/**
 * 代理字符串解析（前端共用）
 *
 * 为什么要独立成模块：导入配置时表里的代理往往是一整串（如 `host:port:user:pass`），
 * 而接口只认结构化的 host/port/username/password。少了这一步，代理字符串只会被塞进
 * proxy.raw，结构化列全空、proxyEnabled 又是 false，最终表现为「代理没保存到数据库」。
 */
export interface ParsedProxy {
  type: string;
  host: string;
  port: string;
  username: string;
  password: string;
}

/**
 * 支持：
 *   socks5://user:pass@host:port
 *   http(s)://user:pass@host:port
 *   user:pass@host:port
 *   host:port
 *   host:port:user:pass
 * 拿不到 host+port 时返回 undefined（调用方需自行决定怎么处理，不要静默吞掉）。
 */
export function parseProxyString(raw: string): ParsedProxy | undefined {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  let type = 'http', host = '', port = '', username = '', password = '';
  let rest = s;
  const m = s.match(/^(https?|socks5):\/\//i);
  if (m) { type = m[1].toLowerCase() === 'socks5' ? 'socks5' : 'http'; rest = s.replace(/^(https?|socks5):\/\//i, ''); }
  if (rest.includes('@')) {
    const [cred, hostpart] = rest.split('@');
    const [u, p] = cred.split(':');
    username = u || ''; password = p || '';
    const [h, pt] = hostpart.split(':');
    host = h || ''; port = pt || '';
  } else {
    const parts = rest.split(':');
    if (parts.length === 2) { host = parts[0]; port = parts[1]; }
    if (parts.length === 4) { host = parts[0]; port = parts[1]; username = parts[2]; password = parts[3]; }
  }
  return host && port ? { type, host, port, username, password } : undefined;
}
