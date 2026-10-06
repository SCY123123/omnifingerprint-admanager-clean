-- =====================================================================
-- OmniFingerprint 宝塔版 MySQL schema（sql/schema-mysql.sql）
-- 目标：MariaDB 10.11（utf8mb4_unicode_ci）
-- 依据：D1 建表 DDL + 全路由代码 INSERT/UPDATE/SELECT 引用列（超集）
-- 说明：
--   1) 时间列统一 VARCHAR(32)：业务代码写 new Date().toISOString()（带 Z），
--      也写 CURRENT_TIMESTAMP；DATETIME 会触发 strict 1292，VARCHAR 保真。
--   2) 复合主键表一律 PK(id VARCHAR(191), profile_id VARCHAR(191))。
--   3) 需 DB 默认值的列用 VARCHAR（MySQL TEXT/BLOB 不允许 DEFAULT）。
--   4) 不建外键（级联删除由代码逐表执行）。
-- 幂等：全部 CREATE TABLE IF NOT EXISTS，可重复执行。
-- =====================================================================

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  username               VARCHAR(191) NULL,
  password_hash          VARCHAR(191) NULL,
  email                  VARCHAR(191) NULL,
  role                   VARCHAR(32)  NOT NULL DEFAULT 'user',
  status                 VARCHAR(32)  NOT NULL DEFAULT 'active',
  parent_id              BIGINT NULL,
  permission_level       VARCHAR(32)  NOT NULL DEFAULT 'full',
  subscription_expires_at VARCHAR(32) NULL,
  last_login             VARCHAR(32) NULL,   -- 懒加列：仅列表 SELECT 引用
  last_active_at         VARCHAR(32) NULL,   -- 最后活跃时间（登录/带 token 请求埋点，团队管理展示）
  created_at             VARCHAR(32) NULL,
  updated_at             VARCHAR(32) NULL,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 环境配置 / 资料 ----------
