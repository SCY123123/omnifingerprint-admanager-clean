'use strict';

// ============================================================================
// Profiles CRUD Routes - extracted from puppeteer-api-server.js
// ============================================================================

const sqlite3 = require('sqlite3').verbose();

// Injected variables
let _log = () => {};
let _app = null;
let _dbPath = '';
let _ensureAdAccountsTable = null;

function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.app) _app = deps.app;
  if (deps.dbPath) _dbPath = deps.dbPath;
  if (deps.ensureAdAccountsTable) _ensureAdAccountsTable = deps.ensureAdAccountsTable;
}

const log = (...args) => _log(...args);

// 🌐 代理字符串 → 结构化字段（与 baota 后端同名逻辑保持一致）
//    导入/其它调用方可能只给了一整串 proxy.raw（host:port:user:pass），而库里是结构化列。
//    支持 socks5://user:pass@host:port、http(s)://host:port、host:port、host:port:user:pass。
//    解析不出 host+port 返回 null。
function parseProxyString(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
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
    return host && port ? { type, host, port, username, password } : null;
}

// 验证卡片自动化流程
// 辅助: ad_accounts 表结构补齐
async function ensureAdAccountsColumns(db) {
    await new Promise((resolve) => db.serialize(resolve));
    const columns = await new Promise((resolve) => {
        db.all(`PRAGMA table_info(ad_accounts)`, (err, rows) => {
            if (err) return resolve([]);
            resolve(rows || []);
        });
    });
    const names = new Set(columns.map(r => r.name));
    const alters = [];
    if (!names.has('country')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN country TEXT`);
    if (!names.has('threshold_amount')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN threshold_amount REAL`);
    if (!names.has('credit_limit')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN credit_limit REAL`);
    if (!names.has('balance')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN balance REAL`);
    if (!names.has('funding_source')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN funding_source TEXT`);
    if (!names.has('pages_count')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN pages_count INTEGER`);
    if (!names.has('bm_count')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN bm_count INTEGER`);
    if (!names.has('pixels_count')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN pixels_count INTEGER`);
    if (!names.has('account')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN account TEXT`);
    if (!names.has('profile_name')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN profile_name TEXT`);
    if (!names.has('address')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN address TEXT`);
    if (!names.has('city')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN city TEXT`);
    if (!names.has('zip')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN zip TEXT`);
    if (!names.has('state')) alters.push(`ALTER TABLE ad_accounts ADD COLUMN state TEXT`);
    
    if (alters.length) {
        await new Promise((resolve) => db.serialize(resolve));
        for (const sql of alters) {
            await new Promise((resolve) => {
                db.run(sql, (err) => {
                    if (err) console.warn(`Column migration failed: ${sql}`, err.message);
                    resolve();
                });
            });
        }
    }
}

function registerRoutes() {
  if (!_app) return;

  // 📋 配置文件管理API
  _app.get('/api/profiles', async (req, res) => {
      try {
          function mapRow(row){
              let proxyConfig = null;
              if (row.proxy_enabled && row.proxy_host) {
                  proxyConfig = {
                      type: row.proxy_type || 'http',
                      host: row.proxy_host,
                      port: row.proxy_port || '8080',
                      username: row.proxy_username,
                      password: row.proxy_password
                  };
              } else if (row.proxy) {
                  try { proxyConfig = JSON.parse(row.proxy); } catch(_){ proxyConfig = null; }
              }
              const profile = {
                  id: String(row.id),
                  name: row.name || String(row.id),
                  platform: row.platform || 'Meta (Facebook/Instagram)',
                  status: 'Idle',
                  accountStatus: 'Unknown',
                  userAgent: row.user_agent || '',
                  ipAddress: row.proxy_host || 'N/A',
                  cookiesCount: 0,
                  lastActive: 'Never',
                  group: '',
                  account: { name: row.account_name || row.account, email: row.account_email, password: row.account_password },
                  notes: row.account_notes || '',
                  token: row.account_tokens || ''
              };
              if (proxyConfig) { profile.proxy = proxyConfig; profile.proxyEnabled = !!row.proxy_enabled; }
              return profile;
          }
          async function readDb(){
              const db = new sqlite3.Database(_dbPath);
              const rows = await new Promise((resolve, reject)=>{
                  db.all(`SELECT id, name, account_name, account_email, account_password, account,
                          start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
                          proxy_port, proxy_username, proxy_password, account_notes, account_tokens, platform
                          FROM profiles`, (err, rows)=> err ? reject(err) : resolve(rows || []));
              });
              db.close();
              return rows.map(mapRow);
          }
          const data = await readDb();
          res.json({ success: true, data, total: data.length });
      } catch (error) {
          log('ERROR', `📋 读取配置列表失败: ${error && error.stack ? error.stack : String(error)}`);
          res.status(500).json({ success: false, error: '获取配置文件失败', message: String(error.message || error) });
      }
  });

  // 📋 获取单个配置文件
  _app.get('/api/profiles/:id', async (req, res) => {
      try {
          const { id } = req.params;
          async function readOne(){
              const db = new sqlite3.Database(_dbPath);
              // 🔎 读路径也加忙等：队列高并发写库时，这里直接开新连接读会瞬间拿到 SQLITE_BUSY，
              //    表现为前端偶发 500（原来连原因都不记，无法追溯）。
              try { db.configure('busyTimeout', 5000); } catch { }
              const row = await new Promise((resolve, reject)=>{
                  db.get(`SELECT id, name, account_name, account_email, account_password, account,
                          start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
                          proxy_port, proxy_username, proxy_password, account_notes, account_tokens, platform
                          FROM profiles WHERE id = ?`, [id], (err, row)=> err ? reject(err) : resolve(row || null));
              });
              db.close();
              return row;
          }
          const row = await readOne();
          if (!row) return res.status(404).json({ success: false, message: '未找到配置' });
          const mapped = {
              id: String(row.id),
              name: row.name || String(row.id),
              platform: row.platform || 'Meta (Facebook/Instagram)',
              status: 'Idle',
              accountStatus: 'Unknown',
              userAgent: row.user_agent || '',
              ipAddress: row.proxy_host || 'N/A',
              cookiesCount: 0,
              lastActive: 'Never',
              group: '',
              account: { name: row.account_name || row.account, email: row.account_email, password: row.account_password },
              notes: row.account_notes || '',
              token: row.account_tokens || ''
          };
          res.json({ success: true, data: mapped });
      } catch (error) {
          // 🔎 以前只把错误塞进响应体，日志里什么都不留 —— 前端只看到 500，事后无从追溯。
          log('ERROR', `📋 读取配置 ${req.params && req.params.id} 失败: ${error && error.stack ? error.stack : String(error)}`);
          res.status(500).json({ success: false, error: '获取配置文件失败', message: String(error.message || error) });
      }
  });

  // 📋 创建配置文件
  _app.post('/api/profiles', async (req, res) => {
      try {
          const profileData = req.body;
          const toArray = Array.isArray(profileData) ? profileData : [profileData];
          function mapProfile(p){
              const acc = p.account || {};
              const proxy = p.proxy || {};
              return {
                  id: String(p.id || Date.now()),
                  name: String(p.name || ''),
                  platform: p.platform || 'Meta (Facebook/Instagram)',
                  account_name: acc.name || acc.email || '',
                  account_email: acc.email || '',
                  account_password: acc.password || '',
                  account: acc.name || '',
                  start_url: Array.isArray(p.startupUrls) && p.startupUrls.length ? String(p.startupUrls[0]) : 'https://www.facebook.com/',
                  user_agent: p.userAgent || '',
                  proxy_enabled: p.proxyEnabled ? 1 : 0,
                  proxy_type: proxy.type || '',
                  proxy_host: proxy.host || '',
                  proxy_port: proxy.port || '',
                  proxy_username: proxy.username || '',
                  proxy_password: proxy.password || '',
                  proxy: JSON.stringify(proxy || {}),
                  account_notes: p.notes || '',
                  account_tokens: p.token || '',
                  // 🍪 保留 payload 带的登录 Cookie（本路由是 INSERT OR REPLACE，不写入这列就是 NULL）
                  account_cookies: (() => {
                      const c = acc.cookies != null ? acc.cookies : p.accountCookies;
                      if (c == null) return '';
                      if (Array.isArray(c)) return c.length ? JSON.stringify(c) : '';
                      if (typeof c === 'string') return c.trim();
                      if (typeof c === 'object') return JSON.stringify(c);
                      return '';
                  })(),
                  os: p.os || '',
                  resolution: p.resolution || '',
                  timezone: p.timezone || '',
                  language: p.language || '',
                  fbLanguage: p.fbLanguage || 'en_US',
                  fingerprintProtection: p.fingerprintProtection ? JSON.stringify(p.fingerprintProtection) : '{}'
              };
          }
          async function ensureAndInsert(){
              const db = new sqlite3.Database(_dbPath);
              await new Promise((resolve, reject)=>{
                  db.run(`CREATE TABLE IF NOT EXISTS profiles (
                      id TEXT PRIMARY KEY,
                      name TEXT,
                      platform TEXT,
                      account_name TEXT,
                      account_email TEXT,
                      account_password TEXT,
                      account TEXT,
                      start_url TEXT,
                      user_agent TEXT,
                      proxy TEXT,
                      proxy_enabled INTEGER,
                      proxy_type TEXT,
                      proxy_host TEXT,
                      proxy_port TEXT,
                      proxy_username TEXT,
                      proxy_password TEXT,
                      account_notes TEXT,
                      account_tokens TEXT,
                      account_cookies TEXT,
                      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                      os TEXT, resolution TEXT, timezone TEXT, language TEXT,
                      fb_language TEXT DEFAULT 'en_US',
                      fingerprint_protection TEXT
                  )`, (err)=> err ? reject(err) : resolve());
              });
              // 🚀 迁移：为已有表添加指纹相关列
              await new Promise(resolve => {
                  db.all(`PRAGMA table_info(profiles)`, (err, rows) => {
                      if (err) { resolve(); return; }
                      const names = new Set((rows || []).map(r => r.name));
                      const missing = [];
                      if (!names.has('os')) missing.push(`ALTER TABLE profiles ADD COLUMN os TEXT`);
                      if (!names.has('resolution')) missing.push(`ALTER TABLE profiles ADD COLUMN resolution TEXT`);
                      if (!names.has('timezone')) missing.push(`ALTER TABLE profiles ADD COLUMN timezone TEXT`);
                      if (!names.has('language')) missing.push(`ALTER TABLE profiles ADD COLUMN language TEXT`);
                      if (!names.has('fb_language')) missing.push(`ALTER TABLE profiles ADD COLUMN fb_language TEXT`);
                      if (!names.has('fingerprint_protection')) missing.push(`ALTER TABLE profiles ADD COLUMN fingerprint_protection TEXT`);
                      let idx = 0;
                      const runNext = () => {
                          if (idx >= missing.length) { resolve(); return; }
                          db.run(missing[idx++], (e) => { if (e) try { console.warn('⚠️ ALTER TABLE 跳过:', e.message); } catch {}; runNext(); });
                      };
                      runNext();
                  });
              });
              try {
                  for(const raw of toArray){
                      const p = mapProfile(raw);
                      await new Promise((resolve, reject)=>{
                          const sql = `INSERT OR REPLACE INTO profiles (
                              id, name, platform, account_name, account_email, account_password, account,
                              start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
                              proxy_port, proxy_username, proxy_password, account_notes, account_tokens, account_cookies,
                              os, resolution, timezone, language, fb_language, fingerprint_protection, updated_at
                          ) VALUES (
                              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                          )`;
                          const args = [
                              p.id, p.name, p.platform, p.account_name, p.account_email, p.account_password, p.account,
                              p.start_url, p.user_agent, p.proxy, p.proxy_enabled, p.proxy_type, p.proxy_host,
                              p.proxy_port, p.proxy_username, p.proxy_password, p.account_notes, p.account_tokens, p.account_cookies,
                              p.os, p.resolution, p.timezone, p.language, p.fbLanguage, p.fingerprintProtection
                          ];
                          db.run(sql, args, (err)=> err ? reject(err) : resolve());
                      });
                  }
              } catch (e) {
                  db.close();
                  throw e;
              }
              db.close();
          }
          await ensureAndInsert();
          res.json({ success: true, count: toArray.length });
      } catch (error) {
          res.status(500).json({ success: false, message: '创建配置文件失败', error: String(error.message || error) });
      }
  });

  _app.post('/api/profiles/bulk-save', async (req, res) => {
      try {
          const payload = req.body && req.body.profiles ? req.body.profiles : [];
          if (!Array.isArray(payload) || payload.length === 0) return res.status(400).json({ success: false, message: '无有效配置' });
          const toArray = payload;
          // 🚀 先取出现有行的代理列：payload 没带代理信息时（如导入表格没映射代理列）
          //    要沿用库里已有值 —— 本接口是 INSERT OR REPLACE，整行覆盖，不自己兜就会把已有代理抹掉。
          // 🍪 先取出现有行的代理 + Cookie/Token 列：本接口是 INSERT OR REPLACE（整行覆盖），
          //    payload 没带的列会被写成 NULL —— payload 通常不含 cookies（列表接口不下发），
          //    结果就是「启动正常 → 一保存卡片 Cookie 变空 → 下次启动未登录」。必须自己兜住。
          const prevRowMap = new Map();
          await new Promise((resolve) => {
              const ids = toArray.map(p => String((p && p.id) || '')).filter(Boolean);
              if (ids.length === 0) return resolve();
              const db = new sqlite3.Database(_dbPath);
              const placeholders = ids.map(() => '?').join(',');
              db.all(
                  `SELECT id, proxy_enabled, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password,
                          account_cookies, account_tokens
                   FROM profiles WHERE id IN (${placeholders})`,
                  ids,
                  (err, rows) => {
                      // 表还没建时（首次导入）这里会报错，忽略即可：没有旧行就没有可沿用的列
                      if (!err && Array.isArray(rows)) {
                          for (const r of rows) prevRowMap.set(String(r.id), r);
                      } else if (err) {
                          log('DEBUG', `读取已有代理/Cookie 列失败（忽略）: ${err.message}`);
                      }
                      try { db.close(); } catch {}
                      resolve();
                  }
              );
          });

          // 🍪 Cookie 归一化成「存库用的 JSON 字符串」：payload 给了就用它，没给则回退旧行值
          const serializeCookies = (value, fallback) => {
              try {
                  if (value == null) return fallback || '';
                  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : (fallback || '');
                  if (typeof value === 'string') { const s = value.trim(); return s ? s : (fallback || ''); }
                  if (typeof value === 'object') { const s = JSON.stringify(value); return s && s !== '{}' ? s : (fallback || ''); }
                  return fallback || '';
              } catch { return fallback || ''; }
          };
          function mapProfile(p, prev){
              const acc = p.account || {};
              const proxy = p.proxy || {};
              // 🌐 代理字符串兜底解析：显式给出的 proxy.host/port/... 优先
              const parsed = (typeof proxy.raw === 'string' && proxy.raw.trim()) ? parseProxyString(proxy.raw) : null;
              const newHost = proxy.host || (parsed && parsed.host) || '';
              const newPort = proxy.port || (parsed && parsed.port) || '';
              const hasProxyPayload = !!(newHost && newPort);
              // 🚀 合并规则（本接口是 INSERT OR REPLACE，整行覆盖，所以必须自己兜住）：
              //    · 带了可用代理信息 → 用新的（proxyEnabled 缺省视为启用）
              //    · 没带代理信息、调用方也没显式声明 → 沿用库里已有值，否则重复保存/重导入会把已有代理抹掉
              //    · 显式 proxyEnabled === false → 清空
              const prevRow = prev || prevRowMap.get(String(p.id || ''));
              const usePrev = !hasProxyPayload && p.proxyEnabled === undefined && !!prevRow;
              const proxyEnabled = p.proxyEnabled !== undefined
                  ? (p.proxyEnabled ? 1 : 0)
                  : (usePrev ? (prevRow.proxy_enabled ? 1 : 0) : (hasProxyPayload ? 1 : 0));
              const prevVal = (field) => (usePrev ? String(prevRow[field] || '') : '');
              const proxyToSave = proxyEnabled ? {
                  type: proxy.type || (parsed && parsed.type) || prevVal('proxy_type') || 'http',
                  host: newHost || prevVal('proxy_host'),
                  port: newPort || prevVal('proxy_port'),
                  username: proxy.username || (parsed && parsed.username) || prevVal('proxy_username'),
                  password: proxy.password || (parsed && parsed.password) || prevVal('proxy_password')
              } : {};
              return {
                  id: String(p.id || Date.now()),
                  name: String(p.name || ''),
                  platform: p.platform || 'Meta (Facebook/Instagram)',
                  account_name: acc.name || acc.email || '',
                  account_email: acc.email || '',
                  account_password: acc.password || '',
                  account: acc.name || '',
                  start_url: Array.isArray(p.startupUrls) && p.startupUrls.length ? String(p.startupUrls[0]) : 'https://www.facebook.com/',
                  user_agent: p.userAgent || '',
                  proxy_enabled: proxyEnabled,
                  proxy_type: proxyToSave.type || '',
                  proxy_host: proxyToSave.host || '',
                  proxy_port: proxyToSave.port || '',
                  proxy_username: proxyToSave.username || '',
                  proxy_password: proxyToSave.password || '',
                  proxy: JSON.stringify(proxyToSave || {}),
                  account_notes: p.notes || '',
                  // 🔑 Token / 🍪 Cookie 与代理同样兜底：payload 没带就沿用库里已有的，
                  //    否则 INSERT OR REPLACE 会把它们整行抹成 NULL（实测 5886 就是这么变空的）
                  account_tokens: p.account_tokens || p.token || (prevRow && prevRow.account_tokens ? String(prevRow.account_tokens) : ''),
                  account_cookies: serializeCookies(acc.cookies != null ? acc.cookies : p.accountCookies,
                      prevRow && prevRow.account_cookies ? String(prevRow.account_cookies) : ''),
                  os: p.os || '',
                  resolution: p.resolution || '',
                  timezone: p.timezone || '',
                  language: p.language || '',
                  fbLanguage: p.fbLanguage || 'en_US',
                  fingerprintProtection: p.fingerprintProtection ? JSON.stringify(p.fingerprintProtection) : '{}'
              };
          }
          async function ensureAndInsert(){
              const db = new sqlite3.Database(_dbPath);
              await new Promise((resolve, reject)=>{
                  db.run(`CREATE TABLE IF NOT EXISTS profiles (
                      id TEXT PRIMARY KEY,
                      name TEXT,
                      platform TEXT,
                      account_name TEXT,
                      account_email TEXT,
                      account_password TEXT,
                      account TEXT,
                      start_url TEXT,
                      user_agent TEXT,
                      proxy TEXT,
                      proxy_enabled INTEGER,
                      proxy_type TEXT,
                      proxy_host TEXT,
                      proxy_port TEXT,
                      proxy_username TEXT,
                      proxy_password TEXT,
                      account_notes TEXT,
                      account_cookies TEXT,
                      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                      os TEXT, resolution TEXT, timezone TEXT, language TEXT,
                      fb_language TEXT DEFAULT 'en_US',
                      fingerprint_protection TEXT
                  )`, (err)=> err ? reject(err) : resolve());
              });
              // 🚀 迁移：为已有表添加指纹相关列
              await new Promise(resolve => {
                  db.all(`PRAGMA table_info(profiles)`, (err, rows) => {
                      if (err) { resolve(); return; }
                      const names = new Set((rows || []).map(r => r.name));
                      const missing = [];
                      if (!names.has('os')) missing.push(`ALTER TABLE profiles ADD COLUMN os TEXT`);
                      if (!names.has('resolution')) missing.push(`ALTER TABLE profiles ADD COLUMN resolution TEXT`);
                      if (!names.has('timezone')) missing.push(`ALTER TABLE profiles ADD COLUMN timezone TEXT`);
                      if (!names.has('language')) missing.push(`ALTER TABLE profiles ADD COLUMN language TEXT`);
                      if (!names.has('fb_language')) missing.push(`ALTER TABLE profiles ADD COLUMN fb_language TEXT`);
                      if (!names.has('fingerprint_protection')) missing.push(`ALTER TABLE profiles ADD COLUMN fingerprint_protection TEXT`);
                      let idx = 0;
                      const runNext = () => {
                          if (idx >= missing.length) { resolve(); return; }
                          db.run(missing[idx++], (e) => { if (e) try { console.warn('⚠️ ALTER TABLE 跳过:', e.message); } catch {}; runNext(); });
                      };
                      runNext();
                  });
              });
              try {
                  for(const raw of toArray){
                      const p = mapProfile(raw);
                      await new Promise((resolve, reject)=>{
                          const sql = `INSERT OR REPLACE INTO profiles (
                              id, name, platform, account_name, account_email, account_password, account,
                              start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
                              proxy_port, proxy_username, proxy_password, account_notes, account_tokens, account_cookies,
                              os, resolution, timezone, language, fb_language, fingerprint_protection, updated_at
                          ) VALUES (
                              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                          )`;
                          const args = [
                              p.id, p.name, p.platform, p.account_name, p.account_email, p.account_password, p.account,
                              p.start_url, p.user_agent, p.proxy, p.proxy_enabled, p.proxy_type, p.proxy_host,
                              p.proxy_port, p.proxy_username, p.proxy_password, p.account_notes, p.account_tokens, p.account_cookies,
                              p.os, p.resolution, p.timezone, p.language, p.fbLanguage, p.fingerprintProtection
                          ];
                          db.run(sql, args, (err)=> err ? reject(err) : resolve());
                      });
                  }
              } catch (e) {
                  db.close();
                  throw e;
              }
              db.close();
          }
          await ensureAndInsert();
          res.json({ success: true, count: toArray.length });
      } catch (error) {
          res.status(500).json({ success: false, message: '批量保存失败', error: String(error.message || error) });
      }
  });

  // 本地读取广告账户（用于前端回退）
  _app.get('/api/local/adaccounts', async (req, res) => {
      try {
          const sdb = new sqlite3.Database(_dbPath);
          await _ensureAdAccountsTable(sdb);
          await ensureAdAccountsColumns(sdb);
          
          // 🚀 修正：先从 pages 表按 profile_id 计算真实数量
          const pageCounts = await new Promise((resolve) => {
              sdb.all(`SELECT profile_id, COUNT(1) AS cnt FROM pages GROUP BY profile_id`, (err, rows) => {
                  resolve(err ? {} : Object.fromEntries((rows || []).map(r => [String(r.profile_id).trim(), Number(r.cnt || 0)])));
              });
          });

          const rows = await new Promise((resolve, reject) => {
              sdb.all(`SELECT id, profile_id AS profileId, platform, account_id AS account_id, name, status, currency, timezone_id, spend, country, threshold_amount, credit_limit, balance, funding_source, pages_count, bm_count, pixels_count, account, profile_name FROM ad_accounts ORDER BY updated_at DESC`, (err, rows) => {
                  if (err) return reject(err);
                  resolve(rows || []);
              });
          });
          sdb.close();

          // 🚀 修正：用 pages 表的真实计数覆盖 pages_count
          const enriched = (rows || []).map(r => ({
              ...r,
              pages_count: pageCounts[String(r.profileId).trim()] || Number(r.pages_count || 0)
          }));

          return res.json({ success: true, data: enriched });
      } catch (e) {
          return res.status(500).json({ success: false, message: String(e.message || e) });
      }
  })
}

module.exports = { __inject, registerRoutes };
