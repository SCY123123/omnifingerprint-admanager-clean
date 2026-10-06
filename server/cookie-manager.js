'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const fs = require('fs').promises;
const sqlite3 = require('sqlite3').verbose();

// Injected dependencies
let _log = () => {};
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _getActiveBrowsers = () => new Map();

function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.sleep) _sleep = deps.sleep;
  if (deps.getActiveBrowsers) _getActiveBrowsers = deps.getActiveBrowsers;
}

// 🌐 Facebook 域名归一化：导出的 Cookie 常写成不带点的 "facebook.com"（host-only），
//    或移动端抓包留下的 "m.facebook.com" / "mbasic.facebook.com" 等。
//    host-only 的含义是「只发给这一个主机」—— 而校验登录固定用 https://www.facebook.com/，
//    business./adsmanager. 更收不到，整批 Cookie 等于没带上，页面永远显示未登录（实测 profile 4247：
//    云端 8 个 Cookie 全是 domain=facebook.com + hostOnly=true，本地目录却攒不下登录态）。
//    统一提升为 ".facebook.com"（对所有子域生效）；对已是 ".facebook.com" 的输入是幂等的。
function normalizeFbDomain(domain) {
    const raw = String(domain == null ? '' : domain).trim();
    const d = raw.replace(/^\./, '').toLowerCase();
    if (d === 'facebook.com' || d.endsWith('.facebook.com')) return '.facebook.com';
    return raw;
}

// 🍪 Cookie 标准化函数
function normalizeCookie(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = raw.name ?? raw.Name ?? raw.NAME ?? null;
    if (!name || typeof name !== 'string' || !name.trim()) return null;
    const value = raw.value ?? raw.Value ?? raw.VALUE ?? '';
    const domain = raw.domain ?? raw.Domain ?? raw.DOMAIN ?? raw.host_key ?? raw.hostKey ?? '';
    const path = raw.path ?? raw.Path ?? raw.PATH ?? '/';
    const secure = raw.secure ?? raw.Secure ?? raw.SECURE ?? false;
    const httpOnly = raw.httpOnly ?? raw.HttpOnly ?? raw.HTTPONLY ?? raw.http_only ?? false;
    
    // expires 标准化为 Unix 秒
    let expires = -1; // -1 = session
    // ⚠️ Cookie-Editor / 浏览器扩展导出用的是 expirationDate，漏读会让过期时间丢失，
    //    整批 Cookie 被当成 session cookie 写入（浏览器一关就清空，本地永远攒不下登录态）。
    const rawExpires = raw.expires ?? raw.Expires ?? raw.EXPIRES ?? raw.expiry ?? raw.Expiry ?? raw.EXPIRY ?? raw.expirationDate ?? raw.expiration_date;
    if (rawExpires !== undefined && rawExpires !== null && rawExpires !== -1 && rawExpires !== '-1') {
        if (typeof rawExpires === 'number') {
            expires = Math.floor(rawExpires);
        } else if (typeof rawExpires === 'string') {
            const d = new Date(rawExpires);
            if (!isNaN(d.getTime())) {
                expires = Math.floor(d.getTime() / 1000);
            }
        }
    }
    
    // sameSite 标准化为字符串
    let sameSite = 'None';
    const rawSameSite = raw.sameSite ?? raw.SameSite ?? raw.SAMESITE ?? raw.Samesite ?? raw.samesite;
    if (rawSameSite !== undefined && rawSameSite !== null) {
        const s = String(rawSameSite).toLowerCase().trim();
        if (s === '-1' || s === 'unspecified') sameSite = 'Unspecified';
        else if (s === '0' || s === 'none' || s === 'no_restriction') sameSite = 'None';
        else if (s === '1' || s === 'lax') sameSite = 'Lax';
        else if (s === '2' || s === 'strict') sameSite = 'Strict';
        else sameSite = rawSameSite.charAt(0).toUpperCase() + rawSameSite.slice(1).toLowerCase();
    }
    
    // sourceScheme 标准化为字符串
    let sourceScheme = 'Secure';
    const rawScheme = raw.sourceScheme ?? raw.SourceScheme ?? raw.SOURCESCHEME ?? raw.source_scheme;
    if (rawScheme !== undefined && rawScheme !== null) {
        const s = String(rawScheme);
        if (s === '0' || s.toLowerCase() === 'unset') sourceScheme = 'Unset';
        else if (s === '1' || s.toLowerCase() === 'insecure') sourceScheme = 'Insecure';
        else if (s === '2' || s.toLowerCase() === 'secure') sourceScheme = 'Secure';
        else sourceScheme = s;
    }
    
    return {
        name: String(name).trim(),
        value: String(value),
        domain: normalizeFbDomain(domain),
        path: String(path),
        expires,
        size: (value || '').length,
        httpOnly: httpOnly === true || httpOnly === 'true' || httpOnly === 1 || httpOnly === '1',
        secure: secure === true || secure === 'true' || secure === 1 || secure === '1',
        session: expires === -1,
        sameSite,
        priority: 'Medium',
        sourceScheme,
    };
}

