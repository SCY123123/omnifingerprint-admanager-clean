/**
 * 临时邮箱（自有域名收信）route handlers
 *
 * 链路：
 *   自有域名 MX(catch-all) → Cloudflare Email Routing → Email Worker
 *   → POST /api/private-emails/ingest（本文件）→ MySQL private_emails
 *   → 前端 tempmail 页面轮询 /api/private-emails/list
 *
 * 为什么不用 D1：
 *   本后端跑在宝塔 Node + MariaDB（src/db.js 是 D1→MySQL 兼容层）。
 *   若继续把邮件写进 Cloudflare D1，Node 端每 5 秒轮询都得跨网调 Cloudflare API，
 *   还要额外维护一个 API Token；写进同库 MySQL 则零外部依赖。
 *
 * 无密码体系（沿用历史临时邮箱的设计）：地址本身就是凭证，
 * 知道地址即可读信，不做账号/密码/token。
 */

const ok = (obj, corsHeaders, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...(corsHeaders || {}), 'content-type': 'application/json' },
  });

const normAddr = (v) => String(v || '').trim().toLowerCase().slice(0, 191);

// 从邮件正文提取 http(s) 链接：去重、按重要性排序（FB 商务邀请链接最优先）。
// 在服务端算好随 list/detail 一起返回，前端卡片可直接显示链接按钮+一键复制，
// 不用点开详情在 iframe 里手动找链接（BM 邀请场景的高频操作）。
function extractEmailLinks(text, html) {
  const found = [];
  const seen = new Set();
  const push = (u) => {
    if (!u) return;
    // HTML 属性里的链接常被实体转义（&amp; 等），先解码再判定，否则同一链接会出现两份
    const url = String(u)
      .replace(/&amp;/gi, '&')
      .replace(/&#38;/g, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .trim()
      .replace(/[.,;:!?'")\]}>】」』]+$/, '');
    if (!/^https?:\/\//i.test(url) || url.length > 800) return;
    if (seen.has(url)) return;
    seen.add(url);
    found.push(url);
  };
  const srcText = String(text || '');
  const srcHtml = String(html || '');
  // HTML 邮件优先取 href 属性（正文链接常被拆行/加样式，href 里是最完整的）
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  const bareRe = /https?:\/\/[^\s"'<>()]+/gi;
  let m;
  while ((m = hrefRe.exec(srcHtml)) !== null) push(m[1]);
  while ((m = bareRe.exec(srcText)) !== null) push(m[0]);
  // 纯文本兜底：没有任何 href 时再扫一遍 html 里的裸链接
  if (found.length === 0) {
    while ((m = bareRe.exec(srcHtml)) !== null) push(m[0]);
  }
  // 排序：business.facebook.com + invitation > business.facebook.com > facebook.com > 其他
  const score = (u) => {
    const s = u.toLowerCase();
    if (s.includes('business.facebook.com') && s.includes('invitation')) return 100;
    if (s.includes('business.facebook.com')) return 80;
    if (s.includes('facebook.com')) return 60;
    return 0;
  };
  return found.sort((a, b) => score(b) - score(a)).slice(0, 8);
}

// ============================================================
// MIME 解析（自包含，不引第三方库）
//
// 背景：Email Worker 早期版本把「整封原始 MIME 源码」塞进 content_text、content_html 留空，
//       前端只能原样显示源码（base64 乱码 / =?UTF-8?B?..?= 主题）。
// 做法：入库时解析好；老数据读取时按需解析并回写，历史邮件一并修好。
// 覆盖：multipart/alternative|related|mixed、base64、quoted-printable、RFC2047 头部、常见字符集。
// ============================================================

// 按字符集把字节解成字符串；Node 没带该 ICU 标签时退回 utf-8/latin1
function decodeCharset(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '').trim();
  const label = /^(gb2312|gbk|cp936)$/.test(cs) ? 'gbk'
    : /^(utf8)$/.test(cs) ? 'utf-8'
    : /^(latin1|ansi_x3\.4-1968)$/.test(cs) ? 'windows-1252'
    : cs;
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    try { return new TextDecoder('utf-8').decode(buf); } catch { return buf.toString('latin1'); }
  }
}

// quoted-printable → 字节（先去掉行尾软换行 =）
function qpToBuffer(str) {
  const s = String(str).replace(/=\r?\n/g, '');
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      out[n++] = parseInt(s.substr(i + 1, 2), 16);
      i += 2;
    } else {
      out[n++] = s.charCodeAt(i) & 0xff;
    }
  }
  return out.slice(0, n);
}

// 正文按 Content-Transfer-Encoding 解码
function decodeBody(body, encoding, charset) {
  const enc = String(encoding || '7bit').toLowerCase().trim();
  const cs = String(charset || 'utf-8').toLowerCase();
  if (enc === 'base64') {
    try { return decodeCharset(Buffer.from(String(body).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'), cs); }
    catch { return String(body); }
  }
  if (enc === 'quoted-printable') return decodeCharset(qpToBuffer(body), cs);
  // 7bit/8bit/binary：Worker 读取时已按 UTF-8 解成文本，此时不要再做 latin1 往返（会毁掉中文）
  const isUtf8 = !cs || cs.includes('utf-8') || cs.includes('utf8') || /^(us-ascii|ascii)$/.test(cs);
  if (isUtf8) return String(body);
  return decodeCharset(Buffer.from(String(body), 'latin1'), cs);
}

// RFC2047 头部解码：=?charset?B?base64?= / =?charset?Q?QP?=
function decodeHeader(value) {
  const s = String(value == null ? '' : value);
  if (!/=\?/.test(s)) return s;
  return s
    // 相邻的编码词之间可能夹着折行/空格，先去掉（否则会被当成普通文本保留）
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, kind, data) => {
      try {
        if (kind.toUpperCase() === 'B') return decodeCharset(Buffer.from(data, 'base64'), charset);
        return decodeCharset(qpToBuffer(data.replace(/_/g, ' ')), charset);  // Q 编码里 _ 代表空格
      } catch { return m; }
    });
}

// 头部块 → 小写键字典（支持折行续行）
function parseHeaders(block) {
  const out = {};
  let cur = null;
  for (const line of String(block).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && cur) { out[cur] += ' ' + line.trim(); continue; }
    const m = line.match(/^([A-Za-z0-9-]+):\s*([\s\S]*)$/);
    if (m) { cur = m[1].toLowerCase(); out[cur] = out[cur] ? out[cur] + ' ' + m[2] : m[2]; }
  }
  return out;
}

function parseContentType(value) {
  const segs = String(value || 'text/plain; charset=utf-8').split(';');
  const out = { type: (segs.shift() || '').trim().toLowerCase(), params: {} };
  for (const p of segs) {
    const m = p.match(/^\s*([^=]+)=\s*"?([^";]*)"?\s*$/);
    if (m) out.params[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

// 按 boundary 切 multipart（首段是 preamble、末段是 epilogue，都丢掉）
function splitMultipart(body, boundary) {
  const segs = String(body).split('--' + boundary);
  const parts = [];
  for (let i = 1; i < segs.length; i++) {
    let seg = segs[i];
    if (/^--/.test(seg)) break;                 // --boundary-- 结束标记
    seg = seg.replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '');
    if (seg.trim()) parts.push(seg);
  }
  return parts;
}

// 递归收集 text/plain 与 text/html（各取第一份）
function walkMime(rawStr, acc, depth) {
  if (depth > 6) return;
  const src = String(rawStr);
  const sep = src.search(/\r?\n\r?\n/);
  const headerBlock = sep >= 0 ? src.slice(0, sep) : src;
  const body = sep >= 0 ? src.slice(sep).replace(/^\r?\n\r?\n/, '') : '';
  const headers = parseHeaders(headerBlock);
  const ct = parseContentType(headers['content-type']);
  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    for (const part of splitMultipart(body, ct.params.boundary)) walkMime(part, acc, depth + 1);
    return;
  }
  const decoded = decodeBody(body, headers['content-transfer-encoding'], ct.params.charset);
  if (ct.type === 'text/html') { if (!acc.html) acc.html = decoded; }
  else if (ct.type === 'text/plain') { if (!acc.text) acc.text = decoded; }
  // 其它类型（图片、附件）忽略
}

// 原始 MIME → { isMime, subject, from, text, html }
// isMime=false 表示这本来就是一封纯文本（例如接口自测），调用方应原样处理
function parseMime(raw) {
  const src = String(raw == null ? '' : raw);
  const out = { isMime: false, subject: '', from: '', text: src, html: '' };
  const sep = src.search(/\r?\n\r?\n/);
  const headerBlock = sep >= 0 ? src.slice(0, sep) : src;
  // 只有确实带 MIME 头才当原始邮件解析，避免把恰好含空行的纯文本误判
  if (!/^(content-type|mime-version):/im.test(headerBlock) || !/^[A-Za-z0-9-]+:\s/m.test(headerBlock)) return out;
  const headers = parseHeaders(headerBlock);
  const acc = { text: '', html: '' };
  walkMime(src, acc, 0);
  out.isMime = true;
  out.subject = decodeHeader(headers['subject'] || '');
  out.from = decodeHeader(headers['from'] || '');
  out.text = acc.text;
  out.html = acc.html;
  return out;
}

// 读取时的统一正文解析（老数据兜底）：识别原始 MIME 就解析，否则原样返回
function resolveContent(row) {
  const rawText = String((row && row.content_text) || '');
  const html = String((row && row.content_html) || '');
  const subject = decodeHeader((row && row.subject) || '');
  if (html || !rawText) return { text: rawText, html, subject, isMime: false };
  // ⚠️ 不能只扫开头一段做预判：FB 邮件光 DKIM/ARC 头就 4~5KB，真正的
  //    Content-Type 行可能在很后面，截断判断会导致整封邮件被当成纯文本（显示源码）。
  //    parseMime 内部自带「头部块是否像 MIME」的判断，直接交给它。
  const parsed = parseMime(rawText);
  if (!parsed.isMime) return { text: rawText, html, subject, isMime: false };
  return { text: parsed.text, html: parsed.html, subject: parsed.subject || subject, isMime: true };
}

// ingest 只允许带正确密钥的调用方（Email Worker）。
// ⚠️ 必须对比非空密钥，否则「两边都为空」会变成人人可写。
function ingestAuthorized(request, env) {
  const secret = (env && env.PUPPETEER_API_SECRET) || process.env.PUPPETEER_API_SECRET || '';
  const got = request.headers.get('X-Api-Secret') || '';
  return !!secret && got === secret;
}

// 懒建表：本仓库既有约定（settings.js / recharge.js 同样在 handler 里建表），
// 这样即使没手工跑 schema-mysql.sql，第一次收信也能自动把表建好。
let _tableReady = false;
async function ensureTable(env) {
  if (_tableReady) return;
  try {
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS private_emails (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      address VARCHAR(191) NOT NULL,
      sender VARCHAR(320) NULL,
      subject VARCHAR(512) NULL,
      content_text LONGTEXT NULL,
      content_html LONGTEXT NULL,
      raw_json LONGTEXT NULL,
      is_seen TINYINT NOT NULL DEFAULT 0,
      created_at VARCHAR(32) NULL,
      KEY idx_private_emails_addr (address, id),
      KEY idx_private_emails_created (created_at)
    )`);
    _tableReady = true;
  } catch (e) {
    // 建表失败不阻断（可能已存在 / 权限不足）；真有问题会在下面的 INSERT/SELECT 上报出来
    console.warn('[private-emails] ensureTable 失败（继续）:', e && e.message);
  }
}

// POST /api/private-emails/ingest — Email Worker 收到信后落库
export async function handlePrivateEmailsIngest(request, env, corsHeaders) {
  if (!ingestAuthorized(request, env)) {
    return ok({ success: false, message: 'Unauthorized' }, corsHeaders, 401);
  }
  let body = {};
  try { body = await request.json(); } catch { /* 非法 JSON 走下面的必填校验 */ }

  const address = normAddr(body.to || body.address);
  if (!address) return ok({ success: false, message: '缺少收件地址' }, corsHeaders, 400);

  await ensureTable(env);
  const now = new Date().toISOString();
  try {
    // Email Worker 送来的 text 是整封原始 MIME（html 为空），这里解析出真正的正文与主题，
    // 避免前端直接看到源码；解析失败/纯文本场景按原值落库。
    const rawText = String(body.text || '');
    const rawHtml = String(body.html || '');
    const parsed = (rawText && !rawHtml) ? parseMime(rawText) : null;
    const finalText = (parsed && parsed.isMime) ? parsed.text : rawText;
    const finalHtml = (parsed && parsed.isMime) ? parsed.html : rawHtml;
    const finalSubject = (parsed && parsed.isMime && parsed.subject) ? parsed.subject : decodeHeader(String(body.subject || ''));
    const finalFrom = (parsed && parsed.isMime && parsed.from) ? parsed.from : decodeHeader(String(body.from || ''));

    const r = await env.DB.prepare(
      `INSERT INTO private_emails (address, sender, subject, content_text, content_html, raw_json, is_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    ).bind(
      address,
      finalFrom.slice(0, 320),
      finalSubject.slice(0, 512) || '(无主题)',
      finalText,
      finalHtml,
      JSON.stringify({
        messageId: body.messageId || '',
        size: Number(body.rawSize) || 0,
        date: body.date || now,
        // 原始 MIME 留一份（LONGTEXT），方便日后解析器升级后重跑
        rawMime: (parsed && parsed.isMime) ? rawText : '',
      }),
      now
    ).run();
    return ok({ success: true, id: (r && r.meta && r.meta.last_row_id) || null, address }, corsHeaders);
  } catch (e) {
    return ok({ success: false, message: '写入失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// GET /api/private-emails/list?address=xxx@your-domain.example&limit=50 — 列表（不含正文，省流量；附带提取好的链接）
export async function handlePrivateEmailsList(request, env, corsHeaders) {
  const url = new URL(request.url);
  const address = normAddr(url.searchParams.get('address'));
  if (!address) return ok({ success: false, message: '缺少 address' }, corsHeaders, 400);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);

  await ensureTable(env);
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, address, sender, subject, content_text, content_html, is_seen, created_at
       FROM private_emails WHERE address = ? ORDER BY id DESC LIMIT ${limit}`
    ).bind(address).all();
    // 列表不回传正文（LONGTEXT 太大），只回传提取出的链接数组；
    // 老数据（content_html 为空、content_text 是原始 MIME）在这里按需解析后再抽链接，
    // 否则 base64/quoted-printable 邮件里的邀请链接根本抽不出来。
    const data = (results || []).map((r) => {
      const c = resolveContent(r);
      return {
        id: r.id,
        address: r.address,
        sender: decodeHeader(r.sender || ''),
        subject: c.subject || '(无主题)',
        is_seen: r.is_seen,
        created_at: r.created_at,
        links: extractEmailLinks(c.text, c.html),
      };
    });
    return ok({ success: true, data }, corsHeaders);
  } catch (e) {
    return ok({ success: false, message: '查询失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// GET /api/private-emails/detail?id=123 — 详情（含正文），顺手标已读
export async function handlePrivateEmailsDetail(request, env, corsHeaders) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get('id')) || 0;
  if (!id) return ok({ success: false, message: '缺少 id' }, corsHeaders, 400);

  await ensureTable(env);
  try {
    const row = await env.DB.prepare(`SELECT * FROM private_emails WHERE id = ?`).bind(id).first();
    if (!row) return ok({ success: false, message: '邮件不存在' }, corsHeaders, 404);
    if (!Number(row.is_seen)) {
      await env.DB.prepare(`UPDATE private_emails SET is_seen = 1 WHERE id = ?`).bind(id).run().catch(() => {});
    }
    // 老数据兜底：content_html 为空且 content_text 是整封 MIME → 现场解析，
    // 解析成功就回写库（老邮件下次读取直接是干净正文，不用重复解析）。
    const c = resolveContent(row);
    if (c.isMime) {
      env.DB.prepare(`UPDATE private_emails SET subject = ?, content_text = ?, content_html = ? WHERE id = ?`)
        .bind((c.subject || '').slice(0, 512), c.text, c.html, id)
        .run()
        .catch((e) => console.warn('[private-emails] 回写解析结果失败:', e && e.message));
    }
    // 详情同样附带提取好的链接，前端详情页顶部直接展示复制按钮
    return ok({
      success: true,
      data: {
        ...row,
        subject: c.subject || row.subject,
        content_text: c.text,
        content_html: c.html,
        is_seen: 1,
        links: extractEmailLinks(c.text, c.html),
      },
    }, corsHeaders);
  } catch (e) {
    return ok({ success: false, message: '查询失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}

// POST /api/private-emails/seen — body { id } 标记已读
export async function handlePrivateEmailsSeen(request, env, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id) || 0;
  if (!id) return ok({ success: false, message: '缺少 id' }, corsHeaders, 400);

  await ensureTable(env);
  try {
    await env.DB.prepare(`UPDATE private_emails SET is_seen = 1 WHERE id = ?`).bind(id).run();
    return ok({ success: true }, corsHeaders);
  } catch (e) {
    return ok({ success: false, message: '更新失败', error: String(e && e.message || e) }, corsHeaders, 500);
  }
}
