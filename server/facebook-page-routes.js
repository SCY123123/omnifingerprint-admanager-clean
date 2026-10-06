'use strict';

// ============================================================
// Facebook 主页/广告管理路由模块
// ============================================================

// 📋 注入的依赖
let _log = () => {};
let _app = null;
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _activeBrowsers = new Map();
let _findProfileById = null;
let _ensureBrowserIsRunning = async () => ({ success: false, error: '__inject not called' });
let _extractFbToken = null;
let _safePageEvaluate = null;
let _callFacebookGraphApi = null;
let _profileGraphqlFailCache = new Set();
let _browserManager = null;
let _postOperationSync = null;
let _PORT = 0;
let _API_SECRET = '';
let _FILE_LOG_PATH = '';
let _SCREENSHOT_DIR = '';
let _extractEmailPrefix = null;

/**
 * 注入主文件的依赖到页面/广告管理模块
 */
function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.app) _app = deps.app;
  if (deps.sleep) _sleep = deps.sleep;
  if (deps.activeBrowsers) _activeBrowsers = deps.activeBrowsers;
  if (deps.findProfileById) _findProfileById = deps.findProfileById;
  if (deps.ensureBrowserIsRunning) _ensureBrowserIsRunning = deps.ensureBrowserIsRunning;
  if (deps.extractFbToken) _extractFbToken = deps.extractFbToken;
  if (deps.safePageEvaluate) _safePageEvaluate = deps.safePageEvaluate;
  if (deps.callFacebookGraphApi) _callFacebookGraphApi = deps.callFacebookGraphApi;
  if (deps.profileGraphqlFailCache) _profileGraphqlFailCache = deps.profileGraphqlFailCache;
  if (deps.browserManager) _browserManager = deps.browserManager;
  if (deps.postOperationSync) _postOperationSync = deps.postOperationSync;
  if (deps.PORT !== undefined) _PORT = deps.PORT;
  if (deps.API_SECRET) _API_SECRET = deps.API_SECRET;
  if (deps.FILE_LOG_PATH) _FILE_LOG_PATH = deps.FILE_LOG_PATH;
  if (deps.SCREENSHOT_DIR) _SCREENSHOT_DIR = deps.SCREENSHOT_DIR;
  if (deps.extractEmailPrefix) _extractEmailPrefix = deps.extractEmailPrefix;
}

const log = (...args) => _log(...args);
const sleep = (ms) => _sleep(ms);
const findProfileById = (...args) => _findProfileById(...args);
const ensureBrowserIsRunning = (...args) => _ensureBrowserIsRunning(...args);
const extractFbToken = (...args) => _extractFbToken(...args);
const safePageEvaluate = (...args) => _safePageEvaluate(...args);
const callFacebookGraphApi = (...args) => _callFacebookGraphApi(...args);
const browserManager = (...args) => _browserManager(...args);
const postOperationSync = (...args) => _postOperationSync(...args);
const extractEmailPrefix = (...args) => _extractEmailPrefix(...args);

/**
 * 注册所有页面/广告管理路由
 */
