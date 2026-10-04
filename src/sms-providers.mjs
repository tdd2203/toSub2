import { createLubanSmsClient } from "./luban-sms.mjs";
import { createSmsBowerClient } from "./smsbower.mjs";
import { createViOtpClient } from "./viotp-sms.mjs";
import { createSmsCodeClient } from "./smscode-sms.mjs";
import { createCustomSmsClient } from "./custom-sms.mjs";

// How far above the chosen tier's price a fallback purchase may go when that tier
// is out of stock. Override with SMSBOWER_FALLBACK_PRICE_MULTIPLIER (>= 1).
const DEFAULT_SMSBOWER_FALLBACK_MULTIPLIER = 2;
function smsbowerFallbackMultiplier(options = {}) {
  const raw = Number(options.smsBowerFallbackMultiplier ?? process.env.SMSBOWER_FALLBACK_PRICE_MULTIPLIER);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_SMSBOWER_FALLBACK_MULTIPLIER;
}

export const SMS_PROVIDER_DEFINITIONS = [
  {
    id: "luban",
    name: "LubanSMS",
    description: "使用供应商编号获取手机号",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "输入 LubanSMS API Key" },
      { key: "serviceId", label: "供应商编号", type: "text", placeholder: "例如 121949", summary: true },
    ],
  },
  {
    id: "smsbower",
    name: "SMSBower",
    description: "查询 OpenAI 实时价格和库存后选择国家",
    optionsEndpoint: "/api/sms-providers/smsbower/options",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "输入 SMSBower API Key" },
      { key: "service", label: "服务代码", type: "hidden", defaultValue: "dr" },
      { key: "country", label: "国家与价格", type: "price-select", defaultValue: "1001", summaryKey: "countryLabel" },
      { key: "maxPrice", label: "最高价格", type: "hidden", required: false },
      { key: "countryLabel", label: "国家名称", type: "hidden", required: false },
    ],
  },
  {
    id: "viotp",
    name: "ViOTP",
    description: "越南/老挝接码平台 (api.viotp.com)",
    optionsEndpoint: "/api/sms-providers/viotp/options",
    fields: [
      { key: "apiKey", label: "API Token", type: "password", placeholder: "输入 ViOTP API Token" },
      { key: "country", label: "国家", type: "select", defaultValue: "vn", options: [
        { value: "vn", label: "越南" },
        { value: "la", label: "老挝" },
      ]},
      { key: "serviceId", label: "服务与价格", type: "service-select", defaultValue: "", summaryKey: "serviceLabel" },
      { key: "serviceLabel", label: "服务名称", type: "hidden", required: false },
    ],
  },
  {
    id: "smscode",
    name: "SMSCode",
    description: "SMSCode 全球接码平台 (smscode.gg)",
    optionsEndpoint: "/api/sms-providers/smscode/options",
    fields: [
      { key: "apiKey", label: "API Token", type: "password", placeholder: "输入 SMSCode API Token" },
      { key: "platformId", label: "平台", type: "smscode-platform" },
      { key: "countryId", label: "国家", type: "smscode-country" },
      { key: "operatorId", label: "运营商", type: "smscode-operator", required: false },
      { key: "maxPriceIdr", label: "最高价格", type: "smscode-tier", summaryKey: "serviceLabel" },
      { key: "catalogProductId", label: "目录产品", type: "hidden", required: false },
      { key: "maxPrice", label: "最高价格 (USD)", type: "hidden", required: false },
      { key: "serviceLabel", label: "服务名称", type: "hidden", required: false },
      { key: "platformLabel", label: "平台名称", type: "hidden", required: false },
      { key: "countryLabel", label: "国家名称", type: "hidden", required: false },
      { key: "operatorLabel", label: "运营商名称", type: "hidden", required: false },
    ],
  },
  {
    id: "custom",
    name: "自定义接码",
    description: "批量粘贴手机号和对应的接码 API",
    fields: [
      {
        key: "entries",
        label: "手机号与接码 API",
        type: "textarea",
        placeholder: "+861871291167----https://example.com/messages/1871291167",
      },
    ],
  },
];

export function publicSmsProviderDefinitions() {
  return SMS_PROVIDER_DEFINITIONS.map((provider) => ({
    ...provider,
    fields: provider.fields.map((field) => ({ ...field })),
  }));
}

