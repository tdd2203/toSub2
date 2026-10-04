#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { createCredentialStore } from "./credential-store.mjs";
import {
  getDb, closeDb, jobDao, usedProxyDao, proxyPoolDao,
  deactivatedEmailDao, usedPhoneDao, sub2apiMonitorDao,
  settingsDao, smsCostDao, migrateFromJsonFiles,
} from "./db.mjs";
import {
  fetchMailboxOtpCandidates,
  filterMailboxOtpCandidatesByRequestTime,
  validateMailApiUrl,
} from "./mail-otp.mjs";
import { createSmsProvider, publicSmsProviderDefinitions } from "./sms-providers.mjs";
import { fetchSmsBowerServiceCatalog, parseSmsBowerServiceCatalog } from "./smsbower.mjs";
import { DirectTlsProfileProbe, proxySupportsSessionRotation, TlsFingerprintTransport } from "./tls-transport.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4399;
const MAX_ACTIVE_JOBS = 20;
const DEFAULT_TLS_PROFILE = "chrome146";
// Per-account curl_cffi profile: existing ("old") accounts keep chrome146, while
// newly created accounts are stamped with the new-account profile — chrome150 by
// default, still overridable through the env knobs the chrome150 trial used. The
// profile is resolved once at creation and persisted per job (see resolveJobTlsProfile),
// so a job never changes fingerprint across reruns or server restarts.
const NEW_ACCOUNT_TLS_PROFILE = normalizeTlsProfile(
  process.env.TOSUB2_NEW_ACCOUNT_TLS_PROFILE || process.env.TOSUB2_TLS_PROFILE,
  "chrome150",
);
const MAX_BATCH_JOBS = 500;
const MAX_PROXY_RISK_RETRIES = 10;
const MAX_PROXY_CONNECTION_FAILURES = 20;
// Cảnh báo "đổi IP": khi một IP (host) đã có >= ngưỡng này tài khoản bị vô hiệu hoá
// (account bị OpenAI ban/xoá/đình chỉ → autoRepairBlocked), IP đó coi như đã "cháy"
// và nên đổi sang IP mới trên proxy. Số nhỏ hơn vẫn hiện cảnh báo (vàng) trên danh sách.
const PROXY_BURN_THRESHOLD = Math.max(1, Math.trunc(Number(process.env.PROXY_BURN_THRESHOLD)) || 5);
const PROXY_CONNECTION_RETRY_BASE_MS = Math.max(1, Number(process.env.PROXY_CONNECTION_RETRY_BASE_MS || 1_000));
const PROXY_CONNECTION_RETRY_MAX_MS = 15_000;
const PAGE_SIZE = 20;
const MAX_LOG_CHARS = 80_000;
const JOB_META_FILENAME = "job-meta.json";
const LOGIN_CHECKPOINT_FILENAME = "login-checkpoint.json";
const TOTP_SETUP_RESULT_FILENAME = "totp-setup-result.json";
const PASSWORD_ADD_RESULT_FILENAME = "password-add-result.json";
const SUB2API_MONITOR_FILENAME = "sub2api-monitor.json";
const USED_PROXIES_FILENAME = "used-proxies.json";
const PROXY_POOL_FILENAME = "proxy-pool.json";
const DEACTIVATED_EMAILS_FILENAME = "deactivated-emails.json";
const USED_PHONES_FILENAME = "used-phones.json";
const SUB2API_MONITOR_INTERVAL_MS = readDurationEnv("SUB2API_MONITOR_INTERVAL_MS", 5 * 60_000, 1_000);
const SUB2API_AUTO_REPAIR_COOLDOWN_MS = readDurationEnv("SUB2API_AUTO_REPAIR_COOLDOWN_MS", 5 * 60_000, 0);
const MAIL_POLL_INTERVAL_MS = 2_500;
const MAIL_POLL_TIMEOUT_MS = 10 * 60_000;
// The first email code is sometimes never delivered (e.g. the mailbox was created
// seconds before it was requested), so ask for a new one when none shows up.
const MAIL_AUTO_RESEND_AFTER_MS = Number(process.env.MAIL_AUTO_RESEND_AFTER_MS) || 45_000;
const MAIL_AUTO_RESEND_MAX = 2;
// OpenAI only emails the verification code for the first couple of signups an IP makes in quick
// succession; a further one within the same short window is accepted but never emailed. So a fixed
// proxy IP may launch at most PROXY_SIGNUP_MAX_PER_WINDOW brand-new registrations per rolling window,
// and extra ones wait in the queue until an earlier start ages out (both overridden by the proxy dialog).
const PROXY_SIGNUP_WINDOW_MS = readDurationEnv("PROXY_SIGNUP_WINDOW_MS", 60_000, 1_000);
const PROXY_SIGNUP_MAX_PER_WINDOW = Math.max(1, Math.trunc(Number(process.env.PROXY_SIGNUP_MAX_PER_WINDOW)) || 2);
const MAX_PROXY_SIGNUP_MAX_PER_WINDOW = 100;
const PROXY_LINK_SETTING_DB_KEY = "ui:chatgpt-onboarding.proxy-link-config-v1";
// Danh sách host (IP cũ) chủ máy đã "Quên" — ẩn khỏi "Danh sách proxy IP". Chỉ ẩn IP cũ
// (configured:false), vì row IP cũ do LIVE JOBS (account đã đăng ký) tạo ra nên không xoá
// được bằng cách sửa cấu hình; thêm lại IP vào cấu hình sẽ hiện lại (configured:true).
const PROXY_FORGOTTEN_HOSTS_KEY = "proxy:forgotten-hosts-v1";
const MAX_MAIL_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_MAIL_REQUEST_HEADERS = 64;
const FORBIDDEN_MAIL_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SMS_POLL_INTERVAL_MS = Number(process.env.SMS_POLL_INTERVAL_MS || process.env.LUBAN_SMS_POLL_INTERVAL_MS || 3_000);
const SMS_POLL_TIMEOUT_MS = Number(process.env.SMS_POLL_TIMEOUT_MS || process.env.LUBAN_SMS_POLL_TIMEOUT_MS || 10 * 60_000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(TOOL_ROOT, "web");
const PROTOCOL_SCRIPT = path.resolve(process.env.ONBOARDING_PROTOCOL_SCRIPT || path.join(__dirname, "protocol-login.mjs"));
const WORKSPACE_ROOT = TOOL_ROOT;
const OUTPUT_ROOT = path.resolve(
  process.env.ONBOARDING_OUTPUT_ROOT || path.join(WORKSPACE_ROOT, "tmp", "chatgpt-onboarding-console"),
);
const SUB2API_MONITOR_PATH = path.join(OUTPUT_ROOT, SUB2API_MONITOR_FILENAME);
const USED_PROXIES_PATH = path.join(OUTPUT_ROOT, USED_PROXIES_FILENAME);
const PROXY_POOL_PATH = path.join(OUTPUT_ROOT, PROXY_POOL_FILENAME);
const DEACTIVATED_EMAILS_PATH = path.join(OUTPUT_ROOT, DEACTIVATED_EMAILS_FILENAME);
const USED_PHONES_PATH = path.join(OUTPUT_ROOT, USED_PHONES_FILENAME);
const DEFAULT_PHONE_MAX_USES = 1;
const credentialStore = createCredentialStore();
const consoleToken = crypto.randomBytes(24).toString("base64url");
const jobs = new Map();
const customSmsPoolPositions = new Map();
const emailJobLocks = new Map();
let outputSyncPromise = null;
let lastOutputSyncAt = 0;
let shuttingDown = false;
let queueSchedulingPaused = false;
let proxyCooldownWakeTimer = null;
let shutdownPromise = null;
let sub2ApiMonitorConfig = null;
let sub2ApiMonitorTimer = null;
let sub2ApiMonitorPromise = null;
// Persistent ledger of every proxy connection-credential ever assigned to an
// account (keyed by session-independent identity), plus the pool of proxies the
// operator has loaded into the system to pick replacements from. Both survive
// restarts and mirror the sub2api-monitor JSON-state pattern.
const usedProxyLedger = new Map(); // identityKey -> { label, protocol, host, port, firstUsedAt, lastUsedAt, emails: [] }
const proxyPool = new Map(); // identityKey -> { label, protocol, host, port, username, password, url, addedAt }
let usedProxyLedgerWritePromise = Promise.resolve();
let proxyPoolWritePromise = Promise.resolve();
// Persistent registry of ChatGPT accounts confirmed deactivated/banned/deleted
// (keyed by lowercased email). The console can't rely on receiving a deactivation
// email, so the moment a permanent failure is confirmed the account is recorded
// here, its task is removed, and only the mailbox stays in "Danh sách email"
// flagged as deactivated — so the operator can see which accounts to remove from
// the workspace. Survives restarts, mirrors the used-proxy ledger pattern.
const deactivatedEmails = new Map(); // email(lowercase) -> { email, reason, at }
let deactivatedEmailsWritePromise = Promise.resolve();
// Persistent registry of phone numbers already used for SMS verification, plus
// numbers the platform's risk control rejected. Keyed by digits-only number.
// Used to (a) cap how many times a number may be reused (phoneMaxUses, default 1)
// and (b) permanently avoid risk-flagged numbers when picking the next one.
// Saved to a file on this machine (never the browser), mirroring the proxy ledger.
const usedPhoneLedger = new Map(); // digits -> { number, uses, blocked, blockedReason, firstUsedAt, lastUsedAt, emails: [] }
let usedPhoneLedgerWritePromise = Promise.resolve();
let phoneMaxUses = DEFAULT_PHONE_MAX_USES; // 0 = unlimited reuse (the block-list still applies)
let mailRequestConfig = { method: "GET", url: null, headers: {} };

// ---- Native temp-mail (magicskill) integration: read the API key from the
// macOS Keychain so the console can create mailboxes and auto-read OTP codes
// without a separate connector or a hand-pasted Authorization header. ----
const MAIL_API_BASE = "https://mail.magicskill.org/emailservice/api/v1";
const MAIL_API_HOST = new URL(MAIL_API_BASE).host; // mail.magicskill.org — used to auto-attach the Keychain Bearer
const MAIL_KEYCHAIN_SERVICE = "magicskill-email-api";
function readMailApiKey() {
  try {
    return execFileSync("security", ["find-generic-password", "-s", MAIL_KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}
const mailApiKey = readMailApiKey();
// Self-configure the email-OTP request so verification codes are read straight
// from the mail service — no external connector, no manual JSON paste.
if (mailApiKey) {
  mailRequestConfig = { method: "GET", url: null, headers: { authorization: `Bearer ${mailApiKey}` } };
}
async function mailApi(path, { method = "GET", body } = {}) {
  const res = await fetch(`${MAIL_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${mailApiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, json };
}

// Public IP of the machine running this console (fetched directly, no proxy),
// cached briefly. Used to show the user which IP accounts get if they opt to
// create on the machine's own network instead of a proxy.
let machineIpCache = { ip: "", at: 0 };
async function fetchMachinePublicIp() {
  if (machineIpCache.ip && Date.now() - machineIpCache.at < 60_000) return machineIpCache.ip;
  const sources = ["https://api.ipify.org?format=json", "https://ifconfig.co/json", "https://ipinfo.io/json"];
  for (const url of sources) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6_000);
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const ip = String(data.ip || data.query || "").trim();
      if (ip) {
        machineIpCache = { ip, at: Date.now() };
        return ip;
      }
    } catch {
      // try next source
    }
  }
  return "";
}

// Check that a proxy actually connects by routing an IP-echo request through it
// (same TLS transport used for onboarding) and returning the proxy's exit IP.
async function checkProxyExitIp(proxyUrl) {
  const url = String(proxyUrl || "").trim();
  if (!url) return { ok: false, error: "缺少代理地址" };
  // Test seam: a host -> exit IP map replaces the live probe (smoke tests have no real proxy).
  if (process.env.PROXY_EXIT_IP_TEST_MAP) {
    const ip = JSON.parse(process.env.PROXY_EXIT_IP_TEST_MAP)[parseProxyUrlForSub2Api(url)?.host];
    return ip ? { ok: true, ip } : { ok: false, error: "no test exit IP" };
  }
  let transport = null;
  try {
    transport = new TlsFingerprintTransport({ cloudflareSolver: false });
    const res = await transport.fetch("https://api.ipify.org?format=json", {
      method: "GET",
      proxy: url,
      timeoutMs: 12_000,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    const ip = String(data?.ip || "").trim();
    return ip ? { ok: true, ip } : { ok: false, error: "无法解析出口 IP" };
  } catch (error) {
    // Never leak proxy credentials in the error text.
    const message = String(error?.message || error).replace(/\/\/[^/@\s]*@/g, "//***@").slice(0, 200);
    return { ok: false, error: message };
  } finally {
    if (transport) await transport.close().catch(() => {});
  }
}

// Cache the exit-IP probe per proxy host so the proxy-list overview can be
// polled frequently (for real-time registration counts) without re-hitting the
// network each time. A fresh probe is forced via { force: true }.
const proxyExitIpCache = new Map(); // host -> { at, result }
const PROXY_EXIT_IP_TTL_MS = 45_000;
async function checkProxyExitIpCached(url, host, { force = false } = {}) {
  const cached = proxyExitIpCache.get(host);
  if (!force && cached && Date.now() - cached.at < PROXY_EXIT_IP_TTL_MS) return cached.result;
  const result = await checkProxyExitIp(url);
  proxyExitIpCache.set(host, { at: Date.now(), result });
  return result;
}

// SMSBower price catalog per service, cached briefly (the raw response is large).
const smsBowerCatalogCache = new Map(); // serviceId -> { at, data }
async function fetchSmsBowerCatalogCached(serviceId) {
  const key = String(serviceId);
  const cached = smsBowerCatalogCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.data;
  try {
    const raw = await fetchSmsBowerServiceCatalog(key, { webBase: process.env.SMSBOWER_WEB_BASE });
    const data = parseSmsBowerServiceCatalog(raw, key);
    if (data) {
      smsBowerCatalogCache.set(key, { at: Date.now(), data });
      return data;
    }
  } catch (error) {
    console.warn(`[warn] SMSBower 价格目录获取失败：${String(error?.message || error).slice(0, 180)}`);
  }
  return cached?.data || null;
}

const sub2ApiRequestControllers = new Set();
const sub2ApiRequestPromises = new Set();
const sub2ApiAutoRepairPromises = new Set();
const directTlsProfileProbe = new DirectTlsProfileProbe({
  explicitProfile: process.env.TOSUB2_TLS_PROFILE,
  validationUrl: `${String(process.env.CHATGPT_BASE || "https://chatgpt.com").replace(/\/$/, "")}/`,
});

// Accept only a real curl_cffi profile name (chromeNNN / chromeNNNx) or "auto";
// anything else (unset, blank, typo) falls back so a job never launches with a
// bogus fingerprint.
function normalizeTlsProfile(value, fallback = DEFAULT_TLS_PROFILE) {
  const normalized = String(value || "").trim();
  return /^chrome\d+[a-z]?$/i.test(normalized) || normalized === "auto" ? normalized : fallback;
}

// The fingerprint a job actually launches with. A stamped job (new account) uses
// its stored profile; an unstamped job (old account restored without one) stays on
// chrome146. This — not the global TOSUB2_TLS_PROFILE env — is authoritative at launch.
function resolveJobTlsProfile(job) {
  return normalizeTlsProfile(job?.tlsProfile, DEFAULT_TLS_PROFILE);
}

// Restore a job's profile from its job-meta.json. Missing field = old account = chrome146.
function restoredTlsProfile(metadata = {}) {
  return normalizeTlsProfile(metadata.tls_profile, DEFAULT_TLS_PROFILE);
}
const sub2ApiMonitorState = {
  running: false,
  lastCheckAt: null,
  nextCheckAt: null,
  lastError: null,
  lastResult: null,
};

const hostArg = process.argv.find((item) => item.startsWith("--host="));
const hostIndex = process.argv.indexOf("--host");
const requestedHost = String(
  hostArg?.slice("--host=".length)
    || (hostIndex >= 0 ? process.argv[hostIndex + 1] : "")
    || process.env.ONBOARDING_HOST
    || DEFAULT_HOST,
).trim();
const portArg = process.argv.find((item) => item.startsWith("--port="));
const portIndex = process.argv.indexOf("--port");
const requestedPort = Number(
  portArg?.slice("--port=".length) || (portIndex >= 0 ? process.argv[portIndex + 1] : "") || DEFAULT_PORT,
);
const hmrPort = requestedPort <= 45_535 ? requestedPort + 20_000 : requestedPort - 20_000;

if (!requestedHost || requestedHost.startsWith("--")) {
  throw new Error("--host must be a valid hostname or IP address");
}

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}

// Proxy session-token patterns — declared before the startup init block below
// because backfillUsedProxiesFromJobs() → stripProxySession() runs at load time.
const PROXY_SID_PATTERN = /(^|-)sid-[A-Za-z0-9]+(?=-|$)/;
const PROXY_KOOKEEY_PATTERN = /^(.*-[A-Za-z]{2})-([0-9]{8})-(\d+m)$/i;

await fs.mkdir(OUTPUT_ROOT, { recursive: true });

// ---- SQLite database init (replaces JSON file persistence for ledger data) ----
const db = getDb();
{
  const dbJobCount = db.prepare("SELECT COUNT(*) as c FROM jobs").get().c;
  if (dbJobCount === 0) {
    console.log("[db] Empty database detected, auto-migrating from JSON files...");
    const migrated = migrateFromJsonFiles();
    console.log(`[db] Migrated: ${migrated.jobs} jobs, ${migrated.proxies} proxies, ${migrated.phones} phones, ${migrated.deactivated} deactivated`);
  }
  const savedMaxUses = settingsDao.get("phone_max_uses");
  if (savedMaxUses !== null) phoneMaxUses = Number(savedMaxUses) || DEFAULT_PHONE_MAX_USES;
}

await loadSub2ApiMonitorConfiguration();
await loadUsedProxyLedger();
await loadProxyPool();
await loadDeactivatedEmails();
await loadUsedPhoneLedger();
await syncCompletedOutputs(true);
backfillUsedProxiesFromJobs();
await backfillDeactivatedFromJobs();
scheduleQueuedJobs();
scheduleSub2ApiMonitor();

const vite = await createViteServer({
  root: WEB_ROOT,
  configFile: false,
  appType: "spa",
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: { port: hmrPort, clientPort: hmrPort },
  },
});

const server = http.createServer(async (req, res) => {
  try {
    enforceUtf8ContentType(res);
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${requestedHost}:${requestedPort}`}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }
    vite.middlewares(req, res, (error) => {
      if (error) sendJson(res, 500, { error: error.message || "Page rendering failed" });
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Internal server error" });
  }
});

function enforceUtf8ContentType(res) {
  const setHeader = res.setHeader;
  res.setHeader = function setUtf8Header(name, value) {
    if (String(name).toLowerCase() === "content-type") {
      value = addUtf8Charset(value);
    }
    return setHeader.call(this, name, value);
  };
}

function addUtf8Charset(value) {
  if (typeof value !== "string" || /;\s*charset=/i.test(value)) return value;
  if (/^(?:text\/(?:html|css|javascript|plain)|application\/(?:javascript|json))(?:\s*;|$)/i.test(value)) {
    return `${value}; charset=utf-8`;
  }
  return value;
}

server.listen(requestedPort, requestedHost, () => {
  const urls = getConsoleUrls(requestedHost, requestedPort);
  console.log(`[ok] ChatGPT onboarding console: ${urls[0]}`);
  for (const url of urls.slice(1)) console.log(`[ok] LAN access: ${url}`);
  console.log(`[info] Output directory: ${OUTPUT_ROOT}`);
  if (isWildcardHost(requestedHost)) {
    console.log("[note] LAN access is enabled without authentication. Keep downloaded OAuth files private.");
  } else {
    console.log("[note] This server only listens on the configured host. Keep downloaded OAuth files private.");
  }
});

function isWildcardHost(host) {
  return host === "0.0.0.0" || host === "::";
}

function getConsoleUrls(host, port) {
  if (!isWildcardHost(host)) return [`http://${host}:${port}`];
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return [
    `http://127.0.0.1:${port}`,
    ...[...new Set(addresses)].map((address) => `http://${address}:${port}`),
  ];
}

async function handleApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      token: consoleToken,
      features: {
        retry: true,
        regenerate: true,
        phoneContext: true,
        batchDownload: true,
        bulkActions: true,
        pagination: true,
        uniqueEmail: true,
        smsProviders: publicSmsProviderDefinitions(),
        queue: true,
        sourceExport: true,
        cancelAll: true,
        sub2apiUpload: true,
        sub2apiBackfill: true,
        sub2apiMonitor: true,
        tlsFingerprint: true,
        totpSetup: true,
        passwordAdd: true,
        forceRelogin: true,
      },
    });
    return;
  }

  if (req.headers["x-console-token"] !== consoleToken) {
    sendJson(res, 403, { error: "Invalid console token" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {
    const requestedPage = Math.max(1, Number.parseInt(requestUrl.searchParams.get("page") || "1", 10) || 1);
    await sendJobsPage(res, requestedPage);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/query") {
    const body = await readJson(req);
    const requestedPage = Math.max(1, Number.parseInt(body.page || "1", 10) || 1);
    // Large enough for a bulk paste (a whole copied account table) — sendJobsPage extracts the emails.
    const search = typeof body.search === "string" ? body.search.slice(0, 200_000) : "";
    // emails is the (optional) bulk list filter; search is the optional quick substring.
    const emails = Array.isArray(body.emails) && body.emails.length ? normalizeEmailFilter(body.emails) : null;
    await sendJobsPage(res, requestedPage, emails, search);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/mail-request-config") {
    const body = await readJson(req);
    mailRequestConfig = normalizeMailRequestConfig(body.config);
    sendJson(res, 200, {
      config: {
        method: mailRequestConfig.method,
        urlConfigured: Boolean(mailRequestConfig.url),
        headerCount: Object.keys(mailRequestConfig.headers).length,
      },
    });
    return;
  }

  // Domains grouped by root + subdomains, for the "Tạo email" picker.
  if (req.method === "GET" && requestUrl.pathname === "/api/mail/domains") {
    const d = await mailApi("/domains");
    const domains = d.ok ? d.json.domains || [] : [];
    const points = d.ok ? d.json.points || {} : {};
    const roots = Object.keys(points);
    const groups = Object.fromEntries(roots.map((r) => [r, []]));
    for (const dom of domains) {
      const root = roots
        .filter((r) => dom === r || dom.endsWith(`.${r}`))
        .sort((a, b) => b.length - a.length)[0];
      if (root) groups[root].push(dom);
    }
    const DEFAULTS = ["ndaigroup.com", "dataidcc.com"];
    const rootsOut = roots
      .map((r) => ({ root: r, weight: points[r], subdomains: groups[r].filter((x) => x !== r).sort() }))
      .sort((a, b) => (DEFAULTS.indexOf(a.root) < 0 ? 99 : DEFAULTS.indexOf(a.root)) - (DEFAULTS.indexOf(b.root) < 0 ? 99 : DEFAULTS.indexOf(b.root)));
    sendJson(res, 200, { available: d.ok, keyPresent: Boolean(mailApiKey), defaults: DEFAULTS, roots: rootsOut });
    return;
  }

  // Public IP of THIS machine (no proxy) — shown to the user when they choose to
  // create accounts on the machine's own network instead of a proxy.
  if (req.method === "GET" && requestUrl.pathname === "/api/machine-ip") {
    const ip = await fetchMachinePublicIp();
    sendJson(res, ip ? 200 : 502, ip ? { ip } : { error: "无法获取本机公网 IP" });
    return;
  }

  // Test a proxy and return its exit IP so the user can see it is connected.
  if (req.method === "POST" && requestUrl.pathname === "/api/proxy-check") {
    const body = await readJson(req);
    const result = await checkProxyExitIp(body.proxyUrl);
    sendJson(res, result.ok ? 200 : 502, result.ok ? { ip: result.ip } : { error: result.error || "代理连接失败" });
    return;
  }

  // The pool of proxies loaded into the system, each annotated with whether the
  // connection credential has ever been used / is currently in use. The
  // change-proxy picker shows the never-used ones.
  if (req.method === "GET" && requestUrl.pathname === "/api/proxy-pool") {
    sendJson(res, 200, { proxies: publicProxyPool() });
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/api/proxy-pool/import") {
    const body = await readJson(req);
    const result = importProxiesIntoPool(body.text);
    await persistProxyPool();
    sendJson(res, 200, { ...result, proxies: publicProxyPool() });
    return;
  }

  // Proxy IP list overview: for each proxy IP (configured now, plus the older IPs
  // that previously registered accounts), report connection status, exit IP, the
  // mailboxes registered through that IP, and how many more accounts it can still
  // register (limitPerIp − used). Everything is grouped per IP (host).
  if (req.method === "POST" && requestUrl.pathname === "/api/proxies/status") {
    const body = await readJson(req);
    const limitPerIp = Math.min(999, Math.max(1, Math.trunc(Number(body.limitPerIp)) || 15));
    const mode = body.mode === "batch" ? "batch" : "single";
    let urls = [];
    if (mode === "batch") {
      // Mỗi IP (host) chỉ tính 1 lần — tránh 1 IP hiện thành 2 dòng (HTTP + SOCKS5).
      const seenHosts = new Set();
      urls = parseProxyList(body.proxies)
        .filter((p) => (seenHosts.has(p.host) ? false : (seenHosts.add(p.host), true)))
        .map(proxyObjToUrl);
    } else {
      const one = normalizeProxyUrl(body.proxies);
      if (one) urls = [one];
    }
    // A domain proxy whose exit IP equals a raw-IP proxy already stored on jobs is
    // the same line: overwrite those records with the domain before counting usage.
    const forceCheck = body.refresh === true;
    const probedHosts = await overwriteRawIpProxiesWithDomains(urls, { force: forceCheck });
    // Group existing jobs by their proxy's IP (host). Keep a representative URL so
    // even an IP that is no longer in the configured list can still be health-checked.
    const jobsByHost = new Map(); // host -> { url, emails: [{email,status,registered}] }
    const consumedByHost = proxyConsumedByHost(); // registered-or-running, minus deactivated
    // host -> { total, deactivated } lấy từ SỔ CÁI lifetime (used_proxy_emails JOIN
    // deactivated_emails). Dùng sổ cái vì job của tài khoản bị vô hiệu hoá bị XOÁ hẳn
    // (removeDeactivatedTask → deleteJobsByEmail), nên đếm từ job đang sống sẽ luôn = 0.
    // HYBRID: giữ 2 góc nhìn về cháy, không wipe lịch sử.
    // - deactivationByHost: lịch sử cháy TRỌN ĐỜI theo proxy line (host) — giữ nguyên
    //   dữ liệu cũ (kể cả account NULL exit_ip), không bao giờ reset.
    // - deactivationByExitIp: cháy theo IP RA THỰC đang ra (chỉ account mới có exit_ip)
    //   — dùng để "checking" xem IP đang dùng đã sạch hay vẫn cháy.
    const deactivationByHost = usedProxyDao.deactivationHistoryByHost();
    const deactivationByExitIp = usedProxyDao.deactivationHistoryByExitIp();
    for (const job of listUniqueJobs()) {
      if (job.deleted || !job.proxyUrl) continue;
      const parsed = parseProxyUrlForSub2Api(job.proxyUrl);
      if (!parsed) continue;
      if (!jobsByHost.has(parsed.host)) jobsByHost.set(parsed.host, { url: job.proxyUrl, emails: [] });
      jobsByHost.get(parsed.host).emails.push({
        email: job.email,
        status: job.status,
        registered: Boolean(job.registrationSucceeded),
      });
    }
    // Build the list of IPs to report: configured first, then older IPs from jobs.
    const targets = [];
    const seen = new Set();
    for (const url of urls) {
      const parsed = parseProxyUrlForSub2Api(url);
      if (!parsed || seen.has(parsed.host)) continue;
      seen.add(parsed.host);
      targets.push({ host: parsed.host, url, configured: true });
    }
    // IP cũ (không trong cấu hình) mà chủ đã "Quên" thì ẩn khỏi danh sách. IP đang
    // cấu hình (ở vòng trên) không bao giờ bị ẩn — thêm lại vào cấu hình là hiện lại.
    const forgottenHosts = getForgottenProxyHosts();
    for (const [host, info] of jobsByHost) {
      if (seen.has(host) || forgottenHosts.has(host)) continue;
      seen.add(host);
      targets.push({ host, url: info.url, configured: false });
    }
    // A live exit-IP probe is slow, so cache it per host — this lets the client
    // poll frequently for real-time registration counts without re-checking the
    // network every time. The manual refresh button forces a fresh probe.
    const proxies = await mapWithConcurrency(targets, 6, async (target) => {
      const parsed = parseProxyUrlForSub2Api(target.url);
      const emails = jobsByHost.get(target.host)?.emails || [];
      // Domain hosts were just probed by the overwrite step above — reuse that result.
      const check = await checkProxyExitIpCached(target.url, target.host, { force: forceCheck && !probedHosts.has(target.host) });
      const emailCount = emails.length;
      // "đăng ký thành công" = đã qua email OTP và tới bước SMS. Một slot bị chiếm
      // bởi tài khoản đã đăng ký (chưa vô hiệu hoá) HOẶC đang chạy; job chờ khởi
      // động không trừ IP.
      const registeredCount = emails.filter((e) => e.registered).length;
      const consumedCount = consumedByHost.get(target.host) || 0;
      const remaining = Math.max(0, limitPerIp - consumedCount);
      // (1) LỊCH SỬ CHÁY theo host (trọn đời proxy line, không wipe): disabledCount =
      // số account bị vô hiệu hoá, disabledTotal = tổng account từng chạy qua.
      const history = deactivationByHost.get(target.host) || { total: 0, deactivated: 0 };
      const disabledCount = history.deactivated;
      const disabledTotal = history.total;
      // (2) CHECKING — IP RA THỰC đang ra (check.ip) đã sạch chưa:
      //   unknown = proxy chết, không probe được IP hiện tại.
      //   nodata  = probe được IP nhưng CHƯA có account mới nào trên IP này (toàn
      //             account cũ NULL) → KHÔNG kết luận sạch, chỉ là chưa có dữ liệu.
      //   clean   = có account mới trên IP này và chưa cháy → "Đã đổi IP ✓".
      //   burning = IP hiện tại đã có account cháy nhưng dưới ngưỡng.
      //   burned  = IP hiện tại cháy >= ngưỡng → đỏ "Cần đổi IP".
      const curBucket = (check.ok && check.ip) ? deactivationByExitIp.get(check.ip) : undefined;
      const curExitDisabled = curBucket ? curBucket.deactivated : 0;
      const curExitTotal = curBucket ? curBucket.total : 0;
      let curExitStatus;
      if (!check.ok || !check.ip) curExitStatus = "unknown";
      else if (!curBucket) curExitStatus = "nodata";
      else if (curExitDisabled >= PROXY_BURN_THRESHOLD) curExitStatus = "burned";
      else if (curExitDisabled > 0) curExitStatus = "burning";
      else curExitStatus = "clean";
      return {
        host: parsed?.host || target.host,
        port: parsed?.port || 0,
        protocol: parsed?.protocol || "",
        label: parsed ? `${parsed.host}:${parsed.port}` : target.url,
        configured: target.configured,
        connected: check.ok,
        ip: check.ip || "",
        error: check.ok ? "" : (check.error || ""),
        emails: emails.map((e) => e.email),
        completed: emails.filter((e) => e.status === "completed").length,
        emailCount,
        registeredCount,
        consumedCount,
        remaining,
        disabledCount,
        disabledTotal,
        curExitDisabled,
        curExitTotal,
        curExitStatus,
        // burned = IP ĐANG DÙNG cháy >= ngưỡng → đỏ "Cần đổi IP" (dựa trên IP hiện tại,
        // không dựa lịch sử host để chủ đổi IP là cờ tắt).
        burned: curExitStatus === "burned",
        // usage: "unused" = chưa chiếm chỗ · "inuse" = còn lượt · "used" = hết lượt
        usage: consumedCount === 0 ? "unused" : (remaining > 0 ? "inuse" : "used"),
      };
    });
    const activeCount = proxies.filter((p) => p.connected).length;
    const remaining = proxies.filter((p) => p.connected).reduce((sum, p) => sum + p.remaining, 0);
    const usageCounts = {
      unused: proxies.filter((p) => p.usage === "unused").length,
      inuse: proxies.filter((p) => p.usage === "inuse").length,
      used: proxies.filter((p) => p.usage === "used").length,
    };
    const burnedCount = proxies.filter((p) => p.burned).length;
    sendJson(res, 200, { limitPerIp, mode, totalCount: proxies.length, activeCount, remaining, usageCounts, burnedCount, burnThreshold: PROXY_BURN_THRESHOLD, proxies });
    return;
  }

  // Áp dụng việc gán proxy theo domain cho các TÀI KHOẢN ĐÃ CÓ: tài khoản nào
  // đang dùng proxy nay đã thành độc quyền của MỘT domain khác (email không khớp
  // domain đó) sẽ được đổi sang proxy phù hợp (proxy riêng của domain nó nếu có,
  // không thì pool chung đã loại các host độc quyền). Chỉ đổi tài khoản KHÔNG
  // đang chạy để không làm gián đoạn phiên đăng ký; tài khoản đang chạy được bỏ
  // qua và báo lại số lượng.
  if (req.method === "POST" && requestUrl.pathname === "/api/proxies/apply-domains") {
    const body = await readJson(req);
    const config = readProxyAllocConfig(body);
    const limitPerIp = Math.min(999, Math.max(1, Math.trunc(Number(body.limitPerIp)) || 15));
    // host -> domain mà nó được gán riêng.
    const domainOfHost = new Map();
    for (const group of config.groups) {
      for (const item of dedupeProxyUrls(group.proxies)) domainOfHost.set(item.host, group.domain);
    }
    const allocator = makeProxyAllocator(config, limitPerIp);
    let reassigned = 0;
    let skippedRunning = 0;
    let noProxy = 0;
    const mismatched = [];
    for (const job of listUniqueJobs()) {
      if (job.deleted || !job.proxyUrl) continue;
      const parsed = parseProxyUrlForSub2Api(job.proxyUrl);
      if (!parsed) continue;
      const boundDomain = domainOfHost.get(parsed.host);
      if (!boundDomain) continue; // proxy hiện tại không bị gán độc quyền → giữ nguyên
      const emailDomain = emailDomainPart(job.email);
      if (emailDomain === boundDomain || emailDomain.endsWith(`.${boundDomain}`)) continue; // đúng domain
      mismatched.push(job); // đang dùng proxy độc quyền của domain khác → cần đổi
    }
    for (const job of mismatched) {
      if (occupiesActiveSlot(job)) { skippedRunning += 1; continue; }
      const newProxy = allocator.next(job.email);
      if (!newProxy) { noProxy += 1; continue; }
      await withEmailJobLock(job.email, () => updateJobProxy(job, newProxy));
      reassigned += 1;
    }
    sendJson(res, 200, { mismatched: mismatched.length, reassigned, skippedRunning, noProxy });
    return;
  }

  // "Quên IP này": ẩn 1 IP cũ (không còn trong cấu hình) khỏi danh sách. Không xoá job
  // (giữ record tài khoản), chỉ ẩn dòng. forget=false để hiện lại.
  if (req.method === "POST" && requestUrl.pathname === "/api/proxies/forget") {
    const body = await readJson(req);
    const host = String(body.host || "").trim();
    if (!host) {
      sendJson(res, 400, { error: "Thiếu host" });
      return;
    }
    const forgotten = setProxyHostForgotten(host, body.forget !== false);
    sendJson(res, 200, { ok: true, host, forgotten });
    return;
  }

  // Create N mailboxes (optionally on a chosen domain, optionally tagged) and
  // return ready-to-add "email----otpUrl" lines for the batch box.
  if (req.method === "POST" && requestUrl.pathname === "/api/mail/create") {
    const body = await readJson(req);
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      sendJson(res, 400, { error: "Số lượng phải từ 1 đến 50" });
      return;
    }
    const payload = { count };
    if (body.domain) payload.domain = String(body.domain);
    if (body.tag) payload.tag = String(body.tag);
    const r = await mailApi("/mailboxes/batch", { method: "POST", body: payload });
    if (!r.ok) {
      sendJson(res, r.status, { error: (r.json && r.json.detail) || `HTTP ${r.status}` });
      return;
    }
    const boxes = (r.json.mailboxes || []).map((mb) => ({
      email: mb.email,
      tag: mb.tag,
      line: `${mb.email}----${MAIL_API_BASE}/mailboxes/${encodeURIComponent(mb.email)}/otp`,
    }));
    sendJson(res, 200, { created: r.json.created ?? boxes.length, boxes, errors: r.json.errors || [] });
    return;
  }

  // List existing mailboxes for the "Danh sách email" panel. Optional ?tag= / ?domain= filters.
  if (req.method === "GET" && requestUrl.pathname === "/api/mail/mailboxes") {
    const r = await mailApi("/mailboxes");
    if (!r.ok) {
      sendJson(res, r.status, { error: (r.json && r.json.detail) || `HTTP ${r.status}` });
      return;
    }
    const tagFilter = requestUrl.searchParams.get("tag");
    const domainFilter = requestUrl.searchParams.get("domain");
    let list = (r.json.mailboxes || []).map((mb) => {
      const email = mb.email;
      const otpUrl = `${MAIL_API_BASE}/mailboxes/${encodeURIComponent(email)}/otp`;
      // Has this mailbox already been used to onboard a ChatGPT account?
      // "Created" = a ChatGPT account already exists for this mailbox: either the
      // onboarding finished (completed), or sign-up + email verification succeeded
      // (a login checkpoint was saved) and only later steps such as SMS verification
      // are still pending — those must NOT be shown as "uncreated".
      const job = findJobByEmail(email);
      const accountCreated = Boolean(job) && (
        job.status === "completed"
        || Boolean(job.loginCheckpointAvailable)
        || ["phone", "phone_otp"].includes(job.status) // account exists, SMS verification pending
      );
      // A deactivated account's task is removed, so the mailbox's deactivated
      // state lives only in the registry — surface it here for the email list.
      const deactivation = deactivatedEmails.get(String(email).toLowerCase()) || null;
      return {
        id: mb.id,
        email,
        tag: mb.tag || null,
        category: mb.category || null,
        created_at: mb.created_at || null,
        last_message_at: mb.last_message_at || null,
        suspended: Boolean(mb.suspended),
        domain: String(email || "").split("@")[1] || "",
        accountCreated,
        accountStatus: job?.status || null,
        deactivated: Boolean(deactivation),
        deactivatedReason: deactivation?.reason || null,
        deactivatedAt: deactivation?.at || null,
        otpUrl,
        line: `${email}----${otpUrl}`,
      };
    });
    if (tagFilter) list = list.filter((m) => (m.tag || "") === tagFilter);
    if (domainFilter) list = list.filter((m) => m.domain === domainFilter || m.domain.endsWith(`.${domainFilter}`));
    // Deactivated mailboxes sink to the very bottom, then mailboxes already used
    // for an account; within each group, newest first so freshly created ones are
    // easy to find.
    list.sort((a, b) => {
      if (a.deactivated !== b.deactivated) return a.deactivated ? 1 : -1;
      if (a.accountCreated !== b.accountCreated) return a.accountCreated ? 1 : -1;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
    // Count emails with jobs (in step 4) and active/stable ones
    const totalInStep4 = list.filter((m) => m.accountCreated).length;
    const totalActiveStable = list.filter((m) => m.accountCreated && !m.deactivated).length;
    const totalDeactivated = list.filter((m) => m.deactivated).length;
    const totalUncreated = list.filter((m) => !m.accountCreated && !m.deactivated).length;
    sendJson(res, 200, {
      mailboxes: list,
      total: list.length,
      totalInStep4,
      totalActiveStable,
      totalDeactivated,
      totalUncreated,
    });
    return;
  }

  // Delete one mailbox (the frontend confirms with the user before calling this).
  if (req.method === "DELETE" && requestUrl.pathname === "/api/mail/mailbox") {
    const email = String(requestUrl.searchParams.get("email") || "").trim();
    if (!email) {
      sendJson(res, 400, { error: "Thiếu email" });
      return;
    }
    const r = await mailApi(`/mailboxes/${encodeURIComponent(email)}`, { method: "DELETE" });
    if (!r.ok) {
      sendJson(res, r.status, { error: (r.json && r.json.detail) || `HTTP ${r.status}` });
      return;
    }
    clearEmailDeactivated(email); // mailbox gone → drop its deactivated flag
    sendJson(res, 200, { status: (r.json && r.json.status) || "deleted", email });
    return;
  }

  // Tag a single existing mailbox.
  if (req.method === "PATCH" && requestUrl.pathname === "/api/mail/tag") {
    const body = await readJson(req);
    const email = String(body.email || "").trim();
    const tag = String(body.tag || "").trim();
    if (!email) { sendJson(res, 400, { error: "Thiếu email" }); return; }
    const r = await mailApi(`/mailboxes/${encodeURIComponent(email)}/tag`, {
      method: "PATCH",
      body: JSON.stringify({ tag }),
    });
    if (!r.ok) {
      sendJson(res, r.status, { error: (r.json && r.json.detail) || `HTTP ${r.status}` });
      return;
    }
    sendJson(res, 200, { email, tag, ok: true });
    return;
  }

  // Tag multiple mailboxes at once.
  if (req.method === "POST" && requestUrl.pathname === "/api/mail/batch-tag") {
    const body = await readJson(req);
    const emails = Array.isArray(body.emails) ? body.emails.map(e => String(e).trim()).filter(Boolean) : [];
    const tag = String(body.tag || "").trim();
    if (!emails.length) { sendJson(res, 400, { error: "Thiếu danh sách email" }); return; }
    if (!tag) { sendJson(res, 400, { error: "Thiếu tag" }); return; }
    // Use hostmail batch-tag endpoint
    const r = await mailApi("/mailboxes/batch-tag", {
      method: "POST",
      body: JSON.stringify({ emails, tag }),
    });
    if (!r.ok) {
      sendJson(res, r.status, { error: (r.json && r.json.detail) || `HTTP ${r.status}` });
      return;
    }
    sendJson(res, 200, r.json || { tagged: 0, errors: [] });
    return;
  }

  // Mark ChatGPT Team emails without jobs as deactivated.
  if (req.method === "POST" && requestUrl.pathname === "/api/mail/deactivate-orphans") {
    const reason = "Email có tag ChatGPT Team nhưng không có tác vụ trong bước 4";
    // Fetch all mailboxes
    const r = await mailApi("/mailboxes");
    if (!r.ok) {
      sendJson(res, r.status, { error: (r.json && r.json.detail) || `HTTP ${r.status}` });
      return;
    }
    let deactivated = 0;
    let skipped = 0;
    const details = [];
    for (const mb of (r.json.mailboxes || [])) {
      const email = mb.email;
      const tag = mb.tag || "";
      if (!/chatgpt/i.test(tag)) { continue; } // not ChatGPT Team tagged
      const job = findJobByEmail(email);
      if (job) { skipped++; continue; } // has a task in step 4
      if (deactivatedEmails.has(String(email).toLowerCase())) { skipped++; continue; } // already deactivated
      markEmailDeactivated(email, reason);
      deactivated++;
      details.push(email);
    }
    sendJson(res, 200, { deactivated, skipped, details });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs") {
    const body = await readJson(req);
    const email = String(body.email || "").trim();
    if (!isEmail(email)) {
      sendJson(res, 400, { error: "Please enter a valid email address" });
      return;
    }
    const hasCredentialUpdate = ["password", "mailApiUrl", "mailRequestBody", "totpSecret"].some((key) => Object.hasOwn(body, key));
    const credentials = normalizeLoginCredentials(body);
    const batchMode = body.proxyMode === "batch";
    const hasProxyUpdate = Object.hasOwn(body, "proxyUrl");
    const proxyUrl = hasProxyUpdate ? normalizeProxyUrl(body.proxyUrl) : null;
    const result = await withEmailJobLock(email, async () => {
      const existing = findJobByEmail(email);
      if (existing) {
        // Ở chế độ nhiều IP: giữ nguyên proxy đã gán cho tài khoản, không gán lại.
        if (hasCredentialUpdate) await updateJobCredentials(existing, credentials, { proxyUrl, hasProxyUpdate });
        else if (hasProxyUpdate) await updateJobProxy(existing, proxyUrl);
        return { job: existing, created: false, updated: hasCredentialUpdate || hasProxyUpdate };
      }
      let assignedProxy = proxyUrl;
      if (batchMode) {
        assignedProxy = makeProxyAllocator(readProxyAllocConfig(body), body.limitPerIp).next(email);
        if (!assignedProxy) return { poolFull: true };
      }
      return { job: await startJob(email, credentials, assignedProxy), created: true, updated: false };
    });
    if (result.poolFull) {
      sendJson(res, 400, { error: "所有代理 IP 已达上限，请在“代理 IP 列表”中添加新 IP" });
      return;
    }
    sendJson(res, result.created ? 201 : 200, { ...result, job: publicJob(result.job) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/batch") {
    const body = await readJson(req);
    const entries = parseBatchEntries(body.text, mailRequestConfig);
    const batchMode = body.proxyMode === "batch";
    const allocator = batchMode ? makeProxyAllocator(readProxyAllocConfig(body), body.limitPerIp) : null;
    const proxyUrl = normalizeProxyUrl(body.proxyUrl);
    // Ở chế độ nhiều IP: chạy đủ số chỗ còn lại của các IP; tài khoản dư (không
    // còn chỗ) được tạo rồi huỷ tác vụ ngay, không từ chối cả lô.
    const results = await Promise.all(entries.map((entry) => withEmailJobLock(entry.email, async () => {
      const existing = findJobByEmail(entry.email);
      if (existing) {
        // Ở chế độ nhiều IP: giữ nguyên proxy đã gán, không gán lại.
        await updateJobCredentials(existing, entry, batchMode ? { hasProxyUpdate: false } : { proxyUrl, hasProxyUpdate: true });
        // Creating a task means "run it" — a staged (idle) job gets started here.
        if (existing.status === "idle") enqueueJob(existing, "full", "正在建立登录会话");
        return { job: existing, updated: true };
      }
      if (allocator) {
        const assignedProxy = allocator.next(entry.email);
        if (!assignedProxy) {
          // IP đã đủ giới hạn đăng ký → tạo tác vụ rồi huỷ ngay.
          const job = await startJob(entry.email, entry, null, { staged: true });
          cancelForProxyCapacity(job);
          return { job, updated: false, canceled: true };
        }
        return { job: await startJob(entry.email, entry, assignedProxy), updated: false };
      }
      return { job: await startJob(entry.email, entry, proxyUrl), updated: false };
    })));
    sendJson(res, 201, {
      jobs: results.map((item) => publicJob(item.job)),
      created: results.filter((item) => !item.updated && !item.canceled).length,
      updated: results.filter((item) => item.updated).length,
      canceled: results.filter((item) => item.canceled).length,
    });
    return;
  }

  // Stage mailboxes into the run list without starting them ("待启动"/idle).
  // Used right after "创建邮箱" so freshly created emails appear in the list and
  // can be launched later with /api/jobs/start-batch.
  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/stage") {
    const body = await readJson(req);
    const entries = parseBatchEntries(body.text, mailRequestConfig);
    const batchMode = body.proxyMode === "batch";
    const proxyUrl = normalizeProxyUrl(body.proxyUrl);
    // Staged jobs are idle and do NOT consume a slot, so stage everything and
    // just distribute them round-robin across the configured IPs. The per-IP
    // registration limit is enforced later, when the jobs are actually started.
    // Khớp proxy theo domain của email (có proxy riêng thì dùng, hết thì mượn
    // pool chung); round-robin thuần, không xét giới hạn/usage ở bước staging.
    const stageConfig = batchMode ? readProxyAllocConfig(body) : { general: "", groups: [] };
    const stageDomains = stageConfig.groups.map((g) => ({ domain: g.domain, list: dedupeProxyUrls(g.proxies) }));
    const stageDomainHosts = new Set(stageDomains.flatMap((d) => d.list.map((it) => it.host)));
    const stageDomainLists = stageDomains.map((d) => ({ domain: d.domain, urls: d.list.map((it) => it.url) }));
    // Proxy đã gán domain là độc quyền → loại khỏi pool chung ở bước staging luôn.
    const stageGeneral = batchMode
      ? dedupeProxyUrls(stageConfig.general).filter((it) => !stageDomainHosts.has(it.host)).map((it) => it.url)
      : [];
    const stageCursors = new Map();
    const pickStage = (urls, key) => {
      if (!urls.length) return null;
      const i = (stageCursors.get(key) || 0) % urls.length;
      stageCursors.set(key, i + 1);
      return urls[i];
    };
    const nextStageProxy = (email) => {
      const domain = emailDomainPart(email);
      const group = domain ? stageDomainLists.find((g) => domain === g.domain || domain.endsWith(`.${g.domain}`)) : null;
      if (group) {
        const url = pickStage(group.urls, `domain:${group.domain}`);
        if (url) return url;
      }
      return pickStage(stageGeneral, "__general__");
    };
    const results = await Promise.all(entries.map((entry) => withEmailJobLock(entry.email, async () => {
      const existing = findJobByEmail(entry.email);
      if (existing) return { job: existing, created: false };
      const assignedProxy = batchMode ? nextStageProxy(entry.email) : proxyUrl;
      return { job: await startJob(entry.email, entry, assignedProxy, { staged: true }), created: true };
    })));
    sendJson(res, 201, {
      jobs: results.map((item) => publicJob(item.job)),
      created: results.filter((item) => item.created).length,
      skipped: results.filter((item) => !item.created).length,
    });
    return;
  }

  // Start selected staged (idle) jobs: apply the current proxy, then enqueue them.
  // "khi bấm chạy tác vụ cần phải xem số lượng có thể tạo với IP có trước": in
  // batch mode, respect each IP's remaining registration slots — start only as
  // many as fit, and cancel the overflow accounts.
  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/start-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const proxyUrl = normalizeProxyUrl(body.proxyUrl);
    const hasProxyUpdate = Object.hasOwn(body, "proxyUrl");
    const hasLimit = body.limitPerIp !== undefined && body.limitPerIp !== null;
    const limitPerIp = hasLimit
      ? Math.min(999, Math.max(1, Math.trunc(Number(body.limitPerIp)) || 15))
      : null;

    // Synchronous pre-pass decides start vs cancel per job so the per-IP counters
    // stay consistent regardless of async interleaving.
    const consumed = hasLimit ? proxyConsumedByHost() : null;
    const startedByHost = new Map();
    const decisions = selected.map((job) => {
      if (job.status !== "idle") return { job, action: "skip" };
      if (!hasLimit) return { job, action: "start" };
      const effectiveProxy = hasProxyUpdate ? proxyUrl : job.proxyUrl;
      const parsed = effectiveProxy ? parseProxyUrlForSub2Api(effectiveProxy) : null;
      if (!parsed) return { job, action: "cancel" };
      const used = (consumed.get(parsed.host) || 0) + (startedByHost.get(parsed.host) || 0);
      if (used >= limitPerIp) return { job, action: "cancel" };
      startedByHost.set(parsed.host, (startedByHost.get(parsed.host) || 0) + 1);
      return { job, action: "start" };
    });

    const applied = await Promise.all(decisions.map((d) => withEmailJobLock(d.job.email, async () => {
      if (d.action === "skip" || d.job.status !== "idle") return { skipped: true };
      if (d.action === "cancel") {
        cancelForProxyCapacity(d.job);
        return { canceled: true, job: d.job };
      }
      if (hasProxyUpdate) await updateJobProxy(d.job, proxyUrl);
      enqueueJob(d.job, "full", "正在建立登录会话");
      return { started: true, job: d.job };
    })));
    const startedJobs = applied.filter((a) => a.started).map((a) => a.job);
    const canceledJobs = applied.filter((a) => a.canceled).map((a) => a.job);
    if (!startedJobs.length && !canceledJobs.length) throw httpError(409, "选中的任务都不是待启动状态");
    sendJson(res, 200, {
      jobs: [...startedJobs, ...canceledJobs].map(publicJob),
      started: startedJobs.length,
      canceled: canceledJobs.length,
      skipped: applied.filter((a) => a.skipped).length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/download-batch") {
    const body = await readJson(req);
    await downloadBatchResult(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/export-source") {
    const body = await readJson(req);
    await exportSourceAccounts(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/delete-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const emails = [...new Set(selected.map((job) => job.email.toLowerCase()))];
    await Promise.all(emails.map((email) => withEmailJobLock(email, () => deleteJobsByEmail(email))));
    sendJson(res, 200, { deleted: emails.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/reauthorize-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const unsupported = selected.find(
      (job) => !["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    );
    if (unsupported) throw httpError(409, `${unsupported.email} 当前仍在进行中，不能重新授权`);
    await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (job.status === "completed") await regenerateJob(job, body);
      else await retryJob(job, body);
    })));
    sendJson(res, 200, { jobs: selected.map(publicJob), started: selected.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/relogin-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canForceRelogin(job)) return null;
      await forceReloginJob(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能重新登录");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/setup-2fa-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canSetupTotp(job)) return null;
      await startTotpSetup(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号都不能设置 2FA");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/add-password-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canAddPassword(job)) return null;
      await startPasswordAdd(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能添加密码");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/cancel-all") {
    const canceled = await cancelAllJobs();
    sendJson(res, 200, { canceled });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/groups") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const payload = await requestSub2Api(config, "/api/v1/admin/groups/all?platform=openai");
    const groups = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    sendJson(res, 200, {
      groups: groups
        .filter((group) => group && Number.isInteger(Number(group.id)))
        .map((group) => ({
          id: Number(group.id),
          name: String(group.name || `号池 ${group.id}`),
          status: String(group.status || "active"),
        })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/options") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const [groupPayload, proxyPayload] = await Promise.all([
      requestSub2Api(config, "/api/v1/admin/groups/all?platform=openai"),
      requestSub2Api(config, "/api/v1/admin/proxies/all"),
    ]);
    const groups = Array.isArray(groupPayload) ? groupPayload : Array.isArray(groupPayload?.data) ? groupPayload.data : [];
    const proxies = Array.isArray(proxyPayload) ? proxyPayload : Array.isArray(proxyPayload?.data) ? proxyPayload.data : [];
    sendJson(res, 200, {
      groups: groups
        .filter((group) => group && Number.isInteger(Number(group.id)))
        .map((group) => ({ id: Number(group.id), name: String(group.name || `号池 ${group.id}`), status: String(group.status || "active") })),
      proxies: proxies
        .filter((proxy) => proxy && Number.isInteger(Number(proxy.id)))
        .map((proxy) => ({
          id: Number(proxy.id),
          name: String(proxy.name || `代理 ${proxy.id}`),
          protocol: String(proxy.protocol || ""),
          host: String(proxy.host || ""),
          port: Number(proxy.port || 0),
          ipAddress: String(proxy.ip_address || ""),
          status: String(proxy.status || "active"),
        })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/upload") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const selected = resolveSelectedJobs(body.ids);
    const downloadable = selected.filter((job) => job.resultSaved);
    if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");
    const payload = await buildSub2ApiUploadPayload(downloadable);
    const idempotencyKey = `tosub2-upload-${crypto.randomUUID()}`;

    // Step 2: resolve a proxy_id for each account.
    //  - batch mode: create a shared list of proxies, then hand each proxy up to
    //    `limitPerIp` accounts in sequence before moving to the next proxy.
    //  - single mode: create each account's own registration proxy and link it.
    const proxyLink = body.proxyLink && typeof body.proxyLink === "object" ? body.proxyLink : null;
    const batchMode = proxyLink?.mode === "batch";
    let proxiesCreated = 0;
    let unassigned = 0;
    let proxyIdForAccount;
    if (batchMode) {
      const limitPerIp = Math.max(1, Math.floor(Number(proxyLink.limitPerIp) || 15));
      const batchObjs = parseProxyList(proxyLink.proxies);
      if (batchObjs.length === 0) throw httpError(400, "批量代理列表为空或格式不正确");

      // Keep each account's own registration proxy when it is still alive; only
      // accounts without a (working) proxy draw from the batch list (15/IP).
      const oldProxyByKey = new Map();
      for (const p of payload.proxies) if (p?.proxy_key) oldProxyByKey.set(p.proxy_key, p);
      const liveOldKeys = new Set();
      for (const [key, p] of oldProxyByKey) {
        const check = await checkProxyExitIp(proxyObjToUrl(p));
        if (check.ok) liveOldKeys.add(key);
      }
      const oldIdByKey = new Map();
      for (const key of liveOldKeys) {
        const ids = await createSub2ApiProxyList(config, [oldProxyByKey.get(key)]);
        if (ids[0]) { oldIdByKey.set(key, ids[0]); proxiesCreated += 1; }
      }
      const batchProxyIds = await createSub2ApiProxyList(config, batchObjs);
      proxiesCreated += batchProxyIds.length;

      let fill = 0;
      proxyIdForAccount = (_index, account) => {
        const key = account.proxy_key;
        if (key && oldIdByKey.has(key)) return oldIdByKey.get(key); // old IP still works → keep it
        const slot = Math.floor(fill / limitPerIp);
        fill += 1;
        return slot < batchProxyIds.length ? batchProxyIds[slot] : undefined;
      };
    } else {
      const { idByKey, created } = await createSub2ApiProxyIds(config, payload.proxies);
      proxiesCreated = created;
      proxyIdForAccount = (_index, account) => (account.proxy_key ? idByKey.get(account.proxy_key) : undefined);
    }

    // Step 3: batch-create accounts, each carrying its proxy_id and group_ids.
    const groupIds = config.groupIds.length ? config.groupIds : [3];
    const accounts = payload.accounts.map((account, index) => {
      const { proxy_key: _proxyKey, ...accountData } = account;
      const credentials = { ...(account.credentials || {}) };
      const extra = {
        ...(account.extra && typeof account.extra === "object" ? account.extra : {}),
        codex_fingerprint_mode: config.codexFingerprintMode,
      };
      if (config.modelWhitelist.length) {
        credentials.model_mapping = Object.fromEntries(config.modelWhitelist.map((model) => [model, model]));
      }
      const resolvedProxyId = proxyIdForAccount(index, account);
      if (!resolvedProxyId && !config.proxyId) unassigned += 1;
      return {
        ...accountData,
        credentials,
        extra,
        status: "active",
        schedulable: true,
        group_ids: groupIds,
        ...(resolvedProxyId ? { proxy_id: resolvedProxyId } : (config.proxyId ? { proxy_id: config.proxyId } : {})),
        ...(config.concurrency !== null ? { concurrency: config.concurrency } : {}),
        ...(config.loadFactor !== null ? { load_factor: config.loadFactor } : {}),
        ...(config.priority !== null ? { priority: config.priority } : {}),
        confirm_mixed_channel_risk: false,
      };
    });
    const result = await requestSub2Api(config, "/api/v1/admin/accounts/batch", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ accounts }),
    });

    // Tag every uploaded account so the console can tell at a glance which
    // accounts have already been pushed to a Sub2API backend.
    const uploadedAt = new Date().toISOString();
    for (const job of downloadable) {
      job.sub2apiUploadedAt = uploadedAt;
      job.sub2apiUploadedBaseUrl = config.baseUrl;
      touch(job);
      await saveJobMetadata(job);
    }

    sendJson(res, 200, {
      selected: selected.length,
      uploaded: downloadable.length,
      skipped: selected.length - downloadable.length,
      groupIds,
      proxiesCreated,
      unassigned,
      result,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/backfill-tags") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const result = await backfillSub2ApiUploadTags(config);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sub2api/monitor") {
    sendJson(res, 200, publicSub2ApiMonitorState());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/monitor") {
    const body = await readJson(req);
    if (body.enabled) {
      const config = normalizeSub2ApiConfig(body.config);
      sub2ApiMonitorConfig = { ...config, enabled: true };
    } else {
      sub2ApiMonitorConfig = null;
    }
    sub2ApiMonitorState.lastError = null;
    await persistSub2ApiMonitorConfiguration();
    scheduleSub2ApiMonitor();
    sendJson(res, 200, publicSub2ApiMonitorState());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/monitor/check") {
    if (!sub2ApiMonitorConfig?.enabled) throw httpError(409, "请先启用 Sub2API 号池监控");
    const result = await runSub2ApiMonitor("manual");
    sendJson(res, 200, { ...publicSub2ApiMonitorState(), result });
    return;
  }

  // SMS cost ledger: itemized number purchases with outcome (charged / refunded / held).
  if (req.method === "GET" && requestUrl.pathname === "/api/sms-costs") {
    const rows = [];
    const totals = { charged: 0, chargedCount: 0, refundedCount: 0, heldCount: 0, currency: "$" };
    for (const job of listUniqueJobs()) {
      for (const ev of (Array.isArray(job.smsCostEvents) ? job.smsCostEvents : [])) {
        rows.push({
          email: job.email,
          provider: ev.provider || null,
          serviceLabel: ev.serviceLabel || null,
          number: ev.number || null,
          price: typeof ev.price === "number" ? ev.price : null,
          currency: ev.currency || "$",
          status: ev.status,
          at: ev.at || null,
          resolvedAt: ev.resolvedAt || null,
        });
        if (ev.status === "charged") { totals.charged += Number(ev.price) || 0; totals.chargedCount += 1; }
        else if (ev.status === "refunded") totals.refundedCount += 1;
        else if (ev.status === "held") totals.heldCount += 1;
      }
    }
    rows.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    totals.charged = Math.round(totals.charged * 1e6) / 1e6;
    sendJson(res, 200, { rows, totals });
    return;
  }

  // Public SMSBower price catalog (country -> quality/rank positions) for the picker.
  // Phone-number usage filter: configurable per-number reuse cap + ledger stats.
  // The cap and the ledger are stored on this machine (not the browser).
  if (requestUrl.pathname === "/api/sms/number-usage") {
    if (req.method === "GET") {
      sendJson(res, 200, phoneLedgerStats());
      return;
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      const maxUses = setPhoneMaxUses(body.maxUses);
      sendJson(res, 200, { ...phoneLedgerStats(), maxUses });
      return;
    }
  }

  // Console UI settings (proxy list, SMS / mail / Sub2API config, language) — kept
  // in the database so they follow the server instead of one browser's localStorage.
  if (requestUrl.pathname === "/api/settings") {
    if (req.method === "GET") {
      sendJson(res, 200, { settings: readUiSettings() });
      return;
    }
    if (req.method === "PUT") {
      const body = await readJson(req);
      writeUiSettings(body.settings);
      // A looser proxy per-IP limit may release registrations that are waiting in the queue.
      scheduleQueuedJobs();
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sms-providers/smsbower/catalog") {
    const serviceId = /^\d{1,6}$/.test(requestUrl.searchParams.get("serviceId") || "")
      ? requestUrl.searchParams.get("serviceId")
      : "247";
    const catalog = await fetchSmsBowerCatalogCached(serviceId);
    if (!catalog) throw httpError(502, "无法获取 SMSBower 价格目录");
    sendJson(res, 200, catalog);
    return;
  }

  const providerOptionsMatch = /^\/api\/sms-providers\/([a-z0-9_-]+)\/options$/.exec(requestUrl.pathname);
  if (req.method === "POST" && providerOptionsMatch) {
    const body = await readJson(req);
    let smsClient;
    try {
      smsClient = createSmsProvider(providerOptionsMatch[1], body.config, {
        lubanApiBase: process.env.LUBAN_SMS_API_BASE,
        smsBowerApiBase: process.env.SMSBOWER_API_BASE,
        viOtpApiBase: process.env.VIOTP_API_BASE,
        smsCodeApiBase: process.env.SMSCODE_API_BASE,
      });
      if (!smsClient.listNumberOptions) throw httpError(400, "该接码平台不支持价格查询");
      const options = await smsClient.listNumberOptions();
      sendJson(res, 200, { providerId: smsClient.id, options });
    } catch (error) {
      if (error?.status) throw error;
      throw httpError(502, safeSmsProviderError(error, body.config?.apiKey));
    }
    return;
  }

  const match = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(input|cancel|retry|regenerate|relogin|setup-2fa|add-password|change-proxy|reconnect-proxy|logs|download|sms-number|luban-number))?$/.exec(requestUrl.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const job = jobs.get(match[1]);
  if (!job) {
    sendJson(res, 404, { error: "Login flow not found" });
    return;
  }

  const action = match[2];
  if (req.method === "GET" && action === "logs") {
    sendJson(res, 200, { id: job.id, logs: job.logs });
    return;
  }
  if (req.method === "GET" && action === "download") {
    await downloadResult(res, job);
    return;
  }
  if (req.method === "POST" && ["sms-number", "luban-number"].includes(action)) {
    const body = await readJson(req);
    const providerId = action === "luban-number" ? "luban" : body.providerId;
    const config = action === "luban-number"
      ? { apiKey: body.apiKey, serviceId: body.serviceId }
      : body.config;
    await withEmailJobLock(job.email, () => acquireSmsNumber(job, providerId, config));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "cancel") {
    await withEmailJobLock(job.email, () => cancelJob(job));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "retry") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => retryJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "regenerate") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => regenerateJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "relogin") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => forceReloginJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "setup-2fa") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startTotpSetup(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "add-password") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startPasswordAdd(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "input") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => submitJobInput(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "change-proxy") {
    const body = await readJson(req);
    const result = await withEmailJobLock(job.email, () => changeJobProxy(job, body));
    sendJson(res, result.status || 200, { ...result.payload, job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "reconnect-proxy") {
    const result = await withEmailJobLock(job.email, () => reconnectJobProxy(job));
    sendJson(res, result.status || 200, { ...result.payload, job: publicJob(job) });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function sendJobsPage(res, requestedPage, emailFilter = null, search = "") {
  await syncCompletedOutputs();
  // Sắp xếp theo thời điểm tạo, mới nhất lên đầu (cách sắp xếp cũ). Không dồn tài khoản "Hoàn tất"
  // xuống cuối — chúng vẫn cần được tải lên Sub2API nên phải giữ nguyên vị trí theo thứ tự tạo.
  const allJobs = listUniqueJobs();
  const emailSet = emailFilter?.length ? new Set(emailFilter) : null;
  const term = String(search || "").trim().toLowerCase();
  let visibleJobs = emailSet
    ? allJobs.filter((job) => emailSet.has(job.email.toLowerCase()))
    : allJobs;
  // Bulk search: text holding several emails (e.g. a pasted account table) matches exactly those
  // emails and is returned on one page so the whole pasted list is visible at once.
  const searchEmails = extractSearchEmails(term);
  const bulkSearch = searchEmails.length > 1;
  let missing = [];
  if (bulkSearch) {
    const wanted = new Set(searchEmails);
    visibleJobs = visibleJobs.filter((job) => wanted.has(job.email.toLowerCase()));
    const found = new Set(visibleJobs.map((job) => job.email.toLowerCase()));
    missing = searchEmails.filter((email) => !found.has(email));
  } else if (term) {
    // Quick email search (substring, across every page), combinable with the list filter.
    visibleJobs = visibleJobs.filter((job) => job.email.toLowerCase().includes(term));
  }
  const total = visibleJobs.length;
  const pageSize = bulkSearch ? Math.max(PAGE_SIZE, total) : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  sendJson(res, 200, {
    jobs: visibleJobs.slice(start, start + pageSize).map(publicJob),
    selection: visibleJobs.map(publicSelectionJob),
    pagination: { page, pageSize, total, totalPages, totalAll: allJobs.length },
    filter: {
      active: Boolean(emailSet) || Boolean(term),
      requested: emailFilter?.length || 0,
      matched: total,
      search: bulkSearch ? null : term || null,
      searchEmails: bulkSearch ? searchEmails.length : 0,
      missing,
    },
    stats: {
      active: allJobs.filter(occupiesActiveSlot).length,
      queued: allJobs.filter((job) => job.status === "queued").length,
      completed: allJobs.filter((job) => job.status === "completed").length,
      idle: allJobs.filter((job) => job.status === "idle").length,
    },
  });
}

// Pulls every distinct email out of free-form search text (lower-cased, capped at MAX_BATCH_JOBS).
function extractSearchEmails(text) {
  const matches = String(text || "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || [];
  return [...new Set(matches)].slice(0, MAX_BATCH_JOBS);
}

function normalizeEmailFilter(value) {
  if (!Array.isArray(value) || value.length === 0) throw httpError(400, "请至少输入一个筛选邮箱");
  if (value.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多筛选 ${MAX_BATCH_JOBS} 个邮箱`);
  const unique = new Set();
  value.forEach((item, index) => {
    const email = String(item || "").trim().toLowerCase();
    if (!isEmail(email)) throw httpError(400, `第 ${index + 1} 个筛选邮箱格式错误`);
    unique.add(email);
  });
  return [...unique];
}

async function startJob(email, credentials = {}, proxyUrl = null, options = {}) {
  const staged = Boolean(options.staged);
  clearEmailDeactivated(email); // operator is re-registering this mailbox → clear any stale deactivated flag
  const { loginMode, mailApiUrl, mailRequestBody, password, totpSecret } = normalizeLoginCredentials(credentials);
  await saveStoredLoginCredentials(email, { password, totpSecret, proxyUrl });
  if (proxyUrl) recordProxyUsage(proxyUrl, email);
  const id = crypto.randomUUID();
  const outputDir = path.join(OUTPUT_ROOT, id);
  const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
  const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
  const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
  const passwordAddResultPath = path.join(outputDir, PASSWORD_ADD_RESULT_FILENAME);
  await fs.mkdir(outputDir, { recursive: true });

  const createdAt = new Date().toISOString();
  const job = {
    id,
    email,
    status: staged ? "idle" : "queued",
    prompt: staged ? "待启动，选中后点击“开始运行”即可加入队列" : "已加入任务队列",
    createdAt,
    updatedAt: createdAt,
    lastOperationAt: createdAt,
    lastOperationType: "initial_authorization",
    completedAt: null,
    outputPath,
    checkpointPath,
    totpResultPath,
    passwordAddResultPath,
    logs: "",
    lastError: null,
    child: null,
    parserTail: "",
    resultSaved: false,
    loginMode,
    password,
    totpSecret,
    hasPasswordCredential: Boolean(password),
    hasTotpCredential: Boolean(totpSecret),
    proxyUrl,
    mailApiUrl,
    mailRequestBody,
    mailSeenCandidateKeys: new Set(),
    mailCandidateCounts: new Map(),
    mailStatus: mailApiUrl ? "baseline" : "manual",
    mailApiError: null,
    mailPollRunning: false,
    mailPollToken: null,
    mailOtpRequestedAt: null,
    currentPhone: null,
    phoneError: null,
    restartRequired: false,
    attempt: 1,
    runId: null,
    runMode: null,
    queuedMode: "full",
    queuedAt: new Date().toISOString(),
    queuedStartPrompt: "正在建立登录会话",
    tlsProfile: NEW_ACCOUNT_TLS_PROFILE,
    directTlsFallbackAttempted: false,
    fallbackInProgress: false,
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpSetupResumesAuthorization: false,
    passwordAddError: null,
    passwordAddedAt: null,
    pendingNewPassword: null,
    passwordAddResumesAuthorization: false,
    loginCheckpointAvailable: false,
    totpKnownEnabled: false,
    totpSetupAttempt: 0,
    totpResultLoading: false,
    proxyRiskRetryCount: 0,
    proxyConnectionFailureCount: 0,
    proxyRiskRestarting: false,
    proxyConnectionError: false,
    failedProxyLabel: null,
    registrationSucceeded: false,
    registeredAt: null,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
    queueRunId: null,
    lastAuthAutomated: false,
    lastAuthAutomationReason: "尚未完成可验证的全自动登录",
    lastAuthAutomatedAt: null,
    lastAuthRequirements: null,
    authAutomationAttempt: null,
    autoRepairBlocked: false,
    autoRepairBlockedReason: null,
    autoRepairBlockedAt: null,
    autoRepairLastAttemptAt: null,
    autoRepairLastSuccessAt: null,
    autoRepairLastError: null,
    autoRepairPendingAccountIds: [],
    autoRepairPendingBackend: null,
    autoRepairOperation: null,
    sub2apiUploadedAt: null,
    sub2apiUploadedBaseUrl: null,
    ...newSmsState(),
  };
  beginAuthorizationAutomationAttempt(job, "initial");
  jobs.set(id, job);
  await saveJobMetadata(job);
  // Staged ("idle") jobs sit in the run list without consuming a slot; they only
  // enter the queue once the user starts them, so skip scheduling here.
  if (!staged) scheduleQueuedJobs();
  return job;
}

function scheduleQueuedJobs() {
  if (shuttingDown || queueSchedulingPaused) return;
  let availableSlots = MAX_ACTIVE_JOBS - [...jobs.values()].filter(occupiesActiveSlot).length;
  if (availableSlots <= 0) return;
  const queuedJobs = [...jobs.values()]
    .filter((job) => job.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)));
  const { windowMs, maxPerWindow } = proxySignupLimit();
  const throttleOn = windowMs > 0 && maxPerWindow > 0;
  // Keep one entry more than the limit so a job is never held back by its own earlier start.
  const keepPerKey = maxPerWindow + 1;
  const signupActivity = throttleOn ? proxySignupActivityByKey(keepPerKey) : null;
  let nextCooldownEndsAt = Infinity;
  for (const job of queuedJobs) {
    const mode = job.queuedMode || "full";
    const cooldownKey = signupActivity ? signupCooldownHost(job, mode) : null;
    if (cooldownKey) {
      const now = Date.now();
      // Other accounts' recent signups through this exit IP, newest first, still inside the window.
      const within = (signupActivity.get(cooldownKey) || [])
        .filter((entry) => entry.id !== job.id && now - entry.at < windowMs)
        .sort((a, b) => b.at - a.at);
      if (within.length >= maxPerWindow) {
        // The window is full; wait until the oldest start that still blocks us leaves it.
        const readyAt = within[maxPerWindow - 1].at + windowMs;
        if (readyAt > now) {
          // Stays queued without taking a slot, so jobs on other IPs behind it still start.
          job.proxyCooldownUntil = readyAt;
          nextCooldownEndsAt = Math.min(nextCooldownEndsAt, readyAt);
          continue;
        }
      }
      job.signupLaunchedAt = now;
      const others = (signupActivity.get(cooldownKey) || []).filter((entry) => entry.id !== job.id);
      signupActivity.set(cooldownKey, [{ id: job.id, at: now }, ...others].slice(0, keepPerKey));
    }
    job.proxyCooldownUntil = null;
    const queueRunId = crypto.randomUUID();
    job.queueRunId = queueRunId;
    job.status = mode === "refresh"
      ? "refreshing"
      : mode === "totp_setup"
        ? "totp_starting"
        : mode === "password_add"
          ? "password_add_starting"
          : "starting";
    job.prompt = job.queuedStartPrompt || (mode === "refresh"
      ? "正在使用已有刷新令牌直接生成新授权"
      : mode === "totp_setup"
        ? "正在重新验证账号并准备设置 2FA"
        : mode === "password_add"
          ? "正在重新验证账号并准备添加密码"
          : "正在建立登录会话");
    job.queuedAt = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    void prepareAndLaunchJob(job, mode, queueRunId);
    availableSlots -= 1;
    if (availableSlots <= 0) break;
  }
  if (nextCooldownEndsAt !== Infinity) scheduleProxyCooldownWake(nextCooldownEndsAt);
}

// How many brand-new registrations a fixed IP may launch per rolling window. The proxy dialog's
// maxPerMinute overrides the default; 0 (or blank) removes the throttle entirely.
function proxySignupLimit() {
  let maxPerWindow = PROXY_SIGNUP_MAX_PER_WINDOW;
  try {
    const raw = JSON.parse(settingsDao.get(PROXY_LINK_SETTING_DB_KEY) || "null")?.maxPerMinute;
    if (raw !== undefined && raw !== null && raw !== "") {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0) maxPerWindow = Math.min(Math.trunc(value), MAX_PROXY_SIGNUP_MAX_PER_WINDOW);
    }
  } catch {}
  return { windowMs: PROXY_SIGNUP_WINDOW_MS, maxPerWindow };
}

// The cool-down only concerns a brand-new registration; a rotating proxy exits through another IP each time.
function signupCooldownHost(job, mode) {
  if (mode !== "full" || job.registrationSucceeded) return null;
  return signupExitKey(job);
}

function fixedProxyHost(proxyUrl) {
  if (!proxyUrl || proxySupportsSessionRotation(proxyUrl)) return null;
  return parseProxyUrlForSub2Api(proxyUrl)?.host || null;
}

// Throttle identity for a signup: the proxy's real exit IP once known, so a changed or reset IP
// starts its own window (and a domain that rotates every request spreads across IPs and never
// trips the limit). Falls back to the configured host until the exit IP is probed; null = exempt
// (rotating sid/kookeey proxy, or no proxy).
function signupExitKey(job) {
  const host = fixedProxyHost(job.proxyUrl);
  if (!host) return null;
  if (job.exitIp) return job.exitIp;
  const cached = proxyExitIpCache.get(host);
  if (cached?.result?.ok && cached.result.ip && Date.now() - cached.at < PROXY_EXIT_IP_TTL_MS) return cached.result.ip;
  return host;
}

// Non-blocking: probe the proxy's current exit IP and stamp it on the job, warming the shared
// cache so later queued-job throttle decisions on the same host key off the real IP too.
function probeSignupExitIp(job) {
  const host = fixedProxyHost(job.proxyUrl);
  if (!host) return; // rotating sid/kookeey proxy or no proxy: not keyed by a fixed exit IP
  void checkProxyExitIp(job.proxyUrl).then((res) => {
    if (res?.ok && res.ip) {
      job.exitIp = res.ip;
      proxyExitIpCache.set(host, { at: Date.now(), result: res });
    }
  }).catch(() => {});
}

// Per exit-IP key: the jobs that most recently sent signup traffic through it, newest first.
// One more than the per-window limit is kept so a job retrying on its own IP is only ever held
// back by other accounts, never by its own earlier start.
function proxySignupActivityByKey(keepPerKey) {
  const byKey = new Map();
  for (const job of jobs.values()) {
    const at = Math.max(job.signupLaunchedAt || 0, job.mailOtpRequestedAt || 0, Date.parse(job.registeredAt || "") || 0);
    const key = at ? signupExitKey(job) : null;
    if (!key) continue;
    const recent = [...(byKey.get(key) || []), { id: job.id, at }].sort((a, b) => b.at - a.at);
    byKey.set(key, recent.slice(0, keepPerKey));
  }
  return byKey;
}

function scheduleProxyCooldownWake(at) {
  if (proxyCooldownWakeTimer) clearTimeout(proxyCooldownWakeTimer);
  proxyCooldownWakeTimer = setTimeout(() => {
    proxyCooldownWakeTimer = null;
    scheduleQueuedJobs();
  }, Math.max(0, at - Date.now()) + 25);
  proxyCooldownWakeTimer.unref?.();
}

async function prepareAndLaunchJob(job, mode, queueRunId) {
  try {
    if (["full", "totp_setup", "password_add"].includes(mode) && job.mailApiUrl) await loadMailboxBaseline(job);
    if (!isActive(job.status) || job.status === "queued" || job.queueRunId !== queueRunId) return;
    launchJob(job, { mode });
  } catch (error) {
    if (mode === "totp_setup") {
      restoreTotpSetupFailure(job, `准备 2FA 设置失败：${error.message}`);
    } else if (mode === "password_add") {
      restorePasswordAddFailure(job, `准备添加密码失败：${error.message}`);
    } else {
      failJob(job, `准备登录任务失败：${error.message}`);
    }
    scheduleQueuedJobs();
  }
}

function enqueueJob(job, mode, startPrompt) {
  job.queueRunId = null;
  job.status = "queued";
  job.prompt = "已加入任务队列";
  job.queuedMode = mode;
  job.queuedAt = new Date().toISOString();
  job.queuedStartPrompt = startPrompt;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

function launchJob(job, options = {}) {
  const mode = options.mode || "full";
  if (mode === "full" && !job.authAutomationAttempt) {
    beginAuthorizationAutomationAttempt(job, "login");
  }
  // Learn this signup's real exit IP in the background so the per-IP throttle (and the
  // registration ledger) key off the IP OpenAI actually sees, not the proxy host. A domain
  // that rotates every request yields a different IP each launch and so never trips the limit.
  if (mode === "full") probeSignupExitIp(job);
  const runId = crypto.randomUUID();
  job.runId = runId;
  job.runMode = mode;
  job.mailOtpRequestedAt = null;
  const args = mode === "refresh"
    ? [
        PROTOCOL_SCRIPT,
        "--refresh-sub2api",
        job.outputPath,
        "--sub2api-out",
        job.outputPath,
        "--verbose",
      ]
    : mode === "totp_setup"
      ? [
          PROTOCOL_SCRIPT,
          "--email",
          job.email,
          "--setup-totp",
          "--totp-result",
          job.totpResultPath,
          ...(job.totpSetupResumesAuthorization ? ["--resume-checkpoint", job.checkpointPath] : []),
          "--verbose",
        ]
    : mode === "password_add"
      ? [
          PROTOCOL_SCRIPT,
          "--email",
          job.email,
          "--add-password",
          "--password-add-result",
          job.passwordAddResultPath,
          ...(job.passwordAddResumesAuthorization ? ["--resume-checkpoint", job.checkpointPath] : []),
          "--verbose",
        ]
    : [
        PROTOCOL_SCRIPT,
        "--email",
        job.email,
        "--output-mode",
        "sub2api",
        "--sub2api-out",
        job.outputPath,
        "--checkpoint",
        job.checkpointPath,
        "--resume-checkpoint",
        job.checkpointPath,
        "--verbose",
      ];
  const child = spawn(process.execPath, args, {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      CHATGPT_LOGIN_PASSWORD: job.password || "",
      CHATGPT_TOTP_SECRET: job.totpSecret || "",
      CHATGPT_NEW_PASSWORD: mode === "password_add" ? job.pendingNewPassword || "" : "",
      CHATGPT_PROXY_URL: job.proxyUrl || "",
      CHATGPT_PROXY_MAX_ATTEMPTS: String(Math.max(0, MAX_PROXY_RISK_RETRIES - (job.proxyRiskRetryCount || 0))),
      // Per-account fingerprint: old accounts resolve to chrome146, new accounts to
      // their stamped chrome150 (see resolveJobTlsProfile). Always concrete so it
      // overrides any inherited global TOSUB2_TLS_PROFILE from the environment.
      TOSUB2_TLS_PROFILE: String(options.tlsProfile || resolveJobTlsProfile(job)),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  job.child = child;

  child.stdout.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    void withEmailJobLock(job.email, async () => {
      if (job.runId !== runId) return;
      if (mode === "totp_setup") restoreTotpSetupFailure(job, `无法启动 2FA 设置进程：${error.message}`);
      else if (mode === "password_add") restorePasswordAddFailure(job, `无法启动添加密码进程：${error.message}`);
      else failJob(job, `无法启动登录进程：${error.message}`);
    });
  });
  child.on("close", (code, signal) => {
    void withEmailJobLock(job.email, () => handleChildClose(job, { code, signal, mode, runId }))
      .catch((error) => {
        handleChildCloseFailure(job, mode, runId, error);
      });
  });
}

async function handleChildClose(job, { code, signal, mode, runId }) {
  if (job.runId !== runId) return;
  stopMailPolling(job);
  job.child = null;
  if (mode === "totp_setup") {
    await finishTotpSetup(job, code, signal);
    scheduleQueuedJobs();
    return;
  }
  if (mode === "password_add") {
    await finishPasswordAdd(job, code, signal);
    scheduleQueuedJobs();
    return;
  }
  if (["canceled", "reauth_required"].includes(job.status)) {
    await finishSub2ApiAutoRepairFailure(job);
    scheduleQueuedJobs();
    return;
  }
  if (code === 0 && job.resultSaved && (await fileExists(job.outputPath))) {
    if (mode === "full") completeAuthorizationAutomationAttempt(job);
    markRegistrationSucceeded(job);
    job.loginCheckpointAvailable = false;
    job.status = "completed";
    job.prompt = "授权完成，可以下载导入文件";
    job.completedAt = new Date().toISOString();
    touch(job);
    await saveJobMetadata(job);
    await finishSub2ApiAutoRepairSuccess(job);
    scheduleQueuedJobs();
    return;
  }
  if (job.status !== "failed") {
    // Safety net: if the fatal "[error]" line slipped past the streaming
    // detector (e.g. split across the parser tail), a permanent account closure
    // must still fail the job rather than be offered as a resumable checkpoint.
    const fatalError = extractFatalLoginError(job.logs);
    if (fatalError && isPermanentAccountFailure(fatalError)) {
      failAccountClosedDuringLogin(job, fatalError);
    } else if (await fileExists(job.checkpointPath)) {
      markResumeAvailable(job, signal ? `登录进程被 ${signal} 终止` : "登录流程中断");
    } else {
      failJob(job, signal ? `登录进程被 ${signal} 终止` : `登录进程退出，代码 ${code ?? "未知"}`);
    }
  }
  await finishSub2ApiAutoRepairFailure(job);
  scheduleQueuedJobs();
}

function handleChildCloseFailure(job, mode, runId, error) {
  if (job.runId !== runId && !(["totp_setup", "password_add"].includes(mode) && job.runId === null)) return;
  const message = `收尾处理失败：${error.message}`;
  if (mode === "totp_setup") {
    job.status = "completed";
    job.prompt = "原授权文件仍然可用，2FA 密钥尚未完成安全保存";
    job.totpSetupError = `${message}；已保留 2FA 结果文件，请重试保存`;
    job.runMode = null;
    job.runId = null;
  } else if (mode === "password_add") {
    restorePasswordAddFailure(job, message);
  } else {
    failJob(job, message);
  }
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function retryJob(job, options = {}) {
  if (!["failed", "canceled", "reauth_required", "resume_available"].includes(job.status)) {
    throw httpError(409, "当前任务不需要重新授权");
  }
  const retryingSecurityCheck = Boolean(job.securityCheckRequired);
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    const persisted = await saveStoredLoginCredentials(job.email, job);
  }
  const resumingCheckpoint = job.status === "resume_available"
    || (retryingSecurityCheck && await fileExists(job.checkpointPath));
  stopMailPolling(job);
  if (resumingCheckpoint) stopSmsPolling(job);
  else releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  const startPrompt = retryingSecurityCheck && resumingCheckpoint
    ? "正在使用已有登录状态重试手机号绑定"
    : "正在重新建立登录会话";
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = resumingCheckpoint ? (job.currentPhone || job.smsNumber) : null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  clearAutoRepairBlock(job);
  job.autoRepairOperation = null;
  job.autoRepairPendingAccountIds = [];
  job.autoRepairPendingBackend = null;
  beginAuthorizationAutomationAttempt(job, "manual_retry");
  recordJobOperation(job, resumingCheckpoint ? "resume" : "reauthorize");
  appendJobLog(
    job,
    retryingSecurityCheck
      ? `\n[retry] 开始第 ${job.attempt} 次手动重试；优先复用已有登录检查点。\n`
      : `\n[retry] 开始第 ${job.attempt} 次授权登录。\n`,
  );
  enqueueJob(job, "full", startPrompt);
}

async function regenerateJob(job, options = {}) {
  if (job.status !== "completed" || !job.resultSaved) {
    throw httpError(409, "只能为已经完成的任务重新生成授权");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  releaseSmsNumber(job, "idle");
  job.restartRequired = false;
  job.completedAt = null;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  recordJobOperation(job, "reauthorize");
  appendJobLog(job, `\n[refresh] 第 ${job.attempt} 次生成：优先使用已有刷新令牌。\n`);
  enqueueJob(job, "refresh", "正在使用已有刷新令牌直接生成新授权");
}

async function forceReloginJob(job, options = {}, context = {}) {
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  await reloadMissingJobCredentials(job);
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  await Promise.all([
    removePrivateFile(job.checkpointPath),
    removePrivateFile(job.totpResultPath),
  ]);
  job.loginCheckpointAvailable = false;
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  job.attempt += 1;
  if (!context.autoRepair) {
    clearAutoRepairBlock(job);
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = null;
  }
  job.autoRepairOperation = context.autoRepair || null;
  if (context.autoRepair) {
    job.autoRepairLastAttemptAt = new Date().toISOString();
    job.autoRepairLastError = null;
    job.autoRepairPendingAccountIds = [...new Set(context.autoRepair.accountIds || [])];
    job.autoRepairPendingBackend = context.autoRepair.backend || null;
  }
  beginAuthorizationAutomationAttempt(job, context.autoRepair ? "sub2api_monitor" : "manual_relogin");
  recordJobOperation(job, context.autoRepair ? "automatic_relogin" : "relogin");
  appendJobLog(job, `\n[relogin] 第 ${job.attempt} 次授权：跳过刷新令牌并强制重新登录。\n`);
  if (job.hasTotpCredential && !job.totpSecret) {
    appendJobLog(job, "[mfa] 本地未能读取已记录的 2FA 密钥，遇到 2FA 时需要手动输入验证码。\n");
  }
  enqueueJob(job, "full", "正在强制重新登录并完成授权");
}

async function reloadMissingJobCredentials(job) {
  if (
    (job.password || !job.hasPasswordCredential)
    && (job.totpSecret || !job.hasTotpCredential)
    && job.proxyUrl
  ) return;
  const stored = await loadStoredLoginCredentials(job.email);
  job.password ||= stored.password;
  job.totpSecret ||= stored.totpSecret;
  job.proxyUrl ||= stored.proxyUrl;
  if (job.password) job.hasPasswordCredential = true;
  if (job.totpSecret) job.hasTotpCredential = true;
  if (stored.password || stored.totpSecret || stored.proxyUrl) {
    await saveStoredLoginCredentials(job.email, job);
  }
}

async function startTotpSetup(job, options = {}) {
  if (!canSetupTotp(job)) {
    throw httpError(409, "只能为已完成授权，或已保存邮箱登录检查点且尚未设置 2FA 的账号设置 2FA");
  }
  if (job.totpSecret || job.hasTotpCredential) {
    throw httpError(409, "该账号已经保存了 2FA 密钥，无需重复设置");
  }
  if (job.totpKnownEnabled) {
    throw httpError(409, "该账号已经启用 2FA，但本地没有它的原始密钥，无法重复创建");
  }
  const resumeAuthorization = !job.resultSaved;
  if (resumeAuthorization && !(await fileExists(job.checkpointPath))) {
    job.loginCheckpointAvailable = false;
    throw httpError(409, "邮箱登录检查点已丢失，请先重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.currentPhone = null;
  job.phoneError = null;
  await removePrivateFile(job.totpResultPath);
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.totpSetupAttempt = (job.totpSetupAttempt || 0) + 1;
  job.totpSetupResumesAuthorization = resumeAuthorization;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.lastError = null;
  job.parserTail = "";
  recordJobOperation(job, "setup_2fa");
  appendJobLog(job, `\n[2fa] 开始第 ${job.totpSetupAttempt} 次 2FA 设置，原授权文件保持不变。\n`);
  enqueueJob(job, "totp_setup", "正在重新验证账号并准备设置 2FA");
}

async function startPasswordAdd(job, options = {}) {
  if (!canAddPassword(job)) {
    throw httpError(409, "只能为已完成授权，或已保存邮箱登录检查点且尚未保存密码的账号添加密码");
  }
  const resumeAuthorization = !job.resultSaved;
  if (resumeAuthorization && !(await fileExists(job.checkpointPath))) {
    job.loginCheckpointAvailable = false;
    throw httpError(409, "邮箱登录检查点已丢失，请先重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.currentPhone = null;
  job.phoneError = null;
  await removePrivateFile(job.passwordAddResultPath);
  job.pendingNewPassword = generateStrongPassword();
  job.passwordAddResumesAuthorization = resumeAuthorization;
  job.passwordAddError = null;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.lastError = null;
  job.parserTail = "";
  recordJobOperation(job, "add_password");
  appendJobLog(job, "\n[password-add] 开始为无密码账号添加密码，新密码不会写入协议日志。\n");
  enqueueJob(job, "password_add", "正在重新验证账号并准备添加密码");
}

function generateStrongPassword() {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#%_";
  const all = `${lower}${upper}${digits}${symbols}`;
  const chars = [
    lower[crypto.randomInt(lower.length)],
    upper[crypto.randomInt(upper.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];
  while (chars.length < 18) chars.push(all[crypto.randomInt(all.length)]);
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const target = crypto.randomInt(index + 1);
    [chars[index], chars[target]] = [chars[target], chars[index]];
  }
  return chars.join("");
}

async function finishPasswordAdd(job, code, signal) {
  let result = null;
  try {
    result = JSON.parse(await fs.readFile(job.passwordAddResultPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") job.passwordAddError = `添加密码结果无法读取：${error.message}`;
  }

  if (
    result?.version === 1
    && String(result.email || "").toLowerCase() === job.email.toLowerCase()
    && typeof result.password === "string"
    && result.password === job.pendingNewPassword
  ) {
    job.password = result.password;
    job.hasPasswordCredential = true;
    job.loginMode = "password";
    job.passwordAddedAt = result.added_at || new Date().toISOString();
    const persisted = await saveStoredLoginCredentials(job.email, job);
    job.passwordAddError = persisted
      ? null
      : "当前系统不支持持久凭据存储，新密码仅在本次服务运行期间可用";
    job.prompt = persisted
      ? job.passwordAddResumesAuthorization
        ? "密码添加成功，可以继续未完成的 Codex 授权"
        : "密码添加成功，账号原始信息已经更新"
      : "密码添加成功，但新密码未能持久保存";
    appendJobLog(job, persisted
      ? "[password-add] 密码添加成功，新密码已安全保存，未写入协议日志。\n"
      : "[password-add] 密码添加成功，但当前系统不支持持久保存新密码。\n");
    if (persisted) await removePrivateFile(job.passwordAddResultPath);
  } else {
    job.prompt = job.passwordAddResumesAuthorization
      ? "本次添加密码未完成，原登录检查点仍可继续"
      : "原授权文件仍可使用，本次添加密码未完成";
    job.passwordAddError ||= signal
      ? `添加密码进程被 ${signal} 终止`
      : `添加密码进程退出，代码 ${code ?? "未知"}`;
    await removePrivateFile(job.passwordAddResultPath);
  }

  job.status = job.passwordAddResumesAuthorization ? "resume_available" : "completed";
  job.lastError = job.passwordAddResumesAuthorization
    ? "ChatGPT 登录状态已保留，点击继续流程即可重新开始 Codex 授权"
    : null;
  job.runMode = null;
  job.runId = null;
  job.pendingNewPassword = null;
  job.passwordAddResumesAuthorization = false;
  touch(job);
  await saveJobMetadata(job);
}

function restorePasswordAddFailure(job, message) {
  const resumeAuthorization = Boolean(job.passwordAddResumesAuthorization);
  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.prompt = resumeAuthorization
    ? "本次添加密码未完成，原登录检查点仍可继续"
    : "原授权文件仍可使用，本次添加密码未完成";
  job.passwordAddError = message;
  job.lastError = resumeAuthorization ? "点击继续流程可恢复 Codex 授权" : null;
  job.runMode = null;
  job.runId = null;
  job.pendingNewPassword = null;
  job.passwordAddResumesAuthorization = false;
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void removePrivateFile(job.passwordAddResultPath).catch(() => {});
  void saveJobMetadata(job).catch(() => {});
}

async function loadTotpSetupResult(job) {
  const data = JSON.parse(await fs.readFile(job.totpResultPath, "utf8"));
  if (data?.version !== 1) throw new Error("2FA 设置结果文件格式不正确");
  if (data.already_enabled) {
    job.totpKnownEnabled = true;
    job.totpSetupSecret = null;
    job.totpSetupUri = null;
    return data;
  }
  const secret = normalizeTotpSecret(data.secret);
  const uri = String(data.otpauth_uri || "");
  if (!uri.startsWith("otpauth://totp/")) throw new Error("2FA 设置地址格式不正确");
  job.totpSetupSecret = secret;
  job.totpSetupUri = uri;
  if (data.activation_mode === "automatic") {
    if (job.status !== "totp_setup_otp") setStage(job, "working", "2FA 密钥已生成，正在自动激活");
  } else {
    setStage(job, "totp_setup_otp", "密钥已生成，请添加到验证器后输入当前 6 位验证码");
  }
  return data;
}

async function finishTotpSetup(job, code, signal) {
  const resumeAuthorization = Boolean(job.totpSetupResumesAuthorization);
  let result = null;
  try {
    result = await loadTotpSetupResult(job);
  } catch (error) {
    if (error?.code !== "ENOENT" && !job.totpSetupError) job.totpSetupError = error.message;
  }

  const activationSucceeded = result?.activation_succeeded === true;
  let removeResult = false;
  if (code === 0 && result?.already_enabled) {
    job.totpKnownEnabled = true;
    job.prompt = "账号已经启用 2FA，但服务端不会返回原始密钥";
    job.totpSetupError = "如需自动登录，请重新导入这个账号原有的 2FA 密钥";
    removeResult = true;
  } else if ((code === 0 || activationSucceeded) && result?.secret) {
    const secret = normalizeTotpSecret(result.secret);
    job.totpSecret = secret;
    job.hasTotpCredential = true;
    job.totpKnownEnabled = true;
    const persisted = await saveStoredLoginCredentials(job.email, job);
    job.prompt = activationSucceeded && code !== 0
      ? "2FA 已激活并保存，但最终状态确认未完成"
      : resumeAuthorization
        ? "2FA 已设置并安全保存，可以继续未完成的 Codex 授权"
        : "2FA 已设置并安全保存，可以继续下载或重新授权";
    job.totpSetupError = !persisted
      ? "当前系统不支持持久凭据存储，2FA 密钥已保留在私有结果文件中，请不要删除该任务目录"
      : activationSucceeded && code !== 0
      ? "激活接口已返回成功，但后续确认请求失败；密钥已保留"
      : null;
    appendJobLog(job, persisted
      ? "[2fa] 2FA 设置成功，密钥已写入系统凭据存储，未写入协议日志。\n"
      : "[2fa] 2FA 设置成功，但当前系统不支持持久凭据存储；密钥已保留在私有结果文件中。\n");
    removeResult = persisted;
  } else {
    job.prompt = resumeAuthorization
      ? "本次 2FA 设置未完成，原登录检查点仍可继续"
      : "授权文件仍然可用，本次 2FA 设置未完成";
    job.totpSetupError ||= signal
      ? `2FA 设置进程被 ${signal} 终止`
      : `2FA 设置进程退出，代码 ${code ?? "未知"}`;
  }

  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.lastError = resumeAuthorization
    ? "ChatGPT 登录状态已保留，点击继续流程即可重新开始 Codex 授权"
    : null;
  job.runMode = null;
  job.runId = null;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupResumesAuthorization = false;
  if (removeResult || !result?.secret || result?.activation_succeeded === false) {
    await removePrivateFile(job.totpResultPath);
  }
  touch(job);
  await saveJobMetadata(job);
}

async function removePrivateFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function restoreTotpSetupFailure(job, message) {
  const resumeAuthorization = Boolean(job.totpSetupResumesAuthorization);
  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.prompt = resumeAuthorization
    ? "本次 2FA 设置未完成，原登录检查点仍可继续"
    : "授权文件仍然可用，本次 2FA 设置未完成";
  job.totpSetupError = message;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupResumesAuthorization = false;
  job.lastError = resumeAuthorization ? "点击继续流程可恢复 Codex 授权" : null;
  job.runMode = null;
  job.child?.kill("SIGTERM");
  job.child = null;
  void removePrivateFile(job.totpResultPath).catch(() => {});
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

async function fallbackFromRefresh(job) {
  if (job.runMode !== "refresh" || job.fallbackInProgress) return;
  job.fallbackInProgress = true;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.status = "starting";
  job.prompt = "已有授权状态已过期，正在重新进行邮箱登录";
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  beginAuthorizationAutomationAttempt(job, "refresh_fallback");
  appendJobLog(job, "[refresh] 刷新令牌已失效，自动回退到邮箱验证码登录。\n");
  job.fallbackInProgress = false;
  if (job.status !== "canceled") {
    enqueueJob(job, "full", "刷新令牌已失效，正在重新登录并授权");
  }
  touch(job);
}

function consumeOutput(job, rawText) {
  const proxyAttemptScan = `${job.proxyAttemptParserTail || ""}${rawText}`;
  job.proxyAttemptParserTail = proxyAttemptScan.slice(-160);
  let proxyAttemptNotices = "";
  for (const match of proxyAttemptScan.matchAll(/\[proxy-session-attempt\]\s+([a-f0-9-]{36})/gi)) {
    const attemptId = match[1].toLowerCase();
    if (job.proxySessionAttemptIds.has(attemptId)) continue;
    job.proxySessionAttemptIds.add(attemptId);
    job.proxyRiskRetryCount = Math.min(MAX_PROXY_RISK_RETRIES, (job.proxyRiskRetryCount || 0) + 1);
    job.proxyConnectionFailureCount = 0;
    proxyAttemptNotices += `[proxy] 正在检测第 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个新代理会话。\n`;
    void saveJobMetadata(job).catch(() => {});
  }
  const text = `${proxyAttemptNotices}${sanitizeLog(rawText)}`
    .replace(/^\[proxy-session-attempt\][^\r\n]*(?:\r?\n)?/gim, "");
  job.logs = `${job.logs}${text}`.slice(-MAX_LOG_CHARS);
  const scan = `${job.parserTail}${text}`;
  job.parserTail = scan.slice(-2_000);

  // Fatal account closure (deleted / deactivated / banned) surfaces as a thrown
  // "[error] ..." line — commonly at the 2FA step. The OTP wasn't wrong and a
  // resume won't help, so stop immediately and mark the mailbox deactivated
  // instead of letting the child exit into a generic "resume available" state.
  if (!isTerminalStatus(job.status) && job.runMode !== "totp_setup" && job.runMode !== "password_add") {
    const fatalError = extractFatalLoginError(scan);
    if (fatalError && isPermanentAccountFailure(fatalError)) {
      failAccountClosedDuringLogin(job, fatalError);
      return;
    }
  }

  if (scan.includes("[3/5] Password login page reached.")) {
    markAuthorizationRequirement(job, "password");
    if (job.password) markAuthorizationAutomatic(job, "password");
  }
  if (scan.includes("[3/5] Email OTP page reached.")) {
    markAuthorizationRequirement(job, "emailOtp");
  }
  const mailRequestMarkers = [...scan.matchAll(/\[email-otp-requested-at\]\s+(\S+)/g)];
  const latestMailRequestAt = Date.parse(mailRequestMarkers.at(-1)?.[1] || "");
  if (Number.isFinite(latestMailRequestAt)) job.mailOtpRequestedAt = latestMailRequestAt;
  if (scan.includes("[checkpoint] Saved verified email login state.")
    || scan.includes("[checkpoint] Updated verified login state after adding the password.")
    || scan.includes("[checkpoint] Updated verified login state after setting 2FA.")) {
    job.loginCheckpointAvailable = true;
  }

  if (scan.includes("[proxy-risk-retry]")) {
    void restartAfterProxyRisk(job, {
      connectionFailure: scan.includes("PROXY_CONNECTION_RETRY"),
    }).catch((error) => {
      finishProxyRiskRetries(job, `自动更换代理会话失败：${error.message}`);
    });
    return;
  }

  if (job.runMode === "refresh" && scan.includes("REFRESH_TOKEN_INVALID")) {
    void fallbackFromRefresh(job);
    return;
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-setup-ready]") && !job.totpResultLoading && !job.totpSetupSecret) {
    job.totpResultLoading = true;
    setStage(job, "working", "2FA 密钥已经生成，正在安全读取");
    void loadTotpSetupResult(job)
      .catch((error) => {
        job.totpSetupError = `无法读取 2FA 密钥：${error.message}`;
        job.child?.kill("SIGTERM");
        touch(job);
      })
      .finally(() => {
        job.totpResultLoading = false;
      });
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-already-enabled]")) {
    job.totpKnownEnabled = true;
    setStage(job, "working", "账号已经启用 2FA，正在收尾");
  }

  if (job.runMode === "totp_setup" && scan.includes("[ok] 2FA setup activated")) {
    setStage(job, "working", "2FA 已激活，正在安全保存密钥");
  }

  if (scan.includes("[security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "本次登录需要浏览器安全校验，2FA 尚未设置";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "添加密码需要浏览器安全校验，请稍后重试或更换代理 IP";
      touch(job);
      return;
    }
    requireBrowserSecurityCheck(job);
    return;
  }

  if (scan.includes("[profile-security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "账号资料校验未通过，2FA 尚未设置";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "账号资料校验未通过，密码尚未添加";
      touch(job);
      return;
    }
    requireProfileSecurityCheck(job);
    return;
  }

  if (scan.includes("ACCOUNT_PROFILE_REQUIRED")) {
    failAccountProfileRequired(job);
    return;
  }

  const sessionErrorLines = [...scan.matchAll(/^\[error\]\s*([^\r\n]+)/gim)];
  const latestSessionError = sessionErrorLines.at(-1)?.[1] || "";
  if (/Your sign-in session is no longer valid|["']code["']\s*:\s*["'](?:invalid_state|invalid_auth_step)["']|Invalid authorization step/i.test(latestSessionError)) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "设置 2FA 时登录状态失效，请稍后重试";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "添加密码时登录状态失效，请稍后重试";
      touch(job);
      return;
    }
    requireReauthorization(job, "当前登录状态已经失效，继续更换手机号也无法发送验证码");
    return;
  }

  if (scan.includes("[auth-expired]")) {
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.currentPhone = null;
    job.phoneError = null;
    setStage(job, "starting", "新登录状态被服务端拒绝，正在自动重新获取邮箱验证码");
  }

  if (scan.includes("Email OTP (r=resend, q=quit):")) {
    markAuthorizationRequirement(job, "emailOtp");
    const rejected = scan.includes("[email-otp-rejected]");
    setStage(
      job,
      "email_otp",
      rejected
        ? "邮箱验证码错误，请重新输入或重新发送"
        : job.mailApiUrl
          ? "正在等待收码接口返回新验证码，也可以手动输入"
          : "请输入邮箱验证码",
    );
    if (job.mailApiUrl) void beginMailPolling(job);
  }
  if (scan.includes("Password (q=quit):")) {
    markAuthorizationRequirement(job, "password");
    stopMailPolling(job);
    setStage(job, "password", "请输入账号密码");
  }
  if (scan.includes("2FA setup OTP (6 digits, q=quit):")) {
    setStage(job, "totp_setup_otp", "请将密钥添加到验证器后输入当前 6 位验证码");
  }
  const mfaReachedIndex = scan.lastIndexOf("[mfa] TOTP 2FA challenge reached.");
  const mfaPromptIndex = scan.lastIndexOf("2FA OTP (6 digits, q=quit):");
  if (mfaReachedIndex > mfaPromptIndex) {
    markAuthorizationRequirement(job, "mfa");
    setStage(job, "working", job.totpSecret ? "正在自动完成 2FA 验证" : "正在准备 2FA 验证");
  } else if (mfaPromptIndex > mfaReachedIndex) {
    markAuthorizationRequirement(job, "mfa");
    setStage(job, "mfa_otp", "请输入 6 位 2FA 验证码");
  }
  if (scan.includes("[mfa] Generated a 6-digit code from the configured 2FA key.")) {
    markAuthorizationAutomatic(job, "mfa");
  }
  const phoneNumberPromptIndex = scan.lastIndexOf("Phone number, E.164 format");
  const phoneOtpPromptIndex = scan.lastIndexOf("Phone OTP (r=resend, p=change phone, q=quit):");
  if (phoneNumberPromptIndex > phoneOtpPromptIndex) {
    stopMailPolling(job);
    setStage(job, "phone", "请输入需要绑定的手机号");
  } else if (phoneOtpPromptIndex > phoneNumberPromptIndex) {
    if (job.smsStatus !== "error") job.phoneError = null;
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `短信验证码已发送至 ${job.currentPhone}` : "请输入手机短信验证码",
    );
    if (job.smsOrderId && job.smsNumber === job.currentPhone) void beginSmsPolling(job);
  }

  const sendFailures = [...scan.matchAll(/\[warn\] Could not send SMS to (\+\d+):\s*([^\r\n]+)/g)];
  if (sendFailures.length) {
    const latest = sendFailures.at(-1);
    job.currentPhone = latest[1];
    job.phoneError = friendlyPhoneError(latest[2]);
    // Risk control / unusable number → block it so the next change-phone avoids it.
    if (isPhonePermanentlyBad(latest[2])) markPhoneBlocked(latest[1], latest[2], job.email);
    if (job.smsOrderId && job.smsNumber === job.currentPhone) {
      releaseSmsNumber(job, "error", "该平台手机号无法接收验证码，请重新取号或手动输入其他手机号");
    }
    setStage(job, "phone", `手机号 ${job.currentPhone} 无法接收验证码，请更换手机号`);
  }

  const validationFailures = [...scan.matchAll(/\[warn\] Phone OTP validation failed:\s*([^\r\n]+)/g)];
  if (validationFailures.length) {
    const validationMessage = validationFailures.at(-1)[1];
    if (isPermanentAccountFailure(validationMessage)) {
      failAccountClosedAtPhoneOtp(job, validationMessage);
      return;
    }
    job.phoneError = friendlyPhoneOtpError(validationMessage);
    stopSmsPolling(job);
    if (job.smsStatus === "submitted") {
      job.smsStatus = "error";
      job.smsError = "平台返回的验证码未通过验证，请重新发送或更换手机号";
    }
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `请重新输入发送至 ${job.currentPhone} 的验证码` : "请重新输入手机验证码",
    );
    if (shouldChangePhoneAfterOtpFailure(validationMessage)) {
      job.smsError = job.phoneError;
      // The server rejected this number (e.g. recently used / in use) → block it.
      if (isPhonePermanentlyBad(validationMessage) && job.currentPhone) {
        markPhoneBlocked(job.currentPhone, validationMessage, job.email);
      }
      appendJobLog(job, "[sms] 当前手机号已被服务端拒绝，停止提交旧验证码并自动返回换号步骤。\n");
      void submitJobInput(job, { action: "change_phone", value: "" }, {
        preservePhoneError: true,
      }).catch((error) => {
        failJob(job, `无法自动返回换号步骤：${error.message}`);
      });
      touch(job);
      return;
    }
  }
  if (scan.includes("[ok] Phone OTP validated")) {
    completeSmsNumber(job);
  }
  applyLoginProgress(job, scan);
  if (scan.includes("[5/5] Select workspace") || scan.includes("[6/6] Convert OAuth callback")) {
    setStage(job, "finalizing", "正在完成授权并生成文件");
  }
  if (scan.includes("[4/5] Existing workspace/session selected")) {
    setStage(job, "finalizing", "账号已绑定手机号，正在继续授权");
  }
  if (scan.includes("[ok] Saved sub2api import:")) {
    job.resultSaved = true;
    setStage(job, "finalizing", "导入文件已生成，正在收尾");
  }
  if (scan.includes("[ok] Account password added and saved securely")) {
    setStage(job, "finalizing", "密码已添加，正在安全保存新密码");
  }
  const errorMatches = [...scan.matchAll(/\[error\]\s*([^\r\n]+)/g)];
  if (errorMatches.length) {
    const errorMessage = extractResponseMessage(errorMatches.at(-1)[1]);
    if (job.runMode === "totp_setup") {
      job.totpSetupError = errorMessage;
    } else if (job.runMode === "password_add") {
      job.passwordAddError = errorMessage;
    } else {
      failJob(job, errorMessage);
    }
  }
  touch(job);
}

async function restartAfterProxyRisk(job, options = {}) {
  if (job.proxyRiskRestarting || isTerminalStatus(job.status)) return;
  job.proxyRiskRestarting = true;
  const mode = job.runMode || job.queuedMode || "full";
  try {
    // A dead/unreachable proxy (connection failure) must stop immediately in a
    // proxy_error state that names the failing proxy — regardless of whether the
    // proxy supports session rotation. Never auto-rotate or auto-switch.
    if (options.connectionFailure && job.proxyUrl) {
      failProxyConnection(job);
      return;
    }
    if (!job.proxyUrl) {
      if (job.directTlsFallbackAttempted) {
        finishProxyRiskRetries(job, "Cloudflare 安全校验未能完成，直连 TLS 指纹筛选已经使用过，请稍后重试");
        return;
      }
      job.directTlsFallbackAttempted = true;
      const fallbackProfile = await directTlsProfileProbe.resolve();
      appendJobLog(job, `[tls] Cloudflare 求解未完成，正在启用直连 TLS 指纹筛选兜底（${fallbackProfile}）。\n`);
    } else if (!proxySupportsSessionRotation(job.proxyUrl)) {
      finishProxyRiskRetries(
        job,
        "当前代理没有可识别的会话编号，无法自动轮换；请更换代理配置后重试",
      );
      return;
    }
    if ((job.proxyRiskRetryCount || 0) >= MAX_PROXY_RISK_RETRIES) {
      finishProxyRiskRetries(job, `代理会话已自动更换 ${MAX_PROXY_RISK_RETRIES} 次，仍然触发安全校验`);
      return;
    }

    stopMailPolling(job);
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.queueRunId = null;
    job.runId = crypto.randomUUID();
    const restartRunId = job.runId;
    job.child?.kill("SIGTERM");
    job.child = null;
    if (mode === "full") await removePrivateFile(job.checkpointPath);
    job.parserTail = "";
    job.lastError = null;
    job.currentPhone = null;
    job.phoneError = null;
    job.securityCheckRequired = false;
    job.restartRequired = false;
    appendJobLog(
      job,
      options.connectionFailure
        ? `[proxy] 代理连接失败，HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}；连接失败 ${job.proxyConnectionFailureCount}/${MAX_PROXY_CONNECTION_FAILURES}。\n`
        : `[proxy] 登录阶段触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话，正在继续更换。\n`,
    );
    if (options.connectionFailure) {
      const retryDelay = Math.min(
        PROXY_CONNECTION_RETRY_MAX_MS,
        PROXY_CONNECTION_RETRY_BASE_MS * (2 ** Math.min(job.proxyConnectionFailureCount - 1, 4)),
      );
      job.status = "starting";
      job.prompt = `代理连接失败，${Math.ceil(retryDelay / 1_000)} 秒后更换会话`;
      touch(job);
      await saveJobMetadata(job);
      await delay(retryDelay);
      if (job.runId !== restartRunId || isTerminalStatus(job.status)) return;
    }
    job.proxyRiskRestarting = false;
    enqueueJob(
      job,
      mode,
      options.connectionFailure
        ? `代理连接失败，正在更换会话；HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}`
        : `代理触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话`,
    );
  } finally {
    job.proxyRiskRestarting = false;
  }
}

// A proxy connection failure (dead/unreachable proxy). Stop the job in a
// terminal "proxy_error" state, name the failing proxy, and wait for the
// operator to pick a replacement — never auto-rotate or auto-switch here.
function failProxyConnection(job) {
  job.proxyRiskRestarting = false;
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  stopSmsPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  // Invalidate the current run so the child's close handler bails (mirrors the
  // session-rotation path) and cannot overwrite proxy_error with failed/resume.
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.proxyConnectionError = true;
  const identity = job.proxyUrl ? proxyConnectionIdentity(job.proxyUrl) : null;
  job.failedProxyLabel = identity?.label || null;
  job.status = "proxy_error";
  job.prompt = "代理连接失败，请更换代理";
  job.lastError = identity?.label
    ? `代理连接失败：${identity.label} 无法连接，请更换代理`
    : "代理连接失败：当前代理无法连接，请更换代理";
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

function finishProxyRiskRetries(job, message) {
  job.proxyRiskRestarting = false;
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    restoreTotpSetupFailure(job, message);
    return;
  }
  if (job.runMode === "password_add" || job.queuedMode === "password_add") {
    restorePasswordAddFailure(job, message);
    scheduleQueuedJobs();
    return;
  }
  if (job.resultSaved) {
    job.status = "completed";
    job.prompt = "原授权文件仍然可用，自动更换代理未能完成本次操作";
    job.lastError = message;
    job.runMode = null;
    job.child?.kill("SIGTERM");
    job.child = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    scheduleQueuedJobs();
    return;
  }
  failJob(job, message);
  job.child?.kill("SIGTERM");
  job.child = null;
  scheduleQueuedJobs();
}

function requireReauthorization(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "reauth_required";
  job.prompt = "登录状态已失效，需要重新授权";
  job.lastError = message;
  job.phoneError = null;
  job.restartRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireBrowserSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "手机号绑定需要浏览器安全校验";
  job.lastError = "邮箱登录已经成功，但服务端拒绝了本次纯协议短信请求；可以手动重试，若仍被拒绝则需要稍后再试";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireProfileSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号资料创建需要安全校验";
  job.lastError = "邮箱验证码已经通过，但账号资料创建仍被 Sentinel 安全校验拒绝；可以点击重新授权再次生成动态校验令牌";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function failAccountProfileRequired(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号注册资料未完成";
  job.lastError = "邮箱验证已经成功，但该邮箱还没有完成账号资料填写。请先在官方页面完成姓名和出生日期后再重新授权。";
  job.phoneError = null;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

// The code was delivered and checked, but the service answered that the account no longer exists.
// The code was not wrong, and neither a resend nor another (paid) number can bring the account back.
function failAccountClosedAtPhoneOtp(job, validationMessage) {
  if (isTerminalStatus(job.status)) return;
  completeSmsNumber(job, "短信验证码已送达并提交");
  job.currentPhone = null;
  job.phoneError = null;
  failJob(job, `提交手机验证码时账号已被 OpenAI 删除或停用：${extractResponseMessage(validationMessage)}`);
  job.child?.kill("SIGTERM");
  job.child = null;
  scheduleQueuedJobs();
}

// Account confirmed deleted/deactivated/banned partway through login — most
// often at the 2FA step, where OpenAI answers "You do not have an account
// because it has been deleted or deactivated." The 2FA code was not wrong, so
// retrying the OTP or resuming the saved checkpoint cannot recover it: fail now
// with the real reason so failJob() tags the mailbox as deactivated and the
// pool scan skips it, instead of offering a pointless resume.
function failAccountClosedDuringLogin(job, rawMessage) {
  if (isTerminalStatus(job.status)) return;
  failJob(job, `账号已被 OpenAI 删除或停用：${extractResponseMessage(rawMessage)}`);
  job.child?.kill("SIGTERM");
  job.child = null;
  scheduleQueuedJobs();
}

// Pull the fatal "[error] ..." line the login child prints right before it
// exits, so a permanent account closure can be recognised from streamed output.
function extractFatalLoginError(scan) {
  let found = null;
  for (const match of String(scan || "").matchAll(/\[error\]\s*([^\r\n]+)/g)) {
    found = match[1].trim();
  }
  return found;
}

function markResumeAvailable(job, reason = "登录流程中断") {
  stopMailPolling(job);
  stopSmsPolling(job);
  job.status = "resume_available";
  job.prompt = "邮箱登录检查点仍然有效，可以继续手机号绑定";
  job.lastError = `${reason}，继续时会优先恢复已保存状态；状态失效才重新获取邮箱验证码`;
  job.child = null;
  job.currentPhone = null;
  job.loginCheckpointAvailable = true;
  touch(job);
}

function friendlyPhoneError(message) {
  const text = String(message || "");
  if (/suspicious behavior/i.test(text)) return "该手机号触发了风控，请更换手机号或稍后重试";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) return "短信发送过于频繁，请稍后重试或更换手机号";
  if (/already|used|unsupported|invalid phone/i.test(text)) return "该手机号不可用或已被使用，请更换手机号";
  return "短信验证码发送失败，请更换手机号后重试";
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function friendlyPhoneOtpError(message) {
  const text = String(message || "");
  if (/phone_recently_used|phone number was recently used/i.test(text)) {
    return "该手机号近期已被使用，已停止重复提交，请更换手机号";
  }
  if (/phone_number_in_use|phone number already in use/i.test(text)) {
    return "该手机号已绑定其他账号，请更换手机号";
  }
  if (/expired/i.test(text)) return "手机验证码已过期，请重新发送或更换手机号";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) {
    return "验证次数过多，已停止自动提交，请稍后更换手机号";
  }
  return "手机验证码不正确，请重新输入；也可以重新发送或更换手机号";
}

function shouldChangePhoneAfterOtpFailure(message) {
  return /phone_recently_used|phone number was recently used|phone_number_in_use|phone number already in use|too many|rate.?limit|HTTP 429/i
    .test(String(message || ""));
}

function acquireCustomSmsEntry(entries) {
  const poolKey = crypto.createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("base64url");
  const nextIndex = customSmsPoolPositions.get(poolKey) || 0;
  if (nextIndex >= entries.length) return null;
  customSmsPoolPositions.set(poolKey, nextIndex + 1);
  return entries[nextIndex];
}

async function acquireSmsNumber(job, providerId, config) {
  requireStage(job, "phone");
  if (job.smsStatus === "requesting") throw httpError(409, "正在获取手机号，请不要重复提交");

  let smsClient;
  try {
    smsClient = createSmsProvider(providerId, config, {
      lubanApiBase: process.env.LUBAN_SMS_API_BASE,
      smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      viOtpApiBase: process.env.VIOTP_API_BASE,
      smsCodeApiBase: process.env.SMSCODE_API_BASE,
      acquireCustomSmsEntry,
    });
  } catch (error) {
    throw httpError(400, safeSmsProviderError(error, config?.apiKey));
  }

  releaseSmsNumber(job, "idle");
  job.smsClient = smsClient;
  job.smsProviderId = smsClient.id;
  job.smsProviderName = smsClient.name;
  job.smsServiceLabel = smsClient.serviceLabel;
  job.smsStatus = "requesting";
  job.smsError = null;
  touch(job);

  let order;
  try {
    // Phone-number filter: before submitting a number to the verification API,
    // skip any number already used up (reuse cap) or risk-blocked, and fetch
    // another. The blocked list and use counts live in the on-disk ledger.
    const maxAttempts = 25;
    let attempt = 0;
    let rejected = 0;
    while (true) {
      attempt += 1;
      order = await smsClient.getNumber();
      if (job.status !== "phone" || !job.child) {
        void smsClient.release(order.requestId).catch(() => {});
        throw httpError(409, "任务已经不在手机号输入步骤，平台号码已释放");
      }
      if (isPhoneAvailable(order.number)) break;
      const why = phoneUnavailableReason(order.number) === "risk"
        ? "曾被风控或判定不可用"
        : `已达使用次数上限（${phoneMaxUses}）`;
      rejected += 1;
      void smsClient.release(order.requestId).catch(() => {});
      appendJobLog(job, `[sms] 号码 ${order.number} ${why}，已跳过并重新取号。\n`);
      if (attempt >= maxAttempts) {
        throw httpError(409, `连续获取到 ${rejected} 个已用过或被风控的号码，请补充新号码或调整使用次数上限`);
      }
    }
    job.smsOrderId = order.requestId;
    job.smsNumber = order.number;
    job.smsStatus = "number_acquired";
    job.smsError = null;
    // Reserve the number now so it is not reused beyond the configured cap.
    recordPhoneUsage(order.number, job.email);
    // Cost ledger: a number was taken → money is held until the code verifies
    // (success = charged) or the number is released (cancel = refunded).
    // Prefer the amount the provider actually charged; a configured max price is only an upper bound.
    const smsPrice = Number(order.price ?? config?.maxPrice);
    if (!Array.isArray(job.smsCostEvents)) job.smsCostEvents = [];
    job.smsCostEvents.push({
      id: crypto.randomUUID(),
      provider: smsClient.name,
      serviceLabel: smsClient.serviceLabel || null,
      number: order.number,
      price: Number.isFinite(smsPrice) && smsPrice >= 0 ? smsPrice : null,
      currency: "$",
      status: "held",
      at: new Date().toISOString(),
      resolvedAt: null,
    });
    await saveJobMetadata(job);
    appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取手机号并提交，等待短信发送结果。\n`);
    await submitJobInput(job, { action: "phone", value: order.number }, { source: "sms-provider" });
  } catch (error) {
    if (order?.requestId && job.smsOrderId === order.requestId) releaseSmsNumber(job, "error");
    if (job.status === "phone") {
      job.smsStatus = "error";
      job.smsError = safeSmsProviderError(error, smsClient.apiKey);
      if (!order) job.smsClient = null;
      touch(job);
    }
    if (error?.status) throw error;
    throw httpError(502, safeSmsProviderError(error, smsClient.apiKey));
  }
}

async function beginSmsPolling(job) {
  if (
    !job.smsClient
    || !job.smsOrderId
    || job.smsPollToken
    || job.status !== "phone_otp"
    || !["number_acquired", "waiting_sms"].includes(job.smsStatus)
  ) return;
  const pollToken = crypto.randomUUID();
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const startedAt = Date.now();
  job.smsPollToken = pollToken;
  job.smsStatus = "waiting_sms";
  job.smsError = null;
  touch(job);

  try {
    if (smsClient.markReady) {
      await smsClient.markReady(requestId).catch((error) => {
        appendJobLog(job, `[sms] ${smsClient.name} 更新号码就绪状态失败：${safeSmsProviderError(error)}\n`);
      });
    }
    while (
      job.smsPollToken === pollToken &&
      job.smsOrderId === requestId &&
      job.status === "phone_otp" &&
      job.child &&
      Date.now() - startedAt < SMS_POLL_TIMEOUT_MS
    ) {
      try {
        const result = await smsClient.getSms(requestId);
        if (job.smsPollToken !== pollToken || job.status !== "phone_otp" || !job.child) return;
        if (result.status === "received") {
          if (job.smsLastSubmittedCode === result.code) {
            job.smsStatus = "error";
            job.smsError = "接码平台仍返回已提交过的验证码，已停止重复提交";
            appendJobLog(job, `[sms] ${smsClient.name} 返回了已提交过的验证码，已停止本次自动轮询。\n`);
            touch(job);
            return;
          }
          job.smsLastSubmittedCode = result.code;
          job.smsStatus = "submitting";
          job.smsError = null;
          appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取短信验证码并自动提交。\n`);
          await submitJobInput(job, { action: "phone_otp", value: result.code }, { source: "sms-provider" });
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = null;
      } catch (error) {
        if (job.smsPollToken !== pollToken) return;
        if (error?.terminal) {
          job.smsStatus = "error";
          job.smsError = `${safeSmsProviderError(error)}，可以手动输入验证码或更换手机号`;
          touch(job);
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = `${safeSmsProviderError(error)}，正在自动重试`;
        touch(job);
      }
      await delay(SMS_POLL_INTERVAL_MS);
    }

    if (job.smsPollToken === pollToken && job.status === "phone_otp") {
      job.smsStatus = "error";
      job.smsError = "等待平台短信超时，可以手动输入验证码或更换手机号";
      touch(job);
    }
  } finally {
    if (job.smsPollToken === pollToken) {
      job.smsPollToken = null;
      touch(job);
    }
  }
}

function stopSmsPolling(job) {
  job.smsPollToken = null;
}

// Settle the most recent "held" SMS cost event as charged (verified) or refunded (canceled).
function settleSmsCost(job, status) {
  const events = Array.isArray(job.smsCostEvents) ? job.smsCostEvents : null;
  if (!events) return;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].status === "held") {
      events[i].status = status;
      events[i].resolvedAt = new Date().toISOString();
      return;
    }
  }
}

function releaseSmsNumber(job, nextStatus = "idle", errorMessage = null) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const providerName = job.smsProviderName || smsClient?.name || "接码平台";
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsNumber = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = nextStatus;
  job.smsError = errorMessage;
  if (nextStatus === "idle") {
    job.smsProviderId = null;
    job.smsProviderName = null;
    job.smsServiceLabel = null;
  }
  if (requestId && smsClient) {
    settleSmsCost(job, "refunded"); // number released before verifying → refunded
    void smsClient.release(requestId).catch(() => {
      appendJobLog(job, `[sms] ${providerName} 号码释放请求失败，请在平台控制台检查订单。\n`);
    });
  }
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function completeSmsNumber(job, outcome = "手机验证码已通过") {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  if (!requestId || !smsClient) return;
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = "completed";
  job.smsError = null;
  settleSmsCost(job, "charged"); // the SMS was delivered and used → this number is charged (counts)
  appendJobLog(job, `[sms] ${outcome}，正在完成 ${smsClient.name} 订单。\n`);
  if (smsClient.complete) {
    void smsClient.complete(requestId).catch((error) => {
      appendJobLog(job, `[sms] ${smsClient.name} 完成订单失败：${safeSmsProviderError(error)}\n`);
      touch(job);
    });
  }
  touch(job);
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function newSmsState() {
  return {
    smsProviderId: null,
    smsProviderName: null,
    smsServiceLabel: null,
    smsOrderId: null,
    smsNumber: null,
    smsClient: null,
    smsStatus: "idle",
    smsError: null,
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function restoredSmsState(metadata = {}) {
  const orderId = metadata.sms_order_id || metadata.luban_request_id;
  const number = metadata.sms_number || metadata.luban_number;
  if (!orderId || !number) return newSmsState();
  return {
    smsProviderId: metadata.sms_provider_id || "luban",
    smsProviderName: metadata.sms_provider_name || (metadata.sms_provider_id === "smsbower" ? "SMSBower" : "LubanSMS"),
    smsServiceLabel: metadata.sms_service_label || metadata.luban_service_id || null,
    smsOrderId: String(orderId),
    smsNumber: String(number),
    smsClient: null,
    smsStatus: "error",
    smsError: "服务重启后已停止自动收短信，可手动输入验证码或换号",
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function safeSmsProviderError(error, apiKey = "") {
  let message = String(error?.message || "接码平台请求失败");
  if (apiKey) message = message.replaceAll(apiKey, "<已隐藏密钥>");
  return message
    .replace(/apikey=[^&\s]+/gi, "apikey=<已隐藏>")
    .replace(/api_key=[^&\s]+/gi, "api_key=<已隐藏>")
    .replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 220);
}

async function submitJobInput(job, body, options = {}) {
  if (!job.child || !isActive(job.status)) {
    throw httpError(409, "This login flow is not waiting for input");
  }
  const action = String(body.action || "");
  const rawValue = String(body.value || "");
  const value = rawValue.trim();
  let inputValue = "";

  if (action === "password") {
    requireStage(job, "password");
    if (!rawValue) throw httpError(400, "密码不能为空");
    await saveStoredLoginCredentials(job.email, {
      password: rawValue,
      totpSecret: job.totpSecret,
      proxyUrl: job.proxyUrl,
    });
    job.loginMode = "password";
    job.password = rawValue;
    job.hasPasswordCredential = true;
    markAuthorizationManual(job, "password");
    await saveJobMetadata(job);
    inputValue = rawValue;
    setStage(job, "working", "正在验证账号密码");
  } else if (action === "mfa_otp") {
    requireStage(job, "mfa_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "2FA 验证码必须是 6 位数字");
    inputValue = value;
    markAuthorizationManual(job, "mfa");
    setStage(job, "working", "正在验证 2FA 验证码");
  } else if (action === "totp_setup_otp") {
    requireStage(job, "totp_setup_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "设置 2FA 的验证码必须是 6 位数字");
    inputValue = value;
    setStage(job, "working", "正在激活新的 2FA");
  } else if (action === "email_otp") {
    requireStage(job, "email_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "Email code must be 6 digits");
    stopMailPolling(job);
    job.parserTail = "";
    markAuthorizationManual(job, "emailOtp");
    inputValue = value;
    setStage(job, "working", "正在验证邮箱验证码");
  } else if (action === "resend_email") {
    requireStage(job, "email_otp");
    stopMailPolling(job);
    job.parserTail = "";
    inputValue = "r";
    setStage(job, "working", "正在重新发送邮箱验证码");
  } else if (action === "phone") {
    requireStage(job, "phone");
    if (!/^\+[1-9]\d{6,14}$/.test(value)) throw httpError(400, "Phone number must use E.164 format, for example +60123456789");
    if (options.source !== "sms-provider") releaseSmsNumber(job, "idle");
    job.currentPhone = value;
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", `正在向 ${value} 发送手机验证码`);
  } else if (action === "phone_otp") {
    requireStage(job, "phone_otp");
    if (!/^\d{4,8}$/.test(value)) throw httpError(400, "Phone code must be 4 to 8 digits");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = options.source === "sms-provider" ? "submitted" : "manual_submitted";
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", "正在验证手机验证码");
  } else if (action === "resend_phone") {
    requireStage(job, "phone_otp");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = "number_acquired";
    job.phoneError = null;
    inputValue = "r";
    setStage(job, "working", job.currentPhone ? `正在向 ${job.currentPhone} 重新发送验证码` : "正在重新发送手机验证码");
  } else if (action === "change_phone") {
    requireStage(job, "phone_otp");
    const preservedPhoneError = options.preservePhoneError ? job.phoneError : null;
    releaseSmsNumber(
      job,
      options.preservePhoneError ? "error" : "idle",
      options.preservePhoneError ? preservedPhoneError : null,
    );
    job.currentPhone = null;
    job.phoneError = preservedPhoneError;
    inputValue = "p";
    setStage(
      job,
      "working",
      options.preservePhoneError ? "当前手机号不可用，正在返回换号步骤" : "正在返回手机号输入",
    );
  } else {
    throw httpError(400, "Unsupported input action");
  }

  job.parserTail = "";
  job.child.stdin.write(`${inputValue}\n`);
  touch(job);
}

async function cancelJob(job) {
  if (!isActive(job.status)) return;
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    stopMailPolling(job);
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    await finishTotpSetup(job, 1, "SIGTERM");
    if (!job.totpKnownEnabled) {
      job.prompt = job.resultSaved
        ? "授权文件仍然可用，2FA 设置已取消"
        : "2FA 设置已取消，原登录检查点仍可继续";
      job.totpSetupError = "用户取消了本次 2FA 设置";
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
    return;
  }
  if (job.runMode === "password_add" || job.queuedMode === "password_add") {
    stopMailPolling(job);
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    await finishPasswordAdd(job, 1, "SIGTERM");
    if (job.passwordAddError) {
      job.prompt = "原授权文件仍可使用，添加密码已取消";
      job.passwordAddError = "用户取消了本次添加密码";
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
    return;
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "canceled";
  job.prompt = "流程已取消";
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

// Cancel a job because its proxy IP has no registration slot left. Used for the
// overflow accounts when the user starts more than the IP capacity allows.
function cancelForProxyCapacity(job) {
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "canceled";
  job.prompt = "代理 IP 注册名额已满，已自动取消该任务";
  job.lastError = null;
  job.queueRunId = null;
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

async function cancelAllJobs() {
  // "Stop all" targets running/queued work only; staged (idle) jobs stay in the list.
  const activeJobs = [...jobs.values()].filter((job) => isActive(job.status) && job.status !== "idle");
  if (!activeJobs.length) return 0;
  queueSchedulingPaused = true;
  try {
    await Promise.all(activeJobs.map((job) => withEmailJobLock(job.email, () => cancelJob(job))));
    await Promise.all(activeJobs.map((job) => saveJobMetadata(job)));
  } finally {
    queueSchedulingPaused = false;
  }
  scheduleQueuedJobs();
  return activeJobs.length;
}

async function downloadResult(res, job) {
  if (!job.resultSaved || !(await fileExists(job.outputPath))) {
    sendJson(res, 409, { error: "The sub2api import file is not ready" });
    return;
  }
  const safeEmail = job.email.replace(/[^a-zA-Z0-9@._+-]/g, "_");
  const data = await fs.readFile(job.outputPath);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${safeEmail}-sub2api-import-oauth-${downloadTimestamp()}.json"`,
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function downloadBatchResult(res, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw httpError(400, "请至少选择一个已完成任务");
  }
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多下载 ${MAX_BATCH_JOBS} 个账号`);

  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  const downloadable = selected.filter((job) => job.resultSaved);
  if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");

  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts);
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }

  const payload = Buffer.from(`${JSON.stringify({
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  }, null, 2)}\n`);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="sub2api-import-oauth-${accounts.length}-accounts-${downloadTimestamp()}.json"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function buildSub2ApiUploadPayload(downloadable) {
  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts);
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  };
}

// Create each registration proxy (from the import bundle) in Sub2API and map its
// proxy_key to the returned proxy id, so accounts can carry proxy_id in the
// batch import. Proxies are already deduped within one upload (uniqueByJson), so
// each distinct proxy is created once. Returns { idByKey: Map<proxy_key, id>, created }.
async function createSub2ApiProxyIds(config, proxies) {
  const idByKey = new Map();
  let created = 0;
  if (!Array.isArray(proxies) || proxies.length === 0) return { idByKey, created };
  for (const proxy of proxies) {
    if (!proxy?.proxy_key) continue;
    // protocol restricted to http/https/socks5/socks5h by Sub2API.
    const createdPayload = await requestSub2Api(config, "/api/v1/admin/proxies", {
      method: "POST",
      body: JSON.stringify({
        name: proxy.name || `${proxy.host}:${proxy.port}`,
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username || "",
        password: proxy.password || "",
      }),
    });
    const id = Number(createdPayload?.data?.id ?? createdPayload?.id);
    if (Number.isInteger(id) && id > 0) {
      idByKey.set(proxy.proxy_key, id);
      created += 1;
    }
  }
  return { idByKey, created };
}

// Parse a proxy URL into a Sub2API proxy object, or null when invalid.
function parseProxyUrlForSub2Api(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const protocol = { "http:": "http", "https:": "https", "socks5:": "socks5", "socks5h:": "socks5h" }[url.protocol];
  const host = url.hostname;
  const port = Number(url.port);
  if (!protocol || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const username = url.username ? decodeURIComponent(url.username) : "";
  const password = url.password ? decodeURIComponent(url.password) : "";
  return { name: `${host}:${port}`, protocol, host, port, username, password };
}

// Parse a newline/comma separated proxy list into unique Sub2API proxy objects,
// preserving order (dedup by protocol|host|port|username).
function parseProxyList(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || "").split(/[\r\n,]+/)) {
    const proxy = parseProxyUrlForSub2Api(line);
    if (!proxy) continue;
    const key = `${proxy.protocol}|${proxy.host}|${proxy.port}|${proxy.username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proxy);
  }
  return out;
}

// Rebuild a proxy URL from a Sub2API proxy object (for health-checking old proxies).
function proxyObjToUrl(p) {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || "")}@` : "";
  return `${p.protocol}://${auth}${p.host}:${p.port}`;
}

// A proxy "connection identity" ignores the rotating session segment so that a
// single credential (which may exit from many IPs) counts as one proxy. This is
// what "đã từng sử dụng" / "chưa từng sử dụng" is measured against. The rotation
// tokens mirror rotateProxySession/maskSession in tls-transport.mjs: "-sid-XXXX"
// in the username, and the kookeey numeric session in the password.
// (PROXY_SID_PATTERN / PROXY_KOOKEEY_PATTERN are hoisted above the startup init block.)
function stripProxySession(username, password) {
  const canonicalUser = PROXY_SID_PATTERN.test(username)
    ? username.replace(PROXY_SID_PATTERN, "$1sid-*")
    : username;
  const canonicalPass = PROXY_KOOKEEY_PATTERN.test(password)
    ? password.replace(PROXY_KOOKEEY_PATTERN, "$1-*-$3")
    : password;
  return { canonicalUser, canonicalPass };
}

// Returns { key, label } for a proxy URL, or null when it cannot be parsed.
// `key` is session-independent and credential-bearing, so it stays local (the
// ledger/pool files are mode 0600). `label` is safe to show in the UI (host:port).
function proxyConnectionIdentity(value) {
  const parsed = parseProxyUrlForSub2Api(value);
  if (!parsed) return null;
  const { canonicalUser, canonicalPass } = stripProxySession(parsed.username, parsed.password);
  const raw = `${parsed.protocol}|${parsed.host.toLowerCase()}|${parsed.port}|${canonicalUser}|${canonicalPass}`;
  const key = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return { key, label: `${parsed.host}:${parsed.port}`, protocol: parsed.protocol, host: parsed.host, port: parsed.port };
}

// ---- Used-proxy ledger (persistent, session-independent) ----
async function loadUsedProxyLedger() {
  usedProxyLedger.clear();
  try {
    const rows = usedProxyDao.getAll();
    for (const row of rows) {
      usedProxyLedger.set(row.identity_key, {
        label: row.label,
        protocol: row.protocol || "",
        host: row.host || "",
        port: row.port || 0,
        firstUsedAt: row.first_used_at || null,
        lastUsedAt: row.last_used_at || null,
        emails: row.emails || [],
      });
    }
  } catch (error) {
    console.warn(`[warn] 代理使用记录无法读取：${String(error?.message || error).slice(0, 180)}`);
  }
}

async function persistUsedProxyLedger() {
  // DB writes happen inline at each mutation — this is now a no-op.
}

// ---- Deactivated-account registry (persistent, session-independent) ----
// The console confirms deactivation from a permanent login/auth failure (it does
// not wait for a deactivation email). A confirmed account is recorded here so its
// mailbox stays in "Danh sách email" flagged as deactivated after the task is
// removed, giving the operator the list to clean up on the workspace.
async function loadDeactivatedEmails() {
  deactivatedEmails.clear();
  try {
    const rows = deactivatedEmailDao.getAll();
    for (const row of rows) {
      deactivatedEmails.set(row.email.toLowerCase(), {
        email: row.email,
        reason: row.reason || null,
        at: row.at || null,
      });
    }
  } catch (error) {
    console.warn(`[warn] 停用账号记录无法读取：${String(error?.message || error).slice(0, 180)}`);
  }
}

async function persistDeactivatedEmails() {
  // DB writes happen inline at each mutation — this is now a no-op.
}

// Flag an email as deactivated (idempotent). Keeps the first-seen timestamp and
// fills in a reason when one becomes known.
function markEmailDeactivated(email, reason) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return false;
  const existing = deactivatedEmails.get(key);
  deactivatedEmails.set(key, {
    email: existing?.email || String(email).trim(),
    reason: reason ? String(reason).slice(0, 500) : existing?.reason || null,
    at: existing?.at || new Date().toISOString(),
  });
  try { deactivatedEmailDao.upsert(key, reason, existing?.at); } catch {}
  return true;
}

// Drop the deactivated flag — the mailbox was deleted, or reused for a fresh
// account that registered successfully.
function clearEmailDeactivated(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!deactivatedEmails.delete(key)) return;
  try { deactivatedEmailDao.remove(key); } catch {}
}

// ---- Used / risk-flagged phone-number ledger (persistent, on this machine) ----
// Normalize to a digits-only key so "+1 202-555-0100" and "12025550100" match.
function normalizePhoneKey(number) {
  return String(number || "").replace(/\D+/g, "");
}

async function loadUsedPhoneLedger() {
  usedPhoneLedger.clear();
  try {
    const rows = usedPhoneDao.getAll();
    for (const row of rows) {
      usedPhoneLedger.set(row.digits, {
        number: row.number,
        uses: row.uses || 0,
        blocked: Boolean(row.blocked),
        blockedReason: row.blocked_reason || null,
        firstUsedAt: row.first_used_at || null,
        lastUsedAt: row.last_used_at || null,
        emails: row.emails || [],
      });
    }
  } catch (error) {
    console.warn(`[warn] 手机号使用记录无法读取：${String(error?.message || error).slice(0, 180)}`);
  }
}

async function persistUsedPhoneLedger() {
  // DB writes happen inline at each mutation — this is now a no-op.
}

function getPhoneLedgerEntry(number) {
  return usedPhoneLedger.get(normalizePhoneKey(number)) || null;
}

// A number may be picked only when it is not risk-blocked and still under the
// reuse cap (phoneMaxUses === 0 disables the cap but never the block-list).
function isPhoneAvailable(number) {
  const digits = normalizePhoneKey(number);
  if (!digits) return true; // can't key it → don't block the flow
  const entry = usedPhoneLedger.get(digits);
  if (!entry) return true;
  if (entry.blocked) return false;
  if (phoneMaxUses > 0 && entry.uses >= phoneMaxUses) return false;
  return true;
}

function phoneUnavailableReason(number) {
  const entry = getPhoneLedgerEntry(number);
  if (!entry) return null;
  if (entry.blocked) return "risk";
  if (phoneMaxUses > 0 && entry.uses >= phoneMaxUses) return "max-uses";
  return null;
}

// Count a number as used (it was submitted to the verification API). Never
// removed, so the cap holds across restarts and even after accounts are deleted.
function recordPhoneUsage(number, email) {
  const digits = normalizePhoneKey(number);
  if (!digits) return;
  const now = new Date().toISOString();
  const entry = usedPhoneLedger.get(digits) || { number: String(number), uses: 0, blocked: false, blockedReason: null, firstUsedAt: now, lastUsedAt: now, emails: [] };
  entry.number = String(number) || entry.number;
  entry.uses += 1;
  entry.firstUsedAt = entry.firstUsedAt || now;
  entry.lastUsedAt = now;
  if (email && !entry.emails.includes(String(email))) entry.emails.push(String(email));
  usedPhoneLedger.set(digits, entry);
  try { usedPhoneDao.recordUsage(digits, entry, email); } catch {}
}

// Permanently block a number the platform's risk control (or an "already used /
// invalid" rejection) turned down, so the next change-phone skips it.
function markPhoneBlocked(number, reason, email) {
  const digits = normalizePhoneKey(number);
  if (!digits) return;
  const now = new Date().toISOString();
  const entry = usedPhoneLedger.get(digits) || { number: String(number), uses: 0, blocked: false, blockedReason: null, firstUsedAt: now, lastUsedAt: now, emails: [] };
  entry.number = String(number) || entry.number;
  entry.blocked = true;
  entry.blockedReason = reason ? String(reason).slice(0, 300) : entry.blockedReason || "风控/号码不可用";
  entry.lastUsedAt = now;
  if (email && !entry.emails.includes(String(email))) entry.emails.push(String(email));
  usedPhoneLedger.set(digits, entry);
  try { usedPhoneDao.markBlocked(digits, entry.number, entry.blockedReason, email); } catch {}
}

// A phone rejection that should permanently burn the number: risk control,
// already-used / in-use, or an invalid/unsupported number. Pure rate-limiting is
// transient, so it is intentionally excluded.
function isPhonePermanentlyBad(message) {
  const text = String(message || "");
  if (/too many|rate.?limit|HTTP 429/i.test(text) && !/suspicious|risk|used|in.?use|invalid|unsupported|blocked|banned|风控/i.test(text)) {
    return false;
  }
  return /suspicious behavior|风控|fraud|phone_recently_used|phone number was recently used|phone_number_in_use|phone number already in use|already|unsupported|invalid phone|blocked|banned/i.test(text);
}

function setPhoneMaxUses(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw httpError(400, "使用次数上限必须是 0 到 1000 的整数");
  phoneMaxUses = n;
  try { settingsDao.set("phone_max_uses", String(n)); } catch {}
  return phoneMaxUses;
}

// Console UI settings live in the `settings` table under a "ui:" prefix, as the
// same key -> string pairs the browser used to keep in localStorage.
const UI_SETTING_PREFIX = "ui:";
const UI_SETTING_KEY_PATTERN = /^chatgpt-onboarding\.[a-z0-9.-]{1,80}$/;

function readUiSettings() {
  const out = {};
  for (const row of settingsDao.getAll()) {
    if (row.key.startsWith(UI_SETTING_PREFIX)) out[row.key.slice(UI_SETTING_PREFIX.length)] = row.value ?? "";
  }
  return out;
}

// A null value deletes the key; anything else is stored as a string.
function writeUiSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw httpError(400, "settings must be an object");
  }
  const entries = Object.entries(settings);
  for (const [key, value] of entries) {
    if (!UI_SETTING_KEY_PATTERN.test(key)) throw httpError(400, `Invalid setting key: ${key}`);
    if (value !== null && typeof value !== "string") throw httpError(400, `Setting ${key} must be a string or null`);
  }
  for (const [key, value] of entries) {
    if (value === null) settingsDao.remove(UI_SETTING_PREFIX + key);
    else settingsDao.set(UI_SETTING_PREFIX + key, value);
  }
}

function phoneLedgerStats() {
  let blocked = 0;
  let totalUses = 0;
  for (const entry of usedPhoneLedger.values()) {
    if (entry.blocked) blocked += 1;
    totalUses += entry.uses;
  }
  return { maxUses: phoneMaxUses, totalNumbers: usedPhoneLedger.size, blocked, totalUses };
}

// Các host (IP cũ) chủ máy đã "Quên" — đọc từ settings, trả về Set.
function getForgottenProxyHosts() {
  try {
    const arr = JSON.parse(settingsDao.get(PROXY_FORGOTTEN_HOSTS_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr.filter((h) => typeof h === "string" && h) : []);
  } catch {
    return new Set();
  }
}

// Thêm/bỏ 1 host khỏi danh sách "đã quên". Trả về mảng host hiện tại.
function setProxyHostForgotten(host, forget) {
  const set = getForgottenProxyHosts();
  if (forget) set.add(host); else set.delete(host);
  settingsDao.set(PROXY_FORGOTTEN_HOSTS_KEY, JSON.stringify([...set]));
  return [...set];
}

// Record that a proxy credential has been assigned to an account. Never removed
// on account deletion, so the ledger keeps the full history ("kể cả tài khoản đã xóa").
function recordProxyUsage(proxyUrl, email, exitIp = null) {
  const identity = proxyConnectionIdentity(proxyUrl);
  if (!identity) return;
  const now = new Date().toISOString();
  const existing = usedProxyLedger.get(identity.key);
  if (existing) {
    existing.lastUsedAt = now;
    existing.label = identity.label;
    existing.protocol = identity.protocol;
    existing.host = identity.host;
    existing.port = identity.port;
    if (email && !existing.emails.includes(email)) existing.emails.push(email);
  } else {
    usedProxyLedger.set(identity.key, {
      label: identity.label,
      protocol: identity.protocol,
      host: identity.host,
      port: identity.port,
      firstUsedAt: now,
      lastUsedAt: now,
      emails: email ? [email] : [],
    });
  }
  try {
    usedProxyDao.recordUsage(identity.key, {
      label: identity.label, protocol: identity.protocol,
      host: identity.host, port: identity.port,
      firstUsedAt: now, lastUsedAt: now,
    }, email, exitIp);
  } catch (error) {
    console.warn(`[warn] 代理使用记录写入失败：${String(error?.message || error).slice(0, 180)}`);
  }
}

// Rule: when a configured domain proxy exits through the same IP as a proxy that
// was stored by raw IP, they are one line — the domain overwrites the raw IP on
// every job and in the used-proxy ledger, so usage is counted under one host.
// Returns the set of domain hosts probed here.
async function overwriteRawIpProxiesWithDomains(urls, { force = false } = {}) {
  const domains = [];
  for (const url of urls) {
    const parsed = parseProxyUrlForSub2Api(url);
    if (parsed && net.isIP(parsed.host) === 0) domains.push({ host: parsed.host, url });
  }
  const probed = new Set(domains.map((d) => d.host));
  const hasRawIpRecord = [...jobs.values()].some((job) => net.isIP(parseProxyUrlForSub2Api(job.proxyUrl)?.host || "") !== 0)
    || [...usedProxyLedger.values()].some((entry) => net.isIP(entry.host || "") !== 0);
  if (!domains.length || !hasRawIpRecord) return new Set();
  const checks = await mapWithConcurrency(domains, 6, (d) => checkProxyExitIpCached(d.url, d.host, { force }));
  const domainByExitIp = new Map();
  checks.forEach((check, index) => {
    if (check.ok && check.ip && !domainByExitIp.has(check.ip)) domainByExitIp.set(check.ip, domains[index]);
  });
  if (!domainByExitIp.size) return probed;

  for (const job of jobs.values()) {
    const parsed = parseProxyUrlForSub2Api(job.proxyUrl);
    const domain = parsed && net.isIP(parsed.host) !== 0 ? domainByExitIp.get(parsed.host) : null;
    if (!domain) continue;
    // Same line, so a running job keeps its connection — only the record changes.
    job.proxyUrl = domain.url;
    await saveStoredLoginCredentials(job.email, job);
    recordProxyUsage(domain.url, job.email);
    appendJobLog(job, `[proxy] 代理记录已由 IP ${parsed.host} 覆盖为域名 ${domain.host}（出口 IP 相同）。\n`);
    touch(job);
    await saveJobMetadata(job);
  }

  for (const [key, entry] of [...usedProxyLedger]) {
    const domain = net.isIP(entry.host || "") !== 0 ? domainByExitIp.get(entry.host) : null;
    if (!domain) continue;
    for (const email of entry.emails.length ? entry.emails : [null]) recordProxyUsage(domain.url, email);
    usedProxyLedger.delete(key);
    try { usedProxyDao.remove(key); } catch {}
  }
  return probed;
}

function isProxyEverUsed(key) {
  return usedProxyLedger.has(key);
}

// True when some existing (non-deleted) job is currently assigned a proxy with
// the same connection identity — used to enforce the reuse-confirmation rule.
function proxyCurrentlyInUse(key, exceptJobId = null) {
  for (const job of jobs.values()) {
    if (exceptJobId && job.id === exceptJobId) continue;
    if (!job.proxyUrl) continue;
    const identity = proxyConnectionIdentity(job.proxyUrl);
    if (identity && identity.key === key) return true;
  }
  return false;
}

// On startup, make sure every proxy already assigned to a restored account is in
// the ledger, so pre-existing accounts count as "đã từng sử dụng" too.
function backfillUsedProxiesFromJobs() {
  for (const job of jobs.values()) {
    if (job.proxyUrl) recordProxyUsage(job.proxyUrl, job.email);
  }
}

// Reconcile every already-confirmed-deactivated job (its autoRepairBlocked flag
// was restored from metadata on load) so the mailbox shows as deactivated in
// "Danh sách email" right away — without waiting for a fresh failure or a monitor
// pass. With no Sub2API backend configured the task is also dropped here; with a
// backend, removal is left to the monitor (disable scheduling first, then drop).
async function backfillDeactivatedFromJobs() {
  for (const job of [...jobs.values()].filter((item) => item.autoRepairBlocked)) {
    await maybeRemoveDeactivatedNow(job.email, job.autoRepairBlockedReason);
  }
}

// ---- Proxy pool (proxies loaded into the system to pick replacements from) ----
async function loadProxyPool() {
  proxyPool.clear();
  try {
    const rows = proxyPoolDao.getAll();
    for (const row of rows) {
      proxyPool.set(row.identity_key, {
        label: row.label || "",
        protocol: row.protocol || "",
        host: row.host || "",
        port: row.port || 0,
        username: row.username || "",
        password: row.password || "",
        url: row.url || "",
        addedAt: row.added_at || null,
      });
    }
  } catch (error) {
    console.warn(`[warn] 代理池无法读取：${String(error?.message || error).slice(0, 180)}`);
  }
}

async function persistProxyPool() {
  // DB writes happen inline at each mutation — this is now a no-op.
}

// Import a newline/comma separated proxy list into the pool. Returns counts.
function importProxiesIntoPool(text) {
  const parsed = parseProxyList(text);
  let added = 0;
  let skipped = 0;
  for (const proxy of parsed) {
    const url = proxyObjToUrl(proxy);
    const identity = proxyConnectionIdentity(url);
    if (!identity) {
      skipped += 1;
      continue;
    }
    if (proxyPool.has(identity.key)) {
      skipped += 1;
      continue;
    }
    const entry = {
      label: identity.label,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || "",
      password: proxy.password || "",
      url,
      addedAt: new Date().toISOString(),
    };
    proxyPool.set(identity.key, entry);
    try { proxyPoolDao.upsert(identity.key, entry); } catch {}
    added += 1;
  }
  return { added, skipped, total: proxyPool.size };
}

// Public projection of the pool, annotated with used/in-use flags.
function publicProxyPool() {
  const out = [];
  for (const [key, entry] of proxyPool) {
    out.push({
      key,
      label: entry.label,
      protocol: entry.protocol,
      host: entry.host,
      port: entry.port,
      addedAt: entry.addedAt,
      used: isProxyEverUsed(key),
      inUse: proxyCurrentlyInUse(key),
    });
  }
  return out;
}

// Auto-assign proxies from a configured list when registering accounts in batch
// mode: round-robin over the IPs (host-deduped) that are still under limitPerIp.
// Usage counts come from existing jobs grouped by IP (host); IPs that are not in
// the configured list (e.g. old IPs) are ignored and never picked.
// A job occupies one registration slot on its proxy IP when it has registered
// (reached the SMS step) and is not deactivated, OR while it is actively running
// toward a registration. Queued/idle ("chờ khởi động") jobs, jobs that failed
// before the SMS step, and deactivated accounts do NOT hold a slot.
function jobConsumesProxySlot(job) {
  if (job.deleted || !job.proxyUrl) return false;
  if (job.autoRepairBlocked) return false; // account deactivated → slot freed
  return Boolean(job.registrationSucceeded) || occupiesActiveSlot(job);
}

// Map of proxy IP (host) -> number of registration slots currently occupied.
function proxyConsumedByHost() {
  const usage = new Map();
  for (const job of listUniqueJobs()) {
    if (!jobConsumesProxySlot(job)) continue;
    const parsed = parseProxyUrlForSub2Api(job.proxyUrl);
    if (!parsed) continue;
    usage.set(parsed.host, (usage.get(parsed.host) || 0) + 1);
  }
  return usage;
}

// Phần sau @ của email, dạng chữ thường. Dùng để khớp proxy theo domain.
function emailDomainPart(email) {
  const at = String(email || "").lastIndexOf("@");
  return at >= 0 ? String(email).slice(at + 1).trim().toLowerCase() : "";
}

// Đọc cấu hình phân bổ proxy từ body: pool chung (`proxies`) + các nhóm proxy
// gán riêng theo domain (`domainProxies: [{ domain, proxies }]`). Nhóm thiếu
// domain hoặc rỗng bị bỏ qua.
function readProxyAllocConfig(body) {
  const general = typeof body?.proxies === "string" ? body.proxies : "";
  const groups = Array.isArray(body?.domainProxies)
    ? body.domainProxies
        .map((g) => ({
          domain: String(g?.domain || "").trim().toLowerCase().replace(/^@+/, ""),
          proxies: typeof g?.proxies === "string" ? g.proxies : "",
        }))
        .filter((g) => g.domain && g.proxies.trim())
    : [];
  return { general, groups };
}

// Danh sách URL proxy đã khử trùng host (mỗi IP chỉ 1 lần) từ 1 khối text.
function dedupeProxyUrls(text) {
  const seen = new Set();
  const list = [];
  for (const p of parseProxyList(text)) {
    if (seen.has(p.host)) continue;
    seen.add(p.host);
    list.push({ host: p.host, url: proxyObjToUrl(p) });
  }
  return list;
}

// Auto-assign proxies when registering accounts in batch mode. Nhận hoặc 1 khối
// text (pool chung, tương thích cũ) hoặc cấu hình { general, groups } có proxy
// gán riêng theo domain. `.next(email)` ưu tiên proxy của domain email đó; hết
// chỗ (mọi IP riêng đã đạt giới hạn) thì mượn pool chung. Giới hạn limitPerIp
// đếm theo host và DÙNG CHUNG cho cả proxy riêng lẫn pool chung, nên một IP
// không bao giờ vượt giới hạn dù nằm ở nhóm nào.
function makeProxyAllocator(proxyConfig, limitPerIpRaw) {
  const limitPerIp = Math.min(999, Math.max(1, Math.trunc(Number(limitPerIpRaw)) || 15));
  const { general, groups } = typeof proxyConfig === "string"
    ? { general: proxyConfig, groups: [] }
    : (proxyConfig || { general: "", groups: [] });
  const domainLists = groups.map((g) => ({ domain: g.domain, list: dedupeProxyUrls(g.proxies) }));
  // Proxy đã gán cho 1 domain là ĐỘC QUYỀN của domain đó: loại khỏi pool chung dù
  // người dùng vẫn để nó trong danh sách chung, nên domain khác không bốc trúng.
  const domainHosts = new Set(domainLists.flatMap((d) => d.list.map((it) => it.host)));
  const generalList = dedupeProxyUrls(general).filter((it) => !domainHosts.has(it.host));
  // Only registered-or-running (non-deactivated) jobs occupy a slot; queued/idle
  // and pre-SMS failures do not — so freshly staged accounts don't pre-reserve.
  // Một usage map DUY NHẤT theo host cho mọi nhóm: cùng IP không bị tính 2 lần.
  const usage = proxyConsumedByHost();
  const allItems = [...generalList, ...domainLists.flatMap((d) => d.list)];
  for (const item of allItems) if (!usage.has(item.host)) usage.set(item.host, 0);
  const cursors = new Map(); // key nhóm -> vị trí round-robin
  const pickFrom = (list, key) => {
    if (!list.length) return null;
    const start = cursors.get(key) || 0;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[(start + i) % list.length];
      if ((usage.get(item.host) || 0) < limitPerIp) {
        cursors.set(key, (start + i + 1) % list.length);
        usage.set(item.host, (usage.get(item.host) || 0) + 1);
        return item.url;
      }
    }
    return null;
  };
  const groupFor = (email) => {
    const domain = emailDomainPart(email);
    if (!domain) return null;
    return domainLists.find((g) => domain === g.domain || domain.endsWith(`.${g.domain}`)) || null;
  };
  return {
    limitPerIp,
    count: allItems.length,
    remainingCapacity: () => allItems.reduce((sum, it) => sum + Math.max(0, limitPerIp - (usage.get(it.host) || 0)), 0),
    next: (email) => {
      const group = groupFor(email);
      // Proxy riêng của domain trước; hết chỗ thì mượn pool chung (fallback).
      if (group) {
        const url = pickFrom(group.list, `domain:${group.domain}`);
        if (url) return url;
      }
      return pickFrom(generalList, "__general__");
    },
  };
}

// Run an async mapper over items with a bounded number of concurrent workers,
// preserving input order in the returned array.
async function mapWithConcurrency(items, limit, mapper) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await mapper(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length || 1) }, worker));
  return results;
}

// Create a list of proxies in Sub2API and return their ids in the same order.
async function createSub2ApiProxyList(config, proxyObjs) {
  const ids = [];
  for (const proxy of proxyObjs) {
    const createdPayload = await requestSub2Api(config, "/api/v1/admin/proxies", {
      method: "POST",
      body: JSON.stringify({
        name: proxy.name,
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username || "",
        password: proxy.password || "",
      }),
    });
    const id = Number(createdPayload?.data?.id ?? createdPayload?.id);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

function normalizeSub2ApiConfig(value) {
  const config = value && typeof value === "object" ? value : {};
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const adminApiKey = String(config.adminApiKey || "").trim();
  if (!baseUrl) throw httpError(400, "请填写 Sub2API 后端地址");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw httpError(400, "Sub2API 后端地址格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError(400, "Sub2API 后端地址必须使用 HTTP 或 HTTPS");
  }
  if (!adminApiKey || adminApiKey.length > 512 || /[\r\n]/.test(adminApiKey)) {
    throw httpError(400, "请填写有效的 Sub2API 管理员 API Key");
  }
  const rawGroupIds = Array.isArray(config.groupIds)
    ? config.groupIds
    : String(config.groupId || "").trim() ? [config.groupId] : [];
  const groupIds = [...new Set(rawGroupIds.map((value) => String(value).trim()).filter(Boolean))].map((value) => {
    if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
      throw httpError(400, "目标号池 ID 无效");
    }
    return Number(value);
  });
  const proxyText = String(config.proxyId || "").trim();
  if (proxyText && (!/^\d+$/.test(proxyText) || Number(proxyText) <= 0 || Number(proxyText) > Number.MAX_SAFE_INTEGER)) {
    throw httpError(400, "代理 ID 无效");
  }
  const proxyId = proxyText ? Number(proxyText) : 0;
  const concurrency = parseOptionalSub2ApiInteger(config.concurrency, "并发数", 0, 10000);
  const loadFactor = parseOptionalSub2ApiInteger(config.loadFactor, "负载因子", 0, 10000);
  const priority = parseOptionalSub2ApiInteger(config.priority, "优先级", 0, 10000);
  const modelWhitelist = parseSub2ApiModelWhitelist(config.modelWhitelist);
  const codexFingerprintMode = String(config.codexFingerprintMode || "session").trim().toLowerCase();
  if (!["off", "device", "session", "full"].includes(codexFingerprintMode)) {
    throw httpError(400, "Codex 指纹收敛模式无效");
  }
  return { baseUrl, adminApiKey, groupIds, proxyId, concurrency, loadFactor, priority, modelWhitelist, codexFingerprintMode };
}

function readDurationEnv(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function parseOptionalSub2ApiInteger(value, label, min, max) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw httpError(400, `${label}必须是数字`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw httpError(400, `${label}范围必须是 ${min} 到 ${max}`);
  return parsed;
}

function parseSub2ApiModelWhitelist(value) {
  const models = String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (models.length > 200) throw httpError(400, "支持模型最多填写 200 个");
  if (models.some((model) => model.length > 200 || /[\r\n]/.test(model))) throw httpError(400, "支持模型名称格式不正确");
  return [...new Set(models)];
}

function requestSub2Api(config, endpoint, options = {}) {
  const requestPromise = performSub2ApiRequest(config, endpoint, options);
  sub2ApiRequestPromises.add(requestPromise);
  void requestPromise.then(
    () => sub2ApiRequestPromises.delete(requestPromise),
    () => sub2ApiRequestPromises.delete(requestPromise),
  );
  return requestPromise;
}

async function performSub2ApiRequest(config, endpoint, options = {}) {
  const controller = new AbortController();
  sub2ApiRequestControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": config.adminApiKey,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = sub2ApiResponseMessage(payload, text).slice(0, 500);
      const error = httpError(502, `Sub2API 返回 HTTP ${response.status}${message ? `：${message}` : ""}`);
      error.remoteStatus = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "AbortError") {
      throw httpError(shuttingDown ? 503 : 504, shuttingDown ? "Sub2API 请求已因服务关闭而取消" : "Sub2API 请求超时");
    }
    throw httpError(502, `无法连接 Sub2API 后端：${error.message}`);
  } finally {
    clearTimeout(timeout);
    sub2ApiRequestControllers.delete(controller);
  }
}

function sub2ApiResponseMessage(payload, text) {
  const message = payload?.error?.message || payload?.message || payload?.error || "";
  return typeof message === "string" && message.trim()
    ? message.trim()
    : extractResponseMessage(text);
}

async function loadSub2ApiMonitorConfiguration() {
  try {
    const saved = sub2apiMonitorDao.get();
    if (!saved) { sub2ApiMonitorConfig = null; return; }
    const config = normalizeSub2ApiConfig({
      baseUrl: saved.base_url,
      adminApiKey: saved.admin_api_key,
      groupIds: saved.group_ids ? JSON.parse(saved.group_ids) : [],
      proxyId: saved.proxy_id,
      concurrency: saved.concurrency,
      loadFactor: saved.load_factor,
      priority: saved.priority,
      modelWhitelist: saved.model_whitelist ? JSON.parse(saved.model_whitelist) : [],
      codexFingerprintMode: saved.codex_fingerprint_mode,
    });
    sub2ApiMonitorConfig = { ...config, enabled: Boolean(saved.enabled) };
    sub2ApiMonitorState.lastCheckAt = saved.last_check_at || null;
    sub2ApiMonitorState.lastError = saved.last_error || null;
    sub2ApiMonitorState.lastResult = saved.last_result ? JSON.parse(saved.last_result) : null;
  } catch (error) {
    console.warn(`[warn] Sub2API 号池监控配置无法读取：${String(error?.message || error).slice(0, 180)}`);
    sub2ApiMonitorConfig = null;
  }
}

async function persistSub2ApiMonitorConfiguration() {
  if (!sub2ApiMonitorConfig) {
    try { sub2apiMonitorDao.remove(); } catch {}
    return;
  }
  try {
    sub2apiMonitorDao.upsert({
      enabled: sub2ApiMonitorConfig.enabled,
      baseUrl: sub2ApiMonitorConfig.baseUrl,
      adminApiKey: sub2ApiMonitorConfig.adminApiKey,
      groupIds: sub2ApiMonitorConfig.groupIds,
      proxyId: sub2ApiMonitorConfig.proxyId,
      concurrency: sub2ApiMonitorConfig.concurrency,
      loadFactor: sub2ApiMonitorConfig.loadFactor,
      priority: sub2ApiMonitorConfig.priority,
      modelWhitelist: sub2ApiMonitorConfig.modelWhitelist,
      codexFingerprintMode: sub2ApiMonitorConfig.codexFingerprintMode,
      lastCheckAt: sub2ApiMonitorState.lastCheckAt,
      lastError: sub2ApiMonitorState.lastError,
      lastResult: sub2ApiMonitorState.lastResult,
    });
  } catch (error) {
    console.warn(`[warn] Sub2API monitor config save failed: ${error.message}`);
  }
}

function publicSub2ApiMonitorState() {
  return {
    configured: Boolean(sub2ApiMonitorConfig?.baseUrl && sub2ApiMonitorConfig?.adminApiKey),
    enabled: Boolean(sub2ApiMonitorConfig?.enabled),
    baseUrl: sub2ApiMonitorConfig?.baseUrl || null,
    groupIds: sub2ApiMonitorConfig?.groupIds || [],
    intervalMinutes: Math.max(1, Math.round(SUB2API_MONITOR_INTERVAL_MS / 60_000)),
    cooldownMinutes: Math.max(1, Math.round(SUB2API_AUTO_REPAIR_COOLDOWN_MS / 60_000)),
    running: sub2ApiMonitorState.running,
    lastCheckAt: sub2ApiMonitorState.lastCheckAt,
    nextCheckAt: sub2ApiMonitorState.nextCheckAt,
    lastError: sub2ApiMonitorState.lastError,
    lastResult: sub2ApiMonitorState.lastResult,
  };
}

function scheduleSub2ApiMonitor() {
  if (sub2ApiMonitorTimer) {
    clearInterval(sub2ApiMonitorTimer);
    sub2ApiMonitorTimer = null;
  }
  sub2ApiMonitorState.nextCheckAt = null;
  if (!sub2ApiMonitorConfig?.enabled || shuttingDown) return;
  const interval = Number.isFinite(SUB2API_MONITOR_INTERVAL_MS) && SUB2API_MONITOR_INTERVAL_MS >= 1_000
    ? SUB2API_MONITOR_INTERVAL_MS
    : 5 * 60_000;
  sub2ApiMonitorState.nextCheckAt = new Date(Date.now() + interval).toISOString();
  sub2ApiMonitorTimer = setInterval(() => {
    sub2ApiMonitorState.nextCheckAt = new Date(Date.now() + interval).toISOString();
    void runSub2ApiMonitor("scheduled").catch((error) => {
      console.warn(`[warn] Sub2API 号池巡检失败：${String(error?.message || error).slice(0, 180)}`);
    });
  }, interval);
  sub2ApiMonitorTimer.unref?.();
}

async function runSub2ApiMonitor(trigger = "scheduled") {
  if (!sub2ApiMonitorConfig?.enabled) throw httpError(409, "Sub2API 号池监控未启用");
  if (sub2ApiMonitorPromise) return sub2ApiMonitorPromise;
  const config = { ...sub2ApiMonitorConfig, groupIds: [...sub2ApiMonitorConfig.groupIds] };
  sub2ApiMonitorPromise = (async () => {
    sub2ApiMonitorState.running = true;
    sub2ApiMonitorState.lastError = null;
    const summary = {
      trigger,
      checked: 0,
      matched: 0,
      started: 0,
      updated: 0,
      missingTask: 0,
      ineligible: 0,
      blocked: 0,
      disabled: 0,
      removed: 0,
      busy: 0,
      cooldown: 0,
      outsideGroups: 0,
      missingEmail: 0,
    };
    try {
      await syncCompletedOutputs(true);
      await retryPendingSub2ApiUploads(config, summary);
      if (shuttingDown) throw httpError(503, "服务正在关闭，已停止号池巡检");
      const remoteAccounts = await listSub2ApiErrorAccounts(config);
      summary.checked = remoteAccounts.length;
      const grouped = new Map();
      for (const account of remoteAccounts) {
        if (!isSub2ApiAccountInMonitoredGroups(account, config.groupIds)) {
          summary.outsideGroups += 1;
          continue;
        }
        const email = sub2ApiAccountEmail(account);
        if (!email) {
          summary.missingEmail += 1;
          continue;
        }
        if (!grouped.has(email)) grouped.set(email, []);
        grouped.get(email).push(account);
      }

      for (const [email, accounts] of grouped) {
        await withEmailJobLock(email, async () => {
          const job = findJobByEmail(email);
          if (!job) {
            summary.missingTask += accounts.length;
            return;
          }
          summary.matched += accounts.length;
          if (job.autoRepairBlocked) {
            summary.blocked += accounts.length;
            // Console cannot recover this account (confirmed banned/deleted/deactivated) —
            // stop Sub2API from scheduling a permanently broken account, then drop the
            // task so only the mailbox remains (flagged deactivated). Remove only once
            // scheduling is confirmed off (no failed calls); otherwise retry next pass.
            const outcome = await disableSub2ApiScheduling(config, accounts, job, "账号已确认不可用");
            summary.disabled += outcome.disabled;
            markEmailDeactivated(email, job.autoRepairBlockedReason);
            if (outcome.failed === 0 && await removeDeactivatedTask(email, job.autoRepairBlockedReason)) {
              summary.removed += 1;
            }
            return;
          }
          if (isActive(job.status) || job.autoRepairOperation) {
            summary.busy += accounts.length;
            return;
          }
          if (isAutoRepairCoolingDown(job)) {
            summary.cooldown += accounts.length;
            return;
          }
          await reloadMissingJobCredentials(job);
          const eligibility = getAutoRepairEligibility(job);
          if (!eligibility.eligible) {
            summary.ineligible += accounts.length;
            // Not auto-repairable (e.g. the last full login needed a manually entered
            // password / email code / 2FA) — keep it out of the schedule instead of
            // letting Sub2API keep dispatching an account the console can't fix.
            summary.disabled += (await disableSub2ApiScheduling(config, accounts, job, eligibility.reason)).disabled;
            return;
          }

          const operation = createSub2ApiAutoRepairOperation(config, accounts);
          await forceReloginJob(job, {}, { autoRepair: operation });
          appendJobLog(job, `[monitor] Sub2API 号池发现 ${accounts.length} 条异常记录，已自动加入重新登录并授权队列。\n`);
          await saveJobMetadata(job);
          summary.started += accounts.length;
        });
      }

      // Confirmed-deactivated tasks that never surfaced as Sub2API error accounts
      // this pass (e.g. an account banned during creation, or one outside the error
      // pool): make sure any schedulable Sub2API account for them is turned off,
      // then drop the task. The full-account listing is fetched at most once, and
      // only when such a task actually exists — a quiet pass makes no extra calls.
      const residualBlocked = listUniqueJobs().filter((job) => job.autoRepairBlocked);
      if (residualBlocked.length) {
        let backendAccounts = null;
        for (const candidate of residualBlocked) {
          if (shuttingDown) break;
          await withEmailJobLock(candidate.email, async () => {
            const job = findJobByEmail(candidate.email);
            if (!job || !job.autoRepairBlocked) return;
            const emailKey = job.email.toLowerCase();
            if (backendAccounts === null) {
              backendAccounts = await listAllSub2ApiAccounts(config).catch(() => []);
            }
            const matches = backendAccounts.filter((account) => sub2ApiAccountEmail(account) === emailKey);
            const outcome = matches.length
              ? await disableSub2ApiScheduling(config, matches, job, "账号已确认不可用")
              : { disabled: 0, failed: 0 };
            summary.disabled += outcome.disabled;
            if (outcome.failed === 0 && await removeDeactivatedTask(job.email, job.autoRepairBlockedReason)) {
              summary.removed += 1;
            }
          });
        }
      }

      sub2ApiMonitorState.lastCheckAt = new Date().toISOString();
      sub2ApiMonitorState.lastResult = summary;
      await persistSub2ApiMonitorConfiguration();
      return summary;
    } catch (error) {
      sub2ApiMonitorState.lastCheckAt = new Date().toISOString();
      sub2ApiMonitorState.lastError = String(error?.message || error).slice(0, 500);
      await persistSub2ApiMonitorConfiguration().catch(() => {});
      throw error;
    } finally {
      sub2ApiMonitorState.running = false;
    }
  })().finally(() => {
    sub2ApiMonitorPromise = null;
  });
  return sub2ApiMonitorPromise;
}

function createSub2ApiAutoRepairOperation(config, accounts) {
  const validAccounts = accounts.filter((account) => {
    const id = Number(account?.id);
    return Number.isSafeInteger(id) && id > 0;
  });
  return {
    accountIds: validAccounts.map((account) => Number(account.id)),
    accounts: validAccounts,
    backend: monitorBackendIdentity(config),
    config,
    startedAt: new Date().toISOString(),
  };
}

// Stop Sub2API from scheduling error accounts the console cannot auto-repair
// (ineligible logins or permanently blocked accounts). Best-effort and
// idempotent: accounts already marked schedulable=false are skipped, and a
// single failed call must never abort the whole monitor pass.
async function disableSub2ApiScheduling(config, accounts, job = null, reason = "") {
  let disabled = 0;
  let failed = 0;
  for (const account of accounts) {
    const accountId = Number(account?.id);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
    if (account?.schedulable === false) continue; // already out of the schedule
    try {
      await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}/schedulable`, {
        method: "POST",
        body: JSON.stringify({ schedulable: false }),
      });
      disabled += 1;
    } catch {
      failed += 1;
    }
  }
  if (job && (disabled || failed)) {
    const detail = reason ? `（${reason}）` : "";
    appendJobLog(
      job,
      failed
        ? `[monitor] 无法自动修复${detail}，已在 Sub2API 停止调度 ${disabled} 条，另有 ${failed} 条停调失败，下次巡检重试。\n`
        : `[monitor] 无法自动修复${detail}，已在 Sub2API 停止调度（schedulable=false）${disabled} 条账号。\n`,
    );
  }
  return { disabled, failed };
}

// A confirmed-deactivated account whose Sub2API scheduling is already off: drop
// the local task + run files so it leaves the task list. The mailbox stays in the
// deactivated registry (and thus in "Danh sách email") — it is never removed here.
async function removeDeactivatedTask(email, reason) {
  markEmailDeactivated(email, reason);
  const key = String(email || "").trim().toLowerCase();
  if (!key || !findJobByEmail(key)) return false;
  await deleteJobsByEmail(key);
  return true;
}

// Tag a confirmed-deactivated account, then drop its task right away when no
// Sub2API backend is configured (there is nothing to unschedule). When a backend
// IS configured, only tag here and leave removal to the monitor, so Sub2API
// scheduling is turned off first (the user's chosen ordering). Tagging runs
// synchronously before the first await, so the label appears immediately.
async function maybeRemoveDeactivatedNow(email, reason) {
  markEmailDeactivated(email, reason);
  if (sub2ApiMonitorConfig?.baseUrl) return false;
  return removeDeactivatedTask(email, reason);
}

async function retryPendingSub2ApiUploads(config, summary) {
  const backend = monitorBackendIdentity(config);
  for (const candidate of listUniqueJobs()) {
    await withEmailJobLock(candidate.email, async () => {
      const job = findJobByEmail(candidate.email);
      const pendingIds = [...new Set(job?.autoRepairPendingAccountIds || [])]
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      if (
        !job
        || pendingIds.length === 0
        || job.autoRepairPendingBackend !== backend
        || !job.resultSaved
        || job.status !== "completed"
        || job.autoRepairOperation
        || isAutoRepairCoolingDown(job)
      ) return;

      const accounts = [];
      const missingIds = [];
      try {
        for (const accountId of pendingIds) {
          const account = await getSub2ApiAccount(config, accountId);
          if (account) accounts.push(account);
          else missingIds.push(accountId);
        }
      } catch (error) {
        job.autoRepairLastAttemptAt = new Date().toISOString();
        job.autoRepairLastError = String(error?.message || error).slice(0, 500);
        appendJobLog(job, `[monitor] 读取待重传的 Sub2API 账号失败：${job.autoRepairLastError}。\n`);
        touch(job);
        await saveJobMetadata(job);
        return;
      }

      if (missingIds.length) {
        const missing = new Set(missingIds);
        job.autoRepairPendingAccountIds = pendingIds.filter((id) => !missing.has(id));
        appendJobLog(job, `[monitor] ${missingIds.length} 条待重传账号已从 Sub2API 删除，已停止重试。\n`);
      }
      if (!accounts.length) {
        job.autoRepairPendingBackend = null;
        job.autoRepairLastError = null;
        touch(job);
        await saveJobMetadata(job);
        return;
      }

      job.autoRepairOperation = createSub2ApiAutoRepairOperation(config, accounts);
      job.autoRepairLastAttemptAt = new Date().toISOString();
      appendJobLog(job, `[monitor] 正在重传 ${accounts.length} 条上次未完成的 Sub2API 更新，不重复登录。\n`);
      if (await finishSub2ApiAutoRepairSuccess(job)) summary.updated += accounts.length;
    });
  }
}

async function getSub2ApiAccount(config, accountId) {
  try {
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}`);
    const account = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    if (!account || Number(account.id) !== Number(accountId)) {
      throw new Error(`Sub2API 账号 ${accountId} 返回数据不完整`);
    }
    return account;
  } catch (error) {
    if (error?.remoteStatus === 404) return null;
    throw error;
  }
}

async function listSub2ApiErrorAccounts(config) {
  const accounts = [];
  let page = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({
      page: String(page),
      page_size: "100",
      platform: "openai",
      status: "error",
    });
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts?${query}`);
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    accounts.push(...items.filter((account) => account && String(account.platform || "openai") === "openai" && String(account.status || "error") === "error"));
    const reportedPages = Number(data?.pages);
    pages = Number.isSafeInteger(reportedPages) && reportedPages > 0
      ? reportedPages
      : items.length >= 100 ? page + 1 : page;
    page += 1;
  } while (page <= pages && page <= 1_000);
  return accounts;
}

// List every OpenAI account on the backend (all statuses). Used to backfill the
// "uploaded to Sub2API" tag on local jobs by matching their email.
async function listAllSub2ApiAccounts(config) {
  const accounts = [];
  let page = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({
      page: String(page),
      page_size: "100",
      platform: "openai",
    });
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts?${query}`);
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    accounts.push(...items.filter((account) => account && String(account.platform || "openai") === "openai"));
    const reportedPages = Number(data?.pages);
    pages = Number.isSafeInteger(reportedPages) && reportedPages > 0
      ? reportedPages
      : items.length >= 100 ? page + 1 : page;
    page += 1;
  } while (page <= pages && page <= 1_000);
  return accounts;
}

// Match local jobs to accounts that already exist on the configured backend (by
// email) and tag them as uploaded. Honors accounts pushed before the tag
// feature existed. Uses each backend account's created_at as the upload time
// when available. Returns { tagged, alreadyTagged, backendAccounts }.
async function backfillSub2ApiUploadTags(config) {
  const backendAccounts = await listAllSub2ApiAccounts(config);
  const timeByEmail = new Map();
  for (const account of backendAccounts) {
    const email = sub2ApiAccountEmail(account);
    if (!email) continue;
    const uploadedAt = account?.created_at || account?.updated_at || null;
    const existing = timeByEmail.get(email);
    // Keep the earliest known timestamp for an email.
    if (!existing || (uploadedAt && String(uploadedAt) < String(existing))) {
      timeByEmail.set(email, uploadedAt);
    } else if (!timeByEmail.has(email)) {
      timeByEmail.set(email, uploadedAt);
    }
  }

  const fallback = new Date().toISOString();
  let tagged = 0;
  let alreadyTagged = 0;
  for (const candidate of listUniqueJobs()) {
    const email = candidate.email.toLowerCase();
    if (!timeByEmail.has(email)) continue;
    const uploadedAt = normalizeUploadTimestamp(timeByEmail.get(email)) || fallback;
    await withEmailJobLock(candidate.email, async () => {
      for (const job of [...jobs.values()].filter((item) => item.email.toLowerCase() === email && !item.deleted)) {
        if (job.sub2apiUploadedAt) {
          alreadyTagged += 1;
          continue;
        }
        job.sub2apiUploadedAt = uploadedAt;
        job.sub2apiUploadedBaseUrl = config.baseUrl;
        touch(job);
        await saveJobMetadata(job);
        tagged += 1;
      }
    });
  }
  return { tagged, alreadyTagged, backendAccounts: backendAccounts.length, matchedEmails: timeByEmail.size };
}

// Coerce an arbitrary backend timestamp (ISO string or epoch seconds/ms) into an
// ISO string, or null when it cannot be parsed.
function normalizeUploadTimestamp(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sub2ApiAccountEmail(account) {
  const direct = [account?.credentials?.email, account?.extra?.email]
    .map((value) => String(value || "").trim().toLowerCase())
    .find(isEmail);
  if (direct) return direct;
  const match = String(account?.name || "").toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match && isEmail(match[0]) ? match[0] : null;
}

function isSub2ApiAccountInMonitoredGroups(account, groupIds) {
  if (!groupIds.length) return true;
  const accountGroupIds = [
    ...(Array.isArray(account?.group_ids) ? account.group_ids : []),
    ...(Array.isArray(account?.account_groups) ? account.account_groups.map((item) => item?.group_id) : []),
  ].map(Number).filter(Number.isSafeInteger);
  return groupIds.some((id) => accountGroupIds.includes(Number(id)));
}

function monitorBackendIdentity(config) {
  return crypto.createHash("sha256").update(String(config?.baseUrl || "")).digest("hex").slice(0, 24);
}

function isAutoRepairCoolingDown(job) {
  if (!job.autoRepairLastAttemptAt || !Number.isFinite(SUB2API_AUTO_REPAIR_COOLDOWN_MS) || SUB2API_AUTO_REPAIR_COOLDOWN_MS <= 0) return false;
  return Date.now() - new Date(job.autoRepairLastAttemptAt).getTime() < SUB2API_AUTO_REPAIR_COOLDOWN_MS;
}

function getAutoRepairEligibility(job) {
  if (job.autoRepairBlocked) return { eligible: false, reason: "账号已确认封禁、删除或永久停用" };
  if (!job.lastAuthAutomated) return { eligible: false, reason: job.lastAuthAutomationReason || "上次授权不是全自动完成" };
  const requirements = job.lastAuthRequirements || {};
  if (requirements.password && !job.password) return { eligible: false, reason: "已保存的密码无法读取" };
  if (requirements.emailOtp && !job.mailApiUrl) return { eligible: false, reason: "缺少可自动收取邮箱验证码的 API" };
  if (requirements.mfa && !job.totpSecret) return { eligible: false, reason: "已保存的 2FA 密钥无法读取" };
  if (!job.password && !job.mailApiUrl) return { eligible: false, reason: "缺少可自动登录的密码或邮件收码 API" };
  if (job.hasTotpCredential && !job.totpSecret) return { eligible: false, reason: "2FA 密钥在当前系统上无法恢复" };
  return { eligible: true, reason: "上次完整登录全自动完成，所需资料仍可用" };
}

function finishSub2ApiAutoRepairSuccess(job) {
  const operationPromise = performSub2ApiAutoRepairSuccess(job);
  sub2ApiAutoRepairPromises.add(operationPromise);
  void operationPromise.then(
    () => sub2ApiAutoRepairPromises.delete(operationPromise),
    () => sub2ApiAutoRepairPromises.delete(operationPromise),
  );
  return operationPromise;
}

async function performSub2ApiAutoRepairSuccess(job) {
  const operation = job.autoRepairOperation;
  if (!operation) return false;
  job.autoRepairPendingAccountIds = [...new Set(operation.accountIds)];
  job.autoRepairPendingBackend = operation.backend;
  try {
    const payload = await buildSub2ApiUploadPayload([job]);
    const localAccount = payload.accounts.find((account) => sub2ApiAccountEmail(account) === job.email.toLowerCase())
      || payload.accounts[0];
    if (!localAccount?.credentials) throw new Error("新授权文件中没有可更新的账号凭据");

    const pendingIds = new Set(job.autoRepairPendingAccountIds);
    for (const remoteAccount of operation.accounts) {
      const accountId = Number(remoteAccount.id);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
      const credentials = {
        ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
        ...localAccount.credentials,
      };
      const extra = {
        ...(remoteAccount.extra && typeof remoteAccount.extra === "object" ? remoteAccount.extra : {}),
        codex_fingerprint_mode: operation.config.codexFingerprintMode,
      };
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}`, {
        method: "PUT",
        body: JSON.stringify({ credentials, extra }),
      });
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}/clear-error`, {
        method: "POST",
        body: "{}",
      });
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}/schedulable`, {
        method: "POST",
        body: JSON.stringify({ schedulable: true }),
      });
      pendingIds.delete(accountId);
      job.autoRepairPendingAccountIds = [...pendingIds];
    }

    job.autoRepairLastSuccessAt = new Date().toISOString();
    job.autoRepairLastError = null;
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = null;
    job.autoRepairOperation = null;
    clearAutoRepairBlock(job);
    appendJobLog(job, `[monitor] 已用新授权覆盖更新 Sub2API 中的 ${operation.accountIds.length} 条账号记录。\n`);
    touch(job);
    await saveJobMetadata(job);
    return true;
  } catch (error) {
    job.autoRepairLastAttemptAt = new Date().toISOString();
    job.autoRepairLastError = String(error?.message || error).slice(0, 500);
    job.autoRepairOperation = null;
    appendJobLog(job, `[monitor] 新授权已生成，但更新 Sub2API 失败：${job.autoRepairLastError}。下次巡检会优先重传，不会重复登录。\n`);
    touch(job);
    await saveJobMetadata(job);
    return false;
  }
}

async function finishSub2ApiAutoRepairFailure(job) {
  if (!job.autoRepairOperation) return;
  const operation = job.autoRepairOperation;
  job.autoRepairOperation = null;
  job.autoRepairLastAttemptAt = new Date().toISOString();
  job.autoRepairLastError = job.autoRepairBlockedReason || job.lastError || "自动重新登录并授权未完成";
  appendJobLog(job, job.autoRepairBlocked
    ? "[monitor] 自动授权确认账号已永久不可用，已停止后续巡检。\n"
    : `[monitor] 本次自动授权未完成，${Math.max(1, Math.round(SUB2API_AUTO_REPAIR_COOLDOWN_MS / 60_000))} 分钟内不会重复启动。\n`);
  if (!job.autoRepairBlocked) {
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = operation.backend;
  }
  touch(job);
  await saveJobMetadata(job);
}

async function exportSourceAccounts(res, ids) {
  const selected = resolveSelectedJobs(ids);
  const lines = [];
  for (const job of selected) {
    let password = job.password || "";
    let totpSecret = job.totpSecret || "";
    if ((!password && job.hasPasswordCredential) || (!totpSecret && job.hasTotpCredential)) {
      const storedCredentials = await loadStoredLoginCredentials(job.email);
      password ||= storedCredentials.password;
      totpSecret ||= storedCredentials.totpSecret;
    }
    if ((job.loginMode === "password" || job.hasPasswordCredential) && !password) {
      throw httpError(409, `${job.email} 的密码未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (job.hasTotpCredential && !totpSecret) {
      throw httpError(409, `${job.email} 的 2FA 密钥未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (password) {
      const parts = [job.email, password];
      if (job.mailRequestBody) parts.push(job.mailRequestBody);
      else if (job.mailApiUrl) parts.push(job.mailApiUrl);
      if (totpSecret) parts.push(totpSecret);
      lines.push(parts.join("----"));
      continue;
    }
    if (job.mailRequestBody) {
      lines.push(totpSecret
        ? `${job.email}----${job.mailRequestBody}----${totpSecret}`
        : `${job.email}----${job.mailRequestBody}`);
      continue;
    }
    if (job.mailApiUrl) {
      lines.push(totpSecret
        ? `${job.email}----${job.mailApiUrl}----${totpSecret}`
        : `${job.email}----${job.mailApiUrl}`);
      continue;
    }
    if (job.loginMode === "manual") {
      throw httpError(409, `${job.email} 是旧版本任务，原始登录资料未保存，请重新导入该账号资料后再导出`);
    }
    lines.push(totpSecret ? `${job.email}--------${totpSecret}` : job.email);
  }
  const payload = Buffer.from(`\uFEFF${lines.join("\n")}\n`, "utf8");
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="chatgpt-account-source-${lines.length}-accounts-${downloadTimestamp()}.txt"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function publicJob(job) {
  const autoRepair = getAutoRepairEligibility(job);
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    prompt: job.status === "queued"
      ? (job.proxyCooldownUntil > Date.now()
        ? `同一代理 IP 刚注册过其他账号，等到 ${formatClockTime(job.proxyCooldownUntil)} 再开始`
        : `排队中，前方还有 ${Math.max(0, getQueuePosition(job) - 1)} 条任务`)
      : job.prompt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastOperationAt: job.lastOperationAt || job.createdAt,
    lastOperationType: job.lastOperationType || "initial_authorization",
    completedAt: job.completedAt,
    lastError: job.lastError,
    canDownload: Boolean(job.resultSaved),
    sub2apiUploadedAt: job.sub2apiUploadedAt || null,
    sub2apiUploadedBaseUrl: job.sub2apiUploadedBaseUrl || null,
    loginMode: job.loginMode || (job.mailApiUrl ? "email_otp" : "manual"),
    hasTotpKey: Boolean(job.totpSecret || job.hasTotpCredential),
    autoEmailOtp: Boolean(job.mailApiUrl),
    mailStatus: job.mailStatus,
    mailApiError: job.mailApiError,
    currentPhone: job.currentPhone,
    phoneError: job.phoneError,
    totpSetupSecret: job.status === "totp_setup_otp" ? job.totpSetupSecret : null,
    totpSetupUri: job.status === "totp_setup_otp" ? job.totpSetupUri : null,
    totpSetupError: job.totpSetupError || null,
    passwordAddError: job.passwordAddError || null,
    passwordAddedAt: job.passwordAddedAt || null,
    smsProviderId: job.smsProviderId,
    smsProviderName: job.smsProviderName,
    smsServiceLabel: job.smsServiceLabel,
    smsStatus: job.smsStatus,
    smsError: job.smsError,
    securityCheckRequired: Boolean(job.securityCheckRequired),
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canResume: job.status === "resume_available",
    canStart: job.status === "idle",
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canSetupTotp: canSetupTotp(job),
    canAddPassword: canAddPassword(job),
    restartRequired: job.restartRequired,
    proxyConfigured: Boolean(job.proxyUrl),
    proxyConnectionError: Boolean(job.proxyConnectionError),
    failedProxyLabel: job.failedProxyLabel || null,
    canChangeProxy: job.status === "proxy_error",
    canReconnectProxy: job.status === "proxy_error" && Boolean(job.proxyUrl),
    autoRepairEligible: autoRepair.eligible,
    autoRepairEligibilityReason: autoRepair.reason,
    autoRepairBlocked: Boolean(job.autoRepairBlocked),
    autoRepairBlockedReason: job.autoRepairBlockedReason || null,
    autoRepairLastAttemptAt: job.autoRepairLastAttemptAt || null,
    autoRepairLastSuccessAt: job.autoRepairLastSuccessAt || null,
    autoRepairLastError: job.autoRepairLastError || null,
    attempt: job.attempt,
    queuePosition: job.status === "queued" ? getQueuePosition(job) : 0,
  };
}

function publicSelectionJob(job) {
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    canDownload: Boolean(job.resultSaved),
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canStart: job.status === "idle",
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canSetupTotp: canSetupTotp(job),
    canAddPassword: canAddPassword(job),
  };
}

function canForceRelogin(job) {
  return ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);
}

function canSetupTotp(job) {
  if (job.totpSecret || job.hasTotpCredential || job.totpKnownEnabled) return false;
  if (job.status === "completed" && job.resultSaved) return true;
  return Boolean(job.loginCheckpointAvailable)
    && ["phone", "phone_otp", "resume_available", "failed", "canceled", "reauth_required"].includes(job.status);
}

function canAddPassword(job) {
  if (job.password || job.hasPasswordCredential) return false;
  if (job.status === "completed" && job.resultSaved) return true;
  return Boolean(job.loginCheckpointAvailable)
    && ["phone", "phone_otp", "resume_available", "failed", "canceled", "reauth_required"].includes(job.status);
}

// Fine-grained "current operation" updates for the full/refresh login flow.
// protocol-login.mjs emits many progress markers between the coarse stages, and
// without surfacing them the current-operation column freezes on one message
// (e.g. "verifying email code") for the whole password → 2FA → profile →
// workspace → OAuth → phone stretch. Each entry maps a worker marker to the
// working prompt shown while that step is the most recent event, in flow order.
const LOGIN_PROGRESS_STEPS = [
  ["[ok] 2FA verification accepted", "2FA 验证通过，正在继续登录"],
  ["[sentinel] Requesting a fresh security token for account profile creation.", "正在创建账号资料"],
  ["[ok] Account profile completed", "账号资料已创建，正在继续登录"],
  ["[web] Select ChatGPT login workspace", "正在选择登录工作区"],
  ["[2/5] Start Codex OAuth flow", "网页登录完成，正在进行授权"],
  ["[ok] Phone OTP validated", "手机号验证通过，正在继续授权"],
];

// Prompts that mean the worker is waiting for the operator. A progress step is
// surfaced only when it is newer than the latest of these, so a pending input
// request is never overwritten by an earlier "in progress" line that is still
// sitting in the rolling parser buffer.
const LOGIN_INPUT_MARKERS = [
  "Email OTP (r=resend, q=quit):",
  "Password (q=quit):",
  "2FA OTP (6 digits, q=quit):",
  "Phone number, E.164 format",
  "Phone OTP (r=resend, p=change phone, q=quit):",
];

function applyLoginProgress(job, scan) {
  if (job.runMode !== "full" && job.runMode !== "refresh") return;
  let stepPos = -1;
  let stepPrompt = null;
  for (const [marker, prompt] of LOGIN_PROGRESS_STEPS) {
    const pos = scan.lastIndexOf(marker);
    if (pos > stepPos) {
      stepPos = pos;
      stepPrompt = prompt;
    }
  }
  if (stepPrompt === null) return;
  let inputPos = -1;
  for (const marker of LOGIN_INPUT_MARKERS) {
    inputPos = Math.max(inputPos, scan.lastIndexOf(marker));
  }
  if (stepPos <= inputPos) return;
  if (job.status === "working" && job.prompt === stepPrompt) return;
  setStage(job, "working", stepPrompt);
}

function setStage(job, status, prompt) {
  if (isTerminalStatus(job.status)) return;
  job.status = status;
  job.prompt = prompt;
  job.lastError = null;
  // Reaching the SMS/phone step means email OTP + account creation succeeded —
  // i.e. the account was registered through its proxy IP.
  if (["phone", "phone_otp", "finalizing"].includes(status)) markRegistrationSucceeded(job);
  touch(job);
}

// A job counts as a successful registration once it has passed email OTP and
// reached the SMS step. Persisted so it survives later status changes, restarts
// and completion, and drives the per-IP "remaining registrations" quota.
function markRegistrationSucceeded(job) {
  if (job.registrationSucceeded) return;
  job.registrationSucceeded = true;
  job.registeredAt = new Date().toISOString();
  clearEmailDeactivated(job.email); // fresh account registered on this mailbox → no longer deactivated
  void recordRegistrationExitIp(job).catch(() => {});
  void saveJobMetadata(job).catch(() => {});
}

// Persist, per account, the real exit IP this registration went through, so burn/history can be
// counted by IP (not proxy host). Reuses the launch probe; probes once (cached) if it is missing.
// A rotating/no-proxy job has no fixed exit IP and is skipped.
async function recordRegistrationExitIp(job) {
  const host = fixedProxyHost(job.proxyUrl);
  if (!host) return;
  let ip = job.exitIp || null;
  if (!ip) {
    const res = await checkProxyExitIpCached(job.proxyUrl, host).catch(() => null);
    if (res?.ok && res.ip) { ip = res.ip; job.exitIp = ip; }
  }
  if (ip) recordProxyUsage(job.proxyUrl, job.email, ip);
}

function failJob(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "流程失败";
  job.lastError = message;
  if (isPermanentAccountFailure(message)) markAutoRepairBlocked(job, message);
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function beginAuthorizationAutomationAttempt(job, source) {
  job.authAutomationAttempt = {
    source,
    startedAt: new Date().toISOString(),
    requirements: { password: false, emailOtp: false, mfa: false },
    automatic: { password: false, emailOtp: false, mfa: false },
    manual: { password: false, emailOtp: false, mfa: false },
  };
}

function markAuthorizationRequirement(job, field) {
  if (!job.authAutomationAttempt?.requirements || !Object.hasOwn(job.authAutomationAttempt.requirements, field)) return;
  job.authAutomationAttempt.requirements[field] = true;
}

function markAuthorizationAutomatic(job, field) {
  if (!job.authAutomationAttempt?.automatic || !Object.hasOwn(job.authAutomationAttempt.automatic, field)) return;
  job.authAutomationAttempt.automatic[field] = true;
}

function markAuthorizationManual(job, field) {
  if (!job.authAutomationAttempt?.manual || !Object.hasOwn(job.authAutomationAttempt.manual, field)) return;
  job.authAutomationAttempt.manual[field] = true;
}

function completeAuthorizationAutomationAttempt(job) {
  const attempt = job.authAutomationAttempt;
  if (!attempt) return;
  const reasons = [];
  for (const [field, label] of [["password", "密码"], ["emailOtp", "邮箱验证码"], ["mfa", "登录 2FA 验证码"]]) {
    if (attempt.manual[field]) reasons.push(`${label}由用户手动输入`);
    else if (attempt.requirements[field] && !attempt.automatic[field]) reasons.push(`${label}未记录为自动完成`);
  }
  const hasAutomaticLoginSource = attempt.requirements.password
    || attempt.requirements.emailOtp
    || Boolean(job.password || job.mailApiUrl);
  if (!hasAutomaticLoginSource) reasons.push("没有可用于下次自动登录的密码或邮件收码接口");

  job.lastAuthAutomated = reasons.length === 0;
  job.lastAuthAutomationReason = reasons.length ? reasons.join("；") : "上次完整登录未需要人工输入密码、邮箱码或登录 2FA";
  job.lastAuthAutomatedAt = new Date().toISOString();
  job.lastAuthRequirements = { ...attempt.requirements };
  job.authAutomationAttempt = null;
  appendJobLog(job, job.lastAuthAutomated
    ? "[automation] 本次完整登录已记录为可自动修复。\n"
    : `[automation] 本次完整登录不可自动修复：${job.lastAuthAutomationReason}。\n`);
}

function clearAutoRepairBlock(job) {
  job.autoRepairBlocked = false;
  job.autoRepairBlockedReason = null;
  job.autoRepairBlockedAt = null;
}

function markAutoRepairBlocked(job, reason) {
  job.autoRepairBlocked = true;
  job.autoRepairBlockedReason = String(reason || "账号已被永久停用").slice(0, 500);
  job.autoRepairBlockedAt = new Date().toISOString();
  job.autoRepairLastError = job.autoRepairBlockedReason;
  job.autoRepairPendingAccountIds = [];
  job.autoRepairPendingBackend = null;
  job.autoRepairOperation = null;
  appendJobLog(job, "[monitor] 已确认账号被封禁、删除或永久停用，后续号池巡检将直接跳过。\n");
  // Label the mailbox as deactivated right away — don't wait for a deactivation
  // email. With no Sub2API backend the task is dropped now; with a backend the
  // monitor drops it after turning off scheduling. (Tagging is synchronous.)
  void maybeRemoveDeactivatedNow(job.email, job.autoRepairBlockedReason).catch(() => {});
}

function isPermanentAccountFailure(message) {
  const text = String(message || "");
  return /(?:account|user)_(?:deactivated|deleted|suspended|disabled)|(?:your|this) account (?:has been|is) (?:deleted|deactivated|suspended|disabled)|account has been (?:deleted|deactivated|suspended|disabled)|deleted or deactivated|do not have an account because it has been deleted/i.test(text);
}

function requireStage(job, expected) {
  if (job.status !== expected) {
    throw httpError(409, `The flow is currently at ${job.status}, not ${expected}`);
  }
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function recordJobOperation(job, type, at = new Date().toISOString()) {
  job.lastOperationAt = at;
  job.lastOperationType = type;
}

function sanitizeLog(text) {
  return String(text)
    .replace(/([?&](?:code|token|state|csrf|nonce|otp|login_hint|code_challenge)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(access_token|refresh_token|id_token|password|totp_secret|2fa_key)\s*[=:]\s*[^\s,}]+/gi, "$1=<redacted>");
}

function isActive(status) {
  return !isTerminalStatus(status);
}

function occupiesActiveSlot(job) {
  // Staged ("idle") jobs are not running, so they never take a concurrency slot.
  return isActive(job.status) && job.status !== "queued" && job.status !== "idle";
}

function formatClockTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("en-GB", { hour12: false });
}

function getQueuePosition(job) {
  if (job.status !== "queued") return 0;
  return [...jobs.values()]
    .filter((item) => item.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)))
    .findIndex((item) => item.id === job.id) + 1;
}

function isTerminalStatus(status) {
  return ["completed", "failed", "canceled", "reauth_required", "resume_available", "proxy_error"].includes(status);
}

function uniqueByJson(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listUniqueJobs() {
  const seen = new Set();
  return [...jobs.values()].sort(sortNewestFirst).filter((job) => {
    const key = job.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findJobByEmail(email) {
  const key = String(email || "").toLowerCase();
  return listUniqueJobs().find((job) => job.email.toLowerCase() === key) || null;
}

async function withEmailJobLock(email, operation) {
  const key = String(email || "").trim().toLowerCase();
  const previous = emailJobLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  emailJobLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (emailJobLocks.get(key) === current) emailJobLocks.delete(key);
  }
}

function resolveSelectedJobs(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw httpError(400, "请至少选择一条任务");
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多操作 ${MAX_BATCH_JOBS} 条任务`);
  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  return selected;
}

async function deleteJobsByEmail(email) {
  const matching = [...jobs.values()].filter((job) => job.email.toLowerCase() === email);
  const directories = new Set();
  matching.forEach((job) => {
    job.deleted = true;
    stopMailPolling(job);
    releaseSmsNumber(job, "idle");
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    directories.add(path.dirname(job.outputPath));
    jobs.delete(job.id);
  });
  try { jobDao.deleteByIds(matching.map((j) => j.id)); } catch {}
  await Promise.allSettled(matching.map((job) => job.metadataWritePromise).filter(Boolean));
  await Promise.all([
    ...[...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    deleteStoredLoginCredentials(email),
  ]);
  scheduleQueuedJobs();
}

function downloadTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function syncCompletedOutputs(force = false) {
  if (!force && Date.now() - lastOutputSyncAt < 2_000) return;
  if (outputSyncPromise) return outputSyncPromise;
  outputSyncPromise = (async () => {
    lastOutputSyncAt = Date.now();
    let entries = [];
    try {
      entries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      if (jobs.has(entry.name)) return;
      const outputDir = path.join(OUTPUT_ROOT, entry.name);
      const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
      const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
      const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
      const passwordAddResultPath = path.join(outputDir, PASSWORD_ADD_RESULT_FILENAME);
      let metadata = {};
      try {
        metadata = JSON.parse(await fs.readFile(path.join(outputDir, JOB_META_FILENAME), "utf8"));
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(outputPath, "utf8"), fs.stat(outputPath)]);
        const data = JSON.parse(raw);
        if (data.type !== "sub2api-data" || !Array.isArray(data.accounts) || !data.accounts.length) throw new Error("invalid output");
        const account = data.accounts[0];
        const email = metadata.email || account?.credentials?.email || account?.extra?.email || account?.name || `restored-${entry.name}`;
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        let storedCredentials = await loadStoredLoginCredentials(email);
        const completedAt = stat.mtime.toISOString();
        const updatedAt = metadata.updated_at || completedAt;
        const passwordRecovery = await recoverAddedPasswordCredential({
          email,
          resultPath: passwordAddResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = passwordRecovery.credentials;
        const totpRecovery = await recoverActivatedTotpCredential({
          email,
          resultPath: totpResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = totpRecovery.credentials;
        const restoredOperation = restoredOutputOperationState(metadata, completedAt, totpRecovery, passwordRecovery);
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredOperation.status,
          prompt: restoredOperation.prompt,
          createdAt: metadata.created_at || completedAt,
          updatedAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || completedAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: metadata.completed_at || completedAt,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: restoredOperation.log,
          lastError: restoredOperation.lastError,
          child: null,
          parserTail: "",
          resultSaved: true,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          tlsProfile: restoredTlsProfile(metadata),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredRegistrationState(metadata),
          ...restoredAutoRepairState(metadata),
          ...restoredSub2ApiUploadState(metadata),
          totpSetupError: restoredOperation.totpSetupError,
          passwordAddError: restoredOperation.passwordAddError,
          passwordAddedAt: metadata.password_added_at || passwordRecovery.addedAt || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: false,
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
          smsCostEvents: Array.isArray(metadata.sms_cost_events) ? metadata.sms_cost_events : [],
        });
        return;
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(checkpointPath, "utf8"), fs.stat(checkpointPath)]);
        const checkpoint = JSON.parse(raw);
        if (checkpoint?.version !== 1 || typeof checkpoint.email !== "string" || !checkpoint.email) return;
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const email = metadata.email || checkpoint.email;
        let storedCredentials = await loadStoredLoginCredentials(email);
        const passwordRecovery = await recoverAddedPasswordCredential({
          email,
          resultPath: passwordAddResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = passwordRecovery.credentials;
        const totpRecovery = await recoverActivatedTotpCredential({
          email,
          resultPath: totpResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = totpRecovery.credentials;
        const restoredAt = stat.mtime.toISOString();
        const savedStatus = String(metadata.status || "");
        const restoredStatus = passwordRecovery.recovered || totpRecovery.recovered
          ? "resume_available"
          : isTerminalStatus(savedStatus) ? savedStatus : "resume_available";
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredStatus,
          prompt: totpRecovery.recovered
            ? "已恢复成功激活的 2FA 密钥，可以继续未完成的 Codex 授权"
            : passwordRecovery.recovered
              ? "已恢复成功添加的新密码，可以继续未完成的 Codex 授权"
            : metadata.prompt || (restoredStatus === "resume_available"
              ? "检测到邮箱登录检查点，可以继续手机号绑定"
              : "已恢复上次操作状态，登录检查点仍然保留"),
          createdAt: metadata.created_at || restoredAt,
          updatedAt: metadata.updated_at || restoredAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || restoredAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: null,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: totpRecovery.recovered
            ? "[restore] 已从中断的 2FA 设置流程恢复并安全保存密钥。\n"
            : passwordRecovery.recovered
              ? "[restore] 已从中断的添加密码流程恢复并安全保存新密码。\n"
            : `[restore] 已恢复 ${checkpoint.stage || "unknown"} 阶段的登录检查点。\n`,
          lastError: passwordRecovery.recovered || totpRecovery.recovered
            ? "ChatGPT 登录状态已保留，点击继续流程即可重新开始 Codex 授权"
            : metadata.last_error || (restoredStatus === "resume_available"
              ? "上次流程在生成授权文件前中断"
              : null),
          child: null,
          parserTail: "",
          resultSaved: false,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: checkpoint.oauth?.phone || metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          tlsProfile: restoredTlsProfile(metadata),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredRegistrationState(metadata),
          ...restoredAutoRepairState(metadata),
          ...restoredSub2ApiUploadState(metadata),
          totpSetupError: totpRecovery.error || null,
          passwordAddError: passwordRecovery.error || metadata.password_add_error || null,
          passwordAddedAt: metadata.password_added_at || passwordRecovery.addedAt || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: true,
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...restoredSmsState(metadata),
          smsCostEvents: Array.isArray(metadata.sms_cost_events) ? metadata.sms_cost_events : [],
        });
      } catch {
        if (
          !metadata.email
          || !isEmail(metadata.email)
        ) return;
        const storedCredentials = await loadStoredLoginCredentials(metadata.email);
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const restoredAt = metadata.updated_at || new Date().toISOString();
        const missingStoredCredentials = restoredMissingCredentials(metadata, storedCredentials);
        const storedCredentialsMissing = missingStoredCredentials.length > 0;
        const savedStatus = String(metadata.status || "");
        const restartable = ["queued", "starting"].includes(savedStatus);
        // Staged ("idle") jobs never ran, so they are not "interrupted" — keep them idle.
        const interrupted = Boolean(savedStatus) && !isTerminalStatus(savedStatus) && !restartable && savedStatus !== "idle";
        const restoredStatus = storedCredentialsMissing && restartable
          ? "reauth_required"
          : restartable
            ? "queued"
            : interrupted || !savedStatus
              ? "failed"
              : savedStatus;
        const restoredPrompt = storedCredentialsMissing && restartable
          ? "登录资料需要重新确认"
          : restartable
            ? "服务重启后已恢复，等待任务槽位"
            : interrupted || !savedStatus
              ? "上次流程因服务重启中断，可以重新授权"
              : metadata.prompt || "已恢复上次任务状态";
        const restoredError = storedCredentialsMissing && restartable
          ? `请重新导入或填写${missingStoredCredentials.join("、")}后重试，任务不会使用缺失的资料自动登录`
          : interrupted || !savedStatus
            ? metadata.last_error || `上次 ${savedStatus || "未知"} 阶段未完成`
            : metadata.last_error || null;
        jobs.set(entry.name, {
          id: entry.name,
          email: metadata.email,
          status: restoredStatus,
          prompt: restoredPrompt,
          createdAt: metadata.created_at || restoredAt,
          updatedAt: restoredAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || restoredAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: metadata.completed_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: storedCredentialsMissing && restartable
            ? `[restore] 系统安全凭据存储中无法恢复${missingStoredCredentials.join("、")}，已停止自动启动。\n`
            : restartable
              ? "[restore] 已恢复排队任务，等待可用任务槽位。\n"
              : interrupted || !savedStatus
                ? "[restore] 上次任务在生成授权文件前中断，已恢复为可重试状态。\n"
                : "[restore] 已恢复上次任务状态。\n",
          lastError: restoredError,
          child: null,
          parserTail: "",
          resultSaved: false,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "baseline" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || null,
          phoneError: null,
          restartRequired: restoredStatus === "reauth_required",
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          tlsProfile: restoredTlsProfile(metadata),
          runId: null,
          runMode: null,
          queuedMode: restoredStatus === "queued" && metadata.queued_mode === "refresh" ? "refresh" : "full",
          queuedAt: restoredStatus === "queued" ? metadata.queued_at || restoredAt : null,
          queuedStartPrompt: metadata.queued_mode === "refresh"
            ? "正在使用已有刷新令牌直接生成新授权"
            : "正在建立登录会话",
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredRegistrationState(metadata),
          ...restoredAutoRepairState(metadata),
          ...restoredSub2ApiUploadState(metadata),
          passwordAddError: metadata.password_add_error || null,
          passwordAddedAt: metadata.password_added_at || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: Boolean(metadata.login_checkpoint_available),
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
          smsCostEvents: Array.isArray(metadata.sms_cost_events) ? metadata.sms_cost_events : [],
        });
      }
    }));
  })().finally(() => {
    outputSyncPromise = null;
  });
  return outputSyncPromise;
}

async function recoverActivatedTotpCredential({ email, resultPath, credentials }) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { credentials, recovered: false, error: null };
    return { credentials, recovered: false, error: `2FA 结果文件无法读取：${error.message}` };
  }
  if (result?.activation_succeeded !== true || !result?.secret) {
    return { credentials, recovered: false, error: null };
  }
  try {
    const secret = normalizeTotpSecret(result.secret);
    const nextCredentials = { ...credentials, totpSecret: secret };
    const persisted = await saveStoredLoginCredentials(email, nextCredentials);
    if (!persisted) {
      return {
        credentials: nextCredentials,
        recovered: false,
        error: "2FA 已激活，但当前系统不支持持久凭据存储；结果文件已保留",
      };
    }
    await removePrivateFile(resultPath);
    return { credentials: nextCredentials, recovered: true, error: null };
  } catch (error) {
    return {
      credentials,
      recovered: false,
      error: `2FA 已激活，但密钥恢复失败：${error.message}；结果文件已保留`,
    };
  }
}

async function recoverAddedPasswordCredential({ email, resultPath, credentials }) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { credentials, recovered: false, error: null, addedAt: null };
    return { credentials, recovered: false, error: `添加密码结果文件无法读取：${error.message}`, addedAt: null };
  }
  if (
    result?.version !== 1
    || String(result.email || "").toLowerCase() !== email.toLowerCase()
    || typeof result.password !== "string"
    || result.password.length < 12
  ) {
    return { credentials, recovered: false, error: "添加密码结果文件格式不正确", addedAt: null };
  }
  const nextCredentials = { ...credentials, password: result.password };
  try {
    const persisted = await saveStoredLoginCredentials(email, nextCredentials);
    if (!persisted) {
      return {
        credentials: nextCredentials,
        recovered: false,
        error: "密码已经添加，但当前系统不支持持久凭据存储；结果文件已保留",
        addedAt: result.added_at || null,
      };
    }
    await removePrivateFile(resultPath);
    return { credentials: nextCredentials, recovered: true, error: null, addedAt: result.added_at || null };
  } catch (error) {
    return {
      credentials,
      recovered: false,
      error: `密码已经添加，但新密码恢复失败：${error.message}；结果文件已保留`,
      addedAt: result.added_at || null,
    };
  }
}

