import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import * as XLSX from 'xlsx';
import { X, Upload, ArrowRight, FileSpreadsheet, Check, AlertCircle, ChevronLeft, Save, ChevronUp, ChevronDown, GripVertical, Copy, Trash2, Globe, CreditCard, Eye, ShieldCheck, Download, Shield } from 'lucide-react';
import { FingerprintProfile, Platform, BrowserStatus, AccountStatus } from '../types';
import { parseProxyString } from '../utils/proxy';
import { PageCreator, PageCreationData } from './PageCreator';
import { CardInfoModal } from './CardInfoModal';
import { FacebookAdPublisher, AdPublishData } from './FacebookAdPublisher';

/** 导入后流程步骤的配置选择 */
export interface FlowStepSelection {
  order: string[];
  templates?: {
    page?: string;
    billing?: string;
    card?: string;
    publish?: string;
  };
}

interface ImportWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (profiles: FingerprintProfile[], flowSelection?: FlowStepSelection) => void;
  // 模板列表（从父组件传入）
  pageTemplateList?: { name: string; data: any }[];
  billingTemplateList?: { name: string; data: any }[];
  cardTemplateList?: { name: string; data: any }[];
  adTemplateList?: { id: number; name: string; config: string; is_default: number }[];
  // 打开子组件编辑弹窗
  onOpenPageCreator?: () => void;
  onOpenBillingEdit?: () => void;
  onOpenCardEdit?: () => void;
  onOpenAdPublisher?: () => void;
}

// 可执行的流程步骤定义
const FLOW_STEP_DEFS = [
  { key: 'checkLogin', label: '检查登录状态', color: 'text-green-500' },
  { key: 'checkAd', label: '检查已有广告', color: 'text-rose-500' },
  { key: 'page', label: '创建主页', color: 'text-cyan-400' },
  { key: 'billing', label: '修改国家/时区/货币', color: 'text-blue-400' },
  { key: 'checkCard', label: '检查已有卡片', color: 'text-amber-500' },
  { key: 'card', label: '绑定卡片', color: 'text-amber-400' },
  { key: 'lang', label: '修改界面语言', color: 'text-purple-400' },
  { key: 'payment', label: '手动付款', color: 'text-emerald-400' },
  { key: 'publish', label: '发布广告', color: 'text-indigo-400' },
];

// Definition for system fields allowing nested keys (e.g., 'proxy.host')
  const SYSTEM_FIELDS: { key: string; label: string; aliases: string[] }[] = [
  // Basic Info
  { key: 'name', label: 'name', aliases: ['name', 'profile', 'account', 'title'] },
  { key: 'group', label: 'group', aliases: ['group', 'team', 'category', 'folder'] },
  { key: 'tags', label: 'tags', aliases: ['tags', 'keywords', 'labels'] },
  { key: 'owner', label: 'owner', aliases: ['owner', 'creator', 'user'] },
  { key: 'token', label: 'token', aliases: ['token', 'access_token', '__accessToken'] },
  { key: 'notes', label: 'notes', aliases: ['notes', 'remarks', 'description'] },
  
  // Platform & Status
  { key: 'platform', label: 'platform', aliases: ['platform', 'site', 'social'] },
  { key: 'status', label: 'status', aliases: ['status', 'state'] },
  { key: 'accountStatus', label: 'accountStatus', aliases: ['account status', 'ban status', 'restriction'] },

  // Assets
  { key: 'assets.bmId', label: 'bmId', aliases: ['bm', 'bm id', 'business manager'] },
  { key: 'assets.currency', label: 'currency', aliases: ['currency', 'curr'] },
  { key: 'assets.country', label: 'country', aliases: ['country', 'geo', 'location'] },
  { key: 'assets.paymentStatus', label: 'paymentStatus', aliases: ['payment', 'card status'] },
  { key: 'assets.pagesCount', label: 'pages', aliases: ['pages', 'fan pages'] },
  { key: 'assets.adAccountsCount', label: 'adAccounts', aliases: ['ad accounts', 'ad acc'] },

  // Fingerprint
  { key: 'os', label: 'os', aliases: ['os', 'operating system', 'system'] },
  { key: 'userAgent', label: 'userAgent', aliases: ['ua', 'useragent', 'agent'] },
  { key: 'resolution', label: 'resolution', aliases: ['resolution', 'screen', 'size'] },
  { key: 'language', label: 'language', aliases: ['language', 'lang'] },
  { key: 'timezone', label: 'timezone', aliases: ['timezone', 'tz', 'zone'] },
  
  // Network / Proxy
  { key: 'ipAddress', label: 'ipAddress', aliases: ['ip', 'address'] }, // Display IP usually
  { key: 'proxy.type', label: 'proxyType', aliases: ['proxy type', 'protocol'] },
  { key: 'proxy.host', label: 'proxyHost', aliases: ['proxy host', 'server', 'proxy ip'] },
  { key: 'proxy.port', label: 'proxyPort', aliases: ['proxy port', 'port'] },
  { key: 'proxy.username', label: 'proxyUsername', aliases: ['proxy user', 'proxy username', 'proxy login'] },
  { key: 'proxy.password', label: 'proxyPassword', aliases: ['proxy pass', 'proxy password'] },
  { key: 'proxy.raw', label: 'proxy', aliases: ['proxy', 'proxy url', 'proxy string', 'proxy_url', 'proxyString'] },

  // Account
  { key: 'account.name', label: 'accountName', aliases: ['username', 'login', 'account name'] },
  { key: 'account.email', label: 'accountEmail', aliases: ['email', 'mail'] },
  { key: 'account.password', label: 'accountPassword', aliases: ['password', 'pass'] },
  { key: 'account.twoFactorSecret', label: '2FA', aliases: ['2fa', 'totp', 'secret'] },
  { key: 'account.cookies', label: 'cookies', aliases: ['cookies', 'cookie', 'session'] },
  { key: 'cookiesCount', label: 'cookiesCount', aliases: ['cookie count', 'count'] },
  
  // Startup
  { key: 'startupUrls', label: 'startupUrls', aliases: ['urls', 'websites', 'startup'] },
];

