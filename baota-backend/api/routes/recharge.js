/**
 * U 充值（TRC20-USDT）+ 余额
 *
 * 订单定位机制：用户输入整数金额（如 100），服务端在后面追加 4 位随机小数
 * （如 100.3748）生成「应付金额」。同一时间未完成订单的应付金额全局唯一，
 * 链上只要出现一笔金额精确相等的 USDT 转入即可唯一定位到这张订单 —— 无需备注。
 *
 * 到账确认：TronGrid 轮询（startRechargePoller，由 src/index.js 启动）。
 * 管理员手动「确认到账 / 拒绝」作为兜底；余额变动一律走 confirmOrder 统一入账。
 *
 * 相关表（懒创建，schema-mysql.sql 同步维护）：
 *   recharge_orders / wallet_transactions / system_settings；users.balance 懒加列。
 */

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ORDER_TTL_MINUTES = 30;
const AMOUNT_DECIMALS = 4; // 随机小数位数：0000~9999 共 1 万个档位，pending 查重后碰撞概率极低

// ---------- 鉴权 ----------

function resolveAuth(request, env) {
  const apiSecret = request.headers.get('X-Api-Secret');
  if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) return { uid: '1', role: 'superadmin' };
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  try {
    const tokenData = atob(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);
    const parts = tokenData.split(':');
    const uid = Number(parts[0] || 0);
    if (!uid) return null;
    return { uid: String(uid), role: parts[2] || 'user' };
  } catch { return null; }
}

const isSuperadmin = (auth) => auth && auth.role === 'superadmin';

const json = (data, status = 200, corsHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
});

// ---------- 建表 / 配置 ----------

let _tablesReady = false;
async function ensureTables(env) {
  if (_tablesReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS recharge_orders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_no VARCHAR(64) NOT NULL,
    user_id BIGINT NOT NULL,
    base_amount DOUBLE NOT NULL DEFAULT 0,
    amount DOUBLE NOT NULL,
    network VARCHAR(32) NOT NULL DEFAULT 'TRC20',
    wallet_address VARCHAR(191) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    tx_hash VARCHAR(191) NULL,
    from_address VARCHAR(191) NULL,
    note VARCHAR(255) NULL,
    confirmed_at VARCHAR(32) NULL,
    expires_at VARCHAR(32) NULL,
    created_at VARCHAR(32) NULL,
    updated_at VARCHAR(32) NULL,
    UNIQUE KEY uq_recharge_order_no (order_no),
    KEY idx_recharge_amount (amount),
    KEY idx_recharge_status (status),
    KEY idx_recharge_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).run().catch(() => {});

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wallet_transactions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    type VARCHAR(32) NOT NULL,
    amount DOUBLE NOT NULL DEFAULT 0,
    balance_after DOUBLE NULL DEFAULT 0,
    ref_id VARCHAR(64) NULL,
    note VARCHAR(255) NULL,
    created_at VARCHAR(32) NULL,
    KEY idx_wallet_tx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).run().catch(() => {});

  // 系统级配置（收款地址 / TronGrid Key / 金额上下限），仅 superadmin 可写
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(191) PRIMARY KEY,
    setting_value LONGTEXT NULL,
    updated_at VARCHAR(32) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).run().catch(() => {});

  // 用户余额列（懒加列，db.js 对重复 ADD COLUMN 自动跳过）
  try { await env.DB.exec(`ALTER TABLE users ADD COLUMN balance DOUBLE NULL DEFAULT 0`); } catch { /* 已存在 */ }

  _tablesReady = true;
}

async function getSetting(env, key, fallback = '') {
  const row = await env.DB.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = ?`).bind(key).first().catch(() => null);
  const v = row && row.setting_value !== null && row.setting_value !== undefined ? String(row.setting_value) : '';
  return v || fallback;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO system_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
  `).bind(key, String(value ?? ''), new Date().toISOString()).run();
}

async function getRechargeConfig(env) {
  const [walletAddress, network, trongridKey, minAmount, maxAmount] = await Promise.all([
    getSetting(env, 'recharge_wallet_address'),
    getSetting(env, 'recharge_network', 'TRC20'),
    getSetting(env, 'recharge_trongrid_api_key'),
    getSetting(env, 'recharge_min_amount', '10'),
    getSetting(env, 'recharge_max_amount', '100000'),
  ]);
  return {
    walletAddress,
    network,
    hasTronGridKey: !!trongridKey,
    minAmount: Number(minAmount) || 10,
    maxAmount: Number(maxAmount) || 100000,
  };
}

// ---------- 余额 ----------

async function getBalance(env, userId) {
  const row = await env.DB.prepare(`SELECT balance FROM users WHERE id = ?`).bind(Number(userId)).first().catch(() => null);
  return row && row.balance !== null && row.balance !== undefined ? Number(row.balance) || 0 : 0;
}

