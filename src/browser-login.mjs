#!/usr/bin/env node
// Real-browser signup worker (v1 scaffold).
//
// Mirrors the CLI shape of src/protocol-login.mjs so console-server.mjs can
// spawn it with the same args. Where the TLS path drives OpenAI's web flow via
// curl_cffi + jsdom, this path drives a real Chromium Stable through Patchright
// (an undetected Playwright fork). The persistent context is keyed by a
// deterministic oai-did derived from the email (shared with the TLS path), the
// account fingerprint is applied via addInitScript BEFORE the first navigation
// to any OpenAI origin, and the Codex OAuth loopback (http://localhost:1455/
// auth/callback) is intercepted at the browser layer with context.route — no
// real port is bound, so N concurrent Chromiums coexist on the same whitelisted
// redirect_uri.
//
// What this file is NOT (v1 scope):
//   - It does not include an Arkose FunCaptcha solver yet (callers that hit
//     Arkose get a clean `[error] ARKOSE_UNSOLVABLE` so classifyLoginError can
//     treat it as operational and keep the mailbox usable).
//   - It does not support --setup-totp or --add-password (prints a clean
//     UNSUPPORTED_IN_BROWSER_WORKER error — the TLS lane handles those).
//   - The signup DOM selectors are reasonable defaults; real-world calibration
//     against auth.openai.com happens on the first live run and selectors are
//     consolidated at the top of this file for easy adjustment.
//
// Modes:
//   --probe                 : launch Chromium, visit a safe fingerprint probe,
//                             write a JSON report, exit (no OpenAI contact).
//   --refresh-sub2api PATH   : delegate to protocol-login refresh helper (pure
//                             HTTP, no browser needed).
//   --setup-totp             : UNSUPPORTED_IN_BROWSER_WORKER (operator falls
//                             back to TLS lane).
//   --add-password           : UNSUPPORTED_IN_BROWSER_WORKER.
//   default (--email ...)    : full signup flow in a real browser.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import readline from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  oaiDeviceIdFromEmail,
  buildPerAccountFingerprint,
  buildContextOptions,
  buildInitScript,
  detectHostProfile,
} from "./browser-fingerprint.mjs";
import { WORKER_MARKERS, emit } from "./browser-stdio-matrix.mjs";
import { detectInstalledChrome } from "./browser-chrome-version.mjs";

const DEFAULT_CHATGPT_BASE = "https://chatgpt.com";
const DEFAULT_AUTH_BASE = "https://auth.openai.com";
const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
// Thực tế đăng ký ChatGPT (2026-10): mở https://chatgpt.com/ là modal "Log in or
// sign up" bật lên — có input Email address + nút Continue + các OAuth third-party
// (Google/Apple/phone). Nhập email → Continue → chuyển sang auth.openai.com cho
// OTP + password + profile + phone. Giữ 2 URL fallback phòng khi modal không
// bật (A/B test của OpenAI đôi lúc redirect thẳng).
const SIGNUP_URL_CANDIDATES = [
  "https://chatgpt.com/",
  "https://auth.openai.com/create-account",
  "https://chatgpt.com/auth/signup",
];
// Manual-assist mode (env TOSUB2_BROWSER_MANUAL=1 hoặc CLI --manual-assist):
//   * Chromium KHÔNG tự đóng khi worker exit (handleSIG* = false)
//   * Timeout tất cả locator/goto giãn lên 30 phút
//   * Timeout stdin cũng 30 phút
//   * Khi error, không teardown context — để user tiếp tục drive tay
// Default (unset): behaviour cũ (60s page timeout, 5 min stdin, context close on exit).
const MANUAL_ASSIST = process.env.TOSUB2_BROWSER_MANUAL === "1" || process.argv.includes("--manual-assist");
const PAGE_IDLE_TIMEOUT_MS = MANUAL_ASSIST ? 1_800_000 : 60_000;
const INPUT_TIMEOUT_MS = MANUAL_ASSIST ? 1_800_000 : 300_000;
// Adaptive loop whole-session cap: email OTP + profile + password + phone +
// OAuth tổng cần 3-5 phút ổn định. 60s cũ gây CODEX_CALLBACK_TIMEOUT ngay
// khi handler nào mất 10-20s (PROFILE waitForURL, SMS poll). 10 min cho
// non-manual, 30 min cho manual-assist.
const ADAPTIVE_LOOP_TIMEOUT_MS = MANUAL_ASSIST ? 1_800_000 : 10 * 60_000;

// auth.openai.com signup selectors.
//
// Each entry is an ORDERED fallback list — tried first-to-last by locatorForKey.
// Keep selectors tag + attribute + text based (never CSS classes — OpenAI's
// Tailwind-ish classes rotate every ship). First-run calibration is expected:
// if a step misses, the --inspect-each mode pauses so the operator can read the
// actual DOM and feed the real selector back into this table.
const SELECTORS = {
  emailInput: [
    'input[placeholder="Email address" i]',
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="email"]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
  ],
  // CẢNH BÁO: modal chatgpt.com có 3 nút "Continue with Google / Apple / phone"
  // → KHÔNG dùng `button:has-text("Continue")` một mình, nó sẽ match nhầm nút
  // OAuth. Dùng text-is (exact) hoặc button[type=submit] của FORM email.
  continueButton: [
    'form button[type="submit"]',
    'button[type="submit"]:not(:has-text("Google")):not(:has-text("Apple")):not(:has-text("phone"))',
    'button:text-is("Continue")',
    'button:text-is("Tiếp tục")',
    'button:text-is("Next")',
    'button[data-testid*="continue" i]:not([data-testid*="google" i]):not([data-testid*="apple" i])',
  ],
  // 3 nút OAuth third-party trên modal — KHÔNG click, chỉ liệt kê để test
  // có thể assert "worker không bấm nhầm".
  thirdPartyOauthButtons: [
    'button:has-text("Continue with Google")',
    'button:has-text("Continue with Apple")',
    'button:has-text("Continue with phone")',
  ],
  // Nút X đóng modal — không được bấm.
  closeModalButton: [
    'button[aria-label*="close" i]',
    'button[aria-label*="đóng" i]',
  ],
  // Nút trigger để bật modal — chatgpt.com không auto-show modal, phải click
  // "Sign up for free" (ưu tiên cho flow signup) hoặc "Log in" (top-right)
  // trước. Cả 2 đều mở cùng modal thống nhất.
  openModalButton: [
    'a:text-is("Sign up for free")',
    'button:text-is("Sign up for free")',
    'a:text-is("Sign up")',
    'button:text-is("Sign up")',
    'a:text-is("Đăng ký")',
    'a:text-is("Log in")',
    'button:text-is("Log in")',
    'a:text-is("Đăng nhập")',
    'button:text-is("Đăng nhập")',
    '[data-testid="login-button"]',
    '[data-testid="signup-button"]',
  ],
  // Cookie banner — Reject non-essential ưu tiên (privacy); Accept all fallback.
  // Không đóng banner có thể cản modal và interaction phía dưới.
  cookieRejectButton: [
    'button:has-text("Reject non-essential")',
    'button:has-text("Reject all")',
    'button:has-text("Từ chối")',
  ],
  cookieAcceptButton: [
    'button:has-text("Accept all")',
    'button:has-text("Chấp nhận")',
    '[data-testid*="accept" i]',
  ],
  emailOtpInput: [
    'input[name="code"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[name="otp"]',
    'input[id*="otp" i]',
    'input[aria-label*="verification" i]',
    'input[aria-label*="code" i]',
  ],
  resendEmailOtpButton: [
    'button:has-text("Resend")',
    'button:has-text("Gửi lại")',
    'a:has-text("Resend")',
    'a:has-text("Gửi lại")',
    '[data-testid*="resend" i]',
    '[role="button"]:has-text("Resend")',
    '[role="button"]:has-text("Gửi lại")',
  ],
  passwordInput: [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="new-password"]',
    'input[autocomplete="current-password"]',
  ],
  // Trang /about-you: Material-style floating label. OpenAI thường render label
  // text như "Full name" / "Họ và tên" làm <label> tách rời input, nên selector
  // bằng placeholder KHÔNG hit. Playwright hỗ trợ `:below(selector)` + layout
  // query và `input` liền kề label. Thực dụng nhất: Playwright `getByLabel`
  // nhưng cú pháp CSS fallback dùng :has(+ input) hoặc input quanh label.
  // Dưới đây là chuỗi best-guess vị trí; worker ưu tiên exact-id/aria rồi lùi.
  nameInput: [
    // Playwright-specific: locator by label text (xài Edit sau khi migrate sang
    // page.getByLabel; CSS này là fallback cho locator.first())
    'input#name',
    'input[name="name"]',
    'input[name="full_name"]',
    'input[name="fullName"]',
    'input[name="given_name"]',
    'input[name="first_name"]',
    'input[name="firstName"]',
    'input[autocomplete="name"]',
    'input[autocomplete="given-name"]',
    'input[aria-label="Họ và tên"]',
    'input[aria-label="Full name"]',
    'input[aria-labelledby*="name" i]',
    'input[placeholder*="Name" i]',
    'input[placeholder*="Họ và tên" i]',
    // Catch-all: text field đầu tiên không phải password/email trên trang about-you
    'form input[type="text"]:not([type="password"]):not([type="email"])',
  ],
  birthdateInput: [
    'input#birthdate',
    'input#birthday',
    'input#age',
    'input[name="birthdate"]',
    'input[name="birthday"]',
    'input[name="date_of_birth"]',
    'input[name="age"]',
    'input[type="date"]',
    'input[type="number"]',
    'input[inputmode="numeric"]',
    'input[aria-label="Tuổi"]',
    'input[aria-label="Age"]',
    'input[aria-label*="birth" i]',
    'input[placeholder*="Age" i]',
    'input[placeholder*="Tuổi" i]',
    'input[placeholder*="birthday" i]',
    'input[placeholder*="sinh" i]',
  ],
  phoneInput: [
    'input[type="tel"]',
    'input[name="phone_number"]',
    'input[name="phone"]',
    'input[autocomplete="tel"]',
    'input[inputmode="tel"]',
  ],
  phoneOtpInput: [
    'input[autocomplete="one-time-code"]',
    'input[name="code"]',
    'input[name="otp"]',
    'input[inputmode="numeric"]',
    'input[aria-label*="verification" i]',
  ],
  // Codex OAuth consent / authorize page may show a "Continue" / "Authorize"
  // button before the automatic redirect.
  oauthContinueButton: [
    'button:has-text("Continue")',
    'button:has-text("Tiếp tục")',
    'button:has-text("Authorize")',
    'button:has-text("Allow")',
    'button:has-text("Cho phép")',
    'button[type="submit"]',
  ],
  // Workspace / organization chooser (only shows when the account already has
  // a workspace or when Codex consent lands on choose-an-account).
  workspaceChoiceRadio: [
    'input[type="radio"][name*="workspace" i]',
    'input[type="radio"][name*="account" i]',
    'button[role="option"]',
    '[data-testid*="workspace" i]',
    '[data-testid*="account" i]',
  ],
  // The "I am 18+" / terms acceptance checkbox OpenAI occasionally shows for
  // VN/jurisdictions requiring age attestation.
  ageConsentCheckbox: [
    'input[type="checkbox"][name*="age" i]',
    'input[type="checkbox"][name*="consent" i]',
    'input[type="checkbox"][aria-label*="18" i]',
  ],
};

// Return a single CSS selector string compatible with page.locator(sel).first().
// Playwright accepts comma-separated selectors, so we flatten the fallback list.
function selectorFor(key) {
  const list = SELECTORS[key];
  if (!list) throw new Error(`Unknown selector key: ${key}`);
  return Array.isArray(list) ? list.join(", ") : list;
}

// Chờ React hydrate xong — ChatGPT SPA cần 1-3s sau goto để onClick attach.
// Dùng ở đầu mỗi handler khi page vừa redirect.
async function waitForReactReady(page) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

// Fill React controlled input chuẩn: Playwright .fill() set .value nhưng React
// internal state không update (vì React override setter). Giải pháp: dùng native
// setter của HTMLInputElement.prototype rồi dispatch input event — React catch
// event, cập nhật state đúng.
async function reactSafeFill(locator, value) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  await locator.click({ timeout: 5000, force: true }).catch(() => {});
  // Clear existing (3 cách: Ctrl+A+Delete, End+Backspace loop, native setter "")
  await locator.press("Control+a").catch(() => {});
  await locator.press("Delete").catch(() => {});
  await locator.press("End").catch(() => {});
  for (let i = 0; i < 25; i += 1) await locator.press("Backspace").catch(() => {});
  // Type character by character (triggers input events)
  await locator.type(String(value), { delay: 25 }).catch(async () => {
    // Fallback: native value setter + fire input event (React catches)
    await locator.evaluate((el, v) => {
      const proto = window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(value)).catch(() => {});
  });
  await locator.evaluate((el) => el.blur()).catch(() => {});
}

// Click React synthetic listener an toàn: thử Playwright click (CDP native mouse)
// trước, fallback dispatchEvent MouseEvent sequence.
async function reactSafeClick(locator) {
  await locator.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  try { await locator.click({ timeout: 5000, force: true }); return; } catch { /* fallthrough */ }
  await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    };
    ["mousedown", "mouseup", "click"].forEach((t) => el.dispatchEvent(new MouseEvent(t, opts)));
    el.click();
  }).catch(() => {});
}

const RUN_MODES = Object.freeze({
  SIGNUP: "signup",
  PROBE: "probe",
  REFRESH: "refresh",
  UNSUPPORTED: "unsupported",
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.setupTotp || args.addPassword) {
    emit(WORKER_MARKERS.unsupportedInBrowser);
    console.error("[error] UNSUPPORTED_IN_BROWSER_WORKER (--setup-totp / --add-password not supported in browser lane v1)");
    process.exit(2);
  }
  if (args.refreshSub2api) {
    await handleRefreshSub2Api(args);
    return;
  }
  if (args.probe) {
    await handleProbe(args);
    return;
  }
  // Flow selection: adaptive state-machine (new, default) vs legacy linear
  // handleSignup. Opt out of adaptive with env TOSUB2_BROWSER_ADAPTIVE=0 or
  // --legacy CLI flag.
  const useAdaptive = !(process.env.TOSUB2_BROWSER_ADAPTIVE === "0" || args.legacy);
  if (useAdaptive) {
    await handleSignupAdaptive(args);
  } else {
    await handleSignup(args);
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function handleRefreshSub2Api(args) {
  // Refresh qua Chromium thật, mở lại same userDataDir (có cookie session từ
  // lúc signup) → fetch('/oauth/token') CHẠY TRONG BROWSER context → request
  // mang TLS Chrome 145, cookie oai-did + cf_bm + session cũ. OpenAI thấy
  // same device/same session như lúc signup → giảm rủi ro bị cờ.
  //
  // Nếu Chromium launch fail (không có engine, binary gone, etc.) → fallback
  // sang Node fetch (match protocol-login's refreshSub2apiOauthExport behaviour,
  // chấp nhận TLS mismatch).
  const authBase = args.authBase || DEFAULT_AUTH_BASE;
  const sourcePath = args.refreshSub2api;
  const targetPath = args.sub2apiOut || args.refreshSub2api;

  let data;
  try {
    data = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`REFRESH_TOKEN_INVALID: không đọc được sub2api file: ${error.message}`);
  }
  const account = data?.accounts?.[0];
  const credentials = account?.credentials;
  const refreshToken = credentials?.refresh_token;
  const clientId = account?.extra?.client_id || args.codexClientId || DEFAULT_CODEX_CLIENT_ID;
  const email = credentials?.email || account?.extra?.email || args.email || "";
  if (data?.type !== "sub2api-data" || !account || !refreshToken) {
    throw new Error("REFRESH_TOKEN_INVALID: file thiếu OAuth account hoặc refresh_token");
  }

  let tokenSet;
  // Thử refresh qua Chromium same userDataDir (TLS Chrome 145 + cookie session).
  // Chỉ work nếu có email để derive oai-did → userDataDir path giống signup.
  if (email) {
    try {
      tokenSet = await refreshOAuthTokenViaBrowser({
        authBase,
        clientId,
        refreshToken,
        email,
        proxy: args.proxy || process.env.CHATGPT_PROXY_URL || null,
        verbose: args.verbose,
      });
      if (args.verbose) console.log("[refresh] via browser OK");
    } catch (err) {
      console.log(`[refresh] browser path failed (${err?.message || err}) — fallback Node fetch`);
    }
  }
  if (!tokenSet) {
    // Fallback: Node fetch (TLS mismatch but ít nhất refresh được)
    tokenSet = await refreshOAuthTokenInline({ authBase, clientId, refreshToken });
  }

  credentials.access_token = tokenSet.access_token;
  credentials.refresh_token = tokenSet.refresh_token || refreshToken;
  if (tokenSet.id_token) credentials.id_token = tokenSet.id_token;

  if (credentials.id_token) {
    try {
      const claims = decodeJwtPayload(credentials.id_token);
      if (claims?.email) credentials.email = claims.email;
      if (claims?.sid) credentials.chatgpt_account_id = claims.sid;
      const authClaims = claims?.["https://api.openai.com/auth"] || {};
      if (account.extra) {
        if (claims?.sid) {
          account.extra.account_id = claims.sid;
          account.extra.chatgpt_account_id = claims.sid;
        }
        if (authClaims.user_id || claims?.sub) {
          account.extra.chatgpt_user_id = authClaims.user_id || claims.sub;
        }
        if (claims?.email) account.extra.email = claims.email;
      }
    } catch { /* best-effort */ }
  }

  data.exported_at = new Date().toISOString();
  await writeJsonAtomic(targetPath, data);
  emit(WORKER_MARKERS.savedSub2api, targetPath);
}

async function refreshOAuthTokenViaBrowser({ authBase, clientId, refreshToken, email, proxy, verbose }) {
  // Mở Chromium same userDataDir (deterministic qua oaiDeviceIdFromEmail(email))
  // → navigate tới chatgpt.com để cookie session được browser load → page.evaluate
  // fetch POST /oauth/token. Request đi với TLS/cookie thật của Chrome.
  const session = await openBrowser({ email, proxy, verbose });
  try {
    // Navigate tới origin OpenAI để cookie oai-did + cf_bm + session cũ được bật.
    // Không cần đợi full load — chỉ cần cookie available cho fetch same-origin.
    await session.page.goto(`${authBase}/`, { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => {});
    const tokenSet = await session.page.evaluate(async (payload) => {
      const res = await fetch(payload.authBase + "/oauth/token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: payload.clientId,
          refresh_token: payload.refreshToken,
        }),
        credentials: "include",
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error("TOKEN_NON_JSON_HTTP_" + res.status); }
      if (!res.ok) {
        const msg = data?.error_description || data?.error || JSON.stringify(data).slice(0, 180);
        throw new Error("TOKEN_HTTP_" + res.status + ": " + msg);
      }
      return data;
    }, { authBase, clientId, refreshToken });
    if (!tokenSet?.access_token) throw new Error("TOKEN_MISSING_ACCESS");
    return tokenSet;
  } finally {
    await session.close().catch(() => {});
  }
}

