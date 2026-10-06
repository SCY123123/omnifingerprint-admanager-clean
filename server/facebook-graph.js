'use strict';

const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

// Shared dependencies (injected)
let _log = () => {};
let _logInjected = false;
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _isProfileRunning = null;
let _ensureBrowserIsRunning = null;
let _findProfileById = null;
let _autoFillPasswordOnPage = null;
let _parseProxy = null;
let _directConnectionFailures = null;
let _S5_TUNNEL_PORT = 10808;
let _getDb = () => null;
// 🚀 宿主机注入的「重新获取并保存 Token」回调（等价于界面上的「获取TOKEN」按钮）
let _refreshProfileToken = null;
// 🍪 宿主机注入的「取该配置的会话 Cookie」回调（给 curl 通道用，见下方 curl 处的说明）
let _getProfileCookies = null;
// 🔐 宿主机注入的「标记本轮登录态」回调。190 一出现就立刻把会话闸门关掉。
//    🐛 缘由（实测 2026-09-27 profile 4067）：FB 报 190「session has been invalidated」后，
//       会话闸门仍是 loggedIn=true（markLoginState 只在启动/自动登录流程里被调用），
//       此时若浏览器 cookie jar 里还留着（已死的）c_user/xs，
//       这份「格式完整但已作废」的 Cookie 就会被 syncCookiesToStorage 当成有效会话写进云端。
let _markLoginState = null;
// ☁️ 宿主机注入的「把云端登录状态改成 ok」回调。前端配置列表的「登录状态」列读的是云端字段，
//    只改本地内存闸门的话，那一列会一直显示「未检测」。
let _reportLoginStatusToCloud = null;
// 🚦 去重：Graph API 调用极其频繁，同一配置本轮只上报一次 ok；
//    被判 190 会话失效时清掉，恢复后再上报。
const _loginOkReported = new Set();

function __inject(deps) {
  if (deps.log) { _log = deps.log; _logInjected = true; }
  if (deps.sleep) _sleep = deps.sleep;
  if (deps.getDb) _getDb = deps.getDb;
  if (deps.refreshProfileToken) _refreshProfileToken = deps.refreshProfileToken;
  if (deps.isProfileRunning) _isProfileRunning = deps.isProfileRunning;
  if (deps.ensureBrowserIsRunning) _ensureBrowserIsRunning = deps.ensureBrowserIsRunning;
  if (deps.findProfileById) _findProfileById = deps.findProfileById;
  if (deps.autoFillPasswordOnPage) _autoFillPasswordOnPage = deps.autoFillPasswordOnPage;
  if (deps.parseProxy) _parseProxy = deps.parseProxy;
  if (deps.directConnectionFailures) _directConnectionFailures = deps.directConnectionFailures;
  if (deps.S5_TUNNEL_PORT) _S5_TUNNEL_PORT = deps.S5_TUNNEL_PORT;
  if (deps.getProfileCookies) _getProfileCookies = deps.getProfileCookies;
  if (deps.markLoginState) _markLoginState = deps.markLoginState;
  if (deps.reportLoginStatusToCloud) _reportLoginStatusToCloud = deps.reportLoginStatusToCloud;
}

// safeLog: 在全局 log 定义前使用 console.log
const safeLog = (level, msg) => { try { if (_logInjected) _log(level, msg); else console.log(`[${level}] ${msg}`); } catch {} };

// ────────────────────────────────────────────────────────────────────────────
// 🖥️ Windows 系统代理
//    Chrome 默认就使用 Windows 系统代理，所以浏览器能上 FB；而 curl.exe **不读**系统代理
//    （只认 http_proxy/HTTPS_PROXY/all_proxy 环境变量）→ 直连被墙 → curl 错误 28。
//    这里把系统代理读出来交给 curl：出口 IP 与浏览器一致，且 curl 不受 CORS 约束。
//    注册表查询要 spawn reg.exe（几十毫秒），做 60s 缓存，避免每个 Graph 请求都查一次。
// ────────────────────────────────────────────────────────────────────────────
const SYS_PROXY_TTL_MS = 60000;
let _sysProxyCache = { value: null, at: 0 };

function _getSystemProxy() {
    if (process.platform !== 'win32') return null;
    const now = Date.now();
    if (now - _sysProxyCache.at < SYS_PROXY_TTL_MS) return _sysProxyCache.value;

    let result = null;
    try {
        const { execSync } = require('child_process');
        const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
        const opts = { encoding: 'latin1', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
        const enableOut = execSync(`reg query "${KEY}" /v ProxyEnable`, opts).toString();
        if (/REG_DWORD\s+0x0*1\b/i.test(enableOut)) {
            const serverOut = execSync(`reg query "${KEY}" /v ProxyServer`, opts).toString();
            const m = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
            let raw = m ? m[1].trim() : '';
            // 兼容按协议分列的写法: http=127.0.0.1:10808;https=127.0.0.1:10808
            if (raw.includes('=')) {
                const map = {};
                for (const seg of raw.split(';')) {
                    const i = seg.indexOf('=');
                    if (i > 0) map[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim();
                }
                raw = map.https || map.http || '';
            }
            if (/^[\w.\-]+:\d+$/.test(raw)) result = raw;
        }
    } catch (e) {
        result = null;
    }
    _sysProxyCache = { value: result, at: now };
    return result;
}

// ────────────────────────────────────────────────────────────────────────────
// 🚦 直连失败名单（按 profile + host 分别记，5 分钟冷却）
//    🐛 以前是「一个 profile 一个标记」：adsmanager-graph.facebook.com 超时后，
//       连本来能通的 graph.facebook.com 也一律跳过 curl、全部退到浏览器上下文 ——
//       而浏览器上下文是跨域 XHR（带 Cookie 必被浏览器拒：XHR failed status=0），
//       于是整条授权链路一个响应都拿不到。现在只拉黑真正失败的那个 host。
// ────────────────────────────────────────────────────────────────────────────
const DIRECT_FAIL_TTL_MS = 300000;
const _directFailHosts = new Map(); // `${profileId}|${host}` → 失败时间戳

function _markDirectFail(profileId, host) {
    if (!profileId || !host) return;
    const now = Date.now();
    for (const [k, t] of _directFailHosts) {
        if (now - t > DIRECT_FAIL_TTL_MS) _directFailHosts.delete(k);
    }
    _directFailHosts.set(`${profileId}|${host}`, now);
}

function _isDirectFailed(profileId, host) {
    if (!profileId || !host) return false;
    const key = `${profileId}|${host}`;
    const t = _directFailHosts.get(key);
    if (!t) return false;
    if (Date.now() - t > DIRECT_FAIL_TTL_MS) { _directFailHosts.delete(key); return false; }
    return true;
}

/**
 * 🔑 判定一个 Graph 报错是不是「Token / 登录态失效」。
 *    与 facebook-ad-publish.js 的 isTokenInvalidError **保持同一口径**：
 *    那边负责「判定失效」，这里负责「触发恢复」。
 *
 * 🐛 修：以前本文件的 190 恢复逻辑只认 `code === 190`，而判定侧还认 102/463/2500
 *    和「(#200) Provide valid app ID」→ 这类错误被判定为 Token 失效，却永远不触发
 *    「重新获取 Token」，发布预检于是直接跳过整单。
 *    实测 Profile=4132 就卡在 (#200) Provide valid app ID：报错说 Token 失效、浏览器
 *    50 秒后自动登录其实成功了，但发布已经失败退出。
 */
function _isTokenInvalidError(input) {
  const err = (input && input.error) ? input.error : (input || {});
  const code = Number(err.code || 0);
  // 190 失效 / 102 会话键无效 / 463 会话过期 / 2500 /me 缺有效 token
  if (code === 190 || code === 102 || code === 463 || code === 2500) return true;
  const msg = String(err.message || err.error_user_msg || (typeof input === 'string' ? input : ''));
  return /session has been invalidated|validating access token|Provide valid app ID|active access token|Session has expired|access token has expired|No valid access token/i.test(msg);
}

// 🔒 「重新获取 Token」重入守卫：按 profileId 去重。
//    放宽失效判据后，(#200) Provide valid app ID 之类的错误也会触发 _refreshProfileToken，
//    而那个回调内部还要走 HTTP（/api/facebook/tokens → 校验 token）—— 如果同一个坏 token
//    在内部校验里再次报同类错误，就会「刷新里再刷新」无限套娃（每次都白烧十几秒）。
//    刷新期间标记该 profile，内部的调用直接跳过恢复、把原始错误返回。
const _refreshInFlight = new Set();
// ⏳ 「重新获取 Token」冷却：同一配置在这个间隔内只刷一次。
//    🐛 缘由（实测 2026-09-27 profile 4067）：批量任务里每个失败的 Graph 调用都会触发一次刷新，
//       而刷新接口内部会重新开标签页 + 把云端 Cookie 再 setCookie 一遍（浏览器级共享 cookie jar）。
//       结果 18:55:01~18:56:58 两分钟内对同一个浏览器重复注入了 4 次同样的 13 个 Cookie，
//       既没用（那份会话已被 FB 作废），又会打断批量任务正在用的页面。
//       重入守卫只防并发，防不了这种「刷新完→下个调用又刷」的连续重复，所以这里再加一层时间冷却。
const _lastRefreshAt = new Map(); // profileId -> ts
const REFRESH_MIN_INTERVAL_MS = 30000;
// 🍪 只给每个 profile 打一次「已附带会话 Cookie」的日志，避免几百次 Graph 调用刷屏
const _cookieLogDone = new Set();

/**
 * ⏱️ 给 curl 子进程挂 Node 侧看门狗。
 *    ⚠️ 不能只依赖 curl 自己的 `--max-time`：当代理隧道「连上了但服务端不回数据」时，
 *    实测 `--max-time 300` 也不生效 —— 进程会一直挂着（CPU 接近 0），
 *    整个发布任务就卡死在那儿，界面上看起来就是「没反应了」。
 *    这里由宿主强制兜底 kill，保证任务一定能往下走（终止后走浏览器上下文回退）。
 */
function _attachCurlWatchdog(child, secs, label) {
    const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        safeLog('WARN', `[GraphAPI] ⏱️ curl 看门狗触发（${secs}s 无返回），已强制终止：${label}`);
    }, Math.max(1, secs) * 1000);
    // unref：看门狗只是兜底，不该拖着 Node 进程不退出
    if (typeof timer.unref === 'function') timer.unref();
    const clear = () => { try { clearTimeout(timer); } catch {} };
    child.on('close', clear);
    child.on('error', clear);
}

