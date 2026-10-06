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
        // ⚠️ 非本系统的 token（如商城 HMAC token）会让 atob 抛 "Invalid character"，
        //    必须包住并返回 401，否则跨系统调用会变成 500（用户隔离要求干净拒绝）
        let uIdParse, uRoleParse;
        try {
          const parts = atob(authHeader.split(' ')[1] || '').split(':');
          uIdParse = parts[0]; uRoleParse = parts[2];
        } catch {
          return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }
        uId = uIdParse; uRole = uRoleParse;
      }

      const { items = [] } = await request.json();
      // 🩺 「账号质量」四列必须先存在（bulk-save 现在会写它们，缺列会整条 INSERT 报错）
      await ensureAqColumns(env);
      const statements = [];
      const timestamp = new Date().toISOString();

      const pIds = [...new Set(items.map(it => String(it.profile_id || it.profileId || '')).filter(Boolean))];
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
        const pId = String(item.profile_id || item.profileId || '');
        // 🛡️ 缺 profileId 必须跳过（否则会把字面量 "undefined" 写进 profile_id 列）
        if (!pId || pId === 'undefined' || pId === 'null') continue;
        const itemUserId = pIdMap.get(pId) || uId;
        const bId = item.businessId || item.id;
        if (!bId) continue;

        // 🐛 修复：原先是 INSERT OR IGNORE，已存在的 BM 整行被丢弃 → 名称/认证状态永远停在首插值。
        //    改为 upsert；名称非空才覆盖；认证状态只在「新值更明确」时覆盖（不让 unknown 把 verified 冲掉）。
        // 🩺 账号质量（aq_*）：只有本次带值时才覆盖，其它写入方（只带认证状态）不会把已探测结果抹掉。
        const aqStatus = item.aq_status != null ? String(item.aq_status).trim() : '';
        const aqEvidence = item.aq_evidence != null ? String(item.aq_evidence) : '';
        const aqPolicy = item.aq_policy != null ? String(item.aq_policy) : '';
        const aqUpdatedAt = item.aq_updated_at != null ? String(item.aq_updated_at) : '';
        const hasAq = aqStatus !== '';
        // 🩺 BM 成员（邮箱+角色 JSON）：只有「本次带了这个字段」才覆盖（空数组也算带了 → 允许清空）
        const hasUsers = item.bm_users !== undefined && item.bm_users !== null;
        const bmUsers = hasUsers ? String(item.bm_users) : null;
        // 🩺 BM 创建时间：带值才覆盖
        const fbCreated = item.fb_created_time != null ? String(item.fb_created_time).trim() : '';
        // 🩺 可创建广告号上限（内部 GraphQL ad_account_creation_limit）：带值才覆盖
        const aaLimitRaw = item.ad_account_limit;
        const hasAaLimit = aaLimitRaw != null && String(aaLimitRaw).trim() !== '';
        const aaLimit = hasAaLimit ? Number(aaLimitRaw) : null;
        statements.push(env.DB.prepare(`
          INSERT INTO businesses (id, user_id, profile_id, name, verification_status, aq_status, aq_evidence, aq_policy, aq_updated_at, bm_users, fb_created_time, ad_account_limit, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            name = IF(VALUES(name) <> '', VALUES(name), name),
            verification_status = IF(VALUES(verification_status) IS NULL OR VALUES(verification_status) = '' OR VALUES(verification_status) = 'unknown', verification_status, VALUES(verification_status)),
            aq_status = IF(VALUES(aq_status) IS NULL OR VALUES(aq_status) = '', aq_status, VALUES(aq_status)),
            aq_evidence = IF(VALUES(aq_status) IS NULL OR VALUES(aq_status) = '', aq_evidence, VALUES(aq_evidence)),
            aq_policy = IF(VALUES(aq_status) IS NULL OR VALUES(aq_status) = '', aq_policy, VALUES(aq_policy)),
            aq_updated_at = IF(VALUES(aq_status) IS NULL OR VALUES(aq_status) = '', aq_updated_at, VALUES(aq_updated_at)),
            bm_users = IF(VALUES(bm_users) IS NULL, bm_users, VALUES(bm_users)),
            fb_created_time = IF(VALUES(fb_created_time) IS NULL OR VALUES(fb_created_time) = '', fb_created_time, VALUES(fb_created_time)),
            ad_account_limit = IF(VALUES(ad_account_limit) IS NULL, ad_account_limit, VALUES(ad_account_limit)),
            updated_at = VALUES(updated_at)
        `).bind(String(bId), Number(itemUserId), pId, item.name || `BM ${bId}`, item.verification_status || 'unknown',
                hasAq ? aqStatus : null, hasAq ? aqEvidence : null, hasAq ? aqPolicy : null, hasAq ? (aqUpdatedAt || timestamp) : null,
                bmUsers,
                fbCreated || null,
                aaLimit,
                timestamp));
      }

      if (statements.length > 0) await env.DB.batch(statements);
      return new Response(JSON.stringify({ success: true, count: statements.length }), { headers: corsHeaders });
}

