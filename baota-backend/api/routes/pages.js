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

// POST /api/pages/assign-operator — 批量设置主页操作员（转移 profile 归属）
// body: { pageIds: string[] | items: [{page_id, profile_id}], profileId?: string }
// 提供 profileId 时对所有 pageIds 统一设置；items 模式可逐条指定
export async function handlePagesAssignOperator(request, env, corsHeaders) {
  try {
    const authHeader = request.headers.get('Authorization');
    const apiSecret = request.headers.get('X-Api-Secret');
    let uId, uRole;
    if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
      uId = 1; uRole = 'superadmin';
    } else {
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      try { const td = atob(authHeader.split(' ')[1]); const parts = td.split(':'); uId = parts[0]; uRole = parts[2] || ''; } catch {}
      if (!uId || uId === '0') return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const body = await request.json().catch(() => ({}));
    const timestamp = new Date().toISOString();
    // 统一模式：pageIds + profileId
    const pageIds = (body.pageIds || body.page_ids || []).map(v => String(v)).filter(Boolean);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!pageIds.length && !items.length) return new Response(JSON.stringify({ success: false, message: 'No pageIds/items' }), { status: 400, headers: corsHeaders });

    // 需要的 profile 集合 → 查 user_id
    const needProfiles = new Set();
    if (pageIds.length) needProfiles.add(String(body.profileId || ''));
    items.forEach(it => needProfiles.add(String(it.profile_id || it.profileId || '')));
    needProfiles.delete('');
    if (!needProfiles.size) return new Response(JSON.stringify({ success: false, message: 'No profileId' }), { status: 400, headers: corsHeaders });

    const profIds = [...needProfiles];
    const placeholders = profIds.map(() => '?').join(',');
    const { results: profRows } = await env.DB.prepare(
      `SELECT id, ext_id, user_id FROM profiles WHERE id IN (${placeholders}) OR ext_id IN (${placeholders})`
    ).bind(...profIds, ...profIds).all();
    const profUserMap = new Map();
    (profRows || []).forEach(p => {
      if (p.id) profUserMap.set(String(p.id), Number(p.user_id));
      if (p.ext_id) profUserMap.set(String(p.ext_id), Number(p.user_id));
    });

    // 组装 (pageId → {profileId, userId})
    const assignMap = new Map();
    for (const pid of pageIds) {
      const targetProfile = String(body.profileId || '');
      const userId = profUserMap.get(targetProfile);
      if (!userId) continue;
      assignMap.set(String(pid), { profileId: targetProfile, userId });
    }
    for (const it of items) {
      const pageId = String(it.page_id || it.pageId || it.id || '');
      const targetProfile = String(it.profile_id || it.profileId || '');
      const userId = profUserMap.get(targetProfile);
      if (!pageId || !userId) continue;
      assignMap.set(pageId, { profileId: targetProfile, userId });
    }
    if (!assignMap.size) return new Response(JSON.stringify({ success: false, message: '目标配置不存在或无效' }), { status: 400, headers: corsHeaders });

    let updated = 0;
    for (const [pageId, op] of assignMap) {
      try {
        const stmt = uRole === 'superadmin'
          ? env.DB.prepare('UPDATE pages SET profile_id = ?, user_id = ?, updated_at = ? WHERE page_id = ?').bind(op.profileId, op.userId, timestamp, pageId)
          : env.DB.prepare('UPDATE pages SET profile_id = ?, user_id = ?, updated_at = ? WHERE page_id = ? AND user_id = ?').bind(op.profileId, op.userId, timestamp, pageId, Number(uId));
        const r = await stmt.run();
        updated += r.meta?.changes || 0;
      } catch {}
      // 兼容 id 列（page_xxx）形态
      try {
        const stmt2 = uRole === 'superadmin'
          ? env.DB.prepare('UPDATE pages SET profile_id = ?, user_id = ?, updated_at = ? WHERE id = ?').bind(op.profileId, op.userId, timestamp, `page_${pageId}`)
          : env.DB.prepare('UPDATE pages SET profile_id = ?, user_id = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(op.profileId, op.userId, timestamp, `page_${pageId}`, Number(uId));
        updated += 0; // id 形态与 page_id 形态二选一命中，不重复计数
        await stmt2.run();
      } catch {}
    }
    return new Response(JSON.stringify({ success: true, updated, count: assignMap.size }), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, message: e?.message || String(e) }), { status: 500, headers: corsHeaders });
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

        // 🐛 修复：原先是 INSERT OR IGNORE（→ MySQL INSERT IGNORE），已存在的 page 整行被丢弃，
        //    名称/粉丝数/链接/分类再也不会更新。改为 upsert；文本字段「非空才覆盖」，避免上游空值抹掉已有值。
        statements.push(env.DB.prepare(`
          INSERT INTO pages (id, user_id, profile_id, page_id, name, fan_count, link, category, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            name = IF(VALUES(name) <> '', VALUES(name), name),
            fan_count = VALUES(fan_count),
            link = IF(VALUES(link) <> '', VALUES(link), link),
            category = IF(VALUES(category) <> '', VALUES(category), category),
            updated_at = VALUES(updated_at)
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
