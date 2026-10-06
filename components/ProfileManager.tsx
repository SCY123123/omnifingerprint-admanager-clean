// @ts-nocheck
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserStatus, FingerprintProfile, Platform, AccountStatus } from '../types';
import { Play, Square, Download, Upload, Plus, PlusCircle, Search, MoreHorizontal, Monitor, Trash2, CheckCircle2, AlertTriangle, Ban, ShieldCheck, Wallet, Globe, ArrowUp, ArrowDown, Pencil, X, Eye, EyeOff, Copy, Key, Briefcase, BarChartHorizontal, LogIn, Share2, XCircle, RotateCw, FileText, CreditCard, ChevronDown, ChevronRight, RefreshCw, CheckCircle2 as PublishIcon, ListChecks, Folder, Tags, UserPlus } from 'lucide-react';
import { ProfileCreator } from './ProfileCreator';
import { useToast } from './Toast';
import { useAppContext } from './AppContext';
import { ImportWizard } from './ImportWizard';
import { PageCreator, PageCreationData } from './PageCreator';
import { FacebookAdPublisher, AdPublishData } from './FacebookAdPublisher';
import GoogleAdsPublisher, { GoogleAdPublishData } from './GoogleAdsPublisher';
import { CardInfoModal } from './CardInfoModal';
import { TikTokRegistration } from './tiktok/TikTokRegistration';
import { XRegistration } from './x/XRegistration';
import { InsRegistration } from './ins/InsRegistration';
import { AdAccountFields, defaultAdAccountForm, adNamePayload, adBillingPayload, type AdAccountForm } from './AdAccountFields';
import { FacebookRegistration } from './facebook/FacebookRegistration';
import { SmartPublishDialog } from './SmartPublishDialog';
import { ProfileFilterBar } from './ProfileFilterBar';
import { ProfileBulkActions } from './ProfileBulkActions';
// 🧵 批量慢操作统一提交给本机服务端任务队列（提交后前端可随意刷新，任务不中断）
import { submitJob, subscribe, snapshot, getLastAssets, waitForJob, type SlowOpType } from './jobQueue';
import { ProfilePagination } from './ProfilePagination';
import { ProfileTable } from './ProfileTable';
import { useContentCounts } from './PageSocialViewers';
import { removeByProfileIds as watchRemoveByProfileIds } from './aiWatch';
import { mergePageRightsCache, normBmRows } from '../utils/constants';

interface ProfileManagerProps {
  profiles?: FingerprintProfile[];
  setProfiles?: React.Dispatch<React.SetStateAction<FingerprintProfile[]>>;
  platform?: Platform;
  token?: string | null;
}

const LOCAL_SERVER_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || ''; // 与本地服务匹配的密钥（构建时注入）

// ⏱️ 带超时的 fetch：本地 9999 一旦卡住（登录验证 / 关浏览器），裸 fetch 会一直占着浏览器对
//    同源的 6 条连接，几条之后连接池耗尽 → 之后所有请求（含启动浏览器）全被排队，表现为"卡住"。
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

// 随机 BM 名称词库（形容词 + 名词组合，看起来像真实商户名）
const RANDOM_BM_NAMES = [
  'Eco Life', 'Tech Trends', 'Daily Joy', 'Green Garden', 'Smart Home',
  'Fashion Hub', 'Pet Paradise', 'Foodie Adventure', 'Fitness First', 'Travel Guide',
  'Artistic Soul', 'Music Magic', 'Gaming World', 'Movie Night', 'Book Worm',
  'Craft Studio', 'Wellness Center', 'Brew Lab', 'Pixel Perfect', 'Cloud Nine',
  'Sunset Media', 'Moonlight Studio', 'Star Tech', 'Ocean View', 'Mountain Peak',
  'Urban Nest', 'Cozy Corner', 'Bright Future', 'Blue Sky', 'Golden Gate',
  'Silver Lake', 'Iron Bridge', 'Maple Road', 'River Side', 'Forest Trail',
];

const get = (obj: any, path: string): any => {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
};

/**
 * 从 cache:businesses 统计「每个配置有多少个 BM」。
 *
 * ⚠️ 抽成一个函数的原因是：以前这段解析在配置列表里被**手写了三遍**（加载、获取信息完成、
 *    刷新列表），每处都只读驼峰 profileId，而 cache:businesses 里存的其实是云端
 *    /api/businesses 返回的原始行（属主字段是蛇形 profile_id）→ 三处全军覆没，BM 列恒为 0。
 *    广告号列表之所以一直正常，就是因为 AssetViewer.refreshBusinesses 先把行**归一化**成
 *    camelCase 再往下用。这里照同样的思路：只在这一处解析，两边的命名都认。
 */
const readCachedBmCounts = (): Record<string, number> => {
    const out: Record<string, number> = {};
    try {
        const raw = localStorage.getItem('cache:businesses');
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return out;
        const pidCount: Record<string, Set<string>> = {};
        arr.forEach((b: any) => {
            if (!b || typeof b !== 'object') return;
            const pid = String(b.profileId || b.profile_id || '');
            if (!pid) return;
            if (!pidCount[pid]) pidCount[pid] = new Set();
            pidCount[pid].add(String(b.businessId || b.business_id || b.id || ''));
        });
        Object.entries(pidCount).forEach(([pid, set]) => { out[pid] = set.size; });
    } catch {}
    return out;
};

