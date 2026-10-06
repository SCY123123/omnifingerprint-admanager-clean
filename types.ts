// ==================== Enums ====================

export enum Platform {
  META = 'Meta (Facebook/Instagram)',
  TIKTOK = 'TikTok',
  GOOGLE = 'Google Ads',
  X = 'X (Twitter)',
  INSTAGRAM = 'Instagram',
  NONE = 'None'
}

export enum BrowserStatus {
  IDLE = 'Idle',
  RUNNING = 'Running',
  SUSPENDED = 'Suspended',
  ERROR = 'Error'
}

export enum AccountStatus {
  ACTIVE = 'Active',
  RESTRICTED = 'Restricted',
  DISABLED = 'Disabled',
  REVIEW = 'In Review',
  UNKNOWN = 'Unknown'
}

/** Facebook 广告账户状态（更多细分状态） */
export type FbAdAccountStatus =
  | 'ACTIVE'
  | 'DISABLED'
  | 'IN_REVIEW'
  | 'PRE_REVIEW'
  | 'PENDING_RISK_REVIEW'
  | 'PENDING_CLOSURE'
  | 'CLOSED'
  | 'SETTLEMENT_IN_PROGRESS'
  | 'UNSETTLED'
  | 'WITH_ISSUES'
  | 'UNKNOWN';

/** BM 状态 */
export type BmStatus = 'Active' | 'Restricted' | 'Ban' | 'Pending';

/** 用户角色 */
export type UserRole = 'superadmin' | 'admin' | 'user';

/** 操作结果类型（用于 Toast 等） */
export type ToastType = 'success' | 'error' | 'info' | 'warning';

// ==================== 通用 API 响应 ====================

/** 标准 API 响应包装 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  step?: string;
  stack?: string;
}

/** 分页元数据 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** 带分页的 API 响应 */
export interface PaginatedResponse<T = unknown> extends ApiResponse<T> {
  pagination: PaginationMeta;
}

// ==================== 用户 & 认证 ====================

/** 用户行（对应 users 表） */
export interface UserRow {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  status: string;
  password_hash?: string;
  parent_id?: number;
  permission_level?: string;
  subscription_expires_at?: string;
  last_login?: string;
  created_at?: string;
  updated_at?: string;
}

/** /api/auth/me 返回的用户信息 */
export interface AuthUser {
  id: number;
  email: string;
  role: UserRole;
  name: string;
  permission_level: string;
}

// ==================== 浏览器配置 (Profiles) ====================

/** profiles 表行（从数据库查询的原始行） */
export interface ProfileRow {
  id: number;
  user_id?: number;
  ext_id?: string;
  name: string;
  platform?: string;
  status?: string;
  user_agent?: string;
  start_url?: string;
  account_name?: string;
  account_email?: string;
  account_password?: string;
  account_cookies?: string;
  account_tokens?: string;
  account_notes?: string;
  proxy_enabled?: number;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: string;
  proxy_username?: string;
  proxy_password?: string;
  proxy?: string;
  proxy_config?: string;
  pages_count?: number;
  bm_count?: number;
  pixels_count?: number;
  os?: string;
  resolution?: string;
  timezone?: string;
  language?: string;
  fb_language?: string;
  fingerprint_protection?: string;
  seq?: number;
  login_status?: string;
  account_status?: string;
  group_col?: string;
  tags_col?: string;
  created_at?: string;
  updated_at?: string;
  /** JOIN 字段 */
  owner_email?: string;
  owner_name?: string;
  /** 动态统计字段 */
  db_pages_count?: number;
  db_bm_count?: number;
  db_pixels_count?: number;
  ad_accounts_count?: number;
  assetSeq?: number;
}

// ==================== 广告账户 (Ad Accounts) ====================