function restoredOutputOperationState(metadata, completedAt, totpRecovery, passwordRecovery) {
  const savedStatus = String(metadata.status || "");
  const interrupted = savedStatus && !isTerminalStatus(savedStatus);
  const status = !savedStatus || savedStatus === "completed"
    ? "completed"
    : interrupted ? "failed" : savedStatus;
  if (passwordRecovery.recovered) {
    return {
      status: "completed",
      prompt: "已恢复上次成功添加的新密码，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: null,
      log: "[restore] 已从中断的添加密码流程恢复并安全保存新密码。\n",
    };
  }
  if (passwordRecovery.error) {
    return {
      status: "completed",
      prompt: "原授权文件仍可下载，新密码需要重试恢复",
      lastError: null,
      totpSetupError: null,
      passwordAddError: passwordRecovery.error,
      log: `[restore] ${passwordRecovery.error}\n`,
    };
  }
  if (savedStatus.startsWith("password_add") || metadata.queued_mode === "password_add") {
    return {
      status: "completed",
      prompt: "服务重启中断了添加密码，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: "添加密码尚未完成，请重新点击添加密码",
      log: "[restore] 添加密码被服务重启中断，旧授权文件未受影响。\n",
    };
  }
  if (totpRecovery.recovered) {
    return {
      status: "completed",
      prompt: "已恢复上次成功激活的 2FA 密钥，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: null,
      log: "[restore] 已从中断的 2FA 设置流程恢复并安全保存密钥。\n",
    };
  }
  if (totpRecovery.error) {
    return {
      status: "completed",
      prompt: "原授权文件仍可下载，2FA 密钥需要重试恢复",
      lastError: metadata.last_error || null,
      totpSetupError: totpRecovery.error,
      passwordAddError: null,
      log: `[restore] ${totpRecovery.error}\n`,
    };
  }
  if (interrupted) {
    return {
      status,
      prompt: "上次操作因服务重启中断，旧授权文件仍可下载",
      lastError: metadata.last_error || `上次 ${savedStatus} 阶段未完成`,
      totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
      passwordAddError: savedStatus.startsWith("password_add") ? "服务重启时添加密码未完成，请重新发起" : null,
      log: "[restore] 检测到旧授权文件，同时保留了上次中断的操作状态。\n",
    };
  }
  return {
    status,
    prompt: metadata.prompt || (status === "completed"
      ? "已从本地输出目录恢复，可以下载导入文件"
      : "旧授权文件仍可下载，已恢复最近一次操作状态"),
    lastError: metadata.last_error || null,
    totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
    passwordAddError: metadata.password_add_error || null,
    log: `[restore] 已恢复任务状态，旧授权文件时间 ${completedAt}。\n`,
  };
}

