/**
 * API 转发层 (Cloudflare Pages Functions)
 * 说明：API 部署在自建后端服务器（https://your-backend.example.com/api/*），
 * 前端保持 Cloudflare Pages 不变，本文件把 /api/* 请求原样转发到新后端。
 *
 * 🆕 临时邮箱网关是例外：/api/mailtm-proxy、/api/mailgw-proxy 在宝塔后端上并不存在
 *    （迁移时没跟着迁，转发过去只会 404），这里直接在边缘节点转发到公共邮箱 API ——
 *    顺带避开「国内机器直连 api.mail.tm 不稳」的问题。
 */
const BACKEND = 'https://your-backend.example.com';

// 前缀 → 上游公共邮箱 API（去掉前缀后原样拼上剩余路径与查询串）
const MAIL_PROXY_TARGETS = [
  { prefix: '/api/mailtm-proxy', target: 'https://api.mail.tm' },
  { prefix: '/api/mailgw-proxy', target: 'https://api.mail.gw' },
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  const mailProxy = MAIL_PROXY_TARGETS.find(
    (t) => pathname === t.prefix || pathname.startsWith(`${t.prefix}/`)
  );
  const isMailProxy = Boolean(mailProxy);
  const target = mailProxy
    ? mailProxy.target + (pathname.slice(mailProxy.prefix.length) || '/') + (url.search || '')
    : BACKEND + pathname + (url.search || '');

  // 读取请求体（GET/HEAD 无 body）
  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  // 转发请求头（去掉 host，交由 fetch 按目标域名设置）
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');
  headers.delete('x-forwarded-for');
  headers.delete('x-forwarded-proto');
  headers.delete('content-length');
  // 公共邮箱 API 要求 Accept: application/json，前端部分请求没带，这里补上
  if (isMailProxy && !headers.get('accept')) headers.set('Accept', 'application/json');

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: 'follow',
    });
  } catch (err) {
    return json({ ok: false, error: isMailProxy ? 'mail gateway unreachable' : 'backend unreachable' }, 502);
  }

  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete('transfer-encoding');
  // 与旧实现一致的宽松 CORS
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Secret');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
