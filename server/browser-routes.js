'use strict';

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const { exec, spawn } = require("child_process");
const crypto = require("crypto");

const proxyTunnel = require('./proxy-tunnel');
const { parseProxy, sshTunnelManager, socksChainServer, _proxyTunnels, _closeProfileResources } = proxyTunnel;
const browserManagerModule = require('./browser-manager');
const { activeBrowsers, profileCookiesCache, profileGraphqlFailCache, browserManager, launchQueueManager, BrowserManager, LaunchQueue, getAvailableDebugPort, extractEmailPrefix, extractFbToken, safePageEvaluate, safePageEvaluateVoid, isProfileRunning, ensureBrowserIsRunning, executeWithBrowserRetry, _rawCdpExtractToken, markBorrowedBrowser, touchBorrowedBrowser, releaseBorrowedBrowser, isBorrowedBrowser, borrowedBrowserCount, releaseDebugPort, logBrowserClose, peekBrowserCloseReason } = browserManagerModule;
const cookieManager = require('./cookie-manager');
const { normalizeCookie, normalizeFbDomain, preinjectCookies, preinjectCookiesToDatabase, parseCookieString, syncCookiesToStorage, attachCookieSync, getCookiesFromStorage, markLoginState, resetLoginState, getLoginState, reportLoginStatusToCloud, readLoginCookiesFromProfileDir } = cookieManager;
const { callFacebookGraphApi } = require('./facebook-graph');
const databaseModule = require('./database');
const { DatabasePool, initDatabase, ensureAdAccountsTable, ensurePagesTable, ensureBusinessesTable, ensureAdsTable, ensurePaymentTokensTable, ensurePixelsTable, loadProfilesFromFile, findProfileById, autoFillPasswordOnPage, probeConnectivity, db, mainDbPool, dbPath, credentialsDb } = databaseModule;
const healthModule = require('./health-diagnostics');
const { buildDiagnosticsHtml } = healthModule;

let _log = () => {};
let _app = null;
let _launchCount = 0;
let _successCount = 0;
let _errorCount = 0;
let _totalLaunchTime = 0;
let _pendingBrowserCount = 0;
// 🛡️ 防重入：正在启动中的 profileId 集合（从开始启动到启动流程结束期间，同一配置的重复请求直接忽略）
const _launchInFlightProfiles = new Set();

const _APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
const _BROWSER_PROFILES_ROOT = process.env.BROWSER_PROFILES_ROOT || path.join(_APP_ROOT, 'browser-profiles');
const _API_SECRET = process.env.PUPPETEER_API_SECRET || '';
const _PORT = parseInt(process.env.PUPPETEER_PORT || process.env.PORT || '9999', 10);
const _SCREENSHOT_DIR = path.join(_APP_ROOT, 'logs', 'screenshots');
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 🔐 回写「登录状态」到云端（前端配置列表那一列读的就是这个字段）。
//    实现已统一挪到 cookie-manager.js —— facebook-graph.js（Graph API 取数成功时）也要用，
//    放公共模块避免两边各写一份。这里直接用上面解构出来的同名函数。

// 🔁 注册「登录状态复检器」：Cookie 同步闸门发现「快照带 c_user+xs 但旧判定为未登录」时会被调用
//    （典型场景：启动时页面停在 checkpoint 判了 false，用户随后人工过完验证登录成功，
//    却一直没有 Graph 调用/二次验证来翻转状态 → 新会话永远无法上云，6007 实测）。
//    在活跃浏览器实例上做 DOM 级探测：已离开 checkpoint/login → 视为已登录，
//    开闸并立即补同步一次 Cookie 到云端；仍在 checkpoint → 返回 false 维持拒绝，等下轮 cookie 变化再试。
cookieManager.setLoginRevalidator(async (profileId, reason) => {
    const bd = activeBrowsers.get(String(profileId));
    if (!bd || !bd.browser) {
        _log('WARN', `🔁 [登录复检] 无活跃浏览器实例，跳过 (profileId=${profileId}, reason=${reason || ''})`);
        return false;
    }
    try {
        const pages = await bd.browser.pages();
        let probePage = null;
        for (const p of pages) {
            const u = String(p.url() || '');
            if (/(\.|^)?facebook\.com/i.test(u)) {
                if (!probePage || /\/checkpoint\b/i.test(probePage.url() || '')) probePage = p; // 优先非 checkpoint 页
                if (!/\/checkpoint\b/i.test(u)) { probePage = p; break; }
            }
        }
        if (!probePage) {
            _log('WARN', `🔁 [登录复检] 实例内无 facebook.com 页面，跳过 (profileId=${profileId})`);
            return false;
        }
        const probe = await probePage.evaluate(() => {
            const url = location.href;
            const bodyText = document.body ? document.body.innerText : '';
            return {
                isCheckpoint: /\/checkpoint\b/i.test(url),
                isLoginPage: /\/login\b/i.test(url) || bodyText.includes('Log in to Facebook') || bodyText.includes('登录 Facebook'),
                onFacebook: /\.facebook\.com/i.test(url),
            };
        });
        if (!probe.onFacebook || probe.isCheckpoint || probe.isLoginPage) {
            _log('WARN', `🔁 [登录复检] 页面仍在 checkpoint/login，维持拒绝 (profileId=${profileId}, checkpoint=${probe.isCheckpoint}, login=${probe.isLoginPage})`);
            return false;
        }
        // ✅ 已离开 checkpoint/login → 会话实际已建立：开闸 + 立即补同步（不等下一次 cookie 变化）
        markLoginState(profileId, true);
        _log('INFO', `✅ [登录复检] 页面已离开验证/登录页，判定已登录，开闸并补同步 (profileId=${profileId})`);
        try {
            const _fbCookies = (await probePage.cookies()).filter(c => /(\.|^)facebook\.com$/i.test(String(c.domain || '')));
            if (_fbCookies.length) {
                await syncCookiesToStorage(profileId, _fbCookies, null);
                _log('INFO', `🔄 [登录复检] 已补同步 Cookie 到云端 (count=${_fbCookies.length}, profileId=${profileId})`);
            }
        } catch (_e) {
            _log('WARN', `🔄 [登录复检] 补同步失败（闸门已开，后续变化仍会同步）: ${String((_e && _e.message) || _e)}`);
        }
        return true;
    } catch (e) {
        _log('WARN', `🔁 [登录复检] 探测异常: ${String((e && e.message) || e)} (profileId=${profileId})`);
        return false;
    }
});

// 🔐 用「能不能真的从 FB 取到数据」来判登录态（参考广告工具箱的 token + Graph API 链路）。
//    流程：① 取页面 script 里的 EAA access token（extractFbToken：CDP 网络拦截 + HTML 正则）
//          ② 用这个 token 调 Graph API
//          ③ 失败 → 换配置里的 token（findProfileById：本地库 → 云端缓存 → 云端）
//          ④ 还失败 → 触发「获取TOKEN」流程（POST /api/facebook/tokens，内部复用运行中
//             浏览器开新页抓 token 并页面内校验）→ 拿校验通过的新 token 重试一次
//          ⑤ 任一步拿到数据 → 会话有效 → markLoginState(true)，打开 Cookie 回写云端的闸门
//    ⚠️ EAA token 只存在于 Ads Manager / Business Suite 这类页面的 script 里，
//       www.facebook.com 首页取不到 —— 所以调用方必须先导航到 adsmanager 再进来。
//    返回 { ok, data?, token?, error? }；error 区分 no_token（所有来源都没有 token）与 graph_error（FB 报错）。
// 🔄 内部调用本地「获取TOKEN」接口刷新 token：POST /api/facebook/tokens（facebook-profile-routes.js）
//    只认 validated_tokens（页面内 XHR 校验通过的），没校验通过的不拿来重试。
async function refreshProfileTokenViaApi(profileId) {
    try {
        const port = parseInt(process.env.PUPPETEER_PORT || process.env.PORT || '9999', 10);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 100000);
        const resp = await fetch(`http://127.0.0.1:${port}/api/facebook/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileId: String(profileId) }),
            signal: controller.signal
        });
        clearTimeout(timer);
        const data = await resp.json().catch(() => null);
        const tokens = data && data.tokens;
        const validated = (tokens && Array.isArray(tokens.validated_tokens)) ? tokens.validated_tokens : [];
        const pick = validated[0] || (tokens && tokens.validated && tokens.primary) || null;
        if (pick) {
            _log('INFO', `[TokenRefresh] 获取TOKEN成功，拿到校验通过的新 token (profileId=${profileId})`);
            return String(pick);
        }
        _log('WARN', `[TokenRefresh] 获取TOKEN未返回校验通过的 token (profileId=${profileId}, status=${resp.status})`);
        return null;
    } catch (e) {
        _log('WARN', `[TokenRefresh] 获取TOKEN流程异常: ${String(e && e.message || e)} (profileId=${profileId})`);
        return null;
    }
}

async function graphApiProbe(profileId, page, endpoint, label) {
    const _t0 = Date.now();
    const pid = String(profileId);
    // 🪜 候选 token 链（去重、去空）：页面现取的最优先，配置里的（含云端）兜底
    const candidates = [];
    const pushTok = (t) => { const s = String(t || '').trim(); if (s && !candidates.includes(s)) candidates.push(s); };
    try { pushTok(await extractFbToken(page, 8000)); } catch (e) { _log('WARN', `[${label}] 取 Token 异常: ${String(e && e.message || e)}`); }
    let prof = null;
    try { prof = await findProfileById(pid); } catch {}
    if (prof) { pushTok(prof.token); pushTok(prof.account_tokens); }
    if (candidates.length === 0) {
        _log('WARN', `[${label}] 页面与配置里都没有 access token，无法调用 Graph API (profileId=${pid})`);
        return { ok: false, error: 'no_token' };
    }
    const payloadProfile = { ...(prof || {}), id: pid };
    const tryCall = async (tok) => {
        try {
            return await callFacebookGraphApi(endpoint, 'GET', null, { ...payloadProfile, token: tok });
        } catch (e) {
            return { error: { message: String(e && e.message || e), type: 'ProbeException' } };
        }
    };

    // 🪜 逐个候选 token 尝试
    let json = null;
    let lastErr = 'unknown';
    let usedToken = '';
    for (let i = 0; i < candidates.length; i++) {
        const tok = candidates[i];
        usedToken = tok;
        json = await tryCall(tok);
        if (json && !json.error) {
            try { markLoginState(pid, true); } catch {}
            _log('INFO', `[${label}] ✅ Graph API 取数成功 (profileId=${pid}, token来源=${i === 0 ? '页面' : '配置'}, ${Date.now() - _t0}ms)`);
            return { ok: true, data: json, token: tok };
        }
        lastErr = (json && json.error && json.error.message) || String(json && json.error || 'unknown');
        _log('WARN', `[${label}] token#${i}(${tok.slice(0, 15)}...) 取数失败: ${lastErr} (profileId=${pid})`);
    }

    // 🪜 全部失败 → 触发「获取TOKEN」流程刷新 → 用校验通过的新 token 重试一次
    _log('INFO', `[${label}] 所有候选 token 均失败，触发获取TOKEN流程 (profileId=${pid})`);
    const refreshed = await refreshProfileTokenViaApi(pid);
    if (refreshed) {
        usedToken = refreshed;
        json = await tryCall(refreshed);
        if (json && !json.error) {
            try { markLoginState(pid, true); } catch {}
            _log('INFO', `[${label}] ✅ 刷新 token 后取数成功 (profileId=${pid}, ${Date.now() - _t0}ms)`);
            return { ok: true, data: json, token: refreshed };
        }
        lastErr = (json && json.error && json.error.message) || String(json && json.error || 'unknown');
        _log('WARN', `[${label}] 刷新 token 后仍失败: ${lastErr} (profileId=${pid})`);
    }

    _log('WARN', `[${label}] Graph API 最终失败: ${lastErr} (profileId=${pid})`);
    return { ok: false, error: lastErr, json: (json && json.error) ? json : undefined, token: usedToken };
}

function __inject(deps) {
    if (deps.log) _log = deps.log;
    if (deps.app) _app = deps.app;
    if (deps.launchCount !== undefined) _launchCount = deps.launchCount;
    if (deps.successCount !== undefined) _successCount = deps.successCount;
    if (deps.errorCount !== undefined) _errorCount = deps.errorCount;
    if (deps.totalLaunchTime !== undefined) _totalLaunchTime = deps.totalLaunchTime;
}