// 🔑 Token 有效性缓存 —— 修「请求数翻倍」。
//    callFacebookGraphApiViaBrowser 里的 evaluate 每次都会先打一发 `/me?fields=id` 校验 token，
//    而一次抓取动辄几百次 Graph 调用（每个帖子 comments/reactions/sharedposts 各一发）→
//    请求数直接翻倍，而且是串行 await，等于每次调用的延迟也翻倍。
//    同一个 token 在几分钟内不会变，所以这里按 token 值缓存结论：
//      · 命中「有效」→ 跳过校验，直接发正式请求
//      · 命中「失效」→ 跳过那一发，直接走 localStorage 兜底找新 token
//    TTL 分两档：有效的记久一点；失效的记短一点，免得服务端刚刷新过 token 还一直按「失效」走。
const TOKEN_ALIVE_TTL_MS = Math.max(10000, parseInt(process.env.TOKEN_ALIVE_TTL_MS || '600000', 10) || 600000);
const TOKEN_DEAD_TTL_MS = Math.max(5000, parseInt(process.env.TOKEN_DEAD_TTL_MS || '60000', 10) || 60000);
const _tokenValidityCache = new Map(); // token -> { alive: boolean, at: number }
const _tokenSkipLogged = new Set();    // 只在每个 token 首次命中缓存时打一条日志，避免几百行刷屏
const _maskTok = (t) => `EAAB...${String(t || '').slice(-6)}`;

function cachedTokenValidity(token) {
  if (!token) return null;
  const hit = _tokenValidityCache.get(String(token));
  if (!hit) return null;
  const ttl = hit.alive ? TOKEN_ALIVE_TTL_MS : TOKEN_DEAD_TTL_MS;
  if (Date.now() - hit.at > ttl) { _tokenValidityCache.delete(String(token)); return null; }
  if (!_tokenSkipLogged.has(String(token))) {
    _tokenSkipLogged.add(String(token));
    safeLog('INFO', `🔑 [TokenCache] ${_maskTok(token)} 命中缓存(${hit.alive ? '有效' : '失效'})，本 token 后续调用不再重复发 /me 校验（请求数减半）`);
  }
  return hit.alive;
}

function rememberTokenValidity(token, alive) {
  if (!token) return;
  try {
    const key = String(token);
    const prev = _tokenValidityCache.get(key);
    _tokenValidityCache.set(key, { alive: !!alive, at: Date.now() });
    if (!prev) {
      _tokenSkipLogged.delete(key); // 结论变了 → 允许再打一次「命中缓存」日志
      safeLog('INFO', `🔑 [TokenCache] 记录 ${_maskTok(token)} 校验结论=${alive ? '有效' : '失效'}（TTL ${Math.round((alive ? TOKEN_ALIVE_TTL_MS : TOKEN_DEAD_TTL_MS) / 1000)}s）`);
    } else if (prev.alive !== !!alive) {
      _tokenSkipLogged.delete(key);
      safeLog('WARN', `🔑 [TokenCache] ${_maskTok(token)} 结论变更：${prev.alive ? '有效' : '失效'} → ${alive ? '有效' : '失效'}`);
    }
    // token 是很长的字符串，抓多了要防内存膨胀
    while (_tokenValidityCache.size > 500) {
      const oldest = _tokenValidityCache.keys().next().value;
      _tokenValidityCache.delete(oldest);
      _tokenSkipLogged.delete(oldest);
    }
  } catch {}
}

// 🚀 Graph API 通用请求（自动处理 fetch 不可用时的 https 回退）
const fetchGraphApi = (url, options) => new Promise((resolve, reject) => {
  fetch(url, options || {})
    .then(r => r.json().then(resolve).catch(e => { safeLog('WARN', `[fetchGraphApi] JSON parse error: ${e.message}`); resolve(null); }))
    .catch(fetchErr => {
      safeLog('WARN', `[fetchGraphApi] fetch 失败: ${fetchErr.message}, 回退 https...`);
      try {
        const https = require('https');
        const u = new URL(url);
        const body = (options && options.body) || null;
        const reqOpts = {
          hostname: u.hostname, path: u.pathname + u.search,
          method: (options && options.method) || 'GET',
          headers: Object.assign({}, (options && options.headers) || {}),
          family: 4,  // 强制 IPv4
        };
        if (body) {
          reqOpts.headers['Content-Length'] = Buffer.byteLength(body);
          if (!reqOpts.headers['Content-Type']) reqOpts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        const req = https.request(reqOpts, (resp) => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { safeLog('WARN', `[fetchGraphApi] https JSON parse error: ${e.message}, raw=${d.substring(0,300)}`); resolve(null); } });
        });
        req.on('error', (e) => { safeLog('WARN', `[fetchGraphApi] https error: ${e.message}`); resolve(null); });
        if (body) req.write(body);
        req.end();
      } catch (e) { safeLog('WARN', `[fetchGraphApi] https 异常: ${e.message}`); resolve(null); }
    });
});

function serializeGraphApiValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? '1' : '0'; // 🚀 修正：布尔值转为 1/0 以增强 API 兼容性
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

