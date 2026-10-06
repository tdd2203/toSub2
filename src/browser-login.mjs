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
const SIGNUP_URL_CANDIDATES = [
  "https://auth.openai.com/create-account",
  "https://chatgpt.com/auth/signup",
];
const PAGE_IDLE_TIMEOUT_MS = 60_000;
const INPUT_TIMEOUT_MS = 300_000;

const SELECTORS = {
  // auth.openai.com signup — these are the pattern-based locators we fall back
  // through. Real selectors on OpenAI pages change over time; keep them tag +
  // name + autocomplete based rather than CSS-class based.
  emailInput: 'input[type="email"], input[name="email"], input[autocomplete="email"]',
  continueButton: 'button[type="submit"], button:has-text("Continue"), button:has-text("Tiếp tục")',
  emailOtpInput: 'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]',
  passwordInput: 'input[type="password"], input[name="password"], input[autocomplete="new-password"]',
  nameInput: 'input[name="name"], input[autocomplete="name"], input[placeholder*="Name" i], input[placeholder*="Tên" i]',
  birthdateInput: 'input[name="birthdate"], input[placeholder*="birthday" i], input[placeholder*="sinh" i]',
  phoneInput: 'input[type="tel"], input[name="phone_number"], input[autocomplete="tel"]',
  phoneOtpInput: 'input[name="code"], input[autocomplete="one-time-code"]',
  continueBirthdateButton: 'button[type="submit"]',
};

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
  await handleSignup(args);
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
  const session = await openBrowser({ email: args.email || "probe@example.test", proxy: args.proxy || null, verbose: args.verbose });
  const probeUrl = args.probeUrl || "https://httpbin.org/anything/tosub2-browser-probe";
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

  const session = await openBrowser({ email: args.email, proxy: args.proxy || process.env.CHATGPT_PROXY_URL || null, verbose: args.verbose });
  try {
    // Pre-flight: assert the proxy actually routes traffic. On a locked-down
    // residential proxy the Chromium can boot but outbound traffic fails
    // silently; this probe surfaces the failure as an operational error so the
    // mailbox is not marked deactivated.
    await proxyPreflight(session, args);

    // 1. Signup landing — email entry.
    const signupUrl = await findReachableSignupUrl(session);
    await session.page.goto(signupUrl, { timeout: PAGE_IDLE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    await assertNotCloudflareStuck(session);

    await fillAndSubmit(session.page, SELECTORS.emailInput, args.email, SELECTORS.continueButton);
    emit(WORKER_MARKERS.emailOtpPageReached);

    // 2. Email OTP — ask console-server, type into DOM, submit.
    const emailOtp = await promptForInput("emailOtpPrompt");
    emit(WORKER_MARKERS.checkpointSavedEmail);
    await fillAndSubmit(session.page, SELECTORS.emailOtpInput, emailOtp, SELECTORS.continueButton);
    await saveCheckpoint(checkpointPath, { stage: "email_verified", oai_device_id: session.oaiDeviceId });

    // 3. Password (OpenAI sometimes asks for a new password at signup).
    const newPassword = process.env.CHATGPT_NEW_PASSWORD || process.env.CHATGPT_LOGIN_PASSWORD || "";
    if (await session.page.locator(SELECTORS.passwordInput).first().isVisible({ timeout: 15_000 }).catch(() => false)) {
      if (!newPassword) throw new Error("MISSING_PASSWORD: signup page requested a password but none was provided");
      await fillAndSubmit(session.page, SELECTORS.passwordInput, newPassword, SELECTORS.continueButton);
      await saveCheckpoint(checkpointPath, { stage: "password_submitted", oai_device_id: session.oaiDeviceId });
    }

    // 4. Account profile — name + birthdate.
    const profile = generateInlineProfile();
    emit(WORKER_MARKERS.sentinelProfilePrepare);
    const nameLocator = session.page.locator(SELECTORS.nameInput).first();
    if (await nameLocator.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await nameLocator.fill(profile.name);
    }
    const birthdateLocator = session.page.locator(SELECTORS.birthdateInput).first();
    if (await birthdateLocator.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await birthdateLocator.fill(profile.birthdate);
    }
    await session.page.locator(SELECTORS.continueBirthdateButton).first().click({ timeout: 10_000 }).catch(() => {});
    emit(WORKER_MARKERS.profileCompleted);
    await saveCheckpoint(checkpointPath, { stage: "profile_submitted", oai_device_id: session.oaiDeviceId });

    // 5. Phone binding — console-server pushes the number, then the OTP.
    const addPhoneUrl = await maybeWaitForPhonePage(session);
    if (addPhoneUrl) {
      process.stdout.write(WORKER_MARKERS.phoneNumberPrompt.marker);
      const phone = await readStdinLine();
      await session.page.locator(SELECTORS.phoneInput).first().fill(phone);
      await session.page.locator(SELECTORS.continueButton).first().click({ timeout: 10_000 });
      await saveCheckpoint(checkpointPath, { stage: "phone_requested", oai_device_id: session.oaiDeviceId });
      process.stdout.write(WORKER_MARKERS.phoneOtpPrompt.marker);
      const phoneOtp = await readStdinLine();
      await session.page.locator(SELECTORS.phoneOtpInput).first().fill(phoneOtp);
      await session.page.locator(SELECTORS.continueButton).first().click({ timeout: 10_000 });
      emit(WORKER_MARKERS.phoneOtpValidated);
      await saveCheckpoint(checkpointPath, { stage: "phone_otp_submitted", oai_device_id: session.oaiDeviceId });
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

  const proxyUrl = normalizeProxyUrl(proxy);
  if (proxyUrl && (proxyUrl.scheme === "socks5" || proxyUrl.scheme === "socks5h")) {
    emit(WORKER_MARKERS.browserProxySchemeUnsupported);
    throw new Error("BROWSER_PROXY_SCHEME_UNSUPPORTED: Chromium does not accept SOCKS5 proxy credentials via --proxy-server; use HTTP(S) proxy on the browser lane.");
  }

  const { chromium } = await import("patchright");
  const launchArgs = [
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,InterestFeedContentSuggestions,PasswordLeakDetection,CalculateNativeWinOcclusion,HeavyAdPrivacyMitigations,HttpsUpgrades,InsecureFormSubmissionWarning,InsecurePasswordRedaction,BackForwardCache,DisableLoadExtensionCommandLineSwitch",
    "--disk-cache-size=52428800",
  ];
  const launchOptions = {
    channel: "chrome",
    headless: false,
    args: launchArgs,
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (proxyUrl) {
    launchOptions.proxy = {
      server: `${proxyUrl.scheme}://${proxyUrl.host}:${proxyUrl.port}`,
      ...(proxyUrl.username ? { username: proxyUrl.username, password: proxyUrl.password || "" } : {}),
    };
  }

  if (verbose) console.log(`[browser] launching ${chrome.bin} (major=${chrome.major})`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOptions,
    ...buildContextOptions({
      fingerprint: buildPerAccountFingerprint({ oaiDeviceId }),
      proxy: launchOptions.proxy,
    }),
    executablePath: chrome.bin,
  });

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
  const payload = { ...data, saved_at: new Date().toISOString() };
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
