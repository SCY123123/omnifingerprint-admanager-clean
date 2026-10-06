// Windows 下强制控制台编码为 UTF-8，解决中文乱码
if (process.platform === 'win32') {
    try { require('child_process').execSync('chcp 65001 > nul', { stdio: 'ignore' }); } catch {}
}

const path = require('path');
// pkg 兼容：使可写路径指向 EXE 所在的实际目录（而非只读快照）
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
require('dotenv').config({ path: path.join(APP_ROOT, '.env') });
const fsSync = require('fs');
const fs = require('fs').promises;
const profilesDir = path.join(process.cwd(), '.profiles');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 🚀 全局 fetch 实现：直接使用 https/http 模块（pkg 兼容，不依赖 experimental fetch）
const _dns = require('dns');
globalThis.fetch = function(url, options) {
  const _start = Date.now();
  return new Promise((resolve, reject) => {
    try {
      const http = require('http');
      const https = require('https');
      const u = typeof url === 'string' ? new URL(url) : url;
      const isHttps = u.protocol === 'https:';
      const transport = isHttps ? https : http;
      const body = (options && options.body) || null;
      // 🔧 统一把 body 规范成 string/Buffer：下面两个消费点（Content-Length 计算、req.write）
      //    都**只接受**这两种类型。以前调用方传 URLSearchParams（GraphQL / 表单常见）时，
      //    `Buffer.byteLength(body)` 会抛 ERR_INVALID_ARG_TYPE —— 而这行跑在 DNS 回调里，
      //    异常既不会被外层 try/catch 也不会被 Promise 捕获，直接变成 uncaughtException，
      //    并且本次 fetch 永久悬挂（实测 CreateBM 创建广告号时必现）。
      const bodyStr = (body == null) ? null
        : (typeof body === 'string' || Buffer.isBuffer(body)) ? body
          : (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ? body.toString()
            : (typeof body === 'object') ? JSON.stringify(body)
              : String(body);
      // 🔌 AbortSignal：队列的「取消 / 单项超时 / 浏览器失活探测」都靠它真正打断在飞请求。
      //    以前没实现，导致 abort() 是空操作 —— 只能干等 socket 空闲超时（回环 280s）。
      const signal = (options && options.signal) || null;
      const isAborted = () => !!(signal && signal.aborted);
      if (isAborted()) { reject(new Error('The operation was aborted')); return; }
      // DNS 解析（IPv4）
      _dns.resolve4(u.hostname, (dnsErr, addresses) => {
        // 🛡️ 回调体整段兜底：该回调在 Promise executor 的同步栈之外执行，
        //    内部任何抛错都不会被外层 try/catch 或 Promise 捕获 —— 会变成 uncaughtException，
        //    同时让本次 fetch 永远 pending（上面的 ERR_INVALID_ARG_TYPE 就是这么炸的）。
        try {
        if (isAborted()) { reject(new Error('The operation was aborted')); return; }
        const ip = (addresses && addresses[0]) || u.hostname;
        const reqOpts = {
          host: ip,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: (options && options.method) || 'GET',
          headers: Object.assign({}, (options && options.headers) || {}),
          rejectUnauthorized: false,
          family: 4,
        };
        if (bodyStr != null) reqOpts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        const req = transport.request(reqOpts, (resp) => {
          let chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({
              ok: resp.statusCode >= 200 && resp.statusCode < 300,
              status: resp.statusCode,
              statusText: resp.statusMessage,
              headers: new Map(Object.entries(resp.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])),
              json: () => { try { return Promise.resolve(JSON.parse(buf.toString())); } catch(e) { return Promise.reject(new Error(`JSON parse error: ${e.message}`)); } },
              text: () => Promise.resolve(buf.toString()),
              arrayBuffer: () => Promise.resolve(buf.buffer),
            });
          });
        });
        req.on('error', e => reject(e));
        // 🔌 把 AbortSignal 接到 socket 上：abort 时立刻 destroy，让 await 方马上拿到异常
        if (signal) {
          const onAbort = () => { try { req.destroy(new Error('The operation was aborted')); } catch { } };
          signal.addEventListener('abort', onAbort, { once: true });
          req.on('close', () => { try { signal.removeEventListener('abort', onAbort); } catch { } });
        }
        // ⏱️ 超时区分回环/外网：
        //    本机接口（127.0.0.1 上的队列、内部编排）自身可能还要「排队等浏览器空位 → 启动 → 抓取」，
        //    用 120s 会把别人浏览器的耗时算到当前配置头上，误报 fetch timeout after 120s。
        //    所以回环调用给更长的上限（默认 280s，略小于队列单项 300s），外网调用仍用 120s。
        const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
        const timeoutMs = isLoopback
            ? (parseInt(process.env.LOCAL_FETCH_TIMEOUT_MS || '280000', 10) || 280000)
            : (parseInt(process.env.FETCH_TIMEOUT_MS || '120000', 10) || 120000);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`fetch timeout after ${Math.round(timeoutMs / 1000)}s`)); });
        if (bodyStr != null) req.write(bodyStr);
        req.end();
        } catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  });
};

// 🚀 PKG 兼容性处理：提取并加载原生 SQLite 模块
let sqlite3;
if (process.pkg) {
    const pkgRoot = path.join(process.cwd(), 'resources');
    const sqlitePath = path.join(pkgRoot, 'node_sqlite3.node');
    if (!fsSync.existsSync(pkgRoot)) fsSync.mkdirSync(pkgRoot, { recursive: true });
    
    try {
        const sourcePath = path.join(__dirname, 'node_modules/sqlite3/build/Release/node_sqlite3.node');
        if (fsSync.existsSync(sourcePath) && !fsSync.existsSync(sqlitePath)) {
            fsSync.writeFileSync(sqlitePath, fsSync.readFileSync(sourcePath));
        }
        // 强制加载提取出的原生模块
        sqlite3 = require('sqlite3');
        // 如果是编译后的环境，sqlite3 可能无法自动找到二进制，我们可以尝试手动注入路径
        // 但通常只要 node_sqlite3.node 在特定目录下，require 就能工作
    } catch (e) {
        console.error('Failed to extract/load sqlite3:', e);
    }
} else {
    sqlite3 = require('sqlite3').verbose();
}
const { exec, spawn } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const execPromise = util.promisify(exec);
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const https = require('https');
const http = require('http');
const tls = require('tls');
const tokenProvider = require('./payment/token-provider');
const adposClient = require('./integrations/adpos-client');
const googleAdsService = require('./google-ads-service');
const proxyTunnel = require('./proxy-tunnel');
const { parseProxy, _createSocksTunnel, _createLocalSocks5AuthForwarder, _createLocalHttpAuthForwarder, _testDirectReachable, sshTunnelManager, socksChainServer, _proxyTunnels, log: tunnelLog } = proxyTunnel;
const browserManagerModule = require('./browser-manager');
const { activeBrowsers, pendingBrowserCount, profileCookiesCache, profileGraphqlFailCache, browserManager, launchQueueManager, BrowserManager, LaunchQueue, getAvailableDebugPort, buildProxyChromeArgs, extractEmailPrefix, extractFbToken, safePageEvaluate, safePageEvaluateVoid, isProfileRunning, ensureBrowserIsRunning, executeWithBrowserRetry, _rawCdpExtractToken, borrowedBrowserStats } = browserManagerModule;
// 🚀 直连失败记录 & Token过期记录：需要在模块注入前初始化
const directConnectionFailures = new Set();
const deadTokenProfiles = new Set();
setInterval(() => directConnectionFailures.clear(), 300000);
// 🔌 S5 隧道配置：需要在模块注入前初始化
let S5_TUNNEL_HOST = process.env.S5_TUNNEL_HOST || '127.0.0.1';
let S5_TUNNEL_PORT = parseInt(process.env.S5_TUNNEL_PORT || '10808', 10);
let S5_TUNNEL_TYPE = (process.env.S5_TUNNEL_TYPE || 'socks5').toLowerCase();

const API_SECRET = process.env.PUPPETEER_API_SECRET || ''; // 🚀 安全加固：API 访问密钥
const BROWSER_PROFILES_ROOT = process.env.BROWSER_PROFILES_ROOT || path.join(APP_ROOT, 'browser-profiles');
const FILE_LOG_PATH = path.join(APP_ROOT, 'logs', 'service.log');
const PORT = parseInt(process.env.PUPPETEER_PORT || process.env.PORT || '9999', 10);
const SCREENSHOT_DIR = path.join(APP_ROOT, 'logs', 'screenshots');
// 🍪 Cookie管理模块
const app = express();

