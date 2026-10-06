/**
 * OmniFingerprint API Gateway (Cloudflare Pages Functions)
 * This single file handles most API routes for the application.
 * 
 * Route handlers are being progressively extracted to functions/api/routes/
 * for better maintainability.
 */

import { handleLogin, handleRegister, handleMe } from './routes/auth.js';
import { handleProfilesList, handleProfilesStats, handleProfilesBulkSave, handleProfilesShare, handleProfilesBatchUpdateFbLanguage, handleProfilesUpdateAccountStatus, handleProfilesUpdateLoginStatus, handleProfilesBatchDelete, handleProfilesGetById, handleProfilesUpdateById } from './routes/profiles.js';
import { handleAdAccountsList, handleAdAccountsBulkSave, handleAdAccountsBatchDelete, handleAdAccountsFillSeq, handleAdAccountsUpdateById, handleAdsList, handleAdsBulkSave } from './routes/adaccounts.js';
import { handlePagesList, handlePagesBulkSave, handlePagesBatchDelete, handlePagesAssignOperator } from './routes/pages.js';
import { handleUploadTemp, handleUploadsGet } from './routes/uploads.js';
import { handleBusinessesList, handleBusinessesBulkSave, handleBusinessesSetInvite } from './routes/businesses.js';
import { handlePostsList, handlePostsBulkSave, handlePostsBatchDelete, handlePostsEngagementBulkSave, handlePostsEngagementGet, handlePostsCommentPatch } from './routes/posts.js';
import { handleMessagesList, handleMessagesBulkSave, handleMessagesBatchDelete } from './routes/messages.js';
import { handleSettingsList, handleSettingsBulkSave } from './routes/settings.js';
import { handleRechargeCreate, handleRechargeOrders, handleRechargeConfig, handleRechargeAdminConfigGet, handleRechargeAdminConfigSave, handleRechargeAdminConfirm, handleRechargeAdminReject } from './routes/recharge.js';
import { handleInsightsBulkSave, handleInsightsList } from './routes/insights.js';
import { handleAiAssetsList, handleAiAssetsBulkSave, handleAiAssetsDelete } from './routes/ai-assets.js';
import { handlePrivateEmailsIngest, handlePrivateEmailsList, handlePrivateEmailsDetail, handlePrivateEmailsSeen } from './routes/private-emails.js';
import { handleShopProductsList, handleShopOrderCreate, handleShopOrderQuery, handleShopAdminProducts, handleShopAdminProductSave, handleShopAdminProductDelete, handleShopAdminOrders, handleShopAdminOrderConfirmPaid, handleShopAdminOrderDeliver, handleShopAdminOrderCancel, handleShopAdminPayInfoSave, handleShopAdminLogin, handleShopAdminMe, handleShopAdminChangePassword, handleShopBuyerLogin, handleShopBuyerMe, handleShopBuyerSetPassword, handleShopBuyerOrders, handleShopAdminBlocks, handleShopAdminBlockSave, handleShopAdminBlockDelete } from './routes/shop.js';

// AI 路由认证：X-Api-Secret 等于 PUPPETEER_API_SECRET，或 Bearer token 结构合法(id:email:role)
function aiAuthorized(request) {
  const apiSecret = request.headers.get('X-Api-Secret');
  if (apiSecret && apiSecret === process.env.PUPPETEER_API_SECRET) return true;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  try {
    const parts = atob(auth.slice(7).trim()).split(':');
    return parts.length >= 3 && !!Number(parts[0]);
  } catch { return false; }
}

const aiJson = (obj, status = 200, corsHeaders) =>
  new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });

// 服务端工具 list_profiles：复用 handleProfilesList（权限/分页逻辑一致），只取编号与总数
async function listProfilesForAi(request, env) {
  const url = new URL(request.url);
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', '500');
  const innerReq = new Request(url.toString(), {
    method: 'GET',
    headers: { Authorization: request.headers.get('Authorization') || '' },
  });
  const resp = await handleProfilesList(innerReq, env, { 'Access-Control-Allow-Origin': '*' });
  let j;
  try { j = await resp.json(); } catch { j = {}; }
  if (!j || j.success === false) throw new Error((j && j.message) || 'list_profiles failed');
  const rows = Array.isArray(j.data) ? j.data : [];
  const total = (j.pagination && typeof j.pagination.total === 'number') ? j.pagination.total : rows.length;
  const ids = rows.map(p => p && p.id).filter(Boolean).sort((a, b) => Number(a) - Number(b));
  return { success: true, total, listedCount: ids.length, truncated: ids.length < total, profileIds: ids };
}

// 服务端工具统一入口：list_profiles / list_pages / list_businesses / list_adaccounts / list_ads / list_pixels
const ASSET_LIST_HANDLERS = {
  list_pages: handlePagesList,
  list_businesses: handleBusinessesList,
  list_adaccounts: handleAdAccountsList,
  list_ads: handleAdsList,
};

// 各类型资产对外展示用的主键字段（按表结构区分，避免误取 account_id 当广告 id）
const TYPE_ID_KEYS = {
  profiles: ['id'],
  pages: ['page_id', 'id'],
  businesses: ['id', 'business_id'],
  adaccounts: ['account_id', 'id'],
  ads: ['ad_id', 'id'],
  pixels: ['pixel_id', 'id'],
};
const ASSET_NAME_KEYS = ['name', 'page_name', 'account_name', 'business_name', 'ad_name', 'adaccount_name', 'pixel_name'];

// 把行数据归一成 {id,name,profileId,accountId} 列表；总数在未分页截断时即条数
function summarizeAssetRows(type, rows, profileId) {
  const scoped = Array.isArray(rows)
    ? (profileId ? rows.filter(r => r && String(r.profile_id) === String(profileId)) : rows)
    : [];
  const idKeys = TYPE_ID_KEYS[type] || ['id'];
  const items = [];
  const seen = new Set();
  for (const r of scoped) {
    const idVal = idKeys.map(k => r && r[k]).find(v => v !== undefined && v !== null && String(v) !== '');
    if (idVal === undefined) continue;
    const key = String(idVal);
    if (seen.has(key)) continue;
    seen.add(key);
    const nmVal = ASSET_NAME_KEYS.map(k => r && r[k]).find(v => v !== undefined && v !== null && String(v) !== '');
    items.push({
      id: key,
      name: nmVal !== undefined ? String(nmVal) : '',
      profileId: (r && r.profile_id !== undefined && r.profile_id !== null) ? String(r.profile_id) : undefined,
      accountId: (r && r.account_id !== undefined && r.account_id !== null) ? String(r.account_id) : undefined,
    });
  }
  return {
    success: true,
    type,
    total: items.length,
    listed: items.length,
    truncated: false,
    items: items.slice(0, 300),
  };
}

// pixels 没有独立列表导出函数，这里复刻 /api/pixels GET 的查询（含 accountId 过滤）
async function listPixelsRowsForAi(request, env, args) {
  const authHeader = request.headers.get('Authorization') || '';
  let uId = 0, uRole = '';
  try {
    const parts = atob(authHeader.replace(/^Bearer\s+/i, '').trim()).split(':');
    uId = parts[0]; uRole = parts[2] || '';
  } catch {}
  let query = `SELECT p.*, u.email AS owner_email FROM pixels p LEFT JOIN users u ON p.user_id = u.id WHERE (p.user_id = ? OR ? = 'superadmin')`;
  const params = [Number(uId) || 0, uRole];
  const profileId = args && args.profileId ? String(args.profileId) : undefined;
  const accountId = args && args.accountId ? String(args.accountId) : undefined;
  if (uRole !== 'superadmin' && profileId) { query += ` AND p.profile_id = ?`; params.push(profileId); }
  if (accountId) { query += ` AND p.account_id = ?`; params.push(accountId); }
  query += ` ORDER BY p.updated_at DESC`;
  const { results } = await env.DB.prepare(query).bind(...params).all();
  return results || [];
}

async function runServerAiTool(name, args, request, env) {
  if (name === 'list_profiles') return listProfilesForAi(request, env);
  if (name === 'list_proxies') return listProxiesForAi(request, env);
  if (name === 'list_ad_templates') return listAdTemplatesForAi(request, env);
  if (name === 'list_cards') return listCardsForAi(request, env);
  const profileId = args && args.profileId ? String(args.profileId) : undefined;

  let rows;
  let pageTotal;
  if (name === 'list_pixels') {
    rows = await listPixelsRowsForAi(request, env, args);
  } else {
    const handler = ASSET_LIST_HANDLERS[name];
    if (!handler) return { success: false, error: 'unknown server tool: ' + name };
    const url = new URL(request.url);
    url.searchParams.set('page', '1');
    url.searchParams.set('pageSize', '500');
    if (profileId) url.searchParams.set('profileIds', profileId);
    const innerReq = new Request(url.toString(), {
      method: 'GET',
      headers: { Authorization: request.headers.get('Authorization') || '' },
    });
    const resp = await handler(innerReq, env, { 'Access-Control-Allow-Origin': '*' });
    let j;
    try { j = await resp.json(); } catch { j = {}; }
    if (!j || j.success === false) throw new Error((j && j.message) || name + ' failed');
    rows = Array.isArray(j.data) ? j.data : [];
    if (j.pagination && typeof j.pagination.total === 'number') pageTotal = j.pagination.total;
  }

  const type = name.replace('list_', '');
  const summarized = summarizeAssetRows(type, rows, profileId);
  if (pageTotal !== undefined && !profileId) {
    summarized.total = pageTotal;
    summarized.truncated = summarized.items.length < pageTotal;
  } else if (!summarized.truncated && rows.length >= 500) {
    summarized.truncated = true;
  }
  return summarized;
}

// IP 代理列表（复刻 /api/proxies GET 的角色范围；仅返回安全字段，不含账号密码）
async function listProxiesForAi(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  let uId = 0;
  try { uId = Number(atob(authHeader.replace(/^Bearer\s+/i, '').trim()).split(':')[0]) || 0; } catch {}
  const { results: reqUserRes } = await env.DB.prepare('SELECT id, role, parent_id, permission_level FROM users WHERE id = ?').bind(uId).all();
  const reqUser = reqUserRes && reqUserRes[0];
  if (!reqUser) return { success: true, type: 'proxies', total: 0, listed: 0, truncated: false, items: [] };
  const normalizedRole = (reqUser.role || '').toLowerCase().trim();
  const permLevel = reqUser.permission_level || 'full';
  const teamRootId = reqUser.parent_id || reqUser.id;
  let query = 'SELECT id, type, host, port, provider, zone, country, city, label, channel, category, user_id, created_at FROM proxies';
  const params = [];
  if (normalizedRole === 'superadmin') {
    // superadmin 看全部
  } else if (permLevel === 'full') {
    query += ' WHERE (user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?) OR user_id = 1)';
    params.push(Number(teamRootId), Number(teamRootId));
  } else {
    query += ' WHERE (user_id = ? OR user_id = 1)';
    params.push(uId);
  }
  query += ' ORDER BY created_at DESC';
  const { results } = await env.DB.prepare(query).bind(...params).all();
  const rows = results || [];
  const items = rows.map(r => ({
    id: String(r.id || ''),
    host: String(r.host || ''),
    port: String(r.port || ''),
    location: [r.country, r.city].filter(Boolean).join(' '),
    provider: String(r.provider || ''),
    type: String(r.type || ''),
    zone: String(r.zone || ''),
    label: String(r.label || ''),
    channel: String(r.channel || ''),
    category: String(r.category || ''),
  }));
  return { success: true, type: 'proxies', total: rows.length, listed: rows.length, truncated: rows.length > 300, items: items.slice(0, 300) };
}

// 广告模板列表（与 /api/ad-templates GET 一致：仅查请求者自己的模板，避免泄露他人配置）
async function listAdTemplatesForAi(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  let uId = 0;
  try { uId = Number(atob(authHeader.replace(/^Bearer\s+/i, '').trim()).split(':')[0]) || 0; } catch {}
  const { results } = await env.DB.prepare('SELECT id, name, is_default, created_at, updated_at FROM ad_templates WHERE user_id = ? ORDER BY updated_at DESC').bind(uId).all();
  const rows = results || [];
  const items = rows.map(r => ({
    id: String(r.id || ''),
    name: String(r.name || ''),
    isDefault: r.is_default ? 1 : 0,
    updatedAt: String(r.updated_at || ''),
  }));
  return { success: true, type: 'ad_templates', total: rows.length, listed: rows.length, truncated: rows.length > 300, items: items.slice(0, 300) };
}

// 支付卡片（账单卡片）列表：与 /api/billing-methods GET 一致，返回尾号等脱敏字段
async function listCardsForAi(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  let uId = 0, uRole = '';
  try {
    const parts = atob(authHeader.replace(/^Bearer\s+/i, '').trim()).split(':');
    uId = parts[0]; uRole = parts[2] || '';
  } catch {}
  let query = 'SELECT m.id, m.profile_id, m.account_id, m.type, m.last4, m.brand, m.exp_month, m.exp_year, m.created_at, u.email AS owner_email FROM billing_methods m LEFT JOIN users u ON m.user_id = u.id';
  const params = [];
  if (uRole !== 'superadmin' && uId) {
    query += ' WHERE (m.user_id = ? OR m.user_id IN (SELECT id FROM users WHERE parent_id = ?))';
    params.push(Number(uId), Number(uId));
  }
  query += ' ORDER BY m.created_at DESC';
  const { results } = await env.DB.prepare(query).bind(...params).all();
  const rows = results || [];
  const items = rows.map(r => ({
    id: String(r.id || ''),
    last4: String(r.last4 || ''),
    brand: String(r.brand || ''),
    type: String(r.type || ''),
    expMonth: String(r.exp_month || ''),
    expYear: String(r.exp_year || ''),
    accountId: String(r.account_id || ''),
    profileId: String(r.profile_id || ''),
  }));
  return { success: true, type: 'cards', total: rows.length, listed: rows.length, truncated: rows.length > 300, items: items.slice(0, 300) };
}

