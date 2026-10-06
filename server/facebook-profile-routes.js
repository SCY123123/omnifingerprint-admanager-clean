'use strict';

// ============================================================
// Facebook 配置/Token/首选项/调试路由模块
// ============================================================

const sqlite3 = require('sqlite3').verbose();
// 🔐 会话闸门：取到有效 Token = 已登录，需要把状态登记给 Cookie 同步闸门（syncCookiesToStorage 会读它）
const cookieManager = require('./cookie-manager');

// 📋 注入的依赖
let _log = () => {};
let _app = null;
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _activeBrowsers = new Map();
let _findProfileById = null;
let _browserManager = null;
let _findChromeExecutable = null;
let _FILE_LOG_PATH = '';
let _dbPath = '';
let _ensureAdAccountsTable = null;
let _ensureAdposPrefs = null;
let _PORT = 0;
let _API_SECRET = '';
// ⏳ 等某个配置的启动流程（含自动登录）跑完 —— 抽 Token 前必须先等，否则会抓到登出态页面
let _waitForLaunchIdle = null;
// 🔐 统一的 Chrome 代理参数构造（含带账密代理的本地认证转发器 / 隧道），与 createBrowser 共用
let _buildProxyChromeArgs = null;
// 🍪 云端 Cookie 读取/规范化 —— 临时浏览器也要带登录态，否则抓到的是登出态 token（validated=false）
let _getCookiesFromStorage = null;
let _normalizeCookie = null;

/**
 * 注入主文件的依赖到配置/Token/首选项模块
 */
function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.app) _app = deps.app;
  if (deps.sleep) _sleep = deps.sleep;
  if (deps.activeBrowsers) _activeBrowsers = deps.activeBrowsers;
  if (deps.findProfileById) _findProfileById = deps.findProfileById;
  if (deps.browserManager) _browserManager = deps.browserManager;
  if (deps.findChromeExecutable) _findChromeExecutable = deps.findChromeExecutable;
  if (deps.FILE_LOG_PATH) _FILE_LOG_PATH = deps.FILE_LOG_PATH;
  if (deps.dbPath) _dbPath = deps.dbPath;
  if (deps.ensureAdAccountsTable) _ensureAdAccountsTable = deps.ensureAdAccountsTable;
  if (deps.ensureAdposPrefs) _ensureAdposPrefs = deps.ensureAdposPrefs;
  if (deps.PORT !== undefined) _PORT = deps.PORT;
  if (deps.API_SECRET) _API_SECRET = deps.API_SECRET;
  if (deps.waitForLaunchIdle) _waitForLaunchIdle = deps.waitForLaunchIdle;
  if (deps.buildProxyChromeArgs) _buildProxyChromeArgs = deps.buildProxyChromeArgs;
  if (deps.getCookiesFromStorage) _getCookiesFromStorage = deps.getCookiesFromStorage;
  if (deps.normalizeCookie) _normalizeCookie = deps.normalizeCookie;
}

const log = (...args) => _log(...args);
const sleep = (ms) => _sleep(ms);
const findProfileById = (...args) => _findProfileById(...args);
// ⚠️ 必须转发真实对象的属性：Token 路由用的是 browserManager.getUnifiedUserDataDir(...)。
//    以前写成 (...args) => _browserManager(...args)，属性访问只会得到 undefined，
//    于是「获取TOKEN」在浏览器未运行时直接报 "browserManager.getUnifiedUserDataDir is not a function"。
const browserManager = {
  getUnifiedUserDataDir: (...args) => _browserManager.getUnifiedUserDataDir(...args)
};

/**
 * 注册所有配置/Token/首选项/调试路由
 */
