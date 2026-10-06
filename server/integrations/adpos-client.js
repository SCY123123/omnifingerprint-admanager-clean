const tokenProvider = require('../payment/token-provider');

const cache = new Map();
const lim = { access: { count: 0, start: 0 }, auth: { count: 0, start: 0 } };

async function rateLimit(kind) {
  const now = Date.now();
  const state = lim[kind];
  const max = kind === 'auth'
    ? Number(process.env.ADPOS_AUTH_RATE_LIMIT || 10)
    : Number(process.env.ADPOS_ACCESS_RATE_LIMIT || 180);
  if (!state.start || (now - state.start) >= 60000) {
    state.start = now;
    state.count = 0;
  }
  state.count++;
  if (state.count > max) {
    const wait = 60000 - (now - state.start);
    await new Promise(r => setTimeout(r, Math.max(wait, 200)));
  }
}

async function getToken(profileId, forceRefresh) {
  const key = String(profileId || '');
  const existed = cache.get(key);
  if (existed && !forceRefresh) return existed;
  await rateLimit('auth');
  const r = await tokenProvider.requestPaymentManagementToken({ profileId: key, adAccountId: '' });
  const t = r && r.token ? String(r.token) : '';
  if (t) cache.set(key, t);
  return t;
}

async function getGlobalToken(forceRefresh) {
  const key = '__global__';
  const existed = cache.get(key);
  if (existed && !forceRefresh) return existed;
  await rateLimit('auth');
  const r = await tokenProvider.requestPaymentManagementToken({ profileId: '', adAccountId: '' });
  const t = r && r.token ? String(r.token) : '';
  if (t) cache.set(key, t);
  return t;
}

