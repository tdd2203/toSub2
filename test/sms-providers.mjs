import assert from "node:assert/strict";

import { createSmsProvider, publicSmsProviderDefinitions } from "../src/sms-providers.mjs";
import { createSmsBowerClient, SmsBowerError } from "../src/smsbower.mjs";
import { createViOtpClient, ViOtpError } from "../src/viotp-sms.mjs";
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

// ---- ViOTP client tests ----
assert.equal(createViOtpClient({ apiKey: "" }), null, "empty apiKey returns null");
assert.equal(createViOtpClient({}), null, "missing apiKey returns null");

const viOtpRequests = [];
let viOtpSmsChecks = 0;
const viOtpFetch = async (url) => {
  const u = new URL(url);
  viOtpRequests.push(u);
  const path = u.pathname;
  if (path === "/users/balance") {
    return new Response(JSON.stringify({ status_code: 200, success: true, data: { balance: 50000 } }));
  }
  if (path === "/service/getv2") {
    const country = u.searchParams.get("country");
    const services = country === "la"
      ? [{ id: 10, name: "Telegram", price: 1200 }]
      : [{ id: 1, name: "Facebook", price: 800 }, { id: 2, name: "Shopee", price: 600 }];
    return new Response(JSON.stringify({ status_code: 200, success: true, data: services }));
  }
  if (path === "/networks/get") {
    return new Response(JSON.stringify({ status_code: 200, success: true, data: [
      { id: 1, name: "MOBIFONE" }, { id: 2, name: "VINAPHONE" },
    ] }));
  }
  if (path === "/request/getv2") {
    return new Response(JSON.stringify({ status_code: 200, success: true, data: {
      phone_number: "987654321", request_id: "122314",
      re_phone_number: "84987654321", countryCode: "84", countryISO: "VN", balance: 49200,
    } }));
  }
  if (path === "/session/getv2") {
    viOtpSmsChecks += 1;
    if (viOtpSmsChecks === 1) {
      return new Response(JSON.stringify({ status_code: 200, success: true, data: { Status: 0 } }));
    }
    return new Response(JSON.stringify({ status_code: 200, success: true, data: {
      Status: 1, Code: "486460",
      SmsContent: "486460 la ma xac thuc OTP dang ky vi MoMo.",
    } }));
  }
  return new Response(JSON.stringify({ status_code: -1, success: false, message: "Unknown" }));
};

const viOtpClient = createViOtpClient({ apiKey: "test-viotp-key", fetchImpl: viOtpFetch });
assert.ok(viOtpClient, "client is created");

assert.equal(await viOtpClient.getBalance(), 50000);
assert.equal(viOtpRequests.at(-1).pathname, "/users/balance");
assert.equal(viOtpRequests.at(-1).searchParams.get("token"), "test-viotp-key");

const viOtpServices = await viOtpClient.listServices("vn");
assert.equal(viOtpServices.length, 2);
assert.equal(viOtpServices[0].name, "Facebook");
assert.equal(viOtpServices[0].price, 800);
assert.equal(viOtpRequests.at(-1).searchParams.get("country"), "vn");

const viOtpLaosServices = await viOtpClient.listServices("la");
assert.equal(viOtpLaosServices.length, 1);
assert.equal(viOtpLaosServices[0].name, "Telegram");

const viOtpNetworks = await viOtpClient.listNetworks();
assert.equal(viOtpNetworks.length, 2);
assert.equal(viOtpNetworks[0].name, "MOBIFONE");
assert.equal(viOtpRequests.at(-1).pathname, "/networks/get");

const viOtpOrder = await viOtpClient.getNumber("1", { country: "vn" });
assert.equal(viOtpOrder.requestId, "122314");
assert.equal(viOtpOrder.number, "+84987654321");
assert.equal(viOtpOrder.rePhone, "84987654321");
assert.equal(viOtpOrder.balance, 49200);
assert.equal(viOtpRequests.at(-1).pathname, "/request/getv2");
assert.equal(viOtpRequests.at(-1).searchParams.get("serviceId"), "1");
assert.equal(viOtpRequests.at(-1).searchParams.get("country"), "vn");

