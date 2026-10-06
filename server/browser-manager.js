// 🚀 浏览器管理器模块 — 从 puppeteer-api-server.js 提取
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const proxyTunnel = require('./proxy-tunnel');
const { parseProxy, _createSocksTunnel, _createLocalSocks5AuthForwarder, _createLocalHttpAuthForwarder, _testDirectReachable, sshTunnelManager, socksChainServer, _proxyTunnels, _registerProxyResource } = proxyTunnel;
// 🧬 设备画像：按 profileId 生成互相自洽的 os/platform/分辨率/GPU/核数/内存/语言
const { normalizeProfileFingerprint, buildUserAgentMetadata } = require('./fingerprint-profiles');

// --- 从主文件引入的常量（在模块中重定义 / 从环境变量读取） ---
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO'; // DEBUG, INFO, WARN, ERROR
const logLevels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname; // 与 puppeteer-api-server.js 同目录
const FILE_LOG_PATH = path.join(APP_ROOT, 'logs', 'service.log');
const BROWSER_PROFILES_ROOT = process.env.BROWSER_PROFILES_ROOT || path.join(APP_ROOT, 'browser-profiles');
const API_SECRET = process.env.PUPPETEER_API_SECRET || '';
const MAX_CONCURRENT_LAUNCHES = parseInt(process.env.MAX_CONCURRENT_LAUNCHES || '5', 10);
let S5_TUNNEL_HOST = process.env.S5_TUNNEL_HOST || '127.0.0.1';
let S5_TUNNEL_PORT = parseInt(process.env.S5_TUNNEL_PORT || '10808', 10);
let S5_TUNNEL_TYPE = (process.env.S5_TUNNEL_TYPE || 'socks5').toLowerCase();
const BROWSER_IDLE_TIMEOUT = 86400000; // 🆕 闲置浏览器回收时间(24小时，禁止自动关闭)
const SCREENSHOT_DIR = path.join(APP_ROOT, 'logs', 'screenshots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 🌍 代理出口时区探测缓存（key = **代理身份** -> { tz, ts }）
//    配置里没写 timezone 时，用浏览器自己（已经挂在代理上）查一次出口 IP 的时区。
//    ⚠️ 以前按 profileId 缓存 —— 同一个配置换了代理以后仍会复用旧时区，时区就不再"跟着代理走"了。
//    改成按代理身份缓存：换代理 = 换 key = 自动重新探测，时区始终对应当前代理的出口。
const _detectedTimezoneCache = new Map();
// 🌍 探测失败的负缓存（key = 代理身份 -> 时间戳）。
//    探测失败时要白等一个超时；以前每次启动都重试，等于每次启动都白亏一次超时。
const _tzFailCache = new Map();
const TZ_CACHE_TTL_MS = 24 * 3600 * 1000;   // 成功结果缓存 24 小时
const TZ_FAIL_TTL_MS = 10 * 60 * 1000;      // 失败后 10 分钟内不再重试
const TZ_PROBE_TIMEOUT_MS = parseInt(process.env.TZ_PROBE_TIMEOUT_MS || '2500', 10);

// 🔁 代理「直连不可达」负缓存（key = 代理身份 -> 时间戳）
//    直连可达性检测超时 3000ms，而「不可达、要走隧道」才是常态 —— 每次启动都实测撞满 3s
//    （日志里就是恰好 3.007s）。这里记下不可达结果，之后一段时间内直接建隧道。
//    只缓存「不可达」：万一代理后来恢复了，最坏也只是继续走隧道，功能不受影响，不会更糟。
const _directReachCache = new Map();
const DIRECT_REACH_TTL_MS = 10 * 60 * 1000;

/** 代理身份键（同类型同 host:port 视为同一出口）—— 时区缓存与直连可达性缓存共用 */
function proxyTzKey(proxy) {
    if (!proxy || !proxy.host || !proxy.port) return 'direct';
    return `${String(proxy.type || 'http').toLowerCase()}://${proxy.host}:${proxy.port}`;
}

// 🔖 书签：新配置是全新目录，不注入的话每次都得手工加。
//    在 Chrome 启动**之前**（此刻还没占用该目录）补齐；已存在且内容一致就不写盘。
const BOOKMARKLET_NAME = 'Omni 广告工具箱';
const BOOKMARKLET_FILE = path.join(__dirname, 'assets', 'omnifingerprint-bookmarklet.txt');
const FB_BOOKMARK_GROUP = 'FB广告管理';
// FB 广告管理常用页面（中文名称 → URL）
const FB_BOOKMARKS = [
    ['广告管理工具', 'https://adsmanager.facebook.com/adsmanager/manage/campaigns'],
    ['广告组', 'https://adsmanager.facebook.com/adsmanager/manage/adsets'],
    ['广告', 'https://adsmanager.facebook.com/adsmanager/manage/ads'],
    ['广告账户', 'https://adsmanager.facebook.com/adsmanager/manage/accounts'],
    ['账单与支付', 'https://adsmanager.facebook.com/adsmanager/manage/billing'],
    ['广告报告', 'https://adsmanager.facebook.com/adsmanager/reporting'],
    ['受众管理', 'https://adsmanager.facebook.com/adsmanager/audiences'],
    ['像素与事件', 'https://business.facebook.com/events_manager2'],
    ['商品目录', 'https://business.facebook.com/commerce'],
    ['商务管理平台', 'https://business.facebook.com/settings'],
    ['商务信息', 'https://business.facebook.com/settings/business_info'],
    ['支付设置', 'https://business.facebook.com/latest/billing_hub/payment_settings/'],
    ['账户品质', 'https://business.facebook.com/accountquality/'],
    ['广告资料库', 'https://www.facebook.com/ads/library'],
    ['我的公共主页', 'https://www.facebook.com/pages/?category=your_pages'],
    ['创建公共主页', 'https://www.facebook.com/pages/create'],
    ['Facebook 首页', 'https://www.facebook.com/'],
];
let _bookmarkletUrl = null;
let _bookmarkletLoaded = false;
function getBookmarkletUrl() {
    if (_bookmarkletLoaded) return _bookmarkletUrl;
    _bookmarkletLoaded = true;
    try {
        const s = fsSync.readFileSync(BOOKMARKLET_FILE, 'utf8').trim();
        _bookmarkletUrl = /^javascript:/i.test(s) ? s : null;
        if (!_bookmarkletUrl) log('WARN', `🔖 广告工具箱书签脚本内容无效（非 javascript: 开头）: ${BOOKMARKLET_FILE}`);
    } catch {
        _bookmarkletUrl = null;
        // 📦 分发环境常见坑：打包时漏带 server/assets/omnifingerprint-bookmarklet.txt，
        //    以前静默跳过 → 「FB广告管理」文件夹正常注入但广告工具箱书签永远不出现，且没有任何日志可查。
        log('WARN', `🔖 广告工具箱书签脚本文件缺失，本次跳过书签注入（FB 页面书签组不受影响）: ${BOOKMARKLET_FILE}`);
    }
    return _bookmarkletUrl;
}
// Chrome 时间戳：1601-01-01 起的微秒数
const _chromeTime = () => String(BigInt(Date.now()) * 1000n + 11644473600000000n);
const _bmFolder = (name, id) => ({
    children: [], date_added: _chromeTime(), date_last_used: '0', date_modified: _chromeTime(),
    guid: crypto.randomUUID(), id, name, type: 'folder',
});
const _bmUrl = (name, url, id) => ({
    date_added: _chromeTime(), date_last_used: '0', date_modified: _chromeTime(),
    guid: crypto.randomUUID(), id: String(id), name, type: 'url', url,
});
// 📌 默认显示书签栏：Chrome 把书签栏显隐存在 Default/Preferences 的 bookmark_bar.show_on_all_tabs
function ensureBookmarkBarVisible(userDataDir) {
    try {
        const defDir = path.join(userDataDir, 'Default');
        const prefPath = path.join(defDir, 'Preferences');
        let prefs = null;
        if (fsSync.existsSync(prefPath)) {
            try { prefs = JSON.parse(fsSync.readFileSync(prefPath, 'utf8')); } catch { return; } // 解析失败绝不覆盖，避免 Chrome 重置配置
            if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return;
        } else {
            fsSync.mkdirSync(defDir, { recursive: true });
            prefs = {};
        }
        if (prefs.bookmark_bar && prefs.bookmark_bar.show_on_all_tabs === true) return;
        prefs.bookmark_bar = { ...(prefs.bookmark_bar || {}), show_on_all_tabs: true };
        fsSync.writeFileSync(prefPath, JSON.stringify(prefs));
    } catch (e) {
        log('WARN', `🔖 设置书签栏默认显示失败 (${userDataDir}): ${e.message}`);
    }
}
function ensureProfileBookmarks(userDataDir) {
    try {
        if (!userDataDir) return;
        ensureBookmarkBarVisible(userDataDir);
        const url = getBookmarkletUrl();
        const defDir = path.join(userDataDir, 'Default');
        const bmPath = path.join(defDir, 'Bookmarks');
        let data = null;
        if (fsSync.existsSync(bmPath)) {
            try { data = JSON.parse(fsSync.readFileSync(bmPath, 'utf8')); } catch { data = null; }
        }
        fsSync.mkdirSync(defDir, { recursive: true });
        if (!data || !data.roots) {
            data = { checksum: '', roots: { bookmark_bar: _bmFolder('书签栏', '1'), other: _bmFolder('其他书签', '2'), synced: _bmFolder('移动设备书签', '3') }, version: 1 };
        }
        if (!data.roots.bookmark_bar) data.roots.bookmark_bar = _bmFolder('书签栏', '1');
        const bar = data.roots.bookmark_bar;
        if (!Array.isArray(bar.children)) bar.children = [];
        let maxId = 0;
        const walk = (n) => {
            if (!n) return;
            if (n.id && /^\d+$/.test(String(n.id))) maxId = Math.max(maxId, +n.id);
            (n.children || []).forEach(walk);
        };
        Object.values(data.roots).forEach(walk);
        let changed = false;
        // ① 书签脚本（广告工具箱）
        if (url && !bar.children.some(c => c && c.name === BOOKMARKLET_NAME && typeof c.url === 'string' && /^javascript:/i.test(c.url))) {
            bar.children.push(_bmUrl(BOOKMARKLET_NAME, url, ++maxId));
            changed = true;
        }
        // ② FB 页面书签组：内容有出入就整组重建，保持与清单一致
        const sameAsList = (folder) => Array.isArray(folder.children)
            && folder.children.length === FB_BOOKMARKS.length
            && folder.children.every((c, i) => c && c.name === FB_BOOKMARKS[i][0] && c.url === FB_BOOKMARKS[i][1]);
        let grp = bar.children.find(c => c && c.type === 'folder' && c.name === FB_BOOKMARK_GROUP);
        if (grp && !sameAsList(grp)) {
            bar.children = bar.children.filter(c => c !== grp);
            grp = null;
            changed = true;
        }
        if (!grp) {
            grp = _bmFolder(FB_BOOKMARK_GROUP, ++maxId);
            grp.children = FB_BOOKMARKS.map(([n, u]) => _bmUrl(n, u, ++maxId));
            bar.children.push(grp);
            changed = true;
        }
        if (!changed) return;
        bar.date_modified = _chromeTime();
        // checksum 必须置空：写了错的校验值 Chrome 会直接忽略整个书签文件
        data.checksum = '';
        fsSync.writeFileSync(bmPath, JSON.stringify(data));
        log('INFO', `🔖 已注入书签（${BOOKMARKLET_NAME} + ${FB_BOOKMARKS.length} 个 FB 页面）: ${userDataDir}`);
    } catch (e) {
        log('WARN', `🔖 注入书签失败 (${userDataDir}): ${e.message}`);
    }
}

// 🧬 已定稿的设备画像缓存（profileId -> fingerprint）
//    browser-routes 在 createBrowser 之后还会新建页面，那里必须复用**同一套**画像 ——
//    尤其是「UA 版本已对齐真实 Chrome」这一步的结果，不能被后来的 setUserAgent 打回旧版本。
const _fingerprintCache = new Map();

// --- 以下函数/变量由主文件注入（保持与主文件的 log、findChromeExecutable 等共享） ---
let log = (level, message, ...args) => {
    // 兜底实现：被主文件 __inject 覆盖
    const isForced = (typeof args[0] === 'string' && args[0].startsWith('FORCE_DBG'));
    if (String(level).toUpperCase() === 'DEBUG' && !isForced) { return; }
    if (logLevels[level] >= logLevels[LOG_LEVEL] || isForced) {
        const ts = new Date().toISOString();
        try { process.stdout.write(`[${ts}] [${level}] ${message} ${args.join(' ')}\n`); } catch {}
    }
};
let findChromeExecutable = () => {
    const bundledPath = path.join(path.dirname(process.execPath), 'bundled-chrome', 'chrome.exe');
    if (fsSync.existsSync(bundledPath)) return bundledPath;
    return process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;
};
let attachCookieSync = () => {};
let getCookiesFromStorage = async () => [];
let syncCookiesToStorage = async () => {};
let parseCookieString = () => [];
// 🔍 由主文件注入：按 profileId 查配置（取 UA / Cookie 用）
let findProfileById = async () => null;

// 🚀 模块依赖注入（由主文件调用，将主文件的 log、findChromeExecutable 等注入）
function __inject(deps) {
    if (deps.log) log = deps.log;
    if (deps.findChromeExecutable) findChromeExecutable = deps.findChromeExecutable;
    if (deps.attachCookieSync) attachCookieSync = deps.attachCookieSync;
    if (deps.getCookiesFromStorage) getCookiesFromStorage = deps.getCookiesFromStorage;
    if (deps.syncCookiesToStorage) syncCookiesToStorage = deps.syncCookiesToStorage;
    if (deps.parseCookieString) parseCookieString = deps.parseCookieString;
    if (deps.findProfileById) findProfileById = deps.findProfileById;
}

// ============================================================
// 🎭 反检测注入：所有页面（含启动时就存在的首页）统一走这里
// ============================================================
// ⚠️ 这个函数会被 puppeteer 序列化后在页面里执行，函数体内不能引用外部变量，
//    所有数据必须通过 args 传入。
function _stealthScript(args) {
    const { platform, langs, wv, wr, pc, cc, dm, sw, sh, availH, canvasRandom, audioRandom } = args;

    // 1. 隐藏 webdriver（puppeteer 最明显的特征）
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}

    // 2. plugins：真实 Chrome 有 PDF 插件，空数组是典型自动化特征
    try {
        const pluginNames = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
        ];
        class MimeType { constructor(m) { this.type = m.type; this.suffixes = m.suffixes; this.description = m.description; this.enabledPlugin = null; } }
        class Plugin { constructor(p) { this.name = p.name; this.filename = p.filename; this.description = p.description; this.length = (p.mimeTypes || []).length; this.item = () => null; this.namedItem = () => null; } }
        const arr = [];
        for (let i = 0; i < Math.min(pc, pluginNames.length); i++) arr.push(new Plugin(pluginNames[i]));
        Object.defineProperty(navigator, 'plugins', { get: () => arr, configurable: true });
    } catch (e) {}

    // 3. languages（与 Accept-Language 对齐）
    try { Object.defineProperty(navigator, 'languages', { get: () => langs, configurable: true }); } catch (e) {}

    // 4. hardwareConcurrency / deviceMemory
    try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => cc, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'deviceMemory', { get: () => dm, configurable: true }); } catch (e) {}

    // 5. platform：必须与 UA 声明一致（Mac 的 UA 配 Win32 是最扎眼的自相矛盾）
    try { Object.defineProperty(navigator, 'platform', { get: () => platform, configurable: true }); } catch (e) {}

    // 6. screen：与窗口/viewport 同一套数值，不再固定 1920x1080
    try {
        Object.defineProperties(screen, {
            width: { get: () => sw, configurable: true },
            height: { get: () => sh, configurable: true },
            availWidth: { get: () => sw, configurable: true },
            availHeight: { get: () => availH, configurable: true },
            colorDepth: { get: () => 24, configurable: true },
            pixelDepth: { get: () => 24, configurable: true }
        });
    } catch (e) {}

    // 7. window.chrome 常用属性（Facebook 会检查）
    try {
        if (!window.chrome) window.chrome = {};
        ['app', 'csi', 'loadTimes', 'runtime'].forEach((k) => { if (!window.chrome[k]) window.chrome[k] = {}; });
    } catch (e) {}

    // 8. WebGL：vendor/renderer 跟随机型。真实 Chrome 返回的是 ANGLE 字符串，
    //    且不能屏蔽 WEBGL_debug_renderer_info（真实浏览器支持它，屏蔽反而暴露）
    try {
        const origGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, attrs) {
            const ctx = origGetContext.call(this, type, attrs);
            try {
                if (ctx && ctx.getParameter) {
                    const origGetParam = ctx.getParameter.bind(ctx);
                    ctx.getParameter = function (p) {
                        if (p === 37445) return wv; // UNMASKED_VENDOR_WEBGL
                        if (p === 37446) return wr; // UNMASKED_RENDERER_WEBGL
                        return origGetParam(p);
                    };
                }
            } catch (e) {}
            return ctx;
        };
    } catch (e) {}

    // 9. Canvas 微扰：只在配置显式开启 random 时注入。
    //    以前是无条件注入，等于给每个号都盖上"指纹被改过"的章
    if (canvasRandom) {
        try {
            const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function () {
                if (!this.width && !this.height) return origToDataURL.apply(this, arguments);
                try {
                    const ctx = this.getContext('2d');
                    if (ctx && ctx.getImageData) {
                        const imgData = ctx.getImageData(0, 0, 1, 1);
                        if (imgData && imgData.data) {
                            imgData.data[0] = (imgData.data[0] + 1) % 256;
                            ctx.putImageData(imgData, 0, 0);
                        }
                    }
                } catch (e) {}
                return origToDataURL.apply(this, arguments);
            };
        } catch (e) {}
    }

    // 10. AudioContext 指纹：同样只在开启 random 时注入，且只扰动少量采样点
    if (audioRandom) {
        try {
            if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
                const origGetChan = AudioBuffer.prototype.getChannelData;
                AudioBuffer.prototype.getChannelData = function (channel) {
                    const data = origGetChan.call(this, channel);
                    try {
                        for (let i = 0; i < Math.min(data.length, 64); i += 3) {
                            data[i] = data[i] * 0.9999 + 0.00001;
                        }
                    } catch (e) {}
                    return data;
                };
            }
        } catch (e) {}
    }
}

