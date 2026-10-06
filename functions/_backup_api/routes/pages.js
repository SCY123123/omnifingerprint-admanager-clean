/**
 * Pages route handlers
 * Extracted from [[path]].js for better maintainability
 */

// POST /api/pages/batch-delete — batch delete pages
export async function handlePagesBatchDelete(request, env, corsHeaders) {
      try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        let uid = '0', uRole = '';
        try { const td = atob(authHeader.split(' ')[1]); const parts = td.split(':'); uid = parts[0]; uRole = parts[2] || ''; } catch {}
        if (!uid || uid === '0') return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });

        const body = await request.json().catch(() => ({}));
        const ids = (body.page_ids || body.ids || []).filter(Boolean);
        if (!ids.length) return new Response(JSON.stringify({ success: false, message: 'No IDs' }), { status: 400, headers: corsHeaders });

        // 🚀 逐条删除，避免 D1 bind 动态参数问题
        let deletedCount = 0;
        for (const id of ids) {
          try {
            if (uRole === 'superadmin') {
              const r = await env.DB.prepare('DELETE FROM pages WHERE page_id = ?').bind(String(id)).run();
              deletedCount += r.meta?.changes || 0;
            } else {
              const r = await env.DB.prepare('DELETE FROM pages WHERE page_id = ? AND user_id = ?').bind(String(id), Number(uid)).run();
              deletedCount += r.meta?.changes || 0;
            }
          } catch (e1) {}
          try {
            if (uRole === 'superadmin') {
              const r = await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(String(id)).run();
              deletedCount += r.meta?.changes || 0;
            } else {
              const r = await env.DB.prepare('DELETE FROM pages WHERE id = ? AND user_id = ?').bind(String(id), Number(uid)).run();
              deletedCount += r.meta?.changes || 0;
            }
          } catch (e2) {}
        }
        return new Response(JSON.stringify({ success: true, count: ids.length, deletedPages: deletedCount }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message, stack: e.stack }), { status: 500, headers: corsHeaders });
      }
}

// POST /api/pages/bulk-save — bulk save pages
export async function handlePagesBulkSave(request, env, corsHeaders) {
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
        const pageId = item.page_id || item.id;
        const fullId = `page_${pageId}`;

        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO pages (id, user_id, profile_id, page_id, name, fan_count, link, category, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(fullId, Number(itemUserId), pId, String(pageId), item.name || '', Number(item.fan_count || 0), item.link || '', item.category || '', timestamp));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
}

// GET /api/pages — list pages
export async function handlePagesList(request, env, corsHeaders) {
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

      // 🚀 V5.6.9: 支持 profileIds 参数过滤
      const url = new URL(request.url);
      const profileIdsParam = url.searchParams.get('profileIds');

      let query = `SELECT p.*, u.email as owner_email FROM pages p LEFT JOIN users u ON p.user_id = u.id WHERE p.user_id = ? OR ? = 'superadmin'`;
      let params = [Number(uId), uRole];
      // 🚀 V5.7.0: superadmin 不应用 profileIds 过滤
      if (uRole !== 'superadmin' && profileIdsParam) {
        const ids = profileIdsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length > 0) {
          query += ` AND p.profile_id IN (${ids.map(() => '?').join(',')})`;
          params.push(...ids);
        }
      }
      query += ' ORDER BY p.updated_at DESC';
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
}
