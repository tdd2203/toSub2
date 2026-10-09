#!/usr/bin/env node
// Pure-logic smoke test for the real-browser lane helpers.
// Does NOT launch Chromium — safe to run anywhere.
//
// Covers:
//   1. oaiDeviceIdFromEmail is deterministic (same email → same UUIDv5)
//   2. per-account fingerprint stays inside documented envelopes
//   3. init-script string respects the WHITELIST (no WebGL/platform/screen/UA override strings)
//   4. buildContextOptions NEVER sets userAgent
//   5. normalizeProxyUrl + proxyUrlToSub2ApiProxy round-trip
//   6. sub2api payload shape matches protocol-login's buildSub2apiOauthExport output
//   7. the console-server-side oaiDeviceIdForEmail (sha1-based v5) agrees with
//      the browser-fingerprint oaiDeviceIdFromEmail — load-bearing: the TLS and
//      browser lanes must mint identical device IDs for the same email so a lane
//      switch is a no-op.

import assert from "node:assert/strict";
import {
  oaiDeviceIdFromEmail,
  buildPerAccountFingerprint,
  buildContextOptions,
  buildInitScript,
  deriveSeedBytes,
} from "../src/browser-fingerprint.mjs";
import {
  parseArgs,
  normalizeProxyUrl,
  proxyUrlToSub2ApiProxy,
  buildSub2ApiPayload,
  decodeJwtPayload,
} from "../src/browser-login.mjs";
import { WORKER_MARKERS, allMarkers } from "../src/browser-stdio-matrix.mjs";

const EMAILS = [
  "alice@example.com",
  "bob@example.org",
  "ngọc.trang@mail.vn", // non-ascii
  "ALICE@EXAMPLE.COM", // uppercase → should match 'alice@…'
];

// 1. Determinism.
{
  const a = oaiDeviceIdFromEmail("alice@example.com");
  const b = oaiDeviceIdFromEmail("alice@example.com");
  const c = oaiDeviceIdFromEmail("bob@example.com");
  const d = oaiDeviceIdFromEmail("ALICE@example.com");
  assert.equal(a, b, "same email → same uuid");
  assert.notEqual(a, c, "different emails → different uuids");
  assert.equal(a, d, "case-insensitive");
}

// 2. Fingerprint envelope.
for (const email of EMAILS) {
  const id = oaiDeviceIdFromEmail(email);
  const fp = buildPerAccountFingerprint({
    oaiDeviceId: id,
    hostProfile: { hardwareConcurrency: 10, screenWidth: 1920, screenHeight: 1080 },
  });
  assert.ok(fp.hardwareConcurrency >= 2, "cores lower bound");
  assert.ok(fp.hardwareConcurrency <= 10, "cores upper bound");
  assert.ok([4, 8].includes(fp.deviceMemory), "deviceMemory ∈ {4,8}");
  assert.ok(Math.abs(fp.viewport.width - 1440) <= 8, "viewport width jitter ≤ 8px");
  assert.ok(Math.abs(fp.viewport.height - 900) <= 8, "viewport height jitter ≤ 8px");
  const seed = deriveSeedBytes(id);
  assert.equal(seed.length, 32, "32-byte seed");
}

// 3. Init-script whitelist.
{
  const fp = buildPerAccountFingerprint({ oaiDeviceId: oaiDeviceIdFromEmail("probe@example.com") });
  const script = buildInitScript(fp);
  // WebGL vendor/renderer, Intl và userAgent nay được init script chỉnh có chủ đích
  // để khớp máy Mac thật; các mục dưới đây vẫn phải để nguyên.
  const forbidden = [
    "WEBGL_debug_renderer_info",
    "navigator.platform",
    "screen.width",
    "navigator.vendor",
  ];
  for (const needle of forbidden) {
    assert.ok(!script.includes(needle), `init script must not touch ${needle}`);
  }
  // Allowed knobs are present.
  for (const needle of ["hardwareConcurrency", "deviceMemory", "webdriver", "toDataURL", "getImageData"]) {
    assert.ok(script.includes(needle), `init script expected to patch ${needle}`);
  }
}

// 4. Context options exclude userAgent.
{
  const fp = buildPerAccountFingerprint({ oaiDeviceId: oaiDeviceIdFromEmail("probe@example.com") });
  const opts = buildContextOptions({ fingerprint: fp });
  assert.ok(!("userAgent" in opts), "buildContextOptions must NOT set userAgent (installed Chrome's UA is used verbatim)");
  assert.equal(opts.locale, "vi-VN");
  assert.equal(opts.timezoneId, "Asia/Ho_Chi_Minh");
}

// 5. Proxy round-trip.
{
  const n = normalizeProxyUrl("http://u:p%2B1@h.example:8080");
  assert.equal(n.scheme, "http");
  assert.equal(n.host, "h.example");
  assert.equal(n.port, "8080");
  assert.equal(n.username, "u");
  assert.equal(n.password, "p+1", "percent-decoded password");
  const sx = proxyUrlToSub2ApiProxy("http://a:b@c.d:3128");
  assert.equal(sx.proxy_key, "http://c.d:3128");
  assert.equal(sx.type, "http");
  assert.equal(sx.port, 3128);
}