// —— 团队管理：用户「最后活跃时间」埋点 ——
// 带 Authorization 的请求按用户节流写入 users.last_active_at（同一用户 60s 内只写一次，避免高频轮询打爆 DB）
const _lastActiveWriteAt = new Map();
let _lastActiveColReady = false;
function touchUserActive(env, uid) {
  const id = Number(uid);
  if (!id) return;
  const now = Date.now();
  if (now - (_lastActiveWriteAt.get(id) || 0) < 60000) return;
  _lastActiveWriteAt.set(id, now);
  // 后台异步写，不阻塞请求
  (async () => {
    try {
      if (!_lastActiveColReady) {
        try { await env.DB.exec(`ALTER TABLE users ADD COLUMN last_active_at VARCHAR(32) NULL`); } catch { /* 已存在 */ }
        _lastActiveColReady = true;
      }
      await env.DB.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).bind(new Date().toISOString(), id).run();
    } catch { /* 埋点失败不影响主流程 */ }
  })();
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS Headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Secret',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // --- 临时邮箱代理：/api/mailtm-proxy/* → https://api.mail.tm，/api/mailgw-proxy/* → https://api.mail.gw ---
  // 上游不返回 Access-Control-Allow-Origin，浏览器直连会被 CORS 拦截；由服务端转发并补 CORS 头。
  const mailProxy = [
    { prefix: '/api/mailtm-proxy', target: 'https://api.mail.tm' },
    { prefix: '/api/mailgw-proxy', target: 'https://api.mail.gw' },
  ].find(t => path === t.prefix || path.startsWith(`${t.prefix}/`));
  if (mailProxy) {
    const targetUrl = mailProxy.target + (path.slice(mailProxy.prefix.length) || '/') + (url.search || '');
    const fwdHeaders = new Headers(request.headers);
    for (const h of ['host', 'content-length', 'accept-encoding', 'connection', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto']) fwdHeaders.delete(h);
    if (!fwdHeaders.get('accept')) fwdHeaders.set('Accept', 'application/json');
    let upstream;
    try {
      let body;
      if (method !== 'GET' && method !== 'HEAD') {
        const buf = await request.arrayBuffer();
        body = buf && buf.byteLength > 0 ? buf : undefined;
      }
      upstream = await fetch(targetUrl, { method, headers: fwdHeaders, body, redirect: 'follow' });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: 'mail gateway unreachable', detail: e && e.message }), { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } });
    }
    const proxyHeaders = new Headers(upstream.headers);
    // 上游可能被自动解压，去掉 encoding/length 以免浏览器按压缩流解析而失败
    for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) proxyHeaders.delete(h);
    proxyHeaders.set('Access-Control-Allow-Origin', '*');
    proxyHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    proxyHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Secret');
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, statusText: upstream.statusText, headers: proxyHeaders });
  }

  // --- 临时邮箱（自有域名收信）：Email Worker 转发落库 + 前端读取 ---
  // 说明见 routes/private-emails.js。放在邮件代理旁边，与主站路由完全隔离。
  if (path === '/api/private-emails/ingest' && method === 'POST') {
    return handlePrivateEmailsIngest(request, env, corsHeaders);
  }
  if (path === '/api/private-emails/list' && method === 'GET') {
    return handlePrivateEmailsList(request, env, corsHeaders);
  }
  if (path === '/api/private-emails/detail' && method === 'GET') {
    return handlePrivateEmailsDetail(request, env, corsHeaders);
  }
  if (path === '/api/private-emails/seen' && method === 'POST') {
    return handlePrivateEmailsSeen(request, env, corsHeaders);
  }

  // --- 商城（BM/账号售卖）：买家侧公开接口（无密码下单/查单）---
  if (path === '/api/shop/products' && method === 'GET') {
    return handleShopProductsList(request, env, corsHeaders);
  }
  if (path === '/api/shop/orders' && method === 'POST') {
    return handleShopOrderCreate(request, env, corsHeaders);
  }
  if (path === '/api/shop/orders/query' && method === 'GET') {
    return handleShopOrderQuery(request, env, corsHeaders);
  }
  // --- 商城买家账号（下单自动建号；独立于商城管理员与主系统账号）---
  if (path === '/api/shop/buyer/login' && method === 'POST') {
    return handleShopBuyerLogin(request, env, corsHeaders);
  }
  if (path === '/api/shop/buyer/me' && method === 'GET') {
    return handleShopBuyerMe(request, env, corsHeaders);
  }
  if (path === '/api/shop/buyer/password' && method === 'POST') {
    return handleShopBuyerSetPassword(request, env, corsHeaders);
  }
  if (path === '/api/shop/buyer/orders' && method === 'GET') {
    return handleShopBuyerOrders(request, env, corsHeaders);
  }
  // --- 商城块（货架）管理 ---
  if (path === '/api/shop/admin/blocks' && method === 'GET') {
    return handleShopAdminBlocks(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/blocks/save' && method === 'POST') {
    return handleShopAdminBlockSave(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/blocks/delete' && method === 'POST') {
    return handleShopAdminBlockDelete(request, env, corsHeaders);
  }
  // --- 商城管理员：独立账号体系（shop_admins），与主系统用户完全隔离 ---
  if (path === '/api/shop/admin/login' && method === 'POST') {
    return handleShopAdminLogin(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/me' && method === 'GET') {
    return handleShopAdminMe(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/change-password' && method === 'POST') {
    return handleShopAdminChangePassword(request, env, corsHeaders);
  }
  // --- 商城管理侧：人工确认收款 / 发货 / 商品管理 ---
  if (path === '/api/shop/admin/products' && method === 'GET') {
    return handleShopAdminProducts(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/products/save' && method === 'POST') {
    return handleShopAdminProductSave(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/products/delete' && method === 'POST') {
    return handleShopAdminProductDelete(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/orders' && method === 'GET') {
    return handleShopAdminOrders(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/orders/confirm-paid' && method === 'POST') {
    return handleShopAdminOrderConfirmPaid(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/orders/deliver' && method === 'POST') {
    return handleShopAdminOrderDeliver(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/orders/cancel' && method === 'POST') {
    return handleShopAdminOrderCancel(request, env, corsHeaders);
  }
  if (path === '/api/shop/admin/pay-info' && method === 'POST') {
    return handleShopAdminPayInfoSave(request, env, corsHeaders);
  }

  // 「最后活跃」埋点：带已登录 token 的请求按用户节流记录（登录成功另有 last_login 写入）
  try {
    const _ah = request.headers.get('Authorization') || '';
    if (_ah.startsWith('Bearer ')) {
      const _uid = Number(atob(_ah.slice(7).trim()).split(':')[0]);
      if (_uid > 0) touchUserActive(env, _uid);
    }
  } catch { /* token 结构非法则忽略 */ }

  // --- AI 路由（补全：原线上旧函数编译包中存在 /api/ai/chat、/api/ai/gemini，此处按宝塔版复刻）---

  // POST /api/ai/chat — DeepSeek 对话（前端 AIChat 使用）
  if (path === '/api/ai/chat' && method === 'POST') {
    if (!aiAuthorized(request)) return aiJson({ success: false, message: 'Unauthorized' }, 401, corsHeaders);
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return aiJson({ success: false, error: 'DEEPSEEK_API_KEY not configured' }, 500, corsHeaders);
    try {
      const body = await request.json();
      let messages = Array.isArray(body.messages) && body.messages.length
        ? body.messages
        : [{ role: 'user', content: String(body.prompt || body.message || '') }];
      // 引导模型把“启动/打开配置 XXX”映射成工具调用，而不是只回文字
      if (!messages.some(m => m && m.role === 'system')) {
        messages = [{
          role: 'system',
          content: '你是 OmniFingerprint 管理后台的 AI 助手。规则：\n1. 用户要求“启动/打开/运行 配置 XXX”或“启动 XXX 账号配置”时（XXX 为数字编号），必须调用 launch_browser 工具并把该编号填入 profileId，不要只回复文字。\n2. 用户要求“关闭/停止/退出 配置 XXX”“关闭浏览器 XXX”“把 XXX 的浏览器关掉”时，必须调用 stop_browser 工具并把该编号填入 profileId；一次只关闭一个配置。\n3. 用户询问“当前运行/启动了哪些浏览器、运行了几个、数量多少”之类问题时，你无法从历史对话推断，必须调用 list_running_browsers 工具，拿到返回结果后再如实回答，绝不能凭空猜测。\n4. 用户询问某一类数据/资产的数量或列表时，必须调用对应工具查询并如实回答，不能说自己“无法读取”或靠猜：配置→list_profiles，Page(Facebook 主页)→list_pages，Meta 商务管理平台 BM→list_businesses，Meta 广告账户→list_adaccounts，广告(Ad)→list_ads，Facebook 像素(Pixel)→list_pixels，IP 代理→list_proxies，广告模板→list_ad_templates，支付卡片/账单卡片→list_cards。其中 list_profiles 返回的 profileIds 就是当前账号可见的全部配置编号（升序数组，未截断时含全部编号）+ total 总数：用户要求“列出/遍历全部配置编号”，或要对“所有配置”批量执行操作时，必须直接使用该 profileIds 数组逐个发起调用，严禁回答“工具只返回总数、不返回编号明细”“无法列出所有配置编号”之类的话。\n5. 若问题限定在某个配置或账户范围（如“配置3906有哪些Page/广告账户”“广告账户 xxx 有哪些像素/广告”），用对应工具的 profileId / accountId 参数指定范围。\n6. 批量浏览器操作：当用户一次要求启动/关闭多个配置时（如“启动4208、4207、4206”“把4208/4207/4206关掉”“全部关掉正在运行的”），可在同一条回复中并列返回多个 launch_browser / stop_browser 调用（每个配置一个）；若要求“全部关闭”，先调用 list_running_browsers 拿到运行清单再逐个 stop_browser。\n7. 对已经存在的 广告(Ad)/广告组(AdSet)/广告系列(Campaign) 执行 启动/停止/归档 时，只有拿到对应 FB 对象编号和配置编号后才能调用 manage_ads / manage_adsets / manage_campaigns，绝不编造编号；对象编号只能来自 list_ads 的查询结果或用户明确给出，无法从对话中得知时，应明确告知用户需要先在界面里选择。\n8. 除上述明确支持的动作外，不得声称已执行任何未实际执行的操作。\n9. 当用户要求“用广告模板发布”“按保存的模板在配置 XXX 发广告”“批量发布广告”等时：先用 list_ad_templates 查询可用模板，与用户确认具体模板与目标配置编号后，为每个目标配置并列调用一次 publish_ad（profileId=配置编号，templateId=模板 id）。发布会真实执行在本机浏览器/FB 上；绝不编造广告文案素材、不臆造模板 id；若没有可用模板，应引导用户先在“广告模板”中用一键智能发布保存好文案/素材/落地页后再发布。\n10. 当用户要求“获取信息/刷新信息/同步最新资产/更新数据”并指向某个/某些配置时，为每个配置并列调用一次 get_info（参数 profileId）。该操作会真实启动或复用本机浏览器抓取该配置的 FB 广告账户/Page/BM/Pixel 资产并刷新云端数据库；必须以工具返回结果如实汇报，禁止伪造抓取结果。\n11. 当用户要求“打开广告图书馆 / Ad Library”“查看最热门广告/热门广告”“在配置 XXX 的浏览器里搜索广告”“浏览 Facebook 广告页面”并给出配置编号（可附带关键词/主页名）时，调用 browse_ads_library（profileId 必填，q=关键词、country=国家代码、url=自定义地址可选）。该工具会真实在该配置的本机浏览器中打开页面并抓取首屏文本与广告链接；页面内的点击/翻页等后续步骤，用户可在弹出的浏览器窗口中继续，或再次告诉我读取新的内容；禁止编造页面标题、广告内容或链接。\n12. 当用户要求“拉取/获取广告贴文、主页贴文、消息对话、收件箱消息、贴文拉取”“把配置 XXX 的贴文/消息同步到云端”等时，调用 fetch_posts 工具：若已明确配置编号，直接调用 fetch_posts（profileId=配置编号）；若用户未指明是哪个配置，先调用 list_profiles 拿到可用配置列表并询问用户选择哪个配置，再携带 profileId 调用 fetch_posts。该工具会真实启动/复用该配置的本机浏览器，抓取其主页广告贴文与收件箱对话消息并同步到云端数据库；必须以工具返回结果如实汇报，禁止伪造抓取结果。\n13. 批量执行必须分批：launch_browser / get_info / fetch_posts / publish_ad / browse_ads_library 这些工具会真实占用本机浏览器（本机一次只能跑有限个），且客户端是串行执行、每个约 30~60 秒。因此当需要对很多配置执行此类操作时，单次回复最多并列 10 个调用，并在文字里说明“本次执行 X 个、还剩 Y 个，继续请回复继续”；绝不一次性罗列几十上百个调用，那会让界面长时间无响应、看起来像卡死。',
        }, ...messages];
      }
      const tools = [{
        type: 'function',
        function: {
          name: 'launch_browser',
          description: '在本机启动某个账号配置对应的浏览器（用于登录/操作 FB 等账号）。当用户说“启动配置 3906”“打开配置 3906”“启动FB账号配置3906”等时调用。',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string', description: '要启动的配置编号（数字字符串），例如 "3906"' },
            },
            required: ['profileId'],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'stop_browser',
          description: '在本机关闭/停止某个账号配置对应的浏览器。当用户说“关闭配置 3906”“停止配置 3906”“关闭浏览器/停止 3906”“关闭FB账号配置3906”等时调用。一次只处理一个配置。',
          parameters: {
            type: 'object',
            properties: { profileId: { type: 'string', description: '要关闭的配置编号，例如 "3906"' } },
            required: ['profileId'],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_running_browsers',
          description: '查询本机当前正在运行的浏览器/配置及数量（从本地浏览器管理服务实时读取）。当用户问“现在运行着哪些浏览器/配置”“当前启动了几个浏览器”“有多少浏览器在运行”等时调用。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'manage_campaigns',
          description: '对已存在的 Meta 广告系列（Campaign）执行 启动/停止/归档。仅在用户明确给出 FB 对象编号、或从 list_ads 等查询结果获得后才能调用；参数 profileId 为配置编号、assetId 为 FB 广告系列对象编号、action 为 start/stop/archive。一次处理一个对象，批量时并列返回多个调用。',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string', description: '配置编号，例如 "3906"' },
              assetId: { type: 'string', description: 'FB 广告系列对象编号，例如 "120207058548602125"' },
              action: { type: 'string', enum: ['start', 'stop', 'archive'], description: 'start=启用/开始投放，stop=暂停，archive=归档' },
            },
            required: ['profileId', 'assetId', 'action'],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'manage_adsets',
          description: '对已存在的 Meta 广告组（AdSet）执行 启动/停止/归档。参数同上（profileId 配置编号、assetId 广告组对象编号、action start/stop/archive）。批量时并列返回多个调用。',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string', description: '配置编号，例如 "3906"' },
              assetId: { type: 'string', description: 'FB 广告组对象编号' },
              action: { type: 'string', enum: ['start', 'stop', 'archive'], description: 'start/stop/archive' },
            },
            required: ['profileId', 'assetId', 'action'],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'manage_ads',
          description: '对已存在的 Meta 广告（Ad）执行 启动/停止/归档。assetId 必须来自 list_ads 返回的广告对象编号或用户明确提供，不得编造。批量时并列返回多个调用。',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string', description: '配置编号，例如 "3906"' },
              assetId: { type: 'string', description: 'FB 广告对象编号（list_ads 查询结果中的 id）' },
              action: { type: 'string', enum: ['start', 'stop', 'archive'], description: 'start/stop/archive' },
            },
            required: ['profileId', 'assetId', 'action'],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'publish_ad',
          description: '用已保存的“广告模板”（需先在广告模板页/一键智能发布中保存好文案、素材、落地页等）在本机为某个账号配置发布广告。当用户说“用 XX 模板给配置 XXX 发广告”“按保存的模板批量发布”“用模板发布广告”时调用。参数：profileId=目标配置编号，templateId=list_ad_templates 返回的模板 id。一次只处理一个配置；若要在多个配置发布，同一回复并列返回多个 publish_ad。发布前必须先与用户确认模板与目标配置，禁止凭空编造模板 id 或广告内容。',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string', description: '要在哪个配置上发布广告，配置编号，例如 "3906"' },
              templateId: { type: 'string', description: '要使用的广告模板 id（list_ad_templates 返回结果中的 id），例如 "3"' },
            },
            required: ['profileId', 'templateId'],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'get_info',
          description: '等价于后台界面里的“获取信息”按钮（同步/刷新该配置的最新资产）：启动或复用本机浏览器，从 FB 抓取该配置的广告账户、Page、BM、Pixel 等资产并保存到云端数据库。当用户要求“获取信息/同步最新资产/刷新资产数据/按界面上的获取信息按钮操作”，或说“把配置 XXX 的信息更新一下/同步一下”时调用。参数 profileId=配置编号。一次只处理一个配置；多个配置时同一回复并列返回多个 get_info。该操作是真实抓取，结果以执行返回值/本机日志为准，禁止伪造。',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string', description: '要获取信息的配置编号，例如 "3906"' },
            },
            required: ['profileId'],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'fetch_posts',
          description: '拉取指定 Facebook 配置(profileId)的主页广告贴文与主页收件箱对话消息（会启动/复用浏览器，在目标配置的浏览器上调用本机抓取并把贴文/对话同步到云端）。当用户说“拉取/获取广告贴文、主页贴文、消息对话、收件箱消息、贴文拉取”“把配置 XXX 的贴文/消息同步一下”等时调用。参数 profileId=配置编号，可选；若用户未指明配置编号，应先调用 list_profiles 询问用户选择哪个配置。一次只处理一个配置；多个配置时同一回复并列返回多个 fetch_posts。该操作是真实抓取，结果以执行返回值/本机日志为准，禁止伪造。',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string', description: '可选。要拉取贴文/对话的配置编号，例如 "3906"；不填时需先用 list_profiles 让用户确认配置' },
            },
            required: [],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'browse_ads_library',
          description: '在指定账号配置的本机可见浏览器中打开 Facebook 广告图书馆（Ad Library）或指定 facebook 页面并读取首屏内容，用于“查看最热门的广告”、按品牌/主页关键词搜索广告。当用户说“打开广告图书馆”“查看最热广告/热门广告”“在配置 XXX 的浏览器里搜一下某品牌的广告”“帮我看看 Facebook 上的广告”时调用。参数：profileId=配置编号（必填），q=搜索的主页/品牌关键词（可选），country=国家代码（可选，默认 ALL），url=自定义页面地址（可选，缺省为广告图书馆首页）。调用后会真实打开可见浏览器标签并返回页面标题、正文摘要与广告链接。',
          parameters: {
            type: 'object',
            properties: {
              profileId: { type: 'string', description: '配置编号，例如 "3906"' },
              q: { type: 'string', description: '可选。要搜索的主页/品牌关键词，例如 "Nike"' },
              country: { type: 'string', description: '可选。国家代码（ISO 2 位或 ALL），默认 ALL' },
              url: { type: 'string', description: '可选。要打开的页面地址（facebook.com 广告库相关）；不传则按 q 搜索或打开广告图书馆首页' },
            },
            required: ['profileId'],
          },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_profiles',
          description: '查询当前账号可见的浏览器配置列表（来自云端配置库）。返回 profileIds=全部配置编号的升序数组（未截断时即全部编号，可直接逐个用于其它工具）、total=总数、truncated=是否被截断。当用户问“一共有多少个配置”“有哪些配置编号/可用配置”“配置列表”，或要求“对所有配置批量执行某操作”时调用；调用后必须基于 profileIds 里的真实编号继续，不得声称本工具只返回总数或无法列出编号明细。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_pages',
          description: '查询当前账号可见的 Facebook Page（主页）资产列表（总数与明细）。当用户问“有多少 Page/主页”“有哪些 Page”或“配置 XXX 有哪些 Page”时调用。',
          parameters: { type: 'object', properties: { profileId: { type: 'string', description: '可选。只查询某个配置编号下的 Page，例如 "3906"' } }, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_businesses',
          description: '查询当前账号可见的 Meta 商务管理平台（BM/BM ID）资产列表（总数与明细）。当用户问“有多少 BM”“有哪些 BM”“配置 XXX 有哪些 BM”时调用。',
          parameters: { type: 'object', properties: { profileId: { type: 'string', description: '可选。只查询某个配置编号下的 BM，例如 "3906"' } }, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_adaccounts',
          description: '查询当前账号可见的 Meta 广告账户资产列表（总数与明细）。当用户问“有多少广告账户/广告号”“有哪些广告账户”“配置 XXX 有哪些广告账户”时调用。',
          parameters: { type: 'object', properties: { profileId: { type: 'string', description: '可选。只查询某个配置编号下的广告账户，例如 "3906"' } }, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_ads',
          description: '查询当前账号可见的广告（Ad）列表（总数与明细）。当用户问“有多少广告”“有哪些广告”“配置 XXX 或广告账户 XXX 有哪些广告”时调用。',
          parameters: { type: 'object', properties: { profileId: { type: 'string', description: '可选。只查询某个配置编号下的广告，例如 "3906"' }, accountId: { type: 'string', description: '可选。只查询某个广告账户下的广告，例如 "act_123456789"' } }, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_pixels',
          description: '查询当前账号可见的 Facebook 像素（Pixel）列表（总数与明细）。当用户问“有多少像素”“有哪些像素”“配置 XXX 或广告账户 XXX 有哪些像素”时调用。',
          parameters: { type: 'object', properties: { profileId: { type: 'string', description: '可选。只查询某个配置编号下的像素，例如 "3906"' }, accountId: { type: 'string', description: '可选。只查询某个广告账户下的像素，例如 "act_123456789"' } }, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_proxies',
          description: '查询当前账号可见的 IP 代理列表（IP代理管理页数据：地址、地区、供应商等，不含账号密码）。当用户问“有多少代理/IP代理”“有哪些代理”“代理都在哪些国家”时调用。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_ad_templates',
          description: '查询当前账号自己的广告模板列表（名称、是否默认等）。当用户问“有多少广告模板”“有哪些广告模板”时调用。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }, {
        type: 'function',
        function: {
          name: 'list_cards',
          description: '查询当前账号可见的支付卡片列表（账单卡片：尾号/品牌/有效期等脱敏信息）。当用户问“有多少卡片/支付卡片”“绑了哪些卡”时调用。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }];
      const payload = { model: body.model || 'deepseek-chat', messages, tools, stream: false };
      if (body.temperature !== undefined) payload.temperature = body.temperature;
      if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = (data && data.error && (data.error.message || data.error.type)) || (data && data.message) || `DeepSeek API error ${resp.status}`;
        return aiJson({ success: false, error: msg }, 502, corsHeaders);
      }
      const choice = data.choices && data.choices[0];
      const msg = (choice && choice.message) || {};
      // DeepSeek 结构化工具调用 → 前端 AIChat 期望的 toolCalls 格式
      const parseToolCalls = (m) => {
        if (!Array.isArray(m.tool_calls) || !m.tool_calls.length) return undefined;
        return m.tool_calls.map(tc => {
          let args = {};
          try { args = (tc.function && tc.function.arguments) ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
          return { id: tc.id, name: tc.function && tc.function.name, arguments: args };
        });
      };
      let toolCalls = parseToolCalls(msg);
      const CLIENT_TOOLS = new Set(['launch_browser', 'stop_browser', 'list_running_browsers', 'manage_campaigns', 'manage_adsets', 'manage_ads', 'publish_ad', 'get_info', 'fetch_posts', 'browse_ads_library']);
      const SERVER_TOOLS = new Set(['list_profiles', 'list_pages', 'list_businesses', 'list_adaccounts', 'list_ads', 'list_pixels', 'list_proxies', 'list_ad_templates', 'list_cards']);

      // 服务端工具（读后端 DB）：由后端直接执行并把结果回喂模型，给出最终文本答案
      if (toolCalls && toolCalls.length && toolCalls.every(tc => SERVER_TOOLS.has(tc.name))) {
        const followMessages = [...messages, { role: 'assistant', content: null, tool_calls: msg.tool_calls }];
        for (let round = 0; round < 2; round++) {
          const results = [];
          for (const tc of toolCalls) {
            let out;
            try { out = await runServerAiTool(tc.name, tc.arguments || {}, request, env); }
            catch (err) { out = { success: false, error: (err && err.message) || String(err) }; }
            results.push({ id: tc.id, content: JSON.stringify(out) });
          }
          for (const r of results) followMessages.push({ role: 'tool', tool_call_id: r.id, content: r.content });

          const resp2 = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ ...payload, messages: followMessages }),
          });
          const data2 = await resp2.json();
          if (!resp2.ok) {
            const m2 = (data2 && data2.error && (data2.error.message || data2.error.type)) || (data2 && data2.message) || `DeepSeek API error ${resp2.status}`;
            return aiJson({ success: false, error: m2 }, 502, corsHeaders);
          }
          const choice2 = data2.choices && data2.choices[0];
          const msg2 = (choice2 && choice2.message) || {};
          const tc2 = parseToolCalls(msg2);
          if (tc2 && tc2.length && tc2.every(t => SERVER_TOOLS.has(t.name))) {
            toolCalls = tc2;
            followMessages.push({ role: 'assistant', content: null, tool_calls: msg2.tool_calls });
            continue;
          }
          return aiJson({
            success: true,
            message: msg2.content || (tc2 && tc2.length ? '正在执行操作…' : ''),
            reasoning: msg2.reasoning_content || null,
            toolCalls: tc2,
            raw: data2,
          }, 200, corsHeaders);
        }
      }

      return aiJson({
        success: true,
        message: msg.content || (toolCalls && toolCalls.length ? '正在执行操作…' : ''),
        reasoning: msg.reasoning_content || null,
        toolCalls,
        raw: data,
      }, 200, corsHeaders);
    } catch (e) {
      console.error('[ai/chat] error:', e && e.stack ? e.stack : e);
      return aiJson({ success: false, error: (e && e.message) || 'AI request failed' }, 500, corsHeaders);
    }
  }

  // POST /api/ai/gemini — 文案生成等（有 GEMINI_API_KEY 用 Gemini；没有则回退 DeepSeek，保证功能可用）
  if (path === '/api/ai/gemini' && method === 'POST') {
    if (!aiAuthorized(request)) return aiJson({ success: false, message: 'Unauthorized' }, 401, corsHeaders);
    try {
      const body = await request.json();
      const prompt = String(body.prompt || body.message || '');
      let text = '';
      let raw = null;
      const gKey = process.env.GEMINI_API_KEY;
      if (gKey) {
        const model = body.model || 'gemini-2.0-flash';
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: body.config || {} }),
        });
        const data = await resp.json();
        raw = data;
        text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
          data.candidates[0].content.parts[0].text) || '';
        if (!resp.ok && !text) {
          const msg = (data && data.error && data.error.message) || `Gemini API error ${resp.status}`;
          return aiJson({ success: false, error: msg }, 502, corsHeaders);
        }
      } else {
        const dKey = process.env.DEEPSEEK_API_KEY;
        if (!dKey) return aiJson({ success: false, error: 'No AI API key configured (GEMINI_API_KEY / DEEPSEEK_API_KEY)' }, 500, corsHeaders);
        const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dKey}` },
          body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], stream: false }),
        });
        const data = await resp.json();
        raw = data;
        text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        if (!resp.ok && !text) {
          const msg = (data && data.error && data.error.message) || `AI API error ${resp.status}`;
          return aiJson({ success: false, error: msg }, 502, corsHeaders);
        }
      }
      return aiJson({ success: true, text, data: raw }, 200, corsHeaders);
    } catch (e) {
      return aiJson({ success: false, error: (e && e.message) || 'AI request failed' }, 500, corsHeaders);
    }
  }

  // POST /api/ai/translate — 消息翻译 / 语言检测（消息对话页使用）
  // body: { texts: [string], to?: 'zh'|'en'|..., detect?: boolean（只检测语言不翻译）, engine?: 'ai'|'google'|'libre'|'geminiweb' }
  // 返回: { success, translations?: [string], detected?: 'zh', detectedName?: '中文', engine }
  // 🎛️ engine 由前端「翻译引擎」下拉手动切换（只做手动切换，不做自动降级）：
  //    ai        = Gemini 优先 → DeepSeek 兜底（按量付费，余额不足会直接报 Insufficient Balance）
  //    google    = clients5.google.com 免费端点。⚠️ 注意：常用的 translate.googleapis.com gtx 端点
  //                已被 Google 按机房 IP 反爬封禁（实测恒定 429「automated queries」，加 UA/Referer 无效），
  //                clients5 这个字典端点实测可用且支持批量。
  //    libre     = 宝塔自建 LibreTranslate（LIBRETRANSLATE_URL，默认 http://127.0.0.1:5000）
  //    geminiweb = 宝塔上的 gemini-web2api 桥（免费；GEMINI_WEB_URL 默认 http://127.0.0.1:8088，
  //                GEMINI_WEB_KEY 必填）。⚠️ 该容器是**共享**的（另一项目 adsplusgo.top 在用，
  //                配置以 bind-mount 挂在那个站点目录下），这里只读 key、绝不改动它的配置或密钥。
  // 🔍 语言检测（detect:true）固定「AI 优先 + 本地启发式兜底」，不随 engine 走：免费引擎的语种判断质量不稳。
  if (path === '/api/ai/translate' && method === 'POST') {
    if (!aiAuthorized(request)) return aiJson({ success: false, message: 'Unauthorized' }, 401, corsHeaders);
    try {
      const body = await request.json();
      let texts = Array.isArray(body.texts) && body.texts.length ? body.texts.map(t => String(t)) : [];
      if (!texts.length && body.text) texts = [String(body.text)];
      texts = texts.slice(0, 50);
      const to = body.to ? String(body.to) : 'zh';
      const detectOnly = body.detect === true;
      const engine = ['ai', 'google', 'libre', 'geminiweb'].includes(String(body.engine || '')) ? String(body.engine) : 'ai';
      const LANG_NAMES = { zh: '中文', en: 'English', tr: 'Türkçe', vi: 'Tiếng Việt', ar: 'العربية', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', id: 'Bahasa Indonesia', th: 'ไทย', ms: 'Bahasa Melayu', ja: '日本語', ko: '한국어', ru: 'Русский', it: 'Italiano', pl: 'Polski', nl: 'Nederlands', uk: 'Українська', fa: 'فارسی', he: 'עברית', hi: 'हिन्दी' };
      const targetLabel = LANG_NAMES[to] || to;
      // 目标语言代码别名：Google 用 zh-CN，LibreTranslate/Argos 用 zh
      const codeFor = (eng, lang) => (lang === 'zh' ? (eng === 'google' ? 'zh-CN' : 'zh') : lang);
      const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      // 本地启发式语言判断（AI 不可用时的兜底，覆盖消息对话支持的 20 个语种里能靠字符集区分的那批）
      const localDetect = (s) => {
        const t = String(s || '');
        if (/[\u3040-\u30ff]/.test(t)) return 'ja';              // 含假名 → 日语（要排在中文前）
        if (/[\uac00-\ud7af]/.test(t)) return 'ko';              // 谚文
        if (/[\u4e00-\u9fff]/.test(t)) return 'zh';              // 汉字
        if (/[\u0600-\u06ff]/.test(t)) return 'ar';              // 阿拉伯字母
        if (/[\u0400-\u04ff]/.test(t)) return 'ru';              // 西里尔字母
        if (/[\u0e00-\u0e7f]/.test(t)) return 'th';              // 泰文
        if (/[\u0590-\u05ff]/.test(t)) return 'he';
        if (/[\u0900-\u097f]/.test(t)) return 'hi';
        if (/[\u1ea0-\u1ef9]/.test(t) || /[ăđơư]/i.test(t)) return 'vi';  // 越南语特有声调符/字母
        if (/[ıİşŞğĞ]/.test(t)) return 'tr';
        return 'en';
      };

      // ---- Google 免费端点（clients5）：一次可带多个 q，实测支持批量 ----
      const googleTranslate = async (list, target) => {
        const translations = [];
        let detected = '';
        let i = 0;
        while (i < list.length) {
          const chunk = [];
          let len = 0;
          while (i < list.length && chunk.length < 20 && (chunk.length === 0 || len + list[i].length < 1200)) {
            len += list[i].length;
            chunk.push(list[i]);
            i++;
          }
          const qs = chunk.map(t => `&q=${encodeURIComponent(t)}`).join('');
          const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&dt=t&tl=${encodeURIComponent(codeFor('google', target))}${qs}`;
          const resp = await fetch(url, { headers: { 'User-Agent': UA_CHROME }, signal: AbortSignal.timeout(15000) });
          if (!resp.ok) {
            throw new Error(`Google 翻译失败 HTTP ${resp.status}${resp.status === 429 ? '（该服务器 IP 被 Google 限流）' : ''}`);
          }
          let data = null;
          try { data = await resp.json(); } catch { }
          if (!Array.isArray(data) || !data.length) throw new Error('Google 翻译返回格式异常');
          // 单条时是 ["译文","en"]，多条时是 [["译文","en"], ...] —— 统一成二维
          const rows = Array.isArray(data[0]) ? data : [data];
          rows.forEach(row => translations.push(String((row && row[0]) || '')));
          while (translations.length < i) translations.push('');   // 行数不足时补齐，保证与入参一一对应
          if (!detected) { const d = rows[0] && rows[0][1]; if (d) detected = String(d); }
        }
        return { translations, detected };
      };

      // ---- 自建 LibreTranslate ----
      const libreTranslate = async (list, target) => {
        const base = String(process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '');
        const translations = [];
        let detected = '';
        for (const t of list) {
          const resp = await fetch(`${base}/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: t, source: 'auto', target: codeFor('libre', target), format: 'text' }),
            signal: AbortSignal.timeout(30000),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || typeof data.translatedText !== 'string') {
            throw new Error(`LibreTranslate 失败 HTTP ${resp.status}${data && data.error ? ': ' + data.error : ''}`);
          }
          translations.push(data.translatedText);
          if (!detected && data.detectedLanguage && data.detectedLanguage.language) detected = String(data.detectedLanguage.language);
        }
        return { translations, detected };
      };

      // ---- AI 引擎（Gemini 优先 → DeepSeek 兜底）----
      const safeParseJson = async (resp, label) => {
        const rawText = await resp.text();
        if (!rawText) return {};
        try { return JSON.parse(rawText); } catch (pe) {
          throw new Error(`[${label}] AI 响应不是合法 JSON (HTTP ${resp.status})，前 200 字符: ${String(rawText).slice(0, 200)}`);
        }
      };
      const askAi = async (prompt) => {
        const gKey = process.env.GEMINI_API_KEY;
        const dKey = process.env.DEEPSEEK_API_KEY;
        if (gKey) {
          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
          });
          const data = await safeParseJson(resp, 'gemini');
          const content = (data.candidates && data.candidates[0] && data.candidates[0].content &&
            data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
            data.candidates[0].content.parts[0].text) || '';
          if (content) return content;
          throw new Error(`Gemini: ${(data && data.error && data.error.message) || `HTTP ${resp.status}`}`);
        }
        if (dKey) {
          const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dKey}` },
            body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2 }),
          });
          const data = await safeParseJson(resp, 'deepseek');
          const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
          if (content) return content;
          // 把上游原文（如 Insufficient Balance）透出来，否则前端只看到「翻译服务调用失败」
          throw new Error(`DeepSeek: ${(data && data.error && data.error.message) || `HTTP ${resp.status}`}`);
        }
        throw new Error('未配置 AI 密钥（GEMINI_API_KEY / DEEPSEEK_API_KEY）');
      };
      const pickJson = (content) => {
        const cleaned = String(content || '').replace(/```json/gi, '').replace(/```/g, '').trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch {} }
        try { return JSON.parse(cleaned); } catch {}
        return null;
      };

      // ---- Gemini Web 桥（宝塔上的 gemini-web2api 容器，免费；OpenAI 兼容 /v1/chat/completions）----
      // ⚠️ 这是**共享**容器：另一个项目 adsplusgo.top 也在调它（配置以 bind-mount 挂在那边的站点目录），
      //    所以这里只从环境变量读 key，绝不改动该容器的配置/密钥，也不要拿字面量 "****" 当 key
      //    （那是管理页把脱敏值回存进配置留下的假 key，重启后就不存在了）。
      // 它是聊天模型不是翻译 API，因此用「要求只输出 JSON 字符串数组」的提示词 + 批量一次多翻，
      // 并对模型偶尔多嘴/包 ```json 的情况做宽松解析。
      const geminiWebTranslate = async (list, target) => {
        const base = String(process.env.GEMINI_WEB_URL || 'http://127.0.0.1:8088').replace(/\/+$/, '');
        const key = String(process.env.GEMINI_WEB_KEY || '');
        const model = String(process.env.GEMINI_WEB_MODEL || 'gemini-3.5-flash');
        if (!key) throw new Error('未配置 GEMINI_WEB_KEY（Gemini Web 桥的 API key）');
        const translations = [];
        let i = 0;
        while (i < list.length) {
          const chunk = [];
          let len = 0;
          while (i < list.length && chunk.length < 20 && (chunk.length === 0 || len + list[i].length < 1200)) {
            len += list[i].length;
            chunk.push(list[i]);
            i++;
          }
          const resp = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model, stream: false, temperature: 0,
              messages: [
                { role: 'system', content: 'You are a translation engine. Translate every input text into the requested target language, keeping emoji, person names and URLs unchanged. Output ONLY a JSON array of strings whose length and order match the input exactly — no markdown fence, no explanation.' },
                { role: 'user', content: `Target language: ${targetLabel}\nInput texts:\n${JSON.stringify(chunk)}` },
              ],
            }),
            signal: AbortSignal.timeout(60000),
          });
          const data = await resp.json().catch(() => ({}));
          const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
          if (!content) {
            throw new Error(`Gemini Web 失败 HTTP ${resp.status}${data && data.error && data.error.message ? ': ' + data.error.message : ''}`);
          }
          const cleaned = String(content).replace(/```json/gi, '').replace(/```/g, '').trim();
          let arr = null;
          const am = cleaned.match(/\[[\s\S]*\]/);
          if (am) { try { arr = JSON.parse(am[0]); } catch {} }
          if (!Array.isArray(arr)) { try { const o = JSON.parse(cleaned); if (o && Array.isArray(o.translations)) arr = o.translations; } catch {} }
          // 实在解析不出来：单条时退化成「整段当译文」，多条时补空，保证长度对齐不串行
          if (!Array.isArray(arr)) arr = chunk.length === 1 ? [cleaned] : [];
          arr.forEach(v => translations.push(v == null ? '' : String(v)));
          while (translations.length < i) translations.push('');
        }
        return { translations, detected: '' };
      };

      // ---- 语言检测：AI 优先 → 本地启发式兜底（永不因 AI 挂掉而失败）----
      if (detectOnly) {
        const one = String(texts[0] || '');
        let detected = '';
        let detectSource = 'local';
        try {
          const out = pickJson(await askAi(`请判断以下文本属于哪种语言（社交媒体短消息，可能含表情/网址/无意义字符）。\n严格只返回一个 JSON 对象，不要任何解释：{"detected":"两字母语言代码(如 zh/en/tr/vi/ar)，无法判断则 en","detectedName":"该语言的本地名称"}\n文本：${JSON.stringify(one)}`));
          if (out && out.detected) { detected = String(out.detected); detectSource = 'ai'; }
        } catch (aiErr) { /* AI 不可用（余额/网络/密钥）→ 静默落到本地启发式 */ }
        if (!detected) detected = localDetect(one);
        return aiJson({ success: true, detected, detectedName: LANG_NAMES[detected] || detected, detectSource }, 200, corsHeaders);
      }

      // ---- 免费引擎：直接在服务端算完返回，不走 AI ----
      if (engine === 'google' || engine === 'libre' || engine === 'geminiweb') {
        const idx = [];
        const list = [];
        texts.forEach((t, i) => { const v = String(t || ''); if (v.trim()) { idx.push(i); list.push(v); } });
        if (!list.length) return aiJson({ success: true, translations: texts.map(() => ''), detected: '', detectedName: '', engine }, 200, corsHeaders);
        const r = engine === 'google' ? await googleTranslate(list, to)
          : engine === 'libre' ? await libreTranslate(list, to)
            : await geminiWebTranslate(list, to);
        const translations = texts.map(() => '');
        idx.forEach((pos, k) => { translations[pos] = String((r.translations && r.translations[k]) || ''); });
        return aiJson({ success: true, translations, detected: r.detected || '', detectedName: LANG_NAMES[r.detected] || r.detected || '', engine }, 200, corsHeaders);
      }

      // ---- AI 引擎 ----
      let out = null;
      const content = await askAi(`你是专业翻译引擎。请把以下每条文本翻译成【${targetLabel}】。保持语气自然口语化，保留 emoji/人名/网址不变。\n严格只返回一个 JSON 对象，不要任何解释：{"detected":"原文主要语言两字母代码","translations":["译文数组，与输入一一对应，空文本返回空字符串"]}\n输入文本：${JSON.stringify(texts)}`);
      out = pickJson(content);
      if (!out || typeof out !== 'object') {
        return aiJson({ success: true, translations: texts.map(() => content.trim()), detected: '', detectedName: '', engine }, 200, corsHeaders);
      }
      return aiJson({
        success: true,
        translations: Array.isArray(out.translations) ? out.translations : texts.map(() => ''),
        detected: out.detected || '',
        detectedName: out.detectedName || LANG_NAMES[out.detected] || '',
        engine,
      }, 200, corsHeaders);
    } catch (e) {
      return aiJson({ success: false, error: (e && e.message) || 'AI request failed', engine: 'unknown' }, 502, corsHeaders);
    }
  }

  try {
    // --- [baota-backend] 运行期初始化/迁移块已移除：schema 由 sql/schema-mysql.sql 预建，数据经 D1 导出导入 ---
    const parseRawProxy = (str) => {
      const s = String(str||'').trim();
      if (!s) return null;
      let type = 'http', rest = s;
      const m = s.match(/^(https?|socks5|residential):\/\//i);
      if (m) { const sch = m[1].toLowerCase(); type = sch==='socks5'?'socks5':(sch==='residential'?'residential':'http'); rest = s.replace(/^(https?|socks5|residential):\/\//i,''); }
      let username = '', password = '', host = '', port = '';
      if (rest.includes('@')) {
        const [cred, hostpart] = rest.split('@');
        const [u,p] = cred.split(':'); username = u||''; password = p||'';
        const [h,pt] = hostpart.split(':'); host = h||''; port = pt||'';
      } else {
        const parts = rest.split(':');
        if (parts.length===2) { host = parts[0]; port = parts[1]; }
        else if (parts.length===4) { host=parts[0]; port=parts[1]; username=parts[2]; password=parts[3]; }
        else return null;
      }
      if (!host || !port) return null;
      return { type, host, port, username, password, provider: '', zone: '', country: '', city: '', session: '', rotation: '', label: '', channel: '', category: '' };
    };
    const getLegacyAccountName = (raw) => {
      if (!raw || typeof raw !== 'string') return '';
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
          return parsed.name;
        }
      } catch {}
      return '';
    };

    // --- ROUTES ---

    // 1. Auth API — § 路由已提取至 functions/api/routes/auth.js
    if (path === '/api/auth/login' && method === 'POST') {
      return handleLogin(request, env, corsHeaders);
    }

    if (path === '/api/auth/register' && method === 'POST') {
      return handleRegister(request, env, corsHeaders);
    }

    if (path === '/api/auth/me' && method === 'GET') {
      return handleMe(request, env, corsHeaders);
    }

    // 1.5 U 充值（TRC20-USDT，随机小数定位订单 + TronGrid 自动对账）
    if (path === '/api/recharge/create' && method === 'POST') {
      return handleRechargeCreate(request, env, corsHeaders);
    }
    if (path === '/api/recharge/orders' && method === 'GET') {
      return handleRechargeOrders(request, env, corsHeaders);
    }
    if (path === '/api/recharge/config' && method === 'GET') {
      return handleRechargeConfig(request, env, corsHeaders);
    }
    if (path === '/api/recharge/admin/config' && method === 'GET') {
      return handleRechargeAdminConfigGet(request, env, corsHeaders);
    }
    if (path === '/api/recharge/admin/config' && method === 'POST') {
      return handleRechargeAdminConfigSave(request, env, corsHeaders);
    }
    if (path === '/api/recharge/admin/confirm' && method === 'POST') {
      return handleRechargeAdminConfirm(request, env, corsHeaders);
    }
    if (path === '/api/recharge/admin/reject' && method === 'POST') {
      return handleRechargeAdminReject(request, env, corsHeaders);
    }

    // 1.6 广告数据追踪（Meta insights，本地后端抓取后推上来）
    if (path === '/api/insights/bulk-save' && method === 'POST') {
      return handleInsightsBulkSave(request, env, corsHeaders);
    }
    if (path === '/api/insights' && method === 'GET') {
      return handleInsightsList(request, env, corsHeaders);
    }

    // 2. Profiles Collection API
    if (path === '/api/profiles' && method === 'GET') {
      return handleProfilesList(request, env, corsHeaders);
    }

    // 2.0 Profiles Stats (轻量统计，供 Dashboard 使用)
    if (path === '/api/profiles/stats' && method === 'GET') {
      return handleProfilesStats(request, env, corsHeaders);
    }

    // 2.1 Profiles Bulk Save (Upsert)
    if (path.includes('/api/profiles/bulk-save') && method === 'POST') {
      return handleProfilesBulkSave(request, env, corsHeaders);
    }

    // 🚀 POST /api/profiles/share — 配置分享/转移
    if (path === '/api/profiles/share' && method === 'POST') {
      return handleProfilesShare(request, env, corsHeaders);
    }

    // 🌐 Profiles Batch Update FB Language
    if (path === '/api/profiles/batch-update-fb-language' && method === 'POST') {
      return handleProfilesBatchUpdateFbLanguage(request, env, corsHeaders);
    }

    // 🌐 Profiles Batch Update Account Status
    if (path === '/api/profiles/update-account-status' && method === 'POST') {
      return handleProfilesUpdateAccountStatus(request, env, corsHeaders);
    }

    // 🔐 Profiles Batch Update Login Status
    if (path === '/api/profiles/update-login-status' && method === 'POST') {
      return handleProfilesUpdateLoginStatus(request, env, corsHeaders);
    }

    // 2.2 Profiles Batch Delete
    if (path.includes('/api/profiles/batch-delete') && method === 'POST') {
      return handleProfilesBatchDelete(request, env, corsHeaders);
    }

    // 2.2.1 AdAccounts Batch Delete
    if (path.includes('/api/adaccounts/batch-delete') && method === 'POST') {
      return handleAdAccountsBatchDelete(request, env, corsHeaders);
    }

    // 2.2.2 Pages Batch Delete
    if (path.includes('/api/pages/batch-delete') && method === 'POST') {
      return handlePagesBatchDelete(request, env, corsHeaders);
    }

    // 2.2.3 Proxies CRUD
    const PROXY_FIELDS = 'id, user_id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, failed_count, created_at, updated_at';
    // GET /api/proxies — 🚀 添加用户数据隔离（参照 profiles 列表 RBAC）
    if (path.includes('/api/proxies') && method === 'GET' && !path.includes('test')) {
      try {
        const apiSecret = request.headers.get('X-Api-Secret');
        let uId, uRole;
        // 支持 PUP 服务器 X-Api-Secret 认证（视为 superadmin）
        if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
          uId = 1; uRole = 'superadmin';
        } else {
          const authHeader = request.headers.get('Authorization');
          if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized', data: [] }), { status: 401, headers: corsHeaders });
          try {
            const parts = atob(authHeader.split(' ')[1]).split(':');
            uId = Number(parts[0]) || 0;
            uRole = parts[2] || '';
          } catch {
            return new Response(JSON.stringify({ success: false, message: 'Invalid Token', data: [] }), { status: 401, headers: corsHeaders });
          }
        }

        // 查询请求者完整信息用于 RBAC
        const { results: reqUserRes } = await env.DB.prepare(`SELECT id, role, parent_id, permission_level FROM users WHERE id = ?`).bind(Number(uId)).all();
        const reqUser = reqUserRes[0];
        // 🐛 容错：找不到用户记录时（如 token 中 uId=0），按最小权限返回空列表，避免泄露数据
        if (!reqUser) {
          return new Response(JSON.stringify({ success: true, data: [] }), { headers: corsHeaders });
        }

        const normalizedRole = (reqUser.role || '').toLowerCase().trim();
        const permLevel = reqUser.permission_level || 'full';
        const teamRootId = reqUser.parent_id || reqUser.id;

        let query = `SELECT ${PROXY_FIELDS} FROM proxies`;
        let params = [];
        if (normalizedRole === 'superadmin') {
          // Superadmin: 看全部
        } else if (permLevel === 'full') {
          // 团队 Full Access: 自己 + 团队成员 + 共享代理池 (user_id=1)
          query += ' WHERE (user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?) OR user_id = 1)';
          params = [Number(teamRootId), Number(teamRootId)];
        } else {
          // 个人: 仅自己 + 共享代理池 (user_id=1)
          query += ' WHERE (user_id = ? OR user_id = 1)';
          params = [Number(uId)];
        }
        query += ' ORDER BY created_at DESC';

        const { results } = await env.DB.prepare(query).bind(...params).all();
        return new Response(JSON.stringify({ success: true, data: results || [] }, (k, v) => typeof v === 'bigint' ? Number(v) : v), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message, data: [] }), { headers: corsHeaders });
      }
    }
    // POST /api/proxies (create)
    // 🐛 修复：这里原来用 path.includes('/api/proxies')，会把子路径也吃掉 ——
    //    例如 POST /api/proxies/<id>/fail（标记失败代理）会先命中这个分支去解析 body，
    //    结果 500「Unexpected end of JSON input」，下面真正的 /fail 路由永远走不到。
    //    改成只匹配集合路径本身。
    if (path.replace(/\/$/, '') === '/api/proxies' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uId;
      try { const td = atob(authHeader.split(' ')[1]); uId = Number(td.split(':')[0]) || 0; } catch { uId = 0; }
      try {
        const body = await request.json();
        const id = body.id || `px_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await env.DB.prepare(`INSERT OR REPLACE INTO proxies (id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(
          id, body.type||'http', body.host||'', body.port||'', body.username||'', body.password||'',
          body.provider||'', body.zone||'', body.country||'', body.city||'', body.session||'', body.rotation||'',
          body.label||'', body.channel||'', body.category||'', uId
        ).run();
        return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers: corsHeaders });
      }
    }
    // POST /api/proxies/batch-import (批量导入)
    if (path.includes('/api/proxies/batch-import') && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uId;
      try { const td = atob(authHeader.split(' ')[1]); uId = Number(td.split(':')[0]) || 0; } catch { uId = 0; }
      const body = await request.json();
      const items = Array.isArray(body) ? body : (body.items || body.proxies || [body]);
      let imported = 0, errors = 0;
      for (const raw of items) {
        try {
          const p = typeof raw === 'string' ? parseRawProxy(raw) : raw;
          if (!p || !p.host) { errors++; continue; }
          const id = p.id || `px_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          await env.DB.prepare(`INSERT OR REPLACE INTO proxies (id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(
            id, p.type||'http', p.host, p.port||'', p.username||'', p.password||'',
            p.provider||'', p.zone||'', p.country||'', p.city||'', p.session||'', p.rotation||'',
            p.label||'', p.channel||'', p.category||'', uId
          ).run();
          imported++;
        } catch (e) { errors++; }
      }
      return new Response(JSON.stringify({ success: true, imported, errors, total: items.length }), { headers: corsHeaders });
    }
    // 提取 uId 和 uRole 的辅助函数
    const parseProxyAuth = (authHeader) => {
      try {
        const parts = atob(authHeader.split(' ')[1]).split(':');
        return { uId: Number(parts[0]) || 0, uRole: parts[2] || '' };
      } catch { return { uId: 0, uRole: '' }; }
    };
    // PUT /api/proxies/:id
    const proxyPutMatch = path.match(/\/api\/proxies\/([^/]+)$/);
    if (proxyPutMatch && method === 'PUT') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const { uId, uRole } = parseProxyAuth(authHeader);
      const pid = proxyPutMatch[1];
      const body = await request.json();
      const userFilter = uRole === 'superadmin' ? '' : ' AND user_id = ?';
      const binds = [body.type||'http', body.host||'', body.port||'', body.username||'', body.password||'',
        body.provider||'', body.zone||'', body.country||'', body.city||'', body.session||'', body.rotation||'',
        body.label||'', body.channel||'', body.category||'', pid];
      if (uRole !== 'superadmin') binds.push(uId);
      await env.DB.prepare(`UPDATE proxies SET type=?,host=?,port=?,username=?,password=?,provider=?,zone=?,country=?,city=?,session=?,rotation=?,label=?,channel=?,category=?,updated_at=CURRENT_TIMESTAMP WHERE id=?${userFilter}`).bind(...binds).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
    // DELETE /api/proxies/:id
    if (proxyPutMatch && method === 'DELETE') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const { uId, uRole } = parseProxyAuth(authHeader);
      const userFilter = uRole === 'superadmin' ? '' : ' AND user_id = ?';
      const binds = [proxyPutMatch[1]];
      if (uRole !== 'superadmin') binds.push(uId);
      await env.DB.prepare(`DELETE FROM proxies WHERE id=?${userFilter}`).bind(...binds).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
    // POST /api/proxies/:id/fail (标记代理失败,递增失败计数)
    const failMatch = path.match(/\/api\/proxies\/([^/]+)\/fail$/);
    if (failMatch && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      await env.DB.prepare('UPDATE proxies SET failed_count = COALESCE(failed_count,0)+1, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(failMatch[1]).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
    // POST /api/proxies/test
    if (path.includes('/api/proxies/test') && method === 'POST') {
      const body = await request.json();
      let ok = true, lat = 0, msg = '';
      const start = Date.now();
      try {
        const r = await fetch(`http://${body.host}:${body.port}`, { signal: AbortSignal.timeout(5000) });
        lat = Date.now() - start;
        ok = r.ok || r.status < 500;
      } catch (e) {
        ok = false; msg = e.message;
      }
      return new Response(JSON.stringify({ success: ok, latency: lat, message: msg }), { headers: corsHeaders });
    }

    // 2.3 Single Profile GET
    if (path.includes('/api/profiles/') && method === 'GET') {
      return handleProfilesGetById(request, env, corsHeaders);
      let __step = 'init';
      try {
        const authHeader = request.headers.get('Authorization');
        const apiSecret = request.headers.get('X-Api-Secret');
        let uId, uRole;

        // 支持 X-Api-Secret 认证（PUP 服务器使用）
        if (apiSecret) {
          if (apiSecret === env.PUPPETEER_API_SECRET) {
            uId = 1; uRole = 'superadmin';
          } else {
            return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
          }
        } else {
          if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
          try {
            const tokenData = atob(authHeader.split(' ')[1]);
            const parts = tokenData.split(':');
            uId = parts[0];
            uRole = parts[2] || '';
          } catch (e) {
            return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
          }
        }

        const id = path.split('/').filter(Boolean).pop();
        if (id === 'profiles') return new Response(JSON.stringify({ success: false, message: 'Invalid ID' }), { status: 400, headers: corsHeaders });

        __step = 'db_query';
        // 🐛 广告号数量：映射里读的是 row._ad_accounts_count，但 SELECT * 里根本没有这个字段
        //    （pages/bm/pixels 走的是 profiles 表的存量列，广告号没有对应列）→ 恒为 0 →
        //    配置列表「广告号」列只在刚点过「获取信息」时才有数，刷新后旧数据全没了。
        //    这里补一个子查询，与列表接口 routes/profiles.js 的取值方式保持一致。
        const { results } = uRole === 'superadmin'
          ? await env.DB.prepare(`SELECT profiles.*, (SELECT COUNT(*) FROM ad_accounts WHERE ad_accounts.profile_id = CAST(profiles.id AS TEXT)) as _ad_accounts_count FROM profiles WHERE id = ? OR ext_id = ?`).bind(Number(id) || 0, id).all()
          : await env.DB.prepare(`SELECT profiles.*, (SELECT COUNT(*) FROM ad_accounts WHERE ad_accounts.profile_id = CAST(profiles.id AS TEXT)) as _ad_accounts_count FROM profiles WHERE (id = ? OR ext_id = ?) AND user_id = ?`).bind(Number(id) || 0, id, Number(uId)).all();
        const row = results[0];
        if (!row) return new Response(JSON.stringify({ success: false, message: 'Not Found' }), { status: 404, headers: corsHeaders });

        // 🚀 查询该配置关联的 BM ID
        __step = 'fetch_bms';
        let bmIds = [];
        try {
          const { results: bmResults } = await env.DB.prepare(`SELECT business_id FROM businesses WHERE profile_id = ?`).bind(Number(id) || 0).all();
          bmIds = bmResults.map(b => String(b.business_id || '')).filter(Boolean);
        } catch {}

        __step = 'parse_proxy';
        let proxy = null;
        try { if (row.proxy) proxy = JSON.parse(row.proxy); } catch {}
        if (!proxy && row.proxy_host) {
          proxy = { type: row.proxy_type, host: row.proxy_host, port: Number(row.proxy_port) || 0, username: row.proxy_username, password: row.proxy_password };
        }

        // 🚀 修复：fingerprint_protection 的 JSON.parse 包裹 try/catch，避免畸形数据导致 500
        __step = 'parse_fp';
        let fingerprintProtection = {};
        try { if (row.fingerprint_protection) fingerprintProtection = JSON.parse(row.fingerprint_protection); } catch {}

        __step = 'build_data';
        // 🚀 BigInt 安全处理：D1 可能对 INTEGER 列返回 BigInt，JSON.stringify 无法序列化 BigInt
        const data = {
          id: String(row.id), extId: row.ext_id, name: row.name, platform: row.platform,
          userAgent: row.user_agent, startupUrls: row.start_url ? [row.start_url] : [],
          account: { name: row.account_name, email: row.account_email, password: row.account_password, twoFactorSecret: row.account_twofactor_secret || '', cookies: row.account_cookies },
          proxy, proxyEnabled: !!row.proxy_enabled, token: row.account_tokens, notes: row.account_notes,
          // 🐛 云端 by-id 接口原来没返回 group/tags（列表接口有），编辑表单直接拿它当 initialData →
          //    「分组 / 标签」回填成空。这里补齐成与列表接口同一形状（group 字符串 / tags 数组）。
          group: row.group_col || '',
          tags: row.tags_col ? String(row.tags_col).split(',').filter(Boolean) : [],
          os: row.os, resolution: row.resolution, timezone: row.timezone, language: row.language,
          fingerprintProtection,
          // 🚀 包含 BM ID 信息
          assets: {
            bmIds: bmIds,
            bmId: bmIds.length > 0 ? bmIds[0] : '',
            bmCount: Number(row.bm_count || 0),
            pagesCount: Number(row.pages_count || 0),
            pixelsCount: Number(row.pixels_count || 0),
            adAccountsCount: Number(row._ad_accounts_count || 0)
          }
        };
        __step = 'serialize';
        const body = JSON.stringify(data, (k, v) => typeof v === 'bigint' ? Number(v) : v);
        return new Response(JSON.stringify({ success: true, data: JSON.parse(body) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        // 🚀 顶层 try/catch：捕获任何未处理异常，返回 500 而不是让 Cloudflare 返回不可读的错误
        // 包含 __step 字段帮助定位具体失败步骤
        return new Response(JSON.stringify({ success: false, message: 'Server error: ' + (e?.message || String(e)), step: __step, stack: e?.stack?.split('\n').slice(0, 3).join(' | ') }), { status: 500, headers: corsHeaders });
      }
    }

    // 2.4 Save Tokens API
    if (path === '/api/facebook/save-tokens' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');

      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0];
          uRole = parts[2] || '';
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
        }
      }

      const { profileId, tokens } = await request.json();
      if (!profileId || !tokens) return new Response(JSON.stringify({ success: false, message: 'Missing profileId or tokens' }), { status: 400, headers: corsHeaders });

      const access = Array.isArray(tokens.access_tokens) ? tokens.access_tokens : [];
      const firstToken = (access.find(v => /^EAAG/i.test(String(v))) || access.find(v => /^EAA/i.test(String(v))) || access.find(v => typeof v === 'string' && v.length > 0) || '');

      if (!firstToken) return new Response(JSON.stringify({ success: false, message: 'No valid token found in payload' }), { status: 400, headers: corsHeaders });

      const timestamp = new Date().toISOString();
      const tokenUserId = Number(uId) || 0;
      // 🚀 修复：superadmin 可更新任意 profile 的 token，不受 user_id 限制
      const isSuperAdmin = uRole === 'superadmin';
      const result = isSuperAdmin
        ? await env.DB.prepare(`UPDATE profiles SET account_tokens = ?, updated_at = ? WHERE (id = ? OR ext_id = ?)`).bind(firstToken, timestamp, Number(profileId) || 0, String(profileId)).run()
        : await env.DB.prepare(`UPDATE profiles SET account_tokens = ?, updated_at = ? WHERE (id = ? OR ext_id = ?) AND user_id = ?`).bind(firstToken, timestamp, Number(profileId) || 0, String(profileId), tokenUserId).run();

      return new Response(JSON.stringify({ success: true, changes: result.meta?.changes || 0 }), { headers: corsHeaders });
    }

    // 🚀 修正：PUT /api/profiles/:id — 编辑单个配置
    if (path.startsWith('/api/profiles/') && method === 'PUT') {
      return handleProfilesUpdateById(request, env, corsHeaders);
      const profileId = path.replace('/api/profiles/', '').split('/')[0];
      if (!profileId) return new Response(JSON.stringify({ success: false, message: 'Missing id' }), { status: 400, headers: corsHeaders });

      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0];
          uRole = parts[2] || '';
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
        }
      }

      const p = await request.json();
      
      // 🚀 部分更新：只更新请求体中存在的字段
      const fields = [];
      const binds = [];
      const cols = {
        name: 'name', account_name: 'account_name', account_email: 'account_email',
        account_password: 'account_password', start_url: 'start_url', user_agent: 'user_agent',
        account_notes: 'account_notes', group_col: 'group_col', tags_col: 'tags_col',
        proxy_enabled: 'proxy_enabled', proxy_type: 'proxy_type', proxy_host: 'proxy_host',
        proxy_port: 'proxy_port', proxy_username: 'proxy_username', proxy_password: 'proxy_password',
        proxy: 'proxy', account: 'account'
      };
      for (const [key, col] of Object.entries(cols)) {
        if (p[key] !== undefined) {
          // tags_col 特殊处理
          if (key === 'tags_col') {
            const val = Array.isArray(p[key]) ? p[key].join(',') : String(p[key]);
            fields.push(`${col} = ?`); binds.push(val);
          } else {
            fields.push(`${col} = ?`); binds.push(typeof p[key] === 'object' ? JSON.stringify(p[key]) : String(p[key]));
          }
        }
      }
      // 兼容 p.notes → account_notes
      if (p.notes !== undefined && p.account_notes === undefined) {
        fields.push('account_notes = ?'); binds.push(String(p.notes));
      }
      // 兼容 p.group → group_col
      if (p.group !== undefined && p.group_col === undefined) {
        fields.push('group_col = ?'); binds.push(String(p.group));
      }
      // 兼容 p.tags → tags_col
      if (p.tags !== undefined && p.tags_col === undefined) {
        fields.push('tags_col = ?'); binds.push(Array.isArray(p.tags) ? p.tags.join(',') : String(p.tags));
      }
      // 兼容 proxyEnabled → proxy_enabled
      if (p.proxyEnabled !== undefined && p.proxy_enabled === undefined) {
        fields.push('proxy_enabled = ?'); binds.push(p.proxyEnabled ? '1' : '0');
      }
      // 兼容 p.proxy 为对象 → 存 JSON
      if (p.proxy !== undefined && typeof p.proxy === 'object' && p.proxy !== null && !Array.isArray(p.proxy)) {
        // 如果 proxy 对象没有在 cols 中处理，手动添加
        const alreadyHandled = fields.some(f => f.startsWith('proxy ='));
        if (!alreadyHandled) {
          fields.push('proxy = ?'); binds.push(JSON.stringify(p.proxy));
          // 同时补充 proxy_type/host/port/username/password
          if (p.proxy_type === undefined && p.proxy.type) { fields.push('proxy_type = ?'); binds.push(String(p.proxy.type)); }
          if (p.proxy_host === undefined && p.proxy.host) { fields.push('proxy_host = ?'); binds.push(String(p.proxy.host)); }
          if (p.proxy_port === undefined && p.proxy.port) { fields.push('proxy_port = ?'); binds.push(String(p.proxy.port)); }
          if (p.proxy_username === undefined && p.proxy.username) { fields.push('proxy_username = ?'); binds.push(String(p.proxy.username)); }
          if (p.proxy_password === undefined && p.proxy.password) { fields.push('proxy_password = ?'); binds.push(String(p.proxy.password)); }
        }
      }
      // 兼容 p.account.twoFactorSecret → account_twofactor_secret
      if (p.account && typeof p.account === 'object' && p.account.twoFactorSecret !== undefined) {
        const alreadyHandled = fields.some(f => f.startsWith('account_twofactor_secret'));
        if (!alreadyHandled) {
          fields.push('account_twofactor_secret = ?'); binds.push(String(p.account.twoFactorSecret));
        }
      }
      
      if (fields.length === 0) {
        return new Response(JSON.stringify({ success: false, message: 'No fields to update' }), { status: 400, headers: corsHeaders });
      }
      
      fields.push('updated_at = ?');
      binds.push(new Date().toISOString());

      const isSuperAdmin = uRole === 'superadmin';
      const pidNum = !isNaN(Number(profileId)) ? Number(profileId) : null;
      let stmt;
      const userFilterClause = isSuperAdmin ? '' : ' AND user_id = ?';
      try {
        if (pidNum) {
          binds.push(pidNum);
          if (!isSuperAdmin) binds.push(Number(uId));
          stmt = await env.DB.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE id = ?${userFilterClause}`).bind(...binds).run();
        } else {
          binds.push(String(profileId));
          if (!isSuperAdmin) binds.push(Number(uId));
          stmt = await env.DB.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE ext_id = ?${userFilterClause}`).bind(...binds).run();
        }
      } catch (e) {
        // 🚀 如果 D1 报 unknown column，尝试去掉不适配的列降级重试
        const msg = String(e.message || e);
        const unknownCols = ['group_col', 'tags_col', 'account_twofactor_secret'];
        if (msg.includes('no such column') && unknownCols.some(c => msg.includes(c))) {
          const safeFields = fields.filter(f => !unknownCols.some(c => f.startsWith(c)));
          const safeBinds = [];
          let fi = 0;
          for (const f of fields) {
            if (!unknownCols.some(c => f.startsWith(c))) safeBinds.push(binds[fi]);
            fi++;
          }
          if (safeFields.length <= 1) {
            return new Response(JSON.stringify({ success: false, message: 'Database schema mismatch: ' + msg }), { status: 500, headers: corsHeaders });
          }
          if (pidNum) {
            safeBinds.push(pidNum);
            if (!isSuperAdmin) safeBinds.push(Number(uId));
            stmt = await env.DB.prepare(`UPDATE profiles SET ${safeFields.join(', ')} WHERE id = ?${userFilterClause}`).bind(...safeBinds).run();
          } else {
            safeBinds.push(String(profileId));
            if (!isSuperAdmin) safeBinds.push(Number(uId));
            stmt = await env.DB.prepare(`UPDATE profiles SET ${safeFields.join(', ')} WHERE ext_id = ?${userFilterClause}`).bind(...safeBinds).run();
          }
        } else {
          throw e;
        }
      }

      return new Response(JSON.stringify({ success: true, message: '配置已更新', changes: stmt.meta?.changes || 0 }), { headers: corsHeaders });
    }

    // 🚀 合并刷新：GET /api/assets/batch-refresh — 一次请求返回所有资产类型
    if (path === '/api/assets/batch-refresh' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0]; uRole = parts[2];
        } catch { return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders }); }
      }

      // 🚀 V5.6.9: 支持 profileIds 参数过滤
      const url = new URL(request.url);
      const profileIdsParam = url.searchParams.get('profileIds');
      const profileIds = profileIdsParam ? profileIdsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

      const buildQuery = (table, alias) => {
        let q = `SELECT * FROM ${table} WHERE ${alias}.user_id = ? OR ? = 'superadmin'`;
        const params = [Number(uId), uRole];
        // 🚀 V5.7.0: superadmin 不应用 profileIds 过滤，否则会看不到所有数据
        if (uRole !== 'superadmin' && profileIds.length > 0) {
          q += ` AND ${alias}.profile_id IN (${profileIds.map(() => '?').join(',')})`;
          params.push(...profileIds);
        }
        q += ' ORDER BY updated_at DESC';
        return { query: q, params };
      };

      const adQ = buildQuery('ad_accounts', 'ad_accounts');
      const adsQ = buildQuery('ads', 'ads');
      const pgQ = buildQuery('pages', 'pages');
      const bizQ = buildQuery('businesses', 'businesses');

      const [adAccountsRes, adsRes, pagesRes, businessesRes] = await Promise.all([
        env.DB.prepare(adQ.query).bind(...adQ.params).all(),
        env.DB.prepare(adsQ.query).bind(...adsQ.params).all(),
        env.DB.prepare(pgQ.query).bind(...pgQ.params).all(),
        env.DB.prepare(bizQ.query).bind(...bizQ.params).all()
      ]);

      return new Response(JSON.stringify({
        success: true,
        adAccounts: adAccountsRes.results || [],
        ads: adsRes.results || [],
        pages: pagesRes.results || [],
        businesses: businessesRes.results || []
      }), { headers: corsHeaders });
    }

    // 3. AdAccounts Bulk Save (Remote Sync)
    if (path.includes('/api/adaccounts/bulk-save') && method === 'POST') {
      return handleAdAccountsBulkSave(request, env, corsHeaders);
    }

    // 3.1 AdAccounts Fill Seq — 回写客户端分配好的固定序号（只补空值）
    if (path.includes('/api/adaccounts/fill-seq') && method === 'POST') {
      return handleAdAccountsFillSeq(request, env, corsHeaders);
    }

    // 4. Businesses Bulk Save
    if (path === '/api/businesses/bulk-save' && method === 'POST') {
      return handleBusinessesBulkSave(request, env, corsHeaders);
    }

    // 4.0.1 Businesses Set Invite（BM 邀请链接写回：本地 9999 自动流程带密钥调用）
    if (path === '/api/businesses/set-invite' && method === 'POST') {
      return handleBusinessesSetInvite(request, env, corsHeaders);
    }

    // 4.1 Pages Bulk Save
    if (path === '/api/pages/bulk-save' && method === 'POST') {
      return handlePagesBulkSave(request, env, corsHeaders);
    }

    // 4.1.1 Pages Assign Operator（批量设置主页操作员）
    if (path === '/api/pages/assign-operator' && method === 'POST') {
      return handlePagesAssignOperator(request, env, corsHeaders);
    }

    // 4.1.2 Upload Temp（媒体附件上传 → 公网 URL，供 Send API url 模式）
    if (path === '/api/upload-temp' && method === 'POST') {
      return handleUploadTemp(request, env, corsHeaders);
    }

    // 4.1.3 Uploaded files（公开读取，供 Facebook 拉取）
    if (path.startsWith('/uploads/') && method === 'GET') {
      return handleUploadsGet(request, env, corsHeaders, path.slice('/uploads/'.length));
    }

    // 4.2 Ads Bulk Save
    if (path === '/api/ads/bulk-save' && method === 'POST') {
      return handleAdsBulkSave(request, env, corsHeaders);
    }

    // 4.3 Pixels Bulk Save
    if (path === '/api/pixels/bulk-save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0]; uRole = parts[2];
      }

      const { items = [] } = await request.json();
      const statements = [];
      const timestamp = new Date().toISOString();

      const pIds = [...new Set(items.map(it => String(it.profile_id || it.profileId || '')).filter(Boolean))];
      const pIdMap = new Map();
      if (pIds.length > 0) {
        const placeholders = pIds.map(() => '?').join(',');
        const { results: pOwners } = await env.DB.prepare(`SELECT id, ext_id, user_id FROM profiles WHERE id IN (${placeholders}) OR ext_id IN (${placeholders})`).bind(...pIds, ...pIds).all();
        pOwners.forEach(p => {
          if (p.id) pIdMap.set(String(p.id), p.user_id);
          if (p.ext_id) pIdMap.set(String(p.ext_id), p.user_id);
        });
      }

      for (const item of items) {
        const pId = String(item.profile_id || item.profileId || '');
        // 🛡️ 缺 profileId 必须跳过（否则会把字面量 "undefined" 写进 profile_id 列）
        if (!pId || pId === 'undefined' || pId === 'null') continue;
        const itemUserId = pIdMap.get(pId) || uId;
        const pixelId = item.pixel_id || item.id;
        const fullId = `pixel_${pixelId}`;

        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO pixels (id, user_id, profile_id, pixel_id, name, status, account_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(fullId, Number(itemUserId), pId, String(pixelId), item.name || '', item.status || 'ACTIVE', item.account_id || '', timestamp));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: statements.length }), { headers: corsHeaders });
    }

    // 🚀 4.4 Page Posts Bulk Save (主页贴文)
    if (path === '/api/posts/bulk-save' && method === 'POST') {
      return handlePostsBulkSave(request, env, corsHeaders);
    }

    // 🚀 4.4.1 贴文互动明细（点赞用户/评论/分享者）批量保存
    if (path === '/api/posts/engagement-bulk-save' && method === 'POST') {
      return handlePostsEngagementBulkSave(request, env, corsHeaders);
    }

    // 🚀 4.4.2 评论操作后同步云端副本（删除/隐藏/取消隐藏）
    if (path === '/api/posts/comment/patch' && method === 'POST') {
      return handlePostsCommentPatch(request, env, corsHeaders);
    }

    // 🚀 4.4.3 用户级键值设置（AI 提示词 / 已发送缓存等）
    if (path === '/api/settings/bulk-save' && method === 'POST') {
      return handleSettingsBulkSave(request, env, corsHeaders);
    }

    // 🚀 4.4.4 AI 自动回复素材库（按 user_id 隔离）
    if (path === '/api/ai-assets/bulk-save' && method === 'POST') {
      return handleAiAssetsBulkSave(request, env, corsHeaders);
    }
    if (path === '/api/ai-assets/delete' && method === 'POST') {
      return handleAiAssetsDelete(request, env, corsHeaders);
    }

    // 🚀 4.5 Page Conversations Bulk Save (主页收件箱对话)
    if (path === '/api/messages/bulk-save' && method === 'POST') {
      return handleMessagesBulkSave(request, env, corsHeaders);
    }

    // 🚀 4.6 Page Posts / Conversations Batch Delete (批量删除云端贴文/对话存档)
    if (path.includes('/api/posts/batch-delete') && method === 'POST') {
      return handlePostsBatchDelete(request, env, corsHeaders);
    }
    if (path.includes('/api/messages/batch-delete') && method === 'POST') {
      return handleMessagesBatchDelete(request, env, corsHeaders);
    }

    // 🚀 6. Billing Transactions bulk-save
    if (path === '/api/billing/bulk-save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0]; uRole = parts[2];
      }

      const { items = [] } = await request.json();
      const statements = [];
      const timestamp = new Date().toISOString();

      await env.DB.exec(`CREATE TABLE IF NOT EXISTS billing_transactions (
        id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
        account_id TEXT, transaction_id TEXT, type TEXT, amount REAL,
        status TEXT, start_time TEXT, payment_due_date TEXT, balance REAL,
        billing_address TEXT, account_billing_info TEXT, updated_at TEXT
      )`);

      for (const item of items) {
        const fullId = `${item.profile_id}_${item.transaction_id}`;
        statements.push(env.DB.prepare(`
          INSERT INTO billing_transactions (id, user_id, profile_id, account_id, transaction_id, type, amount, status, start_time, payment_due_date, balance, billing_address, account_billing_info, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET 
            type=excluded.type, amount=excluded.amount, status=excluded.status, updated_at=excluded.updated_at
        `).bind(fullId, Number(uId), item.profile_id, item.account_id, item.transaction_id, item.type, item.amount, item.status, item.start_time, item.payment_due_date, item.balance, item.billing_address, item.account_billing_info, timestamp));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
    }

    // 🚀 7. Media Files (素材库) bulk-save & GET
    if (path === '/api/media/bulk-save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      let uId;
      try {
        const tokenData = atob(authHeader?.split(' ')[1] || '');
        uId = tokenData.split(':')[0];
      } catch { uId = 1; }
      const { items = [] } = await request.json();
      const statements = [];
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
        name TEXT, file_name TEXT, mime_type TEXT, data_url TEXT,
        width INTEGER, height INTEGER, file_size INTEGER, created_at TEXT
      )`);
      for (const item of items) {
        const mid = item.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        const nowIso = new Date().toISOString();
        statements.push(env.DB.prepare(`INSERT INTO media_files (id, user_id, profile_id, name, file_name, mime_type, data_url, width, height, file_size, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, data_url=excluded.data_url, updated_at=excluded.updated_at`
        ).bind(mid, Number(uId), item.profile_id || '', item.name || '', item.file_name || '', item.mime_type || '', item.data_url || '', item.width || 0, item.height || 0, item.file_size || 0, nowIso, nowIso));
      }
      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
    }
    if (path === '/api/media' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      let uId, uRole;
      try {
        const tokenData = atob(authHeader?.split(' ')[1] || '');
        const parts = tokenData.split(':');
        uId = parts[0]; uRole = parts[2];
      } catch { uId = 1; uRole = ''; }
      const { results } = await env.DB.prepare(`SELECT * FROM media_files WHERE (user_id = ? OR ? = 'superadmin') ORDER BY created_at DESC`).bind(Number(uId), uRole).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
    }

    // 5. AdAccounts GET
    if (path === '/api/adaccounts' && method === 'GET') {
      return handleAdAccountsList(request, env, corsHeaders);
    }

    // 🚀 PUT /api/adaccounts/:id — 单条更新（备注快速编辑）
    if (path.startsWith('/api/adaccounts/') && method === 'PUT') {
      return handleAdAccountsUpdateById(request, env, corsHeaders);
    }

    // 5.2 Pages List
    if (path === '/api/pages' && method === 'GET') {
      return handlePagesList(request, env, corsHeaders);
    }

    // 5.2.1 Page Posts List (主页贴文)
    if (path === '/api/posts' && method === 'GET') {
      return handlePostsList(request, env, corsHeaders);
    }

    // 5.2.1.1 Page Post Engagement (单条贴文的点赞用户/评论/分享者)
    if (path === '/api/posts/engagement' && method === 'GET') {
      return handlePostsEngagementGet(request, env, corsHeaders);
    }

    // 5.2.1.2 User Settings (用户级键值设置)
    if (path === '/api/settings' && method === 'GET') {
      return handleSettingsList(request, env, corsHeaders);
    }

    // 5.2.1.3 AI Assets (AI 自动回复素材库)
    if (path === '/api/ai-assets' && method === 'GET') {
      return handleAiAssetsList(request, env, corsHeaders);
    }

    // 5.2.2 Page Conversations List (主页收件箱对话)
    if (path === '/api/messages' && method === 'GET') {
      return handleMessagesList(request, env, corsHeaders);
    }

    // 5.3 Ads List
    if (path === '/api/ads' && method === 'GET') {
      return handleAdsList(request, env, corsHeaders);
    }

    // 5.4 Pixels List
    if (path === '/api/pixels' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0]; uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      let query = `SELECT p.*, u.email as owner_email FROM pixels p LEFT JOIN users u ON p.user_id = u.id WHERE (p.user_id = ? OR ? = 'superadmin')`;
      const accountId = url.searchParams.get('accountId');
      const params = [Number(uId), uRole];
      
      if (accountId) {
        query += ` AND p.account_id = ?`;
        params.push(accountId);
      }
      
      query += ` ORDER BY p.updated_at DESC`;
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
    }

    // 5.2 Businesses GET
    if (path === '/api/businesses' && method === 'GET') {
      return handleBusinessesList(request, env, corsHeaders);
    }

    // 🚀 Billing Methods GET (查询已保存的信用卡信息)
    if (path === '/api/billing-methods' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      let uId, uRole;
      if (authHeader) {
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0]; uRole = parts[2];
        } catch {}
      }
      let query = `SELECT m.*, u.email as owner_email FROM billing_methods m LEFT JOIN users u ON m.user_id = u.id`;
      let params = [];
      if (uRole !== 'superadmin' && uId) {
        query += ' WHERE (m.user_id = ? OR m.user_id IN (SELECT id FROM users WHERE parent_id = ?))';
        params = [Number(uId), Number(uId)];
      }
      query += ' ORDER BY m.created_at DESC';
      const { results } = await env.DB.prepare(query).bind(...params).all();
      const data = (results || []).map((r) => ({
        id: String(r.id || ''),
        owner_email: r.owner_email || '',
        profile_id: String(r.profile_id || ''),
        account_id: String(r.account_id || ''),
        type: String(r.type || ''),
        last4: String(r.last4 || ''),
        brand: String(r.brand || ''),
        exp_month: String(r.exp_month || ''),
        exp_year: String(r.exp_year || ''),
        billing_address: String(r.billing_address || ''),
        created_at: String(r.created_at || '')
      }));
      return new Response(JSON.stringify({ success: true, data, total: data.length }), { headers: corsHeaders });
    }

    // 🚀 Billing Methods Save (供 Puppeteer 服务调用，保存绑定的信用卡)
    if (path === '/api/billing-methods/save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      if (!authHeader && apiSecret !== env.PUPPETEER_API_SECRET) {
        return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }
      const item = await request.json().catch(() => ({}));
      if (!item.profile_id || !item.last4) {
        return new Response(JSON.stringify({ success: false, message: '缺少 profile_id 或 last4' }), { status: 400, headers: corsHeaders });
      }
      
      const rec = {
        id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
        profile_id: String(item.profile_id || '').trim(),
        account_id: String(item.account_id || '').trim(),
        type: String(item.type || item.brand || 'Card'),
        last4: String(item.last4 || ''),
        brand: String(item.brand || ''),
        exp_month: String(item.exp_month || ''),
        exp_year: String(item.exp_year || ''),
        billing_address: String(item.billing_address || '')
      };

      await env.DB.prepare(`INSERT OR REPLACE INTO billing_methods (id, profile_id, account_id, type, last4, brand, exp_month, exp_year, billing_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .bind(rec.id, rec.profile_id, rec.account_id, rec.type, rec.last4, rec.brand, rec.exp_month, rec.exp_year, rec.billing_address)
        .run();
      
      return new Response(JSON.stringify({ success: true, id: rec.id }), { headers: corsHeaders });
    }

    // 🚀 Billing Methods Bulk Save (前端批量保存到 D1)
    if (path === '/api/billing-methods/bulk-save' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const body = await request.json().catch(() => ({}));
      const items = body.items || body.item ? [body] : [];
      if (!Array.isArray(items) || items.length === 0) {
        return new Response(JSON.stringify({ success: false, message: '缺少 items' }), { status: 400, headers: corsHeaders });
      }
      
      const statements = [];
      for (const item of items) {
        if (!item.profile_id || !item.last4) continue;
        const rec = {
          id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`),
          profile_id: String(item.profile_id || '').trim(),
          account_id: String(item.account_id || '').trim(),
          type: String(item.type || item.brand || 'Card'),
          last4: String(item.last4 || ''),
          brand: String(item.brand || ''),
          exp_month: String(item.exp_month || ''),
          exp_year: String(item.exp_year || ''),
          billing_address: String(item.billing_address || '')
        };
        statements.push(env.DB.prepare(`INSERT OR REPLACE INTO billing_methods (id, profile_id, account_id, type, last4, brand, exp_month, exp_year, billing_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
          .bind(rec.id, rec.profile_id, rec.account_id, rec.type, rec.last4, rec.brand, rec.exp_month, rec.exp_year, rec.billing_address));
      }
      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: statements.length }), { headers: corsHeaders });
    }

    // 🚀 Billing Methods Batch Delete (批量删除卡片)
    if (path === '/api/billing-methods/batch-delete' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const body = await request.json().catch(() => ({}));
      const ids = body.ids || [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return new Response(JSON.stringify({ success: false, message: '缺少 ids' }), { status: 400, headers: corsHeaders });
      }
      let deleted = 0;
      for (const id of ids) {
        try {
          const result = await env.DB.prepare(`DELETE FROM billing_methods WHERE id = ?`).bind(String(id)).run();
          if (result.meta.changes > 0) deleted++;
        } catch (e) { console.error(`[batch-delete] 删除失败 id=${id}:`, e.message); }
      }
      return new Response(JSON.stringify({ success: true, count: deleted }), { headers: corsHeaders });
    }

    // 7. Users Management API
    if (path === '/api/users' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      // 资产数量统计：配置(profiles)/主页(pages)/BM(businesses)/广告账户(ad_accounts) 按 user_id 归属
      // 确保 last_active_at 列存在（首次调用时懒建，避免旧库 SELECT 报错）
      if (!_lastActiveColReady) {
        try { await env.DB.exec(`ALTER TABLE users ADD COLUMN last_active_at VARCHAR(32) NULL`); } catch { /* 已存在 */ }
        _lastActiveColReady = true;
      }
      let query = `SELECT u.id, u.username, u.email, u.role, u.status, u.last_login, u.created_at, u.parent_id, u.permission_level, u.subscription_expires_at,
        (SELECT COUNT(*) FROM profiles p WHERE p.user_id = u.id) AS profile_count,
        (SELECT COUNT(*) FROM pages pg WHERE pg.user_id = u.id) AS page_count,
        (SELECT COUNT(*) FROM businesses b WHERE b.user_id = u.id) AS business_count,
        (SELECT COUNT(*) FROM ad_accounts a WHERE a.user_id = u.id) AS ad_account_count,
        COALESCE(u.last_active_at, u.last_login) AS last_active_at
        FROM users u`;
      let params = [];

      if (uRole === 'superadmin') {
        // Superadmin: See all
      } else if (uRole === 'admin') {
        // Admin: See self and team members
        query += ' WHERE u.id = ? OR u.parent_id = ?';
        params = [Number(uId), Number(uId)];
      } else {
        // User: See only self
        query += ' WHERE u.id = ?';
        params = [Number(uId)];
      }
      query += ' ORDER BY u.id ASC';

      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
    }

    if (path === '/api/users' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      if (uRole !== 'superadmin' && uRole !== 'admin') {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }

      const body = await request.json();
      const { username, password, email, role, status, permission_level, subscription_expires_at } = body;
      
      const timestamp = new Date().toISOString();
      try {
        await env.DB.prepare(`
          INSERT INTO users (username, password_hash, email, role, status, parent_id, permission_level, subscription_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          username, password, email, role || 'user', status || 'active', 
          uRole === 'superadmin' ? null : Number(uId),
          permission_level || 'full', subscription_expires_at || null, timestamp, timestamp
        ).run();
        
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    if (path.startsWith('/api/users/') && method === 'PUT') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      const targetId = path.split('/').pop();
      const body = await request.json();
      const { username, password, email, role, status, permission_level, subscription_expires_at } = body;
      const timestamp = new Date().toISOString();

      // Check permissions
      const { results: targetUser } = await env.DB.prepare(`SELECT parent_id FROM users WHERE id = ?`).bind(Number(targetId)).all();
      if (!targetUser[0]) return new Response(JSON.stringify({ success: false, message: 'User not found' }), { status: 404, headers: corsHeaders });
      
      if (uRole !== 'superadmin' && targetUser[0].parent_id != uId && uId != targetId) {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }

      let query = `UPDATE users SET username = ?, email = ?, role = ?, status = ?, permission_level = ?, subscription_expires_at = ?, updated_at = ?`;
      let params = [username, email, role, status, permission_level, subscription_expires_at || null, timestamp];

      if (password) {
        query += `, password_hash = ?`;
        params.push(password);
      }

      query += ` WHERE id = ?`;
      params.push(Number(targetId));

      await env.DB.prepare(query).bind(...params).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (path.startsWith('/api/users/') && method === 'DELETE') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      const targetId = path.split('/').pop();
      
      // Check permissions
      const { results: targetUser } = await env.DB.prepare(`SELECT parent_id FROM users WHERE id = ?`).bind(Number(targetId)).all();
      if (!targetUser[0]) return new Response(JSON.stringify({ success: false, message: 'User not found' }), { status: 404, headers: corsHeaders });
      
      if (uRole !== 'superadmin' && targetUser[0].parent_id != uId) {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }

      await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(Number(targetId)).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (path === '/api/users/add-member' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      if (uRole !== 'superadmin' && uRole !== 'admin') {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }

      const { email, role } = await request.json();
      const { results: existing } = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).all();
      
      if (existing[0]) {
        // Update parent_id to add to team
        await env.DB.prepare(`UPDATE users SET parent_id = ?, role = ? WHERE id = ?`).bind(Number(uId), role || 'user', existing[0].id).run();
      } else {
        // Create skeleton user
        const timestamp = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO users (username, email, role, status, parent_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(email.split('@')[0], email, role || 'user', 'active', Number(uId), timestamp, timestamp).run();
      }
      
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 6. Graph API Proxy
    if (path === '/api/graph' && method === 'POST') {
      const body = await request.json();
      const { url: targetUrl } = body;
      const resp = await fetch(targetUrl);
      const data = await resp.json();
      return new Response(JSON.stringify({ success: true, data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 8. FB Sync API (Internal)
    if (path === '/api/fb-api/sync-cookies' && method === 'POST') {
      const apiSecret = request.headers.get('X-Api-Secret');
      if (apiSecret !== env.PUPPETEER_API_SECRET) {
        return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }

      const { profileId, cookies } = await request.json();
      if (!profileId) return new Response(JSON.stringify({ success: false, message: 'missing profileId' }), { status: 400, headers: corsHeaders });

      const timestamp = new Date().toISOString();
      const cookiesStr = typeof cookies === 'string' ? cookies : JSON.stringify(cookies);

      await env.DB.prepare(`
        UPDATE profiles SET account_cookies = ?, updated_at = ?
        WHERE id = ? OR ext_id = ?
      `).bind(cookiesStr, timestamp, Number(profileId) || 0, String(profileId)).run();

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 9. Ad Templates API
    if (path === '/api/ad-templates' && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const tokenData = atob(authHeader.split(' ')[1]);
      const [uId] = tokenData.split(':');

      const isDefault = url.searchParams.get('is_default');
      let query = `SELECT * FROM ad_templates WHERE user_id = ?`;
      let params = [Number(uId)];

      if (isDefault) {
        query += ` AND is_default = ?`;
        params.push(Number(isDefault));
      }
      query += ` ORDER BY updated_at DESC`;

      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
    }

    if (path === '/api/ad-templates' && method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const tokenData = atob(authHeader.split(' ')[1]);
      const [uId] = tokenData.split(':');

      const { name, is_default, config, id } = await request.json();
      const timestamp = new Date().toISOString();

      if (is_default) {
        // Reset other defaults for this user
        await env.DB.prepare(`UPDATE ad_templates SET is_default = 0 WHERE user_id = ?`).bind(Number(uId)).run();
      }

      if (id) {
        await env.DB.prepare(`
          UPDATE ad_templates SET name = ?, is_default = ?, config = ?, updated_at = ?
          WHERE id = ? AND user_id = ?
        `).bind(name || 'Last Used', is_default ? 1 : 0, JSON.stringify(config), timestamp, Number(id), Number(uId)).run();
        return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
      } else {
        const { meta } = await env.DB.prepare(`
          INSERT INTO ad_templates (user_id, name, is_default, config, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(Number(uId), name || 'Last Used', is_default ? 1 : 0, JSON.stringify(config), timestamp, timestamp).run();
        return new Response(JSON.stringify({ success: true, id: meta.last_row_id }), { headers: corsHeaders });
      }
    }

    if (path.startsWith('/api/ad-templates/') && method === 'DELETE') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const tokenData = atob(authHeader.split(' ')[1]);
      const [uId] = tokenData.split(':');
      const id = path.split('/').pop();

      await env.DB.prepare(`DELETE FROM ad_templates WHERE id = ? AND user_id = ?`).bind(Number(id), Number(uId)).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 🚀 Publish Configs API（一键智能发布表单配置持久化）
    // GET /api/publish-configs/:key  — 读取配置，不传 key 返回全部
    if (path.startsWith('/api/publish-configs') && method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      // 🚀 工具函数：安全解析 config_value
      const safeParse = (v) => { try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };
      const key = path.replace('/api/publish-configs/', '');
      if (key && key !== 'publish-configs') {
        const { results } = await env.DB.prepare(`SELECT config_key, config_value FROM publish_configs WHERE config_key = ?`).bind(key).all();
        const row = results[0];
        return new Response(JSON.stringify({ success: true, data: row ? { key: row.config_key, value: safeParse(row.config_value) } : null }), { headers: corsHeaders });
      }
      const { results } = await env.DB.prepare(`SELECT config_key, config_value FROM publish_configs`).all();
      const map = {};
      for (const r of results) map[r.config_key] = safeParse(r.config_value);
      return new Response(JSON.stringify({ success: true, data: map }), { headers: corsHeaders });
    }
    // PUT /api/publish-configs/:key  — 保存配置
    if (path.startsWith('/api/publish-configs') && method === 'PUT') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const key = path.replace('/api/publish-configs/', '');
      const body = await request.json();
      const value = typeof body === 'string' ? body : JSON.stringify(body.value ?? body);
      await env.DB.prepare(`INSERT INTO publish_configs (config_key, config_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, updated_at=CURRENT_TIMESTAMP`).bind(key, value).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // 🚀 Logs API — 浏览器执行日志
    // POST /api/logs/batch — 批量写入日志
    if (path === '/api/logs/batch' && method === 'POST') {
      try { await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 0, profile_id TEXT, level TEXT NOT NULL DEFAULT 'INFO', message TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); } catch {}
      try { await env.DB.exec(`ALTER TABLE logs ADD COLUMN user_id INTEGER DEFAULT 0`); } catch {}
      const body = await request.json();
      const items = body.items || [];
      if (!Array.isArray(items) || items.length === 0) {
        return new Response(JSON.stringify({ success: true, count: 0 }), { headers: corsHeaders });
      }
      // 🚀 收集所有 profile_id，批量查询其归属的 user_id
      const pIds = [...new Set(items.map(it => String(it.profile_id || '')).filter(Boolean))];
      const pUserMap = new Map();
      if (pIds.length > 0) {
        const placeholders = pIds.map(() => '?').join(',');
        const { results: pOwners } = await env.DB.prepare(`SELECT id, user_id FROM profiles WHERE id IN (${placeholders}) OR ext_id IN (${placeholders})`).bind(...pIds, ...pIds).all();
        (pOwners || []).forEach(p => {
          if (p.id) pUserMap.set(String(p.id), p.user_id);
          if (p.ext_id) pUserMap.set(String(p.ext_id), p.user_id);
        });
      }
      const timestamp = new Date().toISOString();
      const stmts = items.map(item => {
        const pid = String(item.profile_id || '');
        // 如果未传 user_id 或为 0，尝试从 profile 归属查询
        let uid = item.user_id || 0;
        if (!uid && pid && pUserMap.has(pid)) uid = pUserMap.get(pid);
        return env.DB.prepare(`INSERT OR IGNORE INTO logs (id, user_id, profile_id, level, message, created_at) VALUES (?,?,?,?,?,?)`)
          .bind(item.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`, uid || 0, pid, item.level || 'INFO', item.message || '', timestamp);
      });
      // 分批执行，避免单次 batch 过大
      for (let i = 0; i < stmts.length; i += 100) {
        await env.DB.batch(stmts.slice(i, i + 100));
      }
      return new Response(JSON.stringify({ success: true, count: stmts.length }), { headers: corsHeaders });
    }

    // GET /api/logs — 查询日志（分页 + 过滤）
    if (path === '/api/logs' && method === 'GET') {
      try { await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 0, profile_id TEXT, level TEXT NOT NULL DEFAULT 'INFO', message TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); } catch {}
      try { await env.DB.exec(`ALTER TABLE logs ADD COLUMN user_id INTEGER DEFAULT 0`); } catch {}
      // 🚀 鉴权：superadmin 看全部，普通用户只看自己的
      const authHeader = request.headers.get('Authorization');
      let currentUserId = 0;
      let currentRole = 'user';
      if (authHeader) {
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          currentUserId = Number(parts[0]) || 0;
          currentRole = parts[2] || 'user';
        } catch {}
      }
      const searchParams = url.searchParams;
      const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
      const pageSize = Math.min(200, Math.max(10, parseInt(searchParams.get('pageSize') || '50')));
      const level = searchParams.get('level') || '';
      const profileId = searchParams.get('profileId') || '';
      const keyword = searchParams.get('keyword') || '';
      const userId = searchParams.get('userId') || '';
      const userEmail = searchParams.get('userEmail') || '';

      let where = '1=1';
      const binds = [];
      // 🚀 非 superadmin 只能看自己的日志
      if (currentRole !== 'superadmin' && currentUserId > 0) {
        where += ' AND (user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?))';
        binds.push(currentUserId, currentUserId);
      }
      if (level) { where += ' AND level = ?'; binds.push(level); }
      if (profileId) { where += ' AND profile_id = ?'; binds.push(profileId); }
      if (keyword) { where += ' AND message LIKE ?'; binds.push(`%${keyword}%`); }
      if (userId) { where += ' AND user_id = ?'; binds.push(Number(userId)); }
      if (userEmail) {
        // 通过邮箱反查 user_id
        const { results: emailUsers } = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(userEmail).all();
        if (emailUsers && emailUsers.length > 0) {
          const ids = emailUsers.map(u => u.id);
          where += ` AND user_id IN (${ids.map(() => '?').join(',')})`;
          binds.push(...ids);
        } else {
          // 没有匹配的用户，返回空
          where += ' AND 1=0';
        }
      }

      const countResult = await env.DB.prepare(`SELECT COUNT(1) as total FROM logs WHERE ${where}`).bind(...binds).all();
      const total = countResult.results?.[0]?.total || 0;

      const offset = (page - 1) * pageSize;
      const { results } = await env.DB.prepare(`SELECT l.id, l.user_id, l.profile_id, l.level, l.message, l.created_at, u.email as owner_email, u.username as owner_name FROM logs l LEFT JOIN users u ON l.user_id = u.id WHERE ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all();

      // 获取不重复的 profile_id 列表（用于前端过滤下拉）
      let profileWhere = 'profile_id != ?';
      let profileBinds = [''];
      if (currentRole !== 'superadmin' && currentUserId > 0) {
        profileWhere += ' AND (user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?))';
        profileBinds.push(currentUserId, currentUserId);
      }
      const { results: distinctProfiles } = await env.DB.prepare(`SELECT DISTINCT profile_id FROM logs WHERE ${profileWhere} ORDER BY profile_id`).bind(...profileBinds).all();
      // 获取有日志的用户列表（含邮箱，用于前端用户筛选）
      let userWhere = 'l.user_id IS NOT NULL';
      const userBinds = [];
      if (currentRole !== 'superadmin' && currentUserId > 0) {
        userWhere += ' AND (l.user_id = ? OR l.user_id IN (SELECT id FROM users WHERE parent_id = ?))';
        userBinds.push(currentUserId, currentUserId);
      }
      const { results: logUsers } = await env.DB.prepare(`SELECT DISTINCT l.user_id, u.email FROM logs l LEFT JOIN users u ON l.user_id = u.id WHERE ${userWhere} ORDER BY u.email`).bind(...userBinds).all();

      return new Response(JSON.stringify({
        success: true, data: results || [],
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
        profiles: (distinctProfiles || []).map(r => r.profile_id).filter(Boolean),
        users: (logUsers || []).map(r => ({ userId: r.user_id, email: r.email || `用户 #${r.user_id}` }))
      }), { headers: corsHeaders });
    }

    // DELETE /api/logs/clear — 一键清除所有日志（仅 superadmin）
    if (path === '/api/logs/clear' && method === 'DELETE') {
      try { await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 0, profile_id TEXT, level TEXT NOT NULL DEFAULT 'INFO', message TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); } catch {}
      try { await env.DB.exec(`ALTER TABLE logs ADD COLUMN user_id INTEGER DEFAULT 0`); } catch {}
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        uRole = tokenData.split(':')[2] || '';
      } catch {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }
      if (uRole !== 'superadmin') {
        return new Response(JSON.stringify({ success: false, message: 'Forbidden: superadmin only' }), { status: 403, headers: corsHeaders });
      }
      await env.DB.exec(`DELETE FROM logs`);
      return new Response(JSON.stringify({ success: true, message: 'All logs cleared' }), { status: 200, headers: corsHeaders });
    }

    // Default 404
    return new Response(JSON.stringify({ success: false, message: 'Not Found' }), { status: 404, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, message: err.message, stack: err.stack }), { status: 500, headers: corsHeaders });
  }
}
