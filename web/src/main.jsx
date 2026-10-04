import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  EyeOff,
  FileText,
  Filter,
  Globe2,
  KeyRound,
  Languages,
  List,
  ListPlus,
  LoaderCircle,
  Network,
  LogIn,
  Mail,
  Play,
  Search,
  MailCheck,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  PhoneIncoming,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";
import { t, tf, ts, tsLines, LANGS, getLang, setActiveLang, readInitialLang, persistLang, currentLocale, regionLabel } from "./i18n.js";
import * as settingsStore from "./settings-store.js";

const POLL_INTERVAL_MS = 900;
const LUBAN_API_KEY_STORAGE_KEY = "chatgpt-onboarding.luban-api-key";
const LUBAN_SERVICE_ID_STORAGE_KEY = "chatgpt-onboarding.luban-service-id";
const SMS_PROVIDER_SETTINGS_KEY = "chatgpt-onboarding.sms-provider-settings-v1";
const MAIL_REQUEST_SETTINGS_KEY = "chatgpt-onboarding.mail-request-settings-v1";
const SUB2API_UPLOAD_SETTINGS_KEY = "chatgpt-onboarding.sub2api-upload-settings-v1";
const ACCOUNT_PROXY_STORAGE_KEY = "chatgpt-onboarding.account-proxy-v1";
const USE_MACHINE_IP_STORAGE_KEY = "chatgpt-onboarding.use-machine-ip-v1";
const PROXY_LINK_CONFIG_KEY = "chatgpt-onboarding.proxy-link-config-v1";
// `proxies` = pool proxy dùng chung (mọi domain). `domainProxies` = các nhóm
// proxy gán riêng cho 1 domain: [{ domain, proxies }]. Khi đăng ký, email thuộc
// domain nào sẽ dùng proxy riêng của domain đó trước, hết chỗ mới mượn pool chung.
const DEFAULT_PROXY_LINK_CONFIG = { mode: "single", proxies: "", domainProxies: [], limitPerIp: 15, maxPerMinute: 2 };
const SMS_PROVIDER_EXTERNAL_LINKS = {
  luban: {
    href: "https://lubansms.com/",
    label: "点击获取 API 密钥",
  },
  smsbower: {
    href: "https://smsbower.app/cabinet/profile",
    label: "点击获取 API 密钥",
  },
  smscode: {
    href: "https://smscode.gg/dashboard",
    label: "点击获取 API 密钥",
  },
};
function App() {
  const [token, setToken] = useState("");
  const [features, setFeatures] = useState({});
  const [jobs, setJobs] = useState([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [batchUnchecked, setBatchUnchecked] = useState(() => new Set()); // dòng bị bỏ chọn trong ô "Thêm hàng loạt"; còn lại sẽ chạy khi tạo tác vụ
  const [filterOpen, setFilterOpen] = useState(false);
  const [emailSearch, setEmailSearch] = useState("");   // applied quick-search term (server-side, all pages)
  const [emailSearchDraft, setEmailSearchDraft] = useState(""); // the search input's current text
  const [bulkSearchInfo, setBulkSearchInfo] = useState({ count: 0, missing: [] }); // set when the search holds several emails
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState("");
  const [emailFilter, setEmailFilter] = useState([]);
  const [error, setError] = useState("");
  const [expandedJobId, setExpandedJobId] = useState(null);
  const [selectedJobIds, setSelectedJobIds] = useState(() => new Set());
  const [jobSelectionIndex, setJobSelectionIndex] = useState([]);
  const [batchAction, setBatchAction] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [stats, setStats] = useState({ active: 0, queued: 0, completed: 0 });
  const [smsSettings, setSmsSettings] = useState(readSmsProviderSettings);
  const [smsSettingsOpen, setSmsSettingsOpen] = useState(false);
  const [smsSettingsDraft, setSmsSettingsDraft] = useState(readSmsProviderSettings);
  const [smsSettingsError, setSmsSettingsError] = useState("");
  // Per-number reuse cap + ledger stats — stored on the server (not localStorage).
  const [phoneMaxUses, setPhoneMaxUses] = useState("1");
  const [phoneUsageStats, setPhoneUsageStats] = useState(null); // { maxUses, totalNumbers, blocked, totalUses }
  const [smsNumberOptions, setSmsNumberOptions] = useState([]);
  const [smsOptionsLoading, setSmsOptionsLoading] = useState(false);
  const [smsBalance, setSmsBalance] = useState(null);
  const [smsCodeCatalog, setSmsCodeCatalog] = useState(null); // SMSCode: { balance, platforms, platformId, countries, countryId, operators:[{value,label,tiers,defaultTier}] }
  const [smsCatalog, setSmsCatalog] = useState(null); // SMSBower: { title, serviceCode, countries:[{code,title,positions:[...]}] }
  const [smsCountryQuery, setSmsCountryQuery] = useState(""); // filter text for the SMSBower country dropdown
  const [smsCountryOpen, setSmsCountryOpen] = useState(false); // open state of the searchable country dropdown
  const [mailRequestSettings, setMailRequestSettings] = useState(readMailRequestSettings);
  const [mailRequestSettingsDraft, setMailRequestSettingsDraft] = useState(readMailRequestSettings);
  const [mailRequestSettingsOpen, setMailRequestSettingsOpen] = useState(false);
  const [mailRequestSettingsError, setMailRequestSettingsError] = useState("");
  const [mailRequestSettingsSaving, setMailRequestSettingsSaving] = useState(false);
  const [mailApiReady, setMailApiReady] = useState(false); // true khi backend đọc được API email (có key + gọi /domains ok)
  // "Tạo email" — native temp-mail creation (domain gốc → subdomain → số lượng → tag).
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [mailRoots, setMailRoots] = useState([]);
  const [createRoot, setCreateRoot] = useState("");
  const [createSub, setCreateSub] = useState("");
  const [createCount, setCreateCount] = useState(10);
  const [createTag, setCreateTag] = useState("ChatGPT Team");
  const [createResult, setCreateResult] = useState(null); // { boxes, errors, domain, tag } after a create
  const [createUnchecked, setCreateUnchecked] = useState(() => new Set()); // email bỏ chọn trong kết quả tạo email
  // "Danh sách email" — list existing mailboxes, filter by tag, copy / push to batch.
  const [listOpen, setListOpen] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [mailboxes, setMailboxes] = useState([]);
  const [listTag, setListTag] = useState(null); // null = tất cả; UNTAGGED = chưa gắn tag; ngược lại là tên tag
  const [listAccountFilter, setListAccountFilter] = useState(null); // null = tất cả; "created" = đã tạo TK; "uncreated" = chưa tạo TK
  const [listSearch, setListSearch] = useState("");
  const [listSelected, setListSelected] = useState(() => new Set());
  const [listDeleting, setListDeleting] = useState("");
  const [listCounts, setListCounts] = useState({ totalInStep4: 0, totalActiveStable: 0, totalDeactivated: 0, totalUncreated: 0 });
  const [listTagging, setListTagging] = useState(false); // bulk-tagging untagged emails
  const [listDeactivating, setListDeactivating] = useState(false); // deactivating orphan emails
  const [sub2apiSettings, setSub2apiSettings] = useState(readSub2ApiSettings);
  const [sub2apiSettingsDraft, setSub2apiSettingsDraft] = useState(readSub2ApiSettings);
  const [sub2apiGroups, setSub2apiGroups] = useState([]);
  const [sub2apiProxies, setSub2apiProxies] = useState([]);
  const [sub2apiSettingsOpen, setSub2apiSettingsOpen] = useState(false);
  const [sub2apiSettingsError, setSub2apiSettingsError] = useState("");
  const [sub2apiGroupsLoading, setSub2apiGroupsLoading] = useState(false);
  const [sub2apiSettingsSaving, setSub2apiSettingsSaving] = useState(false);
  const [sub2apiMonitorChecking, setSub2apiMonitorChecking] = useState(false);
  const [sub2apiBackfilling, setSub2apiBackfilling] = useState(false);
  const [sub2apiMonitorStatus, setSub2apiMonitorStatus] = useState({
    configured: false,
    enabled: false,
    running: false,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
    intervalMinutes: 5,
  });
  const [uploadNotice, setUploadNotice] = useState("");
  const [accountProxyUrl, setAccountProxyUrl] = useState(() => readLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY));
  const [useMachineIp, setUseMachineIp] = useState(() => readLocalTextSetting(USE_MACHINE_IP_STORAGE_KEY) === "1");
  const [machineIp, setMachineIp] = useState("");
  const [machineIpBusy, setMachineIpBusy] = useState(false);
  const [proxyCheck, setProxyCheck] = useState({ state: "idle", ip: "", url: "" }); // state: idle|checking|ok|fail
  const [proxyLinkConfig, setProxyLinkConfig] = useState(() => {
    try {
      const stored = JSON.parse(settingsStore.getItem(PROXY_LINK_CONFIG_KEY) || "null");
      return { ...DEFAULT_PROXY_LINK_CONFIG, ...(stored && typeof stored === "object" ? stored : {}) };
    } catch {
      return { ...DEFAULT_PROXY_LINK_CONFIG };
    }
  });
  const [proxyLinkOpen, setProxyLinkOpen] = useState(false);
  // "Danh sách proxy IP" — quản lý proxy, email đã đăng ký, trạng thái kết nối.
  const [proxyListOpen, setProxyListOpen] = useState(false);
  const [proxyListBusy, setProxyListBusy] = useState(false);
  const [proxyListError, setProxyListError] = useState("");
  const [proxyStatus, setProxyStatus] = useState(null); // { limitPerIp, activeCount, totalCount, remaining, proxies:[...] }
  const [proxyExpanded, setProxyExpanded] = useState(() => new Set()); // proxy labels whose email list is expanded
  const [proxyBulkText, setProxyBulkText] = useState(""); // dán nhanh danh sách proxy để nhận diện HTTP/SOCKS5
  const [proxyFilter, setProxyFilter] = useState(null); // null=tất cả · "unused" · "inuse" · "used"
  const [domainApplyBusy, setDomainApplyBusy] = useState(false);
  const [domainApplyNotice, setDomainApplyNotice] = useState(""); // kết quả đổi proxy cho tài khoản cũ
  const [lang, setLang] = useState(readInitialLang);
  setActiveLang(lang);

  useEffect(() => {
    persistLang(lang);
    try {
      document.documentElement.lang = lang === "vi" ? "vi" : "zh-CN";
      document.title = t("ChatGPT 账号授权控制台");
    } catch {}
  }, [lang]);
  useEffect(() => writeLocalJson(SMS_PROVIDER_SETTINGS_KEY, smsSettings), [smsSettings]);
  useEffect(() => writeLocalJson(MAIL_REQUEST_SETTINGS_KEY, mailRequestSettings), [mailRequestSettings]);
  useEffect(() => writeLocalJson(SUB2API_UPLOAD_SETTINGS_KEY, sub2apiSettings), [sub2apiSettings]);
  useEffect(() => writeLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY, accountProxyUrl.trim()), [accountProxyUrl]);
  useEffect(() => writeLocalTextSetting(USE_MACHINE_IP_STORAGE_KEY, useMachineIp ? "1" : ""), [useMachineIp]);
  useEffect(() => writeLocalJson(PROXY_LINK_CONFIG_KEY, proxyLinkConfig), [proxyLinkConfig]);
  // Gộp pool chung + mọi nhóm proxy riêng theo domain thành 1 khối text để hiển
  // thị/thống kê trong "Danh sách proxy IP" (đếm, kiểm tra kết nối, round-robin).
  const combinedProxiesText = useMemo(() => {
    const parts = [normalizeProxyText(proxyLinkConfig.proxies || "")];
    for (const g of proxyLinkConfig.domainProxies || []) if (g?.proxies) parts.push(normalizeProxyText(g.proxies, g.protocol || "socks5h"));
    return parts.filter((p) => p.trim()).join("\n");
  }, [proxyLinkConfig.proxies, proxyLinkConfig.domainProxies]);
  // Map host -> domain (để gắn nhãn domain cho từng dòng proxy trong bảng).
  const proxyDomainByHost = useMemo(() => {
    const map = new Map();
    for (const g of proxyLinkConfig.domainProxies || []) {
      if (!g?.domain || !g?.proxies) continue;
      for (const e of parseProxyPasteList(g.proxies)) map.set(e.host, g.domain);
    }
    return map;
  }, [proxyLinkConfig.domainProxies]);
  // Proxy đã gán riêng cho domain là ĐỘC QUYỀN → tự gỡ host đó khỏi pool chung
  // để không còn dùng chung ("không dùng IP cũ nữa"). Guard tránh vòng lặp set.
  useEffect(() => {
    const domainHosts = new Set();
    for (const g of proxyLinkConfig.domainProxies || []) {
      if (!g?.proxies) continue;
      for (const e of parseProxyPasteList(g.proxies)) domainHosts.add(e.host);
    }
    if (!domainHosts.size) return;
    setProxyLinkConfig((c) => {
      const lines = String(c.proxies || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const kept = lines.filter((line) => {
        const e = parseProxyPasteList(line)[0];
        return !e || !domainHosts.has(e.host);
      });
      if (kept.length === lines.length) return c;
      return { ...c, proxies: kept.join("\n") };
    });
  }, [proxyLinkConfig.domainProxies]);

  async function loadMachineIp() {
    if (!token) return;
    setMachineIpBusy(true);
    try {
      const data = await apiFetch(token, "/api/machine-ip");
      setMachineIp(data.ip || "");
    } catch {
      setMachineIp("");
    } finally {
      setMachineIpBusy(false);
    }
  }
  function chooseMachineIp() {
    setAccountProxyUrl("");
    setUseMachineIp(true);
    void loadMachineIp();
  }
  useEffect(() => {
    if (useMachineIp && token && !machineIp && !machineIpBusy) void loadMachineIp();
  }, [useMachineIp, token]);

  // When a proxy is entered, test it and show its exit IP so the user sees it connects.
  useEffect(() => {
    const url = accountProxyUrl.trim();
    if (useMachineIp || !url || !url.includes("://") || !token) {
      setProxyCheck({ state: "idle", ip: "", url: "" });
      return undefined;
    }
    let cancelled = false;
    setProxyCheck({ state: "checking", ip: "", url });
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch(token, "/api/proxy-check", { method: "POST", body: JSON.stringify({ proxyUrl: url }) });
        if (!cancelled) setProxyCheck({ state: "ok", ip: data.ip || "", url });
      } catch {
        if (!cancelled) setProxyCheck({ state: "fail", ip: "", url });
      }
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accountProxyUrl, useMachineIp, token]);

  // ---- "Danh sách proxy IP": trạng thái kết nối + email đã đăng ký theo từng IP ----
  async function fetchProxyStatus({ silent, refresh } = {}) {
    if (!token) return;
    if (!silent) { setProxyListBusy(true); setProxyListError(""); }
    try {
      // "Danh sách proxy IP" luôn quản lý danh sách IP (batch), độc lập với chế độ đang chọn.
      // refresh=true buộc đo lại exit IP; polling định kỳ dùng cache để chỉ làm
      // mới số lần đăng ký theo thời gian thực mà không đo mạng liên tục.
      const data = await apiFetch(token, "/api/proxies/status", {
        method: "POST",
        body: JSON.stringify({
          mode: "batch",
          proxies: combinedProxiesText,
          limitPerIp: Number(proxyLinkConfig.limitPerIp) || 15,
          refresh: Boolean(refresh),
        }),
      });
      setProxyStatus(data);
    } catch (requestError) {
      if (!silent) setProxyListError(requestError.message);
    } finally {
      if (!silent) setProxyListBusy(false);
    }
  }
  function openProxyList() {
    setProxyListError("");
    setProxyExpanded(new Set());
    setProxyBulkText("");
    setProxyFilter(null);
    setProxyListOpen(true); // effect bên dưới sẽ tự lấy trạng thái theo danh sách proxy
  }
  // Xoá 1 proxy khỏi danh sách cấu hình theo IP (host). Chỉ áp dụng proxy đang cấu hình.
  function removeProxy(host) {
    setProxyLinkConfig((c) => {
      const lines = String(c.proxies || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const kept = lines.filter((line) => {
        const e = parseProxyPasteList(line)[0];
        return !e || e.host !== host;
      });
      return { ...c, proxies: kept.join("\n") };
    });
  }
  // "Quên IP này": ẩn 1 IP cũ (configured:false) khỏi danh sách. Không xoá job/account,
  // chỉ ẩn dòng (lưu server). Thêm lại IP vào cấu hình sẽ hiện lại.
  async function forgetProxy(host) {
    if (!token || !host) return;
    try {
      await apiFetch(token, "/api/proxies/forget", {
        method: "POST",
        body: JSON.stringify({ host, forget: true }),
      });
      await fetchProxyStatus({ silent: true });
    } catch (requestError) {
      setProxyListError(requestError.message);
    }
  }
  async function copyProxyEmails(emails) {
    const text = (emails || []).join("\n");
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch {}
  }
  function toggleProxyEmails(label) {
    setProxyExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }
  // "kind": "socks5" | "http" | "all" — lấy các dòng khớp giao thức và thêm vào danh sách.
  function addBulkProxies(kind) {
    const entries = parseProxyPasteList(proxyBulkText);
    const forced = kind === "socks5" ? "socks5h" : kind === "http" ? "http" : null;
    // Nút SOCKS5/HTTP nhận cả dòng khớp giao thức LẪN dòng chưa rõ (ambiguous) và ép theo nút.
    // "Thêm tất cả" giữ giao thức đã nhận diện.
    const picked = forced
      ? entries.filter((e) => e.ambiguous || e.protocol === forced)
      : entries;
    if (!picked.length) return;
    let added = 0;
    setProxyLinkConfig((c) => {
      const lines = String(c.proxies || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // Mỗi IP (host) chỉ được thêm 1 lần — tránh 1 IP dùng cả HTTP lẫn SOCKS5.
      const existingHosts = new Set(parseProxyPasteList(lines.join("\n")).map((e) => e.host));
      for (const e of picked) {
        if (existingHosts.has(e.host)) continue;
        existingHosts.add(e.host);
        const scheme = forced || e.protocol;
        const auth = e.user ? `${e.user}:${e.pass}@` : "";
        lines.push(`${scheme}://${auth}${e.host}:${e.port}`);
        added += 1;
      }
      // Chỉ cập nhật danh sách proxy, KHÔNG đổi chế độ — chế độ chỉ đổi trong "Cấu hình".
      return { ...c, proxies: lines.join("\n") };
    });
    if (added) setProxyBulkText(""); // effect theo dõi proxyLinkConfig.proxies sẽ tự làm mới bảng
  }
  // ---- Proxy riêng theo domain: thêm/sửa/xoá các nhóm { domain, proxies } ----
  function addDomainProxyGroup() {
    setProxyLinkConfig((c) => ({ ...c, domainProxies: [...(c.domainProxies || []), { domain: "", protocol: "socks5h", proxies: "" }] }));
  }
  function updateDomainProxyGroup(index, field, value) {
    setProxyLinkConfig((c) => {
      const groups = [...(c.domainProxies || [])];
      if (!groups[index]) return c;
      groups[index] = { ...groups[index], [field]: value };
      return { ...c, domainProxies: groups };
    });
  }
  function removeDomainProxyGroup(index) {
    setProxyLinkConfig((c) => ({ ...c, domainProxies: (c.domainProxies || []).filter((_, i) => i !== index) }));
  }
  // Áp dụng gán domain cho các tài khoản đã có: đổi proxy cho tài khoản đang dùng
  // proxy nay đã thành độc quyền của domain khác. Chỉ đổi tài khoản không đang chạy.
  async function applyDomainProxies() {
    if (!token || domainApplyBusy) return;
    setDomainApplyBusy(true);
    setDomainApplyNotice("");
    try {
      const domainProxies = (proxyLinkConfig.domainProxies || [])
        .map((g) => ({ domain: String(g?.domain || "").trim(), proxies: normalizeProxyText(g?.proxies || "", g?.protocol || "socks5h") }))
        .filter((g) => g.domain && g.proxies.trim());
      const data = await apiFetch(token, "/api/proxies/apply-domains", {
        method: "POST",
        body: JSON.stringify({
          proxies: normalizeProxyText(proxyLinkConfig.proxies || ""),
          domainProxies,
          limitPerIp: Number(proxyLinkConfig.limitPerIp) || 15,
        }),
      });
      setDomainApplyNotice(tf("已为 {0} 个账号更换代理（跳过运行中 {1} · 无可用代理 {2}）", data.reassigned || 0, data.skippedRunning || 0, data.noProxy || 0));
      void fetchProxyStatus({ silent: true });
    } catch (requestError) {
      setDomainApplyNotice(requestError.message);
    } finally {
      setDomainApplyBusy(false);
    }
  }
  // Khi popup "Danh sách proxy IP" đang mở: tự lấy trạng thái theo danh sách hiện tại
  // (mọi chế độ), và làm mới mỗi khi danh sách / giới hạn đổi.
  useEffect(() => {
    if (!proxyListOpen || !token) return undefined;
    const timer = setTimeout(() => { void fetchProxyStatus({ silent: Boolean(proxyStatus) }); }, 250);
    return () => clearTimeout(timer);
  }, [proxyListOpen, combinedProxiesText, proxyLinkConfig.limitPerIp, token]);
  // Real-time refresh of the registration counts while the popup is open: poll
  // every 3s (silent). The server caches the exit-IP probe, so this mainly
  // recomputes "còn N lần đăng ký" as accounts reach the SMS step.
  useEffect(() => {
    if (!proxyListOpen || !token) return undefined;
    const interval = setInterval(() => { void fetchProxyStatus({ silent: true }); }, 3_000);
    return () => clearInterval(interval);
  }, [proxyListOpen, combinedProxiesText, proxyLinkConfig.limitPerIp, token]);
  // Nếu 2 proxy có cùng IP xuất (một bản nhập bằng IP, một bản nhập bằng domain),
  // tự thay thế: giữ bản domain, bỏ bản nhập bằng IP thô.
  useEffect(() => {
    if (!proxyStatus || !Array.isArray(proxyStatus.proxies)) return;
    const isDomain = (host) => /[a-z]/i.test(String(host || ""));
    const byExit = new Map();
    for (const p of proxyStatus.proxies) {
      if (!p.configured || !p.connected || !p.ip) continue;
      if (!byExit.has(p.ip)) byExit.set(p.ip, []);
      byExit.get(p.ip).push(p);
    }
    const removeHosts = new Set();
    for (const group of byExit.values()) {
      if (group.length < 2 || !group.some((p) => isDomain(p.host))) continue;
      for (const p of group) if (!isDomain(p.host)) removeHosts.add(p.host);
    }
    if (!removeHosts.size) return;
    setProxyLinkConfig((c) => {
      const lines = String(c.proxies || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const kept = lines.filter((line) => {
        const e = parseProxyPasteList(line)[0];
        return !e || !removeHosts.has(e.host);
      });
      return { ...c, proxies: kept.join("\n") };
    });
  }, [proxyStatus]);
  // Ở chế độ "nhiều IP": tự động (debounce) lấy trạng thái để ô tóm tắt trên thanh công cụ hiển thị số IP hoạt động.
  useEffect(() => {
    if (!token || proxyLinkConfig.mode !== "batch") return undefined;
    if (!parseProxyPasteList(combinedProxiesText).length) { setProxyStatus(null); return undefined; }
    const timer = setTimeout(() => { void fetchProxyStatus({ silent: true }); }, 1000);
    return () => clearTimeout(timer);
  }, [proxyLinkConfig.mode, combinedProxiesText, proxyLinkConfig.limitPerIp, token]);

  useEffect(() => {
    let stopped = false;
    fetch("/api/bootstrap")
      .then(readResponse)
      .then((data) => {
        if (!stopped) {
          setToken(data.token);
          setFeatures(data.features || {});
        }
      })
      .catch((requestError) => setError(requestError.message));
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    void apiFetch(token, "/api/mail-request-config", {
      method: "POST",
      body: JSON.stringify({ config: buildMailRequestConfig(mailRequestSettings) }),
    }).catch((requestError) => setError(requestError.message));
  }, [token]);

  // Kiểm tra API email đã kết nối chưa để chỉ hiện "Tạo email" / "Danh sách email" khi sẵn sàng.
  useEffect(() => {
    if (!token) { setMailApiReady(false); return undefined; }
    let stopped = false;
    apiFetch(token, "/api/mail/domains")
      .then((data) => {
        if (stopped) return;
        setMailApiReady(Boolean(data.available && data.keyPresent));
        if (Array.isArray(data.roots)) setMailRoots(data.roots);
      })
      .catch(() => { if (!stopped) setMailApiReady(false); });
    return () => { stopped = true; };
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const data = (emailFilter.length || emailSearch.trim())
          ? await apiFetch(token, "/api/jobs/query", {
              method: "POST",
              body: JSON.stringify({ page, emails: emailFilter, search: emailSearch.trim() }),
            })
          : await apiFetch(token, `/api/jobs?page=${page}`);
        if (!stopped) {
          setJobs(data.jobs);
          setJobSelectionIndex(data.selection || data.jobs);
          setPagination(data.pagination || { page, pageSize: 20, total: data.jobs.length, totalPages: 1 });
          setStats(data.stats || { active: 0, queued: 0, completed: 0 });
          setBulkSearchInfo({ count: data.filter?.searchEmails || 0, missing: data.filter?.missing || [] });
          if (data.pagination?.page && data.pagination.page !== page) setPage(data.pagination.page);
          setError("");
        }
      } catch (requestError) {
        if (!stopped) setError(requestError.message);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [token, page, emailFilter, emailSearch]);

  useEffect(() => {
    if (!token || !features.sub2apiMonitor) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, "/api/sub2api/monitor");
        if (!stopped) {
          setSub2apiMonitorStatus(data);
          setSub2apiSettings((current) => ({ ...current, monitorEnabled: Boolean(data.enabled) }));
        }
      } catch {}
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [token, features.sub2apiMonitor]);

  const pageJobIds = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const smsProviderDefinitions = Array.isArray(features.smsProviders) ? features.smsProviders : [];
  const activeSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettings),
    [smsProviderDefinitions, smsSettings, lang],
  );
  const draftSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft),
    [smsProviderDefinitions, smsSettingsDraft, lang],
  );
  const smsCodePlatformItems = useMemo(
    () => (smsCodeCatalog?.platforms || []).map((platform) => ({
      value: platform.value,
      text: platform.label,
      search: platform.label.toLowerCase(),
    })),
    [smsCodeCatalog],
  );
  const smsCodeCountryItems = useMemo(
    () => (smsCodeCatalog?.countries || []).map((country) => ({
      value: country.value,
      text: formatSmsCodeCountry(country),
      search: `${country.label} ${country.code} ${country.dialCode}`.toLowerCase(),
    })),
    [smsCodeCatalog, lang],
  );
  const selectedJobs = useMemo(
    () => jobSelectionIndex.filter((job) => selectedJobIds.has(job.id)),
    [jobSelectionIndex, selectedJobIds],
  );
  const downloadableSelectedCount = selectedJobs.filter((job) => job.canDownload).length;
  const allPageSelected = pageJobIds.length > 0 && pageJobIds.every((id) => selectedJobIds.has(id));
  const canDownloadSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && downloadableSelectedCount > 0;
  const canReauthorizeSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && selectedJobs.every((job) => job.canRegenerate || job.canRetry);
  const forceReloginSelectedCount = selectedJobs.filter((job) => job.canForceRelogin).length;
  const canForceReloginSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && forceReloginSelectedCount > 0;
  const canUploadSelected = selectedJobs.length > 0 && downloadableSelectedCount > 0;
  const totpSetupSelectedCount = selectedJobs.filter((job) => job.canSetupTotp).length;
  const canSetupTotpSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && totpSetupSelectedCount > 0;
  const passwordAddSelectedCount = selectedJobs.filter((job) => job.canAddPassword).length;
  const canAddPasswordSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && passwordAddSelectedCount > 0;
  const startableSelectedCount = selectedJobs.filter((job) => job.canStart).length;
  const canStartSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && startableSelectedCount > 0;

  async function openSmsSettings() {
    const draft = withSmsProviderDefaults(smsProviderDefinitions, smsSettings);
    setSmsSettingsDraft(draft);
    setSmsSettingsError("");
    setSmsCodeCatalog(null);
    setSmsSettingsOpen(true);
    if (token) {
      try {
        const data = await apiFetch(token, "/api/sms/number-usage");
        setPhoneUsageStats(data);
        setPhoneMaxUses(String(data.maxUses ?? 1));
      } catch { /* keep last known value */ }
    }
  }

  function openMailRequestSettings() {
    setMailRequestSettingsDraft({ ...mailRequestSettings });
    setMailRequestSettingsError("");
    setMailRequestSettingsOpen(true);
  }

  async function saveMailRequestSettings(event) {
    event.preventDefault();
    let config;
    try {
      config = buildMailRequestConfig(mailRequestSettingsDraft);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
      return;
    }
    setMailRequestSettingsSaving(true);
    setMailRequestSettingsError("");
    try {
      await apiFetch(token, "/api/mail-request-config", {
        method: "POST",
        body: JSON.stringify({ config }),
      });
      setMailRequestSettings(normalizeMailRequestSettings(mailRequestSettingsDraft));
      setMailRequestSettingsOpen(false);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
    } finally {
      setMailRequestSettingsSaving(false);
    }
  }

  function openSub2ApiSettings() {
    setSub2apiSettingsDraft({ ...sub2apiSettings, monitorEnabled: Boolean(sub2apiMonitorStatus.enabled) });
    setSub2apiSettingsError("");
    setSub2apiSettingsOpen(true);
  }

  async function loadSub2ApiOptions(settings = sub2apiSettingsDraft) {
    setSub2apiGroupsLoading(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/options", {
        method: "POST",
        body: JSON.stringify({ config: settings }),
      });
      setSub2apiGroups(Array.isArray(data.groups) ? data.groups : []);
      setSub2apiProxies(Array.isArray(data.proxies) ? data.proxies : []);
    } catch (requestError) {
      setSub2apiGroups([]);
      setSub2apiProxies([]);
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiGroupsLoading(false);
    }
  }

  async function saveSub2ApiSettings(event) {
    event.preventDefault();
    const baseUrl = String(sub2apiSettingsDraft.baseUrl || "").trim();
    const adminApiKey = String(sub2apiSettingsDraft.adminApiKey || "").trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      setSub2apiSettingsError(t("请输入 http:// 或 https:// 开头的 Sub2API 后端地址"));
      return;
    }
    if (!adminApiKey) {
      setSub2apiSettingsError(t("请输入 Sub2API 管理员 API Key"));
      return;
    }
    const nextSettings = {
      ...readSub2ApiSettings(sub2apiSettingsDraft),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      adminApiKey,
    };
    setSub2apiSettingsSaving(true);
    try {
      const monitor = await apiFetch(token, "/api/sub2api/monitor", {
        method: "POST",
        body: JSON.stringify({ enabled: nextSettings.monitorEnabled, config: nextSettings }),
      });
      setSub2apiSettings(nextSettings);
      setSub2apiMonitorStatus(monitor);
      setSub2apiSettingsOpen(false);
      setSub2apiSettingsError("");
    } catch (requestError) {
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiSettingsSaving(false);
    }
  }

  async function checkSub2ApiMonitorNow() {
    if (!sub2apiMonitorStatus.enabled || sub2apiMonitorChecking) return;
    setSub2apiMonitorChecking(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/monitor/check", { method: "POST" });
      setSub2apiMonitorStatus(data);
      setUploadNotice(formatMonitorResult(data.result));
      setError("");
    } catch (requestError) {
      if (sub2apiSettingsOpen) setSub2apiSettingsError(requestError.message);
      else setError(requestError.message);
    } finally {
      setSub2apiMonitorChecking(false);
    }
  }

  function setSub2ApiGroupChecked(groupId, checked) {
    setSub2apiSettingsDraft((current) => {
      const selected = new Set(current.groupIds);
      if (checked) selected.add(String(groupId));
      else selected.delete(String(groupId));
      return { ...current, groupIds: [...selected] };
    });
  }

  async function uploadSelected(ids) {
    if (!sub2apiSettings.baseUrl || !sub2apiSettings.adminApiKey) {
      openSub2ApiSettings();
      setUploadNotice(t("请先配置 Sub2API 后端地址、管理员 API Key 和目标号池"));
      return;
    }
    if (batchAction) return;
    setBatchAction("upload");
    setUploadNotice("");
    try {
      const data = await apiFetch(token, "/api/sub2api/upload", {
        method: "POST",
        body: JSON.stringify({ ids, config: sub2apiSettings, proxyLink: proxyLinkConfig }),
      });
      const result = data.result || {};
      const created = result.account_created ?? result.success ?? data.uploaded;
      const failed = result.account_failed ?? result.failed ?? 0;
      setUploadNotice(`${tf("已上传 {0} 条", created)}${failed ? tf("，失败 {0} 条", failed) : ""}${data.proxiesCreated ? tf("，创建代理 {0} 个", data.proxiesCreated) : ""}${data.unassigned ? tf("，{0} 条未分配代理", data.unassigned) : ""}${data.skipped ? tf("，跳过未完成任务 {0} 条", data.skipped) : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function backfillSub2ApiTags() {
    if (!sub2apiSettings.baseUrl || !sub2apiSettings.adminApiKey) {
      openSub2ApiSettings();
      setUploadNotice(t("请先配置 Sub2API 后端地址、管理员 API Key 和目标号池"));
      return;
    }
    if (sub2apiBackfilling) return;
    setSub2apiBackfilling(true);
    setUploadNotice("");
    try {
      const data = await apiFetch(token, "/api/sub2api/backfill-tags", {
        method: "POST",
        body: JSON.stringify({ config: sub2apiSettings }),
      });
      setUploadNotice(
        `${tf("已为 {0} 个账号补打「已上传」标记", data.tagged ?? 0)}`
        + `${data.alreadyTagged ? tf("，{0} 个此前已标记", data.alreadyTagged) : ""}`
        + `${tf("（后端共 {0} 个账号）", data.backendAccounts ?? 0)}`,
      );
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSub2apiBackfilling(false);
    }
  }

  async function loadSmsNumberOptions(settings = smsSettingsDraft) {
    const resolved = resolveSmsProvider(smsProviderDefinitions, settings);
    if (!resolved.definition?.optionsEndpoint) return;
    if (!String(resolved.config.apiKey || "").trim()) {
      setSmsSettingsError(t("请先填写 API Key"));
      return;
    }
    setSmsOptionsLoading(true);
    setSmsSettingsError("");
    try {
      const data = await apiFetch(token, resolved.definition.optionsEndpoint, {
        method: "POST",
        body: JSON.stringify({ config: resolved.config }),
      });
      if (resolved.id === "viotp") {
        const services = Array.isArray(data.options?.services) ? data.options.services : [];
        setSmsNumberOptions(services);
        setSmsBalance(data.options?.balance || null);
        if (services.length === 0) throw new Error(t("当前没有可用的服务"));
        const current = services.find((s) => s.value === resolved.config.serviceId)
          || services.find((s) => /openai|chatgpt/i.test(s.label))
          || services[0];
        updateSmsProviderConfig(resolved.id, {
          serviceId: current.value,
          serviceLabel: current.label,
        });
      } else if (resolved.id === "smscode") {
        const catalog = normalizeSmsCodeCatalog(data.options);
        if (catalog.platforms.length === 0) throw new Error(t("当前没有可用的服务"));
        setSmsCodeCatalog(catalog);
        updateSmsProviderConfig(resolved.id, pickSmsCodeSelection(catalog, resolved.config));
      } else {
        const options = Array.isArray(data.options) ? data.options : [];
        setSmsNumberOptions(options);
        const current = resolved.config.maxPrice
          ? options.find((option) => option.country === resolved.config.country) || options[0]
          : options[0];
        if (!current) throw new Error(t("当前没有可购买的国家号码"));
        updateSmsProviderConfig(resolved.id, {
          country: current.country,
          maxPrice: String(current.price),
          countryLabel: formatSmsCountryName(current),
        });
      }
    } catch (requestError) {
      setSmsNumberOptions([]);
      setSmsBalance(null);
      setSmsCodeCatalog(null);
      setSmsSettingsError(requestError.message);
    } finally {
      setSmsOptionsLoading(false);
    }
  }

  // SMSCode cascade: operators and prices belong to one platform + country, so a change of either queries again.
  function changeSmsCodeSelection(change) {
    const next = {
      ...smsSettingsDraft,
      configs: {
        ...(smsSettingsDraft.configs || {}),
        smscode: {
          ...(smsSettingsDraft.configs?.smscode || {}),
          // Everything below the changed level is derived again from the fresh catalog.
          countryLabel: "",
          catalogProductId: "",
          operatorId: "",
          operatorLabel: "",
          maxPriceIdr: "",
          maxPrice: "",
          serviceLabel: "",
          ...change,
        },
      },
    };
    setSmsSettingsDraft(next);
    setSmsCodeCatalog((catalog) => (catalog
      ? { ...catalog, operators: [], countries: "platformId" in change ? [] : catalog.countries }
      : catalog));
    loadSmsNumberOptions(next);
  }

  async function loadSmsCatalog() {
    setSmsOptionsLoading(true);
    setSmsSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sms-providers/smsbower/catalog?serviceId=247");
      setSmsCatalog(data && Array.isArray(data.countries) ? data : null);
    } catch (requestError) {
      setSmsCatalog(null);
      setSmsSettingsError(requestError.message);
    } finally {
      setSmsOptionsLoading(false);
    }
  }

  function selectSmsCountry(countryCode) {
    if (!smsCatalog) return;
    const country = smsCatalog.countries.find((c) => c.code === countryCode);
    if (!country) return;
    const best = country.positions[0]; // best quality/cheapest first
    updateSmsProviderConfig("smsbower", {
      service: smsCatalog.serviceCode || "dr",
      country: country.code,
      maxPrice: best ? String(best.price) : "",
      smsAgentId: best ? String(best.agentId) : "",
      countryLabel: best
        ? `${smsCatalog.title} · ${country.title} · ${best.rank} $${best.price}`
        : `${smsCatalog.title} · ${country.title}`,
    });
  }

  function selectSmsPosition(countryCode, agentId) {
    if (!smsCatalog) return;
    const country = smsCatalog.countries.find((c) => c.code === countryCode);
    const pos = country?.positions.find((p) => String(p.agentId) === String(agentId));
    if (!country || !pos) return;
    updateSmsProviderConfig("smsbower", {
      service: smsCatalog.serviceCode || "dr",
      country: country.code,
      maxPrice: String(pos.price),
      smsAgentId: String(pos.agentId),
      countryLabel: `${smsCatalog.title} · ${country.title} · ${pos.rank} $${pos.price}`,
    });
  }


  function updateSmsProviderConfig(providerId, values) {
    setSmsSettingsDraft((current) => ({
      ...current,
      configs: {
        ...(current.configs || {}),
        [providerId]: {
          ...(current.configs?.[providerId] || {}),
          ...values,
        },
      },
    }));
  }

  async function saveSmsSettings(event) {
    event.preventDefault();
    const resolved = resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft);
    if (!resolved.definition) {
      setSmsSettingsError(t("请选择接码平台"));
      return;
    }
    const missing = resolved.definition.fields.find((field) => (
      field.required !== false && !String(resolved.config[field.key] || "").trim()
    ));
    if (missing) {
      setSmsSettingsError(tf("请填写{0}", ts(missing.label)));
      return;
    }
    if (resolved.id === "custom") {
      const customEntries = inspectCustomSmsEntries(resolved.config.entries);
      if (customEntries.error) {
        setSmsSettingsError(customEntries.error);
        return;
      }
    }
    // Persist the per-number reuse cap on the server (not in the browser).
    const n = Number(phoneMaxUses);
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      setSmsSettingsError(t("使用次数上限必须是 0 到 1000 的整数"));
      return;
    }
    try {
      if (token) {
        const data = await apiFetch(token, "/api/sms/number-usage", { method: "POST", body: JSON.stringify({ maxUses: n }) });
        setPhoneUsageStats(data);
      }
    } catch (error) {
      setSmsSettingsError(error.message);
      return;
    }
    setSmsSettings(withSmsProviderDefaults(smsProviderDefinitions, smsSettingsDraft));
    setSmsSettingsOpen(false);
    setSmsSettingsError("");
  }

  useEffect(() => {
    const valid = new Set(jobSelectionIndex.map((job) => job.id));
    setSelectedJobIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [jobSelectionIndex]);

  useEffect(() => {
    setExpandedJobId(null);
  }, [page]);

  // Chế độ nhiều IP: gửi danh sách để backend tự gán IP kế tiếp (round-robin, theo giới hạn).
  // Chế độ 1 IP: gửi proxy đang nhập ở thanh công cụ.
  const proxyBatchMode = proxyLinkConfig.mode === "batch";
  function newJobProxyPayload() {
    return proxyBatchMode
      ? {
          proxyMode: "batch",
          proxies: normalizeProxyText(proxyLinkConfig.proxies),
          domainProxies: (proxyLinkConfig.domainProxies || [])
            .map((g) => ({ domain: String(g?.domain || "").trim(), proxies: normalizeProxyText(g?.proxies || "", g?.protocol || "socks5h") }))
            .filter((g) => g.domain && g.proxies.trim()),
          limitPerIp: Number(proxyLinkConfig.limitPerIp) || 15,
        }
      : { proxyUrl: accountProxyUrl.trim() };
  }
  // Với thao tác trên tài khoản đã có (cấp lại/đăng nhập lại…): ở chế độ nhiều IP giữ nguyên proxy đã gán.
  function reuseProxyPayload() {
    return proxyBatchMode ? {} : { proxyUrl: accountProxyUrl.trim() };
  }
  function ensureProxyReady(setErr) {
    if (proxyBatchMode) {
      if (!parseProxyPasteList(combinedProxiesText).length) { setErr(t("请先在“代理 IP 列表”中添加代理 IP")); return false; }
      return true;
    }
    if (!accountProxyUrl.trim() && !useMachineIp) { setErr(t("必须先配置代理 IP，或在“格式”里选择“本机 IP”")); return false; }
    return true;
  }

  async function createJob(event) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    if (!ensureProxyReady(setError)) return;
    setBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), ...newJobProxyPayload() }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs([data.job], current).slice(0, 20));
      setEmail("");
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  // Ô "Thêm hàng loạt" giữ nguyên là nguồn dữ liệu (textarea). Dưới nó liệt kê
  // từng dòng kèm ô tick: bỏ tick để loại khỏi lần chạy này, nút xoá để bỏ hẳn.
  const batchLines = useMemo(
    () => batchText.split(/\r?\n/).map((raw) => raw.trim()).filter(Boolean)
      .map((raw) => ({ raw, email: extractLineEmail(raw) })),
    [batchText],
  );
  // Còn được tick (không nằm trong batchUnchecked) = sẽ tạo tác vụ.
  const batchRunLines = useMemo(
    () => batchLines.filter((line) => !batchUnchecked.has(line.raw)),
    [batchLines, batchUnchecked],
  );
  const batchAllChecked = batchLines.length > 0 && batchRunLines.length === batchLines.length;

  function toggleBatchLine(raw) {
    setBatchUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(raw)) next.delete(raw); else next.add(raw);
      return next;
    });
  }

  function toggleAllBatchLines() {
    setBatchUnchecked((prev) => {
      // Đang chọn hết → bỏ chọn hết; ngược lại → chọn hết.
      if (!prev.size) return new Set(batchLines.map((line) => line.raw));
      return new Set();
    });
  }

  function removeBatchLine(raw) {
    setBatchText((prev) => prev.split(/\r?\n/).filter((line) => line.trim() !== raw).join("\n"));
    setBatchUnchecked((prev) => {
      if (!prev.has(raw)) return prev;
      const next = new Set(prev);
      next.delete(raw);
      return next;
    });
  }

  async function createBatch(event) {
    event.preventDefault();
    const runText = batchRunLines.map((line) => line.raw).join("\n");
    if (!runText.trim() || batchBusy) return;
    if (!ensureProxyReady(setBatchError)) return;
    setBatchBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs/batch", {
        method: "POST",
        body: JSON.stringify({ text: runText, ...newJobProxyPayload() }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs(data.jobs, current).slice(0, 20));
      // Chỉ tạo tác vụ cho dòng đã tick; dòng bỏ tick giữ lại trong ô để chạy sau.
      const ran = new Set(batchRunLines.map((line) => line.raw));
      const remaining = batchLines.filter((line) => !ran.has(line.raw)).map((line) => line.raw);
      setBatchText(remaining.join("\n"));
      setBatchUnchecked(new Set());
      setBatchError(data.canceled ? tf("已自动取消 {0} 个账号：所在代理 IP 的注册名额已满", data.canceled) : "");
      if (!remaining.length) setBatchOpen(false);
      setError("");
    } catch (requestError) {
      setBatchError(requestError.message);
    } finally {
      setBatchBusy(false);
    }
  }

  async function openCreateEmail() {
    setCreateError("");
    setCreateResult(null);
    setCreateOpen(true);
    try {
      const data = await apiFetch(token, "/api/mail/domains");
      const roots = data.roots || [];
      setMailRoots(roots);
      const scope = mailRequestSettings.domains || [];
      const allowed = scope.length ? roots.filter((r) => scope.includes(r.root)) : roots;
      setCreateRoot((prev) => {
        if (prev && allowed.some((r) => r.root === prev)) return prev;
        return (data.defaults || []).find((d) => allowed.some((r) => r.root === d)) || allowed[0]?.root || "";
      });
      setCreateSub("");
    } catch (requestError) {
      setCreateError(requestError.message);
    }
  }

  async function submitCreateEmail(event) {
    event.preventDefault();
    if (createBusy) return;
    const domain = createSub || createRoot;
    if (!domain) { setCreateError("请选择域名"); return; }
    setCreateBusy(true);
    try {
      const data = await apiFetch(token, "/api/mail/create", {
        method: "POST",
        body: JSON.stringify({ count: Number(createCount), domain, tag: createTag.trim() }),
      });
      // Only create the mailboxes and show them in the popup. Do NOT add them to the
      // step-4 task list here — the user pushes them to the batch box and presses
      // "Thêm tác vụ" to create tasks, as before.
      setCreateResult({ boxes: data.boxes || [], errors: data.errors || [], domain, tag: createTag.trim() });
      setCreateUnchecked(new Set());
      setError("");
    } catch (requestError) {
      setCreateError(requestError.message);
    } finally {
      setCreateBusy(false);
    }
  }

  function sendCreatedToBatch() {
    const checked = (createResult?.boxes || []).filter((box) => !createUnchecked.has(box.email));
    const lines = checked.map((box) => box.line).join("\n");
    if (!lines) return;
    setBatchText((prev) => (prev.trim() ? `${prev.trim()}\n${lines}` : lines));
    setCreateResult(null);
    setCreateOpen(false);
    setCreateUnchecked(new Set());
    setBatchError("");
    setBatchOpen(true);
  }

  async function copyCreatedEmails() {
    const checked = (createResult?.boxes || []).filter((box) => !createUnchecked.has(box.email));
    const text = checked.map((box) => box.email).join("\n");
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  // ---- "Danh sách email": xem/lọc/copy/đưa-vào-batch các mailbox đã tạo ----
  // Domain scope chọn trong Cấu hình (root domain allow-list); rỗng = tất cả. Lọc cả create lẫn list.
  const mailDomainScope = mailRequestSettings.domains || [];
  const mailInScope = (domain) => !mailDomainScope.length
    || mailDomainScope.some((r) => domain === r || String(domain).endsWith(`.${r}`));
  const scopedMailRoots = useMemo(
    () => (mailDomainScope.length ? mailRoots.filter((r) => mailDomainScope.includes(r.root)) : mailRoots),
    [mailRoots, mailRequestSettings.domains],
  );
  // Chỉ hiển thị hộp thư có tag ChatGPT; bỏ email không tag hoặc tag khác.
  const scopedMailboxes = useMemo(
    () => mailboxes.filter((m) => mailInScope(m.domain) && /chatgpt/i.test(m.tag || "")),
    [mailboxes, mailRequestSettings.domains],
  );

  // Đếm số email đã / chưa tạo tài khoản + đã vô hiệu hoá để hiện trên chip lọc.
  // Email vô hiệu hoá tách thành nhóm riêng, không tính vào đã tạo / chưa tạo.
  const deactivatedCount = useMemo(
    () => scopedMailboxes.filter((m) => m.deactivated).length,
    [scopedMailboxes],
  );
  const accountCreatedCount = useMemo(
    () => scopedMailboxes.filter((m) => m.accountCreated && !m.deactivated).length,
    [scopedMailboxes],
  );
  const accountFilterChips = useMemo(() => [
    { value: null, label: "全部", count: scopedMailboxes.length },
    { value: "uncreated", label: "未创建", count: scopedMailboxes.filter((m) => !m.accountCreated && !m.deactivated).length },
    { value: "created", label: "已创建", count: accountCreatedCount },
    { value: "deactivated", label: "已停用", count: deactivatedCount },
  ], [scopedMailboxes, accountCreatedCount, deactivatedCount]);

  const visibleMailboxes = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    const filtered = scopedMailboxes.filter((m) => {
      if (listTag !== null && (m.tag || UNTAGGED) !== listTag) return false;
      if (listAccountFilter === "created" && (!m.accountCreated || m.deactivated)) return false;
      if (listAccountFilter === "uncreated" && (m.accountCreated || m.deactivated)) return false;
      if (listAccountFilter === "deactivated" && !m.deactivated) return false;
      if (q && !`${m.email} ${m.tag || ""} ${m.category || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    // Email vô hiệu hoá luôn ở cuối, rồi tới email đã tạo tài khoản (giữ nguyên
    // thứ tự trong mỗi nhóm).
    return filtered
      .map((m, i) => [m, i])
      .sort(([a, ai], [b, bi]) => {
        if (a.deactivated !== b.deactivated) return a.deactivated ? 1 : -1;
        if (a.accountCreated !== b.accountCreated) return a.accountCreated ? 1 : -1;
        return ai - bi;
      })
      .map(([m]) => m);
  }, [scopedMailboxes, listTag, listAccountFilter, listSearch]);

  const allVisibleSelected = visibleMailboxes.length > 0 && visibleMailboxes.every((m) => listSelected.has(m.email));

  async function openMailboxList() {
    setListError("");
    setListSelected(new Set());
    setListSearch("");
    setListTag(null);
    setListAccountFilter(null);
    setListOpen(true);
    setListBusy(true);
    try {
      const data = await apiFetch(token, "/api/mail/mailboxes");
      setMailboxes(data.mailboxes || []);
      setListCounts({
        totalInStep4: data.totalInStep4 ?? 0,
        totalActiveStable: data.totalActiveStable ?? 0,
        totalDeactivated: data.totalDeactivated ?? 0,
        totalUncreated: data.totalUncreated ?? 0,
      });
    } catch (requestError) {
      setListError(requestError.message);
    } finally {
      setListBusy(false);
    }
  }

  function toggleMailbox(mailboxEmail) {
    setListSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mailboxEmail)) next.delete(mailboxEmail); else next.add(mailboxEmail);
      return next;
    });
  }

  function toggleAllVisible() {
    const emails = visibleMailboxes.map((m) => m.email);
    setListSelected((prev) => {
      const next = new Set(prev);
      if (emails.every((emailAddr) => next.has(emailAddr))) {
        for (const emailAddr of emails) next.delete(emailAddr);
      } else {
        for (const emailAddr of emails) next.add(emailAddr);
      }
      return next;
    });
  }

  function selectedMailboxes() {
    return mailboxes.filter((m) => listSelected.has(m.email));
  }

  async function copySelectedMailboxes() {
    const text = selectedMailboxes().map((m) => m.email).join("\n");
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  function sendSelectedToBatch() {
    const lines = selectedMailboxes().map((m) => m.line).join("\n");
    if (!lines) return;
    setBatchText((prev) => (prev.trim() ? `${prev.trim()}\n${lines}` : lines));
    setListOpen(false);
    setBatchError("");
    setBatchOpen(true);
  }

  async function deleteMailbox(mailboxEmail) {
    if (listDeleting) return;
    if (!window.confirm(tf("永久删除邮箱 {0}？无法撤销。", mailboxEmail))) return;
    setListDeleting(mailboxEmail);
    setListError("");
    try {
      await apiFetch(token, `/api/mail/mailbox?email=${encodeURIComponent(mailboxEmail)}`, { method: "DELETE" });
      setMailboxes((prev) => prev.filter((m) => m.email !== mailboxEmail));
      setListSelected((prev) => {
        const next = new Set(prev);
        next.delete(mailboxEmail);
        return next;
      });
    } catch (requestError) {
      setListError(requestError.message);
    } finally {
      setListDeleting("");
    }
  }

  async function batchTagUntagged() {
    const untagged = scopedMailboxes.filter((m) => !m.tag && !m.accountCreated && !m.deactivated);
    if (!untagged.length) { setListError(t("没有需要补打标签的邮箱")); return; }
    if (!window.confirm(tf("将为 {0} 个无标签邮箱补打「ChatGPT Team」标签，确认？", untagged.length))) return;
    setListTagging(true);
    setListError("");
    try {
      const data = await apiFetch(token, "/api/mail/batch-tag", {
        method: "POST",
        body: JSON.stringify({ emails: untagged.map((m) => m.email), tag: "ChatGPT Team" }),
      });
      setListError("");
      await openMailboxList();
    } catch (requestError) {
      setListError(requestError.message);
    } finally {
      setListTagging(false);
    }
  }

  async function deactivateOrphans() {
    const orphans = scopedMailboxes.filter((m) => !m.accountCreated && !m.deactivated);
    if (!orphans.length) { setListError(t("没有需要停用的邮箱")); return; }
    if (!window.confirm(tf("将停用 {0} 个有 ChatGPT Team 标签但未在步骤 4 的邮箱，确认？", orphans.length))) return;
    setListDeactivating(true);
    setListError("");
    try {
      await apiFetch(token, "/api/mail/deactivate-orphans", { method: "POST" });
      await openMailboxList();
    } catch (requestError) {
      setListError(requestError.message);
    } finally {
      setListDeactivating(false);
    }
  }

  function applyEmailFilter(event) {
    event.preventDefault();
    try {
      const emails = parseEmailFilter(filterText);
      setEmailFilter(emails);
      setSelectedJobIds(new Set());
      setExpandedJobId(null);
      setPage(1);
      setFilterError("");
      setFilterOpen(false);
    } catch (filterParseError) {
      setFilterError(filterParseError.message);
    }
  }

  function clearEmailFilter() {
    setEmailFilter([]);
    setFilterText("");
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
    setFilterError("");
  }

  function toggleJobSelection(jobId) {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      pageJobIds.forEach((id) => {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }

  async function downloadSelected() {
    if (!canDownloadSelected || batchAction) return;
    setBatchAction("download");
    try {
      const response = await fetch("/api/jobs/download-batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || t("批量下载失败"));
      await saveDownloadResponse(response, `sub2api-import-oauth-${downloadableSelectedCount}-accounts-${localTimestamp()}.json`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function startSelectedJobs() {
    if (!canStartSelected || batchAction) return;
    if (!ensureProxyReady(setError)) return;
    setBatchAction("start");
    try {
      const data = await apiFetch(token, "/api/jobs/start-batch", {
        method: "POST",
        body: JSON.stringify({
          ids: [...selectedJobIds],
          ...reuseProxyPayload(),
          // Chế độ nhiều IP: gửi giới hạn để server chặn theo số chỗ còn lại của IP.
          ...(proxyBatchMode ? { limitPerIp: Number(proxyLinkConfig.limitPerIp) || 15 } : {}),
        }),
      });
      setSelectedJobIds(new Set());
      setError(data.canceled ? tf("已自动取消 {0} 个账号：所在代理 IP 的注册名额已满", data.canceled) : "");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function reauthorizeSelected() {
    if (!canReauthorizeSelected || batchAction) return;
    setBatchAction("reauthorize");
    try {
      await apiFetch(token, "/api/jobs/reauthorize-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], ...reuseProxyPayload() }),
      });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function setupTotpSelected() {
    if (!canSetupTotpSelected || batchAction) return;
    const skipped = selectedJobIds.size - totpSetupSelectedCount;
    const message = `${tf("确定为选中的 {0} 个账号设置 2FA 吗？", totpSetupSelectedCount)}${skipped ? tf("另有 {0} 个账号不符合条件，将自动跳过。", skipped) : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("setup-2fa");
    try {
      const data = await apiFetch(token, "/api/jobs/setup-2fa-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], ...reuseProxyPayload() }),
      });
      setUploadNotice(`${tf("已开始为 {0} 个账号设置 2FA", data.started)}${data.skipped ? tf("，跳过 {0} 个", data.skipped) : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function addPasswordSelected() {
    if (!canAddPasswordSelected || batchAction) return;
    const skipped = selectedJobIds.size - passwordAddSelectedCount;
    const message = `${tf("确定为选中的 {0} 个无密码账号生成并添加随机强密码吗？", passwordAddSelectedCount)}${skipped ? tf("另有 {0} 个账号已有密码或不符合条件，将自动跳过。", skipped) : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("add-password");
    try {
      const data = await apiFetch(token, "/api/jobs/add-password-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], ...reuseProxyPayload() }),
      });
      setUploadNotice(`${tf("已开始为 {0} 个账号添加密码", data.started)}${data.skipped ? tf("，跳过 {0} 个", data.skipped) : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function forceReloginSelected() {
    if (!canForceReloginSelected || batchAction) return;
    const skipped = selectedJobIds.size - forceReloginSelectedCount;
    const message = `${tf("确定让选中的 {0} 个账号跳过刷新令牌，重新登录并授权吗？", forceReloginSelectedCount)}${skipped ? tf("另有 {0} 个进行中账号将自动跳过。", skipped) : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("relogin");
    try {
      const data = await apiFetch(token, "/api/jobs/relogin-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], ...reuseProxyPayload() }),
      });
      setUploadNotice(`${tf("已开始重新登录并授权 {0} 个账号", data.started)}${data.skipped ? tf("，跳过 {0} 个", data.skipped) : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function exportSelectedSource() {
    if (!selectedJobIds.size || batchAction) return;
    setBatchAction("source");
    try {
      const response = await fetch("/api/jobs/export-source", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || t("原始信息导出失败"));
      await saveDownloadResponse(response, `chatgpt-account-source-${selectedJobIds.size}-accounts-${localTimestamp()}.txt`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function deleteSelected() {
    if (!selectedJobIds.size || batchAction) return;
    if (!window.confirm(tf("确定删除选中的 {0} 条任务吗？对应的本地授权文件也会被删除。", selectedJobIds.size))) return;
    setBatchAction("delete");
    try {
      await apiFetch(token, "/api/jobs/delete-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setJobs((current) => current.filter((job) => !selectedJobIds.has(job.id)));
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function cancelAllRunningJobs() {
    const runningCount = (stats.active || 0) + (stats.queued || 0);
    if (!runningCount || batchAction) return;
    if (!window.confirm(tf("确定停止全部 {0} 条进行中和排队任务吗？", runningCount))) return;
    setBatchAction("cancel-all");
    try {
      await apiFetch(token, "/api/jobs/cancel-all", { method: "POST" });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><ShieldCheck size={21} strokeWidth={2.2} /></div>
          <div>
            <h1>{t("ChatGPT 账号授权控制台")}</h1>
            <p>{t("本地多任务协议登录")}</p>
          </div>
        </div>
        <div className="topbar-right">
          <div className="summary" aria-label={t("任务统计")}>
            <span><i className="status-dot idle" />{t("待启动")} <strong>{stats.idle || 0}</strong></span>
            <span><i className="status-dot active" />{t("进行中")} <strong>{stats.active}</strong></span>
            <span><i className="status-dot queued" />{t("排队中")} <strong>{stats.queued || 0}</strong></span>
            <span><i className="status-dot complete" />{t("已完成")} <strong>{stats.completed}</strong></span>
          </div>
          <div className="lang-switch" role="group" aria-label={t("语言")}>
            <Languages size={15} aria-hidden="true" />
            {Object.entries(LANGS).map(([code, label]) => (
              <button
                key={code}
                type="button"
                className={lang === code ? "active" : ""}
                onClick={() => setLang(code)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="workspace">
        {/* 第一步：准备工具 —— 代理、接码平台、邮件 API */}
        <div className="workflow-step">
          <div className="step-head">
            <span className="step-index">1</span>
            <div className="step-titles">
              <h3>{t("准备工具")}</h3>
              <p>{t("配置代理、接码平台与邮件 API")}</p>
            </div>
          </div>
          <div className="step-body">
            <div className="provider-toolbar account-proxy-toolbar" aria-label={t("代理 IP 配置")}>
              <div className="provider-heading"><Globe2 size={17} /><strong>{t("代理 IP")}</strong></div>
              {proxyLinkConfig.mode !== "batch" && (
                <div className="account-proxy-input" style={{ display: "flex", gap: 0, alignItems: "center", flex: "1 1 auto", minWidth: 0, maxWidth: "min(480px, 50vw)" }}>
                  <div className="proxy-fmt-dropdown" title={t("将 proxy host:port:user:pass 转为正确格式的 URL（socks5h/http）")}>
                    <span className="proxy-fmt-trigger">{useMachineIp ? t("本机 IP") : t("格式")} <ChevronDown size={13} /></span>
                    <div className="proxy-fmt-menu">
                      <button type="button" onClick={() => { setUseMachineIp(false); setAccountProxyUrl((v) => toProxyUrl(v, "socks5h")); }}>SOCKS5</button>
                      <button type="button" onClick={() => { setUseMachineIp(false); setAccountProxyUrl((v) => toProxyUrl(v, "http")); }}>HTTP</button>
                      <button type="button" onClick={chooseMachineIp}>{t("本机 IP")}</button>
                    </div>
                  </div>
                  <label className="provider-field account-proxy-field" style={{ flex: 1, minWidth: 0, width: "auto", borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: -1 }} title={t("支持 http://、https://、socks5:// 和 socks5h://；用户名中包含 -sid- 时会自动轮换会话编号")}>
                    <Globe2 size={15} aria-hidden="true" />
                    <input
                      value={useMachineIp ? (machineIpBusy ? t("正在获取本机 IP…") : (machineIp ? tf("本机 IP：{0}", machineIp) : t("本机 IP（无代理）"))) : accountProxyUrl}
                      onChange={(event) => { setUseMachineIp(false); setAccountProxyUrl(event.target.value); }}
                      placeholder={t("socks5h://用户名:密码@主机:端口")}
                      spellCheck="false"
                      aria-label={t("代理 IP 地址")}
                      readOnly={useMachineIp}
                      style={useMachineIp ? { cursor: "default" } : undefined}
                    />
                  </label>
                </div>
              )}
              {proxyLinkConfig.mode === "batch" ? (
                <span className={`provider-ready ${proxyStatus && proxyStatus.activeCount ? "" : "incomplete"}`} style={{ flex: "1 1 auto", minWidth: 0 }}>
                  {proxyStatus
                    ? (proxyStatus.activeCount ? <Check size={14} /> : <CircleAlert size={14} />)
                    : (combinedProxiesText.trim() ? <LoaderCircle className="spin" size={14} /> : <CircleAlert size={14} />)}
                  {proxyStatus
                    ? tf("{0} 个 IP 活跃 · 剩余约 {1} 次注册", proxyStatus.activeCount, proxyStatus.remaining)
                    : (combinedProxiesText.trim() ? t("批量模式 · 正在统计代理") : t("批量模式 · 请添加代理"))}
                </span>
              ) : (
                <span className={`provider-ready ${(useMachineIp || accountProxyUrl.trim()) && proxyCheck.state !== "fail" ? "" : "incomplete"}`}>
                  {useMachineIp
                    ? <Check size={14} />
                    : accountProxyUrl.trim()
                      ? (proxyCheck.state === "checking" ? <LoaderCircle className="spin" size={14} /> : proxyCheck.state === "fail" ? <CircleAlert size={14} /> : <Check size={14} />)
                      : <CircleAlert size={14} />}
                  {useMachineIp
                    ? (machineIp ? tf("使用本机网络 · IP {0}", machineIp) : t("使用本机网络（无代理）"))
                    : accountProxyUrl.trim()
                      ? (proxyCheck.state === "checking"
                          ? t("正在检测代理…")
                          : proxyCheck.state === "ok"
                            ? tf("代理已连接 · 出口 IP {0}", proxyCheck.ip)
                            : proxyCheck.state === "fail"
                              ? t("代理连接失败")
                              : t("已配置，按账号检测出口"))
                      : t("必须配置代理 IP，或选择“本机 IP”")}
                </span>
              )}
              <div className="mail-actions-group">
                <button type="button" className="secondary-button" onClick={openProxyList} disabled={!token}>
                  <List size={16} />{t("代理 IP 列表")}
                </button>
                <button type="button" className="secondary-button provider-settings-button" onClick={() => setProxyLinkOpen(true)}>
                  <Settings2 size={16} />{t("配置")}{proxyLinkConfig.mode === "batch" ? tf("（批量 · {0}/IP）", proxyLinkConfig.limitPerIp || 15) : ""}
                </button>
              </div>
            </div>

            <div className="provider-toolbar sms-provider-toolbar" aria-label={t("接码平台配置")}>
              <div className="provider-heading"><PhoneIncoming size={17} /><strong>{t("接码平台")}</strong></div>
              <span className="provider-name">{activeSmsProvider.name || t("未选择")}</span>
              <span className={`provider-ready ${activeSmsProvider.ready ? "" : "incomplete"}`}>
                {activeSmsProvider.ready ? <Check size={14} /> : <CircleAlert size={14} />}
                {activeSmsProvider.ready
                  ? (activeSmsProvider.summary ? tf("已配置 · {0}", activeSmsProvider.summary) : t("已配置"))
                  : t("未完成配置")}
              </span>
              <button type="button" className="secondary-button provider-settings-button" onClick={openSmsSettings} disabled={!smsProviderDefinitions.length}>
                <Settings2 size={16} />{t("配置")}
              </button>
            </div>

            <div className="provider-toolbar mail-request-toolbar" aria-label={t("邮件接码请求配置")}>
              <div className="provider-heading"><MailCheck size={17} /><strong>{t("邮件 API")}</strong></div>
              <span className="provider-name">{mailRequestSettings.method}</span>
              <span className="provider-ready">
                <Check size={14} />
                {formatMailRequestSummary(mailRequestSettings)}
              </span>
              <div className="mail-actions-group">
                {mailApiReady && (
                  <>
                    <button type="button" className="secondary-button" onClick={openCreateEmail} disabled={!token}>
                      <Plus size={16} />
                      {t("创建邮箱")}
                    </button>
                    <button type="button" className="secondary-button" onClick={openMailboxList} disabled={!token}>
                      <Mail size={16} />
                      {t("邮箱列表")}
                    </button>
                  </>
                )}
                <button type="button" className="secondary-button provider-settings-button" onClick={openMailRequestSettings} disabled={!token}>
                  <Settings2 size={16} />{t("配置")}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 第二步：连接 Sub2API */}
        <div className="workflow-step">
          <div className="step-head">
            <span className="step-index">2</span>
            <div className="step-titles">
              <h3>{t("连接 Sub2API")}</h3>
              <p>{t("填写后端地址与管理员 Key，选择目标号池")}</p>
            </div>
          </div>
          <div className="step-body">
            <div className="provider-toolbar sub2api-toolbar" aria-label={t("Sub2API 配置与号池监控")}>
              <div className="provider-heading"><Send size={17} /><strong>Sub2API</strong></div>
              <span className="provider-name">{sub2apiSettings.baseUrl || t("未配置后端")}</span>
              <span className={`provider-ready ${sub2apiSettings.adminApiKey ? "" : "incomplete"}`}>
                {sub2apiSettings.adminApiKey ? <Check size={14} /> : <CircleAlert size={14} />}
                {sub2apiSettings.adminApiKey
                  ? `${sub2apiSettings.groupIds.length ? tf("已配置 · {0} 个号池", sub2apiSettings.groupIds.length) : t("已配置 · 默认号池")}${sub2apiSettings.proxyId ? t(" · 已指定代理") : ""}`
                  : t("未完成配置")}
              </span>
              {features.sub2apiMonitor && (
                <span className={`provider-ready monitor-ready ${sub2apiMonitorStatus.enabled ? "" : "incomplete"}`}>
                  {sub2apiMonitorStatus.running
                    ? <LoaderCircle className="spin" size={14} />
                    : sub2apiMonitorStatus.enabled ? <ShieldCheck size={14} /> : <CircleAlert size={14} />}
                  {sub2apiMonitorStatus.running
                    ? t("正在巡检")
                    : sub2apiMonitorStatus.enabled
                      ? `${t("号池监控已启用")}${sub2apiMonitorStatus.lastCheckAt ? ` · ${formatRelativeMonitorTime(sub2apiMonitorStatus.lastCheckAt)}` : ""}`
                      : t("号池监控未启用")}
                </span>
              )}
              {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
                <button
                  type="button"
                  className="icon-button monitor-check-button"
                  onClick={checkSub2ApiMonitorNow}
                  disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}
                  title={t("立即检查 Sub2API 异常账号")}
                >
                  <RefreshCw className={sub2apiMonitorChecking || sub2apiMonitorStatus.running ? "spin" : ""} size={16} />
                </button>
              )}
              {features.sub2apiBackfill && sub2apiSettings.baseUrl && sub2apiSettings.adminApiKey && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={backfillSub2ApiTags}
                  disabled={!token || sub2apiBackfilling}
                  title={t("对照后端账号，为已上传过的账号补打标记")}
                >
                  {sub2apiBackfilling ? <LoaderCircle className="spin" size={16} /> : <CloudUpload size={16} />}
                  {t("同步已上传标记")}
                </button>
              )}
              <button type="button" className="secondary-button provider-settings-button" onClick={openSub2ApiSettings} disabled={!token}>
                <Settings2 size={16} />{t("配置")}
              </button>
            </div>
          </div>
        </div>

        {/* 第三步：创建账号 */}
        <div className="workflow-step">
          <div className="step-head">
            <span className="step-index">3</span>
            <div className="step-titles">
              <h3>{t("创建账号")}</h3>
              <p>{t("输入邮箱或批量导入，开始授权任务")}</p>
            </div>
          </div>
          <div className="step-body">
            <div className="section-heading">
              <div>
                <h2>{t("授权任务")}</h2>
                <p>{emailFilter.length
                  ? tf("匹配 {0} 条，共 {1} 条任务", pagination.total, pagination.totalAll ?? pagination.total)
                  : (pagination.total ? tf("共 {0} 条任务", pagination.total) : t("添加邮箱后开始第一条任务"))}</p>
              </div>
              <form className="add-form" onSubmit={createJob}>
                <div className="email-field">
                  <Mail size={17} aria-hidden="true" />
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={t("输入邮箱地址")}
                    autoComplete="email"
                    aria-label={t("邮箱地址")}
                    required
                  />
                </div>
                <button className="primary-button" type="submit" disabled={!token || busy}>
                  {busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
                  {t("添加任务")}
                </button>
                <button className="secondary-button" type="button" onClick={() => { setBatchError(""); setBatchOpen(true); }} disabled={!token}>
                  <ListPlus size={17} />
                  {t("批量添加")}
                </button>
                <button
                  className={`secondary-button ${emailFilter.length ? "filter-active" : ""}`}
                  type="button"
                  onClick={() => { setFilterError(""); setFilterText(emailFilter.join("\n")); setFilterOpen(true); }}
                  disabled={!token}
                >
                  <Filter size={17} />
                  {emailFilter.length ? tf("筛选 {0}", emailFilter.length) : t("筛选账号")}
                </button>
                {emailFilter.length > 0 && (
                  <button className="selection-text-button clear-filter-button" type="button" onClick={clearEmailFilter}>
                    {t("清除筛选")}
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>

        {/* 第四步：管理并上传到 Sub2API */}
        <div className="workflow-step">
          <div className="step-head">
            <span className="step-index">4</span>
            <div className="step-titles">
              <h3>{t("管理并上传到 Sub2API")}</h3>
              <p>{t("完成后上传到号池，即可快速登录使用")}</p>
            </div>
          </div>
          <div className="step-body">
        {error && (
          <div className="global-error" role="alert">
            <CircleAlert size={17} />
            <span>{ts(error)}</span>
            <button type="button" onClick={() => setError("")} title={t("关闭")}><X size={16} /></button>
          </div>
        )}
        {uploadNotice && (
          <div className="global-success" role="status">
            <Check size={17} />
            <span>{uploadNotice}</span>
            <button type="button" onClick={() => setUploadNotice("")} title={t("关闭")}><X size={16} /></button>
          </div>
        )}

        {/* Quick email search — filters the task list across every page (step 4) */}
        <div
          className="task-search"
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "2px 0 14px" }}
        >
          <div className="email-field" style={{ flex: "1 1 220px", maxWidth: 360 }}>
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={emailSearchDraft}
              onChange={(event) => {
                const v = event.target.value;
                setEmailSearchDraft(v);
                clearTimeout(window._emailSearchTimer);
                window._emailSearchTimer = setTimeout(() => { setEmailSearch(v.trim()); setPage(1); }, 300);
              }}
              onPaste={(event) => {
                // A bulk paste (e.g. a copied account table) is reduced to its emails before the
                // single-line input can strip the line breaks and glue neighbouring cells together.
                const emails = extractEmails(event.clipboardData?.getData("text"));
                if (emails.length < 2) return;
                event.preventDefault();
                const v = emails.join(", ");
                clearTimeout(window._emailSearchTimer);
                setEmailSearchDraft(v);
                setEmailSearch(v);
                setPage(1);
              }}
              placeholder={t("按邮箱搜索任务")}
              aria-label={t("搜索邮箱")}
              disabled={!token}
            />
          </div>
          {emailSearch && (
            <>
              <span style={{ fontSize: 12.5, opacity: 0.7 }}>
                {bulkSearchInfo.count > 1
                  ? tf("{0} 个邮箱，找到 {1} 条", bulkSearchInfo.count, pagination.total)
                  : tf("找到 {0} 条", pagination.total)}
              </span>
              {bulkSearchInfo.count > 1 && bulkSearchInfo.missing.length > 0 && (
                <span style={{ fontSize: 12.5, color: "#b4532a" }} title={bulkSearchInfo.missing.join("\n")}>
                  {tf("{0} 个邮箱没有任务", bulkSearchInfo.missing.length)}
                </span>
              )}
              <button
                type="button"
                className="selection-text-button clear-filter-button"
                onClick={() => { clearTimeout(window._emailSearchTimer); setEmailSearchDraft(""); setEmailSearch(""); setPage(1); }}
              >
                {t("清除搜索")}
              </button>
            </>
          )}
        </div>

        {features.bulkActions && jobs.length > 0 && (
          <div className="selection-toolbar">
            <div className="selection-summary">
              <span>{tf("当前页 {0} 条，跨页已选 {1} 条，可下载 {2} 条", jobs.length, selectedJobIds.size, downloadableSelectedCount)}</span>
              <button type="button" className="selection-text-button" onClick={toggleAllOnPage} disabled={allPageSelected || !pageJobIds.length}>
                {t("本页全选")}
              </button>
              <button type="button" className="selection-text-button" onClick={() => setSelectedJobIds(new Set())} disabled={!selectedJobIds.size}>
                {t("清除选择")}
              </button>
            </div>
            <div className="bulk-actions">
              <button
                type="button"
                className="start-button bulk-button"
                onClick={startSelectedJobs}
                disabled={!canStartSelected || Boolean(batchAction)}
                title={t("将选中的待启动任务加入队列并开始运行")}
              >
                {batchAction === "start" ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
                {t("开始运行")}
              </button>
              {features.cancelAll && (
                <button
                  type="button"
                  className="stop-all-button"
                  onClick={cancelAllRunningJobs}
                  disabled={!(stats.active || stats.queued) || Boolean(batchAction)}
                >
                  {batchAction === "cancel-all" ? <LoaderCircle className="spin" size={16} /> : <Ban size={16} />}
                  {t("停止全部")}
                </button>
              )}
              <button type="button" className="download-button" onClick={downloadSelected} disabled={!canDownloadSelected || Boolean(batchAction)}>
                {batchAction === "download" ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                {t("批量下载")}
              </button>
              {features.sub2apiUpload && (
                <button type="button" className="secondary-button bulk-button" onClick={() => uploadSelected([...selectedJobIds])} disabled={!canUploadSelected || Boolean(batchAction)}>
                  {batchAction === "upload" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                  {t("上传到 Sub2API")}
                </button>
              )}
              {features.sourceExport && (
                <button type="button" className="secondary-button bulk-button" onClick={exportSelectedSource} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                  {batchAction === "source" ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />}
                  {t("导出原始信息")}
                </button>
              )}
              <button type="button" className="regenerate-button bulk-button" onClick={reauthorizeSelected} disabled={!canReauthorizeSelected || Boolean(batchAction)}>
                {batchAction === "reauthorize" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                {t("批量重新授权")}
              </button>
              {features.forceRelogin && (
                <button type="button" className="relogin-button bulk-button" onClick={forceReloginSelected} disabled={!canForceReloginSelected || Boolean(batchAction)}>
                  {batchAction === "relogin" ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
                  {t("批量重新登录并授权")}
                </button>
              )}
              {features.totpSetup && (
                <button type="button" className="secondary-button bulk-button" onClick={setupTotpSelected} disabled={!canSetupTotpSelected || Boolean(batchAction)}>
                  {batchAction === "setup-2fa" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                  {t("批量设置 2FA")}
                </button>
              )}
              {features.passwordAdd && (
                <button type="button" className="secondary-button bulk-button" onClick={addPasswordSelected} disabled={!canAddPasswordSelected || Boolean(batchAction)}>
                  {batchAction === "add-password" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                  {t("批量添加密码")}
                </button>
              )}
              <button type="button" className="delete-button" onClick={deleteSelected} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                {batchAction === "delete" ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                {t("批量删除")}
              </button>
            </div>
          </div>
        )}

        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th className="select-heading">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={!features.bulkActions || !pageJobIds.length}
                    aria-label={t("选择当前页全部任务")}
                  />
                </th>
                <th>{t("账号")}</th>
                <th>{t("状态")}</th>
                <th>{t("当前操作")}</th>
                <th>{t("开始时间")}</th>
                <th>{t("最近操作时间")}</th>
                <th className="actions-heading">{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {!jobs.length && <EmptyState filtered={emailFilter.length > 0} />}
              {jobs.map((job) => (
                <React.Fragment key={job.id}>
                  <JobRow
                    job={job}
                    token={token}
                    expanded={expandedJobId === job.id}
                    onToggleLogs={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                    onError={setError}
                    selected={selectedJobIds.has(job.id)}
                    onToggleSelected={() => toggleJobSelection(job.id)}
                    selectionSupported={Boolean(features.bulkActions)}
                    smsProviderAvailable={smsProviderDefinitions.length > 0}
                    smsProvider={activeSmsProvider}
                    onUpload={() => uploadSelected([job.id])}
                    sub2apiUploadAvailable={Boolean(features.sub2apiUpload && sub2apiSettings.baseUrl && sub2apiSettings.adminApiKey)}
                    totpSetupAvailable={Boolean(features.totpSetup)}
                    passwordAddAvailable={Boolean(features.passwordAdd)}
                    forceReloginAvailable={Boolean(features.forceRelogin)}
                    accountProxyUrl={accountProxyUrl}
                    proxyBatchMode={proxyBatchMode}
                    sub2apiConfig={sub2apiSettings}
                  />
                  {expandedJobId === job.id && (
                    <tr className="log-row">
                      <td colSpan="7"><JobLogs token={token} jobId={job.id} /></td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {features.pagination && pagination.totalPages > 1 && (
          <nav className="pagination" aria-label={t("任务分页")}>
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} title={t("上一页")}>
              <ChevronLeft size={17} />
            </button>
            <span>{tf("第 {0} / {1} 页", pagination.page, pagination.totalPages)}</span>
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} disabled={page >= pagination.totalPages} title={t("下一页")}>
              <ChevronRight size={17} />
            </button>
          </nav>
        )}
          </div>
        </div>
      </section>
      {smsSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSmsSettingsOpen(false);
        }}>
          <form className="batch-dialog sms-settings-dialog" onSubmit={saveSmsSettings} role="dialog" aria-modal="true" aria-labelledby="sms-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sms-settings-title">{t("接码平台配置")}</h2>
                <span>{t("配置保存在当前浏览器")}</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSmsSettingsOpen(false)} title={t("关闭")}>
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs" role="tablist" aria-label={t("选择接码平台")}>
              {smsProviderDefinitions.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={draftSmsProvider.id === provider.id}
                  className={draftSmsProvider.id === provider.id ? "active" : ""}
                  onClick={() => {
                    setSmsSettingsDraft((current) => withSmsProviderDefaults(smsProviderDefinitions, {
                      ...current,
                      selectedProviderId: provider.id,
                    }));
                    setSmsSettingsError("");
                    setSmsNumberOptions([]);
                    setSmsBalance(null);
                    setSmsCodeCatalog(null);
                  }}
                >
                  {ts(provider.name)}
                </button>
              ))}
            </div>

            {draftSmsProvider.definition && (
              <div className="provider-config-section">
                <div className="provider-description-row">
                  <div className="provider-description">{ts(draftSmsProvider.definition.description)}</div>
                  {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id] && (
                    <a
                      className="provider-external-link"
                      href={SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      {t(SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].label)}
                    </a>
                  )}
                </div>
                <div className="provider-config-grid">
                  {draftSmsProvider.definition.fields.filter((field) => field.type !== "hidden").map((field) => (String(field.type).startsWith("smscode-") ? (
                    <SmsCodeField
                      key={field.key}
                      field={field}
                      config={draftSmsProvider.config}
                      catalog={smsCodeCatalog}
                      loading={smsOptionsLoading}
                      platformItems={smsCodePlatformItems}
                      countryItems={smsCodeCountryItems}
                      onQuery={() => loadSmsNumberOptions()}
                      onChangeSelection={changeSmsCodeSelection}
                      onUpdate={(patch) => updateSmsProviderConfig("smscode", patch)}
                    />
                  ) : (
                    <label key={field.key} className={`settings-field ${["price-select", "service-select", "textarea"].includes(field.type) ? "wide-settings-field" : ""}`}>
                      <span>{ts(field.label)}</span>
                      {field.type === "price-select" ? (
                        (() => {
                          const selCountry = smsCatalog?.countries.find((c) => c.code === draftSmsProvider.config.country);
                          return (
                            <div style={{ display: "grid", gap: 8, height: "auto", padding: 0, border: "none", background: "transparent" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <button
                                  type="button"
                                  className="price-refresh-button"
                                  onClick={() => loadSmsCatalog()}
                                  disabled={smsOptionsLoading}
                                >
                                  {smsOptionsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                                  {smsOptionsLoading ? t("查询中") : t("查询价格")}
                                </button>
                                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, opacity: 0.75, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {smsCatalog
                                    ? tf("服务：{0} · {1} 个国家", smsCatalog.title, smsCatalog.countries.length)
                                    : t("点击查询实时价格与国家/质量")}
                                </div>
                              </div>
                              {smsCatalog && (() => {
                                const q = smsCountryQuery.trim().toLowerCase();
                                const shownCountries = q
                                  ? smsCatalog.countries.filter((c) => `${c.iso || ""} ${c.title || ""}`.toLowerCase().includes(q))
                                  : smsCatalog.countries;
                                const countryText = (c) => `${c.iso ? c.iso + " · " : ""}${c.title} · ${c.count} · $${c.minPrice}`;
                                return (
                                  <div style={{ display: "grid", gap: 8 }}>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                      <div
                                        className="price-select-box"
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => setSmsCountryOpen((o) => !o)}
                                        style={{ cursor: "pointer" }}
                                      >
                                        <Globe2 size={15} />
                                        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 12 }}>
                                          {selCountry ? countryText(selCountry) : t("选择国家")}
                                        </span>
                                        {smsCountryOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                      </div>
                                      <div className="price-select-box">
                                        <Settings2 size={15} />
                                        <select
                                          value={draftSmsProvider.config.smsAgentId || ""}
                                          onChange={(event) => selectSmsPosition(draftSmsProvider.config.country, event.target.value)}
                                          disabled={!selCountry}
                                          aria-label={t("号码质量与价格")}
                                        >
                                          {!selCountry && <option value="">{t("请先选择国家")}</option>}
                                          {selCountry?.positions.map((p) => (
                                            <option key={p.agentId} value={p.agentId}>
                                              {`${p.rank} · $${p.price} · ${p.count} pcs`}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    </div>
                                    {smsCountryOpen && (
                                      <div style={{ border: "1px solid #ccd4d0", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
                                        <div style={{ padding: 8, borderBottom: "1px solid #eef1ef" }}>
                                          <div className="price-select-box" style={{ height: 32 }}>
                                            <Filter size={14} />
                                            <input
                                              type="text"
                                              value={smsCountryQuery}
                                              onChange={(event) => setSmsCountryQuery(event.target.value)}
                                              placeholder="Tìm quốc gia…"
                                              spellCheck="false"
                                              autoFocus
                                              aria-label="Tìm quốc gia"
                                              style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", color: "inherit", fontSize: 12 }}
                                            />
                                          </div>
                                        </div>
                                        <div style={{ maxHeight: 200, overflowY: "auto", overscrollBehavior: "contain" }}>
                                          {shownCountries.length === 0 ? (
                                            <div style={{ padding: "10px 12px", fontSize: 12, opacity: 0.6 }}>Không tìm thấy quốc gia</div>
                                          ) : shownCountries.map((c) => (
                                            <button
                                              type="button"
                                              key={c.code}
                                              onClick={() => { selectSmsCountry(c.code); setSmsCountryOpen(false); setSmsCountryQuery(""); }}
                                              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: 0, cursor: "pointer", fontSize: 12.5, color: "inherit", background: c.code === draftSmsProvider.config.country ? "rgba(16,162,113,0.12)" : "transparent" }}
                                            >
                                              {countryText(c)}
                                            </button>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })()
                      ) : field.type === "service-select" ? (
                        <div style={{ display: "grid", gap: 8, height: "auto", padding: 0, border: "none", background: "transparent" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <button
                              type="button"
                              className="price-refresh-button"
                              onClick={() => loadSmsNumberOptions()}
                              disabled={smsOptionsLoading}
                            >
                              {smsOptionsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                              {smsOptionsLoading ? t("查询中") : t("查询服务")}
                            </button>
                            {smsBalance && <span style={{ fontSize: 12, color: "var(--muted)" }}>{t("余额")}: {smsBalance}</span>}
                          </div>
                          {smsNumberOptions.length > 0 && (
                            <div className="price-select-box">
                              <Settings2 size={15} />
                              <select
                                value={draftSmsProvider.config[field.key] || ""}
                                onChange={(event) => {
                                  const service = smsNumberOptions.find((s) => s.value === event.target.value);
                                  updateSmsProviderConfig(draftSmsProvider.id, {
                                    [field.key]: event.target.value,
                                    serviceLabel: service?.label || "",
                                  });
                                }}
                                aria-label={ts(field.label)}
                                style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", color: "inherit", fontSize: 12.5 }}
                              >
                                {smsNumberOptions.map((s) => (
                                  <option key={s.value} value={s.value}>
                                    {s.label} · {s.priceLabel}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </div>
                      ) : field.type === "select" && field.options ? (
                        <div>
                          <Settings2 size={15} />
                          <select
                            value={draftSmsProvider.config[field.key] || field.defaultValue || ""}
                            onChange={(event) => {
                              updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value });
                              setSmsNumberOptions([]);
                              setSmsBalance(null);
                            }}
                            aria-label={ts(field.label)}
                            style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", color: "inherit", fontSize: 13 }}
                          >
                            {field.options.map((opt) => (
                              <option key={opt.value} value={opt.value}>{ts(opt.label)}</option>
                            ))}
                          </select>
                        </div>
                      ) : field.type === "textarea" ? (
                        <textarea
                          className="settings-textarea"
                          value={draftSmsProvider.config[field.key] || ""}
                          onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                          placeholder={ts(field.placeholder)}
                          rows="8"
                          autoComplete="off"
                          spellCheck="false"
                        />
                      ) : (
                        <div>
                          {field.type === "password" ? <KeyRound size={15} /> : <Settings2 size={15} />}
                          <input
                            type={field.type || "text"}
                            value={draftSmsProvider.config[field.key] || ""}
                            onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                            placeholder={ts(field.placeholder)}
                            autoComplete="off"
                            spellCheck="false"
                          />
                        </div>
                      )}
                    </label>
                  )))}
                </div>
              </div>
            )}

            <div className="provider-config-section" style={{ marginTop: 12 }}>
              <label style={{ display: "block" }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                  {t("每个手机号最多使用次数")}
                </span>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  value={phoneMaxUses}
                  onChange={(event) => setPhoneMaxUses(event.target.value)}
                  style={{ width: 120 }}
                />
                <span style={{ display: "block", fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  {t("0 = 不限制使用次数；被风控的号码始终跳过；记录保存在服务器，不使用浏览器存储")}
                </span>
                {phoneUsageStats ? (
                  <span style={{ display: "block", fontSize: 12, opacity: 0.7, marginTop: 2 }}>
                    {tf("已记录 {0} 个号码 · {1} 个被风控拦截 · 共 {2} 次使用", phoneUsageStats.totalNumbers ?? 0, phoneUsageStats.blocked ?? 0, phoneUsageStats.totalUses ?? 0)}
                  </span>
                ) : null}
              </label>
            </div>

            {smsSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{ts(smsSettingsError)}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setSmsSettingsOpen(false)}>{t("取消")}</button>
              <button type="submit" className="primary-button" disabled={!draftSmsProvider.definition}>
                <Check size={17} />{t("保存配置")}
              </button>
            </div>
          </form>
        </div>
      )}
      {proxyLinkOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setProxyLinkOpen(false);
        }}>
          <div className="batch-dialog mail-request-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="proxy-link-title">
            <div className="dialog-header">
              <div>
                <h2 id="proxy-link-title">{t("代理连接方式")}</h2>
                <span>{t("上传到 Sub2API 时如何给账号分配代理")}</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setProxyLinkOpen(false)} title={t("关闭")}>
                <X size={18} />
              </button>
            </div>
            <div className="provider-tabs mail-method-tabs" role="tablist">
              {[["single", t("连接 1 IP")], ["batch", t("批量连接")]].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={proxyLinkConfig.mode === mode}
                  className={proxyLinkConfig.mode === mode ? "active" : ""}
                  onClick={() => setProxyLinkConfig((c) => ({ ...c, mode }))}
                >
                  {label}
                </button>
              ))}
            </div>
            {proxyLinkConfig.mode === "batch" ? (
              <div className="provider-config-grid mail-request-config-grid">
                <label className="settings-field wide-settings-field">
                  <span>{t("每个 IP 最多账号数")} <small>{tf("默认 {0}", 15)}</small></span>
                  <div>
                    <input
                      type="number"
                      min="1"
                      max="999"
                      value={proxyLinkConfig.limitPerIp}
                      onChange={(event) => setProxyLinkConfig((c) => ({ ...c, limitPerIp: event.target.value }))}
                    />
                  </div>
                </label>
                <div className="settings-field wide-settings-field" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontSize: 13, opacity: 0.85 }}>
                  <span>{tf("通用代理池：已配置 {0} 个代理 IP（用于所有域名）。", parseProxyPasteList(proxyLinkConfig.proxies).filter((e) => !proxyDomainByHost.has(e.host)).length)}</span>
                  <button type="button" className="secondary-button" onClick={() => { setProxyLinkOpen(false); openProxyList(); }}>
                    <List size={16} />{t("代理 IP 列表")}
                  </button>
                </div>
                <div className="wide-settings-field domain-proxy-section">
                  <span className="domain-proxy-title">{t("按域名分配专用代理")} <small>{t("指定域名的邮箱只用该域名的专用代理；用完后再借用通用代理池")}</small></span>
                  <div className="domain-proxy-groups">
                    {(proxyLinkConfig.domainProxies || []).map((group, index) => {
                      const ipCount = parseProxyPasteList(group?.proxies || "").length;
                      const hasDomain = Boolean(String(group?.domain || "").trim());
                      const assignedOk = hasDomain && ipCount > 0;
                      return (
                        <div key={index} className="domain-proxy-group">
                          <div className="domain-proxy-group-head">
                            <input
                              type="text"
                              className="domain-proxy-domain"
                              placeholder={t("域名，例如 example.com")}
                              value={group?.domain || ""}
                              spellCheck="false"
                              onChange={(event) => updateDomainProxyGroup(index, "domain", event.target.value)}
                            />
                            <select
                              className="domain-proxy-proto"
                              value={group?.protocol || "socks5h"}
                              title={t("协议")}
                              onChange={(event) => updateDomainProxyGroup(index, "protocol", event.target.value)}
                            >
                              <option value="socks5h">SOCKS5</option>
                              <option value="http">HTTP</option>
                            </select>
                            <button type="button" className="icon-button" title={t("删除")} onClick={() => removeDomainProxyGroup(index)}>
                              <X size={16} />
                            </button>
                          </div>
                          <textarea
                            className="domain-proxy-list"
                            placeholder={"socks5h://user:pass@host:port\nhost:port:user:pass"}
                            value={group?.proxies || ""}
                            spellCheck="false"
                            onChange={(event) => updateDomainProxyGroup(index, "proxies", event.target.value)}
                          />
                          <div className={`domain-proxy-status ${assignedOk ? "ok" : "warn"}`}>
                            {assignedOk ? <Check size={14} /> : <CircleAlert size={14} />}
                            {assignedOk
                              ? tf("已绑定 {0} 个专用 IP 给 {1}（已从通用池移除）", ipCount, String(group.domain).trim())
                              : (!hasDomain ? t("请填写域名") : t("请填写该域名的代理"))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="domain-proxy-actions">
                    <button type="button" className="secondary-button" onClick={addDomainProxyGroup}>
                      <Plus size={15} />{t("添加域名代理")}
                    </button>
                    <button type="button" className="secondary-button" onClick={applyDomainProxies} disabled={domainApplyBusy}>
                      {domainApplyBusy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                      {t("为现有账号更换代理")}
                    </button>
                  </div>
                  {domainApplyNotice ? <div className="domain-proxy-notice">{ts(domainApplyNotice)}</div> : null}
                  <div className="domain-proxy-hint">{t("把某代理分配给域名后，它会自动从通用池移除；点“为现有账号更换代理”可把正用着该代理的其它域名账号改到合适代理（运行中的账号会跳过）。")}</div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.78, margin: "14px 2px" }}>
                {t("每个账号使用它注册时的代理，上传时自动创建并关联。")}
              </div>
            )}
            <div className="provider-config-grid mail-request-config-grid">
              <label className="settings-field wide-settings-field">
                <span>{t("每个 IP 每分钟最多注册账号数")} <small>{tf("默认 {0}，0 = 不限制", 2)}</small></span>
                <div>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={proxyLinkConfig.maxPerMinute}
                    onChange={(event) => setProxyLinkConfig((c) => ({ ...c, maxPerMinute: event.target.value }))}
                  />
                </div>
              </label>
            </div>
            <div style={{ fontSize: 13, opacity: 0.78, margin: "10px 2px 0" }}>
              {t("同一 IP 短时间内连续注册时，服务端可能不发送验证邮件；超出上限的注册任务会留在队列中等待。")}
            </div>
            <div className="dialog-footer">
              <button type="button" className="primary-button" onClick={() => setProxyLinkOpen(false)}>
                <Check size={17} />{t("完成")}
              </button>
            </div>
          </div>
        </div>
      )}
      {proxyListOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setProxyListOpen(false);
        }}>
          <div className="batch-dialog proxy-list-dialog" role="dialog" aria-modal="true" aria-labelledby="proxy-list-title">
            <div className="dialog-header">
              <div>
                <h2 id="proxy-list-title">{t("代理 IP 列表")}</h2>
                <span>{t("管理代理、查看每个 IP 已注册的邮箱与连接状态")}</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className="icon-button" onClick={() => fetchProxyStatus({ refresh: true })} disabled={proxyListBusy} title={t("刷新")}>
                  <RefreshCw className={proxyListBusy ? "spin" : ""} size={17} />
                </button>
                <button type="button" className="icon-button" onClick={() => setProxyListOpen(false)} title={t("关闭")}>
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Thẻ tóm tắt: IP hoạt động · còn bao nhiêu lần đăng ký · giới hạn mỗi IP */}
            <div className="proxy-stats">
              <div className="proxy-stat">
                <div className={`num ${proxyStatus && proxyStatus.activeCount ? "ok" : ""}`}>
                  {proxyStatus ? `${proxyStatus.activeCount}/${proxyStatus.totalCount}` : "—"}
                </div>
                <div className="lbl">{t("IP 活跃 / 总数")}</div>
              </div>
              <div className="proxy-stat">
                <div className={`num ${proxyStatus && !proxyStatus.remaining ? "warn" : "ok"}`}>
                  {proxyStatus ? proxyStatus.remaining : "—"}
                </div>
                <div className="lbl">{t("剩余可注册次数（估算）")}</div>
              </div>
              <div className="proxy-stat">
                <div className="num">{proxyStatus ? proxyStatus.limitPerIp : (Number(proxyLinkConfig.limitPerIp) || 15)}</div>
                <div className="lbl">{t("每个 IP 上限")}</div>
              </div>
            </div>

            {/* Thêm mới hàng loạt: dán danh sách, tự nhận diện HTTP / SOCKS5 */}
            <div className="proxy-bulk">
              <div className="proxy-bulk-head"><ListPlus size={16} /> {t("批量添加代理")}</div>
              <textarea
                value={proxyBulkText}
                onChange={(event) => setProxyBulkText(event.target.value)}
                placeholder={"# IF_163 · 116.96.82.180 · HTTP 22030 / SOCKS5 23030\n116.96.82.180:22030:user:pass\n116.96.82.180:23030:user:pass"}
                spellCheck="false"
              />
              {(() => {
                const parsed = parseProxyPasteList(proxyBulkText);
                const ambN = parsed.filter((e) => e.ambiguous).length;
                const explicitSocks = parsed.filter((e) => !e.ambiguous && e.protocol === "socks5h").length;
                const explicitHttp = parsed.filter((e) => !e.ambiguous && e.protocol === "http").length;
                // Dòng chưa rõ giao thức được tính cho cả 2 nút; bấm nút nào sẽ ép theo nút đó.
                const socksN = explicitSocks + ambN;
                const httpN = explicitHttp + ambN;
                return (
                  <div className="proxy-bulk-actions">
                    <span className="proxy-bulk-hint">
                      {parsed.length
                        ? (ambN
                            ? tf("{0} SOCKS5 · {1} HTTP · {2} 个未识别（点按钮指定协议）", explicitSocks, explicitHttp, ambN)
                            : tf("已识别 {0} 个 SOCKS5 · {1} 个 HTTP", explicitSocks, explicitHttp))
                        : t("粘贴后自动识别 HTTP / SOCKS5（每个 IP 只添加一次）")}
                    </span>
                    <button type="button" className="secondary-button" onClick={() => addBulkProxies("socks5")} disabled={!socksN}>
                      <Plus size={15} />{tf("添加 SOCKS5（{0}）", socksN)}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => addBulkProxies("http")} disabled={!httpN}>
                      <Plus size={15} />{tf("添加 HTTP（{0}）", httpN)}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => addBulkProxies("all")} disabled={!parsed.length}>
                      <Plus size={15} />{t("添加全部")}
                    </button>
                  </div>
                );
              })()}
            </div>

            {proxyListError && <div className="dialog-error" role="alert" style={{ marginTop: 12 }}><CircleAlert size={15} />{ts(proxyListError)}</div>}

            {proxyStatus && proxyStatus.proxies.length ? (
              <div className="proxy-filters">
                {[
                  [null, t("全部"), proxyStatus.proxies.length],
                  ["inuse", t("使用中"), proxyStatus.usageCounts?.inuse ?? 0],
                  ["unused", t("未使用"), proxyStatus.usageCounts?.unused ?? 0],
                  ["used", t("已用完"), proxyStatus.usageCounts?.used ?? 0],
                  ["burned", t("需换 IP"), proxyStatus.burnedCount ?? 0, "burn"],
                ].map(([value, label, count, tone]) => (
                  <button
                    key={value === null ? "__all__" : value}
                    type="button"
                    className={`proxy-chip ${tone === "burn" ? "burn" : ""} ${proxyFilter === value ? "active" : ""}`}
                    onClick={() => setProxyFilter(value)}
                  >
                    {label}<span className="cnt">{count}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="proxy-table">
              <div className="proxy-thead">
                <span>{t("协议")}</span>
                <span>{t("代理 IP")}</span>
                <span>{t("状态")}</span>
                <span>{t("已注册邮箱")}</span>
                <span style={{ textAlign: "center" }}>{t("被封号")}</span>
                <span style={{ textAlign: "right" }}>{t("剩余额度")}</span>
                <span />
              </div>
              <div className="proxy-scroll">
                {proxyListBusy && !proxyStatus ? (
                  <div className="proxy-empty"><LoaderCircle className="spin" size={20} /></div>
                ) : !proxyStatus || !proxyStatus.proxies.length ? (
                  <div className="proxy-empty">{t("暂无代理，请在“配置”中选择“批量连接”并填入代理，或使用上方批量添加")}</div>
                ) : (() => {
                  const rows = proxyStatus.proxies.filter((p) => proxyFilter === null || (proxyFilter === "burned" ? p.burned : p.usage === proxyFilter));
                  if (!rows.length) return <div className="proxy-empty">{t("没有符合筛选条件的代理")}</div>;
                  return rows.map((p) => {
                    const expanded = proxyExpanded.has(p.label);
                    const isSocks = /socks/i.test(p.protocol);
                    return (
                      <div key={p.label} className={`proxy-row ${p.burned ? "burned" : ""}`}>
                        <div className="proxy-row-main">
                          <span className={`proxy-pill ${isSocks ? "socks" : "http"}`}>
                            <Network size={12} />{isSocks ? "SOCKS5" : (p.protocol || "?").toUpperCase()}
                          </span>
                          <div className="proxy-ipcell">
                            <div className="addr" title={p.label}>
                              {p.label}
                              {!p.configured ? <span className="proxy-old">{t("IP 旧")}</span> : null}
                              {proxyDomainByHost.get(p.host) ? <span className="proxy-domain-tag" title={proxyDomainByHost.get(p.host)}>{proxyDomainByHost.get(p.host)}</span> : null}
                              {(() => {
                                // "Checking" — IP RA THỰC đang ra đã sạch hay vẫn cháy
                                switch (p.curExitStatus) {
                                  case "burned":
                                    return <span className="proxy-check burn" title={tf("当前出口 IP 已有 {0} 个账号被封，需更换", p.curExitDisabled)}><Ban size={11} />{t("需换 IP")}</span>;
                                  case "burning":
                                    return <span className="proxy-check warn" title={tf("当前出口 IP 已有 {0} 个账号被封", p.curExitDisabled)}><CircleAlert size={11} />{tf("当前 IP {0} 封", p.curExitDisabled)}</span>;
                                  case "clean":
                                    return <span className="proxy-check ok" title={t("当前出口 IP 尚无账号被封，已更换成功")}><Check size={11} />{t("已换 IP")}</span>;
                                  case "nodata":
                                    return <span className="proxy-check muted" title={t("当前出口 IP 还没有新账号数据")}>{t("当前 IP 暂无数据")}</span>;
                                  default:
                                    return null; // unknown: proxy chết, pill "连接失败" đã báo
                                }
                              })()}
                            </div>
                            {p.connected && p.ip ? <div className="exit">{tf("出口 {0}", p.ip)}</div> : (!p.connected && p.error ? <div className="exit" title={p.error}>{ts(p.error)}</div> : null)}
                          </div>
                          <span className={`proxy-pill ${p.connected ? "ok" : "down"}`} title={p.connected ? "" : (p.error || "")}>
                            {p.connected ? <Check size={12} /> : <CircleAlert size={12} />}
                            {p.connected ? t("已连接") : t("连接失败")}
                          </span>
                          <button type="button" className="proxy-emailbtn" onClick={() => toggleProxyEmails(p.label)} disabled={!p.emailCount}>
                            <Mail size={14} />{tf("{0} 个邮箱", p.emailCount)}
                            {p.emailCount ? (expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : null}
                          </button>
                          <span
                            className={`proxy-disabled ${p.disabledCount >= (proxyStatus.burnThreshold || 5) ? "burn" : (p.disabledCount ? "warn" : "")}`}
                            title={p.disabledCount ? tf("历史封号 {0}/{1}（该代理全部记录，不随换 IP 清零）", p.disabledCount, p.disabledTotal) : t("该代理暂无封号记录")}
                          >
                            {p.disabledCount ? <><Ban size={12} />{p.disabledCount}</> : <small>0</small>}
                          </span>
                          <span className="proxy-remain" style={{ textAlign: "right" }}>
                            {p.remaining}<small>{tf(" / {0}", proxyStatus.limitPerIp)}</small>
                          </span>
                          {p.configured ? (
                            <button
                              type="button"
                              className="proxy-del"
                              onClick={() => removeProxy(p.host)}
                              title={t("从列表中删除该代理")}
                            >
                              <Trash2 size={15} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="proxy-del forget"
                              onClick={() => forgetProxy(p.host)}
                              title={t("忘记此 IP（从列表隐藏，不删账号）")}
                            >
                              <EyeOff size={15} />
                            </button>
                          )}
                        </div>
                        {expanded && p.emails.length ? (
                          <div className="proxy-emails">
                            <div className="proxy-emails-head">
                              <Mail size={13} />{tf("{0} 个已注册邮箱", p.emails.length)}
                              <button type="button" className="proxy-emails-copy" onClick={() => copyProxyEmails(p.emails)}>
                                <Copy size={13} />{t("复制全部")}
                              </button>
                            </div>
                            <div className="proxy-emails-grid">
                              {p.emails.map((em) => (
                                <div key={em} className="item" title={em}><span className="dot" /><span>{em}</span></div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>

            <div className="dialog-footer">
              <div style={{ marginRight: "auto", alignSelf: "center", fontSize: 12.5, color: "var(--muted)" }}>
                {proxyStatus
                  ? tf("预计：{0} 个 IP 活跃 · 剩余约 {1} 次注册", proxyStatus.activeCount, proxyStatus.remaining)
                  : t("上限可在“配置”中调整")}
              </div>
              <button type="button" className="secondary-button" onClick={() => { setProxyListOpen(false); setProxyLinkOpen(true); }}>
                <Settings2 size={16} />{t("配置")}
              </button>
              <button type="button" className="primary-button" onClick={() => setProxyListOpen(false)}>
                <Check size={17} />{t("完成")}
              </button>
            </div>
          </div>
        </div>
      )}
      {mailRequestSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !mailRequestSettingsSaving) setMailRequestSettingsOpen(false);
        }}>
          <form className="batch-dialog mail-request-settings-dialog" onSubmit={saveMailRequestSettings} role="dialog" aria-modal="true" aria-labelledby="mail-request-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="mail-request-settings-title">{t("邮件 API 请求配置")}</h2>
                <span>{t("配置保存在当前浏览器，请求内容不会写入任务日志")}</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving} title={t("关闭")}>
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs mail-method-tabs" role="tablist" aria-label={t("邮件 API 请求方式")}>
              {["GET", "POST"].map((method) => (
                <button
                  key={method}
                  type="button"
                  role="tab"
                  aria-selected={mailRequestSettingsDraft.method === method}
                  className={mailRequestSettingsDraft.method === method ? "active" : ""}
                  onClick={() => setMailRequestSettingsDraft((current) => ({ ...current, method }))}
                >
                  {method}
                </button>
              ))}
            </div>

            <div className="provider-config-grid mail-request-config-grid">
              {mailRequestSettingsDraft.method === "POST" && (
                <label className="settings-field wide-settings-field">
                  <span className="mail-request-url-label">
                    {t("统一 POST 请求 URL")}
                    <small>{t("必填")}</small>
                  </span>
                  <input
                    className="mail-request-url-input"
                    type="url"
                    value={mailRequestSettingsDraft.url}
                    onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, url: event.target.value }))}
                    placeholder="https://mail.example/api/messages"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <small>{t("每个账号自己的请求体请在批量添加账号时一并导入")}</small>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>{t("请求头 JSON")}</span>
                <textarea
                  className="settings-textarea"
                  value={mailRequestSettingsDraft.headersText}
                  onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, headersText: event.target.value }))}
                  placeholder={'{"Authorization":"Bearer ...","Referer":"https://mail.example/"}'}
                  rows="7"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
              <label className="settings-field wide-settings-field">
                <span>{t("应用域名")} <small>{t("用于“创建邮箱”和“邮箱列表” · 留空 = 全部")}</small></span>
                <div className="mail-domain-chips">
                  {mailRoots.length === 0 ? (
                    <small style={{ opacity: 0.6 }}>{t("未获取到域名列表（需连接邮件 API）。")}</small>
                  ) : mailRoots.map((r) => {
                    const on = (mailRequestSettingsDraft.domains || []).includes(r.root);
                    return (
                      <label
                        key={r.root}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
                          borderRadius: 999, cursor: "pointer", fontSize: 12.5,
                          border: on ? "1px solid var(--green)" : "1px solid rgba(128,128,128,0.3)",
                          background: on ? "rgba(16,162,113,0.12)" : "transparent",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => setMailRequestSettingsDraft((current) => {
                            const set = new Set(current.domains || []);
                            if (set.has(r.root)) set.delete(r.root); else set.add(r.root);
                            return { ...current, domains: [...set] };
                          })}
                        />
                        {r.root}
                      </label>
                    );
                  })}
                </div>
              </label>
            </div>

            {mailRequestSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{ts(mailRequestSettingsError)}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving}>{t("取消")}</button>
              <button type="submit" className="primary-button" disabled={mailRequestSettingsSaving || !token}>
                {mailRequestSettingsSaving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                {t("保存配置")}
              </button>
            </div>
          </form>
        </div>
      )}
      {sub2apiSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSub2apiSettingsOpen(false);
        }}>
          <form className="batch-dialog sub2api-settings-dialog" onSubmit={saveSub2ApiSettings} role="dialog" aria-modal="true" aria-labelledby="sub2api-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sub2api-settings-title">{t("Sub2API 配置")}</h2>
                <span>{t("管理员 Key 不写入任务文件或日志；启用监控后由本机服务保存")}</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSub2apiSettingsOpen(false)} title={t("关闭")}><X size={18} /></button>
            </div>
            <div className="provider-config-grid sub2api-config-grid">
              <label className="settings-field wide-settings-field">
                <span>{t("Sub2API 后端地址")}</span>
                <input
                  type="url"
                  value={sub2apiSettingsDraft.baseUrl}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder={t("例如 http://127.0.0.1:8080")}
                  autoComplete="url"
                />
              </label>
              {features.sub2apiMonitor && (
                <label className="settings-field wide-settings-field sub2api-monitor-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(sub2apiSettingsDraft.monitorEnabled)}
                    onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, monitorEnabled: event.target.checked }))}
                  />
                  <span>
                    <strong>{t("每 5 分钟监控异常账号")}</strong>
                    <small>{t("只自动处理上次完整登录未人工输入密码、邮箱码或登录 2FA 的任务")}</small>
                  </span>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>{t("管理员 API Key")}</span>
                <input
                  type="password"
                  value={sub2apiSettingsDraft.adminApiKey}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, adminApiKey: event.target.value }))}
                  placeholder={t("输入 sub2api 管理员 API Key")}
                  autoComplete="off"
                />
              </label>
              <fieldset className="settings-field wide-settings-field sub2api-group-field">
                <legend>{t("目标号池（可多选）")}</legend>
                <section className="sub2api-group-picker" aria-label={t("目标号池")}>
                  {sub2apiGroups.length ? sub2apiGroups.map((group) => {
                    const groupId = String(group.id);
                    return (
                      <label key={group.id} className="sub2api-group-option">
                        <input
                          type="checkbox"
                          checked={sub2apiSettingsDraft.groupIds.includes(groupId)}
                          onChange={(event) => setSub2ApiGroupChecked(groupId, event.target.checked)}
                        />
                        <span>{ts(group.name)}</span>
                        <small>ID: {group.id}</small>
                      </label>
                    );
                  }) : <div className="sub2api-group-empty">{t("暂无可选号池")}</div>}
                </section>
                <section className="sub2api-group-selection" aria-label={t("号池选择操作")}>
                  <span>{tf("已选 {0} 个", sub2apiSettingsDraft.groupIds.length)}</span>
                  <button
                    type="button"
                    onClick={() => setSub2apiSettingsDraft((current) => ({ ...current, groupIds: sub2apiGroups.map((group) => String(group.id)) }))}
                    disabled={!sub2apiGroups.length || sub2apiGroups.every((group) => sub2apiSettingsDraft.groupIds.includes(String(group.id)))}
                  >
                    {t("全选")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSub2apiSettingsDraft((current) => ({ ...current, groupIds: [] }))}
                    disabled={!sub2apiSettingsDraft.groupIds.length}
                  >
                    {t("清空")}
                  </button>
                </section>
              </fieldset>
              <label className="settings-field wide-settings-field">
                <span>{t("代理 IP")}</span>
                <select
                  value={sub2apiSettingsDraft.proxyId}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, proxyId: event.target.value }))}
                >
                  <option value="">{t("使用账号原配置")}</option>
                  {sub2apiProxies.map((proxy) => <option key={proxy.id} value={String(proxy.id)}>{formatSub2ApiProxy(proxy)}</option>)}
                </select>
              </label>
              <label className="settings-field wide-settings-field">
                <span>{t("Codex 指纹收敛")}</span>
                <select
                  value={sub2apiSettingsDraft.codexFingerprintMode}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, codexFingerprintMode: event.target.value }))}
                >
                  <option value="off">{t("关闭（透传）")}</option>
                  <option value="device">{t("仅设备")}</option>
                  <option value="session">{t("设备+会话（推荐）")}</option>
                  <option value="full">{t("完全收敛")}</option>
                </select>
              </label>
              <label className="settings-field">
                <span>{t("并发数")}</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.concurrency}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, concurrency: event.target.value }))}
                  placeholder={t("留空使用账号原值")}
                />
              </label>
              <label className="settings-field">
                <span>{t("负载因子")}</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.loadFactor}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, loadFactor: event.target.value }))}
                  placeholder={t("留空使用账号原值")}
                />
              </label>
              <label className="settings-field">
                <span>{t("优先级")}</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.priority}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, priority: event.target.value }))}
                  placeholder={t("留空使用账号原值")}
                />
              </label>
              <label className="settings-field wide-settings-field">
                <span>{t("允许使用的模型")}</span>
                <textarea
                  className="sub2api-model-textarea"
                  value={sub2apiSettingsDraft.modelWhitelist}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, modelWhitelist: event.target.value }))}
                  placeholder={t("每行一个模型，也支持逗号分隔，例如：\ngpt-5\ngpt-5-mini\ngpt-4.1")}
                  rows="5"
                  spellCheck="false"
                />
              </label>
            </div>
            <div className="dialog-hint">{t("分组为空时，上传使用 Sub2API 默认号池，监控检查全部 OpenAI 账号；选择分组后只监控这些号池。Codex 指纹收敛会写入每个上传或巡检更新的 OpenAI OAuth 账号。")}</div>
            {features.sub2apiMonitor && sub2apiMonitorStatus.configured && (
              <div className={`sub2api-monitor-status ${sub2apiMonitorStatus.lastError ? "error" : ""}`}>
                <ShieldCheck size={15} />
                <span>{sub2apiMonitorStatus.lastError
                  ? tf("上次巡检失败：{0}", ts(sub2apiMonitorStatus.lastError))
                  : sub2apiMonitorStatus.lastCheckAt
                    ? formatMonitorResult(sub2apiMonitorStatus.lastResult)
                    : t("尚未执行号池巡检")}</span>
              </div>
            )}
            {sub2apiSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{ts(sub2apiSettingsError)}</div>}
            <div className="dialog-actions sub2api-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => loadSub2ApiOptions()} disabled={sub2apiGroupsLoading || !token}>
                {sub2apiGroupsLoading ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}{t("读取配置")}
              </button>
              {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
                <button type="button" className="secondary-button" onClick={checkSub2ApiMonitorNow} disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}>
                  {sub2apiMonitorChecking || sub2apiMonitorStatus.running ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{t("立即检查")}
                </button>
              )}
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={() => setSub2apiSettingsOpen(false)} disabled={sub2apiSettingsSaving}>{t("取消")}</button>
              <button type="submit" className="primary-button" disabled={sub2apiSettingsSaving}>
                {sub2apiSettingsSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{t("保存配置")}
              </button>
            </div>
          </form>
        </div>
      )}
      {batchOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !batchBusy) setBatchOpen(false);
        }}>
          <form className="batch-dialog" onSubmit={createBatch} role="dialog" aria-modal="true" aria-labelledby="batch-title">
            <div className="dialog-header">
              <div>
                <h2 id="batch-title">{t("批量添加账号")}</h2>
                <span>
                  {tf("{0} 条，超出并发上限后自动排队", batchLines.length)}
                  {batchLines.length && !batchAllChecked ? tf(" · 已选 {0}", batchRunLines.length) : ""}
                </span>
              </div>
              <button type="button" className="icon-button" onClick={() => setBatchOpen(false)} disabled={batchBusy} title={t("关闭")}>
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="batch-input">
              {mailRequestSettings.method === "POST"
                ? t("每行：邮箱----编码请求体，或 邮箱----密码----编码请求体；邮箱及可识别字段顺序不限")
                : t("每行一个账号：自动识别邮箱、密码、邮件 API 和 2FA，字段顺序不限")}
            </label>
            <textarea
              id="batch-input"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={mailRequestSettings.method === "POST"
                ? t("a@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9\nb@example.com----账号密码----mailbox_id%3Did-b")
                : t("name@icloud.com----https://mail.example/messages/name\nhttps://mail.example/messages/name2|账号密码|name2@example.co.uk|BASE32二步验证密钥\nBASE32二步验证密钥::name3@example.dev::账号密码")}
              spellCheck="false"
              autoFocus
            />
            {batchLines.length > 0 ? (
              <div style={{ marginTop: 10, maxHeight: "34vh", overflowY: "auto", border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8 }}>
                <label style={{
                  position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 11px", borderBottom: "1px solid rgba(128,128,128,0.2)",
                  background: "var(--surface, #fff)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                }}>
                  <input type="checkbox" checked={batchAllChecked} onChange={toggleAllBatchLines} disabled={batchBusy} />
                  <span>{batchAllChecked ? tf("全选（{0}）", batchLines.length) : tf("已选 {0}/{1}", batchRunLines.length, batchLines.length)}</span>
                </label>
                {batchLines.map((line, index) => {
                  const checked = !batchUnchecked.has(line.raw);
                  return (
                    <label
                      key={`${line.raw}__${index}`}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "7px 11px",
                        borderBottom: "1px solid rgba(128,128,128,0.12)", fontSize: 13, cursor: "pointer",
                        background: checked ? "rgba(16,162,113,0.06)" : "transparent",
                      }}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleBatchLine(line.raw)} disabled={batchBusy} />
                      <span style={{ flex: 1, minWidth: 0, fontFamily: "ui-monospace, Menlo, monospace", wordBreak: "break-all", opacity: checked ? 1 : 0.5 }} title={line.raw}>
                        {line.email}
                      </span>
                      <button
                        type="button"
                        className="icon-button danger"
                        style={{ flex: "0 0 auto", minWidth: 28, height: 28, padding: 0 }}
                        title={t("移除")}
                        onClick={(event) => { event.preventDefault(); removeBatchLine(line.raw); }}
                        disabled={batchBusy}
                      >
                        <Trash2 size={15} />
                      </button>
                    </label>
                  );
                })}
              </div>
            ) : null}
            {batchError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{ts(batchError)}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setBatchOpen(false)} disabled={batchBusy}>{t("取消")}</button>
              <button type="submit" className="primary-button" disabled={!batchRunLines.length || batchBusy || batchRunLines.length > 500}>
                {batchBusy ? <LoaderCircle className="spin" size={17} /> : <ListPlus size={17} />}
                {tf("创建 {0} 条任务", batchRunLines.length || "")}
              </button>
            </div>
          </form>
        </div>
      )}
      {createOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !createBusy) setCreateOpen(false);
        }}>
          <form className="batch-dialog" onSubmit={submitCreateEmail} role="dialog" aria-modal="true" aria-labelledby="create-email-title">
            <div className="dialog-header">
              <div>
                <h2 id="create-email-title">{t("创建邮箱")}</h2>
                <span>{createResult ? tf("已创建 {0} 个邮箱 — 选择加入列表或复制", createResult.boxes.length) : t("创建临时邮箱，查看列表后加入批量添加框")}</span>
              </div>
              <button type="button" className="icon-button" onClick={() => { setCreateOpen(false); setCreateResult(null); }} disabled={createBusy} title={t("关闭")}>
                <X size={18} />
              </button>
            </div>
            {!createResult ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 4 }}>
                  <label style={createFieldLabel}>{t("根域名")}
                    <select style={createField} value={createRoot} onChange={(event) => { setCreateRoot(event.target.value); setCreateSub(""); }}>
                      {scopedMailRoots.map((r) => <option key={r.root} value={r.root}>{r.root}</option>)}
                    </select>
                  </label>
                  <label style={createFieldLabel}>{t("子域名")}
                    <select style={createField} value={createSub} onChange={(event) => setCreateSub(event.target.value)}>
                      <option value="">{t("(不使用子域名)")}</option>
                      {(scopedMailRoots.find((r) => r.root === createRoot)?.subdomains || []).map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label style={createFieldLabel}>{t("数量（1–50）")}
                    <input style={createField} type="number" min="1" max="50" value={createCount} onChange={(event) => setCreateCount(event.target.value)} />
                  </label>
                  <label style={createFieldLabel}>{t("标签（可选）")}
                    <input style={createField} type="text" value={createTag} onChange={(event) => setCreateTag(event.target.value)} placeholder="ChatGPT Team" />
                  </label>
                </div>
                <div style={{ fontSize: 12.5, opacity: 0.7, marginTop: 10 }}>
                  {t("将创建于：")} <b>{createSub || createRoot || "—"}</b>{createTag.trim() ? <> · {t("标签")} <b>{createTag.trim()}</b></> : null}
                </div>
                {createError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{ts(createError)}</div>}
                <div className="dialog-footer">
                  <button type="button" className="cancel-button" onClick={() => { setCreateOpen(false); setCreateResult(null); }} disabled={createBusy}>{t("取消")}</button>
                  <button type="submit" className="primary-button" disabled={createBusy || !(Number(createCount) >= 1 && Number(createCount) <= 50)}>
                    {createBusy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
                    {tf("创建 {0} 个邮箱", Number(createCount) || "")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, opacity: 0.85, margin: "6px 0 8px" }}>
                  {t("已创建")} <b>{createResult.boxes.length}</b> {t("个邮箱，域名")} <b>{createResult.domain}</b>
                  {createResult.tag ? <> · {t("标签")} <b>{createResult.tag}</b></> : null}
                  {createUnchecked.size > 0 ? <> · {tf("已选 {0}", createResult.boxes.length - createUnchecked.size)}</> : null}
                  {createResult.errors?.length ? <> · <span style={{ color: "#dc2626" }}>{tf("{0} 个错误", createResult.errors.length)}</span></> : null}
                </div>
                <div style={{ maxHeight: 270, overflowY: "auto", border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8 }}>
                  <label style={{
                    position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 11px", borderBottom: "1px solid rgba(128,128,128,0.2)",
                    background: "var(--surface, #fff)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                  }}>
                    <input
                      type="checkbox"
                      checked={createUnchecked.size === 0}
                      onChange={() => {
                        setCreateUnchecked((prev) => {
                          if (!prev.size) return new Set(createResult.boxes.map((box) => box.email));
                          return new Set();
                        });
                      }}
                    />
                    <span>{createUnchecked.size === 0
                      ? tf("全选（{0}）", createResult.boxes.length)
                      : tf("已选 {0}/{1}", createResult.boxes.length - createUnchecked.size, createResult.boxes.length)}</span>
                  </label>
                  {createResult.boxes.map((box) => {
                    const checked = !createUnchecked.has(box.email);
                    return (
                      <label
                        key={box.email}
                        style={{
                          display: "flex", alignItems: "center", gap: 10, padding: "7px 11px",
                          borderBottom: "1px solid rgba(128,128,128,0.12)", fontSize: 13, cursor: "pointer",
                          background: checked ? "rgba(16,162,113,0.06)" : "transparent",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setCreateUnchecked((prev) => {
                              const next = new Set(prev);
                              if (next.has(box.email)) next.delete(box.email); else next.add(box.email);
                              return next;
                            });
                          }}
                        />
                        <span style={{ flex: 1, minWidth: 0, fontFamily: "ui-monospace, Menlo, monospace", wordBreak: "break-all", opacity: checked ? 1 : 0.5 }}>{box.email}</span>
                        {box.tag ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "rgba(16,162,113,0.15)", color: "#10a271", whiteSpace: "nowrap" }}>{box.tag}</span> : null}
                      </label>
                    );
                  })}
                </div>
                {createResult.errors?.length ? (
                  <div className="dialog-error" role="alert" style={{ marginTop: 8 }}><CircleAlert size={15} />{createResult.errors.join("; ")}</div>
                ) : null}
                <div className="dialog-footer">
                  <button type="button" className="cancel-button" onClick={() => setCreateResult(null)}>{t("继续创建")}</button>
                  <button type="button" className="cancel-button" onClick={copyCreatedEmails} disabled={createUnchecked.size >= createResult.boxes.length}>{t("复制邮箱")}</button>
                  <button type="button" className="primary-button" onClick={sendCreatedToBatch} disabled={createUnchecked.size >= createResult.boxes.length}>
                    <ListPlus size={17} />
                    {tf("加入批量添加（{0}）", createResult.boxes.length - createUnchecked.size)}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
      {listOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setListOpen(false);
        }}>
          <div className="batch-dialog" role="dialog" aria-modal="true" aria-labelledby="mail-list-title">
            <div className="dialog-header">
              <div>
                <h2 id="mail-list-title">{t("邮箱列表")}</h2>
                <span>
                  {listBusy ? t("加载中…") : tf("{0}/{1} 个邮箱", visibleMailboxes.length, scopedMailboxes.length)}
                  {listSelected.size ? tf(" · 已选 {0}", listSelected.size) : ""}
                  {!listBusy && accountCreatedCount > 0
                    ? tf(" · 步骤 4 活跃 {0}", accountCreatedCount)
                    : ""}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className="icon-button" onClick={openMailboxList} disabled={listBusy} title={t("刷新")}>
                  <RefreshCw className={listBusy ? "spin" : ""} size={17} />
                </button>
                <button type="button" className="icon-button" onClick={() => setListOpen(false)} title={t("关闭")}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <input
                style={{ ...createField, marginTop: 0, flex: 1 }}
                type="text"
                value={listSearch}
                onChange={(event) => setListSearch(event.target.value)}
                placeholder={t("按邮箱、标签、类型搜索…")}
                spellCheck="false"
              />
              <button type="button" className="selection-text-button" onClick={toggleAllVisible} disabled={!visibleMailboxes.length}>
                {allVisibleSelected ? t("取消选择") : t("选择全部")}
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "12px 0 4px" }}>
              {accountFilterChips.map((chip) => {
                const active = listAccountFilter === chip.value;
                return (
                  <button
                    key={chip.value === null ? "__acct_all__" : chip.value}
                    type="button"
                    onClick={() => setListAccountFilter(chip.value)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      padding: "4px 11px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
                      border: active ? "1px solid var(--green)" : "1px solid rgba(128,128,128,0.3)",
                      background: active ? "var(--green)" : "transparent",
                      color: active ? "#fff" : "inherit",
                    }}
                  >
                    {chip.value === "created" ? <CheckCircle2 size={12} /> : chip.value === "uncreated" ? <Filter size={12} /> : chip.value === "deactivated" ? <CircleAlert size={12} /> : null}
                    {t(chip.label)}
                    <span style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>{chip.count}</span>
                  </button>
                );
              })}
            </div>
            {(() => {
              const uncreatedScoped = scopedMailboxes.filter((m) => !m.accountCreated && !m.deactivated).length;
              const untaggedScoped = scopedMailboxes.some((m) => !m.tag && !m.accountCreated && !m.deactivated);
              if (listBusy || (!uncreatedScoped && !untaggedScoped)) return null;
              return (
                <div style={{ display: "flex", gap: 6, margin: "6px 0 0", flexWrap: "wrap" }}>
                  {untaggedScoped && (
                    <button type="button" className="selection-text-button" onClick={batchTagUntagged} disabled={listTagging}>
                      {listTagging ? <LoaderCircle className="spin" size={13} /> : null}
                      {t("补打 ChatGPT Team 标签")}
                    </button>
                  )}
                  {uncreatedScoped > 0 && (
                    <button type="button" className="selection-text-button" style={{ color: "#dc2626" }} onClick={deactivateOrphans} disabled={listDeactivating}>
                      {listDeactivating ? <LoaderCircle className="spin" size={13} /> : <CircleAlert size={13} />}
                      {tf("停用未建号邮箱（{0}）", uncreatedScoped)}
                    </button>
                  )}
                </div>
              );
            })()}
            {listError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{ts(listError)}</div>}
            <div style={{ marginTop: 8, height: "52vh", overflowY: "auto", border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8 }}>
              {!listBusy && visibleMailboxes.length > 0 ? (
                <label style={{
                  position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 11px", borderBottom: "1px solid rgba(128,128,128,0.2)",
                  background: "var(--surface, #fff)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                }}>
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
                  <span>{tf("全选（{0}）", visibleMailboxes.length)}</span>
                </label>
              ) : null}
              {listBusy ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.7 }}><LoaderCircle className="spin" size={20} /></div>
              ) : visibleMailboxes.length === 0 ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.6, fontSize: 13 }}>{t("暂无邮箱")}</div>
              ) : (
                visibleMailboxes.map((m) => {
                  const cat = CATEGORY_STYLE[m.category] || { background: "rgba(128,128,128,0.14)", color: "#6b7280", label: m.category || "—" };
                  const checked = listSelected.has(m.email);
                  return (
                    <label
                      key={m.email}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "8px 11px",
                        borderBottom: "1px solid rgba(128,128,128,0.12)", fontSize: 13, cursor: "pointer",
                        background: checked ? "rgba(16,162,113,0.06)" : "transparent",
                      }}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleMailbox(m.email)} />
                      <span style={{ flex: 1, minWidth: 0, fontFamily: "ui-monospace, Menlo, monospace", wordBreak: "break-all", opacity: (m.suspended || m.deactivated) ? 0.55 : 1 }}>
                        {m.email}
                        {m.suspended ? <span style={{ marginLeft: 6, fontSize: 11, color: "#dc2626" }}>{t("(已锁定)")}</span> : null}
                      </span>
                      {m.deactivated ? (
                        <span
                          title={m.deactivatedReason ? ts(m.deactivatedReason) : t("账号已确认封禁、删除或永久停用")}
                          style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "rgba(220,38,38,0.14)", color: "#dc2626", whiteSpace: "nowrap" }}
                        >
                          <CircleAlert size={11} /> {t("已停用")}
                        </span>
                      ) : null}
                      {m.accountCreated && !m.deactivated ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "rgba(37,99,235,0.14)", color: "#2563eb", whiteSpace: "nowrap" }}>
                          <CheckCircle2 size={11} /> {t("已建号")}
                        </span>
                      ) : null}
                      {m.tag ? (
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "rgba(16,162,113,0.15)", color: "#10a271", whiteSpace: "nowrap" }}>{m.tag}</span>
                      ) : null}
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: cat.background, color: cat.color, whiteSpace: "nowrap" }}>{cat.label}</span>
                      <span style={{ fontSize: 11.5, opacity: 0.6, whiteSpace: "nowrap", minWidth: 92, textAlign: "right" }} title={m.last_message_at ? tf("最后邮件：{0}", m.last_message_at) : t("尚无邮件")}>
                        {m.last_message_at ? formatDateTime(m.last_message_at) : t("暂无邮件")}
                      </span>
                      <button
                        type="button"
                        className="icon-button danger"
                        style={{ flex: "0 0 auto", minWidth: 28, height: 28, padding: 0 }}
                        title={t("删除邮箱")}
                        onClick={(event) => { event.preventDefault(); deleteMailbox(m.email); }}
                        disabled={Boolean(listDeleting)}
                      >
                        {listDeleting === m.email ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                      </button>
                    </label>
                  );
                })
              )}
            </div>
            <div className="dialog-footer">
              <div style={{ marginRight: "auto", alignSelf: "center", fontSize: 12.5, opacity: 0.7 }}>
                {listSelected.size ? tf("已选 {0}", listSelected.size) : t("尚未选择邮箱")}
              </div>
              <button type="button" className="cancel-button" onClick={copySelectedMailboxes} disabled={!listSelected.size}>
                <Copy size={15} /> {t("复制邮箱")}
              </button>
              <button type="button" className="primary-button" onClick={sendSelectedToBatch} disabled={!listSelected.size}>
                <ListPlus size={17} />
                {t("加入批量添加")}
              </button>
            </div>
          </div>
        </div>
      )}
      {filterOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFilterOpen(false);
        }}>
          <form className="batch-dialog filter-dialog" onSubmit={applyEmailFilter} role="dialog" aria-modal="true" aria-labelledby="filter-title">
            <div className="dialog-header">
              <div>
                <h2 id="filter-title">{t("筛选账号")}</h2>
                <span>{tf("{0} 个邮箱", countBatchLines(filterText))}</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setFilterOpen(false)} title={t("关闭")}>
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="filter-input">{t("每行输入一个完整邮箱地址")}</label>
            <textarea
              id="filter-input"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder={"name1@icloud.com\nname2@icloud.com"}
              spellCheck="false"
              autoFocus
            />
            {filterError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{ts(filterError)}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setFilterOpen(false)}>{t("取消")}</button>
              <button type="submit" className="primary-button" disabled={!filterText.trim() || countBatchLines(filterText) > 500}>
                <Filter size={17} />{t("应用筛选")}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function EmptyState({ filtered = false }) {
  return (
    <tr>
      <td colSpan="7">
        <div className="empty-state">
          <div><Mail size={24} /></div>
          <h3>{filtered ? t("没有匹配账号") : t("暂无授权任务")}</h3>
          <p>{filtered ? t("当前筛选邮箱不在任务列表中。") : t("在右上方输入邮箱地址开始登录。")}</p>
        </div>
      </td>
    </tr>
  );
}