export const ImportWizard = ({
  isOpen, onClose, onImport,
  pageTemplateList = [], billingTemplateList = [], cardTemplateList = [], adTemplateList = [],
  onOpenPageCreator, onOpenBillingEdit, onOpenCardEdit, onOpenAdPublisher
}: ImportWizardProps) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2 | 3>(1); // 1: Upload, 2: Map, 3: Preview
  const [fileData, setFileData] = useState<any[]>([]);
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [mappings, setMappings] = useState<Record<string, string>>({}); // SystemFieldKey -> FileHeader
  const [flowEnabled, setFlowEnabled] = useState(false);
  const [flowOrder, setFlowOrder] = useState<string[]>(['checkLogin', 'checkAd', 'page', 'billing', 'checkCard', 'card', 'lang', 'payment', 'publish']);
  const [flowSteps, setFlowSteps] = useState<Record<string, boolean>>({
    checkLogin: false, checkAd: false, page: false, billing: false,
    checkCard: false, card: false, lang: false, payment: false, publish: false,
  });
  // 模板选择
  const [selPageTmpl, setSelPageTmpl] = useState('');
  const [selBillingTmpl, setSelBillingTmpl] = useState('');
  const [selCardTmpl, setSelCardTmpl] = useState('');
  const [selAdTmpl, setSelAdTmpl] = useState('');
  // 本地加载的模板列表（当父组件未传入时使用）
  const [localPageTemplates, setLocalPageTemplates] = useState<{ name: string; data: any }[]>([]);
  const [localBillingTemplates, setLocalBillingTemplates] = useState<{ name: string; data: any }[]>([]);
  const [localCardTemplates, setLocalCardTemplates] = useState<{ name: string; data: any }[]>([]);
  const [localAdTemplates, setLocalAdTemplates] = useState<{ id: number; name: string; config: string; is_default: number }[]>([]);

  // 编辑弹窗可见性
  const [showPageCreator, setShowPageCreator] = useState(false);
  const [showBillingEditor, setShowBillingEditor] = useState(false);
  const [showCardEditor, setShowCardEditor] = useState(false);
  const [showAdPublisher, setShowAdPublisher] = useState(false);
  // 账单编辑表单数据
  const [billingCountry, setBillingCountry] = useState('US');
  const [billingCurrency, setBillingCurrency] = useState('USD');
  const [billingTimezone, setBillingTimezone] = useState('1');
  const [billingLang, setBillingLang] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [billingCity, setBillingCity] = useState('');
  const [billingZip, setBillingZip] = useState('');
  const [billingState, setBillingState] = useState('AL');
  const [billingBusinessName, setBillingBusinessName] = useState('');
  const [billingAddressRandom, setBillingAddressRandom] = useState(true);
  const [billingCityRandom, setBillingCityRandom] = useState(true);
  const [billingZipRandom, setBillingZipRandom] = useState(true);
  const [billingStateRandom, setBillingStateRandom] = useState(false);
  // 卡片编辑数据
  const [localCards, setLocalCards] = useState<any[]>([]);
  const [cardSearch, setCardSearch] = useState('');
  const [cardFilterChannel, setCardFilterChannel] = useState('');
  const [cardFilterTag, setCardFilterTag] = useState('');
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [cardIterateMode, setCardIterateMode] = useState<'all' | 'cycle'>('cycle');
  const [checkBillingParams, setCheckBillingParams] = useState(false);
  // 语言编辑弹窗
  const [showLangEditor, setShowLangEditor] = useState(false);
  const [langValue, setLangValue] = useState('en_US');

  // 常量
  const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
  const LANG_OPTIONS = [
    { value: '', label: '不修改' },
    { value: 'en_US', label: 'English (US)' }, { value: 'zh_CN', label: '简体中文' },
    { value: 'es_ES', label: 'Español (ES)' }, { value: 'fr_FR', label: 'Français (FR)' },
    { value: 'pt_BR', label: 'Português (BR)' }, { value: 'de_DE', label: 'Deutsch (DE)' },
    { value: 'it_IT', label: 'Italiano (IT)' }, { value: 'ja_JP', label: '日本語' },
    { value: 'ko_KR', label: '한국어' }, { value: 'th_TH', label: 'ภาษาไทย' },
    { value: 'vi_VN', label: 'Tiếng Việt' }, { value: 'id_ID', label: 'Bahasa Indonesia' },
    { value: 'ms_MY', label: 'Bahasa Melayu' }, { value: 'ar_AR', label: 'العربية' },
    { value: 'tr_TR', label: 'Türkçe' }, { value: 'ru_RU', label: 'Русский' },
    { value: 'pl_PL', label: 'Polski' }, { value: 'nl_NL', label: 'Nederlands' },
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

  const COUNTRY_CURRENCY: Record<string, string> = {
    US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', DE: 'EUR', FR: 'EUR', IT: 'EUR',
    ES: 'EUR', NL: 'EUR', JP: 'JPY', SG: 'SGD', HK: 'HKD', KR: 'KRW', TW: 'TWD',
    IN: 'INR', BR: 'BRL', MX: 'MXN', CH: 'CHF', NZ: 'NZD', ZA: 'ZAR', AE: 'AED',
    SA: 'SAR', IL: 'ILS', TR: 'TRY', RU: 'RUB', PL: 'PLN', TH: 'THB', VN: 'VND',
    ID: 'IDR', MY: 'MYR', PH: 'PHP', IE: 'EUR', PT: 'EUR', GR: 'EUR', CZ: 'CZK',
    HU: 'HUF', RO: 'RON', BG: 'BGN', UA: 'UAH', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  };
  const inputCls = 'w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm';
  const labelCls = 'text-xs text-slate-400 mb-0.5 block';

  // 页面数据
  const [pageData, setPageData] = useState<PageCreationData | undefined>(undefined);
  const [adPublishData, setAdPublishData] = useState<AdPublishData | undefined>(undefined);
  const [manualCardData, setManualCardData] = useState<any>(undefined);

  // 🚀 打开时从 localStorage 加载模板列表
  useEffect(() => {
    if (!isOpen) return;
    try {
      const p = localStorage.getItem('omnifingerprint_page_template_cache');
      if (p) { const v = JSON.parse(p); if (v.templates) { setLocalPageTemplates(v.templates); } }
    } catch {}
    try {
      const b = localStorage.getItem('omnifingerprint_billing_template_cache');
      if (b) { const v = JSON.parse(b); if (v.templates) { setLocalBillingTemplates(v.templates); } }
    } catch {}
    try {
      const c = localStorage.getItem('omnifingerprint_card_template_cache');
      if (c) { const v = JSON.parse(c); if (v.templates) { setLocalCardTemplates(v.templates); } }
    } catch {}
    try {
      const a = localStorage.getItem('omnifingerprint_ad_templates_cache');
      if (a) { const v = JSON.parse(a); if (Array.isArray(v)) setLocalAdTemplates(v); }
    } catch {}
    // 卡片列表
    try {
      const cards = localStorage.getItem('local_cards');
      if (cards) { const v = JSON.parse(cards); if (Array.isArray(v)) setLocalCards(v); }
    } catch {}
  }, [isOpen]);

  // 最终使用的模板列表（优先 parent props，其次 localStorage）
  const resolvedPageTemplates = pageTemplateList.length > 0 ? pageTemplateList : localPageTemplates;
  const resolvedBillingTemplates = billingTemplateList.length > 0 ? billingTemplateList : localBillingTemplates;
  const resolvedCardTemplates = cardTemplateList.length > 0 ? cardTemplateList : localCardTemplates;
  const resolvedAdTemplates = adTemplateList.length > 0 ? adTemplateList : localAdTemplates;

  // 🚀 保存账单模板到 localStorage
  const saveBillingTemplate = () => {
    const name = selBillingTmpl || `账单模板 ${resolvedBillingTemplates.length + 1}`;
    const templateData = {
      country: billingCountry, currency: billingCurrency, timezone: billingTimezone, lang: billingLang,
      address: billingAddress, city: billingCity, zip: billingZip, state: billingState,
      addressRandom: billingAddressRandom, cityRandom: billingCityRandom, zipRandom: billingZipRandom, stateRandom: billingStateRandom,
      business_name: billingBusinessName,
    };
    const existing = resolvedBillingTemplates.filter(t => t.name !== name);
    const newList = [...existing, { name, data: templateData }];
    localStorage.setItem('omnifingerprint_billing_template_cache', JSON.stringify({ templates: newList, activeTemplate: name }));
    setLocalBillingTemplates(newList);
    setSelBillingTmpl(name);
    setShowBillingEditor(false);
  };

  // 🚀 卡片筛选 + 全选/反选
  const allChannels = [...new Set(localCards.map((c: any) => c.channel).filter(Boolean))];
  const allTags = [...new Set(localCards.flatMap((c: any) => c.tags || []))];
  const filteredCards = localCards.filter((c: any) => {
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
  const selectAllFiltered = () => setSelectedCardIds(new Set(filteredCards.map((c: any) => c.id || c.card_id || '').filter(Boolean)));

  // 🚀 获取步骤图标
  const getStepIcon = (sk: string) => {
    switch (sk) {
      case 'checkLogin': return <ShieldCheck className="w-4 h-4" />;
      case 'checkAd': return <Eye className="w-4 h-4" />;
      case 'page': return <Globe className="w-4 h-4" />;
      case 'billing': return <Download className="w-4 h-4" />;
      case 'checkCard': return <Shield className="w-4 h-4" />;
      case 'card': return <CreditCard className="w-4 h-4" />;
      case 'lang': return <Globe className="w-4 h-4" />;
      case 'payment': return <CreditCard className="w-4 h-4" />;
      case 'publish': return <Upload className="w-4 h-4" />;
      default: return <Check className="w-4 h-4" />;
    }
  };

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        if (json.length === 0) return;
        setFileData(json);
        setFileHeaders(Object.keys(json[0] as object));
        setMappings({});
      } catch {}
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleMappingChange = useCallback((fieldKey: string, header: string) => {
    setMappings(prev => {
      const next = { ...prev };
      if (header) next[fieldKey] = header;
      else delete next[fieldKey];
      return next;
    });
  }, []);

  const getPreviewData = () => {
    return fileData.slice(0, 5).map((row, idx) => {
      const previewRow: any = { _id: idx };
      SYSTEM_FIELDS.forEach(field => {
        if (mappings[field.key]) {
            previewRow[field.key] = row[mappings[field.key]];
        }
      });
      return previewRow;
    });
  };

  const finalizeImport = () => {
    const importedProfiles: FingerprintProfile[] = fileData.map((row, idx) => {
      const profile: any = {
        id: `import-${Date.now()}-${idx}`,
        status: BrowserStatus.IDLE,
        accountStatus: AccountStatus.UNKNOWN,
        lastActive: 'Never',
        cookiesCount: 0,
        platform: Platform.NONE,
        fingerprintProtection: { canvas: 'random', webgl: 'random', audio: 'random' },
        account: {},
        proxy: {},
        assets: {},
        startupUrls: []
      };

      SYSTEM_FIELDS.forEach(field => {
        const mappedHeader = mappings[field.key];
        if (mappedHeader && row[mappedHeader] !== undefined) {
           let value = row[mappedHeader];
           
           // Data Cleaning & Type Conversion
           if (typeof value === 'string') value = value.trim();

           if (field.key === 'platform') {
              const valStr = String(value).toLowerCase();
              if (valStr.includes('face') || valStr.includes('meta')) value = Platform.META;
              else if (valStr.includes('tik')) value = Platform.TIKTOK;
              else if (valStr.includes('google')) value = Platform.GOOGLE;
              else if (valStr.includes('twitter') || valStr.includes('x')) value = Platform.X;
              else value = Platform.NONE;
           }

           if (field.key === 'tags' && typeof value === 'string') {
             value = value.split(/[,|;]/).map((s: string) => s.trim()).filter(Boolean);
           }

           if (field.key === 'startupUrls' && typeof value === 'string') {
             value = value.split(/[,;\n\s]+/).map((s: string) => s.trim()).filter((s: string) => s.startsWith('http'));
           }
           
           if (field.key === 'accountStatus') {
             const valStr = String(value).toLowerCase();
             if (valStr.includes('active')) value = AccountStatus.ACTIVE;
             else if (valStr.includes('restrict')) value = AccountStatus.RESTRICTED;
             else if (valStr.includes('disable') || valStr.includes('ban')) value = AccountStatus.DISABLED;
             else if (valStr.includes('review')) value = AccountStatus.REVIEW;
             else value = AccountStatus.UNKNOWN;
           }

           // Assign to profile structure (handling nested keys)
           if (field.key.includes('.')) {
             const parts = field.key.split('.');
             let current = profile;
             for (let i = 0; i < parts.length - 1; i++) {
               if (!current[parts[i]]) current[parts[i]] = {};
               current = current[parts[i]];
             }
             current[parts[parts.length - 1]] = value;
           } else {
             profile[field.key] = value;
           }
        }
      });

      // 🌐 代理字符串 → 结构化字段：导入表里的代理通常是一整串（host:port:user:pass），
      //    只塞进 proxy.raw 的话后端结构化列全空、proxyEnabled 又是 false，代理等于没导入。
      //    显式映射了 proxy.host/port/... 的以显式值为准，缺的才用字符串解析结果补。
      const rawProxy = typeof profile.proxy?.raw === 'string' ? profile.proxy.raw.trim() : '';
      const parsedProxy = rawProxy ? parseProxyString(rawProxy) : undefined;
      if (parsedProxy) {
        profile.proxy.type = profile.proxy.type || parsedProxy.type;
        profile.proxy.host = profile.proxy.host || parsedProxy.host;
        profile.proxy.port = profile.proxy.port || parsedProxy.port;
        profile.proxy.username = profile.proxy.username || parsedProxy.username;
        profile.proxy.password = profile.proxy.password || parsedProxy.password;
      }
      // 只有真正拿到 host+port 才声明「启用代理」；否则**不带** proxyEnabled 字段，
      // 后端对 undefined 的处理是「不动代理列」——导入表格没映射代理列时就不会把已有代理清空。
      if (profile.proxy.host && profile.proxy.port) profile.proxyEnabled = true;

      return profile;
    });

    // 构建流程配置
    let flowSelection: FlowStepSelection | undefined;
    if (flowEnabled) {
      const enabledSteps = flowOrder.filter(sk => flowSteps[sk]);
      if (enabledSteps.length > 0) {
        flowSelection = {
          order: enabledSteps,
          templates: {
            ...(flowSteps.page && selPageTmpl ? { page: selPageTmpl } : {}),
            ...(flowSteps.billing && selBillingTmpl ? { billing: selBillingTmpl } : {}),
            ...(flowSteps.card && selCardTmpl ? { card: selCardTmpl } : {}),
            ...(flowSteps.publish && selAdTmpl ? { publish: selAdTmpl } : {}),
          }
        };
      }
    }
    onImport(importedProfiles, flowSelection);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col">
      {/* ===== Header ===== */}
      <div className="flex-shrink-0 px-5 py-2.5 flex justify-between items-center bg-slate-900 border-b border-slate-800">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-1.5">
            <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
            {t('importWizard.title')}
          </h2>
          <p className="text-[11px] text-slate-400 mt-0">
            {step === 1 && t('importWizard.steps.upload')}
            {step === 2 && t('importWizard.steps.map')}
            {step === 3 && t('importWizard.steps.preview')}
          </p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white p-1.5">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* ===== Content ===== */}
      <div className="flex-1 h-0 overflow-y-auto p-4 space-y-4">
        {step === 1 && (
          <div className="h-64 border-2 border-dashed border-slate-700 rounded-xl flex flex-col items-center justify-center hover:border-indigo-500 hover:bg-slate-800/50 transition-all cursor-pointer relative">
            <input type="file" accept=".xlsx, .xls, .csv" onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
            <Upload className="w-12 h-12 text-slate-500 mb-4" />
            <p className="text-lg font-medium text-slate-300">{t('importWizard.dragDrop')}</p>
            <p className="text-sm text-slate-500 mt-2">{t('importWizard.supportedFormats')}</p>
          </div>
        )}

        {step === 2 && (
          <>
            <div className="bg-indigo-900/20 border border-indigo-900/50 p-3 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0" />
              <p className="text-xs text-indigo-200">{t('importWizard.mappingHint')}</p>
            </div>
            <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-900/50">
              {SYSTEM_FIELDS.map((field) => (
                <div key={field.key} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-800/30 transition-colors">
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${mappings[field.key] ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                  <span className="text-xs text-slate-200 font-medium w-28 shrink-0">
                    {t(`importWizard.fields.${field.label}`, field.label)}
                    {field.key === 'name' && <span className="text-rose-500 ml-0.5">*</span>}
                  </span>
                  {field.key.includes('.') && (
                    <span className="text-[10px] text-slate-500 font-mono px-1 py-0.5 bg-slate-950 rounded border border-slate-700 shrink-0">{field.key}</span>
                  )}
                  <ArrowRight className="w-3 h-3 text-slate-600 shrink-0" />
                  <select
                    value={mappings[field.key] || ''}
                    onChange={(e) => handleMappingChange(field.key, e.target.value)}
                    className="flex-1 bg-slate-950 border border-slate-700 text-slate-300 rounded-md px-2 py-1.5 text-xs focus:ring-1 focus:ring-indigo-500 outline-none min-w-0"
                  >
                    <option value="">{t('importWizard.ignore')}</option>
                    {fileHeaders.map(h => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <div className="flex gap-4 h-full">
            {/* ===== LEFT: 流程面板 ===== */}
            <div className="w-56 shrink-0 space-y-3 min-w-0">
              <div className="bg-emerald-900/20 border border-emerald-900/50 p-2.5 rounded-lg flex items-start gap-2">
                <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                <p className="text-xs text-emerald-200">{t('importWizard.previewHint', { count: fileData.length })}</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer p-2.5 rounded-xl border border-slate-700 bg-slate-800/30">
                <input type="checkbox" checked={flowEnabled} onChange={(e) => setFlowEnabled(e.target.checked)} className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                <span className="text-xs font-medium text-white">导入后自动执行流程</span>
              </label>
              {flowEnabled && (
                <>
                  <div className="text-[11px] text-slate-500">执行步骤（调整顺序，✓启用）：</div>
                  <div className="space-y-1.5">
                    {flowOrder.map((sk, idx) => {
                      const def = FLOW_STEP_DEFS.find(d => d.key === sk);
                      if (!def) return null;
                      const en = flowSteps[sk];
                      return (
                        <div key={`${sk}_${idx}`} className={`flex items-center gap-1.5 p-2 rounded-lg border transition-colors ${en ? 'border-slate-600 bg-slate-800/80' : 'border-slate-700/50 bg-slate-800/30 opacity-60'}`}>
                          <div className="flex flex-col items-center gap-px shrink-0">
                            <button onClick={() => { const nu = [...flowOrder]; if (idx > 0) { [nu[idx-1], nu[idx]] = [nu[idx], nu[idx-1]]; setFlowOrder(nu); } }} disabled={idx === 0} className="text-slate-500 hover:text-white disabled:opacity-30"><ChevronUp className="w-2.5 h-2.5" /></button>
                            <GripVertical className="w-3 h-3 text-slate-500" />
                            <button onClick={() => { const nu = [...flowOrder]; if (idx < flowOrder.length-1) { [nu[idx], nu[idx+1]] = [nu[idx+1], nu[idx]]; setFlowOrder(nu); } }} disabled={idx === flowOrder.length-1} className="text-slate-500 hover:text-white disabled:opacity-30"><ChevronDown className="w-2.5 h-2.5" /></button>
                          </div>
                          <input type="checkbox" checked={en} onChange={() => setFlowSteps(prev => ({ ...prev, [sk]: !prev[sk] }))} className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-indigo-600 shrink-0" />
                          <span className={`${def.color} shrink-0`}>{getStepIcon(sk)}</span>
                          <span className="text-xs text-white font-medium flex-1 truncate">{idx+1}. {def.label}</span>
                          {en && sk === 'page' && (
                            <div className="flex items-center gap-1">
                              {resolvedPageTemplates.length > 0 && (
                                <select value={selPageTmpl} onChange={e => setSelPageTmpl(e.target.value)} className="bg-slate-950 border border-slate-700 text-white rounded text-[10px] px-1.5 py-0.5 max-w-[80px]">
                                  {resolvedPageTemplates.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                                </select>
                              )}
                              <button onClick={() => setShowPageCreator(true)} className="p-0.5 text-slate-500 hover:text-indigo-400 shrink-0" title="编辑主页配置"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l6.586-6.586z" /></svg></button>
                            </div>
                          )}
                          {en && sk === 'billing' && (
                            <div className="flex items-center gap-1">
                              {resolvedBillingTemplates.length > 0 && (
                                <select value={selBillingTmpl} onChange={e => setSelBillingTmpl(e.target.value)} className="bg-slate-950 border border-slate-700 text-white rounded text-[10px] px-1.5 py-0.5 max-w-[80px]">
                                  {resolvedBillingTemplates.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                                </select>
                              )}
                              <button onClick={() => setShowBillingEditor(true)} className="p-0.5 text-slate-500 hover:text-indigo-400 shrink-0" title="编辑账单配置"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l6.586-6.586z" /></svg></button>
                            </div>
                          )}
                          {en && sk === 'lang' && (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-slate-400 truncate max-w-[60px]">{langValue}</span>
                              <button onClick={() => setShowLangEditor(true)} className="p-0.5 text-slate-500 hover:text-indigo-400 shrink-0" title="选择语言"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l6.586-6.586z" /></svg></button>
                            </div>
                          )}
                          {en && sk === 'card' && (
                            <div className="flex items-center gap-1">
                              {resolvedCardTemplates.length > 0 && (
                                <select value={selCardTmpl} onChange={e => setSelCardTmpl(e.target.value)} className="bg-slate-950 border border-slate-700 text-white rounded text-[10px] px-1.5 py-0.5 max-w-[80px]">
                                  {resolvedCardTemplates.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                                </select>
                              )}
                              <button onClick={() => setShowCardEditor(true)} className="p-0.5 text-slate-500 hover:text-indigo-400 shrink-0" title="编辑绑卡配置"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l6.586-6.586z" /></svg></button>
                            </div>
                          )}
                          {en && sk === 'publish' && (
                            <div className="flex items-center gap-1">
                              {resolvedAdTemplates.length > 0 && (
                                <select value={selAdTmpl} onChange={e => setSelAdTmpl(e.target.value)} className="bg-slate-950 border border-slate-700 text-white rounded text-[10px] px-1.5 py-0.5 max-w-[80px]">
                                  <option value="">选择</option>
                                  {resolvedAdTemplates.map((t, i) => <option key={i} value={t.name}>{t.name}</option>)}
                                </select>
                              )}
                              <button onClick={() => setShowAdPublisher(true)} className="p-0.5 text-slate-500 hover:text-indigo-400 shrink-0" title="编辑广告配置"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l6.586-6.586z" /></svg></button>
                            </div>
                          )}
                          <button onClick={() => { const nu = [...flowOrder]; nu.splice(idx+1, 0, sk); setFlowOrder(nu); setFlowSteps(prev => ({ ...prev, [sk]: en })); }} className="p-0.5 text-slate-500 hover:text-indigo-400 shrink-0" title="复制"><Copy className="w-3 h-3" /></button>
                          <button onClick={() => { if (flowOrder.length <= 1) return; setFlowOrder(flowOrder.filter((_, i) => i !== idx)); }} className="p-0.5 text-slate-500 hover:text-red-400 shrink-0" title="删除"><Trash2 className="w-3 h-3" /></button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* ===== RIGHT: 数据预览 + 执行摘要 ===== */}
            <div className="flex-1 space-y-3 min-w-0">
              <details className="bg-slate-950 rounded-lg border border-slate-800" open>
                <summary className="px-3 py-2 text-xs text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none flex items-center gap-2 sticky top-0 bg-slate-950">
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-500" />
                  导入数据预览
                </summary>
                <div className="overflow-x-auto px-3 pb-3">
                  <table className="w-full text-left text-xs text-slate-400">
                    <thead className="text-slate-200 font-medium">
                      <tr>{SYSTEM_FIELDS.map(f => mappings[f.key] ? <th key={f.key} className="px-2 py-2 whitespace-nowrap">{t(`importWizard.fields.${f.label}`, f.label)}</th> : null)}</tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {getPreviewData().map((row: any, i) => (
                        <tr key={i}>{SYSTEM_FIELDS.map(f => mappings[f.key] ? <td key={f.key} className="px-2 py-1.5 max-w-[160px] truncate">{String(row[f.key] || '-')}</td> : null)}</tr>
                      ))}
                    </tbody>
                  </table>
                  {fileData.length > 5 && <p className="text-xs text-slate-500 mt-1">仅显示前 5 条，共 {fileData.length} 条记录</p>}
                </div>
              </details>
              {flowEnabled && (
                <div className="border border-slate-700 bg-slate-800/30 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Upload className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="text-xs font-medium text-white">执行摘要</span>
                  </div>
                  {(() => {
                    const enabledSteps = flowOrder.filter(sk => flowSteps[sk]);
                    if (enabledSteps.length === 0) return <p className="text-xs text-slate-500">未启用任何步骤，将仅导入账号</p>;
                    return (
                      <div className="space-y-1">
                        <p className="text-xs text-slate-400">将对 <span className="text-white font-medium">{fileData.length}</span> 个导入账号执行 <span className="text-white font-medium">{enabledSteps.length}</span> 个步骤：</p>
                        <div className="flex flex-wrap gap-1.5">
                          {enabledSteps.map((sk, i) => {
                            const def = FLOW_STEP_DEFS.find(d => d.key === sk);
                            if (!def) return null;
                            return <span key={sk} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${def.color} border-slate-600 bg-slate-800/60`}>{i+1}. {def.label}</span>;
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ===== Footer ===== */}
      <div className="flex-shrink-0 p-3 border-t border-slate-800 flex justify-between bg-slate-900">
        {step > 1 ? (
          <button onClick={() => setStep(step - 1 as 1 | 2)} className="flex items-center gap-2 px-4 py-2 text-slate-400 hover:text-white transition-colors">
            <ChevronLeft className="w-4 h-4" /> {t('importWizard.back')}
          </button>
        ) : <div />}
        <div className="flex gap-3">
          <button onClick={onClose} className="px-3 py-1.5 text-xs bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors">{t('importWizard.cancel')}</button>
          {step < 3 && (
            <button onClick={() => setStep(step + 1 as 2 | 3)} disabled={step === 1 && !fileName}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >{t('importWizard.next')} <ArrowRight className="w-3.5 h-3.5" /></button>
          )}
          {step === 3 && (
            <button onClick={finalizeImport} className="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors">
              {flowEnabled ? <><Upload className="w-3.5 h-3.5" /> 导入并执行</> : <><Save className="w-3.5 h-3.5" /> {t('importWizard.finish')}</>}
            </button>
          )}
        </div>
      </div>

      {/* ===== 编辑弹窗（在 ImportWizard 遮罩层外） ===== */}

      {/* 1. PageCreator */}
      {showPageCreator && (
        <PageCreator
          profileIds={[]}
          initialData={pageData || undefined}
          onCancel={() => setShowPageCreator(false)}
          onConfirm={async (data) => {
            setPageData(data);
            const name = selPageTmpl || `主页模板 ${resolvedPageTemplates.length + 1}`;
            const newTpl = { name, data };
            const existing = resolvedPageTemplates.filter(t => t.name !== name);
            const newList = [...existing, newTpl];
            localStorage.setItem('omnifingerprint_page_template_cache', JSON.stringify({ templates: newList, activeTemplate: name }));
            setLocalPageTemplates(newList);
            setSelPageTmpl(name);
            setShowPageCreator(false);
          }}
        />
      )}

      {/* 2. BillingEditor（完整账单配置含地址/城市/邮编/州省+随机勾选） */}
      {showBillingEditor && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={() => setShowBillingEditor(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <Globe className="w-5 h-5 text-emerald-400" />
              <span className="text-base font-semibold text-white">账单配置</span>
            </div>
            <div className="grid grid-cols-3 gap-x-4 gap-y-3">
              <div>
                <label className={labelCls}>国家</label>
                <select value={billingCountry} onChange={e => { setBillingCountry(e.target.value); setBillingCurrency(COUNTRY_CURRENCY[e.target.value] || billingCurrency); }} className={inputCls}>
                  {Object.keys(COUNTRY_CURRENCY).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>货币</label>
                <select value={billingCurrency} onChange={e => setBillingCurrency(e.target.value)} className={inputCls}>
                  {[...new Set(Object.values(COUNTRY_CURRENCY))].sort().map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>时区</label>
                <select value={billingTimezone} onChange={e => setBillingTimezone(e.target.value)} className={inputCls}>
                  {TZ_OPTIONS.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>街道地址</label>
                <div className="flex gap-1 items-center">
                  <input value={billingAddress} onChange={e => setBillingAddress(e.target.value)} disabled={billingAddressRandom} placeholder="地址" className={`${inputCls} flex-1 ${billingAddressRandom ? 'opacity-40' : ''}`} />
                  <label className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer whitespace-nowrap"><input type="checkbox" checked={billingAddressRandom} onChange={e => { setBillingAddressRandom(e.target.checked); if (e.target.checked) setBillingAddress(''); }} className="w-3 h-3" />随机</label>
                </div>
              </div>
              <div>
                <label className={labelCls}>城市</label>
                <div className="flex gap-1 items-center">
                  <input value={billingCity} onChange={e => setBillingCity(e.target.value)} disabled={billingCityRandom} placeholder="城市" className={`${inputCls} flex-1 ${billingCityRandom ? 'opacity-40' : ''}`} />
                  <label className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer whitespace-nowrap"><input type="checkbox" checked={billingCityRandom} onChange={e => { setBillingCityRandom(e.target.checked); if (e.target.checked) setBillingCity(''); }} className="w-3 h-3" />随机</label>
                </div>
              </div>
              <div>
                <label className={labelCls}>邮编</label>
                <div className="flex gap-1 items-center">
                  <input value={billingZip} onChange={e => setBillingZip(e.target.value)} disabled={billingZipRandom} placeholder="邮编" className={`${inputCls} flex-1 ${billingZipRandom ? 'opacity-40' : ''}`} />
                  <label className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer whitespace-nowrap"><input type="checkbox" checked={billingZipRandom} onChange={e => { setBillingZipRandom(e.target.checked); if (e.target.checked) setBillingZip(''); }} className="w-3 h-3" />随机</label>
                </div>
              </div>
              <div>
                <label className={labelCls}>州/省</label>
                <div className="flex gap-1 items-center">
                  <select value={billingState} onChange={e => setBillingState(e.target.value)} disabled={billingStateRandom} className={`${inputCls} flex-1 ${billingStateRandom ? 'opacity-40' : ''}`}>
                    <option value="">选择</option>
                    {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <label className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer whitespace-nowrap"><input type="checkbox" checked={billingStateRandom} onChange={e => { setBillingStateRandom(e.target.checked); if (e.target.checked) setBillingState(''); }} className="w-3 h-3" />随机</label>
                </div>
              </div>
              <div>
                <label className={labelCls}>FB界面语言</label>
                <select value={billingLang} onChange={e => setBillingLang(e.target.value)} className={inputCls}>
                  {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <div className="mt-3">
              <label className={labelCls}>公司名称（账单）</label>
              <input value={billingBusinessName} onChange={e => setBillingBusinessName(e.target.value)}
                placeholder="输入账单公司名称，如 Example Inc.（留空不修改）"
                className={inputCls} />
            </div>
            <div className="flex justify-end gap-3 mt-5">
              <button onClick={() => setShowBillingEditor(false)} className="px-4 py-2 text-xs bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700">取消</button>
              <button onClick={saveBillingTemplate} className="px-4 py-2 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 3. CardEditor（本地卡片多选 + 搜索/筛选 + 遍历模式） */}
      {showCardEditor && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={() => setShowCardEditor(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xl p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <CreditCard className="w-5 h-5 text-amber-400" />
              <span className="text-base font-semibold text-white">绑卡配置</span>
            </div>
            {/* 搜索/筛选栏 */}
            <div className="flex flex-wrap gap-2 mb-3">
              <input value={cardSearch} onChange={e => setCardSearch(e.target.value)} placeholder="搜索卡片别名/卡号/渠道..." className="flex-1 min-w-[100px] bg-slate-950 border border-slate-700 text-white rounded text-xs px-2 py-1.5" />
              <select value={cardFilterChannel} onChange={e => setCardFilterChannel(e.target.value)} className="bg-slate-950 border border-slate-700 text-white rounded text-xs px-2 py-1.5">
                <option value="">全部渠道</option>
                {allChannels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
              </select>
              <select value={cardFilterTag} onChange={e => setCardFilterTag(e.target.value)} className="bg-slate-950 border border-slate-700 text-white rounded text-xs px-2 py-1.5">
                <option value="">全部标签</option>
                {allTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            </div>
            {/* 遍历模式 */}
            <label className="flex items-center gap-2 mb-2 text-xs text-slate-400">
              <input type="checkbox" checked={cardIterateMode === 'cycle'} onChange={e => setCardIterateMode(e.target.checked ? 'cycle' : 'all')} className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
              遍历分配（循环分配，不足时重复使用卡片）
            </label>
            {/* 全选/取消 */}
            <div className="flex items-center gap-2 mb-2">
              <button onClick={selectAllFiltered} className="text-[10px] px-2 py-0.5 bg-slate-800 text-slate-300 rounded hover:bg-slate-700">全选筛选结果</button>
              <button onClick={() => setSelectedCardIds(new Set())} className="text-[10px] px-2 py-0.5 bg-slate-800 text-slate-300 rounded hover:bg-slate-700">取消所有</button>
              <span className="text-xs text-slate-500">已选 {selectedCardIds.size} 张</span>
            </div>
            {/* 卡片列表 */}
            <div className="max-h-40 overflow-y-auto space-y-1 border border-slate-700 rounded-lg p-2 bg-slate-950">
              {filteredCards.length === 0 && <p className="text-xs text-slate-500 text-center py-4">暂无匹配卡片（可在首页添加卡片）</p>}
              {filteredCards.map((c: any) => {
                const cid = c.id || c.card_id || '';
                return (
                  <label key={cid} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800/60 cursor-pointer">
                    <input type="checkbox" checked={selectedCardIds.has(cid)} onChange={() => toggleCard(cid)} className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                    <span className="text-xs text-slate-200 flex-1 truncate">{c.alias || c.cardNumber?.slice(-4) || cid}</span>
                    {c.channel && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-cyan-400">{c.channel}</span>}
                    {(c.tags||[]).map((tag: string) => <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{tag}</span>)}
                  </label>
                );
              })}
            </div>
            {/* 手动绑卡 */}
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-800">
              <span className="text-xs text-slate-500">{manualCardData ? `手动卡片: ****${manualCardData.cardNumber?.slice(-4) || ''}` : '未添加手动卡片'}</span>
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                <input type="checkbox" checked={checkBillingParams} onChange={e => setCheckBillingParams(e.target.checked)} className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                检查国家/货币/时区
              </label>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => setShowCardEditor(false)} className="px-4 py-2 text-xs bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700">取消</button>
              <button onClick={() => {
                const name = selCardTmpl || `卡片模板 ${resolvedCardTemplates.length + 1}`;
                const data = { selectedCardIds: Array.from(selectedCardIds), iterateMode: cardIterateMode, checkBillingParams, cardFilterChannel, cardFilterTag };
                const existing = resolvedCardTemplates.filter(t => t.name !== name);
                const newList = [...existing, { name, data }];
                localStorage.setItem('omnifingerprint_card_template_cache', JSON.stringify({ templates: newList, activeTemplate: name }));
                setLocalCardTemplates(newList);
                setSelCardTmpl(name);
                setShowCardEditor(false);
              }} className="px-4 py-2 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 3.5 LangEditor（语言选择） */}
      {showLangEditor && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={() => setShowLangEditor(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <Globe className="w-5 h-5 text-purple-400" />
              <span className="text-base font-semibold text-white">选择界面语言</span>
            </div>
            <select value={langValue} onChange={e => setLangValue(e.target.value)} className={inputCls}>
              {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowLangEditor(false)} className="px-4 py-2 text-xs bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700">取消</button>
              <button onClick={() => { setShowLangEditor(false); }} className="px-4 py-2 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* 4. FacebookAdPublisher */}
      {showAdPublisher && (
        <FacebookAdPublisher
          profileIds={[]}
          templateMode={true}
          onCancel={() => setShowAdPublisher(false)}
          onConfirm={(data) => {
            setAdPublishData(data);
            setShowAdPublisher(false);
          }}
        />
      )}
    </div>
  );
};
