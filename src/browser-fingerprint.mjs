// Per-account fingerprint for the real-browser signup lane.
//
// IMPORTANT — Patchright policy. Patchright intentionally patches out every
// JS-visible injection path (Page.addScriptToEvaluateOnNewDocument, isolated
// worlds, Runtime.enable). The addInitScript() calls here do NOT fire on pages
// loaded through Patchright, by design — the stealth model is "look exactly
// like a real Chromium, inject nothing the fingerprint can detect." We keep
// the init-script generator so a future lane that uses vanilla Playwright
// (playwright-extra + stealth) can share it, but on the Patchright lane the
// per-account variance comes entirely from:
//
//   * `userDataDir` keyed by sha256(oaiDeviceId).slice(0,16)
//     → different session cookies, localStorage, IndexedDB, Cache Storage per account
//   * `oai-did` cookie seeded via context.addCookies before first navigation
//     → deterministic device identity shared with the TLS lane
//   * The job's residential proxy (burn-ledger-filtered, lifetime cap enforced)
//
// WHITELIST (future vanilla-Playwright lane only). Only touch axes we can vary
// coherently across all the probes Arkose / Sentinel run. The dev host has ONE
// physical GPU, ONE physical screen, ONE real OS kernel; any attempt to lie
// about them splits under cross-probing (shader compile logs, max texture
// size, pointer precision). Only these knobs are safe:
//
//   * `navigator.hardwareConcurrency`  —  host cores vs host cores - 2
//   * `navigator.deviceMemory`         —  4 or 8 GB
//   * viewport width/height jitter     —  ±8 px off a base inside the real screen
//   * HTMLCanvasElement toDataURL/getImageData  —  1-bit noise keyed by oaiDeviceId
//   * AudioContext DynamicsCompressor float output  —  1e-7 noise keyed by seed
//
// EXPLICITLY NOT TOUCHED:
//   WebGL vendor/renderer, screen.* dimensions, navigator.platform, timezoneId,
//   locale, UA, UA-CH client hints, prefers-color-scheme.
//
// All variation is DETERMINISTIC: `deriveSeedBytes(oaiDeviceId)` → a 32-byte
// seed stream. Same email → same oaiDeviceId → same seed → same picks across
// restarts and lane switches. That matches the P5 per-account fingerprint rule
// the TLS lane follows today.

import crypto from "node:crypto";

const BASE_VIEWPORT = { width: 1440, height: 900 };
const JITTER_PX = 8;

export function oaiDeviceIdFromEmail(email, namespace = "7f1b7a1a-5e40-4a3d-9e5e-9c0d1f1a5b2a") {
  const value = String(email || "").trim().toLowerCase();
  if (!value) return crypto.randomUUID();
  // UUIDv5 (name-based, SHA-1) by hand so we don't force a uuid runtime dep on
  // every caller — browser-login.mjs is already fine with crypto only.
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(value, "utf8");
  const hash = crypto.createHash("sha1").update(nsBytes).update(nameBytes).digest();
  const out = Buffer.from(hash.subarray(0, 16));
  out[6] = (out[6] & 0x0f) | 0x50; // version 5
  out[8] = (out[8] & 0x3f) | 0x80; // variant RFC 4122
  return bytesToUuid(out);
}

function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, "");
  return Buffer.from(hex, "hex");
}

