/**
 * Page Posts route handlers
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

// POST /api/posts/bulk-save — bulk save page posts
export async function handlePostsBulkSave(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });

  // 🆕 贴文来源列（page / ad / page,ad）：老库自动补列，已存在时由兼容层跳过
  await env.DB.prepare(`ALTER TABLE page_posts ADD COLUMN source VARCHAR(32) DEFAULT 'page'`).run().catch(() => {});
  // 🆕 贴文互动计数（点赞/评论/分享）：老库自动补列
  await env.DB.prepare(`ALTER TABLE page_posts ADD COLUMN likes_count INT DEFAULT 0`).run().catch(() => {});
  await env.DB.prepare(`ALTER TABLE page_posts ADD COLUMN comments_count INT DEFAULT 0`).run().catch(() => {});
  await env.DB.prepare(`ALTER TABLE page_posts ADD COLUMN shares_count INT DEFAULT 0`).run().catch(() => {});

  const { items = [] } = await request.json().catch(() => ({}));
  if (!Array.isArray(items) || items.length === 0) return new Response(JSON.stringify({ success: true, count: 0 }), { headers: corsHeaders });

  const timestamp = new Date().toISOString();
  const pIds = [...new Set(items.map(it => String(it.profile_id || it.profileId || '')).filter(Boolean))];
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
    const pId = String(item.profile_id || item.profileId || '');
    // 🛡️ 缺 profileId 必须跳过（否则会把字面量 "undefined" 写进 profile_id 列）
    if (!pId || pId === 'undefined' || pId === 'null') continue;
    const itemUserId = pIdMap.get(pId) || auth.uid;
    const pageId = String(item.page_id || '');
    const fbPostId = String(item.fb_post_id || item.post_id || item.id || '');
    if (!fbPostId) continue;
    const fullId = `post_${pageId}_${fbPostId}`;
    statements.push(env.DB.prepare(`
      INSERT OR REPLACE INTO page_posts (id, user_id, profile_id, page_id, page_name, fb_post_id, message, story, permalink_url, full_picture, created_time, source, likes_count, comments_count, shares_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(fullId, Number(itemUserId), pId, pageId, item.page_name || '', fbPostId,
      typeof item.message === 'string' ? item.message : JSON.stringify(item.message || ''),
      item.story || '', item.permalink_url || '', item.full_picture || '',
      item.created_time || '', String(item.source || 'page'),
      Number(item.likes_count || 0), Number(item.comments_count || 0), Number(item.shares_count || 0), timestamp));
  }

  if (statements.length > 0) await env.DB.batch(statements).catch(e => { throw e; });
  return new Response(JSON.stringify({ success: true, count: statements.length }), { headers: corsHeaders });
}

// POST /api/posts/batch-delete — 批量删除已保存的主页贴文存档（仅删云端记录，不影响 Facebook 原文）
export async function handlePostsBatchDelete(request, env, corsHeaders) {
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
        ? await env.DB.prepare(`DELETE FROM page_posts WHERE id = ?`).bind(id).run()
        : await env.DB.prepare(`DELETE FROM page_posts WHERE id = ? AND user_id = ?`).bind(id, Number(uid)).run();
      deleted += r.meta?.changes || 0;
    } catch {}
  }
  return new Response(JSON.stringify({ success: true, count: ids.length, deletedPosts: deleted }), { headers: corsHeaders });
}

// GET /api/posts — list page posts
export async function handlePostsList(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });

  const url = new URL(request.url);
  const profileId = url.searchParams.get('profileId') || url.searchParams.get('profile_id') || '';
  const pageId = url.searchParams.get('pageId') || url.searchParams.get('page_id') || '';

  let query = `SELECT p.*, u.email as owner_email FROM page_posts p LEFT JOIN users u ON p.user_id = u.id WHERE (p.user_id = ? OR ? = 'superadmin')`;
  const params = [Number(auth.uid), auth.role];
  if (profileId) { query += ` AND p.profile_id = ?`; params.push(profileId); }
  if (pageId) { query += ` AND p.page_id = ?`; params.push(pageId); }
  query += ' ORDER BY COALESCE(p.created_time, p.updated_at) DESC';
  const { results } = await env.DB.prepare(query).bind(...params).all();
  // 🚫 不要在这里按 (page_id, fb_post_id) 合并成一条：同一贴文被多个配置各抓一次是**有意义**的多行 ——
  //    每一行代表「这个配置身份下拥有/可调用这条贴文」，发布广告时要按配置挑贴文，
  //    合并掉会让「用哪个广告身份发布」失去依据。
  return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
}

// ============================================================
// 🆕 贴文互动明细：点赞用户 / 评论 / 分享者
// ============================================================

let _engTablesReady = false;
async function ensureEngagementTables(env) {
  if (_engTablesReady) return;
  const ddl = [
    `CREATE TABLE IF NOT EXISTS post_reactions (
      id VARCHAR(191) NOT NULL, profile_id VARCHAR(191) NOT NULL, user_id BIGINT NULL,
      page_id VARCHAR(191) NULL, fb_post_id VARCHAR(191) NULL, from_id VARCHAR(191) NULL,
      from_name VARCHAR(255) NULL, from_pic VARCHAR(1024) NULL, reaction_type VARCHAR(32) NULL,
      created_at VARCHAR(32) NULL, PRIMARY KEY (id), KEY idx_post_reactions_post (profile_id, fb_post_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS post_comments (
      id VARCHAR(191) NOT NULL, profile_id VARCHAR(191) NOT NULL, user_id BIGINT NULL,
      page_id VARCHAR(191) NULL, fb_post_id VARCHAR(191) NULL, comment_id VARCHAR(191) NULL,
      parent_id VARCHAR(191) NULL, from_id VARCHAR(191) NULL, from_name VARCHAR(255) NULL,
      from_pic VARCHAR(1024) NULL, message LONGTEXT NULL, created_time VARCHAR(32) NULL,
      like_count INT DEFAULT 0, reply_count INT DEFAULT 0, is_hidden TINYINT DEFAULT 0,
      can_hide TINYINT DEFAULT 0, can_remove TINYINT DEFAULT 0, can_reply_privately TINYINT DEFAULT 0,
      updated_at VARCHAR(32) NULL, PRIMARY KEY (id), KEY idx_post_comments_post (profile_id, fb_post_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS post_shares (
      id VARCHAR(191) NOT NULL, profile_id VARCHAR(191) NOT NULL, user_id BIGINT NULL,
      fb_post_id VARCHAR(191) NULL, share_post_id VARCHAR(191) NULL, from_id VARCHAR(191) NULL,
      from_name VARCHAR(255) NULL, from_pic VARCHAR(1024) NULL, message TEXT NULL,
      created_time VARCHAR(32) NULL, updated_at VARCHAR(32) NULL, PRIMARY KEY (id),
      KEY idx_post_shares_post (profile_id, fb_post_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  for (const q of ddl) await env.DB.prepare(q).run().catch(() => {});
  _engTablesReady = true;
}

// POST /api/posts/engagement-bulk-save — 按贴文整体覆盖互动明细
// body: { items: [{ profile_id, page_id, post_id, reactions[], comments[], shares[] }] }
// 采用「先删该贴文旧行 → 再插新行」，这样 FB 上被删掉的评论/取消的点赞不会残留。
export async function handlePostsEngagementBulkSave(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureEngagementTables(env);

  const { items = [] } = await request.json().catch(() => ({}));
  if (!Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ success: true, reactions: 0, comments: 0, shares: 0 }), { headers: corsHeaders });
  }

  const timestamp = new Date().toISOString();
  const pIds = [...new Set(items.map(it => String(it.profile_id || it.profileId || '')).filter(Boolean))];
  const pIdMap = new Map();
  if (pIds.length > 0) {
    const ph = pIds.map(() => '?').join(',');
    const { results: owners } = await env.DB.prepare(`SELECT id, ext_id, user_id FROM profiles WHERE id IN (${ph}) OR ext_id IN (${ph})`).bind(...pIds, ...pIds).all().catch(() => ({ results: [] }));
    (owners || []).forEach(p => {
      if (p.id) pIdMap.set(String(p.id), p.user_id);
      if (p.ext_id) pIdMap.set(String(p.ext_id), p.user_id);
    });
  }

  const statements = [];
  const counts = { reactions: 0, comments: 0, shares: 0 };
  for (const item of items) {
    const pId = String(item.profile_id || item.profileId || '');
    if (!pId || pId === 'undefined' || pId === 'null') continue;
    const postId = String(item.post_id || item.fb_post_id || '');
    if (!postId) continue;
    const uid = Number(pIdMap.get(pId) || auth.uid);
    const pageId = String(item.page_id || (postId.includes('_') ? postId.split('_')[0] : ''));

    statements.push(env.DB.prepare(`DELETE FROM post_reactions WHERE profile_id = ? AND fb_post_id = ?`).bind(pId, postId));
    statements.push(env.DB.prepare(`DELETE FROM post_comments WHERE profile_id = ? AND fb_post_id = ?`).bind(pId, postId));
    statements.push(env.DB.prepare(`DELETE FROM post_shares WHERE profile_id = ? AND fb_post_id = ?`).bind(pId, postId));

    for (const r of (item.reactions || [])) {
      const fid = String(r.from_id || r.id || '');
      if (!fid) continue;
      statements.push(env.DB.prepare(`INSERT OR REPLACE INTO post_reactions
        (id, profile_id, user_id, page_id, fb_post_id, from_id, from_name, from_pic, reaction_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        `rx_${postId}_${fid}`, pId, uid, pageId, postId, fid,
        String(r.from_name || r.name || ''), String(r.from_pic || ''), String(r.reaction_type || 'LIKE'), timestamp));
      counts.reactions++;
    }
    for (const c of (item.comments || [])) {
      const cid = String(c.comment_id || c.id || '');
      if (!cid) continue;
      statements.push(env.DB.prepare(`INSERT OR REPLACE INTO post_comments
        (id, profile_id, user_id, page_id, fb_post_id, comment_id, parent_id, from_id, from_name, from_pic,
         message, created_time, like_count, reply_count, is_hidden, can_hide, can_remove, can_reply_privately, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        `cm_${cid}`, pId, uid, pageId, postId, cid, String(c.parent_id || ''),
        String(c.from_id || ''), String(c.from_name || ''), String(c.from_pic || ''),
        typeof c.message === 'string' ? c.message : JSON.stringify(c.message || ''),
        String(c.created_time || ''), Number(c.like_count || 0), Number(c.reply_count || 0),
        c.is_hidden ? 1 : 0, c.can_hide ? 1 : 0, c.can_remove ? 1 : 0, c.can_reply_privately ? 1 : 0, timestamp));
      counts.comments++;
    }
    for (const s of (item.shares || [])) {
      const sid = String(s.share_post_id || s.id || '');
      if (!sid) continue;
      statements.push(env.DB.prepare(`INSERT OR REPLACE INTO post_shares
        (id, profile_id, user_id, fb_post_id, share_post_id, from_id, from_name, from_pic, message, created_time, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        `sh_${sid}`, pId, uid, postId, sid,
        String(s.from_id || ''), String(s.from_name || ''), String(s.from_pic || ''),
        typeof s.message === 'string' ? s.message : JSON.stringify(s.message || ''),
        String(s.created_time || ''), timestamp));
      counts.shares++;
    }
  }

  // 分批提交，避免单次 batch 语句过多
  for (let i = 0; i < statements.length; i += 200) {
    const chunk = statements.slice(i, i + 200);
    if (chunk.length) await env.DB.batch(chunk);
  }
  return new Response(JSON.stringify({ success: true, posts: items.length, ...counts }), { headers: corsHeaders });
}

// POST /api/posts/comment/patch — 在 FB 端操作评论成功后，同步更新云端副本
// 否则「获取信息」前重新打开面板会看到已删除/已隐藏的评论又回来了。
// body: { profileId, commentId, op: 'delete' | 'hide' | 'unhide' }
export async function handlePostsCommentPatch(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureEngagementTables(env);

  const { profileId = '', commentId = '', op = '' } = await request.json().catch(() => ({}));
  if (!commentId || !op) return new Response(JSON.stringify({ success: false, message: 'commentId / op required' }), { status: 400, headers: corsHeaders });

  const rowId = `cm_${String(commentId)}`;
  const scope = `AND (user_id = ? OR ? = 'superadmin')`;
  const base = [Number(auth.uid), auth.role];
  const where = profileId
    ? `id = ? AND profile_id = ? ${scope}`
    : `id = ? ${scope}`;
  const params = profileId ? [rowId, String(profileId), ...base] : [rowId, ...base];

  let run;
  if (op === 'delete') run = env.DB.prepare(`DELETE FROM post_comments WHERE ${where}`).bind(...params);
  else if (op === 'hide' || op === 'unhide') run = env.DB.prepare(`UPDATE post_comments SET is_hidden = ? WHERE ${where}`).bind(op === 'hide' ? 1 : 0, ...params);
  else return new Response(JSON.stringify({ success: false, message: `不支持的 op: ${op}` }), { status: 400, headers: corsHeaders });

  const r = await run.run().catch(() => ({ meta: {} }));
  return new Response(JSON.stringify({ success: true, changes: r?.meta?.changes || 0 }), { headers: corsHeaders });
}

// GET /api/posts/engagement?profileId=&postId= — 读某条贴文的互动明细
export async function handlePostsEngagementGet(request, env, corsHeaders) {
  const auth = resolveAuth(request, env);
  if (!auth) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  await ensureEngagementTables(env);

  const url = new URL(request.url);
  const profileId = url.searchParams.get('profileId') || url.searchParams.get('profile_id') || '';
  const postId = url.searchParams.get('postId') || url.searchParams.get('post_id') || '';
  if (!postId) return new Response(JSON.stringify({ success: false, message: 'postId required' }), { status: 400, headers: corsHeaders });

  const scope = `AND (user_id = ? OR ? = 'superadmin')`;
  const base = [Number(auth.uid), auth.role];
  let where = `profile_id = ? AND fb_post_id = ? ${scope}`;
  const params = profileId ? [profileId, postId, ...base] : [];
  if (!profileId) {
    where = `fb_post_id = ? ${scope}`;
    params.length = 0;
    params.push(postId, ...base);
  }

  const q = async (table, order) => {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where} ${order}`).bind(...params).all().catch(() => ({ results: [] }));
    return results || [];
  };
  const [reactions, comments, shares] = await Promise.all([
    q('post_reactions', 'ORDER BY from_name ASC'),
    q('post_comments', 'ORDER BY created_time DESC'),
    q('post_shares', 'ORDER BY created_time DESC'),
  ]);
  return new Response(JSON.stringify({ success: true, data: { reactions, comments, shares } }), { headers: corsHeaders });
}