// 🍪 Cookie预注入函数 - 在浏览器启动前将Cookie写入用户数据目录
async function preinjectCookies(userDataDir, cookies) {
    const fs = require('fs');
    const path = require('path');
    const sqlite3 = require('sqlite3').verbose();
    
    try {
        // 确保用户数据目录存在
        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
            console.log(`📁 创建用户数据目录: ${userDataDir}`);
        }
        
        // 创建Default目录
        const defaultDir = path.join(userDataDir, 'Default');
        if (!fs.existsSync(defaultDir)) {
            fs.mkdirSync(defaultDir, { recursive: true });
            console.log(`📁 创建Default目录: ${defaultDir}`);
        }
        
        // Cookie数据库路径
        const cookieDbPath = path.join(defaultDir, 'Cookies');
        console.log(`🗄️ Cookie数据库路径: ${cookieDbPath}`);
        
        // 创建或打开Cookie数据库
        const db = new sqlite3.Database(cookieDbPath);
        
        // 创建cookies表（如果不存在）
        await new Promise((resolve, reject) => {
            db.run(`CREATE TABLE IF NOT EXISTS cookies (
                creation_utc INTEGER NOT NULL,
                host_key TEXT NOT NULL,
                top_frame_site_key TEXT NOT NULL,
                name TEXT NOT NULL,
                value TEXT NOT NULL,
                encrypted_value BLOB DEFAULT '',
                path TEXT NOT NULL,
                expires_utc INTEGER NOT NULL,
                is_secure INTEGER NOT NULL,
                is_httponly INTEGER NOT NULL,
                last_access_utc INTEGER NOT NULL,
                has_expires INTEGER NOT NULL,
                is_persistent INTEGER NOT NULL,
                priority INTEGER NOT NULL DEFAULT 1,
                samesite INTEGER NOT NULL DEFAULT -1,
                source_scheme INTEGER NOT NULL DEFAULT 0,
                source_port INTEGER NOT NULL DEFAULT -1,
                is_same_party INTEGER NOT NULL DEFAULT 0
            )`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        // 插入Cookie数据
        // 🚀 Chrome 时间戳 = Unix 微秒 + 11644473600000000 (1601-01-01 到 1970-01-01 的微秒偏移)
        const CHROME_EPOCH_DELTA = 11644473600000000;
        const currentTimeUnixMs = Date.now(); // Unix 毫秒
        const currentTimeChrome = (currentTimeUnixMs * 1000) + CHROME_EPOCH_DELTA; // Chrome 微秒
        const farFutureChrome = currentTimeChrome + Number(10n * 365n * 24n * 60n * 60n * 1000n * 1000n); // 10年后
        
        for (const raw of cookies) {
            try {
                const c = normalizeCookie(raw);
                if (!c) { continue; }
                
                // 计算过期时间 (Chrome epoch 微秒)
                let expiresUtcChrome = Number(farFutureChrome);
                if (c.expires > 0) {
                    expiresUtcChrome = (c.expires * 1000 * 1000) + CHROME_EPOCH_DELTA;
                }
                
                // 确定域名和路径
                const domain = c.domain || '.localhost';
                const path = c.path || '/';
                
                const isSecure = c.secure ? 1 : 0;
                const isHttpOnly = c.httpOnly ? 1 : 0;
                const sameSiteVal = c.sameSite === 'Strict' ? 2 : (c.sameSite === 'Lax' ? 1 : (c.sameSite === 'None' ? 0 : -1));
                
                // 插入Cookie
                await new Promise((resolve, reject) => {
                    db.run(`INSERT OR REPLACE INTO cookies (
                        creation_utc, host_key, top_frame_site_key, name, value,
                        path, expires_utc, is_secure, is_httponly, last_access_utc,
                        has_expires, is_persistent, priority, samesite
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                        currentTimeChrome, domain, domain, c.name, c.value,
                        path, expiresUtcChrome, isSecure, isHttpOnly,
                        currentTimeChrome, c.expires > 0 ? 1 : 0, 1, 1, sameSiteVal
                    ], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                
                console.log(`✅ Cookie已注入: ${c.name} = ${c.value.substring(0, 20)}...`);
            } catch (cookieError) {
                console.warn(`⚠️ 注入Cookie失败 ${c?.name ?? 'unknown'}:`, cookieError.message);
            }
        }
        
        // 关闭数据库
        db.close();
        console.log(`🍪 Cookie预注入完成，共注入 ${cookies.length} 个Cookie`);
        
    } catch (error) {
        console.error(`❌ Cookie预注入失败:`, error.message);
        throw error;
    }
}

// 🍪 Cookie预注入到本地Chrome数据库
async function preinjectCookiesToDatabase(userDataDir, cookies) {
    if (!cookies || cookies.length === 0) {
        console.log('ℹ️ 没有Cookie需要预注入');
        return true;
    }

    // ⚠️ 这里直接跳过，不再往 Cookies 库里写：
    //    Chrome 80+（Windows）只采纳 encrypted_value 里 v10 格式（AES-GCM，密钥由 DPAPI 保护）
    //    的 cookie，而加密/解密要用的密钥存在 profile 的 Local State 里 —— Chrome **首次启动前**
    //    根本不存在。所以这里写入的「明文 value + 空 encrypted_value」一定不会被采纳
    //    （实测：文件被 Chrome 迁移到 Default/Network/Cookies 后，这些行被整行丢弃）。
    //    真正让 cookie 生效的是浏览器启动后的 CDP 注入 —— 由 Chrome 自己加密写库。
    //    跳过同时也消除了误导日志「Cookie数据库不存在，将创建新数据库」每次启动都出现的问题。
    //    （如需恢复写库：删掉这段 early return 即可，下面的实现在路径上已修正为 Network 目录。）
    try { console.log(`ℹ️ 跳过 SQLite 预注入（${cookies.length} 个Cookie）：Chrome 不采纳明文 cookie，改由启动后的 CDP 注入写入`); } catch {}
    return true;

    // —— 以下为原实现（路径已修正为 Network 目录），当前被上面的 early return 跳过 ——
    const defaultDir = path.join(userDataDir, 'Default');
    const networkDir = path.join(defaultDir, 'Network');
    const cookieDbPath = path.join(networkDir, 'Cookies');

    try {
        // 确保目录存在
        await fs.mkdir(defaultDir, { recursive: true });
        await fs.mkdir(networkDir, { recursive: true });
        
        console.log(`🍪 开始预注入 ${cookies.length} 个Cookie到: ${cookieDbPath}`);
        
        // 检查Cookie数据库是否已存在
        let dbExists = false;
        try {
            const stats = await fs.stat(cookieDbPath);
            dbExists = stats.isFile();
            console.log('✅ Cookie数据库已存在，将追加Cookie');
        } catch (error) {
            dbExists = false;
            console.log('📝 Cookie数据库不存在，将创建新数据库');
        }
        
        return new Promise((resolve, reject) => {
            console.log(`🔧 正在打开SQLite数据库: ${cookieDbPath}`);
            const db = new sqlite3.Database(cookieDbPath, (err) => {
                if (err) {
                    console.error('❌ 打开Cookie数据库失败:', err);
                    reject(err);
                    return;
                }
                console.log('✅ SQLite数据库连接成功');
                
                // 如果是新数据库，需要创建表结构
                if (!dbExists) {
                    console.log('🔧 创建Chrome Cookie表结构...');
                    db.run(`CREATE TABLE cookies (
                        creation_utc INTEGER NOT NULL,
                        host_key TEXT NOT NULL,
                        top_frame_site_key TEXT NOT NULL,
                        name TEXT NOT NULL,
                        value TEXT NOT NULL,
                        encrypted_value BLOB DEFAULT '',
                        path TEXT NOT NULL,
                        expires_utc INTEGER NOT NULL,
                        is_secure INTEGER NOT NULL DEFAULT 0,
                        is_httponly INTEGER NOT NULL DEFAULT 0,
                        last_access_utc INTEGER NOT NULL,
                        has_expires INTEGER NOT NULL DEFAULT 1,
                        is_persistent INTEGER NOT NULL DEFAULT 1,
                        priority INTEGER NOT NULL DEFAULT 1,
                        samesite INTEGER NOT NULL DEFAULT -1,
                        source_scheme INTEGER NOT NULL DEFAULT 0,
                        source_port INTEGER NOT NULL DEFAULT -1,
                        last_update_utc INTEGER NOT NULL,
                        UNIQUE (host_key, name, path)
                    )`, (err) => {
                        if (err) {
                            console.error('❌ 创建Cookie表失败:', err);
                            reject(err);
                            return;
                        }
                        console.log('✅ Cookie表结构创建成功');
                        insertCookies();
                    });
                } else {
                    insertCookies();
                }
                
                function insertCookies() {
                    // 🚀 Chrome 时间戳 = Unix 微秒 + 11644473600000000 (1601-01-01 到 1970-01-01 偏移)
                    const CHROME_EPOCH_DELTA = 11644473600000000;
                    const nowUnixMs = Date.now();
                    const chromeEpochNow = (nowUnixMs * 1000) + CHROME_EPOCH_DELTA; // Chrome 微秒
                    let insertedCount = 0;
                    let errorCount = 0;
                    
                    const stmt = db.prepare(`INSERT OR REPLACE INTO cookies (
                        creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
                        path, expires_utc, is_secure, is_httponly, last_access_utc,
                        has_expires, is_persistent, priority, samesite, source_scheme,
                        source_port, last_update_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                    cookies.forEach(raw => {
                        const c = normalizeCookie(raw);
                        if (!c) { return; }
                        
                        // 计算过期时间 (Chrome epoch 微秒)
                        let expiresUtcChrome = chromeEpochNow + Number(365n * 24n * 60n * 60n * 1000n * 1000n); // 1年后
                        if (c.expires > 0) {
                            expiresUtcChrome = (c.expires * 1000 * 1000) + CHROME_EPOCH_DELTA;
                        }
                        
                        // 处理domain为host_key
                        const hostKey = (c.domain && c.domain !== 'undefined') ? 
                            c.domain : '.facebook.com';
                        const topFrameSiteKey = hostKey.startsWith('.') ? 
                            'https://' + hostKey.substring(1) : 
                            'https://' + hostKey;
                        
                        const isSecure = c.secure ? 1 : 0;
                        const isHttpOnly = c.httpOnly ? 1 : 0;
                        const sameSiteVal = c.sameSite === 'Strict' ? 2 : (c.sameSite === 'Lax' ? 1 : (c.sameSite === 'None' ? 0 : -1));
                        const sourceSchemeVal = c.sourceScheme === 'Secure' ? 2 : (c.sourceScheme === 'Insecure' ? 1 : 0);
                        const isPersistentVal = c.session ? 0 : 1;
                        
                        stmt.run([
                            chromeEpochNow,               // creation_utc
                            hostKey,                       // host_key
                            topFrameSiteKey,              // top_frame_site_key
                            c.name,                        // name
                            c.value,                       // value
                            '',                           // encrypted_value (空字符串)
                            c.path,                        // path
                            expiresUtcChrome,             // expires_utc
                            isSecure,                     // is_secure
                            isHttpOnly,                   // is_httponly
                            chromeEpochNow,              // last_access_utc
                            c.expires > 0 ? 1 : 0,       // has_expires
                            isPersistentVal,              // is_persistent
                            1,                            // priority (MEDIUM)
                            sameSiteVal,                  // samesite
                            sourceSchemeVal,              // source_scheme
                            443,                          // source_port
                            chromeEpochNow               // last_update_utc
                        ], function(err) {
                            if (err) {
                                console.error(`❌ 插入Cookie失败 ${c.name}:`, err);
                                errorCount++;
                            } else {
                                console.log(`✅ Cookie已插入: ${c.name}=${c.value.substring(0, 20)}...`);
                                insertedCount++;
                            }
                            
                            // 检查是否所有Cookie都已处理
                            if (insertedCount + errorCount === cookies.length) {
                                stmt.finalize();
                                db.close(async (err) => {
                                    if (err) {
                                        console.error('❌ 关闭数据库失败:', err);
                                        reject(err);
                                    } else {
                                        console.log(`✅ Cookie预注入完成: ${insertedCount}/${cookies.length} 成功`);
                                        
                                        // 验证Cookie文件是否真正创建
                                        try {
                                            const stats = await fs.stat(cookieDbPath);
                                            console.log(`🔍 Cookie数据库文件验证: 大小=${stats.size}字节, 修改时间=${stats.mtime}`);
                                        } catch (verifyError) {
                                            console.error('❌ Cookie数据库文件验证失败:', verifyError);
                                        }
                                        
                                        resolve(true);
                                    }
                                });
                            }
                        });
                    });
                }
            });
        });
        
    } catch (error) {
        console.error('❌ Cookie预注入失败:', error);
        throw error;
    }
}

// 🍪 Cookie字符串解析函数
function parseCookieString(cookieString, startUrls = []) {
    if (!cookieString || typeof cookieString !== 'string') {
        return [];
    }
    
    const cookies = [];
    
    // 🔧 智能域名推导：根据启动网站自动设置cookie域名
    let defaultDomain = '.facebook.com';
    if (startUrls && startUrls.length > 0) {
        try {
            const firstUrl = new URL(startUrls[0]);
            const hostname = firstUrl.hostname;
            // 如果是主域名，添加点前缀以支持子域名
            defaultDomain = hostname.startsWith('www.') ? 
                '.' + hostname.substring(4) : 
                '.' + hostname;
            console.log(`🔧 根据启动网站自动推导Cookie默认域名: ${defaultDomain} (基于: ${hostname})`);
        } catch (urlError) {
            console.warn('⚠️ 无法解析启动网站URL，使用默认域名:', defaultDomain);
        }
    }
    
    // 🔧 检查是否为HTTPS网站（影响secure和sameSite设置）
    const isHttps = (startUrls && startUrls.length > 0) ? startUrls[0].startsWith('https://') : true;
    console.log(`🔒 启动网站协议检测: ${isHttps ? 'HTTPS (将设置secure=true)' : 'HTTP (secure=false)'}`);
    
    try {
        // 尝试解析JSON格式的Cookie
        if (cookieString.trim().startsWith('[') || cookieString.trim().startsWith('{')) {
            const jsonCookies = JSON.parse(cookieString);
            if (Array.isArray(jsonCookies)) {
                return jsonCookies;
            } else if (typeof jsonCookies === 'object') {
                // 单个cookie对象
                return [jsonCookies];
            }
        }
        
        // 解析Netscape格式或简单的键值对格式
        const lines = cookieString.split('\n').map(line => line.trim()).filter(line => line);
        
        for (const line of lines) {
            // 跳过注释行
            if (line.startsWith('#') || line.startsWith('//')) {
                continue;
            }
            
            // 检查是否是Netscape格式（包含制表符）
            if (line.includes('\t')) {
                const parts = line.split('\t');
                if (parts.length >= 7) {
                    const cookie = {
                        domain: parts[0],
                        path: parts[2] || '/',
                        secure: parts[3] === 'TRUE',
                        expiry: parseInt(parts[4]) || Math.floor(Date.now() / 1000) + 86400 * 365, // 默认1年
                        name: parts[5],
                        value: parts[6] || '',
                        httpOnly: false,
                        sameSite: 'Lax'
                    };
                    cookies.push(cookie);
                    continue;
                }
            }
            
            // 解析简单的键值对格式 (name=value; name2=value2)
            if (line.includes('=')) {
                const cookiePairs = line.split(';').map(pair => pair.trim());
                
                for (const pair of cookiePairs) {
                    const equalIndex = pair.indexOf('=');
                    if (equalIndex > 0) {
                        const name = pair.substring(0, equalIndex).trim();
                        const value = pair.substring(equalIndex + 1).trim();
                        
                        if (name && value) {
                            const cookie = {
                                domain: defaultDomain,
                                path: '/',
                                secure: isHttps, // 根据启动网站协议自动设置
                                expiry: Math.floor(Date.now() / 1000) + 86400 * 365, // 1年后过期
                                name: name,
                                value: value,
                                httpOnly: false,
                                sameSite: isHttps ? 'None' : 'Lax' // HTTPS使用None，HTTP使用Lax
                            };
                            cookies.push(cookie);
                            console.log(`🍪 解析Cookie: ${name} -> 域名: ${defaultDomain}, secure: ${isHttps}, sameSite: ${cookie.sameSite}`);
                        }
                    }
                }
            }
        }
        
    } catch (parseError) {
        console.error('❌ Cookie解析失败:', parseError.message);
        console.log('🔍 原始Cookie数据:', cookieString.substring(0, 200));
    }
    
    console.log(`🔧 Cookie解析完成: ${cookies.length} 个cookie`);
    return cookies;
}

// 🔐 把「登录状态」回写云端（值域 ok / relogged / checkpoint / invalid）。
//    前端配置列表的「登录状态」列读的就是云端这个字段 —— 只更新本地内存闸门(markLoginState)的话，
//    列表会一直显示「未检测」。所以「Graph API 取到数据 = 已登录」必须同时落到这里。
//    ⚠️ 一律 fire-and-forget：调用点在 Graph API 成功回调这种热路径上，绝不能拖慢或搞挂调用方。
function reportLoginStatusToCloud(profileId, loginStatus) {
    try {
        const sbase = String(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
        const secret = process.env.PUPPETEER_API_SECRET || '';
        if (!secret) {
            _log('WARN', `⚠️ 未配置 PUPPETEER_API_SECRET，跳过回写登录状态(${loginStatus}) profileId=${profileId}`);
            return;
        }
        fetch(`${sbase}/api/profiles/update-login-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Secret': secret },
            body: JSON.stringify({ items: [{ id: String(profileId), loginStatus: String(loginStatus) }] })
        }).then(r => {
            if (!r || !r.ok) _log('WARN', `⚠️ 回写登录状态(${loginStatus})失败: profileId=${profileId} status=${r && r.status}`);
        }).catch(e => {
            _log('WARN', `⚠️ 回写登录状态(${loginStatus})异常: profileId=${profileId} ${String((e && e.message) || e)}`);
        });
    } catch (e) {
        try { _log('WARN', `⚠️ 回写登录状态异常: ${String((e && e.message) || e)}`); } catch {}
    }
}

// 🍪 Cookie云端同步函数 - 将Cookie同步到远程存储服务器
// 🔐 会话有效性登记表：只有「本轮启动已确认登录」的配置，才允许把 Cookie 推回云端。
//    背景：原守卫只校验 c_user/xs 字段「在不在」，判断不了会话是否已经失效。
//    实测 profile 4178，04:41:43 把一套已失效的 Cookie 推上云端（还返回 success），
//    4 秒后页面就被判定「显示未登录」→ 云端被坏会话永久覆盖，每次启动又灌回浏览器。
//    所以闸门必须放在「本轮启动验证完成」之后：未确认(undefined) 与 已确认未登录(false) 都不许推。
const _loginState = new Map(); // profileId -> { loggedIn: boolean, checkedAt: number }

function markLoginState(profileId, loggedIn) {
    if (profileId === undefined || profileId === null) return;
    _loginState.set(String(profileId), { loggedIn: !!loggedIn, checkedAt: Date.now() });
}

function getLoginState(profileId) {
    if (profileId === undefined || profileId === null) return null;
    return _loginState.get(String(profileId)) || null;
}

// ♻️ 清空某个配置的登录判定：每次「真正启动一个新浏览器实例」时调用。
//    否则上一轮的 markLoginState(true) 会残留在模块级 Map 里 —— 新会话还没验证，
//    闸门就以为「已确认登录」而放行，把未验证的 Cookie 推上云（实测 5894：23:12:55 抢先推送，
//    23:12:59 页面才判定未登录）。这正是闸门当初要防的「用坏会话覆盖云端好快照」。
function resetLoginState(profileId) {
    if (profileId === undefined || profileId === null) return;
    _loginState.delete(String(profileId));
}

// 🔁 登录状态复检器（闸门自愈机制）：由 browser-routes 在模块加载时注册（那里才有页面上下文）。
//    场景：启动验证把配置判成「未登录」（如页面停在 checkpoint），用户随后人工过完验证登录成功，
//    但若一直没有 Graph 调用或二次验证，没有任何路径把状态翻回 true → Cookie 同步闸门永远拒绝，
//    新会话无法上云（6007 实测）。这里提供注册点 + 90 秒冷却调度；复检通过后由注册方开闸并补同步。
let _loginRevalidator = null;
const _revalAt = new Map(); // profileId -> 上次复检时间戳
function setLoginRevalidator(fn) { _loginRevalidator = typeof fn === 'function' ? fn : null; }
function requestLoginRevalidation(profileId, reason) {
    if (!_loginRevalidator) return Promise.resolve(false);
    const pid = String(profileId);
    const now = Date.now();
    if (now - (_revalAt.get(pid) || 0) < 90000) return Promise.resolve(false); // 冷却：checkpoint 期间 cookie 高频变化，防连环复检
    _revalAt.set(pid, now);
    _log('INFO', `🔁 [Sync] 快照已含会话 Cookie 但旧判定为未登录，调度登录状态复检 (profileId=${pid}, reason=${reason || ''})`);
    return Promise.resolve().then(() => _loginRevalidator(pid, reason)).catch((e) => {
        try { _log('WARN', `🔁 [Sync] 登录复检执行异常: ${String((e && e.message) || e)}`); } catch {}
        return false;
    });
}

// 🍪 只读探测：profile 目录里 Chrome 自己保存的 Cookie 是否已有登录态。
//    Chrome 152 用 Default/Network/Cookies，老版本在 Default/Cookies。
//    ⚠️ Windows 下 value 可能为空（密文在 encrypted_value 里），所以只判断「c_user/xs 是否存在且有值」，不解密。
//    ⚠️ host_key 只认 facebook.com / .facebook.com：原来用 LIKE '%facebook.com'，
//       会把只在 m.facebook.com 生效的 host-only Cookie 也算成「已有登录态」→ 误判为可跳过云端注入。
//    浏览器正占用该目录时读不到 → 返回 null，调用方按原有逻辑兜底。
async function readLoginCookiesFromProfileDir(userDataDir) {
    if (!userDataDir) return null;
    const candidates = [
        path.join(userDataDir, 'Default', 'Network', 'Cookies'),
        path.join(userDataDir, 'Default', 'Cookies'),
    ];
    for (const dbPath of candidates) {
        try {
            const st = await fs.stat(dbPath);
            if (!st.isFile() || st.size === 0) continue;
        } catch { continue; }

        const found = await new Promise((resolve) => {
            let db = null;
            try {
                db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                    if (err) return resolve(null);
                    db.all(
                        `SELECT name, length(COALESCE(value,'')) AS vlen, length(COALESCE(encrypted_value,'')) AS elen
                         FROM cookies WHERE name IN ('c_user','xs')
                           AND (host_key = 'facebook.com' OR host_key = '.facebook.com')`,
                        (qErr, rows) => {
                            try { db && db.close(); } catch {}
                            if (qErr || !rows || rows.length === 0) return resolve(null);
                            const names = new Set(rows.map(r => r.name));
                            if (!names.has('c_user') || !names.has('xs')) return resolve(null);
                            if (!rows.every(r => (r.vlen || 0) > 0 || (r.elen || 0) > 0)) return resolve(null);
                            resolve({ dbPath, cookieCount: rows.length });
                        }
                    );
                });
            } catch {
                try { db && db.close(); } catch {}
                resolve(null);
            }
        });
        if (found) return found;
    }
    return null;
}

async function syncCookiesToStorage(profileId, cookies, authToken) {
    // 🚀 修正：使用和全局一致的 fallback secret，避免 API_SECRET 空字符串导致跳过
    const syncSecret = process.env.PUPPETEER_API_SECRET || '';
    if (!syncSecret) {
        if (!global.__warnedNoSecret) { global.__warnedNoSecret = true;
            _log('WARN', `[Sync] API_SECRET 未配置，跳过所有云端 Cookie 同步`);
        }
        return;
    }
    // 🚀 全局节流：每个 profile 每 30 秒最多同步一次，连续失败 3 次后暂停 5 分钟
    if (!global.__syncThrottle) global.__syncThrottle = {};
    const now = Date.now();
    const st = global.__syncThrottle[profileId] || { lastSync: 0, failCount: 0, pausedUntil: 0 };
    if (now < st.pausedUntil) {
        _log('DEBUG', `[Sync] 跳过同步: profileId=${profileId} 暂停中（还有 ${Math.round((st.pausedUntil - now)/1000)}s）`);
        return;
    }
    if (now - st.lastSync < 30000) {
        _log('DEBUG', `[Sync] 跳过同步: profileId=${profileId} 30秒内已同步过`);
        return;
    }
    st.lastSync = now;
    global.__syncThrottle[profileId] = st;

    try {
        const sbase = String(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
        const url = `${sbase}/api/fb-api/sync-cookies`;
        
        // 🚀 核心拦截逻辑：严禁同步空数据或无效数据
        if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
            _log('WARN', `[Sync] 拒绝同步: Cookie 列表为空 (profileId=${profileId})`);
            return;
        }

        // 🚀 关键校验：必须包含 Facebook 登录的核心字段，否则视为"未登录态"或"中间态"
        const hasSession = cookies.some(c => c.name === 'c_user') && cookies.some(c => c.name === 'xs');
        if (!hasSession) {
            _log('WARN', `[Sync] 拒绝同步: 缺少核心登录字段 c_user/xs，防止覆盖正常登录态 (profileId=${profileId}, count=${cookies.length})`);
            // 🚀 核心修复：退回 lastSync，让后续有完整登录 Cookie 时不被 30 秒节流拦住
            st.lastSync = Math.max(0, st.lastSync - 10000);
            global.__syncThrottle[profileId] = st;
            return;
        }

        // 🔐 会话闸门：只允许「本轮启动已确认登录」的配置覆盖云端 Cookie。
        //    未确认（启动验证还没跑完）或已确认未登录 → 一律拒绝，否则会把失效会话写进云端。
        const ls = getLoginState(profileId);
        if (!ls || !ls.loggedIn) {
            _log('WARN', `[Sync] 拒绝同步: 会话未确认有效（${ls ? '本轮已判定未登录' : '本轮启动尚未验证登录'}），禁止覆盖云端 Cookie (profileId=${profileId}, count=${cookies.length})`);
            // 🔁 闸门自愈：拒绝的快照里已带 c_user+xs（浏览器里会话已实际建立）→ 旧的「未登录」判定
            //    大概率已过时（典型：启动时页面停在 checkpoint 判了 false，用户随后人工过完验证）。
            //    调度一次页面登录复检（90s 冷却），通过后 markLoginState(true) 并立即补同步；不通过则维持拒绝。
            try {
                const _sessOk = cookies.some(c => c && c.name === 'c_user' && ((c.value && String(c.value).length > 0) || (c.elen || 0) > 0))
                             && cookies.some(c => c && c.name === 'xs' && ((c.value && String(c.value).length > 0) || (c.elen || 0) > 0));
                if (_sessOk) await requestLoginRevalidation(profileId, 'sync-gate-deny');
            } catch {}
            // 退回 lastSync，等验证完成后再变化仍能及时同步
            st.lastSync = Math.max(0, st.lastSync - 10000);
            global.__syncThrottle[profileId] = st;
            return;
        }

        // 🚀 强制转为字符串，确保 JSON 结构标准
        // 🌐 推送前统一域名：页面/请求里带来的可能是 host-only 的 "facebook.com"，
        //    原样推上去会把云端写成「只对 facebook.com 生效」，下次启动又带不上（4247 就是这么坏的）。
        const body = { 
            profileId: String(profileId), 
            cookies: cookies.map(c => {
                const d = c.domain || c.host_key;
                return d ? { ...c, domain: normalizeFbDomain(d) } : c;
            })
        };
        
        try { _log('INFO', `🔧 准备推送有效Cookie: profileId=${body.profileId} count=${body.cookies.length} to ${url}`); } catch {}

        const postWithRetry = async (u, payload, max = 1) => {
            let attempt = 0; let lastErr = null;
            const jsonString = JSON.stringify(payload);
            const urlObj = new URL(u);
            
            while (attempt < max) {
                attempt++;
                try {
                    _log('DEBUG', `📡 [Attempt ${attempt}/${max}] Sending POST to ${u}`);
                    
                    const result = await new Promise((resolve, reject) => {
                        const isHttps = urlObj.protocol === 'https:';
                        const lib = isHttps ? https : http;
                        
                        const headers = {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(jsonString),
                            'Accept': 'application/json',
                            'User-Agent': 'OmniFingerprint-Client/1.0'
                        };

                        // 🚀 关键：如果存在令牌，则添加到请求头
                        if (authToken) {
                            headers['Authorization'] = authToken;
                        }
                        
                        // 🔐 关键：添加 syncSecret 用于云端验证
                        headers['X-Api-Secret'] = syncSecret;

                        const options = {
                            hostname: urlObj.hostname,
                            port: urlObj.port || (isHttps ? 443 : 80),
                            path: urlObj.pathname,
                            method: 'POST',
                            headers: headers,
                            timeout: 15000,
                            family: 4,  // 强制 IPv4
                        };

                        const req = lib.request(options, (res) => {
                            let data = '';
                            res.on('data', (chunk) => data += chunk);
                            res.on('end', () => {
                                if (res.statusCode >= 200 && res.statusCode < 300) {
                                    try { resolve(JSON.parse(data)); } catch { resolve({ success: true, data }); }
                                } else {
                                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`));
                                }
                            });
                        });

                        req.on('error', reject);
                        req.on('timeout', () => {
                            req.destroy();
                            reject(new Error('Request timeout after 15s'));
                        });
                        req.write(jsonString);
                        req.end();
                    });

                    return result;
                } catch (e) {
                    lastErr = e;
                    const is429 = e.message && e.message.includes('HTTP 429');
                    _log('WARN', `Attempt ${attempt} failed: ${e.message}${is429 ? ' (rate limited)' : ''}`);
                    if (is429) {
                        // 🚀 429 速率限制：长等待 + 指数退避，避免 Cloudflare WAF 持续拦截
                        const wait = attempt === 1 ? 15000 : attempt === 2 ? 30000 : 60000;
                        _log('INFO', `[Sync] 429 限流，等待 ${Math.round(wait/1000)}s 后重试...`);
                        await new Promise(r => setTimeout(r, wait));
                        continue;
                    }
                }
                if (attempt < max) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
            throw lastErr;
        };

        const result = await postWithRetry(url, body, 3);
        _log('INFO', `✅ 同步成功: profileId=${profileId} server_resp=${JSON.stringify(result)}`);
        st.failCount = 0; // 成功则重置失败计数
    } catch (e) {
        // 🚀 失败追踪：连续失败 3 次则暂停 5 分钟
        st.failCount = (st.failCount || 0) + 1;
        if (st.failCount >= 3) {
            st.pausedUntil = Date.now() + 300000; // 5分钟
            _log('WARN', `[Sync] 连续失败 ${st.failCount} 次，暂停同步 5 分钟 (profileId=${profileId})`);
            st.failCount = 0;
        } else {
            _log('WARN', `[Sync] 同步失败 (${st.failCount}/3): ${String(e.message || e)} (profileId=${profileId})`);
        }
    }
}

