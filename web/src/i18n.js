// Lightweight i18n for the console UI.
// Keys are the original Chinese source strings, so Chinese renders verbatim
// (activeLang === "zh" returns the key) and only non-default languages need a
// dictionary entry. Missing entries fall back to the Chinese source.

import { SERVER_VI, SERVER_VI_FRAGMENTS } from "./i18n-server.js";
import { getItem, setItem } from "./settings-store.js";

export const LANG_STORAGE_KEY = "chatgpt-onboarding.lang-v1";

export const LANGS = {
  zh: "中文",
  vi: "Tiếng Việt",
};

const LOCALES = {
  zh: "zh-CN",
  vi: "vi-VN",
};

let activeLang = "zh";

export function setActiveLang(lang) {
  activeLang = Object.hasOwn(LANGS, lang) ? lang : "zh";
  return activeLang;
}

export function getLang() {
  return activeLang;
}

export function readInitialLang() {
  try {
    const stored = getItem(LANG_STORAGE_KEY);
    if (stored && Object.hasOwn(LANGS, stored)) return stored;
  } catch {}
  return "zh";
}

export function persistLang(lang) {
  try {
    setItem(LANG_STORAGE_KEY, lang);
  } catch {}
}

export function t(zh) {
  if (activeLang === "zh") return zh;
  const entry = DICTS[activeLang]?.[zh];
  return entry == null ? zh : entry;
}

export function tf(zh, ...args) {
  const template = activeLang === "zh" ? zh : (DICTS[activeLang]?.[zh] ?? zh);
  return String(template).replace(/\{(\d+)\}/g, (whole, index) => {
    const value = args[Number(index)];
    return value == null ? "" : String(value);
  });
}

export function currentLocale() {
  return LOCALES[activeLang] || LOCALES.zh;
}

const regionNames = new Map();

// Localized country name for an ISO 3166 code, or "" when unknown.
export function regionLabel(iso) {
  if (!iso || typeof Intl.DisplayNames !== "function") return "";
  try {
    const locale = currentLocale();
    if (!regionNames.has(locale)) regionNames.set(locale, new Intl.DisplayNames([locale], { type: "region" }));
    const label = regionNames.get(locale).of(iso);
    return label && label !== iso ? label : "";
  } catch {
    return "";
  }
}

// Text produced by the local server (API errors, job prompts, protocol logs,
// SMS provider definitions) is Chinese. ts() translates it at render time:
// exact dictionary match first, then "{n}" templates compiled to regexes whose
// captured values are translated recursively (so "准备登录任务失败：<inner>"
// comes out fully translated), then clause by clause for unknown compositions.
const CJK = /[　-〿㐀-鿿＀-￯]/;
const LOG_PREFIX = /^(\[[^\]\n]{1,40}\]\s*|[A-Z][A-Z0-9_]{2,}:\s*)([\s\S]+)$/;
const CLAUSE_SPLIT = /(：|；|，|。|、)/;
const CLAUSE_PUNCTUATION = { "：": ": ", "；": "; ", "，": ", ", "。": ". ", "、": ", " };
const MAX_NESTING = 6;
const serverTextCache = new Map();
const templateCache = new WeakMap();

export function ts(text) {
  if (activeLang === "zh" || typeof text !== "string" || !CJK.test(text)) return text;
  const dict = DICTS[activeLang];
  if (!dict) return text;
  const cacheKey = `${activeLang}\u0000${text}`;
  let translated = serverTextCache.get(cacheKey);
  if (translated === undefined) {
    translated = translateServerText(text, dict, 0);
    if (serverTextCache.size >= 5000) serverTextCache.clear();
    serverTextCache.set(cacheKey, translated);
  }
  return translated;
}

// Multi-line server text such as protocol logs, translated line by line.
export function tsLines(text) {
  if (activeLang === "zh" || typeof text !== "string" || !CJK.test(text)) return text;
  return text.split("\n").map(ts).join("\n");
}

function translateServerText(text, dict, depth) {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return lead + translateServerCore(core, dict, depth) + trail;
}

function translateServerCore(core, dict, depth) {
  if (!CJK.test(core)) return core;
  const exact = dict[core];
  if (typeof exact === "string") return exact;
  if (depth >= MAX_NESTING) return replaceFragments(core);
  const nested = (value) => translateServerText(value, dict, depth + 1);

  // Log tags ("[sms] ") and error codes ("REFRESH_TOKEN_INVALID: ") stay as-is.
  const prefixed = LOG_PREFIX.exec(core);
  if (prefixed) return prefixed[1] + nested(prefixed[2]);

  for (const template of compileTemplates(dict)) {
    if (!core.includes(template.anchor)) continue;
    const match = template.pattern.exec(core);
    if (!match) continue;
    return template.value.replace(/\{(\d+)\}/g, (whole, index) => {
      const slot = template.slots.indexOf(Number(index));
      return slot < 0 ? whole : nested(match[slot + 1]);
    });
  }

  const clauses = core.split(CLAUSE_SPLIT);
  if (clauses.length > 1) {
    return clauses
      .map((part, index) => (index % 2 ? CLAUSE_PUNCTUATION[part] : nested(part)))
      .join("")
      .replace(/ {2,}/g, " ")
      .trim();
  }
  return regionFromChineseName(core) || replaceFragments(core);
}

function compileTemplates(dict) {
  let templates = templateCache.get(dict);
  if (templates) return templates;
  templates = [];
  for (const [key, value] of Object.entries(dict)) {
    if (!/\{\d+\}/.test(key) || !CJK.test(key)) continue;
    const slots = [];
    let source = "";
    let anchor = "";
    let literalLength = 0;
    for (const piece of key.split(/(\{\d+\})/)) {
      const slot = /^\{(\d+)\}$/.exec(piece);
      if (slot) {
        slots.push(Number(slot[1]));
        source += "([\\s\\S]*?)";
        continue;
      }
      source += piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      literalLength += piece.length;
      if (piece.length > anchor.length) anchor = piece;
    }
    templates.push({ pattern: new RegExp(`^${source}$`), slots, value, anchor, literalLength });
  }
  // Most specific first, so "{0}：{1}"-style catch-alls are tried last.
  templates.sort((left, right) => right.literalLength - left.literalLength);
  templateCache.set(dict, templates);
  return templates;
}

function replaceFragments(text) {
  return (FRAGMENTS[activeLang] || []).reduce((result, [zh, local]) => result.split(zh).join(local), text);
}

let chineseRegionCodes = null;

// Country names the server or older settings stored in Chinese (e.g. "越南").
function regionFromChineseName(name) {
  if (typeof Intl.DisplayNames !== "function") return "";
  if (!chineseRegionCodes) {
    chineseRegionCodes = new Map();
    try {
      const zh = new Intl.DisplayNames(["zh-CN"], { type: "region" });
      for (let first = 65; first <= 90; first += 1) {
        for (let second = 65; second <= 90; second += 1) {
          const code = String.fromCharCode(first, second);
          const label = zh.of(code);
          if (label && label !== code) chineseRegionCodes.set(label, code);
        }
      }
    } catch {}
  }
  const code = chineseRegionCodes.get(name);
  return code ? regionLabel(code) : "";
}

