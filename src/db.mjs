import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const WORKSPACE_ROOT = path.resolve(
  process.env.ONBOARDING_WORKSPACE_ROOT || path.dirname(import.meta.filename),
  "..",
);
const OUTPUT_ROOT = path.resolve(
  process.env.ONBOARDING_OUTPUT_ROOT || path.join(WORKSPACE_ROOT, "tmp", "chatgpt-onboarding-console"),
);
const DB_PATH = path.join(OUTPUT_ROOT, "toSub2.db");

let _db = null;

export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  _db = new Database(DB_PATH, { fileMustExist: false });
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");
  runMigrations(_db);
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((r) => r.name),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(migration.name);
    })();
    console.log(`[db] migration applied: ${migration.name}`);
  }
}

const MIGRATIONS = [
  {
    name: "001_initial_schema",
    sql: `
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'idle',
  prompt            TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_operation_at TEXT,
  last_operation_type TEXT DEFAULT 'initial_authorization',
  completed_at      TEXT,
  queued_at         TEXT,
  queued_mode       TEXT,
  registered_at     TEXT,
  attempt           INTEGER NOT NULL DEFAULT 1,
  output_path       TEXT,
  checkpoint_path   TEXT,
  totp_result_path  TEXT,
  password_add_result_path TEXT,
  login_mode        TEXT,
  has_password      INTEGER NOT NULL DEFAULT 0,
  has_totp_key      INTEGER NOT NULL DEFAULT 0,
  totp_known_enabled INTEGER NOT NULL DEFAULT 0,
  login_checkpoint_available INTEGER NOT NULL DEFAULT 0,
  mail_api_url      TEXT,
  mail_request_body TEXT,
  proxy_url         TEXT,
  proxy_configured  INTEGER NOT NULL DEFAULT 0,
  proxy_risk_retry_count INTEGER NOT NULL DEFAULT 0,
  proxy_connection_failure_count INTEGER NOT NULL DEFAULT 0,
  proxy_connection_error INTEGER NOT NULL DEFAULT 0,
  failed_proxy_label TEXT,
  result_saved      INTEGER NOT NULL DEFAULT 0,
  registration_succeeded INTEGER NOT NULL DEFAULT 0,
  security_check_required INTEGER NOT NULL DEFAULT 0,
  sms_provider_id   TEXT,
  sms_provider_name TEXT,
  sms_service_label TEXT,
  sms_order_id      TEXT,
  sms_number        TEXT,
  sms_status        TEXT DEFAULT 'idle',
  totp_setup_secret TEXT,
  totp_setup_uri    TEXT,
  totp_setup_error  TEXT,
  totp_setup_attempt INTEGER NOT NULL DEFAULT 0,
  password_add_error TEXT,
  password_added_at TEXT,
  last_auth_automated INTEGER NOT NULL DEFAULT 0,
  last_auth_automation_reason TEXT,
  last_auth_automated_at TEXT,
  last_auth_requirements TEXT,
  auto_repair_blocked INTEGER NOT NULL DEFAULT 0,
  auto_repair_blocked_reason TEXT,
  auto_repair_blocked_at TEXT,
  auto_repair_last_attempt_at TEXT,
  auto_repair_last_success_at TEXT,
  auto_repair_last_error TEXT,
  auto_repair_pending_account_ids TEXT,
  auto_repair_pending_backend TEXT,
  auto_repair_operation TEXT,
  sub2api_uploaded_at TEXT,
  sub2api_uploaded_base_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_email ON jobs(email);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs(completed_at);

CREATE TABLE IF NOT EXISTS job_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content   TEXT NOT NULL DEFAULT '',
  logged_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);

CREATE TABLE IF NOT EXISTS sms_cost_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider_id   TEXT,
  provider_name TEXT,
  service_label TEXT,
  order_id      TEXT,
  number        TEXT,
  event_type    TEXT NOT NULL,
  cost          REAL,
  currency      TEXT,
  raw           TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_cost_events_job_id ON sms_cost_events(job_id);

CREATE TABLE IF NOT EXISTS used_proxies (
  identity_key  TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  protocol      TEXT NOT NULL DEFAULT '',
  host          TEXT NOT NULL DEFAULT '',
  port          INTEGER NOT NULL DEFAULT 0,
  first_used_at TEXT,
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_used_proxies_label ON used_proxies(label);

CREATE TABLE IF NOT EXISTS used_proxy_emails (
  identity_key TEXT NOT NULL REFERENCES used_proxies(identity_key) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  PRIMARY KEY (identity_key, email)
);

CREATE TABLE IF NOT EXISTS proxy_pool (
  identity_key TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  protocol     TEXT NOT NULL DEFAULT '',
  host         TEXT NOT NULL DEFAULT '',
  port         INTEGER NOT NULL DEFAULT 0,
  username     TEXT NOT NULL DEFAULT '',
  password     TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  added_at     TEXT
);

CREATE TABLE IF NOT EXISTS deactivated_emails (
  email   TEXT PRIMARY KEY,
  reason  TEXT,
  at      TEXT
);

CREATE TABLE IF NOT EXISTS used_phones (
  digits         TEXT PRIMARY KEY,
  number         TEXT NOT NULL,
  uses           INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  first_used_at  TEXT,
  last_used_at   TEXT
);

CREATE TABLE IF NOT EXISTS used_phone_emails (
  digits TEXT NOT NULL REFERENCES used_phones(digits) ON DELETE CASCADE,
  email  TEXT NOT NULL,
  PRIMARY KEY (digits, email)
);

CREATE TABLE IF NOT EXISTS sub2api_monitor_config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  enabled          INTEGER NOT NULL DEFAULT 0,
  base_url         TEXT,
  admin_api_key    TEXT,
  group_ids        TEXT,
  proxy_id         TEXT,
  concurrency      INTEGER,
  load_factor      REAL,
  priority         INTEGER,
  model_whitelist  TEXT,
  codex_fingerprint_mode TEXT,
  last_check_at    TEXT,
  last_error       TEXT,
  last_result      TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
    `,
  },
  {
    // Per-account curl_cffi browser profile. Existing (old) accounts keep NULL,
    // which the console resolves to chrome146; newly created accounts are stamped
    // with the new-account profile (chrome150 by default).
    name: "002_job_tls_profile",
    sql: `ALTER TABLE jobs ADD COLUMN tls_profile TEXT;`,
  },
  {
    // Real exit IP each account registered through, recorded per account. A proxy
    // domain can rotate/reset through many exit IPs over time, so burn/throttle keyed
    // by this (not the proxy host) lets a changed IP count as a fresh one. Old rows
    // stay NULL — there is no historical exit IP to backfill.
    name: "003_used_proxy_emails_exit_ip",
    sql: `ALTER TABLE used_proxy_emails ADD COLUMN exit_ip TEXT;`,
  },
];