function registerRoutes() {
  if (!_app) return;

  // ============================================================
  // 🔑 获取登录凭据端点
  // ============================================================
  _app.get('/api/credentials/:domain', (req, res) => {
    const { domain } = req.params;
    const { profileId } = req.query;
    
    try {
        console.log(`🔍 查询登录凭据: ${domain} (Profile: ${profileId})`);
        
        const db = new sqlite3.Database('./profiles.db');
        
        // 查询该域名的登录凭据
        const sql = `
            SELECT id, username, password_encrypted, website_name, form_selectors, is_default, auto_login
            FROM login_credentials 
            WHERE website_domain LIKE ? AND profile_id = ?
            ORDER BY is_default DESC, id ASC
        `;
        
        db.all(sql, [`%${domain}%`, profileId || 'test-profile-001'], (err, rows) => {
            if (err) {
                console.error('❌ 查询登录凭据失败:', err.message);
                return res.status(500).json({
                    success: false,
                    message: '查询登录凭据失败',
                    error: err.message
                });
            }
            
            // 解密密码并格式化数据
            const credentials = rows.map(row => ({
                id: row.id,
                username: row.username,
                password: 'test-password', // 简化处理，实际应该解密
                website_name: row.website_name,
                form_selectors: row.form_selectors ? JSON.parse(row.form_selectors) : null,
                is_default: row.is_default === 1,
                auto_login: row.auto_login === 1
            }));
            
            console.log(`✅ 找到 ${credentials.length} 个登录凭据`);
            
            res.json({
                success: true,
                data: credentials,
                domain,
                profileId: profileId || 'test-profile-001',
                timestamp: new Date().toISOString()
            });
            
            db.close();
        });
        
    } catch (error) {
        console.error('❌ 获取登录凭据失败:', error);
        res.status(500).json({
            success: false,
            message: '获取登录凭据失败',
            error: error.message
        });
    }
  });

  // ============================================================
  // 🚀 获取本地 AdAccounts
  // ============================================================
  _app.get('/api/local/adaccounts', async (req, res) => {
    try {
        const pid = String((req.query && (req.query.profileId || req.query.pid)) || '')
        const sdb = new sqlite3.Database(_dbPath)
        await _ensureAdAccountsTable(sdb)
        const rows = await new Promise((resolve, reject) => {
            const sql = pid ? `SELECT id, profile_id, account_id, name, status, currency, timezone_id FROM ad_accounts WHERE profile_id = ?` : `SELECT id, profile_id, account_id, name, status, currency, timezone_id FROM ad_accounts`
            const args = pid ? [pid] : []
            sdb.all(sql, args, (err, r) => (err ? reject(err) : resolve(r || [])))
        })
        await new Promise(r => sdb.close(r))
        const list = Array.isArray(rows) ? rows.map(r => ({ id: String(r.id||''), profileId: String(r.profile_id||''), adAccountId: String(r.account_id||''), name: String(r.name||''), adAccountStatus: String(r.status||''), currency: String(r.currency||''), timezone_id: String(r.timezone_id||'') })) : []
        return res.json({ success: true, data: list })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
    }
  })

  // ============================================================
  // 🚀 本地兼容存储服务：Profiles 列表
  // ============================================================
  _app.get('/api/profiles', async (req, res) => {
    try {
        const sdb = new sqlite3.Database(_dbPath)
        const rows = await new Promise((resolve, reject) => {
            sdb.all(`SELECT id, name, account_name, account_email, account_password, account, start_url, user_agent, proxy, proxy_enabled, account_notes FROM profiles`, [], (err, r) => (err ? reject(err) : resolve(r || [])))
        })
        await new Promise(r => sdb.close(r))
        const list = (rows || []).map(r => ({
            id: String(r.id||''),
            name: String(r.name||''),
            platform: 'Meta (Facebook/Instagram)',
            account: String(r.account || r.account_email || r.account_name || ''),
            accountEmail: String(r.account_email || ''),
            accountName: String(r.account_name || ''),
            userAgent: String(r.user_agent || ''),
            proxy: (function(){ try { return r.proxy ? JSON.parse(r.proxy) : null } catch { return null } })(),
            proxyEnabled: !!r.proxy_enabled,
            notes: String(r.account_notes || ''),
            startUrl: String(r.start_url || '')
        }))
        return res.json({ success: true, data: list })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
    }
  })

  // ============================================================
  // 🚀 兼容：Profiles 单条
  // ============================================================
  _app.get('/api/profiles/:id', async (req, res) => {
    try {
        const profileId = String(req.params.id || '')
        const sdb = new sqlite3.Database(_dbPath)
        const row = await new Promise((resolve, reject) => {
            sdb.get(`SELECT id, name, account_name, account_email, account_password, account, start_url, user_agent, proxy, proxy_enabled, account_notes FROM profiles WHERE id = ?`, [profileId], (err, r) => (err ? reject(err) : resolve(r || null)))
        })
        await new Promise(r => sdb.close(r))
        if (!row) return res.json({ success: false, data: null })
        const data = {
            id: String(row.id||''),
            name: String(row.name||''),
            platform: 'Meta (Facebook/Instagram)',
            account: String(row.account || row.account_email || row.account_name || ''),
            accountEmail: String(row.account_email || ''),
            accountName: String(row.account_name || ''),
            userAgent: String(row.user_agent || ''),
            proxy: (function(){ try { return row.proxy ? JSON.parse(row.proxy) : null } catch { return null } })(),
            proxyEnabled: !!row.proxy_enabled,
            notes: String(row.account_notes || ''),
            startUrl: String(row.start_url || '')
        }
        return res.json({ success: true, data })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
    }
  })

  // ============================================================
  // 🚀 修正：新增 PUT /api/profiles/:id 端点（编辑单个配置）
  // ============================================================
  _app.put('/api/profiles/:id', async (req, res) => {
    try {
        const profileId = String(req.params.id || '')
        const p = req.body || {}
        if (!profileId) return res.status(400).json({ success: false, message: 'Missing id' })
        
        const acc = p.account || {}

        // 🔧 动态拼接 SET：只更新请求里真实带上的字段。
        //    原来的固定 SQL 有两个问题：
        //    1) 引用了 profiles 表里并不存在的 group_col / tags_col → 每次保存都 500
        //       （实测 SQLITE_ERROR: no such column: group_col）；
        //    2) 没传的字段也会被写空 —— 只改邮箱/密码就会把代理写成「关闭」、把 UA 写成空串。
        const sets = []
        const args = []
        const put = (col, val) => { sets.push(`${col} = ?`); args.push(val) }

        if (p.name !== undefined) put('name', String(p.name || ''))
        if (acc.name !== undefined || acc.email !== undefined) put('account_name', String(acc.name || acc.email || ''))
        if (acc.email !== undefined) put('account_email', String(acc.email || ''))
        if (acc.password !== undefined) put('account_password', String(acc.password || ''))
        if (acc.name !== undefined) put('account', String(acc.name || ''))
        if (p.start_url !== undefined || p.startupUrls !== undefined) {
            put('start_url', String(p.start_url || (Array.isArray(p.startupUrls) && p.startupUrls.length ? String(p.startupUrls[0]) : 'https://www.facebook.com/')))
        }
        // UA 只在真的传了非空值时才写：画像生成出来的 UA 不能被空值冲掉
        const uaVal = p.userAgent || p.user_agent
        if (uaVal) put('user_agent', String(uaVal))
        if (p.proxyEnabled !== undefined || p.proxy !== undefined) {
            const proxyEnabled = p.proxyEnabled ? 1 : 0
            const proxyToSave = proxyEnabled ? (p.proxy || {}) : {}
            put('proxy', JSON.stringify(proxyToSave || {}))
            put('proxy_enabled', proxyEnabled)
            put('proxy_type', String(proxyToSave.type || ''))
            put('proxy_host', String(proxyToSave.host || ''))
            put('proxy_port', String(proxyToSave.port || ''))
            put('proxy_username', String(proxyToSave.username || ''))
            put('proxy_password', String(proxyToSave.password || ''))
        }
        if (p.notes !== undefined || p.account_notes !== undefined) put('account_notes', String(p.notes || p.account_notes || ''))
        if (acc.twoFactorSecret !== undefined || p.account_twofactor_secret !== undefined) {
            put('account_twofactor_secret', String(acc.twoFactorSecret || p.account_twofactor_secret || ''))
        }

        if (!sets.length) return res.json({ success: true, message: '没有需要更新的字段' })

        const db = new sqlite3.Database(_dbPath)
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE profiles SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                args.concat([profileId]),
                (err) => err ? reject(err) : resolve()
            )
        })
        db.close()
        return res.json({ success: true, message: '配置已更新' })
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) })
    }
  })

  // ============================================================
  // 🚀 本地兼容存储服务：AdAccounts 列表
  // ============================================================
  _app.get('/api/adaccounts', async (req, res) => {
    try {
        const sdb = new sqlite3.Database(_dbPath)
        await _ensureAdAccountsTable(sdb)
        const rows = await new Promise((resolve, reject) => {
            sdb.all(`SELECT id, profile_id, account_id, name, status, currency, timezone_id FROM ad_accounts`, [], (err, r) => (err ? reject(err) : resolve(r || [])))
        })
        await new Promise(r => sdb.close(r))
        const list = (rows || []).map(r => ({ id: String(r.id||''), profileId: String(r.profile_id||''), adAccountId: String(r.account_id||''), name: String(r.name||''), adAccountStatus: String(r.status||''), currency: String(r.currency||''), timezone_id: String(r.timezone_id||'') }))
        return res.json({ success: true, data: list })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
    }
  })

  // ============================================================
  // 🚀 本地兼容存储服务：Businesses/BillingMethods 空列表
  // ============================================================
  _app.get('/api/businesses', async (_req, res) => {
    return res.json({ success: true, data: [] })
  })
  _app.get('/api/billing-methods', async (_req, res) => {
    return res.json({ success: true, data: [] })
  })

  // ============================================================
  // 🚀 Facebook 首选项 (GET)
  // ============================================================
  _app.get('/api/facebook/prefs', async (req, res) => {
    try {
        const pid = String((req.query && (req.query.profileId || req.query.pid)) || '')
        const sdb = new sqlite3.Database(_dbPath)
        await _ensureAdposPrefs(sdb)
        const row = await new Promise((resolve)=>{
            sdb.get(`SELECT profile_id, auto_refresh, auto_save_local FROM adpos_prefs WHERE profile_id = ?`, [pid], (err, r)=> resolve(err?null:(r||null)))
        })
        await new Promise(r=>sdb.close(r))
        const data = row ? { profileId: String(row.profile_id||''), auto_refresh: !!Number(row.auto_refresh||0), auto_save_local: !!Number(row.auto_save_local||0) } : { profileId: pid, auto_refresh: false, auto_save_local: false }
        return res.json({ success: true, data })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
    }
  })

  // ============================================================
  // 🚀 Facebook 首选项 (POST)
  // ============================================================
  _app.post('/api/facebook/prefs', async (req, res) => {
    try {
        const body = req.body || {}
        const pid = String(body.profileId || body.pid || '')
        const auto_refresh = body.auto_refresh ? 1 : 0
        const auto_save_local = body.auto_save_local ? 1 : 0
        if (!pid) return res.status(400).json({ success: false, message: 'missing_profileId' })
        const sdb = new sqlite3.Database(_dbPath)
        await _ensureAdposPrefs(sdb)
        await new Promise((resolve, reject)=>{
            sdb.run(`INSERT OR REPLACE INTO adpos_prefs (profile_id, auto_refresh, auto_save_local, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, [pid, auto_refresh, auto_save_local], (err)=> (err?reject(err):resolve()))
        })
        await new Promise(r=>sdb.close(r))
        return res.json({ success: true })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
    }
  })

  // ============================================================
  // 🚀 手动付款 API - 通过 Puppeteer 打开 billing_hub 执行付款
  // ============================================================
  _app.post('/api/facebook/close-browser', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const pid = String(profileId || '');
        const bd = _activeBrowsers.get(pid);
        if (bd && bd.browser && bd.browser.isConnected()) {
            await bd.browser.close().catch(() => {});
            _activeBrowsers.delete(pid);
            log('INFO', `🛑 [Profile=${pid}] 浏览器已关闭`);
            return res.json({ success: true, message: 'closed' });
        } else {
            return res.json({ success: true, message: 'not_running' });
        }
    } catch (e) {
        return res.json({ success: false, message: e.message });
    }
  });

  // ============================================================
  // 🚀 获取 Token
  // ============================================================
  _app.post('/api/facebook/tokens', async (req, res) => {
    // ⏱️ 这个接口以前既不写日志也不设超时：一旦卡住，前端只能无限干等（表现为"点了没反应"）。
    //    现在进入/分支/结果/失败全部打日志，并加整体超时兜底，超过就明确返回失败。
    const _t0 = Date.now();
    const _reqPid = String((req.body || {}).profileId || '');
    const TOKENS_TIMEOUT_MS = Math.max(5000, parseInt(process.env.TOKENS_TIMEOUT_MS || '90000', 10) || 90000);
    let _responded = false;
    let _tempBrowserRef = null;
    const _timeoutTimer = setTimeout(() => {
        if (_responded) return;
        _responded = true;
        log('WARN', `[Tokens] 超时 ${TOKENS_TIMEOUT_MS}ms 仍未取到结果，直接返回失败: profileId=${_reqPid}`);
        try { if (_tempBrowserRef) _tempBrowserRef.close().catch(() => {}); } catch {}
        try {
            res.status(504).json({ success: false, timeout: true, message: `提取 Token 超时(${Math.round(TOKENS_TIMEOUT_MS / 1000)}s)，请稍后重试` });
        } catch {}
    }, TOKENS_TIMEOUT_MS);
    res.on('finish', () => { _responded = true; clearTimeout(_timeoutTimer); });
    try {
        const { profileId, targetUrl } = req.body || {};
        log('INFO', `[Tokens] 开始提取 Token: profileId=${profileId}, targetUrl=${String(targetUrl || '(默认)').substring(0, 80)}`);
        // ⏳ 该配置正在启动（启动流程里含自动登录）就先等它结束。
        //    🐛 不等的话：实例 isConnected() 已经是 true，但页面还在登出态，
        //    于是抽到 0 个 Token、190 恢复链路把这次「没抽到」当最终结果返回 ——
        //    现象就是「日志里自动登录明明成功了，请求却还是 190」。实测 profile 4341 就踩了这个时间差。
        try {
            // ⏱️ 等待上限取「本请求剩余超时预算 - 5s」，保证不会等到自己被上面的兜底定时器砍掉
            const budget = Math.max(5000, TOKENS_TIMEOUT_MS - (Date.now() - _t0) - 5000);
            const waited = _waitForLaunchIdle ? await _waitForLaunchIdle(profileId, budget) : false;
            if (waited) log('INFO', `[Tokens] 已等到启动/自动登录结束，继续抽 Token: profileId=${profileId}`);
        } catch (e) {
            log('WARN', `[Tokens] 等待启动结束异常（继续抽）: ${String(e && e.message || e)}`);
        }
        const browserData = _activeBrowsers.get(profileId);
        let page = null;
        let tempBrowser = null;
        log('INFO', `[Tokens] 活跃浏览器${browserData && browserData.browser && browserData.browser.isConnected() ? '存在，直接复用' : '不存在，将新建临时浏览器'}: profileId=${profileId}`);
        if (browserData && browserData.browser && browserData.browser.isConnected()) {
            page = await browserData.browser.newPage();
        } else {
            const effectiveExecutablePath = _findChromeExecutable() || null;
            const udDir = browserManager.getUnifiedUserDataDir(profileId, undefined, undefined);
            // 🚀 尝试获取 Profile 信息（代理等）
            let profileProxy = null;
            try {
                const prof = await findProfileById(profileId);
                if (prof && prof.proxy) profileProxy = prof.proxy;
            } catch (_) {}
            const puppeteer = require('puppeteer');
            // ⚠️ 不要加 --no-sandbox：Chrome 会因此在窗口顶部弹「unsupported command-line flag」黄条。
            //    与 createBrowser 的启动参数保持一致（普通权限下系统沙箱可用，无需该参数）。
            const chromeArgs = [`--user-data-dir=${udDir}`, '--disable-setuid-sandbox'];
            // 如果有代理配置，交给统一的代理构造（含带账密的本地认证转发器 / 不可直达时的隧道）
            // 🐛 以前这里直接拼 `type://host:port`：代理带账密时 Chrome 收不到认证凭据，
            //    页面导航一路超时（20s）、最终抓到 0 个 token（实测 profileId 4137/4135/4142）。
            if (profileProxy && profileProxy.host && profileProxy.port) {
                log('INFO', `[Tokens] 浏览器将使用代理: ${profileProxy.type || 'http'}://${profileProxy.host}:${profileProxy.port}${profileProxy.username ? ' (带认证)' : ''}`);
                let proxyArgs = [];
                try {
                    proxyArgs = _buildProxyChromeArgs ? await _buildProxyChromeArgs(profileProxy, profileId) : [];
                } catch (proxyErr) {
                    log('WARN', `[Tokens] 代理参数构造失败: ${String(proxyErr && proxyErr.message || proxyErr)}`);
                }
                if (proxyArgs.length > 0) chromeArgs.push(...proxyArgs);
                else chromeArgs.push(`--proxy-server=${profileProxy.type || 'http'}://${profileProxy.host}:${profileProxy.port}`);
            }
            const launchOpts = {
                headless: false,
                args: chromeArgs,
                defaultViewport: null,
                timeout: 30000
            };
            if (effectiveExecutablePath) launchOpts.executablePath = effectiveExecutablePath;
            try {
                tempBrowser = await puppeteer.launch(launchOpts);
            } catch (launchErr) {
                log('ERROR', `[Tokens] 浏览器启动失败: ${String(launchErr.message || launchErr)}`);
                return res.status(500).json({ success: false, message: '浏览器启动失败', error: String(launchErr.message || launchErr) });
            }
            _tempBrowserRef = tempBrowser;
            log('INFO', `[Tokens] 已新建临时浏览器: profileId=${profileId}（耗时 ${Date.now() - _t0}ms）`);
            page = await tempBrowser.newPage();
        }
        log('INFO', `[Tokens] 页面就绪，开始抓取 token: profileId=${profileId}（耗时 ${Date.now() - _t0}ms）`);
        const authSet = new Set();
        const accessTokenSet = new Set();
        try { await page.setRequestInterception(true); } catch {}
        page.on('request', request => {
            try {
                const headers = request.headers();
                const auth = headers['authorization'] || headers['Authorization'];
                if (auth) authSet.add(auth);
                const url = request.url();
                const post = request.postData() || '';
                const m1 = url.match(/access_token=([A-Za-z0-9%\-_.]+)/);
                if (m1) accessTokenSet.add(decodeURIComponent(m1[1]));
                const m2 = post.match(/access_token=([A-Za-z0-9%\-_.]+)/);
                if (m2) accessTokenSet.add(decodeURIComponent(m2[1]));
            } catch {}
            try { request.continue(); } catch {}
        });
        page.on('response', async response => {
            try {
                const url = response.url();
                if (/graph|graphql|batch/i.test(url)) {
                    const headers = response.headers() || {};
                    const ct = headers['content-type'] || headers['Content-Type'] || '';
                    if (/json|text/i.test(ct)) {
                        const txt = await response.text();
                        const m = txt.match(/access_token"\s*:\s*"([A-Za-z0-9\-_.]+)"/);
                        if (m) accessTokenSet.add(m[1]);
                    }
                }
            } catch {}
        });
        // ☁️ 临时浏览器同样要带云端 Cookie：否则页面是登出态，
        //    抓到的 token 在页面校验里过不了（validated=false、fb_dtsg=null）。
        // 🚫 但浏览器自己已经是有效登录态时**不要**再拿云端那份盖上：
        //    setCookie 写的是「浏览器级共享 cookie jar」，会覆盖正在跑任务的页面所用的会话。
        //    批量任务里每个失败的 Graph 调用都会触发一次刷新 → 每刷一次注一遍，
        //    实测 2026-09-27 profile 4067 在 18:55:01~18:56:58 两分钟内重复注入了 4 次同样的 13 个 Cookie。
        try {
            const liveCookies = await page.cookies('https://www.facebook.com', 'https://facebook.com').catch(() => []);
            const hasLiveSession = Array.isArray(liveCookies)
                && liveCookies.some(c => c.name === 'c_user' && c.value)
                && liveCookies.some(c => c.name === 'xs' && c.value);
            if (hasLiveSession) {
                log('INFO', `[Tokens] 浏览器已是有效登录态，跳过往浏览器注入云端 Cookie: profileId=${profileId}`);
            } else {
                const storedCookies = _getCookiesFromStorage ? await _getCookiesFromStorage(profileId) : [];
                if (Array.isArray(storedCookies) && storedCookies.length > 0) {
                    const validCookies = storedCookies.map(c => {
                        const nc = _normalizeCookie ? _normalizeCookie(c) : c;
                        if (!nc || !nc.name) return null;
                        let domain = nc.domain || '.facebook.com';
                        if (!/facebook\.com$/i.test(domain)) domain = '.facebook.com';
                        return {
                            name: nc.name,
                            value: nc.value,
                            domain,
                            path: nc.path || '/',
                            secure: true,
                            httpOnly: nc.httpOnly,
                            sameSite: nc.sameSite,
                            expires: nc.expires > 0 ? nc.expires : undefined,
                        };
                    }).filter(Boolean);
                    if (validCookies.length > 0) {
                        await page.setCookie(...validCookies);
                        const names = validCookies.map(c => c.name);
                        log('INFO', `[Tokens] 已注入 ${validCookies.length} 个云端 Cookie: profileId=${profileId}${names.includes('c_user') ? '（含登录态 c_user）' : '（⚠️ 不含 c_user，注入后仍是登出态）'}`);
                    }
                }
            }
        } catch (cookieErr) {
            log('WARN', `[Tokens] Cookie 注入失败（继续抽 Token）: ${String(cookieErr && cookieErr.message || cookieErr)}`);
        }
        const urlToVisit = typeof targetUrl === 'string' && targetUrl ? targetUrl : 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';
        try {
            await page.goto(urlToVisit, { waitUntil: 'domcontentloaded', timeout: 20000 });
            log('INFO', `[Tokens] 页面加载完成: ${urlToVisit.substring(0, 80)} → 实际 URL: ${String(page.url() || '').substring(0, 120)}`);
        } catch (gotoErr) {
            log('WARN', `[Tokens] 页面加载超时或失败(继续执行): ${String(gotoErr.message || gotoErr).substring(0, 100)}`);
        }
        try { await new Promise(r => setTimeout(r, 2000)); } catch {}
        try {
            await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15A372 Safari/604.1');
            const tokenFromMobile = await page.evaluate(async () => {
                try {
                    const resp = await fetch('https://m.facebook.com/composer/ocelot/async_loader/?publisher=feed', { credentials: 'include' });
                    const txt = await resp.text();
                    const m = txt.match(/"accessToken":"(EAAG[^"]+)"/);
                    return m && m[1] ? m[1] : null;
                } catch { return null; }
            });
            if (tokenFromMobile) accessTokenSet.add(tokenFromMobile);
        } catch {}
        let validated = false;
        let firstToken = null;
        let validatedTokens = [];
        let domTokens = { fb_dtsg: null, lsd: null };
        try {
            domTokens = await page.evaluate(() => {
                const dtsgEl = document.querySelector('input[name="fb_dtsg"], [name="fb_dtsg"]');
                const lsdEl = document.querySelector('input[name="lsd"], [name="lsd"]');
                const dtsg = dtsgEl && 'value' in dtsgEl ? dtsgEl.value : null;
                const lsd = lsdEl && 'value' in lsdEl ? lsdEl.value : null;
                return { fb_dtsg: dtsg || null, lsd: lsd || null };
            });
        } catch {}
        try {
            const directAccessTokens = await page.evaluate(() => {
                const results = new Set();
                try {
                    const v = (window).__accessToken || (window).accessToken;
                    if (typeof v === 'string' && v.length > 0) results.add(v);
                } catch {}
                try {
                    for (const k in window) {
                        try {
                            const val = (window)[k];
                            if (typeof val === 'string' && /access[_-]?token/i.test(k) && val.length > 0) {
                                results.add(val);
                            }
                        } catch {}
                    }
                } catch {}
                try {
                    const lsKeys = Object.keys(localStorage || {});
                    lsKeys.forEach(k => {
                        try {
                            if (/access[_-]?token/i.test(k)) {
                                const v = localStorage.getItem(k);
                                if (v && v.length > 0) results.add(v);
                            }
                        } catch {}
                    });
                } catch {}
                try {
                    const html = document.documentElement ? document.documentElement.innerHTML : '';
                    const m = html.match(/__accessToken\s*[:=]\s*"([A-Za-z0-9\-_.]+)"/);
                    if (m && m[1]) results.add(m[1]);
                } catch {}
                return Array.from(results);
            });
            for (const v of directAccessTokens || []) accessTokenSet.add(v);
        } catch {}
        // 🔍 在页面内校验 Token（必须赶在 page.close() 之前）
        //    🐛 以前这一步是 Node 侧 `https.get('https://graph.facebook.com/v20.0/me')`，
        //       但这台机器/这网络经常直连不到 Facebook（所以 GraphAPI 到处都「跳过 curl 走浏览器上下文」），
        //       于是 validated 恒为 false、firstToken 恒为 Set 里的第一个（顺序随机）。
        //       后果：上层（refreshProfileToken）只能按 /^EAAG|^EAA/ 前缀盲选，可能把死 token 存回配置，
        //       接着又是一轮 190。改到页面里用 XHR 校验 —— 与真正发请求的通道完全一致。
        try {
            const candidates = Array.from(accessTokenSet).slice(0, 10);
            if (candidates.length > 0) {
                validatedTokens = await page.evaluate(async (tokens) => {
                    const ok = [];
                    for (const t of tokens) {
                        try {
                            const j = await new Promise((resolve, reject) => {
                                const xhr = new XMLHttpRequest();
                                xhr.open('GET', `https://graph.facebook.com/v20.0/me?fields=id&access_token=${encodeURIComponent(t)}`);
                                // ⚠️ 必须 true：FB 对不带登录 Cookie 的 Graph 调用统一返回
                                //    {"error":{"message":"Invalid request.","code":1}}，
                                //    于是这里恒为 validated=false（取到 token 也无法登记登录态）。
                                xhr.withCredentials = true;
                                xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); } };
                                xhr.onerror = () => reject(new Error('xhr failed'));
                                xhr.send();
                            });
                            if (j && j.id) ok.push({ token: t, id: String(j.id) });
                        } catch {}
                    }
                    return ok;
                }, candidates);
            }
        } catch (e) {
            log('WARN', `[Tokens] 页面内校验 Token 失败: ${String(e.message || e).substring(0, 120)}`);
        }
        // 优先用校验通过的 token 当 primary，没有才退回第一个（保持旧行为）
        if (Array.isArray(validatedTokens) && validatedTokens.length > 0) {
            firstToken = validatedTokens[0].token;
            validated = true;
        } else {
            const arr = Array.from(accessTokenSet);
            firstToken = arr.length > 0 ? arr[0] : null;
            validated = false;
        }
        try { await page.close(); } catch {}
        try { if (tempBrowser) await tempBrowser.close(); } catch {}
        log('INFO', `[Tokens] 提取完成: profileId=${profileId}, authorization=${authSet.size}, access_tokens=${accessTokenSet.size}, validated=${validated}(${Array.isArray(validatedTokens) ? validatedTokens.length : 0}/${accessTokenSet.size}), 耗时=${Date.now() - _t0}ms`);
        if (accessTokenSet.size === 0) {
            log('WARN', `[Tokens] 未取到任何 access_token: profileId=${profileId}（浏览器可能未登录，或启动后已被关闭）`);
        }
        // 🔐 「获取到有效 Token 即视为已登录」的落点：Token 在页面内校验通过 → 会话有效 →
        //    登记登录态，打开 Cookie 回写云端的闸门（启动流程那套页面文案判定保持不动）。
        try {
            if (validated) {
                cookieManager.markLoginState(profileId, true);
                log('INFO', `[Tokens] Token 已校验有效 → 登记为已登录 (profileId=${profileId})`);
            } else if (accessTokenSet.size > 0) {
                log('WARN', `[Tokens] 取到 ${accessTokenSet.size} 个 Token 但未通过校验，不登记登录态 (profileId=${profileId})`);
            }
        } catch {}
        return res.json({
            success: true,
            tokens: {
                authorization: Array.from(authSet),
                access_tokens: Array.from(accessTokenSet),
                fb_dtsg: domTokens.fb_dtsg || null,
                lsd: domTokens.lsd || null,
                validated: validated,
                validated_tokens: (validatedTokens || []).map(v => v.token),
                primary: firstToken || null
            }
        });
    } catch (e) {
        log('ERROR', `[Tokens] 提取失败: profileId=${_reqPid}, 耗时=${Date.now() - _t0}ms, 原因=${String(e.message || e)}`);
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
  });

  // ============================================================
  // 📝 调试：读取服务日志的末尾行
  // ============================================================
  _app.get('/api/debug/token-logs', async (req, res) => {
    try {
      const maxLines = 200;
      let text = '';
      try { text = require('fs').readFileSync(_FILE_LOG_PATH, 'utf8'); } catch {}
      const lines = String(text || '').split(/\r?\n/).filter(Boolean);
      const tail = lines.slice(-maxLines);
      res.json({ success: true, lines: tail });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // ============================================================
  // 📝 获取特定配置的执行日志
  // ============================================================
  _app.get('/api/logs/:profileId', async (req, res) => {
    try {
        const { profileId } = req.params;
        const maxLines = 500;
        let text = '';
        try { 
            // 🚀 性能优化：只读取末尾部分文件
            const fsSync = require('fs');
            const stats = fsSync.statSync(_FILE_LOG_PATH);
            const bufferSize = Math.min(stats.size, 1024 * 100); // 读取最后 100KB
            const fd = fsSync.openSync(_FILE_LOG_PATH, 'r');
            const buffer = Buffer.alloc(bufferSize);
            fsSync.readSync(fd, buffer, 0, bufferSize, stats.size - bufferSize);
            fsSync.closeSync(fd);
            text = buffer.toString('utf8');
        } catch (e) {
            try { text = require('fs').readFileSync(_FILE_LOG_PATH, 'utf8'); } catch {}
        }

        const lines = String(text || '').split(/\r?\n/).filter(Boolean);
        // 过滤包含 profileId 的行，或者包含该 ID 的 ext_id 形式
        const filtered = lines.filter(line => 
            line.includes(`Profile=${profileId}`) || 
            line.includes(`profileId: ${profileId}`) ||
            line.includes(`profile=${profileId}`) ||
            line.includes(`[${profileId}]`)
        ).slice(-maxLines);

        res.json({ success: true, lines: filtered });
    } catch (e) {
        res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // ============================================================
  // 🚀 保存 tokens 到 storage 服务器
  // ============================================================
  _app.post('/api/facebook/save-tokens', async (req, res) => {
    try {
        const { profileId, tokens } = req.body || {};
        if (!profileId) {
            return res.status(400).json({ success: false, message: '缺少profileId参数' });
        }
        
        // 获取storage服务器地址
        const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
        const baseUrl = storageServerUrl.replace(/\/$/, '');
        
        // 准备要保存的数据
        const accessTokens = Array.isArray(tokens.access_tokens) ? tokens.access_tokens : [];
        // 🔍 优先保存「页面内校验通过」的 token（tokens.validated_tokens，见 /api/facebook/tokens）。
        //    🐛 以前只按 /^EAA/ 前缀取第一个，而提取端那会儿的校验用的是本机 Node 直连 FB（必然失败），
        //       于是经常把死 token 写进配置 → 下一次请求又是 190，还得再刷一遍。
        const validatedTokens = Array.isArray(tokens.validated_tokens) ? tokens.validated_tokens.filter(Boolean) : [];
        const hasValidatedField = Array.isArray(tokens.validated_tokens);
        const firstToken = validatedTokens.find(v => /^EAA/i.test(String(v)))
            || validatedTokens.find(v => typeof v === 'string' && v.length > 0)
            || '';
        if (!firstToken && hasValidatedField && accessTokens.length > 0) {
            log('WARN', `⚠️ 本次提取到的 ${accessTokens.length} 个 Token 全部未通过校验，拒绝写入配置（登录态可能已失效）: profileId=${profileId}`);
            return res.status(400).json({ success: false, message: '提取到的 Token 均无效（登录态可能已失效，请人工重新登录）' });
        }
        // 兼容不带 validated_tokens 的旧调用方
        const fallbackToken = firstToken || accessTokens.find(v => /^EAA/i.test(String(v))) || accessTokens.find(v => typeof v === 'string' && v.length > 0) || '';
        
        // 🚀 优化：使用 bulk-save 接口同步 Token 到云端，保持一致性且支持 API Secret
        const apiSecret = process.env.PUPPETEER_API_SECRET || '';
        const saveResp = await fetch(`${baseUrl}/api/profiles/bulk-save`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': apiSecret
            },
            body: JSON.stringify({ items: [{ id: profileId, token: fallbackToken }] })
        });
        
        const saveResult = await saveResp.json();
        
        if (saveResult.success) {
            log('INFO', `✅ Token保存成功: ${profileId}, Token长度: ${fallbackToken.length}`);
            
            // 🚀 同时更新本地数据库中的 Token
            try {
                const sdb = new sqlite3.Database(_dbPath);
                await new Promise((resolve, reject) => {
                    sdb.run(`UPDATE profiles SET account_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR ext_id = ?`, [fallbackToken, profileId, profileId], (err) => {
                        if (err) reject(err); else resolve();
                    });
                });
                sdb.close();
            } catch (e) { log('WARN', `⚠️ 本地数据库更新Token失败: ${e.message}`); }

            return res.json({ 
                success: true, 
                message: 'Token保存成功',
                token: fallbackToken,
                tokensCount: accessTokens.length
            });
        } else {
            log('ERROR', `❌ Token保存失败: ${profileId}, 原因: ${saveResult.message || '未知错误'}`);
            return res.status(500).json({ 
                success: false, 
                message: saveResult.message || '保存失败'
            });
        }
        
    } catch (e) {
        log('ERROR', `❌ Token保存异常: ${e.message}`);
        return res.status(500).json({ 
            success: false, 
            message: 'Token保存异常',
            error: String(e.message || e)
        });
    }
  });
}

module.exports = { __inject, registerRoutes };
