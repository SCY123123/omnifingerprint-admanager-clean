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
          tags_col: Array.isArray(item.tags) ? item.tags.join(',') : String(item.tags || item.tags_col || ''),
          // 广告号归属的 BM：前端把 Graph 原始行整条传上来，business 就是 me/adaccounts 的 business{id,name}
          businessId: String(item.business_id || item.businessId || (item.business && item.business.id) || ''),
          businessName: String(item.business_name || item.businessName || (item.business && item.business.name) || '')
        };

        // 🐛 修复（货币/国家/时区不更新）：原先是 `INSERT OR IGNORE`（→ MySQL INSERT IGNORE），
        //    主键 (id, profile_id) 已存在时**整行被丢弃**，于是 currency / country / timezone_id
        //    永远停在第一次入库的值（连 updated_at 都不动），前端列表自然一直显示旧数据。
        //    这里改为 MySQL 原生 upsert；文本字段用「非空才覆盖」，避免上游返回空值把已有值抹掉；
        //    notes / group_col / tags_col 属于用户在系统里维护的数据，不在更新列里（保持不动）。
        statements.push(env.DB.prepare(`
          INSERT INTO ad_accounts (
            id, user_id, profile_id, platform, account_id, name, status, currency, 
            timezone_id, spend, country, threshold_amount, credit_limit, balance, 
            funding_source, pages_count, bm_count, pixels_count, account, profile_name, notes,
            group_col, tags_col, updated_at, business_id, business_name
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            status = VALUES(status),
            currency = IF(VALUES(currency) <> '', VALUES(currency), currency),
            timezone_id = IF(VALUES(timezone_id) <> '', VALUES(timezone_id), timezone_id),
            spend = VALUES(spend),
            country = IF(VALUES(country) <> '', VALUES(country), country),
            threshold_amount = VALUES(threshold_amount),
            credit_limit = VALUES(credit_limit),
            balance = VALUES(balance),
            funding_source = IF(VALUES(funding_source) <> '', VALUES(funding_source), funding_source),
            pages_count = VALUES(pages_count),
            bm_count = VALUES(bm_count),
            pixels_count = VALUES(pixels_count),
            account = IF(VALUES(account) <> '', VALUES(account), account),
            profile_name = IF(VALUES(profile_name) <> '', VALUES(profile_name), profile_name),
            business_id = IF(VALUES(business_id) <> '', VALUES(business_id), business_id),
            business_name = IF(VALUES(business_name) <> '', VALUES(business_name), business_name),
            updated_at = VALUES(updated_at)
        `).bind(
          fullId, Number(itemUserId), pId, item.platform || 'facebook', 
          normalized.adAccountId, normalized.name, normalized.status, 
          normalized.currency, normalized.timezone_id, normalized.spend, normalized.country,
          normalized.threshold, normalized.creditLimit, normalized.balance,
          normalized.fundingSource, normalized.pagesCount, normalized.bmCount, normalized.pixelsCount,
          normalized.account, normalized.profileName, normalized.notes,
          normalized.group_col, normalized.tags_col, timestamp,
          normalized.businessId, normalized.businessName
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

      // 🚀 V5.7.0: seq 从「ROW_NUMBER() 虚拟行号」改为**持久列**。
      //    以前是 `ROW_NUMBER() OVER (ORDER BY a.updated_at ASC)`：每次查询重算，
      //    执行「获取信息」时 bulk-save 更新 updated_at → 整列序号全变（用户反馈"序号会变化"）。
      //    现在由客户端首次分配后调用 /api/adaccounts/fill-seq 回写落库，此后任何设备/浏览器
      //    读到的都是同一个固定序号。
      //    ALTER 在 D1→MySQL 兼容层里是幂等的（列已存在自动跳过）。
      try { await env.DB.prepare('ALTER TABLE ad_accounts ADD COLUMN seq INT NULL').run(); } catch {}
      try { await env.DB.prepare('ALTER TABLE ad_accounts ADD COLUMN business_id VARCHAR(191) NULL').run(); } catch {}
      try { await env.DB.prepare('ALTER TABLE ad_accounts ADD COLUMN business_name VARCHAR(255) NULL').run(); } catch {}

      const selectColumns = `a.*, u.email as owner_email,
        (SELECT p.account_tokens FROM profiles p WHERE CAST(p.id AS TEXT) = a.profile_id LIMIT 1) as profile_token,
        (SELECT COUNT(1) FROM ads WHERE ads.account_id = a.account_id) as ads_count,
        (SELECT COUNT(1) FROM billing_methods WHERE billing_methods.account_id = a.account_id) as payment_count`;

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
      // 🚀 水位增量：?since=<ISO> 只回该时间之后变更的行（配合前端"静默 revalidate"，无变更时几乎 0 字节）。
      //    总数查询不带 since，前端用 total 比对本地条数，发现自己漏了新增/删除就做一次全量对齐。
      const whereStrAll = whereStr;
      const sinceParam = (url.searchParams.get('since') || '').trim();
      if (sinceParam) {
        whereClauses.push('a.updated_at > ?');
        params.push(sinceParam);
      }
      query += whereClauses.length > 0 ? ' WHERE ' + whereClauses.join(' AND ') : '';
      countQuery += whereStrAll;

      const serverTime = new Date().toISOString();
      // 🚀 总是统计总数：全量返回时前端用它校验"本地缓存是否完整"
      //    （缓存行数 ≠ total 说明缓存缺行 → 不渲染，避免先闪 192 条再变 215 条）
      const { results: countRes } = await env.DB.prepare(countQuery).bind(...countParams).all();
      const total = Number(countRes[0]?.total || 0);
      if (usePagination) {
        const offset = (reqPage - 1) * reqPageSize;
        query += ` ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`;
        params.push(reqPageSize, offset);
      } else {
        query += ` ORDER BY a.updated_at DESC`;
      }

      const { results } = await env.DB.prepare(query).bind(...params).all();

      const responseBody = usePagination
        ? { success: true, data: results, pagination: { page: reqPage, pageSize: reqPageSize, total, totalPages: Math.ceil(total / reqPageSize) } }
        : (sinceParam
            ? { success: true, data: results, unchanged: results.length === 0, total, serverTime }
            : { success: true, data: results, total, serverTime });

      return new Response(JSON.stringify(responseBody, (k, v) => typeof v === 'bigint' ? Number(v) : v), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// POST /api/adaccounts/fill-seq — 回写客户端分配好的固定序号（只补 seq 为空的记录）
// 客户端只在「服务端还没有序号」时调用，因此不会覆盖已落库的序号 → 序号一旦分配就永久固定，
// 换电脑 / 换浏览器读到的都是同一个值。
export async function handleAdAccountsFillSeq(request, env, corsHeaders) {
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

      try { await env.DB.prepare('ALTER TABLE ad_accounts ADD COLUMN seq INT NULL').run(); } catch {}

      const body = await request.json().catch(() => ({}));
      const items = Array.isArray(body.items) ? body.items : [];
      let updated = 0;
      for (const it of items) {
        const key = String(it.accountId || it.adAccountId || it.id || '').trim();
        const seq = Number(it.seq);
        if (!key || !Number.isFinite(seq) || seq <= 0) continue;
        try {
          const sql = uRole === 'superadmin'
            ? 'UPDATE ad_accounts SET seq = ? WHERE seq IS NULL AND (account_id = ? OR id = ?)'
            : 'UPDATE ad_accounts SET seq = ? WHERE seq IS NULL AND (account_id = ? OR id = ?) AND user_id = ?';
          const stmt = uRole === 'superadmin'
            ? env.DB.prepare(sql).bind(Math.floor(seq), key, key)
            : env.DB.prepare(sql).bind(Math.floor(seq), key, key, Number(uId));
          const r = await stmt.run();
          updated += r.meta?.changes || 0;
        } catch {}
      }
      return new Response(JSON.stringify({ success: true, updated }), { headers: corsHeaders });
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

        // 🐛 修复：原先是 INSERT OR IGNORE，已存在的广告整行被丢弃 → 名称/状态/素材/定向再也不更新。
        //    改为 upsert；文本字段「非空才覆盖」，避免上游空值把已有的名称/定向/素材抹掉。
        statements.push(env.DB.prepare(`
          INSERT INTO ads (
            id, user_id, profile_id, ad_id, name, status, account_id, 
            campaign_id, campaign_name, adset_id, adset_name, 
            creative_id, preview_url, targeting, creative_json, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            name = IF(VALUES(name) <> '', VALUES(name), name),
            status = IF(VALUES(status) <> '', VALUES(status), status),
            campaign_id = IF(VALUES(campaign_id) <> '', VALUES(campaign_id), campaign_id),
            campaign_name = IF(VALUES(campaign_name) <> '', VALUES(campaign_name), campaign_name),
            adset_id = IF(VALUES(adset_id) <> '', VALUES(adset_id), adset_id),
            adset_name = IF(VALUES(adset_name) <> '', VALUES(adset_name), adset_name),
            creative_id = IF(VALUES(creative_id) <> '', VALUES(creative_id), creative_id),
            preview_url = IF(VALUES(preview_url) <> '', VALUES(preview_url), preview_url),
            targeting = IF(VALUES(targeting) <> '', VALUES(targeting), targeting),
            creative_json = IF(VALUES(creative_json) <> '', VALUES(creative_json), creative_json),
            updated_at = VALUES(updated_at)
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
