/**
 * 商城（BM/账号售卖）route handlers
 *
 * 买家侧（公开，无需登录；与主系统用户体系无关）：
 *   GET  /api/shop/products            商品列表（绝不返回 invite_link）
 *   POST /api/shop/orders              无密码下单（邮箱/电话可不填=匿名，凭订单号查单）
 *   GET  /api/shop/orders/query        查单：?order_no=xxx 或 ?contact=邮箱或电话
 *                                      （已发货订单返回发货内容=邀请链接）
 *
 * 商城管理员侧（独立账号体系 shop_admins，与主系统 users 隔离）：
 *   POST /api/shop/admin/login            登录（返回商城专用 token）
 *   GET  /api/shop/admin/me               当前管理员（校验 token）
 *   POST /api/shop/admin/change-password  修改自己的密码
 *   GET  /api/shop/admin/products         全量商品（含 invite_link）
 *   POST /api/shop/admin/products/save    新增/编辑商品
 *   POST /api/shop/admin/products/delete  下架/删除商品
 *   GET  /api/shop/admin/orders           订单列表（可按 status 过滤）
 *   POST /api/shop/admin/orders/confirm-paid  人工确认收款
 *   POST /api/shop/admin/orders/deliver       发货（快照发货内容+商品置 sold）
 *   POST /api/shop/admin/orders/cancel        取消订单（可附原因）
 *
 * 设计约定（沿用 recharge.js 风格）：
 *   - 懒建表：第一次访问自动建表，不依赖手工跑 schema
 *   - 订单号由服务端生成（时间戳36进制+随机，全局唯一约束兜底）
 *   - 收款方式说明存 system_settings 的 shop_pay_info（管理后台可改）
 *   - 发货时把商品 invite_link 快照进订单 deliver_content，防止后续改商品影响已发货订单
 *   - 时间列一律 VARCHAR(32) ISO 字符串（与全库约定一致）
 */

import crypto from 'crypto';

const json = (obj, corsHeaders, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...(corsHeaders || {}), 'content-type': 'application/json' } });

const nowIso = () => new Date().toISOString();

// ---------- 懒建表 ----------
let _shopTablesReady = false;
async function ensureShopTables(env) {
  if (_shopTablesReady) return;
  try {
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS shop_products (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      title        VARCHAR(255) NOT NULL,
      description  TEXT NULL,
      price        DOUBLE NOT NULL DEFAULT 0,
      currency     VARCHAR(16) NOT NULL DEFAULT 'USDT',
      product_type VARCHAR(32) NOT NULL DEFAULT 'bm',
      invite_link  TEXT NULL,
      bm_id        VARCHAR(191) NULL,
      profile_id   VARCHAR(191) NULL,
      status       VARCHAR(32) NOT NULL DEFAULT 'available',
      created_at   VARCHAR(32) NULL,
      updated_at   VARCHAR(32) NULL
    )`);
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS shop_orders (
      id             BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_no       VARCHAR(64) NOT NULL,
      product_id     BIGINT NULL,
      product_title  VARCHAR(255) NULL,
      price          DOUBLE NOT NULL DEFAULT 0,
      currency       VARCHAR(16) NOT NULL DEFAULT 'USDT',
      contact_email  VARCHAR(320) NULL,
      contact_phone  VARCHAR(64) NULL,
      is_anonymous   TINYINT NOT NULL DEFAULT 0,
      status         VARCHAR(32) NOT NULL DEFAULT 'pending',
      pay_method     VARCHAR(32) NULL,
      deliver_content TEXT NULL,
      admin_note     TEXT NULL,
      created_at     VARCHAR(32) NULL,
      paid_at        VARCHAR(32) NULL,
      delivered_at   VARCHAR(32) NULL,
      UNIQUE KEY uq_shop_orders_no (order_no),
      KEY idx_shop_orders_email (contact_email),
      KEY idx_shop_orders_phone (contact_phone),
      KEY idx_shop_orders_status (status)
    )`);
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS shop_admins (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(64) NOT NULL,
      password_hash VARCHAR(191) NOT NULL,
      salt          VARCHAR(64) NOT NULL,
      status        VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at    VARCHAR(32) NULL,
      last_login    VARCHAR(32) NULL,
      UNIQUE KEY uq_shop_admins_user (username)
    )`);
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS shop_blocks (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      title         VARCHAR(255) NOT NULL,
      description   TEXT NULL,
      width_px      INT NOT NULL DEFAULT 380,
      min_height_px INT NOT NULL DEFAULT 0,
      sort_order    INT NOT NULL DEFAULT 0,
      created_at    VARCHAR(32) NULL,
      updated_at    VARCHAR(32) NULL
    )`);
    // 买家账号：下单时填了邮箱/电话就自动建号并登录（邮箱、电话都可作账号，二选一）
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS shop_buyers (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      account       VARCHAR(320) NOT NULL,
      account_type  VARCHAR(16) NOT NULL DEFAULT 'email',
      password_hash VARCHAR(191) NULL,
      salt          VARCHAR(64) NULL,
      created_at    VARCHAR(32) NULL,
      last_login    VARCHAR(32) NULL,
      UNIQUE KEY uq_shop_buyers_account (account)
    )`);
    // 商品的 BM 条目：一个商品可挂多个「BMid + 邀请链接」，每个条目 = 1 个数量（一组）。
    // 下单按下单数量预留（reserved）条目，发货把对应条目置 delivered，取消回到 available。
    // ⚠️ invite_link 用 MEDIUMTEXT：D1 兼容层会把裸 TEXT 改写成 VARCHAR(191)，会截断长邀请链接。
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS shop_product_items (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      product_id   BIGINT NOT NULL,
      bm_id        VARCHAR(191) NULL,
      invite_link  MEDIUMTEXT NULL,
      status       VARCHAR(16) NOT NULL DEFAULT 'available',
      order_id     BIGINT NULL,
      delivered_at VARCHAR(32) NULL,
      created_at   VARCHAR(32) NULL,
      KEY idx_shop_items_product (product_id),
      KEY idx_shop_items_order (order_id),
      KEY idx_shop_items_pstatus (product_id, status)
    )`);
    _shopTablesReady = true;
  } catch (e) {
    // 建表失败不阻断：真有问题会在后续 SQL 上报出来
    console.warn('[shop] ensureShopTables 失败（继续）:', e && e.message);
  }
}