// 🎭 把一个页面的环境对齐到该 profile 的画像：时区 / UA+UA-CH / Accept-Language / viewport / 注入脚本。
//    必须在页面导航之前调用（evaluateOnNewDocument 只对之后的文档生效）。
async function applyStealthToPage(page, fp, tag) {
    if (!page || !fp) return;
    // 时区：CDP 覆盖，对已加载页面立即生效并在后续导航中保持
    if (fp.timezone) {
        try { await page.emulateTimezone(fp.timezone); }
        catch (e) { log('WARN', `🌍 设置时区失败 ${fp.timezone}: ${e.message}`); }
    }
    // UA 字符串与 UA-CH 必须一起改，否则 Sec-CH-UA 仍会暴露真实 Chrome 版本。
    // ⚠️ puppeteer 的签名是 setUserAgent(ua, metadata)，metadata 直接作为第二个参数传，
    //    不能再包一层 { userAgentMetadata: ... }（包了会报 architecture 字段缺失）。
    try { await page.setUserAgent(fp.userAgent, buildUserAgentMetadata(fp)); }
    catch (e) { log('WARN', `🎭 设置 UA/UA-CH 失败: ${e.message}`); }
    // Accept-Language 与 navigator.languages 保持一致
    try { await page.setExtraHTTPHeaders({ 'Accept-Language': fp.acceptLanguage }); }
    catch (e) {}
    // ⚠️ 这里**不要**再 setViewport：它会启用 CDP 的 deviceMetricsOverride 把视口锁死，
    //    窗口最大化/拖动时页面不再重排（用户实测「画面没有响应式加载」就是这个引起的）。
    //    defaultViewport 已是 null，页面自然跟随窗口尺寸；「屏幕/显示器分辨率」由 screen.* 注入体现。
    const stealthArgs = {
        platform: fp.platform,
        langs: fp.languages,
        wv: fp.gpuVendor,
        wr: fp.gpuRenderer,
        pc: fp.pluginsCount,
        cc: fp.cpuCores,
        dm: fp.deviceMemory,
        sw: fp.width,
        sh: fp.height,
        availH: fp.availHeight,
        canvasRandom: fp.canvas === 'random',
        audioRandom: fp.audio === 'random'
    };
    try {
        await page.evaluateOnNewDocument(_stealthScript, stealthArgs);
    } catch (e) {
        log('WARN', `🎭 指纹脚本注入失败${tag ? ' (' + tag + ')' : ''}: ${e.message}`);
    }
    // 🩹 竞态兜底：调用方经常 newPage() 之后立刻 goto，而 targetcreated 回调里的注入是异步的，
    //    evaluateOnNewDocument 只对「之后的文档」生效 —— 页面可能已经加载过了（实测 profileId=5887：
    //    UA/UA-CH 生效了，但 hardwareConcurrency 仍是本机真实的 20 核、languages 仍是系统语言）。
    //    这里再对当前文档直接执行一次同样的脚本（幂等），并在 load 时补一次，确保已加载页面也带上画像。
    const runNow = async () => {
        try { await page.evaluate(_stealthScript, stealthArgs); } catch (e) { /* 文档切换中，忽略 */ }
    };
    if (!String(page.url() || '').startsWith('about:')) await runNow();
    try { page.once('load', () => { void runNow(); }); } catch (e) {}
}

// 🧬 取某个 profile 的最终画像（优先复用 createBrowser 定稿的那份，含 UA 版本对齐结果）。
//    browser-routes 新建页面后调用它 + applyStealthToPage，保证新页面与主页面环境一致。
function getFingerprint(profileId, profile) {
    const key = String(profileId);
    const cached = _fingerprintCache.get(key);
    if (cached) return cached;
    const fp = normalizeProfileFingerprint(profileId, profile || {});
    _fingerprintCache.set(key, fp);
    return fp;
}

// ============================================================
// 以下代码从 puppeteer-api-server.js 原样提取
// ============================================================

// 🗄️ 存储活跃的浏览器实例
const activeBrowsers = new Map();
// 🔻 统一记录「谁、为什么」关闭了浏览器。
//    痛点：批量执行时浏览器被关又自动重启，日志里只有一句"浏览器已断开"，分不清是
//    UA 变更重建 / 启动前清理 / 队列超时 / 代理变更 / 借用回收 / 服务退出 哪条路径干的。
//    做法：每个关闭点先调 logBrowserClose() 登记原因；disconnected、进程 exit 事件回调时
//    用 peekBrowserCloseReason() 回读，落成一条带原因的日志。
const _browserCloseReasons = new Map(); // profileId -> { reason, by, at }
const CLOSE_REASON_TTL_MS = 10 * 60 * 1000;
function markBrowserCloseReason(profileId, reason, by) {
    try { _browserCloseReasons.set(String(profileId), { reason: String(reason || ''), by: String(by || ''), at: Date.now() }); } catch {}
}
// 只读不消费：disconnected 与后续「自动重启」两处都要能看到同一条原因，所以带 TTL 惰性过期。
function peekBrowserCloseReason(profileId) {
    const k = String(profileId);
    const v = _browserCloseReasons.get(k);
    if (!v) return null;
    if (Date.now() - v.at > CLOSE_REASON_TTL_MS) { _browserCloseReasons.delete(k); return null; }
    return v;
}
// 关闭浏览器的统一入口：登记原因 + 打印（触发点 by 用来定位是哪段代码关的）
function logBrowserClose(profileId, reason, by, extra) {
    markBrowserCloseReason(profileId, reason, by);
    log('WARN', `🔻 [Close] profileId=${profileId}｜原因=${reason}｜触发点=${by}${extra ? '｜' + extra : ''}`);
}
// 🚀 跟踪"启动中"的浏览器数（用于并发控制，排除预热）
let pendingBrowserCount = 0;
// 🗄️ 持久化缓存每个 Profile 的最后已知 Cookie（重启浏览器时复用，不受断开影响）
const profileCookiesCache = new Map();
// 🗄️ 记录 GraphQL field_exception 失败的 Profile，后续直接走手动创建
const profileGraphqlFailCache = new Set();

// 📡 探测调试端口是否已被占用
//    ⚠️ 必须显式绑定回环地址：Chrome 的 devtools 只监听 127.0.0.1/::1，
//    而 net.createServer().listen(port) 绑定的是通配地址；Windows 允许两者共存，
//    因此裸 listen 会把"已被 Chrome 占用的端口"误判为空闲。端口被占用时 Chrome 仍会启动，
//    但 devtools HTTP 服务起不来，puppeteer 等待 25 秒超时，并误报 "The browser is already running"。
async function isDebugPortOccupied(port) {
    const net = require('net');
    const tryListen = (host) => new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (e) => resolve(e && e.code === 'EADDRINUSE'));
        server.once('listening', () => { server.close(() => resolve(false)); });
        server.listen(port, host);
    });
    if (await tryListen('127.0.0.1')) return true;
    if (await tryListen('::1')) return true;
    return false;
}

// 🔒 已分配但尚未注册进 activeBrowsers 的调试端口（并发启动防重复分配）
//    ⚠️ 端口探测是异步的：批量启动时多个任务几乎同时探测 9222，此刻还没有任何 Chrome 绑定该端口、
//    activeBrowsers 也还是空的 → 全部拿到 9222。Chrome 起来后只有第一个能绑上 devtools，
//    其余 Chrome 虽存活但 devtools 起不来（puppeteer 报 already running，GraphAPI 请求 Connection closed）
const reservedDebugPorts = new Map(); // port -> 预留时间戳
const DEBUG_PORT_RESERVE_TTL_MS = 5 * 60 * 1000;

// 📡 释放端口预留：Chrome 真正绑定该端口后由 isDebugPortOccupied 兜住，预留即可撤销
function releaseDebugPort(port) {
    const p = Number(port);
    if (p) reservedDebugPorts.delete(p);
}

// 📡 自动分配可用调试端口，防止端口冲突
async function getAvailableDebugPort(startPort = 9222) {
    let port = startPort;
    const maxAttempts = 100;
    let attempts = 0;
    // 启动流程异常没走到释放逻辑时的兜底：过期预留自动失效
    const now = Date.now();
    for (const [p, ts] of reservedDebugPorts) {
        if (now - ts > DEBUG_PORT_RESERVE_TTL_MS) reservedDebugPorts.delete(p);
    }
    while (attempts < maxAttempts) {
        const occupied = await isDebugPortOccupied(port);
        if (occupied) { port++; attempts++; continue; }
        if (reservedDebugPorts.has(port)) { port++; attempts++; continue; }
        let isUsedByActive = false;
        for (const b of activeBrowsers.values()) {
            if (b.debugPort === port) { isUsedByActive = true; break; }
        }
        if (isUsedByActive) { port++; attempts++; continue; }
        reservedDebugPorts.set(port, Date.now()); // 立即占位，堵住并发窗口
        return port;
    }
    return startPort + Math.floor(Math.random() * 1000);
}

// 🔪 查找并杀掉占用指定 user-data-dir 的浏览器进程
//    残留（僵尸）进程会持有 profile 目录，新 Chrome 启动后会因 ProcessSingleton 直接移交退出，
//    puppeteer 表现为 Target closed / already running，因此每次启动前先清理。
function killBrowserProcessesUsingDir(userDataDir) {
    if (!userDataDir) return [];
    const { execSync } = require('child_process');
    const parsePids = (out) => String(out || '')
        .split('\n')
        .map(l => l.trim().split(',').pop().trim())
        .filter(v => /^\d+$/.test(v));
    const killed = [];
    for (const name of ['chrome.exe', 'msedge.exe']) {
        let pids = [];
        let wmicOk = false;
        try {
            const out = execSync(`wmic process where "name='${name}' and commandline like '%${userDataDir}%'" get processid /format:csv 2>nul`, { stdio: 'pipe', timeout: 8000, encoding: 'utf8' });
            // 有表头说明 wmic 可用（结果为空也算可用）
            wmicOk = /ProcessId/i.test(out);
            pids = parsePids(out.replace(/ProcessId/gi, ''));
        } catch { wmicOk = false; }
        // wmic 在 Windows 11 24H2+ 已被移除，回退到 PowerShell CIM 查询
        if (!wmicOk) {
            try {
                const ps = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${name}' -and $_.CommandLine -like '*${userDataDir}*' } | Select-Object -ExpandProperty ProcessId"`;
                pids = parsePids(execSync(ps, { stdio: 'pipe', timeout: 20000, encoding: 'utf8' }));
            } catch { pids = []; }
        }
        for (const pid of pids) {
            try {
                execSync(`taskkill /F /T /PID ${pid} 2>nul`, { stdio: 'pipe', timeout: 5000 });
                killed.push(Number(pid));
            } catch {}
        }
    }
    return killed;
}

const browserPool = [];
const launchQueue = [];
let currentLaunching = 0;

