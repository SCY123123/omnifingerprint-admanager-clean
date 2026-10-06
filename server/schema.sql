-- Cloudflare D1 Schema for OmniFingerprint AdManager

-- Profiles table
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, -- Ownership
    ext_id TEXT UNIQUE,
    name TEXT,
    platform TEXT DEFAULT 'Meta (Facebook/Instagram)',
    account_name TEXT,
    account_email TEXT,
    account_password TEXT,
    account TEXT,
    start_url TEXT,
    user_agent TEXT,
    proxy TEXT,
    proxy_enabled INTEGER DEFAULT 0,
    proxy_type TEXT,
    proxy_host TEXT,
    proxy_port TEXT,
    proxy_username TEXT,
    proxy_password TEXT,
    account_notes TEXT,
    account_tokens TEXT,
    account_cookies TEXT,
    account_status TEXT DEFAULT 'Idle',
    startup_urls TEXT,
    os TEXT,
    resolution TEXT,
    timezone TEXT,
    language TEXT,
    fb_language TEXT DEFAULT 'en_US',
    fingerprint_protection TEXT,
    seq INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_ext_id ON profiles(ext_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_seq ON profiles(seq);

-- Ad Accounts table
CREATE TABLE IF NOT EXISTS ad_accounts (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    platform TEXT,
    account_id TEXT,
    name TEXT,
    status TEXT,
    currency TEXT,
    timezone_id TEXT,
    spend REAL,
    country TEXT,
    threshold_amount REAL,
    credit_limit REAL,
    balance REAL,
    funding_source TEXT,
    account TEXT,
    profile_name TEXT,
    pages_count INTEGER,
    bm_count INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ad_accounts_user_id ON ad_accounts(user_id);

-- Ad Insights table
CREATE TABLE IF NOT EXISTS ad_insights (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    account_id TEXT,
    level TEXT,
    date_preset TEXT,
    metrics TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ad_insights_user_id ON ad_insights(user_id);

-- Pages table
CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    page_id TEXT,
    name TEXT,
    fan_count INTEGER,
    link TEXT,
    category TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pages_user_id ON pages(user_id);

-- Ads table
CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    ad_id TEXT,
    name TEXT,
    status TEXT,
    account_id TEXT,
    campaign_id TEXT,
    campaign_name TEXT,
    adset_id TEXT,
    adset_name TEXT,
    creative_id TEXT,
    preview_url TEXT,
    targeting TEXT,
    creative_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ads_user_id ON ads(user_id);

-- Pixels table
CREATE TABLE IF NOT EXISTS pixels (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    profile_id TEXT,
    pixel_id TEXT,
    name TEXT,
    status TEXT,
    account_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pixels_user_id ON pixels(user_id);
CREATE INDEX IF NOT EXISTS idx_pixels_profile_id ON pixels(profile_id);

-- Adpos Cards table
CREATE TABLE IF NOT EXISTS adpos_cards (
    id TEXT PRIMARY KEY,
    alias TEXT,
    last_four_digits TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Adpos Transactions table
CREATE TABLE IF NOT EXISTS adpos_transactions (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    account_id TEXT,
    transaction_id INTEGER,
    transaction_unix_timestamp INTEGER,
    card_number TEXT,
    alias TEXT,
    username TEXT,
    merchant_name TEXT,
    billing_amount REAL,
    billing_currency TEXT,
    status TEXT,
    transaction_type TEXT,
    billing_status TEXT,
    transaction_amount REAL,
    transaction_currency TEXT,
    transaction_country TEXT,
    last_four_digits TEXT,
    raw_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_adpos_tx_user_id ON adpos_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_adpos_tx_profile ON adpos_transactions(profile_id);

-- Adpos Preferences table
CREATE TABLE IF NOT EXISTS adpos_prefs (
    profile_id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    auto_refresh INTEGER DEFAULT 0,
    auto_save_local INTEGER DEFAULT 0,
    auto_refresh_hours INTEGER DEFAULT 0,
    auto_refresh_minutes INTEGER DEFAULT 0,
    auto_refresh_seconds INTEGER DEFAULT 0,
    auto_save_hours INTEGER DEFAULT 0,
    auto_save_minutes INTEGER DEFAULT 0,
    auto_save_seconds INTEGER DEFAULT 0,
    last_refresh_at DATETIME,
    last_save_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Verification Codes table
CREATE TABLE IF NOT EXISTS verification_codes (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    account_id TEXT,
    card_last4 TEXT,
    code TEXT,
    merchant TEXT,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
);

-- Businesses table
CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    business_id TEXT,
    name TEXT,
    verification_status TEXT,
    admin_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Ad Account Settings table
CREATE TABLE IF NOT EXISTS ad_account_settings (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    account_id TEXT,
    currency TEXT,
    timezone_id TEXT,
    spend_cap REAL,
    amount_spent REAL,
    account_status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Billing Methods table
CREATE TABLE IF NOT EXISTS billing_methods (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    profile_id TEXT,
    account_id TEXT,
    type TEXT,
    brand TEXT,
    last4 TEXT,
    exp_month TEXT,
    exp_year TEXT,
    billing_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Proxies table
CREATE TABLE IF NOT EXISTS proxies (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    type TEXT,
    host TEXT,
    port TEXT,
    username TEXT,
    password TEXT,
    provider TEXT,
    zone TEXT,
    country TEXT,
    city TEXT,
    session TEXT,
    rotation TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    user_id INTEGER, -- Ownership
    event_name TEXT,
    from_tab TEXT,
    to_tab TEXT,
    user_agent TEXT,
    locale TEXT,
    ip TEXT,
    extra TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- IP Blacklist table
CREATE TABLE IF NOT EXISTS ip_blacklist (
    ip TEXT PRIMARY KEY,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Users table for authentication and management
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT DEFAULT 'admin', -- 'superadmin', 'admin', 'user'
    status TEXT DEFAULT 'active', -- 'active', 'disabled'
    parent_id INTEGER, -- The admin who owns this user
    permission_level TEXT DEFAULT 'full', -- 'full', 'read-only', 'limited'
    subscription_expires_at DATETIME, -- For SuperAdmin management
    last_login DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ⚠️ 安全：此处不再内置任何默认账号/密码。
--    历史版本曾写入 superadmin/admin 的明文弱口令，而登录为明文比对（password_hash 实为明文），
--    在公开仓库中等同于公开后门，故移除。
--    首次部署请通过前端「注册」创建账号，再执行迁移提升权限（见 migration_v2.sql）：
--      UPDATE users SET role = 'superadmin' WHERE id = 1;
--    或自行插入使用强密码的账号（切勿使用常见弱口令）。

-- 邮件存储表 (用于私有永久邮箱系统)
CREATE TABLE IF NOT EXISTS private_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,          -- 收件地址 (如 user@your-domain.example)
    sender TEXT,                    -- 发件人
    subject TEXT,                   -- 主题
    content_text TEXT,              -- 纯文本内容
    content_html TEXT,              -- HTML 内容
    raw_json TEXT,                  -- 原始 JSON (保留备份)
    is_seen INTEGER DEFAULT 0,      -- 是否已读
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_address ON private_emails(address);
CREATE INDEX IF NOT EXISTS idx_email_created ON private_emails(created_at);

-- Ad Templates table
CREATE TABLE IF NOT EXISTS ad_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, -- Ownership
    name TEXT, -- Template name
    is_default INTEGER DEFAULT 0,
    config TEXT, -- JSON string of AdPublishData
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ad_templates_user_id ON ad_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_ad_templates_default ON ad_templates(is_default);