async function refreshOAuthTokenInline({ authBase, clientId, refreshToken }) {
  const res = await fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "codex-cli/0.1.0",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`REFRESH_TOKEN_INVALID: token endpoint non-JSON HTTP ${res.status}: ${text.slice(0, 180)}`); }
  if (!res.ok) {
    const message = data?.error_description || data?.error || JSON.stringify(data).slice(0, 180);
    throw new Error(`REFRESH_TOKEN_INVALID: HTTP ${res.status}: ${message}`);
  }
  if (!data.access_token) throw new Error("REFRESH_TOKEN_INVALID: response missing access_token");
  return data;
}

async function handleProbe(args) {
  // Dry-run: open Chromium, apply fingerprint, hit a probe URL, write a report.
  // No OpenAI traffic. Use this to confirm the stack boots on the host before
  // the first live signup.
  //
  // Default behaviour is proxy-only: if the probe URL happens to be anything
  // other than localhost/127.0.0.1 and no proxy is configured, we refuse to
  // leak the host's own IP. Operator may pass --allow-direct-ip for truly
  // offline / loopback probes.
  const proxy = args.proxy || process.env.CHATGPT_PROXY_URL || null;
  const probeUrl = args.probeUrl || "https://httpbin.org/anything/tosub2-browser-probe";
  const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(probeUrl);
  if (!proxy && !args.allowDirectIp && !isLoopback) {
    throw new Error(
      "BROWSER_PROXY_REQUIRED: refusing to run --probe against a non-loopback URL without a proxy — would leak the host IP. Pass --proxy or --allow-direct-ip.",
    );
  }
  const session = await openBrowser({ email: args.email || "probe@example.test", proxy, verbose: args.verbose });
  const started = Date.now();
  const context = session.context;
  const page = await context.newPage();
  try {
    await page.goto(probeUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
    const title = await page.title();
    const navigatorInfo = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      webdriver: navigator.webdriver,
      language: navigator.language,
      languages: navigator.languages,
      screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    let webgl = null;
    try {
      webgl = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) return null;
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          vendor: gl.getParameter(gl.VENDOR),
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        };
      });
    } catch {
      /* noop */
    }
    let canvasHash = null;
    try {
      canvasHash = await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 200;
        c.height = 60;
        const ctx = c.getContext("2d");
        ctx.textBaseline = "top";
        ctx.font = "16px Arial";
        ctx.fillStyle = "#f60";
        ctx.fillRect(0, 0, 200, 60);
        ctx.fillStyle = "#069";
        ctx.fillText("tosub2 canvas probe", 2, 2);
        return c.toDataURL().slice(-80);
      });
    } catch {
      /* noop */
    }
    // Confirm the pre-set oai-did cookie survived onto both OpenAI domains and
    // the user-data-dir is isolated per account.
    const openaiCookies = await context.cookies(["https://chatgpt.com", "https://auth.openai.com"]);
    const oaiDidCookie = openaiCookies.find((c) => c.name === "oai-did");
    const report = {
      type: "tosub2-browser-probe",
      version: 1,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      probe_url: probeUrl,
      title,
      navigator: navigatorInfo,
      webgl,
      canvas_hash_tail: canvasHash,
      chrome: session.chrome,
      fingerprint: session.fingerprint,
      oai_did_cookie: oaiDidCookie ? { value: oaiDidCookie.value, domain: oaiDidCookie.domain, secure: oaiDidCookie.secure } : null,
      user_data_dir: session.userDataDir,
      note: "deviceMemory/hardwareConcurrency JS overrides are no-ops under Patchright by design (stealth = no JS injection). Per-account identity comes from userDataDir + oai-did cookie + proxy.",
    };
    const outPath = args.sub2apiOut || args.out || path.join(process.cwd(), "tmp", `browser-probe-${Date.now()}.json`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[ok] Browser probe report: ${outPath}`);
    emit(WORKER_MARKERS.savedSub2api, outPath); // reuse marker so console-server marks job.resultSaved=true
    // Giữ Chromium alive khi MANUAL_ASSIST=1 hoặc --hold-open để operator inspect
    // thủ công (bot.sannysoft.com, creepjs, pixelscan…). Worker treo chờ stdin
    // close hoặc SIGINT, Chromium chết cùng signal.
    if (MANUAL_ASSIST || args.holdOpen) {
      console.log("[hold] Chromium đang giữ nguyên — press Ctrl+C ở terminal này để đóng.");
      await new Promise((resolve) => {
        process.stdin.on("end", resolve);
        process.on("SIGINT", resolve);
        process.on("SIGTERM", resolve);
      });
    }
  } finally {
    await page.close().catch(() => {});
    await session.close();
  }
}

async function handleSignup(args) {
  if (!args.email) {
    throw new Error("MISSING_EMAIL: --email is required for a signup run");
  }
  const sub2apiOut = args.sub2apiOut || args.out;
  if (!sub2apiOut) throw new Error("MISSING_OUTPUT: --sub2api-out is required");
  const checkpointPath = args.checkpoint || null;

  // Enforce proxy-required for real signup. The host's own IP is the LAST thing
  // that should talk to OpenAI during registration — one deactivation on your
  // residential IP burns every account that ever hit it (per the lifetime burn
  // ledger). Operator can override with --allow-direct-ip for offline tests.
  const proxyUrl = args.proxy || process.env.CHATGPT_PROXY_URL || null;
  if (!proxyUrl && !args.allowDirectIp) {
    throw new Error(
      "BROWSER_PROXY_REQUIRED: --proxy / CHATGPT_PROXY_URL is required for signup. Pass --allow-direct-ip only for offline tests.",
    );
  }

  const session = await openBrowser({ email: args.email, proxy: proxyUrl, verbose: args.verbose });
  try {
    // Pre-flight: assert the proxy actually routes traffic. On a locked-down
    // residential proxy the Chromium can boot but outbound traffic fails
    // silently; this probe surfaces the failure as an operational error so the
    // mailbox is not marked deactivated.
    await proxyPreflight(session, args);

    // 1. Signup landing — chatgpt.com home shows a modal "Log in or sign up"
    // with an email input + Continue button + 3 third-party OAuth buttons.
    // Wait for the modal's email input to be visible before typing.
    const signupUrl = await findReachableSignupUrl(session);
    await session.page.goto(signupUrl, { timeout: PAGE_IDLE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    await assertNotCloudflareStuck(session);
    await waitForModalEmailInput(session.page);
    await assertNotAccidentallyOnOauth(session.page);
    await inspectPauseIfRequested(args, session.page, "modal-visible");

    await fillAndSubmit(session.page, selectorFor("emailInput"), args.email, selectorFor("continueButton"));
    emit(WORKER_MARKERS.emailOtpPageReached);
    console.log(`[email-otp-requested-at] ${new Date().toISOString()}`);
    await inspectPauseIfRequested(args, session.page, "after-email-submit");

    // 2. Email OTP — ask console-server, type into DOM, submit. checkpointSavedEmail
    // chỉ emit SAU khi submit thành công (URL rời /email-verification).
    const emailOtp = await promptForInput("emailOtpPrompt");
    await fillAndSubmit(session.page, selectorFor("emailOtpInput"), emailOtp, selectorFor("continueButton"));
    try {
      await session.page.waitForURL((u) => !/\/email-verification/.test(String(u)), { timeout: 15_000 });
      emit(WORKER_MARKERS.checkpointSavedEmail);
      await saveCheckpoint(checkpointPath, { stage: "email_verified", oai_device_id: session.oaiDeviceId });
    } catch {
      console.log("[email-otp-rejected] 邮箱验证码错误，请重新输入，或输入 r 重新发送。");
    }
    await inspectPauseIfRequested(args, session.page, "after-email-otp");

    // 3. Password (OpenAI sometimes asks for a new password at signup).
    const newPassword = process.env.CHATGPT_NEW_PASSWORD || process.env.CHATGPT_LOGIN_PASSWORD || "";
    if (await session.page.locator(selectorFor("passwordInput")).first().isVisible({ timeout: 15_000 }).catch(() => false)) {
      if (!newPassword) throw new Error("MISSING_PASSWORD: signup page requested a password but none was provided");
      await fillAndSubmit(session.page, selectorFor("passwordInput"), newPassword, selectorFor("continueButton"));
      await saveCheckpoint(checkpointPath, { stage: "password_submitted", oai_device_id: session.oaiDeviceId });
      await inspectPauseIfRequested(args, session.page, "after-password");
    }

    // 4. Account profile — name + birthdate.
    const profile = generateInlineProfile(session.oaiDeviceId);
    emit(WORKER_MARKERS.sentinelProfilePrepare);
    const nameLocator = session.page.locator(selectorFor("nameInput")).first();
    if (await nameLocator.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await nameLocator.fill(profile.name);
    }
    const birthdateLocator = session.page.locator(selectorFor("birthdateInput")).first();
    if (await birthdateLocator.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await birthdateLocator.fill(profile.birthdate);
    }
    const ageConsent = session.page.locator(selectorFor("ageConsentCheckbox")).first();
    if (await ageConsent.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await ageConsent.check({ timeout: 5_000 }).catch(() => {});
    }
    await session.page.locator(selectorFor("continueButton")).first().click({ timeout: 10_000 }).catch(() => {});
    emit(WORKER_MARKERS.profileCompleted);
    await saveCheckpoint(checkpointPath, { stage: "profile_submitted", oai_device_id: session.oaiDeviceId });
    await inspectPauseIfRequested(args, session.page, "after-profile");

    // 5. Phone binding — console-server pushes the number, then the OTP.
    const addPhoneUrl = await maybeWaitForPhonePage(session);
    if (addPhoneUrl) {
      process.stdout.write(WORKER_MARKERS.phoneNumberPrompt.marker);
      const phone = await readStdinLine();
      await session.page.locator(selectorFor("phoneInput")).first().fill(phone);
      await session.page.locator(selectorFor("continueButton")).first().click({ timeout: 10_000 });
      await saveCheckpoint(checkpointPath, { stage: "phone_requested", oai_device_id: session.oaiDeviceId });
      await inspectPauseIfRequested(args, session.page, "after-phone-submit");
      process.stdout.write(WORKER_MARKERS.phoneOtpPrompt.marker);
      const phoneOtp = await readStdinLine();
      await session.page.locator(selectorFor("phoneOtpInput")).first().fill(phoneOtp);
      await session.page.locator(selectorFor("continueButton")).first().click({ timeout: 10_000 });
      emit(WORKER_MARKERS.phoneOtpValidated);
      await saveCheckpoint(checkpointPath, { stage: "phone_otp_submitted", oai_device_id: session.oaiDeviceId });
      await inspectPauseIfRequested(args, session.page, "after-phone-otp");
    }

    // 6. Codex OAuth. Intercept the callback at the browser layer — no socket
    // bound on 1455.
    const { codeVerifier, state, callbackUrl } = await runCodexOauthInBrowser(session, {
      authBase: args.authBase || DEFAULT_AUTH_BASE,
      clientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
      redirectUri: args.codexRedirectUri || DEFAULT_CODEX_REDIRECT_URI,
      checkpointPath,
    });

    // 7. Token exchange — pure HTTPS, direct fetch.
    const { exchangeOAuthCode } = await import("./protocol-login.mjs");
    const tokenSet = await exchangeOAuthCode({
      authBase: args.authBase || DEFAULT_AUTH_BASE,
      clientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
      code: new URL(callbackUrl).searchParams.get("code"),
      codeVerifier,
      redirectUri: args.codexRedirectUri || DEFAULT_CODEX_REDIRECT_URI,
      transport: null,
      cookie: null,
    });

    // 8. Write sub2api-import-oauth.json.
    const sub2apiPayload = buildSub2ApiPayload({
      tokenSet,
      email: args.email,
      proxyUrl: session.proxyUrl,
      clientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
      accountName: args.sub2apiName || null,
      concurrency: Number(args.concurrency || 10),
      priority: Number(args.priority || 1),
      rateMultiplier: Number(args.rateMultiplier || 1),
    });
    await writeJsonAtomic(sub2apiOut, sub2apiPayload);
    emit(WORKER_MARKERS.savedSub2api, sub2apiOut);
  } finally {
    const forceExitTimer = setTimeout(() => {
      try { if (process.stdout.write("")) process.stdout.end?.(); } catch {}
      process.exit(0);
    }, 8_000);
    forceExitTimer.unref?.();
    try { await session.close(); } catch { /* best-effort */ }
    clearTimeout(forceExitTimer);
    setTimeout(() => { process.exit(0); }, 500);
  }
}

// ---------------------------------------------------------------------------
// Adaptive signup — state machine theo URL + accessibility tree
// ---------------------------------------------------------------------------
// Thay vì chuỗi fillAndSubmit cứng (xem handleSignup ở trên — brittle khi
// OpenAI đổi UI), handleSignupAdaptive dò URL + visible headings mỗi tick,
// map sang 1 trong các "page kind" (login-email, email-otp, password, profile,
// phone, oauth-consent, done) rồi gọi handler tương ứng. Handlers dùng
// Playwright accessibility (getByLabel / getByRole) — robust hơn CSS vì bắt
// theo visible text/role mà user thực sự thấy.
//
// Enable: env TOSUB2_BROWSER_ADAPTIVE=1 (default) hoặc --adaptive. Legacy flow
// vẫn giữ ở handleSignup, bật qua TOSUB2_BROWSER_ADAPTIVE=0 hoặc --legacy.

const PAGE_KINDS = Object.freeze({
  LANDING: "landing",
  ONBOARDING: "onboarding",
  LOGIN_EMAIL: "login-email",
  SIGNUP_EMAIL: "signup-email",
  EMAIL_OTP: "email-otp",
  PASSWORD: "password",
  PROFILE: "profile",
  PHONE_NUMBER: "phone-number",
  PHONE_OTP: "phone-otp",
  OAUTH_CONSENT: "oauth-consent",
  WORKSPACE_SELECT: "workspace-select",
  SESSION_EXPIRED: "session-expired",
  ACCOUNT_DEACTIVATED: "account-deactivated",
  DONE: "done",
  WRONG_OAUTH: "wrong-oauth",
  UNKNOWN: "unknown",
});

async function detectPageKind(page) {
  const url = page.url();
  if (/^about:blank$/i.test(url)) return PAGE_KINDS.UNKNOWN;
  if (/^https?:\/\/(localhost|127\.0\.0\.1):1455\/auth\/callback/.test(url)) return PAGE_KINDS.DONE;
  if (/accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com/.test(url)) return PAGE_KINDS.WRONG_OAUTH;

  // Pull text signals.
  let title = "";
  let headings = "";
  let bodyPrefix = "";
  try {
    title = (await page.title()) || "";
    const data = await page.evaluate(() => ({
      h: [...document.querySelectorAll("h1, h2, h3")].map((h) => (h.innerText || "").trim()).join(" | "),
      b: (document.body?.innerText || "").slice(0, 400),
    }));
    headings = data.h || "";
    bodyPrefix = data.b || "";
  } catch { /* page navigating */ }
  const corpus = `${url} | ${title} | ${headings} | ${bodyPrefix}`.toLowerCase();

  if (/\/oauth\/authorize|\/consent|\/sign-in-with-chatgpt\/codex/.test(url)) return PAGE_KINDS.OAUTH_CONSENT;
  // Cloudflare Turnstile challenge page (/api/accounts/logout + anti-bot pages).
  // Logout endpoint luôn bị Cloudflare gate → worker không thể bypass tự động.
  // Trả UNKNOWN để adaptive loop sameKindCount>=2 → navigate oauth.authUrl recover
  // thay vì misroute về email-otp (body có "xác minh"/"verification" keyword).
  if (/\/api\/accounts\/logout/.test(url) || /just a moment|cloudflare|thực hiện xác minh bảo mật/i.test(title + " " + headings)) {
    return PAGE_KINDS.UNKNOWN;
  }
  // Session expired page tại /create-account: OpenAI invalidate session cookie
  // sau khi worker trước đó bị abort. Page chỉ hiển thị "Your session has
  // ended" + nút "Log in", KHÔNG có email input → SIGNUP_EMAIL handler loop
  // 30s timeout. Issue traced job 90884d3f. Route riêng → handler click Log in
  // để tiếp tục flow bình thường.
  if (/\/create-account/.test(url) && /session has ended|session expired|phiên.*hết hạn|phiên đã kết thúc/i.test(corpus)) return PAGE_KINDS.SESSION_EXPIRED;
  // chatgpt.com/onboarding: multi-step survey ("Bạn làm trong lĩnh vực nào?",
  // "Tell us about you", …). Route tới ONBOARDING handler để click đại 1 option
  // + Continue → tiến tới trang kế hoặc chatgpt.com main → OAuth loopback catch
  // code → DONE. Tránh bypass OAuth navigate (navigatedToOauth flag chỉ fire 1
  // lần, không recover nếu stuck sau tick 2).
  if (/^https?:\/\/chatgpt\.com\/onboarding/.test(url)) return PAGE_KINDS.ONBOARDING;
  // chatgpt.com root MUST short-circuit BEFORE any text/keyword checks: the
  // landing SPA pre-renders a hidden modal with headings "Welcome back" and
  // "Log in or sign up" + a hidden <input id=mobile-auth-email name=login_hint>.
  // That corpus matches /welcome back/ (LOGIN_EMAIL) hoặc /sign up/ (SIGNUP_EMAIL),
  // routing to the wrong handler and never clicking the actual "Log in" button.
  // Issue traced in job 367ce5ef — handler timeout 30s on hidden mobile input.
  if (/^https?:\/\/chatgpt\.com\/?(\?|$)/.test(url)) {
    // Modal có thể đã mở (worker click lần trước, hoặc user drive thủ công) →
    // email input visible → SIGNUP_EMAIL. Ngược lại → LANDING để click Log in.
    try {
      const hasEmailInput = await page
        .locator('input[type="email"]:visible, input[placeholder*="email" i]:visible, input[placeholder="Email address" i]:visible')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
      if (hasEmailInput) return PAGE_KINDS.SIGNUP_EMAIL;
    } catch { /* ignore */ }
    return PAGE_KINDS.LANDING;
  }
  if (/\/choose-an-account|\/workspace\/select|choose an account|chọn tài khoản|workspace/.test(corpus)) return PAGE_KINDS.WORKSPACE_SELECT;
  // Account deactivated (OpenAI đã xoá/vô hiệu hóa tài khoản): URL vẫn
  // /email-verification nhưng body có "error_code: account_deactivated" / "Lỗi
  // xác thực" / "đã bị xóa hoặc vô hiệu hóa". Phải short-circuit TRƯỚC
  // EMAIL_OTP branch để adaptive loop không re-submit OTP vô ích. Trigger
  // isPermanentAccountFailure path trong server.
  if (/account_deactivated|account_deleted|user_deactivated|user_deleted|đã bị xóa hoặc vô hiệu hóa|đã bị vô hiệu hóa|đã bị xóa|account has been (?:deleted|deactivated|suspended|disabled)|do not have an account because it has been (?:deleted|deactivated)/i.test(corpus)) {
    return PAGE_KINDS.ACCOUNT_DEACTIVATED;
  }
  // URL-first precedence cho các page có path cụ thể — tránh substring collision
  // với landing/signup corpus check.
  if (/\/create-account\/password|\/log-in\/password|\/account\/password/.test(url)) return PAGE_KINDS.PASSWORD;
  if (/\/email-verification/.test(url)) return PAGE_KINDS.EMAIL_OTP;
  if (/\/about-you/.test(url)) return PAGE_KINDS.PROFILE;
  // /log-in URL check SỚM: trang này có nút "Tiếp tục với số điện thoại" →
  // body chứa "số điện thoại" → sẽ misroute PHONE_NUMBER ở line 849 nếu
  // không short-circuit ở đây. Issue trace job c9b33fc1.
  if (/\/log-in(\/|$|\?|#)/.test(url)) return PAGE_KINDS.LOGIN_EMAIL;
  // Tương tự /create-account URL cho signup flow — trang có nhiều keyword
  // Vietnamese dễ misroute (sẽ tiếp tục fallthrough nếu cần SIGNUP_EMAIL kind
  // riêng cho session_expired, logic đó đã handle qua regex sớm hơn).
  if (/\/create-account(\/|$|\?|#)/.test(url)) return PAGE_KINDS.SIGNUP_EMAIL;
  if (/\/add-phone|\/phone-number|\/phone-verification/.test(url)) {
    // /phone-verification URL luôn là OTP step. /add-phone có thể là input hoặc
    // verify tùy state. Dùng URL path + body keywords để phân biệt.
    if (/\/phone-verification/.test(url) || /check your phone|kiểm tra điện thoại|verification code|mã xác minh/.test(corpus)) return PAGE_KINDS.PHONE_OTP;
    return PAGE_KINDS.PHONE_NUMBER;
  }
  if (/\/email-verification|verification|kiểm tra hộp thư|verify your email|xác minh/.test(corpus)) return PAGE_KINDS.EMAIL_OTP;
  if (/\/log-in\/password|password|mật khẩu/.test(corpus) && !/create|đăng ký|sign up/.test(corpus)) return PAGE_KINDS.PASSWORD;
  if (/\/about-you|bao nhiêu tuổi|about you|họ và tên|full name/.test(corpus)) return PAGE_KINDS.PROFILE;
  if (/\/add-phone|phone-number|add a phone|số điện thoại|phone verification/.test(corpus)) {
    if (/code|mã|otp|verify/.test(corpus) && /\d{2,}/.test(bodyPrefix)) return PAGE_KINDS.PHONE_OTP;
    return PAGE_KINDS.PHONE_NUMBER;
  }
  if (/\/log-in($|[?#])|welcome back|chào mừng trở lại/.test(corpus)) return PAGE_KINDS.LOGIN_EMAIL;
  if (/\/create-account|sign up|đăng ký|tạo tài khoản/.test(corpus)) return PAGE_KINDS.SIGNUP_EMAIL;
  return PAGE_KINDS.UNKNOWN;
}

function roleTextbox(page, name) {
  return page.getByRole("textbox", { name }).first();
}
function roleButton(page, name) {
  return page.getByRole("button", { name }).first();
}
function roleLink(page, name) {
  return page.getByRole("link", { name }).first();
}

// EXACT regex: tránh "Continue with Google/Apple/Microsoft/phone/email" — chỉ
// match "Continue" / "Tiếp tục" đơn (nút submit chính của form).
const CONTINUE_NAME = /^(tiếp tục|continue|next|verify|xác minh|submit|đồng ý)$/i;
const AUTHORIZE_NAME = /^(authorize|allow|cho phép|chấp nhận|accept|đồng ý)$/i;

// Smart continue click. Thứ tự thử:
//   1. Button với accessible name EXACT trong whitelist (tránh "Continue with X")
//   2. Button KHÔNG chứa "with|google|apple|microsoft|phone|facebook" + có "continue|tiếp tục"
//   3. form button[type="submit"] (modal có thể wrap trong form)
//   4. Button cuối cùng (bottom) trong dialog visible — modal thường có submit ở đáy
//   5. page.keyboard.press("Enter") — nếu input vẫn focused, Enter submit
async function clickFormSubmit(page) {
  // 1. Exact name match
  const exactTexts = ["Continue", "Tiếp tục", "Next", "Verify", "Xác minh", "Submit", "Đồng ý"];
  for (const t of exactTexts) {
    try {
      const btn = page.getByRole("button", { name: t, exact: true }).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ timeout: 5000 });
        return;
      }
    } catch { /* next */ }
  }
  // 2. Button loại OAuth, chứa continue/tiếp tục
  try {
    const btn = page.locator("button:visible", { hasText: /continue|tiếp tục|next/i })
      .filter({ hasNotText: /with|google|apple|microsoft|phone|facebook|email/i })
      .first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      await btn.click({ timeout: 5000 });
      return;
    }
  } catch { /* next */ }
  // 3. form submit
  try {
    const formSubmit = page.locator("form button[type='submit']").first();
    if (await formSubmit.isVisible({ timeout: 800 }).catch(() => false)) {
      await formSubmit.click({ timeout: 5000 });
      return;
    }
  } catch { /* next */ }
  // 4. Dialog's last visible button (modal footer)
  try {
    const dialogSubmit = page.locator("[role='dialog'] button:visible").last();
    if (await dialogSubmit.isVisible({ timeout: 800 }).catch(() => false)) {
      await dialogSubmit.click({ timeout: 5000 });
      return;
    }
  } catch { /* next */ }
  // 5. Enter fallback — thường submit input đang focused
  await page.keyboard.press("Enter").catch(() => {});
}

const PAGE_HANDLERS = {
  async [PAGE_KINDS.LANDING](session) {
    await dismissCookieBannerIfVisible(session.page);
    // Helper: check modal opened (email input visible) sau click
    const modalOpened = async () => {
      return await session.page
        .locator('input[type="email"]:visible, input[placeholder*="email" i]:visible')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
    };
    // Nếu modal đã mở (lần tick trước click rồi) → không cần click thêm
    if (await modalOpened()) return;
    // Click Login/Signup button với MULTIPLE strategies — chatgpt.com có nhiều
    // layout, button có thể là <a>, <button>, hoặc <div onClick>.
    const texts = ["Sign up for free", "Đăng ký miễn phí", "Sign up", "Đăng ký", "Log in", "Đăng nhập"];
    for (const text of texts) {
      const tries = [
        // 1. Exact-text visible element
        () => session.page.getByText(text, { exact: true }).first(),
        // 2. Role=button/link exact name regex
        () => session.page.getByRole("button", { name: new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }).first(),
        () => session.page.getByRole("link", { name: new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }).first(),
        // 3. CSS :has-text (looser)
        () => session.page.locator(`a:has-text("${text}"), button:has-text("${text}")`).first(),
        // 4. Any clickable có text (fallback cuối)
        () => session.page.locator(`[data-testid*="login" i]:has-text("${text}"), [data-testid*="signup" i]:has-text("${text}")`).first(),
      ];
      for (const build of tries) {
        try {
          const el = build();
          if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
            // Scroll + hover
            await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            await el.hover({ timeout: 2000 }).catch(() => {});
            await session.page.waitForTimeout(200);

            // Strategy A: Raw page.mouse via coordinates (CDP Input dispatchMouseEvent
            // trực tiếp — bypass Playwright locator abstraction, trigger humanize nếu có)
            const box = await el.boundingBox().catch(() => null);
            if (box) {
              const x = box.x + box.width / 2;
              const y = box.y + box.height / 2;
              await session.page.mouse.move(x, y, { steps: 10 }).catch(() => {});
              await session.page.waitForTimeout(100);
              await session.page.mouse.down().catch(() => {});
              await session.page.waitForTimeout(50);
              await session.page.mouse.up().catch(() => {});
              await session.page.waitForTimeout(2000);
              if (await modalOpened()) return;
            }

            // Strategy B: locator.click force
            await el.click({ timeout: 5000, force: true }).catch(() => {});
            await session.page.waitForTimeout(1500);
            if (await modalOpened()) return;

            // Strategy C: focus + Enter
            await el.focus().catch(() => {});
            await session.page.keyboard.press("Enter").catch(() => {});
            await session.page.waitForTimeout(1500);
            if (await modalOpened()) return;

            // Strategy D: JS dispatchEvent chain
            await el.evaluate((node) => {
              const rect = node.getBoundingClientRect();
              const opts = { bubbles: true, cancelable: true, view: window, button: 0,
                clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 };
              ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(t => {
                try { node.dispatchEvent(new PointerEvent(t, opts)); } catch { node.dispatchEvent(new MouseEvent(t, opts)); }
              });
              node.click();
            }).catch(() => {});
            await session.page.waitForTimeout(1500);
            if (await modalOpened()) return;
          }
        } catch { /* next */ }
      }
    }
    // Fallback: JS scan + simulate real mouse event (React synthetic listener)
    let jsClickOk = false;
    try {
      const res = await session.page.evaluate(() => {
        const re = /^(log in|sign up|sign up for free|đăng nhập|đăng ký|đăng ký miễn phí)$/i;
        const nodes = [...document.querySelectorAll('a, button, [role="button"], div[tabindex], [data-testid*="login" i], [data-testid*="signup" i]')];
        for (const el of nodes) {
          const txt = (el.innerText || el.textContent || "").trim();
          if (re.test(txt)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 };
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent('click', opts));
              el.click();
              return { ok: true, text: txt };
            }
          }
        }
        return { ok: false };
      });
      jsClickOk = res?.ok || false;
      if (jsClickOk) console.log(`[landing] JS click fired on "${res.text}"`);
    } catch { /* give up */ }
    if (!jsClickOk) {
      // DEBUG DUMP: ghi HTML snapshot + visible buttons list để fix selector
      try {
        const dumpDir = path.join(process.cwd(), "tmp", "landing-debug");
        await fs.mkdir(dumpDir, { recursive: true });
        const stamp = String(Date.now());
        const htmlPath = path.join(dumpDir, `landing-${stamp}.html`);
        const metaPath = path.join(dumpDir, `landing-${stamp}.json`);
        const html = await session.page.content();
        await fs.writeFile(htmlPath, html, "utf8");
        const visible = await session.page.evaluate(() => {
          const peek = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return null;
            return {
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute("type"),
              id: el.id || null,
              role: el.getAttribute("role"),
              testid: el.getAttribute("data-testid"),
              ariaLabel: el.getAttribute("aria-label"),
              className: (el.className || "").toString().slice(0, 100),
              text: (el.innerText || "").trim().slice(0, 80),
              hasOnClick: !!el.onclick,
              cursorPointer: window.getComputedStyle(el).cursor === "pointer",
            };
          };
          return [...document.querySelectorAll('a, button, [role="button"], div, span')].map(peek).filter(Boolean).slice(0, 40);
        });
        await fs.writeFile(metaPath, `${JSON.stringify({ url: session.page.url(), title: await session.page.title().catch(() => ""), visible }, null, 2)}\n`, "utf8");
        console.log(`[landing] CLICK MISS — snapshots: ${htmlPath} + ${metaPath}`);
      } catch (err) {
        console.log(`[landing] dump failed: ${err?.message || err}`);
      }
    }
  },
  async [PAGE_KINDS.LOGIN_EMAIL](session, args) {
    await dismissCookieBannerIfVisible(session.page);
    const input = session.page.getByLabel(/email|địa chỉ email/i).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(args.email);
    await clickFormSubmit(session.page);
  },
  async [PAGE_KINDS.ONBOARDING](session) {
    // chatgpt.com/onboarding survey multi-step. Click skip liên tục trong 1
    // handler call cho đến khi URL rời /onboarding (tránh chờ adaptive loop
    // tick 1.5s giữa mỗi câu). Giới hạn 15 round để không treo nếu stuck.
    console.log("[onboarding] handler entering, url=" + session.page.url());
    await session.page.waitForTimeout(600);
    for (let round = 0; round < 15; round += 1) {
      const beforeUrl = session.page.url();
      if (!/\/onboarding/.test(beforeUrl)) {
        console.log(`[onboarding] exited at round ${round}, url=${beforeUrl}`);
        return;
      }
      const picked = await clickOneOnboardingOption(session);
      if (!picked) {
        // Thử click Continue/Tiếp tục nếu có (step chỉ có nút submit, không option)
        try {
          const cont = session.page.getByRole("button", { name: /^(tiếp tục|continue|next|submit|đồng ý|xong|done)$/i }).first();
          if (await cont.isVisible({ timeout: 1200 }).catch(() => false)) {
            await cont.click({ timeout: 3000, force: true }).catch(() => {});
            console.log(`[onboarding] round ${round}: clicked Continue`);
            await session.page.waitForTimeout(900);
            continue;
          }
        } catch { /* next */ }
        console.log(`[onboarding] round ${round}: no option found, break`);
        break;
      }
      await session.page.waitForTimeout(900);
    }
  },
  async [PAGE_KINDS.ACCOUNT_DEACTIVATED](session) {
    // Trích error_code + request_id (nếu có) để log + fail job.
    const info = await session.page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const text = (main.innerText || "").slice(0, 1500);
      const codeMatch = text.match(/error_code:\s*(\S+)/i);
      const reqMatch = text.match(/request_id:\s*([a-f0-9-]+)/i);
      return { code: codeMatch ? codeMatch[1] : "account_deactivated", request_id: reqMatch ? reqMatch[1] : null, text };
    }).catch(() => ({ code: "account_deactivated", request_id: null, text: "" }));
    const reason = `${info.code}: OpenAI đã xóa hoặc vô hiệu hóa tài khoản này` + (info.request_id ? ` (request_id=${info.request_id})` : "");
    console.log(`[error] ${reason}`);
    throw new Error(`ACCOUNT_DEACTIVATED: ${reason}`);
  },
  async [PAGE_KINDS.SESSION_EXPIRED](session) {
    // Page: /create-account với "Your session has ended" + nút "Log in" single.
    // Click Log in để OpenAI điều hướng về /log-in (clean session), classifier
    // tick kế sẽ route LOGIN_EMAIL fill email.
    await session.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await session.page.waitForTimeout(600);
    const btn = session.page.getByRole("button", { name: /^(log in|đăng nhập|sign in)$/i }).first();
    try {
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click({ timeout: 5000 });
        await session.page.waitForTimeout(1500);
        return;
      }
    } catch { /* fallthrough */ }
    // Fallback: anchor link có text "Log in"
    try {
      const link = session.page.getByRole("link", { name: /^(log in|đăng nhập|sign in)$/i }).first();
      if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
        await link.click({ timeout: 5000 });
        return;
      }
    } catch { /* next */ }
    // Fallback cuối: navigate thẳng tới /log-in
    await session.page.goto("https://auth.openai.com/log-in", { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => {});
  },
  async [PAGE_KINDS.SIGNUP_EMAIL](session, args) {
    await dismissCookieBannerIfVisible(session.page);
    const input = session.page.getByLabel(/email|địa chỉ email/i).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(args.email);
    await clickFormSubmit(session.page);
    // Signal mail-poller: OTP vừa được request lúc này; email cũ hơn → ignore.
    console.log(`[email-otp-requested-at] ${new Date().toISOString()}`);
  },
  async [PAGE_KINDS.EMAIL_OTP](session) {
    await waitForReactReady(session.page);
    emit(WORKER_MARKERS.emailOtpPageReached);
    const otp = await promptForInputOrPageAdvance("emailOtpPrompt", session.page, /\/email-verification/, { timeoutMs: 300_000 });
    if (!otp) return;
    // "r" từ console-server = resend_email. Click Resend button rồi return,
    // next tick sẽ re-prompt stdin cho OTP mới. Chỉ emit requested-at khi click
    // thật sự thành công — mail-poller dùng mốc này cutoff email cũ.
    if (String(otp).trim().toLowerCase() === "r") {
      const sel = selectorFor("resendEmailOtpButton");
      let clicked = false;
      try {
        const btn = session.page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await btn.click({ timeout: 5000 });
          clicked = true;
        } else {
          // Fallback: role-based match (anchor/text có thể là <div role="button">)
          const roleBtn = session.page.getByRole("button", { name: /resend|gửi lại|resend email|gửi lại email/i }).first();
          const roleLink = session.page.getByRole("link", { name: /resend|gửi lại|resend email|gửi lại email/i }).first();
          for (const cand of [roleBtn, roleLink]) {
            if (await cand.isVisible({ timeout: 1500 }).catch(() => false)) {
              await cand.click({ timeout: 5000 }).catch(() => {});
              clicked = true;
              break;
            }
          }
        }
      } catch { /* best-effort */ }
      if (clicked) {
        console.log(`[email-otp-requested-at] ${new Date().toISOString()}`);
      } else {
        console.log("[email-otp-resend-failed] Gửi lại email button không visible/clickable.");
      }
      return;
    }
    // Ưu tiên CSS selector từ SELECTORS.emailOtpInput (input[name=code], one-time-code,
    // v.v.) — parity với legacy flow L653. getByLabel KHÔNG match placeholder-only
    // input (OpenAI render <input name=code placeholder=Mã> không có <label>), nên
    // chỉ dùng getByLabel làm fallback cho các UI biến thể có label.
    let input = session.page.locator(selectorFor("emailOtpInput")).first();
    let visible = await input.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!visible) {
      input = session.page.getByLabel(/mã|code|verification|otp/i).first();
      visible = await input.isVisible({ timeout: 3000 }).catch(() => false);
    }
    if (!visible) {
      // Dump DOM để debug — selector miss khi OpenAI đổi UI.
      try {
        const dumpDir = path.join(process.cwd(), "tmp", "email-otp-debug");
        await fs.mkdir(dumpDir, { recursive: true });
        const stamp = String(Date.now());
        const htmlPath = path.join(dumpDir, `email-otp-miss-${stamp}.html`);
        const html = await session.page.content();
        await fs.writeFile(htmlPath, html, "utf8");
        console.log(`[email-otp] input locator MISS — snapshot ${htmlPath}; otp '${otp}' bị bỏ qua.`);
      } catch { /* best-effort */ }
      return;
    }
    await reactSafeFill(input, otp);
    await clickFormSubmit(session.page);
    // Chờ URL rời /email-verification (OpenAI accept code → điều hướng sang
    // password/profile/phone). Timeout = reject → emit [email-otp-rejected] để
    // console-server biết user cần nhập lại.
    try {
      await session.page.waitForURL((u) => !/\/email-verification/.test(String(u)), { timeout: 15_000 });
      emit(WORKER_MARKERS.checkpointSavedEmail);
    } catch {
      console.log("[email-otp-rejected] 邮箱验证码错误，请重新输入，或输入 r 重新发送。");
    }
  },
  async [PAGE_KINDS.PASSWORD](session) {
    await waitForReactReady(session.page);
    const url = session.page.url();
    // 3 nhánh URL password của OpenAI:
    //  - /create-account/password: signup tạo mật khẩu mới (có sẵn).
    //  - /reset-password/new-password: sau quên-mật-khẩu, cần đặt pass mới
    //    (CÓ 2 input: "Mật khẩu mới" + "Nhập lại mật khẩu mới").
    //  - /log-in/password: đăng nhập account có sẵn.
    // STRICT auto-flow policy (per [[feedback_password_handler_fill_dummy]]):
    // KHÔNG throw MISSING_PASSWORD cho email-OTP acc không có pass stored —
    // auto-generate deterministic bằng oai-did, điền vào, submit. Nếu OpenAI
    // từ chối (pass trùng, pass yếu...), adaptive loop sẽ handle. Pass mới
    // emit marker `[account] auto-generated password=...` để console-server
    // lưu vào credential store cho relogin tương lai auto-fill.
    const isCreateAccount = /\/create-account\/password/.test(url);
    const isResetPassword = /\/reset-password\/new-password/.test(url);
    const isLogInPassword = /\/log-in\/password/.test(url);
    const needsNewPassword = isCreateAccount || isResetPassword;
    let pwd = process.env.CHATGPT_NEW_PASSWORD || process.env.CHATGPT_LOGIN_PASSWORD || "";
    let autoGenerated = false;
    if (!pwd) {
      pwd = generatePasswordForAccount(session.oaiDeviceId);
      autoGenerated = true;
      const label = isCreateAccount ? "/create-account/password" : (isResetPassword ? "/reset-password/new-password" : "/log-in/password (fallback)");
      console.log(`[password] ${label} reached — auto-generated 16-char password (deterministic by oai-did).`);
    }
    // Safeguard: nếu /log-in/password + autoGenerated + đã visit >=2 lần (lần
    // trước submit bị OpenAI từ chối, URL vẫn /log-in/password) → có khả năng
    // email-OTP acc chưa từng set password → chuyển qua "Đăng nhập bằng mã
    // dùng một lần" (OTP button) thay vì cứ submit sai hoài làm OpenAI nghi.
    session.__passwordVisits = (session.__passwordVisits || 0) + 1;
    if (isLogInPassword && autoGenerated && session.__passwordVisits >= 2) {
      console.log(`[password] auto-gen pass bị reject ${session.__passwordVisits - 1} lần → thử nút "Đăng nhập bằng mã dùng một lần"`);
      const otpBtn = session.page.getByRole("button", { name: /mã dùng một lần|one.time code|sign.in with code|dùng mã/i }).first();
      if (await otpBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await reactSafeClick(otpBtn).catch(() => {});
        await session.page.waitForURL((u) => !/\/log-in\/password/.test(String(u)), { timeout: 6_000 }).catch(() => {});
        console.log(`[password] clicked OTP button, url=${session.page.url()}`);
        return;
      }
      console.log(`[password] OTP button không tìm thấy — fallback fill pass`);
    }
    // Selector mạnh: `input[type="password"]:visible` chuẩn hơn getByLabel vì
    // OpenAI render floating label (không phải <label for>), getByLabel đôi khi
    // miss hoặc map lên form wrapper.
    let input = session.page.locator('input[type="password"]:visible').first();
    if (!await input.isVisible({ timeout: 3000 }).catch(() => false)) {
      input = session.page.getByLabel(/mật khẩu|password/i).first();
    }
    // Multi-strategy fill giống PROFILE: locator.fill() → keyboard.type → native
    // setter + dispatch events. Verify giá trị sau mỗi strategy.
    const readValue = async () => await input.evaluate((el) => el.value || "").catch(() => "");
    try { await input.fill(pwd, { timeout: 3000 }); } catch { /* next */ }
    let have = await readValue();
    if (have !== pwd) {
      try {
        await input.click({ timeout: 3000, force: true }).catch(() => {});
        await input.press("Control+a").catch(() => {});
        await input.press("Delete").catch(() => {});
        await session.page.keyboard.type(pwd, { delay: 40 });
      } catch { /* next */ }
      have = await readValue();
    }
    if (have !== pwd) {
      await input.evaluate((el, val) => {
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }, pwd).catch(() => {});
      have = await readValue();
    }
    console.log(`[password] fill final: ${have.length} chars (expected ${pwd.length})`);
    // Trang /reset-password/new-password có 2 input: "Mật khẩu mới" + "Nhập
    // lại mật khẩu mới". Fill cả 2 với cùng pass để OpenAI chấp nhận.
    if (needsNewPassword) {
      const confirmInput = session.page.locator('input[type="password"]:visible').nth(1);
      if (await confirmInput.isVisible({ timeout: 1500 }).catch(() => false)) {
        try { await confirmInput.fill(pwd, { timeout: 2000 }); } catch { /* best-effort */ }
        const confirmHave = await confirmInput.evaluate((el) => el.value || "").catch(() => "");
        if (confirmHave !== pwd) {
          await confirmInput.evaluate((el, val) => {
            const proto = window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
            setter.call(el, val);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
          }, pwd).catch(() => {});
        }
        console.log(`[password] confirm input filled (reset/create flow)`);
      }
    }
    // Dispatch Tab để trigger React blur + unlock submit button (OpenAI validate
    // password-strength onBlur, nếu không blur button sẽ disabled).
    await session.page.keyboard.press("Tab").catch(() => {});
    await session.page.waitForTimeout(300);
    await clickFormSubmit(session.page);
    try {
      await session.page.waitForURL((u) => !/\/password/.test(String(u)), { timeout: 10_000 });
      console.log(`[password] left /password, url=${session.page.url()}`);
      // Submit success + password auto-generated → emit marker để console-server
      // lưu pass vào credential store (relogin tiếp theo auto-fill từ env). Chỉ
      // emit sau khi rời khỏi /password (nếu còn kẹt ở /password → có thể là
      // OpenAI reject pass → không lưu nhầm pass sai).
      if (autoGenerated) {
        emit(WORKER_MARKERS.accountPasswordAutoset, pwd);
      }
    } catch {
      console.log(`[password] stuck at /password after submit, trying Enter + reactSafeClick`);
      await session.page.keyboard.press("Enter").catch(() => {});
      try {
        const cont = session.page.getByRole("button", { name: /^(tiếp tục|continue|next|submit)$/i }).first();
        if (await cont.isVisible({ timeout: 1500 }).catch(() => false)) {
          await reactSafeClick(cont);
        }
      } catch { /* best-effort */ }
      const leftPassword = await session.page.waitForURL((u) => !/\/password/.test(String(u)), { timeout: 6_000 }).then(() => true).catch(() => false);
      if (leftPassword && autoGenerated) {
        emit(WORKER_MARKERS.accountPasswordAutoset, pwd);
      }
    }
  },
  async [PAGE_KINDS.PROFILE](session) {
    emit(WORKER_MARKERS.sentinelProfilePrepare);
    // Đóng tabs lạc (Terms/Privacy tab mở nhầm từ click sai) để tránh accumulate.
    try {
      const pages = session.context.pages();
      for (const p of pages) {
        if (p === session.page) continue;
        const u = p.url();
        if (/privacy|terms|chính sách|điều khoản/i.test(u)) await p.close().catch(() => {});
      }
    } catch { /* best-effort */ }
    const profile = generateInlineProfile(session.oaiDeviceId); // deterministic per account
    // Thử getByLabel (ưu tiên), fallback getByPlaceholder, fallback input[type=text]:nth
    const findName = async () => {
      for (const build of [
        () => session.page.getByLabel(/họ và tên|full name|name|tên/i).first(),
        () => session.page.getByPlaceholder(/họ và tên|full name|name|tên/i).first(),
        () => session.page.locator('input[type="text"]:visible, input:not([type]):visible, input[type="tel"]:visible').first(),
      ]) {
        try {
          const el = build();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) return el;
        } catch { /* next */ }
      }
      return null;
    };
    const nameInput = await findName();
    if (nameInput) {
      await reactSafeFill(nameInput, profile.name).catch(() => {});
    }
    // Birthday / Age field — HAI dạng:
    //   (a) input[type=date] → fill YYYY-MM-DD
    //   (b) input[type=text|tel] với mask MM/DD/YYYY (OpenAI dùng ở /about-you)
    //       → cần type từng ký tự digit (12 chars: MMDDYYYY), browser-side mask
    //       sẽ chèn / tự.
    //   (c) input[type=number|tel] cho AGE (số) → fill age
    const bYear = Number(profile.birthdate.slice(0, 4));
    const bMonth = Number(profile.birthdate.slice(5, 7));
    const bDay = Number(profile.birthdate.slice(8, 10));
    const mm = String(bMonth).padStart(2, "0");
    const dd = String(bDay).padStart(2, "0");
    const mmddyyyy = `${mm}${dd}${bYear}`;
    const ddmmyyyy = `${dd}${mm}${bYear}`;
    // Fallback for age/birthday field — label-less floating label ở OpenAI
    // VERIFY: candidate phải là <input>, không được là <form>/<div>/<label>
    // (getByLabel đôi khi match aria-labelledby lên form container → tag=form).
    const isInputElement = async (el) => {
      try {
        return await el.evaluate((node) => node.tagName && node.tagName.toLowerCase() === "input");
      } catch { return false; }
    };
    const findAge = async () => {
      for (const build of [
        () => session.page.getByLabel(/birthday|birthdate|birth|date of birth|ngày sinh|ngày tháng năm sinh|năm sinh|sinh nhật|bao nhiêu tuổi|tuổi của bạn|tuổi|age/i).first(),
        () => session.page.getByPlaceholder(/age|tuổi|birth|sinh|mm.?dd.?yyyy|dd.?mm.?yyyy|nn.?tt.?nnnn/i).first(),
        // Fallback: input type=number visible (VN UI "Tuổi" thường là <input type="number">)
        () => session.page.locator('input[type="number"]:visible').first(),
        // Fallback: input[inputmode="numeric"] (nhiều UI dùng text + inputmode)
        () => session.page.locator('input[inputmode="numeric"]:visible').first(),
        // Nth(1) = input thứ 2 trên trang (Full name là #1, Age/Birthday là #2)
        () => session.page.locator('input[type="text"]:visible, input[type="number"]:visible, input[type="tel"]:visible, input[type="date"]:visible, input:not([type]):visible').nth(1),
      ]) {
        try {
          const el = build();
          if (!await el.isVisible({ timeout: 2000 }).catch(() => false)) continue;
          if (!await isInputElement(el)) continue; // skip <form>/<div>/<label>
          return el;
        } catch { /* next */ }
      }
      return null;
    };
    const ageInput = await findAge();
    if (!ageInput) {
      // Dump visible inputs để debug — regex label miss khi OpenAI đổi UI copy
      try {
        const dumpDir = path.join(process.cwd(), "tmp", "profile-debug");
        await fs.mkdir(dumpDir, { recursive: true });
        const stamp = String(Date.now());
        const metaPath = path.join(dumpDir, `profile-${stamp}.json`);
        const visible = await session.page.evaluate(() => {
          return [...document.querySelectorAll('input, button, [role="button"], label, h1, h2, h3')].slice(0, 60).map((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0 && el.tagName !== 'LABEL') return null;
            return {
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type'),
              id: el.id || null,
              name: el.getAttribute('name'),
              ariaLabel: el.getAttribute('aria-label'),
              ariaLabelledby: el.getAttribute('aria-labelledby'),
              placeholder: el.getAttribute('placeholder'),
              label: (el.innerText || '').trim().slice(0, 100),
            };
          }).filter(Boolean);
        });
        await fs.writeFile(metaPath, `${JSON.stringify({ url: session.page.url(), visible }, null, 2)}\n`, "utf8");
        console.log(`[profile] age input NOT found — snapshot: ${metaPath}`);
      } catch { /* best-effort */ }
    }
    if (ageInput) {
      const inputType = await ageInput.getAttribute("type").catch(() => null);
      const tagName = await ageInput.evaluate((el) => el.tagName.toLowerCase()).catch(() => "?");
      const label = (await ageInput.getAttribute("aria-label").catch(() => "")) || "";
      const placeholder = (await ageInput.getAttribute("placeholder").catch(() => "")) || "";
      const descriptor = (label + " " + placeholder).toLowerCase();
      const isBirthday = /birth|sinh|birthday|birthdate|mm|dd|yyyy|nn|tt|nnnn/.test(descriptor) || /\/|-/.test(placeholder);
      console.log(`[profile] age field: tag=${tagName} type=${inputType} aria-label="${label.slice(0,40)}" placeholder="${placeholder.slice(0,40)}" isBirthday=${isBirthday}`);
      // Detect order từ placeholder: EN "MM/DD/YYYY" vs VN "DD/MM/YYYY" (hoặc
      // "NN/TT/NNNN"). OpenAI Vietnamese UI dùng DD/MM/YYYY → fill ddmmyyyy
      // thay vì mmddyyyy nếu không sẽ day=15,month=15 → invalid, form reject
      // → PROFILE handler re-loop. Check "dd" đứng trước "mm" trong placeholder.
      const placeLower = placeholder.toLowerCase();
      const ddBeforeMm = /dd[^m]*mm|nn[^t]*tt/.test(placeLower);
      const birthdaySequence = ddBeforeMm ? ddmmyyyy : mmddyyyy;
      // Multi-strategy fill: thử .fill() → .type() → native setter. Verify
      // value sau mỗi strategy. CloakBrowser humanize layer đôi khi nuốt mất
      // keypress, native setter đôi khi bị React 18 validation reject nếu
      // không có focus event thật.
      const readValue = async () => {
        return await ageInput.evaluate((el) => el.value).catch(() => "");
      };
      const forceFill = async (value) => {
        const v = String(value);
        // Strategy 1: Playwright locator.fill() — robust cho controlled input
        try { await ageInput.fill(v, { timeout: 3000 }); } catch { /* next */ }
        if ((await readValue()) === v) return;
        // Strategy 2: click + keyboard type (real keypress events qua CDP)
        try {
          await ageInput.click({ timeout: 3000, force: true }).catch(() => {});
          await ageInput.press("Control+a").catch(() => {});
          await ageInput.press("Delete").catch(() => {});
          await session.page.keyboard.type(v, { delay: 60 });
        } catch { /* next */ }
        if ((await readValue()) === v) return;
        // Strategy 3: native setter + dispatch input/change/focus/blur
        await ageInput.evaluate((el, val) => {
          const proto = window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          el.blur();
        }, v).catch(() => {});
        const final = await readValue();
        console.log(`[profile] age field final value after fill: "${final}" (expected "${v}")`);
      };
      try {
        if (inputType === "date") {
          await forceFill(profile.birthdate);
        } else if (isBirthday) {
          await forceFill(birthdaySequence);
        } else {
          // Age numeric (VN UI "Tuổi" field): fill số nguyên từ profile birthdate.
          const age = Math.max(18, 2026 - bYear);
          await forceFill(String(age));
        }
      } catch { /* best-effort */ }
    }
    const ageConsent = session.page.getByRole("checkbox", { name: /18|older|age|consent|agree/i }).first();
    if (await ageConsent.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ageConsent.check({ timeout: 3000 }).catch(() => {});
    }
    await clickFormSubmit(session.page);
    emit(WORKER_MARKERS.profileCompleted);
    // Chờ URL rời /about-you (OpenAI thường redirect sang /onboarding hoặc
    // chatgpt.com). Nếu stuck 10s → thử Enter press (React form onKeyDown handler
    // đôi khi submit được khi click button bị disabled). Return để adaptive loop
    // reclassify — tránh handler fire lại ngay next tick với findName chờ 30s.
    try {
      await session.page.waitForURL((u) => !/\/about-you/.test(String(u)), { timeout: 10_000 });
      console.log(`[profile] left /about-you, url=${session.page.url()}`);
    } catch {
      console.log(`[profile] stuck at /about-you after submit, trying Enter + reactSafeClick on Continue`);
      await session.page.keyboard.press("Enter").catch(() => {});
      try {
        const cont = session.page.getByRole("button", { name: /^(tiếp tục|continue|next|submit)$/i }).first();
        if (await cont.isVisible({ timeout: 1500 }).catch(() => false)) {
          await reactSafeClick(cont);
        }
      } catch { /* best-effort */ }
      await session.page.waitForURL((u) => !/\/about-you/.test(String(u)), { timeout: 6_000 }).catch(() => {});
    }
  },
  async [PAGE_KINDS.PHONE_NUMBER](session) {
    const phone = await promptForInputOrPageAdvance("phoneNumberPrompt", session.page, /\/add-phone/, { timeoutMs: 600_000 });
    if (!phone) return;
    // Chuẩn hoá E.164: nếu bắt đầu "+", tách country code để chọn dropdown; else
    // fill số raw và để country select mặc định.
    const match = String(phone).trim().match(/^\+(\d{1,3})(\d+)$/);
    let countryCode = null;
    let subscriberNumber = String(phone).replace(/^\+/, "");
    if (match) { countryCode = match[1]; subscriberNumber = match[2]; }
    // Thử chọn country dropdown theo countryCode nếu có
    if (countryCode) {
      const countryName = { "84": "Vietnam", "1": "United States", "66": "Thailand", "60": "Malaysia", "63": "Philippines", "62": "Indonesia", "91": "India", "81": "Japan", "82": "South Korea", "86": "China" }[countryCode];
      if (countryName) {
        try {
          const select = session.page.locator("select, [role='combobox']").first();
          if (await select.isVisible({ timeout: 2000 }).catch(() => false)) {
            await select.click({ timeout: 3000 }).catch(() => {});
            // Option within dropdown panel
            const opt = session.page.getByText(new RegExp(`${countryName}.*\\+${countryCode}|\\+${countryCode}.*${countryName}`, "i")).first();
            if (await opt.isVisible({ timeout: 2000 }).catch(() => false)) {
              await opt.click({ timeout: 3000 }).catch(() => {});
            }
          }
        } catch { /* skip */ }
      }
    }
    await waitForReactReady(session.page);
    // Tìm phone input: role=textbox name phone/số, fallback input[type=tel]
    let input = session.page.getByRole("textbox", { name: /phone|số điện thoại/i }).first();
    if (!(await input.isVisible({ timeout: 2000 }).catch(() => false))) {
      input = session.page.locator('input[type="tel"]:visible, input[inputmode="tel"]:visible').first();
    }
    const fullE164 = String(phone).trim().startsWith("+") ? phone : (countryCode ? `+${countryCode}${subscriberNumber}` : subscriberNumber);
    await reactSafeFill(input, fullE164);
    await session.page.waitForTimeout(500); // chờ validation
    // VN UI: OpenAI add-phone yêu cầu chọn "Gửi mã qua" (Tin nhắn văn bản /
    // WhatsApp) TRƯỚC khi nút Tiếp tục enable. Default EN UI chỉ có text SMS →
    // continue sẵn enable. Click "Tin nhắn văn bản" / "Text message" nếu có.
    try {
      const smsPill = session.page.getByRole("button", { name: /^(tin nhắn văn bản|text message|sms)$/i }).first();
      if (await smsPill.isVisible({ timeout: 1500 }).catch(() => false)) {
        await smsPill.click({ timeout: 3000, force: true }).catch(() => {});
        await session.page.waitForTimeout(300);
      } else {
        // Fallback: locator CSS has-text
        const alt = session.page.locator('button:has-text("Tin nhắn văn bản"), button:has-text("Text message"), [role="radio"]:has-text("Tin nhắn")').first();
        if (await alt.isVisible({ timeout: 1200 }).catch(() => false)) {
          await alt.click({ timeout: 3000, force: true }).catch(() => {});
          await session.page.waitForTimeout(300);
        }
      }
    } catch { /* best-effort */ }
    await clickFormSubmit(session.page);
    // Verify: nếu OpenAI reject số (hiển "không hợp lệ" / "invalid" / "chuyển
    // sang WhatsApp" / bất kỳ error UI nào ngay dưới input), URL vẫn /add-phone
    // hoặc có alert đỏ sau submit. Emit "[warn] Could not send SMS to <phone>:
    // <reason>" để console-server tự block số + trigger change_phone (xem
    // console-server.mjs:3034). Scan 2 nguồn: URL change + visible alert text.
    // User policy: bất kỳ phản hồi lỗi về SMS cho số đó = số không sạch, phải
    // đổi số, không cố retry.
    const urlLeft = await session.page.waitForURL(
      (u) => !/\/add-phone/.test(String(u)),
      { timeout: 6_000 },
    ).then(() => true).catch(() => false);
    // Scan error alert dù URL đã rời hay không — OpenAI đôi khi redirect sang
    // /phone-verification nhưng vẫn hiển error (WhatsApp fallback modal).
    const uiState = await session.page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      // Thu error alerts qua role=alert, aria-live, class chứa red/error/danger
      const alerts = [...main.querySelectorAll('[role="alert"], [aria-live], [class*="error" i], [class*="danger" i], [class*="red" i], [class*="warn" i]')]
        .map((el) => (el.innerText || "").trim())
        .filter((t) => t && t.length < 500);
      const fullText = (main.innerText || "").slice(0, 1500);
      return { alerts, fullText };
    }).catch(() => ({ alerts: [], fullText: "" }));
    const corpus = `${uiState.alerts.join("\n")}\n${uiState.fullText}`;
    // Broad regex: bất kỳ phrase về SMS fail / WhatsApp fallback / invalid /
    // retry → block số. User policy: "bất kì phản hồi đều là lỗi về sms".
    const smsBadPatterns = /số điện thoại.*không hợp lệ|không hợp lệ|vui lòng kiểm tra|kiểm tra và thử lại|không thể gửi|không gửi được|chuyển sang whatsapp|whatsapp|invalid.*phone|phone.*invalid|phone.*not.*valid|not valid|cannot send|can'?t send|unable to send|try again|retry|verify.*whatsapp|số không được chấp nhận|unsupported|please check/i;
    const hasError = smsBadPatterns.test(corpus);
    if (hasError) {
      // Lấy snippet lỗi để log (ưu tiên alert, fallback full text match)
      const match = (uiState.alerts.find((a) => smsBadPatterns.test(a))
        || corpus.match(smsBadPatterns)?.[0]
        || "SMS/WhatsApp warning detected"
      ).toString().replace(/\s+/g, " ").slice(0, 160);
      console.log(`[warn] Could not send SMS to ${fullE164}: ${match}`);
      return;
    }
    if (urlLeft) {
      console.log(`[phone] accepted ${fullE164}, url=${session.page.url()}`);
    } else {
      console.log(`[phone] still at /add-phone after submit, no explicit error detected — continuing loop; snippet: ${uiState.fullText.slice(0, 160).replace(/\s+/g, " ")}`);
    }
  },
  async [PAGE_KINDS.PHONE_OTP](session) {
    await waitForReactReady(session.page);
    const otp = await promptForInputOrPageAdvance("phoneOtpPrompt", session.page, /\/phone-verification/, { timeoutMs: 600_000 });
    if (!otp) return;
    // "r" từ console-server = resend_phone. Click "Resend text message" rồi
    // return, next tick re-prompt stdin cho OTP mới.
    const act = String(otp).trim().toLowerCase();
    if (act === "r") {
      try {
        const candidates = [
          () => session.page.getByRole("button", { name: /resend text message|resend|gửi lại/i }).first(),
          () => session.page.getByRole("link", { name: /resend text message|resend|gửi lại/i }).first(),
          () => session.page.locator('button:has-text("Resend"), a:has-text("Resend"), [role="button"]:has-text("Resend")').first(),
        ];
        for (const build of candidates) {
          const btn = build();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click({ timeout: 5000 }).catch(() => {});
            break;
          }
        }
      } catch { /* best-effort */ }
      return;
    }
    // "p" từ console-server = change_phone. Phải quay lại /add-phone để nhập
    // số khác. Thử: click "Change phone"/"Back" link trong trang, fallback
    // page.goBack() browser history, fallback navigate trực tiếp /add-phone.
    if (act === "p") {
      try {
        const candidates = [
          () => session.page.getByRole("link", { name: /change phone|change number|đổi số|back|quay lại/i }).first(),
          () => session.page.getByRole("button", { name: /change phone|change number|đổi số|back|quay lại/i }).first(),
          () => session.page.locator('a:has-text("Change"), button:has-text("Change"), a:has-text("Back"), button:has-text("Back")').first(),
        ];
        let clicked = false;
        for (const build of candidates) {
          const btn = build();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click({ timeout: 5000 }).catch(() => {});
            clicked = true;
            break;
          }
        }
        if (!clicked) {
          // Fallback 1: browser history back
          await session.page.goBack({ timeout: 10_000, waitUntil: "domcontentloaded" }).catch(() => {});
          await session.page.waitForTimeout(800);
          // Fallback 2: nếu URL vẫn ở phone-verification, nav thẳng /add-phone
          if (/\/phone-verification/.test(session.page.url())) {
            await session.page.goto("https://auth.openai.com/add-phone", { timeout: 15_000, waitUntil: "domcontentloaded" }).catch(() => {});
          }
        }
      } catch { /* best-effort */ }
      return;
    }
    const input = session.page.getByLabel(/mã|code|otp|verification/i).first();
    if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) return;
    await reactSafeFill(input, otp);
    await clickFormSubmit(session.page);
    emit(WORKER_MARKERS.phoneOtpValidated);
  },
  async [PAGE_KINDS.OAUTH_CONSENT](session) {
    emit(WORKER_MARKERS.codexOauthStart);
    await session.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await session.page.waitForTimeout(1200);
    // SAFETY: chỉ click EXACT safe text, không bao giờ click Cancel/Hủy/Logout.
    const SAFE_NAMES = /^(tiếp tục|continue|authorize|allow|accept|cho phép|chấp nhận|đồng ý|next|xác nhận|confirm)$/i;
    const UNSAFE_NAMES = /^(cancel|hủy|deny|từ chối|back|quay lại|dùng tài khoản khác|switch account|sign out|đăng xuất|logout)$/i;

    const tryClickSafe = async (locator) => {
      if (!await locator.isVisible({ timeout: 2000 }).catch(() => false)) return false;
      const txt = (await locator.innerText().catch(() => "")).trim();
      if (!txt || UNSAFE_NAMES.test(txt)) return false;
      console.log(`[oauth-consent] click safe button "${txt}"`);
      // Escalation: scroll + hover + CDP mouse → locator click → focus+Enter → JS dispatch
      await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await locator.hover({ timeout: 1500 }).catch(() => {});
      await session.page.waitForTimeout(150);
      const urlBefore = session.page.url();
      // A: CDP mouse via bounding box
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await session.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 }).catch(() => {});
        await session.page.waitForTimeout(80);
        await session.page.mouse.down().catch(() => {});
        await session.page.waitForTimeout(50);
        await session.page.mouse.up().catch(() => {});
        await session.page.waitForTimeout(1500);
        if (session.page.url() !== urlBefore) return true;
      }
      // B: locator.click force
      await locator.click({ timeout: 4000, force: true }).catch(() => {});
      await session.page.waitForTimeout(1500);
      if (session.page.url() !== urlBefore) return true;
      // C: focus + Enter
      await locator.focus().catch(() => {});
      await session.page.keyboard.press("Enter").catch(() => {});
      await session.page.waitForTimeout(1500);
      if (session.page.url() !== urlBefore) return true;
      // D: JS dispatchEvent chain
      await locator.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window, button: 0,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
          try { node.dispatchEvent(new PointerEvent(t, opts)); } catch { node.dispatchEvent(new MouseEvent(t, opts)); }
        });
        node.click();
      }).catch(() => {});
      await session.page.waitForTimeout(1500);
      return session.page.url() !== urlBefore;
    };

    // Candidates: role=button SAFE_NAMES first, then form submit[type=submit]
    const candidates = [
      () => session.page.getByRole("button", { name: SAFE_NAMES }).first(),
      () => session.page.locator('form button[type="submit"]:visible').first(),
      () => session.page.locator('button:visible').filter({ hasText: SAFE_NAMES }).filter({ hasNotText: UNSAFE_NAMES }).first(),
    ];
    for (const build of candidates) {
      try {
        const el = build();
        if (await tryClickSafe(el)) return;
      } catch { /* next */ }
    }
    console.log("[oauth-consent] all strategies did not advance URL");
  },
  async [PAGE_KINDS.WORKSPACE_SELECT](session, args) {
    // Chờ React hydrate (page vừa load từ redirect)
    await session.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await session.page.waitForTimeout(1200);

    // Dump DOM ngay vào entry (one-time per handler tick) để debug — luôn biết
    // page đang hiện gì, kể cả khi strategy "thành công" nhưng click sai element.
    try {
      const dumpDir = path.join(process.cwd(), "tmp", "workspace-debug");
      await fs.mkdir(dumpDir, { recursive: true });
      const stamp = String(Date.now());
      const htmlPath = path.join(dumpDir, `workspace-entry-${stamp}.html`);
      const metaPath = path.join(dumpDir, `workspace-entry-${stamp}.json`);
      const html = await session.page.content();
      await fs.writeFile(htmlPath, html, "utf8");
      const visible = await session.page.evaluate(() => {
        const peek = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          return {
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type"),
            id: el.id || null,
            role: el.getAttribute("role"),
            testid: el.getAttribute("data-testid"),
            tabindex: el.getAttribute("tabindex"),
            ariaLabel: el.getAttribute("aria-label"),
            className: (el.className || "").toString().slice(0, 100),
            text: (el.innerText || "").trim().slice(0, 120),
            hasOnClick: !!el.onclick,
            cursorPointer: window.getComputedStyle(el).cursor === "pointer",
          };
        };
        return [...document.querySelectorAll('button, [role="button"], a, div[tabindex], h1, h2, h3')].map(peek).filter(Boolean).slice(0, 50);
      });
      await fs.writeFile(metaPath, `${JSON.stringify({ url: session.page.url(), title: await session.page.title().catch(() => ""), visible }, null, 2)}\n`, "utf8");
      console.log(`[workspace-select] entry snapshot — ${metaPath}`);
    } catch (err) {
      console.log(`[workspace-select] entry dump failed: ${err?.message || err}`);
    }

    // "Welcome back / Choose an account" page. Giống LANDING: React synthetic
    // listener gắn chậm, native .click() có thể bị skip. Dùng escalation 4
    // chiến lược giống LANDING + verify URL advance.

    const startUrl = session.page.url();
    const urlAdvanced = async () => {
      const u = session.page.url();
      return u !== startUrl && !/\/choose-an-account|\/workspace\/select/.test(u);
    };

    // Build locator cho card chứa email. Walk up tới ancestor clickable qua XPath.
    // Nhiều biến thể: button/role=button/a/div[tabindex]/div[onclick].
    const cardCandidates = [
      () => session.page.locator(`button:has-text("${args.email}")`).first(),
      () => session.page.locator(`[role="button"]:has-text("${args.email}")`).first(),
      () => session.page.locator(`a:has-text("${args.email}")`).first(),
      () => session.page.locator(`div[tabindex]:has-text("${args.email}")`).first(),
      // Fallback: text node → first ancestor có cursor:pointer / clickable role
      () => session.page.getByText(args.email, { exact: false }).first()
        .locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button" or @tabindex][1]').first(),
    ];

    for (const build of cardCandidates) {
      let card;
      try { card = build(); } catch { continue; }
      if (!await card.isVisible({ timeout: 1500 }).catch(() => false)) continue;

      await card.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await card.hover({ timeout: 2000 }).catch(() => {});
      await session.page.waitForTimeout(200);

      // Strategy A: raw page.mouse (CDP native) — bypass locator abstraction
      const box = await card.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await session.page.mouse.move(x, y, { steps: 10 }).catch(() => {});
        await session.page.waitForTimeout(100);
        await session.page.mouse.down().catch(() => {});
        await session.page.waitForTimeout(50);
        await session.page.mouse.up().catch(() => {});
        await session.page.waitForTimeout(1800);
        if (await urlAdvanced()) {
          await clickFormSubmit(session.page).catch(() => {});
          return;
        }
      }

      // Strategy B: locator.click force
      await card.click({ timeout: 5000, force: true }).catch(() => {});
      await session.page.waitForTimeout(1500);
      if (await urlAdvanced()) {
        await clickFormSubmit(session.page).catch(() => {});
        return;
      }

      // Strategy C: focus + Enter
      await card.focus().catch(() => {});
      await session.page.keyboard.press("Enter").catch(() => {});
      await session.page.waitForTimeout(1500);
      if (await urlAdvanced()) {
        await clickFormSubmit(session.page).catch(() => {});
        return;
      }

      // Strategy D: JS dispatchEvent chain (PointerEvent + MouseEvent + .click())
      await card.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window, button: 0,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
          try { node.dispatchEvent(new PointerEvent(t, opts)); } catch { node.dispatchEvent(new MouseEvent(t, opts)); }
        });
        node.click();
      }).catch(() => {});
      await session.page.waitForTimeout(1500);
      if (await urlAdvanced()) {
        await clickFormSubmit(session.page).catch(() => {});
        return;
      }
    }

    // Fallback 1: radio input (nếu OpenAI dùng radio pattern)
    try {
      const radio = session.page.getByRole("radio").first();
      if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
        await radio.check({ timeout: 3000 }).catch(() => {});
        await clickFormSubmit(session.page);
        if (await urlAdvanced()) return;
      }
    } catch { /* next */ }

    // Fallback 2: JS scan + synthetic click chain trên bất kỳ element chứa email
    try {
      const ok = await session.page.evaluate((email) => {
        const nodes = [...document.querySelectorAll('button, [role="button"], a, div[tabindex], div')];
        for (const n of nodes) {
          const txt = (n.innerText || "").trim();
          if (!txt.includes(email)) continue;
          // Walk up tìm clickable ancestor
          let el = n;
          for (let i = 0; i < 6 && el; i += 1) {
            const style = window.getComputedStyle(el);
            if (el.onclick || el.getAttribute("role") === "button" || el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("tabindex") !== null || style.cursor === "pointer") {
              const rect = el.getBoundingClientRect();
              const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
              ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
                try { el.dispatchEvent(new PointerEvent(t, opts)); } catch { el.dispatchEvent(new MouseEvent(t, opts)); }
              });
              el.click();
              return true;
            }
            el = el.parentElement;
          }
          n.click();
          return true;
        }
        return false;
      }, args.email);
      if (ok) {
        await session.page.waitForTimeout(1500);
        await clickFormSubmit(session.page).catch(() => {});
        if (await urlAdvanced()) return;
      }
    } catch { /* give up */ }

    // CLICK MISS: dump DOM snapshot + visible buttons để fix selector tiếp
    try {
      const dumpDir = path.join(process.cwd(), "tmp", "workspace-debug");
      await fs.mkdir(dumpDir, { recursive: true });
      const stamp = String(Date.now());
      const htmlPath = path.join(dumpDir, `workspace-${stamp}.html`);
      const metaPath = path.join(dumpDir, `workspace-${stamp}.json`);
      const html = await session.page.content();
      await fs.writeFile(htmlPath, html, "utf8");
      const visible = await session.page.evaluate(() => {
        const peek = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          return {
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type"),
            id: el.id || null,
            role: el.getAttribute("role"),
            testid: el.getAttribute("data-testid"),
            tabindex: el.getAttribute("tabindex"),
            ariaLabel: el.getAttribute("aria-label"),
            className: (el.className || "").toString().slice(0, 100),
            text: (el.innerText || "").trim().slice(0, 120),
            hasOnClick: !!el.onclick,
            cursorPointer: window.getComputedStyle(el).cursor === "pointer",
          };
        };
        return [...document.querySelectorAll('button, [role="button"], a, div[tabindex], div')].map(peek).filter(Boolean).slice(0, 60);
      });
      await fs.writeFile(metaPath, `${JSON.stringify({ url: session.page.url(), title: await session.page.title().catch(() => ""), visible }, null, 2)}\n`, "utf8");
      console.log(`[workspace-select] CLICK MISS — snapshots: ${htmlPath} + ${metaPath}`);
    } catch (err) {
      console.log(`[workspace-select] dump failed: ${err?.message || err}`);
    }
  },
};

async function handleSignupAdaptive(args) {
  if (!args.email) throw new Error("MISSING_EMAIL: --email is required for a signup run");
  const sub2apiOut = args.sub2apiOut || args.out;
  if (!sub2apiOut) throw new Error("MISSING_OUTPUT: --sub2api-out is required");
  const checkpointPath = args.checkpoint || null;

  const proxyUrl = args.proxy || process.env.CHATGPT_PROXY_URL || null;
  if (!proxyUrl && !args.allowDirectIp) {
    throw new Error("BROWSER_PROXY_REQUIRED: --proxy / CHATGPT_PROXY_URL is required for signup. Pass --allow-direct-ip only for offline tests.");
  }

  const session = await openBrowser({ email: args.email, proxy: proxyUrl, verbose: args.verbose });
  // Set up OAuth callback intercept BEFORE any navigation — catches redirect
  // from any OAuth consent page regardless of which stage drove it.
  const oauth = await setupCodexOauthInterceptEarly(session, {
    authBase: args.authBase || DEFAULT_AUTH_BASE,
    clientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
    redirectUri: args.codexRedirectUri || DEFAULT_CODEX_REDIRECT_URI,
    checkpointPath,
  });

  try {
    await proxyPreflight(session, args);
    const signupUrl = await findReachableSignupUrl(session);
    await session.page.goto(signupUrl, { timeout: PAGE_IDLE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    await assertNotCloudflareStuck(session);
    // Chờ React hydrate xong — ChatGPT nặng, HTML render trước, onClick handlers
    // attach sau 1-3s. Click Login quá sớm sẽ fire vào button chưa có handler.
    // Dùng networkidle hoặc timeout làm proxy cho hydration done.
    await session.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await session.page.waitForTimeout(1500);

    const startedAt = Date.now();
    let lastKind = null;
    let sameKindCount = 0;
    let navigatedToOauth = false;
    while (Date.now() - startedAt < ADAPTIVE_LOOP_TIMEOUT_MS) {
      if (oauth.capturedUrl) break;
      const kind = await detectPageKind(session.page);
      if (kind === PAGE_KINDS.DONE) break;
      if (kind === PAGE_KINDS.WRONG_OAUTH) throw new Error(`WRONG_OAUTH_DESTINATION: ${session.page.url()}`);
      // Account deactivated: fail-fast, không retry. Gọi handler để extract
      // request_id + log, rồi throw thẳng ra try/catch outer để adaptive loop
      // không bắt (handler throw ACCOUNT_DEACTIVATED → server scan [error] →
      // isPermanentAccountFailure → failAccountClosedDuringLogin).
      if (kind === PAGE_KINDS.ACCOUNT_DEACTIVATED) {
        console.log(`[adaptive] page=${kind} url=${session.page.url()} — fail-fast, không retry`);
        await PAGE_HANDLERS[PAGE_KINDS.ACCOUNT_DEACTIVATED](session, args);
        // handler đã throw; code dưới không chạy, nhưng để chắc:
        throw new Error("ACCOUNT_DEACTIVATED: handler returned without throwing");
      }

      if (kind === lastKind) {
        sameKindCount += 1;
      } else {
        console.log(`[adaptive] page=${kind} url=${session.page.url()}`);
        sameKindCount = 0;
        lastKind = kind;
      }

      // If no OAuth consent reached after login flow, drive to authorize URL.
      if (!navigatedToOauth && kind === PAGE_KINDS.UNKNOWN && sameKindCount >= 2) {
        console.log("[adaptive] no known page detected — navigating to Codex OAuth authorize");
        await session.page.goto(oauth.authUrl, { timeout: PAGE_IDLE_TIMEOUT_MS, waitUntil: "domcontentloaded" }).catch(() => {});
        navigatedToOauth = true;
        await session.page.waitForTimeout(1500);
        continue;
      }
      // Sau onboarding (chatgpt.com main → LANDING kind): user đã signed in,
      // navigate thẳng oauth.authUrl để Codex consent → callback → DONE.
      // Dùng flag riêng để không conflict với navigatedToOauth path trên.
      if (!navigatedToOauth && kind === PAGE_KINDS.LANDING && lastKind === PAGE_KINDS.ONBOARDING) {
        console.log("[adaptive] onboarding done, chatgpt.com reached — navigating to Codex OAuth authorize");
        await session.page.goto(oauth.authUrl, { timeout: PAGE_IDLE_TIMEOUT_MS, waitUntil: "domcontentloaded" }).catch(() => {});
        navigatedToOauth = true;
        await session.page.waitForTimeout(1500);
        continue;
      }
      // Force-relogin: user đã có session (userDataDir có cookie), chatgpt.com
      // không hiện login modal → LANDING handler click vào trống → sameKindCount
      // tăng. Sau 2 LANDING tick vẫn ở landing (không advance) → nghĩa là đã
      // signed in, cần navigate oauth luôn để trigger Codex consent → callback.
      if (!navigatedToOauth && kind === PAGE_KINDS.LANDING && sameKindCount >= 2) {
        console.log("[adaptive] LANDING loop — session đã có, navigate Codex OAuth để capture code");
        await session.page.goto(oauth.authUrl, { timeout: PAGE_IDLE_TIMEOUT_MS, waitUntil: "domcontentloaded" }).catch(() => {});
        navigatedToOauth = true;
        await session.page.waitForTimeout(1500);
        continue;
      }
      // PROFILE stuck: handler fire >= 2 lần, URL vẫn /about-you. React submit
      // không propagate (button disabled hoặc field validation reject). Force
      // navigate chatgpt.com/ để OpenAI tự redirect sang onboarding hoặc
      // return LANDING. Giải pháp triệt để cho edge case controlled input +
      // age validation reject. Giảm threshold xuống 2 (từ 3) để không hit
      // CODEX_CALLBACK_TIMEOUT khi handler mỗi call ~16s (waitForURL + fallback).
      if (kind === PAGE_KINDS.PROFILE && sameKindCount >= 2) {
        console.log("[adaptive] PROFILE loop stuck — force navigate chatgpt.com/ để bypass form");
        await session.page.goto("https://chatgpt.com/", { timeout: PAGE_IDLE_TIMEOUT_MS, waitUntil: "domcontentloaded" }).catch(() => {});
        sameKindCount = 0;
        lastKind = null;
        await session.page.waitForTimeout(2000);
        continue;
      }

      if (kind === PAGE_KINDS.UNKNOWN) {
        if (sameKindCount >= 20) {
          throw new Error(`ADAPTIVE_STUCK_UNKNOWN at ${session.page.url()}`);
        }
        await session.page.waitForTimeout(2000);
        continue;
      }

      const handler = PAGE_HANDLERS[kind];
      if (!handler) {
        await session.page.waitForTimeout(2000);
        continue;
      }
      try {
        await handler(session, args);
        await saveCheckpoint(checkpointPath, { stage: `adaptive:${kind}`, oai_device_id: session.oaiDeviceId });
      } catch (err) {
        console.log(`[adaptive] handler ${kind} threw: ${err?.message || err} — continuing loop (manual drive possible)`);
      }
      await session.page.waitForTimeout(1500);
    }

    if (!oauth.capturedUrl) throw new Error("CODEX_CALLBACK_TIMEOUT: did not observe the Codex redirect within the window");

    const tokenSet = await exchangeOAuthCodeInline({
      authBase: args.authBase || DEFAULT_AUTH_BASE,
      clientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
      code: new URL(oauth.capturedUrl).searchParams.get("code"),
      codeVerifier: oauth.codeVerifier,
      redirectUri: args.codexRedirectUri || DEFAULT_CODEX_REDIRECT_URI,
    });
    const sub2apiPayload = buildSub2ApiPayload({
      tokenSet,
      email: args.email,
      proxyUrl: session.proxyUrl,
      clientId: args.codexClientId || DEFAULT_CODEX_CLIENT_ID,
      accountName: args.sub2apiName || null,
      concurrency: Number(args.concurrency || 10),
      priority: Number(args.priority || 1),
      rateMultiplier: Number(args.rateMultiplier || 1),
    });
    await writeJsonAtomic(sub2apiOut, sub2apiPayload);
    emit(WORKER_MARKERS.savedSub2api, sub2apiOut);
  } finally {
    // 2 lớp exit: (1) 8s watchdog nếu session.close() treo; (2) explicit
    // process.exit(0) sau 500ms khi close xong (không rely event loop drain —
    // CloakBrowser humanize đôi khi để lại timer giữ loop → server thấy child
    // không close → job treo "finalizing" vĩnh viễn).
    const forceExitTimer = setTimeout(() => {
      try { if (process.stdout.write("")) process.stdout.end?.(); } catch {}
      process.exit(0);
    }, 8_000);
    forceExitTimer.unref?.();
    try { await session.close(); } catch { /* best-effort */ }
    clearTimeout(forceExitTimer);
    setTimeout(() => { process.exit(0); }, 500);
  }
}

// Pure-HTTPS OAuth code → token exchange. Inlined ở đây vì protocol-login.mjs
// là CLI, không export được. Chuẩn OAuth2 PKCE code exchange theo protocol.mjs.
async function exchangeOAuthCodeInline({ authBase, clientId, code, codeVerifier, redirectUri }) {
  const res = await fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "codex-cli/0.1.0",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Token endpoint returned non-JSON HTTP ${res.status}: ${text.slice(0, 180)}`); }
  if (!res.ok) {
    const message = data?.error_description || data?.error || JSON.stringify(data).slice(0, 180);
    throw new Error(`Token exchange failed with HTTP ${res.status}: ${message}`);
  }
  for (const key of ["access_token", "refresh_token", "id_token"]) {
    if (!data[key]) throw new Error(`Token response missing ${key}.`);
  }
  return data;
}

