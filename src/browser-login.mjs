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
  // The refresh flow is pure HTTPS token exchange — no DOM, no browser needed.
  // We re-use the existing TLS-path implementation.
  const { refreshSub2apiOauthExport, DEFAULT_CODEX_CLIENT_ID: FALLBACK_CLIENT_ID } = await import("./protocol-login.mjs");
  if (!refreshSub2apiOauthExport) {
    throw new Error("REFRESH_HELPER_MISSING: protocol-login.mjs did not export refreshSub2apiOauthExport");
  }
  await refreshSub2apiOauthExport({
    authBase: args.authBase || DEFAULT_AUTH_BASE,
    sourcePath: args.refreshSub2api,
    targetPath: args.sub2apiOut || args.refreshSub2api,
    fallbackClientId: FALLBACK_CLIENT_ID || DEFAULT_CODEX_CLIENT_ID,
    transport: null,
  });
  emit(WORKER_MARKERS.savedSub2api, args.sub2apiOut || args.refreshSub2api);
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
    await inspectPauseIfRequested(args, session.page, "after-email-submit");

    // 2. Email OTP — ask console-server, type into DOM, submit.
    const emailOtp = await promptForInput("emailOtpPrompt");
    emit(WORKER_MARKERS.checkpointSavedEmail);
    await fillAndSubmit(session.page, selectorFor("emailOtpInput"), emailOtp, selectorFor("continueButton"));
    await saveCheckpoint(checkpointPath, { stage: "email_verified", oai_device_id: session.oaiDeviceId });
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
    const profile = generateInlineProfile();
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
    await session.close();
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
  LOGIN_EMAIL: "login-email",
  SIGNUP_EMAIL: "signup-email",
  EMAIL_OTP: "email-otp",
  PASSWORD: "password",
  PROFILE: "profile",
  PHONE_NUMBER: "phone-number",
  PHONE_OTP: "phone-otp",
  OAUTH_CONSENT: "oauth-consent",
  WORKSPACE_SELECT: "workspace-select",
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
  if (/\/choose-an-account|\/workspace\/select|choose an account|chọn tài khoản|workspace/.test(corpus)) return PAGE_KINDS.WORKSPACE_SELECT;
  // URL-first precedence cho các page có path cụ thể — tránh substring collision
  // với landing/signup corpus check.
  if (/\/create-account\/password|\/log-in\/password|\/account\/password/.test(url)) return PAGE_KINDS.PASSWORD;
  if (/\/email-verification/.test(url)) return PAGE_KINDS.EMAIL_OTP;
  if (/\/about-you/.test(url)) return PAGE_KINDS.PROFILE;
  if (/\/add-phone|\/phone-number|\/phone-verification/.test(url)) {
    if (/code|mã|otp|verification/.test(corpus) && /\d{4,}/.test(bodyPrefix)) return PAGE_KINDS.PHONE_OTP;
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
  if (/^https?:\/\/chatgpt\.com\/?(\?|$)/.test(url)) return PAGE_KINDS.LANDING;
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
    // Prefer Sign up for signup flow; both open the same modal.
    const texts = ["Sign up for free", "Đăng ký miễn phí", "Sign up", "Đăng ký", "Log in", "Đăng nhập"];
    for (const text of texts) {
      // Thử getByText (strict), rồi role button/link, rồi CSS fallback.
      const tries = [
        () => session.page.getByText(text, { exact: true }).first(),
        () => session.page.getByRole("button", { name: new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }).first(),
        () => session.page.getByRole("link", { name: new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }).first(),
        () => session.page.locator(`a:has-text("${text}"), button:has-text("${text}")`).first(),
      ];
      for (const build of tries) {
        try {
          const el = build();
          if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
            await el.click({ timeout: 5000 });
            return;
          }
        } catch { /* next */ }
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
  async [PAGE_KINDS.SIGNUP_EMAIL](session, args) {
    await dismissCookieBannerIfVisible(session.page);
    const input = session.page.getByLabel(/email|địa chỉ email/i).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(args.email);
    await clickFormSubmit(session.page);
  },
  async [PAGE_KINDS.EMAIL_OTP](session) {
    emit(WORKER_MARKERS.emailOtpPageReached);
    const otp = await promptForInput("emailOtpPrompt");
    emit(WORKER_MARKERS.checkpointSavedEmail);
    const input = session.page.getByLabel(/mã|code|verification|otp/i).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(otp);
    await clickFormSubmit(session.page);
  },
  async [PAGE_KINDS.PASSWORD](session) {
    const pwd = process.env.CHATGPT_NEW_PASSWORD || process.env.CHATGPT_LOGIN_PASSWORD || "";
    if (!pwd) throw new Error("MISSING_PASSWORD");
    const input = session.page.getByLabel(/mật khẩu|password/i).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(pwd);
    await clickFormSubmit(session.page);
  },
  async [PAGE_KINDS.PROFILE](session) {
    emit(WORKER_MARKERS.sentinelProfilePrepare);
    const profile = generateInlineProfile(); // {name, birthdate:"YYYY-MM-DD"}
    const nameInput = session.page.getByLabel(/họ và tên|full name|name|tên/i).first();
    if (await nameInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await nameInput.fill(profile.name);
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
    const mmddyyyy = `${String(bMonth).padStart(2, "0")}${String(bDay).padStart(2, "0")}${bYear}`;
    const ageInput = session.page.getByLabel(/họ sinh|birthday|birthdate|birth|date of birth|ngày sinh|tuổi|age/i).first();
    if (await ageInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const inputType = await ageInput.getAttribute("type").catch(() => null);
      const label = (await ageInput.getAttribute("aria-label").catch(() => "")) || "";
      const placeholder = (await ageInput.getAttribute("placeholder").catch(() => "")) || "";
      const descriptor = (label + " " + placeholder).toLowerCase();
      const isBirthday = /birth|sinh|birthday|birthdate|mm|dd|yyyy/.test(descriptor) || /\/|-/.test(placeholder);
      if (inputType === "date") {
        await ageInput.fill(profile.birthdate);
      } else if (isBirthday) {
        // Type từng digit để browser mask MM/DD/YYYY chèn / tự
        await ageInput.click({ timeout: 3000 }).catch(() => {});
        await ageInput.press("End").catch(() => {});
        await ageInput.press("Backspace").catch(() => {}); // clear residual
        await session.page.keyboard.type(mmddyyyy, { delay: 40 });
      } else {
        // Age field (number): fill tuổi hiện tại
        const age = Math.max(18, 2026 - bYear);
        await ageInput.fill(String(age));
      }
    }
    const ageConsent = session.page.getByRole("checkbox", { name: /18|older|age|consent|agree/i }).first();
    if (await ageConsent.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ageConsent.check({ timeout: 3000 }).catch(() => {});
    }
    await clickFormSubmit(session.page);
    emit(WORKER_MARKERS.profileCompleted);
  },
  async [PAGE_KINDS.PHONE_NUMBER](session) {
    process.stdout.write(WORKER_MARKERS.phoneNumberPrompt.marker);
    const phone = await readStdinLine();
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
    const input = session.page.getByRole("textbox", { name: /phone|số điện thoại/i }).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    // Clear current (có thể có +1 default)
    await input.click({ timeout: 2000 }).catch(() => {});
    await input.press("End").catch(() => {});
    for (let i = 0; i < 20; i += 1) await input.press("Backspace").catch(() => {});
    await input.type(subscriberNumber, { delay: 40 });
    await clickFormSubmit(session.page);
  },
  async [PAGE_KINDS.PHONE_OTP](session) {
    process.stdout.write(WORKER_MARKERS.phoneOtpPrompt.marker);
    const otp = await readStdinLine();
    const input = session.page.getByLabel(/mã|code|otp|verification/i).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(otp);
    await clickFormSubmit(session.page);
    emit(WORKER_MARKERS.phoneOtpValidated);
  },
  async [PAGE_KINDS.OAUTH_CONSENT](session) {
    emit(WORKER_MARKERS.codexOauthStart);
    // Consent page sometimes has an explicit "Authorize"/"Allow"/"Cho phép"
    // button; sometimes it auto-redirects. Try to click, ignore if not there.
    for (const name of [AUTHORIZE_NAME, CONTINUE_NAME]) {
      try {
        const btn = roleButton(session.page, name);
        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await btn.click({ timeout: 5000 });
          return;
        }
      } catch { /* next */ }
    }
  },
  async [PAGE_KINDS.WORKSPACE_SELECT](session, args) {
    // "Welcome back / Choose an account" page — click the account card có email của mình.
    // Thứ tự thử:
    //   1. Click ancestor của text email (card chứa email)
    //   2. getByRole radio first (một số layout dùng radio)
    //   3. Button có text email
    try {
      const emailLocator = session.page.getByText(args.email, { exact: false }).first();
      if (await emailLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Click ancestor div với role=button/link nếu có, else click element trực tiếp
        const clickable = emailLocator.locator('xpath=ancestor-or-self::*[@role="button" or @role="link" or self::button or self::a][1]').first();
        if (await clickable.isVisible({ timeout: 1000 }).catch(() => false)) {
          await clickable.click({ timeout: 5000 });
          return;
        }
        await emailLocator.click({ timeout: 5000 }).catch(() => {});
        return;
      }
    } catch { /* fallthrough */ }
    try {
      const radio = session.page.getByRole("radio").first();
      if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
        await radio.check({ timeout: 3000 }).catch(() => {});
        await clickFormSubmit(session.page);
        return;
      }
    } catch { /* next */ }
    // Last resort: scan for buttons containing email
    try {
      const btn = session.page.locator("button, [role='button'], a", { hasText: args.email }).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ timeout: 3000 });
      }
    } catch { /* nothing more we can do */ }
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

    const startedAt = Date.now();
    let lastKind = null;
    let sameKindCount = 0;
    let navigatedToOauth = false;
    while (Date.now() - startedAt < PAGE_IDLE_TIMEOUT_MS) {
      if (oauth.capturedUrl) break;
      const kind = await detectPageKind(session.page);
      if (kind === PAGE_KINDS.DONE) break;
      if (kind === PAGE_KINDS.WRONG_OAUTH) throw new Error(`WRONG_OAUTH_DESTINATION: ${session.page.url()}`);

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
    await session.close();
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

  const launchArgs = [
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,InterestFeedContentSuggestions,PasswordLeakDetection,CalculateNativeWinOcclusion,HeavyAdPrivacyMitigations,HttpsUpgrades,InsecureFormSubmissionWarning,InsecurePasswordRedaction,BackForwardCache,DisableLoadExtensionCommandLineSwitch",
    "--disk-cache-size=52428800",
  ];
  const launchOptions = {
    headless: false,
    args: launchArgs,
    ignoreDefaultArgs: ["--enable-automation"],
    // Manual-assist: giữ Chromium alive khi worker exit (user tiếp tục drive tay).
    ...(MANUAL_ASSIST ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
  };
  if (proxyUrl) {
    launchOptions.proxy = {
      server: `${proxyUrl.scheme}://${proxyUrl.host}:${proxyUrl.port}`,
      ...(proxyUrl.username ? { username: proxyUrl.username, password: proxyUrl.password || "" } : {}),
    };
  }

  let context;
  if (engine === "cloak") {
    // CloakBrowser — proxy string form, humanize=true, geoip=true cho timezone/locale auto.
    const cb = await import("cloakbrowser");
    const proxyString = proxyUrl
      ? (proxyUrl.username
          ? `${proxyUrl.scheme}://${encodeURIComponent(proxyUrl.username)}:${encodeURIComponent(proxyUrl.password || "")}@${proxyUrl.host}:${proxyUrl.port}`
          : `${proxyUrl.scheme}://${proxyUrl.host}:${proxyUrl.port}`)
      : undefined;
    if (verbose) console.log(`[browser] launching CloakBrowser (version=${cb.CHROMIUM_VERSION}) proxy=${proxyString ? "set" : "none"}`);
    const cbInfo = cb.binaryInfo();
    const cbOpts = {
      userDataDir,
      headless: false,
      humanize: true,
      // geoip:true cần mmdb-lib + .mmdb file (MaxMind GeoLite2). Bật qua
      // env TOSUB2_CLOAK_GEOIP=1 nếu đã nạp DB. Mặc định false để tránh crash.
      geoip: process.env.TOSUB2_CLOAK_GEOIP === "1" && Boolean(proxyString),
      args: launchArgs,
      ...(proxyString ? { proxy: proxyString } : {}),
      ...(MANUAL_ASSIST ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
    };
    context = await cb.launchPersistentContext(cbOpts);
    // Overwrite "chrome" return field for the report so caller sees cloak version.
    chrome.bin = cbInfo.binaryPath || chrome.bin;
    chrome.major = Number(String(cb.CHROMIUM_VERSION || "").split(".")[0]) || chrome.major;
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
  const page = await session.context.newPage();
  try {
    await page.goto("https://httpbin.org/ip", { timeout: 15_000, waitUntil: "domcontentloaded" });
    const body = await page.evaluate(() => document.body?.innerText || "");
    const match = body.match(/"origin"\s*:\s*"([^"]+)"/);
    const seen = match ? match[1].split(",")[0].trim() : null;
    if (!seen) {
      emit(WORKER_MARKERS.browserProxyAuthFailed);
      throw new Error("BROWSER_PROXY_AUTH_FAILED: httpbin probe did not report an origin IP");
    }
    if (args.verbose) console.log(`[browser-proxy] httpbin origin=${seen}`);
  } catch (error) {
    emit(WORKER_MARKERS.browserProxyAuthFailed);
    throw new Error(`BROWSER_PROXY_AUTH_FAILED: ${error.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function findReachableSignupUrl(session) {
  const page = await session.context.newPage();
  try {
    for (const url of SIGNUP_URL_CANDIDATES) {
      try {
        const res = await page.goto(url, { timeout: 15_000, waitUntil: "domcontentloaded" });
        if (res && res.status() < 400) return url;
      } catch {
        /* try next */
      }
    }
    return SIGNUP_URL_CANDIDATES[0];
  } finally {
    await page.close().catch(() => {});
  }
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
  const payload = {
    proxy_key: key,
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

async function promptForInput(markerKey) {
  const marker = WORKER_MARKERS[markerKey];
  process.stdout.write(marker.marker);
  return readStdinLine();
}

function readStdinLine() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error("STDIN_TIMEOUT"));
    }, INPUT_TIMEOUT_MS);
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

function generateInlineProfile() {
  const pool = ["Nguyễn An", "Trần Linh", "Lê Minh", "Phạm Thảo", "Hoàng Quân", "Vũ Hà", "Đặng Nhi", "Bùi Tâm"];
  const name = pool[crypto.randomInt(pool.length)];
  // Birthdate: 1980-01-01 through 2003-12-31 (ensures 21+ as of 2026).
  const year = 1980 + crypto.randomInt(24);
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
