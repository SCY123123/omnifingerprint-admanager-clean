import React, { useEffect, useState, useCallback, useRef } from 'react';
import { X, FileText, Globe, CreditCard, Upload, Search, Shield, GripVertical, Send, ChevronUp, ChevronDown, Download, Key, Copy, Trash2, DollarSign, Eye, ShieldCheck, Building2, PlusCircle } from 'lucide-react';
import { PageCreator, PageCreationData } from './PageCreator';
import { BMOperationsDialog } from './BMOperationsDialog';
import { CardInfoModal } from './CardInfoModal';
import { FacebookAdPublisher, AdPublishData } from './FacebookAdPublisher';
// 🧵 智能发布的「组合步骤」交给本机服务端队列执行（提交后刷新页面也不中断）
import { submitJob, waitForJob } from './jobQueue';
// 🆕 广告号字段组（命名方式 + 时区/货币 + 账单信息）—— 与「创建广告号」表单共用同一份
import { AdAccountFields, defaultAdAccountForm, adNamePayload, adBillingPayload, type AdAccountForm } from './AdAccountFields';

const LOCAL_SERVER_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

/* ---------- types ---------- */
interface CardRow {
  id?: string; card_id?: string; alias?: string; last_four_digits?: string; card_last4?: string;
  cardNumber?: string; holder?: string; cvv?: string; exp_month?: string; exp_year?: string;
  channel?: string; tags?: string[]; brand?: string; billing_address?: string; zip?: string;
  status?: string; currency?: string;
}
interface AdTemplate {
  id: number;
  name: string;
  config: string;
  is_default: number;
  updated_at: string;
}

type StepKey = 'createAdAccount' | 'fetchInfo' | 'precheck' | 'token' | 'page' | 'billing' | 'checkCard' | 'card' | 'spendCap' | 'checkLogin' | 'checkAd' | 'publish' | 'lang' | 'payment';

// 🚀 主页类别 → Facebook 类别ID映射（来自抓包分析）
const CATEGORY_ID_MAP: Record<string, string> = {
  'Digital Creator': '2196',
  'Business Service': '2074',
  'Entertainment Website': '2183',
  'Health/Beauty': '2214',
  'Product/Service': '2168',
  'Shopping & Retail': '2176',
  'Artist/Band': '2133',
  'Brand/Product': '2011',
  'Cause/Community': '2210',
  'Education': '2166',
  'Entrepreneur': '2035',
  'Fashion/Model': '2142',
  'Food/Beverage': '2095',
  'Government Official': '2140',
  'Journalist': '2041',
  'Local Business': '2100',
  'Media/News Company': '2129',
  'Movie/TV Show': '2080',
  'Musician/Band': '2133',
  'Non-Profit Organization': '2194',
  'Personal Blog': '2063',
  'Photographer': '2156',
  'Politician': '2092',
  'Public Figure': '2018',
  'Real Estate': '2107',
  'Restaurant/Cafe': '2152',
  'School': '2109',
  'Software/App': '2165',
  'Sports Team/Sportsperson': '2143',
  'Tutor/Teacher': '2064',
  'Travel/Tourism': '2171',
  'Video Creator': '2220',
  'Website/Blog': '2043',
  'Writer': '2039',
};

interface StepDef {
  key: StepKey;
  label: string;
  icon: React.ReactNode;
  color: string;
  enabled: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  profileIds: string[];
  adAccountIds?: string[];
  /**
   * 🆕 从「BM 列表」进来时选中的 BM（含它所属的配置）：
   *    会先在这些 BM 下面建广告号，再把新广告号接给后面的账单/绑卡/发布步骤。
   */
  businesses?: Array<{ profileId: string; businessId: string }>;
  assetType?: 'profiles' | 'adAccounts' | 'bms';
}

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
const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', DE: 'EUR', FR: 'EUR', IT: 'EUR',
  ES: 'EUR', NL: 'EUR', JP: 'JPY', SG: 'SGD', HK: 'HKD', KR: 'KRW', TW: 'TWD',
  IN: 'INR', BR: 'BRL', MX: 'MXN', CH: 'CHF', NZ: 'NZD', ZA: 'ZAR', AE: 'AED',
  SA: 'SAR', IL: 'ILS', TR: 'TRY', RU: 'RUB', PL: 'PLN', TH: 'THB', VN: 'VND',
  ID: 'IDR', MY: 'MYR', PH: 'PHP', IE: 'EUR', PT: 'EUR', GR: 'EUR', CZ: 'CZK',
  HU: 'HUF', RO: 'RON', BG: 'BGN', UA: 'UAH', SE: 'SEK', NO: 'NOK', DK: 'DKK',
};
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY', 'DC'];

const inputCls = 'w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm';
const labelCls = 'text-xs text-slate-400 mb-0.5 block';