async function setupCodexOauthInterceptEarly(session, { authBase, clientId, redirectUri, checkpointPath }) {
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  const authUrl =
    `${authBase}/oauth/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      codex_cli_simplified_flow: "true",
      id_token_add_organizations: "true",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile email offline_access",
      state,
    }).toString();

  await saveCheckpoint(checkpointPath, { stage: "callback_ready", codeVerifier, state, oai_device_id: session.oaiDeviceId });

  const slot = { capturedUrl: null, codeVerifier, state, authUrl };
  const intercept = async (route) => {
    slot.capturedUrl = route.request().url();
    await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
  };
  await session.context.route("**://localhost:1455/auth/callback*", intercept);
  await session.context.route("**://127.0.0.1:1455/auth/callback*", intercept);
  return slot;
}

// ---------------------------------------------------------------------------
// Chromium session
// ---------------------------------------------------------------------------

async function openBrowser({ email, proxy, verbose }) {
  const oaiDeviceId = process.env.CHATGPT_OAI_DEVICE_ID || oaiDeviceIdFromEmail(email);
  const chrome = await detectInstalledChrome();
  if (!chrome?.bin) {
    throw new Error("CHROME_NOT_FOUND: Google Chrome Stable required for the browser lane. Install via `brew install --cask google-chrome`.");
  }
  const profileRoot = process.env.ONBOARDING_BROWSER_PROFILE_ROOT
    || path.join(process.env.ONBOARDING_OUTPUT_ROOT || path.join(process.cwd(), "tmp", "chatgpt-onboarding"), "browser-profiles");
  const profileKey = crypto.createHash("sha256").update(String(oaiDeviceId)).digest("hex").slice(0, 16);
  const userDataDir = path.join(profileRoot, profileKey);
  await fs.mkdir(userDataDir, { recursive: true });
  await sweepStaleSingletonLocks(userDataDir);

  // Browser engine chọn qua env CHATGPT_BROWSER_ENGINE:
  //   "patchright" (default) → Patchright + Google Chrome Stable (TLS fingerprint =
  //     Chrome 154 host). SOCKS5+auth KHÔNG hỗ trợ.
  //   "cloak" → CloakBrowser (Chromium fork với 87 C++ patches, Chromium 145 free
  //     tier). SOCKS5+auth NATIVE. Fingerprint khác hẳn Patchright.
  const engine = (process.env.CHATGPT_BROWSER_ENGINE || "patchright").toLowerCase();
  const proxyUrl = normalizeProxyUrl(proxy);
  if (proxyUrl && (proxyUrl.scheme === "socks5" || proxyUrl.scheme === "socks5h") && engine !== "cloak") {
    emit(WORKER_MARKERS.browserProxySchemeUnsupported);
    throw new Error("BROWSER_PROXY_SCHEME_UNSUPPORTED: Patchright/Chromium does not accept SOCKS5 proxy credentials via --proxy-server. Switch to CHATGPT_BROWSER_ENGINE=cloak for socks5+auth, or use HTTP(S) proxy.");
  }

  // Compute viewport sớm để pass vào launchArgs --window-size (tránh Chromium
  // mở fullscreen → viewport nhỏ hơn window → trống đen phía dưới page).
  const _earlyFp = buildPerAccountFingerprint({ oaiDeviceId });
  const _vw = Number(_earlyFp.viewport?.width) || 1440;
  const _vh = Number(_earlyFp.viewport?.height) || 900;
  const launchArgs = [
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,InterestFeedContentSuggestions,PasswordLeakDetection,CalculateNativeWinOcclusion,HeavyAdPrivacyMitigations,HttpsUpgrades,InsecureFormSubmissionWarning,InsecurePasswordRedaction,BackForwardCache,DisableLoadExtensionCommandLineSwitch",
    "--disk-cache-size=52428800",
    `--window-size=${_vw},${_vh + 100}`,
  ];
  const launchOptions = {
    headless: false,
    args: launchArgs,
    ignoreDefaultArgs: ["--enable-automation"],
    // Manual-assist: giữ Chromium alive khi worker exit (user tiếp tục drive tay).
    ...(MANUAL_ASSIST ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
  };
  // Local chain proxy: nếu upstream cần auth hoặc dùng SOCKS5, mở local
  // 127.0.0.1:0 HTTP proxy no-auth → forward sang upstream với creds. Chromium
  // thấy proxy localhost thì không cần Fetch.continueWithAuth → bypass
  // CloakBrowser humanize interception. Root cause fix cho
  // ERR_NO_SUPPORTED_PROXIES / 407 khi upstream HTTP có Basic auth.
  let localChain = null;
  const needsChain = Boolean(proxyUrl && (proxyUrl.username || proxyUrl.scheme === "socks5" || proxyUrl.scheme === "socks5h"));
  if (needsChain) {
    localChain = await startLocalChainProxy(proxyUrl).catch((e) => {
      console.log(`[chain-proxy] start failed: ${e.message} — falling back to direct proxy launch`);
      return null;
    });
    if (localChain) {
      console.log(`[chain-proxy] listening http://127.0.0.1:${localChain.port} → upstream ${proxyUrl.scheme}://${proxyUrl.host}:${proxyUrl.port}`);
    }
  }
  if (proxyUrl) {
    if (localChain) {
      launchOptions.proxy = { server: `http://${localChain.host}:${localChain.port}` };
    } else {
      launchOptions.proxy = {
        server: `${proxyUrl.scheme}://${proxyUrl.host}:${proxyUrl.port}`,
        ...(proxyUrl.username ? { username: proxyUrl.username, password: proxyUrl.password || "" } : {}),
      };
    }
  }

  let context;
  if (engine === "cloak") {
    // CloakBrowser — proxy object form. Nếu local chain đã mở, pass
    // {server: "http://127.0.0.1:PORT"} no-auth → tránh CloakBrowser humanize
    // layer nuốt CDP Fetch.continueWithAuth (root cause ERR_NO_SUPPORTED_PROXIES).
    // Nếu không có chain (upstream no-auth), vẫn pass object form với creds.
    const cb = await import("cloakbrowser");
    const proxyObject = localChain
      ? { server: `http://${localChain.host}:${localChain.port}` }
      : proxyUrl
        ? {
            server: `${proxyUrl.scheme}://${proxyUrl.host}:${proxyUrl.port}`,
            ...(proxyUrl.username ? { username: proxyUrl.username, password: proxyUrl.password || "" } : {}),
          }
        : undefined;
    if (verbose) console.log(`[browser] launching CloakBrowser (version=${cb.CHROMIUM_VERSION}) proxy=${proxyObject ? (localChain ? "chain" : "set") : "none"}`);
    const cbInfo = cb.binaryInfo();
    // UA phải khớp Chromium runtime THẬT của CloakBrowser (vd runtime 146 mà
    // CloakBrowser humanize UA pool có khi lagging 145 → pixelscan flag
    // "Masking detected" vì Sec-CH-UA sẽ gửi major thật, mismatch với UA).
    const cloakMajor = Number(String(cb.CHROMIUM_VERSION || "").split(".")[0]) || chrome.major;
    const matchedUserAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${cloakMajor}.0.0.0 Safari/537.36`;
    // Fingerprint viewport đã compute per-account trong fingerprint object; apply
    // vào CloakBrowser launch (chuẩn hoá size, tránh default 1280×720).
    const _fp = buildPerAccountFingerprint({ oaiDeviceId });
    const cbOpts = {
      userDataDir,
      headless: false,
      humanize: true,
      // geoip:true cần mmdb-lib + .mmdb file (MaxMind GeoLite2). Bật qua
      // env TOSUB2_CLOAK_GEOIP=1 nếu đã nạp DB. Mặc định false để tránh crash.
      geoip: process.env.TOSUB2_CLOAK_GEOIP === "1" && Boolean(proxyObject),
      args: launchArgs,
      // Chuẩn hoá UA + locale + timezone để fingerprint consistent (fix
      // pixelscan "Masking detected" do Chrome UA mismatch Chromium runtime major
      // và "Asia/Saigon" IANA alias cũ thay vì "Asia/Ho_Chi_Minh").
      userAgent: matchedUserAgent,
      locale: "vi-VN",
      timezoneId: "Asia/Ho_Chi_Minh",
      viewport: { width: _fp.viewport.width, height: _fp.viewport.height },
      ...(proxyObject ? { proxy: proxyObject } : {}),
      ...(MANUAL_ASSIST ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
    };
    context = await cb.launchPersistentContext(cbOpts);
    // Overwrite "chrome" return field for the report so caller sees cloak version.
    chrome.bin = cbInfo.binaryPath || chrome.bin;
    chrome.major = cloakMajor;
    chrome.version = `CloakBrowser Chromium ${cb.CHROMIUM_VERSION || ""}`;
  } else {
    const { chromium } = await import("patchright");
    if (verbose) console.log(`[browser] launching ${chrome.bin} (major=${chrome.major}) [patchright]`);
    context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      channel: "chrome",
      ...buildContextOptions({
        fingerprint: buildPerAccountFingerprint({ oaiDeviceId }),
        proxy: launchOptions.proxy,
      }),
      executablePath: chrome.bin,
    });
  }

  // Measure the host's real-ish values once, then apply the per-account knobs.
  const hostProfile = await detectHostProfile(context).catch(() => ({}));
  const fingerprint = buildPerAccountFingerprint({ oaiDeviceId, hostProfile });
  await context.addInitScript({ content: buildInitScript(fingerprint) });
  // Accept-Language header only: CloakBrowser humanize ghi đè bất chấp
  // buildContextOptions. Force sau khi context ready để match navigator.languages
  // = vi-VN. KHÔNG set Sec-CH-UA manual — CloakBrowser's Chromium gửi Sec-CH-UA
  // native từ binary, duplicate hoặc override thường trigger Cloudflare challenge
  // (double headers inconsistent). UA mình set qua launch option (Chrome/146.0.0.0)
  // sẽ sync với Sec-CH-UA native của Chromium 146.
  await context.setExtraHTTPHeaders({
    "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  }).catch(() => {});

  // Pre-set oai-did on both OpenAI domains BEFORE first navigation, so
  // chatgpt.com's middleware does not mint its own device identifier.
  const now = Math.floor(Date.now() / 1000);
  await context.addCookies([
    {
      name: "oai-did",
      value: oaiDeviceId,
      domain: ".chatgpt.com",
      path: "/",
      expires: now + 31_536_000,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "oai-did",
      value: oaiDeviceId,
      domain: ".openai.com",
      path: "/",
      expires: now + 31_536_000,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    },
  ]);

  const page = (context.pages()[0]) || (await context.newPage());

  return {
    context,
    page,
    oaiDeviceId,
    fingerprint,
    chrome,
    userDataDir,
    proxyUrl: proxy || "",
    chainProxy: localChain || null,
    close: async () => {
      if (MANUAL_ASSIST) {
        // User muốn drive tay sau khi worker exit — Chromium survive (SIG* false).
        // Node process cần exit để server thấy child close + finalize job. Nếu
        // không exit, CDP WebSocket giữ event loop alive, server treo "finalizing".
        console.log("[manual-assist] Chromium giữ nguyên — worker exit để server finalize.");
        // Flush stdout/stderr trước khi exit
        if (process.stdout.write("")) process.stdout.end?.();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      await context.close().catch(() => {});
      if (localChain) {
        try { localChain.server.close(); } catch { /* best-effort */ }
      }
    },
  };
}

async function sweepStaleSingletonLocks(userDataDir) {
  const names = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  const twoMinAgo = Date.now() - 2 * 60 * 1000;
  for (const name of names) {
    const target = path.join(userDataDir, name);
    try {
      const stat = await fs.lstat(target);
      if (stat.ctimeMs < twoMinAgo) await fs.rm(target, { force: true, recursive: false });
    } catch {
      /* missing is fine */
    }
  }
}

async function proxyPreflight(session, args) {
  if (!session.proxyUrl) return;
  // Node-side preflight: không dùng page.goto vì CloakBrowser humanize layer
  // đôi khi nuốt CDP Fetch.continueWithAuth → Chromium báo
  // ERR_NO_SUPPORTED_PROXIES mơ hồ ngay cả khi proxy OK. Tự mở TCP CONNECT
  // (HTTP proxy) hoặc SOCKS5 handshake (SOCKS5 proxy), rồi gọi
  // https://api.ipify.org (ít block hơn httpbin) qua tunnel đó. Lỗi phân loại
  // rõ: 407 auth → BROWSER_PROXY_AUTH_FAILED, timeout → BROWSER_PROXY_TIMEOUT,
  // reset/connect → BROWSER_PROXY_UNREACHABLE.
  try {
    const seen = await probeExitIpThroughProxy(session.proxyUrl, { timeoutMs: 15_000 });
    if (!seen) throw new Error("empty response from ip probe");
    if (args.verbose) console.log(`[browser-proxy] exit-ip=${seen}`);
    else console.log(`[browser-proxy] exit-ip=${seen}`);
  } catch (error) {
    emit(WORKER_MARKERS.browserProxyAuthFailed);
    throw new Error(`BROWSER_PROXY_AUTH_FAILED: ${error.message}`);
  }
}

// Mở TCP tunnel qua proxy (HTTP CONNECT / SOCKS5) đến api.ipify.org:443,
// gửi 1 request HTTPS tối thiểu, parse response để lấy IP egress thật.
// Trả về string IP, hoặc throw error có mã rõ (AUTH_FAILED/TIMEOUT/UNREACHABLE).
async function probeExitIpThroughProxy(proxyUrl, { timeoutMs = 15_000 } = {}) {
  const parsed = typeof proxyUrl === "string" ? normalizeProxyUrl(proxyUrl) : proxyUrl;
  if (!parsed) throw new Error("INVALID_PROXY_URL");
  const target = { host: "api.ipify.org", port: 443, pathname: "/" };
  let socket;
  if (parsed.scheme === "http" || parsed.scheme === "https") {
    socket = await openHttpConnectTunnel(parsed, target, timeoutMs);
  } else if (parsed.scheme === "socks5" || parsed.scheme === "socks5h") {
    socket = await openSocks5Tunnel(parsed, target, timeoutMs);
  } else {
    throw new Error(`UNSUPPORTED_PROXY_SCHEME: ${parsed.scheme}`);
  }
  return await fetchOverTunnel(socket, target, timeoutMs);
}

function openHttpConnectTunnel(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = Number(proxy.port || (proxy.scheme === "https" ? 443 : 80));
    let timer;
    const bare = net.connect({ host: proxy.host, port }, () => {
      const credsHeader = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64")}\r\n`
        : "";
      const req = `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n`
        + `Host: ${target.host}:${target.port}\r\n`
        + credsHeader
        + "User-Agent: tosub2-preflight/1.0\r\n"
        + "Proxy-Connection: Keep-Alive\r\n\r\n";
      bare.write(req);
    });
    let buf = Buffer.alloc(0);
    timer = setTimeout(() => { try { bare.destroy(); } catch {} ; reject(new Error("PROXY_TIMEOUT")); }, timeoutMs);
    bare.on("error", (e) => { clearTimeout(timer); reject(new Error(`PROXY_UNREACHABLE: ${e.code || e.message}`)); });
    bare.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(Buffer.from("\r\n\r\n"));
      if (idx < 0) return;
      const headers = buf.slice(0, idx).toString("utf8");
      const firstLine = headers.split(/\r?\n/)[0];
      const status = Number(firstLine.split(/\s+/)[1] || 0);
      if (status === 200) {
        clearTimeout(timer);
        bare.removeAllListeners("data");
        bare.removeAllListeners("error");
        resolve(bare);
        return;
      }
      clearTimeout(timer);
      try { bare.destroy(); } catch {}
      if (status === 407) return reject(new Error(`PROXY_AUTH_REJECTED (HTTP 407, headers=${headers.slice(0, 200)})`));
      if (status === 403) return reject(new Error(`PROXY_FORBIDDEN (HTTP 403, headers=${headers.slice(0, 200)})`));
      return reject(new Error(`PROXY_CONNECT_FAILED: ${firstLine}`));
    });
  });
}