function isEmail(value) {
  const text = String(value || "");
  if (!text || text.length > 254 || /\s/.test(text)) return false;
  const at = text.lastIndexOf("@");
  if (at <= 0 || at !== text.indexOf("@")) return false;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => (
    !label
    || label.length > 63
    || label.startsWith("-")
    || label.endsWith("-")
    || !/^[A-Z0-9-]+$/i.test(label)
  ))) return false;
  const topLevelDomain = labels.at(-1);
  if (!/^(?:[A-Z]{2,63}|XN--[A-Z0-9-]{2,59})$/i.test(topLevelDomain)) return false;
  return true;
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw httpError(400, "账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址");
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw httpError(400, "账号代理只支持 http、https、socks5 和 socks5h 协议");
  }
  return parsed.toString();
}

function normalizeLoginCredentials(value = {}) {
  const password = typeof value.password === "string" ? value.password : "";
  const mailRequestBody = typeof value.mailRequestBody === "string" ? value.mailRequestBody : "";
  const configuredPostUrl = mailRequestConfig.method === "POST" && validateMailApiUrl(mailRequestConfig.url)
    ? mailRequestConfig.url
    : null;
  const mailApiUrl = validateMailApiUrl(value.mailApiUrl)
    ? String(value.mailApiUrl).trim()
    : mailRequestBody && configuredPostUrl
      ? configuredPostUrl
      : null;
  const totpSecret = value.totpSecret ? normalizeTotpSecret(value.totpSecret) : "";
  const loginMode = password ? "password" : "email_otp";
  return { loginMode, mailApiUrl, mailRequestBody, password, totpSecret };
}

