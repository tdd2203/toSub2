const DEFAULT_API_BASE = "https://api.smscode.gg/v2";
const DEFAULT_TIMEOUT_MS = 15_000;
const PRODUCTS_PAGE_LIMIT = 10_000;
const MAX_PRODUCT_PAGES = 20;
const DEFAULT_PLATFORM_CODE = "openai";
// Tiers with only a handful of numbers run dry at once, so the default price cap skips them.
const DEFAULT_TIER_MIN_STOCK = 20;
// SMSCode rejects a cancel during the first 2 minutes of an order (CANCEL_TOO_EARLY).
const CANCEL_RETRY_DELAY_MS = 125_000;
const ANY_OPERATOR_LABEL = "不限运营商";

const ORDER_FAILURE_CAUSES = {
  no_numbers: "上游暂无号码",
  price_rejected: "价格被上游拒绝",
  provider_unavailable: "上游暂不可用",
  insufficient_balance: "账户余额不足",
  provider_account_balance: "上游账户余额不足",
  provider_error: "上游返回错误",
};

export class SmsCodeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SmsCodeError";
    this.code = options.code ?? null;
    this.terminal = Boolean(options.terminal);
  }
}

export function createSmsCodeClient(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const apiBase = new URL(options.apiBase || DEFAULT_API_BASE);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const defer = options.deferImpl || deferUnref;
  const cancelAvailableAt = new Map();
  // An order keeps showing its latest SMS, so remember per order which SMS revision was already used.
  const consumedSmsRevision = new Map();

  if (!apiKey) return null;
  if (!/^https?:$/.test(apiBase.protocol)) throw new Error("SMSCode API 地址必须使用 HTTP 或 HTTPS");
  const baseHref = apiBase.href.replace(/\/+$/, "");

  async function request(method, path, params = {}, body = null) {
    const url = new URL(baseHref + path);
    Object.entries(params).forEach(([key, value]) => {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init = {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        redirect: "error",
        signal: controller.signal,
      };
      if (body) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetchImpl(url, init);
      // Malformed queries are answered with a plain-text 400 instead of the JSON envelope.
      const data = parseJson(await response.text());
      if (!data || typeof data !== "object") {
        throw new SmsCodeError(`接码平台返回了无效数据：HTTP ${response.status}`);
      }
      if (!data.success) {
        const err = data.error || {};
        throw apiError(err.code, err.message, response.status, err.details);
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw new SmsCodeError("接码平台请求超时");
      if (error instanceof SmsCodeError) throw error;
      throw new SmsCodeError(`接码平台请求失败：${safeMessage(error?.message)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveMaxPrice(opts) {
    const idr = Number(opts.maxPriceIdr);
    if (Number.isInteger(idr) && idr > 0) {
      const { data } = await request("GET", "/catalog/exchange-rate");
      const rate = Number(data?.rate);
      if (rate > 0) return usdCapForIdr(idr, rate);
    }
    // Catalog USD prices are rounded, so a cap equal to the shown price can fall below the tier it came from.
    const usd = Number(opts.maxPrice);
    if (Number.isFinite(usd) && usd > 0) return (usd + 0.0001).toFixed(4);
    return "";
  }

  async function loadOrder(orderId) {
    const { data } = await request("GET", "/orders/active");
    const orders = Array.isArray(data) ? data : [];
    return orders.find((o) => String(o.id) === String(orderId)) || client.getOrder(orderId);
  }

  function deferCancel(orderId, delayMs) {
    defer(() => {
      client.cancelOrder(orderId).catch(() => {});
    }, delayMs);
  }

  const client = {
    async getBalance() {
      const { data } = await request("GET", "/balance");
      return data?.balance || null;
    },

    async listServices(countryId) {
      const { data } = await request("GET", "/catalog/services", { country_id: countryId });
      return Array.isArray(data) ? data : [];
    },

    async listCountries() {
      const { data } = await request("GET", "/catalog/countries");
      return Array.isArray(data) ? data : [];
    },

    async listOperators(countryId, platformId) {
      const { data } = await request("GET", "/catalog/operators", { country_id: countryId, platform_id: platformId });
      return Array.isArray(data) ? data : [];
    },

    // Without operatorId the API lists only the "any operator" tiers; operator tiers need the explicit filter.
    async listProducts(filters = {}) {
      const products = [];
      for (let page = 1; page <= MAX_PRODUCT_PAGES; page += 1) {
        const { data, meta } = await request("GET", "/catalog/products", {
          country_id: filters.countryId,
          platform_id: filters.platformId,
          operator_id: filters.operatorId,
          limit: PRODUCTS_PAGE_LIMIT,
          page,
        });
        const rows = Array.isArray(data) ? data : [];
        products.push(...rows);
        if (rows.length < (Number(meta?.limit) || PRODUCTS_PAGE_LIMIT)) break;
      }
      return products;
    },

    async createOrder(catalogProductId, opts = {}) {
      const body = { catalog_product_id: Number(catalogProductId), quantity: 1 };
      if (opts.operatorId) body.operator_id = Number(opts.operatorId);
      const maxPrice = await resolveMaxPrice(opts);
      if (maxPrice) body.max_price = maxPrice;
      const { data } = await request("POST", "/orders/create", {}, body);
      const order = data?.orders?.[0];
      if (!order?.id || !order?.phone_number) {
        throw new SmsCodeError("获取手机号失败：SMSCode 未返回号码", { terminal: false });
      }
      const orderId = String(order.id);
      const cancelAt = Date.parse(order.cancel_available_at || "");
      if (Number.isFinite(cancelAt)) cancelAvailableAt.set(orderId, cancelAt);
      let number;
      try {
        number = normalizePhoneNumber(order.phone_number);
      } catch (error) {
        client.releaseOrder(orderId).catch(() => {});
        throw error;
      }
      const price = Number(order.amount?.amount);
      return {
        requestId: orderId,
        number,
        expiresAt: order.expires_at || null,
        price: Number.isFinite(price) ? price : null,
      };
    },

    async getOrder(orderId) {
      const { data } = await request("GET", `/orders/${encodeURIComponent(orderId)}`);
      if (!data) throw new SmsCodeError("获取订单状态失败", { terminal: false });
      return data;
    },

    async pollActiveOrder(orderId) {
      const key = String(orderId);
      const state = orderSmsState(await loadOrder(key), consumedSmsRevision.get(key) || 0);
      if (state.status !== "received") return state;
      consumedSmsRevision.set(key, state.revision);
      return { status: "received", code: state.code };
    },

    // Runs before every polling session. Once a code of this order has been used, a new session means the
    // service was asked to send again: everything delivered so far is stale and only a later SMS counts.
    async requestNextSms(orderId) {
      const key = String(orderId);
      if (!consumedSmsRevision.has(key)) return false;
      try {
        const order = await loadOrder(key);
        consumedSmsRevision.set(key, Math.max(consumedSmsRevision.get(key), smsRevision(order)));
        const { data } = await request("POST", "/orders/resend", {}, { id: Number(key) });
        return Boolean(data?.resent);
      } catch {
        // The resend hint is optional: polling still only accepts an SMS newer than the consumed one.
        return false;
      }
    },

    async finishOrder(orderId) {
      await request("POST", "/orders/finish", {}, { id: Number(orderId) });
      cancelAvailableAt.delete(String(orderId));
      consumedSmsRevision.delete(String(orderId));
      return true;
    },

    async cancelOrder(orderId) {
      await request("POST", "/orders/cancel", {}, { id: Number(orderId) });
      cancelAvailableAt.delete(String(orderId));
      consumedSmsRevision.delete(String(orderId));
      return true;
    },

    // Cancels now, or schedules the cancel for when the minimum-cancel window has passed.
    async releaseOrder(orderId) {
      const key = String(orderId);
      const waitMs = (cancelAvailableAt.get(key) ?? 0) - Date.now();
      if (waitMs > 0) {
        deferCancel(key, waitMs + 2_000);
        return false;
      }
      try {
        return await client.cancelOrder(key);
      } catch (error) {
        if (error?.code === "CANCEL_TOO_EARLY") {
          deferCancel(key, CANCEL_RETRY_DELAY_MS);
          return false;
        }
        // Already finished, expired or canceled: nothing is left to release.
        if (error?.code === "CONFLICT" || error?.code === "NOT_FOUND") return true;
        throw error;
      }
    },

    async listServiceOptions(selection = {}) {
      const wantedPlatformId = positiveInt(selection.platformId);
      const wantedCountryId = positiveInt(selection.countryId);
      const anyProductsRequest = wantedPlatformId ? client.listProducts({ platformId: wantedPlatformId }) : null;
      const operatorsRequest = wantedPlatformId && wantedCountryId
        ? client.listOperators(wantedCountryId, wantedPlatformId)
        : null;
      anyProductsRequest?.catch(() => {});
      operatorsRequest?.catch(() => {});

      const [balance, services, countries] = await Promise.all([
        client.getBalance(),
        client.listServices(),
        client.listCountries(),
      ]);
      const activeServices = services.filter((s) => s && s.id != null && s.name && s.active !== false);
      const platform = activeServices.find((s) => s.id === wantedPlatformId)
        || activeServices.find((s) => String(s.code || "").toLowerCase() === DEFAULT_PLATFORM_CODE)
        || activeServices.find((s) => /openai|chatgpt/i.test(s.name))
        || null;
      const result = {
        balance: balance?.amount ? `$${balance.amount}` : null,
        platforms: activeServices
          .map((s) => ({ value: String(s.id), label: String(s.name) }))
          .sort(byLabel),
        platformId: "",
        platformLabel: "",
        countries: [],
        countryId: "",
        countryLabel: "",
        catalogProductId: "",
        operators: [],
      };
      if (!platform) return result;
      result.platformId = String(platform.id);
      result.platformLabel = String(platform.name);

      const samePlatform = platform.id === wantedPlatformId;
      const anyProducts = samePlatform && anyProductsRequest
        ? await anyProductsRequest
        : await client.listProducts({ platformId: platform.id });
      const productsByCountry = new Map();
      for (const product of anyProducts) {
        if (product?.country_id == null || product.catalog_product_id == null) continue;
        if (!productsByCountry.has(product.country_id)) productsByCountry.set(product.country_id, []);
        productsByCountry.get(product.country_id).push(product);
      }
      const countryInfo = new Map(countries.map((c) => [c.id, c]));
      result.countries = [...productsByCountry.entries()]
        .map(([countryId, products]) => {
          const info = countryInfo.get(countryId);
          const tiers = buildTiers(products);
          if (!info?.name || tiers.length === 0) return null;
          return {
            value: String(countryId),
            label: String(info.name),
            emoji: info.emoji || "",
            code: info.code || "",
            dialCode: info.dial_code || "",
            priceLabel: tiers[0].priceLabel,
            catalogProductId: String(products[0].catalog_product_id),
          };
        })
        .filter(Boolean)
        .sort(byLabel);

      const country = result.countries.find((c) => c.value === String(wantedCountryId));
      if (!country) return result;
      result.countryId = country.value;
      result.countryLabel = country.label;
      result.catalogProductId = country.catalogProductId;

      const operators = samePlatform && operatorsRequest
        ? await operatorsRequest
        : await client.listOperators(wantedCountryId, platform.id);
      const namedOperators = operators.filter((o) => o && o.operator_id != null);
      const operatorProducts = await Promise.all(namedOperators.map((o) => client.listProducts({
        platformId: platform.id,
        countryId: wantedCountryId,
        operatorId: o.operator_id,
      })));
      result.operators = [
        { value: "", label: ANY_OPERATOR_LABEL, products: productsByCountry.get(wantedCountryId) },
        ...namedOperators.map((o, index) => ({
          value: String(o.operator_id),
          label: String(o.name || o.local_name || o.code || o.operator_id),
          products: operatorProducts[index],
        })),
      ]
        .map(({ value, label, products }) => {
          const tiers = buildTiers(products);
          return { value, label, tiers, defaultTier: defaultTierValue(tiers) };
        })
        .filter((operator) => operator.tiers.length > 0);
      return result;
    },
  };

  return client;
}

function deferUnref(callback, delayMs) {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function positiveInt(value) {
  const text = String(value ?? "").trim();
  return /^\d{1,10}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

function byLabel(left, right) {
  return left.label.localeCompare(right.label);
}

// Tiers are keyed by their exact IDR ledger price: the USD amount is a rounded projection that drifts with the FX rate.
function buildTiers(products) {
  const byPrice = new Map();
  for (const product of products || []) {
    const idr = Number(product?.price?.canonical_amount);
    const usd = String(product?.price?.amount ?? "");
    const available = Number(product?.available);
    if (!Number.isInteger(idr) || idr <= 0 || !/^\d+(?:\.\d+)?$/.test(usd)) continue;
    if (product.active === false || !(available > 0)) continue;
    const existing = byPrice.get(idr);
    if (!existing || available > existing.available) {
      byPrice.set(idr, { value: String(idr), price: usd, priceLabel: `$${usd}`, available });
    }
  }
  return [...byPrice.values()].sort((left, right) => Number(left.value) - Number(right.value));
}

function defaultTierValue(tiers) {
  if (tiers.length === 0) return "";
  const stocked = tiers.find((tier) => tier.available >= DEFAULT_TIER_MIN_STOCK);
  if (stocked) return stocked.value;
  return tiers.reduce((best, tier) => (tier.available > best.available ? tier : best)).value;
}

// The API floors max_price × rate to IDR, so return the smallest 4-decimal USD amount that still covers `idr`.
function usdCapForIdr(idr, rate) {
  let ticks = Math.ceil((idr * 10_000) / rate);
  while (Math.floor((ticks * rate) / 10_000) < idr) ticks += 1;
  return (ticks / 10_000).toFixed(4);
}

function smsRevision(order) {
  const revision = Number(order?.sms_revision);
  if (Number.isInteger(revision) && revision > 0) return revision;
  return order?.otp_code || order?.otp_message ? 1 : 0;
}

function orderSmsState(order, consumedRevision = 0) {
  const status = String(order?.status || "").toUpperCase();
  const revision = smsRevision(order);
  const code = extractOtpCode(order?.otp_code, order?.otp_message);
  if (code && revision > consumedRevision) return { status: "received", code, revision };
  if (status === "CANCELED" || status === "EXPIRED" || status === "COMPLETED") {
    throw new SmsCodeError("号码订单已结束且未收到新的验证码", { code: status, terminal: true });
  }
  // An SMS without a recognizable code may be followed by another one, so keep waiting.
  return { status: "waiting" };
}

// SMSCode's own classification is trusted. Its fallback only accepts a standalone 6-digit number:
// real SIMs also receive carrier notices, and any shorter or longer digit run in those is not a code.
function extractOtpCode(otpCode, otpMessage) {
  if (otpCode && /^\d{4,8}$/.test(String(otpCode).trim())) return String(otpCode).trim();
  const match = /(?<!\d)\d{6}(?!\d)/.exec(String(otpMessage || ""));
  return match?.[0] || null;
}

function normalizePhoneNumber(value) {
  let phone = String(value || "").trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (!phone.startsWith("+")) phone = `+${phone}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new SmsCodeError("接码平台返回的手机号不是有效的国际格式", { terminal: true });
  }
  return phone;
}

function apiError(code, message, httpStatus, details) {
  const terminal = ["UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "IDEMPOTENCY_KEY_REUSED"].includes(code);
  const descriptions = {
    UNAUTHORIZED: "API Key 不正确",
    FORBIDDEN: "没有权限执行此操作",
    NOT_FOUND: "订单不存在",
    INSUFFICIENT_BALANCE: "账户余额不足",
    CONFLICT: "订单状态冲突",
    CANCEL_TOO_EARLY: "当前订单暂时不允许取消",
    NO_OFFER_AVAILABLE: "所选最高价格内暂无可用号码",
    PROVIDER_ERROR: "上游接码供应商拒绝了请求",
    RATE_LIMIT_EXCEEDED: "请求过于频繁，请稍后重试",
    TEMP_BANNED_ABUSE_GUARD: "因失败率过高暂时被限制下单",
    FX_RATE_UNAVAILABLE: "汇率暂不可用，请稍后重试",
    VALIDATION_ERROR: safeMessage(message) || "请求参数验证失败",
  };
  let desc = descriptions[code] || safeMessage(message) || `HTTP ${httpStatus}`;
  if (code === "PROVIDER_ERROR") {
    const causes = orderFailureCauses(details);
    if (causes.length > 0) desc = `${desc}：${causes.join("、")}`;
  }
  return new SmsCodeError(desc, { code, terminal });
}

// The shape of `details` differs between direct and routed orders, so match the documented cause names anywhere in it.
function orderFailureCauses(details) {
  if (!details || typeof details !== "object") return [];
  const text = JSON.stringify(details);
  return Object.entries(ORDER_FAILURE_CAUSES)
    .filter(([cause]) => text.includes(`"${cause}"`))
    .map(([, label]) => label);
}

function safeMessage(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}