assert.deepEqual(await viOtpClient.getSms("122314"), { status: "waiting" });
assert.equal(viOtpRequests.at(-1).searchParams.get("requestId"), "122314");
assert.deepEqual(await viOtpClient.getSms("122314"), { status: "received", code: "486460" });

assert.equal(await viOtpClient.release("122314"), true);

const viOtpOptions = await viOtpClient.listServiceOptions("vn");
assert.equal(viOtpOptions.balance, 50000);
assert.equal(viOtpOptions.services.length, 2);
assert.equal(viOtpOptions.services[0].value, "1");
assert.equal(viOtpOptions.services[0].label, "Facebook");
assert.ok(viOtpOptions.services[0].priceLabel.includes("800"));

// extractViOtpCode: Code field with 4-digit code
let viOtp4digitChecks = 0;
const viOtp4digitFetch = async (url) => {
  const path = new URL(url).pathname;
  if (path === "/session/getv2") {
    return new Response(JSON.stringify({ status_code: 200, success: true, data: {
      Status: 1, Code: "1234", SmsContent: "Ma xac thuc cua ban la 1234.",
    } }));
  }
  return new Response(JSON.stringify({ status_code: 200, success: true, data: {} }));
};
const viOtp4digit = createViOtpClient({ apiKey: "test-key", fetchImpl: viOtp4digitFetch });
assert.deepEqual(await viOtp4digit.getSms("req-1"), { status: "received", code: "1234" });

// extractViOtpCode: SMS content fallback with 5-digit code (no Code field)
const viOtp5digitFetch = async (url) => {
  if (new URL(url).pathname === "/session/getv2") {
    return new Response(JSON.stringify({ status_code: 200, success: true, data: {
      Status: 1, Code: "", SmsContent: "Your code is 54321 for verification.",
    } }));
  }
  return new Response(JSON.stringify({ status_code: 200, success: true, data: {} }));
};
const viOtp5digit = createViOtpClient({ apiKey: "test-key", fetchImpl: viOtp5digitFetch });
assert.deepEqual(await viOtp5digit.getSms("req-2"), { status: "received", code: "54321" });

// expired session
const viOtpExpiredFetch = async (url) => {
  if (new URL(url).pathname === "/session/getv2") {
    return new Response(JSON.stringify({ status_code: 200, success: true, data: { Status: 2 } }));
  }
  return new Response(JSON.stringify({ status_code: 200, success: true, data: {} }));
};
const viOtpExpired = createViOtpClient({ apiKey: "test-key", fetchImpl: viOtpExpiredFetch });
assert.deepEqual(await viOtpExpired.getSms("req-3"), { status: "expired" });

// API error (401)
const viOtpBadKeyFetch = async () =>
  new Response(JSON.stringify({ status_code: 401, success: false, message: "Token không hợp lệ" }));
const viOtpBadKey = createViOtpClient({ apiKey: "bad-key-1", fetchImpl: viOtpBadKeyFetch });
await assert.rejects(() => viOtpBadKey.getBalance(), (e) => e instanceof ViOtpError && e.terminal);

// HTTP error
const viOtpHttp500Fetch = async () => new Response("", { status: 500 });
const viOtp500 = createViOtpClient({ apiKey: "test-key", fetchImpl: viOtpHttp500Fetch });
await assert.rejects(() => viOtp500.getBalance(), (e) => e instanceof ViOtpError && /500/.test(e.message));

// createSmsProvider("viotp") integration
const viOtpProvider = createSmsProvider("viotp", {
  apiKey: "test-viotp-key", serviceId: "1", country: "vn", serviceLabel: "Facebook",
}, { fetchImpl: viOtpFetch });
assert.equal(viOtpProvider.name, "ViOTP");
assert.equal(viOtpProvider.serviceLabel, "Facebook");

