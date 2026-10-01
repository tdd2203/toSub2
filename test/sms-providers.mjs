import assert from "node:assert/strict";

import { createSmsProvider, publicSmsProviderDefinitions } from "../src/sms-providers.mjs";
import { createSmsBowerClient, SmsBowerError } from "../src/smsbower.mjs";
import { createCustomSmsClient, parseCustomSmsEntries } from "../src/custom-sms.mjs";
import {
  extractMailboxOtpCandidates,
  fetchMailboxOtpCandidates,
  filterMailboxOtpCandidatesByRequestTime,
} from "../src/mail-otp.mjs";

const requests = [];
let smsChecks = 0;
const fetchImpl = async (url) => {
  const requestUrl = new URL(url);
  requests.push(requestUrl);
  const action = requestUrl.searchParams.get("action");
  let body;
  if (action === "getNumber") body = "ACCESS_NUMBER:activation-1:60123456789";
  else if (action === "getStatus") body = ++smsChecks === 1 ? "STATUS_WAIT_CODE" : "STATUS_OK:OpenAI code 654321";
  else if (action === "getPrices") body = JSON.stringify({
    12: { dr: { cost: 0.004, count: 366063 } },
    1001: { dr: { cost: 0.42, count: 12 } },
    7: { dr: { cost: 0.18, count: 8 } },
    0: { dr: { cost: 0.08, count: 0 } },
  });
  else if (action === "getCountries") body = JSON.stringify({ data: [
    { id: 12, rus: "США (виртуальные)", eng: "United States (virtual)", chn: "美国（虚拟号码）" },
    { id: 1001, rus: "Япония", eng: "Japan", chn: "日本" },
    { id: 7, rus: "Малайзия", eng: "Malaysia", chn: "马来西亚" },
    { id: 0, rus: "Unavailable", eng: "Unavailable", chn: "无库存" },
  ] });
  else if (action === "setStatus") {
    body = {
      "1": "ACCESS_READY",
      "6": "ACCESS_ACTIVATION",
      "8": "ACCESS_CANCEL",
    }[requestUrl.searchParams.get("status")];
  }
  return new Response(body || "BAD_ACTION", { status: 200 });
};

const client = createSmsBowerClient({ apiKey: "test-api-key", fetchImpl });
const order = await client.getNumber("dr", "1001", "0.42");
assert.deepEqual(order, { requestId: "activation-1", number: "+60123456789" });
assert.equal((await client.getSms(order.requestId)).status, "waiting");
assert.deepEqual(await client.getSms(order.requestId), { status: "received", code: "654321" });
assert.equal(await client.markReady(order.requestId), true);
assert.equal(await client.complete(order.requestId), true);
assert.equal(await client.release(order.requestId), true);
assert.equal(requests[0].searchParams.get("api_key"), "test-api-key");
assert.equal(requests[0].searchParams.get("service"), "dr");
assert.equal(requests[0].searchParams.get("country"), "1001");
assert.equal(requests[0].searchParams.get("maxPrice"), "0.42");
assert.deepEqual(await client.getPriceOptions("dr"), [
  { country: "12", title: "美国（虚拟号码）", iso: "", prefix: "", price: 0.004, count: 366063 },
  { country: "7", title: "马来西亚", iso: "", prefix: "", price: 0.18, count: 8 },
  { country: "1001", title: "日本", iso: "", prefix: "", price: 0.42, count: 12 },
]);

const badClient = createSmsBowerClient({
  apiKey: "test-api-key",
  fetchImpl: async () => new Response("NO_NUMBERS", { status: 200 }),
});
await assert.rejects(() => badClient.getNumber("dr", "1001"), /暂无可用号码/);
await assert.rejects(
  () => createSmsBowerClient({
    apiKey: "test-api-key",
    fetchImpl: async () => new Response("STATUS_OK:order 123456789", { status: 200 }),
  }).getSms("activation-2"),
  (error) => error instanceof SmsBowerError && error.terminal && /没有找到独立的 6 位/.test(error.message),
);

const definitions = publicSmsProviderDefinitions();
assert.deepEqual(definitions.map((provider) => provider.id), ["luban", "smsbower", "viotp", "custom"]);
const provider = createSmsProvider("smsbower", {
  apiKey: "test-api-key",
  service: "dr",
  country: "1001",
  maxPrice: "0.42",
  countryLabel: "日本",
}, { fetchImpl });
assert.equal(provider.name, "SMSBower");
assert.equal(provider.serviceLabel, "日本");
assert.deepEqual(await provider.getNumber(), { requestId: "activation-1", number: "+60123456789" });
assert.equal((await provider.listNumberOptions())[0].country, "12");