function openSocks5Tunnel(proxy, target, timeoutMs) {
  // SOCKS5 handshake (RFC 1928) + optional username/password (RFC 1929).
  return new Promise((resolve, reject) => {
    const port = Number(proxy.port || 1080);
    let timer = setTimeout(() => { try { bare.destroy(); } catch {} ; reject(new Error("SOCKS5_TIMEOUT")); }, timeoutMs);
    const hasAuth = Boolean(proxy.username);
    const bare = net.connect({ host: proxy.host, port }, () => {
      // Greeting: VER=5 NMETHODS=1-2 METHODS=[0x00, 0x02?]
      const methods = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      bare.write(methods);
    });
    let phase = "greet";
    let acc = Buffer.alloc(0);
    bare.on("error", (e) => { clearTimeout(timer); reject(new Error(`SOCKS5_UNREACHABLE: ${e.code || e.message}`)); });
    bare.on("data", (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      try {
        if (phase === "greet") {
          if (acc.length < 2) return;
          if (acc[0] !== 0x05) throw new Error("SOCKS5_BAD_VERSION");
          const method = acc[1];
          acc = acc.slice(2);
          if (method === 0xFF) throw new Error("SOCKS5_NO_ACCEPTABLE_METHOD");
          if (method === 0x02) {
            if (!hasAuth) throw new Error("SOCKS5_AUTH_REQUIRED_BUT_NO_CREDENTIALS");
            const u = Buffer.from(String(proxy.username || ""));
            const p = Buffer.from(String(proxy.password || ""));
            const authMsg = Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
            bare.write(authMsg);
            phase = "auth";
            return;
          }
          if (method === 0x00) {
            sendConnect(bare, target);
            phase = "connect";
            return;
          }
          throw new Error(`SOCKS5_UNEXPECTED_METHOD: 0x${method.toString(16)}`);
        }
        if (phase === "auth") {
          if (acc.length < 2) return;
          if (acc[1] !== 0x00) throw new Error("SOCKS5_AUTH_REJECTED");
          acc = acc.slice(2);
          sendConnect(bare, target);
          phase = "connect";
          return;
        }
        if (phase === "connect") {
          // Reply: VER REP RSV ATYP BND.ADDR BND.PORT (variable)
          if (acc.length < 10) return;
          if (acc[0] !== 0x05) throw new Error("SOCKS5_BAD_REPLY_VERSION");
          const rep = acc[1];
          if (rep !== 0x00) throw new Error(`SOCKS5_CONNECT_FAILED: rep=0x${rep.toString(16)}`);
          const atyp = acc[3];
          const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (acc[4] + 1) : null;
          if (!addrLen) throw new Error(`SOCKS5_BAD_ATYP: ${atyp}`);
          const totalLen = 4 + addrLen + 2;
          if (acc.length < totalLen) return;
          clearTimeout(timer);
          bare.removeAllListeners("data");
          bare.removeAllListeners("error");
          resolve(bare);
        }
      } catch (err) {
        clearTimeout(timer);
        try { bare.destroy(); } catch {}
        reject(err);
      }
    });
  });
  function sendConnect(sock, tgt) {
    const hostBuf = Buffer.from(tgt.host);
    const msg = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
      hostBuf,
      Buffer.from([(tgt.port >> 8) & 0xff, tgt.port & 0xff]),
    ]);
    sock.write(msg);
  }
}