// createSmsProvider("viotp") without serviceId — must succeed for options queries
const viOtpOptionsProvider = createSmsProvider("viotp", {
  apiKey: "test-viotp-key", country: "vn",
}, { fetchImpl: viOtpFetch });
assert.ok(viOtpOptionsProvider.listNumberOptions, "options query provider created");
const viOtpProviderOptions = await viOtpOptionsProvider.listNumberOptions();
assert.ok(viOtpProviderOptions.services.length > 0, "options returned services");
assert.throws(() => viOtpOptionsProvider.getNumber(), /请选择 ViOTP 服务/);

// ---- SMSCode client tests ----
import { createSmsCodeClient, SmsCodeError } from "../src/smscode-sms.mjs";

assert.equal(createSmsCodeClient({ apiKey: "" }), null, "empty apiKey returns null");
assert.equal(createSmsCodeClient({}), null, "missing apiKey returns null");

// The mock mirrors the documented /v2 behaviour: products are filtered server-side, a listing
// without operator_id only returns the "any operator" tiers, and max_price is floored to IDR.
const smsCodeFx = { pair: "USD/IDR", rate: 17903, rate_as_of: "2026-10-01T18:46:24+00:00" };
const smsCodeMoney = (idr) => ({
  amount: (idr / smsCodeFx.rate).toFixed(4), currency: "USD", canonical_amount: idr, canonical_currency: "IDR",
});
const smsCodeServices = [
  { id: 1, code: "whatsapp", name: "WhatsApp", active: true },
  { id: 20, code: "openai", name: "OpenAI (ChatGPT)", active: true },
  { id: 99, code: "retired", name: "Retired", active: false },
];
const smsCodeCountries = [
  { id: 13, code: "US", name: "USA (virtual)", dial_code: "+1", emoji: "🇺🇸", active: true },
  { id: 11, code: "VN", name: "Vietnam", dial_code: "+84", emoji: "🇻🇳", active: true },
  { id: 7, code: "ID", name: "Indonesia", dial_code: "+62", emoji: "🇮🇩", active: true },
];
const smsCodeProductRows = [
  // id, platform_id, country_id, catalog_product_id, operator_id, operator_name, price (IDR), available
  [632518539, 20, 13, 13310, null, null, 79, 142699],
  [632518540, 20, 13, 13310, null, null, 217, 200],
  [632518447, 20, 11, 1046, null, null, 1064, 1],
  [801987988, 20, 11, 1046, null, null, 1261, 3],
  [1369525820, 20, 11, 1046, null, null, 2156, 1068],
  [1369692049, 20, 11, 1046, null, null, 2364, 99374],
  [1369494384, 20, 11, 1046, 13, "VinaPhone", 2156, 9],
  [1369099244, 20, 11, 1046, 13, "VinaPhone", 4790, 219],
  [1369051598, 20, 11, 1046, 13, "VinaPhone", 5747, 219],
  [1369120745, 20, 11, 1046, 10, "MobiFone", 2156, 1],
  [142, 1, 7, 469, null, null, 15000, 42],
].map(([id, platform_id, country_id, catalog_product_id, operator_id, operator_name, idr, available]) => ({
  id, name: `product ${id} ($0.0040)`, country_id, platform_id, catalog_product_id, operator_id, operator_name,
  available, price: smsCodeMoney(idr), active: true,
}));
const smsCodeOperators = {
  "11:20": [
    { operator_id: null, code: "any", name: "Any", local_name: null },
    { operator_id: 10, code: "mobifone", name: "MobiFone", local_name: "MobiFone" },
    { operator_id: 13, code: "vinaphone", name: "VinaPhone", local_name: "VinaPhone" },
  ],
};
const SMSCODE_MOCK_PAGE_LIMIT = 4;