// 🍪 附加Cookie实时同步到页面
function attachCookieSync(page, profileId) {
    if (!page || !profileId) return;
    // ♻️ 幂等：同一个 page 只装一次。本函数有三个调用点 —— browser-manager 的 targetcreated
    //    会给每个新页装一次，browser-routes 在 newPage 后和关标签后又各显式装一次。
    //    不拦的话同一页会挂上多个 setInterval(10s) + 多组 page.on 监听，一个事件触发多次
    //    doSync（每次都 page.cookies()，一次 CDP 往返），纯重复开销。标记挂在 page 对象上按页去重。
    if (page.__cookieSyncInstalled) return;
    page.__cookieSyncInstalled = true;
    try {
        let lastKey = '';
        let lastSyncTs = 0;
        const domainAllow = [/facebook\.com$/i, /\.facebook\.com$/i, /business\.facebook\.com$/i, /adsmanager\.facebook\.com$/i];
        
        const filterCookies = (cookies) => {
            try {
                return (cookies || []).filter(c => {
                    const d = String(c.domain || '');
                    return domainAllow.some(rx => rx.test(d));
                });
            } catch { return cookies || []; }
        };

        const makeKey = (cookies) => {
            try {
                const arr = filterCookies(cookies).map(c => `${c.name}=${c.value};${c.domain}${c.path}`).sort();
                return arr.join('|');
            } catch { return ''; }
        };

        const doSync = async () => {
            try {
                if (page.isClosed()) return;
                
                const now = Date.now();
                
                // 🚀 核心改进：引入 5 秒静默期。新页面加载前 5 秒不执行同步，避免捕获不稳定的空 Cookie
                if (!page._createdAt) page._createdAt = now;
                if (now - page._createdAt < 5000) return;

                const cookies = await page.cookies().catch(() => []);
                if (!cookies || cookies.length === 0) return;

                const key = makeKey(cookies);
                if (key && key !== lastKey) {
                    // 节流：10秒内最多同步一次
                    if (now - lastSyncTs < 10000) return;
                    
                    lastKey = key;
                    lastSyncTs = now;
                    const filtered = filterCookies(cookies);
                    
                    if (filtered.length > 0) {
                        // 日志降噪：30秒内只记录一次 Cookie 变化日志
                        const logThrottle = now - (page._lastCookieLogTs || 0) >= 30000;
                        if (logThrottle) {
                            page._lastCookieLogTs = now;
                            try {
                                const names = filtered.slice(0, 5).map(c => `${c.name}@${c.domain}`).join(', ');
                                _log('INFO', `📥 [Sync] profileId=${profileId} 发现Cookie变化: count=${filtered.length} preview=${names}...`);
                            } catch {}
                        }
                        
                        const browserData = _getActiveBrowsers().get(profileId);
                        const authToken = browserData ? browserData.authToken : null;
                        await syncCookiesToStorage(profileId, filtered, authToken);
                    }
                }
            } catch (e) { 
                // 忽略页面关闭导致的错误
                if (!String(e.message).includes('Target closed')) {
                    _log('DEBUG', `Cookie同步轮询失败 (${profileId}): ${e.message}`); 
                }
            }
        };

        page.on('response', doSync);
        page.on('domcontentloaded', doSync);
        page.on('framenavigated', doSync);
        
        const timer = setInterval(doSync, 10000);
        page.on('close', () => { 
            try { clearInterval(timer); } catch {} 
            _log('DEBUG', `🧷 已卸载Cookie实时同步: profileId=${profileId}`);
        });
        
        try { _log('INFO', `🧷 已安装Cookie实时同步: profileId=${profileId}`); } catch {}
    } catch (e) { _log('ERROR', `❌ 安装Cookie实时同步失败: ${e.message}`); }
}

