/**
 * Authentication Route Handlers
 *
 * Handles /api/auth/login, /api/auth/register, /api/auth/me
 */

/**
 * POST /api/auth/login
 */
export async function handleLogin(request, env, corsHeaders) {
  const { email, password } = await request.json();
  const { results } = await env.DB.prepare(`SELECT * FROM users WHERE email = ? AND password_hash = ?`).bind(email, password).all();
  const user = results[0];
  if (!user) {
    return new Response(JSON.stringify({ success: false, message: '账号或密码错误' }), { status: 401, headers: corsHeaders });
  }
  // 记录登录时间（last_login）与最后活跃（last_active_at，团队管理列表展示用）
  const nowIso = new Date().toISOString();
  try { await env.DB.prepare(`UPDATE users SET last_login = ? WHERE id = ?`).bind(nowIso, user.id).run(); } catch (e) { console.error('[Login] 写入 last_login 失败:', e.message); }
  try { await env.DB.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).bind(nowIso, user.id).run(); } catch { /* 列可能尚未创建，忽略 */ }
  const token = btoa(`${user.id}:${user.email}:${user.role}`);
  return new Response(JSON.stringify({ 
    success: true, 
    token, 
    user: { id: user.id, email: user.email, role: user.role, username: user.username, name: user.username, permission_level: user.permission_level } 
  }), { headers: corsHeaders });
}

/**
 * POST /api/auth/register
 */
export async function handleRegister(request, env, corsHeaders) {
  const { username, password, email } = await request.json();
  if (!username || !password || !email) {
    return new Response(JSON.stringify({ success: false, message: '用户名、密码和邮箱不能为空' }), { status: 400, headers: corsHeaders });
  }
  try {
    const timestamp = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO users (username, password_hash, email, role, status, permission_level, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(username, password, email, 'user', 'active', 'full', timestamp, timestamp).run();
    return new Response(JSON.stringify({ success: true, message: '注册成功' }), { headers: corsHeaders });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return new Response(JSON.stringify({ success: false, message: '该邮箱已被注册' }), { status: 409, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ success: false, message: e.message || '注册失败' }), { status: 500, headers: corsHeaders });
  }
}

/**
 * GET /api/auth/me
 */
export async function handleMe(request, env, corsHeaders) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  
  try {
    const tokenData = atob(authHeader.split(' ')[1]);
    const [uId, email, role] = tokenData.split(':');
    const { results } = await env.DB.prepare(`SELECT id, email, role, username as name, permission_level FROM users WHERE id = ?`).bind(Number(uId)).all();
    const user = results[0];
    if (!user) return new Response(JSON.stringify({ success: false, message: 'User not found' }), { status: 401, headers: corsHeaders });
    
    return new Response(JSON.stringify({ success: true, user }), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, message: 'Invalid Token' }), { status: 401, headers: corsHeaders });
  }
}
