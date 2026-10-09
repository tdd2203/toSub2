// DOM-transition ↔ worker-stdout marker table.
//
// console-server.mjs reads child stdout line by line via consumeOutput() and
// drives job stage transitions off exact substring matches (`scan.includes(…)`).
// To keep the browser worker a drop-in replacement for protocol-login.mjs,
// every marker consumeOutput scans for MUST still appear on the browser
// worker's stdout at the equivalent DOM moment.
//
// Each entry pairs:
//   - key:        shorthand used by browser-login.mjs
//   - marker:     exact substring printed to stdout
//   - meaning:    what the console-server will do when it sees it
//   - domHint:    the Playwright-side signal that fires the emit (indicative)
//
// Keep this file the single source of truth. If you add a new consumeOutput
// scan.includes(...) in console-server.mjs, add the matching marker here.

export const WORKER_MARKERS = {
  // ---------- Progress markers (LOGIN_PROGRESS_STEPS) ----------
  mfaAccepted: {
    key: "mfaAccepted",
    marker: "[ok] 2FA verification accepted",
    meaning: "progress → 2FA verification accepted",
    domHint: "after MFA code successfully submitted on auth.openai.com",
  },
  sentinelProfilePrepare: {
    key: "sentinelProfilePrepare",
    marker: "[sentinel] Requesting a fresh security token for account profile creation.",
    meaning: "progress → working on account profile",
    domHint: "about to submit name + DOB on account-profile page",
  },
  profileCompleted: {
    key: "profileCompleted",
    marker: "[ok] Account profile completed",
    meaning: "progress → profile saved, continuing",
    domHint: "profile submit response 200",
  },
  workspaceSelect: {
    key: "workspaceSelect",
    marker: "[web] Select ChatGPT login workspace",
    meaning: "progress → selecting workspace",
    domHint: "redirect to choose-an-account or workspace select",
  },
  codexOauthStart: {
    key: "codexOauthStart",
    marker: "[2/5] Start Codex OAuth flow",
    meaning: "progress → Codex OAuth begins",
    domHint: "page.goto(authorize URL)",
  },
  phoneOtpValidated: {
    key: "phoneOtpValidated",
    marker: "[ok] Phone OTP validated",
    meaning: "progress → phone verified, continuing authorization",
    domHint: "phone OTP submit response 200",
  },

  // ---------- Input prompts (LOGIN_INPUT_MARKERS) ----------
  emailOtpPrompt: {
    key: "emailOtpPrompt",
    marker: "Email OTP (r=resend, q=quit):",
    meaning: "worker waits on stdin for email OTP",
    domHint: "email OTP page reached, waiting for console-server-provided code",
  },
  passwordPrompt: {
    key: "passwordPrompt",
    marker: "Password (q=quit):",
    meaning: "worker waits on stdin for password",
    domHint: "password page reached when no CHATGPT_LOGIN_PASSWORD set (should not happen in signup flow)",
  },
  twoFaOtpPrompt: {
    key: "twoFaOtpPrompt",
    marker: "2FA OTP (6 digits, q=quit):",
    meaning: "worker waits on stdin for TOTP",
    domHint: "TOTP challenge page reached and no CHATGPT_TOTP_SECRET env",
  },
  phoneNumberPrompt: {
    key: "phoneNumberPrompt",
    marker: "Phone number, E.164 format: ",
    meaning: "worker waits on stdin for phone number (console-server will push it)",
    domHint: "add-phone page reached, phone input visible",
  },
  phoneOtpPrompt: {
    key: "phoneOtpPrompt",
    marker: "Phone OTP (r=resend, p=change phone, q=quit): ",
    meaning: "worker waits on stdin for phone OTP",
    domHint: "phone OTP input visible after phone submit",
  },

  // ---------- Coarse stage markers ----------
  passwordLoginPageReached: {
    key: "passwordLoginPageReached",
    marker: "[3/5] Password login page reached.",
    meaning: "stage = password",
    domHint: "URL matches auth.openai.com/log-in/password",
  },
  emailOtpPageReached: {
    key: "emailOtpPageReached",
    marker: "[3/5] Email OTP page reached.",
    meaning: "stage = email_otp (waiting for code)",
    domHint: "URL matches auth.openai.com/verify-email or similar",
  },
  checkpointSavedEmail: {
    key: "checkpointSavedEmail",
    marker: "[checkpoint] Saved verified email login state.",
    meaning: "job.loginCheckpointAvailable = true (email OTP verified)",
    domHint: "after email OTP accepted, before password or 2FA step",
  },

  // ---------- Terminal success / failure ----------
  savedSub2api: {
    key: "savedSub2api",
    marker: "[ok] Saved sub2api import: ",
    meaning: "job.resultSaved = true (plus the path printed after this prefix)",
    domHint: "sub2api JSON written to disk atomically",
  },
  profileSecurityCheckRequired: {
    key: "profileSecurityCheckRequired",
    marker: "[profile-security-check-required]",
    meaning: "soft-ban at profile step → markEmailDeactivated",
    domHint: "profile submit returned security-check gate",
  },
  accountProfileRequired: {
    key: "accountProfileRequired",
    marker: "ACCOUNT_PROFILE_REQUIRED",
    meaning: "ban-signal class failure (account needs profile but step unreachable)",
    domHint: "server rejected before we could complete profile",
  },

  // ---------- Browser-lane-only markers (operational, not ban) ----------
  browserProxyAuthFailed: {
    key: "browserProxyAuthFailed",
    marker: "[error] BROWSER_PROXY_AUTH_FAILED",
    meaning: "operational — proxy auth broken on this launch; retry with cleaner proxy",
    domHint: "httpbin IP probe did not match job.exitIp within 15s",
  },
  browserProxySchemeUnsupported: {
    key: "browserProxySchemeUnsupported",
    marker: "[error] BROWSER_PROXY_SCHEME_UNSUPPORTED",
    meaning: "operational — proxy scheme (socks5) unsupported for browser lane",
    domHint: "launchPersistentContext refuses socks5+auth in Chromium",
  },
  browserCfInterstitialStuck: {
    key: "browserCfInterstitialStuck",
    marker: "[error] BROWSER_CF_INTERSTITIAL_STUCK",
    meaning: "operational — Cloudflare interstitial did not pass",
    domHint: "Managed Challenge page still visible after 30s",
  },
  arkoseUnsolvable: {
    key: "arkoseUnsolvable",
    marker: "[error] ARKOSE_UNSOLVABLE",
    meaning: "operational — captcha solver gave up",
    domHint: "2 solver failures with 90s budget each",
  },
  phoneRequiredSoftkill: {
    key: "phoneRequiredSoftkill",
    marker: "[error] PHONE_REQUIRED_SOFTKILL",
    meaning: "ban-signal — phone_required stage right after email reg",
    domHint: "add-phone page reached with no prior content stage (dead-on-arrival account)",
  },
  unsupportedInBrowser: {
    key: "unsupportedInBrowser",
    marker: "[error] UNSUPPORTED_IN_BROWSER_WORKER",
    meaning: "operational — this run-mode is v1-unsupported for the browser lane",
    domHint: "--setup-totp or --add-password were requested",
  },
  accountPasswordAutoset: {
    // Format: "[account] auto-generated password=<16-char>" — console-server
    // scanner saves <value> to credential store so future relogin auto-fills.
    // Fires after /create-account/password OR /reset-password/new-password
    // OR /log-in/password (fallback) submits a deterministic password.
    key: "accountPasswordAutoset",
    marker: "[account] auto-generated password=",
    meaning: "worker auto-filled a deterministic password (no stored) — save to credentials",
    domHint: "after fillPasswordInputs on create-account/reset-password/log-in password pages",
  },
};

// Helper: emit a marker as a single stdout line, flushing immediately.
export function emit(marker, tail = "") {
  const line = typeof marker === "string" ? marker : marker?.marker;
  if (!line) return;
  const text = tail ? `${line}${tail}` : line;
  process.stdout.write(`${text}\n`);
}

// Programmatic access to the full marker string for scanning in tests.
export function allMarkers() {
  return Object.values(WORKER_MARKERS).map((m) => m.marker);
}