// 老库补列（每进程一次）：块归属、库存、排序、下单数量、下单买家；并把文本列放宽
let _shopColsReady = false;
async function ensureShopColumns(env) {
  if (_shopColsReady) return;
  const statements = [
    `ALTER TABLE shop_products ADD COLUMN block_id BIGINT NULL`,
    `ALTER TABLE shop_products ADD COLUMN stock INT NULL`,              // NULL = 不限量
    `ALTER TABLE shop_products ADD COLUMN sort_order INT NOT NULL DEFAULT 0`,
    `ALTER TABLE shop_products ADD KEY idx_shop_products_block (block_id)`,
    `ALTER TABLE shop_orders ADD COLUMN quantity INT NOT NULL DEFAULT 1`,
    `ALTER TABLE shop_orders ADD COLUMN buyer_id BIGINT NULL`,
    // ⚠️ 懒建表时 D1 兼容层会把 TEXT 改写成 VARCHAR(191)，导致长发货内容/长邀请链接被截断。
    //    这里统一把文本列放宽到 MEDIUMTEXT（幂等：重复 MODIFY 无副作用）。
    `ALTER TABLE shop_orders MODIFY COLUMN deliver_content MEDIUMTEXT NULL`,
    `ALTER TABLE shop_orders MODIFY COLUMN admin_note MEDIUMTEXT NULL`,
    `ALTER TABLE shop_products MODIFY COLUMN description MEDIUMTEXT NULL`,
    `ALTER TABLE shop_products MODIFY COLUMN invite_link MEDIUMTEXT NULL`,
    `ALTER TABLE shop_blocks MODIFY COLUMN description MEDIUMTEXT NULL`,
  ];
  for (const s of statements) {
    try { await env.DB.prepare(s).run(); } catch { /* 已存在 */ }
  }
  _shopColsReady = true;
}

// 条目制商品的库存 = 「可用 BM 组」数（一个 BMID = 一组 = 1 件，组内可有多条链接）
// 组键：bm_id 非空用 bm_id，否则用「#行id」兜底（旧数据/未填 BMID 时每行自成一组）
const ITEM_GROUP_KEY = `IFNULL(NULLIF(bm_id, ''), CONCAT('#', id))`;
async function recalcStockFromItems(env, productId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM shop_product_items WHERE product_id = ?
       GROUP BY ${ITEM_GROUP_KEY} HAVING SUM(status <> 'available') = 0
     ) t`
  ).bind(productId).first().catch(() => null);
  const avail = Number(row && row.n) || 0;
  await env.DB.prepare(`UPDATE shop_products SET stock = ?, updated_at = ? WHERE id = ?`)
    .bind(avail, nowIso(), productId).run().catch(() => {});
  return avail;
}

// 为订单预留 n 个「可用 BM 组」（组内全部行置 reserved，保证一组要么整体可卖要么整体不可卖）
async function reserveOrderGroups(env, productId, orderId, n) {
  const need = Math.max(parseInt(n, 10) || 1, 1);
  const { results } = await env.DB.prepare(
    `SELECT ${ITEM_GROUP_KEY} AS g
       FROM shop_product_items WHERE product_id = ?
       GROUP BY g HAVING SUM(status <> 'available') = 0
       ORDER BY MIN(id) ASC LIMIT ${need}`
  ).bind(productId).all().catch(() => ({ results: [] }));
  const keys = (results || []).map((r) => r.g);
  if (!keys.length) return 0;
  const ph = keys.map(() => '?').join(',');
  const upd = await env.DB.prepare(
    `UPDATE shop_product_items SET status = 'reserved', order_id = ?
      WHERE product_id = ? AND status = 'available' AND ${ITEM_GROUP_KEY} IN (${ph})`
  ).bind(orderId, productId, ...keys).run().catch(() => null);
  return (upd && upd.meta && Number(upd.meta.changes)) || 0;
}

// ============================================================
// 商城独立用户体系（与主系统 users 表完全隔离）
//
// 为什么要独立：商城是对外的售卖官网，销售/客服人员不应持有主系统后台账号；
//               主系统登录态也绝不允许操作商城订单。两套账号互不通用。
// token 用 HMAC 自签（不落库），密钥优先取 SHOP_TOKEN_SECRET，缺省回退机器密钥。
// ⚠️ 服务器 Node 是 v14.17.6，不支持 Buffer 的 base64url 编码，这里自己转 URL 安全 base64。
// ============================================================

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDec = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ⚠️ 网关传进来的 env 只透出 DB / PUPPETEER_API_SECRET（见 src/db.js 的 createD1Env），
//    其它配置项必须回落到 process.env 才拿得到（本项目既有写法）。
const cfg = (env, key) =>
  (env && env[key]) || (typeof process !== 'undefined' && process.env ? process.env[key] : '') || '';

function shopTokenSecret(env) {
  return cfg(env, 'SHOP_TOKEN_SECRET') || cfg(env, 'PUPPETEER_API_SECRET');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const got = Buffer.from(hashPassword(password, salt), 'hex');
    const exp = Buffer.from(String(expectedHash || ''), 'hex');
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  } catch { return false; }
}

function signShopToken(payload, env) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', shopTokenSecret(env)).update(body).digest());
  return `${body}.${sig}`;
}

// 校验商城 token；返回 payload（含 aid/username）或 null
function verifyShopToken(token, env) {
  const secret = shopTokenSecret(env);
  if (!secret) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expect = b64u(crypto.createHmac('sha256', secret).update(parts[0]).digest());
  const a = Buffer.from(expect), b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(b64uDec(parts[0]).toString('utf8'));
    if (!p || !p.exp || Number(p.exp) < Date.now()) return null;
    return p;
  } catch { return null; }
}

// ---------- 鉴权 ----------
// 管理侧只认两种身份：
//   1) X-Api-Secret（本地自动流程 / 运维脚本）
//   2) 商城管理员 token（kind='admin'，shop_admins 登录签发）
// ⚠️ 不再接受主系统 Bearer token；买家 token（kind='buyer'）同样不能进管理端。
function shopAdminAuthorized(request, env) {
  const apiSecret = request.headers.get('X-Api-Secret');
  if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) return true;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const p = verifyShopToken(auth.slice(7).trim(), env);
  if (!p) return false;
  // 兼容早期签发、还没带 kind 但确实带 username 的管理员 token
  return p.kind === 'admin' || (!p.kind && !!p.username);
}

// 当前登录的商城管理员（未登录/买家 token 返回 null）
function currentShopAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const p = verifyShopToken(auth.slice(7).trim(), env);
  if (!p) return null;
  return (p.kind === 'admin' || (!p.kind && !!p.username)) ? p : null;
}

// 当前登录的买家（kind='buyer'）
function currentShopBuyer(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const p = verifyShopToken(auth.slice(7).trim(), env);
  return (p && p.kind === 'buyer') ? p : null;
}

// ---------- 订单号 ----------
function genOrderNo() {
  // S + 时间戳36进制 + 6位随机：撞库靠唯一索引兜底（极小概率重试一次）
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8).padStart(6, '0');
  return `S${ts}${rnd}`.toUpperCase();
}

// 收款方式说明（管理后台在系统设置里配 shop_pay_info）
async function getPayInfo(env) {
  try {
    const row = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'shop_pay_info'`).first();
    return (row && row.setting_value) || '请联系客服确认收款方式。';
  } catch { return '请联系客服确认收款方式。'; }
}

