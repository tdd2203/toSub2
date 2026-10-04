#!/usr/bin/env node
import { getDb, closeDb, migrateFromJsonFiles } from "./db.mjs";

console.log("[migrate] Initializing database...");
const db = getDb();
console.log("[migrate] Database ready. Starting data migration from JSON files...\n");

const result = migrateFromJsonFiles();

console.log("[migrate] Migration complete:");
console.log(`  Jobs imported:              ${result.jobs}`);
console.log(`  Used proxies imported:      ${result.proxies}`);
console.log(`  Used phones imported:       ${result.phones}`);
console.log(`  Deactivated emails imported: ${result.deactivated}`);
console.log(`  Proxy pool imported:        ${result.proxyPool}`);
console.log();

const stats = db.prepare("SELECT COUNT(*) as count FROM jobs").get();
console.log(`[migrate] Total jobs in database: ${stats.count}`);

const statusCounts = db.prepare("SELECT status, COUNT(*) as c FROM jobs GROUP BY status ORDER BY c DESC").all();
if (statusCounts.length) {
  console.log("[migrate] Jobs by status:");
  for (const { status, c } of statusCounts) console.log(`  ${status}: ${c}`);
}

closeDb();
console.log("\n[migrate] Done. Database saved to tmp/chatgpt-onboarding-console/toSub2.db");