async function callFacebookGraphApiViaBrowser(endpoint, method = 'GET', data = null, profile = null, token = null, launchIfClosed = true) {
    let effectiveToken = token || profile?.token;
    if (!effectiveToken) throw new Error('Access Token is required');
    if (!profile?.id) throw new Error('Profile ID is required for browser fallback');

    // 🚀 Token 合法性检查（与 callFacebookGraphApi 保持一致）
    if (effectiveToken.length > 250) {
        _log('WARN', `[GraphAPI-ViaBrowser] Token 长度异常 (${effectiveToken.length} 字符)，可能已损坏，尝试截断至有效长度`);
        const clean = effectiveToken.match(/^[A-Za-z0-9_-]+/);
        if (clean && clean[0].length > 50) {
            effectiveToken = clean[0].slice(0, 220);
            _log('WARN', `[GraphAPI-ViaBrowser] Token 已截断为 ${effectiveToken.length} 字符: ${effectiveToken.slice(0,15)}...`);
        } else {
            _log('WARN', `[GraphAPI-ViaBrowser] Token 无法修复，继续尝试原始 Token`);
        }
    }

    const base = 'https://graph.facebook.com/v21.0';
    const url = endpoint.startsWith('http') ? endpoint : `${base}/${endpoint.replace(/^\//, '')}`;

    // 🚀 修正：只有在允许启动或浏览器已经打开的情况下才继续
    const isRunning = await _isProfileRunning(profile.id);
    if (!isRunning && !launchIfClosed) {
        _log('WARN', `[GraphAPI] 浏览器未启动且 launchBrowser=false，跳过浏览器回退请求 (ProfileID: ${profile.id})`);
        throw new Error('浏览器未启动且已禁止自动唤醒，无法进行回退请求');
    }

    if (!isRunning && launchIfClosed) {
        _log('INFO', `[GraphAPI] 浏览器未启动，正在根据 launchBrowser=true 自动唤醒 (ProfileID: ${profile.id})`);
    }

    const browserResult = await _ensureBrowserIsRunning(profile.id);
    if (!browserResult.success) {
        throw new Error(browserResult.error || '无法启动浏览器进行 Graph API 回退');
    }

    const browser = browserResult.browserData.browser;
    if (!browser.isConnected()) {
        _log('WARN', `[GraphAPI-ViaBrowser] 浏览器已断开连接，尝试重新启动 (ProfileID: ${profile.id})`);
        const reLaunch = await _ensureBrowserIsRunning(profile.id);
        if (!reLaunch.success) throw new Error('无法重新启动浏览器');
    }
    
    const pages = await browser.pages().catch(() => []);
    // 🚀 安全创建新页面：newPage 可能因 chromium 状态问题失败，回退到已有页面
    const safeNewPage = async () => {
        try {
            const np = await browser.newPage();
            return np;
        } catch (e) {
            _log('WARN', `[GraphAPI-ViaBrowser] newPage 失败 (${e.message})，使用已有页面回退`);
            const existing = await browser.pages().catch(() => []);
            return existing.length > 0 ? existing[0] : null;
        }
    };
    let page = pages.find((p) => /facebook\.com|messenger\.com|instagram\.com/i.test(p.url())) || await safeNewPage();
    if (!page) throw new Error('无法获取或创建页面用于浏览器 API 回退');
    if (!/facebook\.com/i.test(page.url())) {
        await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }

    let payload = null;
    if (data instanceof URLSearchParams) {
        payload = Object.fromEntries(data.entries());
    } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        payload = { ...data };
    }

    // 🐛 关键修复：调用方经常把 access_token 也塞进 payload（facebook-asset-management.js 里
    //    到处是 `formData.append('access_token', effectiveToken)`）。下面拼 body 时会再 append 一次
    //    bestToken，于是 body 里出现**两个 access_token**：
    //      access_token=<bestToken（可能已换成新 token）>  +  access_token=<payload 里的旧 token>
    //    Facebook 取后者 → 永远 190「Error loading application」。
    //    后果是「刷新 Token 再重试」也救不回来 —— 因为重试复用的是同一个 data（旧 token 还在里面），
    //    实测日志：refresh 两次各存 201/205 新 token，重试依旧 190。
    //    这里统一剔除，token 只由 bestToken 一处提供。
    if (payload && payload.access_token !== undefined) {
        delete payload.access_token;
    }

    // 🚀 不走 Node.js 端 Token 预验证，直接让浏览器内 page.evaluate 处理
    // 浏览器内的 fetch 会自动携带 Cookie 会话，并从 localStorage/sessionStorage 提取有效 Token
    if (effectiveToken) {
        _log('INFO', `[GraphAPI-ViaBrowser] 传入 Token (${effectiveToken.slice(0,15)}...)，由浏览器上下文处理`);
    }

    _log('INFO', `[GraphAPI] 切换浏览器上下文重试: ${method} ${url.split('?')[0]} (ProfileID: ${profile.id})`);

    // 🚀 合并为单次 evaluate，避免两次 evaluate 之间页面导航导致上下文销毁
    // 同时尝试从页面 localStorage/sessionStorage 提取有效 Token（作为兜底）
    let json;
    for (let retry = 0; retry < 3; retry++) {
        try {
            // 🚀 每次重试前检查页面是否可用，不可用则重新获取
            if (retry > 0) {
                try {
                    const check = await page.evaluate(() => 1).catch(() => null);
                    if (check === null) throw new Error('page_destroyed');
                } catch {
                    _log('WARN', `[GraphAPI-ViaBrowser] 页面已销毁，重新获取 (重试 ${retry})`);
                    const brReload = await _ensureBrowserIsRunning(profile.id);
                    if (brReload.success && brReload.browserData?.browser?.isConnected()) {
                        const rebBrowser = brReload.browserData.browser;
                        const rebPages = await rebBrowser.pages().catch(() => []);
                        page = rebPages.find(p => /facebook\.com/.test(p.url())) || await rebBrowser.newPage().catch(() => rebPages[0]);
                        if (!page) throw new Error('无法重新获取页面');
                        if (!/facebook\.com/.test(page.url())) {
                            await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                        }
                    }
                }
            }
            json = await page.evaluate(async ({ requestUrl, requestMethod, requestPayload, accessToken, knownTokenAlive }) => {
        // 1. 检查 Token 有效性，失效则从页面存储提取（兜底）
        //    🔑 knownTokenAlive 由 Node 端缓存给出：true/false = 已知结论 → **跳过这一发校验**；
        //       null = 没有缓存 → 照旧现场校验，并把结论带回去让 Node 记住。
        //       以前这里每调用一次 API 就先打一发 /me?fields=id，一次抓取几百个调用 → 请求数翻倍。
        const checkToken = async (t) => { try { const r = await fetch(`https://graph.facebook.com/v21.0/me?fields=id&access_token=${t}`); return await r.json(); } catch { return null; } };
        let bestToken = accessToken;
        let tokenAlive = null; // null=本次没校验；true/false=本次校验的结论
        if (typeof knownTokenAlive === 'boolean') {
            if (!knownTokenAlive) bestToken = ''; // 已知失效 → 直接去 localStorage 兜底找新 token
        } else if (bestToken) {
            const c = await checkToken(bestToken);
            tokenAlive = !!(c && !c.error);
            if (!tokenAlive) bestToken = '';
        }
        if (!bestToken) {
            let found = '';
            try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i), v = localStorage.getItem(k) || ''; if (/EAAB/.test(v) || /EAAG/.test(v)) { found = v; break; } } } catch {}
            if (!found) { try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i), v = sessionStorage.getItem(k) || ''; if (/EAAB/.test(v) || /EAAG/.test(v)) { found = v; break; } } } catch {} }
            if (found) {
                const c = await checkToken(found);
                tokenAlive = !!(c && !c.error);
                if (tokenAlive) bestToken = found;
            }
            if (!bestToken) bestToken = accessToken;
        }
        // 2. 执行实际 API 请求（带频率限制退避重试）
        const serializeValue = (val) => {
            if (val === undefined || val === null) return null;
            if (typeof val === 'string') return val;
            if (typeof val === 'number' || typeof val === 'boolean') return String(val);
            if (Array.isArray(val) || typeof val === 'object') return JSON.stringify(val);
            return String(val);
        };

        // 🚀 频率限制退避重试
        const MAX_RETRIES = 5;
        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
          try {
            let finalUrl = requestUrl;
            const options = { method: requestMethod };

            if (requestMethod === 'GET') {
                const urlObj = new URL(finalUrl);
                if (requestPayload) {
                    for (const [key, value] of Object.entries(requestPayload)) {
                        const serializedValue = serializeValue(value);
                        if (serializedValue !== null && serializedValue !== '') {
                            urlObj.searchParams.set(key, serializedValue);
                        }
                    }
                }
                urlObj.searchParams.set('access_token', bestToken);
                finalUrl = urlObj.toString();
                var hasBase64Bytes = false;
            } else {
                var hasBase64Bytes = Boolean(requestPayload && typeof requestPayload.bytes !== 'undefined');
                if (hasBase64Bytes) {
                    // adimages 的 bytes 字段要求传原始 Base64 字符串
                    const params = new URLSearchParams();
                    params.set('access_token', bestToken);
                    for (const [key, value] of Object.entries(requestPayload || {})) {
                        const serializedValue = serializeValue(value);
                        if (serializedValue === null) continue;
                        params.set(key, serializedValue);
                    }
                    options.body = params;
                } else {
                    const form = new FormData();
                    form.append('access_token', bestToken);

                    if (requestPayload) {
                        for (const [key, value] of Object.entries(requestPayload)) {
                            const serializedValue = serializeValue(value);
                            if (serializedValue === null) continue;
                            form.append(key, serializedValue);
                        }
                    }

                    options.body = form;
                }
            }

            // 🚀 改用 XHR 替代 fetch，避免 adsmanager 页面 CSP 限制导致 Failed to fetch
            // ⚠️ 必须用 var（不能用 const）：下面的 catch(parseErr) 要引用 respText 拼报错信息，
            //    而 const 的作用域只在 try 块内、catch 里看不到 —— 一旦 try 里抛错（XHR 失败 /
            //    非 JSON 响应），catch 自己反而炸「respText is not defined」，把真实错误盖掉。
            var respText = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open(requestMethod, finalUrl);
                // ⚠️ 必须 true：FB 会把不带登录会话 Cookie 的 Graph 调用判为
                //    {"error":{"message":"Invalid request.","code":1,...}}（opes 网关），
                //    实测同一 token：withCredentials=true → 200，false → 400 Invalid request.。
                //    page.goto 导航之所以一直正常，就是因为它天然带 Cookie。
                xhr.withCredentials = true;
                if (hasBase64Bytes) {
                    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                }
                // FormData 会自动设置 multipart/form-data boundary
                xhr.onload = () => resolve(xhr.responseText);
                // 带上 status/readyState：status=0 是「根本没有 HTTP 响应」的典型特征
                // （CORS 被拒 / CSP connect-src 拦截 / 断网 / 请求被 abort），与 4xx/5xx 区分开
                xhr.onerror = () => reject(new Error(`XHR failed (status=${xhr.status}, readyState=${xhr.readyState})`));
                xhr.onabort = () => reject(new Error('XHR aborted'));
                xhr.ontimeout = () => reject(new Error('XHR timeout'));
                xhr.send(options.body || null);
            });
            const parsed = JSON.parse(respText);
            // 🚀 检测频率限制 (error code 4) → 退避重试
            if (parsed && parsed.error && parsed.error.code === 4) {
                if (retry >= MAX_RETRIES) return { __json: parsed, __tokenAlive: tokenAlive, __usedToken: bestToken }; // 已重试完，返回错误
                const backoff = Math.min(1000 * Math.pow(2, retry), 15000);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            // ⚠️ 返回值统一包一层：把「本次 token 校验结论 / 实际用的 token」带回 Node 端缓存，
            //    否则内层多个 return 点各写一份、很容易漏
            return { __json: parsed, __tokenAlive: tokenAlive, __usedToken: bestToken };
        } catch (parseErr) {
            // ⚠️ respText 可能是 undefined：XHR 自身失败（onerror / onabort / ontimeout）时
            //    await 直接 reject，赋值根本没完成。原来这里直接 respText.slice() 会再炸一层
            //    「Cannot read properties of undefined (reading 'slice')」，继续盖住真实错误 ——
            //    所以必须容错，并把「XHR 的真实失败原因」带出去。
            const _body = (typeof respText === 'string') ? respText.slice(0, 500) : '';
            const _why = String((parseErr && parseErr.message) || parseErr);
            return {
                __json: {
                    error: {
                        message: `Browser fetch failed: ${_why}${_body ? ` | non-JSON body: ${_body}` : ''}`,
                        type: 'BrowserFetchParseError'
                    }
                },
                __tokenAlive: tokenAlive,
                __usedToken: bestToken
            };
        }
        } // 🚀 retry for 循环结束
        // 所有重试用完，返回最后一次错误
        return { __json: { error: { message: 'Max retries exceeded for rate limit', type: 'RateLimitExhausted' } }, __tokenAlive: null, __usedToken: bestToken };
    }, {
        requestUrl: url,
        requestMethod: method,
        requestPayload: payload,
        accessToken: effectiveToken,
        knownTokenAlive: cachedTokenValidity(effectiveToken)
    });
    break; // 成功则跳出循环
} catch (e) {
    if (retry === 0 && (e.message?.includes('context was destroyed') || e.message?.includes('detached') || e.message?.includes('Target closed') || e.message?.includes('Protocol error'))) {
        _log('WARN', `[GraphAPI] 浏览器上下文销毁，等待 2 秒后重试... (${e.message})`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
    }
    throw e; // 非上下文销毁错误或已重试，抛出
}
}

    // 🔑 拆掉 evaluate 的包装（见上面的 __json / __tokenAlive / __usedToken），
    //    并把本次的 token 校验结论记进 Node 端缓存 —— 下次同一个 token 就不用再发那一发 /me 校验了。
    if (json && typeof json === 'object' && '__json' in json) {
        try {
            const _usedTok = json.__usedToken || effectiveToken;
            if (typeof json.__tokenAlive === 'boolean') {
                rememberTokenValidity(_usedTok, json.__tokenAlive);
                // 兜底找出来的新 token 也一并记住（否则每次都要重新校验它）
                if (_usedTok !== effectiveToken) rememberTokenValidity(effectiveToken, false);
            } else if (json.__json && _isTokenInvalidError(json.__json) && effectiveToken) {
                // 缓存说「有效」但服务端回了 Token 失效错误 → 立刻纠正，别再用错的结论
                rememberTokenValidity(effectiveToken, false);
            }
        } catch {}
        json = json.__json;
    }

    if (json?.error) {
        // 🐛 只打 error.message 时，(100) Invalid parameter 这类错误完全看不出是哪个参数/什么原因。
        //    补上 error_user_msg / error_user_title / error_data.blame_field_specs，
        //    否则只能靠猜（Meta 常常把真正的原因放在这几个字段里）。
        const _e = json.error;
        const _extra = [
            _e.error_user_title ? `title=${_e.error_user_title}` : '',
            _e.error_user_msg ? `user_msg=${_e.error_user_msg}` : '',
            _e.error_data ? `data=${JSON.stringify(_e.error_data).slice(0, 300)}` : ''
        ].filter(Boolean).join(' | ');
        _log('WARN', `[GraphAPI] 浏览器上下文返回错误: ${_e.message} (${_e.code || _e.type || 'NO_CODE'})${_extra ? ' | ' + _extra : ''}`);
        // 🐛 Token 失效（190），可能是 session 过期，刷新页面后重试一次
        if (_isTokenInvalidError(json.error)) {
            _log('WARN', `[GraphAPI-ViaBrowser] Token 失效 (${json.error.code || 'NO_CODE'})，检查 Cookie 后重试...`);
            // 🔐 FB 都已判定会话失效了 → 立刻关掉会话闸门。
            //    否则这一轮后面若还有 Cookie 变化事件，只要 jar 里还留着 c_user/xs，
            //    就会带着「已作废但格式完整」的 Cookie 去覆盖云端（见 _markLoginState 处说明）。
            try {
                const _pidForState = String((profile && (profile.id || profile.profileId)) || '');
                if (_pidForState && _markLoginState) {
                    _markLoginState(_pidForState, false);
                    // 会话失效 → 允许下次恢复后重新上报 ok
                    _loginOkReported.delete(_pidForState);
                    _log('WARN', `[GraphAPI-ViaBrowser] 会话已失效 → 关闭会话闸门，禁止本轮再覆盖云端 Cookie (profileId=${_pidForState})`);
                }
            } catch {}
            try {
                // 🐛 先检查 Cookie 有效性，Cookie 已失效则自动导航登录页
                const fbCookies = await page.cookies('https://www.facebook.com', 'https://facebook.com').catch(() => []);
                const cookieArr = Array.isArray(fbCookies) ? fbCookies : [];
                const cUser = cookieArr.find(c => c.name === 'c_user');
                const xs = cookieArr.find(c => c.name === 'xs');
                if (!cUser?.value || !xs?.value) {
                    _log('WARN', `[GraphAPI-ViaBrowser] Cookie 已失效 (c_user=${!!cUser}, xs=${!!xs})，自动导航登录页...`);
                    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                    await new Promise(r => setTimeout(r, 3000));
                    // 尝试从 activeProfiles 找 profile 填密码
                    try {
                        const pId = profile?.id || profile?.profileId || '';
                        const profileObj = await _findProfileById(pId);
                        if (profileObj) {
                            await _autoFillPasswordOnPage(page, profileObj, pId);
                            _log('INFO', `[GraphAPI-ViaBrowser] 自动填密码完成，等待登录...`);
                        }
                    } catch (fillErr) {
                        _log('WARN', `[GraphAPI-ViaBrowser] 自动填密码失败: ${fillErr.message}`);
                    }
                    await new Promise(r => setTimeout(r, 5000));
                    // 重新检查 Cookie
                    const retryFbCookies = await page.cookies('https://www.facebook.com', 'https://facebook.com').catch(() => []);
                    const retryArr2 = Array.isArray(retryFbCookies) ? retryFbCookies : [];
                    const retryCUser2 = retryArr2.find(c => c.name === 'c_user');
                    const retryXs2 = retryArr2.find(c => c.name === 'xs');
                    if (!retryCUser2?.value || !retryXs2?.value) {
                        _log('WARN', `[GraphAPI-ViaBrowser] 自动登录后 Cookie 仍然无效，放弃重试`);
                        return { error: { code: 190, message: 'Cookie expired, auto-login failed' } };
                    }
                    _log('INFO', `[GraphAPI-ViaBrowser] Cookie 重新有效，继续重试`);
                }
                await page.goto('https://business.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 3000));
                // 重新执行 API 调用
                json = await page.evaluate(async ({ requestUrl, requestMethod, requestPayload, accessToken }) => {
        // 1. 检查 Token 有效性，失效则从页面存储提取（兜底）
        const checkToken = async (t) => { try { const r = await fetch(`https://graph.facebook.com/v21.0/me?fields=id&access_token=${t}`); return await r.json(); } catch { return null; } };
        let bestToken = accessToken;
        let tokenRefreshed = false;
        if (bestToken) { const c = await checkToken(bestToken); if (c && c.error) { bestToken = ''; } }
        if (!bestToken) {
            let found = '';
            try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i), v = localStorage.getItem(k) || ''; if (/EAAB/.test(v) || /EAAG/.test(v)) { found = v; break; } } } catch {}
            if (!found) { try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i), v = sessionStorage.getItem(k) || ''; if (/EAAB/.test(v) || /EAAG/.test(v)) { found = v; break; } } } catch {} }
            if (found) { const c = await checkToken(found); if (c && !c.error) { bestToken = found; tokenRefreshed = true; } }
        }
        // 🐛 未找到有效的 Token，直接返回 190 避免用空 Token 死循环
        if (!bestToken) {
            return { error: { code: 190, message: 'No valid access token found in browser, cannot refresh' } };
        }
        // 2. 执行实际 API 请求（带频率限制退避重试）
        const serializeValue = (val) => {
            if (val === undefined || val === null) return null;
            if (typeof val === 'string') return val;
            if (typeof val === 'number' || typeof val === 'boolean') return String(val);
            if (Array.isArray(val) || typeof val === 'object') return JSON.stringify(val);
            return String(val);
        };

        // 🚀 频率限制退避重试
        const MAX_RETRIES = 5;
        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
          try {
            let finalUrl = requestUrl;
            const options = { method: requestMethod };

            if (requestMethod === 'GET') {
                const urlObj = new URL(finalUrl);
                if (requestPayload) {
                    for (const [key, value] of Object.entries(requestPayload)) {
                        const serializedValue = serializeValue(value);
                        if (serializedValue !== null && serializedValue !== '') {
                            urlObj.searchParams.set(key, serializedValue);
                        }
                    }
                }
                urlObj.searchParams.set('access_token', bestToken);
                finalUrl = urlObj.toString();
                var hasBase64Bytes = false;
            } else {
                var hasBase64Bytes = Boolean(requestPayload && typeof requestPayload.bytes !== 'undefined');
                if (hasBase64Bytes) {
                    // adimages 的 bytes 字段要求传原始 Base64 字符串
                    const params = new URLSearchParams();
                    params.set('access_token', bestToken);
                    for (const [key, value] of Object.entries(requestPayload || {})) {
                        const serializedValue = serializeValue(value);
                        if (serializedValue === null) continue;
                        params.set(key, serializedValue);
                    }
                    options.body = params;
                } else {
                    const form = new FormData();
                    form.append('access_token', bestToken);

                    if (requestPayload) {
                        for (const [key, value] of Object.entries(requestPayload)) {
                            const serializedValue = serializeValue(value);
                            if (serializedValue === null) continue;
                            form.append(key, serializedValue);
                        }
                    }

                    options.body = form;
                }
            }

            // 🚀 改用 XHR 替代 fetch，避免 adsmanager 页面 CSP 限制导致 Failed to fetch
            // ⚠️ 同上：必须 var（catch 里要引用 respText，const 会被 try 块作用域挡住）
            var respText = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open(requestMethod, finalUrl);
                // ⚠️ 同上：必须带 Cookie，否则 FB 一律返回 Invalid request. (code 1)
                xhr.withCredentials = true;
                if (hasBase64Bytes) {
                    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                }
                // FormData 会自动设置 multipart/form-data boundary
                xhr.onload = () => resolve(xhr.responseText);
                // 同上：status=0 代表没有 HTTP 响应（CORS/CSP/断网/abort）
                xhr.onerror = () => reject(new Error(`XHR failed (status=${xhr.status}, readyState=${xhr.readyState})`));
                xhr.onabort = () => reject(new Error('XHR aborted'));
                xhr.ontimeout = () => reject(new Error('XHR timeout'));
                xhr.send(options.body || null);
            });
            const parsed = JSON.parse(respText);
            // 🚀 检测频率限制 (error code 4) → 退避重试
            if (parsed && parsed.error && parsed.error.code === 4) {
                if (retry >= MAX_RETRIES) return parsed; // 已重试完，返回错误
                const backoff = Math.min(1000 * Math.pow(2, retry), 15000);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            return parsed;
        } catch (parseErr) {
            // ⚠️ 同上：respText 可能 undefined（XHR 失败时赋值没完成），必须容错并带出真实原因
            const _body = (typeof respText === 'string') ? respText.slice(0, 500) : '';
            const _why = String((parseErr && parseErr.message) || parseErr);
            return {
                error: {
                    message: `Browser fetch failed: ${_why}${_body ? ` | non-JSON body: ${_body}` : ''}`,
                    type: 'BrowserFetchParseError'
                }
            };
        }
        } // 🚀 retry for 循环结束
        // 所有重试用完，返回最后一次错误
        return { error: { message: 'Max retries exceeded for rate limit', type: 'RateLimitExhausted' } };
    }, {
        requestUrl: url,
        requestMethod: method,
        requestPayload: payload,
        accessToken: effectiveToken
    });
                if (json?.error) {
                    _log('WARN', `[GraphAPI] 刷新后仍返回错误: ${json.error.message} (${json.error.code || json.error.type || 'NO_CODE'})`);
                } else {
                    _log('INFO', `[GraphAPI] 刷新页面后请求成功: ${method} ${url.split('?')[0]}`);
                }
            } catch (refreshErr) {
                _log('WARN', `[GraphAPI-ViaBrowser] 刷新页面重试失败: ${refreshErr.message}`);
            }
        }
    } else {
        _log('INFO', `[GraphAPI] 浏览器上下文请求成功: ${method} ${url.split('?')[0]}`);
    }

    return json;
}

