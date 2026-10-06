/**
 * 广告数据追踪（Meta insights，广告层级）
 *
 * 数据来源：本地后端（puppeteer 浏览器上下文抓 Graph API）抓完后直接调
 * /api/insights/bulk-save 推上来（X-Api-Secret，归属按 profile_id → profiles.user_id 映射，
 * 与 adaccounts/bulk-save 同一套机制）。前端用 Bearer 走 /api/insights 读取，按用户隔离。
 *
 * 唯一键 (profile_id, ad_id, date_preset)：同一配置同一广告同一时间段的指标反复刷新覆盖更新。
 */

let _tableReady = false;
async function ensureTable(env) {
  if (_tableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ad_insights (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL DEFAULT 0,
    profile_id VARCHAR(191) NOT NULL,
    account_id VARCHAR(64) NOT NULL,
    ad_id VARCHAR(64) NOT NULL,
    ad_name VARCHAR(255) NULL,
    adset_name VARCHAR(255) NULL,
    campaign_name VARCHAR(255) NULL,
    date_start VARCHAR(32) NULL,
    date_stop VARCHAR(32) NULL,
    date_preset VARCHAR(32) NOT NULL DEFAULT 'last_7d',
    impressions BIGINT NOT NULL DEFAULT 0,
    clicks BIGINT NOT NULL DEFAULT 0,
    ctr DOUBLE NOT NULL DEFAULT 0,
    cpc DOUBLE NOT NULL DEFAULT 0,
    cpm DOUBLE NOT NULL DEFAULT 0,
    spend DOUBLE NOT NULL DEFAULT 0,
    results DOUBLE NOT NULL DEFAULT 0,
    actions_json LONGTEXT NULL,
    updated_at VARCHAR(32) NULL,
    UNIQUE KEY uq_insights_row (profile_id, ad_id, date_preset),
    KEY idx_insights_user (user_id),
    KEY idx_insights_account (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).run().catch(() => {});
  _tableReady = true;
}

// POST /api/insights/bulk-save — 本地后端（X-Api-Secret）或前端（Bearer）批量写入
export async function handleInsightsBulkSave(request, env, corsHeaders) {
  const authHeader = request.headers.get('Authorization');
  const apiSecret = request.headers.get('X-Api-Secret');
  let uId, uRole;
  if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
    uId = 1; uRole = 'superadmin';
  } else {
    if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    try {
      const parts = atob(authHeader.split(' ')[1]).split(':');
      uId = parts[0]; uRole = parts[2] || '';
    } catch {}
    if (!uId || uId === '0') return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }
  await ensureTable(env);

  const { items = [] } = await request.json().catch(() => ({ items: [] }));
  if (!Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ success: true, count: 0 }), { headers: corsHeaders });
  }

  // 归属映射：profile_id → profiles.user_id（superadmin 的 X-Api-Secret 也走这里落到真实用户）
  const pIds = [...new Set(items.map(it => String(it.profile_id || it.profileId || '')).filter(Boolean))];
  const pIdMap = new Map();
  if (pIds.length > 0) {
    const placeholders = pIds.map(() => '?').join(',');
    const { results: pOwners } = await env.DB.prepare(
      `SELECT id, ext_id, user_id FROM profiles WHERE id IN (${placeholders}) OR ext_id IN (${placeholders})`
    ).bind(...pIds, ...pIds).all().catch(() => ({ results: [] }));
    (pOwners || []).forEach(p => {
      if (p.id) pIdMap.set(String(p.id), p.user_id);
      if (p.ext_id) pIdMap.set(String(p.ext_id), p.user_id);
    });
  }

  const timestamp = new Date().toISOString();
  let count = 0;
  for (const it of items) {
    const pId = String(it.profile_id || it.profileId || '');
    const adId = String(it.ad_id || it.adId || '').replace(/^act_/i, '');
    const acct = String(it.account_id || it.accountId || '').replace(/^act_/i, '');
    if (!pId || !adId) continue; // 缺归属或缺广告 ID 的行没有唯一键，跳过
    const itemUserId = Number(pIdMap.get(pId) || uId) || 0;
    try {
      await env.DB.prepare(`
        INSERT INTO ad_insights (
          user_id, profile_id, account_id, ad_id, ad_name, adset_name, campaign_name,
          date_start, date_stop, date_preset, impressions, clicks, ctr, cpc, cpm, spend, results, actions_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          user_id = VALUES(user_id), account_id = VALUES(account_id),
          ad_name = VALUES(ad_name), adset_name = VALUES(adset_name), campaign_name = VALUES(campaign_name),
          date_start = VALUES(date_start), date_stop = VALUES(date_stop),
          impressions = VALUES(impressions), clicks = VALUES(clicks), ctr = VALUES(ctr),
          cpc = VALUES(cpc), cpm = VALUES(cpm), spend = VALUES(spend), results = VALUES(results),
          actions_json = VALUES(actions_json), updated_at = VALUES(updated_at)
      `).bind(
        itemUserId, pId, acct, adId,
        String(it.ad_name || it.adName || ''), String(it.adset_name || it.adsetName || ''), String(it.campaign_name || it.campaignName || ''),
        String(it.date_start || it.dateStart || ''), String(it.date_stop || it.dateStop || ''),
        String(it.date_preset || it.datePreset || 'last_7d'),
        Number(it.impressions || 0), Number(it.clicks || 0), Number(it.ctr || 0),
        Number(it.cpc || 0), Number(it.cpm || 0), Number(it.spend || 0), Number(it.results || 0),
        String(it.actions_json || ''), timestamp
      ).run();
      count++;
    } catch { /* 单行失败不影响整批 */ }
  }
  return new Response(JSON.stringify({ success: true, count }), { headers: corsHeaders });
}