/** 确认订单并入账（poller 与管理员手动确认共用，天然幂等：已确认直接返回） */
async function confirmOrder(env, order, txHash, fromAddress) {
  const o = order;
  if (String(o.status) === 'confirmed') return { ok: true, already: true };
  const nowIso = new Date().toISOString();
  const balanceBefore = await getBalance(env, o.user_id);
  const balanceAfter = balanceBefore + Number(o.amount);
  await env.DB.batch([
    env.DB.prepare(`UPDATE recharge_orders SET status = 'confirmed', tx_hash = ?, from_address = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`)
      .bind(txHash || 'manual', fromAddress || '', nowIso, nowIso, o.id),
    env.DB.prepare(`UPDATE users SET balance = ? WHERE id = ?`).bind(balanceAfter, o.user_id),
    env.DB.prepare(`INSERT INTO wallet_transactions (user_id, type, amount, balance_after, ref_id, note, created_at)
                    VALUES (?, 'recharge', ?, ?, ?, ?, ?)`)
      .bind(o.user_id, Number(o.amount), balanceAfter, o.order_no, `充值到账 ${o.order_no}`, nowIso),
  ]);
  return { ok: true, balanceAfter };
}

// ---------- 用户端接口 ----------

/**
 * POST /api/recharge/create — body: { amount: number }
 * 服务端生成随机小数 → 应付金额在未完成订单中全局唯一
 */
export async function handleRechargeCreate(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return json({ success: false, message: 'Unauthorized' }, 401, corsHeaders);
  await ensureTables(env);

  const cfg = await getRechargeConfig(env);
  if (!cfg.walletAddress) {
    return json({ success: false, message: '管理员尚未配置 USDT 收款地址，请联系管理员' }, 400, corsHeaders);
  }

  const body = await request.json().catch(() => ({}));
  const n = Number(body && body.amount);
  if (!Number.isFinite(n) || n <= 0) {
    return json({ success: false, message: '请输入有效的充值金额' }, 400, corsHeaders);
  }
  const base = Math.round(n * 100) / 100; // 输入最多两位小数
  if (base < cfg.minAmount || base > cfg.maxAmount) {
    return json({ success: false, message: `单笔充值金额需在 ${cfg.minAmount} ~ ${cfg.maxAmount} USDT 之间` }, 400, corsHeaders);
  }

  // 生成唯一应付金额：与「未完成订单」查重；也避开 24h 内已到账订单（防止链上晚到转账撞单）
  let amount = 0;
  let ok = false;
  for (let i = 0; i < 25; i++) {
    const suffix = String(Math.floor(Math.random() * 9999) + 1).padStart(AMOUNT_DECIMALS, '0');
    const cand = Number((base + Number(suffix) / Math.pow(10, AMOUNT_DECIMALS)).toFixed(AMOUNT_DECIMALS));
    const { results } = await env.DB.prepare(`
      SELECT id FROM recharge_orders
      WHERE amount = ? AND (status IN ('pending', 'matched')
        OR (status = 'confirmed' AND created_at > ?))
      LIMIT 1
    `).bind(cand, new Date(Date.now() - 24 * 3600 * 1000).toISOString()).all().catch(() => ({ results: [] }));
    if (!results || results.length === 0) { amount = cand; ok = true; break; }
  }
  if (!ok) return json({ success: false, message: '当前金额档位繁忙，请稍后重试或换个金额' }, 409, corsHeaders);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ORDER_TTL_MINUTES * 60 * 1000).toISOString();
  const orderNo = `RC${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const r = await env.DB.prepare(`
    INSERT INTO recharge_orders (order_no, user_id, base_amount, amount, network, wallet_address, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(orderNo, Number(auth.uid), base, amount, cfg.network, cfg.walletAddress, expiresAt, now.toISOString(), now.toISOString()).run();

  return json({
    success: true,
    data: {
      orderId: r.meta && r.meta.last_row_id ? Number(r.meta.last_row_id) : 0,
      orderNo,
      baseAmount: base,
      amount,
      amountStr: amount.toFixed(AMOUNT_DECIMALS),
      network: cfg.network,
      walletAddress: cfg.walletAddress,
      expiresAt,
      ttlMinutes: ORDER_TTL_MINUTES,
    },
  }, 200, corsHeaders);
}

/**
 * GET /api/recharge/orders — 当前用户订单 + 余额
 * GET /api/recharge/orders?all=1 — superadmin 查看全部（可 ?status=pending）
 */
