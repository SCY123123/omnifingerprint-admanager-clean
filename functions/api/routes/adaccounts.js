/**
 * AdAccounts & Ads route handlers
 * Extracted from [[path]].js for better maintainability
 */

// POST /api/adaccounts/batch-delete — Batch delete ad accounts
export async function handleAdAccountsBatchDelete(request, env, corsHeaders) {
      try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        let uid = '0', uRole = '';
        try { const td = atob(authHeader.split(' ')[1]); const parts = td.split(':'); uid = parts[0]; uRole = parts[2] || ''; } catch {}
        if (!uid || uid === '0') return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        
        const body = await request.json().catch(() => ({}));
        const ids = (body.account_ids || body.ids || []).filter(Boolean);
        if (!ids.length) return new Response(JSON.stringify({ success: false, message: 'No IDs' }), { status: 400, headers: corsHeaders });

        // 🚀 遍历删除每条记录，避免 batch/bind 兼容性问题
        let deletedCount = 0;
        for (const id of ids) {
          try {
            if (uRole === 'superadmin') {
              const r = await env.DB.prepare('DELETE FROM ad_accounts WHERE (account_id = ? OR id = ?)').bind(String(id), String(id)).run();
              deletedCount += r.meta?.changes || 0;
            } else {
              const r = await env.DB.prepare('DELETE FROM ad_accounts WHERE (account_id = ? OR id = ?) AND user_id = ?').bind(String(id), String(id), Number(uid)).run();
              deletedCount += r.meta?.changes || 0;
            }
          } catch {}
          try { await env.DB.prepare('DELETE FROM ads WHERE account_id = ?').bind(String(id)).run(); } catch {}
        }
        return new Response(JSON.stringify({ success: true, count: ids.length, deletedAccounts: deletedCount }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: e.message, stack: e.stack }), { status: 500, headers: corsHeaders });
      }
}

// POST /api/adaccounts/bulk-save — Remote sync bulk save
export async function handleAdAccountsBulkSave(request, env, corsHeaders) {
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
      const timestamp = new Date().toISOString();
      const statements = [];

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
        const fullId = item.id || item.adAccountId || `act_${item.account_id || item.accountId}`;
        
        // 🚀 核心优化：字段归一化映射
        const normalized = {
          adAccountId: String(item.adAccountId || item.account_id || item.accountId || ''),
          name: String(item.name || item.adAccountName || ''),
          status: String(item.account_status || item.status || '0'),
          currency: String(item.currency || ''),
          timezone_id: String(item.timezone_id || item.timezoneId || ''),
          spend: Number(item.spend || item.amount_spent || 0),
          country: String(item.business_country_code || item.country || ''),
          threshold: Number(item.threshold || item.threshold_amount || item.spend_cap || 0),
          creditLimit: Number(item.creditLimit || item.credit_limit || item.adtrust_dsl || 0),
          balance: Number(item.balance || 0),
          fundingSource: String(item.fundingSource || item.funding_source || ''),
          pagesCount: Number(item.pagesCount || item.pages_count || 0),
          bmCount: Number(item.bmCount || item.bm_count || 0),
          pixelsCount: Number(item.pixelsCount || item.pixels_count || 0),
          account: String(item.account || item.account_name || ''),
          profileName: String(item.profile_name || item.profileName || ''),
          notes: String(item.notes || ''),
          group_col: String(item.group || item.group_col || ''),
          tags_col: Array.isArray(item.tags) ? item.tags.join(',') : String(item.tags || item.tags_col || '')
        };

        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO ad_accounts (
            id, user_id, profile_id, platform, account_id, name, status, currency, 
            timezone_id, spend, country, threshold_amount, credit_limit, balance, 
            funding_source, pages_count, bm_count, pixels_count, account, profile_name, notes,
            group_col, tags_col, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          fullId, Number(itemUserId), pId, item.platform || 'facebook', 
          normalized.adAccountId, normalized.name, normalized.status, 
          normalized.currency, normalized.timezone_id, normalized.spend, normalized.country,
          normalized.threshold, normalized.creditLimit, normalized.balance,
          normalized.fundingSource, normalized.pagesCount, normalized.bmCount, normalized.pixelsCount,
          normalized.account, normalized.profileName, normalized.notes,
          normalized.group_col, normalized.tags_col, timestamp
        ));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
}