// ============================================================
// DAO: Data Access Objects
// ============================================================

const JOB_COLS = [
  "id", "email", "status", "prompt", "last_error",
  "created_at", "updated_at", "last_operation_at", "last_operation_type",
  "completed_at", "queued_at", "queued_mode", "registered_at", "attempt",
  "output_path", "checkpoint_path", "totp_result_path", "password_add_result_path",
  "login_mode", "has_password", "has_totp_key", "totp_known_enabled",
  "login_checkpoint_available", "mail_api_url", "mail_request_body",
  "proxy_url", "proxy_configured", "proxy_risk_retry_count",
  "proxy_connection_failure_count", "proxy_connection_error", "failed_proxy_label",
  "result_saved", "registration_succeeded", "security_check_required",
  "sms_provider_id", "sms_provider_name", "sms_service_label",
  "sms_order_id", "sms_number", "sms_status",
  "totp_setup_secret", "totp_setup_uri", "totp_setup_error", "totp_setup_attempt",
  "password_add_error", "password_added_at",
  "last_auth_automated", "last_auth_automation_reason",
  "last_auth_automated_at", "last_auth_requirements",
  "auto_repair_blocked", "auto_repair_blocked_reason", "auto_repair_blocked_at",
  "auto_repair_last_attempt_at", "auto_repair_last_success_at", "auto_repair_last_error",
  "auto_repair_pending_account_ids", "auto_repair_pending_backend", "auto_repair_operation",
  "sub2api_uploaded_at", "sub2api_uploaded_base_url",
  "tls_profile",
];

const JOB_INSERT_SQL = `INSERT INTO jobs (${JOB_COLS.join(", ")}) VALUES (${JOB_COLS.map((c) => ":" + c).join(", ")})`;
const JOB_UPDATE_SQL = `UPDATE jobs SET ${JOB_COLS.filter((c) => c !== "id").map((c) => `${c} = :${c}`).join(", ")} WHERE id = :id`;