// 邀请链接相关列的懒迁移（每进程一次）
// ⚠️ invite_link 必须能装下完整邀请链接：FB 的 /invitation/?token=... 约 350~400 字符，
//    早期建成 varchar(191) 会截断/报错（MySQL 严格模式直接 Data too long）。
let _inviteColsReady = false;
async function ensureInviteColumns(env) {
  if (_inviteColsReady) return;
  const statements = [
    `ALTER TABLE businesses ADD COLUMN invite_email VARCHAR(320) NULL`,
    `ALTER TABLE businesses ADD COLUMN invite_link TEXT NULL`,
    `ALTER TABLE businesses ADD COLUMN invited_at VARCHAR(32) NULL`,
    `ALTER TABLE businesses MODIFY COLUMN invite_link TEXT NULL`,
  ];
  for (const s of statements) {
    try { await env.DB.prepare(s).run(); } catch { /* 已存在 / 已改过 */ }
  }
  _inviteColsReady = true;
}

// 🩺 「账号质量」四列 + 「BM 成员」列的懒迁移（每进程一次）。
//    aq_status/aq_evidence/aq_policy/aq_updated_at 由本地 9999 服务探测（内部 GraphQL
//    AccountQualityHubAssetOwnerViewV2Query）后写回；
//    bm_users 是 BM 成员 JSON（邮箱+角色，来自 Graph business_users/pending_users）。
let _aqColsReady = false;
async function ensureAqColumns(env) {
  if (_aqColsReady) return;
  const statements = [
    `ALTER TABLE businesses ADD COLUMN aq_status VARCHAR(32) NULL`,
    `ALTER TABLE businesses ADD COLUMN aq_evidence VARCHAR(512) NULL`,
    `ALTER TABLE businesses ADD COLUMN aq_policy VARCHAR(512) NULL`,
    `ALTER TABLE businesses ADD COLUMN aq_updated_at VARCHAR(32) NULL`,
    `ALTER TABLE businesses ADD COLUMN bm_users MEDIUMTEXT NULL`,
    `ALTER TABLE businesses ADD COLUMN fb_created_time VARCHAR(32) NULL`,
    // 🩺 可创建广告号上限（内部 Comet GraphQL ad_account_creation_limit；仅本地 9999 服务写）
    `ALTER TABLE businesses ADD COLUMN ad_account_limit INT NULL`,
  ];
  for (const s of statements) {
    try { await env.DB.prepare(s).run(); } catch { /* 已存在 / 已改过 */ }
  }
  _aqColsReady = true;
}

// POST /api/businesses/set-invite — BM 邀请链接写回（本地 9999 服务带密钥调用，登录用户也可调）
// 背景：分享 BM 时自动生成临时邮箱 → FB 发邀请邮件 → 提取邀请链接 → 持久化到 BM 行，
//       BM 列表/商城直接展示该链接。只更新已存在的行，避免凭空造出残缺 BM 行。
export async function handleBusinessesSetInvite(request, env, corsHeaders) {
  const authHeader = request.headers.get('Authorization');
  const apiSecret = request.headers.get('X-Api-Secret');
  const secretOk = apiSecret && apiSecret === env.PUPPETEER_API_SECRET;
  let authOk = false;
  if (!secretOk && authHeader) {
    try {
      const parts = atob(authHeader.split(' ')[1] || '').split(':');
      authOk = !!Number(parts[0]);
    } catch { authOk = false; }
  }
  if (!secretOk && !authOk) {
    return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  const body = await request.json().catch(() => ({}));
  const bid = String(body.id || '').trim();
  const pid = String(body.profile_id || body.profileId || '').trim();
  if (!bid || !pid) {
    return new Response(JSON.stringify({ success: false, message: '缺少 id / profile_id' }), { status: 400, headers: corsHeaders });
  }

  // 懒加列/改列：老库没有这三列；invite_link 早期误建成 varchar(191)，
  // 而 FB 邀请链接约 350+ 字符，MySQL 严格模式下会 Data too long 导致写回失败 → 改成 TEXT。
  // 每个进程只跑一次（ALTER TABLE 不便宜，不能每个请求都跑）。
  await ensureInviteColumns(env);

  const now = new Date().toISOString();
  try {
    const r = await env.DB.prepare(
      `UPDATE businesses SET invite_email = ?, invite_link = ?, invited_at = ? WHERE id = ? AND profile_id = ?`
    ).bind(String(body.invite_email || '').slice(0, 320), String(body.invite_link || ''), now, bid, pid).run();
    const changed = r && r.meta && Number(r.meta.changes) > 0;
    return new Response(
      JSON.stringify({ success: changed, message: changed ? 'ok' : 'BM 行不存在（请先在 BM 列表刷新一次再试）' }),
      { status: changed ? 200 : 404, headers: corsHeaders }
    );
  } catch (e) {
    return new Response(JSON.stringify({ success: false, message: '写入失败', error: String(e && e.message || e) }), { status: 500, headers: corsHeaders });
  }
}

// GET /api/businesses — list businesses
export async function handleBusinessesList(request, env, corsHeaders) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });

      // 同上：非本系统 token 的 atob 异常要转成 401，不能漏成 500
      let uId, uRole;
      try {
        const [pid, , prole] = atob(authHeader.split(' ')[1] || '').split(':');
        uId = pid; uRole = prole;
      } catch {
        return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }

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