/**
 * 🛠️ 辅助函数：通过 curl 执行 Facebook Graph API 调用（支持代理）
 * 🚀 优化：使用 spawn + stdin 避免命令行长度限制 (ENAMETOOLONG)
 * 🚀 新增：当系统网络无法直连 Facebook 时，自动切换到浏览器上下文 fetch 回退
 */
async function _callFacebookGraphApiInner(endpoint, method = 'GET', data = null, profile = null, token = null) {
    let effectiveToken = token || profile?.token;
    // 🔧 Token 三级链路全空时（如全新配置从未提取过 token），先从浏览器会话提取一次再放弃：
    //    创建BM等借用型任务中浏览器正开着，白白 throw 会浪费这次提取机会（此前 5957 邀请 0/2 即此因）
    if (!effectiveToken && profile?.id && _refreshProfileToken && !_refreshInFlight.has(String(profile.id))) {
        const _pid = String(profile.id);
        const _sinceLast = Date.now() - (_lastRefreshAt.get(_pid) || 0);
        if (_sinceLast >= REFRESH_MIN_INTERVAL_MS) {
            _refreshInFlight.add(_pid);
            _lastRefreshAt.set(_pid, Date.now());
            try {
                effectiveToken = await _refreshProfileToken(_pid).catch(() => null);
                if (effectiveToken) {
                    _log('INFO', `[GraphAPI] Token 三级链路为空，已从浏览器会话提取补位: profileId=${_pid}`);
                    try { profile.token = effectiveToken; } catch {}
                }
            } finally {
                _refreshInFlight.delete(_pid);
            }
        }
    }
    if (!effectiveToken) throw new Error('Access Token is required');

    // 🚀 Token 合法性检查：正常 FB token 不超 220 字符，过长说明存储损坏
    if (effectiveToken.length > 250) {
        _log('WARN', `[GraphAPI] Token 长度异常 (${effectiveToken.length} 字符)，可能已损坏，尝试截断至有效长度`);
        // 1. 去除非法字符（Facebook Token 只含 [A-Za-z0-9_-]）
        const clean = effectiveToken.match(/^[A-Za-z0-9_-]+/);
        if (clean && clean[0].length > 50) {
            // 2. 硬性截断到 220 字符（正常 FB token 不超过此长度）
            effectiveToken = clean[0].slice(0, 220);
            _log('WARN', `[GraphAPI] Token 已截断为 ${effectiveToken.length} 字符: ${effectiveToken.slice(0,15)}...`);
        } else {
            _log('WARN', `[GraphAPI] Token 无法修复，继续尝试原始 Token`);
        }
    }

    const base = 'https://graph.facebook.com/v21.0'; // 🚀 修正：回退到稳定版本 v21.0 (v25.0 暂不存在或有 AppID 限制)
    const url = endpoint.startsWith('http') ? endpoint : `${base}/${endpoint.replace(/^\//, '')}`;
    
    const urlObj = new URL(url);
    // 🔑 GET 请求必须把 token 挂在 URL 上。
    //    POST 靠 `-F access_token=...` 传（见下方），但 GET 没有 body 可挂 ——
    //    漏传时 Meta 不会说「缺 token」，而是回 (#200) Provide valid app ID，
    //    看起来像 token 坏了。实测发布预检 GET act_xxx?fields=... 每次都栽在这，
    //    换多少次新 token 都没用（因为请求里压根没带 token）。
    if (method === 'GET' && effectiveToken) urlObj.searchParams.set('access_token', effectiveToken);
    const finalUrl = urlObj.toString();

    const args = ['-s', '-S', '-L', '-v', finalUrl]; 
    
    // 🚀 代理检测与全局兜底
    let proxyInput = profile?.proxy;
    
    // 如果 profile 没代理，尝试从 .env 或全局配置获取 (假设存在 GLOBAL_PROXY 变量)
    if (!proxyInput && process.env.GLOBAL_PROXY) {
        proxyInput = process.env.GLOBAL_PROXY;
        _log('INFO', `[GraphAPI] Profile 缺少代理，使用全局代理兜底: ${proxyInput}`);
    }

    // 🖥️ 再兜底：读 Windows 系统代理（Chrome 默认走的就是它，所以浏览器能上、curl 直连不能）
    if (!proxyInput) {
        const _sysProxy = _getSystemProxy();
        if (_sysProxy) {
            proxyInput = _sysProxy;
            _log('INFO', `[GraphAPI] 未配置代理，自动使用系统代理 ${_sysProxy}（与浏览器出口一致）(ProfileID: ${profile?.id || 'unknown'})`);
        }
    }

    // 🚀 该 profile 近期直连**这个 host** 失败过 → 跳过 curl 直接浏览器回退。
    //    ⚠️ 按 host 判定：不要让 adsmanager-graph.facebook.com 的超时连累 graph.facebook.com。
    const launchBrowserFlag = data && typeof data === 'object' ? Boolean(data.launchBrowser !== false) : true;
    if (profile?.id && _isDirectFailed(String(profile.id), urlObj.host)) {
        _log('WARN', `[GraphAPI] ProfileID=${profile.id} 直连 ${urlObj.host} 近期失败过，跳过 curl 直接使用浏览器上下文。`);
        return callFacebookGraphApiViaBrowser(endpoint, method, data, profile, effectiveToken, launchBrowserFlag);
    }

    const proxy = _parseProxy(proxyInput);
    if (proxy && proxy.host) {
        const pType = String(proxy.type || 'http').toLowerCase();
        const pPrefix = pType.startsWith('socks5') ? 'socks5h' : pType;
        const proxyStr = `${pPrefix}://${proxy.username ? `${proxy.username}:${proxy.password}@` : ''}${proxy.host}:${proxy.port}`;
        args.push('--proxy', proxyStr);
        _log('INFO', `[GraphAPI] 使用代理: ${pPrefix}://${proxy.host}:${proxy.port} (ProfileID: ${profile?.id || 'Global'})`);
    } else if (process.env.all_proxy || process.env.ALL_PROXY) {
        // 🚀 检查是否是本地回环代理（127.0.0.1 / localhost），这种代理常因未运行而超时，跳过 curl 直接走浏览器
        const envProxy = process.env.all_proxy || process.env.ALL_PROXY || '';
        if (/127\.0\.0\.1|localhost/i.test(envProxy)) {
            _log('INFO', `[GraphAPI] 检测到本地回环代理 (${envProxy})，跳过 curl 直接使用浏览器上下文 (ProfileID: ${profile?.id || 'unknown'})`);
            return callFacebookGraphApiViaBrowser(endpoint, method, data, profile, effectiveToken, launchBrowserFlag);
        }
        args.__needNoproxyFallback = true;
        _log('INFO', `[GraphAPI] 无配置代理，使用系统环境变量 (all_proxy=${envProxy}) (ProfileID: ${profile?.id || 'unknown'})`);
    } else {
        // 🐛 这里以前是「无任何代理配置 → 跳过 curl，直接走浏览器上下文」，理由是"避免白白等待 10s 超时"。
        //    但浏览器上下文那条路的请求是**跨域 XHR**（页面在 www.facebook.com，接口在
        //    graph.facebook.com），带会话 Cookie 时会被浏览器直接判失败：
        //    `XHR failed (status=0, readyState=4)` —— 实测 profile 5524/5530 的整条授权链路
        //    （act_xxx/users、act_xxx、me/businesses）全部栽在这里，一个 HTTP 响应都拿不到。
        //    而 curl 是 Node 侧直连，**不受 CORS 约束**，并且下面会把该配置的会话 Cookie 一起带上
        //    （-b 参数），正好满足 graph「token + 站点会话同时在场的」要求。
        //    真被墙导致直连不通时，下面的 curl 退出码分支会自动回退到浏览器上下文，不会卡死。
        _log('INFO', `[GraphAPI] 无任何代理配置，改用 curl 直连（失败会自动回退浏览器上下文）(ProfileID: ${profile?.id || 'unknown'})`);
    }
    
    args.push('--connect-timeout', '3'); // 连接超时 3s（总超时 --max-time 在下面按「是否带文件上传」动态补）

    // 🍪 带上该配置的 .facebook.com 会话 Cookie —— 这一步是发布链路能不能走通的关键。
    //    从 adsmanager 取到的这条 token 必须与站点会话**同时在场**，graph 才认：
    //      · 只带 token            → {"error":{"message":"Invalid request.","code":1,"type":"OAuthException"}}
    //      · token + c_user/xs 等  → 正常返回 {"id":"...","name":"..."}（实测）
    //    以前 curl 通道完全不带 Cookie，于是发布链路上的每个请求（账户预检、ads、spixels、
    //    adimages、me/accounts…）都被判 Invalid request.；而浏览器通道天然带 Cookie，
    //    所以「获取TOKEN」里的校验始终是 validated=true —— 这也是它一直没被怀疑的原因。
    if (_getProfileCookies && profile?.id) {
        try {
            const _ck = await _getProfileCookies(String(profile.id));
            if (_ck) {
                args.push('-b', _ck);
                const _ckKey = String(profile.id);
                if (!_cookieLogDone.has(_ckKey)) {
                    _cookieLogDone.add(_ckKey);
                    safeLog('INFO', `🍪 [GraphAPI] curl 已附带 ${_ck.split('; ').length} 个会话 Cookie (ProfileID=${_ckKey})`);
                }
            }
        } catch (e) { safeLog('WARN', `⚠️ [GraphAPI] 取会话 Cookie 失败（继续不带 Cookie 请求）: ${String(e && e.message || e)}`); }
    }

    let postBody = null;
    
    // 🚀 核心改进：按照 FB 文档改用 -F (multipart/form-data) 模式
    if (method !== 'GET') {
        // ⚠️ curl 带 -F 时默认按 POST 发；DELETE 等其它方法必须显式 -X，否则会被当成 POST 提交
        //    （BM 移除成员走 DELETE /{business_scoped_user_id}）
        if (method !== 'POST') args.push('-X', method);
        args.push('-F', `access_token=${effectiveToken}`); // 始终通过 -F 传递 token

        if (data) {
            if (data instanceof URLSearchParams || (typeof data === 'object' && !Array.isArray(data))) {
                const params = data instanceof URLSearchParams ? data : null;
                const entries = params
                    ? Array.from(params.entries())
                    : Object.entries(data).map(([key, value]) => [key, serializeGraphApiValue(value)]);
                for (const [key, value] of entries) {
                    // 🐛 同上：token 已由上面的 `-F access_token=...` 单独传过一遍，payload 里若再带一个
                    //    就会出现两个 access_token（且可能是旧值），Facebook 会取后者 → 190。
                    if (key === 'access_token') continue;
                    const strVal = value === null ? '' : String(value);
                    // 🚀 核心优化：仅对真正巨大的素材数据 (bytes) 使用 stdin
                    // 对于 JSON 字符串参数 (如 object_story_spec)，使用 --form-string 确保不被 curl 解释
                    if (key === 'bytes' && strVal.length > 10000) {
                        args.push('-F', `${key}=@-`);
                        postBody = strVal; 
                    } else {
                        // 使用 --form-string 避免 value 中的 @ 或 < 被 curl 误判为文件
                        args.push('--form-string', `${key}=${strVal}`);
                    }
                }
            } else if (typeof data === 'string') {
                // 如果是纯 JSON 字符串，回退到 application/json
                args.push('-H', 'Content-Type: application/json');
                args.push('--data-binary', '@-');
                postBody = data;
            }
        } else if (method === 'POST') {
            // 无数据的 POST，也要补一个 -X POST (因为没有 -F 或 --data 触发)
            args.push('-X', 'POST');
        }
    }

    // ⏱️ 总超时按「是否带文件上传」区分：素材走 stdin（args 里是 @-）时慢链路要留足 300s；
    //    普通查询 60s 足够 —— 再久基本就是链路卡住，早点失败回退浏览器反而更快。
    const _hasBigUpload = args.some(a => String(a).includes('@-'));
    const _maxTimeSec = _hasBigUpload ? 300 : 60;
    args.push('--max-time', String(_maxTimeSec));

    _log('INFO', `[GraphAPI] 执行 curl: ${method} ${url.split('?')[0]} (${method === 'GET' ? 'token in query' : '-F mode'})`);
    
    return new Promise((resolve, reject) => {
        const child = spawn('curl', args, { env: { ...process.env, LANG: 'en_US.UTF-8' } });
        // ⏱️ 比 --max-time 多留 15s：curl 自己该退不退时，由看门狗强制收尾
        _attachCurlWatchdog(child, _maxTimeSec + 15, `${method} ${url.split('?')[0]}`);
        let stdoutChunks = [];
        let stderrChunks = [];
        let settled = false;

        const safeResolve = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const safeReject = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        };

        const attemptBrowserFallback = async (reason) => {
            if (!profile?.id) {
                safeReject(new Error(reason));
                return;
            }

            // 🚀 修正：尊重 launchBrowserFlag 开关
            _log('WARN', `[GraphAPI] curl 调用失败，准备切换浏览器上下文重试。原因: ${reason}`);
            try {
                const browserJson = await callFacebookGraphApiViaBrowser(endpoint, method, data, profile, effectiveToken, launchBrowserFlag);
                safeResolve(browserJson);
            } catch (browserErr) {
                safeReject(new Error(`${reason}; browser fallback failed: ${browserErr.message}`));
            }
        };

        if (postBody) {
            child.stdin.write(postBody);
            child.stdin.end();
        }

        child.stdout.on('data', (d) => { stdoutChunks.push(d); });
        child.stderr.on('data', (d) => { stderrChunks.push(d); });

        child.on('close', async (code) => {
            // 🚀 兼容 Windows 中文编码：将 Buffer 正确解码为 UTF-8
            const decodedStdout = Buffer.concat(stdoutChunks).toString('utf8');
            let decodedStderr = Buffer.concat(stderrChunks).toString('utf8');
            // 如果 UTF-8 解码产生乱码（含 字符），尝试 GBK 解码
            if (/[\uFFFD]/.test(decodedStderr)) {
                try {
                    decodedStderr = Buffer.concat(stderrChunks).toString('latin1');
                } catch (e) {}
            }

            if (code !== 0) {
                _log('ERROR', `[GraphAPI] curl 进程退出错误码 ${code}. 错误详情: ${decodedStderr || '无额外信息'}`);
                
                // 🚀 智能回退策略：
                // 错误 7 (Connection refused): 系统 SOCKS5 代理端口不可用 → 自动用 --noproxy '*' 重试
                // 错误 28 (Timeout): 无代理直连超时 → 用浏览器回退
                const isProxyRefused = (code === 7 && decodedStderr.includes('Connection refused')) ||
                    (decodedStderr.includes('Failed to connect') && decodedStderr.includes(String(_S5_TUNNEL_PORT)));
                
                if (isProxyRefused && args.__needNoproxyFallback && !args.__isRetry) {
                    _log('WARN', `[GraphAPI] SOCKS5 代理不可用，自动切换 --noproxy 重试...`);
                    const retryArgs = args.slice(0);
                    retryArgs.push('--noproxy', '*');
                    retryArgs.__isRetry = true;
                    retryArgs.__needNoproxyFallback = false;
                    _log('INFO', `[GraphAPI] 重试 curl (noproxy): ${method} ${url.split('?')[0]}`);
                    const childRetry = spawn('curl', retryArgs, { env: { ...process.env, LANG: 'en_US.UTF-8' } });
                    _attachCurlWatchdog(childRetry, _maxTimeSec + 15, `${method} ${url.split('?')[0]} (noproxy retry)`);
                    let rOut = [], rErr = [];
                    if (postBody) { childRetry.stdin.write(postBody); childRetry.stdin.end(); }
                    childRetry.stdout.on('data', (d) => rOut.push(d));
                    childRetry.stderr.on('data', (d) => rErr.push(d));
                    childRetry.on('close', async (retryCode) => {
                        const rOutStr = Buffer.concat(rOut).toString('utf8');
                        const rErrStr = Buffer.concat(rErr).toString('utf8');
                        if (retryCode !== 0) {
                            _log('WARN', `[GraphAPI] noproxy 重试也失败 (code=${retryCode})，最后尝试浏览器回退`);
                            if (profile?.id && (retryCode === 28 || retryCode === 7)) {
                                _markDirectFail(String(profile.id), urlObj.host);
                                _directConnectionFailures.add(String(profile.id));
                            }
                            await attemptBrowserFallback(`curl noproxy retry failed with code ${retryCode}: ${rErrStr}`);
                            return;
                        }
                        if (rOutStr.trim()) {
                            try {
                                const clean = rOutStr.trim().split('\n').pop();
                                const json = JSON.parse(clean);
                                if (json.error) _log('WARN', `[GraphAPI] 错误响应: ${json.error.message} (${json.error.code})`);
                                safeResolve(json);
                            } catch (e) {
                                await attemptBrowserFallback(`noproxy retry parse failed: ${e.message}`);
                            }
                        } else {
                            safeResolve({ success: true });
                        }
                    });
                    childRetry.on('error', async (err) => { await attemptBrowserFallback(`noproxy retry spawn failed: ${err.message}`); });
                    return;
                }
                
                // 🚀 记录失败状态：超时 (28) 或连接失败 (7) —— 只拉黑**这个 host**，
                //    其他 host（比如能直连的 graph.facebook.com）下次仍会正常走 curl。
                if (profile?.id && (code === 28 || code === 7 || decodedStderr.includes('Timed out') || decodedStderr.includes('Could not connect'))) {
                    _markDirectFail(String(profile.id), urlObj.host);
                    _directConnectionFailures.add(String(profile.id)); // 附件上传链路仍在用这个全局名单
                    _log('WARN', `[GraphAPI] ProfileID=${profile.id} 直连 ${urlObj.host} 失败，5 分钟内该 host 不再走 curl（其他 host 不受影响）。`);
                }

                await attemptBrowserFallback(`curl failed with code ${code}: ${decodedStderr}`);
                return;
            }

            if (decodedStdout && decodedStdout.trim()) {
                try {
                    // 处理可能的 multipart 边界干扰或多个 JSON 响应
                    const cleanStdout = decodedStdout.trim().split('\n').pop(); 
                    const json = JSON.parse(cleanStdout);
                    if (json.error) {
                        _log('WARN', `[GraphAPI] 错误响应: ${json.error.message} (${json.error.code})`);
                    }
                    safeResolve(json);
                } catch (e) {
                    _log('ERROR', `[GraphAPI] 解析响应 JSON 失败: ${e.message}. 原始输出: ${decodedStdout.substring(0, 100)}...`);
                    safeReject(new Error(`Failed to parse API response: ${e.message}`));
                }
            } else {
                safeResolve({ success: true }); // 有些 POST 响应为空但成功
            }
        });

        child.on('error', async (err) => {
            _log('ERROR', `[GraphAPI] 启动 curl 失败: ${err.message}`);
            await attemptBrowserFallback(`curl spawn failed: ${err.message}`);
        });
    });
}