export async function handleRechargeOrders(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return json({ success: false, message: 'Unauthorized' }, 401, corsHeaders);
  await ensureTables(env);

  const url = new URL(request.url);
  const wantAll = url.searchParams.get('all') === '1' && isSuperadmin(auth);
  const status = (url.searchParams.get('status') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 300);

  const where = [];
  const params = [];
  if (!wantAll) where.push('user_id = ?');
  if (status) where.push('status = ?');
  const sql = `SELECT * FROM recharge_orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`;
  if (!wantAll) params.push(Number(auth.uid));
  if (status) params.push(status);

  const { results } = await env.DB.prepare(sql).bind(...params).all().catch(() => ({ results: [] }));
  const orders = (results || []).map((o) => ({
    id: Number(o.id),
    orderNo: o.order_no,
    userId: Number(o.user_id),
    baseAmount: Number(o.base_amount) || 0,
    amount: Number(o.amount) || 0,
    amountStr: (Number(o.amount) || 0).toFixed(AMOUNT_DECIMALS),
    network: o.network,
    walletAddress: o.wallet_address,
    status: o.status,
    txHash: o.tx_hash || '',
    fromAddress: o.from_address || '',
    confirmedAt: o.confirmed_at || '',
    expiresAt: o.expires_at || '',
    createdAt: o.created_at || '',
  }));

  // 管理员看全部时附带用户邮箱，便于人工核对
  if (wantAll && orders.length) {
    const { results: users } = await env.DB.prepare(`SELECT id, email, username FROM users`).all().catch(() => ({ results: [] }));
    const um = new Map((users || []).map((u) => [Number(u.id), u]));
    for (const o of orders) {
      const u = um.get(o.userId);
      o.userEmail = u ? (u.email || u.username || `#${o.userId}`) : `#${o.userId}`;
    }
  }

  const balance = await getBalance(env, Number(auth.uid));
  return json({ success: true, data: { balance, orders } }, 200, corsHeaders);
}

/** GET /api/recharge/config — 已登录用户获取收款配置（不含 TronGrid Key） */
export async function handleRechargeConfig(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return json({ success: false, message: 'Unauthorized' }, 401, corsHeaders);
  await ensureTables(env);
  const cfg = await getRechargeConfig(env);
  const balance = await getBalance(env, Number(auth.uid));
  return json({ success: true, data: { ...cfg, balance } }, 200, corsHeaders);
}

// ---------- 管理端接口（superadmin）----------

/** GET /api/recharge/admin/config */
export async function handleRechargeAdminConfigGet(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!isSuperadmin(auth)) return json({ success: false, message: 'Forbidden' }, 403, corsHeaders);
  await ensureTables(env);
  const cfg = await getRechargeConfig(env);
  return json({ success: true, data: cfg }, 200, corsHeaders);
}

/** POST /api/recharge/admin/config — { walletAddress, network, tronGridKey, minAmount, maxAmount } */
export async function handleRechargeAdminConfigSave(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!isSuperadmin(auth)) return json({ success: false, message: 'Forbidden' }, 403, corsHeaders);
  await ensureTables(env);
  const body = await request.json().catch(() => ({}));
  if (body.walletAddress !== undefined) await setSetting(env, 'recharge_wallet_address', String(body.walletAddress).trim());
  if (body.network !== undefined) await setSetting(env, 'recharge_network', String(body.network).trim() || 'TRC20');
  // 传空字符串视为清除 Key；未传该字段则不动（避免误清）
  if (body.tronGridKey !== undefined) await setSetting(env, 'recharge_trongrid_api_key', String(body.tronGridKey).trim());
  if (body.minAmount !== undefined) await setSetting(env, 'recharge_min_amount', String(Number(body.minAmount) || 10));
  if (body.maxAmount !== undefined) await setSetting(env, 'recharge_max_amount', String(Number(body.maxAmount) || 100000));
  const cfg = await getRechargeConfig(env);
  return json({ success: true, data: cfg }, 200, corsHeaders);
}

/** POST /api/recharge/admin/confirm — { orderId } 手动确认到账（兜底） */
export async function handleRechargeAdminConfirm(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!isSuperadmin(auth)) return json({ success: false, message: 'Forbidden' }, 403, corsHeaders);
  await ensureTables(env);
  const body = await request.json().catch(() => ({}));
  const id = Number(body && body.orderId);
  if (!id) return json({ success: false, message: '缺少 orderId' }, 400, corsHeaders);
  const order = await env.DB.prepare(`SELECT * FROM recharge_orders WHERE id = ?`).bind(id).first().catch(() => null);
  if (!order) return json({ success: false, message: '订单不存在' }, 404, corsHeaders);
  if (String(order.status) === 'rejected' || String(order.status) === 'expired') {
    return json({ success: false, message: `订单已${order.status === 'rejected' ? '拒绝' : '过期'}，不能确认` }, 400, corsHeaders);
  }
  const res = await confirmOrder(env, order, String((body && body.txHash) || 'manual'), '');
  return json({ success: true, data: res }, 200, corsHeaders);
}

