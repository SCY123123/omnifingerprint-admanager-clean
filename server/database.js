// 🚀 数据库层模块 — 从 puppeteer-api-server.js 提取
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

// APP_ROOT 与主文件一致
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;

// 🧬 每个 profile 自洽的设备画像（确定性生成，只补空不覆盖）
const { normalizeProfileFingerprint } = require('./fingerprint-profiles');

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

// 📁 浏览器隔离数据根目录 (可通环境变量修改)
const BROWSER_PROFILES_ROOT = process.env.BROWSER_PROFILES_ROOT || path.join(APP_ROOT, 'browser-profiles');

// 从 proxy-tunnel 导入 parseProxy
const proxyTunnel = require('./proxy-tunnel');
const { parseProxy } = proxyTunnel;

// --- 以下函数由主文件注入（保持与主文件的 log 等共享） ---
let log = (level, message, ...args) => {
    // 兜底实现：被主文件 __inject 覆盖
    const logLevels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
    const isForced = (typeof args[0] === 'string' && args[0].startsWith('FORCE_DBG'));
    if (String(level).toUpperCase() === 'DEBUG' && !isForced) { return; }
    if (logLevels[level] >= logLevels[LOG_LEVEL] || isForced) {
        const ts = new Date().toISOString();
        try { process.stdout.write(`[${ts}] [${level}] ${message} ${args.join(' ')}\n`); } catch {}
    }
};

// 🚀 模块依赖注入（由主文件调用，将主文件的 log 等注入）
function __inject(deps) {
    if (deps.log) log = deps.log;
}

// ============================================================
// 以下代码从 puppeteer-api-server.js 原样提取
// ============================================================

// 🚀 性能优化：数据库连接池
class DatabasePool {
    constructor(dbPath, maxConnections = 5) {
        this.dbPath = dbPath;
        this.maxConnections = maxConnections;
        this.pool = [];
        this.activeConnections = 0;
        this.waitingQueue = [];
    }

    async getConnection() {
        return new Promise((resolve, reject) => {
            if (this.pool.length > 0) {
                const db = this.pool.pop();
                resolve(db);
                return;
            }

            if (this.activeConnections < this.maxConnections) {
                const db = new sqlite3.Database(this.dbPath, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    this.activeConnections++;
                    resolve(db);
                });
                return;
            }

            this.waitingQueue.push({ resolve, reject });
        });
    }

    releaseConnection(db) {
        if (this.waitingQueue.length > 0) {
            const { resolve } = this.waitingQueue.shift();
            resolve(db);
        } else {
            this.pool.push(db);
        }
    }

    async closeAll() {
        const allConnections = [...this.pool];
        this.pool = [];
        
        for (const db of allConnections) {
            await new Promise(resolve => db.close(resolve));
        }
        this.activeConnections = 0;
    }
}

// 初始化数据库连接池（新库名，无回退）
const dbPath = path.join(APP_ROOT, 'data', 'omnifingerprint.db');
const credentialsDbPath = path.join(APP_ROOT, 'profiles.db');
const mainDbPool = new DatabasePool(dbPath, 3);
const credentialsDbPool = new DatabasePool(credentialsDbPath, 2);

// ☁️ 云端配置本地缓存（内存 + 磁盘双层）
//    云端 /api/profiles/:id 单次要 1.5~6.9s，且网关 5xx 时会直接失败导致浏览器无法启动。
//    策略：TTL 内直接命中缓存；过期后请求云端，请求失败则降级使用陈旧缓存。
const CLOUD_PROFILE_CACHE_DIR = path.join(APP_ROOT, 'data', 'cloud-profile-cache');
const CLOUD_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const cloudProfileMemoryCache = new Map(); // profileId -> { profile, fetchedAt }

