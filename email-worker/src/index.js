/**
 * 临时邮箱收信 Worker（Cloudflare Email Routing 触发）
 *
 * 链路：自有域名 MX(catch-all) → Email Routing → 本 Worker
 *       → POST /api/private-emails/ingest（宝塔后端）→ MySQL private_emails
 *       → 前端 tempmail 页面轮询读取
 *
 * 🐛 早先 V4.0.3 是「直接写 D1」，但宝塔后端跑的是 MariaDB（src/db.js 是 D1→MySQL 兼容层），
 *    写进 D1 等于写进另一个孤岛：Node 端读不到，前端也就一直没接上。
 *    现在改成把邮件转发给后端落库，库里只有一份。
 *
 * 需要在 Worker 上配置两个变量（不是明文写在这里）：
 *   npx wrangler secret put INGEST_URL      # 例如 https://your-backend.example.com/api/private-emails/ingest
 *   npx wrangler secret put INGEST_SECRET   # 必须等于后端 .env 的 PUPPETEER_API_SECRET
 */
export default {
  async email(message, env, ctx) {
    const address = String(message.to || '').toLowerCase();
    const subject = message.headers.get('subject') || '(无主题)';

    // 原始 MIME 全文先收下来：正文解析（multipart 拆 text/html 部分）留到后续再做，
    // 但验证码/链接都在里面，不影响当前使用。
    let raw = '';
    try {
      raw = await new Response(message.raw).text();
    } catch (err) {
      console.error('读取原始邮件失败:', err && err.message);
    }

    const url = env.INGEST_URL;
    if (!url) {
      console.error('INGEST_URL 未配置，邮件未落库:', address);
      return;
    }

    const payload = {
      to: address,
      from: message.from,
      subject,
      text: raw,
      html: '',
      rawSize: message.rawSize,
      messageId: message.headers.get('message-id') || '',
      date: new Date().toISOString(),
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Api-Secret': env.INGEST_SECRET || '',
        },
        body: JSON.stringify(payload),
      });
      const text = await resp.text();
      if (!resp.ok) {
        console.error(`转发失败 ${resp.status} (${address}): ${text.slice(0, 300)}`);
      } else {
        console.log(`已落库 ${address} ← ${message.from}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.error('转发到后端失败:', err && err.message);
    }
  },
};
