'use strict';

const sqlite3 = require('sqlite3').verbose();

let _log = () => {};
let _app = null;
let _tokenProvider = null;
let _adposClient = null;
let _dbPath = '';

function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.app) _app = deps.app;
  if (deps.tokenProvider) _tokenProvider = deps.tokenProvider;
  if (deps.adposClient) _adposClient = deps.adposClient;
  if (deps.dbPath) _dbPath = deps.dbPath;
}

function ensureAdposTables(db){
    return new Promise((resolve)=>{
        db.serialize(()=>{
            db.run(`CREATE TABLE IF NOT EXISTS adpos_cards (id TEXT PRIMARY KEY, alias TEXT, last_four_digits TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`) 
            db.run(`CREATE TABLE IF NOT EXISTS adpos_transactions (id TEXT PRIMARY KEY, amount REAL, currency TEXT, status TEXT, created_at DATETIME, card_id TEXT, last_four_digits TEXT)`, [], ()=>resolve())
        })
    })
}
function ensureAdposPrefs(db){
    return new Promise((resolve)=>{
        db.serialize(()=>{
            db.run(`CREATE TABLE IF NOT EXISTS adpos_prefs (profile_id TEXT PRIMARY KEY, auto_refresh INTEGER, auto_save_local INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, [], ()=>resolve())
        })
    })
}

async function adposFetch(pathname, token, baseUrl){
    const base = String(baseUrl || 'https://api.adpos.io').replace(/\/$/, '')
    const url = `${base}${pathname.startsWith('/')?pathname:`/${pathname}`}`
    const headers = { 'Accept': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const r = await fetch(url, { headers })
    const j = await r.json().catch(()=>({}))
    return j
}

function registerRoutes() {
  if (!_app) return;

  // 本地交易记录转发（同源到 storage-api-server）
  _app.get('/api/adpos/transactions/list', async (req, res) => {
      try {
          const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
          const qs = new URLSearchParams();
          for (const k of Object.keys(req.query || {})) { const v = req.query[k]; if (v !== undefined && v !== null) qs.set(k, String(v)); }
          const url = `${base}/api/adpos/transactions/list${qs.toString() ? ('?' + qs.toString()) : ''}`;
          const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
          const text = await r.text();
          res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
      } catch (e) { res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
  });
  _app.post('/api/adpos/transactions/save', async (req, res) => {
      try {
          const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
          const url = `${base}/api/adpos/transactions/save`;
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(req.body || {}) });
          const text = await r.text();
          res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
      } catch (e) { res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
  });

  // adpos 路由兜底（优先级提前）
  _app.all('/api/adpos/*splat', (req, res, next) => {
      (async () => {
          try {
              const u = String(req.url || '')
              if (u.includes('/api/adpos/transactions')) { return next() }
              if (u.includes('/api/adpos/prefs')) { return next() }
              if (u.includes('/api/adpos/transactions/save-batch')) { return next() }
              const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '')
              const target = `${base}${u}`
              const method = String(req.method || 'GET').toUpperCase()
              const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' }
              const init = { method, headers }
              try { if (!['GET','HEAD'].includes(method)) Object.assign(init, { body: JSON.stringify(req.body || {}) }) } catch {}
              const r = await fetch(target, init)
              const text = await r.text()
              return res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text)
          } catch (e) {
              return res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) })
          }
      })()
  })

  // 兼容路由提前注册，避免404
  _app.all('/api/adpos/access-token', async (req, res) => {
      try {
          const body = (req.body && Object.keys(req.body).length ? req.body : {})
          const email = String(body.email || process.env.ADPOS_EMAIL || '')
          const password = String(body.password || process.env.ADPOS_PASSWORD || '')
          const base = (String(body.baseUrl || process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io')).replace(/\/$/, '')
          if (!email || !password) {
              return res.status(400).json({ success: false, message: 'missing_credentials' })
          }
          const url = `${base}/auth/access-token`
          const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
          const json = await resp.json().catch(()=>({}))
          const data = json && json.data ? json.data : json
          const token = data && data.access_token ? String(data.access_token) : ''
          const type = data && data.token_type ? String(data.token_type) : ''
          return res.json({ success: !!token, status: resp.status, token, token_type: type || 'Bearer', raw: data })
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
      }
  })

  _app.get('/api/adpos/account', async (req, res) => {
      try {
          const { token } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {}
          const r = await _adposClient.getAccount({ profileId: '', token })
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code })
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
      }
  })
  _app.get('/api/adpos/cards', async (req, res) => {
      try {
          const { profileId, token, page, per_page } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          const r = await _adposClient.listCards({ profileId, token, page, per_page });
          return res.json({ success: r.ok, status: r.status, data: r.data || [], meta: r.meta || null, error: r.error || null, status_code: r.status_code });
      } catch (e) {
          return res.json({ success: false, status: 200, data: [], meta: null });
      }
  });

  _app.get('/api/adpos/cards/all', async (req, res) => {
      try {
          const { profileId, token, per_page } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          const r = await _adposClient.listAllCards({ profileId, token, per_page });
          return res.json({ success: r.ok, status: r.status, data: r.data || [], meta: r.meta || null });
      } catch (e) {
          return res.json({ success: false, status: 200, data: [], meta: null });
      }
  });
  _app.get('/api/adpos/transactions/all', async (req, res) => {
      try {
          const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
          const qs = new URLSearchParams();
          for (const k of Object.keys(req.query || {})) { const v = req.query[k]; if (v !== undefined && v !== null) qs.set(k, String(v)); }
          const url = `${base}/api/adpos/transactions/list${qs.toString() ? ('?' + qs.toString()) : ''}`;
          const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
          const text = await r.text();
          return res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
      } catch (e) { return res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
  });

  _app.get('/api/adpos/transactions/by-card', async (req, res) => {
      try {
          const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
          const qs = new URLSearchParams();
          for (const k of Object.keys(req.query || {})) { const v = req.query[k]; if (v !== undefined && v !== null) qs.set(k, String(v)); }
          const url = `${base}/api/adpos/transactions/list${qs.toString() ? ('?' + qs.toString()) : ''}`;
          const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
          const text = await r.text();
          return res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
      } catch (e) { return res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
  });

  _app.get('/api/adpos/transactions', async (req, res) => {
      try {
          const base = String(process.env.STORAGE_SERVER_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
          const qs = new URLSearchParams();
          for (const k of Object.keys(req.query || {})) { const v = req.query[k]; if (v !== undefined && v !== null) qs.set(k, String(v)); }
          const url = `${base}/api/adpos/transactions/list${qs.toString() ? ('?' + qs.toString()) : ''}`;
          const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
          const text = await r.text();
          return res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
      } catch (e) { return res.status(500).json({ success: false, message: 'proxy_error', error: String(e && e.message || e) }); }
  });

  // 兜底：任何未命中的 adpos 路由统一返回空列表，避免 404
  _app.all('/api/adpos/*splat', (req, res, next) => {
      try {
          const u = String(req.url || '')
          if (u.includes('/api/adpos/prefs')) { return next() }
          if (u.includes('/api/adpos/transactions/save-batch')) { return next() }
          return res.json({ success: true, status: 200, data: [], meta: { count: 0 } });
      } catch { return res.json({ success: true, status: 200, data: [], meta: { count: 0 } }); }
  });

  // AdPOS：卡与交易（本地空/表驱动返回）
  _app.get('/api/adpos/cards/all', async (req, res) => {
      try {
          const per = Math.max(1, Math.min(Number(req.query.per_page||500), 1000))
          const page = Math.max(1, Number(req.query.page||1))
          const offset = (page-1) * per
          const sdb = new sqlite3.Database(_dbPath)
          await ensureAdposTables(sdb)
          const rows = await new Promise((resolve, reject)=>{
              sdb.all(`SELECT id, alias, last_four_digits FROM adpos_cards ORDER BY created_at DESC LIMIT ? OFFSET ?`, [per, offset], (err, r)=> (err?reject(err):resolve(r||[])))
          })
          await new Promise(r=>sdb.close(r))
          return res.json({ success: true, data: rows, meta: { pagination: { current_page: page, per_page: per, count: rows.length, total_pages: 1, total: rows.length } } })
      } catch(e){ return res.status(500).json({ success:false, message:'error', error:String(e.message||e) }) }
  })
  _app.get('/api/adpos/cards', (req, res) => { req.url = '/api/adpos/cards/all' ; return _app._router.handle(req, res, ()=>{}) })
  _app.get('/api/adpos/transactions/all', async (req, res) => {
      try {
          const per = Math.max(1, Math.min(Number(req.query.per_page||200), 2000))
          const page = Math.max(1, Number(req.query.page||1))
          const offset = (page-1) * per
          const start = Number(req.query.start_timestamp||0)
          const end = Number(req.query.end_timestamp||0)
          const status = String(req.query.status||'').trim().toLowerCase()
          const last4 = String((req.query.last4||req.query.card_number||'')).trim()
          const sdb = new sqlite3.Database(_dbPath)
          await ensureAdposTables(sdb)
          let sql = `SELECT id, amount, currency, status, created_at, card_id, last_four_digits FROM adpos_transactions`
          const args = []
          const conds = []
          if (start>0) { conds.push(`created_at >= datetime(?, 'unixepoch')`); args.push(start) }
          if (end>0) { conds.push(`created_at <= datetime(?, 'unixepoch')`); args.push(end) }
          if (status) { conds.push(`LOWER(status) = ?`); args.push(status) }
          if (last4) { conds.push(`last_four_digits LIKE ?`); args.push(`%${last4}%`) }
          if (conds.length) sql += ` WHERE ` + conds.join(' AND ')
          sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`; args.push(per, offset)
          const rows = await new Promise((resolve, reject)=>{ sdb.all(sql, args, (err, r)=> (err?reject(err):resolve(r||[]))) })
          await new Promise(r=>sdb.close(r))
          return res.json({ success: true, data: rows, meta: { pagination: { current_page: page, per_page: per, count: rows.length, total_pages: 1, total: rows.length } } })
      } catch(e){ return res.status(500).json({ success:false, message:'error', error:String(e.message||e) }) }
  })
  _app.get('/api/adpos/transactions/by-card', async (req, res) => {
      try {
          const per = Math.max(1, Math.min(Number(req.query.per_page||200), 2000))
          const page = Math.max(1, Number(req.query.page||1))
          const offset = (page-1) * per
          const cardId = String(req.query.card_id||'').trim()
          const last4 = String((req.query.last4||req.query.card_number||'')).trim()
          const sdb = new sqlite3.Database(_dbPath)
          await ensureAdposTables(sdb)
          let sql = `SELECT id, amount, currency, status, created_at, card_id, last_four_digits FROM adpos_transactions WHERE card_id = ?`
          const args = [cardId]
          if (last4) { sql += ` AND last_four_digits LIKE ?`; args.push(`%${last4}%`) }
          sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`; args.push(per, offset)
          const rows = await new Promise((resolve, reject)=>{
              sdb.all(sql, args, (err, r)=> (err?reject(err):resolve(r||[])))
          })
          await new Promise(r=>sdb.close(r))
          return res.json({ success: true, data: rows, meta: { pagination: { current_page: page, per_page: per, count: rows.length, total_pages: 1, total: rows.length } } })
      } catch(e){ return res.status(500).json({ success:false, message:'error', error:String(e.message||e) }) }
  })
  _app.get('/api/adpos/transactions', (req, res) => { req.url = '/api/adpos/transactions/all' ; return _app._router.handle(req, res, ()=>{}) })

  _app.post('/api/adpos/sync', async (req, res) => {
      try {
          const { token, baseUrl, start_timestamp, end_timestamp, per_page } = req.body || {}
          const sdb = new sqlite3.Database(_dbPath)
          await ensureAdposTables(sdb)
          let savedCards = 0, savedTxns = 0
          try {
              const cj = await adposFetch('/cards?page=1&per_page=500', token, baseUrl)
              const cards = Array.isArray(cj?.data) ? cj.data : []
              for (const c of cards) {
                  const id = String(c.id || c.card_id || '')
                  const alias = String(c.alias || c.name || '')
                  const last4 = String(c.last_four_digits || c.card_last4 || '')
                  if (!id) continue
                  await new Promise((resolve, reject)=>{
                      sdb.run(`INSERT OR REPLACE INTO adpos_cards (id, alias, last_four_digits) VALUES (?, ?, ?)`, [id, alias, last4], (err)=> (err?reject(err):resolve()))
                  })
                  savedCards++
              }
          } catch{}
          try {
              const per = Math.max(1, Math.min(Number(per_page||500), 1000))
              const qs = `per_page=${per}` + (start_timestamp?`&start_timestamp=${Number(start_timestamp)||0}`:'') + (end_timestamp?`&end_timestamp=${Number(end_timestamp)||0}`:'')
              const tj = await adposFetch(`/transactions?${qs}`, token, baseUrl)
              const txns = Array.isArray(tj?.data) ? tj.data : []
              for (const t of txns) {
                  const id = String(t.id || '')
                  const amount = Number(t.amount || 0)
                  const currency = String(t.currency || '')
                  const status = String(t.status || '')
                  const created_at = String(t.created_at || t.date || '')
                  const card_id = String(t.card_id || '')
                  const last4 = String(t.last_four_digits || t.card_last4 || '')
                  if (!id) continue
                  await new Promise((resolve, reject)=>{
                      sdb.run(`INSERT OR REPLACE INTO adpos_transactions (id, amount, currency, status, created_at, card_id, last_four_digits) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, amount, currency, status, created_at, card_id, last4], (err)=> (err?reject(err):resolve()))
                  })
                  savedTxns++
              }
          } catch{}
          await new Promise(r=>sdb.close(r))
          return res.json({ success: true, savedCards, savedTxns })
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) })
      }
  })
  _app.post('/api/adpos/transactions/save-batch', async (req, res) => {
      try {
          const items = (req.body && (req.body.items || req.body.data || req.body)) || []
          const list = Array.isArray(items) ? items : []
          if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
          const sdb = new sqlite3.Database(_dbPath)
          await ensureAdposTables(sdb)
          let saved = 0
          for (const t of list) {
              const id = String(t.id || '')
              const amount = Number(t.amount || 0)
              const currency = String(t.currency || '')
              const status = String(t.status || '')
              const created_at = String(t.created_at || t.date || '')
              const card_id = String(t.card_id || '')
              const last4 = String(t.last_four_digits || t.card_last4 || '')
              if (!id) continue
              await new Promise((resolve, reject)=>{
                  sdb.run(`INSERT OR REPLACE INTO adpos_transactions (id, amount, currency, status, created_at, card_id, last_four_digits) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, amount, currency, status, created_at, card_id, last4], (err)=> (err?reject(err):resolve()))
              })
              saved++
          }
          await new Promise(r=>sdb.close(r))
          return res.json({ success: true, saved })
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
      }
  })
  _app.get('/api/adpos/prefs', async (req, res) => {
      try {
          const pid = String((req.query && (req.query.profileId || req.query.pid)) || '')
          const sdb = new sqlite3.Database(_dbPath)
          await ensureAdposPrefs(sdb)
          const row = await new Promise((resolve)=>{
              sdb.get(`SELECT profile_id, auto_refresh, auto_save_local FROM adpos_prefs WHERE profile_id = ?`, [pid], (err, r)=> resolve(err?null:(r||null)))
          })
          await new Promise(r=>sdb.close(r))
          const data = row ? { profileId: String(row.profile_id||''), auto_refresh: !!Number(row.auto_refresh||0), auto_save_local: !!Number(row.auto_save_local||0) } : { profileId: pid, auto_refresh: false, auto_save_local: false }
          return res.json({ success: true, data })
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
      }
  })
  _app.post('/api/adpos/prefs', async (req, res) => {
      try {
          const body = req.body || {}
          const pid = String(body.profileId || body.pid || '')
          const auto_refresh = body.auto_refresh ? 1 : 0
          const auto_save_local = body.auto_save_local ? 1 : 0
          if (!pid) return res.status(400).json({ success: false, message: 'missing_profileId' })
          const sdb = new sqlite3.Database(_dbPath)
          await ensureAdposPrefs(sdb)
          await new Promise((resolve, reject)=>{
              sdb.run(`INSERT OR REPLACE INTO adpos_prefs (profile_id, auto_refresh, auto_save_local, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, [pid, auto_refresh, auto_save_local], (err)=> (err?reject(err):resolve()))
          })
          await new Promise(r=>sdb.close(r))
          return res.json({ success: true })
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
      }
  })

  _app.get('/api/adpos/extract-code', async (req, res) => {
      try {
          const last4 = String(req.query.last4 || '').replace(/\D/g,'');
          const tokenParam = String(req.query.token || '');
          const base = String(req.query.baseUrl || 'https://api.adpos.io').replace(/\/$/, '');
          if (!last4 || last4.length !== 4) return res.status(400).json({ success: false, message: 'invalid_last4' });
          let token = tokenParam;
          if (!token) {
              try {
                  const r = await _tokenProvider.requestPaymentManagementToken({ profileId: '', adAccountId: '' });
                  token = String(r && r.token || '');
              } catch {}
          }
          if (!token) return res.status(400).json({ success: false, message: 'missing_token' });
          const nowSec = Math.floor(Date.now()/1000);
          const startSec = nowSec - 31*24*60*60;
          const url = `${base}/v2/cards/transactions?start_timestamp=${startSec}&end_timestamp=${nowSec}&per_page=200&page=1`;
          const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
          const json = await resp.json().catch(()=>({}));
          const arr = Array.isArray(json && json.data) ? json.data : [];
          const take = arr.filter(it => {
              const l4 = String((it && (it.last_four_digits || it.card_last4 || (it.card_number ? String(it.card_number).slice(-4) : ''))) || '').replace(/\D/g,'');
              return l4 === last4;
          }).sort((a,b)=>{
              const ta = Number(a && (a.transaction_unix_timestamp || (Date.parse(String(a.created_at||a.date||''))||0)));
              const tb = Number(b && (b.transaction_unix_timestamp || (Date.parse(String(b.created_at||b.date||''))||0)));
              return tb - ta;
          });
          let code = '';
          let merchant = '';
          for (const it of take) {
              const name = String((it && (it.merchant_name || it.merchant || it.description)) || '').toUpperCase();
              const m = name.match(/METAPAY\*([A-Z0-9]{4})/i) || name.match(/\bFB[-\s]*([A-Z0-9]{4})\b/i) || (name.includes('FB.ME/CC') ? name.match(/\b([A-Z0-9]{4})\b/) : null) || name.match(/FACEBK\s.*?\b([A-Z0-9]{4})\b/i);
              if (m && m[1]) { code = String(m[1]); merchant = String(it && (it.merchant_name || it.description || '') || ''); break; }
          }
          return res.json({ success: !!code, last4, code, merchant, count: take.length, meta: json && json.meta || null });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) });
      }
  });

  _app.get('/api/adpos/account', async (req, res) => {
      try {
          const { profileId, token } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          const r = await _adposClient.getAccount({ profileId, token });
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.get('/api/adpos/cards', async (req, res) => {
      try {
          const { profileId, token, page, per_page } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          const r = await _adposClient.listCards({ profileId, token, page, per_page });
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.get('/api/adpos/cards/all', async (req, res) => {
      try {
          const { profileId, token, per_page } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          const r = await _adposClient.listAllCards({ profileId, token, per_page });
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.post('/api/adpos/proxy', async (req, res) => {
      try {
          const { profileId, token, method, path, query, payload } = req.body || {};
          const m = String(method || 'GET').toUpperCase();
          if (!/^GET|POST|PATCH|PUT|DELETE$/.test(m)) {
              return res.status(400).json({ success: false, message: 'invalid_method' });
          }
          const p = String(path || '');
          if (!p || !p.startsWith('/')) {
              return res.status(400).json({ success: false, message: 'invalid_path' });
          }
          const r = await _adposClient.request({ profileId, token, method: m, path: p, query: query || {}, body: payload });
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.get('/api/adpos/token', async (req, res) => {
      try {
          const { profileId, forceRefresh } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          const t = await _adposClient.getToken(String(profileId || ''), !!forceRefresh);
          return res.json({ success: !!t, token: t });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.post('/api/adpos/access-token', async (req, res) => {
      try {
          const { email, password, baseUrl } = req.body || {};
          const base = (String(baseUrl || process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io')).replace(/\/$/, '');
          if (!email || !password) {
              return res.status(400).json({ success: false, message: 'missing_credentials' });
          }
          const url = `${base}/auth/access-token`;
          const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
          const json = await resp.json().catch(()=>({}));
          const data = json && json.data ? json.data : json;
          const token = data && data.access_token ? String(data.access_token) : '';
          const type = data && data.token_type ? String(data.token_type) : '';
          return res.json({ success: !!token, status: resp.status, token, token_type: type || 'Bearer', raw: data });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.get('/api/adpos/transactions', async (req, res) => {
      try {
          const { profileId, token, page, per_page, start_timestamp, end_timestamp, status, card_number, alias } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          const r = await _adposClient.listTransactions({ profileId, token, page, per_page, start_timestamp, end_timestamp, status, card_number, alias });
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.get('/api/adpos/transactions/all', async (req, res) => {
      try {
          const { per_page, start_timestamp, end_timestamp, status } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          const r = await _adposClient.listAllTransactions({ per_page, start_timestamp, end_timestamp, status });
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.get('/api/adpos/transactions/by-card', async (req, res) => {
      try {
          const { card_id, page, per_page, start_timestamp, end_timestamp, status } = (req.query && Object.keys(req.query).length ? req.query : req.body) || {};
          if (!card_id) return res.status(400).json({ success: false, message: 'missing card_id' });
          const r = await _adposClient.listTransactionsByCard({ card_id, page, per_page, start_timestamp, end_timestamp, status });
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });

  _app.post('/api/adpos/transfers', async (req, res) => {
      try {
          const { profileId, token, payload } = req.body || {};
          const r = await _adposClient.createTransfer({ profileId, token, payload });
          return res.json({ success: r.ok, status: r.status, data: r.data, meta: r.meta || null, error: r.error || null, status_code: r.status_code });
      } catch (e) {
          return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
      }
  });
}

module.exports = { __inject, registerRoutes, ensureAdposPrefs };