/** ad_accounts 表行 */
export interface AdAccountRow {
  id: number;
  user_id?: number;
  profile_id?: string;
  profile_name?: string;
  account_id?: string;
  account_name?: string;
  account_status?: string;
  currency?: string;
  timezone_id?: string;
  country?: string;
  balance?: string;
  balance_updated_at?: string;
  spend_cap?: string;
  credit_limit?: string;
  threshold?: string;
  funding_source?: string;
  business_id?: string;
  business_name?: string;
  pixels_count?: number;
  notes?: string;
  group_col?: string;
  tags_col?: string;
  assetSeq?: number;
  created_at?: string;
  updated_at?: string;
  /** JOIN 字段 */
  owner_email?: string;
  /** 动态统计字段 */
  ads_count?: number;
  payment_count?: number;
  seq?: number;
  /** 前端映射字段 */
  adAccountId?: string;
  adAccountName?: string;
  adAccountStatus?: FbAdAccountStatus;
  bmCount?: number;
  pagesCount?: number;
  paymentCount?: number;
  spendCap?: string;
  creditLimit?: string;
}

// ==================== BM (Businesses) ====================

/** businesses 表行 */
export interface BusinessRow {
  id: number;
  user_id?: number;
  profile_id?: string;
  profile_name?: string;
  business_id?: string;
  business_name?: string;
  business_email?: string;
  bm_id?: string;
  bm_name?: string;
  bmId?: string;
  status?: string;
  name?: string;
  email?: string;
  page_count?: number;
  adaccount_count?: number;
  currency?: string;
  timezone_id?: string;
  country?: string;
  payment_method?: string;
  verification_status?: string;
  assetSeq?: number;
  notes?: string;
  created_at?: string;
  updated_at?: string;
  /** JOIN 字段 */
  owner_email?: string;
}

// ==================== 主页 (Pages) ====================

/** pages 表行 */
export interface PageRow {
  id: number;
  user_id?: number;
  profile_id?: string;
  profile_name?: string;
  page_id?: string;
  page_name?: string;
  page_url?: string;
  category?: string;
  followers_count?: number;
  likes_count?: number;
  access_token?: string;
  pageAccessToken?: string;
  page_access_token?: string;
  instagram_id?: string;
  instagram_name?: string;
  instagram_username?: string;
  website?: string;
  bio?: string;
  phone?: string;
  email?: string;
  assetSeq?: number;
  notes?: string;
  created_at?: string;
  updated_at?: string;
  /** JOIN 字段 */
  owner_email?: string;
}

// ==================== 广告 (Ads) ====================

/** ads 表行 */
export interface AdRow {
  id: number;
  user_id?: number;
  profile_id?: string;
  account_id?: string;
  ad_id?: string;
  ad_name?: string;
  ad_status?: string;
  ad_set_id?: string;
  campaign_id?: string;
  creative_id?: string;
  impressions?: number;
  clicks?: number;
  spend?: string;
  reach?: number;
  ctr?: string;
  cpm?: string;
  cpc?: string;
  frequency?: string;
  start_time?: string;
  end_time?: string;
  created_at?: string;
  updated_at?: string;
  /** JOIN 字段 */
  owner_email?: string;
}

// ==================== 交易 (Transactions) ====================

export interface TransactionRow {
  id: number;
  user_id?: number;
  transaction_id: string;
  type: string;
  amount: string;
  currency: string;
  status: string;
  description?: string;
  created_at?: string;
}

// ==================== 商品 (Cards) ====================

export interface CardRow {
  id: number;
  user_id?: number;
  card_id: string;
  card_type: string;
  last4: string;
  expiry_month?: string;
  expiry_year?: string;
  status: string;
  created_at?: string;
}

// ==================== 代理 (Proxy) ====================

export interface ProxyRow {
  id: number;
  user_id?: number;
  name?: string;
  host: string;
  port: string;
  username?: string;
  password?: string;
  type: string;
  location?: string;
  provider?: string;
  status?: string;
  speed?: string;
  notes?: string;
  created_at?: string;
}

// ==================== 域 (Domains) ====================

export interface DomainRow {
  id: number;
  user_id?: number;
  domain: string;
  provider?: string;
  status?: string;
  dns_status?: string;
  ssl_status?: string;
  expires_at?: string;
  notes?: string;
  created_at?: string;
}

// ==================== 计费方式 (Billing Methods) ====================

export interface BillingMethodRow {
  id: string;
  owner_email?: string;
  profile_id: string;
  account_id: string;
  type: string;
  last4: string;
  expiry_date?: string;
  card_holder?: string;
  billing_address?: string;
  is_default?: number;
  created_at?: string;
  /** JOIN 字段 */
  profileName?: string;
}