// 商品公开视图：剥离发货内容与内部字段
function publicProduct(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description || '',
    price: Number(r.price) || 0,
    currency: r.currency || 'USDT',
    product_type: r.product_type || 'bm',
    status: r.status,
    // 库存：null = 不限量，0 = 已售罄（前端据此禁用下单按钮）
    stock: r.stock === null || r.stock === undefined ? null : Number(r.stock),
    block_id: r.block_id === null || r.block_id === undefined ? null : Number(r.block_id),
    sort_order: Number(r.sort_order) || 0,
    created_at: r.created_at,
  };
}

// 订单视图：只有 delivered 才回发货内容
function orderView(r) {
  const base = {
    order_no: r.order_no,
    product_title: r.product_title,
    price: Number(r.price) || 0,
    currency: r.currency || 'USDT',
    status: r.status,
    quantity: Math.max(Number(r.quantity) || 1, 1),
    total: (Number(r.price) || 0) * Math.max(Number(r.quantity) || 1, 1),
    is_anonymous: Number(r.is_anonymous) === 1,
    contact_email: r.contact_email || '',
    contact_phone: r.contact_phone || '',
    admin_note: r.admin_note || '',
    created_at: r.created_at,
    paid_at: r.paid_at || '',
    delivered_at: r.delivered_at || '',
  };
  if (r.status === 'delivered') {
    base.deliver_content = r.deliver_content || r.invite_link || '';
  }
  return base;
}

// ============================================================
// 买家侧
// ============================================================