/**
 * 🛠️ 统一入口：在 _callFacebookGraphApiInner 之外补一层 Token 失效(190) 自动恢复。
 *    fbGraph 内部遇到 190 时，会调用宿主注入的 _refreshProfileToken（即界面/批量操作用的
 *    「获取TOKEN」+「保存TOKEN」两个接口），拿到新 token 后把原请求重放一次。
 *    ⚠️ 只重试一次（_refreshed 守卫），避免刷新接口本身也 190 时无限递归。
 */
async function callFacebookGraphApi(endpoint, method = 'GET', data = null, profile = null, token = null, _refreshed = false) {
    const json = await _callFacebookGraphApiInner(endpoint, method, data, profile, token);
    const _pid = profile && profile.id ? String(profile.id) : '';
    // 🔐 反向闸门：Graph API 被 FB 正常受理（返回里没有 error 对象）= 这份会话确实有效 → 登记「已登录」。
    //    于是「取 Token 成功 / 取到广告号资产 / 取到 BM 信息」本身就构成登录判据，
    //    不必再依赖启动流程那种"页面文案看着像登录"的判定（启动判定保持原样，不动）。
    //    与下面 190 分支的 markLoginState(false) 合起来，形成完整的会话闸门：
    //      能取到数据 → 开门（允许本轮把 Cookie 回写云端）
    //      被 FB 判失效(190) → 关门（禁止把已作废的 Cookie 覆盖上去）
    if (json && !json.error && _pid && _markLoginState) {
        try { _markLoginState(_pid, true); } catch {}
        // ☁️ 同时把云端的「登录状态」置为 ok —— 前端配置列表那一列读的是云端字段，
        //    只改本地内存闸门的话，那一列会一直显示「未检测」。
        //    去重：同一配置本轮只上报一次，避免 Graph 高频调用把云端接口打爆。
        if (_reportLoginStatusToCloud && !_loginOkReported.has(_pid)) {
            _loginOkReported.add(_pid);
            try { _reportLoginStatusToCloud(_pid, 'ok'); } catch {}
            safeLog('INFO', `[GraphAPI] 会话有效 → 云端登录状态置为 ok (profileId=${_pid})`);
        }
    }
    if (json?.error && _isTokenInvalidError(json) && !_refreshed && _refreshProfileToken && _pid && !_refreshInFlight.has(_pid)) {
        // ✅ Token 一失效就**强制执行一次**「获取TOKEN」恢复。
        //    （以前这里有一条「本轮登录态已判定失效 → 跳过刷新」的保守策略，现已移除：
        //      它会直接把可自愈的场景判死 —— 比如浏览器里其实还有另一份可用 token、
        //      或 Cookie 刚被别的流程刷新过。多刷一次最多花十几秒，但能救回来。）
        //    保留的必要护栏：
        //      · _refreshed —— 只重试一次，防止刷新接口本身也 190 时无限递归；
        //      · _refreshInFlight —— 同一配置并发调用时只让一个去刷，其余等结果。
        // ⏳ 冷却：同一配置 30s 内只刷一次，避免批量任务里每个失败调用各刷一遍
        const _sinceLast = Date.now() - (_lastRefreshAt.get(_pid) || 0);
        if (_sinceLast < REFRESH_MIN_INTERVAL_MS) {
            safeLog('WARN', `[GraphAPI] 距上次获取 Token 仅 ${Math.round(_sinceLast / 1000)}s（< ${REFRESH_MIN_INTERVAL_MS / 1000}s），跳过重复刷新: profileId=${_pid}`);
            return json;
        }
        let newToken = null;
        _refreshInFlight.add(_pid);
        _lastRefreshAt.set(_pid, Date.now());
        try {
            newToken = await _refreshProfileToken(_pid).catch(() => null);
        } finally {
            _refreshInFlight.delete(_pid);
        }
        if (newToken) {
            try { profile.token = newToken; } catch {}
            safeLog('INFO', `[GraphAPI] Token 已自动刷新，重试请求: ${method} ${String(endpoint).split('?')[0]}`);
            return callFacebookGraphApi(endpoint, method, data, profile, newToken, true);
        }
        safeLog('WARN', `[GraphAPI] Token 自动刷新失败（ProfileID=${_pid}），按原错误返回`);
    }
    return json;
}