function restoredCredentialFlags(metadata = {}, credentials = {}) {
  const hasExplicitPasswordFlag = Object.hasOwn(metadata, "has_password");
  const hasExplicitTotpFlag = Object.hasOwn(metadata, "has_totp_key");
  return {
    hasPasswordCredential: Boolean(
      credentials.password
      || (hasExplicitPasswordFlag ? metadata.has_password : metadata.login_mode === "password" && metadata.has_stored_credentials),
    ),
    hasTotpCredential: Boolean(
      credentials.totpSecret
      || (hasExplicitTotpFlag ? metadata.has_totp_key : metadata.has_stored_credentials),
    ),
  };
}

function restoredTotpSetupState(metadata = {}, credentials = {}) {
  return {
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpKnownEnabled: Boolean(metadata.totp_known_enabled || credentials.totpSecret),
    totpSetupAttempt: 0,
    totpResultLoading: false,
  };
}

function restoredProxyRiskState(metadata = {}) {
  const count = Number(metadata.proxy_risk_retry_count || 0);
  const connectionFailures = Number(metadata.proxy_connection_failure_count || 0);
  return {
    proxyRiskRetryCount: Number.isInteger(count) && count >= 0 ? Math.min(count, MAX_PROXY_RISK_RETRIES) : 0,
    proxyConnectionFailureCount: Number.isInteger(connectionFailures) && connectionFailures >= 0
      ? Math.min(connectionFailures, MAX_PROXY_CONNECTION_FAILURES)
      : 0,
    proxyRiskRestarting: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
    proxyConnectionError: Boolean(metadata.proxy_connection_error),
    failedProxyLabel: metadata.failed_proxy_label || null,
  };
}