function registerRoutes() {
    if (!_app) return;

    const log = _log;

// 🚀 启动浏览器端点 (优化版)
    _app.post('/api/launch-browser', async (req, res) => {
        const startTime = Date.now();
        _launchCount++;
        
        // 捕获授权令牌，用于后续同步
        const authToken = req.headers['authorization'] || req.headers['Authorization'];
        
        const { profileId, profile, proxy, startUrls, cookies, userAgent, executablePath, chrome115Config, skipStartUrls, strictStartUrls = true, strictVerifyOnly, skipConcurrencyCheck, borrow, borrowMaxMs, awaitLogin } = req.body;
        // 🐛 修复：默认走并发限制，前端从 settings:browserSettings 的 maxConcurrentLaunches 控制
        const skipCC = skipConcurrencyCheck === true;
    try { console.log(`📨 请求参数: profileId=${String(profileId||'')}, strictStartUrls=${!!strictStartUrls}, strictVerifyOnly=${!!strictVerifyOnly}, startUrls=${Array.isArray(startUrls)?startUrls.join(', '):String(startUrls||'')}`); } catch {}
    
    // 🧹 供队列超时清理引用：只关掉本次任务启动的那个浏览器实例，避免误杀其它
    // 🔒 本次任务分配的调试端口预留：成功/失败/超时都要释放，否则端口会被永久占用
    // 🐛 修复：这两个变量原先声明在下面的 try 块里（块级作用域），catch 中引用会抛
    //    「ReferenceError: _allocatedDebugPort is not defined」—— 结果是真正的启动失败原因被吞掉、
    //    端口预留也不会被释放。提到 try 之外（函数作用域）后 catch 才能正常访问。
    let _launchTaskBrowser = null;
    let _allocatedDebugPort = null;
    // 🔗 登录校验/自动登录流程的 promise：默认 fire-and-forget；awaitLogin=true 时在任务末尾等它跑完。
    //    必须声明在 try 之外（页面搭建那段在 try 内），否则任务末尾的 return 处拿不到它。
    let loginFlowPromise = null;

    try {
        console.log(`🚀 启动浏览器配置 ${profileId}...`);

        // 🔍 从文件中读取完整的配置信息
        const actualProfile = await findProfileById(profileId);
        const finalProfile = actualProfile || profile || {};
        
        // 🏷️ 提取窗口标题配置，如果未提供则使用 Profile ID 作为默认值，方便任务栏识别
        const windowTitle = chrome115Config?.windowTitle || String(profileId) || finalProfile?.name || `Profile ${profileId}`;
        console.log(`🏷️ 窗口标题已设定: ${windowTitle || '未设置'}`);

        const finalProxy = proxy || finalProfile.proxy;
        let finalStartUrls = (Array.isArray(startUrls) && startUrls.length ? startUrls : [finalProfile.startUrl].filter(Boolean));
        try {
            const cleaned = (finalStartUrls || []).map(u => String(u || '').trim()).filter(Boolean);
            const target = cleaned.slice(0, 1);
            // 🌐 自动补全URL协议，避免 facebook.com 变成无效URL
            finalStartUrls = target.map(u => {
                if (!/^https?:\/\//i.test(u)) return 'https://' + u;
                return u;
            });
        } catch {}
        const finalUserAgent = userAgent || finalProfile.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        console.log(`📋 使用配置信息:`);
        console.log(`📧 账号邮箱: ${finalProfile.accountEmail || finalProfile.account_email || '未设置'}`);
        console.log(`🔑 密码状态: ${finalProfile.accountPassword || finalProfile.account_password ? '已设置' : '未设置'}`);
        console.log(`🔧 启动URL模式: strict=${!!strictStartUrls} skip=${!!skipStartUrls}`);
        console.log(`🌐 启动网站: ${finalStartUrls.join(', ') || '未设置'}`);

        // ♻️ 复用已运行的浏览器实例，避免重复启动
        try {
            const existing = activeBrowsers.get(profileId);
            let canReuse = false;
            if (existing && existing.browser) {
                try {
                    const conn = existing.browser.isConnected();
                    const proc = existing.browser.process();
                    const procAlive = proc && (proc.exitCode === null || proc.exitCode === undefined);
                    // 🚀 检查浏览器是否有真实的可见页面（过滤 devtools/about:blank），防止复用无窗口僵尸进程
                    const pages = await existing.browser.pages().catch(() => []);
                    const hasRealPage = pages.some(p => {
                        try { const u = p.url(); return u && !u.startsWith('about:') && !u.startsWith('devtools:') && !u.startsWith('chrome://'); } catch { return false; }
                    });
                    // 🔁 只要实例仍连接、进程仍存活就复用：Chrome 窗口是可见的，用户可能正在用它，
                    //    强行关掉再重启会打断操作。hasRealPage 仅作诊断信息，不再作为复用门槛
                    //    （只剩 about:blank 的窗口同样是可见的，复用分支会再打开启动网站）
                    canReuse = conn && procAlive;
                    // 🐛 修复：请求带了 UA、但已运行实例的 UA 为空或与本次不一致时不能直接复用 ——
                    //    否则「第一次用空 UA/通用 UA 起的窗口」会一直沿用错误指纹，后面再发正确 UA 也不会生效。
                    //    这种情况关掉重建，让配置正式生效。
                    if (canReuse) {
                        const instUA = String(existing.userAgent || '');
                        const reqUA = String(finalUserAgent || '');
                        // 🔌 已运行实例的代理与本次不一致（用户改了代理或关了代理）也必须重建：
                        //    否则旧窗口一直挂着旧代理，新配置永远不生效（实测 profileId=3960）
                        const instProxyKey = (existing.proxy && existing.proxy.host) ? `${existing.proxy.host}:${existing.proxy.port}` : '';
                        const reqProxyKey = (finalProxy && finalProxy.host) ? `${finalProxy.host}:${finalProxy.port}` : '';
                        if ((reqUA && instUA !== reqUA) || instProxyKey !== reqProxyKey) {
                            log('WARN', `♻️ 已运行实例配置与本次请求不一致，关闭后按新配置重启 (profileId=${profileId}${instProxyKey !== reqProxyKey ? `, 代理: 现=${instProxyKey || '无'} 新=${reqProxyKey || '无'}` : `, UA: 现=${instUA ? instUA.slice(0, 60) + '...' : '空'} 新=${reqUA.slice(0, 60)}...`})`);
                            logBrowserClose(profileId, '已运行实例配置与本次请求不一致（UA/代理），按新配置重建', 'launch-browser/配置不匹配');
                            try { await existing.browser.close().catch(() => {}); } catch {}
                            try { existing.process?.kill?.(); } catch {}
                            activeBrowsers.delete(profileId);
                            canReuse = false;
                        }
                    }
                    if (!canReuse) {
                        log('WARN', `♻️ 浏览器不可复用: connected=${conn}, procAlive=${procAlive}, hasRealPage=${hasRealPage} (profileId=${profileId})`);
                    } else if (!hasRealPage) {
                        log('INFO', `♻️ 复用已运行实例（无现成页面，将打开启动网站）: profileId=${profileId}`);
                    }
                } catch (checkErr) {
                    log('WARN', `♻️ 浏览器复用检查异常: ${checkErr.message} (profileId=${profileId})`);
                }
            }
            
            if (canReuse) {
                const urls = Array.from(new Set((finalStartUrls || []).map(u => String(u || '').trim()).filter(Boolean))).slice(0, 1);
                console.log(`♻️ 检测到已运行实例，复用并打开启动网站: ${urls.join(', ')}`);
                for (const url of urls) {
                    try {
                        // ♻️ 优先复用现成标签页，不再无条件 newPage()：以前复用时每次都会新开一个标签页
                        //    且从不回收 → 反复点「启动浏览器」、或「启动 + 获取信息」同时打到同一个配置时，
                        //    标签页会越堆越多（窗口里冒出两个空白页就是这么来的）。
                        //    策略：已有 facebook 标签 → 直接带到前台（连导航都省）；否则用现成的空白页；
                        //    实在没有才新开。
                        let page = null;
                        let reusedExisting = false;
                        try {
                            const pages = await existing.browser.pages();
                            page = pages.find(p => { try { return /facebook\.com/i.test(p.url() || ''); } catch { return false; } }) || null;
                            if (page) {
                                reusedExisting = true;
                                try { await page.bringToFront(); } catch {}
                                log('INFO', `♻️ 复用实例里已有 Facebook 标签页，不再新开 (profileId=${profileId}, url=${String(page.url() || '').slice(0, 80)})`);
                            } else {
                                page = pages.find(p => { try { const u = p.url() || ''; return u === '' || u === 'about:blank'; } catch { return false; } }) || null;
                            }
                        } catch {}
                        if (!page) page = await existing.browser.newPage();
                        try { attachCookieSync(page, profileId); } catch {}
                        try { await browserManagerModule.applyStealthToPage(page, browserManagerModule.getFingerprint(profileId, finalProfile), 'reuse'); } catch {}
                        // 复用的是「已经开着 Facebook」的标签时不再重新导航，避免打断用户当前所在页面
                        if (!(reusedExisting && /facebook\.com/i.test(String(page.url() || '')))) {
                            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                        }
                        console.log(`✅ 已在复用实例打开网站: ${url}`);
                    } catch (reuseErr) {
                        try { log('DEBUG', `复用实例打开网站失败 ${url}: ${String(reuseErr && reuseErr.message || reuseErr)}`); } catch {}
                    }
                }
                // 🪶 借用型复用：要区分「这个浏览器是谁的」
                //    · 本来就是借用型的（上次队列借来还没还）→ 它归我们管：重新武装回收定时器
                //      （否则上一轮遗留的定时器会在本次使用中途把它关掉，日志里的
                //       「配置 X 的浏览器已关闭，中止当前任务项」有一部分就是它），
                //      并告诉调用方 owned=true，用完照常归还 → 名额当场释放。
                //    · 用户自己手动开着的窗口 → 不标记、不关闭，只借用；名额也不再被它占用
                //      （闸门已改为按「借用中 + 启动中」计数，见下面 maxSlots 那段）。
                const owned = borrow === true && isBorrowedBrowser(profileId);
                if (owned) {
                    markBorrowedBrowser(profileId, existing.browser);
                    const doneBorrowHold = touchBorrowedBrowser(profileId);
                    if (doneBorrowHold) {
                        res.on('finish', () => { try { doneBorrowHold(); } catch {} });
                        res.on('close', () => { try { doneBorrowHold(); } catch {} });
                    }
                    log('INFO', `🔁 [Launch] 复用借用型实例 profileId=${profileId}（归还名额由调用方负责；活跃${activeBrowsers.size} 借用中${borrowedBrowserCount()}/${launchQueueManager.maxConcurrent}）`);
                } else {
                    log('INFO', `♻️ [Launch] 复用常驻实例 profileId=${profileId}（不占用队列名额；活跃${activeBrowsers.size} 借用中${borrowedBrowserCount()}/${launchQueueManager.maxConcurrent}）`);
                }
                return res.json({ success: true, message: '浏览器已运行，复用实例', data: { profileId, reused: true, owned }, timestamp: new Date().toISOString() });
            }
        } catch (reuseCheckErr) {
            try { log('DEBUG', `复用检查失败: ${String(reuseCheckErr && reuseCheckErr.message || reuseCheckErr)}`); } catch {}
        }

        // 🚀 全局活跃浏览器实例上限保护（按仍连接的实例统计，含所有调用方流量）
        // 🆕 默认「不限制」：0 / 未设置 / 负数 / 非数字 一律视为不设上限；只有显式配成正整数才启用兜底。
        //    需要恢复兜底时：设置环境变量 MAX_ALIVE_BROWSERS=8（或其它正整数）再重启服务即可。
        const MAX_ALIVE_BROWSERS = (() => {
            const raw = String(process.env.MAX_ALIVE_BROWSERS ?? '').trim();
            if (!raw) return 0;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) && n > 0 ? n : 0;
        })();
        try {
            let aliveTotal = 0;
            if (browserManager && browserManager.instances && browserManager.instances.size > 0) {
                for (const inst of browserManager.instances.values()) {
                    try { if (inst && inst.browser && inst.browser.isConnected()) aliveTotal++; } catch {}
                }
            }
            if (MAX_ALIVE_BROWSERS > 0 && aliveTotal >= MAX_ALIVE_BROWSERS) {
                log('WARN', `[Launch] 已达到活跃实例上限 ${MAX_ALIVE_BROWSERS}（当前连接中 ${aliveTotal}），拒绝启动 profileId=${profileId}`);
                return res.status(409).json({
                    success: false,
                    code: 'TOO_MANY_BROWSERS',
                    message: `当前已有 ${aliveTotal} 个浏览器实例在运行（上限 ${MAX_ALIVE_BROWSERS}）。请先关闭部分浏览器窗口，或重启服务 / 调大环境变量 MAX_ALIVE_BROWSERS 后再试。`,
                    data: { alive: aliveTotal, max: MAX_ALIVE_BROWSERS }
                });
            }
        } catch (capErr) {
            try { log('WARN', `[Launch] 活跃实例检查异常: ${capErr.message}`); } catch {}
        }

        // 🛡️ 防重入：同一 profile 已有启动流程在进行中（可能还在取Cookie/注入/登录验证），
        //    直接返回「正在启动」，避免两个并发请求用同一 profile 目录各自拉起 Chrome 互相抢占
        if (_launchInFlightProfiles.has(String(profileId))) {
            log('INFO', `[Launch] profileId=${profileId} 已有启动请求正在进行中，忽略本次重复请求`);
            return res.json({
                success: true,
                duplicate: true,
                message: '该配置正在启动中，请稍候',
                // 🐛 必须带 reused:true：调用方（队列 borrowLaunch）是用 `success && !reused` 判断
                //    「这个浏览器是不是本次由我启动的」，没有 reused 会被误判成「是我启动的」→
                //    这一项跑完就去 /api/stop-browser，把另一个并发项正在用的浏览器关掉。
                //    日志里的「配置 X 的浏览器已关闭，中止当前任务项」有一部分就是这个。
                data: { profileId, alreadyStarting: true, reused: true },
                timestamp: new Date().toISOString()
            });
        }
        _launchInFlightProfiles.add(String(profileId));
        // ♻️ 新一轮启动：清掉上一轮残留的登录判定。闸门状态是模块级 Map、不随浏览器关闭清理，
        //    残留的 loggedIn=true 会在新会话「还没验证」时误开闸门 → 把未验证 Cookie 推上云。
        try { resetLoginState(profileId); } catch {}
        // （_launchTaskBrowser / _allocatedDebugPort 已提到 try 之外声明，见 handler 开头）

        // 🚀 启动前强制关闭该 Profile 残留的浏览器进程，避免窗口堆积
        try {
            const bd = activeBrowsers.get(profileId);
            if (bd && bd.browser) {
                logBrowserClose(profileId, '本次启动前清理该配置残留实例', 'launch-browser/启动前清理');
                try { if (bd.browser.isConnected()) { await bd.browser.close().catch(() => {}); } } catch {}
                try { bd.process?.kill?.(); } catch {}
                activeBrowsers.delete(profileId);
                log('INFO', `🧹 [Launch] 已清理 ${profileId} 的残留浏览器实例`);
            }
        } catch {}

        // 🚀 等待「借用中 + 启动中」的浏览器数低于并发上限（在进入队列前就等，避免两个请求同时通过检查）
        // 🐛 修复：等待改为有上限（LAUNCH_WAIT_MS，默认 150s），超时直接返回 409，
        //    避免「某实例一直未关闭导致空位永远不足 → 请求无限转圈刷屏 + 自动同步持续堆积」
        //
        // ⚠️ 判据以前是 activeBrowsers.size（**所有**开着的 Chrome，含用户手动开的窗口、别的任务常驻的实例）。
        //    后果：只要有一个常驻浏览器，队列 5 个名额里就少 1 个，批量任务永远跑不满并发，
        //    尾巴上那几项要白等一整轮（实测 6 项/并发 5 时，第 6 项等了 66s 才轮到）。
        //    现在只统计「借用型浏览器 + 正在启动的」，常驻窗口不再抢队列名额；
        //    Chrome 进程总量默认不再设上限（如需兜底，显式配置 MAX_ALIVE_BROWSERS）。
        const maxSlots = launchQueueManager.maxConcurrent;
        // 名额占用情况（日志用）：借用的 / 启动中的 / 总活跃
        const slotsInfo = () => `借用中${borrowedBrowserCount()}+启动中${_pendingBrowserCount}/${maxSlots}（总活跃${activeBrowsers.size}）`;
        if (!skipCC) {
            // 🕒 等空位的上限：默认 30s（原 150s）。
            //    「无进展」在这里的语义很明确 —— 排队等别人释放名额，等满 30s 还没轮到就直接放弃，
            //    返回 409（调用方拿到响应后会走「自动启动再取数」兜底继续跑），
            //    而不是像以前那样一直排、或被静默 return 挂到单项 10 分钟超时。
            const waitMs = Math.max(10, parseInt(process.env.LAUNCH_WAIT_MS || '30000', 10) || 30000);
            const deadline = Date.now() + waitMs;
            while (borrowedBrowserCount() + _pendingBrowserCount >= maxSlots) {
                // 🐛 客户端（前端）已经放弃/断开时必须立刻退出等待：
                //    否则前端 60s 超时 abort 之后，服务端还会继续排队；等排到空位又会启动一个
                //    「没人要」的浏览器，白占一个名额（直到借用回收 60s 后才释放）
                //    → 后面排队的越等越久，表现为"前 5 个正常、轮到第二批就卡"。
                // 🐛 不能用 req.destroyed 判定（同下方 L660 的坑）：Node 16+ 请求 body 读完约 1s
                //    后 IncomingMessage 自动 destroy（流 autoDestroy），客户端明明还连着。
                //    2026-09-18 起闸门满员即秒回 CLIENT_GONE，30s 等待机制整体失效，
                //    批量取数表现为「借用中 3/3 时的自动启动全部失败」。
                //    真断开的可靠标志（实测 v22.16.0）：res.destroyed / req.socket.destroyed。
                if (res.destroyed || req.socket?.destroyed) {
                    log('WARN', `[Launch] 客户端已断开，放弃等待空位 profileId=${profileId}（${slotsInfo()}）`);
                    _launchInFlightProfiles.delete(String(profileId));
                    // 🐛 必须回一个响应：以前这里直接 `return`，一个字节都不写，
                    //    调用方（队列 borrowLaunch）的 fetch 永远不 settle —— 该项就一直挂在
                    //    「等待启动名额」这一步，直到 JOB_ITEM_TIMEOUT_MS（默认 10 分钟）才被中止。
                    //    表现就是「超出并发后整批卡住，别人跑完释放了名额也不继续」。
                    try {
                        if (!res.headersSent) {
                            res.status(409).json({
                                success: false,
                                code: 'CLIENT_GONE',
                                message: '客户端已断开，放弃等待浏览器空位',
                                data: { borrowed: borrowedBrowserCount(), pending: _pendingBrowserCount, max: maxSlots }
                            });
                        } else {
                            res.destroy();
                        }
                    } catch { }
                    return;
                }
                if (Date.now() >= deadline) {
                    log('WARN', `[Launch] 等待空位超时 ${waitMs}ms（${slotsInfo()}），放弃启动 profileId=${profileId}`);
                    _launchInFlightProfiles.delete(String(profileId));
                    return res.status(409).json({
                        success: false,
                        code: 'TOO_MANY_BROWSERS',
                        message: `等待浏览器空位超时（当前借用中 ${borrowedBrowserCount()} + 启动中 ${_pendingBrowserCount}，并发上限 ${maxSlots}）。这是「同时启动数」的限制（不是实例总数），可在设置里调大全局并发数后重试。`,
                        data: { borrowed: borrowedBrowserCount(), pending: _pendingBrowserCount, max: maxSlots }
                    });
                }
                log('INFO', `[Launch] ${slotsInfo()} ≥ ${maxSlots}，等待空位...`);
                await new Promise(r => setTimeout(r, 3000));
            }
            log('INFO', `[Launch] 获得空位（${slotsInfo()}，本次将占用第 ${borrowedBrowserCount() + _pendingBrowserCount + 1} 个名额），加入启动队列...`);
        } else {
            log('INFO', `[Launch] 跳过并发限制，直接加入启动队列（${slotsInfo()}）...`);
        }
        // ⚠️ 自增必须在两条分支之外：启动完成/失败处都会无条件下减，否则跳过并发限制的启动会把计数减成负数
        _pendingBrowserCount++;

        // 使用启动队列管理并发
        const result = await launchQueueManager.add(async () => {
            log('INFO', `[Launch] 开始启动浏览器（活跃${activeBrowsers.size}+启动中${_pendingBrowserCount}/${maxSlots}）...`);
            // ⚠️ 登录验证（DOM 探测 / AutoLogin）本次已改为「启动响应返回之后」在后台跑（见下方
            //    void (async…) —— 为的是不把 15~40s 的校验压在启动关键路径上）。
            //    因此它的结论**不可能**随启动响应返回：只落日志 + markLoginState（同步闸门）
            //    + reportLoginStatusToCloud（云端登录状态字段，前端列表读的就是它）。
            //    启动响应里的 success=true 只代表「浏览器进程起来了」，不代表已登录。

            // 🔧 设置默认参数，避免undefined（使用邮箱前缀+profileId作为目录名）
            const emailPrefix = extractEmailPrefix(finalProfile.accountEmail || finalProfile.account_email);
            const dirName = emailPrefix ? `${emailPrefix}_${String(profileId)}` : String(profileId);
            const defaultUserDataDir = path.join(_BROWSER_PROFILES_ROOT, dirName);
            // 基于profileId生成唯一端口（处理字符串profileId）
            const profileHash = profileId ? String(profileId).split('').reduce((a, b) => {
                a = ((a << 5) - a) + b.charCodeAt(0);
                return a & a;
            }, 0) : 0;
            
            // 🚀 核心优化：自动分配调试端口，避免多个浏览器冲突
            let debugPort = req.body.debugPort;
            if (!debugPort) {
                debugPort = await getAvailableDebugPort(9222);
                _allocatedDebugPort = debugPort;
                console.log(`📡 自动分配调试端口: ${debugPort}`);
            } else {
                console.log(`🔧 使用指定调试端口: ${debugPort}`);
            }

            const defaultExecutablePath = (process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
            
            // 配置浏览器参数
            const finalFbLanguage = finalProfile.fbLanguage || finalProfile.fb_language || 'en_US';
            const config = {
                profileId,
                executablePath: executablePath || defaultExecutablePath,
                userDataDir: req.body.userDataDir || defaultUserDataDir,
                debugPort: debugPort,
                proxy: finalProxy,
                userAgent: finalUserAgent,
                windowTitle: windowTitle, // 🏷️ 添加窗口标题配置
                windowSize: (req.body.windowSize || process.env.WINDOW_SIZE || finalProfile.resolution || '700x700'), // 🖥️ 添加窗口大小配置
                // 🖥️ 默认**不**强制窗口大小（原来默认 true，会把窗口钉死、无法最大化）：
                //    只有前端/调用方显式传 forceWindowSize=true 时才套用 windowSize。
                forceWindowSize: (typeof req.body.forceWindowSize !== 'undefined') ? Boolean(req.body.forceWindowSize) : (String(process.env.FORCE_WINDOW_SIZE || 'false').toLowerCase() === 'true'),
                emailPrefix,
                fbLanguage: finalFbLanguage,
                // 🧬 指纹参数
                profile: {
                    os: finalProfile.os || '',
                    resolution: finalProfile.resolution || '',
                    timezone: finalProfile.timezone || '',
                    language: finalProfile.language || '',
                    fbLanguage: finalFbLanguage,
                    userAgent: finalUserAgent,
                    fingerprintProtection: finalProfile.fingerprintProtection || {},
                    fpCanvas: finalProfile.fpCanvas || '',
                    fpWebgl: finalProfile.fpWebgl || '',
                    fpAudio: finalProfile.fpAudio || ''
                }
            };
            try {
                const urls = finalStartUrls || [];
                config.storeOptimized = urls.some(u => /chrome\.google\.com|webstore|extensions\//i.test(String(u)));
            } catch {}

            console.log(`🔧 浏览器配置: executablePath=${config.executablePath}, userDataDir=${config.userDataDir}, debugPort=${config.debugPort}`);

            // 🔧 使用统一的目录管理逻辑
            const actualUserDataDir = browserManager.getUnifiedUserDataDir(profileId, config.userDataDir, emailPrefix);

            // 🔐 本轮启动只读一次：profile 目录里 Chrome 自己维护的 Cookie 是否已有登录态。
            //    有的话，后面所有环节（磁盘预注入 / 云端 Cookie 覆盖）都必须让路，
            //    否则会把浏览器里最新的会话盖成 DB/云端里的旧会话。
            let _localLoginCk = null;
            try { _localLoginCk = await readLoginCookiesFromProfileDir(actualUserDataDir); } catch {}
            
            // 🧹 检查并清理重复目录
            await browserManager.cleanupDuplicateDirectories(profileId, config.emailPrefix);
            
            // 🍪 解析Cookie数据并预注入到数据库
            let parsedCookies = null;
            // 🍪 云端兜底拉 Cookie 的预取 promise（在下面那个块里赋值，但要在浏览器启动后、
            //    注入之前才 await —— 所以必须声明在外层作用域，不能用块内 const）。
            let remoteCookiePrefetch = null;
            if (cookies && (typeof cookies === 'string' ? cookies.trim().length > 0 : cookies.length > 0)) {
                console.log(`🍪 检测到Cookie数据，准备预注入到Chrome数据库...`);
                console.log(`🍪 Cookie数据类型: ${typeof cookies}, 内容预览: ${typeof cookies === 'string' ? cookies.substring(0, 100) : `${cookies.length} 个cookie对象`}`);
                
                try {
                    // 解析Cookie数据
                    parsedCookies = cookies;
                    if (typeof cookies === 'string') {
                        parsedCookies = parseCookieString(cookies, finalStartUrls);
                        console.log(`🔧 Cookie字符串解析结果: ${parsedCookies.length} 个cookie`);
                    }
                    
                    if (parsedCookies && parsedCookies.length > 0) {
                        log('INFO', `🍪 开始预注入 ${parsedCookies.length} 个Cookie到Chrome数据库...`);
                        
                        // 确保用户数据目录存在
                        await fs.mkdir(actualUserDataDir, { recursive: true });
                        log('DEBUG', `📁 用户数据目录已创建: ${actualUserDataDir}`);
                        
                        // 🚀 性能优化：预注入Cookie到Chrome数据库
                        await preinjectCookiesToDatabase(actualUserDataDir, parsedCookies);
                        log('INFO', `✅ Cookie预注入完成，浏览器启动后将自动读取这些Cookie`);
                        // 移除了此处过早的 syncCookiesToStorage，避免阻塞浏览器启动
                    } else {
                        log('DEBUG', `ℹ️ 解析后没有有效的Cookie数据`);
                        parsedCookies = null;
                    }
                } catch (cookieError) {
                    log('WARN', `⚠️ Cookie预注入失败: ${cookieError.message}`);
                    log('WARN', `⚠️ 将回退到页面级别的动态注入`);
                    // 即使预注入失败，也继续启动浏览器，使用动态注入作为备用
                    if (typeof cookies === 'string') {
                        try {
                            parsedCookies = parseCookieString(cookies, startUrls);
                        } catch (parseError) {
                            log('WARN', `⚠️ Cookie解析也失败: ${parseError.message}`);
                            parsedCookies = null;
                        }
                    }
                }
            } else {
                // 🔐 最高优先级：profile 目录里 Chrome 自己维护的 Cookie —— 它才是这份指纹配置
                //    「当前真实、最新」的会话；本地 DB / 云端存的很可能是旧的、甚至已失效的。
                if (_localLoginCk) {
                    log('INFO', `🔐 profile 目录已有登录 Cookie（${_localLoginCk.dbPath}），跳过 Cookie 预注入，保留浏览器现有会话`);
                    parsedCookies = null;
                } else try {
                    const conn = await mainDbPool.getConnection();
                    const row = await new Promise((resolve) => {
                        conn.get(`SELECT account_cookies FROM profiles WHERE id = ?`, [profileId], (err, r) => {
                            resolve(err ? null : r);
                        });
                    });
                    mainDbPool.releaseConnection(conn);
                    if (row && row.account_cookies) {
                        try { parsedCookies = JSON.parse(row.account_cookies); } catch { parsedCookies = null; }
                        if (parsedCookies && parsedCookies.length > 0) {
                            log('INFO', `🍪 从数据库加载到 ${parsedCookies.length} 个Cookie，准备注入`);
                        }
                    } else {
                        log('DEBUG', `ℹ️ 没有Cookie数据需要注入`);
                    }
                } catch { log('DEBUG', `ℹ️ 无法从数据库加载Cookie`); }
                
                // 🚀 如果本地数据库无 Cookie，尝试从远程存储拉取
                // 🔐 但 profile 目录里已有登录会话时（_localLoginCk），绝不从云端拉取覆盖
                // 🍪 并行预热：把「从云端兜底拉 Cookie」**提前发起但不等它** ——
                //    浏览器启动只依赖代理配置，不依赖 cookie（cookie 是启动后才用 CDP 注入的），
                //    所以这 1.2s 的网络往返会被 ~2.8s 的 Chrome 启动时间盖掉，等于白赚。
                //    以前这里是 await：白占了启动关键路径，而且拉回来的数据只喂给已经废弃的
                //    SQLite 预注入（Chrome 不采纳明文 cookie，那一步现在是空转）。
                remoteCookiePrefetch = (async () => {
                    if (_localLoginCk || (parsedCookies && parsedCookies.length > 0)) return;
                    try {
                        const remoteUrl = String(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
                        const apiSecret = process.env.PUPPETEER_API_SECRET || '';
                        // ⚠️ 原来打的是 `/api/profiles/{id}/cookies`：该路由只存在于本地 7070，
                        //    云端（宝塔）没有 → 恒 404，而下面的 `if (remoteResp.ok)` 又把它静默吃掉，
                        //    所以这条「从云端兜底注入 Cookie」的路一直是死的、还查不出原因。
                        //    改用两端都有的 GET /api/profiles/{id}（Cookie 在 data.account.cookies）。
                        // ⏱️ 必须带超时：这条 fetch 以前没有任何中止机制，实测网络抖动时会一直挂着
                        //    （5894 启动卡住的根因：从发起到返回耗了 ~104s）；有超时才能及时放弃兜底。
                        const _rc = new AbortController();
                        const _rt = setTimeout(() => { try { _rc.abort(); } catch {} }, 8000);
                        let remoteResp;
                        try {
                            remoteResp = await fetch(`${remoteUrl}/api/profiles/${profileId}`, {
                                headers: { 'X-Api-Secret': apiSecret },
                                signal: _rc.signal
                            });
                        } finally { clearTimeout(_rt); }
                        if (!remoteResp.ok) {
                            log('WARN', `⚠️ 远程Cookie拉取失败: HTTP ${remoteResp.status} (${remoteUrl}/api/profiles/${profileId})`);
                        } else {
                            const remoteData = await remoteResp.json();
                            const remoteCookies = remoteData && (remoteData.cookies || (remoteData.data && remoteData.data.account && remoteData.data.account.cookies));
                            if (remoteCookies) {
                                const rawCookies = typeof remoteCookies === 'string' ? remoteCookies : JSON.stringify(remoteCookies);
                                parsedCookies = parseCookieString(rawCookies, finalStartUrls);
                                log('INFO', `🍪 从远程存储加载到 ${parsedCookies?.length || 0} 个Cookie`);
                                if (parsedCookies && parsedCookies.length > 0) {
                                    await fs.mkdir(actualUserDataDir, { recursive: true });
                                    await preinjectCookiesToDatabase(actualUserDataDir, parsedCookies);
                                    log('INFO', `✅ 远程Cookie预注入完成`);
                                }
                            }
                        }
                    } catch (remoteErr) {
                        log('WARN', `⚠️ 远程Cookie拉取失败: ${remoteErr.message}`);
                    }
                })();
            }
            
            // 获取或创建浏览器实例（在Cookie预注入之后）
            const browserInstance = await browserManager.getBrowser(config);
            _launchTaskBrowser = browserInstance;
            try { const bp = browserInstance.browser && browserInstance.browser.process ? browserInstance.browser.process() : null; console.log(`🧩 浏览器启动: pid=${bp && bp.pid || 'unknown'} userDataDir=${config.userDataDir} debugPort=${config.debugPort}`); } catch {}
            browserInstance.lastUsed = Date.now();

            // 已移除：启动后清理初始页面逻辑
            

            
            // 注意：Cookie验证将在网站导航后进行，因为Cookie需要在正确的域名下才能被读取

            // 存储活跃浏览器
            activeBrowsers.set(profileId, {
                browser: browserInstance.browser,
                profileId,
                authToken, // 🚀 关键：保存令牌以供后续同步使用
                startTime: Date.now(),
                debugPort: config.debugPort,
                proxy: finalProxy,
                userAgent: config.userAgent,
                fbLanguage: config.fbLanguage || 'en_US', // 🐛 保存语言设置
                lastGraphQL: null,
                strictVerifyOnly: !!strictVerifyOnly
            });
            _pendingBrowserCount = Math.max(0, _pendingBrowserCount - 1);
            // 🔓 启动完成：Chrome 已绑定该端口，后续由 isDebugPortOccupied 兜住，撤销预留即可
            releaseDebugPort(_allocatedDebugPort);
            _allocatedDebugPort = null;

            // 🪶 借用型启动（批量取数临时借用）：调用方用完后应主动 /api/stop-browser 归还；
            //    若调用链断掉没人归还，空闲满 BORROWED_IDLE_MS(默认60s) 会被兜底强制关闭
            if (borrow === true) {
                // borrowMaxMs：本次借用的绝对上限覆盖（长耗时的 puppeteer 重活会传更大的值，见 markBorrowedBrowser 注释）
                markBorrowedBrowser(profileId, browserInstance.browser, borrowMaxMs);
                // 🐛 修复：本次「启动请求」本身必须算作"在用" —— 启动流程后面还有导航 + 登录态校验 +
                //    AutoLogin，经常超过 60s；此前不计入 inFlight，借用回收定时器会在启动中途把浏览器
                //    关掉，表现为 AutoLogin 报「Session closed. Most likely the page has been closed」、
                //    浏览器进程随即退出（日志里 4002 就是这个现象）。
                // 这里一直持有到 HTTP 响应结束（成功/失败/异常都会触发 finish 或 close）再释放。
                const doneBorrowHold = touchBorrowedBrowser(profileId);
                if (doneBorrowHold) {
                    // 把这份占用的**所有**释放出口都挂上，别只依赖 res：
                    // 掉线/客户端 abort 时 res 的 finish 可能压根不触发，只挂 res 就会漏成永久占用。
                    // doneBorrowHold 自身是幂等的（内部有 done 标志），重复调用安全。
                    res.on('finish', () => { try { doneBorrowHold(); } catch {} });
                    res.on('close', () => { try { doneBorrowHold(); } catch {} });
                    req.on('close', () => { try { doneBorrowHold(); } catch {} });
                    req.on('aborted', () => { try { doneBorrowHold(); } catch {} });
                }
            } else {
                // 🪶 孤儿兜底：客户端在响应送达前断开（队列 abort、前端超时）→ 无人认领，
                //    补标记借用型让它进入 60s 空闲回收。
                // 🐛 不能用 req.destroyed 判定：Node 16+ 请求消息读完（body 解析完）就会置
                //    destroyed=true，正常的手动启动请求也会命中 → 每台手动启动的浏览器都被误标
                //    借用型、60s 后被「强制关闭」（实测 4195 连续两轮中招）。
                //    只认「响应未写完时连接关闭」这一种真断开：res close + writableFinished=false。
                res.on('close', () => {
                    if (!res.writableFinished) {
                        markBorrowedBrowser(profileId, browserInstance.browser);
                        log('INFO', `🪶 [Launch] 响应送达前调用方断开，补标记借用型交由空闲回收: profileId=${profileId}`);
                    }
                });
            }

            // 🚀 核心监听：当浏览器断开连接时，自动从活跃列表移除，释放调试端口资源
            browserInstance.browser.on('disconnected', () => {
                try {
                    if (activeBrowsers.has(profileId)) {
                        const bd = activeBrowsers.get(profileId);
                        if (bd && bd.browser === browserInstance.browser) {
                            activeBrowsers.delete(profileId);
                            // 🔎 回读关闭原因：能区分「本服务主动关的」还是「浏览器自己挂了的」
                            const _why = peekBrowserCloseReason(profileId);
                            log('INFO', _why
                                ? `🔌 浏览器已断开（主动关闭）: profileId=${profileId}, port=${config.debugPort}｜原因=${_why.reason}｜触发点=${_why.by}`
                                : `🔌 浏览器已断开（⚠️ 未登记关闭原因：非本服务主动关闭，可能是崩溃/被外部结束）: profileId=${profileId}, port=${config.debugPort}`);
                        }
                        // 🚄 SSH 隧道清理
                        try { sshTunnelManager.closeTunnel(profileId); } catch {}
                        try { socksChainServer.closeChain(profileId); } catch {}
                        // 🚀 S5 隧道 / 本地认证转发器清理（按 profileId 前缀清掉该配置的全部代理资源）
                        try { _closeProfileResources(profileId); } catch {}
                    }
                } catch (e) {
                    log('WARN', `⚠️ 处理浏览器断开清理失败: ${e.message}`);
                }
            });

            // 🚀 监听浏览器进程退出，记录退出码和信号
            if (browserInstance.browser.process) {
                const childProc = browserInstance.browser.process();
                if (childProc) {
                    childProc.on('exit', (code, signal) => {
                        const _why = peekBrowserCloseReason(profileId);
                        log('WARN', `🚨 浏览器进程退出: profileId=${profileId}, exitCode=${code}, signal=${signal}, port=${config.debugPort}, pid=${childProc.pid}${_why ? `｜原因=${_why.reason}｜触发点=${_why.by}` : '｜⚠️ 未登记关闭原因(可能是崩溃/被外部杀死)'}`);
                    });
                    childProc.on('error', (err) => {
                        log('WARN', `🚨 浏览器进程异常: profileId=${profileId}, error=${err.message}, pid=${childProc.pid}`);
                    });
                }
            }

            // 仅打开首页
            try {
                // 🐛 修复「启动时出现两个空白标签页」：Chrome 启动时本来就有且只有一个 about:blank 标签页，
                //    直接拿它当主页面即可。以前是无条件 newPage()（当场变成 2 个标签页），再靠后面那次
                //    「关闭多余标签页」收尾 —— 而这两步之间要取 Cookie / 注入，实测能隔十几秒，
                //    这段时间窗口里就挂着两个空白页，看起来就是"启动了两个空白标签"。
                let page = null;
                try { page = (await browserInstance.browser.pages())[0] || null; } catch {}
                // 兜底：极少数情况拿不到初始页（例如已被外部关掉）才新开一个
                if (!page) page = await browserInstance.browser.newPage();
                
                // 1. 启用Cookie同步监听
                try { attachCookieSync(page, profileId); } catch {}
                
                // 2. 页面级画像（UA + UA-CH + 时区 + viewport + 注入脚本）：必须与主页面同一套，
                //    否则这里会把 createBrowser 已对齐真实 Chrome 版本的 UA 又打回旧版本
                try { await browserManagerModule.applyStealthToPage(page, browserManagerModule.getFingerprint(profileId, finalProfile), 'new-page'); } catch {}

                // 3. 获取并注入Cookie
                // 🐛 修复：优先从D1远程存储获取有效Cookie（上次成功登录同步的），
                // 请求参数中的Cookie可能已过期，仅当D1无数据时作为降级使用
                let cookiesToInject = [];
                // shouldSyncToStorage：本次有可注入的 Cookie（决定要不要走页面内容校验）
                let shouldSyncToStorage = false;
                // syncOk：本次存在「可校验的会话」（注入了 Cookie，或本机目录里本来就有登录态）。
                //   ⚠️ 只表示「可以进页面内容判定」，**不代表 Cookie 有效** —— 真正的登录结论由下面的 DOM 探测给出。
                let syncOk = false;

                // ☁️ 云端优先：profile 目录里有本机会话时，默认仍用云端那份覆盖 ——
                //    本机那份是 FB 上次在这个浏览器里写的，可能旧、也可能已经坏了；
                //    云端那份是「上次验证成功时回写」的，也是换台电脑能接着干的那一份。
                //    ⚠️ 但云端对「FB 事后踢掉会话」无从感知（只有下次取数失败才知道），
                //       所以下面有本机会话保护：两份不是同一个会话（xs 不同）时保留本机。
                if (_localLoginCk) {
                    log('INFO', `☁️ profile 目录里本机也有一份登录会话（${_localLoginCk.dbPath}），默认按云端优先，待会话一致性检查后决定 (profileId=${profileId})`);
                }

                // 🍪 到这里浏览器已经在并行启动了（上面那个 prefetch 也跑了一会儿）。
                //    ⚠️ 不再在这里无条件 await：它是「云端兜底」来源，只在主来源（下方
                //    getCookiesFromStorage）拿不到时才需要。以前无条件挂在启动关键路径上，
                //    而这次请求实测挂了 100+ 秒 → 整段启动卡死（5894）。
                //    挪到主来源为空时再等（见下方），并且它自身已加了 8s 超时。

                // 优先从D1远程存储获取
                try {
                    const storageCookies = await getCookiesFromStorage(profileId);
                    if (Array.isArray(storageCookies) && storageCookies.length > 0) {
                        cookiesToInject = storageCookies;
                        console.log(`✅ 从存储服务器获取到 ${cookiesToInject.length} 个Cookie`);
                    }
                } catch (e) {
                    console.warn('⚠️ 获取存储Cookie失败:', e.message);
                }

                // 🍪 主来源（云端存储）没拿到时，才等那份并行预热的「云端兜底」结果
                //    （它会写 parsedCookies）；命中主来源就不等，避免被它的网络耗时拖住启动。
                if (cookiesToInject.length === 0) {
                    try { await remoteCookiePrefetch; } catch {}
                }

                // D1无数据时，降级使用请求参数中的Cookie
                if (cookiesToInject.length === 0 && parsedCookies && parsedCookies.length > 0) {
                    cookiesToInject = parsedCookies;
                    console.log(`⚠️ 存储服务器无数据，使用请求参数中的 ${cookiesToInject.length} 个Cookie`);
                }

                // 只要有Cookie注入，就同步到远程存储（更新D1数据）
                if (cookiesToInject.length > 0) {
                    shouldSyncToStorage = true;
                }

                // 🛡️ 本机会话保护（云端优先的唯一例外）：
                //    浏览器此刻刚启动、还没注入任何 Cookie —— CDP 读到的就是本机 SQLite 加载进内存的会话。
                //    若它与云端那份**不是同一个会话**（xs 不同），盲目用云端覆盖可能把本机还活着的会话
                //    压死（2026-09-30 FB 批量踢会话后 5812 等配置即此路径：云端死快照 → 覆盖 → 取数 190）。
                //    处理：xs 不一致 → 不注入云端、沿用本机，交给下方页面校验判定真实性；
                //    校验失败仍按现有规则走（需人工 / 自动登录），且不会把死会话写回云端。
                if (_localLoginCk && cookiesToInject.length > 0) {
                    let _localXs = '';
                    try {
                        // page.cookies() 只返回当前页面（about:blank）域的 cookie，必须用 browserContext 级别读取
                        const _ctx = typeof page.browserContext === 'function' ? page.browserContext() : null;
                        const _cur = (_ctx && typeof _ctx.cookies === 'function') ? await _ctx.cookies() : await page.cookies();
                        const _xsCk = (_cur || []).find(c => c && c.name === 'xs' && /facebook\.com$/i.test(String(c.domain || '')));
                        if (_xsCk && _xsCk.value) _localXs = String(_xsCk.value).replace(/^"+|"+$/g, '');
                    } catch {}
                    const _cloudXsCk = cookiesToInject.find(c => c && c.name === 'xs');
                    const _cloudXs = _cloudXsCk ? String(_cloudXsCk.value || '').replace(/^"+|"+$/g, '') : '';
                    if (_localXs && _cloudXs && _localXs !== _cloudXs) {
                        log('WARN', `🛡️ 云端与本机不是同一个登录会话（xs 不同），保留本机会话、跳过云端注入 (profileId=${profileId})——云端那份可能是历史回写快照，真实性交给页面校验判定`);
                        cookiesToInject = [];
                    } else if (_localXs && _cloudXs) {
                        log('INFO', `☁️ 本机与云端是同一个登录会话（xs 一致），按原计划用云端 Cookie 注入 (profileId=${profileId})`);
                    }
                    // 任一侧拿不到 xs（解密失败/极端情况）→ 维持云端优先原行为，不做保护
                }

                // 🐛 云端取不到 Cookie、但本机目录里本来就有登录会话时，仍要进入「按页面内容校验」分支
                //    （syncOk 的语义就是「可以进页面校验」）。否则会朝一个可能已登录的浏览器盲发登录流程。
                if (_localLoginCk && cookiesToInject.length === 0) {
                    syncOk = true;
                    log('WARN', `⚠️ 云端 Cookie 不可用（取不到或因本机会话保护跳过注入），本次沿用本机目录里的会话 (profileId=${profileId})`);
                }

                // 🗄️ 缓存当前 Cookie，供浏览器意外断开重启时复用
                if (cookiesToInject.length > 0) {
                    profileCookiesCache.set(String(profileId), cookiesToInject);
                    console.log(`📌 已缓存 ${cookiesToInject.length} 个Cookie (profileId=${profileId})`);
                }

                if (cookiesToInject.length > 0) {
                    // 🐛 过期时间处理 —— 这是「cookie 明明传了却等于没注入」的根因。
                    //    以前把 normalizeCookie 出来的 expires 原样传给 Chrome，而 Chrome 拿到
                    //    **过去的时间戳会静默丢弃**该 cookie（不抛错、调用返回成功），
                    //    于是浏览器里根本没有 c_user/xs，启动后必然未登录。
                    //    实测：带已过期 expires 注入 → 浏览器里一个都没有；
                    //          把过期时间钳到未来 → 8 个全部写入成功。
                    //    参考实现（根目录 puppeteer-api-server.js 的 preinjectCookiesToDatabase）也是这个思路：
                    //    它只认 Netscape 的 expiry 字段，读不到就回退成「当前时间 + 1 年」。
                    const nowSec = Math.floor(Date.now() / 1000);
                    const reviveDays = parseInt(process.env.COOKIE_REVIVE_DAYS || '36500', 10);
                    const reviveUntil = nowSec + (Number.isFinite(reviveDays) && reviveDays > 0 ? reviveDays : 36500) * 24 * 3600;

                    let sessionCount = 0;   // 原本就没有到期时间的（会话级，如 c_user/xs）
                    let expiredCount = 0;   // 原本已过期的
                    let keptCount = 0;      // 本身就有有效未来有效期，保持原样
                    const validCookies = cookiesToInject
                        .map(cookie => {
                            const nc = normalizeCookie(cookie);
                            if (!nc || !nc.name) return null;
                            let domain = nc.domain || '.facebook.com';
                            if (!/facebook\.com$/i.test(domain)) domain = '.facebook.com';
                            // ⏳ 只补「必须补」的两类，其余保持原有效期：
                            //    · 会话级 cookie（c_user/xs 等没有 expires）→ 浏览器一退出就被丢弃，必须补上到期时间；
                            //    · 已过期的 → Chrome 会静默丢弃，必须钳到未来。
                            //    · 已有有效未来有效期的 → 原样保留，不再无谓改写。
                            //    ⚠️ Chrome 从 M104 起把有效期**硬截断到 400 天**（RFC6265bis 规定，无开关可放宽），
                            //       所以这里写 +100 年只是"足够远"，实际落地是 400 天 —— 仍足以避免"过期被丢弃"。
                            const hasValidExpiry = typeof nc.expires === 'number' && nc.expires > nowSec;
                            let finalExpires;
                            if (hasValidExpiry) { keptCount++; finalExpires = Math.floor(nc.expires); }
                            else if (typeof nc.expires === 'number' && nc.expires > 0) { expiredCount++; finalExpires = reviveUntil; }
                            else { sessionCount++; finalExpires = reviveUntil; }
                            return {
                                name: nc.name,
                                value: nc.value,
                                domain,
                                path: nc.path || '/',
                                secure: true,
                                httpOnly: nc.httpOnly,
                                sameSite: nc.sameSite,
                                expires: finalExpires,
                            };
                        })
                        .filter(c => c !== null);

                    if (validCookies.length > 0) {
                        log('INFO', `🍪 ${validCookies.length} 个 Cookie 就绪（${sessionCount} 个会话级已补有效期、${expiredCount} 个原已过期已钳到未来、${keptCount} 个保留原有效期）；Chrome 硬上限 400 天`);
                    }

                    // 🐛 逐条注入：以前是一次性 page.setCookie(...all)，只要有一个字段非法，
                    //    整个 CDP 调用就失败，其它本来合法的 Cookie 也一起进不去。
                    //    逐条 try/catch 后，坏的那条只影响它自己。
                    const injectedNames = new Set();
                    let injectFailCount = 0;
                    for (const ck of validCookies) {
                        try {
                            // 🚀 性能优化：为 setCookie 添加超时，防止单个浏览器卡死阻塞整个启动队列
                            await Promise.race([
                                page.setCookie(ck),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Cookie injection timed out')), 15000))
                            ]);
                            injectedNames.add(ck.name);
                        } catch (ckErr) {
                            injectFailCount++;
                            console.warn(`⚠️ 注入 Cookie 失败 ${ck.name}: ${ckErr.message}`);
                        }
                    }

                    // 🩺 回读校验：setCookie 不报错 ≠ Chrome 真的写进去了（过期 cookie 就是这种「静默丢弃」）。
                    //    以前只看提交数量就打「✅ 已批量注入 N 个」，把被丢弃的也算成功 ——
                    //    日志说成功、实际没登录，排查时最容易被这个假成功带偏。
                    let landed = 0;
                    try {
                        const ctx = typeof page.browserContext === 'function' ? page.browserContext() : null;
                        const back = (ctx && typeof ctx.cookies === 'function')
                            ? await ctx.cookies().catch(() => [])
                            : await page.cookies().catch(() => []);
                        landed = validCookies.filter(ck => back.some(b => b.name === ck.name)).length;
                    } catch {}
                    if (validCookies.length > 0) {
                        const miss = validCookies.length - landed;
                        console.log(`🍪 Cookie 注入完成：提交 ${validCookies.length} 个，实际写入 ${landed} 个${miss > 0 ? `（${miss} 个未落地）` : ''}，注入报错 ${injectFailCount} 个`);
                    }
                    const missingCritical = ['c_user', 'xs'].filter(n => !injectedNames.has(n));
                    if (missingCritical.length > 0) {
                        log('WARN', `🍪 关键登录 Cookie 未注入成功: ${missingCritical.join(', ')} —— 启动后将处于未登录状态`);
                    }

                    // ✅ 只要注入的 Cookie 里带 c_user+xs，就允许进入下面的「按页面内容校验」分支。
                    //    ⚠️ 这里**不再**顺手把 Cookie 推上云端：本轮启动刚开始时闸门已被 resetLoginState
                    //       清成「未知」，此刻同步必然被拒（还会白打两条 WARN + 一次无效的登录复检）。
                    //       云端的写入统一交给下面「DOM 确认登录之后」的那次同步（见 markLoginState 之后）。
                    if (shouldSyncToStorage) {
                        const hasValidLogin = cookiesToInject.some(c => c.name === 'c_user' && c.value) && cookiesToInject.some(c => c.name === 'xs' && c.value);
                        if (hasValidLogin) {
                            // syncOk 的语义 = 「有可校验的会话」→ 进页面内容判定（不代表 Cookie 有效）
                            syncOk = true;
                        } else {
                            log('INFO', `⏭️ Cookie 不含有效登录态(c_user+xs)，保持云端已有数据`);
                        }
                    }
                }

                // 🌐 FB语言设置：注入 Facebook locale cookie
                try {
                    const fbLocaleMap = { 'zh_CN': 'zh_CN', 'en_US': 'en_US' };
                    const localeValue = fbLocaleMap[config.fbLanguage] || 'en_US';
                    await page.setCookie({
                        name: 'locale',
                        value: localeValue,
                        domain: '.facebook.com',
                        path: '/',
                        secure: true,
                        httpOnly: false,
                        sameSite: 'Lax',
                        // ⏳ 与其它 cookie 保持同一口径：补上到期时间，避免会话级 cookie 在浏览器退出时被丢弃
                        expires: Math.floor(Date.now() / 1000) + 36500 * 24 * 60 * 60
                    });
                    console.log(`🌐 已注入 Facebook locale cookie: ${localeValue}`);
                } catch (e) {
                    console.warn('⚠️ 注入 locale cookie 失败:', e.message);
                }

                // 4. 🌐 关闭 Chrome 默认的 about:blank 标签页，用同一个标签页导航目标网站
                // 🚀 核心修复：Chrome 启动时自带一个 about:blank 标签页，必须关闭，
                // 否则用户会看到空白标签页。同时关闭 Cookie 注入标签页，仅保留导航标签页。
                const targetUrl = (finalStartUrls && finalStartUrls[0]) ? finalStartUrls[0] : 'https://www.facebook.com/';
                const isFacebookDomain = /facebook\.com/i.test(targetUrl);
                
                // 关闭所有无关标签页，只保留当前 page 用于导航
                try {
                    const allPages = await browserInstance.browser.pages();
                    for (const p of allPages) {
                        try {
                            if (p !== page) {
                                await p.close();
                            }
                        } catch {}
                    }
                } catch {}
                
                try { await browserManagerModule.applyStealthToPage(page, browserManagerModule.getFingerprint(profileId, finalProfile), 'new-page'); } catch {}
                try { attachCookieSync(page, profileId); } catch {}
                
                // 5. 🩺 代理诊断页（默认不开）：用 setContent 直接渲染，不走网络请求避免代理拦截 localhost。
                //    ⚠️ 以前是无条件 newPage() 且创建后从不关闭 → 每次启动都在浏览器里多留一个标签页
                //       （上面刚把无关标签页全关掉、只留一个），批量启动时纯噪音。
                //    需要看代理出口 IP / UA 时：环境变量 OPEN_DIAG_PAGE=true 打开。
                //    同一份信息也可直接访问 http://localhost:<debugPort>/api/proxy-diagnostics 查看。
                const diagPromise = /^(1|true|yes|on)$/i.test(String(process.env.OPEN_DIAG_PAGE || ''))
                    ? (async () => {
                    try {
                        const diagPage = await browserInstance.browser.newPage();
                        const proxyType = String(finalProxy?.type || 'N/A');
                        const proxyHost = String(finalProxy?.host || 'N/A');
                        const proxyPort = String(finalProxy?.port || 'N/A');
                        const diagInfo = {
                            profileId: String(profileId),
                            browser: 'Google Chrome (Puppeteer)',
                            localIP: '检测中...',
                            userAgent: finalUserAgent || 'N/A',
                            serverTime: new Date().toISOString(),
                            proxyType,
                            proxyHost,
                            proxyPort,
                        };
                        const diagHtml = buildDiagnosticsHtml(diagInfo);
                        await diagPage.setContent(diagHtml, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => {
                            console.log(`⚠️ 诊断页加载失败（不影响后续）: ${e.message}`);
                        });
                        console.log(`📋 诊断页面已直接渲染（内建 HTML, 不走网络请求)`);
                    } catch {}
                })()
                    : Promise.resolve();

                // 🚀 优化：始终先导航到 www.facebook.com 首页确认登录态，
                // 避免直接跳转 business/adsmanager 等子域名导致 Cookie 被清除
                const landingUrl = 'https://www.facebook.com/';
                console.log(`🚀 首次导航（确认登录态）: ${landingUrl}`);
                // ⚡ 启动提速：以前是 networkidle2 —— Facebook 页面几乎不会进入网络空闲，
                //    这一步会白等好几秒甚至撞满 60s 超时。改为 domcontentloaded（参考实现同款写法），
                //    DOM 一就绪就继续；登录态后面仍会用页面内容重新判定，不靠"networks 静默"来判。
                const firstNavPromise = page.goto(landingUrl, { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                }).then(() => {
                    console.log(`✅ 首次导航完成: ${landingUrl}`);
                }).catch(e => {
                    console.log(`⚠️ 首次导航加载可接受网络延迟: ${e.message}`);
                });

                // 🐛 修复：先等待导航完成（第7392行曾被注释导致导航未完成就执行了登录检测）
                try { await firstNavPromise; } catch {}
                try { await diagPromise; } catch {}

                // 🧹 导航后再清一次「多余的空白标签页」：上面那次清理跑在导航之前，而 Chrome 有时
                //    在首屏导航期间才把初始 about:blank / 新标签页补出来（或上一次复用遗留）→ 窗口里
                //    会挂着两个空白页。这里只关「空白 / 新标签页」，绝不碰有真实 URL 的页面。
                try {
                    const _extraPages = await browserInstance.browser.pages();
                    for (const _p of _extraPages) {
                        try {
                            if (_p === page) continue;
                            const _u = String(_p.url() || '');
                            if (_u === '' || _u === 'about:blank' || _u.startsWith('chrome://newtab')) {
                                await _p.close();
                                log('INFO', `🧹 已关闭多余的空白标签页 (profileId=${profileId})`);
                            }
                        } catch {}
                    }
                } catch {}

                // 🚀 7. 自动登录：始终通过真实页面内容检测登录状态（Cookie同步成功不代表Cookie有效）
                // 🐛 修复：始终坚持DOM页面内容检测，即使CDP检测到c_user+xs cookie也存在过期失效的情况
                // ⚡ 登录校验 / 自动登录 / 二次导航整段转到后台：浏览器起来并把落地页 DOM 拉下来
                //    就立刻返回，不再等这套流程跑完（以前这一步能吃掉 15~40s）。
                //    参考实现（根目录 puppeteer-api-server.js L1713）也是导航完就返回、不做登录流程。
                //    ⚠️ 代价：启动响应里不再同步带「未登录」提示；登录结果照旧写日志 + 上报云端状态。
                //    ⚠️ 守卫：启动提前返回后，调用方（例如批量取数）可能马上把这个标签页导航走，
                //       所以每个侵入性动作前都检查页面是否还在落地页，被接管就立刻退出。
                // ⚠️ 默认 fire-and-forget（不 await）：登录校验/自动登录耗 15~40s，压在启动关键路径上会拖慢手动启动。
                //    awaitLogin=true 的调用方（队列的「获取信息」）会显式 await 这个 promise，等登录流程跑完再返回。
                loginFlowPromise = (async () => {
                let needsAutoLogin = false;
                // 本轮登录流程的结论：只用于本后台块内的日志与云端登录状态回写（不随启动响应返回）
                let loginWarning = '';
                // 🔎 页面内容判定登录态（抽成函数：下面「改用云端 Cookie 重验」要跑同一套判定）
                const domLoginProbe = () => {
                    const bodyText = document.body?.innerText || '';
                    const url = window.location.href;
                    const hasPass = !!document.querySelector('input[type="password"], input[name="pass"i]');
                    const isOnHome = /facebook\.com\/?(\?|$)/i.test(url);
                    const feedIndicators = [
                        "What's on your mind", '在想什么', 'Create a post', '创建帖子',
                        'News Feed', '动态消息', 'Novedades', 'Feed de noticias',
                        'Was ist los', "Was gibt's Neues", 'Beitrag erstellen',
                        'Quoi de neuf', 'Créer une publication', "Fil d'actualité",
                        'A cosa stai pensando', 'Crea un post', 'Feed di notizie',
                        '¿Qué estás pensando', 'Crear una publicación', 'Sección de noticias',
                        'Wat is er aan de hand', 'Bericht plaatsen', 'Nieuwsfeed',
                        'Co słychać', 'Utwórz post', 'Aktualności',
                        'O que você está pensando', 'Criar publicação', 'Feed de notícias',
                        'Bạn đang nghĩ gì', 'Tạo bài viết', 'Bảng tin',
                        '何を考えていますか', '投稿を作成', 'ニュースフィード',
                        '무슨 생각을 하고 있나요', '게시물 만들기', '뉴스 피드'
                    ];
                    const isLoggedIn = isOnHome && feedIndicators.some(kw => bodyText.includes(kw));
                    const hasLoginForm = hasPass || /login/i.test(url) || /checkpoint/i.test(url);
                    // 🛡️ 人机验证（checkpoint）：FB 把账号拦到安全验证页时 URL 会是 facebook.com/checkpoint/...（也可能带 next= 参数）。
                    //    ⚠️ 这跟「Cookie 过期」是两回事：Cookie 本身没坏，只是要人去过验证。
                    //    所以只认 URL（可靠、几乎不会误判），不去猜页面文案，否则容易把正常页误判成验证页。
                    const isCheckpoint = /\/checkpoint\b/i.test(url);
                    return { isLoggedIn, isLoginPage: hasLoginForm || bodyText.includes('Log in') || bodyText.includes('登录'), isCheckpoint };
                };
                const runDomLoginProbe = async () => {
                    try { return await page.evaluate(domLoginProbe); }
                    catch (e) {
                        log('WARN', `⚠️ 登录状态DOM检测异常: ${e.message}`);
                        return { isLoggedIn: false, isLoginPage: false };
                    }
                };
                if (syncOk) {
                    log('INFO', `✅ Cookie已注入到浏览器，通过页面内容验证登录状态...`);
                    const loginCheck = await runDomLoginProbe();

                    if (loginCheck.isLoggedIn) {
                        log('INFO', `✅ 页面验证已登录，跳过自动登录 (profileId=${profileId})`);
                        // 🔐 本轮已确认登录 → 打开会话闸门，之后 Cookie 有变化才允许同步回云端
                        markLoginState(profileId, true);
                        // 🔄 立即同步一次 Cookie 到云端：DOM 已确认登录，此刻浏览器里的会话最新鲜有效。
                        //    以前只开闸门不主动同步，依赖 attachCookieSync 的「变化触发」——若 FB 不下发
                        //    新 Cookie，这份有效会话迟迟不上云，云端/其他机器一直拿旧快照。
                        try {
                            const _vCookies = await page.cookies().catch(() => []);
                            const _vFb = _vCookies.filter(c => /(\.|^)facebook\.com$/i.test(String(c.domain || '')));
                            const _vLoggedIn = _vFb.some(c => c.name === 'c_user' && c.value) && _vFb.some(c => c.name === 'xs' && c.value);
                            if (_vLoggedIn && _vFb.length) {
                                await syncCookiesToStorage(profileId, _vFb, authToken);
                                log('INFO', `🔄 页面验证已登录，立即同步 Cookie 到云端 (count=${_vFb.length}, profileId=${profileId})`);
                            }
                        } catch (_syncErr) {
                            log('WARN', `🔄 验证后立即同步 Cookie 失败（不影响启动，后续变化仍会触发同步）: ${_syncErr.message}`);
                        }
                    } else {
                        // ☁️ 云端优先策略下没有回滚：云端那份就是唯一依据，它不行就走登录流程
                        // 🛡️ 人机验证只改日志措辞，不改行为：照旧走登录流程，等跑完再按最终 URL 定性（见下面 AutoLogin 结束处）
                        log('WARN', loginCheck.isCheckpoint
                            ? `🛡️ 云端 Cookie 页面被人机验证拦截（checkpoint），走登录流程 (profileId=${profileId})`
                            : `⚠️ 云端 Cookie 页面显示未登录 (profileId=${profileId})，执行自动登录`);
                        markLoginState(profileId, false);
                        needsAutoLogin = true;
                    }
                } else {
                    // syncOk 为 false 时也需要等待导航完成
                    try { await firstNavPromise; } catch {}
                    needsAutoLogin = true;
                }
                
                if (needsAutoLogin) {
                    try {
                    log('INFO', `🔐 [AutoLogin] 开始 (profileId=${profileId})...`);
                    await new Promise(r => setTimeout(r, 2000));
                    
                    const fbPage = page;

                    // 🛡️ 页面切换容错：Tab+Tab+Enter 会提交登录表单并触发跳转，跳转期间 frame 会被重建，
                    //    此时在旧 frame 上执行 evaluate/键盘操作，Puppeteer 会抛
                    //    「Attempted to use detached Frame」/「Execution context was destroyed」/
                    //    「Session closed」等瞬时错误 —— 这不是真的失败，等页面切完重试即可。
                    //    （实测这些异常都出现在 Tab+Tab+Enter 之后约 5.6s，也就是密码框检测那一步。）
                    const isTransientPageErr = (e) => /detached Frame|Execution context was destroyed|Cannot find context|Navigating frame was detached|frame was detached|Session closed|Target closed/i.test(String((e && e.message) || e));
                    const pageOp = async (label, fn, retries = 3) => {
                        for (let i = 0; ; i++) {
                            try { return await fn(); }
                            catch (e) {
                                if (i >= retries || !isTransientPageErr(e) || (fbPage.isClosed && fbPage.isClosed())) throw e;
                                log('DEBUG', `🔁 [AutoLogin] ${label} 撞上页面切换，稍后重试 (${i + 1}/${retries})`);
                                await new Promise(r => setTimeout(r, 600 + i * 400));
                            }
                        }
                    };

                    // ⚡ 守卫：启动已经提前返回，调用方（例如队列里的取数）可能已经把这个页面导航走了。
                    //    页面不在落地页就说明有人接管，立刻退出，避免和对方抢同一个标签页。
                    {
                        const cur = String(fbPage.url() || '');
                        const stillLanding = cur === '' || cur === 'about:blank' || /^https?:\/\/(www\.)?facebook\.com\/?(\?|$)/i.test(cur);
                        if (!stillLanding) {
                            log('INFO', `⚡ [AutoLogin] 页面已被调用方导航离开，跳过后台登录流程 (profileId=${profileId}, url=${cur.substring(0, 90)})`);
                            return;
                        }
                    }
                    
                    // CDP 检查 cookie 里有没有 c_user/xs
                    // ⚠️ 这里只能说明 cookie「在」，**不能**说明它「有效」—— 能走到 AutoLogin，
                    //    就说明上面的页面内容检测已经判定未登录了，也就是「cookie 在但会话已死」。
                    //    所以这里绝不能开云端写入闸门：以前这里 markLoginState(true)，等于放行一批
                    //    死 cookie 写回云端；再叠加批量操作大量启停浏览器，坏会话就被成片覆盖上去了。
                    let hasSessionCookies = false;
                    try {
                        const cookies = await fbPage.cookies();
                        hasSessionCookies = cookies.some(c => c.name === 'c_user' && c.value) && cookies.some(c => c.name === 'xs' && c.value);
                    } catch {}
                    if (hasSessionCookies) {
                        // 不早退：cookie 在但页面判定未登录 → 这份会话已经废了，必须继续走登录流程，
                        // 否则浏览器就这么留着一个「看似已登录、实际登出」的状态交回去。
                        log('WARN', `⚠️ [AutoLogin] cookie 里仍有 c_user/xs 但页面已判定未登录（会话已失效），继续执行登录 (profileId=${profileId})`);
                    }

                    const loginPassword = finalProfile?.accountPassword || finalProfile?.account_password || '';
                    if (!loginPassword) {
                        log('WARN', `⚠️ [AutoLogin] 无密码，跳过`);
                        return;
                    }

                    // Tab+Tab+Enter 推进（邮箱由 cookies 带入）
                    log('INFO', `🔐 [AutoLogin] Tab+Tab+Enter 推进...`);
                    await pageOp('Tab', () => fbPage.keyboard.press('Tab'));
                    await new Promise(r => setTimeout(r, 300));
                    await pageOp('Tab', () => fbPage.keyboard.press('Tab'));
                    await new Promise(r => setTimeout(r, 300));
                    await pageOp('Enter', () => fbPage.keyboard.press('Enter'));
                    await new Promise(r => setTimeout(r, 5000));

                    // 检测密码框 → 输入密码 → Enter
                    // ⚠️ 这一步最容易撞上「跳转中 frame 已重建」：重试若干次仍拿不到就当作没有密码框继续往下走，
                    //    不能让它把整个 AutoLogin 中断掉（以前就是它抛异常 → 直接跳到最外层 catch，登录流程半途而废）。
                    const pwFound = await pageOp('检测密码框', () => fbPage.evaluate(() => {
                        const el = document.querySelector('input[type="password"], input[name="pass"i]');
                        if (el) { el.focus(); el.click(); return true; }
                        return false;
                    }), 4).catch((e) => {
                        log('DEBUG', `🔐 [AutoLogin] 检测密码框未成功（页面持续切换）: ${String((e && e.message) || e).slice(0, 80)}`);
                        return false;
                    });
                    if (pwFound) {
                        log('INFO', `🔐 [AutoLogin] 输入密码...`);
                        await new Promise(r => setTimeout(r, 300));
                        // 🧹 输入前先清空：上面检测那一步只做了 focus+click，框里若已有残留
                        //    （浏览器自动填充 / 上一次失败留下的值）直接 type 会在后面拼接 →
                        //    产出错误密码 → 白白送一次「失败登录」，把账号往人机验证上推。
                        //    用原生 setter + input 事件，保证 React 受控组件也同步到新值。
                        await pageOp('清空密码框', () => fbPage.evaluate(() => {
                            const el = document.querySelector('input[type="password"], input[name="pass"i]');
                            if (!el) return false;
                            el.focus();
                            try { el.select && el.select(); } catch {}
                            try {
                                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                                setter.call(el, '');
                            } catch { try { el.value = ''; } catch {} }
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            return true;
                        }), 2).catch(() => false);
                        // ⚠️ 这里**故意不重试**：keyboard.type 是逐字输入，第一次若中途报错，重试会把密码
                        //    再打一遍（框里变成「密码+密码」这种错值）→ 又是一次失败登录。宁可少打，不打两遍。
                        let typedOk = true;
                        try {
                            await fbPage.keyboard.type(loginPassword, { delay: 80 });
                        } catch (tyErr) {
                            typedOk = false;
                            log('WARN', `⚠️ [AutoLogin] 输入密码失败（不重试，避免打两遍）: ${String((tyErr && tyErr.message) || tyErr).slice(0, 80)} (profileId=${profileId})`);
                        }
                        if (typedOk) {
                            await new Promise(r => setTimeout(r, 500));
                            // 🛡️ 提交前回读：确认框里就是我们要的那串密码且非空。
                            //    对不上就**不提交** —— 宁可这次不登录，也不给 FB 送一次错密码
                            //    （同一账号连续失败登录会被抬风控，最终弹人机验证）。
                            const typed = await pageOp('回读密码框', () => fbPage.evaluate(() => {
                                const el = document.querySelector('input[type="password"], input[name="pass"i]');
                                return el ? String(el.value || '') : null;
                            }), 2).catch(() => null);
                            const wantLen = String(loginPassword).length;
                            if (typed === null) {
                                log('WARN', `⚠️ [AutoLogin] 提交前读不到密码框，放弃提交（避免送错密码）(profileId=${profileId})`);
                            } else if (typed.length !== wantLen) {
                                log('WARN', `⚠️ [AutoLogin] 密码框回读不符（期望 ${wantLen} 位 / 框内 ${typed.length} 位），放弃提交（避免送错密码）(profileId=${profileId})`);
                            } else {
                                await fbPage.keyboard.press('Enter');
                                await new Promise(r => setTimeout(r, 3000));
                                try { await fbPage.waitForNavigation({ timeout: 15000 }).catch(() => {}); } catch {}
                            }
                        }
                    }

                    // 验证页面处理：2FA / 两步验证 / checkpoint
                    // 🚫 这里不做任何自动操作：不自动填写 2FA 验证码，也不在验证页上按 Enter/Tab
                    //    试图「推进」（以前会对一次性 encrypted_context 链接重复提交，FB 直接回
                    //    "This page isn't available right now"）。检测到需要验证就停下来标记，交人工。
                    await new Promise(r => setTimeout(r, 1000));
                    const urlAfterSubmit = fbPage.url();
                    const looksLikeVerifyUrl = urlAfterSubmit.includes('two_step_verification') || urlAfterSubmit.includes('checkpoint');
                    const detectCodeInput = () => pageOp('检测验证码框', () => fbPage.evaluate(() => !!document.querySelector(
                        'input[inputmode="numeric"][maxlength="6"], input[autocomplete="one-time-code"], input[type="tel"], input[name="approvals_code"]'
                    )), 2).catch(() => false);
                    let hasCodeInput = await detectCodeInput();
                    // 页面可能还在渲染：URL 像验证页时再确认一次（只确认，不做任何输入）
                    if (!hasCodeInput && looksLikeVerifyUrl) {
                        await new Promise(r => setTimeout(r, 2000));
                        hasCodeInput = await detectCodeInput();
                    }
                    if (hasCodeInput || looksLikeVerifyUrl) {
                        loginWarning = hasCodeInput
                            ? '页面要求输入验证码（2FA），已按要求不自动填写，需人工完成'
                            : '登录未完成：进入了验证流程，需人工检查';
                        markLoginState(profileId, false);
                        log('WARN', `🔐 [AutoLogin] ${loginWarning} (profileId=${profileId}), URL=${fbPage.url().substring(0, 120)}`);
                    }

                    // 同步 Cookie，并在这一步判定这次自动登录到底成没成 —— 只有真的拿到 c_user/xs 才算成功。
                    // ⚠️ 以前这里没有 else：失败什么都不打，上面却无条件写「AutoLogin 完成」→ 上游以为登录成功了。
                    try {
                        const loginCookies = await fbPage.cookies().catch(() => []);
                        const fbCookies = loginCookies.filter(c => /facebook\.com$/i.test(c.domain) || /\.facebook\.com$/i.test(c.domain));
                        const loggedInNow = fbCookies.some(c => c.name === 'c_user' && c.value) && fbCookies.some(c => c.name === 'xs' && c.value);
                        if (loggedInNow) {
                            log('INFO', `🔐 [AutoLogin] 登录成功，同步 Cookie (count=${fbCookies.length}), URL: ${fbPage.url().substring(0, 120)}`);
                            // 🔐 真的登录成功了 → 打开会话闸门，这次同步才允许写云端
                            markLoginState(profileId, true);
                            if (global.__syncThrottle && global.__syncThrottle[profileId]) delete global.__syncThrottle[profileId];
                            await syncCookiesToStorage(profileId, fbCookies, authToken);
                        } else {
                            // 保留上面 2FA 分支给出的更具体原因，没有才用这条兜底
                            if (!loginWarning) loginWarning = '自动登录未成功（输入密码后仍未取得登录态），需人工检查';
                            markLoginState(profileId, false);
                            log('WARN', `🔐 [AutoLogin] 未登录成功: ${loginWarning} (profileId=${profileId}), URL=${fbPage.url().substring(0, 120)}`);
                            // 🛡️ 人机验证单独落一档：Cookie 本身没坏，是 FB 要人去过验证。
                            //    混记成「登录失效」会让用户以为要重新登号，白折腾一轮。
                            //    放在这里（而不是一检测到就写）是因为要等登录流程跑完，
                            //    以最终落地的 URL 为准，避免中途判定被后续成功覆盖成错的。
                            try {
                                if (/\/checkpoint\b/i.test(fbPage.url() || '')) {
                                    log('WARN', `🛡️ 最终落在人机验证页（checkpoint），标记「需人机验证」(profileId=${profileId})`);
                                    reportLoginStatusToCloud(profileId, 'checkpoint');
                                }
                            } catch {}
                        }
                    } catch (syncErr) {
                        log('WARN', `🔐 [AutoLogin] 同步 Cookie 失败: ${syncErr.message}`);
                    }
                } catch (loginErr) {
                    log('WARN', `⚠️ [AutoLogin] 异常: ${loginErr.message}`);
                }
                } // 🚀 结束 if(needsAutoLogin)

                // 🚀 如果首次导航到 facebook.com 确认登录态，且目标 URL 不同，则二次导航
                const finalTargetUrl = (finalStartUrls && finalStartUrls[0]) ? finalStartUrls[0] : 'https://www.facebook.com/';
                if (landingUrl !== finalTargetUrl && /facebook\.com/i.test(finalTargetUrl)) {
                    // ⚡ 守卫同上：页面已被调用方接管就不要再导航它
                    const curUrl = String(page.url() || '');
                    const takenOver = curUrl !== '' && curUrl !== 'about:blank' && !/^https?:\/\/(www\.)?facebook\.com\/?(\?|$)/i.test(curUrl);
                    if (takenOver) {
                        log('INFO', `⚡ 页面已被调用方导航离开，跳过后台二次导航 (profileId=${profileId})`);
                    } else {
                        console.log(`🚀 登录确认完毕，跳转到目标页面: ${finalTargetUrl}`);
                        try {
                            await page.goto(finalTargetUrl, { 
                                waitUntil: 'domcontentloaded', 
                                timeout: 30000 
                            });
                            console.log(`✅ 目标页面导航完成: ${finalTargetUrl}`);
                        } catch (e) {
                            console.log(`⚠️ 目标页面导航可接受网络延迟: ${e.message}`);
                        }
                    }
                }
                })().catch(e => { try { log('WARN', `⚠️ 后台登录流程异常: ${e.message}`); } catch {} });
            } catch (pageError) {
                try { log('DEBUG', `打开网站失败: ${String(pageError && pageError.message || pageError)}`); } catch {}
            }
                
                // 在关键Cookie验证全部成功后再打开账单验证向导；
                // 若开启 AUTO_CLICK_VERIFY_FORCE，则即使未全部就绪也尝试一次点击
                /*
                    if (keyCookiesVerified || forceClick || String(process.env.AUTO_CLICK_VERIFY || '').toLowerCase() === 'true') {
                        try {
                            const navIsBillingHub = /business\.facebook\.com\/billing_hub\/payment_settings/i.test(String(navUrl));
                            let page;
                            if ((navIsBillingHub || openedBillingHub) && firstPage) {
                                page = firstPage;
                                try { await page.bringToFront(); } catch {}
                                console.log(`✅ 复用首个标签页进行账单验证: ${billingHubUrl}`);
                            } else {
                                page = await browserInstance.browser.newPage();
                                try { await browserManagerModule.applyStealthToPage(page, browserManagerModule.getFingerprint(profileId, finalProfile), 'billing-page'); } catch {}
                                await page.goto(billingHubUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                                console.log(`✅ 已打开账单验证向导(延迟至Cookie就绪): ${billingHubUrl}`);
                                try { await new Promise(r => setTimeout(r, )); } catch {}
                            }
                            const doSaveCardInfo = String(process.env.SAVE_CARD_INFO || '').toLowerCase() === 'true';
                            if (doSaveCardInfo) { let last4 = null, network = null;
                            try {
                                const info = await page.evaluate(() => {
                                    const text = document.body.innerText || '';
                                    const networks = ['visa','mastercard','amex','discover','jcb','unionpay'];
                                    let net = null, last = null;
                                    for (const n of networks) {
                                        const rx = new RegExp(`${n}[^0-9]*([0-9]{4})`, 'i');
                                        const m = text.match(rx);
                                        if (m && m[1]) { net = n; last = m[1]; break; }
                                    }
                                    return { net, last };
                                });
                                if (info && info.last) last4 = String(info.last);
                                if (info && info.net) network = String(info.net);
                                try { log('INFO', `🔎 抓取卡片信息: network=${String(network||'')} last4=${String(last4||'')}`); } catch {}
                            } catch {}
                            try {
                                const u = new URL(billingHubUrl);
                                const numId = String(u.searchParams.get('payment_account_id') || u.searchParams.get('asset_id') || '').replace(/[^0-9]/g,'');
                                const sbase = String(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
                                if (last4 && numId) {
                                    const brand = String(network || '').toUpperCase();
                                    const payload = { profileId, accountId: numId, brand, last4 };
                                    try { log('INFO', `🔧 回传卡片信息: profileId=${profileId} accountId=${numId} brand=${brand} last4=${last4}`); } catch {}
                                    try {
                                        const resp = await fetch(`${sbase}/api/billing-methods/upsert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                                        let ok = resp && resp.ok;
                                        let body = null; try { body = await resp.json(); } catch {}
                                        try { log('INFO', `✅ 回传结果: status=${resp && resp.status} ok=${ok} body=${JSON.stringify(body||{})}`); } catch {}
                                    } catch (e) {
                                        try { log('ERROR', `❌ 回传失败: ${String(e && e.message || e)}`); } catch {}
                                    }
                                }
                            } catch {}
                            let clicked = false; const bd2 = activeBrowsers.get(profileId) || {}; if (!bd2.strictVerifyOnly && String(process.env.AUTO_CLICK_VERIFY || '').toLowerCase() === 'true') {
                            try {
                                try {
                                    await page.evaluate(() => {
                                        const hideByText = (t) => Array.from(document.querySelectorAll('*')).filter(el => (el.textContent||'').includes(t));
                                        hideByText('Google Translate').forEach(el => { try { el.style.setProperty('display','none','important'); } catch(_){} });
                                    });
                                } catch {}
                                try { await page.bringToFront(); } catch {}
                                try { await new Promise(r => setTimeout(r, )); } catch {}
                                for (let i = 0; i < 1 && !clicked; i++) {
                                    try { await new Promise(r => setTimeout(r, )); } catch {}
                                    let info1 = null;
                                    try {
                                        info1 = await page.evaluate(() => {
                                            const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                                            const btns = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], [aria-label]'));
                                            let t = btns.find(b => /verify payment method|verifier payment method|verificar|verifica|验证付款方式|验证支付方式|确认/i.test(norm(b.textContent)));
                                            if (!t) t = btns.find(b => /verify payment method|verifier payment method|verificar|verifica|验证付款方式|验证支付方式|确认/i.test(norm(b.getAttribute('aria-label'))));
                                            const details = { candidates: btns.length, matched: !!t, text: t ? (t.textContent||'').trim() : '', aria: t ? (t.getAttribute('aria-label')||'') : '' };
                                            if (t) { try { t.scrollIntoView({ block:'center' }); } catch(_){}; try { t.click(); } catch(_){}; return { clicked: true, source: 'cta.verify_payment_method', details }; }
                                            return { clicked: false, source: '', details };
                                        });
                                    } catch {}
                                    try { log('DEBUG', `🔎 [CTA] candidates=${String(info1 && info1.details && info1.details.candidates || 0)} matched=${String(info1 && info1.details && info1.details.matched || false)} text=${String(info1 && info1.details && info1.details.text || '')} aria=${String(info1 && info1.details && info1.details.aria || '')}`); } catch {}
                                    if (info1 && info1.clicked) { clicked = true; continue; }
                                    let info2 = null;
                                    try {
                                        info2 = await page.evaluate(() => {
                                            const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                                            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal'));
                                            const scope = dialogs.length ? dialogs[0] : document;
                                            const btns = Array.from(scope.querySelectorAll('button, div[role="button"], a[role="button"], [aria-label]'));
                                            const eq = ['verify','verifier','verificar','verifica'];
                                            let t = btns.find(b => eq.includes(norm(b.textContent)));
                                            if (!t) t = btns.find(b => /verify card|verifier la carte|verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.textContent)));
                                            if (!t) t = btns.find(b => /verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.getAttribute('aria-label'))));
                                            const details = { dialogs: dialogs.length, candidates: btns.length, matched: !!t, text: t ? (t.textContent||'').trim() : '', aria: t ? (t.getAttribute('aria-label')||'') : '' };
                                            if (t) {
                                                try { t.removeAttribute('disabled'); } catch(_){ }
                                                try { const ev = (n, opts={}) => { try { t.dispatchEvent(new MouseEvent(n, { bubbles:true, cancelable:true, composed:true, ...opts })); } catch(_){} }; ev('pointerdown'); ev('mousedown'); ev('pointerup'); ev('mouseup'); ev('click'); } catch(_){}
                                                try { t.click(); } catch(_){ }
                                                return { clicked: true, source: 'modal.verify', details };
                                            }
                                            return { clicked: false, source: '', details };
                                        });
                                    } catch {}
                                    try { log('DEBUG', `🔎 [Modal] dialogs=${String(info2 && info2.details && info2.details.dialogs || 0)} candidates=${String(info2 && info2.details && info2.details.candidates || 0)} matched=${String(info2 && info2.details && info2.details.matched || false)} text=${String(info2 && info2.details && info2.details.text || '')} aria=${String(info2 && info2.details && info2.details.aria || '')}`); } catch {}
                                    if (info2 && info2.clicked) { clicked = true; continue; }
                                    if (!clicked) {
                                        try { await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); } catch {}
                                    }
                                    if (!clicked) {
                                        try {
                                            const handle = await page.evaluateHandle(() => {
                                                const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                                                const btns = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], [aria-label]'));
                                                let t = btns.find(b => /verify payment method|verifier payment method|verify card|verifier la carte|verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.textContent)));
                                                if (!t) t = btns.find(b => /verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.getAttribute('aria-label'))));
                                                if (!t) {
                                                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal'));
                                                    const scope = dialogs.length ? dialogs[0] : document;
                                                    const cand = Array.from(scope.querySelectorAll('button, [role="button"], a[role="button"], [aria-label]')).find(b => {
                                                        const label = norm(b.textContent) || norm(b.getAttribute('aria-label'));
                                                        const bg = getComputedStyle(b).backgroundColor || '';
                                                        return /verify|verifier|verificar|verifica|验证|确认/i.test(label) || /rgb\(24,\s*119,\s*242\)/i.test(bg);
                                                    });
                                                    t = cand || t;
                                                }
                                                if (t) { try { t.scrollIntoView({ block: 'center' }); } catch(_){} }
                                                return t || null;
                                            });
                                            if (handle && handle.asElement()) {
                                                try { await page.evaluate(el => { try { el.scrollIntoView({ block: 'center' }); } catch(_){} }, handle); } catch {}
                                                const box = await handle.boundingBox();
                                                if (box) {
                                                    await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                                    await page.mouse.down();
                                                    await new Promise(r => setTimeout(r, ));
                                                    await page.mouse.up();
                                                    clicked = true;
                                                    try { log('DEBUG', `🖱️ [Mouse] x=${Math.round(box.x + box.width/2)} y=${Math.round(box.y + box.height/2)} w=${Math.round(box.width)} h=${Math.round(box.height)}`); } catch {}
                                                }
                                                try { await handle.dispose(); } catch {}
                                            }
                                        } catch {}
                                    }
                                    if (!clicked) {
                                        try {
                                            const rect = await page.evaluate(() => {
                                                const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                                                if (!dlg) return null;
                                                const r = dlg.getBoundingClientRect();
                                                return { left: r.left, top: r.top, width: r.width, height: r.height };
                                            });
                                            if (rect && rect.width && rect.height) {
                                                const x = rect.left + rect.width - 60;
                                                const y = rect.top + rect.height - 40;
                                                await page.mouse.move(x, y);
                                                await page.mouse.down();
                                                await new Promise(r => setTimeout(r, ));
                                                await page.mouse.up();
                                                clicked = true;
                                                try { log('DEBUG', `🖱️ [Corner] x=${Math.round(x)} y=${Math.round(y)} rect=${JSON.stringify(rect)}`); } catch {}
                                            }
                                        } catch {}
                                    }
                                    try {
                                        const frames = page.frames();
                                        for (const f of frames) {
                                            try {
                                                const u = String(f.url() || '');
                                                if (/payments\.facebook\.com\/business_payments\/wizard|business_payments\/verification/i.test(u)) {
                                                    const marked = await f.evaluate(() => {
                                                        const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                                                        const btns = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], [aria-label]'));
                                                        let t = btns.find(b => /verify|verifier|verificar|verifica|continue|下一步|继续|确认/i.test(norm(b.textContent)));
                                                        if (!t) t = btns.find(b => /verify|verifier|verificar|verifica|continue|下一步|继续|确认/i.test(norm(b.getAttribute('aria-label'))));
                                                        if (t) { try { t.setAttribute('data-auto-click-target','1'); t.scrollIntoView({ block:'center' }); } catch(_){}; return { matched: true, text: (t.textContent||'').trim(), aria: (t.getAttribute('aria-label')||'') }; }
                                                        return { matched: false };
                                                    });
                                                    try { log('DEBUG', `🔎 [Iframe] url=${u} matched=${String(marked && marked.matched || false)} text=${String(marked && marked.text || '')} aria=${String(marked && marked.aria || '')}`); } catch {}
                                                    if (marked && marked.matched) {
                                                        const h = await f.$('[data-auto-click-target="1"]');
                                                        if (h) {
                                                            const box = await h.boundingBox();
                                                            if (box) {
                                                                await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                                                await page.mouse.down();
                                                                await new Promise(r => setTimeout(r, ));
                                                                await page.mouse.up();
                                                                clicked = true; break;
                                                            }
                                                        }
                                                    }
                                                }
                                            } catch {}
                                        }
                                    } catch {}
                                }
                                try {
                                    if (clicked) {
                                        try { await Promise.race([
                                            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(()=>{}),
                                            new Promise(r => setTimeout(r, 1200))
                                        ]); } catch {}
                                    }
                                    
                                    log('INFO', `🔎 点击验证: clicked=${clicked}`);
                                    try { await captureScreenshot(page, profileId, clicked ? 'clicked-final' : 'not-clicked-final'); } catch {}
                                } catch {}
                            }
                        }
                */
            // 网络诊断

            // 🕒 awaitLogin：调用方（队列的「获取信息」）要求「等登录校验/自动登录跑完再返回」——
            //    否则取数会抢在 AutoLogin 还没结束时就开跑，拿回来一片空（「获取信息」空结果的主要来源）。
            //    上限 100s 兜底：LaunchQueue 的任务超时是 120s（LAUNCH_TASK_TIMEOUT），别让等待把它顶穿。
            // 🔐 顺带把登录结论带出去（loginOk）：等了才有值，null 表示本次没等/无从判断。
            //    调用方据此决定「还要不要继续后续动作」—— 没登录成功就别白跑取数、白占槽位。
            let loginOk = null;
            if (awaitLogin && loginFlowPromise) {
                const _waitT0 = Date.now();
                try { await Promise.race([loginFlowPromise, new Promise(r => setTimeout(r, 100000))]); } catch {}
                try { loginOk = !!(getLoginState(profileId) || {}).loggedIn; } catch { loginOk = false; }
                log('INFO', `⏳ [Launch] 已等待登录流程结束（awaitLogin）：profileId=${profileId}，耗时=${Date.now() - _waitT0}ms，loggedIn=${loginOk}`);
            }

            return {
                profileId,
                debugPort: config.debugPort,
                startTime: browserInstance.createdAt,
                userAgent: config.userAgent,
                proxyConfig: proxy,
                loginOk
            };
        }, 0, async () => {
            // 🔥 队列超时：关掉本次任务已启动的浏览器进程，避免僵尸占着端口/profile 目录影响后续启动
            const inst = _launchTaskBrowser;
            _launchTaskBrowser = null;
            // 🔓 队列超时：释放端口预留，避免端口被永久占用
            releaseDebugPort(_allocatedDebugPort);
            _allocatedDebugPort = null;
            if (!inst || !inst.browser) return;
            log('WARN', `🧹 [LaunchQueue] 超时清理：关闭 profileId=${profileId} 的浏览器实例`);
            logBrowserClose(profileId, `启动队列任务超时(${launchQueueManager.taskTimeout}ms)清理实例`, 'LaunchQueue/超时清理');
            try {
                // 最多等 5 秒优雅关闭；卡死的 Chrome 不会响应 CDP，超时后直接杀进程
                await Promise.race([inst.browser.close(), new Promise(r => setTimeout(r, 5000))]);
            } catch {}
            try { if (inst.browser.isConnected()) inst.browser.process?.()?.kill?.(); } catch {}
            try { if (activeBrowsers.get(String(profileId))?.browser === inst.browser) activeBrowsers.delete(String(profileId)); } catch {}
        });

        const launchTime = Date.now() - startTime;
        _totalLaunchTime += launchTime;
        _successCount++;

        // 🐛 以前用 console.log：只写控制台、不写 service.log，导致批量操作里
        //    "启动到底完没完、花了多久"在日志里查不到（只能看到"开始启动"没有下文）
        log('INFO', `✅ 浏览器启动成功: ${profileId} (${launchTime}ms)`);
        // ⚠️ 「启动成功」只代表浏览器进程起来了，**不代表已登录**：
        //    · 默认调用（不带 awaitLogin）：登录验证在后台跑，结论只走日志 + 云端登录状态字段；
        //    · 带 awaitLogin 的调用（队列「获取信息」）：响应里会带 loginOk(true/false)，
        //      调用方拿不到登录态就别再跑后续动作（取数必然空，还白占浏览器和槽位）。
        _launchInFlightProfiles.delete(String(profileId)); // 启动流程完成，放行后续请求（复用检查会接管）
        return res.json({
            success: true,
            message: '浏览器启动成功',
            data: result,
            loginOk: (result && typeof result.loginOk === 'boolean') ? result.loginOk : null,
            launchTime,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        _pendingBrowserCount = Math.max(0, _pendingBrowserCount - 1);
        // 🔓 启动失败：释放端口预留，避免该端口被永久占用
        releaseDebugPort(_allocatedDebugPort);
        _allocatedDebugPort = null;
        _launchInFlightProfiles.delete(String(profileId)); // 启动失败也要放行，否则该配置会被永久锁住无法再启动
        log('ERROR', `❌ 浏览器启动失败: profileId=${profileId}, 耗时=${Date.now() - startTime}ms, 原因=${String(error && error.message || error)}`);
        return res.status(500).json({ success: false, message: '浏览器启动失败', error: String(error && error.message || error) });
    }
});


// 🛑 停止浏览器端点
_app.post('/api/stop-browser', async (req, res) => {
    const { profileId } = req.body;
    // 🔻 关闭前先记下「是不是借用型」+ 调用方声明的原因（releaseBorrowedBrowser 会把它从借用表里摘掉）
    const _stopWasBorrowed = (() => { try { return isBorrowedBrowser(profileId); } catch { return false; } })();
    const _stopReason = String((req.body && req.body.reason) || '') || '调用方主动关闭(未注明原因)';
    const _stopBy = String((req.body && req.body.by) || '') || `${req.method} /api/stop-browser`;

    // 🪶 主动归还：清掉借用型浏览器的兜底回收定时器（无论下面关成功与否，都不再需要它）
    try { releaseBorrowedBrowser(profileId); } catch {}

    try {
        const browserData = activeBrowsers.get(profileId);
        if (!browserData) {
            return res.status(404).json({
                success: false,
                message: '未找到运行中的浏览器实例'
            });
        }

        // 关闭浏览器
        if (browserData.browser && browserData.browser.isConnected()) {
            logBrowserClose(profileId, _stopReason, _stopBy, `借用型=${_stopWasBorrowed}`);
            await browserData.browser.close();
        }

        // 🐛 修复 Windows 下 Chrome 进程残留：浏览器 close 后子进程可能未完全退出，导致 userDataDir 仍被占用
        if (browserData.browser) {
            try {
                const proc = browserData.browser.process();
                if (proc && !proc.killed) {
                    const pid = proc.pid;
                    if (pid) {
                        try { process.kill(pid, 'SIGKILL'); } catch {}
                        // Windows 下使用 taskkill /F /T 强制结束所有子进程
                        if (process.platform === 'win32') {
                            try { require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 }); } catch {}
                        }
                    }
                }
            } catch {}
        }

        // 从活跃列表中移除
        activeBrowsers.delete(profileId);

        console.log(`🛑 浏览器已停止: ${profileId}`);

        res.json({
            success: true,
            message: '浏览器停止成功',
            profileId,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(`❌ 停止浏览器失败: ${profileId}`, error);
        
        res.status(500).json({
            success: false,
            message: '停止浏览器失败',
            error: error.message,
            profileId,
            timestamp: new Date().toISOString()
        });
    }
});


// 🔄 重启浏览器端点
_app.post('/api/restart-browser', async (req, res) => {
    const { profileId } = req.body;
    
    try {
        // 先停止
        const stopResult = await new Promise((resolve) => {
            const mockReq = { body: { profileId } };
            const mockRes = {
                status: () => mockRes,
                json: resolve
            };
            // 调用停止逻辑 (简化版)
        });

        // 等待一秒
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 重新启动 (需要完整的配置信息)
        res.json({
            success: true,
            message: '浏览器重启成功，请重新发送启动请求',
            profileId,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(`❌ 重启浏览器失败: ${profileId}`, error);
        
        res.status(500).json({
            success: false,
            message: '重启浏览器失败',
            error: error.message,
            profileId,
            timestamp: new Date().toISOString()
        });
    }
});


// 📋 获取活跃浏览器列表
_app.get('/api/browsers', (req, res) => {
    const browsers = Array.from(activeBrowsers.entries()).map(([profileId, data]) => ({
        profileId,
        debugPort: data.debugPort,
        startTime: data.startTime,
        uptime: Date.now() - data.startTime,
        proxy: data.proxy ? `${data.proxy.host}:${data.proxy.port}` : null,
        userAgent: data.userAgent ? data.userAgent.substring(0, 50) + '...' : null
    }));

    res.json({
        success: true,
        data: browsers,
        count: browsers.length,
        timestamp: new Date().toISOString()
    });
});


// 🍪 验证浏览器Cookie端点
_app.post('/api/validate-cookies', async (req, res) => {
    const { profileId } = req.body;
    
    try {
        console.log(`🔍 开始验证 Profile ${profileId} 的Cookie...`);
        
        // 从activeBrowsers获取浏览器实例
        const browserData = activeBrowsers.get(profileId);
        if (!browserData) {
            return res.status(404).json({
                success: false,
                profileId,
                status: 'not_found',
                message: '未找到运行中的浏览器实例',
                cookies: []
            });
        }
        
        const { browser } = browserData;
        
        // 检查浏览器连接状态
        if (!browser || !browser.isConnected()) {
            return res.json({
                success: false,
                profileId,
                status: 'disconnected',
                message: '浏览器实例已断开连接',
                cookies: []
            });
        }
        
        // 获取所有页面
        const pages = await browser.pages();
        
        if (pages.length === 0) {
            return res.json({
                success: true,
                profileId,
                status: 'no_pages',
                message: '浏览器中没有打开的页面',
                totalCookies: 0,
                cookies: [],
                analysis: {
                    total: 0,
                    domains: [],
            
                    importantCookies: [],
                    sessionCookies: 0,
                    persistentCookies: 0
                }
            });
        }
        
        // 使用第一个页面进行验证
        const page = pages[0];
        const url = page.url();
        
        // 获取所有Cookie
        const cookies = await page.cookies();
        const authToken = browserData ? browserData.authToken : null;
        try { await syncCookiesToStorage(profileId, cookies, authToken); } catch {}
        
        // 分析Cookie
        const analysis = {
            total: cookies.length,
            domains: new Set(),
    
            importantCookies: [],
            sessionCookies: 0,
            persistentCookies: 0
        };
        
        // 重要Cookie名称
        const importantCookieNames = ['c_user', 'xs', 'datr', 'sb', 'fr', 'wd', 'presence'];
        
        cookies.forEach(cookie => {
            // 统计域名
            analysis.domains.add(cookie.domain);
            
            // 检查重要Cookie
            if (importantCookieNames.includes(cookie.name)) {
                analysis.importantCookies.push(cookie.name);
            }
            
            // 统计Cookie类型
            if (cookie.expires && cookie.expires > 0) {
                analysis.persistentCookies++;
            } else {
                analysis.sessionCookies++;
            }
        });
        
        analysis.domains = Array.from(analysis.domains);
        
        console.log(`✅ Profile ${profileId} Cookie验证完成: ${cookies.length}个Cookie`);
        
        res.json({
            success: true,
            profileId,
            status: 'success',
            url,
            totalCookies: cookies.length,
            cookies: cookies.map(cookie => ({
                name: cookie.name,
                value: cookie.value.substring(0, 20) + '...',
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly
            })),
            analysis,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`❌ 验证 Profile ${profileId} Cookie失败:`, error.message);
        
        res.status(500).json({
            success: false,
            profileId,
            status: 'error',
            message: `验证失败: ${error.message}`,
            cookies: [],
            timestamp: new Date().toISOString()
        });
    }
});

_app.post('/api/facebook/check-login', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        if (!profileId) return res.status(400).json({ success: false, message: 'missing_profileId' });
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: true, loggedIn: false, reason: 'no_browser' });
        }
        const pages = await browserData.browser.pages();
        const page = pages[0] || await browserData.browser.newPage();
        // 🐛 不只看 cookie，导航到 Facebook 首页检查页面内容判断是否真实登录
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        let hasFeed = false, hasLoginForm = false, hasCUser = false, hasCheckpoint = false;
        try {
            // 🛡️ 人机验证：FB 会把人带到 facebook.com/checkpoint/...，只认 URL（可靠，不去猜页面文案，免得误判）
            hasCheckpoint = /\/checkpoint\b/i.test(String(page.url() || ''));
            const html = (await page.content().catch(() => '')).toLowerCase();
            hasFeed = html.includes('role="feed"') || html.includes("what's on your mind") || html.includes('你有什么新鲜事');
            hasLoginForm = html.includes('input name="email"') || html.includes('input name="pass"') || html.includes('log in') || html.includes('登录');
            try { const cks = await page.cookies(); hasCUser = cks.some(c => c.name === 'c_user'); } catch {}
        } catch {}
        const loggedIn = !hasCheckpoint && (hasFeed || (!hasLoginForm && hasCUser));
        // 🔐 登录状态三档，checkpoint 优先于 invalid：人机验证时 Cookie 往往是好的，
        //    只是要人去过验证，记成 invalid 会误导用户去重新登号。
        const loginStatus = loggedIn ? 'ok' : (hasCheckpoint ? 'checkpoint' : 'invalid');
        log('INFO', `[check-login] profileId=${profileId} feed=${hasFeed} loginForm=${hasLoginForm} cUser=${hasCUser} checkpoint=${hasCheckpoint} => loggedIn=${loggedIn} loginStatus=${loginStatus}`);
        // 🔐 这是一次真实的登录态判定，登记下来供 Cookie 同步闸门使用
        markLoginState(profileId, loggedIn);
        return res.json({ success: true, loggedIn, loginStatus, userId: null, detail: { hasFeed, hasLoginForm, hasCUser, hasCheckpoint } });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

_app.post('/api/facebook/auto-login', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        if (!profileId) return res.status(400).json({ success: false, message: 'missing_profileId' });
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            // 无活跃浏览器，先启动
            const launchRes = await fetch(`http://localhost:${_PORT}/launch-browser`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': _API_SECRET },
                body: JSON.stringify({ profileId })
            }).catch(() => null);
            if (!launchRes) return res.json({ success: false, message: 'launch_browser_failed' });
            await new Promise(r => setTimeout(r, 5000));
        }
        const bd2 = activeBrowsers.get(profileId);
        if (!bd2 || !bd2.browser || !bd2.browser.isConnected()) {
            return res.json({ success: false, message: 'browser_not_ready' });
        }
        const pages = await bd2.browser.pages();
        const page = pages[0] || await bd2.browser.newPage();
        // 导航到 Facebook 触发自动登录
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        // 构建最小 profile 对象供 autoFillPasswordOnPage 使用
        const p = await findProfileById(profileId);
        if (p) {
            await autoFillPasswordOnPage(page, p, profileId);
        } else {
            log('WARN', `⚠️ [Profile=${profileId}] auto-login: 未找到 profile 配置，仅导航到登录页`);
        }
        return res.json({ success: true, message: 'auto_login_triggered' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

_app.post('/api/facebook/asset-summary', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        if (!profileId) return res.status(400).json({ success: false, message: 'missing_profileId' });
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: true, assetCount: null, status: 'no_browser' });
        }
        const page = await browserData.browser.newPage();
        try {
            // 🍪 先到 Ads Manager —— EAA token 只存在于这个页面的 script 里，首页取不到
            await page.goto('https://business.facebook.com/adsmanager/manage/accounts', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            // 🚀 改用 Graph API 取真实资产：以前是数 [role="row"] 的 DOM 行数 ——
            //    既受页面渲染/虚拟滚动影响不准，也拿不到广告号 id、余额、限额。
            const r = await graphApiProbe(profileId, page,
                'me/adaccounts?fields=id,account_id,name,account_status,currency,balance,amount_spent,adtrust_dsl,business{id,name},owner{id,name}&limit=1000&sort=name_ascending',
                'asset-summary');
            if (!r.ok) {
                return res.json({ success: true, assetCount: null, status: r.error === 'no_token' ? 'no_token' : 'graph_error', error: r.error });
            }
            const list = Array.isArray(r.data && r.data.data) ? r.data.data : [];
            return res.json({
                success: true,
                status: 'ok',
                loggedIn: true,
                assetCount: list.length,
                accounts: list.map(a => ({
                    id: a.id,
                    account_id: a.account_id,
                    name: a.name,
                    account_status: a.account_status,
                    currency: a.currency,
                    balance: a.balance,
                    amount_spent: a.amount_spent,
                    // 💰 限额：广告工具箱用的就是 adtrust_dsl（-1 = 无限制）
                    spend_cap: a.adtrust_dsl,
                    business: a.business ? { id: a.business.id, name: a.business.name } : null,
                    owner: a.owner ? { id: a.owner.id, name: a.owner.name } : null,
                })),
            });
        } finally {
            try { await page.close(); } catch {}
        }
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

_app.post('/api/facebook/bm-info', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: true, businessId: null, status: 'no_browser' });
        }
        const page = await browserData.browser.newPage();
        try {
            // 🍪 先到 Business Suite —— EAA token 只存在于这个页面的 script 里
            await page.goto('https://business.facebook.com/settings/business_info', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            // 🚀 改用 Graph API 取 BM 状态：以前是从 URL query / DOM 文本里"猜" business_id，
            //    经常猜不到（页面改版就失效），也拿不到 BM 是否被限制、验证状态、名下的广告号/主页/成员。
            const r = await graphApiProbe(profileId, page,
                'me/businesses?fields=id,name,is_disabled_for_integrity_reasons,can_use_extended_credit,verification_status,timezone_id,owned_ad_accounts.limit(100){id,account_id,name,account_status},client_ad_accounts.limit(500){id,account_id,name,account_status,owner_business{id,name}},owned_pages.limit(100){id,name},client_pages.limit(100){id,name},business_users.limit(100){id,name,email,role,active_status},pending_users.limit(100){id,email,role,status}&limit=100',
                'bm-info');
            if (!r.ok) {
                return res.json({ success: true, businessId: null, status: r.error === 'no_token' ? 'no_token' : 'graph_error', error: r.error });
            }
            const list = Array.isArray(r.data && r.data.data) ? r.data.data : [];
            const businesses = list.map(b => ({
                id: b.id,
                name: b.name,
                disabled_for_integrity: !!b.is_disabled_for_integrity_reasons,
                can_use_extended_credit: !!b.can_use_extended_credit,
                verification_status: b.verification_status,
                timezone_id: b.timezone_id,
                owned_ad_accounts: (b.owned_ad_accounts && b.owned_ad_accounts.data) || [],
                client_ad_accounts: (b.client_ad_accounts && b.client_ad_accounts.data) || [],
                owned_pages: (b.owned_pages && b.owned_pages.data) || [],
                client_pages: (b.client_pages && b.client_pages.data) || [],
                business_users: (b.business_users && b.business_users.data) || [],
                pending_users: (b.pending_users && b.pending_users.data) || [],
            }));
            return res.json({
                success: true,
                status: 'ok',
                loggedIn: true,
                businessId: businesses.length ? businesses[0].id : null, // 兼容旧字段
                count: businesses.length,
                businesses,
            });
        } finally {
            try { await page.close(); } catch {}
        }
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

_app.post('/api/facebook/adaccounts/sync', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: true, saved: 0, status: 'no_browser' });
        }
        const page = await browserData.browser.newPage();
        let accounts = [];
        try {
            await page.goto('https://business.facebook.com/adsmanager/manage/accounts', { waitUntil: 'networkidle2', timeout: 20000 });
            accounts = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('[role="row"]'));
                const list = [];
                rows.forEach(r => {
                    const nameEl = r.querySelector('[role="gridcell"], a, span');
                    const name = nameEl ? (nameEl.textContent || '').trim() : '';
                    const linkEl = r.querySelector('a[href*="act="]');
                    let id = null;
                    if (linkEl && linkEl.getAttribute('href')) {
                        const href = linkEl.getAttribute('href');
                        const m = href.match(/act[_=](\d{6,})/i);
                        if (m) id = m[1];
                    }
                    if (name || id) list.push({ name, account_id: id });
                });
                return list;
            });
        } catch(_){ }
        try { await page.close(); } catch(_){ }
        const saved = await new Promise(async (resolve, reject) => {
            const sdb = new sqlite3.Database(dbPath);
            try {
                await ensureAdAccountsTable(sdb);
                let count = 0;
                for (const a of accounts) {
                    await new Promise((rj, rsv) => {
                        const sql = `INSERT OR REPLACE INTO ad_accounts (
                            id, profile_id, platform, account_id, name, status, currency, timezone_id, spend, updated_at
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                        )`;
                        const idv = String(a.account_id || `${Date.now()}_${Math.random().toString(36).slice(2)}`);
                        const args = [idv, String(profileId || ''), 'Meta (Facebook/Instagram)', String(a.account_id || ''), String(a.name || ''), 'Unknown', '', '', 0];
                        sdb.run(sql, args, err => (err ? rj(err) : rsv()));
                    }).then(()=>{ count++; });
                }
                sdb.close(() => resolve(count));
            } catch (e) {
                try { sdb.close(() => reject(e)); } catch { reject(e); }
            }
        });

        // 🚀 同步广告账户到远程存储（sync handler 缺失）
        if (accounts.length > 0) {
            try {
                const sBase = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
                const apiSecret = process.env.PUPPETEER_API_SECRET || '';
                const items = accounts.map(a => ({
                    id: `act_${a.account_id}`,
                    account_id: a.account_id,
                    name: a.name || '',
                    account_status: 'Unknown',
                    currency: '',
                    timezone_id: '',
                    business_country_code: '',
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

        return res.json({ success: true, saved });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// 临时诊断：查看当前页面所有按钮文字
_app.post('/api/browser/diagnose', async (req, res) => {
    try {
        const pid = String(req.body?.profileId || '');
        const browserData = activeBrowsers.get(pid);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) return res.json({ success: false, message: 'no_browser' });
        const pages = await browserData.browser.pages();
        const page = pages.find(p => p.url().includes('facebook.com')) || browserData.currentPage;
        if (!page) return res.json({ success: false, message: 'no_page' });
        const result = await page.evaluate(() => {
            // 所有按钮
            const allBtns = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], a'));
            const btnTexts = allBtns.map(b => ({ text: (b.textContent || '').trim().substring(0, 50), cls: (b.className || '').substring(0, 30), id: b.id || '', href: (b.getAttribute('href') || '').substring(0, 30) })).filter(b => b.text || b.href);
            // 所有下拉框
            const selects = Array.from(document.querySelectorAll('select, [role="listbox"], [role="combobox"]'));
            const selectInfo = selects.map(s => ({ aria: s.getAttribute('aria-label') || '', name: s.getAttribute('name') || '', id: s.id || '', html: (s.outerHTML || '').substring(0, 200) }));
            // 弹窗
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
            const dialogInfo = dialogs.map(d => ({ text: (d.textContent || '').substring(0, 300) }));
            // 当前URL
            return { url: window.location.href, btns: btnTexts.slice(0, 30), selects: selectInfo.slice(0, 10), dialogs: dialogInfo.slice(0, 3) };
        });
        return res.json({ success: true, url: result.url, buttons: result.btns, selects: result.selects, dialogs: result.dialogs });
    } catch (e) { return res.json({ success: false, message: e.message }); }
});


    // 🚀 启动Puppeteer浏览器端点 (兼容enhanced.html的API调用)
// 路由已在上方定义 (1726行)，此处不再重复定义
_app.post('/api/browser/launch-puppeteer', async (req, res) => {
    const startTime = Date.now();
    launchCount++;
    
    // 捕获授权令牌，用于后续同步
    const authToken = req.headers['authorization'] || req.headers['Authorization'];
    
    const { profileId, profile, proxy, startUrls, cookies, userAgent, executablePath, userDataDir, url, startUrl, chrome115Config } = req.body;
    
    // 🏷️ 提取窗口标题配置，如果未提供则在下方获取 Profile 后补全
    let windowTitle = chrome115Config?.windowTitle;
    
    // 📁 从文件读取完整的配置信息
    let finalProfile = profile;
    let finalProxy = proxy;
    let finalUserAgent = userAgent;
    
    try {
        const dbProfileLoaded = await findProfileById(profileId);
        if (dbProfileLoaded) {
            console.log(`📁 找到配置卡片 ${profileId}，使用数据库中的配置信息`);
            finalProfile = dbProfileLoaded;
            finalProxy = dbProfileLoaded.proxy || proxy;
            finalUserAgent = finalProfile.userAgent || userAgent;
            // 💡 补全窗口标题
            if (!windowTitle) windowTitle = finalProfile.name || `Profile ${profileId}`;
            console.log(`🔑 账号: ${finalProfile.account || '未设置'}`);
            console.log(`🔑 密码状态: ${finalProfile.accountPassword ? '已设置' : '未设置'}`);
            console.log(`🌐 代理设置: ${finalProxy ? JSON.stringify(finalProxy) : '未设置'}`);
            console.log(`🔧 用户代理: ${finalUserAgent || '默认'}`);
        } else {
            console.log(`⚠️ 配置卡片 ${profileId} 在文件中未找到，使用传递的参数`);
        }
    } catch (error) {
        console.error(`❌ 读取配置卡片 ${profileId} 失败:`, error.message);
        console.log(`⚠️ 使用传递的参数作为备用`);
    }
    
    // 🔧 支持多种URL参数格式
    let finalStartUrls = startUrls;
    if (!finalStartUrls && (url || startUrl)) {
        finalStartUrls = [url || startUrl];
    }
    
    // 🔧 调试端口：未指定时在队列任务内自动分配（与 /api/launch-browser 一致），避免并发启动撞端口
    let debugPort = req.body.debugPort || null;
    if (debugPort) console.log(`🔧 使用指定调试端口: ${debugPort}`);
    // 🔒 本次任务分配的端口预留：成功/失败/超时都要释放，否则端口会被永久占用
    let _allocatedDebugPort = null;
    
    try {
        console.log(`🚀 启动Puppeteer浏览器配置 ${profileId}...`);
        console.log(`🌐 接收到的启动网站:`, finalStartUrls);

        // 🧹 供队列超时清理引用：只关掉本次任务启动的那个浏览器实例，避免误杀其它
        let _launchTaskBrowser = null;

        // 使用启动队列管理并发
        const result = await launchQueueManager.add(async () => {
            // 📡 未指定端口时自动分配（带预留，批量并发启动不会撞端口）
            if (!debugPort) {
                debugPort = await getAvailableDebugPort(9222);
                _allocatedDebugPort = debugPort;
                console.log(`📡 自动分配调试端口: ${debugPort}`);
            }
            // 配置浏览器参数
            const config = {
                profileId,
                executablePath,
                userDataDir,
                debugPort,
                proxy: finalProxy,
                userAgent: finalUserAgent,
                windowTitle: windowTitle, // 🏷️ 添加窗口标题配置
                emailPrefix: extractEmailPrefix(finalProfile?.accountEmail || finalProfile?.account_email)
            };
            try {
                const urls = finalStartUrls || [];
                config.storeOptimized = urls.some(u => /chrome\.google\.com|webstore|extensions\//i.test(String(u)));
            } catch {}

            // 🔧 计算实际的用户数据目录（优先使用邮箱前缀+profileId的统一规则）
            const actualUserDataDir = browserManager.getUnifiedUserDataDir(profileId, userDataDir, config.emailPrefix);
            
            // 🍪 解析Cookie数据（不再预注入到数据库，改为动态注入）
            let parsedCookies = null;
            if (cookies && (typeof cookies === 'string' ? cookies.trim().length > 0 : cookies.length > 0)) {
                console.log(`🍪 检测到Cookie数据，准备动态注入...`);
                console.log(`🍪 Cookie数据类型: ${typeof cookies}, 内容预览: ${typeof cookies === 'string' ? cookies.substring(0, 100) : `${cookies.length} 个cookie对象`}`);
                
                try {
                    // 解析Cookie数据
                    parsedCookies = cookies;
                    if (typeof cookies === 'string') {
                        parsedCookies = parseCookieString(cookies, startUrls);
                        console.log(`🔧 Cookie字符串解析结果: ${parsedCookies.length} 个cookie`);
                    }
                    
                    if (parsedCookies && parsedCookies.length > 0) {
                        console.log(`✅ Cookie解析完成: ${parsedCookies.length} 个cookie，将在页面加载时动态注入`);
                    } else {
                        console.log(`ℹ️ 解析后没有有效的Cookie数据`);
                        parsedCookies = null;
                    }
                } catch (cookieError) {
                    console.warn(`⚠️ Cookie解析失败:`, cookieError.message);
                    parsedCookies = null;
                }
            } else {
                console.log(`ℹ️ 没有Cookie数据需要注入，尝试从存储服务加载...`);
                try {
                    const fromStorage = await getCookiesFromStorage(profileId);
                    if (Array.isArray(fromStorage) && fromStorage.length) {
                        parsedCookies = fromStorage;
                        console.log(`✅ 从存储服务加载到 ${parsedCookies.length} 个Cookie`);
                    }
                } catch (e) {
                    console.log(`⚠️ 从存储服务加载Cookie失败: ${String(e && e.message || e)}`);
                }
            }

            // 获取或创建浏览器实例
            const browserInstance = await browserManager.getBrowser(config);
            _launchTaskBrowser = browserInstance;
            browserInstance.lastUsed = Date.now();

            // 已移除：启动后清理初始页面逻辑



            // 存储活跃浏览器
            activeBrowsers.set(profileId, {
                browser: browserInstance.browser,
                profileId,
                authToken, // 🚀 关键：保存令牌以供后续同步使用
                startTime: Date.now(),
                debugPort,
                proxy: finalProxy,
                userAgent: config.userAgent,
                fbLanguage: config.fbLanguage || 'en_US' // 🐛 保存语言设置
            });
            // 🔓 启动完成：Chrome 已绑定该端口，后续由 isDebugPortOccupied 兜住，撤销预留即可
            releaseDebugPort(_allocatedDebugPort);
            _allocatedDebugPort = null;

            // 处理启动网站
            if (finalStartUrls && finalStartUrls.length > 0) {
                console.log(`🌐 准备打开启动网站: ${finalStartUrls.join(', ')}`);
                
                // 创建新标签页打开网站
                for (const url of finalStartUrls.slice(0, 3)) { // 限制最多3个网站
                    try {
                            const page = await browserInstance.browser.newPage();
                            try { attachCookieSync(page, profileId); } catch {}
                        
                        // 设置页面级别的配置：与主页面使用同一套画像
                        try { await browserManagerModule.applyStealthToPage(page, browserManagerModule.getFingerprint(profileId, config.profile), 'launch-page'); } catch {}
                        
                        // 🍪 动态注入Cookie（在导航之前）
                        if (parsedCookies && parsedCookies.length > 0) {
                            console.log(`🍪 开始为页面 ${url} 动态注入 ${parsedCookies.length} 个Cookie...`);
                            
                            // 先导航到目标域名的空白页面以建立正确的上下文
                            try {
                                const targetUrl = new URL(url);
                                const blankUrl = `${targetUrl.protocol}//${targetUrl.host}`;
                                console.log(`🔧 先导航到空白页面建立域名上下文: ${blankUrl}`);
                                await page.goto(blankUrl, { waitUntil: 'networkidle2', timeout: 10000 });
                            } catch (blankNavError) {
                                console.warn(`⚠️ 导航到空白页面失败，直接注入Cookie: ${blankNavError.message}`);
                            }
                            
                            // 逐个注入Cookie
                            let injectedCount = 0;
                            for (const cookie of parsedCookies) {
                                try {
                                    // 构建符合CDP格式的Cookie对象（域名归一化，避免 host-only 的 facebook.com 送不到 www/business）
                                    const cdpCookie = {
                                        name: cookie.name,
                                        value: cookie.value,
                                        domain: normalizeFbDomain(cookie.domain),
                                        path: cookie.path || '/',
                                        secure: cookie.secure || false,
                                        httpOnly: cookie.httpOnly || false,
                                        sameSite: cookie.sameSite || 'Lax'
                                    };
                                    
                                    // ⏳ 只补「必须补」的两类（与上面的 CDP 注入分支保持同一口径）：
                                    //    · 会话级 cookie（c_user/xs 等没有到期时间）会被浏览器在退出时丢弃，必须补上到期时间；
                                    //    · Chrome 拿到「已过期的 expires」会静默丢弃该 cookie（不报错），所以也必须钳到未来；
                                    //    · 已有有效未来有效期的原样保留。
                                    const _nowSec = Math.floor(Date.now() / 1000);
                                    const _rawExp = Number(cookie.expires);
                                    cdpCookie.expires = (Number.isFinite(_rawExp) && _rawExp > _nowSec)
                                        ? Math.floor(_rawExp)
                                        : _nowSec + 36500 * 24 * 60 * 60;
                                    
                                    await page.setCookie(cdpCookie);
                                    injectedCount++;
                                    console.log(`✅ Cookie注入成功: ${cookie.name}=${cookie.value.substring(0, 20)}... (域名: ${cookie.domain})`);
                                } catch (cookieError) {
                                    console.warn(`⚠️ Cookie注入失败 ${cookie.name}:`, cookieError.message);
                                }
                            }
                            
                            console.log(`🍪 Cookie动态注入完成: ${injectedCount}/${parsedCookies.length} 成功`);
                            try { 
                                const browserData = activeBrowsers.get(profileId);
                                const currentAuthToken = browserData ? browserData.authToken : authToken;
                                await syncCookiesToStorage(profileId, parsedCookies, currentAuthToken); 
                            } catch {}
                            
                            // 验证Cookie是否成功注入
                            try {
                                const currentCookies = await page.cookies();
                                console.log(`🔍 注入后验证: 当前页面共有 ${currentCookies.length} 个Cookie`);
                                if (currentCookies.length > 0) {
                                    console.log(`✅ Cookie验证成功！前3个: ${currentCookies.slice(0, 3).map(c => c.name).join(', ')}`);
                                }
                            } catch (verifyError) {
                                console.warn(`⚠️ Cookie验证失败: ${verifyError.message}`);
                            }
                        }
                        
                        // 🔑 首先注入测试凭证到localStorage（在页面导航之前）
                        console.log('🔑 预先注入测试凭证到localStorage...');
                        try {
                            // 先导航到目标域名的空白页面以建立localStorage上下文
                            const targetUrl = new URL(url);
                            const blankUrl = `${targetUrl.protocol}//${targetUrl.host}`;
                            console.log(`🔧 先导航到空白页面建立localStorage上下文: ${blankUrl}`);
                            await page.goto(blankUrl, { waitUntil: 'networkidle2', timeout: 10000 });
                            
                            // 注入配置卡片凭证到localStorage
                            const credentialsResult = await page.evaluate((profile, targetUrl) => {
                                // 从配置卡片生成凭证数据
                                const targetDomain = new URL(targetUrl).hostname;
                                const testCredentials = {};
                                
                                // 如果配置卡片有账号密码，则为目标域名创建凭证
                                if (profile && profile.account && profile.accountPassword) {
                                    testCredentials[targetDomain] = [
                                        {
                                            id: `${profile.id}_${targetDomain}_001`,
                                            username: profile.account,
                                            password: profile.accountPassword,
                                            domain: targetDomain,
                                            url: targetUrl,
                                            createdAt: Date.now(),
                                            lastUsed: Date.now(),
                                            usageCount: 0,
                                            isActive: true
                                        }
                                    ];
                                    
                                    console.log(`✅ 为域名 ${targetDomain} 创建配置卡片凭证: ${profile.account}`);
                                } else {
                                    console.log('⚠️ 配置卡片中没有账号密码信息，跳过凭证创建');
                                    return { success: false, error: '配置卡片中没有账号密码信息' };
                                }
                                
                                // 将凭证保存到localStorage
                                try {
                                    localStorage.setItem('autoLoginCredentials', JSON.stringify(testCredentials));
                                    console.log('✅ 配置卡片凭证已注入到localStorage');
                                    console.log('📊 注入的凭证数据:', testCredentials);
                                    
                                    // 验证localStorage是否成功保存
                                    const saved = localStorage.getItem('autoLoginCredentials');
                                    const parsed = JSON.parse(saved);
                                    return { 
                                        success: true, 
                                        credentialsCount: Object.keys(testCredentials).length,
                                        savedData: parsed
                                    };
                                } catch (error) {
                                    console.error('❌ localStorage注入失败:', error.message);
                                    return { success: false, error: error.message };
                                }
                            }, profile, url);
                            
                            console.log('✅ 本地存储凭证注入结果:', credentialsResult);
                        } catch (localStorageError) {
                            console.error('❌ localStorage注入失败:', localStorageError.message);
                        }
                        
                        // 导航到目标网站
                        console.log(`🌐 导航到目标网站: ${url}`);
                        try {
                            await page.goto(url, { 
                                waitUntil: 'networkidle2',
                                timeout: 30000 
                            });
                            console.log(`✅ 已打开网站: ${url}`);
                            
                            // 🔐 自动填充密码（如果是登录页面）
                            try {
                                console.log(`🔐 尝试自动填充登录表单...`);
                                await autoFillPasswordOnPage(page, finalProfile, profileId);
                            } catch (autoFillError) {
                                console.warn(`⚠️ 自动填充失败: ${autoFillError.message}`);
                            }
                            
                            // 🔐 使用Chrome DevTools Protocol将配置卡片账号密码保存到浏览器原生密码管理器
                            try {
                                console.log('🔐 使用CDP将配置卡片账号密码保存到浏览器原生密码管理器...');
                                
                                // 从profile配置中获取账号密码信息（使用正确的字段名）
                                if (profile && profile.account && profile.accountPassword) {
                                    const currentDomain = new URL(url).hostname;
                                    console.log(`🔑 准备保存账号密码到域名: ${currentDomain}`);
                                    console.log(`🔑 账号: ${profile.account}`);
                                    console.log(`🔒 密码: ${'*'.repeat(profile.accountPassword.length)}`);
                                    
                                    // 等待页面完全加载
                                    await new Promise(resolve => setTimeout(resolve, 3000));
                                    try {
                                        await page.waitForNetworkIdle({ timeout: 5000 });
                                    } catch (e) {
                                        console.log('⚠️ 网络空闲等待超时，继续执行...');
                                    }
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                    
                                    // 获取CDP客户端
                                    const client = await page.target().createCDPSession();
                                    
                                    try {
                                        // 启用Runtime域
                                        await client.send('Runtime.enable');
                                        
                                        // 使用CDP直接将凭据保存到浏览器密码管理器
                                        const saveCredentialScript = `
                                            (async function() {
                                                try {
                                                    // 创建一个可见的表单来触发浏览器密码保存
                                                    const form = document.createElement('form');
                                                    form.method = 'post';
                                                    form.action = '${url}';
                                                    form.style.position = 'absolute';
                                                    form.style.top = '-9999px';
                                                    form.style.left = '-9999px';
                                                    form.style.opacity = '0';
                                                    form.style.pointerEvents = 'none';
                                                    
                                                    const usernameInput = document.createElement('input');
                                                    usernameInput.type = 'email';
                                                    usernameInput.name = 'username';
                                                    usernameInput.id = 'temp-username-' + Date.now();
                                                    usernameInput.value = '${profile.accountName || profile.account}';
                                                    usernameInput.autocomplete = 'username';
                                                    usernameInput.required = true;
                                                    
                                                    const passwordInput = document.createElement('input');
                                                    passwordInput.type = 'password';
                                                    passwordInput.name = 'password';
                                                    passwordInput.id = 'temp-password-' + Date.now();
                                                    passwordInput.value = '${profile.accountPassword}';
                                                    passwordInput.autocomplete = 'current-password';
                                                    passwordInput.required = true;
                                                    
                                                    const submitButton = document.createElement('button');
                                                    submitButton.type = 'submit';
                                                    submitButton.textContent = 'Login';
                                                    submitButton.id = 'temp-submit-' + Date.now();
                                                    
                                                    form.appendChild(usernameInput);
                                                    form.appendChild(passwordInput);
                                                    form.appendChild(submitButton);
                                                    document.body.appendChild(form);
                                                    
                                                    // 模拟真实的用户输入过程
                                                    usernameInput.focus();
                                                    
                                                    // 模拟逐字符输入用户名
                                                    usernameInput.value = '';
                                                    const username = '${profile.accountName || profile.account}';
                                                    for (let i = 0; i < username.length; i++) {
                                                        usernameInput.value += username[i];
                                                        usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                                                        await new Promise(resolve => setTimeout(resolve, 50));
                                                    }
                                                    usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
                                                    usernameInput.blur();
                                                    
                                                    await new Promise(resolve => setTimeout(resolve, 300));
                                                    
                                                    // 模拟逐字符输入密码
                                                    passwordInput.focus();
                                                    passwordInput.value = '';
                                                    const password = '${profile.accountPassword}';
                                                    for (let i = 0; i < password.length; i++) {
                                                        passwordInput.value += password[i];
                                                        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                                                        await new Promise(resolve => setTimeout(resolve, 50));
                                                    }
                                                    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
                                                    passwordInput.blur();
                                                    
                                                    await new Promise(resolve => setTimeout(resolve, 500));
                                                    
                                                    // 设置表单提交拦截器
                                                    let submitPrevented = false;
                                                    const preventSubmit = (e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        submitPrevented = true;
                                                        console.log('🔐 表单提交被拦截，触发密码保存检测');
                                                        return false;
                                                    };
                                                    
                                                    form.addEventListener('submit', preventSubmit, true);
                                                    
                                                    // 模拟更真实的用户交互序列
                                                    submitButton.focus();
                                                    
                                                    // 模拟鼠标悬停
                                                    submitButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                                                    await new Promise(resolve => setTimeout(resolve, 100));
                                                    
                                                    // 模拟鼠标按下和释放
                                                    submitButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                                                    await new Promise(resolve => setTimeout(resolve, 50));
                                                    submitButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                                                    
                                                    // 触发点击事件
                                                    submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                                                    
                                                    // 等待一小段时间，然后手动触发提交事件
                                                    await new Promise(resolve => setTimeout(resolve, 200));
                                                    
                                                    if (!submitPrevented) {
                                                        // 创建更真实的提交事件
                                                        const submitEvent = new Event('submit', { 
                                                            bubbles: true, 
                                                            cancelable: true 
                                                        });
                                                        form.dispatchEvent(submitEvent);
                                                        
                                                        // 如果还是没有触发，尝试直接调用表单的submit方法
                                                        if (!submitPrevented) {
                                                            try {
                                                                form.submit();
                                                            } catch (e) {
                                                                // submit被拦截是正常的
                                                                console.log('🔐 表单提交被正确拦截');
                                                            }
                                                        }
                                                    }
                                                    
                                                    // 等待密码管理器处理
                                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                                    
                                                    // 清理临时表单
                                                    setTimeout(() => {
                                                        if (form.parentNode) {
                                                            form.parentNode.removeChild(form);
                                                        }
                                                    }, 3000);
                                                    
                                                    return { 
                                                        success: true, 
                                                        message: '凭据已注入到浏览器密码管理器检测系统',
                                                        username: username,
                                                        passwordLength: password.length
                                                    };
                                                    
                                                } catch (error) {
                                                    return { 
                                                        success: false, 
                                                        error: error.message 
                                                    };
                                                }
                                            })();
                                        `;
                                        
                                        // 执行脚本
                                        const result = await client.send('Runtime.evaluate', {
                                            expression: saveCredentialScript,
                                            awaitPromise: true,
                                            returnByValue: true
                                        });
                                        
                                        if (result.result && result.result.value) {
                                            const scriptResult = result.result.value;
                                            console.log('🔐 CDP凭据保存结果:', JSON.stringify(scriptResult, null, 2));
                                            
                                            if (scriptResult.success) {
                                                console.log('✅ 凭据已成功注入到浏览器密码管理器检测系统');
                                                console.log(`🔑 保存的账号: ${profile.account}`);
                                                console.log(`🔒 保存的密码长度: ${profile.accountPassword.length} 字符`);
                                                
                                                // 额外尝试：查找页面上的实际登录表单并填充
                                                const fillResult = await page.evaluate(async (account, accountPassword) => {
                                                    const usernameSelectors = [
                                                        'input[type="email"]',
                                                        'input[type="text"][name*="email"]',
                                                        'input[type="text"][name*="username"]',
                                                        'input[name="email"]',
                                                        'input[name="username"]',
                                                        'input[id*="email"]',
                                                        'input[id*="username"]'
                                                    ];
                                                    
                                                    const passwordSelectors = [
                                                        'input[type="password"]',
                                                        'input[name="password"]',
                                                        'input[id*="password"]'
                                                    ];
                                                    
                                                    let usernameField = null;
                                                    let passwordField = null;
                                                    
                                                    // 查找真实的登录表单
                                                    for (const selector of usernameSelectors) {
                                                        const field = document.querySelector(selector);
                                                        if (field && field.offsetParent !== null) {
                                                            usernameField = field;
                                                            break;
                                                        }
                                                    }
                                                    
                                                    for (const selector of passwordSelectors) {
                                                        const field = document.querySelector(selector);
                                                        if (field && field.offsetParent !== null) {
                                                            passwordField = field;
                                                            break;
                                                        }
                                                    }
                                                    
                                                    if (usernameField && passwordField) {
                                                        // 填充真实表单以增强密码管理器检测
                                                        usernameField.value = account;
                                                        usernameField.dispatchEvent(new Event('input', { bubbles: true }));
                                                        
                                                        passwordField.value = accountPassword;
                                                        passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                                                        
                                                        return { success: true, filled: true };
                                                    }
                                                    
                                                    return { success: true, filled: false };
                                                }, profile.account, profile.accountPassword);
                                                
                                                if (fillResult.filled) {
                                                    console.log('✅ 真实登录表单也已填充，增强密码管理器检测');
                                                }
                                                
                                            } else {
                                                console.log('⚠️ CDP凭据保存失败:', scriptResult.error);
                                            }
                                        }
                                        
                                    } catch (cdpError) {
                                        console.error('❌ CDP操作失败:', cdpError.message);
                                        
                                        // 回退到传统方法
                                        console.log('🔄 回退到传统表单填充方法...');
                                        const fallbackResult = await page.evaluate(async (account, accountPassword) => {
                                            // 创建临时表单触发密码保存
                                            const form = document.createElement('form');
                                            form.style.position = 'absolute';
                                            form.style.left = '-9999px';
                                            form.method = 'post';
                                            
                                            const usernameInput = document.createElement('input');
                                            usernameInput.type = 'email';
                                            usernameInput.name = 'username';
                                            usernameInput.value = account;
                                            usernameInput.autocomplete = 'username';
                                            
                                            const passwordInput = document.createElement('input');
                                            passwordInput.type = 'password';
                                            passwordInput.name = 'password';
                                            passwordInput.value = accountPassword;
                                            passwordInput.autocomplete = 'current-password';
                                            
                                            form.appendChild(usernameInput);
                                            form.appendChild(passwordInput);
                                            document.body.appendChild(form);
                                            
                                            // 模拟用户交互
                                            usernameInput.focus();
                                            usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                                            passwordInput.focus();
                                            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                                            
                                            // 触发提交事件
                                            form.dispatchEvent(new Event('submit', { bubbles: true }));
                                            
                                            return { success: true, method: 'fallback' };
                                        }, profile.account, profile.accountPassword);
                                        
                                        console.log('✅ 回退方法执行完成:', fallbackResult);
                                    } finally {
                                        // 清理CDP会话
                                        await client.detach();
                                    }
                                    
                                } else {
                                    console.log('⚠️ 配置卡片中没有账号密码信息');
                                }
                                
                            } catch (credentialError) {
                                console.error('❌ 保存配置卡片账号密码到浏览器密码管理器失败:', credentialError.message);
                            }
                            
                        } catch (navigationError) {
                            console.warn(`⚠️ 打开网站失败 ${url}: ${navigationError.message}`);
                            // Cookie注入成功，网站访问失败不影响浏览器启动
                            continue;
                        }
                        
                        // 🍪 最终验证Cookie状态
                        if (parsedCookies && parsedCookies.length > 0) {
                            try {
                                const finalCookies = await page.cookies();
                                console.log(`🔍 最终Cookie验证: 当前页面共有 ${finalCookies.length} 个Cookie`);
                                if (finalCookies.length > 0) {
                                    console.log(`✅ Cookie最终验证成功！所有Cookie: ${finalCookies.map(c => c.name).join(', ')}`);
                                    
                                    // 检查关键Cookie
                                    const importantCookies = finalCookies.filter(c => 
                                        c.name.includes('c_user') || 
                                        c.name.includes('xs') || 
                                        c.name.includes('datr') || 
                                        c.name.includes('sb')
                                    );
                                    if (importantCookies.length > 0) {
                                        console.log(`🎯 检测到关键Cookie: ${importantCookies.map(c => c.name).join(', ')}`);
                                    }
                                } else {
                                    console.warn(`⚠️ 警告：页面加载后未检测到任何Cookie`);
                                }
                            } catch (finalVerifyError) {
                                console.warn(`⚠️ 最终Cookie验证失败: ${finalVerifyError.message}`);
                            }
                        }
                    } catch (pageError) {
                        console.warn(`⚠️ 打开网站失败 ${url}:`, pageError.message);
                    }
                }
            } else {
                console.log(`ℹ️ 没有启动网站需要打开`);
            }

            // 网络诊断
            let connectivity = null;
            try {
                connectivity = await probeConnectivity(browserInstance.browser);
                console.log('📶 网络诊断:', connectivity);
            } catch (diagErr) {
                console.warn('⚠️ 网络诊断失败:', diagErr.message);
            }

            return {
                profileId,
                debugPort,
                startTime: browserInstance.createdAt,
                userAgent: config.userAgent,
                proxyConfig: proxy,
                status: 'launched',
                connectivity
            };
        }, 0, async () => {
            // 🔥 队列超时：关掉本次任务已启动的浏览器进程，避免僵尸占着端口/profile 目录影响后续启动
            const inst = _launchTaskBrowser;
            _launchTaskBrowser = null;
            // 🔓 队列超时：释放端口预留，避免端口被永久占用
            releaseDebugPort(_allocatedDebugPort);
            _allocatedDebugPort = null;
            if (!inst || !inst.browser) return;
            log('WARN', `🧹 [LaunchQueue] 超时清理：关闭 profileId=${profileId} 的浏览器实例`);
            logBrowserClose(profileId, `启动队列任务超时(${launchQueueManager.taskTimeout}ms)清理实例`, 'LaunchQueue/超时清理');
            try {
                // 最多等 5 秒优雅关闭；卡死的 Chrome 不会响应 CDP，超时后直接杀进程
                await Promise.race([inst.browser.close(), new Promise(r => setTimeout(r, 5000))]);
            } catch {}
            try { if (inst.browser.isConnected()) inst.browser.process?.()?.kill?.(); } catch {}
            try { if (activeBrowsers.get(String(profileId))?.browser === inst.browser) activeBrowsers.delete(String(profileId)); } catch {}
        });

        const launchTime = Date.now() - startTime;
        _totalLaunchTime += launchTime;
        _successCount++;

        console.log(`✅ Puppeteer浏览器启动成功: ${profileId} (${launchTime}ms)`);

        res.json({
            success: true,
            message: 'Puppeteer浏览器启动成功',
            data: result,
            launchTime,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        const launchTime = Date.now() - startTime;
        _errorCount++;
        // 🔓 启动失败：释放端口预留，避免该端口被永久占用
        releaseDebugPort(_allocatedDebugPort);
        _allocatedDebugPort = null;
        
        console.error(`❌ 启动Puppeteer浏览器失败: ${profileId}`, error);
        
        res.status(500).json({
            success: false,
            message: 'Puppeteer浏览器启动失败',
            error: error.message,
            profileId,
            launchTime,
            timestamp: new Date().toISOString()
        });
    }
});

// ============================================================
// 🕵️ 临时网络抓包（排查 FB 内部接口用）
//   有些操作（例如「接受主页角色邀请」）没有公开 API，只能先让人手动点一遍，
//   把浏览器真实发出的请求/响应抓下来，再照着做成接口。
//   用法：start → 手动操作 → dump（读结果）→ stop
// ============================================================
const _netCaptures = new Map();   // profileId -> { entries, sessions, browser, onTarget, startedAt }

const _NET_CAP_MAX = 800;         // 最多保留多少条，防止长时间挂着把内存吃满
const _netCaptureAttach = async (cap, target) => {
    try {
        const cdp = await target.createCDPSession();
        cap.sessions.push(cdp);
        await cdp.send('Network.enable');

        cdp.on('Network.requestWillBeSent', (params) => {
            const req = (params && params.request) || {};
            const url = String(req.url || '');
            if (!/facebook\.com/i.test(url)) return;
            const apiLike = /\/api\/|graphql|\/ajax\/|\/privacy\/|\/settings\//i.test(url);
            if (cap.entries.length >= _NET_CAP_MAX) cap.entries.shift();
            cap.entries.push({
                kind: 'request', at: Date.now() - cap.startedAt,
                method: req.method, url,
                postData: apiLike ? String(req.postData || '').slice(0, 8000) : '',
            });
        });

        cdp.on('Network.responseReceived', async (params) => {
            const r = (params && params.response) || {};
            const url = String(r.url || '');
            if (!/facebook\.com/i.test(url)) return;
            const apiLike = /\/api\/|graphql|\/ajax\/|\/privacy\/|\/settings\//i.test(url);
            const item = {
                kind: 'response', at: Date.now() - cap.startedAt,
                status: r.status, url, mime: r.mimeType || '',
            };
            // 只有接口类响应才去取 body（静态资源取 body 既慢又没用）
            if (apiLike) {
                try {
                    const b = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
                    item.body = String((b && b.body) || '').slice(0, 20000);
                } catch { /* body 可能已被浏览器丢弃 */ }
            }
            if (cap.entries.length >= _NET_CAP_MAX) cap.entries.shift();
            cap.entries.push(item);
        });
    } catch { /* 挂不上的 target（例如已关闭）直接跳过 */ }
};

_app.post('/api/devtools/net-capture/start', async (req, res) => {
    try {
        const profileId = String((req.body && req.body.profileId) || '');
        if (!profileId) return res.status(400).json({ success: false, message: '缺少 profileId' });
        const entry = activeBrowsers.get(profileId);
        if (!entry || !entry.browser || !entry.browser.isConnected()) {
            return res.status(400).json({ success: false, message: `配置 ${profileId} 的浏览器未在运行，请先启动它` });
        }
        if (_netCaptures.has(profileId)) {
            const old = _netCaptures.get(profileId);
            try { old.browser && old.browser.off('targetcreated', old.onTarget); } catch { }
            for (const s of old.sessions) { try { await s.detach(); } catch { } }
            _netCaptures.delete(profileId);
        }
        const cap = { entries: [], sessions: [], browser: entry.browser, onTarget: null, startedAt: Date.now() };
        for (const target of entry.browser.targets()) await _netCaptureAttach(cap, target);
        // 新开的标签页/弹窗也要抓（点「接受」后经常会跳新页）
        cap.onTarget = (t) => { _netCaptureAttach(cap, t).catch(() => { }); };
        entry.browser.on('targetcreated', cap.onTarget);
        _netCaptures.set(profileId, cap);

        log('INFO', `🕵️ [net-capture] 开始抓包: ${profileId}（已挂 ${cap.sessions.length} 个 target）`);
        return res.json({ success: true, profileId, targets: cap.sessions.length });
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});

_app.get('/api/devtools/net-capture/dump', async (req, res) => {
    const profileId = String(req.query.profileId || '');
    const cap = _netCaptures.get(profileId);
    if (!cap) return res.status(404).json({ success: false, message: '该配置没有正在进行的抓包，请先调用 start' });
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 300, _NET_CAP_MAX));
    const entries = cap.entries.slice(-limit);
    return res.json({ success: true, profileId, total: cap.entries.length, count: entries.length, entries });
});

_app.post('/api/devtools/net-capture/stop', async (req, res) => {
    const profileId = String((req.body && req.body.profileId) || '');
    const cap = _netCaptures.get(profileId);
    if (cap) {
        try { cap.browser && cap.onTarget && cap.browser.off('targetcreated', cap.onTarget); } catch { }
        for (const s of cap.sessions) { try { await s.detach(); } catch { } }
        _netCaptures.delete(profileId);
    }
    return res.json({ success: true, profileId, removed: !!cap });
});

}

module.exports = { __inject, registerRoutes, waitForLaunchIdle };

/**
 * 等待某个配置的「启动流程」彻底结束（含 Cookie 注入 / 登录态探测 / 自动登录 / 二次导航）。
 *
 * ⚠️ 为什么必须有这个：抽 Token 的接口只判断「浏览器实例 isConnected()」，
 *    而启动流程是一长串异步步骤 —— 中途实例已经连上，但页面还停在登出态。
 *    这时抽 Token 必然抓到 0 个，190 恢复链路又把这次「没抽到」当成最终结果返回，
 *    用户看到的现象就是「日志里自动登录明明成功了，可请求还是 190」。
 *    实测（profile 4341）：抽 Token 01:54:36→01:54:41，自动登录 01:54:40 才成功，正好错开。
 *
 * @returns {Promise<boolean>} 是否真的等待过（用于打日志）
 */
async function waitForLaunchIdle(profileId, timeoutMs = 120000) {
    const key = String(profileId || '');
    if (!key || !_launchInFlightProfiles.has(key)) return false;
    const t0 = Date.now();
    // ⚠️ 本函数在模块作用域，只有 _log（registerRoutes 里的 `const log = _log` 在这里看不到）——
    //    以前写成 log(...) 会抛 "log is not defined"，被调用方 catch 吞掉，等待逻辑直接失效。
    _log('INFO', `⏳ [Launch] 配置 ${key} 正在启动（含自动登录），等待其结束…`);
    while (_launchInFlightProfiles.has(key)) {
        if (Date.now() - t0 > timeoutMs) {
            _log('WARN', `⏳ [Launch] 等待配置 ${key} 启动结束超时 ${timeoutMs}ms，不再等待`);
            return true;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    _log('INFO', `⏳ [Launch] 配置 ${key} 启动流程已结束（等待 ${Date.now() - t0}ms）`);
    return true;
}