export function createSmsProvider(providerIdValue, configValue = {}, options = {}) {
  const providerId = String(providerIdValue || "").trim().toLowerCase();
  const config = configValue && typeof configValue === "object" ? configValue : {};

  if (providerId === "luban") {
    const apiKey = validateApiKey(config.apiKey, "LubanSMS");
    const serviceId = String(config.serviceId || "").trim();
    if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(serviceId)) throw new Error("请输入有效的 LubanSMS 供应商编号");
    const client = createLubanSmsClient({ apiKey, apiBase: options.lubanApiBase, fetchImpl: options.fetchImpl });
    return {
      id: "luban",
      name: "LubanSMS",
      apiKey,
      serviceLabel: serviceId,
      getNumber: () => client.getNumber(serviceId),
      getSms: (requestId) => client.getSms(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  if (providerId === "smsbower") {
    const apiKey = validateApiKey(config.apiKey, "SMSBower");
    const service = String(config.service || "dr").trim().toLowerCase();
    const country = String(config.country || "").trim();
    const maxPrice = String(config.maxPrice || "").trim();
    const agentId = String(config.smsAgentId || "").trim();
    if (!/^[a-z0-9_]{1,32}$/.test(service)) throw new Error("请输入有效的 SMSBower 服务代码");
    if (!/^\d{1,5}$/.test(country)) throw new Error("请输入有效的 SMSBower 国家 ID");
    if (maxPrice && (!/^\d+(?:\.\d{1,6})?$/.test(maxPrice) || Number(maxPrice) <= 0)) {
      throw new Error("请重新查询 SMSBower 国家价格");
    }
    if (agentId && !/^\d{1,10}$/.test(agentId)) throw new Error("请重新选择 SMSBower 号码质量档位");
    // agentId "0" means the catalog had no agent for that tier → do not pin a provider.
    const providerIds = agentId && Number(agentId) > 0 ? agentId : "";
    // When the pinned tier runs out, allow buying another tier in the same country
    // up to (chosen price × multiplier) so a replacement never overpays the budget.
    let fallbackMaxPrice = "";
    if (providerIds && /^\d+(?:\.\d{1,6})?$/.test(maxPrice) && Number(maxPrice) > 0) {
      const capped = Number(maxPrice) * smsbowerFallbackMultiplier(options);
      fallbackMaxPrice = String(Number(capped.toFixed(6)));
    }
    const client = createSmsBowerClient({ apiKey, apiBase: options.smsBowerApiBase, fetchImpl: options.fetchImpl });
    return {
      id: "smsbower",
      name: "SMSBower",
      apiKey,
      serviceLabel: config.countryLabel || `${service} / ${country}`,
      getNumber: () => client.getNumber(service, country, maxPrice, { providerIds, fallbackMaxPrice }),
      listNumberOptions: () => client.getPriceOptions(service),
      getSms: (requestId) => client.getSms(requestId),
      markReady: (requestId) => client.markReady(requestId),
      complete: (requestId) => client.complete(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  if (providerId === "viotp") {
    const apiKey = validateApiKey(config.apiKey, "ViOTP");
    const serviceId = String(config.serviceId || "").trim();
    const country = String(config.country || "vn").trim().toLowerCase();
    const client = createViOtpClient({ apiKey, apiBase: options.viOtpApiBase, fetchImpl: options.fetchImpl });
    return {
      id: "viotp",
      name: "ViOTP",
      apiKey,
      serviceLabel: config.serviceLabel || serviceId,
      getNumber: () => {
        if (!/^\d{1,10}$/.test(serviceId)) throw new Error("请选择 ViOTP 服务");
        return client.getNumber(serviceId, { country });
      },
      listNumberOptions: () => client.listServiceOptions(country),
      getSms: (requestId) => client.getSms(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  if (providerId === "smscode") {
    const apiKey = validateApiKey(config.apiKey, "SMSCode");
    const catalogProductId = String(config.catalogProductId || "").trim();
    const operatorId = String(config.operatorId || "").trim();
    const maxPriceIdr = String(config.maxPriceIdr || "").trim();
    const maxPrice = String(config.maxPrice || "").trim();
    const client = createSmsCodeClient({ apiKey, apiBase: options.smsCodeApiBase, fetchImpl: options.fetchImpl });
    return {
      id: "smscode",
      name: "SMSCode",
      apiKey,
      serviceLabel: config.serviceLabel || catalogProductId,
      getNumber: () => {
        if (!/^\d{1,10}$/.test(catalogProductId)) throw new Error("请先查询并选择 SMSCode 国家");
        if (operatorId && !/^\d{1,10}$/.test(operatorId)) throw new Error("请重新选择 SMSCode 运营商");
        // An order without a cap may be routed to any tier, however expensive.
        const cappedByIdr = /^[1-9]\d{0,11}$/.test(maxPriceIdr);
        const cappedByUsd = /^\d+(?:\.\d{1,6})?$/.test(maxPrice) && Number(maxPrice) > 0;
        if (!cappedByIdr && !cappedByUsd) throw new Error("请重新查询并选择 SMSCode 最高价格");
        return client.createOrder(catalogProductId, {
          operatorId,
          maxPriceIdr: cappedByIdr ? maxPriceIdr : "",
          maxPrice: cappedByUsd ? maxPrice : "",
        });
      },
      listNumberOptions: () => client.listServiceOptions({ platformId: config.platformId, countryId: config.countryId }),
      getSms: (requestId) => client.pollActiveOrder(requestId),
      markReady: (requestId) => client.requestNextSms(requestId),
      complete: (requestId) => client.finishOrder(requestId),
      release: (requestId) => client.releaseOrder(requestId),
    };
  }

  if (providerId === "custom") {
    const client = createCustomSmsClient({
      entries: config.entries,
      fetchImpl: options.fetchImpl,
      acquireEntry: options.acquireCustomSmsEntry,
    });
    return {
      id: "custom",
      name: "自定义接码",
      apiKey: "",
      serviceLabel: `${client.entryCount} 个号码`,
      getNumber: () => client.getNumber(),
      getSms: (requestId) => client.getSms(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  throw new Error("请选择受支持的接码平台");
}

function validateApiKey(value, providerName) {
  const apiKey = String(value || "").trim();
  if (!/^[a-zA-Z0-9._-]{8,256}$/.test(apiKey)) throw new Error(`请输入有效的 ${providerName} API Key`);
  return apiKey;
}