/**
 * 上传图片/视频到主页（POST /{pageId}/message_attachments），返回 { id }（attachment_id）。
 * Graph 想给 Messenger 发图片/视频，必须先 multipart 上传拿到 attachment_id，再在 message.attachment.payload 里引用。
 * 代理决策与 callFacebookGraphApi 一致；无可用代理时抛出 UPLOAD_NO_PROXY（文件上传无法经浏览器上下文完成）。
 */
async function uploadPageAttachment(pageId, pageToken, filePath, mimeType, profile = null) {
    const args = ['-s', '-L'];
    let proxyInput = profile && (profile.proxy || profile.proxy_url || profile.proxyUrl)
        ? String(profile.proxy || profile.proxy_url || profile.proxyUrl) : '';
    if (!proxyInput && process.env.GLOBAL_PROXY) proxyInput = String(process.env.GLOBAL_PROXY);
    let usedProxy = false;
    if (proxyInput) {
        const proxy = _parseProxy(proxyInput);
        if (proxy && proxy.host) {
            const pType = String(proxy.type || 'http').toLowerCase();
            const pPrefix = pType.startsWith('socks5') ? 'socks5h' : pType;
            const proxyStr = `${pPrefix}://${proxy.username ? `${proxy.username}:${proxy.password}@` : ''}${proxy.host}:${proxy.port}`;
            args.push('--proxy', proxyStr);
            usedProxy = true;
        }
    }
    if (!usedProxy) {
        // 无可用代理：无法在 Node 侧直连 Facebook，改用浏览器上下文（浏览器本身能访问 FB 且带登录态）上传
        if (profile && profile.id) {
            safeLog('WARN', `[GraphAPI] 附件上传未配置代理，改用浏览器上下文上传 (ProfileID: ${profile.id})`);
            return await uploadPageAttachmentViaBrowser(pageId, pageToken, filePath, mimeType, profile);
        }
        throw new Error('UPLOAD_NO_PROXY: 未找到可用代理，且无浏览器上下文可回退，无法上传附件');
    }

    args.push('--connect-timeout', '3', '--max-time', '180');
    // Messenger 附件上传标准：message 指定附件类型与 is_reusable，文件放在 filedata 字段
    const attType = /^video\//i.test(mimeType || '') ? 'video' : /^audio\//i.test(mimeType || '') ? 'audio' : /^image\//i.test(mimeType || '') ? 'image' : 'file';
    args.push('-F', `access_token=${pageToken}`);
    args.push('-F', `message={"attachment":{"type":"${attType}","payload":{"is_reusable":true}}}`);
    args.push('-F', `filedata=@${filePath}${mimeType ? `;type=${mimeType}` : ''}`);
    args.push(`https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/message_attachments`);

    const response = await new Promise((resolve, reject) => {
        const child = spawn('curl', args, { env: { ...process.env, LANG: 'en_US.UTF-8' } });
        let out = '';
        let errOut = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { errOut += d; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) {
                safeLog('WARN', `[GraphAPI] message_attachments curl 退出码 ${code}: ${errOut.slice(0, 300)}`);
                return resolve(null);
            }
            try { resolve(JSON.parse(out || 'null')); } catch { resolve(null); }
        });
    });
    if (!response || response.error) {
        const msg = response && response.error ? `(${response.error.code || ''}) ${response.error.message}` : 'upload failed';
        safeLog('WARN', `[GraphAPI] message_attachments curl 上传失败: ${msg}`);
        // 代理通道失败（超时/被墙等）→ 兜底走浏览器上下文再试一次
        if (profile && profile.id) {
            safeLog('WARN', `[GraphAPI] curl 上传失败，改用浏览器上下文上传 (ProfileID: ${profile.id})`);
            return await uploadPageAttachmentViaBrowser(pageId, pageToken, filePath, mimeType, profile);
        }
        throw new Error(msg);
    }
    return response; // Graph 返回 { id: attachment_id }
}

