// Detect which Google Chrome Stable the host has installed, so the real-browser
// lane (patchright + channel:'chrome') and the TLS lane can pin their JA4 / UA /
// UA-CH to the same major during an A/B window. We never override the browser's
// userAgent in the browser lane — the installed Chrome's UA is sent verbatim —
// so this value exists primarily so the TLS lane can match it and so the
// operator sees it in the UI / health endpoint.
//
// Resolution order:
//   1. `chromium.executablePath({channel:'chrome'})` from patchright, if a
//      patchright import succeeded. This is the exact binary launchPersistentContext
//      will use.
//   2. The macOS stable install path `/Applications/Google Chrome.app/.../Google Chrome`.
//   3. `google-chrome` on PATH (Linux fallback).

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DARWIN_CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function patchrightChromeBinary() {
  try {
    const pw = await import("patchright");
    const chromium = pw.chromium || pw.default?.chromium;
    if (chromium && typeof chromium.executablePath === "function") {
      const bin = chromium.executablePath({ channel: "chrome" });
      if (bin && fs.existsSync(bin)) return bin;
    }
  } catch {
    /* patchright not installed yet — fall through */
  }
  return null;
}

function findChromeBinarySync() {
  if (process.platform === "darwin" && fs.existsSync(DARWIN_CHROME_BIN)) return DARWIN_CHROME_BIN;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const out = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

function parseMajor(versionLine) {
  if (!versionLine) return null;
  const match = String(versionLine).match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number(match[1]);
  if (!Number.isFinite(major) || major < 50 || major > 500) return null;
  return major;
}

export async function detectInstalledChromeMajor() {
  const bin = (await patchrightChromeBinary()) || findChromeBinarySync();
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
    return parseMajor(out);
  } catch {
    return null;
  }
}

export async function detectInstalledChrome() {
  const bin = (await patchrightChromeBinary()) || findChromeBinarySync();
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
    const major = parseMajor(out);
    return { bin, version: out.trim(), major };
  } catch {
    return { bin, version: null, major: null };
  }
}

export async function printInstalledChromeMajor() {
  const info = await detectInstalledChrome();
  if (!info) {
    console.error("[chrome] no stable Chrome binary found");
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(info));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printInstalledChromeMajor();
}