// GET /api/adaccounts — list ad accounts
export async function handleAdAccountsList(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      const tokenData = atob(authHeader.split(' ')[1]);
      const [uId, , uRole] = tokenData.split(':');

      // 🚀 V5.6.9: 支持 profileIds 参数过滤
      const url = new URL(request.url);
      const profileIdsParam = url.searchParams.get('profileIds');

      // 🚀 分页：解析 page / pageSize 参数（默认不分页）
      const reqPage = parseInt(url.searchParams.get('page') || '0', 10);
      const reqPageSize = parseInt(url.searchParams.get('pageSize') || '0', 10);
      const usePagination = reqPage > 0 && reqPageSize > 0;

      const selectColumns = `a.*, u.email as owner_email,
        (SELECT COUNT(1) FROM ads WHERE ads.account_id = a.account_id) as ads_count,
        (SELECT COUNT(1) FROM billing_methods WHERE billing_methods.account_id = a.account_id) as payment_count,
        ROW_NUMBER() OVER (ORDER BY a.updated_at ASC) as seq`;

      let query = `SELECT ${selectColumns} FROM ad_accounts a LEFT JOIN users u ON a.user_id = u.id`;
      let countQuery = `SELECT COUNT(*) as total FROM ad_accounts a LEFT JOIN users u ON a.user_id = u.id`;
      let params = [];
      let countParams = [];
      let whereClauses = [];

      if (uRole !== 'superadmin') {
        whereClauses.push(`(a.user_id = ? OR a.user_id IN (SELECT id FROM users WHERE parent_id = ?)
          OR EXISTS (SELECT 1 FROM profiles p WHERE CAST(p.id AS TEXT) = a.profile_id AND (p.user_id = ? OR p.user_id IN (SELECT id FROM users WHERE parent_id = ?))))`);
        params.push(Number(uId), Number(uId), Number(uId), Number(uId));
        countParams.push(Number(uId), Number(uId), Number(uId), Number(uId));
      }
      if (profileIdsParam) {
        const ids = profileIdsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length > 0) {
          const placeholders = ids.map(() => '?').join(',');
          whereClauses.push(`a.profile_id IN (${placeholders})`);
          params.push(...ids);
          countParams.push(...ids);
        }
      }

      const whereStr = whereClauses.length > 0 ? ' WHERE ' + whereClauses.join(' AND ') : '';
      query += whereStr;
      countQuery += whereStr;

      let total = 0;
      if (usePagination) {
        const { results: countRes } = await env.DB.prepare(countQuery).bind(...countParams).all();
        total = Number(countRes[0]?.total || 0);
        const offset = (reqPage - 1) * reqPageSize;
        query += ` ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`;
        params.push(reqPageSize, offset);
      } else {
        query += ` ORDER BY a.updated_at DESC`;
      }

      const { results } = await env.DB.prepare(query).bind(...params).all();

      const responseBody = usePagination
        ? { success: true, data: results, pagination: { page: reqPage, pageSize: reqPageSize, total, totalPages: Math.ceil(total / reqPageSize) } }
        : { success: true, data: results };

      return new Response(JSON.stringify(responseBody, (k, v) => typeof v === 'bigint' ? Number(v) : v), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// PUT /api/adaccounts/:id — update single ad account
export async function handleAdAccountsUpdateById(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2] || '';
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }
      
      const path = new URL(request.url).pathname;
      const accountId = path.replace('/api/adaccounts/', '');
      if (!accountId) return new Response(JSON.stringify({ success: false, message: 'Missing account ID' }), { status: 400, headers: corsHeaders });
      try {
        const body = await request.json();
        const fields = [];
        const binds = [];
        if (body.notes !== undefined && body.notes !== null) { fields.push('notes = ?'); binds.push(String(body.notes)); } else if (body.notes === null) { fields.push('notes = ?'); binds.push(''); }
        if (body.group !== undefined && body.group !== null) { fields.push('group_col = ?'); binds.push(String(body.group)); }
        if (body.tags !== undefined) { fields.push('tags_col = ?'); binds.push(Array.isArray(body.tags) ? body.tags.join(',') : String(body.tags)); }
        if (fields.length === 0) {
          return new Response(JSON.stringify({ success: false, message: 'No fields to update' }), { status: 400, headers: corsHeaders });
        }
        fields.push('updated_at = ?');
        binds.push(new Date().toISOString());
        binds.push(accountId);
        if (uRole !== 'superadmin') binds.push(Number(uId));
        
        const userFilter = uRole === 'superadmin' ? '' : ' AND user_id = ?';
        await env.DB.prepare(`UPDATE ad_accounts SET ${fields.join(', ')} WHERE id = ?${userFilter}`).bind(...binds).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: String(e.message || e) }), { status: 500, headers: corsHeaders });
      }
}

// POST /api/ads/bulk-save — bulk save ads
export async function handleAdsBulkSave(request, env, corsHeaders) {
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
        const adId = item.ad_id || item.id;
        const fullId = `ad_${adId}`;

        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO ads (
            id, user_id, profile_id, ad_id, name, status, account_id, 
            campaign_id, campaign_name, adset_id, adset_name, 
            creative_id, preview_url, targeting, creative_json, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          fullId, Number(itemUserId), pId, String(adId), item.name || '', 
          item.status || 'UNKNOWN', item.account_id || '', 
          item.campaign_id || '', item.campaign_name || '', 
          item.adset_id || '', item.adset_name || '',
          item.creative_id || '', item.preview_url || '',
          item.targeting || '', item.creative_json || '',
          timestamp
        ));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: items.length }), { headers: corsHeaders });
}

// GET /api/ads — list ads
export async function handleAdsList(request, env, corsHeaders) {
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

      let query = `SELECT a.*, u.email as owner_email FROM ads a LEFT JOIN users u ON a.user_id = u.id WHERE a.user_id = ? OR ? = 'superadmin'`;
      let params = [Number(uId), uRole];
      // 🚀 V5.7.0: superadmin 不应用 profileIds 过滤
      if (uRole !== 'superadmin' && profileIdsParam) {
        const ids = profileIdsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length > 0) {
          query += ` AND a.profile_id IN (${ids.map(() => '?').join(',')})`;
          params.push(...ids);
        }
      }
      query += ' ORDER BY a.updated_at DESC';
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
}