function JobRow({ job, token, expanded, onToggleLogs, onError, selected, onToggleSelected, selectionSupported, smsProviderAvailable, smsProvider, onUpload, sub2apiUploadAvailable, totpSetupAvailable, passwordAddAvailable, forceReloginAvailable, accountProxyUrl, proxyBatchMode, sub2apiConfig }) {
  // Ở chế độ nhiều IP: thao tác lại trên tài khoản giữ nguyên proxy đã gán (không gửi proxyUrl).
  const reuseProxyBody = () => (proxyBatchMode ? {} : { proxyUrl: accountProxyUrl.trim() });
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [changeProxyOpen, setChangeProxyOpen] = useState(false);
  const [poolProxies, setPoolProxies] = useState([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolError, setPoolError] = useState("");
  const [poolImportText, setPoolImportText] = useState("");
  const [changingKey, setChangingKey] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [resendCount, setResendCount] = useState(0);

  useEffect(() => setValue(""), [job.status]);
  // Đếm lại số lần gửi lại SMS mỗi khi đổi sang số điện thoại khác.
  useEffect(() => setResendCount(0), [job.currentPhone]);

  async function loadProxyPool() {
    setPoolLoading(true);
    setPoolError("");
    try {
      const data = await apiFetch(token, "/api/proxy-pool");
      setPoolProxies(Array.isArray(data.proxies) ? data.proxies : []);
    } catch (requestError) {
      setPoolError(requestError.message);
    } finally {
      setPoolLoading(false);
    }
  }

  function openChangeProxy() {
    setChangeProxyOpen(true);
    loadProxyPool();
  }

  // Retry the SAME failed proxy. Useful when the disconnect was transient and the
  // proxy still shows up in the pool list — no need to switch to a different one.
  async function reconnectProxy() {
    setReconnecting(true);
    onError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/reconnect-proxy`, { method: "POST" });
      if (data.reconnected) onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setReconnecting(false);
    }
  }

  async function importProxyPool() {
    if (!poolImportText.trim()) return;
    setPoolLoading(true);
    setPoolError("");
    try {
      const data = await apiFetch(token, "/api/proxy-pool/import", {
        method: "POST",
        body: JSON.stringify({ text: poolImportText }),
      });
      setPoolProxies(Array.isArray(data.proxies) ? data.proxies : []);
      setPoolImportText("");
    } catch (requestError) {
      setPoolError(requestError.message);
    } finally {
      setPoolLoading(false);
    }
  }

  async function chooseProxy(entry, confirmReuse = false) {
    setChangingKey(entry.key);
    setPoolError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/change-proxy`, {
        method: "POST",
        body: JSON.stringify({ poolKey: entry.key, confirmReuse, config: sub2apiConfig }),
      });
      if (data.needsReuseConfirm && !confirmReuse) {
        const ok = window.confirm(t("该代理线路曾被使用，但当前没有账号在用。确认要重复使用吗？"));
        if (ok) return chooseProxy(entry, true);
        return;
      }
      if (data.sub2apiSync && data.sub2apiSync.attempted && !data.sub2apiSync.ok) {
        onError(tf("代理已更换，但同步到 Sub2API 失败：{0}", ts(data.sub2apiSync.error || t("未知错误"))));
      } else {
        onError("");
      }
      setChangeProxyOpen(false);
    } catch (requestError) {
      setPoolError(requestError.message);
    } finally {
      setChangingKey("");
    }
  }

  async function sendInput(action, submittedValue = value) {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/input`, {
        method: "POST",
        body: JSON.stringify({ action, value: submittedValue }),
      });
      setValue("");
      onError("");
      if (action === "resend_phone") setResendCount((count) => count + 1);
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function retry() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: JSON.stringify(reuseProxyBody()),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function regenerate() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify(reuseProxyBody()),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function forceRelogin() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/relogin`, {
        method: "POST",
        body: JSON.stringify(reuseProxyBody()),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function setupTotp() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/setup-2fa`, {
        method: "POST",
        body: JSON.stringify(reuseProxyBody()),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function addPassword() {
    if (!window.confirm(t("确定为该账号生成并添加随机强密码吗？成功后会自动更新账号原始信息。"))) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/add-password`, {
        method: "POST",
        body: JSON.stringify(reuseProxyBody()),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyTotpSecret() {
    try {
      await navigator.clipboard.writeText(job.totpSetupSecret || "");
      onError("");
    } catch {
      onError(t("无法自动复制，请手动选择 2FA 密钥"));
    }
  }

  async function requestSmsNumber() {
    if (!smsProvider.ready) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sms-number`, {
        method: "POST",
        body: JSON.stringify({ providerId: smsProvider.id, config: smsProvider.config }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function download() {
    try {
      const response = await fetch(`/api/jobs/${job.id}/download`, {
        headers: { "x-console-token": token },
      });
      if (!response.ok) throw new Error((await response.json()).error || t("下载失败"));
      await saveDownloadResponse(response, `${job.email}-sub2api-import-oauth-${localTimestamp()}.json`);
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  const inputConfig = getInputConfig(job.status, job.currentPhone);
  const terminal = ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);

  return (
    <tr className={`job-row status-${job.status}`}>
      <td className="select-cell">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          disabled={!selectionSupported}
          aria-label={tf("选择 {0}", job.email)}
        />
      </td>
      <td>
        <div className="account-cell">
          <div className="account-avatar">{job.email.slice(0, 1).toUpperCase()}</div>
          <div className="account-details"><strong>{job.email}</strong><span>{shortId(job.id)}</span></div>
          <span className="account-badges">
            <LoginMethodBadge job={job} />
            <Sub2ApiUploadBadge job={job} />
          </span>
        </div>
      </td>
      <td>
        <div className="status-cell">
          <StatusBadge status={job.status} />
        </div>
      </td>
      <td className="step-cell">
        <div className="prompt-line">{ts(job.prompt)}</div>
        {job.lastError && !job.proxyConnectionError && <div className="row-error">{ts(extractResponseMessage(job.lastError))}</div>}
        {job.autoRepairBlocked && (
          <div className="row-error">{tf("号池监控已永久跳过：{0}", ts(extractResponseMessage(job.autoRepairBlockedReason || t("账号已不可用"))))}</div>
        )}
        {job.totpSetupError && <div className="row-error">{tf("2FA：{0}", ts(extractResponseMessage(job.totpSetupError)))}</div>}
        {job.passwordAddError && <div className="row-error">{tf("添加密码：{0}", ts(extractResponseMessage(job.passwordAddError)))}</div>}
        {job.proxyConnectionError && (
          <div className="proxy-error-banner" role="alert">
            <CircleAlert size={14} />
            <span>{job.failedProxyLabel ? tf("代理连接失败：{0} 无法连接", job.failedProxyLabel) : t("代理连接失败，请更换代理")}</span>
          </div>
        )}
        {job.mailApiError && job.status === "email_otp" && <div className="mail-error">{ts(job.mailApiError)}</div>}
        {job.currentPhone && ["working", "phone", "phone_otp"].includes(job.status) && (
          <div className="phone-target"><Smartphone size={13} />{t("当前手机号：")}<strong>{job.currentPhone}</strong></div>
        )}
        {job.phoneError && <div className="phone-error"><CircleAlert size={13} />{ts(job.phoneError)}</div>}
        {job.smsStatus && !["idle", "unavailable"].includes(job.smsStatus) && (
          <div className={`sms-status ${job.smsStatus === "error" ? "error" : ""}`}>
            {job.smsStatus === "error" ? <CircleAlert size={13} /> : <PhoneIncoming size={13} />}
            <span>{smsStatusText(job)}</span>
          </div>
        )}
        {job.status === "totp_setup_otp" && job.totpSetupSecret && (
          <div className="totp-setup-secret">
            <span>{t("2FA 密钥")}</span>
            <code>{job.totpSetupSecret}</code>
            <button type="button" className="icon-button" onClick={copyTotpSecret} title={t("复制 2FA 密钥")}>
              <Copy size={15} />
            </button>
          </div>
        )}
        {inputConfig && (
          <div className={`inline-entry${job.status === "phone_otp" ? " otp-inline" : ""}`}>
            <div className="compact-input">
              {inputConfig.icon}
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && value && !submitting) sendInput(inputConfig.action);
                }}
                inputMode={inputConfig.inputMode}
                type={inputConfig.type || "text"}
                placeholder={inputConfig.placeholder}
                aria-label={inputConfig.placeholder}
                autoComplete={inputConfig.autoComplete || "one-time-code"}
              />
            </div>
            <button
              type="button"
              className="icon-button submit"
              onClick={() => sendInput(inputConfig.action)}
              disabled={!value || submitting}
              title={inputConfig.submitLabel}
            >
              {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
            </button>
            {job.status === "email_otp" && (
              <button type="button" className="text-action" onClick={() => sendInput("resend_email", "")} disabled={submitting}>
                <RefreshCw size={14} />{t("重发")}
              </button>
            )}
            {job.status === "phone_otp" && (
              <>
                <button type="button" className="text-action" onClick={() => sendInput("resend_phone", "")} disabled={submitting}>
                  <RefreshCw size={14} />{t("重发")}
                </button>
                {resendCount > 0 && <span className="resend-counter">{tf("已重发 {0} 次", resendCount)}</span>}
                <button type="button" className="text-action" onClick={() => sendInput("change_phone", "")} disabled={submitting}>
                  <RotateCcw size={14} />{t("换号")}
                </button>
              </>
            )}
            {job.status === "phone" && smsProviderAvailable && (
              <>
                <span className="input-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="platform-number-button"
                  onClick={requestSmsNumber}
                  disabled={!smsProvider.ready || submitting || job.smsStatus === "requesting"}
                  title={smsProvider.ready ? tf("使用 {0} 取号", smsProvider.name) : t("请先完成接码平台配置")}
                >
                  {submitting || job.smsStatus === "requesting" ? <LoaderCircle className="spin" size={15} /> : <PhoneIncoming size={15} />}
                  {tf("{0}取号", smsProvider.name || t("平台"))}
                </button>
              </>
            )}
          </div>
        )}
      </td>
      <td className="time-cell"><time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time></td>
      <td className="operation-time-cell">
        <time dateTime={job.lastOperationAt || job.createdAt}>{formatDateTime(job.lastOperationAt || job.createdAt)}</time>
        <span>{operationLabel(job.lastOperationType)}</span>
      </td>
      <td>
        <div className="row-actions">
          {job.canDownload && (
            <button type="button" className="download-button" onClick={download}>
              <Download size={16} />{t("下载")}
            </button>
          )}
          {job.canDownload && sub2apiUploadAvailable && (
            <button type="button" className="secondary-button" onClick={onUpload} disabled={submitting} title={t("上传到已配置的 Sub2API 号池")}>
              <Send size={16} />{t("上传")}
            </button>
          )}
          {job.canRegenerate && (
            <button type="button" className="regenerate-button" onClick={regenerate} disabled={submitting} title={t("重新授权：优先使用刷新令牌，失效后自动重新登录")}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              {t("重新授权")}
            </button>
          )}
          {forceReloginAvailable && job.canForceRelogin && (
            <button type="button" className="relogin-button" onClick={forceRelogin} disabled={submitting} title={t("跳过刷新令牌和旧检查点，完整重新登录后自动授权")}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
              {t("重新登录并授权")}
            </button>
          )}
          {totpSetupAvailable && job.canSetupTotp && (
            <button type="button" className="icon-button" onClick={setupTotp} disabled={submitting} title={t("设置 2FA")}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
            </button>
          )}
          {passwordAddAvailable && job.canAddPassword && (
            <button type="button" className="icon-button" onClick={addPassword} disabled={submitting} title={t("添加密码")}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
            </button>
          )}
          {job.canRetry && (
            <button type="button" className="retry-button" onClick={retry} disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              {job.securityCheckRequired ? t("手动重试") : job.canResume ? t("继续流程") : t("重新授权")}
            </button>
          )}
          {job.canReconnectProxy && (
            <button type="button" className="retry-button" onClick={reconnectProxy} disabled={submitting || reconnecting} title={t("重新测试并使用原代理继续登录，适用于代理只是临时断开的情况")}>
              {reconnecting ? <LoaderCircle className="spin" size={16} /> : <Plug size={16} />}{t("重新连接")}
            </button>
          )}
          {job.canChangeProxy && (
            <button type="button" className="relogin-button" onClick={openChangeProxy} disabled={submitting || reconnecting} title={t("从系统代理池中选择一个未使用过的代理替换失败的代理")}>
              <RefreshCw size={16} />{t("更换代理")}
            </button>
          )}
          <button type="button" className="icon-button" onClick={onToggleLogs} title={expanded ? t("收起日志") : t("查看日志")}>
            <FileText size={17} />
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {!terminal && (
            <button type="button" className="icon-button danger" onClick={cancel} disabled={submitting} title={t("取消任务")}>
              <Ban size={17} />
            </button>
          )}
        </div>
        {changeProxyOpen && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setChangeProxyOpen(false);
          }}>
            <div className="batch-dialog proxy-list-dialog" role="dialog" aria-modal="true" aria-labelledby={`change-proxy-title-${job.id}`}>
              <div className="dialog-header">
                <div>
                  <h2 id={`change-proxy-title-${job.id}`}>{t("更换代理")}</h2>
                  <span>{job.failedProxyLabel ? tf("失败代理：{0}。请选择一个未使用过的代理。", job.failedProxyLabel) : t("请从系统代理池中选择一个未使用过的代理")}</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="icon-button" onClick={loadProxyPool} disabled={poolLoading} title={t("刷新")}>
                    <RefreshCw className={poolLoading ? "spin" : ""} size={17} />
                  </button>
                  <button type="button" className="icon-button" onClick={() => setChangeProxyOpen(false)} title={t("关闭")}>
                    <X size={18} />
                  </button>
                </div>
              </div>

              <div className="proxy-bulk">
                <div className="proxy-bulk-head"><ListPlus size={16} /> {t("将代理导入系统代理池")}</div>
                <textarea
                  value={poolImportText}
                  onChange={(event) => setPoolImportText(event.target.value)}
                  placeholder={"116.96.82.180:22030:user:pass\n116.96.82.180:23030:user:pass"}
                  spellCheck="false"
                />
                <div className="proxy-bulk-actions">
                  <button type="button" className="secondary-button" onClick={importProxyPool} disabled={poolLoading || !poolImportText.trim()}>
                    <Plus size={15} />{t("导入")}
                  </button>
                </div>
              </div>

              {poolError && <div className="dialog-error" role="alert" style={{ marginTop: 12 }}><CircleAlert size={15} />{ts(poolError)}</div>}

              <div className="proxy-pool-list">
                {poolProxies.filter((entry) => !entry.used).length ? (
                  poolProxies.filter((entry) => !entry.used).map((entry) => (
                    <div className="proxy-pool-row" key={entry.key}>
                      <div className="proxy-pool-meta">
                        <strong>{entry.label}</strong>
                        <span>{entry.protocol}</span>
                      </div>
                      <button type="button" className="secondary-button" onClick={() => chooseProxy(entry)} disabled={Boolean(changingKey)}>
                        {changingKey === entry.key ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                        {t("选择")}
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="proxy-pool-empty">{poolLoading ? t("正在加载...") : t("代理池中没有未使用过的代理，请先在上方导入")}</div>
                )}
              </div>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

function JobLogs({ token, jobId }) {
  const [logs, setLogs] = useState(t("正在读取日志..."));

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, `/api/jobs/${jobId}/logs`);
        if (!stopped) setLogs(data.logs || t("暂无日志"));
      } catch (error) {
        if (!stopped) setLogs(tf("日志读取失败：{0}", ts(error.message)));
      }
    };
    load();
    const timer = window.setInterval(load, 1_200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, token]);

  return (
    <div className="log-panel">
      <div className="log-title"><FileText size={15} />{t("协议日志")}</div>
      <pre>{tsLines(logs)}</pre>
    </div>
  );
}

function StatusBadge({ status }) {
  const config = {
    idle: [t("待启动"), <Play size={14} />],
    queued: [t("排队中"), <LoaderCircle size={14} />],
    starting: [t("启动中"), <LoaderCircle className="spin" size={14} />],
    working: [t("处理中"), <LoaderCircle className="spin" size={14} />],
    password: [t("待密码"), <KeyRound size={14} />],
    mfa_otp: [t("待 2FA"), <ShieldCheck size={14} />],
    totp_starting: [t("准备 2FA"), <LoaderCircle className="spin" size={14} />],
    password_add_starting: [t("准备密码"), <LoaderCircle className="spin" size={14} />],
    totp_setup_otp: [t("激活 2FA"), <ShieldCheck size={14} />],
    email_otp: [t("待邮箱码"), <Mail size={14} />],
    phone: [t("待手机号"), <Smartphone size={14} />],
    phone_otp: [t("待手机码"), <Smartphone size={14} />],
    finalizing: [t("生成中"), <LoaderCircle className="spin" size={14} />],
    refreshing: [t("刷新授权"), <RefreshCw className="spin" size={14} />],
    completed: [t("已完成"), <Check size={14} />],
    failed: [t("失败"), <CircleAlert size={14} />],
    canceled: [t("已取消"), <Ban size={14} />],
    reauth_required: [t("待重新授权"), <RefreshCw size={14} />],
    resume_available: [t("可继续"), <RotateCcw size={14} />],
    proxy_error: [t("代理连接失败"), <CircleAlert size={14} />],
  }[status] || [status, null];
  return <span className={`status-badge ${status}`}>{config[1]}{config[0]}</span>;
}

function LoginMethodBadge({ job }) {
  if (job.loginMode === "password") {
    const methods = [t("密码"), job.autoEmailOtp ? t("自动收码") : "", job.hasTotpKey ? "2FA" : ""].filter(Boolean);
    return (
      <span className="mail-mode password-mode">
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <KeyRound size={12} />}
        {methods.join(" + ")}
      </span>
    );
  }
  if (job.autoEmailOtp) {
    return (
      <span className={`mail-mode ${["error", "timeout"].includes(job.mailStatus) ? "error" : ""}`}>
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <MailCheck size={12} />}
        {job.hasTotpKey ? t("自动收码 + 2FA") : t("自动收码")}
      </span>
    );
  }
  if (job.loginMode === "manual") {
    return (
      <span className="mail-mode unknown-mode">
        <CircleAlert size={12} />{t("旧任务资料未记录")}
      </span>
    );
  }
  if (!job.hasTotpKey) return null;
  return (
    <span className="mail-mode">
      <ShieldCheck size={12} />{t("邮箱码 + 2FA")}
    </span>
  );
}

function Sub2ApiUploadBadge({ job }) {
  if (!job.sub2apiUploadedAt) return null;
  const when = formatDateTime(job.sub2apiUploadedAt);
  const target = job.sub2apiUploadedBaseUrl ? ` · ${job.sub2apiUploadedBaseUrl}` : "";
  return (
    <span className="mail-mode sub2api-uploaded" title={tf("已于 {0} 上传到 Sub2API{1}", when, target)}>
      <CloudUpload size={12} />{t("已上传 Sub2API")}
    </span>
  );
}

function getInputConfig(status, currentPhone) {
  if (status === "password") {
    return { action: "password", placeholder: t("输入账号密码"), submitLabel: t("提交密码"), inputMode: "text", type: "password", autoComplete: "current-password", icon: <KeyRound size={15} /> };
  }
  if (status === "mfa_otp") {
    return { action: "mfa_otp", placeholder: t("6 位 2FA 验证码"), submitLabel: t("提交 2FA 验证码"), inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "totp_setup_otp") {
    return { action: "totp_setup_otp", placeholder: t("新 2FA 的 6 位验证码"), submitLabel: t("激活新的 2FA"), inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "email_otp") {
    return { action: "email_otp", placeholder: t("6 位邮箱验证码"), submitLabel: t("提交邮箱验证码"), inputMode: "numeric", icon: <Mail size={15} /> };
  }
  if (status === "phone") {
    return { action: "phone", placeholder: "+60123456789", submitLabel: t("发送手机验证码"), inputMode: "tel", icon: <Smartphone size={15} /> };
  }
  if (status === "phone_otp") {
    return { action: "phone_otp", placeholder: currentPhone ? tf("{0} 的验证码", currentPhone) : t("手机验证码"), submitLabel: t("提交手机验证码"), inputMode: "numeric", icon: <Smartphone size={15} /> };
  }
  return null;
}

function smsStatusText(job) {
  const providerName = ts(job.smsProviderName) || t("接码平台");
  if (job.smsError) return tf("{0}：{1}", providerName, ts(job.smsError));
  return {
    requesting: tf("{0}：正在获取手机号", providerName),
    number_acquired: tf("{0}：已获取手机号，正在发送验证码", providerName),
    waiting_sms: tf("{0}：验证码已发送，正在等待短信", providerName),
    submitting: tf("{0}：已收到验证码，正在自动提交", providerName),
    submitted: tf("{0}：验证码已自动提交", providerName),
    manual_submitted: tf("{0}：已停止自动读取，正在验证手动输入的验证码", providerName),
    completed: tf("{0}：手机验证已通过，订单已完成", providerName),
  }[job.smsStatus] || tf("{0}：处理中", providerName);
}

async function saveDownloadResponse(response, fallbackName) {
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = downloadFilename(response.headers.get("content-disposition")) || fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function downloadFilename(contentDisposition) {
  if (!contentDisposition) return "";
  const encodedMatch = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentDisposition);
  const rawName = encodedMatch?.[1] || plainMatch?.[1] || plainMatch?.[2] || "";
  try {
    return decodeURIComponent(rawName.trim().replace(/^"|"$/g, "")).replace(/[\\/]/g, "_");
  } catch {
    return rawName.trim().replace(/^"|"$/g, "").replace(/[\\/]/g, "_");
  }
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatMonitorResult(result) {
  if (!result || typeof result !== "object") return t("号池巡检已完成");
  const parts = [tf("检查 {0} 条异常记录", Number(result.checked || 0))];
  if (result.started) parts.push(tf("已启动自动修复 {0} 条", result.started));
  if (result.updated) parts.push(tf("已更新 {0} 条", result.updated));
  if (result.blocked) parts.push(tf("永久跳过 {0} 条", result.blocked));
  if (result.ineligible) parts.push(tf("需人工 {0} 条", result.ineligible));
  if (result.disabled) parts.push(tf("已停止调度 {0} 条", result.disabled));
  if (result.missingTask) parts.push(tf("本地无任务 {0} 条", result.missingTask));
  if (result.busy) parts.push(tf("正在运行 {0} 条", result.busy));
  if (result.cooldown) parts.push(tf("冷却中 {0} 条", result.cooldown));
  return parts.join(getLang() === "zh" ? "，" : ", ");
}

function formatRelativeMonitorTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return t("刚刚检查");
  if (elapsed < 60_000) return t("刚刚检查");
  if (elapsed < 60 * 60_000) return tf("{0} 分钟前检查", Math.floor(elapsed / 60_000));
  return tf("{0} 小时前检查", Math.floor(elapsed / (60 * 60_000)));
}

const UNTAGGED = "\u0000untagged"; // sentinel for mailboxes without a tag in the "Danh sách email" filter
const CATEGORY_STYLE = {
  admin: { background: "rgba(59,130,246,0.14)", color: "#2563eb", label: "admin" },
  personal: { background: "rgba(139,92,246,0.14)", color: "#7c3aed", label: "personal" },
  user: { background: "rgba(107,114,128,0.15)", color: "#6b7280", label: "user" },
  suspended: { background: "rgba(220,38,38,0.14)", color: "#dc2626", label: "suspended" },
};
const createField = {
  width: "100%",
  marginTop: 4,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid rgba(128,128,128,0.35)",
  background: "rgba(128,128,128,0.08)",
  color: "inherit",
  font: "inherit",
};
const createFieldLabel = { display: "block", fontSize: 12.5, opacity: 0.7 };

// Convert a proxy string to a full URL with the chosen scheme. Accepts the
// "host:port:user:pass" (or "host:port") colon form that most providers give,
// and an existing scheme://… URL (just swaps the scheme).
// Parse a pasted proxy list into entries with a detected protocol. Understands:
//   - "# ... HTTP 22030 / SOCKS5 23030" header lines that map port → protocol
//   - within a block, the 1st data line is HTTP and the 2nd is SOCKS5 (fallback)
//   - data lines like host:port:user:pass, host:port, or full scheme URLs
// Returns [{ protocol: "http"|"socks5h", host, port, user, pass, url, label }].
function parseProxyPasteList(text) {
  const entries = [];
  let httpPort = null;
  let socksPort = null;
  let lineInBlock = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith("//") || line.startsWith(";")) {
      const httpM = line.match(/HTTPS?\s*[:#=/-]?\s*(\d{2,5})/i);
      const socksM = line.match(/SOCKS\s*5?H?\s*[:#=/-]?\s*(\d{2,5})/i);
      httpPort = httpM ? Number(httpM[1]) : null;
      socksPort = socksM ? Number(socksM[1]) : null;
      lineInBlock = 0;
      continue;
    }
    let host = "";
    let port = 0;
    let user = "";
    let pass = "";
    let protocol = "";
    let ambiguous = false; // true = không có tín hiệu rõ về giao thức (nút SOCKS5/HTTP tự quyết)
    const schemeM = line.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (schemeM) {
      protocol = /socks/i.test(schemeM[1]) ? "socks5h" : "http";
      try {
        const u = new URL(line);
        host = u.hostname;
        port = Number(u.port);
        user = decodeURIComponent(u.username || "");
        pass = decodeURIComponent(u.password || "");
      } catch { lineInBlock += 1; continue; }
    } else {
      const parts = line.split(":").map((p) => p.trim());
      if (parts.length < 2) { lineInBlock += 1; continue; }
      host = parts[0];
      port = Number(parts[1]);
      user = parts[2] || "";
      pass = parts[3] || "";
    }
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) { lineInBlock += 1; continue; }
    if (!protocol) {
      if (socksPort && port === socksPort) protocol = "socks5h";
      else if (httpPort && port === httpPort) protocol = "http";
      else if (httpPort || socksPort) protocol = lineInBlock % 2 === 1 ? "socks5h" : "http"; // có header → đoán theo thứ tự dòng
      else { protocol = "socks5h"; ambiguous = true; } // không header, không scheme → để nút chọn; mặc định SOCKS5
    }
    const auth = user ? `${user}:${pass}@` : "";
    entries.push({ protocol, ambiguous, host, port, user, pass, url: `${protocol}://${auth}${host}:${port}`, label: line });
    lineInBlock += 1;
  }
  return entries;
}

// Chuẩn hoá 1 khối proxy (nhiều dòng, nhận cả host:port:user:pass lẫn scheme://…)
// về dạng URL đầy đủ mỗi dòng, để backend (chỉ hiểu scheme://…) parse được.
// Dòng không ghi rõ giao thức (host:port:user:pass) dùng `defaultProtocol`
// (mặc định socks5h); dòng đã có scheme thì giữ nguyên giao thức của nó.
function normalizeProxyText(text, defaultProtocol) {
  return parseProxyPasteList(text).map((e) => {
    const protocol = defaultProtocol && e.ambiguous ? defaultProtocol : e.protocol;
    const auth = e.user ? `${e.user}:${e.pass}@` : "";
    return `${protocol}://${auth}${e.host}:${e.port}`;
  }).join("\n");
}

function toProxyUrl(value, scheme) {
  const text = String(value || "").trim();
  if (!text) return "";
  const hasScheme = text.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i);
  if (hasScheme) return `${scheme}://${hasScheme[1]}`;
  const parts = text.split(":").map((p) => p.trim());
  if (parts.length === 4) return `${scheme}://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  if (parts.length === 2) return `${scheme}://${parts[0]}:${parts[1]}`;
  return `${scheme}://${text}`;
}

async function apiFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-console-token": token,
      ...(options.headers || {}),
    },
  });
  return readResponse(response);
}

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || tf("请求失败：HTTP {0}", response.status));
  return data;
}

