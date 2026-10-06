require('dotenv').config();
const path = require('path');
const fsSync = require('fs');
const fs = require('fs').promises;
const net = require('net');
const { SocksClient } = require('socks');

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

// 🎭 本地 SOCKS5 代理转发器：用于解决 Chrome 不支持 SOCKS5 认证的问题
// 原理：在本地起一个无需认证的 SOCKS5 代理，通过 v2ray(127.0.0.1:10808) 连接到远程认证代理
// 架构: Chrome → 本地隧道(无认证) → socks库 → v2ray(10808) → 远程SOCKS5(带认证) → 目标网站
const localSocksProxies = new Map();
const V2RAY_HOST = process.env.V2RAY_HOST || '127.0.0.1';
const V2RAY_PORT = parseInt(process.env.V2RAY_PORT || '10808');

// 🌐 全局代理设置：所有支持 ALL_PROXY 的外部请求通过 v2ray 隧道
// NO_PROXY 排除内部服务（localhost、指纹浏览器本地 API）
process.env.ALL_PROXY = `socks5h://${V2RAY_HOST}:${V2RAY_PORT}`;
process.env.NO_PROXY = '127.0.0.1,localhost,0.0.0.0,192.168.,10.,172.16.,::1';

function startLocalSocksProxy(targetHost, targetPort, username, password) {
    const key = `${targetHost}:${targetPort}`;
    if (localSocksProxies.has(key)) return localSocksProxies.get(key);
    
    return new Promise((resolve, reject) => {
        const server = net.createServer((clientConn) => {
            clientConn.once('error', () => {});
            
            // SOCKS5 握手（与 Chrome 客户端）
            clientConn.once('data', (buf) => {
                if (buf[0] !== 0x05) { clientConn.end(); return; }
                clientConn.write(Buffer.from([0x05, 0x00])); // 无认证
                
                // 等待客户端发送目标请求
                clientConn.once('data', (reqBuf) => {
                    if (reqBuf[0] !== 0x05 || reqBuf[1] !== 0x01) { clientConn.end(); return; }
                    
                    const addrType = reqBuf[3];
                    let dstHost, dstPort;
                    if (addrType === 0x01) {
                        dstHost = `${reqBuf[4]}.${reqBuf[5]}.${reqBuf[6]}.${reqBuf[7]}`;
                        dstPort = reqBuf.readUInt16BE(8);
                    } else if (addrType === 0x03) {
                        const nl = reqBuf[4];
                        dstHost = reqBuf.toString('utf-8', 5, 5 + nl);
                        dstPort = reqBuf.readUInt16BE(5 + nl);
                    } else { clientConn.end(); return; }
                    
                    // 第1跳：原始 TCP → v2ray(127.0.0.1:10808)，请求连接到远程代理
                    const v2ray = net.createConnection({ host: V2RAY_HOST, port: V2RAY_PORT, timeout: 10000 }, () => {
                        // SOCKS5 握手 → v2ray
                        v2ray.write(Buffer.from([0x05, 0x01, 0x00])); // 无认证
                        v2ray.once('data', (v2rayHandshake) => {
                            if (v2rayHandshake[0] !== 0x05 || v2rayHandshake[1] !== 0x00) { v2ray.end(); clientConn.end(); return; }
                            
                            // 请求 v2ray 连接到远程 SOCKS5 代理
                            const v2rayReq = buildSocks5ConnectReq(targetHost, Number(targetPort));
                            v2ray.write(v2rayReq);
                            v2ray.once('data', (v2rayResp) => {
                                if (v2rayResp[0] !== 0x05 || v2rayResp[1] !== 0x00) { v2ray.end(); clientConn.end(); return; }
                                
                                // ✅ 第1跳成功！通过 v2ray 连接到远程代理
                                // 第2跳：通过 v2ray 隧道 → 远程 SOCKS5 代理认证
                                // 发送 SOCKS5 握手到远程代理（通过 v2ray 隧道）
                                const ru = Buffer.from(username, 'utf-8');
                                const rp = Buffer.from(password, 'utf-8');
                                const authData = Buffer.alloc(3 + ru.length + rp.length);
                                authData[0] = 0x01; authData[1] = ru.length;
                                ru.copy(authData, 2);
                                authData[2 + ru.length] = rp.length;
                                rp.copy(authData, 3 + ru.length);
                                
                                // 发送握手（无认证 + 密码认证选项）+ 等待远程代理选择
                                v2ray.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
                                v2ray.once('data', (remoteHandshake) => {
                                    if (remoteHandshake[1] === 0x02) {
                                        // 远程代理选择密码认证
                                        v2ray.write(authData);
                                        v2ray.once('data', (authRes) => {
                                            if (authRes[1] !== 0x00) { v2ray.end(); clientConn.end(); return; }
                                            // 认证通过，发送目标请求
                                            remoteSendTarget(v2ray, dstHost, dstPort, clientConn);
                                        });
                                    } else if (remoteHandshake[1] === 0x00) {
                                        remoteSendTarget(v2ray, dstHost, dstPort, clientConn);
                                    } else {
                                        v2ray.end(); clientConn.end();
                                    }
                                });
                            });
                        });
                    });
                    v2ray.on('error', () => { clientConn.end(); });
                    v2ray.on('timeout', () => { v2ray.destroy(); clientConn.end(); });
                });
            });
        });
        
        function buildSocks5ConnectReq(host, port) {
            const pb = Buffer.alloc(2); pb.writeUInt16BE(port, 0);
            if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
                return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(host.split('.').map(Number)), pb]);
            }
            const hb = Buffer.from(host, 'utf-8');
            return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, pb]);
        }
        
        function remoteSendTarget(remote, host, port, client) {
            const req = buildSocks5ConnectReq(host, port);
            remote.write(req);
            remote.once('data', (res) => {
                if (res[0] === 0x05 && res[1] === 0x00) {
                    const reply = Buffer.alloc(10);
                    reply[0] = 0x05; reply[1] = 0x00; reply[2] = 0x00; reply[3] = 0x01;
                    reply.writeUInt32BE(0x7f000001, 4); reply.writeUInt16BE(port, 8);
                    client.write(reply);
                    client.pipe(remote); remote.pipe(client);
                } else { client.end(); }
            });
        }
        
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            localSocksProxies.set(key, port);
            log('INFO', `🔌 本地 SOCKS5 隧道: 127.0.0.1:${port} → v2ray(${V2RAY_HOST}:${V2RAY_PORT}) → ${targetHost}:${targetPort}`);
            resolve(port);
        });
        server.on('error', reject);
    });
}

// 🎭 指纹浏览器本地 API 客户端 — 通过本地 API (50325) 启动隔离浏览器环境
async function omnifpRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, 'http://localhost:50325');
        const lib = require('http');
        const opt = { hostname: url.hostname, port: url.port || 50325, path: url.pathname + (url.search || ''), method, timeout: 15000, headers: { 'Content-Type': 'application/json' } };
        const req = lib.request(opt, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ code: -1, msg: d }); } }); });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('指纹浏览器 API 超时')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const { exec, spawn, execSync } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
// 🎭 Playwright 替代 Puppeteer
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const https = require('https');
const http = require('http');
const tokenProvider = require('./payment/token-provider');
const adposClient = require('./integrations/adpos-client');
const SCREENSHOT_DIR = path.join(__dirname, 'logs', 'screenshots');

if (process.env.QUIET_LOGS === 'true') {
    console.log = () => {};
    console.debug = () => {};
}

// 🚀 性能优化：日志级别控制
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO'; // DEBUG, INFO, WARN, ERROR
const logLevels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// 🚀 性能优化：记录直连失败的配置，避免重复等待超时
const directConnectionFailures = new Set();
// 定期清理失败记录 (例如每小时)，给网络恢复留出机会
setInterval(() => directConnectionFailures.clear(), 3600000);

/**
 * 🚀 辅助函数：统一代理解析逻辑
 */
function parseProxy(proxyInput, row = null) {
    // 1. 优先使用 row 中的结构化字段 (如果存在)
    if (row && row.proxy_host && row.proxy_host.trim()) {
        return {
            type: row.proxy_type || 'http',
            host: row.proxy_host,
            port: row.proxy_port || 8080,
            username: row.proxy_username || '',
            password: row.proxy_password || ''
        };
    }
    
    // 2. 解析字符串输入
    if (typeof proxyInput === 'string' && proxyInput.trim()) {
        const p = proxyInput.trim();
        try {
            // JSON 格式
            if (p.startsWith('{')) return JSON.parse(p);
            
            // 处理带协议的格式: protocol://[user:pass@]host:port
            if (p.includes('://')) {
                const url = new URL(p);
                return {
                    type: url.protocol.replace(':', ''),
                    host: url.hostname,
                    port: url.port || (url.protocol === 'https:' ? 443 : 80),
                    username: url.username || '',
                    password: url.password || ''
                };
            }

            // 处理 user:pass@host:port 格式
            if (p.includes('@')) {
                const [auth, hostPort] = p.split('@');
                const [user, pass] = auth.split(':');
                const [host, port] = hostPort.split(':');
                return {
                    host,
                    port: port || 8080,
                    username: user || '',
                    password: pass || '',
                    type: 'http'
                };
            }
            
            // 处理 host:port:user:pass 或 host:port 格式
            const parts = p.split(':');
            if (parts.length >= 2) {
                // 判断是否是 host:port:user:pass (SOCKS5 带认证格式)
                if (parts.length >= 4) {
                    return {
                        host: parts[0],
                        port: parts[1],
                        username: parts[2],
                        password: parts.slice(3).join(':'), // 支持密码包含冒号
                        type: 'socks5' // 🚀 SOCKS5 代理默认使用 socks5 类型
                    };
                }
                // 默认 host:port
                return {
                    host: parts[0],
                    port: parts[1],
                    username: '',
                    password: '',
                    type: 'socks5' // 🚀 默认为 socks5，兼容性更好
                };
            }
        } catch (e) {
            log('WARN', `[Proxy] 解析代理字符串失败: ${p}, 错误: ${e.message}`);
        }
    } 
    
    // 3. 如果已经是对象
    if (typeof proxyInput === 'object' && proxyInput !== null && proxyInput.host) {
        return proxyInput;
    }
    
    return null;
}

// 📁 浏览器隔离数据根目录 (可通环境变量修改)
const BROWSER_PROFILES_ROOT = process.env.BROWSER_PROFILES_ROOT || path.join(__dirname, '..', 'browser-profiles');

// 简易文件日志：既输出到控制台，也落盘到 backend/logs/service.log
const FILE_LOG_PATH = path.join(__dirname, 'logs', 'service.log');
const API_SECRET = process.env.PUPPETEER_API_SECRET || ''; // 🚀 安全加固：API 访问密钥

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

// 🚀 性能优化：配置缓存
class ProfileCache {
    constructor(ttl = 300000) { // 5分钟TTL
        this.cache = new Map();
        this.ttl = ttl;
    }

