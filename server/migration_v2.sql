-- Migration to add user_id to data tables for isolation

-- 1. Add user_id to data tables
-- Using separate statements to handle potential errors if some columns exist
ALTER TABLE profiles ADD COLUMN user_id INTEGER;
ALTER TABLE ad_accounts ADD COLUMN user_id INTEGER;
ALTER TABLE ad_insights ADD COLUMN user_id INTEGER;
ALTER TABLE pages ADD COLUMN user_id INTEGER;
ALTER TABLE adpos_transactions ADD COLUMN user_id INTEGER;
ALTER TABLE adpos_prefs ADD COLUMN user_id INTEGER;
ALTER TABLE verification_codes ADD COLUMN user_id INTEGER;
ALTER TABLE businesses ADD COLUMN user_id INTEGER;
ALTER TABLE ad_account_settings ADD COLUMN user_id INTEGER;
ALTER TABLE billing_methods ADD COLUMN user_id INTEGER;
ALTER TABLE proxies ADD COLUMN user_id INTEGER;
ALTER TABLE events ADD COLUMN user_id INTEGER;

-- 2. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_ad_accounts_user_id ON ad_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_ad_insights_user_id ON ad_insights(user_id);
CREATE INDEX IF NOT EXISTS idx_pages_user_id ON pages(user_id);
CREATE INDEX IF NOT EXISTS idx_adpos_tx_user_id ON adpos_transactions(user_id);

-- 3. Initialize initial roles
-- Set the first admin as superadmin
UPDATE users SET role = 'superadmin' WHERE id = 1 OR username = 'admin';

-- Associate existing data with the first admin
UPDATE profiles SET user_id = 1 WHERE user_id IS NULL;
UPDATE ad_accounts SET user_id = 1 WHERE user_id IS NULL;
UPDATE pages SET user_id = 1 WHERE user_id IS NULL;