const smsCodeRequests = [];
const smsCodeJson = (body, status = 200) => new Response(JSON.stringify(body), { status });
const smsCodeFailure = (status, code, message, details) => smsCodeJson({
  success: false, error: { code, message, ...(details ? { details } : {}) },
}, status);
let smsCodeOrderSms = { status: "ACTIVE", otp_code: null, otp_message: null, sms_revision: 0 };
let smsCodeResendFails = false;
let smsCodeCancelCalls = 0;
let smsCodeTooEarlyRejected = false;
let smsCodeNextCreateError = null;
const smsCodeFetch = async (url, init) => {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  smsCodeRequests.push({ url: u, method: init?.method || "GET", body, authorization: init?.headers?.authorization });
  const path = u.pathname;
  const query = (name) => (u.searchParams.has(name) ? Number(u.searchParams.get(name)) : null);
  if (path === "/v2/balance") {
    return smsCodeJson({ success: true, data: { balance: smsCodeMoney(88798) }, meta: { fx: smsCodeFx } });
  }
  if (path === "/v2/catalog/services") return smsCodeJson({ success: true, data: smsCodeServices });
  if (path === "/v2/catalog/countries") return smsCodeJson({ success: true, data: smsCodeCountries });
  if (path === "/v2/catalog/exchange-rate") return smsCodeJson({ success: true, data: smsCodeFx });
  if (path === "/v2/catalog/operators") {
    if (query("country_id") == null) {
      return new Response("Failed to deserialize query string: missing field `country_id`", { status: 400 });
    }
    return smsCodeJson({ success: true, data: smsCodeOperators[`${query("country_id")}:${query("platform_id")}`] || [] });
  }
  if (path === "/v2/catalog/products") {
    const rows = smsCodeProductRows
      .filter((p) => query("platform_id") == null || p.platform_id === query("platform_id"))
      .filter((p) => query("country_id") == null || p.country_id === query("country_id"))
      .filter((p) => p.operator_id === query("operator_id"))
      .sort((a, b) => a.price.canonical_amount - b.price.canonical_amount);
    const limit = Math.min(query("limit") || 1000, SMSCODE_MOCK_PAGE_LIMIT);
    const page = query("page") || 1;
    const data = rows.slice((page - 1) * limit, page * limit);
    return smsCodeJson({ success: true, data, meta: { page, limit, count: data.length, fx: smsCodeFx } });
  }
  if (path === "/v2/orders/create") {
    if (smsCodeNextCreateError) {
      const error = smsCodeNextCreateError;
      smsCodeNextCreateError = null;
      return error;
    }
    const capIdr = body.max_price == null ? Infinity : Math.floor(Number(body.max_price) * smsCodeFx.rate);
    const offer = smsCodeProductRows
      .filter((p) => p.catalog_product_id === body.catalog_product_id && p.operator_id === (body.operator_id ?? null))
      .filter((p) => p.price.canonical_amount <= capIdr)
      .sort((a, b) => a.price.canonical_amount - b.price.canonical_amount)[0];
    if (!offer) {
      return smsCodeFailure(422, "NO_OFFER_AVAILABLE", "No offer matches the requested product and policy", {
        catalog_product_id: body.catalog_product_id, policy: "cheapest", candidates_considered: 0,
        operator_id: body.operator_id ?? null, min_price_idr: null, max_price_idr: capIdr,
      });
    }
    return smsCodeJson({
      success: true,
      data: {
        orders: [{
          id: 1002, status: "ACTIVE", product_id: offer.id, catalog_product_id: offer.catalog_product_id,
          amount: offer.price, phone_number: "+84912345678", otp_code: null, otp_received_at: null,
          expires_at: "2026-10-01T19:03:12+00:00", failed_reason: null,
          operator_id: offer.operator_id, operator_name: offer.operator_name,
          can_finish: false, can_resend: false, can_cancel: false, can_replace: false, can_reactivate: false,
          resend_available_at: null,
          cancel_available_at: new Date(Date.now() + 120_000).toISOString(),
          replace_available_at: new Date(Date.now() + 120_000).toISOString(),
        }],
        failed_count: 0,
      },
      meta: { fx: smsCodeFx },
    });
  }
  if (path === "/v2/orders/active") {
    // Like the real endpoint, an order only ever shows its latest SMS together with a rising sms_revision.
    return smsCodeJson({
      success: true,
      data: [{ id: 1002, ...smsCodeOrderSms, expires_at: "2026-10-01T19:03:12+00:00", failed_reason: null }],
    });
  }
  if (path === "/v2/orders/resend") {
    if (smsCodeResendFails) return smsCodeFailure(409, "CONFLICT", "Resend is cooling down");
    return smsCodeJson({ success: true, data: { order_id: body.id, status: "ACTIVE", resent: true } });
  }
  if (path === "/v2/orders/7777") {
    return smsCodeJson({
      success: true,
      data: { id: 7777, status: "EXPIRED", otp_code: null, otp_message: null, amount: smsCodeMoney(4790) },
      meta: { fx: smsCodeFx },
    });
  }
  if (path === "/v2/orders/finish") return smsCodeJson({ success: true, data: { order_id: body.id, status: "COMPLETED" } });
  if (path === "/v2/orders/cancel") {
    smsCodeCancelCalls += 1;
    if (body.id === 5555 && !smsCodeTooEarlyRejected) {
      smsCodeTooEarlyRejected = true;
      return smsCodeFailure(409, "CANCEL_TOO_EARLY", "Order too recent to cancel");
    }
    if (body.id === 6666) return smsCodeFailure(409, "CONFLICT", "Order is not cancelable");
    return smsCodeJson({
      success: true,
      data: { order_id: body.id, status: "CANCELED", refund_amount: smsCodeMoney(2156), new_balance: smsCodeMoney(88798) },
      meta: { fx: smsCodeFx },
    });
  }
  return smsCodeFailure(404, "NOT_FOUND", "Resource not found");
};
const smsCodeLastRequest = (path) => [...smsCodeRequests].reverse().find((r) => r.url.pathname === path);

