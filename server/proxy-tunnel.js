// proxy-tunnel.js — 代理/隧道基础设施
'use strict';

const net = require('net');
const path = require('path');
const fsSync = require('fs');
const { Client } = require('ssh2');
const tls = require('tls');

// 🔌 S5 隧道配置（默认 127.0.0.1:10808 / Clash/V2Ray），可由 /api/config 动态修改
let S5_TUNNEL_HOST = process.env.S5_TUNNEL_HOST || '127.0.0.1';
let S5_TUNNEL_PORT = parseInt(process.env.S5_TUNNEL_PORT || '10808', 10);
let S5_TUNNEL_TYPE = (process.env.S5_TUNNEL_TYPE || 'socks5').toLowerCase(); // 'socks5' | 'http'

// 日志配置（模块本地副本）
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO'; // DEBUG, INFO, WARN, ERROR
const logLevels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
const FILE_LOG_PATH = path.join(APP_ROOT, 'logs', 'service.log');

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
            
            // 处理带协议的格式: protocol://[user:pass@]host:port 或 protocol://host:port:user:pass
            if (p.includes('://')) {
                // 先尝试标准 URL 解析 (protocol://user:pass@host:port)
                try {
                    const url = new URL(p);
                    return {
                        type: url.protocol.replace(':', ''),
                        host: url.hostname,
                        port: url.port || (url.protocol === 'https:' ? 443 : 80),
                        username: url.username || '',
                        password: url.password || ''
                    };
                } catch {
                    // 标准解析失败，尝试非标准格式: protocol://host:port:user:pass
                    const [scheme, rest] = p.split('://');
                    const parts = rest.split(':');
                    if (parts.length >= 4) {
                        return {
                            type: scheme.toLowerCase(),
                            host: parts[0],
                            port: parts[1],
                            username: parts[2],
                            password: parts.slice(3).join(':'),
                        };
                    }
                    // 如果还是解析不了，重新抛出给外层 catch
                    throw new Error(`无法解析代理格式: ${p}`);
                }
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
                // 判断是否是 host:port:user:pass
                if (parts.length >= 4) {
                    return {
                        host: parts[0],
                        port: parts[1],
                        username: parts[2],
                        password: parts[3],
                        type: 'http'
                    };
                }
                // 默认 host:port
                return {
                    host: parts[0],
                    port: parts[1],
                    username: '',
                    password: '',
                    type: 'http'
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

/**
 * 🚀 创建本地 TCP 中继隧道：通过本地代理 (S5_TUNNEL_HOST:S5_TUNNEL_PORT, TYPE=S5_TUNNEL_TYPE) 转发到目标代理
 * 纯字节中继，不解析任何代理协议，由 Chrome 直接与远端代理进行 HTTP CONNECT 或 SOCKS5 握手
 */
async function _createSocksTunnel(targetHost, targetPort, localSocksHost, localSocksPort, tunnelType) {
    if (localSocksHost === undefined) localSocksHost = S5_TUNNEL_HOST;
    if (localSocksPort === undefined) localSocksPort = S5_TUNNEL_PORT;
    if (tunnelType === undefined) tunnelType = S5_TUNNEL_TYPE;

    const isHttp = tunnelType === 'http';
    const net = require('net');
    // 1. 检测本地代理是否可用
    const localAlive = await new Promise(r => {
        const s = new net.Socket();
        s.setTimeout(3000);
        s.connect(localSocksPort, localSocksHost, () => { s.destroy(); r(true); });
        s.on('error', () => r(false));
        s.on('timeout', () => { s.destroy(); r(false); });
    });
    if (!localAlive) return null;

    // 2. 创建纯 TCP 中继服务器
    const server = net.createServer((clientConn) => {
        // 🐛 加 TCP keepalive，避免休眠后隧道 socket 变成"僵尸连接"（半死不被内核判定、永不恢复）
        try { clientConn.setKeepAlive(true, TUNNEL_KEEPALIVE_MS); } catch {}
        try { clientConn.setNoDelay(true); } catch {}
        // 通过本地代理建立到目标代理的 TCP 连接
        const proxyConn = net.createConnection(localSocksPort, localSocksHost, () => {
            if (isHttp) {
                // 🅷 HTTP CONNECT 隧道
                const auth = '';
                const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`;
                proxyConn.write(Buffer.from(connectReq, 'ascii'));
                let buf = Buffer.alloc(0);
                proxyConn.once('data', (d) => {
                    buf = Buffer.concat([buf, d]);
                    const resp = buf.toString('ascii');
                    if (resp.includes('200')) {
                        // HTTP CONNECT 成功，开始双向透传
                        clientConn.pipe(proxyConn);
                        proxyConn.pipe(clientConn);
                    } else {
                        clientConn.end();
                        proxyConn.end();
                    }
                });
            } else {
                // 🆂 SOCKS5 无认证握手
                proxyConn.write(Buffer.from([0x05, 0x01, 0x00]));
                let s5Ready = false;
                proxyConn.once('data', (handshakeResp) => {
                    if (handshakeResp[0] !== 0x05 || handshakeResp[1] !== 0x00) {
                        clientConn.end(); proxyConn.end(); return;
                    }
                    // SOCKS5 CONNECT 到目标代理
                    const hostBuf = Buffer.from(targetHost, 'utf8');
                    const connectReq = Buffer.concat([
                        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                        hostBuf,
                        Buffer.from([((parseInt(targetPort) >> 8) & 0xff), (parseInt(targetPort) & 0xff)])
                    ]);
                    proxyConn.write(connectReq);
                    proxyConn.once('data', (connectResp) => {
                        if (connectResp[0] !== 0x05 || connectResp[1] !== 0x00) {
                            clientConn.end(); proxyConn.end(); return;
                        }
                        s5Ready = true;
                        clientConn.pipe(proxyConn);
                        proxyConn.pipe(clientConn);
                    });
                });
                proxyConn.on('error', () => { try { clientConn.end(); } catch {} });
                clientConn.on('error', () => { if (!s5Ready) try { proxyConn.end(); } catch {} });
                setTimeout(() => { if (!s5Ready) { try { clientConn.end(); } catch {} try { proxyConn.end(); } catch {} } }, 15000);
            }
        });
        proxyConn.on('error', () => { try { clientConn.end(); } catch {} });
        clientConn.on('error', () => { try { proxyConn.end(); } catch {} });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve({
                localHost: '127.0.0.1',
                localPort: addr.port,
                close: () => { try { server.close(); } catch {} }
            });
        });
        server.on('error', () => resolve(null));
    });
}

/**
 * 🚀 创建本地 SOCKS5 认证转发器
 * Chrome 不支持在 --proxy-server 中嵌入 SOCKS5 账密（新版已移除支持），
 * 此函数创建本地 SOCKS5 代理，由 Node.js 处理远程 SOCKS5 用户密码认证，
 * Chrome 只需连接本地代理（无认证），解决认证失败问题。
 * @param {object} proxy - { host, port, username, password, type }
 * @param {string} profileId - 用于关联和清理
 * @returns {Promise<{host:string, port:number, server:net.Server}>}
 */
async function _createLocalSocks5AuthForwarder(proxy, profileId) {
    const net = require('net');
    const remoteHost = proxy.host;
    const remotePort = parseInt(proxy.port, 10);
    const authUser = proxy.username || '';
    const authPass = proxy.password || '';

    if (!authUser) return null; // 无需认证就不创建转发器

    const server = net.createServer((clientConn) => {
        // 接收 Chrome 的 SOCKS5 请求（无认证）
        let buf = Buffer.alloc(0);
        let step = 0; // 0=握手, 1=连接请求

        const onData = (data) => {
            buf = Buffer.concat([buf, data]);

            if (step === 0 && buf.length >= 2) {
                // SOCKS5 握手：Chrome 发送 [ver, nmethods, methods...]
                const ver = buf[0];
                const nmethods = buf[1];
                if (buf.length < 2 + nmethods) return; // 数据不完整

                if (ver !== 0x05) { clientConn.end(); return; }

                // 回复无认证方式
                clientConn.write(Buffer.from([0x05, 0x00]));
                buf = Buffer.alloc(0);
                step = 1;
                return;
            }

            if (step === 1 && buf.length >= 4) {
                // SOCKS5 连接请求: [ver, cmd, rsv, atyp, ...]
                if (buf[0] !== 0x05 || buf[1] !== 0x01) {
                    // 只支持 CONNECT 命令
                    clientConn.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
                    clientConn.end();
                    return;
                }

                // 解析目标地址
                let targetHost, targetPort;
                const atyp = buf[3];
                let headerLen = 0;

                if (atyp === 0x01) {
                    // IPv4
                    if (buf.length < 10) return;
                    targetHost = Array.from(buf.slice(4, 8)).join('.');
                    targetPort = buf.readUInt16BE(8);
                    headerLen = 10;
                } else if (atyp === 0x03) {
                    // 域名
                    const nameLen = buf[4];
                    if (buf.length < 5 + nameLen + 2) return;
                    targetHost = buf.slice(5, 5 + nameLen).toString('utf8');
                    targetPort = buf.readUInt16BE(5 + nameLen);
                    headerLen = 5 + nameLen + 2;
                } else if (atyp === 0x04) {
                    // IPv6
                    if (buf.length < 22) return;
                    targetHost = Array.from(buf.slice(4, 20)).map(b => b.toString(16)).join(':');
                    targetPort = buf.readUInt16BE(20);
                    headerLen = 22;
                } else {
                    clientConn.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
                    clientConn.end();
                    return;
                }

                // 连接到远程 SOCKS5 代理并进行认证
                const remoteConn = net.createConnection(remotePort, remoteHost, () => {
                    // 发送 SOCKS5 认证请求 (username/password auth - RFC 1929)
                    // 先协商: 支持无认证(0x00) + 用户名密码(0x02)
                    const userBuf = Buffer.from(authUser, 'utf8');
                    const passBuf = Buffer.from(authPass, 'utf8');
                    
                    // 协商阶段: 声明支持无认证+用户名密码
                    remoteConn.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
                    
                    let remoteStep = 0;
                    
                    remoteConn.once('data', (resp) => {
                        if (resp[0] !== 0x05) { cleanup(); return; }
                        
                        if (resp[1] === 0x00) {
                            // 远程接受无认证，直接发送 CONNECT
                            _sendRemoteConnect(remoteConn, targetHost, targetPort, clientConn, remoteConn);
                        } else if (resp[1] === 0x02) {
                            // 远程要求用户名密码认证
                            const authReq = Buffer.concat([
                                Buffer.from([0x01, userBuf.length]),
                                userBuf,
                                Buffer.from([passBuf.length]),
                                passBuf
                            ]);
                            remoteConn.write(authReq);
                            remoteConn.once('data', (authResp) => {
                                if (authResp.length >= 2 && authResp[0] === 0x01 && authResp[1] === 0x00) {
                                    // 认证成功，发送 CONNECT
                                    _sendRemoteConnect(remoteConn, targetHost, targetPort, clientConn, remoteConn);
                                } else {
                                    log('ERROR', `🔐 SOCKS5 远程认证失败: user=${authUser}`);
                                    clientConn.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
                                    cleanup();
                                }
                            });
                        } else {
                            log('ERROR', `🔐 SOCKS5 远程不支持的认证方法: ${resp[1]}`);
                            clientConn.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
                            cleanup();
                        }
                    });
                    
                    remoteConn.on('error', cleanup);
                    remoteConn.on('timeout', cleanup);
                });

                function _sendRemoteConnect(conn, h, p, client, remote) {
                    const hostBuf = Buffer.from(h, 'utf8');
                    const connectReq = Buffer.concat([
                        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                        hostBuf,
                        Buffer.from([((p >> 8) & 0xff), (p & 0xff)])
                    ]);
                    conn.write(connectReq);
                    conn.once('data', (connectResp) => {
                        if (connectResp.length >= 2 && connectResp[0] === 0x05 && connectResp[1] === 0x00) {
                            // 代理连接成功，回复 Chrome SOCKS5 CONNECT 成功
                            const bindAddr = Buffer.alloc(10, 0);
                            bindAddr[0] = 0x05; bindAddr[1] = 0x00; bindAddr[2] = 0x00;
                            bindAddr[3] = 0x01; // IPv4
                            bindAddr[4] = 0x7f; bindAddr[5] = 0x00; bindAddr[6] = 0x00; bindAddr[7] = 0x01; // 127.0.0.1
                            bindAddr.writeUInt16BE(0, 8);
                            client.write(bindAddr);
                            // 开始双向中继
                            client.pipe(remote);
                            remote.pipe(client);
                        } else {
                            // 代理连接目标失败，转发错误给 Chrome
                            const errCode = connectResp.length >= 2 ? connectResp[1] : 0x01;
                            const errResp = Buffer.alloc(10, 0);
                            errResp[0] = 0x05; errResp[1] = errCode; errResp[2] = 0x00;
                            errResp[3] = 0x01;
                            client.write(errResp);
                            cleanup();
                        }
                    });
                }

                function cleanup() {
                    try { clientConn.end(); } catch {}
                    try { remoteConn.end(); } catch {}
                }

                clientConn.on('error', cleanup);
                clientConn.on('close', cleanup);
                remoteConn.on('error', cleanup);
                remoteConn.on('close', cleanup);
                remoteConn.setTimeout(30000);
                
                buf = Buffer.alloc(0);
                step = 2; // 已完成
                return;
            }
        };

        clientConn.on('data', onData);
        clientConn.on('error', () => {});
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const localPort = addr.port;
            log('INFO', `🔐 本地 SOCKS5 认证转发器已启动: 127.0.0.1:${localPort} → ${remoteHost}:${remotePort} (user=${authUser})`);
            
            // 存储到全局映射，方便清理（按 kind 分槽位，避免 close 掉同配置的隧道）
            _registerProxyResource(profileId, 'socksfwd', server);
            
            resolve({ host: '127.0.0.1', port: localPort, server });
        });
        server.on('error', (err) => {
            log('ERROR', `🔐 本地 SOCKS5 转发器启动失败: ${err.message}`);
            resolve(null);
        });
    });
}

/**
 * 🚀 创建本地 HTTP/HTTPS 代理认证转发器
 * Chrome 新版已移除对 --proxy-server=http://user:pass@host:port 嵌入账密 URL 的支持，
 * 此函数创建本地 HTTP 代理，由 Node.js 在转发的 HTTP 请求中添加 Proxy-Authorization 头，
 * Chrome 只需连接本地代理（无认证），解决 HTTP/HTTPS 代理认证失败问题。
 * @param {object} proxy - { host, port, username, password, type }
 * @param {string} profileId - 用于关联和清理
 * @returns {Promise<{host:string, port:number, server:net.Server}>}
 */
async function _createLocalHttpAuthForwarder(proxy, profileId) {
    const net = require('net');
    const remoteHost = proxy.host;
    const remotePort = parseInt(proxy.port, 10);
    const authUser = proxy.username || '';
    const authPass = proxy.password || '';
    const protocol = (proxy.type || 'http').toLowerCase();

    if (!authUser) return null;

    // 预计算 Proxy-Authorization Basic header
    const authHeader = 'Proxy-Authorization: Basic ' + Buffer.from(authUser + ':' + authPass).toString('base64') + '\r\n';

    const server = net.createServer((clientConn) => {
        let buf = Buffer.alloc(0);

        const onData = (data) => {
            buf = Buffer.concat([buf, data]);

            // 查找 HTTP 头结束标记 \r\n\r\n
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                // 头部数据还不完整，继续等待
                return;
            }

            // 分离头部和正文
            const headerPart = buf.slice(0, headerEnd).toString('utf8');
            const bodyPart = buf.slice(headerEnd + 4);

            clientConn.removeListener('data', onData);

            // 判断是否 CONNECT 请求（HTTPS 隧道）
            const isConnect = headerPart.startsWith('CONNECT ');

            // 连接到远程代理
            const remoteConn = net.createConnection(remotePort, remoteHost, () => {
                if (isConnect) {
                    // HTTPS 隧道模式：转发 CONNECT 并附加认证头
                    const connectReq = headerPart + '\r\n' + authHeader + '\r\n';
                    remoteConn.write(connectReq);
                    
                    remoteConn.once('data', (resp) => {
                        const respStr = resp.toString('utf8');
                        if (respStr.startsWith('HTTP/1.1 200') || respStr.startsWith('HTTP/1.0 200')) {
                            // 通知 Chrome CONNECT 成功
                            clientConn.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                            // 开始双向中继（此时是 TLS 加密数据）
                            clientConn.pipe(remoteConn);
                            remoteConn.pipe(clientConn);
                        } else {
                            // 代理拒绝 CONNECT，转发响应给 Chrome
                            clientConn.write(resp);
                            cleanup();
                        }
                    });

                    remoteConn.on('error', cleanup);
                    remoteConn.on('end', cleanup);
                } else {
                    // 普通 HTTP 请求：在头部插入 Proxy-Authorization
                    const modifiedReq = headerPart + '\r\n' + authHeader + '\r\n' + (bodyPart.length > 0 ? bodyPart.toString('utf8') : '');
                    remoteConn.write(modifiedReq);
                    // 开始中继（将远程代理的响应转发回 Chrome）
                    clientConn.pipe(remoteConn, { end: false });
                    remoteConn.pipe(clientConn);
                }
            });

            function cleanup() {
                try { clientConn.end(); } catch {}
                try { remoteConn.end(); } catch {}
            }

            clientConn.on('error', cleanup);
            clientConn.on('close', cleanup);
            remoteConn.on('error', cleanup);
            remoteConn.on('close', cleanup);
            remoteConn.setTimeout(60000);
            remoteConn.on('timeout', cleanup);
        };

        clientConn.on('data', onData);
        clientConn.on('error', () => {});
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const localPort = addr.port;
            log('INFO', `🔐 本地 HTTP 认证转发器已启动: 127.0.0.1:${localPort} → ${remoteHost}:${remotePort} (user=${authUser})`);

            // 按 kind 分槽位注册，避免 close 掉同配置的隧道
            _registerProxyResource(profileId, 'httpfwd', server);

            resolve({ host: '127.0.0.1', port: localPort, server });
        });
        server.on('error', (err) => {
            log('ERROR', `🔐 本地 HTTP 转发器启动失败: ${err.message}`);
            resolve(null);
        });
    });
}

/**
 * 🚀 检测远程代理是否直连可达（增强版：不仅检测TCP，还验证 SOCKS5 协议握手）
 * @param {string} host - 代理主机
 * @param {number|string} port - 代理端口
 * @param {string} [proxyType] - 代理类型 ('socks5' | 'http' | 'https' 等)
 * @param {number} [timeoutMs=5000] - 超时毫秒
 * @returns {Promise<boolean>}
 */
async function _testDirectReachable(host, port, proxyType, timeoutMs = 5000) {
    const net = require('net');
    // 1️⃣ 先检测 TCP 连通性
    const tcpOk = await new Promise(r => {
        const s = new net.Socket();
        s.setTimeout(timeoutMs);
        s.connect(parseInt(port), host, () => { s.destroy(); r(true); });
        s.on('error', () => r(false));
        s.on('timeout', () => { s.destroy(); r(false); });
    });
    if (!tcpOk) return false;
    
    // 2️⃣ 对 SOCKS5 代理验证 SOCKS5 协议握手
    const t = (proxyType || '').toLowerCase();
    if (t === 'socks5' || t === 'socks5h') {
        const socks5Ok = await new Promise(r => {
            const s = new net.Socket();
            s.setTimeout(timeoutMs);
            s.connect(parseInt(port), host, () => {
                // SOCKS5 握手：客户端发送 [版本, 支持的认证方法数, 方法列表]
                // 这里发送：版本5, 1种方法, 无认证(0x00)
                s.write(Buffer.from([0x05, 0x01, 0x00]));
                s.once('data', (d) => {
                    s.destroy();
                    // 预期响应: [0x05, 0x00] - 版本5, 无认证
                    r(d.length >= 2 && d[0] === 0x05 && (d[1] === 0x00 || d[1] === 0x02));
                });
            });
            s.on('error', () => r(false));
            s.on('timeout', () => { s.destroy(); r(false); });
        });
        return socks5Ok;
    }
    
    // 非 SOCKS5 代理，TCP 连通即视为可达
    return true;
}

// 🚄 SSH 隧道代理管理器 -- 支持 ssh://host:port:user:pass 格式代理
// 原理：通过 SSH 建立隧道，在本机创建 SOCKS5 代理，Chrome 连接本地 SOCKS5
const sshTunnelManager = {
    _tunnels: new Map(), // profileId -> { sshClient, localServer, localPort }

    /**
     * 创建一个 SSH 隧道，返回本地 SOCKS5 代理地址
     * @param {object} proxy - 解析后的代理对象 { type, host, port, username, password }
     * @param {string} profileId - 用于关联和清理
     * @returns {Promise<{host:string, port:string}>} 本地 SOCKS5 代理地址
     */
    async createTunnel(proxy, profileId) {
        // 先清理已有隧道
        await this.closeTunnel(profileId);

        const sshHost = proxy.host;
        const sshPort = parseInt(proxy.port) || 22;
        const sshUser = proxy.username || 'root';
        const sshPass = proxy.password || '';

        log('INFO', `🔌 SSH 隧道: 正在连接到 ${sshUser}@${sshHost}:${sshPort}...`);

        return new Promise((resolve, reject) => {
            const conn = new Client();
            const timeout = setTimeout(() => {
                conn.end();
                reject(new Error(`SSH 连接超时 (${sshHost}:${sshPort})`));
            }, 15000);

            conn.on('ready', () => {
                clearTimeout(timeout);
                log('INFO', `🔌 SSH 隧道: 已连接到 ${sshHost}:${sshPort}`);

                // 在本机创建 SOCKS5 代理服务器
                const localServer = net.createServer((clientSocket) => {
                    // SOCKS5 协商：仅支持无认证方式 (0x00)
                    clientSocket.once('data', (buf) => {
                        if (buf.length < 3 || buf[0] !== 0x05) {
                            clientSocket.end();
                            return;
                        }
                        // 回复：版本5，无认证
                        clientSocket.write(Buffer.from([0x05, 0x00]));

                        // 等待 CONNECT 请求
                        clientSocket.once('data', (reqBuf) => {
                            if (reqBuf.length < 10 || reqBuf[0] !== 0x05 || reqBuf[1] !== 0x01) {
                                clientSocket.end();
                                return;
                            }
                            let targetHost, targetPort, addrLen;
                            const atyp = reqBuf[3];
                            if (atyp === 0x01) { // IPv4
                                targetHost = Array.from(reqBuf.slice(4, 8)).join('.');
                                addrLen = 4;
                            } else if (atyp === 0x03) { // 域名
                                const nameLen = reqBuf[4];
                                targetHost = reqBuf.slice(5, 5 + nameLen).toString();
                                addrLen = 1 + nameLen;
                            } else if (atyp === 0x04) { // IPv6
                                const ipv6Bytes = Array.from(reqBuf.slice(4, 20));
                                targetHost = ipv6Bytes.map(b => b.toString(16)).join(':');
                                addrLen = 16;
                            } else {
                                clientSocket.end();
                                return;
                            }
                            targetPort = reqBuf.readUInt16BE(4 + addrLen);

                            // 通过 SSH 隧道转发
                            conn.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
                                if (err) {
                                    // 回复 SOCKS5 错误
                                    clientSocket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
                                    clientSocket.end();
                                    return;
                                }
                                // 回复 CONNECT 成功
                                clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
                                // 双向数据转发
                                stream.pipe(clientSocket);
                                clientSocket.pipe(stream);
                                stream.on('error', () => { try { clientSocket.destroy(); } catch {} });
                                clientSocket.on('error', () => { try { stream.close(); } catch {} });
                            });
                        });
                    });
                });

                localServer.on('error', (err) => {
                    log('ERROR', `🔌 SSH 本地 SOCKS5 服务器错误: ${err.message}`);
                });

                // 随机分配端口
                localServer.listen(0, '127.0.0.1', () => {
                    const localPort = localServer.address().port;
                    this._tunnels.set(profileId, { sshClient: conn, localServer, localPort });
                    log('INFO', `🔌 SSH 隧道 SOCKS5 代理已创建: 127.0.0.1:${localPort}`);
                    resolve({ host: '127.0.0.1', port: String(localPort), type: 'socks5' });
                });
            });

            conn.on('error', (err) => {
                clearTimeout(timeout);
                log('ERROR', `🔌 SSH 连接失败: ${err.message}`);
                reject(err);
            });

            conn.on('close', () => {
                log('INFO', `🔌 SSH 隧道已关闭: ${sshHost}:${sshPort}`);
                this._tunnels.delete(profileId);
            });

            conn.connect({
                host: sshHost,
                port: sshPort,
                username: sshUser,
                password: sshPass,
                readyTimeout: 10000,
                keepaliveInterval: 30000,
                keepaliveCountMax: 3,
            });
        });
    },

    /**
     * 关闭指定 profile 的 SSH 隧道
     */
    async closeTunnel(profileId) {
        const tunnel = this._tunnels.get(profileId);
        if (tunnel) {
            try { tunnel.localServer?.close(); } catch {}
            try { tunnel.sshClient?.end(); } catch {}
            this._tunnels.delete(profileId);
            log('INFO', `🔌 SSH 隧道已清理: profileId=${profileId}`);
        }
    },

    /**
     * 关闭所有 SSH 隧道
     */
    async closeAll() {
        for (const [id] of this._tunnels) {
            await this.closeTunnel(id);
        }
    }
};

// 🔁 代理中继管理器 — 通过系统代理(127.0.0.1:10808)转发到远程代理
// 解决场景：远程代理服务器端口被GFW/防火墙拦截，但系统代理可以访问
// 原理：创建本地TCP中继 → 通过系统SOCKS5连接到远程代理 → Chrome连接本地中继
// 🔗 SOCKS5 链式隧道管理器
// 架构: Chrome → 本地SOCKS5(随机端口) → 系统代理(S5_TUNNEL_HOST:S5_TUNNEL_PORT) → 远程代理 → 目标网站
// 通过 socks npm 包实现干净的两跳链式连接
const CHAIN_TIMEOUT = parseInt(process.env.CHAIN_TIMEOUT || '25000', 10); // 链式隧道超时（25秒）
const CHAIN_RETRY_MAX = 2; // 最大重试次数
// 🐛 系统代理探测结果缓存时间。以前是「探测成功就永久缓存」，电脑休眠/断网后
//    系统代理（如 Astrill 127.0.0.1:10808）可能换端口或重启，隧道却一直用旧地址 → 永远连不上。
//    现在超过 TTL 就重新探测，连接失败也会主动作废缓存。
const SYSTEM_PROXY_TTL_MS = parseInt(process.env.SYSTEM_PROXY_TTL_MS || '30000', 10);
// 代理隧道健康检查间隔 / 多久没跑过就认为系统刚从休眠中唤醒
const TUNNEL_HEALTH_INTERVAL_MS = parseInt(process.env.TUNNEL_HEALTH_INTERVAL_MS || '30000', 10);
// ⚠️ 判定「休眠唤醒」的最小跳票时长。gap 量的是**定时器实际间隔**，不是真正的系统休眠时长 ——
//    事件循环被同步重活卡住同样会放大 gap。只按 3×间隔(90s)判定的话，一次 90s 卡顿就会被误判成
//    「刚唤醒」，进而把一切正常的在线隧道连接全部踢掉。真人休眠以分钟/小时计，把硬下限抬到 3 分钟
//    既不影响真休眠（gap 远大于此），又能挡住偶发卡顿。
const WAKE_MIN_GAP_MS = Math.max(TUNNEL_HEALTH_INTERVAL_MS * 3, 180000);
const TUNNEL_KEEPALIVE_MS = parseInt(process.env.TUNNEL_KEEPALIVE_MS || '15000', 10);
const socksClient = (() => {
    try { return require('socks'); } catch { return null; }
})();

// 🚀 模块级 SOCKS5 隧道存储（profileId → tunnel）
const _proxyTunnels = new Map();

const socksChainServer = {
    _servers: new Map(), // profileId -> { server, localPort }

    /** 检测系统代理是否可用（带 TTL 缓存，避免休眠后一直用失效地址） */
    _systemProxy: null,
    _systemProxyAt: 0,
    /** 正在飞行中的探测（并发合并用）。以前没有它，见下面 detectSystemProxy 的注释 */
    _systemProxyProbing: null,
    /** 作废缓存的系统代理探测结果，下次 detectSystemProxy 会重新探测 */
    invalidateSystemProxy(reason) {
        if (this._systemProxy) {
            log('INFO', `🔗 系统代理缓存已失效${reason ? `（${reason}）` : ''}，下次将重新探测`);
        }
        this._systemProxy = null;
        this._systemProxyAt = 0;
    },
    async detectSystemProxy() {
        if (this._systemProxy && (Date.now() - this._systemProxyAt) < SYSTEM_PROXY_TTL_MS) {
            return this._systemProxy;
        }
        // 🐛 并发合并：以前没有 in-flight 去重 —— 而 _chainConnectWithRetry 现在每次失败都会重新探测，
        //    系统代理真挂掉时，同一时刻有多少条链在重试就会有多少个探针同时打 10808（每 500ms 一轮），
        //    形成持续的本地连接风暴。现在同一时刻只允许一个探针在飞，其余共享它的结果。
        if (this._systemProxyProbing) return this._systemProxyProbing;
        this._systemProxyProbing = (async () => {
            try {
                const s = new net.Socket();
                s.setTimeout(2000);
                await new Promise((resolve, reject) => {
                    s.on('connect', () => { s.destroy(); resolve(); });
                    s.on('error', reject);
                    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
                    s.connect(S5_TUNNEL_PORT, S5_TUNNEL_HOST);
                });
                this._systemProxy = { host: S5_TUNNEL_HOST, port: S5_TUNNEL_PORT, type: 5 };
                this._systemProxyAt = Date.now();
                log('INFO', `🔗 检测到系统代理: ${this._systemProxy.host}:${this._systemProxy.port}`);
                return this._systemProxy;
            } catch {
                // 探测失败：一并清掉旧缓存，避免拿着已失效的地址反复重试
                this._systemProxy = null;
                this._systemProxyAt = 0;
                log('DEBUG', '🔗 未检测到系统代理');
                return null;
            } finally {
                this._systemProxyProbing = null;
            }
        })();
        return this._systemProxyProbing;
    },

    /**
     * 🩺 代理隧道健康检查（自愈）
     * 场景：电脑休眠/断网 → 所有已建立的隧道 socket 变成"僵尸"，既不会报错也不会恢复。
     * 处理：定时探测系统代理；发现"刚唤醒"或"从不可达恢复"时作废缓存并踢掉所有旧客户端连接，
     *       逼 Chrome 重连 → 重新建链。
     */
    _healthTimer: null,
    _lastHealthAt: 0,
    _lastSystemProxyReachable: true,
    startHealthMonitor() {
        if (this._healthTimer) return;
        this._healthTimer = setInterval(() => { this._healthCheck().catch(() => {}); }, TUNNEL_HEALTH_INTERVAL_MS);
        try { this._healthTimer.unref && this._healthTimer.unref(); } catch {}
        log('INFO', `🔗 代理隧道健康检查已启动（每 ${TUNNEL_HEALTH_INTERVAL_MS}ms）`);
    },
    stopHealthMonitor() {
        if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    },
    async _probeSystemProxyReachable() {
        return await new Promise((resolve) => {
            const s = new net.Socket();
            s.setTimeout(2000);
            const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
            s.once('connect', () => done(true));
            s.once('error', () => done(false));
            s.once('timeout', () => done(false));
            try { s.connect(S5_TUNNEL_PORT, S5_TUNNEL_HOST); } catch { done(false); }
        });
    },
    async _healthCheck() {
        const now = Date.now();
        const gap = this._lastHealthAt ? (now - this._lastHealthAt) : 0;
        this._lastHealthAt = now;
        // 健康检查"跳票"太久 → 进程很可能刚随系统从休眠中被唤醒。
        // ⚠️ 阈值必须带硬下限（WAKE_MIN_GAP_MS），否则一次 90s 的事件循环卡顿就会被误判成"刚唤醒"，
        //    把一切正常的在线连接全部踢掉（详见 WAKE_MIN_GAP_MS 处的注释）。
        const wokeUp = gap > WAKE_MIN_GAP_MS;

        if (this._servers.size === 0) return; // 没有活跃隧道，无需检查

        const ok = await this._probeSystemProxyReachable();

        if (!ok) {
            if (this._lastSystemProxyReachable !== false || wokeUp) {
                log('WARN', `🔗 系统代理 ${S5_TUNNEL_HOST}:${S5_TUNNEL_PORT} 不可达（休眠/断网？），已作废缓存`);
            }
            this._lastSystemProxyReachable = false;
            this.invalidateSystemProxy('健康检查：系统代理不可达');
            return;
        }

        if (wokeUp || this._lastSystemProxyReachable === false) {
            log('INFO', `🔗 系统代理已恢复${wokeUp ? '（检测到休眠唤醒）' : ''}，重置所有隧道客户端连接，等待浏览器重连`);
            this.invalidateSystemProxy('健康检查：系统代理恢复');
            this.dropAllClients();
        }
        this._lastSystemProxyReachable = true;
    },
    /** 断开所有隧道上已建立的客户端连接（Chrome 会自动重连并新建链） */
    dropAllClients() {
        let n = 0;
        for (const [, entry] of this._servers) {
            if (!entry || !entry.clients) continue;
            for (const c of Array.from(entry.clients)) {
                try { c.destroy(); n++; } catch {}
            }
            entry.clients.clear();
        }
        if (n) log('INFO', `🔗 已断开 ${n} 条旧隧道客户端连接，等待浏览器重连`);
        return n;
    },

    /**
     * 通过 SOCKS5 链连接到远程目标
     * 链: 本机 → 系统代理(S5_TUNNEL_PORT) → 远程代理(HTTP或SOCKS5) → 目标
     */
    // 🚀 带重试的链式连接
    async _chainConnectWithRetry(systemProxy, remoteProxy, targetHost, targetPort) {
        let lastErr;
        let sysProxy = systemProxy;
        for (let attempt = 1; attempt <= CHAIN_RETRY_MAX; attempt++) {
            try {
                const result = await this._chainConnect(sysProxy, remoteProxy, targetHost, targetPort);
                if (attempt > 1) log('INFO', `🔗 链式连接重试成功: [${targetHost}:${targetPort}] 第${attempt}次`);
                return result;
            } catch (err) {
                lastErr = err;
                if (attempt >= CHAIN_RETRY_MAX) {
                    // 🐛 以前对 facebook/fbcdn 目标「直接抛出不重试」，恰恰是最需要重试的目标被短路了。
                    //    现在所有目标统一重试。
                    throw err;
                }
                // 🐛 休眠/断网后系统代理可能已换地址或刚重启：作废缓存并重新探测，避免一直用失效地址重试
                this.invalidateSystemProxy('链式连接失败，重新探测');
                try {
                    const fresh = await this.detectSystemProxy();
                    if (fresh) sysProxy = fresh;
                } catch {}
                log('DEBUG', `🔗 链式连接重试 #${attempt}: [${targetHost}:${targetPort}] ${err.message}`);
                // 短暂等待后重试
                await new Promise(r => setTimeout(r, 500));
            }
        }
        throw lastErr;
    },

    async _chainConnect(systemProxy, remoteProxy, targetHost, targetPort) {
        // 🐛 修复：这里原写成未声明的 socksClient_chain，导致每次链式连接都抛
        //    「socksClient_chain is not defined」，Chrome 表现为"代理无法连接网络"
        if (!socksClient) throw new Error('socks 包不可用');

        // 第1跳: 通过系统代理连接到远程代理服务器
        const hop1 = await socksClient.SocksClient.createConnection({
            proxy: { ...systemProxy, userId: '', password: '' },
            destination: { host: remoteProxy.host, port: parseInt(remoteProxy.port) },
            command: 'connect',
            timeout: CHAIN_TIMEOUT,
        });

        const tunnelSocket = hop1.socket;
        let chainSocket = tunnelSocket; // 默认用原始socket
        const isHttpsRemote = String(remoteProxy.type || '').toLowerCase() === 'https';
        const isSocks5Remote = String(remoteProxy.type || '').toLowerCase() === 'socks5';

        if (isHttpsRemote) {
            // 🅲 第2跳: 远程代理是 HTTPS 协议 → TLS 握手后发 HTTP CONNECT
            // 若 TLS 失败，自动回退到 HTTP
            try {
                chainSocket = await new Promise((resolve, reject) => {
                    const tlsSocket = tls.connect({
                        socket: tunnelSocket,
                        servername: remoteProxy.host,
                        rejectUnauthorized: false,
                    });

                    tlsSocket.once('secureConnect', () => {
                        log('DEBUG', `🔐 HTTPS代理 TLS 握手成功: ${remoteProxy.host}:${remoteProxy.port}`);
                        const auth = remoteProxy.username && remoteProxy.password
                            ? 'Proxy-Authorization: Basic ' + Buffer.from(remoteProxy.username + ':' + remoteProxy.password).toString('base64') + '\r\n'
                            : '';
                        const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`;
                        let buf = Buffer.alloc(0);
                        let httpResolved = false;
                        const httpResolve = () => { if (!httpResolved) { httpResolved = true; resolve(tlsSocket); } };

                        tlsSocket.on('data', (data) => {
                            buf = Buffer.concat([buf, data]);
                            const str = buf.toString();
                            const headerEnd = str.indexOf('\r\n\r\n');
                            if (headerEnd === -1) return;
                            const statusLine = str.split('\r\n')[0];
                            tlsSocket.removeAllListeners('data');
                            if (statusLine.includes('200')) {
                                httpResolve();
                            } else {
                                reject(new Error(`HTTPS CONNECT失败: ${statusLine}`));
                            }
                        });
                        tlsSocket.on('error', reject);
                        tlsSocket.write(connectReq);
                        tunnelSocket.removeAllListeners();
                    });
                    tlsSocket.on('error', (err) => {
                        log('WARN', `🔐 HTTPS TLS握手失败: ${err.message}，回退到 HTTP`);
                        reject(err);
                    });
                    setTimeout(() => reject(new Error('HTTPS TLS握手超时')), CHAIN_TIMEOUT);
                });
            } catch (tlsErr) {
                // TLS 失败，回退到 HTTP CONNECT
                log('WARN', `🔐 HTTPS→HTTP 回退代理 ${remoteProxy.host}:${remoteProxy.port}`);
                // 重新建立 socket（第1跳）
                const retryHop = await socksClient.SocksClient.createConnection({
                    proxy: { ...systemProxy, userId: '', password: '' },
                    destination: { host: remoteProxy.host, port: parseInt(remoteProxy.port) },
                    command: 'connect',
                    timeout: CHAIN_TIMEOUT,
                });
                chainSocket = retryHop.socket;
                // 发 HTTP CONNECT
                await new Promise((resolve, reject) => {
                    const auth = remoteProxy.username && remoteProxy.password
                        ? 'Proxy-Authorization: Basic ' + Buffer.from(remoteProxy.username + ':' + remoteProxy.password).toString('base64') + '\r\n'
                        : '';
                    const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`;
                    let buf = Buffer.alloc(0);
                    chainSocket.on('data', (data) => {
                        buf = Buffer.concat([buf, data]);
                        const str = buf.toString();
                        const headerEnd = str.indexOf('\r\n\r\n');
                        if (headerEnd === -1) return;
                        const statusLine = str.split('\r\n')[0];
                        chainSocket.removeAllListeners('data');
                        if (statusLine.includes('200')) resolve();
                        else reject(new Error(`回退HTTP CONNECT失败: ${statusLine}`));
                    });
                    chainSocket.on('error', reject);
                    chainSocket.write(connectReq);
                    setTimeout(() => reject(new Error('回退HTTP CONNECT超时')), CHAIN_TIMEOUT);
                });
            }
        } else if (!isSocks5Remote) {
            // 🅱️ 第2跳: 远程代理是 HTTP 协议 → 发送 HTTP CONNECT
            await new Promise((resolve, reject) => {
                const auth = remoteProxy.username && remoteProxy.password
                    ? 'Proxy-Authorization: Basic ' + Buffer.from(remoteProxy.username + ':' + remoteProxy.password).toString('base64') + '\r\n'
                    : '';
                const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`;
                let buf = Buffer.alloc(0);

                tunnelSocket.on('data', (data) => {
                    buf = Buffer.concat([buf, data]);
                    const str = buf.toString();
                    const headerEnd = str.indexOf('\r\n\r\n');
                    if (headerEnd === -1) return;
                    const statusLine = str.split('\r\n')[0];
                    tunnelSocket.removeAllListeners('data');

                    if (statusLine.includes('200')) {
                        resolve();
                    } else if (statusLine.includes('407')) {
                        reject(new Error('HTTP代理需要认证'));
                    } else {
                        reject(new Error(`HTTP CONNECT失败: ${statusLine}`));
                    }
                });
                tunnelSocket.on('error', reject);
                tunnelSocket.on('close', () => reject(new Error('HTTP代理连接关闭')));
                tunnelSocket.write(connectReq);
                setTimeout(() => reject(new Error('HTTP CONNECT超时')), CHAIN_TIMEOUT);
            });
        } else {
            // 🅰️ 第2跳: 远程代理是 SOCKS5 协议 → SOCKS5 握手 + 认证 + CONNECT
            await new Promise((resolve, reject) => {
                let step = 0;
                let buf = Buffer.alloc(0);

                const onData = (data) => {
                    buf = Buffer.concat([buf, data]);

                    if (step === 0 && buf.length >= 2) {
                        const ver = buf[0];
                        const method = buf[1];

                        if (method === 0xFF) {
                            reject(new Error('远程SOCKS5代理无可用认证方式'));
                            return;
                        }

                        if (method === 0x02) {
                            if (remoteProxy.username && remoteProxy.password) {
                                const userBuf = Buffer.from(remoteProxy.username, 'utf8');
                                const passBuf = Buffer.from(remoteProxy.password, 'utf8');
                                const authReq = Buffer.alloc(3 + userBuf.length + passBuf.length);
                                authReq[0] = 0x01;
                                authReq[1] = userBuf.length;
                                userBuf.copy(authReq, 2);
                                authReq[2 + userBuf.length] = passBuf.length;
                                passBuf.copy(authReq, 3 + userBuf.length);
                                buf = Buffer.alloc(0);
                                tunnelSocket.write(authReq);
                                step = 1;
                            } else {
                                reject(new Error('远程SOCKS5代理需要认证但未提供'));
                                return;
                            }
                        } else if (method === 0x00) {
                            step = 1;
                            buf = Buffer.alloc(0);
                            _sendSocks5Connect(tunnelSocket, targetHost, targetPort);
                        } else {
                            reject(new Error(`远程SOCKS5不支持的认证: ${method}`));
                            return;
                        }
                        return;
                    }

                    if (step === 1 && buf.length >= 2) {
                        if (buf[0] === 0x01 && buf[1] === 0x00) {
                            buf = Buffer.alloc(0);
                            _sendSocks5Connect(tunnelSocket, targetHost, targetPort);
                            step = 2;
                        } else {
                            reject(new Error('远程SOCKS5认证失败'));
                            return;
                        }
                        return;
                    }

                    if (step === 2 && buf.length >= 10) {
                        if (buf[1] === 0x00) {
                            resolve();
                        } else {
                            const errs = {0x01:'general',0x02:'not allowed',0x03:'net unreachable',0x04:'host unreachable',0x05:'conn refused',0x06:'TTL',0x07:'cmd not supported',0x08:'atype not supported'};
                            reject(new Error(`远程SOCKS5连接失败: ${errs[buf[1]] || buf[1]}`));
                        }
                        return;
                    }
                };

                tunnelSocket.on('data', onData);
                tunnelSocket.on('error', reject);
                tunnelSocket.on('close', () => reject(new Error('远程SOCKS5连接关闭')));
                tunnelSocket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
                setTimeout(() => reject(new Error('远程SOCKS5握手超时')), CHAIN_TIMEOUT);
            });
        }

        function _sendSocks5Connect(sock, host, port) {
            const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(host);
            let req;
            if (isIP) {
                const ipBytes = host.split('.').map(Number);
                req = Buffer.from([0x05, 0x01, 0x00, 0x01, ...ipBytes, (port>>8)&0xFF, port&0xFF]);
            } else {
                const nameBytes = Buffer.from(host, 'utf8');
                req = Buffer.from([0x05, 0x01, 0x00, 0x03, nameBytes.length, ...nameBytes, (port>>8)&0xFF, port&0xFF]);
            }
            sock.write(req);
        }

        return chainSocket;
    },

    /**
     * 创建 SOCKS5 链式隧道
     * @param {object} remoteProxy - 远程SOCKS5代理 { host, port, username, password, type }
     * @param {string} profileId
     * @returns {Promise<{host:string, port:string, type:string}>} 本地SOCKS5地址
     */
    async createChain(remoteProxy, profileId) {
        const systemProxy = await this.detectSystemProxy();
        if (!systemProxy) throw new Error('系统代理不可用');

        await this.closeChain(profileId);

        return new Promise((resolve, reject) => {
            // 🩺 记录该隧道上所有活跃的客户端连接，便于休眠唤醒后统一踢掉重连
            const entry = { server: null, localPort: 0, clients: new Set() };
            // 创建本地 SOCKS5 服务器
            const localServer = net.createServer((clientSocket) => {
                // 解析客户端 (Chrome) 发来的 SOCKS5 请求
                let step = 'greeting';
                let buf = Buffer.alloc(0);
                let targetHost, targetPort;
                let chainSocket = null;
                entry.clients.add(clientSocket);

                // 🐛 休眠/断网时对端 socket 已消失，但内核不一定立刻判定它死了 → 浏览器会一直转圈。
                //    加 TCP keepalive 让半死连接尽快被内核打掉，从而触发 error → 浏览器重连。
                try { clientSocket.setKeepAlive(true, TUNNEL_KEEPALIVE_MS); } catch {}
                try { clientSocket.setNoDelay(true); } catch {}

                const cleanup = () => {
                    entry.clients.delete(clientSocket);
                    try { chainSocket?.destroy(); } catch {}
                    try { clientSocket.destroy(); } catch {}
                };

                const onClientData = async (data) => {
                    buf = Buffer.concat([buf, data]);

                    if (step === 'greeting' && buf.length >= 2) {
                        if (buf[0] !== 0x05) { cleanup(); return; }
                        // 回复: 无认证
                        clientSocket.write(Buffer.from([0x05, 0x00]));
                        step = 'request';
                        buf = Buffer.alloc(0);
                        return;
                    }

                    if (step === 'request' && buf.length >= 10) {
                        if (buf[0] !== 0x05 || buf[1] !== 0x01) {
                            // 不支持的命令/版本
                            clientSocket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0,0,0]));
                            cleanup();
                            return;
                        }
                        const atyp = buf[3];
                        if (atyp === 0x01) {
                            targetHost = Array.from(buf.slice(4, 8)).join('.');
                            targetPort = buf.readUInt16BE(8);
                        } else if (atyp === 0x03) {
                            const nameLen = buf[4];
                            targetHost = buf.slice(5, 5 + nameLen).toString();
                            targetPort = buf.readUInt16BE(5 + nameLen);
                        } else {
                            clientSocket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0,0,0,0,0,0]));
                            cleanup();
                            return;
                        }

                        // 暂停监听，避免冲突
                        clientSocket.removeListener('data', onClientData);

                        // 🐛 用"当下"的系统代理重新探测一次（而不是建隧道时捕获的旧值），
                        //    否则休眠唤醒后系统代理换了地址，这条隧道仍会一直用失效地址。
                        const currentSystemProxy = (await this.detectSystemProxy().catch(() => null)) || systemProxy;

                        // 通过链连接到目标（带重试）
                        this._chainConnectWithRetry(currentSystemProxy, remoteProxy, targetHost, targetPort)
                            .then((socket) => {
                                chainSocket = socket;
                                // 回复 SOCKS5 CONNECT 成功
                                const resp = Buffer.alloc(10);
                                resp[0] = 0x05; resp[1] = 0x00; resp[2] = 0x00;
                                resp[3] = 0x01;
                                const ipParts = (chainSocket.localAddress || '127.0.0.1').split('.');
                                for (let i = 0; i < 4 && i < ipParts.length; i++) {
                                    resp[4 + i] = parseInt(ipParts[i]) || 0;
                                }
                                resp.writeUInt16BE(chainSocket.localPort || 0, 8);
                                clientSocket.write(resp);

                                // 🐛 同上：链路上也加 keepalive，避免休眠后成为"僵尸连接"
                                try { chainSocket.setKeepAlive(true, TUNNEL_KEEPALIVE_MS); } catch {}
                                try { chainSocket.setNoDelay(true); } catch {}

                                // 双向桥接
                                chainSocket.pipe(clientSocket);
                                clientSocket.pipe(chainSocket);
                                chainSocket.on('error', () => { try { clientSocket.destroy(); } catch {} });
                                clientSocket.on('error', () => { try { chainSocket.destroy(); } catch {} });
                            })
                            .catch((err) => {
                                log('ERROR', `🔗 链式连接失败 [${targetHost}:${targetPort}]: ${err.message}`);
                                clientSocket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0,0,0,0,0,0]));
                                cleanup();
                            });
                        return;
                    }
                };

                clientSocket.on('data', onClientData);
                clientSocket.on('error', cleanup);
                clientSocket.on('close', cleanup);
            });

            localServer.on('error', reject);
            localServer.listen(0, '127.0.0.1', () => {
                const localPort = localServer.address().port;
                entry.server = localServer;
                entry.localPort = localPort;
                this._servers.set(profileId, entry);
                const proxyTypes = { 'socks5': 'SOCKS5', 'https': 'HTTPS' };
                const proxyTypeName = proxyTypes[String(remoteProxy.type || '').toLowerCase()] || 'HTTP';
                log('INFO', `🔗 ${proxyTypeName} 链式隧道就绪: 127.0.0.1:${localPort} → (系统代理:${S5_TUNNEL_HOST}:${S5_TUNNEL_PORT}) → (远程:${proxyTypeName} ${remoteProxy.host}:${remoteProxy.port}) → 目标`);
                resolve({ host: '127.0.0.1', port: String(localPort), type: 'socks5' });
            });
        });
    },

    async closeChain(profileId) {
        const entry = this._servers.get(profileId);
        if (entry) {
            // 先踢掉该隧道上的客户端连接，否则 server.close() 只是停止接收新连接，旧连接仍挂着
            if (entry.clients) {
                for (const c of Array.from(entry.clients)) { try { c.destroy(); } catch {} }
                entry.clients.clear();
            }
            try { entry.server?.close(); } catch {}
            this._servers.delete(profileId);
            log('INFO', `🔗 SOCKS5 链式隧道已关闭: profileId=${profileId}`);
        }
    },

    async closeAll() {
        for (const [id] of Array.from(this._servers.keys())) {
            await this.closeChain(id);
        }
    },

    /**
     * 🔄 重置代理隧道（休眠唤醒 / 手动兜底）
     * 作废系统代理缓存 + 踢掉隧道上所有已建立的客户端连接。
     *
     * ⚠️ 这里**绝不能关闭本地监听端口**：该端口号在建隧道时就写进了 Chrome 的
     *    `--proxy-server`，关掉监听等于把 Chrome 的代理地址彻底废掉，永远无法恢复
     *    （只能重启浏览器）。监听保持存活，Chrome 重连时会现场新建一条链，才能真正自愈。
     *
     * @returns {{droppedClients:number, activeTunnels:number, systemProxyReachable:boolean}}
     */
    async resetAll(reason) {
        const droppedClients = this.dropAllClients();
        this.invalidateSystemProxy(reason || '手动重置');
        const reachable = await this._probeSystemProxyReachable();
        this._lastSystemProxyReachable = reachable;
        const activeTunnels = this._servers.size;
        log('INFO', `🔄 代理隧道已重置：保留 ${activeTunnels} 个监听端口、断开 ${droppedClients} 条连接，系统代理${reachable ? '可达' : '不可达'}`);
        return { droppedClients, activeTunnels, systemProxyReachable: reachable };
    }
};

// 辅助函数：允许主文件更新模块的隧道配置
function setS5TunnelConfig(host, port, type) {
    if (host !== undefined) { S5_TUNNEL_HOST = host; }
    if (port !== undefined) { S5_TUNNEL_PORT = port; }
    if (type !== undefined) { S5_TUNNEL_TYPE = type; }
    // 地址/端口/类型变了，旧的探测结果必须作废
    try { socksChainServer.invalidateSystemProxy('S5 隧道配置变更'); } catch {}
}

/**
 * 🚀 注册某个配置的代理资源（隧道 / 认证转发器）。
 * 🐛 以前隧道和转发器都直接拿 profileId 当 key 往 _proxyTunnels 里塞，
 *    于是「先建隧道、再建认证转发器」时，转发器会把刚建好的隧道 close 掉，
 *    转发器随即连不上隧道端口 → Chrome 报 ERR_SOCKS_CONNECTION_FAILED（实测 4137/4135/4142）。
 *    现在按 kind 分槽位注册：只替换同类资源，不会误杀其它资源。
 */
function _registerProxyResource(profileId, kind, resource) {
    if (!profileId || !resource) return;
    const key = `${profileId}::${kind}`;
    const old = _proxyTunnels.get(key);
    if (old && old !== resource) { try { old.close(); } catch {} }
    _proxyTunnels.set(key, resource);
    // 兼容老代码：无 kind 的裸 key 也指向最新资源，便于旧清理逻辑兜底
    _proxyTunnels.set(String(profileId), resource);
}

/** 🚀 关闭某个配置下的全部代理资源（隧道 + 各认证转发器 + 裸 key） */
function _closeProfileResources(profileId) {
    if (!profileId) return;
    const pid = String(profileId);
    for (const key of Array.from(_proxyTunnels.keys())) {
        if (key === pid || key.startsWith(`${pid}::`)) {
            try { _proxyTunnels.get(key).close(); } catch {}
            _proxyTunnels.delete(key);
        }
    }
}

// 🩺 启动代理隧道健康检查（自愈）：电脑休眠/断网后系统代理恢复时自动重置隧道
try { socksChainServer.startHealthMonitor(); } catch {}

module.exports = {
    parseProxy,
    _createSocksTunnel,
    _createLocalSocks5AuthForwarder,
    _createLocalHttpAuthForwarder,
    _testDirectReachable,
    sshTunnelManager,
    socksChainServer,
    _proxyTunnels,
    _registerProxyResource,
    _closeProfileResources,
    S5_TUNNEL_HOST,
    S5_TUNNEL_PORT,
    S5_TUNNEL_TYPE,
    log,
    setS5TunnelConfig,
};