function shortId(id) {
  return tf("任务 {0}", id.slice(0, 8));
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(currentLocale(), {
    ...(isToday ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function operationLabel(type) {
  return ({
    initial_authorization: t("首次授权"),
    reauthorize: t("重新授权"),
    relogin: t("重新登录并授权"),
    automatic_relogin: t("号池自动重登并授权"),
    resume: t("继续中断流程"),
    setup_2fa: t("设置 2FA"),
    add_password: t("添加密码"),
    account_update: t("更新账号资料"),
    proxy_update: t("更新代理 IP"),
  })[type] || t("账号操作");
}

function countBatchLines(value) {
  return String(value || "").split(/\r?\n/).filter((line) => line.trim()).length;
}

// Rút địa chỉ email để hiển thị trong danh sách "Thêm hàng loạt"; dòng vẫn giữ
// nguyên định dạng gốc (email----body, url|pass|email|totp, …) khi gửi lên server.
function extractLineEmail(raw) {
  const match = String(raw || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match ? match[0] : String(raw || "").trim();
}

// Every distinct email found in free-form text (lower-cased), in order of appearance.
function extractEmails(value) {
  const matches = String(value || "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || [];
  return [...new Set(matches)];
}

function parseEmailFilter(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (!lines.length) throw new Error(t("请至少输入一个筛选邮箱"));
  if (lines.length > 500) throw new Error(t("一次最多筛选 500 个邮箱"));
  lines.forEach((email, index) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error(tf("第 {0} 行邮箱格式错误", index + 1));
    }
  });
  return [...new Set(lines)];
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function readLocalSetting(key) {
  try {
    return settingsStore.getItem(key) || "";
  } catch {
    return "";
  }
}

function readLocalTextSetting(key) {
  let value = readLocalSetting(key).trim();
  for (let attempt = 0; attempt < 4 && value; attempt += 1) {
    if (!(value.startsWith('"') && value.endsWith('"'))) return value;
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") return value;
      value = decoded.trim();
    } catch {
      return value;
    }
  }
  return value;
}

function readSmsProviderSettings() {
  try {
    const stored = JSON.parse(settingsStore.getItem(SMS_PROVIDER_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object" && stored.configs && typeof stored.configs === "object") {
      return stored;
    }
  } catch {}
  return {
    selectedProviderId: "luban",
    configs: {
      luban: {
        apiKey: readLocalSetting(LUBAN_API_KEY_STORAGE_KEY),
        serviceId: readLocalSetting(LUBAN_SERVICE_ID_STORAGE_KEY),
      },
    },
  };
}

function normalizeMailRequestSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  let headersText = typeof stored.headersText === "string" ? stored.headersText : "";
  if (!headersText && stored.headers && typeof stored.headers === "object" && !Array.isArray(stored.headers)) {
    headersText = JSON.stringify(stored.headers, null, 2);
  }
  return {
    method: String(stored.method || "GET").toUpperCase() === "POST" ? "POST" : "GET",
    url: typeof stored.url === "string" ? stored.url.trim() : "",
    headersText: headersText.trim() || "{}",
    // Root-domain allow-list scoping "Tạo email" + "Danh sách email"; empty = tất cả domain.
    domains: Array.isArray(stored.domains) ? stored.domains.filter((d) => typeof d === "string" && d) : [],
  };
}

function readMailRequestSettings(value) {
  try {
    const stored = value || JSON.parse(settingsStore.getItem(MAIL_REQUEST_SETTINGS_KEY) || "null");
    return normalizeMailRequestSettings(stored);
  } catch {
    return normalizeMailRequestSettings({});
  }
}

function buildMailRequestConfig(settings) {
  const normalized = normalizeMailRequestSettings(settings);
  let headers;
  try {
    headers = JSON.parse(normalized.headersText || "{}");
  } catch {
    throw new Error(t("请求头必须是有效的 JSON 对象"));
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error(t("请求头必须是 JSON 对象，例如 {\"Authorization\":\"Bearer ...\"}"));
  }
  if (normalized.method === "POST") {
    try {
      const parsedUrl = new URL(normalized.url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
    } catch {
      throw new Error(t("POST 模式必须填写有效的 HTTP 或 HTTPS 请求 URL"));
    }
  }
  return {
    method: normalized.method,
    url: normalized.method === "POST" ? normalized.url : "",
    headers,
  };
}

function formatMailRequestSummary(settings) {
  try {
    const config = buildMailRequestConfig(settings);
    const headerCount = Object.keys(config.headers).length;
    return `${config.method === "POST" ? t("已配置统一 URL · ") : ""}${tf("{0} 个请求头", headerCount)}`;
  } catch {
    return t("配置需要检查");
  }
}

function normalizeSub2ApiSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  const rawGroupIds = Array.isArray(stored.groupIds)
    ? stored.groupIds
    : String(stored.groupId || "").trim()
      ? [stored.groupId]
      : [];
  return {
    baseUrl: String(stored.baseUrl || ""),
    adminApiKey: String(stored.adminApiKey || ""),
    groupIds: [...new Set(rawGroupIds.map((id) => String(id).trim()).filter(Boolean))],
    proxyId: String(stored.proxyId || ""),
    concurrency: String(stored.concurrency ?? ""),
    loadFactor: String(stored.loadFactor ?? ""),
    priority: String(stored.priority ?? ""),
    modelWhitelist: String(stored.modelWhitelist || ""),
    codexFingerprintMode: ["off", "device", "session", "full"].includes(stored.codexFingerprintMode)
      ? stored.codexFingerprintMode
      : "session",
    monitorEnabled: stored.monitorEnabled === true,
  };
}

function readSub2ApiSettings(value) {
  try {
    const stored = value || JSON.parse(settingsStore.getItem(SUB2API_UPLOAD_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object") return normalizeSub2ApiSettings(stored);
  } catch {}
  return normalizeSub2ApiSettings({});
}

function formatSub2ApiProxy(proxy) {
  const protocol = String(proxy.protocol || "http").replace(/:\/\/$/, "");
  const host = String(proxy.host || "");
  const port = proxy.port ? `:${proxy.port}` : "";
  const endpoint = host ? `${protocol}://${host}${port}` : t("地址未知");
  const ip = String(proxy.ipAddress || "").trim();
  const name = ts(proxy.name) || tf("代理 {0}", proxy.id);
  return ip ? tf("{0} | 出口 IP：{1}", `${name} | ${endpoint}`, ip) : `${name} | ${endpoint}`;
}

function withSmsProviderDefaults(definitions, settings) {
  const configs = { ...(settings?.configs || {}) };
  definitions.forEach((provider) => {
    const current = { ...(configs[provider.id] || {}) };
    provider.fields.forEach((field) => {
      if (!String(current[field.key] || "").trim() && field.defaultValue) current[field.key] = field.defaultValue;
    });
    configs[provider.id] = current;
  });
  const selectedProviderId = definitions.some((provider) => provider.id === settings?.selectedProviderId)
    ? settings.selectedProviderId
    : definitions[0]?.id || settings?.selectedProviderId || "luban";
  return { selectedProviderId, configs };
}

function resolveSmsProvider(definitions, settings) {
  const normalized = withSmsProviderDefaults(definitions, settings || {});
  const definition = definitions.find((provider) => provider.id === normalized.selectedProviderId) || null;
  const config = definition ? normalized.configs[definition.id] || {} : {};
  const requiredFieldsReady = Boolean(definition) && definition.fields.every((field) => (
    field.required === false || String(config[field.key] || "").trim()
  ));
  const customEntries = definition?.id === "custom" ? inspectCustomSmsEntries(config.entries) : null;
  const ready = requiredFieldsReady && !customEntries?.error;
  const summary = definition?.id === "custom"
    ? (customEntries?.count ? tf("{0} 个号码", customEntries.count) : "")
    : definition
    ? definition.fields
      .filter((field) => field.summary || field.summaryKey)
      .map((field) => ts(config[field.summaryKey || field.key]))
      .filter(Boolean)
      .join(" / ")
    : "";
  return {
    id: definition?.id || "",
    name: ts(definition?.name || ""),
    definition,
    config,
    ready,
    summary,
  };
}

function inspectCustomSmsEntries(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { count: 0, error: t("请粘贴至少一条手机号和接码 API") };
  if (lines.length > 500) return { count: 0, error: t("自定义接码一次最多导入 500 条") };
  const phones = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const delimiterAt = lines[index].indexOf("----");
    if (delimiterAt < 0) return { count: 0, error: tf("第 {0} 行格式错误，请使用 手机号----接码API", index + 1) };
    const phone = lines[index].slice(0, delimiterAt).trim();
    const apiUrl = lines[index].slice(delimiterAt + 4).trim();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return { count: 0, error: tf("第 {0} 行手机号必须使用 +861871291167 这种国际格式", index + 1) };
    }
    try {
      const parsed = new URL(apiUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      return { count: 0, error: tf("第 {0} 行接码 API 必须是有效的 HTTP 或 HTTPS 地址", index + 1) };
    }
    phones.add(phone);
  }
  return { count: phones.size, error: "" };
}

function formatSmsCountryName(option) {
  return regionLabel(option.iso) || ts(option.title) || tf("国家 {0}", option.country);
}

// The dialog can outlive a server restart, so tolerate a reply in an older shape instead of crashing on it.
function normalizeSmsCodeCatalog(options) {
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    balance: options?.balance || null,
    platforms: list(options?.platforms),
    platformId: String(options?.platformId || ""),
    countries: list(options?.countries),
    countryId: String(options?.countryId || ""),
    operators: list(options?.operators).map((operator) => ({ ...operator, tiers: list(operator?.tiers) })),
    loadedAt: Date.now(),
  };
}

// One consistent SMSCode configuration for what the catalog offers, keeping saved choices that are still valid.
function pickSmsCodeSelection(catalog, config) {
  const platform = catalog.platforms.find((item) => item.value === catalog.platformId);
  const country = catalog.countries.find((item) => item.value === catalog.countryId);
  const operator = country
    ? catalog.operators.find((item) => item.value === String(config.operatorId || "")) || catalog.operators[0]
    : null;
  const tier = operator
    ? operator.tiers.find((item) => item.value === String(config.maxPriceIdr || ""))
      || operator.tiers.find((item) => item.value === operator.defaultTier)
      || operator.tiers[0]
    : null;
  const operatorLabel = operator?.value ? operator.label : "";
  return {
    platformId: catalog.platformId,
    platformLabel: platform?.label || "",
    countryId: country?.value || "",
    countryLabel: country?.label || "",
    catalogProductId: country?.catalogProductId || "",
    operatorId: operator?.value || "",
    operatorLabel,
    maxPriceIdr: tier?.value || "",
    maxPrice: tier?.price || "",
    serviceLabel: tier ? [platform?.label, country.label, operatorLabel, tier.priceLabel].filter(Boolean).join(" · ") : "",
  };
}

function formatSmsCodeCountry(country) {
  const name = [country.emoji, country.label, country.dialCode ? `(${country.dialCode})` : ""].filter(Boolean).join(" ");
  return country.priceLabel ? `${name} · ${tf("{0} 起", country.priceLabel)}` : name;
}

function SmsCodeField({ field, config, catalog, loading, platformItems, countryItems, onQuery, onChangeSelection, onUpdate }) {
  const label = ts(field.label);
  const operators = catalog?.operators || [];
  const operator = operators.find((item) => item.value === String(config.operatorId || "")) || null;
  const tiers = operator?.tiers || [];
  // Before the first query the saved choice is shown as text; the lists only exist once the catalog is loaded.
  const savedOnly = !catalog && Boolean(config.catalogProductId);

  if (field.type === "smscode-platform") {
    const info = catalog
      ? [
        catalog.balance ? `${t("余额")}: ${catalog.balance}` : "",
        loading ? "" : tf("{0} 个国家可用", catalog.countries.length),
      ].filter(Boolean).join(" · ")
      : t("一次查询即可加载平台、国家、运营商和价格");
    return (
      <div className="settings-field wide-settings-field">
        <span>{label}</span>
        <div className="smscode-field">
          <div className="smscode-query-row">
            <button type="button" className="price-refresh-button" onClick={onQuery} disabled={loading}>
              {loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
              {loading ? t("查询中") : t("查询服务")}
            </button>
            <span className="smscode-query-info">{info}</span>
          </div>
          <SearchPicker
            icon={<Settings2 size={15} />}
            items={platformItems}
            value={config.platformId || ""}
            placeholder={config.platformLabel || t("查询服务后选择平台")}
            searchPlaceholder={t("搜索平台")}
            emptyText={t("没有匹配的平台")}
            ariaLabel={label}
            disabled={!catalog || loading}
            onSelect={(platformId) => onChangeSelection({ platformId, platformLabel: "", countryId: "" })}
          />
        </div>
      </div>
    );
  }

  if (field.type === "smscode-country") {
    let placeholder = config.countryLabel || t("查询服务后选择国家");
    if (loading) placeholder = t("加载中…");
    else if (catalog) placeholder = countryItems.length > 0 ? t("选择国家") : t("该平台暂无可用国家");
    return (
      <div className="settings-field wide-settings-field">
        <span>{label}</span>
        <div className="smscode-field">
          <SearchPicker
            key={catalog?.loadedAt || "idle"}
            defaultOpen={Boolean(catalog) && !catalog.countryId && countryItems.length > 0}
            icon={<Globe2 size={15} />}
            items={countryItems}
            value={config.countryId || ""}
            placeholder={placeholder}
            searchPlaceholder={t("搜索国家、区号或代码")}
            emptyText={t("没有匹配的国家")}
            ariaLabel={label}
            disabled={!catalog || loading || countryItems.length === 0}
            onSelect={(countryId) => onChangeSelection({ countryId })}
          />
        </div>
      </div>
    );
  }

  if (field.type === "smscode-operator") {
    let placeholder = t("选择国家后显示运营商");
    if (loading) placeholder = t("加载中…");
    else if (savedOnly) placeholder = config.operatorLabel || ts("不限运营商");
    return (
      <div className="settings-field">
        <span>{label}</span>
        <div className="smscode-field">
          <div className="price-select-box">
            <Smartphone size={15} />
            <select
              value={operator ? operator.value : ""}
              onChange={(event) => onUpdate(pickSmsCodeSelection(catalog, { ...config, operatorId: event.target.value, maxPriceIdr: "" }))}
              disabled={loading || operators.length === 0}
              aria-label={label}
            >
              {operators.length === 0 && <option value="">{placeholder}</option>}
              {operators.map((item) => (
                <option key={item.value} value={item.value}>
                  {`${ts(item.label)} · ${tf("{0} 起", item.tiers[0]?.priceLabel)}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    );
  }

  let placeholder = t("选择国家后显示价格");
  if (loading) placeholder = t("加载中…");
  else if (savedOnly && config.maxPrice) placeholder = `$${config.maxPrice}`;
  return (
    <div className="settings-field">
      <span>{label}</span>
      <div className="smscode-field">
        <div className="price-select-box">
          <Settings2 size={15} />
          <select
            value={tiers.some((tier) => tier.value === String(config.maxPriceIdr || "")) ? String(config.maxPriceIdr) : ""}
            onChange={(event) => onUpdate(pickSmsCodeSelection(catalog, { ...config, maxPriceIdr: event.target.value }))}
            disabled={loading || tiers.length === 0}
            aria-label={label}
          >
            {tiers.length === 0 && <option value="">{placeholder}</option>}
            {tiers.map((tier) => (
              <option key={tier.value} value={tier.value}>
                {`${tier.priceLabel} · ${tf("{0} 个号码", Number(tier.available).toLocaleString(currentLocale()))}`}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

const SEARCH_PICKER_MAX_ROWS = 200;

// Dropdown with a filter box, for lists too long for a native <select> (1,200+ platforms, ~200 countries).
function SearchPicker({ icon, items, value, placeholder, searchPlaceholder, emptyText, ariaLabel, disabled, defaultOpen = false, onSelect }) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const expanded = open && !disabled;

  useEffect(() => {
    if (!expanded) return undefined;
    panelRef.current?.scrollIntoView({ block: "nearest" });
    const closeOnOutsidePress = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsidePress);
    return () => document.removeEventListener("mousedown", closeOnOutsidePress);
  }, [expanded]);

  const selected = items.find((item) => item.value === value);
  const needle = query.trim().toLowerCase();
  const matches = needle ? items.filter((item) => item.search.includes(needle)) : items;
  const shown = matches.slice(0, SEARCH_PICKER_MAX_ROWS);
  const choose = (item) => {
    setOpen(false);
    setQuery("");
    if (item.value !== value) onSelect(item.value);
  };

  return (
    <div className="search-picker" ref={rootRef}>
      <button
        type="button"
        className="price-select-box search-picker-toggle"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-label={`${ariaLabel}: ${selected ? selected.text : placeholder}`}
      >
        {icon}
        <span className={`search-picker-value ${selected ? "" : "placeholder"}`}>{selected ? selected.text : placeholder}</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div className="search-picker-panel" ref={panelRef}>
          <div className="search-picker-search">
            <Search size={14} />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // Enter would otherwise submit the surrounding settings form.
                event.preventDefault();
                if (shown[0]) choose(shown[0]);
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              spellCheck="false"
              autoComplete="off"
              autoFocus
            />
          </div>
          <div className="search-picker-list" role="listbox" aria-label={ariaLabel}>
            {shown.map((item) => (
              <button
                type="button"
                role="option"
                aria-selected={item.value === value}
                className={item.value === value ? "active" : ""}
                key={item.value}
                onClick={() => choose(item)}
              >
                {item.text}
              </button>
            ))}
            {shown.length === 0 && <div className="search-picker-note">{emptyText}</div>}
            {matches.length > shown.length && (
              <div className="search-picker-note">{tf("还有 {0} 项，请输入关键字筛选", matches.length - shown.length)}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatSmsPriceOption(option) {
  const name = formatSmsCountryName(option);
  return tf("{0} | 价格 {1} | 库存 {2}", name, option.price, option.count);
}

function writeLocalJson(key, value) {
  try {
    settingsStore.setItem(key, JSON.stringify(value));
  } catch {
    // Saving is best-effort; the current tab still works.
  }
}

function writeLocalTextSetting(key, value) {
  try {
    settingsStore.setItem(key, String(value || ""));
  } catch {
    // Saving is best-effort; the current tab still works.
  }
}

function mergeJobs(...groups) {
  const unique = new Map();
  groups.flat().forEach((job) => {
    if (!unique.has(job.id)) unique.set(job.id, job);
  });
  return [...unique.values()];
}

const appRoot = globalThis.__chatgptOnboardingRoot || createRoot(document.getElementById("root"));
globalThis.__chatgptOnboardingRoot = appRoot;
// Settings come from the server database, so load them before the first render
// (the state initializers above read them synchronously).
void settingsStore.loadSettingsStore().finally(() => appRoot.render(<App />));
