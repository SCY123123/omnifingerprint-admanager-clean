import React, { useState, useEffect } from 'react';
import { X, Send, Upload, Image as ImageIcon, CheckCircle2, DollarSign, Type, Layout, Globe, Users, Monitor, Calendar, Shield, Smartphone, Zap, MessageSquare, Layers, Settings, Target, Eye, FileText, Save, ChevronDown, Trash2, Power, Search, Link, Pencil, Copy, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const FB_LANGUAGES = [
  { code: 'zh_CN', name: '简体中文 (Chinese, Simplified)' },
  { code: 'zh_TW', name: '繁体中文 (Chinese, Traditional)' },
  { code: 'en_US', name: '英文 (English, US)' },
  { code: 'en_GB', name: '英文 (English, UK)' },
  { code: 'ja_JP', name: '日语 (Japanese)' },
  { code: 'ko_KR', name: '韩语 (Korean)' },
  { code: 'ru_RU', name: '俄语 (Russian)' },
  { code: 'de_DE', name: '德语 (German)' },
  { code: 'fr_FR', name: '法语 (French)' },
  { code: 'es_LA', name: '西班牙语 (Spanish, Latin America)' },
  { code: 'pt_BR', name: '葡萄牙语 (Portuguese, Brazil)' },
  { code: 'vi_VN', name: '越南语 (Vietnamese)' },
  { code: 'th_TH', name: '泰语 (Thai)' },
  { code: 'id_ID', name: '印尼语 (Indonesian)' },
  { code: 'ms_MY', name: '马来语 (Malay)' }
];

// 🚀 广告创意语言列表（Facebook 支持的多语言广告语言）
const AD_CREATIVE_LANGUAGES = [
  { code: 'en', name: '英语 (English)' },
  { code: 'zh', name: '中文 (Chinese)' },
  { code: 'zh_HK', name: '中文(香港) (Chinese, Hong Kong)' },
  { code: 'ja', name: '日语 (Japanese)' },
  { code: 'ko', name: '韩语 (Korean)' },
  { code: 'es', name: '西班牙语 (Spanish)' },
  { code: 'pt', name: '葡萄牙语 (Portuguese)' },
  { code: 'fr', name: '法语 (French)' },
  { code: 'de', name: '德语 (German)' },
  { code: 'it', name: '意大利语 (Italian)' },
  { code: 'nl', name: '荷兰语 (Dutch)' },
  { code: 'pl', name: '波兰语 (Polish)' },
  { code: 'ru', name: '俄语 (Russian)' },
  { code: 'ar', name: '阿拉伯语 (Arabic)' },
  { code: 'tr', name: '土耳其语 (Turkish)' },
  { code: 'th', name: '泰语 (Thai)' },
  { code: 'vi', name: '越南语 (Vietnamese)' },
  { code: 'id', name: '印尼语 (Indonesian)' },
  { code: 'ms', name: '马来语 (Malay)' },
  { code: 'sv', name: '瑞典语 (Swedish)' },
  { code: 'da', name: '丹麦语 (Danish)' },
  { code: 'fi', name: '芬兰语 (Finnish)' },
  { code: 'nb', name: '挪威语 (Norwegian)' },
  { code: 'cs', name: '捷克语 (Czech)' },
  { code: 'hu', name: '匈牙利语 (Hungarian)' },
  { code: 'ro', name: '罗马尼亚语 (Romanian)' },
  { code: 'sk', name: '斯洛伐克语 (Slovak)' },
  { code: 'bg', name: '保加利亚语 (Bulgarian)' },
  { code: 'hr', name: '克罗地亚语 (Croatian)' },
  { code: 'sr', name: '塞尔维亚语 (Serbian)' },
  { code: 'uk', name: '乌克兰语 (Ukrainian)' },
  { code: 'el', name: '希腊语 (Greek)' },
  { code: 'he', name: '希伯来语 (Hebrew)' },
  { code: 'hi', name: '印地语 (Hindi)' },
  { code: 'bn', name: '孟加拉语 (Bengali)' },
  { code: 'ta', name: '泰米尔语 (Tamil)' },
  { code: 'te', name: '泰卢固语 (Telugu)' },
  { code: 'mr', name: '马拉地语 (Marathi)' },
  { code: 'gu', name: '古吉拉特语 (Gujarati)' },
  { code: 'kn', name: '卡纳达语 (Kannada)' },
  { code: 'ml', name: '马拉雅拉姆语 (Malayalam)' },
  { code: 'pa', name: '旁遮普语 (Punjabi)' },
  { code: 'ur', name: '乌尔都语 (Urdu)' },
  { code: 'ne', name: '尼泊尔语 (Nepali)' },
  { code: 'si', name: '僧伽罗语 (Sinhala)' },
  { code: 'km', name: '高棉语 (Khmer)' },
  { code: 'lo', name: '老挝语 (Lao)' },
  { code: 'my', name: '缅甸语 (Burmese)' },
  { code: 'mn', name: '蒙古语 (Mongolian)' },
  { code: 'kk', name: '哈萨克语 (Kazakh)' },
  { code: 'uz', name: '乌兹别克语 (Uzbek)' },
  { code: 'az', name: '阿塞拜疆语 (Azerbaijani)' },
  { code: 'ka', name: '格鲁吉亚语 (Georgian)' },
  { code: 'hy', name: '亚美尼亚语 (Armenian)' },
  { code: 'fa', name: '波斯语 (Persian)' },
  { code: 'ps', name: '普什图语 (Pashto)' },
  { code: 'sw', name: '斯瓦希里语 (Swahili)' },
  { code: 'ha', name: '豪萨语 (Hausa)' },
  { code: 'am', name: '阿姆哈拉语 (Amharic)' },
  { code: 'tl', name: '菲律宾语 (Filipino)' },
  { code: 'ca', name: '加泰罗尼亚语 (Catalan)' },
  { code: 'eu', name: '巴斯克语 (Basque)' },
  { code: 'gl', name: '加利西亚语 (Galician)' },
  { code: 'af', name: '南非语/Afrikaans' },
  { code: 'zu', name: '祖鲁语 (Zulu)' },
  { code: 'xh', name: '科萨语 (Xhosa)' },
];

interface FacebookAdPublisherProps {
  onCancel: () => void;
  onConfirm: (data: AdPublishData) => void;
  profileIds: string[];
  templateMode?: boolean;
  initialTemplate?: AdTemplate | null;
}

export interface AdPublishData {
  publishMethod: 'api' | 'puppeteer';
  launchBrowser: boolean;
  campaignTree: CampaignData[];
  mediaBase64List?: string[];
  campaignCount?: number; // 🚀 发布时系列复制数量
  adSetCount?: number;    // 🚀 发布时广告组复制数量
  adCount?: number;       // 🚀 发布时广告复制数量
}

// ===== 系列级配置 =====
interface CampaignData {
  id: string;
  name: string;
  objective: 'OUTCOME_SALES' | 'OUTCOME_TRAFFIC' | 'OUTCOME_ENGAGEMENT' | 'OUTCOME_AWARENESS' | 'OUTCOME_LEADS' | 'OUTCOME_APP_PROMOTION' | 'OUTCOME_BRAND_AWARENESS' | 'REACH' | 'VIDEO_VIEWS' | 'MESSAGES' | 'CATALOG_SALES' | 'STORE_VISITS';
  buyingType: 'AUCTION' | 'RESERVED';
  specialAdCategories: string[];
  budget: string;
  budgetType: 'DAILY' | 'LIFETIME';
  budgetLevel: 'CAMPAIGN' | 'ADSET';
  startDate: string;
  endDate?: string;
  adSchedule?: any[];
  timezone?: string;
  campaignStatus: 'ACTIVE' | 'PAUSED';
  autoActivate: boolean;
  skipIfAdExists: boolean;
  campaignCount?: number; // 🚀 右侧面板设置的发布时复制数量
  bidStrategy?: 'LOWEST_COST_WITHOUT_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'COST_CAP' | 'BID_CAP' | 'TARGET_COST' | 'ROAS';
  bidAmount?: string;
  pacingType?: 'standard' | 'no_pacing';
  costPerResult?: string;
  targetRoas?: string;
  conversionAttributionWindow?: string;
  brandSafety?: boolean;
  brandSuitability?: string;
  catalogId?: string;
  appId?: string;
  storeUrl?: string;
  advantageCampaignBudget?: boolean;
  enableAdvantageCampaign?: boolean;
  adSets: AdSetData[];
}

// 🔧 「优化目标」历史取值 → Meta 官方枚举名。
//    早期下拉用的 value 是 MESSAGES / CONVERSIONS，而 Meta 的 optimization_goal 枚举叫
//    REPLIES / OFFSITE_CONVERSIONS —— 旧值直接发出去会被 Meta 拒（或静默落到别的目标）。
//    这里在读模板时统一迁移；后端 facebook-ad-publish.js 也保留了同样的别名兜底。
const OPT_GOAL_LEGACY: Record<string, string> = { MESSAGES: 'REPLIES', CONVERSIONS: 'OFFSITE_CONVERSIONS' };

// 🎯 CTA 与优化目标的匹配关系（后端 facebook-ad-publish.js 的 DEFAULT_CTA_BY_GOAL 与此保持一致）。
//    以前 CTA 默认恒为「了解更多」，主页赞/消息类广告会带一个完全不匹配的按钮，
//    在 Ads Manager 里看着就像网站类广告。这里按优化目标推导出应选的行动按钮。
const CTA_BY_OPT_GOAL: Record<string, string> = {
  PAGE_LIKES: 'LIKE_PAGE',
  POST_ENGAGEMENT: 'LIKE_PAGE',
  REPLIES: 'MESSAGE_PAGE',
};
const deriveCta = (goal?: string) => CTA_BY_OPT_GOAL[String(goal || '').toUpperCase()] || '';

// ===== 广告组级配置 =====
interface AdSetData {
  id: string;
  name: string;
  optimizationGoal: string;
  adSetCount?: number; // 🚀 右侧面板设置的发布时复制数量
  countries: string;
  cityTargeting?: string;
  regionTargeting?: string;
  zips?: string;
  dma?: string;
  locationType: 'home' | 'recent' | 'traveling' | 'all';
  radius?: string;
  excludeLocations?: string;
  ageMin: string;
  ageMax: string;
  enableAgeModify?: boolean; // 🚀 发布后修改年龄
  ageMinModify?: string;     // 🚀 发布后修改的最小年龄
  ageMaxModify?: string;     // 🚀 发布后修改的最大年龄
  ageRange?: string;         // 🚀 建议受众年龄范围（Advantage+ AI 起始推荐）
  gender: 'all' | 'male' | 'female';
  placements: 'automatic' | 'manual';
  placementsControl?: string;
  devicePlatforms: ('mobile' | 'desktop')[];
  osType: 'all' | 'ios' | 'android';
  osVersionMin: string;
  osVersionMax?: string;
  deviceModels?: string;
  wifiOnly: boolean;
  carrierTargeting?: string;
  connectionSpeed?: string;
  enableAdvantageAudience: boolean;
  enableAudienceExpansion?: boolean; // 🚀 横向扩展受众
  languages?: string;
  detailedTargeting?: string;
  detailedExclusions?: string;
  customAudiencesInclude?: string;
  customAudiencesExclude?: string;
  excludedConnections?: string;
  friendsOfConnections?: boolean;
  broadTargeting?: boolean;
  allowLimitedSpendOnExcluded?: boolean;
  lifeEvents?: string;
  parents?: string;
  relationshipStatus?: string;
  education?: string;
  college?: string;
  workEmployer?: string;
  income?: string;
  homeOwnership?: string;
  householdComposition?: string;
  ethnicAffinity?: string;
  generation?: string;
  digitalActivities?: string;
  politics?: string;
  adSetStatus: 'ACTIVE' | 'PAUSED';
  adAccountId?: string;
  pageId?: string;
  advertiserName?: string;
  beneficiary?: string;
  customerLifecycle?: string;
  attributionModel?: string;
  budget?: string;
  bidAmount?: string;
  costCap?: string;
  minRoas?: string;
  deliveryType?: 'standard' | 'accelerated';
  dayparting?: string;
  conversionWindow?: string;
  enableVO: boolean;
  ads: AdData[];
}

// ===== 广告级配置 =====
interface AdData {
  id: string;
  name: string;
  adCount?: number; // 🚀 右侧面板设置的发布时复制数量
  adText: string;
  adText2?: string;
  headline: string;
  headline2?: string;
  adDescription?: string;
  adDescription2?: string;
  websiteUrl: string;
  displayLink?: string;
  useDisplayLink: boolean;
  deepLink?: string;
  ctaType: string;
  // 用户是否手动改过 CTA：手动改过就不再被「优化目标联动」覆盖
  ctaManuallySet?: boolean;
  adFormat: 'SINGLE_IMAGE_VIDEO' | 'CAROUSEL' | 'COLLECTION' | 'INSTANT_EXPERIENCE' | 'DYNAMIC';
  enableAdvantageCreative: boolean;
  enableDynamicCreative: boolean;
  pixelIds?: string[];
  conversionEvent?: string;
  adStatus: 'ACTIVE' | 'PAUSED';
  engagementType?: 'MESSAGES' | 'PAGE_LIKES' | 'POST_ENGAGEMENT';
  leadFormId?: string;
  messengerWelcomeMessage?: string;
  enableVO: boolean;
  urlParams?: string;
  mediaFiles?: File[];
  videoFile?: File;
  videoThumbnailUrl?: string;
  videoThumbnailIndex?: number;
  instantExperienceId?: string;
  offerId?: string;
  offerDescription?: string;
  callToActionCustom?: string;
  productCatalogId?: string;
  productSetId?: string;
  adTextOptions?: string[];
  headlineOptions?: string[];
  descriptionOptions?: string[];
  mediaOptions?: string[];
  // 🚀 进阶赋能型创意子选项
  enableEnhancements?: boolean;       // 总开关：所有优化功能
  enhancementOverlayText?: boolean;   // 叠加文字
  enhancementVisualPolish?: boolean;  // 视觉润色
  enhancementAddMusic?: boolean;      // 添加音乐
  enhancementCopyImprove?: boolean;   // 文案改进
  enhancementAddAnimation?: boolean;  // 添加动画
  // 🚀 多语言广告
  enableLanguage?: boolean;           // 语言开关
  primaryLanguage?: string;           // 默认语言
  additionalLanguages?: string[];     // 备选语言列表
  languageContent?: Record<string, {  // 🚀 各语言独立内容
    headline: string;
    body: string;
    description: string;
    websiteUrl?: string;
    mediaFiles?: File[];              // 未上传的文件
    mediaBase64List?: string[];       // 已转为 base64 的素材列表
    mediaHashes?: string[];           // 上传成功后的 hash 列表
    uploadedMediaIds?: string[];      // 后台返回的 media id
  }>;
}

interface AdTemplate { id: number; name: string; is_default: number; config: string; }

const uid = () => Math.random().toString(36).slice(2, 8);

const createDefaultCampaign = (nameSuffix?: string, adSetCount?: number, adCount?: number): CampaignData => {
  const asCount = adSetCount || 1;
  const aCount = adCount || 1;
  return {
    id: uid(),
    name: `Campaign_${new Date().toISOString().split('T')[0]}${nameSuffix ? '_' + nameSuffix : ''}`,
    objective: 'OUTCOME_TRAFFIC',
    buyingType: 'AUCTION',
    specialAdCategories: [],
    budget: '5.00',
    budgetType: 'DAILY',
    budgetLevel: 'ADSET',
    startDate: new Date().toISOString().split('T')[0],
    campaignStatus: 'PAUSED',
    autoActivate: false,
    skipIfAdExists: false,
    pacingType: 'standard',
    conversionAttributionWindow: '7d_click_1d_view',
    brandSafety: false,
    brandSuitability: 'standard',
    advantageCampaignBudget: false,
    enableAdvantageCampaign: false,
    // ⚠️ 必须显式给默认值：下拉框的「最低成本(无上限)」只是显示兜底(campaign.bidStrategy || 'LOWEST_COST_WITHOUT_CAP')，
    //    真实值若为 undefined 会被 JSON.stringify 丢掉，服务端收不到策略 → FB 回退到账号默认竞价策略并要求 bid_amount
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    adSets: Array.from({length: asCount}, (_, si) => ({
      id: uid(),
      name: `Ad Set ${si + 1}`,
      optimizationGoal: 'LINK_CLICKS',
      countries: 'US',
      locationType: 'all',
      ageMin: '18', ageMax: '65', ageRange: '45',
      gender: 'all',
      placements: 'automatic',
      devicePlatforms: ['mobile', 'desktop'],
      osType: 'all', osVersionMin: '0', osVersionMax: '0', wifiOnly: false,
      connectionSpeed: 'any',
      enableAdvantageAudience: true,
      enableAudienceExpansion: true,
      broadTargeting: true,
      // ⚠️ 必须给默认值：下拉框显示的是「促进所有受众发生转化」，但真实值若为 undefined
      //    会被 JSON.stringify 丢掉，服务端收不到 → 客户生命周期不生效（表现为"选了但没发"）
      customerLifecycle: 'ALL',
      allowLimitedSpendOnExcluded: false,
      friendsOfConnections: false,
      deliveryType: 'standard',
      // ⚠️ 这里不再写死 conversionWindow 默认值：写死会让广告组层永远覆盖广告系列层的
      //    「转化归因窗口」，导致系列面板上选的窗口不生效（服务端按 adset > campaign 取值）。
      //    下拉框用 `adSet.conversionWindow || '7d_click_1d_view'` 显示兜底即可。
      enableVO: false,
      adSetStatus: 'PAUSED',
      ads: Array.from({length: aCount}, (_, ai) => ({
        id: uid(),
        name: `Ad ${ai + 1}`,
        adText: '', headline: '',
        websiteUrl: '', displayLink: '', useDisplayLink: false,
        deepLink: '',
        ctaType: 'LEARN_MORE', adFormat: 'SINGLE_IMAGE_VIDEO',
        enableAdvantageCreative: true,
        enableDynamicCreative: false,
        enableEnhancements: true,
        enhancementOverlayText: true,
        enhancementVisualPolish: true,
        enhancementAddMusic: true,
        enhancementCopyImprove: true,
        enhancementAddAnimation: true,
        adStatus: 'ACTIVE', enableVO: false,
        enableLanguage: false,
        primaryLanguage: '',
        additionalLanguages: []
      }))
    }))
  };
};

type SelectedLevel = 'campaign' | 'adset' | 'ad';

let sessionMediaCache: { [adId: string]: File[] } = {};

export const FacebookAdPublisher: React.FC<FacebookAdPublisherProps> = ({ onCancel, onConfirm, profileIds, templateMode, initialTemplate }) => {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<any[]>([]);
  const [tree, setTree] = useState<CampaignData[]>([createDefaultCampaign()]);
  const [selectedType, setSelectedType] = useState<SelectedLevel>('campaign');
  const [selectedCampaignIdx, setSelectedCampaignIdx] = useState(0);
  const [selectedAdSetIdx, setSelectedAdSetIdx] = useState(0);
  const [selectedAdIdx, setSelectedAdIdx] = useState(0);
  const [publishMethod, setPublishMethod] = useState<'api' | 'puppeteer'>('api');
  const [launchBrowser, setLaunchBrowser] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [campaignQty, setCampaignQty] = useState(1);
  // 🚀 每个节点独立数量控制（keyed by node id）
  const [adSetQtyByCampaign, setAdSetQtyByCampaign] = useState<Record<string, number>>({});
  const [adQtyByAdSet, setAdQtyByAdSet] = useState<Record<string, number>>({});
  // 🚨 提示：切换到非「销量」目标时自动关掉了「进阶赋能型销量广告系列」
  const [advAutoOffHint, setAdvAutoOffHint] = useState(false);
  const getAdSetQty = (campaignId: string) => adSetQtyByCampaign[campaignId] || 1;
  const setAdSetQty = (campaignId: string, v: number) => setAdSetQtyByCampaign(prev => ({ ...prev, [campaignId]: v }));
  const getAdQty = (adSetId: string) => adQtyByAdSet[adSetId] || 1;
  const setAdQty = (adSetId: string, v: number) => setAdQtyByAdSet(prev => ({ ...prev, [adSetId]: v }));

  const [deviceModelsOpen, setDeviceModelsOpen] = useState(false);

  // ===== 设备型号列表 =====
  // 🚀 Meta 官方 user_device 合法值（家族级，来源 targeting search: class=user_device）
  //    ⚠️ 不能用 iPhone_14 / SM-S928B 这类机型 ID：Meta 只接受家族名（iPhone / iPad / iPod /
  //       Android_Smartphone / Android_Tablet）或小写带空格的具体机型名，非法值会被 FB 直接拒绝
  const DEVICE_MODELS = [
    { id: 'iPhone', label: 'iPhone', os: 'ios' },
    { id: 'iPad', label: 'iPad', os: 'ios' },
    { id: 'iPod', label: 'iPod', os: 'ios' },
    { id: 'Android_Smartphone', label: 'Android 手机', os: 'android' },
    { id: 'Android_Tablet', label: 'Android 平板', os: 'android' },
  ];

  // ===== OS 版本清单（硬编码全量子版本，如 14.0 / 17.2）=====
  // 🚀 不再依赖 Meta 拉取：Targeting Search 常拿不到清单，直接内置完整版本列表
  const [osVersions, setOsVersions] = useState<{ ios: string[]; android: string[] }>({
    ios: [
      '18.0', '17.7', '17.6', '17.5', '17.4', '17.3', '17.2', '17.1', '17.0',
      '16.7', '16.6', '16.5', '16.4', '16.3', '16.2', '16.1', '16.0',
      '15.7', '15.6', '15.5', '15.4', '15.3', '15.2', '15.1', '15.0',
      '14.8', '14.7', '14.6', '14.5', '14.4', '14.3', '14.2', '14.1', '14.0',
      '13.7', '13.6', '13.5', '13.4', '13.3', '13.2', '13.1', '13.0',
      '12.5', '12.4', '12.3', '12.2', '12.1', '12.0',
      '11.4', '11.3', '11.2', '11.1', '11.0',
      '10.3', '10.2', '10.1', '10.0',
      '9.3', '9.2', '9.1', '9.0',
      '8.4', '8.3', '8.2', '8.1', '8.0',
    ],
    android: [
      '15.0', '14.0', '13.0', '12.0', '11.0', '10.0',
      '9.0', '8.1', '8.0', '7.1', '7.0', '6.0', '5.1', '5.0', '4.4',
    ],
  });
  const [availableAccounts, setAvailableAccounts] = useState<any[]>([]);
  const [availablePages, setAvailablePages] = useState<any[]>([]);
  const [availablePixels, setAvailablePixels] = useState<any[]>([]);

  const [mediaLibrary, setMediaLibrary] = useState<any[]>([]);
  const [showMediaLibrary, setShowMediaLibrary] = useState(false);
  const [mediaLibLoading, setMediaLibLoading] = useState(false);

  const [templates, setTemplates] = useState<AdTemplate[]>([]);
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<AdTemplate | null>(initialTemplate || null);
  const [templateRenameId, setTemplateRenameId] = useState<number | null>(null);
  const [templateRenameValue, setTemplateRenameValue] = useState('');
  // 🚀 模板模式下记录当前编辑的模板名称
  const [templateName, setTemplateName] = useState(initialTemplate?.name || '');

  const campaign = tree[selectedCampaignIdx] || tree[0];
  const adSet = campaign?.adSets[selectedAdSetIdx] || campaign?.adSets[0];
  const ad = adSet?.ads[selectedAdIdx] || adSet?.ads[0];

  const filteredAccounts = availableAccounts.filter(acc => profileIds.includes(String(acc.profile_id || acc.profileId || '')));
  const selectedAccount = availableAccounts.find(a => String(a.account_id || a.id) === adSet?.adAccountId);
  const activeProfileId = selectedAccount?.profile_id || selectedAccount?.profileId || (profileIds.length === 1 ? profileIds[0] : null);
  const filteredPages = availablePages.filter(pg => !activeProfileId || String(pg.profile_id || pg.profileId) === String(activeProfileId));
  const filteredPixels = availablePixels.filter(px => {
    const pxProfile = String(px.profile_id || px.profileId || '');
    if (!adSet?.adAccountId) return profileIds.includes(pxProfile);
    return pxProfile === String(activeProfileId);
  });

  const updateCampaign = (idx: number, upd: Partial<CampaignData>) => {
    setTree(prev => { const n = [...prev]; n[idx] = { ...n[idx], ...upd }; return n; });
  };
  const updateAdSet = (cIdx: number, asIdx: number, upd: Partial<AdSetData>) => {
    setTree(prev => { const n = [...prev]; n[cIdx] = { ...n[cIdx], adSets: [...n[cIdx].adSets] }; n[cIdx].adSets[asIdx] = { ...n[cIdx].adSets[asIdx], ...upd }; return n; });
  };
  const updateAd = (cIdx: number, asIdx: number, aIdx: number, upd: Partial<AdData>) => {
    setTree(prev => { const n = [...prev]; n[cIdx] = { ...n[cIdx], adSets: [...n[cIdx].adSets] }; n[cIdx].adSets[asIdx] = { ...n[cIdx].adSets[asIdx], ads: [...n[cIdx].adSets[asIdx].ads] }; n[cIdx].adSets[asIdx].ads[aIdx] = { ...n[cIdx].adSets[asIdx].ads[aIdx], ...upd }; return n; });
  };
  // 🚀 切换「广告目标」时同步各广告的「转化事件」默认值：
  //    线索目标 → 潜在客户(LEAD)，销量目标 → 购买(PURCHASE)。
  //    ⚠️ 只修正「未设置」或仍是另一目标默认值的广告，用户主动选的其它事件（加购/注册等）不覆盖。
  //    否则会出现「目标选了线索、优化事件还是购买」，发出去在 Ads Manager 里就不是"潜在客户"。
  const applyObjective = (cIdx: number, objective: CampaignData['objective']) => {
    const wantEvent = objective === 'OUTCOME_LEADS' ? 'LEAD' : objective === 'OUTCOME_SALES' ? 'PURCHASE' : null;
    // 🚨 进阶赋能型销量广告系列只支持「销量」目标（后端会强制把 objective 改成 OUTCOME_SALES），
    //    所以切到非销量目标时自动关掉该开关，避免"选了线索却发成销量"
    const turningAdvOff = objective !== 'OUTCOME_SALES' && !!tree[cIdx]?.enableAdvantageCampaign;
    setTree(prev => {
      const n = [...prev];
      const c = { ...n[cIdx], objective };
      if (turningAdvOff) c.enableAdvantageCampaign = false;
      if (wantEvent) {
        c.adSets = (c.adSets || []).map(as => ({
          ...as,
          ads: (as.ads || []).map(a => (!a.conversionEvent || a.conversionEvent === 'PURCHASE' || a.conversionEvent === 'LEAD')
            ? { ...a, conversionEvent: wantEvent } : a)
        }));
      }
      n[cIdx] = c;
      return n;
    });
    setAdvAutoOffHint(turningAdvOff);
  };

  // 🎯 切换「优化目标」时联动 CTA 按钮：主页赞/帖子互动 → 赞主页(LIKE_PAGE)，消息 → 发消息(MESSAGE_PAGE)。
  //    ⚠️ 默认的「了解更多」不算用户的选择，会被目标推导覆盖（与后端 facebook-ad-publish.js 口径一致）；
  //       只有用户选过别的 CTA（ctaManuallySet 且非 LEARN_MORE）才保留。
  const applyOptimizationGoal = (cIdx: number, asIdx: number, goal: string) => {
    const derived = deriveCta(goal);
    setTree(prev => {
      const n = [...prev];
      const c = { ...n[cIdx], adSets: [...n[cIdx].adSets] };
      const as = { ...c.adSets[asIdx], optimizationGoal: goal };
      if (derived) {
        as.ads = (as.ads || []).map(a => ((a.ctaManuallySet && a.ctaType && a.ctaType !== 'LEARN_MORE') ? a : { ...a, ctaType: derived }));
      }
      c.adSets[asIdx] = as;
      n[cIdx] = c;
      return n;
    });
  };

  // 🚀 base64 还原为 File 对象（模板加载图片用）
  const base64ToFile = (dataUrl: string, fileName: string): File | null => {
    try {
      const parts = dataUrl.split(',');
      if (parts.length !== 2) return null;
      const mimeMatch = parts[0].match(/:(.*?);/);
      const mime = mimeMatch?.[1] || 'image/jpeg';
      const raw = atob(parts[1]);
      const ab = new ArrayBuffer(raw.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < raw.length; i++) ia[i] = raw.charCodeAt(i);
      return new File([ab], fileName, { type: mime });
    } catch { return null; }
  };

  useEffect(() => {
    fetchTemplates(templateMode ? false : true); // 模板模式不自动加载默认模板
    if (!templateMode) { fetchProfiles(); fetchAssets(); }
    // 模板模式下加载初始模板配置
    if (templateMode && initialTemplate) {
      try {
        const config = JSON.parse(initialTemplate.config);
        if (config.campaignTree) {
          // 🚀 还原 _mediaBase64 为 File 对象到 sessionMediaCache
          const restoredTree = JSON.parse(JSON.stringify(config.campaignTree));
          for (const c of restoredTree) {
            for (const as of c.adSets) {
              // ⚠️ 旧模板没有该字段 → 补默认，否则客户生命周期不会被下发
              if (!as.customerLifecycle) as.customerLifecycle = 'ALL';
              // 🔧 优化目标旧值迁移，否则下拉框会显示空白
              if (OPT_GOAL_LEGACY[as.optimizationGoal]) as.optimizationGoal = OPT_GOAL_LEGACY[as.optimizationGoal];
              for (const a of as.ads) {
                // ⚠️ 旧模板可能存了 videoFile: {}（File 序列化后的空对象）→ 清掉，
                //    否则界面会误显示「已选视频」且发布时报 FileReader 类型错误
                if (a.videoFile && !(a.videoFile instanceof Blob)) delete a.videoFile;
                // 🎯 旧模板的 CTA 多半还是默认的「了解更多」，按优化目标纠正一次。
                //    默认的「了解更多」不算用户的选择，所以同样纠正（只有选过别的 CTA 才保留）。
                const _derivedCta = deriveCta(as.optimizationGoal);
                if (_derivedCta && (!a.ctaType || a.ctaType === 'LEARN_MORE')) a.ctaType = _derivedCta;
                const b64 = a._mediaBase64;
                if (b64) {
                  const file = base64ToFile(b64, `template_media_${a.id}.jpg`);
                  if (file) {
                    sessionMediaCache[a.id] = [file];
                  }
                }
                delete a._mediaBase64; // 清理临时字段
              }
            }
          }
          setTree(restoredTree);
        }
        if (config.publishMethod) setPublishMethod(config.publishMethod);
        if (config.launchBrowser !== undefined) setLaunchBrowser(config.launchBrowser);
      } catch (e) { console.error('Failed to load initial template:', e); }
    }
  }, []);
  const fetchMediaLibrary = async () => {
    setMediaLibLoading(true);
    try {
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;
      const resp = await fetch('/api/media', { headers: { 'Authorization': `Bearer ${authToken}` } }).then(r => r.json());
      if (resp.success) setMediaLibrary(resp.data || []);
    } catch (e) { console.error('Failed to load media library:', e); }
    setMediaLibLoading(false);
  };

  const fetchProfiles = async () => {
    try {
      const resp = await fetch('/api/profiles', { headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` } });
      const json = await resp.json();
      if (json.success) setProfiles(json.data || []);
    } catch (e) {}
  };

  const fetchAssets = async () => {
    try {
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;
      const [accs, pgs, pxs] = await Promise.all([
        fetch('/api/adaccounts', { headers: { 'Authorization': `Bearer ${authToken}` } }).then(r => r.json()),
        fetch('/api/pages', { headers: { 'Authorization': `Bearer ${authToken}` } }).then(r => r.json()),
        fetch('/api/pixels', { headers: { 'Authorization': `Bearer ${authToken}` } }).then(r => r.json())
      ]);
      if (accs.success) setAvailableAccounts(accs.data);
      if (pgs.success) setAvailablePages(pgs.data);
      if (pxs.success) setAvailablePixels(pxs.data);
    } catch (e) {}
  };

  const fetchTemplates = async (shouldApplyDefault = true) => {
    const cacheKey = 'ad_templates_cache';
    // ① 先用缓存秒显，避免下拉/列表空白
    //    并记录"默认模板是否已从缓存套用"，避免下面拉完服务器再套一次把面板内容重置
    let appliedDefaultFromCache = false;
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (Array.isArray(cached?.data) && cached.data.length > 0) {
          setTemplates(cached.data);
          if (shouldApplyDefault) {
            const dt = cached.data.find((t: AdTemplate) => t.is_default === 1);
            if (dt) { applyTemplate(dt); appliedDefaultFromCache = true; }
          }
        }
      }
    } catch {}
    // ② 始终再拉一次服务器。
    //    ⚠️ 以前这里有个「5 分钟内直接用缓存 return」的逻辑，问题是模板改名/删除/新增
    //       （不管是在本组件里点保存/重命名，还是在「广告模板」导航页操作）之后，
    //       紧接着调用的 fetchTemplates 又读到刚写进去的旧缓存 → 下拉里还是旧名字，
    //       和导航页显示的模板名字对不上。模板列表本来就很小，每次直连服务器即可。
    try {
      const resp = await fetch('/api/ad-templates', { headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` } });
      const json = await resp.json();
      if (json.success) {
        setTemplates(json.data);
        try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: json.data })); } catch {}
        if (shouldApplyDefault && !appliedDefaultFromCache) {
          const dt = json.data.find((t: AdTemplate) => t.is_default === 1);
          if (dt) applyTemplate(dt);
        }
      }
    } catch {}
  };

  const saveTemplate = async (name?: string, isDefault = false, id?: number) => {
    const templateName = name || selectedTemplate?.name || prompt('请输入模板名称', '我的广告配置') || '未命名模版';
    if (!templateName) return;
    let targetId = id || selectedTemplate?.id;
    if (!targetId) { const e = templates.find(t => t.name === templateName); if (e) targetId = e.id; }
    try {
      const firstC = tree[0];
      const firstAS = firstC?.adSets?.[0];
      const firstA = firstAS?.ads?.[0];
      const configToSave = { campaignTree: tree, publishMethod, launchBrowser, campaignCount: firstC?.campaignCount ?? 1, adSetCount: firstAS?.adSetCount ?? 1, adCount: firstA?.adCount ?? 1 };
      const resp = await fetch('/api/ad-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
        body: JSON.stringify({ id: targetId, name: templateName, is_default: (isDefault || templateName === 'Last Used') ? 1 : 0, config: configToSave })
      });
      const json = await resp.json();
      if (json.success) { await fetchTemplates(false); if (!targetId && json.data) setSelectedTemplate(json.data); return json.data; }
    } catch {}
    return null;
  };

  const applyTemplate = (tpl: AdTemplate) => {
    try {
      const config = JSON.parse(tpl.config);
      // ⚠️ 旧模板缺少 customerLifecycle → 补默认，否则客户生命周期不会下发到后端
      if (config.campaignTree) setTree(config.campaignTree.map((c: any) => ({
        ...c,
        adSets: (c.adSets || []).map((as: any) => {
          const next = as.customerLifecycle ? as : { ...as, customerLifecycle: 'ALL' };
          // 🔧 优化目标旧值迁移，否则下拉框会显示空白
          if (OPT_GOAL_LEGACY[next.optimizationGoal]) next.optimizationGoal = OPT_GOAL_LEGACY[next.optimizationGoal];
          // 🎯 旧模板的 CTA 多为默认的「了解更多」，按优化目标纠正（默认值不算用户选择）
          const _derivedCta = deriveCta(next.optimizationGoal);
          if (_derivedCta && next.ads) {
            next.ads = next.ads.map((a: any) => (!a.ctaType || a.ctaType === 'LEARN_MORE') ? { ...a, ctaType: _derivedCta } : a);
          }
          return next;
        }),
      })));
      if (config.publishMethod) setPublishMethod(config.publishMethod);
      if (config.launchBrowser !== undefined) setLaunchBrowser(config.launchBrowser);
      setSelectedTemplate(tpl); setIsTemplateMenuOpen(false);
    } catch { alert('加载失败'); }
  };

  const deleteTemplate = async (id: number) => {
    if (!confirm('确定要删除此模板吗？')) return;
    try {
      const resp = await fetch(`/api/ad-templates/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` } });
      if ((await resp.json()).success) { fetchTemplates(false); if (selectedTemplate?.id === id) setSelectedTemplate(null); }
    } catch {}
  };

  const getActiveTree = () => tree;

  const validate = (): string | null => {
    const active = getActiveTree();
    if (active.length === 0 || !active[0]?.name?.trim()) return '请至少选择一个广告系列';
    const needsUrl = active.some(c => c.adSets.some(as => as.ads.some(a => {
      return !a.websiteUrl?.trim();
    })));
    if (needsUrl) return '部分广告缺少落地页 URL';
    return null;
  };

  const commitRename = () => {
    const id2 = templateRenameId;
    const n2 = templateRenameValue.trim();
    if (!id2 || !n2) { setTemplateRenameId(null); return; }
    const t2 = templates.find(t => t.id === id2);
    if (!t2) { setTemplateRenameId(null); return; }
    const fc2 = tree[0]; const fas2 = fc2?.adSets?.[0]; const fa2 = fas2?.ads?.[0];
    const cs = { campaignTree: tree, publishMethod, launchBrowser, campaignCount: fc2?.campaignCount ?? 1, adSetCount: fas2?.adSetCount ?? 1, adCount: fa2?.adCount ?? 1 };
    fetch('/api/ad-templates', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem('auth_token')}`}, body:JSON.stringify({id:id2,name:n2,is_default:t2.is_default||0,config:cs}) }).then(r=>r.json()).then(j=>{if(j.success){fetchTemplates(false);if(selectedTemplate?.id===id2)setSelectedTemplate({...t2,name:n2})}}).catch(()=>{}).finally(()=>setTemplateRenameId(null));
  };
  const handleRenameKeydown = (e: React.KeyboardEvent) => { if (e.key === 'Enter') commitRename(); };
  const handleRenameBlur = () => commitRename();
  const startRename = (tpl: AdTemplate) => { setTemplateRenameId(tpl.id); setTemplateRenameValue(tpl.name); };
  const doDeleteTemplate = (tpl: AdTemplate) => deleteTemplate(tpl.id);
  const doSaveTemplate = () => { saveTemplate(); setIsTemplateMenuOpen(false); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 🛡️ 只认底部「发布广告 / 保存模板」按钮的显式点击，其它一律忽略。
    //    原因：整个右侧面板被包在 <form> 里，而 HTML 默认 <button> 的 type 就是 submit，
    //    面板里的按钮（添加广告/上传素材/删除…）全都没写 type="button" → 点一下就提交表单；
    //    同理，在任意输入框里按回车也会触发隐式提交。
    //    以前非模板模式没有这个判断 → 表单还没填完就真的把广告发出去了。
    const submitter = (e.nativeEvent as any)?.submitter as HTMLButtonElement | null;
    if (!submitter || submitter.getAttribute('data-submit') !== 'true') {
      return;
    }
    if (templateMode) {
      const name = templateName || selectedTemplate?.name || prompt('请输入模板名称', '我的广告配置') || '未命名模版';
      if (!name) return;
      setIsSubmitting(true);
      try {
        const activeTree = getActiveTree();
        // 🚀 收集 sessionMediaCache 中的文件，转 base64 注入广告节点
        const allMediaFiles: File[] = [];
        // 🚀 同时收集多语言独立素材
        const langMediaMap: Record<string, File[]> = {};
        for (const c of activeTree) {
          for (const as of c.adSets) {
            for (const a of as.ads) {
              const files = sessionMediaCache[a.id] || [];
              allMediaFiles.push(...files);
              // 收集语言内容素材
              if (a.languageContent) {
                for (const [langCode, lc] of Object.entries(a.languageContent)) {
                  const lcFiles = (lc as any).mediaFiles || [];
                  if (lcFiles.length > 0) {
                    const key = `${a.id}_${langCode}`;
                    if (!langMediaMap[key]) langMediaMap[key] = [];
                    langMediaMap[key].push(...lcFiles);
                  }
                }
              }
            }
          }
        }
        const mediaBase64List: string[] = [];
        for (const f of allMediaFiles) {
          try {
            const b64 = await new Promise<string>((resolve, reject) => {
              const r = new FileReader();
              r.readAsDataURL(f);
              r.onload = () => resolve(r.result as string);
              r.onerror = reject;
            });
            mediaBase64List.push(b64);
          } catch (e) {
            console.warn('❌ 模板图片转 base64 失败:', f.name, e);
          }
        }
        // 🚀 深拷贝树，将 base64 注入广告节点的 _mediaBase64 字段
        const treeClone = JSON.parse(JSON.stringify(activeTree));
        let b64Idx = 0;
        for (const c of treeClone) {
          for (const as of c.adSets) {
            for (const a of as.ads) {
              a._mediaBase64 = mediaBase64List.length > 0 ? (mediaBase64List[b64Idx % mediaBase64List.length] || null) : null;
              if (mediaBase64List.length > 0) b64Idx++;
              // ⚠️ File 对象无法 JSON 序列化，存进模板会变成 {}，
              //    下次套用模板时读出来是 truthy 的假文件 → 必须剔除
              delete a.videoFile;
              // 🐛 修复：将语言素材转 base64 注入（替换不可序列化的 File 对象）
              if (a.languageContent) {
                for (const [langCode, lc] of Object.entries(a.languageContent)) {
                  const lcObj = lc as any;
                  const files = langMediaMap[`${a.id}_${langCode}`] || [];
                  if (files.length > 0) {
                    const b64Arr: string[] = [];
                    for (const f of files) {
                      try {
                        const b64 = await new Promise<string>((resolve, reject) => {
                          const r = new FileReader();
                          r.readAsDataURL(f);
                          r.onload = () => resolve(r.result as string);
                          r.onerror = reject;
                        });
                        b64Arr.push(b64);
                      } catch (e) { console.warn('❌ 模板语言素材转 base64 失败:', langCode, f.name, e); }
                    }
                    lcObj.mediaBase64List = b64Arr;
                  }
                  // 清理不可序列化的 File 对象
                  delete lcObj.mediaFiles;
                }
              }
            }
          }
        }
        const firstC = treeClone[0];
        const firstAS = firstC?.adSets?.[0];
        const firstA = firstAS?.ads?.[0];
        const configToSave = { campaignTree: treeClone, publishMethod, launchBrowser, campaignCount: firstC?.campaignCount ?? 1, adSetCount: firstAS?.adSetCount ?? 1, adCount: firstA?.adCount ?? 1 };
        const resp = await fetch('/api/ad-templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
          body: JSON.stringify({ id: selectedTemplate?.id, name, is_default: 0, config: configToSave })
        });
        const json = await resp.json();
        if (json.success) {
          // 🚀 模板保存成功后，把完整数据传给父组件供立即使用
          onConfirm({ publishMethod, launchBrowser, campaignTree: treeClone, mediaBase64List, campaignCount: firstC?.campaignCount ?? 1, adSetCount: firstAS?.adSetCount ?? 1, adCount: firstA?.adCount ?? 1 });
          return;
        } else {
          alert(json.message || '保存失败');
        }
      } catch (err) { alert('请求失败'); }
      setIsSubmitting(false);
      return;
    }
    // ✅ 非模板模式 = 真正发布广告（会真实创建到 Facebook 并产生花费）→ 提交前先弹确认框。
    //    数量口径与发布流程保持一致：每个环境 = 系列数 × 广告组数 × 广告数。
    const previewTree = getActiveTree();
    const perEnvCampaigns = previewTree[0]?.campaignCount ?? 1;
    const perEnvAdSets = previewTree[0]?.adSets?.[0]?.adSetCount ?? 1;
    const perEnvAds = previewTree[0]?.adSets?.[0]?.ads?.[0]?.adCount ?? 1;
    const adsPerEnv = perEnvCampaigns * perEnvAdSets * perEnvAds;
    const envCount = profileIds.length || 1;
    const okToPublish = window.confirm(
      `确认发布广告？\n\n` +
      `每个环境：${perEnvCampaigns} 系列 × ${perEnvAdSets} 广告组 × ${perEnvAds} 广告 = ${adsPerEnv} 条\n` +
      `目标环境：${envCount} 个\n` +
      `合计发布：${adsPerEnv * envCount} 条广告\n` +
      `发布方式：${publishMethod === 'api' ? 'API' : 'Puppeteer'}\n\n` +
      `广告会真实创建到 Facebook，是否继续？`
    );
    if (!okToPublish) return;
    setIsSubmitting(true);
    try {
      const activeTree = getActiveTree();
      // 🚀 从 sessionMediaCache 收集所有广告的图片文件
      const allMediaFiles: File[] = [];
      // 🚀 同时收集多语言独立素材
      const langMediaMap: Record<string, File[]> = {};
      for (const c of activeTree) {
        for (const as of c.adSets) {
          for (const a of as.ads) {
            const files = sessionMediaCache[a.id] || [];
            allMediaFiles.push(...files);
            // 收集语言内容素材
            if (a.languageContent) {
              for (const [langCode, lc] of Object.entries(a.languageContent)) {
                if (lc.mediaFiles && lc.mediaFiles.length > 0) {
                  const key = `${a.id}_${langCode}`;
                  if (!langMediaMap[key]) langMediaMap[key] = [];
                  langMediaMap[key].push(...lc.mediaFiles);
                }
              }
            }
          }
        }
      }
      console.warn('📸 发布图片收集:', allMediaFiles.length, '个文件，来自', 
        Object.keys(sessionMediaCache).length, '个广告的缓存');
      // 🚀 在组件内转 base64，避免 File 对象跨组件传递丢失
      const mediaBase64List: string[] = [];
      for (const f of allMediaFiles) {
        try {
          const b64 = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.readAsDataURL(f);
            r.onload = () => resolve(r.result as string);
            r.onerror = reject;
          });
          mediaBase64List.push(b64);
        } catch (e) {
          console.warn('❌ 图片转 base64 失败:', f.name, e);
        }
      }
      console.warn('🖼️ 已转 base64:', mediaBase64List.length, '个');
      // 🎬 视频素材：File 对象过不了 JSON（会变成 {}），这里先转成 base64，稍后注入 ad 节点
      const fileToBase64 = (f: File) => new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.readAsDataURL(f);
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
      });
      const videoMap: Record<string, { b64: string; name: string; mime: string; thumbB64?: string }> = {};
      for (const c of activeTree) {
        for (const as of c.adSets) {
          for (const a of as.ads) {
            const vf = a.videoFile;
            if (!vf) continue;
            // ⚠️ 旧模板里 videoFile 曾经被 JSON.stringify 存成 {}（File 不可序列化）→ 它是 truthy
            //    但不是 Blob，直接丢给 FileReader 会抛「parameter 1 is not of type 'Blob'」
            if (!(vf instanceof Blob)) {
              console.warn('⚠️ 视频素材不是有效文件（可能来自旧模板），已跳过:', a.name);
              continue;
            }
            try {
              const mediaFiles = sessionMediaCache[a.id] || [];
              const thumbFile = a.videoThumbnailIndex != null ? mediaFiles[a.videoThumbnailIndex] : undefined;
              videoMap[a.id] = {
                b64: await fileToBase64(vf),
                name: vf.name,
                mime: vf.type || 'video/mp4',
                thumbB64: thumbFile ? await fileToBase64(thumbFile) : undefined,
              };
              console.warn('🎬 视频素材转 base64:', vf.name, (vf.size / 1048576).toFixed(1) + 'MB', thumbFile ? `封面=${thumbFile.name}` : '封面=FB自动生成');
            } catch (e) {
              console.warn('❌ 视频转 base64 失败:', vf.name, e);
            }
          }
        }
      }
      // 🚀 将 base64 注入到 ad 节点，深拷贝避免引用问题
      let b64Idx = 0;
      const treeClone = JSON.parse(JSON.stringify(activeTree));
      for (const c of treeClone) {
        for (const as of c.adSets) {
          for (const a of as.ads) {
            a._mediaBase64 = mediaBase64List.length > 0 ? (mediaBase64List[b64Idx % mediaBase64List.length] || null) : null;
            if (mediaBase64List.length > 0) b64Idx++;
            // 🎬 视频素材注入（含用户点选的封面图）
            const vinfo = videoMap[a.id];
            if (vinfo) {
              a._videoBase64 = vinfo.b64;
              a._videoName = vinfo.name;
              a._videoMime = vinfo.mime;
              if (vinfo.thumbB64) a._videoThumbBase64 = vinfo.thumbB64;
            }
            delete a.videoFile;
            // 🚀 将语言素材 base64 注入 languageContent
            if (a.languageContent) {
              for (const [langCode, lc] of Object.entries(a.languageContent)) {
                const lcObj = lc as any;
                const files = langMediaMap[`${a.id}_${langCode}`] || [];
                if (files.length > 0) {
                  const b64Arr: string[] = [];
                  for (const f of files) {
                    try {
                      const b64 = await new Promise<string>((resolve, reject) => {
                        const r = new FileReader();
                        r.readAsDataURL(f);
                        r.onload = () => resolve(r.result as string);
                        r.onerror = reject;
                      });
                      b64Arr.push(b64);
                    } catch (e) { console.warn('❌ 语言素材转 base64 失败:', langCode, f.name, e); }
                  }
                  lcObj.mediaBase64List = b64Arr;
                }
              }
            }
          }
        }
      }
      // 🚀 从 tree 节点收集发布数量（右侧面板设置）
      const firstC = treeClone[0];
      const firstAS = firstC?.adSets?.[0];
      const firstA = firstAS?.ads?.[0];
      const finalCampaignCount = firstC?.campaignCount ?? 1;
      const finalAdSetCount = firstAS?.adSetCount ?? 1;
      const finalAdCount = firstA?.adCount ?? 1;
      console.warn(`📊 发布数量: 系列x${finalCampaignCount} 广告组x${finalAdSetCount} 广告x${finalAdCount} = ${finalCampaignCount * finalAdSetCount * finalAdCount} 条`);
      // 🚀 把完整 tree 传给 ProfileManager，由它逐个系列发布
      onConfirm({ publishMethod, launchBrowser, campaignTree: treeClone, mediaBase64List, campaignCount: finalCampaignCount, adSetCount: finalAdSetCount, adCount: finalAdCount });
      // 保存模板后台静默执行
      saveTemplate(selectedTemplate?.name || 'Last Used', !selectedTemplate).catch(() => {});
    } catch (err2: any) { console.error(err2); }
    setIsSubmitting(false);
  };

  // ===== 渲染模板下拉菜单 =====
  const renderTemplateDropdown = () => {
    if (!isTemplateMenuOpen) return null;
    return (
      <div className="absolute top-full left-0 mt-2 w-56 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl z-[60] py-2 animate-in fade-in zoom-in-95 duration-150">
        <div className="px-3 py-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-slate-700/50 mb-1">我的模板</div>
        <div className="max-h-48 overflow-y-auto custom-scrollbar">
          {templates.length === 0 && <div className="px-4 py-3 text-xs text-slate-500 italic">暂无模板</div>}
          {templates.map(tpl => (
            <div key={tpl.id} className="group flex items-center justify-between px-2 hover:bg-slate-700/50">
              {templateRenameId === tpl.id ? (
                <div className="flex-1 flex items-center gap-1 px-2 py-1">
                  <input type="text" value={templateRenameValue} onChange={e => setTemplateRenameValue(e.target.value)} onKeyDown={handleRenameKeydown} onBlur={handleRenameBlur} className="flex-1 bg-slate-700 border border-indigo-500 rounded px-2 py-1 text-xs text-white outline-none" autoFocus />
                </div>
              ) : (
                <button onClick={() => applyTemplate(tpl)} className="flex-1 text-left px-2 py-2 text-xs text-slate-300 hover:text-white truncate">
                  {tpl.name} {tpl.is_default === 1 && <span className="text-[10px] bg-indigo-500/20 text-indigo-400 px-1 rounded ml-1">默认</span>}
                </button>
              )}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <button onClick={() => startRename(tpl)} className="p-1.5 text-slate-600 hover:text-indigo-400"><Pencil className="w-3 h-3" /></button>
                <button onClick={() => doDeleteTemplate(tpl)} className="p-1.5 text-slate-600 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-slate-700/50 mt-1 pt-1">
          <button onClick={doSaveTemplate} className="w-full text-left px-4 py-2 text-xs text-indigo-400 hover:bg-indigo-500/10 flex items-center gap-2">
            <Save className="w-3.5 h-3.5" />保存当前为新模板
          </button>
        </div>
      </div>
    );
  };

  // ===== 渲染左侧树 =====
  const renderTree = () => (
    <div className="w-[260px] shrink-0 bg-slate-950/60 border-r border-slate-800/50 overflow-y-auto custom-scrollbar">
      <div className="p-3 border-b border-slate-800/50">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">广告结构</h3>
          <button onClick={() => { const n = Array.from({length: campaignQty}, (_, i) => createDefaultCampaign(i === 0 ? undefined : `${tree.length + i + 1}`)); setTree(prev => [...prev, ...n]); setSelectedCampaignIdx(tree.length); setSelectedType('campaign'); }} className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"><Plus className="w-3 h-3" />系列</button>
          <input type="number" min="1" max="20" value={campaignQty} onChange={e => setCampaignQty(Math.max(1, parseInt(e.target.value) || 1))} className="w-10 bg-slate-900 border border-slate-700 rounded text-[9px] text-white text-center px-1 py-0.5" />
        </div>
        <div className="flex gap-1">
          {['api', 'puppeteer'].map(m => (
            <button key={m} onClick={() => setPublishMethod(m as any)} className={`flex-1 py-1 text-[10px] font-bold rounded-lg border transition-all ${publishMethod === m ? 'bg-indigo-600/20 border-indigo-500 text-indigo-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>{m === 'api' ? 'API' : 'Puppeteer'}</button>
          ))}
        </div>
      </div>
      <div className="p-2 space-y-1">
        {tree.map((c, ci) => (
          <div key={c.id}>
            <div onClick={() => { setSelectedCampaignIdx(ci); setSelectedAdSetIdx(0); setSelectedAdIdx(0); setSelectedType('campaign'); }} className={`flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all group ${selectedType === 'campaign' && selectedCampaignIdx === ci ? 'bg-indigo-600/15 border border-indigo-500/30' : 'hover:bg-slate-800/50 border border-transparent'}`}>
              <div className="w-5 h-5 rounded bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-[9px] text-indigo-400 font-bold shrink-0">{ci + 1}</div>
              <span className="text-xs text-slate-300 truncate flex-1">{c.name || '系列'}</span>
              {tree.length > 1 && <button onClick={(ev) => { ev.stopPropagation(); setTree(prev => prev.filter((_, i) => i !== ci)); if (selectedCampaignIdx >= ci && selectedCampaignIdx > 0) setSelectedCampaignIdx(prev => prev - 1); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-rose-400"><Trash2 className="w-3 h-3" /></button>}
              <button onClick={(ev) => { ev.stopPropagation(); const qty = parseInt(prompt('复制数量:', '1') || '1') || 1; const mode = prompt('命名方式: 留空=序列(1,2,3) 输入 random=随机', '') || ''; const useRandom = mode.toLowerCase() === 'random'; setTree(prev => { const n = [...prev]; for (let i = 0; i < qty; i++) { const suffix = useRandom ? '_' + Math.random().toString(36).slice(2,6) : '_' + (i + 1); const nc = {...c, id: uid(), name: c.name + suffix, adSets: c.adSets.map(as => ({...as, id: uid(), ads: as.ads.map(a => ({...a, id: uid()}))}))}; n.splice(ci + 1 + i, 0, nc); } return n; }); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-emerald-400"><Copy className="w-3 h-3" /></button>
            </div>
            {c.adSets.map((as, asi) => (
              <div key={as.id} className="ml-4">
                <div onClick={() => { setSelectedCampaignIdx(ci); setSelectedAdSetIdx(asi); setSelectedAdIdx(0); setSelectedType('adset'); }} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-all group mt-0.5 ${selectedType === 'adset' && selectedCampaignIdx === ci && selectedAdSetIdx === asi ? 'bg-teal-600/15 border border-teal-500/30' : 'hover:bg-slate-800/50 border border-transparent'}`}>
                  <div className="w-4 h-4 rounded bg-teal-600/20 border border-teal-500/30 flex items-center justify-center text-[8px] text-teal-400 font-bold shrink-0">{String.fromCharCode(65 + asi)}</div>
                  <span className="text-[11px] text-slate-400 truncate flex-1">{as.name || ' 广告组'}</span>
                  {c.adSets.length > 1 && <button onClick={(ev) => { ev.stopPropagation(); updateCampaign(ci, { adSets: c.adSets.filter((_, i) => i !== asi) }); if (selectedAdSetIdx >= asi && selectedAdSetIdx > 0) setSelectedAdSetIdx(prev => prev - 1); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-rose-400"><Trash2 className="w-[11px] h-[11px]" /></button>}
                  <button onClick={(ev) => { ev.stopPropagation(); const qty = parseInt(prompt('复制数量:', '1') || '1') || 1; const mode = prompt('命名方式: 留空=序列(1,2,3) 输入 random=随机', '') || ''; const useRandom = mode.toLowerCase() === 'random'; setTree(prev => { const n = [...prev]; const ci2 = n.findIndex(x => x.id === c.id); if (ci2 === -1) return prev; const adsets = [...n[ci2].adSets]; for (let i = 0; i < qty; i++) { const suffix = useRandom ? '_' + Math.random().toString(36).slice(2,6) : '_' + (i + 1); adsets.splice(asi + 1 + i, 0, {...as, id: uid(), name: as.name + suffix, ads: as.ads.map(a => ({...a, id: uid()}))}); } n[ci2] = {...n[ci2], adSets: adsets}; return n; }); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-emerald-400"><Copy className="w-[11px] h-[11px]" /></button>
                </div>
                {as.ads.map((adItem, ai) => (
                  <div key={adItem.id} className="ml-6">
                    <div onClick={() => { setSelectedCampaignIdx(ci); setSelectedAdSetIdx(asi); setSelectedAdIdx(ai); setSelectedType('ad'); }} className={`flex items-center gap-2 px-2.5 py-1 rounded-lg cursor-pointer transition-all group mt-0.5 ${selectedType === 'ad' && selectedCampaignIdx === ci && selectedAdSetIdx === asi && selectedAdIdx === ai ? 'bg-amber-600/15 border border-amber-500/30' : 'hover:bg-slate-800/50 border border-transparent'}`}>
                      <div className="w-3.5 h-3.5 rounded-full bg-amber-600/20 border border-amber-500/30 flex items-center justify-center text-[7px] text-amber-400 font-bold shrink-0">{ai + 1}</div>
                      <span className="text-[10px] text-slate-500 truncate flex-1">{adItem.name || '广告'}</span>
                      {as.ads.length > 1 && <button onClick={(ev) => { ev.stopPropagation(); updateAdSet(ci, asi, { ads: as.ads.filter((_, i) => i !== ai) }); if (selectedAdIdx >= ai && selectedAdIdx > 0) setSelectedAdIdx(prev => prev - 1); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-rose-400"><Trash2 className="w-[10px] h-[10px]" /></button>}
                      <button onClick={(ev) => { ev.stopPropagation(); const qty = parseInt(prompt('复制数量:', '1') || '1') || 1; const mode = prompt('命名方式: 留空=序列(1,2,3) 输入 random=随机', '') || ''; const useRandom = mode.toLowerCase() === 'random'; setTree(prev => { const n = [...prev]; const c2 = n.findIndex(x => x.id === c.id); if (c2 === -1) return prev; const as2 = [...n[c2].adSets]; const asi2 = as2.findIndex(x => x.id === as.id); if (asi2 === -1) return prev; const ads = [...as2[asi2].ads]; for (let i = 0; i < qty; i++) { const suffix = useRandom ? '_' + Math.random().toString(36).slice(2,6) : '_' + (i + 1); ads.splice(ai + 1 + i, 0, {...adItem, id: uid(), name: adItem.name + suffix}); } as2[asi2] = {...as2[asi2], ads}; n[c2] = {...n[c2], adSets: as2}; return n; }); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-emerald-400"><Copy className="w-[10px] h-[10px]" /></button>
                    </div>
                  </div>
                ))}
                <div className="flex items-center gap-1 ml-10 mt-0.5">
                  <button onClick={() => { const qty = getAdQty(as.id); const newAds = Array.from({length: qty}, (_, i) => ({ id: uid(), name: `Ad ${(as.ads?.length || 0) + i + 1}`, adText: '', headline: '', websiteUrl: ad?.websiteUrl || '', displayLink: '', useDisplayLink: false, ctaType: 'LEARN_MORE', adFormat: 'SINGLE_IMAGE_VIDEO', enableAdvantageCreative: true, enableDynamicCreative: false, enableEnhancements: true, enhancementOverlayText: true, enhancementVisualPolish: true, enhancementAddMusic: true, enhancementCopyImprove: true, enhancementAddAnimation: true, adStatus: 'ACTIVE', enableVO: false })); updateAdSet(ci, asi, { ads: [...as.ads, ...newAds] }); setSelectedAdIdx(as.ads.length); setSelectedType('ad'); }} className="text-[9px] text-indigo-500/50 hover:text-indigo-400">+ 广告</button>
                  <input type="number" min="1" max="20" value={getAdQty(as.id)} onChange={e => setAdQty(as.id, Math.max(1, parseInt(e.target.value) || 1))} className="w-9 bg-slate-900 border border-slate-700 rounded text-[8px] text-white text-center px-1 py-0.5" />
                </div>
              </div>
            ))}
            <div className="flex items-center gap-1 ml-8 mt-1">
              <button onClick={() => { const qty = getAdSetQty(c.id); const ags = Array.from({length: qty}, (_, i) => ({ id: uid(), name: `Ad Set ${(c.adSets?.length || 0) + i + 1}`, countries: adSet?.countries || 'US', ageMin: adSet?.ageMin || '18', ageMax: adSet?.ageMax || '65', gender: adSet?.gender || 'all', placements: 'automatic', devicePlatforms: ['mobile', 'desktop'], osType: 'all', osVersionMin: '0', wifiOnly: false, enableAdvantageAudience: true, enableAudienceExpansion: true, enableVO: false, adSetStatus: 'PAUSED', ads: [{ id: uid(), name: 'Ad 1', adText: '', headline: '', websiteUrl: ad?.websiteUrl || '', displayLink: '', useDisplayLink: false, ctaType: 'LEARN_MORE', adFormat: 'SINGLE_IMAGE_VIDEO', enableAdvantageCreative: true, enableDynamicCreative: false, enableEnhancements: true, enhancementOverlayText: true, enhancementVisualPolish: true, enhancementAddMusic: true, enhancementCopyImprove: true, enhancementAddAnimation: true, adStatus: 'ACTIVE', enableVO: false }] })); updateCampaign(ci, { adSets: [...(c.adSets || []), ...ags] }); setSelectedAdSetIdx(c.adSets.length); setSelectedType('adset'); }} className="text-[9px] text-indigo-500/50 hover:text-indigo-400">+ 广告组</button>
              <input type="number" min="1" max="20" value={getAdSetQty(c.id)} onChange={e => setAdSetQty(c.id, Math.max(1, parseInt(e.target.value) || 1))} className="w-9 bg-slate-900 border border-slate-700 rounded text-[8px] text-white text-center px-1 py-0.5" />
            </div>
          </div>
        ))}
      </div>
      <div className="p-3 border-t border-slate-800/50 mt-2">
        <div className="text-[10px] text-slate-500">
          总计: {tree.reduce((s,c) => s + c.adSets.reduce((ss,a) => ss + a.ads.length, 0), 0)} 条广告        </div>
      </div>
    </div>
  );

  // ===== 系列设置面板 (完整版FB后台) =====
  const renderCampaignPanel = () => {
    if (!campaign) return null;
    const specCats = campaign.specialAdCategories || [];
    const toggleSpecCat = (cat: string) => {
      updateCampaign(selectedCampaignIdx, { specialAdCategories: specCats.includes(cat) ? specCats.filter(c => c !== cat) : [...specCats, cat] });
    };
    return (
      <div className="space-y-5 animate-in fade-in slide-in-from-bottom-3 duration-200">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2"><Layers className="w-4 h-4 text-indigo-400" />系列设置 (完整版FB后台)</h3>
          <div className="flex items-center gap-2">
            <span className="text-[8px] text-slate-500">发布数量:</span>
            <input type="number" min="1" max="20" value={campaign.campaignCount ?? 1} onChange={e => updateCampaign(selectedCampaignIdx, { campaignCount: Math.max(1, parseInt(e.target.value) || 1) })} className="w-10 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-white text-center" />
            <span className="text-[10px] text-slate-500 bg-slate-950 px-2 py-0.5 rounded-full border border-slate-800">购买类型: {campaign.buyingType}</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">系列名称</label>
            <input type="text" value={campaign.name} onChange={e => updateCampaign(selectedCampaignIdx, { name: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white focus:ring-2 focus:ring-indigo-500/30" />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">广告目标</label>
            <select value={campaign.objective} onChange={e => applyObjective(selectedCampaignIdx, e.target.value as any)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white">
              <option value="OUTCOME_TRAFFIC">流量 (Traffic)</option>
              <option value="OUTCOME_SALES">销售 (Sales)</option>
              <option value="OUTCOME_ENGAGEMENT">互动 (Engagement)</option>
              <option value="OUTCOME_LEADS">线索 (Leads)</option>
              <option value="OUTCOME_AWARENESS">知名度 (Awareness)</option>
              <option value="OUTCOME_APP_PROMOTION">应用推广 (App Promotion)</option>
              <option value="REACH">覆盖人数 (Reach)</option>
              <option value="VIDEO_VIEWS">视频观看量 (Video Views)</option>
              <option value="MESSAGES">Messenger 消息 (Messages)</option>
              <option value="CATALOG_SALES">目录销售 (Catalog Sales)</option>
              <option value="STORE_VISITS">店铺访问 (Store Visits)</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">购买方式</label>
            <select value={campaign.buyingType} onChange={e => updateCampaign(selectedCampaignIdx, { buyingType: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white">
              <option value="AUCTION">竞价 (Auction)</option>
              <option value="RESERVED">预留 (Reach & Frequency)</option>
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-400">特殊广告类别 <span className="text-[10px] text-slate-500">(勾选后会限制定位选项)</span></label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { key: 'EMPLOYMENT', label: '就业机会', desc: 'Employment' },
              { key: 'CREDIT', label: '信贷机会', desc: 'Credit' },
              { key: 'HOUSING', label: '住房机会', desc: 'Housing' },
              { key: 'SOCIAL_ISSUES_ELECTIONS', label: '社会议题/选举', desc: 'Social Issues/Elections' },
              { key: 'GAMBLING', label: '博彩', desc: 'Gambling' },
              { key: 'HEALTHCARE', label: '医疗健康', desc: 'Healthcare' },
            ].map(cat => (
              <label key={cat.key} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all ${specCats.includes(cat.key) ? 'bg-amber-600/15 border-amber-500/30 text-amber-300' : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600'}`}>
                <input type="checkbox" checked={specCats.includes(cat.key)} onChange={() => toggleSpecCat(cat.key)} className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-amber-500" />
                <span className="text-[11px] leading-tight"><span className="font-medium">{cat.label}</span><br /><span className="text-[9px] opacity-70">{cat.desc}</span></span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">预算层级</label>
            <div className="flex bg-slate-900 rounded-lg p-0.5 border border-slate-800">
              <button type="button" onClick={() => updateCampaign(selectedCampaignIdx, { budgetLevel: 'CAMPAIGN' })} className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all ${campaign.budgetLevel === 'CAMPAIGN' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>CBO</button>
              <button type="button" onClick={() => updateCampaign(selectedCampaignIdx, { budgetLevel: 'ADSET' })} className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all ${campaign.budgetLevel === 'ADSET' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>组预算</button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">预算类型</label>
            <select value={campaign.budgetType} onChange={e => updateCampaign(selectedCampaignIdx, { budgetType: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white">
              <option value="DAILY">单日预算 (Daily)</option>
              <option value="LIFETIME">总预算 (Lifetime)</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">金额 (USD)</label>
            <div className="relative"><DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" /><input type="number" value={campaign.budget} onChange={e => updateCampaign(selectedCampaignIdx, { budget: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-sm text-white" /></div>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">Advantage 系列预算</label>
            <button type="button" onClick={() => updateCampaign(selectedCampaignIdx, { advantageCampaignBudget: !campaign.advantageCampaignBudget })} className={`w-full py-2 text-sm rounded-lg border transition-all ${campaign.advantageCampaignBudget ? 'bg-indigo-600/20 border-indigo-500 text-indigo-400' : 'bg-slate-950 border-slate-800 text-slate-500'}`}>{campaign.advantageCampaignBudget ? '已启用' : '关闭'}</button>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">进阶赋能型销量广告系列</label>
            <button type="button" onClick={() => updateCampaign(selectedCampaignIdx, { enableAdvantageCampaign: !campaign.enableAdvantageCampaign })} className={`w-full py-2 text-sm rounded-lg border transition-all ${campaign.enableAdvantageCampaign ? 'bg-green-600/20 border-green-500 text-green-400' : 'bg-slate-950 border-slate-800 text-slate-500'}`}>{campaign.enableAdvantageCampaign ? '已启用 ✓' : '关闭'}</button>
            {advAutoOffHint && !campaign.enableAdvantageCampaign && <div className="text-[9px] text-amber-400/80">进阶赋能型系列仅支持「销量」目标，已自动关闭</div>}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">出价策略</label>
            <select value={campaign.bidStrategy || 'LOWEST_COST_WITHOUT_CAP'} onChange={e => updateCampaign(selectedCampaignIdx, { bidStrategy: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white">
              <option value="LOWEST_COST_WITHOUT_CAP">最低成本(无上限)</option>
              <option value="LOWEST_COST_WITH_BID_CAP">最低成本(有竞价上限)</option>
              <option value="COST_CAP">成本上限 (Cost Cap)</option>
              <option value="BID_CAP">竞价上限 (Bid Cap)</option>
              <option value="TARGET_COST">目标成本 (Target Cost)</option>
              <option value="ROAS">广告花费回报 (ROAS)</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">投放节奏</label>
            <select value={campaign.pacingType || 'standard'} onChange={e => updateCampaign(selectedCampaignIdx, { pacingType: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white">
              <option value="standard">标准</option>
              <option value="no_pacing">不限速</option>
              <option value="accelerated">加速投放</option>
            </select>
          </div>
          {campaign.bidStrategy === 'ROAS' ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400">目标 ROAS </label>
              <input type="number" value={campaign.targetRoas || ''} onChange={e => updateCampaign(selectedCampaignIdx, { targetRoas: e.target.value })} placeholder="例如 2.0" step="0.1" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" />
            </div>
          ) : campaign.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP' ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400">竞价/成本上限 (USD)</label>
              <input type="number" value={campaign.bidAmount || ''} onChange={e => updateCampaign(selectedCampaignIdx, { bidAmount: e.target.value })} placeholder="0.00" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" />
            </div>
          ) : <div />}
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">转化归因窗口</label>
            {/* ⚠️ 只列 Meta 2026 仍支持的窗口：点击仅 1/7 天，浏览仅 1 天
                （7 天/28 天浏览窗口已于 2026-01 被 Meta 移除）。
                选「带浏览」的项时后端会自动补上「1天互动观看（仅限视频）」，发出的就是 Ads Manager 的三行 */}
            <select value={campaign.conversionAttributionWindow || '7d_click_1d_view'} onChange={e => updateCampaign(selectedCampaignIdx, { conversionAttributionWindow: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white">
              <option value="1d_click_0_view">1天点击（无浏览）</option>
              <option value="7d_click_0_view">7天点击（无浏览）</option>
              <option value="1d_click_1d_view">1天点击+1天互动观看+1天浏览</option>
              <option value="7d_click_1d_view">7天点击+1天互动观看+1天浏览</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">品牌安全</label>
            <button type="button" onClick={() => updateCampaign(selectedCampaignIdx, { brandSafety: !campaign.brandSafety })} className={`w-full py-2 text-sm rounded-lg border transition-all ${campaign.brandSafety ? 'bg-indigo-600/20 border-indigo-500 text-indigo-400' : 'bg-slate-950 border-slate-800 text-slate-500'}`}>{campaign.brandSafety ? '已启用' : '关闭'}</button>
          </div>
          {campaign.brandSafety ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400">品牌适用性</label>
              <select value={campaign.brandSuitability || 'standard'} onChange={e => updateCampaign(selectedCampaignIdx, { brandSuitability: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white">
                <option value="standard">标准</option>
                <option value="limited">有限</option>
                <option value="strict">严格</option>
              </select>
            </div>
          ) : <div />}
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">开始日期</label><input type="date" value={campaign.startDate} onChange={e => updateCampaign(selectedCampaignIdx, { startDate: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white [color-scheme:dark]" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">结束日期</label><input type="date" value={campaign.endDate || ''} onChange={e => updateCampaign(selectedCampaignIdx, { endDate: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white [color-scheme:dark]" /></div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">系列状态</label>
            <button type="button" onClick={() => updateCampaign(selectedCampaignIdx, { campaignStatus: campaign.campaignStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${campaign.campaignStatus === 'ACTIVE' ? 'bg-emerald-600' : 'bg-slate-700'}`}><span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${campaign.campaignStatus === 'ACTIVE' ? 'translate-x-5' : 'translate-x-1'}`} /></button>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">发布后自动激活</label>
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={campaign.autoActivate} onChange={e => updateCampaign(selectedCampaignIdx, { autoActivate: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-[10px] text-slate-400">两步模式 (先草稿)</span></label>
          </div>
        </div>
        {campaign.budgetType === 'LIFETIME' && (
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-400">周时段排期 (Dayparting) <span className="text-[10px] text-slate-500">总预算模式 · X=小时 Y=日 · 拖拽/点击切换</span></label>
          <div className="overflow-auto custom-scrollbar max-h-[300px]">
            <div className="grid grid-cols-[44px_repeat(24,_minmax(20px,1fr))] gap-[1px] bg-slate-800/50 rounded-lg overflow-hidden min-w-[580px] select-none">
              <div
                className="bg-slate-950 p-1 text-[7px] text-slate-400 font-bold text-center cursor-pointer hover:text-indigo-400 transition-colors sticky left-0 z-10"
                onClick={() => {
                  const schedule = campaign.adSchedule || [];
                  const allActive = schedule.length === 7 * 24;
                  updateCampaign(selectedCampaignIdx, { adSchedule: allActive ? [] : Array.from({length:7}, (_,di) => Array.from({length:24}, (_,h) => ({day: di, hour: h, active: true}))).flat() });
                }}
                title="点击全选/取消"
              >{((campaign.adSchedule||[]).length >= 7*24*0.8) ? '全' : '空'}</div>
              {Array.from({length:24}, (_,h) => (
                <div key={h}
                  className="bg-slate-950 p-1 text-[7px] text-slate-500 font-mono text-center cursor-pointer hover:text-indigo-400 transition-colors"
                  onClick={() => {
                    const s = [...(campaign.adSchedule || [])];
                    const hourSlots = s.filter(x => x.hour === h);
                    const allActive = hourSlots.length === 7;
                    for (let di = 0; di < 7; di++) {
                      const idx = s.findIndex(x => x.day === di && x.hour === h);
                      if (allActive) { if (idx >= 0) s.splice(idx, 1); }
                      else { if (idx === -1) s.push({ day: di, hour: h, active: true }); }
                    }
                    updateCampaign(selectedCampaignIdx, { adSchedule: s });
                  }}
                >{h}:00-{h}:59</div>
              ))}
              {['周一','周二','周三','周四','周五','周六','周日'].map((day, di) => (
                <React.Fragment key={day}>
                  <div
                    className="bg-slate-950 p-1 text-[8px] text-slate-600 font-bold text-center cursor-pointer hover:text-indigo-400 transition-colors sticky left-0 z-10"
                    onClick={() => {
                      const s = [...(campaign.adSchedule || [])];
                      const daySlots = s.filter(x => x.day === di);
                      const allActive = daySlots.length === 24;
                      for (let h = 0; h < 24; h++) {
                        const idx = s.findIndex(x => x.day === di && x.hour === h);
                        if (allActive) { if (idx >= 0) s.splice(idx, 1); }
                        else { if (idx === -1) s.push({ day: di, hour: h, active: true }); }
                      }
                      updateCampaign(selectedCampaignIdx, { adSchedule: s });
                    }}
                  >{day}</div>
                  {Array.from({length:24}, (_, h) => {
                    const schedule = campaign.adSchedule || [];
                    const slot = schedule.find((s: any) => s.day === di && s.hour === h);
                    const active = slot?.active === true;
                    return (
                      <div key={h}
                        data-slot={`${di}-${h}`}
                        onMouseDown={() => {
                          const s = [...(campaign.adSchedule || [])];
                          const idx = s.findIndex(x => x.day === di && x.hour === h);
                          if (idx >= 0) s.splice(idx, 1);
                          else s.push({ day: di, hour: h, active: true });
                          updateCampaign(selectedCampaignIdx, { adSchedule: s });
                          (document.querySelector(`[data-slot]`) as any)?.setAttribute('data-dragging', 'true');
                        }}
                        onMouseEnter={(e) => {
                          if (e.buttons !== 1) return;
                          const s = [...(campaign.adSchedule || [])];
                          const idx = s.findIndex(x => x.day === di && x.hour === h);
                          const meta = s.some(x => x.day === di && x.hour === h) ? 'remove' : 'add';
                          if (meta === 'remove') { if (idx >= 0) s.splice(idx, 1); }
                          else { if (idx === -1) s.push({ day: di, hour: h, active: true }); }
                          updateCampaign(selectedCampaignIdx, { adSchedule: s });
                        }}
                        className={`aspect-square cursor-pointer transition-all border border-slate-800/20 ${active ? 'bg-indigo-500/60 hover:bg-indigo-500/80' : 'bg-slate-950 hover:bg-slate-900'} ${h >= 22 || h < 6 ? 'opacity-60' : ''}`}
                      />
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4 mt-3">
            <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告排期时区</label><select value={campaign.timezone || 'viewer'} onChange={e => updateCampaign(selectedCampaignIdx, { timezone: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="viewer">观众时区（默认）</option><option value="Asia/Shanghai">中国标准时间 (UTC+8)</option><option value="America/New_York">美东时间 (UTC-5)</option><option value="America/Chicago">美中时间 (UTC-6)</option><option value="America/Denver">山地时间 (UTC-7)</option><option value="America/Los_Angeles">太平洋时间 (UTC-8)</option><option value="Europe/London">伦敦时间 (UTC+0)</option><option value="Europe/Paris">巴黎时间 (UTC+1)</option><option value="Europe/Berlin">柏林时间 (UTC+1)</option><option value="Asia/Tokyo">东京时间 (UTC+9)</option><option value="Asia/Kolkata">印度时间 (UTC+5:30)</option><option value="Australia/Sydney">悉尼时间 (UTC+10)</option></select></div>
          </div>
        </div>
        )}
      </div>
    );
  };

  // ===== 广告组设置面板(完整版FB后台) =====
  const renderAdSetPanel = () => {
    if (!adSet) return null;
    return (
      <div className="space-y-5 animate-in fade-in slide-in-from-bottom-3 duration-200">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2"><Users className="w-4 h-4 text-teal-400" />广告组设置(完整版FB后台)</h3>
          <div className="flex items-center gap-2">
            <span className="text-[8px] text-slate-500">发布数量:</span>
            <input type="number" min="1" max="20" value={adSet?.adSetCount ?? 1} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { adSetCount: Math.max(1, parseInt(e.target.value) || 1) })} className="w-10 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-white text-center" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告组名称</label><input type="text" value={adSet.name} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { name: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告组状态</label><button type="button" onClick={() => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { adSetStatus: adSet.adSetStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${adSet.adSetStatus === 'ACTIVE' ? 'bg-emerald-600' : 'bg-slate-700'}`}><span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${adSet.adSetStatus === 'ACTIVE' ? 'translate-x-5' : 'translate-x-1'}`} /></button></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">优化目标</label><select value={adSet.optimizationGoal} onChange={e => applyOptimizationGoal(selectedCampaignIdx, selectedAdSetIdx, e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="LINK_CLICKS">链接点击量</option><option value="IMPRESSIONS">展示次数</option><option value="REACH">覆盖人数</option><option value="LANDING_PAGE_VIEWS">落地页浏览量</option><option value="VALUE">转化价值</option><option value="OFFSITE_CONVERSIONS">转化量</option><option value="LEAD_GENERATION">线索收集</option><option value="REPLIES">消息</option><option value="THRUPLAY">连续播放 (ThruPlay)</option><option value="POST_ENGAGEMENT">帖子互动</option><option value="PAGE_LIKES">主页赞</option><option value="APP_INSTALLS">应用安装</option><option value="STORE_VISITS">店铺访问</option></select></div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告账户</label><div className="relative"><select value={adSet.adAccountId || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { adAccountId: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white appearance-none"><option value="">自动选择</option>{filteredAccounts.map(acc => <option key={acc.id || acc.account_id} value={acc.account_id}>{acc.name || acc.account_id}</option>)}</select><ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" /></div></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">关联主页</label><div className="relative"><select value={adSet.pageId || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { pageId: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white appearance-none"><option value="">选择主页</option>{filteredPages.map(p => <option key={p.id} value={p.page_id}>{p.name} | {p.page_id}</option>)}</select><ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" /></div></div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-400 mb-2 block">地域定位 (Geo Targeting)</label>
          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">国家/地区 (ISO)</label><input type="text" value={adSet.countries} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { countries: e.target.value })} placeholder="US,GB,CA" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">城市</label><input type="text" value={adSet.cityTargeting || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { cityTargeting: e.target.value })} placeholder="城市ID或名称" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">地区/州</label><input type="text" value={adSet.regionTargeting || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { regionTargeting: e.target.value })} placeholder="地区ID" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">最低年龄(地域)</label><select value={adSet.geoAgeMin || '18'} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { geoAgeMin: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="18">18</option><option value="19">19</option><option value="20">20</option><option value="21">21</option><option value="22">22</option><option value="23">23</option><option value="24">24</option><option value="25">25</option></select></div>
          </div>
          <div className="grid grid-cols-4 gap-3 mt-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">DMA 区域</label><input type="text" value={adSet.dma || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { dma: e.target.value })} placeholder="DMA ID" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">辐射范围 (km)</label><input type="number" value={adSet.radius || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { radius: e.target.value })} placeholder="10" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">排除位置</label><input type="text" value={adSet.excludeLocations || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { excludeLocations: e.target.value })} placeholder="排除位置" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">邮编 (ZIP)</label><input type="text" value={adSet.zips || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { zips: e.target.value })} placeholder="90001,90002" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-400 mb-2 block">人口统计 (Demographics)</label>
          <div className="grid grid-cols-5 gap-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">最低年龄下限</label><select value={adSet.ageMin} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { ageMin: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white">{(adSet.enableAdvantageAudience ? [18,19,20,21,22,23,24,25] : [18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65]).map(v => <option key={v} value={v}>{v}</option>)}</select>{adSet.enableAdvantageAudience && <div className="text-[8px] text-amber-400/70 mt-0.5">Adv+上限25</div>}</div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">最高年龄上限</label><input type="number" min="13" max="65" value={adSet.ageMax} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { ageMax: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">建议起始年龄</label><input type="text" value={adSet.ageRange || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { ageRange: e.target.value })} placeholder="45" className="w-full bg-slate-950 border border-indigo-500/40 rounded-lg px-3 py-2 text-sm text-white" /><div className="text-[8px] text-indigo-400/70 mt-0.5">AI推荐起始(单数字如45)</div></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">性别</label><select value={adSet.gender} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { gender: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="all">全部</option><option value="male">男性</option><option value="female">女性</option></select></div>
            <div className="space-y-2 col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={adSet.enableAgeModify || false} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { enableAgeModify: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" />
                <span className="text-xs text-slate-300">发布后修改年龄</span>
              </label>
              {adSet.enableAgeModify && (
                <div className="flex items-center gap-2 mt-2">
                  <select value={adSet.ageMinModify || adSet.ageMin} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { ageMinModify: e.target.value })} className="flex-1 bg-slate-950 border border-indigo-500/50 rounded-lg px-2 py-1.5 text-sm text-white"><option value="18">18</option><option value="19">19</option><option value="20">20</option><option value="21">21</option><option value="22">22</option><option value="23">23</option><option value="24">24</option><option value="25">25</option><option value="26">26</option><option value="27">27</option><option value="28">28</option><option value="29">29</option><option value="30">30</option><option value="31">31</option><option value="32">32</option><option value="33">33</option><option value="34">34</option><option value="35">35</option><option value="36">36</option><option value="37">37</option><option value="38">38</option><option value="39">39</option><option value="40">40</option><option value="41">41</option><option value="42">42</option><option value="43">43</option><option value="44">44</option><option value="45">45</option><option value="46">46</option><option value="47">47</option><option value="48">48</option><option value="49">49</option><option value="50">50</option><option value="51">51</option><option value="52">52</option><option value="53">53</option><option value="54">54</option><option value="55">55</option><option value="56">56</option><option value="57">57</option><option value="58">58</option><option value="59">59</option><option value="60">60</option><option value="61">61</option><option value="62">62</option><option value="63">63</option><option value="64">64</option><option value="65">65</option></select>
                  <span className="text-[10px] text-slate-500">~</span>
                  <input type="number" min="13" max="65" value={adSet.ageMaxModify || adSet.ageMax} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { ageMaxModify: e.target.value })} className="flex-1 bg-slate-950 border border-indigo-500/50 rounded-lg px-2 py-1.5 text-sm text-white" placeholder="最大" />
                  <span className="text-[9px] text-slate-500 italic">(发布后生效)</span>
                </div>
              )}
            </div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">人生大事</label><select value={adSet.lifeEvents || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { lifeEvents: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="NEW_JOB">新工作</option><option value="NEWLY_MARRIED">新婚</option><option value="NEW_BABY">新生宝宝</option><option value="RECENTLY_MOVED">近期搬家</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">家长身份</label><select value={adSet.parents || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { parents: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="PARENTS">家长</option><option value="EXPECTANT_PARENTS">准父母</option></select></div>
          </div>
          <div className="grid grid-cols-5 gap-3 mt-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">感情状态</label><select value={adSet.relationshipStatus || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { relationshipStatus: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="SINGLE">单身</option><option value="MARRIED">已婚</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">教育程度</label><select value={adSet.education || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { education: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="HIGH_SCHOOL">高中</option><option value="COLLEGE">大学</option><option value="GRAD_SCHOOL">研究生</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">大学</label><input type="text" value={adSet.college || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { college: e.target.value })} placeholder="大学ID" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">收入</label><select value={adSet.income || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { income: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="INCOME_USD_30K_50K">$30K-$50K</option><option value="INCOME_USD_50K_75K">$50K-$75K</option><option value="INCOME_USD_75K_100K">$75K-$100K</option><option value="INCOME_USD_100K_150K">$100K-$150K</option><option value="INCOME_USD_150K_250K">$150K-$250K</option><option value="INCOME_USD_250K_PLUS">$250K+</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">住房状况</label><select value={adSet.homeOwnership || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { homeOwnership: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="HOME_OWNERS">有房</option><option value="RENTERS">租房</option></select></div>
          </div>
          <div className="grid grid-cols-5 gap-3 mt-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">世代</label><select value={adSet.generation || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { generation: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="GEN_Z">Z世代 (Gen Z)</option><option value="MILLENNIAL">千禧一代</option><option value="GEN_X">X世代</option><option value="BABY_BOOMER">婴儿潮一代</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">家庭构成</label><select value={adSet.householdComposition || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { householdComposition: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="CHILDREN_IN_HOUSEHOLD">有子女</option><option value="NO_CHILDREN_IN_HOUSEHOLD">无子女</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">族裔亲和</label><select value={adSet.ethnicAffinity || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { ethnicAffinity: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="AFRICAN_AMERICAN">非裔</option><option value="ASIAN_AMERICAN">亚裔</option><option value="HISPANIC">西裔</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">数字活动</label><select value={adSet.digitalActivities || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { digitalActivities: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="FREQUENT_SHOPPERS">频繁购物</option><option value="MOBILE_ENTHUSIASTS">移动爱好者</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">雇主</label><input type="text" value={adSet.workEmployer || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { workEmployer: e.target.value })} placeholder="雇主" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
          </div>
          <div className="grid grid-cols-5 gap-3 mt-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">政治倾向</label><select value={adSet.politics || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { politics: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">不限</option><option value="LIBERAL">自由派</option><option value="MODERATE">温和派</option><option value="CONSERVATIVE">保守派</option></select></div>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-400 mb-2 block">受众定位 (Audience)</label>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">包含自定义受众(JSON)</label><input type="text" value={adSet.customAudiencesInclude || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { customAudiencesInclude: e.target.value })} placeholder='[{"id":"123"}]' className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white font-mono text-xs" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">排除自定义受众(JSON)</label><input type="text" value={adSet.customAudiencesExclude || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { customAudiencesExclude: e.target.value })} placeholder='[{"id":"456"}]' className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white font-mono text-xs" /></div>
          </div>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">细分定位 (JSON)</label><input type="text" value={adSet.detailedTargeting || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { detailedTargeting: e.target.value })} placeholder='[{"id":123,"name":"Interest"}]' className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white font-mono text-xs" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">排除细分 (JSON)</label><input type="text" value={adSet.detailedExclusions || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { detailedExclusions: e.target.value })} placeholder='[{"id":456}]' className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white font-mono text-xs" /></div>
          </div>
          <div className="flex items-center gap-4 mt-3">
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={adSet.enableAdvantageAudience} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { enableAdvantageAudience: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-xs text-slate-300">进阶赋能型受众(Advantage+)</span></label>
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={adSet.enableAudienceExpansion ?? true} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { enableAudienceExpansion: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-xs text-slate-300">横向扩展受众</span></label>
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={adSet.broadTargeting || false} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { broadTargeting: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-xs text-slate-300">广泛定位 (Broad)</span></label>
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={adSet.friendsOfConnections || false} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { friendsOfConnections: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-xs text-slate-300">好友扩展</span></label>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-400 mb-2 block">设备与平台(Device & Platform)</label>
          <div className="grid grid-cols-7 gap-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">版位</label><select value={adSet.placements} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { placements: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="automatic">自动版位</option><option value="manual">手动版位</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">设备平台</label><div className="flex gap-2"><label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={adSet.devicePlatforms.includes('mobile')} onChange={() => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { devicePlatforms: adSet.devicePlatforms.includes('mobile') ? adSet.devicePlatforms.filter(d => d !== 'mobile') : [...adSet.devicePlatforms, 'mobile'] })} className="w-3 h-3 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-[10px] text-slate-400">移动</span></label><label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={adSet.devicePlatforms.includes('desktop')} onChange={() => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { devicePlatforms: adSet.devicePlatforms.includes('desktop') ? adSet.devicePlatforms.filter(d => d !== 'desktop') : [...adSet.devicePlatforms, 'desktop'] })} className="w-3 h-3 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-[10px] text-slate-400">桌面</span></label></div></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">操作系统</label><select value={adSet.osType} onChange={e => { const os = e.target.value; const kept = (adSet.deviceModels || '').split(',').filter(id => id && (os === 'all' || (DEVICE_MODELS.find(m => m.id === id) || {}).os === os)); const pre = os === 'ios' ? 'ios_' : 'android_'; let ver = adSet.osVersionMin || '0'; if (ver !== '0' && os !== 'all' && !ver.startsWith(pre)) ver = '0'; let verMax = adSet.osVersionMax || '0'; if (verMax !== '0' && os !== 'all' && !verMax.startsWith(pre)) verMax = '0'; updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { osType: os as any, deviceModels: kept.join(','), osVersionMin: ver, osVersionMax: verMax }); }} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="all">全部</option><option value="ios">iOS</option><option value="android">Android</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">OS 版本区间（最低 - 最高）</label>{(() => { const iosVs = osVersions.ios; const andVs = osVersions.android; const grp = (vals: string[], prefix: string, name: string) => <optgroup label={name}>{vals.map(v => <option key={`${prefix}_${v}`} value={`${prefix}_${v}`}>{v}</option>)}</optgroup>; const cls = 'flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-1 py-2 text-[11px] text-white'; const num = (v?: string) => { const m = String(v || '').match(/^(?:ios|android)_(\d+(?:\.\d+)?)$/); return m ? parseFloat(m[1]) : 0; }; return (<div className="flex items-center gap-1"><select value={adSet.osVersionMin || '0'} onChange={e => { const v = e.target.value; const max = adSet.osVersionMax || '0'; updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { osVersionMin: v, osVersionMax: (v !== '0' && max !== '0' && num(max) < num(v)) ? v : max }); }} className={cls}><option value="0">不限</option>{adSet.osType !== 'android' && grp(iosVs, 'ios', 'iOS')}{adSet.osType !== 'ios' && grp(andVs, 'android', 'Android')}</select><span className="text-slate-600 text-[10px]">-</span><select value={adSet.osVersionMax || '0'} onChange={e => { const v = e.target.value; const min = adSet.osVersionMin || '0'; updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { osVersionMax: v, osVersionMin: (v !== '0' && (min === '0' || num(min) > num(v))) ? v : min }); }} className={cls}><option value="0">不限</option>{adSet.osType !== 'android' && grp(iosVs, 'ios', 'iOS')}{adSet.osType !== 'ios' && grp(andVs, 'android', 'Android')}</select></div>); })()}</div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">仅 WiFi</label><button type="button" onClick={() => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { wifiOnly: !adSet.wifiOnly })} className={`w-full py-2 text-sm rounded-lg border transition-all ${adSet.wifiOnly ? 'bg-indigo-600/20 border-indigo-500 text-indigo-400' : 'bg-slate-950 border-slate-800 text-slate-500'}`}>{adSet.wifiOnly ? '开启' : '关闭'}</button></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">广告账户</label><select value={adSet.adAccountId || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { adAccountId: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="">自动选择</option>{availableAccounts.map(a => <option key={a.account_id || a.id} value={a.account_id || a.id}>{a.account_id || a.id}</option>)}</select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">受益广告主</label><input type="text" value={adSet.advertiserName || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { advertiserName: e.target.value })} placeholder="公司/品牌名称" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /><div className="text-[8px] text-amber-400/70 mt-0.5">🇪🇺 欧盟国家必填(如FR/DE)</div></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">设备型号</label><div className="relative"><button type="button" onClick={() => { setDeviceModelsOpen(!deviceModelsOpen); }} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white text-left truncate">{adSet.deviceModels ? `已选 ${adSet.deviceModels.split(',').length} 个` : '点击选择'}</button>{deviceModelsOpen && <div className="absolute z-10 top-full left-0 mt-1 w-[400px] max-h-[300px] overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg p-3 shadow-xl grid grid-cols-3 gap-1" onClick={e => e.stopPropagation()}>{(() => { const sel = (adSet.deviceModels || '').split(',').filter(Boolean); return DEVICE_MODELS.filter(d => adSet.osType === 'all' || d.os === adSet.osType).map(d => <label key={d.id} className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={sel.includes(d.id)} onChange={() => { const cur = new Set(sel); cur.has(d.id) ? cur.delete(d.id) : cur.add(d.id); updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { deviceModels: Array.from(cur).join(',') }); setDeviceModelsOpen(false); }} className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-indigo-600" /><span className="text-[9px] text-slate-300">{d.label}</span></label>); })()}</div>}</div></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">运营商</label><input type="text" value={adSet.carrierTargeting || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { carrierTargeting: e.target.value })} placeholder="ATT,Verizon" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
          </div>
          {adSet.placements === 'manual' && (() => {
            const ALL_PLACEMENTS = [
              { group: 'Facebook', placements: [
                { id: 'feed', label: '动态消息' }, { id: 'video_feeds', label: '视频动态' },
                { id: 'marketplace', label: 'Marketplace' }, { id: 'reels_overlay', label: 'Reels 覆盖' },
                { id: 'story', label: '快拍' }, { id: 'instream', label: '插播视频' },
                { id: 'search', label: '搜索结果' }, { id: 'in_article', label: '即阅文' },
                { id: 'apps_and_sites', label: '应用和网站' },
                { id: 'explore', label: '探索' }, { id: 'shop', label: '购物' }
              ]},
              { group: 'Instagram', placements: [
                { id: 'stream', label: '动态' }, { id: 'explore', label: '探索' },
                { id: 'reels', label: 'Reels' }, { id: 'story_ig', label: '快拍' },
                { id: 'shop', label: '购物' }
              ]},
              { group: 'Audience Network', placements: [
                { id: 'native_banner_interstitial', label: '原生/横幅/插屏' },
                { id: 'rewarded_video', label: '奖励视频' }
              ]},
              // ⚠️ 快拍/故事的 id 必须按平台分开：以前 Facebook、Instagram、Messenger 三组
              //    都用 'story'，勾一个三组联动，服务端也只能把 Messenger 快拍算成 Facebook 的。
              //    服务端 platformMap 约定：story=FB、story_ig=IG、story_m=Messenger
              { group: 'Messenger', placements: [
                { id: 'inbox', label: '收件箱' }, { id: 'story_m', label: '快拍' }
              ]},
              // 🚀 补上 WhatsApp 组：缺了它，「手动版位」推导不出 whatsapp，
              //    下发时 publisher_platforms 会少一个平台（WhatsApp 永远丢）
              { group: 'WhatsApp', placements: [
                { id: 'whatsapp_status', label: '状态' }
              ]},
              { group: 'Threads', placements: [
                { id: 'threads_feed', label: '动态' }, { id: 'threads_profile', label: '个人主页' },
                { id: 'threads_search', label: '搜索' }
              ]}
            ];
            const parseExcluded = (): string[] => {
              try {
                if (!adSet.placementsControl) return [];
                const parsed = JSON.parse(adSet.placementsControl);
                if (parsed.excluded_placements) return parsed.excluded_placements;
                const flat: string[] = [];
                for (const g of ALL_PLACEMENTS) for (const p of g.placements) flat.push(p.id);
                const included: string[] = [];
                for (const g of ALL_PLACEMENTS) {
                  const key = g.group.toLowerCase() + '_positions';
                  if (parsed[key]) included.push(...parsed[key].map((x: string) => g.group.toLowerCase() + '_' + x));
                }
                return flat.filter(x => !included.some((y: string) => x === y));
              } catch { return []; }
            };
            const excluded = parseExcluded();
            const isExcluded = (id: string) => excluded.includes(id);
            const togglePl = (pid: string) => {
              const cur = new Set(excluded);
              if (cur.has(pid)) cur.delete(pid); else cur.add(pid);
              const s = JSON.stringify({ excluded_placements: Array.from(cur) });
              updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { placementsControl: s });
            };
            const setAll = (exclude: boolean) => {
              const allIds = ALL_PLACEMENTS.flatMap(g => g.placements.map(p => p.id));
              const s = JSON.stringify({ excluded_placements: exclude ? allIds : [] });
              updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { placementsControl: s });
            };
            return (<div className="mt-3 p-3 bg-slate-900/50 border border-slate-800 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-medium text-slate-400">详细版位</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAll(false)} className="text-[9px] bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/40 px-2 py-0.5 rounded">全选</button>
                  <button type="button" onClick={() => setAll(true)} className="text-[9px] bg-rose-600/20 text-rose-400 hover:bg-rose-600/40 px-2 py-0.5 rounded">全取消</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">{ALL_PLACEMENTS.map(g => (
                <div key={g.group} className="flex flex-col gap-1 min-w-[120px]">
                  <span className="text-[9px] font-medium text-slate-500">{g.group}</span>
                  {g.placements.map(p => (<label key={p.id} className="flex items-center gap-1 cursor-pointer">
                    <input type="checkbox" checked={!isExcluded(p.id)} onChange={() => togglePl(p.id)} className="w-3 h-3 rounded border-slate-700 bg-slate-800 text-indigo-600" />
                    <span className="text-[9px] text-slate-300">{p.label}</span>
                  </label>))}
                </div>
              ))}</div>
            </div>);
          })()}
          <div className="grid grid-cols-3 gap-3 mt-3">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">网速</label><select value={adSet.connectionSpeed || 'any'} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { connectionSpeed: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="any">不限</option><option value="LOW">慢速</option><option value="MEDIUM">中等</option><option value="HIGH">高速</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">排除已赞用户</label><input type="text" value={adSet.excludedConnections || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { excludedConnections: e.target.value })} placeholder="主页ID,好友ID" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">语言 (多选)</label><div className="flex flex-wrap gap-1 p-2 bg-slate-950 border border-slate-800 rounded-lg min-h-[38px]">{adSet.languages ? adSet.languages.split(',').filter(Boolean).map(lc => { const l = FB_LANGUAGES.find(x => x.code === lc); return l ? <span key={lc} className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-600/20 border border-indigo-500/30 rounded text-[10px] text-indigo-300">{l.name}<button type="button" onClick={() => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { languages: (adSet.languages||'').split(',').filter(x => x !== lc).join(',') })} className="text-indigo-400 hover:text-indigo-200 ml-0.5">✕</button></span> : null; }) : <span className="text-[10px] text-slate-600 italic">点击选择语言</span>}</div><select onChange={e => { const v = e.target.value; if (!v) return; const cur = (adSet.languages||'').split(',').filter(Boolean); if (!cur.includes(v)) { cur.push(v); updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { languages: cur.join(',') }); } }} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-[9px] text-white mt-1"><option value="">+ 添加语言</option>{FB_LANGUAGES.filter(l => !(adSet.languages||'').split(',').includes(l.code)).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}</select></div>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-400 mb-2 block">预算与竞价(Ad Set Budget & Bidding)</label>
          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">广告组预算 (USD)</label><input type="number" value={adSet.budget || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { budget: e.target.value })} placeholder="仅当组预算模式" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">成本上限 (USD)</label><input type="number" value={adSet.costCap || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { costCap: e.target.value })} placeholder="Cost Cap" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">最低 ROAS</label><input type="number" value={adSet.minRoas || ''} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { minRoas: e.target.value })} placeholder="例 1.5" step="0.1" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white" /></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">转化量最大化 (VO)</label><button type="button" onClick={() => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { enableVO: !adSet.enableVO })} className={`w-full py-2 text-sm rounded-lg border transition-all ${adSet.enableVO ? 'bg-emerald-600/20 border-emerald-500 text-emerald-400' : 'bg-slate-950 border-slate-800 text-slate-500'}`}>{adSet.enableVO ? '已开启' : '关闭'}</button></div>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-400 mb-2 block">投放与归因(Delivery & Attribution)</label>
          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-2"><label className="text-[10px] text-slate-500">投放类型</label><select value={adSet.deliveryType || 'standard'} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { deliveryType: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="standard">标准</option><option value="accelerated">加速投放</option></select></div>
            {/* 广告组级归因窗口：留空则用广告系列面板的「转化归因窗口」，填了就以这里为准 */}
            <div className="space-y-2"><label className="text-[10px] text-slate-500">转化窗口</label><select value={adSet.conversionWindow || '7d_click_1d_view'} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { conversionWindow: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="1d_click_0_view">1天点击（无浏览）</option><option value="7d_click_0_view">7天点击（无浏览）</option><option value="1d_click_1d_view">1天点击+1天互动观看+1天浏览</option><option value="7d_click_1d_view">7天点击+1天互动观看+1天浏览</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">归因模型</label><select value={adSet.attributionModel || 'STANDARD'} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { attributionModel: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="STANDARD">标准归因</option><option value="DATA_DRIVEN">数据驱动</option></select></div>
            <div className="space-y-2"><label className="text-[10px] text-slate-500">客户生命周期</label><select value={adSet.customerLifecycle || 'ALL'} onChange={e => updateAdSet(selectedCampaignIdx, selectedAdSetIdx, { customerLifecycle: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"><option value="ALL">促进所有受众发生转化</option><option value="NEW">获取新客户</option></select></div>
          </div>
        </div>
      </div>
    );
  };

  // ===== 广告设置面板 (完整版FB后台) =====
  const renderAdPanel = () => {
    if (!ad) return null;
    const adMediaFiles = (sessionMediaCache[ad.id] || []).filter(f => f && typeof f.type === 'string');
    // 🐛 修复：模板加载时 mediaFiles 可能含非 File 对象（JSON序列化丢失type），避免 startsWith 崩溃
    return (
      <div className="space-y-5 animate-in fade-in slide-in-from-bottom-3 duration-200">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2"><Zap className="w-4 h-4 text-amber-400" />广告设置 (完整版FB后台)</h3>
          <div className="flex items-center gap-2">
            <span className="text-[8px] text-slate-500">发布数量:</span>
            <input type="number" min="1" max="20" value={ad?.adCount ?? 1} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { adCount: Math.max(1, parseInt(e.target.value) || 1) })} className="w-10 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-white text-center" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告名称</label><input type="text" value={ad.name} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { name: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告状态</label><button type="button" onClick={() => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { adStatus: ad.adStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ad.adStatus === 'ACTIVE' ? 'bg-emerald-600' : 'bg-slate-700'}`}><span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${ad.adStatus === 'ACTIVE' ? 'translate-x-5' : 'translate-x-1'}`} /></button></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告格式</label><select value={ad.adFormat} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { adFormat: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="SINGLE_IMAGE_VIDEO">单图/视频</option><option value="CAROUSEL">轮播 (Carousel)</option><option value="COLLECTION">精品栏(Collection)</option><option value="INSTANT_EXPERIENCE">即时体验 (Instant)</option><option value="DYNAMIC">动态创意(Dynamic)</option></select></div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">落地页URL</label><input type="url" value={ad.websiteUrl} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { websiteUrl: e.target.value })} placeholder="https://" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">显示链接</label><div className="flex gap-2 items-center"><label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={ad.useDisplayLink} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { useDisplayLink: e.target.checked })} className="w-3 h-3 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-[10px] text-slate-400">启用</span></label>{ad.useDisplayLink && <input type="text" value={ad.displayLink || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { displayLink: e.target.value })} placeholder="www.example.com" className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white" />}</div></div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">Deep Link (应用深度链接)</label><input type="text" value={ad.deepLink || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { deepLink: e.target.value })} placeholder="app://deep/link" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">网址参数</label><input type="text" value={ad.urlParams || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { urlParams: e.target.value })} placeholder="utm_source=facebook" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white font-mono text-xs" /></div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">图片素材 <span className="text-[10px] text-slate-500 font-normal">(每张图创建一条广告{ad.videoFile ? ' · 点击图片设为视频封面' : ''})</span></label>
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <div className="grid grid-cols-3 gap-2 mb-2">{adMediaFiles.map((f, fi) => (<div key={fi} className="relative group aspect-square bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">{f.type.startsWith('image/') && <img src={URL.createObjectURL(f)} className="w-full h-full object-cover" />}<div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">{ad.videoFile ? <button type="button" onClick={() => { updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { videoThumbnailIndex: fi }); }} className={`p-1 rounded-full ${ad.videoThumbnailIndex === fi ? 'bg-emerald-600' : 'bg-indigo-600'}`}><span className="text-[8px] text-white px-1">{ad.videoThumbnailIndex === fi ? '封面' : '设为封面'}</span></button> : null}<button type="button" onClick={() => { sessionMediaCache[ad.id] = adMediaFiles.filter((_, i) => i !== fi); updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, {}); }} className="p-1 bg-rose-600 rounded-full"><Trash2 className="w-3 h-3 text-white" /></button></div>{ad.videoThumbnailIndex === fi && <div className="absolute top-1 left-1 bg-emerald-600 text-[8px] text-white px-1 py-0.5 rounded font-bold">封面</div>}<div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[8px] text-white px-1 py-0.5 truncate">{f.name}</div></div>))}<label className="flex flex-col items-center justify-center aspect-square bg-slate-950/50 border-2 border-dashed border-slate-800 rounded-lg cursor-pointer hover:border-indigo-500/50"><Upload className="w-4 h-4 text-slate-500" /><span className="text-[9px] text-slate-600 mt-1">添加</span><input type="file" accept="image/*" multiple onChange={(e) => { const files = Array.from(e.target.files || []); sessionMediaCache[ad.id] = [...adMediaFiles, ...files]; updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, {}); }} className="hidden" /></label></div>
              <button type="button" onClick={() => { fetchMediaLibrary(); setShowMediaLibrary(true); }} className="text-[10px] text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 px-2 py-1 rounded-lg transition-colors w-full">素材库</button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">视频素材 <span className="text-[10px] text-slate-500 font-normal">(可选)</span></label>
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <div className="border-2 border-dashed border-slate-800 rounded-lg p-4 text-center cursor-pointer hover:border-indigo-500/50 transition-all" onClick={() => document.getElementById(`video-input-${ad.id}`)?.click()}>{ad.videoFile ? (<div className="flex items-center gap-2"><div className="w-8 h-8 rounded bg-indigo-600/20 flex items-center justify-center"><Zap className="w-4 h-4 text-indigo-400" /></div><span className="text-xs text-slate-300 truncate">{ad.videoFile.name}</span><button type="button" onClick={(e) => { e.stopPropagation(); updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { videoFile: undefined }); }} className="p-1 bg-rose-600 rounded-full ml-auto"><Trash2 className="w-3 h-3 text-white" /></button></div>) : (<div className="text-center"><Upload className="w-6 h-6 text-slate-600 mx-auto mb-1" /><span className="text-[10px] text-slate-500">点击上传视频</span></div>)}</div>
              <input id={`video-input-${ad.id}`} type="file" accept="video/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { videoFile: file }); }} className="hidden" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-4">
            <div className="space-y-2"><label className="text-xs font-medium text-slate-400">主要文案</label><textarea value={ad.adText} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { adText: e.target.value })} rows={3} placeholder="广告正文内容" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white resize-none" /></div>
            <div className="space-y-2"><label className="text-xs font-medium text-slate-400">文案变体 (动态创意)</label><textarea value={ad.adText2 || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { adText2: e.target.value })} rows={2} placeholder="用于A/B测试的第二条文案" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white resize-none" /></div>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2"><label className="text-xs font-medium text-slate-400">标题</label><input type="text" value={ad.headline} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { headline: e.target.value })} placeholder="标题" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
              <div className="space-y-2"><label className="text-xs font-medium text-slate-400">标题变体</label><input type="text" value={ad.headline2 || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { headline2: e.target.value })} placeholder="A/B测试标题" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告说明</label><input type="text" value={ad.adDescription || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { adDescription: e.target.value })} placeholder="可选" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
              <div className="space-y-2"><label className="text-xs font-medium text-slate-400">说明变体</label><input type="text" value={ad.adDescription2 || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { adDescription2: e.target.value })} placeholder="A/B测试说明" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">CTA 按钮</label><select value={ad.ctaType} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { ctaType: e.target.value, ctaManuallySet: true })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="LEARN_MORE">了解更多</option><option value="LIKE_PAGE">赞主页</option><option value="MESSAGE_PAGE">发消息</option><option value="SHOP_NOW">立即购买</option><option value="SIGN_UP">注册</option><option value="CONTACT_US">联系我们</option><option value="GET_OFFER">获取优惠</option><option value="BOOK_NOW">立即预订</option><option value="DOWNLOAD">下载</option><option value="SUBSCRIBE">订阅</option></select></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">自定义 CTA</label><input type="text" value={ad.callToActionCustom || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { callToActionCustom: e.target.value })} placeholder="自定义按钮文字" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          {campaign.objective === 'OUTCOME_LEADS' ? (
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">线索表单 ID</label><input type="text" value={ad.leadFormId || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { leadFormId: e.target.value })} placeholder="仅线索目标" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          ) : <div />}
          {campaign.objective === 'MESSAGES' || campaign.objective === 'OUTCOME_ENGAGEMENT' ? (
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">Messenger 欢迎消息</label><input type="text" value={ad.messengerWelcomeMessage || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { messengerWelcomeMessage: e.target.value })} placeholder="欢迎消息" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          ) : <div />}
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-400">像素 ID</label>
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-2 max-h-24 overflow-y-auto custom-scrollbar space-y-1">{filteredPixels.length === 0 ? <div className="text-[10px] text-slate-500 text-center py-1">暂无像素</div> : filteredPixels.map(px => { const c = ad.pixelIds?.includes(px.pixel_id) || false; return (<label key={px.id || px.pixel_id} className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer transition-colors ${c ? 'bg-indigo-500/15 text-indigo-300' : 'text-slate-400 hover:bg-slate-800/50'}`}><input type="checkbox" checked={c} onChange={() => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { pixelIds: c ? (ad.pixelIds || []).filter(id => id !== px.pixel_id) : [...(ad.pixelIds || []), px.pixel_id] })} className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-indigo-500" /><span className="text-[10px] truncate flex-1"><span className="text-indigo-400/70 font-mono">#{px.profile_id || px.profileId}</span> {px.name || px.pixel_id}</span></label>)})}</div>
          </div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">转化事件</label><select value={ad.conversionEvent || 'PURCHASE'} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { conversionEvent: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="PURCHASE">购买</option><option value="LEAD">线索</option><option value="ADD_TO_CART">加入购物车</option><option value="COMPLETE_REGISTRATION">完成注册</option><option value="INITIATE_CHECKOUT">发起结账</option><option value="CONTACT">联系</option><option value="VIEW_CONTENT">查看内容</option></select></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">产品目录 ID</label><input type="text" value={ad.productCatalogId || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { productCatalogId: e.target.value })} placeholder="Catalog ID" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">即时体验 ID</label><input type="text" value={ad.instantExperienceId || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { instantExperienceId: e.target.value })} placeholder="Instant Experience" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">产品集ID</label><input type="text" value={ad.productSetId || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { productSetId: e.target.value })} placeholder="Product Set" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">优惠 ID</label><input type="text" value={ad.offerId || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { offerId: e.target.value })} placeholder="Offer ID" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
          <div className="space-y-2"><label className="text-xs font-medium text-slate-400">优惠描述</label><input type="text" value={ad.offerDescription || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { offerDescription: e.target.value })} placeholder="Offer 描述" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
        </div>
        <div className="border-t border-slate-800 pt-4 mt-1">
          <div className="flex items-center gap-2 mb-3">
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={ad.enableAdvantageCreative} onChange={e => { const v = e.target.checked; updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { enableAdvantageCreative: v, enableEnhancements: v }); }} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-xs text-slate-300 font-medium">进阶赋能型创意 (Advantage+)</span></label>
            <span className="text-[9px] text-slate-500 italic">自动测试最佳创意组合</span>
          </div>
          {ad.enableAdvantageCreative && (
            <div className="ml-5 pl-3 border-l-2 border-indigo-500/30 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={ad.enableEnhancements ?? true} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { enableEnhancements: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" />
                <span className="text-xs text-slate-200">进阶赋能型素材增强</span>
              </label>
              {ad.enableEnhancements !== false && (
                <div className="ml-4 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {[
                    { key: 'enhancementOverlayText', label: '叠加文字' },
                    { key: 'enhancementVisualPolish', label: '视觉润色' },
                    { key: 'enhancementAddMusic', label: '添加音乐' },
                    { key: 'enhancementCopyImprove', label: '文案改进' },
                    { key: 'enhancementAddAnimation', label: '添加动画' },
                    { key: 'enhancementImageGeneration', label: '素材图片生成' },
                  ].map(opt => (
                    <label key={opt.key} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={(ad as any)[opt.key] ?? true} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { [opt.key]: e.target.checked } as any)} className="w-3 h-3 rounded border-slate-700 bg-slate-800 text-indigo-600" />
                      <span className="text-[11px] text-slate-400">{opt.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={ad.enableDynamicCreative} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { enableDynamicCreative: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-xs text-slate-300">动态创意(A/B测试)</span></label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={ad.enableVO} onChange={e => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { enableVO: e.target.checked })} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" /><span className="text-xs text-slate-300">视频轮播 (VO)</span></label>
        </div>
        {/* 🚀 多语言广告 */}
        <div className="border-t border-slate-800 pt-4 mt-1">
          <div className="flex items-center gap-2 mb-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={ad.enableLanguage ?? false} onChange={e => {
                const v = e.target.checked;
                updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { enableLanguage: v, primaryLanguage: v ? 'en' : '', additionalLanguages: v ? [] : undefined });
              }} className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-indigo-600" />
              <span className="text-xs text-slate-300 font-medium">多语言广告 (Multilingual)</span>
            </label>
          </div>
          {(ad.enableLanguage ?? false) && (
            <div className="ml-5 pl-3 border-l-2 border-sky-500/30 space-y-4">
              {/* 默认语言 */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-slate-400">默认语言</label>
                <LanguageSelect
                  value={ad.primaryLanguage || 'en'}
                  onChange={v => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { primaryLanguage: v })}
                  placeholder="搜索语言..."
                  languages={AD_CREATIVE_LANGUAGES}
                />
              </div>
              {/* 备选语言（多选） */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-slate-400">备选语言 <span className="text-[10px] text-slate-500 font-normal">(可多选)</span></label>
                <MultiLanguageSelect
                  selected={ad.additionalLanguages || []}
                  onChange={v => updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, { additionalLanguages: v })}
                  exclude={[ad.primaryLanguage || 'en']}
                  placeholder="搜索并选择备选语言..."
                  languages={AD_CREATIVE_LANGUAGES}
                />
              </div>
              {/* 各语言独立内容编辑 */}
              {((ad.additionalLanguages || []).length > 0) && (
                <div className="space-y-3">
                  <label className="text-[11px] font-medium text-slate-400">各语言内容 <span className="text-[10px] text-slate-500 font-normal">(不填则使用默认语言内容)</span></label>
                  {[ad.primaryLanguage || 'en', ...(ad.additionalLanguages || [])].filter(Boolean).map(langCode => {
                    const langInfo = AD_CREATIVE_LANGUAGES.find(l => l.code === langCode);
                    const langName = langInfo?.name || langCode;
                    const isPrimary = langCode === ad.primaryLanguage;
                    const content = ad.languageContent?.[langCode] || { headline: '', body: '', description: '', websiteUrl: '' };
                    const setContent = (field: string, val: string) => {
                      const cur = ad.languageContent || {};
                      const langCur = cur[langCode] || { headline: '', body: '', description: '', websiteUrl: '' };
                      updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, {
                        languageContent: { ...cur, [langCode]: { ...langCur, [field]: val } }
                      });
                    };
                    const setContentFiles = (files: File[]) => {
                      const cur = ad.languageContent || {};
                      const langCur = cur[langCode] || { headline: '', body: '', description: '', websiteUrl: '' };
                      updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, {
                        languageContent: { ...cur, [langCode]: { ...langCur, mediaFiles: files } }
                      });
                    };
                    const langMediaFiles = (content.mediaFiles || []).filter(f => f && typeof f.type === 'string');
                    // 🐛 修复：模板加载时 mediaFiles 可能含 null 或非 File 对象（JSON序列化丢失type），不能用 startsWith
                    return (
                      <div key={langCode} className={`p-2.5 rounded-lg border ${isPrimary ? 'border-sky-500/40 bg-sky-950/10' : 'border-slate-700/50 bg-slate-900/30'}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`text-[11px] font-medium ${isPrimary ? 'text-sky-300' : 'text-slate-300'}`}>{langName}</span>
                          {isPrimary && <span className="text-[8px] text-sky-400/70 bg-sky-500/10 px-1.5 py-0.5 rounded-full">默认</span>}
                        </div>
                        <div className="grid grid-cols-1 gap-1.5">
                          <div className="flex gap-1.5">
                            <div className="flex-1"><input type="text" value={content.body || ''} onChange={e => setContent('body', e.target.value)} placeholder={`文案 (${langCode})`} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-600" /></div>
                            <div className="flex-1"><input type="text" value={content.headline || ''} onChange={e => setContent('headline', e.target.value)} placeholder={`标题 (${langCode})`} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-600" /></div>
                          </div>
                          <div className="flex gap-1.5">
                            <div className="flex-1"><input type="text" value={content.description || ''} onChange={e => setContent('description', e.target.value)} placeholder={`说明 (可选)`} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-600" /></div>
                            <div className="flex-1"><input type="text" value={content.websiteUrl || ''} onChange={e => setContent('websiteUrl', e.target.value)} placeholder={`落地页 (留空使用默认)`} className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-600" /></div>
                          </div>
                          {/* 🖼️ 各语言独立素材 */}
                          <div>
                            <div className="flex flex-wrap gap-1.5 mb-1">{langMediaFiles.map((f, fi) => (
                              <div key={fi} className="relative w-12 h-12 bg-slate-950 border border-slate-800 rounded-lg overflow-hidden group">
                                {f.type.startsWith('image/') && <img src={URL.createObjectURL(f)} className="w-full h-full object-cover" />}
                                {f.type.startsWith('video/') && <div className="w-full h-full flex items-center justify-center bg-slate-900"><Zap className="w-4 h-4 text-indigo-400" /></div>}
                                <button type="button" onClick={() => setContentFiles(langMediaFiles.filter((_, i) => i !== fi))} className="absolute top-0.5 right-0.5 w-4 h-4 bg-rose-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100"><Trash2 className="w-2.5 h-2.5 text-white" /></button>
                              </div>
                            ))}<label className="flex items-center justify-center w-12 h-12 bg-slate-950/50 border border-dashed border-slate-800 rounded-lg cursor-pointer hover:border-indigo-500/50"><Upload className="w-3 h-3 text-slate-500" /><input type="file" accept="image/*,video/*" multiple onChange={e => { const files = Array.from(e.target.files || []); setContentFiles([...langMediaFiles, ...files]); }} className="hidden" /></label></div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ===== 子组件：可搜索语言下拉 =====
  const LanguageSelect: React.FC<{
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    languages: { code: string; name: string }[];
  }> = ({ value, onChange, placeholder, languages }) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const filtered = search ? languages.filter(l => l.code.includes(search.toLowerCase()) || l.name.toLowerCase().includes(search.toLowerCase())) : languages;
    const selected = languages.find(l => l.code === value);
    return (
      <div className="relative">
        <div
          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white cursor-pointer flex items-center justify-between"
          onClick={() => setOpen(!open)}
        >
          <span className={selected ? '' : 'text-slate-500'}>{selected ? `${selected.name}` : placeholder}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-20 max-h-56 overflow-hidden flex flex-col">
            <div className="p-2 border-b border-slate-800">
              <div className="flex items-center gap-2 bg-slate-950 rounded-lg px-3 py-1.5">
                <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={placeholder}
                  className="bg-transparent border-none outline-none text-xs text-white w-full"
                  autoFocus
                />
              </div>
            </div>
            <div className="overflow-y-auto custom-scrollbar flex-1">
              {filtered.length === 0 ? (
                <div className="text-xs text-slate-500 text-center py-4">无匹配语言</div>
              ) : (
                filtered.map(l => (
                  <div
                    key={l.code}
                    className={`px-3 py-2 text-xs cursor-pointer transition-colors flex items-center justify-between ${l.code === value ? 'bg-sky-500/15 text-sky-300' : 'text-slate-300 hover:bg-slate-800'}`}
                    onClick={() => { onChange(l.code); setOpen(false); setSearch(''); }}
                  >
                    <span>{l.name}</span>
                    {l.code === value && <CheckCircle2 className="w-3 h-3 text-sky-400" />}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ===== 子组件：可搜索多选语言 =====
  const MultiLanguageSelect: React.FC<{
    selected: string[];
    onChange: (v: string[]) => void;
    exclude: string[];
    placeholder: string;
    languages: { code: string; name: string }[];
  }> = ({ selected, onChange, exclude, placeholder, languages }) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const available = languages.filter(l => !exclude.includes(l.code));
    const filtered = search ? available.filter(l => l.code.includes(search.toLowerCase()) || l.name.toLowerCase().includes(search.toLowerCase())) : available;
    const selectedItems = languages.filter(l => selected.includes(l.code));
    const toggle = (code: string) => {
      if (selected.includes(code)) {
        onChange(selected.filter(c => c !== code));
      } else {
        onChange([...selected, code]);
      }
    };
    return (
      <div className="relative">
        <div
          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white cursor-pointer flex items-center justify-between min-h-[38px]"
          onClick={() => setOpen(!open)}
        >
          <div className="flex-1 flex flex-wrap gap-1">
            {selectedItems.length === 0 ? (
              <span className="text-slate-500">{placeholder}</span>
            ) : (
              selectedItems.map(l => (
                <span key={l.code} className="inline-flex items-center gap-1 bg-sky-500/15 text-sky-300 text-[10px] px-2 py-0.5 rounded-full">
                  {l.name}
                  <button type="button" onClick={(e) => { e.stopPropagation(); toggle(l.code); }} className="hover:text-white">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))
            )}
          </div>
          <ChevronDown className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-20 max-h-64 overflow-hidden flex flex-col">
            <div className="p-2 border-b border-slate-800">
              <div className="flex items-center gap-2 bg-slate-950 rounded-lg px-3 py-1.5">
                <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={placeholder}
                  className="bg-transparent border-none outline-none text-xs text-white w-full"
                  autoFocus
                />
              </div>
            </div>
            <div className="overflow-y-auto custom-scrollbar flex-1">
              {filtered.length === 0 ? (
                <div className="text-xs text-slate-500 text-center py-4">无匹配语言</div>
              ) : (
                <div>
                  {selectedItems.length > 0 && (
                    <div className="px-3 py-1.5 border-b border-slate-800">
                      <div className="flex flex-wrap gap-1">
                        {selectedItems.map(l => (
                          <span key={l.code} className="inline-flex items-center gap-1 bg-sky-500/15 text-sky-300 text-[10px] px-2 py-0.5 rounded-full">
                            {l.name}
                            <button type="button" onClick={(e) => { e.stopPropagation(); toggle(l.code); }} className="hover:text-white">
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {filtered.map(l => (
                    <div
                      key={l.code}
                      className={`px-3 py-2 text-xs cursor-pointer transition-colors flex items-center justify-between ${selected.includes(l.code) ? 'bg-sky-500/15 text-sky-300' : 'text-slate-300 hover:bg-slate-800'}`}
                      onClick={() => { toggle(l.code); setSearch(''); }}
                    >
                      <span>{l.name}</span>
                      {selected.includes(l.code) && <CheckCircle2 className="w-3 h-3 text-sky-400" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ===== 主渲染 =====
  const tabs = [
    { id: 'campaign', label: '广告系列', icon: Layers, panel: renderCampaignPanel },
    { id: 'adset', label: '广告组', icon: Users, panel: renderAdSetPanel },
    { id: 'ad', label: '广告', icon: Zap, panel: renderAdPanel },
  ];

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-[95vw] max-w-[1600px] overflow-hidden shadow-2xl flex flex-col h-[95vh]">
        <div className="flex justify-between items-center p-4 border-b border-slate-800 bg-slate-900/50 shrink-0">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2"><Target className="w-5 h-5 text-indigo-500" />{templateMode ? '编辑广告模板' : '发布 Facebook 广告'}</h2>
              {templateMode ? (
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="输入模板名称..."
                  className="w-64 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-2 focus:ring-indigo-500 outline-none placeholder-slate-600"
                />
              ) : (
                <p className="text-slate-400 text-xs">选定 {profileIds.length} 个环境</p>
              )}
            </div>
            {!templateMode && <div className="relative">
              <button onClick={() => setIsTemplateMenuOpen(!isTemplateMenuOpen)} className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-400 hover:text-indigo-300"><FileText className="w-3.5 h-3.5" />配置模板<ChevronDown className={`w-3 h-3 transition-transform ${isTemplateMenuOpen ? 'rotate-180' : ''}`} /></button>
              {renderTemplateDropdown()}
            </div>}
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-white transition-colors p-2 hover:bg-slate-800 rounded-full"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          {renderTree()}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex border-b border-slate-800 bg-slate-950/20 shrink-0">
              {tabs.map(tab => (
                <button key={tab.id} onClick={() => setSelectedType(tab.id as SelectedLevel)} className={`flex items-center gap-1.5 px-5 py-3 text-xs font-bold transition-all relative ${selectedType === tab.id ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}>
                  <tab.icon className={`w-3.5 h-3.5 ${selectedType === tab.id ? 'text-indigo-400' : 'text-slate-600'}`} />{tab.label}{selectedType === tab.id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500" />}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-5 custom-scrollbar bg-slate-900/30">
              <form id="ad-publish-form" onSubmit={handleSubmit}>
                {selectedType === 'campaign' && renderCampaignPanel()}
                {selectedType === 'adset' && renderAdSetPanel()}
                {selectedType === 'ad' && renderAdPanel()}
              </form>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between p-4 border-t border-slate-800 bg-slate-900/50 shrink-0">
          <div className="text-[10px] text-slate-500">{templateMode ? `总计 ${tree.reduce((s,c) => s + c.adSets.reduce((ss,a) => ss + a.ads.length, 0), 0)} 条广告` : `选定 ${profileIds.length} 个环境 · 总计 ${tree.reduce((s,c) => s + c.adSets.reduce((ss,a) => ss + a.ads.length, 0), 0)} 条广告`}</div>
          <div className="flex gap-3">
            <button onClick={onCancel} className="px-5 py-2 text-sm text-slate-400 hover:text-white border border-slate-700 hover:border-slate-600 rounded-xl transition-all">取消</button>
            <button type="submit" form="ad-publish-form" data-submit="true" disabled={isSubmitting} className="px-6 py-2 text-sm font-bold text-white bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 rounded-xl transition-all shadow-lg shadow-indigo-600/20 flex items-center gap-2 disabled:opacity-50">
              {isSubmitting ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {templateMode ? '保存中...' : '提交中...'}</> : <>{templateMode ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />} {templateMode ? '保存模板' : '发布广告'}</>}
            </button>
          </div>
        </div>
        {showMediaLibrary && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowMediaLibrary(false)}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl w-[600px] max-h-[80vh] overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between p-4 border-b border-slate-800">
                <h3 className="text-sm font-bold text-white flex items-center gap-2"><ImageIcon className="w-4 h-4 text-indigo-400" />素材库</h3>
                <button onClick={() => setShowMediaLibrary(false)} className="p-1 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
                {mediaLibLoading ? <div className="flex items-center justify-center py-10"><div className="w-6 h-6 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" /></div>
                : mediaLibrary.length === 0 ? <div className="text-center py-10 text-slate-500 text-sm">暂无保存素材</div>
                : <div className="grid grid-cols-3 gap-3">{mediaLibrary.map((m: any) => (
                    <div key={m.id} className="group relative bg-slate-950 border border-slate-800 rounded-xl overflow-hidden cursor-pointer hover:border-indigo-500/50 transition-all" onClick={() => { const blob = (() => { try { const p = m.data_url.split(','); const mt = p[0].match(/:(.*?);/)?.[1] || 'image/jpeg'; const b = atob(p[1]); const ab = new ArrayBuffer(b.length); const ia = new Uint8Array(ab); for (let i = 0; i < b.length; i++) ia[i] = b.charCodeAt(i); return new Blob([ab], { type: mt }); } catch { return null; } })(); if (blob) { const file = new File([blob], m.file_name || m.name || 'media.jpg', { type: m.mime_type || 'image/jpeg' }); if (ad) { sessionMediaCache[ad.id] = [...(sessionMediaCache[ad.id] || []), file]; updateAd(selectedCampaignIdx, selectedAdSetIdx, selectedAdIdx, {}); } } setShowMediaLibrary(false); }}>
                    {m.data_url?.startsWith('data:image') ? <img src={m.data_url} className="w-full aspect-square object-cover" alt={m.name} /> : <div className="w-full aspect-square flex items-center justify-center bg-slate-950 text-slate-600 text-[10px]">{m.mime_type}</div>}
                    <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[10px] text-white px-1.5 py-0.5 truncate">{m.name}</div>
                    </div>
                  ))}</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
