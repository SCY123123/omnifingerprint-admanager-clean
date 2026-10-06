/**
 * Page Inbox Conversations route handlers
 * Extracted from [[path]].js for better maintainability
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
    return { uid: parts[0], role: parts[2] || 'user' };
  } catch { return null; }
}

// POST /api/messages/bulk-save — bulk save page inbox conversations
export async function handleMessagesBulkSave(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });

  const { items = [] } = await request.json().catch(() => ({}));
  if (!Array.isArray(items) || items.length === 0) return new Response(JSON.stringify({ success: true, count: 0 }), { headers: corsHeaders });

  const timestamp = new Date().toISOString();
  const pIds = [...new Set(items.map(it => String(it.profile_id || it.profileId)).filter(Boolean))];
  const pIdMap = new Map();
  if (pIds.length > 0) {
    const placeholders = pIds.map(() => '?').join(',');
    const { results: pOwners } = await env.DB.prepare(`SELECT id, ext_id, user_id FROM profiles WHERE id IN (${placeholders}) OR ext_id IN (${placeholders})`).bind(...pIds, ...pIds).all().catch(() => ({ results: [] }));
    (pOwners || []).forEach(p => {
      if (p.id) pIdMap.set(String(p.id), p.user_id);
      if (p.ext_id) pIdMap.set(String(p.ext_id), p.user_id);
    });
  }

  const statements = [];
  for (const item of items) {
    const pId = String(item.profile_id || item.profileId);
    if (!pId) continue;
    const itemUserId = pIdMap.get(pId) || auth.uid;
    const pageId = String(item.page_id || '');
    const convId = String(item.conversation_id || item.id || '');
    if (!convId) continue;
    const fullId = `conv_${pageId}_${convId}`;
    statements.push(env.DB.prepare(`
      INSERT OR REPLACE INTO page_conversations (id, user_id, profile_id, page_id, page_name, conversation_id, updated_time, message_count, unread_count, participants_json, messages_json, snippet, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(fullId, Number(itemUserId), pId, pageId, item.page_name || '', convId,
      item.updated_time || '', Number(item.message_count || 0), Number(item.unread_count || 0),
      item.participants_json || '', item.messages_json || '', item.snippet || '', timestamp));
  }

  if (statements.length > 0) await env.DB.batch(statements).catch(e => { throw e; });
  return new Response(JSON.stringify({ success: true, count: statements.length }), { headers: corsHeaders });
}

// POST /api/messages/batch-delete — 批量删除已保存的主页收件箱对话存档（仅删云端记录，不影响 Facebook 真实对话）
export async function handleMessagesBatchDelete(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  const { ids = [] } = await request.json().catch(() => ({}));
  if (!Array.isArray(ids) || ids.length === 0) return new Response(JSON.stringify({ success: false, message: 'No IDs' }), { status: 400, headers: corsHeaders });
  const { uid, role } = auth;
  let deleted = 0;
  for (const rawId of ids) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    try {
      const r = role === 'superadmin'
        ? await env.DB.prepare(`DELETE FROM page_conversations WHERE id = ?`).bind(id).run()
        : await env.DB.prepare(`DELETE FROM page_conversations WHERE id = ? AND user_id = ?`).bind(id, Number(uid)).run();
      deleted += r.meta?.changes || 0;
    } catch {}
  }
  return new Response(JSON.stringify({ success: true, count: ids.length, deletedMessages: deleted }), { headers: corsHeaders });
}

// GET /api/messages — list page inbox conversations
export async function handleMessagesList(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });

  const url = new URL(request.url);
  const profileId = url.searchParams.get('profileId') || url.searchParams.get('profile_id') || '';
  const pageId = url.searchParams.get('pageId') || url.searchParams.get('page_id') || '';

  let query = `SELECT c.*, u.email as owner_email FROM page_conversations c LEFT JOIN users u ON c.user_id = u.id WHERE (c.user_id = ? OR ? = 'superadmin')`;
  const params = [Number(auth.uid), auth.role];
  if (profileId) { query += ` AND c.profile_id = ?`; params.push(profileId); }
  if (pageId) { query += ` AND c.page_id = ?`; params.push(pageId); }
  query += ' ORDER BY COALESCE(c.updated_time, c.updated_at) DESC';
  const { results } = await env.DB.prepare(query).bind(...params).all();
  return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
}