// Restore whether a job already counted as a registered account. Older metadata
// (before this flag existed) is inferred from a status that is at/after the SMS
// step, or from a saved result.
function restoredRegistrationState(metadata = {}) {
  const reachedSms = ["phone", "phone_otp", "finalizing", "completed"].includes(String(metadata.status || ""));
  const succeeded = Boolean(metadata.registration_succeeded) || reachedSms || Boolean(metadata.result_saved);
  return {
    registrationSucceeded: succeeded,
    registeredAt: metadata.registered_at || (succeeded ? (metadata.updated_at || metadata.created_at || null) : null),
  };
}

function restoredAutoRepairState(metadata = {}) {
  const requirements = metadata.last_auth_requirements;
  const pendingIds = Array.isArray(metadata.auto_repair_pending_account_ids)
    ? metadata.auto_repair_pending_account_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  return {
    lastAuthAutomated: metadata.last_auth_automated === true,
    lastAuthAutomationReason: String(metadata.last_auth_automation_reason || "旧任务没有自动化参与记录"),
    lastAuthAutomatedAt: metadata.last_auth_automated_at || null,
    lastAuthRequirements: requirements && typeof requirements === "object"
      ? {
          password: Boolean(requirements.password),
          emailOtp: Boolean(requirements.emailOtp),
          mfa: Boolean(requirements.mfa),
        }
      : null,
    authAutomationAttempt: null,
    autoRepairBlocked: metadata.auto_repair_blocked === true,
    autoRepairBlockedReason: metadata.auto_repair_blocked_reason || null,
    autoRepairBlockedAt: metadata.auto_repair_blocked_at || null,
    autoRepairLastAttemptAt: metadata.auto_repair_last_attempt_at || null,
    autoRepairLastSuccessAt: metadata.auto_repair_last_success_at || null,
    autoRepairLastError: metadata.auto_repair_last_error || null,
    autoRepairPendingAccountIds: [...new Set(pendingIds)],
    autoRepairPendingBackend: metadata.auto_repair_pending_backend || null,
    autoRepairOperation: null,
  };
}

