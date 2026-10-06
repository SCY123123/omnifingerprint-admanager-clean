/**
 * Profiles route handlers
 * Extracted from [[path]].js for better maintainability
 */

// Helper: 从 account 字段提取遗留的 name
const getLegacyAccountName = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      return parsed.name;
    }
  } catch {}
  return '';
};

// GET /api/profiles — list profiles with pagination
export async function handleProfilesList(request, env, corsHeaders) {
      try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });

        let uId, uRole;
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0];
          uRole = parts[2];
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
        }

        // Fetch requester's full details for RBAC
        const { results: reqUserRes } = await env.DB.prepare(`SELECT id, role, parent_id, permission_level FROM users WHERE id = ?`).bind(Number(uId)).all();
        const reqUser = reqUserRes[0];
        if (!reqUser) return new Response(JSON.stringify({ success: false, message: 'User not found' }), { status: 401, headers: corsHeaders });

        // 🚀 分页：解析 page / pageSize 参数（默认 page=1, pageSize=0 表示不分页，返回全部）
        const urlObj = new URL(request.url);
        const reqPage = parseInt(urlObj.searchParams.get('page') || '0', 10);
        const reqPageSize = parseInt(urlObj.searchParams.get('pageSize') || '0', 10);
        const usePagination = reqPage > 0 && reqPageSize > 0;

        let query = `SELECT profiles.*, u.email as owner_email, u.username as owner_name,
          (SELECT COUNT(*) FROM pages WHERE pages.profile_id = CAST(profiles.id AS TEXT)) as db_pages_count,
          (SELECT COUNT(*) FROM businesses WHERE businesses.profile_id = CAST(profiles.id AS TEXT)) as db_bm_count,
          (SELECT COUNT(*) FROM pixels WHERE pixels.profile_id = CAST(profiles.id AS TEXT)) as db_pixels_count
          FROM profiles LEFT JOIN users u ON profiles.user_id = u.id`;
        let countQuery = `SELECT COUNT(*) as total FROM profiles LEFT JOIN users u ON profiles.user_id = u.id`;
        let params = [];
        let countParams = [];

        const normalizedRole = (reqUser.role || '').toLowerCase().trim();
        const permLevel = reqUser.permission_level || 'full';
        const teamRootId = reqUser.parent_id || reqUser.id;

        let whereClause = '';
        if (normalizedRole !== 'superadmin') {
          if (permLevel === 'full') {
            whereClause = ' WHERE (profiles.user_id = ? OR profiles.user_id IN (SELECT id FROM users WHERE parent_id = ?))';
            params = [Number(teamRootId), Number(teamRootId)];
            countParams = [Number(teamRootId), Number(teamRootId)];
          } else {
            whereClause = ' WHERE profiles.user_id = ?';
            params = [Number(uId)];
            countParams = [Number(uId)];
          }
        }

        // 🚀 支持 platform 过滤参数
        const platformFilter = urlObj.searchParams.get('platform');
        if (platformFilter) {
          const platformWhere = whereClause ? ' AND' : ' WHERE';
          whereClause += `${platformWhere} profiles.platform = ?`;
          params.push(platformFilter);
          countParams.push(platformFilter);
        }

        // 🚀 支持 search 搜索参数（匹配 id / name / email 等）
        const searchTerm = urlObj.searchParams.get('search');
        if (searchTerm) {
          const searchWhere = whereClause ? ' AND' : ' WHERE';
          const likeStr = `%${searchTerm}%`;
          whereClause += `${searchWhere} (CAST(profiles.id AS TEXT) LIKE ? OR profiles.name LIKE ? OR profiles.account_email LIKE ? OR profiles.account_name LIKE ? OR profiles.account_notes LIKE ? OR u.email LIKE ? OR u.username LIKE ?)`;
          params.push(likeStr, likeStr, likeStr, likeStr, likeStr, likeStr, likeStr);
          countParams.push(likeStr, likeStr, likeStr, likeStr, likeStr, likeStr, likeStr);
        }

        query += whereClause;

        // 🚀 支持 sortKey/sortDir 排序参数（全局排序后再分页）
        const sortFieldMap = {
          'id': 'profiles.id',
          'name': 'profiles.name',
          'updatedAt': 'profiles.updated_at',
          'ownerName': 'u.username',
          'ownerEmail': 'u.email',
          'account.name': 'profiles.account_name',
          'status': 'profiles.account_status',
        };
        const sortKey = urlObj.searchParams.get('sortKey');
        const sortDir = urlObj.searchParams.get('sortDir');
        const orderBy = (sortKey && sortFieldMap[sortKey])
          ? sortFieldMap[sortKey] + ' ' + (sortDir === 'asc' ? 'ASC' : 'DESC')
          : 'updated_at DESC';
        query += ` ORDER BY ${orderBy}`;

        countQuery += whereClause;

        let total = 0;
        if (usePagination) {
          const { results: countRes } = await env.DB.prepare(countQuery).bind(...countParams).all();
          total = Number(countRes[0]?.total || 0);
          const offset = (reqPage - 1) * reqPageSize;
          query += ` LIMIT ? OFFSET ?`;
          params.push(reqPageSize, offset);
        }

        const { results } = await env.DB.prepare(query).bind(...params).all();

        // 🚀 同时查询 businesses 表，合并 BM ID 到每个配置的 assets 中
        let bmMap = new Map();
        try {
          const bmQuery = uRole === 'superadmin'
            ? `SELECT profile_id, business_id FROM businesses`
            : `SELECT profile_id, business_id FROM businesses WHERE user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?)`;
          const bmParams = uRole === 'superadmin' ? [] : [Number(uId), Number(uId)];
          const { results: bmResults } = await env.DB.prepare(bmQuery).bind(...bmParams).all();
          for (const b of bmResults) {
            const pid = String(b.profile_id || '');
            if (!pid) continue;
            if (!bmMap.has(pid)) bmMap.set(pid, []);
            const bid = String(b.business_id || '');
            const existingBms = bmMap.get(pid);
            if (bid && existingBms && !existingBms.includes(bid)) existingBms.push(bid);
          }
        } catch (bmErr) {
          // 查询 businesses 失败不影响 profiles 返回
          bmMap = new Map();
        }

        const data = results.map(row => {
          const rowId = String(row.id);
          const bmIds = bmMap.get(rowId) || [];
          let proxy = null;
          if (row.proxy) {
            try { proxy = JSON.parse(row.proxy); } catch { proxy = null; }
          }
          if (!proxy && row.proxy_host) {
            proxy = {
              type: row.proxy_type || 'http',
              host: row.proxy_host,
              port: row.proxy_port || '8080',
              username: row.proxy_username,
              password: row.proxy_password
            };
          }
          // 🚀 修复：fingerprint_protection 的 JSON.parse 包裹 try/catch，避免畸形数据导致整个列表 500
          let fingerprintProtection = {};
          try { if (row.fingerprint_protection) fingerprintProtection = JSON.parse(row.fingerprint_protection); } catch {}
          return {
            id: String(row.id),
            owner_email: row.owner_email || '',
            owner_name: row.owner_name || '',
            extId: row.ext_id || '',
            name: row.name || String(row.id),
            platform: row.platform || 'Meta (Facebook/Instagram)',
            status: 'Idle',
            accountStatus: row.account_status || 'Unknown',
            userAgent: row.user_agent || '',
            ipAddress: (row.proxy_host || (proxy && proxy.host) || 'N/A'),
            cookiesCount: (() => {
              if (!row.account_cookies || row.account_cookies.length < 2) return 0;
              try {
                const c = JSON.parse(row.account_cookies);
                if (Array.isArray(c)) return c.length;
                if (typeof c === 'object' && c !== null) return 1;
                return 0;
              } catch {
                const cnt = String(row.account_cookies).split(';').filter(s => s.trim().includes('=')).length;
                return cnt > 0 ? cnt : 1;
              }
            })(),
            lastActive: 'Never',
            account: { name: row.account_name || getLegacyAccountName(row.account), email: row.account_email, password: row.account_password, twoFactorSecret: row.account_twofactor_secret || '', cookies: row.account_cookies || '' },
            notes: row.account_notes || '',
            token: row.account_tokens || '',
            group: row.group_col || '',
            tags: row.tags_col ? row.tags_col.split(',').filter(Boolean) : [],
            seq: row.seq,
            os: row.os || '',
            resolution: row.resolution || '',
            timezone: row.timezone || '',
            language: row.language || '',
            fingerprintProtection,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            startupUrls: row.start_url ? [row.start_url] : [],
            proxy: proxy,
            proxyEnabled: !!row.proxy_enabled,
            // 🚀 核心修复：直接查询 pages/businesses/pixels 表获取真实行数（而非 stale 的 profiles.pages_count 列）
            assets: {
              pagesCount: Number(row.db_pages_count || 0),
              bmCount: Number(row.db_bm_count || 0),
              // 🚀 从 businesses 表合并 BM ID 列表
              bmIds: bmIds,
              bmId: bmIds.length > 0 ? bmIds[0] : (row.bm_id || ''),
              pixelsCount: Number(row.db_pixels_count || 0),
              adAccountsCount: Number(row._ad_accounts_count || 0),
              paymentStatus: 'None',
              paymentInfo: '',
              country: '',
              currency: '',
              timezone: ''
            }
          };
        });

        const responseBody = usePagination
          ? { success: true, data, pagination: { page: reqPage, pageSize: reqPageSize, total, totalPages: Math.ceil(total / reqPageSize) } }
          : { success: true, data };

        return new Response(JSON.stringify(responseBody, (k, v) => typeof v === 'bigint' ? Number(v) : v), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        // 🚀 顶层 try/catch：捕获任何未处理异常，返回可读错误信息
        return new Response(JSON.stringify({ success: false, message: 'Server error: ' + (e?.message || String(e)) }), { status: 500, headers: corsHeaders });
      }
}

