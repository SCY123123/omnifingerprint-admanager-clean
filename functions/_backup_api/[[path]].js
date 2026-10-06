/**
 * OmniFingerprint API Gateway (Cloudflare Pages Functions)
 * This single file handles most API routes for the application.
 * 
 * Route handlers are being progressively extracted to functions/api/routes/
 * for better maintainability.
 */

import { handleLogin, handleRegister, handleMe } from './routes/auth.js';
import { handleProfilesList, handleProfilesStats, handleProfilesBulkSave, handleProfilesShare, handleProfilesBatchUpdateFbLanguage, handleProfilesUpdateAccountStatus, handleProfilesBatchDelete, handleProfilesGetById, handleProfilesUpdateById } from './routes/profiles.js';
import { handleAdAccountsList, handleAdAccountsBulkSave, handleAdAccountsBatchDelete, handleAdAccountsUpdateById, handleAdsList, handleAdsBulkSave } from './routes/adaccounts.js';
import { handlePagesList, handlePagesBulkSave, handlePagesBatchDelete } from './routes/pages.js';
import { handleBusinessesList, handleBusinessesBulkSave } from './routes/businesses.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS Headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Secret',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // --- INIT: 轻量初始化，只创建核心表（避免每次请求跑 DDL） ---
    // 🚀 用 env.DB_INITIALIZED 标记是否已初始化（Cloudflare D1 不支持，改用轻量查询）
    let initialized = false;
    try {
      const check = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='profiles'`).all();
      initialized = check.results && check.results.length > 0;
    } catch { /* 首次失败正常 */ }
    
    if (!initialized) {
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER DEFAULT 1, ext_id TEXT,
        name TEXT, platform TEXT, status TEXT, user_agent TEXT, start_url TEXT,
        account_name TEXT, account_email TEXT, account_password TEXT,
        account_cookies TEXT, account_tokens TEXT, account_notes TEXT,
        proxy_enabled INTEGER DEFAULT 0, proxy_type TEXT, proxy_host TEXT,
        proxy_port TEXT, proxy_username TEXT, proxy_password TEXT, proxy TEXT,
        pages_count INTEGER DEFAULT 0, bm_count INTEGER DEFAULT 0,
        pixels_count INTEGER DEFAULT 0, os TEXT, resolution TEXT,
        timezone TEXT, language TEXT, fb_language TEXT, fingerprint_protection TEXT,
        seq INTEGER, account_status TEXT, account_name TEXT,
        group_col TEXT DEFAULT '', tags_col TEXT DEFAULT '',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, password_hash TEXT,
        email TEXT UNIQUE, role TEXT DEFAULT 'user', status TEXT DEFAULT 'active',
        parent_id INTEGER, permission_level TEXT DEFAULT 'full',
        subscription_expires_at TEXT, created_at TEXT, updated_at TEXT
      )`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS ad_accounts (
        id TEXT NOT NULL, user_id INTEGER, profile_id TEXT, platform TEXT DEFAULT 'facebook',
        account_id TEXT, name TEXT, status TEXT, currency TEXT, timezone_id TEXT,
        spend REAL DEFAULT 0, country TEXT, threshold_amount REAL DEFAULT 0,
        credit_limit REAL DEFAULT 0, balance REAL DEFAULT 0,
        funding_source TEXT DEFAULT '', pages_count INTEGER DEFAULT 0,
        bm_count INTEGER DEFAULT 0, pixels_count INTEGER DEFAULT 0,
        account TEXT, profile_name TEXT, notes TEXT DEFAULT '',
        group_col TEXT DEFAULT '', tags_col TEXT DEFAULT '',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, profile_id)
      )`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, user_id INTEGER, profile_id TEXT, page_id TEXT, name TEXT, fan_count INTEGER DEFAULT 0, link TEXT, category TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS pixels (id TEXT PRIMARY KEY, user_id INTEGER, profile_id TEXT, pixel_id TEXT, name TEXT, status TEXT DEFAULT 'ACTIVE', account_id TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY, user_id INTEGER, profile_id TEXT, name TEXT, verification_status TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS ads (id TEXT PRIMARY KEY, user_id INTEGER, profile_id TEXT, account_id TEXT, ad_id TEXT, name TEXT, status TEXT, campaign_id TEXT, campaign_name TEXT, adset_id TEXT, adset_name TEXT, creative_id TEXT, preview_url TEXT, targeting TEXT, creative_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS billing_methods (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT, account_id TEXT, type TEXT, last4 TEXT, brand TEXT, exp_month TEXT, exp_year TEXT, billing_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS billing_transactions (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT, account_id TEXT, transaction_id TEXT, type TEXT, amount REAL, status TEXT, start_time TEXT, payment_due_date TEXT, balance REAL, billing_address TEXT, account_billing_info TEXT, updated_at TEXT)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS proxies (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, type TEXT, host TEXT, port TEXT, username TEXT, password TEXT, provider TEXT, zone TEXT, country TEXT, city TEXT, session TEXT, rotation TEXT, label TEXT DEFAULT '', channel TEXT DEFAULT '', category TEXT DEFAULT '', failed_count INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS media_files (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT, name TEXT, file_name TEXT, mime_type TEXT, data_url TEXT, width INTEGER, height INTEGER, file_size INTEGER, created_at TEXT)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS ad_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, is_default INTEGER DEFAULT 0, config TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS publish_configs (config_key TEXT PRIMARY KEY, config_value TEXT NOT NULL DEFAULT '{}', updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      // 🚀 新数据库在创建时统一建列，无需 ALTER TABLE
    }
    // 🚀 对已有旧表，用一次 batch 完成所有 ALTER TABLE 迁移（只有 column 不存在时才生效）
    try {
      await env.DB.batch([
        env.DB.prepare(`ALTER TABLE profiles ADD COLUMN group_col TEXT DEFAULT ''`),
        env.DB.prepare(`ALTER TABLE profiles ADD COLUMN tags_col TEXT DEFAULT ''`),
        env.DB.prepare(`ALTER TABLE profiles ADD COLUMN account_name TEXT`),
        env.DB.prepare(`ALTER TABLE profiles ADD COLUMN account_status TEXT`),
        env.DB.prepare(`ALTER TABLE ad_accounts ADD COLUMN notes TEXT DEFAULT ''`),
        env.DB.prepare(`ALTER TABLE ad_accounts ADD COLUMN group_col TEXT DEFAULT ''`),
        env.DB.prepare(`ALTER TABLE ad_accounts ADD COLUMN tags_col TEXT DEFAULT ''`),
        // 🚀 代理中心用户隔离：proxies 表添加 user_id 字段（默认 1 = superadmin/系统所有）
        env.DB.prepare(`ALTER TABLE proxies ADD COLUMN user_id INTEGER DEFAULT 1`),
      ]);
    } catch {}
    // 🚀 2FA 密钥存储（单独 try/catch，防止 batch 中其他 ALTER 失败导致被跳过）
    try {
      await env.DB.prepare(`ALTER TABLE profiles ADD COLUMN account_twofactor_secret TEXT DEFAULT ''`).run();
    } catch (e2) { /* column may already exist */ }
    // 🚀 修复历史代理数据：user_id 为 NULL 的设置为 1（共享代理池）
    try {
      await env.DB.prepare(`UPDATE proxies SET user_id = 1 WHERE user_id IS NULL`).run();
    } catch {}
    // 🚀 迁移 ad_accounts 表到复合主键 (id, profile_id)：每个配置独立一行
    try {
      const flag = await env.DB.prepare(`SELECT config_value FROM publish_configs WHERE config_key = 'ad_accounts_pk_migrated'`).first();
      if (!flag) {
        await env.DB.exec(`CREATE TABLE IF NOT EXISTS ad_accounts_new (
          id TEXT NOT NULL, user_id INTEGER, profile_id TEXT, platform TEXT DEFAULT 'facebook',
          account_id TEXT, name TEXT, status TEXT, currency TEXT, timezone_id TEXT,
          spend REAL DEFAULT 0, country TEXT, threshold_amount REAL DEFAULT 0,
          credit_limit REAL DEFAULT 0, balance REAL DEFAULT 0,
          funding_source TEXT DEFAULT '', pages_count INTEGER DEFAULT 0,
          bm_count INTEGER DEFAULT 0, pixels_count INTEGER DEFAULT 0,
          account TEXT, profile_name TEXT, notes TEXT DEFAULT '',
          group_col TEXT DEFAULT '', tags_col TEXT DEFAULT '',
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id, profile_id)
        )`);
        const oldRows = await env.DB.prepare(`SELECT * FROM ad_accounts`).all();
        if (oldRows.results && oldRows.results.length > 0) {
          const cols = ['id','user_id','profile_id','platform','account_id','name','status','currency','timezone_id','spend','country','threshold_amount','credit_limit','balance','funding_source','pages_count','bm_count','pixels_count','account','profile_name','notes','group_col','tags_col','updated_at'];
          const batch = oldRows.results.map(r => {
            const vals = cols.map(c => r[c] !== undefined ? r[c] : null);
            return env.DB.prepare(`INSERT OR IGNORE INTO ad_accounts_new (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).bind(...vals);
          });
          if (batch.length > 0) await env.DB.batch(batch);
        }
        await env.DB.exec(`DROP TABLE IF EXISTS ad_accounts_old_backup`);
        await env.DB.exec(`ALTER TABLE ad_accounts RENAME TO ad_accounts_old_backup`);
        await env.DB.exec(`ALTER TABLE ad_accounts_new RENAME TO ad_accounts`);
        await env.DB.exec(`DROP TABLE IF EXISTS ad_accounts_old_backup`);
        await env.DB.prepare(`INSERT OR REPLACE INTO publish_configs (config_key, config_value) VALUES ('ad_accounts_pk_migrated', '1')`).run();
      }
    } catch (e) { /* 新库或已迁移，忽略 */ }
    // 🚀 迁移 pages / businesses / pixels / ads 表到复合主键 (id, profile_id)
    async function migrateAssetTable(env, flagKey, tableName, columns, selectCols) {
      try {
        const flag = await env.DB.prepare(`SELECT config_value FROM publish_configs WHERE config_key = ?`).bind(flagKey).first();
        if (flag) return;
        const pkCols = ['id','profile_id'];
        const newName = tableName + '_new';
        await env.DB.exec(`CREATE TABLE IF NOT EXISTS ${newName} (${columns})`);
        // 分批迁移
        let offset = 0;
        const batchSize = 100;
        while (true) {
          const oldRows = await env.DB.prepare(`SELECT * FROM ${tableName} LIMIT ? OFFSET ?`).bind(batchSize, offset).all();
          if (!oldRows.results || oldRows.results.length === 0) break;
          const rows = oldRows.results;
          const batch = rows.map(r => {
            const vals = selectCols.map(c => r[c] !== undefined ? r[c] : null);
            return env.DB.prepare(`INSERT OR IGNORE INTO ${newName} (${selectCols.join(',')}) VALUES (${selectCols.map(()=>'?').join(',')})`).bind(...vals);
          });
          if (batch.length > 0) await env.DB.batch(batch);
          offset += batchSize;
        }
        await env.DB.exec(`DROP TABLE IF EXISTS ${tableName}_old_backup`);
        await env.DB.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_old_backup`);
        await env.DB.exec(`ALTER TABLE ${newName} RENAME TO ${tableName}`);
        await env.DB.exec(`DROP TABLE IF EXISTS ${tableName}_old_backup`);
        await env.DB.prepare(`INSERT OR REPLACE INTO publish_configs (config_key, config_value) VALUES (?, '1')`).bind(flagKey).run();
      } catch (e) { /* 新库或已迁移，忽略 */ }
    }
    const pagesCols = 'id TEXT NOT NULL, user_id INTEGER, profile_id TEXT, page_id TEXT, name TEXT, fan_count INTEGER DEFAULT 0, link TEXT, category TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id, profile_id)';
    await migrateAssetTable(env, 'pages_pk_migrated', 'pages', pagesCols, ['id','user_id','profile_id','page_id','name','fan_count','link','category','updated_at']);
    const businessesCols = 'id TEXT NOT NULL, user_id INTEGER, profile_id TEXT, name TEXT, verification_status TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id, profile_id)';
    await migrateAssetTable(env, 'businesses_pk_migrated', 'businesses', businessesCols, ['id','user_id','profile_id','name','verification_status','updated_at']);
    const pixelsCols = 'id TEXT NOT NULL, user_id INTEGER, profile_id TEXT, pixel_id TEXT, name TEXT, status TEXT DEFAULT \'ACTIVE\', account_id TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id, profile_id)';
    await migrateAssetTable(env, 'pixels_pk_migrated', 'pixels', pixelsCols, ['id','user_id','profile_id','pixel_id','name','status','account_id','updated_at']);
    const adsCols = 'id TEXT NOT NULL, user_id INTEGER, profile_id TEXT, ad_id TEXT, name TEXT, status TEXT, campaign_id TEXT, campaign_name TEXT, adset_id TEXT, adset_name TEXT, creative_id TEXT, preview_url TEXT, targeting TEXT, creative_json TEXT, account_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id, profile_id)';
    await migrateAssetTable(env, 'ads_pk_migrated', 'ads', adsCols, ['id','user_id','profile_id','ad_id','name','status','campaign_id','campaign_name','adset_id','adset_name','creative_id','preview_url','targeting','creative_json','account_id','created_at','updated_at']);
    const parseRawProxy = (str) => {
      const s = String(str||'').trim();
      if (!s) return null;
      let type = 'http', rest = s;
      const m = s.match(/^(https?|socks5|residential):\/\//i);
      if (m) { const sch = m[1].toLowerCase(); type = sch==='socks5'?'socks5':(sch==='residential'?'residential':'http'); rest = s.replace(/^(https?|socks5|residential):\/\//i,''); }
      let username = '', password = '', host = '', port = '';
      if (rest.includes('@')) {
        const [cred, hostpart] = rest.split('@');
        const [u,p] = cred.split(':'); username = u||''; password = p||'';
        const [h,pt] = hostpart.split(':'); host = h||''; port = pt||'';
      } else {
        const parts = rest.split(':');
        if (parts.length===2) { host = parts[0]; port = parts[1]; }
        else if (parts.length===4) { host=parts[0]; port=parts[1]; username=parts[2]; password=parts[3]; }
        else return null;
      }
      if (!host || !port) return null;
      return { type, host, port, username, password, provider: '', zone: '', country: '', city: '', session: '', rotation: '', label: '', channel: '', category: '' };
    };
    const getLegacyAccountName = (raw) => {
      if (!raw || typeof raw !== 'string') return '';
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
          return parsed.name;
        }
      } catch {}
      return '';
    };

    // --- ROUTES ---

    // 1. Auth API — § 路由已提取至 functions/api/routes/auth.js
    if (path === '/api/auth/login' && method === 'POST') {
      return handleLogin(request, env, corsHeaders);
    }

    if (path === '/api/auth/register' && method === 'POST') {
      return handleRegister(request, env, corsHeaders);
    }

    if (path === '/api/auth/me' && method === 'GET') {
      return handleMe(request, env, corsHeaders);
    }

    // 2. Profiles Collection API
    if (path === '/api/profiles' && method === 'GET') {
      return handleProfilesList(request, env, corsHeaders);
    }

    // 2.0 Profiles Stats (轻量统计，供 Dashboard 使用)
    if (path === '/api/profiles/stats' && method === 'GET') {
      return handleProfilesStats(request, env, corsHeaders);
    }

    // 2.1 Profiles Bulk Save (Upsert)
    if (path.includes('/api/profiles/bulk-save') && method === 'POST') {
      return handleProfilesBulkSave(request, env, corsHeaders);
    }

    // 🚀 POST /api/profiles/share — 配置分享/转移
    if (path === '/api/profiles/share' && method === 'POST') {
      return handleProfilesShare(request, env, corsHeaders);
    }

    // 🌐 Profiles Batch Update FB Language
    if (path === '/api/profiles/batch-update-fb-language' && method === 'POST') {
      return handleProfilesBatchUpdateFbLanguage(request, env, corsHeaders);
    }

    // 🌐 Profiles Batch Update Account Status
    if (path === '/api/profiles/update-account-status' && method === 'POST') {
      return handleProfilesUpdateAccountStatus(request, env, corsHeaders);
    }

    // 2.2 Profiles Batch Delete
    if (path.includes('/api/profiles/batch-delete') && method === 'POST') {
      return handleProfilesBatchDelete(request, env, corsHeaders);
    }

    // 2.2.1 AdAccounts Batch Delete
    if (path.includes('/api/adaccounts/batch-delete') && method === 'POST') {
      return handleAdAccountsBatchDelete(request, env, corsHeaders);
    }

    // 2.2.2 Pages Batch Delete
    if (path.includes('/api/pages/batch-delete') && method === 'POST') {
      return handlePagesBatchDelete(request, env, corsHeaders);
    }

    // 2.2.3 Proxies CRUD
    const PROXY_FIELDS = 'id, user_id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, failed_count, created_at, updated_at';
    // GET /api/proxies — 🚀 添加用户数据隔离（参照 profiles 列表 RBAC）
    if (path.includes('/api/proxies') && method === 'GET' && !path.includes('test')) {
      try {
        const apiSecret = request.headers.get('X-Api-Secret');
        let uId, uRole;
        // 支持 PUP 服务器 X-Api-Secret 认证（视为 superadmin）
        if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
          uId = 1; uRole = 'superadmin';
        } else {
          const authHeader = request.headers.get('Authorization');
          if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized', data: [] }), { status: 401, headers: corsHeaders });
          try {
            const parts = atob(authHeader.split(' ')[1]).split(':');
            uId = Number(parts[0]) || 0;
            uRole = parts[2] || '';
          } catch {
            return new Response(JSON.stringify({ success: false, message: 'Invalid Token', data: [] }), { status: 401, headers: corsHeaders });
          }
        }

        // 查询请求者完整信息用于 RBAC
        const { results: reqUserRes } = await env.DB.prepare(`SELECT id, role, parent_id, permission_level FROM users WHERE id = ?`).bind(Number(uId)).all();
        const reqUser = reqUserRes[0];
        // 🐛 容错：找不到用户记录时（如 token 中 uId=0），按最小权限返回空列表，避免泄露数据
        if (!reqUser) {
          return new Response(JSON.stringify({ success: true, data: [] }), { headers: corsHeaders });
        }

        const normalizedRole = (reqUser.role || '').toLowerCase().trim();
        const permLevel = reqUser.permission_level || 'full';
        const teamRootId = reqUser.parent_id || reqUser.id;

        let query = `SELECT ${PROXY_FIELDS} FROM proxies`;
        let params = [];
        if (normalizedRole === 'superadmin') {
          // Superadmin: 看全部
        } else if (permLevel === 'full') {
          // 团队 Full Access: 自己 + 团队成员 + 共享代理池 (user_id=1)
          query += ' WHERE (user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?) OR user_id = 1)';
          params = [Number(teamRootId), Number(teamRootId)];
        } else {
          // 个人: 仅自己 + 共享代理池 (user_id=1)
          query += ' WHERE (user_id = ? OR user_id = 1)';
          params = [Number(uId)];
        }
        query += ' ORDER BY created_at DESC';

        const { results } = await env.DB.prepare(query).bind(...params).all();
        return new Response(JSON.stringify({ success: true, data: results || [] }, (k, v) => typeof v === 'bigint' ? Number(v) : v), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message, data: [] }), { headers: corsHeaders });
      }
    }
    // POST /api/proxies (create)
    if (path.includes('/api/proxies') && method === 'POST' && !path.includes('test') && !path.includes('batch')) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uId;
      try { const td = atob(authHeader.split(' ')[1]); uId = Number(td.split(':')[0]) || 0; } catch { uId = 0; }
      try {
        const body = await request.json();
        const id = body.id || `px_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await env.DB.prepare(`INSERT OR REPLACE INTO proxies (id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(
          id, body.type||'http', body.host||'', body.port||'', body.username||'', body.password||'',
          body.provider||'', body.zone||'', body.country||'', body.city||'', body.session||'', body.rotation||'',
          body.label||'', body.channel||'', body.category||'', uId
        ).run();
        return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers: corsHeaders });
      }
    }
    // POST /api/proxies/batch-import (批量导入)
    if (path.includes('/api/proxies/batch-import') && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uId;
      try { const td = atob(authHeader.split(' ')[1]); uId = Number(td.split(':')[0]) || 0; } catch { uId = 0; }
      const body = await request.json();
      const items = Array.isArray(body) ? body : (body.items || body.proxies || [body]);
      let imported = 0, errors = 0;
      for (const raw of items) {
        try {
          const p = typeof raw === 'string' ? parseRawProxy(raw) : raw;
          if (!p || !p.host) { errors++; continue; }
          const id = p.id || `px_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          await env.DB.prepare(`INSERT OR REPLACE INTO proxies (id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(
            id, p.type||'http', p.host, p.port||'', p.username||'', p.password||'',
            p.provider||'', p.zone||'', p.country||'', p.city||'', p.session||'', p.rotation||'',
            p.label||'', p.channel||'', p.category||'', uId
          ).run();
          imported++;
        } catch (e) { errors++; }
      }
      return new Response(JSON.stringify({ success: true, imported, errors, total: items.length }), { headers: corsHeaders });
    }
    // 提取 uId 和 uRole 的辅助函数
    const parseProxyAuth = (authHeader) => {
      try {
        const parts = atob(authHeader.split(' ')[1]).split(':');
        return { uId: Number(parts[0]) || 0, uRole: parts[2] || '' };
      } catch { return { uId: 0, uRole: '' }; }
    };
    // PUT /api/proxies/:id
    const proxyPutMatch = path.match(/\/api\/proxies\/([^/]+)$/);
    if (proxyPutMatch && method === 'PUT') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const { uId, uRole } = parseProxyAuth(authHeader);
      const pid = proxyPutMatch[1];
      const body = await request.json();
      const userFilter = uRole === 'superadmin' ? '' : ' AND user_id = ?';
      const binds = [body.type||'http', body.host||'', body.port||'', body.username||'', body.password||'',
        body.provider||'', body.zone||'', body.country||'', body.city||'', body.session||'', body.rotation||'',
        body.label||'', body.channel||'', body.category||'', pid];
      if (uRole !== 'superadmin') binds.push(uId);
      await env.DB.prepare(`UPDATE proxies SET type=?,host=?,port=?,username=?,password=?,provider=?,zone=?,country=?,city=?,session=?,rotation=?,label=?,channel=?,category=?,updated_at=CURRENT_TIMESTAMP WHERE id=?${userFilter}`).bind(...binds).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
    // DELETE /api/proxies/:id
    if (proxyPutMatch && method === 'DELETE') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const { uId, uRole } = parseProxyAuth(authHeader);
      const userFilter = uRole === 'superadmin' ? '' : ' AND user_id = ?';
      const binds = [proxyPutMatch[1]];
      if (uRole !== 'superadmin') binds.push(uId);
      await env.DB.prepare(`DELETE FROM proxies WHERE id=?${userFilter}`).bind(...binds).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
    // POST /api/proxies/:id/fail (标记代理失败,递增失败计数)
    const failMatch = path.match(/\/api\/proxies\/([^/]+)\/fail$/);
    if (failMatch && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      await env.DB.prepare('UPDATE proxies SET failed_count = COALESCE(failed_count,0)+1, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(failMatch[1]).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
    // POST /api/proxies/test
    if (path.includes('/api/proxies/test') && method === 'POST') {
      const body = await request.json();
      let ok = true, lat = 0, msg = '';
      const start = Date.now();
      try {
        const r = await fetch(`http://${body.host}:${body.port}`, { signal: AbortSignal.timeout(5000) });
        lat = Date.now() - start;
        ok = r.ok || r.status < 500;
      } catch (e) {
        ok = false; msg = e.message;
      }
      return new Response(JSON.stringify({ success: ok, latency: lat, message: msg }), { headers: corsHeaders });
    }

    // 2.3 Single Profile GET
    if (path.includes('/api/profiles/') && method === 'GET') {
      return handleProfilesGetById(request, env, corsHeaders);
      let __step = 'init';
      try {
        const authHeader = request.headers.get('Authorization');
        const apiSecret = request.headers.get('X-Api-Secret');
        let uId, uRole;

        // 支持 X-Api-Secret 认证（PUP 服务器使用）
        if (apiSecret) {
          if (apiSecret === env.PUPPETEER_API_SECRET) {
            uId = 1; uRole = 'superadmin';
          } else {
            return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
          }
        } else {
          if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
          try {
            const tokenData = atob(authHeader.split(' ')[1]);
            const parts = tokenData.split(':');
            uId = parts[0];
            uRole = parts[2] || '';
          } catch (e) {
            return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
          }
        }

        const id = path.split('/').filter(Boolean).pop();
        if (id === 'profiles') return new Response(JSON.stringify({ success: false, message: 'Invalid ID' }), { status: 400, headers: corsHeaders });

        __step = 'db_query';
        const { results } = uRole === 'superadmin'
          ? await env.DB.prepare(`SELECT * FROM profiles WHERE id = ? OR ext_id = ?`).bind(Number(id) || 0, id).all()
          : await env.DB.prepare(`SELECT * FROM profiles WHERE (id = ? OR ext_id = ?) AND user_id = ?`).bind(Number(id) || 0, id, Number(uId)).all();
        const row = results[0];
        if (!row) return new Response(JSON.stringify({ success: false, message: 'Not Found' }), { status: 404, headers: corsHeaders });

        // 🚀 查询该配置关联的 BM ID
        __step = 'fetch_bms';
        let bmIds = [];
        try {
          const { results: bmResults } = await env.DB.prepare(`SELECT business_id FROM businesses WHERE profile_id = ?`).bind(Number(id) || 0).all();
          bmIds = bmResults.map(b => String(b.business_id || '')).filter(Boolean);
        } catch {}

        __step = 'parse_proxy';
        let proxy = null;
        try { if (row.proxy) proxy = JSON.parse(row.proxy); } catch {}
        if (!proxy && row.proxy_host) {
          proxy = { type: row.proxy_type, host: row.proxy_host, port: Number(row.proxy_port) || 0, username: row.proxy_username, password: row.proxy_password };
        }

        // 🚀 修复：fingerprint_protection 的 JSON.parse 包裹 try/catch，避免畸形数据导致 500
        __step = 'parse_fp';
        let fingerprintProtection = {};
        try { if (row.fingerprint_protection) fingerprintProtection = JSON.parse(row.fingerprint_protection); } catch {}

        __step = 'build_data';
        // 🚀 BigInt 安全处理：D1 可能对 INTEGER 列返回 BigInt，JSON.stringify 无法序列化 BigInt
        const data = {
          id: String(row.id), extId: row.ext_id, name: row.name, platform: row.platform,
          userAgent: row.user_agent, startupUrls: row.start_url ? [row.start_url] : [],
          account: { name: row.account_name, email: row.account_email, password: row.account_password, twoFactorSecret: row.account_twofactor_secret || '', cookies: row.account_cookies },
          proxy, proxyEnabled: !!row.proxy_enabled, token: row.account_tokens, notes: row.account_notes,
          os: row.os, resolution: row.resolution, timezone: row.timezone, language: row.language,
          fingerprintProtection,
          // 🚀 包含 BM ID 信息
          assets: {
            bmIds: bmIds,
            bmId: bmIds.length > 0 ? bmIds[0] : '',
            bmCount: Number(row.bm_count || 0),
            pagesCount: Number(row.pages_count || 0),
            pixelsCount: Number(row.pixels_count || 0),
            adAccountsCount: Number(row._ad_accounts_count || 0)
          }
        };
        __step = 'serialize';
        const body = JSON.stringify(data, (k, v) => typeof v === 'bigint' ? Number(v) : v);
        return new Response(JSON.stringify({ success: true, data: JSON.parse(body) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        // 🚀 顶层 try/catch：捕获任何未处理异常，返回 500 而不是让 Cloudflare 返回不可读的错误
        // 包含 __step 字段帮助定位具体失败步骤
        return new Response(JSON.stringify({ success: false, message: 'Server error: ' + (e?.message || String(e)), step: __step, stack: e?.stack?.split('\n').slice(0, 3).join(' | ') }), { status: 500, headers: corsHeaders });
      }
    }

    // 2.4 Save Tokens API
    if (path === '/api/facebook/save-tokens' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');

      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0];
          uRole = parts[2] || '';
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
        }
      }

      const { profileId, tokens } = await request.json();
      if (!profileId || !tokens) return new Response(JSON.stringify({ success: false, message: 'Missing profileId or tokens' }), { status: 400, headers: corsHeaders });

      const access = Array.isArray(tokens.access_tokens) ? tokens.access_tokens : [];
      const firstToken = (access.find(v => /^EAAG/i.test(String(v))) || access.find(v => /^EAA/i.test(String(v))) || access.find(v => typeof v === 'string' && v.length > 0) || '');

      if (!firstToken) return new Response(JSON.stringify({ success: false, message: 'No valid token found in payload' }), { status: 400, headers: corsHeaders });

      const timestamp = new Date().toISOString();
      const tokenUserId = Number(uId) || 0;
      // 🚀 修复：superadmin 可更新任意 profile 的 token，不受 user_id 限制
      const isSuperAdmin = uRole === 'superadmin';
      const result = isSuperAdmin
        ? await env.DB.prepare(`UPDATE profiles SET account_tokens = ?, updated_at = ? WHERE (id = ? OR ext_id = ?)`).bind(firstToken, timestamp, Number(profileId) || 0, String(profileId)).run()
        : await env.DB.prepare(`UPDATE profiles SET account_tokens = ?, updated_at = ? WHERE (id = ? OR ext_id = ?) AND user_id = ?`).bind(firstToken, timestamp, Number(profileId) || 0, String(profileId), tokenUserId).run();

      return new Response(JSON.stringify({ success: true, changes: result.meta?.changes || 0 }), { headers: corsHeaders });
    }

    // 🚀 修正：PUT /api/profiles/:id — 编辑单个配置
    if (path.startsWith('/api/profiles/') && method === 'PUT') {
      return handleProfilesUpdateById(request, env, corsHeaders);
      const profileId = path.replace('/api/profiles/', '').split('/')[0];
      if (!profileId) return new Response(JSON.stringify({ success: false, message: 'Missing id' }), { status: 400, headers: corsHeaders });

      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0];
          uRole = parts[2] || '';
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
        }
      }

      const p = await request.json();
      
      // 🚀 部分更新：只更新请求体中存在的字段
      const fields = [];
      const binds = [];
      const cols = {
        name: 'name', account_name: 'account_name', account_email: 'account_email',
        account_password: 'account_password', start_url: 'start_url', user_agent: 'user_agent',
        account_notes: 'account_notes', group_col: 'group_col', tags_col: 'tags_col',
        proxy_enabled: 'proxy_enabled', proxy_type: 'proxy_type', proxy_host: 'proxy_host',
        proxy_port: 'proxy_port', proxy_username: 'proxy_username', proxy_password: 'proxy_password',
        proxy: 'proxy', account: 'account'
      };
      for (const [key, col] of Object.entries(cols)) {
        if (p[key] !== undefined) {
          // tags_col 特殊处理
          if (key === 'tags_col') {
            const val = Array.isArray(p[key]) ? p[key].join(',') : String(p[key]);
            fields.push(`${col} = ?`); binds.push(val);
          } else {
            fields.push(`${col} = ?`); binds.push(typeof p[key] === 'object' ? JSON.stringify(p[key]) : String(p[key]));
          }
        }
      }
      // 兼容 p.notes → account_notes
      if (p.notes !== undefined && p.account_notes === undefined) {
        fields.push('account_notes = ?'); binds.push(String(p.notes));
      }
      // 兼容 p.group → group_col
      if (p.group !== undefined && p.group_col === undefined) {
        fields.push('group_col = ?'); binds.push(String(p.group));
      }
      // 兼容 p.tags → tags_col
      if (p.tags !== undefined && p.tags_col === undefined) {
        fields.push('tags_col = ?'); binds.push(Array.isArray(p.tags) ? p.tags.join(',') : String(p.tags));
      }
      // 兼容 proxyEnabled → proxy_enabled
      if (p.proxyEnabled !== undefined && p.proxy_enabled === undefined) {
        fields.push('proxy_enabled = ?'); binds.push(p.proxyEnabled ? '1' : '0');
      }
      // 兼容 p.proxy 为对象 → 存 JSON
      if (p.proxy !== undefined && typeof p.proxy === 'object' && p.proxy !== null && !Array.isArray(p.proxy)) {
        // 如果 proxy 对象没有在 cols 中处理，手动添加
        const alreadyHandled = fields.some(f => f.startsWith('proxy ='));
        if (!alreadyHandled) {
          fields.push('proxy = ?'); binds.push(JSON.stringify(p.proxy));
          // 同时补充 proxy_type/host/port/username/password
          if (p.proxy_type === undefined && p.proxy.type) { fields.push('proxy_type = ?'); binds.push(String(p.proxy.type)); }
          if (p.proxy_host === undefined && p.proxy.host) { fields.push('proxy_host = ?'); binds.push(String(p.proxy.host)); }
          if (p.proxy_port === undefined && p.proxy.port) { fields.push('proxy_port = ?'); binds.push(String(p.proxy.port)); }
          if (p.proxy_username === undefined && p.proxy.username) { fields.push('proxy_username = ?'); binds.push(String(p.proxy.username)); }
          if (p.proxy_password === undefined && p.proxy.password) { fields.push('proxy_password = ?'); binds.push(String(p.proxy.password)); }
        }
      }
      // 兼容 p.account.twoFactorSecret → account_twofactor_secret
      if (p.account && typeof p.account === 'object' && p.account.twoFactorSecret !== undefined) {
        const alreadyHandled = fields.some(f => f.startsWith('account_twofactor_secret'));
        if (!alreadyHandled) {
          fields.push('account_twofactor_secret = ?'); binds.push(String(p.account.twoFactorSecret));
        }
      }
      
      if (fields.length === 0) {
        return new Response(JSON.stringify({ success: false, message: 'No fields to update' }), { status: 400, headers: corsHeaders });
      }
      
      fields.push('updated_at = ?');
      binds.push(new Date().toISOString());

      const isSuperAdmin = uRole === 'superadmin';
      const pidNum = !isNaN(Number(profileId)) ? Number(profileId) : null;
      let stmt;
      const userFilterClause = isSuperAdmin ? '' : ' AND user_id = ?';
      try {
        if (pidNum) {
          binds.push(pidNum);
          if (!isSuperAdmin) binds.push(Number(uId));
          stmt = await env.DB.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE id = ?${userFilterClause}`).bind(...binds).run();
        } else {
          binds.push(String(profileId));
          if (!isSuperAdmin) binds.push(Number(uId));
          stmt = await env.DB.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE ext_id = ?${userFilterClause}`).bind(...binds).run();
        }
      } catch (e) {
        // 🚀 如果 D1 报 unknown column，尝试去掉不适配的列降级重试
        const msg = String(e.message || e);
        const unknownCols = ['group_col', 'tags_col', 'account_twofactor_secret'];
        if (msg.includes('no such column') && unknownCols.some(c => msg.includes(c))) {
          const safeFields = fields.filter(f => !unknownCols.some(c => f.startsWith(c)));
          const safeBinds = [];
          let fi = 0;
          for (const f of fields) {
            if (!unknownCols.some(c => f.startsWith(c))) safeBinds.push(binds[fi]);
            fi++;
          }
          if (safeFields.length <= 1) {
            return new Response(JSON.stringify({ success: false, message: 'Database schema mismatch: ' + msg }), { status: 500, headers: corsHeaders });
          }
          if (pidNum) {
            safeBinds.push(pidNum);
            if (!isSuperAdmin) safeBinds.push(Number(uId));
            stmt = await env.DB.prepare(`UPDATE profiles SET ${safeFields.join(', ')} WHERE id = ?${userFilterClause}`).bind(...safeBinds).run();
          } else {
            safeBinds.push(String(profileId));
            if (!isSuperAdmin) safeBinds.push(Number(uId));
            stmt = await env.DB.prepare(`UPDATE profiles SET ${safeFields.join(', ')} WHERE ext_id = ?${userFilterClause}`).bind(...safeBinds).run();
          }
        } else {
          throw e;
        }
      }

      return new Response(JSON.stringify({ success: true, message: '配置已更新', changes: stmt.meta?.changes || 0 }), { headers: corsHeaders });
    }

    // 🚀 合并刷新：GET /api/assets/batch-refresh — 一次请求返回所有资产类型
    if (path === '/api/assets/batch-refresh' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0]; uRole = parts[2];
        } catch { return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders }); }
      }

      // 🚀 V5.6.9: 支持 profileIds 参数过滤
      const url = new URL(request.url);
      const profileIdsParam = url.searchParams.get('profileIds');
      const profileIds = profileIdsParam ? profileIdsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

      const buildQuery = (table, alias) => {
        let q = `SELECT * FROM ${table} WHERE ${alias}.user_id = ? OR ? = 'superadmin'`;
        const params = [Number(uId), uRole];
        // 🚀 V5.7.0: superadmin 不应用 profileIds 过滤，否则会看不到所有数据
        if (uRole !== 'superadmin' && profileIds.length > 0) {
          q += ` AND ${alias}.profile_id IN (${profileIds.map(() => '?').join(',')})`;
          params.push(...profileIds);
        }
        q += ' ORDER BY updated_at DESC';
        return { query: q, params };
      };

      const adQ = buildQuery('ad_accounts', 'ad_accounts');
      const adsQ = buildQuery('ads', 'ads');
      const pgQ = buildQuery('pages', 'pages');
      const bizQ = buildQuery('businesses', 'businesses');

      const [adAccountsRes, adsRes, pagesRes, businessesRes] = await Promise.all([
        env.DB.prepare(adQ.query).bind(...adQ.params).all(),
        env.DB.prepare(adsQ.query).bind(...adsQ.params).all(),
        env.DB.prepare(pgQ.query).bind(...pgQ.params).all(),
        env.DB.prepare(bizQ.query).bind(...bizQ.params).all()
      ]);

      return new Response(JSON.stringify({
        success: true,
        adAccounts: adAccountsRes.results || [],
        ads: adsRes.results || [],
        pages: pagesRes.results || [],
        businesses: businessesRes.results || []
      }), { headers: corsHeaders });
    }

    // 3. AdAccounts Bulk Save (Remote Sync)
    if (path.includes('/api/adaccounts/bulk-save') && method === 'POST') {
      return handleAdAccountsBulkSave(request, env, corsHeaders);
    }

    // 4. Businesses Bulk Save
    if (path === '/api/businesses/bulk-save' && method === 'POST') {
      return handleBusinessesBulkSave(request, env, corsHeaders);
    }

    // 4.1 Pages Bulk Save
    if (path === '/api/pages/bulk-save' && method === 'POST') {
      return handlePagesBulkSave(request, env, corsHeaders);
    }

    // 4.2 Ads Bulk Save
    if (path === '/api/ads/bulk-save' && method === 'POST') {
      return handleAdsBulkSave(request, env, corsHeaders);
    }

    // 4.3 Pixels Bulk Save
    if (path === '/api/pixels/bulk-save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0]; uRole = parts[2];
      }

      const { items = [] } = await request.json();
      const statements = [];
      const timestamp = new Date().toISOString();

      const pIds = [...new Set(items.map(it => String(it.profile_id || it.profileId)))];
      const pIdMap = new Map();
      if (pIds.length > 0) {
        const placeholders = pIds.map(() => '?').join(',');
        const { results: pOwners } = await env.DB.prepare(`SELECT id, ext_id, user_id FROM profiles WHERE id IN (${placeholders}) OR ext_id IN (${placeholders})`).bind(...pIds, ...pIds).all();
        pOwners.forEach(p => {
          if (p.id) pIdMap.set(String(p.id), p.user_id);
          if (p.ext_id) pIdMap.set(String(p.ext_id), p.user_id);
        });
      }

      for (const item of items) {
        const pId = String(item.profile_id || item.profileId);
        const itemUserId = pIdMap.get(pId) || uId;
        const pixelId = item.pixel_id || item.id;
        const fullId = `pixel_${pixelId}`;

        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO pixels (id, user_id, profile_id, pixel_id, name, status, account_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(fullId, Number(itemUserId), pId, String(pixelId), item.name || '', item.status || 'ACTIVE', item.account_id || '', timestamp));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
    }

    // 🚀 6. Billing Transactions bulk-save
    if (path === '/api/billing/bulk-save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0]; uRole = parts[2];
      }

      const { items = [] } = await request.json();
      const statements = [];
      const timestamp = new Date().toISOString();

      await env.DB.exec(`CREATE TABLE IF NOT EXISTS billing_transactions (
        id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
        account_id TEXT, transaction_id TEXT, type TEXT, amount REAL,
        status TEXT, start_time TEXT, payment_due_date TEXT, balance REAL,
        billing_address TEXT, account_billing_info TEXT, updated_at TEXT
      )`);

      for (const item of items) {
        const fullId = `${item.profile_id}_${item.transaction_id}`;
        statements.push(env.DB.prepare(`
          INSERT INTO billing_transactions (id, user_id, profile_id, account_id, transaction_id, type, amount, status, start_time, payment_due_date, balance, billing_address, account_billing_info, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET 
            type=excluded.type, amount=excluded.amount, status=excluded.status, updated_at=excluded.updated_at
        `).bind(fullId, Number(uId), item.profile_id, item.account_id, item.transaction_id, item.type, item.amount, item.status, item.start_time, item.payment_due_date, item.balance, item.billing_address, item.account_billing_info, timestamp));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
    }

    // 🚀 7. Media Files (素材库) bulk-save & GET
    if (path === '/api/media/bulk-save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      let uId;
      try {
        const tokenData = atob(authHeader?.split(' ')[1] || '');
        uId = tokenData.split(':')[0];
      } catch { uId = 1; }
      const { items = [] } = await request.json();
      const statements = [];
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
        name TEXT, file_name TEXT, mime_type TEXT, data_url TEXT,
        width INTEGER, height INTEGER, file_size INTEGER, created_at TEXT
      )`);
      for (const item of items) {
        const mid = item.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        statements.push(env.DB.prepare(`INSERT INTO media_files (id, user_id, profile_id, name, file_name, mime_type, data_url, width, height, file_size, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, data_url=excluded.data_url, updated_at=excluded.updated_at`
        ).bind(mid, Number(uId), item.profile_id || '', item.name || '', item.file_name || '', item.mime_type || '', item.data_url || '', item.width || 0, item.height || 0, item.file_size || 0, new Date().toISOString()));
      }
      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
    }
    if (path === '/api/media' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      let uId, uRole;
      try {
        const tokenData = atob(authHeader?.split(' ')[1] || '');
        const parts = tokenData.split(':');
        uId = parts[0]; uRole = parts[2];
      } catch { uId = 1; uRole = ''; }
      const { results } = await env.DB.prepare(`SELECT * FROM media_files WHERE (user_id = ? OR ? = 'superadmin') ORDER BY created_at DESC`).bind(Number(uId), uRole).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
    }

    // 5. AdAccounts GET
    if (path === '/api/adaccounts' && method === 'GET') {
      return handleAdAccountsList(request, env, corsHeaders);
    }

    // 🚀 PUT /api/adaccounts/:id — 单条更新（备注快速编辑）
    if (path.startsWith('/api/adaccounts/') && method === 'PUT') {
      return handleAdAccountsUpdateById(request, env, corsHeaders);
    }

    // 5.2 Pages List
    if (path === '/api/pages' && method === 'GET') {
      return handlePagesList(request, env, corsHeaders);
    }

    // 5.3 Ads List
    if (path === '/api/ads' && method === 'GET') {
      return handleAdsList(request, env, corsHeaders);
    }

    // 5.4 Pixels List
    if (path === '/api/pixels' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0]; uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      let query = `SELECT p.*, u.email as owner_email FROM pixels p LEFT JOIN users u ON p.user_id = u.id WHERE (p.user_id = ? OR ? = 'superadmin')`;
      const accountId = url.searchParams.get('accountId');
      const params = [Number(uId), uRole];
      
      if (accountId) {
        query += ` AND p.account_id = ?`;
        params.push(accountId);
      }
      
      query += ` ORDER BY p.updated_at DESC`;
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
    }

    // 5.2 Businesses GET
    if (path === '/api/businesses' && method === 'GET') {
      return handleBusinessesList(request, env, corsHeaders);
    }

    // 🚀 Billing Methods GET (查询已保存的信用卡信息)
    if (path === '/api/billing-methods' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      let uId, uRole;
      if (authHeader) {
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0]; uRole = parts[2];
        } catch {}
      }
      let query = `SELECT m.*, u.email as owner_email FROM billing_methods m LEFT JOIN users u ON m.user_id = u.id`;
      let params = [];
      if (uRole !== 'superadmin' && uId) {
        query += ' WHERE (m.user_id = ? OR m.user_id IN (SELECT id FROM users WHERE parent_id = ?))';
        params = [Number(uId), Number(uId)];
      }
      query += ' ORDER BY m.created_at DESC';
      const { results } = await env.DB.prepare(query).bind(...params).all();
      const data = (results || []).map((r) => ({
        id: String(r.id || ''),
        owner_email: r.owner_email || '',
        profile_id: String(r.profile_id || ''),
        account_id: String(r.account_id || ''),
        type: String(r.type || ''),
        last4: String(r.last4 || ''),
        brand: String(r.brand || ''),
        exp_month: String(r.exp_month || ''),
        exp_year: String(r.exp_year || ''),
        billing_address: String(r.billing_address || ''),
        created_at: String(r.created_at || '')
      }));
      return new Response(JSON.stringify({ success: true, data, total: data.length }), { headers: corsHeaders });
    }

    // 🚀 Billing Methods Save (供 Puppeteer 服务调用，保存绑定的信用卡)
    if (path === '/api/billing-methods/save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      if (!authHeader && apiSecret !== env.PUPPETEER_API_SECRET) {
        return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }
      const item = await request.json().catch(() => ({}));
      if (!item.profile_id || !item.last4) {
        return new Response(JSON.stringify({ success: false, message: '缺少 profile_id 或 last4' }), { status: 400, headers: corsHeaders });
      }
      
      const rec = {
        id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
        profile_id: String(item.profile_id || '').trim(),
        account_id: String(item.account_id || '').trim(),
        type: String(item.type || item.brand || 'Card'),
        last4: String(item.last4 || ''),
        brand: String(item.brand || ''),
        exp_month: String(item.exp_month || ''),
        exp_year: String(item.exp_year || ''),
        billing_address: String(item.billing_address || '')
      };

      await env.DB.prepare(`INSERT OR REPLACE INTO billing_methods (id, profile_id, account_id, type, last4, brand, exp_month, exp_year, billing_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .bind(rec.id, rec.profile_id, rec.account_id, rec.type, rec.last4, rec.brand, rec.exp_month, rec.exp_year, rec.billing_address)
        .run();
      
      return new Response(JSON.stringify({ success: true, id: rec.id }), { headers: corsHeaders });
    }

    // 🚀 Billing Methods Bulk Save (前端批量保存到 D1)
    if (path === '/api/billing-methods/bulk-save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const body = await request.json().catch(() => ({}));
      const items = body.items || body.item ? [body] : [];
      if (!Array.isArray(items) || items.length === 0) {
        return new Response(JSON.stringify({ success: false, message: '缺少 items' }), { status: 400, headers: corsHeaders });
      }
      
      const statements = [];
      for (const item of items) {
        if (!item.profile_id || !item.last4) continue;
        const rec = {
          id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`),
          profile_id: String(item.profile_id || '').trim(),
          account_id: String(item.account_id || '').trim(),
          type: String(item.type || item.brand || 'Card'),
          last4: String(item.last4 || ''),
          brand: String(item.brand || ''),
          exp_month: String(item.exp_month || ''),
          exp_year: String(item.exp_year || ''),
          billing_address: String(item.billing_address || '')
        };
        statements.push(env.DB.prepare(`INSERT OR REPLACE INTO billing_methods (id, profile_id, account_id, type, last4, brand, exp_month, exp_year, billing_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
          .bind(rec.id, rec.profile_id, rec.account_id, rec.type, rec.last4, rec.brand, rec.exp_month, rec.exp_year, rec.billing_address));
      }
      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: statements.length }), { headers: corsHeaders });
    }

    // 🚀 Billing Methods Batch Delete (批量删除卡片)
    if (path === '/api/billing-methods/batch-delete' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const body = await request.json().catch(() => ({}));
      const ids = body.ids || [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return new Response(JSON.stringify({ success: false, message: '缺少 ids' }), { status: 400, headers: corsHeaders });
      }
      let deleted = 0;
      for (const id of ids) {
        try {
          const result = await env.DB.prepare(`DELETE FROM billing_methods WHERE id = ?`).bind(String(id)).run();
          if (result.meta.changes > 0) deleted++;
        } catch (e) { console.error(`[batch-delete] 删除失败 id=${id}:`, e.message); }
      }
      return new Response(JSON.stringify({ success: true, count: deleted }), { headers: corsHeaders });
    }

    // 7. Users Management API
    if (path === '/api/users' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      let query = `SELECT id, username, email, role, status, last_login, created_at, parent_id, permission_level, subscription_expires_at FROM users`;
      let params = [];

      if (uRole === 'superadmin') {
        // Superadmin: See all
      } else if (uRole === 'admin') {
        // Admin: See self and team members
        query += ' WHERE id = ? OR parent_id = ?';
        params = [Number(uId), Number(uId)];
      } else {
        // User: See only self
        query += ' WHERE id = ?';
        params = [Number(uId)];
      }

      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
    }

    if (path === '/api/users' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      if (uRole !== 'superadmin' && uRole !== 'admin') {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }

      const body = await request.json();
      const { username, password, email, role, status, permission_level, subscription_expires_at } = body;
      
      const timestamp = new Date().toISOString();
      try {
        await env.DB.prepare(`
          INSERT INTO users (username, password_hash, email, role, status, parent_id, permission_level, subscription_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          username, password, email, role || 'user', status || 'active', 
          uRole === 'superadmin' ? null : Number(uId),
          permission_level || 'full', subscription_expires_at || null, timestamp, timestamp
        ).run();
        
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    if (path.startsWith('/api/users/') && method === 'PUT') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      const targetId = path.split('/').pop();
      const body = await request.json();
      const { username, password, email, role, status, permission_level, subscription_expires_at } = body;
      const timestamp = new Date().toISOString();

      // Check permissions
      const { results: targetUser } = await env.DB.prepare(`SELECT parent_id FROM users WHERE id = ?`).bind(Number(targetId)).all();
      if (!targetUser[0]) return new Response(JSON.stringify({ success: false, message: 'User not found' }), { status: 404, headers: corsHeaders });
      
      if (uRole !== 'superadmin' && targetUser[0].parent_id != uId && uId != targetId) {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }

      let query = `UPDATE users SET username = ?, email = ?, role = ?, status = ?, permission_level = ?, subscription_expires_at = ?, updated_at = ?`;
      let params = [username, email, role, status, permission_level, subscription_expires_at || null, timestamp];

      if (password) {
        query += `, password_hash = ?`;
        params.push(password);
      }

      query += ` WHERE id = ?`;
      params.push(Number(targetId));

      await env.DB.prepare(query).bind(...params).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (path.startsWith('/api/users/') && method === 'DELETE') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      const targetId = path.split('/').pop();
      
      // Check permissions
      const { results: targetUser } = await env.DB.prepare(`SELECT parent_id FROM users WHERE id = ?`).bind(Number(targetId)).all();
      if (!targetUser[0]) return new Response(JSON.stringify({ success: false, message: 'User not found' }), { status: 404, headers: corsHeaders });
      
      if (uRole !== 'superadmin' && targetUser[0].parent_id != uId) {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }

      await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(Number(targetId)).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (path === '/api/users/add-member' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      if (uRole !== 'superadmin' && uRole !== 'admin') {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }

      const { email, role } = await request.json();
      const { results: existing } = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).all();
      
      if (existing[0]) {
        // Update parent_id to add to team
        await env.DB.prepare(`UPDATE users SET parent_id = ?, role = ? WHERE id = ?`).bind(Number(uId), role || 'user', existing[0].id).run();
      } else {
        // Create skeleton user
        const timestamp = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO users (username, email, role, status, parent_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(email.split('@')[0], email, role || 'user', 'active', Number(uId), timestamp, timestamp).run();
      }
      
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 6. Graph API Proxy
    if (path === '/api/graph' && method === 'POST') {
      const body = await request.json();
      const { url: targetUrl } = body;
      const resp = await fetch(targetUrl);
      const data = await resp.json();
      return new Response(JSON.stringify({ success: true, data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 8. FB Sync API (Internal)
    if (path === '/api/fb-api/sync-cookies' && method === 'POST') {
      const apiSecret = request.headers.get('X-Api-Secret');
      if (apiSecret !== env.PUPPETEER_API_SECRET) {
        return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }

      const { profileId, cookies } = await request.json();
      if (!profileId) return new Response(JSON.stringify({ success: false, message: 'missing profileId' }), { status: 400, headers: corsHeaders });

      const timestamp = new Date().toISOString();
      const cookiesStr = typeof cookies === 'string' ? cookies : JSON.stringify(cookies);

      await env.DB.prepare(`
        UPDATE profiles SET account_cookies = ?, updated_at = ?
        WHERE id = ? OR ext_id = ?
      `).bind(cookiesStr, timestamp, Number(profileId) || 0, String(profileId)).run();

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 9. Ad Templates API
    if (path === '/api/ad-templates' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const tokenData = atob(authHeader.split(' ')[1]);
      const [uId] = tokenData.split(':');

      const isDefault = url.searchParams.get('is_default');
      let query = `SELECT * FROM ad_templates WHERE user_id = ?`;
      let params = [Number(uId)];

      if (isDefault) {
        query += ` AND is_default = ?`;
        params.push(Number(isDefault));
      }
      query += ` ORDER BY updated_at DESC`;

      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
    }

    if (path === '/api/ad-templates' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const tokenData = atob(authHeader.split(' ')[1]);
      const [uId] = tokenData.split(':');

      const { name, is_default, config, id } = await request.json();
      const timestamp = new Date().toISOString();

      if (is_default) {
        // Reset other defaults for this user
        await env.DB.prepare(`UPDATE ad_templates SET is_default = 0 WHERE user_id = ?`).bind(Number(uId)).run();
      }

      if (id) {
        await env.DB.prepare(`
          UPDATE ad_templates SET name = ?, is_default = ?, config = ?, updated_at = ?
          WHERE id = ? AND user_id = ?
        `).bind(name || 'Last Used', is_default ? 1 : 0, JSON.stringify(config), timestamp, Number(id), Number(uId)).run();
        return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
      } else {
        const { meta } = await env.DB.prepare(`
          INSERT INTO ad_templates (user_id, name, is_default, config, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(Number(uId), name || 'Last Used', is_default ? 1 : 0, JSON.stringify(config), timestamp, timestamp).run();
        return new Response(JSON.stringify({ success: true, id: meta.last_row_id }), { headers: corsHeaders });
      }
    }

    if (path.startsWith('/api/ad-templates/') && method === 'DELETE') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const tokenData = atob(authHeader.split(' ')[1]);
      const [uId] = tokenData.split(':');
      const id = path.split('/').pop();

      await env.DB.prepare(`DELETE FROM ad_templates WHERE id = ? AND user_id = ?`).bind(Number(id), Number(uId)).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 🚀 Publish Configs API（一键智能发布表单配置持久化）
    // GET /api/publish-configs/:key  — 读取配置，不传 key 返回全部
    if (path.startsWith('/api/publish-configs') && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      // 🚀 工具函数：安全解析 config_value
      const safeParse = (v) => { try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };
      const key = path.replace('/api/publish-configs/', '');
      if (key && key !== 'publish-configs') {
        const { results } = await env.DB.prepare(`SELECT config_key, config_value FROM publish_configs WHERE config_key = ?`).bind(key).all();
        const row = results[0];
        return new Response(JSON.stringify({ success: true, data: row ? { key: row.config_key, value: safeParse(row.config_value) } : null }), { headers: corsHeaders });
      }
      const { results } = await env.DB.prepare(`SELECT config_key, config_value FROM publish_configs`).all();
      const map = {};
      for (const r of results) map[r.config_key] = safeParse(r.config_value);
      return new Response(JSON.stringify({ success: true, data: map }), { headers: corsHeaders });
    }
    // PUT /api/publish-configs/:key  — 保存配置
    if (path.startsWith('/api/publish-configs') && method === 'PUT') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const key = path.replace('/api/publish-configs/', '');
      const body = await request.json();
      const value = typeof body === 'string' ? body : JSON.stringify(body.value ?? body);
      await env.DB.prepare(`INSERT INTO publish_configs (config_key, config_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, updated_at=CURRENT_TIMESTAMP`).bind(key, value).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 🚀 Logs API — 浏览器执行日志
    // POST /api/logs/batch — 批量写入日志
    if (path === '/api/logs/batch' && method === 'POST') {
      try { await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 0, profile_id TEXT, level TEXT NOT NULL DEFAULT 'INFO', message TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); } catch {}
      try { await env.DB.exec(`ALTER TABLE logs ADD COLUMN user_id INTEGER DEFAULT 0`); } catch {}
      const body = await request.json();
      const items = body.items || [];
      if (!Array.isArray(items) || items.length === 0) {
        return new Response(JSON.stringify({ success: true, count: 0 }), { headers: corsHeaders });
      }
      // 🚀 收集所有 profile_id，批量查询其归属的 user_id
      const pIds = [...new Set(items.map(it => String(it.profile_id || '')).filter(Boolean))];
      const pUserMap = new Map();
      if (pIds.length > 0) {
        const placeholders = pIds.map(() => '?').join(',');
        const { results: pOwners } = await env.DB.prepare(`SELECT id, user_id FROM profiles WHERE id IN (${placeholders}) OR ext_id IN (${placeholders})`).bind(...pIds, ...pIds).all();
        (pOwners || []).forEach(p => {
          if (p.id) pUserMap.set(String(p.id), p.user_id);
          if (p.ext_id) pUserMap.set(String(p.ext_id), p.user_id);
        });
      }
      const timestamp = new Date().toISOString();
      const stmts = items.map(item => {
        const pid = String(item.profile_id || '');
        // 如果未传 user_id 或为 0，尝试从 profile 归属查询
        let uid = item.user_id || 0;
        if (!uid && pid && pUserMap.has(pid)) uid = pUserMap.get(pid);
        return env.DB.prepare(`INSERT OR IGNORE INTO logs (id, user_id, profile_id, level, message, created_at) VALUES (?,?,?,?,?,?)`)
          .bind(item.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`, uid || 0, pid, item.level || 'INFO', item.message || '', timestamp);
      });
      // 分批执行，避免单次 batch 过大
      for (let i = 0; i < stmts.length; i += 100) {
        await env.DB.batch(stmts.slice(i, i + 100));
      }
      return new Response(JSON.stringify({ success: true, count: stmts.length }), { headers: corsHeaders });
    }

    // GET /api/logs — 查询日志（分页 + 过滤）
    if (path === '/api/logs' && method === 'GET') {
      try { await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 0, profile_id TEXT, level TEXT NOT NULL DEFAULT 'INFO', message TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); } catch {}
      try { await env.DB.exec(`ALTER TABLE logs ADD COLUMN user_id INTEGER DEFAULT 0`); } catch {}
      // 🚀 鉴权：superadmin 看全部，普通用户只看自己的
      const authHeader = request.headers.get('Authorization');
      let currentUserId = 0;
      let currentRole = 'user';
      if (authHeader) {
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          currentUserId = Number(parts[0]) || 0;
          currentRole = parts[2] || 'user';
        } catch {}
      }
      const searchParams = url.searchParams;
      const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
      const pageSize = Math.min(200, Math.max(10, parseInt(searchParams.get('pageSize') || '50')));
      const level = searchParams.get('level') || '';
      const profileId = searchParams.get('profileId') || '';
      const keyword = searchParams.get('keyword') || '';
      const userId = searchParams.get('userId') || '';
      const userEmail = searchParams.get('userEmail') || '';

      let where = '1=1';
      const binds = [];
      // 🚀 非 superadmin 只能看自己的日志
      if (currentRole !== 'superadmin' && currentUserId > 0) {
        where += ' AND (user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?))';
        binds.push(currentUserId, currentUserId);
      }
      if (level) { where += ' AND level = ?'; binds.push(level); }
      if (profileId) { where += ' AND profile_id = ?'; binds.push(profileId); }
      if (keyword) { where += ' AND message LIKE ?'; binds.push(`%${keyword}%`); }
      if (userId) { where += ' AND user_id = ?'; binds.push(Number(userId)); }
      if (userEmail) {
        // 通过邮箱反查 user_id
        const { results: emailUsers } = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(userEmail).all();
        if (emailUsers && emailUsers.length > 0) {
          const ids = emailUsers.map(u => u.id);
          where += ` AND user_id IN (${ids.map(() => '?').join(',')})`;
          binds.push(...ids);
        } else {
          // 没有匹配的用户，返回空
          where += ' AND 1=0';
        }
      }

      const countResult = await env.DB.prepare(`SELECT COUNT(1) as total FROM logs WHERE ${where}`).bind(...binds).all();
      const total = countResult.results?.[0]?.total || 0;

      const offset = (page - 1) * pageSize;
      const { results } = await env.DB.prepare(`SELECT l.id, l.user_id, l.profile_id, l.level, l.message, l.created_at, u.email as owner_email, u.username as owner_name FROM logs l LEFT JOIN users u ON l.user_id = u.id WHERE ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all();

      // 获取不重复的 profile_id 列表（用于前端过滤下拉）
      let profileWhere = 'profile_id != ?';
      let profileBinds = [''];
      if (currentRole !== 'superadmin' && currentUserId > 0) {
        profileWhere += ' AND (user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?))';
        profileBinds.push(currentUserId, currentUserId);
      }
      const { results: distinctProfiles } = await env.DB.prepare(`SELECT DISTINCT profile_id FROM logs WHERE ${profileWhere} ORDER BY profile_id`).bind(...profileBinds).all();
      // 获取有日志的用户列表（含邮箱，用于前端用户筛选）
      let userWhere = 'l.user_id IS NOT NULL';
      const userBinds = [];
      if (currentRole !== 'superadmin' && currentUserId > 0) {
        userWhere += ' AND (l.user_id = ? OR l.user_id IN (SELECT id FROM users WHERE parent_id = ?))';
        userBinds.push(currentUserId, currentUserId);
      }
      const { results: logUsers } = await env.DB.prepare(`SELECT DISTINCT l.user_id, u.email FROM logs l LEFT JOIN users u ON l.user_id = u.id WHERE ${userWhere} ORDER BY u.email`).bind(...userBinds).all();

      return new Response(JSON.stringify({
        success: true, data: results || [],
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
        profiles: (distinctProfiles || []).map(r => r.profile_id).filter(Boolean),
        users: (logUsers || []).map(r => ({ userId: r.user_id, email: r.email || `用户 #${r.user_id}` }))
      }), { headers: corsHeaders });
    }

    // DELETE /api/logs/clear — 一键清除所有日志（仅 superadmin）
    if (path === '/api/logs/clear' && method === 'DELETE') {
      try { await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 0, profile_id TEXT, level TEXT NOT NULL DEFAULT 'INFO', message TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); } catch {}
      try { await env.DB.exec(`ALTER TABLE logs ADD COLUMN user_id INTEGER DEFAULT 0`); } catch {}
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        uRole = tokenData.split(':')[2] || '';
      } catch {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }
      if (uRole !== 'superadmin') {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden: superadmin only' }), { status: 403, headers: corsHeaders });
      }
      await env.DB.exec(`DELETE FROM logs`);
      return new Response(JSON.stringify({ success: true, message: 'All logs cleared' }), { status: 200, headers: corsHeaders });
    }

    // Default 404
    return new Response(JSON.stringify({ success: false, message: 'Not Found' }), { status: 404, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, message: err.message, stack: err.stack }), { status: 500, headers: corsHeaders });
  }
}
