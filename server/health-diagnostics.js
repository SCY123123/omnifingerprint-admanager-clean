'use strict';

// ============================================================
// 🔍 健康检查与诊断端点
// ============================================================

// 📋 注入的依赖
let _log = () => {};
let _activeBrowsers = new Map();
let _browserManager = null;
let _launchQueueManager = null;
// 借用型浏览器回收状态（由主文件注入）：用于排查"浏览器该关没关"
let _borrowedBrowserStats = () => ({});
let _getLaunchCount = () => 0;
let _getSuccessCount = () => 0;
let _getErrorCount = () => 0;
let _getTotalLaunchTime = () => 0;
let _S5_TUNNEL_HOST = process.env.S5_TUNNEL_HOST || '127.0.0.1';
let _S5_TUNNEL_PORT = parseInt(process.env.S5_TUNNEL_PORT || '10808', 10);
let _S5_TUNNEL_TYPE = (process.env.S5_TUNNEL_TYPE || 'socks5').toLowerCase();
let _socksChainServer = null;
let _proxyTunnel = null;

/**
 * 注入主文件的依赖到健康检查模块
 */
function __inject(deps) {
    if (deps.log) _log = deps.log;
    if (deps.activeBrowsers) _activeBrowsers = deps.activeBrowsers;
    if (deps.browserManager) _browserManager = deps.browserManager;
    if (deps.launchQueueManager) _launchQueueManager = deps.launchQueueManager;
    if (deps.borrowedBrowserStats) _borrowedBrowserStats = deps.borrowedBrowserStats;
    if (deps.getLaunchCount) _getLaunchCount = deps.getLaunchCount;
    if (deps.getSuccessCount) _getSuccessCount = deps.getSuccessCount;
    if (deps.getErrorCount) _getErrorCount = deps.getErrorCount;
    if (deps.getTotalLaunchTime) _getTotalLaunchTime = deps.getTotalLaunchTime;
    if (deps.S5_TUNNEL_HOST !== undefined) _S5_TUNNEL_HOST = deps.S5_TUNNEL_HOST;
    if (deps.S5_TUNNEL_PORT !== undefined) _S5_TUNNEL_PORT = deps.S5_TUNNEL_PORT;
    if (deps.S5_TUNNEL_TYPE !== undefined) _S5_TUNNEL_TYPE = deps.S5_TUNNEL_TYPE;
    if (deps.socksChainServer) _socksChainServer = deps.socksChainServer;
    if (deps.proxyTunnel) _proxyTunnel = deps.proxyTunnel;
}

/**
 * 注册所有健康检查和诊断路由
 */