// GET /api/profiles/stats — profile stats
export async function handleProfilesStats(request, env, corsHeaders) {
      try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        let uId, uRole;
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0];
          uRole = parts[2];
        } catch {
          return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
        }
        const { results: reqUserRes } = await env.DB.prepare(`SELECT id, role, parent_id FROM users WHERE id = ?`).bind(Number(uId)).all();
        const reqUser = reqUserRes[0];
        if (!reqUser) return new Response(JSON.stringify({ success: false, message: 'User not found' }), { status: 401, headers: corsHeaders });

        let where = '';
        let params = [];
        const role = (reqUser.role || '').toLowerCase().trim();
        if (role !== 'superadmin') {
          where = ' WHERE user_id = ? OR user_id IN (SELECT id FROM users WHERE parent_id = ?)';
          params = [Number(reqUser.parent_id || reqUser.id), Number(reqUser.parent_id || reqUser.id)];
        }

        // 总配置数 & 按 platform 分组统计
        const { results: totalRes } = await env.DB.prepare(`SELECT COUNT(*) as total FROM profiles${where}`).bind(...params).all();
        const { results: platformRes } = await env.DB.prepare(`SELECT platform, COUNT(*) as count FROM profiles${where} GROUP BY platform`).bind(...params).all();
        const { results: statusRes } = await env.DB.prepare(`SELECT account_status, COUNT(*) as count FROM profiles${where} GROUP BY account_status`).bind(...params).all();

        const total = Number(totalRes[0]?.total || 0);
        const platformBreakdown = {};
        (platformRes || []).forEach((r) => { platformBreakdown[r.platform || 'Unknown'] = Number(r.count || 0); });
        const statusBreakdown = {};
        (statusRes || []).forEach((r) => { statusBreakdown[r.account_status || 'Unknown'] = Number(r.count || 0); });

        return new Response(JSON.stringify({ success: true, data: { total, platformBreakdown, statusBreakdown } }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Server error: ' + String(e?.message || e) }), { status: 500, headers: corsHeaders });
      }
}