function restoredSub2ApiUploadState(metadata = {}) {
  return {
    sub2apiUploadedAt: metadata.sub2api_uploaded_at || null,
    sub2apiUploadedBaseUrl: metadata.sub2api_uploaded_base_url || null,
  };
}

function restoredMissingCredentials(metadata = {}, credentials = {}) {
  const missing = [];
  const passwordRequired = Object.hasOwn(metadata, "has_password")
    ? metadata.has_password
    : metadata.login_mode === "password" && metadata.has_stored_credentials;
  const totpRequired = Object.hasOwn(metadata, "has_totp_key")
    ? metadata.has_totp_key
    : metadata.has_stored_credentials && !passwordRequired;
  if (passwordRequired && !credentials.password) missing.push("密码");
  if (totpRequired && !credentials.totpSecret) missing.push("2FA 密钥");
  if (metadata.proxy_configured && !credentials.proxyUrl) missing.push("代理 IP");
  return missing;
}

function normalizeTotpSecret(value, lineNumber = null) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
    const prefix = lineNumber ? `第 ${lineNumber} 行` : "";
    throw httpError(400, `${prefix}2FA 密钥格式错误，只能包含 Base32（基础三十二进制）的 A-Z 和 2-7`);
  }
  return normalized;
}

function parseBatchEntries(value, requestConfig = {}) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw httpError(400, "请至少输入一行账号信息");
  if (lines.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多添加 ${MAX_BATCH_JOBS} 条任务`);

  const entries = lines.map((line, index) => (
    requestConfig.method === "POST" && !isEmail(line)
      ? parsePostMailAccountLine(line, index + 1, requestConfig)
      : parseSmartAccountLine(line, index + 1)
  ));

  const unique = new Map();
  entries.forEach((entry) => unique.set(entry.email.toLowerCase(), entry));
  return [...unique.values()];
}

function parsePostMailAccountLine(line, lineNumber, requestConfig) {
  if (!validateMailApiUrl(requestConfig.url)) {
    throw httpError(400, "POST 邮件接码模式需要先在控制台配置统一请求 URL");
  }
  const fields = line.split("----").map((value) => value.trim());
  if (fields.length < 2) {
    throw httpError(400, `第 ${lineNumber} 行格式错误，POST 邮件接码请使用 邮箱----编码请求体`);
  }
  const emailFields = fields.map((value, index) => ({ value, index })).filter((field) => isEmail(field.value));
  if (emailFields.length !== 1) throw httpError(400, `第 ${lineNumber} 行必须包含一个独立邮箱`);
  const emailField = emailFields[0];
  const remaining = fields
    .map((value, index) => ({ value, index }))
    .filter((field) => field.index !== emailField.index && field.value);
  if (!remaining.length) throw httpError(400, `第 ${lineNumber} 行缺少 POST 请求体`);

  let totpField = null;
  if (remaining.length >= 2) {
    const totpCandidates = remaining.filter((field) => isTotpSecretCandidate(field.value));
    if (totpCandidates.length === 1) totpField = totpCandidates[0];
  }
  const bodyAndPassword = remaining.filter((field) => field !== totpField);
  const recognizableBodies = bodyAndPassword.filter((field) => looksLikeEncodedMailRequestBody(field.value));
  const bodyField = recognizableBodies.length === 1 ? recognizableBodies[0] : bodyAndPassword.at(-1);
  const passwordFields = bodyAndPassword.filter((field) => field !== bodyField);
  if (passwordFields.length > 1) {
    throw httpError(400, `第 ${lineNumber} 行无法区分密码和 POST 请求体，请将编码请求体放在最后`);
  }
  const mailRequestBody = bodyField?.value || "";
  const password = passwordFields[0]?.value || "";
  if (Buffer.byteLength(mailRequestBody) > MAX_MAIL_REQUEST_BODY_BYTES) {
    throw httpError(400, `第 ${lineNumber} 行 POST 请求体不能超过 64 KB`);
  }
  return {
    email: emailField.value,
    loginMode: password ? "password" : "email_otp",
    mailApiUrl: requestConfig.url,
    mailRequestBody,
    password,
    totpSecret: totpField ? normalizeTotpSecret(totpField.value, lineNumber) : "",
  };
}

function looksLikeEncodedMailRequestBody(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^[{\[]/.test(text)) {
    try {
      JSON.parse(text);
      return true;
    } catch {}
  }
  if (/(?:^|&)[^=&\s]+=[^&]*(?:&|$)/.test(text) || /%[0-9A-F]{2}/i.test(text)) return true;
  const compact = text.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) && compact.length >= 12) {
    try {
      const decoded = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim();
      return /^[{\[]/.test(decoded) || /(?:^|&)[^=&\s]+=[^&]*(?:&|$)/.test(decoded);
    } catch {}
  }
  return false;
}

function parseSmartAccountLine(line, lineNumber) {
  if (isEmail(line)) {
    return {
      email: line,
      loginMode: "email_otp",
      mailApiUrl: null,
      password: "",
      totpSecret: "",
      preserveExistingCredentials: true,
    };
  }

  const parsed = accountDelimiterCandidates(line)
    .map((delimiter) => parseAccountLineWithDelimiter(line, delimiter, lineNumber))
    .filter(Boolean);
  const ambiguity = parsed.find((candidate) => candidate.ambiguity);
  if (ambiguity) throw httpError(400, `第 ${lineNumber} 行${ambiguity.ambiguity}`);

  const candidates = parsed
    .sort(compareAccountParseCandidates);
  if (!candidates.length) {
    const unsupportedHyphenRun = [...line.matchAll(/-+/g)].find((match) => (
      match[0].length === 5 || match[0].length > 8
    ));
    if (unsupportedHyphenRun) {
      throw httpError(400, `第 ${lineNumber} 行存在 ${unsupportedHyphenRun[0].length} 个连续短横线，无法确定是分隔符还是字段内容，请改用 | 或 Tab 分隔`);
    }
    throw httpError(400, `第 ${lineNumber} 行无法识别出独立邮箱和账号字段`);
  }
  const best = candidates[0];
  const conflicting = candidates.find((candidate) => (
    candidate.recognizedCount === best.recognizedCount
    && accountParseSignature(candidate) !== accountParseSignature(best)
  ));
  if (conflicting) {
    throw httpError(400, `第 ${lineNumber} 行存在多种可能的字段分隔方式，请改用 ---- 明确分隔`);
  }
  if (passwordContainsStructuredField(best.entry.password)) {
    throw httpError(400, `第 ${lineNumber} 行似乎混用了多种分隔符，密码中又识别到 URL 或 2FA 密钥，请统一改用 ---- 分隔`);
  }
  return best.entry;
}

function accountDelimiterCandidates(line) {
  const candidates = [
    { id: "hyphen-4", split: (value) => splitHyphenDelimitedLine(value, 4), priority: 110 },
    { id: "hyphen-3", split: (value) => splitHyphenDelimitedLine(value, 3), priority: 105 },
    { id: "hyphen-mixed", split: (value) => splitMixedHyphenDelimitedLine(value), priority: 100 },
    { id: "tab", pattern: /\t+/g, priority: 80 },
    { id: "pipe", pattern: /\|+/g, priority: 70 },
    { id: "double-colon", pattern: /:{2,}/g, priority: 65 },
    { id: "semicolon", pattern: /[;；]+/g, priority: 60 },
    { id: "comma", pattern: /[,，]+/g, priority: 55 },
    { id: "spaces", pattern: / {2,}/g, priority: 40 },
  ];
  const repeated = line.match(/([#~^*])\1+/g) || [];
  for (const delimiter of new Set(repeated)) {
    candidates.push({
      id: `repeated-${delimiter[0].codePointAt(0)}`,
      pattern: new RegExp(escapeRegExp(delimiter), "g"),
      priority: 35 + delimiter.length,
    });
  }
  return candidates;
}

function parseAccountLineWithDelimiter(line, delimiter, lineNumber) {
  const split = delimiter.split ? delimiter.split(line) : splitPreservingDelimiters(line, delimiter.pattern);
  if (split.separators.length === 0) return null;
  if (split.segments.length > 64) return null;
  const fields = split.segments.map((raw, index) => ({ raw, value: raw.trim(), index, type: "plain" }));
  if (fields.filter((field) => isEmail(field.value)).length > 1) {
    return { ambiguity: "中识别到多个完整邮箱，无法确定哪个是账号" };
  }
  const emailRange = findLongestEmailRange(split);
  if (!emailRange) return null;
  for (let index = emailRange.start; index <= emailRange.end; index += 1) fields[index].type = "email";

  const urls = fields.filter((field) => field.type === "plain" && validateMailApiUrl(field.value));
  if (urls.length > 1) return null;
  if (["comma", "semicolon"].includes(delimiter.id) && urls.some((field) => (
    adjacentPlainFieldCanExtendUrl(fields, split, field)
  ))) {
    return { ambiguity: "中的 URL 可能包含逗号或分号，请改用 ---- 分隔字段" };
  }
  for (const field of urls) field.type = "mail_api";

  const remaining = fields.filter((field) => field.type === "plain" && field.value);
  const totpCandidates = remaining.filter((field) => isTotpSecretCandidate(field.value));
  const emptyFieldPresent = fields.some((field) => !field.value);
  let totp = null;
  let totpValue = "";
  if (totpCandidates.length === 1) {
    const candidate = totpCandidates[0];
    const otherPlain = remaining.filter((field) => field !== candidate);
    const followsMailApi = urls.some((field) => field.index < candidate.index);
    if (otherPlain.length > 0 || followsMailApi || emptyFieldPresent) {
      totp = candidate;
      totp.type = "totp";
      totpValue = totp.value;
    }
  } else if (totpCandidates.length > 1) {
    const conventionalPasswordTotp = delimiter.id.startsWith("hyphen-")
      && split.separators.length === 2
      && fields.length === 3
      && emailRange.start === 0
      && emailRange.end === 0
      && urls.length === 0
      && totpCandidates.length === 2
      && totpCandidates[0].index === 1
      && totpCandidates[1].index === 2;
    if (!conventionalPasswordTotp) return null;
    // A 16-character password can also look like Base32; in email----password----2FA, the final field is 2FA.
    totp = totpCandidates[1];
    totp.type = "totp";
    totpValue = totp.value;
  }
  if (!totp && delimiter.id === "spaces") {
    const groupedTotp = findGroupedTotpCandidate(fields, split);
    if (groupedTotp) {
      const outsidePlain = remaining.filter((field) => (
        field.index < groupedTotp.start || field.index > groupedTotp.end
      ));
      if (outsidePlain.length > 0 || urls.length > 0 || emptyFieldPresent) {
        for (let index = groupedTotp.start; index <= groupedTotp.end; index += 1) fields[index].type = "totp";
        totp = fields[groupedTotp.start];
        totpValue = groupedTotp.value;
      }
    }
  }

  const passwordFields = fields.filter((field) => field.type === "plain" && field.value);
  if (passwordFields.length && !indexesAreContiguous(passwordFields.map((field) => field.index))) return null;
  const password = passwordFields.length
    ? reconstructSegmentRange(split, passwordFields[0].index, passwordFields.at(-1).index).trim()
    : "";
  if (!password && !urls.length && !totp) return null;

  const recognizedCount = 1 + urls.length + Number(Boolean(totp));
  const score = recognizedCount * 1_000
    + Number(Boolean(password)) * 100
    + delimiter.priority
    - Math.max(0, split.separators.length - 3);
  return {
    score,
    recognizedCount,
    delimiter: delimiter.id,
    entry: {
      email: emailRange.value,
      loginMode: password ? "password" : "email_otp",
      mailApiUrl: urls[0]?.value || null,
      password,
      totpSecret: totp ? normalizeTotpSecret(totpValue, lineNumber) : "",
    },
  };
}

function splitHyphenDelimitedLine(line, width) {
  return splitWithSelectedMatches(line, [...line.matchAll(/-+/g)].flatMap((match) => {
    if (match[0].length === width) return [{ index: match.index, value: match[0] }];
    if (match[0].length === width * 2) {
      return [
        { index: match.index, value: "-".repeat(width) },
        { index: match.index + width, value: "-".repeat(width) },
      ];
    }
    return [];
  }));
}

function splitMixedHyphenDelimitedLine(line) {
  return splitWithSelectedMatches(line, [...line.matchAll(/-+/g)].flatMap((match) => {
    const length = match[0].length;
    if (length === 3 || length === 4) return [{ index: match.index, value: match[0] }];
    if (length >= 6 && length <= 8) {
      const firstLength = length === 6 ? 3 : 4;
      return [
        { index: match.index, value: "-".repeat(firstLength) },
        { index: match.index + firstLength, value: "-".repeat(length - firstLength) },
      ];
    }
    return [];
  }));
}

function splitWithSelectedMatches(line, matches) {
  const segments = [];
  const separators = [];
  let cursor = 0;
  for (const match of matches) {
    segments.push(line.slice(cursor, match.index));
    separators.push(match.value);
    cursor = match.index + match.value.length;
  }
  segments.push(line.slice(cursor));
  return { segments, separators };
}

function splitPreservingDelimiters(line, pattern) {
  const segments = [];
  const separators = [];
  pattern.lastIndex = 0;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    segments.push(line.slice(cursor, match.index));
    separators.push(match[0]);
    cursor = match.index + match[0].length;
  }
  segments.push(line.slice(cursor));
  return { segments, separators };
}

function reconstructSegmentRange(split, start, end) {
  let result = split.segments[start];
  for (let index = start; index < end; index += 1) {
    result += split.separators[index] + split.segments[index + 1];
  }
  return result;
}

function findLongestEmailRange(split) {
  const candidates = [];
  for (let start = 0; start < split.segments.length; start += 1) {
    for (let end = start; end < split.segments.length; end += 1) {
      const value = reconstructSegmentRange(split, start, end).trim();
      const atCount = (value.match(/@/g) || []).length;
      if (atCount > 1) break;
      if (atCount === 1 && isEmail(value)) candidates.push({ start, end, value });
    }
  }
  if (!candidates.length) return null;
  const leadingCandidates = candidates.filter((candidate) => candidate.start === 0);
  const standaloneCandidates = candidates.filter((candidate) => candidate.start === candidate.end);
  // A complete segment is a stronger signal than a longer range. Otherwise a
  // dotted password can be appended to a valid email and still look like a
  // valid domain (for example, email----r7.UjRUWVVS).
  const preferred = standaloneCandidates.length ? standaloneCandidates : leadingCandidates;
  if (!preferred.length) return null;
  preferred.sort((left, right) => (
    right.value.length - left.value.length
    || (right.end - right.start) - (left.end - left.start)
    || left.start - right.start
  ));
  const best = preferred[0];
  const conflicting = preferred.find((candidate) => (
    candidate.value.length === best.value.length && candidate.value.toLowerCase() !== best.value.toLowerCase()
  ));
  return conflicting ? null : best;
}

function adjacentPlainFieldCanExtendUrl(fields, split, urlField) {
  for (const adjacentIndex of [urlField.index - 1, urlField.index + 1]) {
    const adjacent = fields[adjacentIndex];
    if (!adjacent || adjacent.type !== "plain" || !adjacent.value) continue;
    const start = Math.min(urlField.index, adjacentIndex);
    const end = Math.max(urlField.index, adjacentIndex);
    if (validateMailApiUrl(reconstructSegmentRange(split, start, end).trim())) return true;
  }
  return false;
}

function findGroupedTotpCandidate(fields, split) {
  const candidates = [];
  for (let start = 0; start < fields.length; start += 1) {
    if (fields[start].type !== "plain" || !/^[A-Z2-7=]{4,8}$/i.test(fields[start].value)) continue;
    for (let end = start + 1; end < fields.length; end += 1) {
      if (fields[end].type !== "plain" || !/^[A-Z2-7=]{4,8}$/i.test(fields[end].value)) break;
      const value = reconstructSegmentRange(split, start, end);
      if (isTotpSecretCandidate(value)) candidates.push({ start, end, value });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => (right.end - right.start) - (left.end - left.start));
  const best = candidates[0];
  return candidates.some((candidate) => (
    candidate !== best
    && candidate.end - candidate.start === best.end - best.start
    && (candidate.start !== best.start || candidate.end !== best.end)
  )) ? null : best;
}

function isTotpSecretCandidate(value) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  return /^[A-Z2-7]{16,128}$/.test(normalized);
}

function passwordContainsStructuredField(password) {
  const text = String(password || "");
  if (!text) return false;
  const patterns = [/-{3,4}/g, /\|+/g, /:{2,}/g, /[;；]+/g, /[,，]+/g, / {2,}/g];
  return patterns.some((pattern) => {
    const split = splitPreservingDelimiters(text, pattern);
    return split.separators.length > 0 && split.segments.some((segment) => (
      validateMailApiUrl(segment.trim()) || isTotpSecretCandidate(segment.trim())
    ));
  });
}

function indexesAreContiguous(indexes) {
  return indexes.every((value, index) => index === 0 || value === indexes[index - 1] + 1);
}

function compareAccountParseCandidates(left, right) {
  return right.score - left.score || left.delimiter.localeCompare(right.delimiter);
}

function accountParseSignature(candidate) {
  const { email, mailApiUrl, mailRequestBody, password, totpSecret } = candidate.entry;
  return JSON.stringify({ email: email.toLowerCase(), mailApiUrl, mailRequestBody, password, totpSecret });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function updateJobCredentials(job, credentials, options = {}) {
  if (credentials.preserveExistingCredentials) await reloadMissingJobCredentials(job);
  const normalized = credentials.preserveExistingCredentials
    ? normalizeLoginCredentials({
        password: job.password,
        mailApiUrl: job.mailApiUrl,
        mailRequestBody: job.mailRequestBody,
        totpSecret: job.totpSecret,
      })
    : normalizeLoginCredentials(credentials);
  const nextProxyUrl = options.hasProxyUpdate ? normalizeProxyUrl(options.proxyUrl) : job.proxyUrl;
  const changed = job.loginMode !== normalized.loginMode
    || job.mailApiUrl !== normalized.mailApiUrl
    || job.mailRequestBody !== normalized.mailRequestBody
    || job.password !== normalized.password
    || job.totpSecret !== normalized.totpSecret
    || job.proxyUrl !== nextProxyUrl;
  await saveStoredLoginCredentials(job.email, { ...normalized, proxyUrl: nextProxyUrl });
  if (!changed) return;
  stopMailPolling(job);
  job.loginMode = normalized.loginMode;
  job.mailApiUrl = normalized.mailApiUrl;
  job.mailRequestBody = normalized.mailRequestBody;
  job.password = normalized.password;
  job.totpSecret = normalized.totpSecret;
  job.hasPasswordCredential = Boolean(normalized.password);
  job.hasTotpCredential = Boolean(normalized.totpSecret);
  job.proxyUrl = nextProxyUrl;
  if (nextProxyUrl) recordProxyUsage(nextProxyUrl, job.email);
  job.mailSeenCandidateKeys.clear();
  job.mailCandidateCounts.clear();
  job.mailStatus = job.mailApiUrl ? "baseline" : "manual";
  job.mailApiError = null;
  recordJobOperation(job, "account_update");
  appendJobLog(job, "[account] 登录方式与验证资料已按邮箱唯一键更新，敏感字段未写入日志。\n");
  if (isActive(job.status) && job.status !== "queued" && job.status !== "idle") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

async function updateJobProxy(job, proxyUrl) {
  if (job.proxyUrl === proxyUrl) return;
  job.proxyUrl = proxyUrl;
  if (proxyUrl) recordProxyUsage(proxyUrl, job.email);
  // A fresh proxy clears the previous connection-error marker.
  job.proxyConnectionError = false;
  job.failedProxyLabel = null;
  await saveStoredLoginCredentials(job.email, job);
  recordJobOperation(job, "proxy_update");
  appendJobLog(job, "[proxy] 账号代理配置已更新。\n");
  if (isActive(job.status) && job.status !== "queued" && job.status !== "idle") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

// Operator-driven replacement of a dead proxy. Enforces: the replacement must be
// in the loaded pool; it must differ from the failing proxy; and a connection
// credential ("giao thức kết nối") that was ever used may only be reused when no
// account currently uses it AND the operator explicitly confirms. Never switches
// proxies on its own. Returns { status, payload } for the route to send.
async function changeJobProxy(job, body = {}) {
  if (job.status !== "proxy_error") {
    throw httpError(409, "只有代理连接失败的任务才能更换代理");
  }
  // The client selects a pooled proxy by its key (credentials never leave the
  // server); a raw proxyUrl is also accepted for flexibility/tests.
  let proxyUrl;
  if (body.poolKey) {
    const entry = proxyPool.get(String(body.poolKey));
    if (!entry) throw httpError(400, "所选代理不在系统代理池中，请刷新后重试");
    proxyUrl = entry.url;
  } else {
    proxyUrl = normalizeProxyUrl(body.proxyUrl);
  }
  if (!proxyUrl) throw httpError(400, "必须提供有效的代理地址");
  const identity = proxyConnectionIdentity(proxyUrl);
  if (!identity) throw httpError(400, "无法解析代理连接信息");

  // "đã được nạp vào hệ thống": only proxies loaded into the pool are selectable.
  if (!proxyPool.has(identity.key)) {
    throw httpError(400, "该代理尚未纳入系统代理池，请先在代理池中导入后再选择");
  }

  const currentIdentity = job.proxyUrl ? proxyConnectionIdentity(job.proxyUrl) : null;
  if (currentIdentity && currentIdentity.key === identity.key) {
    throw httpError(409, "新代理与当前失败的代理相同，请选择其它代理");
  }

  // never-used → allow; used-before → require confirmation and no current user.
  if (isProxyEverUsed(identity.key)) {
    if (proxyCurrentlyInUse(identity.key, job.id)) {
      throw httpError(409, "该代理线路仍有其它账号在使用，不能重复使用");
    }
    if (body.confirmReuse !== true) {
      return {
        status: 409,
        payload: {
          needsReuseConfirm: true,
          proxyLabel: identity.label,
          message: "该代理线路曾被使用，但当前没有账号在用。确认要重复使用吗？",
        },
      };
    }
  }

  // Verify the replacement actually connects before committing to it. A test
  // seam skips the live network probe (smoke tests have no real proxy).
  const check = process.env.PROXY_CHANGE_SKIP_LIVE_CHECK === "1"
    ? { ok: true, ip: null }
    : await checkProxyExitIp(proxyUrl);
  if (!check.ok) {
    throw httpError(502, `新代理仍然无法连接：${check.error || "未知错误"}`);
  }

  job.proxyUrl = proxyUrl;
  job.proxyConnectionError = false;
  job.failedProxyLabel = null;
  await saveStoredLoginCredentials(job.email, job);
  recordProxyUsage(proxyUrl, job.email);
  recordJobOperation(job, "proxy_change");
  appendJobLog(job, `[proxy] 已更换为新的代理线路（${identity.label}，出口 IP ${check.ip || "未知"}）。\n`);

  // Auto-sync the new proxy to Sub2API when this account was uploaded there.
  let sub2apiSync = { attempted: false };
  if (job.sub2apiUploadedAt) {
    sub2apiSync = await syncAccountProxyToSub2Api(job, proxyUrl, body.config).catch((error) => ({
      attempted: true,
      ok: false,
      error: String(error?.message || error).slice(0, 300),
    }));
    if (sub2apiSync.ok) {
      appendJobLog(job, `[proxy] 新代理已同步到 Sub2API（proxy_id ${sub2apiSync.proxyId}）。\n`);
    } else if (sub2apiSync.attempted) {
      appendJobLog(job, `[proxy] 同步新代理到 Sub2API 失败：${sub2apiSync.error || "未知错误"}。\n`);
    }
  }

  restartJobForProxyChange(job);
  return {
    status: 200,
    payload: { changed: true, proxyLabel: identity.label, exitIp: check.ip || null, sub2apiSync },
  };
}

// Operator-driven retry of the SAME proxy that just failed. A proxy_error can be
// transient (the pool health probe may still show the proxy up while a single
// login attempt failed), so re-test the current proxy and, if it now connects,
// resume the login flow on it without forcing a change. If it still fails, report
// the error so the operator switches proxies instead. Never retries on its own.
async function reconnectJobProxy(job) {
  if (job.status !== "proxy_error") {
    throw httpError(409, "只有代理连接失败的任务才能重新连接");
  }
  const proxyUrl = job.proxyUrl;
  if (!proxyUrl) throw httpError(409, "当前任务没有可重连的代理，请改用更换代理");
  const identity = proxyConnectionIdentity(proxyUrl);

  // Verify the same proxy actually connects now before committing to a restart.
  // A test seam skips the live network probe (smoke tests have no real proxy).
  const check = process.env.PROXY_CHANGE_SKIP_LIVE_CHECK === "1"
    ? { ok: true, ip: null }
    : await checkProxyExitIp(proxyUrl);
  if (!check.ok) {
    throw httpError(502, `代理仍然无法连接：${check.error || "未知错误"}，请更换代理`);
  }

  job.proxyConnectionError = false;
  job.failedProxyLabel = null;
  recordProxyUsage(proxyUrl, job.email);
  recordJobOperation(job, "proxy_reconnect");
  appendJobLog(
    job,
    `[proxy] 原代理重新连接成功（${identity?.label || "未知"}，出口 IP ${check.ip || "未知"}），使用原代理重新登录。\n`,
  );
  restartJobForProxyChange(job, {
    source: "proxy_reconnect",
    logLine: `\n[proxy-reconnect] 使用原代理开始第 ${job.attempt + 1} 次授权登录。\n`,
    enqueueMessage: "代理已重新连接，正在使用原代理重新登录",
  });
  return {
    status: 200,
    payload: { reconnected: true, proxyLabel: identity?.label || null, exitIp: check.ip || null },
  };
}

// Restart the login flow after a proxy change or reconnect (a proxy_error job is
// terminal, so updateJobProxy's active-only restart does not apply here). The
// caller supplies the automation source, log line and queue prompt so the same
// restart path serves both "更换代理" (new proxy) and "重新连接" (same proxy).
function restartJobForProxyChange(job, options = {}) {
  const source = options.source || "proxy_change";
  const logLine = options.logLine || `\n[proxy-change] 使用新代理开始第 ${job.attempt + 1} 次授权登录。\n`;
  const enqueueMessage = options.enqueueMessage || "已更换代理，正在使用新代理重新登录";
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  beginAuthorizationAutomationAttempt(job, source);
  recordJobOperation(job, "reauthorize");
  appendJobLog(job, logLine);
  enqueueJob(job, "full", enqueueMessage);
}

// Build a Sub2API-creatable proxy object (with a proxy_key) from a proxy URL.
function proxyUrlToCreatableSub2ApiProxy(proxyUrl) {
  const parsed = parseProxyUrlForSub2Api(proxyUrl);
  if (!parsed) return null;
  const rawKey = `${parsed.protocol}|${parsed.host}|${parsed.port}|${parsed.username}|${parsed.password}`;
  const proxyKey = `p_${crypto.createHash("sha1").update(rawKey).digest("hex").slice(0, 16)}`;
  return { ...parsed, proxy_key: proxyKey, status: "active" };
}

// Create the new proxy on Sub2API and point the account's proxy_id at it. Uses
// the config from the request body, falling back to the stored monitor config.
// Best-effort: never throws to the caller (caught upstream) — returns a status.
async function syncAccountProxyToSub2Api(job, proxyUrl, rawConfig) {
  let config = null;
  try {
    config = rawConfig ? normalizeSub2ApiConfig(rawConfig) : null;
  } catch {
    config = null;
  }
  if ((!config?.baseUrl || !config?.adminApiKey) && sub2ApiMonitorConfig?.baseUrl && sub2ApiMonitorConfig?.adminApiKey) {
    config = sub2ApiMonitorConfig;
  }
  if (!config?.baseUrl || !config?.adminApiKey) {
    return { attempted: false, reason: "no-config" };
  }
  const proxyObj = proxyUrlToCreatableSub2ApiProxy(proxyUrl);
  if (!proxyObj) return { attempted: true, ok: false, error: "无法解析代理信息" };
  const { idByKey } = await createSub2ApiProxyIds(config, [proxyObj]);
  const proxyId = idByKey.get(proxyObj.proxy_key);
  if (!proxyId) return { attempted: true, ok: false, error: "在 Sub2API 创建代理失败" };
  const accounts = await listAllSub2ApiAccounts(config);
  const email = String(job.email || "").toLowerCase();
  const account = accounts.find((item) => sub2ApiAccountEmail(item) === email);
  if (!account) return { attempted: true, ok: false, error: "在 Sub2API 未找到该账号" };
  const accountId = Number(account.id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return { attempted: true, ok: false, error: "Sub2API 账号 ID 无效" };
  }
  await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}`, {
    method: "PUT",
    body: JSON.stringify({ proxy_id: proxyId }),
  });
  return { attempted: true, ok: true, proxyId, accountId };
}