function cloudProfileCacheFile(profileId) {
    return path.join(CLOUD_PROFILE_CACHE_DIR, `${String(profileId).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

async function readCloudProfileCache(profileId) {
    const key = String(profileId);
    let entry = cloudProfileMemoryCache.get(key);
    if (!entry) {
        try {
            const parsed = JSON.parse(await fs.readFile(cloudProfileCacheFile(key), 'utf8'));
            if (parsed && parsed.profile && parsed.fetchedAt) {
                entry = parsed;
                cloudProfileMemoryCache.set(key, entry);
            }
        } catch {
            return null;
        }
    }
    return entry || null;
}

async function writeCloudProfileCache(profileId, profile) {
    const entry = { profile, fetchedAt: Date.now() };
    cloudProfileMemoryCache.set(String(profileId), entry);
    try {
        await fs.mkdir(CLOUD_PROFILE_CACHE_DIR, { recursive: true });
        await fs.writeFile(cloudProfileCacheFile(profileId), JSON.stringify(entry), 'utf8');
    } catch (e) {
        log('WARN', `⚠️ 写入云端配置缓存失败 (${profileId}): ${e.message}`);
    }
}

async function initDatabase() {
    log('INFO', '🗄️ 正在初始化数据库表结构...');
    const db = await mainDbPool.getConnection();
    try {
        // 1. 创建 profiles 表
        await new Promise((resolve, reject) => {
            db.run(`CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY, 
                name TEXT, 
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
                account_status TEXT,
                seq INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (err) => {
                if (err) return reject(err);
                // 检查缺失的字段并补全
                db.all(`PRAGMA table_info(profiles)`, (e, rows) => {
                    if (e || !Array.isArray(rows)) return reject(e);
                    const names = new Set(rows.map(r => String(r.name)));
                    const missing = [];
                    if (!names.has('account_name')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN account_name TEXT`);
                    }
                    if (!names.has('pages_count')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN pages_count INTEGER DEFAULT 0`);
                    }
                    if (!names.has('bm_count')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN bm_count INTEGER DEFAULT 0`);
                    }
                    if (!names.has('pixels_count')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN pixels_count INTEGER DEFAULT 0`);
                    }
                    if (!names.has('ext_id')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN ext_id TEXT`);
                    }
                    if (!names.has('platform')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN platform TEXT`);
                    }
                    if (!names.has('account_twofactor_secret')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN account_twofactor_secret TEXT DEFAULT ''`);
                    }
                    if (!names.has('os')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN os TEXT`);
                    }
                    if (!names.has('resolution')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN resolution TEXT`);
                    }
                    if (!names.has('timezone')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN timezone TEXT`);
                    }
                    if (!names.has('language')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN language TEXT`);
                    }
                    if (!names.has('fb_language')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN fb_language TEXT`);
                    }
                    if (!names.has('fingerprint_protection')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN fingerprint_protection TEXT`);
                    }
                    if (!names.has('fp_canvas')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN fp_canvas TEXT`);
                    }
                    if (!names.has('fp_webgl')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN fp_webgl TEXT`);
                    }
                    if (!names.has('fp_audio')) {
                        missing.push(`ALTER TABLE profiles ADD COLUMN fp_audio TEXT`);
                    }
                    if (missing.length === 0) return resolve();
                    log('INFO', `🔧 正在添加缺失的 profiles 字段: ${missing.length} 个`);
                    let idx = 0;
                    const runNext = () => {
                        if (idx >= missing.length) return resolve();
                        const sql = missing[idx++];
                        db.run(sql, (alterErr) => {
                            if (alterErr) log('WARN', `⚠️ 添加字段失败: ${sql} - ${alterErr.message}`);
                            runNext();
                        });
                    };
                    runNext();
                });
            });
        });

        // 2. 初始化其他表
        await ensureAdAccountsTable(db);
        await ensurePagesTable(db);
        await ensureBusinessesTable(db);
        await ensureAdsTable(db);
        await ensurePixelsTable(db);
        await ensureAdTemplatesTable(db);
        await ensurePaymentTokensTable(db);
        
        log('INFO', '✅ 数据库初始化完成');
    } catch (err) {
        log('ERROR', `❌ 数据库初始化失败: ${err.message}`);
    } finally {
        await mainDbPool.releaseConnection(db);
    }
}

// 兼容性：保持原有的数据库连接变量（用于不需要优化的地方）
const db = new sqlite3.Database(dbPath);
const credentialsDb = new sqlite3.Database(credentialsDbPath);

// 在服务器启动前运行初始化
initDatabase().catch(e => log('ERROR', `数据库初始化异常: ${e.message}`));

async function probeConnectivity() {
    try {
        const targets = [
            'https://business.facebook.com/robots.txt',
            'https://www.google.com/robots.txt',
            'https://example.com/'
        ];
        for (const url of targets) {
            try {
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), 7000);
                const resp = await fetch(url, { method: 'GET', signal: controller.signal });
                clearTimeout(t);
                if (resp && resp.ok) {
                    return { ok: true, target: 'reachable' };
                }
            } catch (e) {}
        }
        return { ok: false, error: 'unreachable' };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}

function ensureAdAccountsTable(db) {
    return new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS ad_accounts (
                id TEXT PRIMARY KEY,
                profile_id TEXT,
                platform TEXT,
                account_id TEXT,
                name TEXT,
                status TEXT,
                currency TEXT,
                timezone_id TEXT,
                spend REAL,
                country TEXT,
                threshold_amount REAL,
                credit_limit REAL,
                balance REAL,
                funding_source TEXT,
                pages_count INTEGER DEFAULT 0,
                bm_count INTEGER DEFAULT 0,
                pixels_count INTEGER DEFAULT 0,
                account TEXT,
                profile_name TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            err => {
                if (err) return reject(err);
                resolve();
            }
        )
    })
}

function ensurePagesTable(db) {
    return new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS pages (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                profile_id TEXT,
                page_id TEXT,
                name TEXT,
                fan_count INTEGER,
                link TEXT,
                category TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            err => { if (err) return reject(err); resolve(); }
        );
    });
}

function ensureBusinessesTable(db) {
    return new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS businesses (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                profile_id TEXT,
                name TEXT,
                verification_status TEXT,
                aq_status TEXT,
                aq_evidence TEXT,
                aq_policy TEXT,
                aq_updated_at TEXT,
                bm_users TEXT,
                fb_created_time TEXT,
                ad_account_limit INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            err => { if (err) return reject(err); resolve(); }
        );
    });
}

function ensureAdsTable(db) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(
                `CREATE TABLE IF NOT EXISTS ads (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER,
                    profile_id TEXT,
                    ad_id TEXT,
                    name TEXT,
                    status TEXT,
                    account_id TEXT,
                    campaign_id TEXT,
                    campaign_name TEXT,
                    adset_id TEXT,
                    adset_name TEXT,
                    creative_id TEXT,
                    preview_url TEXT,
                    targeting TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,
                err => { if (err) return reject(err); }
            );
            
            // 🚀 确保旧表升级：检查并添加缺失的列
            db.all("PRAGMA table_info(ads)", (err, rows) => {
                if (err) return;
                const columns = rows.map(r => r.name);
                const toAdd = [
                    { name: 'campaign_id', type: 'TEXT' },
                    { name: 'adset_id', type: 'TEXT' },
                    { name: 'creative_id', type: 'TEXT' },
                    { name: 'preview_url', type: 'TEXT' },
                    { name: 'targeting', type: 'TEXT' },
                    { name: 'creative_json', type: 'TEXT' }
                ];
                
                toAdd.forEach(col => {
                    if (!columns.includes(col.name)) {
                        db.run(`ALTER TABLE ads ADD COLUMN ${col.name} ${col.type}`, err => {
                            if (err) log('WARN', `Failed to add column ${col.name} to ads table: ${err.message}`);
                        });
                    }
                });
                resolve();
            });
        });
    });
}