// POST /api/profiles/bulk-save — bulk save (upsert)
export async function handleProfilesBulkSave(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0]; uRole = parts[2];
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
        }
      }

      const body = await request.json();
      const items = Array.isArray(body) ? body : (body.profiles || body.items || [body]);
      const timestamp = new Date().toISOString();
      const results = { saved: 0, updated: 0, skipped: 0 };
      const savedIds = []; // { tempId: string, d1Id: number }[] 新增配置的 ID 映射
      for (const item of items) {
        const inputId = item.id;
        const inputExtId = item.extId || item.ext_id;
        
        let existingRow = null;
        if (inputId && !String(inputId).startsWith('fp_') && !String(inputId).startsWith('import-')) {
          const isNum = !isNaN(Number(inputId));
          if (isNum) {
            const { results: search } = await env.DB.prepare(`SELECT * FROM profiles WHERE id = ?`).bind(Number(inputId)).all();
            existingRow = search[0];
          }
          if (!existingRow) {
            const { results: search } = await env.DB.prepare(`SELECT * FROM profiles WHERE ext_id = ?`).bind(String(inputId)).all();
            existingRow = search[0];
          }
        }
        if (!existingRow && inputExtId) {
          const { results: search } = await env.DB.prepare(`SELECT * FROM profiles WHERE ext_id = ?`).bind(String(inputExtId)).all();
          existingRow = search[0];
        }

        if (existingRow && uRole !== 'superadmin' && existingRow.user_id != uId) {
          results.skipped++;
          continue;
        }

        const account = item.account || {};
        const proxy = item.proxy || {};
        const fingerprint = item.fingerprintProtection || {};

        if (existingRow) {
          // 🚀 智能部分更新：只更新传入的非空字段，防止覆盖已有数据
          const updateFields = [];
          const params = [];

          const mapping = {
            name: item.name,
            platform: item.platform,
            user_agent: item.userAgent,
            start_url: (item.startupUrls && item.startupUrls[0]) || item.start_url,
            account_name: account.name || item.accountName || item.account_name,
            account_email: account.email || item.accountEmail || item.account_email,
            account_password: account.password || item.accountPassword || item.account_password,
            account_cookies: account.cookies || item.cookies || item.account_cookies,
            account_tokens: item.token || item.accountTokens || item.account_tokens,
            account_notes: item.notes || item.accountNotes || item.account_notes,
            account_twofactor_secret: account.twoFactorSecret || item.twoFactorSecret || item.account_twofactor_secret,
            proxy_enabled: item.proxyEnabled !== undefined ? (item.proxyEnabled ? 1 : 0) : undefined,
            // 🚀 修正：当代理禁用时，清空代理字段
            proxy: item.proxyEnabled === false ? '{}' : undefined,
            proxy_type: item.proxyEnabled === false ? '' : (proxy.type || item.proxy_type),
            proxy_host: item.proxyEnabled === false ? '' : (proxy.host || item.proxy_host),
            proxy_port: item.proxyEnabled === false ? '' : (proxy.port || item.proxy_port),
            proxy_username: item.proxyEnabled === false ? '' : (proxy.username || item.proxy_username),
            proxy_password: item.proxyEnabled === false ? '' : (proxy.password || item.proxy_password),
            pages_count: item.pages_count ?? item.pagesCount,
            bm_count: item.bm_count ?? item.bmCount,
            pixels_count: item.pixels_count ?? item.pixelsCount,
            os: item.os,
            resolution: item.resolution,
            timezone: item.timezone,
            language: item.language,
            fb_language: item.fbLanguage,
            fingerprint_protection: item.fingerprintProtection ? JSON.parse(JSON.stringify(item.fingerprintProtection)) : undefined,
            group_col: item.group || item.group_col,
            tags_col: Array.isArray(item.tags) ? item.tags.join(',') : (item.tags_col || '')
          };

          for (const [col, val] of Object.entries(mapping)) {
            if (val !== undefined && val !== null) {
              updateFields.push(`${col} = ?`);
              params.push(typeof val === 'object' ? JSON.stringify(val) : val);
            }
          }

          if (updateFields.length > 0) {
            updateFields.push(`updated_at = ?`);
            params.push(timestamp);
            params.push(existingRow.id);
            try {
              await env.DB.prepare(`UPDATE profiles SET ${updateFields.join(', ')} WHERE id = ?`).bind(...params).run();
              results.updated++;
            } catch (e) {
              const msg = String(e.message || e);
              if (msg.includes('no such column') && (msg.includes('group_col') || msg.includes('tags_col'))) {
                // 降级：去除 group_col/tags_col 后重试
                const safeFields = updateFields.filter(f => !f.startsWith('group_col') && !f.startsWith('tags_col'));
                const safeParams = [];
                for (let idx = 0; idx < updateFields.length; idx++) {
                  if (!updateFields[idx].startsWith('group_col') && !updateFields[idx].startsWith('tags_col')) safeParams.push(params[idx]);
                }
                if (safeFields.length > 1) {
                  safeParams.push(existingRow.id);
                  await env.DB.prepare(`UPDATE profiles SET ${safeFields.join(', ')} WHERE id = ?`).bind(...safeParams).run();
                  results.updated++;
                }
              } else {
                throw e;
              }
            }
          }
        } else {
          // INSERT
          // 🚀 ext_id 使用 NULL 而非空字符串，避免 UNIQUE 约束冲突（SQLite 允许多个 NULL）
          const extIdVal = inputExtId ? String(inputExtId) : null;
          // 🚀 有数字 id 时保留，让导入/新建的配置 ID 固定。id=null 时 SQLite 自增
          const stableId = inputId && /^\d+$/.test(String(inputId)) ? Number(inputId) : null;
          const sql = `INSERT INTO profiles (
            id, user_id, ext_id, name, platform, user_agent, start_url,
            account_name, account_email, account_password, account_cookies, account_tokens, account_notes, account_twofactor_secret,
            proxy_enabled, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password, proxy,
            pages_count, bm_count, pixels_count,
            os, resolution, timezone, language, fb_language, fingerprint_protection,
            group_col, tags_col, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          const params = [
            stableId, Number(uId), extIdVal, item.name || 'New Profile', item.platform || 'Meta (Facebook/Instagram)', item.userAgent || '', (item.startupUrls && item.startupUrls[0]) || '',
            account.name || item.accountName || item.account_name || '', account.email || item.accountEmail || item.account_email || '', account.password || item.accountPassword || item.account_password || '', account.cookies || item.cookies || item.account_cookies || '', item.token || item.accountTokens || item.account_tokens || '', item.notes || item.accountNotes || item.account_notes || '', account.twoFactorSecret || item.twoFactorSecret || item.account_twofactor_secret || '',
            item.proxyEnabled ? 1 : 0, proxy.type || 'http', proxy.host || '', proxy.port || '', proxy.username || '', proxy.password || '',
            JSON.stringify(proxy || {}),
            item.pages_count ?? item.pagesCount ?? 0, item.bm_count ?? item.bmCount ?? 0, item.pixels_count ?? item.pixelsCount ?? 0,
            item.os || '', item.resolution || '', item.timezone || '', item.language || '', item.fbLanguage || 'en_US', JSON.stringify(fingerprint),
            item.group || '', Array.isArray(item.tags) ? item.tags.join(',') : (item.tags_col || ''),
            timestamp, timestamp
          ];
          try {
            const insResult = await env.DB.prepare(sql).bind(...params).run();
            results.saved++;
            // 🚀 记录 D1 自动分配的 ID，供前端替换临时 ID
            if (!stableId && inputId && inputId.startsWith('fp_')) {
              const d1Id = insResult.meta?.last_row_id;
              if (d1Id) savedIds.push({ tempId: String(inputId), d1Id: Number(d1Id) });
            }
          } catch (e) {
            const msg = String(e.message || e);
            if (msg.includes('no such column') && (msg.includes('group_col') || msg.includes('tags_col'))) {
              // 降级：去掉 group_col/tags_col 后重试 INSERT
              const fallbackSql = `INSERT INTO profiles (
                id, user_id, ext_id, name, platform, user_agent, start_url, 
                account_name, account_email, account_password, account_cookies, account_tokens, account_notes, account_twofactor_secret,
                proxy_enabled, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password, proxy,
                pages_count, bm_count, pixels_count,
                os, resolution, timezone, language, fb_language, fingerprint_protection,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
              const fallbackParams = [
                stableId, Number(uId), extIdVal, item.name || 'New Profile', item.platform || 'Meta (Facebook/Instagram)', item.userAgent || '', (item.startupUrls && item.startupUrls[0]) || '',
                account.name || item.accountName || item.account_name || '', account.email || item.accountEmail || item.account_email || '', account.password || item.accountPassword || item.account_password || '', account.cookies || item.cookies || item.account_cookies || '', item.token || item.accountTokens || item.account_tokens || '', item.notes || item.accountNotes || item.account_notes || '', account.twoFactorSecret || item.twoFactorSecret || item.account_twofactor_secret || '',
                item.proxyEnabled ? 1 : 0, proxy.type || 'http', proxy.host || '', proxy.port || '', proxy.username || '', proxy.password || '',
                JSON.stringify(proxy || {}),
                item.pages_count ?? item.pagesCount ?? 0, item.bm_count ?? item.bmCount ?? 0, item.pixels_count ?? item.pixelsCount ?? 0,
                item.os || '', item.resolution || '', item.timezone || '', item.language || '', item.fbLanguage || 'en_US', JSON.stringify(fingerprint),
                timestamp, timestamp
              ];
              const fallbackResult = await env.DB.prepare(fallbackSql).bind(...fallbackParams).run();
              results.saved++;
              if (!stableId && inputId && inputId.startsWith('fp_')) {
                const d1Id = fallbackResult.meta?.last_row_id;
                if (d1Id) savedIds.push({ tempId: String(inputId), d1Id: Number(d1Id) });
              }
            } else {
              throw e;
            }
          }
        }
      }

      return new Response(JSON.stringify({ success: true, ...results, savedIds: savedIds.length ? savedIds : undefined }), { headers: corsHeaders });
}