async function request({ profileId, token, method, path, query, body }) {
  const base = (process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  const tk = token || (await getToken(profileId));
  if (tk) headers['Authorization'] = `Bearer ${tk}`;
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)])).toString()}` : '';
  const url = `${base}${path}${qs}`;
  const maxRetries = 4;
  let attempt = 0;
  let lastResp = null;
  let refreshed = false;
  while (attempt <= maxRetries) {
    await rateLimit('access');
    const controller = (() => { try { return new (require('abort-controller'))(); } catch { try { return new AbortController(); } catch { return null; } } })();
    const timeoutMs = Number(process.env.ADPOS_TIMEOUT || 12000);
    let timer = null;
    if (controller) { timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs); }
    const resp = await fetch(url, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: controller ? controller.signal : undefined }).catch(e => ({ status: 599, ok: false, _error: String(e && e.message || e), json: async ()=>({ message: String(e && e.message || e) }) }));
    if (timer) { try { clearTimeout(timer); } catch {} }
    lastResp = resp;
    if (resp.status === 401 || resp.status === 500) {
      try {
        const j = await resp.clone().json().catch(() => ({}));
        const msg = j && (j.message || j.error) ? String(j.message || j.error) : '';
        if (!refreshed && (/Unauthenticated/i.test(msg) || resp.status === 401)) {
          const nt = await getToken(profileId, true);
          if (nt) { headers['Authorization'] = `Bearer ${nt}`; refreshed = true; continue; }
        }
      } catch {}
    }
    if (resp.status !== 429) break;
    const delay = Math.min(1200, 200 * Math.pow(2, attempt)) + Math.floor(Math.random() * 120);
    await new Promise(r => setTimeout(r, delay));
    attempt++;
  }
  let json = await lastResp.json().catch(async () => {
    try {
      const txt = await lastResp.text();
      return { message: txt };
    } catch { return {}; }
  });
  const data = json && json.data !== undefined ? json.data : json;
  const meta = json && json.meta ? json.meta : null;
  const error = (!lastResp.ok && ((json && (json.message || json.error)) || (data && (data.message || data.error))))
    ? String((json && (json.message || json.error)) || (data && (data.message || data.error)))
    : null;
  const status_code = json && json.status_code !== undefined ? json.status_code : null;
  return { status: lastResp.status, ok: lastResp.ok, data, meta, error, status_code };
}

async function getAccount({ profileId, token }) {
  return request({ profileId, token, method: 'GET', path: '/account' });
}

async function listCards({ profileId, token, page, per_page }) {
  const pp = per_page ? Math.min(Number(per_page)||15, 500) : undefined;
  return request({ profileId, token, method: 'GET', path: '/cards', query: { page, per_page: pp } });
}

async function listTransactions({ profileId, token, page, per_page, start_timestamp, end_timestamp, status, card_number, alias, tags, card_bin_code }) {
  const pp = per_page ? Math.min(Number(per_page)||15, 500) : undefined;
  const qs = { page, per_page: pp, start_timestamp, end_timestamp, status, card_number, alias, tags, card_bin_code };
  const r1 = await request({ profileId, token, method: 'GET', path: '/v2/cards/transactions', query: qs });
  if (r1.ok || (r1.status !== 404 && r1.status !== 422)) return r1;
  return request({ profileId, token, method: 'GET', path: '/transactions', query: { page, per_page: pp, status, card_number, alias, tags, card_bin_code } });
}

async function createTransfer({ profileId, token, payload }) {
  return request({ profileId, token, method: 'POST', path: '/transfers', body: payload || {} });
}

async function listAllCards({ profileId, token, per_page }) {
  const size = per_page ? Math.min(Number(per_page)||500, 500) : 500;
  let page = 1;
  const out = [];
  while (true) {
    const r = await listCards({ profileId, token, page, per_page: size });
    if (!r.ok) break;
    const arr = Array.isArray(r.data) ? r.data : [];
    out.push(...arr);
    const pg = r.meta && r.meta.pagination ? r.meta.pagination : null;
    const cur = pg && pg.current_page ? Number(pg.current_page) : page;
    const total = pg && pg.total_pages ? Number(pg.total_pages) : (arr.length < size ? cur : cur + 1);
    if (!pg || cur >= total) break;
    page = cur + 1;
    await rateLimit('access');
  }
  return { ok: true, status: 200, data: out, meta: { count: out.length } };
}

async function listAllTransactions({ token, per_page, start_timestamp, end_timestamp, status, card_number, alias, tags, card_bin_code }) {
  const size = per_page ? Math.min(Number(per_page)||500, 500) : 500;
  let page = 1;
  const out = [];
  const tk = token || (await getGlobalToken(false));
  while (true) {
    let r = await request({ profileId: '', token: tk, method: 'GET', path: '/v2/cards/transactions', query: { page, per_page: size, start_timestamp, end_timestamp, status, card_number, alias, tags, card_bin_code } });
    if (!r.ok && (r.status === 404 || r.status === 422)) {
      r = await request({ profileId: '', token: tk, method: 'GET', path: '/transactions', query: { page, per_page: size, status, card_number, alias, tags, card_bin_code } });
    }
    if (!r.ok) break;
    const arr = Array.isArray(r.data) ? r.data : [];
    out.push(...arr);
    const pg = r.meta && r.meta.pagination ? r.meta.pagination : null;
    const cur = pg && pg.current_page ? Number(pg.current_page) : page;
    const total = pg && pg.total_pages ? Number(pg.total_pages) : (arr.length < size ? cur : cur + 1);
    if (!pg || cur >= total) break;
    page = cur + 1;
    await rateLimit('access');
  }
  if (out.length === 0) {
    try {
      const cards = await listAllCards({ profileId: '', token: tk, per_page: 500 });
      const list = Array.isArray(cards && cards.data) ? cards.data : [];
      for (const c of list) {
        let p = 1; const per = size;
        while (true) {
          let r = await request({ profileId: '', token: tk, method: 'GET', path: '/v2/cards/transactions', query: { card_id: String(c.card_id||c.id||''), page: p, per_page: per, start_timestamp, end_timestamp, status, card_number, alias, tags, card_bin_code } });
          if (!r.ok && (r.status === 404 || r.status === 422)) {
            r = await request({ profileId: '', token: tk, method: 'GET', path: '/transactions', query: { card_id: String(c.card_id||c.id||''), page: p, per_page: per, status, card_number, alias, tags, card_bin_code } });
          }
          if (!r.ok) break;
          const arr = Array.isArray(r.data) ? r.data : [];
          out.push(...arr);
          const pg = r.meta && r.meta.pagination ? r.meta.pagination : null;
          const cur = pg && pg.current_page ? Number(pg.current_page) : p;
          const total = pg && pg.total_pages ? Number(pg.total_pages) : (arr.length < per ? cur : cur + 1);
          if (!pg || cur >= total) break;
          p = cur + 1;
          await rateLimit('access');
        }
      }
    } catch {}
  }
  return { ok: true, status: 200, data: out, meta: { count: out.length } };
}

async function listTransactionsByCard({ token, card_id, page, per_page, start_timestamp, end_timestamp, status, card_number, alias, tags, card_bin_code }) {
  const size = per_page ? Math.min(Number(per_page)||500, 500) : 500;
  const tk = token || (await getGlobalToken(false));
  let r = await request({ profileId: '', token: tk, method: 'GET', path: '/v2/cards/transactions', query: { card_id: String(card_id||''), page: Number(page||1), per_page: size, start_timestamp, end_timestamp, status, card_number, alias, tags, card_bin_code } });
  if (!r.ok && (r.status === 404 || r.status === 422)) {
    r = await request({ profileId: '', token: tk, method: 'GET', path: '/transactions', query: { card_id: String(card_id||''), page: Number(page||1), per_page: size, status, card_number, alias, tags, card_bin_code } });
  }
  return r;
}

module.exports = { getToken, getGlobalToken, request, getAccount, listCards, listTransactions, createTransfer, listAllCards, listAllTransactions, listTransactionsByCard };