function registerRoutes(app) {
    if (!app) return;

    // 🩺 API健康检查端点
    app.get('/api/health', (req, res) => {
        const memUsage = process.memoryUsage();

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            service: 'AdsPlus Go Puppeteer Service',
            version: '1.1.0',
            performance: {
                activeBrowsers: _activeBrowsers.size,
                browserInstances: _browserManager.getStats(),
                launchQueue: _launchQueueManager.getStats(),
                memory: {
                    used: Math.round(memUsage.heapUsed / 1024 / 1024),
                    total: Math.round(memUsage.heapTotal / 1024 / 1024),
                    external: Math.round(memUsage.external / 1024 / 1024)
                },
                stats: {
                    launches: _getLaunchCount(),
                    successes: _getSuccessCount(),
                    errors: _getErrorCount(),
                    avgLaunchTime: _getLaunchCount() > 0 ? Math.round(_getTotalLaunchTime() / _getLaunchCount()) : 0
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

    // 🌐 代理诊断页面 — 浏览器首标签页，检测代理连通性和浏览器配置
    app.get('/api/proxy-diagnostics', (req, res) => {
        const host = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const info = {
            browser: 'Google Chrome (Puppeteer)',
            localIP: host,
            userAgent: req.headers['user-agent'] || 'N/A',
            serverTime: new Date().toISOString(),
            proxyType: req.query.proxyType || 'N/A',
            proxyHost: req.query.proxyHost || 'N/A',
            proxyPort: req.query.proxyPort || 'N/A',
            profileId: req.query.profileId || 'N/A',
        };
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(buildDiagnosticsHtml(info));
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

            await _browserManager.cleanupDuplicateDirectories(profileId);

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

    // 🚀 动态配置端点 — 前端系统设置页面可以调用
    app.post('/api/config', (req, res) => {
        try {
            const { maxConcurrentLaunches, s5TunnelHost, s5TunnelPort, s5TunnelType } = req.body || {};
            if (typeof maxConcurrentLaunches === 'number' || typeof maxConcurrentLaunches === 'string') {
                _launchQueueManager.setMaxConcurrent(maxConcurrentLaunches);
            }
            if (typeof s5TunnelHost === 'string' && s5TunnelHost.trim()) {
                _S5_TUNNEL_HOST = s5TunnelHost.trim();
                // 清除缓存的系统代理检测结果，下次 detectSystemProxy 将重新检测新地址
                _socksChainServer._systemProxy = null;
                _log('INFO', `🔌 S5 隧道主机已更新: ${_S5_TUNNEL_HOST}`);
            }
            if (typeof s5TunnelPort !== 'undefined' && s5TunnelPort !== null && s5TunnelPort !== '') {
                const port = parseInt(String(s5TunnelPort), 10);
                if (port > 0 && port <= 65535) {
                    _S5_TUNNEL_PORT = port;
                    _socksChainServer._systemProxy = null;
                    _log('INFO', `🔌 S5 隧道端口已更新: ${_S5_TUNNEL_PORT}`);
                }
            }
            if (typeof s5TunnelType === 'string') {
                const t = s5TunnelType.toLowerCase().trim();
                if (t === 'socks5' || t === 'http') {
                    _S5_TUNNEL_TYPE = t;
                    _socksChainServer._systemProxy = null;
                    _log('INFO', `🔌 S5 隧道类型已更新: ${_S5_TUNNEL_TYPE}`);
                }
            }
            // 将更新同步到 proxy-tunnel 模块
            _proxyTunnel.setS5TunnelConfig(_S5_TUNNEL_HOST, _S5_TUNNEL_PORT, _S5_TUNNEL_TYPE);
            res.json({ success: true, maxConcurrent: _launchQueueManager.maxConcurrent, s5TunnelHost: _S5_TUNNEL_HOST, s5TunnelPort: _S5_TUNNEL_PORT, s5TunnelType: _S5_TUNNEL_TYPE });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // 🔄 一键重置代理隧道 — 电脑休眠唤醒后代理隧道掉线无法恢复时使用
    // 作废系统代理缓存 + 踢掉所有隧道客户端连接，浏览器下次请求会自动重建隧道
    app.post('/api/proxy/reset', async (req, res) => {
        try {
            if (!_socksChainServer || typeof _socksChainServer.resetAll !== 'function') {
                return res.status(500).json({ success: false, error: '隧道管理器不可用' });
            }
            const reason = (req.body && req.body.reason) || '前端手动重置';
            const result = await _socksChainServer.resetAll(reason);
            _log('INFO', `🔄 代理隧道已通过 /api/proxy/reset 重置（${reason}）`);
            res.json({
                success: true,
                message: result.systemProxyReachable
                    ? '代理隧道已重置，系统代理可达'
                    : '代理隧道已重置，但系统代理当前不可达（请检查本机代理软件）',
                ...result,
                s5TunnelHost: _S5_TUNNEL_HOST,
                s5TunnelPort: _S5_TUNNEL_PORT,
                s5TunnelType: _S5_TUNNEL_TYPE,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // 📡 读取当前配置
    app.get('/api/config', (req, res) => {
        try {
            res.json({
                success: true,
                maxConcurrent: _launchQueueManager.maxConcurrent,
                s5TunnelHost: _S5_TUNNEL_HOST,
                s5TunnelPort: _S5_TUNNEL_PORT,
                s5TunnelType: _S5_TUNNEL_TYPE,
                activeTunnels: _socksChainServer && _socksChainServer._servers ? _socksChainServer._servers.size : 0,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // 📊 性能统计端点
    app.get('/api/stats', (req, res) => {
        res.json({
            success: true,
            data: {
                browserManager: _browserManager.getStats(),
                launchQueue: _launchQueueManager.getStats(),
                // 🪶 借用型浏览器状态：idleForMs 远超 idleMs 却还没被关 = 计数泄漏/定时器没触发
                borrowedBrowsers: _borrowedBrowserStats(),
                performance: {
                    launches: _getLaunchCount(),
                    successes: _getSuccessCount(),
                    errors: _getErrorCount(),
                    avgLaunchTime: _getLaunchCount() > 0 ? Math.round(_getTotalLaunchTime() / _getLaunchCount()) : 0
                },
                memory: process.memoryUsage(),
                uptime: process.uptime()
            }
        });
    });

    // 🔌 代理连通性测试端点 — 前端系统设置可调用，测试 HTTP / SOCKS5 代理是否正常
    app.post('/api/proxy/test', async (req, res) => {
        try {
            const { host, port, username, password, type } = req.body || {};
            if (!host || !port) return res.json({ success: false, error: '缺少 host 或 port' });

            const net = require('net');
            const results = [];

            // 1. TCP 连通性测试
            const tcpOk = await new Promise(r => {
                const s = new net.Socket();
                s.setTimeout(5000);
                s.connect(parseInt(port), host, () => { s.destroy(); r(true); });
                s.on('error', () => r(false));
                s.on('timeout', () => { s.destroy(); r(false); });
            });
            results.push({ test: 'TCP 连接', status: tcpOk ? 'pass' : 'fail', detail: tcpOk ? `${host}:${port} 可达` : '连接超时或拒绝' });
            if (!tcpOk) return res.json({ success: true, proxy: { host, port, type }, results });

            // 2. SOCKS5 协议测试
            const socksResult = await new Promise(async (resolve) => {
                try {
                    const s = new net.Socket();
                    s.setTimeout(8000);
                    s.connect(parseInt(port), host, () => {
                        // SOCKS5 握手：声明支持无认证(0x00)和用户密码(0x02)
                        s.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
                        s.once('data', (handshakeResp) => {
                            if (handshakeResp[0] !== 0x05) {
                                s.destroy();
                                resolve({ status: 'fail', detail: '非 SOCKS5 协议' });
                                return;
                            }
                            const method = handshakeResp[1];
                            if (method === 0x00) {
                                // 无认证 → 直接 CONNECT 测试
                                s.write(Buffer.concat([
                                    Buffer.from([0x05, 0x01, 0x00, 0x03, 10]),
                                    Buffer.from('api.ipify.org'),
                                    Buffer.from([0x01, 0xBB])
                                ]));
                                s.once('data', (connectResp) => {
                                    const ok = connectResp[1] === 0x00;
                                    s.destroy();
                                    resolve({ status: ok ? 'pass' : 'fail', detail: ok ? 'CONNECT 成功' : `CONNECT 失败 code=${connectResp[1]}` });
                                });
                            } else if (method === 0x02 && username && password) {
                                // 用户密码认证
                                const uBuf = Buffer.from(username, 'utf8');
                                const pBuf = Buffer.from(password, 'utf8');
                                const authReq = Buffer.concat([
                                    Buffer.from([0x01, uBuf.length]), uBuf,
                                    Buffer.from([pBuf.length]), pBuf
                                ]);
                                s.write(authReq);
                                s.once('data', (authResp) => {
                                    if (authResp[1] !== 0x00) {
                                        s.destroy();
                                        resolve({ status: 'fail', detail: '账号密码认证失败' });
                                        return;
                                    }
                                    // 认证成功 → CONNECT 测试
                                    s.write(Buffer.concat([
                                        Buffer.from([0x05, 0x01, 0x00, 0x03, 10]),
                                        Buffer.from('api.ipify.org'),
                                        Buffer.from([0x01, 0xBB])
                                    ]));
                                    s.once('data', (connectResp) => {
                                        const ok = connectResp[1] === 0x00;
                                        s.destroy();
                                        resolve({ status: ok ? 'pass' : 'fail', detail: ok ? '带认证 CONNECT 成功' : `带认证 CONNECT 失败 code=${connectResp[1]}` });
                                    });
                                });
                            } else {
                                s.destroy();
                                resolve({ status: 'fail', detail: '无可用的认证方法' });
                            }
                        });
                    });
                    s.on('error', () => resolve({ status: 'fail', detail: '连接异常' }));
                    s.on('timeout', () => { s.destroy(); resolve({ status: 'fail', detail: 'SOCKS5 握手超时' }); });
                } catch { resolve({ status: 'fail', detail: 'SOCKS5 测试异常' }); }
            });
            results.push({ test: 'SOCKS5 协议', status: socksResult.status, detail: socksResult.detail });

            // 3. HTTP CONNECT 测试（即使不是 HTTP 类型也试一下，判断代理是否双协议兼容）
            const httpResult = await new Promise(async (resolve) => {
                try {
                    const s = new net.Socket();
                    s.setTimeout(8000);
                    s.connect(parseInt(port), host, () => {
                        const auth = (username && password)
                            ? 'Proxy-Authorization: Basic ' + Buffer.from(`${username}:${password}`).toString('base64') + '\r\n'
                            : '';
                        const reqStr = `CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\n${auth}\r\n`;
                        s.write(Buffer.from(reqStr, 'ascii'));
                        s.once('data', (d) => {
                            const ok = d.toString('ascii').includes('200');
                            s.destroy();
                            resolve({ status: ok ? 'pass' : 'info', detail: ok ? 'HTTP CONNECT 成功 (双协议兼容)' : '不支持 HTTP CONNECT（纯 SOCKS5 代理属正常）' });
                        });
                    });
                    s.on('error', () => resolve({ status: 'info', detail: 'HTTP CONNECT 不可用' }));
                    s.on('timeout', () => { s.destroy(); resolve({ status: 'info', detail: 'HTTP CONNECT 超时' }); });
                } catch { resolve({ status: 'info', detail: 'HTTP CONNECT 测试异常' }); }
            });
            results.push({ test: 'HTTP CONNECT', status: httpResult.status, detail: httpResult.detail });

            res.json({ success: true, proxy: { host, port, type }, results, overall: results.every(r => r.status === 'pass') ? 'pass' : 'partial' });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // 🧹 清理资源端点
    app.post('/api/cleanup', async (req, res) => {
        try {
            console.log('🧹 开始清理资源...');

            // 清理空闲浏览器实例
            await _browserManager.cleanupIdleInstances();

            // 强制垃圾回收
            if (global.gc) {
                global.gc();
            }

            console.log('✅ 资源清理完成');

            res.json({
                success: true,
                message: '资源清理完成',
                timestamp: new Date().toISOString(),
                stats: _browserManager.getStats()
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
}

// ============================================================
// 🌐 生成诊断页 HTML
// ============================================================
function buildDiagnosticsHtml(info) {
  const defaultUrl = info.defaultCheckUrl || 'https://ip-api.com/json';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>代理诊断页面</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;display:flex;justify-content:center;padding:20px;min-height:100vh}
.container{max-width:800px;width:100%}
h1{color:#1a73e8;margin:20px 0;font-size:24px;text-align:center}
.card{background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1);padding:20px;margin-bottom:16px}
.card h2{font-size:16px;color:#333;margin-bottom:12px;border-bottom:2px solid #e8f0fe;padding-bottom:8px}
.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
.info-row:last-child{border-bottom:none}
.info-row .label{color:#666;flex-shrink:0}
.info-row .value{color:#1a1a1a;font-family:monospace;font-size:13px;word-break:break-all;text-align:right;max-width:60%}
.status-badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600}
.status-ok{background:#e6f4ea;color:#137333}
.status-err{background:#fce8e6;color:#c5221f}
.status-warn{background:#fef7e0;color:#b06000}
#ip-check{font-family:monospace;font-size:13px;line-height:1.6;margin-top:8px}
#ip-check .result{padding:8px;border-radius:6px;margin:4px 0}
.btn{background:#1a73e8;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;margin:8px 4px}
.btn:hover{background:#1557b0}
.btn-small{padding:4px 12px;font-size:12px;background:#e8f0fe;color:#1a73e8;border:1px solid #1a73e8}
.btn-small:hover{background:#d2e3fc}
.loading{color:#999;font-size:13px}.mt-8{margin-top:8px}
</style>
</head>
<body>
<div class="container">
<h1>🔍 代理诊断面板</h1>
<div class="card">
<h2>📋 浏览器配置</h2>
<div class="info-row"><span class="label">Profile ID</span><span class="value">${info.profileId}</span></div>
<div class="info-row"><span class="label">浏览器</span><span class="value">${info.browser}</span></div>
<div class="info-row"><span class="label">本地IP</span><span class="value" id="local-ip">${info.localIP}</span></div>
<div class="info-row"><span class="label">User-Agent</span><span class="value" title="${info.userAgent}">${(info.userAgent||'').substring(0,60)}...</span></div>
<div class="info-row"><span class="label">服务器时间</span><span class="value">${info.serverTime}</span></div>
</div>
<div class="card">
<h2>🌐 代理配置</h2>
<div class="info-row"><span class="label">代理类型</span><span class="value">${info.proxyType}</span></div>
<div class="info-row"><span class="label">代理地址</span><span class="value">${info.proxyHost}:${info.proxyPort}</span></div>
</div>
<div class="card">
<h2>🔄 IP 检测</h2>
<p style="color:#666;font-size:13px;margin-bottom:8px">点击按钮检测当前出口IP：</p>
<button class="btn" onclick="checkIP()">检测我的 IP</button>
<button class="btn btn-small" onclick="checkIP('https://httpbin.org/ip')">httpbin</button>
<button class="btn btn-small" onclick="checkIP('https://api.ipify.org?format=json')">ipify</button>
<button class="btn btn-small" onclick="checkIP('https://ip-api.com/json')">ip-api</button>
<div id="ip-check"></div>
</div>
<div class="card">
<h2>🔗 快速链接</h2>
<button class="btn btn-small" onclick="navigateTest('https://www.facebook.com/')">打开 Facebook</button>
<button class="btn btn-small" onclick="navigateTest('https://www.google.com/search?q=my+ip')">搜索 myip</button>
<button class="btn btn-small" onclick="navigateTest('https://fast.com')">测速 fast.com</button>
<button class="btn btn-small" onclick="window.location.reload()">刷新诊断页</button>
</div>
</div>
<script>
let detectedIp='';
async function checkIP(url){
url=url||'https://ip-api.com/json';
const el=document.getElementById('ip-check');
el.innerHTML='<div class="loading">⏳ 检测中...</div>';
try{
const resp=await fetch(url,{signal:AbortSignal.timeout(10000)});
const text=await resp.text();
let data;try{data=JSON.parse(text)}catch{data=text}
let html='<div class="result status-ok">✅ 成功</div>';
html+='<div class="info-row"><span class="label">原始响应</span><span class="value">'+JSON.stringify(data).substring(0,200)+'</span></div>';
let ip=data.query||data.ip||'';
if(ip){html+='<div class="info-row"><span class="label" style="font-weight:700;color:#1a73e8">出口IP</span><span class="value" style="font-weight:700;color:#1a73e8">'+ip+'</span></div>';
detectedIp=ip;document.getElementById('local-ip').textContent=ip;}
if(data.org)html+='<div class="info-row"><span class="label">运营商</span><span class="value">'+data.org+'</span></div>';
if(data.country)html+='<div class="info-row"><span class="label">国家</span><span class="value">'+data.country+(data.regionName?' - '+data.regionName:'')+'</span></div>';
if(data.isp)html+='<div class="info-row"><span class="label">运营商</span><span class="value">'+data.isp+'</span></div>';
el.innerHTML=html;
}catch(e){el.innerHTML='<div class="result status-err">❌ 失败: '+e.message+'</div>'}
}
function navigateTest(url){window.open(url,'_blank')}
// 🚀 自动检测 IP（页面加载后自动运行）
window.addEventListener('DOMContentLoaded',()=>{
setTimeout(()=>{checkIP('${defaultUrl}')},500);
});
</script>
</body>
</html>`;
}

module.exports = { __inject, registerRoutes, buildDiagnosticsHtml };
