import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-console-resend-"));
const port = await findAvailablePort();
const mailboxPort = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const mailboxUrl = `http://127.0.0.1:${mailboxPort}/messages`;
// The mailbox stays empty until the login flow has been asked to resend twice.
let mailboxHasCode = false;
const mailbox = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(mailboxHasCode
    ? JSON.stringify({ found: true, code: "424242", subject: "Your ChatGPT code is 424242", received_at: new Date().toISOString() })
    : JSON.stringify({ found: false, code: null }));
});
await new Promise((resolve) => mailbox.listen(mailboxPort, "127.0.0.1", resolve));

const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-resend-protocol.mjs"),
    TOSUB2_SIGNUP_BACKEND: "tls",
    TOSUB2_ALLOW_TLS_SIGNUP: "1",
    MAIL_AUTO_RESEND_AFTER_MS: "400",
    TOSUB2_TLS_PROFILE: "chrome142",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let consoleLogs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
const childExit = new Promise((resolve) => child.once("exit", resolve));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "no-first-code@example.com", mailApiUrl: mailboxUrl }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const jobId = (await created.json()).job.id;
  const readLogs = async () => (await (await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers })).json()).logs;

  // No code arrives, so the console asks for a new one by itself — but only twice.
  await waitFor(async () => countOccurrences(await readLogs(), "[mock] email OTP resent") === 2);
  await delay(1_500);
  assert.equal(countOccurrences(await readLogs(), "[mock] email OTP resent"), 2, "auto resend is capped");
  const waiting = await waitForJob(headers, jobId, (job) => job.status === "email_otp");
  assert.equal(waiting.mailStatus, "polling");

  // Once the resent code lands in the mailbox it is picked up and submitted.
  mailboxHasCode = true;
  await waitFor(async () => (await readLogs()).includes("[mock] email OTP accepted 424242"));
  await fetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: "POST", headers, body: "{}" });
  console.log("console mail auto resend tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${consoleLogs}`;
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await new Promise((resolve) => mailbox.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`console exited before startup with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`console did not start at ${url}`);
}

async function waitForJob(headers, jobId, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers });
    const page = await response.json();
    const job = page.jobs.find((item) => item.id === jobId);
    if (job && predicate(job)) return job;
    await delay(100);
  }
  throw new Error(`job ${jobId} did not reach the expected state`);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error("condition did not become true before timeout");
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function countOccurrences(value, needle) {
  return String(value || "").split(needle).length - 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