CREATE TABLE IF NOT EXISTS profiles (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id                BIGINT NULL DEFAULT 1,
  ext_id                 VARCHAR(191) NULL,
  name                   VARCHAR(255) NULL,
  platform               VARCHAR(32)  NULL,
  status                 VARCHAR(32)  NULL,
  user_agent             TEXT NULL,
  start_url              VARCHAR(1024) NULL,
  account_name           VARCHAR(255) NULL,
  account_email          VARCHAR(255) NULL,
  account_password       VARCHAR(255) NULL,
  account_cookies        LONGTEXT NULL,
  account_tokens         LONGTEXT NULL,
  account_notes          TEXT NULL,
  account_twofactor_secret VARCHAR(191) NULL DEFAULT '',  -- 2FA 密钥（懒加列）
  account                LONGTEXT NULL,     -- 懒加列：兼容旧 JSON 账号名
  proxy_enabled          INT NOT NULL DEFAULT 0,
  proxy_type             VARCHAR(32)  NULL,
  proxy_host             VARCHAR(255) NULL,
  proxy_port             VARCHAR(32)  NULL,
  proxy_username         VARCHAR(191) NULL,
  proxy_password         VARCHAR(191) NULL,
  proxy                  TEXT NULL,         -- 存 JSON
  pages_count            INT NOT NULL DEFAULT 0,
  bm_count               INT NOT NULL DEFAULT 0,
  pixels_count           INT NOT NULL DEFAULT 0,
  os                     VARCHAR(64)  NULL,
  resolution             VARCHAR(64)  NULL,
  timezone               VARCHAR(64)  NULL,
  language               VARCHAR(64)  NULL,
  fb_language            VARCHAR(64)  NULL,
  fingerprint_protection LONGTEXT NULL,     -- 存 JSON
  seq                    INT NULL,
  login_status           VARCHAR(32)  NULL,  -- 登录状态：ok / relogged / invalid（懒加列）
  account_status         VARCHAR(32)  NULL,
  group_col              VARCHAR(64)  NOT NULL DEFAULT '',
  tags_col               VARCHAR(64)  NOT NULL DEFAULT '',
  created_at             VARCHAR(32) NULL,
  updated_at             VARCHAR(32) NULL,
  KEY idx_profiles_user (user_id),
  KEY idx_profiles_ext_id (ext_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 广告账户（复合主键 id, profile_id）----------
CREATE TABLE IF NOT EXISTS ad_accounts (
  id                   VARCHAR(191) NOT NULL,
  profile_id           VARCHAR(191) NOT NULL,
  user_id              BIGINT NULL,
  platform             VARCHAR(32)  NOT NULL DEFAULT 'facebook',
  account_id           VARCHAR(191) NULL,
  name                 VARCHAR(255) NULL,
  status               VARCHAR(32)  NULL,
  currency             VARCHAR(32)  NULL,
  timezone_id          VARCHAR(64)  NULL,
  spend                DOUBLE NULL DEFAULT 0,
  country              VARCHAR(64)  NULL,
  threshold_amount     DOUBLE NULL DEFAULT 0,
  credit_limit         DOUBLE NULL DEFAULT 0,
  balance              DOUBLE NULL DEFAULT 0,
  funding_source       VARCHAR(191) NOT NULL DEFAULT '',
  pages_count          INT NOT NULL DEFAULT 0,
  bm_count             INT NOT NULL DEFAULT 0,
  pixels_count         INT NOT NULL DEFAULT 0,
  account              VARCHAR(255) NULL,
  profile_name         VARCHAR(255) NULL,
  notes                VARCHAR(191) NOT NULL DEFAULT '',
  group_col            VARCHAR(64)  NOT NULL DEFAULT '',
  tags_col             VARCHAR(64)  NOT NULL DEFAULT '',
  updated_at           VARCHAR(32) NULL,
  seq                  INT NULL,
  PRIMARY KEY (id, profile_id),
  KEY idx_ad_accounts_profile (profile_id),
  KEY idx_ad_accounts_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 主页 / 专页 ----------
CREATE TABLE IF NOT EXISTS pages (
  id          VARCHAR(191) NOT NULL,
  profile_id  VARCHAR(191) NOT NULL,
  user_id     BIGINT NULL,
  page_id     VARCHAR(191) NULL,
  name        VARCHAR(255) NULL,
  fan_count   INT NOT NULL DEFAULT 0,
  link        VARCHAR(1024) NULL,
  category    VARCHAR(255) NULL,
  updated_at  VARCHAR(32) NULL,
  PRIMARY KEY (id, profile_id),
  KEY idx_pages_profile (profile_id),
  KEY idx_pages_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 像素 ----------
CREATE TABLE IF NOT EXISTS pixels (
  id          VARCHAR(191) NOT NULL,
  profile_id  VARCHAR(191) NOT NULL,
  user_id     BIGINT NULL,
  pixel_id    VARCHAR(191) NULL,
  name        VARCHAR(255) NULL,
  status      VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
  account_id  VARCHAR(191) NULL,
  updated_at  VARCHAR(32) NULL,
  PRIMARY KEY (id, profile_id),
  KEY idx_pixels_profile (profile_id),
  KEY idx_pixels_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 商务管理平台（BM）----------
CREATE TABLE IF NOT EXISTS businesses (
  id                  VARCHAR(191) NOT NULL,
  profile_id          VARCHAR(191) NOT NULL,
  business_id         VARCHAR(191) NULL,   -- 懒加列：BM 计数/读取用
  user_id             BIGINT NULL,
  name                VARCHAR(255) NULL,
  verification_status VARCHAR(64)  NULL,
  updated_at          VARCHAR(32) NULL,
  PRIMARY KEY (id, profile_id),
  KEY idx_businesses_profile (profile_id),
  KEY idx_businesses_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 广告 ----------
CREATE TABLE IF NOT EXISTS ads (
  id            VARCHAR(191) NOT NULL,
  profile_id    VARCHAR(191) NOT NULL,
  user_id       BIGINT NULL,
  account_id    VARCHAR(191) NULL,
  ad_id         VARCHAR(191) NULL,
  name          VARCHAR(255) NULL,
  status        VARCHAR(32)  NULL,
  campaign_id   VARCHAR(191) NULL,
  campaign_name VARCHAR(255) NULL,
  adset_id      VARCHAR(191) NULL,
  adset_name    VARCHAR(255) NULL,
  creative_id   VARCHAR(191) NULL,
  preview_url   TEXT NULL,
  targeting     LONGTEXT NULL,
  creative_json LONGTEXT NULL,
  created_at    VARCHAR(32) NULL,
  updated_at    VARCHAR(32) NULL,
  PRIMARY KEY (id, profile_id),
  KEY idx_ads_profile (profile_id),
  KEY idx_ads_account (account_id),
  KEY idx_ads_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 支付方式 ----------
CREATE TABLE IF NOT EXISTS billing_methods (
  id              VARCHAR(191) NOT NULL PRIMARY KEY,
  user_id         BIGINT NOT NULL DEFAULT 1,
  profile_id      VARCHAR(191) NULL,
  account_id      VARCHAR(191) NULL,
  type            VARCHAR(32)  NULL,
  last4           VARCHAR(32)  NULL,
  brand           VARCHAR(64)  NULL,
  exp_month       VARCHAR(16)  NULL,
  exp_year        VARCHAR(16)  NULL,
  billing_address TEXT NULL,
  created_at      VARCHAR(32) NULL,
  updated_at      VARCHAR(32) NULL,
  KEY idx_billing_methods_profile (profile_id),
  KEY idx_billing_methods_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 支付流水 ----------
CREATE TABLE IF NOT EXISTS billing_transactions (
  id                   VARCHAR(191) NOT NULL PRIMARY KEY,
  user_id              BIGINT NOT NULL DEFAULT 1,
  profile_id           VARCHAR(191) NULL,
  account_id           VARCHAR(191) NULL,
  transaction_id       VARCHAR(191) NULL,
  type                 VARCHAR(32)  NULL,
  amount               DOUBLE NULL,
  status               VARCHAR(32)  NULL,
  start_time           VARCHAR(32) NULL,
  payment_due_date     VARCHAR(32) NULL,
  balance              DOUBLE NULL,
  billing_address      TEXT NULL,
  account_billing_info TEXT NULL,
  updated_at           VARCHAR(32) NULL,
  KEY idx_billing_tx_profile (profile_id),
  KEY idx_billing_tx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 代理池 ----------
CREATE TABLE IF NOT EXISTS proxies (
  id           VARCHAR(191) NOT NULL PRIMARY KEY,
  user_id      BIGINT NULL DEFAULT 1,
  type         VARCHAR(32)  NULL,
  host         VARCHAR(255) NULL,
  port         VARCHAR(32)  NULL,
  username     VARCHAR(191) NULL,
  password     VARCHAR(191) NULL,
  provider     VARCHAR(64)  NULL,
  zone         VARCHAR(64)  NULL,
  country      VARCHAR(64)  NULL,
  city         VARCHAR(64)  NULL,
  session      VARCHAR(191) NULL,
  rotation     VARCHAR(64)  NULL,
  label        VARCHAR(64)  NOT NULL DEFAULT '',
  channel      VARCHAR(64)  NOT NULL DEFAULT '',
  category     VARCHAR(64)  NOT NULL DEFAULT '',
  failed_count INT NOT NULL DEFAULT 0,
  created_at   VARCHAR(32) NULL,
  updated_at   VARCHAR(32) NULL,
  KEY idx_proxies_user (user_id),
  KEY idx_proxies_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 素材库 ----------
CREATE TABLE IF NOT EXISTS media_files (
  id         VARCHAR(191) NOT NULL PRIMARY KEY,
  user_id    BIGINT NOT NULL DEFAULT 1,
  profile_id VARCHAR(191) NULL,
  name       VARCHAR(255) NULL,
  file_name  VARCHAR(255) NULL,
  mime_type  VARCHAR(64)  NULL,
  data_url   LONGTEXT NULL,                 -- base64，必须 LONGTEXT
  width      INT NULL,
  height     INT NULL,
  file_size  BIGINT NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,              -- 懒加列：upsert 冲突时更新
  KEY idx_media_profile (profile_id),
  KEY idx_media_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 广告模板 ----------
CREATE TABLE IF NOT EXISTS ad_templates (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT NULL,
  name       VARCHAR(255) NULL,
  is_default INT NOT NULL DEFAULT 0,
  config     LONGTEXT NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  KEY idx_ad_templates_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 主页广告贴文（主页 Timeline Posts）----------
CREATE TABLE IF NOT EXISTS page_posts (
  id            VARCHAR(191) NOT NULL,
  profile_id    VARCHAR(191) NOT NULL,
  user_id       BIGINT NULL,
  page_id       VARCHAR(191) NULL,
  page_name     VARCHAR(255) NULL,
  fb_post_id    VARCHAR(191) NULL,
  message       LONGTEXT NULL,
  story         VARCHAR(1024) NULL,
  permalink_url VARCHAR(1024) NULL,
  full_picture  TEXT NULL,
  created_time  VARCHAR(32) NULL,
  source        VARCHAR(32) DEFAULT 'page', -- page=主页 Timeline / ad=广告创意引用 / page,ad=两者都有
  likes_count   INT DEFAULT 0,             -- 点赞数（reactions.summary.total_count）
  comments_count INT DEFAULT 0,            -- 评论数（comments.summary.total_count）
  shares_count  INT DEFAULT 0,             -- 分享数（shares.count）
  updated_at    VARCHAR(32) NULL,
  PRIMARY KEY (id, profile_id),
  KEY idx_page_posts_profile (profile_id),
  KEY idx_page_posts_page (page_id),
  KEY idx_page_posts_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 主页收件箱对话（Page Inbox Conversations）----------
CREATE TABLE IF NOT EXISTS page_conversations (
  id                VARCHAR(191) NOT NULL,
  profile_id        VARCHAR(191) NOT NULL,
  user_id           BIGINT NULL,
  page_id           VARCHAR(191) NULL,
  page_name         VARCHAR(255) NULL,
  conversation_id   VARCHAR(191) NULL,
  updated_time      VARCHAR(32) NULL,
  message_count     INT NULL,
  unread_count      INT NULL,
  participants_json LONGTEXT NULL,
  messages_json     LONGTEXT NULL,
  snippet           VARCHAR(2048) NULL,
  updated_at        VARCHAR(32) NULL,
  PRIMARY KEY (id, profile_id),
  KEY idx_page_convs_profile (profile_id),
  KEY idx_page_convs_page (page_id),
  KEY idx_page_convs_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 贴文点赞用户（Post Reactions，仅 LIKE）----------
CREATE TABLE IF NOT EXISTS post_reactions (
  id            VARCHAR(191) NOT NULL,
  profile_id    VARCHAR(191) NOT NULL,
  user_id       BIGINT NULL,
  page_id       VARCHAR(191) NULL,
  fb_post_id    VARCHAR(191) NULL,
  from_id       VARCHAR(191) NULL,   -- 点赞者的 PSID（主页维度）
  from_name     VARCHAR(255) NULL,
  from_pic      VARCHAR(1024) NULL,  -- 头像 URL
  reaction_type VARCHAR(32) NULL,
  created_at    VARCHAR(32) NULL,
  PRIMARY KEY (id),
  KEY idx_post_reactions_post (profile_id, fb_post_id),
  KEY idx_post_reactions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 贴文评论（Post Comments）----------
CREATE TABLE IF NOT EXISTS post_comments (
  id                  VARCHAR(191) NOT NULL,
  profile_id          VARCHAR(191) NOT NULL,
  user_id             BIGINT NULL,
  page_id             VARCHAR(191) NULL,
  fb_post_id          VARCHAR(191) NULL,
  comment_id          VARCHAR(191) NULL,
  parent_id           VARCHAR(191) NULL,
  from_id             VARCHAR(191) NULL,   -- 评论者的 PSID
  from_name           VARCHAR(255) NULL,
  from_pic            VARCHAR(1024) NULL,  -- 头像 URL
  message             LONGTEXT NULL,
  created_time        VARCHAR(32) NULL,
  like_count          INT DEFAULT 0,
  reply_count         INT DEFAULT 0,
  is_hidden           TINYINT DEFAULT 0,
  can_hide            TINYINT DEFAULT 0,   -- 主页管理员可隐藏
  can_remove          TINYINT DEFAULT 0,   -- 主页管理员可删除
  can_reply_privately TINYINT DEFAULT 0,   -- 可私密回复（私聊）
  updated_at          VARCHAR(32) NULL,
  PRIMARY KEY (id),
  KEY idx_post_comments_post (profile_id, fb_post_id),
  KEY idx_post_comments_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 贴文分享者（Post Shares）----------
CREATE TABLE IF NOT EXISTS post_shares (
  id            VARCHAR(191) NOT NULL,
  profile_id    VARCHAR(191) NOT NULL,
  user_id       BIGINT NULL,
  fb_post_id    VARCHAR(191) NULL,
  share_post_id VARCHAR(191) NULL,   -- 分享产生的贴文 ID
  from_id       VARCHAR(191) NULL,
  from_name     VARCHAR(255) NULL,
  from_pic      VARCHAR(1024) NULL,
  message       TEXT NULL,
  created_time  VARCHAR(32) NULL,
  updated_at    VARCHAR(32) NULL,
  PRIMARY KEY (id),
  KEY idx_post_shares_post (profile_id, fb_post_id),
  KEY idx_post_shares_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 用户级键值设置（AI 提示词 / 已发送缓存等，按 user_id 天然隔离）----------
CREATE TABLE IF NOT EXISTS user_settings (
  user_id       BIGINT NOT NULL,
  setting_key   VARCHAR(191) NOT NULL,
  setting_value LONGTEXT NULL,
  updated_at    VARCHAR(32) NULL,
  PRIMARY KEY (user_id, setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- AI 自动回复素材库（图片/视频 + 用途描述，按 user_id 隔离）----------
CREATE TABLE IF NOT EXISTS ai_assets (
  id         VARCHAR(191) NOT NULL,
  user_id    BIGINT NOT NULL DEFAULT 1,
  name       VARCHAR(255) NULL,
  kind       VARCHAR(16)  NULL,      -- image | video
  mime_type  VARCHAR(64)  NULL,
  desc_text  VARCHAR(1024) NULL,     -- 「desc」是 MySQL 保留字，故用 desc_text
  data_url   LONGTEXT NULL,          -- base64，必须 LONGTEXT
  file_size  BIGINT NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  PRIMARY KEY (id),
  KEY idx_ai_assets_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 配置键值 ----------
CREATE TABLE IF NOT EXISTS publish_configs (
  config_key   VARCHAR(191) NOT NULL PRIMARY KEY,
  config_value LONGTEXT NULL,
  updated_at   VARCHAR(32) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 操作日志（懒建表也走此结构）----------
CREATE TABLE IF NOT EXISTS logs (
  id         VARCHAR(191) NOT NULL PRIMARY KEY,
  user_id    BIGINT NOT NULL DEFAULT 0,
  profile_id VARCHAR(191) NULL,
  level      VARCHAR(16)  NOT NULL DEFAULT 'INFO',
  message    LONGTEXT NOT NULL,
  created_at VARCHAR(32) NULL,
  KEY idx_logs_profile (profile_id),
  KEY idx_logs_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- U 充值（TRC20-USDT）：随机小数定位订单，金额全局唯一即链上身份 ----------
CREATE TABLE IF NOT EXISTS recharge_orders (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_no       VARCHAR(64) NOT NULL,
  user_id        BIGINT NOT NULL,
  base_amount    DOUBLE NOT NULL DEFAULT 0,   -- 用户输入的金额
  amount         DOUBLE NOT NULL,             -- 应付金额 = base + 4 位随机小数
  network        VARCHAR(32) NOT NULL DEFAULT 'TRC20',
  wallet_address VARCHAR(191) NULL,
  status         VARCHAR(32) NOT NULL DEFAULT 'pending',  -- pending|confirmed|rejected|expired
  tx_hash        VARCHAR(191) NULL,
  from_address   VARCHAR(191) NULL,
  note           VARCHAR(255) NULL,
  confirmed_at   VARCHAR(32) NULL,
  expires_at     VARCHAR(32) NULL,            -- 30 分钟内未到账自动过期
  created_at     VARCHAR(32) NULL,
  updated_at     VARCHAR(32) NULL,
  UNIQUE KEY uq_recharge_order_no (order_no),
  KEY idx_recharge_amount (amount),
  KEY idx_recharge_status (status),
  KEY idx_recharge_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 余额流水（充值入账 / 后续消费扣减都记这里）
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  type          VARCHAR(32) NOT NULL,         -- recharge | consume | adjust
  amount        DOUBLE NOT NULL DEFAULT 0,
  balance_after DOUBLE NULL DEFAULT 0,
  ref_id        VARCHAR(64) NULL,             -- 关联 order_no
  note          VARCHAR(255) NULL,
  created_at    VARCHAR(32) NULL,
  KEY idx_wallet_tx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 系统级配置（收款地址 / TronGrid API Key / 金额上下限；user_settings 是用户级的，别混用）
CREATE TABLE IF NOT EXISTS system_settings (
  setting_key   VARCHAR(191) PRIMARY KEY,
  setting_value LONGTEXT NULL,
  updated_at    VARCHAR(32) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 用户余额（懒加列，与代码内 ALTER 保持一致）
ALTER TABLE users ADD COLUMN balance DOUBLE NULL DEFAULT 0;

-- 广告数据追踪（广告层级 insights；唯一键 = 配置+广告+时间段，重复刷新覆盖更新）
CREATE TABLE IF NOT EXISTS ad_insights (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL DEFAULT 0,
  profile_id VARCHAR(191) NOT NULL,
  account_id VARCHAR(64) NOT NULL,
  ad_id VARCHAR(64) NOT NULL,
  ad_name VARCHAR(255) NULL,
  adset_name VARCHAR(255) NULL,
  campaign_name VARCHAR(255) NULL,
  date_start VARCHAR(32) NULL,
  date_stop VARCHAR(32) NULL,
  date_preset VARCHAR(32) NOT NULL DEFAULT 'last_7d',
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  ctr DOUBLE NOT NULL DEFAULT 0,
  cpc DOUBLE NOT NULL DEFAULT 0,
  cpm DOUBLE NOT NULL DEFAULT 0,
  spend DOUBLE NOT NULL DEFAULT 0,
  results DOUBLE NOT NULL DEFAULT 0,
  actions_json LONGTEXT NULL,
  updated_at VARCHAR(32) NULL,
  UNIQUE KEY uq_insights_row (profile_id, ad_id, date_preset),
  KEY idx_insights_user (user_id),
  KEY idx_insights_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- 临时邮箱（自有域名收信）----------
-- 链路：自有域名 MX → Cloudflare Email Routing(catch-all) → Email Worker
--       → POST /api/private-emails/ingest → 本表 → 前端 tempmail 页面轮询读取。
-- 列名沿用原 D1 版本（d1-dump.sql 的 private_emails），避免历史数据/字段对不上。
-- 说明：原 D1 版 id 是自增整数，这里保持 BIGINT AUTO_INCREMENT（前端只当不透明 id 用）。
CREATE TABLE IF NOT EXISTS private_emails (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  address      VARCHAR(191) NOT NULL,          -- 收件地址，如 tk_xxx@your-domain.example
  sender       VARCHAR(320) NULL,              -- 发件人
  subject      VARCHAR(512) NULL,              -- 主题
  content_text LONGTEXT NULL,                  -- 纯文本正文（当前存原始 MIME 全文）
  content_html LONGTEXT NULL,                  -- HTML 正文（预留）
  raw_json     LONGTEXT NULL,                  -- 原始元信息备份（messageId / size / date）
  is_seen      TINYINT NOT NULL DEFAULT 0,     -- 0 未读 / 1 已读
  created_at   VARCHAR(32) NULL,               -- ISO 字符串（与其余表一致，不用 DATETIME）
  KEY idx_private_emails_addr (address, id),
  KEY idx_private_emails_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