function ensurePaymentTokensTable(db) {
    return new Promise((resolve) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS payment_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id TEXT,
                ad_account_id TEXT,
                token TEXT,
                expires_at TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            () => resolve()
        );
    });
}

function ensurePixelsTable(db) {
    return new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS pixels (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                profile_id TEXT,
                pixel_id TEXT,
                name TEXT,
                status TEXT,
                account_id TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            err => { if (err) return reject(err); resolve(); }
        );
    });
}

function ensureAdTemplatesTable(db) {
    return new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS ad_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE,
                config TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            err => { if (err) return reject(err); resolve(); }
        );
    });
}

// 🚀 性能优化：配置文件缓存
let profilesFileCache = null;
let profilesFileCacheTime = 0;
const PROFILES_CACHE_TTL = 60000; // 1分钟缓存

// 📁 读取配置文件函数（优化版）
async function loadProfilesFromFile() {
    try {
        // 检查缓存
        if (profilesFileCache && (Date.now() - profilesFileCacheTime) < PROFILES_CACHE_TTL) {
            log('DEBUG', `📁 使用缓存的配置文件数据: ${profilesFileCache.length} 个配置卡片`);
            return profilesFileCache;
        }

        const profilesPath = path.join(APP_ROOT, 'data', 'profiles.json');
        log('DEBUG', `📁 读取配置文件: ${profilesPath}`);
        
        const data = await fs.readFile(profilesPath, 'utf8');
        const profiles = JSON.parse(data);
        
        // 更新缓存
        profilesFileCache = profiles;
        profilesFileCacheTime = Date.now();
        
        log('INFO', `✅ 成功读取 ${profiles.length} 个配置卡片`);
        return profiles;
    } catch (error) {
        log('WARN', `⚠️ 读取配置文件失败: ${error.message}`);
        return [];
    }
}