const cookieManager = require('./cookie-manager');
const { normalizeCookie, preinjectCookies, preinjectCookiesToDatabase, parseCookieString, syncCookiesToStorage, attachCookieSync, getCookiesFromStorage } = cookieManager;
// 🚀 注入主文件的依赖到模块（共享 log、findChromeExecutable、cookie函数等）
browserManagerModule.__inject({ log, findChromeExecutable, attachCookieSync, getCookiesFromStorage, syncCookiesToStorage, parseCookieString });
// 🍪 注入主文件依赖到Cookie管理模块（共享 log、sleep、activeBrowsers）
cookieManager.__inject({ log, sleep, getActiveBrowsers: () => activeBrowsers });
const databaseModule = require('./database');
const { DatabasePool, initDatabase, ensureAdAccountsTable, ensurePagesTable, ensureBusinessesTable, ensureAdsTable, ensurePaymentTokensTable, ensurePixelsTable, ensureAdTemplatesTable, loadProfilesFromFile, findProfileById, autoFillPasswordOnPage, probeConnectivity, db, mainDbPool, dbPath, credentialsDb, BROWSER_PROFILES_ROOT: BROWSER_PROFILES_ROOT_DB } = databaseModule;
// 🚀 注入主文件的依赖到数据库模块（共享 log）
databaseModule.__inject({ log });
const fbGraph = require('./facebook-graph');
const { fetchGraphApi, callFacebookGraphApiViaBrowser, callFacebookGraphApi, serializeGraphApiValue } = fbGraph;
// 🚀 注入主文件的依赖到 Facebook Graph 模块
// 🔑 refreshProfileToken：token 失效(190) 时的自动恢复 —— 内部重跑一遍「获取TOKEN + 保存TOKEN」
//    （也就是界面上那个按钮做的事），拿到新 token 后 facebook-graph.js 会把原请求重放一次。
//    ⚠️ 以前这里**没有**注入这个回调，导致 facebook-graph.js 里那段 190 恢复逻辑是死代码
//       （`&& _refreshProfileToken` 永远短路）。后果：token 一失效就直接把 190 抛给上层，
//       发布链路的预检判定「Token/登录已过期」→ 跳过发布，必须人工去点「获取TOKEN」才能恢复。
fbGraph.__inject({
    log, sleep, isProfileRunning, ensureBrowserIsRunning, findProfileById, autoFillPasswordOnPage,
    parseProxy, directConnectionFailures, S5_TUNNEL_PORT,
    // 🔐 190 判定出来时立刻关掉「会话闸门」，禁止再把这轮（已失效的）Cookie 推到云端
    markLoginState: cookieManager.markLoginState,
    // ☁️ Graph API 取数成功 = 会话有效 → 把云端的「登录状态」置为 ok
    //    （前端配置列表那一列读的就是云端字段，只改内存闸门它会一直显示「未检测」）
    reportLoginStatusToCloud: cookieManager.reportLoginStatusToCloud,
    // 🔐 反过来读：已判定未登录时不再走 190 自动恢复（避免反复注入死 Cookie、打断批量任务）
    getLoginState: cookieManager.getLoginState,
    // 🍪 取该配置的 .facebook.com 会话 Cookie，供 GraphAPI 的 curl 通道使用
    //    （缘由见 facebook-graph.js 里 curl 处的说明：这条 token 必须与会话 Cookie 同时在场，
    //      否则 graph 一律回 Invalid request.）
    getProfileCookies: async (profileId) => {
        const pid = String(profileId || '');
        if (!pid) return '';
        const toHeader = (arr) => (Array.isArray(arr) ? arr : [])
            .filter(c => c && c.name && c.value)
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
        try {
            // 1) 本轮启动实际注入浏览器的 Cookie（最准，同步命中，零成本）
            const fromMem = toHeader(profileCookiesCache.get(pid));
            if (fromMem) return fromMem;
            // 2) 本地库里存的那份
            try {
                const p = await findProfileById(pid);
                const fromLocal = toHeader(p && p.accountCookies);
                if (fromLocal) return fromLocal;
            } catch {}
            // 3) 云端（首次要等一次 HTTP；取到后写回缓存，后续调用同步命中）
            const cloud = await getCookiesFromStorage(pid).catch(() => []);
            const fromCloud = toHeader(cloud);
            if (fromCloud) { try { profileCookiesCache.set(pid, cloud); } catch {} }
            return fromCloud;
        } catch { return ''; }
    },
    refreshProfileToken: async (profileId) => {
        const t0 = Date.now();
        const headers = { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET || '' };
        try {
            log('INFO', `🔑 [TokenRefresh] 检测到 190，自动重新获取 Token: profileId=${profileId}`);
            const resp = await fetch(`http://127.0.0.1:${PORT}/api/facebook/tokens`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ profileId: String(profileId), targetUrl: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns' })
            });
            const json = await resp.json().catch(() => ({}));
            const tk = (json && json.tokens) || {};
            const access = Array.isArray(tk.access_tokens) ? tk.access_tokens.filter(Boolean) : [];
            const validated = Array.isArray(tk.validated_tokens) ? tk.validated_tokens.filter(Boolean) : [];
            // 🐛 优先用「页面内 /me 校验通过」的 token。
            //    以前这里只按 /^EAAG|^EAA/ 前缀盲选，而提取端以前用的是 Node 侧 https.get 校验
            //    （本机直连不到 Facebook，所以 validated 恒为 false、候选顺序随机），
            //    结果经常把一个**死 token** 存回配置 —— 下一轮请求还是 190，白烧十几秒。
            //    现在：只有校验通过的 token 才允许保存；一个都没通过就不动配置，把真实的 190 抛给上层。
            const newToken = validated.find(v => /^EAAG/i.test(String(v)))
                || validated[0]
                || '';
            if (!newToken) {
                log('WARN', `🔑 [TokenRefresh] 提取到的 Token 全部未通过校验，不覆盖已存 Token（登录态可能已失效，需人工重新登录）: profileId=${profileId}, 候选=${access.length}, 耗时=${Date.now() - t0}ms`);
                return null;
            }
            await fetch(`http://127.0.0.1:${PORT}/api/facebook/save-tokens`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ profileId: String(profileId), tokens: { access_tokens: [newToken] } })
            }).catch(() => {});
            log('INFO', `🔑 [TokenRefresh] Token 已刷新并保存: profileId=${profileId} ${newToken.slice(0, 12)}... 耗时=${Date.now() - t0}ms`);
            return newToken;
        } catch (e) {
            log('WARN', `🔑 [TokenRefresh] 重新获取 Token 失败: profileId=${profileId}, 原因=${String(e && e.message || e)}`);
            return null;
        }
    }
});
const adPubModule = require('./facebook-ad-publish');
const { SkipPublishError, runFacebookPublishAdApi, runFacebookPublishAd } = adPubModule;
// 🚀 注入主文件的依赖到 Facebook 广告发布模块
adPubModule.__inject({ log, PORT });
// 🎯 TikTok 模块
const tiktokModule = require('./tiktok');
const { __inject: __injectTt } = tiktokModule;
// 🚀 注入主文件的依赖到 TikTok 模块
__injectTt({ log, sleep, ensureBrowserIsRunning, APP_ROOT, app });
// 🔍 健康检查与诊断模块
const healthModule = require('./health-diagnostics');
const { __inject: __injectHealth, registerRoutes: registerHealthRoutes, buildDiagnosticsHtml } = healthModule;
// 🚀 浏览器路由模块
const { __inject: __injectBrowserRoutes, registerRoutes: registerBrowserRoutes, waitForLaunchIdle } = require('./browser-routes');
// 🚀 Facebook 账单模块
const billingModule = require('./facebook-billing');
const { __inject: __injectBilling } = billingModule;
// 🚀 注入主文件的依赖到 Facebook 账单模块
__injectBilling({ log, sleep, activeBrowsers, safePageEvaluate, findProfileById, extractFbToken, autoFillPasswordOnPage, callFacebookGraphApi, PORT: PORT, API_SECRET: API_SECRET });
// 🚀 Facebook 账单路由模块
const { __inject: __injectBillingRoutes, registerRoutes: registerBillingRoutes } = require('./facebook-billing-routes');
// 🚀 注入主文件的依赖到 Facebook 账单路由模块
__injectBillingRoutes({ log, app, PORT, API_SECRET, directConnectionFailures, S5_TUNNEL_PORT, APP_ROOT, BROWSER_PROFILES_ROOT, FILE_LOG_PATH, SCREENSHOT_DIR });
// 📊 广告数据追踪 + 账单信息路由模块（insights / billing-info，浏览器上下文调 Graph）
const { __inject: __injectInsightsRoutes, registerRoutes: registerInsightsRoutes } = require('./facebook-insights-routes');
__injectInsightsRoutes({ log, app, callFacebookGraphApi, findProfileById, API_SECRET });
// 🚀 解构导出 billing 模块函数，使现有调用仍可直接使用函数名
const { clickButtonByText, fillCardForm, fillIframeCardFields, detectCardBrand, normalizeFbTimezoneId, getBillingCache, getBillingCacheKey, setBillingCache, buildBillingHubUrl, navigateToBillingHub, retryWithTokenRefresh, ensureFbLanguage, tryUpdateBillingCountrySmart, postOperationSync, tryUpdateCurrencyTimezone } = billingModule;
// 🚀 Facebook 资产管理模块
const { __inject: __injectAssetMgmt, registerRoutes: registerAssetRoutes } = require('./facebook-asset-management');
// 🚀 Facebook 资产/广告/Page/配置等路由模块统一注册，见中间件后的位置说明
__injectAssetMgmt({ log, sleep, activeBrowsers, findProfileById, callFacebookGraphApi, ensureBrowserIsRunning, PORT: PORT, API_SECRET: API_SECRET, APP_ROOT, dbPath, app });
// 🧵 服务端任务队列：批量慢操作统一入队执行，任务落盘（刷新前端/重启后端都不丢）
const { JobQueue } = require('./job-queue');
const jobQueue = new JobQueue({
    dbPath, port: PORT, apiSecret: API_SECRET, log,
    // 🔗 队列并发数 = 全局浏览器闸门（LaunchQueue.maxConcurrent）：改一个数字两处同时生效。
    //    否则队列设 10、闸门只有 5 时，队列里会有一半任务卡在「等空位」，看起来像队列不动。
    onConcurrencyChange: (n) => { try { launchQueueManager.setMaxConcurrent(n); } catch (e) { log('WARN', `[JobQueue] 同步并发数失败: ${e.message}`); } },
});
// 🚀 AdPOS 路由模块
const { __inject: __injectAdpos, registerRoutes: registerAdposRoutes, ensureAdposPrefs } = require('./adpos-routes');
// 🚀 注入主文件的依赖到 AdPOS 路由模块
__injectAdpos({ log, app, tokenProvider, adposClient, dbPath });
// 🚀 Facebook 页面/广告路由模块
const { __inject: __injectPageRoutes, registerRoutes: registerPageRoutes } = require('./facebook-page-routes');
// 🚀 注入主文件的依赖到 Facebook 页面/广告路由模块
__injectPageRoutes({ log, app, sleep, activeBrowsers, findProfileById, ensureBrowserIsRunning, extractFbToken, safePageEvaluate, callFacebookGraphApi, profileGraphqlFailCache, browserManager, postOperationSync, PORT, API_SECRET, FILE_LOG_PATH, SCREENSHOT_DIR, extractEmailPrefix });
// 🚀 Facebook 配置/Token/首选项/调试路由模块
const { __inject: __injectProfileRoutes, registerRoutes: registerProfileRoutes } = require('./facebook-profile-routes');
// 🚀 注入主文件的依赖到 Facebook 配置/Token/首选项/调试路由模块
__injectProfileRoutes({ log, app, sleep, activeBrowsers, findProfileById, browserManager, findChromeExecutable, FILE_LOG_PATH, dbPath, ensureAdAccountsTable, ensureAdposPrefs, PORT, API_SECRET, waitForLaunchIdle, buildProxyChromeArgs, getCookiesFromStorage, normalizeCookie });
// 🚀 Google Ads 路由模块
const { __inject: __injectGoogleAdsRoutes, registerRoutes: registerGoogleAdsRoutes } = require('./google-ads-routes');
// 🚀 调试/DevTools/RPA 路由模块
const { __inject: __injectDebugRoutes, registerRoutes: registerDebugRoutes } = require('./debug-routes');
// 🚀 配置文件 CRUD 路由模块
const { __inject: __injectProfileCrudRoutes, registerRoutes: registerProfileCrudRoutes } = require('./profiles-routes');

