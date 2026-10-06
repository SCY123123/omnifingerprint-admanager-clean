/**
 * POST /api/upload-temp — 本机服务上传媒体附件（base64），存到服务器 uploads 目录并返回公网 URL。
 *   用途：Messenger Send API 的 attachment.payload.url 模式需要 Facebook 服务器能直接拉取该 URL，
 *   以绕开 message_attachments 端点对官方 app 令牌的 (10) Permission Denied 限制。
 * GET  /uploads/:name — 公开读取已上传的附件（供 Facebook 拉取，无需认证）。
 *
 * 认证：POST 需要 X-Api-Secret === PUPPETEER_API_SECRET；GET 公开。
 * 兼容：Node 环境（node:fs/promises 动态加载），非 Node 环境返回明确错误。
 */

const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'm4v']);
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
};

function uploadDir() {
  return (process.env.UPLOAD_DIR || '').replace(/\/$/, '');
}
function publicBase() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
}

export async function handleUploadTemp(request, env, corsHeaders) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: { ...(corsHeaders || { 'Access-Control-Allow-Origin': '*' }), 'content-type': 'application/json' },
  });
  try {
    const secret = request.headers.get('X-Api-Secret') || '';
    if (!secret || secret !== (process.env.PUPPETEER_API_SECRET || env.PUPPETEER_API_SECRET)) {
      return json({ success: false, message: 'Unauthorized' }, 401);
    }
    let body;
    try { body = await request.json(); } catch { return json({ success: false, message: 'body must be JSON {base64, ext}' }, 400); }
    const b64 = String((body && body.base64) || '').replace(/^data:[^,]+,/, '');
    const ext = String((body && body.ext) || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    if (!b64 || b64.length < 64) return json({ success: false, message: 'base64 missing/too small' }, 400);
    if (!ALLOWED_EXT.has(ext)) return json({ success: false, message: 'ext not allowed' }, 400);
    let fs;
    try { fs = await import('node:fs/promises'); } catch {
      return json({ success: false, message: 'upload-temp only supported on Node runtime' }, 500);
    }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 64) return json({ success: false, message: 'decoded file too small' }, 400);
    if (buf.length > 10 * 1024 * 1024) return json({ success: false, message: 'file too large (<=10MB)' }, 400);
    const dir = uploadDir();
    await fs.mkdir(dir, { recursive: true });
    const name = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await fs.writeFile(`${dir}/${name}`, buf);
    return json({ success: true, url: `${publicBase()}/uploads/${name}`, size: buf.length });
  } catch (e) {
    return json({ success: false, message: 'upload failed: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
}

export async function handleUploadsGet(request, env, corsHeaders, fileName) {
  try {
    const name = String(fileName || '');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
      return new Response(JSON.stringify({ success: false, message: 'bad file name' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const ext = (name.split('.').pop() || '').toLowerCase();
    let fs;
    try { fs = await import('node:fs/promises'); } catch {
      return new Response('not supported', { status: 500 });
    }
    const buf = await fs.readFile(`${uploadDir()}/${name}`);
    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*',
      },
    });
  } catch {
    return new Response(JSON.stringify({ success: false, message: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
}