// 🧹 启动清扫：把「上一轮服务残留」的浏览器进程清掉。
//    覆盖所有没机会走优雅退出的死法：被硬杀（taskkill /F、任务管理器）、崩溃、断电。
//    ⚠️ 只杀「孤儿」——父进程已经不存在的。这一条是安全底线：
//       · 正常的浏览器（哪怕是别的实例在跑）父进程是活着的 node，绝不会命中；
//       · 服务被硬杀后，Chrome 的 ParentProcessId 仍指向那个已死的 node（Windows 不会重新挂父），
//         正好命中。
//       不加这个条件就会误杀别人正在用的浏览器（实测过：会把运行中实例的浏览器一起干掉）。
//    ⚠️ 必须按「根目录」一次查询。不能复用 killBrowserProcessesUsingDir 按 157 个子目录逐个查，
//       那样每个目录一次 PowerShell，启动会多等几分钟。
function killAllResidualBrowsers(rootDir) {
    if (!rootDir) return [];
    const { execSync } = require('child_process');
    const parsePids = (out) => String(out || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(v => /^\d+$/.test(v));
    const filter = ['chrome.exe', 'msedge.exe'].map(n => `$_.Name -eq '${n}'`).join(' -or ');
    let pids = [];
    try {
        const ps = `powershell -NoProfile -NonInteractive -Command "$alive = @{}; Get-Process | ForEach-Object { $alive[$_.Id] = $true }; Get-CimInstance Win32_Process | Where-Object { (${filter}) -and $_.CommandLine -like '*${rootDir}*' -and -not $alive[[int]$_.ParentProcessId] } | Select-Object -ExpandProperty ProcessId"`;
        pids = parsePids(execSync(ps, { stdio: 'pipe', timeout: 30000, encoding: 'utf8' }));
    } catch { pids = []; }
    const killed = [];
    for (const pid of pids) {
        try {
            execSync(`taskkill /F /T /PID ${pid} 2>nul`, { stdio: 'pipe', timeout: 5000 });
            killed.push(Number(pid));
        } catch {}
    }
    return killed;
}

// 🧹 清掉所有 profile 目录里残留的单例锁（上一次被强杀留下的 Singleton*/lockfile）。
//    浏览器进程已经不在、但这些文件还在时，新 Chrome 起来约 1 秒后会因「profile 被占用」自行退出，
//    puppeteer 报 Target closed / already running。
//    ⚠️ 必须在 killAllResidualBrowsers 之后调用：否则会把「还活着」的浏览器的锁删掉。
function cleanAllStaleLocks(rootDir) {
    if (!rootDir) return 0;
    let removed = 0;
    try {
        for (const ent of fsSync.readdirSync(rootDir, { withFileTypes: true })) {
            if (!ent.isDirectory()) continue;
            const dir = path.join(rootDir, ent.name);
            let files = [];
            try { files = fsSync.readdirSync(dir); } catch { continue; }
            for (const f of files) {
                if (/^(Singleton|lockfile)/.test(f)) {
                    try { fsSync.unlinkSync(path.join(dir, f)); removed++; } catch {}
                }
            }
        }
    } catch {}
    return removed;
}


// 🚀 浏览器实例管理类（优化版）
// 提取邮箱前缀并安全化为文件名
function extractEmailPrefix(email) {
    if (!email || typeof email !== 'string') return null;
    const local = email.split('@')[0] || '';
    const sanitized = local.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
    return sanitized || null;
}

// 🚀 通过 CDP Network.requestWillBeSent 拦截提取 Token（不依赖 page.evaluate）
// 在每个 Chromium 版本上都可用，完全绕开 JS 执行
/**
 * 🚀 统一 Token 提取函数：CDP 网络拦截 + HTML 正则回退
 * 替代所有分散的 _extractTokenFromNetwork 调用及各自附带的 HTML fallback
 */
async function extractFbToken(page, timeoutMs = 10000) {
    // 先尝试 CDP 网络拦截提取
    let token = '';
    try {
        // 检查 page/target 是否有效
        const t = page.target();
        if (t) {
            const cdpSession = await t.createCDPSession().catch(() => null);
            if (cdpSession) {
                token = await _rawCdpExtractToken(cdpSession, timeoutMs);
                cdpSession.detach().catch(() => {});
            }
        }
    } catch (e) {
        log('WARN', `[extractFbToken] CDP 提取失败: ${e.message}`);
    }
    // HTML 正则回退
    if (!token || !token.startsWith('EAA')) {
        try {
            const html = await page.content().catch(() => '');
            const m1 = html.match(/"accessToken":"(EAA[A-Za-z0-9_\-]+)"/);
            if (m1) token = m1[1];
            else {
                const m2 = html.match(/EAAB[A-Za-z0-9_\-]{50,}/);
                if (m2) token = m2[0];
            }
        } catch {}
    }
    return (token && token.startsWith('EAA')) ? token.substring(0, 220) : '';
}

/**
 * 🚀 底层 CDP Token 提取（从 _extractTokenFromNetwork 抽出，不含 HTML fallback）
 */
async function _rawCdpExtractToken(cdpSession, timeoutMs = 10000) {
    return new Promise((resolve) => {
        const tokens = new Set();
        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                const arr = [...tokens];
                resolve(arr.find(t => t.startsWith('EAA') && t.length > 50 && t.length < 250) || arr[0] || '');
            }
        }, timeoutMs);
        cdpSession.on('Network.requestWillBeSent', (params) => {
            if (resolved) return;
            try {
                const req = params.request || {};
                const url = req.url || '';
                const postData = req.postData || '';
                const headers = req.headers || {};
                const auth = headers['authorization'] || headers['Authorization'] || '';
                const uMatch = url.match(/access_token=(EAAB[A-Za-z0-9_\-]{50,})/);
                if (uMatch && uMatch[1].length > 50) tokens.add(uMatch[1].substring(0, 220));
                const aMatch = auth.match(/(EAAB[A-Za-z0-9_\-]{50,})/);
                if (aMatch && aMatch[1].length > 50) tokens.add(aMatch[1].substring(0, 220));
                const pMatch = postData.match(/access_token=(EAAB[A-Za-z0-9_\-]{50,})/);
                if (pMatch && pMatch[1].length > 50) tokens.add(pMatch[1].substring(0, 220));
                const rMatch = url.match(/EAAB[A-Za-z0-9_\-]{50,}/);
                if (rMatch && rMatch[0].length > 50) tokens.add(rMatch[0].substring(0, 220));
                const best = [...tokens].find(t => t.startsWith('EAA') && t.length > 50 && t.length < 250);
                if (best) {
                    resolved = true;
                    clearTimeout(timer);
                    resolve(best);
                }
            } catch {}
        });
        cdpSession.send('Network.enable').catch(() => { resolved = true; clearTimeout(timer); resolve(''); });
    });
}