const smsCodeDeferred = [];
const smsCodeClient = createSmsCodeClient({
  apiKey: "test-smscode-key",
  fetchImpl: smsCodeFetch,
  deferImpl: (callback, delayMs) => smsCodeDeferred.push({ callback, delayMs }),
});
assert.ok(smsCodeClient, "client is created");

const smsCodeBalance = await smsCodeClient.getBalance();
assert.equal(smsCodeBalance.amount, "4.9600");
assert.equal(smsCodeRequests.at(-1).url.href, "https://api.smscode.gg/v2/balance", "uses the v2 API surface");
assert.equal(smsCodeRequests.at(-1).authorization, "Bearer test-smscode-key");

// Products are filtered by the API (an unfiltered listing is just the cheapest rows of every platform)
// and every page is followed.
smsCodeRequests.length = 0;
const smsCodeAnyTiers = await smsCodeClient.listProducts({ platformId: 20 });
assert.equal(smsCodeAnyTiers.length, 6, "all any-operator tiers of the platform across pages");
assert.ok(smsCodeAnyTiers.every((p) => p.platform_id === 20 && p.operator_id === null));
assert.deepEqual(
  smsCodeRequests.map((r) => `${r.url.searchParams.get("platform_id")}/${r.url.searchParams.get("limit")}/${r.url.searchParams.get("page")}`),
  ["20/10000/1", "20/10000/2"],
);
const smsCodeVinaTiers = await smsCodeClient.listProducts({ platformId: 20, countryId: 11, operatorId: 13 });
assert.deepEqual(smsCodeVinaTiers.map((p) => p.price.canonical_amount), [2156, 4790, 5747]);
assert.equal(smsCodeLastRequest("/v2/catalog/products").url.searchParams.get("operator_id"), "13");