function bytesToUuid(buf) {
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveSeedBytes(oaiDeviceId) {
  // 32 bytes of deterministic entropy — more than enough for every axis we
  // pick on. SHA-256 the UUID so the raw UUID isn't exposed in page code.
  return crypto.createHash("sha256").update(String(oaiDeviceId || "")).digest();
}

function pickFrom(seedByte, options) {
  if (!options.length) throw new Error("pickFrom: empty option list");
  return options[seedByte % options.length];
}

function jitter(seedByte, base, amplitude) {
  // Map a 0..255 byte to -amplitude..+amplitude evenly.
  const span = amplitude * 2 + 1;
  const offset = (seedByte % span) - amplitude;
  return base + offset;
}

export function buildPerAccountFingerprint({ oaiDeviceId, hostProfile = {} }) {
  const seed = deriveSeedBytes(oaiDeviceId);
  const realCores = Number.isFinite(hostProfile.hardwareConcurrency) ? hostProfile.hardwareConcurrency : 8;
  const coresChoices = [realCores, Math.max(2, realCores - 2)];
  const memoryChoices = [4, 8];
  const screenWidth = Number.isFinite(hostProfile.screenWidth) ? hostProfile.screenWidth : 1920;
  const screenHeight = Number.isFinite(hostProfile.screenHeight) ? hostProfile.screenHeight : 1080;
  const baseWidth = Math.min(BASE_VIEWPORT.width, screenWidth - 20);
  const baseHeight = Math.min(BASE_VIEWPORT.height, screenHeight - 80);
  return {
    oaiDeviceId,
    hardwareConcurrency: pickFrom(seed[0], coresChoices),
    deviceMemory: pickFrom(seed[1], memoryChoices),
    viewport: {
      width: jitter(seed[2], baseWidth, JITTER_PX),
      height: jitter(seed[3], baseHeight, JITTER_PX),
    },
    canvasNoiseSeed: seed.subarray(4, 12).toString("hex"),
    audioNoiseSeed: seed.subarray(12, 20).toString("hex"),
  };
}

export function buildContextOptions({ fingerprint, proxy, locale = "vi-VN", timezoneId = "Asia/Ho_Chi_Minh" }) {
  const opts = {
    viewport: { width: fingerprint.viewport.width, height: fingerprint.viewport.height },
    deviceScaleFactor: 2,
    locale,
    timezoneId,
    extraHTTPHeaders: {
      "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    bypassCSP: false,
  };
  if (proxy) opts.proxy = proxy;
  return opts;
}

// Returned string is passed to context.addInitScript. Runs at document_start on
// EVERY page/iframe in the context, before any site script executes — so canvas
// and audio hooks are in place by the time Arkose boots.
export function buildInitScript(fingerprint) {
  const { hardwareConcurrency, deviceMemory, canvasNoiseSeed, audioNoiseSeed } = fingerprint;
  // The init script is interpolated as a string; keep every value here primitive.
  return `
(() => {
  const seedHex = ${JSON.stringify(canvasNoiseSeed)};
  const audioSeedHex = ${JSON.stringify(audioNoiseSeed)};
  const seedBytes = new Uint8Array(seedHex.match(/.{1,2}/g).map(h => parseInt(h, 16)));
  const audioSeedBytes = new Uint8Array(audioSeedHex.match(/.{1,2}/g).map(h => parseInt(h, 16)));

  // navigator.hardwareConcurrency / deviceMemory: deterministic per account.
  // Chrome exposes these as prototype getters on Navigator.prototype that are
  // configurable, but some ships make them own-properties on the navigator
  // instance; override BOTH places so whichever lookup path a probe takes sees
  // our value.
  const navForce = (name, value) => {
    try {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    } catch {}
    try {
      Object.defineProperty(navigator, name, { get: () => value, configurable: true });
    } catch {}
  };
  navForce('hardwareConcurrency', ${Number(hardwareConcurrency)});
  navForce('deviceMemory', ${Number(deviceMemory)});
  navForce('webdriver', false);
  // Language override: CloakBrowser humanize set navigator.language = "en-US"
  // bất chấp context locale "vi-VN". Pin về vi-VN để khớp proxy VN + accept-language.
  navForce('language', 'vi-VN');
  navForce('languages', Object.freeze(['vi-VN', 'vi', 'en-US', 'en']));

  // userAgentData brand pin: CloakBrowser's binary bakes brand "Chromium"
  // version 145 trong Sec-CH-UA, nhưng UA string mình force 146. creepjs/pixelscan
  // cross-check userAgentData.brands vs userAgent major → mismatch = red flag.
  // Override cả brands + getHighEntropyValues để trả về cùng major UA.
  try {
    const uaMajor = (navigator.userAgent.match(/Chrome\\/(\\d+)/) || [])[1] || '146';
    const brandsFaked = Object.freeze([
      Object.freeze({ brand: 'Chromium', version: uaMajor }),
      Object.freeze({ brand: 'Google Chrome', version: uaMajor }),
      Object.freeze({ brand: 'Not=A?Brand', version: '24' }),
    ]);
    const uaDataFaked = {
      brands: brandsFaked,
      mobile: false,
      platform: 'macOS',
      getHighEntropyValues: (hints) => Promise.resolve({
        brands: brandsFaked,
        mobile: false,
        platform: 'macOS',
        platformVersion: '15.2.0',
        architecture: 'arm',
        bitness: '64',
        model: '',
        uaFullVersion: uaMajor + '.0.0.0',
        fullVersionList: brandsFaked.map((b) => ({ brand: b.brand, version: b.version + '.0.0.0' })),
      }),
      toJSON: () => ({ brands: brandsFaked, mobile: false, platform: 'macOS' }),
    };
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => uaDataFaked, configurable: true });
  } catch {}

  // Timezone + locale override: CloakBrowser Chromium ship ICU cũ, trả
  // "Asia/Saigon" (IANA alias deprecated 2010) thay vì "Asia/Ho_Chi_Minh", và
  // Intl.* default locale = "en-US" bất chấp navigator.language = "vi-VN".
  // Pixelscan cross-check lang vs Intl.locale → mismatch = "Masking detected".
  // Patch resolvedOptions() cho CẢ DateTimeFormat/NumberFormat/Collator/
  // RelativeTimeFormat/ListFormat/PluralRules để trả về vi-VN + canonical TZ.
  try {
    const canonicalTZ = (tz) => tz === 'Asia/Saigon' ? 'Asia/Ho_Chi_Minh' : tz;
    const spoofResolve = (origResolve) => function patched() {
      const opts = origResolve.call(this);
      if (opts) {
        if (opts.timeZone) opts.timeZone = canonicalTZ(opts.timeZone);
        if (opts.locale === 'en-US') opts.locale = 'vi-VN';
      }
      return opts;
    };
    for (const Ctor of [Intl.DateTimeFormat, Intl.NumberFormat, Intl.Collator, Intl.RelativeTimeFormat, Intl.ListFormat, Intl.PluralRules]) {
      try {
        if (Ctor && Ctor.prototype && Ctor.prototype.resolvedOptions) {
          Ctor.prototype.resolvedOptions = spoofResolve(Ctor.prototype.resolvedOptions);
        }
      } catch {}
    }
  } catch {}

  // Canvas noise: 1-bit flip on <0.1% of bytes in getImageData output and the
  // final PNG from toDataURL. Keyed by seedBytes so the same account always
  // emits the same canvas hash.
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function patched(...args) {
    const data = origGetImageData.apply(this, args);
    const buf = data.data;
    for (let i = 0, j = 0; i < buf.length; i += 1013, j += 1) {
      buf[i] = buf[i] ^ (seedBytes[j % seedBytes.length] & 1);
    }
    return data;
  };

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function patched(...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx) {
        const w = this.width, h = this.height;
        if (w > 0 && h > 0) {
          const img = ctx.getImageData(0, 0, w, h); // triggers our patched getImageData
          ctx.putImageData(img, 0, 0);
        }
      }
    } catch {}
    return origToDataURL.apply(this, args);
  };

  // AudioContext fingerprint: perturb DynamicsCompressor sampled output by ~1e-7
  // keyed off audioSeedBytes.
  try {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function patched(ch) {
      const arr = origGetChannelData.call(this, ch);
      const n = audioSeedBytes[0] % 101; // use just one perturbation point
      if (n < arr.length) {
        const shift = (audioSeedBytes[1] / 255 - 0.5) * 2e-7;
        arr[n] += shift;
      }
      return arr;
    };
  } catch {}

  // Hide the automation-controlled badge chromeDevtools adds to window.chrome
  // when launched via CDP. Patchright already blanks most of this, but
  // "Runtime.enable" leaked-prototype checks occasionally see it in the wild.
  try {
    const origFnToString = Function.prototype.toString;
    const nativeMarker = ' { [native code] }';
    Function.prototype.toString = function patched() {
      try {
        if (this === HTMLCanvasElement.prototype.toDataURL
            || this === CanvasRenderingContext2D.prototype.getImageData
            || this === AudioBuffer.prototype.getChannelData) {
          return 'function ' + (this.name || '') + '()' + nativeMarker;
        }
      } catch {}
      return origFnToString.apply(this, arguments);
    };
  } catch {}

  // WebGL vendor/renderer: CloakBrowser Chromium đôi khi trả về
  // "WebKit"/"WebKit WebGL" (giá trị kiểu Safari) ở gl.getParameter(VENDOR/RENDERER)
  // → mismatch với UA Chrome → pixelscan flag "Masking detected".
  // Override cả 4 params (VENDOR, RENDERER, UNMASKED_VENDOR_WEBGL,
  // UNMASKED_RENDERER_WEBGL) để trả giá trị kiểu Chrome real trên macOS.
  // Giá trị dưới là Chrome 145+/macOS Apple Silicon chuẩn.
  try {
    const WEBGL_VENDOR = 0x1F00;
    const WEBGL_RENDERER = 0x1F01;
    const UNMASKED_VENDOR_WEBGL = 0x9245;
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    const chromeVendor = "Google Inc. (Apple)";
    const chromeRenderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)";
    const spoofParam = (orig) => function patched(param) {
      if (param === WEBGL_VENDOR || param === UNMASKED_VENDOR_WEBGL) return chromeVendor;
      if (param === WEBGL_RENDERER || param === UNMASKED_RENDERER_WEBGL) return chromeRenderer;
      return orig.call(this, param);
    };
    if (typeof WebGLRenderingContext !== 'undefined') {
      const orig = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = spoofParam(orig);
    }
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const orig = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = spoofParam(orig);
    }
  } catch {}

  // NOTE: Worker constructor hook (window.Worker = WrappedWorker + sync XHR
  // + Blob URL rewrite) đã BỊ TẮT. Pattern này quá aggressive: Cloudflare bot
  // detection flag khi window.Worker bị override + sync XHR fetch cross-origin
  // worker script → trigger "just a moment" challenge trên chatgpt.com/
  // auth.openai.com. Trade-off: creepjs sẽ hiện Worker scope leak lại (lang
  // en-US, timezone Asia/Saigon, UA 145, GPU M3 Max) nhưng OpenAI/Cloudflare
  // care về consistency MAIN thread chủ yếu — worker leak không block login.
})();
`;
}

// Called once per browser worker to measure the host's REAL values for the
// axes we vary around (cores / memory / screen). We launch the browser briefly
// and read, so applyFingerprint picks jitter inside the host's envelope rather
// than a hardcoded 1920x1080 that may misalign with the real screen.
export async function detectHostProfile(context) {
  // Open a blank page and read the real values.
  const page = await context.newPage();
  try {
    await page.goto("about:blank", { timeout: 5000 });
    const info = await page.evaluate(() => ({
      hardwareConcurrency: navigator.hardwareConcurrency || 8,
      deviceMemory: Number(navigator.deviceMemory) || 8,
      platform: navigator.platform || "MacIntel",
      screenWidth: screen.width,
      screenHeight: screen.height,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
    }));
    return info;
  } finally {
    await page.close().catch(() => {});
  }
}