// GET /api/shop/products — 公开商品列表（在售）+ 块（货架）定义
// 返回 { data: 商品数组, blocks: 块数组 }，前端按块渲染、块内自动排列
export async function handleShopProductsList(request, env, corsHeaders) {
  await ensureShopTables(env);
  await ensureShopColumns(env);
  try {
    const [pr, bl] = await Promise.all([
      env.DB.prepare(`SELECT * FROM shop_products WHERE status = 'available' ORDER BY sort_order ASC, id DESC LIMIT 300`).all(),
      env.DB.prepare(`SELECT * FROM shop_blocks ORDER BY sort_order ASC, id ASC LIMIT 100`).all(),
    ]);
    const products = (pr.results || []).map(publicProduct);
    // 只回「还有在售商品」的块，前台不会出现空货架
    const usedBlockIds = new Set(products.map(p => p.block_id).filter(v => v !== null));
    const blocks = (bl.results || [])
      .filter(b => usedBlockIds.has(Number(b.id)))
      .map(b => ({
        id: Number(b.id),
        title: b.title,
        description: b.description || '',
        width_px: Number(b.width_px) || 380,
        min_height_px: Number(b.min_height_px) || 0,
        sort_order: Number(b.sort_order) || 0,
      }));
    return json({ success: true, data: products, blocks }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '商品加载失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/orders — 下单
// body: { product_id, quantity?, contact_email?, contact_phone? }
//   联系方式可留空=匿名下单（凭订单号查单）；
//   填了邮箱或电话 → 自动建/取买家账号并签发登录 token（前端下单即自动登录）。
export async function handleShopOrderCreate(request, env, corsHeaders) {
  await ensureShopTables(env);
  await ensureShopColumns(env);
  const body = await request.json().catch(() => ({}));
  const productId = Number(body.product_id) || 0;
  if (!productId) return json({ success: false, message: '缺少 product_id' }, corsHeaders, 400);

  const quantity = Math.min(Math.max(parseInt(body.quantity, 10) || 1, 1), 999);
  const email = String(body.contact_email || '').trim().toLowerCase().slice(0, 320) || null;
  const phone = String(body.contact_phone || '').trim().slice(0, 64) || null;
  const anonymous = !email && !phone;

  try {
    const product = await env.DB.prepare(`SELECT * FROM shop_products WHERE id = ?`).bind(productId).first();
    if (!product) return json({ success: false, message: '商品不存在' }, corsHeaders, 404);
    if (product.status !== 'available') return json({ success: false, message: '该商品已下架' }, corsHeaders, 400);

    // 库存：null = 不限量；否则原子扣减，避免并发超卖
    if (product.stock !== null && product.stock !== undefined) {
      const dec = await env.DB.prepare(
        `UPDATE shop_products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?`
      ).bind(quantity, nowIso(), productId, quantity).run();
      const changed = dec && dec.meta && Number(dec.meta.changes) > 0;
      if (!changed) {
        return json({ success: false, message: `库存不足，当前仅剩 ${Math.max(Number(product.stock) || 0, 0)} 件` }, corsHeaders, 400);
      }
    }

    // 买家账号：填了联系方式就自动建号 + 直接登录（邮箱/电话均可作账号）
    const now = nowIso();
    let buyerToken = '', buyerAccount = '', buyerHasPassword = false, buyerCreated = false, buyerId = null;
    if (!anonymous) {
      const account = email || phone;
      const accountType = email ? 'email' : 'phone';
      let buyer = await env.DB.prepare(`SELECT * FROM shop_buyers WHERE account = ?`).bind(account).first();
      if (!buyer) {
        const ins = await env.DB.prepare(
          `INSERT INTO shop_buyers (account, account_type, created_at, last_login) VALUES (?, ?, ?, ?)`
        ).bind(account, accountType, now, now).run();
        buyer = { id: (ins && ins.meta && ins.meta.last_row_id) || 0, account, password_hash: null };
        buyerCreated = true;
      } else {
        await env.DB.prepare(`UPDATE shop_buyers SET last_login = ? WHERE id = ?`).bind(now, buyer.id).run().catch(() => {});
      }
      buyerHasPassword = !!buyer.password_hash;
      buyerId = Number(buyer.id) || null;
      buyerToken = signShopToken({ kind: 'buyer', bid: buyer.id, account, exp: Date.now() + 30 * 24 * 3600 * 1000 }, env);
      buyerAccount = account;
    }

    const orderNo = genOrderNo();
    const insRes = await env.DB.prepare(
      `INSERT INTO shop_orders (order_no, product_id, product_title, price, currency, contact_email, contact_phone, is_anonymous, quantity, buyer_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(
      orderNo, product.id, product.title, Number(product.price) || 0, product.currency || 'USDT',
      email, phone, anonymous ? 1 : 0, quantity, buyerId, now
    ).run();

    // 条目制商品：按下单数量预留 BM 组（一个 BMID = 一组 = 1 件，下 N 件就预留 N 组）
    const orderId = (insRes && insRes.meta && insRes.meta.last_row_id) || 0;
    if (orderId) {
      await reserveOrderGroups(env, productId, orderId, quantity);
    }

    return json({
      success: true,
      data: {
        order_no: orderNo,
        product_title: product.title,
        price: Number(product.price) || 0,
        currency: product.currency || 'USDT',
        quantity,
        total: (Number(product.price) || 0) * quantity,
        status: 'pending',
        is_anonymous: anonymous,
        created_at: now,
        pay_info: await getPayInfo(env),
        // 下单即登录：前端拿到 token 直接写入本地登录态
        buyer_token: buyerToken || undefined,
        buyer_account: buyerAccount || undefined,
        buyer_has_password: buyerHasPassword,
        buyer_created: buyerCreated,
      },
    }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '下单失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// GET /api/shop/orders/query?order_no=Sxxx 或 ?contact=邮箱/电话 或 ?order_nos=a,b,c — 查单（公开）
export async function handleShopOrderQuery(request, env, corsHeaders) {
  await ensureShopTables(env);
  await ensureShopColumns(env);
  const url = new URL(request.url);
  const orderNo = String(url.searchParams.get('order_no') || '').trim();
  const orderNos = String(url.searchParams.get('order_nos') || '').trim();
  const contact = String(url.searchParams.get('contact') || '').trim();

  try {
    // 批量按订单号查（本机缓存的匿名订单）——一次拿回，避免前端并发多次请求
    if (orderNos) {
      const list = orderNos.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
      if (!list.length) return json({ success: false, message: '请提供 order_nos' }, corsHeaders, 400);
      const ph = list.map(() => '?').join(',');
      const { results } = await env.DB.prepare(
        `SELECT * FROM shop_orders WHERE order_no IN (${ph}) ORDER BY id DESC LIMIT 50`
      ).bind(...list).all();
      return json({ success: true, data: (results || []).map(orderView), pay_info: await getPayInfo(env) }, corsHeaders);
    }
    if (orderNo) {
      const row = await env.DB.prepare(`SELECT * FROM shop_orders WHERE order_no = ?`).bind(orderNo.slice(0, 64)).first();
      if (!row) return json({ success: false, message: '订单不存在' }, corsHeaders, 404);
      return json({ success: true, data: [orderView(row)], pay_info: await getPayInfo(env) }, corsHeaders);
    }
    if (contact) {
      // 邮箱/电话模糊不了——按原值精确匹配（下单时怎么填的怎么查）
      const cEmail = contact.toLowerCase();
      const { results } = await env.DB.prepare(
        `SELECT * FROM shop_orders WHERE contact_email = ? OR contact_phone = ? ORDER BY id DESC LIMIT 50`
      ).bind(cEmail, contact).all();
      return json({ success: true, data: (results || []).map(orderView), pay_info: await getPayInfo(env) }, corsHeaders);
    }
    return json({ success: false, message: '请提供 order_no / order_nos 或 contact' }, corsHeaders, 400);
  } catch (e) {
    return json({ success: false, message: '查询失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// ============================================================
// 买家账号（邮箱/电话均可作账号；下单自动创建，可设置/修改密码）
// token: kind='buyer'，与商城管理员 token 互不通用
// ============================================================

// POST /api/shop/buyer/login — { account, password }（账号为下单时填的邮箱或电话）
export async function handleShopBuyerLogin(request, env, corsHeaders) {
  await ensureShopTables(env);
  const body = await request.json().catch(() => ({}));
  const account = String(body.account || '').trim().slice(0, 320);
  const password = String(body.password || '');
  if (!account || !password) return json({ success: false, message: '请输入账号和密码' }, corsHeaders, 400);
  try {
    const buyer = await env.DB.prepare(`SELECT * FROM shop_buyers WHERE account = ?`).bind(account.toLowerCase()).first()
      || await env.DB.prepare(`SELECT * FROM shop_buyers WHERE account = ?`).bind(account).first();
    if (!buyer) return json({ success: false, message: '账号或密码错误' }, corsHeaders, 401);
    if (!buyer.password_hash) {
      return json({ success: false, message: '该账号还没设置密码：请先用下单时的邮箱/电话下单（会自动登录），再在「我的订单」里设置密码' }, corsHeaders, 400);
    }
    if (!verifyPassword(password, buyer.salt, buyer.password_hash)) {
      return json({ success: false, message: '账号或密码错误' }, corsHeaders, 401);
    }
    await env.DB.prepare(`UPDATE shop_buyers SET last_login = ? WHERE id = ?`).bind(nowIso(), buyer.id).run().catch(() => {});
    const token = signShopToken({ kind: 'buyer', bid: buyer.id, account: buyer.account, exp: Date.now() + 30 * 24 * 3600 * 1000 }, env);
    return json({ success: true, data: { account: buyer.account, token, has_password: true } }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '登录失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// GET /api/shop/buyer/me — 校验买家 token
export async function handleShopBuyerMe(request, env, corsHeaders) {
  const me = currentShopBuyer(request, env);
  if (!me) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  try {
    const buyer = await env.DB.prepare(`SELECT account, password_hash FROM shop_buyers WHERE id = ?`).bind(me.bid).first();
    return json({
      success: true,
      data: { account: (buyer && buyer.account) || me.account, has_password: !!(buyer && buyer.password_hash) },
    }, corsHeaders);
  } catch (e) {
    return json({ success: true, data: { account: me.account, has_password: false } }, corsHeaders);
  }
}

// POST /api/shop/buyer/password — { new_password, old_password? }
// 首次设置密码不需要原密码；已设置过则必须提供正确的原密码
export async function handleShopBuyerSetPassword(request, env, corsHeaders) {
  const me = currentShopBuyer(request, env);
  if (!me) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  const body = await request.json().catch(() => ({}));
  const newPass = String(body.new_password || '');
  const oldPass = String(body.old_password || '');
  if (newPass.length < 6) return json({ success: false, message: '新密码至少 6 位' }, corsHeaders, 400);
  try {
    const buyer = await env.DB.prepare(`SELECT * FROM shop_buyers WHERE id = ?`).bind(me.bid).first();
    if (!buyer) return json({ success: false, message: '账号不存在' }, corsHeaders, 404);
    if (buyer.password_hash && !verifyPassword(oldPass, buyer.salt, buyer.password_hash)) {
      return json({ success: false, message: '原密码错误' }, corsHeaders, 400);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await env.DB.prepare(`UPDATE shop_buyers SET password_hash = ?, salt = ? WHERE id = ?`)
      .bind(hashPassword(newPass, salt), salt, buyer.id).run();
    return json({ success: true, message: buyer.password_hash ? '密码已修改' : '密码已设置' }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '操作失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// GET /api/shop/buyer/orders — 我的订单（按买家账号或下单时填的联系方式）
export async function handleShopBuyerOrders(request, env, corsHeaders) {
  const me = currentShopBuyer(request, env);
  if (!me) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  await ensureShopColumns(env);
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM shop_orders WHERE buyer_id = ? OR contact_email = ? OR contact_phone = ?
       ORDER BY id DESC LIMIT 200`
    ).bind(me.bid || 0, String(me.account || '').toLowerCase(), me.account || '').all();
    return json({ success: true, data: (results || []).map(orderView), pay_info: await getPayInfo(env) }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '查询失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// ============================================================
// 管理侧
// ============================================================

// ============================================================
// 商城管理员账号（独立用户体系）
// ============================================================

// POST /api/shop/admin/login — { username, password }
// 首次登录引导：shop_admins 表为空时，用服务器环境变量 SHOP_ADMIN_USER / SHOP_ADMIN_PASS
// 校验通过后自动创建该管理员（无需手工初始化脚本）。
export async function handleShopAdminLogin(request, env, corsHeaders) {
  await ensureShopTables(env);
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim().slice(0, 64);
  const password = String(body.password || '');
  if (!username || !password) return json({ success: false, message: '请输入账号和密码' }, corsHeaders, 400);

  try {
    const cntRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM shop_admins`).first();
    const isEmpty = !cntRow || Number(cntRow.n) === 0;

    // 空表 → 允许用环境变量里的初始账号完成初始化
    if (isEmpty) {
      const initUser = String(cfg(env, 'SHOP_ADMIN_USER')).trim();
      const initPass = String(cfg(env, 'SHOP_ADMIN_PASS'));
      if (!initUser || !initPass) {
        return json({ success: false, message: '商城管理员尚未初始化（服务器未配置 SHOP_ADMIN_USER / SHOP_ADMIN_PASS）' }, corsHeaders, 400);
      }
      if (username !== initUser || password !== initPass) {
        return json({ success: false, message: '账号或密码错误' }, corsHeaders, 401);
      }
      const salt = crypto.randomBytes(16).toString('hex');
      await env.DB.prepare(
        `INSERT INTO shop_admins (username, password_hash, salt, status, created_at, last_login) VALUES (?, ?, ?, 'active', ?, ?)`
      ).bind(username, hashPassword(password, salt), salt, nowIso(), nowIso()).run();
      const token = signShopToken({ kind: 'admin', aid: null, username, exp: Date.now() + 7 * 24 * 3600 * 1000 }, env);
      return json({ success: true, data: { username, token, initialized: true } }, corsHeaders);
    }

    const admin = await env.DB.prepare(`SELECT * FROM shop_admins WHERE username = ?`).bind(username).first();
    if (!admin || admin.status !== 'active' || !verifyPassword(password, admin.salt, admin.password_hash)) {
      // 不区分「账号不存在」和「密码错误」，避免账号枚举
      return json({ success: false, message: '账号或密码错误' }, corsHeaders, 401);
    }
    await env.DB.prepare(`UPDATE shop_admins SET last_login = ? WHERE id = ?`).bind(nowIso(), admin.id).run().catch(() => {});
    const token = signShopToken({ kind: 'admin', aid: admin.id, username: admin.username, exp: Date.now() + 7 * 24 * 3600 * 1000 }, env);
    return json({ success: true, data: { username: admin.username, token } }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '登录失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// GET /api/shop/admin/me — 校验 token 是否仍有效（前端启动时调用）
export async function handleShopAdminMe(request, env, corsHeaders) {
  const me = currentShopAdmin(request, env);
  if (!me) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  return json({ success: true, data: { username: me.username } }, corsHeaders);
}

// POST /api/shop/admin/change-password — { old_password, new_password }
export async function handleShopAdminChangePassword(request, env, corsHeaders) {
  const me = currentShopAdmin(request, env);
  if (!me) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  const body = await request.json().catch(() => ({}));
  const oldPass = String(body.old_password || '');
  const newPass = String(body.new_password || '');
  if (newPass.length < 6) return json({ success: false, message: '新密码至少 6 位' }, corsHeaders, 400);
  try {
    const admin = await env.DB.prepare(`SELECT * FROM shop_admins WHERE username = ?`).bind(me.username).first();
    if (!admin || !verifyPassword(oldPass, admin.salt, admin.password_hash)) {
      return json({ success: false, message: '原密码错误' }, corsHeaders, 400);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await env.DB.prepare(`UPDATE shop_admins SET password_hash = ?, salt = ? WHERE id = ?`)
      .bind(hashPassword(newPass, salt), salt, admin.id).run();
    return json({ success: true }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '修改失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// GET /api/shop/admin/products — 全量商品（含发货内容）+ 全部块
export async function handleShopAdminProducts(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  await ensureShopColumns(env);
  try {
    const [pr, bl] = await Promise.all([
      env.DB.prepare(`SELECT * FROM shop_products ORDER BY sort_order ASC, id DESC LIMIT 500`).all(),
      env.DB.prepare(`SELECT * FROM shop_blocks ORDER BY sort_order ASC, id ASC LIMIT 100`).all(),
    ]);
    // 顺带给出「可上架的 BM」：businesses 表里已有 invite_link 且还没上架的
    let importableBms = [];
    try {
      const { results: bms } = await env.DB.prepare(
        `SELECT b.id AS bm_id, b.profile_id, b.name, b.invite_email, b.invite_link, b.invited_at
         FROM businesses b
         WHERE b.invite_link IS NOT NULL AND b.invite_link <> ''
           AND NOT EXISTS (SELECT 1 FROM shop_products p WHERE p.bm_id = b.id AND p.status <> 'delisted')
         ORDER BY b.invited_at DESC LIMIT 200`
      ).all();
      importableBms = bms || [];
    } catch { /* invite 列还没懒建出来时忽略 */ }
    // 附加每个商品的 BM 条目（编辑表单回填 + 显示预留/已发货情况）
    const itemsByProduct = new Map();
    try {
      const { results: itemRows } = await env.DB.prepare(
        `SELECT id, product_id, bm_id, invite_link, status, order_id FROM shop_product_items ORDER BY id ASC LIMIT 5000`
      ).all();
      for (const it of (itemRows || [])) {
        const k = Number(it.product_id);
        if (!itemsByProduct.has(k)) itemsByProduct.set(k, []);
        itemsByProduct.get(k).push({
          id: Number(it.id),
          bm_id: it.bm_id || '',
          invite_link: it.invite_link || '',
          status: it.status,
          order_id: it.order_id === null || it.order_id === undefined ? null : Number(it.order_id),
        });
      }
    } catch { /* 表还没建好时忽略 */ }
    const withItems = (pr.results || []).map(p => ({ ...p, items: itemsByProduct.get(Number(p.id)) || [] }));
    return json({ success: true, data: withItems, blocks: bl.results || [], importable_bms: importableBms }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '查询失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// ---------------- 块（货架）管理 ----------------
// GET /api/shop/admin/blocks
export async function handleShopAdminBlocks(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  try {
    const { results } = await env.DB.prepare(`SELECT * FROM shop_blocks ORDER BY sort_order ASC, id ASC LIMIT 100`).all();
    // 顺带把每个块的在售商品数带上，管理页方便看空块
    const counts = await env.DB.prepare(
      `SELECT block_id, COUNT(*) AS n FROM shop_products WHERE status = 'available' GROUP BY block_id`
    ).all();
    const map = new Map((counts.results || []).map(r => [Number(r.block_id), Number(r.n)]));
    return json({ success: true, data: (results || []).map(b => ({ ...b, product_count: map.get(Number(b.id)) || 0 })) }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '查询失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/admin/blocks/save — { id?, title, description?, width_px?, min_height_px?, sort_order? }
export async function handleShopAdminBlockSave(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 255);
  if (!title) return json({ success: false, message: '缺少块标题' }, corsHeaders, 400);
  const width = Math.min(Math.max(parseInt(body.width_px, 10) || 380, 200), 2000);
  const minH = Math.min(Math.max(parseInt(body.min_height_px, 10) || 0, 0), 2000);
  const sortOrder = parseInt(body.sort_order, 10) || 0;
  const now = nowIso();
  try {
    if (body.id) {
      await env.DB.prepare(
        `UPDATE shop_blocks SET title=?, description=?, width_px=?, min_height_px=?, sort_order=?, updated_at=? WHERE id=?`
      ).bind(title, String(body.description || '').slice(0, 2000), width, minH, sortOrder, now, Number(body.id)).run();
      return json({ success: true, id: Number(body.id) }, corsHeaders);
    }
    const r = await env.DB.prepare(
      `INSERT INTO shop_blocks (title, description, width_px, min_height_px, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(title, String(body.description || '').slice(0, 2000), width, minH, sortOrder, now, now).run();
    return json({ success: true, id: (r && r.meta && r.meta.last_row_id) || null }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '保存失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/admin/blocks/delete — { id }  块内商品自动回到「未分组」，不删商品
export async function handleShopAdminBlockDelete(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  await ensureShopColumns(env);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id) || 0;
  if (!id) return json({ success: false, message: '缺少 id' }, corsHeaders, 400);
  try {
    await env.DB.prepare(`UPDATE shop_products SET block_id = NULL WHERE block_id = ?`).bind(id).run().catch(() => {});
    await env.DB.prepare(`DELETE FROM shop_blocks WHERE id = ?`).bind(id).run();
    return json({ success: true }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '删除失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/admin/products/save — 新增/编辑商品
// body: { id?, title, description?, price, currency?, product_type?, invite_link?, bm_id?, profile_id?,
//         block_id?, stock?, sort_order?, status?, items? }
//   block_id: 归属块（空=未分组）
//   items: [{ id?, bm_id, invite_link }] —— BM 条目（一个 BMID = 一组数量）。
//          传了 items 即为「条目制」：库存 = 可用条目数（自动），下单按下单数量预留、发货发 N 组。
//          传了 items 时 stock 字段被忽略（由条目数决定）；不传 items 保持旧「手填 stock」兼容。
export async function handleShopAdminProductSave(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  await ensureShopColumns(env);
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 255);
  if (!title) return json({ success: false, message: '缺少 title' }, corsHeaders, 400);

  const blank = (v) => v === '' || v === null || v === undefined;
  const rawItems = Array.isArray(body.items) ? body.items : null;
  // 条目制：用第一组 BM 回填 legacy 单链接字段（仅用于列表展示，发货以条目为准）
  let firstBmId = body.bm_id, firstLink = body.invite_link;
  if (rawItems) {
    const first = rawItems.find(it => String((it && it.bm_id) || '').trim() || String((it && it.invite_link) || '').trim());
    if (first) { firstBmId = first.bm_id; firstLink = first.invite_link; }
  }
  const vals = {
    title,
    description: String(body.description || '').slice(0, 2000),
    price: Number(body.price) || 0,
    currency: String(body.currency || 'USDT').slice(0, 16),
    product_type: String(body.product_type || 'bm').slice(0, 32),
    invite_link: String(firstLink || ''),
    bm_id: blank(firstBmId) ? null : String(firstBmId).slice(0, 191),
    profile_id: blank(body.profile_id) ? null : String(body.profile_id).slice(0, 191),
    block_id: blank(body.block_id) ? null : (Number(body.block_id) || null),
    stock: rawItems ? null : (blank(body.stock) ? null : Math.max(parseInt(body.stock, 10) || 0, 0)),
    sort_order: parseInt(body.sort_order, 10) || 0,
  };
  const now = nowIso();
  const baseCols = `title=?, description=?, price=?, currency=?, product_type=?, invite_link=?, bm_id=?, profile_id=?, block_id=?, stock=?, sort_order=?`;
  const baseVals = [vals.title, vals.description, vals.price, vals.currency, vals.product_type, vals.invite_link, vals.bm_id, vals.profile_id, vals.block_id, vals.stock, vals.sort_order];
  try {
    let productId = Number(body.id) || 0;
    // 🔁 按 bm_id 防重：没带 id 但带了 bm_id 时，若该 BM 已有未下架商品则转更新，
    //    避免「自动上架」重复执行（重试/再次生成链接）时插入重复商品。
    if (!productId && vals.bm_id) {
      try {
        const dup = await env.DB.prepare(
          `SELECT id FROM shop_products WHERE bm_id = ? AND status <> 'delisted' ORDER BY id DESC LIMIT 1`
        ).bind(vals.bm_id).first();
        if (dup && dup.id) productId = Number(dup.id);
      } catch { /* 表结构差异时忽略，走原插入 */ }
    }
    // 🔁 条目合并模式（itemsMerge）：自动上架追加新链接时不覆盖商品主字段、
    //    不清掉已有条目，只把「云端还没有的 invite_link」插进去。
    if (productId && body.itemsMerge && rawItems) {
      let added = 0, skipped = 0;
      let existingLinks = new Set();
      try {
        const { results: ex } = await env.DB.prepare(
          `SELECT invite_link FROM shop_product_items WHERE product_id = ? AND invite_link IS NOT NULL`
        ).bind(productId).all();
        existingLinks = new Set((ex || []).map(r => String(r.invite_link || '')));
      } catch { /* 表还没建时忽略 */ }
      const now2 = nowIso();
      for (const it of rawItems) {
        const bmId = String((it && it.bm_id) || '').trim().slice(0, 191);
        const link = String((it && it.invite_link) || '').trim();
        if (!bmId && !link) continue;
        if (link && existingLinks.has(link)) { skipped++; continue; }
        await env.DB.prepare(
          `INSERT INTO shop_product_items (product_id, bm_id, invite_link, status, created_at) VALUES (?, ?, ?, 'available', ?)`
        ).bind(productId, bmId || null, link || null, now2).run();
        added++;
      }
      // 🐛 追加条目后必须重算库存：下单/展示读的是主表 stock 列（L393 原子扣减），
      //    不重算的话 itemsMerge 新增的组不会反映到商品数量（任务显示成功但数量不涨）。
      if (added > 0) await recalcStockFromItems(env, productId);
      return json({ success: true, id: productId, merged: true, added, skipped }, corsHeaders);
    }
    if (body.id) {
      if (body.status) {
        await env.DB.prepare(`UPDATE shop_products SET ${baseCols}, status=?, updated_at=? WHERE id=?`)
          .bind(...baseVals, String(body.status).slice(0, 32), now, productId).run();
      } else {
        await env.DB.prepare(`UPDATE shop_products SET ${baseCols}, updated_at=? WHERE id=?`)
          .bind(...baseVals, now, productId).run();
      }
    } else {
      const r = await env.DB.prepare(
        `INSERT INTO shop_products (title, description, price, currency, product_type, invite_link, bm_id, profile_id, block_id, stock, sort_order, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`
      ).bind(...baseVals, now, now).run();
      productId = (r && r.meta && r.meta.last_row_id) || 0;
    }

    // 条目制：重建 BM 条目（已预留/已发货带 id 的条目原地更新，不影响其状态）
    if (rawItems && productId) {
      const keepIds = [];
      for (const it of rawItems) {
        const itId = Number(it && it.id) || 0;
        const bmId = String((it && it.bm_id) || '').trim().slice(0, 191);
        const link = String((it && it.invite_link) || '').trim();
        if (!bmId && !link) continue;
        if (itId) {
          await env.DB.prepare(`UPDATE shop_product_items SET bm_id = ?, invite_link = ? WHERE id = ? AND product_id = ?`)
            .bind(bmId || null, link || null, itId, productId).run();
          keepIds.push(itId);
        } else {
          const ins = await env.DB.prepare(
            `INSERT INTO shop_product_items (product_id, bm_id, invite_link, status, created_at) VALUES (?, ?, ?, 'available', ?)`
          ).bind(productId, bmId || null, link || null, now).run();
          const nid = (ins && ins.meta && ins.meta.last_row_id) || 0;
          if (nid) keepIds.push(nid);
        }
      }
      // 删除被管理员移除的「可用」条目（预留/已发货的条目保留，避免影响进行中的订单）
      if (keepIds.length) {
        const ph = keepIds.map(() => '?').join(',');
        await env.DB.prepare(
          `DELETE FROM shop_product_items WHERE product_id = ? AND status = 'available' AND id NOT IN (${ph})`
        ).bind(productId, ...keepIds).run();
      } else {
        await env.DB.prepare(`DELETE FROM shop_product_items WHERE product_id = ? AND status = 'available'`).bind(productId).run();
      }
      await recalcStockFromItems(env, productId);
    }
    return json({ success: true, id: productId }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '保存失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/admin/products/delete — 删除/下架商品 body: { id, hard? }
export async function handleShopAdminProductDelete(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id) || 0;
  if (!id) return json({ success: false, message: '缺少 id' }, corsHeaders, 400);
  try {
    if (body.hard) {
      await env.DB.prepare(`DELETE FROM shop_product_items WHERE product_id = ?`).bind(id).run().catch(() => {});
      await env.DB.prepare(`DELETE FROM shop_products WHERE id = ?`).bind(id).run();
    } else {
      await env.DB.prepare(`UPDATE shop_products SET status = 'delisted', updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
    }
    return json({ success: true }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '操作失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// GET /api/shop/admin/orders?status= — 订单列表
export async function handleShopAdminOrders(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  await ensureShopColumns(env);
  const url = new URL(request.url);
  const status = String(url.searchParams.get('status') || '').trim();
  try {
    const rows = status
      ? (await env.DB.prepare(`SELECT * FROM shop_orders WHERE status = ? ORDER BY id DESC LIMIT 500`).bind(status).all()).results
      : (await env.DB.prepare(`SELECT * FROM shop_orders ORDER BY id DESC LIMIT 500`).all()).results;
    // pay_info 一并返回：管理页「收款方式说明」编辑框直接读现有值
    return json({ success: true, data: rows || [], pay_info: await getPayInfo(env) }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '查询失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/admin/orders/confirm-paid — 人工确认收款 body: { id, pay_method? }
export async function handleShopAdminOrderConfirmPaid(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id) || 0;
  if (!id) return json({ success: false, message: '缺少 id' }, corsHeaders, 400);
  try {
    const r = await env.DB.prepare(
      `UPDATE shop_orders SET status = 'paid', pay_method = ?, paid_at = ? WHERE id = ? AND status = 'pending'`
    ).bind(String(body.pay_method || 'manual').slice(0, 32), nowIso(), id).run();
    const changed = r && r.meta && Number(r.meta.changes) > 0;
    return json({ success: changed, message: changed ? 'ok' : '订单不存在或状态不允许' }, corsHeaders, changed ? 200 : 400);
  } catch (e) {
    return json({ success: false, message: '操作失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/admin/orders/deliver — 发货 body: { id }
// 快照商品发货内容进订单，商品置 sold；重复发货幂等（已 delivered 直接成功返回）
export async function handleShopAdminOrderDeliver(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id) || 0;
  if (!id) return json({ success: false, message: '缺少 id' }, corsHeaders, 400);
  try {
    const order = await env.DB.prepare(`SELECT * FROM shop_orders WHERE id = ?`).bind(id).first();
    if (!order) return json({ success: false, message: '订单不存在' }, corsHeaders, 404);
    if (order.status === 'delivered') return json({ success: true, message: '已发货' }, corsHeaders);
    if (order.status !== 'paid' && order.status !== 'pending') {
      return json({ success: false, message: `状态 ${order.status} 不允许发货` }, corsHeaders, 400);
    }
    const now = nowIso();
    // 发货内容：优先取本订单预留的 BM 组（一个 BMID 一组，组内可有多条链接，一起发）；
    // 没有条目（旧商品/单链接商品）则回退商品的单条 invite_link。
    let content = '';
    if (order.product_id) {
      const itemRes = await env.DB.prepare(
        `SELECT id, bm_id, invite_link FROM shop_product_items WHERE order_id = ? ORDER BY ${ITEM_GROUP_KEY} ASC, id ASC`
      ).bind(id).all().catch(() => ({ results: [] }));
      const itemRows = (itemRes && itemRes.results) || [];
      if (itemRows.length > 0) {
        const groups = [];
        const gmap = new Map();
        for (const it of itemRows) {
          const key = String(it.bm_id || '').trim() || `#${it.id}`;
          if (!gmap.has(key)) { const g = { bm: it.bm_id || '', links: [] }; gmap.set(key, g); groups.push(g); }
          gmap.get(key).links.push(it.invite_link || '');
        }
        content = groups.map((g) => `BMID: ${g.bm || '-'}\n` + g.links.map((l) => `链接: ${l}`).join('\n')).join('\n\n');
        await env.DB.prepare(
          `UPDATE shop_product_items SET status = 'delivered', delivered_at = ? WHERE order_id = ? AND status IN ('reserved', 'delivered')`
        ).bind(now, id).run().catch(() => {});
      } else {
        const p = await env.DB.prepare(`SELECT invite_link FROM shop_products WHERE id = ?`).bind(order.product_id).first();
        content = (p && p.invite_link) || '';
      }
    }
    await env.DB.prepare(
      `UPDATE shop_orders SET status = 'delivered', deliver_content = ?, delivered_at = ?, paid_at = COALESCE(paid_at, ?) WHERE id = ?`
    ).bind(content, now, now, id).run();
    // 商品是否收尾：限量商品（stock 不为 NULL）发货后不动状态，卖完靠 stock=0 显示售罄；
    // 不限量商品（单件制）发货即置 sold。可能已被删/下架，忽略失败。
    if (order.product_id) {
      const sp = await env.DB.prepare(`SELECT stock FROM shop_products WHERE id = ?`).bind(order.product_id).first().catch(() => null);
      if (!sp || sp.stock === null || sp.stock === undefined) {
        await env.DB.prepare(`UPDATE shop_products SET status = 'sold', updated_at = ? WHERE id = ?`).bind(now, order.product_id).run().catch(() => {});
      }
    }
    return json({ success: true }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '发货失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/admin/pay-info — 保存收款方式说明（存 system_settings.shop_pay_info）
export async function handleShopAdminPayInfoSave(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  const body = await request.json().catch(() => ({}));
  const info = String(body.pay_info || '').slice(0, 4000);
  try {
    await env.DB.prepare(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES ('shop_pay_info', ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`
    ).bind(info, nowIso()).run();
    return json({ success: true }, corsHeaders);
  } catch (e) {
    return json({ success: false, message: '保存失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/shop/admin/orders/cancel — 取消订单 body: { id, note? }
export async function handleShopAdminOrderCancel(request, env, corsHeaders) {
  if (!shopAdminAuthorized(request, env)) return json({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  await ensureShopTables(env);
  await ensureShopColumns(env);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id) || 0;
  if (!id) return json({ success: false, message: '缺少 id' }, corsHeaders, 400);
  try {
    const order = await env.DB.prepare(`SELECT * FROM shop_orders WHERE id = ?`).bind(id).first();
    if (!order) return json({ success: false, message: '订单不存在' }, corsHeaders, 404);
    if (order.status === 'delivered' || order.status === 'cancelled') {
      return json({ success: false, message: order.status === 'delivered' ? '已发货不可取消' : '订单已取消' }, corsHeaders, 400);
    }
    const r = await env.DB.prepare(
      `UPDATE shop_orders SET status = 'cancelled', admin_note = COALESCE(NULLIF(?, ''), admin_note) WHERE id = ?`
    ).bind(String(body.note || '').slice(0, 1000), id).run();
    const changed = r && r.meta && Number(r.meta.changes) > 0;
    // 取消后回补库存：条目制订单释放预留条目并重算库存；旧商品按数量还回手填库存
    if (changed && order.product_id) {
      const freed = await env.DB.prepare(
        `UPDATE shop_product_items SET status = 'available', order_id = NULL, delivered_at = NULL WHERE order_id = ? AND status = 'reserved'`
      ).bind(id).run().catch(() => null);
      const freedN = freed && freed.meta ? Number(freed.meta.changes) : 0;
      if (freedN > 0) {
        await recalcStockFromItems(env, order.product_id);
      } else {
        await env.DB.prepare(
          `UPDATE shop_products SET stock = stock + ?, updated_at = ? WHERE id = ? AND stock IS NOT NULL`
        ).bind(Math.max(Number(order.quantity) || 1, 1), nowIso(), order.product_id).run().catch(() => {});
      }
    }
    return json({ success: changed, message: changed ? 'ok' : '操作失败' }, corsHeaders, changed ? 200 : 400);
  } catch (e) {
    return json({ success: false, message: '操作失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}
