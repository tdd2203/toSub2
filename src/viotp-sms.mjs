const DEFAULT_API_BASE = "https://api.viotp.com";
const DEFAULT_TIMEOUT_MS = 15_000;

export class ViOtpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ViOtpError";
    this.code = options.code ?? null;
    this.terminal = Boolean(options.terminal);
  }
}

export function createViOtpClient(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const apiBase = new URL(options.apiBase || DEFAULT_API_BASE);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!apiKey) return null;
  if (!/^https?:$/.test(apiBase.protocol)) throw new Error("ViOTP API 地址必须使用 HTTP 或 HTTPS");

  async function request(path, params = {}) {
    const url = new URL(path, apiBase);
    url.searchParams.set("token", apiKey);
    Object.entries(params).forEach(([key, value]) => {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new ViOtpError(`接码平台返回 HTTP ${response.status}`, { terminal: response.status < 500 });
      const data = await response.json();
      if (!data || typeof data !== "object") throw new ViOtpError("接码平台返回了无效数据");
      if (data.status_code !== 200 && !data.success) {
        throw new ViOtpError(safeMessage(data.message) || "ViOTP 请求失败", {
          code: data.status_code,
          terminal: data.status_code === 401 || data.status_code === 403,
        });
      }
      return data.data;
    } catch (error) {
      if (error?.name === "AbortError") throw new ViOtpError("接码平台请求超时");
      if (error instanceof ViOtpError) throw error;
      throw new ViOtpError(`接码平台请求失败：${safeMessage(error?.message)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getBalance() {
      const data = await request("/api/balance");
      return typeof data === "number" ? data : Number(data?.balance ?? data ?? 0);
    },

    async listServices(country) {
      const params = {};
      if (country) params.country = country;
      const data = await request("/api/service/getv2", params);
      if (!Array.isArray(data)) return [];
      return data.map((s) => ({
        id: s.id,
        name: String(s.name || ""),
        price: Number(s.price || 0),
      }));
    },

    async listNetworks() {
      const data = await request("/api/network/getv2");
      if (!Array.isArray(data)) return [];
      return data.map((n) => ({ id: n.id, name: String(n.name || "") }));
    },

    async getNumber(serviceId, opts = {}) {
      const params = { service_id: serviceId };
      if (opts.network) params.network = opts.network;
      if (opts.country) params.country = opts.country;
      if (opts.number) params.number = opts.number;
      const data = await request("/api/request/getv2", params);
      if (!data?.phone_number || !data?.request_id) {
        throw new ViOtpError("获取手机号失败：ViOTP 未返回号码", { terminal: false });
      }
      const countryCode = String(data.countryCode || "84");
      return {
        requestId: String(data.request_id),
        number: normalizePhoneNumber(data.phone_number, countryCode),
        rePhone: String(data.re_phone_number || ""),
        balance: Number(data.balance || 0),
      };
    },

    async getSms(requestId) {
      const data = await request("/api/session/getv2", { id: requestId });
      const status = Number(data?.Status ?? data?.status ?? 0);
      if (status === 1) {
        const code = extractViOtpCode(data);
        if (code) return { status: "received", code };
        throw new ViOtpError("接码平台返回内容中没有找到验证码", { terminal: true });
      }
      if (status === 2) return { status: "expired" };
      return { status: "waiting" };
    },

    async release(requestId) {
      return true;
    },

    async listServiceOptions(country) {
      const [services, balance] = await Promise.all([
        this.listServices(country),
        this.getBalance(),
      ]);
      return {
        balance,
        services: services.map((s) => ({
          value: String(s.id),
          label: s.name,
          price: s.price,
          priceLabel: `${Number(s.price).toLocaleString()} đ`,
        })),
      };
    },
  };
}

function extractViOtpCode(data) {
  const code = String(data?.Code || data?.code || "").trim();
  if (/^\d{4,8}$/.test(code)) return code;
  const content = String(data?.SmsContent || data?.sms_content || "");
  const match = /(?:^|\D)(\d{6})(?!\d)/.exec(content);
  return match?.[1] || code || null;
}

function normalizePhoneNumber(value, countryCode) {
  let phone = String(value || "").trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (!phone.startsWith("+")) phone = `+${countryCode}${phone}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new ViOtpError("接码平台返回的手机号不是有效的国际格式", { terminal: true });
  }
  return phone;
}

function safeMessage(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}