// 🚀 page.evaluate 兼容方案：四重降级
// ① page.evaluate(fn, args) → ② page.evaluate(string) → ③ CDP Runtime.evaluate → ④ addScriptTag
async function safePageEvaluate(page, fn, ...args) {
    // 先尝试绕过 CSP（某些网站 CSP 会阻止 CDP evaluate）
    try { await page.setBypassCSP(true); } catch {}
    
    const fnStr = fn.toString();
    const argsStr = args.map(a => JSON.stringify(a)).join(',');
    const expression = args.length > 0
        ? `(${fnStr})(${argsStr})`
        : `(${fnStr})()`;

    // 尝试一：标准 page.evaluate（Runtime.callFunctionOn）
    try {
        return await page.evaluate(fn, ...args);
    } catch (e1) {
        // 尝试二：用字符串表达式调用 page.evaluate（走 Runtime.evaluate，不是 callFunctionOn）
        try {
            return await page.evaluate(expression);
        } catch (e2) {
            // 尝试三：CDP Runtime.evaluate 直接执行
            try {
                const cdpSession = await page.target().createCDPSession();
                const result = await cdpSession.send('Runtime.evaluate', {
                    expression: expression,
                    returnByValue: true,
                    awaitPromise: true,
                    userGesture: true
                });
                if (result.exceptionDetails) {
                    throw new Error(`CDP evaluate exception: ${result.exceptionDetails.text || 'Uncaught'}`);
                }
                return result.result.value;
            } catch (e3) {
                // 尝试四：通过 addScriptTag 注入脚本（本质是 <script> 标签，不受 CSP eval 限制影响）
                try {
                    return await new Promise((resolve, reject) => {
                        const uid = '_safeEval_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                        const wrappedExpr = `
                            window['${uid}'] = (function() {
                                try {
                                    return Promise.resolve(${expression}).then(r => ({ ok: true, val: r }), e => ({ ok: false, err: e.message || String(e) }));
                                } catch(e) {
                                    return { ok: false, err: e.message || String(e) };
                                }
                            })();
                        `;
                        page.addScriptTag({ content: wrappedExpr }).then(() => {
                            // 轮询等待结果（最多 15 秒）
                            let polled = false;
                            const poll = setInterval(async () => {
                                if (polled) return;
                                try {
                                    const r = await page.evaluate((uid) => window[uid], uid).catch(() => null);
                                    if (r) {
                                        polled = true;
                                        clearInterval(poll);
                                        page.evaluate((uid) => { try { delete window[uid]; } catch {} }, uid).catch(() => {});
                                        if (r.ok) resolve(r.val);
                                        else reject(new Error(r.err || 'script tag eval failed'));
                                    }
                                } catch {}
                            }, 300);
                            setTimeout(() => {
                                if (!polled) {
                                    polled = true;
                                    clearInterval(poll);
                                    reject(new Error('script tag eval timeout'));
                                }
                            }, 15000);
                        }).catch(reject);
                    });
                } catch (e4) {
                    const msg = `page.evaluate 全面失败: ${e1.message} | 字符串式: ${e2.message} | CDP: ${e3.message} | scriptTag: ${e4.message}`;
                    log('WARN', msg);
                    throw e1;
                }
            }
        }
    }
}

// 🚀 safePageEvaluate 的 void 版本（不关心返回值）
async function safePageEvaluateVoid(page, fn, ...args) {
    try { await safePageEvaluate(page, fn, ...args); } catch {}
}

class BrowserManager {
    constructor() {
        this.instances = new Map();
        this.pool = [];
        this.stats = {
            created: 0,
            destroyed: 0,
            active: 0,
            poolSize: 0
        };
    }

    // 🔍 检测并获取现有的用户数据目录
    findExistingUserDataDir(profileId, emailPrefix) {
        if (!profileId) return null;

        // 定义可能的目录路径（按优先级排序）
        const possiblePaths = [
            // 基于邮箱前缀的新格式（优先）
            ...(emailPrefix ? [
                path.join(BROWSER_PROFILES_ROOT, `${emailPrefix}_${profileId}`),
                path.join(APP_ROOT, 'data', 'profiles', `${emailPrefix}_${profileId}`)
            ] : []),
            // 新的统一格式
            path.join(BROWSER_PROFILES_ROOT, `${profileId}_${profileId}`),
            // 当前使用的格式
            path.join(BROWSER_PROFILES_ROOT, String(profileId)),
            // data/profiles 下的格式
            path.join(APP_ROOT, 'data', 'profiles', `${profileId}_${profileId}`),
            path.join(APP_ROOT, 'data', 'profiles', String(profileId)),
            path.join(APP_ROOT, 'data', 'profiles', `profile_${profileId}`)
        ];

        // 检查每个可能的路径
        for (const dirPath of possiblePaths) {
            if (fsSync.existsSync(dirPath)) {
                // 检查是否是有效的Chrome用户数据目录
                const defaultPath = path.join(dirPath, 'Default');
                if (fsSync.existsSync(defaultPath)) {
                    log('INFO', `🔍 发现现有用户数据目录: ${dirPath}`);
                    return dirPath;
                }
            }
        }

        return null;
    }

    // 🔧 获取或创建统一的用户数据目录
    getUnifiedUserDataDir(profileId, baseUserDataDir, emailPrefix) {
        if (!profileId) {
            return baseUserDataDir;
        }

        // 优先使用调用方提供的目录（两级隔离结构），只要在固定根路径下
        // 其次复用旧格式现有目录（单层 <prefix_or_id>_<id>），最后构建新目录
        // 仅当调用方提供的目录位于固定根路径下时才接受
        const omnibrowserProfilesRoot = BROWSER_PROFILES_ROOT;
        if (baseUserDataDir) {
            const normalizedBase = path.normalize(baseUserDataDir);
            const normalizedRoot = path.normalize(omnibrowserProfilesRoot);
            if (normalizedBase.startsWith(normalizedRoot)) {
                log('INFO', `🆕 使用调用方提供的用户数据目录(有效范围): ${baseUserDataDir}`);
                return baseUserDataDir;
            } else {
                log('WARN', `⚠️ 忽略外部用户数据目录: ${baseUserDataDir}，改用固定根路径`);
            }
        }

        // 复用旧格式现有目录
        const existingDir = this.findExistingUserDataDir(profileId, emailPrefix);
        if (existingDir) {
            log('INFO', `♻️ 复用现有用户数据目录: ${existingDir}`);
            return existingDir;
        }

        // 否则根据邮箱前缀或profileId构建统一格式目录
        const dirName = emailPrefix ? `${emailPrefix}_${profileId}` : `${profileId}_${profileId}`;
        const unifiedDir = path.join(BROWSER_PROFILES_ROOT, dirName);
        log('INFO', `🆕 创建新的用户数据目录: ${unifiedDir}`);
        return unifiedDir;
    }

    // 🧹 清理重复的用户数据目录
    async cleanupDuplicateDirectories(profileId, emailPrefix) {
        if (!profileId) return;

        const possiblePaths = [
            ...(emailPrefix ? [
                path.join(BROWSER_PROFILES_ROOT, `${emailPrefix}_${profileId}`)
            ] : []),
            path.join(BROWSER_PROFILES_ROOT, `${profileId}_${profileId}`),
            path.join(BROWSER_PROFILES_ROOT, String(profileId)),
            ...(emailPrefix ? [
                path.join(APP_ROOT, 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', `${emailPrefix}_${profileId}`)
            ] : []),
            path.join(APP_ROOT, 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', `${profileId}_${profileId}`),
            path.join(APP_ROOT, 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', String(profileId))
        ];

        const existingDirs = possiblePaths.filter(dirPath => fsSync.existsSync(dirPath));
        
        if (existingDirs.length > 1) {
            log('WARN', `🧹 发现 ${existingDirs.length} 个重复目录，profileId: ${profileId}`);
            
            // 选择最新的目录作为主目录（按修改时间）
            const dirStats = existingDirs.map(dir => ({
                path: dir,
                mtime: fsSync.statSync(dir).mtime
            }));
            
            dirStats.sort((a, b) => b.mtime - a.mtime);
            const primaryDir = dirStats[0].path;
            const duplicateDirs = dirStats.slice(1);
            
            log('INFO', `🎯 选择主目录: ${primaryDir}`);
            
            for (const duplicate of duplicateDirs) {
                log('INFO', `🗑️ 标记重复目录: ${duplicate.path}`);
                // 这里可以选择删除或重命名重复目录
                // 为了安全起见，我们只记录，不自动删除
            }
        }
    }

    async ensureUserDataMigration(profileId, emailPrefix) {
        const targetName = emailPrefix ? `${emailPrefix}_${profileId}` : `${profileId}_${profileId}`;
        const targetDir = path.join(BROWSER_PROFILES_ROOT, targetName);
        const candidates = [
            path.join(APP_ROOT, 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', targetName),
            path.join(APP_ROOT, 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', String(profileId))
        ];
        for (const src of candidates) {
            try {
                if (fsSync.existsSync(src) && src !== targetDir) {
                    await fs.mkdir(targetDir, { recursive: true });
                    const entries = await fs.readdir(src, { withFileTypes: true });
                    for (const e of entries) {
                        const s = path.join(src, e.name);
                        const d = path.join(targetDir, e.name);
                        if (e.isDirectory()) {
                            await fs.mkdir(d, { recursive: true });
                            const sub = await fs.readdir(s, { withFileTypes: true });
                            for (const se of sub) {
                                const ss = path.join(s, se.name);
                                const dd = path.join(d, se.name);
                                if (se.isDirectory()) {
                                    await fs.mkdir(dd, { recursive: true });
                                }
                                await fs.copyFile(ss, dd).catch(() => {});
                            }
                        } else {
                            await fs.copyFile(s, d).catch(() => {});
                        }
                    }
                }
            } catch {}
        }
        return targetDir;
    }

    // 🔒 Profile 级互斥锁：防止同一 userDataDir 并发启动
    acquireProfileLock(lockKey) {
        if (!this._profileLocks) this._profileLocks = new Map();
        if (this._profileLocks.has(lockKey)) {
            return new Promise(resolve => {
                const lock = this._profileLocks.get(lockKey);
                if (!lock.queue) lock.queue = [];
                lock.queue.push(resolve);
            });
        }
        this._profileLocks.set(lockKey, { queue: [] });
        return Promise.resolve();
    }

    releaseProfileLock(lockKey) {
        if (!this._profileLocks || !this._profileLocks.has(lockKey)) return;
        const lock = this._profileLocks.get(lockKey);
        if (lock.queue && lock.queue.length > 0) {
            const next = lock.queue.shift();
            next();
        } else {
            this._profileLocks.delete(lockKey);
        }
    }

    // 🚀 性能优化：获取或创建浏览器实例
    async getBrowser(config) {
        let { executablePath, userDataDir, debugPort, profileId, proxy } = config;
        // 🚀 统一代理解析：支持传入字符串格式（如 "socks5://host:port:user:pass"）
        if (typeof proxy === 'string') {
            const parsed = parseProxy(proxy);
            if (parsed && parsed.host) {
                proxy = parsed;
                config.proxy = parsed; // 同步更新 config 供 createBrowser 使用
            }
        }
        // 🚄 SSH 隧道代理处理：将 ssh:// 协议转为本地 SOCKS5 代理
        if (proxy && proxy.type === 'ssh') {
            try {
                log('INFO', `🔌 检测到 SSH 代理: ${proxy.host}:${proxy.port}，正在创建 SSH 隧道...`);
                const localProxy = await sshTunnelManager.createTunnel(proxy, profileId);
                proxy = { ...proxy, ...localProxy };
                config.proxy = proxy;
                log('INFO', `🔌 SSH 隧道已就绪，浏览器将使用本地代理: ${localProxy.host}:${localProxy.port}`);
            } catch (err) {
                log('ERROR', `🔌 SSH 隧道创建失败: ${err.message}，尝试通过系统代理中继...`);
                proxy = null;
                config.proxy = null;
            }
        }
        // 🌍 时区缓存键必须在**代理被重写成本地隧道之前**算好。
        //    🐛 否则拿到的是每次启动都变的本地隧道地址（127.0.0.1:随机端口）→ 缓存永远命中不了，
        //    每次启动都重新探测；失败负缓存同样失效（key 每次都不同）。实测日志里就是
        //    `proxy=socks5://127.0.0.1:46755` 这种随机端口。
        //    这里存的是真实的远程代理身份，换代理才会换 key。
        config.__originProxyKey = proxyTzKey(proxy);
        // 🔁 非SSH代理：检测远程代理是否可达，不可达或HTTPS时通过系统代理中继
        if (proxy && proxy.host && proxy.port && proxy.type !== 'ssh' && proxy.type !== 'socks5_local') {
            const isHttps = String(proxy.type || '').toLowerCase() === 'https';
            if (isHttps) {
                if (S5_TUNNEL_TYPE === 'http') {
                    // 🆕 HTTP 本地代理：改用 TCP 中继隧道（不支持 socks npm 的 SOCKS5 方式）
                    log('INFO', `🔁 HTTPS代理 ${proxy.host}:${proxy.port}，本地代理为 HTTP 类型，使用 TCP 中继隧道...`);
                    try {
                        const tunnel = await _createSocksTunnel(proxy.host, proxy.port, S5_TUNNEL_HOST, S5_TUNNEL_PORT, 'http');
                        if (tunnel) {
                            log('INFO', `🔗 HTTP 中继隧道已创建 (HTTPS远程): 本地 ${tunnel.localHost}:${tunnel.localPort} → 远程 ${proxy.host}:${proxy.port}`);
                            proxy = { ...proxy, host: tunnel.localHost, port: String(tunnel.localPort) };
                            config.proxy = proxy;
                            _registerProxyResource(profileId, 'tunnel', tunnel);
                        } else {
                            log('WARN', '🔗 HTTP 中继隧道创建失败 (HTTPS远程)');
                        }
                    } catch (tunnelErr) {
                        log('ERROR', `🔗 HTTP 中继隧道创建异常 (HTTPS远程): ${tunnelErr.message}`);
                    }
                } else {
                    // 🅲 HTTPS代理：强制走链式隧道（Chrome 直接 TLS 握手到代理经常失败）
                    log('INFO', `🔁 HTTPS代理 ${proxy.host}:${proxy.port}，强制走 SOCKS5 链式隧道...`);
                    try {
                        const relayAddr = await socksChainServer.createChain(proxy, profileId);
                        log('INFO', `🔗 HTTPS链式隧道已连接: 本地 ${relayAddr.host}:${relayAddr.port} → 远程 ${proxy.host}:${proxy.port}`);
                        proxy = { ...proxy, ...relayAddr };
                        config.proxy = proxy;
                    } catch (relayErr) {
                        log('ERROR', `🔗 HTTPS链式隧道创建失败: ${relayErr.message}`);
                    }
                }
            } else {
                // 🔁 域名代理或不可达IP：强制走链式隧道（利用系统代理的DNS和路由加速）
                const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(proxy.host) || /^\[/.test(proxy.host);
                let useChain = !isIP; // 域名默认走链式隧道
                
                if (isIP) {
                    // IP 地址：检测是否直连可达（TCP + SOCKS5 协议验证）
                    // ⚡ 已知不可达的直接跳过：这个检测超时 3000ms，而不可达是要走隧道的常态，
                    //    不缓存的话每次启动都白等满 3s。
                    const reachKey = proxyTzKey(proxy);
                    const unreachableAt = _directReachCache.get(reachKey) || 0;
                    if (Date.now() - unreachableAt < DIRECT_REACH_TTL_MS) {
                        log('INFO', `🔁 代理 ${proxy.host}:${proxy.port} 近期已判定不可达，跳过直连检测，直接建隧道`);
                        useChain = true;
                    } else {
                        useChain = !(await _testDirectReachable(proxy.host, proxy.port, proxy.type, 3000).catch(() => false));
                        if (useChain) _directReachCache.set(reachKey, Date.now());
                        else _directReachCache.delete(reachKey);
                    }
                }
                
                if (useChain) {
                    // 🆕 如果本地代理是 HTTP 类型（如 Astrill），跳过 SOCKS5 链式隧道，改用 TCP 中继隧道
                    if (S5_TUNNEL_TYPE === 'http') {
                        log('INFO', `🔁 本地代理为 HTTP 类型，使用 TCP 中继隧道 ${proxy.host}:${proxy.port}...`);
                        try {
                            const tunnel = await _createSocksTunnel(proxy.host, proxy.port, S5_TUNNEL_HOST, S5_TUNNEL_PORT, 'http');
                            if (tunnel) {
                                const t = (proxy.type || 'http').toLowerCase();
                                const proto = (t === 'socks5' || t === 'socks5h') ? 'socks5' : 'http';
                                log('INFO', `🔗 HTTP 中继隧道已创建: 本地 ${tunnel.localHost}:${tunnel.localPort} → 远程 ${proxy.host}:${proxy.port}`);
                                proxy = { ...proxy, host: tunnel.localHost, port: String(tunnel.localPort) };
                                config.proxy = proxy;
                                // 注册隧道以便关闭浏览器时自动清理（按 kind 分槽位，不会被认证转发器误杀）
                                _registerProxyResource(profileId, 'tunnel', tunnel);
                            } else {
                                log('WARN', '🔗 HTTP 中继隧道创建失败，将尝试直连...');
                            }
                        } catch (tunnelErr) {
                            log('ERROR', `🔗 HTTP 中继隧道创建异常: ${tunnelErr.message}`);
                        }
                    } else {
                        log('INFO', `🔁 ${isIP ? '代理不可达' : '域名代理'} ${proxy.host}:${proxy.port}，通过系统代理链式隧道加速...`);
                        try {
                            const relayAddr = await socksChainServer.createChain(proxy, profileId);
                            log('INFO', `🔗 链式隧道已连接: 本地 ${relayAddr.host}:${relayAddr.port} → 远程 ${proxy.host}:${proxy.port}`);
                            proxy = { ...proxy, ...relayAddr };
                            config.proxy = proxy;
                        } catch (relayErr) {
                            log('ERROR', `🔗 链式隧道创建失败: ${relayErr.message}`);
                        }
                    }
                } else {
                    log('INFO', `🔁 远程代理 ${proxy.host}:${proxy.port} 直连可达`);
                }
            }
        }
        // 规范化用户数据目录，避免实例键包含外部路径
        await this.cleanupDuplicateDirectories(profileId, config.emailPrefix);
        const effectiveUserDataDir = this.getUnifiedUserDataDir(profileId, userDataDir, config.emailPrefix);
        config.userDataDir = effectiveUserDataDir;
        // 🔖 启动前补齐书签（广告工具箱 + FB 页面）+ 默认显示书签栏：新配置的目录是全新的
        ensureProfileBookmarks(effectiveUserDataDir);
        await this.ensureUserDataMigration(profileId, config.emailPrefix);
        
        // 🔧 优化实例键生成：区分代理和无代理模式
        let instanceKey;
        if (proxy && proxy.host && proxy.port) {
            // 有代理：使用代理信息作为键的一部分
            instanceKey = `${effectiveUserDataDir}_${profileId}_${proxy.host}:${proxy.port}`;
        } else {
            // 无代理：强制使用profileId确保独立实例
            instanceKey = `${effectiveUserDataDir}_${profileId}_no_proxy`;
        }
        
        log('DEBUG', `🔑 生成实例键: ${instanceKey} (代理: ${proxy ? `${proxy.host}:${proxy.port}` : '无'})`);

        // 检查是否已存在
        if (this.instances.has(instanceKey)) {
            const instance = this.instances.get(instanceKey);
            if (instance.browser && instance.browser.isConnected()) {
                log('DEBUG', `♻️ 复用浏览器实例: ${instanceKey}`);
                instance.lastUsed = Date.now();
                return instance;
            } else {
                // 清理无效实例（浏览器已断开，可能 disconnected 事件未及时处理）
                this.instances.delete(instanceKey);
                this.stats.active = Math.max(0, this.stats.active - 1);
                this.stats.destroyed++;
            }
        }

        // 创建新实例（使用 profile 级互斥锁防止同一 userDataDir 并发启动）
        const lockKey = effectiveUserDataDir;
        const releaseLock = () => this.releaseProfileLock(lockKey);
        try {
            await this.acquireProfileLock(lockKey);
            // 获取锁后再次检查，避免等待期间已有其他请求创建完成
            if (this.instances.has(instanceKey)) {
                const existing = this.instances.get(instanceKey);
                if (existing.browser && existing.browser.isConnected()) {
                    log('DEBUG', `♻️ 等待后复用浏览器实例: ${instanceKey}`);
                    existing.lastUsed = Date.now();
                    releaseLock();
                    return existing;
                } else {
                    this.instances.delete(instanceKey);
                    this.stats.active = Math.max(0, this.stats.active - 1);
                    this.stats.destroyed++;
                }
            }
            log('INFO', `🔨 创建新浏览器实例: ${instanceKey}`);
            const browser = await this.createBrowser(config);
            const instance = {
                browser,
                config,
                createdAt: Date.now(),
                lastUsed: Date.now(),
                profileId: config.profileId
            };

            this.instances.set(instanceKey, instance);
            this.stats.created++;
            this.stats.active++;
            // 🚀 根治：浏览器退出/断开时立即从注册表移除并修正统计，防止实例长期堆积
            this._attachInstanceCleanup(instanceKey, instance);

            return instance;
        } finally {
            releaseLock();
        }
    }

    // 🚀 创建浏览器实例（优化版）
    async createBrowser(config) {
        const { executablePath, userDataDir, debugPort, proxy, userAgent, profileId, displayId, fbLanguage } = config;

        // 🧬 自洽设备画像：os / platform / 分辨率 / GPU / 核数 / 内存 / 语言 / UA 版本。
        //    正常情况下 database.findProfileById 已经补好并写回本地库；这里再算一次是幂等的兜底
        //    （直接以 config 调用 getBrowser 的路径也要拿到一致结果）。
        let fingerprint = null;
        try {
            fingerprint = normalizeProfileFingerprint(profileId, Object.assign({}, config.profile || {}, {
                userAgent: userAgent || (config.profile && config.profile.userAgent) || ''
            }));
        } catch (fpErr) {
            log('WARN', `⚠️ 设备画像生成失败 (profileId=${profileId}): ${fpErr.message}`);
        }
        if (!fingerprint) {
            // 极端兜底：画像模块异常时也不该让浏览器起不来
            fingerprint = {
                os: 'windows', browser: 'chrome', platform: 'Win32', width: 1920, height: 1080, availHeight: 1040,
                cpuCores: 8, deviceMemory: 8, pluginsCount: 5,
                gpuVendor: 'Google Inc. (Intel)',
                gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
                userAgent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                chromeMajor: '131', chromeFull: '131.0.0.0', platformVersion: '10.0.0', architecture: 'x86',
                timezone: '', language: 'en-US', languages: ['en-US', 'en'], acceptLanguage: 'en-US',
                canvas: 'off', webgl: 'off', audio: 'off'
            };
        }
        const fpUserAgent = fingerprint.userAgent || userAgent || '';
        // 🌍 时区跟着**当前代理**走：按代理身份取缓存，换代理会自动重新探测
        //    优先用「代理被重写成本地隧道之前」记下的真实远程代理身份（见 getBrowser 里的 __originProxyKey）
        const tzKey = config.__originProxyKey || proxyTzKey(proxy);
        if (!fingerprint.timezone) {
            const hit = _detectedTimezoneCache.get(tzKey);
            if (hit && (Date.now() - hit.ts) < TZ_CACHE_TTL_MS) fingerprint.timezone = hit.tz;
        }

        // 🏷️ 确保windowTitle有默认值，避免undefined错误
        const windowTitle = config.windowTitle || `${displayId || profileId || 'Unknown'}`;
        
        // 🏷️ 调试日志：显示接收到的配置
        log('INFO', `🏷️ createBrowser接收到的配置: profileId=${profileId}, displayId=${displayId || 'N/A'}, windowTitle=${windowTitle}`);

        // 🔧 使用新的统一目录管理逻辑
        let actualUserDataDir = this.getUnifiedUserDataDir(profileId, userDataDir, config.emailPrefix);
        if (!actualUserDataDir || String(actualUserDataDir).trim().length === 0) {
            // 回退到统一规则下的默认目录（omnibrowser 路径）
            const dirName = config.emailPrefix ? `${config.emailPrefix}_${String(profileId || 'unknown')}` : `${String(profileId || 'unknown')}_${String(profileId || 'unknown')}`;
            actualUserDataDir = path.join(APP_ROOT, 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', dirName);
            log('WARN', `⚠️ userDataDir 为空，回退到默认目录: ${actualUserDataDir}`);
        }
        // 确保目录存在
        try {
            await fs.mkdir(actualUserDataDir, { recursive: true });
            log('DEBUG', `📁 用户数据目录已准备: ${actualUserDataDir}`);
        } catch (e) {
            log('ERROR', `❌ 创建用户数据目录失败: ${e.message}`);
        }
        log('DEBUG', `🔧 使用实际用户数据目录: ${actualUserDataDir} (profileId: ${profileId})`);

        // 预防扩展迁移提示：确保 Default 目录存在，并备份可能冲突的 Extensions 目录
        try {
            const defaultDir = path.join(actualUserDataDir, 'Default');
            await fs.mkdir(defaultDir, { recursive: true });
            const extDir = path.join(defaultDir, 'Extensions');
            const bakDir = path.join(defaultDir, 'Extensions_backup');
            if (fsSync.existsSync(extDir) && !fsSync.existsSync(bakDir)) {
                try {
                    fsSync.renameSync(extDir, bakDir);
                    log('WARN', `⚠️ 检测到扩展目录，已备份为: ${bakDir}`);
                } catch (reErr) {
                    log('WARN', `⚠️ 备份扩展目录失败: ${reErr.message}`);
                }
            }
            const rootExt = path.join(actualUserDataDir, 'Extensions');
            const destExt = path.join(defaultDir, 'Extensions');
            if (fsSync.existsSync(rootExt)) {
                try {
                    if (!fsSync.existsSync(destExt)) {
                        try { fsSync.renameSync(rootExt, destExt); }
                        catch {
                            const copyDir = async (src, dst) => {
                                await fs.mkdir(dst, { recursive: true });
                                const entries = await fs.readdir(src, { withFileTypes: true });
                                for (const entry of entries) {
                                    const s = path.join(src, entry.name);
                                    const d = path.join(dst, entry.name);
                                    if (entry.isDirectory()) await copyDir(s, d);
                                    else await fs.copyFile(s, d);
                                }
                            };
                            await copyDir(rootExt, destExt);
                            try { await fs.rm(rootExt, { recursive: true, force: true }); } catch {}
                        }
                        log('INFO', `📦 已将根扩展目录迁移到: ${destExt}`);
                    } else {
                        const rootBak = path.join(actualUserDataDir, `Extensions_root_backup_${Date.now()}`);
                        try { fsSync.renameSync(rootExt, rootBak); } catch {}
                        log('WARN', `⚠️ 根扩展目录重复，已备份为: ${rootBak}`);
                    }
                } catch (mErr) {
                    log('WARN', `⚠️ 根扩展目录迁移失败: ${mErr.message}`);
                }
            }
        } catch (prepErr) {
            log('WARN', `⚠️ 预处理用户数据目录失败: ${prepErr.message}`);
        }

        // 🚀 性能优化：构建优化的Chrome启动参数
        let chromeArgs = [
            // 移除冗余的 --user-data-dir，由 puppeteer launchOptions 处理
            `--remote-debugging-port=${debugPort}`,
            // 窗口配置 - 移除 --start-maximized 以允许 --window-size 参数正常工作
            // ⚠️ 原来的 --disable-web-security 是个很强的"非正常浏览器"信号（同源策略被关掉，
            //    cookie/跨域行为都反常），真实用户 Chrome 不会有它 —— 已移除。
            // 🔒 WebRTC 强制走代理：否则 ICE 收集会绕过代理暴露真实公网/内网 IP，
            //    与账号的登录 IP 不符，是很硬的判定依据。
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--enforce-webrtc-ip-permission-check',
            '--disable-popup-blocking',
            // 禁用所有通知弹窗
            '--disable-notifications',
            // 移除 --disable-sync 以允许历史记录保存
            '--disable-translate',
            // 性能优化
            '--disable-background-timer-throttling',
            
            '--disable-features=VizDisplayCompositor',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-field-trial-config',
            // 移除 --disable-back-forward-cache 以支持历史记录导航
            '--disable-background-networking',
            '--disable-client-side-phishing-detection',
            '--disable-ipc-flooding-protection',
            // 移除 --disable-prompt-on-repost 以启用密码保存提示
            '--disable-dev-shm-usage',
            // 系统相关
            // ⚠️ 这里原先是 '--no-sandbox'：Chrome 会因此在窗口顶部显示
            //    「You are using an unsupported command-line flag: --no-sandbox」黄色警告条。
            //    服务用**普通权限**启动时系统沙箱可用，不需要它；只有在提权(管理员)进程下
            //    Chrome 用不了沙箱时才有必要，那时需配合 --test-type 抑制警告条。
            // 移除 --no-first-run 以允许正常的浏览器初始化
            '--no-default-browser-check',
            '--disable-hang-monitor',
            // ⚠️ 原来这里有 --disable-gpu / --disable-software-rasterizer：结果真实页面里
            //    canvas.getContext('webgl') 直接返回 null —— 真人电脑不可能没有 WebGL，
            //    这本身就是极强的"自动化环境"特征，而且会让上面辛苦伪装的 GPU 指纹失效。
            //    有 GPU 的机器就正常走 GPU；没有的由 Chrome 自己回退到软件渲染。
            // 内存优化
            '--memory-pressure-off',
            '--max_old_space_size=4096',
            '--js-flags=--max-old-space-size=4096',
            // 🔐 启用原生密码管理器功能
            '--enable-password-manager-reauthentication',
            '--enable-save-password-bubble',
            '--enable-password-generation',
            '--enable-password-manager',
            '--password-store=basic',
            // 启用密码管理器与书签栏相关功能
            '--enable-features=PasswordManager,PasswordGeneration,PasswordImport,PasswordExport,BookmarkBar',
            // 确保表单自动完成功能正常
            '--enable-autofill-keyboard-accessory-view',
            // 允许密码保存提示
            '--enable-password-save-bubble',
            // 确保密码管理器数据库正确初始化
            '--enable-password-manager-ui'
        ];
        // ⚠️ 这里原先是 '--disable-blink-features=AutomationControlled'：它会让 Chrome 在窗口顶部显示
        //    「You are using an unsupported command-line flag: --disable-blink-features=AutomationControlled」黄色警告条
        //    （Puppeteer 默认带的 --enable-automation 被 ignoreDefaultArgs 移除后，Chrome 就不再压这条警告了）。
        //    该 flag 唯一作用是让 navigator.webdriver 为 false，而这一层已由 _stealthScript 里的
        //    Object.defineProperty(navigator,'webdriver') 通过 evaluateOnNewDocument 在每个文档创建前覆盖，
        //    比 flag 更彻底 → 删掉后警告条消失，命令行也少一个非默认参数。不要再加回来。
        chromeArgs.push('--disable-features=TranslateUI,IsolateOrigins,site-per-process');
        // 🦎 浏览器兼容：禁用进程复用以防止自定义 user-data-dir 被忽略
        chromeArgs.push('--disable-features=ProcessReuse');
        // Edge 专用：禁用 Edge 的进程复用和会话恢复
        chromeArgs.push('--disable-features=msEdgeElevationManager,msEdgeProcessReuse,msEdgeSessionCrashed');
        chromeArgs.push('--disable-features=msEdgeInPrivate,msEdgeSidebarV2');

        // 商店访问优化：当需要访问 Chrome Web Store/扩展页面时，移除可能导致卡顿的限制参数
        try {
            if (config && (config.storeOptimized === true)) {
                const removeFlags = new Set([
                    '--disable-background-networking',
                    '--disable-renderer-backgrounding',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-features=VizDisplayCompositor'
                ]);
                chromeArgs = chromeArgs.filter(f => !removeFlags.has(f));
                log('INFO', '🛍️ 已启用商店访问优化参数');
            }
        } catch {}

        // 🚀 修正：添加代理配置（仅当代理已启用且配置有效时）
        //    具体策略（隧道 / 本地认证转发器 / 直连）统一收敛到 buildProxyChromeArgs，
        //    与「获取 Token」临时浏览器共用同一套，避免两边逻辑漂移
        if (config && config.proxyEnabled !== false && proxy && proxy.host && proxy.port) {
            chromeArgs.push(...(await buildProxyChromeArgs(proxy, profileId)));
        }

        // 添加User Agent（用画像里的最终 UA，保证与 UA-CH / platform 一致）
        if (fpUserAgent) {
            chromeArgs.push(`--user-agent=${fpUserAgent}`);
            log('DEBUG', `🔧 User Agent: ${fpUserAgent.substring(0, 60)}...`);
        }

        // 🖥️ 窗口大小：默认**不固定**，交给 Chrome 用它自己记忆的尺寸，用户可以自由拖动/最大化。
        //    之前这里（以及上面那行 --window-size=1920,1080）是无条件钉死窗口的，所以既不能最大化、
        //    拖动也不重排。「显示器分辨率」由画像通过 screen.* 注入体现 —— 真人本来就是窗口小于屏幕。
        if (config.windowSize && config.forceWindowSize) {
            const forced = String(config.windowSize).replace(/[x×,]/g, ',');
            chromeArgs.push(`--window-size=${forced}`);
            log('INFO', `🖥️ 强制窗口大小: ${forced}（调用方显式要求 forceWindowSize）`);
        } else {
            log('INFO', `🖥️ 窗口大小: 不固定（可自由调整/最大化）；画像显示器分辨率 ${fingerprint.width}x${fingerprint.height}`);
        }

        // 🌐 语言：与画像 / navigator.languages / Accept-Language 三者保持一致
        //    （原来按 fbLanguage 硬映射成 en-US，用户配置的 language 根本不生效）
        const chromeLang = fingerprint.language || 'en-US';
        chromeArgs.push(`--lang=${chromeLang}`);
        log('INFO', `🌐 语言: ${chromeLang}（languages=${fingerprint.languages.join(',')}）`);

        // 🏷️ 添加窗口标题配置 - 优化版，确保任务栏显示卡片ID且不出现灰色浏览器
        if (windowTitle) {
            // 基础窗口标题设置
            chromeArgs.push(`--window-name=${windowTitle}`);
            chromeArgs.push(`--app-name=${windowTitle}`);
            // 移除 --force-app-mode 和 --app 参数，这些会导致灰色浏览器
            
            // 强化任务栏显示的额外参数
            chromeArgs.push(`--class=${windowTitle}`);
            chromeArgs.push(`--name=${windowTitle}`);
            chromeArgs.push(`--title=${windowTitle}`);
            
            // 防止标题被覆盖的参数
            chromeArgs.push(`--disable-features=TranslateUI`);
            chromeArgs.push(`--disable-ipc-flooding-protection`);
            
            log('INFO', `🏷️ 优化窗口标题: ${windowTitle}`);
            log('INFO', `🏷️ 任务栏显示参数已添加（已修复灰色浏览器问题）`);
        }

        // 优先使用环境变量指定的 Chrome 路径（CHROME_PATH / PUPPETEER_EXECUTABLE_PATH），否则使用系统默认 Chrome
        const envChromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
        log('INFO', `🔧 环境变量 CHROME_PATH=${process.env.CHROME_PATH || '未设置'}`);
        log('INFO', `🔧 环境变量 PUPPETEER_EXECUTABLE_PATH=${process.env.PUPPETEER_EXECUTABLE_PATH || '未设置'}`);
        let effectiveExecutablePath = findChromeExecutable() || envChromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        const isBundled = effectiveExecutablePath.includes('bundled-chrome');
        log('INFO', `🔧 使用 Chrome 可执行文件: ${effectiveExecutablePath}${isBundled ? ' (📦 捆绑版)' : ''}`);
        const launchOptions = {
            executablePath: effectiveExecutablePath,
            headless: false,
            args: chromeArgs,
            userDataDir: actualUserDataDir,
            defaultViewport: null,
            ignoreDefaultArgs: [
                '--disable-extensions',
                '--disable-component-extensions-with-background-pages',
                '--disable-background-networking',
                '--disable-sync',
                '--enable-automation'
            ],
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            timeout: 10000, // 🔥 Chrome 启动上限 10 秒：超时 puppeteer 会直接杀掉进程，避免卡死拖住后续启动
            protocolTimeout: 60000 // CDP 协议超时（从120秒缩短到60秒）
        };

        log('INFO', `🚀 准备调用 puppeteer.launch: ${JSON.stringify({
            executablePath: launchOptions.executablePath,
            userDataDir: launchOptions.userDataDir,
            debugPort,
            argsCount: launchOptions.args.length,
            headless: launchOptions.headless
        }, null, 2)}`);

        // 🦎 浏览器兼容：只杀掉使用相同 user-data-dir 的已有进程，避免杀死用户自己的浏览器
        try {
            const customDir = launchOptions.userDataDir || '';
            const killed = killBrowserProcessesUsingDir(customDir);
            if (killed.length) {
                log('WARN', `🔪 已清理占用该 profile 的残留浏览器进程 (profileId=${profileId}): PIDs=${killed.join(',')}`);
                // 等待文件句柄释放，避免紧接着的 launch 仍被判为 profile 被占用
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (killErr) {
            log('WARN', `⚠️ 清理残留浏览器进程失败 (profileId=${profileId}): ${killErr.message}`);
        }

        // 🧹 清理残留的 Chrome 单例锁：上次被强杀/异常退出留下的 Singleton* / lockfile
        //    会让新 Chrome 启动约 1 秒后因"profile 被占用"自行退出（puppeteer 报 Target closed / already running）
        const cleanStaleLocks = () => {
            try {
                const lockDir = launchOptions.userDataDir || '';
                if (!lockDir) return;
                for (const f of fsSync.readdirSync(lockDir)) {
                    if (/^(Singleton|lockfile)/.test(f)) {
                        try { fsSync.unlinkSync(path.join(lockDir, f)); } catch {}
                    }
                }
            } catch {}
        };
        cleanStaleLocks();

        // 🚀 启动浏览器；若因锁残留/竞争启动即退出，清理锁后自动重试一次
        let browser;
        try {
            browser = await puppeteer.launch(launchOptions);
        } catch (err) {
            const launchMsg = String((err && err.message) || err);
            log('WARN', `❌ 浏览器启动失败 (profileId=${profileId}): ${launchMsg}`);
            if (/already running/i.test(launchMsg)) {
                const occupied = await isDebugPortOccupied(debugPort).catch(() => false);
                log('WARN', `🔍 启动失败诊断 (profileId=${profileId}): debugPort=${debugPort}, 端口仍被占用=${occupied}${occupied ? ' → 真正原因是调试端口被其他 Chrome 占用（devtools 起不来），"already running" 为误报' : ''}`);
            }
            if (/Target closed|browser closed|has crashed|closed/i.test(launchMsg)) {
                try { cleanStaleLocks(); } catch {}
                await new Promise(r => setTimeout(r, 800));
                try {
                    log('INFO', `🔁 已清理残留锁，重试启动浏览器 (profileId=${profileId})`);
                    browser = await puppeteer.launch(launchOptions);
                } catch (err2) {
                    log('WARN', `❌ 浏览器启动重试仍失败 (profileId=${profileId}): ${err2.message}`);
                    throw err2;
                }
            } else {
                throw err;
            }
        }

        // 🎯 UA 版本对齐真实 Chrome：本机 Chrome 实际是 154，UA 里却写着 131 —— UA-CH、
        //    客户端提示、特性检测都会对不上。这里把 UA 的版本号换成真实版本（OS 部分保持画像不变），
        //    并同步更新 UA-CH 元数据，让 navigator.userAgent 与 Sec-CH-UA 完全一致。
        try {
            const realVersion = await browser.version();
            const vm = String(realVersion).match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
            if (vm) {
                const realMajor = vm[1];
                const realFull = `${vm[1]}.${vm[2]}.${vm[3]}.${vm[4]}`;
                // ⚠️ 只对纯 Chrome UA 对齐：Edge/Opera 的 UA 里 Chrome 内核版本与 Edg/OPR 版本
                //    必须配套，只换 Chrome 版本会造出「Chrome/154 … Edg/120」这种矛盾组合。
                if (fingerprint.browser === 'chrome' && fingerprint.chromeMajor !== realMajor) {
                    const prevUa = fingerprint.userAgent;
                    fingerprint.userAgent = String(fingerprint.userAgent).replace(/Chrome\/\d+(?:\.\d+){0,3}/, `Chrome/${realFull}`);
                    fingerprint.chromeMajor = realMajor;
                    fingerprint.chromeFull = realFull;
                    log('INFO', `🎯 UA 版本已对齐真实 Chrome：${(prevUa.match(/Chrome\/[\d.]+/) || ['?'])[0]} → Chrome/${realFull}`);
                }
            }
            log('INFO', `🎯 实际 Chrome 版本: ${realVersion}`);
        } catch (verErr) {
            log('WARN', `⚠️ 读取/对齐 Chrome 版本失败: ${verErr.message}`);
        }
        // 🧬 画像定稿：browser-routes 后续新建页面时复用这一份（含对齐后的 UA）
        _fingerprintCache.set(String(profileId), fingerprint);

        // 🍪 核心修复：安装Cookie实时同步到所有新创建的页面
        browser.on('targetcreated', async (target) => {
            try {
                if (target.type() === 'page') {
                    const page = await target.page();
                    if (page) {
                        // 1. 自我隐藏 / 完整指纹画像（时区、UA-CH、platform、screen、WebGL、Canvas…）
                        //    统一交给 applyStealthToPage：以前这里是内联脚本，platform 硬编码 'Win32'、
                        //    screen 硬编码 1920x1080、WebGL 默认 "Intel Iris OpenGL Engine"（Mac 格式），
                        //    与 UA 里声明的 Mac 直接打架，一百多个号还共用同一套值。
                        await applyStealthToPage(page, fingerprint, 'targetcreated');
                        // 1.5 viewport 已由 applyStealthToPage 与画像分辨率一起设置
                        
                        // 2. 代理认证
                        if (proxy && proxy.username && proxy.password) {
                            try {
                                await page.authenticate({
                                    username: proxy.username,
                                    password: proxy.password
                                });
                            } catch (authErr) { log('WARN', `⚠️ 代理认证失败: ${authErr.message}`); }
                        }

                        // 3. Cookie 实时同步
                        const pid = String(profileId || config.profileId || '');
                        if (pid) {
                            try { attachCookieSync(page, pid); } catch (e) {
                                log('WARN', `🍪 为新页面 ${page.url()} 安装Cookie同步失败: ${e.message}`);
                            }
                        }
                    }
                }
            } catch (error) {
                log('WARN', '⚠️ 处理 targetcreated 事件失败:', error.message);
            }
        });

        // 🎭 启动时就存在的首页不会触发 targetcreated —— 不补这一步，首屏（也就是 Facebook 登录页）
        //    会完全没有指纹注入，等于一个"裸奔的自动化浏览器"。
        try {
            const initialPages = await browser.pages();
            for (const p of initialPages) {
                try { await applyStealthToPage(p, fingerprint, 'initial-page'); } catch {}
            }
            log('INFO', `🎭 已对 ${initialPages.length} 个初始页面应用画像：${fingerprint.os} ${fingerprint.width}x${fingerprint.height} ${fingerprint.cpuCores}C/${fingerprint.deviceMemory}G ${fingerprint.language}${fingerprint.timezone ? ' TZ=' + fingerprint.timezone : ' TZ=跟随系统（未配置时区）'}`);
        } catch (initFpErr) {
            log('WARN', `🎭 初始页面指纹应用失败: ${initFpErr.message}`);
        }

        // 🌍 时区跟随代理出口：配置里没写 timezone 时，用浏览器自己（已经挂在代理上）
        //    查一次出口 IP 的时区。代理在美国、系统时区却是 Asia/Shanghai 是最硬的判定信号之一。
        //    🐛 以前的三个毛病：
        //      ① 结果按 profileId 缓存 → 换了代理仍用旧时区（时区不再跟着代理走）→ 现在按代理身份缓存；
        //      ② 端点**串行**且首个是 http://ip-api.com → 被代理掐掉时要依次干等，实测白等满 6s 才失败；
        //      ③ 失败不留痕 → 每次启动都重试、每次都白亏一个超时 → 现在加 10 分钟负缓存。
        if (!fingerprint.timezone) {
            const tzFailAt = _tzFailCache.get(tzKey) || 0;
            if (Date.now() - tzFailAt < TZ_FAIL_TTL_MS) {
                log('INFO', `🌍 时区探测近期失败过，本次跳过（沿用系统时区）proxy=${tzKey}`);
            } else {
            try {
                const tzPage = (await browser.pages())[0];
                if (tzPage) {
                    const detected = await Promise.race([
                        tzPage.evaluate(async () => {
                            // 多个 HTTPS 端点**并行**赛跑：串行时任意一个卡住都会拖满整个超时预算。
                            // （http://ip-api.com 只提供 http，容易被代理拦，放最后单独兜底）
                            const endpoints = [
                                'https://ipinfo.io/json',
                                'https://ipapi.co/json/',
                                'https://worldtimeapi.org/api/ip',
                            ];
                            const pick = (d) => (d && (d.timezone || d.time_zone)) || '';
                            const one = async (url) => {
                                const resp = await fetch(url, { cache: 'no-store' });
                                if (!resp.ok) throw new Error('http ' + resp.status);
                                const tz = pick(await resp.json());
                                if (!tz) throw new Error('no timezone field');
                                return tz;
                            };
                            try {
                                return await Promise.any(endpoints.map(one));
                            } catch {
                                try { return await one('http://ip-api.com/json/?fields=status,timezone'); }
                                catch { return ''; }
                            }
                        }).catch(() => ''),
                        sleep(TZ_PROBE_TIMEOUT_MS).then(() => '')
                    ]);
                    if (detected) {
                        _detectedTimezoneCache.set(tzKey, { tz: detected, ts: Date.now() });
                        _tzFailCache.delete(tzKey);
                        fingerprint.timezone = detected;
                        await applyStealthToPage(tzPage, fingerprint, 'timezone-detect');
                        log('INFO', `🌍 时区已按代理出口对齐: ${detected} (proxy=${tzKey}, profileId=${profileId})`);
                    } else {
                        _tzFailCache.set(tzKey, Date.now());
                        log('WARN', `🌍 未能探测代理出口时区，本次沿用系统时区 (proxy=${tzKey}, profileId=${profileId})，${Math.round(TZ_FAIL_TTL_MS / 60000)} 分钟内不再重试`);
                    }
                }
            } catch (tzErr) {
                _tzFailCache.set(tzKey, Date.now());
                log('WARN', `🌍 时区探测失败 (profileId=${profileId}): ${tzErr.message}`);
            }
            }
        }

        // 全局提升协议超时，确保后续 CDP 调用更稳健
        try {
            if (typeof browser.setDefaultProtocolTimeout === 'function') {
                browser.setDefaultProtocolTimeout(120000);
                log('DEBUG', '⏱️ 已设置默认协议超时为 120000ms');
            }
        } catch (protoErr) {
            log('WARN', `⚠️ 设置默认协议超时失败: ${protoErr.message}`);
        }

        // 设置全局代理认证
        if (proxy && proxy.username && proxy.password) {
            browser.on('targetcreated', async (target) => {
                const page = await target.page();
                if (page) {
                    await page.authenticate({
                        username: proxy.username,
                        password: proxy.password
                    });
                }
            });
        }

        // 🔐 初始化密码管理器
        try {
            const pages = await browser.pages();
            if (pages.length > 0) {
                const page = pages[0];
                // 提升页面默认超时，减少慢网络/页面导致的超时
                try {
                    if (typeof page.setDefaultTimeout === 'function') {
                        page.setDefaultTimeout(60000);
                    }
                    if (typeof page.setDefaultNavigationTimeout === 'function') {
                        page.setDefaultNavigationTimeout(60000);
                    }
                    log('DEBUG', '⏱️ 已设置页面默认超时与导航超时为 60000ms');
                } catch (pageTimeoutErr) {
                    log('WARN', `⚠️ 设置页面默认超时失败: ${pageTimeoutErr.message}`);
                }
                
                // 启用密码管理器相关的 CDP 域
                const client = await page.target().createCDPSession();
                await client.send('Runtime.enable');
                await client.send('Page.enable');
                
                // 🚀 性能优化：按需初始化密码管理器状态（使用 safePageEvaluateVoid 兼容 Chrome 149）
                await safePageEvaluateVoid(page, () => {
                    window.__passwordManagerEnabled = true;
                    if (window.navigator && window.navigator.credentials) {
                        window.__passwordManagerAvailable = true;
                    }
                });
                
                log('DEBUG', '✅ 密码管理器初始化完成');
            }
        } catch (initError) {
            log('WARN', '⚠️ 密码管理器初始化失败:', initError.message);
        }

        // 🏷️ 启动标题持续监控，确保任务栏始终显示卡片ID
        if (windowTitle) {
            try {
                await this.startTitleMonitoring(browser, windowTitle);
                log('INFO', `🏷️ 标题监控已启动: ${windowTitle}`);
            } catch (titleError) {
                log('WARN', '⚠️ 标题监控启动失败:', titleError.message);
            }
        }

        // 已移除：卡片信息标签页创建逻辑

        return browser;
    }

    // 🚀 性能优化：清理空闲实例
    async cleanupIdleInstances() {
        const now = Date.now();
        const toRemove = [];

        for (const [key, instance] of this.instances) {
            if (now - instance.lastUsed > BROWSER_IDLE_TIMEOUT) {
                toRemove.push(key);
            }
        }

        for (const key of toRemove) {
            await this.destroyInstance(key);
        }

        if (toRemove.length > 0) {
            log('INFO', `🧹 清理了 ${toRemove.length} 个空闲浏览器实例`);
        }
    }

    // 🚀 根治：浏览器退出/断开时立即从注册表移除并修正统计，防止实例长期堆积
    _attachInstanceCleanup(instanceKey, instance) {
        if (!instance || !instance.browser) return;
        const forget = () => this._removeInstanceEntry(instanceKey, instance);
        try { instance.browser.once('disconnected', forget); } catch (e) {}
        try {
            const proc = instance.browser.process ? instance.browser.process() : null;
            if (proc) proc.once('exit', forget);
        } catch (e) {}
    }

    // 幂等移除注册表条目（仅当仍是同一实例时删除并修正统计，避免重复计数）
    _removeInstanceEntry(instanceKey, instance) {
        if (!instance || this.instances.get(instanceKey) !== instance) return;
        this.instances.delete(instanceKey);
        this.stats.active = Math.max(0, this.stats.active - 1);
        this.stats.destroyed++;
        log('INFO', `🧹 移除浏览器实例注册: ${instanceKey} (created=${this.stats.created}, active=${this.stats.active}, destroyed=${this.stats.destroyed})`);
    }

    // 🚀 性能优化：销毁实例
    async destroyInstance(key) {
        const instance = this.instances.get(key);
        if (instance) {
            try {
                if (instance.browser && instance.browser.isConnected()) {
                    logBrowserClose(key, '销毁浏览器实例(destroyInstance)', 'BrowserManager.destroyInstance');
                    await instance.browser.close();
                }
                log('DEBUG', `🗑️ 浏览器实例已销毁: ${key}`);
            } catch (error) {
                log('WARN', `⚠️ 关闭浏览器实例失败: ${error.message}`);
            }
            this._removeInstanceEntry(key, instance);
        }
    }

    // 🏷️ 启动标题持续监控，确保任务栏始终显示卡片ID
    async startTitleMonitoring(browser, windowTitle) {
        try {
            const pages = await browser.pages();
            if (pages.length === 0) {
                // 已移除：为标题监控强制创建空白页；改为等待新页面
                log('DEBUG', 'ℹ️ 当前无页面，等待新页面创建以设置标题监控');
            } else {
                // 在现有页面上设置监控
                await this.setupTitleMonitoringOnPage(pages[0], windowTitle);
            }

            // 监听新页面创建事件
            browser.on('targetcreated', async (target) => {
                try {
                    if (target.type() === 'page') {
                        const page = await target.page();
                        if (page) {
                            await this.setupTitleMonitoringOnPage(page, windowTitle);
                        }
                    }
                } catch (error) {
                    log('WARN', '⚠️ 新页面标题监控设置失败:', error.message);
                }
            });

            log('INFO', `🏷️ 标题监控设置完成: ${windowTitle}`);
        } catch (error) {
            log('ERROR', '❌ 标题监控启动失败:', error.message);
            throw error;
        }
    }

    // 🏷️ 在页面上设置标题监控
    async setupTitleMonitoringOnPage(page, windowTitle) {
        try {
            // 注入标题监控脚本
            await page.evaluateOnNewDocument((title) => {
                // 立即设置标题
                document.title = title;
                
                // 创建持续监控
                let titleMonitorInterval;
                
                const startTitleMonitoring = () => {
                    // 清除之前的监控
                    if (titleMonitorInterval) {
                        clearInterval(titleMonitorInterval);
                    }
                    
                    // 普通页面：正常监控
                    titleMonitorInterval = setInterval(() => {
                        if (document.title !== title) {
                            document.title = title;
                            console.log(`🏷️ 标题已重置为: ${title}`);
                        }
                    }, 2000);
                };
                
                // 页面加载完成后启动监控
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', startTitleMonitoring);
                } else {
                    startTitleMonitoring();
                }
                
                // 监听标题变化
                const observer = new MutationObserver((mutations) => {
                    mutations.forEach((mutation) => {
                        if (mutation.type === 'childList' && mutation.target.tagName === 'TITLE') {
                            if (document.title !== title) {
                                document.title = title;
                                console.log(`🏷️ 标题被重置: ${title}`);
                            }
                        }
                    });
                });
                
                // 开始观察title元素变化
                const titleElement = document.querySelector('title');
                if (titleElement) {
                    observer.observe(titleElement, { childList: true, characterData: true });
                }
                
                // 监听页面标题变化事件
                document.addEventListener('DOMContentLoaded', () => {
                    const titleElement = document.querySelector('title');
                    if (titleElement) {
                        observer.observe(titleElement, { childList: true, characterData: true });
                    }
                });
                
                console.log(`🏷️ 标题监控脚本已注入: ${title}`);
            }, windowTitle);

            log('DEBUG', `🏷️ 页面标题监控已设置: ${windowTitle}`);
        } catch (error) {
            log('WARN', '⚠️ 页面标题监控设置失败:', error.message);
        }
    }

    // 已移除：关闭初始空白页和信息页逻辑

    // 已移除：卡片信息标签页创建函数

    // 已移除：卡片信息HTML生成函数

    // 获取统计信息
    getStats() {
        return {
            ...this.stats,
            poolSize: this.pool.length,
            instanceCount: this.instances.size
        };
    }

    // 清理所有实例
    async cleanup() {
        const keys = Array.from(this.instances.keys());
        for (const key of keys) {
            await this.destroyInstance(key);
        }
        // 🚄 清理所有 SSH 隧道
        try { sshTunnelManager.closeAll(); } catch {}
        try { socksChainServer.closeAll(); } catch {}
    }
}

// 创建浏览器管理器实例
const browserManager = new BrowserManager();

// 🚀 启动队列管理 — 支持超时、内存感知、优先级
class LaunchQueue {
    constructor(maxConcurrent = MAX_CONCURRENT_LAUNCHES) {
        this.queue = [];
        this.running = 0;
        this.maxConcurrent = maxConcurrent;
        this.taskTimeout = parseInt(process.env.LAUNCH_TASK_TIMEOUT || '120000', 10); // 单个任务超时
    }

    // 🚀 动态修改并发数
    setMaxConcurrent(val) {
        this.maxConcurrent = Math.max(1, Math.min(20, parseInt(val, 10) || 5));
        log('INFO', `[LaunchQueue] 并发数已更新: ${this.maxConcurrent}`);
    }

    async add(task, priority = 0, onTimeout = null) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject, priority, createdAt: Date.now(), onTimeout });
            // 按优先级排序（高优先级在前）
            this.queue.sort((a, b) => b.priority - a.priority);
            this.process();
        });
    }

    async process() {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        this.running++;
        const item = this.queue.shift();
        const { task, resolve, reject, onTimeout } = item;

        // 🔓 名额（running）只释放一次：
        //    原实现里超时回调和 finally 各减一次，任务超时后会把 running 减成负数 → 并发上限失效
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            clearTimeout(timeoutId);
            this.running = Math.max(0, this.running - 1);
            this.process(); // 处理下一个任务
        };

        // 🔥 超时保护：先清理该任务已启动的浏览器（避免留下僵尸进程占着端口/profile 目录），再释放名额
        const timeoutId = setTimeout(async () => {
            if (released) return;
            log('WARN', `[LaunchQueue] 任务超时 ${this.taskTimeout}ms，清理并释放名额（队列剩余 ${this.queue.length}）`);
            if (typeof onTimeout === 'function') {
                try { await onTimeout(); } catch (e) { log('WARN', `[LaunchQueue] 超时清理失败: ${e.message}`); }
            }
            if (!released) reject(new Error(`启动超时 (${this.taskTimeout}ms)`));
            release();
        }, this.taskTimeout);

        try {
            const result = await task();
            if (!released) resolve(result);
        } catch (error) {
            if (!released) reject(error);
        } finally {
            release();
        }
    }

    // 🚀 检测是否过载（内存/并发）
    isOverloaded() {
        try {
            const memUsage = process.memoryUsage();
            const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
            // 如果堆内存超过2GB或并发数接近上限，视为过载
            return memMB > 2048 || this.running >= this.maxConcurrent;
        } catch { return false; }
    }

    getStats() {
        return {
            queueLength: this.queue.length,
            running: this.running,
            maxConcurrent: this.maxConcurrent,
            overloaded: this.isOverloaded()
        };
    }
}

const launchQueueManager = new LaunchQueue();

/**
 * 🛡️ 辅助函数：确保浏览器正在运行，如果没运行则自动启动
 * @param {string} profileId 
 * @returns {Promise<{success: boolean, browserData?: any, error?: string}>}
 */
async function isProfileRunning(profileId) {
    try {
        const browserData = activeBrowsers.get(String(profileId));
        return !!(browserData && browserData.browser && browserData.browser.isConnected());
    } catch {
        return false;
    }
}

// 🚀 通用工具：浏览器断开时自动重新执行整个任务（而不是重启浏览器继续操作损坏的页面）
// 使用方式：await executeWithBrowserRetry(profileId, async (attempt) => { ... 你的操作 ... });
async function executeWithBrowserRetry(profileId, operation, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation(attempt);
        } catch (e) {
            const isBrowserDead = e && /Session closed|detached Frame|Protocol error|Target closed|Unable to find page|Page crashed/i.test(e.message);
            if (isBrowserDead && attempt < maxRetries) {
                log('WARN', `[Retry] 浏览器断开，重新执行整个任务 (profileId=${profileId}, attempt=${attempt+1}/${maxRetries})...`);
                // 清理浏览器进程
                try {
                    const bd = activeBrowsers.get(String(profileId));
                    if (bd && bd.browser) {
                        logBrowserClose(profileId, `浏览器断开(${String(e && e.message).slice(0, 80)})后清理旧实例重试`, 'executeWithBrowserRetry');
                        try { await bd.browser.close(); } catch {}
                    }
                    activeBrowsers.delete(String(profileId));
                } catch {}
                await sleep(2000);
                continue;
            }
            throw e;
        }
    }
}

