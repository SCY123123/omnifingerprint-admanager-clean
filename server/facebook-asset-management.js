'use strict';

// ============================================================
// Facebook 资产管理（BM/Pages/AdAccount 操作）
// ============================================================

// 📋 注入的依赖
let _log = () => {};
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _activeBrowsers = new Map();
let _findProfileById = null;
let _callFacebookGraphApi = null;
let _ensureBrowserIsRunning = async () => ({ success: false, error: '__inject not called' });
let _PORT = 0;
let _API_SECRET = '';
let _APP_ROOT = '';
let _dbPath = '';
let _app = null;

/**
 * 注入主文件的依赖到资产管理模块
 */
function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.sleep) _sleep = deps.sleep;
  if (deps.activeBrowsers) _activeBrowsers = deps.activeBrowsers;
  if (deps.findProfileById) _findProfileById = deps.findProfileById;
  if (deps.callFacebookGraphApi) _callFacebookGraphApi = deps.callFacebookGraphApi;
  if (deps.ensureBrowserIsRunning) _ensureBrowserIsRunning = deps.ensureBrowserIsRunning;
  if (deps.PORT !== undefined) _PORT = deps.PORT;
  if (deps.API_SECRET) _API_SECRET = deps.API_SECRET;
  if (deps.APP_ROOT) _APP_ROOT = deps.APP_ROOT;
  if (deps.dbPath) _dbPath = deps.dbPath;
  if (deps.app) _app = deps.app;
}

const log = (...args) => _log(...args);
const sleep = (ms) => _sleep(ms);
const findProfileById = (...args) => _findProfileById(...args);
const callFacebookGraphApi = (...args) => _callFacebookGraphApi(...args);
const ensureBrowserIsRunning = (...args) => _ensureBrowserIsRunning(...args);

// 🛡️ 读出该 BM 当前的「活跃管理员」id 集合 —— 用于自我保护（不允许把最后一个管理员降级/移除）。
//    ⚠️ 失败时返回空集合 → 上层会跳过保护（宁可放行也不误拦），并打日志。
async function fetchActiveAdminIds(businessId, profile, token) {
  const ids = new Set();
  try {
    const r = await callFacebookGraphApi(`${businessId}?fields=business_users{id,role,active_status}`, 'GET', null, profile, token);
    (((r && r.business_users && r.business_users.data) || [])).forEach(u => {
      const role = String(u.role || '').toUpperCase();
      const status = String(u.active_status || 'ACTIVE').toUpperCase();
      if (role === 'ADMIN' && status === 'ACTIVE') ids.add(String(u.id));
    });
  } catch (e) {
    log('WARN', `[BM用户] 读取管理员列表失败，跳过自我保护校验: ${e.message}`);
  }
  return ids;
}

// 🆕 广告号命名/账单信息的生成素材（与前端 AssetViewer、BMOperationsDialog 的随机数据保持一致）
const RANDOM_AD_NAMES = [
  'Eco Life', 'Tech Trends', 'Daily Joy', 'Green Garden', 'Smart Home',
  'Fashion Hub', 'Pet Paradise', 'Foodie Adventure', 'Fitness First', 'Travel Guide',
  'Artistic Soul', 'Music Magic', 'Gaming World', 'Movie Night', 'Book Worm',
  'Future Vision', 'Ocean Breeze', 'Mountain Peak', 'Urban Style', 'Zen Master',
  'Bright Studio', 'Prime Media', 'Elite Commerce', 'Global Trade', 'Apex Digital',
  'Nova Solutions', 'Vertex Labs', 'Quantum Edge', 'Stellar Works', 'Crystal Bloom',
];
const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'];
const BILL_RANDOM_STREETS = ['Main St', 'Oak Ave', 'Elm St', 'Park Rd', 'Broadway', 'Lake Dr', 'Hill St', 'Cedar Ln', 'Maple Ave', 'River Rd', 'Pine St', 'Washington Blvd', 'Sunset Blvd', 'Madison Ave', 'Lincoln St'];
const BILL_RANDOM_CITIES = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Austin', 'Miami', 'Denver', 'Seattle', 'Portland', 'Atlanta', 'Boston', 'Nashville', 'Detroit'];
const BILL_RANDOM_ZIPS = ['10001', '90001', '60601', '77001', '85001', '19101', '78201', '92101', '75201', '73301', '33101', '80201', '98101', '97201', '30301', '02101', '37201', '48201'];

const _pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * 🆕 广告号名称 —— 必须在「真正执行创建」这一刻才算，不能在提交时就固定下来。
 *    mode: manual=手填 / random=随机 / timestamp=本机时间戳（年月日时分秒）
 *    seq>0 表示同一批的第 2 个起，追加 _2、_3 避免重名
 */
function buildAdAccountName(mode, manual, seq = 0) {
  const m = String(mode || 'manual');
  if (m === 'random') return `${_pickRandom(RANDOM_AD_NAMES)} ${Math.floor(1000 + Math.random() * 9000)}`;
  if (m === 'timestamp') {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return seq > 0 ? `${ts}_${seq + 1}` : ts;
  }
  return String(manual || '').trim();
}

/**
 * 🆕 把前端传来的账单参数（手填值 + 随机开关）解析成 change-currency-timezone 认识的字段。
 *    随机在这里做：每次执行随机一份，同一批广告号共用同一份地址。
 */
function resolveAdBilling(src) {
  const b = src || {};
  return {
    country: String(b.country || '').trim(),
    address: b.randomStreet ? `${Math.floor(Math.random() * 9000 + 1000)} ${_pickRandom(BILL_RANDOM_STREETS)}` : String(b.street || '').trim(),
    city: b.randomCity ? _pickRandom(BILL_RANDOM_CITIES) : String(b.city || '').trim(),
    zip: b.randomZip ? _pickRandom(BILL_RANDOM_ZIPS) : String(b.zip || '').trim(),
    state: b.randomState ? _pickRandom(US_STATES) : String(b.state || '').trim(),
    business_name: String(b.company || '').trim(),
  };
}

/**
 * 🆕 广告号账单信息写入（国家/街道/城市/州/邮编/公司）—— 串行版。
 *    Meta 在创建广告号时（POST /{bm}/adaccount）不支持账单地址/公司，只能创建成功后
 *    复用现成的「改账单」流程补写 —— 它走浏览器自动化，多个广告号共用一次浏览器。
 *    payload 传 resolveAdBilling() 的结果；全空则返回 null（调用方据此跳过）。
 *
 *    ⚠️ 以前这里外面还包了一层 `fireAdAccountsBilling`：`setTimeout(4s)` 后 fire-and-forget 发请求。
 *    为什么必须去掉：那 4 秒根本不够 —— 创建流程这时还在收尾、正准备关自己的浏览器，
 *    而账单接口内部又会为**同一个 profile** 拉起一个浏览器，于是撞上 browser-routes 的
 *    「启动前强制关闭该 profile 残留实例」，把正在用的那个关掉 → 页面 frame 被 detach，
 *    账单必然失败（日志里的 `Attempted to use detached Frame`）。
 *    现在由调用方 await，并且**必须在创建流程的浏览器关闭之后**才调，
 *    也就是「创建完成 → 再单独改账单」，绝不并发。
 */
