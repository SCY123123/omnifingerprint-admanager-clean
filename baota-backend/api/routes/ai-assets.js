/**
 * AI 自动回复素材库（图片/视频 + 用途描述）
 * 从「本机 IndexedDB 全局共享」改为「云端按 user_id 隔离 + 本地缓存」。
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

let _aiAssetsTableReady = false;
async function ensureAiAssetsTable(env) {
  if (_aiAssetsTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_assets (
    id VARCHAR(191) NOT NULL, user_id BIGINT NOT NULL DEFAULT 1,
    name VARCHAR(255) NULL, kind VARCHAR(16) NULL, mime_type VARCHAR(64) NULL,
    desc_text VARCHAR(1024) NULL, data_url LONGTEXT NULL, file_size BIGINT NULL,
    created_at VARCHAR(32) NULL, updated_at VARCHAR(32) NULL,
    PRIMARY KEY (id), KEY idx_ai_assets_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).run().catch(() => {});
  _aiAssetsTableReady = true;
}

// GET /api/ai-assets — 当前用户的素材列表
export async function handleAiAssetsList(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureAiAssetsTable(env);

  const { results } = await env.DB.prepare(
    `SELECT id, name, kind, mime_type, desc_text, data_url, file_size, created_at
     FROM ai_assets WHERE (user_id = ? OR ? = 'superadmin') ORDER BY created_at ASC`
  ).bind(Number(auth.uid), auth.role).all().catch(() => ({ results: [] }));

  const data = (results || []).map(r => ({
    id: String(r.id),
    name: r.name || '',
    kind: r.kind === 'video' ? 'video' : 'image',
    mimeType: r.mime_type || '',
    desc: r.desc_text || '',
    base64: r.data_url || '',
    size: Number(r.file_size || 0),
    createdAt: Date.parse(String(r.created_at || '')) || 0,
  }));
  return new Response(JSON.stringify({ success: true, data }), { headers: corsHeaders });
}

// POST /api/ai-assets/bulk-save — { items: [{ id, name, kind, mimeType, desc, base64, size, createdAt }] }
export async function handleAiAssetsBulkSave(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureAiAssetsTable(env);

  const { items = [] } = await request.json().catch(() => ({}));
  if (!Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ success: true, count: 0 }), { headers: corsHeaders });
  }

  const timestamp = new Date().toISOString();
  const statements = [];
  for (const it of items) {
    const id = String(it?.id || '').trim();
    if (!id || id.length > 191) continue;
    statements.push(env.DB.prepare(`
      INSERT INTO ai_assets (id, user_id, name, kind, mime_type, desc_text, data_url, file_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, kind = excluded.kind, mime_type = excluded.mime_type,
        desc_text = excluded.desc_text, data_url = excluded.data_url,
        file_size = excluded.file_size, updated_at = excluded.updated_at
    `).bind(
      id, Number(auth.uid),
      String(it.name || '').slice(0, 255),
      it.kind === 'video' ? 'video' : 'image',
      String(it.mimeType || '').slice(0, 64),
      String(it.desc || '').slice(0, 1024),
      typeof it.base64 === 'string' ? it.base64 : '',
      Number(it.size || 0),
      String(it.createdAt ? new Date(Number(it.createdAt)).toISOString() : timestamp),
      timestamp));
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return new Response(JSON.stringify({ success: true, count: statements.length }), { headers: corsHeaders });
}

// POST /api/ai-assets/delete — { ids: [] }
export async function handleAiAssetsDelete(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureAiAssetsTable(env);

  const { ids = [] } = await request.json().catch(() => ({}));
  if (!Array.isArray(ids) || ids.length === 0) {
    return new Response(JSON.stringify({ success: false, message: 'ids required' }), { status: 400, headers: corsHeaders });
  }
  let deleted = 0;
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (!id) continue;
    try {
      const r = auth.role === 'superadmin'
        ? await env.DB.prepare(`DELETE FROM ai_assets WHERE id = ?`).bind(id).run()
        : await env.DB.prepare(`DELETE FROM ai_assets WHERE id = ? AND user_id = ?`).bind(id, Number(auth.uid)).run();
      deleted += r?.meta?.changes || 0;
    } catch { }
  }
  return new Response(JSON.stringify({ success: true, deleted }), { headers: corsHeaders });
}
