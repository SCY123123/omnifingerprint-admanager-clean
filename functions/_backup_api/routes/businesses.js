/**
 * Businesses route handlers
 * Extracted from [[path]].js for better maintainability
 */

// POST /api/businesses/bulk-save — bulk save businesses
export async function handleBusinessesBulkSave(request, env, corsHeaders) {
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

      const pIds = [...new Set(items.map(it => String(it.profile_id || it.profileId)))];
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
        const pId = String(item.profile_id || item.profileId);
        const itemUserId = pIdMap.get(pId) || uId;
        const bId = item.businessId || item.id;
        if (!bId) continue;

        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO businesses (id, user_id, profile_id, name, verification_status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(String(bId), Number(itemUserId), pId, item.name || `BM ${bId}`, item.verification_status || 'unknown', timestamp));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
}

// GET /api/businesses — list businesses
export async function handleBusinessesList(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const tokenData = atob(authHeader.split(' ')[1]);
      const [uId, , uRole] = tokenData.split(':');

      // 🚀 V5.6.9: 支持 profileIds 参数过滤
      const url = new URL(request.url);
      const profileIdsParam = url.searchParams.get('profileIds');

      let query = `SELECT b.*, u.email as owner_email FROM businesses b LEFT JOIN users u ON b.user_id = u.id`;
      let params = [];
      let whereClauses = [];
      if (uRole !== 'superadmin') {
        whereClauses.push('(b.user_id = ? OR b.user_id IN (SELECT id FROM users WHERE parent_id = ?))');
        params.push(Number(uId), Number(uId));
      }
      // 🚀 V5.7.0: superadmin 不应用 profileIds 过滤
      if (uRole !== 'superadmin' && profileIdsParam) {
        const ids = profileIdsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length > 0) {
          whereClauses.push(`b.profile_id IN (${ids.map(() => '?').join(',')})`);
          params.push(...ids);
        }
      }
      if (whereClauses.length > 0) {
        query += ' WHERE ' + whereClauses.join(' AND ');
      }

      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results.map(r => ({ ...r, bmId: r.id })) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