/**
 * 浏览器上下文上传 message_attachments：
 * Node 侧把临时文件读成 base64 → 传给已登录 Facebook 的浏览器页面 → 页面内 fetch(multipart FormData) 上传。
 * 适用于：无可用代理 / curl 直连失败等场景（复用浏览器本身的网络与登录态）。
 */
async function uploadPageAttachmentViaBrowser(pageId, pageToken, filePath, mimeType, profile) {
    if (!profile || !profile.id) throw new Error('缺少配置信息，无法使用浏览器上下文上传附件');
    const fs = require('fs');
    let b64 = '';
    try {
        const buf = await fs.promises.readFile(filePath);
        b64 = buf.toString('base64');
    } catch (e) {
        throw new Error(`读取附件失败：${e.message}`);
    }
    // 浏览器未运行则按需拉起（用户主动发送图片/视频，允许冷启动）
    let isRunning = false;
    try { isRunning = await _isProfileRunning(profile.id); } catch {}
    if (!isRunning) safeLog('INFO', `[GraphAPI-Upload] 浏览器未启动，自动拉起 (ProfileID: ${profile.id})`);
    const brResult = await _ensureBrowserIsRunning(profile.id);
    if (!brResult || !brResult.success) throw new Error((brResult && brResult.error) || '无法启动浏览器进行附件上传');
    const browser = brResult.browserData && brResult.browserData.browser;
    if (!browser || !browser.isConnected()) throw new Error('浏览器连接已断开，无法上传附件');

    const pages = await browser.pages().catch(() => []);
    let page = pages.find(p => /facebook\.com|messenger\.com/i.test(p.url()));
    if (!page) {
        try { page = await browser.newPage(); } catch {
            const existing = await browser.pages().catch(() => []);
            page = existing[0] || null;
        }
    }
    if (!page) throw new Error('无法获取或创建浏览器页面用于上传附件');
    if (!/facebook\.com|messenger\.com/i.test(page.url())) {
        await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }

    const uploadUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/message_attachments`;
    const attType = /^video\//i.test(mimeType || '') ? 'video' : /^audio\//i.test(mimeType || '') ? 'audio' : /^image\//i.test(mimeType || '') ? 'image' : 'file';
    let json = null;
    for (let retry = 0; retry < 3 && !json; retry++) {
        try {
            if (retry > 0) { // 页面可能已销毁，重取
                const ok = await page.evaluate(() => 1).catch(() => null);
                if (ok === null) {
                    const again = await _ensureBrowserIsRunning(profile.id);
                    const bb = again && again.success ? again.browserData.browser : null;
                    if (!bb || !bb.isConnected()) throw new Error('无法重新连接浏览器');
                    const pp = await bb.pages().catch(() => []);
                    page = pp.find(x => /facebook\.com/i.test(x.url())) || (await bb.newPage().catch(() => pp[0]));
                    if (!page) throw new Error('无法重新获取页面');
                }
            }
            json = await page.evaluate(async ({ uploadUrl, accessToken, base64, mimeType, attType, targetPageId }) => {
                const G = 'https://graph.facebook.com/v21.0';
                // 校验/兜底 token：与 Graph 通道一致，失效时从页面存储找 EAAB/EAAG
                const checkToken = async (t) => { try { const r = await fetch(`${G}/me?fields=id,name&access_token=${encodeURIComponent(t)}`); return await r.json(); } catch { return null; } };
                const diag = [];
                let bestToken = accessToken;
                if (bestToken) { const c = await checkToken(bestToken); if (c && c.error) { diag.push(`传入token失效(${c.error.code})`); bestToken = ''; } else if (c && c.id) diag.push(`传入token身份=${c.id}`); }
                if (!bestToken) {
                    let found = '';
                    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i), v = localStorage.getItem(k) || ''; if (/EAAB/.test(v) || /EAAG/.test(v)) { found = v; break; } } } catch {}
                    if (!found) { try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i), v = sessionStorage.getItem(k) || ''; if (/EAAB/.test(v) || /EAAG/.test(v)) { found = v; break; } } } catch {} }
                    if (found) { const c = await checkToken(found); if (c && !c.error) { bestToken = found; diag.push(`localStorage兜底身份=${c.id}`); } }
                    if (!bestToken) bestToken = accessToken;
                }
                if (!bestToken) return { error: { message: '未找到有效访问令牌（请确认浏览器已登录 Facebook）' } };
                // 关键：message_attachments 只接受 page token。若当前 token 的 /me 不是目标主页，
                // 说明它是 user token（或其它主页的 token）——在浏览器上下文内用 me/accounts 换取该主页的 page token
                const idj = await checkToken(bestToken);
                if (idj && !idj.error && String(idj.id) !== String(targetPageId)) {
                    diag.push(`非page token(身份=${idj.id}),浏览器内换page token...`);
                    try {
                        const exr = await fetch(`${G}/me/accounts?fields=id,name,access_token&limit=500&access_token=${encodeURIComponent(bestToken)}`);
                        const exj = await exr.json();
                        const pg = (exj && Array.isArray(exj.data)) ? exj.data.find(x => String(x.id) === String(targetPageId)) : null;
                        if (pg && pg.access_token) {
                            const v2 = await checkToken(pg.access_token);
                            if (v2 && !v2.error && String(v2.id) === String(targetPageId)) { bestToken = pg.access_token; diag.push('已换取有效page token'); }
                            else diag.push(`换到的token校验失败:${JSON.stringify(v2).slice(0, 80)}`);
                        } else diag.push(`me/accounts未含该主页(${(exj && exj.error && exj.error.code) || 'empty'}),已管理主页数=${(exj && exj.data && exj.data.length) || 0}`);
                    } catch (e2) { diag.push(`换token异常:${e2.message}`); }
                } else if (idj && idj.error) {
                    diag.push(`token完全失效:${(idj.error.code || '')} ${(idj.error.message || '').slice(0, 60)}`);
                }
                // 依次尝试两个上传端点：/{pageId}/message_attachments → /me/message_attachments（Messenger 标准）
                const urls = [uploadUrl];
                try { const alt = new URL(uploadUrl); alt.pathname = '/me/message_attachments'; urls.push(alt.href); } catch {}
                const errParts = [];
                for (const tryUrl of urls) {
                    // is_reusable=true 需要 App 的 Messenger 高级访问权限，未过审 App 会报 (10)；
                    // 上传后立即发送一次的场景无需复用 → 自动降级 is_reusable=false 重试
                    for (const reusable of [true, false]) {
                        try {
                            // 每次尝试都重建 Blob/FormData，避免 body 复用问题
                            const bin = atob(base64);
                            const u8 = new Uint8Array(bin.length);
                            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                            const blob = new Blob([u8], { type: mimeType || 'application/octet-stream' });
                            const fd = new FormData();
                            fd.append('access_token', bestToken);
                            // Messenger 附件上传标准：message 指定附件类型与 is_reusable，文件放 filedata 字段
                            fd.append('message', JSON.stringify({ attachment: { type: attType, payload: { is_reusable: reusable } } }));
                            fd.append('filedata', blob, 'file');
                            const resp = await fetch(tryUrl, { method: 'POST', body: fd });
                            const data = await resp.json();
                            const attId = data && (data.attachment_id || data.id);
                            if (data && !data.error && attId) {
                                const d = reusable ? diag : diag.concat(['is_reusable=false（无高级访问权限，附件仅本次发送可用）']);
                                return { id: String(attId), attachment_id: String(attId), raw: data, diag: d.join(' | ') };
                            }
                            if (data && data.error) {
                                errParts.push(`${tryUrl} (reusable=${reusable}) → (${data.error.code || ''}) ${data.error.message} [subcode:${data.error.error_subcode || '-'}]`);
                                // 仅权限类错误(10/200/1363030)值得降级重试，其它错误直接跳出
                                if (![10, 200, 1363030].includes(Number(data.error.code))) break;
                            } else { errParts.push(`${tryUrl} (reusable=${reusable}) → 无 id`); break; }
                        } catch (e) {
                            errParts.push(`${tryUrl} (reusable=${reusable}) → 异常: ${e.message}`);
                            break;
                        }
                    }
                }
                return { error: { message: `${diag.join(' | ')} ⚠ ${errParts.join(' | ')}` } };
            }, { uploadUrl, accessToken: pageToken, base64: b64, mimeType: mimeType || 'application/octet-stream', attType, targetPageId: String(pageId) });
        } catch (e) {
            safeLog('WARN', `[GraphAPI-Upload] 浏览器上传 evaluate 失败(重试 ${retry}): ${e.message}`);
            json = null;
        }
    }
    if (!json) throw new Error('浏览器上下文上传失败（多次重试均异常）');
    if (json.error) throw new Error(`(${json.error.code || ''}) ${json.error.message}`);
    if (!json.id) throw new Error('浏览器上传响应缺少 attachment id');
    safeLog('INFO', `[GraphAPI-Upload] 浏览器上下文上传成功 attachmentId=${json.id}`);
    return json;
}

/**
 * 🎬 上传视频广告素材到广告账户（POST /{adAccountId}/advideos），返回 { id: videoId }。
 * - 有可用代理：Node 侧 curl multipart（-F source=@临时文件），不经过浏览器
 * - 无代理/直连失败：浏览器上下文 Blob + FormData（复用浏览器自身的网络与登录态）
 */
async function uploadVideoToAdAccount(adAccountId, videoBase64, filename = 'video.mp4', mimeType = 'video/mp4', profile = null) {
    const b64 = String(videoBase64 || '').replace(/^data:[^;]*;base64,/, '');
    if (!b64) throw new Error('视频数据为空');
    if (!profile || !profile.token) throw new Error('Access Token is required');
    const uploadUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(adAccountId)}/advideos`;
    const safeName = String(filename || 'video.mp4').replace(/[^\w.\-]/g, '_') || 'video.mp4';
    const sizeMb = (Buffer.byteLength(b64, 'base64') / 1048576).toFixed(1);

    let proxyInput = profile.proxy || profile.proxy_url || profile.proxyUrl || '';
    if (!proxyInput && process.env.GLOBAL_PROXY) proxyInput = String(process.env.GLOBAL_PROXY);
    const inFailureList = profile.id && _directConnectionFailures && _directConnectionFailures.has(String(profile.id));
    const proxy = (!inFailureList && _parseProxy) ? _parseProxy(proxyInput) : null;

    if (proxy && proxy.host) {
        // ── 1) 有代理：curl multipart 直传 ──
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const tmpFile = path.join(os.tmpdir(), `omnifp-video-${Date.now()}-${safeName}`);
        fs.writeFileSync(tmpFile, Buffer.from(b64, 'base64'));
        const pType = String(proxy.type || 'http').toLowerCase();
        const pPrefix = pType.startsWith('socks5') ? 'socks5h' : pType;
        const proxyStr = `${pPrefix}://${proxy.username ? `${proxy.username}:${proxy.password}@` : ''}${proxy.host}:${proxy.port}`;
        const args = ['-s', '-L', '--connect-timeout', '10', '--max-time', '1800',
            '--proxy', proxyStr,
            '-F', `access_token=${profile.token}`,
            '-F', `source=@${tmpFile};type=${mimeType || 'video/mp4'}`,
            uploadUrl];
        try {
            safeLog('INFO', `[GraphAPI-Video] curl 上传视频 ${sizeMb}MB (proxy=${pPrefix}://${proxy.host}:${proxy.port})`);
            const out = await new Promise((resolve, reject) => {
                const child = spawn('curl', args, { env: { ...process.env, LANG: 'en_US.UTF-8' } });
                let o = '', e = '';
                child.stdout.on('data', d => { o += d; });
                child.stderr.on('data', d => { e += d; });
                child.on('error', reject);
                child.on('close', code => code === 0 ? resolve(o) : reject(new Error(`curl exit ${code}: ${e.slice(0, 300)}`)));
            });
            const json = JSON.parse(out.trim().split('\n').pop());
            if (json.error) throw new Error(`(${json.error.code || ''}) ${json.error.message}`);
            if (!json.id) throw new Error('上传响应缺少 video id');
            safeLog('INFO', `[GraphAPI-Video] ✅ 视频上传成功 videoId=${json.id}`);
            return json;
        } finally {
            try { fs.unlinkSync(tmpFile); } catch {}
        }
    }

    // ── 2) 无代理：浏览器上下文上传 ──
    if (!profile.id) throw new Error('UPLOAD_NO_PROXY: 无可用代理且无浏览器上下文，无法上传视频');
    const brResult = await _ensureBrowserIsRunning(profile.id).catch(() => null);
    if (!brResult || !brResult.success) throw new Error((brResult && brResult.error) || '无法启动浏览器进行视频上传');
    const browser = brResult.browserData && brResult.browserData.browser;
    if (!browser || !browser.isConnected()) throw new Error('浏览器连接已断开，无法上传视频');
    const pages = await browser.pages().catch(() => []);
    let page = pages.find(p => /facebook\.com/i.test(p.url()));
    if (!page) {
        try { page = await browser.newPage(); } catch {
            const existing = await browser.pages().catch(() => []);
            page = existing[0] || null;
        }
    }
    if (!page) throw new Error('无法获取或创建浏览器页面用于上传视频');
    if (!/facebook\.com/i.test(page.url())) {
        await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }

    safeLog('INFO', `[GraphAPI-Video] 浏览器上下文上传视频 ${sizeMb}MB (ProfileID: ${profile.id})`);
    let json = null;
    for (let retry = 0; retry < 2 && !json; retry++) {
        try {
            if (retry > 0) {
                const alive = await page.evaluate(() => 1).catch(() => null);
                if (alive === null) {
                    const again = await _ensureBrowserIsRunning(profile.id);
                    const bb = again && again.success ? again.browserData.browser : null;
                    if (!bb || !bb.isConnected()) throw new Error('无法重新连接浏览器');
                    const pp = await bb.pages().catch(() => []);
                    page = pp.find(x => /facebook\.com/i.test(x.url())) || (await bb.newPage().catch(() => pp[0]));
                    if (!page) throw new Error('无法重新获取页面');
                }
            }
            json = await page.evaluate(async ({ uploadUrl, accessToken, base64, mimeType, fileName }) => {
                const G = 'https://graph.facebook.com/v21.0';
                // 校验/兜底 token：与 Graph 通道一致，失效时从页面存储找 EAAB/EAAG
                const checkToken = async (t) => { try { const r = await fetch(`${G}/me?fields=id&access_token=${encodeURIComponent(t)}`); return await r.json(); } catch { return null; } };
                let bestToken = accessToken;
                if (bestToken) { const c = await checkToken(bestToken); if (c && c.error) bestToken = ''; }
                if (!bestToken) {
                    let found = '';
                    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i), v = localStorage.getItem(k) || ''; if (/EAAB/.test(v) || /EAAG/.test(v)) { found = v; break; } } } catch {}
                    if (!found) { try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i), v = sessionStorage.getItem(k) || ''; if (/EAAB/.test(v) || /EAAG/.test(v)) { found = v; break; } } } catch {} }
                    if (found) { const c = await checkToken(found); if (c && !c.error) bestToken = found; }
                }
                if (!bestToken) return { error: { code: 190, message: '未找到有效访问令牌（请确认浏览器已登录 Facebook）' } };
                // base64 → Blob → multipart（advideos 的 source 字段要求真实文件流）
                const bin = atob(base64);
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                const blob = new Blob([u8], { type: mimeType || 'video/mp4' });
                const fd = new FormData();
                fd.append('access_token', bestToken);
                fd.append('source', blob, fileName || 'video.mp4');
                const resp = await fetch(uploadUrl, { method: 'POST', body: fd });
                const data = await resp.json().catch(() => null);
                if (!data) return { error: { message: '上传响应非 JSON' } };
                if (data.error) return { error: data.error };
                return data;
            }, { uploadUrl, accessToken: profile.token, base64: b64, mimeType: mimeType || 'video/mp4', fileName: safeName });
        } catch (e) {
            safeLog('WARN', `[GraphAPI-Video] 浏览器上传 evaluate 失败(重试 ${retry}): ${e.message}`);
            json = null;
        }
    }
    if (!json) throw new Error('浏览器上下文视频上传失败（多次重试均异常）');
    if (json.error) throw new Error(`(${json.error.code || ''}) ${json.error.message}`);
    if (!json.id) throw new Error('视频上传响应缺少 video id');
    safeLog('INFO', `[GraphAPI-Video] ✅ 视频上传成功 videoId=${json.id}`);
    return json;
}

