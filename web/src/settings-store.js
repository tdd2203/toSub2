// Console settings store, backed by the server database (GET/PUT /api/settings).
// It mirrors the localStorage API (string values, synchronous getItem/setItem)
// so callers read from an in-memory copy that is loaded once before the app
// mounts; writes update that copy immediately and are pushed to the server
// shortly after. Values left in localStorage by older versions are moved to the
// server on first load.

const KEY_PREFIX = "chatgpt-onboarding.";
const FLUSH_DELAY_MS = 400;

const cache = new Map(); // key -> string
const pending = new Map(); // key -> string | null (null = delete)
let token = "";
let loaded = false;
let flushTimer = null;

export async function loadSettingsStore() {
  try {
    const bootstrap = await fetchJson("/api/bootstrap");
    token = bootstrap.token || "";
    const data = await fetchJson("/api/settings", { headers: { "x-console-token": token } });
    for (const [key, value] of Object.entries(data.settings || {})) cache.set(key, String(value ?? ""));
    loaded = true;
    await migrateLocalStorage();
  } catch {
    // Server unreachable or too old: fall back to localStorage for this tab.
  }
}

export function getItem(key) {
  if (!loaded) return readLocal(key);
  return cache.has(key) ? cache.get(key) : null;
}

export function setItem(key, value) {
  const text = String(value ?? "");
  if (!loaded) {
    writeLocal(key, text);
    return;
  }
  if (cache.get(key) === text) return;
  cache.set(key, text);
  pending.set(key, text);
  scheduleFlush();
}

// Move settings an older version left in localStorage up to the server, but ONLY
// for keys the server does not already have — the SERVER WINS for any key it
// already holds. This prevents a browser whose localStorage is empty/stale (e.g.
// a fresh preview, or a tab that once failed to load) from clobbering the real
// server config (a nasty data-loss bug). Stale local copies of keys the server
// already has are simply dropped so they can never interfere again.
async function migrateLocalStorage() {
  const moved = {}; // keys the server lacks → migrate up
  const stale = []; // keys the server already has → drop the local copy, never push
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const value = window.localStorage.getItem(key);
      if (value === null) continue;
      if (cache.has(key)) stale.push(key); // server already has it → keep server's
      else moved[key] = value;
    }
  } catch {
    return;
  }
  for (const key of stale) {
    try { window.localStorage.removeItem(key); } catch {}
  }
  if (!Object.keys(moved).length) return;
  for (const [key, value] of Object.entries(moved)) cache.set(key, value);
  try {
    await putSettings(moved);
  } catch {
    for (const [key, value] of Object.entries(moved)) pending.set(key, value);
    scheduleFlush();
    return;
  }
  for (const key of Object.keys(moved)) {
    try { window.localStorage.removeItem(key); } catch {}
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush(options = {}) {
  if (!pending.size) return;
  const batch = Object.fromEntries(pending);
  pending.clear();
  try {
    await putSettings(batch, options);
  } catch {
    // Keep unsent values (unless a newer one is already queued) and retry.
    for (const [key, value] of Object.entries(batch)) if (!pending.has(key)) pending.set(key, value);
    if (!options.keepalive) scheduleFlush();
  }
}

function putSettings(settings, options = {}) {
  return fetchJson("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-console-token": token },
    body: JSON.stringify({ settings }),
    keepalive: Boolean(options.keepalive),
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function readLocal(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

// Don't lose the last edits when the tab is closed before the debounce fires.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    void flush({ keepalive: true });
  });
}
