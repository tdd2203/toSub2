import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-console-cooldown-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
// A fixed IP may launch MAX_PER_WINDOW brand-new registrations per rolling WINDOW_MS; the next one waits.
const WINDOW_MS = 4_000;
const MAX_PER_WINDOW = 2;
const PROXY_SETTING_KEY = "chatgpt-onboarding.proxy-link-config-v1";

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
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs"),
    PROXY_SIGNUP_WINDOW_MS: String(WINDOW_MS),
    PROXY_SIGNUP_MAX_PER_WINDOW: String(MAX_PER_WINDOW),
    // The throttle keys by real exit IP; this seam maps each test proxy host to a
    // deterministic exit IP so launches don't probe the (fake) proxies over the network.
    PROXY_EXIT_IP_TEST_MAP: JSON.stringify({
      "10.9.8.7": "77.77.77.7",
      "10.9.8.8": "88.88.88.8",
      "10.9.8.9": "99.99.99.9",
    }),
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
  const createJob = async (email, proxyUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs`, { method: "POST", headers, body: JSON.stringify({ email, proxyUrl }) });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).job.id;
  };
  const sharedIp = "socks5h://user:password@10.9.8.7:1080";

  // The first two accounts on an IP start at once — the per-minute window allows two.
  const windowStartedAt = Date.now();
  const first = await createJob("window-first@example.com", sharedIp);
  const second = await createJob("window-second@example.com", sharedIp);
  // A third account on the same IP waits in the queue and says until when.
  const third = await createJob("window-third@example.com", sharedIp);
  const held = await waitForJob(headers, third, (job) => job.status === "queued" && /同一代理 IP/.test(job.prompt));
  assert.match(held.prompt, /^同一代理 IP 刚注册过其他账号，等到 \d{2}:\d{2}:\d{2} 再开始$/);
  await waitForJob(headers, first, (job) => job.status === "completed");
  await waitForJob(headers, second, (job) => job.status === "completed");

  // The held job takes no slot: other IPs, and rotating proxies on the same host, are not delayed.
  const otherIp = await createJob("window-other-ip@example.com", "socks5h://user:password@10.9.8.8:1080");
  const rotating = await createJob("window-rotating@example.com", "socks5h://user-sid-abc-t-20:password@10.9.8.7:6000");
  await waitForJob(headers, otherIp, (job) => job.status === "completed", 2_000);
  await waitForJob(headers, rotating, (job) => job.status === "completed", 2_000);
  assert.equal((await getJob(headers, third)).status, "queued", "still waiting for the window while other IPs run");

  // It starts by itself once an earlier start has aged out of the window.
  await waitForJob(headers, third, (job) => job.status === "completed");
  const waited = Date.now() - windowStartedAt;
  assert.ok(waited >= WINDOW_MS, `third registration started after ${waited} ms, before the ${WINDOW_MS} ms window cleared`);

  // The limit set in the proxy dialog replaces the default, and 0 removes the throttle so a waiting job runs.
  const ownIp = "socks5h://user:password@10.9.8.9:1080";
  const fillA = await createJob("window-fill-a@example.com", ownIp);
  const fillB = await createJob("window-fill-b@example.com", ownIp);
  const blocked = await createJob("window-blocked@example.com", ownIp);
  await waitForJob(headers, blocked, (job) => job.status === "queued" && /同一代理 IP/.test(job.prompt));
  await waitForJob(headers, fillA, (job) => job.status === "completed");
  await waitForJob(headers, fillB, (job) => job.status === "completed");
  const saved = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ settings: { [PROXY_SETTING_KEY]: JSON.stringify({ mode: "batch", proxies: "", limitPerIp: 15, maxPerMinute: "0" }) } }),
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  await waitForJob(headers, blocked, (job) => job.status === "completed", 2_000);

  console.log("console proxy cooldown tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${consoleLogs}`;
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
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

async function getJob(headers, jobId) {
  const page = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  return page.jobs.find((item) => item.id === jobId);
}

async function waitForJob(headers, jobId, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getJob(headers, jobId);
    if (last && predicate(last)) return last;
    await delay(50);
  }
  throw new Error(`job ${jobId} did not reach the expected state: ${JSON.stringify(last && { status: last.status, prompt: last.prompt })}`);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