const VI = {
  // Header
  "ChatGPT 账号授权控制台": "Bảng điều khiển ủy quyền tài khoản ChatGPT",
  "本地多任务协议登录": "Đăng nhập giao thức đa tác vụ cục bộ",
  "任务统计": "Thống kê tác vụ",
  "待启动": "Chờ khởi động",
  "进行中": "Đang chạy",
  "排队中": "Đang chờ",
  "已完成": "Hoàn tất",

  // Workflow steps
  "准备工具": "Chuẩn bị công cụ",
  "配置代理、接码平台与邮件 API": "Cấu hình proxy, nền tảng nhận mã và Email API",
  "连接 Sub2API": "Kết nối Sub2API",
  "填写后端地址与管理员 Key，选择目标号池": "Nhập backend & API Key quản trị, chọn pool đích",
  "创建账号": "Tạo tài khoản",
  "输入邮箱或批量导入，开始授权任务": "Nhập email hoặc thêm hàng loạt để bắt đầu tác vụ",
  "管理并上传到 Sub2API": "Quản lý & đẩy lên Sub2API để dùng",
  "完成后上传到号池，即可快速登录使用": "Xong thì tải lên pool để đăng nhập nhanh",

  // Section heading + add form
  "授权任务": "Tác vụ ủy quyền",
  "添加邮箱后开始第一条任务": "Thêm email để bắt đầu tác vụ đầu tiên",
  "匹配 {0} 条，共 {1} 条任务": "Khớp {0}, tổng {1} tác vụ",
  "共 {0} 条任务": "Tổng {0} tác vụ",
  "输入邮箱地址": "Nhập địa chỉ email",
  "邮箱地址": "Địa chỉ email",
  "添加任务": "Thêm tác vụ",
  "批量添加": "Thêm hàng loạt",
  "筛选 {0}": "Lọc {0}",
  "筛选账号": "Lọc tài khoản",
  "清除筛选": "Xóa bộ lọc",

  // SMS provider toolbar
  "接码平台配置": "Cấu hình nền tảng nhận mã",
  "接码平台": "Nền tảng nhận mã",
  "未选择": "Chưa chọn",
  "已配置": "Đã cấu hình",
  "已配置 · {0}": "Đã cấu hình · {0}",
  "未完成配置": "Chưa cấu hình xong",
  "配置": "Cấu hình",

  // Mail API toolbar
  "邮件接码请求配置": "Cấu hình yêu cầu nhận mã qua email",
  "邮件 API": "Email API",

  // Sub2API toolbar
  "Sub2API 配置与号池监控": "Cấu hình Sub2API và giám sát pool",
  "未配置后端": "Chưa cấu hình backend",
  "已配置 · {0} 个号池": "Đã cấu hình · {0} pool",
  "已配置 · 默认号池": "Đã cấu hình · pool mặc định",
  " · 已指定代理": " · đã chỉ định proxy",
  "正在巡检": "Đang kiểm tra",
  "号池监控已启用": "Đã bật giám sát pool",
  "号池监控未启用": "Chưa bật giám sát pool",
  "立即检查 Sub2API 异常账号": "Kiểm tra ngay tài khoản lỗi trên Sub2API",

  // Proxy toolbar
  "代理 IP 配置": "Cấu hình proxy IP",
  "代理 IP": "Proxy IP",
  "支持 http://、https://、socks5:// 和 socks5h://；用户名中包含 -sid- 时会自动轮换会话编号":
    "Hỗ trợ http://, https://, socks5:// và socks5h://; nếu tên đăng nhập có -sid- sẽ tự xoay số phiên",
  "socks5h://用户名:密码@主机:端口": "socks5h://user:mật_khẩu@host:cổng",
  "代理 IP 地址": "Địa chỉ proxy IP",
  "已配置，按账号检测出口": "Đã cấu hình, kiểm tra IP theo từng tài khoản",
  "未配置，使用本地 IP": "Chưa cấu hình, dùng IP máy này",
  "本机 IP": "IP máy",
  "正在获取本机 IP…": "Đang lấy IP máy…",
  "本机 IP：{0}": "IP máy: {0}",
  "本机 IP（无代理）": "IP máy (không proxy)",
  "使用本机网络 · IP {0}": "Dùng mạng máy · IP {0}",
  "使用本机网络（无代理）": "Dùng mạng máy (không proxy)",
  "必须配置代理 IP，或选择“本机 IP”": "Bắt buộc cấu hình proxy IP, hoặc chọn “IP máy”",
  "正在检测代理…": "Đang kiểm tra proxy…",
  "代理已连接 · 出口 IP {0}": "Proxy đã kết nối · IP {0}",
  "代理连接失败": "Proxy kết nối thất bại",
  "（批量 · {0}/IP）": "（Hàng loạt · {0}/IP）",
  "代理连接方式": "Cách kết nối proxy",
  "上传到 Sub2API 时如何给账号分配代理": "Cách gán proxy cho tài khoản khi tải lên Sub2API",
  "连接 1 IP": "Kết nối 1 IP",
  "批量连接": "Kết nối hàng loạt",
  "代理 IP 列表": "Danh sách proxy IP",
  "每行一个，例如 socks5h://user:pass@host:port": "Mỗi dòng một proxy, ví dụ socks5h://user:pass@host:port",
  "每个 IP 最多账号数": "Số tài khoản tối đa mỗi IP",
  "默认 {0}": "mặc định {0}",
  "每个 IP 每分钟最多注册账号数": "Số tài khoản tối đa đăng ký mỗi phút trên mỗi IP",
  "默认 {0}，0 = 不限制": "mặc định {0}, 0 = không giới hạn",
  "同一 IP 短时间内连续注册时，服务端可能不发送验证邮件；超出上限的注册任务会留在队列中等待。":
    "Khi cùng một IP đăng ký liên tiếp trong thời gian ngắn, phía dịch vụ có thể không gửi email xác minh; tác vụ đăng ký vượt giới hạn sẽ chờ trong hàng đợi.",
  "每个账号使用它注册时的代理，上传时自动创建并关联。": "Mỗi tài khoản dùng proxy lúc đăng ký; khi tải lên tự tạo và liên kết.",
  "完成": "Xong",
  "，创建代理 {0} 个": "，đã tạo {0} proxy",
  "，{0} 条未分配代理": "，{0} chưa gán proxy",
  "服务：{0} · {1} 个国家": "Dịch vụ: {0} · {1} quốc gia",
  "点击查询实时价格与国家/质量": "Bấm tra giá & quốc gia/chất lượng theo thời gian thực",
  "选择国家": "Chọn quốc gia",
  "国家": "Quốc gia",
  "号码质量与价格": "Chất lượng & giá số",
  "请先选择国家": "Hãy chọn quốc gia trước",
  "短信费用": "Chi phí SMS",
  "取号会扣费；验证成功才计入，取消/换号会退款": "Lấy số bị trừ tiền; chỉ tính khi xác minh thành công, huỷ/đổi số sẽ hoàn tiền",
  "已扣费 · 成功 {0} 个": "Đã trừ · {0} số thành công",
  "已退款（取消/换号）": "Đã hoàn (huỷ/đổi số)",
  "待验证（暂扣）": "Chờ xác minh (tạm giữ)",
  "暂无取号记录": "Chưa có lượt lấy số",
  "已扣费": "Đã trừ",
  "已退款": "Đã hoàn",
  "待验证": "Chờ xác minh",
  "必须先配置代理 IP，或在“格式”里选择“本机 IP”": "Cần cấu hình proxy IP trước, hoặc chọn “IP máy” ở mục “Định dạng”",
  "请先在“代理 IP 列表”中添加代理 IP": "Hãy thêm proxy IP vào “Danh sách proxy IP” trước",

  // Proxy IP list dialog
  "{0} 个 IP 活跃 · 剩余约 {1} 次注册": "{0} IP hoạt động · còn ~{1} lần đăng ký",
  "{0}/{1} 个 IP 活跃 · 剩余约 {2} 次注册 · 上限 {3}/IP": "{0}/{1} IP hoạt động · còn ~{2} lần đăng ký · tối đa {3}/IP",
  "批量模式 · 正在统计代理": "Chế độ nhiều IP · đang thống kê proxy",
  "批量模式 · 请添加代理": "Chế độ nhiều IP · hãy thêm proxy",
  "管理代理、查看每个 IP 已注册的邮箱与连接状态": "Quản lý proxy, xem email đã đăng ký và trạng thái kết nối của từng IP",
  "批量添加代理": "Thêm proxy hàng loạt",
  "已识别 {0} 个 SOCKS5 · {1} 个 HTTP": "Nhận diện {0} SOCKS5 · {1} HTTP",
  "{0} SOCKS5 · {1} HTTP · {2} 个未识别（点按钮指定协议）": "{0} SOCKS5 · {1} HTTP · {2} chưa rõ (chọn nút để ép giao thức)",
  "粘贴后自动识别 HTTP / SOCKS5": "Dán vào để tự nhận diện HTTP / SOCKS5",
  "添加 SOCKS5（{0}）": "Thêm SOCKS5 ({0})",
  "添加 HTTP（{0}）": "Thêm HTTP ({0})",
  "添加全部": "Thêm tất cả",
  "暂无代理，请在“配置”中选择“批量连接”并填入代理，或使用上方批量添加": "Chưa có proxy — hãy chọn “Kết nối hàng loạt” trong Cấu hình rồi nhập proxy, hoặc dùng phần thêm hàng loạt ở trên",
  " · 出口 {0}": " · IP ra {0}",
  "剩余 {0}": "còn {0}",
  "预计：{0} 个 IP 活跃 · 剩余约 {1} 次注册": "Ước lượng: {0} IP hoạt động · còn ~{1} lần đăng ký",
  "上限可在“配置”中调整": "Có thể chỉnh giới hạn trong Cấu hình",
  "已连接": "Đã kết nối",
  "连接失败": "Mất kết nối",
  "IP 活跃 / 总数": "IP hoạt động / tổng",
  "剩余可注册次数（估算）": "Lần đăng ký còn lại (ước lượng)",
  "每个 IP 上限": "Giới hạn mỗi IP",
  "协议": "Giao thức",
  "已注册邮箱": "Email đã đăng ký",
  "剩余额度": "Còn lại",
  "出口 {0}": "IP ra {0}",
  "出口 IP": "IP ra",
  "未知出口": "Chưa rõ IP ra",
  "代理异常": "Proxy lỗi",
  "粘贴后自动识别 HTTP / SOCKS5（每个 IP 只添加一次）": "Dán vào để tự nhận diện HTTP / SOCKS5 (mỗi IP chỉ thêm 1 lần)",
  "已配置 {0} 个代理 IP。代理请在“代理 IP 列表”中添加与管理。": "Đã cấu hình {0} proxy IP. Thêm và quản lý proxy trong “Danh sách proxy IP”.",
  "通用代理池：已配置 {0} 个代理 IP（用于所有域名）。": "Pool chung: đã cấu hình {0} proxy IP (dùng cho mọi domain).",
  "按域名分配专用代理": "Gán proxy riêng theo domain",
  "指定域名的邮箱只用该域名的专用代理；用完后再借用通用代理池": "Email thuộc domain đã chỉ định chỉ dùng proxy riêng của domain đó; hết chỗ mới mượn pool chung",
  "每个域名可填多行代理（每行一个）；该域名的账号会在这些专用代理间按每 IP 上限轮流分配，用完后再借用通用代理池": "Mỗi domain nhập được nhiều proxy (mỗi dòng 1 cái); tài khoản của domain được phân bổ đều (round-robin) qua các proxy riêng đó theo giới hạn mỗi IP, hết chỗ mới mượn pool chung",
  "域名，例如 example.com": "Domain, ví dụ example.com",
  "{0} 个 IP": "{0} IP",
  "添加域名代理": "Thêm proxy domain",
  "删除": "Xoá",
  "已绑定 {0} 个专用 IP 给 {1}（已从通用池移除）": "Đã gán {0} IP riêng cho {1} (đã gỡ khỏi pool chung)",
  "请填写域名": "Hãy nhập domain",
  "请填写该域名的代理": "Hãy nhập proxy cho domain này",
  "为现有账号更换代理": "Đổi proxy cho tài khoản hiện có",
  "已为 {0} 个账号更换代理（跳过运行中 {1} · 无可用代理 {2}）": "Đã đổi proxy cho {0} tài khoản (bỏ qua đang chạy {1} · không có proxy phù hợp {2})",
  "把某代理分配给域名后它会自动从通用池移除；点“为现有账号更换代理”会把该域名的已有账号移到它的专用代理，并把占用该代理的其它域名账号移走（运行中的账号会跳过）。":
    "Sau khi gán proxy cho domain nó tự gỡ khỏi pool chung; bấm “Đổi proxy cho tài khoản hiện có” sẽ kéo các tài khoản của domain đó về proxy riêng, và đẩy tài khoản domain khác đang chiếm proxy đó sang proxy phù hợp (tài khoản đang chạy sẽ bỏ qua).",
  "使用中": "Đang sử dụng",
  "未使用": "Chưa sử dụng",
  "已用完": "Đã sử dụng",
  "需换 IP": "Cần đổi IP",
  "被封号": "Bị vô hiệu",
  "已换 IP": "Đã đổi IP",
  "未换 IP": "Chưa đổi IP",
  "未知": "Chưa rõ",
  "新 IP": "IP mới",
  "合计": "Tổng",
  "当前出口 IP 封 {0}/{1}": "IP ra hiện tại: {0}/{1} bị vô hiệu hoá",
  "当前 IP {0} 封": "IP hiện tại: {0} cháy",
  "当前 IP 暂无数据": "IP hiện tại: chưa có dữ liệu",
  "当前出口 IP 已有 {0} 个账号被封，需更换": "IP ra hiện tại đã có {0} tài khoản bị vô hiệu hoá — cần đổi IP",
  "当前出口 IP 已有 {0} 个账号被封": "IP ra hiện tại đã có {0} tài khoản bị vô hiệu hoá",
  "当前出口 IP 尚无账号被封，已更换成功": "IP ra hiện tại chưa có tài khoản nào bị vô hiệu hoá — đã đổi IP thành công",
  "当前出口 IP 还没有新账号数据": "IP ra hiện tại chưa có dữ liệu tài khoản mới",
  "历史封号 {0}/{1}（该代理全部记录，不随换 IP 清零）": "Lịch sử bị vô hiệu hoá {0}/{1} (toàn bộ record của proxy này, không xoá khi đổi IP)",
  "该代理暂无封号记录": "Proxy này chưa có record bị vô hiệu hoá",
  "忘记此 IP（从列表隐藏，不删账号）": "Quên IP này (ẩn khỏi danh sách, không xoá tài khoản)",
  "没有符合筛选条件的代理": "Không có proxy khớp bộ lọc",
  "IP 旧": "IP cũ",
  "从列表中删除该代理": "Xoá proxy này khỏi danh sách",
  "旧 IP（不在配置列表中）": "IP cũ (không có trong danh sách cấu hình)",
  "{0} 个已注册邮箱": "{0} email đã đăng ký",
  "复制全部": "Copy tất cả",

  // Global banners
  "关闭": "Đóng",

  // Selection toolbar
  "当前页 {0} 条，跨页已选 {1} 条，可下载 {2} 条": "Trang này {0}, đã chọn {1} (mọi trang), tải được {2}",
  "本页全选": "Chọn hết trang này",
  "清除选择": "Bỏ chọn",
  "开始运行": "Bắt đầu chạy",
  "将选中的待启动任务加入队列并开始运行": "Đưa các tác vụ chờ khởi động đã chọn vào hàng đợi và bắt đầu chạy",
  "选中的任务都不是待启动状态": "Các tác vụ đã chọn đều không ở trạng thái chờ khởi động",
  "已加入运行列表（待启动）{0} 个，选中后点击“开始运行”即可启动": "Đã thêm {0} email vào danh sách chạy (chờ khởi động); chọn rồi bấm “Bắt đầu chạy” để khởi động",
  "加入运行列表失败：{0}": "Thêm vào danh sách chạy thất bại: {0}",
  "已创建 {0} 个邮箱 — 已自动加入运行列表（待启动）": "Đã tạo {0} email — đã tự động thêm vào danh sách chạy (chờ khởi động)",
  "创建临时邮箱，自动加入运行列表（待启动），稍后再开始运行": "Tạo hộp thư tạm, tự động thêm vào danh sách chạy (chờ khởi động), sau đó mới bắt đầu chạy",
  "待启动，选中后点击“开始运行”即可加入队列": "Chờ khởi động — chọn rồi bấm “Bắt đầu chạy” để vào hàng đợi",
  "停止全部": "Dừng tất cả",
  "批量下载": "Tải hàng loạt",
  "上传到 Sub2API": "Tải lên Sub2API",
  "导出原始信息": "Xuất thông tin gốc",
  "批量重新授权": "Ủy quyền lại hàng loạt",
  "批量重新登录并授权": "Đăng nhập & ủy quyền lại hàng loạt",
  "批量强制浏览器验证": "Buộc xác minh qua trình duyệt hàng loạt",
  "批量设置 2FA": "Đặt 2FA hàng loạt",
  "批量添加密码": "Thêm mật khẩu hàng loạt",
  "批量删除": "Xóa hàng loạt",

  // Table headers
  "选择当前页全部任务": "Chọn tất cả tác vụ ở trang này",
  "账号": "Tài khoản",
  "状态": "Trạng thái",
  "当前操作": "Thao tác hiện tại",
  "开始时间": "Thời gian bắt đầu",
  "最近操作时间": "Thao tác gần nhất",
  "操作": "Thao tác",

  // Pagination
  "任务分页": "Phân trang tác vụ",
  "上一页": "Trang trước",
  "下一页": "Trang sau",
  "第 {0} / {1} 页": "Trang {0} / {1}",

  // SMS settings modal
  "配置保存在当前浏览器": "Cấu hình lưu trong trình duyệt này",
  "选择接码平台": "Chọn nền tảng nhận mã",
  "正在查询实时价格...": "Đang truy vấn giá thời gian thực...",
  "请先查询实时价格": "Hãy truy vấn giá thời gian thực trước",
  "查询中": "Đang truy vấn",
  "查询价格": "Truy vấn giá",
  "查询服务": "Truy vấn dịch vụ",
  "余额": "Số dư",
  "一次查询即可加载平台、国家、运营商和价格": "Một lần truy vấn sẽ tải nền tảng, quốc gia, nhà mạng và giá",
  "{0} 个国家可用": "{0} quốc gia khả dụng",
  "查询服务后选择平台": "Truy vấn dịch vụ trước rồi chọn nền tảng",
  "搜索平台": "Tìm nền tảng",
  "没有匹配的平台": "Không tìm thấy nền tảng phù hợp",
  "查询服务后选择国家": "Truy vấn dịch vụ trước rồi chọn quốc gia",
  "搜索国家、区号或代码": "Tìm quốc gia, mã vùng hoặc mã quốc gia",
  "没有匹配的国家": "Không tìm thấy quốc gia phù hợp",
  "该平台暂无可用国家": "Nền tảng này hiện không có quốc gia khả dụng",
  "选择国家后显示运营商": "Chọn quốc gia để hiển thị nhà mạng",
  "选择国家后显示价格": "Chọn quốc gia để hiển thị giá",
  "{0} 起": "từ {0}",
  "还有 {0} 项，请输入关键字筛选": "Còn {0} mục nữa, hãy nhập từ khóa để lọc",
  "当前没有可用的服务": "Hiện không có dịch vụ nào khả dụng",
  "SMSBower 国家与价格": "Quốc gia và giá SMSBower",
  "取消": "Hủy",
  "保存配置": "Lưu cấu hình",

  // Mail request modal
  "邮件 API 请求配置": "Cấu hình yêu cầu Email API",
  "配置保存在当前浏览器，请求内容不会写入任务日志":
    "Cấu hình lưu trong trình duyệt này; nội dung yêu cầu không ghi vào log tác vụ",
  "邮件 API 请求方式": "Phương thức yêu cầu Email API",
  "统一 POST 请求 URL": "URL yêu cầu POST chung",
  "必填": "Bắt buộc",
  "每个账号自己的请求体请在批量添加账号时一并导入":
    "Phần thân yêu cầu riêng của từng tài khoản hãy nhập kèm khi thêm hàng loạt",
  "请求头 JSON": "Header yêu cầu (JSON)",

  // Sub2API settings modal
  "Sub2API 配置": "Cấu hình Sub2API",
  "管理员 Key 不写入任务文件或日志；启用监控后由本机服务保存":
    "API Key quản trị không ghi vào file/log tác vụ; khi bật giám sát sẽ do dịch vụ máy này lưu",
  "Sub2API 后端地址": "Địa chỉ backend Sub2API",
  "例如 http://127.0.0.1:8080": "Ví dụ http://127.0.0.1:8080",
  "每 5 分钟监控异常账号": "Giám sát tài khoản lỗi mỗi 5 phút",
  "只自动处理上次完整登录未人工输入密码、邮箱码或登录 2FA 的任务":
    "Chỉ tự xử lý tác vụ mà lần đăng nhập đủ trước đó không nhập tay mật khẩu, mã email hay 2FA",
  "管理员 API Key": "API Key quản trị",
  "输入 sub2api 管理员 API Key": "Nhập API Key quản trị sub2api",
  "目标号池（可多选）": "Pool đích (chọn nhiều)",
  "目标号池": "Pool đích",
  "暂无可选号池": "Chưa có pool nào để chọn",
  "号池选择操作": "Thao tác chọn pool",
  "全选": "Chọn hết",
  "清空": "Xóa hết",
  "使用账号原配置": "Dùng cấu hình gốc của tài khoản",
  "Codex 指纹收敛": "Hội tụ vân tay Codex",
  "关闭（透传）": "Tắt (truyền thẳng)",
  "仅设备": "Chỉ thiết bị",
  "设备+会话（推荐）": "Thiết bị + phiên (khuyên dùng)",
  "完全收敛": "Hội tụ hoàn toàn",
  "并发数": "Số luồng đồng thời",
  "留空使用账号原值": "Để trống thì giữ giá trị gốc",
  "负载因子": "Hệ số tải",
  "优先级": "Độ ưu tiên",
  "允许使用的模型": "Các model được phép dùng",
  "每行一个模型，也支持逗号分隔，例如：\ngpt-5\ngpt-5-mini\ngpt-4.1":
    "Mỗi dòng một model, hoặc phân tách bằng dấu phẩy, ví dụ:\ngpt-5\ngpt-5-mini\ngpt-4.1",
  "分组为空时，上传使用 Sub2API 默认号池，监控检查全部 OpenAI 账号；选择分组后只监控这些号池。Codex 指纹收敛会写入每个上传或巡检更新的 OpenAI OAuth 账号。":
    "Khi không chọn pool: tải lên dùng pool mặc định của Sub2API và giám sát kiểm tra toàn bộ tài khoản OpenAI; chọn pool thì chỉ giám sát các pool đó. Hội tụ vân tay Codex sẽ ghi vào mỗi tài khoản OpenAI OAuth khi tải lên hoặc khi giám sát cập nhật.",
  "上次巡检失败：{0}": "Lần kiểm tra trước thất bại: {0}",
  "尚未执行号池巡检": "Chưa thực hiện kiểm tra pool",
  "读取配置": "Đọc cấu hình",
  "立即检查": "Kiểm tra ngay",

  // Batch add modal
  "批量添加账号": "Thêm tài khoản hàng loạt",
  "{0} 条，超出并发上限后自动排队": "{0} dòng, vượt giới hạn đồng thời sẽ tự xếp hàng",
  "每行：邮箱----编码请求体，或 邮箱----密码----编码请求体；邮箱及可识别字段顺序不限":
    "Mỗi dòng: email----thân_yêu_cầu, hoặc email----mật_khẩu----thân_yêu_cầu; thứ tự các trường tùy ý",
  "每行一个账号：自动识别邮箱、密码、邮件 API 和 2FA，字段顺序不限":
    "Mỗi dòng một tài khoản: tự nhận diện email, mật khẩu, Email API và 2FA, thứ tự tùy ý",
  "创建 {0} 条任务": "Tạo {0} tác vụ",
  "a@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9\nb@example.com----账号密码----mailbox_id%3Did-b":
    "a@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9\nb@example.com----mật_khẩu----mailbox_id%3Did-b",
  "name@icloud.com----https://mail.example/messages/name\nhttps://mail.example/messages/name2|账号密码|name2@example.co.uk|BASE32二步验证密钥\nBASE32二步验证密钥::name3@example.dev::账号密码":
    "name@icloud.com----https://mail.example/messages/name\nhttps://mail.example/messages/name2|mật_khẩu|name2@example.co.uk|khóa_2FA_BASE32\nkhóa_2FA_BASE32::name3@example.dev::mật_khẩu",

  // Filter modal
  "{0} 个邮箱": "{0} email",
  "每行输入一个完整邮箱地址": "Mỗi dòng một địa chỉ email đầy đủ",
  "应用筛选": "Áp dụng bộ lọc",

  // Danh sách email — account-created filter & bulk select
  "全部": "Tất cả",
  "未创建": "Chưa tạo",
  "已创建": "Đã tạo",
  "已停用": "Đã vô hiệu hóa",
  "{0} 秒后从列表移除": "Xóa khỏi danh sách sau {0} giây",
  "按邮箱搜索任务": "Tìm tác vụ theo email",
  "搜索邮箱": "Tìm kiếm email",
  "搜索": "Tìm kiếm",
  "清除搜索": "Xóa tìm kiếm",
  "找到 {0} 条": "Tìm thấy {0} tác vụ",
  "{0} 个邮箱，找到 {1} 条": "{0} email, tìm thấy {1} tác vụ",
  "{0} 个邮箱没有任务": "{0} email chưa có tác vụ",
  "每个手机号最多使用次数": "Số lần dùng tối đa mỗi số điện thoại",
  "0 = 不限制使用次数；被风控的号码始终跳过；记录保存在服务器，不使用浏览器存储": "0 = không giới hạn lần dùng. Số bị cơ chế rủi ro luôn bị tránh. Lưu trên máy chủ, không dùng localStorage.",
  "已记录 {0} 个号码 · {1} 个被风控拦截 · 共 {2} 次使用": "Đã ghi {0} số · {1} số bị chặn (rủi ro) · {2} lượt dùng",
  "使用次数上限必须是 0 到 1000 的整数": "Số lần dùng tối đa phải là số nguyên từ 0 đến 1000",
  "已建号": "Đã tạo TK",
  "全选（{0}）": "Chọn tất cả ({0})",
  " · 步骤 4 活跃 {0}": " · Bước 4 hoạt động {0}",
  "补打 ChatGPT Team 标签": "Gắn tag ChatGPT Team",
  "停用未建号邮箱（{0}）": "Vô hiệu hoá email chưa tạo TK ({0})",
  "没有需要补打标签的邮箱": "Không có email nào cần gắn tag",
  "没有需要停用的邮箱": "Không có email nào cần vô hiệu hoá",
  "将为 {0} 个无标签邮箱补打「ChatGPT Team」标签，确认？": "Sẽ gắn tag \"ChatGPT Team\" cho {0} email chưa có tag, xác nhận?",
  "将停用 {0} 个有 ChatGPT Team 标签但未在步骤 4 的邮箱，确认？": "Sẽ vô hiệu hoá {0} email có tag ChatGPT Team nhưng không có tác vụ trong bước 4, xác nhận?",

  // Email API row + "Tạo email" / "Danh sách email" popups
  "创建邮箱": "Tạo email",
  "邮箱列表": "Danh sách email",
  "已创建 {0} 个邮箱 — 选择加入列表或复制": "Đã tạo {0} email — chọn đưa vào danh sách hoặc copy",
  "创建临时邮箱，查看列表后加入批量添加框": "Tạo hộp thư tạm, xem danh sách rồi đưa vào ô thêm hàng loạt",
  "根域名": "Domain gốc",
  "子域名": "Subdomain",
  "(不使用子域名)": "(không dùng subdomain)",
  "数量（1–50）": "Số lượng (1–50)",
  "标签（可选）": "Tag (tuỳ chọn)",
  "将创建于：": "Sẽ tạo trên:",
  "标签": "tag",
  "创建 {0} 个邮箱": "Tạo {0} email",
  "个邮箱，域名": "email trên",
  "{0} 个错误": "{0} lỗi",
  "继续创建": "Tạo thêm",
  "复制邮箱": "Copy email",
  "加入批量添加": "Đưa vào Thêm hàng loạt",
  "加入批量添加（{0}）": "Đưa vào Thêm hàng loạt ({0})",
  "加载中…": "Đang tải…",
  "{0}/{1} 个邮箱": "{0}/{1} hộp thư",
  " · 已选 {0}": " · đã chọn {0}",
  "已选 {0}/{1}": "Đã chọn {0}/{1}",
  "移除": "Xoá",
  "刷新": "Tải lại",
  "按邮箱、标签、类型搜索…": "Tìm theo email, tag, loại…",
  "取消选择": "Bỏ chọn",
  "选择全部": "Chọn tất cả",
  "暂无邮箱": "Không có hộp thư nào",
  "(已锁定)": "(đã khoá)",
  "最后邮件：{0}": "Thư cuối: {0}",
  "尚无邮件": "Chưa có thư",
  "暂无邮件": "chưa có thư",
  "删除邮箱": "Xoá hộp thư",
  "已选 {0}": "Đã chọn {0}",
  "尚未选择邮箱": "Chưa chọn hộp thư nào",
  "应用域名": "Domain áp dụng",
  "用于“创建邮箱”和“邮箱列表” · 留空 = 全部": "cho “Tạo email” & “Danh sách email” · bỏ trống = tất cả",
  "未获取到域名列表（需连接邮件 API）。": "Chưa lấy được danh sách domain (cần kết nối API email).",
  "永久删除邮箱 {0}？无法撤销。": "Xoá vĩnh viễn hộp thư {0}? Không thể hoàn tác.",
  "请选择域名": "Chọn domain",
  "格式": "Định dạng",
  "将 proxy host:port:user:pass 转为正确格式的 URL（socks5h/http）": "Chuyển proxy host:port:user:pass sang URL đúng định dạng (socks5h/http)",

  // Empty state
  "没有匹配账号": "Không có tài khoản khớp",
  "暂无授权任务": "Chưa có tác vụ ủy quyền",
  "当前筛选邮箱不在任务列表中。": "Email đang lọc không có trong danh sách tác vụ.",
  "在右上方输入邮箱地址开始登录。": "Nhập email ở góc trên bên phải để bắt đầu.",

  // JobRow
  "选择 {0}": "Chọn {0}",
  "号池监控已永久跳过：{0}": "Giám sát pool đã bỏ qua vĩnh viễn: {0}",
  "账号已不可用": "Tài khoản không còn dùng được",
  "2FA：{0}": "2FA: {0}",
  "添加密码：{0}": "Thêm mật khẩu: {0}",
  "当前手机号：": "Số điện thoại hiện tại: ",
  "2FA 密钥": "Khóa 2FA",
  "复制 2FA 密钥": "Sao chép khóa 2FA",
  "重发": "Gửi lại",
  "换号": "Đổi số",
  "已重发 {0} 次": "Đã gửi lại {0} lần",
  "使用 {0} 取号": "Lấy số bằng {0}",
  "请先完成接码平台配置": "Hãy cấu hình nền tảng nhận mã trước",
  "平台": "Nền tảng",
  "{0}取号": "Lấy số {0}",
  "下载": "Tải xuống",
  "上传": "Tải lên",
  "上传到已配置的 Sub2API 号池": "Tải lên pool Sub2API đã cấu hình",
  "已上传 Sub2API": "Đã tải lên Sub2API",
  "已于 {0} 上传到 Sub2API{1}": "Đã tải lên Sub2API lúc {0}{1}",
  "同步已上传标记": "Đồng bộ dấu đã tải lên",
  "对照后端账号，为已上传过的账号补打标记": "Đối chiếu tài khoản trên backend để gắn dấu cho các tài khoản đã tải lên trước đó",
  "已为 {0} 个账号补打「已上传」标记": "Đã gắn dấu « đã tải lên » cho {0} tài khoản",
  "，{0} 个此前已标记": ", {0} tài khoản đã có dấu từ trước",
  "（后端共 {0} 个账号）": " (backend có tổng {0} tài khoản)",
  "重新授权：优先使用刷新令牌，失效后自动重新登录": "Ủy quyền lại: ưu tiên refresh token, hết hạn thì tự đăng nhập lại",
  "重新授权": "Ủy quyền lại",
  "跳过刷新令牌和旧检查点，完整重新登录后自动授权":
    "Bỏ qua refresh token và checkpoint cũ, đăng nhập lại đầy đủ rồi tự ủy quyền",
  "重新登录并授权": "Đăng nhập lại & ủy quyền",
  "强制浏览器验证": "Buộc xác minh qua trình duyệt",
  "跳过策略（含 {0} 天刷新规则），强制启动浏览器完整验证流程":
    "Bỏ qua policy (gồm quy tắc refresh {0} ngày), ép mở trình duyệt chạy xác minh đầy đủ",
  "跳过策略（含 60 天刷新规则），强制启动浏览器完整验证流程":
    "Bỏ qua policy (gồm quy tắc refresh 60 ngày), ép mở trình duyệt chạy xác minh đầy đủ",
  "设置 2FA": "Đặt 2FA",
  "添加密码": "Thêm mật khẩu",
  "手动重试": "Thử lại thủ công",
  "继续流程": "Tiếp tục",
  "收起日志": "Thu gọn log",
  "查看日志": "Xem log",
  "取消任务": "Hủy tác vụ",
  "确定为该账号生成并添加随机强密码吗？成功后会自动更新账号原始信息。":
    "Tạo và thêm mật khẩu mạnh ngẫu nhiên cho tài khoản này? Thành công sẽ tự cập nhật thông tin gốc.",
  "无法自动复制，请手动选择 2FA 密钥": "Không thể tự sao chép, hãy tự chọn khóa 2FA",
  "下载失败": "Tải xuống thất bại",

  // Batch action confirmations / notices
  "确定为选中的 {0} 个账号设置 2FA 吗？": "Đặt 2FA cho {0} tài khoản đã chọn?",
  "另有 {0} 个账号不符合条件，将自动跳过。": "Còn {0} tài khoản không đủ điều kiện sẽ tự bỏ qua.",
  "已开始为 {0} 个账号设置 2FA": "Đã bắt đầu đặt 2FA cho {0} tài khoản",
  "，跳过 {0} 个": ", bỏ qua {0}",
  "确定为选中的 {0} 个无密码账号生成并添加随机强密码吗？":
    "Tạo và thêm mật khẩu mạnh ngẫu nhiên cho {0} tài khoản chưa có mật khẩu?",
  "另有 {0} 个账号已有密码或不符合条件，将自动跳过。":
    "Còn {0} tài khoản đã có mật khẩu hoặc không đủ điều kiện sẽ tự bỏ qua.",
  "已开始为 {0} 个账号添加密码": "Đã bắt đầu thêm mật khẩu cho {0} tài khoản",
  "确定让选中的 {0} 个账号跳过刷新令牌，重新登录并授权吗？":
    "Cho {0} tài khoản đã chọn bỏ qua refresh token, đăng nhập lại và ủy quyền?",
  "另有 {0} 个进行中账号将自动跳过。": "Còn {0} tài khoản đang chạy sẽ tự bỏ qua.",
  "已开始重新登录并授权 {0} 个账号": "Đã bắt đầu đăng nhập lại và ủy quyền {0} tài khoản",
  "确定对选中的 {0} 个账号强制浏览器验证吗？将忽略刷新令牌策略（含年龄 60 天规则）。":
    "Buộc xác minh qua trình duyệt {0} tài khoản đã chọn? Sẽ bỏ qua policy refresh (gồm quy tắc tuổi 60 ngày).",
  "已开始强制浏览器验证 {0} 个账号": "Đã bắt đầu xác minh qua trình duyệt {0} tài khoản",
  "已标记强制浏览器验证，下一次刷新/再授权会打开浏览器":
    "Đã đánh dấu buộc xác minh qua trình duyệt — lần refresh/ủy quyền tới sẽ mở trình duyệt",
  "账号来自外部导入，始终走浏览器验证":
    "Tài khoản nhập từ ngoài — luôn xác minh qua trình duyệt",
  "账号年龄 {0}/{1} 天 — 下一次刷新仍使用浏览器全量验证":
    "Tuổi tài khoản {0}/{1} ngày — lần refresh tới vẫn dùng trình duyệt xác minh đầy đủ",
  "账号年龄 {0} 天 ≥ {1} 天 — 下一次刷新使用 TLS 刷新令牌":
    "Tuổi tài khoản {0} ngày ≥ {1} ngày — lần refresh tới dùng TLS refresh token",
  "强制浏览器": "Buộc trình duyệt",
  "外部导入 · 浏览器": "Nhập ngoài · trình duyệt",
  "浏览器 ({0}/{1}d)": "Trình duyệt ({0}/{1}d)",
  "TLS 刷新": "TLS refresh",
  "确定删除选中的 {0} 条任务吗？对应的本地授权文件也会被删除。":
    "Xóa {0} tác vụ đã chọn? File ủy quyền cục bộ tương ứng cũng bị xóa.",
  "确定停止全部 {0} 条进行中和排队任务吗？": "Dừng toàn bộ {0} tác vụ đang chạy và đang chờ?",
  "已上传 {0} 条": "Đã tải lên {0}",
  "，失败 {0} 条": ", lỗi {0}",
  "，跳过未完成任务 {0} 条": ", bỏ qua {0} tác vụ chưa xong",
  "批量下载失败": "Tải hàng loạt thất bại",
  "原始信息导出失败": "Xuất thông tin gốc thất bại",
  "请先配置 Sub2API 后端地址、管理员 API Key 和目标号池":
    "Hãy cấu hình địa chỉ backend Sub2API, API Key quản trị và pool đích trước",

  // Sub2API save validation
  "请输入 http:// 或 https:// 开头的 Sub2API 后端地址":
    "Hãy nhập địa chỉ backend Sub2API bắt đầu bằng http:// hoặc https://",
  "请输入 Sub2API 管理员 API Key": "Hãy nhập API Key quản trị Sub2API",
  "请先填写 API Key": "Hãy nhập API Key trước",
  "当前没有可购买的国家号码": "Hiện không có số quốc gia nào để mua",
  "请选择接码平台": "Hãy chọn nền tảng nhận mã",
  "请填写{0}": "Hãy nhập {0}",

  // JobLogs
  "正在读取日志...": "Đang đọc log...",
  "暂无日志": "Chưa có log",
  "日志读取失败：{0}": "Đọc log thất bại: {0}",
  "协议日志": "Log giao thức",

  // StatusBadge
  "启动中": "Đang khởi động",
  "处理中": "Đang xử lý",
  "待密码": "Chờ mật khẩu",
  "待 2FA": "Chờ 2FA",
  "准备 2FA": "Chuẩn bị 2FA",
  "准备密码": "Chuẩn bị mật khẩu",
  "激活 2FA": "Kích hoạt 2FA",
  "待邮箱码": "Chờ mã email",
  "待手机号": "Chờ số điện thoại",
  "待手机码": "Chờ mã SMS",
  "生成中": "Đang tạo",
  "刷新授权": "Làm mới ủy quyền",
  "失败": "Thất bại",
  "已取消": "Đã hủy",
  "待重新授权": "Chờ ủy quyền lại",
  "可继续": "Có thể tiếp tục",
  "代理连接失败": "Lỗi kết nối proxy",

  // Proxy connection error + change proxy
  "代理连接失败，请更换代理": "Proxy lỗi kết nối, vui lòng đổi proxy",
  "代理连接失败：{0} 无法连接": "Lỗi kết nối proxy: {0} không kết nối được",
  "从系统代理池中选择一个未使用过的代理替换失败的代理": "Chọn một proxy chưa từng dùng trong kho proxy của hệ thống để thay proxy bị lỗi",
  "重新连接": "Kết nối lại",
  "重新测试并使用原代理继续登录，适用于代理只是临时断开的情况": "Kiểm tra lại và dùng chính proxy cũ để tiếp tục đăng nhập — phù hợp khi proxy chỉ tạm thời mất kết nối",
  "更换代理": "Đổi proxy",
  "失败代理：{0}。请选择一个未使用过的代理。": "Proxy lỗi: {0}. Hãy chọn một proxy chưa từng dùng.",
  "请从系统代理池中选择一个未使用过的代理": "Hãy chọn một proxy chưa từng dùng trong kho proxy của hệ thống",
  "将代理导入系统代理池": "Nạp proxy vào kho proxy của hệ thống",
  "导入": "Nạp",
  "选择": "Chọn",
  "代理池中没有未使用过的代理，请先在上方导入": "Kho proxy không còn proxy chưa dùng, hãy nạp thêm ở trên",
  "该代理线路曾被使用，但当前没有账号在用。确认要重复使用吗？": "Proxy này đã từng được dùng nhưng hiện không còn tài khoản nào dùng. Xác nhận dùng lại?",
  "代理已更换，但同步到 Sub2API 失败：{0}": "Đã đổi proxy, nhưng đồng bộ lên Sub2API thất bại: {0}",

  // Per-IP registration limit
  "代理 IP 注册名额已满，已自动取消该任务": "IP proxy đã đủ lượt đăng ký, đã tự động huỷ tác vụ này",
  "已自动取消 {0} 个账号：所在代理 IP 的注册名额已满": "Đã tự động huỷ {0} tài khoản: IP proxy đã đủ lượt đăng ký",

  // LoginMethodBadge
  "密码": "Mật khẩu",
  "自动收码": "Tự nhận mã",
  "自动收码 + 2FA": "Tự nhận mã + 2FA",
  "旧任务资料未记录": "Tác vụ cũ chưa lưu thông tin",
  "邮箱码 + 2FA": "Mã email + 2FA",

  // getInputConfig
  "输入账号密码": "Nhập mật khẩu tài khoản",
  "提交密码": "Gửi mật khẩu",
  "6 位 2FA 验证码": "Mã 2FA 6 số",
  "提交 2FA 验证码": "Gửi mã 2FA",
  "新 2FA 的 6 位验证码": "Mã 6 số của 2FA mới",
  "激活新的 2FA": "Kích hoạt 2FA mới",
  "6 位邮箱验证码": "Mã email 6 số",
  "提交邮箱验证码": "Gửi mã email",
  "发送手机验证码": "Gửi mã SMS",
  "{0} 的验证码": "Mã của {0}",
  "手机验证码": "Mã SMS",
  "提交手机验证码": "Gửi mã SMS",

  // smsStatusText
  "{0}：{1}": "{0}: {1}",
  "{0}：正在获取手机号": "{0}: đang lấy số điện thoại",
  "{0}：已获取手机号，正在发送验证码": "{0}: đã lấy số, đang gửi mã",
  "{0}：验证码已发送，正在等待短信": "{0}: đã gửi mã, đang chờ SMS",
  "{0}：已收到验证码，正在自动提交": "{0}: đã nhận mã, đang tự gửi",
  "{0}：验证码已自动提交": "{0}: đã tự gửi mã",
  "{0}：已停止自动读取，正在验证手动输入的验证码": "{0}: đã dừng đọc tự động, đang xác minh mã nhập tay",
  "{0}：手机验证已通过，订单已完成": "{0}: đã xác minh số, đơn đã xong",
  "{0}：处理中": "{0}: đang xử lý",

  // formatMonitorResult
  "号池巡检已完成": "Đã kiểm tra pool xong",
  "检查 {0} 条异常记录": "Kiểm tra {0} bản ghi lỗi",
  "已启动自动修复 {0} 条": "Đã tự sửa {0}",
  "已更新 {0} 条": "Đã cập nhật {0}",
  "永久跳过 {0} 条": "Bỏ qua vĩnh viễn {0}",
  "需人工 {0} 条": "Cần thủ công {0}",
  "已停止调度 {0} 条": "Đã ngừng điều phối {0}",
  "本地无任务 {0} 条": "Không có tác vụ cục bộ {0}",
  "正在运行 {0} 条": "Đang chạy {0}",
  "冷却中 {0} 条": "Đang chờ nguội {0}",

  // formatRelativeMonitorTime
  "刚刚检查": "Vừa kiểm tra",
  "{0} 分钟前检查": "Kiểm tra {0} phút trước",
  "{0} 小时前检查": "Kiểm tra {0} giờ trước",

  // operationLabel
  "首次授权": "Ủy quyền lần đầu",
  "号池自动重登并授权": "Pool tự đăng nhập lại & ủy quyền",
  "继续中断流程": "Tiếp tục quy trình bị gián đoạn",
  "更新账号资料": "Cập nhật thông tin tài khoản",
  "更新代理 IP": "Cập nhật proxy IP",
  "账号操作": "Thao tác tài khoản",

  // parseEmailFilter
  "请至少输入一个筛选邮箱": "Hãy nhập ít nhất một email để lọc",
  "一次最多筛选 500 个邮箱": "Tối đa 500 email mỗi lần lọc",
  "第 {0} 行邮箱格式错误": "Email dòng {0} sai định dạng",

  // buildMailRequestConfig
  "请求头必须是有效的 JSON 对象": "Header phải là một đối tượng JSON hợp lệ",
  "请求头必须是 JSON 对象，例如 {\"Authorization\":\"Bearer ...\"}":
    "Header phải là đối tượng JSON, ví dụ {\"Authorization\":\"Bearer ...\"}",
  "POST 模式必须填写有效的 HTTP 或 HTTPS 请求 URL": "Chế độ POST phải nhập URL HTTP hoặc HTTPS hợp lệ",

  // formatMailRequestSummary
  "已配置统一 URL · ": "Đã cấu hình URL chung · ",
  "{0} 个请求头": "{0} header",
  "配置需要检查": "Cần kiểm tra cấu hình",

  // formatSub2ApiProxy
  "地址未知": "Địa chỉ không rõ",
  "代理 {0}": "Proxy {0}",
  "{0} | 出口 IP：{1}": "{0} | IP ra: {1}",

  // inspectCustomSmsEntries
  "请粘贴至少一条手机号和接码 API": "Hãy dán ít nhất một số điện thoại và API nhận mã",
  "自定义接码一次最多导入 500 条": "Nhận mã tùy chỉnh tối đa 500 dòng mỗi lần",
  "第 {0} 行格式错误，请使用 手机号----接码API": "Dòng {0} sai định dạng, hãy dùng số_điện_thoại----API_nhận_mã",
  "第 {0} 行手机号必须使用 +861871291167 这种国际格式": "Số ở dòng {0} phải theo định dạng quốc tế như +84987654321",
  "第 {0} 行接码 API 必须是有效的 HTTP 或 HTTPS 地址": "API nhận mã ở dòng {0} phải là địa chỉ HTTP hoặc HTTPS hợp lệ",

  // formatSmsCountryName / price
  "国家 {0}": "Quốc gia {0}",
  "{0} | 价格 {1} | 库存 {2}": "{0} | Giá {1} | Kho {2}",

  // misc
  "请求失败：HTTP {0}": "Yêu cầu thất bại: HTTP {0}",
  "任务 {0}": "Tác vụ {0}",
  "已选 {0} 个": "Đã chọn {0}",
  "{0} 个号码": "{0} số",

  // SMS provider external links
  "点击获取 API 密钥": "Bấm để lấy API Key",

  // Language switcher
  "语言": "Ngôn ngữ",
};

// UI strings win over server strings when both define the same key.
const DICTS = { vi: { ...SERVER_VI, ...VI } };
const FRAGMENTS = { vi: SERVER_VI_FRAGMENTS };