// First query: nothing selected → ChatGPT is the default platform and its countries are listed.
const smsCodeOptions = await smsCodeClient.listServiceOptions();
assert.equal(smsCodeOptions.balance, "$4.9600");
assert.deepEqual(smsCodeOptions.platforms, [
  { value: "20", label: "OpenAI (ChatGPT)" },
  { value: "1", label: "WhatsApp" },
], "inactive services are hidden");
assert.equal(smsCodeOptions.platformId, "20");
assert.equal(smsCodeOptions.platformLabel, "OpenAI (ChatGPT)");
assert.deepEqual(smsCodeOptions.countries, [
  { value: "13", label: "USA (virtual)", emoji: "🇺🇸", code: "US", dialCode: "+1", priceLabel: "$0.0044", catalogProductId: "13310" },
  { value: "11", label: "Vietnam", emoji: "🇻🇳", code: "VN", dialCode: "+84", priceLabel: "$0.0594", catalogProductId: "1046" },
], "only countries with stock for the platform");
assert.equal(smsCodeOptions.countryId, "");
assert.deepEqual(smsCodeOptions.operators, []);

// Country selected → operators of that country, each with its own price tiers.
const smsCodeVietnam = await smsCodeClient.listServiceOptions({ platformId: "20", countryId: "11" });
assert.equal(smsCodeVietnam.countryId, "11");
assert.equal(smsCodeVietnam.countryLabel, "Vietnam");
assert.equal(smsCodeVietnam.catalogProductId, "1046");
assert.deepEqual(smsCodeVietnam.operators.map((o) => [o.value, o.label, o.defaultTier]), [
  ["", "不限运营商", "2156"],
  ["10", "MobiFone", "2156"],
  ["13", "VinaPhone", "4790"],
], "default cap skips tiers that only have a few numbers");
assert.deepEqual(smsCodeVietnam.operators[0].tiers.map((tier) => tier.value), ["1064", "1261", "2156", "2364"]);
assert.deepEqual(smsCodeVietnam.operators[2].tiers, [
  { value: "2156", price: "0.1204", priceLabel: "$0.1204", available: 9 },
  { value: "4790", price: "0.2676", priceLabel: "$0.2676", available: 219 },
  { value: "5747", price: "0.3210", priceLabel: "$0.3210", available: 219 },
]);

// A country without named operators only offers the any-operator tiers.
const smsCodeUsa = await smsCodeClient.listServiceOptions({ platformId: "20", countryId: "13" });
assert.deepEqual(smsCodeUsa.operators.map((o) => [o.value, o.defaultTier, o.tiers.length]), [["", "79", 2]]);

// A country that has no stock for the platform is dropped instead of being kept as a stale selection.
const smsCodeStaleCountry = await smsCodeClient.listServiceOptions({ platformId: "20", countryId: "7" });
assert.equal(smsCodeStaleCountry.countryId, "");
assert.deepEqual(smsCodeStaleCountry.operators, []);
assert.equal(smsCodeStaleCountry.countries.length, 2);

const smsCodeWhatsApp = await smsCodeClient.listServiceOptions({ platformId: "1" });
assert.equal(smsCodeWhatsApp.platformId, "1");
assert.deepEqual(smsCodeWhatsApp.countries.map((c) => c.label), ["Indonesia"]);
const smsCodeUnknownPlatform = await smsCodeClient.listServiceOptions({ platformId: "99" });
assert.equal(smsCodeUnknownPlatform.platformId, "20", "inactive or unknown platform falls back to ChatGPT");
assert.equal(smsCodeUnknownPlatform.countries.length, 2);

// Orders: the shown USD price is rounded ($0.1204 is really 2156 IDR = $0.12043) and the API floors
// max_price back to IDR, so the cap is derived from the IDR price instead of echoing the shown amount.
const smsCodeProvider = createSmsProvider("smscode", {
  apiKey: "test-smscode-key", catalogProductId: "1046", operatorId: "13", maxPriceIdr: "2156", maxPrice: "0.1204",
  serviceLabel: "OpenAI (ChatGPT) · Vietnam · VinaPhone · $0.1204",
}, { fetchImpl: smsCodeFetch });
assert.equal(smsCodeProvider.name, "SMSCode");
assert.equal(smsCodeProvider.serviceLabel, "OpenAI (ChatGPT) · Vietnam · VinaPhone · $0.1204");
assert.deepEqual(await smsCodeProvider.getNumber(), {
  requestId: "1002", number: "+84912345678", expiresAt: "2026-10-01T19:03:12+00:00", price: 0.1204,
});
assert.deepEqual(smsCodeLastRequest("/v2/orders/create").body, {
  catalog_product_id: 1046, quantity: 1, operator_id: 13, max_price: "0.1205",
});