export const jobDao = {
  insert(job) {
    getDb().prepare(JOB_INSERT_SQL).run(serializeJob(job));
  },

  update(job) {
    getDb().prepare(JOB_UPDATE_SQL).run(serializeJob(job));
  },

  getById(id) {
    return deserializeJob(getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  },

  getByEmail(email) {
    return getDb().prepare("SELECT * FROM jobs WHERE email = ? ORDER BY created_at DESC")
      .all(email.toLowerCase()).map(deserializeJob);
  },

  listAll({ status, limit, offset, search, orderBy } = {}) {
    const db = getDb();
    let sql = "SELECT * FROM jobs WHERE 1=1";
    const params = {};
    if (status) {
      sql += " AND status = :status";
      params.status = status;
    }
    if (search) {
      sql += " AND email LIKE :search";
      params.search = `%${search}%`;
    }
    sql += ` ORDER BY ${orderBy || "created_at"} DESC`;
    if (limit) {
      sql += " LIMIT :lim";
      params.lim = limit;
    }
    if (offset) {
      sql += " OFFSET :off";
      params.off = offset;
    }
    return db.prepare(sql).all(params).map(deserializeJob);
  },

  countByStatus() {
    return getDb().prepare("SELECT status, COUNT(*) as count FROM jobs GROUP BY status").all();
  },

  deleteById(id) {
    getDb().prepare("DELETE FROM jobs WHERE id = ?").run(id);
  },

  deleteByIds(ids) {
    const db = getDb();
    const del = db.prepare("DELETE FROM jobs WHERE id = ?");
    db.transaction(() => { for (const id of ids) del.run(id); })();
  },

  queryByEmails(emails) {
    if (!emails.length) return [];
    const db = getDb();
    const placeholders = emails.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM jobs WHERE LOWER(email) IN (${placeholders}) ORDER BY created_at DESC`)
      .all(emails.map((e) => e.toLowerCase())).map(deserializeJob);
  },
};

function serializeJob(job) {
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    prompt: job.prompt || null,
    last_error: job.last_error ?? job.lastError ?? null,
    created_at: job.created_at ?? job.createdAt,
    updated_at: job.updated_at ?? job.updatedAt ?? new Date().toISOString(),
    last_operation_at: job.last_operation_at ?? job.lastOperationAt ?? null,
    last_operation_type: job.last_operation_type ?? job.lastOperationType ?? "initial_authorization",
    completed_at: job.completed_at ?? job.completedAt ?? null,
    queued_at: job.queued_at ?? job.queuedAt ?? null,
    queued_mode: job.queued_mode ?? job.queuedMode ?? null,
    registered_at: job.registered_at ?? job.registeredAt ?? null,
    attempt: Number(job.attempt || 1),
    output_path: job.output_path ?? job.outputPath ?? null,
    checkpoint_path: job.checkpoint_path ?? job.checkpointPath ?? null,
    totp_result_path: job.totp_result_path ?? job.totpResultPath ?? null,
    password_add_result_path: job.password_add_result_path ?? job.passwordAddResultPath ?? null,
    login_mode: job.login_mode ?? job.loginMode ?? null,
    has_password: Number(job.has_password ?? job.hasPasswordCredential ?? 0),
    has_totp_key: Number(job.has_totp_key ?? job.hasTotpCredential ?? 0),
    totp_known_enabled: Number(job.totp_known_enabled ?? job.totpKnownEnabled ?? 0),
    login_checkpoint_available: Number(job.login_checkpoint_available ?? job.loginCheckpointAvailable ?? 0),
    mail_api_url: job.mail_api_url ?? job.mailApiUrl ?? null,
    mail_request_body: job.mail_request_body ?? job.mailRequestBody ?? null,
    proxy_url: job.proxy_url ?? job.proxyUrl ?? null,
    proxy_configured: Number(job.proxy_configured ?? (job.proxyUrl ? 1 : 0)),
    proxy_risk_retry_count: Number(job.proxy_risk_retry_count ?? job.proxyRiskRetryCount ?? 0),
    proxy_connection_failure_count: Number(job.proxy_connection_failure_count ?? job.proxyConnectionFailureCount ?? 0),
    proxy_connection_error: Number(job.proxy_connection_error ?? job.proxyConnectionError ?? 0),
    failed_proxy_label: job.failed_proxy_label ?? job.failedProxyLabel ?? null,
    result_saved: Number(job.result_saved ?? job.resultSaved ?? 0),
    registration_succeeded: Number(job.registration_succeeded ?? job.registrationSucceeded ?? 0),
    security_check_required: Number(job.security_check_required ?? job.securityCheckRequired ?? 0),
    sms_provider_id: job.sms_provider_id ?? job.smsProviderId ?? null,
    sms_provider_name: job.sms_provider_name ?? job.smsProviderName ?? null,
    sms_service_label: job.sms_service_label ?? job.smsServiceLabel ?? null,
    sms_order_id: job.sms_order_id ?? job.smsOrderId ?? null,
    sms_number: job.sms_number ?? job.smsNumber ?? null,
    sms_status: job.sms_status ?? job.smsStatus ?? "idle",
    totp_setup_secret: job.totp_setup_secret ?? job.totpSetupSecret ?? null,
    totp_setup_uri: job.totp_setup_uri ?? job.totpSetupUri ?? null,
    totp_setup_error: job.totp_setup_error ?? job.totpSetupError ?? null,
    totp_setup_attempt: Number(job.totp_setup_attempt ?? job.totpSetupAttempt ?? 0),
    password_add_error: job.password_add_error ?? job.passwordAddError ?? null,
    password_added_at: job.password_added_at ?? job.passwordAddedAt ?? null,
    last_auth_automated: Number(job.last_auth_automated ?? job.lastAuthAutomated ?? 0),
    last_auth_automation_reason: job.last_auth_automation_reason ?? job.lastAuthAutomationReason ?? null,
    last_auth_automated_at: job.last_auth_automated_at ?? job.lastAuthAutomatedAt ?? null,
    last_auth_requirements: typeof (job.last_auth_requirements ?? job.lastAuthRequirements) === "object"
      ? JSON.stringify(job.last_auth_requirements ?? job.lastAuthRequirements)
      : (job.last_auth_requirements ?? job.lastAuthRequirements ?? null),
    auto_repair_blocked: Number(job.auto_repair_blocked ?? job.autoRepairBlocked ?? 0),
    auto_repair_blocked_reason: job.auto_repair_blocked_reason ?? job.autoRepairBlockedReason ?? null,
    auto_repair_blocked_at: job.auto_repair_blocked_at ?? job.autoRepairBlockedAt ?? null,
    auto_repair_last_attempt_at: job.auto_repair_last_attempt_at ?? job.autoRepairLastAttemptAt ?? null,
    auto_repair_last_success_at: job.auto_repair_last_success_at ?? job.autoRepairLastSuccessAt ?? null,
    auto_repair_last_error: job.auto_repair_last_error ?? job.autoRepairLastError ?? null,
    auto_repair_pending_account_ids: JSON.stringify(job.auto_repair_pending_account_ids ?? job.autoRepairPendingAccountIds ?? []),
    auto_repair_pending_backend: job.auto_repair_pending_backend ?? job.autoRepairPendingBackend ?? null,
    auto_repair_operation: job.auto_repair_operation ?? job.autoRepairOperation ?? null,
    sub2api_uploaded_at: job.sub2api_uploaded_at ?? job.sub2apiUploadedAt ?? null,
    sub2api_uploaded_base_url: job.sub2api_uploaded_base_url ?? job.sub2apiUploadedBaseUrl ?? null,
    tls_profile: job.tls_profile ?? job.tlsProfile ?? null,
  };
}

function deserializeJob(row) {
  if (!row) return null;
  return {
    ...row,
    has_password: Boolean(row.has_password),
    has_totp_key: Boolean(row.has_totp_key),
    totp_known_enabled: Boolean(row.totp_known_enabled),
    login_checkpoint_available: Boolean(row.login_checkpoint_available),
    proxy_configured: Boolean(row.proxy_configured),
    proxy_connection_error: Boolean(row.proxy_connection_error),
    result_saved: Boolean(row.result_saved),
    registration_succeeded: Boolean(row.registration_succeeded),
    security_check_required: Boolean(row.security_check_required),
    last_auth_automated: Boolean(row.last_auth_automated),
    auto_repair_blocked: Boolean(row.auto_repair_blocked),
    last_auth_requirements: row.last_auth_requirements ? JSON.parse(row.last_auth_requirements) : null,
    auto_repair_pending_account_ids: row.auto_repair_pending_account_ids ? JSON.parse(row.auto_repair_pending_account_ids) : [],
  };
}

// ---- SMS Cost Events ----

export const smsCostDao = {
  insert(jobId, event) {
    getDb().prepare(`
      INSERT INTO sms_cost_events (job_id, provider_id, provider_name, service_label,
        order_id, number, event_type, cost, currency, raw, created_at)
      VALUES (:job_id, :provider_id, :provider_name, :service_label,
        :order_id, :number, :event_type, :cost, :currency, :raw, :created_at)
    `).run({
      job_id: jobId,
      provider_id: event.providerId || event.provider_id || null,
      provider_name: event.providerName || event.provider_name || null,
      service_label: event.serviceLabel || event.service_label || null,
      order_id: event.orderId || event.order_id || null,
      number: event.number || null,
      event_type: event.type || event.event_type || "unknown",
      cost: event.cost ?? null,
      currency: event.currency || null,
      raw: event.raw ? JSON.stringify(event.raw) : null,
      created_at: event.at || event.created_at || new Date().toISOString(),
    });
  },

  insertBatch(jobId, events) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO sms_cost_events (job_id, provider_id, provider_name, service_label,
        order_id, number, event_type, cost, currency, raw, created_at)
      VALUES (:job_id, :provider_id, :provider_name, :service_label,
        :order_id, :number, :event_type, :cost, :currency, :raw, :created_at)
    `);
    db.transaction(() => {
      for (const event of events) {
        stmt.run({
          job_id: jobId,
          provider_id: event.providerId || event.provider_id || null,
          provider_name: event.providerName || event.provider_name || null,
          service_label: event.serviceLabel || event.service_label || null,
          order_id: event.orderId || event.order_id || null,
          number: event.number || null,
          event_type: event.type || event.event_type || "unknown",
          cost: event.cost ?? null,
          currency: event.currency || null,
          raw: event.raw ? JSON.stringify(event.raw) : null,
          created_at: event.at || event.created_at || new Date().toISOString(),
        });
      }
    })();
  },

  getByJobId(jobId) {
    return getDb().prepare("SELECT * FROM sms_cost_events WHERE job_id = ? ORDER BY created_at").all(jobId);
  },

  totalCostSummary() {
    return getDb().prepare(`
      SELECT provider_name, currency, SUM(cost) as total_cost, COUNT(*) as event_count
      FROM sms_cost_events WHERE cost IS NOT NULL GROUP BY provider_name, currency
    `).all();
  },
};