async function applyAdAccountsBilling(profileId, adAccountIds, payload) {
  const p = payload || {};
  const ids = (adAccountIds || []).map(String).filter(Boolean);
  if (ids.length === 0 || !Object.values(p).some(Boolean)) return null;
  try {
    const resp = await fetch(`http://127.0.0.1:${_PORT}/api/facebook/adaccounts/change-currency-timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': _API_SECRET || '' },
      body: JSON.stringify({ profileId, adAccountIds: ids, ...p }),
    });
    const j = await resp.json().catch(() => ({}));
    return { success: !!j.success, message: String(j.message || (j.success ? '账单信息已写入' : '账单信息写入失败')) };
  } catch (e) {
    return { success: false, message: `账单信息写入异常: ${String((e && e.message) || e)}` };
  }
}

/**
 * 🆕 账单信息「串行写入」：由调用方 await，并且**必须在创建流程的浏览器关闭之后**调用。
 *    写一次要 30~90s（浏览器自动化填 tax 表单），所以它会明显拖长创建请求的耗时 ——
 *    这是刻意接受的代价：以前为了「不阻塞创建结果」把它放到后台 setTimeout 偷跑，
 *    结果和创建流程的浏览器收尾撞车、账单 100% 写不进去（详见 applyAdAccountsBilling 的注释）。
 *    宁可慢一点、写对，也不要快而写不上。
 *    返回写入结果（{success, message}）或 null（没东西要写）。
 */
async function writeAdAccountsBillingSerial(profileId, adAccountIds, billingSrc, tag) {
  const payload = resolveAdBilling(billingSrc);
  const ids = (adAccountIds || []).map(String).filter(Boolean);
  if (ids.length === 0 || !Object.values(payload).some(Boolean)) return null;
  let r = null;
  try {
    r = await applyAdAccountsBilling(profileId, ids, payload);
  } catch (e) {
    r = { success: false, message: `账单信息写入异常: ${String((e && e.message) || e)}` };
  }
  if (r) log(r.success ? 'INFO' : 'WARN', `📮 [${tag}] 账单信息写入: ${r.message}`);
  return r;
}

/**
 * 注册所有资产管理路由
 */
function registerRoutes() {
  if (!_app) return;

  // ============================================================
  // 🆕 8大资产管理方法集成（从 bookmarklet 分析转化而来）
  // ============================================================

  // -------------------------------------------------------
  // 1. 授权主页给 BM (Graph API)
  // POST /api/facebook/businesses/grant-page
  // Body: { profileId, pageId, businessId, accessToken }
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/grant-page', async (req, res) => {
    try {
      const { profileId, pageId, businessId, accessToken } = req.body || {};
      if (!profileId || !pageId || !businessId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, pageId, businessId' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }
      log('INFO', `📌 授权主页 ${pageId} 给 BM ${businessId}`);

      // 方式一：添加为 owned_page
      const formData = new URLSearchParams();
      formData.append('page_id', pageId);
      formData.append('access_token', effectiveToken);

      let result;
      try {
        result = await callFacebookGraphApi(`${businessId}/owned_pages`, 'POST', formData, profile, effectiveToken);
      } catch (e) {
        log('WARN', `owned_pages 失败，尝试 client_pages: ${e.message}`);
        formData.append('permitted_tasks', JSON.stringify(['ADVERTISE', 'ANALYZE', 'MANAGE']));
        result = await callFacebookGraphApi(`${businessId}/client_pages`, 'POST', formData, profile, effectiveToken);
      }

      if (result && result.id) {
        return res.json({ success: true, message: '主页已成功授权给 BM', pageId, businessId });
      }
      const errMsg = result?.error?.message || result?.error_user_msg || '未知错误';
      return res.status(500).json({ success: false, message: `授权失败: ${errMsg}`, detail: result?.error });
    } catch (err) {
      log('ERROR', `授权主页给 BM 异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 2. 授权广告号用户/给用户添加广告号权限 (Graph API)
  // POST /api/facebook/adaccounts/assign-user
  // Body: { profileId, adAccountId, businessUserId, tasks, accessToken }
  // -------------------------------------------------------
  _app.post('/api/facebook/adaccounts/assign-user', async (req, res) => {
    try {
      const { profileId, adAccountId, businessUserId, tasks, accessToken } = req.body || {};
      if (!profileId || !adAccountId || !businessUserId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, adAccountId, businessUserId' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      const userTasks = tasks || ['ANALYZE', 'ADVERTISE', 'MANAGE'];
      log('INFO', `📌 授权广告号 ${adAccountId} 给用户 ${businessUserId}, 任务: ${userTasks.join(',')}`);

      const formData = new URLSearchParams();
      formData.append('user', businessUserId);
      formData.append('tasks', JSON.stringify(userTasks));
      formData.append('access_token', effectiveToken);

      const result = await callFacebookGraphApi(`${adAccountId}/assigned_users`, 'POST', formData, profile, effectiveToken);

      if (result && result.success !== false) {
        return res.json({ success: true, message: '广告号权限已授权', adAccountId, businessUserId });
      }
      const errMsg = result?.error?.message || result?.error_user_msg || '未知错误';
      return res.status(500).json({ success: false, message: `授权失败: ${errMsg}`, detail: result?.error });
    } catch (err) {
      log('ERROR', `授权广告号用户异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 3. BM 创建广告号 (Graph API)
  // POST /api/facebook/businesses/create-adaccount
  // Body: { profileId, businessId, name, timezoneId, currency, count, createPixel, assignAdmin, accessToken }
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/create-adaccount', async (req, res) => {
    try {
      const {
        profileId, businessId, name, timezoneId = 0, currency = 'USD',
        count = 1, createPixel = false, assignAdmin = false, accessToken,
        adNameMode = 'manual',   // 🆕 手填 / 随机 / 时间戳（名称在后端真正创建那一刻才生成）
        adNameManual,            // 🆕 手填模式下的名称
        adBilling,               // 🆕 账单参数（手填值 + 随机开关）
      } = req.body || {};
      if (!profileId || !businessId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, businessId' });
      }
      // 手填模式必须给名称；随机/时间戳模式由后端在执行时生成
      if (String(adNameMode) === 'manual' && !String(adNameManual || name || '').trim()) {
        return res.status(400).json({ success: false, message: '缺少必要参数: 广告号名称' });
      }
      // 🐛 timezoneId 以前默认 0 直接透传给 Meta（POST /{bm}/adaccount 只认有效时区枚举，从 1 起），
      //    报出来的是 Meta 那句很难懂的 (#100) Must include a valid timezone ID。
      //    这里提前拦住，给出能直接定位的报错。
      const tzNum = Number(timezoneId);
      if (!Number.isFinite(tzNum) || tzNum < 1) {
        return res.status(400).json({ success: false, message: `timezoneId 无效（${timezoneId}）：必须是 Meta 广告号时区枚举，从 1 开始` });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      log('INFO', `📌 BM ${businessId} 创建 ${count} 个广告号, 名称前缀: ${name}`);

      // 如需自动设为管理员，先获取当前用户在 BM 中的 business_user_id
      let businessUserId = null;
      if (assignAdmin) {
        try {
          const meResult = await callFacebookGraphApi(`me?fields=id,business_users.business(${businessId})`, 'GET', null, profile, effectiveToken);
          if (meResult?.business_users?.data?.[0]?.id) {
            businessUserId = meResult.business_users.data[0].id;
          }
        } catch (e) {
          log('WARN', `获取 business_user_id 失败，跳过自动授权: ${e.message}`);
        }
      }

      const createdAccounts = [];
      for (let i = 1; i <= count; i++) {
        // 🆕 名称在执行到这一行时才生成（时间戳取当下，不是提交时）；手填且多个时追加序号
        const accName = buildAdAccountName(adNameMode, adNameManual || name, i - 1)
          || (count > 1 ? `${name} ${i}` : name);
        const formData = new URLSearchParams();
        formData.append('name', accName);
        formData.append('timezone_id', String(timezoneId));
        formData.append('currency', currency);
        formData.append('end_advertiser', 'NONE');
        formData.append('media_agency', 'NONE');
        formData.append('partner', 'NONE');
        formData.append('access_token', effectiveToken);

        const result = await callFacebookGraphApi(`${businessId}/adaccount`, 'POST', formData, profile, effectiveToken);

        if (result?.error) {
          log('ERROR', `创建第 ${i} 个广告号失败: ${result.error.message}`);
          return res.status(500).json({ success: false, message: `第 ${i} 个创建失败: ${result.error.message}`, createdAccounts });
        }

        const actId = result?.id;
        if (actId) {
          createdAccounts.push({ id: actId, accountId: result.account_id, name: accName, adtrust_dsl: result.adtrust_dsl });

          // 自动授权用户
          if (businessUserId && actId) {
            try {
              const assignForm = new URLSearchParams();
              assignForm.append('user', businessUserId);
              assignForm.append('tasks', JSON.stringify(['ANALYZE', 'ADVERTISE', 'MANAGE']));
              assignForm.append('access_token', effectiveToken);
              await callFacebookGraphApi(`${actId}/assigned_users`, 'POST', assignForm, profile, effectiveToken);
            } catch (e) {
              log('WARN', `授权用户失败: ${e.message}`);
            }
          }

          // 自动创建像素
          if (createPixel && actId) {
            try {
              const pixelForm = new URLSearchParams();
              pixelForm.append('name', `pixel_${actId}`);
              pixelForm.append('access_token', effectiveToken);
              await callFacebookGraphApi(`act_${result.account_id || actId}/adspixels`, 'POST', pixelForm, profile, effectiveToken);
            } catch (e) {
              log('WARN', `创建像素失败: ${e.message}`);
            }
          }
        }
      }

      // 🆕 账单信息（国家/地址/州/邮编/公司）：Meta 在创建时收不了，必须等广告号创建完成后
      //    **单独串行**补写 —— 以前是 setTimeout(4s) 后台偷跑，会和创建流程的浏览器收尾撞车。
      const billingResult = await writeAdAccountsBillingSerial(profileId, createdAccounts.map(a => a.accountId || a.id), adBilling, 'create-adaccount');

      return res.json({
        success: true,
        message: `成功创建 ${createdAccounts.length} 个广告号` + (billingResult ? (billingResult.success ? '（账单信息已写入）' : '（账单信息写入失败，可稍后重试）') : ''),
        accounts: createdAccounts,
        billing: billingResult || undefined,
      });
    } catch (err) {
      log('ERROR', `BM 创建广告号异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 3b. BM 刷新信息 (Graph API)
  // POST /api/facebook/businesses/refresh-info
  // Body: { profileId, businessId, accessToken }
  // Returns: BM verification_status, ad_accounts & pages counts + ids
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/refresh-info', async (req, res) => {
    try {
      const { profileId, businessId, accessToken } = req.body || {};
      if (!profileId || !businessId) return res.status(400).json({ success: false, message: 'missing profileId/businessId' });
      const profile = await findProfileById(profileId);
      const token = accessToken || profile?.account_tokens || profile?.token || '';
      if (!token) return res.status(400).json({ success: false, message: 'missing access token' });

      const enc = encodeURIComponent(token);
      const base = 'https://graph.facebook.com/v21.0';

      // 并行获取 BM 信息和拥有的广告号/主页
      const [bmRes, adAcctsRes, pagesRes] = await Promise.all([
        fetch(`${base}/${businessId}?fields=id,name,verification_status&access_token=${enc}`).then(r => r.json()).catch(() => ({})),
        fetch(`${base}/${businessId}/owned_ad_accounts?fields=id,account_id,name,account_status,currency,balance,spend_cap&limit=100&access_token=${enc}`).then(r => r.json()).catch(() => ({})),
        fetch(`${base}/${businessId}/owned_pages?fields=id,name,fan_count,is_published,verification_status&limit=100&access_token=${enc}`).then(r => r.json()).catch(() => ({}))
      ]);

      const adAccounts = Array.isArray(adAcctsRes?.data) ? adAcctsRes.data : [];
      const pages = Array.isArray(pagesRes?.data) ? pagesRes.data : [];

      return res.json({
        success: true,
        businessId,
        name: bmRes?.name || '',
        verification_status: bmRes?.verification_status || 'not_verified',
        adAccountsCount: adAccounts.length,
        pagesCount: pages.length,
        adAccounts: adAccounts.map(a => ({ id: a.id, accountId: a.account_id, name: a.name, account_status: a.account_status, currency: a.currency, balance: a.balance, spend_cap: a.spend_cap })),
        pages: pages.map(p => ({ id: p.id, name: p.name, fan_count: p.fan_count, is_published: p.is_published, verification_status: p.verification_status }))
      });
    } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }); }
  });

  // -------------------------------------------------------
  // 3c. BM 同步所有权限 (Graph API)
  // POST /api/facebook/businesses/sync-permissions
  // Body: { profileId, businessId, accessToken }
  // 对 BM 下所有广告号和主页，将当前用户授权为管理员
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/sync-permissions', async (req, res) => {
    try {
      const { profileId, businessId, accessToken } = req.body || {};
      if (!profileId || !businessId) return res.status(400).json({ success: false, message: 'missing profileId/businessId' });
      const profile = await findProfileById(profileId);
      const token = accessToken || profile?.account_tokens || profile?.token || '';
      if (!token) return res.status(400).json({ success: false, message: 'missing access token' });

      const enc = encodeURIComponent(token);
      const base = 'https://graph.facebook.com/v21.0';

      // 步骤 1: 获取当前用户在 BM 中的 business_user_id
      const meRes = await fetch(`${base}/me?fields=id,business_users.business(${businessId})&access_token=${enc}`).then(r => r.json()).catch(() => ({}));
      const businessUserId = meRes?.business_users?.data?.[0]?.id;
      if (!businessUserId) {
        return res.status(400).json({ success: false, message: '无法获取 BM 中的 business_user_id，请确认你属于该 BM' });
      }

      // 步骤 2: 获取所有广告号和主页
      const [adAcctsRes, pagesRes] = await Promise.all([
        fetch(`${base}/${businessId}/owned_ad_accounts?fields=id,account_id&limit=100&access_token=${enc}`).then(r => r.json()).catch(() => ({})),
        fetch(`${base}/${businessId}/owned_pages?fields=id,name&limit=100&access_token=${enc}`).then(r => r.json()).catch(() => ({}))
      ]);

      const adAccounts = Array.isArray(adAcctsRes?.data) ? adAcctsRes.data : [];
      const pages = Array.isArray(pagesRes?.data) ? pagesRes.data : [];
      const adAccountResults = [];
      const pageResults = [];

      // 步骤 3: 逐个授权广告号（赋予 MANAGE + ADVERTISE + ANALYZE）
      for (const act of adAccounts) {
        try {
          const form = new URLSearchParams();
          form.append('user', businessUserId);
          form.append('tasks', JSON.stringify(['ANALYZE', 'ADVERTISE', 'MANAGE']));
          form.append('access_token', token);
          const r = await fetch(`${base}/${act.id}/assigned_users`, { method: 'POST', body: form }).then(r => r.json());
          adAccountResults.push({ id: act.id, accountId: act.account_id, success: !r?.error, error: r?.error?.message || null });
        } catch (e) { adAccountResults.push({ id: act.id, accountId: act.account_id, success: false, error: e.message }); }
      }

      // 步骤 4: 逐个授权主页
      for (const pg of pages) {
        try {
          const form = new URLSearchParams();
          form.append('user', businessUserId);
          form.append('tasks', JSON.stringify(['ANALYZE', 'ADVERTISE', 'MANAGE', 'CREATE_CONTENT', 'MESSAGING', 'MODERATE']));
          form.append('access_token', token);
          const r = await fetch(`${base}/${pg.id}/assigned_users`, { method: 'POST', body: form }).then(r => r.json());
          pageResults.push({ id: pg.id, name: pg.name, success: !r?.error, error: r?.error?.message || null });
        } catch (e) { pageResults.push({ id: pg.id, name: pg.name, success: false, error: e.message }); }
      }

      return res.json({
        success: true,
        businessId,
        businessUserId,
        adAccounts: { total: adAccounts.length, results: adAccountResults },
        pages: { total: pages.length, results: pageResults }
      });
    } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }); }
  });

  // -------------------------------------------------------
  // 4. BM 邀请用户 (Graph API)
  // POST /api/facebook/businesses/invite-user
  // Body: { profileId, businessId, email | emails[], role, accessToken }
  //   支持一次邀请多个邮箱：emails 数组优先，或把 email 按换行/逗号/分号/空格拆分。
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/invite-user', async (req, res) => {
    try {
      const { profileId, businessId, email, emails, role = 'EMPLOYEE', accessToken } = req.body || {};
      // 🆕 支持一次邀请多个邮箱：emails 数组优先；否则把 email 按 换行/逗号/分号/空格 拆开。
      //    Meta 的 /{bm}/business_users 一次只收一个 email，所以这里逐个发、逐个记结果。
      const rawList = Array.isArray(emails)
        ? emails
        : String(email || '').split(/[\s,;]+/);
      const unique = [...new Set(rawList.map(e => String(e || '').trim()).filter(Boolean))];
      if (!profileId || !businessId || unique.length === 0) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, businessId, email' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      const inviteRole = role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';
      log('INFO', `📌 BM ${businessId} 邀请 ${unique.length} 个用户: ${unique.join(', ')}, 角色: ${inviteRole}`);

      const results = [];
      for (const addr of unique) {
        const formData = new URLSearchParams();
        formData.append('email', addr);
        formData.append('role', inviteRole);
        formData.append('access_token', effectiveToken);

        const result = await callFacebookGraphApi(`${businessId}/business_users`, 'POST', formData, profile, effectiveToken);
        if (result && !result.error) {
          results.push({ email: addr, status: 'success', message: '邀请已发送' });
        } else {
          results.push({ email: addr, status: 'error', message: result?.error?.message || result?.error_user_msg || '未知错误' });
        }
      }

      const okCount = results.filter(r => r.status === 'success').length;
      const failList = results.filter(r => r.status === 'error');
      return res.json({
        success: okCount > 0,
        message: `邀请完成: ${okCount}/${results.length} 个邮箱成功`
          + (failList.length ? `（失败: ${failList.map(f => `${f.email} → ${f.message}`).join('；')}）` : ''),
        businessId,
        role: inviteRole,
        results
      });
    } catch (err) {
      log('ERROR', `BM 邀请用户异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // 🚀 6. 接入BM（接受BM邀请/关联BM）
  // POST /api/facebook/businesses/accept-invite-link
  // Body: { profileId, bmLink }
  // bmLink 可以是 BM 邀请链接（https://business.facebook.com/accept?...）或纯 BM ID
  // 对每个 profileId，启动/复用浏览器，导航到链接点击接受，返回 BM ID
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/accept-invite-link', async (req, res) => {
    try {
      const { profileId, bmLink } = req.body || {};
      if (!profileId || !bmLink) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, bmLink' });
      }
      log('INFO', `[AcceptBM] 开始接入BM: profileId=${profileId}, bmLink=${bmLink.substring(0, 100)}`);

      // 如果输入的是纯数字（BM ID），直接保存并返回
      const pureIdMatch = String(bmLink).match(/^(\d+)$/);
      if (pureIdMatch) {
        const bmId = pureIdMatch[1];
        log('INFO', `[AcceptBM] 纯 BM ID 输入: ${bmId}`);
        // 通过 Graph API 验证 BM 存在性
        const actualProfile = await findProfileById(profileId);
        if (actualProfile) {
          const pToken = actualProfile.account_tokens || actualProfile.token || '';
          if (pToken) {
            try {
              // ⚠️ credentials: 'include' 必带：FB 对不带登录 Cookie 的 Graph 调用返回 Invalid request. (code 1)
              const vResp = await fetch(`https://graph.facebook.com/v19.0/${bmId}?fields=id,name&access_token=${pToken}`, { credentials: 'include' });
              const vJson = await vResp.json();
              if (vJson.id) log('SUCCESS', `[AcceptBM] BM ID 验证通过: ${vJson.name || bmId}`);
            } catch {}
          }
        }
        return res.json({ success: true, businessId: bmId, message: `BM ${bmId} 接入成功` });
      }

      // 尝试从链接中提取 business_id
      let targetId = '';
      const idMatch = String(bmLink).match(/business_id[=/](\d+)/i) || String(bmLink).match(/\/business[=/](\d+)/i);
      if (idMatch) targetId = idMatch[1];

      // 启动浏览器
      const actualProfile = await findProfileById(profileId);
      if (!actualProfile) return res.status(404).json({ success: false, message: 'profile_not_found' });

      let browser, page, shouldClose = false;
      try {
        const existing = _activeBrowsers.get(profileId);
        if (existing && existing.browser && existing.browser.isConnected()) {
          browser = existing.browser;
          const pages = await browser.pages();
          page = pages.length > 0 ? pages[0] : await browser.newPage();
          log('INFO', `[AcceptBM] 复用已运行的浏览器: ${profileId}`);
        } else {
          const lr = await fetch(`http://127.0.0.1:${_PORT}/api/launch-browser`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': req.headers['x-api-secret'] || '' },
            body: JSON.stringify({ profileId, profile: actualProfile, proxy: actualProfile.proxy, startUrls: ['https://www.facebook.com/'], strictStartUrls: true, skipStartUrls: false })
          });
          const lj = await lr.json().catch(() => ({}));
          if (!lj.success) return res.status(500).json({ success: false, message: `浏览器启动失败: ${lj.message || 'unknown'}` });
          await sleep(2000);
          const entry = _activeBrowsers.get(profileId);
          if (!entry || !entry.browser || !entry.browser.isConnected()) return res.status(500).json({ success: false, message: '浏览器启动后连接丢失' });
          browser = entry.browser;
          const pages = await browser.pages();
          page = pages.length > 0 ? pages[0] : await browser.newPage();
          shouldClose = true;
        }

        // 导航到 BM 链接
        log('INFO', `[AcceptBM] 导航到 BM 链接: ${bmLink.substring(0, 120)}`);
        await page.goto(bmLink, { waitUntil: 'networkidle2', timeout: 45000 }).catch(e => {
          log('WARN', `[AcceptBM] 导航超时/失败: ${e.message}`);
        });
        await sleep(3000);

        // 尝试点击"接受邀请"或"加入"按钮
        const acceptSelectors = [
          'button[data-testid="accept-invite-button"]',
          'button:has-text("接受")',
          'button:has-text("加入")',
          'button:has-text("Accept")',
          'button:has-text("Join")',
          '[role="button"]:has-text("接受")',
          '[role="button"]:has-text("Accept")',
          'div[aria-label="接受"]',
          'div[aria-label="Accept"]',
          'a:has-text("接受邀请")',
          'a:has-text("Accept Invite")'
        ];
        let accepted = false;
        for (const sel of acceptSelectors) {
          try {
            const btn = await page.$(sel);
            if (btn) {
              await btn.click();
              log('INFO', `[AcceptBM] 点击了接受按钮: ${sel}`);
              await sleep(2000);
              accepted = true;
              // 可能有确认弹窗
              try {
                const confirmBtns = await page.$$('div[role="dialog"] button:has-text("确认"), div[role="dialog"] button:has-text("Confirm"), div[role="dialog"] button:has-text("完成"), div[role="dialog"] button:has-text("Done")');
                for (const cb of confirmBtns) { await cb.click(); await sleep(1000); }
              } catch {}
              break;
            }
          } catch {}
        }

        if (!accepted) {
          log('WARN', `[AcceptBM] 未找到接受按钮，可能不需要接受或页面结构不匹配`);
        }

        // 尝试从页面 URL 或内容提取 BM ID
        let businessId = targetId || '';
        if (!businessId) {
          try {
            const url = page.url();
            const urlIdMatch = url.match(/business_id[=/](\d+)/i) || url.match(/[?&]id=(\d{9,})/) || url.match(/business[=/](\d{9,})/i);
            if (urlIdMatch) businessId = urlIdMatch[1];
          } catch {}
        }
        if (!businessId) {
          try {
            businessId = await page.evaluate(() => {
              const el = document.querySelector('[data-business-id], [data-bsid]');
              if (el) return el.getAttribute('data-business-id') || el.getAttribute('data-bsid') || '';
              return '';
            });
          } catch {}
        }

        if (businessId) {
          log('SUCCESS', `[AcceptBM] 接入成功: profileId=${profileId}, BM=${businessId}`);
          return res.json({ success: true, businessId, message: `BM ${businessId} 接入成功` });
        }

        // 没提取到 BM ID，但流程执行了
        log('WARN', `[AcceptBM] 链接访问完成但未提取到 BM ID`);
        return res.json({ success: true, businessId: targetId || '', message: '链接访问完成，但未自动提取到 BM ID(可能需手动确认页面状态)' });
      } finally {
        // 不关闭浏览器，方便用户查看状态
        if (shouldClose && browser) {
          // 等待 5 秒后关闭
          await sleep(5000);
          try { await browser.close(); } catch {}
        }
      }
    } catch (e) {
      log('ERROR', `[AcceptBM] 异常: ${e.message || e}`);
      return res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // -------------------------------------------------------
  // 5. 通过 Puppeteer + Session 创建 BM
  // POST /api/facebook/businesses/create-puppeteer
  // Body: { profileId, name, email, firstName, lastName }
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/create-puppeteer', async (req, res) => {
    try {
      const { profileId, name, email, firstName, lastName } = req.body || {};
      if (!profileId || !name) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, name' });
      }

      // 📮 同 bundle 流程：@creator.fb.com / 自有收信域名 会让新 BM 被 Meta 限制邀请，回退用 Gmail 风格随机地址
      let finalEmail = String(email || '').trim();
      const _ownMailDomain = String(process.env.MAIL_DOMAIN || '').trim().replace(/^@/, '').toLowerCase();
      const _isBlockedMailDomain = /@creator\.fb\.com$/i.test(finalEmail) ||
        (_ownMailDomain && finalEmail.toLowerCase().endsWith('@' + _ownMailDomain));
      if (!finalEmail || _isBlockedMailDomain) {
        const _gmailLocal = () => {
          const cons = 'bcdfghjklmnprstvwxz';
          let r = '';
          for (let i = 0; i < 4; i++) r += cons[Math.floor(Math.random() * cons.length)];
          return r + Math.random().toString(36).slice(2, 12).replace(/[^a-z0-9]/g, '');
        };
        finalEmail = `${_gmailLocal()}@gmail.com`;
      }

      log('INFO', `📌 通过 Puppeteer 创建 BM: ${name}, email: ${finalEmail}`);

      const result = await ensureBrowserIsRunning(profileId);
      if (!result.success) {
        return res.status(500).json({ success: false, message: `浏览器启动失败: ${result.error}` });
      }

      const browser = result.browserData.browser;
      const pages = await browser.pages();
      let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();
      if (!page.url().includes('facebook.com')) {
        await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      // 🚀 等待 Facebook SPA 初始化（确保 window.dtsg 可用）
      try { await page.waitForFunction(() => typeof window.dtsg !== 'undefined' && window.dtsg !== '', { timeout: 20000 }); } catch {}
      await new Promise(r => setTimeout(r, 2000));

      // 从页面提取 session 参数 (fb_dtsg, __user, spinR 等)
      const sessionData = await page.evaluate(() => {
        let fbDtsg = (typeof window !== 'undefined' && window.dtsg) || '';
        let userId = '', spinR = '', spinB = '', spinT = '', hsi = '';
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const html = s.innerHTML || '';
          const uidMatch = html.match(/"USER_ID":"(\d+)"/) || html.match(/"userID":"(\d+)"/);
          if (uidMatch) userId = uidMatch[1];
          const spinRMatch = html.match(/__spin_r=(\d+)/);
          if (spinRMatch) spinR = spinRMatch[1];
          const spinBMatch = html.match(/__spin_b=([^"&]+)/);
          if (spinBMatch) spinB = spinBMatch[1];
          const spinTMatch = html.match(/__spin_t=([^"&]+)/);
          if (spinTMatch) spinT = spinTMatch[1];
          const hsiMatch = html.match(/__hsi=(\d+)/);
          if (hsiMatch) hsi = hsiMatch[1];
          if (!fbDtsg) {
            const dtsgMatch = html.match(/"dtsg":\{"token":"([^"]+)"/);
            if (dtsgMatch) fbDtsg = dtsgMatch[1];
          }
        }
        return { fbDtsg, userId, spinR, spinB, spinT, hsi };
      });

      if (!sessionData.fbDtsg || !sessionData.userId) {
        return res.status(400).json({ success: false, message: '浏览器未登录 Facebook，请先登录' });
      }

      // 使用 GraphQL 方式创建 BM (与 bookmarklet 方式 A 一致)
      const fullName = firstName || name;
      const shortName = lastName || name.substring(0, 8);

      const bmResult = await page.evaluate(async (params) => {
        const { name, email, fullName, shortName, fbDtsg, userId, spinR, spinB, spinT, hsi } = params;
        const apiUrl = 'https://www.facebook.com/api/graphql/';
        const urlencoded = new URLSearchParams();
        urlencoded.append('__rev', spinR || '1005599768');
        urlencoded.append('__hsi', hsi || '');
        urlencoded.append('__spin_r', spinR || '1005599768');
        urlencoded.append('__spin_b', spinB || '');
        urlencoded.append('__spin_t', spinT || '');
        urlencoded.append('fb_api_caller_class', 'RelayModern');
        urlencoded.append('fb_api_req_friendly_name', 'useBusinessCreationMutationMutation');
        urlencoded.append('av', userId);
        urlencoded.append('__user', userId);
        urlencoded.append('fb_dtsg', fbDtsg);
        urlencoded.append('variables', JSON.stringify({
          input: {
            client_mutation_id: '1',
            actor_id: userId,
            business_name: name,
            user_first_name: fullName,
            user_last_name: shortName,
            user_email: email,
            creation_source: 'FBS_BUSINESS_CREATION_FLOW'
          }
        }));
        urlencoded.append('doc_id', '7183377418404152');
        urlencoded.append('server_timestamps', 'true');

        try {
          const resp = await fetch(apiUrl, {
            mode: 'cors', method: 'POST', credentials: 'include', redirect: 'follow', body: urlencoded
          });
          return await resp.json();
        } catch (e) {
          return { error: { message: e.message } };
        }
      }, { name, email: finalEmail, fullName, shortName, ...sessionData });

      if (bmResult?.data?.bizkit_create_business?.id) {
        const bmId = bmResult.data.bizkit_create_business.id;
        log('INFO', `✅ BM 创建成功: ${name} (${bmId})`);
        return res.json({ success: true, message: 'BM 创建成功', businessId: bmId, name });
      }

      const errMsg = bmResult?.errors?.[0]?.message || bmResult?.error?.message || 'BM 创建失败';
      log('ERROR', `BM 创建失败: ${errMsg}`);
      return res.status(500).json({ success: false, message: errMsg, detail: bmResult });
    } catch (err) {
      log('ERROR', `Puppeteer 创建 BM 异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 5.2 通过 Puppeteer 发起 BM 业务认证（文件验证方式）
  // POST /api/facebook/businesses/verify-puppeteer
  // Body: {
  //   profileId, bmId,
  //   legalName, legalAddress, phoneNumber, website,
  //   businessType: 'ADVERTISER' | 'ADVERTISING_AGENCY' | 'OTHER',
  //   documents: [{ filename, mimeType, base64 }]  // 营业执照/法人证件等
  //   proxyOverride (可选)
  // }
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/verify-puppeteer', async (req, res) => {
    const taskId = `bmverify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { profileId, bmId, legalName, legalAddress, phoneNumber, website, businessType, documents, proxyOverride } = req.body || {};
      if (!profileId || !bmId || !legalName) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, bmId, legalName' });
      }
      if (!Array.isArray(documents) || documents.length === 0) {
        return res.status(400).json({ success: false, message: '至少上传一份认证文件' });
      }

      log('INFO', `[BM认证] 开始 BM=${bmId} legalName=${legalName} 文件数=${documents.length}`);

      // 代理覆盖（直接传给 ensureBrowserIsRunning，会自动处理切换）
      const result = await ensureBrowserIsRunning(profileId, proxyOverride);
      if (!result.success) {
        return res.status(500).json({ success: false, message: `浏览器启动失败: ${result.error}` });
      }

      const browser = result.browserData.browser;
      const pages = await browser.pages();
      let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();

      // 步骤1: 导航到 BM 安全中心
      log('INFO', `[BM认证] 导航到安全中心: BM=${bmId}`);
      const securityUrl = `https://business.facebook.com/settings/security?business_id=${bmId}`;
      try {
        await page.goto(securityUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 4000));
      } catch (navErr) {
        log('WARN', `[BM认证] 导航失败: ${navErr.message}`);
      }

      // 步骤2: 查找并点击"开始业务认证"按钮
      log('INFO', `[BM认证] 查找"开始业务认证"按钮`);
      const startBtnSelectors = [
        'div[role="button"]:has-text("Start Verification")',
        'div[role="button"]:has-text("开始业务认证")',
        'div[role="button"]:has-text("Start Business Verification")',
        'a:has-text("Start Verification")',
        'a:has-text("开始认证")',
        'button:has-text("Start Verification")',
        'button:has-text("开始业务认证")',
      ];
      let started = false;
      for (const sel of startBtnSelectors) {
        try {
          const btn = await page.evaluate((text) => {
            const candidates = Array.from(document.querySelectorAll('div[role="button"], a, button'));
            return candidates.find(el => (el.textContent || '').trim().includes(text))?.outerHTML || null;
          }, sel.match(/"([^"]+)"/)?.[1] || '');
          if (btn) {
            await page.evaluate((text) => {
              const candidates = Array.from(document.querySelectorAll('div[role="button"], a, button'));
              const el = candidates.find(el => (el.textContent || '').trim().includes(text));
              if (el) el.click();
            }, sel.match(/"([^"]+)"/)?.[1] || '');
            await new Promise(r => setTimeout(r, 3000));
            started = true;
            log('INFO', `[BM认证] 成功点击认证按钮: ${sel}`);
            break;
          }
        } catch (e) {}
      }

      if (!started) {
        let screenshotBase64 = '';
        try { screenshotBase64 = (await page.screenshot({ encoding: 'base64' })).slice(0, 200); } catch {}
        const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (/verified|已认证|已通过/i.test(pageText)) {
          return res.json({ success: true, message: 'BM 已通过认证，无需重复操作', status: 'verified' });
        }
        return res.status(400).json({
          success: false,
          message: '未找到"开始业务认证"按钮。可能 BM 已开始认证流程或页面结构变化。',
          currentUrl: page.url(),
          status: 'no_start_button'
        });
      }

      // 步骤3: 填写法律实体信息（公司名、地址、电话、网站）
      log('INFO', `[BM认证] 填写法律实体信息: ${legalName}`);

      // 通用填写函数：通过 placeholder/label/aria-label 找输入框
      const fillInput = async (keywords, value) => {
        if (!value) return false;
        return await page.evaluate((kws, val) => {
          const kwsArr = kws.split('|').map(s => s.trim().toLowerCase());
          const inputs = Array.from(document.querySelectorAll('input, textarea'));
          for (const inp of inputs) {
            const attrs = [inp.placeholder || '', inp.getAttribute('aria-label') || '', inp.getAttribute('name') || '', inp.id || ''].join(' ').toLowerCase();
            for (const kw of kwsArr) {
              if (kw && attrs.includes(kw)) {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                const setter = inp.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeInputValueSetter;
                setter.call(inp, val);
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
          }
          return false;
        }, keywords, value);
      };

      // 尝试填写各字段（多种语言关键词）
      await fillInput('legal name|公司名称|法定名称|business name|entity name', legalName);
      await new Promise(r => setTimeout(r, 800));
      if (legalAddress) {
        await fillInput('address|地址|street|街道', legalAddress);
        await new Promise(r => setTimeout(r, 800));
      }
      if (phoneNumber) {
        await fillInput('phone|电话|mobile|手机', phoneNumber);
        await new Promise(r => setTimeout(r, 800));
      }
      if (website) {
        await fillInput('website|网站|url|domain', website);
        await new Promise(r => setTimeout(r, 800));
      }

      // 步骤4: 选择业务类型（下拉或单选）
      if (businessType) {
        log('INFO', `[BM认证] 选择业务类型: ${businessType}`);
        try {
          // 尝试下拉选择
          const dropdownClicked = await page.evaluate(() => {
            const dropdowns = Array.from(document.querySelectorAll('div[role="combobox"], select, div[aria-haspopup="listbox"]'));
            if (dropdowns.length > 0) { dropdowns[0].click(); return true; }
            return false;
          });
          if (dropdownClicked) {
            await new Promise(r => setTimeout(r, 1500));
            await page.evaluate((bt) => {
              const opts = Array.from(document.querySelectorAll('div[role="option"], li, option'));
              const opt = opts.find(o => (o.textContent || '').toLowerCase().includes(bt.toLowerCase()));
              if (opt) opt.click();
            }, businessType);
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (e) {
          log('WARN', `[BM认证] 选择业务类型失败: ${e.message}`);
        }
      }

      // 步骤5: 点击"下一步" / "Next" 按钮
      log('INFO', `[BM认证] 点击下一步`);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
        const next = btns.find(el => /^(next|下一步|continue|继续)$/i.test((el.textContent || '').trim()));
        if (next) next.click();
      });
      await new Promise(r => setTimeout(r, 3000));

      // 步骤6: 上传文件
      log('INFO', `[BM认证] 上传认证文件 (${documents.length} 份)`);
      const fs = require('fs');
      const path = require('path');
      const tempFiles = [];
      try {
        for (let i = 0; i < documents.length; i++) {
          const doc = documents[i];
          if (!doc.base64) continue;
          const matches = doc.base64.match(/^data:(.+);base64,(.+)$/);
          if (!matches) {
            // 也许是纯 base64
            const ext = (doc.filename || 'doc.pdf').split('.').pop() || 'pdf';
            const tempPath = path.join(_APP_ROOT, 'logs', `${taskId}_doc${i}.${ext}`);
            fs.writeFileSync(tempPath, Buffer.from(doc.base64, 'base64'));
            tempFiles.push(tempPath);
          } else {
            const tempPath = path.join(_APP_ROOT, 'logs', `${taskId}_${doc.filename || 'doc_' + i}`);
            fs.writeFileSync(tempPath, Buffer.from(matches[2], 'base64'));
            tempFiles.push(tempPath);
          }
        }

        // 查找所有 file input 并依次上传
        const fileInputs = await page.$$('input[type="file"]');
        log('INFO', `[BM认证] 找到 ${fileInputs.length} 个文件输入框`);

        for (let i = 0; i < fileInputs.length && i < tempFiles.length; i++) {
          try {
            await fileInputs[i].uploadFile(tempFiles[i]);
            log('INFO', `[BM认证] 已上传文件 ${i + 1}: ${tempFiles[i]}`);
            await new Promise(r => setTimeout(r, 2000));
          } catch (e) {
            log('WARN', `[BM认证] 文件 ${i + 1} 上传失败: ${e.message}`);
          }
        }

        // 如果 fileInputs 不够，尝试通过点击"上传"按钮触发
        if (fileInputs.length < tempFiles.length) {
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
            const uploadBtn = btns.find(el => /upload|上传/i.test(el.textContent || ''));
            if (uploadBtn) uploadBtn.click();
          });
          await new Promise(r => setTimeout(r, 1500));
          const moreInputs = await page.$$('input[type="file"]');
          for (let i = fileInputs.length; i < moreInputs.length && i < tempFiles.length; i++) {
            try {
              await moreInputs[i].uploadFile(tempFiles[i]);
              log('INFO', `[BM认证] 已上传额外文件 ${i + 1}`);
              await new Promise(r => setTimeout(r, 2000));
            } catch (e) {}
          }
        }
      } finally {
        // 清理临时文件
        for (const fp of tempFiles) {
          try { fs.unlinkSync(fp); } catch {}
        }
      }

      // 步骤7: 提交认证
      log('INFO', `[BM认证] 提交认证`);
      await new Promise(r => setTimeout(r, 2000));
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
        const submit = btns.find(el => /^(submit|提交|finish|完成|done|完成认证)$/i.test((el.textContent || '').trim()));
        if (submit) submit.click();
      });
      await new Promise(r => setTimeout(r, 4000));

      // 步骤8: 检查结果
      const finalUrl = page.url();
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      let status = 'submitted';
      if (/in review|审核中|under review|pending/i.test(pageText)) status = 'in_review';
      else if (/verified|已认证|已通过/i.test(pageText)) status = 'verified';
      else if (/rejected|拒绝|失败|failed/i.test(pageText)) status = 'rejected';

      log('INFO', `[BM认证] 完成 BM=${bmId} 状态=${status}`);
      return res.json({
        success: true,
        message: 'BM 认证已提交，请等待 Facebook 审核（通常 1-3 个工作日）',
        status,
        currentUrl: finalUrl,
        bmId
      });
    } catch (err) {
      log('ERROR', `[BM认证] 异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 6. 创建主页并授权给 BM (Graph API + Puppeteer 回退)
  // POST /api/facebook/pages/create-and-grant
  // Body: { profileId, name, category, businessId, accessToken, proxyOverride }
  // -------------------------------------------------------
  _app.post('/api/facebook/pages/create-and-grant', async (req, res) => {
    try {
      const { profileId, name, category, businessId, accessToken, proxyOverride } = req.body || {};
      if (!profileId || !name) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, name' });
      }

      log('INFO', `📌 创建主页并授权给 BM: ${name}, BM: ${businessId || '无'}`);

      // 步骤 1: 先使用 Graph API 创建主页
      const profile = await findProfileById(profileId);

      // 🚀 代理覆盖
      if (proxyOverride) {
        profile.proxy = proxyOverride;
      }
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';

      let pageId = null;
      // 尝试 API 创建
      if (effectiveToken) {
        try {
          const formData = new URLSearchParams();
          formData.append('name', name);
          formData.append('category', category || '1601');
          formData.append('category_list', JSON.stringify([{id: category || '1601'}]));
          formData.append('access_token', effectiveToken);

          const createResult = await callFacebookGraphApi('me/accounts', 'POST', formData, profile, effectiveToken);
          if (createResult?.id) {
            pageId = createResult.id;
          } else {
            log('WARN', `API 创建主页失败: ${createResult?.error?.message || '未知错误'}`);
          }
        } catch (e) {
          log('WARN', `API 创建主页异常: ${e.message}`);
        }
      }

      // 如果 API 失败，回退到 Puppeteer
      if (!pageId) {
        log('INFO', 'API 创建失败，回退到 Puppeteer 自动化...');
        const browResult = await ensureBrowserIsRunning(profileId, proxyOverride);
        if (!browResult.success) {
          return res.status(500).json({ success: false, message: `浏览器启动失败: ${browResult.error}` });
        }
        const browser = browResult.browserData.browser;
        const page = await browser.newPage();
        await page.goto('https://www.facebook.com/pages/create', { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(r => setTimeout(r, 5000));

        // 使用 bookmarklet 中的 GraphQL 方式
        const sessionData = await page.evaluate(() => {
          const scripts = Array.from(document.querySelectorAll('script'));
          let fbDtsg = '', userId = '', spinR = '', spinB = '', spinT = '', hsi = '';
          for (const s of scripts) {
            const html = s.innerHTML || '';
            const dtsgMatch = html.match(/"dtsg":\{"token":"([^"]+)"/);
            if (dtsgMatch) fbDtsg = dtsgMatch[1];
            const uidMatch = html.match(/"USER_ID":"(\d+)"/);
            if (uidMatch) userId = uidMatch[1];
            const spinRMatch = html.match(/__spin_r=(\d+)/);
            if (spinRMatch) spinR = spinRMatch[1];
          }
          return { fbDtsg, userId, spinR, spinB: '', spinT: '', hsi: '' };
        });

        if (!sessionData.fbDtsg || !sessionData.userId) {
          await page.close();
          return res.status(400).json({ success: false, message: '浏览器未登录 Facebook' });
        }

        const pageResult = await page.evaluate(async (p) => {
          const { name, category, userId, fbDtsg, spinR } = p;
          const apiUrl = 'https://www.facebook.com/api/graphql';
          const urlencoded = new URLSearchParams();
          urlencoded.append('jazoest', '25477');
          urlencoded.append('__rev', spinR || '1005599768');
          urlencoded.append('fb_api_caller_class', 'RelayModern');
          urlencoded.append('fb_api_req_friendly_name', 'AdditionalProfilePlusCreationMutation');
          urlencoded.append('av', userId);
          urlencoded.append('__user', userId);
          urlencoded.append('fb_dtsg', fbDtsg);
          urlencoded.append('variables', JSON.stringify({
            input: {
              bio: '',
              categories: [category || '164886566892249'],
              creation_source: 'comet',
              name: name,
              page_referrer: 'launch_point',
              actor_id: userId,
              client_mutation_id: '1'
            }
          }));
          urlencoded.append('doc_id', '4722866874428654');
          urlencoded.append('server_timestamps', 'true');

          const resp = await fetch(apiUrl, { mode: 'cors', method: 'POST', credentials: 'include', redirect: 'follow', body: urlencoded });
          return await resp.json();
        }, { name, category: category || '164886566892249', ...sessionData });

        if (pageResult?.data?.additional_profile_plus_create?.additional_profile?.id) {
          pageId = pageResult.data.additional_profile_plus_create.additional_profile.id;
        } else if (pageResult?.data?.page_create?.page?.id) {
          pageId = pageResult.data.page_create.page.id;
        }
        await page.close();
      }

      if (!pageId) {
        return res.status(500).json({ success: false, message: '主页创建失败' });
      }
      log('INFO', `✅ 主页创建成功: ${pageId}`);

      // 步骤 2: 如果提供了 businessId，自动授权
      if (businessId && effectiveToken) {
        try {
          const grantForm = new URLSearchParams();
          grantForm.append('page_id', pageId);
          grantForm.append('access_token', effectiveToken);
          await callFacebookGraphApi(`${businessId}/owned_pages`, 'POST', grantForm, profile, effectiveToken);
          log('INFO', `✅ 主页 ${pageId} 已授权给 BM ${businessId}`);
          return res.json({ success: true, message: '主页创建并授权成功', pageId, businessId, granted: true });
        } catch (grantErr) {
          log('WARN', `授权失败但主页已创建: ${grantErr.message}`);
          return res.json({ success: true, message: '主页已创建但授权失败', pageId, grantError: grantErr.message, granted: false });
        }
      }

      return res.json({ success: true, message: '主页创建成功', pageId });
    } catch (err) {
      log('ERROR', `创建主页并授权异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 8. 查询 BM 用户列表（含待定邀请）
  // POST /api/facebook/businesses/users
  // Body: { profileId, businessId, accessToken }
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/users', async (req, res) => {
    try {
      const { profileId, businessId, accessToken } = req.body || {};
      if (!profileId || !businessId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, businessId' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      const result = await callFacebookGraphApi(
        `${businessId}?fields=business_users{active_status,id,email,name,role,title},pending_users{id,role,email,status}`,
        'GET', null, profile, effectiveToken
      );

      const users = result?.business_users?.data || [];
      const pendingUsers = result?.pending_users?.data || [];

      return res.json({
        success: true,
        business: { id: businessId, name: result?.name },
        users: users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active_status })),
        pendingUsers: pendingUsers.map(u => ({ id: u.id, email: u.email, role: u.role, status: u.status }))
      });
    } catch (err) {
      log('ERROR', `查询 BM 用户异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 8b. BM 变更成员角色 / 移除成员（支持批量）
  // POST /api/facebook/businesses/update-user-role
  //   Body: { profileId, businessId, targets:[{ id, role, name? }], accessToken }
  // POST /api/facebook/businesses/remove-users
  //   Body: { profileId, businessId, targets:[{ id, name?, email? }], accessToken }
  //   ⚠️ Meta 一次只处理一个成员（business_users 里的 id 就是 business-scoped user id）：
  //       改角色  POST   /{business_scoped_user_id}   (form: role=ADMIN|EMPLOYEE)
  //       移除    DELETE /{business_scoped_user_id}
  //   批量 = 逐个发、逐个记结果（一个失败不影响其余）。
  // -------------------------------------------------------
  _app.post('/api/facebook/businesses/update-user-role', async (req, res) => {
    try {
      const { profileId, businessId, targets, accessToken } = req.body || {};
      const list = (Array.isArray(targets) ? targets : []).filter(t => t && t.id && t.role);
      if (!profileId || !businessId || !list.length) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, businessId, targets[{id,role}]' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) return res.status(400).json({ success: false, message: '缺少 Access Token' });

      // 🛡️ 自我保护：先读出该 BM 当前的管理员列表，禁止把「唯一的管理员」降级
      //    （否则该 BM 会变成 0 管理员，谁都进不去，不可逆）
      const adminIds = await fetchActiveAdminIds(businessId, profile, effectiveToken);

      const results = [];
      for (const t of list) {
        const role = String(t.role).toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';
        // 唯一管理员要从 ADMIN 降为 EMPLOYEE → 拦截
        if (role !== 'ADMIN' && adminIds.has(String(t.id)) && adminIds.size <= 1) {
          results.push({ id: String(t.id), name: t.name || '', role, ok: false, message: '该 BM 只剩这一个管理员，降级会导致 BM 无人管理，已拦截' });
          continue;
        }
        try {
          const form = new URLSearchParams();
          form.append('role', role);
          const r = await callFacebookGraphApi(String(t.id), 'POST', form, profile, effectiveToken);
          const ok = !!(r && !r.error);
          results.push({ id: String(t.id), name: t.name || '', role, ok, message: ok ? 'ok' : (r?.error?.message || '未知错误') });
        } catch (e) {
          results.push({ id: String(t.id), name: t.name || '', role, ok: false, message: String(e.message || e) });
        }
      }
      const okCount = results.filter(r => r.ok).length;
      log('INFO', `📌 BM ${businessId} 变更成员角色: 成功 ${okCount}/${results.length}`);
      return res.json({ success: okCount > 0, count: okCount, total: results.length, results });
    } catch (err) {
      log('ERROR', `变更 BM 成员角色异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  _app.post('/api/facebook/businesses/remove-users', async (req, res) => {
    try {
      const { profileId, businessId, targets, accessToken } = req.body || {};
      const list = (Array.isArray(targets) ? targets : []).filter(t => t && t.id);
      if (!profileId || !businessId || !list.length) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, businessId, targets[{id}]' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) return res.status(400).json({ success: false, message: '缺少 Access Token' });

      // 🛡️ 自我保护：禁止移除「唯一的管理员」（移除后 BM 无人管理，且不可逆）
      const adminIds = await fetchActiveAdminIds(businessId, profile, effectiveToken);

      const results = [];
      for (const t of list) {
        if (adminIds.has(String(t.id)) && adminIds.size <= 1) {
          results.push({ id: String(t.id), name: t.name || '', email: t.email || '', ok: false, message: '该 BM 只剩这一个管理员，移除后 BM 将无人管理，已拦截' });
          continue;
        }
        try {
          const r = await callFacebookGraphApi(String(t.id), 'DELETE', null, profile, effectiveToken);
          // DELETE 成功一般回 { success: true }，部分节点回 { id }
          const ok = !!(r && !r.error && r.success !== false);
          results.push({ id: String(t.id), name: t.name || '', email: t.email || '', ok, message: ok ? 'ok' : (r?.error?.message || '未知错误') });
        } catch (e) {
          results.push({ id: String(t.id), name: t.name || '', email: t.email || '', ok: false, message: String(e.message || e) });
        }
      }
      const okCount = results.filter(r => r.ok).length;
      log('INFO', `📌 BM ${businessId} 移除成员: 成功 ${okCount}/${results.length}`);
      return res.json({ success: okCount > 0, count: okCount, total: results.length, results });
    } catch (err) {
      log('ERROR', `移除 BM 成员异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 9. 广告号分享到合作伙伴 BM (Graph API)
  // POST /api/facebook/adaccounts/share-to-partner
  // Body: { profileId, adAccountIds[], partnerBusinessId, tasks[], accessToken, businessId (autoFetch) }
  // -------------------------------------------------------
  _app.post('/api/facebook/adaccounts/share-to-partner', async (req, res) => {
    try {
      const { profileId, adAccountIds, partnerBusinessId, tasks, accessToken, businessId, autoFetchAdAccounts } = req.body || {};
      if (!profileId || !partnerBusinessId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, partnerBusinessId' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      // 🆕 自动获取 BM 拥有的广告号
      let finalAccountIds = adAccountIds;
      if ((!finalAccountIds || !Array.isArray(finalAccountIds) || finalAccountIds.length === 0) && autoFetchAdAccounts && businessId) {
        log('INFO', `🔄 正在自动获取 BM ${businessId} 的 owned_ad_accounts...`);
        try {
          const ownedResult = await callFacebookGraphApi(
            `${businessId}?fields=owned_ad_accounts{id,account_id,name,account_status}`,
            'GET', null, profile, effectiveToken
          );
          if (ownedResult?.owned_ad_accounts?.data) {
            finalAccountIds = ownedResult.owned_ad_accounts.data
              .filter(a => String(a.account_status) === '1') // 仅活跃
              .map(a => a.account_id || a.id);
            log('INFO', `✅ 自动获取到 ${finalAccountIds.length} 个活跃广告号`);
          }
        } catch (e) {
          log('WARN', `自动获取 owned_ad_accounts 失败: ${e.message}`);
        }
      }

      if (!finalAccountIds || !Array.isArray(finalAccountIds) || finalAccountIds.length === 0) {
        return res.status(400).json({ success: false, message: '没有可分享的广告号。请手动输入 adAccountIds 或提供有 owned_ad_accounts 的 BM。' });
      }

      const partnerTasks = tasks || ['ANALYZE', 'ADVERTISE', 'MANAGE'];
      log('INFO', `📌 分享 ${finalAccountIds.length} 个广告号给合作伙伴 BM ${partnerBusinessId}`);

      const results = [];
      for (const rawId of finalAccountIds) {
        const actId = rawId.replace(/^act_/, '');
        try {
          // 方式一: 通过 assigned_partners 直接分享
          const formData = new URLSearchParams();
          formData.append('partner', partnerBusinessId);
          formData.append('tasks', JSON.stringify(partnerTasks));
          formData.append('access_token', effectiveToken);

          const result = await callFacebookGraphApi(`act_${actId}/assigned_partners`, 'POST', formData, profile, effectiveToken);

          if (result && result.success !== false) {
            results.push({ adAccountId: actId, status: 'success', message: '分享成功' });
          } else {
            // 方式二: 回退到 client_ad_accounts 方式
            const fallbackForm = new URLSearchParams();
            fallbackForm.append('ad_account_id', actId);
            fallbackForm.append('permitted_tasks', JSON.stringify(partnerTasks));
            fallbackForm.append('access_token', effectiveToken);

            const fallbackResult = await callFacebookGraphApi(`${partnerBusinessId}/client_ad_accounts`, 'POST', fallbackForm, profile, effectiveToken);
            if (fallbackResult && fallbackResult.id) {
              results.push({ adAccountId: actId, status: 'success', message: '通过 client_ad_accounts 分享成功' });
            } else {
              const errMsg = result?.error?.message || fallbackResult?.error?.message || '未知错误';
              results.push({ adAccountId: actId, status: 'error', message: errMsg });
            }
          }
        } catch (e) {
          results.push({ adAccountId: actId, status: 'error', message: e.message });
        }
      }

      const successCount = results.filter(r => r.status === 'success').length;
      return res.json({ success: successCount > 0, message: `分享完成: ${successCount}/${finalAccountIds.length} 成功`, results });
    } catch (err) {
      log('ERROR', `分享广告号给合作伙伴异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // 把 Meta 侧的报错翻译成可操作的中文提示（原始报错仍会附在后面，便于排查）
  const friendlyInviteError = (rawMsg, errObj) => {
    const s = String(rawMsg || '');
    const code = errObj && errObj.code ? Number(errObj.code) : 0;
    if (/cannot be added to the company|não pode ser adicionado/i.test(s)) {
      return `${s}（该 BM 拒绝添加此用户：常见原因是 BM 已达成员上限、BM 处于受限/封禁状态，或该邮箱此前已被邀请过 → 换个 BM 或稍后重试）`;
    }
    if (/must be one of/i.test(s) && /tasks/i.test(s)) {
      return `${s}（Meta 已更新 BM 权限白名单，请只使用 MANAGE 等新值）`;
    }
    if (code === 368 || /limit|limit reached/i.test(s)) {
      return `${s}（该 BM 可能已达邀请/成员上限）`;
    }
    // (#3) Business must be on whitelist：Meta 对 Graph App 的 business_users 写权限做了白名单限制，
    // 多配置（含新建 BM）系统性复现 → 是 App 级限制，换配置/重试无效，需到 Meta 开发者后台检查 App 状态
    if (code === 3 || /must be on whitelist/i.test(s)) {
      return `${s}（Meta 对本 Graph App 的 BM 成员邀请权限做了白名单限制：多配置系统性报此错，属 App 级限制 → 换配置/重试无效，需到 Meta 开发者后台检查 App 是否被风控限制或需要重新提交 business_management 权限审核）`;
    }
    return s;
  };

  // -------------------------------------------------------
  // 9a-2. BM 邀请链接自动化（分享 BM 给自动生成的临时邮箱）
  // POST /api/facebook/business/invite-user
  // Body: { profileId, businessId, email?, role?('admin'|'employee'), tasks?, accessToken?, pollSeconds? }
  // 流程：
  //   1) 生成临时邮箱（catch-all 自有域名，任意地址无需预创建即可收信）
  //   2) Graph POST /{businessId}/business_users 邀请该邮箱加入 BM（FB 会发邀请邮件）
  //   3) 轮询云端临时邮箱收信（list 接口已服务端提取好 links），提取 business.facebook.com 邀请链接
  //   4) 用 X-Api-Secret 写回云端 businesses 表（invite_email / invite_link / invited_at）
  //   5) 把链接返回给前端，BM 列表立即显示 + 快速复制
  // -------------------------------------------------------
  _app.post('/api/facebook/business/invite-user', async (req, res) => {
    const { profileId, businessId, email: emailInput, role: roleInput, tasks: tasksInput, accessToken, pollSeconds } = req.body || {};
    if (!profileId || !businessId) {
      return res.status(400).json({ success: false, message: '缺少必要参数: profileId, businessId' });
    }
    try {
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      // 1) 邮箱：外部传入则用外部的；否则生成高熵临时邮箱（地址即凭证，无密码体系）
      const mailDomain = process.env.MAIL_DOMAIN || '';
      const email = String(emailInput || '').trim().toLowerCase() ||
        `bm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@${mailDomain}`;
      const role = roleInput === 'admin' ? 'ADMIN' : 'EMPLOYEE';

      // 2) 发出 BM 邀请（EMPLOYEE 需要 tasks；ADMIN 全权不需要）
      // ⚠️ business_users 的 tasks 是固定白名单：老值 ADVERTISE / ANALYZE / DEVELOP 已废弃，
      //    传了会让整个邀请失败（#100 Param tasks[n] must be one of {...} - got "ADVERTISE"）。
      //    这里对入参做白名单过滤，默认只给 MANAGE（= 管理全部业务资产）。
      const formData = new URLSearchParams();
      formData.append('email', email);
      formData.append('role', role);
      if (role === 'EMPLOYEE') {
        const VALID_BM_TASKS = [
          'MANAGE', 'DEFAULT', 'ADMIN', 'EMPLOYEE', 'DEVELOPER', 'ADS_RIGHTS_REVIEWER',
          'FINANCE_EDIT', 'FINANCE_VIEW', 'FINANCE_EDITOR', 'FINANCE_ANALYST',
          'PARTNER_CENTER_ADMIN', 'PARTNER_CENTER_ANALYST', 'PARTNER_CENTER_OPERATIONS',
          'PARTNER_CENTER_MARKETING', 'PARTNER_CENTER_EDUCATION',
        ];
        const asked = (Array.isArray(tasksInput) ? tasksInput : [])
          .map(t => String(t || '').toUpperCase().trim()).filter(Boolean);
        const picked = asked.filter(t => VALID_BM_TASKS.includes(t));
        const dropped = asked.filter(t => !VALID_BM_TASKS.includes(t));
        if (dropped.length) log('WARN', `忽略 Meta 已废弃的 BM 权限项: ${dropped.join(', ')}`);
        formData.append('tasks', (picked.length ? picked : ['MANAGE']).join(','));
      }
      formData.append('access_token', effectiveToken);
      log('INFO', `📧 BM 邀请：${businessId} → ${email} (${role})`);
      const inviteResult = await callFacebookGraphApi(`${businessId}/business_users`, 'POST', formData, profile, effectiveToken);
      const inviteUserId = inviteResult && (inviteResult.id || inviteResult.business_user_id);
      if (!inviteResult || inviteResult.success === false || !inviteUserId) {
        const errMsg = friendlyInviteError(
          (inviteResult && inviteResult.error && inviteResult.error.message) || (inviteResult && inviteResult.message) || '邀请请求失败',
          inviteResult && inviteResult.error
        );
        log('WARN', `BM 邀请失败: ${errMsg}`);
        return res.json({ success: false, message: errMsg, email });
      }

      // 3) 轮询收信并提取邀请链接（最长 pollSeconds 秒，默认 90）
      const cloudBase = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
      const maxWait = Math.min(Math.max(Number(pollSeconds) || 90, 10), 300);
      const deadline = Date.now() + maxWait * 1000;
      let inviteLink = '';
      let emailRowId = null;
      while (Date.now() < deadline && !inviteLink) {
        await sleep(3000);
        try {
          const r = await fetch(`${cloudBase}/api/private-emails/list?address=${encodeURIComponent(email)}&limit=10`);
          const j = await r.json().catch(() => null);
          const rows = (j && j.success && Array.isArray(j.data)) ? j.data : [];
          for (const row of rows) {
            const links = Array.isArray(row.links) ? row.links : [];
            const hit = links.find(u => /business\.facebook\.com/i.test(u)) || links[0] || '';
            if (hit) { inviteLink = hit; emailRowId = row.id; break; }
          }
        } catch (e) {
          log('WARN', `轮询临时邮箱失败（继续重试）: ${e.message}`);
        }
      }

      // 4) 写回云端 businesses 表（邀请链接随 BM 数据持久化，跨设备可见）
      let savedToCloud = false;
      if (inviteLink) {
        try {
          const apiSecret = process.env.PUPPETEER_API_SECRET || '';
          const saveResp = await fetch(`${cloudBase}/api/businesses/set-invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
            body: JSON.stringify({ id: String(businessId), profile_id: String(profileId), invite_email: email, invite_link: inviteLink })
          });
          const sj = await saveResp.json().catch(() => null);
          savedToCloud = !!(sj && sj.success);
          if (!savedToCloud) {
            // 把服务端返回的 error 一并打出来（例如 MySQL: Data too long for column 'invite_link'）
            log('WARN', `邀请链接写回云端失败: ${(sj && sj.message) || '未知原因'}${sj && sj.error ? ' / ' + sj.error : ''}`);
          }
        } catch (e) {
          log('WARN', `邀请链接写回云端异常: ${e.message}`);
        }
      }

      if (!inviteLink) {
        log('WARN', `BM 邀请已发出但 ${maxWait} 秒内未收到邀请邮件: ${businessId} / ${email}`);
        return res.json({
          success: true, invited: true, linkPending: true, email,
          inviteUserId, access_status: inviteResult.access_status || '',
          message: `邀请已发出（${email}），但 ${maxWait} 秒内未收到邀请邮件。可稍后到临时邮箱页查看，或重试提取。`
        });
      }
      log('INFO', `✅ BM 邀请链接已提取: ${businessId} → ${inviteLink.slice(0, 80)}...`);
      return res.json({ success: true, invited: true, email, inviteUserId, inviteLink, emailRowId, savedToCloud });
    } catch (err) {
      log('ERROR', `BM 邀请链接流程异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // POST /api/facebook/business/generate-invite-links
  // Body: { profileId, businessId, count=1, role?, tasks?, accessToken?, pollSeconds? }
  // 作用：为**同一个 BM** 连续生成 count 个邀请链接（每个链接一个独立随机临时邮箱）。
  //   直接复用上面的 invite-user（生成邮箱 → 邀请 → 轮询收信 → 提取链接 → 写回云端），
  //   所以链接同样会持久化到 businesses 表、在 BM 列表可见。
  //   ⚠️ 串行执行：每个链接要轮询收信最长 pollSeconds 秒，N 个 = N×轮询时间，属慢操作，
  //      调用方（队列 op / 创建BM 组合任务）应放在后台队列里跑。
  // -------------------------------------------------------
  _app.post('/api/facebook/business/generate-invite-links', async (req, res) => {
    const { profileId, businessId, count, role, tasks, accessToken, pollSeconds, shopPublish, shopPrice, shopCurrency } = req.body || {};
    if (!profileId || !businessId) {
      return res.status(400).json({ success: false, message: '缺少必要参数: profileId, businessId' });
    }
    const want = Math.min(Math.max(parseInt(count, 10) || 1, 1), 20);
    const apiSecret = process.env.PUPPETEER_API_SECRET || '';
    const links = [];    // 已提取到链接的
    const pending = [];  // 邀请已发出但超时未收到邮件的（可稍后重试提取）
    const failed = [];   // 邀请本身失败的
    log('INFO', `📧 开始批量生成邀请链接: BM=${businessId}, 数量=${want}`);
    for (let i = 0; i < want; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${_PORT}/api/facebook/business/invite-user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
          // 不传 email → 由 invite-user 生成高熵临时邮箱（地址即凭证）
          body: JSON.stringify({ profileId, businessId, role, tasks, accessToken, pollSeconds }),
        });
        const j = await r.json().catch(() => null);
        if (j && j.success && j.inviteLink) {
          links.push({ email: j.email, inviteLink: j.inviteLink });
        } else if (j && j.success) {
          pending.push({ email: j.email, message: j.message || '未收到邀请邮件' });
        } else {
          failed.push({ message: (j && j.message) || '邀请请求失败' });
        }
      } catch (e) {
        failed.push({ message: String(e && e.message || e) });
        log('WARN', `批量邀请第 ${i + 1} 个失败: ${e.message}`);
      }
    }
    log('INFO', `📧 批量生成邀请链接完成: BM=${businessId}, 成功 ${links.length}, 待收信 ${pending.length}, 失败 ${failed.length}`);

    // 🛒 联动：勾选「自动上架商城」时，把成功生成的链接写入商城商品。
    //    走本地代理 /api/shop/save-product（X-Api-Secret 直连云端）；
    //    云端按 bm_id 防重 + itemsMerge 条目合并（重复执行不会插重复商品/条目）。
    let shop = null;
    if (shopPublish && links.length) {
      try {
        const payload = {
          title: `BM ${businessId}`,
          description: 'Business Manager 账号。购买后通过邀请链接接受加入即可获得对应权限。',
          price: Number(shopPrice) || 0,
          currency: String(shopCurrency || 'USDT'),
          product_type: 'bm',
          bm_id: String(businessId),
          profile_id: String(profileId || ''),
          itemsMerge: true,
          items: links.map(l => ({ bm_id: String(businessId), invite_link: l.inviteLink })),
        };
        const sr = await fetch(`http://127.0.0.1:${_PORT}/api/shop/save-product`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
          body: JSON.stringify(payload),
        });
        const sj = await sr.json().catch(() => null);
        shop = sj || { success: false, message: `商城无响应 (${sr.status})` };
        if (shop && shop.success) {
          log('INFO', `🛒 邀请链接已自动上架商城: BM=${businessId}, 商品#${shop.id}, 新增条目 ${shop.added}, 跳过 ${shop.skipped}`);
        } else {
          log('WARN', `🛒 自动上架商城失败: BM=${businessId}, ${(shop && shop.message) || ''}`);
        }
      } catch (e) {
        shop = { success: false, message: String(e && e.message || e) };
        log('WARN', `🛒 自动上架商城异常: BM=${businessId}, ${e.message}`);
      }
    }

    return res.json({
      success: true, businessId, requested: want,
      generated: links.length, links, pending, failed, shop,
      message: `邀请链接 ${links.length}/${want} 个已生成${pending.length ? `，${pending.length} 个待收信` : ''}${failed.length ? `，${failed.length} 个失败` : ''}${shop && shop.success ? `，已自动上架商城(商品#${shop.id}${shop.merged ? `，+${shop.added}条` : ''})` : ''}${shop && shop.success === false ? `，自动上架失败: ${shop.message || ''}` : ''}`,
    });
  });

  // -------------------------------------------------------
  // 商城（板块/商品）代理：本地后端带 X-Api-Secret 直连云端商城接口。
  //   为什么要代理：商城接口要「商城管理员 token」，而浏览器端登录的是主系统账号，拿不到；
  //   本地后端有 PUPPETEER_API_SECRET，云端 shopAdminAuthorized 认它，所以由本机中转。
  // -------------------------------------------------------
  // POST /api/shop/catalog → { success, blocks:[...], products:[...] }
  //   供「生成邀请链接并写入商品」的板块/商品下拉用（含 importable_bms 也一并带回，前端可复用）
  _app.post('/api/shop/catalog', async (req, res) => {
    try {
      const cloudBase = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
      const apiSecret = process.env.PUPPETEER_API_SECRET || '';
      const r = await fetch(`${cloudBase}/api/shop/admin/products`, { headers: { 'X-Api-Secret': apiSecret } });
      const j = await r.json().catch(() => null);
      if (!j || j.success === false) {
        return res.json({ success: false, message: (j && j.message) || `云端商城返回 ${r.status}` });
      }
      return res.json({ success: true, blocks: j.blocks || [], products: j.data || [] });
    } catch (e) {
      return res.status(500).json({ success: false, message: String((e && e.message) || e) });
    }
  });

  // POST /api/shop/save-product  透传到云端 /api/shop/admin/products/save
  //   body 与云端一致：{ id?, title, block_id?, stock?, invite_link?, product_type?, price?, currency?, status? }
  _app.post('/api/shop/save-product', async (req, res) => {
    try {
      const cloudBase = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
      const apiSecret = process.env.PUPPETEER_API_SECRET || '';
      const r = await fetch(`${cloudBase}/api/shop/admin/products/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
        body: JSON.stringify(req.body || {}),
      });
      const j = await r.json().catch(() => null);
      if (!j) return res.status(502).json({ success: false, message: `云端商城无响应 (${r.status})` });
      return res.json(j);
    } catch (e) {
      return res.status(500).json({ success: false, message: String((e && e.message) || e) });
    }
  });

  // -------------------------------------------------------
  // 9b. 广告号授权 / 认领到 BM（把广告号加进某个商务管理平台）
  // POST /api/facebook/adaccounts/assign-to-bm
  // Body: { profileId, assetProfileId?, adAccountIds[], businessId, tasks[], accessToken,
  //         mode: 'claim' | 'client', partnerBusinessId?, partnerTasks? }
  //   ⚠️ profileId 必须是**目标 BM 所属配置**（认领/申请访问权限 = 以 BM 管理员身份发起）；
  //      assetProfileId 是广告号所属配置，只在「分享合作伙伴」那一步当身份用。
  //   两种模式（Meta 语义完全不同，别混）：
  //     claim  认领 → POST /{bm}/owned_ad_accounts  body: adaccount_id=act_x
  //                  广告号**归属**该 BM（一次性，认领后只能在 BM 里管理）。
  //                  返回 access_status：CONFIRMED=立即生效；PENDING=已发认领请求等管理员批。
  //     client 申请访问权限 → POST /{bm}/client_ad_accounts  body: adaccount_id + permitted_tasks
  //                  只是**申请**访问，等对方广告号管理员批准，归属不变。
  //   可选 partnerBusinessId：主操作成功后再把广告号分享给另一家 BM（合作伙伴）。
  // -------------------------------------------------------
  // 把某个广告号加到 BM 的某条边上（owned_ad_accounts / client_ad_accounts）。
  // ⚠️ 参数名各版本不一致（adaccount_id / ad_account_id，有的还收不带 act_ 前缀的纯数字），
  //    所以这里做「换名重试」，但只在报参数类错误时才换 —— 别的错（已在 BM、无权限）重试没意义。
  async function addAdAccountToBusiness(businessId, actId, permittedTasks, profile, token, edge) {
    const variants = edge === 'client_ad_accounts'
      ? [
        { key: 'adaccount_id', value: `act_${actId}` },
        { key: 'ad_account_id', value: actId },
        { key: 'adaccount_id', value: actId }
      ]
      : [
        { key: 'adaccount_id', value: `act_${actId}` },
        { key: 'adaccount_id', value: actId },
        { key: 'ad_account_id', value: actId }
      ];
    let last = null;
    for (const v of variants) {
      const form = new URLSearchParams();
      form.append(v.key, v.value);
      if (edge === 'client_ad_accounts') form.append('permitted_tasks', JSON.stringify(permittedTasks));
      const r = await callFacebookGraphApi(`${businessId}/${edge}`, 'POST', form, profile, token);
      if (r && !r.error) return { ok: true, raw: r, via: `${v.key}=${v.value}` };
      last = r;
      const msg = String(r?.error?.message || '');
      if (!/param|adaccount_id|ad_account_id|Unknown/i.test(msg)) break;
      log('WARN', `⚠️ [assign-to-bm] ${edge} 用 ${v.key}=${v.value} 失败，换参数名重试: ${msg}`);
    }
    return { ok: false, raw: last };
  }

  _app.post('/api/facebook/adaccounts/assign-to-bm', async (req, res) => {
    try {
      const {
        profileId, assetProfileId, adAccountIds, businessId, tasks, accessToken,
        mode, partnerBusinessId, partnerTasks
      } = req.body || {};
      if (!profileId || !businessId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, businessId' });
      }
      if (!Array.isArray(adAccountIds) || adAccountIds.length === 0) {
        return res.status(400).json({ success: false, message: '没有可授权的广告号' });
      }
      // ⚠️ profileId 必须是**目标 BM 所属配置**：Meta 认领文档明确「发送请求的用户必须是
      //    认领该广告账户的企业的管理员」，用广告号所属配置的 token 会稳定报
      //    (#10) ...requires that you can MANAGE_AD_ACCOUNTS for this business account。
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: `配置 ${profileId} 缺少 Access Token（认领/申请访问权限需要目标 BM 管理员身份的 token）` });
      }

      // 分享合作伙伴那一步是「广告号」侧的资产分享，身份要用广告号所属配置（没给就复用主配置）
      let partnerProfile = profile;
      let partnerToken = effectiveToken;
      if (assetProfileId && String(assetProfileId) !== String(profileId)) {
        try {
          const ap = await findProfileById(assetProfileId);
          const at = ap?.account_tokens || ap?.token || '';
          if (at) { partnerProfile = ap; partnerToken = at; }
        } catch (e) {
          log('WARN', `⚠️ [assign-to-bm] 取广告号所属配置 ${assetProfileId} 的 token 失败，改用 ${profileId} 的: ${e.message}`);
        }
      }

      const permittedTasks = Array.isArray(tasks) && tasks.length ? tasks : ['MANAGE', 'ADVERTISE', 'ANALYZE'];
      const edge = mode === 'client' ? 'client_ad_accounts' : 'owned_ad_accounts';
      const partnerBiz = partnerBusinessId ? String(partnerBusinessId) : '';
      const partnerTaskList = Array.isArray(partnerTasks) && partnerTasks.length ? partnerTasks : permittedTasks;
      log('INFO', `📌 [assign-to-bm] 把 ${adAccountIds.length} 个广告号${edge === 'client_ad_accounts' ? '申请访问权限' : '认领'}到 BM ${businessId}（${edge} · 权限 ${permittedTasks.join('/')}）${partnerBiz ? ` · 并分享给合作伙伴 ${partnerBiz}` : ''}`);

      const results = [];
      for (const rawId of adAccountIds) {
        const actId = String(rawId).replace(/^act_/, '');
        try {
          const r = await addAdAccountToBusiness(businessId, actId, permittedTasks, profile, effectiveToken, edge);
          if (!r.ok) {
            results.push({ adAccountId: actId, status: 'error', message: r.raw?.error?.message || '未知错误' });
            continue;
          }

          // 认领会回 access_status，必须区分「立即生效」和「等对方批」，否则用户以为成功其实还挂着
          const accessStatus = String(r.raw?.access_status || '').toUpperCase();
          let msg;
          if (edge === 'client_ad_accounts') {
            msg = accessStatus === 'CONFIRMED'
              ? '已获得访问权限'
              : '已发送访问权限申请（等对方广告号管理员批准）';
          } else if (accessStatus === 'CONFIRMED') {
            msg = '已认领（立即生效）';
          } else if (accessStatus === 'PENDING') {
            msg = '已发送认领请求（等广告号管理员批准）';
          } else {
            msg = '已提交';
          }

          // 可选：再分享给合作伙伴 BM
          if (partnerBiz) {
            const shareMsg = await shareAdAccountToPartner(actId, partnerBiz, partnerTaskList, partnerProfile, partnerToken);
            results.push({
              adAccountId: actId,
              status: 'success',
              message: shareMsg ? `${msg}；分享合作伙伴：${shareMsg}` : msg,
              accessStatus: accessStatus || undefined
            });
          } else {
            results.push({ adAccountId: actId, status: 'success', message: msg, accessStatus: accessStatus || undefined });
          }
        } catch (e) {
          results.push({ adAccountId: actId, status: 'error', message: String(e.message || e) });
        }
      }

      const okCount = results.filter(r => r.status === 'success').length;
      const pendingCount = results.filter(r => r.accessStatus && r.accessStatus !== 'CONFIRMED').length;
      return res.json({
        success: okCount > 0,
        message: `授权到 BM 完成: ${okCount}/${adAccountIds.length} 成功${pendingCount ? `（其中 ${pendingCount} 个待对方批准）` : ''}`,
        businessId: String(businessId),
        mode: edge === 'client_ad_accounts' ? 'client' : 'claim',
        results
      });
    } catch (err) {
      log('ERROR', `[assign-to-bm] 异常: ${err.message}`);
      return res.status(500).json({ success: false, message: String(err.message || err) });
    }
  });

  // 把广告号分享给另一家 BM（合作伙伴）：先试 assigned_partners，失败退回对方 BM 的 client_ad_accounts。
  // 返回一句人话结果（成功/失败原因），失败不抛错 —— 它只是主操作的可选附加步骤。
  async function shareAdAccountToPartner(actId, partnerBusinessId, taskList, profile, token) {
    try {
      const f1 = new URLSearchParams();
      f1.append('partner', String(partnerBusinessId));
      f1.append('tasks', JSON.stringify(taskList));
      const r1 = await callFacebookGraphApi(`act_${actId}/assigned_partners`, 'POST', f1, profile, token);
      if (r1 && !r1.error) return '已分享';

      const f2 = new URLSearchParams();
      f2.append('ad_account_id', actId);
      f2.append('permitted_tasks', JSON.stringify(taskList));
      const r2 = await callFacebookGraphApi(`${partnerBusinessId}/client_ad_accounts`, 'POST', f2, profile, token);
      if (r2 && !r2.error) return '已分享（client_ad_accounts）';

      const why = r1?.error?.message || r2?.error?.message || '未知错误';
      log('WARN', `⚠️ [assign-to-bm] 分享 ${actId} 给合作伙伴 ${partnerBusinessId} 失败: ${why}`);
      return `失败（${why}）`;
    } catch (e) {
      log('WARN', `⚠️ [assign-to-bm] 分享 ${actId} 给合作伙伴 ${partnerBusinessId} 异常: ${e.message}`);
      return `异常（${e.message}）`;
    }
  }


  // -------------------------------------------------------
  // 🆕 把广告号授权给某个 FB 用户（个人号）
  // 🐛 老代码发的是 `user_id` + `permissions`，两个参数都不对：Meta 的
  //    POST /{ad-account-id}/userpermissions 要的是 `user`，并且 **role / tasks 二选一**，
  //    所以一直报 (#100) Requires exactly one and only one of the params: role,tasks ——
  //    业务上表现为「好友加成功了，但广告号没授权过去」。
  // 🐛 而且老代码用 `result.success !== false` 判成功，FB 报错时返回 {error:{...}}（没有 success 字段），
  //    undefined !== false 为真 → 错误被当成成功，所以界面上还显示「授权成功」。
  // 返回 { ok, message }
  // -------------------------------------------------------
  // 🐛 第三坑：即使改成 `user` + `role`，Meta 还会报 `(#100) The parameter business is required`
  //    —— `business` 是**必填**，指的是「这个广告号挂在哪家 BM 下」。
  //    用户界面上通常不知道该填哪个，所以这里自动定位，三步走：
  //      ① 直接问广告号自己 act_x?fields=business,owner_business（最准，但常常是空的）
  //      ② 拉当前用户所有 BM，逐个查 owned_ad_accounts / client_ad_accounts 里有没有这个广告号
  //      ③ 都不行就返回 null，让调用方提示用户手填 businessId
  async function listBusinessIds(profile, token) {
    try {
      const r = await callFacebookGraphApi('me/businesses?fields=id,name&limit=100', 'GET', null, profile, token);
      const data = Array.isArray(r?.data) ? r.data : [];
      return data.map(b => ({ id: String(b.id), name: String(b.name || '') }));
    } catch (e) {
      log('WARN', `⚠️ [授权] 拉取账号名下 BM 列表失败: ${e.message}`);
      return [];
    }
  }

  async function resolveAdAccountBusiness(actId, profile, token, hintBiz) {
    if (hintBiz) return String(hintBiz);

    // ① 问广告号自己
    try {
      const r = await callFacebookGraphApi(
        `act_${actId}?fields=business,owner_business`, 'GET', null, profile, token
      );
      const id = r?.owner_business?.id || r?.business?.id;
      if (id) {
        log('INFO', `ℹ️ [授权] act_${actId} 直接解析到所属 BM: ${id}`);
        return String(id);
      }
      log('DEBUG', `ℹ️ [授权] act_${actId} 自身没有 business 字段，回退枚举 BM：${JSON.stringify(r).slice(0, 300)}`);
    } catch (e) {
      log('WARN', `⚠️ [授权] act_${actId} 反查所属 BM 失败: ${e.message}`);
    }

    // ② 枚举 BM 反查
    const bms = await listBusinessIds(profile, token);
    for (const bm of bms) {
      for (const edge of ['owned_ad_accounts', 'client_ad_accounts']) {
        try {
          const r = await callFacebookGraphApi(
            `${bm.id}/${edge}?fields=account_id&limit=500`, 'GET', null, profile, token
          );
          const hit = (r?.data || []).some(a => String(a.account_id || '').replace(/^act_/, '') === String(actId));
          if (hit) {
            log('INFO', `ℹ️ [授权] act_${actId} 在 BM ${bm.id}(${bm.name}) 的 ${edge} 里找到`);
            return bm.id;
          }
        } catch (e) {
          log('DEBUG', `⚠️ [授权] 查 ${bm.id}/${edge} 失败: ${e.message}`);
        }
      }
    }
    log('WARN', `⚠️ [授权] act_${actId} 未能定位所属 BM（共查了 ${bms.length} 个 BM）`);
    return null;
  }

  // 🎯 抓包还原（2026-09-21，配置 4340 在 Ads Manager 里手动授权一次录到的真实请求）：
  //     POST https://adsmanager-graph.facebook.com/v22.0/act_{actId}/users?_reqName=adaccount%2Fusers
  //     参数是 `uid`（不是 user / user_id）+ `role`（**数字 ID**，不是 'ADMIN' 字符串）
  //     _reqSrc=AdsPermissionDialogController 说明这就是「广告号 → 人员权限」弹窗发的那一发。
  //     三个 role ID 由用户逐档实测确认：
  const FB_ADACCOUNT_ROLE = {
    ADMIN: '281423141961500',      // 管理员
    ADVERTISER: '461336843905730', // 普通权限
    ANALYST: '498940650138739'     // 分析师
  };

  async function grantAdAccountToUser(actId, fbUserId, profile, token, role = 'ADMIN') {
    const roleKey = String(role || 'ADMIN').toUpperCase();
    const roleId = FB_ADACCOUNT_ROLE[roleKey] || FB_ADACCOUNT_ROLE.ADMIN;
    let lastErr = '';

    // ① 主力：Ads Manager 内部接口（抓包原样还原）
    try {
      const form = new URLSearchParams();
      form.append('account_id', String(actId));
      form.append('method', 'post');
      form.append('uid', String(fbUserId));
      form.append('role', roleId);
      form.append('ads_manager_write_regions', 'true');
      form.append('include_headers', 'false');
      form.append('locale', 'en_US');
      form.append('pretty', '0');
      form.append('suppress_http_code', '1');
      form.append('_reqName', 'adaccount/users');
      form.append('_reqSrc', 'AdsPermissionDialogController');
      const r = await callFacebookGraphApi(
        `https://adsmanager-graph.facebook.com/v22.0/act_${actId}/users?_reqName=adaccount%2Fusers`,
        'POST', form, profile, token
      );
      if (r && !r.error) return { ok: true, message: `授权成功（${roleKey} · ${roleId}）` };
      lastErr = r?.error?.message || r?.error_user_msg || '未知错误';
      log('WARN', `⚠️ [授权] act_${actId} 走 adsmanager/users 失败: ${lastErr}`);
    } catch (e) { lastErr = String(e.message || e); }

    // ② 回退：公开 Graph 的同名边 act_x/users（同样的 uid + role）
    try {
      const form = new URLSearchParams();
      form.append('uid', String(fbUserId));
      form.append('role', roleId);
      const r = await callFacebookGraphApi(`act_${actId}/users`, 'POST', form, profile, token);
      if (r && !r.error) return { ok: true, message: `授权成功（${roleKey} · 公开 users 边）` };
      lastErr = r?.error?.message || r?.error_user_msg || lastErr;
      log('WARN', `⚠️ [授权] act_${actId} 走公开 users 边失败: ${lastErr}`);
    } catch (e) { lastErr = String(e.message || e) || lastErr; }

    // ③ 兜底：BM 归属的广告号走 userpermissions（需要 business）
    const biz = await resolveAdAccountBusiness(actId, profile, token, null);
    if (biz) {
      try {
        const form = new URLSearchParams();
        form.append('user', String(fbUserId));
        form.append('business', String(biz));
        form.append('role', roleKey);
        const r = await callFacebookGraphApi(`act_${actId}/userpermissions`, 'POST', form, profile, token);
        if (r && !r.error) return { ok: true, message: `授权成功（userpermissions · BM ${biz}）` };
        lastErr = r?.error?.message || r?.error_user_msg || lastErr;
        log('WARN', `⚠️ [授权] act_${actId} 走 userpermissions 失败: ${lastErr}`);
      } catch (e) { lastErr = String(e.message || e) || lastErr; }
    }

    return { ok: false, message: lastErr || '授权失败' };
  }

  // -------------------------------------------------------
  // 7. 广告号授权到个人号 (传入 FB 用户 ID,固定全权限)
  // POST /api/facebook/adaccounts/assign-personal
  // Body: { profileId, adAccountIds, fbUserId, accessToken, businessId, autoFetchAdAccounts }
  // -------------------------------------------------------
  _app.post('/api/facebook/adaccounts/assign-personal', async (req, res) => {
    try {
      const { profileId, adAccountIds, fbUserId, accessToken, businessId, autoFetchAdAccounts, role } = req.body || {};
      if (!profileId || !fbUserId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, fbUserId' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      // 🆕 自动获取 BM 拥有的广告号
      let finalAccountIds = adAccountIds;
      if ((!finalAccountIds || !Array.isArray(finalAccountIds) || finalAccountIds.length === 0) && autoFetchAdAccounts && businessId) {
        log('INFO', `🔄 [assign-personal] 自动获取 BM ${businessId} 的 owned_ad_accounts...`);
        try {
          const ownedResult = await callFacebookGraphApi(
            `${businessId}?fields=owned_ad_accounts{id,account_id,name,account_status}`,
            'GET', null, profile, effectiveToken
          );
          if (ownedResult?.owned_ad_accounts?.data) {
            finalAccountIds = ownedResult.owned_ad_accounts.data
              .filter(a => String(a.account_status) === '1')
              .map(a => a.account_id || a.id);
            log('INFO', `✅ [assign-personal] 自动获取到 ${finalAccountIds.length} 个活跃广告号`);
          }
        } catch (e) {
          log('WARN', `[assign-personal] 自动获取 owned_ad_accounts 失败: ${e.message}`);
        }
      }

      if (!finalAccountIds || !Array.isArray(finalAccountIds) || finalAccountIds.length === 0) {
        return res.status(400).json({ success: false, message: '没有可授权的广告号。请传入 adAccountIds 或提供 businessId + autoFetchAdAccounts' });
      }

      log('INFO', `📌 [assign-personal] 授权 ${finalAccountIds.length} 个广告号给个人号 ${fbUserId}`);

      const results = [];
      for (const rawId of finalAccountIds) {
        const actId = String(rawId).replace(/^act_/, '');
        try {
          const r = await grantAdAccountToUser(actId, fbUserId, profile, effectiveToken, role || 'ADMIN');
          results.push({ adAccountId: actId, status: r.ok ? 'success' : 'error', message: r.message });
        } catch (e) {
          results.push({ adAccountId: actId, status: 'error', message: e.message });
        }
      }

      const successCount = results.filter(r => r.status === 'success').length;
      return res.json({ success: successCount > 0, message: `授权完成: ${successCount}/${finalAccountIds.length} 成功`, results });
    } catch (err) {
      log('ERROR', `[assign-personal] 广告号授权到个人号异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 8. 主页授权到个人号 (传入 FB 用户 ID,固定全权限)
  // POST /api/facebook/pages/grant-personal
  // Body: { profileId, pageIds, fbUserId, accessToken, businessId, autoFetchPages }
  // -------------------------------------------------------
  _app.post('/api/facebook/pages/grant-personal', async (req, res) => {
    try {
      const { profileId, pageIds, fbUserId, accessToken, businessId, autoFetchPages } = req.body || {};
      if (!profileId || !fbUserId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, fbUserId' });
      }
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      // 🆕 自动获取 BM 拥有的主页
      let finalPageIds = pageIds;
      if ((!finalPageIds || !Array.isArray(finalPageIds) || finalPageIds.length === 0) && autoFetchPages && businessId) {
        log('INFO', `🔄 [grant-personal] 自动获取 BM ${businessId} 的 owned_pages...`);
        try {
          const ownedResult = await callFacebookGraphApi(
            `${businessId}?fields=owned_pages{id,name}`,
            'GET', null, profile, effectiveToken
          );
          if (ownedResult?.owned_pages?.data) {
            finalPageIds = ownedResult.owned_pages.data.map(p => p.id);
            log('INFO', `✅ [grant-personal] 自动获取到 ${finalPageIds.length} 个主页`);
          }
        } catch (e) {
          log('WARN', `[grant-personal] 自动获取 owned_pages 失败: ${e.message}`);
        }
      }

      if (!finalPageIds || !Array.isArray(finalPageIds) || finalPageIds.length === 0) {
        return res.status(400).json({ success: false, message: '没有可授权的主页。请传入 pageIds 或提供 businessId + autoFetchPages' });
      }

      // 🧾 明确区分「执行身份」和「授权对象」：两者都是账号，日志里以前只写「授权 N 个主页给个人号 X」，
      //    看不出是哪个配置在执行（一个主页可能有多个关联账号，容易被误读成所有账号都在授权）
      log('INFO', `📌 [grant-personal] 执行身份: 配置 ${profileId}（发邀请时切到主页身份）→ 授权对象: 个人号 FB ${fbUserId}；主页 ${finalPageIds.length} 个: ${finalPageIds.join(', ')}`);

      // 主页全权限: MANAGE, CREATE_CONTENT, MODERATE, ADVERTISE, ANALYZE（老接口兜底时用）
      const allTasks = ['MANAGE', 'CREATE_CONTENT', 'MODERATE', 'ADVERTISE', 'ANALYZE'];

      // 🎯 主路：新版主页（profile plus）的管理员邀请，走 FB 内部 GraphQL。
      //    老 Graph API 的 assigned_users 只认 BM 内的 business-scoped 用户 ID，
      //    喂普通个人 FB 用户 ID 会被 FB 直接拒（实测 Invalid parameter 100「用户不在业务范围内」）。
      const results = await invitePageAdminsViaBrowser(profileId, finalPageIds, fbUserId);

      // 兜底：内部 GraphQL 没成的，再用老 Graph API 试一次（老版主页可能只认这条）
      const retryList = results.filter(r => r.status !== 'success');
      if (retryList.length) {
        log('WARN', `[grant-personal] 内部 GraphQL 未成功 ${retryList.length} 个，回退老接口 assigned_users。原因: ${retryList.map(r => `${r.pageId}: ${r.message}`).join('；')}`);
        for (const item of retryList) {
          try {
            const formData = new URLSearchParams();
            formData.append('user', fbUserId);
            formData.append('tasks', JSON.stringify(allTasks));
            formData.append('access_token', effectiveToken);

            const result = await callFacebookGraphApi(`${item.pageId}/assigned_users`, 'POST', formData, profile, effectiveToken);

            // 🐛 同上：不能再用 `result.success !== false` —— FB 报错时返回 {error:{...}}，
            //    success 字段不存在，undefined !== false 为真会把错误判成成功。
            if (result && !result.error) {
              item.status = 'success';
              item.message = '授权成功（老接口）';
              item.via = 'graph';
            } else {
              const errMsg = result?.error?.message || result?.error_user_msg || '未知错误';
              item.message = `${item.message}；老接口兜底: ${errMsg}`;
            }
          } catch (e) {
            item.message = `${item.message}；老接口兜底异常: ${e.message}`;
          }
        }
      }

      const successCount = results.filter(r => r.status === 'success').length;
      return res.json({ success: successCount > 0, message: `授权完成: ${successCount}/${finalPageIds.length} 成功`, results });
    } catch (err) {
      log('ERROR', `[grant-personal] 主页授权到个人号异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 8b. 发布 / 取消发布主页 (Graph API)
  // POST /api/facebook/pages/publish
  // Body: { profileId, pageIds, publish, accessToken }
  // 主页节点的 is_published 字段：publish=true 发布，false 取消发布
  // -------------------------------------------------------
  _app.post('/api/facebook/pages/publish', async (req, res) => {
    try {
      const { profileId, pageIds, publish, accessToken } = req.body || {};
      if (!profileId || !Array.isArray(pageIds) || pageIds.length === 0) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, pageIds' });
      }
      const target = publish !== false;   // 不传默认「发布」
      const profile = await findProfileById(profileId);
      const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) {
        return res.status(400).json({ success: false, message: '缺少 Access Token' });
      }

      log('INFO', `📌 [pages/publish] ${target ? '发布' : '取消发布'} ${pageIds.length} 个主页 (profile ${profileId})`);

      const results = [];
      for (const rawId of pageIds) {
        const pid = String(rawId);
        try {
          const formData = new URLSearchParams();
          formData.append('is_published', target ? 'true' : 'false');
          formData.append('access_token', effectiveToken);

          const result = await callFacebookGraphApi(pid, 'POST', formData, profile, effectiveToken);

          // 🐛 同 grant-personal：FB 报错返回 {error:{...}}，没有 success 字段，
          //    必须判 result.error 而不是 result.success !== false
          if (result && !result.error) {
            results.push({ pageId: pid, status: 'success', message: target ? '已发布' : '已取消发布' });
          } else {
            const errMsg = result?.error?.message || result?.error_user_msg || '未知错误';
            results.push({ pageId: pid, status: 'error', message: errMsg });
          }
        } catch (e) {
          results.push({ pageId: pid, status: 'error', message: e.message });
        }
      }

      const successCount = results.filter(r => r.status === 'success').length;
      return res.json({
        success: successCount > 0,
        message: `${target ? '发布' : '取消发布'}完成: ${successCount}/${pageIds.length} 成功`,
        results,
      });
    } catch (err) {
      log('ERROR', `[pages/publish] 异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // 启动/关闭广告账户（占位：返回成功）
  _app.post('/api/facebook/adaccounts/account/start', async (req, res) => {
    try {
      const { profileId, adAccountId } = req.body || {}
      if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
      return res.json({ success: true, op: 'start' })
    } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
  });
  _app.post('/api/facebook/adaccounts/account/stop', async (req, res) => {
    try {
      const { profileId, adAccountId } = req.body || {}
      if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
      return res.json({ success: true, op: 'stop' })
    } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
  });

  // 🔒 同配置创建串行闸门：批量 create_bm_bundle（全局并发 10）时，同一 profile 的多个任务项
  //    轮询等到浏览器就绪后会**同时**进入复用分支 —— 共享 pages[0] 导航互相打断，且人人都置
  //    shouldClose=true，任一先完成就 browser.close() → 其余任务中途 Target closed。
  //    浏览器使用必须按 profile 串行。队列单项超时 600s，这里等待上限取 420s（留足执行余量）。
  //    超时/断开的请求必须把闸门放回去（abandoned 标记 + releaseGate），否则队列永久堵死。
  const _createBmGates = new Map(); // profileId -> 队尾 Promise（前一个使用者的完成信号）
  function _enterCreateBmGate(profileId, res, waitMs = 420000) {
    const key = String(profileId);
    const prev = Promise.resolve(_createBmGates.get(key)).catch(() => {});
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    _createBmGates.set(key, prev.then(() => gate));
    let abandoned = false;
    const timer = setTimeout(() => { abandoned = true; releaseGate(); }, waitMs);
    return prev.then(() => {
      clearTimeout(timer);
      // 轮到本请求：正常 → 返回 release（调用方用完必须调用）；
      // 排队期间超时放弃 / 客户端已断开 → 立刻放行下一个并让调用方直接返回
      if (abandoned || res.destroyed) { releaseGate(); return null; }
      return releaseGate;
    });
  }

  // 🚀 创建BM：启动浏览器 → 提取token → API创建（不点UI）
  _app.post('/api/facebook/business/create', async (req, res) => {
    try {
      const { profileId, name, email, proxyOverride, createAdAccount, createPage, defaultPageName,
        adAccountCount = 1, adNameMode = 'manual', adNameManual, adBilling,
        // 🆕 创建者名字/姓氏：前端「名字/姓氏 用配置 ID」勾选后会传过来。
        //    🐛 以前这里没接收 → 下一段又硬编码用 BM 名称 → 整个「用配置 ID」选项完全无效。
        firstName, lastName,
        timezoneId, currency } = req.body || {};
      if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
      log('INFO', `[CreateBM] 开始: profileId=${profileId}, name=${name}, email=${email || '(将使用账号配置邮箱兜底)'}, createAdAccount=${!!createAdAccount}, createPage=${!!createPage}${proxyOverride ? ', 使用代理覆盖' : ''}`);

      const actualProfile = await findProfileById(profileId);
      if (!actualProfile) return res.status(404).json({ success: false, message: 'profile_not_found' });

      // 🔒 排队等本配置的浏览器使用权（同配置任务串行，见 _enterCreateBmGate 注释）
      const releaseGate = await _enterCreateBmGate(profileId, res);
      if (!releaseGate) return res.status(409).json({ success: false, message: '同配置创建排队超时，请减少同配置的并发创建数后重试' });

      // 🚀 临时覆盖代理（不保存到配置）
      const originalProxy = actualProfile.proxy ? { ...actualProfile.proxy } : null;
      if (proxyOverride) {
        actualProfile.proxy = proxyOverride;
        log('INFO', `[CreateBM] 临时代理覆盖: ${proxyOverride.host}:${proxyOverride.port} (${proxyOverride.type || 'http'})`);
      }

      let browser, page, shouldClose = false;
      // 🆕 待补写的账单（创建广告号成功后登记，等浏览器关掉之后单独串行写，见下面成功返回处与 finally）
      let pendingBilling = null;
      try {
        // 🚀 启动/复用配置浏览器（代理/Cookie/指纹完整加载）
        const existing = _activeBrowsers.get(profileId);
        if (existing && existing.browser && existing.browser.isConnected()) {
          log('INFO', `[CreateBM] 复用已运行的浏览器: ${profileId}`);
          browser = existing.browser;
          const pages = await browser.pages();
          page = pages.length > 0 ? pages[0] : await browser.newPage();
        } else {
          const hdrs = { 'Content-Type': 'application/json' };
          if (req.headers['authorization']) hdrs['Authorization'] = req.headers['authorization'];
          if (req.headers['x-api-secret']) hdrs['X-Api-Secret'] = req.headers['x-api-secret'];
          const lr = await fetch(`http://127.0.0.1:${_PORT}/api/launch-browser`, {
            method: 'POST', headers: hdrs,
            body: JSON.stringify({ profileId, profile: actualProfile, proxy: actualProfile.proxy, startUrls: ['https://www.facebook.com/'], strictStartUrls: true, skipStartUrls: false })
          });
          const lj = await lr.json().catch(() => ({}));
          if (!lj.success) return res.status(500).json({ success: false, message: lj.message || 'browser_launch_failed' });
          // 🐛 原来睡 2 秒后只查一次：批量 create_bm_bundle（并发 10）时，同一 profile 的多个任务项
          //    并发调 launch-browser，只有第一项真正启动，其余命中防重入返回 duplicate（success=true
          //    但浏览器还在冷启动，实测冷启动 10~30s）→ 2 秒后 _activeBrowsers 必然还没有 →
          //    大面积 browser_launch_failed_no_page（实测 24 项失败 20）。
          //    改成轮询等待浏览器真正就绪（最长 45s，1s 一次）。
          let entry = null;
          for (let i = 0; i < 45; i++) {
            const cur = _activeBrowsers.get(profileId);
            if (cur && cur.browser && cur.browser.isConnected()) { entry = cur; break; }
            await sleep(1000);
          }
          if (!entry) return res.status(500).json({ success: false, message: 'browser_launch_failed_no_page' });
          browser = entry.browser;
          const pages = await browser.pages();
          page = pages.length > 0 ? pages[0] : await browser.newPage();
          shouldClose = true;
        }

        // 🌐 确保在 Facebook
        if (!page.url().includes('facebook.com')) {
          await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          await sleep(2000);
        }

        // 🚀 等待 Facebook SPA 初始化（确保 window.dtsg 可用）
        try { await page.waitForFunction(() => typeof window.dtsg !== 'undefined' && window.dtsg !== '', { timeout: 20000 }); } catch {}
        await sleep(2000);

        // 📮 BM 创建邮箱：@creator.fb.com 回退和自有收信域名（账号配置邮箱）会导致新 BM 被 Meta 打低信任标，
        //    邀请成员时报 (#3) Business must be on whitelist（2026-10 实测：手动用随机 gmail.com 创建的 BM 可正常邀请）。
        //    旧注释「Facebook 校验 business_email 真实性(1752189) 随机 gmail 会被拒」已过时——实测随机 gmail.com 可通过。
        //    优先级：请求显式传入 email → 否则随机生成 Gmail 风格地址（字母开头+字母数字混合，模拟真人填法）
        let finalEmail = String(email || '').trim();
        if (!finalEmail) {
          const _gmailLocal = () => {
            const cons = 'bcdfghjklmnprstvwxz';
            let r = '';
            for (let i = 0; i < 4; i++) r += cons[Math.floor(Math.random() * cons.length)];
            return r + Math.random().toString(36).slice(2, 12).replace(/[^a-z0-9]/g, '');
          };
          finalEmail = `${_gmailLocal()}@gmail.com`;
          log('INFO', `[CreateBM] 未提供邮箱, 已生成 Gmail 风格地址: ${finalEmail}`);
        }

        // 🔑 从页面提取 session 参数 (fb_dtsg, __user, spinR 等)
        const sessionData = await page.evaluate(() => {
          let fbDtsg = (typeof window !== 'undefined' && window.dtsg) || '';
          let userId = '', spinR = '', spinB = '', spinT = '', hsi = '';
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const html = s.innerHTML || '';
            const uidMatch = html.match(/"USER_ID":"(\d+)"/) || html.match(/"userID":"(\d+)"/);
            if (uidMatch) userId = uidMatch[1];
            const spinRMatch = html.match(/__spin_r=(\d+)/);
            if (spinRMatch) spinR = spinRMatch[1];
            const spinBMatch = html.match(/__spin_b=([^"&]+)/);
            if (spinBMatch) spinB = spinBMatch[1];
            const spinTMatch = html.match(/__spin_t=([^"&]+)/);
            if (spinTMatch) spinT = spinTMatch[1];
            const hsiMatch = html.match(/__hsi=(\d+)/);
            if (hsiMatch) hsi = hsiMatch[1];
            if (!fbDtsg) {
              const dtsgMatch = html.match(/"dtsg":\{"token":"([^"]+)"/);
              if (dtsgMatch) fbDtsg = dtsgMatch[1];
            }
          }
          return { fbDtsg, userId, spinR, spinB, spinT, hsi };
        });

        if (!sessionData.fbDtsg || !sessionData.userId) {
          return res.status(400).json({ success: false, message: '浏览器未登录 Facebook,请先登录' });
        }

        // 🚀 使用 GraphQL 方式创建 BM（与 bookmarklet 方式 A 一致,绕过 Graph API 的 business_email 校验问题）
        // 🐛 以前这里硬编码 fullName=name / shortName=name 前 8 位，前端传的 firstName/lastName 被丢弃。
        //    现在优先用传入值（「用配置 ID」= 传该配置的 profileId），未传才回落成 BM 名称。
        const fullName = (firstName && String(firstName).trim()) || name;
        const shortName = (lastName && String(lastName).trim()) || name.substring(0, 8);
        const createResult = await page.evaluate(async (params) => {
          const { bmName, bmEmail, fullName, shortName, fbDtsg, userId, spinR, spinB, spinT, hsi } = params;
          const apiUrl = 'https://www.facebook.com/api/graphql/';
          const urlencoded = new URLSearchParams();
          urlencoded.append('__rev', spinR || '1005599768');
          urlencoded.append('__hsi', hsi || '');
          urlencoded.append('__spin_r', spinR || '1005599768');
          urlencoded.append('__spin_b', spinB || '');
          urlencoded.append('__spin_t', spinT || '');
          urlencoded.append('fb_api_caller_class', 'RelayModern');
          urlencoded.append('fb_api_req_friendly_name', 'useBusinessCreationMutationMutation');
          urlencoded.append('av', userId);
          urlencoded.append('__user', userId);
          urlencoded.append('fb_dtsg', fbDtsg);
          urlencoded.append('variables', JSON.stringify({
            input: {
              client_mutation_id: '1',
              actor_id: userId,
              business_name: bmName,
              user_first_name: fullName,
              user_last_name: shortName,
              user_email: bmEmail,
              creation_source: 'FBS_BUSINESS_CREATION_FLOW'
            }
          }));
          urlencoded.append('doc_id', '7183377418404152');
          urlencoded.append('server_timestamps', 'true');

          try {
            const resp = await fetch(apiUrl, {
              mode: 'cors', method: 'POST', credentials: 'include', redirect: 'follow', body: urlencoded
            });
            return await resp.json();
          } catch (e) {
            return { error: { message: e.message } };
          }
        }, { bmName: name, bmEmail: finalEmail, fullName, shortName, ...sessionData });

        log('INFO', `[CreateBM] GraphQL 响应: ${JSON.stringify(createResult).substring(0, 500)}`);

        if (createResult?.data?.bizkit_create_business?.id) {
          const bmId = createResult.data.bizkit_create_business.id;
          log('SUCCESS', `[CreateBM] 成功: id=${bmId}`);

          // 🚀 勾选了创建广告号 — 使用 profile token 通过 Graph API 创建（可按数量创建多个）
          const adAccountResults = [];
          if (createAdAccount) {
            const adCount = Math.max(1, Math.min(20, parseInt(adAccountCount, 10) || 1));
            try {
              log('INFO', `[CreateBM] 开始创建 ${adCount} 个广告号 (BM=${bmId})`);
              const effectiveToken = actualProfile.account_tokens || actualProfile.token || '';
              if (!effectiveToken) {
                for (let k = 0; k < adCount; k++) adAccountResults.push({ success: false, error: 'profile 无可用 access_token' });
                log('WARN', `[CreateBM] 广告号创建失败: 无 token`);
              } else {
                for (let k = 0; k < adCount; k++) {
                  // 🆕 名称在执行到这一行时才生成（时间戳取当下，不是提交时）；同批追加 _2、_3 避免重名
                  const adName = buildAdAccountName(adNameMode, adNameManual, k) || name;
                  // 🆕 时区/货币用调用方传入的（以前硬编码 '12'=London / USD，
                  //    导致「创建BM时顺带建广告号」永远建出伦敦时区）
                  const tzNum = Number(timezoneId);
                  const adFormData = new URLSearchParams();
                  adFormData.append('name', adName);
                  adFormData.append('timezone_id', Number.isFinite(tzNum) && tzNum >= 1 ? String(tzNum) : '1');
                  adFormData.append('currency', String(currency || 'USD'));
                  adFormData.append('end_advertiser', 'NONE');
                  adFormData.append('media_agency', 'NONE');
                  adFormData.append('partner', 'NONE');
                  adFormData.append('access_token', effectiveToken);
                  const adResp = await fetch(`https://graph.facebook.com/v19.0/${bmId}/adaccount`, {
                    method: 'POST', body: adFormData, credentials: 'include'
                  });
                  const adJson = await adResp.json().catch(() => ({}));
                  if (adJson.id || adJson.account_id) {
                    const actId = adJson.account_id || adJson.id;
                    adAccountResults.push({ success: true, adAccountId: actId, name: adName });
                    log('SUCCESS', `[CreateBM] 广告号 ${k + 1}/${adCount} 创建成功: ${actId}（${adName}）`);
                  } else {
                    adAccountResults.push({ success: false, error: adJson?.error?.message || '创建广告号失败' });
                    log('WARN', `[CreateBM] 广告号 ${k + 1}/${adCount} 创建失败: ${adJson?.error?.message || ''}`);
                  }
                }
                // 🆕 账单信息（国家/地址/州/邮编/公司）：创建时 Meta 收不了，登记下来稍后补写。
                //    ⚠️ 不能在这里写：此刻本路由的浏览器还没关（关在下面的 finally 里），
                //       而账单接口会为**同一个 profile** 再拉起一个浏览器 → 撞上 browser-routes 的
                //       「启动前强制关闭该 profile 残留实例」，把当前这个正在用的浏览器关掉 → detached Frame。
                //       所以先记下来，等浏览器真正关掉之后再单独串行写。
                pendingBilling = {
                  ids: adAccountResults.filter(r => r.success).map(r => r.adAccountId).filter(Boolean),
                  src: adBilling,
                };
              }
            } catch (e) {
              adAccountResults.push({ success: false, error: e.message });
              log('WARN', `[CreateBM] 广告号创建异常: ${e.message}`);
            }
          }
          // 兼容旧字段：第一个成功的广告号
          const adAccountResult = adAccountResults.find(r => r.success) || adAccountResults[0] || null;

          // 🚀 勾选了创建主页 — 继续使用当前浏览器创建
          let pageResult = null;
          if (createPage) {
            try {
              const pageName = defaultPageName || `${name}-Page`;
              log('INFO', `[CreateBM] 开始创建主页: ${pageName}`);
              const effectiveToken = actualProfile.account_tokens || actualProfile.token || '';
              const pageFormData = new URLSearchParams();
              pageFormData.append('name', pageName);
              pageFormData.append('access_token', effectiveToken);
              pageFormData.append('category_enum', 'PAGE');
              const pageResp = await fetch('https://graph.facebook.com/v19.0/me/accounts', {
                method: 'POST', body: pageFormData, credentials: 'include'
              });
              const pageJson = await pageResp.json().catch(() => ({}));
              if (pageJson.id) {
                pageResult = { success: true, pageId: pageJson.id, pageName };
                log('SUCCESS', `[CreateBM] 主页创建成功: ${pageJson.id}`);
              } else {
                pageResult = { success: false, error: pageJson?.error?.message || '创建主页失败' };
                log('WARN', `[CreateBM] 主页创建失败: ${pageResult.error}`);
              }
            } catch (e) {
              pageResult = { success: false, error: e.message };
              log('WARN', `[CreateBM] 主页创建异常: ${e.message}`);
            }
          }

          // 🆕 账单信息：必须**先关掉本路由的浏览器**，再单独串行补写，最后才响应。
          //    顺序反了就会「同 profile 双浏览器互相清理」→ detached Frame（详见 pendingBilling 处的注释）。
          //    这里主动关并清掉 shouldClose，避免 finally 再关一次。
          if (shouldClose && browser) { try { await browser.close(); } catch {} shouldClose = false; }
          let billingResult = null;
          if (pendingBilling && pendingBilling.ids.length) {
            billingResult = await writeAdAccountsBillingSerial(profileId, pendingBilling.ids, pendingBilling.src, 'CreateBM');
            pendingBilling = null;
          }

          return res.json({
            success: true, method: 'graphql', businessId: bmId, name,
            ...(adAccountResults.length ? { adAccountResults, adAccountResult } : {}),
            ...(pageResult ? { pageResult } : {}),
            ...(billingResult ? { billing: billingResult } : {})
          });
        }
        const errMsg = createResult?.errors?.[0]?.message || createResult?.error?.message || 'BM 创建失败';
        log('ERROR', `[CreateBM] GraphQL 失败: ${errMsg}`);
        return res.status(400).json({ success: false, message: errMsg });
      } finally {
        if (shouldClose && browser) try { await browser.close(); } catch {}
        // 🆕 兜底：广告号已经建出来了、但上面因异常没走到成功返回时，浏览器此时已关，把账单补上
        if (pendingBilling && pendingBilling.ids.length) {
          try { await writeAdAccountsBillingSerial(profileId, pendingBilling.ids, pendingBilling.src, 'CreateBM'); } catch {}
          pendingBilling = null;
        }
        // 🔒 归还本配置的浏览器使用权（无论成功/失败/异常都必须释放，否则同配置后续创建全部卡死）
        try { releaseGate(); } catch {}
      }
    } catch (e) { log('ERROR', `[CreateBM] 异常: ${e.message || e}`); return res.status(500).json({ success: false, message: String(e.message || e) }) }
  });

  // ============================================================
  // 🆕 个人号（系统配置 ↔ 广告号所属配置）相关
  // ============================================================

  // 从 Cookie 数组/字符串里取 c_user —— 它就是该配置自己的 FB 用户 ID。
  // 线上/本地库里存的登录 Cookie 都带 c_user，所以不用开浏览器就能拿到。
  function extractFbUserIdFromCookies(cookies) {
    if (!cookies) return '';
    let list = cookies;
    if (typeof list === 'string') {
      const m = list.match(/c_user=(\d+)/);
      if (m) return m[1];
      try { list = JSON.parse(list); } catch { return ''; }
    }
    if (!Array.isArray(list)) return '';
    const hit = list.find(c => c && c.name === 'c_user' && c.value);
    return hit ? String(hit.value).trim() : '';
  }

  // 🔎 解析某个配置自己的 FB 用户 ID（c_user）。
  // ⚠️ 只读「本地库那条配置的 Cookie」是不够的：本地库经常只有 token 没有 account_cookies，
  //    而 findProfileById 见到 token 就早退（不会再去云端补 Cookie），于是这里永远拿不到 c_user，
  //    界面上就报「Cookie 里没有 c_user（未登录或 Cookie 已被清）」——其实云端那条配置本来就有。
  //    实测 profileId=4195：本地库 account_cookies 为空、token 198 字符；云端 11 个 Cookie 含
  //    c_user=100084769099357。所以顺序是：配置里的 Cookie → 直连云端取 Cookie → 用 token 问 Graph。
  async function resolveProfileFbUserId(profileId) {
    const key = String(profileId || '').trim();
    if (!key) return { userId: '', source: '' };
    let profile = null;
    try { profile = await findProfileById(key); } catch { /* 取不到就往后走云端 */ }

    let userId = extractFbUserIdFromCookies(profile && profile.accountCookies);
    if (userId) return { userId, source: '配置 Cookie', profile };

    // ① 直连云端配置接口取登录 Cookie（绕过 findProfileById 的「有 token 就早退」）
    //    ⚠️ 必须重试：实测 00:15:35 有一次云端 10 秒超时（The operation was aborted），
    //       失败后就会往下走到「用 token 问 Graph」——那条路有副作用（见 ②），不能因为一次抖动就触发。
    const base = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
    const secret = process.env.PUPPETEER_API_SECRET || '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await fetch(`${base}/api/profiles/${encodeURIComponent(key)}`, {
          headers: { 'Accept': 'application/json', 'X-Api-Secret': secret, 'Authorization': `Bearer ${secret}` },
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
        });
        const j = await resp.json().catch(() => null);
        const d = j && (j.data || j);
        let c = d && d.account && d.account.cookies;
        if (typeof c === 'string' && c.trim()) { try { c = JSON.parse(c); } catch { c = []; } }
        userId = extractFbUserIdFromCookies(c);
        if (userId) {
          log('INFO', `🔎 [个人号] 配置 ${key} 的 FB 用户 ID 取自云端 Cookie: ${userId}`);
          return { userId, source: '云端 Cookie', profile, cloud: d };
        }
        break;   // 拿到了响应、只是确实没有 c_user → 重试也没用
      } catch (e) {
        log('WARN', `🔎 [个人号] 配置 ${key} 云端取 Cookie 失败（第 ${attempt} 次）: ${e.message}`);
        if (attempt === 2) break;
        await sleep(800);
      }
    }

    // ② 最后兜底：用 access token 问 Graph。
    //    ⚠️ 只在「这个配置的浏览器已经在跑」时才走：callFacebookGraphApi 带 190 自动刷新/自动登录钩子，
    //       token 一失效它会**直接把这个配置的浏览器拉起来重新登录**。
    //       实测 2026-09-27 00:15：用户只是在下拉框里选了一下 4195（解析它的 FB 用户 ID），
    //       token 恰好失效 → 4195 的浏览器被自动启动 + 自动登录 40 秒，看起来像「跑错配置了」。
    //       查一个 ID 不该有这种副作用；浏览器本来就在跑时这一步是纯读取，才安全。
    const token = String((profile && (profile.account_tokens || profile.token)) || '').trim();
    const liveBrowserData = _activeBrowsers && _activeBrowsers.get(key);
    const hasLiveBrowser = !!(liveBrowserData && liveBrowserData.browser && liveBrowserData.browser.isConnected && liveBrowserData.browser.isConnected());
    if (token && hasLiveBrowser) {
      try {
        const j = await callFacebookGraphApi('me?fields=id', 'GET', null, profile, token);
        if (j && !j.error && j.id) {
          log('INFO', `🔎 [个人号] 配置 ${key} 的 FB 用户 ID 取自 Graph me?id: ${j.id}`);
          return { userId: String(j.id), source: 'Graph me?id', profile };
        }
        if (j && j.error) log('WARN', `🔎 [个人号] 配置 ${key} 用 token 取用户 ID 被拒: ${j.error.message}`);
      } catch (e) {
        log('WARN', `🔎 [个人号] 配置 ${key} 用 token 取用户 ID 异常: ${e.message}`);
      }
    } else if (token) {
      log('INFO', `🔎 [个人号] 配置 ${key} 云端也没取到 c_user，且该配置浏览器未在运行 → 不用 token 兜底（避免为查一个 ID 把浏览器拉起来）`);
    }

    return { userId: '', source: '', profile };
  }

  // 🎯 「加好友 / 同意好友」走 FB 内部 GraphQL —— 参数都是从真实点击抓包得到的
  //    （2026-09-20 在 profile 4343 / 4340 上抓取；发请求那次的请求被 failRequest 掉，没有真的发出）。
  //      POST https://www.facebook.com/api/graphql/   (application/x-www-form-urlencoded)
  //      发请求: FriendingCometFriendRequestSendMutation    doc_id = 28400389149651601
  //              variables.input = { friend_requestee_ids:[<目标>], friending_channel:"PROFILE_BUTTON",
  //                                  warn_ack_for_ids:[], actor_id:"<自己>", ... }  + scale:2
  //      同意  : FriendingCometFriendRequestConfirmMutation doc_id = 27351021931180810
  //              variables.input = { friend_requester_id:"<申请人>", friending_channel:"GRIFFIN_TAB",
  //                                  warn_ack:false, actor_id:"<自己>", ... } + scale:2, refresh_num:0,
  //                                should_fix_banner:true
  //    🔑 jazoest 算法：'2' + Σ(charCode(fb_dtsg))。两次抓包分别反推验证过（25458 / 25440 均完全吻合）。
  //    ✅ 实测 __dyn / __csr / __hsdp / __hblp 等客户端能力字段可以省略，FB 照常受理。
  const FRIEND_SEND_DOC_ID = '28400389149651601';
  const FRIEND_SEND_FRIENDLY = 'FriendingCometFriendRequestSendMutation';
  const FRIEND_CONFIRM_DOC_ID = '27351021931180810';
  const FRIEND_CONFIRM_FRIENDLY = 'FriendingCometFriendRequestConfirmMutation';

  // 在页面内发出 Comet GraphQL（同源请求，Cookie 自动带上）。
  // mode: 'send'（发好友请求）| 'confirm'（同意好友请求）| 'pageAccept'（同意主页管理员邀请）
  //       | 'pageInvite'（邀请某人成为主页管理员）
  // actorOverride: 以哪个身份发（默认=当前登录用户）。主页邀请要传「主页ID」——
  //   抓包里那条请求的 av / __user / actor_id 三者都是主页 ID，不是个人号 ID。
  // 返回 { ok, stage?, response? }；response 是 FB 的原始 JSON 文本。
  function graphqlCometInPage({ mode, targetId, docId, friendly, pageId, inviteId, switchTo, searchTerm, actorOverride, additionalProfileId, actorId, targetProfileId }) {
    const req = (n) => { try { return window.require(n); } catch { return null; } };
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };

    let dtsg = '';
    const dtsgEl = document.querySelector('input[name="fb_dtsg"]');
    if (dtsgEl && dtsgEl.value) dtsg = dtsgEl.value;
    if (!dtsg) { const d = req('DTSGInitialData'); if (d && d.token) dtsg = d.token; }
    if (!dtsg) dtsg = pick(/"DTSGInitialData"[\s\S]{0,400}?"token":"([^"]+)"/);

    let lsd = '';
    const lsdEl = document.querySelector('input[name="lsd"]');
    if (lsdEl && lsdEl.value) lsd = lsdEl.value;
    if (!lsd) { const l = req('LSD'); if (l && l.token) lsd = l.token; }
    if (!lsd) lsd = pick(/"LSD",\[\],function\([^)]*\)\s*\{[^}]*?"token":"([^"]+)"/);

    let userId = '';
    const cu = req('CurrentUserInitialData');
    if (cu && cu.USER_ID) userId = String(cu.USER_ID);
    if (!userId) userId = pick(/"USER_ID":"(\d+)"/);

    if (!dtsg || !lsd || !userId) {
      return { ok: false, stage: 'extract', detail: `dtsg=${dtsg.length} lsd=${lsd ? 'y' : 'n'} user=${userId || 'n'} url=${location.href}` };
    }

    const sd = req('SiteData') || {};
    const spinR = String(sd.__spin_r || sd.__rev || '');
    const spinB = String(sd.__spin_b || 'trunk');
    const spinT = String(sd.__spin_t || Math.floor(Date.now() / 1000));

    let sum = 0;
    for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
    const jazoest = '2' + sum;

    const baseInput = {
      click_correlation_id: String(Date.now()),
      click_proof_validation_result: JSON.stringify({ validated: true }),
      actor_id: String(userId),
      client_mutation_id: '1'
    };
    const variables = mode === 'confirm'
      ? {
          input: { ...baseInput, friend_requester_id: String(targetId), friending_channel: 'GRIFFIN_TAB', warn_ack: false },
          scale: 2, refresh_num: 0, should_fix_banner: true
        }
      : mode === 'profileSwitch'
      ? {
          // 🎯 「切换身份」——抓包实证：variables 只有一个 profile_id，没有 scale。
          //    av/__user 用「切换前」的身份（effUser 默认就是这个）。
          profile_id: String(switchTo)
        }
      : mode === 'pageInviteSearch'
      ? {
          // 🎯 「邀请前先搜索这个人」——抓包实证：界面在发邀请前会先跑这条查询
          //    （search_term 传的就是那个人的主页链接）。少了它，邀请会报 field_exception 1675030。
          //      useProfilePlusAddPermissionsSearchDataSourceQuery  doc_id = 9673725249401044
          search_term: String(searchTerm || '')
        }
      : mode === 'pageInvite'
      ? {
          // 🎯 「邀请某人成为主页管理员」（新版主页 profile plus）——同上抓包得到。
          //    ⚠️ actor_id 是「主页身份」：这条邀请是以主页身份发出的。
          //    ⚠️ 2026-09-27 实测补充：新版主页的「身份」用的是**身份档案 ID**（profile plus 的 id），
          //       不是主页 ID（同一账号发请求时 av/__user 也都是身份档案 ID）。
          //       所以这里优先用调用方解析出来的身份档案 ID，取不到才退回主页 ID。
          //    ⚠️ 参数必须与抓包逐字一致：不要带 click_correlation_id / click_proof_validation_result
          //       （那是加好友接口的字段，多带会被 FB 判成 field_exception 1675030）。
          input: {
            additional_profile_id: String(additionalProfileId || pageId),
            admin_id: String(targetId),
            grant_full_control: true,
            actor_id: String(actorId || pageId),
            client_mutation_id: '2'
          },
          scale: 2
        }
      : mode === 'pageAccept'
      ? {
          // 🎯 「同意主页管理员邀请」——2026-09-21 抓包得到。
          //    ⚠️ 同样照抄抓包，不要额外带 click_* 字段（否则 field_exception）。
          //    ⚠️ user_id 是「被邀请加入的那个主页身份」→ 新版主页同样是身份档案 ID（prefer targetProfileId）。
          input: {
            actor_id: String(userId),
            client_mutation_id: '3',
            is_accept: true,
            profile_admin_invite_id: String(inviteId),
            user_id: String(targetProfileId || pageId)
          },
          scale: 2
        }
      : {
          input: { ...baseInput, friend_requestee_ids: [String(targetId)], friending_channel: 'PROFILE_BUTTON', warn_ack_for_ids: [] },
          scale: 2
        };

    const body = new URLSearchParams();
    // 以哪个身份发：默认当前登录用户；主页邀请时是主页 ID（抓包实证）
    const effUser = actorOverride ? String(actorOverride) : userId;
    body.append('av', effUser);
    body.append('__aaid', '0');
    body.append('__user', effUser);
    body.append('__a', '1');
    body.append('__req', Math.random().toString(36).slice(2, 4));
    body.append('__rev', spinR);
    body.append('__spin_r', spinR);
    body.append('__spin_b', spinB);
    body.append('__spin_t', spinT);
    body.append('__comet_req', '15');
    body.append('fb_dtsg', dtsg);
    body.append('jazoest', jazoest);
    body.append('lsd', lsd);
    body.append('fb_api_caller_class', 'RelayModern');
    body.append('fb_api_req_friendly_name', friendly);
    body.append('server_timestamps', 'true');
    body.append('variables', JSON.stringify(variables));
    body.append('doc_id', docId);

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://www.facebook.com/api/graphql/', true);
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.setRequestHeader('X-FB-Friendly-Name', friendly);
      xhr.setRequestHeader('X-FB-LSD', lsd);
      xhr.setRequestHeader('X-ASBD-ID', '359341');
      xhr.onload = () => resolve({ ok: true, response: String(xhr.responseText || ''), jazoest, userId });
      xhr.onerror = () => resolve({ ok: false, stage: 'xhr', detail: 'XHR failed' });
      xhr.send(body.toString());
    });
  }

  // 解析 FB 返回的 JSON：FB 的错误响应（AJAX 惯例）会带 `for (;;);` 前缀，
  // 直接 JSON.parse 会失败，把真实错误埋成「FB 返回非 JSON」。统一先剥前缀。
  function parseFbJson(text) {
    let s = String(text || '').trim();
    if (s.startsWith('for (;;);')) s = s.slice('for (;;);'.length);
    try { return JSON.parse(s); } catch { return null; }
  }

  // 把 GraphQL 错误压成一行：message | summary | description | code | severity。
  // 单独拎出来是因为 FB 有些错误 message 只有一句「A server error XXX occured」，
  // 真正的线索在 summary/description/code 里（比如 noncoercible_argument_value + 1675012）。
  function gqlErrorText(j, r) {
    const e0 = j && Array.isArray(j.errors) && j.errors[0];
    if (e0) return [e0.message, e0.summary, e0.description, e0.code ? `code=${e0.code}` : '', e0.severity].filter(Boolean).join(' | ');
    if (j && (j.errorSummary || j.errorDescription)) return [j.errorSummary, j.errorDescription, j.error ? `code=${j.error}` : ''].filter(Boolean).join(' | ');
    return String((r && r.response) || '').slice(0, 160);
  }

  // 解析 FB 的 GraphQL 响应，统一成 { status, message }
  function parseFriendingResponse(r, okStatus, okMessage) {
    const j = parseFbJson(r.response);
    if (!j) return { status: 'error', message: `FB 返回非 JSON: ${String(r.response).slice(0, 160)}` };
    const errs = Array.isArray(j.errors) ? j.errors : [];
    if (errs.length > 0) {
      const e = errs[0] || {};
      const detail = [e.summary, e.description_raw || e.description, e.message, e.code ? `code=${e.code}` : ''].filter(Boolean).join(' | ');
      return { status: 'error', message: detail, raw: detail };
    }
    // 有些错误走的是非 GraphQL 的形状（没有 errors 数组，而是 error/errorSummary）
    if (j.error) {
      const detail = [j.errorSummary, j.errorDescription, `code=${j.error}`].filter(Boolean).join(' | ');
      return { status: 'error', message: detail, raw: detail };
    }
    return { status: okStatus, message: okMessage };
  }

  // ============================================================
  // 🎯 「邀请某人成为主页管理员」（新版主页 profile plus）
  //    2026-09-21 在 4343 手动邀请时用 CDP 抓包得到：
  //      POST https://www.facebook.com/api/graphql/
  //      ProfilePlusCoreAppAdminInviteMutation  doc_id = 27622438327347937
  //      variables.input = { additional_profile_id:"<主页ID>", admin_id:"<被邀请人FB用户ID>",
  //                          grant_full_control:true, actor_id:"<主页ID>" }
  //    ⚠️ 为什么不用官方 Graph API：实测 POST /{page-id}/assigned_users 会被 FB 拒
  //       （Invalid parameter 100「用户不在业务范围内，请输入业务或系统用户 ID」）——
  //       那个接口只认 BM 内的 business-scoped 用户 ID，喂普通个人 FB 用户 ID 必挂。
  //       所以这条路为主，老接口只作兜底。
  // ============================================================
  const PAGE_INVITE_DOC_ID = '27622438327347937';
  const PAGE_INVITE_FRIENDLY = 'ProfilePlusCoreAppAdminInviteMutation';

  // 🎯 「切换身份」（切到某个主页 / 切回个人号）——2026-09-21 抓包得到。
  //    为什么要它：这条邀请必须以「主页身份」发出，但光在请求里把 __user 写成主页 ID 不够，
  //    FB 会返回 1357032「请刷新页面」（身份/CSRF 校验不过）。必须先用这个 mutation 真的切身份，
  //    之后的请求（av/__user）才会被 FB 认成主页。实测 fb_dtsg 切换前后不变，不用重新取。
  //      POST /api/graphql/  CometProfileSwitchMutation  doc_id = 29569331136046912
  //      variables = { profile_id: "<目标主页ID>" }   ← 只有这一个字段，没有 scale
  //    🐛 2026-09-27 抓包修正：这里的 "<目标主页ID>" 其实是「**身份档案 ID**」（profile plus 的 id），
  //       跟主页 ID 是两个号！实测主页 1253428704530178 的身份档案 ID 是 61594389617095；
  //       喂主页 ID 会被 FB 判 `noncoercible_argument_value`（code 1675012）。
  //       界面上从个人号切到主页时用的也是这个身份档案 ID（av/__user 会跟着变成它）。
  const PROFILE_SWITCH_DOC_ID = '29569331136046912';
  const PROFILE_SWITCH_FRIENDLY = 'CometProfileSwitchMutation';

  // 🎯 切身份的另一个变体：FB 界面在「个人号 → 主页」（需要清 web-storage 白名单）时用的是这条。
  //    2026-09-27 在 4132 上抓包得到，variables 与上面完全相同（只有 profile_id）。
  const PROFILE_SWITCH_ALLOWLIST_DOC_ID = '9921807754532566';
  const PROFILE_SWITCH_ALLOWLIST_FRIENDLY = 'CometProfileSwitchWithWebStorageLogoutAllowlistMutation';

  // 🔎 把「主页 ID」换成 FB 的「身份档案 ID」（切换身份/以主页身份发请求都要它）。
  //    两者之间没有可推算的关系，但 **FB 自己会做这个跳转**：
  //      打开 https://www.facebook.com/<主页ID> 会 302 到
  //      https://www.facebook.com/profile.php?id=<身份档案ID>  （2026-09-27 实测 4132 → 1253428704530178）
  //    所以用一个临时标签页去问一次；问不到就返回空，调用方退回用主页 ID。
  async function resolveProfileIdentityId(browser, pageId) {
    const pid = String(pageId || '').trim();
    if (!/^\d+$/.test(pid)) return '';
    let tmp = null;
    try {
      tmp = await browser.newPage();
      await tmp.goto(`https://www.facebook.com/${pid}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2500);
      const finalUrl = String(tmp.url() || '');
      const m = finalUrl.match(/profile\.php\?[^#]*?\bid=(\d+)/);
      if (m && m[1] !== pid) return m[1];
      // 兜底：页面数据里 `delegate_page`（主页）旁边就有 `selectedID`（身份档案 ID）
      const hit = await tmp.evaluate((pidStr) => {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        if (html.indexOf(`"delegate_page":{"id":"${pidStr}"`) < 0) return '';
        const m2 = html.match(/"selectedID":"(\d+)"/);
        return m2 ? m2[1] : '';
      }, pid).catch(() => '');
      return (hit && hit !== pid) ? String(hit) : '';
    } catch (e) {
      log('WARN', `   ↳ 主页 ${pid} 解析身份档案 ID 失败: ${String(e.message || e)}`);
      return '';
    } finally {
      if (tmp) await tmp.close().catch(() => {});
    }
  }

  // 🎯 邀请前的那次「搜索这个人」——抓包里界面在发邀请前先跑它，少了它邀请必炸。
  //      POST /api/graphql/  useProfilePlusAddPermissionsSearchDataSourceQuery  doc_id = 9673725249401044
  //      variables = { search_term: "<被邀请人的主页链接>" }
  const PAGE_INVITE_SEARCH_DOC_ID = '9673725249401044';
  const PAGE_INVITE_SEARCH_FRIENDLY = 'useProfilePlusAddPermissionsSearchDataSourceQuery';

  // ⏳ 等页面真的进入「已登录的 FB」再发 GraphQL。
  //    ⚠️ 实测 2026-09-27 00:08: 浏览器刚被 ensureBrowserIsRunning 拉起来（就绪日志只早 4ms），
  //       页面里 fb_dtsg / lsd / USER_ID 都还没渲染出来 → GraphQL 直接判
  //       `extract: dtsg=0 lsd=n user=n`，整批邀请全灭。
  //       以前只 `sleep(3500)` 就发请求，刚启动的浏览器必然踩这个坑。
  //    取参数的方式与 graphqlCometInPage 里完全一致，避免「这里说就绪、那边取不到」。
  async function waitForFbGraphqlSession(page, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const r = await page.evaluate(() => {
        const req = (n) => { try { return window.require(n); } catch { return null; } };
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };
        let dtsg = '';
        const dtsgEl = document.querySelector('input[name="fb_dtsg"]');
        if (dtsgEl && dtsgEl.value) dtsg = dtsgEl.value;
        if (!dtsg) { const d = req('DTSGInitialData'); if (d && d.token) dtsg = d.token; }
        if (!dtsg) dtsg = pick(/"DTSGInitialData"[\s\S]{0,400}?"token":"([^"]+)"/);
        let lsd = '';
        const lsdEl = document.querySelector('input[name="lsd"]');
        if (lsdEl && lsdEl.value) lsd = lsdEl.value;
        if (!lsd) { const l = req('LSD'); if (l && l.token) lsd = l.token; }
        if (!lsd) lsd = pick(/"LSD",\[\],function\([^)]*\)\s*\{[^}]*?"token":"([^"]+)"/);
        let userId = '';
        const cu = req('CurrentUserInitialData');
        if (cu && cu.USER_ID) userId = String(cu.USER_ID);
        if (!userId) userId = pick(/"USER_ID":"(\d+)"/);
        return { dtsg: dtsg.length, lsd: lsd ? 1 : 0, user: userId || '', url: location.href, ready: document.readyState };
      }).catch(() => null);
      if (r) {
        last = `dtsg=${r.dtsg} lsd=${r.lsd ? 'y' : 'n'} user=${r.user || 'n'} url=${r.url} ready=${r.ready}`;
        // ⚠️ 人机验证页 / 登录页上同样能取到 fb_dtsg / lsd / USER_ID（会误判成「已就绪」），
        //    在这种页面上发 GraphQL 一律被 FB 判 1357032「Something Went Wrong」，
        //    报出来完全看不出是没登录（实测 2026-09-27 01:13 profile 4132 停在 checkpoint）。
        //    所以：停在验证/登录页时不算就绪，继续等（自动登录完成后 URL 会自己变）。
        const onAuthWall = /\/checkpoint\/|\/login\/|\/recover\//i.test(String(r.url || ''));
        if (!onAuthWall && r.dtsg && r.lsd && r.user) return { ok: true, detail: last };
      }
      await sleep(1000);
    }
    return { ok: false, detail: last || '页面一直取不到会话参数' };
  }

  // 在「主页所属配置」的浏览器里批量发管理员邀请。同一个浏览器只取一次页面上下文。
  // 返回 [{ pageId, status:'success'|'error', message, via }]
  async function invitePageAdminsViaBrowser(profileId, pageIds, fbUserId) {
    // ⚠️ 每一条失败路径都要打日志：以前只有「主页身份发邀请」成功/失败那一行会打日志，
    //    浏览器启动失败、上下文打不开、切身份异常这些分支全是静默的，
    //    结果日志里只剩一句「内部 GraphQL 未成功 N 个」，完全看不出为什么。
    const failAll = (message) => {
      log('WARN', `🛡️ [主页邀请] 配置 ${profileId} 邀 ${fbUserId} 未发出（主页 ${(pageIds || []).join(', ')}）: ${message}`);
      return (pageIds || []).map((id) => ({ pageId: String(id), status: 'error', message, via: 'graphql' }));
    };
    const target = String(fbUserId || '').trim();
    log('INFO', `🛡️ [主页邀请] 开始: 配置 ${profileId} → 个人号 FB ${target}，主页 ${(pageIds || []).join(', ')}`);
    if (!/^\d+$/.test(target)) return failAll(`被邀请人 FB 用户 ID 不是纯数字: ${target}`);

    const browResult = await ensureBrowserIsRunning(profileId);
    if (!browResult || !browResult.success) {
      return failAll(`浏览器启动失败: ${(browResult && browResult.error) || '未知原因'}`);
    }
    const browser = browResult.browserData && browResult.browserData.browser;
    if (!browser) return failAll(`浏览器对象缺失（ensureBrowserIsRunning 返回了 success 但没有 browserData.browser）`);
    const results = [];
    let page;
    try {
      // 🐛 刚启动的浏览器自己还在导航（Cookie 预注入 / 自动登录会占用同一个标签页），
      //    这时去 goto 会撞上并发导航，puppeteer 报 `Navigating frame was detached`，
      //    整次授权直接判失败（实测 2026-09-27 01:19 profile 4118 就是这样）。
      //    这是瞬态错误，重试即可；重试前等启动流程收尾。
      for (let attempt = 1; ; attempt++) {
        try {
          const openPages = await browser.pages().catch(() => []);
          page = openPages.find(p => /facebook\.com/i.test(p.url() || '')) || await browser.newPage();
          // GraphQL 是同源请求，页面得先在 facebook.com 上（顺便拿到 fb_dtsg/lsd/SiteData）
          if (!/facebook\.com/i.test(page.url() || '')) {
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(3500);
          }
          break;
        } catch (e) {
          const transient = /detached|Target closed|Session closed|Protocol error|Unable to find page/i.test(String(e && e.message || ''));
          if (!transient || attempt >= 3) throw e;
          log('WARN', `   ↳ 主页邀请：浏览器还在导航/收尾（${String(e && e.message)}），等 4s 后重试打开上下文（第 ${attempt} 次）`);
          await sleep(4000);
        }
      }
    } catch (e) {
      return failAll(`打开浏览器上下文失败: ${String(e.message || e)}`);
    }
    // ⏳ 页面停在 facebook.com 上还不够：刚启动的浏览器这时 fb_dtsg/lsd/用户ID 常常还没渲染出来，
    //    直接发 GraphQL 会得到 `extract: dtsg=0 lsd=n user=n`。这里等到真能取到会话参数为止。
    const session = await waitForFbGraphqlSession(page, 30000);
    if (!session.ok) return failAll(`页面未就绪（未登录 / 停在 FB 人机验证页 / 页面卡住）: ${session.detail}`);
    log('INFO', `🛡️ [主页邀请] 配置 ${profileId} 页面上下文就绪: ${String(page.url() || '').slice(0, 80)}`);

    // 浏览器当前的身份：默认取页面里的登录用户，每切一次主页就更新
    let currentActor = '';
    let originalActor = '';
    for (const rawId of pageIds) {
      const pageId = String(rawId);
      try {
        // ⓪ 先把「主页 ID」换成 FB 的「身份档案 ID」：切换身份、以及以主页身份发请求，用的都是后者
        const identityId = await resolveProfileIdentityId(browser, pageId);
        const actId = identityId || pageId;
        if (identityId) log('INFO', `   ↳ 主页 ${pageId} 的身份档案 ID = ${identityId}（切换与发邀请都用这个，不是主页 ID）`);
        else log('WARN', `   ↳ 主页 ${pageId} 没解析出身份档案 ID，退回用主页 ID 试（FB 大概率判 noncoercible_argument_value）`);

        // ① 先切到「这个主页」的身份（没这一步，邀请会被 FB 判 1357032 —— 2026-09-27 已实测确认：
        //    跳过切换直接以主页身份发邀请，FB 回 error 1357032「Something Went Wrong / 请刷新页面」）
        //    FB 界面在两个方向上各用一条 doc_id（variables 相同）→ 先试主用的，不成就试 allowlist 变体。
        let sw = null;
        let switched = null;
        let switchWhy = '';
        for (const at of [
          { docId: PROFILE_SWITCH_DOC_ID, friendly: PROFILE_SWITCH_FRIENDLY, name: 'CometProfileSwitchMutation' },
          { docId: PROFILE_SWITCH_ALLOWLIST_DOC_ID, friendly: PROFILE_SWITCH_ALLOWLIST_FRIENDLY, name: 'CometProfileSwitchWithWebStorageLogoutAllowlistMutation' },
        ]) {
          const r0 = await page.evaluate(graphqlCometInPage, {
            mode: 'profileSwitch', switchTo: actId, docId: at.docId, friendly: at.friendly,
            actorOverride: currentActor || undefined
          });
          if (!r0 || !r0.ok) {
            switchWhy = `页面内取会话参数失败(${r0 && r0.stage}: ${r0 && r0.detail})`;
            log('WARN', `   ↳ 主页 ${pageId} 用 ${at.name} 切身份失败: ${switchWhy}`);
            continue;
          }
          const j0 = parseFbJson(r0.response);
          const ok0 = j0 && j0.data && j0.data.profile_switcher_comet_login;
          if (ok0) { sw = r0; switched = ok0; break; }
          switchWhy = gqlErrorText(j0, r0);
          log('WARN', `   ↳ 主页 ${pageId} 用 ${at.name} 切身份被拒: ${switchWhy}`);
        }

        // ⚠️ 不能只看 XHR 有没有回来：FB 会在响应体里报错。
        //    切不过去时**不再直接判失败**：照样往下走一遍「搜索 + 以主页身份发邀请」，
        //    这样报出来的是「切换失败 + 直接邀请也失败」两个真实原因，而不是一句推断。
        if (!switched) {
          log('WARN', `   ↳ 主页 ${pageId} 切换身份没成功，仍按主页身份直接发一次邀请试: ${switchWhy}`);
        } else {
          if (!originalActor && sw.userId) originalActor = String(sw.userId);   // 记下切换前的身份，最后切回去
          currentActor = String(switched.id || actId);
          await sleep(1500);   // 给 FB 服务端一点时间把身份状态落下去
        }

        // ② 先「搜索」一次这个人（界面在邀请前会跑这一步；少了它邀请会报 field_exception）
        //    ⚠️ 这一步的响应以前被静默吞掉。它其实是邀请的前置条件，失败必须能看到，否则
        //       后面只会得到一句 field_exception，查不出是搜索没成。
        const rSearch = await page.evaluate(graphqlCometInPage, {
          mode: 'pageInviteSearch',
          searchTerm: `https://www.facebook.com/profile.php?id=${encodeURIComponent(target)}`,
          docId: PAGE_INVITE_SEARCH_DOC_ID, friendly: PAGE_INVITE_SEARCH_FRIENDLY,
          actorOverride: actId
        });
        if (!rSearch || !rSearch.ok) {
          log('WARN', `   ↳ 主页 ${pageId} 邀请前的搜索没发出去(${rSearch && rSearch.stage}: ${rSearch && rSearch.detail})`);
        } else {
          const jSearch = parseFbJson(rSearch.response);
          const okSearch = !(jSearch && (jSearch.errors || jSearch.error));
          log(okSearch ? 'INFO' : 'WARN',
            `   ↳ 主页 ${pageId} 邀请前搜索: ${okSearch ? '成功' : '失败'} — ${String(rSearch.response || '').slice(0, 240)}`);
        }
        await sleep(1000);

        // ③ 以主页身份发邀请。actor_id / av / __user 用身份档案 ID；
        //    additional_profile_id 抓包里记的是主页 ID、但新版主页实际是身份档案 ID，两种都试。
        let inviteOk = false;
        let inviteRespRaw = '';
        const inviteErrors = [];
        for (const additionalId of [actId, pageId]) {
          const r = await page.evaluate(graphqlCometInPage, {
            mode: 'pageInvite', pageId, targetId: target, docId: PAGE_INVITE_DOC_ID, friendly: PAGE_INVITE_FRIENDLY,
            actorOverride: actId, additionalProfileId: additionalId, actorId: actId
          });
          if (!r || !r.ok) {
            inviteErrors.push(`additional_profile_id=${additionalId}: 页面内取会话参数失败(${r && r.stage}: ${r && r.detail})`);
            continue;
          }
          inviteRespRaw = String(r.response || '');
          const parsedOne = parseFriendingResponse(r, 'success', '邀请已发送');
          if (parsedOne.status === 'success') {
            inviteOk = true;
            log('INFO', `   ↳ 主页 ${pageId} 邀请已发出（actor=${actId}, additional_profile_id=${additionalId}）`);
            break;
          }
          inviteErrors.push(`additional_profile_id=${additionalId}: ${parsedOne.message}`);
          log('WARN', `   ↳ 主页 ${pageId} 邀请被拒(additional_profile_id=${additionalId}, actor=${actId}): ${parsedOne.message}`);
        }
        const inviteMsg = inviteOk ? '邀请已发送' : inviteErrors.join('；');
        // 切身份没成、但直接以主页身份发邀请成了 → 说明这条邀请其实不依赖切换，得记下来（别让它看起来像失败）
        if (inviteOk && switchWhy) {
          log('INFO', `   ↳ 主页 ${pageId} 切身份虽被拒，但直接以主页身份发邀请成功 → 这条邀请不依赖身份切换`);
        }
        const finalMsg = (inviteOk || !switchWhy) ? inviteMsg : `切主页身份未成功（${switchWhy}）；直接邀请也未成功: ${inviteMsg}`;
        results.push({ pageId, status: inviteOk ? 'success' : 'error', message: finalMsg, via: 'graphql' });
        // 每个主页一条结果日志：执行身份是「切过去的这个主页」，授权对象是 target
        // ⚠️ 级别只用 INFO/WARN（logLevels 里没有 SUCCESS，传 SUCCESS 会被静默吞掉）
        log(inviteOk ? 'INFO' : 'WARN',
          `   ↳ 主页 ${pageId}（主页身份）邀请个人号 FB ${target}: ${inviteOk ? '已发出' : '失败'} — ${finalMsg}`);
        if (!inviteOk) {
          log('WARN', `   ↳ 主页 ${pageId} 邀请被拒，FB 原始响应片段: ${String(inviteRespRaw).slice(0, 300)}`);
        }
      } catch (e) {
        results.push({ pageId, status: 'error', message: String(e.message || e), via: 'graphql' });
        log('WARN', `   ↳ 主页 ${pageId} 邀请异常: ${String(e.message || e)}`);
      }
    }

    // ③ 切回原来的身份，别把浏览器留在「主页身份」上（后续其它操作会跟着以主页身份发请求）
    if (originalActor && currentActor && currentActor !== originalActor) {
      try {
        await page.evaluate(graphqlCometInPage, {
          mode: 'profileSwitch', switchTo: originalActor, docId: PROFILE_SWITCH_DOC_ID, friendly: PROFILE_SWITCH_FRIENDLY,
          actorOverride: currentActor
        });
      } catch { /* 切不回去不影响本次结果 */ }
    }
    return results;
  }

  // 界面点击兜底：按按钮文案识别「加好友 / 已请求 / 已是好友」。
  // ⚠️ 必须用**包含**匹配而不是全等：实测韩语界面下按钮 aria-label 是「친구 조아라님 추가」，
  //    并不是干净的「친구 추가」，用全等匹配会永远找不到按钮。
  // ⚠️ 只认 [role=button]：直接用 aria-label="Friends" 全局扫会把左侧导航栏的「好友」入口
  //    误判成「已经是好友」，所以要额外要求页面上同时存在 Message 按钮。
  const FRIEND_LABELS = {
    ADD: [/add friend/i, /加好友|加为好友/, /친구.*추가|추가.*친구/, /友達(になる|に追加)|友達追加/,
          /agregar a amigos|añadir a amigos/i, /thêm bạn bè|kết bạn/i, /aggiungi amico/i,
          /freund.*hinzufügen/i, /добавить в друзья/i, /adicionar amigo/i],
    PENDING: [/cancel request/i, /取消请求|收回好友请求/, /요청\s*취소/, /リクエストを取り消す/,
              /cancelar solicitud/i, /hủy lời mời/i, /annulla richiesta/i, /anfrage.*abbrechen/i,
              /отменить запрос/i, /إلغاء الطلب/, /ยกเลิกคำขอ/, /cancelar pedido/i],
    FRIENDS: [/^friends$/i, /^朋友$/, /^친구$/, /^友達$/, /^amigos$/i, /^bạn bè$/i, /^amici$/i, /^freunde$/i],
    MESSAGE: [/^message$/i, /^发消息$/, /^메시지 보내기$/, /^メッセージ$/, /^enviar mensaje$/i, /^nhắn tin$/i],
    CONFIRM: [/^confirm$/i, /^确定$|^确认$/, /^확인$/, /^ok$/i, /^aceptar$/i, /^đồng ý$/i, /^send request$/i, /^发送请求$/]
  };

  function friendProbeInPage(labels) {
    const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const test = (s, arr) => { const x = norm(s); return !!x && arr.some(re => re.test(x)); };
    const nodes = Array.from(document.querySelectorAll('[role="button"]'));
    const list = nodes.map(el => ({ el, aria: norm(el.getAttribute('aria-label')), txt: norm(el.textContent) }))
      .filter(x => (x.aria || x.txt) && x.txt.length < 80);
    const find = (arr) => list.find(x => test(x.aria, arr) || test(x.txt, arr));
    let hit = find(labels.ADD);
    if (hit) { hit.el.setAttribute('data-omnifriend', '1'); return { state: 'add', label: hit.aria || hit.txt }; }
    hit = find(labels.PENDING);
    if (hit) return { state: 'pending', label: hit.aria || hit.txt };
    const hasMessage = !!list.find(x => test(x.aria, labels.MESSAGE) || test(x.txt, labels.MESSAGE));
    hit = find(labels.FRIENDS);
    if (hit && hasMessage) return { state: 'friends', label: hit.aria || hit.txt };
    return { state: 'unknown', label: '', snippet: norm(document.body ? document.body.innerText : '').slice(0, 200) };
  }

  // 界面点击兜底（GraphQL 的 doc_id 过期时用）
  async function sendFriendRequestByClicking(page, targetFbUserId) {
    await page.goto(`https://www.facebook.com/profile.php?id=${encodeURIComponent(targetFbUserId)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    let probe = await page.evaluate(friendProbeInPage, FRIEND_LABELS);
    if (probe.state === 'friends') return { status: 'already_friends', message: '已经是好友' };
    if (probe.state === 'pending') return { status: 'pending', message: '好友请求此前已发送，等待对方确认' };
    if (probe.state !== 'add') return { status: 'not_found', message: `没找到「加好友」按钮。页面片段: ${(probe.snippet || '').slice(0, 120)}` };
    try { await page.click('[data-omnifriend="1"]'); } catch { await page.evaluate(() => { const el = document.querySelector('[data-omnifriend="1"]'); if (el) el.click(); }); }
    await sleep(3000);
    try {
      const tagged = await page.evaluate((labels) => {
        const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const dlg = document.querySelector('div[role="dialog"]');
        if (!dlg) return false;
        const btns = Array.from(dlg.querySelectorAll('[role="button"], button'));
        const ok = btns.find(b => labels.CONFIRM.some(re => re.test(norm(b.getAttribute && b.getAttribute('aria-label'))) || re.test(norm(b.textContent))));
        if (ok) { ok.setAttribute('data-omniconfirm', '1'); return true; }
        return false;
      }, FRIEND_LABELS);
      if (tagged) { await page.click('[data-omniconfirm="1"]').catch(() => {}); await sleep(2500); }
    } catch {}
    probe = await page.evaluate(friendProbeInPage, FRIEND_LABELS).catch(() => ({ state: 'unknown' }));
    if (probe.state === 'pending' || probe.state === 'friends') return { status: 'sent', message: '好友请求已发送（界面点击）' };
    return { status: 'not_found', message: `点了「加好友」但按钮状态没变。当前按钮: ${probe.label || '未知'}` };
  }

  /**
   * 用 fromProfileId 的浏览器，向 targetFbUserId 发好友请求。
   * 首选「内部 GraphQL mutation」（抓包得到的真实调用，不依赖页面渲染/语言/选择器）；
   * doc_id 过期等情况下自动回退到界面点击。
   * 返回 { status: 'sent'|'already_friends'|'pending'|'not_found'|'error', message, via }
   */
  async function sendFriendRequestViaBrowser(fromProfileId, targetFbUserId) {
    const target = String(targetFbUserId || '').trim();
    if (!/^\d+$/.test(target)) return { status: 'error', message: `目标 FB 用户 ID 不是纯数字: ${target}` };
    const browResult = await ensureBrowserIsRunning(fromProfileId);
    if (!browResult || !browResult.success) {
      return { status: 'error', message: `浏览器启动失败: ${(browResult && browResult.error) || '未知原因'}` };
    }
    const browser = browResult.browserData.browser;
    try {
      const pages = await browser.pages().catch(() => []);
      const page = pages.find(p => /facebook\.com/i.test(p.url() || '')) || await browser.newPage();
      // GraphQL 是同源请求，页面得先在 facebook.com 上（顺便拿到 fb_dtsg/lsd/SiteData）
      if (!/facebook\.com/i.test(page.url() || '')) {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3500);
      }

      const r = await page.evaluate(graphqlCometInPage, { mode: 'send', targetId: target, docId: FRIEND_SEND_DOC_ID, friendly: FRIEND_SEND_FRIENDLY });
      if (!r || !r.ok) {
        log('WARN', `👥 [加好友] 页面内取会话参数失败(${r && r.stage}: ${r && r.detail})，回退界面点击`);
        return { ...(await sendFriendRequestByClicking(page, target)), via: 'click' };
      }

      const parsed = parseFriendingResponse(r, 'sent', '好友请求已发送');
      if (parsed.status === 'error') {
        // doc_id 失效 → 回退界面点击（FB 改版会换 doc_id，这是唯一需要重新抓包的地方）
        if (/doc_id|unknown|not\s*found|query.*not|invalid.*(doc|query)/i.test(parsed.message || '')) {
          log('WARN', `👥 [加好友] GraphQL doc_id 可能已过期(${parsed.message})，回退界面点击`);
          return { ...(await sendFriendRequestByClicking(page, target)), via: 'click' };
        }
        return { ...parsed, via: 'graphql' };
      }
      const sent = true;
      if (sent) return { status: 'sent', message: '好友请求已发送', via: 'graphql' };
      return { status: 'error', message: `FB 未返回结果: ${String(r.response).slice(0, 160)}`, via: 'graphql' };
    } catch (e) {
      return { status: 'error', message: String(e.message || e), via: 'graphql' };
    }
  }

  /**
   * 用 profileId 的浏览器，同意 requesterFbUserId 发来的好友请求（双向好友关系就此成立）。
   * 走抓包得到的 FriendingCometFriendRequestConfirmMutation，不依赖页面渲染/语言/选择器。
   * 返回 { status: 'accepted'|'already_friends'|'error'|'not_found', message, via }
   */
  async function acceptFriendRequestViaBrowser(profileId, requesterFbUserId) {
    const requester = String(requesterFbUserId || '').trim();
    if (!/^\d+$/.test(requester)) return { status: 'error', message: `申请人 FB 用户 ID 不是纯数字: ${requester}` };
    const browResult = await ensureBrowserIsRunning(profileId);
    if (!browResult || !browResult.success) {
      return { status: 'error', message: `浏览器启动失败: ${(browResult && browResult.error) || '未知原因'}` };
    }
    const browser = browResult.browserData.browser;
    try {
      const pages = await browser.pages().catch(() => []);
      const page = pages.find(p => /facebook\.com/i.test(p.url() || '')) || await browser.newPage();
      if (!/facebook\.com/i.test(page.url() || '')) {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3500);
      }
      const r = await page.evaluate(graphqlCometInPage, { mode: 'confirm', targetId: requester, docId: FRIEND_CONFIRM_DOC_ID, friendly: FRIEND_CONFIRM_FRIENDLY });
      if (!r || !r.ok) {
        return { status: 'error', message: `页面内取会话参数失败(${r && r.stage}: ${r && r.detail})`, via: 'graphql' };
      }
      return { ...parseFriendingResponse(r, 'accepted', '已同意好友请求'), via: 'graphql' };
    } catch (e) {
      return { status: 'error', message: String(e.message || e), via: 'graphql' };
    }
  }

  // -------------------------------------------------------
  // 🆕 单独同意好友请求（调试/单测用）
  // POST /api/facebook/friends/accept   Body: { profileId, requesterFbUserId | requesterProfileId }
  // -------------------------------------------------------
  _app.post('/api/facebook/friends/accept', async (req, res) => {
    try {
      const { profileId, requesterFbUserId, requesterProfileId } = req.body || {};
      if (!profileId) return res.status(400).json({ success: false, message: '缺少 profileId' });
      let requester = String(requesterFbUserId || '').trim();
      if (!requester && requesterProfileId) {
        requester = (await resolveProfileFbUserId(requesterProfileId)).userId;
      }
      if (!requester) return res.status(400).json({ success: false, message: '缺少 requesterFbUserId（或 requesterProfileId 解析不出 c_user）' });
      log('INFO', `👥 [同意好友] 配置 ${profileId} 同意 FB ${requester} 的请求`);
      const r = await acceptFriendRequestViaBrowser(profileId, requester);
      return res.json({ success: r.status === 'accepted', ...r, profileId: String(profileId), requesterFbUserId: requester });
    } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
  });

  // ============================================================
  // 🎯 主页管理员邀请 —— 自动「同意」（受邀方配置执行）
  //    2026-09-21 在 4343 邀请 / 4347 手动同意时用 CDP 抓包得到：
  //      POST https://www.facebook.com/api/graphql/
  //      ProfilePlusCometAcceptOrDeclineAdminInviteMutation  doc_id = 28351761954513079
  //      variables.input = { actor_id:"<自己FB用户ID>", is_accept:true,
  //                          profile_admin_invite_id:"<邀请ID>", user_id:"<主页ID>" }
  //    ⚠️ profile_admin_invite_id 构造不出来（每条邀请一个），只能从「这个主页的邀请页」上读，
  //       所以流程是「先打开邀请页取 ID → 再发 mutation」，而不是凭空拼参数。
  // ============================================================
  const PAGE_ACCEPT_DOC_ID = '28351761954513079';
  const PAGE_ACCEPT_FRIENDLY = 'ProfilePlusCometAcceptOrDeclineAdminInviteMutation';

  // 页面内取「本主页的待处理管理员邀请 ID」（服务端渲染的数据里带下来）
  function extractPageAdminInviteIdInPage() {
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const m = html.match(/"profile_admin_invite_id":"(\d+)"/);
    return m ? m[1] : '';
  }

  async function acceptPageAdminInviteViaBrowser(profileId, pageId) {
    const pid = String(profileId || '').trim();
    const page = String(pageId || '').trim();
    if (!pid) return { status: 'error', message: '缺少 profileId' };
    if (!/^\d+$/.test(page)) return { status: 'error', message: `主页 ID 不是纯数字: ${page}` };

    const browResult = await ensureBrowserIsRunning(pid);
    if (!browResult || !browResult.success) {
      return { status: 'error', message: `浏览器启动失败: ${(browResult && browResult.error) || '未知原因'}` };
    }
    const browser = browResult.browserData.browser;
    try {
      const pages = await browser.pages().catch(() => []);
      const pageObj = pages.find(p => /facebook\.com/i.test(p.url() || '')) || await browser.newPage();

      // 打开这个主页的「管理员邀请」页（就是通知点进来的那个地址）
      await pageObj.goto(
        `https://www.facebook.com/profile.php?id=${encodeURIComponent(page)}&notif_t=profile_plus_admin_invite`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      ).catch(() => { });
      await sleep(4000);

      let inviteId = await pageObj.evaluate(extractPageAdminInviteIdInPage).catch(() => '');
      if (!inviteId) {
        // 邀请可能刚发出还没同步到对方，页面也没渲染完 —— 再等一轮
        await sleep(4000);
        inviteId = await pageObj.evaluate(extractPageAdminInviteIdInPage).catch(() => '');
      }
      if (!inviteId) {
        return { status: 'not_found', message: `在主页 ${page} 的邀请页上没找到 profile_admin_invite_id（邀请可能还没到对方、或已经同意过了）`, via: 'graphql' };
      }

      // ⚠️ user_id 是「被邀请加入的那个主页身份」→ 新版主页用身份档案 ID。
      //    好在这里不用额外开标签页去问：上面 goto 的 profile.php?id=<主页ID> 会被 FB 自动
      //    归一化到 profile.php?id=<身份档案ID>（2026-09-27 实测），直接读当前 URL 就是答案。
      const m = String(pageObj.url() || '').match(/profile\.php\?[^#]*?\bid=(\d+)/);
      const identityId = (m && m[1] !== page) ? m[1] : '';
      if (identityId) log('INFO', `   ↳ 主页 ${page} 的身份档案 ID = ${identityId}（同意邀请用它）`);

      let last = null;
      for (const uid of (identityId ? [identityId, page] : [page])) {
        const r = await pageObj.evaluate(graphqlCometInPage, {
          mode: 'pageAccept', pageId: page, inviteId, targetProfileId: uid,
          docId: PAGE_ACCEPT_DOC_ID, friendly: PAGE_ACCEPT_FRIENDLY
        });
        if (!r || !r.ok) {
          last = { status: 'error', message: `页面内取会话参数失败(${r && r.stage}: ${r && r.detail})`, via: 'graphql' };
          continue;
        }
        const parsed = parseFriendingResponse(r, 'accepted', '已同意主页管理员邀请');
        last = { ...parsed, via: 'graphql', inviteId };
        if (parsed.status === 'accepted') break;
        log('WARN', `   ↳ 同意主页 ${page} 邀请失败(user_id=${uid}): ${parsed.message}`);
      }
      return last;
    } catch (e) {
      return { status: 'error', message: String(e.message || e), via: 'graphql' };
    }
  }

  // -------------------------------------------------------
  // 🎯 同意主页管理员邀请（批量）
  // POST /api/facebook/pages/accept-admin-invite
  // Body: { profileId, pageIds }
  // -------------------------------------------------------
  _app.post('/api/facebook/pages/accept-admin-invite', async (req, res) => {
    try {
      const { profileId, pageIds } = req.body || {};
      if (!profileId || !Array.isArray(pageIds) || pageIds.length === 0) {
        return res.status(400).json({ success: false, message: '缺少必要参数: profileId, pageIds' });
      }
      log('INFO', `🎯 [accept-admin-invite] 配置 ${profileId} 同意 ${pageIds.length} 个主页的管理员邀请`);
      const results = [];
      for (const rawId of pageIds) {
        const pageId = String(rawId);
        try {
          const r = await acceptPageAdminInviteViaBrowser(profileId, pageId);
          results.push({ pageId, status: r.status, message: r.message });
        } catch (e) {
          results.push({ pageId, status: 'error', message: String(e.message || e) });
        }
      }
      const okCount = results.filter(r => r.status === 'accepted').length;
      return res.json({
        success: okCount > 0,
        message: `同意主页邀请完成: ${okCount}/${pageIds.length} 成功`,
        results,
      });
    } catch (err) {
      log('ERROR', `[accept-admin-invite] 异常: ${err.message}`);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // -------------------------------------------------------
  // 🛡️ 某个配置「真正能管理的主页」清单（带角色）
  // POST /api/facebook/pages/manageable   Body: { profileId, refresh }
  // -------------------------------------------------------
  // ⚠️ 为什么需要它：应用里的「主页列表」来源是广告账户的 promotable_pages / BM 的 owned_pages，
  //    意思是「这个广告账户能给哪些主页投广告」，**不等于**「这个配置的账号是这些主页的管理员」。
  //    授权/切身份时 FB 只认后者，所以要用 me/accounts（角色维度）来判定能不能管理。
  // ⚠️ me/accounts 比较慢（实测每轮 20~30s），因此加 10 分钟内存缓存，避免列表反复刷。
  const _manageablePagesCache = new Map();   // profileId -> { at, pages }
  const MANAGEABLE_CACHE_MS = 10 * 60 * 1000;

  _app.post('/api/facebook/pages/manageable', async (req, res) => {
    try {
      const { profileId, refresh } = req.body || {};
      if (!profileId) return res.status(400).json({ success: false, message: '缺少 profileId' });
      const key = String(profileId);

      const hit = _manageablePagesCache.get(key);
      if (!refresh && hit && Date.now() - hit.at < MANAGEABLE_CACHE_MS) {
        return res.json({ success: true, profileId: key, cached: true, fetchedAt: hit.at, count: hit.pages.length, pages: hit.pages });
      }

      const profile = await findProfileById(profileId);
      const effectiveToken = profile?.account_tokens || profile?.token || '';
      if (!effectiveToken) return res.status(400).json({ success: false, message: '缺少 Access Token' });

      const json = await callFacebookGraphApi('me/accounts?fields=id,name,tasks&limit=500', 'GET', null, profile, effectiveToken);
      if (!json || json.error) {
        const msg = json?.error?.message || 'me/accounts 调用失败';
        log('WARN', `🛡️ [pages/manageable] 配置 ${key} 取可管理主页失败: ${msg}`);
        return res.status(500).json({ success: false, message: msg });
      }

      const pages = (Array.isArray(json.data) ? json.data : []).map(p => {
        const tasks = Array.isArray(p.tasks) ? p.tasks : [];
        return {
          id: String(p.id || ''),
          name: String(p.name || ''),
          tasks,
          // ⚠️ 新版主页的权限字段名是 PROFILE_PLUS_*（不是老的 MANAGE）：
          //    实测管理员拿到的是 PROFILE_PLUS_FULL_CONTROL + PROFILE_PLUS_MANAGE。
          //    旧的 MANAGE 也一并认，兼容老式主页。
          canManage: tasks.includes('PROFILE_PLUS_FULL_CONTROL')
            || tasks.includes('PROFILE_PLUS_MANAGE')
            || tasks.includes('MANAGE'),
        };
      }).filter(p => p.id);

      _manageablePagesCache.set(key, { at: Date.now(), pages });
      log('INFO', `🛡️ [pages/manageable] 配置 ${key} 可管理主页 ${pages.length} 个（其中管理员 ${pages.filter(p => p.canManage).length} 个）`);
      return res.json({ success: true, profileId: key, cached: false, fetchedAt: Date.now(), count: pages.length, pages });
    } catch (e) {
      log('ERROR', `[pages/manageable] 异常: ${e.message}`);
      return res.status(500).json({ success: false, message: String(e.message || e) });
    }
  });

  // -------------------------------------------------------
  // 🔎 解析某个配置自己的 FB 用户 ID（读它的登录 Cookie 里的 c_user，不用开浏览器）
  // POST /api/facebook/profile-fb-id   Body: { profileId }
  // -------------------------------------------------------
  _app.post('/api/facebook/profile-fb-id', async (req, res) => {
    try {
      const { profileId } = req.body || {};
      if (!profileId) return res.status(400).json({ success: false, message: '缺少 profileId' });
      const profile = await findProfileById(profileId);
      if (!profile) return res.status(404).json({ success: false, message: `未找到配置 ${profileId}` });
      const r = await resolveProfileFbUserId(profileId);
      if (!r.userId) {
        return res.status(400).json({ success: false, message: `配置 ${profileId} 解析不出 FB 用户 ID：配置 Cookie、云端 Cookie、以及用 token 调 Graph me?id 都没拿到（可先启动一次浏览器登录该配置，或改用手填 FB 用户 ID）` });
      }
      log('INFO', `🔎 [个人号] 配置 ${profileId} 自己的 FB 用户 ID = ${r.userId}（来源: ${r.source}）`);
      return res.json({ success: true, profileId: String(profileId), userId: r.userId, source: r.source, name: profile.name || '' });
    } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
  });

  // -------------------------------------------------------
  // 🆕 单独发好友请求（调试/单测用）
  // POST /api/facebook/friends/request   Body: { profileId, targetFbUserId | targetProfileId }
  // -------------------------------------------------------
  _app.post('/api/facebook/friends/request', async (req, res) => {
    try {
      const { profileId, targetFbUserId, targetProfileId } = req.body || {};
      if (!profileId) return res.status(400).json({ success: false, message: '缺少 profileId' });
      let target = String(targetFbUserId || '').trim();
      if (!target && targetProfileId) {
        target = (await resolveProfileFbUserId(targetProfileId)).userId;
      }
      if (!target) return res.status(400).json({ success: false, message: '缺少 targetFbUserId（或 targetProfileId 解析不出 c_user）' });
      log('INFO', `👥 [加好友] 配置 ${profileId} → FB ${target}`);
      const r = await sendFriendRequestViaBrowser(profileId, target);
      return res.json({ success: r.status === 'sent' || r.status === 'already_friends' || r.status === 'pending', ...r, profileId: String(profileId), targetFbUserId: target });
    } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
  });

  // -------------------------------------------------------
  // 🆕 授权到个人号（完整版）：选中系统的配置当个人号 + 可选双向加好友 + 授权管理员
  // POST /api/facebook/adaccounts/assign-personal-full
  // Body: { ownerProfileId, personalProfileId, adAccountIds[], addFriend: bool, accessToken? }
  //   1) 从 personalProfileId 的 Cookie 解析出它的 FB 用户 ID（c_user），不再要人手填
  //   2) addFriend=true 时：个人号 → 广告号所属配置、广告号所属配置 → 个人号，各发一次好友请求
  //   3) 用广告号所属配置的 token 调 act_{id}/userpermissions 授权（沿用原 assign-personal 的逻辑）
  // -------------------------------------------------------
  _app.post('/api/facebook/adaccounts/assign-personal-full', async (req, res) => {
    try {
      const { ownerProfileId, personalProfileId, adAccountIds, addFriend, accessToken, businessId, role } = req.body || {};
      if (!ownerProfileId || !personalProfileId) {
        return res.status(400).json({ success: false, message: '缺少必要参数: ownerProfileId, personalProfileId' });
      }
      if (!Array.isArray(adAccountIds) || adAccountIds.length === 0) {
        return res.status(400).json({ success: false, message: '没有可授权的广告号' });
      }
      if (String(ownerProfileId) === String(personalProfileId)) {
        return res.status(400).json({ success: false, message: '个人号不能和广告号所属配置是同一个配置' });
      }

      const ownerProfile = await findProfileById(ownerProfileId);
      const personalProfile = await findProfileById(personalProfileId);
      if (!personalProfile) return res.status(404).json({ success: false, message: `未找到配置 ${personalProfileId}` });

      const personalResolved = await resolveProfileFbUserId(personalProfileId);
      const personalFbUserId = personalResolved.userId;
      if (!personalFbUserId) {
        return res.status(400).json({ success: false, message: `配置 ${personalProfileId} 解析不出 FB 用户 ID：配置 Cookie、云端 Cookie、以及用 token 调 Graph me?id 都没拿到（可先启动一次浏览器登录该配置，或改用手填 FB 用户 ID）` });
      }
      const ownerFbUserId = (await resolveProfileFbUserId(ownerProfileId)).userId;

      const effectiveToken = accessToken || (ownerProfile && (ownerProfile.account_tokens || ownerProfile.token)) || '';
      if (!effectiveToken) return res.status(400).json({ success: false, message: `配置 ${ownerProfileId} 缺少 Access Token` });

      const friendResults = [];
      const warnings = [];
      if (addFriend) {
        if (!ownerFbUserId) {
          warnings.push(`配置 ${ownerProfileId} 的 Cookie 里没有 c_user，无法完成加好友（缺广告号所属配置自己的 FB 用户 ID）`);
        } else {
          // ① 个人号 → 广告号所属配置：发好友请求
          log('INFO', `👥 [加好友] ${personalProfileId} → ${ownerFbUserId} 发请求`);
          const r1 = await sendFriendRequestViaBrowser(personalProfileId, ownerFbUserId);
          friendResults.push({ from: String(personalProfileId), to: ownerFbUserId, direction: '个人号 发请求 → 广告号所属配置', ...r1 });

          // ② 广告号所属配置：同意这条请求。好友关系本身就是双向的，
          //    所以「A 发请求 + B 点同意」就等于双方互为好友，不需要再反向发一次
          //    （反向再发一次反而会在已经是好友之后报错，变成噪音）。
          log('INFO', `👥 [加好友] ${ownerProfileId} 同意 ${personalFbUserId} 的请求`);
          const r2 = await acceptFriendRequestViaBrowser(ownerProfileId, personalFbUserId);
          friendResults.push({ from: String(ownerProfileId), to: personalFbUserId, direction: '广告号所属配置 同意请求（双向好友成立）', ...r2 });
        }
      }

      // 授权：把广告号授权给解析出来的个人号 FB 用户 ID（用 ownerProfile 的 token）。
      // 🎯 档位（role）由前端选，默认管理员；走抓包还原的 Ads Manager 内部 users 接口。
      const results = [];
      for (const rawId of adAccountIds) {
        const actId = String(rawId).replace(/^act_/, '');
        try {
          const r = await grantAdAccountToUser(actId, personalFbUserId, ownerProfile, effectiveToken, role || 'ADMIN');
          results.push({ adAccountId: actId, status: r.ok ? 'success' : 'error', message: r.message });
        } catch (e) {
          results.push({ adAccountId: actId, status: 'error', message: String(e.message || e) });
        }
      }

      const okCount = results.filter(r => r.status === 'success').length;
      log('INFO', `📌 [assign-personal-full] 配置 ${personalProfileId}(FB ${personalFbUserId}) ← 广告号所属配置 ${ownerProfileId}: 授权 ${okCount}/${adAccountIds.length}`);
      return res.json({
        success: okCount > 0,
        message: `授权完成: ${okCount}/${adAccountIds.length} 成功`,
        personalProfileId: String(personalProfileId),
        personalFbUserId,
        ownerProfileId: String(ownerProfileId),
        friendResults,
        results,
        warnings
      });
    } catch (err) {
      log('ERROR', `[assign-personal-full] 异常: ${err.message}`);
      return res.status(500).json({ success: false, message: String(err.message || err) });
    }
  });

  // ============================================================
  // 🆕 贴文评论操作：隐藏 / 取消隐藏 / 删除 / 回复 / 私密回复（私聊）
  //    ⚠️ 这四类操作官方都要求用**主页访问口令**，口令在「获取信息」时已落到本地
  //       SQLite 的 page_tokens 表；若没有则明确提示重跑「获取信息」。
  // ============================================================
  const _readPageToken = (profileId, pageId) => new Promise((resolve) => {
    if (!_dbPath) return resolve('');
    let d;
    try { d = new (require('sqlite3').Database)(_dbPath); } catch { return resolve(''); }
    d.get(`SELECT access_token FROM page_tokens WHERE profile_id = ? AND page_id = ?`,
      [String(profileId), String(pageId)], (err, row) => {
        try { d.close(); } catch { }
        resolve(err || !row ? '' : String(row.access_token || ''));
      });
  });

  // 评论 ID 形如 {page-id}_{post-id}_{comment-id} → 第一段就是主页 ID
  const _pageIdOfComment = (commentId) => {
    const s = String(commentId || '');
    const i = s.indexOf('_');
    return i > 0 ? s.slice(0, i) : '';
  };

  // 前置校验失败属于「请求问题」，用 400 而不是 500，把原因直接回给前端
  const _badRequest = (msg) => { const e = new Error(msg); e.status = 400; return e; };

  const _resolveCommentCtx = async (profileId, commentId) => {
    const pageId = _pageIdOfComment(commentId);
    if (!pageId) throw _badRequest('评论 ID 格式异常，无法解析出主页 ID（预期 {page-id}_{post-id}_{comment-id}）');
    const token = await _readPageToken(profileId, pageId);
    if (!token) throw _badRequest(`本地没有主页 ${pageId} 的访问口令，请先对该配置重新执行一次「获取信息」`);
    const profile = await findProfileById(profileId);
    if (!profile || !profile.id) throw _badRequest(`找不到配置 ${profileId}`);
    return { pageId, token, profile };
  };

  const _fbErrOf = (r) => (r && r.error) ? (r.error.error_user_msg || r.error.message || '未知错误') : '';

  // 隐藏 / 取消隐藏评论（可在 FB 端恢复）
  _app.post('/api/facebook/comment/hide', async (req, res) => {
    try {
      const { profileId, commentId, hidden } = req.body || {};
      if (!profileId || !commentId) return res.status(400).json({ success: false, message: '缺少 profileId / commentId' });
      const want = hidden !== false;
      const { token, profile } = await _resolveCommentCtx(profileId, commentId);
      const body = new URLSearchParams();
      body.append('is_hidden', want ? 'true' : 'false');
      body.append('access_token', token);
      const r = await callFacebookGraphApi(String(commentId), 'POST', body, profile, token);
      const err = _fbErrOf(r);
      if (err) return res.status(400).json({ success: false, message: err });
      log('SUCCESS', `💬 [评论] ${want ? '隐藏' : '取消隐藏'}成功 comment=${commentId}`);
      return res.json({ success: true, is_hidden: want });
    } catch (e) {
      log('ERROR', `[评论/隐藏] 异常: ${e.message}`);
      return res.status(e.status || 500).json({ success: false, message: String(e.message || e) });
    }
  });

  // 删除评论（不可恢复）
  _app.post('/api/facebook/comment/delete', async (req, res) => {
    try {
      const { profileId, commentId } = req.body || {};
      if (!profileId || !commentId) return res.status(400).json({ success: false, message: '缺少 profileId / commentId' });
      const { token, profile } = await _resolveCommentCtx(profileId, commentId);
      const r = await callFacebookGraphApi(String(commentId), 'DELETE', null, profile, token);
      const err = _fbErrOf(r);
      if (err) return res.status(400).json({ success: false, message: err });
      log('SUCCESS', `💬 [评论] 删除成功 comment=${commentId}`);
      return res.json({ success: true });
    } catch (e) {
      log('ERROR', `[评论/删除] 异常: ${e.message}`);
      return res.status(e.status || 500).json({ success: false, message: String(e.message || e) });
    }
  });

  // 公开回复评论
  _app.post('/api/facebook/comment/reply', async (req, res) => {
    try {
      const { profileId, commentId, message } = req.body || {};
      if (!profileId || !commentId || !String(message || '').trim()) {
        return res.status(400).json({ success: false, message: '缺少 profileId / commentId / message' });
      }
      const { token, profile } = await _resolveCommentCtx(profileId, commentId);
      const body = new URLSearchParams();
      body.append('message', String(message));
      body.append('access_token', token);
      const r = await callFacebookGraphApi(`${commentId}/comments`, 'POST', body, profile, token);
      const err = _fbErrOf(r);
      if (err) return res.status(400).json({ success: false, message: err });
      log('SUCCESS', `💬 [评论] 回复成功 comment=${commentId} → ${r && r.id}`);
      return res.json({ success: true, replyId: String((r && r.id) || '') });
    } catch (e) {
      log('ERROR', `[评论/回复] 异常: ${e.message}`);
      return res.status(e.status || 500).json({ success: false, message: String(e.message || e) });
    }
  });

  // 私密回复 = 「私聊」：消息以主页身份进对方 Messenger，同时落进主页收件箱对话
  // ⚠️ 官方限制：只能在对方评论后 7 天内发送，且需 pages_messaging 权限
  _app.post('/api/facebook/comment/private-reply', async (req, res) => {
    try {
      const { profileId, commentId, message } = req.body || {};
      if (!profileId || !commentId || !String(message || '').trim()) {
        return res.status(400).json({ success: false, message: '缺少 profileId / commentId / message' });
      }
      const { token, profile } = await _resolveCommentCtx(profileId, commentId);
      const body = new URLSearchParams();
      body.append('message', String(message));
      body.append('access_token', token);
      const r = await callFacebookGraphApi(`${commentId}/private_replies`, 'POST', body, profile, token);
      const err = _fbErrOf(r);
      if (err) return res.status(400).json({ success: false, message: err });
      log('SUCCESS', `💬 [评论] 私密回复（私聊）已发送 comment=${commentId} → ${r && r.id}`);
      return res.json({ success: true, messageId: String((r && r.id) || '') });
    } catch (e) {
      log('ERROR', `[评论/私密回复] 异常: ${e.message}`);
      return res.status(e.status || 500).json({ success: false, message: String(e.message || e) });
    }
  });
}

module.exports = { __inject, registerRoutes };
