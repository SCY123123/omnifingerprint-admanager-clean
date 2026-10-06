/**
 * 宝塔版后端入口
 * 把 Node HTTP 请求封装成 Cloudflare Pages Functions 的 Request，
 * 转给同构移植的 onRequest(context) 处理（api/[[path]].js）。
 */
import http from 'node:http';
import 'dotenv/config';
import { onRequest } from '../api/[[path]].js';
import { createD1Env } from './db.js';
import { startRechargePoller } from '../api/routes/recharge.js';

const PORT = Number(process.env.PORT || 7700);

const env = await createD1Env(process.env);
console.log(`[baota-backend] DB=${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT} ready, listening :${PORT}`);

async function handleRequest(req, res) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks);

    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = req.rawHeaders[i + 1];
      if (headers[k] !== undefined) headers[k] = `${headers[k]}, ${v}`;
      else headers[k] = v;
    }

    const url = new URL(req.url || '/', `http://${headers.host || '127.0.0.1'}`);
    const useBody = rawBody.length > 0;
    const request = new Request(url.toString(), {
      method: req.method,
      headers,
      body: useBody ? rawBody : undefined,
    });

    const response = await onRequest({ request, env, url });
    // Headers 转普通对象（writeHead 不识别 Headers 实例）；body 用 ArrayBuffer 原样回写（图片等二进制不能转 text）
    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(response.status, outHeaders);
    const bodyBuf = Buffer.from(await response.arrayBuffer());
    res.end(bodyBuf);
  } catch (e) {
    try {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    } catch (_) { /* ignore */ }
    res.end(JSON.stringify({ success: false, message: 'Internal server error: ' + (e && e.message ? e.message : String(e)) }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[baota-backend] listening on http://127.0.0.1:${PORT}`);
  // U 充值自动对账：轮询 TRON 链，金额精确匹配即入账（管理员手动确认兜底）
  startRechargePoller(env);
});