    set(key, value) {
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        
        return item.value;
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

// 初始化数据库连接池（新库名，无回退）
const dbPath = path.join(__dirname, 'data', 'omnifingerprint.db');
// 🗂️ 与 browser-manager.js 同口径：pkg 打包后根目录取 exe 所在目录（watch-active.json / 日志等按它定位）
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
const credentialsDbPath = path.join(__dirname, 'profiles.db');
const mainDbPool = new DatabasePool(dbPath, 3);
const credentialsDbPool = new DatabasePool(credentialsDbPath, 2);

// 初始化配置缓存
const profileCache = new ProfileCache();

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

const app = express();
// 🎭 Playwright 版本
const PORT = parseInt(process.env.PLAYWRIGHT_PORT || process.env.PUPPETEER_PORT || process.env.PORT || '8888', 10);
// 🚀 性能优化配置
const BROWSER_POOL_SIZE = 30; // 浏览器实例池大小（从20提升到30）
const MAX_CONCURRENT_LAUNCHES = parseInt(process.env.MAX_CONCURRENT_LAUNCHES || '5', 10); // 🚀 从 3 提升到 5，支持 multi-profile 秒开
const MEMORY_CLEANUP_INTERVAL = 30000; // 30秒内存清理间隔（从60秒缩短）
const BROWSER_PREWARM_COUNT = 2; // 🆕 预热浏览器实例数
const BROWSER_IDLE_TIMEOUT = 120000; // 🆕 闲置浏览器回收时间(2分钟)
const MAX_BROWSER_SYSTEM_MEMORY_MB = 4096; // 🆕 所有浏览器进程总内存上限(4GB)

// 中间件
app.use(cors({
    // 🚀 本机执行代理（9999）会被多个来源的前端调用 —— localhost 开发页、Cloudflare Pages、
    //    以及宝塔上的正式后端域名。origin: true = 反射请求方 Origin，
    //    不再维护白名单，否则换个域名就得改一次（旧白名单未含正式后端域名 → 预检缺 ACAO）。
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Api-Secret'],
    // ⚠️ preflightContinue 必须为 true：cors 库默认在 OPTIONS 时**直接结束响应**，
    //    下面那个中间件就跑不到 → Chrome 私网访问（PNA）要求的
    //    Access-Control-Allow-Private-Network 头丢失，表现为
    //    「https 页面 → http://localhost:9999」预检被浏览器拦下。
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
// 🧵 从 puppeteer-api-server.js 回移：前端把「监听主页/对话」的 profileId 上报到这里，
//    服务端只同步这些配置，不再扫描已删除/残留的目录。
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
                pages_count INTEGER,
                bm_count INTEGER,
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

        const profilesPath = path.join(__dirname, 'data', 'profiles.json');
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
    // 🚀 性能优化：检查缓存
    const cachedProfile = profileCache.get(profileId);
    if (cachedProfile) {
        log('DEBUG', `🚀 从缓存获取配置卡片: ${profileId}`);
        return cachedProfile;
    }

    log('DEBUG', `🔍 查找配置卡片: ${profileId}`);
    
    // 🚀 性能优化：使用数据库连接池
    const dbConnection = await mainDbPool.getConnection();
    
    try {
        // 首先尝试从主数据库的profiles表查找
        const dbProfile = await new Promise((resolve, reject) => {
            // 查询 adsplus.db 中的 profiles 表
            dbConnection.get(`SELECT id, name, account_name, account_email, account_password, account, 
                           start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host, proxy_port, 
                           proxy_username, proxy_password, account_notes, account_tokens
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
                        account_tokens: row.account_tokens || '', // 原始字段
                        token: row.account_tokens || '', // 映射为 token 供 API 使用
                        startUrl: row.start_url || 'https://www.facebook.com/',
                        userAgent: row.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        proxy: proxyConfig,
                        notes: row.account_notes || `配置卡片 ${row.name}`
                    };
                    
                    log('DEBUG', `✅ 配置卡片构建完成，账号: ${profile.account}`);
                    resolve(profile);
                } else {
                    log('DEBUG', `❌ 主数据库中未找到配置卡片: ${profileId}`);
                    resolve(null);
                }
            });
        });
    
        if (dbProfile) {
            // 🚀 性能优化：缓存结果
            profileCache.set(profileId, dbProfile);
            return dbProfile;
        }
        
        // 🚀 降级处理：如果本地数据库没找到，尝试从云端存储服务获取
        log('INFO', `🌐 本地数据库未找到配置卡片 ${profileId}，尝试从云端获取...`);
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
                    account_tokens: result.data.account_tokens || result.data.token || '', // 兼容多字段
                    token: result.data.token || result.data.account_tokens || '',
                    startUrl: result.data.startupUrls?.[0] || 'https://www.facebook.com/',
                    userAgent: result.data.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    proxy: parseProxy(result.data.proxy),
                    notes: result.data.notes || ''
                };
                log('SUCCESS', `✅ 从云端成功获取到配置卡片 ${profileId}`);
                profileCache.set(profileId, cloudProfile);
                return cloudProfile;
            } else {
                log('WARN', `❌ 云端返回失败: ${JSON.stringify(result)}`);
            }
        } catch (e) {
            log('WARN', `⚠️ 尝试从云端获取配置失败: ${e.message}`);
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

/**
 * 🚀 Facebook 广告发布 API
 */
app.post('/api/facebook/publish-ad', async (req, res) => {
    const { 
        profileId, campaignName, adSetName, adName, budget, adText, headline, websiteUrl, mediaBase64,
        countries, ageMin, ageMax, gender, placements, publishMethod,
        adAccountId, pageId, objective, budgetType, startDate, endDate,
        pixelId, conversionEvent, enableVO, devicePlatforms, osType, osVersionMin, wifiOnly,
        ctaType, enableAICreative, adFormat, leadFormId, messengerWelcomeMessage, engagementType
    } = req.body;
    
    log('INFO', `🔥 [Profile=${profileId}] 收到广告发布请求: Campaign=${campaignName}, Method=${publishMethod || 'api'}`);

    try {
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
                log('SUCCESS', `✅ [Profile=${profileId}] API 广告发布成功: AdID=${result.adId}`);
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
        
        const browser = bResult.browserData.context;
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
        log('ERROR', `❌ [Profile=${profileId}] 发布流程异常: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
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
    const effectiveToken = token || profile?.token;
    if (!effectiveToken) throw new Error('Access Token is required');
    if (!profile?.id) throw new Error('Profile ID is required for browser fallback');

    const base = 'https://graph.facebook.com/v21.0';
    const url = endpoint.startsWith('http') ? endpoint : `${base}/${endpoint.replace(/^\//, '')}`;

    // 🚀 修正：只有在允许启动或浏览器已经打开的情况下才继续
    const isRunning = await isProfileRunning(profile.id);
    if (!isRunning && !launchIfClosed) {
        log('WARN', `[GraphAPI] 浏览器未启动且 launchBrowser=false，跳过浏览器回退请求 (ProfileID: ${profile.id})`);
        throw new Error('浏览器未启动且已禁止自动唤醒，无法进行回退请求');
    }

    if (!isRunning && launchIfClosed) {
        log('INFO', `[GraphAPI] 浏览器未启动，正在根据 launchBrowser=true 自动唤醒 (ProfileID: ${profile.id})`);
    }

    const browserResult = await ensureBrowserIsRunning(profile.id);
    if (!browserResult.success) {
        throw new Error(browserResult.error || '无法启动浏览器进行 Graph API 回退');
    }

    const browser = browserResult.browserData.context;
    const pages = await browser.pages();
    let page = pages.find((p) => /facebook\.com|messenger\.com|instagram\.com/i.test(p.url())) || await browser.newPage();
    if (!/facebook\.com/i.test(page.url())) {
        await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    let payload = null;
    if (data instanceof URLSearchParams) {
        payload = Object.fromEntries(data.entries());
    } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        payload = { ...data };
    }

    log('INFO', `[GraphAPI] 切换浏览器上下文重试: ${method} ${url.split('?')[0]} (ProfileID: ${profile.id})`);

    const json = await page.evaluate(async ({ requestUrl, requestMethod, requestPayload, accessToken }) => {
        // 🚀 在浏览器上下文中重新定义序列化逻辑
        const serializeValue = (val) => {
            if (val === undefined || val === null) return null;
            if (typeof val === 'string') return val;
            if (typeof val === 'number' || typeof val === 'boolean') return String(val);
            if (Array.isArray(val) || typeof val === 'object') return JSON.stringify(val);
            return String(val);
        };

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
                urlObj.searchParams.set('access_token', accessToken);
                finalUrl = urlObj.toString();
            } else {
                const hasBase64Bytes = Boolean(requestPayload && typeof requestPayload.bytes !== 'undefined');
                if (hasBase64Bytes) {
                    // adimages 的 bytes 字段要求传原始 Base64 字符串
                    const params = new URLSearchParams();
                    params.set('access_token', accessToken);
                    for (const [key, value] of Object.entries(requestPayload || {})) {
                        const serializedValue = serializeValue(value);
                        if (serializedValue === null) continue;
                        params.set(key, serializedValue);
                    }
                    options.body = params;
                } else {
                    const form = new FormData();
                    form.append('access_token', accessToken);

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

            const resp = await fetch(finalUrl, options);
            const text = await resp.text();

            try {
                return JSON.parse(text);
            } catch (parseErr) {
                return {
                    error: {
                        message: `Browser fetch returned non-JSON response (HTTP ${resp.status}): ${text.slice(0, 500)}`,
                        type: 'BrowserFetchParseError'
                    }
                };
            }
        } catch (err) {
            return {
                error: {
                    message: err.message || 'Unknown browser fetch error',
                    type: 'BrowserFetchError'
                }
            };
        }
    }, {
        requestUrl: url,
        requestMethod: method,
        requestPayload: payload,
        accessToken: effectiveToken
    });

    if (json?.error) {
        log('WARN', `[GraphAPI] 浏览器上下文返回错误: ${json.error.message} (${json.error.code || json.error.type || 'NO_CODE'})`);
    } else {
        log('INFO', `[GraphAPI] 浏览器上下文请求成功: ${method} ${url.split('?')[0]}`);
    }

    return json;
}

/**
 * 🛠️ 辅助函数：通过 curl 执行 Facebook Graph API 调用（支持代理）
 * 🚀 优化：使用 spawn + stdin 避免命令行长度限制 (ENAMETOOLONG)
 * 🚀 新增：当系统网络无法直连 Facebook 时，自动切换到浏览器上下文 fetch 回退
 */
async function callFacebookGraphApi(endpoint, method = 'GET', data = null, profile = null, token = null) {
    const effectiveToken = token || profile?.token;
    if (!effectiveToken) throw new Error('Access Token is required');

    const base = 'https://graph.facebook.com/v21.0'; // 🚀 修正：回退到稳定版本 v21.0 (v25.0 暂不存在或有 AppID 限制)
    const url = endpoint.startsWith('http') ? endpoint : `${base}/${endpoint.replace(/^\//, '')}`;
    
    const urlObj = new URL(url);
    const finalUrl = urlObj.toString();

    const args = ['-s', '-S', '-L', '-v', finalUrl]; 
    
    // 🚀 代理检测与全局兜底
    let proxyInput = profile?.proxy;
    
    // 如果 profile 没代理，尝试从 .env 或全局配置获取 (假设存在 GLOBAL_PROXY 变量)
    if (!proxyInput && process.env.GLOBAL_PROXY) {
        proxyInput = process.env.GLOBAL_PROXY;
        log('INFO', `[GraphAPI] Profile 缺少代理，使用全局代理兜底: ${proxyInput}`);
    }

    const proxy = parseProxy(proxyInput);
    if (proxy && proxy.host) {
        const pType = String(proxy.type || 'http').toLowerCase();
        
        // 🎭 SOCKS5 带认证 → 通过 v2ray 隧道中转（否则 curl 直连远程代理会超时）
        if (pType.startsWith('socks5') && proxy.username && proxy.password) {
            try {
                const localPort = await startLocalSocksProxy(proxy.host, Number(proxy.port), proxy.username, proxy.password);
                args.push('--proxy', `socks5h://127.0.0.1:${localPort}`);
                // 记录隧道key，curl 完成后清理
                args._v2rayTunnelKey = `${proxy.host}:${proxy.port}`;
                log('INFO', `[GraphAPI] 使用 v2ray 隧道代理: 127.0.0.1:${localPort} → ${proxy.host}:${proxy.port}`);
            } catch (tunnelErr) {
                log('WARN', `[GraphAPI] 创建 v2ray 隧道失败: ${tunnelErr.message}，跳过 curl，直接走浏览器上下文`);
                const launchBrowserFlag = data && typeof data === 'object' ? Boolean(data.launchBrowser !== false) : true;
                return callFacebookGraphApiViaBrowser(endpoint, method, data, profile, effectiveToken, launchBrowserFlag);
            }
        } else {
            // SOCKS5 无认证 / HTTP 代理 → 直接使用
            const pPrefix = pType.startsWith('socks5') ? 'socks5h' : pType;
            const proxyStr = `${pPrefix}://${proxy.username ? `${proxy.username}:${proxy.password}@` : ''}${proxy.host}:${proxy.port}`;
            args.push('--proxy', proxyStr);
            log('INFO', `[GraphAPI] 使用代理: ${pPrefix}://${proxy.host}:${proxy.port} (ProfileID: ${profile?.id || 'Global'})`);
        }
    } else {
        // 🚀 核心优化：如果已知该环境直连会超时，则直接跳过 curl 尝试，进入浏览器上下文
        if (profile?.id && directConnectionFailures.has(String(profile.id))) {
            const launchBrowserFlag = data && typeof data === 'object' ? Boolean(data.launchBrowser !== false) : true;
            log('WARN', `[GraphAPI] 检测到 ProfileID=${profile.id} 之前直连超时，跳过 curl 尝试，直接使用浏览器上下文。`);
            return callFacebookGraphApiViaBrowser(endpoint, method, data, profile, effectiveToken, launchBrowserFlag);
        }
        log('INFO', `[GraphAPI] 采用本地网络直连 Facebook (ProfileID: ${profile?.id || 'unknown'})`);
    }
    
    args.push('--connect-timeout', '10', '--max-time', '600'); // 缩短连接超时到 10s，减少等待焦虑
    
    let postBody = null;
    
    // 🚀 核心改进：按照 FB 文档改用 -F (multipart/form-data) 模式
    if (method !== 'GET') {
        args.push('-F', `access_token=${effectiveToken}`); // 始终通过 -F 传递 token

        if (data) {
            if (data instanceof URLSearchParams || (typeof data === 'object' && !Array.isArray(data))) {
                const params = data instanceof URLSearchParams ? data : null;
                const entries = params
                    ? Array.from(params.entries())
                    : Object.entries(data).map(([key, value]) => [key, serializeGraphApiValue(value)]);
                for (const [key, value] of entries) {
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

    log('INFO', `[GraphAPI] 执行 curl: ${method} ${url.split('?')[0]} (Using -F mode)`);
    
    // 🚀 修正：从 data 中提取 launchBrowser 标识，用于失败后的回退决策
    const launchBrowserFlag = data && typeof data === 'object' ? Boolean(data.launchBrowser !== false) : true;

    return new Promise((resolve, reject) => {
        const child = spawn('curl', args);
        let stdout = '';
        let stderr = '';
        let settled = false;

        // 🔌 清理 v2ray 隧道（如有）
        const cleanupTunnel = () => {
            const tunnelKey = args._v2rayTunnelKey;
            if (tunnelKey) {
                localSocksProxies.delete(tunnelKey);
                log('INFO', `[GraphAPI] 🔌 已清理 v2ray 隧道: ${tunnelKey}`);
                args._v2rayTunnelKey = null;
            }
        };

        const safeResolve = (value) => {
            if (settled) return;
            settled = true;
            cleanupTunnel();
            resolve(value);
        };

        const safeReject = (err) => {
            if (settled) return;
            settled = true;
            cleanupTunnel();
            reject(err);
        };

        const attemptBrowserFallback = async (reason) => {
            if (!profile?.id) {
                safeReject(new Error(reason));
                return;
            }

            // 🚀 修正：尊重 launchBrowserFlag 开关
            log('WARN', `[GraphAPI] curl 调用失败，准备切换浏览器上下文重试。原因: ${reason}`);
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

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });

        child.on('close', async (code) => {
            if (code !== 0) {
                log('ERROR', `[GraphAPI] curl 进程退出错误码 ${code}. 错误详情: ${stderr || '无额外信息'}`);
                
                // 🚀 记录失败状态：如果是超时 (28) 或连接失败 (7)，记录到 Set 中
                if (profile?.id && (code === 28 || code === 7 || stderr.includes('Timed out') || stderr.includes('Could not connect'))) {
                    directConnectionFailures.add(String(profile.id));
                    log('WARN', `[GraphAPI] 已将 ProfileID=${profile.id} 加入直连失败名单，后续将优先使用浏览器上下文。`);
                }

                await attemptBrowserFallback(`curl failed with code ${code}: ${stderr}`);
                return;
            }

            if (stdout && stdout.trim()) {
                try {
                    // 处理可能的 multipart 边界干扰或多个 JSON 响应
                    const cleanStdout = stdout.trim().split('\n').pop(); 
                    const json = JSON.parse(cleanStdout);
                    if (json.error) {
                        log('WARN', `[GraphAPI] 错误响应: ${json.error.message} (${json.error.code})`);
                    }
                    safeResolve(json);
                } catch (e) {
                    log('ERROR', `[GraphAPI] 解析响应 JSON 失败: ${e.message}. 原始输出: ${stdout.substring(0, 100)}...`);
                    safeReject(new Error(`Failed to parse API response: ${e.message}`));
                }
            } else {
                safeResolve({ success: true }); // 有些 POST 响应为空但成功
            }
        });

        child.on('error', async (err) => {
            log('ERROR', `[GraphAPI] 启动 curl 失败: ${err.message}`);
            await attemptBrowserFallback(`curl spawn failed: ${err.message}`);
        });
    });
}

/**
 * 🚀 Facebook Graph API 广告发布核心逻辑
 */
async function runFacebookPublishAdApi(data) {
    const { 
        profileId, campaignName, adSetName, adName, budget, adText, headline, websiteUrl, mediaBase64,
        countries, ageMin, ageMax, gender, placements,
        adAccountId, pageId, objective, budgetLevel, budgetType, startDate, endDate,
        pixelId, conversionEvent, enableVO, devicePlatforms, osType, osVersionMin, wifiOnly,
        ctaType, enableAdvantageCreative, enableAdvantageAudience, adFormat, leadFormId, messengerWelcomeMessage, engagementType,
        adDescription, adSchedule, 
        campaignCount = 1, adSetCount = 1, adCount = 1,
        campaignStatus, adSetStatus, adStatus,
        autoActivate, // 🚀 新增：两步发布模式
        useDisplayLink, displayLink, // 🚀 新增：显示链接
        launchBrowser, // 🚀 新增：发布前是否启动浏览器
        customerLifecycle, attributionSpec, costPerResult, attributionModel,
        languages, detailedTargeting, placementsControl, allowLimitedSpendOnExcluded,
        bidAmount, bidStrategy // 🚀 补全：竞价相关字段
    } = data;
    
    const results = [];
    try {
        log('INFO', `🎬 [Profile=${profileId}] 开始 API 发布流程: ${campaignName} (批量: ${campaignCount}x${adSetCount}x${adCount})`);
        
        // 1. 获取 Profile 详情及 Token
        const profile = await findProfileById(profileId);
        if (!profile || !profile.token) {
            throw new Error('未找到该环境的 Access Token，请先执行“获取TOKEN”操作');
        }

        // 🚀 核心优化：根据开关决定是否预先启动浏览器
        // 注意：上游 /api/facebook/publish-ad handler 已经执行过 ensureBrowserIsRunning，
        // 此处作为兜底二次确认，使用 ensureBrowserIsRunning 保证浏览器状态。
        if (launchBrowser) {
            log('INFO', `🌐 [Profile=${profileId}] 正在根据设置二次确认浏览器状态...`);
            try {
                const brResult = await ensureBrowserIsRunning(profileId);
                if (brResult.success) {
                    log('SUCCESS', `✅ [Profile=${profileId}] 浏览器已就绪。`);
                } else {
                    log('WARN', `⚠️ [Profile=${profileId}] 浏览器自动唤醒失败: ${brResult.error}，继续 API 发布流程...`);
                }
            } catch (launchErr) {
                log('WARN', `⚠️ [Profile=${profileId}] 浏览器状态确认异常: ${launchErr.message}，继续发布流程...`);
            }
        }

        const formatFBError = (res) => {
            if (!res || !res.error) return JSON.stringify(res);
            const err = res.error;
            // 🚀 优先返回 Facebook 提供的用户友好提示
            return err.error_user_msg || err.message || JSON.stringify(err);
        };
        
        // 校验基础参数
        if (!budget || isNaN(parseFloat(budget))) {
            throw new Error('预算金额无效');
        }
        if (!campaignName || !adSetName || !adName) {
            throw new Error('广告系列/组/素材名称不能为空');
        }

        const token = profile.token;
        
        // 2. 确定广告账户
        let actId = adAccountId;
        if (!actId) {
            log('INFO', `🔍 [Profile=${profileId}] 正在获取可用广告账户...`);
            const accountsData = await callFacebookGraphApi('me/adaccounts?fields=account_id,name,account_status', 'GET', null, profile);
            if (accountsData.data && accountsData.data.length > 0) {
                const adAccount = accountsData.data.find(a => a.account_status === 1) || accountsData.data[0];
                actId = `act_${adAccount.account_id}`;
            } else {
                throw new Error('未发现可用的广告账户');
            }
        } else if (!actId.startsWith('act_')) {
            actId = `act_${actId}`;
        }
        log('INFO', `🎯 [Profile=${profileId}] 使用广告账户: ${actId}`);

        // 3. 上传素材 (全局上传一次即可复用)
        let imageHash = null;
        if (mediaBase64) {
            log('INFO', `🖼️ [Profile=${profileId}] 正在上传广告素材 (Base64长度: ${mediaBase64.length})...`);
            const base64Data = mediaBase64.replace(/^data:image\/\w+;base64,/, "");
            const formData = new URLSearchParams();
            formData.append('bytes', base64Data);
            
            const uploadData = await callFacebookGraphApi(`${actId}/adimages`, 'POST', formData, profile);
            if (uploadData.images && Object.keys(uploadData.images).length > 0) {
                const firstKey = Object.keys(uploadData.images)[0];
                imageHash = uploadData.images[firstKey].hash;
                log('SUCCESS', `✅ [Profile=${profileId}] 素材上传成功: ${imageHash}`);
            } else {
                throw new Error(`素材上传失败: ${formatFBError(uploadData)}`);
            }
        }

        // --- 批量发布循环开始 ---
        for (let c = 0; c < campaignCount; c++) {
            const currentCampaignName = campaignCount > 1 ? `${campaignName}_${c + 1}` : campaignName;
            
            // 4. 创建广告系列 (Campaign)
            log('INFO', `🏗️ [Profile=${profileId}] 正在创建广告系列 [${c+1}/${campaignCount}]: ${currentCampaignName}`);
            const campaignBody = {
                name: currentCampaignName,
                objective: objective || 'OUTCOME_TRAFFIC',
                status: autoActivate ? 'PAUSED' : (campaignStatus || 'PAUSED'), // 🚀 两步模式强制先 PAUSED
                special_ad_categories: [] 
            };

            // 🚀 如果开启系列预算 (CBO)
            if (budgetLevel === 'CAMPAIGN') {
                if (budgetType === 'DAILY') {
                    campaignBody.daily_budget = Math.round(parseFloat(budget) * 100);
                } else {
                    campaignBody.lifetime_budget = Math.round(parseFloat(budget) * 100);
                }
                // CBO 模式下，竞价策略通常在系列层级设置
                if (data.bidStrategy) {
                    campaignBody.bid_strategy = data.bidStrategy;
                }
            }

            const campaignData = await callFacebookGraphApi(`${actId}/campaigns`, 'POST', campaignBody, profile);
            if (!campaignData.id) throw new Error(`Campaign 创建失败: ${formatFBError(campaignData)}`);
            const campaignId = campaignData.id;

            for (let s = 0; s < adSetCount; s++) {
                const currentAdSetName = adSetCount > 1 ? `${adSetName}_${s + 1}` : adSetName;
                
                // 5. 创建广告组 (Ad Set)
                log('INFO', `🏗️ [Profile=${profileId}] 正在创建广告组 [${s+1}/${adSetCount}]: ${currentAdSetName}`);
                
                const targeting = {
                    geo_locations: { countries: countries ? countries.split(',').map(c => c.trim().toUpperCase()) : ['US'] },
                    publisher_platforms: placements === 'automatic' ? ['facebook', 'instagram', 'audience_network', 'messenger'] : ['facebook'],
                    device_platforms: devicePlatforms || ['mobile', 'desktop']
                };

                // 🚀 进阶赋能型受众 (Advantage+ Audience)：年龄仍传递，FB 会将其作为"建议受众"进行优化扩展
                targeting.age_min = parseInt(ageMin) || 18;
                targeting.age_max = parseInt(ageMax) || 65;
                
                if (enableAdvantageAudience) {
                    targeting.targeting_automation = {
                        advantage_audience: 1
                    };
                }
                
                if (gender === 'male') targeting.genders = [1];
                else if (gender === 'female') targeting.genders = [2];

                // 🚀 新增：语言设置
                if (languages) {
                    targeting.languages = languages.split(',').map(l => l.trim()).filter(l => l);
                }

                // 🚀 新增：细分定位 (Detailed Targeting)
                if (detailedTargeting) {
                    try {
                        // 支持 JSON 格式或 逗号分隔的 ID 列表
                        if (detailedTargeting.startsWith('[') || detailedTargeting.startsWith('{')) {
                            targeting.flexible_spec = JSON.parse(detailedTargeting);
                        } else {
                            const ids = detailedTargeting.split(',').map(id => ({ id: id.trim() })).filter(item => item.id);
                            targeting.flexible_spec = [{ interests: ids }];
                        }
                    } catch (e) {
                        log('WARN', `细分定位解析失败: ${e.message}`);
                    }
                }

                if (devicePlatforms && devicePlatforms.includes('mobile')) {
                    if (osType === 'ios') {
                        targeting.user_os = ['iOS'];
                        // 🚀 修正：Facebook API 不支持 user_os_version 字段
                        // 针对版本要求，通常需要使用 user_device 结合特定的型号，或者留空让 FB 自动优化
                    } else if (osType === 'android') {
                        targeting.user_os = ['Android'];
                    }
                }
                if (wifiOnly) targeting.wireless_carrier = ['Wifi'];

                let optimizationGoal = 'LINK_CLICKS';
                if (objective === 'OUTCOME_SALES') {
                    optimizationGoal = enableVO ? 'VALUE' : 'OFFSITE_CONVERSIONS';
                } else if (objective === 'OUTCOME_LEADS') {
                    optimizationGoal = 'OFFSITE_CONVERSIONS';
                } else if (objective === 'OUTCOME_ENGAGEMENT') {
                    if (engagementType === 'PAGE_LIKES') optimizationGoal = 'PAGE_LIKES';
                    else if (engagementType === 'POST_ENGAGEMENT') optimizationGoal = 'POST_ENGAGEMENT';
                    else optimizationGoal = 'REPLIES';
                } else if (objective === 'OUTCOME_AWARENESS') {
                    optimizationGoal = 'REACH';
                }

                const adSetBody = {
                    name: currentAdSetName,
                    campaign_id: campaignId,
                    billing_event: (optimizationGoal === 'REACH' || optimizationGoal === 'IMPRESSIONS') ? 'IMPRESSIONS' : (optimizationGoal === 'PAGE_LIKES' ? 'PAGELIKES' : 'IMPRESSIONS'),
                    optimization_goal: optimizationGoal,
                    targeting: JSON.stringify(targeting), 
                    status: autoActivate ? 'PAUSED' : (adSetStatus || 'PAUSED'), // 🚀 两步模式强制先 PAUSED
                    pacing_type: data.pacingType === 'no_pacing' ? ['no_pacing'] : ['standard']
                };

                // 🚀 新增：归因与费用控制
                if (attributionSpec) {
                    // Facebook API attribution_spec 通常是一个对象数组
                    // 简化处理：目前支持 7D_CLICK_1D_VIEW 这种常用字符串的快速转换
                    // 🚀 修正：event_type 必须是 CLICK_THROUGH 或 VIEW_THROUGH
                    const specs = {
                        '7D_CLICK_1D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
                        '1D_CLICK_1D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 1 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
                        '1D_CLICK': [{ event_type: 'CLICK_THROUGH', window_days: 1 }],
                        '7D_CLICK': [{ event_type: 'CLICK_THROUGH', window_days: 7 }]
                    };
                    adSetBody.attribution_spec = JSON.stringify(specs[attributionSpec] || specs['7D_CLICK_1D_VIEW']);
                }

                if (costPerResult && !isNaN(parseFloat(costPerResult))) {
                    // 如果有费用目标，使用它作为 bid_amount
                    adSetBody.bid_amount = Math.round(parseFloat(costPerResult) * 100);
                }

                // 🚀 新增：版位控制
                if (placements === 'manual' && placementsControl) {
                    try {
                        adSetBody.placements_control = placementsControl.startsWith('{') ? JSON.parse(placementsControl) : { excluded_placements: placementsControl.split(',').map(p => p.trim()) };
                    } catch (e) {}
                }
                if (allowLimitedSpendOnExcluded) {
                    adSetBody.allow_limited_spend_on_excluded_placements = true;
                }

                // 🚀 客户生命周期
                // ⚠️ Meta 的真实参数是 ad_set_goal.type（0=促进所有受众发生转化，1=获取新客户），
                //    customer_lifecycle_parameters 不是合法参数会被 FB 静默忽略
                if (customerLifecycle === 'NEW') { adSetBody.ad_set_goal = { type: 1 }; }
                else if (customerLifecycle === 'ALL') { adSetBody.ad_set_goal = { type: 0 }; }

                // 🚀 竞价策略与金额逻辑优化
                // 优先使用 costPerResult (对应 Cost Cap)，回退到 bidAmount (对应 Bid Cap)
                const finalBidAmount = costPerResult || bidAmount;
                
                if (finalBidAmount && !isNaN(parseFloat(finalBidAmount)) && parseFloat(finalBidAmount) > 0) {
                    adSetBody.bid_amount = Math.round(parseFloat(finalBidAmount) * 100);
                    // 如果设置了 costPerResult，默认使用 COST_CAP，否则按用户选择或默认为 BID_CAP
                    if (costPerResult) {
                        adSetBody.bid_strategy = 'COST_CAP';
                    } else {
                        adSetBody.bid_strategy = data.bidStrategy === 'COST_CAP' ? 'COST_CAP' : 'LOWEST_COST_WITH_BID_CAP';
                    }
                } else {
                    // 如果没填金额，即便前端传了策略也回退到最低成本，防止 API 报错
                    adSetBody.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
                }

                // 🚀 仅当层级为广告组时，才在 AdSet 设置预算
                if (budgetLevel === 'ADSET') {
                    if (budgetType === 'DAILY') {
                        adSetBody.daily_budget = Math.round(parseFloat(budget) * 100);
                    } else {
                        adSetBody.lifetime_budget = Math.round(parseFloat(budget) * 100);
                    }
                }

                // 只有 AdSet 级别的预算才支持排期
                if (budgetType === 'LIFETIME') {
                    if (endDate) adSetBody.end_time = Math.floor(new Date(endDate).getTime() / 1000);
                    if (startDate) adSetBody.start_time = Math.floor(new Date(startDate).getTime() / 1000);
                    if (budgetLevel === 'ADSET' && adSchedule && Array.isArray(adSchedule) && adSchedule.length > 0) {
                        adSetBody.adset_schedule = JSON.stringify(adSchedule);
                    }
                }

                if (pixelId) {
                    adSetBody.promoted_object = JSON.stringify({
                        pixel_id: pixelId,
                        custom_event_type: conversionEvent || 'PURCHASE'
                    });
                }

                const adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                if (!adSetData.id) throw new Error(`AdSet 创建失败: ${formatFBError(adSetData)}`);
                const adSetId = adSetData.id;

                for (let a = 0; a < adCount; a++) {
                    const currentAdName = adCount > 1 ? `${adName}_${a + 1}` : adName;
                    
                    // 6. 创建创意 (Ad Creative)
                    log('INFO', `🏗️ [Profile=${profileId}] 正在创建广告创意 [${a+1}/${adCount}]: ${currentAdName}`);
                    let finalPageId = pageId;
                    if (!finalPageId) {
                        const pagesData = await callFacebookGraphApi('me/accounts?fields=id,name', 'GET', null, profile);
                        if (pagesData.data && pagesData.data.length > 0) {
                            finalPageId = pagesData.data[0].id;
                        } else {
                            throw new Error('该账号未创建任何主页');
                        }
                    }

                    // 🚀 构建 link_data（显示链接仅当用户显式开启时才传 caption）
                    const linkData = {
                        message: adText || '',
                        link: websiteUrl,
                        name: headline || '', // 🚀 修正：Facebook 广告的“标题”实际上对应 link_data.name
                        image_hash: imageHash,
                        call_to_action: { 
                            type: ctaType || 'LEARN_MORE',
                            value: { link: websiteUrl }
                        }
                    };
                    // 仅当用户显式开启并填写了显示链接时才注入 caption，否则不传该字段
                    if (useDisplayLink && displayLink) {
                        linkData.caption = displayLink;
                    }

                    const objectStorySpec = {
                        page_id: finalPageId,
                        link_data: linkData
                    };
                    if (adDescription) objectStorySpec.link_data.description = adDescription;

                    // 🚀 进阶赋能型创意 (Advantage+ Creative)
                    if (enableAdvantageCreative) {
                        objectStorySpec.advantage_plus_creative = {
                            enroll_status: 'OPT_IN'
                        };
                    }

                    const creativeBody = {
                        name: `Creative_${currentAdName}_${Date.now()}`,
                        object_story_spec: JSON.stringify(objectStorySpec)
                    };

                    log('DEBUG', `[Profile=${profileId}] Creating AdCreative with spec: ${JSON.stringify(objectStorySpec)}`);
                    const creativeResult = await callFacebookGraphApi(`${actId}/adcreatives`, 'POST', creativeBody, profile);
                    const creativeId = creativeResult.id;
                    if (!creativeId) {
                        const err = creativeResult.error || {};
                        log('ERROR', `❌ [Profile=${profileId}] 广告创意创建失败详情: ${err.message} (Code: ${err.code}, Subcode: ${err.error_subcode}, UserTitle: ${err.error_user_title})`);
                        throw new Error(`广告创意创建失败: ${formatFBError(creativeResult)}`);
                    }

                    // 7. 创建广告 (Ad)
                    log('INFO', `🚀 [Profile=${profileId}] 正在执行最终发布: ${currentAdName}`);
                    const adData = await callFacebookGraphApi(`${actId}/ads`, 'POST', {
                        name: currentAdName,
                        adset_id: adSetId,
                        creative: JSON.stringify({ creative_id: creativeId }),
                        status: autoActivate ? 'PAUSED' : (adStatus || 'ACTIVE') // 🚀 两步模式强制先 PAUSED
                    }, profile);
                    
                    if (adData.id) {
                        const newAdId = adData.id;
                        results.push(newAdId);
                        log('SUCCESS', `🎉 [Profile=${profileId}] 广告创建成功! ID: ${newAdId}`);

                        // 🚀 两步模式核心逻辑：创建成功后立即开启
                        if (autoActivate) {
                            log('INFO', `⚡ [Profile=${profileId}] 正在自动开启广告资产...`);
                            try {
                                // 1. 开启广告
                                await callFacebookGraphApi(newAdId, 'POST', { status: 'ACTIVE' }, profile);
                                // 2. 开启广告组
                                await callFacebookGraphApi(adSetId, 'POST', { status: 'ACTIVE' }, profile);
                                // 3. 开启广告系列
                                await callFacebookGraphApi(campaignId, 'POST', { status: 'ACTIVE' }, profile);
                                log('SUCCESS', `✅ [Profile=${profileId}] 广告已成功从 PAUSED 切换为 ACTIVE 状态。`);
                            } catch (actErr) {
                                log('WARN', `⚠️ [Profile=${profileId}] 自动开启失败，请手动开启。原因: ${actErr.message}`);
                            }
                        }
                    } else {
                        throw new Error(`Ad 创建失败: ${formatFBError(adData)}`);
                    }
                }
            }
        }

        // 8. 同步结果到云端
        const storageUrl = process.env.STORAGE_SERVER_URL || '';
        const apiSecret = process.env.PUPPETEER_API_SECRET || '';
        await fetch(`${storageUrl}/api/profiles/${profileId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
            body: JSON.stringify({
                id: profileId,
                account_notes: `[API Ads] Bulk Published ${results.length} ads for "${campaignName}" at ${new Date().toLocaleString()}`
            })
        }).catch(() => {});

        return { success: true, adId: results[0], allAdIds: results };
    } catch (error) {
        log('ERROR', `❌ [Profile=${profileId}] API 发布失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 🚀 Facebook 模拟发布核心逻辑
 */
async function runFacebookPublishAd(page, data, profileId) {
    try {
        log('INFO', `🎬 [Profile=${profileId}] 开始浏览器模拟发布流程: ${data.campaignName}`);
        await page.goto('https://adsmanager.facebook.com/adsmanager/manage/campaigns', { waitUntil: 'networkidle', timeout: 60000 });
        
        // 简化的模拟逻辑... (实际逻辑会根据 UI 逐步执行点击)
        // 此处仅作为结构占位，实际逻辑包含在之前的实现中
        log('INFO', `🖱️ [Profile=${profileId}] 正在操作 Ads Manager 界面...`);
        
        // 执行发布...
        
        return true;
    } catch (error) {
        log('ERROR', `❌ [Profile=${profileId}] 浏览器模拟发布失败: ${error.message}`);
        return false;
    }
}

// 本地交易记录转发（同源到 storage-api-server）
app.get('/api/adpos/transactions/list', async (req, res) => {
    try {
        const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
        const qs = new URLSearchParams();
        for (const k of Object.keys(req.query || {})) { const v = req.query[k]; if (v !== undefined && v !== null) qs.set(k, String(v)); }
        const url = `${base}/api/adpos/transactions/list${qs.toString() ? ('?' + qs.toString()) : ''}`;
        const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
    } catch (e) { res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
});
app.post('/api/adpos/transactions/save', async (req, res) => {
    try {
        const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
        const url = `${base}/api/adpos/transactions/save`;
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(req.body || {}) });
        const text = await r.text();
        res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
    } catch (e) { res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
});

// adpos 路由兜底（优先级提前）
app.all('/api/adpos/*splat', (req, res, next) => {
    (async () => {
        try {
            const u = String(req.url || '')
            if (u.includes('/api/adpos/transactions')) { return next() }
            if (u.includes('/api/adpos/prefs')) { return next() }
            if (u.includes('/api/adpos/transactions/save-batch')) { return next() }
            const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '')
            const target = `${base}${u}`
            const method = String(req.method || 'GET').toUpperCase()
            const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' }
            const init = { method, headers }
            try { if (!['GET','HEAD'].includes(method)) Object.assign(init, { body: JSON.stringify(req.body || {}) }) } catch {}
            const r = await fetch(target, init)
            const text = await r.text()
            return res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text)
        } catch (e) {
            return res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) })
        }
    })()
})

// 📊 性能监控
let launchCount = 0;
let successCount = 0;
let errorCount = 0;
let totalLaunchTime = 0;

// 🗄️ 存储活跃的浏览器实例
const activeBrowsers = new Map();

// 📡 自动分配可用调试端口，防止端口冲突
async function getAvailableDebugPort(startPort = 9222) {
    const net = require('net');
    let port = startPort;
    const maxAttempts = 100;
    let attempts = 0;
    while (attempts < maxAttempts) {
        const isOccupied = await new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(true));
            server.once('listening', () => { server.close(); resolve(false); });
            server.listen(port);
        });
        if (isOccupied) { port++; attempts++; continue; }
        let isUsedByActive = false;
        for (const b of activeBrowsers.values()) {
            if (b.debugPort === port) { isUsedByActive = true; break; }
        }
        if (isUsedByActive) { port++; attempts++; continue; }
        return port;
    }
    return startPort + Math.floor(Math.random() * 1000);
}

const browserPool = [];
const launchQueue = [];
let currentLaunching = 0;

// 🚀 浏览器实例管理类（优化版）
// 提取邮箱前缀并安全化为文件名
function extractEmailPrefix(email) {
    if (!email || typeof email !== 'string') return null;
    const local = email.split('@')[0] || '';
    const sanitized = local.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
    return sanitized || null;
}

class BrowserManager {
    constructor() {
        this.instances = new Map();
        this.pool = [];
        this.uridCache = new Set(); // 🚀 缓存已确认存在的目录，跳过重复检查
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
                path.join(__dirname, 'data', 'profiles', `${emailPrefix}_${profileId}`)
            ] : []),
            // 新的统一格式
            path.join(BROWSER_PROFILES_ROOT, `${profileId}_${profileId}`),
            // 当前使用的格式
            path.join(BROWSER_PROFILES_ROOT, String(profileId)),
            // data/profiles 下的格式
            path.join(__dirname, 'data', 'profiles', `${profileId}_${profileId}`),
            path.join(__dirname, 'data', 'profiles', String(profileId)),
            path.join(__dirname, 'data', 'profiles', `profile_${profileId}`)
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
                path.join(__dirname, '..', 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', `${emailPrefix}_${profileId}`)
            ] : []),
            path.join(__dirname, '..', 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', `${profileId}_${profileId}`),
            path.join(__dirname, '..', 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', String(profileId))
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
            path.join(__dirname, '..', 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', targetName),
            path.join(__dirname, '..', 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', String(profileId))
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

    // 🚀 性能优化：获取或创建浏览器实例
    async getBrowser(config) {
        const { executablePath, userDataDir, debugPort, profileId, proxy, browserType } = config;
        
        // 🦎 指纹浏览器 API 模式（仅同步开启）：通过 API 管理环境
        if (browserType === 'omnifp' && config.omnifpSync === true) {
            const instanceKey = `omnifp_${profileId}`;
            if (this.instances.has(instanceKey)) {
                const instance = this.instances.get(instanceKey);
                if (instance.context && (instance.context.browser ? instance.context.browser() : instance.context._connected)) {
                    log('INFO', `♻️ 复用指纹浏览器实例: ${instanceKey}`);
                    return instance;
                }
                this.instances.delete(instanceKey);
                this.stats.active--;
            }
            log('INFO', `🦎 创建指纹浏览器实例: ${instanceKey}`);
            const ctx = await this.createBrowser(config);
            // 包装返回对象，兼容现有代码对 instance.browser 的访问
            const instance = {
                context: ctx,
                browser: ctx,
                config,
                createdAt: Date.now(),
                lastUsed: Date.now(),
                profileId: config.profileId,
                isOmniFp: true,
                pages: () => { try { return ctx.pages ? ctx.pages() : []; } catch { return []; } },
                close: async () => {
                    try { await launchOmniFpBrowser._lastClose?.(config.profileId); } catch {}
                    try { await ctx.close(); } catch {}
                }
            };
            this.instances.set(instanceKey, instance);
            this.stats.active++;
            this.stats.created++;
            return instance;
        }
        let effectiveUserDataDir; // 🚀 提升作用域，确保在 if/else 外部可访问
        // 🚀 仅有首次构建时才需要目录清理/迁移，缓存已存在的目录跳过
        if (!this.uridCache.has(profileId)) {
            await this.cleanupDuplicateDirectories(profileId, config.emailPrefix);
            effectiveUserDataDir = this.getUnifiedUserDataDir(profileId, userDataDir, config.emailPrefix);
            config.userDataDir = effectiveUserDataDir;
            await this.ensureUserDataMigration(profileId, config.emailPrefix);
            this.uridCache.add(profileId);
        } else {
            // 快速路径：直接使用缓存的目录
            effectiveUserDataDir = this.getUnifiedUserDataDir(profileId, userDataDir, config.emailPrefix);
            config.userDataDir = effectiveUserDataDir;
        }
        
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
            if (instance.context && instance.context.browser()) {
                log('DEBUG', `♻️ 复用浏览器实例: ${instanceKey}`);
                return instance;
            } else {
                // 清理无效实例
                this.instances.delete(instanceKey);
                this.stats.active--;
            }
        }

        // 创建新实例
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

        return instance;
    }

    // 🚀 指纹浏览器启动：通过本地 API 创建/复用隔离环境
    async launchOmniFpBrowser(config) {
        const { profileId, proxy, userAgent, startUrls, omnifpSync } = config;
        const userId = String(profileId);
        const hasProxy = proxy && proxy.host && proxy.port;
        
        // 1️⃣ 先尝试直接用 userId 启动
        let startRes = await omnifpRequest('GET', `/api/v1/browser/start?user_id=${userId}&open_urls=${encodeURIComponent((startUrls && startUrls[0]) || '')}`);
        
        if (startRes.code !== 0 && hasProxy) {
            // 2️⃣ 启动失败 → 尝试创建（携代理参数）
            log('INFO', `🦎 指纹浏览器: 创建 userId=${userId}${hasProxy ? ' 带代理' : ''}`);
            const createBody = { user_id: userId, name: String(profileId), group_id: '0', group_name: 'OmniFingerprint' };
            if (hasProxy) {
                createBody.proxy_type = proxy.type?.toLowerCase().includes('socks5') ? 'socks5' : 'http';
                createBody.proxy_host = proxy.host; createBody.proxy_port = Number(proxy.port);
                createBody.proxy_user = proxy.username || ''; createBody.proxy_password = proxy.password || '';
                createBody.proxy_soft = 'other';
            }
            const createRes = await omnifpRequest('POST', '/api/v1/user/create', createBody);
            if (createRes.code === 0) {
                // 创建成功 → 启动
                startRes = await omnifpRequest('GET', `/api/v1/browser/start?user_id=${userId}&open_urls=${encodeURIComponent((startUrls && startUrls[0]) || '')}`);
            } else {
                // 3️⃣ 创建失败（免费版限制）→ 找已有环境轮换
                log('WARN', `🦎 指纹浏览器: 创建失败，轮换已有环境`);
                const listRes = await omnifpRequest('GET', '/api/v1/user/list?page=1&page_size=200');
                const users = listRes.data?.list || [];
                // 倒序取最新 2 个中的一个
                const recycleId = users.length > 0 ? String(users[users.length - 1].user_id) : 'kngqntb';
                log('INFO', `🦎 指纹浏览器: 轮换环境 ${recycleId}，更新代理...`);
                // 更新代理
                await omnifpRequest('POST', '/api/v1/user/update', {
                    user_id: recycleId,
                    proxy_type: proxy.type?.toLowerCase().includes('socks5') ? 'socks5' : 'http',
                    proxy_host: proxy.host, proxy_port: Number(proxy.port),
                    proxy_user: proxy.username || '', proxy_password: proxy.password || '',
                    proxy_soft: 'other'
                }).catch(() => {});
                // 停止旧的（如果有）
                await omnifpRequest('GET', `/api/v1/browser/stop?user_id=${recycleId}`).catch(() => {});
                // 启动
                startRes = await omnifpRequest('GET', `/api/v1/browser/start?user_id=${recycleId}&open_urls=${encodeURIComponent((startUrls && startUrls[0]) || '')}`);
                // 记录回收 ID 供后续 close 使用
                config._recycledUserId = recycleId;
            }
        } else if (startRes.code === 0 && hasProxy && omnifpSync) {
            // 环境已存在 + 同步 ON → 更新代理
            log('INFO', `🦎 指纹浏览器: 同步代理到 ${userId}`);
            await omnifpRequest('POST', '/api/v1/user/update', {
                user_id: userId,
                proxy_type: proxy.type?.toLowerCase().includes('socks5') ? 'socks5' : 'http',
                proxy_host: proxy.host, proxy_port: Number(proxy.port),
                proxy_user: proxy.username || '', proxy_password: proxy.password || '',
                proxy_soft: 'other'
            }).catch(() => {});
        }
        
        if (startRes.code !== 0) throw new Error(`指纹浏览器启动失败: ${JSON.stringify(startRes)}`);

        const wsEndpoint = startRes.data?.ws?.puppeteer || startRes.data?.ws || startRes.data?.debugging_url || `ws://127.0.0.1:${startRes.data?.port || 9222}/devtools/browser`;
        log('INFO', `🦎 指纹浏览器: 浏览器已启动 WS=${wsEndpoint}`);

        // CDP 连接
        const pw = require('playwright');
        const context = await pw.chromium.connectOverCDP(wsEndpoint);

        // Cookie 注入
        if (config.cookies && config.cookies.length > 0) {
            try {
                const pages = context.pages();
                if (pages.length > 0) await pages[0].context().addCookies(config.cookies);
            } catch {}
        }

        // 窗口标题
        if (config.windowTitle) {
            try {
                const pages = context.pages();
                if (pages.length > 0) await pages[0].evaluate((t) => { document.title = t; }, config.windowTitle);
            } catch {}
        }

        return { context, wsEndpoint, userId: config._recycledUserId || userId, pages: () => context.pages(), close: async () => { try { await omnifpRequest('GET', `/api/v1/browser/stop?user_id=${config._recycledUserId || userId}`); } catch {} try { await context.close(); } catch {} } };
    }

    // 🚀 创建浏览器实例（优化版）
    async createBrowser(config) {
        const { executablePath, userDataDir, debugPort, proxy, userAgent, profileId, displayId, browserType, omnifpSync } = config;
        
        // 🦎 指纹浏览器模式
        if (browserType === 'omnifp') {
            if (omnifpSync) {
                // 数据同步 ON → 走指纹浏览器本地 API 管理环境
                log('INFO', `🦎 指纹浏览器 API 模式: profileId=${profileId}`);
                try {
                    const result = await this.launchOmniFpBrowser({ ...config, omnifpSync: true });
                    log('INFO', `✅ 指纹浏览器已连接: userId=${result.userId}`);
                    return result.context;
                } catch (e) {
                    log('ERROR', `❌ 指纹浏览器 API 启动失败: ${e.message}`);
                    throw e;
                }
            } else {
                // 不同步数据 → Playwright 直启指纹浏览器内核（绕免费版限制）
                log('INFO', `🦎 指纹浏览器直接启动模式（绕限）: profileId=${profileId}, exe=${executablePath}`);
            }
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
            actualUserDataDir = path.join(__dirname, '..', 'omnibrowser', 'browsers', 'chrome', 'data', 'profiles', dirName);
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
            // 窗口配置 - 不设置任何窗口/视口大小参数，让 Playwright defaultViewport:null 自动跟随窗口
            // 安全相关
            '--disable-web-security',
            '--disable-popup-blocking',
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
            '--unsafely-disable-devtools-self-xss-warnings',
            '--disable-ipc-flooding-protection',
            // 🚀 多实例稳定化：每个浏览器限制 CPU 和内存使用
            '--renderer-process-limit=1',
            '--disable-features=TranslateUI,ChromeWhatsNewUI,AutofillServerCommunication,SidePanelPinning',
            '--disable-component-update',
            // 移除 --disable-prompt-on-repost 以启用密码保存提示
            '--disable-dev-shm-usage',
            // 系统相关
            '--no-sandbox',
            // 移除 --no-first-run 以允许正常的浏览器初始化
            '--no-default-browser-check',
            '--disable-hang-monitor',
            '--disable-gpu',
            '--disable-software-rasterizer',
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
        chromeArgs.push('--disable-blink-features=AutomationControlled');
        chromeArgs.push('--disable-features=TranslateUI,IsolateOrigins,site-per-process');
        chromeArgs.push('--unsafely-disable-devtools-self-xss-warnings');

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

        // 添加代理配置
        let playwrightProxy = null;
        if (proxy && proxy.host && proxy.port) {
            const pType = proxy.type && proxy.type.toLowerCase().includes('socks5') ? 'socks5' : 'http';
            
            log('INFO', `🔐 代理配置: type=${pType}, host=${proxy.host}, port=${proxy.port}, hasAuth=${!!proxy.username}`);
            
            if (pType === 'socks5' && proxy.username && proxy.password) {
                const isOmniFp = browserType === 'omnifp';
                if (isOmniFp) {
                    // 指纹浏览器修改版内核：CLI 直嵌认证
                    chromeArgs.push(`--proxy-server=${pType}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`, `--proxy-bypass-list=<-loopback>`);
                    log('INFO', `🔐 SOCKS5 指纹浏览器内核直嵌: ${proxy.host}:${proxy.port}`);
                } else {
                    // Chrome/Edge：本地转发器（通过 v2ray 隧道）
                    try {
                        const lp = await startLocalSocksProxy(proxy.host, Number(proxy.port), proxy.username, proxy.password);
                        chromeArgs.push(`--proxy-server=socks5://127.0.0.1:${lp}`);
                        log('INFO', `🔐 SOCKS5 转发器: ${proxy.host}:${proxy.port} → v2ray隧道 127.0.0.1:${lp}`);
                    } catch (e) {
                        log('WARN', `⚠️ 启动 v2ray 隧道失败: ${e.message}，跳过代理`);
                    }
                }
            } else if (pType === 'socks5' && !proxy.username) {
                // SOCKS5 无认证：直接使用 socks5://host:port
                chromeArgs.push(`--proxy-server=socks5://${proxy.host}:${proxy.port}`);
                log('INFO', `🔐 SOCKS5 代理: ${proxy.host}:${proxy.port} (无认证)`);
            } else {
                // ✅ HTTP(含认证)：直接使用 --proxy-server
                let proxyUrl = proxy.username
                    ? `${pType}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
                    : `${pType}://${proxy.host}:${proxy.port}`;
                chromeArgs.push(`--proxy-server=${proxyUrl}`);
                log('INFO', `🔐 代理: ${proxyUrl}${proxy.username ? ' (已嵌入认证凭证)' : ''}`);
            }
        }

        // 添加User Agent
        if (userAgent) {
            chromeArgs.push(`--user-agent=${userAgent}`);
            log('DEBUG', `🔧 User Agent: ${userAgent.substring(0, 50)}...`);
        }

        // 🖥️ 窗口尺寸：使用配置的 windowSize，窗口放大时 viewport 自动跟随
        if (config.windowSize) {
            chromeArgs.push(`--window-size=${config.windowSize}`);
        } else {
            chromeArgs.push('--start-maximized');
        }
        log('DEBUG', `🖥️ 窗口尺寸: ${config.windowSize || '最大化'}`);

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

        log('INFO', `🔧 浏览器类型: ${browserType}`);

        // 优先使用环境变量指定的 Chrome 路径，否则使用系统默认
        const envChromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
        log('INFO', `🔧 环境变量 CHROME_PATH=${process.env.CHROME_PATH || '未设置'}`);
        log('INFO', `🔧 环境变量 PUPPETEER_EXECUTABLE_PATH=${process.env.PUPPETEER_EXECUTABLE_PATH || '未设置'}`);
        
        // 根据浏览器类型查找可执行文件
        let effectiveExecutablePath = envChromePath;
        if (!effectiveExecutablePath) {
            const browserCandidates = {
                chrome: [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    `${process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local'}\\Google\\Chrome\\Application\\chrome.exe`,
                    'D:\\omnibrowser\\browsers\\chrome\\chrome.exe',
                    (() => { try { return require('playwright').chromium.executablePath(); } catch(_) { return null; } })()
                ],
                edge: [
                    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                    `${process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local'}\\Microsoft\\Edge\\Application\\msedge.exe`,
                    (() => { try { return require('playwright').chromium.executablePath({ channel: 'msedge' }); } catch(_) { return null; } })()
                ],
                omnifp: [
                    'D:\\omnibrowser\\browsers\\chrome\\chrome.exe',
                    'C:\\omnibrowser\\browsers\\chrome\\chrome.exe',
                    `${process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local'}\\omnibrowser\\browsers\\chrome\\chrome.exe`,
                    `${process.env.USERPROFILE || 'C:\\Users\\Administrator'}\\AppData\\Local\\omnibrowser\\browsers\\chrome\\chrome.exe`
                ]
            };
            const candidates = browserCandidates[browserType] || browserCandidates.chrome;
            effectiveExecutablePath = candidates.find(p => { try { return require('fs').existsSync(p); } catch { return false; } }) || candidates[0];
        }
        
        log('INFO', `🔧 使用可执行文件: ${effectiveExecutablePath}`);
        const launchOptions = {
            executablePath: effectiveExecutablePath,
            headless: false,
            args: chromeArgs,
            userDataDir: actualUserDataDir,
            defaultViewport: null,
            // 🎭 SOCKS5 带认证使用本地转发器（--proxy-server CLI 参数）
            // ⚠️ 不移除任何默认参数，确保 Playwright 的 viewport 管理正常运作
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            timeout: 30000, // 30秒启动超时
            // 提升 CDP 协议超时，避免 Network.enable 等调用在慢环境下超时
            protocolTimeout: 120000
        };

        log('INFO', `🚀 准备调用 chromium.launchPersistentContext: ${JSON.stringify({
            executablePath: launchOptions.executablePath,
            userDataDir: launchOptions.userDataDir,
            argsCount: launchOptions.args.length,
            headless: launchOptions.headless
        }, null, 2)}`);

        let browser;
        try {
            browser = await chromium.launchPersistentContext(userDataDir, launchOptions);

            // 🎭 不做任何 viewport 操作，defaultViewport: null 让 viewport 跟随窗口
        } catch (err) {
            // 处理 "Browser is already running" 错误 (通常是 SingletonLock 残留)
            const isLockError = err.message && (
                err.message.includes('already running') || 
                err.message.includes('SingletonLock') ||
                err.message.includes('SetEndOfFile') ||
                err.message.includes('拒绝访问') ||
                err.message.includes('0x5')
            );
            
            if (isLockError) {
                log('WARN', `⚠️ 检测到浏览器锁定 (SingletonLock/AccessDenied)，尝试清理残留文件并重试: ${actualUserDataDir}`);
                try {
                    // 检查目录是否存在
                    if (fsSync.existsSync(actualUserDataDir)) {
                        // 列出目录内容进行诊断
                        try {
                            const files = fsSync.readdirSync(actualUserDataDir);
                            log('INFO', `📂 目录内容诊断 (${actualUserDataDir}): ${files.join(', ')}`);
                        } catch (dirErr) {
                            log('INFO', `ℹ️ 无法读取目录内容: ${dirErr.message}`);
                        }
                        
                        // 尝试删除所有可能的锁定文件 (跨平台)
                        const locks = ['SingletonLock', 'lockfile', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
                        for (const l of locks) {
                            try {
                                const lp = path.join(actualUserDataDir, l);
                                if (fsSync.existsSync(lp)) {
                                    fsSync.unlinkSync(lp);
                                    log('INFO', `✅ 强制删除锁定文件成功: ${l}`);
                                }
                            } catch (e) {
                                // 忽略无法删除的错误 (通常是文件被占用)
                            }
                        }
                    } else {
                        log('INFO', `ℹ️ 目录不存在，跳过清理锁定文件`);
                    }
                    
                    // 再次尝试启动
                    browser = await chromium.launchPersistentContext(userDataDir, launchOptions);
                    log('INFO', `✅ 重试启动成功`);
                } catch (retryErr) {
                    log('ERROR', `❌ 重试启动仍然失败: ${retryErr.message}`);
                    throw retryErr;
                }
            } else {
                throw err;
            }
        }

        // 🎭 Playwright: context.on('page') 替代 browser.on('targetcreated')
        browser.on('page', async (page) => {
            try {
                if (!page) return;
                
                // 1. 自我保护/隐藏
                try { await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); }); } catch {}
                
                // 2. 代理认证 (Playwright: 在 context 创建时已通过 proxy config 设置，page 级别不需要)
                // 🚫 page.authenticate 在 Playwright 中不存在，代理认证已在 launchOptions 中处理

                // 3. Cookie 实时同步
                const pid = String(profileId || config.profileId || '');
                if (pid) {
                    try { attachCookieSync(page, pid); } catch (e) {
                        log('WARN', `🍪 为新页面 ${page.url()} 安装Cookie同步失败: ${e.message}`);
                    }
                }
            } catch (error) {
                log('WARN', '⚠️ 处理 page 事件失败:', error.message);
            }
        });

        // 🎭 Playwright: browser.version 是同步属性
        try {
            const ver = browser.browser().version;
            log('INFO', `🎯 实际 Chrome 版本: ${ver}`);
        } catch (verErr) {
            log('WARN', `⚠️ 读取 Chrome 版本失败: ${verErr.message}`);
        }

        // 全局提升协议超时 (Playwright: context.setDefaultTimeout)
        try {
            if (typeof browser.setDefaultTimeout === 'function') {
                browser.setDefaultTimeout(120000);
                log('DEBUG', '⏱️ 已设置默认超时为 120000ms');
            }
        } catch (protoErr) {
            log('WARN', `⚠️ 设置默认协议超时失败: ${protoErr.message}`);
        }

        // 设置全局代理认证 (Playwright: 在 context 创建时已通过 proxy config 处理)
        // 🚫 browser.on('targetcreated') 在 Playwright 中应为 browser.on('page')，
        //    但代理认证已在 launchOptions 中设置，无需在此重复

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
                // 🎭 Playwright: newCDPSession 需要传入 page 参数
                const client = await page.context().newCDPSession(page);
                await client.send('Runtime.enable');
                await client.send('Page.enable');
                
                // 🚀 性能优化：按需初始化密码管理器状态
                await page.evaluate(() => {
                    // 设置密码保存相关的标志
                    window.__passwordManagerEnabled = true;
                    // 减少不必要的日志输出
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

    // 🚀 性能优化：销毁实例
    async destroyInstance(key) {
        const instance = this.instances.get(key);
        if (instance) {
            try {
                if (instance.context && instance.context.browser()) {
                    await instance.context.close();
                }
                log('DEBUG', `🗑️ 浏览器实例已销毁: ${key}`);
            } catch (error) {
                log('WARN', `⚠️ 关闭浏览器实例失败: ${error.message}`);
            }

            this.instances.delete(key);
            this.stats.destroyed++;
            this.stats.active--;
        }
    }

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

            // 🎭 Playwright: context.on('page') 替代 targetcreated
            browser.on('page', async (page) => {
                try {
                    if (page) {
                        await this.setupTitleMonitoringOnPage(page, windowTitle);
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
            // 注入标题监控脚本 - 🎭 Playwright: addInitScript 替代 evaluateOnNewDocument
            await page.addInitScript((title) => {
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
    }
}

// 创建浏览器管理器实例
const browserManager = new BrowserManager();

// 🚀 启动队列管理
class LaunchQueue {
    constructor(maxConcurrent = MAX_CONCURRENT_LAUNCHES) {
        this.queue = [];
        this.running = 0;
        this.maxConcurrent = maxConcurrent;
        this.taskTimeout = parseInt(process.env.LAUNCH_TASK_TIMEOUT || '120000', 10); // 单个任务超时
    }

    async add(task, priority = 0) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject, priority, createdAt: Date.now() });
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
        const { task, resolve, reject } = item;

        const timeoutId = setTimeout(() => {
            reject(new Error('启动超时'));
            this.running--;
            this.process();
        }, this.taskTimeout);

        try {
            const result = await task();
            clearTimeout(timeoutId);
            resolve(result);
        } catch (error) {
            clearTimeout(timeoutId);
            reject(error);
        } finally {
            this.running--;
            this.process();
        }
    }

    // 🎚️ 并发数由服务端任务队列（job-queue）统一设置，改一个数字两处同时生效
    //    （口径与 browser-manager.js 的 LaunchQueue.setMaxConcurrent 一致）
    setMaxConcurrent(val) {
        this.maxConcurrent = Math.max(1, Math.min(20, parseInt(val, 10) || 5));
        log('INFO', `[LaunchQueue] 并发数已更新: ${this.maxConcurrent}`);
    }

    isOverloaded() {
        try {
            const memUsage = process.memoryUsage();
            const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
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

// ===================== 服务端任务队列（批量慢操作统一入队执行，任务落盘） =====================
// 🧵 从 puppeteer-api-server.js 回移。job-queue.js 与浏览器引擎无关：所有 op 都是回调本机
//    HTTP 接口（http://127.0.0.1:PORT + X-Api-Secret），所以直接复用同一份逻辑。
const { JobQueue } = require('./job-queue');
const jobQueue = new JobQueue({
    dbPath, port: PORT, apiSecret: API_SECRET, log,
    // 🔗 队列并发数 = 全局浏览器闸门（LaunchQueue.maxConcurrent）：改一个数字两处同时生效。
    //    否则队列设 10、闸门只有 5 时，队列里会有一半任务卡在「等空位」，看起来像队列不动。
    onConcurrencyChange: (n) => { try { launchQueueManager.setMaxConcurrent(n); } catch (e) { log('WARN', `[JobQueue] 同步并发数失败: ${e.message}`); } },
});
jobQueue.registerRoutes(app);
jobQueue.init().catch((e) => log('ERROR', `🧵 [JobQueue] 初始化失败: ${e && e.message}`));

// 🆕 浏览器预热器
const browserPrewarmer = {
    _prewarmedCount: 0,
    _timer: null,
    async start() {
        log('INFO', `🔥 浏览器预热器启动，目标预热量: ${BROWSER_PREWARM_COUNT}`);
        setTimeout(() => this._prewarm(), 5000);
        this._timer = setInterval(() => this._maintainPool(), 300000);
    },
    async _prewarm() {
        while (this._prewarmedCount < BROWSER_PREWARM_COUNT) {
            if (launchQueueManager.isOverloaded()) break;
            try {
                await launchQueueManager.add(async () => {
                    const { chromium } = require('playwright');
                    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
                    const browser = await chromium.launch({
                        headless: true,
                        executablePath: chromePath,
                        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
                    });
                    this._prewarmedCount++;
                    log('INFO', `🔥 预热浏览器 #${this._prewarmedCount} 就绪`);
                    await browser.close();
                }, -1);
            } catch (e) {
                log('WARN', `🔥 预热失败: ${e.message}`);
                break;
            }
        }
    },
    async _maintainPool() {
        this._prewarmedCount = 0;
        this._prewarm();
    },
    stop() { if (this._timer) clearInterval(this._timer); }
};

// ❤️ 健康检查端点
app.get('/api/health', (req, res) => {
    const memUsage = process.memoryUsage();
    
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'AdsPlus Go Puppeteer Service',
        version: '1.1.0',
        performance: {
            activeBrowsers: activeBrowsers.size,
            browserInstances: browserManager.getStats(),
            launchQueue: launchQueueManager.getStats(),
            memory: {
                used: Math.round(memUsage.heapUsed / 1024 / 1024),
                total: Math.round(memUsage.heapTotal / 1024 / 1024),
                external: Math.round(memUsage.external / 1024 / 1024)
            },
            stats: {
                launches: launchCount,
                successes: successCount,
                errors: errorCount,
                avgLaunchTime: launchCount > 0 ? Math.round(totalLaunchTime / launchCount) : 0
            }
        }
    });
});

// ❤️ 根路径健康检查端点（用于前端状态检查）
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'AdsPlus Go Backend Service',
        version: '1.1.0'
    });
});

// 🦎 指纹浏览器健康检查代理（前端通过后端代理检测，避免 CORS + 混合内容问题）
app.get('/api/health/omnifp', async (req, res) => {
    try {
        const resp = await fetch('http://127.0.0.1:50325/api/v1/user/list?page=1&page_size=1', {
            signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        res.json({ success: true, online: true, code: data.code, userCount: Array.isArray(data.data?.list) ? data.data.list.length : 0 });
    } catch (err) {
        res.json({ success: true, online: false, error: err.message });
    }
});

// 兼容路由提前注册，避免404
app.all('/api/adpos/access-token', async (req, res) => {
    try {
        const body = (req.body && Object.keys(req.body).length ? req.body : {})
        const email = String(body.email || process.env.ADPOS_EMAIL || '')
        const password = String(body.password || process.env.ADPOS_PASSWORD || '')
        const base = (String(body.baseUrl || process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io')).replace(/\/$/, '')
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'missing_credentials' })
        }
        const url = `${base}/auth/access-token`
        const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
        const json = await resp.json().catch(()=>({}))
        const data = json && json.data ? json.data : json
        const token = data && data.access_token ? String(data.access_token) : ''
        const type = data && data.token_type ? String(data.token_type) : ''
        return res.json({ success: !!token, status: resp.status, token, token_type: type || 'Bearer', raw: data })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
    }
})

app.get('/api/adpos/account', async (req, res) => {
    try {
        const { token } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {}
        const r = await adposClient.getAccount({ profileId: '', token })
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
    }
})
app.get('/api/adpos/cards', async (req, res) => {
    try {
        const { profileId, token, page, per_page } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        const r = await adposClient.listCards({ profileId, token, page, per_page });
        return res.json({ success: r.ok, status: r.status, data: r.data || [], meta: r.meta || null, error: r.error || null, status_code: r.status_code });
    } catch (e) {
        return res.json({ success: false, status: 200, data: [], meta: null });
    }
});

app.get('/api/adpos/cards/all', async (req, res) => {
    try {
        const { profileId, token, per_page } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        const r = await adposClient.listAllCards({ profileId, token, per_page });
        return res.json({ success: r.ok, status: r.status, data: r.data || [], meta: r.meta || null });
    } catch (e) {
        return res.json({ success: false, status: 200, data: [], meta: null });
    }
});
app.get('/api/adpos/transactions/all', async (req, res) => {
    try {
        const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
        const qs = new URLSearchParams();
        for (const k of Object.keys(req.query || {})) { const v = req.query[k]; if (v !== undefined && v !== null) qs.set(k, String(v)); }
        const url = `${base}/api/adpos/transactions/list${qs.toString() ? ('?' + qs.toString()) : ''}`;
        const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        return res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
    } catch (e) { return res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
});

app.get('/api/adpos/transactions/by-card', async (req, res) => {
    try {
        const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
        const qs = new URLSearchParams();
        for (const k of Object.keys(req.query || {})) { const v = req.query[k]; if (v !== undefined && v !== null) qs.set(k, String(v)); }
        const url = `${base}/api/adpos/transactions/list${qs.toString() ? ('?' + qs.toString()) : ''}`;
        const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        return res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
    } catch (e) { return res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
});

app.get('/api/adpos/transactions', async (req, res) => {
    try {
        const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
        const qs = new URLSearchParams();
        for (const k of Object.keys(req.query || {})) { const v = req.query[k]; if (v !== undefined && v !== null) qs.set(k, String(v)); }
        const url = `${base}/api/adpos/transactions/list${qs.toString() ? ('?' + qs.toString()) : ''}`;
        const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        return res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
    } catch (e) { return res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
});

// 兜底：任何未命中的 adpos 路由统一返回空列表，避免 404
app.all('/api/adpos/*splat', (req, res, next) => {
    try {
        const u = String(req.url || '')
        if (u.includes('/api/adpos/prefs')) { return next() }
        if (u.includes('/api/adpos/transactions/save-batch')) { return next() }
        return res.json({ success: true, status: 200, data: [], meta: { count: 0 } });
    } catch { return res.json({ success: true, status: 200, data: [], meta: { count: 0 } }); }
});

// 🧹 清理重复目录端点
app.post('/api/cleanup-duplicates', async (req, res) => {
    try {
        const { profileId } = req.body;
        
        if (!profileId) {
            return res.status(400).json({ 
                success: false, 
                error: '缺少 profileId 参数' 
            });
        }

        await browserManager.cleanupDuplicateDirectories(profileId);
        
        res.json({ 
            success: true, 
            message: `已检查并清理 profileId: ${profileId} 的重复目录` 
        });
    } catch (error) {
        console.error('清理重复目录失败:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// 📊 性能统计端点
app.get('/api/stats', (req, res) => {
    res.json({
        success: true,
        data: {
            browserManager: browserManager.getStats(),
            launchQueue: launchQueueManager.getStats(),
            performance: {
                launches: launchCount,
                successes: successCount,
                errors: errorCount,
                avgLaunchTime: launchCount > 0 ? Math.round(totalLaunchTime / launchCount) : 0
            },
            memory: process.memoryUsage(),
            uptime: process.uptime()
        }
    });
});

// 🚀 启动浏览器端点 (优化版)
    app.post('/api/launch-browser', async (req, res) => {
        const startTime = Date.now();
        launchCount++;
        
        // 捕获授权令牌，用于后续同步
        const authToken = req.headers['authorization'] || req.headers['Authorization'];
        
        const { profileId, profile, proxy: rawProxy, startUrls, cookies, userAgent, executablePath, chrome115Config, skipStartUrls, strictStartUrls = true, strictVerifyOnly } = req.body;
    try { console.log(`📨 请求参数: profileId=${String(profileId||'')}, strictStartUrls=${!!strictStartUrls}, strictVerifyOnly=${!!strictVerifyOnly}, startUrls=${Array.isArray(startUrls)?startUrls.join(', '):String(startUrls||'')}`); } catch {}
    
    // 🚀 将原始代理字符串解析为对象格式
    const proxy = typeof rawProxy === 'string' && rawProxy.trim()
        ? parseProxy(rawProxy.trim())
        : (typeof rawProxy === 'object' ? rawProxy : null);
    
    try {
        console.log(`🚀 启动浏览器配置 ${profileId}...`);

        // 🔍 从文件中读取完整的配置信息
        const actualProfile = await findProfileById(profileId);
        const finalProfile = actualProfile || profile || {};
        
        // 🏷️ 提取窗口标题配置，如果未提供则使用 Profile 名称或 ID 作为默认值
        const windowTitle = chrome115Config?.windowTitle || finalProfile?.name || (profileId ? `Profile ${profileId}` : undefined);
        console.log(`🏷️ 窗口标题已设定: ${windowTitle || '未设置'}`);

        const finalProxy = proxy || (typeof finalProfile.proxy === 'string' ? parseProxy(finalProfile.proxy) : finalProfile.proxy);
        let finalStartUrls = (Array.isArray(startUrls) && startUrls.length ? startUrls : [finalProfile.startUrl].filter(Boolean));
        try {
            const cleaned = (finalStartUrls || []).map(u => String(u || '').trim()).filter(Boolean);
            const target = cleaned.slice(0, 1);
            finalStartUrls = target;
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
            if (existing && existing.context && existing.context.browser()) {
                const urls = Array.from(new Set((finalStartUrls || []).map(u => String(u || '').trim()).filter(Boolean))).slice(0, 1);
                console.log(`♻️ 检测到已运行实例，复用并打开启动网站: ${urls.join(', ')}`);
                for (const url of urls) {
                    try {
                        const page = await existing.context.newPage();
                        try { attachCookieSync(page, profileId); } catch {}
                        // [PW] setUserAgent 在 Playwright 中需在 context 创建时通过 launchOptions 设置
                        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
                        console.log(`✅ 已在复用实例打开网站: ${url}`);
                    } catch (reuseErr) {
                        try { log('DEBUG', `复用实例打开网站失败 ${url}: ${String(reuseErr && reuseErr.message || reuseErr)}`); } catch {}
                    }
                }
                return res.json({ success: true, message: '浏览器已运行，复用实例', data: { profileId, reused: true }, timestamp: new Date().toISOString() });
            }
        } catch (reuseCheckErr) {
            try { log('DEBUG', `复用检查失败: ${String(reuseCheckErr && reuseCheckErr.message || reuseCheckErr)}`); } catch {}
        }

        // 使用启动队列管理并发
        const result = await launchQueueManager.add(async () => {
            
            // 🔧 设置默认参数，避免undefined（使用邮箱前缀+profileId作为目录名）
            const emailPrefix = extractEmailPrefix(finalProfile.accountEmail || finalProfile.account_email);
            const dirName = emailPrefix ? `${emailPrefix}_${String(profileId)}` : String(profileId);
            const defaultUserDataDir = path.join(BROWSER_PROFILES_ROOT, dirName);
            // 基于profileId生成唯一端口（处理字符串profileId）
            const profileHash = profileId ? String(profileId).split('').reduce((a, b) => {
                a = ((a << 5) - a) + b.charCodeAt(0);
                return a & a;
            }, 0) : 0;
            
            // 🚀 核心优化：自动分配调试端口，避免多个浏览器冲突
            let debugPort = req.body.debugPort;
            if (!debugPort) {
                debugPort = await getAvailableDebugPort(9222);
                console.log(`📡 自动分配调试端口: ${debugPort}`);
            } else {
                console.log(`🔧 使用指定调试端口: ${debugPort}`);
            }

            const defaultExecutablePath = (process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
            
            // 🚀 添加浏览器类型支持（默认 chrome，可选 edge / omnifp）
            const browserType = (req.body.browserType || process.env.BROWSER_TYPE || 'chrome').toLowerCase();
            
            // 根据浏览器类型选择默认可执行文件
            let resolvedExecutablePath = executablePath || defaultExecutablePath;
            if (browserType === 'edge' && !executablePath) {
                const edgePaths = [
                    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                    `${process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local'}\\Microsoft\\Edge\\Application\\msedge.exe`
                ];
                resolvedExecutablePath = edgePaths.find(p => { try { return require('fs').existsSync(p); } catch { return false; } }) || resolvedExecutablePath;
            } else if (browserType === 'omnifp' && !executablePath) {
                const omnifpPaths = [
                    'D:\\omnibrowser\\browsers\\chrome\\chrome.exe',
                    'C:\\omnibrowser\\browsers\\chrome\\chrome.exe',
                    `${process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local'}\\omnibrowser\\browsers\\chrome\\chrome.exe`
                ];
                resolvedExecutablePath = omnifpPaths.find(p => { try { return require('fs').existsSync(p); } catch { return false; } }) || resolvedExecutablePath;
            }
            
            // 配置浏览器参数
            const config = {
                profileId,
                browserType,
                executablePath: resolvedExecutablePath,
                userDataDir: req.body.userDataDir || defaultUserDataDir,
                debugPort: debugPort,
                proxy: finalProxy,
                userAgent: finalUserAgent,
                windowTitle: windowTitle, // 🏷️ 添加窗口标题配置
                windowSize: (req.body.windowSize || process.env.WINDOW_SIZE || finalProfile.resolution || '1366x768'), // 🖥️ 添加窗口大小配置
                forceWindowSize: (typeof req.body.forceWindowSize !== 'undefined') ? Boolean(req.body.forceWindowSize) : (String(process.env.FORCE_WINDOW_SIZE || 'false').toLowerCase() === 'true'),
                omnifpSync: req.body.omnifpSync === true,
                emailPrefix
            };
            try {
                const urls = finalStartUrls || [];
                config.storeOptimized = urls.some(u => /chrome\.google\.com|webstore|extensions\//i.test(String(u)));
            } catch {}

            console.log(`🔧 浏览器配置: executablePath=${config.executablePath}, userDataDir=${config.userDataDir}, debugPort=${config.debugPort}`);

            // 🔧 使用统一的目录管理逻辑
            const actualUserDataDir = browserManager.getUnifiedUserDataDir(profileId, config.userDataDir, emailPrefix);
            
            // 🧹 检查并清理重复目录
            await browserManager.cleanupDuplicateDirectories(profileId, config.emailPrefix);
            
            // 🍪 解析Cookie数据并预注入到数据库
            let parsedCookies = null;
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
                try {
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
            }
            
            // 获取或创建浏览器实例（在Cookie预注入之后）
            const browserInstance = await browserManager.getBrowser(config);
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
                lastGraphQL: null,
                strictVerifyOnly: !!strictVerifyOnly
            });

            // 🚀 核心监听：当浏览器断开连接时，自动从活跃列表移除，释放调试端口资源
            browserInstance.browser.on('close', () => {
                try {
                    if (activeBrowsers.has(profileId)) {
                        const bd = activeBrowsers.get(profileId);
                        if (bd && bd.context === browserInstance.browser) {
                            activeBrowsers.delete(profileId);
                            log('INFO', `🔌 浏览器已断开，自动清理活跃列表: profileId=${profileId}, port=${config.debugPort}`);
                        }
                    }
                } catch (e) {
                    log('WARN', `⚠️ 处理浏览器断开清理失败: ${e.message}`);
                }
            });

            // 仅打开首页
            try {
                const page = await browserInstance.browser.newPage();
                
                // 1. 启用Cookie同步监听
                try { attachCookieSync(page, profileId); } catch {}
                
                // 2. 设置UserAgent
                // [PW] UA 在 context 创建时设置

                // 3. 获取并注入Cookie
                // 逻辑调整：优先使用请求参数中的Cookie（明确意图），其次尝试从在线存储获取
                let cookiesToInject = [];
                let shouldSyncToStorage = false;

                if (parsedCookies && parsedCookies.length > 0) {
                    cookiesToInject = parsedCookies;
                    shouldSyncToStorage = true;
                    console.log(`ℹ️ 使用请求参数中的 ${cookiesToInject.length} 个Cookie`);
                } else {
                    try {
                        const storageCookies = await getCookiesFromStorage(profileId);
                        if (Array.isArray(storageCookies) && storageCookies.length > 0) {
                            cookiesToInject = storageCookies;
                            console.log(`✅ 从存储服务器获取到 ${cookiesToInject.length} 个Cookie`);
                        }
                    } catch (e) {
                        console.warn('⚠️ 获取Cookie失败，尝试使用本地缓存:', e.message);
                    }
                }

                if (cookiesToInject.length > 0) {
                    const validCookies = cookiesToInject
                        .map(cookie => {
                            const nc = normalizeCookie(cookie);
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
                        })
                        .filter(c => c !== null);

                    try {
                        // 🚀 性能优化：为 setCookie 添加超时，防止单个浏览器卡死阻塞整个启动队列
                        await Promise.race([
                            page.context().addCookies(validCookies),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Cookie injection timed out')), 15000))
                        ]);
                        console.log(`✅ 已批量注入 ${validCookies.length} 个Cookie`);
                        
                        // 如果使用了请求中的Cookie，则异步同步到存储服务器
                        if (shouldSyncToStorage) {
                            // 不使用 await，避免阻塞页面加载
                            const browserData = activeBrowsers.get(profileId);
                            const authToken = browserData ? browserData.authToken : null;
                            syncCookiesToStorage(profileId, cookiesToInject, authToken).catch(e => {
                                console.warn('⚠️ 后台同步Cookie失败:', e.message);
                            });
                        }
                    } catch (e) {
                        console.warn('⚠️ 批量注入Cookie失败:', e.message);
                    }
                }

                // 4. 导航到目标页面
                const targetUrl = (finalStartUrls && finalStartUrls[0]) ? finalStartUrls[0] : 'https://www.facebook.com/';
                console.log(`🚀 正在导航到目标页面: ${targetUrl}`);
                
                await page.goto(targetUrl, { 
                    waitUntil: 'networkidle', 
                    timeout: 60000 
                });
                
                console.log(`✅ 页面导航完成: ${page.url()} (title=${await page.title().catch(()=>'N/A')})`);

                // 5. 自动填充密码 (非严格模式)
                if (!strictStartUrls) {
                    try { await autoFillPasswordOnPage(page, finalProfile, profileId); } catch {}
                }

            } catch (pageError) {
                console.log(`❌ 页面导航失败: ${String(pageError && pageError.message || pageError)}`);
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
                                // [PW] UA 在 context 创建时设置
                                await page.goto(billingHubUrl, { waitUntil: 'networkidle', timeout: 30000 });
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
                                            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 8000 }).catch(()=>{}),
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

            return {
                profileId,
                debugPort: config.debugPort,
                startTime: browserInstance.createdAt,
                userAgent: config.userAgent,
                proxyConfig: proxy
            };
        });

        const launchTime = Date.now() - startTime;
        totalLaunchTime += launchTime;
        successCount++;

        console.log(`✅ 浏览器启动成功: ${profileId} (${launchTime}ms)`);
        return res.json({
            success: true,
            message: '浏览器启动成功',
            data: result,
            launchTime,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        try { console.error('❌ 浏览器启动失败:', error); } catch {}
        return res.status(500).json({ success: false, message: '浏览器启动失败', error: String(error && error.message || error) });
    }
});

        // 🛑 停止浏览器端点
// 🛑 关闭活跃浏览器实例（stop-browser 等关闭路径共用）
//    ⚠️ 坑：activeBrowsers 里存的 `.browser` 其实是 Playwright 的 BrowserContext
//       （见 browserManager.getBrowser 的包装对象 { context: ctx, browser: ctx }），
//       旧代码读的是 `browserData.context` → 恒为 undefined → 整段关闭被静默跳过，
//       但注册表照删，于是浏览器进程变成孤儿：接口回"成功"，调试端口却仍在监听。
function killProcessTree(pid) {
    try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe', timeout: 5000 }); return true; }
    catch { return false; }
}

// 按调试端口反查 LISTENING 进程并连子进程一起强杀
// （Playwright 的 browser 对象没有 puppeteer 那样的 process() 可拿 pid，只能从端口找）
function killChromeByDebugPort(port) {
    const pids = new Set();
    try {
        const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of String(out).split(/\r?\n/)) {
            const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
            if (m && Number(m[1]) === Number(port)) pids.add(m[2]);
        }
    } catch {}
    let killed = 0;
    for (const pid of pids) if (killProcessTree(pid)) killed++;
    return killed;
}

async function closeBrowserInstance(profileId, browserData, trigger) {
    // 字段名两种都认：实际写入的是 .browser（BrowserContext），历史代码读的是 .context
    const ctx = (browserData && (browserData.context || browserData.browser)) || null;
    let browser = null;
    try { if (ctx && typeof ctx.browser === 'function') browser = ctx.browser(); } catch {}

    // 先摘注册表：避免关闭期间被"复用实例"逻辑又拿到同一个 context
    activeBrowsers.delete(profileId);

    try { if (ctx && typeof ctx.close === 'function') await ctx.close(); }
    catch (e) { log('WARN', `🛑 [${trigger}] context.close 失败 profileId=${profileId}: ${e && e.message}`); }

    try { if (browser && typeof browser.close === 'function') await browser.close(); }
    catch (e) { log('WARN', `🛑 [${trigger}] browser.close 失败 profileId=${profileId}: ${e && e.message}`); }

    // 兜底：给 Chrome 一点自退时间，调试端口若仍在监听就强杀进程树
    const port = browserData && browserData.debugPort;
    if (port) {
        await new Promise(r => setTimeout(r, 300));
        const killed = killChromeByDebugPort(port);
        if (killed > 0) {
            log('WARN', `🛑 [${trigger}] context 关不掉进程，已按调试端口 ${port} 强杀 ${killed} 个进程: profileId=${profileId}`);
        }
    }
    log('INFO', `🛑 浏览器已停止: profileId=${profileId}｜触发点=${trigger}`);
}

app.post('/api/stop-browser', async (req, res) => {
    const { profileId } = req.body;
    
    try {
        const browserData = activeBrowsers.get(profileId);
        if (!browserData) {
            return res.status(404).json({
                success: false,
                message: '未找到运行中的浏览器实例'
            });
        }

        await closeBrowserInstance(profileId, browserData, 'api/stop-browser');

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
app.post('/api/restart-browser', async (req, res) => {
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
app.get('/api/browsers', (req, res) => {
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

// 🔑 获取登录凭据端点
app.get('/api/credentials/:domain', (req, res) => {
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

// 🍪 验证浏览器Cookie端点
app.post('/api/validate-cookies', async (req, res) => {
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
        if (!browser || !browser.browser()) {
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
        const cookies = await page.context().cookies();
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
app.post('/api/facebook/check-login', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        if (!profileId) return res.status(400).json({ success: false, message: 'missing_profileId' });
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: true, loggedIn: false, reason: 'no_browser' });
        }
        const pages = await browserData.context.pages();
        const page = pages[0] || await browserData.context.newPage();
        const cookies = await page.context().cookies();
        const fbCookies = cookies.filter(c => /facebook\.com$/i.test(c.domain));
        const cUser = fbCookies.find(c => c.name === 'c_user');
        const xs = fbCookies.find(c => c.name === 'xs');
        const loggedIn = !!(cUser && xs);
        return res.json({ success: true, loggedIn, userId: cUser ? cUser.value : null });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});
app.post('/api/facebook/asset-summary', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        if (!profileId) return res.status(400).json({ success: false, message: 'missing_profileId' });
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: true, assetCount: null, status: 'no_browser' });
        }
        const page = await browserData.context.newPage();
        try { await page.goto('https://business.facebook.com/adsmanager/manage/accounts', { waitUntil: 'networkidle', timeout: 20000 }); } catch {}
        let assetCount = null;
        try {
            assetCount = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('[role="row"]'));
                return els.length || null;
            });
        } catch {}
        try { await page.close(); } catch {}
        return res.json({ success: true, assetCount });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});
app.post('/api/facebook/bm-info', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: true, businessId: null, status: 'no_browser' });
        }
        const page = await browserData.context.newPage();
        let businessId = null;
        try {
            await page.goto('https://business.facebook.com/settings/business_info', { waitUntil: 'networkidle', timeout: 20000 });
            businessId = await page.evaluate(() => {
                try {
                    const url = new URL(window.location.href);
                    const bid = url.searchParams.get('business_id');
                    if (bid) return bid;
                    const meta = document.querySelector('[data-testid="business_info_section"]');
                    if (meta) {
                        const t = meta.textContent || '';
                        const m = t.match(/business\s*id\s*[:：]\s*(\d+)/i);
                        if (m) return m[1];
                    }
                } catch(_){ }
                return null;
            });
        } catch(_){ }
        try { await page.close(); } catch(_){ }
        return res.json({ success: true, businessId });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});
app.post('/api/facebook/adaccounts', async (req, res) => {
    try {
        const { profileId, skip_browser } = req.body || {};
        let accounts = [];
        
        // 1. 尝试使用 Token 获取 (Graph API) - 纯服务端请求，无需浏览器
        try {
            const profile = await findProfileById(profileId);
            const token = profile?.token;
            if (token && String(token).length > 10) {
                console.log(`[AdAccounts] Trying Graph API for profile ${profileId}`);
                const gUrl = `https://graph.facebook.com/v20.0/me/adaccounts?fields=account_id,id,name,account_status,currency,timezone_id,timezone_name,timezone_offset_hours_utc,business_country_code&limit=200&access_token=${encodeURIComponent(token)}`;
                const gResp = await fetch(gUrl);
                const gJson = await gResp.json();
                if (gJson && !gJson.error && Array.isArray(gJson.data)) {
                     accounts = gJson.data.map(a => {
                        let tzDisplay = String(a.timezone_id || '');
                        if (a.timezone_name) {
                            const offset = a.timezone_offset_hours_utc;
                            const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                            tzDisplay = `${a.timezone_name}${offsetStr}`;
                        }

                        return {
                            name: a.name,
                            account_id: a.account_id || a.id,
                            id: a.id,
                            account_status: a.account_status,
                            currency: a.currency,
                            timezone_id: tzDisplay,
                            business_country_code: a.business_country_code
                        };
                     });
                     console.log(`[AdAccounts] Graph API success: ${accounts.length} accounts`);
                }
            }
        } catch (e) {
            console.error(`[AdAccounts] Graph API failed:`, e.message);
        }

        // 2. 如果 Graph API 没获取到，且允许使用浏览器，则尝试 Puppeteer 抓取
        if ((!accounts.length) && !skip_browser) {
            let browserRef = null;
            let browserData = activeBrowsers.get(profileId);
            
            // 如果已存在且连接正常
            if ((browserData && browserData.context && browserData.context.browser())) {
                browserRef = browserData.context;
            } else {
                // 尝试启动新浏览器
                try {
                    console.log(`[AdAccounts] Launching browser for profile ${profileId}...`);
                    const profile = await findProfileById(profileId);
                    const userDataDir = browserManager.getUnifiedUserDataDir(profileId, undefined, extractEmailPrefix(profile?.accountEmail || profile?.account_email));
                    
                    const config = {
                        profileId,
                        browserType: (profile?.browserType || process.env.BROWSER_TYPE || 'chrome').toLowerCase(),
                        userDataDir,
                        debugPort: 0, // Let manager decide or use default
                        proxy: profile?.proxy,
                        userAgent: profile?.userAgent,
                        windowTitle: String(profileId || ''),
                        emailPrefix: extractEmailPrefix(profile?.accountEmail || profile?.account_email)
                    };
                    
                    // 尝试从存储加载Cookie并注入
                    if (profile?.account?.cookies) {
                         const ckStr = profile.account.cookies;
                         if (ckStr && typeof ckStr === 'string' && ckStr.length > 5) {
                             config.cookies = ckStr;
                         }
                    }
                    
                    const browserInstance = await browserManager.getBrowser(config);
                    browserRef = browserInstance.browser;
                    
                    // 如果有Cookies，尝试在第一个页面注入（browserManager.getBrowser 内部可能已经处理，但这里显式确认）
                    if (config.cookies) {
                        try {
                            const pages = await browserRef.pages();
                            if (pages.length > 0) {
                                const page = pages[0];
                                const cookies = parseCookieString(config.cookies, 'facebook.com');
                                if (cookies.length) {
                                    await page.context().addCookies(cookies);
                                    console.log(`[AdAccounts] Injected ${cookies.length} cookies into browser`);
                                }
                            }
                        } catch (ckErr) {
                            console.error(`[AdAccounts] Cookie injection failed:`, ckErr);
                        }
                    }
                    
                    // 记录到 activeBrowsers
                    activeBrowsers.set(profileId, {
                        browser: browserRef,
                        profileId,
                        startTime: Date.now(),
                        debugPort: browserInstance.debugPort || 9222
                    });
                } catch (launchErr) {
                    console.error(`[AdAccounts] Failed to launch browser:`, launchErr);
                }
            }

            if (browserRef && browserRef.browser()) {
                let page = null;
                try {
                    page = await browserRef.newPage();
                    await page.goto('https://adsmanager.facebook.com/adsmanager/manage/accounts', { waitUntil: 'networkidle', timeout: 35000 });
                    try { await new Promise(r => setTimeout(r, )); } catch {}
                    const scraped = await page.evaluate(() => {
                        const list = [];
                        const add = (name, id) => { if (name || id) list.push({ name, account_id: id }); };
                        
                        const links = Array.from(document.querySelectorAll('a[href*="act="]'));
                        links.forEach(a => {
                            const href = a.getAttribute('href') || '';
                            const m = href.match(/act[_=](\d{6,})/i);
                            const id = m ? m[1] : null;
                            const nameEl = a.closest('[role="row"]') || a.closest('div');
                            const name = nameEl ? String(nameEl.textContent || '').trim() : '';
                            add(name, id);
                        });
                        
                        // 兜底：尝试从表格行获取
                        if (!list.length) {
                             const rows = Array.from(document.querySelectorAll('[role="row"]'));
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
                                 add(name, id);
                             });
                        }
                        return list;
                    });
                    if (scraped && scraped.length) accounts = scraped;
                } catch(e) { console.error(`[AdAccounts] Scraping failed:`, e); }
                try { if (page) await page.close(); } catch {}
            }
        }

        // 3. 保存并返回
        if (accounts.length) {
             const sdb = new sqlite3.Database(dbPath);
             await ensureAdAccountsTable(sdb);
             for (const a of accounts) {
                 await new Promise((resolve) => {
                     const idv = String(a.account_id || a.id || '');
                     const sql = `INSERT OR REPLACE INTO ad_accounts (id, profile_id, platform, account_id, name, status, currency, timezone_id, spend, country, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
                     const args = [
                        idv || `${Date.now()}_${Math.random().toString(36).slice(2)}`, 
                        String(profileId || ''), 
                        'Meta (Facebook/Instagram)', 
                        String(a.account_id || a.id || ''), 
                        String(a.name || ''), 
                        String(a.account_status || a.status || 'Unknown'), 
                        String(a.currency || ''), 
                        String(a.timezone_id || ''), 
                        0,
                        String(a.business_country_code || '')
                     ];
                     sdb.run(sql, args, () => resolve());
                 });
             }
             sdb.close();
        }

        return res.json({ success: true, accounts, count: accounts.length });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.get('/api/local/adaccounts', async (req, res) => {
    try {
        const pid = String((req.query && (req.query.profileId || req.query.pid)) || '')
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdAccountsTable(sdb)
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

// 本地兼容存储服务：Profiles 列表
app.get('/api/profiles', async (req, res) => {
    try {
        const sdb = new sqlite3.Database(dbPath)
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

// 兼容：Profiles 单条
app.get('/api/profiles/:id', async (req, res) => {
    try {
        const profileId = String(req.params.id || '')
        const sdb = new sqlite3.Database(dbPath)
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

// 本地兼容存储服务：AdAccounts 列表
app.get('/api/adaccounts', async (req, res) => {
    try {
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdAccountsTable(sdb)
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

// 本地兼容存储服务：Businesses/BillingMethods 空列表
app.get('/api/businesses', async (_req, res) => {
    return res.json({ success: true, data: [] })
})
app.get('/api/billing-methods', async (_req, res) => {
    return res.json({ success: true, data: [] })
})

// AdPOS：卡与交易（本地空/表驱动返回）
function ensureAdposTables(db){
    return new Promise((resolve)=>{
        db.serialize(()=>{
            db.run(`CREATE TABLE IF NOT EXISTS adpos_cards (id TEXT PRIMARY KEY, alias TEXT, last_four_digits TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`) 
            db.run(`CREATE TABLE IF NOT EXISTS adpos_transactions (id TEXT PRIMARY KEY, amount REAL, currency TEXT, status TEXT, created_at DATETIME, card_id TEXT, last_four_digits TEXT)`, [], ()=>resolve())
        })
    })
}
function ensureAdposPrefs(db){
    return new Promise((resolve)=>{
        db.serialize(()=>{
            db.run(`CREATE TABLE IF NOT EXISTS adpos_prefs (profile_id TEXT PRIMARY KEY, auto_refresh INTEGER, auto_save_local INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, [], ()=>resolve())
        })
    })
}
app.get('/api/adpos/cards/all', async (req, res) => {
    try {
        const per = Math.max(1, Math.min(Number(req.query.per_page||500), 1000))
        const page = Math.max(1, Number(req.query.page||1))
        const offset = (page-1) * per
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposTables(sdb)
        const rows = await new Promise((resolve, reject)=>{
            sdb.all(`SELECT id, alias, last_four_digits FROM adpos_cards ORDER BY created_at DESC LIMIT ? OFFSET ?`, [per, offset], (err, r)=> (err?reject(err):resolve(r||[])))
        })
        await new Promise(r=>sdb.close(r))
        return res.json({ success: true, data: rows, meta: { pagination: { current_page: page, per_page: per, count: rows.length, total_pages: 1, total: rows.length } } })
    } catch(e){ return res.status(500).json({ success:false, message:'error', error:String(e.message||e) }) }
})
app.get('/api/adpos/cards', (req, res) => { req.url = '/api/adpos/cards/all' ; return app._router.handle(req, res, ()=>{}) })
app.get('/api/adpos/transactions/all', async (req, res) => {
    try {
        const per = Math.max(1, Math.min(Number(req.query.per_page||200), 2000))
        const page = Math.max(1, Number(req.query.page||1))
        const offset = (page-1) * per
        const start = Number(req.query.start_timestamp||0)
        const end = Number(req.query.end_timestamp||0)
        const status = String(req.query.status||'').trim().toLowerCase()
        const last4 = String((req.query.last4||req.query.card_number||'')).trim()
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposTables(sdb)
        let sql = `SELECT id, amount, currency, status, created_at, card_id, last_four_digits FROM adpos_transactions`
        const args = []
        const conds = []
        if (start>0) { conds.push(`created_at >= datetime(?, 'unixepoch')`); args.push(start) }
        if (end>0) { conds.push(`created_at <= datetime(?, 'unixepoch')`); args.push(end) }
        if (status) { conds.push(`LOWER(status) = ?`); args.push(status) }
        if (last4) { conds.push(`last_four_digits LIKE ?`); args.push(`%${last4}%`) }
        if (conds.length) sql += ` WHERE ` + conds.join(' AND ')
        sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`; args.push(per, offset)
        const rows = await new Promise((resolve, reject)=>{ sdb.all(sql, args, (err, r)=> (err?reject(err):resolve(r||[]))) })
        await new Promise(r=>sdb.close(r))
        return res.json({ success: true, data: rows, meta: { pagination: { current_page: page, per_page: per, count: rows.length, total_pages: 1, total: rows.length } } })
    } catch(e){ return res.status(500).json({ success:false, message:'error', error:String(e.message||e) }) }
})
app.get('/api/adpos/transactions/by-card', async (req, res) => {
    try {
        const per = Math.max(1, Math.min(Number(req.query.per_page||200), 2000))
        const page = Math.max(1, Number(req.query.page||1))
        const offset = (page-1) * per
        const cardId = String(req.query.card_id||'').trim()
        const last4 = String((req.query.last4||req.query.card_number||'')).trim()
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposTables(sdb)
        let sql = `SELECT id, amount, currency, status, created_at, card_id, last_four_digits FROM adpos_transactions WHERE card_id = ?`
        const args = [cardId]
        if (last4) { sql += ` AND last_four_digits LIKE ?`; args.push(`%${last4}%`) }
        sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`; args.push(per, offset)
        const rows = await new Promise((resolve, reject)=>{
            sdb.all(sql, args, (err, r)=> (err?reject(err):resolve(r||[])))
        })
        await new Promise(r=>sdb.close(r))
        return res.json({ success: true, data: rows, meta: { pagination: { current_page: page, per_page: per, count: rows.length, total_pages: 1, total: rows.length } } })
    } catch(e){ return res.status(500).json({ success:false, message:'error', error:String(e.message||e) }) }
})
app.get('/api/adpos/transactions', (req, res) => { req.url = '/api/adpos/transactions/all' ; return app._router.handle(req, res, ()=>{}) })

async function adposFetch(pathname, token, baseUrl){
    const base = String(baseUrl || 'https://api.adpos.io').replace(/\/$/, '')
    const url = `${base}${pathname.startsWith('/')?pathname:`/${pathname}`}`
    const headers = { 'Accept': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const r = await fetch(url, { headers })
    const j = await r.json().catch(()=>({}))
    return j
}

app.post('/api/adpos/sync', async (req, res) => {
    try {
        const { token, baseUrl, start_timestamp, end_timestamp, per_page } = req.body || {}
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposTables(sdb)
        let savedCards = 0, savedTxns = 0
        try {
            const cj = await adposFetch('/cards?page=1&per_page=500', token, baseUrl)
            const cards = Array.isArray(cj?.data) ? cj.data : []
            for (const c of cards) {
                const id = String(c.id || c.card_id || '')
                const alias = String(c.alias || c.name || '')
                const last4 = String(c.last_four_digits || c.card_last4 || '')
                if (!id) continue
                await new Promise((resolve, reject)=>{
                    sdb.run(`INSERT OR REPLACE INTO adpos_cards (id, alias, last_four_digits) VALUES (?, ?, ?)`, [id, alias, last4], (err)=> (err?reject(err):resolve()))
                })
                savedCards++
            }
        } catch{}
        try {
            const per = Math.max(1, Math.min(Number(per_page||500), 1000))
            const qs = `per_page=${per}` + (start_timestamp?`&start_timestamp=${Number(start_timestamp)||0}`:'') + (end_timestamp?`&end_timestamp=${Number(end_timestamp)||0}`:'')
            const tj = await adposFetch(`/transactions?${qs}`, token, baseUrl)
            const txns = Array.isArray(tj?.data) ? tj.data : []
            for (const t of txns) {
                const id = String(t.id || '')
                const amount = Number(t.amount || 0)
                const currency = String(t.currency || '')
                const status = String(t.status || '')
                const created_at = String(t.created_at || t.date || '')
                const card_id = String(t.card_id || '')
                const last4 = String(t.last_four_digits || t.card_last4 || '')
                if (!id) continue
                await new Promise((resolve, reject)=>{
                    sdb.run(`INSERT OR REPLACE INTO adpos_transactions (id, amount, currency, status, created_at, card_id, last_four_digits) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, amount, currency, status, created_at, card_id, last4], (err)=> (err?reject(err):resolve()))
                })
                savedTxns++
            }
        } catch{}
        await new Promise(r=>sdb.close(r))
        return res.json({ success: true, savedCards, savedTxns })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
    }
})
app.post('/api/adpos/transactions/save-batch', async (req, res) => {
    try {
        const items = (req.body && (req.body.items || req.body.data || req.body)) || []
        const list = Array.isArray(items) ? items : []
        if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposTables(sdb)
        let saved = 0
        for (const t of list) {
            const id = String(t.id || '')
            const amount = Number(t.amount || 0)
            const currency = String(t.currency || '')
            const status = String(t.status || '')
            const created_at = String(t.created_at || t.date || '')
            const card_id = String(t.card_id || '')
            const last4 = String(t.last_four_digits || t.card_last4 || '')
            if (!id) continue
            await new Promise((resolve, reject)=>{
                sdb.run(`INSERT OR REPLACE INTO adpos_transactions (id, amount, currency, status, created_at, card_id, last_four_digits) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, amount, currency, status, created_at, card_id, last4], (err)=> (err?reject(err):resolve()))
            })
            saved++
        }
        await new Promise(r=>sdb.close(r))
        return res.json({ success: true, saved })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
    }
})
app.get('/api/adpos/prefs', async (req, res) => {
    try {
        const pid = String((req.query && (req.query.profileId || req.query.pid)) || '')
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposPrefs(sdb)
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
app.post('/api/adpos/prefs', async (req, res) => {
    try {
        const body = req.body || {}
        const pid = String(body.profileId || body.pid || '')
        const auto_refresh = body.auto_refresh ? 1 : 0
        const auto_save_local = body.auto_save_local ? 1 : 0
        if (!pid) return res.status(400).json({ success: false, message: 'missing_profileId' })
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposPrefs(sdb)
        await new Promise((resolve, reject)=>{
            sdb.run(`INSERT OR REPLACE INTO adpos_prefs (profile_id, auto_refresh, auto_save_local, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, [pid, auto_refresh, auto_save_local], (err)=> (err?reject(err):resolve()))
        })
        await new Promise(r=>sdb.close(r))
        return res.json({ success: true })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
    }
})
app.get('/api/facebook/prefs', async (req, res) => {
    try {
        const pid = String((req.query && (req.query.profileId || req.query.pid)) || '')
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposPrefs(sdb)
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
app.post('/api/facebook/prefs', async (req, res) => {
    try {
        const body = req.body || {}
        const pid = String(body.profileId || body.pid || '')
        const auto_refresh = body.auto_refresh ? 1 : 0
        const auto_save_local = body.auto_save_local ? 1 : 0
        if (!pid) return res.status(400).json({ success: false, message: 'missing_profileId' })
        const sdb = new sqlite3.Database(dbPath)
        await ensureAdposPrefs(sdb)
        await new Promise((resolve, reject)=>{
            sdb.run(`INSERT OR REPLACE INTO adpos_prefs (profile_id, auto_refresh, auto_save_local, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, [pid, auto_refresh, auto_save_local], (err)=> (err?reject(err):resolve()))
        })
        await new Promise(r=>sdb.close(r))
        return res.json({ success: true })
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
    }
})

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
app.post('/api/facebook/adaccounts/sync', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: true, saved: 0, status: 'no_browser' });
        }
        const page = await browserData.context.newPage();
        let accounts = [];
        try {
            await page.goto('https://business.facebook.com/adsmanager/manage/accounts', { waitUntil: 'networkidle', timeout: 20000 });
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
        return res.json({ success: true, saved });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});
app.post('/api/facebook/adaccount-settings', async (req, res) => {
    try {
        const { profileId, adaccountId } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: true, timezone_id: null, currency: null, status: 'no_browser' });
        }
        const page = await browserData.context.newPage();
        let timezone_id = null;
        let currency = null;
        try {
            const act = adaccountId ? `act=${adaccountId}` : '';
            await page.goto(`https://business.facebook.com/adsmanager/settings/account_settings/?${act}`, { waitUntil: 'networkidle', timeout: 25000 });
            const data = await page.evaluate(() => {
                let tz = null, cur = null;
                const txt = document.body.textContent || '';
                const tm = txt.match(/时区[:：]\s*([\w\-\s\/]+)/) || txt.match(/Timezone[:：]\s*([\w\-\s\/]+)/i);
                if (tm) tz = tm[1].trim();
                const cm = txt.match(/货币[:：]\s*([A-Z]{3})/) || txt.match(/Currency[:：]\s*([A-Z]{3})/i);
                if (cm) cur = cm[1].trim();
                return { tz, cur };
            });
            timezone_id = data.tz;
            currency = data.cur;
        } catch(_){ }
        try { await page.close(); } catch(_){ }
        return res.json({ success: true, timezone_id, currency });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});
app.post('/api/facebook/billing', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: true, methods: [], status: 'no_browser' });
        }
        const page = await browserData.context.newPage();
        let methods = [];
        try {
            await page.goto('https://business.facebook.com/adsmanager/billing', { waitUntil: 'networkidle', timeout: 25000 });
            methods = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                return items.map(el => {
                    const t = el.textContent || '';
                    const type = (t.match(/信用卡|Debit|Visa|Mastercard|Amex/i) || [])[0] || 'Payment';
                    const last4 = (t.match(/\d{4}/) || [])[0] || '';
                    return { type, last4 };
                });
            });
        } catch(_){ }
        try { await page.close(); } catch(_){ }
        return res.json({ success: true, methods });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.post('/api/facebook/billing/cards/merged', async (req, res) => {
    try {
        const { profileId, adAccountId } = req.body || {};
        const pid = String(profileId || '');
        const act = String(adAccountId || '');
        const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
        const storageBase = storageServerUrl.replace(/\/$/, '');
        let stash = [];
        let adpos = [];
        try {
            const r = await fetch(`${storageBase}/api/billing-methods`).catch(()=>null);
            const j = r && await r.json().catch(()=>({}));
            stash = Array.isArray(j && j.data) ? j.data : [];
        } catch {}
        try {
            const r = await adposClient.listAllCards({ profileId: pid, per_page: 500 });
            adpos = Array.isArray(r && r.data) ? r.data : [];
        } catch {}
        const merged = [];
        for (const s of stash) {
            merged.push({ last4: String(s.last4||''), brand: String(s.brand||''), holder: '', provider: '', tags: [], cvv: '', cardNumber: '', profile_id: String(s.profile_id||pid), account_id: String(s.account_id||act), billing_address: String(s.billing_address||'') });
        }
        for (const c of adpos) {
            merged.push({
                last4: String(c.last_four_digits || c.last4 || ''),
                brand: String(c.card_type || c.brand || ''),
                holder: String(c.name || ''),
                provider: String(c.provider || ''),
                tags: Array.isArray(c.tags) ? c.tags.map((x)=>String(x)) : [],
                cvv: '',
                cardNumber: String(c.card_number || ''),
                profile_id: pid,
                account_id: act,
                balance: typeof c.available_balance === 'number' ? c.available_balance : undefined,
                currency: String(c.currency || ''),
                status: String(c.status || ''),
                appliedAt: String(c.applied_at || ''),
                singleLimit: typeof c.single_transaction_limit === 'number' ? c.single_transaction_limit : undefined,
                autoTopup: typeof c.auto_topup === 'number' ? c.auto_topup : undefined,
                cardType: String(c.card_type || '')
            });
        }
        const uniq = [];
        const seen = new Set();
        for (const x of merged) {
            const k = String(x.last4||'');
            if (!k || seen.has(k)) continue;
            seen.add(k);
            uniq.push(x);
        }
        return res.json({ success: true, count: uniq.length, cards: uniq });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

/**
 * 🚀 信用卡绑定 API - 通过 Puppeteer 真实填入信用卡信息
 */
app.post('/api/facebook/billing/add', async (req, res) => {
    try {
        const { profileId, adAccountId, mode, card, method, channel, tag } = req.body || {};
        const pid = String(profileId || '');
        const actId = String(adAccountId || '').replace('act_', '');

        log('INFO', `💳 [Profile=${pid}] 收到信用卡绑定请求: mode=${mode}, actId=${actId}`);

        // 1. 获取浏览器实例
        const browserData = activeBrowsers.get(pid);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: false, status: 'no_browser', message: '浏览器未启动，请先启动浏览器' });
        }

        const page = await browserData.context.newPage();
        
        try {
            // 2. 导航到账单支付设置页
            const billingUrl = actId
                ? `https://business.facebook.com/latest/billing_hub/payment_settings/?asset_id=${encodeURIComponent(actId)}`
                : 'https://business.facebook.com/latest/billing_hub/payment_settings/';
            
            log('INFO', `🧭 [Profile=${pid}] 导航至账单页面: ${billingUrl}`);
            await page.goto(billingUrl, { waitUntil: 'networkidle', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));

            // 3. 点击"添加支付方式"按钮
            log('INFO', `🔍 [Profile=${pid}] 查找"添加支付方式"按钮...`);
            const addBtnClicked = await page.evaluate(() => {
                const selectors = [
                    '[data-testid*="add_payment" i]',
                    '[data-testid*="addPayment" i]',
                    '[aria-label*="Add payment" i]',
                    '[aria-label*="添加支付" i]',
                    'div[role="button"]',
                ];
                for (const sel of selectors) {
                    try {
                        const el = document.querySelector(sel);
                        if (el && (el.textContent || '').match(/add.*payment|添加.*支付/i)) {
                            el.click();
                            return true;
                        }
                    } catch (_) {}
                }
                // fallback: 查找所有 button
                const buttons = document.querySelectorAll('button, a, div[role="button"]');
                for (const btn of Array.from(buttons)) {
                    if ((btn.textContent || '').match(/add.*payment|添加.*支付/i)) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });

            if (!addBtnClicked) {
                // 尝试直接打开添加支付表单页面
                log('WARN', `⚠️ [Profile=${pid}] 未找到添加按钮，尝试直接打开表单页面`);
                await page.goto('https://business.facebook.com/latest/billing_hub/payment_settings/add', { waitUntil: 'networkidle', timeout: 20000 });
                await new Promise(r => setTimeout(r, 3000));
            }

            await new Promise(r => setTimeout(r, 2000));

            if (mode === 'manual' && card) {
                // 🚀 手动输入信用卡信息
                log('INFO', `✍️ [Profile=${pid}] 开始填写信用卡信息...`);

                const fillResult = await page.evaluate((cardData) => {
                    var log = [];
                    
                    function fillInput(selectors, value) {
                        for (var i = 0; i < selectors.length; i++) {
                            try {
                                var el = document.querySelector(selectors[i]);
                                if (el) {
                                    el.focus();
                                    el.value = '';
                                    el.dispatchEvent(new Event('focus', { bubbles: true }));
                                    // 逐字符输入以触发 React 事件
                                    for (var j = 0; j < value.length; j++) {
                                        var ch = value[j];
                                        el.value += ch;
                                        el.dispatchEvent(new Event('input', { bubbles: true }));
                                        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
                                        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
                                    }
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                                    return true;
                                }
                            } catch (_) {}
                        }
                        return false;
                    }
                    
                    // 找到并填写卡号
                    var cardNumberSelectors = [
                        'input[name*="card"][name*="number"]',
                        'input[placeholder*="card"][placeholder*="number"]',
                        'input[aria-label*="card number"]',
                        'input[autocomplete="cc-number"]',
                        'input[id*="credit"][id*="card"]',
                        'input[id*="card"][id*="number"]'
                    ];
                    if (fillInput(cardNumberSelectors, cardData.number)) log.push('card_number: filled');

                    // 填写持有人姓名
                    var holderSelectors = [
                        'input[name*="holder"]',
                        'input[placeholder*="holder"]',
                        'input[placeholder*="name"]',
                        'input[aria-label*="cardholder"]',
                        'input[autocomplete="cc-name"]'
                    ];
                    if (cardData.holder && fillInput(holderSelectors, cardData.holder)) log.push('holder: filled');

                    // 填写有效期
                    if (cardData.exp_month && cardData.exp_year) {
                        var expiryVal = cardData.exp_month + '/' + cardData.exp_year;
                        var expirySelectors = [
                            'input[name*="expir"]',
                            'input[placeholder*="MM"]',
                            'input[placeholder*="expir"]',
                            'input[autocomplete="cc-exp"]',
                            'input[aria-label*="expir"]'
                        ];
                        if (fillInput(expirySelectors, expiryVal)) log.push('expiry: filled');
                    }

                    // 填写 CVV
                    if (cardData.cvv) {
                        var cvvSelectors = [
                            'input[name*="cvv"]',
                            'input[name*="cvc"]',
                            'input[name*="security"]',
                            'input[placeholder*="CVV"]',
                            'input[placeholder*="cvv"]',
                            'input[autocomplete="cc-csc"]',
                            'input[aria-label*="security code"]'
                        ];
                        if (fillInput(cvvSelectors, cardData.cvv)) log.push('cvv: filled');
                    }

                    return log;
                }, { number: card.number, holder: card.holder, exp_month: card.exp_month, exp_year: card.exp_year, cvv: card.cvv });

                log('INFO', `📝 [Profile=${pid}] 填写结果: ${JSON.stringify(fillResult)}`);
                await new Promise(r => setTimeout(r, 1500));

                // 查找并点击"保存"/"继续"按钮
                const saveClicked = await page.evaluate(() => {
                    var buttons = document.querySelectorAll('button, a, div[role="button"], input[type="submit"]');
                    for (var i = 0; i < buttons.length; i++) {
                        var txt = (buttons[i].textContent || '').trim();
                        if (/save|保存|continue|继续|add|添加/i.test(txt)) {
                            buttons[i].click();
                            return true;
                        }
                    }
                    return false;
                });

                if (saveClicked) {
                    log('INFO', `✅ [Profile=${pid}] 已点击保存按钮`);
                    await new Promise(r => setTimeout(r, 4000));
                } else {
                    log('WARN', `⚠️ [Profile=${pid}] 未找到保存按钮，请在浏览器中手动完成`);
                }
            } else if (mode === 'existing' && method) {
                // 🚀 从已有卡片中选择绑定
                log('INFO', `🔄 [Profile=${pid}] 选择已有卡片: ${method.last4}`);
                await page.evaluate((last4) => {
                    var items = document.querySelectorAll('[role="listitem"], [role="option"]');
                    for (var i = 0; i < items.length; i++) {
                        if ((items[i].textContent || '').indexOf(last4) !== -1) {
                            items[i].click();
                            return;
                        }
                    }
                }, method.last4 || '');
                await new Promise(r => setTimeout(r, 2000));
            }

            // 保存到本地数据库和云端
            const savedCard = {
                profile_id: pid,
                account_id: actId,
                last4: (card?.number || method?.last4 || '').slice(-4),
                brand: detectCardBrand(card?.number || ''),
                channel: String(channel || ''),
                tag: String(tag || ''),
                status: 'pending_verification',
                appliedAt: new Date().toISOString()
            };

            // 同步到云端
            try {
                const storageUrl = process.env.STORAGE_SERVER_URL || '';
                await fetch(`${storageUrl.replace(/\/$/, '')}/api/billing-methods/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': process.env.PUPPETEER_API_SECRET || '' },
                    body: JSON.stringify(savedCard)
                }).catch(() => {});
            } catch {}

            await page.close();
            return res.json({
                success: true,
                card: savedCard,
                message: '卡片信息已填写，请在浏览器中完成最终验证（如 OTP）'
            });

        } catch (innerErr) {
            try { await page.close(); } catch {}
            throw innerErr;
        }
    } catch (e) {
        log('ERROR', `💳 信用卡绑定失败: ${e.message}`);
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});

function detectCardBrand(number) {
    const n = String(number || '').replace(/\D/g, '');
    if (/^4/.test(n)) return 'Visa';
    if (/^5[1-5]/.test(n)) return 'Mastercard';
    if (/^3[47]/.test(n)) return 'Amex';
    if (/^6/.test(n)) return 'Discover';
    return '';
}

app.use((req, res, next) => {
    const p = String(req.path || '');
    if (/^\/api\/facebook\/billing\/verify/.test(p)) {
        return res.status(403).json({ success: false, message: 'disabled' });
    }
    next();
});
// 触发当前浏览器页面上的“Verify/验证”按钮点击（不新开标签）
app.post('/api/facebook/billing/verify-click', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const browserData = activeBrowsers.get(String(profileId || ''));
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: false, status: 'no_browser' });
        }
        const browser = browserData.context;
        const pages = await browser.pages();
        if (!pages || !pages.length) return res.json({ success: false, status: 'no_pages' });
        let clicked = false; let source = '';
        const tryClickOnPage = async (page) => {
            try { await page.bringToFront(); } catch {}
            try { await new Promise(r => setTimeout(r, )); } catch {}
            for (let i = 0; i < 16 && !clicked; i++) {
                try { await new Promise(r => setTimeout(r, )); } catch {}
                // 清理常见遮挡
                try { await page.evaluate(() => { const hideByText = (t) => Array.from(document.querySelectorAll('*')).filter(el => (el.textContent||'').includes(t)); hideByText('Google Translate').forEach(el => { try { el.style.setProperty('display','none','important'); } catch(_){} }); }); } catch {}
                // CTA或弹窗
                try {
                    const info = await page.evaluate(() => {
                        const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                        const modal = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                        const scope = modal || document;
                        const btns = Array.from(scope.querySelectorAll('button, div[role="button"], a[role="button"], [aria-label]'));
                        const eq = ['verify','verifier','verificar','verifica'];
                        let t = btns.find(b => eq.includes(norm(b.textContent)));
                        if (!t) t = btns.find(b => /verify payment method|verifier payment method|verify card|verifier la carte|verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.textContent)));
                        if (!t) t = btns.find(b => /verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.getAttribute('aria-label'))));
                        if (t) { try { t.scrollIntoView({ block:'center' }); } catch(_){ } t.click(); return { clicked: true, source: modal ? 'modal' : 'cta' }; }
                        return { clicked: false, source: '' };
                    });
                    if (info && info.clicked) { clicked = true; source = info.source || source; }
                } catch {}
                if (!clicked) {
                    try {
                        const els = await page.$$('button, div[role="button"], a[role="button"], [aria-label]');
                        for (const el of els) {
                            try {
                                const txt = (await page.evaluate(e => (e.textContent||'').trim(), el)) || '';
                                const aria = (await page.evaluate(e => e.getAttribute('aria-label') || '', el)) || '';
                                const t = `${txt}\n${aria}`.toLowerCase();
                                if (/\bverify\b/.test(t) || /验证|确认/.test(t)) {
                                    try { await el.scrollIntoViewIfNeeded(); } catch(_){}
                                    try { await el.click({ delay: 10 }); clicked = true; source = source || 'handle.click'; break; } catch(_){}
                                }
                            } catch {}
                        }
                    } catch {}
                }
                if (clicked) break;
                // 真实鼠标兜底
                try {
                    const handle = await page.evaluateHandle(() => {
                        const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                        const modal = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                        const scope = modal || document;
                        const btns = Array.from(scope.querySelectorAll('button, div[role="button"], a[role="button"], [aria-label]'));
                        const eq = ['verify','verifier','verificar','verifica'];
                        let t = btns.find(b => eq.includes(norm(b.textContent)));
                        if (!t) t = btns.find(b => /verify payment method|verifier payment method|verify card|verifier la carte|verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.textContent)));
                        if (!t) t = btns.find(b => /verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.getAttribute('aria-label'))));
                        if (!t) {
                            const cand = btns.find(b => {
                                const cs = getComputedStyle(b);
                                const bg = (cs.backgroundColor || '').toLowerCase();
                                const bd = (cs.borderColor || '').toLowerCase();
                                return /rgb\(24,\s*119,\s*242\)/i.test(bg) || /rgb\(24,\s*119,\s*242\)/i.test(bd);
                            });
                            t = cand || t;
                        }
                        if (t) { try { t.scrollIntoView({ block:'center' }); } catch(_){} }
                        return t || null;
                    });
                    if (handle && handle.asElement()) {
                        try {
                            await page.evaluate(el => {
                                try { el.removeAttribute('disabled'); } catch(_){}
                                const ev = (n, opts={}) => { try { el.dispatchEvent(new MouseEvent(n, { bubbles:true, cancelable:true, composed:true, ...opts })); } catch(_){} };
                                ev('pointerdown'); ev('mousedown'); ev('pointerup'); ev('mouseup'); ev('click');
                            }, handle);
                            clicked = true; source = source || 'dispatch';
                        } catch {}
                        if (!clicked) {
                            const box = await handle.boundingBox();
                            if (box) {
                                await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                await page.mouse.down();
                                await new Promise(r => setTimeout(r, ));
                                await page.mouse.up();
                                clicked = true; source = source || 'mouse';
                            }
                        }
                        try { await handle.dispose(); } catch {}
                    }
                } catch {}
                if (!clicked) {
                    // 对话框右下角坐标兜底
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
                            try { await page.mouse.click(x, y, { clickCount: 2, delay: 20 }); } catch {}
                            clicked = true; source = source || 'corner';
                        }
                    } catch {}
                }
                if (!clicked) {
                    try {
                        const ok = await page.evaluate(() => {
                            const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                            if (!dlg) return false;
                            const dr = dlg.getBoundingClientRect();
                            const inside = (r) => r.left >= dr.left && r.right <= dr.right && r.top >= dr.top && r.bottom <= dr.bottom;
                            const list = Array.from(document.querySelectorAll('*')).filter(el => {
                                const r = el.getBoundingClientRect();
                                if (!r || r.width < 60 || r.height < 32) return false;
                                if (!inside(r)) return false;
                                const cs = getComputedStyle(el);
                                const bg = (cs.backgroundColor || '').toLowerCase();
                                const color = (cs.color || '').toLowerCase();
                                const txt = (el.textContent || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                                const isBlue = /rgb\(24,\s*119,\s*242\)/i.test(bg) || /rgb\(24,\s*119,\s*242\)/i.test(color);
                                const hasTxt = /\bverify\b|\bverifier\b|\bverificar\b|\bverifica\b/.test(txt) || /验证|确认/.test(txt);
                                return isBlue || hasTxt;
                            });
                            const t = list[0];
                            if (t) { try { t.scrollIntoView({ block:'center' }); } catch(_){} ; try { t.click(); return true; } catch(_){} }
                            return false;
                        });
                        if (ok) { clicked = true; source = source || 'modal-scan'; }
                    } catch {}
                }
                if (!clicked) {
                    // 键盘遍历触发
                    try {
                        for (let k = 0; k < 6; k++) { await page.keyboard.press('Tab'); await new Promise(r => setTimeout(r, )); }
                        await page.keyboard.press('Enter');
                    } catch {}
                }
                if (clicked) break;
                // iframe向导
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
                                    if (t) { try { t.setAttribute('data-auto-click-target','1'); t.scrollIntoView({ block:'center' }); } catch(_){}; return true; }
                                    return false;
                                });
                                if (marked) {
                                    const h = await f.$('[data-auto-click-target="1"]');
                                    if (h) {
                                        const box = await h.boundingBox();
                                        if (box) {
                                            await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                            await page.mouse.down();
                                            await new Promise(r => setTimeout(r, ));
                                            await page.mouse.up();
                                            clicked = true; source = source || 'iframe'; break;
                                        }
                                    }
                                }
                            }
                        } catch {}
                    }
                } catch {}
                if (!clicked) {
                    // 页面顶部CTA“Verify payment method”兜底
                    try {
                        const h2 = await page.evaluateHandle(() => {
                            const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                            const cand = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], [aria-label]')).find(b => /verify payment method|verifier payment method|验证付款方式|验证支付方式/i.test(norm(b.textContent)) || /verify payment method|verifier payment method|验证|确认/i.test(norm(b.getAttribute('aria-label'))));
                            if (cand) { try { cand.setAttribute('data-auto-click-target','1'); cand.scrollIntoView({ block:'center' }); } catch(_){} }
                            return cand || null;
                        });
                        if (h2 && h2.asElement()) {
                            const box = await h2.boundingBox();
                            if (box) {
                                await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                await page.mouse.down();
                                await new Promise(r => setTimeout(r, ));
                                await page.mouse.up();
                                clicked = true; source = source || 'cta-top';
                            }
                            try { await h2.dispose(); } catch {}
                        }
                    } catch {}
                }
            }
        };
        for (const p of pages) {
            try {
                const u = String(p.url() || '');
                const isBilling = /business\.facebook\.com\/billing_hub\/payment_settings|adsmanager\.facebook\.com\/adsmanager\/manage\/billing/i.test(u);
                await tryClickOnPage(p);
                if (clicked) break;
                if (!isBilling) {
                    // 非账单页也尝试一次（弹窗可能在其他页面）
                    await tryClickOnPage(p);
                    if (clicked) break;
                }
            } catch {}
        }
        if (!clicked) {
            try {
                const ok = await pages[0].evaluate(() => {
                    const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                    if (!dlg) return false;
                    const r = dlg.getBoundingClientRect();
                    const el = document.elementFromPoint(Math.floor(r.right - 40), Math.floor(r.bottom - 30));
                    if (el && typeof el.click === 'function') { try { el.click(); return true; } catch(_){} }
                    return false;
                });
                if (ok) clicked = true; source = source || 'elementFromPoint';
            } catch {}
        }
        // 不再进行“直接导航向导页”的兜底，严格模拟人工点击保持在当前页面
        if (clicked) {
            try { await Promise.race([ page.waitForNavigation({ waitUntil: 'networkidle', timeout: 8000 }).catch(()=>{}), new Promise(r => setTimeout(r, 1000)) ]); } catch {}
        }
        return res.json({ success: !!clicked, source: String(source||'') });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.post('/api/facebook/billing/otp/auto-fill', async (req, res) => {
    try {
        const { profileId, adAccountId, last4, code } = req.body || {};
        const pid = String(profileId || '');
        const aid = String(adAccountId || '');
        const l4 = String(last4 || '').slice(-4);
        const browserData = activeBrowsers.get(pid);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: false, status: 'no_browser' });
        }
        const debugPort = browserData.debugPort;
        let otp = String(code || '');
        if (!otp) {
            try {
                const http = require('http');
                const qs = encodeURI(`last4=${l4}${pid?`&profileId=${pid}`:''}${aid?`&accountId=${aid}`:''}`);
                const data = await new Promise((resolve, reject) => {
                const reqOpt = { hostname: 'localhost', port: 7070, path: `/api/verification-codes/latest?${qs}`, method: 'GET' };
                    const r = http.request(reqOpt, (resp) => { let raw=''; resp.on('data',d=>raw+=d); resp.on('end',()=>{ try { resolve(JSON.parse(raw)); } catch(e){ reject(e) } }); });
                    r.on('error', reject); r.end();
                });
                if (data && data.success && data.data && data.data.code) { otp = String(data.data.code); }
            } catch {}
        }
        if (!otp) return res.json({ success: false, status: 'missing_code' });
        const http = require('http');
        const payload = JSON.stringify({
            expression: `(() => { const sel = [ 'input[autocomplete=one-time-code]', 'input[name*=code i]', 'input[id*=code i]', 'input[placeholder*=code i]', 'input[aria-label*=code i]', 'input[aria-label*=验证码 i]' ]; let input = null; for (const s of sel) { try { const el = document.querySelector(s); if (el) { input = el; break; } } catch {} } if (!input) { const ins = Array.from(document.querySelectorAll('input')); input = ins.find(i => { const t = (i.getAttribute('name')||i.id||i.placeholder||'').toLowerCase(); return t.includes('code') || t.includes('otp') || t.includes('验证码'); }) || null; } if (input) { try { input.focus(); input.value = '${otp.replace(/'/g,"\\'")}'; const ev = new Event('input',{bubbles:true}); input.dispatchEvent(ev); } catch {} } const btns = Array.from(document.querySelectorAll('button, [role=button], a')); const btn = btns.find(b => /验证|确认|继续|提交|verify|continue|next/i.test((b.textContent||'').trim())) || null; if (btn) { try { btn.click(); } catch {} } return input ? 'filled' : 'not_found'; })()`,
            awaitPromise: false,
            returnByValue: true,
            targetUrlContains: 'payments.facebook.com/business_payments/wizard',
            targetType: 'iframe'
        });
        const opt = { hostname: 'localhost', port: PORT, path: `/api/devtools/${debugPort}/runtime/evaluate`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
        const result = await new Promise((resolve, reject) => { const rq = http.request(opt, (resp)=>{ let raw=''; resp.on('data',d=>raw+=d); resp.on('end',()=>{ try { resolve(JSON.parse(raw)); } catch(e){ reject(e) } }); }); rq.on('error', reject); rq.write(payload); rq.end(); });
        const ok = !!(result && result.success);
        return res.json({ success: ok, status: ok ? 'ok' : 'failed' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.post('/api/facebook/billing/list-methods', async (req, res) => {
    try {
        const { profileId, adAccountId, url } = req.body || {};
        const bd = activeBrowsers.get(String(profileId || ''));
        if (!bd || !bd.context || !bd.context.browser()) {
            return res.json({ success: false, status: 'no_browser' });
        }
        const page = await bd.context.newPage();
        let targetUrl = String(url || '');
        if (!targetUrl) {
            targetUrl = 'https://business.facebook.com/adsmanager/billing';
            try {
                const acc = String(adAccountId || '').trim();
                if (acc) {
                    const actId = acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc);
                    targetUrl = `https://business.facebook.com/adsmanager/manage/billing?act=${encodeURIComponent(actId)}`;
                }
            } catch {}
        }
        try { await page.setDefaultTimeout(60000); } catch {}
        try { await page.setDefaultNavigationTimeout(60000); } catch {}
        try {
            const conn = await mainDbPool.getConnection();
            const row = await new Promise((resolve) => {
                conn.get(`SELECT account_cookies FROM profiles WHERE id = ?`, [String(profileId || '')], (err, r) => resolve(err ? null : r));
            });
            mainDbPool.releaseConnection(conn);
            if (row && row.account_cookies) {
                let cookies = null;
                try { cookies = JSON.parse(row.account_cookies); } catch { cookies = null; }
                if (Array.isArray(cookies) && cookies.length > 0) {
                    for (const ck of cookies) {
                        try {
                            const host = 'business.facebook.com';
                            let domain = ck.domain || host;
                            if (/facebook\.com$/i.test(domain)) domain = '.facebook.com';
                            await page.context().addCookies([{
                                name: ck.name,
                                value: ck.value,
                                domain,
                                path: ck.path || '/',
                                secure: ck.secure !== undefined ? ck.secure : true,
                                httpOnly: !!ck.httpOnly,
                                sameSite: ck.sameSite || 'None',
                                expires: ck.expirationDate || ck.expiry
                            }]);
                        } catch {}
                    }
                }
            }
        } catch {}
        try { await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 }); } catch {}
        try {
            const needLogin = await page.evaluate(() => {
                const u = location.href || '';
                const hasPwd = !!document.querySelector('input[type="password"], input[name*="pass" i], input[id*="pass" i]');
                const hasEmail = !!document.querySelector('input[name="email"], input[type="email"]');
                return /login|signin|accounts\.facebook/i.test(u) || (hasPwd && hasEmail);
            });
            if (needLogin) { try { await page.close(); } catch {} ; return res.json({ success: false, status: 'not_logged_in' }); }
        } catch {}
        let methods = [];
        try {
            try { await new Promise(r => setTimeout(r, )); } catch {}
            try { await page.waitForSelector('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod', { timeout: 15000 }); } catch {}
            methods = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                const norm = s => String(s||'').toLowerCase();
                const parseBrand = t => (/visa/i.test(t) ? 'Visa' : (/master/i.test(t) ? 'Mastercard' : (/amex/i.test(t) ? 'Amex' : (/debit/i.test(t) ? 'Debit' : ''))));
                return items.map(el => {
                    const t = el.textContent || '';
                    const last4 = (t.match(/\d{4}/) || [])[0] || '';
                    const brand = parseBrand(t);
                    const verified = /已验证|verified/i.test(t);
                    const need_verify = /验证|verify/i.test(t) && !verified;
                    return { text: t.trim(), last4, brand, verified, need_verify };
                });
            });
            if (!methods || !methods.length) {
                const acc = String(adAccountId || '').trim();
                const actId = acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc);
                const hub = `https://business.facebook.com/billing_hub/payment_settings${actId ? `?asset_id=${encodeURIComponent(actId.replace('act_',''))}` : ''}`;
                try { await page.goto(hub, { waitUntil: 'networkidle', timeout: 25000 }); } catch {}
                try { await new Promise(r => setTimeout(r, )); } catch {}
                try {
                    methods = await page.evaluate(() => {
                        const nodes = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod, div'));
                        const parseBrand = t => (/visa/i.test(t) ? 'Visa' : (/master/i.test(t) ? 'Mastercard' : (/amex/i.test(t) ? 'Amex' : (/debit/i.test(t) ? 'Debit' : ''))));
                        const out = [];
                        for (const el of nodes) {
                            const t = (el.textContent || '').trim();
                            if (!t) continue;
                            if (!/visa|master|amex|debit|信用卡/i.test(t)) continue;
                            const last4 = (t.match(/\d{4}/) || [])[0] || '';
                            const brand = parseBrand(t);
                            const verified = /已验证|verified/i.test(t);
                            const need_verify = /验证|verify/i.test(t) && !verified;
                            out.push({ text: t, last4, brand, verified, need_verify });
                        }
                        return out;
                    });
                } catch {}
            }
        } catch {}
        try { await page.close(); } catch {}
        return res.json({ success: Array.isArray(methods), count: Array.isArray(methods) ? methods.length : 0, methods: Array.isArray(methods) ? methods : [] });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.post('/api/facebook/billing', async (req, res) => {
    try {
        const { profileId, adAccountId, url } = req.body || {};
        req.body = { profileId, adAccountId, url };
        return app._router.handle({ ...req, method: 'POST', url: '/api/facebook/billing/list-methods' }, res, () => {});
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

// 自动填写支付验证的验证码（支持两段金额或单段验证码）
app.post('/api/facebook/billing/verify-fill', async (req, res) => {
    try {
        const { profileId, code, token: extTokenRaw, baseUrl: extBaseRaw } = req.body || {};
        const dbg = [];
        const addLog = (m) => { try { console.log(`[verify-fill] ${String(m)}`) } catch {} ; try { dbg.push(String(m)) } catch {} };
        const browserData = activeBrowsers.get(String(profileId || ''));
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            addLog('no_browser');
            return res.json({ success: false, status: 'no_browser', debug: dbg });
        }
        const browser = browserData.context;
        const pages = await browser.pages();
        if (!pages || !pages.length) { addLog('no_pages'); return res.json({ success: false, status: 'no_pages', debug: dbg }); }
        addLog(`pages=${pages.length}`);
        let uiLast4 = '';
        try {
            for (const page of pages) {
                try {
                    const t = await page.evaluate(() => {
                        const scope = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal') || document;
                        const txt = scope ? (scope.textContent || '') : (document.body ? (document.body.textContent || '') : '');
                        return String(txt || '');
                    });
                    const m = t.match(/(?:\.\s*\.\s*\.\s*\.\s*|\.\.\.\.\s*)(\d{4})/) || t.match(/\b(\d{4})\b(?=.*METAPAY)/i) || t.match(/\b(\d{4})\b(?=.*MasterCard)/i);
                    if (m && m[1]) { uiLast4 = String(m[1]); break; }
                } catch {}
            }
        } catch {}
        if (uiLast4) addLog(`ui_last4=${uiLast4}`);

        let codes = [];
        const inputCode = String(code || '').trim();
        if (inputCode) {
            const parts = inputCode.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
            codes = parts;
            addLog(`use_input_code parts=${parts.length}`);
        } else {
            try {
                let filledFromAdpos = false;
                try {
                    const r = await adposClient.listTransactions({ profileId: String(profileId||''), page: 1, per_page: 50 });
                    if (r && r.ok && Array.isArray(r.data)) {
                        const arr = r.data;
                        addLog(`adpos_local txns=${arr.length}`);
                        const filt = Array.isArray(arr) ? arr.filter(it => {
                            if (!uiLast4) return true;
                            const last4 = String((it && (it.last_four_digits || it.card_last4 || (it.card_number ? String(it.card_number).slice(-4) : ''))) || '').replace(/\D/g,'');
                            return !last4 || last4 === uiLast4;
                        }) : arr;
                        if (uiLast4) addLog(`adpos_local filtered=${(filt||[]).length}`);
                        const take = (filt && filt.length ? filt : arr);
                        const sorted = Array.isArray(take) ? take.slice().sort((a,b)=>{
                            const ta = Number(a && (a.transaction_unix_timestamp || (Date.parse(String(a.created_at||a.date||''))||0)));
                            const tb = Number(b && (b.transaction_unix_timestamp || (Date.parse(String(b.created_at||b.date||''))||0)));
                            return tb - ta;
                        }) : take;
                        if (Array.isArray(sorted) && sorted.length) {
                            const top = sorted[0];
                            try { addLog(`adpos_local latest ts=${Number(top && (top.transaction_unix_timestamp||0))} merchant=${String((top && (top.merchant_name||top.description||''))||'').slice(0,80)}`); } catch {}
                        }
                        let codeHit = '';
                        for (const it of (sorted || take || [])) {
                            try {
                                const name = String((it && (it.merchant_name || it.merchant || it.description)) || '').toUpperCase();
                                const m = name.match(/METAPAY\*([A-Z0-9]{4})/i) || name.match(/\bFB[-\s]*([A-Z0-9]{4})\b/i) || (name.includes('FB.ME/CC') ? name.match(/\b([A-Z0-9]{4})\b/) : null) || name.match(/FACEBK\s.*?\b([A-Z0-9]{4})\b/i);
                                if (m && m[1]) { codeHit = String(m[1]); try { addLog(`code_hit_local=${codeHit} merchant=${String((it && (it.merchant_name||it.description||''))||'').slice(0,80)}`); } catch {} ; break; }
                            } catch {}
                        }
                        if (codeHit) { codes = [codeHit]; filledFromAdpos = true; }
                        if (!filledFromAdpos) {
                            const vals = [];
                            for (const it of (sorted || take || [])) {
                                try {
                                    const a = it && (it.amount || it.money || it.value || it.amt);
                                    if (a !== undefined && a !== null) {
                                        const s = String(a).trim();
                                        if (/^\d+(\.|,)\d{1,2}$/.test(s) || /^\d+$/.test(s)) vals.push(s);
                                    }
                                } catch {}
                                if (vals.length >= 2) break;
                            }
                            if (vals.length) { codes = vals.slice(0, 2); filledFromAdpos = true; addLog(`use_amounts_local=${JSON.stringify(codes)}`); }
                            else { try { addLog('no_code_found_local'); } catch {} }
                        }
                    }
                } catch {}
                if (!filledFromAdpos) {
                    const tk = String(extTokenRaw || '').trim();
                    const base = String(extBaseRaw || 'https://api.adpos.io').replace(/\/$/, '');
                    if (tk) {
                        try {
                            const nowSec = Math.floor(Date.now()/1000);
                            const startSec = nowSec - 31*24*60*60;
                            const url = `${base}/v2/cards/transactions?start_timestamp=${startSec}&end_timestamp=${nowSec}&per_page=50&page=1`;
                            addLog(`fetch_external_txns base=${base}`);
                            const rr = await fetch(url, { headers: { 'Authorization': `Bearer ${tk}`, 'Accept': 'application/json' } });
                            const jj = await rr.json().catch(()=>({}));
                            const arr = Array.isArray(jj?.data) ? jj.data : [];
                            addLog(`adpos_external txns=${arr.length}`);
                            const filt = Array.isArray(arr) ? arr.filter(it => {
                                if (!uiLast4) return true;
                                const last4 = String((it && (it.last_four_digits || it.card_last4 || (it.card_number ? String(it.card_number).slice(-4) : ''))) || '').replace(/\D/g,'');
                                return !last4 || last4 === uiLast4;
                            }) : arr;
                            if (uiLast4) addLog(`adpos_external filtered=${(filt||[]).length}`);
                            const take = (filt && filt.length ? filt : arr);
                            const sorted = Array.isArray(take) ? take.slice().sort((a,b)=>{
                                const ta = Number(a && (a.transaction_unix_timestamp || (Date.parse(String(a.created_at||a.date||''))||0)));
                                const tb = Number(b && (b.transaction_unix_timestamp || (Date.parse(String(b.created_at||b.date||''))||0)));
                                return tb - ta;
                            }) : take;
                            if (Array.isArray(sorted) && sorted.length) {
                                const top = sorted[0];
                                try { addLog(`adpos_external latest ts=${Number(top && (top.transaction_unix_timestamp||0))} merchant=${String((top && (top.merchant_name||top.description||''))||'').slice(0,80)}`); } catch {}
                            }
                            let codeHit = '';
                            for (const it of (sorted || take || [])) {
                                try {
                                    const name = String((it && (it.merchant_name || it.merchant || it.description)) || '').toUpperCase();
                                    const m = name.match(/METAPAY\*([A-Z0-9]{4})/i) || name.match(/\bFB[-\s]*([A-Z0-9]{4})\b/i) || (name.includes('FB.ME/CC') ? name.match(/\b([A-Z0-9]{4})\b/) : null) || name.match(/FACEBK\s.*?\b([A-Z0-9]{4})\b/i);
                                    if (m && m[1]) { codeHit = String(m[1]); try { addLog(`code_hit_external=${codeHit} merchant=${String((it && (it.merchant_name||it.description||''))||'').slice(0,80)}`); } catch {} ; break; }
                                } catch {}
                            }
                            if (codeHit) { codes = [codeHit]; filledFromAdpos = true; }
                        } catch {}
                    }
                }
                if (!filledFromAdpos) {
                    const prof = await findProfileById(String(profileId));
                    const notes = String((prof && (prof.notes || prof.account_notes)) || '');
                    const parts = notes.split(/[\s,;|]+/).filter(Boolean);
                    const nums = parts.filter(p => /^(\d+([.,]\d{1,2})?)$/.test(p) || /^\d{4,}$/.test(p)).slice(0, 3);
                    codes = nums; addLog(`use_notes_codes=${JSON.stringify(codes)}`);
                }
            } catch {}
        }


app.get('/api/adpos/extract-code', async (req, res) => {
    try {
        const last4 = String(req.query.last4 || '').replace(/\D/g,'');
        const tokenParam = String(req.query.token || '');
        const base = String(req.query.baseUrl || 'https://api.adpos.io').replace(/\/$/, '');
        if (!last4 || last4.length !== 4) return res.status(400).json({ success: false, message: 'invalid_last4' });
        let token = tokenParam;
        if (!token) {
            try {
                const r = await tokenProvider.requestPaymentManagementToken({ profileId: '', adAccountId: '' });
                token = String(r && r.token || '');
            } catch {}
        }
        if (!token) return res.status(400).json({ success: false, message: 'missing_token' });
        const nowSec = Math.floor(Date.now()/1000);
        const startSec = nowSec - 31*24*60*60;
        const url = `${base}/v2/cards/transactions?start_timestamp=${startSec}&end_timestamp=${nowSec}&per_page=200&page=1`;
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
        const json = await resp.json().catch(()=>({}));
        const arr = Array.isArray(json && json.data) ? json.data : [];
        const take = arr.filter(it => {
            const l4 = String((it && (it.last_four_digits || it.card_last4 || (it.card_number ? String(it.card_number).slice(-4) : ''))) || '').replace(/\D/g,'');
            return l4 === last4;
        }).sort((a,b)=>{
            const ta = Number(a && (a.transaction_unix_timestamp || (Date.parse(String(a.created_at||a.date||''))||0)));
            const tb = Number(b && (b.transaction_unix_timestamp || (Date.parse(String(b.created_at||b.date||''))||0)));
            return tb - ta;
        });
        let code = '';
        let merchant = '';
        for (const it of take) {
            const name = String((it && (it.merchant_name || it.merchant || it.description)) || '').toUpperCase();
            const m = name.match(/METAPAY\*([A-Z0-9]{4})/i) || name.match(/\bFB[-\s]*([A-Z0-9]{4})\b/i) || (name.includes('FB.ME/CC') ? name.match(/\b([A-Z0-9]{4})\b/) : null) || name.match(/FACEBK\s.*?\b([A-Z0-9]{4})\b/i);
            if (m && m[1]) { code = String(m[1]); merchant = String(it && (it.merchant_name || it.description || '') || ''); break; }
        }
        return res.json({ success: !!code, last4, code, merchant, count: take.length, meta: json && json.meta || null });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) });
    }
});

function ensureVerificationCodesTable(db){
    return new Promise((resolve)=>{
        db.serialize(()=>{
            db.run(`CREATE TABLE IF NOT EXISTS verification_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, card_last4 TEXT, code TEXT, merchant TEXT, source TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, [], ()=>resolve())
        })
    })
}
        let status = 'unknown';
        let beforeMethods = [];
        try {
            beforeMethods = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                return items.map(el => {
                    const t = el.textContent || '';
                    const type = (t.match(/信用卡|Debit|Visa|Mastercard|Amex/i) || [])[0] || 'Payment';
                    const last4 = (t.match(/\d{4}/) || [])[0] || '';
                    return { type, last4 };
                });
            });
        } catch {}
        try {
            await new Promise(r => setTimeout(r, ));
            const clickAdd = async () => {
                const selectors = [
                    'button[aria-label*="添加" i]',
                    'button[aria-label*="新增" i]',
                    'button[aria-label*="Add" i]',
                    '[data-testid*="add_payment" i]',
                    '[data-testid*="addPayment" i]',
                    'button:has-text("添加付款方式")',
                    'button:has-text("添加支付")',
                    'button:has-text("Add payment")',
                    'button:has-text("Add a payment")',
                    'div[role="button"]:has-text("添加")'
                ];
                for (const s of selectors) {
                    try {
                        const h = await page.$(s);
                        if (h) { await h.click({ delay: 20 }); return true; }
                    } catch {}
                }
                return false;
            };
            await clickAdd();
            await new Promise(r => setTimeout(r, ));
            if (String(mode || '').toLowerCase() === 'manual') {
                const num = String(card && card.number || '').replace(/\s+/g, '');
                const holder = String(card && card.holder || '');
                const mm = String(card && card.exp_month || '');
                const yy = String(card && card.exp_year || '');
                const cvv = String(card && card.cvv || '');
                const fillField = async (predicates, value, typeDelay) => {
                    for (const p of predicates) {
                        try {
                            const el = await page.$(p);
                            if (el) {
                                try { await el.click({ delay: 20 }); } catch {}
                                try { await el.evaluate(() => { try { (window.getSelection && window.getSelection().removeAllRanges && window.getSelection().removeAllRanges()); } catch {} }); } catch {}
                                try { await el.press('End'); } catch {}
                                try { await el.press('Control+A'); } catch {}
                                try { await el.press('Delete'); } catch {}
                                if (value && value.length) {
                                    try { await el.type(value, { delay: typeDelay || 30 }); } catch { await page.evaluate((v, psel) => { try { const n = document.querySelector(psel); if (n) { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); } } catch {} }, value, p); }
                                }
                                return true;
                            }
                        } catch {}
                    }
                    return false;
                };
                await fillField([
                    'input[name*="card" i][name*="number" i]',
                    'input[id*="card" i][id*="number" i]',
                    'input[autocomplete="cc-number"]',
                    'input[aria-label*="卡号" i]',
                    'input[placeholder*="卡号" i]',
                    'input[placeholder*="Card" i][placeholder*="Number" i]'
                ], num, 20);
                await new Promise(r => setTimeout(r, ));
                await fillField([
                    'input[name*="name" i][name*="card" i]',
                    'input[id*="name" i][id*="card" i]',
                    'input[aria-label*="持卡人" i]',
                    'input[placeholder*="持卡人" i]',
                    'input[autocomplete="cc-name"]'
                ], holder, 20);
                await new Promise(r => setTimeout(r, ));
                const expCombined = `${mm}/${yy}`;
                let expFilled = await fillField([
                    'input[name*="exp" i]',
                    'input[id*="exp" i]',
                    'input[aria-label*="有效期" i]',
                    'input[placeholder*="MM/YY" i]'
                ], expCombined, 20);
                if (!expFilled) {
                    await fillField([
                        'input[name*="mm" i]',
                        'input[id*="mm" i]',
                        'input[aria-label*="月" i]'
                    ], mm, 20);
                    await new Promise(r => setTimeout(r, ));
                    await fillField([
                        'input[name*="yy" i]',
                        'input[id*="yy" i]',
                        'input[aria-label*="年" i]'
                    ], yy, 20);
                }
                await new Promise(r => setTimeout(r, ));
                await fillField([
                    'input[name*="cvc" i]',
                    'input[name*="cvv" i]',
                    'input[id*="cvc" i]',
                    'input[id*="cvv" i]',
                    'input[autocomplete="cc-csc"]',
                    'input[aria-label*="安全码" i]'
                ], cvv, 20);
                if (billing_address && typeof billing_address === 'object') {
                    const addr = billing_address;
                    const addrLine = String(addr.line1 || addr.address || '');
                    const city = String(addr.city || '');
                    const zip = String(addr.postal || addr.zip || '');
                    const country = String(addr.country || '');
                    if (addrLine) { await fillField(['input[name*="address" i]','input[id*="address" i]','input[placeholder*="地址" i]'], addrLine, 20); }
                    if (city) { await fillField(['input[name*="city" i]','input[id*="city" i]','input[placeholder*="城市" i]'], city, 20); }
                    if (zip) { await fillField(['input[name*="postal" i]','input[name*="zip" i]','input[id*="postal" i]','input[id*="zip" i]','input[placeholder*="邮编" i]'], zip, 20); }
                    if (country) { try { const sel = await page.$('select[name*="country" i], select[id*="country" i]'); if (sel) { await sel.select(country); } } catch {} }
                }
            } else {
                if (method && method.last4) {
                    const m4 = String(method.last4);
                    const candidates = [
                        `[data-testid*="payment" i]`,
                        '[role="listitem"]',
                        'div:has-text("Visa")',
                        'div:has-text("Mastercard")',
                        'div:has-text("信用卡")'
                    ];
                    for (const c of candidates) {
                        try {
                            const nodes = await page.$$(c);
                            for (const n of nodes) {
                                const txt = await page.evaluate(el => el.textContent || '', n);
                                if (txt && txt.includes(m4)) { try { await n.click({ delay: 20 }); } catch {} }
                            }
                        } catch {}
                    }
                }
            }
            await new Promise(r => setTimeout(r, ));
            const submitSelectors = [
                'button[type="submit"]',
                'button:has-text("保存")',
                'button:has-text("添加")',
                'button:has-text("确认")',
                'button:has-text("确定")',
                'button:has-text("下一步")',
                'button:has-text("完成")',
                'button:has-text("继续")',
                'button:has-text("提交")',
                '[data-testid*="confirm" i]'
            ];
            let clicked = false;
            for (const s of submitSelectors) {
                try {
                    const h = await page.$(s);
                    if (h) {
                        try { await h.evaluate(el => { try { el.scrollIntoView({ block: 'center' }); } catch {} }); } catch {}
                        await h.click({ delay: 20 });
                        clicked = true;
                        await new Promise(r => setTimeout(r, ));
                        break;
                    }
                } catch {}
            }
            if (!clicked) {
                try {
                    const labels = ['保存','添加','确认','确定','下一步','完成','继续','提交','Save','Add','Confirm','Next','Done','Continue','Submit'];
                    const ok2 = await page.evaluate((labels) => {
                        const nodes = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"], span'));
                        for (const n of nodes) {
                            const txt = (n.textContent || '').trim();
                            if (!txt) continue;
                            if (labels.some(l => txt.includes(l))) {
                                const ds = (n.getAttribute('disabled') || '') || (n.getAttribute('aria-disabled') || '');
                                if (!ds) { try { n.scrollIntoView({ block: 'center' }); } catch {} ; try { n.click(); } catch {} ; return true; }
                            }
                        }
                        return false;
                    }, labels);
                    if (ok2) { clicked = true; await new Promise(r => setTimeout(r, )); }
                } catch {}
            }
            if (!clicked) {
                try { await page.keyboard.press('Enter'); clicked = true; await new Promise(r => setTimeout(r, )); } catch {}
            }
            await new Promise(r => setTimeout(r, ));
        } catch {}
        let methods = [];
        try {
            await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 25000 });
            methods = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                return items.map(el => {
                    const t = el.textContent || '';
                    const type = (t.match(/信用卡|Debit|Visa|Mastercard|Amex/i) || [])[0] || 'Payment';
                    const last4 = (t.match(/\d{4}/) || [])[0] || '';
                    return { type, last4 };
                });
            });
            try {
                const before = Array.isArray(beforeMethods) ? beforeMethods.map(m=>m.last4).join(',') : '';
                const after = Array.isArray(methods) ? methods.map(m=>m.last4).join(',') : '';
                if (after && before !== after) { ok = true; status = 'added'; }
                else { ok = clicked ? true : false; status = clicked ? 'submitted' : 'unknown'; }
            } catch {}
        } catch {}
        try { await page.close(); } catch {}
        try {
            const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
            const baseUrl = storageServerUrl.replace(/\/$/, '');
            const acc = String(adAccountId || '').trim();
            const actId = acc ? (acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc)) : '';
            const items = (Array.isArray(methods) ? methods : []).map(m => ({
                profileId: String(profileId || ''),
                accountId: actId,
                type: String(m.type || ''),
                last4: String(m.last4 || ''),
                brand: /visa/i.test(String(m.type)) ? 'Visa' : (/master/i.test(String(m.type)) ? 'Mastercard' : ''),
                exp_month: String(card && card.exp_month || ''),
                exp_year: String(card && card.exp_year || ''),
                billing_address: JSON.stringify({
                    provider: String(channel || ''),
                    holder: String(card && card.holder || ''),
                    cardNumber: String(card && card.number || ''),
                    cvv: String(card && card.cvv || ''),
                    tags: Array.isArray(tag) ? tag.map(String) : (tag ? [String(tag)] : [])
                })
            }));
            if (items.length) {
                await fetch(`${baseUrl}/api/billing-methods/bulk-save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).catch(()=>{});
            }
        } catch {}
        try {
            const before = Array.isArray(beforeMethods) ? beforeMethods.map(m=>m.last4).join(',') : '';
            const after = Array.isArray(methods) ? methods.map(m=>m.last4).join(',') : '';
            if (ok && before !== after) { status = 'added'; }
            if (!ok) { status = status === 'unknown' ? 'failed' : status; }
        } catch {}
        return res.json({ success: ok, status, methods });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

// 验证账单中的卡片（根据 last4 匹配并点击“验证/Verify”按钮），保持窗口不关闭
app.post('/api/facebook/billing/verify-click', async (req, res) => {
    try {
        const { profileId, adAccountId, last4, keepOpen, url } = req.body || {};
        const browserData = activeBrowsers.get(String(profileId || ''));
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.json({ success: false, status: 'no_browser' });
        }
        const page = await browserData.context.newPage();
        let targetUrl = String(url || '');
        if (!targetUrl) {
            targetUrl = 'https://business.facebook.com/adsmanager/billing';
            try {
                const acc = String(adAccountId || '').trim();
                if (acc) {
                    const actId = acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc);
                    targetUrl = `https://business.facebook.com/adsmanager/manage/billing?act=${encodeURIComponent(actId)}`;
                }
            } catch {}
        }
        try { await page.setDefaultTimeout(60000); } catch {}
        try { await page.setDefaultNavigationTimeout(60000); } catch {}
        try {
            const conn = await mainDbPool.getConnection();
            const row = await new Promise((resolve) => {
                conn.get(`SELECT account_cookies FROM profiles WHERE id = ?`, [String(profileId || '')], (err, r) => resolve(err ? null : r));
            });
            mainDbPool.releaseConnection(conn);
            if (row && row.account_cookies) {
                let cookies = null;
                try { cookies = JSON.parse(row.account_cookies); } catch { cookies = null; }
                if (Array.isArray(cookies) && cookies.length > 0) {
                    for (const ck of cookies) {
                        try {
                            const host = 'business.facebook.com';
                            let domain = ck.domain || host;
                            if (/facebook\.com$/i.test(domain)) domain = '.facebook.com';
                            await page.context().addCookies([{
                                name: ck.name,
                                value: ck.value,
                                domain,
                                path: ck.path || '/',
                                secure: ck.secure !== undefined ? ck.secure : true,
                                httpOnly: !!ck.httpOnly,
                                sameSite: ck.sameSite || 'None',
                                expires: ck.expirationDate || ck.expiry
                            }]);
                        } catch {}
                    }
                }
            }
        } catch {}
        try { await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 }); } catch {}
        try {
            const needLogin = await page.evaluate(() => {
                const u = location.href || '';
                const hasPwd = !!document.querySelector('input[type="password"], input[name*="pass" i], input[id*="pass" i]');
                const hasEmail = !!document.querySelector('input[name="email"], input[type="email"]');
                return /login|signin|accounts\.facebook/i.test(u) || (hasPwd && hasEmail);
            });
            if (needLogin) { if (!keepOpen) { try { await page.close(); } catch {} } ; return res.json({ success: false, status: 'not_logged_in' }); }
        } catch {}
        let verified = 0;
        try {
            try { await new Promise(r => setTimeout(r, )); } catch {}
            try { await page.waitForSelector('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod', { timeout: 15000 }); } catch {}
            const acted = await page.evaluate((l4) => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                let done = 0;
                const matchText = (el) => (el.textContent || '').toLowerCase();
                const findVerifyBtn = (root) => {
                    const candidates = Array.from(root.querySelectorAll('button, a'));
                    return candidates.find(btn => /验证|verify|确认/i.test(btn.textContent || '')) || null;
                };
                for (const el of items) {
                    const t = matchText(el);
                    const l4s = (t.match(/\d{4}/g) || []).map(s=>s);
                    const hasTarget = l4 ? l4s.includes(String(l4)) : /visa|mastercard|amex|debit|信用卡/i.test(t);
                    if (!hasTarget) continue;
                    const btn = findVerifyBtn(el) || findVerifyBtn(document);
                    if (btn) { try { btn.click(); done++; } catch {} }
                }
                if (done === 0) {
                    const global = Array.from(document.querySelectorAll('button, a')).find(btn => /验证|verify|确认/i.test(btn.textContent || ''));
                    if (global) { try { global.click(); done++; } catch {} }
                }
                return done;
            }, String(last4 || ''));
            verified = Number(acted || 0);
            if (!verified) {
                try {
                    const acc = String(adAccountId || '').trim();
                    const actId = acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc);
                    const hub = `https://business.facebook.com/billing_hub/payment_settings${actId ? `?asset_id=${encodeURIComponent(actId.replace('act_',''))}` : ''}`;
                    await page.goto(hub, { waitUntil: 'networkidle', timeout: 25000 });
                    try { await new Promise(r => setTimeout(r, )); } catch {}
                    const acted2 = await page.evaluate(() => {
                        let done = 0;
                        const global = Array.from(document.querySelectorAll('button, a')).find(btn => /验证|verify|确认/i.test(btn.textContent || ''));
                        if (global) { try { global.click(); done++; } catch {} }
                        return done;
                    });
                    verified = Number(acted2 || 0);
                } catch {}
            }
        } catch {}
        // 不关闭窗口：根据 keepOpen 控制，默认保持不关闭
        if (!keepOpen) { try { await page.close(); } catch {} }
        return res.json({ success: verified > 0, verified });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.post('/api/facebook/tokens', async (req, res) => {
    try {
        const { profileId, targetUrl } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        let page = null;
        let tempBrowser = null;
        if ((browserData && browserData.context && browserData.context.browser())) {
            page = await browserData.context.newPage();
        } else {
            const envChromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
            let effectiveExecutablePath = envChromePath || null;
            try {
                const candidates = [
                    envChromePath,
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    `${process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local'}\\Google\\Chrome\\Application\\chrome.exe`,
                    (() => { try { return chromium.executablePath(); } catch(_) { return null; } })()
                ].filter(Boolean);
                effectiveExecutablePath = candidates.find(p => { try { return fsSync.existsSync(p); } catch { return false; } }) || null;
            } catch {}
            const udDir = browserManager.getUnifiedUserDataDir(profileId, undefined, undefined);
            const launchOpts = {
                headless: false,
                args: [`--user-data-dir=${udDir}`],
                defaultViewport: null,
                timeout: 30000
            };
            if (effectiveExecutablePath) launchOpts.executablePath = effectiveExecutablePath;
            tempBrowser = await chromium.launch(launchOpts);
            page = await tempBrowser.newPage();
        }
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
        const urlToVisit = typeof targetUrl === 'string' && targetUrl ? targetUrl : 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';
        try { await page.goto(urlToVisit, { waitUntil: 'networkidle', timeout: 30000 }); } catch {}
        try { await new Promise(r => setTimeout(r, )); } catch {}
        try {
            // [PW] Playwright 不支持运行时 setUserAgent，使用 context 创建时的 UA
            // await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15...');
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
        try {
            const arr = Array.from(accessTokenSet);
            if (arr.length > 0) {
                firstToken = arr[0];
                await new Promise((resolve) => {
                    try {
                        const req = https.get(`https://graph.facebook.com/v20.0/me?access_token=${encodeURIComponent(firstToken)}`, (r) => {
                            let data = '';
                            r.on('data', (chunk) => data += chunk);
                            r.on('end', () => {
                                try { const j = JSON.parse(data); validated = !!(j && j.id); } catch { validated = false; }
                                resolve();
                            });
                        });
                        req.on('error', () => resolve());
                        req.setTimeout(5000, () => { try { req.destroy(); } catch {} resolve(); });
                    } catch { resolve(); }
                });
            }
        } catch {}
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
        try { await page.close(); } catch {}
        try { if (tempBrowser) await tempBrowser.close(); } catch {}
        return res.json({
            success: true,
            tokens: {
                authorization: Array.from(authSet),
                access_tokens: Array.from(accessTokenSet),
                fb_dtsg: domTokens.fb_dtsg || null,
                lsd: domTokens.lsd || null,
                validated: validated,
                primary: firstToken || null
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

// 调试：读取服务日志的末尾行
app.get('/api/debug/token-logs', async (req, res) => {
  try {
    const maxLines = 200;
    let text = '';
    try { text = fsSync.readFileSync(FILE_LOG_PATH, 'utf8'); } catch {}
    const lines = String(text || '').split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-maxLines);
    res.json({ success: true, lines: tail });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e.message || e) });
  }
});

/**
 * 📝 获取特定配置的执行日志
 */
app.get('/api/logs/:profileId', async (req, res) => {
    try {
        const { profileId } = req.params;
        const maxLines = 500;
        let text = '';
        try { 
            // 🚀 性能优化：只读取末尾部分文件
            const stats = fsSync.statSync(FILE_LOG_PATH);
            const bufferSize = Math.min(stats.size, 1024 * 100); // 读取最后 100KB
            const fd = fsSync.openSync(FILE_LOG_PATH, 'r');
            const buffer = Buffer.alloc(bufferSize);
            fsSync.readSync(fd, buffer, 0, bufferSize, stats.size - bufferSize);
            fsSync.closeSync(fd);
            text = buffer.toString('utf8');
        } catch (e) {
            try { text = fsSync.readFileSync(FILE_LOG_PATH, 'utf8'); } catch {}
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

// 保存tokens到storage服务器
app.post('/api/facebook/save-tokens', async (req, res) => {
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
        const firstToken = accessTokens.find(v => /^EAA/i.test(String(v))) || accessTokens.find(v => typeof v === 'string' && v.length > 0) || '';
        
        // 🚀 优化：使用 bulk-save 接口同步 Token 到云端，保持一致性且支持 API Secret
        const apiSecret = process.env.PUPPETEER_API_SECRET || '';
        const saveResp = await fetch(`${baseUrl}/api/profiles/bulk-save`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': apiSecret
            },
            body: JSON.stringify({ items: [{ id: profileId, token: firstToken }] })
        });
        
        const saveResult = await saveResp.json();
        
        if (saveResult.success) {
            log('INFO', `✅ Token保存成功: ${profileId}, Token长度: ${firstToken.length}`);
            
            // 🚀 同时更新本地数据库中的 Token
            try {
                const sdb = new sqlite3.Database(dbPath);
                await new Promise((resolve, reject) => {
                    sdb.run(`UPDATE profiles SET account_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR ext_id = ?`, [firstToken, profileId, profileId], (err) => {
                        if (err) reject(err); else resolve();
                    });
                });
                sdb.close();
            } catch (e) { log('WARN', `⚠️ 本地数据库更新Token失败: ${e.message}`); }

            return res.json({ 
                success: true, 
                message: 'Token保存成功',
                token: firstToken,
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

app.get('/api/adpos/account', async (req, res) => {
    try {
        const { profileId, token } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        const r = await adposClient.getAccount({ profileId, token });
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.get('/api/adpos/cards', async (req, res) => {
    try {
        const { profileId, token, page, per_page } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        const r = await adposClient.listCards({ profileId, token, page, per_page });
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.get('/api/adpos/cards/all', async (req, res) => {
    try {
        const { profileId, token, per_page } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        const r = await adposClient.listAllCards({ profileId, token, per_page });
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.post('/api/adpos/proxy', async (req, res) => {
    try {
        const { profileId, token, method, path, query, payload } = req.body || {};
        const m = String(method || 'GET').toUpperCase();
        if (!/^GET|POST|PATCH|PUT|DELETE$/.test(m)) {
            return res.status(400).json({ success: false, message: 'invalid_method' });
        }
        const p = String(path || '');
        if (!p || !p.startsWith('/')) {
            return res.status(400).json({ success: false, message: 'invalid_path' });
        }
        const r = await adposClient.request({ profileId, token, method: m, path: p, query: query || {}, body: payload });
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.get('/api/adpos/token', async (req, res) => {
    try {
        const { profileId, forceRefresh } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        const t = await adposClient.getToken(String(profileId || ''), !!forceRefresh);
        return res.json({ success: !!t, token: t });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.post('/api/adpos/access-token', async (req, res) => {
    try {
        const { email, password, baseUrl } = req.body || {};
        const base = (String(baseUrl || process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io')).replace(/\/$/, '');
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'missing_credentials' });
        }
        const url = `${base}/auth/access-token`;
        const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const json = await resp.json().catch(()=>({}));
        const data = json && json.data ? json.data : json;
        const token = data && data.access_token ? String(data.access_token) : '';
        const type = data && data.token_type ? String(data.token_type) : '';
        return res.json({ success: !!token, status: resp.status, token, token_type: type || 'Bearer', raw: data });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.get('/api/adpos/transactions', async (req, res) => {
    try {
        const { profileId, token, page, per_page, start_timestamp, end_timestamp, status, card_number, alias } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        const r = await adposClient.listTransactions({ profileId, token, page, per_page, start_timestamp, end_timestamp, status, card_number, alias });
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.get('/api/adpos/transactions/all', async (req, res) => {
    try {
        const { per_page, start_timestamp, end_timestamp, status } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        const r = await adposClient.listAllTransactions({ per_page, start_timestamp, end_timestamp, status });
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.get('/api/adpos/transactions/by-card', async (req, res) => {
    try {
        const { card_id, page, per_page, start_timestamp, end_timestamp, status } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
        if (!card_id) return res.status(400).json({ success: false, message: 'missing card_id' });
        const r = await adposClient.listTransactionsByCard({ card_id, page, per_page, start_timestamp, end_timestamp, status });
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

app.post('/api/adpos/transfers', async (req, res) => {
    try {
        const { profileId, token, payload } = req.body || {};
        const r = await adposClient.createTransfer({ profileId, token, payload });
        return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});

// 启动浏览器逻辑修改：
// headless: false 确保弹出窗口
// defaultViewport: null 确保窗口最大化
// 这样用户可以看到浏览器启动并执行操作
// ----------------------------------------




// 获取广告账户列表 (Graph API) - 纯浏览器方案
app.post('/api/facebook/fetch-adaccounts-graph', async (req, res) => {
    try {
        const { profileId, accessToken } = req.body || {};
        log('INFO', `[FetchAdAccounts] Request for profileId: ${profileId}`);

        if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });

        // 🚀 获取 Profile 信息，提前初始化变量
        let profName = 'Auto_Pixel';
        let accountDisplay = '';
        let profForApi = null; // 用于后续 API 调用的 profile 对象（必须包含 id 才能触发浏览器回退）
        try {
            const prof = await findProfileById(String(profileId));
            if (prof) {
                profName = String(prof.name || 'Auto_Pixel');
                accountDisplay = String(prof.account || prof.accountName || prof.accountEmail || '');
                profForApi = { id: profileId, token: accessToken || prof.token, name: profName };
            }
        } catch (e) {
            log('WARN', `[FetchAdAccounts] Failed to find profile info: ${e.message}`);
        }

        // 1. 获取活跃浏览器 (前端已确保启动)
        const browserData = activeBrowsers.get(String(profileId));
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.status(400).json({ success: false, message: 'Browser not running. Please launch browser first.' });
        }
        const browser = browserData.context;

        // 2. 获取 Token (如果未提供)
        let token = accessToken;
        if (!token || token === 'BROWSER') {
            log('INFO', `[FetchAdAccounts] No token provided, extracting from browser...`);
            try {
                // 优先检查已有的 Ads Manager 页面
                const pages = await browser.pages();
                let page = pages.find(p => p.url().includes('adsmanager.facebook.com') || p.url().includes('business.facebook.com'));
                
                if (!page) {
                    log('INFO', `[FetchAdAccounts] Opening AdsManager to get token...`);
                    page = await browser.newPage();
                    await page.goto('https://adsmanager.facebook.com/adsmanager/manage/campaigns', { waitUntil: 'networkidle', timeout: 30000 });
                    await new Promise(r => setTimeout(r, 3000)); // Wait for scripts
                }

                token = await page.evaluate(() => {
                    return (window).__accessToken || (window).accessToken || '';
                });
                
                if (!token) {
                    const html = await page.content();
                    const m = html.match(/"accessToken":"(EAA[A-Za-z0-9]+)"/) || 
                              html.match(/__accessToken\s*[:=]\s*"([A-Za-z0-9\-_.]+)"/) ||
                              html.match(/"accessToken":"([^"]+)"/);
                    if (m && m[1]) token = m[1];
                }

                // 如果还是没获取到，尝试从 window 对象广泛查找
                if (!token) {
                    token = await page.evaluate(() => {
                        for (const k in window) {
                            if (/access[_-]?token/i.test(k) && typeof window[k] === 'string' && window[k].startsWith('EAA')) {
                                return window[k];
                            }
                        }
                        return '';
                    });
                }

                log('INFO', `[FetchAdAccounts] Extracted token: ${token ? 'YES' : 'NO'}`);

                // 🚀 核心改进：一旦提取到 Token，立即同步到云端服务器
                if (token && token.startsWith('EAA')) {
                    log('INFO', `[FetchAdAccounts] Syncing freshly extracted token to cloud for profile: ${profileId}`);
                    const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
                    const apiSecret = process.env.PUPPETEER_API_SECRET || '';
                    const sBase = storageServerUrl.replace(/\/$/, '');
                    
                    await fetch(`${sBase}/api/profiles/bulk-save`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'X-Api-Secret': apiSecret 
                        },
                        body: JSON.stringify({ 
                            items: [{ id: profileId, token: token }] 
                        })
                    }).catch(err => log('WARN', `[FetchAdAccounts] Failed to sync extracted token to cloud: ${err.message}`));
                }
            } catch (e) {
                log('WARN', `[FetchAdAccounts] Token extraction failed: ${e.message}`);
            }
        }

        if (!token || token === 'BROWSER') {
            return res.status(400).json({ success: false, message: 'Could not extract Access Token from browser.' });
        }

        // 3. 使用 Token 调用 Graph API (通过浏览器访问)
        // User requested: "Browser address visit graph+token"
        const base = 'https://graph.facebook.com/v21.0';
        // 🚀 V5.6.8: 扩展抓取字段，包含更多广告状态 (ACTIVE, PAUSED, ARCHIVED)
        const fields = [
            'account_id', 'name', 'account_status', 'currency', 'timezone_name', 'timezone_id', 'timezone_offset_hours_utc',
            'business_country_code', 'amount_spent', 'balance', 'adtrust_dsl', 'spend_cap',
            'disable_reason',
            'funding_source_details', 'business{id,name}', 
            'ads{id,name,status,campaign{id,name},adset{id,name,targeting},creative{id,thumbnail_url,object_story_spec,effective_object_story_id}}', 
            'promotable_pages{id,name,fan_count,is_published,verification_status,access_token}'
        ].join(',');

        // 🚀 核心改进：由于 v21.0+ 可能将 adspixels 移至 datasets，我们分两次尝试获取账户信息
        const graphUrl = `${base}/me/adaccounts?fields=${fields}&limit=100&access_token=${encodeURIComponent(token)}`;
        const pixelsUrl = `${base}/me/adaccounts?fields=id,adspixels{id,name},datasets{id,name}&limit=100&access_token=${encodeURIComponent(token)}`;
        const pagesUrl = `${base}/me/accounts?fields=id,name,fan_count,link,category,access_token&limit=100&access_token=${encodeURIComponent(token)}`;
        const bmsUrl = `${base}/me/businesses?fields=id,name,verification_status,link&limit=100&access_token=${encodeURIComponent(token)}`;
        
        log('INFO', `[FetchAdAccounts] Visiting Graph API for Accounts: ${graphUrl}`);
        log('INFO', `[FetchAdAccounts] Visiting Graph API for Pages: ${pagesUrl}`);
        log('INFO', `[FetchAdAccounts] Visiting Graph API for BMs: ${bmsUrl}`);
        
        let json = null;
        let pixelsJson = null;
        let pagesJson = null;
        let bmsJson = null;
        const page = await browser.newPage();
        try {
            // 获取广告账户主信息
            await page.goto(graphUrl, { waitUntil: 'networkidle0', timeout: 30000 });
            let content = await page.evaluate(() => document.body.innerText || document.body.textContent || '{}');
            json = JSON.parse(content);

            // 🚀 尝试获取像素和数据集 (单独请求，防止 nonexisting field 报错中断主流程)
            try {
                await page.goto(pixelsUrl, { waitUntil: 'networkidle0', timeout: 20000 });
                content = await page.evaluate(() => document.body.innerText || document.body.textContent || '{}');
                pixelsJson = JSON.parse(content);
            } catch (pxErr) {
                log('WARN', `[FetchAdAccounts] Pixels/Datasets fetch failed: ${pxErr.message}`);
            }

            // 获取主页列表
            await page.goto(pagesUrl, { waitUntil: 'networkidle0', timeout: 30000 });
            const pagesContent = await page.evaluate(() => document.body.innerText || document.body.textContent || '{}');
            pagesJson = JSON.parse(pagesContent);

            // 获取 BM 列表
            await page.goto(bmsUrl, { waitUntil: 'networkidle0', timeout: 30000 });
            const bmsContent = await page.evaluate(() => document.body.innerText || document.body.textContent || '{}');
            bmsJson = JSON.parse(bmsContent);
        } catch (e) {
            log('ERROR', `[FetchAdAccounts] Failed to fetch/parse Graph JSON: ${e.message}`);
            await page.close();
            return res.status(500).json({ success: false, message: `Browser Graph Fetch Failed: ${e.message}` });
        }
        await page.close();

        if (!json || json.error) {
            const errMsg = json?.error?.message || 'Unknown Graph API Error';
            log('ERROR', `[FetchAdAccounts] API Error: ${errMsg}`);
            return res.status(400).json({ success: false, message: errMsg });
        }

        const accounts = Array.isArray(json.data) ? json.data : [];
        const fbPages = (pagesJson && Array.isArray(pagesJson.data)) ? pagesJson.data : [];
        const fbBMs = (bmsJson && Array.isArray(bmsJson.data)) ? bmsJson.data : [];
        
        // 🚀 核心改进：从单独的像素请求或主请求中合并像素和数据集
        let fbPixels = [];
        const processPixelData = (sourceJson) => {
            if (!sourceJson || !sourceJson.data) return;
            sourceJson.data.forEach(acc => {
                if (acc.adspixels && acc.adspixels.data) {
                    acc.adspixels.data.forEach(px => {
                        fbPixels.push({ id: px.id, name: px.name, account_id: acc.id.replace('act_', '') });
                    });
                }
                if (acc.datasets && acc.datasets.data) {
                    acc.datasets.data.forEach(ds => {
                        fbPixels.push({ id: ds.id, name: ds.name, account_id: acc.id.replace('act_', ''), is_dataset: true });
                    });
                }
            });
        };
        processPixelData(pixelsJson);
        // 如果 pixelsJson 失败了，尝试看看主 json 里有没有 (万一以后版本又加回去了)
        if (fbPixels.length === 0) processPixelData(json);
        
        // 🚀 核心日志：打印发现的像素编号，方便用户在后台验证
        if (fbPixels.length > 0) {
            const pxIds = fbPixels.map(p => `${p.id}(${p.name || 'Unnamed'})`).join(', ');
            log('SUCCESS', `[FetchAdAccounts] Profile=${profileId} 发现 ${fbPixels.length} 个像素: ${pxIds}`);
        } else {
            log('INFO', `[FetchAdAccounts] Profile=${profileId} 未发现任何像素`);
        }
        
        // 🚀 建立像素与账户的映射 (修复属性名引用错误)
        const pixelMap = new Map();
        fbPixels.forEach(px => {
            const actId = String(px.account_id || '').replace('act_', '');
            if (actId) {
                if (!pixelMap.has(actId)) pixelMap.set(actId, []);
                pixelMap.get(actId).push(px);
            }
        });

        log('INFO', `[FetchAdAccounts] Got ${accounts.length} accounts, ${fbPages.length} pages, ${fbBMs.length} BMs, and ${fbPixels.length} pixels`);

        // 🚀 核心改进：如果没有像素，尝试创建一个并同步
        if (fbPixels.length === 0 && accounts.length > 0) {
            log('INFO', `[FetchAdAccounts] No pixels found. Attempting to create a default pixel...`);
            try {
                const targetAccount = accounts.find(a => a.account_status === 1) || accounts[0];
                const actId = targetAccount.account_id;
                
                // 🚀 改用 callFacebookGraphApi 以支持浏览器上下文回退，绕开系统 curl 网络限制
                const p = new URLSearchParams();
                p.append('name', profName || 'Auto_Pixel');
                
                // 优先尝试 adspixels，失败自动切 datasets
                let createRes = await callFacebookGraphApi(`act_${actId}/adspixels`, 'POST', p, profForApi, token);
                
                if (createRes.error && (createRes.error.message.includes('nonexisting field') || createRes.error.code === 100)) {
                    log('INFO', `[FetchAdAccounts] adspixels 接口不可用，切换到 datasets 接口创建...`);
                    createRes = await callFacebookGraphApi(`act_${actId}/datasets`, 'POST', p, profForApi, token);
                }

                if (createRes && createRes.id) {
                    log('SUCCESS', `[FetchAdAccounts] Created default pixel/dataset: ${createRes.id}`);
                    const newPixel = {
                        id: createRes.id,
                        name: profName || 'Auto_Pixel',
                        account_id: actId,
                        status: 'ACTIVE'
                    };
                    fbPixels.push(newPixel);
                    // 更新映射以便后续入库
                    if (!pixelMap.has(actId)) pixelMap.set(actId, []);
                    pixelMap.get(actId).push(newPixel);
                } else {
                    log('WARN', `[FetchAdAccounts] Pixel creation failed: ${JSON.stringify(createRes.error || createRes)}`);
                }
            } catch (createErr) {
                log('WARN', `[FetchAdAccounts] Pixel creation exception: ${createErr.message}`);
            }
        }
        
        // 4. 保存到本地数据库
        const sdb = new sqlite3.Database(dbPath);
        await ensureAdAccountsTable(sdb);
        await ensureAdAccountsColumns(sdb);
        
        // 🚀 同时保存 Token 到 Profile 表
        try {
            await new Promise((resolve, reject) => {
                sdb.run(`UPDATE profiles SET account_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR ext_id = ?`, [token, profileId, profileId], (err) => {
                    if (err) reject(err); else resolve();
                });
            });
        } catch (e) { log('WARN', `[FetchAdAccounts] Failed to update token in DB: ${e.message}`); }

        let savedCount = 0;
        const timestamp = new Date().toISOString();
        
        await new Promise((resolve, reject) => {
            sdb.serialize(() => {
                sdb.run('BEGIN TRANSACTION');
                
                // 1. 保存广告账户
                const stmt = sdb.prepare(`INSERT OR REPLACE INTO ad_accounts (
                    id, profile_id, platform, account_id, name, status, currency, 
                    timezone_id, spend, country, threshold_amount, credit_limit, balance, 
                    funding_source, pages_count, bm_count, pixels_count, updated_at, account, profile_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                accounts.forEach(acc => {
                    const actId = acc.account_id;
                    const fullId = `act_${actId}`;
                    const adsCount = acc.ads && Array.isArray(acc.ads.data) ? acc.ads.data.length : 0;
                    const pagesCount = acc.promotable_pages && Array.isArray(acc.promotable_pages.data) ? acc.promotable_pages.data.length : 0;
                    const pixelsCount = pixelMap.get(String(actId))?.length || 0;
                    const bmId = acc.business ? acc.business.id : null;
                    
                    // 🚀 核心改进：更鲁棒的卡片后四位提取
                    const fs = acc.funding_source_details;
                    const rawCard = fs ? (fs.display_string || fs.display_name || '') : '';
                    const lastFour = rawCard.match(/\d{4}/)?.[0] || '';
                    const cardInfo = lastFour ? `${lastFour} (${fs?.type || ''})` : (rawCard || '');
                    
                    const spendCap = Number(acc.spend_cap || 0) / 100;
                    
                    // 🚀 时区处理：严格遵循 "Name+Offset" 格式，如 America/Los_Angeles-8
                    let tzDisplay = String(acc.timezone_id || '');
                    if (acc.timezone_name) {
                        const offset = acc.timezone_offset_hours_utc;
                        const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                        tzDisplay = `${acc.timezone_name}${offsetStr}`;
                    } else if (acc.timezone_name_display) {
                         tzDisplay = acc.timezone_name_display;
                    }

                    stmt.run([
                        fullId, profileId, 'facebook', actId, acc.name || `Account ${actId}`, 
                        String(acc.account_status), acc.currency, tzDisplay, 
                        Number(acc.amount_spent || 0) / 100, acc.business_country_code || '', spendCap, 
                        Number(acc.adtrust_dsl || 0), Number(acc.balance || 0) / 100, cardInfo,
                        pagesCount || adsCount, bmId ? 1 : 0, pixelsCount, timestamp, accountDisplay, profName
                    ]);
                    savedCount++;
                });
                stmt.finalize();

                // 2. 保存主页列表
                const pageStmt = sdb.prepare(`INSERT OR REPLACE INTO pages (
                    id, user_id, profile_id, page_id, name, fan_count, link, category, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                fbPages.forEach(p => {
                    const pageId = String(p.id);
                    pageStmt.run([
                        `page_${pageId}`, 1, profileId, pageId, p.name, p.fan_count || 0, 
                        p.link || '', p.category || '', timestamp
                    ]);
                });
                pageStmt.finalize();

                // 3. 保存广告列表
                const adStmt = sdb.prepare(`INSERT OR REPLACE INTO ads (
                    id, user_id, profile_id, ad_id, name, status, account_id, 
                    campaign_id, campaign_name, adset_id, adset_name, creative_id, preview_url, targeting, creative_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                accounts.forEach(acc => {
                    if (acc.ads && Array.isArray(acc.ads.data)) {
                        acc.ads.data.forEach(ad => {
                            const adId = String(ad.id);
                            const targeting = ad.adset && ad.adset.targeting ? JSON.stringify(ad.adset.targeting) : '';
                            const creativeJson = ad.creative ? JSON.stringify(ad.creative) : '';
                            adStmt.run([
                                `ad_${adId}`, 1, profileId, adId, ad.name, ad.status, acc.account_id,
                                ad.campaign ? ad.campaign.id : '',
                                ad.campaign ? ad.campaign.name : '',
                                ad.adset ? ad.adset.id : '',
                                ad.adset ? ad.adset.name : '',
                                ad.creative ? ad.creative.id : '',
                                ad.creative ? ad.creative.thumbnail_url : '',
                                targeting,
                                creativeJson,
                                timestamp
                            ]);
                        });
                    }
                });
                adStmt.finalize();

                // 4. 保存像素列表
                const pixelStmt = sdb.prepare(`INSERT OR REPLACE INTO pixels (
                    id, user_id, profile_id, pixel_id, name, status, account_id, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

                fbPixels.forEach(px => {
                    const pxId = String(px.id);
                    pixelStmt.run([
                        `pixel_${pxId}`, 1, profileId, pxId, px.name, px.status || 'ACTIVE', px.account_id || '', timestamp
                    ]);
                });
                pixelStmt.finalize();

                sdb.run('COMMIT', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
        sdb.close();

        // 5. 同步到远程存储 (Storage Server)
        try {
            const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
            const apiSecret = process.env.PUPPETEER_API_SECRET || '';
            const sBase = storageServerUrl.replace(/\/$/, '');
            const items = accounts.map(acc => {
                let tzDisplay = String(acc.timezone_id || '');
                if (acc.timezone_name) {
                    const offset = acc.timezone_offset_hours_utc;
                    const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                    tzDisplay = `${acc.timezone_name}${offsetStr}`;
                } else if (acc.timezone_name_display) {
                    tzDisplay = acc.timezone_name_display;
                }

                const fs = acc.funding_source_details;
                const rawCard = fs ? (fs.display_string || fs.display_name || '') : '';
                const lastFour = rawCard.match(/\d{4}/)?.[0] || '';
                const cardInfo = lastFour ? `${lastFour} (${fs?.type || ''})` : (rawCard || '');

                return {
                    id: `act_${acc.account_id}`,
                    account_id: acc.account_id,
                    name: acc.name,
                    account_status: acc.account_status,
                    currency: acc.currency,
                    timezone_id: tzDisplay,
                    business_country_code: acc.business_country_code,
                    spend: Number(acc.amount_spent || 0) / 100,
                    credit_limit: Number(acc.adtrust_dsl || 0),
                    balance: Number(acc.balance || 0) / 100,
                    threshold_amount: Number(acc.spend_cap || 0) / 100, // 保存总限额到 threshold_amount
                    funding_source: cardInfo,
                    bm_count: acc.business ? 1 : 0,
                    pages_count: acc.promotable_pages && Array.isArray(acc.promotable_pages.data) ? acc.promotable_pages.data.length : 0,
                    pixels_count: pixelMap.get(String(acc.account_id))?.length || 0,
                    profile_id: profileId,
                    profile_name: profName,
                    account: accountDisplay
                };
            });
            
            await fetch(`${sBase}/api/adaccounts/bulk-save`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-Api-Secret': apiSecret 
                },
                body: JSON.stringify({ items })
            });

            // 🚀 新增：同步主页列表到远程存储
            if (fbPages.length > 0) {
                log('INFO', `[FetchAdAccounts] Syncing ${fbPages.length} pages to remote storage...`);
                const pageItems = fbPages.map(p => ({
                    id: `page_${p.id}`,
                    page_id: p.id,
                    name: p.name,
                    fan_count: p.fan_count || 0,
                    link: p.link || '',
                    category: p.category || '',
                    profile_id: profileId
                }));

                await fetch(`${sBase}/api/pages/bulk-save`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-Api-Secret': apiSecret 
                    },
                    body: JSON.stringify({ items: pageItems })
                });
            }

            // 🚀 新增：同步 BM 列表到远程存储
            if (fbBMs.length > 0) {
                log('INFO', `[FetchAdAccounts] Syncing ${fbBMs.length} BMs to remote storage...`);
                const bmItems = fbBMs.map(b => ({
                    id: String(b.id),
                    businessId: String(b.id),
                    name: b.name,
                    verification_status: b.verification_status || 'unknown',
                    profile_id: profileId
                }));

                await fetch(`${sBase}/api/businesses/bulk-save`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-Api-Secret': apiSecret 
                    },
                    body: JSON.stringify({ items: bmItems })
                });
            }

            // 🚀 新增：同步广告列表到远程存储
            const allAds = [];
            accounts.forEach(acc => {
                if (acc.ads && Array.isArray(acc.ads.data)) {
                    acc.ads.data.forEach(ad => {
                        allAds.push({
                            id: `ad_${ad.id}`,
                            ad_id: ad.id,
                            name: ad.name,
                            status: ad.status,
                            account_id: acc.account_id,
                            campaign_id: ad.campaign ? ad.campaign.id : '',
                            campaign_name: ad.campaign ? ad.campaign.name : '',
                            adset_id: ad.adset ? ad.adset.id : '',
                            adset_name: ad.adset ? ad.adset.name : '',
                            creative_id: ad.creative ? ad.creative.id : '',
                            preview_url: ad.creative ? ad.creative.thumbnail_url : '',
                            targeting: ad.adset && ad.adset.targeting ? JSON.stringify(ad.adset.targeting) : '',
                            creative_json: ad.creative ? JSON.stringify(ad.creative) : '',
                            profile_id: profileId
                        });
                    });
                }
            });

            if (allAds.length > 0) {
                log('INFO', `[FetchAdAccounts] Syncing ${allAds.length} ads to remote storage...`);
                await fetch(`${sBase}/api/ads/bulk-save`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-Api-Secret': apiSecret 
                    },
                    body: JSON.stringify({ items: allAds })
                });
            }

            // 🚀 新增：同步像素列表到远程存储
            if (fbPixels.length > 0) {
                log('INFO', `[FetchAdAccounts] Syncing ${fbPixels.length} pixels to remote storage...`);
                const pixelItems = fbPixels.map(px => ({
                    id: `pixel_${px.id}`,
                    pixel_id: px.id,
                    name: px.name,
                    status: px.status || 'ACTIVE',
                    account_id: px.account_id || '',
                    profile_id: profileId
                }));

                await fetch(`${sBase}/api/pixels/bulk-save`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-Api-Secret': apiSecret 
                    },
                    body: JSON.stringify({ items: pixelItems })
                });
            }

            // 同时同步 Token 到远程
            log('INFO', `[FetchAdAccounts] Syncing token and page counts to remote storage for profile: ${profileId}`);
            
            // 计算总主页数 (使用获取到的完整主页列表数量)
            const totalPages = fbPages.length;
            const totalBMs = fbBMs.length;

            const syncResp = await fetch(`${sBase}/api/profiles/bulk-save`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-Api-Secret': apiSecret 
                },
                body: JSON.stringify({ 
                    items: [{ 
                        id: profileId, 
                        token: token,
                        pages_count: totalPages, // 同步主页数量到 Profile 表
                        bm_count: totalBMs      // 同步 BM 数量到 Profile 表
                    }] 
                })
            });
            const syncJson = await syncResp.json();
            if (syncJson.success) {
                log('SUCCESS', `[FetchAdAccounts] Token synced to remote successfully`);
            } else {
                log('WARN', `[FetchAdAccounts] Token sync failed: ${syncJson.message || 'Unknown error'}`);
            }
        } catch (e) {
            console.warn('Remote sync failed:', e.message);
        }

        try {
            const b = activeBrowsers.get(String(profileId));
            if (b && b.context) {
                await b.context.close();
                activeBrowsers.delete(String(profileId));
            }
        } catch {}
        
        // 🚀 核心改进：在返回结果中包含像素列表，方便前端弹窗显示编号
        return res.json({ 
            success: true, 
            count: savedCount, 
            data: accounts, 
            pixels: fbPixels, // 包含像素编号
            token: token, 
            closed: true 
        });

    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});



// 获取账单设置信息（国家、货币、时区）
app.post('/api/facebook/scrape-billing-info', async (req, res) => {
    try {
        const { profileId, url, accessToken } = req.body || {};
        
        if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
        
        // 解析 asset_id
        let assetId = req.body.assetId;
        if (!assetId && url) {
            const m = url.match(/asset_id=(\d+)/);
            if (m) assetId = m[1];
        }
        if (!assetId && url) {
             const m2 = url.match(/payment_account_id=(\d+)/);
             if (m2) assetId = m2[1];
        }

        if (!assetId) return res.status(400).json({ success: false, message: 'Could not extract asset_id from URL' });
        if (!accessToken) return res.status(400).json({ success: false, message: 'missing accessToken' });

        // 获取浏览器
        let browserRef = null;
        let tempBrowser = null;
        try {
            const browserData = activeBrowsers.get(profileId);
            if ((browserData && browserData.context && browserData.context.browser())) {
                browserRef = browserData.context;
            } else {
                 const envChromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
                let effectiveExecutablePath = envChromePath || null;
                try {
                    const candidates = [
                        envChromePath,
                        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                        `${process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local'}\\Google\\Chrome\\Application\\chrome.exe`,
                        (() => { try { return chromium.executablePath(); } catch(_) { return null; } })()
                    ].filter(Boolean);
                    effectiveExecutablePath = candidates.find(p => { try { return fsSync.existsSync(p); } catch { return false; } }) || null;
                } catch {}
                const udDir = browserManager.getUnifiedUserDataDir(profileId, undefined, undefined);
                const launchOpts = { headless: false, args: [`--user-data-dir=${udDir}`], defaultViewport: null, timeout: 30000 };
        if (effectiveExecutablePath) launchOpts.executablePath = effectiveExecutablePath;
        tempBrowser = await chromium.launch(launchOpts);
                browserRef = tempBrowser;
            }
        } catch {}

        if (!browserRef || !browserRef.browser()) {
            return res.status(500).json({ success: false, message: 'no_browser' });
        }

        const page = await browserRef.newPage();
        try {
            const base = 'https://graph.facebook.com/v20.0';
            // 尝试使用 act_ 前缀，如果 assetId 纯数字
            const targetId = /^\d+$/.test(assetId) ? `act_${assetId}` : assetId;
            // fields: business_country_code (国家), currency (货币), timezone_name (时区名), timezone_id (时区ID), timezone_offset_hours_utc (偏移)
            const apiUrl = `${base}/${targetId}?fields=business_country_code,currency,timezone_name,timezone_id,timezone_offset_hours_utc,name,id,account_id&access_token=${encodeURIComponent(accessToken)}`;
            
            await page.goto(apiUrl, { waitUntil: 'networkidle', timeout: 15000 });
            
            let raw = await page.evaluate(() => document.body.innerText || document.body.textContent || '{}');
            let json = null;
            try { json = JSON.parse(raw); } catch {}
            
            if (!json || json.error) {
                // 如果出错，尝试不带 act_ 前缀
                if (/act_/.test(targetId)) {
                     const altId = targetId.replace('act_', '');
                     const altUrl = `${base}/${altId}?fields=business_country_code,currency,timezone_name,timezone_id,timezone_offset_hours_utc,name,id,account_id&access_token=${encodeURIComponent(accessToken)}`;
                     await page.goto(altUrl, { waitUntil: 'networkidle', timeout: 15000 });
                     raw = await page.evaluate(() => document.body.innerText || document.body.textContent || '{}');
                     try { json = JSON.parse(raw); } catch {}
                }
            }
            
            if (!json || json.error) {
                throw new Error(json?.error?.message || 'Graph API Error');
            }
            
            await page.close();
            if (tempBrowser) await tempBrowser.close();

            // 更新数据库
            try {
                const sdb = new sqlite3.Database(dbPath);
                await ensureAdAccountsTable(sdb);
                await new Promise((resolve, reject) => {
                    // 更新字段: country, currency, timezone_id
                    // 匹配: id 或 account_id
                    const updateSql = `UPDATE ad_accounts SET 
                        country = ?, 
                        currency = ?, 
                        timezone_id = ?,
                        updated_at = CURRENT_TIMESTAMP
                        WHERE account_id = ? OR id = ? OR account_id = ? OR id = ?`;
                    
                    const country = json.business_country_code || '';
                    const currency = json.currency || '';
                    
                    // 🚀 时区处理：如果存在 timezone_name，则显示为 "Name+-Offset" 格式
                    let tzVal = String(json.timezone_id || '');
                    if (json.timezone_name) {
                        const offset = json.timezone_offset_hours_utc;
                        const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                        tzVal = `${json.timezone_name}${offsetStr}`;
                    } else if (json.timezone_name_display) {
                        tzVal = json.timezone_name_display;
                    } else if (!tzVal && json.timezone_name) {
                        tzVal = json.timezone_name;
                    }

                    // 匹配ID: 原始assetId, act_assetId, stripped assetId
                    const id1 = assetId;
                    const id2 = `act_${assetId.replace('act_', '')}`;
                    const id3 = assetId.replace('act_', '');
                    
                    sdb.run(updateSql, [country, currency, tzVal, id1, id1, id2, id2], function(err) {
                        if (err) reject(err);
                        else resolve(this.changes);
                    });
                });
                sdb.close();
            } catch (e) {
                console.error('Update DB failed:', e);
            }

            // Sync to remote storage
            try {
                const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
                const sBase = storageServerUrl.replace(/\/$/, '');
                let tzSync = String(json.timezone_id || '');
                if (json.timezone_name) {
                    const offset = json.timezone_offset_hours_utc;
                    const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                    tzSync = `${json.timezone_name}${offsetStr}`;
                }

                const item = {
                    id: String(json.id || assetId || ''),
                    account_id: String(json.account_id || assetId || ''),
                    name: String(json.name || ''),
                    business_country_code: String(json.business_country_code || ''),
                    currency: String(json.currency || ''),
                    timezone_id: tzSync,
                    profile_id: String(profileId || '')
                };
                await fetch(`${sBase}/api/adaccounts/bulk-save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: [item] })
                });
            } catch (e) { console.error('Remote sync failed:', e); }

            return res.json({ 
                success: true, 
                data: {
                    country: json.business_country_code,
                    currency: json.currency,
                    timezone: json.timezone_name,
                    timezone_id: json.timezone_id,
                    name: json.name,
                    id: json.id,
                    account_id: json.account_id
                }
            });

        } catch (e) {
            try { await page.close(); } catch {}
            try { if (tempBrowser) await tempBrowser.close(); } catch {}
            throw e;
        }
        
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});

// 广告：更改状态（ACTIVE/PAUSED）
app.post('/api/facebook/ads/status', async (req, res) => {
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

// 广告：删除
app.post('/api/facebook/ads/delete', async (req, res) => {
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

// 广告账户：更改货币/时区（写入 storage 的 ad_account_settings）
app.post('/api/facebook/adaccounts/change-currency-timezone', async (req, res) => {
  try {
    const { profileId, adAccountId, currency, timezone_id } = req.body || {}
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
    const storageServerUrl = process.env.STORAGE_SERVER_URL || ''
    const baseUrl = storageServerUrl.replace(/\/$/, '')
    const items = [{ profileId, accountId: String(adAccountId), currency: String(currency||''), timezone_id: String(timezone_id||'') }]
    
    // 1. 同步到云端 ad_account_settings 表
    const resp = await fetch(`${baseUrl}/api/adaccount-settings/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) })
    const json = await resp.json()
    
    // 2. 🚀 同时更新本地 ad_accounts 表，确保列表页立即显示变更
    try {
      const sdb = new sqlite3.Database(dbPath);
      await ensureAdAccountsTable(sdb);
      await ensureAdAccountsColumns(sdb);
      await new Promise((resolve, reject) => {
        sdb.run(
          `UPDATE ad_accounts SET currency = ?, timezone_id = ?, updated_at = CURRENT_TIMESTAMP WHERE (account_id = ? OR id = ?) AND profile_id = ?`,
          [String(currency||''), String(timezone_id||''), String(adAccountId), String(adAccountId), String(profileId)],
          (err) => err ? reject(err) : resolve()
        );
      });
      sdb.close();
      log('INFO', `[AdAccount] 本地 ad_accounts 表已更新: profileId=${profileId}, adAccountId=${adAccountId}, currency=${currency}, tz=${timezone_id}`);
    } catch (localErr) {
      log('WARN', `[AdAccount] 本地 ad_accounts 表更新失败: ${localErr.message}`);
    }

    return res.json({ success: !!json?.success, count: json?.count || items.length, message: '货币/时区已更新（注：Facebook 不支持 API 修改，此更改仅影响本地显示）' })
  } catch (e) {
    return res.status(500).json({ success: false, message: String(e.message || e) })
  }
})

// 广告账户：设置限额（spend_cap）
app.post('/api/facebook/adaccounts/spend-cap', async (req, res) => {
  try {
    const { profileId, adAccountId, spend_cap } = req.body || {}
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
    const storageServerUrl = process.env.STORAGE_SERVER_URL || ''
    const baseUrl = storageServerUrl.replace(/\/$/, '')
    const items = [{ profileId, accountId: String(adAccountId), spend_cap: Number(spend_cap||0) }]
    const resp = await fetch(`${baseUrl}/api/adaccount-settings/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) })
    const json = await resp.json()
    return res.json({ success: !!json?.success, count: json?.count || items.length })
  } catch (e) {
    return res.status(500).json({ success: false, message: String(e.message || e) })
  }
})

// 广告账户：充值（仅记录 amount_spent 累加到设置表）
app.post('/api/facebook/adaccounts/topup', async (req, res) => {
  try {
    const { profileId, adAccountId, amount } = req.body || {}
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
    const storageServerUrl = process.env.STORAGE_SERVER_URL || ''
    const baseUrl = storageServerUrl.replace(/\/$/, '')
    // 读取现有设置
    let current = 0
    try {
      const settingsResp = await fetch(`${baseUrl}/api/adaccounts`)
      const settingsJson = await settingsResp.json()
      const arr = Array.isArray(settingsJson?.data) ? settingsJson.data : []
      const found = arr.find((x) => String(x.profileId) === String(profileId) && String(x.adAccountId) === String(adAccountId))
      current = Number(found?.spend || 0)
    } catch {}
    const items = [{ profileId, accountId: String(adAccountId), amount_spent: Number(current) + Number(amount||0) }]
    const resp = await fetch(`${baseUrl}/api/adaccount-settings/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) })
    const json = await resp.json()
    return res.json({ success: !!json?.success, count: json?.count || items.length })
  } catch (e) {
    return res.status(500).json({ success: false, message: String(e.message || e) })
  }
})

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

// 创建像素（占位返回）
app.post('/api/facebook/adaccounts/pixel/create', async (req, res) => {
  try {
    const { profileId, adAccountId, name } = req.body || {}
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
        if (json.error && (json.error.message.includes('nonexisting field') || json.error.code === 100)) {
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
        const browser = result.browserData.context;
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

    // 🚀 如果 API 模式返回了“已存在”错误，也尝试获取
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

      return res.json({ success: true, id: json.id, name: pixelName });
    } else {
      const errMsg = json?.error?.message || '像素创建最终失败';
      throw new Error(errMsg);
    }
  } catch (e) { 
    log('ERROR', `❌ 创建像素失败: ${e.message}`);
    return res.status(500).json({ success: false, message: String(e.message || e) }) 
  }
})

// 创建主页（占位返回）
app.post('/api/facebook/pages/create', async (req, res) => {
  try {
    const { profileId, name, category, website, profileImage, backgroundImage, accessToken, useApi } = req.body || {};
    if (!profileId || !name) return res.status(400).json({ success: false, message: 'missing profileId/name' });

    // 🔍 获取配置信息（包含代理）
    const profile = await findProfileById(profileId);
    const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';

    // 💡 优先尝试 API 创建（如果提供了 Token 且用户选择了 API 模式）
    if ((useApi || effectiveToken) && effectiveToken) {
      log('INFO', `正在尝试通过 Graph API 创建主页: ${name}`);
      try {
        const base = 'https://graph.facebook.com/v20.0';
        
        // 🚀 核心优化：使用更通用的类别参数
        // 1012 是 "Community" 的 ID，这是最稳健的创建方式
        const categoryId = '1012'; 
        const categoryName = category || 'Community';
        
        const apiParams = {
            name: name,
            category: categoryId, // 优先使用 ID
            category_list: JSON.stringify([categoryId]), // 同时提供列表以增强兼容性
            access_token: effectiveToken,
            about: website || 'Created via OmniFingerprint AdManager'
        };

        log('DEBUG', `API 预设参数: name=${name}, category=${categoryId}, hasToken=${!!effectiveToken}`);

        let json = null;
        let proxy = profile?.proxy;
        
        // 🚀 增强：如果 proxy 是字符串（来自云端可能未解析），尝试在这里解析
        if (typeof proxy === 'string' && proxy.trim()) {
            try {
                if (proxy.startsWith('{')) {
                    proxy = JSON.parse(proxy);
                } else {
                    const parts = proxy.split(':');
                    if (parts.length >= 2) {
                        proxy = { host: parts[0], port: parts[1], username: parts[2] || '', password: parts[3] || '', type: 'http' };
                    }
                }
            } catch (e) { log('WARN', `解析代理失败: ${e.message}`); }
        }
        
        // 🚀 核心改进：统一使用 callFacebookGraphApi 辅助函数，它处理了代理解析和避免命令行过长的问题
        log('INFO', `正在通过 API 执行主页创建 (代理: ${proxy?.host || '无'})...`);
        
        try {
            const formData = new URLSearchParams();
            formData.append('name', name);
            formData.append('category', categoryId);
            formData.append('category_list', JSON.stringify([categoryId]));
            if (website) formData.append('about', website);
            
            json = await callFacebookGraphApi('me/accounts', 'POST', formData, profile, effectiveToken);
        } catch (apiErr) {
            log('ERROR', `API 创建主页失败: ${apiErr.message}`);
        }

        // 如果 curl 失败且无代理，才尝试浏览器 fetch 作为最后的回退
        if (!json && (!proxy || !proxy.host)) {
            log('INFO', 'curl 失败且无代理，尝试最后一次浏览器环境 fetch...');
            const result = await ensureBrowserIsRunning(profileId);
            if (result.success) {
                const browser = result.browserData.context;
                const pages = await browser.pages();
                let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();
                if (!page.url().includes('facebook.com')) {
                    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
                }
                
                json = await page.evaluate(async (url, params) => {
                    try {
                        const p = new URLSearchParams();
                        for (const [k, v] of Object.entries(params)) if (v) p.append(k, v);
                        
                        // 🚀 核心改进：创建主页前，确保浏览器上下文内已经有 cookie
                        // 这里的 fetch 会自动带上当前浏览器的 Cookie
                        const resp = await fetch(url, { 
                            method: 'POST', 
                            body: p 
                        });
                        return await resp.json();
                    } catch (e) { return { error: { message: e.message } }; }
                }, "https://graph.facebook.com/v21.0/me/accounts", apiParams);
            }
        }

        if (json && json.id) {
          log('SUCCESS', `通过 API 成功创建主页: ${json.id}`);
          
          // 🚀 核心改进：创建成功后立即触发资产同步
          try {
            log('INFO', `🚀 正在为 profileId=${profileId} 启动创建后的资产同步...`);
            const port = process.env.PLAYWRIGHT_PORT || process.env.PUPPETEER_PORT || 8888;
            const syncUrl = `http://127.0.0.1:${port}/api/facebook/fetch-adaccounts-graph`;
            
            // 异步触发同步，不阻塞返回响应
            fetch(syncUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-Api-Secret': API_SECRET
                },
                body: JSON.stringify({ profileId, accessToken: effectiveToken })
            }).catch(err => log('WARN', `同步资产失败: ${err.message}`));
          } catch (syncErr) {
            log('WARN', `启动同步逻辑异常: ${syncErr.message}`);
          }

          return res.json({ success: true, message: 'Page created successfully via Graph API', pageId: json.id, method: 'api' });
        } else {
          // 🚀 增强日志：记录完整的错误响应
          const apiErrorMsg = json?.error?.message || 'Unknown error';
          const apiErrorCode = json?.error?.code || 'No code';
          const apiErrorSubcode = json?.error?.error_subcode || 'No subcode';
          const apiErrorType = json?.error?.type || 'No type';
          
          log('WARN', `API 创建失败 [${apiErrorCode}/${apiErrorSubcode}]: ${apiErrorMsg} (${apiErrorType})`);
          if (!json?.error) log('DEBUG', `完整 API 响应: ${JSON.stringify(json)}`);
          
          log('INFO', 'API 模式失败，将继续回退到 Puppeteer 自动化...');
        }
      } catch (apiErr) {
        log('ERROR', `API 创建异常: ${apiErr.message}`);
      }
    }

    // 🚀 如果 API 模式未生效或失败，进入 UI 自动化流程
    log('INFO', '进入 Puppeteer UI 自动化创建流程...');
    const result = await ensureBrowserIsRunning(profileId);
    if (!result.success) {
      return res.status(500).json({ success: false, message: result.error });
    }
    const browserData = result.browserData;
    const browser = browserData.context;
    const page = await browser.newPage();

    try {
      log('INFO', '正在导航到 Facebook 主页创建页面...');
      let navigated = false;
      for (let i = 0; i < 3; i++) {
        try {
          await page.goto('https://www.facebook.com/pages/create', { waitUntil: 'networkidle', timeout: 45000 });
          navigated = true;
          break;
        } catch (e) {
          log('WARN', `导航尝试 ${i+1} 失败: ${e.message}，正在重试...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      
      if (!navigated) throw new Error('无法加载 Facebook 主页创建页面，请检查网络或代理设置');

      const currentUrl = page.url();
      if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
          log('ERROR', `检测到页面被拦截或重定向: ${currentUrl}`);
          throw new Error('浏览器当前未登录或触发了安全检查，请先手动登录并解决验证');
      }

      await new Promise(r => setTimeout(r, 5000));
      
      // 1. 填写名称
      log('INFO', `正在尝试填写主页名称: ${name}`);
      
      const nameSelectorResult = await page.evaluate((targetName) => {
        const selectors = [
          'input[aria-label*="名称" i]', 'input[aria-label*="Name" i]', 'input[aria-label*="Page name" i]',
          'input[placeholder*="主页名称" i]', 'input[placeholder*="Page name" i]', 'input[id*="name" i]', 'input[name*="name" i]'
        ];

        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') return { selector: sel, method: 'selector' };
          }
        }

        const allInputs = Array.from(document.querySelectorAll('input'));
        for (const input of allInputs) {
           let contextText = '';
           let p = input.parentElement;
           for(let i=0; i<3 && p; i++) { contextText += p.innerText + ' '; p = p.parentElement; }
           if (/主页名称|Page name|名称|Name/i.test(contextText) && input.offsetParent !== null) {
               input.id = input.id || `tmp_name_ctx_${Date.now()}`;
               return { selector: `#${input.id}`, method: 'context-search' };
           }
        }

        const labels = Array.from(document.querySelectorAll('label, span, div')).filter(el => {
            const t = el.innerText || '';
            return t.length < 30 && /主页名称|Page name|名称|Name/i.test(t);
        });

        for (const l of labels) {
          const input = l.querySelector('input') || l.parentElement.querySelector('input') || (l.nextElementSibling && l.nextElementSibling.querySelector('input'));
          if (input && input.offsetParent !== null) {
            input.id = input.id || `tmp_name_lbl_${Date.now()}`;
            return { selector: `#${input.id}`, method: 'label-near' };
          }
        }

        const firstVisible = allInputs.find(i => {
            const style = window.getComputedStyle(i);
            return i.type === 'text' && i.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (firstVisible) {
          firstVisible.id = firstVisible.id || `tmp_name_fallback_${Date.now()}`;
          return { selector: `#${firstVisible.id}`, method: 'fallback-visible' };
        }
        return null;
      }, name);

      if (!nameSelectorResult) throw new Error('无法定位主页名称输入框，请检查 Facebook UI 是否发生变化或页面加载是否完整');

      log('INFO', `找到名称输入框 (方法: ${nameSelectorResult.method}, 选择器: ${nameSelectorResult.selector})`);
      const finalNameSelector = nameSelectorResult.selector;
      await page.waitForSelector(finalNameSelector, { visible: true, timeout: 5000 });
      await page.click(finalNameSelector, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type(finalNameSelector, name, { delay: 100 });

      // 2. 填写类别
      if (category) {
        log('INFO', `正在尝试填写类别: ${category}`);
        // 🚀 优化：增加 2 次 Tab 补偿逻辑，以跳过名称框后的装饰元素
        try {
          log('INFO', '尝试使用 2 次 Tab 键补偿切换到类别输入框...');
          await page.keyboard.press('Tab');
          await new Promise(r => setTimeout(r, 400)); // 增加延迟确保 UI 响应
          await page.keyboard.press('Tab');
          await new Promise(r => setTimeout(r, 600));
          
          // 检查当前焦点是否是输入框
          const isInputFocused = await page.evaluate(() => {
            const active = document.activeElement;
            // Facebook 的类别输入框通常是 combobox 或带有特定 aria 属性的 input
            return active && (active.tagName === 'INPUT' || active.getAttribute('role') === 'combobox' || active.getAttribute('aria-haspopup') === 'listbox' || active.getAttribute('aria-autocomplete') === 'list');
          });
          
          if (isInputFocused) {
            log('INFO', '2 次 Tab 切换成功，开始输入类别');
            // 清空可能存在的默认文本
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await page.keyboard.type(category, { delay: 120 });
          } else {
            throw new Error('Tab focus failed after 2 attempts');
          }
        } catch (tabErr) {
          log('WARN', `Tab 补偿失败 (${tabErr.message})，改用选择器定位类别框`);
          const catSelectorResult = await page.evaluate(() => {
            const selectors = [
                'input[aria-label*="类别" i]', 'input[aria-label*="Category" i]', 
                'input[placeholder*="类别" i]', 'input[placeholder*="Category" i]',
                'div[aria-label*="类别" i] input', 'div[aria-label*="Category" i] input',
                'input[role="combobox"]', '[data-testid="page_create_category_input"]'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && el.offsetParent !== null) return sel;
            }
            const labels = Array.from(document.querySelectorAll('label'));
            for (const l of labels) {
              if (/类别|Category/i.test(l.innerText)) {
                const input = l.querySelector('input') || l.parentElement.querySelector('input') || (l.nextElementSibling && l.nextElementSibling.querySelector('input'));
                if (input) { input.id = input.id || `tmp_cat_${Date.now()}`; return `#${input.id}`; }
              }
            }
            return null;
          });

          if (catSelectorResult) {
            log('INFO', `找到类别输入框: ${catSelectorResult}`);
            await page.click(catSelectorResult, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(catSelectorResult, category, { delay: 100 });
          } else {
            log('WARN', '未能找到类别输入框，跳过此步');
          }
        }

        // 统一处理类别选择后的回车逻辑
        await new Promise(r => setTimeout(r, 4500)); // 增加等待类别列表出现的时间
        await page.keyboard.press('ArrowDown');
        await new Promise(r => setTimeout(r, 1000));
        await page.keyboard.press('Enter');
        log('INFO', '类别已选择并回车确认');

        // 🚀 优化：根据用户需求，选择类别后执行 Tab 2 次再回车提交
        await new Promise(r => setTimeout(r, 1500));
        log('INFO', '正在执行 Tab 2 次补偿提交逻辑...');
        await page.keyboard.press('Tab');
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Tab');
        await new Promise(r => setTimeout(r, 1000));
        await page.keyboard.press('Enter');
        log('INFO', '已执行 Tab 2 次并回车提交');
      }

      // 3. 点击创建按钮
      log('INFO', '检查并点击“创建”按钮');
      const createBtnSelector = '[aria-label*="创建" i], [aria-label*="Create" i]';
      try {
        const foundCreateBtn = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
          const target = btns.find(b => {
            const txt = (b.innerText || '').toLowerCase();
            return (txt.includes('创建') || txt.includes('create')) && !txt.includes('账号') && !txt.includes('account');
          });
          if (target && target.offsetParent !== null) {
            target.scrollIntoView({ block: 'center' });
            target.click();
            return true;
          }
          return false;
        });
        if (!foundCreateBtn) await page.click(createBtnSelector);
      } catch (e) { log('WARN', `点击创建按钮时发生异常: ${e.message}`); }

      // 4. 处理多步骤向导
      log('INFO', '等待创建响应并处理后续步骤...');
      let stepsHandled = 0;
      let isFinalSuccess = false;
      const maxSteps = 12;

      while (stepsHandled < maxSteps) {
        try {
          await new Promise(r => setTimeout(r, 2000));
          const errorText = await page.evaluate(() => {
            const alert = document.querySelector('div[role="alert"]');
            if (alert) return alert.innerText;
            const errorSpans = Array.from(document.querySelectorAll('span')).filter(s => {
              const t = (s.innerText || '').toLowerCase();
              return t.includes('too many pages') || t.includes('无法创建') || t.includes('something went wrong');
            });
            if (errorSpans.length > 0) return errorSpans[0].innerText;
            return null;
          });

          if (errorText) { log('ERROR', `创建失败: ${errorText}`); throw new Error(errorText); }

          const currentUrl = page.url();
          if (currentUrl.includes('/pages/admin/') || currentUrl.includes('/latest/home') || currentUrl.includes('business.facebook.com/latest/home')) {
            log('SUCCESS', '已进入主页管理界面，确认创建成功！');
            isFinalSuccess = true;
            break;
          }

          const stepBtnInfo = await page.evaluate(() => {
            const labels = ['下一步', 'Next', '继续', 'Continue', '完成', 'Done', '保存', 'Save', '跳过', 'Skip', '确定', 'Confirm'];
            const buttons = Array.from(document.querySelectorAll('div[role="button"], button')).filter(b => {
              const text = (b.innerText || '').trim();
              return labels.some(l => text.includes(l));
            });
            const visibleBtn = buttons.find(b => {
              const style = window.getComputedStyle(b);
              const rect = b.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && b.offsetHeight > 0 && rect.top >= 0;
            });
            if (visibleBtn) {
              const btnText = visibleBtn.innerText;
              visibleBtn.scrollIntoView({ block: 'center' });
              visibleBtn.click();
              return { success: true, text: btnText };
            }
            return { success: false };
          });

          if (stepBtnInfo.success) {
            log('INFO', `点击了向导按钮: ${stepBtnInfo.text}`);
            await new Promise(r => setTimeout(r, 3500));
            stepsHandled++;
          } else {
            log('INFO', '未发现可见按钮，尝试按下 Enter 键继续...');
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 3000));
            stepsHandled++;
          }
        } catch (stepErr) {
          log('WARN', `处理步骤时发生异常: ${stepErr.message}`);
          if (stepErr.message.toLowerCase().includes('too many pages')) throw stepErr;
          await new Promise(r => setTimeout(r, 2000));
          stepsHandled++;
        }
      }

      if (!isFinalSuccess && page.url().includes('/pages/')) isFinalSuccess = true;
      await page.close();

      if (isFinalSuccess) {
          // 🚀 核心改进：浏览器模式创建成功后也触发资产同步
          try {
            log('INFO', `🚀 正在为 profileId=${profileId} 启动创建(UI)后的资产同步...`);
            const port = process.env.PLAYWRIGHT_PORT || process.env.PUPPETEER_PORT || 8888;
            const syncUrl = `http://127.0.0.1:${port}/api/facebook/fetch-adaccounts-graph`;
            
            fetch(syncUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-Api-Secret': API_SECRET
                },
                body: JSON.stringify({ profileId }) // 浏览器模式通常有 Cookie，同步接口会自动处理
            }).catch(err => log('WARN', `同步资产失败: ${err.message}`));
          } catch (syncErr) {
            log('WARN', `启动同步逻辑异常: ${syncErr.message}`);
          }
          return res.json({ success: true, message: 'Page created and saved successfully' });
      }
      else return res.status(500).json({ success: false, message: 'Reached step limit without confirming final success' });

    } catch (createErr) {
      log('ERROR', `创建过程中发生错误: ${createErr.message}`);
      try { await page.close(); } catch {}
      return res.status(500).json({ success: false, message: createErr.message });
    }

  } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
})

// 发布广告（占位返回）
app.post('/api/facebook/adaccounts/ads/publish', async (req, res) => {
  try {
    const { profileId, adAccountId, creative } = req.body || {}
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
    return res.json({ success: true })
  } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
})

// 账号重登（占位）
app.post('/api/facebook/relogin', async (req, res) => {
  try {
    const { profileId } = req.body || {};
    if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
    const browserData = activeBrowsers.get(String(profileId || ''));
    if (!browserData || !browserData.context || !browserData.context.browser()) {
      return res.json({ success: false, status: 'no_browser' });
    }
    const browser = browserData.context;
    const page = await browser.newPage();
    let clicked = false;
    let loggedIn = false;
    let saved = 0;
    let closed = false;
    try {
      // await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle', timeout: 30000 });
      // User wants to visit Graph API to get config? 
      // No, this is relogin logic.
      // Let's keep it as is but fix storage url below if needed.
      await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle', timeout: 30000 });
      const prof = await findProfileById(String(profileId));
      const ok = await autoFillPasswordOnPage(page, prof || {}, String(profileId));
      try { await new Promise(r => setTimeout(r, )); } catch {}
      if (ok) {
        try {
          const info = await page.evaluate(async () => {
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
              ...qs('[data-testid*="login" i]'),
              ...qs('button'),
              ...qs('div[role="button"]'),
              ...qs('a[role="button"]')
            ];
            let target = btns.find(b => visible(b) && (/登录|log in|signin|sign in|登入/i.test(norm(b.textContent)) || /登录|log in|signin|sign in|登入/i.test(norm(b.getAttribute('aria-label')))));
            if (!target) target = btns.find(b => visible(b));
            if (target) {
              try { target.scrollIntoView({ block: 'center' }); } catch {}
              try { target.click(); } catch {}
              return { clicked: true, method: 'button' };
            }
            let pwd = document.querySelector('input[type="password"]');
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
          clicked = !!(info && info.clicked);
        } catch {}
        try { await new Promise(r => setTimeout(r, )); } catch {}
        if (!loggedIn) {
          try {
            const pages = await browser.pages();
            let all = [];
            for (const p of pages) { try { const cks = await p.cookies(); all = all.concat(cks); } catch {} }
            const fb = all.filter(c => /facebook\.com$/i.test(String(c.domain||'')));
            const hasCUser = fb.some(c => c.name === 'c_user');
            const hasXs = fb.some(c => c.name === 'xs');
            loggedIn = !!(hasCUser && hasXs);
          } catch {}
        }
        if (clicked && !loggedIn) {
          try { if (page && !page.isClosed()) await page.close(); } catch {}
          try { if (browser && browser.browser()) await browser.close(); closed = true; } catch {}
          try { activeBrowsers.delete(String(profileId || '')); } catch {}
        }
        if (!closed && !loggedIn) {
          for (let i = 0; i < 20 && !loggedIn; i++) {
            try {
              const pages = await browser.pages();
              let all = [];
              for (const p of pages) { try { const cks = await p.cookies(); all = all.concat(cks); } catch {} }
              const fb = all.filter(c => /facebook\.com$/i.test(String(c.domain||'')));
              const hasCUser = fb.some(c => c.name === 'c_user');
              const hasXs = fb.some(c => c.name === 'xs');
              loggedIn = !!(hasCUser && hasXs);
            } catch {}
            if (!loggedIn) { try { await new Promise(r => setTimeout(r, )); } catch {} }
          }
        }
        // 登录成功则同步Cookie并关闭浏览器
        if (loggedIn) {
          try {
            const pages = await browser.pages();
            let allCookies = [];
            for (const p of pages) { try { const cks = await p.cookies(); allCookies = allCookies.concat(cks); } catch {} }
            const seen = new Set(); const dedup = [];
            for (const c of allCookies) { const key = `${c.domain}|${c.name}`; if (!seen.has(key)) { seen.add(key); dedup.push(c); } }
            const jsonData = JSON.stringify(dedup);
            const sdb = new sqlite3.Database(dbPath);
            await new Promise((resolve, reject) => {
              sdb.run(`UPDATE profiles SET account_cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [jsonData, profileId], function(err){ if (err) return reject(err); resolve(); });
            });
            await new Promise(r => sdb.close(r));
            saved = dedup.length;
          } catch {}
          try { if (page && !page.isClosed()) await page.close(); } catch {}
          try { if (browser && browser.browser()) await browser.close(); closed = true; } catch {}
          try { activeBrowsers.delete(String(profileId || '')); } catch {}
        } else {
          try { if (page && !page.isClosed()) await page.close(); } catch {}
          try { if (browser && browser.browser()) await browser.close(); closed = true; } catch {}
          try { activeBrowsers.delete(String(profileId || '')); } catch {}
        }
      }
    } catch {}
    return res.json({ success: true, clicked, loggedIn, saved, closed });
  } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }); }
})

// 获取/刷新TOKEN（占位）
app.post('/api/facebook/tokens/refresh', async (req, res) => {
  return res.status(404).json({ success: false, message: 'removed' })
})


// 🍪 同步当前浏览器Cookie到卡片配置（profiles.account_cookies）
app.post('/api/sync-cookies-to-card', async (req, res) => {
    const { profileId } = req.body || {};
    try {
        if (!profileId) return res.status(400).json({ success: false, message: '缺少 profileId' });
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.context || !browserData.context.browser()) {
            return res.status(404).json({ success: false, message: '未找到运行中的浏览器实例' });
        }

        const browser = browserData.context;
        const pages = await browser.pages();
        let allCookies = [];
        for (const page of pages) {
            try {
                const cks = await page.context().cookies();
                allCookies = allCookies.concat(cks);
            } catch {}
        }
        // 去重
        const seen = new Set();
        const dedup = [];
        for (const c of allCookies) {
            const key = `${c.domain}|${c.name}`;
            if (!seen.has(key)) { seen.add(key); dedup.push(c); }
        }

        // 写入到新数据库的 profiles.account_cookies
        const jsonData = JSON.stringify(dedup);
        async function updateDb(){
            const db = new sqlite3.Database(dbPath);
            await new Promise((resolve, reject) => {
                db.run(`UPDATE profiles SET account_cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [jsonData, profileId], function(err){
                    if (err) return reject(err);
                    resolve();
                });
            });
            db.close();
        }
        await updateDb();

        res.json({ success: true, profileId, saved: dedup.length, message: 'Cookie已同步到卡片配置' });
    } catch (error) {
        res.status(500).json({ success: false, message: '同步失败', error: error.message });
    }
});

/**
 * 🛡️ 辅助函数：确保浏览器正在运行，如果没运行则自动启动
 * @param {string} profileId 
 * @returns {Promise<{success: boolean, browserData?: any, error?: string}>}
 */
// 🎭 Playwright 辅助函数
function isBrowserConnected(browserData) {
    try {
        if (!browserData) return false;
        const ctx = browserData.context || browserData;
        return !!(ctx && ctx._context && typeof ctx.pages === 'function');
    } catch { return false; }
}

function isContextConnected(context) {
    try {
        return !!(context && typeof context.pages === 'function' && context.browser() !== null);
    } catch { return false; }
}

async function isProfileRunning(profileId) {
    try {
        const browserData = activeBrowsers.get(String(profileId));
        return !!((browserData && browserData.context && browserData.context.browser()));
    } catch {
        return false;
    }
}

async function ensureBrowserIsRunning(profileId) {
    let browserData = activeBrowsers.get(String(profileId));
    if ((browserData && browserData.context && browserData.context.browser())) {
        return { success: true, browserData };
    }

    log('INFO', `🚀 自动化任务检测到浏览器未运行，正在为 profileId=${profileId} 自动启动浏览器...`);
    try {
        // 调用内部启动逻辑 (模拟 API 请求)
        const port = process.env.PUPPETEER_PORT || 9999;
        const launchUrl = `http://127.0.0.1:${port}/api/launch-browser`;
        
        const launchResp = await fetch(launchUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-Api-Secret': API_SECRET
            },
            body: JSON.stringify({ profileId })
        });
        
        const launchResult = await launchResp.json();
        if (!launchResult.success) {
            throw new Error(`自动启动浏览器失败: ${launchResult.message}`);
        }
        
        // 🚀 优化：等待浏览器完全就绪，增加到 30 秒，并检查 browser 实例是否存在
        let retries = 0;
        const maxRetries = 30;
        while (retries < maxRetries) {
            await new Promise(r => setTimeout(r, 1000));
            browserData = activeBrowsers.get(String(profileId));
            if ((browserData && browserData.context && browserData.context.browser())) {
                log('INFO', `✅ 浏览器已成功自动启动并就绪 (profileId=${profileId})`);
                return { success: true, browserData };
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

    // 🚀 启动Puppeteer浏览器端点 (兼容enhanced.html的API调用)
// 路由已在上方定义 (1726行)，此处不再重复定义
app.post('/api/browser/launch-puppeteer', async (req, res) => {
    const startTime = Date.now();
    launchCount++;
    
    // 捕获授权令牌，用于后续同步
    const authToken = req.headers['authorization'] || req.headers['Authorization'];
    
    const { profileId, profile, proxy: rawProxy, startUrls, cookies, userAgent, executablePath, userDataDir, url, startUrl, chrome115Config } = req.body;
    
    // 🚀 将原始代理字符串解析为对象格式（关键修复：否则 createBrowser 无法识别代理）
    const proxy = typeof rawProxy === 'string' && rawProxy.trim()
        ? parseProxy(rawProxy.trim())
        : (typeof rawProxy === 'object' ? rawProxy : null);
    log('DEBUG', `🔐 代理解析: ${rawProxy ? (typeof rawProxy) : '无'} → ${proxy ? JSON.stringify(proxy) : '无'}`);
    
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
            finalProxy = typeof dbProfileLoaded.proxy === 'string'
                ? parseProxy(dbProfileLoaded.proxy)
                : (dbProfileLoaded.proxy || proxy);
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
    
    // 🔧 确保debugPort有默认值，避免undefined导致路径错误
    const debugPort = req.body.debugPort || 9222;
    console.log(`🔧 使用调试端口: ${debugPort} (${req.body.debugPort ? '用户指定' : '默认值'})`);
    
    try {
        console.log(`🚀 启动Puppeteer浏览器配置 ${profileId}...`);
        console.log(`🌐 接收到的启动网站:`, finalStartUrls);

        // 使用启动队列管理并发
        const result = await launchQueueManager.add(async () => {
            // 配置浏览器参数
            const config = {
                profileId,
                browserType: (req.body.browserType || process.env.BROWSER_TYPE || 'chrome').toLowerCase(),
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
                userAgent: config.userAgent
            });

            // 处理启动网站
            if (finalStartUrls && finalStartUrls.length > 0) {
                console.log(`🌐 准备打开启动网站: ${finalStartUrls.join(', ')}`);
                
                // 创建新标签页打开网站
                for (const url of finalStartUrls.slice(0, 3)) { // 限制最多3个网站
                    try {
                            const page = await browserInstance.browser.newPage();
                            try { attachCookieSync(page, profileId); } catch {}
                        
                        // [PW] UA 在 context 创建时设置，跳过运行时 setUserAgent
                        
                        // 🍪 动态注入Cookie（在导航之前）
                        if (parsedCookies && parsedCookies.length > 0) {
                            console.log(`🍪 开始为页面 ${url} 动态注入 ${parsedCookies.length} 个Cookie...`);
                            
                            // 先导航到目标域名的空白页面以建立正确的上下文
                            try {
                                const targetUrl = new URL(url);
                                const blankUrl = `${targetUrl.protocol}//${targetUrl.host}`;
                                console.log(`🔧 先导航到空白页面建立域名上下文: ${blankUrl}`);
                                await page.goto(blankUrl, { waitUntil: 'networkidle', timeout: 10000 });
                            } catch (blankNavError) {
                                console.warn(`⚠️ 导航到空白页面失败，直接注入Cookie: ${blankNavError.message}`);
                            }
                            
                            // 逐个注入Cookie
                            let injectedCount = 0;
                            for (const cookie of parsedCookies) {
                                try {
                                    // 构建符合CDP格式的Cookie对象
                                    const cdpCookie = {
                                        name: cookie.name,
                                        value: cookie.value,
                                        domain: cookie.domain,
                                        path: cookie.path || '/',
                                        secure: cookie.secure || false,
                                        httpOnly: cookie.httpOnly || false,
                                        sameSite: cookie.sameSite || 'Lax'
                                    };
                                    
                                    // 设置过期时间
                                    if (cookie.expiry) {
                                        cdpCookie.expires = cookie.expiry;
                                    } else if (cookie.expires) {
                                        cdpCookie.expires = Math.floor(new Date(cookie.expires).getTime() / 1000);
                                    } else {
                                        // 默认1年后过期
                                        cdpCookie.expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
                                    }
                                    
                                    await page.context().addCookies([cdpCookie]);
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
                                const currentCookies = await page.context().cookies();
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
                            await page.goto(blankUrl, { waitUntil: 'networkidle', timeout: 10000 });
                            
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
                                waitUntil: 'networkidle',
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
                                    // 🎭 Playwright: newCDPSession 需要传入 page 参数
                const client = await page.context().newCDPSession(page);
                                    
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
                                const finalCookies = await page.context().cookies();
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
        });

        const launchTime = Date.now() - startTime;
        totalLaunchTime += launchTime;
        successCount++;

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
        errorCount++;
        
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

app.post('/api/rpa/run', async (req, res) => {
    const { profileId, steps = [], newPage } = req.body || {};
    const logs = [];
    try {
        const active = activeBrowsers.get(profileId);
        if (!active || !active.context) return res.status(400).json({ success: false, message: 'browser not running', profileId });
        const browser = active.context;
        let page;
        if (newPage) {
            page = await browser.newPage();
        } else {
            const pages = await browser.pages();
            page = pages[0] || await browser.newPage();
        }
        for (const step of steps) {
            try {
                const a = step.action;
                if (a === 'goto') {
                    await page.goto(step.url, { waitUntil: step.waitUntil || 'networkidle', timeout: step.timeout || 30000 });
                    logs.push(`goto:${step.url}`);
                } else if (a === 'waitForSelector') {
                    await page.waitForSelector(step.selector, { timeout: step.timeout || 30000 });
                    logs.push(`wait:${step.selector}`);
                } else if (a === 'click') {
                    await page.click(step.selector, step.options || {});
                    logs.push(`click:${step.selector}`);
                } else if (a === 'type') {
                    await page.type(step.selector, step.text || '', step.options || {});
                    logs.push(`type:${step.selector}`);
                } else if (a === 'evaluate') {
                    const r = await page.evaluate(step.script || (() => null));
                    logs.push(`eval:${String(r).slice(0,80)}`);
                } else if (a === 'screenshot') {
                    const buf = await page.screenshot({ fullPage: !!step.fullPage });
                    logs.push(`screenshot:${buf.length}`);
                } else if (a === 'delay') {
                    await new Promise(r => setTimeout(r, step.ms || 500));
                    logs.push(`delay:${step.ms || 500}`);
                }
            } catch (e) {
                logs.push(`error:${e.message}`);
                return res.status(500).json({ success: false, profileId, logs, message: e.message });
            }
        }
        const url = page.url();
        return res.json({ success: true, profileId, url, logs });
    } catch (e) {
        return res.status(500).json({ success: false, profileId, message: e.message });
    }
});

// 📋 配置文件管理API
app.get('/api/profiles', async (req, res) => {
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
            const db = new sqlite3.Database(dbPath);
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
        res.status(500).json({ success: false, error: '获取配置文件失败', message: String(error.message || error) });
    }
});

// 📋 获取单个配置文件
app.get('/api/profiles/:id', async (req, res) => {
    try {
        const { id } = req.params;
        async function readOne(){
            const db = new sqlite3.Database(dbPath);
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
        res.status(500).json({ success: false, error: '获取配置文件失败', message: String(error.message || error) });
    }
});

// 📋 创建配置文件
app.post('/api/profiles', async (req, res) => {
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
                account_tokens: p.token || ''
            };
        }
        async function ensureAndInsert(){
            const db = new sqlite3.Database(dbPath);
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
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, (err)=> err ? reject(err) : resolve());
            });
            try {
                for(const raw of toArray){
                    const p = mapProfile(raw);
                    await new Promise((resolve, reject)=>{
                        const sql = `INSERT OR REPLACE INTO profiles (
                            id, name, platform, account_name, account_email, account_password, account,
                            start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
                            proxy_port, proxy_username, proxy_password, account_notes, account_tokens, updated_at
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                        )`;
                        const args = [
                            p.id, p.name, p.platform, p.account_name, p.account_email, p.account_password, p.account,
                            p.start_url, p.user_agent, p.proxy, p.proxy_enabled, p.proxy_type, p.proxy_host,
                            p.proxy_port, p.proxy_username, p.proxy_password, p.account_notes, p.account_tokens
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

app.post('/api/profiles/bulk-save', async (req, res) => {
    try {
        const payload = req.body && req.body.profiles ? req.body.profiles : [];
        if (!Array.isArray(payload) || payload.length === 0) return res.status(400).json({ success: false, message: '无有效配置' });
        const toArray = payload;
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
                account_notes: p.notes || ''
            };
        }
        async function ensureAndInsert(){
            const db = new sqlite3.Database(dbPath);
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
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, (err)=> err ? reject(err) : resolve());
            });
            try {
                for(const raw of toArray){
                    const p = mapProfile(raw);
                    await new Promise((resolve, reject)=>{
                        const sql = `INSERT OR REPLACE INTO profiles (
                            id, name, platform, account_name, account_email, account_password, account,
                            start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
                            proxy_port, proxy_username, proxy_password, account_notes, updated_at
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                        )`;
                        const args = [
                            p.id, p.name, p.platform, p.account_name, p.account_email, p.account_password, p.account,
                            p.start_url, p.user_agent, p.proxy, p.proxy_enabled, p.proxy_type, p.proxy_host,
                            p.proxy_port, p.proxy_username, p.proxy_password, p.account_notes
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

// 📋 会话管理API
app.get('/api/sessions', (req, res) => { res.status(404).end() });

// 🗑️ 清理端点
app.post('/api/cleanup', async (req, res) => {
    try {
        console.log('🧹 开始清理资源...');
        
        // 清理空闲浏览器实例
        await browserManager.cleanupIdleInstances();
        
        // 强制垃圾回收
        if (global.gc) {
            global.gc();
        }
        
        console.log('✅ 资源清理完成');
        
        res.json({
            success: true,
            message: '资源清理完成',
            timestamp: new Date().toISOString(),
            stats: browserManager.getStats()
        });
        
    } catch (error) {
        console.error('❌ 清理失败:', error);
        
        res.status(500).json({
            success: false,
            message: '清理失败',
            error: error.message
        });
    }
});

// 🔧 DevTools代理API - 用于线上域名访问本地DevTools
app.get('/api/devtools/:debugPort/json/list', async (req, res) => {
    try {
        const { debugPort } = req.params;
        const http = require('http');
        
        console.log(`🔧 DevTools代理请求: localhost:${debugPort}/json/list`);
        
        const options = {
            hostname: 'localhost',
            port: debugPort,
            path: `/json/list?t=${Date.now()}`,
            method: 'GET'
        };
        
        const request = http.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => {
                data += chunk;
            });
            response.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    res.json(jsonData);
                } catch (parseError) {
                    console.error('❌ JSON解析失败:', parseError.message);
                    res.status(500).json({
                        success: false,
                        error: 'JSON解析失败',
                        message: parseError.message
                    });
                }
            });
        });
        
        request.on('error', (error) => {
            console.error(`❌ DevTools代理失败:`, error.message);
            res.status(500).json({
                success: false,
                error: 'DevTools代理失败',
                message: error.message
            });
        });
        
        request.end();
    } catch (error) {
        console.error(`❌ DevTools代理失败:`, error.message);
        res.status(500).json({
            success: false,
            error: 'DevTools代理失败',
            message: error.message
        });
    }
});

app.get('/api/devtools/:debugPort/json/version', async (req, res) => {
    try {
        const { debugPort } = req.params;
        const http = require('http');
        
        console.log(`🔧 DevTools代理请求: localhost:${debugPort}/json/version`);
        
        const options = {
            hostname: 'localhost',
            port: debugPort,
            path: '/json/version',
            method: 'GET'
        };
        
        const request = http.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => {
                data += chunk;
            });
            response.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    res.json(jsonData);
                } catch (parseError) {
                    console.error('❌ JSON解析失败:', parseError.message);
                    res.status(500).json({
                        success: false,
                        error: 'JSON解析失败',
                        message: parseError.message
                    });
                }
            });
        });
        
        request.on('error', (error) => {
            console.error(`❌ DevTools代理失败:`, error.message);
            res.status(500).json({
                success: false,
                error: 'DevTools代理失败',
                message: error.message
            });
        });
        
        request.end();
    } catch (error) {
        console.error(`❌ DevTools代理失败:`, error.message);
        res.status(500).json({
            success: false,
            error: 'DevTools代理失败',
            message: error.message
        });
    }
});

// 🔧 DevTools WebSocket代理 - 用于Runtime.evaluate等操作
app.post('/api/devtools/:debugPort/runtime/evaluate', async (req, res) => {
    try {
        const { debugPort } = req.params;
        const { expression, awaitPromise = false, returnByValue = true, targetUrlContains = '', targetType = '' } = req.body;
        const WebSocket = require('ws');
        
        console.log(`🔧 DevTools Runtime.evaluate代理: localhost:${debugPort}`);
        
        // 首先获取可用的targets
        const http = require('http');
        const targets = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'localhost',
                port: debugPort,
                path: `/json/list?t=${Date.now()}`,
                method: 'GET'
            };
            
            const request = http.request(options, (response) => {
                let data = '';
                response.on('data', (chunk) => {
                    data += chunk;
                });
                response.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve(jsonData);
                    } catch (parseError) {
                        reject(parseError);
                    }
                });
            });
            
            request.on('error', (error) => {
                reject(error);
            });
            
            request.end();
        });
        
        if (!Array.isArray(targets) || targets.length === 0) {
            throw new Error('未找到可用的调试页面');
        }
        
        let candidates = targets.filter(item => item.webSocketDebuggerUrl);
        if (targetType) {
            candidates = candidates.filter(item => String(item.type || '').toLowerCase() === String(targetType).toLowerCase());
        }
        if (targetUrlContains) {
            candidates = candidates.filter(item => String(item.url || '').includes(String(targetUrlContains)));
        }
        if (!candidates.length) {
            candidates = targets.filter(item => item.type === 'page' && item.url && !String(item.url).startsWith('devtools://') && !String(item.url).startsWith('chrome-extension://'));
        }
        const target = candidates[0];
        
        if (!target || !target.webSocketDebuggerUrl) {
            throw new Error('调试目标缺少 WebSocket 地址');
        }
        
        // 通过WebSocket执行Runtime.evaluate
        const result = await new Promise((resolve, reject) => {
            let settled = false;
            let evalMessageId = null;
            let messageId = 1;
            const socket = new WebSocket(target.webSocketDebuggerUrl);
            
            const cleanup = () => {
                if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                    socket.close();
                }
            };
            
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(new Error('Runtime.evaluate 超时'));
                }
            }, 8000);
            
            socket.onopen = () => {
                socket.send(JSON.stringify({ id: messageId++, method: 'Runtime.enable' }));
                evalMessageId = messageId++;
                socket.send(JSON.stringify({
                    id: evalMessageId,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: expression,
                        awaitPromise: awaitPromise,
                        returnByValue: returnByValue
                    }
                }));
            };
            
            socket.onmessage = event => {
                if (settled) return;
                
                try {
                    const data = JSON.parse(event.data);
                    if (data.id === evalMessageId) {
                        settled = true;
                        clearTimeout(timeout);
                        cleanup();
                        
                        if (data.error) {
                            reject(new Error(data.error.message || 'Runtime.evaluate 执行失败'));
                            return;
                        }
                        
                        resolve(data.result);
                    }
                } catch (parseError) {
                    console.warn('⚠️ WebSocket消息解析失败:', parseError.message);
                }
            };
            
            socket.onerror = error => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    cleanup();
                    reject(new Error(`WebSocket连接失败: ${error.message}`));
                }
            };
            
            socket.onclose = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(new Error('WebSocket连接意外关闭'));
                }
            };
        });
        
        res.json({
            success: true,
            result: result
        });
        
    } catch (error) {
        console.error(`❌ DevTools Runtime.evaluate代理失败:`, error.message);
        res.status(500).json({
            success: false,
            error: 'DevTools Runtime.evaluate代理失败',
            message: error.message
        });
    }
});

// ⚠️ 错误处理中间件
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

// 🕐 定期清理任务：回收空闲实例和内存
setInterval(async () => {
    try {
        await browserManager.cleanupIdleInstances();
        
        // 内存使用检查
        const memUsage = process.memoryUsage();
        const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        
        if (memMB > 500) {
            log('WARN', `⚠️ 内存使用较高: ${memMB}MB`);
        }
    } catch (error) {
        log('ERROR', `❌ 定期清理任务失败: ${error.message}`);
    }
}, MEMORY_CLEANUP_INTERVAL);

// ✅ 启动浏览器预热器
setTimeout(() => {
    browserPrewarmer.start().catch(e => log('WARN', `🔥 预热器启动失败: ${e.message}`));
}, 2000);

console.log('✅ 浏览器自动清理与预热已启用');

// 🛡️ 优雅关闭处理
process.on('SIGINT', async () => {
    console.log('\n🔄 正在优雅关闭 Puppeteer 服务...');
    
    try {
        // 关闭所有浏览器实例
        console.log('🗑️ 正在关闭所有浏览器实例...');
        await browserManager.cleanup();
        
        // 清理活跃浏览器
        for (const [profileId, browserData] of activeBrowsers) {
            try {
                if (browserData.context && browserData.context.browser()) {
                    await browserData.context.close();
                }
            } catch (error) {
                console.warn(`⚠️ 关闭浏览器失败 ${profileId}:`, error.message);
            }
        }
        
        activeBrowsers.clear();
        
        console.log('✅ 资源清理完成');
        console.log('👋 Puppeteer 服务已关闭');
        
    } catch (error) {
        console.error('❌ 关闭过程中出现错误:', error);
    }
    
    process.exit(0);
});

// 🍪 Cookie 标准化函数：将任意格式的 cookie 统一转换为 Puppeteer/Chrome DevTools 标准小写格式
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
    const rawExpires = raw.expires ?? raw.Expires ?? raw.EXPIRES ?? raw.expiry ?? raw.Expiry ?? raw.EXPIRY;
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
        const s = String(rawSameSite);
        if (s === '-1' || s.toLowerCase() === 'unspecified') sameSite = 'Unspecified';
        else if (s === '0' || s.toLowerCase() === 'none') sameSite = 'None';
        else if (s === '1' || s.toLowerCase() === 'lax') sameSite = 'Lax';
        else if (s === '2' || s.toLowerCase() === 'strict') sameSite = 'Strict';
        else sameSite = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
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
        domain: String(domain),
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

    const cookieDbPath = path.join(userDataDir, 'Default', 'Cookies');
    const networkDir = path.join(userDataDir, 'Default', 'Network');
    
    try {
        // 确保目录存在
        await fs.mkdir(path.join(userDataDir, 'Default'), { recursive: true });
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
                        const hostKey = c.domain || '.example.com';
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

// 🚀 启动优化后的服务器
let server;

// 检查是否启用 HTTPS
const ENABLE_HTTPS = process.env.ENABLE_HTTPS === 'true';

// 🚀 资源清理函数：每 2 分钟清理僵尸浏览器实例
function startResourceCleanup() {
    setInterval(() => {
        let cleaned = 0;
        for (const [pid, data] of activeBrowsers) {
            try {
                if (!data || !data.context || !data.context.browser || !data.context.browser()) {
                    activeBrowsers.delete(pid);
                    cleaned++;
                } else {
                    const pages = data.context.pages();
                    if (pages.length === 0 && (Date.now() - (data.startTime || Date.now())) > 300000) {
                        data.context.close().catch(() => {});
                        activeBrowsers.delete(pid);
                        cleaned++;
                    }
                }
            } catch {
                activeBrowsers.delete(pid);
                cleaned++;
            }
        }
        if (cleaned > 0) log('INFO', `🧹 自动清理 ${cleaned} 个僵尸浏览器实例`);
        try { if (global.gc) global.gc(); } catch {}
    }, 120000);
}
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

if (ENABLE_HTTPS) {
    try {
        // 读取 SSL 证书
        const privateKey = fsSync.readFileSync(path.join(__dirname, 'puppeteer-key.pem'), 'utf8');
        const certificate = fsSync.readFileSync(path.join(__dirname, 'puppeteer-cert.pem'), 'utf8');
        
        const credentials = { key: privateKey, cert: certificate };
        
        // 创建 HTTPS 服务器
        server = https.createServer(credentials, app);
        server.listen(EFFECTIVE_HTTPS_PORT, '0.0.0.0', () => {
            const actualPort = (server && typeof server.address === 'function' && server.address()) ? server.address().port : EFFECTIVE_HTTPS_PORT;
            log('INFO', `🎭 Playwright HTTPS 服务已启动在端口 ${actualPort}`);
            log('INFO', `📊 健康检查: http://localhost:${actualPort}/health`);
            log('INFO', `🌐 启动浏览器: http://localhost:${actualPort}/api/launch-browser`);
            log('INFO', `📈 性能监控: http://localhost:${actualPort}/api/stats`);
            log('INFO', `🎯 日志级别: ${process.env.LOG_LEVEL || 'INFO'}`);
            log('INFO', `🔒 HTTPS 模式已启用`);
            
            // 🚀 启动定时资源清理（每 2 分钟清理僵尸浏览器）
            startResourceCleanup();
            
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
            log('INFO', `🎭 Playwright HTTP 服务已启动在端口 ${actualPort}`);
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
        log('INFO', `🎭 Playwright HTTP 服务已启动在端口 ${actualPort}`);
        log('INFO', `📊 健康检查: http://localhost:${actualPort}/health`);
        log('INFO', `🌐 启动浏览器: http://localhost:${actualPort}/api/launch-browser`);
        log('INFO', `📈 性能监控: http://localhost:${actualPort}/api/stats`);
        log('INFO', `🎯 日志级别: ${process.env.LOG_LEVEL || 'INFO'}`);
        
        // 🚀 启动定时资源清理（每 2 分钟清理僵尸浏览器）
        startResourceCleanup();
        
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
// 启动/关闭广告账户（占位：返回成功）
app.post('/api/facebook/adaccounts/account/start', async (req, res) => {
  try {
    const { profileId, adAccountId } = req.body || {}
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
    return res.json({ success: true, op: 'start' })
  } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
})
app.post('/api/facebook/adaccounts/account/stop', async (req, res) => {
  try {
    const { profileId, adAccountId } = req.body || {}
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
    return res.json({ success: true, op: 'stop' })
  } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
})

// 创建BM（占位：返回成功）
app.post('/api/facebook/business/create', async (req, res) => {
  try {
    const { profileId, name, email } = req.body || {}
    if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' })
    return res.json({ success: true, name: String(name || ''), email: String(email || '') })
  } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
})
async function syncCookiesToStorage(profileId, cookies, authToken) {
    try {
        const sbase = String(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
        const url = `${sbase}/api/fb-api/sync-cookies`;
        
        // 🚀 核心拦截逻辑：严禁同步空数据或无效数据
        if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
            log('WARN', `[Sync] 拒绝同步: Cookie 列表为空 (profileId=${profileId})`);
            return;
        }

        // 🚀 关键校验：必须包含 Facebook 登录的核心字段，否则视为“未登录态”或“中间态”
        const hasSession = cookies.some(c => c.name === 'c_user') && cookies.some(c => c.name === 'xs');
        if (!hasSession) {
            log('WARN', `[Sync] 拒绝同步: 缺少核心登录字段 c_user/xs，防止覆盖正常登录态 (profileId=${profileId}, count=${cookies.length})`);
            return;
        }

        // 🚀 强制转为字符串，确保 JSON 结构标准
        const body = { 
            profileId: String(profileId), 
            cookies: cookies 
        };
        
        try { log('INFO', `🔧 准备推送有效Cookie: profileId=${body.profileId} count=${body.cookies.length} to ${url}`); } catch {}

        const postWithRetry = async (u, payload, max = 3) => {
            let attempt = 0; let lastErr = null;
            const jsonString = JSON.stringify(payload);
            const urlObj = new URL(u);
            
            while (attempt < max) {
                attempt++;
                try {
                    log('DEBUG', `📡 [Attempt ${attempt}/${max}] Sending POST to ${u}`);
                    
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
                        
                        // 🔐 关键：添加 API Secret 用于云端验证
                        headers['X-Api-Secret'] = API_SECRET;

                        const options = {
                            hostname: urlObj.hostname,
                            port: urlObj.port || (isHttps ? 443 : 80),
                            path: urlObj.pathname,
                            method: 'POST',
                            headers: headers,
                            timeout: 15000
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
                    log('WARN', `Attempt ${attempt} failed: ${e.message}`);
                }
                if (attempt < max) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
            throw lastErr;
        };

        const result = await postWithRetry(url, body, 3);
        log('INFO', `✅ 同步成功: profileId=${profileId} server_resp=${JSON.stringify(result)}`);
    } catch (e) {
        log('ERROR', `❌ 同步Cookie最终失败: ${String(e.message || e)}`);
    }
}

function attachCookieSync(page, profileId) {
    if (!page || !profileId) return;
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

                const cookies = await page.context().cookies().catch(() => []);
                if (!cookies || cookies.length === 0) return;

                const key = makeKey(cookies);
                if (key && key !== lastKey) {
                    // 节流：3秒内最多同步一次
                    if (now - lastSyncTs < 3000) return;
                    
                    lastKey = key;
                    lastSyncTs = now;
                    const filtered = filterCookies(cookies);
                    
                    if (filtered.length > 0) {
                        try {
                            const names = filtered.slice(0, 5).map(c => `${c.name}@${c.domain}`).join(', ');
                            log('INFO', `📥 [Sync] profileId=${profileId} 发现Cookie变化: count=${filtered.length} preview=${names}...`);
                        } catch {}
                        
                        const browserData = activeBrowsers.get(profileId);
                        const authToken = browserData ? browserData.authToken : null;
                        await syncCookiesToStorage(profileId, filtered, authToken);
                    }
                }
            } catch (e) { 
                // 忽略页面关闭导致的错误
                if (!String(e.message).includes('Target closed')) {
                    log('DEBUG', `Cookie同步轮询失败 (${profileId}): ${e.message}`); 
                }
            }
        };

        page.on('response', doSync);
        page.on('domcontentloaded', doSync);
        page.on('framenavigated', doSync);
        
        const timer = setInterval(doSync, 5000);
        page.on('close', () => { 
            try { clearInterval(timer); } catch {} 
            log('DEBUG', `🧷 已卸载Cookie实时同步: profileId=${profileId}`);
        });
        
        try { log('INFO', `🧷 已安装Cookie实时同步: profileId=${profileId}`); } catch {}
    } catch (e) { log('ERROR', `❌ 安装Cookie实时同步失败: ${e.message}`); }
}
async function getCookiesFromStorage(profileId) {
    let url = '';
    try {
        const sbase = String(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
        url = `${sbase}/api/profiles/${encodeURIComponent(profileId)}/cookies`;
        const controller = new AbortController();
        const timer = setTimeout(() => { try { controller.abort(); } catch {} }, 5000);
        const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
        clearTimeout(timer);
        const j = await r.json().catch(()=>({}));
        const raw = j && j.cookies;
        if (!raw) return [];
        if (typeof raw === 'string') {
            try { return parseCookieString(raw, []); } catch { return []; }
        }
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        try { log('WARN', `⚠️ getCookiesFromStorage 失败 (${url}): ${String(e && e.message || e)}`); } catch {}
        return [];
    }
}

// 验证卡片自动化流程
app.post('/api/facebook/verify-card', async (req, res) => {
    try {
        const { profileId, targetUrl } = req.body || {};
        if (!profileId || !targetUrl) return res.status(400).json({ success: false, message: 'Missing profileId or targetUrl' });

        log('INFO', `🚀 Starting Verify Card for ${profileId} -> ${targetUrl}`);

        let browser;
        let browserData = activeBrowsers.get(String(profileId));

        if ((browserData && browserData.context && browserData.context.browser())) {
             browser = browserData.context;
             log('INFO', `✅ Reusing existing browser for ${profileId}`);
        } else {
             // Try to launch if not open
             try {
                const profile = await findProfileById(profileId);
                if (!profile) throw new Error('Profile not found');
                
                let proxyConfig = null;
                try {
                    if (profile.proxy) {
                        const p = typeof profile.proxy === 'string' ? JSON.parse(profile.proxy) : profile.proxy;
                        if (p.host && p.port) proxyConfig = { host: p.host, port: p.port, username: p.username, password: p.password };
                    }
                } catch {}

                // Basic config to launch
                const config = {
                    profileId,
                    browserType: (process.env.BROWSER_TYPE || 'chrome').toLowerCase(),
                    userAgent: profile.user_agent || undefined,
                    proxy: proxyConfig,
                    windowTitle: profile.name || profileId,
                    debugPort: 0, // Random
                    emailPrefix: extractEmailPrefix(profile.account_email || '')
                };
                
                const instance = await browserManager.getBrowser(config);
                browser = instance.context;
                
                // Add to activeBrowsers
                activeBrowsers.set(String(profileId), {
                    browser,
                    profileId,
                    startTime: Date.now(),
                    proxy: proxyConfig,
                    userAgent: config.userAgent
                });
             } catch (e) {
                 return res.status(500).json({ success: false, message: 'Failed to launch browser: ' + e.message });
             }
        }

        const page = await browser.newPage();
        try {
            // 🍪 Inject Cookies before navigation
            try {
                log('INFO', `🍪 Fetching cookies for profile ${profileId}...`);
                const cookies = await getCookiesFromStorage(profileId);
                
                if (Array.isArray(cookies) && cookies.length > 0) {
                    log('INFO', `🍪 Injecting ${cookies.length} cookies...`);
                    
                    // First navigate to a blank page on the target domain to set context
                    try {
                        const targetUrlObj = new URL(targetUrl);
                        const blankUrl = `${targetUrlObj.protocol}//${targetUrlObj.host}/`;
                        await page.goto(blankUrl, { waitUntil: 'networkidle', timeout: 10000 });
                    } catch (e) {
                        log('WARN', `⚠️ Failed to navigate to blank page context: ${e.message}`);
                    }

                    const cdpCookies = cookies.map(c => ({
                        name: c.name,
                        value: c.value,
                        domain: c.domain,
                        path: c.path || '/',
                        secure: c.secure || false,
                        httpOnly: c.httpOnly || false,
                        sameSite: c.sameSite || 'Lax',
                        expires: c.expiry || (c.expires ? Math.floor(new Date(c.expires).getTime() / 1000) : Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60)
                    }));

                    await page.context().addCookies(cdpCookies);
                    log('INFO', `✅ Cookies injected successfully`);
                } else {
                    log('WARN', `⚠️ No cookies found for profile ${profileId}`);
                }
            } catch (cookieError) {
                log('WARN', `⚠️ Cookie injection failed: ${cookieError.message}`);
            }

            await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
            
            log('INFO', 'Waiting for wizard content...');
            // Try to find common verification buttons
            // "Next", "Start", "Verify", "Confirm"
            // The wizard is "RESOLVE_SDC_FRICTION"
            
            try { await page.waitForNetworkIdle({ timeout: 5000 }); } catch {}
            // Wait longer for dialog to fully render (User Request: 5 seconds)
            await new Promise(r => setTimeout(r, 5000));

            // 🔍 Scrape Card Digits (Phase 1)
            let cardDigits = await page.evaluate(() => {
                const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
                const visibleDialog = dialogs.find(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                }) || document.body;
                
                const text = visibleDialog.innerText || visibleDialog.textContent || '';
                // Matches "MasterCard .... 2564" or "Visa •••• 1234"
                const m = text.match(/(?:Visa|MasterCard|Master\s*Card|Amex|American\s*Express).*?(?:\.{2,}|•{2,}|\*{2,}|[\s\.]+)(\d{4})/i);
                return m ? m[1] : null;
            });

            if (cardDigits) log('INFO', `💳 Detected Card ending in: ${cardDigits}`);

            let codeFilled = false;

            // 🔄 Main Automation Loop (Click -> Wait Input -> Fetch Code -> Fill -> Submit)
            log('INFO', '🔄 Starting automation loop (30 attempts)...');
            
            for(let i=0; i<30; i++) {
                // 1. Check if input field exists (Phase 2)
                const inputSelector = 'input[type="text"], input[type="number"], input[placeholder*="code" i], input[name="code"]';
                const needsCode = await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    return el && el.offsetParent !== null; // Visible
                }, inputSelector);

                // 2. If needs code and we have digits, fetch code (Phase 3)
                if (needsCode && cardDigits && !codeFilled) {
                    log('INFO', `⌨️ Input detected, checking transactions for card *${cardDigits}...`);
                    try {
                        // Use external Transaction DB API as requested
                        // 🌐 线上后端统一走 STORAGE_SERVER_URL（宝塔），不再硬编码 Pages 域名
                        const dbApiUrl = `${(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '')}/api/adpos/transactions/list?last4=${cardDigits}&per_page=50`;
                        const dbResp = await fetch(dbApiUrl).catch(e => ({ ok: false, message: e.message }));
                        const txRes = dbResp.ok ? await dbResp.json() : null;
                        
                        if (txRes && txRes.data && Array.isArray(txRes.data)) {
                            const txList = txRes.data;
                            log('INFO', `📊 Fetched ${txList.length} transactions from DB API (${dbApiUrl}).`);

                            // Filter for matching card (double check)
                            const cardTxs = txList.filter(t => {
                                const cNum = String(t.card_number || t.last_four_digits || t.card_last_4 || '');
                                return cNum.endsWith(cardDigits);
                            });

                            if (cardTxs.length > 0) {
                                // Log the latest transaction description for debugging
                                const latest = cardTxs[0];
                                const latestDesc = (latest.merchant_name || latest.description || latest.merchant || '').replace(/\n/g, ' ');
                                log('INFO', `🔎 Latest tx for card: "${latestDesc}" | Amount: ${latest.billing_amount} ${latest.billing_currency}`);

                                // Find Meta/Facebook transaction with code
                                const targetTx = cardTxs.find(t => {
                                    const desc = (t.merchant_name || t.description || t.merchant || '').toLowerCase();
                                    return /meta|facebk|facebook|ads|bill|matapay/.test(desc);
                                });

                                if (targetTx) {
                                    const desc = targetTx.merchant_name || targetTx.description || targetTx.merchant || '';
                                    // Match "METAPAY*ABCD" (4 mixed alphanumeric) or "FACEBK*1234"
                                    // User confirmed format: "METAPAY*OI4K" (4 chars after *)
                                    // Also supports: "FACEBK*1234", "CODE 1234"
                                    const m = desc.match(/(?:METAPAY|MATAPAY|FACEBK|FACEBOOK|CODE)[\*\s:]*([A-Z0-9]{4})/i) || desc.match(/[\*\s]([A-Z0-9]{4})[\s$]/i);
                                    
                                    if (m) {
                                        const code = m[1];
                                        // Avoid capturing the card last 4 digits if they appear in desc (unlikely for code)
                                        if (code === cardDigits) {
                                            log('WARN', `⚠️ Found 4 chars "${code}" but it matches card number, ignoring...`);
                                        } else {
                                            log('INFO', `✅ Found verification code: ${code} from "${desc}"`);
                                            
                                            await page.type(inputSelector, code);
                                            codeFilled = true;
                                            log('INFO', '✍️ Code entered into input field');
                                            await new Promise(r => setTimeout(r, 1000)); 
                                        }
                                    } else {
                                        log('INFO', `⏳ Found Meta transaction but couldn't extract 4-digit code: "${desc}"`);
                                    }
                                } else {
                                    log('INFO', '⏳ Transactions found for card, but none match "Meta/Facebook/Matapay"...');
                                }
                            } else {
                                log('INFO', `⏳ No transactions found for card ending in ${cardDigits} yet...`);
                            }
                        } else {
                            log('WARN', `⚠️ AdPos response invalid: ${JSON.stringify(txRes).slice(0, 100)}`);
                        }
                    } catch (e) {
                        log('WARN', `⚠️ Failed to fetch transactions: ${e.message}`);
                    }
                }

                // 3. Auto-click logic (Phase 1 & 4)
                // Enhanced polling, global language support, and visual detection (Blue Button in Dialog)
                // Only click if we are NOT waiting for a code (i.e., if input is visible but code not filled, don't click submit yet)
                if (needsCode && !codeFilled) {
                    log('INFO', '⏳ Waiting for verification code before clicking submit...');
                } else {
                    const clicked = await page.evaluate(async () => {
                        const keywords = [
                            'next', 'continue', 'start', 'verify', 'confirm', 'submit', 'send',
                            '下一步', '继续', '開始', '验证', '确认', '提交', '發送', '繼續', '驗證', '確認',
                            'siguiente', 'continuar', 'empezar', 'verificar', 'confirmar', 'enviar',
                            'avançar', 'continuar', 'começar', 'verificar', 'confirmar', 'enviar',
                            'suivant', 'continuer', 'commencer', 'vérifier', 'confirmer', 'envoyer',
                            'weiter', 'fortfahren', 'starten', 'überprüfen', 'bestätigen', 'senden',
                            'далее', 'продолжить', 'начать', 'подтвердить', 'отправить',
                            '次へ', '続行', '開始', '確認', '送信', '認証',
                            '다음', '계속', '시작', '확인', '제출', '인증',
                            'lanjut', 'teruskan', 'mulai', 'verifikasi', 'konfirmasi', 'kirim',
                            'tiếp', 'tiếp tục', 'bắt đầu', 'xác minh', 'xác nhận', 'gửi',
                            'ถัดไป', 'ดำเนินการต่อ', 'เริ่ม', 'ยืนยัน', 'ส่ง', 'ตรวจสอบ',
                            'ileri', 'devam', 'başla', 'doğrula', 'onayla', 'gönder',
                            'avanti', 'continua', 'inizia', 'verifica', 'conferma', 'invia',
                            'التالي', 'متابعة', 'ابدأ', 'تأكيد', 'إرسال', 'تحقق'
                        ];
                        
                        const logs = [];
                        const log = (msg) => logs.push(`[AutoClick] ${msg}`);
                        
                        const isVisible = (el) => {
                            const rect = el.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0;
                        };
        
                        const isBlueButton = (el) => {
                            const style = window.getComputedStyle(el);
                            const bg = style.backgroundColor;
                            const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                            if (m) {
                                const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
                                return (b > r + 50) && (b > g + 10);
                            }
                            return false;
                        };

                        // 1. Prioritize finding a Dialog
                        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
                        const visibleDialogs = dialogs.filter(isVisible);
                        let targetBtn = null;

                        // Strategy A: Search inside visible dialogs
                        for (const dialog of visibleDialogs) {
                            const buttons = Array.from(dialog.querySelectorAll('div[role="button"], button, a[role="button"], span[role="button"], div[class*="button"], div[class*="btn"]'));
                            
                            // A1. Look for BLUE buttons inside dialog
                            const blueButtons = buttons.filter(b => isVisible(b) && isBlueButton(b));
                            if (blueButtons.length > 0) {
                                // Prioritize keyword match if multiple
                                const blueKeywordButtons = blueButtons.filter(b => {
                                    const text = (b.innerText || b.textContent || '').toLowerCase().trim();
                                    return keywords.some(k => text.includes(k));
                                });
                                targetBtn = blueKeywordButtons.length > 0 ? blueKeywordButtons[0] : blueButtons[0];
                                log(`✅ Found BLUE button in dialog: "${targetBtn.innerText}"`);
                                break;
                            }

                            // A2. Keyword match
                            const keywordButtons = buttons.filter(b => {
                                if (!isVisible(b)) return false;
                                const text = (b.innerText || b.textContent || '').toLowerCase().trim();
                                return keywords.some(k => text.includes(k));
                            });
                            if (keywordButtons.length > 0) {
                                targetBtn = keywordButtons[0];
                                log(`✅ Found keyword button in dialog: "${targetBtn.innerText}"`);
                                break;
                            }
                        }

                        // Strategy B: Global Blue Button
                        if (!targetBtn) {
                            const allButtons = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"], span[role="button"], div[class*="button"], div[class*="btn"]'));
                            const blueButtons = allButtons.filter(b => isVisible(b) && isBlueButton(b));
                            const blueKeywordButtons = blueButtons.filter(b => {
                                const text = (b.innerText || b.textContent || '').toLowerCase().trim();
                                return keywords.some(k => text.includes(k));
                            });
                            
                            if (blueKeywordButtons.length > 0) {
                                targetBtn = blueKeywordButtons[0];
                                log(`✅ Found global BLUE keyword button: "${targetBtn.innerText}"`);
                            } else if (blueButtons.length > 0 && blueButtons.length <= 2) {
                                 targetBtn = blueButtons[0];
                                 log(`✅ Found single global BLUE button: "${targetBtn.innerText}"`);
                            }
                        }

                        // Strategy C: Global Keyword
                        if (!targetBtn) {
                            const allButtons = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"], span[role="button"], div[class*="button"], div[class*="btn"]'));
                            for (const gBtn of allButtons) {
                                const text = (gBtn.innerText || gBtn.textContent || '').toLowerCase().trim();
                                if (keywords.some(k => text.includes(k)) && isVisible(gBtn)) {
                                    targetBtn = gBtn;
                                    log(`✅ Found global keyword button: "${text}"`);
                                    break;
                                }
                            }
                        }
                        
                        if (targetBtn) {
                            targetBtn.click();
                            return { success: true, text: targetBtn.innerText, logs };
                        }
                        
                        return { success: false, logs };
                    });

                    if (clicked.logs && clicked.logs.length) clicked.logs.forEach(l => log('INFO', l));
                    if (clicked.success) log('INFO', `✅ Clicked: ${clicked.text}`);
                }
                
                await new Promise(r => setTimeout(r, 3000));
            }

            return res.json({ success: true, message: 'Browser launched and navigated' });

        } catch (e) {
            log('ERROR', `Navigation failed: ${e.message}`);
            return res.status(500).json({ success: false, message: e.message });
        }
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});
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

// 本地读取广告账户（用于前端回退）
app.get('/api/local/adaccounts', async (req, res) => {
    try {
        const sdb = new sqlite3.Database(dbPath);
        await ensureAdAccountsTable(sdb);
        await ensureAdAccountsColumns(sdb);
        const rows = await new Promise((resolve, reject) => {
            sdb.all(`SELECT id, profile_id AS profileId, platform, account_id AS account_id, name, status, currency, timezone_id, spend, country, threshold_amount, credit_limit, balance, funding_source, pages_count, bm_count, pixels_count, account, profile_name FROM ad_accounts ORDER BY updated_at DESC`, (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
        sdb.close();
        return res.json({ success: true, data: rows });
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});