// GET /api/insights?accounts=123,456&preset=last_7d — 当前用户的广告数据
export async function handleInsightsList(request, env, corsHeaders) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  let uId = '0', uRole = '';
  try {
    const parts = atob(authHeader.split(' ')[1]).split(':');
    uId = parts[0]; uRole = parts[2] || '';
  } catch {}
  if (!uId || uId === '0') return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureTable(env);

  const url = new URL(request.url);
  const preset = (url.searchParams.get('preset') || 'last_7d').trim();
  const accounts = (url.searchParams.get('accounts') || '').split(',').map(s => String(s).trim().replace(/^act_/i, '')).filter(Boolean);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 3000, 10000);

  const where = ['date_preset = ?'];
  const params = [preset];
  if (uRole !== 'superadmin') {
    where.push('(user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?))');
    params.push(Number(uId), Number(uId));
  }
  if (accounts.length) {
    where.push(`account_id IN (${accounts.map(() => '?').join(',')})`);
    params.push(...accounts);
  }
  // 关联 ad_accounts 拿名称/货币/配置名（同账户可能被多个配置同步过，必须同时按 profile_id 关联）
  const sql = `SELECT i.*, a.name AS account_name, a.currency, a.profile_name
               FROM ad_insights i
               LEFT JOIN ad_accounts a ON a.account_id = i.account_id AND a.profile_id = i.profile_id
               WHERE ${where.join(' AND ')}
               ORDER BY i.spend DESC LIMIT ${limit}`;
  const { results } = await env.DB.prepare(sql).bind(...params).all().catch(() => ({ results: [] }));
  const rows = (results || []).map(r => ({
    id: Number(r.id),
    profileId: String(r.profile_id || ''),
    accountId: String(r.account_id || ''),
    adId: String(r.ad_id || ''),
    adName: String(r.ad_name || ''),
    adsetName: String(r.adset_name || ''),
    campaignName: String(r.campaign_name || ''),
    dateStart: String(r.date_start || ''),
    dateStop: String(r.date_stop || ''),
    datePreset: String(r.date_preset || ''),
    impressions: Number(r.impressions || 0),
    clicks: Number(r.clicks || 0),
    ctr: Number(r.ctr || 0),
    cpc: Number(r.cpc || 0),
    cpm: Number(r.cpm || 0),
    spend: Number(r.spend || 0),
    results: Number(r.results || 0),
    accountName: String(r.account_name || ''),
    currency: String(r.currency || ''),
    profileName: String(r.profile_name || ''),
    updatedAt: String(r.updated_at || ''),
  }));
  return new Response(JSON.stringify({ success: true, data: rows, total: rows.length }), { headers: corsHeaders });
}