// 🍪 从远程存储获取Cookie
async function getCookiesFromStorage(profileId) {
    const sbase = String(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
    // ⚠️ 原来打的是 `${sbase}/api/profiles/{id}/cookies`，两个问题叠在一起让这个来源彻底失效：
    //    · 该路由只存在于本地 7070（storage-api-server.js），云端（宝塔）没有 → 云端必回 404；
    //    · 而且这里**从不带任何认证头**，走云端会先被 401 拦掉。
    //    于是它永远返回 []，等于不存在：一旦浏览器目录里没有 c_user/xs（profile 4175 实测
    //    只剩 7 个非登录 cookie），又赶上内存缓存为空、本地 profiles 表也是空的，
    //    启动时就是一个 Cookie 都不注入 → 出来的浏览器必然是未登录态。
    //    改用两端都存在的 GET /api/profiles/{id}（返回 data.account.cookies），并带上 X-Api-Secret。
    const secret = process.env.PUPPETEER_API_SECRET || '';
    const url = `${sbase}/api/profiles/${encodeURIComponent(profileId)}`;

    // 🔁 网络瞬断重试：这条链路实测会偶发 `read ECONNRESET` / `socket hang up`（同期的
    //    sync-cookies 也一样，重试即成功）。以前一次失败就 return []，调用方会退到本地缓存
    //    里那份「可能已经失效」的会话上（实测 5776 就是这么把死会话灌回浏览器的）。
    //    这里对「抛出型网络错误」重试；HTTP 4xx/5xx 属确定性错误，不重试。
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => { try { controller.abort(); } catch {} }, 5000);
            let r;
            try {
                r = await fetch(url, {
                    headers: { 'Accept': 'application/json', 'X-Api-Secret': secret },
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }
            // 不再静默吞掉非 2xx：401/404 正是上面那两个 bug 的表现，必须能看见
            if (!r.ok) {
                try { _log('WARN', `⚠️ getCookiesFromStorage 响应异常 (${url}): HTTP ${r.status}`); } catch {}
                return [];
            }
            const j = await r.json().catch(() => ({}));
            const raw = j && (j.cookies || (j.data && j.data.account && j.data.account.cookies));
            if (!raw) return [];
            if (typeof raw === 'string') {
                try { return parseCookieString(raw, []); } catch { return []; }
            }
            return Array.isArray(raw) ? raw : [];
        } catch (e) {
            const emsg = String((e && e.message) || e);
            if (attempt < MAX_ATTEMPTS) {
                try { _log('WARN', `⚠️ getCookiesFromStorage 第 ${attempt}/${MAX_ATTEMPTS} 次失败 (${url}): ${emsg}，重试中...`); } catch {}
                await _sleep(600 * attempt);
                continue;
            }
            try { _log('WARN', `⚠️ getCookiesFromStorage 失败 (${url}): ${emsg}`); } catch {}
            return [];
        }
    }
    return [];
}

module.exports = {
  normalizeCookie,
  normalizeFbDomain,
  preinjectCookies,
  preinjectCookiesToDatabase,
  parseCookieString,
  syncCookiesToStorage,
  attachCookieSync,
  getCookiesFromStorage,
  markLoginState,
  getLoginState,
  resetLoginState,
  setLoginRevalidator,
  requestLoginRevalidation,
  reportLoginStatusToCloud,
  readLoginCookiesFromProfileDir,
  __inject,
};