// 🚀 TOTP 解码：Base32 密钥 → 6 位验证码（RFC 6238）
function totp_decode(secret) {
    if (!secret) return '';
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleaned = secret.replace(/=+$/, '').toUpperCase();
    let bits = '';
    for (let i = 0; i < cleaned.length; i++) {
        const val = base32chars.indexOf(cleaned[i]);
        if (val === -1) continue;
        bits += val.toString(2).padStart(5, '0');
    }
    const buf = Buffer.alloc(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i += 8) {
        const byte = bits.substring(i, i + 8);
        buf[i / 8] = parseInt(byte.padEnd(8, '0'), 2);
    }
    const epoch = Math.floor(Date.now() / 1000);
    let timeVal = Math.floor(epoch / 30);
    const counter = Buffer.alloc(8);
    for (let i = 7; i >= 0; i--) {
        counter[i] = timeVal & 0xff;
        timeVal = Math.floor(timeVal / 256);
    }
    const hmac = crypto.createHmac('sha1', buf);
    hmac.update(counter);
    const result = hmac.digest();
    const offset = result[result.length - 1] & 0xf;
    const code = ((result[offset] & 0x7f) << 24) |
        ((result[offset + 1] & 0xff) << 16) |
        ((result[offset + 2] & 0xff) << 8) |
        (result[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
}

if (process.env.QUIET_LOGS === 'true') {
    console.log = () => {};
    console.debug = () => {};
}

// 🚀 性能优化：日志级别控制
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO'; // DEBUG, INFO, WARN, ERROR
// ⚠️ SUCCESS 必须登记在这个表里：否则 logLevels['SUCCESS'] === undefined，
//    `undefined >= INFO(1)` 恒为 false → 全项目所有 log('SUCCESS', ...) 都会被静默丢弃。
//    （实测这条正好吞掉了「已用云端数据补全本地配置」这类关键排查日志。）
const logLevels = { DEBUG: 0, SUCCESS: 1, INFO: 1, WARN: 2, ERROR: 3 };

// 📁 浏览器隔离数据根目录 (可通环境变量修改)

// 简易文件日志：既输出到控制台，也落盘到 backend/logs/service.log

function ensureLogDir() {
    try {
        const dir = path.dirname(FILE_LOG_PATH);
        if (!fsSync.existsSync(dir)) {
            fsSync.mkdirSync(dir, { recursive: true });
        }
    } catch (e) {
        
    }
}
ensureLogDir();

function ensureScreenshotDir() {
    try {
        if (!fsSync.existsSync(SCREENSHOT_DIR)) {
            fsSync.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        }
    } catch {}
}

// 🔍 查找系统中可用的 Chrome/Edge 浏览器可执行文件路径
// 优先使用系统安装的 Chrome/Edge：它们会自动更新到新版本，
// 能打开任意较新版本的 profile；而捆绑版(bundled-chrome)版本固定，
// 若 profile 被更新版本的 Chrome 打开/升级过，旧捆绑版会启动即崩溃
// （表现为 Target.setAutoAttach: Target closed / 进程秒退并产生 .dmp）。
// 捆绑版仅在系统找不到任何 Chrome/Edge 时作为兜底。
// 设置环境变量 USE_BUNDLED_CHROME=true 可强制使用捆绑版。
function findChromeExecutable() {
    // pkg EXE 中 __dirname 指向 snapshot，bundled-chrome 在 exe 同级目录
    const exeDir = path.dirname(process.execPath);
    const cwdDir = process.cwd();
    const bundledPath = (
        fsSync.existsSync(path.join(exeDir, 'bundled-chrome', 'chrome.exe'))
            ? path.join(exeDir, 'bundled-chrome', 'chrome.exe')
            : fsSync.existsSync(path.join(cwdDir, 'bundled-chrome', 'chrome.exe'))
                ? path.join(cwdDir, 'bundled-chrome', 'chrome.exe')
                : path.join(__dirname, '..', 'bundled-chrome', 'chrome.exe')
    );
    const forceBundled = process.env.USE_BUNDLED_CHROME === 'true' || process.env.USE_BUNDLED_CHROME === '1';
    const envChromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    let candidates;
    if (forceBundled) {
        // 强制模式：只检查捆绑版，不存在则返回 null
        candidates = [bundledPath];
    } else {
        candidates = [
            envChromePath,
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            `${process.env.LOCALAPPDATA || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
            bundledPath,
            path.join(cwdDir, 'pup-client', 'bundled-chrome', 'chrome.exe'),
            'D:\\omnibrowser\\browsers\\chrome\\chrome.exe',
            (() => { try { return require('puppeteer').executablePath(); } catch(_) { return null; } })()
        ];
    }
    return candidates.filter(Boolean).find(p => { try { return require('fs').existsSync(p); } catch { return false; } }) || null;
}

async function captureScreenshot(page, profileId, tag) {
    return;
}

function log(level, message, ...args) {
    // 🚀 debug 日志关闭时不输出纯 debug 消息（但 info/warn/error 仍继续）
    const isForced = (typeof args[0] === 'string' && args[0].startsWith('FORCE_DBG'));
    if (String(level).toUpperCase() === 'DEBUG' && !isForced) { return; }
    if (logLevels[level] >= logLevels[LOG_LEVEL] || isForced) {
        const now = new Date();
        const y = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const h = String(now.getHours()).padStart(2, '0');
        const mi = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        const timestamp = `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`;
        const line = `[${timestamp}] [${level}] ${message}`;
        const formatted = args && args.length ? `${line} ${args.map(a => {
            try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
        }).join(' ')}` : line;
        try { process.stdout.write(formatted + "\n"); } catch {}
        try { fsSync.appendFileSync(FILE_LOG_PATH, formatted + "\n"); } catch {}
    }
}

// 进程级异常兜底：记录到文件，避免静默退出
process.on('uncaughtException', (err) => {
    try {
        const ts = new Date().toISOString();
        const stack = (err && err.stack) ? err.stack : String(err);
        fsSync.appendFileSync(FILE_LOG_PATH, `[${ts}] [FATAL] uncaughtException: ${stack}\n`);
    } catch {}
    console.error('uncaughtException:', err);
    // 不立即退出，尽量保持服务存活；如需强制重启请改用守护进程（pm2/nssm）
});

process.on('unhandledRejection', (reason, promise) => {
    try {
        const ts = new Date().toISOString();
        const msg = (reason && reason.stack) ? reason.stack : JSON.stringify(reason);
        fsSync.appendFileSync(FILE_LOG_PATH, `[${ts}] [ERROR] unhandledRejection: ${msg}\n`);
    } catch {}
    console.error('unhandledRejection:', reason);
});

// 🧹 优雅退出：收到关闭信号时先关闭所有浏览器，避免锁文件残留
const gracefulShutdown = async (signal) => {
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] [INFO] 收到 ${signal}，正在进行优雅退出...`);
    try {
        fsSync.appendFileSync(FILE_LOG_PATH, `[${ts}] [INFO] 收到 ${signal}，关闭所有浏览器实例...\n`);
    } catch {}
    let closed = 0;
    if (typeof activeBrowsers !== 'undefined' && activeBrowsers instanceof Map) {
        for (const [key, entry] of activeBrowsers) {
            if (entry && entry.browser && entry.browser.isConnected()) {
                try {
                    browserManagerModule.logBrowserClose(key, `服务退出(${signal})，优雅关闭全部浏览器`, 'puppeteer-api-server/gracefulShutdown');
                    await entry.browser.close();
                    closed++;
                } catch (e) {
                    try { fsSync.appendFileSync(FILE_LOG_PATH, `[${ts}] [WARN] 关闭浏览器 ${key} 时出错: ${e.message}\n`); } catch {}
                }
            }
        }
        activeBrowsers.clear();
    }
    console.log(`[${ts}] [INFO] ✅ 已关闭 ${closed} 个浏览器实例，正在退出...`);
    try {
        fsSync.appendFileSync(FILE_LOG_PATH, `[${ts}] [INFO] ✅ 已关闭 ${closed} 个浏览器实例，优雅退出完成\n`);
    } catch {}
    process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// Windows 下 taskkill 不带 /F 时也会发 SIGTERM，但如果是窗口关闭可以再加一层保障
if (process.platform === 'win32') {
    // 监听 stdin 的 end 事件（适用于管道关闭等场景）
    process.stdin.on('end', () => {
        if (process.stdin.isTTY) return; // 交互式终端不触发
        gracefulShutdown('stdin-end');
    });
}

// 🚀 日志缓冲：浏览器执行日志批量上报 D1
const LOG_BUFFER = [];
const LOG_BUFFER_MAX = 200;
let LOG_FLUSH_INTERVAL = null;

function _flushLogBuffer() {
    const items = LOG_BUFFER.splice(0, LOG_BUFFER_MAX);
    if (items.length === 0) return;
    const storageUrl = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
    const apiSecret = process.env.PUPPETEER_API_SECRET || '';
    const payload = { items };
    fetch(`${storageUrl}/api/logs/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
        body: JSON.stringify(payload)
    }).catch(() => {});
}

// 每 5 秒 flush 一次日志到 D1
setTimeout(() => {
    LOG_FLUSH_INTERVAL = setInterval(_flushLogBuffer, 5000);
}, 10000); // 等服务器启动后再开始 flush

// 修改 log() 函数，增加日志缓冲上报
const _origLog = log;
log = function(level, message, ...args) {
    _origLog(level, message, ...args);
    if (String(level).toUpperCase() === 'DEBUG') return;
    const formatted = args && args.length ? `${message} ${args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
    }).join(' ')}` : message;
    LOG_BUFFER.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        profile_id: '',
        level: level,
        message: formatted.substring(0, 1000)
    });
    if (LOG_BUFFER.length >= LOG_BUFFER_MAX) _flushLogBuffer();
};

// 🚀 数据库初始化已在 database.js 模块中处理


// 🚀 性能优化配置
const BROWSER_POOL_SIZE = 30; // 浏览器实例池大小（从20提升到30）
const MAX_CONCURRENT_LAUNCHES = parseInt(process.env.MAX_CONCURRENT_LAUNCHES || '5', 10); // 系统默认 5，可由 /api/config 动态修改

/**
 * 🚀 Windows 系统代理自动检测（读取注册表中的代理设置，支持 Astrill 等 VPN）
 * 当 S5_TUNNEL_PORT 为默认值 10808 且连接失败时，自动尝试检测 Windows 系统代理
 * 常见 VPN/代理端口: Astrill(3213,3205,6583,24152), Clash(7890,10808), V2Ray(10808), Shadowsocks(1080)
 */
async function _detectWindowsSystemProxy() {
    if (process.platform !== 'win32') return null;
    const net = require('net');
    
    // ⚡ 辅助函数：检测指定端口是否存活
    //    ⚠️ 不能用 socket.setTimeout 当 connect 超时：启动阶段事件循环常被同步重活
    //    （DB 初始化、execSync 读注册表等）阻塞超过 1.5s，此时「计时器到期」会排在
    //    「connect 已成功」事件之前被处理，把活着的端口误判成不可用。
    //    实测复现：发起探测后阻塞 2000ms → false；阻塞 800ms → true；阻塞后立刻重测 → true。
    //    所以改成 JS 计时器 + 有限重试。
    const _testPortOnce = (host, port) => new Promise(r => {
        const s = new net.Socket();
        let settled = false;
        let timer = null;
        const fin = (v) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { s.destroy(); } catch (e) {}
            r(v);
        };
        timer = setTimeout(() => fin(false), 1500);
        s.once('connect', () => fin(true));
        s.once('error', () => fin(false));
        s.connect(port, host);
    });
    // 首次探测可能正好撞上事件循环阻塞，连续 3 次都失败才认定不可用
    const _testPort = async (host, port) => {
        for (let i = 0; i < 3; i++) {
            if (await _testPortOnce(host, port)) return true;
            await new Promise(r => setTimeout(r, 150));
        }
        return false;
    };

    // 🔍 协议探测：判断这个端口说的是 SOCKS5 还是 HTTP 代理协议
    //    ⚠️ 原来下面的 return 把 type 写死成 'http'。但客户端配置差异很大：v2rayN / xray 的
    //    mixed 入站同一端口两种协议都支持，也有只开 SOCKS5 或只开 HTTP 的；写死会把隧道配错。
    //    单次探测返回 'yes' / 'no'（已拿到明确答复）/ 'unknown'（超时无响应）。
    const _probeOnce = (host, port, payload, isMatch, isDefinitelyNo) => new Promise((resolve) => {
        const s = new net.Socket();
        let buf = Buffer.alloc(0);
        let settled = false;
        let timer = null;
        const fin = (v) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { s.destroy(); } catch (e) {}
            resolve(v);
        };
        timer = setTimeout(() => fin('unknown'), 1500);
        s.once('error', () => fin('no'));
        s.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (isMatch(buf)) return fin('yes');
            if (isDefinitelyNo(buf)) return fin('no');
        });
        s.once('connect', () => s.write(payload));
        s.connect(port, host);
    });
    // 只有 'unknown'（超时无响应，多半又是事件循环被阻塞）才重试；拿到明确答复立刻定论
    const _probeWithRetry = async (fn, host, port) => {
        const r = await fn(host, port);
        if (r !== 'unknown') return r;
        await new Promise(x => setTimeout(x, 150));
        return await fn(host, port);
    };
    const _trySocks5 = (host, port) => _probeOnce(
        host, port,
        Buffer.from([0x05, 0x01, 0x00]),           // SOCKS5 免认证握手：版本5 + 1种方法 + 无认证
        (b) => b.length >= 2 && b[0] === 0x05,     // 应答首字节固定 0x05
        (b) => b.length >= 2 && b[0] !== 0x05
    );
    const _tryHttp = (host, port) => _probeOnce(
        host, port,
        // 目标故意指向必然连不上的本地端口：HTTP 代理会立刻回 4xx/5xx 状态行，无需真的出网
        Buffer.from('GET http://127.0.0.1:9/ HTTP/1.1\r\nHost: 127.0.0.1:9\r\nProxy-Connection: close\r\n\r\n'),
        (b) => /^HTTP\/\d\.\d/.test(b.toString('latin1')),
        (b) => b.length >= 16
    );
    const _detectProxyType = async (host, port) => {
        if (await _probeWithRetry(_trySocks5, host, port) === 'yes') return 'socks5';
        if (await _probeWithRetry(_tryHttp, host, port) === 'yes') return 'http';
        return 'http'; // 两种都探不出来时保持改动前的行为（原先写死 http）
    };
    
    const { execSync } = require('child_process');
    let detectedHost = '127.0.0.1', detectedPort = 10808;
    
    try {
        // 从 Windows 注册表读取系统代理设置
        const regOut = execSync(
            `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer`,
            { encoding: 'utf8', timeout: 3000 }
        ).toString();
        const match = regOut.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (match) {
            const proxyStr = match[1].trim();
            // 格式: "host:port" 或 "http=host:port;https=..." 或 "host:port"
            const httpMatch = proxyStr.match(/http=([^:;]+):(\d+)/i);
            if (httpMatch) {
                detectedHost = httpMatch[1];
                detectedPort = parseInt(httpMatch[2], 10);
            } else {
                const simpleMatch = proxyStr.match(/([^:;]+):(\d+)/);
                if (simpleMatch) {
                    detectedHost = simpleMatch[1];
                    detectedPort = parseInt(simpleMatch[2], 10);
                }
            }
            log('INFO', `🔌 注册表系统代理: ${proxyStr} → 解析为 ${detectedHost}:${detectedPort}`);
        }
    } catch (e) {
        log('DEBUG', `🔌 注册表代理检测: ${e.message}`);
    }
    
    // 尝试多个常见代理端口（优先级：注册表端口 > 常见VPN端口）
    const portsToTry = [
        detectedPort,
        3213,  // Astrill StealthVPN HTTP
        3205,  // Astrill OpenVPN HTTP
        6583,  // Astrill 旧版
        24152, // Astrill HTTPS/Web面板
        10808, // Clash/V2Ray SOCKS5
        7890,  // Clash HTTP
        1080,  // Shadowsocks
        8080,  // 通用HTTP代理
    ].filter((v, i, a) => a.indexOf(v) === i); // 去重
    
    for (const port of portsToTry) {
        if (detectedHost === '127.0.0.1' || detectedHost === 'localhost') {
            const alive = await _testPort(detectedHost, port);
            if (alive) {
                const type = await _detectProxyType(detectedHost, port);
                log('INFO', `🔌 检测到本地代理: ${detectedHost}:${port} (协议探测=${type})`);
                return { host: detectedHost, port, type };
            }
        } else {
            const alive = await _testPort(detectedHost, detectedPort);
            if (alive) {
                const type = await _detectProxyType(detectedHost, detectedPort);
                log('INFO', `🔌 检测到系统代理: ${detectedHost}:${detectedPort} (协议探测=${type})`);
                return { host: detectedHost, port: detectedPort, type };
            }
        }
    }
    
    log('INFO', `🔌 未检测到可用的本地代理，使用默认配置 127.0.0.1:10808`);
    return null;
}

// 启动时尝试自动检测 Windows 系统代理（如果 S5_TUNNEL_HOST:S5_TUNNEL_PORT 是默认值）
async function _autoDetectTunnelConfig() {
    // 只在默认配置时尝试自动检测
    if (S5_TUNNEL_HOST === '127.0.0.1' && S5_TUNNEL_PORT === 10808) {
        const detected = await _detectWindowsSystemProxy().catch(() => null);
        if (detected && detected.host && detected.port && detected.type) {
            S5_TUNNEL_HOST = detected.host;
            S5_TUNNEL_PORT = detected.port;
            if (S5_TUNNEL_TYPE === 'socks5') {
                S5_TUNNEL_TYPE = detected.type;
            }
            proxyTunnel.setS5TunnelConfig(S5_TUNNEL_HOST, S5_TUNNEL_PORT, S5_TUNNEL_TYPE);
            log('INFO', `🔌 已自动配置隧道: ${S5_TUNNEL_HOST}:${S5_TUNNEL_PORT} (type=${S5_TUNNEL_TYPE})`);
        }
    }
}
// 异步执行自动检测
_autoDetectTunnelConfig();
const MEMORY_CLEANUP_INTERVAL = 30000; // 30秒内存清理间隔（从60秒缩短）
// const BROWSER_PREWARM_COUNT = 2; // 🆕 预热浏览器实例数（已禁用）
const BROWSER_IDLE_TIMEOUT = 86400000; // 🆕 闲置浏览器回收时间(24小时，禁止自动关闭)
const MAX_BROWSER_SYSTEM_MEMORY_MB = 4096; // 🆕 所有浏览器进程总内存上限(4GB)

// 中间件
// 🚀 CORS：本机执行代理（9999）会被多个来源的前端调用 —— localhost 开发页、
//    Cloudflare Pages、以及宝塔上的正式后端域名。
//    origin: true = 反射请求方的 Origin，不再维护白名单（否则换个域名就得改一次）。
//    ⚠️ preflightContinue 必须为 true：cors 库默认会在 OPTIONS 时**直接结束响应**，
//    导致下面那个中间件跑不到 —— 于是 Chrome 私网访问（PNA）要求的
//    Access-Control-Allow-Private-Network 头就丢了，表现为
//    「https 页面 → http://localhost:9999」预检被浏览器拦下。
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Api-Secret'],
    preflightContinue: true
}));
// 私网访问与预检支持
app.use((req, res, next) => {
    if (req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Api-Secret');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});
app.use(express.json({ limit: '50mb' }));

// 🪶 借用型浏览器心跳：任何携带 profileId 的请求都会给该 profile 的「借用型浏览器」续期，
//    请求结束才开始计空闲；空闲满 BORROWED_IDLE_MS（默认 60s）由 browser-manager 强制关闭。
//    ⚠️ 必须注册在所有路由之前，否则挂在路由后面的中间件不会执行。
//    （touchBorrowedBrowser 内部还有一层保险丝：即使 finish/close 都没触发，也会自行释放，
//      避免掉线时这份续期计数泄漏、把浏览器名额永久占住。）
app.use((req, res, next) => {
    try {
        const pid = (req.body && (req.body.profileId || req.body.profile_id))
            || (req.query && (req.query.profileId || req.query.profile_id));
        if (pid) {
            const done = browserManagerModule.touchBorrowedBrowser(pid);
            if (done) {
                res.on('finish', done);
                res.on('close', done);
                req.on('close', done);      // 掉线/客户端 abort 时 res 的 finish 不一定触发，req 这条路要一起挂
                req.on('aborted', done);
            }
        }
    } catch {}
    next();
});
// 🔧 针对 JSON 解析错误的专用处理中间件（更清晰的400响应）
app.use((err, req, res, next) => {
    try {
        const isJsonParseError = err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && String(err.message || '').includes('JSON')));
        if (isJsonParseError) {
            try { log('ERROR', `❌ 请求体JSON解析失败: ${String(err && err.message || err)}`); } catch {}
            return res.status(400).json({ success: false, message: '请求体JSON解析失败', error: String(err.message || err) });
        }
    } catch {}
    try { const stack = String(err && err.stack || err); log('ERROR', `🔥 服务器错误: ${stack}`); } catch {}
    return next(err);
});

// 🚀 路由模块在此统一注册：必须位于 cors / express.json 中间件之后，否则请求体不会被解析、跨域头与私网头会丢失
registerBillingRoutes();
registerInsightsRoutes();
registerAssetRoutes();
registerAdposRoutes();
registerPageRoutes();
registerProfileRoutes();
// 🧵 任务队列路由 + 启动队列（会建表并恢复上次未跑完的任务）
jobQueue.registerRoutes(app);
jobQueue.init().catch((e) => log('ERROR', `🧵 [JobQueue] 初始化失败: ${e && e.message}`));

// 🚀 安全加固：校验 API 密钥（白名单路径免校验）
const publicPaths = ['/health', '/favicon.ico', '/robots.txt'];
app.use((req, res, next) => {
    // 🚀 放行 OPTIONS 预检请求
    if (req.method === 'OPTIONS') return next();
    // 🚀 放行白名单路径（健康检查、图标等）
    const pathname = req.url.split('?')[0];
    if (publicPaths.some(p => pathname === p || pathname.startsWith(p))) return next();
    
    if (API_SECRET) {
        const providedSecret = req.headers['x-api-secret'] || req.query.secret;
        if (providedSecret !== API_SECRET) {
            log('WARN', `🚫 拒绝未经授权的访问: ${req.method} ${req.url} IP: ${req.ip}`);
            return res.status(401).json({ success: false, message: 'Unauthorized: Invalid API Secret' });
        }
    }
    next();
});

// ===================== 值守队列（前端上报，AutoSync 只同步这些配置） =====================
const WATCH_ACTIVE_FILE = path.join(APP_ROOT, 'watch-active.json');
function readWatchActiveProfiles() {
    try {
        if (!fsSync.existsSync(WATCH_ACTIVE_FILE)) return [];
        const j = JSON.parse(fsSync.readFileSync(WATCH_ACTIVE_FILE, 'utf8'));
        const arr = Array.isArray(j) ? j : (Array.isArray(j && j.profileIds) ? j.profileIds : []);
        return arr.map(String).filter(Boolean);
    } catch (e) {
        return [];
    }
}
app.get('/api/watch-active', (req, res) => {
    res.json({ success: true, profileIds: readWatchActiveProfiles() });
});
app.post('/api/watch-active', (req, res) => {
    try {
        const body = req.body || {};
        let arr = Array.isArray(body.profileIds) ? body.profileIds : (Array.isArray(body) ? body : []);
        arr = arr.map(String).filter(Boolean);
        const uniq = [...new Set(arr)];
        fsSync.writeFileSync(WATCH_ACTIVE_FILE, JSON.stringify({ updatedAt: Date.now(), profileIds: uniq }, null, 2));
        log('INFO', `[WatchQueue] 值守队列已更新：${uniq.length} 个配置 [${uniq.join(',')}]`);
        res.json({ success: true, count: uniq.length });
    } catch (e) {
        res.status(500).json({ success: false, message: String(e && e.message || e) });
    }
});

// probeConnectivity 已移至 database.js 模块

// ensureAdAccountsTable 已移至 database.js 模块

// ensurePagesTable 已移至 database.js 模块

// ensureBusinessesTable 已移至 database.js 模块

// ensureAdsTable 已移至 database.js 模块

// ensurePaymentTokensTable 已移至 database.js 模块

// ensurePixelsTable 已移至 database.js 模块

// ensureAdTemplatesTable 已移至 database.js 模块

// loadProfilesFromFile 已移至 database.js 模块

// findProfileById 已移至 database.js 模块



// autoFillPasswordOnPage 已移至 database.js 模块

/**
 * 🚀 Facebook 广告发布 API
 */
app.post('/api/facebook/publish-ad', async (req, res) => {
    const { 
        profileId, campaignName, adSetName, adName, budget, adText, headline, websiteUrl, mediaBase64,
        countries, ageMin, ageMax, gender, placements, publishMethod,
        adAccountId, pageId, objective, budgetType, startDate, endDate,
        pixelIds, conversionEvent, enableVO, devicePlatforms, osType, osVersionMin, wifiOnly,
        ctaType, enableAICreative, adFormat, leadFormId, messengerWelcomeMessage, engagementType
    } = req.body;
    
    log('INFO', `🔥 [Profile=${profileId}] 收到广告发布请求: Campaign=${campaignName}, Method=${publishMethod || 'api'}, campaignTree长度=${req.body.campaignTree ? req.body.campaignTree.length : '无'}`);

    for (let retryAttempt = 1; retryAttempt <= 2; retryAttempt++) {
        if (retryAttempt > 1) {
            log('WARN', `[Profile=${profileId}] 浏览器断开，重新执行发布任务 (第${retryAttempt}次)...`);
            const bd = activeBrowsers.get(String(profileId));
            if (bd && bd.browser) try { await bd.browser.close(); } catch {}
            activeBrowsers.delete(String(profileId));
            await new Promise(r => setTimeout(r, 2000));
        }
        try {
        // 🚀 多系列支持：如果 campaignTree 有多个系列，逐个发布
        const campaignTree = req.body.campaignTree;
        if (campaignTree && Array.isArray(campaignTree) && campaignTree.length > 1) {
            log('INFO', `🔥 [Profile=${profileId}] campaignTree 有 ${campaignTree.length} 个系列，逐个发布...`);
            const allResults = [];
            let allSuccess = true;
            for (let ci = 0; ci < campaignTree.length; ci++) {
                const camp = campaignTree[ci];
                const campName = camp.name || `系列${ci + 1}`;
                log('INFO', `📦 [${ci + 1}/${campaignTree.length}] 发布系列: ${campName}`);
                
                const singleBody = {
                    ...req.body,
                    campaignTree: [{ ...camp }],
                    campaignName: campName,
                };
                
                try {
                    const result = await runFacebookPublishAdApi(singleBody);
                    // 「已有广告」是预期跳过（算成功）；token失效 / 无权访问 属于真失败，不能混进成功计数
                    const benignSkip = !!(result.skipped && result.skipReason === '已有广告');
                    if (result.skipped && !benignSkip) {
                        allSuccess = false;
                        allResults.push({ campaign: campName, success: false, skipped: true, error: result.error || result.message || '跳过发布' });
                        log('WARN', `⏭️ [Profile=${profileId}] [${ci + 1}/${campaignTree.length}] ${campName} 跳过（未发布）: ${result.error || result.message || ''}`);
                    } else if (result.success) {
                        allResults.push({ campaign: campName, success: true, skipped: !!result.skipped, adId: result.adId });
                        log('SUCCESS', `✅ [Profile=${profileId}] [${ci + 1}/${campaignTree.length}] ${campName} 成功: adId=${result.adId}`);
                    } else {
                        allSuccess = false;
                        allResults.push({ campaign: campName, success: false, error: result.error });
                        log('ERROR', `❌ [Profile=${profileId}] [${ci + 1}/${campaignTree.length}] ${campName} 失败: ${result.error}`);
                    }
                } catch (err2) {
                    allSuccess = false;
                    allResults.push({ campaign: campName, success: false, error: err2.message });
                    log('ERROR', `❌ [Profile=${profileId}] [${ci + 1}/${campaignTree.length}] ${campName} 异常: ${err2.message}`);
                }
            }
            const totalAds = allResults.length;
            const okCount = allResults.filter(r => r.success).length;
            log('INFO', `📊 [Profile=${profileId}] 多系列发布完成: ${okCount}/${totalAds} 成功`);
            if (okCount > 0) { postOperationSync(profileId, req.body.accessToken || req.body.adPublishData?.accounts?.[0]?.token, { syncAdAccounts: true }).catch(() => {}); }
            return res.json({ success: okCount === totalAds, total: totalAds, successCount: okCount, failCount: totalAds - okCount, results: allResults });
        }
        
        // 🚀 仅检查模式：不启动浏览器，直接检查广告账户
        if (req.body.onlyCheck) {
            const result = await runFacebookPublishAdApi(req.body);
            return res.json(result);
        }
        
        if (publishMethod === 'api' || !publishMethod) {
            // 🚀 核心改进：根据 launchBrowser 开关决定是否确保浏览器运行
            const launchBrowser = Boolean(req.body.launchBrowser !== false);
            if (launchBrowser) {
                log('INFO', `🤖 [Profile=${profileId}] 正在根据设置确保浏览器运行 (API 模式)...`);
                await ensureBrowserIsRunning(profileId);
            } else {
                log('INFO', `🤖 [Profile=${profileId}] 根据设置跳过浏览器启动 (仅 API 模式)`);
            }
            
            // 🚀 API 发布模式
            const result = await runFacebookPublishAdApi(req.body);
            if (result.success) {
                // 🐛 「跳过发布」不是「发布成功」：runFacebookPublishAdApi 跳过时返回
                //    `{success:true, skipped:true, skipReason?, error, total:0}`（见 facebook-ad-publish.js
                //    的「跳过发布」几处）。以前这里只判 result.success 就直接回「广告发布成功」，
                //    把 skipped 丢了 —— 于是 job-queue 里那段「已有广告=成功 / token失效·无权=失败」
                //    的区分逻辑永远进不去，一条广告都没发出去也显示「成功 1/1」。
                //    现在原样透传 skipped / skipReason / total，让上游按真实情况判定。
                if (result.skipped) {
                    log('WARN', `⏭️ [Profile=${profileId}] 跳过发布（未发出广告）: ${result.error || result.message || ''}`);
                    return res.json({
                        success: true,
                        skipped: true,
                        skipReason: result.skipReason || '',
                        total: result.total || 0,
                        message: result.message || result.error || '已跳过发布（未发出广告）',
                        error: result.error || result.message || '',
                    });
                }
                log('SUCCESS', `✅ [Profile=${profileId}] API 广告发布成功: AdID=${result.adId}`);
                postOperationSync(profileId, req.body.accessToken || req.body.adPublishData?.accounts?.[0]?.token, { syncAdAccounts: true }).catch(() => {});
                return res.json({ success: true, message: '广告发布成功', adId: result.adId });
            } else {
                log('ERROR', `❌ [Profile=${profileId}] API 广告发布失败: ${result.error}`);
                return res.status(500).json({ success: false, message: result.error || 'API 发布失败' });
            }
        }

        // 🤖 Puppeteer 模拟发布模式
        log('INFO', `🤖 [Profile=${profileId}] 正在启动浏览器进行模拟发布...`);
        const bResult = await ensureBrowserIsRunning(profileId);
        if (!bResult.success) throw new Error(bResult.error || '无法启动浏览器');
        
        const browser = bResult.browserData.browser;
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        const success = await runFacebookPublishAd(page, req.body, profileId);

        if (success) {
            log('SUCCESS', `✅ [Profile=${profileId}] 浏览器自动化发布成功`);
            return res.json({ success: true, message: '浏览器自动化发布成功' });
        } else {
            log('ERROR', `❌ [Profile=${profileId}] 浏览器自动化发布失败`);
            return res.status(500).json({ success: false, message: '浏览器自动化发布失败，请检查本地窗口' });
        }
        } catch (err) {
            const isBrowserDead = err && /Session closed|detached Frame|Protocol error|Target closed|Unable to find page|Page crashed/i.test(err.message);
            if (isBrowserDead && retryAttempt < 2) continue;
            log('ERROR', `❌ [Profile=${profileId}] 发布流程异常: ${err.message}`);
            res.status(500).json({ success: false, message: err.message });
            return;
        }
        break;
    }
});

// 🚀 批量发布：接收完整 campaignTree，逐个处理每个系列->广告组->广告
app.post('/api/facebook/batch-publish', async (req, res) => {
    const { profileId, campaignTree, publishMethod } = req.body;
    // 🚀 读取数量控制，每个系列无独立值时使用全局默认值
        const globalCampaignCount = parseInt(req.body.campaignCount) || 1;
        const adSetCount = parseInt(req.body.adSetCount) || 1;
        const adCount = parseInt(req.body.adCount) || 1;
    log('INFO', `🔥 [Profile=${profileId}] 收到批量发布请求: ${(campaignTree || []).length} 个系列 (per-campaign counts: ${(campaignTree || []).map(c => parseInt(c.campaignCount) || 1).join(',')})`);
    // 🚀 诊断：打印每个系列的名称，确认前端确实发送了所有系列
    if (campaignTree && Array.isArray(campaignTree)) {
        for (let di = 0; di < campaignTree.length; di++) {
            const dc = campaignTree[di];
            log('INFO', `  📋 [诊断] 系列[${di + 1}]: name="${dc.name}", campaignCount=${dc.campaignCount || globalCampaignCount}, adSets=${(dc.adSets || []).length}, ads总计=${(dc.adSets || []).reduce((s, as) => s + (as.ads || []).length, 0)}`);
        }
    }
    
    for (let retryAttempt = 1; retryAttempt <= 2; retryAttempt++) {
        if (retryAttempt > 1) {
            log('WARN', `[Profile=${profileId}] 浏览器断开，重新执行批量发布任务 (第${retryAttempt}次)...`);
            const bd = activeBrowsers.get(String(profileId));
            if (bd && bd.browser) try { await bd.browser.close(); } catch {}
            activeBrowsers.delete(String(profileId));
            await new Promise(r => setTimeout(r, 2000));
        }
        try {
            if (!campaignTree || !Array.isArray(campaignTree) || campaignTree.length === 0) {
                return res.status(400).json({ success: false, message: 'campaignTree 为空' });
            }
        
        const launchBrowser = req.body.launchBrowser !== false;
        if (launchBrowser) {
            await ensureBrowserIsRunning(profileId).catch(() => log('WARN', '启动浏览器异常，继续发布...'));
        }
        
        const allResults = [];
        let totalSuccess = 0;
        let totalFail = 0;
        let totalProcessed = 0;
        
        // 🚀 遍历树中每个系列（作为模板），使用每个系列自己的 campaignCount
        for (let ci = 0; ci < campaignTree.length; ci++) {
            const campaign = campaignTree[ci];
            const baseCampaignName = campaign.name || `系列${ci + 1}`;
            const perCampaignCount = parseInt(campaign.campaignCount) || globalCampaignCount; // 🚀 每个系列独立数量，未设置则用全局默认
            
            for (let cc = 0; cc < perCampaignCount; cc++) {
                const curCampaignName = perCampaignCount > 1 ? `${baseCampaignName}_${cc + 1}` : baseCampaignName;
                log('INFO', `🚀 [Profile=${profileId}] 处理系列 [${ci + 1}/${campaignTree.length}] 副本 ${cc + 1}/${perCampaignCount}: ${curCampaignName}`);
                
                const adSets = campaign.adSets || [];
                for (let si = 0; si < adSets.length; si++) {
                    const adSet = adSets[si];
                    const baseAdSetName = adSet.name || `广告组${si + 1}`;
                    
                    for (let sc = 0; sc < adSetCount; sc++) {
                        const curAdSetName = (adSetCount > 1 && globalCampaignCount > 1) ? `${baseAdSetName}_${sc + 1}` :
                                              adSetCount > 1 ? `${baseAdSetName}_${sc + 1}` : baseAdSetName;
                        
                        const ads = adSet.ads || [];
                        for (let ai = 0; ai < ads.length; ai++) {
                            const ad = ads[ai];
                            const baseAdName = ad.name || `广告${ai + 1}`;
                            
                            for (let ac = 0; ac < adCount; ac++) {
                                const curAdName = adCount > 1 ? `${baseAdName}_${ac + 1}` : baseAdName;
                                
                                const singleData = {
                                    ...req.body,
                                    campaignTree: [{
                                        ...campaign,
                                        name: curCampaignName,
                                        adSets: [{
                                            ...adSet,
                                            name: curAdSetName,
                                            ads: [ad]
                                        }]
                                    }],
                                    campaignName: curCampaignName,
                                    adSetName: curAdSetName,
                                    adName: curAdName,
                                    campaignCount: 1,
                                    adSetCount: 1,
                                    adCount: 1,
                                    budget: campaign.budget,
                                    objective: campaign.objective,
                                    budgetLevel: campaign.budgetLevel,
                                    budgetType: campaign.budgetType,
                                    startDate: campaign.startDate,
                                    endDate: campaign.endDate,
                                    // 🚀 每个广告独立的字段：如果 ad 节点没有设置，fallback 到 req.body 的全局值
                                    adText: ad.adText || req.body.adText,
                                    headline: ad.headline || req.body.headline,
                                    websiteUrl: ad.websiteUrl || req.body.websiteUrl,
                                    ctaType: ad.ctaType || req.body.ctaType,
                                    pixelIds: ad.pixelIds || req.body.pixelIds,
                                    conversionEvent: ad.conversionEvent || req.body.conversionEvent,
                                    mediaBase64: ad._mediaBase64 || null,
                                    adStatus: ad.adStatus || req.body.adStatus,
                                };
                                
                                totalProcessed++;
                                try {
                                    log('INFO', `📦 [Profile=${profileId}] [${totalProcessed}] 发布: ${curCampaignName} -> ${curAdSetName} -> ${curAdName}`);
                                    const result = await runFacebookPublishAdApi(singleData);
                                    if (result.success) {
                                        totalSuccess++;
                                        allResults.push({ campaign: curCampaignName, adSet: curAdSetName, ad: curAdName, success: true, adId: result.adId });
                                    } else {
                                        totalFail++;
                                        allResults.push({ campaign: curCampaignName, adSet: curAdSetName, ad: curAdName, success: false, error: result.error });
                                        log('ERROR', `❌ [Profile=${profileId}] ${curCampaignName} -> ${curAdSetName} -> ${curAdName} 失败: ${result.error}`);
                                    }
                                } catch (err) {
                                    totalFail++;
                                    allResults.push({ campaign: curCampaignName, adSet: curAdSetName, ad: curAdName, success: false, error: err.message });
                                    log('ERROR', `❌ [Profile=${profileId}] ${curCampaignName} -> ${curAdSetName} -> ${curAdName} 异常: ${err.message}`);
                                }
                                
                                // 每条广告间隔 1 秒
                                 await new Promise(r => setTimeout(r, 1000));
                            }
                        }
                    }
                }
            }
        }
        
        log('INFO', `📊 [Profile=${profileId}] 批量发布完成: 共${totalProcessed}条, ${totalSuccess} 成功, ${totalFail} 失败`);
        return res.json({ 
            success: totalFail === 0, 
            total: totalProcessed,
            successCount: totalSuccess,
            failCount: totalFail,
            results: allResults 
        });
        } catch (err) {
            const isBrowserDead = err && /Session closed|detached Frame|Protocol error|Target closed|Unable to find page|Page crashed/i.test(err.message);
            if (isBrowserDead && retryAttempt < 2) continue;
            log('ERROR', `❌ [Profile=${profileId}] 批量发布异常: ${err.message}`);
            res.status(500).json({ success: false, message: err.message });
            return;
        }
        break;
    }
});

/** 🚀 Facebook Graph API 广告发布核心逻辑 — 已迁移至 facebook-ad-publish.js */


// 📊 性能监控
let launchCount = 0;
let successCount = 0;
let errorCount = 0;
let totalLaunchTime = 0;

// 🚀 注入主文件的依赖到健康检查模块并注册路由
__injectHealth({
    log,
    activeBrowsers,
    browserManager,
    launchQueueManager,
    // 🔍 借用型浏览器的占位明细（inFlight / idleForMs）。
    //    ⚠️ 以前这里漏传了这一个，health-diagnostics 里的默认实现是 `() => ({})`，
    //    于是 /api/stats 的 borrowedBrowsers 永远返回空对象 —— 明明写了统计函数却看不见，
    //    「占位降不下来」这类问题就完全没法排查（分不清是没人归还、还是 inFlight 计数泄漏）。
    borrowedBrowserStats,
    getLaunchCount: () => launchCount,
    getSuccessCount: () => successCount,
    getErrorCount: () => errorCount,
    getTotalLaunchTime: () => totalLaunchTime,
    S5_TUNNEL_HOST,
    S5_TUNNEL_PORT,
    S5_TUNNEL_TYPE,
    socksChainServer,
    proxyTunnel,
});
registerHealthRoutes(app);

// 🚀 注入主文件的依赖到浏览器路由模块并注册路由
__injectBrowserRoutes({ log, app, launchCount, successCount, errorCount, totalLaunchTime });
registerBrowserRoutes();

// 🚀 注入主文件的依赖到 Google Ads 路由模块并注册路由
__injectGoogleAdsRoutes({ log, app });
registerGoogleAdsRoutes();
// 🚀 注入主文件的依赖到调试/DevTools/RPA 路由模块并注册路由
__injectDebugRoutes({ log, app, dbPath });
registerDebugRoutes();
// 🚀 注入主文件的依赖到配置文件 CRUD 路由模块并注册路由
__injectProfileCrudRoutes({ log, app, dbPath, ensureAdAccountsTable });
registerProfileCrudRoutes();
// 共享状态和辅助函数已移至 browser-manager.js

// 🆕 浏览器预热器 — 预先启动浏览器进程，减少冷启动时间（已禁用：无效机制）
// const browserPrewarmer = {
//     _prewarmedCount: 0,
//     _timer: null,
//     async start() {
//         log('INFO', `🔥 浏览器预热器启动，目标预热量: ${BROWSER_PREWARM_COUNT}`);
//         // 不阻塞服务启动，延迟预热
//         setTimeout(() => this._prewarm(), 5000);
//         // 每5分钟检查一次，维持预热池
//         this._timer = setInterval(() => this._maintainPool(), 300000);
//     },
//     async _prewarm() {
//         while (this._prewarmedCount < BROWSER_PREWARM_COUNT) {
//             if (launchQueueManager.isOverloaded()) {
//                 log('DEBUG', '🔥 系统负载较高，暂停预热');
//                 break;
//             }
//             try {
//                 await launchQueueManager.add(async () => {
//                     // 查找系统已安装的 Chrome/Edge（避免使用不存在的内置 Chromium）
//                     const chromePath = findChromeExecutable();
//                     if (!chromePath) {
//                         log('WARN', '🔥 未找到系统 Chrome/Edge，跳过预热');
//                         this._prewarmedCount = BROWSER_PREWARM_COUNT; // 标记完成，不再重试
//                         return;
//                     }
//                     // 创建一个轻量级浏览器实例，无UI、无导航
//                     const browser = await puppeteer.launch({
//                         executablePath: chromePath,
//                         headless: true,
//                         args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-features=ProcessReuse'],
//                         timeout: 15000,
//                     });
//                     this._prewarmedCount++;
//                     log('INFO', `🔥 预热浏览器 #${this._prewarmedCount} 就绪 (PID: ${browser.process()?.pid || 'N/A'})`);
//                     // 立即关闭，主要目的是让 Chrome 进程加载到系统缓存
//                     await browser.close();
//                 }, -1); // 低优先级
//             } catch (e) {
//                 log('WARN', `🔥 预热失败: ${e.message}`);
//                 break;
//             }
//         }
//     },
//     async _maintainPool() {
//         this._prewarmedCount = 0; // 重置计数，下次预热会重新创建
//         this._prewarm();
//     },
//     stop() {
//         if (this._timer) clearInterval(this._timer);
//     }
// };








app.post('/api/facebook/adaccounts', async (req, res) => {
    try {
        const { profileId, skip_browser } = req.body || {};
        let accounts = [];
        let fbPages = [];
        let fbBMs = [];
        let fbPixels = [];
        let token = req.body.token || '';
        
        // 1. 查找 Profile
        const profile = await findProfileById(profileId);
        if (!token && profile?.token) token = profile.token;

        // 2. 如果有 Token，使用 Graph API 获取(纯服务端 fetch，无需浏览器)
        if (token && String(token).length > 10) {
            console.log(`[AdAccounts] Trying full Graph API fetch for profile ${profileId}`);
            try {
                const base = 'https://graph.facebook.com/v21.0';
                const encToken = encodeURIComponent(token);
                const acctFields = 'account_id,id,name,account_status,currency,timezone_id,timezone_name,timezone_offset_hours_utc,business_country_code,amount_spent,balance,spend_cap,min_daily_budget,funding_source_details,business{id,name},promotable_pages{id,name,fan_count,is_published,verification_status,access_token}';
                const [acctRes, pagesRes, bmsRes, pixelsRes] = await Promise.all([
                    fetch(`${base}/me/adaccounts?fields=${acctFields}&limit=100&access_token=${encToken}`).then(r => r.json()),
                    fetch(`${base}/me/accounts?fields=id,name,fan_count,link,category,access_token&limit=100&access_token=${encToken}`).then(r => r.json()),
                    fetch(`${base}/me/businesses?fields=id,name,verification_status,link&limit=100&access_token=${encToken}`).then(r => r.json()),
                    fetch(`${base}/me/adaccounts?fields=adspixels{id,name},datasets{id,name}&limit=100&access_token=${encToken}`).then(r => r.json()).catch(() => ({}))
                ]);
                
                if (acctRes && !acctRes.error && Array.isArray(acctRes.data)) accounts = acctRes.data;
                if (pagesRes && !pagesRes.error && Array.isArray(pagesRes.data)) fbPages = pagesRes.data;
                if (bmsRes && !bmsRes.error && Array.isArray(bmsRes.data)) fbBMs = bmsRes.data;
                
                // 从 pixelsRes 提取像素
                if (pixelsRes && pixelsRes.data) {
                    pixelsRes.data.forEach(acc => {
                        if (acc.adspixels?.data) acc.adspixels.data.forEach(px => fbPixels.push({ id: px.id, name: px.name, account_id: acc.id.replace('act_', '') }));
                        if (acc.datasets?.data) acc.datasets.data.forEach(ds => fbPixels.push({ id: ds.id, name: ds.name, account_id: acc.id.replace('act_', ''), is_dataset: true }));
                    });
                }
                // 从 accounts 的 adspixels/datasets 中再提取（兜底）
                if (fbPixels.length === 0) {
                    accounts.forEach(acc => {
                        if (acc.adspixels?.data) acc.adspixels.data.forEach(px => fbPixels.push({ id: px.id, name: px.name, account_id: acc.account_id || acc.id?.replace('act_', '') }));
                        if (acc.datasets?.data) acc.datasets.data.forEach(ds => fbPixels.push({ id: ds.id, name: ds.name, account_id: acc.account_id || acc.id?.replace('act_', ''), is_dataset: true }));
                    });
                }
                
                console.log(`[AdAccounts] Graph API success: ${accounts.length} accounts, ${fbPages.length} pages, ${fbBMs.length} BMs, ${fbPixels.length} pixels`);
            } catch (e) {
                console.error(`[AdAccounts] Graph API fetch error:`, e.message);
            }
        }

        // 2b. 如果没有 Token 或 Graph API 没拿到数据，用浏览器
        if ((!accounts.length || !token) && !skip_browser) {
            let browserRef = null;
            let browserData = activeBrowsers.get(profileId);
            
            if (browserData && browserData.browser && browserData.browser.isConnected()) {
                browserRef = browserData.browser;
            } else {
                try {
                    console.log(`[AdAccounts] Launching browser for profile ${profileId}...`);
                    const prof = await findProfileById(profileId);
                    const userDataDir = browserManager.getUnifiedUserDataDir(profileId, undefined, extractEmailPrefix(prof?.accountEmail || prof?.account_email));
                    const config = {
                        profileId, userDataDir, debugPort: 0,
                        proxy: prof?.proxy, userAgent: prof?.userAgent,
                        windowTitle: String(profileId || ''),
                        emailPrefix: extractEmailPrefix(prof?.accountEmail || prof?.account_email)
                    };
                    if (prof?.account?.cookies && typeof prof.account.cookies === 'string' && prof.account.cookies.length > 5) {
                        config.cookies = prof.account.cookies;
                    }
                    const browserInstance = await browserManager.getBrowser(config);
                    browserRef = browserInstance.browser;
                    activeBrowsers.set(profileId, { browser: browserRef, profileId, startTime: Date.now(), debugPort: browserInstance.debugPort || 9222 });
                } catch (launchErr) {
                    console.error(`[AdAccounts] Failed to launch browser:`, launchErr);
                }
            }

            if (browserRef && browserRef.isConnected()) {
                // 提取 Token（如果还没有）
                if (!token || token.length < 10) {
                    try {
                        const pages = await browserRef.pages();
                        let page = pages.find(p => /facebook\.com/i.test(p.url()) && !p.url().includes('login') && !p.url().includes('checkpoint'));
                        if (!page) { page = await browserRef.newPage(); await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); }
                        await new Promise(r => setTimeout(r, 3000));
                        // 🚀 通过 CDP 网络拦截提取 Token（不依赖 JS 执行）
                        token = await extractFbToken(page, 8000);

                        // 🚀 Token 提取失败 → 检测是否在登录页（通过 page.url + page.content，不依赖 JS 执行）
                        if (!token || !token.startsWith('EAA')) {
                            const currentUrl = page.url() || '';
                            let hasPassField = false;
                            let bodyText = '';
                            try { bodyText = await page.content().catch(() => ''); hasPassField = bodyText.includes('input') && bodyText.includes('password'); } catch {}
                            const isLoginPage = /login/i.test(currentUrl) || /checkpoint/i.test(currentUrl) || hasPassField || bodyText.includes('Log in') || bodyText.includes('登录');

                            if (isLoginPage) {
                                console.log(`[AdAccounts] Cookie 失效，检测到登录页面，执行自动登录...`);
                                // 获取密码
                                const profForLogin = await findProfileById(String(profileId)).catch(() => null);
                                const loginPw = profForLogin?.accountPassword || profForLogin?.account_password || '';
                                
                                if (hasPassField && loginPw) {
                                    // 用 Puppeteer page.type 填入密码（不依赖 JS 执行）
                                    try {
                                        await page.type('input[type="password"]', loginPw, { delay: 50 });
                                    } catch {}
                                    await new Promise(r => setTimeout(r, 500));
                                }
                                
                                // Tab + Enter 提交
                                await page.keyboard.press('Tab');
                                await new Promise(r => setTimeout(r, 300));
                                await page.keyboard.press('Tab');
                                await new Promise(r => setTimeout(r, 300));
                                await page.keyboard.press('Enter');
                                await new Promise(r => setTimeout(r, 5000));
                                
                                // 🚀 导航到广告管理后台触发 API 请求（包含 access_token），CDP 才能拦截到
                                try {
                                    await page.goto('https://adsmanager.facebook.com/adsmanager/manage/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                                    await new Promise(r => setTimeout(r, 3000));
                                } catch {}

                                // 登录后通过 CDP 网络拦截提取 Token
                                token = await extractFbToken(page, 10000);

                                if (token && token.startsWith('EAA')) {
                                    console.log(`[AdAccounts] 登录后成功提取 Token: ${token.slice(0, 15)}...`);
                                } else {
                                    console.log(`[AdAccounts] 自动登录后仍无法提取 Token`);
                                }
                            } else {
                                console.log(`[AdAccounts] 不在登录页面，无法提取 Token`);
                            }
                        }
                    } catch (e) { console.error(`[AdAccounts] Token extraction failed:`, e.message); }
                }

                // 有 Token 就用浏览器 Tab 并行请求完整数据
                if (token && token.startsWith('EAA')) {
                    const encToken = encodeURIComponent(token);
                    const baseUrl = 'https://graph.facebook.com/v21.0';
                    const acctFields = 'account_id,id,name,account_status,currency,timezone_id,timezone_name,timezone_offset_hours_utc,business_country_code,amount_spent,balance,spend_cap,min_daily_budget,funding_source_details,business{id,name},promotable_pages{id,name,fan_count,is_published,verification_status,access_token}';
                    
                    let accountsPage, pagesPage, bmsPage, pixelsPage;
                    try {
                        [accountsPage, pagesPage, bmsPage, pixelsPage] = await Promise.all([
                            browserRef.newPage(), browserRef.newPage(), browserRef.newPage(), browserRef.newPage()
                        ]);
                        const [acctRes, pgRes, bmRes] = await Promise.all([
                            accountsPage.goto(`${baseUrl}/me/adaccounts?fields=${acctFields}&limit=100&access_token=${encToken}`, { waitUntil: 'networkidle0', timeout: 30000 })
                                .then(() => accountsPage.evaluate(() => document.body.innerText || '{}')).then(c => JSON.parse(c)),
                            pagesPage.goto(`${baseUrl}/me/accounts?fields=id,name,fan_count,link,category,access_token&limit=100&access_token=${encToken}`, { waitUntil: 'networkidle0', timeout: 30000 })
                                .then(() => pagesPage.evaluate(() => document.body.innerText || '{}')).then(c => JSON.parse(c)),
                            bmsPage.goto(`${baseUrl}/me/businesses?fields=id,name,verification_status,link&limit=100&access_token=${encToken}`, { waitUntil: 'networkidle0', timeout: 30000 })
                                .then(() => bmsPage.evaluate(() => document.body.innerText || '{}')).then(c => JSON.parse(c)),
                        ]);
                        if (acctRes && !acctRes.error && Array.isArray(acctRes.data)) accounts = acctRes.data;
                        if (pgRes && !pgRes.error && Array.isArray(pgRes.data)) fbPages = pgRes.data;
                        if (bmRes && !bmRes.error && Array.isArray(bmRes.data)) fbBMs = bmRes.data;
                        
                        try {
                            const pxRes = await pixelsPage.goto(`${baseUrl}/me/adaccounts?fields=adspixels{id,name},datasets{id,name}&limit=100&access_token=${encToken}`, { waitUntil: 'networkidle0', timeout: 20000 })
                                .then(() => pixelsPage.evaluate(() => document.body.innerText || '{}')).then(c => JSON.parse(c));
                            if (pxRes && pxRes.data) {
                                pxRes.data.forEach(acc => {
                                    if (acc.adspixels?.data) acc.adspixels.data.forEach(px => fbPixels.push({ id: px.id, name: px.name, account_id: acc.id.replace('act_', '') }));
                                    if (acc.datasets?.data) acc.datasets.data.forEach(ds => fbPixels.push({ id: ds.id, name: ds.name, account_id: acc.id.replace('act_', ''), is_dataset: true }));
                                });
                            }
                        } catch {}
                        // 从 accounts 中再提取
                        if (fbPixels.length === 0) {
                            accounts.forEach(acc => {
                                if (acc.adspixels?.data) acc.adspixels.data.forEach(px => fbPixels.push({ id: px.id, name: px.name, account_id: acc.account_id }));
                                if (acc.datasets?.data) acc.datasets.data.forEach(ds => fbPixels.push({ id: ds.id, name: ds.name, account_id: acc.account_id, is_dataset: true }));
                            });
                        }
                    } finally {
                        for (const p of [accountsPage, pagesPage, bmsPage, pixelsPage].filter(Boolean)) { try { await p.close(); } catch {} }
                    }
                } else {
                    // 无 Token，退回到 adsmanager 爬虫模式（仅获取广告号）
                    let page = null;
                    try {
                        page = await browserRef.newPage();
                        await page.goto('https://adsmanager.facebook.com/adsmanager/manage/accounts', { waitUntil: 'networkidle2', timeout: 35000 }).catch(() => {});
                        const scraped = await page.evaluate(() => {
                            const list = [];
                            const add = (name, id) => { if (name || id) list.push({ name, account_id: id }); };
                            document.querySelectorAll('a[href*="act="]').forEach(a => {
                                const href = a.getAttribute('href') || '';
                                const m = href.match(/act[_=](\d{6,})/i);
                                add((a.closest('[role="row"]') || a.closest('div'))?.textContent?.trim() || '', m ? m[1] : null);
                            });
                            if (!list.length) {
                                document.querySelectorAll('[role="row"]').forEach(r => {
                                    const nameEl = r.querySelector('[role="gridcell"], a, span');
                                    const linkEl = r.querySelector('a[href*="act="]');
                                    const href = linkEl?.getAttribute('href') || '';
                                    const m = href.match(/act[_=](\d{6,})/i);
                                    add(nameEl?.textContent?.trim() || '', m ? m[1] : null);
                                });
                            }
                            return list;
                        });
                        if (scraped?.length) accounts = scraped;
                    } catch(e) { console.error(`[AdAccounts] Scraping failed:`, e); }
                    try { if (page) await page.close(); } catch {}
                }
            }
        }

        // 3. 保存到本地数据库
        if (accounts.length) {
            const sdb = new sqlite3.Database(dbPath);
            await ensureAdAccountsTable(sdb);
            const timestamp = new Date().toISOString();
            for (const a of accounts) {
                // ⚠️ 主键格式必须与 /api/facebook/fetch-adaccounts-graph 保持一致（act_<数字>）：
                //    之前这里写的是纯数字，导致同一广告号以两种 id 各存一行（库里出现两条相同账号）
                const rawActId = String(a.account_id || a.id || '').replace(/^act_/, '');
                const idv = rawActId ? `act_${rawActId}` : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
                await new Promise((resolve) => {
                    sdb.run(`INSERT OR REPLACE INTO ad_accounts (id, profile_id, platform, account_id, name, status, currency, timezone_id, spend, country, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [idv, String(profileId || ''), 'Meta (Facebook/Instagram)',
                         rawActId, String(a.name || ''), String(a.account_status || a.status || 'Unknown'),
                         String(a.currency || ''), String(a.timezone_id || ''), 0, String(a.business_country_code || '')],
                        () => resolve());
                });
            }
            // 同步 pages 到本地
            if (fbPages.length) {
                await ensurePagesTable(sdb);
                for (const p of fbPages) {
                    // ⚠️ 同上：主键统一为 page_<数字>，避免与主路径写出重复行
                    const rawPageId = String(p.id || '').replace(/^page_/, '');
                    await new Promise((resolve) => {
                        sdb.run(`INSERT OR REPLACE INTO pages (id, profile_id, page_id, name, fan_count, link, category, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                            [`page_${rawPageId}`, String(profileId), rawPageId, String(p.name || ''), Number(p.fan_count || 0),
                             String(p.link || ''), String(p.category || '')],
                            () => resolve());
                    });
                }
            }
            // 同步 pixels 到本地（🚀 确保 account_id 写入正确的纯数字格式）
            if (fbPixels.length) {
                await ensurePixelsTable(sdb);
                for (const px of fbPixels) {
                    // ⚠️ 同上：主键统一为 pixel_<数字>，避免与主路径写出重复行
                    const rawPixelId = String(px.id || '').replace(/^pixel_/, '');
                    const rawAccountId = String(px.account_id || px.id || '').replace(/^act_/, '');
                    await new Promise((resolve) => {
                        sdb.run(`INSERT OR REPLACE INTO pixels (id, profile_id, pixel_id, account_id, name, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                            [`pixel_${rawPixelId}`, String(profileId), rawPixelId, rawAccountId, String(px.name || ''), 'ACTIVE'],
                            () => resolve());
                    });
                }
            }
            // 同步 BMs 到本地
            if (fbBMs.length) {
                await ensureBusinessesTable(sdb);
                for (const bm of fbBMs) {
                    await new Promise((resolve) => {
                        sdb.run(`INSERT OR REPLACE INTO businesses (id, profile_id, business_id, name, verification_status, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                            [String(bm.id), String(profileId), String(bm.id), String(bm.name || ''), String(bm.verification_status || '')],
                            () => resolve());
                    });
                }
            }
            sdb.close();
        }

        // 同步 Token 到 Profile 表
        if (token && token.startsWith('EAA')) {
            try {
                const sdb = new sqlite3.Database(dbPath);
                await new Promise((resolve, reject) => {
                    sdb.run(`UPDATE profiles SET account_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR ext_id = ?`, [token, profileId, profileId], (err) => { sdb.close(); err ? reject(err) : resolve(); });
                });
            } catch (e) { console.error(`[AdAccounts] Failed to save token:`, e.message); }
        }

        // 🚀 同步像素/主页/BM 到线上 D1
        try {
            const d1Url = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
            const d1ApiSecret = process.env.PUPPETEER_API_SECRET || '';
            
            if (fbPixels.length > 0) {
                const pixelItems = fbPixels.map(px => ({
                    id: `pixel_${px.id}`,
                    pixel_id: px.id,
                    name: px.name,
                    status: 'ACTIVE',
                    account_id: px.account_id || '',
                    profile_id: profileId
                }));
                await fetch(`${d1Url}/api/pixels/bulk-save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': d1ApiSecret },
                    body: JSON.stringify({ items: pixelItems })
                });
                console.log(`[AdAccounts] D1 sync: ${fbPixels.length} pixels synced to cloud`);
            }
            if (fbPages.length > 0) {
                const pageItems = fbPages.map(p => ({
                    // ⚠️ 与主路径保持一致：云端主键也用 page_<数字>
                    id: `page_${String(p.id || '').replace(/^page_/, '')}`, page_id: String(p.id || '').replace(/^page_/, ''),
                    name: p.name, fan_count: p.fan_count || 0,
                    link: p.link || '', category: p.category || '', profile_id: profileId
                }));
                await fetch(`${d1Url}/api/pages/bulk-save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': d1ApiSecret },
                    body: JSON.stringify({ items: pageItems })
                });
                console.log(`[AdAccounts] D1 sync: ${fbPages.length} pages synced to cloud`);
            }
            if (fbBMs.length > 0) {
                const bmItems = fbBMs.map(bm => ({
                    id: bm.id, business_id: bm.id, name: bm.name,
                    verification_status: bm.verification_status || '', profile_id: profileId
                }));
                await fetch(`${d1Url}/api/businesses/bulk-save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': d1ApiSecret },
                    body: JSON.stringify({ items: bmItems })
                });
                console.log(`[AdAccounts] D1 sync: ${fbBMs.length} BMs synced to cloud`);
            }
        } catch (d1Err) {
            console.warn(`[AdAccounts] D1 sync failed:`, d1Err.message);
        }

        // 🚀 同步广告账户到远程存储（旧版 handler 缺失）
        if (accounts.length > 0) {
            try {
                const sBase = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
                const apiSecret = process.env.PUPPETEER_API_SECRET || '';
                const items = accounts.map(a => ({
                    id: `act_${a.account_id || a.id}`,
                    account_id: a.account_id || a.id,
                    name: a.name || '',
                    account_status: a.account_status || a.status || 'Unknown',
                    currency: a.currency || '',
                    timezone_id: a.timezone_id || '',
                    business_country_code: a.business_country_code || '',
                    spend: 0,
                    profile_id: profileId,
                    profile_name: ''
                }));
                await fetch(`${sBase}/api/adaccounts/bulk-save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
                    body: JSON.stringify({ items })
                });
                console.log(`[AdAccounts] Remote sync: ${items.length} adaccounts synced to cloud`);
            } catch (syncErr) {
                console.warn(`[AdAccounts] Remote sync failed:`, syncErr.message);
            }
        }

        return res.json({ success: true, data: accounts, count: accounts.length, pages: fbPages, pagesCount: fbPages.length, bms: fbBMs, bmCount: fbBMs.length, pixels: fbPixels, pixelsCount: fbPixels.length, token });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});



function runAdposAutoRefreshScheduler(){
    try {
        setInterval(async ()=>{
            try {
                const sdb = new sqlite3.Database(dbPath)
                await ensureAdposPrefs(sdb)
                const rows = await new Promise((resolve)=>{ sdb.all(`SELECT profile_id, auto_refresh, auto_save_local FROM adpos_prefs WHERE auto_refresh = 1`, (err, r)=> resolve(err?[]:(r||[]))) })
                await new Promise(r=>sdb.close(r))
                for (const row of rows) {
                    try {
                        const tokenObj = await tokenProvider.requestPaymentManagementToken({ profileId: '', adAccountId: '' })
                        const token = String(tokenObj && tokenObj.token || '')
                        if (!token) { continue }
                        const now = Math.floor(Date.now()/1000)
                        const start = now - 2*60*60
                        const per = 200
                        const qs = `per_page=${per}&start_timestamp=${start}&end_timestamp=${now}`
                        const tj = await adposFetch(`/transactions?${qs}`, token, process.env.ADPOS_API_BASE_URL)
                        const txns = Array.isArray(tj && tj.data) ? tj.data : []
                        if (Number(row.auto_save_local||0) === 1 && txns.length) {
                            const sdb2 = new sqlite3.Database(dbPath)
                            await ensureAdposTables(sdb2)
                            for (const t of txns) {
                                const id = String(t.id || '')
                                const amount = Number(t.amount || 0)
                                const currency = String(t.currency || '')
                                const status = String(t.status || '')
                                const created_at = String(t.created_at || t.date || '')
                                const card_id = String(t.card_id || '')
                                const last4 = String(t.last_four_digits || t.card_last4 || '')
                                if (!id) continue
                                await new Promise((resolve, reject)=>{ sdb2.run(`INSERT OR REPLACE INTO adpos_transactions (id, amount, currency, status, created_at, card_id, last_four_digits) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, amount, currency, status, created_at, card_id, last4], err => (err ? reject(err) : resolve())) })
                            }
                            await new Promise(r=>sdb2.close(r))
                        }
                    } catch {}
                }
            } catch {}
        }, 60000)
    } catch {}
}

runAdposAutoRefreshScheduler()


/**
 * 🚀 仅获取卡号列表（轻量 API）- 直接导航到 billing_hub 提取，不走 FetchAdAccounts
 */

/**
 * 🚀 手动付款 API - 通过 Puppeteer 打开 billing_hub 执行付款
 */


/**
 * 🚀 手动付款 API - 通过 Puppeteer 打开 billing_hub 执行付款
 */



/**
 * 🚀 信用卡绑定 API - 通过 Puppeteer 真实填入信用卡信息
 */


// 触发当前浏览器页面上的验证按钮点击




// 自动填写支付验证的验证码（支持两段金额或单段验证码）

// 验证账单中的卡片（根据 last4 匹配并点击“验证/Verify”按钮），保持窗口不关闭





// 启动浏览器逻辑修改：
// headless: false 确保弹出窗口
// defaultViewport: null 确保窗口最大化
// 这样用户可以看到浏览器启动并执行操作
// ----------------------------------------




// 获取广告账户列表 (Graph API) - 纯浏览器方案



// 获取账单设置信息（国家、货币、时区）



// 广告账户：更改货币/时区/国家
// Facebook timezone_id 映射表 (常用时区名 → FB 内部 ID)
const FB_TIMEZONE_MAP = {
  'Pacific/Midway': -11, 'Pacific/Honolulu': -10, 'America/Anchorage': -9,
  'America/Los_Angeles': -8, 'America/Denver': -7, 'America/Chicago': -6,
  'America/New_York': -5, 'America/Caracas': -4, 'America/Sao_Paulo': -3,
  'America/Noronha': -2, 'Atlantic/Azores': -1, 'Europe/London': 0,
  'Europe/Paris': 1, 'Europe/Helsinki': 2, 'Europe/Moscow': 3,
  'Asia/Dubai': 4, 'Asia/Karachi': 5, 'Asia/Kolkata': 5.5,
  'Asia/Dhaka': 6, 'Asia/Bangkok': 7, 'Asia/Shanghai': 8,
  'Asia/Tokyo': 9, 'Australia/Sydney': 10, 'Pacific/Noumea': 11,
  'Pacific/Auckland': 12
};
// 反转：偏移小时 → 最接近的时区名
const FB_TIMEZONE_BY_OFFSET = {};
for (const [name, offset] of Object.entries(FB_TIMEZONE_MAP)) {
  const key = String(offset);
  if (!FB_TIMEZONE_BY_OFFSET[key]) FB_TIMEZONE_BY_OFFSET[key] = [];
  FB_TIMEZONE_BY_OFFSET[key].push(name);
}


// 🚀 简化版：通过绑卡 GraphQL API 修改账单地址国家/货币/时区（复用 billing/add 逻辑）
// 有卡信息则绑卡+改账单国家，无卡则仅保存到本地



// [tryUpdateBillingCountrySmart 已移至 facebook-billing.js]


// 🚀 修改 Facebook 语言（调用已有的 ensureFbLanguage 函数）

// 广告账户：设置限额（spend_cap）

// 广告账户：充值（仅记录 amount_spent 累加到设置表）

// 广告账户：批量管理（系列/组/广告）— 按照 v21.0 规范实现
const assetManagementHandler = (kind) => async (req, res) => {
  try {
    const { profileId, adAccountId, assetId, action } = req.body || {}
    if (!profileId || !assetId) return res.status(400).json({ success: false, message: 'missing profileId/assetId' })
    
    const profile = await findProfileById(profileId);
    if (!profile) throw new Error('未找到该环境配置');

    let method = 'POST';
    let data = null;
    let endpoint = assetId;

    switch (action) {
      case 'start':
      case 'ACTIVE':
        data = { status: 'ACTIVE' };
        break;
      case 'stop':
      case 'PAUSED':
        data = { status: 'PAUSED' };
        break;
      case 'archive':
      case 'ARCHIVED':
        data = { status: 'ARCHIVED' };
        break;
      case 'delete':
        method = 'DELETE';
        break;
      default:
        throw new Error(`不支持的操作: ${action}`);
    }

    log('INFO', `🚀 [Profile=${profileId}] 正在对 ${kind} ${assetId} 执行操作: ${action}`);
    const result = await callFacebookGraphApi(endpoint, method, data, profile);
    
    if (result.success || result.id) {
        log('SUCCESS', `✅ [Profile=${profileId}] ${kind} ${assetId} ${action} 成功`);
        return res.json({ success: true, result });
    } else {
        throw new Error(result.error?.message || '操作失败');
    }
  } catch (e) { 
    log('ERROR', `❌ [Profile=${req.body?.profileId}] ${kind} 操作失败: ${e.message}`);
    return res.status(500).json({ success: false, message: String(e.message || e) });
  }
}

app.post('/api/facebook/adaccounts/campaigns/manage', assetManagementHandler('campaign'))
app.post('/api/facebook/adaccounts/adsets/manage', assetManagementHandler('adset'))
app.post('/api/facebook/adaccounts/ads/manage', assetManagementHandler('ad'))

// 保持兼容性的旧路由
app.post('/api/facebook/adaccounts/campaigns/start', (req, res) => { req.body.action = 'start'; return assetManagementHandler('campaign')(req, res); })
app.post('/api/facebook/adaccounts/campaigns/stop', (req, res) => { req.body.action = 'stop'; return assetManagementHandler('campaign')(req, res); })
app.post('/api/facebook/adaccounts/adsets/start', (req, res) => { req.body.action = 'start'; return assetManagementHandler('adset')(req, res); })
app.post('/api/facebook/adaccounts/adsets/stop', (req, res) => { req.body.action = 'stop'; return assetManagementHandler('adset')(req, res); })
app.post('/api/facebook/adaccounts/ads/start', (req, res) => { req.body.action = 'start'; return assetManagementHandler('ad')(req, res); })
app.post('/api/facebook/adaccounts/ads/stop', (req, res) => { req.body.action = 'stop'; return assetManagementHandler('ad')(req, res); })

// 🚀 浏览器浏览 / Facebook 广告图书馆查询 API（AI 工具 browse_ads_library 使用）
// 在指定配置的可见浏览器中新建标签页打开页面（默认 Facebook 广告图书馆），读取首屏文本与广告链接返回给 AI 汇报
app.post('/api/facebook/browse', async (req, res) => {
  try {
    const { profileId, url, q, country } = req.body || {};
    if (!profileId) return res.status(400).json({ success: false, message: '缺少 profileId' });

    const run = await ensureBrowserIsRunning(String(profileId));
    if (!run.success) throw new Error(run.error || '无法启动/获取该配置的浏览器');
    const browser = run.browserData && run.browserData.browser;
    if (!browser || !browser.isConnected()) throw new Error('浏览器尚未就绪');

    // 组装目标地址：显式 url 优先；否则带关键词的广告图书馆搜索页；否则广告图书馆首页
    let target = String(url || '').trim();
    if (!target) {
      if (q) {
        const params = new URLSearchParams({
          active_status: 'all',
          ad_type: 'all',
          country: String(country || 'ALL'),
          q: String(q),
          media_type: 'all',
        });
        target = `https://www.facebook.com/ads/library/?${params.toString()}`;
      } else {
        target = 'https://www.facebook.com/ads/library/';
      }
    }
    if (!/^https?:\/\//i.test(target)) throw new Error('仅支持 http/https 地址');

    log('INFO', `🌐 [Profile=${profileId}] browse → ${target}`);
    const page = await browser.newPage();
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40000 });
    } catch (e) {
      log('WARN', `🌐 [Profile=${profileId}] 页面加载等待超时/失败，继续读取已渲染内容: ${e.message}`);
    }
    // 等待 FB 前端渲染
    await sleep(6000);

    const result = await page.evaluate(() => {
      const pick = (el) => (el && typeof el.innerText === 'string' ? el.innerText.trim() : '');
      let bodyText = pick(document.body);
      if (bodyText.length > 6000) bodyText = bodyText.slice(0, 6000);
      const seen = new Set();
      const links = [];
      const anchors = document.querySelectorAll('a[href]');
      for (const a of anchors) {
        const href = (a.getAttribute('href') || '').trim();
        if (!/ads\/library|ad_library/i.test(href)) continue;
        const txt = pick(a).replace(/\s+/g, ' ').slice(0, 200);
        if (!txt) continue;
        const key = href.split('?')[0];
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ href, text: txt });
        if (links.length >= 25) break;
      }
      const h = document.querySelector('h1, h2');
      return { heading: pick(h), bodyText, links };
    });

    const title = await page.title().catch(() => '');
    log('INFO', `✅ [Profile=${profileId}] browse 完成: ${title || target} (links=${(result.links || []).length})`);
    return res.json({
      success: true,
      title,
      url: page.url(),
      heading: result.heading,
      textSample: result.bodyText,
      links: result.links,
      note: '已在可见浏览器中打开该页面；如需翻页/点击广告，可在弹出的浏览器窗口中继续操作。',
    });
  } catch (e) {
    log('ERROR', `❌ [Profile=${req.body && req.body.profileId}] browse 失败: ${e.message}`);
    return res.status(500).json({ success: false, message: String(e.message || e) });
  }
});

// [postOperationSync 已移至 facebook-billing.js]
app.use((err, req, res, next) => {
    console.error('🔥 服务器错误:', err);
    
    res.status(500).json({
        success: false,
        message: '服务器内部错误',
        error: err.message,
        timestamp: new Date().toISOString()
    });
});

// 🚀 服务器启动逻辑已移至文件末尾

// 🕐 定期清理任务 - 已禁用自动清理功能
// setInterval(async () => {
//     try {
//         await browserManager.cleanupIdleInstances();
//         
//         // 内存使用检查
//         const memUsage = process.memoryUsage();
//         const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
//         
//         if (memMB > 500) { // 超过500MB时警告
//             console.warn(`⚠️ 内存使用较高: ${memMB}MB`);
//             
// ✅ 启用浏览器自动清理：定期回收空闲实例和内存
setInterval(async () => {
    try {
        const stats = await browserManager.cleanupIdleInstances();
    } catch (error) {
        console.error('❌ 定期清理任务失败:', error);
    }
}, MEMORY_CLEANUP_INTERVAL);

// ✅ 启动浏览器预热器，加速首次启动（已禁用：无效的预热机制）
// setTimeout(() => {
//     browserPrewarmer.start().catch(e => log('WARN', `🔥 预热器启动失败: ${e.message}`));
// }, 2000);

// ⛔ 这里以前「又」注册了一个 SIGINT handler，走的是 browser.disconnect()（只断 CDP 连接，
//    Chrome 进程继续跑）+ activeBrowsers.clear() + process.exit(0)。
//    两个 handler 收到信号后会同时开跑，而它总先跑完并 exit —— 于是上面 gracefulShutdown 里
//    那批 await browser.close() 全部没机会执行。实测日志：125 次退出只有 74 次打出「优雅退出完成」，
//    而这 74 次的关闭数**全是 0**（地图已被这里 clear 掉），等于每次退出都在留一堆孤儿 Chrome。
//    现在统一交给上面的 gracefulShutdown 处理，本处不再注册第二个 SIGINT。

// 🚀 启动优化后的服务器
let server;

// 检查是否启用 HTTPS
const ENABLE_HTTPS = process.env.ENABLE_HTTPS === 'true';
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '9443', 10);
const EFFECTIVE_HTTPS_PORT = (Number(HTTPS_PORT) === Number(process.env.PUPPETEER_PORT || process.env.PORT || 9999)) ? 9443 : HTTPS_PORT;

// 🚀 服务启动日志：包含版本/时间戳，方便用户确认重启
const SERVER_VERSION = "1.0.5";
const START_TIME = new Date().toLocaleString();
console.log(`\n==================================================`);
console.log(`🚀 OmniFingerprint API Server v${SERVER_VERSION} 正在启动...`);
console.log(`⏰ 启动时间: ${START_TIME}`);
console.log(`📡 监听端口: ${PORT}`);
console.log(`📂 日志路径: ${FILE_LOG_PATH}`);
console.log(`==================================================\n`);

// 🚀 Facebook 资产管理路由已移至 facebook-asset-management.js 模块

// -------------------------------------------------------
// 6. 通过 Puppeteer + Session 绑卡（支持同时修改货币/时区）
// POST /api/facebook/billing/bind-card-puppeteer
// Body: { profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC, ccIso, currency, timezone_id }
// -------------------------------------------------------

// -------------------------------------------------------
// 6b. 通过模拟页面表单操作绑卡（填写支付设置页面的表单，让 Facebook 触发 e2ee 加密）
// POST /api/facebook/billing/bind-card-form
// Body: { profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC, ccIso, cardholderName }
// -------------------------------------------------------

// -------------------------------------------------------
// 7. 创建主页并自动授权给 BM (组合方法)
// POST /api/facebook/pages/create-and-grant
// Body: { profileId, name, category, businessId, accessToken }

// -------------------------------------------------------
// Debug: 在当前页面填写并提交卡号
// -------------------------------------------------------
// 🚀 提取浏览器会话令牌：从运行的浏览器获取 fbDtsg + cookies + token
// POST /api/facebook/session-tokens
// Body: { profileId }
// -------------------------------------------------------
// -------------------------------------------------------
// 🚀 提取 Facebook binder/GraphQL doc_ids：从 billing_hub 页面提取所有可用的 doc_id
// POST /api/facebook/billing/extract-docids
// Body: { profileId }
// -------------------------------------------------------
// -------------------------------------------------------
// 🚀 直接 API 绑卡：使用提取的会话令牌直接调用 Facebook GraphQL
// POST /api/facebook/billing/bind-card-direct
// Body: { profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC, ccIso, cardholderName, billingStreet, billingCity, billingZip }
// -------------------------------------------------------
// 🚀 页面和广告账户授权路由已移至 facebook-asset-management.js 模块

// 🧹 启动清扫（整个进程只做一次）：把上一轮服务残留的「孤儿」浏览器进程和单例锁清掉。
//    为什么需要：只有 Ctrl+C/SIGTERM 才会走 gracefulShutdown；被 taskkill /F、任务管理器
//    结束进程、崩溃、断电时根本没有任何 handler 机会，Chrome 就永久留在 browser-profiles/<pid> 下：
//    · 每组残留 ≈ 15 个进程，白占内存
//    · 占着 profile 目录 → 下次启动同配置直接 "browser is already running"
//    · 占着调试端口 9222 → 后续启动 devtools 起不来
//    安全性：killAllResidualBrowsers 只杀「父进程已不存在」的进程，所以哪怕此刻有别的实例
//    正在正常服务，它的浏览器（父进程是活着的 node）也不会被误伤。
let _residualSwept = false;
function sweepResidualBrowsersOnce() {
    if (_residualSwept) return;
    _residualSwept = true;
    try {
        const killed = browserManagerModule.killAllResidualBrowsers(BROWSER_PROFILES_ROOT);
        if (killed.length) log('WARN', `🧹 启动清扫：清理了 ${killed.length} 个上一轮残留的孤儿浏览器进程 (PIDs=${killed.join(',')})`);
        else log('INFO', `🧹 启动清扫：未发现孤儿浏览器进程`);
        // ⚠️ 必须在杀进程之后：否则会删掉还活着的浏览器的锁
        const removed = browserManagerModule.cleanAllStaleLocks(BROWSER_PROFILES_ROOT);
        if (removed) log('WARN', `🧹 启动清扫：清理了 ${removed} 个残留的单例锁文件`);
    } catch (e) {
        log('WARN', `🧹 启动清扫失败: ${e && e.message}`);
    }
}
sweepResidualBrowsersOnce();

// 🔎 自检：190 自动恢复钩子到底装上没有。
//    以前这段恢复逻辑因为宿主没注入 refreshProfileToken 而整体静默失效（连日志都没有），
//    排查时只能靠读代码；这里在启动日志里明确写一行，以后一眼可辨。
//    ⚠️ 不能放在上面的 __inject 处打印：那里 log() 依赖的 logLevels/FILE_LOG_PATH 等 const 还没初始化，
//       调用会抛 ReferenceError 并被 safeLog 的 try/catch 吞掉。
log('INFO', `🔑 [TokenRefresh] 190 自动恢复钩子: ${fbGraph.isRefreshTokenHookArmed() ? '已注册' : '❌ 未注册'}`);

if (ENABLE_HTTPS) {
    try {
        // 读取 SSL 证书
        const privateKey = fsSync.readFileSync(path.join(APP_ROOT, 'puppeteer-key.pem'), 'utf8');
        const certificate = fsSync.readFileSync(path.join(APP_ROOT, 'puppeteer-cert.pem'), 'utf8');
        
        const credentials = { key: privateKey, cert: certificate };
        
        // 创建 HTTPS 服务器
        server = https.createServer(credentials, app);
        server.listen(EFFECTIVE_HTTPS_PORT, '0.0.0.0', () => {
            const actualPort = (server && typeof server.address === 'function' && server.address()) ? server.address().port : EFFECTIVE_HTTPS_PORT;
            log('INFO', `🚀 Puppeteer HTTPS 服务已启动在端口 ${actualPort}`);
            log('INFO', `📊 健康检查: http://localhost:${actualPort}/health`);
            log('INFO', `🌐 启动浏览器: http://localhost:${actualPort}/api/launch-browser`);
            log('INFO', `📈 性能监控: http://localhost:${actualPort}/api/stats`);
            log('INFO', `🎯 日志级别: ${process.env.LOG_LEVEL || 'INFO'}`);
            log('INFO', `🔒 HTTPS 模式已启用`);
            
            if (Number(actualPort) !== Number(EFFECTIVE_HTTPS_PORT)) {
                log('WARN', `⚠️ 警告: 服务启动在端口 ${actualPort}，而不是预期的 ${EFFECTIVE_HTTPS_PORT}`);
            }
        });
    } catch (error) {
        log('ERROR', `❌ HTTPS 启动失败: ${error.message}`);
        log('INFO', `🔄 回退到 HTTP 模式...`);
        
        // 回退到 HTTP
        server = app.listen(PORT, '0.0.0.0', () => {
            const actualPort = (server && typeof server.address === 'function' && server.address()) ? server.address().port : PORT;
            log('INFO', `🚀 Puppeteer HTTP 服务已启动在端口 ${actualPort}`);
            log('INFO', `📊 健康检查: http://localhost:${actualPort}/health`);
            log('INFO', `🌐 启动浏览器: http://localhost:${actualPort}/api/launch-browser`);
            log('INFO', `📈 性能监控: http://localhost:${actualPort}/api/stats`);
            log('INFO', `🎯 日志级别: ${process.env.LOG_LEVEL || 'INFO'}`);
            
            if (actualPort !== PORT) {
                log('WARN', `⚠️ 警告: 服务启动在端口 ${actualPort}，而不是预期的 ${PORT}`);
            }
        });
    }
} else {
    // HTTP 模式
    server = app.listen(PORT, '0.0.0.0', () => {
        const actualPort = (server && typeof server.address === 'function' && server.address()) ? server.address().port : PORT;
        log('INFO', `🚀 Puppeteer HTTP 服务已启动在端口 ${actualPort}`);
        log('INFO', `📊 健康检查: http://localhost:${actualPort}/health`);
        log('INFO', `🌐 启动浏览器: http://localhost:${actualPort}/api/launch-browser`);
        log('INFO', `📈 性能监控: http://localhost:${actualPort}/api/stats`);
        log('INFO', `🎯 日志级别: ${process.env.LOG_LEVEL || 'INFO'}`);
        
        if (actualPort !== PORT) {
            log('WARN', `⚠️ 警告: 服务启动在端口 ${actualPort}，而不是预期的 ${PORT}`);
        }
    });
}

server.on('error', (err) => {
    const currentPort = ENABLE_HTTPS ? HTTPS_PORT : PORT;
    if (err.code === 'EADDRINUSE') {
        log('ERROR', `❌ 端口 ${currentPort} 已被占用，请检查其他服务`);
        process.exit(1);
    } else {
        log('ERROR', `❌ 服务器启动失败: ${err.message}`);
        process.exit(1);
    }
});

// ============================= 半实时自动同步（贴文 + 消息对话） =============================
// 每 N 分钟自动对本地配置执行一次“获取信息”中的贴文/收件箱对话抓取并同步云端。
// 开关：MSG_AUTO_SYNC_ENABLED=0 关闭；间隔：MSG_AUTO_SYNC_MINUTES（默认 10）；
// 首次延迟：MSG_AUTO_SYNC_FIRST_SEC（默认 60）；只同步部分配置：MSG_AUTO_SYNC_PROFILES=id1,id2
let _autoSyncRunning = false;
let _autoSyncTimer = null;
let _autoSyncCursor = 0; // 轮转指针：每轮最多处理 MSG_AUTO_SYNC_ROUND_MAX 个配置，避免一轮启动过多浏览器
let _autoSyncHadProfiles = false; // 记录上一轮是否有可同步配置，用于“空→有”状态变化日志
async function autoSyncMessagesOnce() {
    const flag = String(process.env.MSG_AUTO_SYNC_ENABLED || '1');
    if (flag === '0' || flag === 'false' || flag === 'off') return;
    if (_autoSyncRunning) return;
    _autoSyncRunning = true;
    try {
        // 🚀 只同步「值守队列」中的配置（前端把监听主页/对话的 profileId 上报到 /api/watch-active）：
        // 不再无条件扫描本地 browser-profiles 下所有目录，避免已删除/残留配置仍被扫描产生日志。
        // 旧行为（同步全部本地目录）可通过 .env 设置 MSG_AUTO_SYNC_PROFILES 白名单或 MSG_AUTO_SYNC_ALL_LOCAL=1 恢复。
        let profiles = [];
        const only = String(process.env.MSG_AUTO_SYNC_PROFILES || '').split(',').map(s => String(s).trim()).filter(Boolean);
        const scanAllLocal = String(process.env.MSG_AUTO_SYNC_ALL_LOCAL || '0') === '1';
        const activeProfiles = scanAllLocal ? [] : readWatchActiveProfiles();
        try {
            const entries = fsSync.readdirSync(BROWSER_PROFILES_ROOT, { withFileTypes: true });
            const allLocal = entries
                .filter(en => en.isDirectory() && /^\d{4,}$/.test(en.name))
                .map(en => ({ id: en.name }))
                .sort((a, b) => Number(a.id) - Number(b.id));
            if (scanAllLocal) {
                profiles = allLocal;
            } else if (only.length) {
                profiles = allLocal.filter(p => only.includes(String(p.id)));
            } else {
                // 仅同步值守队列中且本地仍存在目录的配置
                profiles = allLocal.filter(p => activeProfiles.includes(String(p.id)));
            }
        } catch (e) {
            profiles = [];
        }
        if (only.length) profiles = profiles.filter(p => only.includes(String(p.id)));
        if (!profiles.length) {
            // 队列为空/白名单为空：静默跳过，不产生逐配置日志（仅在状态由“有→空”时输出一次）
            if (_autoSyncHadProfiles) {
                log('INFO', `[AutoSync] 值守队列已清空，本轮无待同步配置，后续自动静默跳过`);
                _autoSyncHadProfiles = false;
            }
            return;
        }
        if (!_autoSyncHadProfiles) {
            _autoSyncHadProfiles = true;
            log('INFO', `[AutoSync] 值守队列存在 ${profiles.length} 个配置，开始自动同步（仅同步值守中的配置）`);
        }
        // 轮转限流：默认每轮最多同步 10 个（可 MSG_AUTO_SYNC_ROUND_MAX 调整；指定 MSG_AUTO_SYNC_PROFILES 时不受限）
        if (!only.length && profiles.length > 1) {
            const cap = Math.max(1, parseInt(process.env.MSG_AUTO_SYNC_ROUND_MAX || '10', 10) || 10);
            if (profiles.length > cap) {
                const start = _autoSyncCursor % profiles.length;
                profiles = profiles.slice(start).concat(profiles.slice(0, start)).slice(0, cap);
                _autoSyncCursor = (start + cap) % profiles.length;
            }
        }
        const svcPort = (typeof ENABLE_HTTPS !== 'undefined' && ENABLE_HTTPS) ? (typeof EFFECTIVE_HTTPS_PORT !== 'undefined' ? EFFECTIVE_HTTPS_PORT : PORT) : PORT;
        const svcProto = (typeof ENABLE_HTTPS !== 'undefined' && ENABLE_HTTPS) ? 'https' : 'http';
        // 清理注册表里已断开的残留条目，避免「幽灵实例」占满并发名额
        try {
            for (const [key, entry] of activeBrowsers) {
                try { if (!entry || !entry.browser || !entry.browser.isConnected()) activeBrowsers.delete(key); } catch { activeBrowsers.delete(key); }
            }
        } catch (e) {
            log('DEBUG', `[AutoSync] 清理残留实例失败: ${e.message}`);
        }
        log('INFO', `[AutoSync] 开始无浏览器收件箱同步 ${profiles.length} 个配置（仅同步存有 FB token 的配置，全程不弹窗口）`);
        for (const p of profiles) {
            const pid = String((p && (p.id || p.profileId)) || '');
            if (!pid) continue;
            try {
                const r = await fetch(`${svcProto}://127.0.0.1:${svcPort}/api/facebook/sync-inbox`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                    body: JSON.stringify({ profileId: pid, onlyUnread: true }),
                });
                let j = null;
                try { j = await r.json(); } catch {}
                if (j && j.success && j.skipped) {
                    log('INFO', `[AutoSync] ${pid} 跳过（${j.skipped === 'no-browser-running' ? '浏览器未运行' : '无 FB token'}）`);
                    continue;
                }
                const cc = j && typeof j.conversations === 'number' ? j.conversations : null;
                log('INFO', `[AutoSync] ${pid} 收件箱同步完成 conversations=${cc == null ? '?' : cc}${j && j.success ? '' : (j && j.message ? ` (失败: ${j.message})` : ` (HTTP ${r.status})`)}`);
            } catch (e) {
                log('WARN', `[AutoSync] ${pid} 同步异常: ${e.message}`);
            }
        }
        log('INFO', `[AutoSync] 本轮自动同步结束`);
    } catch (e) {
        log('WARN', `[AutoSync] 自动同步整体异常: ${e.message}`);
    } finally {
        _autoSyncRunning = false;
    }
}
function startAutoSyncScheduler() {
    try {
        const flag = String(process.env.MSG_AUTO_SYNC_ENABLED || '1');
        if (flag === '0' || flag === 'false' || flag === 'off') { log('INFO', `[AutoSync] 已通过 MSG_AUTO_SYNC_ENABLED=0 关闭`); return; }
        const intervalMs = Math.max(2, parseInt(process.env.MSG_AUTO_SYNC_MINUTES || '10', 10) || 10) * 60000;
        const firstMs = Math.max(10, parseInt(process.env.MSG_AUTO_SYNC_FIRST_SEC || '60', 10) || 60) * 1000;
        if (_autoSyncTimer) clearInterval(_autoSyncTimer);
        setTimeout(() => { autoSyncMessagesOnce(); }, firstMs);
        _autoSyncTimer = setInterval(() => { autoSyncMessagesOnce(); }, intervalMs);
        log('INFO', `[AutoSync] 已启动：首次 ${Math.round(firstMs / 1000)}s 后执行，之后每 ${intervalMs / 60000} 分钟同步一次`);
    } catch (e) {
        log('WARN', `[AutoSync] 调度器启动失败: ${e.message}`);
    }
}
setTimeout(startAutoSyncScheduler, 5000);


