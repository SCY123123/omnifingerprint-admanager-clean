/**
 * 用户级键值设置（AI 提示词 / 已发送缓存等）
 * 与其它业务表一致：一律按 user_id 隔离，superadmin 可读他人。
 */

// 统一的 API 鉴权：X-Api-Secret 或 Bearer(id:email:role)
function resolveAuth(request, env) {
  const apiSecret = request.headers.get('X-Api-Secret');
  if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) return { uid: '1', role: 'superadmin' };
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  try {
    const tokenData = atob(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);
    const parts = tokenData.split(':');
    return { uid: parts[0] || '0', role: parts[2] || 'user' };
  } catch { return null; }
}

let _settingsTableReady = false;
async function ensureSettingsTable(env) {
  if (_settingsTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_settings (
    user_id BIGINT NOT NULL, setting_key VARCHAR(191) NOT NULL,
    setting_value LONGTEXT NULL, updated_at VARCHAR(32) NULL,
    PRIMARY KEY (user_id, setting_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).run().catch(() => {});
  _settingsTableReady = true;
}

// GET /api/settings — 返回当前用户的全部设置 { key: value }
export async function handleSettingsList(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureSettingsTable(env);

  const url = new URL(request.url);
  const only = (url.searchParams.get('keys') || '').split(',').map(s => s.trim()).filter(Boolean);
  let query = `SELECT setting_key, setting_value FROM user_settings WHERE (user_id = ? OR ? = 'superadmin')`;
  const params = [Number(auth.uid), auth.role];
  if (only.length) {
    query += ` AND setting_key IN (${only.map(() => '?').join(',')})`;
    params.push(...only);
  }
  const { results } = await env.DB.prepare(query).bind(...params).all().catch(() => ({ results: [] }));
  const data = {};
  (results || []).forEach(r => { data[String(r.setting_key)] = r.setting_value ?? ''; });
  return new Response(JSON.stringify({ success: true, data }), { headers: corsHeaders });
}

// POST /api/settings/bulk-save — { items: [{ key, value }] }，按当前用户 upsert
export async function handleSettingsBulkSave(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureSettingsTable(env);

  const { items = [] } = await request.json().catch(() => ({}));
  if (!Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ success: true, count: 0 }), { headers: corsHeaders });
  }

  const timestamp = new Date().toISOString();
  const statements = [];
  for (const it of items) {
    const key = String(it?.key || '').trim();
    if (!key || key.length > 191) continue;
    const value = it?.value === null || it?.value === undefined
      ? ''
      : (typeof it.value === 'string' ? it.value : JSON.stringify(it.value));
    statements.push(env.DB.prepare(`
      INSERT INTO user_settings (user_id, setting_key, setting_value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).bind(Number(auth.uid), key, value, timestamp));
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return new Response(JSON.stringify({ success: true, count: statements.length }), { headers: corsHeaders });
}