// ---- Used Proxies ----

export const usedProxyDao = {
  upsert(identityKey, entry) {
    getDb().prepare(`
      INSERT INTO used_proxies (identity_key, label, protocol, host, port, first_used_at, last_used_at)
      VALUES (:key, :label, :protocol, :host, :port, :first, :last)
      ON CONFLICT(identity_key) DO UPDATE SET
        label = :label, protocol = :protocol, host = :host, port = :port, last_used_at = :last
    `).run({
      key: identityKey,
      label: entry.label,
      protocol: entry.protocol || "",
      host: entry.host || "",
      port: entry.port || 0,
      first: entry.firstUsedAt || entry.first_used_at || new Date().toISOString(),
      last: entry.lastUsedAt || entry.last_used_at || new Date().toISOString(),
    });
  },

  // exitIp is set once known (at registration); a null value never overwrites an
  // exit IP already recorded for this (identity_key, email).
  addEmail(identityKey, email, exitIp = null) {
    getDb().prepare(`
      INSERT INTO used_proxy_emails (identity_key, email, exit_ip)
      VALUES (?, ?, ?)
      ON CONFLICT(identity_key, email) DO UPDATE SET
        exit_ip = COALESCE(excluded.exit_ip, exit_ip)
    `).run(identityKey, email, exitIp || null);
  },

  recordUsage(identityKey, entry, email, exitIp = null) {
    const db = getDb();
    db.transaction(() => {
      usedProxyDao.upsert(identityKey, entry);
      if (email) usedProxyDao.addEmail(identityKey, email, exitIp);
    })();
  },

  getAll() {
    const db = getDb();
    const proxies = db.prepare("SELECT * FROM used_proxies ORDER BY last_used_at DESC").all();
    const emailStmt = db.prepare("SELECT email FROM used_proxy_emails WHERE identity_key = ?");
    return proxies.map((p) => ({
      ...p,
      emails: emailStmt.all(p.identity_key).map((r) => r.email),
    }));
  },

  has(identityKey) {
    return Boolean(getDb().prepare("SELECT 1 FROM used_proxies WHERE identity_key = ?").get(identityKey));
  },

  getEmails(identityKey) {
    return getDb().prepare("SELECT email FROM used_proxy_emails WHERE identity_key = ?")
      .all(identityKey).map((r) => r.email);
  },

  // Lifetime per-host account history, joined with the deactivated registry.
  // The proxy ledger is never pruned (even when a job is deleted), so this
  // surfaces IPs that have already burned accounts — the signal the live job
  // list loses the moment a deactivated task is removed. Returns a Map keyed by
  // host: { total, deactivated }.
  deactivationHistoryByHost() {
    const rows = getDb().prepare(`
      SELECT p.host AS host,
             COUNT(DISTINCT e.email) AS total,
             COUNT(DISTINCT CASE WHEN d.email IS NOT NULL THEN e.email END) AS deactivated
      FROM used_proxies p
      JOIN used_proxy_emails e ON e.identity_key = p.identity_key
      LEFT JOIN deactivated_emails d ON lower(e.email) = d.email
      WHERE p.host <> ''
      GROUP BY p.host
    `).all();
    const map = new Map();
    for (const r of rows) {
      map.set(r.host, { total: Number(r.total) || 0, deactivated: Number(r.deactivated) || 0 });
    }
    return map;
  },

  // Lifetime per-EXIT-IP account history. exit_ip is recorded per account on
  // used_proxy_emails at registration time (the real IP OpenAI saw), so this keys
  // the burn signal by the actual IP rather than the proxy line's host/domain —
  // after the operator resets a domain's exit IP, the new IP starts clean. Records
  // from before exit_ip existed are NULL and excluded (no history to attribute).
  // Returns a Map keyed by exit_ip: { total, deactivated }.
  deactivationHistoryByExitIp() {
    const rows = getDb().prepare(`
      SELECT e.exit_ip AS exitIp,
             COUNT(DISTINCT e.email) AS total,
             COUNT(DISTINCT CASE WHEN d.email IS NOT NULL THEN e.email END) AS deactivated
      FROM used_proxy_emails e
      LEFT JOIN deactivated_emails d ON lower(e.email) = d.email
      WHERE e.exit_ip IS NOT NULL AND e.exit_ip <> ''
      GROUP BY e.exit_ip
    `).all();
    const map = new Map();
    for (const r of rows) {
      map.set(r.exitIp, { total: Number(r.total) || 0, deactivated: Number(r.deactivated) || 0 });
    }
    return map;
  },

  remove(identityKey) {
    const db = getDb();
    db.transaction(() => {
      db.prepare("DELETE FROM used_proxy_emails WHERE identity_key = ?").run(identityKey);
      db.prepare("DELETE FROM used_proxies WHERE identity_key = ?").run(identityKey);
    })();
  },

  clearAll() {
    const db = getDb();
    db.transaction(() => {
      db.prepare("DELETE FROM used_proxy_emails").run();
      db.prepare("DELETE FROM used_proxies").run();
    })();
  },
};