// A configured quality tier (smsAgentId) must pin the buy to that provider/agent.
const lastGetNumber = () => [...requests].reverse().find((url) => url.searchParams.get("action") === "getNumber");
assert.equal(lastGetNumber().searchParams.get("providerIds"), null, "no agent selected → no providerIds");
const pinnedProvider = createSmsProvider("smsbower", {
  apiKey: "test-api-key",
  service: "dr",
  country: "1001",
  maxPrice: "0.42",
  smsAgentId: "2295",
}, { fetchImpl });
await pinnedProvider.getNumber();
assert.equal(lastGetNumber().searchParams.get("providerIds"), "2295", "selected agent → providerIds pinned");
// agentId "0" means the catalog had no agent for that tier → do not pin.
const zeroAgentProvider = createSmsProvider("smsbower", {
  apiKey: "test-api-key", service: "dr", country: "1001", maxPrice: "0.42", smsAgentId: "0",
}, { fetchImpl });
await zeroAgentProvider.getNumber();
assert.equal(lastGetNumber().searchParams.get("providerIds"), null, "agent 0 → no providerIds");
assert.throws(
  () => createSmsProvider("smsbower", { apiKey: "test-api-key", service: "dr", country: "1001", smsAgentId: "abc" }),
  /号码质量档位/,
);

// Fallback: pinned tier out of stock → retry any tier, capped at price × multiplier.
const fallbackRequests = [];
const fallbackFetch = async (url) => {
  const requestUrl = new URL(url);
  fallbackRequests.push(requestUrl);
  if (requestUrl.searchParams.get("action") !== "getNumber") return new Response("BAD_ACTION", { status: 200 });
  // The pinned attempt carries providerIds and must report no stock.
  if (requestUrl.searchParams.get("providerIds")) return new Response("NO_NUMBERS", { status: 200 });
  return new Response("ACCESS_NUMBER:activation-fb:60987654321", { status: 200 });
};
const fallbackProvider = createSmsProvider("smsbower", {
  apiKey: "test-api-key", service: "dr", country: "1001", maxPrice: "0.42", smsAgentId: "2295",
}, { fetchImpl: fallbackFetch, smsBowerFallbackMultiplier: 2 });
assert.deepEqual(await fallbackProvider.getNumber(), { requestId: "activation-fb", number: "+60987654321" });
const fbGetNumbers = fallbackRequests.filter((url) => url.searchParams.get("action") === "getNumber");
assert.equal(fbGetNumbers.length, 2, "one pinned attempt, then one fallback");
assert.equal(fbGetNumbers[0].searchParams.get("providerIds"), "2295");
assert.equal(fbGetNumbers[0].searchParams.get("maxPrice"), "0.42");
assert.equal(fbGetNumbers[1].searchParams.get("providerIds"), null, "fallback drops the tier lock");
assert.equal(fbGetNumbers[1].searchParams.get("maxPrice"), "0.84", "fallback cap = chosen price × 2");

// A non-stock error (e.g. bad key) must NOT trigger the fallback.
let pinnedCalls = 0;
const badKeyFetch = async (url) => {
  if (new URL(url).searchParams.get("action") === "getNumber") pinnedCalls += 1;
  return new Response("BAD_KEY", { status: 200 });
};
const badKeyProvider = createSmsProvider("smsbower", {
  apiKey: "test-api-key", service: "dr", country: "1001", maxPrice: "0.42", smsAgentId: "2295",
}, { fetchImpl: badKeyFetch });
await assert.rejects(() => badKeyProvider.getNumber(), /API Key/);
assert.equal(pinnedCalls, 1, "no fallback on non-stock errors");

assert.throws(() => createSmsProvider("smsbower", { apiKey: "short", service: "dr", country: "1001" }), /API Key/);
assert.deepEqual(parseCustomSmsEntries([
  "+8613711111111----https://sms.example/first",
  "+8613822222222----https://sms.example/second",
  "+8613711111111----https://sms.example/updated",
].join("\n")), [
  { phone: "+8613711111111", apiUrl: "https://sms.example/updated" },
  { phone: "+8613822222222", apiUrl: "https://sms.example/second" },
]);
assert.throws(() => parseCustomSmsEntries("8613711111111----https://sms.example/code"), /E\.164/);
assert.throws(() => parseCustomSmsEntries("+8613711111111----ftp://sms.example/code"), /HTTP 或 HTTPS/);