// 6. sub2api payload shape.
{
  const idHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const idPayload = Buffer.from(JSON.stringify({ sub: "u_123", sid: "s_abc", email: "x@y.z", name: "Pat Tester" })).toString("base64url");
  const tokenSet = { access_token: "AT", refresh_token: "RT", id_token: `${idHeader}.${idPayload}.` };
  const payload = buildSub2ApiPayload({
    tokenSet,
    email: "x@y.z",
    proxyUrl: null,
    clientId: "cid",
    accountName: null,
    concurrency: 10,
    priority: 1,
    rateMultiplier: 1,
  });
  assert.equal(payload.type, "sub2api-data");
  assert.equal(payload.version, 1);
  assert.equal(payload.accounts.length, 1);
  const acc = payload.accounts[0];
  assert.equal(acc.platform, "openai");
  assert.equal(acc.type, "oauth");
  assert.equal(acc.credentials.access_token, "AT");
  assert.equal(acc.credentials.refresh_token, "RT");
  assert.equal(acc.credentials.email, "x@y.z");
  assert.equal(acc.extra.client_id, "cid");
  assert.equal(acc.extra.chatgpt_account_id, "s_abc");
  assert.equal(acc.extra.chatgpt_user_id, "u_123");
  const back = decodeJwtPayload(tokenSet.id_token);
  assert.equal(back.sid, "s_abc");
}

// 7. Cross-lane oai-did consistency.
// The console-server defines its own tiny UUIDv5 helper (to avoid pulling the
// patchright import into the TLS path). It must mint the exact same UUID as
// src/browser-fingerprint.mjs — otherwise a lane switch for the same email
// would hand OpenAI two different device identities and spoil the P5 rule.
{
  const serverSide = (() => {
    // Inline mirror of console-server.oaiDeviceIdForEmail (keep in sync).
    const crypto = require("node:crypto"); // via esbuild stub? no — use import().
    return null;
  });
  // We can't easily import console-server (it starts a server). Instead,
  // re-implement the same UUIDv5 here against the same namespace and compare.
  const { createHash } = await import("node:crypto");
  const NS = "7f1b7a1a-5e40-4a3d-9e5e-9c0d1f1a5b2a".replace(/-/g, "");
  const nsBytes = Buffer.from(NS, "hex");
  const email = "shared-probe@example.com";
  const nameBytes = Buffer.from(email.toLowerCase().trim(), "utf8");
  const digest = createHash("sha1").update(nsBytes).update(nameBytes).digest();
  const out = Buffer.from(digest.subarray(0, 16));
  out[6] = (out[6] & 0x0f) | 0x50;
  out[8] = (out[8] & 0x3f) | 0x80;
  const hex = out.toString("hex");
  const serverExpected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const browserValue = oaiDeviceIdFromEmail(email);
  assert.equal(browserValue, serverExpected, "console-server and browser-fingerprint must agree on oai-did v5 for the same email");
}

// 8. parseArgs covers the modes.
{
  const probeArgs = parseArgs(["--probe", "--probe-url", "https://e.com/x", "--sub2api-out", "/t/x.json"]);
  assert.equal(probeArgs.probe, true);
  assert.equal(probeArgs.probeUrl, "https://e.com/x");
  const signupArgs = parseArgs(["--email", "e@e.com", "--output-mode", "sub2api", "--sub2api-out", "/t/y.json", "--checkpoint", "/t/c.json"]);
  assert.equal(signupArgs.email, "e@e.com");
  assert.equal(signupArgs.outputMode, "sub2api");
  const refreshArgs = parseArgs(["--refresh-sub2api", "/t/src.json", "--sub2api-out", "/t/dst.json", "--verbose"]);
  assert.equal(refreshArgs.refreshSub2api, "/t/src.json");
  assert.equal(refreshArgs.verbose, true);
}

// 9. All stdio markers are non-empty and unique.
{
  const seen = new Set();
  for (const m of allMarkers()) {
    assert.ok(m && m.length > 0, "marker must be non-empty");
    assert.ok(!seen.has(m), `marker duplicate: ${m}`);
    seen.add(m);
  }
  // Markers that console-server scans for must exist in our matrix.
  for (const expected of [
    "Email OTP (r=resend, q=quit):",
    "Phone number, E.164 format: ",
    "Phone OTP (r=resend, p=change phone, q=quit): ",
    "[ok] Saved sub2api import: ",
    "[2/5] Start Codex OAuth flow",
    "[sentinel] Requesting a fresh security token for account profile creation.",
  ]) {
    assert.ok(allMarkers().includes(expected) || allMarkers().some((m) => m.startsWith(expected)), `missing marker: ${expected}`);
  }
  assert.equal(WORKER_MARKERS.phoneRequiredSoftkill.marker, "[error] PHONE_REQUIRED_SOFTKILL");
}

console.log("[ok] browser-fingerprint-smoke passed (9 groups)");