function restartJobAfterConfigurationUpdate(job) {
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  beginAuthorizationAutomationAttempt(job, "configuration_update");
  appendJobLog(job, "[account] 已停止使用旧配置的登录进程，并使用新配置重新排队。\n");
  enqueueJob(job, "full", "账号资料已更新，正在重新建立登录会话");
}

async function saveJobMetadata(job) {
  if (job.deleted) return;
  job.metadataWritePromise = (job.metadataWritePromise || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (job.deleted) return;
      const metadataPath = path.join(path.dirname(job.outputPath), JOB_META_FILENAME);
      const data = {
        version: 1,
        email: job.email,
        status: job.status,
        prompt: job.prompt || null,
        last_error: job.lastError || null,
        result_saved: Boolean(job.resultSaved),
        completed_at: job.completedAt || null,
        attempt: Number(job.attempt || 1),
        security_check_required: Boolean(job.securityCheckRequired),
        queued_mode: job.queuedMode || null,
        queued_at: job.queuedAt || null,
        created_at: job.createdAt,
        last_operation_at: job.lastOperationAt || job.createdAt,
        last_operation_type: job.lastOperationType || "initial_authorization",
        login_mode: job.loginMode || null,
        mail_api_url: job.mailApiUrl || null,
        mail_request_body: job.mailRequestBody || null,
        has_stored_credentials: Boolean(job.password || job.totpSecret),
        has_password: Boolean(job.password || job.hasPasswordCredential),
        has_totp_key: Boolean(job.totpSecret || job.hasTotpCredential),
        totp_known_enabled: Boolean(job.totpKnownEnabled || job.totpSecret || job.hasTotpCredential),
        password_add_error: job.passwordAddError || null,
        password_added_at: job.passwordAddedAt || null,
        login_checkpoint_available: Boolean(job.loginCheckpointAvailable),
        proxy_risk_retry_count: Number(job.proxyRiskRetryCount || 0),
        proxy_connection_failure_count: Number(job.proxyConnectionFailureCount || 0),
        proxy_configured: Boolean(job.proxyUrl),
        proxy_connection_error: Boolean(job.proxyConnectionError),
        failed_proxy_label: job.failedProxyLabel || null,
        registration_succeeded: Boolean(job.registrationSucceeded),
        registered_at: job.registeredAt || null,
        sms_provider_id: job.smsProviderId || null,
        sms_provider_name: job.smsProviderName || null,
        sms_service_label: job.smsServiceLabel || null,
        sms_order_id: job.smsOrderId || null,
        sms_number: job.smsNumber || null,
        sms_status: job.smsStatus || null,
        sms_cost_events: Array.isArray(job.smsCostEvents) ? job.smsCostEvents : [],
        last_auth_automated: Boolean(job.lastAuthAutomated),
        last_auth_automation_reason: job.lastAuthAutomationReason || null,
        last_auth_automated_at: job.lastAuthAutomatedAt || null,
        last_auth_requirements: job.lastAuthRequirements || null,
        auto_repair_blocked: Boolean(job.autoRepairBlocked),
        auto_repair_blocked_reason: job.autoRepairBlockedReason || null,
        auto_repair_blocked_at: job.autoRepairBlockedAt || null,
        auto_repair_last_attempt_at: job.autoRepairLastAttemptAt || null,
        auto_repair_last_success_at: job.autoRepairLastSuccessAt || null,
        auto_repair_last_error: job.autoRepairLastError || null,
        auto_repair_pending_account_ids: job.autoRepairPendingAccountIds || [],
        auto_repair_pending_backend: job.autoRepairPendingBackend || null,
        sub2api_uploaded_at: job.sub2apiUploadedAt || null,
        sub2api_uploaded_base_url: job.sub2apiUploadedBaseUrl || null,
        tls_profile: job.tlsProfile || null,
        updated_at: new Date().toISOString(),
      };
      const tempPath = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, metadataPath);
      try {
        if (jobDao.getById(job.id)) jobDao.update(job);
        else jobDao.insert(job);
      } catch {}
    });
  return job.metadataWritePromise;
}