let customInboxChecks = 0;
const customFetch = async () => {
  customInboxChecks += 1;
  return new Response(JSON.stringify({ messages: customInboxChecks === 1
    ? [{ id: "old-message", text: "OpenAI code\n111111\n" }]
    : [
        { id: "new-message", text: "OpenAI code\n654321\n" },
        { id: "old-message", text: "OpenAI code\n111111\n" },
      ] }), { status: 200 });
};
const customClient = createCustomSmsClient({
  entries: [
    "+8613711111111----https://sms.example/first",
    "+8613822222222----https://sms.example/second",
  ].join("\n"),
  fetchImpl: customFetch,
  acquireEntry: (entries) => entries[1],
});
assert.equal(customClient.entryCount, 2);
const customOrder = await customClient.getNumber();
assert.equal(customOrder.number, "+8613822222222");
assert.deepEqual(await customClient.getSms(customOrder.requestId), { status: "received", code: "654321" });
assert.equal(await customClient.release(customOrder.requestId), true);

let customJsonChecks = 0;
const customJsonClient = createCustomSmsClient({
  entries: "+8613912345678----https://sms.example/json-code",
  fetchImpl: async () => {
    customJsonChecks += 1;
    return new Response(JSON.stringify({
      code: 1,
      msg: "ok",
      data: {
        code: "您的验证代码是：766448",
        code_time: customJsonChecks === 1 ? "2026-08-17 23:30:00" : "2026-08-17 23:37:03",
        expired_date: "2026-08-25 00:00:00",
      },
    }), { status: 200 });
  },
});
const customJsonOrder = await customJsonClient.getNumber();
assert.deepEqual(await customJsonClient.getSms(customJsonOrder.requestId), { status: "received", code: "766448" });

const mailboxCandidates = extractMailboxOtpCandidates(JSON.stringify({
  data: [
    {
      id: "8662a68c-8d5e-4b94-9508-e6c3f676715c",
      subject: "New sign-in to your OpenAI account",
      body_text: "New sign-in details for your OpenAI account.",
      received_at: "2026-08-21T07:03:20.48048Z",
    },
    {
      id: "233381cc-38cd-49c0-bac5-490580bb9125",
      subject: "Your temporary ChatGPT login code",
      body_text: "Enter this temporary verification code to continue: 866483",
      received_at: "2026-08-21T07:03:13.197752Z",
    },
    {
      id: "4b38e61d-7c5f-4988-8e9b-80a1f1ebb7b8",
      subject: "Your temporary OpenAI verification code",
      body_text: "Enter this temporary verification code to continue: 606195",
      received_at: "2026-08-20T23:56:22.341347Z",
    },
  ],
  page: 1,
  size: 20,
  total: 3,
}));
assert.deepEqual(mailboxCandidates.map(({ code }) => code), ["866483", "606195"]);
assert.ok(mailboxCandidates[0].receivedAt > mailboxCandidates[1].receivedAt);
assert.deepEqual(
  filterMailboxOtpCandidatesByRequestTime(mailboxCandidates, Date.parse("2026-08-21T07:03:00Z"))
    .map(({ code }) => code),
  ["866483"],
);
assert.deepEqual(
  filterMailboxOtpCandidatesByRequestTime(mailboxCandidates, Date.parse("2026-08-21T07:04:00Z")),
  [],
);

let mailboxRequestOptions;
const configuredMailboxCandidates = await fetchMailboxOtpCandidates("https://mail.example/messages", {
  request: {
    method: "POST",
    headers: {
      authorization: "Bearer test-mail-token",
      referer: "https://mail.example/private/inbox",
      "content-type": "application/json",
    },
    body: "mailbox_id%3Daccount-specific-id%26page%3D1",
  },
  fetchImpl: async (_url, options) => {
    mailboxRequestOptions = options;
    return new Response(JSON.stringify({ data: [{
      id: "new-message",
      body_text: "Your ChatGPT verification code is 752941",
      received_at: "2026-08-21T08:00:00Z",
    }] }), { status: 200 });
  },
});
assert.equal(mailboxRequestOptions.method, "POST");
assert.equal(mailboxRequestOptions.headers.get("authorization"), "Bearer test-mail-token");
assert.equal(mailboxRequestOptions.headers.get("referer"), "https://mail.example/private/inbox");
assert.equal(mailboxRequestOptions.headers.get("content-type"), "application/json");
assert.equal(
  mailboxRequestOptions.body,
  "mailbox_id%3Daccount-specific-id%26page%3D1",
);
assert.equal(configuredMailboxCandidates[0].code, "752941");

assert.throws(() => createSmsProvider("unknown", {}), /受支持/);

console.log("sms provider tests passed");