/**
 * 🎬 等待视频转码完成：Meta 上传后需要处理，未 ready 就建广告会报 "video not ready"。
 * 返回 { ready, status }；超时不算失败（仍会尝试建创意，由 FB 决定）。
 */
async function waitForVideoReady(videoId, profile, timeoutMs = 300000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        const r = await callFacebookGraphApi(`${videoId}?fields=status,title`, 'GET', null, profile).catch(e => ({ error: { message: e.message } }));
        const st = r && r.status;
        if (st) {
            last = st;
            if (st.video_status === 'ready') {
                safeLog('INFO', `[GraphAPI-Video] 视频 ${videoId} 转码完成 (${Math.round((Date.now() - started) / 1000)}s)`);
                return { ready: true, status: st };
            }
            if (st.video_status === 'error') {
                return { ready: false, status: st, error: st.processing_phase && st.processing_phase.errors };
            }
            safeLog('INFO', `[GraphAPI-Video] 视频 ${videoId} 转码中: ${st.video_status || 'unknown'}${st.processing_progress != null ? ` ${st.processing_progress}%` : ''}`);
        }
        await _sleep(5000);
    }
    safeLog('WARN', `[GraphAPI-Video] 视频 ${videoId} 等待转码超时(${Math.round(timeoutMs / 1000)}s)，先按现状继续`);
    return { ready: false, status: last, timeout: true };
}

module.exports = {
  fetchGraphApi,
  callFacebookGraphApiViaBrowser,
  callFacebookGraphApi,
  uploadPageAttachment,
  uploadVideoToAdAccount,
  waitForVideoReady,
  serializeGraphApiValue,
  __inject,
  // 供宿主启动时自检：190 自动恢复钩子是否真的装上了。
  // 加这个是因为「钩子声明了但宿主忘了注入」曾让整段 190 恢复逻辑静默失效且毫无日志。
  isRefreshTokenHookArmed: () => !!_refreshProfileToken,
};