async function fetchOverTunnel(socket, target, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { tlsSock.destroy(); } catch {} ; reject(new Error("TLS_REQ_TIMEOUT")); }, timeoutMs);
    const tlsSock = tls.connect({ socket, servername: target.host, ALPNProtocols: ["http/1.1"] }, () => {
      tlsSock.write(
        `GET ${target.pathname} HTTP/1.1\r\n`
        + `Host: ${target.host}\r\n`
        + "User-Agent: tosub2-preflight/1.0\r\n"
        + "Accept: text/plain\r\n"
        + "Connection: close\r\n\r\n",
      );
    });
    let body = "";
    tlsSock.on("error", (e) => { clearTimeout(timer); reject(new Error(`TLS_ERR: ${e.code || e.message}`)); });
    tlsSock.on("data", (c) => { body += c.toString("utf8"); });
    tlsSock.on("end", () => {
      clearTimeout(timer);
      const idx = body.indexOf("\r\n\r\n");
      const payload = idx > 0 ? body.slice(idx + 4).trim() : body.trim();
      // api.ipify.org trả raw IP; last chunk nếu chunked encoding.
      const match = payload.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-fA-F:]{3,}\b/);
      resolve(match ? match[0] : payload.slice(0, 40));
    });
  });
}

// Local no-auth HTTP proxy forwarder → upstream HTTP/SOCKS5 proxy with auth.
// Mục đích: Chromium (CloakBrowser) ↔ localhost:random (no auth) ↔ upstream
// proxy với Basic/SOCKS5 auth. Tránh CloakBrowser humanize layer nuốt CDP
// Fetch.continueWithAuth → root cause của ERR_NO_SUPPORTED_PROXIES khi upstream
// cần auth. Server listen 127.0.0.1 only, bind port=0 (OS pick), handle:
//   - CONNECT host:port → mở tunnel qua upstream, pipe hai socket.
//   - GET/POST http://remote → forward lên upstream (HTTP proxy relay cổ điển).
// Lifetime gắn với browser session: close khi context closed.
async function startLocalChainProxy(upstream) {
  if (!upstream) return null;
  const server = http.createServer();
  // Non-CONNECT HTTP: proxy GET/POST (plain HTTP sites). Chromium ChatGPT luôn
  // CONNECT (TLS), nhưng vẫn relay HTTP cho hoàn chỉnh (http://httpbin, OCSP, …).
  server.on("request", (req, res) => {
    try {
      const parsed = new URL(req.url);
      const upstreamSocket = net.connect({ host: upstream.host, port: Number(upstream.port) });
      upstreamSocket.on("error", () => { try { res.destroy(); } catch {} });
      upstreamSocket.on("connect", () => {
        const authHeader = upstream.username
          ? `Proxy-Authorization: Basic ${Buffer.from(`${upstream.username}:${upstream.password || ""}`).toString("base64")}\r\n`
          : "";
        const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [k, v] of Object.entries(req.headers)) {
          if (/^proxy-/i.test(k)) continue;
          headerLines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
        }
        upstreamSocket.write(headerLines.join("\r\n") + "\r\n" + authHeader + "\r\n");
        req.pipe(upstreamSocket, { end: false });
        upstreamSocket.pipe(res.socket);
      });
    } catch (e) {
      try { res.statusCode = 502; res.end("chain-proxy-error: " + e.message); } catch {}
    }
  });
  server.on("connect", async (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(":");
    const port = Number(portStr || 443);
    try {
      let upstreamSocket;
      if (upstream.scheme === "http" || upstream.scheme === "https") {
        upstreamSocket = await openHttpConnectTunnel(upstream, { host, port }, 30_000);
      } else if (upstream.scheme === "socks5" || upstream.scheme === "socks5h") {
        upstreamSocket = await openSocks5Tunnel(upstream, { host, port }, 30_000);
      } else {
        throw new Error(`UNSUPPORTED_UPSTREAM_SCHEME: ${upstream.scheme}`);
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.on("error", () => { try { clientSocket.destroy(); } catch {} });
      clientSocket.on("error", () => { try { upstreamSocket.destroy(); } catch {} });
      upstreamSocket.on("end", () => { try { clientSocket.end(); } catch {} });
      clientSocket.on("end", () => { try { upstreamSocket.end(); } catch {} });
    } catch (e) {
      try {
        const msg = String(e.message || e);
        const status = /AUTH/i.test(msg) ? "502 Proxy Auth Failed"
          : /TIMEOUT/i.test(msg) ? "504 Gateway Timeout"
          : "502 Bad Gateway";
        clientSocket.write(`HTTP/1.1 ${status}\r\nContent-Length: ${msg.length}\r\n\r\n${msg}`);
        clientSocket.destroy();
      } catch {}
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Unref so the chain server does NOT keep the event loop alive after signup
  // completes. Without this, Chromium's keep-alive socket to localhost giữ
  // server active → process không exit → worker không trả về → server treo
  // ở "finalizing" (code === 0 branch trong handleChildClose không chạy).
  try { server.unref(); } catch { /* best-effort */ }
  const addr = server.address();
  return { server, port: addr.port, host: "127.0.0.1", scheme: "http" };
}

async function findReachableSignupUrl(session) {
  // Skip probe tab: trước đây mở tab mới (context.newPage) để probe, nhưng
  // Chromium đôi khi không close kịp → user thấy 2 tab chatgpt mở cùng lúc
  // (default tab + probe tab). SIGNUP_URL_CANDIDATES[0] = chatgpt.com/ luôn
  // reachable qua proxy VN đã verify, không cần probe.
  // Đóng extra tabs mở lạc trong context (default blank tab, residual probe).
  try {
    const pages = session.context.pages();
    for (const p of pages) {
      if (p === session.page) continue;
      await p.close().catch(() => {});
    }
  } catch { /* best-effort */ }
  return SIGNUP_URL_CANDIDATES[0];
}

async function assertNotCloudflareStuck(session) {
  const title = (await session.page.title().catch(() => "")) || "";
  const url = session.page.url();
  if (/cloudflare|just a moment/i.test(title)) {
    try {
      await session.page.waitForFunction(() => !/cloudflare|just a moment/i.test(document.title), {
        timeout: 30_000,
      });
    } catch {
      emit(WORKER_MARKERS.browserCfInterstitialStuck);
      throw new Error(`BROWSER_CF_INTERSTITIAL_STUCK at ${url}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Codex OAuth with context.route interception
// ---------------------------------------------------------------------------

async function runCodexOauthInBrowser(session, { authBase, clientId, redirectUri, checkpointPath }) {
  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  const authUrl =
    `${authBase}/oauth/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      codex_cli_simplified_flow: "true",
      id_token_add_organizations: "true",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile email offline_access",
      state,
    }).toString();

  await saveCheckpoint(checkpointPath, { stage: "callback_ready", codeVerifier, state, oai_device_id: session.oaiDeviceId });
  emit(WORKER_MARKERS.codexOauthStart);

  // Intercept the loopback redirect at the browser layer — nothing listens on
  // :1455. The real Chromium's attempt to GET that URL fires here before any
  // network stack reaches the socket.
  let capturedUrl = null;
  const intercept = async (route) => {
    capturedUrl = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "ok",
    });
  };
  await session.context.route("**://localhost:1455/auth/callback*", intercept);
  await session.context.route("**://127.0.0.1:1455/auth/callback*", intercept);

  await session.page.goto(authUrl, { timeout: PAGE_IDLE_TIMEOUT_MS, waitUntil: "domcontentloaded" });

  // Wait for the callback: either the fulfilled route body loads ("ok") OR a
  // navigation to the callback URL completes. We also observe context requests
  // defensively in case the page defers.
  const start = Date.now();
  while (!capturedUrl && Date.now() - start < PAGE_IDLE_TIMEOUT_MS) {
    try {
      await session.context.waitForEvent("request", {
        predicate: (req) => /\/auth\/callback\?/.test(req.url()) && /localhost:1455|127\.0\.0\.1:1455/.test(req.url()),
        timeout: 5_000,
      });
    } catch {
      /* keep polling */
    }
    if (capturedUrl) break;
    const url = session.page.url();
    if (/localhost:1455|127\.0\.0\.1:1455/.test(url) && /\/auth\/callback\?/.test(url)) {
      capturedUrl = url;
      break;
    }
  }
  if (!capturedUrl) throw new Error("CODEX_CALLBACK_TIMEOUT: did not observe the Codex redirect within the window");

  return { codeVerifier, state, callbackUrl: capturedUrl };
}

// ---------------------------------------------------------------------------
// sub2api payload (mirror of protocol-login.mjs buildSub2apiOauthExport)
// ---------------------------------------------------------------------------

function buildSub2ApiPayload({ tokenSet, email, proxyUrl, clientId, accountName, concurrency, priority, rateMultiplier }) {
  const claims = decodeJwtPayload(tokenSet.id_token);
  const authClaims = claims["https://api.openai.com/auth"] || {};
  const resolvedEmail = claims.email || email || "";
  const chatgptAccountId = claims.sid || "";
  const chatgptUserId = authClaims.user_id || claims.sub || "";
  const account = {
    name: accountName || claims.name || resolvedEmail.split("@")[0] || "openai-account",
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: tokenSet.access_token,
      chatgpt_account_id: chatgptAccountId,
      email: resolvedEmail,
      id_token: tokenSet.id_token,
      refresh_token: tokenSet.refresh_token,
    },
    extra: {
      account_id: chatgptAccountId,
      chatgpt_account_id: chatgptAccountId,
      chatgpt_user_id: chatgptUserId,
      client_id: clientId,
      email: resolvedEmail,
      openai_long_context_billing_enabled: false,
      openai_oauth_responses_websockets_v2_enabled: false,
      openai_oauth_responses_websockets_v2_mode: "off",
      privacy_mode: "training_set_failed",
    },
    concurrency,
    priority,
    rate_multiplier: rateMultiplier,
    auto_pause_on_expired: true,
  };
  const registrationProxy = proxyUrlToSub2ApiProxy(proxyUrl);
  if (registrationProxy) account.proxy_key = registrationProxy.proxy_key;
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: registrationProxy ? [registrationProxy] : [],
    accounts: [account],
  };
}