// Any operator: no operator_id is sent and the cheapest tier within the cap is bought.
const smsCodeAnyProvider = createSmsProvider("smscode", {
  apiKey: "test-smscode-key", catalogProductId: "1046", maxPriceIdr: "2156",
}, { fetchImpl: smsCodeFetch });
assert.equal((await smsCodeAnyProvider.getNumber()).price, 0.0594);
assert.deepEqual(smsCodeLastRequest("/v2/orders/create").body, { catalog_product_id: 1046, quantity: 1, max_price: "0.1205" });

// A configuration saved before the IDR cap existed only has the rounded USD price: pad it by one tick.
const smsCodeLegacyProvider = createSmsProvider("smscode", {
  apiKey: "test-smscode-key", catalogProductId: "13310", maxPrice: "0.0044",
}, { fetchImpl: smsCodeFetch });
assert.equal((await smsCodeLegacyProvider.getNumber()).price, 0.0044);
assert.equal(smsCodeLastRequest("/v2/orders/create").body.max_price, "0.0045");

// Nothing within the cap → a retryable "no number" error, not a terminal one.
await assert.rejects(
  () => smsCodeClient.createOrder(1046, { operatorId: 13, maxPriceIdr: 1 }),
  (e) => e instanceof SmsCodeError && e.code === "NO_OFFER_AVAILABLE" && !e.terminal && /最高价格内暂无可用号码/.test(e.message),
);
assert.equal(smsCodeLastRequest("/v2/orders/create").body.max_price, "0.0001");
smsCodeNextCreateError = smsCodeFailure(422, "PROVIDER_ERROR", "Provider rejected the order", {
  attempts: [{ provider: "a", outcome: "no_numbers" }, { provider: "b", outcome: "price_rejected" }],
});
await assert.rejects(
  () => smsCodeClient.createOrder(1046, { maxPriceIdr: 2156 }),
  (e) => e.code === "PROVIDER_ERROR" && e.message === "上游接码供应商拒绝了请求：上游暂无号码、价格被上游拒绝",
);

// Incomplete configurations never reach the API.
const smsCodeUnconfigured = createSmsProvider("smscode", { apiKey: "test-smscode-key" }, { fetchImpl: smsCodeFetch });
assert.throws(() => smsCodeUnconfigured.getNumber(), /请先查询并选择 SMSCode 国家/);
assert.throws(
  () => createSmsProvider("smscode", { apiKey: "test-smscode-key", catalogProductId: "1046" }, { fetchImpl: smsCodeFetch }).getNumber(),
  /最高价格/,
  "an order without a price cap is refused",
);
assert.throws(
  () => createSmsProvider("smscode", {
    apiKey: "test-smscode-key", catalogProductId: "1046", operatorId: "vina", maxPriceIdr: "2156",
  }, { fetchImpl: smsCodeFetch }).getNumber(),
  /运营商/,
);
const smsCodeProviderOptions = await createSmsProvider("smscode", {
  apiKey: "test-smscode-key", platformId: "20", countryId: "11",
}, { fetchImpl: smsCodeFetch }).listNumberOptions();
assert.equal(smsCodeProviderOptions.operators.length, 3, "the provider forwards the selected platform and country");

// SMS polling. Real SIMs also get carrier notices, which must not be read as a code.
const smsCodeSms = (sms_revision, otp_code, otp_message) => ({ status: "OTP_RECEIVED", otp_code, otp_message, sms_revision });
assert.deepEqual(await smsCodeProvider.getSms("1002"), { status: "waiting" });
smsCodeOrderSms = smsCodeSms(1, null, "TB: Quy khach duoc tang 20000d, han dung 30 ngay. LH 9191");
assert.deepEqual(await smsCodeProvider.getSms("1002"), { status: "waiting" }, "a notice without a 6-digit code keeps waiting");
smsCodeOrderSms = smsCodeSms(2, "589206", "Mã xác thực OpenAI của bạn là: 589206");
assert.equal(await smsCodeProvider.markReady("1002"), false, "nothing was used yet, so no resend is requested");
assert.equal(smsCodeLastRequest("/v2/orders/resend"), undefined);
assert.deepEqual(await smsCodeProvider.getSms("1002"), { status: "received", code: "589206" });