// 🔍 根据ID查找配置卡片（优化版）
async function findProfileById(profileId) {
    log('DEBUG', `🔍 查找配置卡片: ${profileId}`);
    
    // 🚀 性能优化：使用数据库连接池
    const dbConnection = await mainDbPool.getConnection();
    
    try {
        // 首先尝试从主数据库的profiles表查找
        const dbProfile = await new Promise((resolve, reject) => {
            // 查询 adsplus.db 中的 profiles 表
            dbConnection.get(`SELECT id, name, account_name, account_email, account_password, account, 
                           start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host, proxy_port, 
                           proxy_username, proxy_password, account_notes, account_tokens, account_twofactor_secret,
                           account_cookies,
                           os, resolution, timezone, language, fb_language, fingerprint_protection,
                           fp_canvas, fp_webgl, fp_audio
                    FROM profiles WHERE id = ? OR name = ?`, [profileId, profileId], (err, row) => {
                if (err) {
                    // 如果字段不存在，可能初始化还没完成，直接记录但不崩溃
                    log('WARN', `⚠️ 查找配置卡片 SQL 失败: ${err.message}`);
                    resolve(null);
                    return;
                }
                
                if (row) {
                    log('DEBUG', `✅ 从主数据库找到配置卡片 ${profileId}`);
                    
                    // 优先使用 account_email，然后是 account，最后是 account_name
                    const accountField = row.account_email || row.account || row.account_name;
                    log('DEBUG', `🔑 账号字段映射完成，使用: ${accountField || '未设置'}`);
                    
                    // 构建代理配置
                    const proxyConfig = parseProxy(row.proxy, row);
                    
                    const profile = {
                        id: profileId,
                        name: row.name,
                        account: accountField, // 使用正确的账号字段
                        accountName: row.account_name || accountField, // 添加 accountName 字段
                        accountEmail: row.account_email, // 保持兼容性
                        accountPassword: row.account_password,
                        account_twofactor_secret: row.account_twofactor_secret || '', // 🚀 2FA 密钥
                        twoFactorSecret: row.account_twofactor_secret || '', // 🚀 2FA 别名
                        account_tokens: row.account_tokens || '', // 原始字段
                        token: row.account_tokens || '', // 映射为 token 供 API 使用
                        startUrl: row.start_url || 'https://www.facebook.com/',
                        userAgent: row.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        // 🍪 本地库里存的登录 Cookie：供「自动启动浏览器」在请求/缓存/云端都没有时兜底
                        accountCookies: (() => { try { const p = JSON.parse(row.account_cookies || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } })(),
                        // 🔌 proxy_enabled=0（用户已关闭代理）时本地代理必须视为 null：
                        //    否则快路径「有 token + 有代理 → 直接返回」会永远用本地旧代理，
                        //    用户在云端关了代理也不生效（实测 profileId=3960）
                        proxy: row.proxy_enabled === 0 ? null : proxyConfig,
                        proxyEnabled: row.proxy_enabled !== 0,
                        notes: row.account_notes || `配置卡片 ${row.name}`,
                        // 🧬 指纹参数
                        os: row.os || '',
                        resolution: row.resolution || '',
                        timezone: row.timezone || '',
                        language: row.language || '',
                        fbLanguage: row.fb_language || 'en_US',
                        fingerprintProtection: (() => { try { return JSON.parse(row.fingerprint_protection || '{}'); } catch { return {}; } })(),
                        fpCanvas: row.fp_canvas || '',
                        fpWebgl: row.fp_webgl || '',
                        fpAudio: row.fp_audio || ''
                    };
                    
                    log('DEBUG', `✅ 配置卡片构建完成，账号: ${profile.account}`);

                    // 🧬 补齐自洽的设备画像：os / platform / 分辨率 / GPU / 核数 / 内存 / 语言。
                    //    以前 101 个配置这些字段全为空 → 启动时统一退回 1920x1080 + Win32 +
                    //    "Intel Iris OpenGL Engine"（那是 Mac 的格式），一百多个号共用一台机器画像。
                    //    这里按 profileId 确定性生成，只补空、不覆盖用户已配置的值。
                    //    ⚠️ 传 row.user_agent（原始值）而不是上面填了通用默认值的 profile.userAgent，
                    //       否则"UA 为空"会被误判成"已有 UA"，永远补不出差异化 UA。
                    let finalProfile = profile;
                    try {
                        const fpImage = normalizeProfileFingerprint(profileId, {
                            os: row.os || '',
                            resolution: row.resolution || '',
                            timezone: row.timezone || '',
                            language: row.language || '',
                            fbLanguage: row.fb_language || '',
                            userAgent: row.user_agent || '',
                            fingerprintProtection: profile.fingerprintProtection || {}
                        });
                        const mergedProtection = Object.assign({}, profile.fingerprintProtection || {}, {
                            webglVendor: fpImage.gpuVendor,
                            webglRenderer: fpImage.gpuRenderer,
                            cpuCores: fpImage.cpuCores,
                            deviceMemory: fpImage.deviceMemory,
                            pluginsCount: fpImage.pluginsCount
                        });
                        finalProfile = Object.assign({}, profile, {
                            os: fpImage.os,
                            platform: fpImage.platform,
                            resolution: `${fpImage.width}x${fpImage.height}`,
                            language: fpImage.language,
                            userAgent: fpImage.userAgent,
                            fingerprintProtection: mergedProtection
                        });
                        // ♻️ 固化到本地库那一行：这样列表/编辑配置里也能看到，不必等每次启动现算
                        const cols = [];
                        const args = [];
                        if (String(row.os || '') !== fpImage.os) { cols.push('os = ?'); args.push(fpImage.os); }
                        if (String(row.resolution || '') !== finalProfile.resolution) { cols.push('resolution = ?'); args.push(finalProfile.resolution); }
                        if (String(row.language || '') !== fpImage.language) { cols.push('language = ?'); args.push(fpImage.language); }
                        if (String(row.user_agent || '') !== fpImage.userAgent) { cols.push('user_agent = ?'); args.push(fpImage.userAgent); }
                        if (JSON.stringify(profile.fingerprintProtection || {}) !== JSON.stringify(mergedProtection)) {
                            cols.push('fingerprint_protection = ?');
                            args.push(JSON.stringify(mergedProtection));
                        }
                        if (cols.length) {
                            args.push(profileId);
                            dbConnection.run(
                                `UPDATE profiles SET ${cols.join(', ')} WHERE id = ?`,
                                args,
                                (updErr) => {
                                    if (updErr) log('WARN', `⚠️ 画像回写本地库失败 ${profileId}: ${updErr.message}`);
                                    else log('SUCCESS', `🧬 已补齐设备画像 ${profileId}: ${fpImage.os} ${finalProfile.resolution} ${fpImage.cpuCores}C/${fpImage.deviceMemory}G ${fpImage.language}`);
                                }
                            );
                        }
                    } catch (fpErr) {
                        log('WARN', `⚠️ 生成设备画像失败 ${profileId}: ${fpErr.message}`);
                    }

                    resolve(finalProfile);
                } else {
                    log('DEBUG', `❌ 主数据库中未找到配置卡片: ${profileId}`);
                    resolve(null);
                }
            });
        });
    
        // 🔑 本地库命中但没有 access token 时不能就此返回：本地库里往往只有「配置基础信息」
        //    （proxy / 指纹 / Cookie 等），token 是后续抽到才同步的。直接返回就会让所有需要
        //    token 的功能（认领/申请访问权限到 BM、发布广告…）报「缺少 Access Token」。
        //    实测 profileId=4142：本地库有记录但 account_tokens 为空，云端那条其实有 token。
        // ♻️ 把（从云端/缓存）补全到的代理写回本地库那一行。
        //    不回写的话，等本地库补上 token 后，「本地有 token 就直接返回」会再次拿到空代理 → 又不走代理。
        //    存储格式与 PUT /api/profiles/:id 完全一致：proxy 存 JSON 字符串 + 6 个结构化列
        //    （parseProxy 优先读 proxy_host，所以结构化列也必须写）。
        const backfillLocalProxy = async (px) => {
            if (!px || !px.host) return;
            try {
                await new Promise((resolve) => {
                    dbConnection.run(
                        `UPDATE profiles SET proxy = ?, proxy_enabled = 1, proxy_type = ?, proxy_host = ?, proxy_port = ?, proxy_username = ?, proxy_password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [JSON.stringify(px), String(px.type || ''), String(px.host || ''), String(px.port || ''), String(px.username || ''), String(px.password || ''), profileId],
                        (err) => { if (err) log('WARN', `⚠️ 代理回写本地库失败 ${profileId}: ${err.message}`); resolve(); }
                    );
                });
                log('SUCCESS', `♻️ 已把云端代理回写本地库 ${profileId}: ${px.host}:${px.port}`);
            } catch (e) {
                log('WARN', `⚠️ 代理回写本地库异常 ${profileId}: ${e.message}`);
            }
        };

        // 🧹 云端已关闭代理时清掉本地库残留的旧代理：不清的话快路径/合并会一直捡起旧值，
        //    用户在云端「关闭代理」后浏览器仍走旧代理（实测 profileId=3960）
        const clearLocalProxy = async () => {
            try {
                await new Promise((resolve) => {
                    dbConnection.run(
                        `UPDATE profiles SET proxy = NULL, proxy_enabled = 0, proxy_type = NULL, proxy_host = NULL, proxy_port = NULL, proxy_username = NULL, proxy_password = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [profileId],
                        (err) => { if (err) log('WARN', `⚠️ 清除本地代理失败 ${profileId}: ${err.message}`); resolve(); }
                    );
                });
                log('SUCCESS', `🧹 云端已关闭代理，本地库代理已清除 ${profileId}`);
            } catch (e) {
                log('WARN', `⚠️ 清除本地代理异常 ${profileId}: ${e.message}`);
            }
        };

        const dbProfileHasToken = !!(dbProfile && (dbProfile.account_tokens || dbProfile.token));
        // 🐛 快路径必须**同时**要求「代理不为空」：实测本地 50 条里有 20 条 proxy_host 是空的（其中 5 条有 token）。
        //    以前只判 token 就直接返回 → 这些配置永远走不到云端补代理，启动时按无代理跑（目录名 _no_proxy）。
        //    代理为空的才放行，去缓存/云端补，并回写本地库。
        const dbProfileProxyMissing = !(dbProfile && dbProfile.proxy && dbProfile.proxy.host);
        if (dbProfile && dbProfileHasToken && !dbProfileProxyMissing) {
            return dbProfile;
        }
        if (dbProfile && dbProfileHasToken && dbProfileProxyMissing) {
            log('WARN', `⚠️ 本地库配置 ${profileId} 代理为空，继续向云端/缓存补取代理（本地已有 token）`);
        }
        if (dbProfile && !dbProfileHasToken) {
            log('WARN', `⚠️ 本地库配置 ${profileId} 没有 access token，继续向云端补取`);
        }
        
        // 🚀 降级处理：如果本地数据库没找到，尝试从云端存储服务获取（优先命中本地缓存）
        const cachedEntry = await readCloudProfileCache(profileId);
        // 🔑 缓存里没有 access token 就不算命中：这种缓存会把「创建主页 / 发布广告」卡在
        //    missing_token 上（实测 profileId=4335），而云端那条记录其实是有 token 的。
        //    缺 token 时宁可多打一次云端，也不要用坏缓存。
        const cachedHasToken = !!(cachedEntry && cachedEntry.profile && (cachedEntry.profile.account_tokens || cachedEntry.profile.token));
        if (cachedEntry && !cachedHasToken) {
            log('WARN', `⚠️ 云端配置缓存 ${profileId} 里没有 access token，绕过缓存重新向云端拉取`);
        }
        if (cachedHasToken && (Date.now() - cachedEntry.fetchedAt) < CLOUD_PROFILE_CACHE_TTL_MS) {
            log('INFO', `⚡ 命中云端配置缓存 ${profileId}（缓存于 ${Math.round((Date.now() - cachedEntry.fetchedAt) / 1000)} 秒前），跳过云端请求`);
            // 本地代理为空、而缓存里有 → 顺手回写本地库，让快路径尽快恢复（零网络成本）
            if (dbProfileProxyMissing) await backfillLocalProxy(cachedEntry.profile && cachedEntry.profile.proxy);
            return structuredClone(cachedEntry.profile);
        }

        log('INFO', `🌐 本地没有可用的（带 token 的）配置 ${profileId}，尝试从云端获取...`);
        try {
            const storageUrl = process.env.STORAGE_SERVER_URL || '';
            const secret = process.env.PUPPETEER_API_SECRET || '';
            
            // 💡 改进：增加 AbortController 超时保护，防止 fetch 无限等待
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const resp = await fetch(`${storageUrl}/api/profiles/${profileId}`, {
                headers: { 
                    'Authorization': `Bearer ${secret}`,
                    'X-Api-Secret': secret
                },
                signal: controller.signal
            });
            clearTimeout(timeout);
            
            const result = await resp.json();
            if (result.success && result.data) {
                const cloudProfile = {
                    id: profileId,
                    name: result.data.name,
                    account: result.data.account?.email || result.data.account?.name || '',
                    accountName: result.data.account?.name || '',
                    accountEmail: result.data.account?.email || '',
                    accountPassword: result.data.account?.password || '',
                    account_twofactor_secret: result.data.account?.twoFactorSecret || result.data.account_twofactor_secret || result.data.twoFactorSecret || '', // 🚀 2FA 密钥
                    twoFactorSecret: result.data.account?.twoFactorSecret || result.data.account_twofactor_secret || result.data.twoFactorSecret || '', // 🚀 2FA 别名
                    account_tokens: result.data.account_tokens || result.data.token || '', // 兼容多字段
                    token: result.data.token || result.data.account_tokens || '',
                    startUrl: result.data.startupUrls?.[0] || 'https://www.facebook.com/',
                    userAgent: result.data.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    // 🍪 云端的登录 Cookie（与前端 payload 里的 profile.account.cookies 同源）
                    accountCookies: (() => { const c = result.data.account?.cookies; if (Array.isArray(c)) return c; if (typeof c === 'string' && c.trim()) { try { const p = JSON.parse(c); return Array.isArray(p) ? p : []; } catch { return []; } } return []; })(),
                    proxy: parseProxy(result.data.proxy),
                    // 🔌 云端的代理开关原样带上：proxyEnabled = 云端代理是否有效（有 host 才算开）
                    proxyEnabled: !!(parseProxy(result.data.proxy) || {}).host,
                    notes: result.data.notes || '',
                    // 🧬 指纹参数（云端可能没有，用空值兜底）
                    os: result.data.os || '',
                    resolution: result.data.resolution || '',
                    timezone: result.data.timezone || '',
                    language: result.data.language || '',
                    fbLanguage: result.data.fbLanguage || result.data.fb_language || 'en_US',
                    fingerprintProtection: (() => { try { return typeof result.data.fingerprintProtection === 'object' ? result.data.fingerprintProtection : JSON.parse(result.data.fingerprintProtection || '{}'); } catch { return {}; } })(),
                    fpCanvas: result.data.fpCanvas || result.data.fp_canvas || '',
                    fpWebgl: result.data.fpWebgl || result.data.fp_webgl || '',
                    fpAudio: result.data.fpAudio || result.data.fp_audio || ''
                };
                // 本地库已有基础信息（proxy/指纹等）时只把云端独有的 token / Cookie 补进去，
                // 避免云端缺字段反而把本地好的覆盖掉
                if (dbProfile) {
                    const merged = { ...dbProfile };
                    const ct = cloudProfile.account_tokens || cloudProfile.token || '';
                    if (ct) { merged.account_tokens = ct; merged.token = cloudProfile.token || ct; }
                    if ((!merged.accountCookies || merged.accountCookies.length === 0) && Array.isArray(cloudProfile.accountCookies) && cloudProfile.accountCookies.length > 0) {
                        merged.accountCookies = cloudProfile.accountCookies;
                    }
                    // 🐛 本地库那条的 proxy 可能是空的（实测 profileId=3959 存的是 `{}`），
                    //    而「本地优先」的合并以前只补 token/Cookie → 云端那条好好的 socks5 代理被丢弃，
                    //    启动时按「无代理」创建（目录名可看到 _no_proxy），账号直接走本机 IP。
                    //    这里对称地补一次：本地代理缺 host 而云端有 → 用云端的。
                    // 🔌 代理统一以云端为准：用户在前端改代理/关代理后，本地库的旧值不能再压住云端的新值
                    //    （实测 profileId=3960：云端已 proxyEnabled=false，本地库残留旧代理 → 启动永远走旧代理）
                    if (cloudProfile.proxy && cloudProfile.proxy.host) {
                        if (!merged.proxy || merged.proxy.host !== cloudProfile.proxy.host || String(merged.proxy.port) !== String(cloudProfile.proxy.port)) {
                            log('INFO', `🔌 代理以云端为准 ${profileId}: ${cloudProfile.proxy.host}:${cloudProfile.proxy.port}`);
                        }
                        merged.proxy = cloudProfile.proxy;
                        merged.proxyEnabled = true;
                        // ♻️ 固化到本地库那一行
                        await backfillLocalProxy(merged.proxy);
                    } else if (merged.proxy && merged.proxy.host) {
                        // 云端明确无代理（proxyEnabled=false / proxy 为空）→ 清掉本地旧值，浏览器直连
                        log('INFO', `🔌 云端已关闭代理，清除本地旧代理 ${profileId}: ${merged.proxy.host}:${merged.proxy.port}`);
                        merged.proxy = null;
                        merged.proxyEnabled = false;
                        await clearLocalProxy();
                    }
                    await writeCloudProfileCache(profileId, merged);
                    log('SUCCESS', `✅ 已用云端数据补全本地配置 ${profileId}（access token ${ct ? '已补到' : '云端也没有'}）`);
                    return merged;
                }
                await writeCloudProfileCache(profileId, cloudProfile);
                log('SUCCESS', `✅ 从云端成功获取到配置卡片 ${profileId}`);
                return cloudProfile;
            } else {
                log('WARN', `❌ 云端返回失败: ${JSON.stringify(result)}`);
            }
        } catch (e) {
            log('WARN', `⚠️ 尝试从云端获取配置失败: ${e.message}`);
        }
        
        // 云端不可用（超时/5xx）时降级使用陈旧缓存，避免配置缺失导致浏览器无法启动
        if (cachedEntry) {
            log('WARN', `⚠️ 云端不可用，降级使用本地缓存配置卡片 ${profileId}（缓存于 ${Math.round((Date.now() - cachedEntry.fetchedAt) / 60000)} 分钟前）`);
            return structuredClone(cachedEntry.profile);
        }

        // 云端也没拿到时，至少把本地库那条返回（有代理/指纹还能启浏览器，比 null 强）
        if (dbProfile) {
            log('WARN', `⚠️ 云端也没能补到 access token，退回本地库配置 ${profileId}`);
            return dbProfile;
        }

        log('WARN', `⚠️ 最终未能找到配置卡片: ${profileId}`);
        return null;
    } finally {
        // 🚀 性能优化：释放数据库连接
        mainDbPool.releaseConnection(dbConnection);
    }
}

// 🔐 自动填充密码函数（优化版）
async function autoFillPasswordOnPage(page, profile, profileId) {
    try {
        log('DEBUG', `🔐 开始为页面自动填充密码 - Profile ID: ${profileId}`);
        
        // 直接使用 profile.accountName 作为账号
        const finalUsername = profile?.accountName || profile?.account || '';
        const accountPassword = profile?.accountPassword || '';
        
        if (!finalUsername || !accountPassword) {
            log('WARN', `⚠️ 配置卡片 ${profileId} 缺少账号或密码信息，跳过自动填充`);
            return false;
        }
        
        log('DEBUG', `🔐 准备自动填充凭证: ${finalUsername}`);
        
        // 等待页面加载完成
        log('DEBUG', '⏳ 等待页面加载完成...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        log('DEBUG', '✅ 页面等待完成');
        
        // 获取当前页面URL用于调试
        const currentUrl = page.url();
        log('DEBUG', `📄 当前页面URL: ${currentUrl}`);
        
        // 在页面上下文中查找并填充登录表单
        if (page.isClosed && page.isClosed()) {
            return false;
        }
        const result = await page.evaluate(async (username, password) => {
            try {
                console.log(`🔑 使用配置的账号: ${username}`);
                
                // 🔍 增强的表单检测逻辑 - 查找用户名输入框
                const usernameSelectors = [
                    // 标准属性
                    'input[name="email"]',
                    'input[type="email"]',
                    'input[name="username"]',
                    'input[name="user"]',
                    'input[name="login"]',
                    'input[name="account"]',
                    'input[id="email"]',
                    'input[id="username"]',
                    'input[id="user"]',
                    'input[id="login"]',
                    'input[id="account"]',
                    // 自动完成属性
                    'input[autocomplete="username"]',
                    'input[autocomplete="email"]',
                    // 占位符文本
                    'input[placeholder*="email" i]',
                    'input[placeholder*="username" i]',
                    'input[placeholder*="用户名" i]',
                    'input[placeholder*="邮箱" i]',
                    'input[placeholder*="账号" i]',
                    // 类名
                    'input.username',
                    'input.email',
                    'input.login',
                    'input.account',
                    // 通用文本输入框（在登录表单中）
                    'form input[type="text"]:first-of-type',
                    'form input:not([type]):first-of-type'
                ];
                
                let usernameInput = null;
                for (const selector of usernameSelectors) {
                    try {
                        usernameInput = document.querySelector(selector);
                        if (usernameInput && usernameInput.type !== 'hidden') {
                            console.log(`🎯 找到用户名输入框: ${selector}`);
                            break;
                        }
                    } catch (e) {
                        // 忽略选择器错误，继续尝试下一个
                    }
                }
                
                // 🔍 增强的表单检测逻辑 - 查找密码输入框
                const passwordSelectors = [
                    // 标准密码字段
                    'input[type="password"]',
                    'input[name="password"]',
                    'input[name="pass"]',
                    'input[name="passwd"]',
                    'input[name="pwd"]',
                    'input[id="password"]',
                    'input[id="pass"]',
                    'input[id="passwd"]',
                    'input[id="pwd"]',
                    // 自动完成属性
                    'input[autocomplete="current-password"]',
                    'input[autocomplete="password"]',
                    // 占位符文本
                    'input[placeholder*="password" i]',
                    'input[placeholder*="密码" i]',
                    // 类名
                    'input.password',
                    'input.pass',
                    'input.pwd'
                ];
                
                let passwordInput = null;
                for (const selector of passwordSelectors) {
                    try {
                        passwordInput = document.querySelector(selector);
                        if (passwordInput) {
                            console.log(`🎯 找到密码输入框: ${selector}`);
                            break;
                        }
                    } catch (e) {
                        // 忽略选择器错误，继续尝试下一个
                    }
                }
                
                if (!usernameInput && !passwordInput) {
                    return { 
                        success: false, 
                        error: '未找到登录表单元素' 
                    };
                }
                
                let filledFields = [];
                

                
                // 填充用户名 - 模拟真实用户输入
                if (usernameInput && !usernameInput.value) {
                    usernameInput.focus();
                    
                    // 模拟逐字符输入
                    usernameInput.value = '';
                    for (let i = 0; i < username.length; i++) {
                        usernameInput.value += username[i];
                        usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                        await new Promise(resolve => setTimeout(resolve, 30));
                    }
                    
                    usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
                    usernameInput.blur();
                    filledFields.push('username');
                    console.log(`✅ 已填充用户名: ${username}`);
                }
                
                // 等待一小段时间，模拟用户操作间隔
                await new Promise(resolve => setTimeout(resolve, 200));
                
                // 填充密码 - 模拟真实用户输入
                if (passwordInput && !passwordInput.value) {
                    passwordInput.focus();
                    
                    // 模拟逐字符输入密码
                    passwordInput.value = '';
                    for (let i = 0; i < password.length; i++) {
                        passwordInput.value += password[i];
                        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                        await new Promise(resolve => setTimeout(resolve, 40));
                    }
                    
                    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
                    passwordInput.blur();
                    filledFields.push('password');
                    console.log(`✅ 已填充密码`);
                }
                

                
                return { 
                    success: true, 
                    filledFields: filledFields,
                    usernameFound: !!usernameInput,
                    passwordFound: !!passwordInput
                };
                
            } catch (error) {
                return { success: false, error: error.message };
            }
        }, finalUsername, accountPassword);
        
        if (result.success) {
            console.log(`✅ 自动填充完成: ${result.filledFields.join(', ')}`);
            console.log(`📊 表单元素: 用户名=${result.usernameFound}, 密码=${result.passwordFound}`);
            try { await new Promise(r => setTimeout(r, 300)); } catch {}
            try {
                const clickInfo = await page.evaluate(async () => {
                    const url = String(location.href || '');
                    if (!/login|signin|login\.php/i.test(url)) return { clicked: false, method: 'skip' };
                    const visible = (el) => {
                        const cs = getComputedStyle(el);
                        return cs && cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
                    };
                    const qs = (s) => Array.from(document.querySelectorAll(s));
                    const norm = (s) => String(s || '').trim().toLowerCase();
                    const btns = [
                        ...qs('button[type="submit"]'),
                        ...qs('input[type="submit"]'),
                        ...qs('#loginbutton'),
                        ...qs('button[name="login"]'),
                        ...qs('[data-testid*="login" i]')
                    ];
                    let target = btns.find(b => visible(b) && (/登录|log in|signin|sign in|登入/i.test(norm(b.textContent)) || /登录|log in|signin|sign in|登入/i.test(norm(b.getAttribute('aria-label')))));
                    if (!target) target = btns.find(b => visible(b));
                    if (target) {
                        try { target.scrollIntoView({ block: 'center' }); } catch {}
                        try { target.click(); } catch {}
                        return { clicked: true, method: 'button' };
                    }
                    const pwd = document.querySelector('input[type="password"]');
                    let form = null;
                    if (pwd) form = pwd.form || pwd.closest('form');
                    if (!form) {
                        const user = document.querySelector('input[name="email"], input[name="username"], input[type="email"]');
                        if (user) form = user.form || user.closest('form');
                    }
                    if (form) {
                        try { form.submit(); } catch {}
                        try { form.dispatchEvent(new Event('submit', { bubbles: true })); } catch {}
                        return { clicked: true, method: 'form' };
                    }
                    if (pwd) {
                        try { pwd.focus(); } catch {}
                        try { document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); } catch {}
                        return { clicked: true, method: 'enter' };
                    }
                    return { clicked: false };
                });
                console.log(`🔘 登录点击: ${clickInfo && clickInfo.clicked ? '已触发' : '未找到按钮'}${clickInfo && clickInfo.method ? `（${clickInfo.method}）` : ''}`);
            } catch (e) { console.warn('登录点击失败', e && e.message ? e.message : String(e)); }
            if (page && !page.isClosed() && /login|signin|login\.php/i.test(String(page.url()||''))) {
                /*
                    const selectors = ['button[name="login"]', '#loginbutton', 'button[type="submit"]', 'input[type="submit"]', '[data-testid*="login" i]'];
                    for (const s of selectors) {
                        try {
                            await page.waitForSelector(s, { timeout: 1500, visible: true });
                            const el = await page.$(s);
                            if (el) { try { await el.click({ delay: 20 }); } catch {} }
                            break;
                        } catch {}
                    }
                */
                try { await page.keyboard.press('Enter'); } catch {}
            }
            try { await new Promise(r => setTimeout(r, 500)); } catch {}
            return true;
        } else {
            console.warn(`⚠️ 自动填充失败: ${result.error}`);
            return false;
        }
        
    } catch (error) {
        console.error(`❌ 自动填充密码失败:`, error.message);
        return false;
    }
}

// ============================================================
// 模块导出
// ============================================================
module.exports = {
    __inject,
    DatabasePool,
    initDatabase,
    ensureAdAccountsTable,
    ensurePagesTable,
    ensureBusinessesTable,
    ensureAdsTable,
    ensurePaymentTokensTable,
    ensurePixelsTable,
    ensureAdTemplatesTable,
    loadProfilesFromFile,
    findProfileById,
    autoFillPasswordOnPage,
    probeConnectivity,
    db,
    mainDbPool,
    credentialsDb,
    dbPath,
    BROWSER_PROFILES_ROOT,
};