function proxyUrlToSub2ApiProxy(raw) {
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return null;
  const key = `${normalized.scheme}://${normalized.host}:${normalized.port}`;
  // Sub2API /import endpoint yêu cầu field `protocol` (http/https/socks5/socks5h).
  // Giữ cả `type` legacy để không vỡ old consumers nếu còn ai parse theo tên cũ.
  const payload = {
    proxy_key: key,
    protocol: normalized.scheme,
    type: normalized.scheme,
    host: normalized.host,
    port: Number(normalized.port) || 0,
  };
  if (normalized.username) payload.username = normalized.username;
  if (normalized.password) payload.password = normalized.password;
  return payload;
}

function normalizeProxyUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(":", "");
  if (!["http", "https", "socks5", "socks5h"].includes(scheme)) return null;
  return {
    scheme,
    host: parsed.hostname,
    port: parsed.port || (scheme === "https" ? "443" : "80"),
    username: decodeURIComponent(parsed.username || ""),
    password: decodeURIComponent(parsed.password || ""),
  };
}

function decodeJwtPayload(token) {
  try {
    const segment = String(token || "").split(".")[1];
    if (!segment) return {};
    const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=").replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(padded, "base64");
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return {};
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

async function fillAndSubmit(page, inputSelector, value, submitSelector) {
  const locator = page.locator(inputSelector).first();
  await locator.waitFor({ state: "visible", timeout: PAGE_IDLE_TIMEOUT_MS });
  await locator.fill(String(value));
  if (submitSelector) {
    const btn = page.locator(submitSelector).first();
    await btn.click({ timeout: 10_000 }).catch(() => locator.press("Enter"));
  } else {
    await locator.press("Enter");
  }
}

async function promptForInput(markerKey, options = {}) {
  const marker = WORKER_MARKERS[markerKey];
  process.stdout.write(marker.marker);
  return readStdinLine(options);
}

function readStdinLine(options = {}) {
  const timeoutMs = Number(options.timeoutMs || INPUT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error("STDIN_TIMEOUT"));
    }, timeoutMs);
    rl.once("line", (line) => {
      clearTimeout(timer);
      rl.close();
      resolve(String(line).trim());
    });
    rl.once("close", () => {
      clearTimeout(timer);
    });
  });
}

