const express = require('express')
const cors = require('cors')
const path = require('path')
const sqlite3 = require('sqlite3').verbose()
const https = require('https')
const net = require('net')
const tokenProvider = require('./payment/token-provider')
require('dotenv').config()

const app = express()
app.use(cors())

// 🚀 核心优化：专门为同步接口提供原始文本处理，必须放在 express.json 之前
// 这样可以彻底避开 express.json 对部分 malformed JSON 的全局拦截报错
app.post('/api/fb-api/sync-cookies', express.text({ type: '*/*', limit: '10mb' }), async (req, res) => {
  let body;
  try {
    const rawBody = req.body;
    if (typeof rawBody !== 'string') {
      console.warn(`[${new Date().toISOString()}] [WARN] Sync called with non-string body: type=${typeof rawBody}`);
      body = rawBody;
    } else {
      console.log(`[${new Date().toISOString()}] [DEBUG] Sync raw body length: ${rawBody.length} snippet: ${rawBody.substring(0, 50)}`);
      body = JSON.parse(rawBody);
    }
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] [WARN] JSON manual parse failed: ${e.message}. Body snippet: ${String(req.body).substring(0, 100)}`);
    return res.status(400).json({ success: false, message: 'invalid_json_format' });
  }

  const { profileId, cookies } = body || {};
  const cleanPid = String(profileId || '').trim();
  if (!cleanPid) return res.status(400).json({ success: false, message: 'missing_profileId' });
  
  const raw = typeof cookies === 'string' ? cookies : JSON.stringify(cookies || []);
  const db = new sqlite3.Database(dbPath);
  try {
    const row = await new Promise((resolve, reject) => {
      const isNumeric = /^\d+$/.test(cleanPid);
      if (isNumeric) {
        db.get(`SELECT rowid as id FROM profiles WHERE rowid = ? OR id = ? OR ext_id = ? ORDER BY (CASE WHEN rowid = ? THEN 0 WHEN id = ? THEN 1 ELSE 2 END) LIMIT 1`, [cleanPid, cleanPid, cleanPid, cleanPid, cleanPid], (err, r) => (err ? reject(err) : resolve(r || null)));
      } else {
        db.get(`SELECT rowid as id FROM profiles WHERE id = ? OR ext_id = ? ORDER BY (CASE WHEN id = ? THEN 0 ELSE 1 END) LIMIT 1`, [cleanPid, cleanPid, cleanPid], (err, r) => (err ? reject(err) : resolve(r || null)));
      }
    });

    if (row) {
      await new Promise((resolve, reject) => {
        db.run(`UPDATE profiles SET account_cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE rowid = ?`, [raw, row.id], function(err) {
          if (err) return reject(err);
          if (this.changes > 0) process.stdout.write(`[${new Date().toISOString()}] [INFO] ✅ Updated cookies for profile: pid=${cleanPid} len=${raw.length}\n`);
          resolve(null);
        });
      });
      return res.json({ success: true, updated: true, internalId: row.id });
    } else {
      await new Promise((resolve, reject) => {
        db.run(`INSERT INTO profiles (ext_id, name, account_cookies, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, [cleanPid, cleanPid, raw], err => (err ? reject(err) : resolve(null)))
      });
      process.stdout.write(`[${new Date().toISOString()}] [INFO] 🆕 Created profile for sync: ext_id=${cleanPid}\n`);
      return res.json({ success: true, created: true });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) });
  } finally {
    db.close();
  }
});

app.use(express.json({ limit: '10mb' }))

// 🚀 诊断点：捕获 JSON 解析错误并记录原始信息
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    try {
      process.stdout.write(`[${new Date().toISOString()}] [ERROR] JSON Parse Error: ${err.message}. Path: ${req.path}\n`);
      // 如果能获取到部分内容，记录下来
      if (err.body) process.stdout.write(`[${new Date().toISOString()}] [DEBUG] Faulty Body Snippet: ${String(err.body).substring(0, 100)}\n`);
    } catch {}
    return res.status(400).send({ success: false, message: 'invalid_json_body' });
  }
  next();
});

app.disable('etag')
app.use((req, res, next) => {
  try {
    if (String(req.path || '').startsWith('/api/')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.set('Pragma', 'no-cache')
      res.set('Expires', '0')
    }
  } catch {}
  next()
})

// Puppeteer API proxy (same-origin bridge)
const forwardJson = (targetHost, targetPort, targetPath, method, bodyObj) => new Promise((resolve, reject) => {
  try {
    const http = require('http')
    const data = JSON.stringify(bodyObj || {})
    const opt = { hostname: targetHost, port: targetPort, path: targetPath, method: method || 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }
    const rq = http.request(opt, (resp) => { let raw=''; resp.on('data', d=>raw+=d); resp.on('end', ()=>{ try { resolve(JSON.parse(raw)) } catch { resolve({ success: false, status: resp.statusCode || 0 }) } }) })
    rq.on('error', reject); rq.write(data); rq.end()
  } catch (e) { reject(e) }
})

const fetchDeepSeek = (bodyObj, apiKey) => new Promise((resolve, reject) => {
  try {
    const data = JSON.stringify(bodyObj);
    const options = {
      hostname: 'api.deepseek.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 60000
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          resolve({ error: 'Invalid JSON response', raw });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  } catch (e) { reject(e); }
});

app.post('/api/ai/chat', async (req, res) => {
  const { messages } = req.body || {};
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: '未配置 DEEPSEEK_API_KEY 环境变量' });
  }

  const db = new sqlite3.Database(dbPath);
  try {
    // 获取配置上下文以辅助 AI
    const profiles = await new Promise((resolve, reject) => {
      db.all(`SELECT rowid as id, name, platform FROM profiles LIMIT 50`, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });

    const systemPrompt = `你是一个 OmniFingerprint 浏览器管理系统的智能助手。
你可以帮助用户管理浏览器配置、启动浏览器、查询状态等。
当前系统中的配置列表如下：
${profiles.map(p => `- ID: ${p.id}, 名称: ${p.name}, 平台: ${p.platform}`).join('\n')}

你可以使用 launch_browser(profileId) 函数来启动指定的浏览器。
请用简洁、专业的中文回答用户。如果是执行指令，请在回复中告知用户。`;

    const deepseekBody = {
      model: 'deepseek-reasoner',
      messages: [
        { role: 'system', content: systemPrompt },
        ...(messages || [])
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'launch_browser',
            description: '启动指定的浏览器配置',
            parameters: {
              type: 'object',
              properties: {
                profileId: { type: 'string', description: '配置的 ID (rowid)' }
              },
              required: ['profileId']
            }
          }
        }
      ]
    };

    const data = await fetchDeepSeek(deepseekBody, apiKey);
    
    if (data.error) {
      return res.status(500).json({ success: false, error: data.error.message || data.error });
    }

    if (data.choices && data.choices[0]) {
      const message = data.choices[0].message;
      res.json({
        success: true,
        message: message.content,
        reasoning: message.reasoning_content,
        toolCalls: message.tool_calls ? message.tool_calls.map(tc => ({
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments)
        })) : []
      });
    } else {
      res.status(500).json({ success: false, error: 'DeepSeek 返回数据异常', raw: data });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: String(error.message || error) });
  } finally {
    db.close();
  }
});

app.post('/api/puppeteer/launch-browser', async (req, res) => {
  try { const r = await forwardJson('127.0.0.1', 9999, '/api/launch-browser', 'POST', req.body || {}); return res.json(r) } catch (e) { return res.status(502).json({ success: false, message: 'puppeteer_unavailable', error: String(e && e.message || e) }) }
})
app.post('/api/puppeteer/stop-browser', async (req, res) => {
  try { const r = await forwardJson('127.0.0.1', 9999, '/api/stop-browser', 'POST', req.body || {}); return res.json(r) } catch (e) { return res.status(502).json({ success: false, message: 'puppeteer_unavailable', error: String(e && e.message || e) }) }
})
app.post('/api/puppeteer/facebook/billing/verify-click', async (req, res) => { return res.status(403).json({ success: false, message: 'disabled' }) })
app.post('/api/puppeteer/facebook/billing/verify-fill', async (req, res) => { return res.status(403).json({ success: false, message: 'disabled' }) })

// console.log = () => {}
// console.debug = () => {}

const PORT = Number(process.env.STORAGE_PORT || 7070)
const CUSTOM_DB = process.env.STORAGE_DB_PATH || process.env.STORAGE_DB_FILE
const dbPath = CUSTOM_DB
  ? (path.isAbsolute(CUSTOM_DB) ? CUSTOM_DB : path.join(__dirname, 'data', CUSTOM_DB))
  : path.join(__dirname, 'data', 'omnifingerprint.db')
try {
  const dir = path.dirname(dbPath)
  require('fs').mkdirSync(dir, { recursive: true })
} catch {}

function ensureProfilesTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT,
        platform TEXT,
        account_name TEXT,
        account_email TEXT,
        account_password TEXT,
        account TEXT,
        start_url TEXT,
        user_agent TEXT,
        proxy TEXT,
        proxy_enabled INTEGER,
        proxy_type TEXT,
        proxy_host TEXT,
        proxy_port TEXT,
        proxy_username TEXT,
        proxy_password TEXT,
        account_notes TEXT,
        account_tokens TEXT,
        account_cookies TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