// ---- Proxy Pool ----

export const proxyPoolDao = {
  upsert(identityKey, entry) {
    getDb().prepare(`
      INSERT INTO proxy_pool (identity_key, label, protocol, host, port, username, password, url, added_at)
      VALUES (:key, :label, :protocol, :host, :port, :username, :password, :url, :added_at)
      ON CONFLICT(identity_key) DO UPDATE SET label = :label, url = :url, added_at = :added_at
    `).run({
      key: identityKey,
      label: entry.label,
      protocol: entry.protocol || "",
      host: entry.host || "",
      port: entry.port || 0,
      username: entry.username || "",
      password: entry.password || "",
      url: entry.url || "",
      added_at: entry.addedAt || entry.added_at || new Date().toISOString(),
    });
  },

  has(identityKey) {
    return Boolean(getDb().prepare("SELECT 1 FROM proxy_pool WHERE identity_key = ?").get(identityKey));
  },

  getAll() {
    return getDb().prepare("SELECT * FROM proxy_pool ORDER BY added_at DESC").all();
  },

  deleteByKey(identityKey) {
    getDb().prepare("DELETE FROM proxy_pool WHERE identity_key = ?").run(identityKey);
  },

  clearAll() {
    getDb().prepare("DELETE FROM proxy_pool").run();
  },

  importBatch(entries) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO proxy_pool (identity_key, label, protocol, host, port, username, password, url, added_at)
      VALUES (:key, :label, :protocol, :host, :port, :username, :password, :url, :added_at)
      ON CONFLICT(identity_key) DO NOTHING
    `);
    let added = 0;
    let skipped = 0;
    db.transaction(() => {
      for (const { key, ...entry } of entries) {
        const result = stmt.run({
          key,
          label: entry.label,
          protocol: entry.protocol || "",
          host: entry.host || "",
          port: entry.port || 0,
          username: entry.username || "",
          password: entry.password || "",
          url: entry.url || "",
          added_at: entry.addedAt || entry.added_at || new Date().toISOString(),
        });
        if (result.changes > 0) added++; else skipped++;
      }
    })();
    return { added, skipped };
  },
};

// ---- Deactivated Emails ----

export const deactivatedEmailDao = {
  upsert(email, reason, at) {
    getDb().prepare(`
      INSERT INTO deactivated_emails (email, reason, at) VALUES (:email, :reason, :at)
      ON CONFLICT(email) DO UPDATE SET
        reason = COALESCE(:reason, deactivated_emails.reason),
        at = COALESCE(deactivated_emails.at, :at)
    `).run({
      email: email.toLowerCase(),
      reason: reason ? String(reason).slice(0, 500) : null,
      at: at || new Date().toISOString(),
    });
  },

  has(email) {
    return Boolean(getDb().prepare("SELECT 1 FROM deactivated_emails WHERE email = ?").get(email.toLowerCase()));
  },

  get(email) {
    return getDb().prepare("SELECT * FROM deactivated_emails WHERE email = ?").get(email.toLowerCase()) || null;
  },

  getAll() {
    return getDb().prepare("SELECT * FROM deactivated_emails ORDER BY at DESC").all();
  },

  remove(email) {
    return getDb().prepare("DELETE FROM deactivated_emails WHERE email = ?").run(email.toLowerCase()).changes > 0;
  },

  clearAll() {
    getDb().prepare("DELETE FROM deactivated_emails").run();
  },
};

// ---- Used Phones ----

export const usedPhoneDao = {
  upsert(digits, entry) {
    getDb().prepare(`
      INSERT INTO used_phones (digits, number, uses, blocked, blocked_reason, first_used_at, last_used_at)
      VALUES (:digits, :number, :uses, :blocked, :blocked_reason, :first, :last)
      ON CONFLICT(digits) DO UPDATE SET
        number = :number, uses = :uses, blocked = :blocked,
        blocked_reason = :blocked_reason, last_used_at = :last
    `).run({
      digits,
      number: entry.number,
      uses: entry.uses || 0,
      blocked: Number(entry.blocked || 0),
      blocked_reason: entry.blockedReason || entry.blocked_reason || null,
      first: entry.firstUsedAt || entry.first_used_at || new Date().toISOString(),
      last: entry.lastUsedAt || entry.last_used_at || new Date().toISOString(),
    });
  },

  addEmail(digits, email) {
    getDb().prepare("INSERT OR IGNORE INTO used_phone_emails (digits, email) VALUES (?, ?)").run(digits, email);
  },

  recordUsage(digits, entry, email) {
    const db = getDb();
    db.transaction(() => {
      usedPhoneDao.upsert(digits, entry);
      if (email) usedPhoneDao.addEmail(digits, email);
    })();
  },

  get(digits) {
    const db = getDb();
    const phone = db.prepare("SELECT * FROM used_phones WHERE digits = ?").get(digits);
    if (!phone) return null;
    phone.emails = db.prepare("SELECT email FROM used_phone_emails WHERE digits = ?")
      .all(digits).map((r) => r.email);
    phone.blocked = Boolean(phone.blocked);
    return phone;
  },

  getAll() {
    const db = getDb();
    const phones = db.prepare("SELECT * FROM used_phones ORDER BY last_used_at DESC").all();
    const emailStmt = db.prepare("SELECT email FROM used_phone_emails WHERE digits = ?");
    return phones.map((p) => ({
      ...p,
      blocked: Boolean(p.blocked),
      emails: emailStmt.all(p.digits).map((r) => r.email),
    }));
  },

  isAvailable(digits, maxUses) {
    const entry = getDb().prepare("SELECT blocked, uses FROM used_phones WHERE digits = ?").get(digits);
    if (!entry) return true;
    if (entry.blocked) return false;
    if (maxUses > 0 && entry.uses >= maxUses) return false;
    return true;
  },

  markBlocked(digits, number, reason, email) {
    const db = getDb();
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO used_phones (digits, number, uses, blocked, blocked_reason, first_used_at, last_used_at)
        VALUES (:d, :n, 0, 1, :r, :now, :now)
        ON CONFLICT(digits) DO UPDATE SET blocked = 1, blocked_reason = :r, last_used_at = :now
      `).run({ d: digits, n: number, r: reason || null, now });
      if (email) {
        db.prepare("INSERT OR IGNORE INTO used_phone_emails (digits, email) VALUES (?, ?)").run(digits, email);
      }
    })();
  },

  stats(maxUses) {
    const row = getDb().prepare(`
      SELECT COUNT(*) as total, SUM(blocked) as blocked_count, SUM(uses) as total_uses FROM used_phones
    `).get();
    return {
      maxUses,
      totalNumbers: row.total,
      blocked: row.blocked_count || 0,
      totalUses: row.total_uses || 0,
    };
  },

  clearAll() {
    const db = getDb();
    db.transaction(() => {
      db.prepare("DELETE FROM used_phone_emails").run();
      db.prepare("DELETE FROM used_phones").run();
    })();
  },
};