async function saveStoredLoginCredentials(email, credentials = {}) {
  const password = typeof credentials.password === "string" ? credentials.password : "";
  const totpSecret = credentials.totpSecret ? normalizeTotpSecret(credentials.totpSecret) : "";
  const proxyUrl = credentials.proxyUrl ? normalizeProxyUrl(credentials.proxyUrl) : "";
  if (!password && !totpSecret && !proxyUrl) {
    await deleteStoredLoginCredentials(email);
    return true;
  }
  try {
    await credentialStore.save(email, { password, totpSecret, proxyUrl });
  } catch (error) {
    if (error?.status === 501) return false;
    throw error;
  }
  return true;
}

async function loadStoredLoginCredentials(email) {
  try {
    const data = await credentialStore.load(email);
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: data.totpSecret ? normalizeTotpSecret(data.totpSecret) : "",
      proxyUrl: data.proxyUrl ? normalizeProxyUrl(data.proxyUrl) : null,
    };
  } catch {
    return { password: "", totpSecret: "", proxyUrl: null };
  }
}

async function deleteStoredLoginCredentials(email) {
  await credentialStore.delete(email);
}

async function loadMailboxBaseline(job) {
  try {
    const candidates = await fetchMailboxOtpCandidates(mailApiUrlForJob(job), {
      request: mailRequestForJob(job),
    });
    candidates.forEach((candidate) => job.mailSeenCandidateKeys.add(candidate.key));
    job.mailStatus = "ready";
    job.mailApiError = null;
    appendJobLog(job, `[mail] 已记录收码接口中的 ${candidates.length} 个旧邮件验证码标识，等待新邮件。\n`);
  } catch (error) {
    job.mailStatus = "error";
    job.mailApiError = safeMailError(error);
    appendJobLog(job, `[mail] 首次读取收码接口失败：${job.mailApiError}\n`);
  }
  touch(job);
}

async function beginMailPolling(job) {
  if (!mailApiUrlForJob(job) || job.mailPollRunning || job.status !== "email_otp") return;
  job.mailPollRunning = true;
  job.mailStatus = "polling";
  job.mailApiError = null;
  const pollToken = crypto.randomUUID();
  const startedAt = Date.now();
  job.mailPollToken = pollToken;
  touch(job);

  try {
    while (
      job.mailPollToken === pollToken &&
      job.status === "email_otp" &&
      job.child &&
      Date.now() - startedAt < MAIL_POLL_TIMEOUT_MS
    ) {
      try {
        const candidates = filterMailboxOtpCandidatesByRequestTime(
          await fetchMailboxOtpCandidates(mailApiUrlForJob(job), {
            request: mailRequestForJob(job),
          }),
          job.mailOtpRequestedAt,
        );
        if (job.mailPollToken !== pollToken || job.status !== "email_otp" || !job.child) return;
        const unseen = candidates.filter((candidate) => !job.mailSeenCandidateKeys.has(candidate.key));
        let fresh = unseen.find((candidate) => candidate.score >= 12);
        if (!fresh) {
          unseen.forEach((candidate) => {
            job.mailCandidateCounts.set(candidate.key, (job.mailCandidateCounts.get(candidate.key) || 0) + 1);
          });
          fresh = unseen.find((candidate) => (job.mailCandidateCounts.get(candidate.key) || 0) >= 2);
        }
        job.mailApiError = null;
        if (fresh) {
          job.mailSeenCandidateKeys.add(fresh.key);
          job.mailCandidateCounts.delete(fresh.key);
          job.mailStatus = "found";
          markAuthorizationRequirement(job, "emailOtp");
          markAuthorizationAutomatic(job, "emailOtp");
          job.parserTail = "";
          job.mailAutoResendCount = 0;
          appendJobLog(job, "[mail] 已从收码接口自动取得新验证码并提交。\n");
          setStage(job, "working", "已自动获取邮箱验证码，正在验证");
          job.child.stdin.write(`${fresh.code}\n`);
          return;
        }
        if (
          Date.now() - startedAt >= MAIL_AUTO_RESEND_AFTER_MS &&
          (job.mailAutoResendCount || 0) < MAIL_AUTO_RESEND_MAX
        ) {
          // Resending restarts polling once the login flow prompts for the code again.
          const resent = await withEmailJobLock(job.email, async () => {
            if (job.mailPollToken !== pollToken || job.status !== "email_otp" || !job.child) return false;
            job.mailAutoResendCount = (job.mailAutoResendCount || 0) + 1;
            appendJobLog(job, `[mail] ${Math.round(MAIL_AUTO_RESEND_AFTER_MS / 1000)} 秒内未收到验证码，自动重新发送（第 ${job.mailAutoResendCount}/${MAIL_AUTO_RESEND_MAX} 次）。\n`);
            await submitJobInput(job, { action: "resend_email" });
            return true;
          });
          if (resent) return;
        }
      } catch (error) {
        if (job.mailPollToken !== pollToken) return;
        job.mailStatus = "error";
        job.mailApiError = safeMailError(error);
        touch(job);
      }
      await delay(MAIL_POLL_INTERVAL_MS);
    }

    if (job.mailPollToken === pollToken && job.status === "email_otp") {
      job.mailStatus = "timeout";
      job.mailApiError = "自动收码等待超时，请手动输入或重新发送";
      job.prompt = "自动收码等待超时，请手动输入邮箱验证码";
      touch(job);
    }
  } finally {
    if (job.mailPollToken === pollToken) {
      job.mailPollRunning = false;
      job.mailPollToken = null;
      touch(job);
    }
  }
}

function stopMailPolling(job) {
  if (!job.mailApiUrl) return;
  job.mailPollToken = null;
  job.mailPollRunning = false;
  if (job.mailStatus === "polling") job.mailStatus = "stopped";
}

function appendJobLog(job, text) {
  job.logs = `${job.logs}${sanitizeLog(text)}`.slice(-MAX_LOG_CHARS);
}

function safeMailError(error) {
  const message = String(error?.message || "读取收码接口失败");
  return message.replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>").slice(0, 180);
}

function normalizeMailRequestConfig(value) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const method = String(config.method || "GET").trim().toUpperCase();
  if (!["GET", "POST"].includes(method)) throw httpError(400, "邮件接码请求方式只支持 GET 或 POST");

  const sourceHeaders = config.headers == null ? {} : config.headers;
  if (!sourceHeaders || typeof sourceHeaders !== "object" || Array.isArray(sourceHeaders)) {
    throw httpError(400, "邮件接码请求头必须是 JSON 对象");
  }
  const entries = Object.entries(sourceHeaders);
  if (entries.length > MAX_MAIL_REQUEST_HEADERS) {
    throw httpError(400, `邮件接码请求头最多配置 ${MAX_MAIL_REQUEST_HEADERS} 项`);
  }
  const headers = {};
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw httpError(400, `无效的请求头名称：${rawName}`);
    if (FORBIDDEN_MAIL_REQUEST_HEADERS.has(name)) throw httpError(400, `请求头 ${rawName} 由请求库自动管理，不能手动配置`);
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw httpError(400, `请求头 ${rawName} 的值必须是文本或数字`);
    }
    const headerValue = String(rawValue);
    if (/\r|\n/.test(headerValue)) throw httpError(400, `请求头 ${rawName} 不能包含换行符`);
    if (Buffer.byteLength(headerValue) > 8 * 1024) throw httpError(400, `请求头 ${rawName} 的值过长`);
    headers[name] = headerValue;
  }

  const url = String(config.url || "").trim();
  if (method === "POST" && !validateMailApiUrl(url)) {
    throw httpError(400, "POST 邮件接码模式必须配置有效的 HTTP 或 HTTPS 请求 URL");
  }
  return { method, url: validateMailApiUrl(url) ? url : null, headers };
}

function mailRequestForJob(job) {
  const headers = { ...(mailRequestConfig.headers || {}) };
  // For magicskill mailbox URLs, always attach the Keychain Bearer key so OTP
  // reading keeps working even if the browser overwrote the global config with
  // 0 headers (the SPA POSTs mailRequestConfig from localStorage on load). The
  // user's own Authorization header, if any, still takes precedence.
  let sameHost = false;
  try { sameHost = new URL(mailApiUrlForJob(job)).host === MAIL_API_HOST; } catch { sameHost = false; }
  const hasAuth = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
  if (mailApiKey && sameHost && !hasAuth) headers.authorization = `Bearer ${mailApiKey}`;
  return {
    method: mailRequestConfig.method,
    headers,
    body: mailRequestConfig.method === "POST" ? job.mailRequestBody || "" : "",
  };
}

function mailApiUrlForJob(job) {
  return mailRequestConfig.method === "POST" && validateMailApiUrl(mailRequestConfig.url)
    ? mailRequestConfig.url
    : job.mailApiUrl;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortNewestFirst(a, b) {
  return b.createdAt.localeCompare(a.createdAt);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw httpError(413, "Request body is too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

process.on("SIGINT", () => void shutdown().catch(reportShutdownFailure));
process.on("SIGTERM", () => void shutdown().catch(reportShutdownFailure));

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    queueSchedulingPaused = true;
    if (sub2ApiMonitorTimer) {
      clearInterval(sub2ApiMonitorTimer);
      sub2ApiMonitorTimer = null;
    }
    for (const controller of sub2ApiRequestControllers) controller.abort();
    await Promise.allSettled([
      sub2ApiMonitorPromise,
      ...sub2ApiRequestPromises,
      ...sub2ApiAutoRepairPromises,
    ].filter(Boolean));
    // Don't cancel staged (idle) jobs on shutdown — they must survive restart as "待启动".
    const activeJobs = [...jobs.values()].filter((job) => isActive(job.status) && job.status !== "idle");
    const childWaits = activeJobs
      .map((job) => job.child)
      .filter(Boolean)
      .map((child) => waitForChildExit(child, 3_000));
    await Promise.allSettled(activeJobs.map((job) => cancelJob(job)));
    await Promise.allSettled([
      ...childWaits,
      ...[...jobs.values()].map((job) => job.metadataWritePromise).filter(Boolean),
    ]);
    await vite.close();
    await closeHttpServer(server);
    closeDb();
  })();
  return shutdownPromise;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", finish);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
  });
}

function closeHttpServer(httpServer) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      httpServer.closeAllConnections?.();
      resolve();
    }, 3_000);
    httpServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function reportShutdownFailure(error) {
  console.error(`[shutdown] ${error.message}`);
  process.exitCode = 1;
}