async function ensureProfilesColumns(db) {
  await ensureProfilesTable(db)
  await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(profiles)`, (e, rows) => {
      if (e) return reject(e)
      const names = new Set((rows || []).map(r => String(r.name)))
      const ops = []
      if (!names.has('account_name')) ops.push(`ALTER TABLE profiles ADD COLUMN account_name TEXT`)
      if (!names.has('account_status')) ops.push(`ALTER TABLE profiles ADD COLUMN account_status TEXT`)
      if (!names.has('seq')) ops.push(`ALTER TABLE profiles ADD COLUMN seq INTEGER`)
      if (!names.has('ext_id')) ops.push(`ALTER TABLE profiles ADD COLUMN ext_id TEXT`)
      if (!names.has('platform')) ops.push(`ALTER TABLE profiles ADD COLUMN platform TEXT`)
      if (!names.has('pages_count')) ops.push(`ALTER TABLE profiles ADD COLUMN pages_count INTEGER DEFAULT 0`)
      if (!names.has('bm_count')) ops.push(`ALTER TABLE profiles ADD COLUMN bm_count INTEGER DEFAULT 0`)
      if (!names.has('pixels_count')) ops.push(`ALTER TABLE profiles ADD COLUMN pixels_count INTEGER DEFAULT 0`)
      if (!names.has('account_tokens')) ops.push(`ALTER TABLE profiles ADD COLUMN account_tokens TEXT`)
      if (!names.has('account_cookies')) ops.push(`ALTER TABLE profiles ADD COLUMN account_cookies TEXT`)
      if (!names.has('account_notes')) ops.push(`ALTER TABLE profiles ADD COLUMN account_notes TEXT`)
      if (!names.has('startup_urls')) ops.push(`ALTER TABLE profiles ADD COLUMN startup_urls TEXT`)
      if (!names.has('os')) ops.push(`ALTER TABLE profiles ADD COLUMN os TEXT`)
      if (!names.has('resolution')) ops.push(`ALTER TABLE profiles ADD COLUMN resolution TEXT`)
      if (!names.has('timezone')) ops.push(`ALTER TABLE profiles ADD COLUMN timezone TEXT`)
      if (!names.has('language')) ops.push(`ALTER TABLE profiles ADD COLUMN language TEXT`)
      if (!names.has('fb_language')) ops.push(`ALTER TABLE profiles ADD COLUMN fb_language TEXT DEFAULT 'en_US'`)
      if (!names.has('fingerprint_protection')) ops.push(`ALTER TABLE profiles ADD COLUMN fingerprint_protection TEXT`)
      
      let i = 0
      const runNext = () => {
        if (i >= ops.length) return resolve(null)
        db.run(ops[i++], err => {
          if (err) console.error('Migration error:', err);
          runNext()
        })
      }
      runNext()
    })
  })
  await new Promise((resolve) => {
    try {
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_seq ON profiles(seq)`, () => resolve())
    } catch {
      resolve()
    }
  })
  // 🚀 核心修复：确保 ext_id 唯一索引存在，否则 ON CONFLICT(ext_id) 会失败
  await new Promise((resolve) => {
    try {
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_ext_id ON profiles(ext_id)`, () => resolve())
    } catch {
      resolve()
    }
  })
  await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(profiles)`, async (e, rows) => {
      if (e) return reject(e)
      const idCol = Array.isArray(rows) ? rows.find(r => String(r.name) === 'id') : null
      const hasExtId = Array.isArray(rows) && rows.some(r => String(r.name) === 'ext_id')
      const idIsText = !!idCol && String(idCol.type || '').toUpperCase().includes('TEXT')
      if (idIsText && !hasExtId) {
        try {
          await new Promise((res, rej) => {
            db.run(
              `CREATE TABLE IF NOT EXISTS profiles_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ext_id TEXT UNIQUE,
                name TEXT,
                platform TEXT,
                account_name TEXT,
                account_email TEXT,
                account_password TEXT,
                account TEXT,
                start_url TEXT,
                user_agent TEXT,
                proxy TEXT,
                proxy_enabled INTEGER,
                proxy_type TEXT,
                proxy_host TEXT,
                proxy_port TEXT,
                proxy_username TEXT,
                proxy_password TEXT,
                account_notes TEXT,
                account_tokens TEXT,
                account_cookies TEXT,
                account_status TEXT,
                startup_urls TEXT,
                seq INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )`, err => (err ? rej(err) : res())
            )
          })
          const oldRows = await new Promise((res, rej) => {
            db.all(`SELECT * FROM profiles`, (err, rs) => (err ? rej(err) : res(rs || [])))
          })
          for (const r of oldRows) {
            const args = [
              String(r.id || ''),
              String(r.name || ''),
              String(r.platform || ''),
              String(r.account_name || ''),
              String(r.account_email || ''),
              String(r.account_password || ''),
              String(r.account || ''),
              String(r.start_url || ''),
              String(r.user_agent || ''),
              String(r.proxy || ''),
              Number(r.proxy_enabled || 0),
              String(r.proxy_type || ''),
              String(r.proxy_host || ''),
              String(r.proxy_port || ''),
              String(r.proxy_username || ''),
              String(r.proxy_password || ''),
              String(r.account_notes || ''),
              String(r.account_tokens || ''),
              String(r.account_cookies || ''),
              String(r.account_status || ''),
              String(r.startup_urls || ''),
              typeof r.seq === 'number' ? r.seq : null
            ]
            await new Promise((res, rej) => {
              db.run(
                `INSERT INTO profiles_new (
                  ext_id, name, platform, account_name, account_email, account_password,
                  account, start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host, proxy_port,
                  proxy_username, proxy_password, account_notes, account_tokens, account_cookies, account_status, startup_urls, seq, updated_at
                ) VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                )`, args, err => (err ? rej(err) : res())
              )
            })
          }
          await new Promise((res, rej) => { db.run(`ALTER TABLE profiles RENAME TO profiles_backup`, err => (err ? rej(err) : res())) })
          await new Promise((res, rej) => { db.run(`ALTER TABLE profiles_new RENAME TO profiles`, err => (err ? rej(err) : res())) })
          await new Promise((res) => { try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_ext_id ON profiles(ext_id)`, () => res()) } catch { res() } })
          resolve()
        } catch (err) {
          reject(err)
        }
      } else {
        resolve()
      }
    })
  })
}

function ensureAdAccountsTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS ad_accounts (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        platform TEXT,
        account_id TEXT,
        name TEXT,
        status TEXT,
        currency TEXT,
        timezone_id TEXT,
        spend REAL,
        country TEXT,
        threshold_amount REAL,
        credit_limit REAL,
        balance REAL,
        funding_source TEXT,
        account TEXT,
        profile_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

async function ensureAdAccountsColumns(db) {
  await ensureAdAccountsTable(db)
  await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(ad_accounts)`, (e, rows) => {
      if (e) return reject(e)
      const names = new Set((rows || []).map(r => String(r.name)))
      const ops = []
      if (!names.has('country')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN country TEXT`)
      if (!names.has('threshold_amount')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN threshold_amount REAL`)
      if (!names.has('credit_limit')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN credit_limit REAL`)
      if (!names.has('balance')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN balance REAL`)
      if (!names.has('funding_source')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN funding_source TEXT`)
      if (!names.has('account')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN account TEXT`)
      if (!names.has('profile_name')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN profile_name TEXT`)
      if (!names.has('pages_count')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN pages_count INTEGER`)
      if (!names.has('bm_count')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN bm_count INTEGER`)
      if (!names.has('pixels_count')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN pixels_count INTEGER`)
      
      let i = 0
      const runNext = () => { 
        if (i >= ops.length) return resolve(null)
        db.run(ops[i++], err => {
           if (err) console.error('Migration error:', err);
           runNext()
        }) 
      }
      runNext()
    })
  })
}

function ensureAdInsightsTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS ad_insights (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        account_id TEXT,
        level TEXT,
        date_preset TEXT,
        metrics TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

function ensureAdsTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS ads (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        profile_id TEXT,
        ad_id TEXT,
        name TEXT,
        status TEXT,
        account_id TEXT,
        campaign_id TEXT,
        campaign_name TEXT,
        adset_id TEXT,
        adset_name TEXT,
        creative_id TEXT,
        preview_url TEXT,
        targeting TEXT,
        creative_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

function ensurePixelsTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS pixels (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        profile_id TEXT,
        pixel_id TEXT,
        name TEXT,
        status TEXT,
        account_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

function ensurePagesTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        page_id TEXT,
        name TEXT,
        fan_count INTEGER,
        link TEXT,
        category TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

function ensureAdposTables(db){
  return new Promise((resolve)=>{
    db.serialize(()=>{
      db.run(`CREATE TABLE IF NOT EXISTS adpos_cards (id TEXT PRIMARY KEY, alias TEXT, last_four_digits TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
      db.run(`CREATE TABLE IF NOT EXISTS adpos_transactions (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        account_id TEXT,
        transaction_id INTEGER,
        transaction_unix_timestamp INTEGER,
        card_number TEXT,
        alias TEXT,
        username TEXT,
        merchant_name TEXT,
        billing_amount REAL,
        billing_currency TEXT,
        status TEXT,
        transaction_type TEXT,
        billing_status TEXT,
        transaction_amount REAL,
        transaction_currency TEXT,
        transaction_country TEXT,
        last_four_digits TEXT,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, [], ()=>resolve())
    })
  })
}
function ensureAdposPrefs(db){
  return new Promise((resolve)=>{
    db.serialize(()=>{
      db.run(`CREATE TABLE IF NOT EXISTS adpos_prefs (
        profile_id TEXT PRIMARY KEY,
        auto_refresh INTEGER,
        auto_save_local INTEGER,
        auto_refresh_hours INTEGER,
        auto_refresh_minutes INTEGER,
        auto_refresh_seconds INTEGER,
        auto_save_hours INTEGER,
        auto_save_minutes INTEGER,
        auto_save_seconds INTEGER,
        last_refresh_at DATETIME,
        last_save_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, [], ()=>{
        db.all(`PRAGMA table_info(adpos_prefs)`, (e, rows)=>{
          const names = new Set((rows||[]).map(r => String(r.name)))
          const ops = []
          if (!names.has('auto_refresh_hours')) ops.push(`ALTER TABLE adpos_prefs ADD COLUMN auto_refresh_hours INTEGER`)
          if (!names.has('auto_refresh_minutes')) ops.push(`ALTER TABLE adpos_prefs ADD COLUMN auto_refresh_minutes INTEGER`)
          if (!names.has('auto_refresh_seconds')) ops.push(`ALTER TABLE adpos_prefs ADD COLUMN auto_refresh_seconds INTEGER`)
          if (!names.has('auto_save_hours')) ops.push(`ALTER TABLE adpos_prefs ADD COLUMN auto_save_hours INTEGER`)
          if (!names.has('auto_save_minutes')) ops.push(`ALTER TABLE adpos_prefs ADD COLUMN auto_save_minutes INTEGER`)
          if (!names.has('auto_save_seconds')) ops.push(`ALTER TABLE adpos_prefs ADD COLUMN auto_save_seconds INTEGER`)
          if (!names.has('last_refresh_at')) ops.push(`ALTER TABLE adpos_prefs ADD COLUMN last_refresh_at DATETIME`)
          if (!names.has('last_save_at')) ops.push(`ALTER TABLE adpos_prefs ADD COLUMN last_save_at DATETIME`)
          let i=0; const runNext=()=>{ if(i>=ops.length) return resolve(null); db.run(ops[i++], ()=> runNext()) }
          runNext()
        })
      })
    })
  })
}
app.post('/api/adpos/transactions/save-batch', async (req, res) => {
  try {
    const items = (req.body && (req.body.items || req.body.data || req.body)) || []
    const list = Array.isArray(items) ? items : []
    if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
    const db = new sqlite3.Database(dbPath)
    try {
      await ensureAdposTables(db)
      await ensureAdposTransactionsColumns(db)
      let saved = 0
      for (const t of list) {
        const rid = String(t.id || '')
        if (!rid) continue
        const args = [
          rid,
          null,
          null,
          (typeof t.id === 'number' ? t.id : (typeof t.transaction_id === 'number' ? t.transaction_id : null)),
          (typeof t.transaction_unix_timestamp === 'number' ? t.transaction_unix_timestamp : null),
          t.card_number || null,
          t.alias || null,
          t.username || null,
          t.merchant_name || null,
          (typeof t.billing_amount === 'number' ? t.billing_amount : null),
          t.billing_currency || null,
          t.status || null,
          t.transaction_type || null,
          t.billing_status || null,
          (typeof t.transaction_amount === 'number' ? t.transaction_amount : null),
          t.transaction_currency || null,
          t.transaction_country || null,
          (t.last_four_digits || t.card_last4 || (t.card_number ? String(t.card_number).slice(-4) : null)) || null,
          JSON.stringify(t || {})
        ]
        await new Promise((resolve, reject)=>{ db.run(`INSERT OR REPLACE INTO adpos_transactions (
          id, profile_id, account_id, transaction_id, transaction_unix_timestamp, card_number, alias, username,
          merchant_name, billing_amount, billing_currency, status, transaction_type, billing_status,
          transaction_amount, transaction_currency, transaction_country, last_four_digits, raw_json, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
        )`, args, err => (err ? reject(err) : resolve())) })
        saved++
      }
      res.json({ success: true, saved })
    } catch (e) {
      res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
    } finally { db.close() }
  } catch (e) {
    res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
  }
})
app.get('/api/adpos/prefs', async (req, res) => {
  try {
    const pid = String((req.query && (req.query.profileId || req.query.pid)) || '')
    const db = new sqlite3.Database(dbPath)
    try {
      await ensureAdposPrefs(db)
      const row = await new Promise((resolve)=>{ db.get(`SELECT profile_id, auto_refresh, auto_save_local, auto_refresh_hours, auto_refresh_minutes, auto_refresh_seconds, auto_save_hours, auto_save_minutes, auto_save_seconds, last_refresh_at, last_save_at FROM adpos_prefs WHERE profile_id = ?`, [pid], (err, r)=> resolve(err?null:(r||null))) })
      const data = row ? {
        profileId: String(row.profile_id||''),
        auto_refresh: !!Number(row.auto_refresh||0),
        auto_save_local: !!Number(row.auto_save_local||0),
        auto_refresh_hours: Number(row.auto_refresh_hours||0),
        auto_refresh_minutes: Number(row.auto_refresh_minutes||0),
        auto_refresh_seconds: Number(row.auto_refresh_seconds||0),
        auto_save_hours: Number(row.auto_save_hours||0),
        auto_save_minutes: Number(row.auto_save_minutes||0),
        auto_save_seconds: Number(row.auto_save_seconds||0),
        last_refresh_at: row.last_refresh_at || null,
        last_save_at: row.last_save_at || null
      } : {
        profileId: pid,
        auto_refresh: false,
        auto_save_local: false,
        auto_refresh_hours: 0,
        auto_refresh_minutes: 0,
        auto_refresh_seconds: 0,
        auto_save_hours: 0,
        auto_save_minutes: 0,
        auto_save_seconds: 0,
        last_refresh_at: null,
        last_save_at: null
      }
      res.json({ success: true, data })
    } catch (e) { res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) }) }
    finally { db.close() }
  } catch (e) { res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) }) }
})
app.post('/api/adpos/prefs', async (req, res) => {
  try {
    const body = req.body || {}
    const pid = String(body.profileId || body.pid || '')
    const auto_refresh = body.auto_refresh ? 1 : 0
    const auto_save_local = body.auto_save_local ? 1 : 0
    const arh = Math.max(0, Number(body.auto_refresh_hours || 0))
    const arm = Math.max(0, Number(body.auto_refresh_minutes || 0))
    const ars = Math.max(0, Number(body.auto_refresh_seconds || 0))
    const ash = Math.max(0, Number(body.auto_save_hours || 0))
    const asm = Math.max(0, Number(body.auto_save_minutes || 0))
    const ass = Math.max(0, Number(body.auto_save_seconds || 0))
    if (!pid) return res.status(400).json({ success: false, message: 'missing_profileId' })
    const db = new sqlite3.Database(dbPath)
    try {
      await ensureAdposPrefs(db)
      await new Promise((resolve, reject)=>{ db.run(`INSERT OR REPLACE INTO adpos_prefs (
        profile_id, auto_refresh, auto_save_local, auto_refresh_hours, auto_refresh_minutes, auto_refresh_seconds,
        auto_save_hours, auto_save_minutes, auto_save_seconds, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      )`, [pid, auto_refresh, auto_save_local, arh, arm, ars, ash, asm, ass], err => (err ? reject(err) : resolve())) })
      res.json({ success: true })
    } catch (e) { res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) }) }
    finally { db.close() }
  } catch (e) { res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) }) }
})

// 自动拉取外部交易并保存到数据库（基于偏好设置）
;(function startAdposAutoScheduler(){
  try {
    const lastRun = new Map()
    const tick = async () => {
      try {
        const db = new sqlite3.Database(dbPath)
        await ensureAdposPrefs(db)
        const prefs = await new Promise((resolve, reject)=>{
          db.all(`SELECT profile_id, auto_refresh, auto_save_local, auto_refresh_hours, auto_refresh_minutes, auto_refresh_seconds FROM adpos_prefs WHERE auto_refresh = 1`, (err, rows)=> (err?reject(err):resolve(rows||[])))
        })
        db.close()
        const base = String(process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io').replace(/\/$/, '')
        for (const p of prefs) {
          const pid = String(p.profile_id||'')
          const intervalMs = ((Number(p.auto_refresh_hours||0)*3600 + Number(p.auto_refresh_minutes||0)*60 + Number(p.auto_refresh_seconds||0)) || 3600) * 1000
          const last = Number(lastRun.get(pid)||0)
          const now = Date.now()
          if (now - last < intervalMs) continue
          lastRun.set(pid, now)
          let token = ''
          try { const r = await tokenProvider.requestPaymentManagementToken({ profileId: '', adAccountId: '' }); token = String(r && r.token || '') } catch {}
          if (!token) continue
          const endSec = Math.floor(now/1000)
          const startSec = Math.max(0, endSec - Math.floor(intervalMs/1000))
          const urlHost = base.replace(/^https?:\/\//,'')
          const isHttps = base.startsWith('https://')
          const pathListV2 = `/v2/cards/transactions/list?start_timestamp=${startSec}&end_timestamp=${endSec}&per_page=200&page=1`
          const pathV2 = `/v2/cards/transactions?start_timestamp=${startSec}&end_timestamp=${endSec}&per_page=200&page=1`
          const pathApiListV2 = `/api/v2/cards/transactions/list?start_timestamp=${startSec}&end_timestamp=${endSec}&per_page=200&page=1`
          const pathApiV2 = `/api/v2/cards/transactions?start_timestamp=${startSec}&end_timestamp=${endSec}&per_page=200&page=1`
          const pathLegacy = `/transactions?start_timestamp=${startSec}&end_timestamp=${endSec}&per_page=200&page=1`
          const fetchJson = () => new Promise((resolve, reject) => {
            const lib = isHttps ? require('https') : require('http')
            const req = lib.request({ hostname: urlHost, path: pathListV2, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, resp => {
              let data = ''
              resp.on('data', c => { data += c })
              resp.on('end', () => {
                try { const j = JSON.parse(data); if (j && j.data) return resolve(j) } catch {}
                const reqV2 = lib.request({ hostname: urlHost, path: pathV2, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respV2 => {
                  let d2 = ''
                  respV2.on('data', c => { d2 += c })
                  respV2.on('end', () => {
                    try { const j2 = JSON.parse(d2); if (j2 && j2.data) return resolve(j2) } catch {}
                    const reqApiList = lib.request({ hostname: urlHost, path: pathApiListV2, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respApiList => {
                      let d3 = ''
                      respApiList.on('data', c => { d3 += c })
                      respApiList.on('end', () => {
                        try { const j3 = JSON.parse(d3); if (j3 && j3.data) return resolve(j3) } catch {}
                        const reqApi = lib.request({ hostname: urlHost, path: pathApiV2, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respApi => {
                          let d4 = ''
                          respApi.on('data', c => { d4 += c })
                          respApi.on('end', () => {
                            try { const j4 = JSON.parse(d4); if (j4 && j4.data) return resolve(j4) } catch {}
                            const req2 = lib.request({ hostname: urlHost, path: pathLegacy, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, resp2 => {
                              let d5 = ''
                              resp2.on('data', c => { d5 += c })
                              resp2.on('end', () => { try { resolve(JSON.parse(d5)) } catch { resolve({}) } })
                            }); req2.on('error', reject); req2.end()
                          })
                        }); reqApi.on('error', reject); reqApi.end()
                      })
                    }); reqApiList.on('error', reject); reqApiList.end()
                  })
                }); reqV2.on('error', reject); reqV2.end()
              })
            })
            req.on('error', reject); req.end()
          })
          const json = await fetchJson().catch(()=>({}))
          const arr = Array.isArray(json && json.data) ? json.data : []
          if (arr.length) {
            const sdb = new sqlite3.Database(dbPath)
            try {
              await ensureAdposTables(sdb)
              await ensureAdposTransactionsColumns(sdb)
              let saved = 0
              for (const t of arr) {
                const rid = String(t.id || '')
                if (!rid) continue
                const args = [
                  rid,
                  pid || null,
                  null,
                  (typeof t.id === 'number' ? t.id : (typeof t.transaction_id === 'number' ? t.transaction_id : null)),
                  (typeof t.transaction_unix_timestamp === 'number' ? t.transaction_unix_timestamp : null),
                  t.card_number || null,
                  t.alias || null,
                  t.username || null,
                  t.merchant_name || null,
                  (typeof t.billing_amount === 'number' ? t.billing_amount : null),
                  t.billing_currency || null,
                  t.status || null,
                  t.transaction_type || null,
                  t.billing_status || null,
                  (typeof t.transaction_amount === 'number' ? t.transaction_amount : null),
                  t.transaction_currency || null,
                  t.transaction_country || null,
                  (t.last_four_digits || t.card_last4 || (t.card_number ? String(t.card_number).slice(-4) : null)) || null,
                  JSON.stringify(t || {})
                ]
                await new Promise((resolve, reject)=>{ sdb.run(`INSERT OR REPLACE INTO adpos_transactions (
                  id, profile_id, account_id, transaction_id, transaction_unix_timestamp, card_number, alias, username,
                  merchant_name, billing_amount, billing_currency, status, transaction_type, billing_status,
                  transaction_amount, transaction_currency, transaction_country, last_four_digits, raw_json, updated_at
                ) VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                )`, args, err => (err ? reject(err) : resolve())) })
                saved++
              }
              await new Promise((resolve)=>{ sdb.run(`UPDATE adpos_prefs SET last_refresh_at=CURRENT_TIMESTAMP, last_save_at=CURRENT_TIMESTAMP WHERE profile_id=?`, [pid], ()=> resolve(null)) })
            } catch {}
            finally { sdb.close() }
          }
        }
      } catch {}
    }
    setInterval(tick, 60000)
  } catch {}
})()

app.get('/api/adpos/transactions/list-external', async (req, res) => {
  try {
    const base = String(process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io').replace(/\/$/, '')
    let token = String(req.query && req.query.token || '')
    if (!token) {
      try { const r = await tokenProvider.requestPaymentManagementToken({ profileId: '', adAccountId: '' }); token = String(r && r.token || '') } catch {}
    }
    if (!token) return res.status(400).json({ success: false, message: 'missing_token' })
    const startSec = Number(req.query && req.query.start_timestamp || 0)
    const endSec = Number(req.query && req.query.end_timestamp || Math.floor(Date.now()/1000))
    const perPage = Math.min(Number(req.query && req.query.per_page || 200), 200)
    const page = Math.max(Number(req.query && req.query.page || 1), 1)
    const status = String(req.query && req.query.status || '')
    const last4 = String(req.query && req.query.last4 || '')
    const cardId = String(req.query && req.query.card_id || '')
    const filters = `${status?`&status=${encodeURIComponent(status)}`:''}${last4?`&last4=${encodeURIComponent(last4)}`:''}`
    const baseQs = `start_timestamp=${startSec}&end_timestamp=${endSec}&per_page=${perPage}&page=${page}${filters}`
    const pathList1 = cardId ? `/v2/cards/transactions/list?card_id=${encodeURIComponent(cardId)}&${baseQs}` : `/v2/cards/transactions/list?${baseQs}`
    const path1 = cardId ? `/v2/cards/transactions?card_id=${encodeURIComponent(cardId)}&${baseQs}` : `/v2/cards/transactions?${baseQs}`
    const pathListApi = cardId ? `/api/v2/cards/transactions/list?card_id=${encodeURIComponent(cardId)}&${baseQs}` : `/api/v2/cards/transactions/list?${baseQs}`
    const path3 = cardId ? `/api/v2/cards/transactions?card_id=${encodeURIComponent(cardId)}&${baseQs}` : `/api/v2/cards/transactions?${baseQs}`
    const path2 = `/transactions?${baseQs}`
    const host = base.replace(/^https?:\/\//,'')
    const isHttps = base.startsWith('https://')
    const fetchJson = () => new Promise((resolve, reject) => {
      const lib = isHttps ? require('https') : require('http')
      const req2 = lib.request({ hostname: host, path: pathList1, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, resp => {
        let data = ''
        resp.on('data', c => { data += c })
        resp.on('end', () => {
          try { const j = JSON.parse(data); if (j && j.data) return resolve(j) } catch {}
          const reqV2 = lib.request({ hostname: host, path: path1, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respV2 => {
            let d2 = ''
            respV2.on('data', c => { d2 += c })
            respV2.on('end', () => {
              try { const j2 = JSON.parse(d2); if (j2 && j2.data) return resolve(j2) } catch {}
              const reqApiList = lib.request({ hostname: host, path: pathListApi, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respApiList => {
                let d3 = ''
                respApiList.on('data', c => { d3 += c })
                respApiList.on('end', () => {
                  try { const j3 = JSON.parse(d3); if (j3 && j3.data) return resolve(j3) } catch {}
                  const reqApi = lib.request({ hostname: host, path: path3, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respApi => {
                    let d4 = ''
                    respApi.on('data', c => { d4 += c })
                    respApi.on('end', () => {
                      try { const j4 = JSON.parse(d4); if (j4 && j4.data) return resolve(j4) } catch {}
                      const req3 = lib.request({ hostname: host, path: path2, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, resp2 => {
                        let d5 = ''
                        resp2.on('data', c => { d5 += c })
                        resp2.on('end', () => { try { const j5 = JSON.parse(d5); resolve(j5 || {}) } catch { resolve({}) } })
                      }); req3.on('error', reject); req3.end()
                    })
                  }); reqApi.on('error', reject); reqApi.end()
                })
              }); reqApiList.on('error', reject); reqApiList.end()
            })
          }); reqV2.on('error', reject); reqV2.end()
        })
      })
      req2.on('error', reject); req2.end()
    })
    const json = await fetchJson().catch(()=>({}))
    res.json(json || { success: false })
  } catch (e) { res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) }) }
})

app.get('/api/adpos/transactions/fetch-save', async (req, res) => {
  try {
    const base = String(process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io').replace(/\/$/, '')
    let token = String(req.query && req.query.token || '')
    if (!token) {
      try { const r = await tokenProvider.requestPaymentManagementToken({ profileId: '', adAccountId: '' }); token = String(r && r.token || '') } catch {}
    }
    if (!token) return res.status(400).json({ success: false, message: 'missing_token' })
    const startSec = Number(req.query && req.query.start_timestamp || 0)
    const endSec = Number(req.query && req.query.end_timestamp || Math.floor(Date.now()/1000))
    const perPage = Math.min(Number(req.query && req.query.per_page || 200), 200)
    const firstPage = Math.max(Number(req.query && req.query.page || 1), 1)
    const status = String(req.query && req.query.status || '')
    const last4 = String(req.query && req.query.last4 || '')
    const cardId = String(req.query && req.query.card_id || '')
    const maxPages = Math.max(1, Number(req.query && (req.query.max_pages || req.query.maxPages || 50)))
    const filters = `${status?`&status=${encodeURIComponent(status)}`:''}${last4?`&last4=${encodeURIComponent(last4)}`:''}`
    const host = base.replace(/^https?:\/\//,'')
    const isHttps = base.startsWith('https://')
    const fetchPage = (p) => new Promise((resolve, reject) => {
      const lib = isHttps ? require('https') : require('http')
      const qs = `start_timestamp=${startSec}&end_timestamp=${endSec}&per_page=${perPage}&page=${p}${filters}`
      const pathList1 = cardId ? `/v2/cards/transactions/list?card_id=${encodeURIComponent(cardId)}&${qs}` : `/v2/cards/transactions/list?${qs}`
      const path1 = cardId ? `/v2/cards/transactions?card_id=${encodeURIComponent(cardId)}&${qs}` : `/v2/cards/transactions?${qs}`
      const pathListApi = cardId ? `/api/v2/cards/transactions/list?card_id=${encodeURIComponent(cardId)}&${qs}` : `/api/v2/cards/transactions/list?${qs}`
      const path3 = cardId ? `/api/v2/cards/transactions?card_id=${encodeURIComponent(cardId)}&${qs}` : `/api/v2/cards/transactions?${qs}`
      const path2 = `/transactions?${qs}`
      const req2 = lib.request({ hostname: host, path: pathList1, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, resp => {
        let data = ''
        resp.on('data', c => { data += c })
        resp.on('end', () => {
          try { const j = JSON.parse(data); if (j && j.data) return resolve(j) } catch {}
          const reqV2 = lib.request({ hostname: host, path: path1, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respV2 => {
            let d2 = ''
            respV2.on('data', c => { d2 += c })
            respV2.on('end', () => {
              try { const j2 = JSON.parse(d2); if (j2 && j2.data) return resolve(j2) } catch {}
              const reqApiList = lib.request({ hostname: host, path: pathListApi, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respApiList => {
                let d3 = ''
                respApiList.on('data', c => { d3 += c })
                respApiList.on('end', () => {
                  try { const j3 = JSON.parse(d3); if (j3 && j3.data) return resolve(j3) } catch {}
                  const reqApi = lib.request({ hostname: host, path: path3, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, respApi => {
                    let d4 = ''
                    respApi.on('data', c => { d4 += c })
                    respApi.on('end', () => {
                      try { const j4 = JSON.parse(d4); if (j4 && j4.data) return resolve(j4) } catch {}
                      const req3 = lib.request({ hostname: host, path: path2, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }, resp2 => {
                        let d5 = ''
                        resp2.on('data', c => { d5 += c })
                        resp2.on('end', () => { try { const j5 = JSON.parse(d5); resolve(j5 || {}) } catch { resolve({}) } })
                      }); req3.on('error', reject); req3.end()
                    })
                  }); reqApi.on('error', reject); reqApi.end()
                })
              }); reqApiList.on('error', reject); reqApiList.end()
            })
          }); reqV2.on('error', reject); reqV2.end()
        })
      })
      req2.on('error', reject); req2.end()
    })
    let saved = 0
    let currentPage = firstPage
    let totalPages = 0
    const db = new sqlite3.Database(dbPath)
    try {
      await ensureAdposTransactionsTable(db)
      await ensureAdposTransactionsColumns(db)
      for (let i = 0; i < maxPages; i++) {
        const json = await fetchPage(currentPage).catch(()=>({}))
        const arr = Array.isArray(json && json.data) ? json.data : []
        if (json && json.meta && json.meta.pagination && typeof json.meta.pagination.total_pages === 'number') {
          totalPages = Math.max(totalPages, Number(json.meta.pagination.total_pages || 0))
        }
        if (!arr.length) break
        for (const t of arr) {
          const rid = String(t.id || '')
          if (!rid) continue
          const args = [
            rid,
            null,
            null,
            typeof t.id === 'number' ? t.id : (typeof t.transaction_id === 'number' ? t.transaction_id : null),
            Number(t.transaction_unix_timestamp || 0),
            String(t.card_number || ''),
            String(t.alias || ''),
            String(t.username || ''),
            String(t.merchant_name || ''),
            Number(t.billing_amount || 0),
            String(t.billing_currency || ''),
            String(t.status || ''),
            String(t.transaction_type || ''),
            String(t.billing_status || ''),
            Number(t.transaction_amount || 0),
            String(t.transaction_currency || ''),
            String(t.transaction_country || ''),
            String(t.last_four_digits || t.card_last4 || (t.card_number ? String(t.card_number).slice(-4) : '')) || null,
            JSON.stringify(t || {})
          ]
          await new Promise((resolve, reject)=>{ db.run(`INSERT OR REPLACE INTO adpos_transactions (
            id, profile_id, account_id, transaction_id, transaction_unix_timestamp, card_number, alias, username,
            merchant_name, billing_amount, billing_currency, status, transaction_type, billing_status,
            transaction_amount, transaction_currency, transaction_country, last_four_digits, raw_json, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
          )`, args, err => (err ? reject(err) : resolve())) })
          saved++
        }
        if (arr.length < perPage) break
        currentPage++
        if (totalPages && currentPage > totalPages) break
      }
    } catch {}
    finally { db.close() }
    res.json({ success: true, saved, meta: { pagination: { per_page: perPage, current_page: currentPage, total_pages: totalPages } } })
  } catch (e) { res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) }) }
})

function ensureVerificationCodesTable(db){
  return new Promise((resolve)=>{
    db.serialize(()=>{
      db.run(`CREATE TABLE IF NOT EXISTS verification_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, card_last4 TEXT, code TEXT, merchant TEXT, source TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, [], ()=>resolve())
    })
  })
}

app.post('/api/facebook/verification-codes/fetch', async (req, res) => {
  try {
    const body = req.body || {}
    const last4 = String(body.last4 || body.card_last4 || '').replace(/\D/g,'')
    const profileId = String(body.profileId || '')
    let token = String(body.token || '')
    const base = String(body.baseUrl || process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io').replace(/\/$/, '')
    if (!last4 || last4.length !== 4) return res.status(400).json({ success: false, message: 'invalid_last4' })
    if (!token) {
      try {
        const r = await tokenProvider.requestPaymentManagementToken({ profileId: '', adAccountId: '' })
        token = String(r && r.token || '')
      } catch {}
    }
    if (!token) return res.status(400).json({ success: false, message: 'missing_token' })
    const nowSec = Math.floor(Date.now()/1000)
    const startSec = nowSec - 31*24*60*60
    const urlPath = `/v2/cards/transactions?start_timestamp=${startSec}&end_timestamp=${nowSec}&per_page=200&page=1`
    const urlHost = base.replace(/^https?:\/\//,'')
    const isHttps = base.startsWith('https://')
    const reqOpts = { method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
    const fetchJson = () => new Promise((resolve, reject) => {
      const lib = isHttps ? require('https') : require('http')
      const r = lib.request({ hostname: urlHost, path: urlPath, method: reqOpts.method, headers: reqOpts.headers }, resp => {
        let data = ''
        resp.on('data', chunk => { data += chunk })
        resp.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({}) }
        })
      })
      r.on('error', reject)
      r.end()
    })
    const json = await fetchJson().catch(()=>({}))
    const arr = Array.isArray(json && json.data) ? json.data : []
    const take = arr.filter(it => {
      const l4 = String((it && (it.last_four_digits || it.card_last4 || (it.card_number ? String(it.card_number).slice(-4) : ''))) || '').replace(/\D/g,'')
      return l4 === last4
    }).sort((a,b)=>{
      const ta = Number(a && (a.transaction_unix_timestamp || (Date.parse(String(a.created_at||a.date||''))||0)))
      const tb = Number(b && (b.transaction_unix_timestamp || (Date.parse(String(b.created_at||b.date||''))||0)))
      return tb - ta
    })
    let code = ''
    let merchant = ''
    for (const it of take) {
      const name = String((it && (it.merchant_name || it.merchant || it.description)) || '').toUpperCase()
      const m = name.match(/METAPAY\*([A-Z0-9]{4})/i) || name.match(/\bFB[-\s]*([A-Z0-9]{4})\b/i) || (name.includes('FB.ME/CC') ? name.match(/\b([A-Z0-9]{4})\b/) : null) || name.match(/FACEBK\s.*?\b([A-Z0-9]{4})\b/i)
      if (m && m[1]) { code = String(m[1]); merchant = String(it && (it.merchant_name || it.description || '') || ''); break }
    }
    const sdb = new sqlite3.Database(dbPath)
    await ensureVerificationCodesTable(sdb)
    if (code) {
      await new Promise((resolve, reject)=>{
        sdb.run(`INSERT INTO verification_codes (profile_id, card_last4, code, merchant, source) VALUES (?, ?, ?, ?, ?)`, [profileId, last4, code, merchant, 'external'], (err)=> (err?reject(err):resolve()))
      })
    }
    await new Promise(r=>sdb.close(r))
    return res.json({ success: !!code, last4, code, merchant, count: take.length })
  } catch (e) {
    return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
  }
})

app.get('/api/facebook/verification-codes/latest', async (req, res) => {
  try {
    const last4 = String(req.query.last4 || req.query.card_last4 || '').replace(/\D/g,'')
    const profileId = String(req.query.profileId || '')
    const sdb = new sqlite3.Database(dbPath)
    await ensureVerificationCodesTable(sdb)
    const rows = await new Promise((resolve, reject)=>{
      let sql = `SELECT profile_id, card_last4, code, merchant, created_at FROM verification_codes`
      const args = []
      const conds = []
      if (last4) { conds.push(`card_last4 = ?`); args.push(last4) }
      if (profileId) { conds.push(`profile_id = ?`); args.push(profileId) }
      if (conds.length) sql += ` WHERE ` + conds.join(' AND ')
      sql += ` ORDER BY created_at DESC LIMIT 1`
      sdb.all(sql, args, (err, r)=> (err?reject(err):resolve(r||[])))
    })
    await new Promise(r=>sdb.close(r))
    const top = Array.isArray(rows) && rows.length ? rows[0] : null
    return res.json({ success: !!(top && top.code), data: top })
  } catch (e) {
    return res.status(500).json({ success: false, message: 'error', error: String(e && e.message || e) })
  }
})

function ensureBusinessesTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        business_id TEXT,
        name TEXT,
        verification_status TEXT,
        admin_email TEXT,
        aq_status TEXT,
        aq_evidence TEXT,
        aq_policy TEXT,
        aq_updated_at TEXT,
        bm_users TEXT,
        fb_created_time TEXT,
        ad_account_limit INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

async function ensureBusinessesColumns(db) {
  await ensureBusinessesTable(db)
  await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(businesses)`, (err, rows) => {
      if (err) return reject(err)
      const has = (n) => Array.isArray(rows) && rows.some(r => String(r.name) === n)
      const todo = []
      if (!has('admin_email')) todo.push(`ALTER TABLE businesses ADD COLUMN admin_email TEXT`)
      // 🩺 账号质量四列（本地库补齐；云端 MySQL 由 baota-backend 的 ensureAqColumns 补）
      if (!has('aq_status')) todo.push(`ALTER TABLE businesses ADD COLUMN aq_status TEXT`)
      if (!has('aq_evidence')) todo.push(`ALTER TABLE businesses ADD COLUMN aq_evidence TEXT`)
      if (!has('aq_policy')) todo.push(`ALTER TABLE businesses ADD COLUMN aq_policy TEXT`)
      if (!has('aq_updated_at')) todo.push(`ALTER TABLE businesses ADD COLUMN aq_updated_at TEXT`)
      if (!has('bm_users')) todo.push(`ALTER TABLE businesses ADD COLUMN bm_users TEXT`)
      if (!has('fb_created_time')) todo.push(`ALTER TABLE businesses ADD COLUMN fb_created_time TEXT`)
      // 🩺 可创建广告号上限（内部 GraphQL ad_account_creation_limit）
      if (!has('ad_account_limit')) todo.push(`ALTER TABLE businesses ADD COLUMN ad_account_limit INTEGER`)
      if (!todo.length) return resolve()
      let i = 0
      const next = () => {
        if (i >= todo.length) return resolve()
        db.run(todo[i++], e => (e ? reject(e) : next()))
      }
      next()
    })
  })
}

function ensureAdAccountSettingsTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS ad_account_settings (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        account_id TEXT,
        currency TEXT,
        timezone_id TEXT,
        spend_cap REAL,
        amount_spent REAL,
        account_status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

function ensureBillingMethodsTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS billing_methods (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        account_id TEXT,
        type TEXT,
        last4 TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

async function ensureBillingMethodsColumns(db) {
  await ensureBillingMethodsTable(db)
  await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(billing_methods)`, (e, rows) => {
      if (e) return reject(e)
      const names = new Set((rows || []).map(r => String(r.name)))
      const ops = []
      if (!names.has('brand')) ops.push(`ALTER TABLE billing_methods ADD COLUMN brand TEXT`)
      if (!names.has('exp_month')) ops.push(`ALTER TABLE billing_methods ADD COLUMN exp_month TEXT`)
      if (!names.has('exp_year')) ops.push(`ALTER TABLE billing_methods ADD COLUMN exp_year TEXT`)
      if (!names.has('billing_address')) ops.push(`ALTER TABLE billing_methods ADD COLUMN billing_address TEXT`)
      let i = 0
      const runNext = () => { if (i >= ops.length) return resolve(null); db.run(ops[i++], err => (err ? reject(err) : runNext())) }
      runNext()
    })
  })
}

function ensureVerificationCodesTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS verification_codes (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        account_id TEXT,
        last4 TEXT,
        code TEXT,
        source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

function ensureProxiesTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS proxies (
        id TEXT PRIMARY KEY,
        type TEXT,
        host TEXT,
        port TEXT,
        username TEXT,
        password TEXT,
        provider TEXT,
        zone TEXT,
        country TEXT,
        city TEXT,
        session TEXT,
        rotation TEXT,
        label TEXT DEFAULT '',
          channel TEXT DEFAULT '',
          category TEXT DEFAULT '',
          failed_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => {
        if (err) return reject(err)
        // 🚀 新增列迁移
        const migrations = [
          `ALTER TABLE proxies ADD COLUMN label TEXT DEFAULT ''`,
          `ALTER TABLE proxies ADD COLUMN channel TEXT DEFAULT ''`,
          `ALTER TABLE proxies ADD COLUMN category TEXT DEFAULT ''`,
          `ALTER TABLE proxies ADD COLUMN failed_count INTEGER DEFAULT 0`
        ];

  // 🚀 publish_configs 表（一键智能发布配置持久化）
  db.run(`CREATE TABLE IF NOT EXISTS publish_configs (
    config_key TEXT PRIMARY KEY,
    config_value TEXT NOT NULL DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, err => { if (err) console.error('[DB] publish_configs 表创建失败:', err.message) })
        let idx = 0;
        const runNext = () => {
          if (idx >= migrations.length) return resolve();
          db.run(migrations[idx++], err => { if (err && !err.message.includes('duplicate column')) {} runNext(); });
        };
        runNext();
      }
    )
  })
}

function ensureEventsTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_name TEXT,
        from_tab TEXT,
        to_tab TEXT,
        user_agent TEXT,
        locale TEXT,
        ip TEXT,
        extra TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => {
        if (err) return reject(err)
        db.all(`PRAGMA table_info(events)`, (e, rows) => {
          if (e) return reject(e)
          const hasIp = Array.isArray(rows) && rows.some(r => String(r.name) === 'ip')
          if (hasIp) return resolve()
          db.run(`ALTER TABLE events ADD COLUMN ip TEXT`, alterErr => (alterErr ? reject(alterErr) : resolve()))
        })
      }
    )
  })
}

function ensureAdposTransactionsTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS adpos_transactions (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        account_id TEXT,
        transaction_id INTEGER,
        transaction_unix_timestamp INTEGER,
        card_number TEXT,
        alias TEXT,
        username TEXT,
        merchant_name TEXT,
        billing_amount REAL,
        billing_currency TEXT,
        status TEXT,
        transaction_type TEXT,
        billing_status TEXT,
        transaction_amount REAL,
        transaction_currency TEXT,
        transaction_country TEXT,
        last_four_digits TEXT,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

async function ensureAdposTransactionsColumns(db) {
  const needed = [
    'profile_id','account_id','transaction_id','transaction_unix_timestamp','card_number','alias','username','merchant_name',
    'billing_amount','billing_currency','status','transaction_type','billing_status','transaction_amount','transaction_currency',
    'transaction_country','last_four_digits','raw_json','created_at','updated_at'
  ]
  const rows = await new Promise((resolve, reject)=>{
    db.all(`PRAGMA table_info(adpos_transactions)`, (err, rs)=> (err?reject(err):resolve(rs||[])))
  })
  const existing = new Set(rows.map(r => String(r.name)))
  for (const col of needed) {
    if (!existing.has(col)) {
      let type = 'TEXT'
      if (col.endsWith('_amount')) type = 'REAL'
      if (col.endsWith('_timestamp') || col === 'transaction_id') type = 'INTEGER'
      if (col.endsWith('_at')) type = 'DATETIME'
      await new Promise((resolve, reject)=>{
        db.run(`ALTER TABLE adpos_transactions ADD COLUMN ${col} ${type}`, err => (err ? reject(err) : resolve()))
      })
    }
  }
}

function ensureBlacklistTable(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS ip_blacklist (
        ip TEXT PRIMARY KEY,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      err => (err ? reject(err) : resolve())
    )
  })
}

app.get('/health', (req, res) => {
  res.json({ ok: true, port: PORT })
})

app.post('/api/profiles/set-cookies', async (req, res) => {
  const { profileId, cookies } = req.body || {}
  const pid = String(profileId || '')
  if (!pid) return res.status(400).json({ success: false, message: 'missing_profileId' })
  const raw = typeof cookies === 'string' ? cookies : JSON.stringify(cookies || [])
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProfilesColumns(db)
    try {
      const names = Array.isArray(cookies) ? cookies.slice(0, 10).map(c => `${c.name}@${c.domain}${c.path}`).join(', ') : ''
      const line = `[${new Date().toISOString()}] [INFO] 收到Cookie: profileId=${pid} count=${Array.isArray(cookies)?cookies.length:0} preview=${names}\n`
      try { process.stdout.write(line) } catch {}
    } catch {}
    const row = await new Promise((resolve, reject) => {
      db.get(`SELECT rowid AS rid, id, ext_id FROM profiles WHERE id = ? OR ext_id = ? OR rid = ? LIMIT 1`, [pid, pid, Number(pid) || -1], (err, r) => (err ? reject(err) : resolve(r || null)))
    })
    if (!row) {
      await new Promise((resolve, reject) => {
        db.run(`INSERT INTO profiles (ext_id, account_cookies, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`, [pid, raw], err => (err ? reject(err) : resolve(null)))
      })
      try { process.stdout.write(`[${new Date().toISOString()}] [INFO] 已创建新配置并写入Cookie: profileId=${pid} len=${raw.length}\n`) } catch {}
      return res.json({ success: true, created: true })
    }
    const targetId = (typeof row.id === 'number' && row.id) ? row.id : row.rid
    await new Promise((resolve, reject) => {
      db.run(`UPDATE profiles SET account_cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [raw, targetId], err => (err ? reject(err) : resolve(null)))
    })
    try { process.stdout.write(`[${new Date().toISOString()}] [INFO] 已更新Cookie: profileId=${pid} targetId=${targetId} len=${raw.length}\n`) } catch {}
    res.json({ success: true, updated: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/billing-methods/upsert', async (req, res) => {
  const { profileId, accountId, brand, last4, exp_month, exp_year } = req.body || {}
  const pid = String(profileId || '')
  const aid = String(accountId || '')
  if (!pid || !aid) return res.status(400).json({ success: false, message: 'missing_profile_or_account' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBillingMethodsColumns(db)
    const row = await new Promise((resolve, reject) => {
      db.get(`SELECT id FROM billing_methods WHERE profile_id = ? AND account_id = ? LIMIT 1`, [pid, aid], (err, r) => (err ? reject(err) : resolve(r || null)))
    })
    if (row) {
      await new Promise((resolve, reject) => {
        db.run(`UPDATE billing_methods SET brand = ?, last4 = ?, exp_month = ?, exp_year = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [brand || null, last4 || null, exp_month || null, exp_year || null, row.id], err => (err ? reject(err) : resolve(null)))
      })
      return res.json({ success: true, updated: true })
    }
    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO billing_methods (id, profile_id, account_id, brand, last4, exp_month, exp_year, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [`${pid}:${aid}`, pid, aid, brand || null, last4 || null, exp_month || null, exp_year || null], err => (err ? reject(err) : resolve(null)))
    })
    return res.json({ success: true, created: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.get('/api/profiles/:id/cookies', async (req, res) => {
  const pid = String(req.params.id || '')
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProfilesColumns(db)
    const row = await new Promise((resolve, reject) => {
      db.get(`SELECT account_cookies FROM profiles WHERE id = ? OR ext_id = ? OR rowid = ? LIMIT 1`, [pid, pid, Number(pid) || -1], (err, r) => (err ? reject(err) : resolve(r || null)))
    })
    if (!row) return res.status(404).json({ success: false, message: 'not_found' })
    res.json({ success: true, cookies: row.account_cookies })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.put('/api/profiles/:id', async (req, res) => {
  const { id } = req.params
  const body = req.body || {}
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProfilesColumns(db)
    
    // 构建更新字段
    const updates = []
    const params = []
    
    const allowedFields = [
      'name', 'platform', 'account_name', 'account_email', 'account_password',
      'account', 'start_url', 'user_agent', 'proxy', 'proxy_enabled',
      'proxy_type', 'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password',
      'account_notes', 'account_tokens', 'account_cookies', 'account_status',
      'startup_urls', 'os', 'resolution', 'timezone', 'language', 'fingerprint_protection', 'seq'
    ]
    
    for (const field of allowedFields) {
      // 检查直接匹配
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`)
        let val = body[field]
        if ((field === 'startup_urls' || field === 'fingerprint_protection' || field === 'proxy') && typeof val === 'object' && val !== null) {
          val = JSON.stringify(val)
        }
        params.push(val)
      } else {
        // 兼容前端驼峰命名
        const camelMap = {
          'startup_urls': 'startupUrls',
          'proxy_enabled': 'proxyEnabled',
          'fingerprint_protection': 'fingerprintProtection',
          'account_name': 'accountName',
          'account_email': 'accountEmail',
          'account_password': 'accountPassword',
          'account_notes': 'notes',
          'account_tokens': 'token',
          'account_cookies': 'cookies',
          'account_status': 'accountStatus',
          'start_url': 'startUrl'
        }
        const camelField = camelMap[field]
        if (camelField && body[camelField] !== undefined) {
          updates.push(`${field} = ?`)
          let val = body[camelField]
          if ((field === 'startup_urls' || field === 'fingerprint_protection' || field === 'proxy') && typeof val === 'object' && val !== null) {
            val = JSON.stringify(val)
          }
          params.push(val)
        }
      }
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'no_fields_to_update' })
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`)
    params.push(id) // 为 WHERE id = ? 准备
    
    const sql = `UPDATE profiles SET ${updates.join(', ')} WHERE rowid = ? OR id = ? OR ext_id = ?`
    // 为了安全，我们需要 3 个 id 参数
    params.push(id, id)
    
    await new Promise((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) reject(err)
        else resolve(this.changes)
      })
    })
    
    res.json({ success: true, id })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

// Simple proxy for Graph API to avoid CORS in browser
app.post('/api/graph', async (req, res) => {
  try {
    const url = String((req.body && (req.body.url || req.body.target)) || '')
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, message: 'invalid_url' })
    }
    const r = await fetch(url)
    const ct = String(r.headers.get('content-type') || '')
    let data
    if (/json/i.test(ct)) data = await r.json()
    else data = await r.text()
    return res.json({ success: true, data })
  } catch (error) {
    return res.status(500).json({ success: false, message: String(error.message || error) })
  }
})

app.post('/api/verification-codes/upsert', async (req, res) => {
  const { profileId, accountId, last4, code, source, expiresAt } = req.body || {}
  const pid = String(profileId || '')
  const aid = String(accountId || '')
  const l4 = String(last4 || '').slice(-4)
  const c = String(code || '')
  if (!l4 || !c) return res.status(400).json({ success: false, message: 'missing_last4_or_code' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureVerificationCodesTable(db)
    const id = `${pid}:${aid}:${Date.now()}`
    await new Promise((resolve, reject) => {
      const sql = `INSERT INTO verification_codes (id, profile_id, account_id, last4, code, source, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      const args = [id, pid, aid, l4, c, String(source || ''), expiresAt ? String(expiresAt) : null]
      db.run(sql, args, err => (err ? reject(err) : resolve()))
    })
    res.json({ success: true, id })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/adpos/transactions/save', async (req, res) => {
  const { profileId, accountId, items } = req.body || {}
  const pid = profileId ? String(profileId) : null
  const aid = accountId ? String(accountId) : null
  const aliasData = (req.body && (req.body.data || req.body.transactions)) || []
  const list = Array.isArray(items) ? items : (Array.isArray(aliasData) ? aliasData : [])
  if (!list.length) return res.status(400).json({ success: false, message: 'invalid_payload' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdposTransactionsTable(db)
    await ensureAdposTransactionsColumns(db)
    const stmt = await new Promise((resolve, reject) => {
      db.run(`CREATE INDEX IF NOT EXISTS idx_adpos_tx_profile ON adpos_transactions(profile_id)`, () => resolve(null))
    })
    let count = 0
    for (const it of list) {
      const rid = `${pid||''}:${aid||''}:${String(it.id || it.transaction_id || '')}`
      const args = [
        rid,
        pid,
        aid,
        typeof it.id === 'number' ? it.id : (typeof it.transaction_id === 'number' ? it.transaction_id : null),
        Number(it.transaction_unix_timestamp || 0),
        String(it.card_number || ''),
        String(it.alias || ''),
        String(it.username || ''),
        String(it.merchant_name || ''),
        Number(it.billing_amount || 0),
        String(it.billing_currency || ''),
        String(it.status || ''),
        String(it.transaction_type || ''),
        String(it.billing_status || ''),
        Number(it.transaction_amount || 0),
        String(it.transaction_currency || ''),
        String(it.transaction_country || ''),
        String(it.last_four_digits || it.card_last4 || (it.card_number ? String(it.card_number).slice(-4) : '')) || null,
        JSON.stringify(it || {})
      ]
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO adpos_transactions (
          id, profile_id, account_id, transaction_id, transaction_unix_timestamp, card_number, alias, username,
          merchant_name, billing_amount, billing_currency, status, transaction_type, billing_status,
          transaction_amount, transaction_currency, transaction_country, last_four_digits, raw_json, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
        )`
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
      count++
    }
    res.json({ success: true, saved: count })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.get('/api/adpos/transactions/list', async (req, res) => {
  const last4 = String((req.query.last4 || '')).replace(/\D/g,'')
  const status = String(req.query.status || '')
  const page = Math.max(1, Number(req.query.page || 1))
  const perPage = Math.min(200, Math.max(1, Number(req.query.per_page || 50)))
  const startTs = Number(req.query.start_timestamp || 0)
  const endTs = Number(req.query.end_timestamp || 0)
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdposTransactionsTable(db)
    await ensureAdposTransactionsColumns(db)
    const where = []
    const args = []
    if (last4) { where.push('last_four_digits = ?'); args.push(last4) }
    if (status) { where.push('status = ?'); args.push(status) }
    if (startTs && endTs && endTs >= startTs) { where.push('transaction_unix_timestamp BETWEEN ? AND ?'); args.push(startTs, endTs) }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : ''
    const total = await new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(1) as cnt FROM adpos_transactions ${whereSql}`, args, (err, row) => (err ? reject(err) : resolve(Number(row && row.cnt || 0))))
    })
    const offset = (page - 1) * perPage
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM adpos_transactions ${whereSql} ORDER BY transaction_unix_timestamp DESC, created_at DESC LIMIT ? OFFSET ?`,
        [...args, perPage, offset],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      )
    })
    const data = []
    for (const r of rows) {
      let obj = {}
      try { obj = JSON.parse(String(r.raw_json || '{}')) } catch {}
      const merged = Object.assign({}, obj, {
        id: r.transaction_id || obj.id,
        transaction_unix_timestamp: r.transaction_unix_timestamp || obj.transaction_unix_timestamp,
        card_number: r.card_number || obj.card_number,
        alias: r.alias || obj.alias,
        username: r.username || obj.username,
        merchant_name: r.merchant_name || obj.merchant_name,
        billing_amount: (typeof r.billing_amount === 'number' ? r.billing_amount : obj.billing_amount),
        billing_currency: r.billing_currency || obj.billing_currency,
        status: r.status || obj.status,
        transaction_type: r.transaction_type || obj.transaction_type,
        billing_status: r.billing_status || obj.billing_status,
        transaction_amount: (typeof r.transaction_amount === 'number' ? r.transaction_amount : obj.transaction_amount),
        transaction_currency: r.transaction_currency || obj.transaction_currency,
        transaction_country: r.transaction_country || obj.transaction_country,
        last_four_digits: r.last_four_digits || obj.last_four_digits || (obj.card_number ? String(obj.card_number).slice(-4) : null)
      })
      data.push(merged)
    }
    const totalPages = Math.max(1, Math.ceil(total / perPage))
    const meta = { pagination: { total, count: data.length, per_page: perPage, current_page: page, total_pages: totalPages, links: {} } }
    res.json({ data, meta })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.get('/api/verification-codes/latest', async (req, res) => {
  const last4 = String((req.query && req.query.last4) || '').slice(-4)
  const pid = String((req.query && (req.query.profileId || req.query.pid)) || '')
  const aid = String((req.query && (req.query.accountId || req.query.adAccountId)) || '')
  if (!last4) return res.status(400).json({ success: false, message: 'missing_last4' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureVerificationCodesTable(db)
    const rows = await new Promise((resolve, reject) => {
      const where = []
      const args = []
      where.push(`last4 = ?`); args.push(last4)
      if (pid) { where.push(`profile_id = ?`); args.push(pid) }
      if (aid) { where.push(`account_id = ?`); args.push(aid) }
      const sql = `SELECT id, profile_id, account_id, last4, code, source, created_at, expires_at FROM verification_codes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
      db.all(sql, args, (err, rs) => (err ? reject(err) : resolve(rs || [])))
    })
    let item = null
    for (const r of rows) {
      if (!r.expires_at) { item = r; break }
      const now = Date.now()
      const ts = Date.parse(String(r.expires_at))
      if (!isNaN(ts) && now <= ts) { item = r; break }
    }
    if (!item) return res.status(404).json({ success: false, message: 'not_found' })
    res.json({ success: true, data: item })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.get('/api/profiles', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProfilesColumns(db)
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT rowid AS rid, ext_id, name, account_name, account_email, account_password, account,
                start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
                proxy_port, proxy_username, proxy_password, account_notes, account_tokens, account_cookies, account_status, platform, startup_urls, seq, updated_at, created_at
         FROM profiles
         ORDER BY updated_at DESC, created_at DESC`,
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      )
    })

    // 🚀 核心优化：获取资产统计数据以填充 Profile 列表
    const [pageCounts, bmCounts, pixelCounts, adAccountCounts, paymentInfoRows] = await Promise.all([
      new Promise(res => db.all(`SELECT profile_id, COUNT(1) as cnt FROM pages GROUP BY profile_id`, (e, rs) => res(rs || []))),
      new Promise(res => db.all(`SELECT profile_id, COUNT(1) as cnt FROM businesses GROUP BY profile_id`, (e, rs) => res(rs || []))),
      new Promise(res => db.all(`SELECT profile_id, COUNT(DISTINCT pixel_id) as cnt FROM pixels GROUP BY profile_id`, (e, rs) => res(rs || []))),
      new Promise(res => db.all(`SELECT profile_id, COUNT(1) as cnt FROM ad_accounts GROUP BY profile_id`, (e, rs) => res(rs || []))),
      new Promise(res => db.all(`SELECT profile_id, funding_source, country, currency, status FROM ad_accounts WHERE funding_source IS NOT NULL AND funding_source != '' ORDER BY updated_at DESC`, (e, rs) => res(rs || [])))
    ]);

    const pageMap = new Map(pageCounts.map(r => [String(r.profile_id).trim(), r.cnt]));
    const bmMap = new Map(bmCounts.map(r => [String(r.profile_id).trim(), r.cnt]));
    const pixelMap = new Map(pixelCounts.map(r => [String(r.profile_id).trim(), r.cnt]));
    const adAccountMap = new Map(adAccountCounts.map(r => [String(r.profile_id).trim(), r.cnt]));
    
    // 聚合支付信息和资产属性
    const assetExtraMap = new Map();
    paymentInfoRows.forEach(r => {
      const pid = String(r.profile_id).trim();
      if (!assetExtraMap.has(pid)) {
        assetExtraMap.set(pid, {
          paymentStatus: r.status === '1' || r.status === 'ACTIVE' ? 'Active' : 'None',
          paymentInfo: r.funding_source,
          country: r.country,
          currency: r.currency,
          timezone: r.timezone_id
        });
      }
    });

    const data = rows.map(row => {
      const pid = String(row.rid).trim();
      // ... (省略部分 proxy/startupUrls 逻辑保持不变)
      let proxy = null
      if (row.proxy) {
        try { 
          proxy = JSON.parse(row.proxy) 
        } catch { 
          proxy = null 
        }
      }
      
      // 如果 JSON 解析失败或为空，尝试从独立列构建
      if (!proxy && row.proxy_host) {
        proxy = {
          type: row.proxy_type || 'http',
          host: row.proxy_host,
          port: row.proxy_port || '8080',
          username: row.proxy_username,
          password: row.proxy_password
        }
      } else if (proxy && row.proxy_host) {
        // 如果两者都有，以 JSON 为主但合并基础字段确保最新
        proxy.type = row.proxy_type || proxy.type || 'http'
        proxy.host = row.proxy_host || proxy.host
        proxy.port = row.proxy_port || proxy.port
        proxy.username = row.proxy_username || proxy.username
        proxy.password = row.proxy_password || proxy.password
      }
      
      let startupUrls = []
      if (row.startup_urls) {
        try { startupUrls = JSON.parse(row.startup_urls) } catch { startupUrls = [] }
      }
      if (startupUrls.length === 0 && row.start_url) {
        startupUrls = [row.start_url]
      }

      const p = {
        id: String(row.rid),
        name: row.name || String(row.id),
        platform: row.platform || 'Meta (Facebook/Instagram)',
        status: 'Idle',
        accountStatus: row.account_status || 'Unknown',
        userAgent: row.user_agent || '',
        ipAddress: (row.proxy_host || (proxy && proxy.host) || 'N/A'),
        cookiesCount: (() => {
          if (!row.account_cookies || row.account_cookies.length < 2) return 0;
          try {
            // 尝试解析 JSON 数组
            const c = JSON.parse(row.account_cookies);
            if (Array.isArray(c)) return c.length;
            if (typeof c === 'object' && c !== null) return 1;
            return 0;
          } catch {
            // 如果不是 JSON，尝试按分号分隔统计（兼容旧格式）
            const count = row.account_cookies.split(';').filter(s => s.trim().includes('=')).length;
            return count > 0 ? count : 1;
          }
        })(),
        lastActive: 'Never',
        group: '',
        account: { name: row.account_name || row.account, email: row.account_email, password: row.account_password, cookies: row.account_cookies || '' },
        notes: row.account_notes || '',
        token: row.account_tokens || '',
        seq: typeof row.seq === 'number' ? row.seq : undefined,
        createdAt: String(row.created_at || ''),
        updatedAt: String(row.updated_at || ''),
        startupUrls: startupUrls
      }
      p.extId = String(row.ext_id || '')
      if (proxy) { p.proxy = proxy }
      p.proxyEnabled = (!!row.proxy_enabled) || (!!proxy)

      // 🚀 核心优化：填充资产统计信息
      const extra = assetExtraMap.get(pid) || {};
      p.assets = {
        pagesCount: pageMap.get(pid) || 0,
        bmCount: bmMap.get(pid) || 0,
        pixelsCount: pixelMap.get(pid) || 0,
        adAccountsCount: adAccountMap.get(pid) || 0,
        paymentStatus: extra.paymentStatus || 'None',
        paymentInfo: extra.paymentInfo || '',
        country: extra.country || '',
        currency: extra.currency || '',
        timezone: extra.timezone || ''
      };

      return p
    })
    // 🚀 诊断点：记录当前返回的配置数量和关键字段
    if (data.length > 0) {
      const sample = data[0];
      try { process.stdout.write(`[${new Date().toISOString()}] [DEBUG] GET /api/profiles returned ${data.length} profiles. Sample: id=${sample.id} name=${sample.name} cookiesCount=${sample.cookiesCount}\n`) } catch {}
    }
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.get('/api/proxies', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProxiesTable(db)
    const rows = await new Promise((resolve, reject) => {
      db.all(`SELECT id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, created_at FROM proxies`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
    })
    const data = rows.map(r => ({
      id: String(r.id),
      type: String(r.type || 'http'),
      host: String(r.host || ''),
      port: String(r.port || ''),
      username: String(r.username || ''),
      password: String(r.password || ''),
      provider: String(r.provider || ''),
      zone: String(r.zone || ''),
      country: String(r.country || ''),
      city: String(r.city || ''),
      session: String(r.session || ''),
      rotation: String(r.rotation || ''),
      label: String(r.label || ''),
      channel: String(r.channel || ''),
      category: String(r.category || '')
    }))
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/proxies', async (req, res) => {
  const payload = Array.isArray(req.body) ? req.body : [req.body]
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProxiesTable(db)
    for (const p of payload) {
      const rec = {
        id: String(p.id || `px_${Date.now()}_${Math.random().toString(36).slice(2)}`),
        type: String(p.type || 'http'),
        host: String(p.host || ''),
        port: String(p.port || ''),
        username: String(p.username || ''),
        password: String(p.password || ''),
        provider: String(p.provider || ''),
        zone: String(p.zone || ''),
        country: String(p.country || ''),
        city: String(p.city || ''),
        session: String(p.session || ''),
        rotation: String(p.rotation || ''),
        label: String(p.label || ''),
        channel: String(p.channel || ''),
        category: String(p.category || '')
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO proxies (
          id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
        )`
        const args = [rec.id, rec.type, rec.host, rec.port, rec.username, rec.password, rec.provider, rec.zone, rec.country, rec.city, rec.session, rec.rotation, rec.label, rec.channel, rec.category]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: payload.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/proxies/test', async (req, res) => {
  const { host, port } = req.body || {}
  const h = String(host || '')
  const p = Number(port || 0)
  if (!h || !p) return res.status(400).json({ success: false, message: 'invalid' })
  const start = Date.now()
  const socket = new net.Socket()
  let done = false
  socket.setTimeout(5000)
  socket.once('error', err => {
    if (done) return
    done = true
    try { socket.destroy() } catch {}
    res.status(200).json({ success: false, message: String(err && err.message || 'error'), latency: Date.now() - start })
  })
  socket.once('timeout', () => {
    if (done) return
    done = true
    try { socket.destroy() } catch {}
    res.status(200).json({ success: false, message: 'timeout', latency: Date.now() - start })
  })
  socket.connect(p, h, () => {
    if (done) return
    done = true
    try { socket.end() } catch {}
    res.json({ success: true, latency: Date.now() - start })
  })
})

app.put('/api/proxies/:id', async (req, res) => {
  const { id } = req.params
  const p = req.body || {}
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProxiesTable(db)
    await new Promise((resolve, reject) => {
      const sql = `INSERT OR REPLACE INTO proxies (
        id, type, host, port, username, password, provider, zone, country, city, session, rotation, label, channel, category, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      )`
      const args = [
        String(id), String(p.type||'http'), String(p.host||''), String(p.port||''), String(p.username||''), String(p.password||''),
        String(p.provider||''), String(p.zone||''), String(p.country||''), String(p.city||''), String(p.session||''), String(p.rotation||''),
        String(p.label||''), String(p.channel||''), String(p.category||'')
      ]
      db.run(sql, args, err => (err ? reject(err) : resolve()))
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.delete('/api/proxies/:id', async (req, res) => {
  const { id } = req.params
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProxiesTable(db)
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM proxies WHERE id = ?`, [String(id)], err => (err ? reject(err) : resolve()))
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

// POST /api/proxies/fail (标记代理失败，递增失败计数)
app.post('/api/proxies/fail', async (req, res) => {
  const { id } = req.body || {}
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProxiesTable(db)
    await new Promise((resolve, reject) => {
      db.run(`UPDATE proxies SET failed_count = COALESCE(failed_count,0)+1, updated_at=CURRENT_TIMESTAMP WHERE id = ?`, [String(id)], err => (err ? reject(err) : resolve()))
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

// GET /api/publish-configs (读取发布配置，可选指定 key)
app.get('/api/publish-configs/:key?', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    const key = req.params.key
    if (key) {
      db.get(`SELECT config_key, config_value FROM publish_configs WHERE config_key = ?`, [key], (err, row) => {
        if (err) return res.status(500).json({ success: false, message: err.message })
        res.json({ success: true, data: row ? { key: row.config_key, value: JSON.parse(row.config_value || '{}') } : null })
      })
    } else {
      db.all(`SELECT config_key, config_value FROM publish_configs`, [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message })
        const map = {}
        for (const r of rows) map[r.config_key] = JSON.parse(r.config_value || '{}')
        res.json({ success: true, data: map })
      })
    }
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

// PUT /api/publish-configs/:key (保存发布配置)
app.put('/api/publish-configs/:key', async (req, res) => {
  const key = req.params.key
  const val = typeof req.body === 'string' ? req.body : JSON.stringify(req.body?.value ?? req.body)
  const db = new sqlite3.Database(dbPath)
  try {
    db.run(`INSERT INTO publish_configs (config_key, config_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, updated_at=CURRENT_TIMESTAMP`,
      [key, val], err => {
        if (err) return res.status(500).json({ success: false, message: err.message })
        res.json({ success: true })
      })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/proxies/assign-to-profiles', async (req, res) => {
  const { proxyId, profileIds } = req.body || {}
  const ids = Array.isArray(profileIds) ? profileIds.map(String) : []
  const db = new sqlite3.Database(dbPath)
  try {
    if (!proxyId || !ids.length) return res.status(400).json({ success: false, message: 'invalid' })
    await ensureProxiesTable(db)
    await ensureProfilesTable(db)
    const proxy = await new Promise((resolve, reject) => {
      db.get(`SELECT id, type, host, port, username, password, provider, zone, country, city, session, rotation FROM proxies WHERE id = ?`, [String(proxyId)], (err, r) => (err ? reject(err) : resolve(r||null)))
    })
    if (!proxy) return res.status(404).json({ success: false, message: 'proxy not found' })
    for (const pid of ids) {
      await new Promise((resolve, reject) => {
        const sql = `UPDATE profiles SET 
          proxy_enabled = 1,
          proxy_type = ?,
          proxy_host = ?,
          proxy_port = ?,
          proxy_username = ?,
          proxy_password = ?,
          proxy = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
        const proxyJson = JSON.stringify({ type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password, provider: proxy.provider, residentialOptions: { zone: proxy.zone, country: proxy.country, city: proxy.city, session: proxy.session, rotation: proxy.rotation } })
        const args = [String(proxy.type||'http'), String(proxy.host||''), String(proxy.port||''), String(proxy.username||''), String(proxy.password||''), proxyJson, String(pid)]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: ids.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.get('/api/adaccounts', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdAccountsColumns(db)
    // 运行时确保扩展列存在
    try { await ensureAdAccountSettingsTable(db) } catch {}
    try {
      await new Promise((resolve) => {
        db.all(`PRAGMA table_info(ad_account_settings)`, (e, rows) => {
          const names = new Set((rows||[]).map(r => String(r.name)))
          const ops = []
          if (!names.has('threshold_amount')) ops.push(`ALTER TABLE ad_account_settings ADD COLUMN threshold_amount REAL`)
          if (!names.has('credit_limit')) ops.push(`ALTER TABLE ad_account_settings ADD COLUMN credit_limit REAL`)
          if (!names.has('balance')) ops.push(`ALTER TABLE ad_account_settings ADD COLUMN balance REAL`)
          if (!names.has('funding_source')) ops.push(`ALTER TABLE ad_account_settings ADD COLUMN funding_source TEXT`)
          let i=0; const runNext=()=>{ if(i>=ops.length) return resolve(null); db.run(ops[i++], ()=> runNext()) }
          runNext()
        })
      })
    } catch {}
    await ensureProfilesTable(db)
      const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT a.id, a.profile_id, a.platform, a.account_id, a.name, a.status, a.currency, a.timezone_id, a.country, a.spend, a.account, a.profile_name,
                a.pages_count, a.bm_count, a.pixels_count,
                s.spend_cap, s.amount_spent, s.account_status AS settings_status,
                s.threshold_amount AS s_threshold_amount, s.credit_limit AS s_credit_limit, s.balance AS s_balance, s.funding_source AS s_funding_source
         FROM ad_accounts a
         LEFT JOIN ad_account_settings s ON s.profile_id = a.profile_id AND s.account_id = a.account_id`,
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      )
    })
    const profiles = await new Promise((resolve, reject) => {
      db.all(`SELECT id, name, account_name, account, proxy FROM profiles`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
    })
    const profMap = new Map(profiles.map(p => [String(p.id), p]))
    const nameMap = new Map(profiles.map(p => [String(p.id), String(p.name || p.id)]))
    let data = rows.map(r => ({
      profileId: String(r.profile_id || ''),
      profileName: nameMap.get(String(r.profile_id || '')) || '',
      adAccountId: String(r.account_id || ''),
      adAccountStatus: String(r.status || r.settings_status || 'Unknown'),
      spend: Number(r.spend || r.amount_spent || 0),
      spendCap: Number(r.spend_cap || 0),
      threshold: Number(r.s_threshold_amount || 0),
      creditLimit: Number(r.s_credit_limit || 0),
      balance: Number(r.s_balance || 0),
      fundingSource: String(r.s_funding_source || r.funding_source || ''),
      paymentInfo: String(r.s_funding_source || r.funding_source || ''), // 🚀 增加明确的支付信息字段
      adAccountName: String(r.name || ''),
      currency: String(r.currency || ''),
      timezone_id: String(r.timezone_id || ''),
      adsCount: 0,
      paymentCount: 0,
      pagesCount: Number(r.pages_count || 0),
      bmCount: Number(r.bm_count || 0),
      pixelsCount: Number(r.pixels_count || 0),
      account: r.account || (() => { const p = profMap.get(String(r.profile_id||'')); return p ? String(p.account_name || p.account || '') : '' })(),
      country: String(r.country || '')
    }))
    // Aggregate counts
    try {
      const cards = await new Promise((resolve, reject) => {
        db.all(`SELECT profile_id, account_id, COUNT(1) AS cnt, MAX(billing_address) AS billing_address FROM billing_methods GROUP BY profile_id, account_id`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
      })
      const pages = await new Promise((resolve, reject) => {
        db.all(`SELECT profile_id, COUNT(1) AS cnt FROM pages GROUP BY profile_id`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
      })
      const bms = await new Promise((resolve, reject) => {
        db.all(`SELECT profile_id, COUNT(1) AS cnt FROM businesses GROUP BY profile_id`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
      })
      const pixels = await new Promise((resolve, reject) => {
        db.all(`SELECT profile_id, COUNT(DISTINCT pixel_id) AS cnt FROM pixels GROUP BY profile_id`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
      })
      const ads = await new Promise((resolve, reject) => {
        db.all(`SELECT profile_id, account_id, COUNT(1) AS cnt FROM ads GROUP BY profile_id, account_id`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
      })
      const cardKey = new Map(cards.map((r) => [String(r.profile_id).trim()+':'+String(r.account_id).trim(), Number(r.cnt||0)]))
      const pageKey = new Map(pages.map((r) => [String(r.profile_id).trim(), Number(r.cnt||0)]))
      const bmKey = new Map(bms.map((r) => [String(r.profile_id).trim(), Number(r.cnt||0)]))
      const pixelKey = new Map(pixels.map((r) => [String(r.profile_id).trim(), Number(r.cnt||0)]))
      const adsKey = new Map(ads.map((r) => [String(r.profile_id).trim()+':'+String(r.account_id).trim(), Number(r.cnt||0)]))
      const countryKey = new Map(cards.map((r) => {
        let c = ''
        try {
          if (r.billing_address) {
            const obj = JSON.parse(String(r.billing_address))
            c = String(obj?.country || '')
          }
        } catch {}
        return [String(r.profile_id).trim()+':'+String(r.account_id).trim(), c]
      }))
      data = data.map(it => {
        const pid = String(it.profileId).trim()
        const aid = String(it.adAccountId).trim()
        const k = pid + ':' + aid
        let c = it.country
        if (!c) {
          const fromMethod = countryKey.get(k) || ''
          if (fromMethod) c = fromMethod
          else if (!c && typeof it.fundingSource === 'string' && it.fundingSource.length) {
            try {
              const obj = JSON.parse(String(it.fundingSource))
              c = String(obj?.billing_address?.country || obj?.country || '')
            } catch {}
          }
        }
        if (!c) {
          const cur = String(it.currency||'').toUpperCase()
          const cur2cty = { USD: 'US', EUR: 'EU', GBP: 'GB', CNY: 'CN', HKD: 'HK', JPY: 'JP', KRW: 'KR', AUD: 'AU', CAD: 'CA' }
          if (cur && cur2cty[cur]) c = cur2cty[cur]
        }
        return {
          ...it,
          paymentCount: cardKey.get(k) || 0,
          pagesCount: pageKey.get(pid) || 0,
          bmCount: bmKey.get(pid) || 0,
          pixelsCount: pixelKey.get(pid) || 0,
          adsCount: adsKey.get(k) || 0,
          country: c
        }
      })
    } catch {}
    data = data.filter(it => it.adAccountId && it.adAccountId.length > 0)
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/adaccounts/clear', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdAccountsTable(db)
    await new Promise((resolve) => { db.run(`DELETE FROM ad_accounts`, [], () => resolve(null)) })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/graph', async (req, res) => {
  try {
    const { url } = req.body || {}
    if (!url || typeof url !== 'string') return res.status(400).json({ success: false, message: 'missing url' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const target = new URL(url)
    const protocol = target.protocol === 'https:' ? https : null
    if (!protocol) return res.status(400).json({ success: false, message: 'only https supported' })
    const chunks = []
    const reqHttps = protocol.get(url, r => {
      r.on('data', d => chunks.push(d))
      r.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          let data = null
          try { data = JSON.parse(raw) } catch { data = null }
          res.json({ success: true, data, raw })
        } catch (e) {
          res.status(500).json({ success: false, message: String(e.message || e) })
        }
      })
    })
    reqHttps.on('error', e => {
      res.status(500).json({ success: false, message: String(e.message || e) })
    })
    reqHttps.setTimeout(8000, () => { try { reqHttps.destroy() } catch {} })
  } catch (e) {
    res.status(500).json({ success: false, message: String(e.message || e) })
  }
})

app.post('/api/adinsights/bulk-save', async (req, res) => {
  const payload = req.body && (req.body.items || req.body.data || req.body) || []
  const list = Array.isArray(payload) ? payload : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdInsightsTable(db)
    for (const item of list) {
      const rec = {
        id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
        profile_id: String(item.profileId || ''),
        account_id: String(item.accountId || ''),
        level: String(item.level || 'ad'),
        date_preset: String(item.date_preset || 'last_7d'),
        metrics: JSON.stringify(item.metrics || {})
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO ad_insights (id, profile_id, account_id, level, date_preset, metrics, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        const args = [rec.id, rec.profile_id, rec.account_id, rec.level, rec.date_preset, rec.metrics]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/ads/bulk-save', async (req, res) => {
  const payload = req.body && (req.body.items || req.body.data || req.body) || []
  const list = Array.isArray(payload) ? payload : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdsTable(db)
    for (const item of list) {
      const rec = {
        id: String(item.id || `ad_${item.ad_id || item.adId}`),
        user_id: Number(item.user_id || 1),
        profile_id: String(item.profile_id || item.profileId || '').trim(),
        ad_id: String(item.ad_id || item.adId || ''),
        name: String(item.name || ''),
        status: String(item.status || ''),
        account_id: String(item.account_id || item.accountId || ''),
        campaign_id: String(item.campaign_id || item.campaignId || ''),
        campaign_name: String(item.campaign_name || item.campaignName || ''),
        adset_id: String(item.adset_id || item.adsetId || ''),
        adset_name: String(item.adset_name || item.adsetName || ''),
        creative_id: String(item.creative_id || item.creativeId || ''),
        preview_url: String(item.preview_url || item.previewUrl || ''),
        targeting: String(typeof item.targeting === 'string' ? item.targeting : JSON.stringify(item.targeting || {})),
        creative_json: String(typeof item.creative_json === 'string' ? item.creative_json : (typeof item.creativeJson === 'string' ? item.creativeJson : JSON.stringify(item.creative_json || item.creativeJson || {})))
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO ads (
          id, user_id, profile_id, ad_id, name, status, account_id, 
          campaign_id, campaign_name, adset_id, adset_name, creative_id, preview_url, targeting, creative_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        const args = [
          rec.id, rec.user_id, rec.profile_id, rec.ad_id, rec.name, rec.status, rec.account_id,
          rec.campaign_id, rec.campaign_name, rec.adset_id, rec.adset_name, rec.creative_id, rec.preview_url, rec.targeting, rec.creative_json
        ]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/pixels/bulk-save', async (req, res) => {
  const payload = req.body && (req.body.items || req.body.data || req.body) || []
  const list = Array.isArray(payload) ? payload : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensurePixelsTable(db)
    for (const item of list) {
      const rec = {
        id: String(item.id || `pixel_${item.pixel_id || item.pixelId}`),
        user_id: Number(item.user_id || 1),
        profile_id: String(item.profile_id || item.profileId || '').trim(),
        pixel_id: String(item.pixel_id || item.pixelId || ''),
        name: String(item.name || ''),
        status: String(item.status || 'ACTIVE'),
        account_id: String(item.account_id || item.accountId || '')
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO pixels (
          id, user_id, profile_id, pixel_id, name, status, account_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        const args = [rec.id, rec.user_id, rec.profile_id, rec.pixel_id, rec.name, rec.status, rec.account_id]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/pages/bulk-save', async (req, res) => {
  const payload = req.body && (req.body.items || req.body.data || req.body) || []
  const list = Array.isArray(payload) ? payload : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensurePagesTable(db)
    for (const item of list) {
      const rec = {
        id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
        profile_id: String(item.profileId || item.profile_id || '').trim(),
        page_id: String(item.pageId || item.id || ''),
        name: String(item.name || ''),
        fan_count: Number(item.fan_count || item.fans || 0),
        link: String(item.link || ''),
        category: String(item.category || '')
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO pages (id, profile_id, page_id, name, fan_count, link, category, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        const args = [rec.id, rec.profile_id, rec.page_id, rec.name, rec.fan_count, rec.link, rec.category]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.get('/api/pages', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensurePagesTable(db)
    await ensureProfilesTable(db)
    const pid = String(req.query && (req.query.profileId || req.query.pid || ''))
    const rows = await new Promise((resolve, reject) => {
      const sql = pid ? `SELECT profile_id, page_id, name, fan_count, link, category FROM pages WHERE profile_id = ?` : `SELECT profile_id, page_id, name, fan_count, link, category FROM pages`
      const args = pid ? [pid] : []
      db.all(sql, args, (err, rs) => (err ? reject(err) : resolve(rs || [])))
    })
    const profiles = await new Promise((resolve, reject) => {
      db.all(`SELECT id, name FROM profiles`, (err, rs) => (err ? reject(err) : resolve(rs || [])))
    })
    const nameMap = new Map((profiles || []).map(p => [String(p.id), String(p.name || p.id)]))
    const data = (rows || []).map(r => ({
      profileId: String(r.profile_id || ''),
      profileName: nameMap.get(String(r.profile_id || '')) || '',
      pageId: String(r.page_id || ''),
      name: String(r.name || ''),
      fan_count: Number(r.fan_count || 0),
      link: String(r.link || ''),
      category: String(r.category || '')
    }))
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.get('/api/pixels', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensurePixelsTable(db)
    const pid = String(req.query && (req.query.profileId || req.query.pid || ''))
    const rows = await new Promise((resolve, reject) => {
      const sql = pid ? `SELECT id, profile_id, pixel_id, name, status, account_id FROM pixels WHERE profile_id = ?` : `SELECT id, profile_id, pixel_id, name, status, account_id FROM pixels`
      const args = pid ? [pid] : []
      db.all(sql, args, (err, rs) => (err ? reject(err) : resolve(rs || [])))
    })
    const profiles = await new Promise((resolve, reject) => {
      db.all(`SELECT id, name FROM profiles`, (err, rs) => (err ? reject(err) : resolve(rs || [])))
    })
    const nameMap = new Map((profiles || []).map(p => [String(p.id), String(p.name || p.id)]))
    const data = (rows || []).map(r => ({
      id: String(r.id || ''),
      profileId: String(r.profile_id || ''),
      profileName: nameMap.get(String(r.profile_id || '')) || '',
      pixel_id: String(r.pixel_id || r.id || ''),
      name: String(r.name || ''),
      status: String(r.status || ''),
      account_id: String(r.account_id || '')
    }))
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/pages/batch-delete', async (req, res) => {
  const ids = req.body && (req.body.page_ids || req.body.pageIds || req.body.ids) || []
  const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensurePagesTable(db)
    for (const pid of list) {
      await new Promise((resolve, reject) => {
        db.run(`DELETE FROM pages WHERE page_id = ?`, [pid], err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/businesses/bulk-save', async (req, res) => {
  const payload = req.body && (req.body.items || req.body.data || req.body) || []
  const list = Array.isArray(payload) ? payload : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBusinessesColumns(db)
    for (const item of list) {
      const rec = {
        id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
        profile_id: String(item.profileId || item.profile_id || '').trim(),
        business_id: String(item.businessId || item.id || ''),
        name: String(item.name || ''),
        verification_status: String(item.verification_status || item.status || ''),
        admin_email: String(item.admin_email || item.email || ''),
        // 🩺 账号质量（只有探测方会带；其它写入方为空 → upsert 时保留原值）
        aq_status: item.aq_status != null ? String(item.aq_status).trim() : '',
        aq_evidence: item.aq_evidence != null ? String(item.aq_evidence) : '',
        aq_policy: item.aq_policy != null ? String(item.aq_policy) : '',
        aq_updated_at: item.aq_updated_at != null ? String(item.aq_updated_at) : '',
        // 🩺 BM 成员（邮箱+角色 JSON）；'' 表示本次没带 → upsert 时保留原值
        bm_users: item.bm_users != null ? String(item.bm_users) : '',
        // 🩺 BM 创建时间（Graph Business.creation_time）
        fb_created_time: item.fb_created_time != null ? String(item.fb_created_time) : '',
        // 🩺 可创建广告号上限（内部 GraphQL ad_account_creation_limit）；null 表示本次没带 → upsert 保留原值
        ad_account_limit: (item.ad_account_limit != null && String(item.ad_account_limit).trim() !== '') ? Number(item.ad_account_limit) : null
      }
      await new Promise((resolve, reject) => {
        // ⚠️ 从 INSERT OR REPLACE 改成 upsert：REPLACE 会先删后插，别的写入方（不带 aq）会把已探测结果抹掉
        const sql = `INSERT INTO businesses (id, profile_id, business_id, name, verification_status, admin_email, aq_status, aq_evidence, aq_policy, aq_updated_at, bm_users, fb_created_time, ad_account_limit, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            profile_id = excluded.profile_id,
            business_id = excluded.business_id,
            name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE businesses.name END,
            verification_status = CASE WHEN excluded.verification_status <> '' THEN excluded.verification_status ELSE businesses.verification_status END,
            admin_email = CASE WHEN excluded.admin_email <> '' THEN excluded.admin_email ELSE businesses.admin_email END,
            aq_status = CASE WHEN excluded.aq_status <> '' THEN excluded.aq_status ELSE businesses.aq_status END,
            aq_evidence = CASE WHEN excluded.aq_status <> '' THEN excluded.aq_evidence ELSE businesses.aq_evidence END,
            aq_policy = CASE WHEN excluded.aq_status <> '' THEN excluded.aq_policy ELSE businesses.aq_policy END,
            aq_updated_at = CASE WHEN excluded.aq_status <> '' THEN excluded.aq_updated_at ELSE businesses.aq_updated_at END,
            bm_users = CASE WHEN excluded.bm_users <> '' THEN excluded.bm_users ELSE businesses.bm_users END,
            fb_created_time = CASE WHEN excluded.fb_created_time <> '' THEN excluded.fb_created_time ELSE businesses.fb_created_time END,
            ad_account_limit = CASE WHEN excluded.ad_account_limit IS NOT NULL THEN excluded.ad_account_limit ELSE businesses.ad_account_limit END,
            updated_at = CURRENT_TIMESTAMP`
        const args = [rec.id, rec.profile_id, rec.business_id, rec.name, rec.verification_status, rec.admin_email, rec.aq_status, rec.aq_evidence, rec.aq_policy, rec.aq_updated_at, rec.bm_users, rec.fb_created_time, rec.ad_account_limit]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.get('/api/businesses', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBusinessesColumns(db)
    await ensureProfilesTable(db)
    const pid = String(req.query && (req.query.profileId || req.query.pid || ''))
    const rows = await new Promise((resolve, reject) => {
      const sql = pid ? `SELECT id, profile_id, business_id, name, verification_status, admin_email, aq_status, aq_evidence, aq_policy, aq_updated_at, bm_users, fb_created_time, ad_account_limit FROM businesses WHERE profile_id = ?` : `SELECT id, profile_id, business_id, name, verification_status, admin_email, aq_status, aq_evidence, aq_policy, aq_updated_at, bm_users, fb_created_time, ad_account_limit FROM businesses`
      const args = pid ? [pid] : []
      db.all(sql, args, (err, rs) => (err ? reject(err) : resolve(rs || [])))
    })
    const profiles = await new Promise((resolve, reject) => {
      db.all(`SELECT id, name FROM profiles`, (err, rs) => (err ? reject(err) : resolve(rs || [])))
    })
    const nameMap = new Map((profiles || []).map(p => [String(p.id), String(p.name || p.id)]))
    const data = (rows || []).map(r => ({
      id: String(r.id || r.business_id || ''),
      profileId: String(r.profile_id || ''),
      profileName: nameMap.get(String(r.profile_id || '')) || '',
      businessId: String(r.business_id || ''),
      name: String(r.name || ''),
      verification_status: String(r.verification_status || ''),
      admin_email: String(r.admin_email || ''),
      // 🩺 账号质量（探测结果，落库后随列表一起返回）
      aq_status: String(r.aq_status || ''),
      aq_evidence: String(r.aq_evidence || ''),
      aq_policy: String(r.aq_policy || ''),
      aq_updated_at: String(r.aq_updated_at || ''),
      // 🩺 BM 成员（邮箱+角色 JSON 字符串，前端自行 parse）
      bm_users: String(r.bm_users || ''),
      // 🩺 BM 创建时间
      fb_created_time: String(r.fb_created_time || ''),
      // 🩺 可创建广告号上限（数字；NULL → 空串）
      ad_account_limit: (r.ad_account_limit == null ? '' : Number(r.ad_account_limit))
    }))
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/businesses/batch-delete', async (req, res) => {
  const ids = req.body && (req.body.business_ids || req.body.businessIds || req.body.ids) || []
  const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBusinessesTable(db)
    for (const bid of list) {
      await new Promise((resolve, reject) => {
        db.run(`DELETE FROM businesses WHERE business_id = ?`, [bid], err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/adaccount-settings/bulk-save', async (req, res) => {
  const payload = req.body && (req.body.items || req.body.data || req.body) || []
  const list = Array.isArray(payload) ? payload : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdAccountSettingsTable(db)
    for (const item of list) {
      const rec = {
        id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
        profile_id: String(item.profileId || item.profile_id || '').trim(),
        account_id: String(item.accountId || item.account_id || ''),
        currency: String(item.currency || ''),
        timezone_id: String(item.timezone_id || item.timezoneId || ''),
        spend_cap: Number(item.spend_cap || 0),
        amount_spent: Number(item.amount_spent || 0),
        account_status: String(item.account_status || ''),
        threshold_amount: Number(item.threshold || item.threshold_amount || 0),
        credit_limit: Number(item.creditLimit || item.credit_limit || 0),
        balance: Number(item.balance || 0),
        funding_source: String(item.fundingSource || item.funding_source || '')
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO ad_account_settings (id, profile_id, account_id, currency, timezone_id, spend_cap, amount_spent, account_status, threshold_amount, credit_limit, balance, funding_source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        const args = [rec.id, rec.profile_id, rec.account_id, rec.currency, rec.timezone_id, rec.spend_cap, rec.amount_spent, rec.account_status, rec.threshold_amount, rec.credit_limit, rec.balance, rec.funding_source]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/billing-methods/bulk-save', async (req, res) => {
  const payload = req.body && (req.body.items || req.body.data || req.body) || []
  const list = Array.isArray(payload) ? payload : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBillingMethodsColumns(db)
    for (const item of list) {
      const rec = {
        id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
        profile_id: String(item.profileId || item.profile_id || '').trim(),
        account_id: String(item.accountId || item.account_id || '').trim(),
        type: String(item.type || ''),
        last4: String(item.last4 || ''),
        brand: String(item.brand || ''),
        exp_month: String(item.exp_month || ''),
        exp_year: String(item.exp_year || ''),
        billing_address: String(item.billing_address || '')
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO billing_methods (id, profile_id, account_id, type, last4, brand, exp_month, exp_year, billing_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        const args = [rec.id, rec.profile_id, rec.account_id, rec.type, rec.last4, rec.brand, rec.exp_month, rec.exp_year, rec.billing_address]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.get('/api/billing-methods', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBillingMethodsColumns(db)
    const rows = await new Promise((resolve, reject) => {
      db.all(`SELECT id, profile_id, account_id, type, last4, brand, exp_month, exp_year, billing_address FROM billing_methods ORDER BY updated_at DESC, created_at DESC`, (err, rs) => (err ? reject(err) : resolve(rs || [])))
    })
    const data = (rows || []).map(r => ({
      id: String(r.id || ''),
      profile_id: String(r.profile_id || ''),
      account_id: String(r.account_id || ''),
      type: String(r.type || ''),
      last4: String(r.last4 || ''),
      brand: String(r.brand || ''),
      exp_month: String(r.exp_month || ''),
      exp_year: String(r.exp_year || ''),
      billing_address: String(r.billing_address || '')
    }))
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

// 🚀 单条信用卡记录保存（供 Puppeteer 服务调用）
app.post('/api/billing-methods/save', async (req, res) => {
  const item = req.body || {}
  if (!item.profile_id || !item.last4) {
    return res.status(400).json({ success: false, message: '缺少 profile_id 或 last4' })
  }
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBillingMethodsColumns(db)
    const rec = {
      id: String(item.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
      profile_id: String(item.profile_id || '').trim(),
      account_id: String(item.account_id || '').trim(),
      type: String(item.type || item.brand || 'Card'),
      last4: String(item.last4 || ''),
      brand: String(item.brand || ''),
      exp_month: String(item.exp_month || ''),
      exp_year: String(item.exp_year || ''),
      billing_address: String(item.billing_address || '')
    }
    await new Promise((resolve, reject) => {
      const sql = `INSERT OR REPLACE INTO billing_methods (id, profile_id, account_id, type, last4, brand, exp_month, exp_year, billing_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      const args = [rec.id, rec.profile_id, rec.account_id, rec.type, rec.last4, rec.brand, rec.exp_month, rec.exp_year, rec.billing_address]
      db.run(sql, args, err => (err ? reject(err) : resolve()))
    })
    res.json({ success: true, id: rec.id })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/billing-methods/batch-delete', async (req, res) => {
  const ids = req.body && (req.body.ids || req.body.id_list || req.body.list) || []
  const last4s = req.body && (req.body.last4s || req.body.last4_list) || []
  const idList = Array.isArray(ids) ? ids.map(String).filter(Boolean) : []
  const l4List = Array.isArray(last4s) ? last4s.map(String).filter(Boolean) : []
  if (!idList.length && !l4List.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBillingMethodsTable(db)
    if (idList.length) {
      for (const bid of idList) {
        await new Promise((resolve, reject) => { db.run(`DELETE FROM billing_methods WHERE id = ?`, [bid], err => (err ? reject(err) : resolve())) })
      }
    }
    if (l4List.length) {
      for (const l4 of l4List) {
        await new Promise((resolve, reject) => { db.run(`DELETE FROM billing_methods WHERE last4 = ?`, [l4], err => (err ? reject(err) : resolve())) })
      }
    }
    res.json({ success: true, count: idList.length + l4List.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/admin/clear-all', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdAccountsTable(db)
    await ensurePagesTable(db)
    await ensureBusinessesTable(db)
    await ensureAdAccountSettingsTable(db)
    await ensureBillingMethodsTable(db)
    await ensureAdInsightsTable(db)
    await ensureProfilesColumns(db)
    const tables = ['ad_accounts','pages','businesses','ad_account_settings','billing_methods','ad_insights','profiles']
    for (const t of tables) {
      await new Promise((resolve) => { db.run(`DELETE FROM ${t}`, [], () => resolve(null)) })
    }
    res.json({ success: true, tables: tables.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/admin/migrate', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProfilesColumns(db)
    await ensureAdAccountsTable(db)
    await ensureAdAccountSettingsTable(db)
    await ensureBillingMethodsTable(db)
    // ad_accounts
    await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(ad_accounts)`, (e, rows) => {
        if (e) return reject(e)
        const names = new Set((rows||[]).map(r => String(r.name)))
        const ops = []
        if (!names.has('threshold_amount')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN threshold_amount REAL`)
        if (!names.has('credit_limit')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN credit_limit REAL`)
        if (!names.has('balance')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN balance REAL`)
        if (!names.has('funding_source')) ops.push(`ALTER TABLE ad_accounts ADD COLUMN funding_source TEXT`)
        let i=0; const runNext=()=>{ if(i>=ops.length) return resolve(null); db.run(ops[i++], err => (err ? reject(err) : runNext())) }
        runNext()
      })
    })
    // ad_account_settings
    await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(ad_account_settings)`, (e, rows) => {
        if (e) return reject(e)
        const names = new Set((rows||[]).map(r => String(r.name)))
        const ops = []
        if (!names.has('threshold_amount')) ops.push(`ALTER TABLE ad_account_settings ADD COLUMN threshold_amount REAL`)
        if (!names.has('credit_limit')) ops.push(`ALTER TABLE ad_account_settings ADD COLUMN credit_limit REAL`)
        if (!names.has('balance')) ops.push(`ALTER TABLE ad_account_settings ADD COLUMN balance REAL`)
        if (!names.has('funding_source')) ops.push(`ALTER TABLE ad_account_settings ADD COLUMN funding_source TEXT`)
        let i=0; const runNext=()=>{ if(i>=ops.length) return resolve(null); db.run(ops[i++], err => (err ? reject(err) : runNext())) }
        runNext()
      })
    })
    // billing_methods
    await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(billing_methods)`, (e, rows) => {
        if (e) return reject(e)
        const names = new Set((rows||[]).map(r => String(r.name)))
        const ops = []
        if (!names.has('brand')) ops.push(`ALTER TABLE billing_methods ADD COLUMN brand TEXT`)
        if (!names.has('exp_month')) ops.push(`ALTER TABLE billing_methods ADD COLUMN exp_month TEXT`)
        if (!names.has('exp_year')) ops.push(`ALTER TABLE billing_methods ADD COLUMN exp_year TEXT`)
        if (!names.has('billing_address')) ops.push(`ALTER TABLE billing_methods ADD COLUMN billing_address TEXT`)
        let i=0; const runNext=()=>{ if(i>=ops.length) return resolve(null); db.run(ops[i++], err => (err ? reject(err) : runNext())) }
        runNext()
      })
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/facebook/tokens', async (req, res) => {
  try {
    const payload = req.body || {}
    const items = Array.isArray(payload) ? payload : (Array.isArray(payload.items || payload.tokens) ? (payload.items || payload.tokens) : [payload])
    if (!items.length) return res.status(400).json({ success: false, message: 'empty' })

    const db = new sqlite3.Database(dbPath)
    try {
      await ensureProfilesColumns(db)
      let updated = 0
      for (const item of items) {
        const pid = String(item.profileId || item.id || '')
        const token = String(item.token || item.accessToken || item.account_tokens || '')
        if (!pid || !token) continue

        await new Promise((resolve, reject) => {
          db.run(`UPDATE profiles SET account_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR ext_id = ?`, [token, pid, pid], function(err) {
            if (err) return reject(err)
            updated += (this.changes || 0)
            resolve()
          })
        })
      }
      res.json({ success: true, updated })
    } catch (e) {
      res.status(500).json({ success: false, message: String(e && e.message || e) })
    } finally {
      db.close()
    }
  } catch (e) {
    res.status(500).json({ success: false, message: String(e && e.message || e) })
  }
})

app.post('/api/facebook/save-tokens', async (req, res) => {
  try {
    const payload = req.body || {}
    const items = Array.isArray(payload) ? payload : (Array.isArray(payload.items || payload.tokens) ? (payload.items || payload.tokens) : [payload])
    if (!items.length) return res.status(400).json({ success: false, message: 'empty' })

    const db = new sqlite3.Database(dbPath)
    try {
      await ensureProfilesColumns(db)
      let updated = 0
      for (const item of items) {
        const pid = String(item.profileId || item.id || '')
        const token = String(item.token || item.accessToken || item.account_tokens || '')
        if (!pid || !token) continue

        await new Promise((resolve, reject) => {
          db.run(`UPDATE profiles SET account_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR ext_id = ?`, [token, pid, pid], function(err) {
            if (err) return reject(err)
            updated += (this.changes || 0)
            resolve()
          })
        })
      }
      res.json({ success: true, updated })
    } catch (e) {
      res.status(500).json({ success: false, message: String(e && e.message || e) })
    } finally {
      db.close()
    }
  } catch (e) {
    res.status(500).json({ success: false, message: String(e && e.message || e) })
  }
})

app.get('/api/debug/token-logs', (req, res) => {
  res.json({ success: true, logs: [] })
})

// Simple fetch polyfill for Node v14
const nodeFetch = (url, options = {}) => new Promise((resolve, reject) => {
  const urlObj = new URL(url);
  const protocol = urlObj.protocol === 'https:' ? https : require('http');
  const req = protocol.request(url, {
    method: options.method || 'GET',
    headers: options.headers || {}
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: () => Promise.resolve(JSON.parse(data)),
        text: () => Promise.resolve(data)
      });
    });
  });
  req.on('error', reject);
  if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  req.end();
});

app.post('/api/fb-api/pages/create', async (req, res) => {
  // Deprecated: 前端已改为走 Puppeteer 自动化真实操作创建 (/api/facebook/pages/create)
  // 保留此接口防止旧版本请求报错，但直接返回需要更新的提示。
  return res.status(400).json({ success: false, message: 'Please use Puppeteer automation API instead.' });
});

app.get('/api/facebook/graph-info', async (req, res) => {
  try {
    const id = String((req.query && (req.query.id || req.query.profileId)) || '')
    const indexStr = String((req.query && req.query.index) || '')
    const db = new sqlite3.Database(dbPath)
    let row = null
    try {
      if (id) {
        row = await new Promise((resolve, reject) => {
          db.get(`SELECT id, name, account_tokens FROM profiles WHERE id = ?`, [id], (err, r) => (err ? reject(err) : resolve(r || null)))
        })
      } else if (indexStr) {
        const idx = Math.max(1, parseInt(indexStr, 10))
        const rows = await new Promise((resolve, reject) => {
          db.all(`SELECT id, name, account_tokens FROM profiles ORDER BY updated_at DESC, created_at DESC`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
        })
        if (rows && rows.length >= idx) row = rows[idx - 1]
      }
    } finally { db.close() }
    if (!row) return res.status(404).json({ success: false, message: 'not_found' })
    const token = String(row.account_tokens || '').trim()
    if (!token) return res.status(404).json({ success: false, message: 'missing_token' })
    const base = 'https://graph.facebook.com/v20.0'
    const qs = (u) => `${u}${u.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
    const user = await (await fetch(qs(`${base}/me?fields=id,name`))).json()
    const pages = await (await fetch(qs(`${base}/me/accounts?fields=id,name,fan_count,category&limit=20`))).json()
    const adAccounts = await (await fetch(qs(`${base}/me/adaccounts?fields=account_id,id,name,account_status,currency,timezone_id&limit=20`))).json()
    const businesses = await (await fetch(qs(`${base}/me/businesses?fields=id,name,verification_status&limit=20`))).json()
    return res.json({ success: true, data: { profile: { id: String(row.id), name: String(row.name || row.id) }, user, pages, adAccounts, businesses } })
  } catch (error) {
    return res.status(500).json({ success: false, message: String(error.message || error) })
  }
})

app.get('/api/facebook/account-limits', async (req, res) => {
  try {
    const profileId = String((req.query && (req.query.profileId || req.query.id)) || '');
    const accountIdRaw = String((req.query && (req.query.accountId || req.query.adAccountId)) || '');
    if (!profileId || !accountIdRaw) return res.status(400).json({ success: false, message: 'missing_params' });
    const db = new sqlite3.Database(dbPath);
    let row = null;
    try {
      row = await new Promise((resolve, reject) => {
        db.get(`SELECT id, name, account_tokens FROM profiles WHERE id = ?`, [profileId], (err, r) => (err ? reject(err) : resolve(r || null)))
      })
    } finally { db.close() }
    if (!row) return res.status(404).json({ success: false, message: 'not_found' });
    const token = String(row.account_tokens || '').trim();
    if (!token) return res.status(404).json({ success: false, message: 'missing_token' });
    const base = 'https://graph.facebook.com/v20.0';
    const qs = (u) => `${u}${u.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    const accId = accountIdRaw.startsWith('act_') ? accountIdRaw : (accountIdRaw.match(/^\d+$/) ? `act_${accountIdRaw}` : accountIdRaw);
    const url = qs(`${base}/${accId}?fields=account_id,id,name,account_status,currency,timezone_id,amount_spent,spend_cap,funding_source_details`);
    const resp = await (await fetch(url)).json();
    // 💰 Meta 金额字段单位是「货币最小单位」，但 spend_cap（限额）按需求「不换算」：
    //    提交时原样写入，读取时也原样返回，保证界面显示值 == 提交值。
    if (resp && typeof resp === 'object' && !resp.error) {
      const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF', 'GNF', 'KMF', 'DJF', 'BIF']);
      const div = ZERO_DECIMAL.has(String(resp.currency || '').trim().toUpperCase()) ? 1 : 100;
      const major = (v) => (v == null || v === '' ? v : Math.round((Number(v) / div) * 100) / 100);
      if (resp.amount_spent != null) resp.amount_spent = major(resp.amount_spent);
      // resp.spend_cap 不换算（原样返回）
      if (resp.balance != null) resp.balance = major(resp.balance);
      if (resp.min_daily_budget != null) resp.min_daily_budget = major(resp.min_daily_budget);
    }
    return res.json({ success: true, data: resp });
  } catch (error) {
    return res.status(500).json({ success: false, message: String(error.message || error) })
  }
})

app.get('/api/profiles/:id', async (req, res) => {
  const { id } = req.params
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProfilesColumns(db)
    const isNumeric = String(id).match(/^\d+$/)
    const row = await new Promise((resolve, reject) => {
      const sql = `SELECT rowid AS rid, ext_id, name, account_name, account_email, account_password, account,
                start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
                proxy_port, proxy_username, proxy_password, account_notes, account_tokens, account_cookies, account_status, platform, startup_urls, seq, updated_at, created_at,
                os, resolution, timezone, language, fb_language,
                fp_canvas, fp_webgl, fp_audio
         FROM profiles WHERE ${isNumeric ? 'rowid = ?' : 'id = ?'}`
      db.get(sql, [id], (err, r) => (err ? reject(err) : resolve(r || null)))
    })
    if (!row) return res.status(404).json({ success: false, message: 'not found' })
    let proxy = null
    if (row.proxy) {
      try { 
        proxy = JSON.parse(row.proxy) 
      } catch { 
        proxy = null 
      }
    }
    
    if (!proxy && row.proxy_host) {
      proxy = {
        type: row.proxy_type || 'http',
        host: row.proxy_host,
        port: row.proxy_port || '8080',
        username: row.proxy_username,
        password: row.proxy_password
      }
    } else if (proxy && row.proxy_host) {
      proxy.type = row.proxy_type || proxy.type || 'http'
      proxy.host = row.proxy_host || proxy.host
      proxy.port = row.proxy_port || proxy.port
      proxy.username = row.proxy_username || proxy.username
      proxy.password = row.proxy_password || proxy.password
    }

    let startupUrls = []
    if (row.startup_urls) {
      try { startupUrls = JSON.parse(row.startup_urls) } catch { startupUrls = [] }
    }
    if (startupUrls.length === 0 && row.start_url) {
      startupUrls = [row.start_url]
    }

    const data = {
      id: String(row.rid),
      name: row.name || String(row.id),
      platform: row.platform || 'Meta (Facebook/Instagram)',
      status: 'Idle',
      accountStatus: row.account_status || 'Unknown',
      userAgent: row.user_agent || '',
      ipAddress: (row.proxy_host || (proxy && proxy.host) || 'N/A'),
      cookiesCount: 0,
      lastActive: 'Never',
      group: '',
      account: { name: row.account_name || row.account, email: row.account_email, password: row.account_password, cookies: row.account_cookies || '' },
      notes: row.account_notes || '',
      token: row.account_tokens || '',
      seq: typeof row.seq === 'number' ? row.seq : undefined,
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
      startupUrls: startupUrls
    }
    data.extId = String(row.ext_id || '')
    if (proxy) { data.proxy = proxy }
    data.proxyEnabled = (!!row.proxy_enabled) || (!!proxy)
    res.json({ success: true, data })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

function mapProfile(p) {
  const acc = p.account || {}
  const proxy = p.proxy || {}
  return {
    ext_id: String((p.extId || p.id || Date.now())),
    name: String(p.name || ''),
    platform: p.platform || 'Meta (Facebook/Instagram)',
    account_name: acc.name || acc.email || '',
    account_email: acc.email || '',
    account_password: acc.password || '',
    account: acc.name || '',
    start_url: Array.isArray(p.startupUrls) && p.startupUrls.length ? String(p.startupUrls[0]) : (p.start_url || p.startUrl || 'https://www.facebook.com/'),
    user_agent: p.userAgent || '',
    proxy_enabled: p.proxyEnabled ? 1 : 0,
    proxy_type: proxy.type || '',
    proxy_host: proxy.host || '',
    proxy_port: proxy.port || '',
    proxy_username: proxy.username || '',
    proxy_password: proxy.password || '',
    proxy: JSON.stringify(proxy || {}),
    account_notes: p.notes || '',
    account_tokens: p.token || '',
    account_cookies: (acc.cookies || ''),
    account_status: p.accountStatus || 'Unknown',
    startup_urls: JSON.stringify(p.startupUrls || []),
    os: p.os || '',
    resolution: p.resolution || '',
    timezone: p.timezone || '',
    language: p.language || '',
    fingerprint_protection: JSON.stringify(p.fingerprintProtection || {}),
    seq: typeof p.seq === 'number' ? p.seq : null,
    pages_count: Number(p.pages_count || p.pagesCount || 0),
    bm_count: Number(p.bm_count || p.bmCount || 0),
    pixels_count: Number(p.pixels_count || p.pixelsCount || 0)
  }
}

async function insertMany(db, list) {
  await ensureProfilesColumns(db)
  let nextSeq = await new Promise((resolve) => {
    try {
      db.get(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM profiles`, [], (e, r) => {
        if (e || !r) return resolve(0)
        resolve(Number(r.max_seq || 0))
      })
    } catch {
      resolve(0)
    }
  })
  nextSeq = Number(nextSeq || 0) + 1

  for (const raw of list) {
    const p = mapProfile(raw)
    // 强制清理 ID，确保 inputId 为字符串或数字
    const inputId = raw.id || raw.rid || raw.rowid || '';
    const isNumericId = inputId && /^\d+$/.test(String(inputId))
    
    console.log(`[STORAGE] Processing profile: inputId=${inputId}, ext_id=${p.ext_id}, name=${p.name}`);

    // 1. 查找现有记录 (明确查找 rid)
    const foundRow = await new Promise((resolve) => {
      try { 
        // 这里的逻辑：如果有数字 ID，优先用数字 ID (rowid) 找；否则只用 ext_id 找
        // 同时我们也检查 ext_id 是否匹配，防止 rowid 漂移（虽然在 SQLite 中 INTEGER PRIMARY KEY 不会漂移）
        let sql = '';
        let args = [];
        if (isNumericId) {
          sql = `SELECT rowid AS rid, seq, ext_id FROM profiles WHERE rowid = ? OR ext_id = ? LIMIT 1`;
          args = [Number(inputId), String(p.ext_id)];
        } else {
          sql = `SELECT rowid AS rid, seq, ext_id FROM profiles WHERE ext_id = ? LIMIT 1`;
          args = [String(p.ext_id)];
        }
        
        db.get(sql, args, (e, r) => {
          if (e) console.error(`[STORAGE] DB Error during find:`, e);
          resolve(r || null);
        }) 
      } catch (err) { 
        console.error(`[STORAGE] Find exception:`, err);
        resolve(null) 
      }
    })

    // 2. 确定 seq
    if (foundRow && typeof foundRow.seq === 'number') {
      p.seq = foundRow.seq
    } else if (typeof p.seq !== 'number') {
      p.seq = nextSeq
      nextSeq++
    }

    if (foundRow && foundRow.rid) {
      // 3. 执行更新 (UPDATE) - 使用 rowid 准确定位
      console.log(`[STORAGE] Action: UPDATE, rid=${foundRow.rid}, old_ext_id=${foundRow.ext_id}, new_ext_id=${p.ext_id}`);
      await new Promise((resolve, reject) => {
        const sql = `UPDATE profiles SET 
          ext_id=?, name=?, platform=?, account_name=?, account_email=?, account_password=?, account=?,
          start_url=?, user_agent=?, proxy=?, proxy_enabled=?, proxy_type=?, proxy_host=?,
          proxy_port=?, proxy_username=?, proxy_password=?, account_notes=?, account_tokens=?, account_cookies=?, account_status=?, startup_urls=?, seq=?, os=?, resolution=?, timezone=?, language=?, fingerprint_protection=?, pages_count=?, bm_count=?, pixels_count=?, updated_at=CURRENT_TIMESTAMP
          WHERE rowid = ?`
        const args = [
          p.ext_id, p.name, p.platform, p.account_name, p.account_email, p.account_password, p.account,
          p.start_url, p.user_agent, p.proxy, p.proxy_enabled, p.proxy_type, p.proxy_host,
          p.proxy_port, p.proxy_username, p.proxy_password, p.account_notes, p.account_tokens, p.account_cookies, p.account_status, p.startup_urls, p.seq,
          p.os, p.resolution, p.timezone, p.language, p.fingerprint_protection,
          p.pages_count, p.bm_count, p.pixels_count,
          foundRow.rid
        ]
        db.run(sql, args, function(err) {
          if (err) {
            console.error(`[STORAGE] Update error:`, err);
            reject(err);
          } else {
            console.log(`[STORAGE] Update success, changes: ${this.changes}`);
            resolve();
          }
        })
      })
    } else {
      // 4. 执行插入 (INSERT)
      console.log(`[STORAGE] Action: INSERT, ext_id=${p.ext_id}`);
      await new Promise((resolve, reject) => {
        // 列清单：ext_id(1), name(2), platform(3), account_name(4), account_email(5), account_password(6), account(7), start_url(8), user_agent(9), proxy(10), proxy_enabled(11), proxy_type(12), proxy_host(13), proxy_port(14), proxy_username(15), proxy_password(16), account_notes(17), account_tokens(18), account_cookies(19), account_status(20), startup_urls(21), seq(22), os(23), resolution(24), timezone(25), language(26), fingerprint_protection(27), pages_count(28), bm_count(29), pixels_count(30), updated_at(使用 CURRENT_TIMESTAMP)
        const sql = `INSERT INTO profiles (
          ext_id, name, platform, account_name, account_email, account_password, account,
          start_url, user_agent, proxy, proxy_enabled, proxy_type, proxy_host,
          proxy_port, proxy_username, proxy_password, account_notes, account_tokens, account_cookies, account_status, startup_urls, seq, os, resolution, timezone, language, fingerprint_protection, pages_count, bm_count, pixels_count, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
        )`
        const args = [
          p.ext_id, p.name, p.platform, p.account_name, p.account_email, p.account_password, p.account,
          p.start_url, p.user_agent, p.proxy, p.proxy_enabled, p.proxy_type, p.proxy_host,
          p.proxy_port, p.proxy_username, p.proxy_password, p.account_notes, p.account_tokens, p.account_cookies, p.account_status, p.startup_urls, p.seq,
          p.os, p.resolution, p.timezone, p.language, p.fingerprint_protection,
          p.pages_count, p.bm_count, p.pixels_count
        ]
        db.run(sql, args, function(err) {
          if (err) {
            console.error(`[STORAGE] Insert error:`, err);
            reject(err);
          } else {
            console.log(`[STORAGE] Insert success, new rowid: ${this.lastID}`);
            resolve();
          }
        })
      })
    }
  }
}

async function insertAdAccountsMany(db, list) {
  await ensureAdAccountsColumns(db)
  await new Promise((resolve) => {
    try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_accounts_profile_account ON ad_accounts(profile_id, account_id)`, () => resolve()) } catch { resolve() }
  })
  for (const item of list) {
    const rec = {
      profile_id: String(item.profileId || item.profile_id || ''),
      platform: String(item.platform || 'Meta (Facebook/Instagram)'),
      account_id: String(item.adAccountId || item.account_id || ''),
      name: String(item.name || item.profileName || item.profile_name || ''),
      status: String(item.adAccountStatus || item.status || item.account_status || 'Unknown'),
      currency: String(item.currency || ''),
      timezone_id: String(item.timezone_id || item.timezoneId || ''),
      spend: Number(item.spend || 0),
      account: String(item.account || ''),
      profile_name: String(item.profile_name || item.profileName || ''),
      country: String(item.country || ''),
      threshold_amount: Number(item.threshold || 0),
      credit_limit: Number(item.creditLimit || item.spendCap || 0),
      balance: Number(item.balance || 0),
      funding_source: String(item.fundingSource || ''),
      pages_count: Number(item.pagesCount || 0),
      bm_count: Number(item.bmCount || 0),
      pixels_count: Number(item.pixelsCount || item.pixels_count || 0)
    }
    if (!rec.account_id) continue
    await new Promise((resolve, reject) => {
      const sql = `INSERT INTO ad_accounts (
        profile_id, platform, account_id, name, status, currency, timezone_id, spend, account, profile_name,
        country, threshold_amount, credit_limit, balance, funding_source, pages_count, bm_count, pixels_count, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      )
      ON CONFLICT(profile_id, account_id) DO UPDATE SET
        name=excluded.name,
        status=excluded.status,
        currency=excluded.currency,
        timezone_id=excluded.timezone_id,
        spend=excluded.spend,
        account=excluded.account,
        profile_name=excluded.profile_name,
        country=excluded.country,
        threshold_amount=excluded.threshold_amount,
        credit_limit=excluded.credit_limit,
        balance=excluded.balance,
        funding_source=excluded.funding_source,
        pages_count=excluded.pages_count,
        bm_count=excluded.bm_count,
        pixels_count=excluded.pixels_count,
        updated_at=CURRENT_TIMESTAMP`
      const args = [
        rec.profile_id, rec.platform, rec.account_id, rec.name, rec.status, rec.currency, rec.timezone_id, rec.spend, rec.account, rec.profile_name,
        rec.country, rec.threshold_amount, rec.credit_limit, rec.balance, rec.funding_source, rec.pages_count, rec.bm_count, rec.pixels_count
      ]
      db.run(sql, args, err => (err ? reject(err) : resolve()))
    })
  }
}

app.post('/api/profiles', async (req, res) => {
  const payload = Array.isArray(req.body) ? req.body : [req.body]
  console.log(`[STORAGE] Received ${payload.length} profiles to insert`);
  const db = new sqlite3.Database(dbPath)
  try {
    await insertMany(db, payload)
    const ids = await new Promise((resolve, reject) => {
      db.all(`SELECT id, ext_id FROM profiles ORDER BY updated_at DESC LIMIT ?`, [payload.length], (e, rs) => {
        if (e) reject(e);
        else resolve(rs || []);
      })
    })
    console.log(`[STORAGE] Successfully inserted. Returning IDs:`, ids);
    res.json({ success: true, count: payload.length, ids })
  } catch (error) {
    console.error(`[STORAGE] Error inserting profiles:`, error);
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/profiles/update-account-status', async (req, res) => {
  const items = (req.body && (req.body.items || req.body)) || []
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureProfilesColumns(db)
    for (const it of items) {
      const id = String(it.id || it.profileId || '')
      const status = String(it.accountStatus || it.status || 'Unknown')
      if (!id) continue
      await new Promise((resolve, reject) => {
        db.run(`UPDATE profiles SET account_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, id], err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: items.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/adaccounts/bulk-save', async (req, res) => {
  const payload = req.body && (req.body.items || req.body.adAccounts || req.body.data || req.body)
  const list = Array.isArray(payload) ? payload : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdAccountsColumns(db)
    
    // 🚀 核心优化：统一字段映射，确保不管前端/后端发送什么字段名都能正确保存
    const normalizedList = list.map(item => ({
      profileId: String(item.profileId || item.profile_id || '').trim(),
      platform: String(item.platform || 'facebook'),
      adAccountId: String(item.adAccountId || item.account_id || ''),
      name: String(item.name || item.adAccountName || ''),
      adAccountStatus: String(item.adAccountStatus || item.account_status || item.status || 'Unknown'),
      currency: String(item.currency || ''),
      timezone_id: String(item.timezone_id || item.timezoneId || ''),
      spend: Number(item.spend || item.amount_spent || 0),
      account: String(item.account || item.account_name || ''),
      profile_name: String(item.profile_name || item.profileName || ''),
      country: String(item.country || item.business_country_code || ''),
      threshold: Number(item.threshold || item.threshold_amount || item.spend_cap || 0),
      creditLimit: Number(item.creditLimit || item.credit_limit || item.adtrust_dsl || 0),
      balance: Number(item.balance || 0),
      fundingSource: String(item.fundingSource || item.funding_source || ''),
      pagesCount: Number(item.pagesCount || item.pages_count || 0),
      bmCount: Number(item.bmCount || item.bm_count || 0),
      pixelsCount: Number(item.pixelsCount || item.pixels_count || 0)
    }));

    await insertAdAccountsMany(db, normalizedList)
    
    res.json({ success: true, count: normalizedList.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/adaccounts/batch-delete', async (req, res) => {
  const ids = req.body && (req.body.ids || req.body.account_ids || req.body.accountIds) || []
  const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : []
  if (!list.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureAdAccountsTable(db)
    for (const aid of list) {
      // 删除广告账户主表
      await new Promise((resolve, reject) => { db.run(`DELETE FROM ad_accounts WHERE account_id = ?`, [aid], err => (err ? reject(err) : resolve())) })
      // 级联删除设置、报表、支付方式（按 account_id）
      await new Promise((resolve) => { db.run(`DELETE FROM ad_account_settings WHERE account_id = ?`, [aid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM ad_insights WHERE account_id = ?`, [aid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM billing_methods WHERE account_id = ?`, [aid], () => resolve(null)) })
    }
    res.json({ success: true, count: list.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally { db.close() }
})

app.post('/api/profiles/bulk-save', async (req, res) => {
  const payload = req.body && req.body.profiles ? req.body.profiles : []
  if (!Array.isArray(payload) || payload.length === 0) return res.status(400).json({ success: false, message: 'empty' })
  console.log(`[${new Date().toISOString()}] [INFO] Bulk save requested for ${payload.length} profiles`);
  const db = new sqlite3.Database(dbPath)
  try {
    await insertMany(db, payload)
    console.log(`[${new Date().toISOString()}] [INFO] Bulk save completed for ${payload.length} profiles`);

    // 🚀 同步至 Cloudflare D1 线上数据库
    try {
      const d1Url = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
      const apiSecret = process.env.PUPPETEER_API_SECRET || '';
      console.log(`[${new Date().toISOString()}] [INFO] D1 Sync: Sending ${payload.length} profiles to ${d1Url}/api/profiles/bulk-save`);
      
      const d1Resp = await fetch(`${d1Url}/api/profiles/bulk-save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Secret': apiSecret
        },
        body: JSON.stringify({ profiles: payload, items: payload })
      });
      const d1Result = await d1Resp.text();
      console.log(`[${new Date().toISOString()}] [INFO] D1 Sync result: ${d1Resp.status} ${d1Result.substring(0, 200)}`);
    } catch (d1Err) {
      // 云端同步失败不应阻断本地操作
      console.warn(`[${new Date().toISOString()}] [WARN] D1 Sync failed (local save already succeeded): ${d1Err.message}`);
    }

    res.json({ success: true, count: payload.length })
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [ERROR] Bulk save failed:`, error.message || error);
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

// 🌐 批量更新 FB 语言（仅更新 fb_language 列，不覆盖其他字段）
app.post('/api/profiles/batch-update-fb-language', async (req, res) => {
  const { ids, fbLanguage } = req.body || {}
  if (!Array.isArray(ids) || ids.length === 0 || !fbLanguage) {
    return res.status(400).json({ success: false, message: '缺少 ids 或 fbLanguage 参数' })
  }
  const db = new sqlite3.Database(dbPath)
  try {
    await new Promise((resolve, reject) => {
      db.run(`UPDATE profiles SET fb_language = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [fbLanguage, ids[0]], function(err) {
        if (err) return reject(err)
        resolve(null)
      })
    })
    if (ids.length > 1) {
      const placeholders = ids.slice(1).map(() => '?').join(',')
      const sql = `UPDATE profiles SET fb_language = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
      await new Promise((resolve, reject) => {
        db.run(sql, [fbLanguage, ...ids.slice(1)], function(err) {
          if (err) return reject(err)
          resolve(null)
        })
      })
    }
    res.json({ success: true, count: ids.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/profiles/batch-delete', async (req, res) => {
  const ids = req.body && req.body.ids ? req.body.ids : []
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT,
        platform TEXT,
        account_name TEXT,
        account_email TEXT,
        account_password TEXT,
        account TEXT,
        start_url TEXT,
        user_agent TEXT,
        proxy TEXT,
        proxy_enabled INTEGER,
        proxy_type TEXT,
        proxy_host TEXT,
        proxy_port TEXT,
        proxy_username TEXT,
        proxy_password TEXT,
        account_notes TEXT,
        account_cookies TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, err => (err ? reject(err) : resolve()))
    })
    for (const id of ids) {
      const pid = String(id)
      // 删除配置
      await new Promise((resolve, reject) => { db.run(`DELETE FROM profiles WHERE id = ?`, [pid], err => (err ? reject(err) : resolve())) })
      // 级联删除资产
      await new Promise((resolve) => { db.run(`DELETE FROM ad_accounts WHERE profile_id = ?`, [pid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM pages WHERE profile_id = ?`, [pid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM businesses WHERE profile_id = ?`, [pid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM ad_account_settings WHERE profile_id = ?`, [pid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM billing_methods WHERE profile_id = ?`, [pid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM ad_insights WHERE profile_id = ?`, [pid], () => resolve(null)) })
      // 🐛 补齐贴文/对话/广告：广告投放在用的贴文和主页 timeline 贴文都存在同一张 page_posts 里
      //    （靠 source 字段区分 page / page,ad），以前这几张表没级联 → 删了配置还残留贴文数据。
      await new Promise((resolve) => { db.run(`DELETE FROM page_posts WHERE profile_id = ?`, [pid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM page_conversations WHERE profile_id = ?`, [pid], () => resolve(null)) })
      await new Promise((resolve) => { db.run(`DELETE FROM ads WHERE profile_id = ?`, [pid], () => resolve(null)) })
    }
    res.json({ success: true, count: ids.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim()
  if (Array.isArray(xf) && xf.length) return String(xf[0])
  const xr = req.headers['x-real-ip']
  if (typeof xr === 'string' && xr.length) return xr.trim()
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.length) return cf.trim()
  const raw = String((req.socket && req.socket.remoteAddress) || req.ip || '')
  if (!raw) return ''
  const m = raw.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/)
  return m ? m[1] : raw
}

app.post('/api/analytics/events', async (req, res) => {
  const raw = req.body && (req.body.items || req.body.events || req.body.data || req.body)
  const list = Array.isArray(raw) ? raw : [raw]
  const ipFromHeader = getClientIp(req)
  const events = list.filter(Boolean).map(e => ({
    id: String(e && e.id ? e.id : `${Date.now()}_${Math.random().toString(36).slice(2)}`),
    event_name: String(e && e.event_name ? e.event_name : 'nav'),
    from_tab: String(e && e.from_tab ? e.from_tab : ''),
    to_tab: String(e && e.to_tab ? e.to_tab : ''),
    user_agent: String(e && e.user_agent ? e.user_agent : ''),
    locale: String(e && e.locale ? e.locale : ''),
    ip: String(e && e.ip ? e.ip : ipFromHeader || ''),
    extra: JSON.stringify(e && e.extra ? e.extra : {})
  }))
  if (!events.length) return res.status(400).json({ success: false, message: 'empty' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureEventsTable(db)
    await ensureBlacklistTable(db)
    const blockedIps = await new Promise((resolve, reject) => {
      db.all(`SELECT ip FROM ip_blacklist`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
    })
    const blockedSet = new Set((blockedIps || []).map(r => String(r.ip)))
    for (const ev of events) {
      if (ev.ip && blockedSet.has(ev.ip)) {
        continue
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO events (
          id, event_name, from_tab, to_tab, user_agent, locale, ip, extra
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?
        )`
        const args = [ev.id, ev.event_name, ev.from_tab, ev.to_tab, ev.user_agent, ev.locale, ev.ip, ev.extra]
        db.run(sql, args, err => (err ? reject(err) : resolve()))
      })
    }
    res.json({ success: true, count: events.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.get('/api/analytics/events', async (req, res) => {
  const limit = Number(req.query.limit || 100)
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureEventsTable(db)
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT rowid AS seq, id, event_name, from_tab, to_tab, user_agent, locale, ip, extra, created_at FROM events ORDER BY created_at DESC LIMIT ?`,
        [limit],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      )
    })
    const data = rows.map(r => ({
      seq: Number(r.seq || 0),
      id: String(r.id),
      event_name: String(r.event_name || ''),
      from_tab: String(r.from_tab || ''),
      to_tab: String(r.to_tab || ''),
      user_agent: String(r.user_agent || ''),
      locale: String(r.locale || ''),
      ip: String(r.ip || ''),
      extra: (() => { try { return JSON.parse(r.extra || '{}') } catch { return {} } })(),
      created_at: String(r.created_at || '')
    }))
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.get('/api/analytics/blacklist', async (req, res) => {
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBlacklistTable(db)
    const rows = await new Promise((resolve, reject) => {
      db.all(`SELECT ip, reason, created_at FROM ip_blacklist ORDER BY created_at DESC`, (err, rows) => (err ? reject(err) : resolve(rows || [])))
    })
    const data = (rows || []).map(r => ({ ip: String(r.ip || ''), reason: String(r.reason || ''), created_at: String(r.created_at || '') }))
    res.json({ success: true, data, total: data.length })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.post('/api/analytics/blacklist', async (req, res) => {
  const ip = String(req.body && (req.body.ip || req.body.target || '') || '')
  const reason = String(req.body && (req.body.reason || '') || '')
  if (!ip) return res.status(400).json({ success: false, message: 'ip required' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBlacklistTable(db)
    await new Promise((resolve, reject) => {
      db.run(`INSERT OR REPLACE INTO ip_blacklist (ip, reason) VALUES (?, ?)`, [ip, reason], err => (err ? reject(err) : resolve()))
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

app.delete('/api/analytics/blacklist/:ip', async (req, res) => {
  const ip = String(req.params && req.params.ip || '')
  if (!ip) return res.status(400).json({ success: false, message: 'ip required' })
  const db = new sqlite3.Database(dbPath)
  try {
    await ensureBlacklistTable(db)
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM ip_blacklist WHERE ip = ?`, [ip], err => (err ? reject(err) : resolve()))
    })
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, message: String(error.message || error) })
  } finally {
    db.close()
  }
})

// 🚀 V5.4.0: 新增接码平台代理接口，解决跨域问题并统一请求
app.all('/api/sms-proxy', async (req, res) => {
  const { targetUrl, method = 'GET', body, headers = {} } = req.body || req.query || {};
  const url = targetUrl || req.query.url;
  
  if (!url) return res.status(400).json({ success: false, message: 'Missing targetUrl' });

  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    if (method !== 'GET' && body) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const resp = await fetch(url, options);
    const text = await resp.text();
    
    // 尝试解析 JSON，如果不是则返回原始文本
    try {
      const json = JSON.parse(text);
      res.json({ success: true, data: json });
    } catch {
      res.json({ success: true, data: text });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[${new Date().toISOString()}] [INFO] 🚀 Storage API Server V5.6.6 running on port ${PORT}`)
  console.log(`[${new Date().toISOString()}] [INFO] 📂 Database path: ${dbPath}`)
  
  // Initialize database schema
  const db = new sqlite3.Database(dbPath);
  try {
    await ensureProfilesColumns(db);
    console.log(`[${new Date().toISOString()}] [INFO] ✅ Database schema initialized`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [ERROR] Database initialization failed: ${err.message}`);
  } finally {
    db.close();
  }
})
app.post('/api/analytics/events', async (req, res) => {
  try {
    const payload = req.body || {}
    res.json({ success: true, received: !!payload })
  } catch (e) {
    res.status(500).json({ success: false, message: String(e && e.message || e) })
  }
})