// ---- Sub2API Monitor Config ----

export const sub2apiMonitorDao = {
  get() {
    return getDb().prepare("SELECT * FROM sub2api_monitor_config WHERE id = 1").get() || null;
  },

  upsert(config) {
    getDb().prepare(`
      INSERT INTO sub2api_monitor_config (id, enabled, base_url, admin_api_key, group_ids,
        proxy_id, concurrency, load_factor, priority, model_whitelist,
        codex_fingerprint_mode, last_check_at, last_error, last_result, updated_at)
      VALUES (1, :enabled, :base_url, :admin_api_key, :group_ids,
        :proxy_id, :concurrency, :load_factor, :priority, :model_whitelist,
        :codex_fingerprint_mode, :last_check_at, :last_error, :last_result, :updated_at)
      ON CONFLICT(id) DO UPDATE SET
        enabled = :enabled, base_url = :base_url, admin_api_key = :admin_api_key,
        group_ids = :group_ids, proxy_id = :proxy_id, concurrency = :concurrency,
        load_factor = :load_factor, priority = :priority, model_whitelist = :model_whitelist,
        codex_fingerprint_mode = :codex_fingerprint_mode,
        last_check_at = :last_check_at, last_error = :last_error, last_result = :last_result,
        updated_at = :updated_at
    `).run({
      enabled: Number(config.enabled || 0),
      base_url: config.baseUrl || config.base_url || null,
      admin_api_key: config.adminApiKey || config.admin_api_key || null,
      group_ids: JSON.stringify(config.groupIds || config.group_ids || []),
      proxy_id: config.proxyId || config.proxy_id || null,
      concurrency: config.concurrency ?? null,
      load_factor: (config.loadFactor ?? config.load_factor) ?? null,
      priority: config.priority ?? null,
      model_whitelist: JSON.stringify(config.modelWhitelist || config.model_whitelist || []),
      codex_fingerprint_mode: config.codexFingerprintMode || config.codex_fingerprint_mode || null,
      last_check_at: config.lastCheckAt || config.last_check_at || null,
      last_error: config.lastError || config.last_error || null,
      last_result: (config.lastResult || config.last_result)
        ? JSON.stringify(config.lastResult || config.last_result)
        : null,
      updated_at: new Date().toISOString(),
    });
  },

  remove() {
    getDb().prepare("DELETE FROM sub2api_monitor_config WHERE id = 1").run();
  },
};