// POST /api/profiles/share — share/transfer profiles
export async function handleProfilesShare(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = Number(parts[0]);
        uRole = parts[2];
      } catch { return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders }); }

      const { profileIds, targetEmail, mode } = await request.json();
      if (!Array.isArray(profileIds) || profileIds.length === 0 || !targetEmail) {
        return new Response(JSON.stringify({ success: false, message: '缺少参数' }), { status: 400, headers: corsHeaders });
      }

      // 查找目标用户
      const targetResult = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(targetEmail).all();
      const targetUser = targetResult.results?.[0];
      if (!targetUser) {
        return new Response(JSON.stringify({ success: false, message: '目标用户不存在' }), { status: 404, headers: corsHeaders });
      }
      const targetId = targetUser.id;

      const placeholders = profileIds.map(() => '?').join(',');
      // 校验：只允许分享/转移自己的配置（superadmin 可以操作任何配置）
      let ownershipFilter;
      if (uRole === 'superadmin') {
        ownershipFilter = '';
      } else {
        ownershipFilter = `AND user_id = ${Number(uId)}`;
      }

      if (mode === 'transfer') {
        // 转移：直接修改 user_id
        await env.DB.prepare(`UPDATE profiles SET user_id = ?, updated_at = ? WHERE id IN (${placeholders}) ${ownershipFilter}`).bind(targetId, new Date().toISOString(), ...profileIds).run();
        return new Response(JSON.stringify({ success: true, message: `已转移 ${profileIds.length} 个配置给 ${targetEmail}` }), { headers: corsHeaders });
      } else {
        // 复制：查询原配置，插入新配置
        const { results: sourceProfiles } = await env.DB.prepare(`SELECT * FROM profiles WHERE id IN (${placeholders}) ${ownershipFilter}`).bind(...profileIds).all();
        if (!sourceProfiles || sourceProfiles.length === 0) {
          return new Response(JSON.stringify({ success: false, message: '未找到可分享的配置' }), { status: 404, headers: corsHeaders });
        }
        const timestamp = new Date().toISOString();
        let copied = 0;
        for (const src of sourceProfiles) {
          await env.DB.prepare(`INSERT INTO profiles (user_id, name, platform, user_agent, start_url, account_name, account_email, account_password, account_cookies, account_tokens, account_notes, account_twofactor_secret, proxy_enabled, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password, proxy, pages_count, bm_count, pixels_count, os, resolution, timezone, language, fb_language, fingerprint_protection, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
            targetId, src.name, src.platform, src.user_agent, src.start_url, src.account_name, src.account_email, src.account_password, src.account_cookies, src.account_tokens, src.account_notes, src.account_twofactor_secret || '', src.proxy_enabled, src.proxy_type, src.proxy_host, src.proxy_port, src.proxy_username, src.proxy_password, src.proxy, src.pages_count, src.bm_count, src.pixels_count, src.os, src.resolution, src.timezone, src.language, src.fb_language, src.fingerprint_protection, timestamp, timestamp
          ).run();
          copied++;
        }
        return new Response(JSON.stringify({ success: true, message: `已复制 ${copied} 个配置给 ${targetEmail}` }), { headers: corsHeaders });
      }
}

// POST /api/profiles/batch-update-fb-language
export async function handleProfilesBatchUpdateFbLanguage(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }
      const { ids, fbLanguage } = await request.json();
      if (!Array.isArray(ids) || ids.length === 0 || !fbLanguage) {
        return new Response(JSON.stringify({ success: false, message: '缺少 ids 或 fbLanguage 参数' }), { status: 400, headers: corsHeaders });
      }
      const timestamp = new Date().toISOString();
      const placeholders = ids.map(() => '?').join(',');
      let userFilter = '';
      const params = [fbLanguage, timestamp];
      if (uRole !== 'superadmin') {
        userFilter = ` AND user_id = ?`;
        params.push(Number(uId));
      }
      const result = await env.DB.prepare(`UPDATE profiles SET fb_language = ?, updated_at = ? WHERE id IN (${placeholders})${userFilter}`).bind(...params, ...ids).run();
      return new Response(JSON.stringify({ success: true, count: result.meta?.changes || 0 }), { headers: corsHeaders });
}

// POST /api/profiles/update-account-status
export async function handleProfilesUpdateAccountStatus(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }
      const { items } = await request.json();
      if (!Array.isArray(items) || items.length === 0) {
        return new Response(JSON.stringify({ success: false, message: '缺少 items' }), { status: 400, headers: corsHeaders });
      }
      const timestamp = new Date().toISOString();
      let updated = 0;
      for (const item of items) {
        if (!item.id || !item.accountStatus) continue;
        try {
          let userFilter = '';
          const params = [item.accountStatus, timestamp, String(item.id)];
          if (uRole !== 'superadmin') {
            userFilter = ' AND user_id = ?';
            params.push(Number(uId));
          }
          const r = await env.DB.prepare(`UPDATE profiles SET account_status = ?, updated_at = ? WHERE id = ?${userFilter}`).bind(...params).run();
          updated += r.meta?.changes || 0;
        } catch {}
      }
      return new Response(JSON.stringify({ success: true, count: updated }), { headers: corsHeaders });
}

// POST /api/profiles/batch-delete
export async function handleProfilesBatchDelete(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      
      let uId, uRole;
      try {
        const tokenData = atob(authHeader.split(' ')[1]);
        const parts = tokenData.split(':');
        uId = parts[0];
        uRole = parts[2];
      } catch (e) {
        return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
      }

      const { ids = [] } = await request.json();
      if (ids.length > 0) {
        let totalDeletedProfiles = 0;
        let totalDeletedAccounts = 0;
        let totalDeletedPages = 0;

        // 🚀 分块删除，避免 SQLite 变量数超限（最大 999 个 ?）
        const CHUNK = 20;
        for (let ci = 0; ci < ids.length; ci += CHUNK) {
          const chunk = ids.slice(ci, ci + CHUNK);
          const stringIds = chunk.map((id) => String(id));
          const numericIds = chunk.map((id) => Number(id)).filter((id) => !isNaN(id));

          let pFilter = `(id IN (${numericIds.map(() => '?').join(',')}) OR ext_id IN (${stringIds.map(() => '?').join(',')}))`;
          let pParams = [...numericIds, ...stringIds];

          if (uRole !== 'superadmin') {
            pFilter += ' AND user_id = ?';
            pParams.push(Number(uId));
          }

          let lFilter = `profile_id IN (${stringIds.map(() => '?').join(',')})`;
          let lParams = [...stringIds];
          if (uRole !== 'superadmin') {
            lFilter += ' AND user_id = ?';
            lParams.push(Number(uId));
          }

          // 🚀 逐表独立删除，避免 batch 因为某个表不存在而整体失败
          const pR = await env.DB.prepare(`DELETE FROM profiles WHERE ${pFilter}`).bind(...pParams).run();
          totalDeletedProfiles += pR.meta?.changes || 0;
          try { const aR = await env.DB.prepare(`DELETE FROM ad_accounts WHERE ${lFilter}`).bind(...lParams).run(); totalDeletedAccounts += aR.meta?.changes || 0; } catch {}
          try { const gR = await env.DB.prepare(`DELETE FROM pages WHERE ${lFilter}`).bind(...lParams).run(); totalDeletedPages += gR.meta?.changes || 0; } catch {}
          try { await env.DB.prepare(`DELETE FROM ads WHERE ${lFilter}`).bind(...lParams).run(); } catch {}
          // 🚀 级联删除该配置的贴文/消息对话存档，避免删除账号配置后残留脏数据
          try { await env.DB.prepare(`DELETE FROM page_posts WHERE ${lFilter}`).bind(...lParams).run(); } catch {}
          try { await env.DB.prepare(`DELETE FROM page_conversations WHERE ${lFilter}`).bind(...lParams).run(); } catch {}
        }

        return new Response(JSON.stringify({ success: true, count: ids.length, deletedCount: totalDeletedProfiles }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify({ success: true, count: 0 }), { headers: corsHeaders });
}

// GET /api/profiles/:id — single profile
export async function handleProfilesGetById(request, env, corsHeaders) {
      let __step = 'init';
      try {
        const authHeader = request.headers.get('Authorization');
        const apiSecret = request.headers.get('X-Api-Secret');
        let uId, uRole;

        // 支持 X-Api-Secret 认证（PUP 服务器使用）
        if (apiSecret) {
          if (apiSecret === env.PUPPETEER_API_SECRET) {
            uId = 1; uRole = 'superadmin';
          } else {
            return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
          }
        } else {
          if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
          try {
            const tokenData = atob(authHeader.split(' ')[1]);
            const parts = tokenData.split(':');
            uId = parts[0];
            uRole = parts[2] || '';
          } catch (e) {
            return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
          }
        }

        const path = new URL(request.url).pathname;
        const id = path.split('/').filter(Boolean).pop();
        if (id === 'profiles') return new Response(JSON.stringify({ success: false, message: 'Invalid ID' }), { status: 400, headers: corsHeaders });

        __step = 'db_query';
        const { results } = uRole === 'superadmin'
          ? await env.DB.prepare(`SELECT * FROM profiles WHERE id = ? OR ext_id = ?`).bind(Number(id) || 0, id).all()
          : await env.DB.prepare(`SELECT * FROM profiles WHERE (id = ? OR ext_id = ?) AND user_id = ?`).bind(Number(id) || 0, id, Number(uId)).all();
        const row = results[0];
        if (!row) return new Response(JSON.stringify({ success: false, message: 'Not Found' }), { status: 404, headers: corsHeaders });

        // 🚀 查询该配置关联的 BM ID
        __step = 'fetch_bms';
        let bmIds = [];
        try {
          const { results: bmResults } = await env.DB.prepare(`SELECT business_id FROM businesses WHERE profile_id = ?`).bind(Number(id) || 0).all();
          bmIds = bmResults.map(b => String(b.business_id || '')).filter(Boolean);
        } catch {}

        __step = 'parse_proxy';
        let proxy = null;
        try { if (row.proxy) proxy = JSON.parse(row.proxy); } catch {}
        if (!proxy && row.proxy_host) {
          proxy = { type: row.proxy_type, host: row.proxy_host, port: Number(row.proxy_port) || 0, username: row.proxy_username, password: row.proxy_password };
        }

        // 🚀 修复：fingerprint_protection 的 JSON.parse 包裹 try/catch，避免畸形数据导致 500
        __step = 'parse_fp';
        let fingerprintProtection = {};
        try { if (row.fingerprint_protection) fingerprintProtection = JSON.parse(row.fingerprint_protection); } catch {}

        __step = 'build_data';
        // 🚀 BigInt 安全处理：D1 可能对 INTEGER 列返回 BigInt，JSON.stringify 无法序列化 BigInt
        const data = {
          id: String(row.id), extId: row.ext_id, name: row.name, platform: row.platform,
          userAgent: row.user_agent, startupUrls: row.start_url ? [row.start_url] : [],
          account: { name: row.account_name, email: row.account_email, password: row.account_password, twoFactorSecret: row.account_twofactor_secret || '', cookies: row.account_cookies },
          proxy, proxyEnabled: !!row.proxy_enabled, token: row.account_tokens, notes: row.account_notes,
          os: row.os, resolution: row.resolution, timezone: row.timezone, language: row.language,
          fingerprintProtection,
          // 🚀 包含 BM ID 信息
          assets: {
            bmIds: bmIds,
            bmId: bmIds.length > 0 ? bmIds[0] : '',
            bmCount: Number(row.bm_count || 0),
            pagesCount: Number(row.pages_count || 0),
            pixelsCount: Number(row.pixels_count || 0),
            adAccountsCount: Number(row._ad_accounts_count || 0)
          }
        };
        __step = 'serialize';
        const body = JSON.stringify(data, (k, v) => typeof v === 'bigint' ? Number(v) : v);
        return new Response(JSON.stringify({ success: true, data: JSON.parse(body) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        // 🚀 顶层 try/catch：捕获任何未处理异常，返回 500 而不是让 Cloudflare 返回不可读的错误
        // 包含 __step 字段帮助定位具体失败步骤
        return new Response(JSON.stringify({ success: false, message: 'Server error: ' + (e?.message || String(e)), step: __step, stack: e?.stack?.split('\n').slice(0, 3).join(' | ') }), { status: 500, headers: corsHeaders });
      }
}

// PUT /api/profiles/:id — update single profile
export async function handleProfilesUpdateById(request, env, corsHeaders) {
      const path = new URL(request.url).pathname;
      const profileId = path.replace('/api/profiles/', '').split('/')[0];
      if (!profileId) return new Response(JSON.stringify({ success: false, message: 'Missing id' }), { status: 400, headers: corsHeaders });

      const authHeader = request.headers.get('Authorization');
      const apiSecret = request.headers.get('X-Api-Secret');
      let uId, uRole;
      if (apiSecret && apiSecret === env.PUPPETEER_API_SECRET) {
        uId = 1; uRole = 'superadmin';
      } else {
        if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        try {
          const tokenData = atob(authHeader.split(' ')[1]);
          const parts = tokenData.split(':');
          uId = parts[0];
          uRole = parts[2] || '';
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
        }
      }

      const p = await request.json();
      
      // 🚀 部分更新：只更新请求体中存在的字段
      const fields = [];
      const binds = [];
      const cols = {
        name: 'name', account_name: 'account_name', account_email: 'account_email',
        account_password: 'account_password', start_url: 'start_url', user_agent: 'user_agent',
        account_notes: 'account_notes', group_col: 'group_col', tags_col: 'tags_col',
        proxy_enabled: 'proxy_enabled', proxy_type: 'proxy_type', proxy_host: 'proxy_host',
        proxy_port: 'proxy_port', proxy_username: 'proxy_username', proxy_password: 'proxy_password',
        proxy: 'proxy', account: 'account',
        os: 'os', resolution: 'resolution', timezone: 'timezone',
        language: 'language', fbLanguage: 'fb_language'
      };
      for (const [key, col] of Object.entries(cols)) {
        if (p[key] !== undefined) {
          // tags_col 特殊处理
          if (key === 'tags_col') {
            const val = Array.isArray(p[key]) ? p[key].join(',') : String(p[key]);
            fields.push(`${col} = ?`); binds.push(val);
          } else {
            fields.push(`${col} = ?`); binds.push(typeof p[key] === 'object' ? JSON.stringify(p[key]) : String(p[key]));
          }
        }
      }
      // 兼容 p.notes → account_notes
      if (p.notes !== undefined && p.account_notes === undefined) {
        fields.push('account_notes = ?'); binds.push(String(p.notes));
      }
      // 兼容 p.group → group_col
      if (p.group !== undefined && p.group_col === undefined) {
        fields.push('group_col = ?'); binds.push(String(p.group));
      }
      // 兼容 p.tags → tags_col
      if (p.tags !== undefined && p.tags_col === undefined) {
        fields.push('tags_col = ?'); binds.push(Array.isArray(p.tags) ? p.tags.join(',') : String(p.tags));
      }
      // 兼容 proxyEnabled → proxy_enabled
      if (p.proxyEnabled !== undefined && p.proxy_enabled === undefined) {
        fields.push('proxy_enabled = ?'); binds.push(p.proxyEnabled ? '1' : '0');
      }
      // 兼容 p.proxy 为对象 → 存 JSON
      if (p.proxy !== undefined && typeof p.proxy === 'object' && p.proxy !== null && !Array.isArray(p.proxy)) {
        // 如果 proxy 对象没有在 cols 中处理，手动添加
        const alreadyHandled = fields.some(f => f.startsWith('proxy ='));
        if (!alreadyHandled) {
          fields.push('proxy = ?'); binds.push(JSON.stringify(p.proxy));
          // 同时补充 proxy_type/host/port/username/password
          if (p.proxy_type === undefined && p.proxy.type) { fields.push('proxy_type = ?'); binds.push(String(p.proxy.type)); }
          if (p.proxy_host === undefined && p.proxy.host) { fields.push('proxy_host = ?'); binds.push(String(p.proxy.host)); }
          if (p.proxy_port === undefined && p.proxy.port) { fields.push('proxy_port = ?'); binds.push(String(p.proxy.port)); }
          if (p.proxy_username === undefined && p.proxy.username) { fields.push('proxy_username = ?'); binds.push(String(p.proxy.username)); }
          if (p.proxy_password === undefined && p.proxy.password) { fields.push('proxy_password = ?'); binds.push(String(p.proxy.password)); }
        }
      }
      // 兼容 p.account.twoFactorSecret → account_twofactor_secret
      if (p.account && typeof p.account === 'object' && p.account.twoFactorSecret !== undefined) {
        const alreadyHandled = fields.some(f => f.startsWith('account_twofactor_secret'));
        if (!alreadyHandled) {
          fields.push('account_twofactor_secret = ?'); binds.push(String(p.account.twoFactorSecret));
        }
      }
      // 🚀 兼容 p.fingerprintProtection 为对象 → 存 JSON
      if (p.fingerprintProtection !== undefined && typeof p.fingerprintProtection === 'object') {
        const alreadyHandled = fields.some(f => f.startsWith('fingerprint_protection'));
        if (!alreadyHandled) {
          fields.push('fingerprint_protection = ?'); binds.push(JSON.stringify(p.fingerprintProtection));
        }
      }
      
      if (fields.length === 0) {
        return new Response(JSON.stringify({ success: false, message: 'No fields to update' }), { status: 400, headers: corsHeaders });
      }
      
      fields.push('updated_at = ?');
      binds.push(new Date().toISOString());

      const isSuperAdmin = uRole === 'superadmin';
      const pidNum = !isNaN(Number(profileId)) ? Number(profileId) : null;
      let stmt;
      const userFilterClause = isSuperAdmin ? '' : ' AND user_id = ?';
      try {
        if (pidNum) {
          binds.push(pidNum);
          if (!isSuperAdmin) binds.push(Number(uId));
          stmt = await env.DB.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE id = ?${userFilterClause}`).bind(...binds).run();
        } else {
          binds.push(String(profileId));
          if (!isSuperAdmin) binds.push(Number(uId));
          stmt = await env.DB.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE ext_id = ?${userFilterClause}`).bind(...binds).run();
        }
      } catch (e) {
        // 🚀 如果 D1 报 unknown column，尝试去掉不适配的列降级重试
        const msg = String(e.message || e);
        const unknownCols = ['group_col', 'tags_col', 'account_twofactor_secret'];
        if (msg.includes('no such column') && unknownCols.some(c => msg.includes(c))) {
          const safeFields = fields.filter(f => !unknownCols.some(c => f.startsWith(c)));
          const safeBinds = [];
          let fi = 0;
          for (const f of fields) {
            if (!unknownCols.some(c => f.startsWith(c))) safeBinds.push(binds[fi]);
            fi++;
          }
          if (safeFields.length <= 1) {
            return new Response(JSON.stringify({ success: false, message: 'Database schema mismatch: ' + msg }), { status: 500, headers: corsHeaders });
          }
          if (pidNum) {
            safeBinds.push(pidNum);
            if (!isSuperAdmin) safeBinds.push(Number(uId));
            stmt = await env.DB.prepare(`UPDATE profiles SET ${safeFields.join(', ')} WHERE id = ?${userFilterClause}`).bind(...safeBinds).run();
          } else {
            safeBinds.push(String(profileId));
            if (!isSuperAdmin) safeBinds.push(Number(uId));
            stmt = await env.DB.prepare(`UPDATE profiles SET ${safeFields.join(', ')} WHERE ext_id = ?${userFilterClause}`).bind(...safeBinds).run();
          }
        } else {
          throw e;
        }
      }

      return new Response(JSON.stringify({ success: true, message: '配置已更新', changes: stmt.meta?.changes || 0 }), { headers: corsHeaders });
}
