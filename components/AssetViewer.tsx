// @ts-nocheck
import React, { useMemo, useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { useTranslation } from 'react-i18next';
import { FingerprintProfile, AdAccountAsset, BrowserStatus } from '../types';
import { LOCAL_SERVER_SECRET, selectionKeyOf, getLaunchServerUrl, canManageFromTasks, readPageRightsCache, mergePageRightsCache, normBmRows } from '../utils/constants';
// 🧵 批量慢操作统一提交给本机服务端任务队列（提交后前端可随意刷新，任务不中断）
import { submitJob, waitForJob, getLastAssets, withLongRequestSlot } from './jobQueue';
import { useAppContext } from './AppContext';
import { BookUser, Briefcase, BarChartHorizontal, HelpCircle, FileText, Wallet, Trash2, Power, PowerOff, CheckCircle2 as PublishIcon, EyeOff, RefreshCw, ArrowUp, ArrowDown, Play, Square, ShieldCheck, Pencil, ChevronRight, ChevronDown, Layers, Settings, Image, Key, LogIn, CreditCard, UserPlus, Users, Globe, Megaphone, BellRing, Copy, Check, Loader2 } from 'lucide-react';
import { FacebookAdPublisher, AdPublishData } from './FacebookAdPublisher';
import { BMOperationsDialog } from './BMOperationsDialog';
import { PageCreator, PageCreationData } from './PageCreator';
import { SmartPublishDialog } from './SmartPublishDialog';
import { GrantPageDialog } from './GrantPageDialog';
import { CreateAdAccountDialog } from './CreateAdAccountDialog';
import { AssignPersonalDialog } from './AssignPersonalDialog';
import { AssignToBMDialog } from './AssignToBMDialog';
import { AssetViewerFilterBar } from './AssetViewerFilterBar';
import { useContentCounts, jumpToPosts, jumpToMessages } from './PageSocialViewers';
import { CcyTzDialog } from './CcyTzDialog';
import { getStatusBadgeConfig, getAdAccountStatusCodeColor, loginStatusView } from './assetRowHelpers';
// 具名导入（避免 namespace import 在循环依赖中被 rollup 遗漏导致运行时报 WATCH is not defined）
import { subscribe as watchSubscribe, addPage as watchAddPage, removePage as watchRemovePage, isPageWatching as watchIsPageWatching } from './aiWatch';

interface AssetViewerProps {
  profiles?: FingerprintProfile[];
  assetType: 'pages' | 'bms' | 'adAccounts' | 'ads';
  token?: string | null;
  setProfiles?: React.Dispatch<React.SetStateAction<FingerprintProfile[]>>;
}

type PageAsset = { profileId: string; profileName: string; pageId: string; pageName: string; likes: number; status: 'Published' | 'Unpublished'; tokenValue?: string; notes?: string };
// ⚠️ 这里**故意没有**「BM 状态（bmStatus）」字段：Meta 没有可直接读的 BM 封禁/受限状态，
//    以前那个值只是前端按「有没有 ID」推断出来的（拿到 ID 就 Active，否则 Restricted），
//    看着像真实状态，实际会把配置全涂成 Restricted，容易误判 → 已整体撤掉，只保留「企业认证」。
type BmAsset = { profileId: string; profileName: string; bmId: string; bmName?: string; verificationStatus?: 'verified' | 'not_verified' | 'unknown'; paymentStatus?: 'Active' | 'Failed' | 'None'; country?: string, currency?: string, adminEmail?: string; tokenValue?: string; notes?: string; adAccountCount?: number; adAccountIds?: string; updated_at?: string;
  // 🏢 BM状态：按该 BM 名下广告号的真实状态汇总
  //    （normal 正常 / partial 部分受限 / warn 部分异常 / restricted 全部受限 /
  //      bm_risk BM 已被牵连 / none 无广告号数据），详见 bmStatusOf
  bmStatus?: string; bmStatusDetail?: string;
  // 🩺 停用原因：名下被停用广告号的 disable_reason 汇总文案，如「支付风险×2、BM 政策违规×1」
  bmDisableReason?: string;
  // 🩺 BM 状态：优先用浏览器探测到的「BM 自身」状态（aqStatus），没探测过才回退到按广告号汇总。
  //    取值 active / restricted / disabled / no_login / not_found（无权限查询）/ unknown
  aqStatus?: string; aqEvidence?: string; aqPolicy?: string;
  // 👥 BM 成员（邮箱 + 角色/权限）—— 来自 Graph business_users/pending_users
  bmUsers?: Array<{ id?: string; name?: string; email?: string; role?: string; active_status?: string }>;
  // 🕒 BM 创建时间（Graph Business.creation_time，云端 businesses.fb_created_time）
  fbCreatedTime?: string;
  // 🔢 可创建广告号上限（内部 GraphQL ad_account_creation_limit，云端 businesses.ad_account_limit）
  adAccountLimit?: number | string;
  // 📧 BM 邀请链接（分享 BM 时自动生成临时邮箱收信提取，见 /api/facebook/business/invite-user）
  inviteEmail?: string; inviteLink?: string; invitedAt?: string };

// 🐛 防止「自己 dispatch 的事件又被自己的监听器接管」形成死循环：
//    refreshBusinessesFromServer 拉完服务端数据后会 dispatch('businesses-refresh') 去通知其他组件
//    （Layout 的 BM 计数、贴文/对话统计等），但 AssetViewer 自己也监听同一个事件 → 于是又调用
//    refreshBusinessesFromServer → 又 dispatch → 无限循环。表现就是 BM 列表不停重渲染「闪烁」，
//    同时疯狂请求 /api/businesses（Layout / 统计的监听器也被带着一起刷）。
//    dispatchEvent 是同步派发的，所以这个标志位能精确挡住「自触发」，其他组件的监听器照常收到。
let _selfBusinessesRefresh = false;

type AdAsset = { profileId: string; profileName: string; adId: string; adName: string; status: string; accountId: string; campaignName: string; adsetName: string };

// 📧 复制按钮（自带瞬时反馈；放模块作用域避免父级重渲染丢状态）
const InviteCopyBtn: React.FC<{ link: string }> = ({ link }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      title="复制邀请链接"
      className={`p-1 rounded-md border shrink-0 ${copied ? 'bg-green-600/20 text-green-400 border-green-500/40' : 'bg-slate-900 text-slate-400 hover:text-indigo-400 border-slate-700'}`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

interface BatchActionButtonProps {
  onClick: () => void;
  icon: React.ElementType;
  label: string;
  variant?: 'danger' | 'primary' | 'secondary';
}

const BatchActionButton = ({ onClick, icon: Icon, label, variant = 'secondary' }: BatchActionButtonProps) => {
  const baseClasses = "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors";
  const variants = {
    danger: "bg-rose-600/20 text-rose-400 hover:bg-rose-600/30 border-rose-600/30",
    primary: "bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border-blue-600/30",
    secondary: "bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600",
  };
  return (
    <button onClick={onClick} className={`${baseClasses} ${variants[variant]}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
};


// 🛡️ 打本地服务的统一入口：**必须带超时**。裸 fetch 一旦遇上服务端卡住（登录验证/关浏览器），
//    会一直挂着，占满浏览器对同一域名的 6 条连接 → 之后所有请求（含"获取信息"）全被排队，
//    表现为「前端浮层停在某一步、服务端却收不到任何请求」。
const postLocal = (url: string, body: any, ms = 150000, label = '本地服务请求') =>
  fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
    body: JSON.stringify(body)
  }, ms, label);

// ⏱️ 带超时的 fetch：到点自动 abort 并抛出「XX超时(Ns)」。
//    单行操作以前没有任何超时，服务端要 39~70s 才启动完浏览器时，界面全程零反馈（表现为"点了没反应"）
const fetchWithTimeout = async (url: string, init: RequestInit, ms: number, label: string) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (ctrl.signal.aborted) throw new Error(`${label}超时(${Math.round(ms / 1000)}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

// 🏷️ 广告号状态码 → 展示文案：表格列 accessor 是 adAccountStatus，但 Graph/D1 里存的是数字码，
//    缓存与服务器两条渲染路径必须用同一套转换，否则同一个广告号会出现两种状态
const adAccountStatusLabel = (raw: any): string => {
  const s = String(raw ?? '').trim();
  if (s === '1') return 'Active';
  if (s === '2') return 'Disabled';
  if (s === '3') return 'Unsettled';
  if (s === '7') return 'Pending Risk Review';
  if (s === '8') return 'Pending Settlement';
  if (s === '9') return 'In Grace Period';
  if (s === '100') return 'Pending Closure';
  if (s === '101') return 'Closed';
  return s;
};

// 随机 BM 名称词库（形容词 + 名词组合，看起来像真实商户名）
const RANDOM_BM_NAMES = [
  'Eco Life', 'Tech Trends', 'Daily Joy', 'Green Garden', 'Smart Home',
  'Fashion Hub', 'Pet Paradise', 'Foodie Adventure', 'Fitness First', 'Travel Guide',
  'Artistic Soul', 'Music Magic', 'Gaming World', 'Movie Night', 'Book Worm',
  'Future Vision', 'Ocean Breeze', 'Mountain Peak', 'Urban Style', 'Zen Master',
  'Bright Studio', 'Prime Media', 'Elite Commerce', 'Global Trade', 'Apex Digital',
  'Nova Solutions', 'Vertex Labs', 'Quantum Edge', 'Stellar Works', 'Crystal Bloom'
];

const TZ_OPTIONS = [
  { label: '(GMT-12:00) Baker Island', val: '3' },
  { label: '(GMT-11:00) Pago Pago', val: '3' },
  { label: '(GMT-10:00) Honolulu', val: '3' },
  { label: '(GMT-08:00) Anchorage', val: '4' },
  { label: '(GMT-07:00) Los Angeles', val: '1' },
  { label: '(GMT-06:00) Denver', val: '2' },
  { label: '(GMT-05:00) Chicago', val: '6' },
  { label: '(GMT-04:00) New York', val: '7' },
  { label: '(GMT-03:00) Halifax', val: '37' },
  { label: '(GMT-03:00) Brasilia', val: '25' },
  { label: '(GMT-02:00) Noronha', val: '22' },
  { label: '(GMT+00:00) Azores', val: '109' },
  { label: '(GMT+01:00) London', val: '58' },
  { label: '(GMT+02:00) Paris', val: '57' },
  { label: '(GMT+03:00) Athens', val: '60' },
  { label: '(GMT+03:00) Moscow', val: '116' },
  { label: '(GMT+04:00) Dubai', val: '8' },
  { label: '(GMT+05:00) Karachi', val: '105' },
  { label: '(GMT+05:30) New Delhi', val: '71' },
  { label: '(GMT+06:00) Dhaka', val: '17' },
  { label: '(GMT+07:00) Bangkok', val: '132' },
  { label: '(GMT+08:00) Taipei', val: '136' },
  { label: '(GMT+09:00) Tokyo', val: '77' },
  { label: '(GMT+10:00) Sydney', val: '15' },
  { label: '(GMT+11:00) Noumea', val: '24' },
  { label: '(GMT+12:00) Auckland', val: '100' },
];

// 🚀 时区显示统一为「名称+偏移」格式（如 Asia/Taipei+8）。
//    历史数据里存在两种来源：获取信息写的是 "Asia/Taipei+8"，
//    改账单国家/时区写的是 FB 数字时区ID（如 136）→ 这里把数字ID映射回名称再补偏移。
const FB_TZ_ID_TO_NAME: Record<string, string> = {
  '1': 'America/Los_Angeles', '2': 'America/Denver', '3': 'Pacific/Honolulu',
  '4': 'America/Anchorage', '6': 'America/Chicago', '7': 'America/New_York',
  '8': 'Asia/Dubai', '15': 'Australia/Sydney', '17': 'Asia/Dhaka',
  '22': 'America/Noronha', '24': 'Pacific/Noumea', '25': 'America/Sao_Paulo',
  '37': 'America/Halifax', '57': 'Europe/Paris', '58': 'Europe/London',
  '60': 'Europe/Athens', '71': 'Asia/Kolkata', '77': 'Asia/Tokyo',
  '100': 'Pacific/Auckland', '105': 'Asia/Karachi', '109': 'Atlantic/Azores',
  '116': 'Europe/Moscow', '132': 'Asia/Bangkok', '136': 'Asia/Taipei',
};

// 💰 Meta Graph API 的金额字段（amount_spent / balance / spend_cap / min_daily_budget …）单位都是
//    「该货币的最小单位」：两位小数货币（USD/EUR/INR…）返回的是「分」，要 /100；无小数货币
//    （JPY/KRW/VND/IDR…）本身即最小单位，不能再除。
//    实测依据：USD 账号 min_daily_budget=100（=$1.00）、spend_cap=99999999900（Meta 的"无上限"）；
//    IDR 账号 min_daily_budget=18158（=Rp18,158，若按分算只有 Rp181，低于最低日预算，不可能）。
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'VUV',
  'XAF', 'XOF', 'XPF', 'GNF', 'KMF', 'DJF', 'BIF',
]);
// 最小单位 → 主单位（保留 2 位小数，避免浮点尾数）
export const toMajorAmount = (amount: any, currency: any): number => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  const div = ZERO_DECIMAL_CURRENCIES.has(String(currency || '').trim().toUpperCase()) ? 1 : 100;
  return Math.round((n / div) * 100) / 100;
};

// 🛡️ 广告号缓存完整性校验：缓存行数必须与上次服务器返回的 total 一致，否则视为"缺行的旧缓存"
//    → 直接不渲染（交给随后必然发生的服务器刷新），避免列表先闪一次错误条数（如 192）再变成 215。
//    meta 单独存一个 key，缓存本身仍是数组，其它组件（ProfileManager / SmartPublishDialog）不受影响。
const ADS_CACHE_KEY = 'cache:adaccounts';
const ADS_CACHE_META_KEY = 'cache:adaccounts:meta';
// 🎛️ 「互动明细」开关（每条贴文的点赞用户/评论/分享者）。
//    这一步每条贴文最多 3 个 Graph 调用，服务端时间预算 ENGAGEMENT_BUDGET_MS 默认 90 秒 ——
//    不需要这些明细时关掉，抓取能直接省下最多 90 秒。默认开（跟历史行为一致）。
const PREF_ENGAGEMENT_KEY = 'pref:fetch-engagement';
const readAdsCache = (): any[] | null => {
  try {
    const raw = localStorage.getItem(ADS_CACHE_KEY);
    if (!raw) return null;
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return null;
    const meta = JSON.parse(localStorage.getItem(ADS_CACHE_META_KEY) || 'null');
    if (!meta || typeof meta.total !== 'number' || meta.total !== rows.length) return null;
    return rows;
  } catch { return null; }
};
const writeAdsCacheMeta = (total: number) => {
  try { localStorage.setItem(ADS_CACHE_META_KEY, JSON.stringify({ total, savedAt: Date.now() })); } catch {}
};
const clearAdsCacheMeta = () => {
  try { localStorage.removeItem(ADS_CACHE_META_KEY); } catch {}
};

// 🔑 选择键 selectionKeyOf 已抽到 utils/constants.ts（AssignPersonalDialog / CreateAdAccountDialog 也要用）

// 🧹 脏数据行：后端历史 bug 曾经把字面量 "undefined"/"null" 写进 profile_id 列（写入端已修），
//    这些行在列表里只会显示成「账号ID = undefined / 操作员 = Profile undefined」，
//    属于纯垃圾数据 → 列表直接不展示（数据库里的存量另行清理）。
const isDirtyAssetRow = (item: any): boolean => {
  const pid = String(item?.profileId ?? item?.profile_id ?? '').trim().toLowerCase();
  return pid === 'undefined' || pid === 'null';
};

// 🔀 行级合并（治"画面闪烁"）：只把真的变了的行换成新对象，未变的行保持**原引用**
//    → React 直接跳过这些行的重渲染；整个列表无变化时连数组都不换（不 setState）。
//    以前是整表替换：每次刷新/轮询所有行都是新对象，全部重渲染 + 重排序，视觉上就是闪一下。
const rowUnchanged = (a: any, b: any): boolean => {
  const kb = Object.keys(b);
  if (Object.keys(a).length !== kb.length) return false;
  for (const k of kb) {
    const av = a[k], bv = b[k];
    if (av === bv) continue;
    if (Array.isArray(bv) || typeof bv === 'object' || Array.isArray(av) || typeof av === 'object') {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
      continue;
    }
    return false;
  }
  return true;
};
// 广告号状态归一化成 Graph 数字码：
//   1=Active 2=Disabled 3=Unsettled 7=Pending Risk Review 8=Pending Settlement
//   9=In Grace Period 100=Pending Closure 101=Closed
//   ⚠️ 缓存/服务器两条路径存的形态不同：一处是数字码，一处已被 adAccountStatusLabel 转成文案，
//      所以两种都要认，否则会整列算不出值（全变成「—」）。
const adAccountStatusCode = (row: any): number => {
  const raw = row?.accountStatus ?? row?.account_status ?? row?.status ?? row?.adAccountStatus ?? 0;
  const n = Number(raw);
  if (!isNaN(n) && n > 0) return n;
  const s = String(raw || '').toLowerCase();
  if (!s) return 0;
  if (s.includes('active') || s.includes('正常') || s.includes('启用')) return 1;
  if (s.includes('disabled') || s.includes('受限') || s.includes('禁用')) return 2;
  if (s.includes('unsettled') || s.includes('未结清')) return 3;
  if (s.includes('grace')) return 9;
  if (s.includes('closure') || s.includes('待关闭')) return 100;
  if (s.includes('closed') || s.includes('已关闭')) return 101;
  if (s.includes('pending') || s.includes('审核')) return 7;
  return -1; // 有值但认不出来 → 计入「异常」，不假装正常
};

// 🩺 广告号「停用原因」（Graph 的 disable_reason）官方枚举 → 中文。
//    ⚠️ 缓存里有两种形状：本地写的是 disableReason，服务端返回的是 disable_reason，读取时都要认。
const DISABLE_REASON_LABELS: Record<number, string> = {
  1: '广告违规',
  2: '资产/IP 风险',
  3: '支付风险',
  4: '灰色账号清退',
  5: 'AFC 审查',
  6: 'BM 完整性风险',
  7: '永久关闭',
  8: '代理商未使用',
  9: '长期未使用',
  10: '伞形账号',
  11: 'BM 政策违规',
  12: '虚假陈述',
  13: '法律实体不符',
  14: '关联审查',
  15: '账号被盗用'
};

// ⚠️ 只有这两个原因指向「BM 本身出事」，其余（广告违规 / 支付风险 / 长期未使用…）都是广告号维度：
//    6 = BUSINESS_INTEGRITY_RAR（BM 完整性风险）、11 = BUSINESS_MANAGER_INTEGRITY_POLICY（BM 政策违规）。
//    看到它们 = 不是单个广告号的问题，BM 已经被牵连（即使 BM 对象还读得到）。
const BM_LINKED_DISABLE_REASONS = new Set([6, 11]);

const disableReasonOf = (row: any): number => {
  const n = Number(row?.disableReason ?? row?.disable_reason ?? 0);
  return isNaN(n) ? 0 : n;
};

// 🏢 BM「状态」= 它名下广告号的健康汇总。
//    ⚠️ 不是「BM 自身被封/受限」：Meta 根本没提供 BM 的可读状态字段（详见 BmAsset 注释）。
//    口径：1=正常；2/101=受限（禁用/已关闭）；其余（未结清/审核中/宽限期/认不出的）一律算「异常」——
//    第一版只看 1/2/3，导致「全是不认识的状态码」会被判成「正常」，属于误报，这里修掉。
//    🩺 bm_risk：只要有广告号的停用原因是 6/11，说明 BM 已被牵连 → 单列出来，不再混进「全部受限」。
const bmStatusOf = (adRows: any[]) => {
  const rows = Array.isArray(adRows) ? adRows : [];
  const codes = rows.map(adAccountStatusCode).filter(c => c !== 0);
  const total = codes.length;
  if (!total) return { kind: 'none', detail: '名下还没有广告号数据（先对该配置跑一次「获取信息」）', reasonLabel: '' };
  const ok = codes.filter(c => c === 1).length;
  const bad = codes.filter(c => c === 2 || c === 101).length;
  const warn = total - ok - bad;
  // 停用原因分布：只统计「真被停用」（2 禁用 / 101 关闭）的广告号，按出现次数从多到少排
  const reasonCount = new Map<number, number>();
  rows.forEach(r => {
    const code = adAccountStatusCode(r);
    if (code !== 2 && code !== 101) return;
    const rs = disableReasonOf(r);
    if (!rs) return;
    reasonCount.set(rs, (reasonCount.get(rs) || 0) + 1);
  });
  const sorted = Array.from(reasonCount.entries()).sort((a, b) => b[1] - a[1]);
  const bmLinked = sorted.reduce((s, [rs, n]) => BM_LINKED_DISABLE_REASONS.has(rs) ? s + n : s, 0);
  const reasonLabel = sorted.map(([rs, n]) => `${DISABLE_REASON_LABELS[rs] || `原因${rs}`}×${n}`).join('、');
  const kind = bmLinked > 0 ? 'bm_risk'
    : bad > 0 ? (ok > 0 ? 'partial' : 'restricted')
    : (warn > 0 ? 'warn' : 'normal');
  const detail = [
    `共 ${total} 个广告号`,
    `正常 ${ok}`,
    bad > 0 ? `受限 ${bad}` : '',
    warn > 0 ? `异常(审核中/未结清等) ${warn}` : '',
    bmLinked > 0 ? `⚠️ ${bmLinked} 个因 BM 完整性/政策违规被停用（BM 已被牵连）` : '',
    reasonLabel ? `停用原因：${reasonLabel}` : ''
  ].filter(Boolean).join('；');
  return { kind, detail, reasonLabel };
};

// 🩺 「账号质量」= 用浏览器读 Meta Account Quality 得到的 BM 自身是否被封/受限。
//    现已落库（云端 businesses 表的 aq_status / aq_evidence / aq_policy / aq_updated_at），
//    探测由本地 9999 服务写入；前端读云端时把 snake_case 三列映射成界面用的 aqStatus 三件套。
//    兼容两种来源：① 云端 aq_* 列；② 本地 cache:businesses 里的驼峰 aqStatus。
type AqFields = { aqStatus?: string; aqEvidence?: string; aqPolicy?: string };
const aqFieldsOf = (b: any): AqFields => ({
  aqStatus: b?.aqStatus ? String(b.aqStatus) : undefined,
  aqEvidence: b?.aqEvidence ? String(b.aqEvidence) : undefined,
  aqPolicy: b?.aqPolicy ? String(b.aqPolicy) : undefined
});

// 云端 businesses 行（aq_status/aq_evidence/aq_policy）→ 界面字段；无值时返回空对象（不覆盖已有值）
const aqOfCloudRow = (b: any): AqFields => {
  const s = b?.aq_status ?? b?.aqStatus;
  if (!s) return {};
  return {
    aqStatus: String(s),
    aqEvidence: String(b?.aq_evidence ?? b?.aqEvidence ?? ''),
    aqPolicy: String(b?.aq_policy ?? b?.aqPolicy ?? '')
  };
};

// 云端 businesses 行（bm_users JSON 字符串）/ 本地数组 → 统一的成员数组
const bmUsersOf = (b: any): any[] => {
  const raw = b?.bmUsers ?? b?.bm_users;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  return [];
};

// 🕒 BM 创建时间：云端 fb_created_time / Graph creation_time / 本地驼峰
const fbCreatedOf = (b: any): string =>
  String(b?.fbCreatedTime || b?.fb_created_time || b?.creation_time || '').trim();

// 🔢 BM 可创建广告号上限：云端 ad_account_limit / Graph 附上的 ad_account_limit / 本地驼峰。
//    取不到 → 空串（列里显示「—」，不会被当成 0）。
const adLimitOf = (b: any): number | string => {
  const v = b?.adAccountLimit ?? b?.ad_account_limit;
  if (v === undefined || v === null || String(v).trim() === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
};

// 把 cache:businesses 里已有的 aq* 补回到「即将覆盖写入」的行上（按 配置ID + BM ID 匹配）
// ⚠️ 只在行上没有 aqStatus 时才补 —— 云端 DB 带回来的值优先，不被本地旧缓存覆盖。
const keepAqFromCache = (rows: any[]): any[] => {
  let existing: any[] = [];
  try { existing = JSON.parse(localStorage.getItem('cache:businesses') || '[]'); } catch {}
  const map = new Map<string, AqFields>();
  (Array.isArray(existing) ? existing : []).forEach((e: any) => {
    const pid = String(e.profileId || e.profile_id || '');
    const bid = String(e.businessId || e.business_id || e.bmId || e.id || '');
    if (!pid || !bid) return;
    const aq = aqFieldsOf(e);
    if (aq.aqStatus) map.set(`${pid}::${bid}`, aq);
  });
  (Array.isArray(rows) ? rows : []).forEach((r: any) => {
    if (!r || typeof r !== 'object') return;
    const pid = String(r.profileId || r.profile_id || '');
    const bid = String(r.businessId || r.business_id || r.bmId || r.id || '');
    const prev = map.get(`${pid}::${bid}`);
    if (prev && !r.aqStatus) Object.assign(r, prev);
  });
  return rows;
};

const mergeRowsById = (prev: any[], incoming: any[], key: string): any[] => {
  if (!prev || prev.length === 0) return incoming;
  const prevMap = new Map(prev.map((x: any) => [String(x?.[key] ?? ''), x]));
  let changed = false;
  const next = incoming.map((m: any) => {
    const old = prevMap.get(String(m?.[key] ?? ''));
    if (old && rowUnchanged(old, m)) return old; // 同一引用 → 该行不重渲染
    changed = true;
    return old ? { ...old, ...m } : m;
  });
  if (!changed && next.length === prev.length && next.every((x, i) => x === prev[i])) return prev;
  return next;
};

// 由 IANA 名称算出当前 UTC 偏移，返回 "+8" / "-7" / "+5.5"
const tzOffsetOf = (name: string): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: name, timeZoneName: 'longOffset' } as any).formatToParts(new Date());
    const v = parts.find(p => p.type === 'timeZoneName')?.value || '';
    const m = v.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return '';
    const mins = Number(m[3] || 0);
    const hours = Number(m[2]) + (mins ? mins / 60 : 0);
    return `${m[1]}${Number.isInteger(hours) ? hours : hours.toFixed(1)}`;
  } catch { return ''; }
};

// 任意来源的时区值 → "名称+偏移"
const formatTimezoneValue = (raw: any): string => {
  const tz = String(raw ?? '').trim();
  if (!tz) return '';
  if (/^\d+$/.test(tz)) {
    const name = FB_TZ_ID_TO_NAME[tz];
    if (!name) return tz;
    const off = tzOffsetOf(name);
    return off ? `${name}${off}` : name;
  }
  if (/^[A-Za-z]+\/[A-Za-z_]+$/.test(tz)) {   // 只有 IANA 名称、没带偏移
    const off = tzOffsetOf(tz);
    return off ? `${tz}${off}` : tz;
  }
  return tz;
};

export const AssetViewer = ({ profiles: propProfiles, assetType, token: propToken, setProfiles: propSetProfiles }: AssetViewerProps) => {
  const ctx = useAppContext();
  const profiles = propProfiles ?? ctx.profiles;
  const token = propToken ?? ctx.token;
  const setProfiles = propSetProfiles ?? ctx.setProfiles;
  const { t } = useTranslation();
  // 🚀 贴文/对话数量统计（主页列表按 page、广告号/BM 列表按 profile）
  const contentCounts = useContentCounts();
  // 🚀 V5.7.0: 解析当前用户角色，superadmin 不应用 profileIds 过滤
  const isSuperadmin = (() => {
    try {
      const t0 = token || localStorage.getItem('auth_token');
      if (!t0) return false;
      // 兼容 "Bearer xxx" 和裸 base64 两种格式
      const raw = t0.startsWith('Bearer ') ? t0.slice(7) : t0;
      const payload = atob(raw);
      const parts = payload.split(':');
      return (parts[2] || '').toLowerCase() === 'superadmin';
    } catch { return false; }
  })();
  const handleBatchPublish = async (data: AdPublishData) => {
    if (selectedIds.size === 0) return;
    setPublishPosting(true);
    setPublishError('');
    setPublishResult(null);
    setPublishFailed([]);
    
    try {
      const targets: any[] = (sortedData as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));
      
      const fileToBase64 = (file: File): Promise<string> => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsDataURL(file);
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = error => reject(error);
        });
      };

      const mediaBase64 = data.mediaFile ? await fileToBase64(data.mediaFile) : undefined;
      // 🧵 发布也交给服务端队列：每个广告号一项，puppeteer 模式由队列负责先启动浏览器。
      //    ⚠️ File 对象不能进 JSON，单独去掉（素材已转成 base64 放进 shared）。
      const { mediaFile: _mf, ...restData } = data as any;
      const shared = { ...restData, mediaBase64 };
      const items = targets.map((item: any) => ({
        key: `${String(item.profileId)}::${String(item.adAccountId)}`,
        label: String(item.adAccountId || item.profileId),
        payload: { profileId: String(item.profileId), adAccountId: String(item.adAccountId) },
      }));
      setPublishProgress({ done: 0, total: items.length });

      const job = await submitJob({
        type: 'publish_ads',
        title: `批量发布广告（${items.length} 个广告号）`,
        items,
        shared,
      });
      const finished = await waitForJob(job.id, (j) => {
        if (j) setPublishProgress({ done: j.done + j.fail, total: j.total });
      });

      const ok = finished?.ok ?? 0;
      const failed = (finished?.items || [])
        .filter((it) => it.status === 'failed' || it.status === 'cancelled')
        .map((it) => ({
          profileId: String((it as any).payload?.profileId || ''),
          adAccountId: String((it as any).payload?.adAccountId || ''),
          error: it.message || '发布失败',
        }));
      setPublishResult({ count: ok });
      setPublishFailed(failed as any);
      
      if (failed.length > 0) {
        setPublishError(`完成！成功 ${ok} 个，失败 ${failed.length} 个。`);
      } else {
        alert(`已在执行队列完成 ${ok} 个广告发布任务`);
        setIsPublishOpen(false);
      }
    } catch (e: any) {
      setPublishError(e?.message || '发布过程发生异常');
    } finally {
      setPublishPosting(false);
    }
  };

  const COUNTRY_CURRENCY: Record<string, string> = {
    CN:'CNY', US:'USD', HK:'HKD', MO:'MOP', TW:'TWD', JP:'JPY', KR:'KRW', SG:'SGD', MY:'MYR', TH:'THB', VN:'VND', ID:'IDR', PH:'PHP',
    GB:'GBP', IE:'EUR', DE:'EUR', FR:'EUR', IT:'EUR', ES:'EUR', NL:'EUR', BE:'EUR', SE:'SEK', NO:'NOK', DK:'DKK', CH:'CHF', PT:'EUR', AT:'EUR', FI:'EUR', GR:'EUR', PL:'PLN', CZ:'CZK', HU:'HUF', RO:'RON', BG:'BGN', HR:'EUR',
    AU:'AUD', NZ:'NZD', CA:'CAD', MX:'MXN', BR:'BRL', AR:'ARS', CL:'CLP', CO:'COP', PE:'PEN', RU:'RUB', UA:'UAH', TR:'TRY', SA:'SAR', AE:'AED', EG:'EGP'
  };
  // 🚀 随机地址数据
  const COUNTRY_ADDRESS_DATA: Record<string, { cities: string[]; streets: string[]; zipPrefix: string }> = {
    US: { cities: ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Miami', 'Seattle', 'Denver', 'Boston', 'Atlanta', 'Portland'], streets: ['Main St', 'Oak Ave', 'Elm St', 'Park Blvd', 'Broadway', 'Maple Dr', 'Cedar Ln', 'Lakeview Dr', 'Highland Ave', 'Sunset Blvd'], zipPrefix: '9' },
    GB: { cities: ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Liverpool', 'Edinburgh', 'Bristol', 'Cardiff', 'Belfast'], streets: ['High St', 'Church Rd', 'London Rd', 'Queen St', 'King St', 'Park Lane', 'Station Rd', 'Victoria St', 'Green Ln', 'Mill Rd'], zipPrefix: 'E' },
    DE: { cities: ['Berlin', 'Munich', 'Hamburg', 'Cologne', 'Frankfurt', 'Stuttgart', 'Dusseldorf', 'Leipzig', 'Dresden', 'Bremen'], streets: ['Hauptstr', 'Bahnhofstr', 'Schulstr', 'Berliner Str', 'Goethestr', 'Parkstr', 'Dorfstr', 'Kirchenweg', 'Mühlenweg', 'Waldstr'], zipPrefix: '1' },
    FR: { cities: ['Paris', 'Marseille', 'Lyon', 'Toulouse', 'Nice', 'Nantes', 'Strasbourg', 'Montpellier', 'Bordeaux', 'Lille'], streets: ['Rue de la Paix', 'Rue du Faubourg', 'Avenue des Champs', 'Boulevard Saint', 'Place de la', 'Rue Nationale', 'Avenue de la', 'Rue des Fleurs', 'Boulevard Voltaire', 'Rue Victor Hugo'], zipPrefix: '75' },
    IT: { cities: ['Rome', 'Milan', 'Naples', 'Turin', 'Palermo', 'Genoa', 'Bologna', 'Florence', 'Catania', 'Venice'], streets: ['Via Roma', 'Via Milano', 'Via Nazionale', 'Corso Italia', 'Via Garibaldi', 'Via Cavour', 'Via Dante', 'Via Manzoni', 'Via Mazzini', 'Via Verdi'], zipPrefix: '0' },
    ES: { cities: ['Madrid', 'Barcelona', 'Valencia', 'Seville', 'Zaragoza', 'Malaga', 'Murcia', 'Palma', 'Bilbao', 'Alicante'], streets: ['Calle Mayor', 'Calle de Alcalá', 'Gran Via', 'Paseo de la', 'Avenida de la', 'Calle Serrano', 'Rambla de', 'Calle Velázquez', 'Calle Goya', 'Plaza Mayor'], zipPrefix: '28' },
    NL: { cities: ['Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht', 'Eindhoven', 'Groningen', 'Tilburg', 'Almere', 'Breda', 'Nijmegen'], streets: ['Damrak', 'Kalverstraat', 'Leidsestraat', 'Nieuwendijk', 'Rokin', 'Spuistraat', 'Haarlemmerstraat', 'Vijzelstraat', 'Utrechtsestraat', 'Prinsengracht'], zipPrefix: '10' },
    AU: { cities: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Gold Coast', 'Newcastle', 'Canberra', 'Hobart', 'Darwin'], streets: ['George St', 'Collins St', 'Queen St', 'William St', 'Elizabeth St', 'King St', 'Victoria St', 'Edward St', 'Smith St', 'Jones St'], zipPrefix: '2' },
    CA: { cities: ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Edmonton', 'Ottawa', 'Winnipeg', 'Quebec City', 'Hamilton', 'Halifax'], streets: ['Bay St', 'Robson St', 'Saint Catherine', 'Stephen Ave', 'Jasper Ave', 'Bank St', 'Portage Ave', 'Grande Allee', 'King St W', 'Spring Garden Rd'], zipPrefix: 'M' },
    SG: { cities: ['Singapore'], streets: ['Orchard Rd', 'Shenton Way', 'Raffles Blvd', 'Marina Blvd', 'Temasek Ave', 'Bras Basah Rd', 'Victoria St', 'North Bridge Rd', 'South Bridge Rd', 'Serangoon Rd'], zipPrefix: '0' },
    JP: { cities: ['Tokyo', 'Osaka', 'Yokohama', 'Nagoya', 'Sapporo', 'Fukuoka', 'Kobe', 'Kyoto', 'Kawasaki', 'Saitama'], streets: ['Sakura-dori', 'Chuo-dori', 'Meiji-dori', 'Yamate-dori', 'Aoyama-dori', 'Harumi-dori', 'Showa-dori', 'Eitai-dori', 'Sotobori-dori', 'Kasuga-dori'], zipPrefix: '10' },
    KR: { cities: ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon', 'Gwangju', 'Suwon', 'Ulsan', 'Seongnam', 'Changwon'], streets: ['Jong-ro', 'Gangnam-daero', 'Teheran-ro', 'Yanghwa-ro', 'Eulji-ro', 'Sejong-daero', 'Mapo-daero', 'Digital-ro', 'Sinnonhyeon-ro', 'Banpo-daero'], zipPrefix: '0' },
    BR: { cities: ['Sao Paulo', 'Rio de Janeiro', 'Brasilia', 'Salvador', 'Fortaleza', 'Belo Horizonte', 'Manaus', 'Curitiba', 'Recife', 'Porto Alegre'], streets: ['Av Paulista', 'Rua Augusta', 'Av Atlantica', 'Rua da Consolacao', 'Av Brasil', 'Rua Oscar Freire', 'Av Rio Branco', 'Rua XV de Novembro', 'Av Copacabana', 'Rua da Praia'], zipPrefix: '01' },
    ID: { cities: ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Semarang', 'Makassar', 'Palembang', 'Denpasar', 'Tangerang', 'Yogyakarta'], streets: ['Jl Merdeka', 'Jl Sudirman', 'Jl Thamrin', 'Jl Gatot Subroto', 'Jl Rasuna Said', 'Jl Kuningan', 'Jl Diponegoro', 'Jl Ahmad Yani', 'Jl Pramuka', 'Jl Gajah Mada'], zipPrefix: '1' },
    TH: { cities: ['Bangkok', 'Chiang Mai', 'Phuket', 'Pattaya', 'Hat Yai', 'Nakhon Ratchasima', 'Khon Kaen', 'Udon Thani', 'Nonthaburi', 'Pak Kret'], streets: ['Sukhumvit Rd', 'Silom Rd', 'Ratchadamri Rd', 'Rama I Rd', 'Phra Athit Rd', 'Khao San Rd', 'Charoen Krung Rd', 'Sathorn Rd', 'Phetchaburi Rd', 'Ratchaprarop Rd'], zipPrefix: '10' },
    VN: { cities: ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Can Tho', 'Bien Hoa', 'Nha Trang', 'Hue', 'Da Lat', 'Buon Ma Thuot'], streets: ['Nguyen Hue', 'Le Loi', 'Dong Khoi', 'Ham Nghi', 'Nguyen Trai', 'Tran Hung Dao', 'Ly Tu Trong', 'Nam Ky Khoi Nghia', 'Pham Ngoc Thach', 'Le Thanh Ton'], zipPrefix: '70' },
    AE: { cities: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Al Ain', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'], streets: ['Sheikh Zayed Rd', 'Al Maktoom Rd', 'Al Wasl Rd', 'Al Maktoum St', 'Al Rigga Rd', 'Al Nahda St', 'Al Muraqqabat St', 'Al Ghurair St'], zipPrefix: '00' }
  };
  const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY', 'DC'];
  // 🚀 随机生成地址
  const generateRandomAddress = (countryCode: string) => {
    const data = COUNTRY_ADDRESS_DATA[countryCode];
    if (!data) return { city: '', street: '', zip: '', state: '' };
    const city = data.cities[Math.floor(Math.random() * data.cities.length)];
    const streetNum = Math.floor(Math.random() * 9999) + 1;
    const street = `${streetNum} ${data.streets[Math.floor(Math.random() * data.streets.length)]}`;
    const zip = data.zipPrefix + String(Math.floor(Math.random() * 9000 + 1000));
    const state = countryCode === 'US' ? US_STATES[Math.floor(Math.random() * US_STATES.length)] : '';
    return { city, street, zip, state };
  };
  const detectNetwork = (num: string): string => {
    const n = String(num || '').replace(/\D/g, '');
    if (/^4\d{12,18}$/.test(n)) return 'Visa';
    if (/^(5[1-5]\d{14}|2(2[2-9]\d{12}|[3-6]\d{13}|7[01]\d{12}|720\d{12}))$/.test(n)) return 'Mastercard';
    if (/^3[47]\d{13}$/.test(n)) return 'Amex';
    if (/^6\d{15,}$/.test(n)) return 'Discover';
    return '';
  };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 🚀 广告号列表"首屏是否已就绪"：缓存被判定不完整时不渲染缓存，此期间空表显示"加载中"而不是"暂无资产"
  const [adsLoaded, setAdsLoaded] = useState(false);
  // 🚀 订阅 AI 主页值守状态变化，刷新行内按钮
  const [, setWatchTick] = useState(0);
  useEffect(() => watchSubscribe(() => setWatchTick(t => t + 1)), []);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'profileName', direction: 'asc' });
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(() => {
    try { const k = `assetViewer_page_${assetType}`; return parseInt(localStorage.getItem(k) || '1', 10); } catch { return 1; }
  });
  const [pageSize, setPageSize] = useState(() => {
    try { const k = `assetViewer_pageSize_${assetType}`; return parseInt(localStorage.getItem(k) || '30', 10); } catch { return 30; }
  });
  const [jumpPage, setJumpPage] = useState('');
  const [assetSeqMap, setAssetSeqMap] = useState<Record<string, number>>({});
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [tokens, setTokens] = useState<any | null>(null);
  const [manualAccessToken, setManualAccessToken] = useState('');
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState('');
  const [assetsResult, setAssetsResult] = useState<any | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  // 🚀 批量操作阶段提示：以前只有菜单里一个转圈，而菜单点完就自动关了 →
  //    启动浏览器要 39~70s 的这段时间界面上什么都看不到，观感就是"点了没反应"
  const [batchStage, setBatchStage] = useState('');
  const [batchError, setBatchError] = useState('');
  const [batchResult, setBatchResult] = useState<any | null>(null);
  const [opsLog, setOpsLog] = useState([] as Array<{ time: number; action: string; detail: string }>);
  const [opsDetails, setOpsDetails] = useState([] as Array<{ profileId: string; adAccountId?: string; ok: boolean; message?: string }>);
  const [inlineNotesEdit, setInlineNotesEdit] = useState<{ id: string; notes: string } | null>(null);
  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState('');
  const [pagePostMessage, setPagePostMessage] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [postResult, setPostResult] = useState<any | null>(null);
  const [pageImageUrl, setPageImageUrl] = useState('');
  const [pageLinkUrl, setPageLinkUrl] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState('');
  const [pagePosts, setPagePosts] = useState<any[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [adAccountsDb, setAdAccountsDb] = useState<AdAccountAsset[]>([]);
  const [pagesDb, setPagesDb] = useState<any[]>([]);
  // 🚀 新增：pages 过滤状态，用于点击 pagesCount 跳转后的可靠过滤
  const [pagesFilterState, setPagesFilterState] = useState<{ profileId?: string; profileName?: string }>({});
  // 🛡️ 主页「账号权限」：配置ID -> { at, pages: { 主页ID -> 是否管理员 } }
  //    来源是 Graph API me/accounts（角色维度），回答「这个配置的账号在这主页上是什么角色」。
  //    ⚠️ 注意：主页列表里的 id 是「老式 Page ID」，而切身份/发邀请要的是「新式 profile id」，
  //    两者不一定相同 —— 所以这一列只说明账号有没有该主页的角色，不等于一定能授权成功。
  //    ⚠️ 数据只在「获取信息」/「获取主页」时写入（这两个动作本来就会调 me/accounts 取 tasks），
  //    不再挂在列表刷新上自动探测 —— 那是每次刷新（含 F5）逐配置重打一次 me/accounts，每轮 20~30s。
  //    缓存与配置列表（ProfileManager）共用，见 utils/constants 的 PAGE_RIGHTS_CACHE_KEY。
  const [pageRights, setPageRights] = useState<Record<string, { at: number; pages: Record<string, boolean> }>>(() => readPageRightsCache());
  const [adsDb, setAdsDb] = useState<AdAsset[]>([]);
  const [businessesDb, setBusinessesDb] = useState<BmAsset[]>([]);
  const [bmRefreshInfo, setBmRefreshInfo] = useState('');
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState('');
  const [insightsDatePreset, setInsightsDatePreset] = useState('last_7d');
  const [pageInsights, setPageInsights] = useState<any[]>([]);
  const [selectedPostId, setSelectedPostId] = useState('');
  const [postInsightsLoading, setPostInsightsLoading] = useState(false);
  const [postInsightsError, setPostInsightsError] = useState('');
  const [postInsights, setPostInsights] = useState<any[]>([]);
  const [limitsLoading, setLimitsLoading] = useState(false);
  // 🎛️ 互动明细开关（关闭可省下最多 90 秒），状态记在 localStorage
  const [fetchEngagement, setFetchEngagement] = useState<boolean>(() => {
    try { return localStorage.getItem(PREF_ENGAGEMENT_KEY) !== '0'; } catch { return true; }
  });
  const [isChangeCTOpen, setIsChangeCTOpen] = useState(false);
  const [changeCurrency, setChangeCurrency] = useState('USD');
  const [changeTimezone, setChangeTimezone] = useState('1');
  const [changeTimezoneOffset, setChangeTimezoneOffset] = useState('1');
  const [changeCountry, setChangeCountry] = useState('US');
  const [changeAddress, setChangeAddress] = useState('');
  const [changeCity, setChangeCity] = useState('');
  const [changeZip, setChangeZip] = useState('');
  const [changeState, setChangeState] = useState('AL');
  const [changeAddressRandom, setChangeAddressRandom] = useState(true);
  const [changeCityRandom, setChangeCityRandom] = useState(true);
  const [changeZipRandom, setChangeZipRandom] = useState(true);
  const [changeStateRandom, setChangeStateRandom] = useState(false);
  const [changeTargets, setChangeTargets] = useState<any[]>([]);
  const [changeLoading, setChangeLoading] = useState(false);
  const [changeError, setChangeError] = useState('');
  const [changeLang, setChangeLang] = useState(''); // ''=不修改, 'zh_CN'=中文, 'en_US'=英语
  const [changeBusinessName, setChangeBusinessName] = useState(''); // 公司名称（账单信息中的公司名）
  const [isAddPaymentOpen, setIsAddPaymentOpen] = useState(false);
  const [addPaymentTargets, setAddPaymentTargets] = useState<any[]>([]);
  const [billingMethodsByProfile, setBillingMethodsByProfile] = useState<Record<string, any[]>>({});
  const [billingLoading, setBillingLoading] = useState(false);
  const [addMode, setAddMode] = useState<'manual' | 'existing' | 'auto'>('manual');
  const [cardNumber, setCardNumber] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [cardExpiryMonth, setCardExpiryMonth] = useState('');
  const [cardExpiryYear, setCardExpiryYear] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [cardAddress, setCardAddress] = useState('');
  const [cardCity, setCardCity] = useState('');
  const [cardZip, setCardZip] = useState('');
  const [cardTag, setCardTag] = useState('');
  const [cardIso, setCardIso] = useState('US');
  const [cardBindCurrency, setCardBindCurrency] = useState('');
  const [cardBindTimezone, setCardBindTimezone] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<{ profileId: string; last4?: string; type?: string } | null>(null);
  const [addPaymentLoading, setAddPaymentLoading] = useState(false);
  const [addPaymentError, setAddPaymentError] = useState('');
  const [cardChannel, setCardChannel] = useState('');
  const [channelOptions, setChannelOptions] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  // 🚀 新增：标签/渠道筛选
  const [cardTagFilter, setCardTagFilter] = useState('');
  const [cardChannelFilter, setCardChannelFilter] = useState('');

  // 🚀 修复：直接从 localStorage 读取本地卡片，与 state 合并（确保卡片不丢失）
  const getAllCards = () => {
    const stateCards: any[] = [];
    for (const pid of Object.keys(billingMethodsByProfile)) {
      for (const m of billingMethodsByProfile[pid]) {
        stateCards.push({ ...m, _pid: pid });
      }
    }
    // 补充直接从 localStorage 读取的本地卡片（避免 state 被覆盖丢失）
    try {
      const raw = localStorage.getItem('billingMethodsByProfile');
      if (raw) {
        const byProfile = JSON.parse(raw);
        const seenKeys = new Set(stateCards.map(c => `${c._pid}:${c.last4 || c.id}`));
        for (const pid of Object.keys(byProfile)) {
          for (const m of byProfile[pid]) {
            const key = `${pid}:${m.last4 || m.id || ''}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              stateCards.push({
                ...m,
                _pid: pid,
                source: 'local',
                type: m.brand || 'Card',
                last4: m.last4 || '',
                channel: m.channel || '',
                tags: Array.isArray(m.tags) ? m.tags : [],
                alias: m.alias || '',
                id: m.id || ''
              });
            }
          }
        }
      }
    } catch {}
    // 🚀 补充从 local-cards 加载的完整卡片数据（含卡号、有效期、CVV）
    // 注意：local-cards 和 billingMethodsByProfile 可能存同 ID 的卡片，
    // 但 billingMethodsByProfile 只存 last4 等信息，没有完整 cardNumber，
    // 所以 local-cards 的完整数据必须追加进去（不做 id 去重）
    try {
      const raw = localStorage.getItem('local-cards');
      if (raw) {
        const localCards = JSON.parse(raw);
        if (Array.isArray(localCards)) {
          for (const card of localCards) {
            if (!card.cardNumber && !card.cvv) continue; // 跳过不完整的卡
            stateCards.push({
              ...card,
              _pid: card._pid || 'local',
              source: 'local-cards',
              last4: card.card_last4 || card.last_four_digits || card.cardNumber?.slice(-4) || '',
              channel: card.channel || '',
              tags: Array.isArray(card.tags) ? card.tags : [],
              type: card.brand || 'Card',
              cardNumber: card.cardNumber || '',
              exp_month: card.exp_month || '',
              exp_year: card.exp_year || '',
              cvv: card.cvv || '',
              holder: card.holder || ''
            });
          }
        }
      }
    } catch {}
    return stateCards;
  };

  // 🚀 新增：从本地卡片库加载卡片到 billingMethodsByProfile
  useEffect(() => {
    try {
      const raw = localStorage.getItem('billingMethodsByProfile');
      if (raw) {
        const byProfile = JSON.parse(raw);
        const merged = { ...billingMethodsByProfile };
        for (const pid of Object.keys(byProfile)) {
          const arr = Array.isArray(byProfile[pid]) ? byProfile[pid] : [];
          if (arr.length) {
            // 标记来源为 local
            const enriched = arr.map((c: any) => ({
              ...c,
              source: 'local',
              type: c.brand || 'Card',
              last4: c.last4 || '',
              channel: c.channel || '',
              tags: Array.isArray(c.tags) ? c.tags : [],
              alias: c.alias || '',
              id: c.id || ''
            }));
            if (!merged[pid]) merged[pid] = [];
            // 去重
            const seen = new Set(merged[pid].map((m:any) => m.last4 || m.id));
            for (const m of enriched) {
              if (!seen.has(m.last4 || m.id)) {
                seen.add(m.last4 || m.id);
                merged[pid].push(m);
              }
            }
          }
        }
        setBillingMethodsByProfile(merged);
      }
    } catch {}

    // 从服务器 API 加载
    const loadApi = async () => {
      try {
        const authToken = token || localStorage.getItem('auth_token');
        const r = await fetch(`/api/billing-methods`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const j = await r.json();
        const list = Array.isArray(j?.data) ? j.data : [];
        if (list.length) {
          setBillingMethodsByProfile(prev => {
            const next = { ...prev };
            for (const m of list) {
              const pid = String(m.profile_id || '');
              if (!next[pid]) next[pid] = [];
              const enriched = {
                ...m,
                source: 'api',
                type: m.brand || m.type || 'Card',
                last4: m.last4 || '',
                channel: m.channel || '',
                tags: Array.isArray(m.tags) ? m.tags : (() => { try { return JSON.parse(m.tags || '[]'); } catch { return []; } })(),
                alias: m.alias || ''
              };
              const seen = new Set(next[pid].map((x:any) => x.last4 || x.id));
              if (!seen.has(enriched.last4 || enriched.id)) {
                next[pid].push(enriched);
              }
            }
            return next;
          });
        }
      } catch {}
    };
    loadApi();
  }, []);

  // 🚀 加载所有卡片后刷新 channelOptions / tagOptions
  useEffect(() => {
    const chSet = new Set<string>();
    const tagSet = new Set<string>();
    // 从 state 和 localStorage 收集
    for (const pid of Object.keys(billingMethodsByProfile)) {
      for (const m of billingMethodsByProfile[pid]) {
        if (m.channel && typeof m.channel === 'string') chSet.add(m.channel);
        if (Array.isArray(m.tags)) m.tags.forEach((t: string) => tagSet.add(t));
      }
    }
    try {
      const raw = localStorage.getItem('billingMethodsByProfile');
      if (raw) {
        const byProfile = JSON.parse(raw);
        for (const pid of Object.keys(byProfile)) {
          for (const m of byProfile[pid]) {
            if (m.channel && typeof m.channel === 'string') chSet.add(m.channel);
            if (Array.isArray(m.tags)) m.tags.forEach((t: string) => tagSet.add(t));
          }
        }
      }
    } catch {}
    setChannelOptions(Array.from(chSet));
    setTagOptions(Array.from(tagSet));
  }, [billingMethodsByProfile]);
  const [limitsError, setLimitsError] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [currencyFilter, setCurrencyFilter] = useState<string>('');
  const [countryFilter, setCountryFilter] = useState<string>('');
  const [bmEmailFilter, setBmEmailFilter] = useState<string>('');
  const [profileEmailFilter, setProfileEmailFilter] = useState<string>('');
  // 🚀 分组 / 标签 下拉筛选（页面、BM、广告号等标签页通用）
  const [groupFilter, setGroupFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [isPublishOpen, setIsPublishOpen] = useState(false);
  const [publishPosting, setPublishPosting] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [publishResult, setPublishResult] = useState<any | null>(null);
  const [publishProgress, setPublishProgress] = useState<{done:number,total:number}>({done:0,total:0});
  const [publishFailed, setPublishFailed] = useState<Array<{profileId:string;adAccountId:string}>>([]);
  const [publishTemplates, setPublishTemplates] = useState<Array<{id:string;name:string;data:any}>>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [publishConcurrency, setPublishConcurrency] = useState<number>(3);
  const [publishForm, setPublishForm] = useState<{campaignName:string;adName:string;text:string;link:string;imageUrl:string;headline:string;description:string;pageId:string;objective:string;dailyBudget:number;cta:string;placements:string;pixelId:string}>({campaignName:'Campaign',adName:'Ad',text:'',link:'',imageUrl:'',headline:'',description:'',pageId:'',objective:'LINK_CLICKS',dailyBudget:5,cta:'LEARN_MORE',placements:'',pixelId:''});
  const [publishPagesLoading, setPublishPagesLoading] = useState(false);
  const [publishPagesError, setPublishPagesError] = useState('');
  useEffect(() => {
    try { const raw = localStorage.getItem('adaccounts:publishForm'); if (raw) { const obj = JSON.parse(raw); setPublishForm(f=>({ ...f, ...obj })); } } catch {}
    try { const rawT = localStorage.getItem('adaccounts:publishTemplates'); if (rawT) { const arr = JSON.parse(rawT); if (Array.isArray(arr)) setPublishTemplates(arr); } } catch {}
    try { const rawC = localStorage.getItem('adaccounts:publishConcurrency'); if (rawC) { const n = Number(rawC); if (!isNaN(n) && n>=1 && n<=10) setPublishConcurrency(n); } } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem('adaccounts:publishForm', JSON.stringify(publishForm)); } catch {}
  }, [publishForm]);
  useEffect(() => { try { localStorage.setItem('adaccounts:publishTemplates', JSON.stringify(publishTemplates)); } catch {} }, [publishTemplates]);
  useEffect(() => { try { localStorage.setItem('adaccounts:publishConcurrency', String(publishConcurrency)); } catch {} }, [publishConcurrency]);
  const [isPageCreatorOpen, setIsPageCreatorOpen] = useState(false);
  const [isSmartPublishOpen, setIsSmartPublishOpen] = useState(false);
  const [isCreateBMOpen, setIsCreateBMOpen] = useState(false);
  const [createTargets, setCreateTargets] = useState<any[]>([]);
  const [createBMName, setCreateBMName] = useState('');
  const [isRandomBMName, setIsRandomBMName] = useState(false);
  const [createBMCountry, setCreateBMCountry] = useState('');
  // 🚀 BM创建代理选择
  const [bmProxyList, setBmProxyListAV] = useState<Array<any>>([]);
  const [bmSelectedProxyId, setBmSelectedProxyIdAV] = useState('');
  const [bmProxyManualInput, setBmProxyManualInputAV] = useState('');
  const [bmProxyType, setBmProxyTypeAV] = useState('http');
  const [createBMEmail, setCreateBMEmail] = useState('');
  const [isRandomBMEmail, setIsRandomBMEmail] = useState(false);
  const [createBMCount, setCreateBMCount] = useState(1);
  const [bmCreateAdAccount, setBmCreateAdAccount] = useState(false);
  const [bmCreatePage, setBmCreatePage] = useState(false);
  const [bmDefaultPageName, setBmDefaultPageName] = useState('');
  // 📧 创建BM：建完自动生成邀请链接（每个 BM N 个）
  const [bmInviteEnabled, setBmInviteEnabled] = useState(false);
  // 🔗 创建BM联动：建完后自动对该配置跑一次「获取信息」（广告号数/BM状态/创建时间立即填充）
  const [bmAutoFetchInfo, setBmAutoFetchInfo] = useState(true);
  // 🛒 创建BM联动：邀请链接生成后自动上架商城（价格 USDT，默认 0）
  const [bmShopPublish, setBmShopPublish] = useState(false);
  const [bmShopPrice, setBmShopPrice] = useState(0);
  const [bmInviteCount, setBmInviteCount] = useState(1);
  // 👤 BM 创建者名字/姓氏（可选；各自可勾「用配置 ID」→ 提交该配置的 profileId）
  const [useProfileIdFirstName, setUseProfileIdFirstName] = useState(false);
  const [useProfileIdLastName, setUseProfileIdLastName] = useState(false);
  const [bmFirstName, setBmFirstName] = useState('');
  const [bmLastName, setBmLastName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // 🚀 随机邮箱生成
  const generateRandomEmail = () => {
    const domains = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'];
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const firstNameLen = 4 + Math.floor(Math.random() * 4);
    const lastNameLen = 3 + Math.floor(Math.random() * 3);
    let user = '';
    for (let i = 0; i < firstNameLen; i++) user += chars[Math.floor(Math.random() * chars.length)];
    user += '.';
    for (let i = 0; i < lastNameLen; i++) user += chars[Math.floor(Math.random() * chars.length)];
    let num = '';
    for (let i = 0; i < 4; i++) num += Math.floor(Math.random() * 10);
    const domain = domains[Math.floor(Math.random() * domains.length)];
    return `${user}${num}@${domain}`;
  };

  // 🆕 BM 管理操作弹窗
  const [isBMOperationsOpen, setIsBMOperationsOpen] = useState(false);
  const [bmOperationsItems, setBmOperationsItems] = useState<Array<{ profileId: string; bmId: string; name?: string }>>([]);
  
  // 🆕 授权主页给BM 弹窗
  const [isGrantPageOpen, setIsGrantPageOpen] = useState(false);

  // 🆕 授权到个人号 弹窗 (广告号 / 主页 共用)
  const [isAssignPersonalOpen, setIsAssignPersonalOpen] = useState(false);
  const [assignPersonalMode, setAssignPersonalMode] = useState<'adAccount' | 'page'>('adAccount');
  // 🆕 授权到 BM 弹窗
  const [isAssignToBmOpen, setIsAssignToBmOpen] = useState(false);
  
  // 🆕 更改货币/时区 弹窗
  const [isCcyTzOpen, setIsCcyTzOpen] = useState(false);
  const [ccyTzLoading, setCcyTzLoading] = useState(false);
  
  // 🆕 创建广告账户 弹窗
  const [isCreateAdAccountOpen, setIsCreateAdAccountOpen] = useState(false);

  const refreshAdAccounts = async () => {
    try {
      // 🛡️ 只渲染"完整"的缓存：缺行的旧缓存（行数 ≠ 服务器 total）直接不渲染，
      //    否则会出现「先 192 条 → 再 215 条」这种数据不一致的闪烁
      const cachedRows = readAdsCache();
      if (!cachedRows) return;
      // 🚀 从本地缓存 pages 数据统计真实主页数量（避免先显示 0 再刷新）
      let localPageCountMap = new Map<string, number>();
      try {
        const pageRaw = localStorage.getItem('cache:pages');
        if (pageRaw) {
          const pageArr = JSON.parse(pageRaw);
          if (Array.isArray(pageArr)) {
            pageArr.forEach((pg: any) => {
              const pid = String(pg.profileId || '');
              if (pid) localPageCountMap.set(pid, (localPageCountMap.get(pid) || 0) + 1);
            });
          }
        }
      } catch {}
      // 🚀 从 cache:pixels 统计每个广告号的像素数量
      let localPixelCountMap = new Map<string, number>();
      try {
        const pixelRaw = localStorage.getItem('cache:pixels');
        if (pixelRaw) {
          const pixelArr = JSON.parse(pixelRaw);
          if (Array.isArray(pixelArr)) {
            pixelArr.forEach((px: any) => {
              const aid = String(px.account_id || '').replace(/^act_/, '');
              if (aid) localPixelCountMap.set(aid, (localPixelCountMap.get(aid) || 0) + 1);
            });
          }
        }
      } catch {}
      let arr = cachedRows;
      // 🚀 V5.6.9: 过滤缓存数据，只保留当前 profiles 对应的数据，避免闪一下
      // 🚀 V5.7.0: superadmin 跳过过滤，确保能看到所有数据
      const profileIdSet = new Set(profiles.map(p => p.id).filter(Boolean));
      if (!isSuperadmin && profileIdSet.size > 0 && Array.isArray(arr)) {
        arr = arr.filter((item: any) => profileIdSet.has(String(item.profileId || item.profile_id || '')));
      }
      if (Array.isArray(arr)) {
        const mapped = arr.map((item: any) => {
          const pid = String(item.profileId || item.profile_id || '');
          const prof = profiles.find(p => String(p.id) === pid);
          
          // 优先使用 profiles 中的数据，如果没有则保留后端返回的原始数据
          const accountDisplay = (
            (prof?.account?.name) || (prof?.account?.email) || item.account || item.account_name || item.user_name || ''
          );
          const pname = (prof?.name || item.profileName || item.profile_name || '');
          
          return {
            ...item,
            owner_email: item.owner_email || '',
            profileId: pid,
            account: accountDisplay || t('status.unknown'),
            profileName: pname || t('status.unnamed'),
            // 🚀 核心映射：将数据库字段映射到前端表格 Accessor
            adAccountName: item.name || item.adAccountName,
            adAccountId: item.account_id || item.adAccountId,
            spendCap: item.credit_limit ?? item.spendCap ?? 0,
            threshold: item.threshold_amount ?? item.threshold ?? 0,
            // 🚀 修正：使用 ?? 替代 ||，避免 0 被当成 falsy 吞掉
            adsCount: item.ads_count ?? item.adsCount ?? 0,
            pagesCount: localPageCountMap.get(pid) ?? item.pages_count ?? item.pagesCount ?? 0,
            bmCount: item.bm_count ?? item.bmCount ?? 0,
            pixelsCount: localPixelCountMap.get(String(item.account_id || item.adAccountId || '').replace(/^act_/, '')) ?? item.pixels_count ?? item.pixelsCount ?? 0,
            // 🚀 修正：统一 fundingSource 字段名，匹配表格 accessor
            fundingSource: item.funding_source || item.fundingSource || item.paymentInfo || '',
            paymentCount: (item.funding_source || item.fundingSource || item.paymentInfo) ? 1 : (item.paymentCount ?? 0),
            // 🚀 修正：显式映射 timezone_id
            timezone_id: item.timezone_id || item.timezoneId || ''
          };
        });
        setAdAccountsDb(prev => mergeRowsById(prev as any[], mapped, 'adAccountId') as AdAccountAsset[]);
        setAdsLoaded(true);
      }
    } catch {}
  };

  // 🚀 将 PUP 获取结果写入 localStorage 缓存，确保 AssetViewer 可直接读取
  // ⚠️ 注意：仅替换当前 profileId 的数据，不做全量合并，防止跨用户数据泄露
  // 🛡️ 把一次抓取结果里的主页（me/accounts，带 tasks）落成「账号权限」列的数据。
  //    只有「获取信息」/「获取主页」这两个动作会调它 —— 列表刷新不再自动探测。
  //    合并与落盘在 utils/constants 的 mergePageRightsCache 里（配置列表也走同一份缓存）。
  const applyPageRightsFromPages = (pid: string, pages: any[]) => {
    const next = mergePageRightsCache(pid, pages);
    if (next) setPageRights(next);
  };

  const writeFetchResultToCache = (profileId: string, json: any) => {
    try {
      const adAccounts = Array.isArray(json.data) ? json.data : [];
      // 🚀 从 json.pixels 构建每个广告号的像素计数（像素单独请求，不在 adAccount 上）
      const pixelCountMap = new Map<string, number>();
      if (Array.isArray(json.pixels)) {
        json.pixels.forEach((px: any) => {
          const aid = String(px.account_id || '').replace(/^act_/, '');
          if (aid) pixelCountMap.set(aid, (pixelCountMap.get(aid) || 0) + 1);
        });
      }
      // adaccounts — 仅替换当前 profile 的数据
      const existingAd = (() => { try { return JSON.parse(localStorage.getItem('cache:adaccounts') || '[]'); } catch { return []; } })();
      const filteredAd = Array.isArray(existingAd) ? existingAd.filter((x:any) => String(x.profileId) !== String(profileId)) : [];
      // 🗂️ 备注/分组/标签/Token 是用户数据（Graph 不返回），本次覆盖前先留一份，
      //    否则「获取信息」会把这几列抹成空（缓存是按 profileId 整体替换的）
      const prevMetaByAid = new Map<string, { notes: string; group: string; tags: any[]; tokenValue: string; businessId: string }>();
      if (Array.isArray(existingAd)) {
        existingAd.forEach((x: any) => {
          const aid = String(x.adAccountId || x.account_id || x.accountId || '');
          if (aid) prevMetaByAid.set(aid, { notes: x.notes || '', group: x.group || '', tags: x.tags || [], tokenValue: x.tokenValue || x.accessToken || '', businessId: String(x.businessId || x.business_id || '') });
        });
      }
      const adMapped = adAccounts.map((a:any) => {
        const aid = String(a.account_id || a.id || '');
        const prevMeta = prevMetaByAid.get(aid);
        let tzDisplay = String(a.timezone_id || a.timezone || '');
        if (a.timezone_name) {
          const offset = a.timezone_offset_hours_utc;
          const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
          tzDisplay = `${a.timezone_name}${offsetStr}`;
        } else if (a.timezone_name_display) { tzDisplay = a.timezone_name_display; }
        const adsCount = a.ads && Array.isArray(a.ads.data) ? a.ads.data.length : 0;
        const pagesCount = a.promotable_pages && Array.isArray(a.promotable_pages.data) ? a.promotable_pages.data.length : 0;
        const bmCount = a.business ? 1 : 0;
        const pixelsCount = pixelCountMap.get(String(a.account_id || a.id || '').replace(/^act_/, '')) || 0;
        const fs = a.funding_source_details;
        const rawCard = fs ? (fs.display_string || fs.display_name || '') : '';
        const lastFour = rawCard.match(/\d{4}/)?.[0] || '';
        const cardInfo = lastFour ? `${lastFour} (${fs?.type || ''})` : (rawCard || '');
        return {
          profileId, adAccountId: a.account_id || a.id, accountId: a.account_id || a.id,
          // 🐛 修复：以前只写了 accountName，而表格列的 accessor 是 adAccountName → 名称列取自缓存时为空
          name: a.name || '',
          adAccountName: a.name || a.accountName || '',
          accountName: a.name || a.accountName || '',
          // 🐛 修复：以前写的是 accountStatus（且表格列要 adAccountStatus）→ 状态列取自缓存时为空
          adAccountStatus: adAccountStatusLabel(a.account_status ?? a.status),
          accountStatus: a.account_status ?? a.status ?? 1,
          // 💰 Graph 金额字段是「货币最小单位」（USD 即分）→ 统一换算成主单位再入缓存，
          //    否则「额度 / 账单 / 门槛」列会多两个 0（16000 应为 160）。
          //    ⚠️ 限额 spend_cap 也一样：Meta 写入用「元」、读取返回「分」，
          //       所以这里必须 ÷100，列表才会显示你提交的那个值（提交 0.02 → 显示 0.02）。
          currency: a.currency || '', balance: toMajorAmount(a.balance, a.currency),
          spend: toMajorAmount(a.amount_spent, a.currency),
          disableReason: a.disable_reason ?? 0,
          spendCap: toMajorAmount(a.spend_cap, a.currency),
          creditLimit: toMajorAmount(a.spend_cap, a.currency),
          threshold: toMajorAmount(a.min_daily_budget, a.currency),
          threshold_amount: toMajorAmount(a.min_daily_budget, a.currency),
          fundingSource: cardInfo || (a.funding_source ?? ''),
          timezone_id: tzDisplay,
          timezoneId: tzDisplay,
          // 🌍 国家：服务端存的是 business_country_code，表格列 accessor 是 country
          //    （以前缓存映射漏了这个字段 → 获取信息后国家列必空，只有等服务器数据回来才补齐）
          country: a.business_country_code || a.country || '',
          paymentCount: (cardInfo || a.funding_source || a.paymentInfo) ? 1 : 0,
          adsCount, pagesCount, bmCount, pixelsCount,
          ads_count: adsCount, pages_count: pagesCount, bm_count: bmCount, pixels_count: pixelsCount,
          // 🏢 广告号归属的 BM：Graph 抓取时带了 business{id,name}，但以前只用来算 bmCount(0/1)、
          //    没落盘 → BM 列表没法知道「哪些广告号在这个 BM 里」，只能按配置猜。
          //    现在存下来，BM 列表就能按 BM 精确统计（Graph 不再返回时沿用上次缓存的值）。
          // 🏢 广告号归属的 BM：Graph 抓取时带了 business{id,name}。
          //    ⚠️ 兜底要同时认 businessId（本地缓存形状）和 business_id（服务端返回形状），
          //       否则从服务端刷回来的那一份会被当成空值、把归属写丢 → BM 列表统计全空。
          businessId: String(a.business?.id || prevMeta?.businessId || prevMeta?.business_id || ''),
          business_id: String(a.business?.id || prevMeta?.businessId || prevMeta?.business_id || ''),
          businessName: a.business?.name || '',
          account: a.account || a.account_name || a.name || '',
          profileName: a.profileName || a.profile_name || (profiles.find(p=>p.id===profileId)?.name || ''),
          profile_name: a.profileName || a.profile_name || (profiles.find(p=>p.id===profileId)?.name || ''),
          // 📝 备注/分组/标签/时间：用户数据优先沿用上一份缓存，避免被 Graph 的空字段抹掉
          notes: prevMeta?.notes || a.notes || '',
          group: prevMeta?.group || a.group || a.group_col || '',
          tags: (Array.isArray(prevMeta?.tags) && prevMeta!.tags.length > 0) ? prevMeta!.tags : (a.tags || a.tags_col || []),
          updated_at: a.updated_at || new Date().toISOString(),
          // 🚀 核心修复：保存 tokenValue，确保缓存中有 token（配置不在首屏 50 条时沿用旧缓存，别写成空）
          tokenValue: profiles.find(p => String(p.id) === String(profileId))?.token || prevMeta?.tokenValue || ''
        };
      });
      localStorage.setItem('cache:adaccounts', JSON.stringify([...filteredAd, ...adMapped]));
      // 这里只是"按 profile 局部覆盖"，整体是否完整未知 → 清掉完整性标记，下次全量刷新再写
      clearAdsCacheMeta();
      // pages — 同时从 json.pages 和 adAccounts promotable_pages 提取
      const existingPages = (() => { try { return JSON.parse(localStorage.getItem('cache:pages') || '[]'); } catch { return []; } })();
      const filteredPages = Array.isArray(existingPages) ? existingPages.filter((x:any) => String(x.profileId) !== String(profileId)) : [];
      const pagesFromPromotable = adAccounts.flatMap((a:any) => (a.promotable_pages?.data||[]).map((p:any) => ({ profileId, pageId: p.id, pageName: p.name, pageCategory: p.category, pageAccessToken: p.access_token, pageTasks: Array.isArray(p.tasks) ? p.tasks.join(',') : '' })));
      const pagesFromJson = Array.isArray(json.pages) ? json.pages.map((p:any) => ({ profileId, pageId: p.id || p.pageId, pageName: p.name || p.pageName, pageCategory: p.category, pageAccessToken: p.access_token, pageTasks: '' })) : [];
      const allPages = [...pagesFromJson, ...pagesFromPromotable].filter((v,i,a) => a.findIndex(x => x.pageId === v.pageId) === i);
      console.log(`[AssetViewer] writeFetchResultToCache: profile=${profileId} pagesJson=${pagesFromJson.length} promotable=${pagesFromPromotable.length} allPages=${allPages.length}`);
      localStorage.setItem('cache:pages', JSON.stringify([...filteredPages, ...allPages]));
      // 🛡️「获取信息」顺带把 me/accounts 的角色（tasks）落成「账号权限」列的数据
      applyPageRightsFromPages(profileId, Array.isArray(json.pages) ? json.pages : []);
      // businesses — 从 adAccounts business 和 json.bms 提取
      // ⚠️ 剔除「本配置」的旧行时必须两种命名都认（云端原始行是蛇形 profile_id）：
      //    只认 profileId 的话，之前从服务器整体刷进来的那批蛇形行会被漏下 → 同一个 BM 存两份。
      const existingBms = (() => { try { return JSON.parse(localStorage.getItem('cache:businesses') || '[]'); } catch { return []; } })();
      const filteredBms = Array.isArray(existingBms) ? existingBms.filter((x:any) => String(x.profileId || x.profile_id || '') !== String(profileId)) : [];
      const bmsFromArray = adAccounts.filter((a:any)=>a.business).map((a:any)=>({profileId,businessId:a.business.id,name:a.business.name,verification_status:a.business.verification_status}));
      const bmsFromJson = Array.isArray(json.bms) ? json.bms.map((b:any)=>{
        const bu = (b.business_users && b.business_users.data) || [];
        const pu = (b.pending_users && b.pending_users.data) || [];
        return {
          profileId,
          businessId: b.id,
          name: b.name,
          verification_status: b.verification_status,
          // 🕒 BM 创建时间（服务端已把 Graph creation_time 附到 bms 上）
          fbCreatedTime: String(b.creation_time || b.fb_created_time || ''),
          // 🔢 可创建广告号上限（服务端已把内部 GraphQL 的 ad_account_creation_limit 附到 bms 上）
          adAccountLimit: adLimitOf(b),
          // 👥 BM 成员（邮箱+角色）：成员 + 待接受邀请（pending 统一 active_status=PENDING）
          bmUsers: [
            ...bu.map((u:any)=>({ id:String(u.id||''), name:String(u.name||''), email:String(u.email||''), role:String(u.role||''), active_status:String(u.active_status||'') })),
            ...pu.map((u:any)=>({ id:String(u.id||''), name:'', email:String(u.email||''), role:String(u.role||''), active_status:String(u.status||'PENDING') })),
          ]
        };
      }) : [];
      // 🩺 获取信息带了 withAccountQuality 时，后端在关浏览器前顺带探测了 BM 自身状态
      //    （json.bmAccountQuality = [{businessId,status,evidence,policy}]）→ 并进行，探测结果优先；
      //    没探测到的 BM 再由 keepAqFromCache 用旧缓存补，别被这次覆盖抹掉。
      //    ⚠️ 只并「本配置」的行：同一个 BM 理论上可能挂在多个配置下，不能按 BM ID 全局覆盖。
      const aqByBid = new Map<string, any>();
      if (Array.isArray(json.bmAccountQuality)) {
        (json.bmAccountQuality as any[]).forEach((r) => { const bid = String(r?.businessId || ''); if (bid) aqByBid.set(bid, r); });
      }
      const mergeAq = (rows: any[]) => rows.map((r: any) => {
        if (String(r.profileId || profileId) !== String(profileId)) return r;
        const aq = aqByBid.get(String(r.businessId || ''));
        return aq ? { ...r, aqStatus: String(aq.status || ''), aqEvidence: String(aq.evidence || ''), aqPolicy: String(aq.policy || '') } : r;
      });
      // 🩺 「账号质量」是浏览器探测出来的，Graph 抓不到 → 用旧缓存里的值补回来，别被这次覆盖抹掉
      const allBms = normBmRows(keepAqFromCache(mergeAq([...filteredBms, ...bmsFromJson, ...bmsFromArray])));
      localStorage.setItem('cache:businesses', JSON.stringify(allBms));
      // pixels — 仅替换当前 profile 的数据
      const existingPixels = (() => { try { return JSON.parse(localStorage.getItem('cache:pixels') || '[]'); } catch { return []; } })();
      const filteredPixels = Array.isArray(existingPixels) ? existingPixels.filter((x:any) => String(x.profileId) !== String(profileId)) : [];
      const allPixels = Array.isArray(json.pixels) ? json.pixels.map((p:any)=>({...p,profileId})) : [];
      localStorage.setItem('cache:pixels', JSON.stringify([...filteredPixels, ...allPixels]));
      // ads — 仅替换当前 profile 的数据
      const existingAds = (() => { try { return JSON.parse(localStorage.getItem('cache:ads') || '[]'); } catch { return []; } })();
      const filteredAds = Array.isArray(existingAds) ? existingAds.filter((x:any) => String(x.profileId) !== String(profileId)) : [];
      const allAds = adAccounts.flatMap((a:any) => (a.ads?.data||[]).map((ad:any) => ({
        profileId, id: ad.id, adId: ad.id, adName: ad.name, status: ad.status, accountId: a.account_id || a.id,
        campaignId: ad.campaign?.id || '', campaignName: ad.campaign?.name || '',
        adsetId: ad.adset?.id || '', adsetName: ad.adset?.name || '',
        creativeId: ad.creative?.id || '', previewUrl: ad.creative?.thumbnail_url || '',
        targeting: ad.adset?.targeting ? JSON.stringify(ad.adset.targeting) : '',
        creativeJson: ad.creative ? JSON.stringify(ad.creative) : ''
      })));
      localStorage.setItem('cache:ads', JSON.stringify([...filteredAds, ...allAds]));
      // 🛡️ 同时把数量直接写进 profiles[].assets —— 配置列表的数量列读的就是它。
      //    以前这个更新只靠一个 window 事件（batch-asset-fetch-completed）：用户当时如果不在
      //    配置列表页，事件没人监听就丢了，数量要等下次进列表、或打开过 BM 列表写出 cache 之后才补上
      //    （看起来就是「必须先显示 BM 列表才有数量」）。直接写 state 才能做到「获取信息完立即显示」。
      if (setProfiles) {
        setProfiles((prev: any[]) => (prev || []).map((p: any) => String(p.id) === String(profileId)
          ? { ...p, assets: { ...(p.assets || {}), adsCount: allAds.length, pagesCount: allPages.length, bmCount: allBms.length, pixelsCount: allPixels.length } }
          : p));
      }
    } catch (e) { console.warn('writeFetchResultToCache failed:', e); }
  };

  // 🧵 从后端取回「队列刚抓到的结果」并落位到本地缓存 + 刷新界面。
  //    创建BM（含「建完自动获取信息」）与 BM 管理弹窗共用这一条：
  //    队列服务端已经抓完并同步了云端，但 localStorage 缓存只有前端能写 ——
  //    不落位的话，本地列表（BM/广告号数量、BM 状态）要等下次手动跑「获取信息」才更新。
  const applyLastAssetsToLocal = async (pids: string[]) => {
    const list = Array.from(new Set((pids || []).map(String))).filter(Boolean);
    if (!list.length) return;
    for (const pid of list) {
      try {
        const res = await getLastAssets(pid);
        if (res && res.success !== false) writeFetchResultToCache(pid, res);
      } catch {}
    }
    // 🚀 本地缓存先出（秒显），再通知配置列表更新数量列
    try { refreshAds(); refreshAdAccounts(); refreshPages(); refreshBusinesses(); } catch {}
    try { window.dispatchEvent(new CustomEvent('batch-asset-fetch-completed', { detail: {} })); } catch {}
    try {
      window.dispatchEvent(new Event('posts-refresh'));
      window.dispatchEvent(new Event('messages-refresh'));
    } catch {}
  };

  // 🚀 合并刷新：一次请求获取所有资产类型，替代 4 次独立 API 调用
  const refreshAllAssets = async () => {
    try {
      let sbase = (((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '/').replace(/\/$/, '');
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const authToken = token || localStorage.getItem('auth_token');
      if (!authToken) return;
      
      // 🚀 不传 profileIds，后端按 user_id 过滤（非 superadmin），避免分页加载不全问题
      const resp = await fetch(`${sbase}/api/assets/batch-refresh?_t=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache', 'Authorization': `Bearer ${authToken}` }
      });
      const json = await resp.json();
      if (!json?.success) return;

      // 映射 adAccounts
      if (Array.isArray(json.adAccounts)) {
        const nameToId = new Map<string, string>(profiles.map(p => [String(p.name || ''), String(p.id)]));
        const accToId = new Map<string, string>();
        profiles.forEach(p => {
          const n = String(p.account?.name || '').trim();
          const e = String(p.account?.email || '').trim();
          if (n) accToId.set(n, String(p.id));
          if (e) accToId.set(e, String(p.id));
        });
        const mappedList = json.adAccounts.map((item: any) => {
          let pid = String(item.profileId || item.profile_id || '');
          let prof = profiles.find(p => String(p.id) === pid);
          if (!pid) {
            const byName = String(item.profileName || item.profile_name || '');
            const byAcc = String(item.account || item.account_name || item.user_name || '');
            const guessId = nameToId.get(byName || '') || accToId.get(byAcc || '');
            if (guessId) { pid = guessId; prof = profiles.find(p => String(p.id) === pid); }
          }
          const name = item.name || item.accountName || `Account ${item.account_id}`;
          return {
            ...item,
            owner_email: item.owner_email || '',
            profileId: pid,
            profileName: prof?.name || item.profileName || item.profile_name || `Profile ${pid}`,
            adAccountName: name,
            adAccountId: item.account_id || item.id,
            adAccountStatus: item.status ?? item.account_status,
            spend: Number(item.spend ?? item.amount_spent ?? 0),
            // 💰 额度列存的是 Meta 的 spend_cap（「分」）→ ÷100 显示，才会等于你提交的值
            spendCap: toMajorAmount(item.credit_limit ?? item.spend_cap ?? 0, item.currency),
            adsCount: item.adsCount ?? item.ads_count ?? 0,
            pagesCount: item.pagesCount ?? item.pages_count ?? 0,
            bmCount: item.bmCount ?? item.bm_count ?? 0,
            pixelsCount: item.pixelsCount ?? item.pixels_count ?? 0,
            paymentCount: item.paymentCount ?? item.payment_count ?? 0,
            country: item.country ?? item.business_country_code,
            currency: item.currency,
            timezone_id: item.timezone_id,
            balance: Number(item.balance ?? 0),
            threshold: item.threshold_amount ?? item.spend_cap,
            fundingSource: item.funding_source || ''
          };
        });
      setAdAccountsDb(prev => mergeRowsById(prev as any[], mappedList, 'adAccountId') as AdAccountAsset[]);
      try { localStorage.setItem('cache:adaccounts', JSON.stringify(mappedList)); writeAdsCacheMeta(mappedList.length); } catch {}
    }

    // 映射 ads
    const adsList = Array.isArray(json.ads) ? json.ads : [];
    const mappedAds = adsList.map((item: any) => {
      const pid = String(item.profileId || item.profile_id || '');
      const prof = profiles.find(p => String(p.id) === pid);
      return {
        ...item,
        owner_email: item.owner_email || '',
        profileId: pid,
        profileName: prof?.name || item.profileName || item.profile_name || `Profile ${pid}`,
        adId: item.ad_id || item.id,
        adName: item.name || item.adName,
        status: item.status,
        accountId: item.account_id,
        campaignId: item.campaign_id,
        campaignName: item.campaign_name,
        adsetId: item.adset_id,
        adsetName: item.adset_name,
        creativeId: item.creative_id,
        previewUrl: item.preview_url,
        targeting: item.targeting,
        creativeJson: item.creative_json
      };
    });
    setAdsDb(mappedAds);
    try { localStorage.setItem('cache:ads', JSON.stringify(mappedAds)); } catch {}

    // 映射 pages
    const pagesList = Array.isArray(json.pages) ? json.pages : [];
    const mappedPages = pagesList.map((item: any) => {
      const pid = String(item.profileId || item.profile_id || '');
      const prof = profiles.find(p => String(p.id) === pid);
      return {
        ...item,
        owner_email: item.owner_email || '',
        profileId: pid,
        profileName: prof?.name || item.profileName || item.profile_name || `Profile ${pid}`,
        pageId: item.page_id || item.id,
        pageName: item.name || item.pageName || `Page ${item.page_id || item.id}`,
        likes: Number(item.fan_count ?? item.likes ?? 0),
        status: (item.is_published === 0 || item.status === 'Unpublished') ? 'Unpublished' : 'Published'
      };
    });
    setPagesDb(mappedPages);
    try { localStorage.setItem('cache:pages', JSON.stringify(mappedPages)); } catch {}

    // 映射 businesses
    const bmsList = Array.isArray(json.businesses) ? json.businesses : [];
    const mappedBms = bmsList.map((b: any) => ({
      profileId: String(b.profileId || b.profile_id || ''),
      profileName: String(b.profileName || ''),
      bmId: String(b.businessId || b.business_id || b.id || ''),
      bmName: String(b.name || b.bmName || ''),
      verificationStatus: (String(b.verification_status || '').toLowerCase() || 'unknown') as 'verified' | 'not_verified' | 'unknown',
      adminEmail: b.admin_email ? String(b.admin_email) : undefined,
      updated_at: b.updated_at || '',
      // 🩺 账号质量（云端 aq_* 列）
      ...aqOfCloudRow(b),
      // 👥 BM 成员（云端 bm_users 列）
      bmUsers: bmUsersOf(b),
      // 🕒 BM 创建时间（云端 fb_created_time 列）
      fbCreatedTime: fbCreatedOf(b),
      // 🔢 可创建广告号上限（云端 ad_account_limit 列）
      adAccountLimit: adLimitOf(b)
    })).filter(x => x.bmId && x.bmId.length > 0);
    setBusinessesDb(mappedBms);
    // ⚠️ 写缓存时归一化（mappedBms 用的是界面键 bmId，其它读取方按 businessId / business_id 取 → 会读空）
    // 🩺 云端已带 aq_* 列；旧库里还没有的行再从本地缓存补回来
    try { localStorage.setItem('cache:businesses', JSON.stringify(normBmRows(keepAqFromCache(mappedBms)))); } catch {}
    try { window.dispatchEvent(new Event('businesses-refresh')); } catch {}
    } catch (e) {
      console.error('batch-refresh failed:', e);
    }
  };

  const refreshAdsFromServer = async () => {
    try {
      let sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const authToken = localStorage.getItem('auth_token');
      
      // 🚀 不传 profileIds，后端按 user_id 过滤（非 superadmin），避免分页加载不全问题
      const resp = await fetch(`${sbase}/api/ads?_t=${Date.now()}`, {
        headers: { 
          'Cache-Control': 'no-cache',
          'Authorization': `Bearer ${authToken}`
        } 
      });
      const json = await resp.json();
      const list = (json && json.success && Array.isArray(json.data)) ? json.data : [];
      
      const mappedList = list.map((item: any) => {
        const pid = String(item.profileId || item.profile_id || '');
        const prof = profiles.find(p => String(p.id) === pid);
        return {
          ...item,
          owner_email: item.owner_email || '',
          profileId: pid,
          profileName: prof?.name || item.profileName || item.profile_name || `Profile ${pid}`,
          adId: item.ad_id || item.id,
          adName: item.name || item.adName,
          status: item.status,
          accountId: item.account_id,
          campaignId: item.campaign_id,
          campaignName: item.campaign_name,
          adsetId: item.adset_id,
          adsetName: item.adset_name,
          creativeId: item.creative_id,
          previewUrl: item.preview_url,
          targeting: item.targeting,
          creativeJson: item.creative_json
        };
      });
      if (mappedList.length > 0) {
        setAdsDb(mappedList);
        try { localStorage.setItem('cache:ads', JSON.stringify(mappedList)); } catch {}
      }
    } catch (e) {
      console.error('Failed to refresh ads:', e);
    }
  };

  const refreshAds = async () => {
    try {
      const raw = localStorage.getItem('cache:ads');
      let arr = raw ? JSON.parse(raw) : [];
      // 🚀 V5.6.9: 过滤缓存数据，只保留当前 profiles 对应的数据，避免闪一下
      // 🚀 V5.7.0: superadmin 跳过过滤
      const profileIdSet = new Set(profiles.map(p => p.id).filter(Boolean));
      if (!isSuperadmin && profileIdSet.size > 0 && Array.isArray(arr)) {
        arr = arr.filter((item: any) => profileIdSet.has(String(item.profileId || item.profile_id || '')));
      }
      if (Array.isArray(arr)) setAdsDb(arr);
    } catch {}
  };

  const refreshPagesFromServer = async () => {
    try {
      let sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const authToken = token || localStorage.getItem('auth_token');
      if (!authToken) return;
      
      // 🚀 不传 profileIds，后端按 user_id 过滤（非 superadmin），避免分页加载不全问题
      const resp = await fetch(`${sbase}/api/pages?_t=${Date.now()}`, {
        headers: { 
          'Cache-Control': 'no-cache',
          'Authorization': `Bearer ${authToken}`
        } 
      });
      const json = await resp.json();
      const rawList = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []);
      
      const mappedList = rawList.map((item: any) => {
        const pid = String(item.profileId || item.profile_id || '');
        const prof = profiles.find(p => String(p.id) === pid);
        return {
          ...item,
          owner_email: item.owner_email || '',
          profileId: pid,
          profileName: prof?.name || item.profileName || item.profile_name || `Profile ${pid}`,
          pageId: item.page_id || item.id,
          pageName: item.name || item.pageName || `Page ${item.page_id || item.id}`,
          likes: Number(item.fan_count ?? item.likes ?? 0),
          status: (item.is_published === 0 || item.status === 'Unpublished') ? 'Unpublished' : 'Published'
        };
      });
      if (mappedList.length > 0) {
        setPagesDb(mappedList);
        try { localStorage.setItem('cache:pages', JSON.stringify(mappedList)); } catch {}
      }
    } catch (e) {
      console.error('Failed to refresh pages:', e);
    }
  };

  const refreshAdAccountsFromServer = async () => {
    try {
      let sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const authToken = token || localStorage.getItem('auth_token');
      if (!authToken) return;
      
      // 🚀 不传 profileIds，后端按 user_id 过滤（非 superadmin），避免分页加载不全问题
      // 🚀 不传分页参数：带 page/pageSize 时后端会 LIMIT 截断（实测 pageSize=200 → 只返回 200 行，
      //    而库里实际 382 行）→ 列表"共 N 条"永远少于真实数量。不带分页参数才是全量返回。
      const [adResp, pageResp] = await Promise.all([
        fetch(`${sbase}/api/adaccounts?_t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache', 'Authorization': `Bearer ${authToken}` } }),
        fetch(`${sbase}/api/pages?_t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache', 'Authorization': `Bearer ${authToken}` } })
      ]);
      const [json, pageJson] = await Promise.all([adResp.json(), pageResp.json()]);
      const list = (json && json.success && Array.isArray(json.data)) ? json.data : [];
      setAdsLoaded(true); // 服务器已应答（哪怕 0 条）→ 空表可以显示"暂无资产"了
      
      // 🚀 从 pages 表按 profileId 统计真实数量
      const realPageCountMap = new Map<string, number>();
      if (pageJson && pageJson.success && Array.isArray(pageJson.data)) {
        pageJson.data.forEach((row: any) => {
          const pid = String(row.profileId || row.profile_id || '');
          if (!pid) return;
          realPageCountMap.set(pid, (realPageCountMap.get(pid) || 0) + 1);
        });
      }
      const nameToId = new Map<string, string>(profiles.map(p => [String(p.name || ''), String(p.id)]));
      const accToId = new Map<string, string>();
      profiles.forEach(p => {
        const n = String(p.account?.name || '').trim();
        const e = String(p.account?.email || '').trim();
        if (n) accToId.set(n, String(p.id));
        if (e) accToId.set(e, String(p.id));
      });
      
      const mappedList = list.map((item: any) => {
        let pid = String(item.profileId || item.profile_id || '');
        let prof = profiles.find(p => String(p.id) === pid);
        if (!pid) {
          const byName = String(item.profileName || item.profile_name || '');
          const byAcc = String(item.account || item.account_name || item.user_name || '');
          const guessId = nameToId.get(byName || '') || accToId.get(byAcc || '');
          if (guessId) {
            pid = guessId;
            prof = profiles.find(p => String(p.id) === pid);
          }
        }
        let statusStr = adAccountStatusLabel(item.adAccountStatus || item.account_status || item.status);
        
        const pname = prof?.name || item.profileName || item.profile_name || (pid ? `Profile ${pid}` : '') || t('status.unnamed');
        const accDisplay = (prof?.account?.name) || (prof?.account?.email) || item.account || item.account_name || item.user_name || (prof?.name) || (item.adAccountName) || t('status.unknown');

        return {
          ...item,
          owner_email: item.owner_email || '',
          profileId: pid,
          adAccountStatus: statusStr,
          profileName: String(pname),
          account: String(accDisplay),
          adAccountName: item.name || item.adAccountName,
          adAccountId: item.account_id || item.adAccountId,
          spend: item.spend ?? 0,
          spendCap: item.credit_limit ?? item.spendCap ?? 0,
          balance: item.balance ?? 0,
          threshold: item.threshold_amount ?? item.threshold ?? 0,
          pagesCount: realPageCountMap.get(pid) ?? item.pages_count ?? item.pagesCount ?? 0,
          adsCount: item.ads_count ?? item.adsCount ?? 0,
          pixelsCount: item.pixels_count ?? item.pixelsCount ?? 0,
          bmCount: item.bm_count ?? item.bmCount ?? 0,
          country: item.country || item.business_country_code || '',
          currency: item.currency || '',
          timezone_id: item.timezone_id || item.timezoneId || '',
          fundingSource: item.funding_source || item.fundingSource || item.paymentInfo || '',
          paymentCount: (item.funding_source || item.fundingSource || item.paymentInfo) ? 1 : (item.paymentCount ?? 0),
          notes: item.notes || '',
          tokenValue: (() => {
            // 🚀 优先使用后端随行返回的 profile_token（服务端 join profiles.account_tokens），
            //    避免依赖前端 profiles 仅加载前 50 条导致部分配置的 token 合并不到
            const rowToken = (item as any)?.profile_token || (item as any)?.profileToken || '';
            if (rowToken) return rowToken;
            const foundProf = profiles.find(p => String(p.id) === pid);
            return foundProf?.token || '';
          })(),
          group: item.group || item.group_col || profiles.find(p => String(p.id) === pid)?.group || '',
          tags: (() => { try { const t = item.tags || item.tags_col || ''; if (t && (typeof t === 'string' ? t.length > 0 : Array.isArray(t) ? t.length > 0 : false)) return typeof t === 'string' ? t.split(',').filter(Boolean) : Array.isArray(t) ? t : []; const foundProf = profiles.find(p => String(p.id) === pid); return foundProf?.tags || []; } catch { return []; } })()
        };
      });
      if (mappedList.length > 0) {
        // 🐛 修复：保存前合并现有缓存的 token，避免 profiles 未加载时用空 token 覆盖
        try {
          const existingRaw = localStorage.getItem('cache:adaccounts');
          if (existingRaw) {
            const existing = JSON.parse(existingRaw);
            const tokenMap = new Map<string, string>();
            // 🏢 广告号归属的 BM 只有「获取信息」从 Graph 拿得到，云端 ad_accounts 表没有这一列 ——
            //    而下面是把整个 cache:adaccounts 整体替换，不做保留就会把 businessId 抹掉。
            const bizMap = new Map<string, string>();
            // 🩺 停用原因同理：只有「获取信息」从 Graph 拿得到 disable_reason，
            //    云端 ad_accounts 表未必有这一列 —— 整体替换时不保留就会被抹成空。
            const reasonMap = new Map<string, number>();
            if (Array.isArray(existing)) {
              existing.forEach((e: any) => {
                if (e.tokenValue || e.accessToken || e.access_token) {
                  tokenMap.set(String(e.adAccountId || e.adAccount_id || ''), e.tokenValue || e.accessToken || e.access_token || '');
                }
                const bid = String(e.businessId || e.business_id || '');
                if (bid) bizMap.set(String(e.adAccountId || e.adAccount_id || ''), bid);
                const rs = disableReasonOf(e);
                if (rs) reasonMap.set(String(e.adAccountId || e.adAccount_id || ''), rs);
              });
            }
            mappedList.forEach((item: any) => {
              const aid = String(item.adAccountId || item.adAccount_id || '');
              if (!item.tokenValue && tokenMap.has(aid)) item.tokenValue = tokenMap.get(aid);
              if (!item.businessId && bizMap.has(aid)) {
                item.businessId = bizMap.get(aid);
                item.business_id = bizMap.get(aid);
              }
              if (!disableReasonOf(item) && reasonMap.has(aid)) {
                item.disableReason = reasonMap.get(aid);
                item.disable_reason = reasonMap.get(aid);
              }
            });
          }
        } catch {}
        setAdAccountsDb(prev => mergeRowsById(prev as any[], mappedList, 'adAccountId') as AdAccountAsset[]);
        // 🚀 核心修复：仅当 profiles 已加载时才保存到缓存，避免空 token 覆盖缓存
        if (profiles.length > 0) {
          try { localStorage.setItem('cache:adaccounts', JSON.stringify(mappedList)); writeAdsCacheMeta(Number(json.total ?? mappedList.length)); } catch {}
        }
      }
    } catch (e) {
      console.error('Failed to auto-fetch ad accounts:', e);
    }
  };

  const rowToggleStatus = async (pid: string) => {
    const baseUrl = 'http://localhost:9999/api';
    if (!pid) { alert('缺少 Profile ID'); return; }
    let prof = profiles.find(p => p.id === pid);
    const isRunning = prof && prof.status === BrowserStatus.RUNNING;
    
    // Debug info
    console.log(`[Launch] PID=${pid} URL=${baseUrl} Found=${!!prof} Running=${isRunning}`);

    if (isRunning) {
      try {
        const r = await fetch(`${baseUrl}/stop-browser`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          }, 
          body: JSON.stringify({ profileId: pid }) 
        });
        const json = await r.json();
        if (json && json.success && setProfiles) setProfiles(prev => prev.map(p => p.id === pid ? { ...p, status: BrowserStatus.IDLE } : p));
      } catch (e: any) {
        alert('停止失败: ' + e.message);
      }
      return;
    }

    // 🚀 prof 不在本地数组时（异步分页导致），从服务端降级获取
    if (!prof) {
      try {
        const sbase = String((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
        const authToken = localStorage.getItem('auth_token');
        const resp = await fetch(`${sbase}/api/profiles/${pid}`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await resp.json();
        if (data?.success && data?.data) {
          const serverProfile = data.data;
          prof = {
            id: String(serverProfile.id ?? pid),
            proxy: serverProfile.proxy || serverProfile.proxy_config,
            userAgent: serverProfile.userAgent,
            startupUrls: serverProfile.startupUrls,
            account: { cookies: serverProfile.cookies || serverProfile.account?.cookies },
          };
          console.log(`[Launch] 已从服务端获取 profile ${pid}，使用完整配置启动`);
        }
      } catch (e) {
        console.warn('[Launch] 服务端获取 profile 失败，使用降级启动:', e);
      }
    }

    const desiredStart = (() => {
      const s = Array.isArray(prof?.startupUrls) ? prof?.startupUrls : (prof?.startupUrls ? [prof?.startupUrls] : []);
      return (s && s.length) ? s : ['https://adsmanager.facebook.com/adsmanager/manage/campaigns'];
    })();
    const payload: any = {
      profileId: pid,
      profile: prof,
      proxy: prof?.proxy,
      startUrls: desiredStart,
      cookies: prof?.account?.cookies,
      userAgent: prof?.userAgent,
      chrome115Config: { windowTitle: String(prof?.id ?? pid) },
      strictVerifyOnly: true,
      strictStartUrls: true,
      // 单个按钮启动不受「最多 N 个浏览器」并发上限约束（该上限只用于批量启动）
      skipConcurrencyCheck: true,
      // 🖐 单个启动：自动登录没成功时保留浏览器窗口，方便直接在里面手动登录（批量启动不传此参数，仍会关窗）
      keepBrowserOnLoginFail: true
    };

    try {
      // 🧵 改成走服务端执行队列，而不是直连 /launch-browser 等 180s：
      //    直连长请求会一直占着浏览器到 localhost:9999 的一条 HTTP/1.1 连接；连点几次就把
      //    Chrome 对该 origin 的 6 条连接占满 → 页面上所有 9999 请求（队列轮询、列表刷新、
      //    后续启动）全部在浏览器本地排队、一个字节都发不出去，表现就是「点了没反应、请求都没发出」。
      //    提交给队列后本函数立即返回，进度去左侧「执行队列」看，刷新/切页也不影响执行。
      const job = await submitJob({
        type: 'launch_browser',
        title: `启动浏览器（配置 ${pid}）`,
        items: [{ key: String(pid), label: String(pid), payload }],
      });
      const finished = await waitForJob(job.id);
      const item = finished?.items?.[0];
      if (item && item.status === 'done') {
        if (setProfiles) setProfiles(prev => prev.map(p => p.id === pid ? { ...p, status: BrowserStatus.RUNNING, lastActive: new Date().toLocaleString() } : p));
      } else if (item && item.status !== 'running' && item.status !== 'queued') {
        alert('启动失败: ' + String(item.message || t('status.unknownError')));
      }
    } catch (e: any) {
      console.error(e);
      alert(`提交执行队列失败：${e?.message || e}\n请确认本机后端 9999 已启动（进度见左侧「执行队列」）`);
    }
  };

  const rowGetAndSaveTokens = async (pid: string) => {
    const baseUrl = 'http://localhost:9999/api';
    if (!pid) return;

    try {
      const prof = profiles.find(p => p.id === pid);
      const existed = prof && typeof (prof as any).token === 'string' ? String((prof as any).token) : '';
      if (existed) {
        try {
          await fetch(`${baseUrl}/facebook/save-tokens`, { 
            method: 'POST', 
            headers: { 
              'Content-Type': 'application/json',
              'X-Api-Secret': LOCAL_SERVER_SECRET
            }, 
            body: JSON.stringify({ profileId: pid, tokens: { EAAG: existed } }) 
          });
          alert('已使用现有令牌保存，跳过启动浏览器');
          refreshAdAccountsFromServer();
          return;
        } catch {}
      }
    } catch {}

    // 1. Check if browser is running, if not, launch it
    const prof = profiles.find(p => p.id === pid);
    const isRunning = prof && prof.status === BrowserStatus.RUNNING;
    if (!isRunning) {
      const confirmed = window.confirm('浏览器未启动，是否立即启动并获取信息？');
      if (!confirmed) return;
      const payload: any = {
        profileId: pid,
        profile: prof,
        proxy: prof?.proxy,
        startUrls: Array.isArray(prof?.startupUrls) ? prof?.startupUrls : (prof?.startupUrls ? [prof?.startupUrls] : []),
        cookies: prof?.account?.cookies,
        userAgent: prof?.userAgent,
        chrome115Config: { windowTitle: String(prof?.id ?? pid) },
        strictVerifyOnly: true,
        strictStartUrls: true,
        // 单个按钮启动不受「最多 N 个浏览器」并发上限约束（该上限只用于批量启动）
        skipConcurrencyCheck: true
      };
      try {
        // ⏱️ 与上面的单点启动同因：90s 比服务端最坏耗时还短，会误报超时 → 统一给 180s
        // 🚦 通过长请求闸门：启动浏览器最长 180s，直连会把 9999 的连接占满，
        //    用闸门限制同时最多 3 条长任务，保证轮询/列表始终有连接可用。
        const lResp = await withLongRequestSlot(() => fetchWithTimeout(`${baseUrl}/launch-browser`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          },
          body: JSON.stringify(payload)
        }, 180000, '启动浏览器'));
        const lJson = await lResp.json();
        if (!lJson || !lJson.success) {
          alert('自动启动浏览器失败: ' + (lJson?.message || t('status.unknownError')));
          return;
        }
        if (setProfiles) setProfiles(prev => prev.map(p => p.id === pid ? { ...p, status: BrowserStatus.RUNNING, lastActive: new Date().toLocaleString() } : p));
        // Wait a bit for browser to initialize (shortened)
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (e: any) {
        alert('启动浏览器失败: ' + (e?.message || e));
        return;
      }
    }

    // ⏱️ 分开捕获：以前 token 请求和保存共用一个 try，token 请求超时会被误报成"Token 获取成功但保存失败"
    let tokens: any = null;
    try {
      const tResp = await fetchWithTimeout(`${baseUrl}/facebook/tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET
        },
        body: JSON.stringify({ profileId: pid, targetUrl: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns', strictEAAB: true })
      }, 120000, '提取 Token');
      const tJson = await tResp.json();
      if (!tJson || !tJson.success) {
        alert('获取 Token 失败: ' + (tJson?.message || t('status.unknownError')));
        return;
      }
      tokens = tJson.tokens || {};
    } catch (e: any) {
      alert('获取 Token 失败: ' + (e?.message || e) + '\n（服务端可能未登录或浏览器已被关闭，详见服务日志 [Tokens] 开头几行）');
      return;
    }

    // 🚀 核心修复：先更新本地 profiles state（确保后续 refreshAdAccountsFromServer 能读到新 token）
    const access = Array.isArray(tokens.access_tokens) ? tokens.access_tokens : [];
    const firstToken = (access.find((v:any) => /^EAAG/i.test(String(v))) || access.find((v:any) => /^EAA/i.test(String(v))) || access.find((v:any) => typeof v === 'string' && v.length > 0) || '');
    if (firstToken && setProfiles) {
      setProfiles(prev => prev.map(p => p.id === pid ? { ...p, token: firstToken } : p));
    } else if (!firstToken) {
      alert('未取到任何 access_token（服务端返回 0 个），请确认该配置浏览器已登录 Facebook。');
      return;
    }
    try {
      await fetch(`${baseUrl}/api/facebook/save-tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET
        },
        body: JSON.stringify({ profileId: pid, tokens })
      });
      alert('Token 获取并保存成功！');
      // 🚀 此时 profiles state 已包含新 token，refreshAdAccountsFromServer 能正确读取
      refreshAdAccountsFromServer(); // Refresh the list from server
    } catch {
      alert('Token 获取成功但保存失败');
      // 即使保存到服务器失败，本地 state 已有新 token，刷新列表也能显示
      refreshAdAccountsFromServer();
    }
  };

  // 🔐 检查登录状态：以前这里只发请求、**把返回结果直接丢掉**（`.then(r=>r.json())` 后面什么都不做），
  //    所以点完界面上毫无反馈；而且 check-login 要求该配置有活跃浏览器，获取信息跑完浏览器已归还，
  //    此时必然得到 `no_browser`。现在：没启动就先借用浏览器 → 检测 → 写进列表并落库 → 弹结果 → 归还。
  const rowCheckLoginStatus = async (pid: string) => {
    const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
    if (!pid || !launchUrl) return;
    const lbase = launchUrl.replace(/\/$/, '');
    const p = profiles.find(x => String(x.id) === String(pid));
    const startedByUs = p?.status !== BrowserStatus.RUNNING;
    try {
      if (startedByUs) {
        await postLocal(`${lbase}/api/launch-browser`, { profileId: pid, startUrls: ['https://www.facebook.com/'], borrow: true }, 150000, '启动浏览器');
      }
      const res = await postLocal(`${lbase}/api/facebook/check-login`, { profileId: pid }, 60000, '检查登录状态').then(r => r.json());
      if (res?.reason === 'no_browser') {
        alert(`配置 ${pid}：浏览器实例未就绪，无法检测（请重试或手动启动）`);
        return;
      }
      const ls = res?.loggedIn ? 'ok' : 'invalid';
      if (setProfiles) setProfiles(prev => prev.map(x => String(x.id) === String(pid) ? { ...x, loginStatus: ls } : x));
      // 落库（换设备/刷新后仍可见）
      try {
        const authToken = token || localStorage.getItem('auth_token');
        const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
        fetchWithTimeout(`${sbase}/api/profiles/update-login-status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ items: [{ id: pid, loginStatus: ls }] })
        }, 30000, '回写登录状态').catch(() => {});
      } catch {}
      alert(`配置 ${pid} 登录状态：${ls === 'ok' ? '已登录' : '登录失效（需人工登录）'}`);
    } catch (e: any) {
      alert(`检查登录状态失败：${e?.message || e}`);
    } finally {
      // 只归还「本次为检测而借」的浏览器，原本就在跑的不动
      if (startedByUs) {
        await fetchWithTimeout(`${lbase}/api/stop-browser`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
          body: JSON.stringify({ profileId: pid })
        }, 8000, '归还浏览器').catch(() => {});
      }
    }
  };

  const rowEditProfile = (pid: string) => {
    if (!pid) return;
    try { (window as any).setActiveTab && (window as any).setActiveTab('meta-profiles'); } catch {}
    try { window.dispatchEvent(new CustomEvent('open-profile-edit', { detail: { profileId: pid } })); } catch {}
  };


  // 🔀 切换列表（主页 / 广告号 / BM / 广告）时重置「属于某一行」的临时状态。
  //    ⚠️ 这四个列表是同一个组件实例（App.tsx 里都是 <AssetViewer assetType=.../>），
  //       React 只换 props 不换实例 → useState 全部沿用上一个列表的值。
  //       旧代码只清了勾选/排序，详情弹窗、TOKEN、限额等仍留着上一个列表的资产，
  //       表现就是「切到主页却还显示广告号的信息」。
  useEffect(() => {
    setSelectedIds(new Set());
    setIsDetailsOpen(false);
    setSelectedItem(null);
    setTokens(null);
    setTokenError('');
    setManualAccessToken('');
    setAssetsResult(null);
    setAssetsError('');
    setLimitsError('');
    setInlineNotesEdit(null);
    setSelectedPostId('');
    setPagePosts([]);
    setPostInsights([]);
    setPostInsightsError('');
    setPageInsights([]);
    setInsightsError('');
    // 📄 分页 / 排序偏好：每个列表各自存一份，切换时必须**读回自己的那份**。
    //    ⚠️ 原来的写法是 currentPage 直接写死 1、pageSize 沿用上一个列表的值，
    //       而下面两个持久化 effect 又会以「新 assetType + 旧值」立刻回写 →
    //       等于每次切列表都用上一个列表的每页条数覆盖本列表的缓存（本地缓存被串写）。
    let defaultSortKey = 'profileName';
    let defaultDirection: 'asc' | 'desc' = 'asc';
    if (assetType === 'pages') defaultSortKey = 'pageName';
    if (assetType === 'bms') defaultSortKey = 'bmId';
    if (assetType === 'adAccounts') {
      defaultSortKey = 'seq';
      defaultDirection = 'desc';
    }
    let savedSort: any = null;
    try { savedSort = JSON.parse(localStorage.getItem(`assetViewer_sort_${assetType}`) || 'null'); } catch { savedSort = null; }
    setSortConfig(savedSort && typeof savedSort.key === 'string' ? savedSort : { key: defaultSortKey, direction: defaultDirection });
    try {
      const ps = parseInt(localStorage.getItem(`assetViewer_pageSize_${assetType}`) || '', 10);
      setPageSize(Number.isFinite(ps) && ps > 0 ? ps : 30);
      const cp = parseInt(localStorage.getItem(`assetViewer_page_${assetType}`) || '1', 10);
      setCurrentPage(Number.isFinite(cp) && cp > 0 ? cp : 1);
    } catch { setPageSize(30); setCurrentPage(1); }
  }, [assetType]);

  // 🚀 持久化排序偏好
  useEffect(() => {
    try { localStorage.setItem(`assetViewer_sort_${assetType}`, JSON.stringify(sortConfig)); } catch {}
  }, [sortConfig, assetType]);

  useEffect(() => {
    if (assetType === 'adAccounts') {
      refreshAdAccounts(); // Load from cache first
      refreshAdAccountsFromServer(); // Then load from server
    } else if (assetType === 'pages') {
      refreshPages(); // Load from cache first
      refreshPagesFromServer(); // Then load from server
    } else if (assetType === 'ads') {
      refreshAds(); // Load from cache first
      refreshAdsFromServer(); // Then load from server
    } else if (assetType === 'bms') {
      refreshBusinesses(); // Load from cache first
      refreshBusinessesFromServer(); // Then load from server
      // 🐛 BM 列表的「广告号数量 / 广告号ID / BM状态」是按 adAccountsDb 里的 businessId 匹配出来的，
      //    所以这里必须把广告号也拉全。以前只调了 refreshAdAccounts()（只读本地缓存），
      //    而 readAdsCache() 要求缓存带 meta 标记、否则返回 null → refreshAdAccounts 直接 return、不更新 state；
      //    「获取信息」按配置局部覆盖后会 clearAdsCacheMeta()，于是刷新页面后 adAccountsDb 恒为空
      //    → BM 列表那几列全空（必须先去广告号标签页拉一次服务端才恢复）。
      refreshAdAccounts(); // 本地缓存先出
      refreshAdAccountsFromServer(); // 再从服务端补全（关键）
    }
    
    const handler = () => {
      // 🐛 忽略本组件自己发出的 businesses-refresh：否则 refreshBusinessesFromServer 里的
      //    dispatch → 这个 handler → 又 refreshBusinessesFromServer → 死循环（BM 列表闪烁）。
      if (_selfBusinessesRefresh) return;
      if (assetType === 'adAccounts') { refreshAdAccounts(); refreshAdAccountsFromServer(); }
      else if (assetType === 'pages') { refreshPages(); refreshPagesFromServer(); }
      else if (assetType === 'ads') { refreshAds(); refreshAdsFromServer(); }
      else if (assetType === 'bms') { refreshBusinesses(); refreshBusinessesFromServer(); refreshAdAccounts(); refreshAdAccountsFromServer(); }
    };
    window.addEventListener('adaccounts-refresh', handler);
    window.addEventListener('pages-refresh', handler);
    window.addEventListener('businesses-refresh', handler);
    
    // 🚀 新增：监听 pages-filter 自定义事件以实时捕获过滤条件
    const pagesFilterListener = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail) setPagesFilterState(detail);
    };
    window.addEventListener('pages-filter', pagesFilterListener as any);
    
    return () => {
      window.removeEventListener('adaccounts-refresh', handler);
      window.removeEventListener('pages-refresh', handler);
      window.removeEventListener('businesses-refresh', handler);
      window.removeEventListener('pages-filter', pagesFilterListener as any);
    };
  }, [assetType, profiles, token]);

  // 🚀 切换标签页时清除搜索筛选，避免残留（仅非 prefilled 的 tab 切换清除）
  useEffect(() => {
    // 当离开 adAccounts 或 bms 时清除搜索
    // 但如果是通过预填跳转的（有 localStorage 标记），预填 effect 会重新设置
    setSearchTerm('');
    setGroupFilter('');
    setTagFilter('');
  }, [assetType]);

  useEffect(() => {
    if (assetType !== 'adAccounts') return;
    try {
      const v = localStorage.getItem('adAccounts:searchPrefill');
      if (v) {
        setSearchTerm(v);
        localStorage.removeItem('adAccounts:searchPrefill');
      }
    } catch {}
  }, [assetType]);

  // 🚀 核心修复：profiles 加载完成后重新刷新广告号列表（确保 token 正确填充）
  useEffect(() => {
    if (assetType !== 'adAccounts') return;
    if (profiles.length === 0) return;
    refreshAdAccountsFromServer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, assetType]);

  // 🚀 BM 搜索预填：从广告号列表跳转 BM 时自动筛选
  useEffect(() => {
    if (assetType !== 'bms') return;
    try {
      const v = localStorage.getItem('bmSearchPrefill');
      if (v) {
        setSearchTerm(v);
        localStorage.removeItem('bmSearchPrefill');
      }
    } catch {}
  }, [assetType]);

  // 🚀 核心修复：手动挂载 pages 时从 localStorage 读取过滤条件
  useEffect(() => {
    if (assetType !== 'pages') return;
    try {
      const raw = localStorage.getItem('pagesFilter');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.profileId) setPagesFilterState(parsed);
      }
    } catch {}
  }, [assetType]);

  const refreshBusinesses = async () => {
    try {
      const raw = localStorage.getItem('cache:businesses');
      const list = raw ? JSON.parse(raw) : [];
      // 🧹 先归一化去重（历史缓存里同一个 BM 可能存在两种命名的行），再映射成界面行
      const mapped: BmAsset[] = normBmRows(list).map((b: any) => ({
        profileId: String(b.profileId || b.profile_id || ''),
        profileName: String(b.profileName || b.profile_name || ''),
        bmId: String(b.businessId || b.business_id || b.id || ''),
        bmName: String(b.name || b.bmName || ''),
        verificationStatus: (String(b.verification_status || '').toLowerCase() || 'unknown') as 'verified' | 'not_verified' | 'unknown',
        paymentStatus: ((() => {
          const s = String(b.paymentStatus || '').toLowerCase();
          return (s === 'active' ? 'Active' : (s === 'failed' ? 'Failed' : undefined)) as 'Active' | 'Failed' | undefined;
        })()),
        country: b.country ? String(b.country) : undefined,
        currency: b.currency ? String(b.currency) : undefined,
        adminEmail: b.admin_email ? String(b.admin_email) : undefined,
        owner_email: b.owner_email || '',
        updated_at: b.updated_at || '',
        // 📧 BM 邀请链接（本地缓存行兼容驼峰/蛇形两种命名）
        inviteEmail: b.inviteEmail || b.invite_email || '',
        inviteLink: b.inviteLink || b.invite_link || '',
        invitedAt: b.invitedAt || b.invited_at || '',
        // 🩺 账号质量原样带上（本地缓存独有的字段）
        ...aqFieldsOf(b),
        // 👥 BM 成员
        bmUsers: Array.isArray(b.bmUsers) ? b.bmUsers : [],
        // 🕒 BM 创建时间
        fbCreatedTime: fbCreatedOf(b),
        // 🔢 可创建广告号上限（本地缓存行）
        adAccountLimit: adLimitOf(b)
      })).filter((x: any) => x.bmId && x.bmId.length > 0);
      setBusinessesDb(mapped);
    } catch {}
  };

  const refreshBusinessesFromServer = async () => {
    try {
      let sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const authToken = token || localStorage.getItem('auth_token');
      
      // 🚀 不传入 profileIds，让后端按 user_id 返回全部 BM
      const resp = await fetch(`${sbase}/api/businesses`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const json = await resp.json();
      const list = (json && json.success && Array.isArray(json.data)) ? json.data : [];
      const mapped: BmAsset[] = normBmRows(list).map((b: any) => ({
        profileId: String(b.profileId || b.profile_id || ''),
        profileName: String(b.profileName || b.profile_name || ''),
        bmId: String(b.businessId || b.business_id || b.id || ''),
        bmName: String(b.name || b.bmName || ''),
        verificationStatus: (String(b.verification_status || '').toLowerCase() || 'unknown') as 'verified' | 'not_verified' | 'unknown',
        paymentStatus: undefined,
        country: undefined,
        currency: undefined,
        adminEmail: b.admin_email ? String(b.admin_email) : undefined,
        // 📧 BM 邀请链接（云端 businesses 表的 invite_* 列）
        inviteEmail: b.invite_email || '',
        inviteLink: b.invite_link || '',
        invitedAt: b.invited_at || '',
        updated_at: b.updated_at || '',
        // 🩺 账号质量（云端 aq_* 列；normBmRows 已把蛇形/驼峰都归一成 aqStatus 三件套）
        ...aqOfCloudRow(b),
        // 👥 BM 成员（normBmRows 已把 bm_users JSON 解析成数组）
        bmUsers: Array.isArray(b.bmUsers) ? b.bmUsers : [],
        // 🕒 BM 创建时间
        fbCreatedTime: fbCreatedOf(b),
        // 🔢 可创建广告号上限（云端 ad_account_limit 列）
        adAccountLimit: adLimitOf(b)
      })).filter(x => x.bmId && x.bmId.length > 0);
      if (mapped.length > 0) {
        setBusinessesDb(mapped);
        // ⚠️ 写归一化后的行，不能把云端原始行（蛇形 profile_id / business_id）直接塞进缓存：
        //    别的写入方按 profileId 做「同配置整体替换」，蛇形行匹配不上 → 同一 BM 存两份，
        //    列表先显示 2 行、刷新后才回到 1 行。
        // 🩺 账号质量已落库（aq_* 列）；老行还没有的再从旧缓存捞回来
        try { localStorage.setItem('cache:businesses', JSON.stringify(normBmRows(keepAqFromCache(mapped)))); } catch {}
        _selfBusinessesRefresh = true;
        try { window.dispatchEvent(new Event('businesses-refresh')); } catch {} finally { _selfBusinessesRefresh = false; }
      }

      if (!mapped.length && profiles.length > 0) {
        const tokensByProfile: Array<{pid:string;tok:string}> = profiles.map(p=>({ pid: String(p.id||'') , tok: typeof p.token==='string'?p.token:'' })).filter(x=>x.pid && x.tok);
        if (tokensByProfile.length) {
          const proxyGet = async (_url: string) => {
            return {} as any;
          };
          const base = 'https://graph.facebook.com/v20.0';
          const items: any[] = [];
          for (const { pid, tok } of tokensByProfile.slice(0, 20)) {
            const qs = (u: string) => `${u}${u.includes('?')?'&':'?'}access_token=${encodeURIComponent(tok)}`;
            try {
              const data = await proxyGet(qs(`${base}/me/businesses?fields=id,name,verification_status&limit=50`));
              const arr = Array.isArray((data as any)?.data) ? (data as any).data : Array.isArray(data) ? data : [];
              arr.forEach((b:any)=>{ items.push({ profileId: pid, businessId: String(b.id||''), name: String(b.name||''), verification_status: String(b.verification_status||'') }); });
            } catch {}
          }
          if (items.length) {
            try { 
              const authToken = token || localStorage.getItem('auth_token');
              await fetch(`${sbase}/api/businesses/bulk-save`, { 
                method: 'POST', 
                headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${authToken}`
                }, 
                body: JSON.stringify({ items }) 
              }); 
            } catch {}
            const mappedLocal: BmAsset[] = items.map((b: any) => ({
              profileId: String(b.profileId || b.profile_id || ''),
              profileName: '',
              bmId: String(b.businessId || b.business_id || b.id || ''),
              bmName: String(b.name || b.bmName || ''),
              verificationStatus: (String(b.verification_status || '').toLowerCase() === 'verified' ? 'verified' : 'not_verified') as 'verified' | 'not_verified' | 'unknown'
            })).filter(x => x.bmId && x.bmId.length > 0);
            setBusinessesDb(mappedLocal);
            // 🩺 同上：用旧缓存里的「账号质量」补回来
            try { localStorage.setItem('cache:businesses', JSON.stringify(normBmRows(keepAqFromCache(items)))); } catch {}
            _selfBusinessesRefresh = true;
            try { window.dispatchEvent(new Event('businesses-refresh')); } catch {} finally { _selfBusinessesRefresh = false; }
          }
        }
      }
    } catch {}
  };

  const refreshPages = async () => {
    try {
      const raw = localStorage.getItem('cache:pages');
      let arr = raw ? JSON.parse(raw) : [];
      // 🚀 V5.6.9: 过滤缓存数据，只保留当前 profiles 对应的数据，避免闪一下
      // 🚀 V5.7.0: superadmin 跳过过滤
      const profileIdSet = new Set(profiles.map(p => p.id).filter(Boolean));
      if (!isSuperadmin && profileIdSet.size > 0 && Array.isArray(arr)) {
        arr = arr.filter((item: any) => profileIdSet.has(String(item.profileId || '')));
      }
      if (Array.isArray(arr)) setPagesDb(arr);
      // 🛡️ 顺带把「账号权限」缓存同步进内存：配置列表（ProfileManager）跑完「获取信息」也会写这份缓存，
      //    这里重读一次就能立刻显示，不需要刷新页面 —— 纯读缓存，不发任何请求。
      setPageRights(readPageRightsCache());
    } catch {}
  };

  // 🛡️「账号权限」列不做自动探测了：数据只在「获取信息」/「获取主页」时由
  //    applyPageRightsFromPages 写入（这两个动作本来就会调 me/accounts 拿 tasks），
  //    并缓存在 localStorage，刷新页面也能直接显示。

  const { title, subtitle, icon: Icon, data, columns, uniqueIdKey } = useMemo(() => {
    switch (assetType) {
      case 'pages':
        const pageData: PageAsset[] = (pagesDb && pagesDb.length)
          ? pagesDb.filter((pg: any) => !isDirtyAssetRow(pg)).map((pg: any) => {
              const pid = String(pg.profileId || '');
              const foundProf = profiles.find(p => String(p.id) === pid);
              return {
                profileId: pid,
                profileName: String(pg.profileName || ''),
                pageId: String(pg.pageId || ''),
                pageName: String(pg.pageName || pg.name || ''),
                likes: Number(pg.fan_count || pg.likes || 0),
                status: pg.status || (pg.is_published === 0 ? 'Unpublished' : 'Published'),
                owner_email: pg.owner_email || '',
                // 🛡️ 该配置的账号在这主页上的角色（admin/member/none/unknown）
                //    优先用行上带回来的 tasks（me/accounts，角色维度）；没有再查「获取信息」/「获取主页」落下的结果。
                adminRight: (() => {
                  const tasks: string[] = Array.isArray((pg as any).tasks) ? (pg as any).tasks : [];
                  if (tasks.length) return canManageFromTasks(tasks) ? 'admin' : 'member';
                  const r = pageRights[pid];
                  if (!r) return 'unknown';
                  const v = r.pages[String(pg.pageId || '')];
                  return v === true ? 'admin' : v === false ? 'member' : 'none';
                })(),
                updated_at: pg.updated_at || '',
                tokenValue: foundProf?.token || '',
                notes: pg.notes || '',
                group: foundProf?.group || '',
                tags: foundProf?.tags || []
              };
            })
          : profiles
              .filter(p => p.assets?.pagesCount && p.assets.pagesCount > 0)
              .flatMap(p => 
                Array.from({ length: p.assets!.pagesCount! }, (_, i) => ({
                  profileId: p.id,
                  profileName: p.name,
                  pageId: `page-${String(p.id || '').slice(-3)}-${i + 1}`,
                  pageName: `${p.name} - Page ${i + 1}`,
                  likes: 0,
                  status: 'Published',
                  owner_email: p.owner_email || '',
                  tokenValue: p.token || '',
                  notes: p.notes || '',
                  group: p.group || '',
                  tags: p.tags || []
                }))
              );
        return {
          title: t('assetViewer.titlePages'),
          subtitle: t('assetViewer.subtitlePages'),
          icon: FileText,
          data: pageData,
          uniqueIdKey: 'pageId',
          columns: [
            { header: '归属邮箱', accessor: 'owner_email' },
            { header: '账号ID', accessor: 'profileId', responsive: 'md' },
            { header: '操作员', accessor: 'profileName', responsive: 'md' },
            { header: t('assetViewer.table.pageName'), accessor: 'pageName' },
            { header: t('assetViewer.table.pageId'), accessor: 'pageId', responsive: 'lg' },
            { header: t('assetViewer.table.pageLikes'), accessor: 'likes', responsive: 'md' },
            { header: t('assetViewer.table.pageStatus'), accessor: 'status' },
            { header: '账号权限', accessor: 'adminRight' },
            { header: '备注', accessor: 'notes' },
            { header: '分组', accessor: 'group', responsive: 'md' },
            { header: '标签', accessor: 'tags', responsive: 'md' },
            { header: 'Token', accessor: 'tokenValue', responsive: 'md' },
            { header: '时间', accessor: 'updated_at' },
            { header: '贴文', accessor: 'socialPosts', responsive: 'md' },
            { header: '对话', accessor: 'socialMessages', responsive: 'md' },
            { header: 'AI值守', accessor: 'aiWatch', responsive: 'md' }
          ]
        };
      case 'ads':
        // 🚀 核心改进：构建层级结构 (Campaign -> AdSet -> Ad)
        const treeData: any[] = [];
        const campaignsMap = new Map();
        
        adsDb.forEach((ad: any) => {
            const cId = ad.campaign_id || `c_unknown_${ad.campaignName}`;
            if (!campaignsMap.has(cId)) {
                campaignsMap.set(cId, {
                    id: cId,
                    name: ad.campaignName || 'Unknown Campaign',
                    type: 'campaign',
                    children: new Map(),
                    profileName: ad.profileName,
                    accountId: ad.accountId,
                    status: 'ACTIVE' // Simplified
                });
            }
            const campaign = campaignsMap.get(cId);
            
            const sId = ad.adset_id || `s_unknown_${ad.adsetName}`;
            if (!campaign.children.has(sId)) {
                campaign.children.set(sId, {
                    id: sId,
                    name: ad.adsetName || 'Unknown AdSet',
                    type: 'adset',
                    children: [],
                    targeting: ad.targeting,
                    status: 'ACTIVE' // Simplified
                });
            }
            const adset = campaign.children.get(sId);
            adset.children.push({
                ...ad,
                type: 'ad'
            });
        });
        
        // 展平树结构以便表格显示，同时保持父子关系标识
        const flattenedAds: any[] = [];
        campaignsMap.forEach(campaign => {
            flattenedAds.push({ ...campaign, depth: 0, uniqueKey: `campaign_${campaign.id}` });
            if (expandedIds.has(campaign.id) || expandedIds.has(`campaign_${campaign.id}`)) {
                campaign.children.forEach((adset: any) => {
                    flattenedAds.push({ ...adset, depth: 1, uniqueKey: `adset_${adset.id}`, profileName: campaign.profileName, accountId: campaign.accountId });
                    if (expandedIds.has(adset.id) || expandedIds.has(`adset_${adset.id}`)) {
                        adset.children.forEach((ad: any) => {
                            flattenedAds.push({ 
                                ...ad, 
                                depth: 2, 
                                uniqueKey: `ad_${ad.adId}`, 
                                adName: ad.adName,
                                creativeJson: ad.creativeJson,
                                profileName: campaign.profileName,
                                accountId: campaign.accountId
                            });
                        });
                    }
                });
            }
        });

        return {
          title: '广告资产',
          subtitle: '查看该账号下的所有广告列表',
          icon: BarChartHorizontal,
          data: flattenedAds,
          uniqueIdKey: 'uniqueKey',
          columns: [
            { header: '层级结构', accessor: 'hierarchy' },
            { header: '状态', accessor: 'status' },
            { header: '配置名称', accessor: 'profileName' },
            { header: '广告账户', accessor: 'accountId' },
            { header: '详细信息', accessor: 'details' },
            { header: '时间', accessor: 'updated_at' }
          ]
        };

      case 'bms':
        // 🔎 诊断日志：定位「广告号数量 / 广告号ID / BM状态」为空到底是哪一侧没数据。
        //    adAccountsDb=0  → 广告号根本没加载（服务端/缓存问题）
        //    withBiz=0       → 广告号加载了，但都没带 BM 归属（business_id 没同步到）
        //    两者都有值但某行 匹配0 → 归属的 id 与 BM 的 bmId 对不上
        try {
          const withBiz = adAccountsDb.filter((a: any) => String(a.businessId || a.business_id || '')).length;
          const sampleAcc = adAccountsDb.slice(0, 3).map((a: any) => `${a.profileId}:${a.businessId || a.business_id || '-'}`);
          const sampleBm = (businessesDb || []).slice(0, 3).map((b: any) => `${b.profileId}:${b.bmId}`);
          console.log(`[BM诊断] adAccountsDb=${adAccountsDb.length} 带BM归属=${withBiz} | 广告号样例=[${sampleAcc.join(', ')}] | BM样例=[${sampleBm.join(', ')}]`);
        } catch { }
        // 🎯 只统计**真正属于这个 BM** 的广告号。
        //    以前是按「该配置下的所有广告号」统计 → 同一配置的每个 BM 显示的数量都一样，而且偏大。
        //    精确匹配靠广告号缓存里的 businessId（「获取信息」时从 Graph 的 business{id,name} 落盘）。
        const adAccountsOfBm = (profileId: any, bmId: any) =>
          adAccountsDb.filter(a =>
            String(a.profileId) === String(profileId) &&
            String((a as any).businessId || (a as any).business_id || '') === String(bmId)
          );
        const bmData: BmAsset[] = (businessesDb && businessesDb.length)
          ? businessesDb.filter(b => b.bmId && b.bmId.length > 0 && !isDirtyAssetRow(b))
              .map(b => {
                const foundProf = profiles.find(p => String(p.id) === b.profileId);
                const bmAdAccounts = adAccountsOfBm(b.profileId, b.bmId);
                const adAccountCount = bmAdAccounts.length;
                const adAccountIds = bmAdAccounts.slice(0, 5).map(a => a.adAccountId).join(', ') + (bmAdAccounts.length > 5 ? '...' : '');
                const st = bmStatusOf(bmAdAccounts as any[]);
                return { ...b, tokenValue: foundProf?.token || '', notes: b.notes || '', group: foundProf?.group || '', tags: foundProf?.tags || [], adAccountCount, adAccountIds, bmStatus: st.kind, bmStatusDetail: st.detail, bmDisableReason: st.reasonLabel };
              })
          : profiles
              .filter(p => p.assets?.bmId)
              .map(p => {
                const bmAdAccounts = adAccountsOfBm(p.id, p.assets!.bmId);
                const adAccountCount = bmAdAccounts.length;
                const adAccountIds = bmAdAccounts.slice(0, 5).map(a => a.adAccountId).join(', ') + (bmAdAccounts.length > 5 ? '...' : '');
                const st = bmStatusOf(bmAdAccounts as any[]);
                return {
                profileId: p.id,
                profileName: p.name,
                bmId: p.assets!.bmId!,
                verificationStatus: (p.assets!.verificationStatus as 'verified' | 'not_verified' | 'unknown' | undefined),
                paymentStatus: p.assets!.paymentStatus,
                country: p.assets!.country,
                currency: p.assets!.currency,
                owner_email: p.owner_email || '',
                tokenValue: p.token || '',
                notes: p.notes || '',
                group: p.group || '',
                tags: p.tags || [],
                adAccountCount,
                adAccountIds,
                bmStatus: st.kind,
                bmStatusDetail: st.detail,
                bmDisableReason: st.reasonLabel
              }});
        return {
          title: t('assetViewer.titleBMs'),
          subtitle: t('assetViewer.subtitleBMs'),
          icon: Briefcase,
          data: bmData,
          uniqueIdKey: 'bmId',
          columns: [
            { header: '归属邮箱', accessor: 'owner_email', responsive: 'md' },
            { header: 'BM名称', accessor: 'bmName' },
            { header: '配置ID', accessor: 'profileId' },
            { header: t('assetViewer.table.bmId'), accessor: 'bmId', responsive: 'lg' },
            { header: '广告号数量', accessor: 'adAccountCount' },
            { header: 'BM状态', accessor: 'bmStatus' },
            { header: '停用原因', accessor: 'bmDisableReason', responsive: 'md' },
            { header: '邀请链接', accessor: 'inviteLink' },
            { header: '广告号ID', accessor: 'adAccountIds', responsive: 'md' },
            { header: '时间', accessor: 'updated_at' },
            { header: '创建时间', accessor: 'fbCreatedTime', responsive: 'md' },
            { header: '可创建广告号上限', accessor: 'adAccountLimit', responsive: 'md' },
            { header: '企业认证', accessor: 'verificationStatus' },
            { header: '管理员(权限)', accessor: 'bmUsers', responsive: 'md' },
            { header: t('assetViewer.table.payment'), accessor: 'payment', responsive: 'md' },
            { header: 'Token', accessor: 'tokenValue', responsive: 'md' },
            { header: '分组', accessor: 'group', responsive: 'md' },
            { header: '标签', accessor: 'tags', responsive: 'md' },
            { header: '备注', accessor: 'notes' },
            { header: '贴文', accessor: 'socialPosts', responsive: 'md' },
            { header: '对话', accessor: 'socialMessages', responsive: 'md' },
          ]
        };
        
      case 'adAccounts':
        const adAccountData: AdAccountAsset[] = (adAccountsDb || []).filter((a: any) => !isDirtyAssetRow(a));
        return {
          title: t('assetViewer.titleAdAccounts'),
          subtitle: t('assetViewer.subtitleAdAccounts'),
          icon: BarChartHorizontal,
          data: adAccountData,
          uniqueIdKey: 'adAccountId',
          columns: [
            { header: t('assetViewer.table.adAccountActions') || '操作', accessor: 'actions' },
            { header: '备注', accessor: 'notes' },
            { header: 'Token', accessor: 'tokenValue', responsive: 'md' },
            { header: '分组', accessor: 'group', responsive: 'md' },
            { header: '标签', accessor: 'tags', responsive: 'md' },
            { header: '归属邮箱', accessor: 'owner_email' },
            { header: t('assetViewer.table.profileName'), accessor: 'account' },
            { header: t('assetViewer.table.adAccountAccount') || '浏览器配置ID', accessor: 'profileId', responsive: 'md' },
            { header: '登录状态', accessor: 'loginStatus', responsive: 'md' },
            { header: t('assetViewer.table.adAccountName') || '广告账户名称', accessor: 'adAccountName' },
            { header: t('assetViewer.table.adAccountId'), accessor: 'adAccountId' },
            { header: t('assetViewer.table.adAccountStatus'), accessor: 'adAccountStatus' },
            { header: t('assetViewer.table.adAccountSpend'), accessor: 'spend', responsive: 'md' },
            { header: t('assetViewer.table.adAccountLimit') || '额度(USD)', accessor: 'spendCap', responsive: 'md' },
            { header: t('assetViewer.table.adAccountAdsCount') || '广告数量', accessor: 'adsCount' },
            { header: t('assetViewer.table.adAccountBalance') || '账单', accessor: 'balance', responsive: 'md' },
            { header: t('assetViewer.table.adAccountThreshold') || '门槛', accessor: 'threshold', responsive: 'md' },
            { header: '像素', accessor: 'pixelsCount', responsive: 'md' },
            { header: t('assetViewer.table.adAccountPagesCount') || 'Page', accessor: 'pagesCount', responsive: 'md' },
            { header: t('assetViewer.table.adAccountBmCount') || '关联BM数量', accessor: 'bmCount', responsive: 'md' },
            { header: t('assetViewer.table.adAccountPaymentCount') || '卡片', accessor: 'paymentCount', responsive: 'md' },
            { header: t('assetViewer.table.adAccountCountry') || '国家', accessor: 'country', responsive: 'lg' },
            { header: t('assetViewer.table.adAccountCurrency') || '货币', accessor: 'currency', responsive: 'md' },
            { header: t('assetViewer.table.adAccountTimezone') || '时区', accessor: 'timezone_id', responsive: 'lg' },
            { header: '时间', accessor: 'updated_at' },
            { header: '支付卡号', accessor: 'fundingSource', responsive: 'md' },
            { header: '贴文', accessor: 'socialPosts', responsive: 'md' },
            { header: '对话', accessor: 'socialMessages', responsive: 'md' }
          ]
        };
      default:
        return { title: '', subtitle: '', icon: HelpCircle, data: [], columns: [], uniqueIdKey: 'id' };
    }
  }, [assetType, profiles, t, adAccountsDb, businessesDb, pagesDb, adsDb, expandedIds, pageRights]);
  
  // 🚀 序号固定：以 localStorage 为唯一来源，只给"从未分配过序号"的数据补新号，
  //    已分配过的 id 永远保持原序号，不再因为刷新/重新进列表/数据重排而重新分配。
  //    ⚡️ 服务端持久化的 seq（ad_accounts.seq 列）是权威值：换电脑/换浏览器读到的就是它，
  //       拿到后直接采纳进本地表；本地新分配的号再回写服务端（/api/adaccounts/fill-seq）。
  useEffect(() => {
    const key = `assetSeq:${assetType}`;
    let next: Record<string, number> = {};
    try {
      const raw = localStorage.getItem(key);
      if (raw) next = JSON.parse(raw) || {};
    } catch { next = {}; }
    let maxSeq: number = Object.values(next).reduce((m: number, v: any) => (typeof v === 'number' && v > m ? v : m), 0);
    // ① 采纳服务端已落库的固定序号
    data.forEach((item: any) => {
      const id = item[uniqueIdKey];
      const s = Number(item.seq);
      if (id != null && Number.isFinite(s) && s > 0) {
        next[id] = s;
        if (s > maxSeq) maxSeq = s;
      }
    });
    // ② 数据按 updated_at DESC 返回（最新在前），反转后分配 seq，
    //    使新出现的数据获得最大的 seq（仅影响首次分配）
    const toPersist: Array<{ accountId: string; seq: number }> = [];
    [...data].reverse().forEach((item: any) => {
      const id = item[uniqueIdKey] as string;
      const serverSeq = Number(item.seq);
      if (id != null && next[id] == null) {
        maxSeq = maxSeq + 1;
        next[id] = maxSeq;
      }
      // 只回写"服务端还没有号"的，避免每次刷新都写库
      if (id != null && next[id] != null && !(Number.isFinite(serverSeq) && serverSeq > 0)) {
        toPersist.push({ accountId: String(id), seq: next[id] });
      }
    });
    setAssetSeqMap(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
    // ③ 回写服务端：序号落到数据库后，换电脑/换浏览器也是同一套序号
    if (assetType === 'adAccounts' && toPersist.length) {
      const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
      const authToken = token || localStorage.getItem('auth_token');
      fetch(`${sbase}/api/adaccounts/fill-seq`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ items: toPersist })
      }).catch(() => {});
    }
  }, [data, uniqueIdKey, assetType]);

  const fetchTokens = async (profileId: string) => {
    if (!profileId) return;
    setTokenLoading(true);
    setTokenError('');
    setTokens(null);
    try {
      const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
      const baseUrl = launchUrl.replace(/\/$/, '');
      const resp = await fetch(`${baseUrl}/api/facebook/tokens`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET
        },
        body: JSON.stringify({ profileId, targetUrl: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns', pollIntervalMs: 500, maxWaitMs: 15000 })
      });
      const data = await resp.json();
      if (!data.success) {
        setTokenError('获取失败');
      } else {
        setTokens(data.tokens || {});
      }
    } catch (e) {
      setTokenError('网络错误');
    } finally {
      setTokenLoading(false);
    }
  };

  const publishLinkToPage = async () => {
    if (!selectedPageId || !pageLinkUrl || !manualAccessToken) return;
    setPosting(true);
    setPostError('');
    setPostResult(null);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let pageToken = '';
      const pages = assetsResult?.pages || [];
      const found = Array.isArray(pages) ? pages.find((p: any) => p.id === selectedPageId) : null;
      if (found && found.access_token) pageToken = found.access_token;
      if (!pageToken) {
        const infoResp = await fetch(qs(`${base}/${selectedPageId}?fields=access_token`));
        const infoJson = await infoResp.json();
        pageToken = infoJson?.access_token || '';
      }
      if (!pageToken) {
        setPostError('缺少页面令牌');
      } else {
        const form = new URLSearchParams();
        form.set('link', pageLinkUrl);
        if (pagePostMessage) form.set('message', pagePostMessage);
        form.set('access_token', pageToken);
        const resp = await fetch(`${base}/${selectedPageId}/feed`, { method: 'POST', body: form });
        const json = await resp.json();
        if (json && json.id) {
          setPostResult(json);
          setPageLinkUrl('');
          setPagePostMessage('');
        } else {
          setPostError((json && json.error && json.error.message) ? json.error.message : '发布失败');
        }
      }
    } catch (e) {
      setPostError('网络错误');
    } finally {
      setPosting(false);
    }
  };

  const publishPhotoToPage = async () => {
    if (!selectedPageId || !pageImageUrl || !manualAccessToken) return;
    setPosting(true);
    setPostError('');
    setPostResult(null);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let pageToken = '';
      const pages = assetsResult?.pages || [];
      const found = Array.isArray(pages) ? pages.find((p: any) => p.id === selectedPageId) : null;
      if (found && found.access_token) pageToken = found.access_token;
      if (!pageToken) {
        const infoResp = await fetch(qs(`${base}/${selectedPageId}?fields=access_token`));
        const infoJson = await infoResp.json();
        pageToken = infoJson?.access_token || '';
      }
      if (!pageToken) {
        setPostError('缺少页面令牌');
      } else {
        const form = new URLSearchParams();
        form.set('url', pageImageUrl);
        if (pagePostMessage) form.set('caption', pagePostMessage);
        form.set('access_token', pageToken);
        const resp = await fetch(`${base}/${selectedPageId}/photos`, { method: 'POST', body: form });
        const json = await resp.json();
        if (json && (json.id || json.post_id)) {
          setPostResult(json);
          setPageImageUrl('');
          setPagePostMessage('');
        } else {
          setPostError((json && json.error && json.error.message) ? json.error.message : '发布失败');
        }
      }
    } catch (e) {
      setPostError('网络错误');
    } finally {
      setPosting(false);
    }
  };

  const schedulePostToPage = async () => {
    if (!selectedPageId || !pagePostMessage || !scheduleTime || !manualAccessToken) return;
    setPosting(true);
    setPostError('');
    setPostResult(null);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let pageToken = '';
      const pages = assetsResult?.pages || [];
      const found = Array.isArray(pages) ? pages.find((p: any) => p.id === selectedPageId) : null;
      if (found && found.access_token) pageToken = found.access_token;
      if (!pageToken) {
        const infoResp = await fetch(qs(`${base}/${selectedPageId}?fields=access_token`));
        const infoJson = await infoResp.json();
        pageToken = infoJson?.access_token || '';
      }
      if (!pageToken) {
        setPostError('缺少页面令牌');
      } else {
        const ts = Math.floor(new Date(scheduleTime).getTime() / 1000);
        const form = new URLSearchParams();
        form.set('message', pagePostMessage);
        form.set('published', 'false');
        form.set('scheduled_publish_time', String(ts));
        form.set('access_token', pageToken);
        const resp = await fetch(`${base}/${selectedPageId}/feed`, { method: 'POST', body: form });
        const json = await resp.json();
        if (json && json.id) {
          setPostResult(json);
          setPagePostMessage('');
        } else {
          setPostError((json && json.error && json.error.message) ? json.error.message : '发布失败');
        }
      }
    } catch (e) {
      setPostError('网络错误');
    } finally {
      setPosting(false);
    }
  };

  const loadPagePosts = async () => {
    if (!selectedPageId || !manualAccessToken) return;
    setPostsLoading(true);
    setPostsError('');
    setPagePosts([]);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let pageToken = '';
      const pages = assetsResult?.pages || [];
      const found = Array.isArray(pages) ? pages.find((p: any) => p.id === selectedPageId) : null;
      if (found && found.access_token) pageToken = found.access_token;
      if (!pageToken) {
        const infoResp = await fetch(qs(`${base}/${selectedPageId}?fields=access_token`));
        const infoJson = await infoResp.json();
        pageToken = infoJson?.access_token || '';
      }
      if (!pageToken) {
        setPostsError('缺少页面令牌');
      } else {
        const resp = await fetch(`${base}/${selectedPageId}/posts?fields=id,message,created_time,permalink_url&limit=20&access_token=${encodeURIComponent(pageToken)}`);
        const json = await resp.json();
        const list = Array.isArray(json.data) ? json.data : [];
        setPagePosts(list);
      }
    } catch (e) {
      setPostsError('拉取失败');
    } finally {
      setPostsLoading(false);
    }
  };

  const deletePost = async (postId: string) => {
    if (!selectedPageId || !postId || !manualAccessToken) return;
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let pageToken = '';
      const pages = assetsResult?.pages || [];
      const found = Array.isArray(pages) ? pages.find((p: any) => p.id === selectedPageId) : null;
      if (found && found.access_token) pageToken = found.access_token;
      if (!pageToken) {
        const infoResp = await fetch(qs(`${base}/${selectedPageId}?fields=access_token`));
        const infoJson = await infoResp.json();
        pageToken = infoJson?.access_token || '';
      }
      if (!pageToken) return;
      await fetch(`${base}/${postId}?access_token=${encodeURIComponent(pageToken)}`, { method: 'DELETE' });
      setPagePosts(prev => prev.filter(p => p.id !== postId));
    } catch {}
  };
  const fetchPageInsights = async () => {
    if (!selectedPageId || !manualAccessToken) return;
    setInsightsLoading(true);
    setInsightsError('');
    setPageInsights([]);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let pageToken = '';
      const pages = assetsResult?.pages || [];
      const found = Array.isArray(pages) ? pages.find((p: any) => p.id === selectedPageId) : null;
      if (found && found.access_token) pageToken = found.access_token;
      if (!pageToken) {
        const infoResp = await fetch(qs(`${base}/${selectedPageId}?fields=access_token`));
        const infoJson = await infoResp.json();
        pageToken = infoJson?.access_token || '';
      }
      const token = pageToken || manualAccessToken;
      if (!token) {
        setInsightsError('缺少页面令牌');
      } else {
        const metrics = [
          'page_impressions',
          'page_engaged_users',
          'page_fans',
          'page_actions_post_reactions_total'
        ].join(',');
        const url = `${base}/${selectedPageId}/insights?metric=${encodeURIComponent(metrics)}&date_preset=${encodeURIComponent(insightsDatePreset)}&period=day&access_token=${encodeURIComponent(token)}`;
        const resp = await fetch(url);
        const json = await resp.json();
        const list = Array.isArray(json?.data) ? json.data : [];
        setPageInsights(list);
      }
    } catch (e) {
      setInsightsError('拉取失败');
    } finally {
      setInsightsLoading(false);
    }
  };
  const fetchPostInsights = async () => {
    if (!selectedPostId || !manualAccessToken) return;
    setPostInsightsLoading(true);
    setPostInsightsError('');
    setPostInsights([]);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let pageToken = '';
      const pages = assetsResult?.pages || [];
      const found = Array.isArray(pages) ? pages.find((p: any) => p.id === selectedPageId) : null;
      if (found && found.access_token) pageToken = found.access_token;
      if (!pageToken) {
        const infoResp = await fetch(qs(`${base}/${selectedPageId}?fields=access_token`));
        const infoJson = await infoResp.json();
        pageToken = infoJson?.access_token || '';
      }
      const token = pageToken || manualAccessToken;
      if (!token) {
        setPostInsightsError('缺少页面令牌');
      } else {
        const metrics = [
          'post_impressions',
          'post_engaged_users',
          'post_reactions_by_type_total'
        ].join(',');
        const url = `${base}/${selectedPostId}/insights?metric=${encodeURIComponent(metrics)}&period=day&access_token=${encodeURIComponent(token)}`;
        const resp = await fetch(url);
        const json = await resp.json();
        const list = Array.isArray(json?.data) ? json.data : [];
        setPostInsights(list);
      }
    } catch (e) {
      setPostInsightsError('拉取失败');
    } finally {
      setPostInsightsLoading(false);
    }
  };
  const exportInsights = (items: any[], filename: string) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const rows: any[] = [];
    items.forEach((m: any) => {
      const name = m?.name || '';
      const title = m?.title || '';
      const period = m?.period || '';
      const vals = Array.isArray(m?.values) ? m.values : [];
      vals.forEach((v: any) => {
        rows.push({
          metric: name,
          title,
          period,
          end_time: v?.end_time || v?.date || '',
          value: typeof v?.value === 'number' ? v.value : JSON.stringify(v?.value)
        });
      });
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'insights');
    XLSX.writeFile(wb, filename);
  };
  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {}
  };

  const fetchAssetsWithToken = async (accessToken: string) => {
    if (!accessToken) return;
    setAssetsLoading(true);
    setAssetsError('');
    setAssetsResult(null);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      let sbase = ''; // 线上相对路径
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`;
      const proxyGet = async (url: string) => {
        try {
          const resp = await fetch(`${sbase}/api/graph`, { 
            method: 'POST', 
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
            }, 
            body: JSON.stringify({ url }) 
          });
          const json = await resp.json();
          if (!json || !json.success) throw new Error('proxy_failed');
          const data = json.data ?? {};
          if (data && data.error && data.error.message) throw new Error(data.error.message);
          return data;
        } catch {
          // ❌ 不直接浏览器端 fetch graph.facebook.com（会触发 CORS 错误），返回空数据
          return {};
        }
      };
      const fetchAll = async (initialUrl: string) => {
        let items: any[] = [];
        let url = initialUrl;
        for (let i = 0; i < 10; i++) {
          const data = await proxyGet(url);
          const part = Array.isArray((data as any).data) ? (data as any).data : [];
          items = items.concat(part);
          const next = (data as any)?.paging?.next;
          if (!next) break;
          url = next;
        }
        return items;
      };

      const user = await proxyGet(qs(`${base}/me?fields=id,name`));
      let pages = await fetchAll(qs(`${base}/me/accounts?fields=id,name,fan_count,link,category,access_token&limit=50`));
      const adAccounts = await fetchAll(qs(`${base}/me/adaccounts?fields=account_id,id,name,account_status,currency,timezone_id,amount_spent,spend_cap,balance,adtrust_dsl,funding_source_details,country_code&limit=50`));
      const businesses = await fetchAll(qs(`${base}/me/businesses?fields=id,name,verification_status&limit=50`));
      if (businesses.length) {
        for (const b of businesses.slice(0, 20)) {
          const ownedPages = await fetchAll(qs(`${base}/${b.id}/owned_pages?fields=id,name,fan_count,link,category,access_token&limit=50`));
          const map: Record<string, any> = {};
          pages.forEach((p: any) => { map[p.id] = p; });
          ownedPages.forEach((p: any) => { map[p.id] = p; });
          pages = Object.values(map);
        }
      }

      setAssetsResult({ user, pages, adAccounts, businesses });

      // Persist to backend
      if (selectedItem) {
        const pid = String(selectedItem.profileId || '');
        const prof = profiles.find(p => p.id === pid);
        const pname = prof?.name || pid;
        const mappedAds = adAccounts.map((a: any) => {
          const fsd = a.funding_source_details;
          const paymentInfo = fsd ? `${fsd.display_string ? fsd.display_string.slice(-4) : ''} (${fsd.type || ''})` : '';
          return {
            profileId: pid,
            profileName: pname,
            adAccountId: String(a.account_id || a.id || ''),
            adAccountName: String(a.name || ''),
            adAccountStatus: String(a.account_status || 'Unknown'),
            account: user ? String(user.name || user.id || '') : '',
            currency: String(a.currency || ''),
            timezone_id: String(a.timezone_id || ''),
            spend: toMajorAmount(a.amount_spent, a.currency),
            credit_limit: toMajorAmount(a.adtrust_dsl, a.currency),
            balance: toMajorAmount(a.balance, a.currency),
            threshold_amount: toMajorAmount(a.spend_cap, a.currency),
            country: String(a.country_code || ''),
            funding_source: paymentInfo,
            pages_count: pages.length,
            bm_count: businesses.length
          };
        });
        
        try {
          const authToken = localStorage.getItem('auth_token');
          if (mappedAds.length) {
            await fetch(`${sbase}/api/adaccounts/bulk-save`, { 
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
              }, 
              body: JSON.stringify({ items: mappedAds }) 
            });
          }
          if (pages.length) {
            await fetch(`${sbase}/api/pages/bulk-save`, { 
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
              }, 
              body: JSON.stringify({ items: pages.map((pg: any) => ({ ...pg, profileId: pid })) }) 
            });
          }
          if (businesses.length) {
            await fetch(`${sbase}/api/businesses/bulk-save`, { 
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
              }, 
              body: JSON.stringify({ items: businesses.map((bz: any) => ({ ...bz, profileId: pid })) }) 
            });
          }
          // fetchAdAccountsDb(); // Refresh global list (deleted due to non-existent function)
        } catch (saveErr) {
          console.warn('Single profile save failed:', saveErr);
        }
      }
    } catch (e: any) {
      setAssetsError(e?.message || '拉取失败');
    } finally {
      setAssetsLoading(false);
    }
  };

  const refetchPagesFromBusinesses = async () => {
    if (!manualAccessToken || !assetsResult || !Array.isArray(assetsResult.businesses)) return;
    setAssetsError('');
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const sbase = ''; // 线上相对路径
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      const proxyGet = async (url: string) => {
        try {
          const resp = await fetch(`${sbase}/api/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
          const json = await resp.json();
          if (!json || !json.success) throw new Error('proxy_failed');
          const data = json.data ?? {};
          if (data && data.error && data.error.message) throw new Error(data.error.message);
          return data;
        } catch {
          const r2 = await fetch(url);
          const j2 = await r2.json();
          if (j2 && j2.error && j2.error.message) throw new Error(j2.error.message);
          return j2;
        }
      };
      const fetchAll = async (initialUrl: string) => {
        let items: any[] = [];
        let url = initialUrl;
        for (let i = 0; i < 10; i++) {
          const data = await proxyGet(url);
          const part = Array.isArray((data as any).data) ? (data as any).data : [];
          items = items.concat(part);
          const next = (data as any)?.paging?.next;
          if (!next) break;
          url = next;
        }
        return items;
      };
      const businesses = assetsResult.businesses;
      let pages = Array.isArray(assetsResult.pages) ? assetsResult.pages.slice() : [];
      const businessesToSlice = Array.isArray(businesses) ? businesses : [];
      for (const b of businessesToSlice.slice(0, 20)) {
        const ownedPages = await fetchAll(qs(`${base}/${b.id}/owned_pages?fields=id,name,fan_count,link,category,access_token&limit=50`));
        const map: Record<string, any> = {};
        pages.forEach((p: any) => { map[p.id] = p; });
        ownedPages.forEach((p: any) => { map[p.id] = p; });
        pages = Object.values(map);
      }
      setAssetsResult({ ...(assetsResult as any), pages });
    } catch (e: any) {
      setAssetsError(e?.message || '业务主页补充失败');
    }
  };

  const checkPermissions = async () => {
    if (!manualAccessToken) return;
    setAssetsError('');
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || 'http://localhost:7000').replace(/\/$/, '');
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let data: any = null;
      try {
        const resp = await fetch(`${sbase}/api/graph`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
          }, 
          body: JSON.stringify({ url: qs(`${base}/me/permissions`) }) 
        });
        const json = await resp.json();
        if (!json || !json.success) throw new Error('proxy_failed');
        data = json.data ?? {};
      } catch {
        const r2 = await fetch(qs(`${base}/me/permissions`));
        data = await r2.json();
      }
      const perms = Array.isArray((data as any).data) ? (data as any).data : [];
      const required = ['pages_show_list','pages_manage_posts','pages_read_engagement','pages_read_user_content'];
      const missing = required.filter(r => !perms.find((p:any)=>p.permission===r && p.status==='granted'));
      if (missing.length) {
        setAssetsError(`缺少权限：${missing.join(', ')}`);
      } else {
        setAssetsError('权限检测通过');
      }
    } catch (e: any) {
      setAssetsError(e?.message || '权限检测失败');
    }
  };

  useEffect(() => {
    if (isDetailsOpen && selectedItem) {
      const p = profiles.find(pr => pr.id === selectedItem.profileId);
      const tok = p && typeof p.token === 'string' ? p.token : '';
      if (tok && !manualAccessToken) setManualAccessToken(tok);
      if (tok && !assetsResult && !assetsLoading) fetchAssetsWithToken(tok);
    }
  }, [isDetailsOpen, selectedItem, profiles]);

  useEffect(() => {
    if (!isDetailsOpen || !selectedItem) return;
    try {
      const raw = localStorage.getItem('defaultPages');
      const map = raw ? JSON.parse(raw) : {};
      const name = String(map[String(selectedItem.profileId)]||'');
      if (name && assetsResult && Array.isArray(assetsResult.pages)) {
        const found = assetsResult.pages.find((pg:any)=> String(pg.name||'')===name);
        if (found && found.id) setSelectedPageId(String(found.id));
      }
    } catch {}
  }, [assetsResult, isDetailsOpen, selectedItem]);

  const publishToPage = async () => {
    if (!selectedPageId || !pagePostMessage || !manualAccessToken) return;
    setPosting(true);
    setPostError('');
    setPostResult(null);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      let pageToken = '';
      const pages = assetsResult?.pages || [];
      const found = Array.isArray(pages) ? pages.find((p: any) => p.id === selectedPageId) : null;
      if (found && found.access_token) pageToken = found.access_token;
      if (!pageToken) {
        const infoResp = await fetch(qs(`${base}/${selectedPageId}?fields=access_token`));
        const infoJson = await infoResp.json();
        pageToken = infoJson?.access_token || '';
      }
      if (!pageToken) {
        setPostError('缺少页面令牌');
      } else {
        const form = new URLSearchParams();
        form.set('message', pagePostMessage);
        form.set('access_token', pageToken);
        const resp = await fetch(`${base}/${selectedPageId}/feed`, { method: 'POST', body: form });
        const json = await resp.json();
        if (json && json.id) {
          setPostResult(json);
          setPagePostMessage('');
        } else {
          setPostError((json && json.error && json.error.message) ? json.error.message : '发布失败');
        }
      }
    } catch (e) {
      setPostError('网络错误');
    } finally {
      setPosting(false);
    }
  };
  
  // 🚀 所有 profile 的去重邮箱列表（用于超级管理员邮箱筛选）
  const profileEmailOptions = useMemo(() => {
    const emails = new Set<string>();
    profiles.forEach(p => {
      if (p.account?.email) emails.add(p.account.email);
      if (p.ownerEmail) emails.add(p.ownerEmail);
    });
    return Array.from(emails).sort();
  }, [profiles]);

  const filteredData = useMemo(() => {
    const q = searchTerm.toLowerCase();
    let base: any[] = data as any[];
    // 🚀 超级管理员邮箱筛选：按 profileId 匹配邮箱
    if (profileEmailFilter) {
      const matchedProfileIds = new Set(
        profiles
          .filter(p => (p.account?.email || p.ownerEmail || '').toLowerCase().includes(profileEmailFilter.toLowerCase()))
          .map(p => p.id)
      );
      base = base.filter((item: any) => matchedProfileIds.has(String(item.profileId || item.profile_id || '')));
    }
    // 🚀 分组 / 标签 下拉筛选（标签同时兼容数组与逗号字符串）
    if (groupFilter) {
      base = base.filter((item: any) => String(item.group ?? '') === groupFilter);
    }
    if (tagFilter) {
      base = base.filter((item: any) => {
        const t = item.tags;
        const arr = Array.isArray(t) ? t.map(String) : String(t ?? '').split(',').map(s => s.trim()).filter(Boolean);
        return arr.includes(tagFilter);
      });
    }
    if (assetType === 'adAccounts') {
      base = base.filter((item: any) => {
        const okStatus = statusFilter ? String(item.adAccountStatus || '').toLowerCase() === statusFilter.toLowerCase() : true;
        const okCurrency = currencyFilter ? String(item.currency || '').toUpperCase() === currencyFilter.toUpperCase() : true;
        const okCountry = countryFilter ? String(item.country || '').toUpperCase() === countryFilter.toUpperCase() : true;
        return okStatus && okCurrency && okCountry;
      });
    }
    if (assetType === 'bms') {
      base = base.filter((item: any) => {
        const okEmail = bmEmailFilter ? String(item.adminEmail || '').toLowerCase().includes(bmEmailFilter.toLowerCase()) : true;
        return okEmail;
      });
    }
    if (assetType === 'pages') {
      // 🚀 核心修复：同时使用 pagesFilterState 和 localStorage，确保过滤生效
      let activeFilter: any = null;
      if (pagesFilterState.profileId) {
        activeFilter = pagesFilterState;
      } else {
        try {
          const raw = localStorage.getItem('pagesFilter');
          if (raw) activeFilter = JSON.parse(raw);
        } catch {}
      }
      base = base.filter((item: any) => {
        try {
          if (activeFilter?.profileId) {
            // 🚀 修复：同时匹配 profileId 和 profileName，兼容不同数据源
            const matchesId = String(item.profileId) === String(activeFilter.profileId);
            const matchesName = activeFilter.profileName && 
              (String(item.profileName || '').toLowerCase().includes(String(activeFilter.profileName).toLowerCase()));
            if (!matchesId && !matchesName) return false;
          }
        } catch {}
        return true;
      });
    }
    if (!q) return base;
    // 🚀 可搜索字段：除基础字段外，纳入用户数据 —— 分组 / 标签 / 备注
    //    （之前漏了这几个，导致「按分组/标签搜索」完全筛不出来）
    const fieldsOf = (item: any): string[] => {
      const tagsStr = Array.isArray(item.tags) ? item.tags.join(',') : String(item.tags ?? '');
      const fields = [
        uniqueIdKey, 'profileId', 'profileName', 'pageName', 'bmId', 'adAccountId',
        'adAccountName', 'account', 'country', 'currency', 'adminEmail', 'group', 'notes',
      ].map(k => String(item[k] ?? '').toLowerCase());
      fields.push(tagsStr.toLowerCase());
      return fields;
    };
    // 🚀 批量搜索支持：用逗号或换行符分隔多个关键词，匹配任意一个即显示
    const terms = q.split(/[,;\n\r]+/).map(t => t.trim()).filter(Boolean);
    if (terms.length <= 1) {
      return base.filter((item: any) => {
        const seqStr = String(assetSeqMap[item[uniqueIdKey]] ?? item.seq ?? '').toLowerCase();
        return seqStr.includes(q) || fieldsOf(item).some(s => s.includes(q));
      });
    }
    // 🚀 多关键词：匹配任意一个关键词即显示（OR 逻辑）
    return base.filter((item: any) => {
      const fields = fieldsOf(item);
      return terms.some(term => {
        const tl = term.toLowerCase();
        return fields.some(s => s.includes(tl));
      });
    });
  }, [data, searchTerm, uniqueIdKey, assetSeqMap, assetType, statusFilter, currencyFilter, countryFilter, bmEmailFilter, pagesFilterState, profileEmailFilter, profiles, groupFilter, tagFilter]);

  // 🚀 分组 / 标签 下拉可选值（取当前标签页全量数据去重）
  const groupFilterOptions = useMemo(() => {
    const s = new Set<string>();
    (data as any[]).forEach((it) => { const g = String(it.group ?? '').trim(); if (g) s.add(g); });
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh'));
  }, [data]);
  const tagFilterOptions = useMemo(() => {
    const s = new Set<string>();
    (data as any[]).forEach((it) => {
      const t = it.tags;
      const arr = Array.isArray(t) ? t.map(String) : String(t ?? '').split(',').map(x => x.trim()).filter(Boolean);
      arr.forEach((x) => { if (x) s.add(x); });
    });
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh'));
  }, [data]);

  const sortedData = useMemo(() => {
    let sortableItems = [...filteredData];
    sortableItems.sort((a: any, b: any) => {
        let aValue = a[sortConfig.key];
        let bValue = b[sortConfig.key];
        const numericKeys = new Set(['spend','spendCap','pagesCount','bmCount','paymentCount','threshold','creditLimit','balance']);
        if (numericKeys.has(sortConfig.key)) {
          aValue = Number(aValue || 0);
          bValue = Number(bValue || 0);
        }
        if (sortConfig.key === 'seq' || sortConfig.key === 'assetSeq') {
          const av = Number(assetSeqMap[a[uniqueIdKey]] ?? a.seq ?? 0);
          const bv = Number(assetSeqMap[b[uniqueIdKey]] ?? b.seq ?? 0);
          if (av < bv) return sortConfig.direction === 'asc' ? -1 : 1;
          if (av > bv) return sortConfig.direction === 'asc' ? 1 : -1;
          return 0;
        }
        if (sortConfig.key === 'adAccountId') {
          const an = /^\d+$/.test(String(aValue||'')) ? parseInt(String(aValue),10) : String(aValue||'');
          const bn = /^\d+$/.test(String(bValue||'')) ? parseInt(String(bValue),10) : String(bValue||'');
          aValue = an; bValue = bn;
        }
        
        if (sortConfig.key === 'payment') {
          const order = { 'Active': 1, 'Failed': 2, 'None': 3, undefined: 4 };
          const aOrder = order[a.paymentStatus as keyof typeof order];
          const bOrder = order[b.paymentStatus as keyof typeof order];
          if (aOrder < bOrder) return sortConfig.direction === 'asc' ? -1 : 1;
          if (aOrder > bOrder) return sortConfig.direction === 'asc' ? 1 : -1;
          return 0;
        }

        if (aValue === undefined || aValue < bValue) {
            return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (bValue === undefined || aValue > bValue) {
            return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
    });
    return sortableItems;
  }, [filteredData, sortConfig]);

  // 🚀 分页
  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));
  // 🛡️ 页码越界兜底：恢复了「本列表上次所在的页」，但中间数据可能变少 → 停在空白页。
  //    数据还没加载（length=0）时不处理，否则会把刚恢复的页码立刻压回第 1 页。
  useEffect(() => {
    if (sortedData.length > 0 && currentPage > totalPages) setCurrentPage(totalPages);
  }, [totalPages, currentPage, sortedData.length]);
  // 「跳至第 N 页」应用（回车/点按钮共用）：空值或非法值不跳转
  const applyJump = () => {
    const raw = String(jumpPage).trim();
    const n = Number(raw);
    if (!raw || !Number.isFinite(n)) return;
    setCurrentPage(Math.min(totalPages, Math.max(1, Math.floor(n))));
  };
  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, currentPage, pageSize]);
  // 持久化页码
  useEffect(() => {
    try { localStorage.setItem(`assetViewer_page_${assetType}`, String(currentPage)); } catch {}
  }, [currentPage, assetType]);
  useEffect(() => {
    try { localStorage.setItem(`assetViewer_pageSize_${assetType}`, String(pageSize)); } catch {}
  }, [pageSize, assetType]);
  // 搜索时重置到首页
  useEffect(() => { setCurrentPage(1); }, [searchTerm]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
        direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // Selection Logic
  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  // ✅ 全选/取消全选：只作用于**当前分页**，逐行用选择键判断
  //    之前用 selectedIds.size === paginatedData.length 判断，因为集合存的是资产ID（同ID多行会去重），
  //    size 永远小于行数 → 判断永不成立 → 全选后再点也只会「再全选一遍」，取消不了。
  const pageSelectionKeys = useMemo(
    () => paginatedData.map((item: any) => selectionKeyOf(item, uniqueIdKey)),
    [paginatedData, uniqueIdKey]
  );
  const isAllPageSelected = pageSelectionKeys.length > 0 && pageSelectionKeys.every(k => selectedIds.has(k));
  const toggleSelectAll = () => {
    const next = new Set(selectedIds);
    if (isAllPageSelected) {
      pageSelectionKeys.forEach(k => next.delete(k));
    } else {
      pageSelectionKeys.forEach(k => next.add(k));
    }
    setSelectedIds(next);
  };

  const publishPageOptions = useMemo(() => {
    const selectedItems = (data as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));
    const pidSet = new Set<string>(selectedItems.map(it => String(it.profileId||'')).filter(Boolean));
    const pages: Array<{ id: string; name: string; profileId: string }> = Array.isArray(pagesDb) ? pagesDb.filter((p:any)=> pidSet.has(String(p.profileId||''))).map((p:any)=> ({ id: String(p.pageId||p.id||''), name: String(p.pageName||p.name||''), profileId: String(p.profileId||'') })) : [];
    const uniqMap = new Map<string, { id: string; name: string; profileId: string }>();
    pages.forEach(p => { if (!uniqMap.has(p.id)) uniqMap.set(p.id, p); });
    return Array.from(uniqMap.values());
  }, [data, selectedIds, uniqueIdKey, pagesDb]);

  const fetchPagesForSelected = async () => {
    const selectedItems = (data as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));
    const pidList = Array.from(new Set<string>(selectedItems.map(it => String(it.profileId||''))).values()).filter(Boolean);
    if (!pidList.length) return;
    setPublishPagesLoading(true);
    setPublishPagesError('');
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || 'http://localhost:7000').replace(/\/$/, '');
      const proxyGet = async (url: string) => {
        const resp = await fetch(`${sbase}/api/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
        const json = await resp.json();
        if (!json || !json.success) throw new Error('proxy_failed');
        const data = json.data ?? {}; if ((data as any).error && (data as any).error.message) throw new Error((data as any).error.message); return data;
      };
      const nextPages = [...pagesDb];
      for (const pid of pidList) {
        const prof = profiles.find(p => String(p.id) === pid);
        const tok = prof && typeof prof.token === 'string' ? prof.token : '';
        if (!tok) continue;
        const qs = (u: string) => `${u}${u.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(tok)}`;
        const data = await proxyGet(qs(`${base}/me/accounts?fields=id,name&limit=50`));
        const arr = Array.isArray((data as any)?.data) ? (data as any).data : [];
        arr.forEach((p:any) => {
          const id = String(p.id||''); const name = String(p.name||'');
          if (!id) return;
          const exists = nextPages.find((x:any)=> String(x.pageId||x.id||'') === id);
          if (!exists) nextPages.push({ profileId: pid, pageId: id, pageName: name } as any);
        });
      }
      setPagesDb(nextPages as any[]);
    } catch (e:any) {
      setPublishPagesError(e?.message || '页面拉取失败');
    } finally { setPublishPagesLoading(false); }
  };

  const cleanupHiddenAdAccounts = async () => {
    try {
      const sbase = ''; // 统一使用相对路径
      const authToken = localStorage.getItem('auth_token');
      const resp = await fetch(`${sbase}/api/adaccounts`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const json = await resp.json();
      const backend: any[] = (json && json.success && Array.isArray(json.data)) ? json.data : [];
      const backendIds = new Set(backend.map(a => String(a.adAccountId || '')));
      const visibleIds = new Set((adAccountsDb as any[]).map((it: any) => String(it.adAccountId || it.account_id || it.id || '')));
      const target = Array.from(backendIds).filter(id => id && !visibleIds.has(id));
      if (target.length === 0) { alert('无未显示的广告号'); return; }
      const ok = window.confirm(`检测到 ${target.length} 个未显示广告号，将彻底清除并级联删除，确认？`);
      if (!ok) return;
      await fetch(`${sbase}/api/adaccounts/batch-delete`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }, 
        body: JSON.stringify({ account_ids: target }) 
      });
      const resp2 = await fetch(`${sbase}/api/adaccounts`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const json2 = await resp2.json();
      const list = (json2 && json2.success && Array.isArray(json2.data)) ? json2.data : [];
      setAdAccountsDb(list as AdAccountAsset[]);
      try { localStorage.setItem('cache:adaccounts', JSON.stringify(list)); writeAdsCacheMeta(list.length); } catch {}
      try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
    } catch { alert('清理失败'); }
  };

  // 🧵 提交批量慢操作到本机服务端队列：提交即返回，进度/取消在左侧「执行队列」。
  //    与配置列表的 batchSaveAssets 用同一套队列，避免两个入口各自在前端开并发窗口。
  const submitQueueJob = async (type: any, title: string, items: Array<{ key: string; label?: string; payload: any }>, shared?: any) => {
    if (!items.length) { alert('没有可用目标'); return null; }
    try {
      return await submitJob({ type, title, items, shared });
    } catch (e: any) {
      alert(`提交执行队列失败：${e?.message || e}\n（请确认本机后端 9999 已启动）`);
      return null;
    }
  };

  // 🧵 「启动浏览器 → fetch-adaccounts-graph」这类动作（获取像素/主页/广告、检测BM）本质是同一个任务，
  //    统一入队执行，跑完再从后端暂存里取回结果，由调用方做各自的本地落位。
  // ⚠️ pids 必须由调用方传进来：targetsProfileIds 是 handleBatchAction 里的局部常量，
  //    这里（组件作用域）引用不到，以前会直接抛 ReferenceError: targetsProfileIds is not defined。
  const runFetchGraphViaQueue = async (title: string, pids: string[], extra: Record<string, any> = {}) => {
    setBatchLoading(true);
    const job = await submitQueueJob('get_info', title, pids.map(pid => ({
      key: String(pid),
      label: String(pid),
      payload: {
        profileId: String(pid),
        accessToken: (profiles.find(x => String(x.id) === String(pid)) as any)?.token || 'BROWSER',
        // 🎛️ 互动明细开关（关掉可省下最多 90 秒）
        withEngagement: fetchEngagement,
        ...extra
      }
    })));
    if (!job) { setBatchLoading(false); return [] as Array<{ pid: string; res: any }>; }
    // 🚀 「完成一个取一个」：某项一有结论就立刻把它的抓取结果取回来并落位，
    //    不再等整批跑完 —— 以前 50 个配置要等最后一个抓完，界面上全程没有任何变化。
    //    服务端每项抓完就已把结果暂存在 /jobs/last-assets，所以这里随时可以单独取。
    const out: Array<{ pid: string; res: any }> = [];
    const applied = new Set<string>();
    let chain: Promise<void> = Promise.resolve();
    const takeFinished = (j: any): string[] => {
      if (!j || !Array.isArray(j.items)) return [];
      return j.items
        .filter((it: any) => (it.status === 'done' || it.status === 'failed' || it.status === 'cancelled') && !applied.has(String(it.key)))
        .map((it: any) => { applied.add(String(it.key)); return String(it.key); });
    };
    const collectOne = (pid: string) => {
      // 串行取回：applyPageRightsFromPages 会读改写同一份 cache:page-rights，并发会互相覆盖
      chain = chain.then(async () => {
        const res = await getLastAssets(pid);
        if (res && res.success !== false) {
          out.push({ pid, res });
          // 🛡️ 这批动作（获取主页/像素/广告、检测BM）走的都是同一个抓数接口，
          //    结果里带 me/accounts 的 tasks → 顺带刷新「账号权限」列
          applyPageRightsFromPages(pid, Array.isArray(res.pages) ? res.pages : []);
        }
      }).catch(() => {});
    };
    await waitForJob(job.id, (j) => {
      if (j && (j.status === 'queued' || j.status === 'running')) setBatchStage(`执行队列进行中 ${j.done + j.fail}/${j.total}…`);
      takeFinished(j).forEach(collectOne);
    });
    // 兜底：把收尾时仍没扫到的项补齐（取消 / 状态跳变）
    pids.forEach(pid => { if (!applied.has(String(pid))) { applied.add(String(pid)); collectOne(pid); } });
    await chain;
    // 保持返回顺序与传入的 pids 一致（调用方按这个顺序展示/汇总）
    out.sort((a, b) => pids.indexOf(a.pid) - pids.indexOf(b.pid));
    setBatchLoading(false);
    setBatchStage('');
    return out;
  };

  const handleBatchAction = async (action: string) => {
    // 🎛️ 互动明细开关：是个全局偏好，不需要勾选任何资产 —— 必须放在下面的「请先勾选」之前
    if (action === 'toggleEngagement') {
      const next = !fetchEngagement;
      setFetchEngagement(next);
      try { localStorage.setItem(PREF_ENGAGEMENT_KEY, next ? '1' : '0'); } catch {}
      alert(next
        ? '互动明细已开启：抓取时额外取每条贴文的点赞用户/评论/分享者（最多多花 90 秒）'
        : '互动明细已关闭：抓取时跳过点赞用户/评论/分享者，可省下最多 90 秒');
      return;
    }
    if (selectedIds.size === 0) { alert('请先勾选要操作的项'); return; }

    // 批量设置操作员：打开配置选择弹窗（目标操作员由用户选择，与选中项当前归属无关）
    if (action === 'assignOperator') {
      setOperatorModal(true);
      return;
    }
    
    // 🚀 核心重构：统一提取选中资产对应的 Profile IDs
    const selectedItems = (sortedData as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));
    const targetsProfileIds: string[] = Array.from(new Set(selectedItems.map(it => String(it.profileId || it.profile_id || '')))).filter(Boolean);
    const lbase = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';

    if (action === 'delete') {
      const ok = window.confirm(t('assetViewer.batch.deleteConfirm', { count: selectedIds.size }));
      if (!ok) return;
      // ⚠️ 选择集合存的是「配置ID::资产ID」复合键，不能直接当资产ID 用；
      //    这里从选中行取真实资产ID 并去重（同一资产在多配置下会重复出现）
      const ids = Array.from(new Set(selectedItems.map((it: any) => String(it[uniqueIdKey] || '')).filter(Boolean)));
      try {
        if (assetType === 'adAccounts') {
          // 🚀 同步删除 D1、localStorage 和后端缓存
          try {
            const authToken = localStorage.getItem('auth_token');
            await fetch(`/api/adaccounts/batch-delete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
              body: JSON.stringify({ account_ids: ids })
            });
          } catch {}
          const raw = localStorage.getItem('cache:adaccounts');
          const arr = raw ? JSON.parse(raw) : [];
          const next = Array.isArray(arr) ? arr.filter((x: any) => !ids.includes(String(x.adAccountId || x.account_id || ''))) : [];
          localStorage.setItem('cache:adaccounts', JSON.stringify(next));
          writeAdsCacheMeta(next.length);
          setAdAccountsDb(next as AdAccountAsset[]);
          try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
        } else if (assetType === 'pages') {
          // 🚀 同步删除 D1
          try {
            const authToken = localStorage.getItem('auth_token');
            await fetch(`/api/pages/batch-delete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
              body: JSON.stringify({ page_ids: ids })
            });
          } catch {}
          const raw = localStorage.getItem('cache:pages');
          const arr = raw ? JSON.parse(raw) : [];
          const next = Array.isArray(arr) ? arr.filter((x: any) => !ids.includes(String(x.pageId || x.id || ''))) : [];
          localStorage.setItem('cache:pages', JSON.stringify(next));
          setPagesDb(next);
          try { window.dispatchEvent(new Event('pages-refresh')); } catch {}
        } else if (assetType === 'bms') {
          const raw = localStorage.getItem('cache:businesses');
          const arr = raw ? JSON.parse(raw) : [];
          const next = Array.isArray(arr) ? arr.filter((x: any) => !ids.includes(String(x.businessId || x.business_id || x.bmId || x.id || ''))) : [];
          localStorage.setItem('cache:businesses', JSON.stringify(normBmRows(next)));
          const mapped: BmAsset[] = next.map((b: any) => ({
            profileId: String(b.profileId || b.profile_id || ''),
            profileName: String(b.profileName || b.profile_name || ''),
            bmId: String(b.businessId || b.id || ''),
            bmName: String(b.name || b.bmName || ''),
            verificationStatus: (String(b.verification_status || '').toLowerCase() || 'unknown') as 'verified' | 'not_verified' | 'unknown',
            paymentStatus: ((() => {
              const s = String(b.paymentStatus || '').toLowerCase();
              return (s === 'active' ? 'Active' : (s === 'failed' ? 'Failed' : undefined)) as 'Active' | 'Failed' | undefined;
            })()),
            country: b.country ? String(b.country) : undefined,
            currency: b.currency ? String(b.currency) : undefined,
            // 🩺 账号质量（normBmRows 里带着，别在删行后的重渲染中丢掉）
            ...aqFieldsOf(b),
            // 👥 BM 成员
            bmUsers: bmUsersOf(b),
            // 🕒 BM 创建时间
            fbCreatedTime: fbCreatedOf(b),
            // 🔢 可创建广告号上限
            adAccountLimit: adLimitOf(b)
          }));
          setBusinessesDb(mapped);
          try { window.dispatchEvent(new Event('businesses-refresh')); } catch {}
        }
      } catch { alert(t('assetViewer.batch.deleteFailed')); }
      setSelectedIds(new Set());
      return;
    }

    // 🚀 统一浏览器批量操作逻辑 (Token, Cookie, DB, BM, Relogin, Start/Stop)
    //    ⚠️ 启动类动作已改为提交服务端队列（payload 只带 profileId + 启动参数），
    //       完整配置（cookies/userAgent/proxy）由服务端按 profileId 自行读取，
    //       不再需要前端把整份配置拼进请求体。
    // 这些操作在 adAccounts, ads, pages, bms 标签页下逻辑一致
    if (['startProfile', 'stopProfile', 'fetchTokens', 'syncCookies', 'saveToDb', 'checkBM', 'probeAq', 'relogin', 'fetchPixels', 'fetchPages', 'fetchAds'].includes(action)) {
        if (!targetsProfileIds.length) {
            alert('无法识别选中资产关联的浏览器配置 ID');
            return;
        }

        setBatchLoading(true);

        if (action === 'startProfile') {
            const isAdAccountsTab = assetType === 'adAccounts';
            // 🧵 交给服务端队列：浏览器并发由全局闸门统一排队，提交后刷新页面也不丢
            const items = targetsProfileIds.map(pid => {
                // 🚀 广告号启动时打开广告管理后台并带上广告编号
                let startUrl = 'https://www.facebook.com/';
                if (isAdAccountsTab) {
                  const adItem = selectedItems.find(it => String(it.profileId || it.profile_id || '') === pid);
                  const actId = String(adItem?.adAccountId || adItem?.id || '').replace(/^act_?/i, '');
                  startUrl = actId
                    ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${actId}`
                    : 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';
                }
                return {
                    key: String(pid),
                    label: String(pid),
                    payload: {
                        profileId: String(pid),
                        startUrls: [startUrl],
                        strictVerifyOnly: !isAdAccountsTab,
                        strictStartUrls: isAdAccountsTab ? false : true
                    }
                };
            });
            const job = await submitQueueJob('launch_browser', `批量启动浏览器（${items.length} 个）`, items);
            if (job) {
                // 🚀 广告号列表：启动完后自动拉一次广告（同样丢给队列，不占前端）
                if (isAdAccountsTab) {
                    const finished = await waitForJob(job.id);
                    if (finished && finished.status === 'done') {
                        const adJob = await submitQueueJob('get_info', `启动后拉取广告（${items.length} 个）`,
                            items.map(it => ({ key: it.key, label: it.label, payload: { profileId: it.payload.profileId, fetchAds: true, withEngagement: fetchEngagement } })));
                        if (adJob) { await waitForJob(adJob.id); refreshAdsFromServer(); }
                    }
                }
            }
        } else if (action === 'stopProfile') {
            // ⚠️ 关闭浏览器**不进队列**：它是「释放资源」的动作（不占并发名额），
            //    排队反而可能被前面正在跑的任务挡住 → 用户点了没反应。直连立刻执行。
            const tasks = targetsProfileIds.map(pid => fetch(`${lbase}/api/stop-browser`, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET }, 
                body: JSON.stringify({ profileId: pid }) 
            }).then(r=>r.json()).catch(()=>({ success:false })));
            await Promise.allSettled(tasks);
        } else if (action === 'fetchTokens') {
            // 🧵 TOKEN 抓取要开浏览器，走队列；抓到的 token 由服务端直接落库
            const job = await submitQueueJob('fetch_tokens', `批量获取TOKEN（${targetsProfileIds.length} 个）`,
                targetsProfileIds.map(pid => ({ key: String(pid), label: String(pid), payload: { profileId: String(pid) } })));
            if (job) { await waitForJob(job.id); alert('TOKEN 获取任务已在执行队列跑完（结果已保存到配置）'); }
        } else if (action === 'syncCookies') {
            const tasks = targetsProfileIds.map(async pid => {
                try {
                    const res = await postLocal(`${lbase}/api/sync-cookies-to-card`, { profileId: pid }, 120000, '同步 Cookie').then(r=>r.json());
                    if (res.success && setProfiles) {
                        setProfiles(prev => prev.map(p => p.id === pid ? { ...p, cookiesCount: typeof res.saved === 'number' ? res.saved : (p.cookiesCount ?? 0) } : p));
                    }
                    return res;
                } catch (e) { return { success: false }; }
            });
            const results = await Promise.allSettled(tasks);
            const ok = results.filter(r => r.status === 'fulfilled' && (r as any).value?.success).length;
            // 失败时把服务端的原因带出来（比如「浏览器当前不是登录态，已拒绝覆盖」），否则只有一句 0/1
            const firstReason = results.map(r => (r.status === 'fulfilled' ? (r as any).value?.message : '') || '').find(Boolean) || '';
            alert(`Cookie 同步完成：成功 ${ok}/${targetsProfileIds.length}${ok < targetsProfileIds.length && firstReason ? `\n原因：${firstReason}` : ''}`);
        } else if (action === 'saveToDb') {
            const targets = profiles.filter(p => targetsProfileIds.includes(p.id));
            try {
                const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
                const authToken = localStorage.getItem('auth_token');
                const resp = await fetch(`${sbase}/api/profiles/bulk-save`, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, 
                    body: JSON.stringify({ profiles: targets }) 
                });
                const json = await resp.json();
                if (json && json.success) alert(`成功保存 ${targets.length} 个配置到数据库`);
                else alert(`保存失败: ${json?.message || '未知错误'}`);
            } catch (e: any) { alert(`保存网络错误: ${e.message}`); }
        } else if (action === 'checkBM') {
            // 🧵 启动浏览器 → fetch-adaccounts-graph 这套动作统一交给队列，跑完再取回结果做本地落位
            // 🩺 withAccountQuality：顺带读一次 Meta Account Quality，拿「BM 自身」是否被封/受限。
            //    Graph 侧完全没有这个信息（me/businesses 只有 id/name/verification_status/link），
            //    而且必须趁浏览器还被队列借着的时候查 —— 队列跑完就会把浏览器还掉。
            const got = await runFetchGraphViaQueue(`批量检测BM（${targetsProfileIds.length} 个）`, targetsProfileIds, { withAccountQuality: true });
            const bmRows: any[] = [];
            let foundProfiles = 0;
            let aqChecked = 0;
            let aqUnclear = 0;
            const aqRawSamples: string[] = [];
            for (const { pid, res } of got) {
                // ⚠️ 抓数接口里 BM 列表的字段名是 `bms`（不是我以前写错的 `businesses`）——
                //    写错 → 永远拿到空数组 → 每个配置都被判成「没有 BM」，还会把企业认证状态一起涂成 unknown。
                const bms = Array.isArray(res.bms) ? res.bms : [];
                if (bms.length) foundProfiles += 1;
                // 🩺 Account Quality 结果：businessId -> { status, evidence, policy }
                const aqMap = new Map<string, any>();
                if (Array.isArray(res.bmAccountQuality)) {
                    res.bmAccountQuality.forEach((r: any) => {
                        const bid = String(r?.businessId || '');
                        if (bid) aqMap.set(bid, r);
                    });
                }
                if (res.bmAccountQualityRaw) aqRawSamples.push(`--- ${pid} ---\n${String(res.bmAccountQualityRaw).slice(0, 1000)}`);
                const firstBm = bms[0] || null;
                if (setProfiles) {
                    setProfiles(prev => prev.map(px => px.id === pid ? { ...px, assets: { ...(px.assets || {}),
                        bmId: firstBm ? (String(firstBm.id || '') || px.assets?.bmId) : px.assets?.bmId,
                        bmIds: bms.map((b: any) => String(b.id || '')).filter(Boolean),
                        // 只在真拿到 BM 时更新认证状态，取不到就保持原值（别用 unknown 覆盖已知状态）
                        ...(firstBm ? { verificationStatus: (String(firstBm.verification_status || '').toLowerCase() || px.assets?.verificationStatus) as any } : {})
                    } } : px));
                }
                bms.forEach((b: any) => {
                    const bid = String(b.id || '');
                    if (!bid) return;
                    const aq = aqMap.get(bid);
                    if (aq) {
                        aqChecked += 1;
                        // 页面里没找到这个 BM（多半不是管理员）或认不出状态 → 都算「没结论」
                        if (aq.status === 'not_found' || aq.status === 'unknown' || aq.status === 'no_login') aqUnclear += 1;
                    }
                    bmRows.push({ profileId: pid, businessId: bid, id: bid, name: String(b.name || ''), verification_status: String(b.verification_status || ''), link: String(b.link || ''),
                        aqStatus: aq ? String(aq.status || '') : '',
                        aqEvidence: aq ? String(aq.evidence || '') : '',
                        aqPolicy: aq ? String(aq.policy || '') : '' });
                });
            }
            // 🎯 结果落到「BM 列表」那份数据：按 profileId 替换涉及的配置，其余保留。
            //    （以前只写 profiles[].assets，BM 列表其实读的是 businessesDb / cache:businesses，两边对不上）
            if (bmRows.length) {
                const prevRows = (() => { try { return JSON.parse(localStorage.getItem('cache:businesses') || '[]'); } catch { return []; } })();
                const touched = new Set(bmRows.map(r => String(r.profileId)));
                const next = [
                    ...(Array.isArray(prevRows) ? prevRows : []).filter((x: any) => !touched.has(String(x.profileId || x.profile_id || ''))),
                    ...bmRows
                ];
                try { localStorage.setItem('cache:businesses', JSON.stringify(normBmRows(next))); } catch {}
                // 事件会触发 refreshBusinesses（读缓存）+ 从服务器刷新，界面即时更新
                try { window.dispatchEvent(new Event('businesses-refresh')); } catch {}
            }
            // 🔎 校准用：一个都没结论时，把 Account Quality 的页面原文打到控制台 ——
            //    页面结构变了 / ?business_id= 不生效的话，靠这段原文就能定出新的解析规则。
            if (aqChecked > 0 && aqUnclear === aqChecked && aqRawSamples.length) {
                console.warn('[AccountQuality] 全部无法判定，页面原文（前 1000 字/配置）如下，可用于校准解析规则：\n' + aqRawSamples.join('\n'));
            }
            alert(`BM 检测完成：${got.length}/${targetsProfileIds.length} 个配置，共检出 ${bmRows.length} 个 BM（${foundProfiles} 个配置有 BM）\n账号质量：已查 ${aqChecked} 个${aqUnclear ? `，其中 ${aqUnclear} 个无法判定（见控制台原文）` : ''}`);
        } else if (action === 'probeAq') {
            // 🩺 只做「账号质量」浏览器探测（读 Meta Account Quality，看 BM 自身是否被封/受限），
            //    不跑「检测BM」那套全量取数 —— 以前这列唯一入口是检测BM，几乎没人专门为这一列
            //    跑全量（日志可证：探测从未执行过，列里永远是「未检测」）。
            //    流程：按配置分组 → 浏览器没开的经执行队列拉起（探测接口自己不开浏览器）→
            //          逐配置直连 /api/facebook/bm-account-quality → 结果并回 cache:businesses。
            const rows = (sortedData as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));
            const byProfile = new Map<string, Array<{ id: string; name: string }>>();
            rows.forEach(r => {
                const pid = String(r.profileId || r.profile_id || '');
                const bid = String(r.businessId || r.business_id || r.bmId || r.id || '');
                if (!pid || !bid) return;
                const list = byProfile.get(pid) || [];
                if (!list.some(x => x.id === bid)) list.push({ id: bid, name: String(r.name || '') });
                byProfile.set(pid, list);
            });
            if (!byProfile.size) { alert('无法识别选中 BM 关联的配置/BM 编号'); setBatchLoading(false); return; }

            // 1) 浏览器没开的配置先经执行队列拉起（复用并发闸门，避免直连启动绕过排队）
            let running: string[] = [];
            try {
                const rb = await fetchWithTimeout(`${lbase}/api/browsers`, { method: 'GET' }, 15000, '查询运行中浏览器');
                running = (((await rb.json())?.data) || []).map((x: any) => String(x.profileId));
            } catch {}
            const missing = Array.from(byProfile.keys()).filter(pid => !running.includes(pid));
            if (missing.length) {
                const job = await submitQueueJob('launch_browser', `账号质量探测：启动浏览器（${missing.length} 个）`,
                    missing.map(pid => ({ key: String(pid), label: String(pid), payload: { profileId: String(pid) } })));
                if (job) await waitForJob(job.id);
            }

            // 2) 逐配置串行探测（Account Quality 是重型页面，同一浏览器不宜并发开多个；
            //    单个 BM 最多 ~51s = 45s 导航 + 6s 等待，按 BM 数放宽超时）
            let okCount = 0, failCount = 0;
            const statCount: Record<string, number> = {};
            for (const [pid, businesses] of byProfile) {
                try {
                    const resp = await postLocal(`${lbase}/api/facebook/bm-account-quality`,
                        { profileId: pid, businesses }, 90000 + businesses.length * 70000, '账号质量探测');
                    const j = await resp.json().catch(() => null);
                    const results = Array.isArray(j?.results) ? j.results : [];
                    if (j?.success && results.length) {
                        okCount += results.length;
                        results.forEach((r: any) => { const s = String(r.status || 'unknown'); statCount[s] = (statCount[s] || 0) + 1; });
                    } else {
                        // no_browser（启动失败/被秒关）或探测为空 → 都算失败
                        failCount += businesses.length;
                    }
                    // 3) 结果并回 cache:businesses：按 配置ID::BM ID 匹配覆盖 aq 三件套；
                    //    缓存里没有的 BM 新建一行（这样「无权限查询」这类结果也能显示出来）
                    const prev = (() => { try { return JSON.parse(localStorage.getItem('cache:businesses') || '[]'); } catch { return []; } })();
                    const resultMap = new Map<string, any>(results.map((r: any) => [String(r.businessId || ''), r]));
                    const next = (Array.isArray(prev) ? prev : []).map((row: any) => {
                        const bid = String(row.businessId || row.business_id || row.bmId || row.id || '');
                        const r = resultMap.get(bid);
                        return (String(row.profileId || row.profile_id || '') === pid && r)
                            ? { ...row, aqStatus: String(r.status || ''), aqEvidence: String(r.evidence || ''), aqPolicy: String(r.policy || '') }
                            : row;
                    });
                    results.forEach((r: any) => {
                        const bid = String(r.businessId || '');
                        if (!bid) return;
                        const exists = next.some((row: any) => String(row.profileId || row.profile_id || '') === pid
                            && String(row.businessId || row.business_id || row.bmId || row.id || '') === bid);
                        if (!exists) next.push({ profileId: pid, businessId: bid, bmId: bid, business_id: bid, id: bid,
                            name: (byProfile.get(pid) || []).find(b => b.id === bid)?.name || '',
                            aqStatus: String(r.status || ''), aqEvidence: String(r.evidence || ''), aqPolicy: String(r.policy || '') });
                    });
                    try { localStorage.setItem('cache:businesses', JSON.stringify(normBmRows(next))); } catch {}
                } catch { failCount += businesses.length; }
            }
            try { window.dispatchEvent(new Event('businesses-refresh')); } catch {}
            const statLabel = (s: string) => s === 'active' ? '正常' : s === 'restricted' ? '受限' : s === 'disabled' ? '已停用'
                : s === 'not_found' ? '无权限' : s === 'no_login' ? '未登录' : '无法判定';
            const statText = Object.entries(statCount).map(([s, n]) => `${statLabel(s)} ${n}`).join('，');
            alert(`账号质量探测完成：成功 ${okCount} 个${failCount ? `，失败 ${failCount} 个（浏览器没开起来/页面读不到）` : ''}${statText ? `\n结果：${statText}` : ''}\n说明：只有该 BM 的管理员才看得到页面 → 非管理员显示「无权限查询」`);
            setBatchLoading(false);
        } else if (action === 'relogin') {
            // 🧵 重登要开浏览器 → 走队列
            const job = await submitQueueJob('relogin', `批量重登（${targetsProfileIds.length} 个）`,
                targetsProfileIds.map(pid => ({ key: String(pid), label: String(pid), payload: { profileId: String(pid) } })));
            if (job) {
                const finished = await waitForJob(job.id);
                alert(`批量重登任务已在执行队列结束：成功 ${finished?.ok ?? 0}/${targetsProfileIds.length}`);
            }
        } else if (action === 'fetchPixels') {
            const got = await runFetchGraphViaQueue(`批量获取像素（${targetsProfileIds.length} 个）`, targetsProfileIds);
            const allFoundPixels: any[] = [];
            got.forEach(({ res }) => { if (Array.isArray(res.pixels)) allFoundPixels.push(...res.pixels); });
            if (allFoundPixels.length > 0) {
                const pixelInfo = allFoundPixels.map(p => `${p.name || 'Unnamed'}: ${p.id}`).join('\n');
                alert(`像素同步完成！共找到 ${allFoundPixels.length} 个像素：\n\n${pixelInfo}`);
            } else {
                alert('像素同步完成，但未发现任何像素。');
            }
            refreshAdAccountsFromServer();
        } else if (action === 'fetchPages') {
            const got = await runFetchGraphViaQueue(`批量获取主页（${targetsProfileIds.length} 个）`, targetsProfileIds);
            alert(`主页获取完成：${got.length}/${targetsProfileIds.length} 个 Profile`);
            refreshPagesFromServer();
        } else if (action === 'fetchAds') {
            const got = await runFetchGraphViaQueue(`批量获取广告（${targetsProfileIds.length} 个）`, targetsProfileIds, { fetchAds: true });
            alert(`广告获取完成：${got.length}/${targetsProfileIds.length} 个 Profile`);
            refreshAdsFromServer();
        }

        setBatchLoading(false);
        return;
    }

    if (assetType === 'ads') {
        if (['activeAd', 'pauseAd', 'archiveAd', 'deleteAd'].includes(action)) {
            const fbAction = action === 'activeAd' ? 'start' : (action === 'pauseAd' ? 'stop' : (action === 'archiveAd' ? 'archive' : 'delete'));
            
            if (fbAction === 'delete') {
                const ok = window.confirm(`确定要永久删除选中的 ${selectedItems.length} 个资产吗？此操作不可撤销。`);
                if (!ok) return;
            }

            setBatchLoading(true);
            const tasks = selectedItems.map(item => {
                let endpoint = '';
                if (item.type === 'campaign') endpoint = 'campaigns';
                else if (item.type === 'adset') endpoint = 'adsets';
                else endpoint = 'ads';

                return fetch(`${lbase}/api/facebook/adaccounts/${endpoint}/manage`, { 
                    method: 'POST', 
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-Api-Secret': LOCAL_SERVER_SECRET
                    }, 
                    body: JSON.stringify({ 
                        profileId: String(item.profileId || item.profile_id), 
                        assetId: String(item.id || item.adId), 
                        action: fbAction 
                    }) 
                }).then(r=>r.json()).catch(()=>({ success:false }));
            });

            await Promise.allSettled(tasks);
            setBatchLoading(false);
            
            // 🚀 核心改进：拉取资产后，同时刷新广告账户和广告列表
            await Promise.all([
                refreshAdAccountsFromServer(),
                refreshAdsFromServer()
            ]);
            
            // 弹出成功提示
            alert('获取信息同步完成！');
            return;
        }
        
    }
    if (assetType === 'adAccounts' && action === 'checkSpend') {
      // 🐛 原写法 `profiles.filter(p => selectedIds.has(p.id))`：拿「广告号的行选择键」去比「配置的 id」，
      //    两边根本不是一个东西 → 永远筛不出任何配置，检查消耗一直空转。改为从选中行取 profileId。
      const targetProfileIds = Array.from(new Set(selectedItems.map((it: any) => String(it.profileId || it.profile_id || '')).filter(Boolean)));
      const run = async () => {
        for (const pid of targetProfileIds) {
          try {
            await fetch(`${lbase}/api/facebook/adaccounts/sync`, { 
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': LOCAL_SERVER_SECRET
              }, 
              body: JSON.stringify({ profileId: pid }) 
            });
          } catch {}
        }
        refreshAdAccountsFromServer();
      };
      run();
      return;
    }
    if (assetType === 'adAccounts' && action === 'hardDelete') {
      const ok = window.confirm(`将彻底清除选中的 ${selectedIds.size} 个广告号，且级联删除相关数据，确认？`);
      if (!ok) return;
      // ⚠️ 同样从选中行取真实 adAccountId（选择键含配置ID，不能直接当资产ID 用）
      const ids = Array.from(new Set(selectedItems.map((it: any) => String(it[uniqueIdKey] || '')).filter(Boolean)));
      try {
        const authToken = localStorage.getItem('auth_token');
        const sbase = ''; // 统一使用相对路径
        await fetch(`${sbase}/api/adaccounts/batch-delete`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          }, 
          body: JSON.stringify({ account_ids: ids }) 
        });
        refreshAdAccountsFromServer();
        try {
          const raw = localStorage.getItem('cache:adaccounts');
          const arr = raw ? JSON.parse(raw) : [];
          const next = Array.isArray(arr) ? arr.filter((x: any) => !ids.includes(String(x.adAccountId || x.account_id || ''))) : [];
          localStorage.setItem('cache:adaccounts', JSON.stringify(next));
          writeAdsCacheMeta(next.length);
          window.dispatchEvent(new Event('adaccounts-refresh'));
        } catch {}
      } catch {
        alert('彻底清除失败');
      }
      setSelectedIds(new Set());
      return;
    }
    if (assetType === 'adAccounts') {
      const targets: any[] = (sortedData as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));

      if (action === 'checkBMStatus') {
        try { await refreshBusinesses(); } catch {}
        return;
      }
      if (action === 'changeCurrencyTimezone') {
        setChangeError('');
        setChangeTargets(targets);
        setChangeCurrency(String(targets[0]?.currency || 'USD'));
        setChangeCountry(String(targets[0]?.country || 'US'));
        setChangeTimezone(String(targets[0]?.timezone_id && TZ_OPTIONS.some(t=>t.val===String(targets[0]?.timezone_id)) ? targets[0]?.timezone_id : '1'));
        setChangeTimezoneOffset(String(targets[0]?.timezone_id && TZ_OPTIONS.some(t=>t.val===String(targets[0]?.timezone_id)) ? targets[0]?.timezone_id : '1'));
        setIsChangeCTOpen(true);
        return;
      }
      if (action === 'addPayment') {
        setAddPaymentError('');
        setAddPaymentTargets(targets);
        setSelectedMethod(null);
        setAddMode('manual');
        setCardNumber('');
        setCardHolder('');
        setCardExpiryMonth('');
        setCardExpiryYear('');
        setCardCvv('');
        setCardChannel('');
        setCardTag('');
        // 预设渠道和标签选项
        setChannelOptions(['Adpos', 'Link', 'OmniFingerprint', 'Manual', 'API']);
        setTagOptions(['主号', '备用', '测试', '个人', '公司', '俄区', '其他']);
        setIsAddPaymentOpen(true);
        setBillingLoading(true);
        try {
          const by: Record<string, any[]> = {};
          let nb = false;
          const calls = targets.map(async it => {
            const pid = String(it.profileId);
            try {
              const j = await fetch(`${lbase}/api/facebook/billing`, { 
                method: 'POST', 
                headers: { 
                  'Content-Type': 'application/json',
                  'X-Api-Secret': LOCAL_SERVER_SECRET
                }, 
                body: JSON.stringify({ profileId: pid }) 
              }).then(r=>r.json());
              const arr = Array.isArray(j?.methods) ? j.methods : [];
              if (String(j?.status||'')==='no_browser') nb = true;
              by[pid] = arr;
            } catch { by[pid] = []; }
          });
          await Promise.allSettled(calls);
          // 🚀 修正：移除误导性的"已打开验证页面"提示
          // 改为从 Cloudflare API 拉取已保存的卡片
          try {
            const authToken = token || localStorage.getItem('auth_token');
            const r = await fetch(`/api/billing-methods`, {
              headers: { 'Authorization': `Bearer ${authToken}` }
            });
            const j = await r.json();
            const list = Array.isArray(j?.data) ? j.data : [];
            // 按 profile_id 分组
            const by: Record<string, any[]> = {};
            for (const m of list) {
              const pid = String(m.profile_id || '');
              if (!by[pid]) by[pid] = [];
              by[pid].push(m);
            }
            // 合并已有的 billingMethodsByProfile
            setBillingMethodsByProfile(prev => ({ ...prev, ...by }));
            const providers = Array.from(new Set(list.map((x:any)=>{ try { const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {}); return String(addr.provider||''); } catch { return '' } }).filter(Boolean)));
            const tags = Array.from(new Set(list.flatMap((x:any)=>{ try { const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {}); return Array.isArray(addr.tags)?addr.tags.map(String):[]; } catch { return [] } }).filter(Boolean)));
            setChannelOptions(providers as string[]);
            setTagOptions(tags as string[]);
            const pidSet = new Set(targets.map(t=>String(t.profileId)));
            for (const pid of Array.from(pidSet)) {
              const stash = list.filter((x:any)=>String(x.profileId||'')===pid).map((m:any)=>({ type: String(m.type||''), last4: String(m.last4||'') }));
              const src = Array.isArray(by[pid]) ? by[pid] : [];
              const merged = [...src, ...stash];
              const uniq = [] as any[];
              const seen = new Set<string>();
              for (const m of merged) { const k = String(m.last4||''); if (!seen.has(k) && k) { seen.add(k); uniq.push(m); } }
              by[pid] = uniq;
            }
          } catch { }
          // 🚀 修复：合并而非覆盖
          setBillingMethodsByProfile(prev => ({ ...prev, ...by }));
          if (nb) setAddPaymentError('部分目标未启动浏览器或未登录，请先启动后刷新账单');
        } catch { /* 不重置数据，保留原有状态 */ }
        finally { setBillingLoading(false); }
        return;
      }
      if (action === 'enableAccount' || action === 'disableAccount') {
        const endpoint = action === 'enableAccount' ? 'start' : 'stop';
        const tasks = targets.map(item => fetch(`${lbase}/api/facebook/adaccounts/account/${endpoint}`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          }, 
          body: JSON.stringify({ profileId: String(item.profileId), adAccountId: String(item.adAccountId) }) 
        }).then(r=>r.json()).catch(()=>({ success:false })));
        await Promise.allSettled(tasks);
        return;
      }
      if (action === 'topUp') {
        const amountStr = window.prompt('输入充值金额(USD)：', '50') || '0';
        const amount = Number(amountStr) || 0;
        const tasks = targets.map(item => fetch(`${lbase}/api/facebook/adaccounts/topup`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          }, 
          body: JSON.stringify({ profileId: String(item.profileId), adAccountId: String(item.adAccountId), amount }) 
        }).then(r=>r.json()).catch(()=>({ success:false })));
        await Promise.allSettled(tasks);
        return;
      }
      if (action === 'setSpendCap') {
        // 💰 真正写入 Meta 的账户花费上限。金额按「账户货币主单位」输入，后端换算成最小单位。
        const cur = String(targets[0]?.currency || 'USD').toUpperCase();
        const mixedCurrency = targets.some(t => String(t.currency || '').toUpperCase() !== cur);
        const capStr = window.prompt(
          mixedCurrency
            ? `注意：选中的账户货币不一致，将按各自账户货币写入。输入账户花费上限(${cur}，原值提交·不换算)：`
            : `输入账户花费上限(${cur}，原值提交·不换算，0 = 取消限额)：`,
          String(targets[0]?.spendCap || 100)
        );
        if (capStr === null || capStr.trim() === '') return;
        const spend_cap = Number(capStr);
        if (!Number.isFinite(spend_cap) || spend_cap < 0) { alert('限额数值无效：' + capStr); return; }
        const tasks = targets.map(item => fetch(`${lbase}/api/facebook/adaccounts/spend-cap`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          }, 
          body: JSON.stringify({ profileId: String(item.profileId), adAccountId: String(item.adAccountId), spend_cap, currency: String(item.currency || cur) }) 
        }).then(r=>r.json()).catch(()=>({ success:false, message: '请求失败' })));
        const results = await Promise.allSettled(tasks);
        const failed = results.filter(r => r.status !== 'fulfilled' || !(r.value as any)?.success);
        refreshAdAccountsFromServer();
        if (failed.length) {
          const first = failed[0].status === 'fulfilled' ? (failed[0].value as any)?.message : '请求失败';
          alert(`修改限额：成功 ${targets.length - failed.length}/${targets.length}，失败 ${failed.length}\n首个失败原因：${first || '未知'}`);
        }
        return;
      }
      const startStop = async (kind: 'campaigns'|'adsets'|'ads', op: 'start'|'stop') => {
        const tasks = targets.map(item => fetch(`${lbase}/api/facebook/adaccounts/${kind}/${op}`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          }, 
          body: JSON.stringify({ profileId: String(item.profileId), adAccountId: String(item.adAccountId) }) 
        }).then(r=>r.json()).catch(()=>({ success:false })));
        await Promise.allSettled(tasks);
      };
      if (action === 'startCampaigns') { await startStop('campaigns','start'); return; }
      if (action === 'stopCampaigns') { await startStop('campaigns','stop'); return; }
      if (action === 'startAdSets') { await startStop('adsets','start'); return; }
      if (action === 'stopAdSets') { await startStop('adsets','stop'); return; }
      if (action === 'startAds') { await startStop('ads','start'); return; }
      if (action === 'stopAds') { await startStop('ads','stop'); return; }
      if (action === 'createPixel') {
        const name = window.prompt('输入像素名称：', 'My Pixel') || '';
        if (!name) return;
        
        const tasks = targets.map(async item => {
          try {
            const resp = await fetch(`${lbase}/api/facebook/adaccounts/pixel/create`, { 
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': LOCAL_SERVER_SECRET
              }, 
              body: JSON.stringify({ 
                profileId: String(item.profileId), 
                adAccountId: String(item.adAccountId || item.account_id), 
                name 
              }) 
            });
            return await resp.json();
          } catch (e) {
            return { success: false, message: '网络错误' };
          }
        });

        const results = await Promise.all(tasks);
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        
        if (successCount > 0) {
          alert(`成功创建 ${successCount} 个像素${failCount > 0 ? `，失败 ${failCount} 个` : ''}`);
          setTimeout(() => {
            refreshAdAccountsFromServer();
          }, 1000);
        } else {
          const firstErr = results.find(r => !r.success)?.message || '未知错误';
          alert(`像素创建失败: ${firstErr}`);
        }
        return;
      }
      if (action === 'createPage') {
        setCreateTargets(targetsProfileIds as any);
        setIsPageCreatorOpen(true);
        return;
      }
      if (action === 'createBM') {
        setCreateTargets(targetsProfileIds as any);
        setCreateBMName('');
        setIsRandomBMName(false);
        setIsRandomBMEmail(false);
        setCreateBMCountry('');
        setCreateBMCount(1);
        setBmCreateAdAccount(false);
        setBmCreatePage(false);
        setBmDefaultPageName('');
        // 🚀 自动填充随机邮箱 + 加载代理
        setCreateBMEmail(generateRandomEmail());
        // 🚀 打开时加载已保存的代理列表（缓存 + API 回退）
        (async () => {
          try {
            const raw = localStorage.getItem('proxy-list');
            if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length > 0) { setBmProxyListAV(arr); return; } }
          } catch {}
          try {
            const base = String((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
            const authToken = localStorage.getItem('auth_token');
            if (!authToken) return;
            const r = await fetch(`${base}/api/proxies`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            if (!r.ok) return;
            const j = await r.json();
            const list = Array.isArray(j?.data) ? j.data : [];
            setBmProxyListAV(list);
            try { localStorage.setItem('proxy-list', JSON.stringify(list)); } catch {}
          } catch {}
        })();
        setIsCreateBMOpen(true);
        return;
      }
      // 🆕 更改货币/时区
      if (action === 'changeCurrencyTimezone') {
        const item = targets[0];
        if (!item) { alert('请先选择一个广告账户'); return; }
        setIsCcyTzOpen(true);
        return;
      }
      // 🆕 授权主页给BM
      if (action === 'grantPage') {
        setCreateError('');
        setIsGrantPageOpen(true);
        return;
      }
      // 🆕 广告号授权到个人号
      if (action === 'assignPersonalAd') {
        setAssignPersonalMode('adAccount');
        setIsAssignPersonalOpen(true);
        return;
      }
      // 🆕 授权/认领到 BM（把选中广告号加入系统里的某个 BM，BM 可搜索名称或 ID）
      if (action === 'assignToBm') {
        setIsAssignToBmOpen(true);
        return;
      }
      // 🆕 创建广告账户（BM 下）
      if (action === 'createAdAccount') {
        setIsCreateAdAccountOpen(true);
        return;
      }
      if (action === 'publishAd') { setIsPublishOpen(true); return; }
      if (action === 'smartPublish') { setIsSmartPublishOpen(true); return; }
      if (action === 'verifyCards') {
        try {
          const calls = targets.map(async it => {
            const pid = String(it.profileId || '');
            const aid = String(it.adAccountId || it.account_id || it.id || '');
            if (!pid || !aid) return null as any;
            const numId = aid.replace(/^act_/, '');
            const qs = new URLSearchParams();
            qs.set('asset_id', numId);
            qs.set('payment_account_id', numId);
            qs.set('nav_ref', 'billing_hub');
            qs.set('placement', 'aymt_cvco_ad_account_tip');
            qs.set('wizard_name', 'RESOLVE_SDC_FRICTION');
            const target = `https://business.facebook.com/latest/billing_hub/payment_settings/?${qs.toString()}`;
            
            try {
              const res = await fetch(`${lbase}/api/facebook/verify-card`, {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'X-Api-Secret': LOCAL_SERVER_SECRET
                },
                body: JSON.stringify({ profileId: pid, targetUrl: target })
              });
              const json = await res.json();
              if (!json.success) {
                 const msg = json.message || json.error || 'launch failed';
                 setOpsDetails(prev => [...prev, { profileId: pid, adAccountId: aid, ok: false, message: msg }]);
                 return false;
              }
              return true;
            } catch (e: any) {
              setOpsDetails(prev => [...prev, { profileId: pid, adAccountId: aid, ok: false, message: e.message || 'network error' }]);
              return false;
            }
          });
          const results = await Promise.allSettled(calls);
          const stats = results.map(r => (r.status === 'fulfilled' ? (r.value === true) : false));
          const total = stats.length;
          const success = stats.filter(Boolean).length;
          const failed = total - success;
          const detail = `验证卡片: 成功 ${success}/${total}${failed>0?`，失败 ${failed}`:''}`;
          setOpsLog(prev => [...prev, { time: Date.now(), action: 'verifyCards', detail }]);
          try {
            if (success > 0 && failed === 0) {
              window.alert(`已触发 ${success} 个账户的验证卡片流程，浏览器将自动打开`);
            } else if (success > 0 && failed > 0) {
              window.alert(`已触发 ${success}/${total} 个账户的验证卡片流程，部分失败，请检查后端服务`);
            } else {
              window.alert('触发验证卡片失败，请检查后端服务或选择的账户信息');
            }
          } catch {}
        } catch {}
        return;
      }
    }
    if (assetType === 'bms' && (action === 'checkStatus' || action === 'addPayment')) {
      const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
      const baseUrl = launchUrl.replace(/\/$/, '');
      const targets: any[] = (sortedData as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));
      if (action === 'checkStatus') {
        const base = 'https://graph.facebook.com/v20.0';
        // ⚠️ 这里只产出「真实拿得到的东西」：BM ID（可能有多个）+ 企业认证状态。
        //    BM 的封禁/受限状态 Meta 没有可直接读的字段，以前那个 `bid ? Active : Restricted`
        //    只是「有没有 BM」的推断，已被当成 BM 健康度误用 → 不再产出。
        const results: Array<{ pid: string; bids: string[]; verificationStatus: 'verified' | 'not_verified' | 'unknown' }> = [];
        for (const item of targets) {
          const pid = String(item.profileId);
          const prof = profiles.find(pp => pp.id === pid);
          const tok = prof && typeof prof.token === 'string' ? prof.token : '';
          if (tok) {
            try {
              const r = await fetch(`${base}/me/businesses?fields=id,verification_status&limit=50&access_token=${encodeURIComponent(tok)}`);
              const j = await r.json();
              const arr = Array.isArray(j?.data) ? j.data : [];
              const bids = arr.map((b: any) => String(b.id || '')).filter(Boolean);
              // 认证状态取第一个 BM 的（多 BM 配置不在这里猜，下面把全部 ID 都记下来）
              const vs = (String(arr[0]?.verification_status || '').toLowerCase() || 'unknown') as 'verified' | 'not_verified' | 'unknown';
              results.push({ pid, bids, verificationStatus: vs });
              continue;
            } catch {}
          }
          try {
            const jr = await fetch(`${baseUrl}/api/facebook/bm-info`, { 
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': LOCAL_SERVER_SECRET
              }, 
              body: JSON.stringify({ profileId: pid }) 
            });
            const jj = await jr.json();
            const bid = jj?.businessId ? [String(jj.businessId)] : [];
            results.push({ pid, bids: bid, verificationStatus: 'unknown' });
          } catch {
            results.push({ pid, bids: [], verificationStatus: 'unknown' });
          }
        }
        if (setProfiles) {
          const doneMap = new Map<string, { bids: string[]; vs: 'verified' | 'not_verified' | 'unknown' }>();
          results.forEach(r => doneMap.set(r.pid, { bids: r.bids, vs: r.verificationStatus }));
          setProfiles(prev => prev.map(p => {
            const hit = doneMap.get(p.id);
            if (!hit) return p;
            return { ...p, assets: { ...(p.assets || {}),
              bmId: hit.bids[0] || p.assets?.bmId,
              bmIds: hit.bids.length ? hit.bids : p.assets?.bmIds,
              // 没查到 BM / 状态 unknown 时保持原值，别用 unknown 覆盖已知认证状态
              ...(hit.bids.length && hit.vs !== 'unknown' ? { verificationStatus: hit.vs } : {})
            } };
          }));
        }
        try {
          const storageUrl = '';
          let sbase = storageUrl.replace(/\/$/, '');
          // ⚠️ 只传 id + 认证状态（云端 upsert 不会用空名覆盖已有名称，也不会用 unknown 冲掉 verified）
          const items = results.flatMap(r => r.bids.map(bid => ({ profileId: r.pid, businessId: bid, verification_status: r.verificationStatus })));
          if (items.length) await fetch(`${sbase}/api/businesses/bulk-save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
          window.dispatchEvent(new Event('businesses-refresh'));
        } catch {}
        return;
      }
      // 移除添加支付功能分支
    }

    // 🆕 主页授权到个人号（⚠️ 必须放在 assetType === 'adAccounts' 块之外：
    //    这个动作来自「主页列表」的批量菜单，之前被嵌在上面的 adAccounts 块里，
    //    主页列表点它永远走不到 → 屏幕上毫无反应）
    if (action === 'grantPersonalPage') {
      setAssignPersonalMode('page');
      setIsAssignPersonalOpen(true);
      return;
    }

    // 🆕 主页列表：发布 / 取消发布主页（⚠️ 同样必须放在 adAccounts 块之外）
    if (action === 'publish' || action === 'unpublish') {
      const target = action === 'publish';
      const rows = (sortedData as any[])
        .filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)))
        .map(item => ({ profileId: String(item.profileId || item.profile_id || ''), pageId: String(item[uniqueIdKey] || '') }))
        .filter(r => r.profileId && r.pageId);
      if (!rows.length) { alert('无法识别选中的主页（缺少配置ID或主页ID）'); return; }

      // 一个 item = 一个配置下的若干主页（同「授权到个人号」的分组方式）
      const byProfile = new Map<string, string[]>();
      rows.forEach(({ profileId, pageId }) => {
        const arr = byProfile.get(profileId) || [];
        if (!arr.includes(pageId)) arr.push(pageId);
        byProfile.set(profileId, arr);
      });
      const items = Array.from(byProfile).map(([pid, pageIds]) => ({
        key: pid,
        label: `配置 ${pid}（${pageIds.length} 个主页）`,
        payload: { profileId: pid, pageIds, publish: target },
      }));

      const label = target ? '发布主页' : '取消发布';
      const job = await submitQueueJob('publish_pages', `${label}（${rows.length} 个）`, items);
      if (job) {
        await waitForJob(job.id);
        // 乐观更新本地列表状态（FB 那边不会回写缓存，这里直接改，避免用户以为没生效）
        const nextStatus = target ? 'Published' : 'Unpublished';
        const updated = (pagesDb as any[]).map((pg: any) =>
          byProfile.get(String(pg.profileId || ''))?.includes(String(pg.pageId || ''))
            ? { ...pg, status: nextStatus, is_published: target ? 1 : 0 }
            : pg
        );
        setPagesDb(updated as any);
        try { localStorage.setItem('cache:pages', JSON.stringify(updated)); } catch {}
        alert(`${label}任务已在执行队列跑完`);
      }
      return;
    }

    // 🆕 BM 管理操作弹窗（独立于 assetType，BM 列表页和广告号页均可触发）
    if (action === 'openBmOps') {
      const selectedItems = (sortedData as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));
      const items = selectedItems.map((item: any) => ({
        profileId: String(item.profileId || item.profile_id || ''),
        bmId: String(item.bmId || item.businessId || item.id || ''),
        name: String(item.name || item.bmName || '')
      })).filter(i => i.bmId && i.profileId);
      if (items.length === 0) { alert('无法识别选中的 BM'); return; }
      setBmOperationsItems(items);
      setIsBMOperationsOpen(true);
      return;
    }

    // 🚀 复用核心流程：getInfo / fetchPixels / fetchPosts 共用
    // 「启动浏览器 + 抓数」交给本机服务端队列执行（见下方 runGetInfoFlow），
    // 前端只负责：提交任务、等队列跑完、把结果写回本地缓存与云端。
    // 不再 dispatch 'batch-asset-fetch' 事件，避免触发 ProfileManager 的 batchSaveAssets 造成重复/竞争；
    // ProfileManager 的配置列表数量更新由下方 batch-asset-fetch-completed 事件处理
    const runGetInfoFlow = async (stageLabel = '获取信息') => {
      const targetsProfileIds = Array.from(new Set(sortedData.filter((item: any) => selectedIds.has(selectionKeyOf(item, uniqueIdKey))).map((i: any) => String(i.profileId || i.profile_id || '')))).filter(Boolean);
      if (!targetsProfileIds.length) {
        alert('无法识别选中资产关联的浏览器配置 ID');
        return { ok: false, allFoundPixels: [] as any[] };
      }
      setBatchLoading(true);
      const allFoundPixels: any[] = [];
      // 🔐 本次每个配置探测到的登录状态（ok / relogged / invalid），跑完统一回写
      const loginStatusMap = new Map<string, string>();
      const stageTotal = targetsProfileIds.length;
      setBatchStage(`准备中（共 ${stageTotal} 个配置）…`);

      const failures: string[] = [];

      // 🚀 单个配置的抓取结果 → 写回 localStorage 缓存 + 同步云端（原 runOneProfile 里的落位逻辑，原样保留）
      const applyOneResult = (pid: string, res: any) => {
        if (res && res.loginStatus) loginStatusMap.set(pid, String(res.loginStatus));
        if (res && res.success && Array.isArray(res.pixels)) allFoundPixels.push(...res.pixels);
        if (!(res && res.success && Array.isArray(res.data))) return;
        try {
          writeFetchResultToCache(pid, res);
          // 🚀 更新 profiles 中的 token，立即刷新显示，无需等待服务器加载
          if (res.token && setProfiles) {
            setProfiles((prev: any[]) => prev.map((p: any) => String(p.id) === String(pid) ? { ...p, token: res.token } : p));
          }
          // 🚀 同时同步到云端，确保后续从服务器刷新时不会读空数据
          const authToken = token || localStorage.getItem('auth_token');
          if (authToken && res.data.length) {
            const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
            const flushD1 = (url: string, items: any[]) => {
              if (items.length) fetchWithTimeout(url, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body:JSON.stringify({items}) }, 60000, '同步到服务器').catch(()=>{});
            };
            // 🚀 计算像素计数映射（像素单独请求，不在 adAccount 上）
            const pxCountMap = new Map<string, number>();
            if (Array.isArray(res.pixels)) {
              res.pixels.forEach((px: any) => {
                const aid = String(px.account_id || '').replace(/^act_/, '');
                if (aid) pxCountMap.set(aid, (pxCountMap.get(aid) || 0) + 1);
              });
            }
            flushD1(`${sbase}/api/adaccounts/bulk-save`, res.data.map((a:any)=>({...a, profileId: pid, pixelsCount: pxCountMap.get(String(a.account_id || a.id || '').replace(/^act_/, '')) || 0})));
            if (Array.isArray(res.pages) && res.pages.length) flushD1(`${sbase}/api/pages/bulk-save`, res.pages);
            if (Array.isArray(res.bms) && res.bms.length) flushD1(`${sbase}/api/businesses/bulk-save`, res.bms.map((b:any)=>({...b,profileId:pid})));
            if (Array.isArray(res.pixels) && res.pixels.length) flushD1(`${sbase}/api/pixels/bulk-save`, res.pixels.map((p:any)=>({...p,profileId:pid})));
          }
        } catch {}
      };

      // 🧵「启动浏览器 + 抓数」交给本机服务端队列执行（与配置列表的「获取信息」同一套）：
      //    - 提交后即可刷新/切页/断网，任务在后端继续跑；进度与取消在左侧「执行队列」
      //    - 浏览器由队列按 borrow 借用、跑完立刻归还，不会把全局并发名额占满
      //    - 前端只保留「数据落位」：从后端取回抓取结果 → 写本地缓存 + 同步云端
      const items = targetsProfileIds.map((pid) => {
        const p = profiles.find(x => x.id === pid);
        const tok = p && typeof (p as any).token === 'string' ? (p as any).token : '';
        // 🩺 withAccountQuality：取数收尾（关浏览器之前）顺带读一次 Meta Account Quality，
        //    把 BM 自身是否被封/受限写进结果 → 「账号质量」列跟着获取信息一起更新。
        //    没有 BM 的配置后端会自动跳过（零耗时）；有 BM 的每个最多 ~51s（串行读页面）。
        return { key: String(pid), label: String(pid), payload: { profileId: String(pid), accessToken: tok || 'BROWSER', withEngagement: fetchEngagement, withAccountQuality: true } };
      });
      setBatchStage(`已提交到执行队列（共 ${items.length} 个配置），可在左侧「执行队列」查看进度…`);
      let jobId = '';
      try {
        const job = await submitJob({ type: 'get_info', title: `${stageLabel}（${items.length} 个配置）`, items });
        jobId = job.id;
      } catch (e: any) {
        setBatchLoading(false);
        setBatchStage('');
        alert(`提交执行队列失败：${e?.message || e}\n（请确认本机后端 9999 已启动）`);
        return { ok: false, allFoundPixels: [] as any[] };
      }
      const finished = await waitForJob(jobId, (j) => {
        if (!j) return;
        if (j.status === 'queued' || j.status === 'running') {
          setBatchStage(`执行队列进行中 ${j.done + j.fail}/${j.total}（成功 ${j.ok} · 失败 ${j.fail}）…`);
        } else if (j.status === 'cancelled') {
          setBatchStage('任务已在执行队列中被取消');
        }
      });
      if (finished && finished.status === 'cancelled') {
        setBatchLoading(false);
        setBatchStage('');
        alert('任务已在执行队列中被取消');
        return { ok: false, allFoundPixels: [] as any[] };
      }

      // 🪶 队列跑完 → 逐配置取回后端暂存的抓取结果并落位
      setBatchStage('队列已执行完，正在写回资产数据…');
      let okCount = 0;
      for (const pid of targetsProfileIds) {
        const res = await getLastAssets(pid);
        if (!res || res.success === false) { failures.push(`${pid}: 队列未取到抓取结果`); continue; }
        okCount++;
        applyOneResult(pid, res);
      }
      const failCount = targetsProfileIds.length - okCount;
      setBatchLoading(false);
      setBatchStage('');

      // 🔐 登录状态：本地立刻反映 + 落库（换设备/刷新后仍能看到哪个号掉线了）
      if (loginStatusMap.size > 0) {
        if (setProfiles) {
          setProfiles(prev => prev.map(p => loginStatusMap.has(String(p.id)) ? { ...p, loginStatus: loginStatusMap.get(String(p.id)) } : p));
        }
        try {
          const authToken = token || localStorage.getItem('auth_token');
          const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
          fetchWithTimeout(`${sbase}/api/profiles/update-login-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ items: Array.from(loginStatusMap).map(([id, loginStatus]) => ({ id, loginStatus })) })
          }, 30000, '回写登录状态').catch(() => {});
        } catch {}
      }

      // 🚀 本地缓存先出（秒显，避免"先闪 0/空"），随后再拉服务器对齐 —— 与刷新页面时的顺序一致
      //    ⚠️ 以前这里只有本地缓存那 4 个调用：服务端刚写好的那份（含国家/状态/时间等更全字段）根本不会被读回来，
      //       所以"获取信息"之后货币/国家/时区看着不更新，必须手动刷新页面才补齐。
      refreshAds();
      refreshAdAccounts();
      refreshPages();
      refreshBusinesses();
      // 🚀 服务器对齐（不 await：不阻塞弹窗；服务端返回空时会自行跳过覆盖）
      try {
        refreshAdsFromServer();
        refreshAdAccountsFromServer();
        refreshPagesFromServer();
        refreshBusinessesFromServer();
      } catch {}
      // 🚀 通知 ProfileManager 更新配置列表的 BM/Page 数量列
      try { window.dispatchEvent(new CustomEvent('batch-asset-fetch-completed', { detail: {} })); } catch {}
      // 🚀 通知贴文/对话列表与数量统计刷新（AssetViewer 列表、PageSocialViewers 联动）
      try {
        window.dispatchEvent(new Event('posts-refresh'));
        window.dispatchEvent(new Event('messages-refresh'));
        window.dispatchEvent(new Event('content-counts-refresh'));
      } catch {}
      return { ok: true, allFoundPixels, okCount, failCount, failures };
    };

    // 🚨 如实汇报：失败/超时不再被吞掉（以前无论成败都弹"同步完成"，看起来像卡死后又莫名成功）
    const reportResult = (r: { okCount: number; failCount: number; failures: string[] }, okMsg: string) => {
      if (r.failCount > 0) {
        const detail = r.failures.slice(0, 5).join('\n');
        alert(`${okMsg}\n成功 ${r.okCount}/${r.okCount + r.failCount}，失败 ${r.failCount}${detail ? `\n${detail}${r.failures.length > 5 ? `\n…还有 ${r.failures.length - 5} 条` : ''}` : ''}`);
      } else {
        alert(okMsg);
      }
    };

    if (action === 'fetchAssets' || action === 'getInfo') {
      const r = await runGetInfoFlow();
      if (!r.ok) return;
      reportResult(r, r.failCount > 0 ? '资产信息拉取完成（部分失败）' : '资产信息拉取与同步完成！');
      return;
    }
    if (action === 'fetchPixels') {
      const r = await runGetInfoFlow('获取像素');
      if (!r.ok) return;
      if (r.allFoundPixels.length > 0) {
        const pixelInfo = r.allFoundPixels.map(p => `${p.name || 'Unnamed'}: ${p.id}`).join('\n');
        alert(`像素同步完成！共找到 ${r.allFoundPixels.length} 个像素：\n\n${pixelInfo}`);
      } else {
        alert('像素同步完成，但未发现任何像素。');
      }
      if (r.failCount > 0) reportResult(r, '（有配置拉取失败）');
      return;
    }
    if (action === 'fetchPosts') {
      const r = await runGetInfoFlow('抓取贴文/对话');
      if (!r.ok) return;
      reportResult(r, r.failCount > 0 ? '贴文/对话拉取完成（部分失败）' : '贴文/对话拉取完成，数量已刷新！');
      return;
    }

    if (assetType === 'ads') {
      if (['activeAd', 'pauseAd', 'archiveAd', 'deleteAd'].includes(action)) {
        const fbAction = action === 'activeAd' ? 'start' : (action === 'pauseAd' ? 'stop' : (action === 'archiveAd' ? 'archive' : 'delete'));
        
        if (fbAction === 'delete') {
          const ok = window.confirm(`确定要永久删除选中的 ${selectedItems.length} 个资产吗？此操作不可撤销。`);
          if (!ok) return;
        }

        setBatchLoading(true);
        const tasks = selectedItems.map(item => {
          let endpoint = '';
          if (item.type === 'campaign') endpoint = 'campaigns';
          else if (item.type === 'adset') endpoint = 'adsets';
          else endpoint = 'ads';

          return fetch(`${lbase}/api/facebook/adaccounts/${endpoint}/manage`, { 
            method: 'POST', 
            headers: { 
              'Content-Type': 'application/json',
              'X-Api-Secret': LOCAL_SERVER_SECRET
            }, 
            body: JSON.stringify({ 
              profileId: String(item.profileId || item.profile_id), 
              assetId: String(item.id || item.adId), 
              action: fbAction 
            }) 
          }).then(r=>r.json()).catch(()=>({ success:false }));
        });

        await Promise.allSettled(tasks);
        setBatchLoading(false);
        
        // 🚀 核心改进：拉取资产后，同时刷新广告账户和广告列表
        await Promise.all([
          refreshAdAccountsFromServer(),
          refreshAdsFromServer()
        ]);
        
        // 弹出成功提示
        alert('获取信息同步完成！');
        return;
      }
    }
  };

  const toggleExpand = (id: string, e: any) => {
    e.stopPropagation();
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };

  // 🚀 贴文/对话数量列渲染：可点击彩色计数（主页按 page、广告号/BM 按 profile）
  const renderSocialCountBtn = (item: any, kind: 'posts' | 'messages') => {
    const isPages = assetType === 'pages';
    const profileKey = String(item.profile_id ?? item.profileId ?? '');
    if (!profileKey) return <span className="text-xs text-slate-600">-</span>;
    const bucket = isPages
      ? contentCounts.page[`${profileKey}|${String(item.page_id ?? item.pageId ?? '')}`]
      : contentCounts.profile[profileKey];
    const num = bucket ? (kind === 'posts' ? bucket.posts : bucket.messages) : 0;
    if (!num) {
      return (
        <span className="inline-flex items-center justify-center min-w-7 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-800/80 text-slate-500 select-none" title="暂无贴文/对话">0</span>
      );
    }
    const pageId = isPages ? String(item.page_id ?? item.pageId ?? '') : undefined;
    const pageName = isPages ? String(item.page_name ?? item.pageName ?? '') : undefined;
    const jump = () => {
      if (kind === 'posts') jumpToPosts({ profileId: profileKey, pageId, pageName });
      else jumpToMessages({ profileId: profileKey, pageId, pageName });
    };
    const colorCls = kind === 'posts'
      ? 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500 hover:text-white'
      : 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500 hover:text-white';
    const target = kind === 'posts' ? '贴文' : '对话';
    return (
      <button onClick={jump} title={`查看${target}（${profileKey}${isPages ? ` | ${item.page_name ?? item.pageName ?? ''}` : ''}）`}
        className={`inline-flex items-center justify-center min-w-7 px-2 py-0.5 rounded-full text-xs font-semibold transition-colors cursor-pointer ${colorCls}`}>
        {num}
      </button>
    );
  };

  // 🚀 主页「AI 全自动值守」开关：将该主页当前+未来所有对话自动纳入 AI 持续监听
  const renderPageWatchBtn = (item: any) => {
    if (assetType !== 'pages') return null;
    const pid = String(item.profileId ?? item.profile_id ?? '');
    const pgId = String(item.pageId ?? item.page_id ?? '');
    if (!pid || !pgId) return <span className="text-xs text-slate-600">-</span>;
    const on = watchIsPageWatching(pid, pgId);
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (on) {
            watchRemovePage(pid, pgId);
          } else {
            if (!window.confirm('将该主页加入「AI 全自动值守」？\n\n该主页当前已同步及之后新出现的所有 Messenger 对话都会被持续监听；检测到客户发来新消息时，将按「提示词设置」用 AI 生成回复自动发送。\n\n注意：需本机 PUP 服务器(9999)在运行且该配置浏览器保持登录。')) return;
            watchAddPage(pid, pgId, String(item.pageName ?? item.page_name ?? ''));
          }
        }}
        title={on ? '值守中：正在监听该主页全部对话（点击停止）' : '将该主页加入 AI 全自动值守（监听全部对话智能回复）'}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs whitespace-nowrap ${on ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30' : 'bg-slate-700/60 border-slate-600 text-slate-300 hover:bg-slate-600 hover:text-white'}`}
      >
        <BellRing className="w-3.5 h-3.5" /> {on ? '值守中' : '监听主页'}
      </button>
    );
  };

  // 📧 BM 邀请链接：按「配置ID::BM ID」记录正在生成中的行（一键自动：生成邮箱→邀请→收信→提取链接）
  const [inviteBusy, setInviteBusy] = useState<Set<string>>(new Set());

  const handleGenerateInvite = async (row: any) => {
    const pid = String(row.profileId || row.profile_id || '');
    const bid = String(row.bmId || row.businessId || row.business_id || row.id || '');
    if (!pid || !bid) { alert('该行缺少 配置ID / BM ID，无法发起邀请'); return; }
    const key = `${pid}::${bid}`;
    const lbase = getLaunchServerUrl().replace(/\/$/, '');
    setInviteBusy(prev => new Set(prev).add(key));
    try {
      const resp = await fetch(`${lbase}/api/facebook/business/invite-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: pid, businessId: bid, role: 'employee' })
      });
      const j = await resp.json().catch(() => null);
      if (!j || j.success === false) {
        alert(`BM 邀请失败：${(j && j.message) || '未知错误'}`);
        return;
      }
      if (j.linkPending) {
        alert(j.message || '邀请已发出，但暂未收到邀请邮件链接');
        return;
      }
      // 更新界面状态 + 本地缓存（云端持久化由本地服务端已完成）
      const applyRow = (r: any) =>
        String(r.profileId || r.profile_id || '') === pid && String(r.bmId || r.businessId || r.business_id || r.id || '') === bid
          ? { ...r, inviteEmail: j.email, inviteLink: j.inviteLink, invitedAt: new Date().toISOString() }
          : r;
      setBusinessesDb(prev => prev.map(applyRow));
      try {
        const raw = localStorage.getItem('cache:businesses');
        const arr = raw ? JSON.parse(raw) : [];
        const next = (Array.isArray(arr) ? arr : []).map((r: any) =>
          String(r.profileId || r.profile_id || '') === pid && String(r.businessId || r.business_id || r.id || '') === bid
            ? { ...r, invite_email: j.email, invite_link: j.inviteLink, invited_at: new Date().toISOString() }
            : r
        );
        localStorage.setItem('cache:businesses', JSON.stringify(next));
      } catch {}
      alert(`邀请链接已生成（${j.email}），已写入 BM 数据`);
    } catch (e: any) {
      alert(`BM 邀请请求失败：${(e && e.message) || e}`);
    } finally {
      setInviteBusy(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  // 📧 邀请链接单元格：已有链接 → 邮箱+链接+复制；没有 → 「生成邀请链接」按钮
  const renderInviteLinkCell = (item: any) => {
    const link = String(item.inviteLink || '');
    const email = String(item.inviteEmail || item.invite_email || '');
    const key = `${item.profileId || item.profile_id || ''}::${item.bmId || item.businessId || item.id || ''}`;
    const busy = inviteBusy.has(key);
    if (!link) {
      return busy ? (
        <span className="text-xs text-indigo-300 inline-flex items-center gap-1 whitespace-nowrap">
          <Loader2 className="w-3 h-3 animate-spin" /> 生成中（约1分钟）…
        </span>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); handleGenerateInvite(item); }}
          title="自动生成临时邮箱并邀请加入该 BM，收信后提取邀请链接"
          className="text-xs px-2 py-1 rounded-md bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/30 whitespace-nowrap"
        >
          生成邀请链接
        </button>
      );
    }
    return (
      <div className="flex flex-col gap-1 max-w-[240px]" onClick={(e) => e.stopPropagation()}>
        {email && <span className="text-[10px] text-slate-500 truncate" title={email}>{email}</span>}
        <div className="flex items-center gap-1">
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            title={link}
            className="text-[11px] font-mono text-indigo-300 hover:underline truncate flex-1 min-w-0"
          >
            {link}
          </a>
          <InviteCopyBtn link={link} />
        </div>
      </div>
    );
  };

  const renderCell = (item: any, accessor: string) => {
    const value = item[accessor];

    // 📧 邀请链接列（BM 列表专用）
    if (accessor === 'inviteLink') {
      return renderInviteLinkCell(item);
    }

    // 🚀 时间列统一格式化
    if (accessor === 'updated_at') {
      if (!value) return <span className="text-xs text-slate-500">-</span>;
      const d = new Date(value);
      if (isNaN(d.getTime())) return <span className="text-xs font-mono text-slate-400">{value}</span>;
      const now = new Date();
      const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
      const formatted = d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      if (diffDays <= 0) return <span className="text-xs text-emerald-400">{formatted}</span>;
      if (diffDays <= 7) return <span className="text-xs text-slate-300">{formatted}</span>;
      return <span className="text-xs text-slate-400">{formatted}</span>;
    }

    // 🚀 Token 列：截断显示，鼠标悬停看全文
    if (accessor === 'tokenValue') {
      if (!value) return <span className="text-xs text-slate-600">-</span>;
      const short = String(value).substring(0, 30);
      return (
        <div className="group relative">
          <span className="text-xs font-mono text-slate-400 cursor-default">{short}...</span>
          <div className="absolute left-0 bottom-full mb-1 bg-slate-950 border border-slate-700 rounded-lg p-2 shadow-xl z-10 hidden group-hover:block whitespace-normal break-all max-w-[300px]">
            <span className="text-xs text-slate-300">{value}</span>
          </div>
        </div>
      );
    }

    // 🚀 备注列：支持快速编辑
    if (accessor === 'notes') {
      return (
        <div className="group flex items-center gap-1 max-w-[180px]">
          <span className="text-xs text-slate-400 truncate flex-1 min-w-0" title={value || ''}>
            {value || <span className="text-slate-600">-</span>}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); setInlineNotesEdit({ id: item.id || item.adAccountId, notes: value || '' }); }}
            className="p-1 text-slate-600 hover:text-white hover:bg-slate-800 rounded opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
            title="编辑备注"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
        </div>
      );
    }

    // 🔐 登录状态列：行上未必带这个字段（广告号/主页/BM 都是挂在某个浏览器配置下的），
    //    统一按 profileId 反查 profiles 拿最新状态，避免各处重复维护
    if (accessor === 'loginStatus') {
      const pid = String(item.profileId ?? item.profile_id ?? '');
      const rowStatus = item.loginStatus ?? profiles.find(p => String(p.id) === pid)?.loginStatus;
      const v = loginStatusView(rowStatus);
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-xs whitespace-nowrap ${v.className}`}>
          {v.label}
        </span>
      );
    }

    if (assetType === 'ads') {
        if (accessor === 'hierarchy') {
            const isExpanded = expandedIds.has(item.uniqueKey);
            const hasChildren = item.type !== 'ad';
            const depth = item.depth || 0;
            
            return (
                <div className="flex items-center" style={{ paddingLeft: `${depth * 24}px` }}>
                    {hasChildren ? (
                        <button onClick={(e) => toggleExpand(item.uniqueKey, e)} className="p-1 hover:bg-slate-800 rounded transition-colors mr-1">
                            {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                        </button>
                    ) : (
                        <div className="w-6 h-6 mr-1 flex items-center justify-center">
                             <div className="w-1.5 h-1.5 rounded-full bg-slate-600"></div>
                        </div>
                    )}
                    <div className="flex items-center gap-2 truncate">
                        {item.type === 'campaign' && <Layers className="w-4 h-4 text-indigo-400" />}
                        {item.type === 'adset' && <Settings className="w-4 h-4 text-emerald-400" />}
                        {item.type === 'ad' && <Image className="w-4 h-4 text-amber-400" />}
                        <span className={`text-sm ${item.type === 'campaign' ? 'font-bold text-white' : (item.type === 'adset' ? 'font-medium text-slate-200' : 'text-slate-300')}`}>
                            {item.type === 'ad' ? (item.adName || item.name) : item.name}
                        </span>
                    </div>
                </div>
            );
        }

        if (accessor === 'details') {
            if (item.type === 'adset' && item.targeting) {
                try {
                    const t = typeof item.targeting === 'string' ? JSON.parse(item.targeting) : item.targeting;
                    const countries = t.geo_locations?.countries?.join(', ') || '';
                    const age = `${t.age_min || ''}-${t.age_max || ''}`;
                    return <span className="text-xs text-slate-500 truncate block max-w-[200px]" title={JSON.stringify(t)}>{countries} | 年龄: {age}</span>;
                } catch { return null; }
            }
            if (item.type === 'ad') {
                 const c = item.creativeJson ? (typeof item.creativeJson === 'string' ? JSON.parse(item.creativeJson) : item.creativeJson) : null;
                 const previewUrl = item.previewUrl || c?.thumbnail_url;
                 const postMsg = c?.object_story_spec?.link_data?.message || c?.object_story_spec?.link_data?.name || '';
                 const postId = c?.effective_object_story_id;
                 
                 return (
                     <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                             {previewUrl && <img src={previewUrl} className="w-8 h-8 rounded border border-slate-700 object-cover bg-slate-800" alt="preview" />}
                             <div className="flex flex-col">
                                 {postMsg && <span className="text-xs text-slate-300 truncate max-w-[150px]" title={postMsg}>{postMsg}</span>}
                                 <span className="text-[10px] text-slate-500 font-mono">ID: {item.adId}</span>
                             </div>
                        </div>
                        {postId && (
                            <a 
                                href={`https://www.facebook.com/${postId}`} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-[10px] text-indigo-400 hover:underline"
                                onClick={e => e.stopPropagation()}
                            >
                                查看贴文
                            </a>
                        )}
                     </div>
                 );
             }
            return null;
        }
    }
    if (assetType === 'adAccounts' && accessor === 'actions') {
      const pid = String(item.profileId || item.profile_id || item.pid || item.profile || '');
      const prof = profiles.find(pr => pr.id === pid);
      const isRunning = !!prof && prof.status === BrowserStatus.RUNNING;
      return (
        <div className="flex items-center gap-2">
          <button onClick={(e) => { e.stopPropagation(); rowToggleStatus(pid); }} className={`${isRunning ? 'bg-rose-900/20 text-rose-400 hover:bg-rose-900/40' : 'bg-emerald-900/20 text-emerald-400 hover:bg-emerald-900/40'} p-2 rounded-lg transition-colors`} title={isRunning ? '停止浏览器' : '启动浏览器'}>
            {isRunning ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
          </button>
          <button onClick={(e) => { e.stopPropagation(); rowEditProfile(pid); }} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors" title="编辑配置">
            <Pencil className="w-4 h-4" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); rowGetAndSaveTokens(pid); }} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors" title="获取TOKEN并保存">
            <Wallet className="w-4 h-4" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); rowCheckLoginStatus(pid); }} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors" title="检查登录状态">
            <ShieldCheck className="w-4 h-4" />
          </button>
        </div>
      );
    }
    
    if (accessor === 'adAccountStatus') {
        const code = Number(value);
        const statusColor = getAdAccountStatusCodeColor(code);
        if (statusColor) {
          return (
            <span className="inline-flex items-center">
              <span className={`inline-block w-2 h-2 rounded-full bg-${statusColor}-500`}></span>
            </span>
          );
        }
    }

    // 🏢 BM 列表的「BM状态」列：优先显示**BM 自身**的真实状态
    //    （内部 GraphQL advertising_restriction_info → 正常/受限/已停用；没有广告号也能显示）。
    //    没探测过的 BM 才回退到「按名下广告号汇总」的旧逻辑。
    if (accessor === 'bmStatus') {
        const aq = String(item?.aqStatus || '');
        if (aq) {
            const acfg = aq === 'active' ? { cls: 'bg-emerald-900/30 text-emerald-400 border-emerald-800', label: '正常' }
                : aq === 'restricted' ? { cls: 'bg-amber-900/30 text-amber-400 border-amber-800', label: '受限' }
                : aq === 'disabled' ? { cls: 'bg-rose-900/40 text-rose-300 border-rose-700', label: '已停用' }
                // not_found = 该身份看不到这个 BM（多半不是管理员）→ 明确说「无权限」，不猜成正常
                : aq === 'not_found' ? { cls: 'bg-slate-800 text-slate-500 border-slate-700', label: '无权限查询' }
                : aq === 'no_login' ? { cls: 'bg-slate-800 text-slate-500 border-slate-700', label: '未登录' }
                : { cls: 'bg-slate-800 text-slate-500 border-slate-700', label: '无法判定' };
            const atip = [item?.aqEvidence, item?.aqPolicy].filter(Boolean).join('\n');
            return (
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${acfg.cls}`}
                  title={atip ? `BM 自身状态：${atip}` : 'BM 自身状态（内部 GraphQL 探测）'}
                >
                  {acfg.label}
                </span>
            );
        }
        const kind = String(value || 'none');
        const cfg = kind === 'normal' ? { cls: 'bg-emerald-900/30 text-emerald-400 border-emerald-800', label: '正常' }
            : kind === 'partial' ? { cls: 'bg-amber-900/30 text-amber-400 border-amber-800', label: '部分受限' }
            : kind === 'warn' ? { cls: 'bg-amber-900/30 text-amber-400 border-amber-800', label: '部分异常' }
            : kind === 'bm_risk' ? { cls: 'bg-rose-900/40 text-rose-300 border-rose-700', label: 'BM 牵连' }
            : kind === 'restricted' ? { cls: 'bg-rose-900/30 text-rose-400 border-rose-800', label: '全部受限' }
            : { cls: 'bg-slate-800 text-slate-500 border-slate-700', label: '—' };
        return (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.cls}`}
              title={item?.bmStatusDetail || ''}
            >
              {cfg.label}
            </span>
        );
    }

    // 🩺 BM 列表的「管理员(权限)」列：该 BM 下的成员（邮箱 + 角色/权限）。
    //    数据来自 Graph 的 business_users{id,name,email,role,active_status}（见服务端 bmsUrl）。
    if (accessor === 'bmUsers') {
        const users: any[] = Array.isArray(item?.bmUsers) ? item.bmUsers : [];
        if (!users.length) return <span className="text-slate-600">—</span>;
        const labelOf = (u: any) => {
            const email = String(u?.email || u?.pending_email || '');
            const name = String(u?.name || '');
            const who = email || name || String(u?.id || '');
            const role = String(u?.role || '').toUpperCase();
            const status = String(u?.active_status || u?.status || '').toUpperCase();
            const tag = role === 'ADMIN' ? '管理员' : role === 'EMPLOYEE' ? '员工' : (role || '—');
            const pending = status && status !== 'ACTIVE' ? `·${status === 'INVITED' ? '待接受' : status}` : '';
            return { who, tag, pending };
        };
        // 🩺 全部列出（不截断、不隐藏）：管理员排前面，其次员工，最后待接受
        const rank = (u: any) => {
          const role = String(u?.role || '').toUpperCase();
          const status = String(u?.active_status || u?.status || '').toUpperCase();
          if (status && status !== 'ACTIVE') return 2;
          return role === 'ADMIN' ? 0 : 1;
        };
        const sorted = [...users].sort((a, b) => rank(a) - rank(b));
        const line = sorted.map(u => { const l = labelOf(u); return `${l.who}（${l.tag}${l.pending}）`; }).join('、');
        return (
            <span className="text-xs text-slate-300 whitespace-normal break-words">{line}</span>
        );
    }

    // 🕒 BM 列表的「创建时间」列：Graph Business.creation_time（可能是 ISO 字符串或 unix 秒）
    if (accessor === 'fbCreatedTime') {
        const v = String(value || '');
        if (!v) return <span className="text-slate-600">—</span>;
        let shown = v;
        // Graph 返回形如 "2025-01-09T02:49:57+0000"（时区无冒号）→ 补冒号再解析，兼容性更好
        const norm = v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
        const d = new Date(/^\d{9,}$/.test(v) ? Number(v) * 1000 : norm);
        if (!isNaN(d.getTime())) {
            const p = (n: number) => String(n).padStart(2, '0');
            shown = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        }
        return <span className="text-xs text-slate-300 whitespace-nowrap" title={v}>{shown}</span>;
    }

    // 🔢 BM 列表的「可创建广告号上限」列：内部 GraphQL ad_account_creation_limit
    if (accessor === 'adAccountLimit') {
        const v = String(value ?? '');
        if (v === '') return <span className="text-slate-600">—</span>;
        return <span className="text-xs text-slate-300 whitespace-nowrap" title="Business Settings → 商家資訊 → 廣告帳號建立上限">{v}</span>;
    }

    // 🩺 BM 列表的「停用原因」列：该 BM 名下被停用广告号的 disable_reason 汇总
    if (accessor === 'bmDisableReason') {
        const txt = String(value || '');
        if (!txt) return <span className="text-slate-600">—</span>;
        // 含 BM 牵连原因（bm_risk）时用红字，纯广告号维度用常规灰字
        const isBmRisk = String(item?.bmStatus || '') === 'bm_risk';
        return (
            <span className={`text-xs ${isBmRisk ? 'text-rose-300' : 'text-slate-400'}`} title={item?.bmStatusDetail || ''}>
              {txt}
            </span>
        );
    }

    // 🛡️ 主页列表的「账号权限」列：该配置的账号在这个主页上是管理员 / 有部分权限 / 无角色
    if (accessor === 'adminRight') {
        const state = String(value || 'unknown');
        const cfg = state === 'admin' ? { cls: 'bg-emerald-900/30 text-emerald-400 border-emerald-800', label: '管理员' }
            : state === 'member' ? { cls: 'bg-amber-900/30 text-amber-400 border-amber-800', label: '部分权限' }
            : state === 'none' ? { cls: 'bg-rose-900/30 text-rose-400 border-rose-800', label: '无角色' }
            : state === 'pending' ? { cls: 'bg-slate-800 text-slate-400 border-slate-700', label: '检测中…' }
            : { cls: 'bg-slate-800 text-slate-500 border-slate-700', label: '—' };
        return (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.cls}`}
              title="该配置的账号在这个主页上的角色（取自 Graph API me/accounts）。注意：列表里是「老式主页 ID」，切身份/发邀请用的是「新式 profile ID」，两者不一定相同。"
            >
              {cfg.label}
            </span>
        );
    }

    if (accessor === 'status' || accessor === 'adAccountStatus' || accessor === 'verificationStatus') {
        const statusConfig = getStatusBadgeConfig(String(value));
        const label = statusConfig.i18nKey ? t(statusConfig.i18nKey) : statusConfig.fallback;
        const colorClasses = `bg-${statusConfig.color}-900/30 text-${statusConfig.color}-400 border-${statusConfig.color}-800`;
        const Icon = statusConfig.icon;
        return (
             <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colorClasses}`}>
                <Icon className="w-3 h-3 mr-1"/> {label}
            </span>
        );
    }
    
    if (accessor === 'payment') {
        const paymentStatus = item.paymentStatus;
        return (
             <div className="flex flex-col gap-1">
                {paymentStatus === 'Active' && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-900/30 text-emerald-400 border border-emerald-800"><Wallet className="w-3 h-3 mr-1" /> Active</span>}
                {paymentStatus === 'Failed' && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-900/30 text-rose-400 border border-rose-800"><Wallet className="w-3 h-3 mr-1" /> Failed</span>}
                {item.currency && (
                    <span className="text-xs text-slate-400 font-mono">{item.country} / {item.currency}</span>
                )}
            </div>
        );
    }
    
    if (accessor === 'likes' || accessor === 'spend' || accessor === 'spendCap' || accessor === 'balance' || accessor === 'threshold' || accessor === 'creditLimit') {
        const num = Number(value || 0);
        // 🚀 货币列自动判断：如果有 item.currency 则用该货币符号
        const currencySymbol = item.currency === 'USD' ? '$' : 
          item.currency === 'CNY' ? '¥' : 
          item.currency === 'EUR' ? '€' : 
          item.currency === 'VND' ? '₫' : 
          item.currency === 'TWD' ? 'NT$' :
          item.currency ? `${item.currency} ` : '$';
        
        if (accessor === 'balance' && num > 0) {
          // 🚀 账单列加 CSV 下载按钮
          return (
            <div className="flex items-center gap-1">
              <span className="font-mono">{currencySymbol}{new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num)}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open('https://business.facebook.com/billing_hub/payment_settings/?placement=ads_manager&asset_id=${actId}', '_blank');
                }}
                className="text-[10px] text-indigo-500 hover:text-indigo-300 underline ml-1"
                title="在 Facebook Billing Hub 查看和下载原始账单"
              >国家账单</button>
            </div>
          );
        }
        
        return <span className="font-mono">{currencySymbol}{new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num)}</span>
    }
    
    // 🚀 pagesCount 必须优先处理（可点击进入 pages 列表），否则被下方通用 catch-all 拦截
    if (accessor === 'pagesCount') {
        const pid = String(item.profileId || '');
        const profileName = String(item.profileName || '');
        const count = Number(value ?? 0);
        const openPages = () => {
          if (count === 0) return;
          const filterData = { profileId: pid, profileName };
          try { localStorage.setItem('pagesFilter', JSON.stringify(filterData)); } catch {}
          try { (window as any).setActiveTab && (window as any).setActiveTab('meta-pages'); } catch {}
          window.dispatchEvent(new CustomEvent('pages-filter', { detail: filterData }));
          window.dispatchEvent(new Event('pages-refresh'));
        };
        return (
          <button onClick={openPages} className={`font-mono ${count > 0 ? 'text-indigo-400 hover:text-indigo-300 underline' : 'text-slate-500 cursor-default'}`}>
            {count}
          </button>
        );
    }
    
    if (accessor === 'pagesCount' || accessor === 'bmCount' || accessor === 'paymentCount' || accessor === 'adsCount' || accessor === 'pixelsCount') {
        if (accessor === 'paymentCount') {
          // 🚀 从 fundingSource 提取卡片类型显示
          const fs = String(item.fundingSource || item.funding_source || item.paymentInfo || '');
          if (fs) {
            // 提取卡片类型：从 "1234 (TYPE)" 或 JSON 中提取
            const typeMatch = fs.match(/\((\w+)\)/);
            const typeName = typeMatch ? typeMatch[1] : '';
            const lastFour = fs.match(/\d{4}/)?.[0];
            const displayType = 
              typeName === 'CREDIT_CARD' ? '信用卡' :
              typeName === 'DEBIT_CARD' ? '借记卡' :
              typeName === 'ATM_CARD' ? '储蓄卡' :
              typeName === 'PREPAID' ? '预付卡' :
              typeName === 'ACH' || typeName === 'CHECKING' || typeName === 'SAVINGS' ? '银行账户' :
              typeName === 'DIRECT_DEBIT' ? '直接借记' :
              typeName || '卡片';
            return (
              <span className="font-mono text-emerald-400" title={fs}>
                {lastFour ? `*${lastFour} ` : ''}{displayType}
              </span>
            );
          }
          return <span className="text-slate-500">-</span>;
        }
        
        // 🚀 复用 ProfileManager 方式：从 profiles 状态获取真实的主页/像素/BM 数量
        const pid = String(item.profileId || item.profile_id || '');
        const prof = profiles.find(p => String(p.id) === pid);
        const profilePages = prof?.assets?.pagesCount || 0;
        const profilePixels = prof?.assets?.pixelsCount || 0;
        const profileBm = prof?.assets?.bmCount || 0;
        
        if (accessor === 'pagesCount') {
          const count = profilePages || Number(item.pagesCount ?? item.pages_count ?? 0);
          if (count > 0) {
            return (
              <button
                className="font-mono text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                onClick={() => {
                  try { localStorage.setItem('pages:searchPrefill', pid); } catch {}
                  try { (window as any).setActiveTab && (window as any).setActiveTab('meta-pages'); } catch {}
                }}
                title="点击查看该配置的主页列表"
              >
                {count}
              </button>
            );
          }
          return <span className="font-mono">{count}</span>;
        }
        
        // 🚀 核心改进：像素数量支持点击弹窗显示详细 ID
        if (accessor === 'pixelsCount') {
          const count = profilePixels || Number(item.pixelsCount ?? item.pixels_count ?? 0);
          if (count > 0) {
            const onClickPixels = async (e: React.MouseEvent) => {
              e.stopPropagation();
              const actId = String(item.adAccountId || '').replace('act_', '');
              if (!actId) return;
              try {
                const authToken = token || localStorage.getItem('auth_token');
                const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
                const resp = await fetch(`${sbase}/api/pixels?accountId=${actId}`, {
                  headers: { 'Authorization': `Bearer ${authToken}` }
                });
                const json = await resp.json();
                if (json.success && Array.isArray(json.data) && json.data.length > 0) {
                  const pixelInfo = json.data.map((p: any) => `${p.name || 'Unnamed'}: ${p.pixel_id || p.id}`).join('\n');
                  alert(`关联像素详情：\n\n${pixelInfo}\n\n(提示：您可以在“资产拉取”中获取最新像素状态)`);
                } else {
                  alert('暂无像素详细 ID，请先执行“获取信息”或“获取像素”操作。');
                }
              } catch (err) {
                alert('获取像素详情失败，请检查网络连接。');
              }
            };
            return (
              <button 
                onClick={onClickPixels}
                className="font-mono text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                title="点击查看像素详情"
              >
                {count}
              </button>
            );
          }
          return <span className="font-mono">{count}</span>;
        }
        
        if (accessor === 'bmCount') {
          const count = profileBm || Number(item.bmCount ?? item.bm_count ?? 0);
          const pid = String(item.profileId || item.profile_id || '');
          const rowId = String(item.adAccountId || item.id || '');
          const isExpanded = expandedIds.has(rowId);
          if (count > 0) {
            return (
              <span className="font-mono">
                <button
                  className="text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = new Set(expandedIds);
                    if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
                    setExpandedIds(next);
                  }}
                  title={isExpanded ? '收起BM列表' : '点击查看BM ID'}
                >
                  {count}
                </button>
                {isExpanded && (() => {
                  const bmIds = businessesDb.filter(b => String(b.profileId) === pid).map(b => b.bmId).filter(Boolean);
                  const uniqueBmIds = [...new Set(bmIds)];
                  return uniqueBmIds.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {uniqueBmIds.map((bmId, i) => (
                        <button
                          key={i}
                          onClick={(e) => {
                            e.stopPropagation();
                            try { localStorage.setItem('bmSearchPrefill', bmId); } catch {}
                            try { setExpandedIds(new Set()); } catch {}
                            try { (window as any).setActiveTab && (window as any).setActiveTab('meta-bms'); } catch {}
                          }}
                          className="text-[10px] font-mono text-indigo-400 hover:text-indigo-300 hover:underline bg-indigo-500/10 px-1.5 py-0.5 rounded"
                          title="点击跳转BM列表筛选"
                        >
                          {bmId}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-slate-500 mt-1">无BM ID</div>
                  );
                })()}
              </span>
            );
          }
          return <span className="font-mono">{count}</span>;
        }

        return <span className="font-mono">{value ?? 0}</span>
    }

    if (accessor === 'adAccountId') {
      return (
        <a
          href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${value}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-indigo-400 hover:text-indigo-300 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {value}
        </a>
      );
    }

    if (accessor === 'profileName') {
        const pid = String(item.profileId || item.profile_id || '');
        const prof = profiles.find(pr => String(pr.id) === pid);
        const nameDisplay = (value !== t('status.unnamed') && value) ? value : (prof?.name || item.profileName || item.profile_name || (pid ? `Profile ${pid}` : '') || t('status.unnamed'));
        return (
          <button
            className="text-indigo-400 hover:text-indigo-300 hover:underline text-left font-medium"
            onClick={() => {
              if (!pid) return;
              try { (window as any).setActiveTab && (window as any).setActiveTab('meta-profiles'); } catch {}
              try { window.dispatchEvent(new CustomEvent('open-profile-edit', { detail: { profileId: pid } })); } catch {}
            }}
          >
            {nameDisplay}
          </button>
        );
    }
    if (accessor === 'account') {
        const pid = String(item.profileId || item.profile_id || '');
        const prof = profiles.find(pr => String(pr.id) === pid);
        const nameDisplay = (
          (prof?.account?.name) || (prof?.account?.email) || item.account || item.account_name || [item.firstName, item.lastName].filter(Boolean).join(' ') || (prof?.name) || (item.adAccountName) || t('status.unknown')
        );
        return (
          <button
            className="text-indigo-400 hover:text-indigo-300 hover:underline text-left font-medium"
            onClick={() => {
              if (!pid) return;
              try { (window as any).setActiveTab && (window as any).setActiveTab('meta-profiles'); } catch {}
              try { window.dispatchEvent(new CustomEvent('open-profile-edit', { detail: { profileId: pid } })); } catch {}
            }}
          >
            {nameDisplay}
          </button>
        );
    }
    if (accessor === 'profileId') {
        const pid = String(item.profileId || item.profile_id || '');
        const isAdAccountView = assetType === 'adAccounts';
        const isBmView = assetType === 'bms';
        return (
          <div className="flex flex-col leading-tight">
            <button
              className={`${isAdAccountView ? 'text-emerald-400 hover:text-emerald-300' : 'text-indigo-400 hover:text-indigo-300'} hover:underline text-left font-mono font-bold text-base`}
              onClick={() => {
                if (!pid) return;
                if (isBmView) {
                  // BM 列表 → 配置列表，按配置ID**筛选**（以前走的是 open-profile-edit，弹的是编辑窗，不是筛选）
                  try { localStorage.setItem('browserConfig:searchPrefill', pid); } catch {}
                  try { (window as any).setActiveTab && (window as any).setActiveTab('meta-profiles'); } catch {}
                  try { window.dispatchEvent(new Event('browser-config-prefill')); } catch {}
                } else if (isAdAccountView) {
                  // 广告账号列表 → 跳转浏览器配置列表，筛选该ID
                  try { localStorage.setItem('browserConfig:searchPrefill', pid); } catch {}
                  try { (window as any).setActiveTab && (window as any).setActiveTab('meta-profiles'); } catch {}
                  try { window.dispatchEvent(new CustomEvent('open-profile-edit', { detail: { profileId: pid } })); } catch {}
                } else {
                  try { (window as any).setActiveTab && (window as any).setActiveTab('meta-profiles'); } catch {}
                  try { window.dispatchEvent(new CustomEvent('open-profile-edit', { detail: { profileId: pid } })); } catch {}
                }
              }}
            >
              {pid || '??'}
            </button>
          </div>
        );
    }
    if (accessor === 'timezone_id') {
        // 🚀 广告号列表的时区来自 ad_accounts 表 timezone_id 字段
        //    统一成「名称+偏移」格式（历史数据里有 "136" 这种纯数字FB时区ID）
        const tz = formatTimezoneValue(value);
        if (!tz) return <span className="text-slate-500">-</span>;
        // 高亮偏移量部分
        const offsetMatch = tz.match(/([+-]\d+(?:\.\d+)?)$/);
        if (offsetMatch) {
          const offset = offsetMatch[1];
          const name = tz.slice(0, tz.length - offset.length);
          // 名称本身就是 UTC/GMT 时不重复显示
          if (!name || /^(UTC|GMT|UCT)$/i.test(name)) return <span className="font-mono text-amber-400">{`UTC${offset}`}</span>;
          return <span className="font-mono">{name}<span className="text-amber-400">{`UTC${offset}`}</span></span>;
        }
        return <span className="font-mono">{tz}</span>;
    }
    if (accessor === 'fundingSource') {
        const text = String(value || '');
        if (!text) return <span className="text-slate-500">-</span>;
        // 格式: "1234 (TYPE)" 或 JSON
        if (text.startsWith('{')) {
            try {
                const obj = JSON.parse(text);
                const last4 = (obj.display_string || '').match(/\d{4}/)?.[0];
                const type = obj.type || '';
                return <span className="font-mono text-emerald-400">{last4 ? `*${last4}` : 'Active'}{type ? ` (${type})` : ''}</span>;
            } catch { return <span className="font-mono">{text}</span>; }
        }
        const match = text.match(/^(\d{4})\s*\((.+)\)$/);
        if (match) return <span className="font-mono text-emerald-400">*{match[1]} <span className="text-slate-500">{match[2]}</span></span>;
        const numOnly = text.match(/^(\d{4})/);
        if (numOnly) return <span className="font-mono text-emerald-400">*{numOnly[1]}</span>;
        return <span className="font-mono text-emerald-400">{text}</span>;
    }
    if (accessor === 'pixelsCount') {
        const count = Number(value ?? 0);
        return <span className={`font-mono ${count > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>{count}</span>;
    }
    if (accessor === 'adsCount') {
        const act = String(item.adAccountId || '');
        const pid = String(item.profileId || '');
        const openAds = () => {
          try { localStorage.setItem('adsFilter', JSON.stringify({ profileId: pid, adAccountId: act })); } catch {}
          window.dispatchEvent(new CustomEvent('open-ads-list', { detail: { profileId: pid, adAccountId: act } }));
          try { (window as any).setActiveTab && (window as any).setActiveTab('meta-ads'); } catch {}
        };
        return (
          <button onClick={openAds} className="text-indigo-400 hover:text-indigo-300 underline font-mono">
            {value ?? 0}
          </button>
        );
    }
    if (accessor === 'adAccountId') {
        const onClick = async () => {
          const pid = String(item.profileId || '');
          const act = String(item.adAccountId || '');
          if (!pid || !act) return;
          setLimitsLoading(true);
          setLimitsError('');
          try {
            const url = `/api/facebook/account-limits?profileId=${encodeURIComponent(pid)}&accountId=${encodeURIComponent(act)}`;
            const resp = await fetch(url);
            const json = await resp.json();
            const data = json && json.data ? json.data : null;
            if (!data) {
              setLimitsError('未获取到限额信息');
            } else {
              const next = { ...item };
              next.currency = String(data.currency || next.currency || '');
              next.timezone_id = String(data.timezone_id || next.timezone_id || '');
              next.spendCap = Number(data.spend_cap || next.spendCap || 0);
              next.spend = Number(data.amount_spent || next.spend || 0);
              setSelectedItem(next);
              setAssetsResult(null);
              setIsDetailsOpen(true);
            }
          } catch {
            setLimitsError('网络错误');
          } finally {
            setLimitsLoading(false);
          }
        };
        return (
          <button onClick={onClick} className="font-mono text-indigo-400 hover:text-indigo-300 underline">
            {value}
          </button>
        );
    }
    // 🚀 BM列表广告号ID可点击跳转筛选广告号
    if (accessor === 'adAccountIds' && value) {
      const ids = String(value).replace(/\.\.\.$/, '').split(/\s*,\s*/).filter(Boolean);
      return (
        <div className="flex flex-wrap gap-1 max-w-[200px]">
          {ids.map((id: string, i: number) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                try { localStorage.setItem('adAccounts:searchPrefill', id); } catch {}
                try { (window as any).setActiveTab && (window as any).setActiveTab('meta-adAccounts'); } catch {}
              }}
              className="text-[10px] font-mono text-indigo-400 hover:text-indigo-300 hover:underline bg-indigo-500/10 px-1.5 py-0.5 rounded"
              title="点击跳转广告号列表并筛选"
            >
              {id}
            </button>
          ))}
          {String(value).endsWith('...') && <span className="text-[10px] text-slate-500">...</span>}
        </div>
      );
    }
    if (accessor.endsWith('Id')) {
        return <span className="font-mono text-slate-400">{value}</span>
    }

    return value;
  };
  
  const [batchDropdownOpen, setBatchDropdownOpen] = useState(false);

  // —— 主页批量设置操作员 ——
  const [operatorModal, setOperatorModal] = useState(false);
  const [operatorTarget, setOperatorTarget] = useState('');
  const [operatorBusy, setOperatorBusy] = useState(false);
  const confirmAssignOperator = async () => {
    if (!operatorTarget) { alert('请选择要接管的新操作员（浏览器配置）'); return; }
    // ⚠️ 选择集合是「配置ID::资产ID」复合键，需从选中行取真实 pageId 并去重
    const pageIds = Array.from(new Set((sortedData as any[])
      .filter((item: any) => selectedIds.has(selectionKeyOf(item, uniqueIdKey)))
      .map((it: any) => String(it[uniqueIdKey] || ''))
      .filter(Boolean)));
    if (!pageIds.length) return;
    setOperatorBusy(true);
    try {
      const authToken = localStorage.getItem('auth_token') || token || '';
      const resp = await fetch(`/api/pages/assign-operator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ pageIds, profileId: operatorTarget }),
      });
      const j = await resp.json().catch(() => null);
      if (j && j.success) {
        const prof = profiles.find(p => String(p.id) === String(operatorTarget));
        alert(`已把 ${j.updated ?? pageIds.length} 个主页的操作员设置为「${prof?.name || operatorTarget}」\n该配置下次拉取后即获得对话/贴文的操控权。`);
        setOperatorModal(false);
        setSelectedIds(new Set());
        refreshPagesFromServer();
        try { window.dispatchEvent(new Event('pages-refresh')); } catch {}
      } else {
        alert(`设置失败：${(j && (j.message || j.error)) || `HTTP ${resp.status}`}`);
      }
    } catch (e: any) {
      alert('请求失败：' + (e?.message || String(e)));
    } finally { setOperatorBusy(false); }
  };

  const renderBatchActions = () => {
    const commonActions = [
      { label: '启动浏览器', icon: 'power', action: 'startProfile', variant: 'primary' },
      { label: '停止浏览器', icon: 'stop', action: 'stopProfile' },
      { label: '获取TOKEN', icon: 'key', action: 'fetchTokens' },
      { label: '同步Cookie', icon: 'cookie', action: 'syncCookies' },
      { label: '保存到库', icon: 'save', action: 'saveToDb' },
      { label: '检测BM', icon: 'shield', action: 'checkBM' },
      { label: '批量重登', icon: 'login', action: 'relogin' },
      { label: '拉取贴文', icon: 'refresh', action: 'fetchPosts', variant: 'primary' },
      // 🎛️ 点一下切换：关掉后抓取会跳过「点赞用户/评论/分享者」，省下最多 90 秒
      { label: fetchEngagement ? '互动明细：开' : '互动明细：关', icon: 'shield', action: 'toggleEngagement' },
    ];
    const actionGroups: { label: string; actions: { label: string; icon: string; action: string; variant?: string }[] }[] = [];
    switch(assetType) {
      case 'pages':
        actionGroups.push({ label: '通用', actions: commonActions }, { label: '操作', actions: [
          { label: '发布主页', icon: 'publish', action: 'publish', variant: 'primary' },
          { label: '取消发布', icon: 'unpublish', action: 'unpublish' },
          { label: '授权到个人号', icon: 'shield', action: 'grantPersonalPage' },
          { label: '设置操作员', icon: 'users', action: 'assignOperator', variant: 'primary' },
          { label: '获取信息', icon: 'refresh', action: 'getInfo', variant: 'primary' },
          { label: '删除选中', icon: 'delete', action: 'delete', variant: 'danger' },
        ]}); break;
      case 'bms':
        actionGroups.push({ label: '通用', actions: commonActions }, { label: '操作', actions: [
          { label: '检测状态', icon: 'refresh', action: 'checkStatus', variant: 'primary' },
          // 🩺 探测「BM 自身」状态（内部 GraphQL advertising_restriction_info），比「获取信息」快得多
          { label: '探测BM状态', icon: 'shield', action: 'probeAq', variant: 'primary' },
          { label: 'BM管理', icon: 'bmmgr', action: 'openBmOps', variant: 'primary' },
          { label: '获取信息', icon: 'refresh', action: 'getInfo', variant: 'primary' },
          // 🆕 以选中的 BM 为目标：先在这些 BM 下建广告号，再接绑卡/发布
          { label: '一键智能广告发布', icon: 'publish', action: 'smartPublish', variant: 'primary' },
          { label: '删除选中', icon: 'delete', action: 'delete', variant: 'danger' },
        ]}); break;
      case 'adAccounts':
        actionGroups.push({ label: '通用', actions: commonActions }, { label: '资产操作', actions: [
          { label: '更改账单国家/时区/货币', icon: 'refresh', action: 'changeCurrencyTimezone' },
          { label: '验证卡片', icon: 'shield', action: 'verifyCards' },
          { label: '绑定卡片', icon: 'card', action: 'addPayment' },
          { label: '充值', icon: 'wallet', action: 'topUp' },
          { label: '修改限额', icon: 'wallet', action: 'setSpendCap' },
          { label: '创建像素', icon: 'pixel', action: 'createPixel' },
          { label: '获取像素', icon: 'refresh', action: 'fetchPixels', variant: 'primary' },
          { label: '获取主页', icon: 'page', action: 'fetchPages', variant: 'primary' },
          { label: '获取广告', icon: 'megaphone', action: 'fetchAds', variant: 'primary' },
          { label: '获取信息', icon: 'refresh', action: 'getInfo', variant: 'primary' },
          { label: '创建主页', icon: 'page', action: 'createPage' },
          { label: '创建BM', icon: 'bmmgr', action: 'createBM' },
          { label: '授权到个人号', icon: 'shield', action: 'assignPersonalAd' },
          { label: '授权到BM', icon: 'bmmgr', action: 'assignToBm' },
          { label: '启动广告号', icon: 'power', action: 'enableAccount', variant: 'primary' },
          { label: '关闭广告号', icon: 'stop', action: 'disableAccount' },
          { label: '发布广告', icon: 'publish', action: 'publishAd', variant: 'primary' },
          { label: '一键智能广告发布', icon: 'publish', action: 'smartPublish', variant: 'primary' },
        ]}, { label: '危险操作', actions: [
          { label: '删除选中', icon: 'delete', action: 'delete', variant: 'danger' },
          { label: '彻底清除', icon: 'delete', action: 'hardDelete', variant: 'danger' },
        ]}); break;
      case 'ads':
        actionGroups.push({ label: '通用', actions: commonActions }, { label: '广告操作', actions: [
          { label: '启动资产', icon: 'power', action: 'activeAd', variant: 'primary' },
          { label: '暂停资产', icon: 'stop', action: 'pauseAd' },
          { label: '归档资产', icon: 'unpublish', action: 'archiveAd' },
          { label: '删除资产', icon: 'delete', action: 'deleteAd', variant: 'danger' },
          { label: '获取信息', icon: 'refresh', action: 'getInfo', variant: 'primary' },
        ]}); break;
    }
    const iconMap: Record<string, React.ElementType> = {
      power: Power, stop: PowerOff, key: Key, cookie: FileText, save: FileText, shield: ShieldCheck,
      login: LogIn, publish: PublishIcon, unpublish: EyeOff, refresh: RefreshCw, delete: Trash2,
      card: CreditCard, wallet: Wallet, pixel: Briefcase, page: FileText, bmmgr: UserPlus, megaphone: Megaphone,
      users: Users,
    };
    return (
      <div className="relative">
        <button onClick={() => setBatchDropdownOpen(v => !v)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-600/20 whitespace-nowrap">
          <span className="bg-indigo-500 text-white text-xs font-bold px-2 py-0.5 rounded-md">{selectedIds.size}</span>
          批量操作
          <ChevronDown className={`w-4 h-4 transition-transform ${batchDropdownOpen ? 'rotate-180' : ''}`} />
        </button>
        {batchDropdownOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setBatchDropdownOpen(false)} />
            <div className="absolute right-0 top-full mt-2 z-50 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl shadow-black/50 min-w-[240px] max-h-[70vh] overflow-y-auto">
              {actionGroups.map((group, gi) => (
                <div key={gi}>
                  {gi > 0 && <div className="mx-3 my-1 border-t border-slate-700" />}
                  <div className="px-3 pt-2 pb-1"><span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">{group.label}</span></div>
                  {group.actions.map((act) => {
                    const Icon = iconMap[act.icon] || RefreshCw;
                    const vs = act.variant === 'danger' ? 'text-rose-400 hover:bg-rose-500/20' : act.variant === 'primary' ? 'text-blue-400 hover:bg-blue-500/20' : 'text-slate-200 hover:bg-slate-700/50';
                    return (
                      <button key={act.action} onClick={() => { setBatchDropdownOpen(false); handleBatchAction(act.action); }} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${vs}`}>
                        <Icon className="w-4 h-4 shrink-0 opacity-70" />
                        <span>{act.variant === 'danger' ? '⚠ ' : ''}{act.label}</span>
                        {batchLoading && <RefreshCw className="w-3 h-3 ml-auto animate-spin" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
        {/* 🚀 批量操作阶段提示：菜单一点就自动关了，之前界面上完全看不到进度 —— 启动浏览器要 40~70s，
            这段"什么都没变"的观感就是"点了没反应"。这里固定在顶部显示当前阶段/进度。 */}
        {batchLoading && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900/95 border border-indigo-500/40 shadow-2xl shadow-black/50 pointer-events-none">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
            <span className="text-xs text-slate-200">{batchStage || '处理中…'}</span>
          </div>
        )}
      </div>
    );
  };

  const getResponsiveClass = (responsive?: string) => {
    if (responsive === 'md') return 'hidden md:table-cell';
    if (responsive === 'lg') return 'hidden lg:table-cell';
    return '';
  };

  const exportAssets = () => {
    let headers: string[] = [];
    let filename = 'assets.csv';
    
    if (assetType === 'adAccounts') {
      headers = ['profileId','profileName','adAccountId','adAccountName','status','spend','spendCap','pagesCount','bmCount','paymentCount','country','currency','timezone_id'];
      filename = 'adaccounts.csv';
    } else if (assetType === 'bms') {
      headers = ['profileId','profileName','bmId','verificationStatus','paymentStatus','country','currency'];
      filename = 'bms.csv';
    } else if (assetType === 'pages') {
      headers = ['profileId','profileName','pageId','pageName','likes','status'];
      filename = 'pages.csv';
    }
    
    const esc = (v: any) => {
      const s = String(v ?? '');
      const needs = /[",\n]/.test(s);
      return needs ? '"' + s.replace(/"/g,'""') + '"' : s;
    };
    
    const lines: string[] = [];
    lines.push(headers.join(','));
    
    // ⚠️ 选择集合是「配置ID::资产ID」复合键，导出时也必须用同一个键匹配
    //    （以前用资产ID 匹配：同ID 多行全被导出，选中一行却导出多行）
    const hasSelection = selectedIds.size > 0;
    const itemsToExport = hasSelection
      ? filteredData.filter((a: any) => selectedIds.has(selectionKeyOf(a, uniqueIdKey)))
      : filteredData;

    if (!hasSelection && filteredData.length > 0) {
      if (!window.confirm('您未勾选任何项目，是否导出当前列表中的全部项目？')) return;
    }

    itemsToExport.forEach((a: any) => {
      let row: any[] = [];
      if (assetType === 'adAccounts') {
        row = [a.profileId, a.profileName, a.adAccountId, a.adAccountName, a.adAccountStatus, a.spend, a.spendCap, a.pagesCount, a.bmCount, a.paymentCount, a.country, a.currency, a.timezone_id];
      } else if (assetType === 'bms') {
        // ⚠️ 列数必须和表头一一对应（以前表头 8 列、行只有 6 个值 → CSV 整行错位）
        row = [a.profileId, a.profileName, a.bmId, a.verificationStatus, a.paymentStatus, a.country, a.currency];
      } else if (assetType === 'pages') {
        row = [a.profileId, a.profileName, a.pageId, a.pageName, a.likes, a.status];
      }
      lines.push(row.map(esc).join(','));
    });
    
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // 🚀 在 render 作用域定义 targets，供底部对话框使用
  const targets: any[] = (sortedData as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)));

  return (
  <div className="space-y-6">
      <AssetViewerFilterBar
        assetType={assetType}
        Icon={Icon}
        title={title}
        renderBatchActions={renderBatchActions}
        onBatchAction={handleBatchAction}
        onRefresh={() => {
          // 🚀 「刷新」= 本地缓存秒显 + 服务器对齐。以前只读本地缓存(cache:adaccounts)，
          //    缓存里缺哪些号就只有多少条（实测 192 条），与 F5 后的服务器条数不一致。
          if (assetType === 'adAccounts') { refreshAdAccounts(); refreshAdAccountsFromServer(); }
          else if (assetType === 'pages') { refreshPages(); refreshPagesFromServer(); }
          else if (assetType === 'ads') { refreshAds(); refreshAdsFromServer(); }
          else if (assetType === 'bms') { refreshBusinesses(); refreshBusinessesFromServer(); refreshAdAccounts(); }
        }}
        onRefreshFromServer={refreshAdAccountsFromServer}
        onCleanup={cleanupHiddenAdAccounts}
        onExport={exportAssets}
        onRefreshBM={refreshBusinesses}
        onRefreshBMFromServer={refreshBusinessesFromServer}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        bmEmailFilter={bmEmailFilter}
        onBmEmailFilterChange={setBmEmailFilter}
        profileEmailFilter={profileEmailFilter}
        onProfileEmailFilterChange={setProfileEmailFilter}
        onProfileEmailFilterClear={() => setProfileEmailFilter('')}
        profileEmailOptions={profileEmailOptions}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        currencyFilter={currencyFilter}
        onCurrencyFilterChange={setCurrencyFilter}
        countryFilter={countryFilter}
        onCountryFilterChange={setCountryFilter}
        groupFilter={groupFilter}
        onGroupFilterChange={setGroupFilter}
        groupOptions={groupFilterOptions}
        tagFilter={tagFilter}
        onTagFilterChange={setTagFilter}
        tagOptions={tagFilterOptions}
        adAccountsDb={adAccountsDb}
        bmRefreshInfo={bmRefreshInfo}
      />

      <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
        {opsLog.length > 0 && (
          <div className="px-4 py-2 text-xs text-indigo-200 bg-indigo-900/20 border-b border-slate-800">
            <span>{new Date(opsLog[opsLog.length-1].time).toLocaleTimeString()}</span>
            <span className="ml-2">{opsLog[opsLog.length-1].detail}</span>
          </div>
        )}
        {opsDetails.length > 0 && (
          <div className="px-4 py-2 text-xs text-indigo-200/80 space-y-1 bg-indigo-900/10 border-b border-slate-800">
            {opsDetails.slice(-10).map((d, idx) => (
              <div key={idx} className={`flex items-center gap-2 ${d.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                <span className="font-mono">[{String(d.profileId)}]</span>
                <span className="font-mono">act:{String(d.adAccountId || '')}</span>
                <span>{d.ok ? 'OK' : 'FAIL'}</span>
                {d.message ? <span>- {d.message}</span> : null}
              </div>
            ))}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 font-medium">
              <tr>
                <th className="px-6 py-4 w-10">
                  <input 
                    type="checkbox" 
                    checked={isAllPageSelected}
                    onChange={toggleSelectAll}
                    disabled={paginatedData.length === 0}
                    className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900 disabled:opacity-50"
                  />
                </th>
                <th className="px-6 py-4 w-12 text-center cursor-pointer group" onClick={() => requestSort('seq')}>
                  <div className="flex items-center justify-center gap-1">
                    <span className="text-sm font-medium tracking-normal">ID</span>
                    {sortConfig.key === 'seq' ? (
                      sortConfig.direction === 'asc' ? <ArrowUp className="w-3.5 h-3.5 shrink-0" /> : <ArrowDown className="w-3.5 h-3.5 shrink-0" />
                    ) : <div className="w-3.5 h-3.5 opacity-0 group-hover:opacity-50 shrink-0"><ArrowDown/></div>}
                  </div>
                </th>
                {columns.map(col => (
                   <th key={col.accessor} className={`px-6 py-4 whitespace-nowrap cursor-pointer group ${getResponsiveClass(col.responsive)}`} onClick={() => requestSort(col.accessor)}>
                      <div className="flex items-center gap-1">
                          <span className="text-sm font-medium tracking-normal">{col.header}</span>
                          {sortConfig.key === col.accessor ? (
                              sortConfig.direction === 'asc' ? <ArrowUp className="w-3.5 h-3.5 shrink-0" /> : <ArrowDown className="w-3.5 h-3.5 shrink-0" />
                          ) : <div className="w-3.5 h-3.5 opacity-0 group-hover:opacity-50 shrink-0"><ArrowDown/></div>}
                      </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {paginatedData.length > 0 ? paginatedData.map((item: any, index) => {
                 const id = item[uniqueIdKey];
                 const selKey = selectionKeyOf(item, uniqueIdKey);
                 const isSelected = selectedIds.has(selKey);
                 return (
                    <tr key={selKey} className={`transition-colors ${isSelected ? 'bg-indigo-900/20' : 'hover:bg-slate-800/50'}`}>
                      <td className="px-6 py-4">
                        <input 
                          type="checkbox" 
                          checked={isSelected}
                          onChange={() => toggleSelection(selKey)}
                          className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900"
                        />
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <span className="text-slate-300 font-mono cursor-pointer" onClick={() => { setSelectedItem(item); setIsDetailsOpen(true); }}>{String(assetSeqMap[id] ?? item.seq ?? (index + 1))}</span>
                          {assetType === 'adAccounts' && null}
                        </div>
                      </td>
                      {columns.map(col => (
                        <td key={col.accessor} className={`px-6 py-4 text-slate-200 ${getResponsiveClass(col.responsive)}`}>
                          {col.accessor === 'socialPosts' || col.accessor === 'socialMessages'
                            ? renderSocialCountBtn(item, col.accessor === 'socialPosts' ? 'posts' : 'messages')
                            : col.accessor === 'aiWatch'
                              ? renderPageWatchBtn(item)
                              : renderCell(item, col.accessor)}
                        </td>
                      ))}
                    </tr>
                 );
              }) : (
                <tr>
                  <td colSpan={columns.length + 2} className="text-center py-16 text-slate-500">
                    <BookUser className="w-8 h-8 mx-auto mb-2" />
                    {assetType === 'adAccounts' && !adsLoaded ? '加载中…' : t('assetViewer.noAssets')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {/* 🚀 分页控制 */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-900/50 mt-2 rounded-lg border border-slate-800">
          <div className="text-sm text-slate-400">
            共 {sortedData.length} 条，{totalPages} 页，每页
            <select value={pageSize} onChange={e => { setPageSize(Math.min(1000, Number(e.target.value))); setCurrentPage(1); }} className="ml-2 bg-slate-950 border border-slate-700 text-slate-200 rounded px-2 py-1">
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={30}>30</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className="px-2.5 py-1.5 rounded bg-slate-800 text-slate-300 disabled:opacity-50 text-sm">首页</button>
            <button onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1} className="px-2.5 py-1.5 rounded bg-slate-800 text-slate-300 disabled:opacity-50 text-sm">上一页</button>
            {Array.from({length: Math.min(5, totalPages)}, (_,i)=>{
              const from = Math.max(1, currentPage - 2);
              const idx = from + i;
              return idx <= totalPages ? (
                <button key={idx} onClick={() => setCurrentPage(idx)} className={`px-2.5 py-1.5 rounded text-sm ${currentPage===idx ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>{idx}</button>
              ) : null;
            })}
            <button onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages} className="px-2.5 py-1.5 rounded bg-slate-800 text-slate-300 disabled:opacity-50 text-sm">下一页</button>
            <button onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className="px-2.5 py-1.5 rounded bg-slate-800 text-slate-300 disabled:opacity-50 text-sm">末页</button>
            <div className="flex items-center gap-2 ml-2">
              <input type="number" min={1} max={totalPages} value={jumpPage} onChange={e => setJumpPage(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyJump(); } }}
                title="输入页码后按回车或点「跳转」"
                className="w-16 bg-slate-950 border border-slate-700 text-slate-200 rounded px-2 py-1 text-sm" />
              <button onClick={applyJump} className="px-2.5 py-1.5 rounded bg-indigo-600 text-white text-sm">跳转</button>
            </div>
          </div>
        </div>
      </div>

      {isDetailsOpen && selectedItem && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">资产详情</h3>
              <button onClick={() => setIsDetailsOpen(false)} className="text-slate-400 hover:text-white p-2">关闭</button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-slate-400 text-sm">ID</div>
                  <div className="text-white font-mono">{String(selectedItem[uniqueIdKey])}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">配置名称</div>
                  <div className="text-white">{selectedItem.profileName}</div>
                </div>
                {selectedItem.pageId && (
                  <>
                    <div>
                      <div className="text-slate-400 text-sm">页面ID</div>
                      <div className="text-white font-mono">{selectedItem.pageId}</div>
                    </div>
                    <div>
                      <div className="text-slate-400 text-sm">页面名称</div>
                      <div className="text-white">{selectedItem.pageName}</div>
                    </div>
                  </>
                )}
                {selectedItem.bmId && (
                  <>
                    <div>
                      <div className="text-slate-400 text-sm">BM</div>
                      <div className="text-white font-mono">{selectedItem.bmId}</div>
                    </div>
                    <div>
                      <div className="text-slate-400 text-sm">BM 名称</div>
                      <div className="text-white">{selectedItem.bmName || '-'}</div>
                    </div>
                    <div>
                      <div className="text-slate-400 text-sm">企业认证</div>
                      <div className="text-white">{selectedItem.verificationStatus || '-'}</div>
                    </div>
                  </>
                )}
                {selectedItem.adAccountId && (
                  <>
                    <div>
                      <div className="text-slate-400 text-sm">广告账户ID</div>
                      <div className="text-white font-mono">{selectedItem.adAccountId}</div>
                    </div>
                    <div>
                      <div className="text-slate-400 text-sm">广告账户状态</div>
                      <div className="text-white">{selectedItem.adAccountStatus}</div>
                    </div>
                  </>
                )}
              </div>
              {selectedItem.likes != null && (
                <div className="border-t border-slate-800 pt-4">
                  <div className="text-slate-400 text-sm">点赞数</div>
                  <div className="text-white font-mono">{new Intl.NumberFormat().format(selectedItem.likes)}</div>
                </div>
              )}
              {selectedItem.spend != null && (
                <div className="border-t border-slate-800 pt-4">
                  <div className="text-slate-400 text-sm">花费(USD)</div>
                  <div className="text-white font-mono">{new Intl.NumberFormat().format(selectedItem.spend)}</div>
                </div>
              )}
              {selectedItem.spendCap != null && (
                <div className="border-t border-slate-800 pt-4">
                  <div className="text-slate-400 text-sm">额度(USD)</div>
                  <div className="text-white font-mono">{new Intl.NumberFormat().format(selectedItem.spendCap)}</div>
                </div>
              )}
              {selectedItem.country || selectedItem.currency ? (
                <div className="border-t border-slate-800 pt-4">
                  <div className="text-slate-400 text-sm">国家/货币</div>
                  <div className="text-white">{selectedItem.country || '-'} / {selectedItem.currency || '-'}</div>
                </div>
              ) : null}
              {(limitsLoading || limitsError) && (
                <div className="border-t border-slate-800 pt-4">
                  {limitsLoading && <div className="text-slate-400 text-sm">限额获取中…</div>}
                  {limitsError && <div className="text-rose-400 text-sm">{limitsError}</div>}
                </div>
              )}
              <div className="border-t border-slate-800 pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-slate-400 text-sm">Facebook TOKEN</div>
                  <button
                    onClick={() => fetchTokens(selectedItem.profileId)}
                    className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50"
                    disabled={tokenLoading}
                  >{tokenLoading ? '获取中…' : '获取TOKEN'}</button>
                </div>
                {tokenError && <div className="text-rose-400 text-sm">{tokenError}</div>}
                {tokens && (
                  <div className="space-y-2">
                    {typeof (tokens as any).primary === 'string' && (
                      <div className="flex items-center gap-2">
                        <span className="text-slate-400 text-xs">primary</span>
                        <span className="font-mono text-slate-200 break-all">{(tokens as any).primary}</span>
                        <button onClick={() => copyText((tokens as any).primary)} className="px-2 py-1 text-xs bg-slate-800 text-slate-200 rounded">复制</button>
                        <button onClick={() => { setManualAccessToken((tokens as any).primary); fetchAssetsWithToken((tokens as any).primary); }} className="px-2 py-1 text-xs bg-indigo-600 text-white rounded">使用并拉取</button>
                        {typeof (tokens as any).validated === 'boolean' && (
                          <span className={`text-xs px-2 py-0.5 rounded ${ (tokens as any).validated ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800' : 'bg-rose-900/30 text-rose-400 border border-rose-800'}`}>
                            {(tokens as any).validated ? '已校验' : '未校验'}
                          </span>
                        )}
                      </div>
                    )}
                    {tokens.fb_dtsg && (
                      <div className="flex items-center gap-2">
                        <span className="text-slate-400 text-xs">fb_dtsg</span>
                        <span className="font-mono text-slate-200 break-all">{tokens.fb_dtsg}</span>
                        <button onClick={() => copyText(tokens.fb_dtsg)} className="px-2 py-1 text-xs bg-slate-800 text-slate-200 rounded">复制</button>
                      </div>
                    )}
                    {tokens.lsd && (
                      <div className="flex items-center gap-2">
                        <span className="text-slate-400 text-xs">lsd</span>
                        <span className="font-mono text-slate-200 break-all">{tokens.lsd}</span>
                        <button onClick={() => copyText(tokens.lsd)} className="px-2 py-1 text-xs bg-slate-800 text-slate-200 rounded">复制</button>
                      </div>
                    )}
                    {Array.isArray(tokens.authorization) && tokens.authorization.length > 0 && (
                      <div>
                        <div className="text-slate-400 text-xs mb-1">Authorization</div>
                        <div className="space-y-1">
                          {tokens.authorization.map((v: string, idx: number) => (
                            <div key={idx} className="flex items-center gap-2">
                              <span className="font-mono text-slate-200 break-all">{v}</span>
                              <button onClick={() => copyText(v)} className="px-2 py-1 text-xs bg-slate-800 text-slate-200 rounded">复制</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {Array.isArray(tokens.access_tokens) && tokens.access_tokens.length > 0 && (
                      <div>
                        <div className="text-slate-400 text-xs mb-1">access_token</div>
                        <div className="space-y-1">
                          {tokens.access_tokens.map((v: string, idx: number) => (
                            <div key={idx} className="flex items-center gap-2">
                              <span className="font-mono text-slate-200 break-all">{v}</span>
                              <button onClick={() => copyText(v)} className="px-2 py-1 text-xs bg-slate-800 text-slate-200 rounded">复制</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-4 space-y-2">
                  <div className="text-slate-400 text-sm">Facebook Graph access_token</div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualAccessToken}
                      onChange={(e) => setManualAccessToken(e.target.value)}
                      placeholder="粘贴EAAG..."
                      className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded"
                    />
                    <button
                      onClick={() => fetchAssetsWithToken(manualAccessToken)}
                      className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50"
                      disabled={assetsLoading || !manualAccessToken}
                    >{assetsLoading ? '拉取中…' : '拉取资产'}</button>
                    <button
                      onClick={checkPermissions}
                      className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded disabled:opacity-50"
                      disabled={!manualAccessToken}
                    >检测令牌权限</button>
                  </div>
                  {assetsError && <div className="text-rose-400 text-sm">{assetsError}</div>}
                              {assetsResult && (
                                <div className="mt-2 space-y-3">
                                  <div className="text-slate-300 text-sm">用户：<span className="font-mono text-slate-200">{assetsResult.user?.id}</span> / {assetsResult.user?.name}</div>
                                  <div className="text-slate-300 text-sm">页面：{Array.isArray(assetsResult.pages) ? assetsResult.pages.length : 0}</div>
                                  {Array.isArray(assetsResult.pages) && assetsResult.pages.length === 0 && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-slate-400">主页为空，尝试从商业账户补充</span>
                                      <button onClick={refetchPagesFromBusinesses} className="px-2 py-1 text-xs bg-slate-800 text-slate-200 rounded">补充主页</button>
                                    </div>
                                  )}
                                  {Array.isArray(assetsResult.pages) && assetsResult.pages.length > 0 && (
                                    <div className="bg-slate-950 border border-slate-800 rounded p-2">
                                      {assetsResult.pages.slice(0, 20).map((p: any) => (
                                        <button key={p.id} onClick={() => setSelectedPageId(p.id)} className={`w-full flex items-center justify-between text-xs text-slate-300 rounded px-2 py-1 ${selectedPageId === p.id ? 'bg-indigo-900/40' : 'hover:bg-slate-800/60'}`}>
                                          <span className="font-mono text-slate-400">{p.id}</span>
                                  <span>{p.name}</span>
                                  <span className="font-mono text-slate-500">{p.fan_count ?? ''}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="mt-2 space-y-2">
                            <div className="text-slate-300 text-sm">选中页面：<span className="font-mono text-slate-200">{selectedPageId || '未选择'}</span></div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={pagePostMessage}
                                onChange={(e) => setPagePostMessage(e.target.value)}
                                placeholder="输入发布内容"
                                className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded"
                              />
                              <button
                                onClick={publishToPage}
                                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50"
                                disabled={posting || !selectedPageId || !manualAccessToken || !pagePostMessage}
                              >{posting ? '发布中…' : '发布动态'}</button>
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={pageLinkUrl}
                                onChange={(e) => setPageLinkUrl(e.target.value)}
                                placeholder="输入链接URL"
                                className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded"
                              />
                              <button
                                onClick={publishLinkToPage}
                                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50"
                                disabled={posting || !selectedPageId || !manualAccessToken || !pageLinkUrl}
                              >{posting ? '发布中…' : '发布链接'}</button>
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={pageImageUrl}
                                onChange={(e) => setPageImageUrl(e.target.value)}
                                placeholder="输入图片URL"
                                className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded"
                              />
                              <button
                                onClick={publishPhotoToPage}
                                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50"
                                disabled={posting || !selectedPageId || !manualAccessToken || !pageImageUrl}
                              >{posting ? '发布中…' : '发布图片'}</button>
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="datetime-local"
                                value={scheduleTime}
                                onChange={(e) => setScheduleTime(e.target.value)}
                                className="bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded"
                              />
                              <button
                                onClick={schedulePostToPage}
                                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50"
                                disabled={posting || !selectedPageId || !manualAccessToken || !pagePostMessage || !scheduleTime}
                              >{posting ? '发布中…' : '定时发布'}</button>
                            </div>
                            {postError && <div className="text-rose-400 text-sm">{postError}</div>}
                            {postResult && <div className="text-emerald-400 text-sm">已发布：<span className="font-mono">{postResult.id}</span></div>}
                          <div className="pt-2">
                            <button onClick={loadPagePosts} className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded">加载最近动态</button>
                            {postsLoading && <span className="ml-2 text-slate-400 text-sm">加载中…</span>}
                            {postsError && <div className="text-rose-400 text-sm">{postsError}</div>}
                            {pagePosts.length > 0 && (
                                <div className="mt-2 bg-slate-950 border border-slate-800 rounded p-2">
                                  {pagePosts.map(p => (
                                    <div key={p.id} className="grid grid-cols-5 gap-2 items-center text-xs text-slate-300">
                                      <span className="font-mono text-slate-400 col-span-2 break-all">{p.id}</span>
                                      <span className="truncate">{p.message || ''}</span>
                                      <div className="flex justify-end gap-2">
                                        <a href={p.permalink_url} target="_blank" rel="noreferrer" className="px-2 py-1 rounded bg-slate-800 text-slate-200">打开</a>
                                        <button onClick={() => setSelectedPostId(p.id)} className={`px-2 py-1 rounded ${selectedPostId===p.id?'bg-indigo-600 text-white':'bg-slate-800 text-slate-200'}`}>{selectedPostId===p.id?'已选中':'选中'}</button>
                                        <button onClick={() => deletePost(p.id)} className="px-2 py-1 rounded bg-rose-600 text-white">删除</button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="mt-3 space-y-2">
                              <div className="flex items-center gap-2">
                                <select value={insightsDatePreset} onChange={(e) => setInsightsDatePreset(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded">
                                  <option value="last_7d">最近7天</option>
                                  <option value="last_28d">最近28天</option>
                                  <option value="yesterday">昨天</option>
                                  <option value="today">今天</option>
                                </select>
                                <button onClick={fetchPageInsights} className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded disabled:opacity-50" disabled={!selectedPageId || !manualAccessToken || insightsLoading}>{insightsLoading ? '拉取中…' : '拉取页面洞察'}</button>
                              </div>
                              {insightsError && <div className="text-rose-400 text-sm">{insightsError}</div>}
                              {pageInsights.length > 0 && (
                                <div className="mt-2 bg-slate-950 border border-slate-800 rounded p-2">
                                  {pageInsights.slice(0, 8).map((m: any) => (
                                    <div key={m.name} className="mb-2">
                                      <div className="text-xs text-slate-300">{m.title || m.name} · {m.period}</div>
                                      <div className="grid grid-cols-3 gap-2 text-xs text-slate-300">
                                        {(Array.isArray(m.values) ? m.values : []).slice(0, 6).map((v: any, idx: number) => (
                                          <div key={idx} className="flex items-center justify-between gap-2">
                                            <span className="font-mono text-slate-400">{v.end_time || v.date || ''}</span>
                                            <span className="font-mono text-slate-200">{typeof v.value === 'number' ? v.value : JSON.stringify(v.value)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="flex items-center gap-2 pt-1">
                                <button onClick={fetchPostInsights} className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded disabled:opacity-50" disabled={!selectedPostId || !selectedPageId || !manualAccessToken || postInsightsLoading}>{postInsightsLoading ? '拉取中…' : '拉取贴文洞察'}</button>
                                {selectedPostId && <span className="text-xs text-slate-400">贴文：<span className="font-mono text-slate-300">{selectedPostId}</span></span>}
                              </div>
                              {postInsightsError && <div className="text-rose-400 text-sm">{postInsightsError}</div>}
                              {postInsights.length > 0 && (
                                <div className="mt-2 bg-slate-950 border border-slate-800 rounded p-2">
                                  {postInsights.slice(0, 6).map((m: any) => (
                                    <div key={m.name} className="mb-2">
                                      <div className="text-xs text-slate-300">{m.title || m.name} · {m.period}</div>
                                      <div className="grid grid-cols-3 gap-2 text-xs text-slate-300">
                                        {(Array.isArray(m.values) ? m.values : []).slice(0, 6).map((v: any, idx: number) => (
                                          <div key={idx} className="flex items-center justify-between gap-2">
                                            <span className="font-mono text-slate-400">{v.end_time || v.date || ''}</span>
                                            <span className="font-mono text-slate-200">{typeof v.value === 'number' ? v.value : JSON.stringify(v.value)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="flex items-center gap-2 pt-1">
                                <button onClick={() => exportInsights(pageInsights, `page-${selectedPageId || 'unknown'}-insights.xlsx`)} className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded disabled:opacity-50" disabled={pageInsights.length===0}>导出页面洞察</button>
                                <button onClick={() => exportInsights(postInsights, `post-${selectedPostId || 'unknown'}-insights.xlsx`)} className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded disabled:opacity-50" disabled={postInsights.length===0}>导出贴文洞察</button>
                              </div>
                            </div>
                          </div>
                          <div className="text-slate-300 text-sm">广告账户：{Array.isArray(assetsResult.adAccounts) ? assetsResult.adAccounts.length : 0}</div>
                          {Array.isArray(assetsResult.adAccounts) && assetsResult.adAccounts.length > 0 && (
                            <div className="bg-slate-950 border border-slate-800 rounded p-2">
                              {assetsResult.adAccounts.slice(0, 10).map((a: any) => (
                                <div key={a.id} className="grid grid-cols-4 gap-2 text-xs text-slate-300">
                                  <span className="font-mono text-slate-400">{a.account_id || a.id}</span>
                                  <span>{a.name}</span>
                                  <span className="font-mono text-slate-500">{a.currency}</span>
                                  <span className="font-mono text-slate-500">{a.timezone_id}</span>
                                </div>
                              ))}
                            </div>
                          )}
                      <div className="text-slate-300 text-sm">商业账户：{Array.isArray(assetsResult.businesses) ? assetsResult.businesses.length : 0}</div>
                      {Array.isArray(assetsResult.businesses) && assetsResult.businesses.length > 0 && (
                        <div className="bg-slate-950 border border-slate-800 rounded p-2">
                          {assetsResult.businesses.slice(0, 10).map((b: any) => (
                            <div key={b.id} className="flex items-center justify-between text-xs text-slate-300">
                              <span className="font-mono text-slate-400">{b.id}</span>
                              <span>{b.name}</span>
                              <span className="font-mono text-slate-500">{b.verification_status ?? ''}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="border-t border-slate-800 pt-4 mt-2">
                <label className="block text-slate-300 text-sm mb-2 font-medium">账单地址</label>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">街道地址</label>
                    <div className="flex gap-1">
                      <input value={changeAddress} onChange={e=>setChangeAddress(e.target.value)} placeholder="123 Main St" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm flex-1" disabled={changeAddressRandom} />
                      <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" checked={changeAddressRandom} onChange={e=>{ setChangeAddressRandom(e.target.checked); if (e.target.checked) setChangeAddress(''); }} className="w-3 h-3 rounded border-slate-600" />
                        随机
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">城市</label>
                    <div className="flex gap-1">
                      <input value={changeCity} onChange={e=>setChangeCity(e.target.value)} placeholder="New York" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm flex-1" disabled={changeCityRandom} />
                      <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" checked={changeCityRandom} onChange={e=>{ setChangeCityRandom(e.target.checked); if (e.target.checked) setChangeCity(''); }} className="w-3 h-3 rounded border-slate-600" />
                        随机
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">邮编</label>
                    <div className="flex gap-1">
                      <input value={changeZip} onChange={e=>setChangeZip(e.target.value)} placeholder="10001" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm flex-1" disabled={changeZipRandom} />
                      <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" checked={changeZipRandom} onChange={e=>{ setChangeZipRandom(e.target.checked); if (e.target.checked) setChangeZip(''); }} className="w-3 h-3 rounded border-slate-600" />
                        随机
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">州/省</label>
                    <div className="flex gap-1">
                      <select value={changeState} onChange={e=>setChangeState(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm flex-1" disabled={changeStateRandom}>
                        <option value="">选择州</option>
                        {US_STATES.map(s=> <option key={s} value={s}>{s}</option>)}
                      </select>
                      <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" checked={changeStateRandom} onChange={e=>{ setChangeStateRandom(e.target.checked); if (e.target.checked) setChangeState(''); }} className="w-3 h-3 rounded border-slate-600" />
                        随机
                      </label>
                    </div>
                  </div>
                </div>
                <button onClick={() => {
                  const addr = generateRandomAddress(changeCountry);
                  setChangeAddress(addr.street);
                  setChangeCity(addr.city);
                  setChangeZip(addr.zip);
                  if (changeCountry === 'US' && addr.state) setChangeState(addr.state);
                }} className="mt-2 px-3 py-1.5 bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 rounded-lg text-xs hover:bg-emerald-600/30 transition-colors">
                  随机生成地址
                </button>
              </div>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end">
              <button onClick={() => setIsDetailsOpen(false)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 🚀 广告账户备注快速编辑弹窗 */}
      {inlineNotesEdit && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setInlineNotesEdit(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-200 mb-3">编辑广告账户备注</h3>
            <textarea
              value={inlineNotesEdit.notes}
              onChange={e => setInlineNotesEdit(prev => prev ? { ...prev, notes: e.target.value } : null)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500 min-h-[80px] resize-y"
              placeholder="输入备注内容..."
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setInlineNotesEdit(null)} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors">取消</button>
              <button onClick={async () => {
                if (!inlineNotesEdit) return;
                try {
                  const aid = inlineNotesEdit.id;
                  const resp = await fetch(`/api/adaccounts/${encodeURIComponent(aid)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
                    body: JSON.stringify({ notes: inlineNotesEdit.notes })
                  });
                  const result = await resp.json();
                  if (!result.success) {
                    console.error('保存备注失败:', result.message);
                    return;
                  }
                  setAdAccountsDb(prev => prev.map(a => {
                    const itemId = a.id || a.adAccountId;
                    return itemId === aid ? { ...a, notes: inlineNotesEdit.notes } : a;
                  }));
                  setInlineNotesEdit(null);
                } catch (e) {
                  console.error('保存备注异常:', e);
                }
              }} className="px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}

      {isBatchOpen && batchResult && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">批量资产结果</h3>
              <button onClick={() => setIsBatchOpen(false)} className="text-slate-400 hover:text-white p-2">关闭</button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
              {batchError && <div className="text-rose-400 text-sm">{batchError}</div>}
              <div className="text-slate-300 text-sm">已保存广告账户：<span className="font-mono text-slate-200">{batchResult.savedAdAccounts}</span></div>
              <div className="overflow-x-auto rounded border border-slate-800">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-950 text-slate-300">
                    <tr>
                      <th className="px-4 py-2">配置ID</th>
                      <th className="px-4 py-2">名称</th>
                      <th className="px-4 py-2">状态</th>
                      <th className="px-4 py-2">页面</th>
                      <th className="px-4 py-2">广告账户</th>
                      <th className="px-4 py-2">商业账户</th>
                      <th className="px-4 py-2">像素编号</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-200">
                    {batchResult.items.map((it: any) => (
                      <tr key={it.profileId}>
                        <td className="px-4 py-2 font-mono text-slate-400">{it.profileId}</td>
                        <td className="px-4 py-2">{it.profileName}</td>
                        <td className="px-4 py-2">{it.ok ? '成功' : '失败'}</td>
                        <td className="px-4 py-2">{it.pagesCount ?? '-'}</td>
                        <td className="px-4 py-2">{it.adAccountsCount ?? '-'}</td>
                        <td className="px-4 py-2">{it.businessesCount ?? '-'}</td>
                        <td className="px-4 py-2 font-mono text-xs text-indigo-400 break-all max-w-[200px]">{it.pixelIds || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end">
              <button onClick={() => setIsBatchOpen(false)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">关闭</button>
            </div>
          </div>
        </div>
      )}

      {isPublishOpen && assetType === 'adAccounts' && (
        <FacebookAdPublisher
          profileIds={Array.from(new Set((sortedData as any[]).filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey))).map(item => String(item.profileId))))}
          onCancel={() => setIsPublishOpen(false)}
          onConfirm={handleBatchPublish}
        />
      )}

      {isChangeCTOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">更改账单国家/时区/货币</h3>
              <button onClick={() => setIsChangeCTOpen(false)} className="text-slate-400 hover:text-white p-2">关闭</button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
              {changeError && <div className="text-rose-400 text-sm">{changeError}</div>}
              <div className="overflow-x-auto rounded border border-slate-800">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-950 text-slate-300">
                    <tr>
                      <th className="px-4 py-2">广告账号ID</th>
                      <th className="px-4 py-2">国家</th>
                      <th className="px-4 py-2">货币代码</th>
                      <th className="px-4 py-2">时区</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-200">
                    {changeTargets.map((a: any) => (
                      <tr key={String(a.adAccountId)}>
                        <td className="px-4 py-2 font-mono text-slate-400">{a.adAccountId}</td>
                        <td className="px-4 py-2">{a.country || '-'}</td>
                        <td className="px-4 py-2"><span className="font-mono">{a.currency || '-'}</span></td>
                        <td className="px-4 py-2"><span className="font-mono">{typeof a.timezone_offset_hours_utc === 'number' ? `${a.timezone_name || ''}${a.timezone_offset_hours_utc>=0?'+':''}${a.timezone_offset_hours_utc}` : (a.timezone_id || '-')}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-4 gap-4">
                <div>
                  <label className="block text-slate-300 text-sm mb-1">新国家</label>
                  <select value={changeCountry || 'US'} onChange={e=>{ const v = e.target.value; setChangeCountry(v); const cur = COUNTRY_CURRENCY[v] || changeCurrency; setChangeCurrency(cur);} } className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded">
                    <option value="">选择国家</option>
                    {Object.keys(COUNTRY_CURRENCY).map(cty=> (<option key={cty} value={cty}>{cty}</option>))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 text-sm mb-1">新货币代码</label>
                  <select value={changeCurrency || 'USD'} onChange={e=>{ const v = e.target.value; setChangeCurrency(v); if (!changeCountry) { const found = Object.keys(COUNTRY_CURRENCY).find(k=>COUNTRY_CURRENCY[k]===v); if (found) setChangeCountry(found); } }} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded">
                    <option value="">选择货币</option>
                    {Array.from(new Set(Object.values(COUNTRY_CURRENCY))).map(cur=> (<option key={cur} value={cur}>{cur}</option>))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 text-sm mb-1">新时区（FB 时区ID）</label>
                  <select value={changeTimezoneOffset || '1'} onChange={e=>{ const v = e.target.value; setChangeTimezoneOffset(v); setChangeTimezone(v); }} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded">
                    <option value="">请选择时区</option>
                    {TZ_OPTIONS.map(tz => <option key={tz.label} value={tz.val}>{tz.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 text-sm mb-1">FB界面语言</label>
                  <select value={changeLang} onChange={e=>setChangeLang(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded">
                    <option value="">不修改</option>
                    <option value="en_US">🇺🇸 English (US)</option>
                    <option value="zh_CN">🇨🇳 简体中文</option>
                    <option value="es_ES">🇪🇸 Español (ES)</option>
                    <option value="fr_FR">🇫🇷 Français (FR)</option>
                    <option value="pt_BR">🇧🇷 Português (BR)</option>
                    <option value="de_DE">🇩🇪 Deutsch (DE)</option>
                    <option value="it_IT">🇮🇹 Italiano (IT)</option>
                    <option value="ja_JP">🇯🇵 日本語</option>
                    <option value="ko_KR">🇰🇷 한국어</option>
                    <option value="th_TH">🇹🇭 ภาษาไทย</option>
                    <option value="vi_VN">🇻🇳 Tiếng Việt</option>
                    <option value="id_ID">🇮🇩 Bahasa Indonesia</option>
                    <option value="ms_MY">🇲🇾 Bahasa Melayu</option>
                    <option value="ar_AR">🇸🇦 العربية</option>
                    <option value="tr_TR">🇹🇷 Türkçe</option>
                    <option value="ru_RU">🇷🇺 Русский</option>
                    <option value="pl_PL">🇵🇱 Polski</option>
                    <option value="nl_NL">🇳🇱 Nederlands</option>
                  </select>
                  <p className="text-xs text-slate-500 mt-1">非英语界面会自动切到英语</p>
                </div>
              </div>
              <div className="border-t border-slate-800 pt-4 mt-2">
                <label className="block text-slate-300 text-sm mb-2 font-medium">账单地址</label>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">街道地址</label>
                    <div className="flex gap-1">
                      <input value={changeAddress} onChange={e=>setChangeAddress(e.target.value)} placeholder="123 Main St" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm flex-1" disabled={changeAddressRandom} />
                      <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" checked={changeAddressRandom} onChange={e=>{ setChangeAddressRandom(e.target.checked); if (e.target.checked) setChangeAddress(''); }} className="w-3 h-3 rounded border-slate-600" />
                        随机
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">城市</label>
                    <div className="flex gap-1">
                      <input value={changeCity} onChange={e=>setChangeCity(e.target.value)} placeholder="New York" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm flex-1" disabled={changeCityRandom} />
                      <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" checked={changeCityRandom} onChange={e=>{ setChangeCityRandom(e.target.checked); if (e.target.checked) setChangeCity(''); }} className="w-3 h-3 rounded border-slate-600" />
                        随机
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">邮编</label>
                    <div className="flex gap-1">
                      <input value={changeZip} onChange={e=>setChangeZip(e.target.value)} placeholder="10001" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm flex-1" disabled={changeZipRandom} />
                      <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" checked={changeZipRandom} onChange={e=>{ setChangeZipRandom(e.target.checked); if (e.target.checked) setChangeZip(''); }} className="w-3 h-3 rounded border-slate-600" />
                        随机
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">州/省</label>
                    <div className="flex gap-1">
                      <select value={changeState} onChange={e=>setChangeState(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm flex-1" disabled={changeStateRandom}>
                        <option value="">选择州</option>
                        {US_STATES.map(s=> <option key={s} value={s}>{s}</option>)}
                      </select>
                      <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                        <input type="checkbox" checked={changeStateRandom} onChange={e=>{ setChangeStateRandom(e.target.checked); if (e.target.checked) setChangeState(''); }} className="w-3 h-3 rounded border-slate-600" />
                        随机
                      </label>
                    </div>
                  </div>
                </div>
              </div>
              <div className="border-t border-slate-800 pt-4 mt-2">
                <label className="block text-slate-300 text-sm mb-2 font-medium">公司名称（账单）</label>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <input value={changeBusinessName} onChange={e=>setChangeBusinessName(e.target.value)}
                      placeholder="输入账单公司名称，如 Example Inc.（留空不修改）"
                      className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm" />
                    <p className="text-xs text-slate-500 mt-1">修改广告号账单信息中的公司名称（business_name），通过 GraphQL 提交。</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
              <button onClick={() => setIsChangeCTOpen(false)} className="px-4 py-2 bg-slate-800 text-slate-200 rounded-lg hover:bg-slate-700">取消</button>
              <button disabled={changeLoading} onClick={async () => {
                setChangeLoading(true);
                setChangeError('');
                try {
                  const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
                  const lbase = launchUrl.replace(/\/$/, '');
                  const filtered = changeTargets.filter(item => item.profileId && item.adAccountId);
                  if (filtered.length === 0) {
                    setChangeError('没有可修改的广告号（缺少 profileId 或 adAccountId）');
                    setChangeLoading(false);
                    return;
                  }
                  if (filtered.length < changeTargets.length) {
                    setChangeError(`已跳过 ${changeTargets.length - filtered.length} 个缺少参数的项目`);
                  }
                  // 🚀 随机地址/城市/邮编/州
                  const streets = ['Main St','Oak Ave','Elm St','Park Rd','Broadway','Lake Dr','Hill St','Cedar Ln','Maple Ave','River Rd','Pine St','Washington Blvd','Sunset Blvd','Madison Ave','Lincoln St'];
                  const cities = ['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio','San Diego','Dallas','Austin','Miami','Denver','Seattle','Portland','Atlanta','Boston','Nashville','Detroit'];
                  const zipCodes = ['10001','90001','60601','77001','85001','19101','78201','92101','75201','73301','33101','80201','98101','97201','30301','02101','37201','48201'];
                  const randomStreet = () => `${Math.floor(Math.random()*9000+1000)} ${streets[Math.floor(Math.random()*streets.length)]}`;
                  const randomCity = () => cities[Math.floor(Math.random()*cities.length)];
                  const randomZip = () => zipCodes[Math.floor(Math.random()*zipCodes.length)];
                  const randomState = () => US_STATES[Math.floor(Math.random()*US_STATES.length)];
                  const addr = changeAddressRandom ? randomStreet() : changeAddress;
                  const cty = changeCityRandom ? randomCity() : changeCity;
                  const zp = changeZipRandom ? randomZip() : changeZip;
                  const st = changeStateRandom ? randomState() : changeState;
                  // 🚀 按 profileId 分组，同一配置的所有广告号一次请求完成（复用浏览器）
                  const grouped: Record<string, any[]> = {};
                  filtered.forEach(item => {
                    const pid = String(item.profileId);
                    if (!grouped[pid]) grouped[pid] = [];
                    grouped[pid].push(item);
                  });
                  const profileTasks = Object.entries(grouped).map(async ([pid, items]) => {
                    const adAccountIds = items.map(item => String(item.adAccountId));
                    const resp = await fetch(`${lbase}/api/facebook/adaccounts/change-currency-timezone`, { 
                      method: 'POST', 
                      headers: { 
                        'Content-Type': 'application/json',
                        'X-Api-Secret': LOCAL_SERVER_SECRET
                      }, 
                      body: JSON.stringify({ profileId: pid, adAccountIds, currency: changeCurrency, timezone_id: changeTimezone, country: changeCountry, address: addr, city: cty, zip: zp, state: st, lang: changeLang || undefined, business_name: changeBusinessName || undefined }) 
                    });
                    return resp.json().catch(() => ({ success: false }));
                  });
                  const batchResults = await Promise.allSettled(profileTasks);
                  setIsChangeCTOpen(false);
                  refreshAdAccountsFromServer();
                } catch (e) {
                  setChangeError('更改失败');
                } finally {
                  setChangeLoading(false);
                }
              }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">确认更改</button>
            </div>
          </div>
        </div>
      )}

      {isAddPaymentOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">💳 绑定信用卡</h3>
              <button onClick={() => setIsAddPaymentOpen(false)} className="text-slate-400 hover:text-white p-2">✕</button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
              {addPaymentError && <div className={`text-sm ${addPaymentError.includes('保存') ? 'text-emerald-400' : addPaymentError.includes('填写') ? 'text-emerald-400' : 'text-rose-400'}`}>{addPaymentError}</div>}
              <div className="overflow-x-auto rounded border border-slate-800">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-950 text-slate-300">
                    <tr>
                      <th className="px-4 py-2">广告账号ID</th>
                      <th className="px-4 py-2">国家</th>
                      <th className="px-4 py-2">货币</th>
                      <th className="px-4 py-2">时区</th>
                      <th className="px-4 py-2">已有卡片</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-200">
                    {addPaymentTargets.map((a: any) => (
                      <tr key={String(a.adAccountId)}>
                        <td className="px-4 py-2 font-mono text-slate-400">{a.adAccountId}</td>
                        <td className="px-4 py-2">{a.country || '-'}</td>
                        <td className="px-4 py-2"><span className="font-mono">{a.currency || '-'}</span></td>
                        <td className="px-4 py-2"><span className="font-mono">{a.timezone_id || '-'}</span></td>
                        <td className="px-4 py-2">
                          {(billingMethodsByProfile[String(a.profileId)]||[]).length ? (
                            <span className="text-slate-400">{(billingMethodsByProfile[String(a.profileId)]||[]).map(m=>`${m.type||'Card'}(${m.last4||'****'})`).join(', ')}</span>
                          ) : (
                            <span className="text-slate-500">无</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {/* 🚀 优化：工具按钮行 */}
            <div className="flex flex-wrap gap-2">
              <div className="flex gap-1">
                <button onClick={()=>setAddMode('manual')} className={`px-3 py-1.5 rounded-lg text-xs transition-all ${addMode==='manual'?'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30':'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>🖊 手动输入</button>
                <button onClick={()=>setAddMode('existing')} className={`px-3 py-1.5 rounded-lg text-xs transition-all ${addMode==='existing'?'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30':'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>📋 选择已有卡片</button>
                <button onClick={()=>setAddMode('auto')} className={`px-3 py-1.5 rounded-lg text-xs transition-all ${addMode==='auto'?'bg-amber-600 text-white shadow-lg shadow-amber-600/30':'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>🔄 遍历卡片绑卡</button>
              </div>
              <div className="flex-1" />
              <button onClick={()=>{ try { (window as any).setActiveTab && (window as any).setActiveTab('payment'); } catch {} }} className="px-3 py-1.5 rounded-lg text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all">📂 打开卡片管理</button>
              <button onClick={async ()=>{
                setBillingLoading(true);
                try {
                  // ...刷新账单逻辑
                  const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
                  const lbase = launchUrl.replace(/\/$/, '');
                  const by: Record<string, any[]> = {};
                  let nb = false;
                  const calls = addPaymentTargets.map(async it => {
                    const pid = String(it.profileId);
                    try {
                      const j = await fetch(`${lbase}/api/facebook/billing`, { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET }, 
                        body: JSON.stringify({ profileId: pid }) 
                      }).then(r=>r.json());
                      const arr = Array.isArray(j?.methods) ? j.methods : [];
                      if (String(j?.status||'')==='no_browser') nb = true;
                      by[pid] = arr;
                    } catch { by[pid] = []; }
                  });
                  await Promise.allSettled(calls);
                  try {
                    const authToken = token || localStorage.getItem('auth_token');
                    const r = await fetch(`/api/billing-methods`, { headers: { 'Authorization': `Bearer ${authToken}` } });
                    const j = await r.json();
                    const list = Array.isArray(j?.data) ? j.data : [];
                    const pidSet = new Set(addPaymentTargets.map(t=>String(t.profileId)));
                    for (const pid of Array.from(pidSet)) {
                      const stash = list.filter((x:any)=>String(x.profileId||'')===pid).map((m:any)=>({ type: String(m.type||''), last4: String(m.last4||'') }));
                      const src = Array.isArray(by[pid]) ? by[pid] : [];
                      const merged = [...src, ...stash];
                      const uniq = [] as any[];
                      const seen = new Set<string>();
                      for (const m of merged) { const k = String(m.last4||''); if (!seen.has(k) && k) { seen.add(k); uniq.push(m); } }
                      by[pid] = uniq;
                    }
                  } catch {}
                  setBillingMethodsByProfile(by);
                  if (nb) setAddPaymentError('部分目标未启动浏览器或未登录，请先启动后刷新账单');
                } catch {}
                finally { setBillingLoading(false); }
              }} className="px-3 py-1.5 rounded-lg text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all">🔄 刷新账单</button>
              <button onClick={async ()=>{
                setAddPaymentError('');
                setBillingLoading(true);
                try {
                  const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
                  const lbase = launchUrl.replace(/\/$/, '');
                  const pids = Array.from(new Set(addPaymentTargets.map(t=>String(t.profileId))));
                  // 🚦 每个启动都是一条最长 180s 的长请求，N 个并发会瞬间占满 9999 的连接；
                  //    套上闸门（同时最多 3 条），避免把整页对 9999 的请求全堵死。
                  const startTasks = pids.map(pid => withLongRequestSlot(() => fetch(`http://localhost:9999/api/launch-browser`, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET }, 
                    body: JSON.stringify({ profileId: pid, borrow: true }) 
                  })).then(r=>r.json()).catch(()=>({ success:false })));
                  await Promise.allSettled(startTasks);
                  const by: Record<string, any[]> = {};
                  let nb = false;
                  const calls = addPaymentTargets.map(async it => {
                    const pid = String(it.profileId);
                    try {
                      const j = await fetch(`${lbase}/api/facebook/billing`, { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET }, 
                        body: JSON.stringify({ profileId: pid }) 
                      }).then(r=>r.json());
                      const arr = Array.isArray(j?.methods) ? j.methods : [];
                      if (String(j?.status||'')==='no_browser') nb = true;
                      by[pid] = arr;
                    } catch { by[pid] = []; }
                  });
                  await Promise.allSettled(calls);
                  try {
                    const authToken = token || localStorage.getItem('auth_token');
                    const r = await fetch(`/api/billing-methods`, { headers: { 'Authorization': `Bearer ${authToken}` } });
                    const j = await r.json();
                    const list = Array.isArray(j?.data) ? j.data : [];
                    const pidSet = new Set(addPaymentTargets.map(t=>String(t.profileId)));
                    for (const pid of Array.from(pidSet)) {
                      const stash = list.filter((x:any)=>String(x.profileId||'')===pid).map((m:any)=>({ type: String(m.type||''), last4: String(m.last4||'') }));
                      const src = Array.isArray(by[pid]) ? by[pid] : [];
                      const merged = [...src, ...stash];
                      const uniq = [] as any[];
                      const seen = new Set<string>();
                      for (const m of merged) { const k = String(m.last4||''); if (!seen.has(k) && k) { seen.add(k); uniq.push(m); } }
                      by[pid] = uniq;
                    }
                  } catch {}
                  setBillingMethodsByProfile(prev => ({ ...prev, ...by }));
                  if (nb) setAddPaymentError('部分目标未启动浏览器或未登录，请先启动后刷新账单');
                } catch {}
                finally { setBillingLoading(false); }
              }} className="px-3 py-1.5 rounded-lg text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all">🚀 启动并刷新</button>
            </div>
            {/* 🚀 优化：表单卡片区域 - 3列布局 */}
            {addMode==='manual' ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                {/* 卡片信息 */}
                <div className="md:col-span-2 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                  <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />卡片信息</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-xs text-slate-400 mb-1">卡号</label>
                      <input value={cardNumber} onChange={e=>setCardNumber(e.target.value.replace(/\D/g,''))} maxLength={16} placeholder="4242424242424242" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm font-mono" />
                      <div className="mt-1 text-[11px] text-slate-400">
                        <span className="mr-3">类型：{detectNetwork(cardNumber) || '—'}</span>
                        <span>后四位：{String(cardNumber||'').replace(/\D/g,'').slice(-4) || '—'}</span>
                      </div>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-slate-400 mb-1">持卡人姓名</label>
                      <input value={cardHolder} onChange={e=>setCardHolder(e.target.value)} placeholder="JOHN DOE" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">有效期 (月)</label>
                      <select value={cardExpiryMonth} onChange={e=>setCardExpiryMonth(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                        <option value="">月</option>
                        {Array.from({length:12},(_,i)=>String(i+1).padStart(2,'0')).map(m=>(<option key={m} value={m}>{m}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">有效期 (年)</label>
                      <select value={cardExpiryYear} onChange={e=>setCardExpiryYear(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                        <option value="">年</option>
                        {Array.from({length:10},(_,i)=>String(new Date().getFullYear()+i)).map(y=>(<option key={y} value={y}>{y}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">CVV</label>
                      <input value={cardCvv} onChange={e=>setCardCvv(e.target.value.replace(/\D/g,''))} maxLength={4} placeholder="123" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm font-mono" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">街道地址</label>
                        <input value={cardAddress} onChange={e=>setCardAddress(e.target.value)} placeholder="123 Main St" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">城市</label>
                        <input value={cardCity} onChange={e=>setCardCity(e.target.value)} placeholder="New York" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">邮编</label>
                        <input value={cardZip} onChange={e=>setCardZip(e.target.value)} placeholder="10001" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm font-mono" />
                      </div>
                    </div>
                    <button type="button" onClick={() => {
                      const addr = generateRandomAddress(cardIso);
                      setCardAddress(addr.street);
                      setCardCity(addr.city);
                      setCardZip(addr.zip);
                    }} className="mt-1 px-2 py-1 bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 rounded text-xs hover:bg-emerald-600/30 transition-colors">
                      随机生成地址
                    </button>
                  </div>
                </div>
                {/* 账单 & 附加信息 */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                  <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />附加信息</h4>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">账单地址</label>
                      <input value={cardAddress} onChange={e=>setCardAddress(e.target.value)} placeholder="123 Main St, City" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">国家</label>
                        <select value={cardIso} onChange={e => setCardIso(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                          <option value="US">United States</option>
                          <option value="GB">United Kingdom</option>
                          <option value="DE">Germany</option>
                          <option value="FR">France</option>
                          <option value="IT">Italy</option>
                          <option value="ES">Spain</option>
                          <option value="JP">Japan</option>
                          <option value="KR">South Korea</option>
                          <option value="SG">Singapore</option>
                          <option value="AU">Australia</option>
                          <option value="CA">Canada</option>
                          <option value="CN">China</option>
                          <option value="TW">Taiwan</option>
                          <option value="TH">Thailand</option>
                          <option value="VN">Vietnam</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">货币代码</label>
                        <select value={cardBindCurrency} onChange={e => setCardBindCurrency(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                          <option value="">不修改</option>
                          <option value="USD">USD ($)</option>
                          <option value="EUR">EUR (€)</option>
                          <option value="GBP">GBP (£)</option>
                          <option value="JPY">JPY (¥)</option>
                          <option value="KRW">KRW (₩)</option>
                          <option value="SGD">SGD (S$)</option>
                          <option value="VND">VND (₫)</option>
                          <option value="THB">THB (฿)</option>
                          <option value="AUD">AUD (A$)</option>
                          <option value="CAD">CAD (C$)</option>
                          <option value="CNY">CNY (¥)</option>
                          <option value="TWD">TWD (NT$)</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">时区（FB 时区ID）</label>
                      <select value={cardBindTimezone} onChange={e => setCardBindTimezone(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                        <option value="">不修改</option>
                        <option value="4">(GMT-08:00) Los Angeles</option>
                        <option value="4">(GMT-08:00) San Francisco</option>
                        <option value="4">(GMT-08:00) Seattle</option>
                        <option value="5">(GMT-07:00) Denver</option>
                        <option value="5">(GMT-07:00) Phoenix</option>
                        <option value="6">(GMT-06:00) Chicago</option>
                        <option value="6">(GMT-06:00) Dallas</option>
                        <option value="6">(GMT-06:00) Houston</option>
                        <option value="6">(GMT-06:00) Mexico City</option>
                        <option value="7">(GMT-05:00) New York</option>
                        <option value="7">(GMT-05:00) Miami</option>
                        <option value="7">(GMT-05:00) Toronto</option>
                        <option value="8">(GMT-04:00) Halifax</option>
                        <option value="9">(GMT-03:00) Brasilia</option>
                        <option value="9">(GMT-03:00) Buenos Aires</option>
                        <option value="12">(GMT+00:00) London</option>
                        <option value="12">(GMT+00:00) Dublin</option>
                        <option value="12">(GMT+00:00) Lisbon</option>
                        <option value="13">(GMT+01:00) Berlin</option>
                        <option value="13">(GMT+01:00) Paris</option>
                        <option value="13">(GMT+01:00) Rome</option>
                        <option value="13">(GMT+01:00) Madrid</option>
                        <option value="14">(GMT+02:00) Helsinki</option>
                        <option value="14">(GMT+02:00) Kyiv</option>
                        <option value="14">(GMT+02:00) Athens</option>
                        <option value="15">(GMT+03:00) Moscow</option>
                        <option value="15">(GMT+03:00) Istanbul</option>
                        <option value="16">(GMT+04:00) Dubai</option>
                        <option value="16">(GMT+04:00) Abu Dhabi</option>
                        <option value="17">(GMT+05:00) Karachi</option>
                        <option value="17">(GMT+05:00) Islamabad</option>
                        <option value="18">(GMT+05:30) Mumbai</option>
                        <option value="18">(GMT+05:30) New Delhi</option>
                        <option value="18">(GMT+05:30) Kolkata</option>
                        <option value="18">(GMT+05:30) Chennai</option>
                        <option value="19">(GMT+06:00) Dhaka</option>
                        <option value="19">(GMT+06:00) Almaty</option>
                        <option value="20">(GMT+07:00) Bangkok</option>
                        <option value="20">(GMT+07:00) Jakarta</option>
                        <option value="20">(GMT+07:00) Hanoi</option>
                        <option value="21">(GMT+08:00) Beijing</option>
                        <option value="21">(GMT+08:00) Shanghai</option>
                        <option value="21">(GMT+08:00) Hong Kong</option>
                        <option value="21">(GMT+08:00) Singapore</option>
                        <option value="22">(GMT+09:00) Tokyo</option>
                        <option value="22">(GMT+09:00) Seoul</option>
                        <option value="23">(GMT+10:00) Sydney</option>
                        <option value="23">(GMT+10:00) Melbourne</option>
                        <option value="23">(GMT+10:00) Brisbane</option>
                        <option value="25">(GMT+12:00) Auckland</option>
                        <option value="25">(GMT+12:00) Wellington</option>
                        <option value="25">(GMT+12:00) Fiji</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">邮编</label>
                      <input value={cardZip} onChange={e=>setCardZip(e.target.value)} placeholder="10001" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm font-mono" />
                    </div>
                  </div>
                </div>
              </div>
            ) : addMode==='existing' ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                {/* 卡片选择 */}
                <div className="md:col-span-2 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                  <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />选择已有卡片</h4>
                  <div className="flex gap-2 mb-3">
                    <select value={cardTagFilter} onChange={e=>setCardTagFilter(e.target.value)} className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 text-xs px-2 py-1.5 rounded-lg">
                      <option value="">全部标签</option>
                      {tagOptions.map(opt=> (<option key={opt} value={opt}>{opt}</option>))}
                    </select>
                    <select value={cardChannelFilter} onChange={e=>setCardChannelFilter(e.target.value)} className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 text-xs px-2 py-1.5 rounded-lg">
                      <option value="">全部渠道</option>
                      {channelOptions.map(opt=> (<option key={opt} value={opt}>{opt}</option>))}
                    </select>
                  </div>
                  {/* 🚀 修复：同时检查本地卡片和 state */}
                  {(addPaymentTargets.every(a => (billingMethodsByProfile[String(a.profileId)]||[]).length===0) && 
                    (() => { try { const raw = localStorage.getItem('billingMethodsByProfile'); return !raw || JSON.parse(raw)['local']?.length === 0; } catch { return true; } })()
                  ) && (
                    <div className="text-xs text-slate-500 py-2">暂无可选卡片，请先在卡片管理添加本地卡片，或启动浏览器刷新账单</div>
                  )}
                  <select disabled={billingLoading} value={selectedMethod ? `${selectedMethod.profileId}:${selectedMethod.last4||''}:${selectedMethod.type||''}` : ''} onChange={e=>{
                    const v = e.target.value; const parts = v.split(':');
                    const pid = parts[0]; const last4 = parts.slice(1,-1).join(':')||parts[1]; const type = parts[parts.length-1];
                    const allCards = getAllCards();
                    const filtered = allCards.filter(m=>{if(m._pid!==pid)return false;if(m.last4!==last4)return false;if(cardTagFilter&&(!Array.isArray(m.tags)||!m.tags.includes(cardTagFilter)))return false;if(cardChannelFilter&&m.channel!==cardChannelFilter)return false;return true;});
                    const found = filtered.find(m=>m.last4===last4);
                    setSelectedMethod(found?{profileId:pid,last4:found.last4,type:found.type||found.brand}:null);
                  }} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                    <option value="">请选择卡片</option>
                    {(()=>{
                      const allCards = getAllCards().filter(m => {
                        if (cardTagFilter && (!Array.isArray(m.tags) || !m.tags.includes(cardTagFilter))) return false;
                        if (cardChannelFilter && m.channel !== cardChannelFilter) return false;
                        return true;
                      });
                      return allCards.map(m=>(<option key={`${m._pid}:${m.last4||''}:${m.type||''}`} value={`${m._pid}:${m.last4||''}:${m.type||''}`}>{m.source==='local'?'📦':'🌐'} {m._pid.slice(0,8)} {m.type||'Card'}({m.last4||'****'}) {m.channel?`[${m.channel}]`:''} {Array.isArray(m.tags)&&m.tags.length?`#${m.tags.join(',')}`:''} {m.alias?`"${m.alias}"`:''}</option>));
                    })()}
                  </select>
                  <div className="mt-1 text-[11px] text-slate-500">📦=本地卡片 🌐=账单卡片 · 共 {getAllCards().length} 张</div>
                </div>
                {/* 附加信息 */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                  <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />附加信息</h4>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">国家</label>
                        <select value={cardIso} onChange={e => setCardIso(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                          <option value="US">United States</option>
                          <option value="GB">United Kingdom</option>
                          <option value="DE">Germany</option>
                          <option value="FR">France</option>
                          <option value="IT">Italy</option>
                          <option value="ES">Spain</option>
                          <option value="JP">Japan</option>
                          <option value="KR">South Korea</option>
                          <option value="SG">Singapore</option>
                          <option value="AU">Australia</option>
                          <option value="CA">Canada</option>
                          <option value="CN">China</option>
                          <option value="TW">Taiwan</option>
                          <option value="TH">Thailand</option>
                          <option value="VN">Vietnam</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">货币代码</label>
                        <select value={cardBindCurrency} onChange={e => setCardBindCurrency(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                          <option value="">不修改</option>
                          <option value="USD">USD ($)</option>
                          <option value="EUR">EUR (€)</option>
                          <option value="GBP">GBP (£)</option>
                          <option value="JPY">JPY (¥)</option>
                          <option value="KRW">KRW (₩)</option>
                          <option value="SGD">SGD (S$)</option>
                          <option value="VND">VND (₫)</option>
                          <option value="THB">THB (฿)</option>
                          <option value="AUD">AUD (A$)</option>
                          <option value="CAD">CAD (C$)</option>
                          <option value="CNY">CNY (¥)</option>
                          <option value="TWD">TWD (NT$)</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">时区（FB 时区ID）</label>
                      <select value={cardBindTimezone} onChange={e => setCardBindTimezone(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                        <option value="">不修改</option>
                        <option value="4">(GMT-08:00) Los Angeles</option>
                        <option value="4">(GMT-08:00) San Francisco</option>
                        <option value="4">(GMT-08:00) Seattle</option>
                        <option value="5">(GMT-07:00) Denver</option>
                        <option value="5">(GMT-07:00) Phoenix</option>
                        <option value="6">(GMT-06:00) Chicago</option>
                        <option value="6">(GMT-06:00) Dallas</option>
                        <option value="6">(GMT-06:00) Houston</option>
                        <option value="6">(GMT-06:00) Mexico City</option>
                        <option value="7">(GMT-05:00) New York</option>
                        <option value="7">(GMT-05:00) Miami</option>
                        <option value="7">(GMT-05:00) Toronto</option>
                        <option value="8">(GMT-04:00) Halifax</option>
                        <option value="9">(GMT-03:00) Brasilia</option>
                        <option value="9">(GMT-03:00) Buenos Aires</option>
                        <option value="12">(GMT+00:00) London</option>
                        <option value="12">(GMT+00:00) Dublin</option>
                        <option value="12">(GMT+00:00) Lisbon</option>
                        <option value="13">(GMT+01:00) Berlin</option>
                        <option value="13">(GMT+01:00) Paris</option>
                        <option value="13">(GMT+01:00) Rome</option>
                        <option value="13">(GMT+01:00) Madrid</option>
                        <option value="14">(GMT+02:00) Helsinki</option>
                        <option value="14">(GMT+02:00) Kyiv</option>
                        <option value="14">(GMT+02:00) Athens</option>
                        <option value="15">(GMT+03:00) Moscow</option>
                        <option value="15">(GMT+03:00) Istanbul</option>
                        <option value="16">(GMT+04:00) Dubai</option>
                        <option value="16">(GMT+04:00) Abu Dhabi</option>
                        <option value="17">(GMT+05:00) Karachi</option>
                        <option value="17">(GMT+05:00) Islamabad</option>
                        <option value="18">(GMT+05:30) Mumbai</option>
                        <option value="18">(GMT+05:30) New Delhi</option>
                        <option value="18">(GMT+05:30) Kolkata</option>
                        <option value="18">(GMT+05:30) Chennai</option>
                        <option value="19">(GMT+06:00) Dhaka</option>
                        <option value="19">(GMT+06:00) Almaty</option>
                        <option value="20">(GMT+07:00) Bangkok</option>
                        <option value="20">(GMT+07:00) Jakarta</option>
                        <option value="20">(GMT+07:00) Hanoi</option>
                        <option value="21">(GMT+08:00) Beijing</option>
                        <option value="21">(GMT+08:00) Shanghai</option>
                        <option value="21">(GMT+08:00) Hong Kong</option>
                        <option value="21">(GMT+08:00) Singapore</option>
                        <option value="22">(GMT+09:00) Tokyo</option>
                        <option value="22">(GMT+09:00) Seoul</option>
                        <option value="23">(GMT+10:00) Sydney</option>
                        <option value="23">(GMT+10:00) Melbourne</option>
                        <option value="23">(GMT+10:00) Brisbane</option>
                        <option value="25">(GMT+12:00) Auckland</option>
                        <option value="25">(GMT+12:00) Wellington</option>
                        <option value="25">(GMT+12:00) Fiji</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">街道地址</label>
                        <input value={cardAddress} onChange={e=>setCardAddress(e.target.value)} placeholder="123 Main St" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">城市</label>
                        <input value={cardCity} onChange={e=>setCardCity(e.target.value)} placeholder="New York" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">邮编</label>
                        <input value={cardZip} onChange={e=>setCardZip(e.target.value)} placeholder="10001" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm font-mono" />
                      </div>
                      <div className="flex items-end">
                        <button type="button" onClick={() => {
                          const addr = generateRandomAddress(cardIso);
                          setCardAddress(addr.street);
                          setCardCity(addr.city);
                          setCardZip(addr.zip);
                        }} className="w-full px-3 py-2 bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 rounded-lg text-xs hover:bg-emerald-600/30 transition-colors">
                          随机生成地址
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">渠道</label>
                      <div className="flex gap-2">
                        <select value={cardChannel} onChange={e=>setCardChannel(e.target.value)} className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                          <option value="">选择</option>
                          {channelOptions.map(opt=> (<option key={opt} value={opt}>{opt}</option>))}
                        </select>
                        <input value={cardChannel} onChange={e=>setCardChannel(e.target.value)} placeholder="自定义" className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">标签</label>
                      <div className="flex gap-2">
                        <select value={cardTag} onChange={e=>setCardTag(e.target.value)} className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                          <option value="">选择</option>
                          {tagOptions.map(opt=> (<option key={opt} value={opt}>{opt}</option>))}
                        </select>
                        <input value={cardTag} onChange={e=>setCardTag(e.target.value)} placeholder="自定义" className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                {/* 渠道/标签选择 → 自动遍历 */}
                <div className="md:col-span-2 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                  <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />按渠道/标签自动遍历</h4>
                  <p className="text-xs text-slate-400 mb-3">选择渠道或标签，系统自动找出匹配卡片依次尝试绑定</p>
                  <div className="flex gap-2 mb-3">
                    <select value={cardChannelFilter} onChange={e=>setCardChannelFilter(e.target.value)} className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 text-xs px-2 py-1.5 rounded-lg">
                      <option value="">全部渠道</option>
                      {channelOptions.map(opt=> (<option key={opt} value={opt}>{opt}</option>))}
                    </select>
                    <select value={cardTagFilter} onChange={e=>setCardTagFilter(e.target.value)} className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 text-xs px-2 py-1.5 rounded-lg">
                      <option value="">全部标签</option>
                      {tagOptions.map(opt=> (<option key={opt} value={opt}>{opt}</option>))}
                    </select>
                  </div>
                  {(() => {
                    const matched = getAllCards().filter(m => {
                      if (cardChannelFilter && m.channel !== cardChannelFilter) return false;
                      if (cardTagFilter && (!Array.isArray(m.tags) || !m.tags.includes(cardTagFilter))) return false;
                      return true;
                    });
                    return (
                      <div className="text-xs text-slate-500">
                        {cardChannelFilter || cardTagFilter ? `匹配到 ${matched.length} 张卡片，将依次尝试绑定` : '请选择渠道或标签筛选卡片'}
                      </div>
                    );
                  })()}
                  {/* 显示匹配的卡片列表预览 */}
                  {(() => {
                    const matched = getAllCards().filter(m => {
                      if (cardChannelFilter && m.channel !== cardChannelFilter) return false;
                      if (cardTagFilter && (!Array.isArray(m.tags) || !m.tags.includes(cardTagFilter))) return false;
                      return true;
                    });
                    if (matched.length === 0) return null;
                    return (
                      <div className="mt-3 max-h-40 overflow-y-auto space-y-1">
                        {matched.map(m => (
                          <div key={m.id} className="flex items-center gap-2 px-2 py-1 rounded bg-slate-900/50 text-xs text-slate-300">
                            <span className="font-mono text-indigo-300">{m.card_last4 || m.cardNumber?.slice(-4)}</span>
                            <span className="text-slate-500">{m.channel || '—'}</span>
                            <span className="text-slate-500">{Array.isArray(m.tags) ? m.tags.slice(0,3).join(',') : ''}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
                {/* 附加信息 */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                  <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />附加信息</h4>
                  <p className="text-xs text-slate-400 mb-3">遍历绑卡将依次尝试匹配的卡片</p>
                </div>
              </div>
            )}
            <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
              <button onClick={() => setIsAddPaymentOpen(false)} className="px-4 py-2 bg-slate-800 text-slate-200 rounded-lg hover:bg-slate-700">取消</button>
              <button disabled={addPaymentLoading || addPaymentTargets.length===0 || (addMode==='manual' ? !(cardNumber && cardHolder && cardExpiryMonth && cardExpiryYear && cardCvv) : addMode==='existing' ? !selectedMethod : !(cardChannelFilter || cardTagFilter))} onClick={async () => {
                if (!addPaymentTargets.length) { setAddPaymentError('请先选择至少一个目标'); return; }
                setAddPaymentLoading(true);
                setAddPaymentError('');
                try {
                  const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
                  const lbase = launchUrl.replace(/\/$/, '');
                  // 🚀 按 profileId 分组，同一配置的广告号顺序绑卡（复用浏览器），不同配置并行
                  const pidGroups: Record<string, typeof addPaymentTargets> = {};
                  addPaymentTargets.forEach(item => {
                    const pid = String(item.profileId);
                    if (!pidGroups[pid]) pidGroups[pid] = [];
                    pidGroups[pid].push(item);
                  });
                  const results: any[] = [];
                  for (const [pid, items] of Object.entries(pidGroups)) {
                    for (const item of items) {
                      const accId = String(item.adAccountId || item.accountId || '');
                      let itemResult: any = { success: false };
                      if (addMode==='auto') {
                        // 🚀 自动遍历模式：找到匹配的卡片，依次尝试绑定
                        const matched = getAllCards().filter(m => {
                          if (cardChannelFilter && m.channel !== cardChannelFilter) return false;
                          if (cardTagFilter && (!Array.isArray(m.tags) || !m.tags.includes(cardTagFilter))) return false;
                          return true;
                        });
                        for (const mCard of matched) {
                          const ccNumber = mCard.cardNumber || '';
                          const ccExpMonth = mCard.exp_month || '';
                          const ccExpYear = mCard.exp_year || '';
                          const ccCvv = mCard.cvv || '';
                          const ccHolder = mCard.holder || 'Cardholder';
                          if (!ccNumber) continue;
                          const payload = {
                            profileId: pid, adAccountId: accId, mode: 'manual',
                            card: {
                              number: ccNumber, holder: ccHolder,
                              exp_month: ccExpMonth, exp_year: ccExpYear,
                              cvv: ccCvv,
                              billing_address: cardAddress || mCard.billing_address || '',
                              city: cardCity || '', zip: cardZip || '',
                              country_code: cardIso
                            },
                            channel: cardChannel, tag: cardTag, currency: cardBindCurrency || undefined,
                            timezone_id: cardBindTimezone || undefined
                          };
                          try {
                            const resp = await fetch(`${lbase}/api/facebook/billing/add`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                              body: JSON.stringify(payload)
                            });
                            const json = await resp.json();
                            if (json?.success) {
                              itemResult = { success: true, method: mCard.card_last4 || mCard.cardNumber?.slice(-4) };
                              break;
                            }
                          } catch {}
                        }
                        if (!itemResult.success) itemResult = { success: false, error: '所有卡片均绑定失败' };
                      } else {
                        const payload = addMode==='manual'
                          ? { profileId: pid, adAccountId: accId, mode: 'manual', card: { number: cardNumber, holder: cardHolder, exp_month: cardExpiryMonth, exp_year: cardExpiryYear, cvv: cardCvv, billing_address: cardAddress, city: cardCity, zip: cardZip, country_code: cardIso }, channel: cardChannel, tag: cardTag, currency: cardBindCurrency || undefined, timezone_id: cardBindTimezone || undefined }
                          : { profileId: pid, adAccountId: accId, mode: 'existing', method: selectedMethod, channel: cardChannel, tag: cardTag, card: { country_code: cardIso, billing_address: cardAddress, city: cardCity, zip: cardZip }, currency: cardBindCurrency || undefined, timezone_id: cardBindTimezone || undefined };
                        try {
                          itemResult = await fetch(`${lbase}/api/facebook/billing/add`, { 
                            method: 'POST', 
                            headers: { 
                              'Content-Type': 'application/json',
                              'X-Api-Secret': LOCAL_SERVER_SECRET
                            }, 
                            body: JSON.stringify(payload) 
                          }).then(r=>r.json()).catch(()=>({ success:false }));
                        } catch { itemResult = { success: false }; }
                      }
                      results.push(itemResult);
                    }
                  }
                  try {
                    const failed = results.filter(r=> !r?.success);
                    if (failed.length) {
                      const first = failed[0];
                      const msg = first?.error || first?.message || first?.status || 'failed';
                      setAddPaymentError(`添加失败: ${msg}`);
                    }
                  } catch {}
                  try {
                    // 🚀 修正：从 Cloudflare API 刷新卡片列表
                    const authToken = token || localStorage.getItem('auth_token');
                    const r = await fetch(`/api/billing-methods`, {
                      headers: { 'Authorization': `Bearer ${authToken}` }
                    });
                    const j = await r.json();
                    const list = Array.isArray(j?.data) ? j.data : [];
                    const by: Record<string, any[]> = {};
                    for (const m of list) {
                      const pid = String(m.profile_id || '');
                      if (!by[pid]) by[pid] = [];
                      by[pid].push(m);
                    }
                    setBillingMethodsByProfile(prev => ({ ...prev, ...by }));
                  } catch {}
                // 🚀 修正：不关闭弹窗，让用户看到结果。改为显示成功消息
                try {
                  const firstSuccess = results.find(r=>r?.success);
                  if (firstSuccess) {
                    const msg = firstSuccess?.message || '卡片已保存，浏览器正在填写中...';
                    setAddPaymentError(msg); // 用 error 区域显示成功消息（绿色）
                  }
                } catch {}
                // 不再自动关闭 setIsAddPaymentOpen(false)
                } catch (e) {
                  setAddPaymentError('添加支付失败');
                } finally {
                  setAddPaymentLoading(false);
                }
              }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">确认添加</button>
            </div>
          </div>
        </div>
      )}
      {isPageCreatorOpen && (
        <PageCreator
          profileIds={createTargets}
          onCancel={() => setIsPageCreatorOpen(false)}
          onConfirm={async (data: PageCreationData) => {
            setIsPageCreatorOpen(false);
            const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://127.0.0.1:9999';
            const lbase = launchUrl.replace(/\/$/, '');
            const pro = profiles || [];
            const fileToBase64 = (file: File): Promise<string> => {
              return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.readAsDataURL(file);
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = error => reject(error);
              });
            };
            const profileImageBase64 = data.profileImage ? await fileToBase64(data.profileImage) : undefined;
            const backgroundImageBase64 = data.backgroundImage ? await fileToBase64(data.backgroundImage) : undefined;
            const rs: any[] = [];
            for (const pid of createTargets) {
              const prof = pro.find(p => String(p.id) === String(pid));
              const payload: any = { profileId: pid, name: data.name, category: data.category, useApi: data.useApi, accessToken: prof?.token || '', profileImage: profileImageBase64, backgroundImage: backgroundImageBase64 };
              if (data.proxyOverride) payload.proxyOverride = data.proxyOverride;
              try {
                const res = await fetch(`${lbase}/api/facebook/pages/create`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify(payload)
                });
                const json = await res.json();
                rs.push(json?.success ? { ok: true } : { ok: false, error: json?.message || '未知错误' });
              } catch (e: any) { rs.push({ ok: false, error: e.message }); }
            }
            const okCount = rs.filter(x => x.ok).length;
            const fails = rs.filter(x => !x.ok);
            let failMsg = '';
            if (fails.length > 0) failMsg = '\n\n失败详情:\n' + fails.map(f => `配置ID ${f.id || ''}: ${f.error}`).join('\n');
            alert(`主页创建完成：共 ${rs.length} 个，成功 ${okCount} 个。${failMsg}`);
            if (okCount > 0) try { refreshPages(); } catch {}
          }}
        />
      )}
      {isSmartPublishOpen && (
        <SmartPublishDialog
          open={isSmartPublishOpen}
          onClose={() => setIsSmartPublishOpen(false)}
          profileIds={Array.from(new Set(targets.map((i: any) => String(i.profileId || i.profile_id || '')).filter(Boolean)))}
          adAccountIds={assetType === 'adAccounts'
            ? Array.from(new Set(targets.map((i: any) => String(i[uniqueIdKey] || '')).filter(Boolean)))
            : undefined}
          businesses={assetType === 'bms'
            ? Array.from(new Map(
                targets
                  .map((i: any) => ({ profileId: String(i.profileId || i.profile_id || ''), businessId: String(i[uniqueIdKey] || i.bmId || '') }))
                  .filter((b: any) => b.profileId && b.businessId)
                  .map((b: any) => [`${b.profileId}::${b.businessId}`, b]),
              ).values()) as Array<{ profileId: string; businessId: string }>
            : undefined}
          assetType={assetType === 'bms' ? 'bms' : 'adAccounts'}
        />
      )}
      {isCreateBMOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl shadow-2xl flex flex-col">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">创建BM</h3>
              <button onClick={() => setIsCreateBMOpen(false)} className="text-slate-400 hover:text-white p-2">关闭</button>
            </div>
            <div className="p-6 space-y-3">
              <div className="text-slate-300 text-sm">目标数量：<span className="font-mono text-slate-200">{createTargets.length}</span></div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-slate-400">BM名称</label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={isRandomBMName}
                      onChange={(e) => {
                        setIsRandomBMName(e.target.checked);
                        if (e.target.checked) {
                          const rn = RANDOM_BM_NAMES[Math.floor(Math.random() * RANDOM_BM_NAMES.length)];
                          const suffix = Math.floor(1000 + Math.random() * 9000);
                          setCreateBMName(`${rn} ${suffix}`);
                        }
                      }}
                      className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600"
                    />
                    <RefreshCw className={`w-3 h-3 ${isRandomBMName ? 'text-indigo-400' : 'text-slate-500'}`} />
                    随机生成
                  </label>
                </div>
                <div className="flex gap-2">
                  <input
                    value={createBMName}
                    onChange={(e) => {
                      setCreateBMName(e.target.value);
                      if (isRandomBMName) setIsRandomBMName(false);
                    }}
                    placeholder="输入BM名称或勾选随机生成"
                    className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded"
                  />
                  {isRandomBMName && (
                    <button
                      type="button"
                      onClick={() => {
                        const rn = RANDOM_BM_NAMES[Math.floor(Math.random() * RANDOM_BM_NAMES.length)];
                        const suffix = Math.floor(1000 + Math.random() * 9000);
                        setCreateBMName(`${rn} ${suffix}`);
                      }}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded text-sm flex items-center gap-1"
                      title="换一个"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      换
                    </button>
                  )}
                </div>
              </div>
              <input value={createBMCountry} onChange={e=>setCreateBMCountry(e.target.value)} placeholder="国家(可选)" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded" />
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-slate-300 text-sm">邮箱</label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
                    <input type="checkbox" checked={isRandomBMEmail} onChange={e => { setIsRandomBMEmail(e.target.checked); if (e.target.checked) setCreateBMEmail(''); }} className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                    后台自动生成长随机邮箱
                  </label>
                </div>
                <div className="flex gap-2">
                  <input value={createBMEmail} onChange={e=>setCreateBMEmail(e.target.value)} placeholder={isRandomBMEmail ? '后台自动生成' : 'user@example.com'} disabled={isRandomBMEmail} className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-40" />
                  <button type="button" onClick={() => setCreateBMEmail(generateRandomEmail())} disabled={isRandomBMEmail} title="随机生成邮箱" className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm shrink-0 flex items-center gap-1 disabled:opacity-40">🎲 <span className="text-xs">随机</span></button>
                </div>
              </div>
              {/* 👤 名字 / 姓氏（可选；各自可勾「用配置 ID」） */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-slate-300 text-sm">名字 <span className="text-slate-500 text-xs">(可选)</span></label>
                    <label className="flex items-center gap-1 text-xs text-slate-400 cursor-pointer select-none">
                      <input type="checkbox" checked={useProfileIdFirstName} onChange={e=>setUseProfileIdFirstName(e.target.checked)} className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                      用配置 ID
                    </label>
                  </div>
                  <input value={useProfileIdFirstName ? '' : bmFirstName} onChange={e=>setBmFirstName(e.target.value)} disabled={useProfileIdFirstName}
                    placeholder={useProfileIdFirstName ? '该配置的 ID' : 'John'}
                    className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-40" />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-slate-300 text-sm">姓氏 <span className="text-slate-500 text-xs">(可选)</span></label>
                    <label className="flex items-center gap-1 text-xs text-slate-400 cursor-pointer select-none">
                      <input type="checkbox" checked={useProfileIdLastName} onChange={e=>setUseProfileIdLastName(e.target.checked)} className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                      用配置 ID
                    </label>
                  </div>
                  <input value={useProfileIdLastName ? '' : bmLastName} onChange={e=>setBmLastName(e.target.value)} disabled={useProfileIdLastName}
                    placeholder={useProfileIdLastName ? '该配置的 ID' : 'Doe'}
                    className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-40" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 text-sm mb-1">创建数量</label>
                  <input type="number" min={1} max={10} value={createBMCount} onChange={e=>setCreateBMCount(Math.max(1, Math.min(10, Number(e.target.value)||1)))} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded" />
                </div>
                <div className="space-y-2">
                  <label className="inline-flex items-center gap-2 text-slate-300 text-sm"><input type="checkbox" checked={bmCreateAdAccount} onChange={e=>setBmCreateAdAccount(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />创建广告号</label>
                  <label className="inline-flex items-center gap-2 text-slate-300 text-sm"><input type="checkbox" checked={bmCreatePage} onChange={e=>setBmCreatePage(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />创建主页</label>
                </div>
              </div>
              {bmCreatePage && (
                <input value={bmDefaultPageName} onChange={e=>setBmDefaultPageName(e.target.value)} placeholder="默认主页名称(可选)" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded" />
              )}
              {/* 📧 建完自动生成邀请链接 */}
              <div className="space-y-2">
                <label className="inline-flex items-center gap-2 text-slate-300 text-sm">
                  <input type="checkbox" checked={bmInviteEnabled} onChange={e=>setBmInviteEnabled(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
                  建完自动生成邀请链接
                </label>
                {bmInviteEnabled && (
                  <div>
                    <label className="block text-slate-300 text-sm mb-1">每个 BM 邀请链接数量</label>
                    <input type="number" min={1} max={10} value={bmInviteCount} onChange={e=>setBmInviteCount(Math.max(1, Math.min(10, Number(e.target.value)||1)))} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded" />
                    <p className="text-xs text-slate-500 mt-1">每个新建的 BM 自动生成 N 个邀请链接（临时邮箱→邀请→收信提取→写回 BM 列表）。每个链接需轮询收信最长 45s，会明显拉长该项耗时，已放入执行队列后台跑（可关弹窗、可刷新）。</p>
                    {/* 🛒 生成后自动上架商城（联动） */}
                    <label className="inline-flex items-center gap-2 text-slate-300 text-sm mt-2">
                      <input type="checkbox" checked={bmShopPublish} onChange={e=>setBmShopPublish(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
                      生成后自动上架商城
                    </label>
                    {bmShopPublish && (
                      <div className="mt-1">
                        <label className="block text-slate-300 text-sm mb-1">商品价格（USDT）</label>
                        <input type="number" min={0} step={0.5} value={bmShopPrice} onChange={e=>setBmShopPrice(Math.max(0, Number(e.target.value)||0))} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded" />
                        <p className="text-xs text-slate-500 mt-1">每个 BM 一个商品（标题「BM {`{id}`}」），链接作为可发货条目追加；同一 BM 重复上架只追加新链接，不产生重复商品。上架失败不影响链接生成。</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 🔗 建完自动获取信息 */}
              <div className="space-y-2">
                <label className="inline-flex items-center gap-2 text-slate-300 text-sm">
                  <input type="checkbox" checked={bmAutoFetchInfo} onChange={e=>setBmAutoFetchInfo(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
                  建完自动获取信息
                </label>
                <p className="text-xs text-slate-500">全部 BM 建完后，自动对涉及的配置跑一次「获取信息」，广告号数量、BM 状态、创建时间等立即填充，无需手动再跑。</p>
              </div>

              {/* 🚀 代理选择器 */}
              <div className="pt-2 border-t border-slate-800">
                <label className="block text-slate-300 text-sm mb-2 font-medium">代理（覆盖配置自带代理，不保存）</label>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <select value={bmSelectedProxyId} onChange={e=>{ setBmSelectedProxyIdAV(e.target.value); if(e.target.value) setBmProxyManualInputAV(''); }} className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-2 rounded text-sm col-span-2">
                    <option value="">-- 使用配置自带代理 --</option>
                    {bmProxyList.filter(p=>p).map(px => (
                      <option key={px.id} value={px.id}>
                        {px.name || px.remark || px.id?.substring(0,8)} ({px.host}:{px.port})
                      </option>
                    ))}
                  </select>
                  <select value={bmProxyType} onChange={e=>setBmProxyTypeAV(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-2 rounded text-sm">
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </div>
                <input value={bmProxyManualInput} onChange={e=>{ setBmProxyManualInputAV(e.target.value); if(e.target.value) setBmSelectedProxyIdAV(''); }} placeholder="或手动输入代理: host:port 或 user:pass@host:port" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm" />
              </div>

              {createError && <div className="text-rose-400 text-sm">{createError}</div>}
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
              <button onClick={() => setIsCreateBMOpen(false)} className="px-4 py-2 bg-slate-800 text-slate-200 rounded">取消</button>
              <button onClick={async ()=>{
                if (!createBMName) { setCreateError('请输入名称'); return; }
                setCreating(true); setCreateError('');
                try {
                  // 🚀 解析代理覆盖
                  let proxyOverride: any = undefined;
                  if (bmSelectedProxyId) {
                    proxyOverride = bmProxyList.find(px => px.id === bmSelectedProxyId);
                  } else if (bmProxyManualInput.trim()) {
                    const proxyInput = bmProxyManualInput.trim();
                    const colonCount = (proxyInput.match(/:/g) || []).length;
                    if (colonCount === 1) { const [h,p]=proxyInput.split(':'); proxyOverride={host:h,port:parseInt(p),type:bmProxyType}; }
                    else if (colonCount === 3 && proxyInput.includes('@')) { const [up,hp]=proxyInput.split('@'); const [u,pass]=up.split(':'); const [h,p]=hp.split(':'); proxyOverride={host:h,port:parseInt(p),username:u,password:pass,type:bmProxyType}; }
                    else { proxyOverride={host:proxyInput,port:80,type:bmProxyType}; }
                  }

                  // 🧵 统一走服务端队列（与 BM 批量操作「创建BM」一致）：
                  //    每个「配置 × 创建数量」一个队列项，执行顺序 = 建BM →（可选）广告号 →（可选）主页 →（可选）邀请链接。
                  //    提交即返回，执行/进度/取消见左侧「执行队列」，刷新或切页都不会中断。
                  const jobItems: Array<{ key: string; label: string; payload: any }> = [];
                  const genRandomBMName = () => {
                    const rn = RANDOM_BM_NAMES[Math.floor(Math.random() * RANDOM_BM_NAMES.length)];
                    const suffix = Math.floor(1000 + Math.random() * 9000);
                    return `${rn} ${suffix}`;
                  };
                  for (const pidAny of (createTargets as any[])) {
                    const pid = String(pidAny);
                    for (let i = 0; i < createBMCount; i++) {
                      // 勾选随机名称且创建多个时,每个 BM 使用不同的随机名
                      const currentBMName = isRandomBMName ? genRandomBMName() : createBMName;
                      const pageName = bmDefaultPageName || `${currentBMName}-Page-${i + 1}`;
                      const payload: any = {
                        profileId: pid,
                        name: currentBMName,
                        country: createBMCountry || undefined,
                        email: createBMEmail || undefined,
                        createAdAccount: bmCreateAdAccount,
                        createPage: bmCreatePage,
                        defaultPageName: bmCreatePage ? pageName : undefined,
                        inviteCount: bmInviteEnabled ? bmInviteCount : 0,
                        // 🛒 邀请链接生成后自动上架商城（勾选时透传）
                        shopPublish: bmInviteEnabled ? bmShopPublish : false,
                        shopPrice: bmShopPrice,
                        shopCurrency: 'USDT',
                        proxyOverride,
                      };
                      // 👤 名字/姓氏：勾了「用配置 ID」就用该配置的 profileId（与 BM 批量操作同一口径）
                      const fn = useProfileIdFirstName ? pid : bmFirstName;
                      const ln = useProfileIdLastName ? pid : bmLastName;
                      if (fn) payload.firstName = fn;
                      if (ln) payload.lastName = ln;
                      // 广告号参数与原先直连调用保持一致：名称=BM名、时区 1、USD、建好即授管理员、数量 1
                      if (bmCreateAdAccount) {
                        payload.adNameMode = 'manual';
                        payload.adNameManual = currentBMName;
                        payload.adAccountCount = 1;
                        payload.timezoneId = 1;
                        payload.currency = 'USD';
                      }
                      jobItems.push({ key: `${pid}#${i + 1}`, label: `${pid} / ${currentBMName}`, payload });
                      // 📌 仍然记住默认主页名：详情页打开时自动选中该主页（提交时就知道要建的名字）
                      if (bmCreatePage) {
                        try { const raw = localStorage.getItem('defaultPages'); const map = raw ? JSON.parse(raw) : {}; map[pid] = pageName; localStorage.setItem('defaultPages', JSON.stringify(map)); } catch {}
                      }
                    }
                  }
                  // 🔗 联动：勾选「建完自动获取信息」→ 把获取信息作为同 job 的追加项（项级 type=get_info），
                  //    与创建项同 job 串行执行；服务端同 job 的 hasNextForProfile 查得到它，
                  //    创建项完成时浏览器保留 → 获取信息直接复用，不再冷启动。
                  // 🩺 payload 必须带 withAccountQuality: true，否则 BM 状态探测不会跑。
                  if (bmAutoFetchInfo) {
                    const infoPids = Array.from(new Set((createTargets as any[]).map((x: any) => String(x))));
                    for (const pid of infoPids) {
                      jobItems.push({
                        key: `${pid}#auto-info`,
                        label: `${pid}（创建后自动获取信息）`,
                        type: 'get_info',
                        payload: { profileId: pid, accessToken: 'BROWSER', withAccountQuality: true },
                      } as any);
                    }
                  }
                  const job = await submitQueueJob('create_bm_bundle', `创建BM（${jobItems.filter(j => !j.key.endsWith('#auto-info')).length} 个）`, jobItems);
                  if (!job) return;
                  try { refreshBusinesses(); } catch {}
                  setIsCreateBMOpen(false);
                  // 🔗 建完自动获取信息：队列服务端已经抓完并把数据同步到云端，但前端还得再「落位」
                  //    —— 从后端取回抓取结果写进 localStorage 缓存 + 刷新界面，否则本地列表
                  //    （BM/广告号数量、BM 状态）要等下次手动跑「获取信息」才更新。
                  if (bmAutoFetchInfo) {
                    const autoInfoPids = Array.from(new Set((createTargets as any[]).map((x: any) => String(x))));
                    void (async () => {
                      try { await waitForJob(job.id, () => {}); } catch {}
                      await applyLastAssetsToLocal(autoInfoPids);
                    })();
                  }
                } catch { setCreateError('创建失败'); } finally { setCreating(false); }
              }} disabled={creating} className="px-4 py-2 bg-indigo-600 text-white rounded disabled:opacity-50">{creating?'提交中…':'创建'}</button>
            </div>
          </div>
        </div>
      )}
      
      {/* 🆕 BM 管理操作弹窗 */}
      <BMOperationsDialog
        isOpen={isBMOperationsOpen}
        onClose={() => setIsBMOperationsOpen(false)}
        items={bmOperationsItems}
        // 🔗 弹窗里创建BM勾了「建完自动获取信息」→ 任务跑完把结果落位到本地缓存/界面
        onFetchedAssets={(pids) => { void applyLastAssetsToLocal(pids); }}
      />
      
      <CcyTzDialog
        isOpen={isCcyTzOpen}
        onClose={() => setIsCcyTzOpen(false)}
        initialTarget={targets[0] || null}
        targets={targets}
        tzOptions={TZ_OPTIONS}
        loading={ccyTzLoading}
        onRefresh={refreshAdAccountsFromServer}
        setLoading={setCcyTzLoading}
      />
      
      <GrantPageDialog
        isOpen={isGrantPageOpen}
        onClose={() => setIsGrantPageOpen(false)}
        pagesDb={pagesDb}
        businessesDb={businessesDb}
        defaultProfileId={targets[0]?.profileId || ''}
        onRefresh={refreshAllAssets}
      />

      <AssignPersonalDialog
        isOpen={isAssignPersonalOpen}
        onClose={() => { setIsAssignPersonalOpen(false); }}
        mode={assignPersonalMode}
        sortedData={sortedData}
        selectedIds={selectedIds}
        uniqueIdKey={uniqueIdKey}
        onRefresh={refreshAllAssets}
        profiles={profiles}
      />

      <AssignToBMDialog
        isOpen={isAssignToBmOpen}
        onClose={() => { setIsAssignToBmOpen(false); }}
        sortedData={sortedData}
        selectedIds={selectedIds}
        uniqueIdKey={uniqueIdKey}
        onRefresh={refreshAllAssets}
        token={token}
      />

      <CreateAdAccountDialog
        isOpen={isCreateAdAccountOpen}
        onClose={() => setIsCreateAdAccountOpen(false)}
        sortedData={sortedData}
        selectedIds={selectedIds}
        uniqueIdKey={uniqueIdKey}
        onRefresh={refreshAllAssets}
      />

      {operatorModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !operatorBusy && setOperatorModal(false)}>
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl" onClick={(e: any) => e.stopPropagation()}>
            <h3 className="mb-1 text-lg font-bold text-white">批量设置主页操作员</h3>
            <p className="mb-4 text-xs leading-5 text-slate-400">
              把选中的 {selectedIds.size} 个主页交给新的浏览器配置（操作员）管理：该配置的「消息对话 / 拉取更新 / AI 值守」将接管这些主页；原配置若在值守同一主页会自动让位（谁最新操控谁生效）。
            </p>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">选择新操作员</label>
            <select value={operatorTarget} onChange={(e: any) => setOperatorTarget(e.target.value)}
              className="mb-5 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none">
              <option value="">— 请选择浏览器配置 —</option>
              {profiles.map((p: any) => (
                <option key={String(p.id)} value={String(p.id)}>{p.name || `配置 ${p.id}`}</option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <button onClick={() => setOperatorModal(false)} disabled={operatorBusy}
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">取消</button>
              <button onClick={confirmAssignOperator} disabled={operatorBusy || !operatorTarget}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                {operatorBusy && <RefreshCw className="h-3.5 w-3.5 animate-spin" />} 确认转移
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