/** POST /api/recharge/admin/reject — { orderId, reason? } */
export async function handleRechargeAdminReject(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!isSuperadmin(auth)) return json({ success: false, message: 'Forbidden' }, 403, corsHeaders);
  await ensureTables(env);
  const body = await request.json().catch(() => ({}));
  const id = Number(body && body.orderId);
  if (!id) return json({ success: false, message: '缺少 orderId' }, 400, corsHeaders);
  await env.DB.prepare(`UPDATE recharge_orders SET status = 'rejected', note = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(String((body && body.reason) || '管理员拒绝'), new Date().toISOString(), id).run();
  return json({ success: true }, 200, corsHeaders);
}

// ---------- TronGrid 自动对账（由 src/index.js 启动，仅 Node 进程内运行）----------

let _pollerStarted = false;
export function startRechargePoller(env) {
  if (_pollerStarted) return;
  _pollerStarted = true;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(env);
    } catch (e) {
      console.error('[recharge-poller] cycle error:', (e && e.message) || e);
    } finally {
      running = false;
    }
  };

  // 每 25s 一轮；TronGrid 免费额度完全够用（每轮最多 1 次链上请求）
  setTimeout(tick, 8000).unref?.();
  setInterval(tick, 25000).unref?.();
  console.log('[recharge-poller] started (every 25s)');
}

async function pollOnce(env) {
  await ensureTables(env);

  // 1) 过期未付订单置为 expired，释放其金额档位
  await env.DB.prepare(`UPDATE recharge_orders SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at < ?`)
    .bind(new Date().toISOString(), new Date().toISOString()).run().catch(() => {});

  // 2) 取未过期 pending 订单
  const { results: pending } = await env.DB.prepare(
    `SELECT * FROM recharge_orders WHERE status = 'pending' AND expires_at >= ? ORDER BY id ASC LIMIT 200`
  ).bind(new Date().toISOString()).all().catch(() => ({ results: [] }));
  if (!pending || pending.length === 0) return;

  const cfg = await getRechargeConfig(env);
  if (!cfg.walletAddress) return;

  // 3) 拉取该地址最近 USDT TRC20 转入（只查已确认）
  const oldest = pending.reduce((acc, o) => Math.min(acc, Date.parse(o.created_at || '') || acc), Date.now());
  const minTimestamp = Math.max(0, oldest - 10 * 60 * 1000); // 放宽 10 分钟时钟偏差
  const url = `https://api.trongrid.io/v1/accounts/${encodeURIComponent(cfg.walletAddress)}/transactions/trc20`
    + `?only_confirmed=true&only_to=true&limit=100&contract_address=${USDT_TRC20_CONTRACT}&min_timestamp=${minTimestamp}`;
  const headers = { 'accept': 'application/json' };
  const apiKey = cfg.hasTronGridKey ? (await getSetting(env, 'recharge_trongrid_api_key')) : (process.env.TRONGRID_API_KEY || '');
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  let transfers = [];
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) { console.error('[recharge-poller] trongrid http', resp.status); return; }
    const j = await resp.json();
    transfers = (j && Array.isArray(j.data)) ? j.data : [];
  } catch (e) {
    console.error('[recharge-poller] trongrid fetch failed:', (e && e.message) || e);
    return;
  }

  // 4) 金额精确匹配（微 USDT 整数比较，避开浮点误差）；一笔转账只入一张订单，先进先出
  const used = new Set();
  for (const t of transfers) {
    if (!t || t.type !== 'Transfer' || !t.transaction_id || used.has(t.transaction_id)) continue;
    if (String(t.to || '').toUpperCase() !== String(cfg.walletAddress).toUpperCase()) continue;
    const micro = Math.round(Number(t.value)); // USDT 有 6 位小数，value 为微单位字符串
    if (!Number.isFinite(micro) || micro <= 0) continue;

    const hit = pending.find((o) => o.status === 'pending' && Math.round(Number(o.amount) * 1e6) === micro);
    if (!hit) continue;

    // 该 tx 是否已被其它订单占用（防重复入账）
    const dup = await env.DB.prepare(`SELECT id FROM recharge_orders WHERE tx_hash = ? LIMIT 1`).bind(t.transaction_id).first().catch(() => null);
    if (dup) { used.add(t.transaction_id); continue; }

    const r = await confirmOrder(env, hit, t.transaction_id, String(t.from || ''));
    used.add(t.transaction_id);
    hit.status = 'confirmed';
    console.log(`[recharge-poller] order ${hit.order_no} confirmed by tx ${t.transaction_id}`, r);
  }
}
