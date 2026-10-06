/**
 * API 转发层 (Cloudflare Pages Functions)
 * 说明：API 部署在自建后端服务器（https://your-backend.example.com/api/*），
 * 前端保持 Cloudflare Pages 不变，本文件把 /api/* 请求原样转发到新后端。
 * 原完整 API 实现已备份到 functions/_backup_api/（Pages 会忽略 _ 开头的目录）。
 */
const BACKEND = 'https://your-backend.example.com';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = BACKEND + url.pathname + (url.search || '');

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

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: 'follow',
    });
  } catch (err) {
    return json({ ok: false, error: 'backend unreachable' }, 502);
  }

  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete('transfer-encoding');
  // 与旧实现一致的宽松 CORS
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