// ==================== 前端组件专用类型 ====================

/** AssetViewer 的资产标签类型 */
export type AssetTabType = 'adAccounts' | 'bm' | 'pages' | 'ads';

/** AssetViewer 的通用数据行（联合类型） */
export type AssetDataRow = AdAccountRow | BusinessRow | PageRow | AdRow;

/** 前端 FingerprintProfile（与 ProfileRow 对应但字段名不同） */
export interface FingerprintProfile {
  id: string;
  extId?: string;
  seq?: number;
  name: string;
  platform: Platform;
  status: BrowserStatus;
  accountStatus?: AccountStatus;
  assets?: AccountAssets;
  userAgent: string;
  ipAddress: string;
  cookiesCount: number;
  lastActive: string;
  group: string;
  tags?: string[];
  owner?: string;
  ownerName?: string;
  ownerEmail?: string;
  os?: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'random';
  resolution?: string;
  timezone?: string;
  language?: string;
  fbLanguage?: 'en_US' | 'zh_CN';
  fingerprintProtection?: {
    canvas: 'random' | 'off';
    webgl: 'random' | 'off';
    audio: 'random' | 'off';
  };
  proxyEnabled?: boolean;
  proxy?: ProxyConfig;
  startupUrls?: string[];
  account?: {
    name?: string;
    email?: string;
    password?: string;
    twoFactorSecret?: string;
    cookies?: string;
  };
  token?: string;
  tokens?: string;
  customer_id?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 动态统计字段（从 API JOIN 获取） */
  ad_accounts_count?: number;
  db_pages_count?: number;
  db_bm_count?: number;
  db_pixels_count?: number;
  assetSeq?: number;
  /** 🔐 登录状态（落库）：ok 已登录 / relogged 已自动重登 / checkpoint 撞人机验证需人工过 / invalid Cookie失效需人工登录 / 空 未检测 */
  loginStatus?: string;
}

export interface AccountAssets {
  bmId?: string;
  bmIds?: string[];
  bmCount?: number;
  pagesCount?: number;
  pixelsCount?: number;
  adAccountsCount?: number;
  paymentStatus?: 'Active' | 'Failed' | 'None';
  paymentInfo?: string;
  timezone?: string;
  currency?: string;
  country?: string;
}

export interface ProxyConfig {
  host: string;
  port: string;
  username?: string;
  password?: string;
  type: 'http' | 'https' | 'socks5' | 'residential';
  provider?: string;
  residentialOptions?: {
    zone?: string;
    country?: string;
    city?: string;
    session?: string;
    rotation?: 'auto' | 'sticky';
  };
}

export interface AdCampaign {
  id: string;
  name: string;
  profileId: string;
  targetPlatform: Platform;
  productName: string;
  budget: number;
  generatedCopy?: string;
  status: 'Draft' | 'Scheduled' | 'Published' | 'Failed';
}

export interface DashboardStats {
  totalProfiles: number;
  activeCampaigns: number;
  totalSpend: number;
  successRate: number;
}

export interface AdAccountAsset {
  profileId: string;
  profileName: string;
  adAccountId: string;
  adAccountStatus: 'Active' | 'In Review' | 'Disabled' | 'Unknown';
  spend: number;
  spendCap?: number;
  adAccountName?: string;
  currency?: string;
  timezone_id?: string;
  paymentCount?: number;
  pagesCount?: number;
  bmCount?: number;
  account?: string;
  country?: string;
  pixelsCount?: number;
  threshold?: number;
  creditLimit?: number;
  balance?: number;
  fundingSource?: string;
  notes?: string;
  group?: string;
  tags?: string[];
}

// ==================== 通用工具类型 ====================

/** 将数据库行的数字 id 转为 string 的工具映射类型 */
export type WithStringId<T> = Omit<T, 'id'> & { id: string };

/** 可选字段全部变为必填 */
export type Required<T> = {
  [P in keyof T]-?: T[P];
};

/** 从一个联合类型中提取包含特定 key 的子类型 */
export type ExtractByKey<T, K extends string> = T extends Record<K, unknown> ? T : never;