function registerRoutes() {
  if (!_app) return;

  // ============================================================
  // 🚀 创建 Facebook 主页（通过浏览器 GraphQL）
  // ============================================================
  // 🚀 直接 fetch 创建 Facebook 主页（无需浏览器自动化，只需浏览器上下文）
  // 支持可选：网站(创建后编辑)、头像(上传并设置)、背景图(上传并设置)
  // 头像/背景需传 base64 和文件名
  _app.post('/api/facebook/page/create', async (req, res) => {
    const { profileId, name, categoryId, bio, website, profileImageBase64, profileImageName, coverImageBase64, coverImageName } = req.body;
    if (!profileId || !name) return res.status(400).json({ success: false, message: '缺少 profileId 或 name' });
    if (!categoryId) return res.status(400).json({ success: false, message: '缺少 categoryId（主页类别ID）' });
    
    // 🐛 修复：自动启动浏览器（支持并发批量创建），不再要求预先启动
    let launchedByUs = false;
    try {
        let browser;
        let page;
        
        // 1. 先尝试获取已运行的浏览器
        const existing = _activeBrowsers.get(profileId);
        if (existing && existing.browser && existing.browser.isConnected()) {
            browser = existing.browser;
            page = (await browser.pages()).find(p => { try { const u = p.url(); return u && u.includes('facebook.com'); } catch { return false; } });
            if (!page) page = (await browser.pages())[0];
            log('INFO', `[PageCreate] 复用已有浏览器 (profileId=${profileId})`);
        } else {
            // 2. 没有运行中的浏览器 → 自动启动（走并发限制）
            log('INFO', `[PageCreate] 自动启动浏览器 (profileId=${profileId})`);
            const launchResult = await ensureBrowserIsRunning(profileId, null, null);
            if (!launchResult.success) {
                throw new Error(`自动启动浏览器失败: ${launchResult.error}`);
            }
            browser = launchResult.browserData.browser;
            launchedByUs = true;
            // 打开新标签页并导航到 facebook.com
            page = await browser.newPage();
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        }
        
        // 🐛 修复：用 CDP page.cookies() 提取 c_user（httpOnly，JS 无法读取）
        let cUserIdFromCDP = '';
        try {
            const cookiesForCreate = await page.cookies();
            const cUserCookie = cookiesForCreate.find(c => c.name === 'c_user' && c.value);
            if (cUserCookie) cUserIdFromCDP = cUserCookie.value;
        } catch {}
        
        const result = await page.evaluate(async (params) => {
            const { name, categoryId, bio, website, profileImageBase64, profileImageName, coverImageBase64, coverImageName, cUserIdFromCDP } = params;
            
            // 1. 提取 fb_dtsg
            let fbDtsg = '';
            try { const CD = typeof window.require === 'function' && window.require('CurrentUserInitialData'); if (CD && CD.fbDtsg) fbDtsg = CD.fbDtsg; } catch {}
            if (!fbDtsg) { const inp = document.querySelector('input[name="fb_dtsg"]'); if (inp && inp.value) fbDtsg = inp.value; }
            if (!fbDtsg) { const m = document.body?.innerHTML?.match(/"token":"([^"]+)"/); if (m) fbDtsg = m[1]; }
            if (!fbDtsg) { const attr = document.querySelector('[data-dtsg]'); if (attr) fbDtsg = attr.getAttribute('data-dtsg') || ''; }
            
            // 2. 提取 actor_id
            let actorId = '';
            try { const CD = typeof window.require === 'function' && window.require('CurrentUserInitialData'); if (CD && CD.userID) actorId = CD.userID; } catch {}
            if (!actorId && cUserIdFromCDP) { actorId = cUserIdFromCDP; }
            
            if (!fbDtsg) return { error: 'no_fb_dtsg', message: '无法提取 fb_dtsg' };
            if (!actorId) return { error: 'no_actor_id', message: '无法提取用户ID' };
            
            // 3. 发送创建主页请求
            const variables = {
                input: {
                    bio: bio || '',
                    categories: [categoryId],
                    creation_source: 'comet',
                    name: name,
                    off_platform_creator_reachout_id: null,
                    page_referrer: 'null',
                    actor_id: actorId,
                    client_mutation_id: String(Date.now())
                }
            };
            
            const fd = new URLSearchParams();
            fd.append('fb_dtsg', fbDtsg);
            fd.append('variables', JSON.stringify(variables));
            fd.append('doc_id', '23863457623296585');
            
            let pageId = '';
            try {
                const resp = await fetch('/api/graphql/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: fd.toString()
                });
                let text = await resp.text();
                const idx = text.indexOf('{');
                const json = JSON.parse(idx > 0 ? text.substring(idx) : text);
                const createResult = json?.data?.additional_profile_plus_create;
                if (!createResult || !createResult.page?.id) return json;
                pageId = createResult.page.id;
            } catch (e) { return { error: 'fetch_failed_create', message: String(e.message || e) }; }
            
            // 4. 如果提供了网站，用编辑 mutation 设置
            if (website && pageId) {
                try {
                    const editVars = {
                        input: {
                            additional_profile_plus_id: actorId,
                            creation_source: 'comet',
                            cpn_setting: true,
                            email_notif_setting: true,
                            website: website,
                            actor_id: actorId,
                            client_mutation_id: String(Date.now() + 1)
                        }
                    };
                    const editFd = new URLSearchParams();
                    editFd.append('fb_dtsg', fbDtsg);
                    editFd.append('variables', JSON.stringify(editVars));
                    editFd.append('doc_id', '9799341016792282');
                    await fetch('/api/graphql/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: editFd.toString() });
                } catch (e) { /* 设置网站失败不影响主流程 */ }
            }
            
            // 5. 如果提供了头像图片，上传并设置
            if (profileImageBase64 && pageId) {
                try {
                    // 转换 base64 为 Blob
                    const byteChars = atob(profileImageBase64.split(',')[1] || profileImageBase64);
                    const byteNums = new Array(byteChars.length);
                    for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
                    const byteArr = new Uint8Array(byteNums);
                    const blob = new Blob([byteArr], { type: 'image/jpeg' });
                    const file = new File([blob], profileImageName || 'profile.jpg', { type: 'image/jpeg' });
                    
                    const formData = new FormData();
                    formData.append('profile_pic', file);
                    formData.append('page_id', pageId);
                    formData.append('fb_dtsg', fbDtsg);
                    
                    await fetch('/photos/profile_upload/', { method: 'POST', body: formData }).catch(() => {});
                } catch (e) { /* 头像上传失败不影响主流程 */ }
            }
            
            // 6. 如果提供了背景图片，上传并设置
            if (coverImageBase64 && pageId) {
                try {
                    const byteChars = atob(coverImageBase64.split(',')[1] || coverImageBase64);
                    const byteNums = new Array(byteChars.length);
                    for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
                    const byteArr = new Uint8Array(byteNums);
                    const blob = new Blob([byteArr], { type: 'image/jpeg' });
                    const file = new File([blob], coverImageName || 'cover.jpg', { type: 'image/jpeg' });
                    
                    const formData = new FormData();
                    formData.append('cover', file);
                    formData.append('page_id', pageId);
                    formData.append('fb_dtsg', fbDtsg);
                    
                    await fetch('/photos/cover_upload/', { method: 'POST', body: formData }).catch(() => {});
                } catch (e) { /* 背景上传失败不影响主流程 */ }
            }
            
            return { data: { additional_profile_plus_create: { page: { id: pageId }, additional_profile: { id: actorId } } } };
        }, { name, categoryId, bio: bio || '', website: website || '', profileImageBase64: profileImageBase64 || '', profileImageName: profileImageName || '', coverImageBase64: coverImageBase64 || '', coverImageName: coverImageName || '', cUserIdFromCDP });
        
        log('INFO', `[PageCreate] 结果=${JSON.stringify(result).substring(0,300)}`);
        
        if (result?.data?.additional_profile_plus_create) {
            const pageData = result.data.additional_profile_plus_create;
            const pageId = pageData.page?.id || '';
            res.json({ 
                success: true, 
                pageId,
                message: `主页创建成功: ID=${pageId}`,
                raw: pageData
            });
        } else if (result?.error) {
            res.json({ success: false, error: result.error, message: result.message || '创建失败' });
        } else if (result?.errors) {
            res.json({ success: false, error: 'graphql_error', message: result.errors.map(e => e.message).join('; ') });
        } else {
            res.json({ success: false, error: 'unknown', message: '未知响应', raw: result });
        }
        
        // 🔌 如果是自动启动的浏览器，任务完成后释放空位
        if (launchedByUs) {
            log('INFO', `[PageCreate] 🔌 任务完成，关闭自动启动的浏览器释放空位 (profileId=${profileId})`);
            try { const bd = _activeBrowsers.get(String(profileId)); if (bd && bd.browser) { try { await bd.browser.close(); } catch {} } _activeBrowsers.delete(String(profileId)); } catch {}
        }
        
    } catch (err) {
        log('WARN', `[PageCreate] ❌ 异常: ${err.message} (profileId=${profileId})`);
        res.status(500).json({ success: false, message: err.message });
        // 🔌 如果是自动启动的浏览器，异常时也释放空位
        if (launchedByUs) {
            log('INFO', `[PageCreate] 🔌 异常退出，关闭自动启动的浏览器释放空位 (profileId=${profileId})`);
            try { const bd = _activeBrowsers.get(String(profileId)); if (bd && bd.browser) { try { await bd.browser.close(); } catch {} } _activeBrowsers.delete(String(profileId)); } catch {}
        }
    }
  });

  // ============================================================
  // 🚀 广告：更改状态（ACTIVE/PAUSED）
  // ============================================================
  _app.post('/api/facebook/ads/status', async (req, res) => {
    try {
        const { profileId, adId, status, accessToken } = req.body || {};
        if (!profileId || !adId || !status) return res.status(400).json({ success: false, message: 'missing profileId/adId/status' });

        const profile = await findProfileById(profileId);
        const token = accessToken || profile?.account_tokens || profile?.token;
        if (!token) return res.status(400).json({ success: false, message: 'missing access token' });

        const base = 'https://graph.facebook.com/v20.0';
        const url = `${base}/${adId}?status=${status}&access_token=${encodeURIComponent(token)}`;
        
        const resp = await fetch(url, { method: 'POST' });
        const json = await resp.json();
        
        if (json && json.success) {
            return res.json({ success: true, adId, status });
        } else {
            return res.status(400).json({ success: false, message: json?.error?.message || 'Update failed' });
        }
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // ============================================================
  // 🚀 广告：删除
  // ============================================================
  _app.post('/api/facebook/ads/delete', async (req, res) => {
    try {
        const { profileId, adId, accessToken } = req.body || {};
        if (!profileId || !adId) return res.status(400).json({ success: false, message: 'missing profileId/adId' });

        const profile = await findProfileById(profileId);
        const token = accessToken || profile?.account_tokens || profile?.token;
        if (!token) return res.status(400).json({ success: false, message: 'missing access token' });

        const base = 'https://graph.facebook.com/v20.0';
        const url = `${base}/${adId}?access_token=${encodeURIComponent(token)}`;
        
        const resp = await fetch(url, { method: 'DELETE' });
        const json = await resp.json();
        
        if (json && json.success) {
            return res.json({ success: true, adId });
        } else {
            return res.status(400).json({ success: false, message: json?.error?.message || 'Delete failed' });
        }
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // ============================================================
  // 🔍 查询广告号当前真实设置
  // ============================================================
  _app.post('/api/facebook/adaccounts/query-settings', async (req, res) => {
    try {
      const { profileId, adAccountId } = req.body || {}
      if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })

      log('INFO', `[QueryAdAccountSettings] 查询: profileId=${profileId}, adAccountId=${adAccountId}`);

      let browserResult;
      try { browserResult = await ensureBrowserIsRunning(profileId); } catch (e) { browserResult = { success: false, error: e.message }; }
      if (!browserResult.success) return res.json({ success: false, message: '浏览器未运行', error: browserResult.error });

      const profile = await findProfileById(profileId);
      let token = String(profile?.account_tokens || profile?.token || '').trim();
      const browser2 = browserResult.browserData.browser;
      const pages = await browser2.pages();
      let page = pages.find(p => p.url().includes('facebook.com')) || await browser2.newPage();

      if (!token) {
        if (!page.url().includes('facebook.com')) await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        token = await page.evaluate(() => {
          try {
            const keys = Object.keys(localStorage);
            for (const k of keys) {
              const v = localStorage.getItem(k);
              if (v && (v.startsWith('EAAB') || v.startsWith('EAA'))) return v;
              try { const p = JSON.parse(v); if (p && typeof p === 'object') for (const sk of Object.keys(p)) if (String(p[sk]).startsWith('EA')) return p[sk]; } catch {}
            }
            if (window.__accessToken && String(window.__accessToken).startsWith('EA')) return window.__accessToken;
            return '';
          } catch { return ''; }
        }).catch(() => '');
      }

      if (!token) return res.json({ success: false, message: '无法获取 Token' });

      const cleanId = String(adAccountId).replace('act_', '');
      
      // 🔍 GET 查询：currency, timezone_id, business_country_code, account_status
      const queryResult = await page.evaluate(async ({ cleanId, token }) => {
        try {
          const resp = await fetch(`https://graph.facebook.com/v19.0/act_${cleanId}?fields=id,name,currency,timezone_id,business_country_code,account_status,balance&access_token=${encodeURIComponent(token)}`);
          return await resp.json();
        } catch (e) { return { error: { message: String(e && (e.message || e)) } }; }
      }, { cleanId, token });

      log('INFO', `[QueryAdAccountSettings] 查询结果: ${JSON.stringify(queryResult).substring(0, 600)}`);

      if (queryResult && !queryResult.error && queryResult.id) {
        return res.json({
          success: true,
          data: {
            id: queryResult.id,
            name: queryResult.name,
            currency: queryResult.currency || '',
            timezone_id: queryResult.timezone_id !== undefined ? String(queryResult.timezone_id) : '',
            business_country_code: queryResult.business_country_code || '',
            account_status: queryResult.account_status !== undefined ? String(queryResult.account_status) : '',
            balance: queryResult.balance || ''
          }
        });
      } else {
        return res.json({
          success: false,
          message: 'API 查询失败',
          error: queryResult?.error || queryResult
        });
      }
    } catch (e) {
      return res.status(500).json({ success: false, message: String(e.message || e) })
    }
  })

  // ============================================================
  // 🔍 查询广告账户的像素列表
  // ============================================================
  _app.post('/api/facebook/adaccounts/query-pixels', async (req, res) => {
    try {
      const { profileId, adAccountId } = req.body || {}
      if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })

      log('INFO', `[QueryPixels] 查询: profileId=${profileId}, adAccountId=${adAccountId}`);

      // 1. 确保浏览器运行
      let browserResult;
      try { browserResult = await ensureBrowserIsRunning(profileId); } catch (e) { browserResult = { success: false, error: e.message }; }
      if (!browserResult.success) return res.json({ success: false, message: '浏览器未运行', error: browserResult.error });

      const profile = await findProfileById(profileId);
      const browser2 = browserResult.browserData.browser;
      const pages = await browser2.pages();
      let page = pages.find(p => p.url().includes('facebook.com')) || await browser2.newPage();

      // 2. 获取 Token
      let token = String(profile?.account_tokens || profile?.token || '').trim();
      if (!token) {
        if (!page.url().includes('facebook.com')) await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        token = await page.evaluate(() => {
          try {
            const keys = Object.keys(localStorage);
            for (const k of keys) {
              const v = localStorage.getItem(k);
              if (v && (v.startsWith('EAAB') || v.startsWith('EAA'))) return v;
              try { const p = JSON.parse(v); if (p && typeof p === 'object') for (const sk of Object.keys(p)) if (String(p[sk]).startsWith('EA')) return p[sk]; } catch {}
            }
            if (window.__accessToken && String(window.__accessToken).startsWith('EA')) return window.__accessToken;
            return '';
          } catch { return ''; }
        }).catch(() => '');
      }
      if (!token) return res.json({ success: false, message: '无法获取 Token' });

      const cleanId = String(adAccountId).replace('act_', '');

      // 3. 查询像素列表
      const pixelsResult = await page.evaluate(async ({ cleanId, token }) => {
        try {
          const resp = await fetch(`https://graph.facebook.com/v21.0/act_${cleanId}/adspixels?fields=id,pixel_id,name,status,last_fired_time&access_token=${encodeURIComponent(token)}`);
          return await resp.json();
        } catch (e) { return { error: { message: String(e && (e.message || e)) } }; }
      }, { cleanId, token });

      log('INFO', `[QueryPixels] 查询结果: ${JSON.stringify(pixelsResult).substring(0, 400)}`);

      if (pixelsResult && !pixelsResult.error && pixelsResult.data) {
        const pixels = (pixelsResult.data || []).map((p) => ({
          id: p.id || '',
          pixel_id: p.pixel_id || '',
          name: p.name || '',
          status: p.status || '',
          last_fired_time: p.last_fired_time || ''
        }));
        return res.json({ success: true, data: pixels, total: pixels.length });
      } else {
        return res.json({
          success: false,
          message: '查询像素失败',
          error: pixelsResult?.error || pixelsResult
        });
      }
    } catch (e) {
      return res.status(500).json({ success: false, message: String(e.message || e) })
    }
  })

  // ============================================================
  // 🚀 创建像素
  // ============================================================
  // 创建像素
  _app.post('/api/facebook/adaccounts/pixel/create', async (req, res) => {
    try {
      const { profileId, adAccountId, name, businessId, claimToBusiness } = req.body || {}
      if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
      
      log('INFO', `🚀 [Profile=${profileId}] 准备为广告账户 ${adAccountId} 创建像素: ${name}`);
      
      const profile = await findProfileById(profileId);
      if (!profile) throw new Error('未找到该配置信息');
      
      const pixelName = name || (profile.name ? `${profile.name}_Pixel` : 'Auto_Pixel');
      const actId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
      let effectiveToken = profile.account_tokens || profile.token || '';
      let json = null;

      // 💡 第一阶段：尝试 API 高速创建
      if (effectiveToken) {
        log('INFO', `⚡ [API 模式] 正在尝试通过 Graph API 快速创建像素/数据集...`);
        try {
          const formData = new URLSearchParams();
          formData.append('name', pixelName);
          
          // 🚀 v21.0 优先尝试 adspixels，失败则尝试 datasets
          json = await callFacebookGraphApi(`${actId}/adspixels`, 'POST', formData, profile, effectiveToken);
          if (json.error && (json.error.message.includes('nonexisting field') || json.error.code === 100 || (json.error.code === 1 && json.error.message.includes('Invalid request')))) {
              log('INFO', `[Pixel] adspixels 接口不可用，尝试 datasets 接口...`);
              json = await callFacebookGraphApi(`${actId}/datasets`, 'POST', formData, profile, effectiveToken);
          }
        } catch (apiErr) {
          log('WARN', `API 快速创建失败: ${apiErr.message}，将尝试启动浏览器回退...`);
        }
      }

      // 💡 第二阶段：如果 API 失败或没有 Token，启动浏览器执行
      if (!json || !json.id) {
        log('INFO', `🤖 [浏览器模式] 正在启动/检查浏览器以执行像素创建...`);
        const result = await ensureBrowserIsRunning(profileId);
        if (result.success) {
          const browser = result.browserData.browser;
          const pages = await browser.pages();
          let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();
          
          if (!page.url().includes('facebook.com')) {
              await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
          }

          // 尝试从浏览器环境中获取最新的 Token 并执行 fetch
          log('INFO', `[Pixel] 正在浏览器环境执行创建脚本...`);
          json = await page.evaluate(async (actId, pName) => {
              const fetchToken = async () => {
                  try {
                      const resp = await fetch('https://www.facebook.com/adsmanager/manage/campaigns');
                      const text = await resp.text();
                      const match = text.match(/accessToken="([^"]+)"/);
                      return match ? match[1] : '';
                  } catch (e) { return ''; }
              };

              try {
                  let browserToken = await fetchToken();
                  if (!browserToken) throw new Error('无法从浏览器获取授权令牌，请确保已登录 Facebook');

                  const p = new URLSearchParams();
                  p.append('name', pName);
                  p.append('access_token', browserToken);
                  
                  // 🚀 v21.0 优先尝试 adspixels
                  let apiResp = await fetch(`https://graph.facebook.com/v21.0/${actId}/adspixels`, {
                      method: 'POST',
                      body: p
                  });
                  let res = await apiResp.json();
                  
                  // 🚀 如果 adspixels 不存在，尝试 datasets
                  if (res.error && (res.error.message.includes('nonexisting field') || res.error.code === 100)) {
                      apiResp = await fetch(`https://graph.facebook.com/v21.0/${actId}/datasets`, {
                          method: 'POST',
                          body: p
                      });
                      res = await apiResp.json();
                  }

                  // 🚀 核心逻辑：如果像素已存在 (#6200)，尝试获取现有像素
                  if (res.error && res.error.code === 6200) {
                      const listResp = await fetch(`https://graph.facebook.com/v21.0/${actId}/adspixels?fields=id,name&access_token=${browserToken}`);
                      const listJson = await listResp.json();
                      if (listJson.data && listJson.data.length > 0) {
                          return { ...listJson.data[0], _is_existing: true };
                      }
                      // 尝试 datasets 列表
                      const dsResp = await fetch(`https://graph.facebook.com/v21.0/${actId}/datasets?fields=id,name&access_token=${browserToken}`);
                      const dsJson = await dsResp.json();
                      if (dsJson.data && dsJson.data.length > 0) {
                          return { ...dsJson.data[0], _is_existing: true };
                      }
                  }
                  return res;
              } catch (err) {
                  return { error: { message: err.message } };
              }
          }, actId, pixelName);
        } else {
          throw new Error(`无法启动浏览器: ${result.error}`);
        }
      }

      // 🚀 如果 API 模式返回了"已存在"错误，也尝试获取
      if (json && json.error && json.error.code === 6200) {
          log('INFO', `[Pixel] API 模式检测到像素已存在，正在尝试获取现有像素 ID...`);
          try {
              let listJson = await callFacebookGraphApi(`${actId}/adspixels`, 'GET', { fields: 'id,name' }, profile, effectiveToken);
              if (listJson.data && listJson.data.length > 0) {
                  json = { ...listJson.data[0], _is_existing: true };
              } else {
                  listJson = await callFacebookGraphApi(`${actId}/datasets`, 'GET', { fields: 'id,name' }, profile, effectiveToken);
                  if (listJson.data && listJson.data.length > 0) {
                      json = { ...listJson.data[0], _is_existing: true };
                  }
              }
          } catch (e) { log('WARN', `获取现有像素失败: ${e.message}`); }
      }

      // 💡 第三阶段：处理结果并同步数据库
      if (json && json.id) {
        if (json._is_existing) {
            log('SUCCESS', `✅ [Profile=${profileId}] 检测到现有像素: ${json.id}`);
        } else {
            log('SUCCESS', `✅ [Profile=${profileId}] 像素创建成功: ${json.id}`);
        }
        try {
          const timestamp = new Date().toISOString();
          const pixelData = {
            id: `pixel_${json.id}`,
            pixel_id: json.id,
            name: pixelName,
            status: 'ACTIVE',
            account_id: adAccountId.replace(/^act_/, ''),
            profile_id: profileId
          };

          // 同步到本地 SQLite
          const sdb = await getSQLiteDb();
          if (sdb) {
              const stmt = sdb.prepare(`INSERT OR REPLACE INTO pixels (id, user_id, profile_id, pixel_id, name, status, account_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
              stmt.run([pixelData.id, 1, profileId, pixelData.pixel_id, pixelData.name, pixelData.status, pixelData.account_id, timestamp]);
              stmt.finalize();
          }

          // 同步到远程 D1
          const storageUrl = process.env.STORAGE_SERVER_URL || '';
          const apiSecret = process.env.PUPPETEER_API_SECRET || '';
          
          await fetch(`${storageUrl}/api/pixels/bulk-save`, {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'X-Api-Secret': apiSecret 
              },
              body: JSON.stringify({ items: [pixelData] })
          }).catch(err => log('WARN', `同步像素到远程失败: ${err.message}`));

        } catch (syncErr) {
          log('WARN', `同步新像素数据异常: ${syncErr.message}`);
        }

        // 🆕 自动把像素认领到 BM（POST /{business-id}/owned_pixels，body: pixel_id）。
        //    认领后该像素归这个 BM 所有 —— BM 里的管理员用户天然对它拥有完全控制权，
        //    这就是「创建像素时自动补上管理员权限」的官方接口路径。
        let claim = null;
        if (businessId && claimToBusiness !== false) {
          try {
            const claimRes = await callFacebookGraphApi(`${businessId}/owned_pixels`, 'POST', { pixel_id: String(json.id) }, profile, effectiveToken);
            if (claimRes && !claimRes.error) {
              claim = { success: true, message: `已认领到 BM ${businessId}${claimRes.access_status ? `（${claimRes.access_status}）` : ''}` };
            } else {
              claim = { success: false, message: claimRes?.error?.message || '认领失败' };
            }
          } catch (ce) {
            claim = { success: false, message: `认领异常: ${ce.message}` };
          }
          log(claim.success ? 'SUCCESS' : 'WARN', `[Pixel] ${claim.message} (pixel=${json.id}, bm=${businessId})`);
        }

        return res.json({ success: true, id: json.id, name: pixelName, ...(claim ? { claim } : {}) });
      } else {
        const errMsg = json?.error?.message || '像素创建最终失败';
        throw new Error(errMsg);
      }
    } catch (e) { 
      log('ERROR', `❌ 创建像素失败: ${e.message}`);
      return res.status(500).json({ success: false, message: String(e.message || e) }) 
    }
  })

  // ============================================================
  // 🚀 像素资产关系（Meta 官方 Business Asset Management「在商务管理平台之间共享 Pixel」）
  //   · 拉 BM 名下像素   GET  /{business-id}/owned_pixels
  //   · 认领到 BM        POST /{business-id}/owned_pixels   body: pixel_id
  //   · 分享给合作方 BM   POST /{ads_pixel}/agencies         body: business, permitted_tasks
  //   · 授权给广告号      POST /{ads_pixel}/shared_accounts  body: business, ad_account
  //   参考 https://developers.facebook.com/docs/business-management-apis/business-asset-management/guides/business-pixel-sharing
  //   ----
  //   ⚠️ 「把像素授给某个具体的人」官方没有 AdsPixel 级接口，只能走业务资产组的
  //      POST /{business_asset_group_id}/assigned_users（要求 BM 里先有资产组）。
  //      所以这里给的是「认领到 BM」——认领后 BM 的管理员天然拥有完全控制权。
  // ============================================================
  const _asIdList = (v) => (Array.isArray(v) ? v : [v])
    .map(x => String(x == null ? '' : x).trim())
    .filter(Boolean);

  // 统一的「取 profile + token」前置检查；失败时已写好响应，返回 null
  const _pixelCtx = async (req, res) => {
    const { profileId, accessToken } = req.body || {};
    if (!profileId) { res.status(400).json({ success: false, message: 'missing profileId' }); return null; }
    const profile = await findProfileById(profileId);
    const token = accessToken || profile?.account_tokens || profile?.token || '';
    if (!token) { res.status(400).json({ success: false, message: 'missing access token' }); return null; }
    return { profile, token };
  };

  // 拉取像素列表：给了 adAccountId 就列该广告号下的，否则列 BM 名下的
  _app.post('/api/facebook/pixels/list', async (req, res) => {
    try {
      const { businessId, adAccountId } = req.body || {};
      const ctx = await _pixelCtx(req, res);
      if (!ctx) return;
      let json;
      if (adAccountId) {
        const actId = String(adAccountId).replace(/^act_/, '');
        json = await callFacebookGraphApi(`${actId}/adspixels?fields=id,name&limit=100`, 'GET', null, ctx.profile, ctx.token);
        if (json?.error) json = await callFacebookGraphApi(`${actId}/datasets?fields=id,name&limit=100`, 'GET', null, ctx.profile, ctx.token);
      } else {
        if (!businessId) return res.status(400).json({ success: false, message: 'missing businessId/adAccountId' });
        json = await callFacebookGraphApi(`${businessId}/owned_pixels?fields=id,name&limit=100`, 'GET', null, ctx.profile, ctx.token);
      }
      if (json?.error) return res.json({ success: false, message: json.error.message || '拉取像素失败' });
      const pixels = (Array.isArray(json?.data) ? json.data : [])
        .map(p => ({ id: String(p.id || ''), name: String(p.name || '') }))
        .filter(p => p.id);
      return res.json({ success: true, count: pixels.length, pixels });
    } catch (e) {
      log('ERROR', `[Pixel] 拉取像素失败: ${e.message}`);
      return res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // 认领像素到 BM（BM 管理员随即可完全控制）
  _app.post('/api/facebook/pixels/claim-to-business', async (req, res) => {
    try {
      const { businessId, pixelIds } = req.body || {};
      const ctx = await _pixelCtx(req, res);
      if (!ctx) return;
      if (!businessId) return res.status(400).json({ success: false, message: 'missing businessId' });
      const ids = _asIdList(pixelIds);
      if (!ids.length) return res.status(400).json({ success: false, message: 'missing pixelIds' });

      const results = [];
      for (const pid of ids) {
        try {
          const r = await callFacebookGraphApi(`${businessId}/owned_pixels`, 'POST', { pixel_id: pid }, ctx.profile, ctx.token);
          if (r && !r.error) {
            results.push({ pixelId: pid, status: 'success', message: `已认领${r.access_status ? `（${r.access_status}）` : ''}` });
          } else {
            results.push({ pixelId: pid, status: 'error', message: r?.error?.message || '认领失败' });
          }
        } catch (e) {
          results.push({ pixelId: pid, status: 'error', message: e.message });
        }
      }
      const ok = results.filter(r => r.status === 'success').length;
      log('INFO', `[Pixel] 认领到 BM ${businessId}: ${ok}/${ids.length} 成功`);
      return res.json({ success: ok > 0, message: `认领完成: ${ok}/${ids.length} 成功`, results });
    } catch (e) {
      log('ERROR', `[Pixel] 认领异常: ${e.message}`);
      return res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // 把像素分享给合作方 BM（agency）：POST /{ads_pixel}/agencies
  // 可能直接生效，也可能返回 pending_request_id（等对方 BM 接受）
  _app.post('/api/facebook/pixels/share-to-partner', async (req, res) => {
    try {
      const { partnerBusinessId, pixelIds, tasks } = req.body || {};
      const ctx = await _pixelCtx(req, res);
      if (!ctx) return;
      if (!partnerBusinessId) return res.status(400).json({ success: false, message: 'missing partnerBusinessId' });
      const ids = _asIdList(pixelIds);
      if (!ids.length) return res.status(400).json({ success: false, message: 'missing pixelIds' });
      const permitted = (Array.isArray(tasks) && tasks.length ? tasks : ['ANALYZE', 'UPLOAD', 'ADVERTISE']);

      const results = [];
      for (const pid of ids) {
        try {
          const r = await callFacebookGraphApi(`${pid}/agencies`, 'POST', {
            business: String(partnerBusinessId),
            permitted_tasks: JSON.stringify(permitted),
          }, ctx.profile, ctx.token);
          if (r && !r.error) {
            results.push({
              pixelId: pid,
              status: 'success',
              pending: !!r.pending_request_id,
              message: r.pending_request_id ? `已发出共享协议，待对方接受（${r.pending_request_id}）` : '已分享',
            });
          } else {
            results.push({ pixelId: pid, status: 'error', message: r?.error?.message || '分享失败' });
          }
        } catch (e) {
          results.push({ pixelId: pid, status: 'error', message: e.message });
        }
      }
      const ok = results.filter(r => r.status === 'success').length;
      log('INFO', `[Pixel] 分享给合作方 BM ${partnerBusinessId}: ${ok}/${ids.length} 成功（权限 ${permitted.join('/')}）`);
      return res.json({ success: ok > 0, message: `分享完成: ${ok}/${ids.length} 成功`, results });
    } catch (e) {
      log('ERROR', `[Pixel] 分享异常: ${e.message}`);
      return res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // 把像素授权给广告号（广告号才能用这个像素投放）：POST /{ads_pixel}/shared_accounts
  _app.post('/api/facebook/pixels/assign-to-adaccounts', async (req, res) => {
    try {
      const { businessId, pixelIds, adAccountIds } = req.body || {};
      const ctx = await _pixelCtx(req, res);
      if (!ctx) return;
      if (!businessId) return res.status(400).json({ success: false, message: 'missing businessId（必须是同时能访问该像素和广告号的 BM）' });
      const pixels = _asIdList(pixelIds);
      const acts = _asIdList(adAccountIds).map(a => a.replace(/^act_/, ''));
      if (!pixels.length) return res.status(400).json({ success: false, message: 'missing pixelIds' });
      if (!acts.length) return res.status(400).json({ success: false, message: 'missing adAccountIds' });

      const results = [];
      for (const pid of pixels) {
        for (const actId of acts) {
          try {
            const r = await callFacebookGraphApi(`${pid}/shared_accounts`, 'POST', {
              business: String(businessId),
              ad_account: actId,
            }, ctx.profile, ctx.token);
            if (r && !r.error) results.push({ pixelId: pid, adAccountId: actId, status: 'success', message: '已关联' });
            else results.push({ pixelId: pid, adAccountId: actId, status: 'error', message: r?.error?.message || '关联失败' });
          } catch (e) {
            results.push({ pixelId: pid, adAccountId: actId, status: 'error', message: e.message });
          }
        }
      }
      const ok = results.filter(r => r.status === 'success').length;
      log('INFO', `[Pixel] 像素授权给广告号(BM ${businessId}): ${ok}/${results.length} 成功`);
      return res.json({ success: ok > 0, message: `关联完成: ${ok}/${results.length} 成功`, results });
    } catch (e) {
      log('ERROR', `[Pixel] 授权广告号异常: ${e.message}`);
      return res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // ============================================================
  // 🚀 抓取页面分类 ID
  // ============================================================
  _app.post('/api/facebook/pages/categories', async (req, res) => {
    try {
      const { profileId } = req.body || {};
      if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });

      log('INFO', `[PageCategories] 开始抓取分类: profileId=${profileId}`);

      const actualProfile = await findProfileById(profileId);
      if (!actualProfile) return res.status(404).json({ success: false, message: 'profile_not_found' });

      let browser, page;
      const existing = _activeBrowsers.get(profileId);
      if (existing && existing.browser && existing.browser.isConnected()) {
        browser = existing.browser;
        const pages = await browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();
      } else {
        const lr = await fetch(`http://127.0.0.1:${_PORT}/api/launch-browser`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': _API_SECRET },
          body: JSON.stringify({ profileId, profile: actualProfile, proxy: actualProfile.proxy, startUrls: ['https://www.facebook.com/pages/create'], strictStartUrls: false, skipStartUrls: true })
        });
        const lj = await lr.json().catch(() => ({}));
        if (!lj.success) return res.status(500).json({ success: false, message: lj.message || 'browser_launch_failed' });
        // 🐛 与 CreateBM 同因：launch-browser 命中防重入 duplicate 时浏览器还在冷启动，
        //    固定睡 5 秒查一次会误报 browser_not_ready → 轮询等待真正就绪（最长 45s）
        let entry = null;
        for (let i = 0; i < 45; i++) {
          const cur = _activeBrowsers.get(profileId);
          if (cur && cur.browser && cur.browser.isConnected()) { entry = cur; break; }
          await sleep(1000);
        }
        if (!entry) return res.status(500).json({ success: false, message: 'browser_not_ready' });
        browser = entry.browser;
        page = await browser.newPage();
      }

      // 导航到创建页面
      await page.goto('https://www.facebook.com/pages/create', { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
      await sleep(5000);

      // 尝试点击"开始"按钮进入分类选择
      try {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
          for (const b of btns) {
            const t = (b.textContent || '').trim().toLowerCase();
            if (t.includes('开始') || t.includes('get started') || t.includes('继续') || t.includes('continue')) {
              b.click(); return;
            }
          }
        });
        await sleep(3000);
      } catch {}

      // 提取分类列表
      const categories = await page.evaluate(() => {
        const results = [];
        // 策略1: 查找 select/option
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.querySelectorAll('option')) {
            const val = opt.value?.trim();
            const txt = (opt.textContent || '').trim();
            if (val && txt && val !== '' && !/^[\s-]+$/.test(val)) results.push({ id: val, name: txt });
          }
        }
        // 策略2: 查找 role=listbox + role=option
        if (results.length === 0) {
          const listboxes = document.querySelectorAll('[role="listbox"]');
          for (const lb of listboxes) {
            for (const opt of lb.querySelectorAll('[role="option"]')) {
              const val = opt.getAttribute('data-value') || opt.getAttribute('value') || '';
              const txt = (opt.textContent || '').trim();
              if (txt && (val || txt)) results.push({ id: val, name: txt });
            }
          }
        }
        // 策略3: 查找所有按钮组的 data 属性
        if (results.length === 0) {
          const allEls = document.querySelectorAll('[data-page-category-id], [data-category-id]');
          for (const el of allEls) {
            const id = el.getAttribute('data-page-category-id') || el.getAttribute('data-category-id') || '';
            const txt = (el.textContent || '').trim();
            if (id && txt) results.push({ id, name: txt });
          }
        }
        // 策略4: 从页面源码中提取 JSON 数据
        if (results.length === 0) {
          const text = document.body.innerText || '';
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          const seen = new Set();
          for (const line of lines) {
            // 尝试匹配 "数字 文本" 或 "分类名"
            const m = line.match(/^(\d{3,5})\s+(.+)/);
            if (m && !seen.has(m[1])) { seen.add(m[1]); results.push({ id: m[1], name: m[2] }); }
          }
        }
        return results;
      }).catch(() => []);

      log('INFO', `[PageCategories] 提取到 ${categories.length} 个分类`);
      return res.json({ success: true, count: categories.length, categories });
    } catch (e) {
      log('ERROR', `[PageCategories] 异常: ${e.message}`);
      return res.status(500).json({ success: false, message: e.message });
    }
  });

  // ============================================================
  // 🚀 创建主页（浏览器 UI 模式）
  // ============================================================
  // 🔒 同配置创建串行闸门（与 CreateBM 的 _enterCreateBmGate 同因同构）：
  //    同 profile 的多个创建请求并发复用一台浏览器会互踩（pages[0] 导航竞争 + shouldClose 互相关闭）。
  //    返回 null 表示排队超时/客户端断开，调用方应直接返回；否则返回 release（幂等）。
  //    ⚠️ 释放点在 handler 最外层 finally（不能在 attempt 重试循环内释放，重试仍需持锁）。
  const _createPageGates = new Map();
  function _enterCreatePageGate(profileId, res, waitMs = 420000) {
    const key = String(profileId);
    const prev = Promise.resolve(_createPageGates.get(key)).catch(() => {});
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    _createPageGates.set(key, prev.then(() => gate));
    let abandoned = false;
    const timer = setTimeout(() => { abandoned = true; releaseGate(); }, waitMs);
    return prev.then(() => {
      clearTimeout(timer);
      if (abandoned || res.destroyed) { releaseGate(); return null; }
      return releaseGate;
    });
  }
  _app.post('/api/facebook/pages/create', async (req, res) => {
    // ⚠️ 必须在 try 之前声明：外层 finally 会引用它，而 gate 前的提前 return（参数校验/404）
    //    也会执行 finally —— const 的 TDZ 下连 typeof 都会抛 ReferenceError
    let releaseGateOnce = null;
    try {
      const { profileId, name, category, proxyOverride } = req.body || {};
      if (!profileId || !name) return res.status(400).json({ success: false, message: 'missing profileId/name' });

      log('INFO', `[CreatePage] 开始: profileId=${profileId}, name=${name}${proxyOverride ? ', 使用代理覆盖' : ''}`);

      const actualProfile = await findProfileById(profileId);
      if (!actualProfile) return res.status(404).json({ success: false, message: 'profile_not_found' });

      // 🔒 排队等本配置的浏览器使用权。⚠️ 释放点必须在 handler 最外层 finally：
      //    不能挂 res close/finish —— 客户端断开（队列 abort）时主体还在跑浏览器 UI 自动化，
      //    提前放行会让下一个任务复用「正在使用中」的浏览器 → 互踩复活。
      //    attempt 重试循环内也不能释放（重试仍需持锁）。
      const releaseGate = await _enterCreatePageGate(profileId, res);
      if (!releaseGate) return res.status(409).json({ success: false, message: '同配置创建主页排队超时，请稍后重试' });
      let gateReleased = false;
      releaseGateOnce = () => { if (!gateReleased) { gateReleased = true; try { releaseGate(); } catch {} } };

      if (proxyOverride) actualProfile.proxy = proxyOverride;

      let browser, page, shouldClose = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt > 1) {
          log('WARN', `[CreatePage] 浏览器断开，重新执行整个任务 (第${attempt}次)...`);
          if (browser) try { await browser.close(); } catch {}
          browser = null; page = null; shouldClose = false;
          await sleep(2000);
        }
        try {
        const existing = _activeBrowsers.get(profileId);
        if (existing && existing.browser && existing.browser.isConnected()) {
          log('INFO', `[CreatePage] 复用已运行的浏览器: ${profileId}`);
          browser = existing.browser;
          const pages = await browser.pages();
          page = pages.length > 0 ? pages[0] : await browser.newPage();
        } else {
          const hdrs = { 'Content-Type': 'application/json' };
          if (req.headers['authorization']) hdrs['Authorization'] = req.headers['authorization'];
          if (req.headers['x-api-secret']) hdrs['X-Api-Secret'] = req.headers['x-api-secret'];
          const lr = await fetch(`http://127.0.0.1:${_PORT}/api/launch-browser`, {
            method: 'POST', headers: hdrs,
            body: JSON.stringify({ profileId, profile: actualProfile, proxy: actualProfile.proxy, startUrls: ['https://www.facebook.com/'], strictStartUrls: true, skipStartUrls: false })
          });
          const lj = await lr.json().catch(() => ({}));
          if (!lj.success) return res.status(500).json({ success: false, message: lj.message || 'browser_launch_failed' });
          // 🐛 与 CreateBM 同因：launch-browser 命中防重入 duplicate 时浏览器还在冷启动，
          //    固定睡 2 秒查一次会误报 browser_launch_failed_no_page → 轮询等待真正就绪（最长 45s）
          let entry = null;
          for (let i = 0; i < 45; i++) {
            const cur = _activeBrowsers.get(profileId);
            if (cur && cur.browser && cur.browser.isConnected()) { entry = cur; break; }
            await sleep(1000);
          }
          if (!entry) return res.status(500).json({ success: false, message: 'browser_launch_failed_no_page' });
          browser = entry.browser;
          const pages = await browser.pages();
          page = pages.length > 0 ? pages[0] : await browser.newPage();
          shouldClose = true;
        }

        if (!page.url().includes('facebook.com')) {
          await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          await sleep(2000);
        }

        // 🔁 token 提取：刚启动的浏览器里 localStorage 可能还没来得及写入 token。
        //    实测「浏览器启动成功 1.7s 后」就抓会拿到空串 → 直接 400 missing_token（profileId=4335）。
        //    所以第一次抓不到时先 reload 等一会儿再抓一次，别急着失败。
        const extractBrowserToken = async () => {
          try {
            const t = await page.evaluate(() => {
              const w = window;
              const keys = Object.keys(localStorage);
              for (const k of keys) {
                try {
                  const v = localStorage.getItem(k);
                  if (v && (v.startsWith('EAAB') || v.startsWith('EAA'))) return v;
                  const p = JSON.parse(v);
                  if (p && typeof p === 'object')
                    for (const sk of Object.keys(p)) if (String(p[sk]).startsWith('EA')) return p[sk];
                } catch {}
              }
              if (w.__accessToken && String(w.__accessToken).startsWith('EA')) return w.__accessToken;
              return '';
            }).catch(() => '');
            return t || '';
          } catch { return ''; }
        };
        let browserToken = await extractBrowserToken();
        if (!browserToken) {
          log('WARN', `[CreatePage] 页面里没提取到 token，reload 后重试一次 (profileId=${profileId})`);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await sleep(3000);
          browserToken = await extractBrowserToken();
        }
        const profileToken = String(actualProfile.account_tokens || actualProfile.token || '').trim();
        const token = browserToken || profileToken;
        if (!token) {
          log('WARN', `[CreatePage] 缺少 access token: 浏览器=${browserToken ? '有' : '无'}, 配置记录=${profileToken ? '有' : '无'} (profileId=${profileId})`);
          return res.status(400).json({
            success: false,
            message: 'missing_token：浏览器里和配置记录里都没有 access token。请先让该配置登录一次，或先跑一次「获取信息」把 token 刷新出来',
          });
        }

        // 🚀 在 Graph API 调用前验证 Token 有效性，失效则从页面重新提取
        let validToken = token;
        try {
          const checkToken = await safePageEvaluate(page, async (t) => {
            try {
              const r = await fetch(`https://graph.facebook.com/v21.0/me?fields=id&access_token=${t}`);
              const data = await r.json();
              if (data && !data.error) return { valid: true, token: t };
              // Token 失效，尝试从 localStorage 提取
              let found = '';
              try {
                for (let i = 0; i < localStorage.length; i++) {
                  const k = localStorage.key(i);
                  const v = localStorage.getItem(k) || '';
                  if (v && (v.startsWith('EAAB') || v.startsWith('EAA') || v.startsWith('EAAG'))) { found = v; break; }
                  try { const p = JSON.parse(v); if (p && typeof p === 'object') for (const sk of Object.keys(p)) if (String(p[sk]).startsWith('EA')) { found = p[sk]; break; } } catch {}
                  if (found) break;
                }
                if (!found) { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); const v = sessionStorage.getItem(k) || ''; if (v && (v.startsWith('EAAB') || v.startsWith('EAAG'))) { found = v; break; } } }
              } catch {}
              if (found) {
                const c = await fetch(`https://graph.facebook.com/v21.0/me?fields=id&access_token=${found}`);
                const d = await c.json();
                if (d && !d.error) return { valid: true, token: found };
              }
              return { valid: false, token: t };
            } catch { return { valid: false, token: t }; }
          }, token);
          if (checkToken.valid && checkToken.token !== token) {
            validToken = checkToken.token;
            log('INFO', `[CreatePage] Token 已刷新: ${token.slice(0,10)}... → ${validToken.slice(0,10)}...`);
          } else if (!checkToken.valid) {
            log('WARN', `[CreatePage] Token 已失效，尝试重新获取... (${token.slice(0,10)}...)`);
            // 导航到 Facebook 首页触发自动登录（Cookie 还在），然后重新提取 Token
            try {
              await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
              await sleep(5000);
              const newToken = await safePageEvaluate(page, () => {
                try {
                  let t = '';
                  for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    const v = localStorage.getItem(k) || '';
                    if (v && (v.startsWith('EAAB') || v.startsWith('EAAG') || v.startsWith('EAA'))) { t = v; break; }
                  }
                  if (!t) {
                    for (let i = 0; i < sessionStorage.length; i++) {
                      const k = sessionStorage.key(i);
                      const v = sessionStorage.getItem(k) || '';
                      if (v && (v.startsWith('EAAB') || v.startsWith('EAAG') || v.startsWith('EAA'))) { t = v; break; }
                    }
                  }
                  if (t) {
                    return fetch(`https://graph.facebook.com/v21.0/me?fields=id&access_token=${t}`).then(r => r.json()).then(d => d && !d.error ? t : '');
                  }
                  return '';
                } catch { return ''; }
              });
              if (newToken) {
                validToken = newToken;
                log('INFO', `[CreatePage] Token 重新获取成功: ${newToken.slice(0,10)}...`);
              } else {
                log('WARN', `[CreatePage] 重新获取 Token 失败，继续尝试 (${token.slice(0,10)}...)`);
              }
            } catch (refreshErr) {
              log('WARN', `[CreatePage] 重新获取 Token 异常: ${refreshErr.message}`);
            }
          } else {
            log('INFO', `[CreatePage] Token 有效 (${token.slice(0,10)}...)`);
          }
        } catch (checkErr) {
          log('WARN', `[CreatePage] Token 校验异常: ${checkErr.message}`);
        }

        // 🚀 优先使用浏览器 session 发送 GraphQL（跟绑卡/改账单一样），不行再退到手动输入
        // 🚀 检查该 Profile 是否之前 GraphQL field_exception 失败过，是则直接跳过，走手动创建
        if (_profileGraphqlFailCache.has(String(profileId))) {
          log('WARN', `[CreatePage] Profile=${profileId} 之前 GraphQL field_exception 失败，跳过 GraphQL 直接手动创建`);
        } else {
        log('INFO', `[CreatePage] 尝试 GraphQL 创建: name=${name}`);

        // 设置 CDP 监听拦截响应
        let cdpSession = null;
        let capturedPageId = '';
        try {
          cdpSession = await page.target().createCDPSession();
          await cdpSession.send('Network.enable');
          cdpSession.on('Network.responseReceived', async params => {
            if (capturedPageId) return;
            const r = params.response;
            if (params.requestId && r.status >= 200 && r.status < 400 && r.url.includes('graphql')) {
              try {
                const body = await cdpSession.send('Network.getResponseBody', { requestId: params.requestId });
                if (body && body.body) {
                  if (body.body.includes('additional_profile_plus_create') || body.body.includes('additional_profile_plus_creation') || body.body.includes('profile_plus')) {
                    const idMatch = body.body.match(/"id"\s*:\s*"(\d+)"/);
                    if (idMatch) { capturedPageId = idMatch[1]; log('INFO', `[CreatePage] CDP 捕获到主页 ID: ${capturedPageId}`); }
                  }
                }
              } catch {}
            }
          });
        } catch { log('WARN', `[CreatePage] CDP 初始化失败`); }

        // 🚀 在新标签页快速导航到 pages/create 提取 doc_id（当前页没有创建页的 script）
        let dynamicDocId = '';
        try {
          const docPage = await browser.newPage();
          try {
            await docPage.goto('https://www.facebook.com/pages/create', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(3000);
            dynamicDocId = await safePageEvaluate(docPage, () => {
              const scripts = Array.from(document.querySelectorAll('script'));
              for (const s of scripts) {
                const html = s.innerHTML || '';
                if (html.includes('AdditionalProfilePlusCreate') || html.includes('additional_profile_plus_create')) {
                  const m = html.match(/doc_id["']?\s*[:=]\s*["']?(\d{10,})["']?/);
                  if (m) return m[1];
                }
              }
              return '';
            }).catch(() => '');
          } catch {}
          await docPage.close().catch(() => {});
        } catch {}
        if (!dynamicDocId) { dynamicDocId = '23863457623296585'; log('WARN', `[CreatePage] 未获取到动态 doc_id，使用硬编码`); }
        else log('INFO', `[CreatePage] 动态 doc_id 提取成功: ${dynamicDocId}`);

        // 🚀 用 page.content() 提取 session（不依赖 JS 执行）
        log('INFO', `[CreatePage] 提取 session...`);
        await sleep(4000);

        let fbDtsg = '';
        let userId = '';
        try {
          const pageHtml = await page.content();
          // 从 cookie 提取 userId
          const cookieMatch = pageHtml.match(/c_user=(\d+)/);
          if (cookieMatch) userId = cookieMatch[1];
          // 从 DTSGInitialData 提取 fbDtsg
          const d1 = pageHtml.match(/DTSGInitialData[^}]+"token":"([^"]+)"/);
          if (d1) fbDtsg = d1[1];
          // 降级：传统 dtsg 格式
          if (!fbDtsg) { const d2 = pageHtml.match(/"dtsg":\{"token":"([^"]+)"/); if (d2) fbDtsg = d2[1]; }
          // 降级：data-store 属性
          if (!fbDtsg) {
            const dsRe = /data-store=["']([^"']*dtsg[^"']*)["']/g;
            let m; while ((m = dsRe.exec(pageHtml)) !== null) {
              try { const store = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#34;/g, '"'));
                if (store.dtsg) { fbDtsg = store.dtsg; break; }
                if (store.DTSGInitialData?.token) { fbDtsg = store.DTSGInitialData.token; break; }
              } catch {}
            }
          }
          if (!userId) { const u = pageHtml.match(/"USER_ID":"(\d+)"/) || pageHtml.match(/"userID":"(\d+)"/); if (u) userId = u[1]; }
        } catch (contentErr) {
          log('WARN', `[CreatePage] page.content 提取 session 失败: ${contentErr.message}`);
        }
        const sessionData = { fbDtsg: fbDtsg || '', userId };
        log('INFO', `[CreatePage] session: userId=${sessionData.userId}, fbDtsg=${sessionData.fbDtsg ? '✅' : '❌'}`);
        if (!sessionData.fbDtsg) throw new Error('missing fb_dtsg');

        // 🚀 通过浏览器请求拦截发送 GraphQL POST（浏览器自动带 Cookie + 走代理）
        const catNum = '2214'; // Health/Beauty
        let result = null;
        try {
          const gqlPage = await browser.newPage();
          try {
            await gqlPage.setRequestInterception(true);
            const bodyStr = new URLSearchParams({
              doc_id: dynamicDocId,
              fb_dtsg: sessionData.fbDtsg,
              __user: sessionData.userId,
              __a: '1',
              fb_api_req_friendly_name: 'AdditionalProfilePlusCreationMutation',
              fb_api_caller_class: 'comet',
              variables: JSON.stringify({
                input: {
                  bio: '',
                  categories: [String(catNum)],
                  creation_source: 'comet',
                  name: name,
                  off_platform_creator_reachout_id: null,
                  page_referrer: null,
                  actor_id: sessionData.userId,
                  client_mutation_id: '1'
                }
              })
            }).toString();

            const gqlResultPromise = new Promise((resolve, reject) => {
              let handled = false;
              const timeout = setTimeout(() => { if (!handled) { handled = true; reject(new Error('GraphQL response timeout')); } }, 30000);

              gqlPage.on('request', (req) => {
                const url = req.url();
                if (url.includes('/api/graphql/') || url.includes('graphql')) {
                  const origHeaders = req.headers();
                  req.continue({
                    method: 'POST',
                    postData: bodyStr,
                    headers: { ...origHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }
                  });
                } else {
                  req.continue();
                }
              });

              gqlPage.on('response', async (resp) => {
                if (handled) return;
                const url = resp.url();
                if (url.includes('/api/graphql/') || url.includes('graphql')) {
                  try {
                    const text = await resp.text();
                    if (!text || text.length < 10) return;
                    let clean = text;
                    while (clean.length > 0) {
                      const prev = clean.length;
                      if (clean.startsWith('for ') || clean.startsWith('for(') || clean.startsWith('while ') || clean.startsWith('while(')) {
                        const si = clean.indexOf(';'); if (si > 0 && si < 30) { clean = clean.substring(si + 1); continue; }
                      }
                      if (clean.startsWith(';') || clean.startsWith(')') || clean.startsWith('(')) { clean = clean.substring(1); continue; }
                      break;
                    }
                    const parsed = JSON.parse(clean);
                    if (!handled) { handled = true; clearTimeout(timeout); resolve(parsed); }
                  } catch { /* 非 GraphQL 响应或解析失败，忽略 */ }
                }
              });
            });

            await gqlPage.goto('https://www.facebook.com/api/graphql/', {
              waitUntil: 'domcontentloaded', timeout: 25000
            }).catch(() => {});
            result = await gqlResultPromise;
          } finally {
            await gqlPage.close().catch(() => {});
          }
        } catch (gqlErr) {
          log('WARN', `[CreatePage] GraphQL 拦截请求失败: ${gqlErr.message}`);
        }

          if (result) {
            const pageId = capturedPageId ||
              result?.data?.additional_profile_plus_create?.page?.id ||
              result?.data?.additional_profile_plus_creation?.profile_plus?.page?.id ||
              result?.data?.additional_profile_plus_creation?.page?.id ||
              result?.data?.page_create?.page?.id;
            if (pageId) {
              log('SUCCESS', `[CreatePage] ✅ GraphQL 创建成功: id=${pageId}`);
              // 同步
              postOperationSync(profileId, validToken || token, { syncPages: true, syncPixels: false, syncAdAccounts: false }).catch(() => {});
              return res.json({ success: true, method: 'graphql', pageId, name, message: 'GraphQL 创建成功' });
            } else {
              log('WARN', `[CreatePage] GraphQL 返回无 pageId: ${JSON.stringify(result).substring(0,300)}`);
            }
          } else {
            log('WARN', `[CreatePage] GraphQL 返回空`);
          }

          // 🏷️ 如果 GraphQL 失败原因是 field_exception（code 16750），记录此 Profile 跳过后续重试
          if (result?.errors?.some(e => e.code === 16750)) {
            _profileGraphqlFailCache.add(String(profileId));
            log('WARN', `[CreatePage] 检测到 field_exception (code=16750)，已记录 profileId=${profileId}，后续跳过 GraphQL`);
          }
        } // 🚀 结束 GraphQL else 块

        // 🚀 降级：手动输入
        log('INFO', `[CreatePage] 开始手动创建: name=${name}`);

        // 1. 直接输入主页名称（光标已在输入框，无需查找点击）
        log('INFO', `[CreatePage] 输入名称: ${name}`);
        await sleep(1000);
        await page.keyboard.type(name, { delay: 50 });
        log('INFO', `[CreatePage] 名称输入完成`);
        
        // 2. 类别 — Tab x2 → type → ArrowDown → Enter
        let catName = category || 'Business';
        // 🚀 检测页面语言，中文页面用中文类别名
        let pageLang = 'en';
        try { pageLang = await page.evaluate(() => document.documentElement.lang || 'en').catch(() => 'en'); } catch {}
        const catLangMap = {
          'Health/Beauty': { zh: '保健/美容', en: 'Health/Beauty', es: 'Salud/Belleza' },
          'Health/beauty': { zh: '保健/美容', en: 'Health/beauty', es: 'Salud/Belleza' },
          '健康/美容': { zh: '保健/美容', en: 'Health/Beauty', es: 'Salud/Belleza' },
          '保健/美容': { zh: '保健/美容', en: 'Health/Beauty', es: 'Salud/Belleza' },
          'Personal Blog': { zh: '个人博客', en: 'Personal Blog', es: 'Blog personal' },
          '个人博客': { zh: '个人博客', en: 'Personal Blog', es: 'Blog personal' },
          'Business': { zh: '商业', en: 'Business', es: 'Negocio' },
          '商业': { zh: '商业', en: 'Business', es: 'Negocio' },
        };
        const langCode = pageLang.startsWith('zh') ? 'zh' : pageLang.startsWith('es') ? 'es' : 'en';
        if (catLangMap[catName]) {
          catName = catLangMap[catName][langCode] || catLangMap[catName]['en'] || catName;
        }
        log('INFO', `[CreatePage] 填写类别: ${catName} (lang=${pageLang})`);

        await sleep(1000);
        await page.keyboard.press('Tab');
        await sleep(500);
        await page.keyboard.press('Tab');
        await sleep(800);

        // 检查焦点
        const focusOk = await page.evaluate(() => {
          const a = document.activeElement;
          return a && (a.tagName==='INPUT' || a.getAttribute('role')==='combobox' || a.getAttribute('aria-autocomplete')==='list');
        });

        if (focusOk) {
          await page.keyboard.type(catName, { delay: 80 });
          await sleep(3000);
          await page.keyboard.press('ArrowDown');
          await sleep(1000);
          await page.keyboard.press('Enter');
          log('INFO', `[CreatePage] 类别选择完成`);
          await sleep(1500);
        } else {
          log('WARN', `[CreatePage] Tab 未聚焦到类别框，尝试直接定位`);
          const catSel = await page.evaluate(() => {
            const s = ['input[aria-label*="Category"i]','input[aria-label*="类别"i]','input[role="combobox"]'];
            for (const x of s) { const e = document.querySelector(x); if (e && e.offsetParent!==null) return x; }
            return null;
          });
          if (catSel) {
            await page.click(catSel, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(catSel, catName, { delay: 80 });
            await sleep(3000);
            await page.keyboard.press('ArrowDown');
            await sleep(1000);
            await page.keyboard.press('Enter');
          }
        }

        // 3. 点击创建按钮
        // 便携版流程：类别选择后 Tab x2 + Enter 提交
        await sleep(1500);
        await page.keyboard.press('Tab');
        await sleep(500);
        await page.keyboard.press('Tab');
        await sleep(1000);
        await page.keyboard.press('Enter');
        log('INFO', `[CreatePage] 已执行 Tabx2+Enter 提交`);

        // 或者尝试直接点 Create Page 按钮
        await sleep(3000);
        const btnClicked = await page.evaluate(() => {
          const all = document.querySelectorAll('div[role="button"], button');
          // 🐛 修复：改用 includes 模糊匹配 + 多组关键词 + 可见性检查
          const patterns = [
            ['create page', 'create', '创建主页', '创建'],
            ['next', '下一步', 'continue', '继续', 'save', '保存']
          ];
          // 先优先弹窗内的按钮
          const dlg = document.querySelector('[role="dialog"]');
          const scope = dlg ? [dlg] : [document];
          for (const s of scope) {
            const btns = Array.from(s.querySelectorAll('div[role="button"], button'));
            for (const p of patterns) {
              for (const el of btns) {
                const t = (el.textContent||'').toLowerCase().trim();
                const aria = (el.getAttribute('aria-label')||'').toLowerCase().trim();
                const combined = t + ' ' + aria;
                if (p.some(k => combined.includes(k)) && el.offsetParent !== null) {
                  try { el.click(); return true; } catch {}
                }
              }
            }
          }
          return false;
        });
        log('INFO', `[CreatePage] 创建按钮点击: ${btnClicked ? '✅' : '❌'}`);

        // 4. 处理多步骤向导（便携版已验证）
        log('INFO', `[CreatePage] 处理后续步骤...`);
        let isFinal = false;
        for (let step = 0; step < 15; step++) {
          await sleep(3000);
          const url = page.url();
          if (url.includes('/pages/admin/') || url.includes('/latest/home') || url.includes('/pages/')) {
            isFinal = true; break;
          }
          const stepOk = await page.evaluate(() => {
            const labels = ['下一步','Next','继续','Continue','完成','Done','保存','Save','跳过','Skip'];
            const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
            for (const b of btns) {
              const t = (b.textContent||'').trim();
              if (labels.some(l => t.includes(l)) && b.offsetParent!==null) { b.click(); return true; }
            }
            return false;
          });
          if (!stepOk) {
            await page.keyboard.press('Enter'); await sleep(2000);
          }
        }
        log('INFO', `[CreatePage] 向导完成, isFinal=${isFinal}, url=${page.url()}`);

        // 5. 提取页面 ID（可选，创建成功即可）
        let finalPageId = '';
        try {
          const u = page.url();
          const m1 = u.match(/facebook\.com\/(\d+)/);
          if (m1) finalPageId = m1[1];
          else {
            const m2 = u.match(/facebook\.com\/([A-Za-z][A-Za-z0-9._-]{2,})(?:\?|$)/);
            if (m2 && !['pages','creation','create','login','checkpoint','me'].includes(m2[1])) finalPageId = m2[1];
          }
          if (!finalPageId) {
            finalPageId = await page.evaluate(() => {
              const a = document.querySelector('a[href*="page.php"]');
              return a?.getAttribute('href')?.match(/id=(\d+)/)?.[1] || location.href.match(/page_id=(\d+)/)?.[1] || '';
            }).catch(() => '');
          }
        } catch {}

        if (finalPageId) {
          log('SUCCESS', `[CreatePage] ✅ 创建成功: id=${finalPageId}`);
        } else if (capturedPageId) {
          finalPageId = capturedPageId;
          log('SUCCESS', `[CreatePage] ✅ CDP 捕获创建成功: id=${finalPageId}`);
        } else {
          log('INFO', `[CreatePage] ✅ 创建成功（未提取页面 ID）`);
        }
        // 🚀 每次创建成功都触发同步，确保新建的主页被保存到数据库
        postOperationSync(profileId, token, { syncPages: true, syncPixels: false, syncAdAccounts: false }).catch(() => {});
        return res.json({ success: true, method: 'browser_ui', pageId: finalPageId });
      } catch (e) {
          const isBrowserDead = /Session closed|detached Frame|Protocol error|Target closed/i.test(e && e.message);
          if (isBrowserDead && attempt < 2) { continue; }
          throw e;
        } finally {
          if (shouldClose && browser) try { await browser.close(); } catch {}
        }
        break; // 🚀 成功退出重试循环
      }
    } catch (e) { log('ERROR', `[CreatePage] 异常: ${e.message || e}`); return res.status(500).json({ success: false, message: String(e.message || e) }) } finally {
      // 🔒 归还本配置的浏览器使用权：handler 任何出口（成功/失败/异常）都必经这里，
      //    保证「锁保持到浏览器使用段结束」，不会因客户端断开而提前放行
      if (releaseGateOnce) releaseGateOnce();
    }
  });
}

module.exports = { __inject, registerRoutes };