// Chờ stdin HOẶC URL thay đổi (user drive DOM thủ công). Khi URL rời khỏi
// expectedUrlPattern, race winner là URL change → trả null; nếu stdin resolve
// trước, trả string input. Giúp loop không bị block vĩnh viễn khi URL moves on.
async function promptForInputOrPageAdvance(markerKey, page, expectedUrlRegex, options = {}) {
  const marker = WORKER_MARKERS[markerKey];
  process.stdout.write(marker.marker);
  const stdinPromise = readStdinLine({ timeoutMs: options.timeoutMs || 300_000 }).catch(() => null);
  const urlChangePromise = (async () => {
    const started = Date.now();
    const maxMs = Number(options.timeoutMs || 300_000);
    while (Date.now() - started < maxMs) {
      const url = page.url();
      if (!expectedUrlRegex.test(url)) return "URL_ADVANCED";
      await page.waitForTimeout(1000);
    }
    return null;
  })();
  const winner = await Promise.race([stdinPromise, urlChangePromise]);
  if (winner === "URL_ADVANCED") return null;
  return winner; // stdin value or null if nothing resolved
}

// --inspect-each pauses the worker after each DOM transition so the operator
// can read the real page via the open Chromium window and tell the next run
// what the actual selectors look like. Writes a per-stage DOM snapshot
// (visible inputs + buttons + current URL) to tmp/inspect-<stage>.json next to
// the sub2api output. Enable by passing --inspect-each on the CLI OR by
// setting env TOSUB2_BROWSER_INSPECT=1.
async function inspectPauseIfRequested(args, page, stageLabel) {
  const enabled = Boolean(args?.inspectEach) || process.env.TOSUB2_BROWSER_INSPECT === "1";
  if (!enabled) return;
  const snapshot = await captureDomSnapshot(page).catch((e) => ({ error: String(e?.message || e) }));
  const outDir = args?.sub2apiOut ? path.dirname(args.sub2apiOut) : path.join(process.cwd(), "tmp");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `inspect-${stageLabel}.json`);
  await fs.writeFile(outPath, `${JSON.stringify({ stage: stageLabel, at: new Date().toISOString(), ...snapshot }, null, 2)}\n`, "utf8");
  console.log(`[inspect] ${stageLabel}: snapshot ${outPath} — press Enter in stdin to continue`);
  await readStdinLine().catch(() => {});
}