// The order keeps showing the SMS that was just used: it must not be handed out a second time.
assert.deepEqual(await smsCodeProvider.getSms("1002"), { status: "waiting" });
// Resend: whatever arrived before the resend was asked is stale, even if it was never handed out.
smsCodeOrderSms = smsCodeSms(3, "111111", "Mã xác thực OpenAI của bạn là: 111111");
assert.equal(await smsCodeProvider.markReady("1002"), true);
assert.deepEqual(smsCodeLastRequest("/v2/orders/resend").body, { id: 1002 });
assert.deepEqual(await smsCodeProvider.getSms("1002"), { status: "waiting" }, "an SMS delivered before the resend is skipped");
smsCodeOrderSms = smsCodeSms(4, null, "Your ChatGPT code is 968671");
assert.deepEqual(
  await smsCodeProvider.getSms("1002"),
  { status: "received", code: "968671" },
  "an unclassified text still yields its standalone 6-digit code",
);
smsCodeResendFails = true;
assert.equal(await smsCodeProvider.markReady("1002"), false, "a refused resend does not break polling");
assert.deepEqual(await smsCodeProvider.getSms("1002"), { status: "waiting" });
await assert.rejects(
  () => smsCodeProvider.getSms("7777"),
  (e) => e instanceof SmsCodeError && e.terminal && e.code === "EXPIRED",
  "an order that ended without a code stops the polling",
);
assert.equal(await smsCodeProvider.complete("1002"), true);
assert.deepEqual(smsCodeLastRequest("/v2/orders/finish").body, { id: 1002 });

// Release: SMSCode refuses to cancel during the first 2 minutes, so the cancel is postponed instead of dropped.
await smsCodeClient.createOrder(1046, { maxPriceIdr: 2156 });
smsCodeCancelCalls = 0;
assert.equal(await smsCodeClient.releaseOrder("1002"), false, "inside the cancel window nothing is sent yet");
assert.equal(smsCodeCancelCalls, 0);
assert.equal(smsCodeDeferred.length, 1);
assert.ok(smsCodeDeferred[0].delayMs > 100_000 && smsCodeDeferred[0].delayMs <= 122_000);
smsCodeDeferred.shift().callback();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(smsCodeLastRequest("/v2/orders/cancel").body, { id: 1002 });
assert.equal(await smsCodeClient.releaseOrder("1002"), true, "once canceled the window no longer applies");
assert.equal(await smsCodeClient.releaseOrder("5555"), false, "CANCEL_TOO_EARLY schedules a retry");
assert.equal(smsCodeDeferred.shift().delayMs, 125_000);
assert.equal(await smsCodeClient.releaseOrder("6666"), true, "an order that can no longer be canceled needs no release");

// API error handling
const smsCodeBadKey = createSmsCodeClient({
  apiKey: "bad-key-1",
  fetchImpl: async () => smsCodeFailure(401, "UNAUTHORIZED", "Authentication required"),
});
await assert.rejects(() => smsCodeBadKey.getBalance(), (e) => e instanceof SmsCodeError && e.terminal);
await assert.rejects(
  () => smsCodeClient.listOperators(null, 20),
  (e) => e instanceof SmsCodeError && e.message === "接码平台返回了无效数据：HTTP 400",
  "plain-text error bodies are reported instead of crashing the JSON parser",
);

const definitions = publicSmsProviderDefinitions();
assert.deepEqual(definitions.map((provider) => provider.id), ["luban", "smsbower", "viotp", "smscode", "custom"]);
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