export const SmartPublishDialog: React.FC<Props> = ({ open, onClose, profileIds, adAccountIds, businesses, assetType }) => {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<string[]>([]);
  const logTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, step: 0, totalSteps: 0 });

  // Puppeteer 服务器地址（页面创建、账单修改、绑卡等需要浏览器操作的地方使用）
  const puppeteerBase = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL 
    ? String((import.meta as any).env.VITE_LAUNCH_SERVER_URL).replace(/\/$/, '') + '/api'
    : 'http://localhost:9999/api';

  // ---- 步骤排序 ----
  const [stepOrder, setStepOrder] = useState<StepKey[]>(['createAdAccount', 'fetchInfo', 'precheck', 'token', 'page', 'billing', 'checkCard', 'card', 'spendCap', 'checkLogin', 'checkAd', 'publish', 'lang', 'payment']);
  const stepDefs: Record<StepKey, { label: string; icon: React.ReactNode; color: string }> = {
    createAdAccount: { label: '创建广告号', icon: <PlusCircle className="w-4 h-4" />, color: 'text-teal-400' },
    fetchInfo: { label: '获取信息', icon: <Download className="w-4 h-4" />, color: 'text-cyan-400' },
    precheck: { label: '预检获取信息', icon: <Search className="w-4 h-4" />, color: 'text-sky-400' },
    token: { label: '获取 Token', icon: <Key className="w-4 h-4" />, color: 'text-violet-400' },
    page: { label: '创建主页', icon: <FileText className="w-4 h-4" />, color: 'text-indigo-400' },
    billing: { label: '修改国家/时区/货币', icon: <Globe className="w-4 h-4" />, color: 'text-emerald-400' },
    checkCard: { label: '检查已有卡片', icon: <ShieldCheck className="w-4 h-4" />, color: 'text-amber-500' },
    card: { label: '绑定卡片', icon: <CreditCard className="w-4 h-4" />, color: 'text-amber-400' },
    spendCap: { label: '设置限额', icon: <DollarSign className="w-4 h-4" />, color: 'text-yellow-400' },
    checkLogin: { label: '检查登录状态', icon: <ShieldCheck className="w-4 h-4" />, color: 'text-green-500' },
    checkAd: { label: '检查已有广告', icon: <Eye className="w-4 h-4" />, color: 'text-rose-500' },
    publish: { label: '发布广告', icon: <Send className="w-4 h-4" />, color: 'text-rose-400' },
    lang: { label: '修改界面语言', icon: <Globe className="w-4 h-4" />, color: 'text-purple-400' },
    payment: { label: '手动付款', icon: <DollarSign className="w-4 h-4" />, color: 'text-green-400' },
  };
  const [stepEnabled, setStepEnabled] = useState<Record<StepKey, boolean>>({
    createAdAccount: false, fetchInfo: true, precheck: true, token: false, page: false, billing: false, checkCard: false, card: false, spendCap: false, checkLogin: false, checkAd: false, publish: false, lang: false, payment: false
  });
  // 🆕 广告号字段组（命名方式 + 时区/货币 + 账单信息）：从「BM 列表」进来时用它配置
  //    「在选中的 BM 下建广告号」的参数，与「创建广告号」表单共用同一份组件。
  const [adForm, setAdForm] = useState<AdAccountForm>(defaultAdAccountForm);
  const patchAd = (p: Partial<AdAccountForm>) => setAdForm(v => ({ ...v, ...p }));
  const businessKey = (businesses || []).map(b => `${b.profileId}::${b.businessId}`).join(',');
  // 🆕 从「BM 列表」发起（带了 businessIds）→ 自动勾上「创建广告号」步骤
  useEffect(() => {
    if (open && businessKey) setStepEnabled(v => (v.createAdAccount ? v : { ...v, createAdAccount: true }));
  }, [open, businessKey]);
  const moveStep = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= stepOrder.length) return;
    const nu = [...stepOrder];
    [nu[idx], nu[to]] = [nu[to], nu[idx]];
    setStepOrder(nu);
  };

  // ---- 1. 创建主页 ----
  const [pageData, setPageData] = useState<PageCreationData | null>(null);
  const [showPageCreator, setShowPageCreator] = useState(false);

  // ---- 2. 修改账单 ----
  const [ctCountry, setCtCountry] = useState('US');
  const [ctCurrency, setCtCurrency] = useState('USD');
  const [ctTimezone, setCtTimezone] = useState('1');
  const [ctLang, setCtLang] = useState('');
  const [ctAddress, setCtAddress] = useState('');
  const [ctCity, setCtCity] = useState('');
  const [ctZip, setCtZip] = useState('');
  const [ctBusinessName, setCtBusinessName] = useState('');
  const [ctAddressRandom, setCtAddressRandom] = useState(true);
  const [ctCityRandom, setCtCityRandom] = useState(true);
  const [ctZipRandom, setCtZipRandom] = useState(true);
  const [billingState, setBillingState] = useState('AL');
  const [billingStateRandom, setBillingStateRandom] = useState(false);

  // ---- 手动付款 ----
  const [paymentAmount, setPaymentAmount] = useState('50');

  // ---- 3. 绑定卡片 ----
  const [localCards, setLocalCards] = useState<CardRow[]>([]);
  const [cardSearch, setCardSearch] = useState('');
  const [cardFilterChannel, setCardFilterChannel] = useState('');
  const [cardFilterTag, setCardFilterTag] = useState('');
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [cardIterateMode, setCardIterateMode] = useState<'all' | 'cycle'>('cycle');
  const [showCardInfo, setShowCardInfo] = useState(false);
  const [manualCardData, setManualCardData] = useState<any>(null);
  const [checkBillingParams, setCheckBillingParams] = useState(false);

  // ---- 3.5 设置限额（绑卡后执行） ----
  // 💰 账户花费上限（spend_cap）：按账户货币主单位「原值」提交（0 = 取消限额）。
  //    值存在 localStorage，下次打开弹窗沿用。
  const [spendCapAmount, setSpendCapAmount] = useState<string>(() => {
    try { return localStorage.getItem('smartPublish:spendCapAmount') ?? '100'; } catch { return '100'; }
  });
  useEffect(() => {
    try { localStorage.setItem('smartPublish:spendCapAmount', spendCapAmount); } catch {}
  }, [spendCapAmount]);

  // ---- 4. 代理 ----
  const [enableProxy, setEnableProxy] = useState(false);
  const [publishWithProxy, setPublishWithProxy] = useState(false);
  const [proxyList, setProxyList] = useState<any[]>([]);
  const [proxySearch, setProxySearch] = useState('');
  const [proxyFilterTag, setProxyFilterTag] = useState('');
  const [proxyFilterChannel, setProxyFilterChannel] = useState('');
  const [proxySelectedId, setProxySelectedId] = useState('');
  const [proxyFailedIds, setProxyFailedIds] = useState<Set<string>>(new Set());
  const [proxyIterateMode, setProxyIterateMode] = useState<'auto' | 'fixed'>('auto');

  // ---- 5. 发布广告 ----
  const [adPublishData, setAdPublishData] = useState<AdPublishData | null>(null);
  const [showAdPublisher, setShowAdPublisher] = useState(false);

  // ---- 模板选择（支持多模板命名） ----
  const [pageTemplateList, setPageTemplateList] = useState<{ name: string; data: any }[]>([]);
  const [billingTemplateList, setBillingTemplateList] = useState<{ name: string; data: any }[]>([]);
  const [cardTemplateList, setCardTemplateList] = useState<{ name: string; data: any }[]>([]);
  const [adTemplateList, setAdTemplateList] = useState<AdTemplate[]>([]);
  const [selectedPageTemplate, setSelectedPageTemplate] = useState('');
  const [selectedBillingTemplate, setSelectedBillingTemplate] = useState('');
  const [selectedCardTemplate, setSelectedCardTemplate] = useState('');
  const [selectedAdTemplateName, setSelectedAdTemplateName] = useState('');

  // ---- 预检结果 ----
  interface PrecheckItem {
    adAccountId: string;
    accountStatus: string;
    accountStatusLabel: string;
    hasCards: boolean;
    cardsCount: number;
    pixelOk: boolean;
    pixelName: string;
    pixelCount: number;
    passed: boolean;
  }
  const [precheckResults, setPrecheckResults] = useState<Record<string, PrecheckItem[]>>({});

  // ---- 加载数据 + 从数据库加载已保存配置 ----
  useEffect(() => {
    if (!open) return;
    // 1. 从 billingMethodsByProfile 加载卡片（含渠道/标签）
    (async () => {
      const all: CardRow[] = [];
      try {
        const stored = localStorage.getItem('billingMethodsByProfile');
        if (stored) {
          const byProfile = JSON.parse(stored);
          Object.values(byProfile).forEach((cards: any) => {
            if (Array.isArray(cards)) cards.forEach((c: any) => {
              const tags = Array.isArray(c.tags) ? c.tags : [];
              let holder = '', cardNum = '', cvvVal = '', ch = '', tgs: string[] = [];
              try {
                const addr = typeof c.billing_address === 'string' ? JSON.parse(c.billing_address) : (c.billing_address || {});
                holder = String(addr.holder || '');
                cardNum = String(addr.number || '');
                cvvVal = String(addr.cvv || '');
                // billing_address 内部也可能存 channel/tags
                if (addr.channel && !c.channel) ch = addr.channel;
                if (Array.isArray(addr.tags) && (!c.tags || !Array.isArray(c.tags) || c.tags.length === 0)) tgs = addr.tags.map(String);
              } catch {}
              all.push({
                id: c.id || c.card_id || '',
                card_last4: c.last4 || '',
                brand: c.brand || '',
                status: c.status || 'pending_verification',
                exp_month: c.exp_month || '',
                exp_year: c.exp_year || '',
                zip: c.zip || '',
                channel: ch || c.channel || '',
                tags: tgs.length > 0 ? tgs : tags,
                savedAt: c.savedAt || '',
                billing_address: typeof c.billing_address === 'string' ? c.billing_address : JSON.stringify(c.billing_address || {}),
                alias: c.alias || `末四位 ${c.last4 || '****'}`,
                cardNumber: cardNum, holder, cvv: cvvVal
              });
            });
          });
        }
      } catch {}
      localStorage.setItem('local-cards', JSON.stringify(all));
      setLocalCards(all);
    })();
    try {
      const p = localStorage.getItem('omnifingerprint_page_template_cache');
      if (p) { const v = JSON.parse(p); if (v.templates) { setPageTemplateList(v.templates); setSelectedPageTemplate(v.activeTemplate || v.templates[0]?.name || ''); } }
    } catch {}
    try {
      const b = localStorage.getItem('omnifingerprint_billing_template_cache');
      if (b) { const v = JSON.parse(b); if (v.templates) { setBillingTemplateList(v.templates); setSelectedBillingTemplate(v.activeTemplate || v.templates[0]?.name || ''); } }
    } catch {}
    try {
      const c = localStorage.getItem('omnifingerprint_card_template_cache');
      if (c) { const v = JSON.parse(c); if (v.templates) { setCardTemplateList(v.templates); setSelectedCardTemplate(v.activeTemplate || v.templates[0]?.name || ''); } }
    } catch {}
    try {
      const a = localStorage.getItem('omnifingerprint_ad_templates_cache');
      if (a) { const v = JSON.parse(a); if (Array.isArray(v)) setAdTemplateList(v); }
    } catch {}
    // 从数据库加载已保存的发布配置
    (async () => {
      try {
        const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
        const base = String(serverUrl || '').replace(/\/$/, '');
        const authToken = localStorage.getItem('auth_token');
        const r = await fetch(`${base}/api/publish-configs`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const j = await r.json();
        if (j.success && j.data) {
          // page 配置 - 新版 { templates, activeTemplate } 格式
          if (j.data.page) {
            const p = j.data.page;
            if (p.templates) {
              setPageTemplateList(p.templates);
              const active = p.activeTemplate || (p.templates[0]?.name || '');
              setSelectedPageTemplate(active);
              const tpl = p.templates.find((t: any) => t.name === active);
              if (tpl?.data) {
                const d = tpl.data;
                setPageData({
                  name: d.name || '', isRandomName: d.isRandomName ?? false,
                  website: d.website || '', category: d.category || 'Digital Creator',
                  useSession: d.useSession ?? false, proxyId: d.proxyId || undefined,
                  proxyManualInput: d.proxyManualInput || undefined,
                  proxyType: d.proxyType || undefined
                });
              }
            } else {
              // 旧格式兼容
              setSelectedPageTemplate('默认');
              setPageData({
                name: p.name || '', isRandomName: p.isRandomName ?? false,
                website: p.website || '', category: p.category || 'Digital Creator',
                useSession: p.useSession ?? false, proxyId: p.proxyId || undefined,
                proxyManualInput: p.proxyManualInput || undefined,
                proxyType: p.proxyType || undefined
              });
            }
            setStepEnabled(prev => ({ ...prev, page: true }));
          }
          // billing 配置 - 新版 { templates, activeTemplate } 格式
          if (j.data.billing) {
            const b = j.data.billing;
            if (b.templates) {
              setBillingTemplateList(b.templates);
              const active = b.activeTemplate || (b.templates[0]?.name || '');
              setSelectedBillingTemplate(active);
              const tpl = b.templates.find((t: any) => t.name === active);
              if (tpl?.data) {
                setCtCountry(tpl.data.country || 'US');
                setCtCurrency(tpl.data.currency || 'USD');
                setCtTimezone(tpl.data.timezone || '1');
                setCtLang(tpl.data.lang || '');
                setCtAddress(tpl.data.address || '');
                setCtCity(tpl.data.city || '');
                setCtZip(tpl.data.zip || '');
                setBillingState(tpl.data.state || '');
                setCtBusinessName(tpl.data.business_name || '');
                setCtAddressRandom(tpl.data.addressRandom ?? false);
                setCtCityRandom(tpl.data.cityRandom ?? false);
                setCtZipRandom(tpl.data.zipRandom ?? false);
                setBillingStateRandom(tpl.data.stateRandom ?? false);
              }
            } else {
              // 旧格式兼容
              setSelectedBillingTemplate('默认');
              setCtCountry(b.country || 'US');
              setCtCurrency(b.currency || 'USD');
              setCtTimezone(b.timezone || '1');
              setCtLang(b.lang || '');
              setCtAddress(b.address || '');
              setCtCity(b.city || '');
              setCtZip(b.zip || '');
              setBillingState(b.state || '');
              setCtBusinessName(b.business_name || '');
              setCtAddressRandom(b.addressRandom ?? false);
              setCtCityRandom(b.cityRandom ?? false);
              setCtZipRandom(b.zipRandom ?? false);
              setBillingStateRandom(b.stateRandom ?? false);
            }
            setStepEnabled(prev => ({ ...prev, billing: true }));
          }
          // card 配置 - 新版 { templates, activeTemplate } 格式
          if (j.data.card) {
            const c = j.data.card;
            if (c.templates) {
              setCardTemplateList(c.templates);
              const active = c.activeTemplate || (c.templates[0]?.name || '');
              setSelectedCardTemplate(active);
              const tpl = c.templates.find((t: any) => t.name === active);
              if (tpl?.data) {
                if (tpl.data.selectedCardIds) setSelectedCardIds(new Set(tpl.data.selectedCardIds));
                if (tpl.data.iterateMode) setCardIterateMode(tpl.data.iterateMode);
                if (tpl.data.manualCard) setManualCardData(tpl.data.manualCard);
                if (tpl.data.checkBillingParams !== undefined) setCheckBillingParams(tpl.data.checkBillingParams);
              }
            } else {
              // 旧格式兼容
              setSelectedCardTemplate('默认');
              if (c.manualCard) setManualCardData(c.manualCard);
              if (c.selectedCardIds && Array.isArray(c.selectedCardIds)) setSelectedCardIds(new Set(c.selectedCardIds));
              if (c.iterateMode) setCardIterateMode(c.iterateMode);
              if (c.checkBillingParams !== undefined) setCheckBillingParams(c.checkBillingParams);
            }
            setStepEnabled(prev => ({ ...prev, card: true }));
          }
        }
      } catch {}
      // 加载代理列表
      try {
        const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
        const base = String(serverUrl || '').replace(/\/$/, '');
        const authToken = localStorage.getItem('auth_token');
        const r = await fetch(`${base}/api/proxies`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const j = await r.json();
        const list = Array.isArray(j?.data) ? j.data : [];
        setProxyList(list);
      } catch {}
      // 加载 ad-templates（发布广告模板列表）
      try {
        const authToken = localStorage.getItem('auth_token');
        const r = await fetch('/api/ad-templates', {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const j = await r.json();
        if (j.success) setAdTemplateList(j.data);
      } catch {}
    })();
    setPageData(null);
    setManualCardData(null);
    setAdPublishData(null);
    setProxySelectedId('');
    setProxyFailedIds(new Set());
    setLog([]);
    setProgress({ done: 0, total: 0, step: 0, totalSteps: 0 });
    setPageTemplateList([]);
    setBillingTemplateList([]);
    setCardTemplateList([]);
    setAdTemplateList([]);
    setSelectedPageTemplate('');
    setSelectedBillingTemplate('');
    setSelectedCardTemplate('');
    setSelectedAdTemplateName('');
    setPrecheckResults({});
    // 账单表单随机勾选重置
    setCtAddressRandom(false);
    setCtCityRandom(false);
    setCtZipRandom(false);
    setBillingStateRandom(false);
  }, [open]);

  // ---- 计算属性 ----
  const allChannels = [...new Set(localCards.map(c => c.channel).filter(Boolean))];
  const allTags = [...new Set(localCards.flatMap(c => c.tags || []))];
  const filteredCards = localCards.filter(c => {
    const q = cardSearch.toLowerCase();
    if (q && !(c.alias||'').toLowerCase().includes(q) && !(c.cardNumber||'').includes(q) && !(c.channel||'').toLowerCase().includes(q)) return false;
    if (cardFilterChannel && c.channel !== cardFilterChannel) return false;
    if (cardFilterTag && !(c.tags||[]).includes(cardFilterTag)) return false;
    return true;
  });
  const toggleCard = (id: string) => {
    setSelectedCardIds(prev => {
      const nu = new Set(prev);
      if (nu.has(id)) nu.delete(id); else nu.add(id);
      return nu;
    });
  };
  const addLog = (msg: string) => {
    logRef.current = [...logRef.current, `[${new Date().toLocaleTimeString()}] ${msg}`];
    if (!logTimerRef.current) {
      logTimerRef.current = setTimeout(() => {
        setLog([...logRef.current]);
        logTimerRef.current = null;
      }, 300);
    }
  };

  // 🚀 组件卸载或执行完成时强制刷新日志
  const flushLog = () => {
    if (logTimerRef.current) { clearTimeout(logTimerRef.current); logTimerRef.current = null; }
    setLog([...logRef.current]);
  };

  // 渠道/标签筛选时自动全选匹配卡片
  useEffect(() => {
    if (cardFilterChannel || cardFilterTag) {
      const ids = filteredCards.map(c => c.id || c.card_id || '').filter(Boolean);
      setSelectedCardIds(new Set(ids));
    }
  }, [cardFilterChannel, cardFilterTag]);

  // ---- 自动保存 billing / card 配置到数据库（合并到模板数组中） ----
  const saveConfig = async (key: string, value: any) => {
    try {
      const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
      const base = String(serverUrl || '').replace(/\/$/, '');
      const authToken = localStorage.getItem('auth_token');
      await fetch(`${base}/api/publish-configs/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ value })
      });
      // 同步更新 localStorage 缓存，统一与模板管理器数据
      const cacheKey = `omnifingerprint_${key}_template_cache`;
      localStorage.setItem(cacheKey, JSON.stringify(value));
    } catch {}
  };
  // 账单变更时自动保存（读出现有模板数组，只更新 active 模板的数据）
  useEffect(() => {
    if (open && selectedBillingTemplate) {
      const nuData = { country: ctCountry, currency: ctCurrency, timezone: ctTimezone, lang: ctLang, address: ctAddress, city: ctCity, zip: ctZip, state: billingState, addressRandom: ctAddressRandom, cityRandom: ctCityRandom, zipRandom: ctZipRandom, stateRandom: billingStateRandom, business_name: ctBusinessName };
      const nuTemplates = billingTemplateList.map(t => t.name === selectedBillingTemplate ? { name: t.name, data: nuData } : t);
      const nuList = nuTemplates.length > 0 ? nuTemplates : [{ name: selectedBillingTemplate, data: nuData }];
      saveConfig('billing', { templates: nuList, activeTemplate: selectedBillingTemplate });
    }
  }, [ctCountry, ctCurrency, ctTimezone, ctLang, ctAddress, ctCity, ctZip, billingState, ctBusinessName, ctAddressRandom, ctCityRandom, ctZipRandom, billingStateRandom]);
  // 卡片变更时自动保存
  useEffect(() => {
    if (open && selectedCardTemplate) {
      const nuData = { selectedCardIds: Array.from(selectedCardIds), iterateMode: cardIterateMode, manualCard: manualCardData, checkBillingParams };
      const nuTemplates = cardTemplateList.map(t => t.name === selectedCardTemplate ? { name: t.name, data: nuData } : t);
      const nuList = nuTemplates.length > 0 ? nuTemplates : [{ name: selectedCardTemplate, data: nuData }];
      saveConfig('card', { templates: nuList, activeTemplate: selectedCardTemplate });
    }
  }, [selectedCardIds, cardIterateMode]);

  // ---- 模板切换处理 ----
  const switchPageTemplate = (name: string) => {
    setSelectedPageTemplate(name);
    const tpl = pageTemplateList.find(t => t.name === name);
    if (tpl?.data) {
      const d = tpl.data;
      setPageData({
        name: d.name || '', isRandomName: d.isRandomName ?? false,
        website: d.website || '', category: d.category || 'Digital Creator',
        useSession: d.useSession ?? false, proxyId: d.proxyId || undefined,
        proxyManualInput: d.proxyManualInput || undefined,
        proxyType: d.proxyType || undefined
      });
    }
  };
  const switchBillingTemplate = (name: string) => {
    setSelectedBillingTemplate(name);
    const tpl = billingTemplateList.find(t => t.name === name);
    if (tpl?.data) {
      setCtCountry(tpl.data.country || 'US');
      setCtCurrency(tpl.data.currency || 'USD');
      setCtTimezone(tpl.data.timezone || '1');
      setCtLang(tpl.data.lang || '');
      setCtAddress(tpl.data.address || '');
      setCtCity(tpl.data.city || '');
      setCtZip(tpl.data.zip || '');
      setBillingState(tpl.data.state || '');
      setCtBusinessName(tpl.data.business_name || '');
      setCtAddressRandom(tpl.data.addressRandom ?? false);
      setCtCityRandom(tpl.data.cityRandom ?? false);
      setCtZipRandom(tpl.data.zipRandom ?? false);
      setBillingStateRandom(tpl.data.stateRandom ?? false);
    }
  };
  const switchCardTemplate = (name: string) => {
    setSelectedCardTemplate(name);
    const tpl = cardTemplateList.find(t => t.name === name);
    if (tpl?.data) {
      if (tpl.data.selectedCardIds) setSelectedCardIds(new Set(tpl.data.selectedCardIds));
      if (tpl.data.iterateMode) setCardIterateMode(tpl.data.iterateMode);
      if (tpl.data.manualCard) setManualCardData(tpl.data.manualCard);
      if (tpl.data.checkBillingParams !== undefined) setCheckBillingParams(tpl.data.checkBillingParams);
    }
  };
  const switchAdTemplate = (name: string) => {
    setSelectedAdTemplateName(name);
    const tpl = adTemplateList.find(t => t.name === name);
    if (tpl) {
      try {
        setAdPublishData({ ...JSON.parse(tpl.config), templateName: tpl.name, publishMethod: JSON.parse(tpl.config).publishMethod || 'api' } as any);
      } catch {}
    }
  };

  const proxyAllTags = [...new Set(proxyList.flatMap((p: any) => {
    const tags = p.tags || p.label || '';
    return typeof tags === 'string' ? tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
  }))];
  const proxyAllChannels = [...new Set(proxyList.map((p: any) => p.channel).filter(Boolean))];
  const filteredProxies = proxyList.filter((p: any) => {
    const q = proxySearch.toLowerCase();
    const tags = (p.tags || p.label || '').toString().toLowerCase();
    if (q && !(p.host||'').includes(q) && !(p.country||'').toLowerCase().includes(q) && !tags.includes(q) && !(p.channel||'').toLowerCase().includes(q)) return false;
    if (proxyFilterChannel && p.channel !== proxyFilterChannel) return false;
    if (proxyFilterTag && !tags.includes(proxyFilterTag.toLowerCase())) return false;
    if (proxyFailedIds.has(p.id)) return false;
    return true;
  });
  const smartProxyType = (p: any) => {
    if (!p) return '';
    const t = (p.type || p.proxy_type || p.protocol || '').toLowerCase();
    if (t === 'socks5' || t === 'socks5h' || t === 'socks') return 'socks5';
    if (t === 'residential' || t === 'http' || t === 'https') return t;
    // 如果 type 字段不存在但有端口号辅助判断
    const port = Number(p.port || 0);
    if (port === 1080 || port === 10808 || port === 10808) return 'socks5';
    return 'http';
  };
  const markProxyFailed = async (proxyId: string) => {
    setProxyFailedIds(prev => new Set(prev).add(proxyId));
    try {
      const authToken = localStorage.getItem('auth_token');
      // 🐛 修复：云端路由是 POST /api/proxies/:id/fail（id 在路径里），
      //    以前写成 POST /api/proxies/fail + body{id} → 一直 404 静默失败，失败代理从没落库过。
      await fetch(`/api/proxies/${encodeURIComponent(proxyId)}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }
      });
    } catch {}
  };

  const activeSteps = stepOrder.filter(sk => stepEnabled[sk]);

  // ---- 执行 ----
  const handleRun = async () => {
    if (profileIds.length === 0 || activeSteps.length === 0) return;
    setRunning(true);
    setLog([]);
    setPrecheckResults({});
    const authToken = localStorage.getItem('auth_token');
    const cardList = localCards.filter(c => selectedCardIds.has(c.id || c.card_id || ''));
    setProgress({ done: 0, total: profileIds.length, step: 0, totalSteps: activeSteps.length });

    // 记录预检未通过的配置，后续步骤跳过
    const skippedPids = new Set<string>();

    // 🧵 已接入服务端队列的步骤（分 3 批迁移中）。
    //    本次选中的步骤**全部**属于「已接入」集合时，整条流水线交给服务端队列执行：
    //    提交后可随意刷新/切页/断网，进度与取消在左侧「执行队列」；
    //    只要含有未接入的步骤，就仍走下面的前端流程（保证行为不回归）。
    //    第 1 批：fetchInfo / token / checkLogin / lang / payment / checkCard
    //    第 2 批：billing / card / page
    //    第 3 批：precheck / checkAd / publish（至此全部步骤都已接入）
    const QUEUE_READY_STEPS = new Set(['fetchInfo', 'token', 'checkLogin', 'lang', 'payment', 'checkCard', 'billing', 'card', 'spendCap', 'page', 'precheck', 'checkAd', 'publish']);
    // 🆘 逃生开关：万一队列版有问题，在控制台执行
    //    localStorage.setItem('smartPublish:useLegacy','1') 再重新打开弹窗，就回到旧的前端流程；
    //    确认队列版稳定后我会把旧流程整段删掉（现在先留着当回滚路径）。
    const useLegacyPath = (() => { try { return localStorage.getItem('smartPublish:useLegacy') === '1'; } catch { return false; } })();

    // 🆕「创建广告号」单独摘出来先跑：从「BM 列表」进来时，先在选中的这些 BM 下把广告号建出来，
    //    再把新建的广告号接给后面「账单/绑卡/发布」等步骤（那些步骤只认 adAccountIds）。
    //    用的是现成的 create_adaccount 队列任务（与「创建广告号」表单提交的是同一种任务）。
    const bundleSteps = activeSteps.filter(sk => sk !== 'createAdAccount');
    // 本次实际要操作的广告号 = 原有的 + 刚建出来的
    const runAccountIds: string[] = [...(adAccountIds || [])];

    // ① 若勾了「创建广告号」，先跑掉
    if (activeSteps.includes('createAdAccount')) {
      const pairs = (businesses || [])
        .map(b => ({ profileId: String(b.profileId || ''), businessId: String(b.businessId || '') }))
        .filter(b => b.profileId && b.businessId);
      if (!pairs.length) {
        addLog('⚠️ 已勾选「创建广告号」但没有可用的 BM —— 该步骤需要在「BM 列表」里选中 BM 后发起才有效，已跳过');
        flushLog();
      } else {
        try {
          const adItems = pairs.map(({ profileId, businessId }) => ({
            key: `${profileId}::${businessId}`,
            label: `${profileId} / BM ${businessId}`,
            payload: {
              profileId, businessId,
              name: adForm.manualName.trim(),
              ...adNamePayload(adForm),
              timezoneId: Number(adForm.timezoneId) || 1,
              currency: adForm.currency,
              count: 1,
              assignAdmin: true,
              adBilling: adBillingPayload(adForm),
            },
          }));
          addLog(`🧵 第 1 步：在 ${pairs.length} 个 BM 下创建广告号`);
          flushLog();
          const adJob = await submitJob({ type: 'create_adaccount', title: `在选中 BM 下创建广告号（${adItems.length} 项）`, items: adItems });
          addLog(`   已提交（${adJob.id}），等待执行完成...`);
          flushLog();
          let fin: any = null;
          await waitForJob(adJob.id, (j) => {
            fin = j;
            if (j && (j.status === 'queued' || j.status === 'running')) {
              setProgress({ done: j.done + j.fail, total: j.total, step: 0, totalSteps: activeSteps.length });
            }
          });
          // 队列项只回传 message，新广告号 ID 是服务端拼在 message 里的（act_xxx）
          const got: string[] = [];
          for (const it of ((fin && fin.items) || [])) {
            const ms = String(it.message || '').match(/act_\d+/g) || [];
            for (const s of ms) got.push(s.replace('act_', ''));
          }
          if (got.length) {
            for (const id of got) if (!runAccountIds.includes(id)) runAccountIds.push(id);
            addLog(`✅ 已创建 ${got.length} 个广告号，并接给后续步骤：${got.map(i => 'act_' + i).join('、')}`);
          } else {
            addLog('⚠️ 没解析到新建广告号 ID，后续步骤不会作用到它们（每项结果见「执行队列」）');
          }
          flushLog();
        } catch (e: any) {
          addLog(`❌ 创建广告号失败：${e?.message || e}（请确认本机后端 9999 已启动）`);
          flushLog();
          setRunning(false);
          return;
        }
      }
    }
    // ② 后面没有别的步骤了 → 到此结束
    if (bundleSteps.length === 0) {
      addLog('ℹ️ 除「创建广告号」外没有其它步骤，本次到此结束');
      flushLog();
      setRunning(false);
      return;
    }

    if (!useLegacyPath && bundleSteps.length > 0 && bundleSteps.every(s => QUEUE_READY_STEPS.has(s))) {
      let cachedAccounts: any[] = [];
      try { cachedAccounts = JSON.parse(localStorage.getItem('cache:adaccounts') || '[]'); } catch { cachedAccounts = []; }

      // —— 账单参数：随机地址在提交前生成好（不把随机逻辑搬到服务端）——
      const pickOne = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
      const billing = {
        currency: ctCurrency,
        timezone_id: ctTimezone,
        country: ctCountry,
        lang: ctLang,
        business_name: ctBusinessName || '',
        address: ctAddressRandom ? `${Math.floor(Math.random() * 9000 + 1000)} ${pickOne(['Main St', 'Oak Ave', 'Elm St', 'Park Rd', 'Broadway', 'Lake Dr', 'Hill St', 'Cedar Ln', 'Maple Ave', 'River Rd', 'Pine St', 'Washington Blvd', 'Sunset Blvd', 'Madison Ave', 'Lincoln St'])}` : ctAddress,
        city: ctCityRandom ? pickOne(['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Austin', 'Miami', 'Denver', 'Boston', 'Seattle', 'Atlanta']) : ctCity,
        zip: ctZipRandom ? String(Math.floor(Math.random() * 90000 + 10000)) : ctZip,
        state: billingStateRandom ? pickOne(US_STATES) : billingState,
      };

      // —— 卡片池（手动卡优先，否则用户勾选的卡）——
      const cardPool = manualCardData ? [manualCardData] : localCards.filter(c => selectedCardIds.has(c.id || c.card_id || ''));
      const cards = cardPool.map((c: any) => {
        const num = String(c.number || c.cardNumber || '').replace(/\s/g, '');
        let y = String(c.expYear || c.exp_year || '');
        if (y.length === 2) y = '20' + y;
        return {
          number: num,
          holder: c.holderName || c.holder || '',
          expMonth: String(c.expMonth || c.exp_month || '').padStart(2, '0'),
          expYear: y,
          cvv: c.cvv || c.cvc || c.cardCvc || '',
          channel: c.channel || c.chip || 'ali',
          tag: Array.isArray(c.tags) ? c.tags.join(',') : '',
          last4: String(c.last4 || c.card_last4 || num).slice(-4),
        };
      });

      // —— 预检用：各配置的像素情况（原来读 localStorage cache:pixels，这里同样读好后下发）——
      const pixelsByProfile: Record<string, { ok: boolean; name: string; count: number }> = {};
      try {
        const pxArr = JSON.parse(localStorage.getItem('cache:pixels') || '[]');
        if (Array.isArray(pxArr)) {
          pxArr.forEach((px: any) => {
            const pid0 = String(px.profileId || '');
            if (!pid0) return;
            const cur = pixelsByProfile[pid0] || { ok: false, name: '', count: 0 };
            cur.count += 1;
            if (!cur.ok && String(px.status || '').toUpperCase() === 'ACTIVE') { cur.ok = true; cur.name = px.name || px.pixel_id || ''; }
            pixelsByProfile[pid0] = cur;
          });
        }
      } catch {}

      // —— 主页模板：图片先转 base64 再下发（服务端拿不到 File 对象）——
      let pageCfg: any = null;
      if (pageData) {
        const toB64 = async (f: any) => {
          if (!f) return '';
          try {
            const buf = await f.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return 'data:image/jpeg;base64,' + btoa(bin);
          } catch { return ''; }
        };
        pageCfg = {
          name: pageData.name,
          categoryId: CATEGORY_ID_MAP[pageData.category] || '',
          website: pageData.website || '',
          useSession: !!pageData.useSession,
          profileImageBase64: await toB64((pageData as any).profileImage),
          profileImageName: (pageData as any).profileImage?.name || 'profile.jpg',
          coverImageBase64: await toB64((pageData as any).backgroundImage),
          coverImageName: (pageData as any).backgroundImage?.name || 'cover.jpg',
        };
      }

      // —— 代理池（创建主页 / 发布用；结构里带 id，便于事后标记失败代理）——
      const buildProxyPool = (enabled: boolean) => {
        if (!enabled) return [] as any[];
        let pool: any[] = [];
        if (proxySelectedId) {
          const sel = proxyList.find((p: any) => p.id === proxySelectedId);
          if (sel && !proxyFailedIds.has(sel.id)) pool = [sel];
        } else {
          pool = [...filteredProxies].sort((a: any, b: any) => (a.failed_count || 0) - (b.failed_count || 0));
        }
        return pool.map((p: any) => ({
          id: p.id,
          proxy: {
            type: smartProxyType(p), host: p.host, port: p.port,
            username: p.username || '', password: p.password || '',
            provider: p.provider || '', zone: p.zone || '',
            country: p.country || '', city: p.city || '',
            session: p.session || '', rotation: p.rotation || '',
          },
        }));
      };
      const proxyPool = buildProxyPool(enableProxy);

      // —— 发布用：广告内容（含素材 base64）+ 发布代理池 ——
      let publishCfg: any = null;
      if (adPublishData) {
        let mediaBase64 = (adPublishData as any).mediaBase64List?.[0] || '';
        if (!mediaBase64 && (adPublishData as any).campaignTree) {
          for (const c of (adPublishData as any).campaignTree) {
            for (const as of c.adSets || []) {
              for (const a of as.ads || []) { if (a._mediaBase64) { mediaBase64 = a._mediaBase64; break; } }
              if (mediaBase64) break;
            }
            if (mediaBase64) break;
          }
        }
        const { mediaFile: _mediaFilePub, ...pubData } = adPublishData as any;  // File 不能进 JSON
        publishCfg = { data: pubData, mediaBase64, proxyPool: buildProxyPool(publishWithProxy) };
      }

      const items = profileIds.map((pid) => {
        // 只下发属于该配置的广告号（原来是前端按 cache:adaccounts 过滤，这里同样过滤后再下发）
        // 🆕 用 runAccountIds：它包含「刚刚在选中 BM 下建出来的」广告号
        const accs = (runAccountIds || []).filter((aid: string) => {
          const cleanAid = String(aid).replace('act_', '');
          return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === String(pid)
            && String(a.adAccountId || a.account_id || a.id || '').replace('act_', '') === cleanAid);
        });
        return {
          key: String(pid),
          label: String(pid),
          payload: {
            profileId: String(pid),
            steps: bundleSteps,
            adAccountIds: accs,
            // 各广告号当前的国家/货币/时区：服务端据此判断「已经匹配就跳过」（原来读的是本地缓存）
            adAccountMeta: accs.map((aid: string) => {
              const clean = String(aid).replace('act_', '');
              const a = cachedAccounts.find((x: any) => String(x.adAccountId || x.account_id || x.id || '').replace('act_', '') === clean) || {};
              return { adAccountId: clean, currency: a.currency || '', timezone_id: a.timezone_id || '', business_country_code: a.business_country_code || a.country || '' };
            }),
            // 预检所需信息都在前端缓存/状态里，直接下发（服务端不另找数据源）
            precheck: {
              cardsCount: localCards.filter(c => selectedCardIds.has(c.id || c.card_id || '')).length + (manualCardData ? 1 : 0),
              pixelOk: !!pixelsByProfile[String(pid)]?.ok,
              pixelName: pixelsByProfile[String(pid)]?.name || '',
              pixelCount: pixelsByProfile[String(pid)]?.count || 0,
              pageConfigured: !stepEnabled.page || !!pageData,
            },
          },
        };
      });
      try {
        const job = await submitJob({
          type: 'smart_publish_bundle',
          title: `智能发布（${items.length} 个配置 · ${bundleSteps.length} 步）`,
          items,
          // 公共配置（账单参数 / 卡片池 / 主页模板含图片 base64 / 代理池）整批只下发一份，
          // 否则 N 个配置会各存一份图片 base64（几十 MB）到任务表里
          shared: {
            config: {
              lang: ctLang, currency: ctCurrency, timezone_id: ctTimezone, country: ctCountry, paymentAmount,
              billing, cards, cardIterateMode, checkBillingParams,
              spendCap: spendCapAmount,
              page: pageCfg, proxyPool,
              publish: publishCfg,
            },
            // 🚩 失败代理要落到云端（原来前端自己调 /api/proxies/fail）；队列只回传 message，
            //    所以把云端地址 + token 交给服务端，由它直接标记。
            cloud: {
              base: String((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '').replace(/\/$/, '') || (typeof window !== 'undefined' ? window.location.origin : ''),
              token: localStorage.getItem('auth_token') || '',
            },
          },
        });
        addLog(`🧵 已提交执行队列：共 ${items.length} 项，步骤 ${bundleSteps.join(' → ')}`);
        addLog(`   进度与取消请到左侧「执行队列」查看（提交后刷新页面也不会中断）`);
        flushLog();
        await waitForJob(job.id, (j) => {
          if (!j) return;
          if (j.status === 'queued' || j.status === 'running') {
            setProgress({ done: j.done + j.fail, total: j.total, step: 0, totalSteps: activeSteps.length });
          }
        });
        addLog('✅ 队列执行完成（每项的详细结果见「执行队列」）');
        flushLog();
        try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
      } catch (e: any) {
        addLog(`❌ 提交执行队列失败：${e?.message || e}（请确认本机后端 9999 已启动）`);
        flushLog();
      }
      setRunning(false);
      return;
    }

    try {
      // 🚀 同步系统设置的并发数到后端 LaunchQueue
      try {
        const browserSettingsStr = localStorage.getItem('settings:browserSettings');
        if (browserSettingsStr) {
          const bs = JSON.parse(browserSettingsStr);
          if (bs.maxConcurrentLaunches) {
            await fetch(`${puppeteerBase}/config`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
              body: JSON.stringify({ maxConcurrentLaunches: bs.maxConcurrentLaunches })
            });
            addLog(`📊 并发数同步: ${bs.maxConcurrentLaunches}`);
          }
        }
      } catch {}

      // 🚀 Per-profile 持久化状态（随机地址等在 billing 步骤生成，供 card/publish 使用）
      const profileBillingState = new Map<string, { street: string; city: string; zip: string; state: string }>();

      // 🚀 信号量并发：最多 CONCURRENCY 个 profile 同时跑，快的先出、慢的后出，自动填补
      const CONCURRENCY = 3;
      const runConcurrent = async <T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<void> => {
        const queue = [...items];
        let active = 0;
        let completed = 0;
        let doneResolve: (() => void) | null = null;
        const total = items.length;
        const tryComplete = () => {
          if (completed >= total && doneResolve) { doneResolve(); doneResolve = null; }
        };
        const startNext = () => {
          while (active < limit && queue.length > 0) {
            const item = queue.shift()!;
            active++;
            worker(item).finally(() => {
              active--;
              completed++;
              tryComplete();
              startNext();
            });
          }
        };
        await new Promise<void>(resolve => {
          doneResolve = resolve;
          startNext();
          tryComplete();
        });
      };

      await runConcurrent(profileIds, CONCURRENCY, async (pid) => {
        // 预检失败的配置，跳过后续所有步骤
        if (skippedPids.has(pid)) {
          setProgress(prev => ({ ...prev, done: prev.done + 1 }));
          return;
        }

        // 跳过标志
        let shouldSkipCardForProfile = false;

        // 当前 profile 的账单地址（由 billing 步骤生成，供 card/publish 使用）
        if (!profileBillingState.has(pid)) profileBillingState.set(pid, { street: '', city: '', zip: '', state: '' });

        // 🚀 加载缓存的广告账户数据（按 profile 过滤 adAccountIds 时使用）
        const cachedAccounts: any[] = JSON.parse(localStorage.getItem('cache:adaccounts') || '[]');

        // 🚀 该 profile 依次执行所有步骤
        //    ⚠️ 用 bundleSteps 而不是 activeSteps：「创建BM」已在上面作为独立队列任务跑完了，
        //       这条前端流程不认识它，留在序列里只会被当成未知步骤。
        stepsLoop: for (let si = 0; si < bundleSteps.length; si++) {
          const sk = bundleSteps[si];
          setProgress(prev => ({ ...prev, step: si, totalSteps: bundleSteps.length }));
          if (sk !== 'precheck') addLog(`[${pid}] 步骤 ${si+1}/${bundleSteps.length}: ${stepDefs[sk].label}...`);

          const billState = profileBillingState.get(pid)!;
          let billingStreet = billState.street, billingCity = billState.city, billingZip = billState.zip, billingState = billState.state;

          // 🚀 通用：启动浏览器并注入 Cookie（供 billing / lang / card 步骤使用）
          const ensureBrowserForStep = async () => {
            if (sk === 'page' || sk === 'fetchInfo' || sk === 'precheck') return; // 这些步骤有自己的启动逻辑
            try {
              const checkR = await fetch(`${puppeteerBase}/facebook/adaccounts/status`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid })
              });
              const checkJ = await checkR.json();
              if (checkJ.status === 'running' || checkJ.success) return;
            } catch {}
            let stepCookies = '';
            try {
              const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
              const base = String(serverUrl || '').replace(/\/$/, '');
              const authToken = localStorage.getItem('auth_token');
              const pfR = await fetch(`${base}/api/profiles`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
              });
              if (pfR.ok) {
                const pfJ = await pfR.json();
                const profiles = Array.isArray(pfJ) ? pfJ : (pfJ.data || pfJ.results || []);
                const found = profiles.find((p: any) => String(p.id) === pid || String(p.extId) === pid);
                if (found && found.account?.cookies) {
                  stepCookies = typeof found.account.cookies === 'string' ? found.account.cookies : JSON.stringify(found.account.cookies);
                }
              }
            } catch {}
            try {
              await fetch(`${puppeteerBase}/launch-browser`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid, cookies: stepCookies || undefined })
              });
              addLog(`  ✅ 浏览器已启动`);
              await new Promise(r => setTimeout(r, 3000));
            } catch { addLog(`  ⚠️ 启动浏览器失败`); }
          };

          // ===== 获取信息（可选，默认启用） =====
          if (sk === 'fetchInfo') {
            addLog(`  >>> 加载 Profile Cookie...`);
            let profileCookies = '';
            try {
              const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
              const base = String(serverUrl || '').replace(/\/$/, '');
              const authToken = localStorage.getItem('auth_token');
              const pfR = await fetch(`${base}/api/profiles`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
              });
              if (pfR.ok) {
                const pfJ = await pfR.json();
                const profiles = Array.isArray(pfJ) ? pfJ : (pfJ.data || pfJ.results || []);
                const found = profiles.find((p: any) => String(p.id) === pid || String(p.extId) === pid);
                if (found && found.account?.cookies) {
                  profileCookies = typeof found.account.cookies === 'string' ? found.account.cookies : JSON.stringify(found.account.cookies);
                  addLog(`  ✅ 已加载 Cookie: ${profileCookies.substring(0, 30)}...`);
                }
              }
            } catch { addLog(`  ⚠️ 未获取到远程 Cookie`); }

            addLog(`  >>> 启动浏览器...`);
            try {
              const lbR = await fetch(`${puppeteerBase}/launch-browser`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid, cookies: profileCookies || undefined })
              });
              const lbJ = await lbR.json();
              if (!lbJ.success) {
                addLog(`  ⚠️ 启动浏览器失败: ${lbJ.message || '未知'}`);
                continue;
              }
              addLog(`  ✅ 浏览器已启动`);
            } catch (e: any) { addLog(`  ⚠️ 启动浏览器异常: ${e.message}`); }

            await new Promise(r => setTimeout(r, 3000));

            addLog(`  >>> 获取信息中...`);
            try {
              const fetchR = await fetch(`${puppeteerBase}/facebook/fetch-adaccounts-graph`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid, accessToken: 'BROWSER' })
              });
              const fetchJ = await fetchR.json();
              if (fetchJ.success) {
                addLog(`  ✅ 获取信息成功: 广告号=${fetchJ.count||0} 主页=${fetchJ.pagesCount||0} 像素=${fetchJ.pixelsCount||0}`);
                window.dispatchEvent(new CustomEvent('adaccounts-refresh'));
                window.dispatchEvent(new CustomEvent('pages-refresh'));
                window.dispatchEvent(new CustomEvent('pixels-refresh'));
              } else {
                addLog(`  ⚠️ 获取信息结果: ${fetchJ.message || '未知'}`);
              }
            } catch (e: any) { addLog(`  ⚠️ 获取信息异常: ${e.message}`); }

            // 🚀 关闭浏览器释放资源
            try {
              await fetch(`${puppeteerBase}/facebook/close-browser`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid })
              });
              addLog(`  ✅ 浏览器已关闭`);
            } catch (closeErr) { /* ignore */ }
            continue;
          }

          // ===== 预检获取信息 =====
          if (sk === 'precheck') {
            const targets = (adAccountIds?.length ? adAccountIds : []).filter((aid: string) => {
              const cleanAid = aid.replace('act_', '');
              return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
            });
            if (targets.length === 0) { addLog(`  [${pid}] 无可处理的广告号`); continue; }
            const results: PrecheckItem[] = [];

            for (const accId of targets) {
              addLog(`  [${accId}] 正在预检...`);
              const item: PrecheckItem = {
                adAccountId: accId,
                accountStatus: 'unknown',
                accountStatusLabel: '未知',
                hasCards: false,
                cardsCount: 0,
                pixelOk: false,
                pixelName: '',
                pixelCount: 0,
                passed: false,
              };
              try {
                const r = await fetch(`${puppeteerBase}/facebook/billing/list-methods`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid, adAccountId: accId })
                });
                const j = await r.json();
                if (j.status === 'no_browser') item.accountStatusLabel = '浏览器未运行';
                else if (j.status === 'not_logged_in') item.accountStatusLabel = '未登录';
                else if (j.success) { item.accountStatus = '1'; item.accountStatusLabel = '正常(账单页可访问)'; }
                else item.accountStatusLabel = '账单页访问异常';
              } catch (e: any) { addLog(`  查询账单状态异常: ${e.message}`); }
              const selectedCards = cardList;
              item.cardsCount = selectedCards.length + (manualCardData ? 1 : 0);
              item.hasCards = item.cardsCount > 0;
              try {
                const pixelsRaw = localStorage.getItem('cache:pixels');
                if (pixelsRaw) {
                  const pixelsList = JSON.parse(pixelsRaw);
                  if (Array.isArray(pixelsList)) {
                    const profilePixels = pixelsList.filter((px: any) => String(px.profileId || '') === String(pid));
                    const active = profilePixels.find((px: any) => String(px.status || '').toUpperCase() === 'ACTIVE');
                    if (active) { item.pixelOk = true; item.pixelName = active.name || active.pixel_id || ''; item.pixelCount = profilePixels.length; }
                    else item.pixelCount = profilePixels.length;
                  }
                }
              } catch {}
              let pageOk = true, pageFailReason = '';
              if (stepEnabled.page) { if (!pageData) { pageOk = false; pageFailReason = '未配置主页模板'; } }
              item.passed = item.accountStatus === '1' && item.hasCards && item.pixelOk && pageOk;
              results.push(item);
              const icon = item.passed ? '✅' : '❌';
              addLog(`  ${icon} ${accId} | 状态: ${item.accountStatusLabel} | 卡片: ${item.cardsCount}张 | 像素: ${item.pixelOk ? `正常(${item.pixelName})` : '无'}${pageFailReason ? ` | 主页: ❌${pageFailReason}` : ''}`);
            }

            setPrecheckResults(prev => ({ ...prev, [pid]: results }));

            const allPassed = results.every(r => r.passed);
            if (!allPassed) {
              skippedPids.add(pid);
              const failReasons: string[] = [];
              results.forEach(r => {
                if (r.accountStatus !== '1') failReasons.push(`${r.adAccountId}:账户状态`);
                if (!r.hasCards) failReasons.push(`${r.adAccountId}:无卡片`);
                if (!r.pixelOk) failReasons.push(`${r.adAccountId}:无有效像素`);
              });
              if (stepEnabled.page && !pageData) failReasons.push('主页未配置');
              addLog(`  ⛔ 预检未全部通过，跳过该配置的后续步骤 (${failReasons.join(', ')})`);
            } else {
              addLog(`  ✅ 预检全部通过`);
            }
            continue;
          }

          // ===== 创建主页 =====
          if (sk === 'page' && pageData) {
            const catId = CATEGORY_ID_MAP[pageData.category] || '';
            if (!catId) {
              addLog(`  [${pid}] ⛔ 类别 "${pageData.category}" 没有对应的 Facebook 类别ID`);
              continue;
            }

            // 🚀 构建代理池（先于浏览器启动，有代理时传递给浏览器）
            let proxyPool: any[] = [];
            if (enableProxy) {
              if (proxySelectedId) {
                const sel = proxyList.find((p: any) => p.id === proxySelectedId);
                if (sel && !proxyFailedIds.has(sel.id)) proxyPool = [sel];
              } else {
                proxyPool = [...filteredProxies].sort((a: any, b: any) => (a.failed_count||0) - (b.failed_count||0));
              }
            }
            if (enableProxy && proxyPool.length === 0) {
              addLog(`  [${pid}] ⛔ 无可用的代理`);
              continue;
            }

            let pubCookies = '';
            try {
              const serverUrl2 = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
              const base2 = String(serverUrl2 || '').replace(/\/$/, '');
              const authToken2 = localStorage.getItem('auth_token');
              const pfR2 = await fetch(`${base2}/api/profiles`, {
                headers: { 'Authorization': `Bearer ${authToken2}` }
              });
              if (pfR2.ok) {
                const pfJ2 = await pfR2.json();
                const profiles2 = Array.isArray(pfJ2) ? pfJ2 : (pfJ2.data || pfJ2.results || []);
                const found2 = profiles2.find((p: any) => String(p.id) === pid || String(p.extId) === pid);
                if (found2 && found2.account?.cookies) {
                  pubCookies = typeof found2.account.cookies === 'string' ? found2.account.cookies : JSON.stringify(found2.account.cookies);
                }
              }
            } catch {}

            // 🚀 Session模式（useSession=true）不需要浏览器，直接走 API 创建
            //    非Session模式（useSession=false）需要启动浏览器手动创建，代理传入浏览器启动
            if (!pageData.useSession) {
              // 非 Session 模式：先构造代理覆盖参数
              let pageProxyOverride: any = undefined;
              if (proxyPool.length > 0) {
                const firstProxy = proxyPool[0];
                pageProxyOverride = {
                  type: smartProxyType(firstProxy), host: firstProxy.host, port: firstProxy.port,
                  username: firstProxy.username || '', password: firstProxy.password || '',
                  provider: firstProxy.provider || '', zone: firstProxy.zone || '',
                  country: firstProxy.country || '', city: firstProxy.city || '',
                  session: firstProxy.session || '', rotation: firstProxy.rotation || '',
                };
              }
              try {
                const launchBody: any = { profileId: pid, cookies: pubCookies || undefined };
                if (pageProxyOverride) launchBody.proxyOverride = pageProxyOverride;
                await fetch(`${puppeteerBase}/launch-browser`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify(launchBody)
                });
                addLog(`  ✅ 浏览器已启动${pageProxyOverride ? ' (使用代理)' : ''}`);
                await new Promise(r => setTimeout(r, 3000));
              } catch { addLog(`  ⚠️ 启动浏览器失败，尝试继续...`); }
            }

            let profileBase64 = '', profileName = '', coverBase64 = '', coverName = '';
            try {
              if (pageData.profileImage) {
                const buf = await pageData.profileImage.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                profileBase64 = 'data:image/jpeg;base64,' + btoa(binary);
                profileName = pageData.profileImage.name || 'profile.jpg';
              }
            } catch { addLog('  ⚠️ 头像图片编码失败'); }
            try {
              if (pageData.backgroundImage) {
                const buf = await pageData.backgroundImage.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                coverBase64 = 'data:image/jpeg;base64,' + btoa(binary);
                coverName = pageData.backgroundImage.name || 'cover.jpg';
              }
            } catch { addLog('  ⚠️ 背景图编码失败'); }
            
            const attempts = proxyPool.length > 0 ? proxyPool : [null];
            let ok = false;
            for (const proxy of attempts) {
              if (ok) break;
              const label = proxy ? `${proxy.host}:${proxy.port}(${smartProxyType(proxy)})` : '无代理';
              try {
                addLog(`  创建主页: ${pageData.name} (类别ID=${catId}) [代理: ${label}]${pageData.useSession ? ' [Session模式]' : ''}`);
                const body: any = { profileId: pid, name: pageData.name, categoryId: catId, bio: '', website: pageData.website || '' };
                if (profileBase64) { body.profileImageBase64 = profileBase64; body.profileImageName = profileName; }
                if (coverBase64) { body.coverImageBase64 = coverBase64; body.coverImageName = coverName; }
                if (proxy) {
                  body.proxyOverride = {
                    type: smartProxyType(proxy), host: proxy.host, port: proxy.port,
                    username: proxy.username || '', password: proxy.password || '',
                    provider: proxy.provider || '', zone: proxy.zone || '',
                    country: proxy.country || '', city: proxy.city || '',
                    session: proxy.session || '', rotation: proxy.rotation || '',
                  };
                }
                const r = await fetch(`${puppeteerBase}/facebook/page/create`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify(body)
                });
                const j = await r.json();
                if (j.success) { addLog(`  ✅ 主页创建成功: ID=${j.pageId}`); ok = true; }
                else {
                  addLog(`  ❌ ${j.message || j.raw?.error_user_title || j.raw?.message || '创建失败'}`);
                  if (proxy?.id) await markProxyFailed(proxy.id);
                  if (!ok) { addLog(`  等待 30 秒后重试...`); await new Promise(r => setTimeout(r, 30000)); }
                }
              } catch (e: any) {
                addLog(`  ❌ ${e.message}`);
                if (proxy?.id) await markProxyFailed(proxy.id);
                if (!ok) { addLog(`  等待 30 秒后重试...`); await new Promise(r => setTimeout(r, 30000)); }
              }
            }
            if (!ok) addLog(`  ⛔ 所有代理尝试均失败`);
          }

          // ===== 获取 Token =====
          if (sk === 'token') {
            const targets = adAccountIds?.length ? adAccountIds : [];
            if (targets.length === 0) { addLog(`  无广告号`); return; }
            try {
              addLog(`  >>> 通过浏览器获取 Token...`);
              const r = await fetch(`${puppeteerBase}/facebook/fetch-adaccounts-graph`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid, accessToken: 'BROWSER' })
              });
              const j = await r.json();
              if (j.success) {
                addLog(`  ✅ Token 获取成功: ${j.message || ''}`);
                window.dispatchEvent(new CustomEvent('adaccounts-refresh'));
              } else {
                addLog(`  ⚠️ 获取 Token 失败: ${j.message || '未知'}`);
              }
            } catch (e: any) { addLog(`  ❌ 获取 Token 异常: ${e.message}`); }
            return;
          }

          if (sk === 'billing') {
            // 🐛 修复：过滤出属于当前 profile 的 adAccountId
            const targets = (adAccountIds?.length ? adAccountIds : []).filter((aid: string) => {
              const cleanAid = aid.replace('act_', '');
              return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
            });
            if (targets.length === 0) { addLog(`  [${pid}] 无可处理的广告号`); continue; }
            await ensureBrowserForStep();
            const accCheck = (tid: string) => {
              const actId = tid.replace('act_', '');
              const found = cachedAccounts.find((a: any) => String(a.account_id || a.id || '').replace('act_','') === actId);
              if (!found) return null;
              const ccyOk = String(found.currency || '').toUpperCase() === String(ctCurrency || '').toUpperCase();
              const tzOk = String(found.timezone_id || '') === String(ctTimezone || '');
              const countryOk = String(found.business_country_code || '').toUpperCase() === String(ctCountry || '').toUpperCase();
              return { ccyOk, tzOk, countryOk, allOk: ccyOk && tzOk && countryOk };
            };
            // 随机地址生成
            const randomStreet = () => {
              const streets = ['Main St','Oak Ave','Elm St','Park Rd','Broadway','Lake Dr','Hill St','Cedar Ln','Maple Ave','River Rd','Pine St','Washington Blvd','Sunset Blvd','Madison Ave','Lincoln St'];
              return `${Math.floor(Math.random()*9000+1000)} ${streets[Math.floor(Math.random()*streets.length)]}`;
            };
            const randomCity = () => {
              const cities = ['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio','San Diego','Dallas','Austin','Miami','Denver','Boston','Seattle','Atlanta'];
              return cities[Math.floor(Math.random()*cities.length)];
            };
            const randomZip = () => String(Math.floor(Math.random()*90000+10000));
            const randomState = () => US_STATES[Math.floor(Math.random()*US_STATES.length)];
            billingStreet = ctAddressRandom ? randomStreet() : ctAddress;
            billingCity = ctCityRandom ? randomCity() : ctCity;
            billingZip = ctZipRandom ? randomZip() : ctZip;
            billingState = billingStateRandom ? randomState() : billingState;
            // 🚀 保存到持久化状态，确保 card/publish 步骤能读取到此值
            billState.street = billingStreet; billState.city = billingCity; billState.zip = billingZip; billState.state = billingState;
            // 🚀 批量提交：一次性传入所有广告号，后端并行处理
            const needUpdate = targets.filter((accId: string) => {
              const check = accCheck(accId);
              if (check && check.allOk) {
                addLog(`  ${accId}: 货币/时区/国家已是 ${ctCurrency}/${ctTimezone}/${ctCountry}，跳过`);
                return false;
              }
              if (check) {
                const parts: string[] = [];
                if (check.countryOk) parts.push('国家');
                if (check.ccyOk) parts.push('货币');
                if (check.tzOk) parts.push('时区');
                addLog(`  ${accId}: 部分已匹配(${parts.join('/')})，更新剩余字段`);
              }
              return true;
            });
            if (needUpdate.length > 0) {
              addLog(`  🚀 批量提交 ${needUpdate.length} 个广告号...`);
              try {
                const r = await fetch(`${puppeteerBase}/facebook/adaccounts/change-currency-timezone`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid, adAccountIds: needUpdate, currency: ctCurrency, timezone_id: ctTimezone, country: ctCountry, lang: ctLang, address: billingStreet, city: billingCity, zip: billingZip, state: billingState, business_name: ctBusinessName || undefined })
                });
                const j = await r.json();
                if (j.loginFailed) {
                  addLog(`  🚫 Token 已过期，停止该配置剩余步骤`);
                  try { await fetch(`${puppeteerBase}/facebook/close-browser`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                    body: JSON.stringify({ profileId: pid })
                  }); } catch {}
                  break stepsLoop;
                }
                if (j.results && Array.isArray(j.results)) {
                  for (const res of j.results) {
                    addLog(`  ${res.adAccountId}: ${res.success ? '✅' : '❌'} ${res.message || ''}`);
                  }
                }
                addLog(`  批量完成: ${j.completed || 0}/${j.total || needUpdate.length} 成功`);
              } catch (e: any) { addLog(`  批量异常: ${e.message}`); }
            } else {
              addLog(`  所有广告号已是最新，无需修改`);
            }
          }

          // ===== 修改界面语言（单独步骤，不修改账单） =====
          if (sk === 'lang') {
            const targets = (adAccountIds?.length ? adAccountIds : []).filter((aid: string) => {
              const cleanAid = aid.replace('act_', '');
              return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
            });
            if (targets.length === 0) { addLog(`  [${pid}] 无可处理的广告号`); continue; }
            await ensureBrowserForStep();
            for (const accId of targets) {
              try {
                const r = await fetch(`${puppeteerBase}/facebook/adaccounts/change-currency-timezone`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid, adAccountId: accId, lang: ctLang })
                });
                const j = await r.json();
                if (j.loginFailed) {
                  addLog(`  🚫 ${accId}: Token 已过期，停止该配置剩余步骤`);
                  try { await fetch(`${puppeteerBase}/facebook/close-browser`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                    body: JSON.stringify({ profileId: pid })
                  }); } catch {}
                  break stepsLoop;
                }
                addLog(`  ${accId}: ${j.success ? '✅' : '❌'} 语言=${ctLang}`);
              } catch (e: any) { addLog(`  ${accId} 异常: ${e.message}`); }
            }
            continue;
          }

          // ===== 手动付款 =====
          if (sk === 'payment') {
            const targets = (adAccountIds?.length ? adAccountIds : []).filter((aid: string) => {
              const cleanAid = aid.replace('act_', '');
              return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
            });
            if (targets.length === 0) { addLog(`  [${pid}] 无可处理的广告号`); continue; }
            await ensureBrowserForStep();
            const amt = paymentAmount?.trim() || '';
            for (const accId of targets) {
              try {
                addLog(`  ${accId}: 开始手动付款 $${amt}...`);
                const r = await fetch(`${puppeteerBase}/facebook/billing/manual-payment`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid, adAccountId: accId, amount: amt })
                });
                const j = await r.json();
                if (j.loginFailed) {
                  addLog(`  🚫 ${accId}: Token 已过期，停止该配置剩余步骤`);
                  try { await fetch(`${puppeteerBase}/facebook/close-browser`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                    body: JSON.stringify({ profileId: pid })
                  }); } catch {}
                  break stepsLoop;
                }
                addLog(`  ${accId}: ${j.success ? '✅' : '❌'} ${j.message || ''}`);
              } catch (e: any) { addLog(`  ${accId} 异常: ${e.message}`); }
            }
            continue;
          }

          // ===== 检查已有卡片 =====
          if (sk === 'checkCard') {
            const targets = (adAccountIds?.length ? adAccountIds : []).filter((aid: string) => {
              const cleanAid = aid.replace('act_', '');
              return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
            });
            if (targets.length === 0) { addLog(`  [${pid}] 无可处理的广告号`); continue; }
            await ensureBrowserForStep();
            let anyCardExists = false;
            for (const accId of targets) {
              try {
                const r = await fetch(`${puppeteerBase}/facebook/billing/cards`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid, adAccountId: accId })
                });
                const j = await r.json();
                if (j.loginFailed) {
                  addLog(`  🚫 ${accId}: Token 已过期，停止该配置剩余步骤`);
                  try { await fetch(`${puppeteerBase}/facebook/close-browser`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                    body: JSON.stringify({ profileId: pid })
                  }); } catch {}
                  break stepsLoop;
                }
                if (j.success && j.methods && j.methods.length > 0) {
                  addLog(`  ✅ ${accId}: 检查发现已有 ${j.methods.length} 张卡片`);
                  anyCardExists = true;
                } else {
                  addLog(`  ℹ️ ${accId}: 检查未发现卡片`);
                }
              } catch (e: any) { addLog(`  ${accId} 检查异常: ${e.message}`); }
            }
            if (anyCardExists) {
              shouldSkipCardForProfile = true;
              addLog(`  🚀 已标记该配置后续跳过绑卡步骤`);
            }
            continue;
          }

          // ===== 检查登录状态 =====
          if (sk === 'checkLogin') {
            addLog(`  🚀 启动浏览器检查登录状态...`);
            try {
              await fetch(`${puppeteerBase}/launch-browser`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid })
              });
              await new Promise(r => setTimeout(r, 5000));
            } catch (e: any) {
              addLog(`  ⚠️ 启动浏览器失败: ${e.message}`);
              try { await fetch(`${puppeteerBase}/facebook/close-browser`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid })
              }); } catch {}
              break stepsLoop;
            }

            // 第1次检查
            let loginOk = false;
            try {
              const r1 = await fetch(`${puppeteerBase}/facebook/check-login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ profileId: pid })
              });
              const j1 = await r1.json();
              loginOk = j1.loggedIn;
              if (loginOk) addLog(`  ✅ 登录状态正常`);
            } catch (e: any) { addLog(`  ⚠️ 登录检查异常: ${e.message}`); }

            // 未登录 → 自动填密码1次
            if (!loginOk) {
              addLog(`  ⚠️ 未登录，尝试自动登录...`);
              try {
                await fetch(`${puppeteerBase}/facebook/auto-login`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid })
                });
                await new Promise(r => setTimeout(r, 8000));
                const r2 = await fetch(`${puppeteerBase}/facebook/check-login`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid })
                });
                const j2 = await r2.json();
                loginOk = j2.loggedIn;
                if (loginOk) addLog(`  ✅ 自动登录成功`);
                else addLog(`  🚫 自动登录失败`);
              } catch (e: any) { addLog(`  ⚠️ 自动登录异常: ${e.message}`); }
            }

            // 关闭浏览器释放空位
            try { await fetch(`${puppeteerBase}/facebook/close-browser`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
              body: JSON.stringify({ profileId: pid })
            }); } catch {}

            if (!loginOk) {
              addLog(`  🚫 登录失败，停止该配置剩余步骤`);
              break stepsLoop;
            }
            continue;
          }

          // ===== 检查已有广告 =====
          if (sk === 'checkAd') {
            const targets = (adAccountIds?.length ? adAccountIds : []).filter((aid: string) => {
              const cleanAid = aid.replace('act_', '');
              return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
            });
            if (targets.length === 0) { addLog(`  [${pid}] 无可处理的广告号`); continue; }
            let foundAd = false;
            for (const accId of targets) {
              try {
                const r = await fetch(`${puppeteerBase}/facebook/publish-ad`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid, adAccountId: accId, skipIfAdExists: true, onlyCheck: true })
                });
                const j = await r.json();
                if (j.loginFailed) {
                  addLog(`  🚫 ${accId}: ${j.message || '登录已过期，请重新登录'}`);
                  foundAd = true;
                } else if (j.success && j.skipped) {
                  addLog(`  🛑 ${accId}: 检查发现已有广告`);
                  foundAd = true;
                } else {
                  addLog(`  ℹ️ ${accId}: 检查未发现广告`);
                }
              } catch (e: any) { addLog(`  ${accId} 检查异常: ${e.message}`); }
            }
            if (foundAd) {
              addLog(`  🛑 有广告号存在已有广告，停止该配置剩余步骤`);
              break stepsLoop;
            }
            continue;
          }

          if (sk === 'card') {
            if (shouldSkipCardForProfile) {
              addLog(`  ⏭️ 检查发现已有卡片，跳过绑卡步骤`);
              continue;
            }
            const targets = (adAccountIds?.length ? adAccountIds : []).filter((aid: string) => {
              const cleanAid = aid.replace('act_', '');
              return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
            });
            if (targets.length === 0) { addLog(`  [${pid}] 无可处理的广告号`); continue; }
            await ensureBrowserForStep();
            const pool = manualCardData ? [manualCardData] : cardList;
            if (pool.length === 0) { addLog(`  未选择卡片`); continue; }
            let cardLoginFailed = false;
            const doBind = async (cid: string, card: any) => {
              try {
                const ccNumber = card.number?.replace(/\s/g,'') || card.cardNumber?.replace(/\s/g,'') || '';
                const ccMonth = String(card.expMonth || card.exp_month || '').padStart(2,'0');
                let ccYear = String(card.expYear || card.exp_year || '');
                if (ccYear.length === 2) ccYear = '20' + ccYear;
                const ccCVC = card.cvv || card.cvc || card.cardCvc || '';
                // 复用批量操作的 /api/facebook/billing/add
                const r = await fetch(`${puppeteerBase}/facebook/billing/add`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({
                    profileId: pid, adAccountId: cid,
                    mode: 'manual',
                    card: {
                      number: ccNumber,
                      holder: card.holderName || card.holder || '',
                      exp_month: ccMonth,
                      exp_year: ccYear,
                      cvv: ccCVC,
                      billing_address: billingStreet,
                      city: billingCity,
                      zip: billingZip,
                      state: billingState,
                      country_code: ctCountry
                    },
                    channel: card.channel || card.chip || 'ali',
                    tag: card.tags?.join(',') || '',
                    currency: ctCurrency,
                    timezone_id: ctTimezone,
                    country_code: ctCountry,
                    checkBillingParams,
                  })
                });
                const j = await r.json();
                if (j.loginFailed) {
                  addLog(`  🚫 ${cid}: Token 已过期，停止该配置剩余步骤`);
                  try { await fetch(`${puppeteerBase}/facebook/close-browser`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                    body: JSON.stringify({ profileId: pid })
                  }); } catch {}
                  cardLoginFailed = true;
                  return;
                }
                addLog(`  ${cid}: ${j.success ? '✅' : '❌'} ${j.message || ''}`);
              } catch (e: any) { addLog(`  ${cid} 异常: ${e.message}`); }
            };
            if (cardIterateMode === 'cycle') {
              for (let ci = 0; ci < targets.length; ci++) {
                if (cardLoginFailed) break;
                await doBind(targets[ci], pool[ci % pool.length]);
              }
            } else {
              for (const accId of targets) {
                if (cardLoginFailed) break;
                let bound = false;
                for (const card of pool) {
                  if (bound) break;
                  await doBind(accId, card);
                  // 检查绑卡是否成功（使用轻量卡号 API）
                  const j = await (await fetch(`${puppeteerBase}/facebook/billing/cards`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                    body: JSON.stringify({ profileId: pid, adAccountId: accId })
                  })).json();
                  const ok = (j.methods || []).some((m: any) => {
                    const ml4 = (m.last4 || '').slice(-4);
                    const cl4 = (card.last4 || card.card_last4 || card.number || '').slice(-4);
                    return ml4 && cl4 && ml4 === cl4;
                  });
                  if (ok) { addLog(`  ✅ ${accId} 绑卡成功`); bound = true; break; }
                  else { addLog(`  ${accId}: 该卡未生效，尝试下一张...`); await new Promise(r => setTimeout(r, 5000)); }
                }
                // 每个广告号绑卡完成后关闭浏览器（如果下个步骤是发布则不关，减少重复启动）
                const nextStep = activeSteps[si + 1];
                const hasPublishNext = nextStep === 'publish';
                if (!hasPublishNext) {
                  try { await fetch(`${puppeteerBase}/api/stop-browser`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET }, body: JSON.stringify({ profileId: pid }) }); addLog(`  🔒 ${accId} 浏览器已关闭`); } catch {}
                } else {
                  addLog(`  🚀 ${accId} 绑卡完成，浏览器保持打开以继续发布`);
                }
              }
            }
            if (cardLoginFailed) break stepsLoop;
          }

          if (sk === 'spendCap') {
            // 💰 绑卡后设置账户花费上限（spend_cap）：按账户货币原值提交
            const targets = (adAccountIds?.length ? adAccountIds : []).filter((aid: string) => {
              const cleanAid = String(aid).replace('act_', '');
              return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
            });
            if (targets.length === 0) { addLog(`  [${pid}] 无可处理的广告号`); continue; }
            const capRaw = String(spendCapAmount || '').trim();
            const cap = Number(capRaw);
            if (capRaw === '' || !Number.isFinite(cap) || cap < 0) { addLog(`  限额数值无效：${capRaw || '(空)'}`); continue; }
            await ensureBrowserForStep();
            let capLoginFailed = false;
            for (const cid of targets) {
              if (capLoginFailed) break;
              try {
                const r = await fetch(`${puppeteerBase}/facebook/adaccounts/spend-cap`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify({ profileId: pid, adAccountId: cid, spend_cap: cap, currency: ctCurrency })
                });
                const j = await r.json();
                if (j && j.loginFailed) {
                  addLog(`  🚫 ${cid}: Token 已过期，停止该配置剩余步骤`);
                  try { await fetch(`${puppeteerBase}/facebook/close-browser`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET }, body: JSON.stringify({ profileId: pid }) }); } catch {}
                  capLoginFailed = true;
                  break;
                }
                addLog(`  ${cid}: 限额=${cap} ${j && j.success ? '✅' : `❌ ${(j && j.message) || ''}`}`);
              } catch (e: any) { addLog(`  ${cid} 异常: ${e.message}`); }
            }
            if (capLoginFailed) break stepsLoop;
          }

          if (sk === 'publish' && adPublishData) {
            // 代理池构建
            let proxyPool: any[] = [];
            if (publishWithProxy) {
              if (proxySelectedId) {
                const sel = proxyList.find((p: any) => p.id === proxySelectedId);
                if (sel && !proxyFailedIds.has(sel.id)) proxyPool = [sel];
              } else {
                proxyPool = [...filteredProxies].sort((a: any, b: any) => (a.failed_count||0) - (b.failed_count||0));
              }
            }
            if (publishWithProxy && proxyPool.length === 0) {
              addLog(`  [${pid}] ⛔ 无可用的代理`);
              return;
            }
            const pubAttempts = proxyPool.length > 0 ? proxyPool : [null];
            let pubOk = false;
            for (const proxy of pubAttempts) {
              if (pubOk) break;
              const label = proxy ? `${proxy.host}:${proxy.port}(${smartProxyType(proxy)})` : '无代理';
              addLog(`  发布广告... [代理: ${label}]`);
              try {
                let mediaBase64 = '';
                if (adPublishData.mediaBase64List?.length) {
                  mediaBase64 = adPublishData.mediaBase64List[0];
                }
                if (!mediaBase64 && adPublishData.campaignTree) {
                  for (const c of adPublishData.campaignTree) {
                    for (const as of c.adSets || []) {
                      for (const a of as.ads || []) {
                        if (a._mediaBase64) { mediaBase64 = a._mediaBase64; break; }
                      }
                      if (mediaBase64) break;
                    }
                    if (mediaBase64) break;
                  }
                }
                const method = adPublishData.publishMethod || 'api';
                const body: any = {
                  ...adPublishData,
                  publishMethod: method,
                  campaignTree: adPublishData.campaignTree,
                  campaignCount: adPublishData.campaignCount || 1,
                  adSetCount: adPublishData.adSetCount || 1,
                  adCount: adPublishData.adCount || 1,
                  mediaBase64,
                  mediaFile: undefined,
                  profileId: pid,
                  adAccountId: (adAccountIds || []).find((aid: string) => {
                    const cleanAid = aid.replace('act_', '');
                    return cachedAccounts.some((a: any) => String(a.profileId || a.profile_id || '') === pid && (String(a.adAccountId || a.account_id || a.id || '').replace('act_','') === cleanAid));
                  }) || '',
                };
                if (proxy) {
                  body.proxyOverride = {
                    type: smartProxyType(proxy),
                    host: proxy.host,
                    port: proxy.port,
                    username: proxy.username || '',
                    password: proxy.password || '',
                    provider: proxy.provider || '',
                    zone: proxy.zone || '',
                    country: proxy.country || '',
                    city: proxy.city || '',
                    session: proxy.session || '',
                    rotation: proxy.rotation || '',
                  };
                }
                if (method === 'puppeteer' || adPublishData.launchBrowser) {
                  let pubCookies = '';
                  try {
                    const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
                    const base = String(serverUrl || '').replace(/\/$/, '');
                    const authToken = localStorage.getItem('auth_token');
                    const pfR = await fetch(`${base}/api/profiles`, {
                      headers: { 'Authorization': `Bearer ${authToken}` }
                    });
                    if (pfR.ok) {
                      const pfJ = await pfR.json();
                      const profiles = Array.isArray(pfJ) ? pfJ : (pfJ.data || pfJ.results || []);
                      const found = profiles.find((p: any) => String(p.id) === pid || String(p.extId) === pid);
                      if (found && found.account?.cookies) {
                        pubCookies = typeof found.account.cookies === 'string' ? found.account.cookies : JSON.stringify(found.account.cookies);
                      }
                    }
                  } catch {}
                  try {
                    await fetch(`${puppeteerBase}/launch-browser`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                      body: JSON.stringify({ profileId: pid, proxyOverride: body.proxyOverride, cookies: pubCookies || undefined })
                    });
                  } catch {}
                }
                const r = await fetch(`${puppeteerBase}/facebook/publish-ad`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                  body: JSON.stringify(body)
                });
                const j = await r.json();
                if (j.success) {
                  if (j.skipped) {
                    addLog(`  ⏭️ 发布跳过: ${j.message || '已有广告'}`);
                  } else {
                    addLog(`  ✅ 发布结果: ${j.message || '成功'}`);
                  }
                  pubOk = true;
                } else {
                  addLog(`  ❌ 发布结果: ${j.message || '失败'}`);
                  if (proxy?.id) await markProxyFailed(proxy.id);
                  if (!pubOk) { addLog(`  等待 30 秒后重试...`); await new Promise(r => setTimeout(r, 30000)); }
                }
              } catch (e: any) {
                addLog(`  发布广告异常: ${e.message}`);
                if (proxy?.id) await markProxyFailed(proxy.id);
                if (!pubOk) { addLog(`  等待 30 秒后重试...`); await new Promise(r => setTimeout(r, 30000)); }
              }
            }
            if (!pubOk) addLog(`  [${pid}] ⛔ 发布失败`);
            try { await fetch(`${puppeteerBase}/facebook/close-browser`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
              body: JSON.stringify({ profileId: pid })
            }); } catch {}
          }

        } // end for steps (si)

        // 🚀 兜底：确保 Profile 处理完后浏览器一定被关闭
        try {
          await fetch(`${puppeteerBase}/facebook/close-browser`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
            body: JSON.stringify({ profileId: pid })
          });
        } catch {}

        setProgress(prev => ({ ...prev, done: prev.done + 1 }));
        // 🚀 每个 Profile 处理完后让出主线程，避免 UI 卡死
        await new Promise(r => setTimeout(r, 0));
      });
      addLog('\n✅ 全部步骤执行完成！');
      flushLog();
      // 🚀 发布完成后刷新广告账户列表，回传真实广告数量
      try { window.dispatchEvent(new Event('adaccounts-refresh')); } catch {}
    } catch (e: any) { addLog(`❌ 执行异常: ${e.message}`); flushLog(); }
    setRunning(false);
  };

  if (!open) return null;

  return (
    <>
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col" onClick={onClose}>
      <div className="flex-1 flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* header */}
        <div className="flex justify-between items-center p-6 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <div>
            <h2 className="text-xl font-bold text-white">一键智能广告发布</h2>
            <p className="text-xs text-slate-400 mt-1">
              已选择 <span className="text-indigo-400 font-medium">{profileIds.length}</span> 个配置
              {adAccountIds?.length ? <>、<span className="text-indigo-400 font-medium">{adAccountIds.length}</span> 个广告号</> : ''}
              &nbsp;| 共 {activeSteps.length} 个步骤
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors"><X className="w-6 h-6" /></button>
        </div>

        <div className="p-6 flex gap-4 flex-1 overflow-y-auto custom-scrollbar">
          {/* ===== LEFT: 步骤面板（所有可用步骤，点击添加到右侧） ===== */}
          <div className="w-44 shrink-0 rounded-xl border border-slate-700 bg-slate-800/30 p-3">
            <div className="text-[11px] font-medium text-slate-500 mb-2">步骤面板（点击 + 添加）</div>
            <div className="space-y-1">
              {(Object.keys(stepDefs) as StepKey[]).map(sk => {
                const def = stepDefs[sk];
                return (
                  <div key={sk} className="flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-all border-slate-700 bg-slate-800/60 hover:bg-slate-700/60 hover:border-indigo-500/30 cursor-pointer"
                    onClick={() => { setStepOrder(prev => [...prev, sk]); }}
                  >
                    <span className={`${def.color} shrink-0`}>{def.icon}</span>
                    <span className="text-[11px] flex-1 truncate text-slate-300">{def.label}</span>
                    <span className="text-indigo-400 text-sm font-bold shrink-0 leading-none">+</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ===== RIGHT: 执行流 + 配置区域 ===== */}
          <div className="flex-1 space-y-4 min-w-0 rounded-xl border border-slate-700 bg-slate-800/30 p-4">
            {/* 🆕 从「BM 列表」发起：在这里配置「在选中 BM 下建广告号」的参数 */}
            {businesses && businesses.length > 0 && (
              <div className="rounded-xl border border-teal-700/40 bg-teal-900/10 p-3 space-y-2">
                <div className="text-xs text-teal-300">
                  已选中 {businesses.length} 个 BM：会自动先在它们下面创建广告号，再把新建的广告号接给后面的步骤
                </div>
                <AdAccountFields value={adForm} onChange={patchAd} manualPlaceholder="留空则沿用 BM 名称" />
              </div>
            )}
            {/* ===== 当前执行步骤列表（可拖拽排序） ===== */}
            <div className="text-xs text-slate-500 mb-2 font-medium">执行步骤（拖动 ↔ 调整顺序，勾选启用 / 取消禁用）：</div>
            {stepOrder.length === 0 ? (
              <div className="text-xs text-slate-600 text-center py-6 border border-dashed border-slate-700 rounded-xl">左侧面板点击 + 添加步骤</div>
            ) : stepOrder.map((sk, idx) => {
                const def = stepDefs[sk];
                const en = stepEnabled[sk];
              return (
                <div key={`${sk}_${idx}`} className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${en ? 'border-slate-600 bg-slate-800/80' : 'border-slate-700/50 bg-slate-800/30 opacity-60'}`}>
                  {/* 拖拽手柄 + 上移/下移 */}
                  <div className="flex flex-col items-center gap-0.5">
                    <button onClick={() => moveStep(idx, -1)} disabled={idx === 0} className="text-slate-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"><ChevronUp className="w-3 h-3" /></button>
                    <GripVertical className="w-4 h-4 text-slate-500 cursor-grab" />
                    <button onClick={() => moveStep(idx, 1)} disabled={idx === stepOrder.length-1} className="text-slate-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"><ChevronDown className="w-3 h-3" /></button>
                  </div>
                  {/* 勾选开关 */}
                  <input type="checkbox" checked={en} onChange={() => setStepEnabled(prev => ({ ...prev, [sk]: !prev[sk] }))} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                  {/* 图标 + 名称 */}
                  <span className={`${def.color} shrink-0`}>{def.icon}</span>
                  <span className="text-sm text-white font-medium flex-1">{idx+1}. {def.label}</span>
                  {/* 配置摘要 */}
                  {en && sk === 'page' && (
                    <div className="flex items-center gap-2 shrink-0">
                      {pageTemplateList.length > 0 && (
                        <select value={selectedPageTemplate} onChange={e => switchPageTemplate(e.target.value)}
                          className="bg-slate-950 border border-slate-700 text-white rounded text-[11px] px-2 py-1 max-w-[120px]"
                        >
                          {pageTemplateList.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                        </select>
                      )}
                      {pageData && <span className="text-xs text-slate-400">{pageData.name}</span>}
                      {!pageData && <span className="text-xs text-slate-500">未配置</span>}
                    </div>
                  )}
                  {en && sk === 'billing' && (
                    <div className="flex items-center gap-2 shrink-0">
                      {billingTemplateList.length > 0 && (
                        <select value={selectedBillingTemplate} onChange={e => switchBillingTemplate(e.target.value)}
                          className="bg-slate-950 border border-slate-700 text-white rounded text-[11px] px-2 py-1 max-w-[120px]"
                        >
                          {billingTemplateList.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                        </select>
                      )}
                      <span className="text-xs text-slate-400">{ctCountry}/{ctCurrency}/TZ{ctTimezone}</span>
                    </div>
                  )}
                  {en && sk === 'card' && (
                    <div className="flex items-center gap-2 shrink-0">
                      {cardTemplateList.length > 0 && (
                        <select value={selectedCardTemplate} onChange={e => switchCardTemplate(e.target.value)}
                          className="bg-slate-950 border border-slate-700 text-white rounded text-[11px] px-2 py-1 max-w-[120px]"
                        >
                          {cardTemplateList.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                        </select>
                      )}
                      <span className="text-xs text-slate-400">{manualCardData ? '手动卡' : `${selectedCardIds.size}张`}</span>
                    </div>
                  )}
                  {en && sk === 'spendCap' && (
                    <div className="flex items-center gap-2 shrink-0">
                      <input value={spendCapAmount} onChange={e => setSpendCapAmount(e.target.value)} inputMode="decimal"
                        className="bg-slate-950 border border-slate-700 text-white rounded text-[11px] px-2 py-1 w-24" placeholder="金额" />
                      <span className="text-xs text-slate-400">限额</span>
                    </div>
                  )}
                  {en && sk === 'publish' && (
                    <div className="flex items-center gap-2 shrink-0">
                      {adTemplateList.length > 0 && (
                        <select value={selectedAdTemplateName} onChange={e => switchAdTemplate(e.target.value)}
                          className="bg-slate-950 border border-slate-700 text-white rounded text-[11px] px-2 py-1 max-w-[130px]"
                        >
                          <option value="">选择模板</option>
                          {adTemplateList.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                        </select>
                      )}
                      {adPublishData && <span className="text-xs text-slate-400">({adPublishData.publishMethod})</span>}
                      {!adPublishData && <span className="text-xs text-slate-500">未配置</span>}
                    </div>
                  )}
                  {en && sk === 'fetchInfo' && (
                    <span className="text-xs text-slate-400">启动浏览器同步资产数据</span>
                  )}
                  {en && sk === 'token' && (
                    <span className="text-xs text-slate-400">通过浏览器获取 API Token</span>
                  )}
                  {en && sk === 'precheck' && (
                    <div className="flex items-center gap-2 shrink-0">
                      {Object.keys(precheckResults).length > 0 && (
                        <span className="text-xs text-slate-400">
                          {Object.values(precheckResults).flat().filter(r => r.passed).length}/{Object.values(precheckResults).flat().length} 通过
                        </span>
                      )}
                    </div>
                  )}
                  {en && sk === 'lang' && (
                    <span className="text-xs text-slate-400">语言: {ctLang}</span>
                  )}
                  {en && sk === 'payment' && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">金额:</span>
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">$</span>
                        <input type="number" min="1" max="99999" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} className="w-20 bg-slate-950 border border-slate-800 rounded-lg pl-5 pr-2 py-1 text-xs text-white text-right" />
                      </div>
                    </div>
                  )}
                  {/* 配置按钮 */}
                  {en && sk === 'page' && (
                    !pageData
                      ? <button onClick={() => setShowPageCreator(true)} className="px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs hover:bg-indigo-500 shrink-0">配置</button>
                      : <button onClick={() => setShowPageCreator(true)} className="px-3 py-1 bg-slate-700 text-slate-200 rounded-lg text-xs hover:bg-slate-600 shrink-0">修改</button>
                  )}
                  {en && sk === 'publish' && (
                    !adPublishData
                      ? <button onClick={() => setShowAdPublisher(true)} className="px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs hover:bg-indigo-500 shrink-0">配置</button>
                      : <button onClick={() => setShowAdPublisher(true)} className="px-3 py-1 bg-slate-700 text-slate-200 rounded-lg text-xs hover:bg-slate-600 shrink-0">修改</button>
                  )}
                  {/* 🚀 复制 / 删除步骤 */}
                  <button onClick={() => {
                    const nu = [...stepOrder];
                    nu.splice(idx + 1, 0, sk);
                    setStepOrder(nu);
                    setStepEnabled(prev => ({ ...prev, [sk]: en }));
                  }} className="p-1.5 text-slate-500 hover:text-indigo-400 transition-colors shrink-0" title="复制步骤"><Copy className="w-3.5 h-3.5" /></button>
                  <button onClick={() => {
                    if (stepOrder.length <= 1) return;
                    const nu = stepOrder.filter((_, i) => i !== idx);
                    setStepOrder(nu);
                  }} className="p-1.5 text-slate-500 hover:text-red-400 transition-colors shrink-0" title="删除步骤"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              );
            })}

          {/* ===== 代理配置（折叠） ===== */}
          <div className={`rounded-xl border p-4 transition-colors ${enableProxy ? 'border-slate-600 bg-slate-800/50' : 'border-slate-700/50'}`}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={enableProxy} onChange={e => setEnableProxy(e.target.checked)} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-cyan-600" />
              <Shield className="w-4 h-4 text-cyan-400" />
              <span className="text-sm font-medium text-white">创建主页时使用代理</span>
              <span className="text-xs text-slate-500">从代理中心按标签/渠道筛选，失败自动切换</span>
            </label>
            {/* 发布广告独立代理勾选 */}
            <label className="flex items-center gap-3 cursor-pointer mt-3 ml-7">
              <input type="checkbox" checked={publishWithProxy} onChange={e => setPublishWithProxy(e.target.checked)} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-purple-500" />
              <Upload className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-medium text-white">发布广告时使用代理</span>
              <span className="text-xs text-slate-500">通过代理 IP 发布，降低风险</span>
            </label>
            {enableProxy && (
              <div className="mt-3 ml-7 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[120px]">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                    <input value={proxySearch} onChange={e => setProxySearch(e.target.value)} placeholder="搜索..." className={`${inputCls} pl-8 text-xs !py-1.5`} />
                  </div>
                  <select value={proxyFilterChannel} onChange={e => setProxyFilterChannel(e.target.value)} className={`${inputCls} w-auto text-xs !py-1.5`}>
                    <option value="">全部渠道</option>
                    {proxyAllChannels.map((ch: string) => <option key={ch} value={ch}>{ch}</option>)}
                  </select>
                  <select value={proxyFilterTag} onChange={e => setProxyFilterTag(e.target.value)} className={`${inputCls} w-auto text-xs !py-1.5`}>
                    <option value="">全部标签</option>
                    {proxyAllTags.map((t: string) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400 whitespace-nowrap">
                    <input type="checkbox" checked={proxyIterateMode === 'fixed'} onChange={e => setProxyIterateMode(e.target.checked ? 'fixed' : 'auto')} className="rounded border-slate-600 bg-slate-800 text-cyan-600 w-3.5 h-3.5" />
                    固定代理
                  </label>
                </div>
                <div className="max-h-32 overflow-y-auto custom-scrollbar rounded-lg border border-slate-700 divide-y divide-slate-700/50">
                  {filteredProxies.length === 0 ? (
                    <div className="p-3 text-center text-slate-500 text-xs">{proxyFailedIds.size > 0 ? '所有代理已失败' : '无匹配代理'}</div>
                  ) : filteredProxies.map((p: any) => (
                    <label key={p.id} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer ${proxySelectedId === p.id ? 'bg-indigo-500/15' : 'hover:bg-slate-800/50'}`}>
                      <input type="radio" name="proxySelect" checked={proxySelectedId === p.id} onChange={() => setProxySelectedId(proxySelectedId === p.id ? '' : p.id)} className="accent-indigo-600 w-3 h-3" />
                      <Shield className={`w-3 h-3 shrink-0 ${p.type === 'socks5' ? 'text-purple-400' : p.type === 'residential' ? 'text-cyan-400' : 'text-slate-400'}`} />
                      <span className="text-xs text-white font-mono">{p.host}:{p.port}</span>
                      <span className={`text-[10px] px-1 rounded ${p.type === 'socks5' ? 'bg-purple-600/20 text-purple-300' : p.type === 'residential' ? 'bg-cyan-600/20 text-cyan-300' : 'bg-slate-700 text-slate-300'}`}>{smartProxyType(p)}</span>
                      {(p.failed_count||0) > 0 && <span className="text-[10px] bg-rose-600/20 text-rose-300 px-1 rounded">失败{p.failed_count}次</span>}
                    </label>
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-slate-500">
                  <span>{proxySelectedId ? '已选1个(固定)' : '自动遍历'} | 排除{proxyFailedIds.size}个失败</span>
                  <span>{filteredProxies.length}可用/{proxyList.length}总计</span>
                </div>
              </div>
            )}
          </div>

          {/* ===== 预检结果展示 ===== */}
          {stepEnabled.precheck && Object.keys(precheckResults).length > 0 && (
            <div className="rounded-xl border border-sky-700/50 bg-sky-900/10 p-4">
              <div className="flex items-center gap-2 mb-3">
                <Search className="w-4 h-4 text-sky-400" />
                <span className="text-sm font-medium text-white">预检结果</span>
              </div>
              <div className="space-y-2">
                {Object.entries(precheckResults).map(([pid, items]) => {
                  const allPassed = items.every(i => i.passed);
                  return (
                    <div key={pid} className={`rounded-lg border p-3 ${allPassed ? 'border-emerald-700/50 bg-emerald-900/10' : 'border-rose-700/50 bg-rose-900/10'}`}>
                      <div className="text-xs font-medium mb-1.5 text-slate-300">
                        {allPassed ? '✅' : '❌'} 
                        <span className="ml-1">{pid}</span>
                        <span className="ml-2 text-slate-500">{items.length} 个广告号</span>
                        {allPassed && <span className="ml-2 text-emerald-400">全部通过</span>}
                        {!allPassed && <span className="ml-2 text-rose-400">存在失败项</span>}
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                        {items.map((item, idx) => (
                          <div key={idx} className={`text-[11px] px-2.5 py-1.5 rounded ${item.passed ? 'bg-slate-800/60' : 'bg-rose-900/20'}`}>
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-slate-200">{item.adAccountId}</span>
                              <span className="text-slate-500">|</span>
                              <span className={item.accountStatus === '1' ? 'text-emerald-400' : 'text-rose-400'}>
                                {item.accountStatusLabel}
                              </span>
                              <span className="text-slate-500">|</span>
                              <span className={item.hasCards ? 'text-emerald-400' : 'text-rose-400'}>
                                卡片 {item.cardsCount}张
                              </span>
                              <span className="text-slate-500">|</span>
                              <span className={item.pixelOk ? 'text-emerald-400' : 'text-rose-400'}>
                                像素 {item.pixelOk ? `✓${item.pixelName ? `(${item.pixelName})` : ''}` : `✗(${item.pixelCount}个)`}
                              </span>
                              {stepEnabled.page && (
                                <>
                                  <span className="text-slate-500">|</span>
                                  <span className={pageData ? 'text-emerald-400' : 'text-rose-400'}>
                                    主页 {pageData ? '✓已配置' : '✗未配置'}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ===== 主页配置（折叠，仅在 page 步骤启用时显示） ===== */}
          {stepEnabled.page && (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
              <div className="flex items-center gap-2 mb-3">
                <FileText className="w-4 h-4 text-indigo-400" />
                <span className="text-sm font-medium text-white">主页配置</span>
                {pageTemplateList.length > 0 && (
                  <select value={selectedPageTemplate} onChange={e => switchPageTemplate(e.target.value)}
                    className="ml-2 bg-slate-950 border border-slate-700 text-white rounded text-xs px-2 py-1"
                  >
                    {pageTemplateList.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                  </select>
                )}
              </div>
              <div className="flex items-center justify-between">
                {pageData ? (
                  <div className="text-xs text-slate-400 space-y-1">
                    <div>名称: <span className="text-slate-200">{pageData.name}</span> {pageData.isRandomName && <span className="text-indigo-400">(随机)</span>}</div>
                    <div>分类: <span className="text-slate-200">{pageData.category}</span> {pageData.isRandomCategory && <span className="text-indigo-400">(随机)</span>}</div>
                    {pageData.website && <div>网站: <span className="text-slate-200">{pageData.website}</span> {pageData.isRandomWebsite && <span className="text-indigo-400">(随机)</span>}</div>}
                    <div>{pageData.profileImage ? '🖼️ 头像已上传' : ''} {pageData.backgroundImage ? '🖼️ 背景图已上传' : ''}</div>
                    <div>Session创建: <span className="text-slate-200">{pageData.useSession ? '是' : '否'}</span></div>
                  </div>
                ) : (
                  <span className="text-xs text-slate-500">未配置主页模板</span>
                )}
                <button onClick={() => setShowPageCreator(true)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-xs hover:bg-indigo-500 shrink-0">
                  {pageData ? '修改' : '配置'}
                </button>
              </div>
            </div>
          )}

          {/* ===== 账单配置（折叠，仅在 billing 步骤启用时显示） ===== */}
          {stepEnabled.billing && (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
              <div className="flex items-center gap-2 mb-3">
                <Globe className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-medium text-white">账单配置</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className={labelCls}>国家</label>
                  <select value={ctCountry} onChange={e => { setCtCountry(e.target.value); setCtCurrency(COUNTRY_CURRENCY[e.target.value] || ctCurrency); }} className={inputCls}>
                    {Object.keys(COUNTRY_CURRENCY).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>货币</label>
                  <select value={ctCurrency} onChange={e => setCtCurrency(e.target.value)} className={inputCls}>
                    {[...new Set(Object.values(COUNTRY_CURRENCY))].sort().map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>时区</label>
                  <select value={ctTimezone} onChange={e => setCtTimezone(e.target.value)} className={inputCls}>
                    {TZ_OPTIONS.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>FB界面语言</label>
                  <select value={ctLang} onChange={e => setCtLang(e.target.value)} className={inputCls}>
                    <option value="">不修改</option>
                    <option value="en_US">English (US)</option>
                    <option value="zh_CN">简体中文</option>
                    <option value="es_ES">Español (ES)</option>
                    <option value="fr_FR">Français (FR)</option>
                    <option value="pt_BR">Português (BR)</option>
                    <option value="de_DE">Deutsch (DE)</option>
                    <option value="it_IT">Italiano (IT)</option>
                    <option value="ja_JP">日本語</option>
                    <option value="ko_KR">한국어</option>
                    <option value="th_TH">ภาษาไทย</option>
                    <option value="vi_VN">Tiếng Việt</option>
                    <option value="id_ID">Bahasa Indonesia</option>
                    <option value="ms_MY">Bahasa Melayu</option>
                    <option value="ar_AR">العربية</option>
                    <option value="tr_TR">Türkçe</option>
                    <option value="ru_RU">Русский</option>
                    <option value="pl_PL">Polski</option>
                    <option value="nl_NL">Nederlands</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div>
                  <label className={labelCls}>街道地址</label>
                  <div className="flex gap-1">
                    <input value={ctAddress} onChange={e => setCtAddress(e.target.value)} placeholder="123 Main St" className={`${inputCls} flex-1`} disabled={ctAddressRandom} />
                    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={ctAddressRandom} onChange={e => { setCtAddressRandom(e.target.checked); if (e.target.checked) setCtAddress(''); }} className="w-3 h-3 rounded border-slate-600" />
                      随机
                    </label>
                  </div>
                </div>
                <div>
                  <label className={labelCls}>城市</label>
                  <div className="flex gap-1">
                    <input value={ctCity} onChange={e => setCtCity(e.target.value)} placeholder="New York" className={`${inputCls} flex-1`} disabled={ctCityRandom} />
                    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={ctCityRandom} onChange={e => { setCtCityRandom(e.target.checked); if (e.target.checked) setCtCity(''); }} className="w-3 h-3 rounded border-slate-600" />
                      随机
                    </label>
                  </div>
                </div>
                <div>
                  <label className={labelCls}>邮编</label>
                  <div className="flex gap-1">
                    <input value={ctZip} onChange={e => setCtZip(e.target.value)} placeholder="10001" className={`${inputCls} flex-1`} disabled={ctZipRandom} />
                    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={ctZipRandom} onChange={e => { setCtZipRandom(e.target.checked); if (e.target.checked) setCtZip(''); }} className="w-3 h-3 rounded border-slate-600" />
                      随机
                    </label>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 mt-3">
                <div>
                  <label className={labelCls}>州/省 (State)</label>
                  <div className="flex gap-1">
                    <select value={billingState} onChange={e => setBillingState(e.target.value)} className={`${inputCls} flex-1`} disabled={billingStateRandom}>
                      <option value="">-- 选择州/省 --</option>
                      {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={billingStateRandom} onChange={e => { setBillingStateRandom(e.target.checked); if (e.target.checked) setBillingState(''); }} className="w-3 h-3 rounded border-slate-600" />
                      随机
                    </label>
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <label className={labelCls}>公司名称（账单）</label>
                <input value={ctBusinessName} onChange={e => setCtBusinessName(e.target.value)}
                  placeholder="输入账单公司名称，如 Example Inc.（留空不修改）"
                  className={inputCls} />
              </div>
            </div>
          )}

          {/* ===== 语言配置（折叠，仅在 lang 步骤启用时显示） ===== */}
          {stepEnabled.lang && (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
              <div className="flex items-center gap-2 mb-3">
                <Globe className="w-4 h-4 text-purple-400" />
                <span className="text-sm font-medium text-white">界面语言配置</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>FB界面语言</label>
                  <select value={ctLang} onChange={e => setCtLang(e.target.value)} className={inputCls}>
                    <option value="">不修改</option>
                    <option value="en_US">English (US)</option>
                    <option value="zh_CN">简体中文</option>
                    <option value="es_ES">Español (ES)</option>
                    <option value="fr_FR">Français (FR)</option>
                    <option value="pt_BR">Português (BR)</option>
                    <option value="de_DE">Deutsch (DE)</option>
                    <option value="it_IT">Italiano (IT)</option>
                    <option value="ja_JP">日本語</option>
                    <option value="ko_KR">한국어</option>
                    <option value="th_TH">ภาษาไทย</option>
                    <option value="vi_VN">Tiếng Việt</option>
                    <option value="id_ID">Bahasa Indonesia</option>
                    <option value="ms_MY">Bahasa Melayu</option>
                    <option value="ar_AR">العربية</option>
                    <option value="tr_TR">Türkçe</option>
                    <option value="ru_RU">Русский</option>
                    <option value="pl_PL">Polski</option>
                    <option value="nl_NL">Nederlands</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ===== 卡片配置（折叠，仅在 card 步骤启用时显示） ===== */}
          {stepEnabled.card && (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
              <div className="flex items-center gap-2 mb-3">
                <CreditCard className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-medium text-white">卡片配置</span>
              </div>
              <div className="space-y-3 ml-1">
                {manualCardData ? (
                  <div className="flex items-center justify-between bg-slate-800/50 rounded-lg p-2.5">
                    <span className="text-xs text-slate-200">手动卡: ****{manualCardData.number?.slice(-4)} | {manualCardData.holderName}</span>
                    <button onClick={() => { setManualCardData(null); setShowCardInfo(true); }} className="text-xs text-indigo-400 hover:text-indigo-300">修改</button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={() => setShowCardInfo(true)} className="px-3 py-1.5 bg-slate-700 text-slate-200 rounded-lg text-xs hover:bg-slate-600">手动输入绑卡</button>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[120px]">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                    <input value={cardSearch} onChange={e => setCardSearch(e.target.value)} placeholder="搜索卡片..." className={`${inputCls} pl-8 text-xs !py-1.5`} />
                  </div>
                  <select value={cardFilterChannel} onChange={e => setCardFilterChannel(e.target.value)} className={`${inputCls} w-auto text-xs !py-1.5`}>
                    <option value="">全部渠道</option>
                    {allChannels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
                  </select>
                  <select value={cardFilterTag} onChange={e => setCardFilterTag(e.target.value)} className={`${inputCls} w-auto text-xs !py-1.5`}>
                    <option value="">全部标签</option>
                    {allTags.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <input type="checkbox" checked={cardIterateMode === 'cycle'} onChange={e => setCardIterateMode(e.target.checked ? 'cycle' : 'all')} className="rounded border-slate-600 bg-slate-800 text-indigo-600 w-3.5 h-3.5" />
                    遍历分配
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <input type="checkbox" checked={checkBillingParams} onChange={e => setCheckBillingParams(e.target.checked)} className="rounded border-slate-600 bg-slate-800 text-indigo-600 w-3.5 h-3.5" />
                    检查国家/货币/时区
                  </label>
                  {checkBillingParams && (
                    <span className="text-[10px] text-slate-500 ml-4">
                      目标: {ctCountry || '—'} / {ctCurrency || '—'} / UTC+{ctTimezone || '—'}
                    </span>
                  )}
                </div>
                <div className="max-h-32 overflow-y-auto custom-scrollbar rounded-lg border border-slate-700 divide-y divide-slate-700/50">
                  {filteredCards.length === 0 ? (
                    <div className="p-3 text-center text-slate-500 text-xs">无匹配卡片</div>
                  ) : filteredCards.map(card => {
                    const cid = card.id || card.card_id || '';
                    return (
                      <label key={cid} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer ${selectedCardIds.has(cid) ? 'bg-indigo-500/15' : 'hover:bg-slate-800/50'}`}>
                        <input type="checkbox" checked={selectedCardIds.has(cid)} onChange={() => toggleCard(cid)} className="rounded border-slate-600 bg-slate-800 text-indigo-600 w-3 h-3" />
                        <CreditCard className="w-3 h-3 text-slate-400 shrink-0" />
                        <span className="text-xs text-white font-mono">{card.alias || (card.cardNumber ? card.cardNumber.slice(-4).padStart(4,'•') : cid.slice(0,8))}</span>
                        {card.channel && <span className="text-[10px] bg-slate-700 text-slate-300 px-1 rounded">{card.channel}</span>}
                        {(card.tags||[]).map(t => <span key={t} className="text-[10px] bg-indigo-600/20 text-indigo-300 px-1 rounded">{t}</span>)}
                      </label>
                    );
                  })}
                </div>
                <div className="text-[10px] text-slate-400">已选 {selectedCardIds.size + (manualCardData?1:0)} 张</div>
              </div>
            </div>
          )}

          {/* ===== 限额设置（绑卡后执行） ===== */}
          {stepEnabled.spendCap && (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
              <div className="flex items-center gap-2 mb-3">
                <DollarSign className="w-4 h-4 text-yellow-400" />
                <span className="text-sm font-medium text-white">限额设置（绑卡后执行）</span>
              </div>
              <div className="space-y-2 ml-1">
                <label className={labelCls}>账户花费上限（按账户货币，原值提交，0 = 取消限额）</label>
                <input value={spendCapAmount} onChange={e => setSpendCapAmount(e.target.value)} inputMode="decimal"
                  placeholder="例如 100" className={`${inputCls} max-w-[200px]`} />
                <div className="text-[10px] text-slate-500">会把本次涉及的每个广告号的限额写成这个值（写入 Meta 的账户花费上限 spend_cap）。</div>
              </div>
            </div>
          )}

          {/* ===== 日志 ===== */}
          {(log.length > 0 || running) && (
            <div className="bg-slate-950 rounded-xl border border-slate-700 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-slate-300">执行日志</span>
                {running && <span className="text-xs text-indigo-400">步骤{progress.step+1}/{progress.totalSteps}</span>}
              </div>
              {running && progress.total > 0 && (
                <div className="w-full h-1 bg-slate-800 rounded-full mb-2 overflow-hidden">
                  <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${(progress.done/progress.total)*100}%` }} />
                </div>
              )}
              <div className="max-h-40 overflow-y-auto custom-scrollbar text-xs text-slate-400 font-mono space-y-0.5">
                {log.map((l, i) => (
                  <div key={i} className={`${l.includes('✅') ? 'text-emerald-400' : l.includes('❌') ? 'text-rose-400' : l.includes('=====') ? 'text-white font-bold' : ''}`}>{l}</div>
                ))}
                {running && <div className="text-indigo-400 animate-pulse">处理中...</div>}
              </div>
            </div>
          )}

          </div> {/* end right column */}
        </div>

        {/* footer */}
        <div className="p-6 border-t border-slate-800 flex justify-between items-center shrink-0">
          <div className="text-xs text-slate-500">
            步骤: {activeSteps.map(sk => stepDefs[sk].label).join(' → ') || '无'}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} disabled={running} className="px-5 py-2.5 bg-slate-800 text-slate-200 rounded-xl hover:bg-slate-700 disabled:opacity-50">取消</button>
            <button onClick={handleRun} disabled={running || activeSteps.length === 0}
              className="px-6 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 font-medium transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-50 flex items-center gap-2">
              {running ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />执行中...</>
                : <><Send className="w-4 h-4" />开始执行 ({activeSteps.length}步)</>}
            </button>
          </div>
        </div>
      </div>
    </div>

      {/* 内嵌 PageCreator（在遮罩层外） */}
      {showPageCreator && (
        <PageCreator
          profileIds={profileIds}
          initialData={pageData || undefined}
          onCancel={() => setShowPageCreator(false)}
          onConfirm={async (data) => {
            setPageData(data);
            setShowPageCreator(false);
            // 保存到 publish-configs/page 统一模板存储
            const name = selectedPageTemplate || `主页模板 ${pageTemplateList.length + 1}`;
            const newTpl = { name, data };
            const oldList = pageTemplateList.length > 0 ? pageTemplateList : [{ name, data }];
            const nuList = pageTemplateList.some(t => t.name === name)
              ? pageTemplateList.map(t => t.name === name ? newTpl : t)
              : [...oldList, newTpl];
            setPageTemplateList(nuList);
            setSelectedPageTemplate(name);
            const payload = { templates: nuList, activeTemplate: name };
            try {
              const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
              const base = String(serverUrl || '').replace(/\/$/, '');
              const authToken = localStorage.getItem('auth_token');
              await fetch(`${base}/api/publish-configs/page`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify({ value: payload })
              });
              localStorage.setItem('omnifingerprint_page_template_cache', JSON.stringify(payload));
            } catch {}
          }}
        />
      )}
      {/* 内嵌 CardInfoModal（在遮罩层外） */}
      <CardInfoModal
        open={showCardInfo}
        onClose={() => setShowCardInfo(false)}
        profileCount={profileIds.length}
        onConfirm={(card) => { setManualCardData(card); setShowCardInfo(false); }}
      />
      {/* 内嵌 FacebookAdPublisher（在遮罩层外） */}
      {showAdPublisher && (
        <FacebookAdPublisher
          profileIds={profileIds}
          templateMode
          initialTemplate={adTemplateList.find(t => t.name === selectedAdTemplateName) || null}
          onCancel={() => setShowAdPublisher(false)}
          onConfirm={async (data) => {
            setAdPublishData(data);
            setShowAdPublisher(false);
            // FacebookAdPublisher 在 templateMode 下已自动保存到 /api/ad-templates
            // 刷新列表
            try {
              const authToken = localStorage.getItem('auth_token');
              const r = await fetch('/api/ad-templates', {
                headers: { 'Authorization': `Bearer ${authToken}` }
              });
              const j = await r.json();
              if (j.success) {
                setAdTemplateList(j.data);
                localStorage.setItem('omnifingerprint_ad_templates_cache', JSON.stringify(j.data));
              }
            } catch {}
          }}
        />
      )}
    </>  );
};