// ---- Settings (key-value) ----

export const settingsDao = {
  get(key) {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
  },

  set(key, value) {
    getDb().prepare(`
      INSERT INTO settings (key, value) VALUES (:key, :value)
      ON CONFLICT(key) DO UPDATE SET value = :value
    `).run({ key, value: String(value) });
  },

  remove(key) {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
  },

  getAll() {
    return getDb().prepare("SELECT * FROM settings ORDER BY key").all();
  },
};

// ---- Job Logs ----

export const jobLogDao = {
  append(jobId, content) {
    getDb().prepare("INSERT INTO job_logs (job_id, content, logged_at) VALUES (?, ?, datetime('now'))").run(jobId, content);
  },

  getByJobId(jobId, { limit = 100 } = {}) {
    return getDb().prepare("SELECT * FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(jobId, limit);
  },

  deleteByJobId(jobId) {
    getDb().prepare("DELETE FROM job_logs WHERE job_id = ?").run(jobId);
  },
};

// ---- Migration helpers: import từ JSON files cũ ----

export function migrateFromJsonFiles(outputRoot) {
  const db = getDb();
  const root = outputRoot || OUTPUT_ROOT;

  const imported = { jobs: 0, proxies: 0, phones: 0, deactivated: 0, proxyPool: 0 };

  // Used proxies
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "used-proxies.json"), "utf8"));
    const entries = data?.entries || {};
    db.transaction(() => {
      for (const [key, entry] of Object.entries(entries)) {
        usedProxyDao.upsert(key, entry);
        if (Array.isArray(entry.emails)) {
          for (const email of entry.emails) usedProxyDao.addEmail(key, email);
        }
      }
    })();
    imported.proxies = Object.keys(entries).length;
  } catch (e) { if (e?.code !== "ENOENT") console.warn("[db] skip used-proxies.json:", e.message); }

  // Used phones
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "used-phones.json"), "utf8"));
    if (data.maxUses !== undefined) settingsDao.set("phone_max_uses", String(data.maxUses));
    const entries = data?.entries || {};
    db.transaction(() => {
      for (const [digits, entry] of Object.entries(entries)) {
        usedPhoneDao.upsert(digits, entry);
        if (Array.isArray(entry.emails)) {
          for (const email of entry.emails) usedPhoneDao.addEmail(digits, email);
        }
      }
    })();
    imported.phones = Object.keys(entries).length;
  } catch (e) { if (e?.code !== "ENOENT") console.warn("[db] skip used-phones.json:", e.message); }

  // Deactivated emails
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "deactivated-emails.json"), "utf8"));
    const entries = data?.entries || {};
    db.transaction(() => {
      for (const [, entry] of Object.entries(entries)) {
        deactivatedEmailDao.upsert(entry.email, entry.reason, entry.at);
      }
    })();
    imported.deactivated = Object.keys(entries).length;
  } catch (e) { if (e?.code !== "ENOENT") console.warn("[db] skip deactivated-emails.json:", e.message); }

  // Proxy pool
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "proxy-pool.json"), "utf8"));
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    db.transaction(() => {
      for (const entry of entries) {
        if (!entry?.key) continue;
        proxyPoolDao.upsert(entry.key, entry);
      }
    })();
    imported.proxyPool = entries.length;
  } catch (e) { if (e?.code !== "ENOENT") console.warn("[db] skip proxy-pool.json:", e.message); }

  // Sub2API monitor
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "sub2api-monitor.json"), "utf8"));
    sub2apiMonitorDao.upsert({
      enabled: data.enabled,
      ...data.config,
      lastCheckAt: data.state?.lastCheckAt,
      lastError: data.state?.lastError,
      lastResult: data.state?.lastResult,
    });
  } catch (e) { if (e?.code !== "ENOENT") console.warn("[db] skip sub2api-monitor.json:", e.message); }

  // Job metadata from per-job directories
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true });
    db.transaction(() => {
      for (const dirent of dirs) {
        if (!dirent.isDirectory()) continue;
        const metaPath = path.join(root, dirent.name, "job-meta.json");
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          if (!meta.email) continue;
          const jobId = dirent.name;
          const outputDir = path.join(root, jobId);
          jobDao.insert({
            id: jobId,
            email: meta.email,
            status: meta.status || "completed",
            prompt: meta.prompt || null,
            last_error: meta.last_error || null,
            created_at: meta.created_at || meta.updated_at || new Date().toISOString(),
            updated_at: meta.updated_at || new Date().toISOString(),
            last_operation_at: meta.last_operation_at || meta.created_at,
            last_operation_type: meta.last_operation_type || "initial_authorization",
            completed_at: meta.completed_at || null,
            queued_at: meta.queued_at || null,
            queued_mode: meta.queued_mode || null,
            registered_at: meta.registered_at || null,
            attempt: meta.attempt || 1,
            output_path: path.join(outputDir, "sub2api-import-oauth.json"),
            checkpoint_path: path.join(outputDir, "login-checkpoint.json"),
            totp_result_path: path.join(outputDir, "totp-setup-result.json"),
            password_add_result_path: path.join(outputDir, "password-add-result.json"),
            login_mode: meta.login_mode || null,
            has_password: Number(meta.has_password || 0),
            has_totp_key: Number(meta.has_totp_key || 0),
            totp_known_enabled: Number(meta.totp_known_enabled || 0),
            login_checkpoint_available: Number(meta.login_checkpoint_available || 0),
            mail_api_url: meta.mail_api_url || null,
            mail_request_body: meta.mail_request_body || null,
            proxy_configured: Number(meta.proxy_configured || 0),
            proxy_risk_retry_count: meta.proxy_risk_retry_count || 0,
            proxy_connection_failure_count: meta.proxy_connection_failure_count || 0,
            proxy_connection_error: Number(meta.proxy_connection_error || 0),
            failed_proxy_label: meta.failed_proxy_label || null,
            result_saved: Number(meta.result_saved || 0),
            registration_succeeded: Number(meta.registration_succeeded || 0),
            security_check_required: Number(meta.security_check_required || 0),
            sms_provider_id: meta.sms_provider_id || null,
            sms_provider_name: meta.sms_provider_name || null,
            sms_service_label: meta.sms_service_label || null,
            sms_order_id: meta.sms_order_id || null,
            sms_number: meta.sms_number || null,
            sms_status: meta.sms_status || "idle",
            password_add_error: meta.password_add_error || null,
            password_added_at: meta.password_added_at || null,
            last_auth_automated: Number(meta.last_auth_automated || 0),
            last_auth_automation_reason: meta.last_auth_automation_reason || null,
            last_auth_automated_at: meta.last_auth_automated_at || null,
            last_auth_requirements: meta.last_auth_requirements
              ? JSON.stringify(meta.last_auth_requirements) : null,
            auto_repair_blocked: Number(meta.auto_repair_blocked || 0),
            auto_repair_blocked_reason: meta.auto_repair_blocked_reason || null,
            auto_repair_blocked_at: meta.auto_repair_blocked_at || null,
            auto_repair_last_attempt_at: meta.auto_repair_last_attempt_at || null,
            auto_repair_last_success_at: meta.auto_repair_last_success_at || null,
            auto_repair_last_error: meta.auto_repair_last_error || null,
            auto_repair_pending_account_ids: JSON.stringify(meta.auto_repair_pending_account_ids || []),
            auto_repair_pending_backend: meta.auto_repair_pending_backend || null,
            sub2api_uploaded_at: meta.sub2api_uploaded_at || null,
            sub2api_uploaded_base_url: meta.sub2api_uploaded_base_url || null,
            tls_profile: meta.tls_profile || null,
          });
          if (Array.isArray(meta.sms_cost_events) && meta.sms_cost_events.length) {
            smsCostDao.insertBatch(jobId, meta.sms_cost_events);
          }
          imported.jobs++;
        } catch { /* skip non-job dirs */ }
      }
    })();
  } catch (e) { console.warn("[db] job scan error:", e.message); }

  return imported;
}