async function ensureBrowserIsRunning(profileId, proxyOverride, extraCookies, opts) {
    let browserData = activeBrowsers.get(String(profileId));
    // 🔐 awaitLogin 时的登录结论：true=已登录 / false=等了但没成功 / null=未等待（复用已有实例或没带该开关）
    let loginOk = null;
    
    // 🚀 如果传入了代理覆盖，且浏览器已运行，检查代理是否一致
    // 如果不一致，先关闭现有浏览器，用新代理重新启动
    if (proxyOverride && browserData && browserData.browser && browserData.browser.isConnected()) {
        const currentProxy = browserData.proxy;
        const proxyChanged = JSON.stringify(currentProxy) !== JSON.stringify(proxyOverride);
        if (proxyChanged) {
            log('INFO', `🔁 检测到代理覆盖变更，先关闭现有浏览器并用新代理重新启动 profileId=${profileId}`);
            logBrowserClose(profileId, `代理覆盖变更(${String(currentProxy && currentProxy.host)}:${String(currentProxy && currentProxy.port)} → ${String(proxyOverride && proxyOverride.host)}:${String(proxyOverride && proxyOverride.port)})，重建浏览器`, 'ensureBrowserIsRunning');
            try {
                await browserData.browser.close();
            } catch {}
            activeBrowsers.delete(String(profileId));
            browserData = null;
        } else {
            return { success: true, browserData };
        }
    }
    
    if (browserData && browserData.browser && browserData.browser.isConnected()) {
        return { success: true, browserData };
    }

    // 🔎 关联上一次关闭原因：批量里"关了又自动重启"到底是谁先关的，一行就能对上。
    const _lastClose = peekBrowserCloseReason(profileId);
    log('INFO', `🚀 自动化任务检测到浏览器未运行，正在为 profileId=${profileId} 自动启动浏览器...${_lastClose ? `（上一次关闭：原因=${_lastClose.reason}｜触发点=${_lastClose.by}｜${Math.round((Date.now() - _lastClose.at) / 1000)}s 前）` : '（未记录到关闭原因：可能是首次启动/服务重启后内存态丢失）'}`);
    try {
        // 调用内部启动逻辑 (模拟 API 请求)
        const port = process.env.PUPPETEER_PORT || 9999;
        const launchUrl = `http://127.0.0.1:${port}/api/launch-browser`;
        
        // 🪶 兜底自动启动一律按「借用型」拉起：这条路径是各路由临时拉起来干活的，
        //    没有明确的归属方 —— 以前建成常驻型，干完没人调 /api/stop-browser，
        //    于是永久占着 user-data-dir 变成孤儿，下一轮启动直接撞车
        //    （实测 5879：`The browser is already running for ...\browser-profiles\5879`）。
        //    带 borrow 后交给现成的空闲回收兜底：满 BORROWED_IDLE_MS(默认60s) 无请求自动关闭。
        const launchPayload = { profileId, skipConcurrencyCheck: false, borrow: true };
        // 🕒 opts.awaitLogin：要求启动端「等页面校验/自动登录跑完」再返回。
        //    改国家/货币/时区/账单这类动作必须已登录才做得成，抢跑会白跑一轮。
        const _awaitLogin = !!(opts && opts.awaitLogin);
        if (_awaitLogin) launchPayload.awaitLogin = true;
        // 🔍 先取一次配置：用于补 UA，以及 Cookie 的最后兜底
        const launchProfile = await findProfileById(String(profileId)).catch(() => null);
        // 🐛 修复：以前这里从不传 userAgent，服务端只能退化成通用 UA（甚至为空），
        //    结果「自动启动」出来的浏览器指纹和 profile 里配的对不上。
        //    现在显式带上配置里的 UA；取不到就明确告警，不静默。
        if (launchProfile?.userAgent) {
            launchPayload.userAgent = launchProfile.userAgent;
            log('INFO', `🧬 自动启动携带配置中的 UserAgent (profileId=${profileId}): ${String(launchProfile.userAgent).slice(0, 60)}...`);
        } else {
            log('WARN', `⚠️ 自动启动未取到 profile ${profileId} 的 UserAgent：本次将使用服务端默认 UA（指纹可能与配置不一致）`);
        }
        // 📤 优先使用调用方显式传入的 Cookie
        if (extraCookies && extraCookies.length > 0) {
            launchPayload.cookies = extraCookies;
            log('INFO', `📌 自动重启携带调用方传入的 ${extraCookies.length} 个Cookie (profileId=${profileId})`);
        } else {
            // 🗄️ 从缓存读取最后已知的 Cookie，重启时注入，避免丢失登录态
            const cachedCookies = profileCookiesCache.get(String(profileId));
            if (cachedCookies && cachedCookies.length > 0) {
                launchPayload.cookies = cachedCookies;
                log('INFO', `📌 自动重启携带缓存中的 ${cachedCookies.length} 个Cookie (profileId=${profileId})`);
            } else {
                // 🗄️ 缓存无 Cookie 时，尝试从远程存储拉取（新 Profile 首次启动场景）
                try {
                    const stored = await getCookiesFromStorage(profileId);
                    if (Array.isArray(stored) && stored.length > 0) {
                        launchPayload.cookies = stored;
                        log('INFO', `📌 从远程存储获取到 ${stored.length} 个Cookie (profileId=${profileId})`);
                    }
                } catch (e) {
                    log('WARN', `⚠️ ensureBrowserIsRunning 获取远程Cookie失败: ${e.message}`);
                }
                // 🐛 修复：远程也没有时，再读一次本地库里的 account_cookies 兜底；
                //    四个来源全空就明确告警，避免"一个 Cookie 都没注入"却毫无提示
                if (!launchPayload.cookies && Array.isArray(launchProfile?.accountCookies) && launchProfile.accountCookies.length > 0) {
                    launchPayload.cookies = launchProfile.accountCookies;
                    log('INFO', `📌 从本地库获取到 ${launchProfile.accountCookies.length} 个Cookie (profileId=${profileId})`);
                }
                if (!launchPayload.cookies) {
                    log('WARN', `⚠️ 本次未注入任何 Cookie（profileId=${profileId}）：调用方/缓存/远程/本地库四个来源均为空，启动后大概率是未登录状态`);
                }
            }
        }
        if (proxyOverride) launchPayload.proxy = proxyOverride;
        
        try {
            const launchResp = await fetch(launchUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-Api-Secret': API_SECRET
                },
                body: JSON.stringify(launchPayload),
                // 🔕 60 秒上限：闸门排队等空位最长 30s（LAUNCH_WAIT_MS）+ 启动本身 10~15s，
                //    以前的 10s 比排队上限还短 —— 满员时启动请求在闸门里排着队就被掐断，
                //    只能靠 45s 轮询兜底（而闸门一看到断开就放弃 → 浏览器根本没启动，白等）。
                //    🕒 带 awaitLogin 时启动端还会额外等登录流程（最多 100s），超时要相应放大，
                //       否则我们这一侧会先 abort，就白白丢掉了「等登录」的意义。
                signal: AbortSignal.timeout(_awaitLogin ? 150000 : 60000)
            });

            const launchResult = await launchResp.json();
            if (!launchResult.success) {
                throw new Error(`自动启动浏览器失败: ${launchResult.message}`);
            }
            // 🔐 带回登录结论（仅 awaitLogin 时启动端才会给），供调用方决定要不要继续后续动作
            if (_awaitLogin && typeof launchResult.loginOk === 'boolean') loginOk = launchResult.loginOk;
        } catch (e) {
            // ⚠️ 只有「60 秒没拿到结果」才放行：正常启动（含闸门排队）本身可能要 45s+，
            //    直接判失败会误杀成功启动；交给下面的就绪轮询确认真实结果。
            if (!/abort/i.test(String(e && e.message))) throw e;
            log('WARN', `⚠️ 启动请求 60 秒未返回 (profileId=${profileId})，转为轮询就绪状态`);
        }
        
        // 🚀 优化：等待浏览器完全就绪，增加到 45 秒，并检查 browser 实例是否存在
        let retries = 0;
        const maxRetries = 45;
        while (retries < maxRetries) {
            await new Promise(r => setTimeout(r, 1000));
            browserData = activeBrowsers.get(String(profileId));
            if (browserData && browserData.browser && browserData.browser.isConnected()) {
                log('INFO', `✅ 浏览器已成功自动启动并就绪 (profileId=${profileId})`);
                return { success: true, browserData, loginOk };
            }
            retries++;
            if (retries % 5 === 0) log('DEBUG', `[ensureBrowserIsRunning] Still waiting for browser ${profileId}... (${retries}/${maxRetries})`);
        }
        
        throw new Error(`浏览器启动超时 (${maxRetries}s) 或未能正确注册到活跃列表`);
    } catch (err) {
        log('ERROR', `❌ 自动启动浏览器发生异常: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// ============================================================
// 🪶 借用型浏览器（批量取数临时用的浏览器）兜底回收
//   批量取数只是「临时借用」浏览器：正常完成由调用方主动归还（/api/stop-browser）；
//   万一调用链断掉/卡死没人归还，就在「没有任何请求使用它满 N 秒」后强制关闭，
//   避免名额被永久占用（MAX_ALIVE_BROWSERS 用满后，后续所有启动都会被 409 拒绝）。
//   ⚠️ 默认值从 15s 提到 60s：实测单次启动要 27~72s，而「启动成功后 → 前端发出取数请求」
//      之间可能隔十几秒。15s 太短，会把刚启动好、还没开始取数的浏览器先关掉，
//      导致后续取数请求全变成 400 "Browser not running"（实测 18:14:37 一次 4 个）。
// ============================================================
const BORROWED_IDLE_MS = Math.max(1000, parseInt(process.env.BORROWED_IDLE_MS || '60000', 10) || 60000);
// 🔥 绝对硬上限（可选）：从「浏览器就绪」起算，到点**无条件**关闭（不看 inFlight、不续期）。
//    idle 定时器（60s）解决的是「没人在用却没人归还」；但只要有请求在跑，idle 就会一直顺延，
//    一个卡死的批量任务可以把名额无限占住 → 后续任务全在「等空位」。
//    🆕 默认「不限制」：0 / 未设置 / 负数 / 非数字 一律视为不设硬上限（借用型浏览器不再被 90s 强杀）。
//       要恢复硬性生命期兜底时：设置 BORROWED_MAX_MS=90000（或其它正毫秒数）再重启服务即可。
//    ⚠️ 只作用于借用型（borrow:true，即批量操作临时借的浏览器），不影响用户手动常驻窗口。
const BORROWED_MAX_MS = (() => {
    const raw = String(process.env.BORROWED_MAX_MS ?? '').trim();
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
})();
// 🧯 inFlight 计数泄漏的兜底界限。
//    正常流程里 inFlight 由 touchBorrowedBrowser 返回的 done() 在响应结束时减回去；
//    但客户端掉线、连接被掐导致响应没能正常结束时，done() 可能永远不被调用，
//    于是 inFlight 一直 >0、回收定时器每次顺延 → 这个名额被**永久**占住（日志上「借用中 N/5」降不下来）。
//    这里给「持有」和「无新请求续期」两个维度各设一个上限，超了就认定是泄漏、强制回收。
//    取 5 分钟是因为 inFlight>0 只可能来自启动请求（整条受 LaunchQueue 120s 超时约束），
//    正常启动远不到 5 分钟，所以不会误杀真正在跑的任务。
const BORROWED_HOLD_FUSE_MS = Math.max(60000, parseInt(process.env.BORROWED_HOLD_FUSE_MS || '300000', 10) || 300000);
const _borrowedBrowsers = new Map(); // profileId -> { browser, inFlight, idleTimer, armedAt, lastTouchAt }

async function _closeBorrowedBrowser(profileId, reason) {
    const key = String(profileId);
    const entry = _borrowedBrowsers.get(key);
    if (!entry) return;
    _borrowedBrowsers.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);
    const b = entry.browser;
    logBrowserClose(key, reason, '_closeBorrowedBrowser(借用型回收)', `inFlight=${entry.inFlight}`);
    log('WARN', `🧹 [Borrow] ${reason}，强制关闭借用型浏览器 profileId=${key}`);
    try {
        if (b && b.isConnected && b.isConnected()) {
            // 最多等 5 秒优雅关闭；卡死的 Chrome 不响应 CDP，之后直接杀进程
            await Promise.race([b.close(), new Promise(r => setTimeout(r, 5000))]);
        }
    } catch {}
    try { if (b && b.isConnected && b.isConnected()) b.process?.()?.kill?.(); } catch {}
    try { if (activeBrowsers.get(key)?.browser === b) activeBrowsers.delete(key); } catch {}
}

function _armBorrowTimer(key) {
    const entry = _borrowedBrowsers.get(key);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.armedAt = Date.now();
    entry.idleTimer = setTimeout(() => {
        const cur = _borrowedBrowsers.get(key);
        if (!cur) return;
        if (cur.inFlight > 0) {
            // 仍有请求在用 → 顺延。但**顺延必须有上限**：
            // 以前这里是无条件顺延，一旦 done() 因掉线没被调用，就会无限顺延、名额永久占住。
            const lastTouch = cur.lastTouchAt || cur.armedAt || 0;
            const staleFor = Date.now() - lastTouch;
            if (staleFor < BORROWED_HOLD_FUSE_MS) { _armBorrowTimer(key); return; }
            log('WARN', `🧯 [Borrow] profileId=${key} inFlight=${cur.inFlight} 但已 ${Math.round(staleFor / 1000)}s 无新请求续期，判定计数泄漏，强制回收`);
        }
        void _closeBorrowedBrowser(key, `借用型浏览器空闲超过 ${BORROWED_IDLE_MS}ms`);
    }, BORROWED_IDLE_MS);
}

// 标记为借用型浏览器
//   maxMs：可选的「本次借用的绝对上限」覆盖值（毫秒）。>0 时优先生效（绑卡/BM认证这类重活会传更大的值）；
//          <=0 / 未传时跟随 BORROWED_MAX_MS（默认 0 = 不设硬上限）。传正数时下限 10s。
function markBorrowedBrowser(profileId, browser, maxMs) {
    const key = String(profileId);
    const prev = _borrowedBrowsers.get(key);
    if (prev && prev.idleTimer) clearTimeout(prev.idleTimer);
    if (prev && prev.maxTimer) clearTimeout(prev.maxTimer);
    // maxMs（调用方覆盖）> 0 → 用它；否则用 env 默认；两者都 <= 0 → 不限制
    const override = Number(maxMs);
    const max = (Number.isFinite(override) && override > 0)
        ? Math.max(10000, override)
        : (BORROWED_MAX_MS > 0 ? Math.max(10000, BORROWED_MAX_MS) : 0);
    // 🔥 绝对硬上限定时器：与 idle 定时器不同，它**永远不会被续期**（touch/arm 都不碰它）。
    //    到点直接强制关闭，不管有没有请求在跑 —— 这是「执行批量操作的浏览器必须有硬性生命期」的落地。
    //    发生在就绪时（本函数在 puppeteer.launch 返回、浏览器已可用后调用），符合「就绪起算」。
    //    🆕 max = 0 表示「不限制」→ 不装定时器（借用型浏览器只受空闲回收约束）。
    let maxAt = null;
    let maxTimer = null;
    if (max > 0) {
        maxAt = Date.now() + max;
        maxTimer = setTimeout(() => {
            void _closeBorrowedBrowser(key, `借用型浏览器已达绝对硬上限 ${Math.round(max / 1000)}s（无论是否仍在执行）`);
        }, max);
        if (maxTimer && maxTimer.unref) maxTimer.unref();
    }
    // ⚠️ 重复标记时必须**保留** prev.inFlight：以前这里直接写 inFlight:0，
    //    等于把「当前还有请求正在用」这件事抹掉 → 回收定时器会在请求还没跑完时就把浏览器关掉，
    //    表现就是日志里那批「配置 X 的浏览器已关闭，中止当前任务项」。
    _borrowedBrowsers.set(key, {
        browser,
        inFlight: prev ? (prev.inFlight || 0) : 0,
        idleTimer: null,
        maxTimer,
        maxAt,
        armedAt: Date.now(),
        lastTouchAt: prev && prev.lastTouchAt ? prev.lastTouchAt : Date.now()
    });
    _armBorrowTimer(key);
    log('INFO', `🪶 [Borrow] profileId=${key} 已标记为借用型浏览器（空闲 ${Math.round(BORROWED_IDLE_MS / 1000)}s 回收；${max > 0 ? `就绪起满 ${Math.round(max / 1000)}s 强制回收` : '不设硬上限'}）`);
}

// 由 HTTP 中间件调用：本请求引用了该 profile 就续期；返回的函数在请求结束时调用
function touchBorrowedBrowser(profileId) {
    const key = String(profileId);
    const entry = _borrowedBrowsers.get(key);
    if (!entry) return null;
    entry.inFlight++;
    // 有请求在用 → 刷新续期时间，回收定时器据此区分「还在干活」和「计数泄漏了」
    entry.lastTouchAt = Date.now();
    _armBorrowTimer(key);
    let done = false;
    const release = () => {
        if (done) return;
        done = true;
        const cur = _borrowedBrowsers.get(key);
        if (!cur) return;
        cur.inFlight = Math.max(0, cur.inFlight - 1);
        _armBorrowTimer(key);
    };
    // 🧯 保险丝：就算 finish/close/aborted 全都没触发（掉线时就是这么漏的），
    //    也不能让这一份 inFlight 永远挂着，到点自己减回去。
    const fuse = setTimeout(() => {
        log('WARN', `🧯 [Borrow] profileId=${key} 持有超过 ${Math.round(BORROWED_HOLD_FUSE_MS / 1000)}s 仍未收到响应结束事件，保险丝触发，释放这份占用`);
        release();
    }, BORROWED_HOLD_FUSE_MS);
    if (fuse && fuse.unref) fuse.unref();
    return () => { clearTimeout(fuse); release(); };
}

// 调用方主动归还
function releaseBorrowedBrowser(profileId) {
    const key = String(profileId);
    const entry = _borrowedBrowsers.get(key);
    if (!entry) return;
    _borrowedBrowsers.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);
}

// 这个浏览器是不是「我方借来的」（区别于用户自己手动开着的窗口）
function isBorrowedBrowser(profileId) {
    return _borrowedBrowsers.has(String(profileId));
}

// 借用型浏览器总数：队列闸门按它限流。
// ⚠️ 以前闸门用的是 activeBrowsers.size（所有开着的 Chrome，含用户手动开的、别的任务常驻的）——
//    只要有一个常驻窗口，队列就少一个名额，批量任务永远跑不满并发，尾巴上那几项要白等一整轮。
function borrowedBrowserCount() {
    let n = 0;
    for (const e of _borrowedBrowsers.values()) {
        try { if (e && e.browser && e.browser.isConnected && e.browser.isConnected()) n++; } catch { }
    }
    return n;
}

function borrowedBrowserStats() {
    const now = Date.now();
    const profiles = Array.from(_borrowedBrowsers.entries()).map(([key, e]) => {
        const sinceTouch = e.lastTouchAt ? now - e.lastTouchAt : null;
        return {
            profileId: key,
            inFlight: e.inFlight,                                  // >0 说明还有请求在用（会顺延回收）
            hasTimer: !!e.idleTimer,
            idleForMs: e.armedAt ? now - e.armedAt : null,          // 距上次续期多久
            sinceTouchMs: sinceTouch,                               // 距最后一次「有请求碰过它」多久
            maxInMs: e.maxAt ? Math.max(0, e.maxAt - now) : null,    // 距绝对硬上限（强制回收）还剩多久
            // 🧯 嫌疑泄漏：还挂着 inFlight，但已经很久没有新请求续期 —— 正常情况下早该被保险丝回收，
            //    还留在这里就说明某条释放路径没走通。看到这个 true 就直接查该 profile。
            suspectedLeak: !!(e.inFlight > 0 && sinceTouch !== null && sinceTouch >= BORROWED_HOLD_FUSE_MS),
            connected: !!(e.browser && e.browser.isConnected && e.browser.isConnected())
        };
    });
    return { idleMs: BORROWED_IDLE_MS, fuseMs: BORROWED_HOLD_FUSE_MS, maxMs: BORROWED_MAX_MS, count: profiles.length, profiles };
}

// ============================================================
// Chrome 代理参数（统一构造，供 createBrowser 与「获取 Token」临时浏览器共用）
// ============================================================
/**
 * 构造 Chrome 的 --proxy-server 等代理参数。
 * 🐛 背景：SOCKS5/HTTP 带账密时代理不能直接写进 URL（新版 Chrome 不支持），
 *    必须起本地认证转发器；不可直达的代理还要先建本地隧道。
 *    以前「获取 Token」的临时浏览器自己拼了一行 `--proxy-server=socks5://host:port`，
 *    漏掉账密与转发器 → 带认证的代理直接连不上、页面导航 20s 超时、抓到 0 个 token。
 */
async function buildProxyChromeArgs(proxy, profileId) {
    const args = [];
    if (!proxy || !proxy.host || !proxy.port) return args;

    const type = (proxy.type || '').toLowerCase();
    const isSocks = (type === 'socks5' || type === 'socks5h');
    const hasAuth = !!(proxy.username && proxy.password);
    const bypass = '--proxy-bypass-list=<-loopback>;127.0.0.1;localhost';
    const proto = isSocks ? 'socks5' : (type === 'https' ? 'https' : 'http');

    // ① 远端不可直达 → 先建本地 TCP 中继隧道，之后一律针对「隧道地址」操作。
    //    ⚠️ 隧道只做 TCP 转发、不解代理认证，所以带账密时后面还得再套一层认证转发器。
    let target = proxy;
    const directReachable = await _testDirectReachable(proxy.host, proxy.port, proxy.type).catch(() => false);
    if (!directReachable) {
        const tunnel = await _createSocksTunnel(proxy.host, proxy.port, S5_TUNNEL_HOST, S5_TUNNEL_PORT).catch(() => null);
        if (tunnel) {
            target = { ...proxy, host: tunnel.localHost, port: String(tunnel.localPort) };
            log('INFO', `🔐 代理经本地隧道: ${target.host}:${target.port} → ${proxy.host}:${proxy.port}`);
            _registerProxyResource(profileId, 'tunnel', tunnel);
        }
    }

    // ② 带账密 → 在目标地址前再套一层本地认证转发器（SOCKS5/HTTP 认证由 Node 侧完成）
    //    🐛 只建隧道不做认证时，Chrome 会以「无认证」去连远端代理 → ERR_SOCKS_CONNECTION_FAILED
    if (hasAuth) {
        const forwarder = isSocks
            ? await _createLocalSocks5AuthForwarder(target, profileId).catch(() => null)
            : await _createLocalHttpAuthForwarder(target, profileId).catch(() => null);
        if (forwarder) {
            args.push(`--proxy-server=${proto}://${forwarder.host}:${forwarder.port}`);
            args.push(bypass);
            log('INFO', `🔐 代理配置 (本地认证转发器) ${proto}://${forwarder.host}:${forwarder.port} → ${target.host}:${target.port} (user=${proxy.username})`);
            return args;
        }
        // 转发器创建失败，降级为嵌入 URL（部分旧版 Chrome 仍支持）
        args.push(`--proxy-server=${proto}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${target.host}:${target.port}`);
        args.push(bypass);
        log('WARN', `🔐 直连代理 (嵌入URL降级): ${proto}://***@${target.host}:${target.port}`);
        return args;
    }

    // ③ 无认证代理：直接用（隧道后的）目标地址
    args.push(`--proxy-server=${proto}://${target.host}:${target.port}`);
    args.push(bypass);
    log('INFO', `🔐 代理配置 (直连): ${proto}://${target.host}:${target.port}`);
    return args;
}

// ============================================================
// 模块导出
// ============================================================
module.exports = {
    __inject,
    activeBrowsers,
    pendingBrowserCount,
    profileCookiesCache,
    profileGraphqlFailCache,
    browserManager,
    launchQueueManager,
    BrowserManager,
    LaunchQueue,
    getAvailableDebugPort,
    applyStealthToPage,
    getFingerprint,
    buildProxyChromeArgs,
    extractEmailPrefix,
    extractFbToken,
    safePageEvaluate,
    safePageEvaluateVoid,
    isProfileRunning,
    ensureBrowserIsRunning,
    executeWithBrowserRetry,
    _rawCdpExtractToken,
    releaseDebugPort,
    markBorrowedBrowser,
    touchBorrowedBrowser,
    releaseBorrowedBrowser,
    isBorrowedBrowser,
    borrowedBrowserCount,
    borrowedBrowserStats,
    killAllResidualBrowsers,
    cleanAllStaleLocks,
    logBrowserClose,
    markBrowserCloseReason,
    peekBrowserCloseReason,
};