export const ProfileManager = ({ profiles: propProfiles, setProfiles: propSetProfiles, platform: propPlatform, token: propToken }: ProfileManagerProps) => {
  const ctx = useAppContext();
  const profiles = propProfiles ?? ctx.profiles;
  const setProfiles = propSetProfiles ?? ctx.setProfiles;
  const platform = propPlatform ?? ((ctx.platform as Platform) || Platform.META);
  const token = propToken ?? ctx.token;
  const { showToast } = useToast();
  const contentCounts = useContentCounts();
  const [isCreating, setIsCreating] = useState(false);
  const [editingProfile, setEditingProfile] = useState<FingerprintProfile | null>(null);
  
  const [isImporting, setIsImporting] = useState(false);
  const [isImportPreviewOpen, setIsImportPreviewOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<FingerprintProfile[]>([]);
  const [importProgress, setImportProgress] = useState<{ completed: number; total: number } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isMoreActionsOpen, setIsMoreActionsOpen] = useState(false);
  const [isBatchDropOpen, setIsBatchDropOpen] = useState(false);
  // 🚀 统一创建BM对话框
  const [isCreateBMOpen, setIsCreateBMOpen] = useState(false);
  const [createBMName, setCreateBMName] = useState('');
  const [isRandomBMName, setIsRandomBMName] = useState(false);
  const [useProfileIdFirstName, setUseProfileIdFirstName] = useState(false);   // 🆕 「名字」用浏览器配置 ID 填充
  const [useProfileIdLastName, setUseProfileIdLastName] = useState(false);     // 🆕 「姓氏」用浏览器配置 ID 填充
  const [createBMCountry, setCreateBMCountry] = useState('');
  const [bmFirstName, setBmFirstName] = useState('');   // 🆕 与「BM 管理」创建BM表单保持一致
  const [bmLastName, setBmLastName] = useState('');
  const [createBMEmail, setCreateBMEmail] = useState('');
  const [isRandomBMEmail, setIsRandomBMEmail] = useState(false);
  const [createBMError, setCreateBMError] = useState('');
  const [creatingBM, setCreatingBM] = useState(false);
  const [createBMCount, setCreateBMCount] = useState(1);
  const [bmAdAccountCount, setBmAdAccountCount] = useState(1);   // 🆕 每个 BM 创建几个广告号
  // 🆕 广告号字段组（命名方式 + 时区/货币 + 账单信息）—— 与「BM 操作弹窗」共用同一份组件，
  //    以前这里各自维护一份、漏了时区，建出来的广告号时区是默认值。
  const [adForm, setAdForm] = useState<AdAccountForm>(defaultAdAccountForm);
  const patchAd = (p: Partial<AdAccountForm>) => setAdForm(v => ({ ...v, ...p }));
  const [bmCreateAdAccount, setBmCreateAdAccount] = useState(false);
  const [bmCreatePage, setBmCreatePage] = useState(false);
  const [bmDefaultPageName, setBmDefaultPageName] = useState('');
  // 📧 创建BM联动：建完自动生成邀请链接（每个 BM N 个）
  const [bmInviteEnabled, setBmInviteEnabled] = useState(false);
  const [bmInviteCount, setBmInviteCount] = useState(1);
  // 🛒 创建BM联动：邀请链接生成后自动上架商城（价格 USDT，默认 0）
  const [bmShopPublish, setBmShopPublish] = useState(false);
  const [bmShopPrice, setBmShopPrice] = useState(0);
  // 🔗 创建BM联动：建完后自动对涉及配置跑一次「获取信息」（广告号数/BM状态等立即填充）
  const [bmAutoFetchInfo, setBmAutoFetchInfo] = useState(true);
  // 🚀 BM创建代理选择
  const [bmProxyList, setBmProxyList] = useState<Array<any>>([]);
  const [bmSelectedProxyId, setBmSelectedProxyId] = useState('');
  const [bmProxyManualInput, setBmProxyManualInput] = useState('');
  const [bmProxyType, setBmProxyType] = useState('http');
  
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

  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
  const [isSetFbLangOpen, setIsSetFbLangOpen] = useState(false);
  const [batchFbLang, setBatchFbLang] = useState('en_US');
  const [isBatchBillingOpen, setIsBatchBillingOpen] = useState(false);
  const [batchBillCountry, setBatchBillCountry] = useState('US');
  const [batchBillCurrency, setBatchBillCurrency] = useState('USD');
  const [batchBillTimezone, setBatchBillTimezone] = useState('4');
  const [batchBillAddress, setBatchBillAddress] = useState('');
  const [batchBillCity, setBatchBillCity] = useState('');
  const [batchBillZip, setBatchBillZip] = useState('');
  const [batchBillAddressRandom, setBatchBillAddressRandom] = useState(true);
  const [batchBillCityRandom, setBatchBillCityRandom] = useState(true);
  const [batchBillZipRandom, setBatchBillZipRandom] = useState(true);
  const [batchBillState, setBatchBillState] = useState('AL');
  const [batchBillStateRandom, setBatchBillStateRandom] = useState(false);
  const [bulkEdit, setBulkEdit] = useState({
    group: '',
    owner: '',
    tags: '',
    tagsMode: 'replace' as 'replace' | 'append',
    accountStatus: '' as '' | AccountStatus,
    paymentStatus: '' as '' | 'Active' | 'Failed' | 'None',
    country: '',
    currency: '',
    notes: '',
    os: '' as '' | 'windows' | 'macos' | 'linux' | 'random',
    userAgent: '',
    resolution: '',
    timezone: '',
    language: '',
    fbLanguage: '' as '' | 'en_US' | 'zh_CN',
    fingerprintCanvas: '' as '' | 'random' | 'off',
    fingerprintWebgl: '' as '' | 'random' | 'off',
    fingerprintAudio: '' as '' | 'random' | 'off',
    proxyEnabled: '' as '' | 'enable' | 'disable',
    proxyType: '' as '' | 'http' | 'socks5' | 'residential',
    proxyHost: '',
    proxyPort: '',
    proxyUsername: '',
    proxyPassword: '',
    proxyRaw: '',
    proxyProvider: '',
    proxyZone: '',
    proxyCountry: '',
    proxyCity: '',
    proxySession: '',
    proxyRotation: '' as '' | 'auto' | 'sticky',
    startupUrls: ''
  });
  // unused - removed
  const { t } = useTranslation();
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'id', direction: 'desc' });
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [selectedDetails, setSelectedDetails] = useState<FingerprintProfile | null>(null);
  const [loginMap, setLoginMap] = useState<Record<string, 'in' | 'out' | 'unknown'>>({});
  const [currentPage, setCurrentPage] = useState(() => {
    try { return parseInt(localStorage.getItem('profiles_currentPage') || '1', 10); } catch { return 1; }
  });
  // 🚀 分页页码持久化到 localStorage
  useEffect(() => {
    try { localStorage.setItem('profiles_currentPage', String(currentPage)); } catch {}
  }, [currentPage]);
  const [pageSize, setPageSize] = useState(10);
  const [jumpPage, setJumpPage] = useState('');
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  const [visibleTwoFA, setVisibleTwoFA] = useState<Set<string>>(new Set());
  const [totpMap, setTotpMap] = useState<Record<string, { code: string; left: number }>>({});
  const [savingDb, setSavingDb] = useState(false);
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [isApplyProxyOpen, setIsApplyProxyOpen] = useState(false);
  const [savedProxies, setSavedProxies] = useState<Array<any>>([]);
  const [selectedProxyId, setSelectedProxyId] = useState('');
  const [enableTotp, setEnableTotp] = useState(false);
  const [groupFilter, setGroupFilter] = useState('');
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState('');
  const [shareMode, setShareMode] = useState<'copy' | 'transfer'>('copy');
  const [isPageCreatorOpen, setIsPageCreatorOpen] = useState(false);
  const [isAdPublisherOpen, setIsAdPublisherOpen] = useState(false);
  const [isGoogleAdPublisherOpen, setIsGoogleAdPublisherOpen] = useState(false);
  const [isSmartPublishOpen, setIsSmartPublishOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [isProfileLogOpen, setIsProfileLogOpen] = useState(false);
  const [selectedLogProfile, setSelectedLogProfile] = useState<FingerprintProfile | null>(null);
  const [profileLogs, setProfileLogs] = useState<string[]>([]);
  const [isFetchingLogs, setIsFetchingLogs] = useState(false);
  const [profileAdAccounts, setProfileAdAccounts] = useState<Record<string, any[]>>({});
  const [isTikTokRegOpen, setIsTikTokRegOpen] = useState(false);
  const [isXRegOpen, setIsXRegOpen] = useState(false);
  const [isInsRegOpen, setIsInsRegOpen] = useState(false);
  const [isFBRegOpen, setIsFBRegOpen] = useState(false);
  const [isCardInfoOpen, setIsCardInfoOpen] = useState(false);
  const [cardData, setCardData] = useState<any>(null);
  // 🚀 接入BM
  const [isJoinBMOpen, setIsJoinBMOpen] = useState(false);
  const [joinBMLinks, setJoinBMLinks] = useState('');
  const [joiningBM, setJoiningBM] = useState(false);
  const [joinBMResults, setJoinBMResults] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshingProfiles, setIsRefreshingProfiles] = useState(false);
  const [editingNotes, setEditingNotes] = useState<{ id: string; notes: string } | null>(null);

  // 🚀 服务端分页：纯框架渲染，数据完全由服务端驱动
  // 页面缓存：刷新时快速显示上次数据，再静默更新
  const getPageCache = () => {
    try {
      // 🚀 优先按当前页读取缓存，其次回退到旧格式
      const page = parseInt(localStorage.getItem('profiles_cache_page') || '1', 10);
      const size = parseInt(localStorage.getItem('profiles_cache_size') || '10', 10);
      const newKey = `profiles_cache_${platform}_${page}_${size}`;
      let raw = localStorage.getItem(newKey);
      if (!raw) raw = localStorage.getItem(`profiles_page_${platform}`);
      const c = JSON.parse(raw || '{}');
      return { data: Array.isArray(c.data) ? c.data : [], total: c.total || 0 };
    } catch { return { data: [], total: 0 }; }
  };
  const [paginatedProfiles, setPaginatedProfiles] = useState<FingerprintProfile[]>(() => getPageCache().data);
  const [serverTotal, setServerTotal] = useState(() => getPageCache().total);
  const [serverPageLoading, setServerPageLoading] = useState(false);
  const [serverPage, setServerPage] = useState(0); // 记录当前数据属于哪一页
  const [serverError, setServerError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [refreshKey, setRefreshKey] = useState(0); // 搜索/刷新时递增，强制重新加载

  // 🚀 初始化：加载第 1 页
  useEffect(() => {
    fetchServerPage(1, pageSize);
  }, []);

  // 🚀 翻页 / 改每页条数 / 排序 / refreshKey 变化时加载对应页
  useEffect(() => {
    if (currentPage > 0 && pageSize > 0) {
      fetchServerPage(currentPage, pageSize);
    }
  }, [currentPage, pageSize, refreshKey, sortConfig]);

  // 🚀 搜索防抖：停止输入 300ms 后翻到第 1 页（不直接调 fetchServerPage，由 currentPage/refreshKey 驱动）
  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentPage(1);
      setRefreshKey(k => k + 1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // 🚀 生产级分页请求：AbortController 防竞态 + 错误处理 + 去重
  const fetchServerPage = async (page: number, size: number) => {
    // 取消上一个还在飞行的请求
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const cacheKey = `profiles_cache_${platform}_${page}_${size}_${searchTerm || ''}`;

    // 🚀 翻页时先尝试从缓存读取该页数据，立即显示（无等待感）
    let servedFromCache = false;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}');
      if (Array.isArray(cached.data) && cached.data.length > 0) {
        setPaginatedProfiles(cached.data as any);
        setServerPage(page);
        setServerTotal(cached.total || 0);
        servedFromCache = true;
      }
    } catch {}

    // 🚀 记录当前页/大小，供刷新时恢复
    try { localStorage.setItem('profiles_cache_page', String(page)); localStorage.setItem('profiles_cache_size', String(size)); } catch {}

    setServerPageLoading(true);
    setServerError(null);

    try {
      const authToken = localStorage.getItem('auth_token');
      const base = String((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
      const searchQ = searchTerm ? `&search=${encodeURIComponent(searchTerm)}` : '';
      const sortQ = `&sortKey=${encodeURIComponent(sortConfig.key)}&sortDir=${encodeURIComponent(sortConfig.direction)}`;
      const r = await fetch(`${base}/api/profiles?page=${page}&pageSize=${size}&platform=${encodeURIComponent(platform)}${searchQ}${sortQ}&_t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${authToken}` },
        signal: ctrl.signal
      });
      if (!r.ok) throw new Error(`请求失败 (${r.status})`);
      const json = await r.json();
      // 被取消的请求不更新 UI
      if (ctrl.signal.aborted) return;
      if (json.success && Array.isArray(json.data)) {
        const incoming = json.data as any[];
        const mapped: FingerprintProfile[] = incoming.map((p: any) => ({
          id: String(p.id ?? ''),
          name: String(p.name ?? p.id ?? ''),
          platform: (p.platform as Platform) || Platform.META,
          status: BrowserStatus.IDLE,
          accountStatus: (p.accountStatus as AccountStatus) || AccountStatus.UNKNOWN,
          userAgent: String(p.userAgent ?? ''),
          ipAddress: String(p.ipAddress ?? 'N/A'),
          cookiesCount: Number(p.cookiesCount ?? 0),
          lastActive: String(p.lastActive ?? 'Never'),
          group: String(p.group ?? ''),
          tags: Array.isArray(p.tags) ? p.tags : (p.tags_col ? String(p.tags_col).split(',').filter(Boolean) : []),
          account: p.account || {},
          notes: String(p.notes ?? ''),
          token: String(p.token ?? ''),
          createdAt: String(p.createdAt ?? ''),
          updatedAt: String(p.updatedAt ?? ''),
          ownerName: String(p.ownerName ?? p.owner_name ?? ''),
          ownerEmail: String(p.ownerEmail ?? p.owner_email ?? ''),
          seq: p.seq,
          os: p.os || '',
          resolution: p.resolution || '',
          timezone: p.timezone || '',
          language: p.language || '',
          startupUrls: p.startupUrls || [],
          proxy: p.proxy || null,
          proxyEnabled: !!p.proxyEnabled,
          fingerprintProtection: p.fingerprintProtection || {},
          // 🔐 这一行曾经漏掉，导致配置列表的「登录状态」永远显示「未检测」：
          //    分页接口 /api/profiles 本来就返回 loginStatus，但映射没接上，
          //    ProfileTable 里读 profile.loginStatus 恒为 undefined。资产列表那条路径（App.tsx）有接，所以那边是好的。
          loginStatus: String(p.loginStatus ?? ''),
          assets: p.assets || {}
        }));
        setPaginatedProfiles(mapped);
        setServerPage(page);
        setServerTotal(json.pagination?.total || mapped.length);
        // 🚀 按页缓存，翻页时先显示缓存再静默更新
        try { localStorage.setItem(cacheKey, JSON.stringify({ data: mapped, total: json.pagination?.total || mapped.length })); } catch {}
      } else {
        throw new Error(json?.message || '数据格式异常');
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // 被取消的请求不处理
      // 🚀 如果缓存已提供数据，静默失败（不覆盖缓存数据）
      if (!servedFromCache) {
        setServerError(e?.message || '加载失败，请重试');
      }
      setServerPageLoading(false);
      return;
    }
    setServerPageLoading(false);
  };

  useEffect(() => {
    const handleOpenEdit = (e: any) => {
      const pid = e.detail?.profileId;
      if (!pid) return;
      const target = profiles.find(p => p.id === pid);
      if (target) {
        setEditingProfile(target);
        setIsCreating(true);
      }
    };
    // 🚀 从广告账号列表点击浏览器配置ID跳转时，自动填入搜索
    const prefillSearch = () => {
      try {
        const prefill = localStorage.getItem('browserConfig:searchPrefill');
        if (prefill) {
          setSearchTerm(prefill);
          localStorage.removeItem('browserConfig:searchPrefill');
        }
      } catch {}
    };
    prefillSearch();
    window.addEventListener('open-profile-edit', handleOpenEdit);
    window.addEventListener('browser-config-prefill', prefillSearch);
    // 🚀 从广告账号/资产列表点击"获取信息"时的跳转入口
    const handleBatchAssetFetch = (e: any) => {
      const ids = e.detail?.ids;
      if (Array.isArray(ids) && ids.length > 0) {
        batchSaveAssets(ids);
      }
    };
    window.addEventListener('batch-asset-fetch', handleBatchAssetFetch);
    // 🚀 获取信息完成后更新配置列表的 BM/Page 数量列
    const handleAssetFetchCompleted = () => {
      try {
        const cacheRaw = localStorage.getItem('cache:adaccounts');
        if (!cacheRaw) { console.log('[handleAssetFetchCompleted] ❌ cache:adaccounts 不存在'); return; }
        let cacheArr: any[];
        try { cacheArr = JSON.parse(cacheRaw); if (!Array.isArray(cacheArr)) { console.log('[handleAssetFetchCompleted] ❌ cache:adaccounts 不是数组'); return; } } catch { console.log('[handleAssetFetchCompleted] ❌ cache:adaccounts JSON解析失败'); return; }
        console.log(`[handleAssetFetchCompleted] ✅ cache:adaccounts 数组长度=${cacheArr.length}`);
        // 按 profileId 统计 BM（有 business 字段或 bmCount>0）
        const bmMap: Record<string, number> = {};
        const pageMap: Record<string, number> = {};
        cacheArr.forEach((a: any) => {
          const pid = String(a.profileId || a.profile_id || '');
          if (!pid) return;
          if (a.bmCount > 0 || a.business || a.bmCount) bmMap[pid] = (bmMap[pid] || 0) + (a.bmCount || 1);
          if (a.pagesCount > 0 || a.pages_count > 0) pageMap[pid] = Math.max(pageMap[pid] || 0, Number(a.pagesCount || a.pages_count || 0));
        });
        console.log(`[handleAssetFetchCompleted] 按adAccount统计: pageMap=${JSON.stringify(pageMap)} bmMap=${JSON.stringify(bmMap)}`);
        // 再读 cache:pages 按 profileId 统计真实 page 数
        try {
          const pageRaw = localStorage.getItem('cache:pages');
          if (pageRaw) {
            const pageArr = JSON.parse(pageRaw);
            if (Array.isArray(pageArr)) {
              const pidCount: Record<string, Set<string>> = {};
              pageArr.forEach((pg: any) => {
                const pid = String(pg.profileId || '');
                if (!pid) return;
                if (!pidCount[pid]) pidCount[pid] = new Set();
                pidCount[pid].add(String(pg.pageId || ''));
              });
              Object.entries(pidCount).forEach(([pid, set]) => { pageMap[pid] = set.size; });
            }
          }
        } catch {}
        console.log(`[handleAssetFetchCompleted] cache:pages覆盖后: pageMap=${JSON.stringify(pageMap)}`);
        // 再读 cache:businesses 覆盖成真实 BM 数（解析统一走 readCachedBmCounts）
        Object.assign(bmMap, readCachedBmCounts());
        console.log(`[handleAssetFetchCompleted] cache:businesses覆盖后: bmMap=${JSON.stringify(bmMap)}`);
        // 🚀 从 cache:pixels 按 profileId 统计真实像素数量
        const pixelMap: Record<string, number> = {};
        try {
          const pxRaw = localStorage.getItem('cache:pixels');
          if (pxRaw) {
            const pxArr = JSON.parse(pxRaw);
            if (Array.isArray(pxArr)) {
              const pidCount: Record<string, Set<string>> = {};
              pxArr.forEach((px: any) => {
                const pid = String(px.profileId || '');
                if (!pid) return;
                if (!pidCount[pid]) pidCount[pid] = new Set();
                pidCount[pid].add(String(px.pixel_id || px.id || ''));
              });
              Object.entries(pidCount).forEach(([pid, set]) => { pixelMap[pid] = set.size; });
            }
          }
        } catch {}
        console.log(`[handleAssetFetchCompleted] pixelMap=${JSON.stringify(pixelMap)}`);
        setProfiles(prev => prev.map(p => {
          const pid = String(p.id || '');
          const curAssets = p.assets || {};
          const newBm = bmMap[pid];
          const newPage = pageMap[pid];
          const newPixel = pixelMap[pid];
          if (newBm !== undefined || newPage !== undefined || newPixel !== undefined) {
            return { ...p, assets: { ...curAssets, ...(newBm !== undefined ? { bmCount: newBm } : {}), ...(newPage !== undefined ? { pagesCount: newPage } : {}), ...(newPixel !== undefined ? { pixelsCount: newPixel } : {}) } };
          }
          return p;
        }));
      } catch (e) { console.log('[handleAssetFetchCompleted] 异常:', e); }
    };
    window.addEventListener('batch-asset-fetch-completed', handleAssetFetchCompleted);
    return () => {
      window.removeEventListener('open-profile-edit', handleOpenEdit);
      window.removeEventListener('browser-config-prefill', prefillSearch);
      window.removeEventListener('batch-asset-fetch', handleBatchAssetFetch);
      window.removeEventListener('batch-asset-fetch-completed', handleAssetFetchCompleted);
    };
  }, [profiles]);

  useEffect(() => {
    const loadAdAccountsMap = () => {
      try {
        const raw = localStorage.getItem('cache:adaccounts');
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) {
            const map: Record<string, any[]> = {};
            list.forEach(item => {
              const pid = String(item.profileId || item.profile_id || '');
              if (pid) {
                if (!map[pid]) map[pid] = [];
                map[pid].push(item);
              }
            });
            setProfileAdAccounts(map);
          }
        }
        // 🚀 加载后立即从 localStorage 读取 page/BM/pixel 数量更新 profiles
        const newBmMap: Record<string, number> = {};
        const newPageMap: Record<string, number> = {};
        const newPixelMap: Record<string, number> = {};
        // 从 cache:pages 统计页数
        try {
          const pageRaw = localStorage.getItem('cache:pages');
          if (pageRaw) {
            const pageArr = JSON.parse(pageRaw);
            if (Array.isArray(pageArr)) {
              const pidCount: Record<string, Set<string>> = {};
              pageArr.forEach((pg: any) => {
                const pid = String(pg.profileId || '');
                if (!pid) return;
                if (!pidCount[pid]) pidCount[pid] = new Set();
                pidCount[pid].add(String(pg.pageId || ''));
              });
              Object.entries(pidCount).forEach(([pid, set]) => { newPageMap[pid] = set.size; });
            }
          }
        } catch {}
        // 从 cache:businesses 统计 BM 数（解析统一走 readCachedBmCounts）
        Object.assign(newBmMap, readCachedBmCounts());
        // 从 cache:pixels 统计像素数量
        try {
          const pxRaw = localStorage.getItem('cache:pixels');
          if (pxRaw) {
            const pxArr = JSON.parse(pxRaw);
            if (Array.isArray(pxArr)) {
              const pidCount: Record<string, Set<string>> = {};
              pxArr.forEach((px: any) => {
                const pid = String(px.profileId || '');
                if (!pid) return;
                if (!pidCount[pid]) pidCount[pid] = new Set();
                pidCount[pid].add(String(px.pixel_id || px.id || ''));
              });
              Object.entries(pidCount).forEach(([pid, set]) => { newPixelMap[pid] = set.size; });
            }
          }
        } catch {}
        // 更新 profiles 状态
        setProfiles(prev => prev.map(p => {
          const pid = String(p.id || '');
          const curAssets = p.assets || {};
          const newBm = newBmMap[pid];
          const newPage = newPageMap[pid];
          const newPixel = newPixelMap[pid];
          if (newBm !== undefined || newPage !== undefined || newPixel !== undefined) {
            return { ...p, assets: { ...curAssets, ...(newBm !== undefined ? { bmCount: newBm } : {}), ...(newPage !== undefined ? { pagesCount: newPage } : {}), ...(newPixel !== undefined ? { pixelsCount: newPixel } : {}) } };
          }
          return p;
        }));
      } catch {}
    };
    loadAdAccountsMap();
    window.addEventListener('adaccounts-refresh', loadAdAccountsMap);
    window.addEventListener('profiles-refresh', () => refreshProfilesList(true));
    return () => {
      window.removeEventListener('adaccounts-refresh', loadAdAccountsMap);
      window.removeEventListener('profiles-refresh', () => refreshProfilesList(true));
    };
  }, []);

  const fetchFreshProfileForLaunch = async (profileId: string, fallback: any) => {
    try {
      const serverUrl = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '/') as string);
      let baseUrl = String(serverUrl).replace(/\/$/, '');
      try { if (baseUrl && /localhost|127\.0\.0\.1/i.test(baseUrl)) baseUrl = '' } catch {}
      const resp = await fetch(`${baseUrl}/api/profiles/${profileId}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        }
      });
      const json = await resp.json();
      if (json && json.success && json.data) {
        return json.data;
      }
    } catch {}
    return fallback;
  };

  const getLaunchStartUrls = (profile: any) => (
    Array.isArray(profile?.startupUrls) ? profile.startupUrls : (profile?.startupUrls ? [profile.startupUrls] : [])
  );

  const buildLaunchPayload = (profile: any, fallbackId?: string, extras: Record<string, any> = {}) => {
    const resolvedId = profile?.id || fallbackId || '';
    const effectiveProxy = (profile?.proxy && profile.proxy.host && profile.proxy.port) ? profile.proxy : null;
    // 🚀 从系统设置读取浏览器类型和数据同步配置
    let browserType = 'chrome';
    let omnifpSync = false;
    try {
      const saved = localStorage.getItem('settings:browserSettings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.browserType) browserType = parsed.browserType;
        if (parsed.omnifpSync === true) omnifpSync = true;
      }
    } catch {}
    // 🦎 指纹浏览器模式下，支持通过 profile 的 omnifpProfileId 字段指定指纹浏览器环境 ID
    const effectiveProfileId = profile?.omnifpProfileId || resolvedId;
    return {
      profileId: effectiveProfileId,
      profile,
      browserType,
      omnifpSync,
      proxy: effectiveProxy,
      startUrls: getLaunchStartUrls(profile),
      cookies: profile?.account?.cookies,
      userAgent: profile?.userAgent,
      chrome115Config: { windowTitle: String(resolvedId) },
      ...extras
    };
  };

  const buildFreshLaunchPayload = async (profile: any, extras: Record<string, any> = {}) => {
    if (!profile?.id) {
      return buildLaunchPayload(profile, '', extras);
    }
    const fresh = await fetchFreshProfileForLaunch(profile.id, profile);
    return buildLaunchPayload(fresh, profile.id, extras);
  };

  const refreshProfilesList = async (silent = false) => {
    setIsRefreshingProfiles(true);
    try {
      const baseUrl = '';
      const resp = await fetch(`${baseUrl}/api/profiles?_t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
        cache: 'no-store'
      });
      const json = await resp.json();
      if (json && json.success && Array.isArray(json.data)) {
        // 🚀 修复：合并服务器数据与本地状态，避免远程同步延迟导致资产数量被覆盖为 0
        const serverData = json.data;
        setProfiles(prev => {
          const prevMap = new Map(prev.map(p => [String(p.id), p]));
          const merged = serverData.map((sd: any) => {
            // 🚀 映射蛇形→驼峰（API 返回 owner_email, 前端用 ownerEmail）
            if (sd.owner_email !== undefined) { sd.ownerEmail = sd.owner_email; delete sd.owner_email; }
            if (sd.owner_name !== undefined) { sd.ownerName = sd.owner_name; delete sd.owner_name; }
            const prevP = prevMap.get(String(sd.id));
            if (prevP && prevP.assets) {
              return {
                ...sd,
                assets: {
                  ...(sd.assets || {}),
                  pagesCount: (sd.assets?.pagesCount || 0) || (prevP.assets?.pagesCount || 0),
                  bmCount: (sd.assets?.bmCount || 0) || (prevP.assets?.bmCount || 0),
                  pixelsCount: (sd.assets?.pixelsCount || 0) || (prevP.assets?.pixelsCount || 0),
                  adAccountsCount: (sd.assets?.adAccountsCount || 0) || (prevP.assets?.adAccountsCount || 0),
                  // 🚀 保留 businesses 表合并的 BM ID 列表
                  bmIds: sd.assets?.bmIds || prevP.assets?.bmIds || [],
                  bmId: sd.assets?.bmId || prevP.assets?.bmId || '',
                }
              };
            }
            return sd;
          });
          try { localStorage.setItem('profiles', JSON.stringify(merged)); } catch {}
          return merged;
        });
        // 🚀 从本地缓存补充 BM/Page/像素数量（D1 profiles 表不一定有最新数据）
        try {
          const updateCounts = () => {
            setProfiles(prev => {
              // 读 cache:pages
              const pageRaw = localStorage.getItem('cache:pages');
              const pageMap: Record<string, number> = {};
              if (pageRaw) { try {
                const arr = JSON.parse(pageRaw);
                if (Array.isArray(arr)) {
                  const pidCount: Record<string, Set<string>> = {};
                  arr.forEach((pg: any) => {
                    const pid = String(pg.profileId || '');
                    if (!pid) return;
                    if (!pidCount[pid]) pidCount[pid] = new Set();
                    pidCount[pid].add(String(pg.pageId || ''));
                  });
                  Object.entries(pidCount).forEach(([pid, set]) => { pageMap[pid] = set.size; });
                }
              } catch {} }
              // 读 cache:businesses（解析统一走 readCachedBmCounts）
              const bmMap: Record<string, number> = readCachedBmCounts();
              // 读 cache:pixels
              const pxRaw = localStorage.getItem('cache:pixels');
              const pxMap: Record<string, number> = {};
              if (pxRaw) { try {
                const arr = JSON.parse(pxRaw);
                if (Array.isArray(arr)) {
                  const pidCount: Record<string, Set<string>> = {};
                  arr.forEach((px: any) => {
                    const pid = String(px.profileId || '');
                    if (!pid) return;
                    if (!pidCount[pid]) pidCount[pid] = new Set();
                    pidCount[pid].add(String(px.pixel_id || px.id || ''));
                  });
                  Object.entries(pidCount).forEach(([pid, set]) => { pxMap[pid] = set.size; });
                }
              } catch {} }
              console.log(`[refreshProfilesList/updateCounts] pageMap=${JSON.stringify(pageMap)} bmMap=${JSON.stringify(bmMap)} pxMap=${JSON.stringify(pxMap)}`);
              return prev.map(p => {
                const pid = String(p.id || '');
                const curAssets = p.assets || {};
                const newPage = pageMap[pid];
                const newBm = bmMap[pid];
                const newPx = pxMap[pid];
                if (newPage !== undefined || newBm !== undefined || newPx !== undefined) {
                  return { ...p, assets: { ...curAssets, ...(newPage !== undefined ? { pagesCount: newPage } : {}), ...(newBm !== undefined ? { bmCount: newBm } : {}), ...(newPx !== undefined ? { pixelsCount: newPx } : {}) } };
                }
                return p;
              });
            });
          };
          setTimeout(updateCounts, 50);
        } catch {}
        if (!silent) alert('列表已刷新');
      } else if (!silent) {
        alert(String(json?.message || json?.error || '刷新失败'));
      }
    } catch (err: any) {
      if (!silent) alert(`刷新失败: ${err?.message || '网络错误'}`);
    } finally {
      setIsRefreshingProfiles(false);
    }
  };

  const fetchProfileLogs = async (profileId: string) => {
    setIsFetchingLogs(true);
    try {
      const baseUrl = 'http://localhost:9999';
      const resp = await fetch(`${baseUrl}/api/logs/${profileId}`);
      const json = await resp.json();
      if (json && json.success) {
        setProfileLogs(json.lines || []);
      }
    } catch (err) {
      console.error('Fetch logs failed:', err);
      setProfileLogs(['获取日志失败: ' + String(err)]);
    } finally {
      setIsFetchingLogs(false);
    }
  };

  // Clear selection when platform changes
  useEffect(() => {
    setSelectedIds(new Set());
  }, [platform]);

  useEffect(() => {
    setCurrentPage(1);
  }, [platform]);

  useEffect(() => {
    return () => {};
  }, []);


  const handleExport = async () => {
    const mod = await import('xlsx');
    const XLSX = (mod as any);
    
    // 强制转换为字符串比较，确保匹配
    const selectedIdsArray = Array.from(selectedIds).map(String);
    const hasSelection = selectedIdsArray.length > 0;
    
    // 如果有勾选，则仅导出勾选项；否则导出当前列表中的全部（已过滤且排序的）
    const dataToExport = hasSelection 
      ? profiles.filter(p => selectedIdsArray.includes(String(p.id)))
      : sortedProfiles;
    
    if (!hasSelection && sortedProfiles.length > 0) {
      if (!window.confirm(`您未勾选任何配置，是否导出当前列表中的全部 ${sortedProfiles.length} 个配置？`)) return;
    }

    const exportData = dataToExport.map(p => {
      const proxyStr = p.proxy ? `${p.proxy.type}://${p.proxy.username ? p.proxy.username + ':' + p.proxy.password + '@' : ''}${p.proxy.host}:${p.proxy.port}` : '';
      
      return {
        'ID': p.id,
        '序号': p.seq || '',
        '配置名称': p.name,
        '分组': p.group || '',
        '标签': (p.tags || []).join(', '),
        '所有者': p.owner || '',
        '平台': p.platform,
        '浏览器状态': p.status,
        '账户状态': p.accountStatus || 'Unknown',
        'IP地址': p.ipAddress || '',
        'BM ID': p.assets?.bmId || '',
        '企业认证': p.assets?.verificationStatus || '',
        'BM 数量': p.assets?.bmCount ?? 0,
        'Page 数量': p.assets?.pagesCount ?? 0,
        '广告号数量': p.assets?.adAccountsCount ?? 0,
        '货币': p.assets?.currency || '',
        '国家': p.assets?.country || '',
        '支付状态': p.assets?.paymentStatus || '',
        '操作系统': p.os || '',
        'User Agent': p.userAgent || '',
        '分辨率': p.resolution || '',
        '时区': p.timezone || '',
        '语言': p.language || '',
        '启用代理': p.proxyEnabled ? '是' : '否',
        '代理详情': proxyStr,
        '代理类型': p.proxy?.type || '',
        '代理主机': p.proxy?.host || '',
        '代理端口': p.proxy?.port || '',
        '代理用户': p.proxy?.username || '',
        '代理密码': p.proxy?.password || '',
        '账号名称': p.account?.name || '',
        '账号邮箱': p.account?.email || '',
        '账号密码': p.account?.password || '',
        '2FA 密钥': p.account?.twoFactorSecret || '',
        'Access Token': p.token || '',
        'Cookies 数量': p.cookiesCount || 0,
        'Cookies': p.account?.cookies || '',
        '启动链接': (p.startupUrls || []).join('\n'),
        '备注': p.notes || '',
        '最后活动': p.lastActive || '',
        '更新时间': p.updatedAt || ''
      };
    });

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Profiles");
    XLSX.writeFile(wb, `OmniFingerprint_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
  };
  
  // 🚀 配置列表表格渲染的是服务端分页数据（paginatedProfiles），profiles 供其它逻辑用：
  //    两处必须一起改，否则保存后表格要刷新/切页才看得到
  const patchProfileBoth = (id: any, patch: (p: any) => any) => {
    const apply = (list: any[]) => list.map(p => (String(p.id) === String(id) ? patch(p) : p));
    setProfiles(prev => apply(prev));
    setPaginatedProfiles(prev => apply(prev) as any);
  };

  const handleSaveProfile = async (profileData: any) => {
    if (profileData.id) { // Editing existing profile
        const originalProfile = profiles.find(p => p.id === profileData.id);
        const seq = originalProfile?.seq;
        
        // 1. 更新本地状态
        patchProfileBoth(profileData.id, p => ({ ...p, ...profileData, seq: seq }));
        setEditingProfile(null);

        try {
          const serverUrl = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '/') as string);
          let baseUrl = String(serverUrl).replace(/\/$/, '');
          try { if (baseUrl && /localhost|127\.0\.0\.1/i.test(baseUrl)) baseUrl = '' } catch {}
          
          const payload: any = { ...profileData, seq: seq };
          
          // 🚀 核心修复：编辑单个配置时，优先使用 PUT 接口进行精确更新
          const resp = await fetch(`${baseUrl}/api/profiles/${profileData.id}`, {
            method: 'PUT',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
            },
            body: JSON.stringify(payload)
          });
          
          const json = await resp.json();
          if (json && json.success) {
            // 🚀 修正：同时更新本地服务器（浏览器启动使用），确保代理禁用生效
            try {
              const localBase = (((import.meta as any).env?.VITE_LAUNCH_SERVER_URL) || 'http://localhost:9999').replace(/\/$/, '');
              if (localBase && !/pages\.dev/i.test(localBase)) {
                await fetch(`${localBase}/api/profiles/${profileData.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json', 'X-Api-Secret': (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '' },
                  body: JSON.stringify(payload)
                });
              }
            } catch {}
            try {
              const freshResp = await fetch(`${baseUrl}/api/profiles/${profileData.id}`, {
                headers: {
                  'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
                }
              });
              const freshJson = await freshResp.json();
              if (freshJson && freshJson.success && freshJson.data) {
                // 🚀 保留本地已有的 tags/group/notes/owner，避免 D1 降级后空值覆盖本地
                const local = profiles.find(p => p.id === profileData.id);
                const merged = { ...freshJson.data };
                // 映射蛇形→驼峰（API 返回 owner_email, 前端用 ownerEmail）
                if (merged.owner_email !== undefined) { merged.ownerEmail = merged.owner_email; delete merged.owner_email; }
                if (merged.owner_name !== undefined) { merged.ownerName = merged.owner_name; delete merged.owner_name; }
                if (local) {
                  if (local.tags && Array.isArray(local.tags) && local.tags.length > 0 && (!merged.tags || (Array.isArray(merged.tags) && merged.tags.length === 0) || merged.tags === '')) merged.tags = local.tags;
                  if (local.group && !merged.group) merged.group = local.group;
                  if (local.notes && !merged.notes) merged.notes = local.notes;
                  if (local.ownerEmail && !merged.ownerEmail) merged.ownerEmail = local.ownerEmail;
                  if (local.ownerName && !merged.ownerName) merged.ownerName = local.ownerName;
                }
                setProfiles(prev => {
                  const next = prev.map(p => (String(p.id) === String(profileData.id) ? { ...p, ...merged } : p));
                  try { localStorage.setItem('profiles', JSON.stringify(next)); } catch {}
                  return next;
                });
                // 同步分页数据，保证表格立即显示
                setPaginatedProfiles(prev => prev.map(p => (String(p.id) === String(profileData.id) ? { ...p, ...merged } : p)) as any);
              }
            } catch {}
            // 🚫 保存只写数据库，不再自动执行「获取TOKEN + 获取信息」——那会悄悄启动浏览器
            //    （2026-09-28 用户要求去掉；需要刷新时用列表上的手动按钮）
          } else if (resp.status === 404) {
            // 🚀 核心修复：如果返回 404，说明配置已被删除，绝不尝试重新创建
            console.warn('Profile not found (likely deleted), skipping auto-recreation');
          } else {
            // 只有在非 404 错误（如网络抖动）时才尝试降级
            console.warn('PUT update failed, fallback if not deleted:', json.message);
            await fetch(`${baseUrl}/api/profiles/bulk-save`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
              },
              body: JSON.stringify({ profiles: [payload] })
            });
          }
        } catch (err) {
          console.error('Save profile error:', err);
        }
    } else { // Creating new profile(s)
        const { batchCount, name, ...restOfData } = profileData;
        const baseId = `fp_${Date.now()}`;
        const newProfiles: FingerprintProfile[] = [];
        
        // 不预设seq，让后续的normalization逻辑处理
        for (let i = 0; i < batchCount; i++) {
            const profileName = batchCount > 1 ? `${name} ${String(i + 1).padStart(2, '0')}` : name;
            newProfiles.push({
                ...restOfData,
                id: `${baseId}_${i}`,
                name: profileName,
                platform: platform,
                status: BrowserStatus.IDLE,
                accountStatus: AccountStatus.UNKNOWN,
                ipAddress: 'N/A',
                cookiesCount: 0,
                lastActive: 'Never',
                // 不设置seq，让normalization逻辑处理
            });
        }
        setProfiles(prev => [...newProfiles, ...prev]);
        
        setIsCreating(false);
        try {
          let serverUrl = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '/') as string);
          let baseUrl = serverUrl.replace(/\/$/, '');
          try { if (baseUrl && /localhost|127\.0\.0\.1/i.test(baseUrl)) baseUrl = '' } catch {}
          if (typeof baseUrl === 'string') {
            const saveResp = await fetch(`${baseUrl}/api/profiles/bulk-save`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
              },
              body: JSON.stringify({ profiles: newProfiles })
            });
            const saveJson = await saveResp.json();
            // 🚀 用 D1 返回的真实 ID 替换本地临时 ID
            if (saveJson?.savedIds?.length) {
              const idMap = Object.fromEntries(saveJson.savedIds.map((s: any) => [s.tempId, String(s.d1Id)]));
              setProfiles(prev => prev.map(p => idMap[p.id] ? { ...p, id: idMap[p.id] } : p));
              // 后面的批量操作使用真实 ID
              const realIds = saveJson.savedIds.map((s: any) => String(s.d1Id));
              try { await batchFetchTokens(realIds); } catch {}
              try { await batchSaveAssets(realIds); } catch {}
            } else {
              try { await batchFetchTokens(newProfiles.map(p => p.id)); } catch {}
              try { await batchSaveAssets(newProfiles.map(p => p.id)); } catch {}
            }
          }
        } catch {}
    }
  };

  const existingGroups = useMemo(() => {
    const groups = new Set<string>();
    profiles.forEach(p => { if ((p as any).group) groups.add((p as any).group); });
    return Array.from(groups).sort();
  }, [profiles]);

  const filteredProfiles = useMemo(() => {
    return profiles.filter(p => {
      if (groupFilter && (p as any).group !== groupFilter) return false;
      return p.platform === platform;
    });
  }, [profiles, platform, groupFilter]);
  
  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
        direction = 'desc';
    }
    setSortConfig({ key, direction });
    setCurrentPage(1); // 🚀 排序变化时回到第1页，触发全局排序后重新分页
  };

  const sortedProfiles = useMemo(() => {
    let sortableItems = [...filteredProfiles];
    sortableItems.sort((a, b) => {
      const isId = sortConfig.key === 'id';
      const avRaw = isId ? String(get(a, 'id') ?? '') : get(a, sortConfig.key);
      const bvRaw = isId ? String(get(b, 'id') ?? '') : get(b, sortConfig.key);
      const aValue = isId ? (parseInt(avRaw || '0', 10) || 0) : avRaw;
      const bValue = isId ? (parseInt(bvRaw || '0', 10) || 0) : bvRaw;

      if (aValue === undefined || aValue < bValue) {
        return sortConfig.direction === 'asc' ? -1 : 1;
      }
      if (bValue === undefined || aValue > bValue) {
        return sortConfig.direction === 'asc' ? 1 : -1;
      }
      return 0;
    });
    return sortableItems;
  }, [filteredProfiles, sortConfig]);




  // 🚀 分页：纯服务端驱动（含排序），总页数完全依赖 serverTotal
  const pageCount = Math.max(1, Math.ceil(serverTotal / pageSize));
  // 🚀 表格数据直接来自服务端（服务端已按 sortConfig 排序后分页）
  const pageItems = paginatedProfiles;
  const idsKey = useMemo(() => pageItems.map(p => p.id).join(','), [pageItems]);
  const allPageSelected = pageItems.length > 0 && pageItems.every(p => selectedIds.has(p.id));

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

  const toggleSelectAll = () => {
    if (allPageSelected) {
      const next = new Set(selectedIds);
      pageItems.forEach(p => next.delete(p.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      pageItems.forEach(p => next.add(p.id));
      setSelectedIds(next);
    }
  };

  // 🚀 批量操作目标解析
  //    ⚠️ 全局 profiles 只有首屏 50 条（App.tsx 固定请求 page=1&pageSize=50，且不带 platform 过滤），
  //       而表格是服务端分页的 —— 选中的配置不在前 50 条时，用 profiles.filter 会得到空数组，
  //       表现为「批量启动/停止点了完全没反应」。这里按选中 ID 解析：
  //       本地（全局 + 当前页）查不到的先用 { id } 占位，由 buildFreshLaunchPayload 去服务端拉全量配置。
  const resolveSelectedTargets = (ids: string[]): any[] => {
    const known = new Map<string, any>();
    [...(profiles || []), ...(paginatedProfiles || [])].forEach(p => {
      if (p && p.id != null) known.set(String(p.id), p);
    });
    return ids.map(id => known.get(String(id)) || { id: String(id) });
  };

  // 🧵 批量慢操作统一提交给本机服务端队列：
  //    以前是在这个页面里用 for/await 跑，刷新/切页/断网就全丢了；现在提交即返回，
  //    真正的执行与进度都在后端，去左侧「执行队列」看进度、取消。
  const submitBatchJob = async (type: SlowOpType, title: string, items: Array<{ key: string; label?: string; payload: any }>, shared?: any) => {
    if (!items.length) { showToast('没有可用目标', 'warning'); return null; }
    try {
      const job = await submitJob({ type, title, items, shared });
      showToast(`已提交「${title}」到执行队列（${items.length} 项），可在左侧「执行队列」查看进度与取消`, 'success');
      return job;
    } catch (e: any) {
      showToast(`提交执行队列失败：${e?.message || e}（请确认本机后端 9999 已启动）`, 'warning');
      return null;
    }
  };

  // Batch Operations
  const handleBatchAction = (action: 'start' | 'stop' | 'delete' | 'share' | 'check' | 'relogin' | 'getInfo' | 'createPage' | 'publishAds' | 'createBM' | 'createAdAccount' | 'changeCurrency' | 'addPayment' | 'topUp' | 'fetchTokens' | 'joinBM') => {
    // ⚠️ 以前这里直接 return，界面上「批量操作」按钮不会置灰 → 没勾选任何配置时
    //    点任何批量动作都毫无反应，看起来像「功能坏了」
    if (selectedIds.size === 0) { showToast('请先勾选要操作的配置', 'warning'); return; }

    switch (action) {
      case 'start':
        {
          const targets = resolveSelectedTargets(Array.from(selectedIds));
          if (targets.length === 0) { showToast('没有可启动的配置，请重新勾选', 'warning'); break; }
          // 🧵 走服务端队列：本机浏览器并发有限，排队执行比前端一次性打出去更稳，且刷新不丢
          void submitBatchJob('launch_browser', `批量启动浏览器（${targets.length} 个）`,
            targets.map(p => ({ key: String(p.id), label: String(p.id), payload: { profileId: String(p.id) } })));
        }
        break;
      case 'stop':
        {
          const targets = resolveSelectedTargets(Array.from(selectedIds));
          if (targets.length === 0) { showToast('没有可停止的配置，请重新勾选', 'warning'); break; }
          void submitBatchJob('stop_browser', `批量关闭浏览器（${targets.length} 个）`,
            targets.map(p => ({ key: String(p.id), label: String(p.id), payload: { profileId: String(p.id) } })));
        }
        break;
      case 'delete':
        setIsDeleteConfirmOpen(true);
        break;
      case 'share':
        setIsShareModalOpen(true);
        break;
      case 'check':
        {
          const base = 'http://localhost:9999/api';
          const ids = Array.from(selectedIds);
          const tasks = ids.map(id => (
            fetch(`${base}/facebook/check-login`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': LOCAL_SERVER_SECRET
              },
              body: JSON.stringify({ profileId: id })
            }).then(r => r.json()).then(json => ({ id, ok: !!json?.success, loggedIn: !!json?.loggedIn, userId: json?.userId })).catch(() => ({ id, ok: false, loggedIn: false }))
          ));
          Promise.allSettled(tasks).then(results => {
            const parsed = results.map(r => (r.status === 'fulfilled' ? (r as any).value : { id: '', ok: false, loggedIn: false }));
            setLoginMap(prev => {
              const next = { ...prev };
              parsed.forEach(r => { if (r.id) next[r.id] = r.loggedIn ? 'in' : 'out'; });
              return next;
            });
            setProfiles(prev => prev.map(p => {
              const r = parsed.find(x => x.id === p.id);
              if (!r) return p;
              return { ...p, accountStatus: r.loggedIn ? AccountStatus.ACTIVE : AccountStatus.DISABLED };
            }));
            try {
              const items = parsed.map(r => ({ id: r.id, accountStatus: r.loggedIn ? 'Active' : 'Disabled' }));
              const statusAuthToken = localStorage.getItem('auth_token');
              fetch(`/api/profiles/update-account-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(statusAuthToken ? { 'Authorization': `Bearer ${statusAuthToken}` } : {}) },
                body: JSON.stringify({ items })
              }).catch(() => {});
            } catch {}
          });
        }
        break;
      case 'relogin':
        {
          const baseUrl = 'http://localhost:9999/api';
          const targets = resolveSelectedTargets(Array.from(selectedIds));
          if (targets.length === 0) { showToast('没有可重登的配置，请重新勾选', 'warning'); break; }
          const toLaunch = targets.filter(p => p.status !== BrowserStatus.RUNNING);
          const toRelogin = targets.filter(p => p.status === BrowserStatus.RUNNING);
          
          const doLaunch = toLaunch.length ? runInChunks(toLaunch, 4, async (p) => (
            fetch(`${baseUrl}/launch-browser`, {
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': LOCAL_SERVER_SECRET,
                'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
              }, 
              body: JSON.stringify(await buildFreshLaunchPayload(p, {
                strictVerifyOnly: true,
                strictStartUrls: true
              }))
            })
              .then(r => r.json()).then(json => ({ id: p.id, ok: !!json?.success }))
              .catch(() => ({ id: p.id, ok: false }))
          )) : Promise.resolve([] as any[]);
          doLaunch.then((launchRs: any[]) => {
            const okIds = new Set(launchRs.filter(x => x && x.ok).map(x => x.id));
            const allRunning = [...toRelogin.map(x => x.id), ...Array.from(okIds)];
            
            // 🚀 步骤1：先检查所有已运行环境的 Cookie 是否有效
            runInChunks(allRunning, 6, (id) => (
              fetch(`${baseUrl}/facebook/check-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: id })
              }).then(r => r.json()).then(json => ({ id, ok: !!json?.success, loggedIn: !!json?.loggedIn })).catch(() => ({ id, ok: false, loggedIn: false }))
            )).then((checkRs: any[]) => {
              // 🚀 步骤2：筛选出 Cookie 无效的，仅对这些执行自动登录
              const needsLogin = checkRs.filter(x => x && x.ok && !x.loggedIn).map(x => x.id);
              const validIds = checkRs.filter(x => x && x.ok && x.loggedIn).map(x => x.id);
              const loggedOut = checkRs.filter(x => !x.ok || !x.loggedIn).map(x => x.id);
              
              // 🚀 更新登录状态图
              setLoginMap(prev => {
                const next = { ...prev } as any;
                validIds.forEach(id => { next[id] = 'in'; });
                loggedOut.forEach(id => { next[id] = 'out'; });
                return next;
              });
              
              if (needsLogin.length === 0) {
                const total = allRunning.length;
                alert(`Cookie 检查完成：全部 ${total} 个环境 Cookie 有效，无需重新登录`);
                return;
              }
              
              // 🚀 步骤3：仅对 Cookie 无效的执行自动登录
              runInChunks(needsLogin, 5, (id) => (
                fetch(`${baseUrl}/facebook/relogin`, {
                  method: 'POST', 
                  headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET }, 
                  body: JSON.stringify({ profileId: id })
                }).then(r => r.json()).then(json => ({ id, ok: !!json?.success, clicked: !!json?.clicked, loggedIn: !!json?.loggedIn, closed: !!json?.closed })).catch(() => ({ id, ok: false, clicked: false, loggedIn: false, closed: false }))
              )).then((rs: any[]) => {
                const total = needsLogin.length;
                const ok = rs.filter(x => x && x.ok).length;
                const clicked = rs.filter(x => x && x.clicked).length;
                const logged = rs.filter(x => x && x.loggedIn).length;
                alert(`批量重登完成：需重登 ${total} 个，成功触发登录 ${clicked}/${total}，登录成功 ${logged}/${total}`);
                const loginIds = new Set(rs.filter(x => x && x.loggedIn).map(x => x.id));
                const closedIds = new Set(rs.filter(x => x && x.closed).map(x => x.id));
                setLoginMap(prev => {
                  const next = { ...prev } as any;
                  Array.from(loginIds).forEach(id => { next[id] = 'in'; });
                  return next;
                });
                setProfiles(prev => prev.map(p => closedIds.has(p.id) ? { ...p, status: BrowserStatus.IDLE } : p));
              });
            });
          });
        }
        break;
      case 'getInfo':
        batchSaveAssets(Array.from(selectedIds));
        break;
      case 'fetchPosts':
        batchSaveAssets(Array.from(selectedIds), 'fetch_posts');
        window.dispatchEvent(new Event('content-counts-refresh'));
        break;
      case 'createPage':
        setIsPageCreatorOpen(true);
        break;
      case 'publishAds':
        setIsAdPublisherOpen(true);
        break;
      case 'createBM':
        setIsCreateBMOpen(true);
        setCreateBMCountry('');
        setIsRandomBMName(false);
        setIsRandomBMEmail(false);
        if (!createBMEmail) setCreateBMEmail(generateRandomEmail());
        // 🚀 打开时加载已保存的代理列表
        (async () => {
          try {
            const raw = localStorage.getItem('proxy-list');
            if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length > 0) { setBmProxyList(arr); return; } }
          } catch {}
          try {
            const base = String((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
            const authToken = localStorage.getItem('auth_token');
            if (!authToken) return;
            const r = await fetch(`${base}/api/proxies`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            if (!r.ok) return;
            const j = await r.json();
            const list = Array.isArray(j?.data) ? j.data : [];
            setBmProxyList(list);
            try { localStorage.setItem('proxy-list', JSON.stringify(list)); } catch {}
          } catch {}
        })();
        break;
      case 'createAdAccount':
        alert(t('profileManager.batch.actionInitiated', { action: t('profileManager.batch.createAdAccount'), count: selectedIds.size }));
        break;
      case 'changeCurrency':
        alert(t('profileManager.batch.actionInitiated', { action: t('profileManager.batch.changeCurrencyTimezone'), count: selectedIds.size }));
        break;
      case 'addPayment':
        // 🚀 改为弹出绑卡信息对话框，收集卡片信息后批量绑卡
        setIsCardInfoOpen(true);
        break;
      case 'topUp':
        alert(t('profileManager.batch.actionInitiated', { action: t('profileManager.batch.topUp'), count: selectedIds.size }));
        break;
      case 'fetchTokens':
        batchFetchTokens(Array.from(selectedIds));
        break;
      case 'joinBM':
        setIsJoinBMOpen(true);
        setJoinBMLinks('');
        setJoinBMResults([]);
        break;
    }
  };

  const refreshAdAccountCounts = async () => {
    try {
      let list: any[] = [];
      const authToken = localStorage.getItem('auth_token');
      if (authToken) {
        try {
          const resp = await fetch(`/api/adaccounts`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
          });
          const json = await resp.json();
          list = Array.isArray(json?.data) ? json.data as any[] : [];
        } catch (e) {
          console.error('Failed to fetch ad accounts from Cloudflare:', e);
        }
      }
      
      // 仅在非生产环境且未获取到云端数据时，尝试本地同步（可选）
      if (!list.length && !authToken) {
        try {
          const resp = await fetch(`http://localhost:9999/api/local/adaccounts`, {
            headers: { 'X-Api-Secret': LOCAL_SERVER_SECRET }
          });
          const json = await resp.json();
          list = Array.isArray(json?.data) ? json.data as any[] : [];
        } catch {}
      }
      const byProfile: Record<string, number> = {};
      const seen: Record<string, Set<string>> = {};
      for (const it of list) {
        // ⚠️ 云端 /api/adaccounts 直出数据库列名（snake_case），只有本地缓存是 camelCase：
        //    以前这里只读 it.profileId → pid 恒为空 → 所有行被 continue 跳过 → 每个配置都被算成 0，
        //    界面上就只剩「刚点过获取信息」的那几个（内存里还有数），旧广告号数量全没了。
        const pid = String(it.profileId || it.profile_id || '');
        const acc = String(it.adAccountId || it.account_id || '');
        if (!pid || !acc) continue;
        if (!seen[pid]) seen[pid] = new Set<string>();
        if (!seen[pid].has(acc)) {
          seen[pid].add(acc);
          byProfile[pid] = (byProfile[pid] || 0) + 1;
        }
      }
      setProfiles(prev => prev.map(p => {
        const cnt = byProfile[p.id] || 0;
        const prevAssets = p.assets || {} as any;
        return { ...p, assets: { ...prevAssets, adAccountsCount: cnt } };
      }));
    } catch {}
  };

  useEffect(() => {
    refreshAdAccountCounts(); // 初始化时立即加载
    const handler = () => refreshAdAccountCounts();
    window.addEventListener('adaccounts-refresh', handler);
    return () => window.removeEventListener('adaccounts-refresh', handler);
  }, []);

  const getAccountStatusBadge = (status?: AccountStatus) => {
    switch (status) {
      case AccountStatus.ACTIVE:
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-900/30 text-emerald-400 border border-emerald-800"><CheckCircle2 className="w-3 h-3 mr-1"/> {t('status.active')}</span>;
      case AccountStatus.RESTRICTED:
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-900/30 text-orange-400 border border-orange-800"><AlertTriangle className="w-3 h-3 mr-1"/> {t('status.restricted')}</span>;
      case AccountStatus.DISABLED:
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-900/30 text-rose-400 border border-rose-800"><Ban className="w-3 h-3 mr-1"/> {t('status.disabled')}</span>;
      case AccountStatus.REVIEW:
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-900/30 text-yellow-400 border border-yellow-800"><ShieldCheck className="w-3 h-3 mr-1"/> {t('status.review')}</span>;
      default:
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">{t('status.unknown')}</span>;
    }
  };
  
  const getPaymentStatusBadge = (status?: 'Active' | 'Failed' | 'None', cardInfo?: string) => {
    let cardSuffix = '';
    if (cardInfo) {
      const match = cardInfo.match(/\d{4}/);
      if (match) cardSuffix = ` (*${match[0]})`;
    }

    switch (status) {
      case 'Active':
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-900/30 text-emerald-400 border border-emerald-800"><Wallet className="w-3 h-3 mr-1"/> {t('status.payment.active')}{cardSuffix}</span>;
      case 'Failed':
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-900/30 text-rose-400 border border-rose-800"><Ban className="w-3 h-3 mr-1"/> {t('status.payment.failed')}</span>;
      default:
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">{t('status.payment.none')}</span>;
    }
  };

  const toggleStatus = async (id: string) => {
    const baseUrl = 'http://localhost:9999/api';
    // 🚀 优先从 profiles prop 找，找不到时从 paginatedProfiles（当前渲染页）回退查找
    let target = profiles.find(pp => pp.id === id);
    if (!target) target = paginatedProfiles.find(pp => pp.id === id);
    if (!target) return;

    const isRunning = target.status === BrowserStatus.RUNNING;
    
    // 🚀 如果正在运行 → 停止浏览器
    if (isRunning) {
      try {
        const stopResp = await fetch(`${baseUrl}/stop-browser`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
          body: JSON.stringify({ profileId: id })
        });
        // 无论返回 404（未在运行）还是 200，都认为已停止
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: BrowserStatus.IDLE } : p));
        setPaginatedProfiles(prev => prev.map(p => p.id === id ? { ...p, status: BrowserStatus.IDLE } : p));
      } catch {
        // 即使后端不可用也重置状态，让用户可以再次启动
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: BrowserStatus.IDLE } : p));
        setPaginatedProfiles(prev => prev.map(p => p.id === id ? { ...p, status: BrowserStatus.IDLE } : p));
      }
      return;
    }

    // 🧵 单个启动也走服务端队列：
    //    - 与批量启动共用同一个全局浏览器闸门，不会再出现「手动点和队列任务互相抢空位」；
    //    - 提交后立即返回，即使刷新页面/切页，启动任务照样在后端跑完。
    //    启动所需完整配置（cookies / UA / 代理）由服务端按 profileId 自己读库，前端不必再拼。
    try {
      const job = await submitJob({
        type: 'launch_browser',
        title: `启动浏览器（配置 ${id}）`,
        // 🖐 单个启动：自动登录没成功时保留浏览器窗口，方便直接在里面手动登录（批量启动不传此参数，仍会关窗）
        items: [{ key: String(id), label: String(id), payload: { profileId: String(id), keepBrowserOnLoginFail: true } }],
      });
      showToast(`已提交「启动浏览器」到执行队列：${id}（进度见左侧「执行队列」，实测 40~70s）`, 'success');
      const finished = await waitForJob(job.id);
      const item = finished?.items?.[0];
      if (item && item.status === 'done') {
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: BrowserStatus.RUNNING, lastActive: new Date().toLocaleString() } : p));
        setPaginatedProfiles(prev => prev.map(p => p.id === id ? { ...p, status: BrowserStatus.RUNNING, lastActive: new Date().toLocaleString() } : p));
      } else if (item && item.status !== 'running' && item.status !== 'queued') {
        let msg = String(item.message || '启动失败');
        if (msg.includes('net::ERR_CONNECTION_RESET')) {
          msg = '代理连接被重置 (ERR_CONNECTION_RESET)。请检查：\n1. 代理类型是否正确（如 SOCKS5）\n2. 代理是否已过期或 IP 被封\n3. 账号密码是否正确';
        } else if (msg.includes('net::ERR_PROXY_CONNECTION_FAILED')) {
          msg = '无法连接到代理服务器 (ERR_PROXY_CONNECTION_FAILED)。请检查代理地址和端口。';
        }
        showToast(msg, 'error');
      }
    } catch (e: any) {
      showToast(`提交执行队列失败：${e?.message || e}（请确认本机后端 9999 已启动）`, 'error');
    }
  };

  // 🔐 检查登录状态：check-login 要求该配置有活跃浏览器，所以先按需借用 → 检测 → 归还；
  //    结果除了弹窗，还会写进 profiles.loginStatus 并落库，列表里「登录状态」列长期可见。
  const checkLoginStatus = async (id: string) => {
    const baseUrl = 'http://localhost:9999/api';
    const target = profiles.find(pp => pp.id === id) || paginatedProfiles.find(pp => pp.id === id);
    const startedByUs = target?.status !== BrowserStatus.RUNNING;
    const headers = { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET };
    try {
      if (startedByUs) {
        await fetchWithTimeout(`${baseUrl}/launch-browser`, {
          method: 'POST', headers,
          body: JSON.stringify({ profileId: id, startUrls: ['https://www.facebook.com/'], borrow: true })
        }, 150000, '启动浏览器');
      }

      const json = await fetchWithTimeout(`${baseUrl}/facebook/check-login`, {
        method: 'POST', headers, body: JSON.stringify({ profileId: id })
      }, 60000, '检查登录状态').then(r => r.json());

      if (json?.reason === 'no_browser') {
        alert('登录状态：浏览器实例未就绪，无法检测');
        return;
      }

      const loggedIn = !!json?.loggedIn;
      setLoginMap(prev => ({ ...prev, [id]: loggedIn ? 'in' : 'out' }));

      // 后端现在会直接给 loginStatus（ok / checkpoint / invalid）：
      // checkpoint = 页面落在 Facebook 人机验证页，这跟「Cookie 过期」不是一回事，
      // 要人去过验证，不能混记成 invalid，否则用户不知道该去点验证。
      const ls = ['ok', 'checkpoint', 'invalid'].includes(String(json?.loginStatus || ''))
        ? String(json.loginStatus)
        : (loggedIn ? 'ok' : 'invalid');
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, loginStatus: ls } : p));
      setPaginatedProfiles(prev => prev.map(p => p.id === id ? { ...p, loginStatus: ls } : p));
      try {
        const authToken = localStorage.getItem('auth_token');
        const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
        fetchWithTimeout(`${sbase}/api/profiles/update-login-status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ items: [{ id, loginStatus: ls }] })
        }, 30000, '回写登录状态').catch(() => {});
      } catch {}

      alert(ls === 'checkpoint'
        ? '登录状态：需人机验证（页面被 Facebook 拦到安全验证页，请点「启动」进浏览器手动过验证）'
        : loggedIn
          ? `登录状态：已登录${json.userId ? `（UID ${json.userId}）` : ''}`
          : '登录状态：未登录（未检测到登录Cookie）');
    } catch (e: any) {
      alert(`检查登录状态失败：${e?.message || e}`);
    } finally {
      if (startedByUs) {
        await fetchWithTimeout(`${baseUrl}/stop-browser`, {
          method: 'POST', headers, body: JSON.stringify({ profileId: id })
        }, 8000, '归还浏览器').catch(() => {});
      }
    }
  };

  const autofillLogin = (id: string) => {
    const baseUrl = 'http://localhost:9999/api';
    fetch(`${baseUrl}/facebook/autofill-login`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Api-Secret': LOCAL_SERVER_SECRET
      },
      body: JSON.stringify({ profileId: id })
    }).then(r => r.json()).then(json => {
      if (json && json.success) {
        alert('已自动填充登录表单');
      } else {
        alert('自动填充失败：' + (json && json.message ? json.message : '未知错误'));
      }
    }).catch(() => { alert('后端不可用'); });
  };

  const getAndSaveTokens = async (id: string) => {
    const baseUrl = 'http://localhost:9999/api'

    const profile = profiles.find(p => p.id === id);
    if (profile && profile.status !== BrowserStatus.RUNNING) {
      try {
        const launchPayload = await buildFreshLaunchPayload(profile);
        const lResp = await fetch(`${baseUrl}/launch-browser`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET,
            'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
          },
          body: JSON.stringify(launchPayload)
        });
        const lJson = await lResp.json();
        if (!lJson || !lJson.success) {
          showToast('启动浏览器失败: ' + (lJson?.message || '未知错误'), 'error');
          return;
        }
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: BrowserStatus.RUNNING, lastActive: new Date().toLocaleString() } : p));
      } catch {
        showToast('启动浏览器失败: 后端不可用', 'error');
        return;
      }
    }

    try {
      const tResp = await fetch(`${baseUrl}/facebook/tokens`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET
        },
        body: JSON.stringify({ profileId: id, targetUrl: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns', strictEAAB: true })
      });
      const tJson = await tResp.json();
      if (!tJson || !tJson.success) {
        try {
          const dbg = await fetch(`${baseUrl}/debug/token-logs`, {
            headers: { 'X-Api-Secret': LOCAL_SERVER_SECRET }
          }).then(r => r.json()).catch(() => null);
          const lines = Array.isArray(dbg?.lines) ? dbg.lines.slice(-6) : [];
          alert(`获取TOKEN失败\n${lines.join('\n')}`);
        } catch { alert('获取TOKEN失败'); }
        return;
      }
      const tokens = tJson.tokens || {};
      const access = Array.isArray(tokens.access_tokens) ? tokens.access_tokens : [];
      const first = (access.find(v => /^EAAG/i.test(String(v))) || access.find(v => /^EAA/i.test(String(v))) || access.find(v => typeof v === 'string' && v.length > 0) || '');
      if (!first) {
        try {
          const dbg = await fetch(`${baseUrl}/debug/token-logs`, {
            headers: { 'X-Api-Secret': LOCAL_SERVER_SECRET }
          }).then(r => r.json()).catch(() => null);
          const lines = Array.isArray(dbg?.lines) ? dbg.lines.slice(-6) : [];
          alert(`未获取到TOKEN\n${lines.join('\n')}`);
        } catch { alert('未获取到TOKEN'); }
      }
      try {
        const sAuthToken = localStorage.getItem('auth_token');
        const sResp = await fetch(`/api/facebook/save-tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(sAuthToken ? { 'Authorization': `Bearer ${sAuthToken}` } : {}) },
          body: JSON.stringify({ profileId: id, tokens })
        });
        const sJson = await sResp.json();
        if (sJson && sJson.success) {
          try {
            const stopResp = await fetch(`${baseUrl}/stop-browser`, {
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': LOCAL_SERVER_SECRET
              }, 
              body: JSON.stringify({ profileId: id })
            });
            const stopJson = await stopResp.json();
            if (stopJson && stopJson.success) {
              setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: BrowserStatus.IDLE } : p));
            }
          } catch {}
        }
      } catch {}
      try {
        const refAuthToken = localStorage.getItem('auth_token');
        const refreshed = await fetch(`/api/profiles/${id}`, { headers: refAuthToken ? { 'Authorization': `Bearer ${refAuthToken}` } : {} }).then(r => r.json());
        const data = refreshed && refreshed.data ? refreshed.data : null;
        if (data) {
          setProfiles(prev => prev.map(p => p.id === id ? { ...p, ...data } : p));
          setEditingProfile(ep => (ep && ep.id === id) ? data : ep);
        } else {
          setProfiles(prev => prev.map(p => p.id === id ? { ...p, token: first || 'N/A' } : p));
        }
      } catch {
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, token: first || 'N/A' } : p));
      }
      alert(first ? 'TOKEN已保存' : '未获取到TOKEN');
    } catch {
      alert('后端不可用或网络错误');
    }
  };

  const batchFetchTokens = async (ids: string[]) => {
    if (!ids.length) { return; }
    const baseUrl = 'http://localhost:9999/api';
    // 🐛 修复「翻页选中丢目标」：原来从 profiles（只有首屏 50 条）里过滤，翻页选中的配置会被
    //    整条丢掉 —— 界面上显示「获取TOKEN（N 个）」，实际只跑了首屏那批，数量还对不上。
    //    改用 resolveSelectedTargets：本地查不到的用 { id } 占位，交给下面的
    //    buildFreshLaunchPayload 去服务端取全量配置（与批量启动/停止同一套解析）。
    const targets = resolveSelectedTargets(ids);
    const toLaunch = targets.filter(p => p.status !== BrowserStatus.RUNNING);
    const alreadyRunning = targets.filter(p => p.status === BrowserStatus.RUNNING);
    const launchRs = await runInChunks(toLaunch, 4, async (p) => {
      const payload = await buildFreshLaunchPayload(p);
      return fetch(`${baseUrl}/launch-browser`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET,
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        }, 
        body: JSON.stringify(payload) 
      })
        .then(r => r.json()).then(json => ({ id: p.id, ok: !!json?.success }))
        .catch(() => ({ id: p.id, ok: false }));
    });
    const okIds = new Set((launchRs as any[]).filter(x => x && x.ok).map(x => x.id));
    if (okIds.size) {
      setProfiles(prev => prev.map(p => okIds.has(p.id) ? { ...p, status: BrowserStatus.RUNNING, lastActive: new Date().toLocaleString() } : p));
    }
    const finalIds = new Set<string>([...alreadyRunning.map(x => x.id), ...Array.from(okIds)]);
    const tokenMap: Record<string, string> = {};
    const fetchRs = await runInChunks(targets.filter(p => finalIds.has(p.id)), 5, async (p) => {
      try {
        const resp = await fetch(`${baseUrl}/facebook/tokens`, {
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          }, 
          body: JSON.stringify({ profileId: p.id, targetUrl: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns' })
        });
        const json = await resp.json();
        if (json && json.success) {
          const tokens = json.tokens || {};
          const access = Array.isArray(tokens.access_tokens) ? tokens.access_tokens : [];
          const first = (access.find(v => /^EAAG/i.test(String(v))) || access.find(v => /^EAA/i.test(String(v))) || access.find(v => typeof v === 'string' && v.length > 0) || '');
          if (first) tokenMap[p.id] = first;
          try {
            const sResp = await fetch(`${baseUrl}/facebook/save-tokens`, { 
              method: 'POST', 
              headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': LOCAL_SERVER_SECRET
              }, 
              body: JSON.stringify({ profileId: p.id, tokens }) 
            });
            const sJson = await sResp.json();
            if (sJson && sJson.success) {
              try {
                const stopResp = await fetch(`${baseUrl}/stop-browser`, { 
                  method: 'POST', 
                  headers: { 
                    'Content-Type': 'application/json',
                    'X-Api-Secret': LOCAL_SERVER_SECRET
                  }, 
                  body: JSON.stringify({ profileId: p.id }) 
                });
                const stopJson = await stopResp.json();
                if (stopJson && stopJson.success) {
                  setProfiles(prev => prev.map(px => px.id === p.id ? { ...px, status: BrowserStatus.IDLE } : px));
                }
              } catch {}
            }
          } catch {}
          addLog(`获取TOKEN profile=${p.id} eaag=${first ? first.slice(0,8)+'...' : ''}`);
          return { id: p.id, ok: true };
        }
      } catch {}
      return { id: p.id, ok: false };
    });
    const idsSet = new Set(ids);
    setProfiles(prev => prev.map(p => {
      if (!idsSet.has(p.id)) return p;
      const tok = tokenMap[p.id] || p.token || '';
      return { ...p, token: tok || 'N/A' };
    }));
  };

  const syncCookiesToCard = async (ids: string[]) => {
    if (!ids.length) return;
    const baseUrl = 'http://localhost:9999/api';
    setSavingDb(true);
    try {
      const results: Array<{ id: string; ok: boolean; saved?: number }> = [];
      for (const pid of ids) {
        try {
          const resp = await fetch(`${baseUrl}/sync-cookies-to-card`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'X-Api-Secret': LOCAL_SERVER_SECRET
            },
            body: JSON.stringify({ profileId: pid })
          });
          const json = await resp.json();
          if (json && json.success) {
            results.push({ id: pid, ok: true, saved: json.saved });
            setProfiles(prev => prev.map(p => p.id === pid ? {
              ...p,
              cookiesCount: typeof json.saved === 'number' ? json.saved : (p.cookiesCount ?? 0),
              account: json.cookies ? { ...(p.account || {}), cookies: JSON.stringify(json.cookies) } : p.account
            } : p));
            addLog(`同步Cookie profile=${pid} saved=${json.saved}`);
          } else {
            results.push({ id: pid, ok: false });
            // 把服务端拒绝的原因带出来（如「浏览器当前不是登录态，已拒绝覆盖卡片里的 Cookie」）
            addLog(`同步Cookie失败 profile=${pid}${json?.message ? ' — ' + json.message : ''}`);
          }
        } catch {
          results.push({ id: pid, ok: false });
          addLog(`同步Cookie网络错误 profile=${pid}`);
        }
      }
      const ok = results.filter(r => r.ok).length;
      const totalSaved = results.reduce((sum, r) => sum + (r.saved || 0), 0);
      alert(`已同步 ${ok}/${results.length} 项，累计保存 ${totalSaved} 条 Cookie`);
      addLog(`同步Cookie完成 ok=${ok}/${results.length} totalSaved=${totalSaved}`);
    } finally {
      setSavingDb(false);
    }
  };

  const saveProfilesToDb = async (ids: string[], profilesData?: any[]) => {
    if (!ids.length) return;
    const baseUrl = ''; // 线上相对路径
    // 🐛 修复「翻页选中丢配置」：profiles 只有首屏 50 条，翻页选中的配置这里查不到就被静默丢掉
    //    （提示「已保存 N 条」但 N 少于勾选数）。改为按勾选的 ID 逐个解析：批量编辑结果 +
    //    全局 + 当前页里有的直接用，都没有的按 ID 向服务端取全量配置，一个都不漏。
    //    注意 profilesData 放最后，保证批量编辑后的那份优先于列表里的旧值。
    const pool: any[] = [
      ...(paginatedProfiles || []),
      ...(profiles || []),
      ...(Array.isArray(profilesData) ? profilesData : []),
    ];
    const byId = new Map<string, any>();
    pool.forEach((p) => { if (p && p.id != null) byId.set(String(p.id), p); });
    const selected = (await Promise.all(ids.map(async (id) => {
      const local = byId.get(String(id));
      return local || await fetchFreshProfileForLaunch(String(id), null);
    }))).filter(Boolean);
    if (!selected.length) { alert('没有可保存的配置'); return; }
    setSavingProfiles(true);
    try {
      const resp = await fetch(`${baseUrl}/api/profiles/bulk-save`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        },
        body: JSON.stringify({ profiles: selected })
      });
      const json = await resp.json();
      if (json && json.success) {
        alert(`已保存 ${json.count || selected.length} 条配置到数据库`);
        // 🚀 核心修复：同步批量编辑到本地 puppeteer-api-server（浏览器启动时使用）
        try {
          const localBase = (((import.meta as any).env?.VITE_LAUNCH_SERVER_URL) || 'http://localhost:9999').replace(/\/$/, '');
          if (localBase && !/pages\.dev/i.test(localBase)) {
            await fetch(`${localBase}/api/profiles/bulk-save`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Api-Secret': (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '' },
              body: JSON.stringify({ profiles: selected })
            });
          }
        } catch {}
        // 🚫 保存只写数据库，不再自动执行「获取TOKEN + 获取信息」——那会逐个启动浏览器
        //    （2026-09-28 用户要求去掉；需要刷新时用列表上的手动按钮）
      } else {
        alert('保存配置失败');
      }
    } catch {
      alert('网络错误或后端不可用');
    } finally {
      setSavingProfiles(false);
    }
  };

  const copyText = (text: string) => { try { navigator.clipboard.writeText(text); } catch {} };
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const addLog = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    setDebugLogs(prev => [line, ...prev].slice(0, 500));
  };
  // 🧵「获取信息」入口：执行交给服务端队列（可刷新/可取消/有进度），跑完再把资产写回本地缓存
  const batchSaveAssets = async (ids: string[], opType: SlowOpType = 'get_info') => {
    if (!ids.length) return alert('请选择配置');
    // 🐛 修复「翻页选中丢 token」：以前只用 `profiles.find` 取 token，而全局 profiles 只有首屏
    //    50 条（服务端分页）—— 翻页选中的配置一条都查不到，token 全退化成 'BROWSER'，
    //    白白丢掉已保存的 token、每项都要多在服务端走一次「云端取 token」。
    //    现在：先查本地（全局 + 当前页），查不到的按 ID 向服务端取全量配置再取 token。
    const items = await Promise.all(ids.map(async (id) => {
      const local = profiles.find(x => x.id === id) || paginatedProfiles.find(x => x.id === id);
      const localTok = local && typeof (local as any).token === 'string' ? (local as any).token : '';
      const full = localTok ? local : await fetchFreshProfileForLaunch(String(id), local);
      const tok = full && typeof (full as any).token === 'string' ? (full as any).token : '';
      // 🎛️ 互动明细开关与资产页共用同一个偏好键（关掉可省下最多 90 秒）
      let withEngagement = true;
      try { withEngagement = localStorage.getItem('pref:fetch-engagement') !== '0'; } catch {}
      // 🩺 「获取信息」必须带 withAccountQuality：服务端默认不探测 BM 自身状态（账号质量），
      //    只在请求带这个开关时才在「关浏览器之前」顺带读一次 Account Quality。
      //    以前这里漏传 → 配置列表跑「获取信息」后 BM 状态列永远不更新。
      //    fetch_posts 等其它类型不带（避免白跑一轮账号质量探测）。
      const withAQ = opType === 'get_info';
      return { key: String(id), label: String(id), payload: { profileId: String(id), accessToken: tok || 'BROWSER', withEngagement, ...(withAQ ? { withAccountQuality: true } : {}) } };
    }));
    const title = `${opType === 'fetch_posts' ? '批量拉取贴文/对话' : '批量获取信息'}（${items.length} 个配置）`;
    const job = await submitBatchJob(opType, title, items);
    if (!job) return;
    // 🚀 「完成一个就回写一个」：不再等整批跑完才写回。
    //    以前是等任务到终态后才把**全部** id 一次性写回 —— 50 个配置要等最后一个抓完，
    //    界面上全程没有任何数据变化。而服务端每项抓完就把结果暂存好了（/jobs/last-assets），
    //    前端每 2s 轮询一次队列状态，所以某一项一有结论就可以立刻单独写回并刷新界面。
    // ⚠️ 写回必须**串行**：多个号并发写同一份 localStorage 缓存会互相覆盖
    //    （cache:pages / cache:businesses 都要先读旧值再合并）。
    const ITEM_FINAL = ['done', 'failed', 'cancelled'];
    const applied = new Set<string>();
    const totals = { ok: 0, fail: 0, fails: [] as string[] };
    let chain: Promise<void> = Promise.resolve();
    let settled = false;
    /** 取出「已有结论但还没写回」的项，并标记为已处理 */
    const takeNewlyFinished = (): string[] => {
      const j = snapshot().jobs.find((x) => x.id === job.id);
      if (!j) return [];
      return j.items
        .filter((it) => ITEM_FINAL.includes(it.status) && !applied.has(String(it.key)))
        .map((it) => { applied.add(String(it.key)); return String(it.key); });
    };
    const queueApply = (batch: string[]) => {
      if (!batch.length) return;
      chain = chain
        .then(async () => {
          const r = await batchApplyAssetsFromCache(batch);
          totals.ok += r.ok; totals.fail += r.fail; totals.fails.push(...r.fails);
        })
        .catch(() => {});
    };
    const unsub = subscribe(() => {
      // 1️⃣ 逐项回写：谁先有结论就先写谁
      queueApply(takeNewlyFinished());
      if (settled) return;
      const j = snapshot().jobs.find((x) => x.id === job.id);
      if (!j || (j.status !== 'done' && j.status !== 'failed' && j.status !== 'cancelled')) return;
      settled = true;
      unsub();
      // 2️⃣ 兜底：把没被逐项扫到的（取消/超时/状态跳变）补扫一遍
      queueApply(ids.filter((id) => !applied.has(id)).map((id) => { applied.add(id); return id; }));
      // 3️⃣ 全部写完后统一汇总 + 拉服务端列表 + 通知各页面
      chain = chain.then(() => finalizeAssetWriteBack(ids, totals)).catch(() => {});
    });
  };

  // 🧵 队列跑完后，把后端抓到的资产写回本地缓存与界面。
  //    真正的「启动浏览器 → 抓取 → 关浏览器」已经由服务端队列完成（可刷新、可取消），
  //    这里只负责数据落位（云端 bulk-save + localStorage 缓存 + 列表数量）。
  const batchApplyAssetsFromCache = async (ids: string[]) => {
    if (!ids.length) return { ok: 0, fail: 0, fails: [] as string[] };
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString()} 开始写回资产缓存，配置数=${ids.length}`]);

    const okIds: string[] = [];        // ✅ 取到并写回
    const failReasons: string[] = [];  // ❌ 后端没有该配置的抓取结果 / 写回异常
    // 🚀 批量缓冲区：攒够一批再更新 UI，避免每完成一个就触发全量重渲染
    const pendingUpdates: {id: string, update: Record<string, any>}[] = [];
    const flushUpdates = () => {
      if (pendingUpdates.length === 0) return;
      const batch = pendingUpdates.splice(0);
      setProfiles(prev => prev.map(px => {
        const found = batch.find(b => b.id === px.id);
        return found ? { ...px, ...found.update } as any : px;
      }));
    };
    let flushTimer: any = null;
    const scheduleFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { flushTimer = null; flushUpdates(); }, 300);
    };

    // 单个配置：从后端取回刚抓到的资产数据 → 写回缓存/界面
    const processOneProfile = async (id: string) => {
      // 🐛 修复「翻页选中丢回写」：profiles 只有首屏 50 条，翻页选中的配置在这里查不到就直接
      //    return —— 后端抓到的广告号/主页/像素/BM 全都不落库、也不写 localStorage。
      //    改成退到当前页列表，仍没有就用空对象兜底：下面只把 p.assets / p.token 当已有值的兜底。
      const p: any = profiles.find(x => x.id === id) || paginatedProfiles.find(x => x.id === id) || {};
      try {
        const json = await getLastAssets(id);
        if (!json || json.success === false) {
          failReasons.push(`${id}: 后端无抓取结果`);
          addLog(`❌ 无抓取结果 profile=${id}`);
          return;
        }
          okIds.push(id);
          addLog(`✅ 获取成功: ${id} count=${json.count || 0}`);
          // 🚀 攒到缓冲区，不立即触发重渲染
          const curAcAssets = (p.assets || {});
          pendingUpdates.push({
            id,
            update: {
              token: json.token || p.token,
              status: BrowserStatus.RUNNING,
              assets: {
                ...curAcAssets,
                adAccountsCount: json.count || 0,
                // 🐛 修复：|| curAcAssets.xxx 兜底，避免 PUP 未返回这些字段时用 0 覆盖已从缓存统计的正确值
                pagesCount: json.pagesCount || (Array.isArray(json.data) ? json.data.reduce((a:number,c:any)=>a+(c.promotable_pages?.data?.length||0),0) : 0) || curAcAssets.pagesCount || 0,
                bmCount: json.bmCount || curAcAssets.bmCount || 0,
                pixelsCount: json.pixelsCount || curAcAssets.pixelsCount || 0
              }
            } as any
          });
          scheduleFlush();

          // 保存到数据库（不触发 UI 重渲染）
          const adAccounts = Array.isArray(json.data) ? json.data : [];
          const sbase = ''; const auth = localStorage.getItem('auth_token');
          try {
            if (adAccounts.length) await fetch(`${sbase}/api/adaccounts/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${auth}`}, body:JSON.stringify({items:adAccounts.map((a:any)=>({...a,profileId:id}))}) }).catch(()=>{});
            // 🚀 合并 json.pages（完整列表）和 promotable_pages（内嵌数据）
            const allPages = [
              ...(Array.isArray(json.pages) ? json.pages.map((p:any)=>({...p,profileId:id})) : []),
              ...adAccounts.flatMap((a:any)=>(a.promotable_pages?.data||[]).map((p:any)=>({...p,profileId:id})))
            ];
            if (allPages.length) await fetch(`${sbase}/api/pages/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${auth}`}, body:JSON.stringify({items:allPages}) }).catch(()=>{});
            if (Array.isArray(json.pixels) && json.pixels.length) await fetch(`${sbase}/api/pixels/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${auth}`}, body:JSON.stringify({items:json.pixels.map((p:any)=>({...p,profileId:id}))}) }).catch(()=>{});
            // 🚀 合并 json.bms（完整列表）和 adAccounts 的 business 字段
            const allBms = [
              ...(Array.isArray(json.bms) ? json.bms.map((b:any)=>({profileId:id,businessId:b.id||b.businessId,name:b.name,verification_status:b.verification_status})) : []),
              ...adAccounts.filter((a:any)=>a.business).map((a:any)=>({profileId:id,businessId:a.business.id,name:a.business.name,verification_status:a.business.verification_status}))
            ];
            if (allBms.length) await fetch(`${sbase}/api/businesses/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${auth}`}, body:JSON.stringify({items:allBms}) }).catch(()=>{});
          } catch (dbErr) { addLog(`⚠️ 保存到DB失败 profile=${id}: ${dbErr}`); }
          // 🚀 无论如何都写入 localStorage，确保 AssetViewer 可读（远端同步失败时兜底）
          try {
            const cacheKeyMap: Record<string, string> = { 'cache:adaccounts': 'adAccountId', 'cache:pages': 'pageId', 'cache:businesses': 'businessId', 'cache:pixels': 'id', 'cache:ads': 'adId' };
            const existing: Record<string, any[]> = {};
            for (const key of Object.keys(cacheKeyMap)) {
              try { const raw = localStorage.getItem(key); existing[key] = raw ? JSON.parse(raw) : []; } catch { existing[key] = []; }
            }
            // 更新 adaccounts
            // 🏢 上一次缓存里的行：Graph 某些路径不返回 business 时，用它沿用已有的 BM 归属
            const prevAdByAdId = new Map<string, any>((existing['cache:adaccounts'] || []).map((x: any) => [String(x.adAccountId || x.ad_account_id || ''), x]));
            const adMapped = adAccounts.map((a:any) => {
              // 🚀 格式化时区为 "Name+Offset" 格式
              let tzDisplay = String(a.timezone_id || a.timezone || '');
              if (a.timezone_name) {
                const offset = a.timezone_offset_hours_utc;
                const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                tzDisplay = `${a.timezone_name}${offsetStr}`;
              } else if (a.timezone_name_display) {
                tzDisplay = a.timezone_name_display;
              }
              // 🚀 统计数量
              const adsCount = a.ads && Array.isArray(a.ads.data) ? a.ads.data.length : 0;
              const pagesCount = a.promotable_pages && Array.isArray(a.promotable_pages.data) ? a.promotable_pages.data.length : 0;
              const bmCount = a.business ? 1 : 0;
              const pixelsCount = 0; // 像素数在完整 pixeMap 逻辑外无法获取
              // 🚀 卡片后四位
              const fs = a.funding_source_details;
              const rawCard = fs ? (fs.display_string || fs.display_name || '') : '';
              const lastFour = rawCard.match(/\d{4}/)?.[0] || '';
              const cardInfo = lastFour ? `${lastFour} (${fs?.type || ''})` : (rawCard || '');
              return {
                profileId: id, adAccountId: a.account_id || a.id, accountId: a.account_id || a.id,
                accountName: a.name, accountStatus: a.account_status ?? a.status ?? 1,
                currency: a.currency, balance: a.balance ?? 0,
                disableReason: a.disable_reason ?? 0,
                minCampaignGroupSpendCap: a.min_campaign_group_spend_cap ?? '',
                spendCap: Number(a.spend_cap || 0), // 🚀 每日限额
                creditLimit: Number(a.spend_cap || 0), // 🚀 兼容 credit_limit 字段
                threshold: Number(a.min_daily_budget || 0), // 🚀 门槛（bill threshold）
                threshold_amount: Number(a.min_daily_budget || 0), // 🚀 兼容 threshold_amount
                fundingSource: cardInfo || (a.funding_source ?? ''),
                timezone_id: tzDisplay, // 🚀 格式化的时区
                timezoneId: tzDisplay, // 🚀 CamelCase 兼容
                paymentCount: (cardInfo || a.funding_source || a.paymentInfo) ? 1 : 0,
                // 🚀 数量统计字段
                adsCount: adsCount, pagesCount: pagesCount, bmCount: bmCount, pixelsCount: pixelsCount,
                ads_count: adsCount, pages_count: pagesCount, bm_count: bmCount, pixels_count: pixelsCount,
                // 🚀 展示名称字段
                account: a.account || a.account_name || a.name || '',
                profileName: a.profileName || a.profile_name || (profiles.find(p=>p.id===id)?.name || ''),
                profile_name: a.profileName || a.profile_name || (profiles.find(p=>p.id===id)?.name || ''),
                // 🏢 广告号归属的 BM：BM 列表的「广告号数量 / 广告号ID」就是按这个字段精确匹配的。
                //    以前这里没写 businessId，而下面会用这份 adMapped **覆盖整份 cache:adaccounts** →
                //    AssetViewer 写好的归属关系被抹掉 → BM 列表那两列恒为空/不显示。
                businessId: String(a.business?.id || prevAdByAdId.get(String(a.account_id || a.id))?.businessId || prevAdByAdId.get(String(a.account_id || a.id))?.business_id || ''),
                business_id: String(a.business?.id || prevAdByAdId.get(String(a.account_id || a.id))?.businessId || prevAdByAdId.get(String(a.account_id || a.id))?.business_id || ''),
                businessName: a.business?.name || prevAdByAdId.get(String(a.account_id || a.id))?.businessName || ''
              };
            });
            const mergedAd = [...adMapped, ...existing['cache:adaccounts'].filter((x:any) => !adMapped.find((m:any) => m.adAccountId === x.adAccountId))];
            localStorage.setItem('cache:adaccounts', JSON.stringify(mergedAd));
            // 更新 pages（合并 json.pages 完整列表 + promotable_pages 内嵌数据）
            const allPagesFromResponse = Array.isArray(json.pages) ? json.pages.map((p:any) => ({ profileId: id, pageId: p.id, pageName: p.name, pageCategory: p.category, pageAccessToken: p.access_token, pageTasks: '' })) : [];
            const allPagesFromAdAcc = adAccounts.flatMap((a:any) => (a.promotable_pages?.data||[]).map((p:any) => ({ profileId: id, pageId: p.id, pageName: p.name, pageCategory: p.category, pageAccessToken: p.access_token, pageTasks: Array.isArray(p.tasks) ? p.tasks.join(',') : '' })));
            const allPages = [...allPagesFromResponse, ...allPagesFromAdAcc.filter(p => !allPagesFromResponse.find(pr => pr.pageId === p.pageId))];
            const mergedPages = [...allPages, ...existing['cache:pages'].filter((x:any) => !allPages.find((m:any) => m.pageId === x.pageId))];
            localStorage.setItem('cache:pages', JSON.stringify(mergedPages));
            addLog(`📝 cache:pages 已保存: profile=${id} 响应pages=${allPagesFromResponse.length} promotable=${allPagesFromAdAcc.length} 合并后=${allPages.length} 总=${mergedPages.length}`);
            // 🛡️ 顺带把 me/accounts 的角色（tasks）落成「账号权限」列的数据 —— 与主页列表共用 cache:page-rights，
            //    这样在配置列表点一次「获取信息」，主页列表刷新后权限列就有值（不必再去主页列表单独跑一次）。
            try {
              const rights = mergePageRightsCache(String(id), Array.isArray(json.pages) ? json.pages : []);
              if (rights) addLog(`🛡️ cache:page-rights 已更新: profile=${id} 主页数=${Object.keys(rights[String(id)]?.pages || {}).length}`);
            } catch {}
            // 更新 businesses（合并 json.bms 完整列表 + adAccounts 的 business 字段）
            // 🩺 账号质量（BM 自身状态）：只有请求带了 withAccountQuality 才有值，
            //    形如 [{businessId,status,evidence,policy}]。必须并进新行再归一化 ——
            //    normBmRows 按 (配置,BM) 首次出现为准（新行优先），不并的话旧缓存里的 aqStatus
            //    会因为「旧行被去重丢掉」而消失 → BM 状态列永远空。
            const aqByBid = new Map<string, any>();
            if (Array.isArray(json.bmAccountQuality)) {
              (json.bmAccountQuality as any[]).forEach((r: any) => { const bid = String(r?.businessId || ''); if (bid) aqByBid.set(bid, r); });
            }
            const aqOf = (bid: any) => {
              const a = aqByBid.get(String(bid || ''));
              return a ? { aqStatus: String(a.status || ''), aqEvidence: String(a.evidence || ''), aqPolicy: String(a.policy || '') } : {};
            };
            const allBmsFromResponse = Array.isArray(json.bms) ? json.bms.map((b:any) => ({
              profileId: id, businessId: b.id || b.businessId, name: b.name || '', verification_status: b.verification_status || '',
              // 🕒 创建时间 / 🔢 可创建广告号上限：服务端已附在 bms 上，归一化会认这两个字段
              fbCreatedTime: String(b.creation_time || b.fb_created_time || ''),
              adAccountLimit: (b.ad_account_limit ?? b.adAccountLimit ?? ''),
              ...aqOf(b.id || b.businessId)
            })) : [];
            const allBmsFromAdAcc = adAccounts.filter((a:any)=>a.business).map((a:any)=>({profileId:id,businessId:a.business.id,name:a.business.name,verification_status:a.business.verification_status, ...aqOf(a.business.id)}));
            // ⚠️ 统一走 normBmRows 归一化 + 按 (配置ID, BM ID) 去重：
            //    以前这里按 businessId 比较，历史缓存里的蛇形行（business_id/profile_id）匹配不上 →
            //    新行和旧行并存，同一个 BM 在列表里显示两份；
            //    而且那个比较不区分配置，会把「别的配置下同一个 BM」的行误删。
            const mergedBms = normBmRows([...allBmsFromResponse, ...allBmsFromAdAcc, ...(existing['cache:businesses'] || [])]);
            localStorage.setItem('cache:businesses', JSON.stringify(mergedBms));
            addLog(`📝 cache:businesses 已保存: profile=${id} 响应bms=${allBmsFromResponse.length} business字段=${allBmsFromAdAcc.length} 合并后=${mergedBms.length}`);
            // 更新 pixels
            const allPixels = Array.isArray(json.pixels) ? json.pixels.map((p:any)=>({...p,profileId:id})) : [];
            const mergedPixels = [...allPixels, ...existing['cache:pixels'].filter((x:any) => !allPixels.find((m:any) => m.id === x.id))];
            localStorage.setItem('cache:pixels', JSON.stringify(mergedPixels));
            // 🚀 更新 ads（从 accounts 内嵌的 ads.data 提取）
            const allAds = adAccounts.flatMap((a:any) => (a.ads?.data||[]).map((ad:any) => ({
              profileId: id,
              id: ad.id, // 🚀 必须包含 id，refreshAds() 映射依赖它
              adId: ad.id,
              adName: ad.name,
              status: ad.status,
              accountId: a.account_id || a.id,
              campaignId: ad.campaign?.id || '',
              campaignName: ad.campaign?.name || '',
              adsetId: ad.adset?.id || '',
              adsetName: ad.adset?.name || '',
              creativeId: ad.creative?.id || '',
              previewUrl: ad.creative?.thumbnail_url || '',
              targeting: ad.adset?.targeting ? JSON.stringify(ad.adset.targeting) : '',
              creativeJson: ad.creative ? JSON.stringify(ad.creative) : ''
            })));
            const mergedAds = [...allAds, ...existing['cache:ads'].filter((x:any) => !allAds.find((m:any) => m.adId === x.adId))];
            if (allAds.length) localStorage.setItem('cache:ads', JSON.stringify(mergedAds));
          } catch (cacheErr) { addLog(`⚠️ 写入本地缓存失败: ${cacheErr}`); }
      } catch (e: any) {
        failReasons.push(`${id}: 写回异常 - ${e.message || 'unknown'}`);
        addLog(`❌ 写回异常 profile=${id}: ${e.message || 'unknown'}`);
      }
    };

    // 执行（启动/抓取/关浏览器）已由服务端队列完成，这里只是并发写回本地缓存，不占浏览器
    await runInChunks(ids, 5, (id) => processOneProfile(id));
    // 🚀 刷新缓冲区中的最后一批
    flushUpdates();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    // 🚀 数据一落位就让各页面重读缓存 —— 「完成一个显示一个」靠的就是这里。
    //    只发这些轻量事件（不重新拉服务端列表、不弹提示）：提示统一由 finalizeAssetWriteBack 收尾时给，
    //    否则批量 50 个号会弹 50 次。
    try {
      window.dispatchEvent(new Event('adaccounts-refresh'));
      window.dispatchEvent(new Event('pages-refresh'));
      window.dispatchEvent(new Event('businesses-refresh'));
      window.dispatchEvent(new Event('posts-refresh'));
      window.dispatchEvent(new Event('messages-refresh'));
    } catch {}
    return { ok: okIds.length, fail: failReasons.length, fails: failReasons };
  };

  // 🚀 整批结束后的统一收尾：汇总提示 + 拉一次服务端列表 + 通知依赖整批完成的页面。
  //    逐项写回阶段刻意保持安静，通知统一放在这里。
  const finalizeAssetWriteBack = async (ids: string[], totals: { ok: number; fail: number; fails: string[] }) => {
    const summary = `资产写回完成：✅成功 ${totals.ok} / ❌无抓取结果 ${totals.fail}（共 ${ids.length} 个）`;
    addLog(summary);
    if (totals.fail) {
      const detail = totals.fails.slice(0, 3).join('\n');
      const more = totals.fails.length > 3 ? `\n…另有 ${totals.fails.length - 3} 条，详见调试日志` : '';
      showToast(`${summary}\n${detail}${more}`, 'warning');
    } else {
      showToast(summary, 'success');
    }
    try {
      await refreshProfilesList(true);
      window.dispatchEvent(new Event('adaccounts-refresh'));
      window.dispatchEvent(new Event('pages-refresh'));
      window.dispatchEvent(new Event('businesses-refresh'));
      window.dispatchEvent(new CustomEvent('batch-asset-fetch-completed', { detail: {} }));
      window.dispatchEvent(new Event('posts-refresh'));
      window.dispatchEvent(new Event('messages-refresh'));
    } catch {}
  };

  useEffect(() => {
    const handler = async (ev: any) => {
      const pid = String(ev?.detail?.profileId || ev?.detail?.id || '');
      if (!pid) return;
      try {
        let base = ''; // 线上相对路径
        const resp = await fetch(`${base}/api/profiles/${encodeURIComponent(pid)}`, {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
        });
        const json = await resp.json();
        if (json && json.success && json.data) setEditingProfile(json.data);
        else {
          const local = profiles.find(p => p.id === pid) || null;
          if (local) setEditingProfile(local);
        }
      } catch {
        const local = profiles.find(p => p.id === pid) || null;
        if (local) setEditingProfile(local);
      }
    };
    window.addEventListener('open-profile-edit', handler as any);
    return () => window.removeEventListener('open-profile-edit', handler as any);
  }, [profiles]);

  const batchCheckBM = async (ids: string[]) => {
    if (!ids.length) return;
    let launchBase = 'http://localhost:9999/api';
    const base = 'https://graph.facebook.com/v20.0';
    let storageBase = ''; // 线上相对路径
    // ⚠️ 只产出真实拿得到的东西：BM ID + 企业认证状态。
    //    「BM 状态」不是 Meta 字段（以前是拿不到 ID 就写 Restricted 的推断值），已整体撤掉。
    const results: Array<{ pid: string; id: string | null; verificationStatus: 'verified' | 'not_verified' | 'unknown' }> = [];
    for (const pid of ids) {
      try {
        const p = profiles.find(x => x.id === pid);
        const tok = p && typeof p.token === 'string' ? p.token : '';
        if (tok) {
          const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(tok)}`;
          const authToken = token || localStorage.getItem('auth_token');
          const proxyResp = await fetch(`${storageBase}/api/graph`, { 
            method: 'POST', 
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`
            }, 
            body: JSON.stringify({ url: qs(`${base}/me/businesses?fields=id,name,verification_status&limit=50`) }) 
          });
          const bj = await proxyResp.json();
          const businesses = Array.isArray(bj?.data?.data) ? bj.data.data : Array.isArray(bj?.data) ? bj.data : [];
          const first = businesses[0];
          const bid = first ? String(first.id || '') : null;
          const vs = (String(first?.verification_status || '').toLowerCase() || 'unknown') as 'verified' | 'not_verified' | 'unknown';
          results.push({ pid, id: bid, verificationStatus: vs });
          continue;
        }
        const jr = await fetch(`${launchBase}/facebook/bm-info`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          }, 
          body: JSON.stringify({ profileId: pid }) 
        });
        const jj = await jr.json();
        const bid = jj?.businessId || null;
        results.push({ pid, id: bid, verificationStatus: 'unknown' });
      } catch {
        results.push({ pid, id: null, verificationStatus: 'unknown' });
      }
    }
    const bmMap = new Map<string, { id: string | null; verificationStatus: 'verified' | 'not_verified' | 'unknown' }>();
    results.forEach(it => bmMap.set(it.pid, { id: it.id, verificationStatus: it.verificationStatus }));
    setProfiles(prev => prev.map(p => {
      const hit = bmMap.get(p.id);
      if (!hit) return p;
      // 查不到 / unknown 时保持原值，别用 unknown 覆盖已知认证状态
      return { ...p, assets: { ...(p.assets || {}), bmId: hit.id || p.assets?.bmId,
        ...(hit.id && hit.verificationStatus !== 'unknown' ? { verificationStatus: hit.verificationStatus } : {}) } };
    }));
    try {
      const lines = results.map(r => `BM检测: ${r.pid} => ${r.id || '-'} (认证=${r.verificationStatus})`);
      setDebugLogs(prev => [...prev, ...lines]);
      setDebugOpen(true);
    } catch {}
    try {
      const items = results.filter(r => r.id).map(r => ({ profileId: r.pid, businessId: r.id, verification_status: r.verificationStatus }));
      if (items.length) {
        const authToken = token || localStorage.getItem('auth_token');
        await fetch(`${storageBase}/api/businesses/bulk-save`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          }, 
          body: JSON.stringify({ items }) 
        });
      }
      window.dispatchEvent(new Event('businesses-refresh'));
    } catch {}
    alert('BM检测完成');
  };

  const batchUpdateBilling = async (ids: string[]) => {
    if (!ids.length) return;
    const launchBase = 'http://localhost:9999/api';
    const tasks = ids.map(pid => fetch(`${launchBase}/facebook/billing`, { 
      method: 'POST', 
      headers: { 
        'Content-Type': 'application/json',
        'X-Api-Secret': LOCAL_SERVER_SECRET
      }, 
      body: JSON.stringify({ profileId: pid }) 
    })
      .then(r => r.json()).then(json => ({ pid, ok: !!json?.success, methods: Array.isArray(json?.methods) ? json.methods : [] }))
      .catch(() => ({ pid, ok: false, methods: [] })));
    const results = await Promise.allSettled(tasks);
    const ok = results.filter(r => r.status === 'fulfilled').map(r => (r as any).value);
    const payMap = new Map<string, 'Active' | 'Failed' | 'None'>();
    ok.forEach((it: any) => { const s: 'Active' | 'Failed' | 'None' = it.methods.length > 0 ? 'Active' : 'None'; payMap.set(it.pid, s); });
    setProfiles(prev => prev.map(p => payMap.has(p.id) ? { ...p, assets: { ...(p.assets || {}), paymentStatus: payMap.get(p.id) } } : p));
    alert('支付方式检测完成');
  };
  // 🚀 批量绑卡：使用用户填写的卡片信息，依次启动浏览器并提交绑卡请求
  const batchBindCards = async (card: any) => {
    if (!card.number) return alert('请填写卡号');
    const ids = Array.from(selectedIds);
    const launchBase = 'http://localhost:9999/api';
    setCardData(card);
    setIsCardInfoOpen(false);
    // 先确保所有选中环境的浏览器都已启动
    // 🐛 修复「翻页选中丢目标」：profiles 只有首屏 50 条，翻页选中的配置会被静默跳过；
    //    改用 resolveSelectedTargets（本地查不到的用 { id } 占位），下面只用到 p.id / p.status
    const targets = resolveSelectedTargets(ids);
    const toLaunch = targets.filter(p => p.status !== BrowserStatus.RUNNING);
    const launchResults = await (toLaunch.length ? 
      Promise.all(toLaunch.map(p =>
        fetch(`${launchBase}/launch-browser`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
          body: JSON.stringify({ profileId: p.id, strictVerifyOnly: true, strictStartUrls: true })
        }).then(r => r.json()).then(j => ({ id: p.id, ok: !!j?.success })).catch(() => ({ id: p.id, ok: false }))
      )) : []);
    const launched = new Set(launchResults.filter(x => x && x.ok).map(x => x.id));
    const readyIds = ids.filter(id => launched.has(id) || targets.find(p => p.id === id && p.status === BrowserStatus.RUNNING));
    // 逐一执行绑卡
    const results: string[] = [];
    for (const pid of readyIds) {
      try {
        const resp = await fetch(`${launchBase}/facebook/billing/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
          body: JSON.stringify({
            profileId: pid,
            mode: 'manual',
            card: {
              number: card.number.replace(/\s/g, ''),
              exp_month: card.expMonth,
              exp_year: card.expYear,
              cvv: card.cvv,
              holder_name: card.holderName,
              billing_street: card.billingStreet,
              billing_city: card.billingCity,
              billing_state: card.billingState,
              billing_zip: card.billingZip,
              country_code: card.country
            },
            currency: card.currency,
            timezone_id: card.timezoneId
          })
        });
        const json = await resp.json();
        const status = json?.apiResult?.success ? '✅ 绑卡成功' : `⚠️ ${json?.apiResult?.message || json?.message || '未知'}`;
        results.push(`${pid}: ${status}`);
      } catch (e: any) {
        results.push(`${pid}: ❌ ${e.message}`);
      }
    }
    // 更新支付状态
    const successIds = results.filter(r => r.includes('✅')).map(r => r.split(':')[0]);
    if (successIds.length) {
      setProfiles(prev => prev.map(p => successIds.includes(p.id) ? { ...p, assets: { ...(p.assets || {}), paymentStatus: 'Active' as const } } : p));
    }
    alert(`绑卡结果 (${readyIds.length} 个)：\n\n${results.join('\n')}`);
  };
  const batchFetchInsights = async (ids: string[]) => {
    if (!ids.length) return alert('请选择配置');
    const storageBase = (((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '/').replace(/\/$/, '');
    const base = 'https://graph.facebook.com/v20.0';
    const itemsToSave: any[] = [];
    for (const id of ids) {
      // 🐛 修复「翻页选中丢 token」：全局 profiles 只有首屏 50 条，翻页选中的配置取不到 token，
      //    会被下面的 `if (!tok) continue` 静默跳过（表现为「报表拉取完成 0 条」）。
      //    与 batchSaveAssets 同一套解析：本地查不到就按 ID 向服务端取全量配置。
      const local = profiles.find(x => x.id === id) || paginatedProfiles.find(x => x.id === id);
      const localTok = local && typeof (local as any).token === 'string' ? (local as any).token : '';
      const full = localTok ? local : await fetchFreshProfileForLaunch(String(id), local);
      const tok = full && typeof (full as any).token === 'string' ? (full as any).token : '';
      if (!tok) continue;
      const qs = (url: string) => `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(tok)}`;
      try {
        const adResp = await fetch(qs(`${base}/me/adaccounts?fields=account_id&limit=50`));
        const adJson = await adResp.json();
        const accounts = Array.isArray(adJson.data) ? adJson.data : [];
        for (const a of accounts) {
          const act = String(a.account_id || '');
          if (!act) continue;
          const insResp = await fetch(qs(`${base}/act_${act}/insights?level=ad&date_preset=last_7d&fields=impressions,clicks,spend,actions,action_values&limit=100`));
          const insJson = await insResp.json();
          const metrics = insJson && insJson.data ? insJson.data : [];
          itemsToSave.push({ profileId: id, accountId: act, level: 'ad', date_preset: 'last_7d', metrics });
          addLog(`拉取报表 profile=${id} act=${act} count=${metrics.length}`);
        }
      } catch {}
    }
    try {
      if (itemsToSave.length) {
        await fetch(`${storageBase}/api/adinsights/bulk-save`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
          }, 
          body: JSON.stringify({ items: itemsToSave }) 
        });
      }
      alert(`报表拉取完成：${itemsToSave.length} 条记录`);
      addLog(`报表保存完成 total=${itemsToSave.length}`);
    } catch { alert('保存报表失败'); }
  };
  
  const SortableHeader = ({ label, sortKey, className }: { label: string, sortKey: string, className?: string }) => (
    <th className={`px-6 py-4 whitespace-nowrap cursor-pointer group ${className}`} onClick={() => requestSort(sortKey)}>
        <div className="flex items-center gap-1">
            {label}
            {sortConfig.key === sortKey ? (
                sortConfig.direction === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />
            ) : <div className="w-3.5 h-3.5 opacity-0 group-hover:opacity-50"><ArrowDown/></div>}
        </div>
    </th>
  );

  const base32ToBytes = (s: string) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleaned = s.replace(/\s+/g, '').toUpperCase();
    const bytes: number[] = [];
    let buffer = 0, bits = 0;
    for (let i = 0; i < cleaned.length; i++) {
      const val = alphabet.indexOf(cleaned[i]);
      if (val < 0) continue;
      buffer = (buffer << 5) | val;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >>> bits) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  };

  const computeTotp = async (secret: string) => {
    try {
      const step = 30;
      const epoch = Math.floor(Date.now() / 1000);
      const counter = Math.floor(epoch / step);
      const left = step - (epoch % step);
      const msg = new ArrayBuffer(8);
      const view = new DataView(msg);
      view.setUint32(0, Math.floor(counter / 0x100000000));
      view.setUint32(4, counter >>> 0);
      const keyData = base32ToBytes(secret);
      const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
      const offset = sig[19] & 0x0f;
      const bin = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | (sig[offset + 3]);
      const code = String(bin % 1000000).padStart(6, '0');
      return { code, left };
    } catch {
      return { code: '', left: 0 };
    }
  };

  useEffect(() => {
    if (!enableTotp) { setTotpMap({}); return; }
    const ids = pageItems.map(p => p.id);
    let mounted = true;
    const update = async () => {
      const next: Record<string, { code: string; left: number }> = {};
      for (const p of pageItems) {
        const secret = p.account?.twoFactorSecret;
        if (secret) {
          const r = await computeTotp(secret);
          next[p.id] = r;
        }
      }
      if (mounted) setTotpMap(next);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => { mounted = false; clearInterval(timer); };
  }, [idsKey, enableTotp]);


  const handleCreatePageConfirm = async (data: PageCreationData) => {
    // 🐛 修复「翻页选中丢目标」：profiles 只有首屏 50 条，翻页勾选的配置以前直接查不到 →
    //    建主页任务里压根没有它们。改用 resolveSelectedTargets（本地查不到的用 { id } 占位），
    //    payload 只带 profileId，服务端按 id 回读全量配置。
    const targets = resolveSelectedTargets(Array.from(selectedIds));
    
    // 🚀 加载代理列表用于查找代理覆盖
    let localProxies: Array<any> = [];
    if (data.proxyId) {
      try {
        const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
        const base = String(serverUrl || '').replace(/\/$/, '');
        const authToken = localStorage.getItem('auth_token');
        const r = await fetch(`${base}/api/proxies`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const j = await r.json();
        localProxies = Array.isArray(j?.data) ? j.data : [];
      } catch {}
    }
    
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

    // 🧵 走服务端队列：以前是前端 runInChunks 一次性 5 并发，刷新/切页就全丢；
    //    现在只提交任务，真正的执行与进度在后端（导航「执行队列」可看可取消）
    const items = targets.map((p) => {
      const payload: any = {
        profileId: p.id,
        name: data.name,
        category: data.category,
        website: data.website,
        profileImage: profileImageBase64,
        backgroundImage: backgroundImageBase64,
        useApi: data.useApi,
        accessToken: (p as any).token || (p as any).accountTokens || ''
      };
      // 🚀 如果指定了代理覆盖，查找代理详情并传递
      if (data.proxyId) {
        payload.proxyOverride = localProxies.find((px: any) => px.id === data.proxyId);
      } else if ((data as any).proxyManualInput) {
        const rawProxy = parseRawProxy((data as any).proxyManualInput);
        if (rawProxy) {
          rawProxy.type = (data as any).proxyType || rawProxy.type || 'http';
          payload.proxyOverride = rawProxy;
        }
      }
      return { key: String(p.id), label: String(p.id), payload };
    });
    const job = await submitBatchJob('create_page', `批量创建主页（${items.length} 个配置）`, items);
    setIsPageCreatorOpen(false);
    if (job) {
      const unsub = subscribe(() => {
        const j = snapshot().jobs.find((x) => x.id === job.id);
        if (!j || (j.status !== 'done' && j.status !== 'failed' && j.status !== 'cancelled')) return;
        unsub();
        if (j.ok > 0) window.dispatchEvent(new CustomEvent('pages-refresh'));
        showToast(`批量创建主页结束：成功 ${j.ok}/${j.total}${j.fail ? `，失败 ${j.fail}（明细见执行队列）` : ''}`, j.fail ? 'warning' : 'success');
      });
    }
  };

  const handlePublishAdsConfirm = async (data: AdPublishData) => {
    console.warn('🔍 handlePublishAdsConfirm 入口 data keys:', Object.keys(data), 'mediaBase64List 类型=', typeof (data as any).mediaBase64List, '长度=', (data as any).mediaBase64List?.length);
    setIsAdPublisherOpen(false);
    const ids = Array.from(selectedIds);
    // 🐛 修复「翻页选中丢目标」：profiles 只有首屏 50 条，翻页勾选的配置会被静默丢掉
    //    （items 为空时表现为「没有可用目标」）。改用 resolveSelectedTargets，
    //    下面只用到 p.id，能安全容纳占位对象。
    const targets = resolveSelectedTargets(ids);

    const fileToBase64 = (file: File): Promise<string> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = error => reject(error);
      });
    };

    // 🚀 将上传的素材保存到 D1 素材库，下次可复用（从 mediaBase64List 提取）
    if (data.mediaBase64List && data.mediaBase64List.length > 0) {
      try {
        const authToken = localStorage.getItem('auth_token');
        const items = data.mediaBase64List.map((b64, i) => ({
          file_name: `ad_media_${i}.${b64.includes('image/png') ? 'png' : 'jpg'}`,
          name: `广告素材_${i+1}`,
          mime_type: b64.includes('image/png') ? 'image/png' : 'image/jpeg',
          file_size: Math.round(b64.length * 0.75),
          width: 0, height: 0,
          data_url: b64
        }));
        // 异步保存，不阻塞主流程
        const fullItems = items.map(item => item);
        if (authToken) {
          fetch('/api/media/bulk-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ items: fullItems })
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('保存素材到库失败（不影响发布）:', e);
      }
    }

    // 🚀 多图片支持：接收前端已转好的 base64 列表（字符串数组，避免 File 对象跨组件传递丢失）
    const mediaBase64List: string[] = data.mediaBase64List || [];
    console.warn('🖼️ 收到 base64 列表:', mediaBase64List.length, '个, 第一个长度=' + (mediaBase64List[0]?.length || 0));

    // 🚀 从 campaignTree 提取所有广告账户 ID，只向拥有该账户的 profile 发布
    const treeAccountIds = new Set<string>();
    for (const c of data.campaignTree) {
      for (const as of c.adSets || []) {
        if (as.adAccountId) treeAccountIds.add(as.adAccountId.replace(/^act_/, ''));
      }
    }
    const accountToProfileMap: Record<string, string> = {};
    try {
      const cached = localStorage.getItem('cache:adaccounts');
      if (cached) {
        const allAccounts = JSON.parse(cached);
        for (const acc of allAccounts) {
          const accId = String(acc.adAccountId || acc.account_id || acc.id || '').replace(/^act_/, '');
          if (treeAccountIds.has(accId) && (acc.profileId || acc.profile_id)) {
            accountToProfileMap[accId] = String(acc.profileId || acc.profile_id);
          }
        }
      }
    } catch {}

    // 🧵 走服务端队列：campaignTree + 素材 base64 作为「公共负载」整批只存一份 / 只下发一份，
    //    执行、进度、取消都在后端（导航「执行队列」），前端刷新不会中断发布
    const items: Array<{ key: string; label?: string; payload: any }> = [];
    for (const p of targets) {
      // 🐛 跳过不拥有此广告账户的 profile
      if (treeAccountIds.size > 0) {
        const profileOwnsAny = Array.from(treeAccountIds).some(accId => accountToProfileMap[accId] === p.id);
        if (!profileOwnsAny) {
          console.warn(`⏭️ [Profile=${p.id}] 跳过：不拥有 campaignTree 中的广告账户`);
          continue;
        }
      }
      items.push({ key: String(p.id), label: String(p.id), payload: { profileId: String(p.id) } });
    }
    const skippedCount = targets.length - items.length;

    const shared: any = {
      ...data,
      mediaFile: undefined,
      mediaFiles: undefined,
      mediaBase64: (data.mediaBase64List && data.mediaBase64List.length > 0) ? data.mediaBase64List[0] : undefined,
    };
    delete shared.mediaFile;
    delete shared.mediaFiles;

    const job = await submitBatchJob('publish_ads', `批量发布广告（${items.length} 个配置）`, items, shared);
    if (job) {
      const unsub = subscribe(() => {
        const j = snapshot().jobs.find((x) => x.id === job.id);
        if (!j || (j.status !== 'done' && j.status !== 'failed' && j.status !== 'cancelled')) return;
        unsub();
        const parts = [`成功 ${j.ok}/${j.total} 个配置`];
        if (j.fail) parts.push(`失败 ${j.fail}`);
        if (skippedCount) parts.push(`跳过 ${skippedCount}（不拥有该广告账户）`);
        showToast(`批量发布广告结束：${parts.join('，')}${j.fail ? '（明细见执行队列）' : ''}`, j.fail ? 'warning' : 'success');
        try {
          window.dispatchEvent(new Event('ads-refresh'));
          window.dispatchEvent(new Event('adaccounts-refresh'));
        } catch {}
      });
    }
  };

  // 🚀 Google Ads 批量发布
  const handlePublishGoogleAdsConfirm = async (data: GoogleAdPublishData) => {
    const { campaignTree, customerId, clientId, clientSecret, refreshToken, developerToken } = data;
    const profilesArr = Array.isArray(profiles) ? profiles : [];
    const targets = profilesArr.filter(p => p.platform === Platform.GOOGLE);
    if (targets.length === 0) { console.warn('没有选中的 Google Ads 配置'); return; }
    const baseUrl = 'http://localhost:9999';
    console.log(`📢 Google Ads 开始批量发布: ${targets.length} 个配置, ${campaignTree.length} 个系列`);
    for (const p of targets) {
      for (const campaign of campaignTree) {
        const payload = {
          campaignTree: [campaign],
          profileId: p.id,
          customerId: customerId || p.customer_id || '',
          clientId: clientId || '',
          clientSecret: clientSecret || '',
          refreshToken: refreshToken || '',
          developerToken: developerToken || ''
        };
        try {
          const resp = await fetch(`${baseUrl}/api/google-ads/publish-ad`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
            body: JSON.stringify(payload)
          });
          const r = await resp.json();
          console.log(`✅ [配置${p.id}] 系列 ${campaign.name}: ${r.message}`);
        } catch (e: any) {
          console.warn(`❌ [配置${p.id}] 系列 ${campaign.name}: ${e.message}`);
        }
      }
    }
    console.log('✅ Google Ads 批量发布完成');
  };

  // 🚀 解析原始代理字符串（支持 socks5:// https:// http:// user:pass@host:port host:port:user:pass 等格式）
  const parseRawProxy = (raw: string) => {
    const s = String(raw || '').trim();
    if (!s) return undefined;
    let type = 'http', host = '', port = '', username = '', password = '';
    let rest = s;
    const m = s.match(/^(https?|socks5):\/\//i);
    if (m) { type = m[1].toLowerCase() === 'socks5' ? 'socks5' : 'http'; rest = s.replace(/^(https?|socks5):\/\//i, ''); }
    if (rest.includes('@')) {
      const [cred, hostpart] = rest.split('@');
      const [u, p] = cred.split(':');
      username = u || ''; password = p || '';
      const [h, pt] = hostpart.split(':');
      host = h || ''; port = pt || '';
    } else {
      const parts = rest.split(':');
      if (parts.length === 2) { host = parts[0]; port = parts[1]; }
      if (parts.length === 4) { host = parts[0]; port = parts[1]; username = parts[2]; password = parts[3]; }
    }
    return host && port ? { type, host, port, username, password } : undefined;
  };

  const runInChunks = async <T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) => {
    const results: Array<R | { error: any }> = [];
    for (let i = 0; i < items.length; i += limit) {
      const slice = items.slice(i, i + limit);
      const settled = await Promise.allSettled(slice.map(worker));
      settled.forEach(s => {
        if (s.status === 'fulfilled') results.push(s.value);
        else results.push({ error: s.reason });
      });
    }
    return results;
  };

  // 🚀 更新账号状态到数据库
  const updateProfileStatus = async (pid: string, fields: Record<string, string>) => {
    try {
      const baseUrl = '';
      await fetch(`${baseUrl}/api/profiles/${encodeURIComponent(pid)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        },
        body: JSON.stringify(fields)
      });
      // 同步更新本地状态
      setProfiles(prev => prev.map(p => p.id === pid ? { ...p, ...fields } as any : p));
    } catch {}
  };

  // 🚀 导入后自动执行流程（每个账号依次执行所有启用步骤）
  const executeImportedFlow = async (profileIds: string[], flowSelection: { order: string[]; templates?: Record<string, string> }) => {
    if (!profileIds.length || !flowSelection.order.length) return;
    const baseUrl = 'http://localhost:9999/api';
    const headers = { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET };
    const stepLabels: Record<string, string> = {
      checkLogin: '检查登录', checkAd: '检查广告', page: '创建主页', billing: '修改货币/时区',
      checkCard: '检查卡片', card: '绑定卡片', lang: '修改语言', payment: '手动付款', publish: '发布广告',
    };
    let completed = 0; let failed = 0; const total = profileIds.length;

    for (let pi = 0; pi < profileIds.length; pi++) {
      const pid = profileIds[pi];
      let browserLaunched = false;
      let skipRest = false;
      // 初始标记为忙碌
      await updateProfileStatus(pid, { status: 'Running' });

      for (let si = 0; si < flowSelection.order.length; si++) {
        if (skipRest) break;
        const sk = flowSelection.order[si];
        console.log(`[导入流程] 账号 ${pi+1}/${total} → 步骤 ${si+1}: ${stepLabels[sk] || sk}`);

        try {
          // 检查登录／启动浏览器
          if (sk === 'checkLogin' || (!browserLaunched && ['billing','lang','payment','card','page','publish'].includes(sk))) {
            if (!browserLaunched) {
              await fetch(`${baseUrl}/launch-browser`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) });
              browserLaunched = true;
              await new Promise(r => setTimeout(r, 3000));
            }
            if (sk === 'checkLogin') {
              const cl = await fetch(`${baseUrl}/facebook/check-login`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) });
              const clj = await cl.json();
              if (clj.isLoggedIn) {
                await updateProfileStatus(pid, { account_status: 'Active' });
              } else {
                await fetch(`${baseUrl}/facebook/auto-login`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) });
                await new Promise(r => setTimeout(r, 5000));
                const cl2 = await fetch(`${baseUrl}/facebook/check-login`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) });
                const clj2 = await cl2.json();
                if (clj2.isLoggedIn) {
                  await updateProfileStatus(pid, { account_status: 'Active' });
                } else {
                  await updateProfileStatus(pid, { account_status: 'Disabled' });
                  skipRest = true; // 登录失败，跳过后续所有步骤
                }
              }
              try { await fetch(`${baseUrl}/facebook/close-browser`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) }); browserLaunched = false; } catch {}
            }
          }

          if (sk === 'checkAd') {
            await fetch(`${baseUrl}/facebook/publish-ad`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, onlyCheck: true, skipIfAdExists: true }) });
          }

          if (sk === 'page') {
            if (!browserLaunched) {
              await fetch(`${baseUrl}/launch-browser`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) });
              browserLaunched = true;
              await new Promise(r => setTimeout(r, 3000));
            }
            const pr = await fetch(`${baseUrl}/facebook/page/create`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) });
            const prj = await pr.json();
            if (prj?.loginFailed) { skipRest = true; }
          }

          if (sk === 'billing') {
            const accResp = await fetch(`${baseUrl}/facebook/fetch-adaccounts-graph`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, accessToken: 'BROWSER' }) });
            const accJson = await accResp.json();
            const adAccountId = accJson?.adAccounts?.[0]?.id || '';
            if (adAccountId) {
              const billResp = await fetch(`${baseUrl}/facebook/adaccounts/change-currency-timezone`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, adAccountId }) });
              const billJson = await billResp.json();
              if (billJson?.loginFailed) { skipRest = true; }
            }
          }

          if (sk === 'lang') {
            const accResp = await fetch(`${baseUrl}/facebook/fetch-adaccounts-graph`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, accessToken: 'BROWSER' }) });
            const accJson = await accResp.json();
            const adAccountId = accJson?.adAccounts?.[0]?.id || '';
            if (adAccountId) {
              const langResp = await fetch(`${baseUrl}/facebook/adaccounts/change-currency-timezone`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, adAccountId, lang: 'en_US' }) });
              const langJson = await langResp.json();
              if (langJson?.loginFailed) { skipRest = true; }
            }
          }

          if (sk === 'checkCard') {
            const accResp = await fetch(`${baseUrl}/facebook/fetch-adaccounts-graph`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, accessToken: 'BROWSER' }) });
            const accJson = await accResp.json();
            const adAccountId = accJson?.adAccounts?.[0]?.id || '';
            if (adAccountId) {
              const cr = await fetch(`${baseUrl}/facebook/billing/cards`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, adAccountId }) });
              const crj = await cr.json();
              if (crj?.loginFailed) { skipRest = true; }
            }
          }

          if (sk === 'card') {
            const accResp = await fetch(`${baseUrl}/facebook/fetch-adaccounts-graph`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, accessToken: 'BROWSER' }) });
            const accJson = await accResp.json();
            const adAccountId = accJson?.adAccounts?.[0]?.id || '';
            if (adAccountId) {
              const cardResp = await fetch(`${baseUrl}/facebook/billing/add`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, adAccountId, mode: 'manual', card: { number: '', holder: '', exp_month: '', exp_year: '', cvv: '', billing_address: '', city: '', zip: '', state: '', country_code: '' } }) });
              const cardJson = await cardResp.json();
              if (cardJson?.loginFailed) { skipRest = true; }
            }
          }

          if (sk === 'payment') {
            const accResp = await fetch(`${baseUrl}/facebook/fetch-adaccounts-graph`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, accessToken: 'BROWSER' }) });
            const accJson = await accResp.json();
            const adAccountId = accJson?.adAccounts?.[0]?.id || '';
            if (adAccountId) {
              const payResp = await fetch(`${baseUrl}/facebook/billing/manual-payment`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, adAccountId, amount: 50 }) });
              if (payResp.ok) { const payJson = await payResp.json(); if (payJson?.loginFailed) skipRest = true; }
            }
          }

          if (sk === 'publish') {
            if (!browserLaunched) {
              await fetch(`${baseUrl}/launch-browser`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) });
              browserLaunched = true;
              await new Promise(r => setTimeout(r, 3000));
            }
            const accResp = await fetch(`${baseUrl}/facebook/fetch-adaccounts-graph`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, accessToken: 'BROWSER' }) });
            const accJson = await accResp.json();
            const adAccountId = accJson?.adAccounts?.[0]?.id || '';
            if (adAccountId) {
              const pubResp = await fetch(`${baseUrl}/facebook/publish-ad`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid, adAccountId }) });
              const pubJson = await pubResp.json();
              if (pubJson?.loginFailed) { skipRest = true; }
            }
          }

          // 步骤间间隔
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          console.error(`[导入流程] 账号 ${pid} 步骤 ${sk} 失败:`, err);
          failed++;
          await updateProfileStatus(pid, { account_status: 'Error', status: 'Error' });
        }
      }

      // 关闭浏览器 + 更新最终状态
      if (browserLaunched) {
        try { await fetch(`${baseUrl}/facebook/close-browser`, { method: 'POST', headers, body: JSON.stringify({ profileId: pid }) }); } catch {}
      }
      if (!skipRest) {
        await updateProfileStatus(pid, { status: 'Idle', account_status: 'Active' });
      }
      completed++;
      console.log(`[导入流程] 账号 ${pi+1}/${total} 完成`);
    }
    console.log(`[导入流程] 全部完成: ${completed} 成功, ${failed} 失败`);
    alert(`导入流程执行完成\n已完成: ${completed} 个账号\n失败: ${failed} 个步骤`);
  };

  return (
    <div className="space-y-4">
      {/* 🚀 修复：列表不卸载，编辑弹窗覆盖层 */}
      {(isCreating || editingProfile) && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => { setIsCreating(false); setEditingProfile(null); }}>
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <ProfileCreator 
              onCancel={() => { setIsCreating(false); setEditingProfile(null); }} 
              onSave={handleSaveProfile} 
              existingGroups={existingGroups}
              initialData={editingProfile}
            />
          </div>
        </div>
      )}
      <ImportWizard 
        isOpen={isImporting} 
        onClose={() => setIsImporting(false)}
        onImport={async (newProfiles, flowSelection) => {
           const assigned = newProfiles.map(p => ({ ...p, platform }));
           // 🚀 保留原始 ID，让 bulk-save 保持导入时的固定 ID
           const persistProfiles = assigned.map(({ extId, ...rest }) => ({
             ...rest,
             extId: extId || undefined
           }));

           try {
             const baseUrl = ''; 
             const CHUNK_SIZE = 20; // 每批 20 条，避免 D1 超时
             let successCount = 0;
             let skippedCount = 0;
             const savedIdMaps: { tempId: string; d1Id: number }[] = [];
             const importedProfiles: any[] = []; // 🚀 累积已导入的配置
             // 🚀 初始化导入进度
             setImportProgress({ completed: 0, total: persistProfiles.length });

             for (let i = 0; i < persistProfiles.length; i += CHUNK_SIZE) {
               const chunk = persistProfiles.slice(i, i + CHUNK_SIZE);
               const resp = await fetch(`${baseUrl}/api/profiles/bulk-save`, {
                 method: 'POST',
                 headers: { 
                   'Content-Type': 'application/json',
                   'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
                 },
                 body: JSON.stringify({ profiles: chunk })
               });
               const json = await resp.json();
               if (json && json.success) {
                 successCount += Number(json.savedCount ?? chunk.length);
                 skippedCount += Number(json.skippedCount ?? 0);
                 // 🚀 收集 D1 分配的数字ID映射
                 if (json.savedIds?.length) {
                   savedIdMaps.push(...json.savedIds);
                 }
                 // 🚀 用后端返回的真实 ID 替换临时 ID，追加到本地列表
                 const savedChunk = chunk.map((p: any, idx: number) => {
                   const mapEntry = json.savedIds?.find((s: any) => s.tempId === p.id);
                   return {
                     ...p,
                     id: mapEntry ? String(mapEntry.d1Id) : p.id
                   };
                 });
                 importedProfiles.push(...savedChunk);
                 setProfiles(prev => [...prev, ...savedChunk]);
                 setServerTotal(prev => prev + savedChunk.length);
               } else {
                 console.error(`Chunk ${i/CHUNK_SIZE} save failed:`, json.message || json.error || 'Unauthorized');
               }
               // 🚀 每批完成后更新导入进度（包含成功和失败的处理）
               setImportProgress({ completed: Math.min(i + CHUNK_SIZE, persistProfiles.length), total: persistProfiles.length });
             }

             if (successCount > 0) {
               // 🚀 不再重新拉取全量（分页接口只返回第一页），直接用已有数据
               setProfiles(importedProfiles);
               try { localStorage.setItem('profiles', JSON.stringify(importedProfiles)); } catch {}
               setImportPreview(assigned.slice(0, 10));
               setIsImportPreviewOpen(true);
               // 🚀 导入成功后立即用本地数据填充第一页（即时显示），再后台刷新分页
               setPaginatedProfiles(importedProfiles.slice(0, pageSize));
               setServerTotal(importedProfiles.length);
               setCurrentPage(1);
               
               // 导入成功后，如果配置了流程，自动执行
               // 🚀 使用 D1 分配的数字ID，不用临时ID
               if (flowSelection && flowSelection.order.length > 0) {
                 const newIds = savedIdMaps.length > 0
                   ? savedIdMaps.map((s: any) => String(s.d1Id))
                   : importedProfiles.slice(0, successCount).map((p: any) => String(p.id));
                 setTimeout(() => {
                   executeImportedFlow(newIds, flowSelection);
                 }, 1000);
               }

               if (skippedCount > 0 || successCount < assigned.length) {
                 alert(`导入部分成功：已保存 ${successCount} 条，跳过 ${Math.max(skippedCount, assigned.length - successCount)} 条`);
               } else {
                 alert(t('profileManager.importSuccess', { count: successCount }));
               }
             } else {
               alert('导入保存失败，请检查网络或数据格式');
             }
             // 🚀 清除导入进度
             setImportProgress(null);
           } catch (err) {
             console.error('Import save error:', err);
             // 🚀 清除导入进度
             setImportProgress(null);
             alert(`导入请求失败: ${err.message}`);
           }
        }}
      />

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">{t('profileManager.title')}</h2>
        </div>
        <div className="flex gap-3 w-full sm:w-auto">
          <button
            onClick={() => refreshProfilesList(true)}
            disabled={isRefreshingProfiles}
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-slate-800 text-slate-200 rounded-lg hover:bg-slate-700 border border-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCw className={`w-4 h-4 ${isRefreshingProfiles ? 'animate-spin' : ''}`} /> {isRefreshingProfiles ? '刷新中...' : '刷新'}
          </button>
          <button
            onClick={() => setIsImporting(true)}
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-slate-800 text-slate-200 rounded-lg hover:bg-slate-700 border border-slate-700 transition-colors"
          >
            <Upload className="w-4 h-4" /> {t('profileManager.import')}
          </button>
          <button
            onClick={handleExport}
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-slate-800 text-slate-200 rounded-lg hover:bg-slate-700 border border-slate-700 transition-colors"
          >
            <Download className="w-4 h-4" /> {t('profileManager.export')}
          </button>
          {platform === Platform.TIKTOK && (
            <button 
              onClick={() => setIsTikTokRegOpen(true)} 
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-rose-600 text-white rounded-lg hover:bg-rose-500 font-bold transition-all shadow-lg shadow-rose-900/20"
            >
              <PlusCircle className="w-4 h-4" /> TikTok 批量注册
            </button>
          )}
          {platform === Platform.X && (
            <button 
              onClick={() => setIsXRegOpen(true)} 
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-sky-600 text-white rounded-lg hover:bg-sky-500 font-bold transition-all shadow-lg shadow-sky-900/20"
            >
              <PlusCircle className="w-4 h-4" /> X 批量注册
            </button>
          )}
          {platform === Platform.INSTAGRAM && (
            <button 
              onClick={() => setIsInsRegOpen(true)} 
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg hover:from-purple-500 hover:to-pink-500 font-bold transition-all shadow-lg"
            >
              <PlusCircle className="w-4 h-4" /> Ins 批量注册
            </button>
          )}
          {platform === Platform.META && (
            <button 
              onClick={() => setIsFBRegOpen(true)} 
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 font-bold transition-all shadow-lg shadow-blue-900/20"
            >
              <PlusCircle className="w-4 h-4" /> FB 批量注册
            </button>
          )}
          <ProfileBulkActions
            isBatchDropOpen={isBatchDropOpen}
            setIsBatchDropOpen={setIsBatchDropOpen}
            selectedIds={selectedIds}
            handleBatchAction={handleBatchAction}
            batchFetchTokens={batchFetchTokens}
            setIsBulkEditOpen={setIsBulkEditOpen}
            handleExport={handleExport}
            batchCheckBM={batchCheckBM}
            setIsSmartPublishOpen={setIsSmartPublishOpen}
            setIsGoogleAdPublisherOpen={setIsGoogleAdPublisherOpen}
            setIsSetFbLangOpen={setIsSetFbLangOpen}
            platform={platform}
            setIsTikTokRegOpen={setIsTikTokRegOpen}
            setIsXRegOpen={setIsXRegOpen}
            setIsInsRegOpen={setIsInsRegOpen}
            setIsFBRegOpen={setIsFBRegOpen}
          />
          <ProfileFilterBar
            searchTerm={searchTerm}
            onSearchChange={(v) => { setSearchTerm(v); setCurrentPage(1); }}
            groupFilter={groupFilter}
            onGroupFilterChange={(v) => { setGroupFilter(v); setCurrentPage(1); }}
            groups={existingGroups}
            enableTotp={enableTotp}
            onEnableTotpChange={(v) => setEnableTotp(v)}
          />
          <button onClick={() => setIsCreating(true)} className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors shadow-lg shadow-indigo-900/20">
            <Plus className="w-4 h-4" /> {t('profileManager.newProfile')}
          </button>
        </div>
      </div>
      
      {isDebugOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">调试日志</h3>
              <div className="flex gap-2">
                <button onClick={() => setDebugLogs([])} className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded">清空</button>
                <button onClick={() => setIsDebugOpen(false)} className="px-3 py-1.5 bg-indigo-600 text白 rounded">关闭</button>
              </div>
            </div>
            <div className="p-6 overflow-y-auto">
              {debugLogs.length === 0 ? (
                <div className="text-slate-400">暂无日志</div>
              ) : (
                <div className="space-y-2">
                  {debugLogs.map((l, i) => (
                    <div key={i} className="text-xs font-mono text-slate-300 break-all">{l}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {debugOpen && (
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-slate-300 text-sm">批量调试日志</span>
            <button onClick={() => setDebugLogs([])} className="px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs">清空</button>
          </div>
          <div className="max-h-48 overflow-auto text-xs font-mono text-slate-300 space-y-1">
            {debugLogs.length === 0 ? (
              <div className="text-slate-500">暂无日志</div>
            ) : (
              debugLogs.map((l, idx) => (
                <div key={idx}>{l}</div>
              ))
            )}
          </div>
        </div>
      )}

      {isShareModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">批量分享配置</h3>
              <button onClick={() => setIsShareModalOpen(false)} className="text-slate-400 hover:text-white p-2">
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-slate-400">将选中的 {selectedIds.size} 个配置分享给指定邮箱用户。</p>
              
              <div className="space-y-2">
                <label className="text-xs font-medium text-slate-400">操作类型</label>
                <div className="flex gap-6">
                  <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer group">
                    <input 
                      type="radio" 
                      name="shareMode" 
                      value="copy" 
                      checked={shareMode === 'copy'} 
                      onChange={() => setShareMode('copy')}
                      className="w-4 h-4 text-indigo-600 bg-slate-950 border-slate-700 focus:ring-indigo-500"
                    />
                    <span className="group-hover:text-white transition-colors">共享 (创建副本)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer group">
                    <input 
                      type="radio" 
                      name="shareMode" 
                      value="transfer" 
                      checked={shareMode === 'transfer'} 
                      onChange={() => setShareMode('transfer')}
                      className="w-4 h-4 text-indigo-600 bg-slate-950 border-slate-700 focus:ring-indigo-500"
                    />
                    <span className="group-hover:text-white transition-colors">转移 (移交所有权)</span>
                  </label>
                </div>
                <p className="text-[10px] text-slate-500 italic">
                  {shareMode === 'copy' ? "* 共享会为对方生成一份数据完全相同的副本，您的原数据不受影响。" : "* 转移将直接把配置的所有权移交给对方，您的列表将不再显示这些配置。"}
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-400">接收者邮箱</label>
                <input 
                  type="email" 
                  required 
                  value={shareEmail} 
                  onChange={(e) => setShareEmail(e.target.value)} 
                  placeholder="receiver@example.com"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500" 
                />
              </div>
              <div className="pt-4 flex gap-3">
                <button onClick={() => setIsShareModalOpen(false)} className="flex-1 px-4 py-2 bg-slate-800 text-slate-300 rounded-xl hover:bg-slate-700 transition-colors text-sm">取消</button>
                <button 
                  onClick={async () => {
                    if (!shareEmail) return alert('请输入接收者邮箱');
                    try {
                      const response = await fetch('/api/profiles/share', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
                        },
                        body: JSON.stringify({ 
                          profileIds: Array.from(selectedIds), 
                          targetEmail: shareEmail,
                          mode: shareMode 
                        })
                      });
                      const data = await response.json();
                      if (data.success) {
                        alert(data.message || '操作成功');
                        setIsShareModalOpen(false);
                        setShareEmail('');
                        setSelectedIds(new Set());
                        // 如果是转移，需要刷新列表
                        if (shareMode === 'transfer') {
                          window.dispatchEvent(new Event('adaccounts-refresh'));
                        }
                      } else {
                        alert(data.message || data.error || '分享失败');
                      }
                    } catch {
                      alert('请求失败');
                    }
                  }} 
                  className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 transition-colors text-sm"
                >{shareMode === 'copy' ? '确认共享' : '确认转移'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isDeleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setIsDeleteConfirmOpen(false)}></div>
          <div className="relative w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl">
            <div className="text-white text-lg font-semibold mb-2">确认删除</div>
            <div className="text-slate-300 text-sm mb-4">将删除 {selectedIds.size} 条配置，且无法恢复，是否继续？</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsDeleteConfirmOpen(false)} className="px-3 py-2 rounded bg-slate-700 text-slate-200 text-sm">取消</button>
                  <button
                    disabled={isLoading}
                    onClick={async () => {
                      const removedIds = Array.from(selectedIds);
                      setIsDeleteConfirmOpen(false);
                      setIsLoading(true);
                      
                      try {
                        const response = await fetch(`/api/profiles/batch-delete`, {
                          method: 'POST',
                          headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
                          },
                          body: JSON.stringify({ ids: removedIds })
                        });

                        const json = await response.json();
                        
                        if (json && json.success) {
                          // 🚀 服务器删除成功后再移除本地缓存，避免闪烁
                          const removedSet = new Set(removedIds);
                          setProfiles(prev => {
                            const next = prev.filter(p => !removedSet.has(p.id));
                            try { localStorage.setItem('profiles', JSON.stringify(next)); } catch {}
                            return next;
                          });
                          setPaginatedProfiles(prev => prev.filter(p => !removedSet.has(p.id)));
                          setServerTotal(prev => Math.max(0, prev - removedIds.length));
                          // 🚀 同步清理值守队列（主页值守/对话监听 + 本机 PUP 上报），避免已删配置仍被 AutoSync 扫描
                          try { watchRemoveByProfileIds(removedIds); } catch {}
                          // 🚀 从下一页补充本页数据（当前页不足 pageSize 时自动补全）
                          // 🚀 清理关联的资产缓存（广告号、页面、BM、像素），避免刷新时仍显示已删除配置的关联数据
                          const cleanCache = (key: string, profileKey: string) => {
                            try {
                              const raw = localStorage.getItem(key);
                              if (!raw) return;
                              const arr = JSON.parse(raw);
                              if (!Array.isArray(arr)) return;
                              // 🐛 这些 cache 里的「归属配置」字段命名不统一：
                              //    页面/像素/广告号是前端自己写的驼峰 profileId，而 BM 那一份
                              //    是云端 /api/businesses 返回的**蛇形 profile_id**（AssetViewer 把原始行
                              //    直接存进了 cache:businesses）。以前只按驼峰取，蛇形那批永远匹配不到，
                              //    于是删掉配置后，它名下的 BM 一直残留在 BM 列表页。
                              const snakeKey = profileKey.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
                              const filtered = arr.filter((item: any) => {
                                if (!item || typeof item !== 'object') return true;
                                const pid = String(item[profileKey] || item[snakeKey] || '');
                                return !pid || !removedSet.has(pid);
                              });
                              localStorage.setItem(key, JSON.stringify(filtered));
                            } catch {}
                          };
                          cleanCache('cache:adaccounts', 'profileId');
                          cleanCache('cache:pages', 'profileId');
                          cleanCache('cache:businesses', 'profileId');
                          cleanCache('cache:pixels', 'profileId');
                          cleanCache('cache:ads', 'profileId');
                          const remainingOnPage = paginatedProfiles.filter(p => !removedSet.has(p.id)).length;
                          if (remainingOnPage < pageSize && serverTotal > (currentPage - 1) * pageSize + pageSize) {
                            try { await fetchServerPage(currentPage, pageSize); } catch {}
                          }
                        } else {
                          console.warn(`服务端删除失败: ${json?.message || '未知错误'}`);
                        }
                      } catch (err) {
                        console.error('服务端删除请求失败:', err);
                      }
                      setSelectedIds(new Set());
                      setIsLoading(false);
                      // 🚀 后台静默刷新确保数据一致
                      try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
                    }}
                    className={`px-3 py-2 rounded text-white text-sm transition-opacity ${isLoading ? 'bg-rose-400 cursor-not-allowed' : 'bg-rose-600 hover:bg-rose-500'}`}
                  >
                    {isLoading ? '正在删除...' : '确认删除'}
                  </button>
            </div>
          </div>
        </div>
      )}

      {/* 🚀 导入进度条 */}
      {importProgress && (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden mb-3 animate-fade-in">
          <div className="px-4 py-3 flex items-center gap-4">
            <div className="flex-1">
              <div className="flex justify-between text-sm text-slate-400 mb-1">
                <span>导入中...</span>
                <span>{importProgress.completed} / {importProgress.total}</span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                <div 
                  className="bg-indigo-500 h-full rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${Math.round((importProgress.completed / importProgress.total) * 100)}%` }}
                />
              </div>
            </div>
            <div className="text-indigo-400 animate-spin">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeDasharray="31.416" strokeDashoffset="10" />
              </svg>
            </div>
          </div>
        </div>
      )}

      <ProfileTable
        paginatedProfiles={paginatedProfiles}
        selectedIds={selectedIds}
        allPageSelected={allPageSelected}
        pageSize={pageSize}
        searchTerm={searchTerm}
        serverError={serverError}
        serverPageLoading={serverPageLoading}
        sortConfig={sortConfig}
        visiblePasswords={visiblePasswords}
        visibleTwoFA={visibleTwoFA}
        enableTotp={enableTotp}
        totpMap={totpMap}
        loginMap={loginMap}
        profileAdAccounts={profileAdAccounts}
        contentCounts={contentCounts.profile}
        getPaymentStatusBadge={getPaymentStatusBadge}
        onToggleSelectAll={toggleSelectAll}
        onToggleSelect={toggleSelection}
        onToggleStatus={toggleStatus}
        onSort={requestSort}
        onViewLogs={(profile) => {
          setSelectedLogProfile(profile);
          setIsProfileLogOpen(true);
          fetchProfileLogs(profile.id);
        }}
        onGetAndSaveTokens={getAndSaveTokens}
        onCheckLoginStatus={checkLoginStatus}
        onAutofillLogin={autofillLogin}
        onEditProfile={async (id) => {
          try {
            const base = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
            const resp = await fetch(`${base}/api/profiles/${id}`, {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
            });
            const json = await resp.json();
            const profile = profiles.find(p => p.id === id) || paginatedProfiles.find(p => p.id === id);
            if (json && json.success && json.data) {
              setEditingProfile(json.data);
            } else if (profile) {
              setEditingProfile(profile);
            }
          } catch {
            const profile = profiles.find(p => p.id === id) || paginatedProfiles.find(p => p.id === id);
            if (profile) setEditingProfile(profile);
          }
        }}
        onSetEditingNotes={setEditingNotes}
        onCopyText={copyText}
        onTogglePasswordVisibility={(id) => setVisiblePasswords(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        onToggleTwoFAVisibility={(id) => setVisibleTwoFA(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        onRetry={() => fetchServerPage(currentPage, pageSize)}
      />
      <ProfilePagination
        currentPage={currentPage}
        onPageChange={setCurrentPage}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        pageCount={pageCount}
        totalItems={serverTotal}
        serverError={serverError}
        serverPageLoading={serverPageLoading}
        jumpPage={jumpPage}
        setJumpPage={setJumpPage}
        fetchServerPage={fetchServerPage}
      />

      {isImportPreviewOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[85vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold text-white">
                  {t('importWizard.previewTitle')}
                </h3>
                <p className="text-sm text-slate-400 mt-1">
                  {t('profileManager.importSuccess', { count: importPreview.length })}
                </p>
              </div>
              <button onClick={() => setIsImportPreviewOpen(false)} className="text-slate-400 hover:text-white p-2">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 overflow-auto">
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="bg-slate-950 text-slate-200 font-medium">
                    <tr>
                      <th className="px-4 py-3 whitespace-nowrap">#</th>
                      <th className="px-4 py-3 whitespace-nowrap">Name</th>
                      <th className="px-4 py-3 whitespace-nowrap">Platform</th>
                      <th className="px-4 py-3 whitespace-nowrap">Account</th>
                      <th className="px-4 py-3 whitespace-nowrap">Email</th>
                      <th className="px-4 py-3 whitespace-nowrap">IP</th>
                      <th className="px-4 py-3 whitespace-nowrap">Country</th>
                      <th className="px-4 py-3 whitespace-nowrap">Pages</th>
                      <th className="px-4 py-3 whitespace-nowrap">Ad Accounts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900">
                    {importPreview.map((p, i) => (
                      <tr key={p.id}>
                        <td className="px-4 py-2">{i + 1}</td>
                        <td className="px-4 py-2">{p.name}</td>
                        <td className="px-4 py-2">{p.platform}</td>
                        <td className="px-4 py-2">{p.account?.name || '-'}</td>
                        <td className="px-4 py-2">{p.account?.email || '-'}</td>
                        <td className="px-4 py-2">{p.ipAddress || '-'}</td>
                        <td className="px-4 py-2">{p.assets?.country || '-'}</td>
                        <td className="px-4 py-2 text-center">{p.assets?.pagesCount ?? 0}</td>
                        <td className="px-4 py-2 text-center">{p.assets?.adAccountsCount ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end">
              <button onClick={() => setIsImportPreviewOpen(false)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors">OK</button>
            </div>
          </div>
        </div>
      )}

      {isProfileLogOpen && selectedLogProfile && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex justify-end">
          <div className="bg-slate-900 border-l border-slate-800 w-full max-w-xl h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  <FileText className="w-5 h-5 text-indigo-400" />
                  执行日志
                </h3>
                <p className="text-sm text-slate-400 mt-1">配置: {selectedLogProfile.name} (ID: {selectedLogProfile.id})</p>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => fetchProfileLogs(selectedLogProfile.id)}
                  disabled={isFetchingLogs}
                  className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                  title="刷新日志"
                >
                  <RotateCw className={`w-5 h-5 ${isFetchingLogs ? 'animate-spin' : ''}`} />
                </button>
                <button onClick={() => setIsProfileLogOpen(false)} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-auto p-4 bg-slate-950 font-mono text-[11px] leading-relaxed custom-scrollbar">
              {isFetchingLogs && profileLogs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-slate-500">正在获取最新日志...</div>
              ) : profileLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3">
                  <Ban className="w-12 h-12 opacity-20" />
                  <p>暂无该配置的相关执行日志</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {profileLogs.map((line, idx) => {
                    const isError = line.includes('ERROR') || line.includes('❌') || line.includes('失败');
                    const isSuccess = line.includes('SUCCESS') || line.includes('✅') || line.includes('成功');
                    const isInfo = line.includes('INFO') || line.includes('🎬') || line.includes('🏗️');
                    
                    return (
                      <div key={idx} className={`py-1 border-b border-slate-900/50 break-all ${
                        isError ? 'text-rose-400' : isSuccess ? 'text-emerald-400' : isInfo ? 'text-sky-400' : 'text-slate-400'
                      }`}>
                        {line}
                      </div>
                    );
                  })}
                  <div id="logs-end" />
                </div>
              )}
            </div>
            
            <div className="p-4 border-t border-slate-800 bg-slate-900/50 flex justify-between items-center text-[10px] text-slate-500 italic">
              <span>* 日志仅包含最近 500 条相关操作记录</span>
              <button 
                onClick={() => setProfileLogs([])}
                className="text-slate-400 hover:text-rose-400 transition-colors"
              >
                清空当前显示
              </button>
            </div>
          </div>
        </div>
      )}

      {isDetailsOpen && selectedDetails && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">资产详情</h3>
              <button onClick={() => setIsDetailsOpen(false)} className="text-slate-400 hover:text-white p-2">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-slate-400 text-sm">ID</div>
                  <div className="text-white">{selectedDetails?.id}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">名称</div>
                  <div className="text-white">{selectedDetails.name}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">平台</div>
                  <div className="text-white">{selectedDetails.platform}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">IP</div>
                  <div className="text-white">{selectedDetails.ipAddress}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">Cookies</div>
                  <div className="text-white">{selectedDetails.cookiesCount}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">账户状态</div>
                  <div className="text-white">{selectedDetails.accountStatus}</div>
                </div>
              </div>
              <div className="border-t border-slate-800 pt-4">
                <h4 className="text-slate-200 font-semibold mb-3">资产信息</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <div className="text-slate-400 text-sm">BM ID</div>
                    <div className="text-white">{selectedDetails.assets?.bmId || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-sm">企业认证</div>
                    <div className="text-white">{selectedDetails.assets?.verificationStatus || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-sm">BM 数量</div>
                    <div className="text-white">{selectedDetails.assets?.bmCount ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-sm">页面数量</div>
                    <div className="text-white">{selectedDetails.assets?.pagesCount ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-sm">广告账户数量</div>
                    <div className="text-white">{selectedDetails.assets?.adAccountsCount ?? 0}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-sm">支付状态</div>
                    <div className="text-white">{selectedDetails.assets?.paymentStatus || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-sm">国家/货币</div>
                    <div className="text-white">{selectedDetails.assets?.country || '-'} / {selectedDetails.assets?.currency || '-'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end">
              <button onClick={() => setIsDetailsOpen(false)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">关闭</button>
            </div>
          </div>
        </div>
      )}

      {isBulkEditOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">批量编辑（{selectedIds.size}）</h3>
              <button onClick={() => setIsBulkEditOpen(false)} className="text-slate-400 hover:text-white p-2">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">分组</label>
                  <input value={bulkEdit.group} onChange={e => setBulkEdit(prev => ({...prev, group: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">所有者</label>
                  <input value={bulkEdit.owner} onChange={e => setBulkEdit(prev => ({...prev, owner: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                </div>
                <div className="md:col-span-2">
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-slate-300">标签</label>
                    <div className="flex items-center gap-3 text-sm">
                      <label className="flex items-center gap-1">
                        <input type="radio" checked={bulkEdit.tagsMode==='replace'} onChange={() => setBulkEdit(prev => ({...prev, tagsMode: 'replace'}))} /> 替换
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="radio" checked={bulkEdit.tagsMode==='append'} onChange={() => setBulkEdit(prev => ({...prev, tagsMode: 'append'}))} /> 追加
                      </label>
                    </div>
                  </div>
                  <input value={bulkEdit.tags} onChange={e => setBulkEdit(prev => ({...prev, tags: e.target.value}))} placeholder="逗号分隔，例如: facebook, q1" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">账户状态</label>
                  <select value={bulkEdit.accountStatus} onChange={e => setBulkEdit(prev => ({...prev, accountStatus: e.target.value as AccountStatus}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                    <option value="">不修改</option>
                    <option value={AccountStatus.ACTIVE}>Active</option>
                    <option value={AccountStatus.RESTRICTED}>Restricted</option>
                    <option value={AccountStatus.DISABLED}>Disabled</option>
                    <option value={AccountStatus.REVIEW}>In Review</option>
                    <option value={AccountStatus.UNKNOWN}>Unknown</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">支付状态</label>
                  <select value={bulkEdit.paymentStatus} onChange={e => setBulkEdit(prev => ({...prev, paymentStatus: e.target.value as 'Active'|'Failed'|'None'}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                    <option value="">不修改</option>
                    <option value="Active">Active</option>
                    <option value="Failed">Failed</option>
                    <option value="None">None</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">国家</label>
                  <input value={bulkEdit.country} onChange={e => setBulkEdit(prev => ({...prev, country: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">货币</label>
                  <input value={bulkEdit.currency} onChange={e => setBulkEdit(prev => ({...prev, currency: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-300 mb-2">备注</label>
                  <textarea rows={3} value={bulkEdit.notes} onChange={e => setBulkEdit(prev => ({...prev, notes: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2"></textarea>
                </div>
              </div>

              <div className="border-t border-slate-800 pt-4 space-y-3">
                <h4 className="text-slate-200 font-semibold">浏览器指纹</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">操作系统</label>
                    <select value={bulkEdit.os} onChange={e => setBulkEdit(prev => ({...prev, os: e.target.value as any}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                      <option value="">不修改</option>
                      <option value="windows">Windows</option>
                      <option value="macos">macOS</option>
                      <option value="linux">Linux</option>
                      <option value="random">Random</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">User Agent</label>
                    <input value={bulkEdit.userAgent} onChange={e => setBulkEdit(prev => ({...prev, userAgent: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">分辨率</label>
                    <input value={bulkEdit.resolution} onChange={e => setBulkEdit(prev => ({...prev, resolution: e.target.value}))} placeholder="例如 1920x1080" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">时区</label>
                    <input value={bulkEdit.timezone} onChange={e => setBulkEdit(prev => ({...prev, timezone: e.target.value}))} placeholder="例如 UTC+8, Asia/Shanghai" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">语言</label>
                    <input value={bulkEdit.language} onChange={e => setBulkEdit(prev => ({...prev, language: e.target.value}))} placeholder="例如 zh-CN,en-US" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                  <div className="grid grid-cols-3 gap-3 md:col-span-2">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Canvas</label>
                      <select value={bulkEdit.fingerprintCanvas} onChange={e => setBulkEdit(prev => ({...prev, fingerprintCanvas: e.target.value as any}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                        <option value="">不修改</option>
                        <option value="random">random</option>
                        <option value="off">off</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">WebGL</label>
                      <select value={bulkEdit.fingerprintWebgl} onChange={e => setBulkEdit(prev => ({...prev, fingerprintWebgl: e.target.value as any}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                        <option value="">不修改</option>
                        <option value="random">random</option>
                        <option value="off">off</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Audio</label>
                      <select value={bulkEdit.fingerprintAudio} onChange={e => setBulkEdit(prev => ({...prev, fingerprintAudio: e.target.value as any}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                        <option value="">不修改</option>
                        <option value="random">random</option>
                        <option value="off">off</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-800 pt-4 space-y-3">
                <h4 className="text-slate-200 font-semibold">代理设置</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-300 mb-2">代理字符串</label>
                    <input value={bulkEdit.proxyRaw} onChange={e => setBulkEdit(prev => ({...prev, proxyRaw: e.target.value}))} placeholder="http://user:pass@host:port 或 host:port:user:pass" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">启用代理</label>
                    <select value={bulkEdit.proxyEnabled} onChange={e => setBulkEdit(prev => ({...prev, proxyEnabled: e.target.value as any}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                      <option value="">不修改</option>
                      <option value="enable">启用</option>
                      <option value="disable">禁用</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">类型</label>
                    <select value={bulkEdit.proxyType} onChange={e => setBulkEdit(prev => ({...prev, proxyType: e.target.value as any}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                      <option value="">不修改</option>
                      <option value="http">http</option>
                      <option value="socks5">socks5</option>
                      <option value="residential">residential</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">主机</label>
                    <input value={bulkEdit.proxyHost} onChange={e => setBulkEdit(prev => ({...prev, proxyHost: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">端口</label>
                    <input value={bulkEdit.proxyPort} onChange={e => setBulkEdit(prev => ({...prev, proxyPort: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">用户名</label>
                    <input value={bulkEdit.proxyUsername} onChange={e => setBulkEdit(prev => ({...prev, proxyUsername: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">密码</label>
                    <input value={bulkEdit.proxyPassword} onChange={e => setBulkEdit(prev => ({...prev, proxyPassword: e.target.value}))} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-800 pt-4 space-y-3">
                <h4 className="text-slate-200 font-semibold">启动网站</h4>
                <textarea rows={3} value={bulkEdit.startupUrls} onChange={e => setBulkEdit(prev => ({...prev, startupUrls: e.target.value}))} placeholder="每行或逗号分隔一个URL，自动过滤为 http/https" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2"></textarea>
              </div>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
              <button onClick={() => setIsBulkEditOpen(false)} className="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700">取消</button>
              <button onClick={() => {
                const parseProxy = (raw: string) => {
                  const s = raw.trim();
                  let type: 'http' | 'socks5' | 'residential' = 'http';
                  let rest = s;
                const schemeMatch = s.match(/^(https?|socks5|residential):\/\//i);
                if (schemeMatch) {
                    const sch = schemeMatch[1].toLowerCase();
                    type = sch === 'socks5' ? 'socks5' : (sch === 'residential' ? 'residential' : 'http');
                    rest = s.replace(/^(https?|socks5|residential):\/\//i, '');
                }
                  let username = '';
                  let password = '';
                  let host = '';
                  let port = '';
                  let query = '';
                  if (rest.includes('?')) {
                    const [before, q] = rest.split('?');
                    rest = before;
                    query = q;
                  }
                  if (rest.includes('@')) {
                    const [cred, hostpart] = rest.split('@');
                    const [u, p] = cred.split(':');
                    username = u || '';
                    password = p || '';
                    const [h, pt] = hostpart.split(':');
                    host = h || '';
                    port = pt || '';
                  } else {
                    const parts = rest.split(':');
                    if (parts.length === 2) {
                      host = parts[0];
                      port = parts[1];
                    } else if (parts.length === 4) {
                      host = parts[0];
                      port = parts[1];
                      username = parts[2];
                      password = parts[3];
                    }
                  }
                const opts: any = {};
                if (query) {
                  const params = new URLSearchParams(query);
                  if (params.get('zone')) opts.zone = params.get('zone') || undefined;
                    if (params.get('country')) opts.country = params.get('country') || undefined;
                    if (params.get('city')) opts.city = params.get('city') || undefined;
                    if (params.get('session')) opts.session = params.get('session') || undefined;
                    const rot = params.get('rotation');
                    if (rot) opts.rotation = rot === 'sticky' ? 'sticky' : 'auto';
                    const prov = params.get('provider');
                    if (prov) opts.provider = prov || undefined;
                  }
                if (!port) {
                  if (type === 'http') port = '80';
                  else if (type === 'socks5') port = '1080';
                }
                return { type, host, port, username, password, residentialOptions: Object.keys(opts).length ? {
                  zone: opts.zone,
                  country: opts.country,
                  city: opts.city,
                  session: opts.session,
                  rotation: opts.rotation
                } : undefined, provider: opts.provider };
                };

                // 🚀 把「本次批量编辑」抽成纯函数：首屏内的配置在 setProfiles 里直接套用；
                //    翻页选中的不在 profiles 里，取回全量配置后套用同一份变换 —— 两边规则完全一致。
                const applyBulkEdit = (p: FingerprintProfile): FingerprintProfile => {
                    const next = { ...p } as FingerprintProfile;
                    if (bulkEdit.group) next.group = bulkEdit.group;
                    if (bulkEdit.owner) next.owner = bulkEdit.owner;
                    if (bulkEdit.tags) {
                      const incoming = bulkEdit.tags.split(',').map(s=>s.trim()).filter(Boolean);
                      if (bulkEdit.tagsMode === 'replace') next.tags = incoming;
                      else next.tags = Array.from(new Set([...(next.tags||[]), ...incoming]));
                    }
                    if (bulkEdit.accountStatus) next.accountStatus = bulkEdit.accountStatus;
                    const assets = { ...(next.assets||{}) } as any;
                    if (bulkEdit.paymentStatus) assets.paymentStatus = bulkEdit.paymentStatus;
                    if (bulkEdit.country) assets.country = bulkEdit.country;
                    if (bulkEdit.currency) assets.currency = bulkEdit.currency;
                    next.assets = assets;
                    if (bulkEdit.notes) next.notes = bulkEdit.notes;
                    if (bulkEdit.os) next.os = bulkEdit.os;
                    if (bulkEdit.userAgent) next.userAgent = bulkEdit.userAgent;
                    if (bulkEdit.resolution) next.resolution = bulkEdit.resolution;
                    if (bulkEdit.timezone) next.timezone = bulkEdit.timezone;
                    if (bulkEdit.language) next.language = bulkEdit.language;
                    if (bulkEdit.fbLanguage) next.fbLanguage = bulkEdit.fbLanguage;
                    const fpProt = { ...(next.fingerprintProtection||{}) } as any;
                    if (bulkEdit.fingerprintCanvas) fpProt.canvas = bulkEdit.fingerprintCanvas;
                    if (bulkEdit.fingerprintWebgl) fpProt.webgl = bulkEdit.fingerprintWebgl;
                    if (bulkEdit.fingerprintAudio) fpProt.audio = bulkEdit.fingerprintAudio;
                    next.fingerprintProtection = fpProt;
                    let proxy = { ...(next.proxy||{}) } as any;
                    // 🐛 用户到底有没有填代理信息（任一字段）—— 决定后面要不要顺手把代理启用
                    const proxyTouched = !!(bulkEdit.proxyRaw?.trim() || bulkEdit.proxyType || bulkEdit.proxyHost || bulkEdit.proxyPort || bulkEdit.proxyUsername || bulkEdit.proxyPassword);
                    if (bulkEdit.proxyRaw && bulkEdit.proxyRaw.trim().length > 0) {
                      const parsed = parseProxy(bulkEdit.proxyRaw);
                      proxy = { ...proxy, ...parsed };
                      next.proxyEnabled = true;
                      if (!next.ipAddress || next.ipAddress === 'N/A' || next.ipAddress === 'Auto-assigned') {
                        next.ipAddress = parsed.host || next.ipAddress;
                      }
                    }
                    if (bulkEdit.proxyType) proxy.type = bulkEdit.proxyType;
                    if (bulkEdit.proxyHost) proxy.host = bulkEdit.proxyHost;
                    if (bulkEdit.proxyPort) proxy.port = bulkEdit.proxyPort;
                    if (bulkEdit.proxyUsername) proxy.username = bulkEdit.proxyUsername;
                    if (bulkEdit.proxyPassword) proxy.password = bulkEdit.proxyPassword;
                    if (bulkEdit.proxyProvider) proxy.provider = bulkEdit.proxyProvider;
                    const ro = { ...(proxy.residentialOptions||{}) } as any;
                    if (bulkEdit.proxyZone) ro.zone = bulkEdit.proxyZone;
                    if (bulkEdit.proxyCountry) ro.country = bulkEdit.proxyCountry;
                    if (bulkEdit.proxyCity) ro.city = bulkEdit.proxyCity;
                    if (bulkEdit.proxySession) ro.session = bulkEdit.proxySession;
                    if (bulkEdit.proxyRotation) ro.rotation = bulkEdit.proxyRotation;
                    if (Object.keys(ro).length) proxy.residentialOptions = ro;
                    next.proxy = proxy;
                    if (bulkEdit.proxyEnabled) next.proxyEnabled = bulkEdit.proxyEnabled === 'enable';
                    // 🐛 填了代理信息、但「启用代理」保持「不修改」时：会把该配置**原有的** proxyEnabled
                    //    一起发上来；若原来是禁用状态，后端会按「显式禁用」把代理清空（proxy='{}' 且
                    //    proxy_host/port/... 全清）→ 表现就是「批量改代理保存不成功」。
                    //    用户既然填了 host+port，就是要用这个代理，这里顺手启用（和上面「代理字符串」分支一致）。
                    else if (proxyTouched && proxy.host && proxy.port) next.proxyEnabled = true;
                    if (bulkEdit.startupUrls) {
                      const urls = bulkEdit.startupUrls.split(/[,;\n\s]+/).map(s=>s.trim()).filter(s=>s.startsWith('http'));
                      next.startupUrls = urls;
                    }
                    return next;
                };
                let updatedProfilesList: FingerprintProfile[] = [];
                setProfiles(prev => {
                  const newList = prev.map(p => selectedIds.has(p.id) ? applyBulkEdit(p) : p);
                  updatedProfilesList = newList;
                  return newList;
                });

                // 异步将修改后的配置批量保存到后端数据库
                // 🐛 修复「翻页选中丢修改」：上面 setProfiles 只能改到首屏 50 条里的配置，翻页选中的
                //    不在其中 —— 以前这次修改根本不会落到它们身上（保存时也不含它们）。
                //    这里把本地没有的按 ID 取回全量配置，套用同一份 applyBulkEdit 后一起保存。
                setTimeout(async () => {
                  const idsArray = Array.from(selectedIds);
                  if (!idsArray.length) { setIsBulkEditOpen(false); return; }
                  const edited = updatedProfilesList.filter(p => selectedIds.has(p.id));
                  const editedIds = new Set(edited.map(p => String(p.id)));
                  const missing = idsArray.filter(id => !editedIds.has(String(id)));
                  let extras: FingerprintProfile[] = [];
                  if (missing.length) {
                    const fetched = await Promise.all(missing.map(id => fetchFreshProfileForLaunch(String(id), null)));
                    extras = fetched.filter(Boolean).map(p => applyBulkEdit(p as FingerprintProfile));
                  }
                  if (edited.length || extras.length) {
                    saveProfilesToDb(idsArray, [...edited, ...extras]);
                  }
                }, 100);
                
                setIsBulkEditOpen(false);
              }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">应用</button>
            </div>
          </div>
        </div>
      )}

      {isSetFbLangOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="p-6 border-b border-slate-800">
              <h3 className="text-xl font-bold text-white">批量修改FB语言（{selectedIds.size}）</h3>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">选择语言</label>
                <select value={batchFbLang} onChange={e => setBatchFbLang(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                  <option value="en_US">英文 (English)</option>
                  <option value="zh_CN">中文 (简体)</option>
                  <option value="es_ES">西班牙语 (Español)</option>
                  <option value="fr_FR">法语 (Français)</option>
                  <option value="pt_BR">葡萄牙语 (Português)</option>
                  <option value="de_DE">德语 (Deutsch)</option>
                  <option value="it_IT">意大利语 (Italiano)</option>
                  <option value="ja_JP">日语 (日本語)</option>
                  <option value="ko_KR">韩语 (한국어)</option>
                  <option value="th_TH">泰语 (ภาษาไทย)</option>
                  <option value="vi_VN">越南语 (Tiếng Việt)</option>
                  <option value="id_ID">印尼语 (Bahasa Indonesia)</option>
                  <option value="ms_MY">马来语 (Bahasa Melayu)</option>
                  <option value="ar_AR">阿拉伯语 (العربية)</option>
                  <option value="tr_TR">土耳其语 (Türkçe)</option>
                  <option value="ru_RU">俄语 (Русский)</option>
                  <option value="pl_PL">波兰语 (Polski)</option>
                  <option value="nl_NL">荷兰语 (Nederlands)</option>
                </select>
              </div>
              <p className="text-xs text-slate-400">将修改选中配置的 Facebook 界面语言，下次启动浏览器时生效。</p>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
              <button onClick={() => setIsSetFbLangOpen(false)} className="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700">取消</button>
              <button onClick={async () => {
                 const ids = Array.from(selectedIds);
                 try {
                   // 1. 本地更新
                   setProfiles(prev => prev.map(p => ids.includes(p.id) ? { ...p, fbLanguage: batchFbLang } : p));
                   // 2. 通过专用API保存到后端（加超时，失败不影响后续切换）
                   try {
                     const resp = await fetch('/api/profiles/batch-update-fb-language', {
                       method: 'POST',
                       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
                       body: JSON.stringify({ ids, fbLanguage: batchFbLang }),
                       signal: AbortSignal.timeout(8000)
                     });
                     const result = await resp.json();
                     if (!result.success) console.warn('线上保存失败:', result.message);
                   } catch (saveErr) {
                     console.warn('线上保存异常（继续执行本地切换）:', saveErr);
                   }

                   // 3. 🌐 逐个浏览器执行真正的FB语言切换（GraphQL API）
                   const langName = ({ en_US: '英文', zh_CN: '中文', es_ES: '西班牙语', fr_FR: '法语', pt_BR: '葡萄牙语', de_DE: '德语', it_IT: '意大利语', ja_JP: '日语', ko_KR: '韩语', th_TH: '泰语', vi_VN: '越南语', id_ID: '印尼语', ms_MY: '马来语', ar_AR: '阿拉伯语', tr_TR: '土耳其语', ru_RU: '俄语', pl_PL: '波兰语', nl_NL: '荷兰语' } as any)[batchFbLang] || batchFbLang;
                   let changed = 0, failed = 0, launched = 0;
                   const baseUrl = 'http://localhost:9999/api';
                   for (const pid of ids) {
                     try {
                       // 3a. 先试切换语言
                       let langResp = await fetch(`${baseUrl}/facebook/change-language`, {
                         method: 'POST',
                         headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                         body: JSON.stringify({ profileId: pid, lang: batchFbLang }),
                         signal: AbortSignal.timeout(20000)
                       });
                       let langResult = await langResp.json();

                       // 3b. 浏览器未运行 → 启动再试
                       if (!langResult.success && langResult.message?.includes('无运行中的浏览器')) {
                         const profile = profiles.find(p => p.id === pid);
                         if (profile) {
                           const payload = await buildFreshLaunchPayload(profile, {});
                           const launchResp = await fetch(`${baseUrl}/launch-browser`, {
                             method: 'POST',
                             headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                             body: JSON.stringify(payload),
                             signal: AbortSignal.timeout(120000)
                           }).catch(() => null);
                           if (launchResp && launchResp.ok) launched++;
                           // 等浏览器就绪
                           await new Promise(r => setTimeout(r, 5000));
                           // 重试切换语言
                           langResp = await fetch(`${baseUrl}/facebook/change-language`, {
                             method: 'POST',
                             headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                             body: JSON.stringify({ profileId: pid, lang: batchFbLang }),
                             signal: AbortSignal.timeout(30000)
                           });
                           langResult = await langResp.json();
                         }
                       }

                       if (langResult.success) changed++;
                       else failed++;
                     } catch { failed++; }
                   }
                   const summary = `已保存 ${ids.length} 个配置的 FB 语言为 ${langName}` +
                     `，切换成功 ${changed} 个` +
                     (launched > 0 ? `（启动 ${launched} 个浏览器）` : '') +
                     (failed > 0 ? `，失败 ${failed} 个` : '');
                   alert(summary);
                 } catch (e: any) {
                   alert('保存失败: ' + (e.message || '未知错误'));
                 }
                 setIsSetFbLangOpen(false);
               }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">确认修改</button>
            </div>
          </div>
        </div>
      )}

      {isBatchBillingOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto custom-scrollbar shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center p-6 border-b border-slate-800">
              <h3 className="text-xl font-bold text-white">批量修改账单国家/时区（{selectedIds.size}）</h3>
              <button onClick={() => setIsBatchBillingOpen(false)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">国家</label>
                  <select value={batchBillCountry} onChange={e => setBatchBillCountry(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                    {['US','GB','CA','AU','DE','FR','IT','ES','NL','JP','SG','HK','KR','TW','IN','BR','MX','CH','NZ','ZA','AE','SA','IL','TR','RU','PL','TH','VN','ID','MY','PH','IE','PT','GR','CZ','HU','RO','BG','UA','SE','NO','DK','FI'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">时区</label>
                  <select value={batchBillTimezone} onChange={e => setBatchBillTimezone(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                    {[
                      { l: '(GMT-11:00) Midway Island', v: '1' },
                      { l: '(GMT-11:00) Pago Pago', v: '1' },
                      { l: '(GMT-10:00) Hawaii', v: '2' },
                      { l: '(GMT-10:00) Honolulu', v: '2' },
                      { l: '(GMT-09:00) Alaska', v: '3' },
                      { l: '(GMT-09:00) Anchorage', v: '3' },
                      { l: '(GMT-08:00) Los Angeles', v: '4' },
                      { l: '(GMT-08:00) San Francisco', v: '4' },
                      { l: '(GMT-08:00) Seattle', v: '4' },
                      { l: '(GMT-08:00) Vancouver', v: '4' },
                      { l: '(GMT-08:00) Tijuana', v: '4' },
                      { l: '(GMT-07:00) Denver', v: '5' },
                      { l: '(GMT-07:00) Salt Lake City', v: '5' },
                      { l: '(GMT-07:00) Phoenix', v: '5' },
                      { l: '(GMT-07:00) Calgary', v: '5' },
                      { l: '(GMT-07:00) Edmonton', v: '5' },
                      { l: '(GMT-06:00) Chicago', v: '6' },
                      { l: '(GMT-06:00) Dallas', v: '6' },
                      { l: '(GMT-06:00) Houston', v: '6' },
                      { l: '(GMT-06:00) Mexico City', v: '6' },
                      { l: '(GMT-06:00) Winnipeg', v: '6' },
                      { l: '(GMT-05:00) New York', v: '7' },
                      { l: '(GMT-05:00) Miami', v: '7' },
                      { l: '(GMT-05:00) Toronto', v: '7' },
                      { l: '(GMT-05:00) Washington DC', v: '7' },
                      { l: '(GMT-05:00) Atlanta', v: '7' },
                      { l: '(GMT-05:00) Havana', v: '7' },
                      { l: '(GMT-04:00) Halifax', v: '8' },
                      { l: '(GMT-04:00) Santiago', v: '8' },
                      { l: '(GMT-04:00) Caracas', v: '8' },
                      { l: '(GMT-03:00) Brasilia', v: '9' },
                      { l: '(GMT-03:00) Buenos Aires', v: '9' },
                      { l: '(GMT-03:00) Sao Paulo', v: '9' },
                      { l: '(GMT-02:00) Mid-Atlantic', v: '10' },
                      { l: '(GMT-02:00) Fernando de Noronha', v: '10' },
                      { l: '(GMT-01:00) Azores', v: '11' },
                      { l: '(GMT-01:00) Cape Verde', v: '11' },
                      { l: '(GMT+00:00) London', v: '12' },
                      { l: '(GMT+00:00) Dublin', v: '12' },
                      { l: '(GMT+00:00) Lisbon', v: '12' },
                      { l: '(GMT+00:00) Reykjavik', v: '12' },
                      { l: '(GMT+00:00) Accra', v: '12' },
                      { l: '(GMT+01:00) Berlin', v: '13' },
                      { l: '(GMT+01:00) Paris', v: '13' },
                      { l: '(GMT+01:00) Rome', v: '13' },
                      { l: '(GMT+01:00) Madrid', v: '13' },
                      { l: '(GMT+01:00) Amsterdam', v: '13' },
                      { l: '(GMT+01:00) Brussels', v: '13' },
                      { l: '(GMT+01:00) Vienna', v: '13' },
                      { l: '(GMT+01:00) Warsaw', v: '13' },
                      { l: '(GMT+01:00) Prague', v: '13' },
                      { l: '(GMT+01:00) Stockholm', v: '13' },
                      { l: '(GMT+01:00) Oslo', v: '13' },
                      { l: '(GMT+01:00) Copenhagen', v: '13' },
                      { l: '(GMT+01:00) Zurich', v: '13' },
                      { l: '(GMT+01:00) Belgrade', v: '13' },
                      { l: '(GMT+02:00) Helsinki', v: '14' },
                      { l: '(GMT+02:00) Kyiv', v: '14' },
                      { l: '(GMT+02:00) Athens', v: '14' },
                      { l: '(GMT+02:00) Sofia', v: '14' },
                      { l: '(GMT+02:00) Bucharest', v: '14' },
                      { l: '(GMT+02:00) Riga', v: '14' },
                      { l: '(GMT+02:00) Vilnius', v: '14' },
                      { l: '(GMT+02:00) Tallinn', v: '14' },
                      { l: '(GMT+02:00) Cairo', v: '14' },
                      { l: '(GMT+02:00) Jerusalem', v: '14' },
                      { l: '(GMT+02:00) Beirut', v: '14' },
                      { l: '(GMT+03:00) Moscow', v: '15' },
                      { l: '(GMT+03:00) Istanbul', v: '15' },
                      { l: '(GMT+03:00) St. Petersburg', v: '15' },
                      { l: '(GMT+03:00) Baghdad', v: '15' },
                      { l: '(GMT+03:00) Kuwait', v: '15' },
                      { l: '(GMT+03:00) Riyadh', v: '15' },
                      { l: '(GMT+03:00) Nairobi', v: '15' },
                      { l: '(GMT+03:00) Addis Ababa', v: '15' },
                      { l: '(GMT+04:00) Dubai', v: '16' },
                      { l: '(GMT+04:00) Abu Dhabi', v: '16' },
                      { l: '(GMT+04:00) Muscat', v: '16' },
                      { l: '(GMT+04:00) Baku', v: '16' },
                      { l: '(GMT+04:00) Tbilisi', v: '16' },
                      { l: '(GMT+04:00) Samara', v: '16' },
                      { l: '(GMT+05:00) Karachi', v: '17' },
                      { l: '(GMT+05:00) Islamabad', v: '17' },
                      { l: '(GMT+05:00) Tashkent', v: '17' },
                      { l: '(GMT+05:00) Yekaterinburg', v: '17' },
                      { l: '(GMT+05:30) Mumbai', v: '18' },
                      { l: '(GMT+05:30) New Delhi', v: '18' },
                      { l: '(GMT+05:30) Kolkata', v: '18' },
                      { l: '(GMT+05:30) Chennai', v: '18' },
                      { l: '(GMT+05:30) Bangalore', v: '18' },
                      { l: '(GMT+05:30) Colombo', v: '18' },
                      { l: '(GMT+06:00) Dhaka', v: '19' },
                      { l: '(GMT+06:00) Almaty', v: '19' },
                      { l: '(GMT+06:00) Novosibirsk', v: '19' },
                      { l: '(GMT+06:00) Astana', v: '19' },
                      { l: '(GMT+07:00) Bangkok', v: '20' },
                      { l: '(GMT+07:00) Jakarta', v: '20' },
                      { l: '(GMT+07:00) Hanoi', v: '20' },
                      { l: '(GMT+07:00) Ho Chi Minh', v: '20' },
                      { l: '(GMT+07:00) Phnom Penh', v: '20' },
                      { l: '(GMT+07:00) Vientiane', v: '20' },
                      { l: '(GMT+08:00) Beijing', v: '21' },
                      { l: '(GMT+08:00) Shanghai', v: '21' },
                      { l: '(GMT+08:00) Hong Kong', v: '21' },
                      { l: '(GMT+08:00) Singapore', v: '21' },
                      { l: '(GMT+08:00) Kuala Lumpur', v: '21' },
                      { l: '(GMT+08:00) Taipei', v: '21' },
                      { l: '(GMT+08:00) Perth', v: '21' },
                      { l: '(GMT+08:00) Manila', v: '21' },
                      { l: '(GMT+08:00) Ulaanbaatar', v: '21' },
                      { l: '(GMT+09:00) Tokyo', v: '22' },
                      { l: '(GMT+09:00) Seoul', v: '22' },
                      { l: '(GMT+09:00) Osaka', v: '22' },
                      { l: '(GMT+09:00) Yakutsk', v: '22' },
                      { l: '(GMT+09:00) Pyongyang', v: '22' },
                      { l: '(GMT+10:00) Sydney', v: '23' },
                      { l: '(GMT+10:00) Melbourne', v: '23' },
                      { l: '(GMT+10:00) Brisbane', v: '23' },
                      { l: '(GMT+10:00) Vladivostok', v: '23' },
                      { l: '(GMT+10:00) Port Moresby', v: '23' },
                      { l: '(GMT+10:00) Guam', v: '23' },
                      { l: '(GMT+11:00) Solomon Is.', v: '24' },
                      { l: '(GMT+11:00) Noumea', v: '24' },
                      { l: '(GMT+11:00) Vanuatu', v: '24' },
                      { l: '(GMT+12:00) Auckland', v: '25' },
                      { l: '(GMT+12:00) Wellington', v: '25' },
                      { l: '(GMT+12:00) Fiji', v: '25' },
                      { l: '(GMT+12:00) Kamchatka', v: '25' },
                      { l: '(GMT+12:00) Anadyr', v: '25' }
                    ].map(t => <option key={t.l} value={t.v}>{t.l}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">货币</label>
                  <select value={batchBillCurrency} onChange={e => setBatchBillCurrency(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                    {['USD','EUR','GBP','AUD','CAD','JPY','CNY','HKD','SGD','KRW','TWD','INR','BRL','MXN','CHF','NZD','ZAR','AED','SAR','ILS','TRY','RUB','PLN','THB','VND','IDR','MYR','PHP','NGN','ARS','COP'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">FB语言</label>
                  <select value={batchBillLang} onChange={e => setBatchBillLang(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                    <option value="en_US">英文</option>
                    <option value="zh_CN">中文</option>
                    <option value="es_ES">西班牙语</option>
                    <option value="fr_FR">法语</option>
                    <option value="pt_BR">葡萄牙语</option>
                    <option value="de_DE">德语</option>
                    <option value="it_IT">意大利语</option>
                    <option value="ja_JP">日语</option>
                    <option value="ko_KR">韩语</option>
                    <option value="ar_AR">阿拉伯语</option>
                    <option value="tr_TR">土耳其语</option>
                    <option value="ru_RU">俄语</option>
                    <option value="th_TH">泰语</option>
                    <option value="vi_VN">越南语</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">街道地址</label>
                  <div className="flex gap-1">
                    <input value={batchBillAddress} onChange={e => setBatchBillAddress(e.target.value)} placeholder="123 Main St" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm flex-1" disabled={batchBillAddressRandom} />
                    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={batchBillAddressRandom} onChange={e => { setBatchBillAddressRandom(e.target.checked); if (e.target.checked) setBatchBillAddress(''); }} className="w-3 h-3 rounded border-slate-600" />
                      随机
                    </label>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">城市</label>
                  <div className="flex gap-1">
                    <input value={batchBillCity} onChange={e => setBatchBillCity(e.target.value)} placeholder="New York" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm flex-1" disabled={batchBillCityRandom} />
                    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={batchBillCityRandom} onChange={e => { setBatchBillCityRandom(e.target.checked); if (e.target.checked) setBatchBillCity(''); }} className="w-3 h-3 rounded border-slate-600" />
                      随机
                    </label>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">邮编</label>
                  <div className="flex gap-1">
                    <input value={batchBillZip} onChange={e => setBatchBillZip(e.target.value)} placeholder="10001" className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm flex-1" disabled={batchBillZipRandom} />
                    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={batchBillZipRandom} onChange={e => { setBatchBillZipRandom(e.target.checked); if (e.target.checked) setBatchBillZip(''); }} className="w-3 h-3 rounded border-slate-600" />
                      随机
                    </label>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">州/省</label>
                  <div className="flex gap-1">
                    <select value={batchBillState} onChange={e => setBatchBillState(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm flex-1" disabled={batchBillStateRandom}>
                      <option value="">—</option>
                      {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={batchBillStateRandom} onChange={e => { setBatchBillStateRandom(e.target.checked); if (e.target.checked) setBatchBillState(''); }} className="w-3 h-3 rounded border-slate-600" />
                      随机
                    </label>
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-400">将修改选中配置的广告账户国家、时区。启用"随机"将自动生成随机地址/城市/邮编/州。</p>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
              <button onClick={() => setIsBatchBillingOpen(false)} className="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700">取消</button>
              <button onClick={async () => {
                const ids = Array.from(selectedIds);
                const baseUrl = 'http://localhost:9999/api';
                const streets = ['Main St','Oak Ave','Elm St','Park Rd','Broadway','Lake Dr','Hill St','Cedar Ln','Maple Ave','River Rd','Pine St','Washington Blvd','Sunset Blvd','Madison Ave','Lincoln St'];
                const cities = ['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio','San Diego','Dallas','Austin','Miami','Denver','Seattle','Portland','Atlanta','Boston','Nashville','Detroit'];
                const zipCodes = ['10001','90001','60601','77001','85001','19101','78201','92101','75201','73301','33101','80201','98101','97201','30301','02101','37201','48201'];
                const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY', 'DC'];
                const randomStreet = () => `${Math.floor(Math.random()*9000+1000)} ${streets[Math.floor(Math.random()*streets.length)]}`;
                const randomCity = () => cities[Math.floor(Math.random()*cities.length)];
                const randomZip = () => zipCodes[Math.floor(Math.random()*zipCodes.length)];
                const randomState = () => US_STATES[Math.floor(Math.random()*US_STATES.length)];
                const addr = batchBillAddressRandom ? randomStreet() : batchBillAddress;
                const city = batchBillCityRandom ? randomCity() : batchBillCity;
                const zip = batchBillZipRandom ? randomZip() : batchBillZip;
                const st = batchBillStateRandom ? randomState() : batchBillState;
                let done = 0, localOnly = 0, failed = 0;
                let localOnlyReason = '';
                const cachedAccounts: any[] = JSON.parse(localStorage.getItem('cache:adaccounts') || '[]');
                for (const pid of ids) {
                  // 🐛 获取该 profile 下所有广告号
                  const profileAccounts = cachedAccounts.filter((a: any) => String(a.profileId || a.profile_id || '') === pid);
                  const actIds = [...new Set(profileAccounts.map((a: any) => String(a.adAccountId || a.account_id || a.id || '').replace('act_','')))];
                  if (actIds.length === 0) { failed++; continue; }
                  for (const actId of actIds) {
                    try {
                      const r = await fetch(`${baseUrl}/facebook/adaccounts/change-currency-timezone`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                        body: JSON.stringify({ profileId: pid, adAccountId: `act_${actId}`, country: batchBillCountry, timezone_id: batchBillTimezone, currency: batchBillCurrency, lang: batchBillLang, address: addr, city, zip, state: st })
                      });
                      const j = await r.json().catch(() => ({} as any));
                      // 🐛 修复：以前只看 j.success（服务端恒为 true），"浏览器起不来→只存本地"被算成成功。
                      //    现在按服务端返回的三类计数统计：已下发 / 仅存本地未下发 / 失败。
                      const applied = Number(j?.apiSuccessCount ?? (j?.success ? 1 : 0));
                      const onlyLocal = Number(j?.localOnlyCount ?? 0);
                      const bad = Number(j?.failedCount ?? 0) || ((applied === 0 && onlyLocal === 0) ? 1 : 0);
                      done += applied;
                      localOnly += onlyLocal;
                      failed += bad;
                      if (onlyLocal > 0 && !localOnlyReason && j?.message) localOnlyReason = String(j.message);
                    } catch { failed++; }
                  }
                }
                alert(
                  `批量修改账单完成：\n` +
                  `✅ 已下发到 Meta: ${done}\n` +
                  (localOnly ? `⚠️ 仅保存本地（未下发到 Meta）: ${localOnly}\n` : '') +
                  (failed ? `❌ 失败: ${failed}\n` : '') +
                  `地址: ${addr}, ${city}, ${st}, ${zip}` +
                  (localOnly ? `\n\n未下发原因: ${localOnlyReason || '浏览器/Token 不可用'}\n（请确认这些配置能正常启动浏览器后再重试）` : '')
                );
                setIsBatchBillingOpen(false);
              }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">确认修改</button>
            </div>
          </div>
        </div>
      )}

      {isApplyProxyOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">应用已保存代理（{selectedIds.size}）</h3>
              <button onClick={() => setIsApplyProxyOpen(false)} className="text-slate-400 hover:text-white p-2">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 space-y-3 overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">选择代理</label>
                <select value={selectedProxyId} onChange={e=>setSelectedProxyId(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2">
                  <option value="">请选择</option>
                  {savedProxies.map(p => (
                    <option key={p.id} value={p.id}>{p.type || 'http'}://{p.host}:{p.port}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
              <button onClick={() => setIsApplyProxyOpen(false)} className="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700">取消</button>
              <button onClick={async () => {
                if (!selectedProxyId) return;
                try {
                  const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
                  const base = serverUrl.replace(/\/$/, '');
                  const authToken = localStorage.getItem('auth_token');
                  await fetch(`${base}/api/proxies/assign-to-profiles`, { 
                    method: 'POST', 
                    headers: { 
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${authToken}`
                    }, 
                    body: JSON.stringify({ proxyId: selectedProxyId, profileIds: Array.from(selectedIds) }) 
                  });
                  const resp = await fetch(`${base}/api/profiles`, {
                    headers: { 'Authorization': `Bearer ${authToken}` }
                  });
                  const json = await resp.json();
                  const list = Array.isArray(json?.data) ? json.data : [];
                  const map: Map<string, Partial<FingerprintProfile>> = new Map<string, Partial<FingerprintProfile>>(list.map((p:any)=>[String(p.id), p]));
                  setProfiles(prev => prev.map(p => {
                    if (!selectedIds.has(p.id)) return p;
                    const fresh = map.get(p.id);
                    return fresh ? { ...p, proxy: fresh.proxy, proxyEnabled: fresh.proxyEnabled, ipAddress: fresh.ipAddress || p.ipAddress } : p;
                  }));
                  setIsApplyProxyOpen(false);
                } catch {}
              }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">应用</button>
            </div>
          </div>
        </div>
      )}

      {isPageCreatorOpen && (
        <PageCreator
          profileIds={Array.from(selectedIds)}
          onCancel={() => setIsPageCreatorOpen(false)}
          onConfirm={handleCreatePageConfirm}
        />
      )}

      {isAdPublisherOpen && (
        <FacebookAdPublisher
          profileIds={Array.from(selectedIds)}
          onCancel={() => setIsAdPublisherOpen(false)}
          onConfirm={handlePublishAdsConfirm}
        />
      )}
      {isGoogleAdPublisherOpen && (
        <GoogleAdsPublisher
          onClose={() => setIsGoogleAdPublisherOpen(false)}
          onConfirm={handlePublishGoogleAdsConfirm}
          profileIds={Array.from(selectedIds)}
        />
      )}

      {isSmartPublishOpen && (
        <SmartPublishDialog
          open={isSmartPublishOpen}
          onClose={() => setIsSmartPublishOpen(false)}
          profileIds={Array.from(selectedIds)}
          assetType="profiles"
        />
      )}

      {isTikTokRegOpen && (
        <div className="fixed bottom-4 right-4 z-[60] w-[450px] shadow-2xl animate-in slide-in-from-right-10 duration-300">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl flex flex-col max-h-[80vh] overflow-hidden ring-1 ring-white/10">
            <div className="p-4 bg-slate-800/50 border-b border-slate-700 flex justify-between items-center cursor-move">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">TikTok 注册流水线</h3>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => setIsTikTokRegOpen(false)} 
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-md transition-colors"
                  title="后台运行"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar">
              <TikTokRegistration 
                selectedProfileIds={selectedIds.size > 0 ? Array.from(selectedIds) : undefined}
                onComplete={() => {
                  // 注册任务启动后刷新列表显示 pending 状态的配置
                  try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
                }} 
              />
              <div className="mt-4 p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
                <p className="text-[10px] text-indigo-300 leading-relaxed">
                  💡 任务已在后台启动。您可以关闭此窗口或切换页面，注册流程将继续运行。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {isXRegOpen && (
        <div className="fixed bottom-4 right-4 z-[60] w-[450px] shadow-2xl animate-in slide-in-from-right-10 duration-300">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl flex flex-col max-h-[80vh] overflow-hidden ring-1 ring-white/10">
            <div className="p-4 bg-slate-800/50 border-b border-slate-700 flex justify-between items-center cursor-move">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-sky-500 animate-pulse"></div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">X 注册流水线</h3>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => setIsXRegOpen(false)} 
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-md transition-colors"
                  title="后台运行"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar">
              <XRegistration 
                selectedProfileIds={selectedIds.size > 0 ? Array.from(selectedIds) : undefined}
                onComplete={() => {
                  try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
                }} 
              />
              <div className="mt-4 p-3 bg-sky-500/10 border border-sky-500/20 rounded-xl">
                <p className="text-[10px] text-sky-300 leading-relaxed">
                  💡 任务已在后台启动。您可以关闭此窗口或切换页面，注册流程将继续运行。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      {isInsRegOpen && (
        <div className="fixed bottom-4 right-4 z-[60] w-[450px] shadow-2xl animate-in slide-in-from-right-10 duration-300">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl flex flex-col max-h-[80vh] overflow-hidden ring-1 ring-white/10">
            <div className="p-4 bg-slate-800/50 border-b border-slate-700 flex justify-between items-center cursor-move">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-pink-500 animate-pulse"></div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Instagram 注册流水线</h3>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => setIsInsRegOpen(false)} 
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-md transition-colors"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar">
              <InsRegistration 
                selectedProfileIds={selectedIds.size > 0 ? Array.from(selectedIds) : undefined}
                onComplete={() => {
                  try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
                }} 
              />
            </div>
          </div>
        </div>
      )}
      {isCreateBMOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">创建BM</h3>
              <button onClick={() => { setIsCreateBMOpen(false); setCreateBMError(''); }} className="text-slate-400 hover:text-white p-2">关闭</button>
            </div>
            <div className="p-6 space-y-3">
              <div className="text-slate-300 text-sm">目标数量：<span className="font-mono text-slate-200">{selectedIds.size}</span></div>
              
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

              {/* 名字 / 姓氏（可选；各自可勾选「用配置 ID」）— 与「BM 管理」创建BM表单一致 */}
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
                    className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded disabled:opacity-40" />
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
                    className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded disabled:opacity-40" />
                </div>
              </div>

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
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 text-sm mb-1">BM 创建数量</label>
                  <input type="number" min={1} max={10} value={createBMCount} onChange={e=>setCreateBMCount(Math.max(1, Math.min(10, Number(e.target.value)||1)))} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded" />
                </div>
                <div className="space-y-2 pt-6">
                  <label className="inline-flex items-center gap-2 text-slate-300 text-sm"><input type="checkbox" checked={bmCreateAdAccount} onChange={e=>setBmCreateAdAccount(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />创建广告号</label>
                  <label className="inline-flex items-center gap-2 text-slate-300 text-sm"><input type="checkbox" checked={bmCreatePage} onChange={e=>setBmCreatePage(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />创建主页</label>
                </div>
              </div>

              {bmCreateAdAccount && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-300 text-sm mb-1">广告号数量 <span className="text-slate-500 text-xs">(每个 BM)</span></label>
                      <input type="number" min={1} max={20} value={bmAdAccountCount} onChange={e=>setBmAdAccountCount(Math.max(1, Math.min(20, Number(e.target.value)||1)))} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded" />
                    </div>
                    <div className="pt-7 text-xs text-slate-500">
                      共 {selectedIds.size} 个配置 × {createBMCount} 个 BM × {bmAdAccountCount} 个广告号
                    </div>
                  </div>
                  {/* 与「BM 操作弹窗」完全同一份字段组：命名方式 + 时区/货币 + 账单信息 */}
                  <AdAccountFields value={adForm} onChange={patchAd} manualPlaceholder="留空则沿用 BM 名称" />
                </>
              )}

              {bmCreatePage && (
                <input value={bmDefaultPageName} onChange={e=>setBmDefaultPageName(e.target.value)} placeholder="默认主页名称(可选)" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded" />
              )}

              {/* 📧 建完自动生成邀请链接（联动：可自动上架商城） */}
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
                        <p className="text-xs text-slate-500 mt-1">每个 BM 一个商品，链接作为可发货条目追加；同一 BM 重复上架只追加新链接，不产生重复商品。上架失败不影响链接生成。</p>
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
                  <select value={bmSelectedProxyId} onChange={e=>{ setBmSelectedProxyId(e.target.value); if(e.target.value) setBmProxyManualInput(''); }} className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-2 rounded text-sm col-span-2">
                    <option value="">-- 使用配置自带代理 --</option>
                    {bmProxyList.filter(p=>p).map(px => (
                      <option key={px.id} value={px.id}>
                        {px.name || px.remark || px.id?.substring(0,8)} ({px.host}:{px.port})
                      </option>
                    ))}
                  </select>
                  <select value={bmProxyType} onChange={e=>setBmProxyType(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-2 rounded text-sm">
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </div>
                <input value={bmProxyManualInput} onChange={e=>{ setBmProxyManualInput(e.target.value); if(e.target.value) setBmSelectedProxyId(''); }} placeholder="或手动输入代理: host:port 或 user:pass@host:port" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm" />
              </div>

              {createBMError && <div className="text-rose-400 text-sm">{createBMError}</div>}
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
              <button onClick={() => { setIsCreateBMOpen(false); setCreateBMError(''); }} className="px-4 py-2 bg-slate-800 text-slate-200 rounded">取消</button>
              <button onClick={async ()=>{
                // ⚠️ 以前只在按钮上方显示一行小红字（很容易看不见）→ 用户以为点「创建」没反应
                if (!createBMName) { setCreateBMError('请输入 BM 名称（或勾选「随机生成」）'); showToast('请输入 BM 名称', 'warning'); return; }
                setCreatingBM(true); setCreateBMError('');
                try {
                  const ids = Array.from(selectedIds);
                  
                  // 🚀 解析代理覆盖
                  let proxyOverride: any = undefined;
                  if (bmSelectedProxyId) {
                    proxyOverride = bmProxyList.find(px => px.id === bmSelectedProxyId);
                  } else if (bmProxyManualInput.trim()) {
                    const proxyInput = bmProxyManualInput.trim();
                    const colonCount = (proxyInput.match(/:/g) || []).length;
                    if (colonCount === 1) {
                      const [h, p] = proxyInput.split(':');
                      proxyOverride = { host: h, port: parseInt(p), type: bmProxyType };
                    } else if (colonCount === 3 && proxyInput.includes('@')) {
                      const [up, hp] = proxyInput.split('@');
                      const [u, pass] = up.split(':');
                      const [h, p] = hp.split(':');
                      proxyOverride = { host: h, port: parseInt(p), username: u, password: pass, type: bmProxyType };
                    } else {
                      proxyOverride = { host: proxyInput, port: 80, type: bmProxyType };
                    }
                  }

                  const payload = (pid: string, bmName: string) => ({
                    profileId: pid, name: bmName,
                    country: createBMCountry || undefined,
                    firstName: (useProfileIdFirstName ? String(pid) : bmFirstName) || undefined,
                    lastName: (useProfileIdLastName ? String(pid) : bmLastName) || undefined,
                    email: createBMEmail || undefined,
                    bmCount: createBMCount,
                    createAdAccount: bmCreateAdAccount,
                    createPage: bmCreatePage,
                    defaultPageName: bmDefaultPageName || undefined,
                    proxyOverride,
                    // 🆕 广告号：数量 + 命名方式 + 时区/货币 + 账单信息（与「BM 操作弹窗」共用同一份字段组）
                    adAccountCount: bmAdAccountCount,
                    ...adNamePayload(adForm),
                    adBilling: adBillingPayload(adForm),
                    timezoneId: Number(adForm.timezoneId) || 1,
                    currency: adForm.currency,
                    // 📧 建完自动生成邀请链接（每个 BM N 个）；0/未勾选 = 不生成
                    inviteCount: bmInviteEnabled ? bmInviteCount : 0,
                    // 🛒 邀请链接生成后自动上架商城（勾选时透传）
                    shopPublish: bmInviteEnabled ? bmShopPublish : false,
                    shopPrice: bmShopPrice,
                    shopCurrency: 'USDT',
                  });
                  const genRandomBMName = () => {
                    const rn = RANDOM_BM_NAMES[Math.floor(Math.random() * RANDOM_BM_NAMES.length)];
                    const suffix = Math.floor(1000 + Math.random() * 9000);
                    return `${rn} ${suffix}`;
                  };
                  // ⚠️ 以前这里把失败全吞了（catch 成 {success:false}）且从不检查 bmResp.success，
                  // 🧵 走服务端队列：以前是前端 for/await 串行跑（每个 ~55s），刷新/切页就全丢、
                  //    也没有真正的进度。现在只提交任务，执行/进度/取消都在后端。
                  //    「建BM →（可选）建广告号 →（可选）建主页」由后端 create_bm_bundle 按顺序完成。
                  const items: Array<{ key: string; label?: string; payload: any; type?: string }> = [];
                  for (const pid of ids) {
                    for (let i = 0; i < createBMCount; i++) {
                      const bmName = isRandomBMName ? genRandomBMName() : createBMName;
                      // key 必须唯一：同一配置允许建多个 BM
                      items.push({ key: `${pid}#${i + 1}`, label: `${pid} / ${bmName}`, payload: payload(String(pid), bmName) });
                    }
                  }
                  // 🔗 联动：勾选「建完自动获取信息」→ 把获取信息作为同 job 的追加项（项级 type=get_info），
                  //    与创建项同 job 串行执行；服务端同 job 的 hasNextForProfile 查得到它，
                  //    创建项完成时浏览器保留 → 获取信息直接复用，不再冷启动。
                  // 🩺 payload 必须带 withAccountQuality: true（服务端默认不探测 BM 状态）。
                  if (bmAutoFetchInfo) {
                    const infoPids = Array.from(new Set(ids.map(String)));
                    for (const pid of infoPids) {
                      items.push({
                        key: `${pid}#pmauto`, label: `${pid}（创建后自动获取信息）`, type: 'get_info',
                        payload: { profileId: pid, accessToken: 'BROWSER', withAccountQuality: true },
                      });
                    }
                  }
                  const job = await submitBatchJob('create_bm_bundle', `创建BM（${items.filter(it => !it.key.endsWith('#pmauto')).length} 个）`, items);
                  setIsCreateBMOpen(false);
                  if (job) {
                    // 🔗 建完自动获取信息：队列把数据抓回来了（服务端已同步云端），但前端必须再「落位」
                    //    —— 从后端取回抓取结果写 localStorage 缓存 + 刷新界面，否则本地列表
                    //    （BM/广告号数量、BM 状态）要等下次手动跑获取信息才更新。
                    const autoInfoPids = bmAutoFetchInfo ? Array.from(new Set(ids.map(String))) : [];
                    const unsub = subscribe(() => {
                      const j = snapshot().jobs.find((x) => x.id === job.id);
                      if (!j || (j.status !== 'done' && j.status !== 'failed' && j.status !== 'cancelled')) return;
                      unsub();
                      showToast(`创建BM结束：成功 ${j.ok}/${j.total}${j.fail ? `，失败 ${j.fail}（明细见执行队列）` : ''}`, j.fail ? 'warning' : 'success');
                      if (autoInfoPids.length) {
                        void batchApplyAssetsFromCache(autoInfoPids)
                          .then((r) => finalizeAssetWriteBack(autoInfoPids, { ok: r.ok, fail: r.fail, fails: r.fails }))
                          .catch(() => {});
                      }
                    });
                  }
                } catch (e: any) { setCreateBMError(e.message); }
                finally { setCreatingBM(false); }
              }} disabled={creatingBM} className="px-4 py-2 bg-indigo-600 text-white rounded disabled:opacity-50">{creatingBM?'提交中…':'创建'}</button>
            </div>
          </div>
        </div>
      )}
      {isFBRegOpen && (
        <div className="fixed bottom-4 right-4 z-[60] w-[450px] shadow-2xl animate-in slide-in-from-right-10 duration-300">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl flex flex-col max-h-[80vh] overflow-hidden ring-1 ring-white/10">
            <div className="p-4 bg-slate-800/50 border-b border-slate-700 flex justify-between items-center cursor-move">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Facebook 注册流水线</h3>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => setIsFBRegOpen(false)} 
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-md transition-colors"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar">
              <FacebookRegistration 
                selectedProfileIds={selectedIds.size > 0 ? Array.from(selectedIds) : undefined}
                onComplete={() => {
                  try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
                }} 
              />
            </div>
          </div>
        </div>
      )}
      {/* 🚀 备注快速编辑弹窗 */}
      {editingNotes && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setEditingNotes(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-200 mb-3">编辑备注</h3>
            <textarea
              value={editingNotes.notes}
              onChange={e => setEditingNotes(prev => prev ? { ...prev, notes: e.target.value } : null)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500 min-h-[80px] resize-y"
              placeholder="输入备注内容..."
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setEditingNotes(null)} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors">取消</button>
              <button onClick={async () => {
                if (!editingNotes) return;
                try {
                  const resp = await fetch(`/api/profiles/${encodeURIComponent(editingNotes.id)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
                    body: JSON.stringify({ account_notes: editingNotes.notes })
                  });
                  const json = await resp.json().catch(() => ({}));
                  if (!json.success) {
                    alert(`保存失败: ${json.message || resp.statusText || '未知错误'}`);
                    return;
                  }
                  if (json.changes === 0) {
                    alert(`保存失败: 未找到匹配的配置 (changes=0)，可能是权限不足或 profile 不存在`);
                    return;
                  }
                  // 表格渲染的是服务端分页数据（paginatedProfiles），两份都要同步才会立即显示
                  patchProfileBoth(editingNotes.id, p => ({ ...p, notes: editingNotes.notes }));
                } catch (e: any) {
                  alert(`保存异常: ${e?.message || '网络错误'}`);
                  return;
                }
                setEditingNotes(null);
              }} className="px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}
      {/* 🚀 绑卡信息对话框 */}
      <CardInfoModal
        open={isCardInfoOpen}
        onClose={() => setIsCardInfoOpen(false)}
        onConfirm={batchBindCards}
        profileCount={selectedIds.size}
      />
      {/* 🚀 接入BM对话框 */}
      {isJoinBMOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { if (!joiningBM) setIsJoinBMOpen(false); }}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-100">接入BM</h3>
              {!joiningBM && <button onClick={() => setIsJoinBMOpen(false)} className="text-slate-400 hover:text-slate-200"><X className="w-5 h-5" /></button>}
            </div>
            <p className="text-sm text-slate-400 mb-3">
              每行输入一个 BM ID 或 BM 邀请链接，系统将依次为选中的每个浏览器配置接入这些 BM。
            </p>
            <textarea
              value={joinBMLinks}
              onChange={e => setJoinBMLinks(e.target.value)}
              disabled={joiningBM}
              placeholder={`1234567890\nhttps://business.facebook.com/accept?business_id=1234567890&invitation_id=xxx\n0987654321`}
              className="w-full h-32 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm resize-none disabled:opacity-50"
            />
            <div className="text-xs text-slate-500 mt-1">
              已勾选 <span className="text-indigo-400 font-semibold">{selectedIds.size}</span> 个配置 | 
              BM列表: <span className="text-indigo-400 font-semibold">{joinBMLinks.trim() ? joinBMLinks.split('\n').filter(Boolean).length : 0}</span> 个
            </div>
            {joinBMResults.length > 0 && (
              <div className="mt-3 max-h-48 overflow-y-auto bg-slate-950 rounded-lg p-2 text-xs space-y-1">
                {joinBMResults.map((r, i) => (
                  <div key={i} className={`px-2 py-1 rounded ${r.includes('成功') ? 'text-emerald-400' : 'text-rose-400'}`}>{r}</div>
                ))}
              </div>
            )}
            <div className="flex gap-3 mt-4">
              <button onClick={() => setIsJoinBMOpen(false)} disabled={joiningBM} className="flex-1 px-4 py-2 bg-slate-700 text-slate-200 rounded-lg hover:bg-slate-600 disabled:opacity-50 text-sm">
                关闭
              </button>
              <button
                onClick={async () => {
                  const links = joinBMLinks.trim().split('\n').map(s => s.trim()).filter(Boolean);
                  if (links.length === 0) { alert('请至少输入一个 BM 链接或 ID'); return; }
                  setJoiningBM(true);
                  setJoinBMResults([]);
                  const allResults: string[] = [];
                  const targetProfiles = profiles.filter(p => selectedIds.has(p.id));
                  const lbase = 'http://localhost:9999';

                  for (const p of targetProfiles) {
                    for (const link of links) {
                      try {
                        const resp = await fetch(`${lbase}/api/facebook/businesses/accept-invite-link`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                          body: JSON.stringify({ profileId: p.id, bmLink: link })
                        });
                        const json = await resp.json().catch(() => ({ success: false }));
                        const msg = json.success
                          ? `✅ [${p.name}] BM ${json.businessId || link} 接入成功`
                          : `❌ [${p.name}] BM ${link} 接入失败: ${json.message || '未知错误'}`;
                        allResults.push(msg);
                      } catch (err: any) {
                        allResults.push(`❌ [${p.name}] BM ${link} 请求异常: ${err.message}`);
                      }
                      setJoinBMResults([...allResults]);
                    }
                  }

                  setJoiningBM(false);
                }}
                disabled={joiningBM}
                className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50 text-sm flex items-center justify-center gap-2"
              >
                {joiningBM ? <><RefreshCw className="w-4 h-4 animate-spin" />处理中...</> : <>开始接入</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