async function captureDomSnapshot(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const dom = await page.evaluate(() => {
    const peek = (el) => ({
      tag: el.tagName?.toLowerCase() || null,
      type: el.getAttribute?.("type") || null,
      name: el.getAttribute?.("name") || null,
      id: el.id || null,
      autocomplete: el.getAttribute?.("autocomplete") || null,
      placeholder: el.getAttribute?.("placeholder") || null,
      ariaLabel: el.getAttribute?.("aria-label") || null,
      role: el.getAttribute?.("role") || null,
      testid: el.getAttribute?.("data-testid") || null,
      text: ((el.innerText || el.value || "") + "").slice(0, 120).trim(),
      visible: !!(el.offsetParent || el.getClientRects().length),
    });
    return {
      inputs: Array.from(document.querySelectorAll("input, textarea, select")).map(peek),
      buttons: Array.from(document.querySelectorAll('button, [role="button"]')).map(peek),
      headings: Array.from(document.querySelectorAll("h1, h2, h3")).map((h) => (h.innerText || "").trim()).filter(Boolean),
      iframes: Array.from(document.querySelectorAll("iframe")).map((f) => ({ src: f.src, name: f.name, id: f.id })),
      bodyPrefix: (document.body?.innerText || "").slice(0, 300),
    };
  });
  return { url, title, dom };
}

async function waitForModalEmailInput(page) {
  // chatgpt.com không auto-show modal. Thứ tự thật:
  //   1. Trang load → có thể có cookie banner cản dưới cùng → đóng.
  //   2. Click "Sign up for free" hoặc "Log in" ở header → modal bật.
  //   3. Chờ email input hiện.
  //
  // Step 1 + 2 best-effort — nếu banner/button không có, chuyển bước. Step 3 là
  // hard requirement.
  await dismissCookieBannerIfVisible(page);
  await openSignupModalIfNeeded(page);

  const emailSelector = SELECTORS.emailInput.join(", ");
  try {
    await page.locator(emailSelector).first().waitFor({ state: "visible", timeout: PAGE_IDLE_TIMEOUT_MS });
  } catch (error) {
    // On miss, dump an evidence snapshot so operator sees what Chromium actually
    // got (Cloudflare interstitial? "Just a moment"? wrong URL?). Written to
    // tmp/ next to the sub2api output.
    try {
      const dumpDir = path.join(process.cwd(), "tmp", "browser-login-failures");
      await fs.mkdir(dumpDir, { recursive: true });
      const stamp = String(Date.now());
      const htmlPath = path.join(dumpDir, `modal-miss-${stamp}.html`);
      const metaPath = path.join(dumpDir, `modal-miss-${stamp}.json`);
      const pngPath = path.join(dumpDir, `modal-miss-${stamp}.png`);
      const html = await page.content().catch(() => "<unavailable>");
      await fs.writeFile(htmlPath, html, "utf8");
      const url = page.url();
      const title = await page.title().catch(() => "");
      await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
      const dom = await captureDomSnapshot(page).catch((e) => ({ error: String(e?.message || e) }));
      await fs.writeFile(metaPath, `${JSON.stringify({ url, title, dom, originalError: String(error?.message || error) }, null, 2)}\n`, "utf8");
      console.error(`[error] MODAL_NOT_FOUND url=${url} title=${JSON.stringify(title)} dump=${metaPath}`);
    } catch (dumpErr) {
      console.error(`[error] MODAL_NOT_FOUND (dump failed: ${dumpErr?.message || dumpErr})`);
    }
    throw error;
  }
}

// Click 1 option trong onboarding survey. Return text đã click hoặc null.
async function clickOneOnboardingOption(session) {
  const PREFERRED_SRC = "^(để sau|tạm bỏ qua|later|not now|khác|other|something else|cá nhân|personal|skip|bỏ qua|maybe later)$";
  const target = await session.page.evaluate((preferredSrc) => {
    const PREFERRED_RE = new RegExp(preferredSrc, "i");
    const main = document.querySelector('main') || document.body;
    const nodes = [...main.querySelectorAll('button, [role="button"], [role="radio"], label, div[tabindex], a[role="button"], a[href^="#"], a:not([href^="http"]):not([href=""])')];
    const options = [];
    for (const n of nodes) {
      const txt = (n.innerText || "").trim();
      if (!txt || txt.length > 80) continue;
      const rect = n.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 24) continue;
      if (n.closest('nav, aside, header')) continue;
      options.push(txt);
    }
    if (!options.length) return null;
    return options.find((t) => PREFERRED_RE.test(t)) || options[0];
  }, PREFERRED_SRC).catch(() => null);

  if (!target) return null;
  console.log(`[onboarding] target option: "${target}"`);

  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp("^" + esc + "$", "i");
  const candidates = [
    () => session.page.locator('main').getByRole("button", { name: regex }).first(),
    () => session.page.locator('main').getByRole("radio", { name: regex }).first(),
    () => session.page.locator('main').getByRole("link", { name: regex }).first(),
    () => session.page.locator('main').getByText(regex, { exact: true }).first(),
    () => session.page.locator('main button:visible, main [role="button"]:visible, main [role="radio"]:visible, main label:visible, main a:visible').filter({ hasText: regex }).first(),
  ];
  for (const build of candidates) {
    try {
      const el = build();
      if (!await el.isVisible({ timeout: 1200 }).catch(() => false)) continue;
      await el.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => {});
      await el.click({ timeout: 3000, force: true });
      console.log(`[onboarding] clicked "${target}" via locator`);
      return target;
    } catch { /* next */ }
  }
  // JS fallback
  await session.page.evaluate((txt) => {
    const re = new RegExp("^" + txt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
    const main = document.querySelector('main') || document.body;
    const nodes = [...main.querySelectorAll('button, [role="button"], [role="radio"], label, div[tabindex], a')];
    for (const n of nodes) {
      if (re.test((n.innerText || "").trim())) {
        const rect = n.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) => {
          try { n.dispatchEvent(new PointerEvent(t, opts)); } catch { n.dispatchEvent(new MouseEvent(t, opts)); }
        });
        n.click();
        return true;
      }
    }
    return false;
  }, target).catch(() => {});
  console.log(`[onboarding] clicked "${target}" via JS fallback`);
  return target;
}

async function dismissCookieBannerIfVisible(page) {
  // Try reject-first (privacy), fallback accept. Short 3s window — if no banner
  // in 3s, assume there isn't one and move on.
  for (const sel of [...SELECTORS.cookieRejectButton, ...SELECTORS.cookieAcceptButton]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await btn.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      /* keep trying */
    }
  }
}

async function openSignupModalIfNeeded(page) {
  // Nếu email input đã hiện (modal auto-visible trên một variant A/B nào đó),
  // không cần click gì. Nếu không, thử click một trong các nút trigger modal.
  const emailSelector = SELECTORS.emailInput.join(", ");
  if (await page.locator(emailSelector).first().isVisible({ timeout: 2_000 }).catch(() => false)) {
    return;
  }
  const openSelector = SELECTORS.openModalButton.join(", ");
  try {
    const trigger = page.locator(openSelector).first();
    await trigger.waitFor({ state: "visible", timeout: 15_000 });
    await trigger.click({ timeout: 5_000 });
    // Chờ 1 nhịp cho modal animate xong trước khi caller waitFor email input.
    await page.waitForTimeout(800);
  } catch {
    /* nếu không tìm thấy trigger thì để caller tự fail với dump — có thể là CF
     * interstitial / trang trắng */
  }
}

async function assertNotAccidentallyOnOauth(page) {
  // Belt-and-braces: if the page's URL is already on google/apple/phone OAuth,
  // something upstream clicked a wrong button — refuse to proceed.
  const url = page.url();
  if (/accounts\.google\.com|appleid\.apple\.com|phone-provider/.test(url)) {
    throw new Error(`WRONG_OAUTH_DESTINATION: landed on ${url} instead of the chatgpt.com modal`);
  }
}

async function maybeWaitForPhonePage(session) {
  try {
    await session.page.waitForURL(/add-phone|phone/, { timeout: 15_000 });
    return session.page.url();
  } catch {
    return null;
  }
}

async function saveCheckpoint(filePath, data) {
  if (!filePath) return;
  // Merge với checkpoint cũ (nếu có) để không mất PKCE verifier/state khi stage
  // update sau. Previous bug: overwrite xóa codeVerifier → không recover được
  // OAuth exchange.
  let existing = {};
  try {
    const txt = await fs.readFile(filePath, "utf8");
    existing = JSON.parse(txt);
  } catch { /* file missing OK */ }
  const payload = { ...existing, ...data, saved_at: new Date().toISOString() };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonAtomic(filePath, payload);
}

async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

// Password hợp lệ cho OpenAI create-account (≥12 chars, upper + lower + digit
// + symbol). Deterministic theo oaiDeviceId; worker không persist password
// riêng (OpenAI chấp nhận email-OTP login sau khi create xong, nên password
// chỉ dùng 1 lần qua trang /create-account/password). Guarantees: 1 upper
// + 1 lower + 1 digit + 1 symbol + 12 base64url chars = 16 chars total.
function generatePasswordForAccount(seedKey) {
  const h = crypto.createHash("sha256").update(String(seedKey || "")).digest();
  const b64 = Buffer.from(h).toString("base64url").slice(0, 12);
  const upper = String.fromCharCode(65 + (h[12] % 26)); // A..Z
  const lower = String.fromCharCode(97 + (h[13] % 26)); // a..z
  const digit = String(h[14] % 10); // 0..9
  const symbols = "!@#$%^&*";
  const symbol = symbols[h[15] % symbols.length];
  return `${upper}${lower}${digit}${symbol}${b64}`;
}

function generateInlineProfile(seedKey) {
  const pool = ["Nguyễn An", "Trần Linh", "Lê Minh", "Phạm Thảo", "Hoàng Quân", "Vũ Hà", "Đặng Nhi", "Bùi Tâm"];
  // Deterministic nếu có seedKey (vd oaiDeviceId) → cùng account luôn generate
  // CÙNG name/age. Tránh PROFILE handler re-run tạo random khác mỗi tick khiến
  // OpenAI thấy "name A → B → C" trong cùng form, loop vô tận.
  if (seedKey) {
    const h = crypto.createHash("sha256").update(String(seedKey)).digest();
    const name = pool[h[0] % pool.length];
    const age = 25 + (h[1] % 16); // 25..40
    const year = 2026 - age;
    const month = 1 + (h[2] % 12);
    const day = 1 + (h[3] % 28);
    const birthdate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { name, birthdate };
  }
  // Fallback random cho call không có seed (vd probe mode)
  const name = pool[crypto.randomInt(pool.length)];
  const age = 25 + crypto.randomInt(16);
  const year = 2026 - age;
  const month = 1 + crypto.randomInt(12);
  const day = 1 + crypto.randomInt(28);
  const birthdate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { name, birthdate };
}

// Map any thrown error to a single-line descriptor compatible with
// console-server's error scan.
function classifyAndFormatError(error) {
  const msg = String(error?.message || error || "unknown");
  const first = msg.split("\n")[0].trim();
  return first;
}

// ---------------------------------------------------------------------------
// Argument parsing — a subset of protocol-login.mjs, with the probe + browser
// specifics bolted on.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const takeValue = (flag) => {
      const eq = `--${flag}=`;
      if (item.startsWith(eq)) return item.slice(eq.length);
      if (item === `--${flag}`) {
        const next = argv[i + 1];
        i += 1;
        return next;
      }
      return undefined;
    };

    if (item === "--help" || item === "-h") {
      args.help = true;
      continue;
    }
    if (item === "--verbose" || item === "-v") {
      args.verbose = true;
      continue;
    }
    if (item === "--probe") {
      args.probe = true;
      continue;
    }
    if (item === "--inspect-each") {
      args.inspectEach = true;
      continue;
    }
    if (item === "--allow-direct-ip") {
      // Opt-out of the "signup requires a proxy" guard. Only use for probe mode
      // (--probe) or offline dev — never for real OpenAI signup.
      args.allowDirectIp = true;
      continue;
    }
    if (item === "--hold-open") {
      // Probe mode only: giữ Chromium alive sau khi dump report xong để
      // operator inspect fingerprint thủ công. Tương đương TOSUB2_BROWSER_MANUAL=1.
      args.holdOpen = true;
      continue;
    }
    if (item === "--legacy") {
      // Dùng flow linear fillAndSubmit cũ thay vì adaptive state-machine.
      args.legacy = true;
      continue;
    }
    if (item === "--adaptive") {
      // Hiển minh adaptive — mặc định đã bật, cờ này chỉ để rõ intent.
      args.adaptive = true;
      continue;
    }
    if (item === "--setup-totp") {
      args.setupTotp = true;
      continue;
    }
    if (item === "--add-password") {
      args.addPassword = true;
      continue;
    }
    const emailVal = takeValue("email");
    if (emailVal !== undefined) {
      args.email = emailVal;
      continue;
    }
    const outVal = takeValue("out");
    if (outVal !== undefined) {
      args.out = outVal;
      continue;
    }
    const sub2apiOutVal = takeValue("sub2api-out");
    if (sub2apiOutVal !== undefined) {
      args.sub2apiOut = sub2apiOutVal;
      continue;
    }
    const outputModeVal = takeValue("output-mode");
    if (outputModeVal !== undefined) {
      args.outputMode = outputModeVal;
      continue;
    }
    const refreshVal = takeValue("refresh-sub2api");
    if (refreshVal !== undefined) {
      args.refreshSub2api = refreshVal;
      continue;
    }
    const checkpointVal = takeValue("checkpoint");
    if (checkpointVal !== undefined) {
      args.checkpoint = checkpointVal;
      continue;
    }
    const resumeVal = takeValue("resume-checkpoint");
    if (resumeVal !== undefined) {
      args.resumeCheckpoint = resumeVal;
      continue;
    }
    const sub2apiNameVal = takeValue("sub2api-name");
    if (sub2apiNameVal !== undefined) {
      args.sub2apiName = sub2apiNameVal;
      continue;
    }
    const concurrencyVal = takeValue("concurrency");
    if (concurrencyVal !== undefined) {
      args.concurrency = concurrencyVal;
      continue;
    }
    const priorityVal = takeValue("priority");
    if (priorityVal !== undefined) {
      args.priority = priorityVal;
      continue;
    }
    const rateVal = takeValue("rate-multiplier");
    if (rateVal !== undefined) {
      args.rateMultiplier = rateVal;
      continue;
    }
    const proxyVal = takeValue("proxy");
    if (proxyVal !== undefined) {
      args.proxy = proxyVal;
      continue;
    }
    const probeUrlVal = takeValue("probe-url");
    if (probeUrlVal !== undefined) {
      args.probeUrl = probeUrlVal;
      continue;
    }
    const authBaseVal = takeValue("auth-base");
    if (authBaseVal !== undefined) {
      args.authBase = authBaseVal;
      continue;
    }
    const chatgptBaseVal = takeValue("chatgpt-base");
    if (chatgptBaseVal !== undefined) {
      args.chatgptBase = chatgptBaseVal;
      continue;
    }
    const codexClientIdVal = takeValue("codex-client-id");
    if (codexClientIdVal !== undefined) {
      args.codexClientId = codexClientIdVal;
      continue;
    }
    const codexRedirectUriVal = takeValue("codex-redirect-uri");
    if (codexRedirectUriVal !== undefined) {
      args.codexRedirectUri = codexRedirectUriVal;
      continue;
    }
    const totpResultVal = takeValue("totp-result");
    if (totpResultVal !== undefined) {
      args.totpResult = totpResultVal;
      continue;
    }
    const passwordAddResultVal = takeValue("password-add-result");
    if (passwordAddResultVal !== undefined) {
      args.passwordAddResult = passwordAddResultVal;
      continue;
    }
    if (item === "--tls-profile" || item.startsWith("--tls-profile=") || item === "--native-http") {
      // Accepted silently for CLI parity with protocol-login.
      if (item === "--tls-profile") i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: browser-login.mjs [options]

Modes:
  --probe                  Launch Chromium with per-account fingerprint, visit a probe URL,
                           write a JSON report, and exit (no OpenAI traffic).
  --refresh-sub2api PATH   Refresh an existing sub2api-import-oauth.json via HTTPS (no browser).
  (default)                Full signup flow driven through a real Chromium.

Options (subset mirrors protocol-login.mjs):
  --email EMAIL
  --output-mode sub2api
  --sub2api-out PATH
  --checkpoint PATH
  --resume-checkpoint PATH
  --sub2api-name NAME
  --concurrency N / --priority N / --rate-multiplier N
  --proxy URL              Overrides CHATGPT_PROXY_URL env.
  --auth-base URL / --chatgpt-base URL / --codex-client-id ID / --codex-redirect-uri URL
  --probe-url URL          Custom probe target (default: https://httpbin.org/anything/...)
  --verbose
`);
}

// ---------------------------------------------------------------------------
// Programmatic entry — unit tests import this file without triggering run().
// ---------------------------------------------------------------------------

function isDirectCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryUrl = pathToFileURL(entry).href;
    return entryUrl === import.meta.url || fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isDirectCliEntry()) {
  run().catch((error) => {
    console.error(`[error] ${classifyAndFormatError(error)}`);
    process.exit(1);
  });
}

export {
  parseArgs,
  buildSub2ApiPayload,
  normalizeProxyUrl,
  proxyUrlToSub2ApiProxy,
  decodeJwtPayload,
  SELECTORS,
  RUN_MODES,
};
