'use strict';

// ============================================================================
// Facebook Billing Routes - extracted from puppeteer-api-server.js
// ============================================================================

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const { exec, spawn } = require('child_process');
const crypto = require('crypto');

const proxyTunnel = require('./proxy-tunnel');
const { parseProxy, sshTunnelManager, socksChainServer, _proxyTunnels } = proxyTunnel;
const browserManagerModule = require('./browser-manager');
const { activeBrowsers, pendingBrowserCount, profileCookiesCache, profileGraphqlFailCache, browserManager, launchQueueManager, BrowserManager, LaunchQueue, getAvailableDebugPort, extractEmailPrefix, extractFbToken, safePageEvaluate, safePageEvaluateVoid, isProfileRunning, ensureBrowserIsRunning, executeWithBrowserRetry, _rawCdpExtractToken, logBrowserClose } = browserManagerModule;
const cookieManager = require('./cookie-manager');
const { normalizeCookie, preinjectCookies, preinjectCookiesToDatabase, parseCookieString, syncCookiesToStorage, attachCookieSync, getCookiesFromStorage } = cookieManager;
const databaseModule = require('./database');
const { DatabasePool, initDatabase, ensureAdAccountsTable, ensurePagesTable, ensureBusinessesTable, ensureAdsTable, ensurePaymentTokensTable, ensurePixelsTable, ensureAdTemplatesTable, loadProfilesFromFile, findProfileById, autoFillPasswordOnPage, probeConnectivity, db, mainDbPool, dbPath, credentialsDb, BROWSER_PROFILES_ROOT: BROWSER_PROFILES_ROOT_DB } = databaseModule;
const fbGraph = require('./facebook-graph');
const { fetchGraphApi, callFacebookGraphApiViaBrowser, callFacebookGraphApi, serializeGraphApiValue } = fbGraph;
const adPubModule = require('./facebook-ad-publish');
const { SkipPublishError, runFacebookPublishAdApi, runFacebookPublishAd } = adPubModule;
const billingModule = require('./facebook-billing');
const { clickButtonByText, fillCardForm, fillIframeCardFields, detectCardBrand, normalizeFbTimezoneId, getBillingCache, getBillingCacheKey, setBillingCache, buildBillingHubUrl, navigateToBillingHub, retryWithTokenRefresh, ensureFbLanguage, tryUpdateBillingCountrySmart, postOperationSync, tryUpdateCurrencyTimezone } = billingModule;
const healthModule = require('./health-diagnostics');
const { buildDiagnosticsHtml } = healthModule;

// 🔑 校验 EAA access token 是否还有效。
//    以前只用 `token.startsWith('EAA')` 判断，token 过期/被作废后仍会被复用 →
//    取数返回全 0 却报成功（实测 profile 4178），并且坏 token 还会被写回云端。
//    这里用最轻量的 /me 探测：HTTP 200 且无 error 才算有效。
async function isFbTokenAlive(token) {
    if (!token || typeof token !== 'string' || !token.startsWith('EAA')) return false;
    try {
        const resp = await fetch(`https://graph.facebook.com/v21.0/me?fields=id&access_token=${encodeURIComponent(token)}`);
        let json = null;
        try { json = await resp.json(); } catch { return false; }
        if (json && json.error) return false;
        return resp.ok && !!(json && json.id);
    } catch {
        // 网络/代理异常时不要误判为「失效」，交给后续流程按原逻辑处理
        return null;
    }
}
const tokenProvider = require('./payment/token-provider');
const adposClient = require('./integrations/adpos-client');
const googleAdsService = require('./google-ads-service');

// Injected variables
let _log = () => {};
let _app = null;
let _PORT = 9999;
let _API_SECRET = '';
let _directConnectionFailures = new Set();
let _S5_TUNNEL_PORT = 10808;
let _APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
let _BROWSER_PROFILES_ROOT = '';
let _FILE_LOG_PATH = '';
let _SCREENSHOT_DIR = '';
let _ensureVerificationCodesTable = null;

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 🩺 Account Quality 页面文本 → 该 BM 的「账号质量」。
//    这是唯一能反映 **Business Portfolio 自身** 是否被封/受限的出处（Graph 没有任何字段）。
//    返回 { status, evidence, policy }，status 取值：
//      disabled   已停用   | restricted 受限      | active 正常
//      no_login   浏览器未登录 Facebook
//      not_found  页面里根本没有这个 BM（该身份多半不是管理员 / 已被撤权）
//      unknown    认不出来
//    ⚠️ 核心原则：**宁可说不知道，也不谎报正常**。必须在页面里看到该 BM 的 ID 或名称，
//       再以它为锚点看附近状态词，才敢下结论；否则一律 not_found/unknown。
//       这样即使 Meta 改版、或 ?business_id= 不生效（页面永远只显示默认 Portfolio），
//       最坏结果是「无权限查询」而不是把一堆受限 BM 涂成正常。
function classifyAccountQuality(text, bizId, bizName) {
  const t = String(text || '');
  if (!t.trim()) return { status: 'unknown', evidence: '页面没有任何内容', policy: '' };
  const lower = t.toLowerCase();

  // 未登录：登出态只剩登录页（Account Quality 必须登录才看得到）
  if (/(log in|log into facebook|登录|登入)/.test(lower) && !/(account quality|账号质量|账户质量)/.test(lower)) {
    return { status: 'no_login', evidence: '浏览器未登录 Facebook', policy: '' };
  }

  // 锚点：优先 BM ID，其次 BM 名称（页面上通常显示名称，ID 未必出现在可见文本里）
  const byId = bizId && t.includes(bizId);
  const byName = !byId && bizName && bizName.length >= 3 && t.includes(bizName);
  if (!byId && !byName) {
    return { status: 'not_found', evidence: '页面中未出现该 BM（该身份可能不是管理员）', policy: '' };
  }
  const idx = byId ? t.indexOf(bizId) : t.indexOf(bizName);
  // 只看锚点附近的文本，避免被页面里别的资产的「Active/受限」串味
  const win = t.slice(Math.max(0, idx - 900), idx + 900);
  const grab = (re) => { const m = win.match(re); return m ? String(m[0]).trim().replace(/\s+/g, ' ') : ''; };

  const disabledEv = grab(/(已停用|已禁用|已关闭|已封禁|停用|禁用|disabled)/i);
  const restrictedEv = grab(/(受限|受限制|限制投放|restricted)/i);
  const activeEv = grab(/(无限制|未受限|有效|正常|active)/i);
  const policy = grab(/([^\n]{0,80}(?:违反|政策|条款|policy)[^\n]{0,80})/i);

  if (disabledEv) return { status: 'disabled', evidence: disabledEv, policy };
  if (restrictedEv) return { status: 'restricted', evidence: restrictedEv, policy };
  if (activeEv) return { status: 'active', evidence: activeEv, policy };
  return { status: 'unknown', evidence: '锚点附近未找到可识别的状态文案', policy };
}

// 🆕 「账号质量」首选读法：调 FB 内部 GraphQL —— AccountQualityHubAssetOwnerViewV2Query
//    来源：抓包脚本 PzrdBmList（doc_id 6139497919470985, variables={assetOwnerId:<bmid>}）。
//    🔑 这条接口只认 BM ID，不需要任何广告号 —— 「没有广告号就读不了 BM 状态」是错的。
//    返回结构化 JSON：data.assetOwnerData.advertising_restriction_info = { is_restricted,
//    restriction_type, status }，比抠页面文本又快又准（毫秒级 vs 7s/BM）。
//    ⚠️ doc_id 会随 FB 前端发版变化 —— 拿不到结论时由上层回退到页面文本抓取。
//    @returns {{ ok:boolean, map:Map<string,object>, detail:string }}
async function probeBmAccountQualityViaGraphql(browser, items) {
  const map = new Map();
  const list = (Array.isArray(items) ? items : []).filter((b) => b && b.id);
  if (!browser || !list.length) return { ok: false, map, detail: 'no browser/items' };
  const page = await browser.newPage();
  try {
    // 必须在 facebook.com 域：同源才能发 /api/graphql/，也才有 fb_dtsg / lsd / USER_ID
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    // 等 DTSG 渲染出来（最多 ~10s）
    for (let i = 0; i < 20; i++) {
      const ready = await safePageEvaluate(page, () => {
        const el = document.querySelector('input[name="fb_dtsg"]');
        if (el && el.value) return true;
        try { const d = window.require('DTSGInitialData'); if (d && d.token) return true; } catch {}
        return /"DTSGInitialData"[\s\S]{0,400}?"token":"([^"]+)"/.test(document.documentElement ? document.documentElement.innerHTML : '');
      });
      if (ready) break;
      await _sleep(500);
    }
    // 🔎 诊断：页面到底有没有带齐发 GraphQL 所需的会话参数（失败时一眼看出卡在哪）
    try {
      const st = await safePageEvaluate(page, () => {
        let dtsg = ''; try { const d = window.require('DTSGInitialData'); if (d && d.token) dtsg = d.token; } catch {}
        if (!dtsg) { const el = document.querySelector('input[name="fb_dtsg"]'); if (el && el.value) dtsg = el.value; }
        let uid = ''; try { const cu = window.require('CurrentUserInitialData'); if (cu && cu.USER_ID) uid = String(cu.USER_ID); } catch {}
        return { href: location.href, dtsgLen: dtsg ? dtsg.length : 0, uid: uid || '' };
      });
      _log('INFO', `[AccountQuality][GQL] 页面就绪 href=${(st && st.href) || '?'} dtsgLen=${(st && st.dtsgLen) || 0} user=${(st && st.uid) || 'n'}`);
    } catch {}

    let anyOk = false;
    let _diag = 0;
    for (const biz of list) {
      const r = await safePageEvaluate(page, async (bmid) => {
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
        if (!dtsg || !userId) return { ok: false, stage: 'extract', detail: `dtsg=${dtsg ? 1 : 0} user=${userId || 'n'}` };
        const sd = req('SiteData') || {};
        const spinR = String(sd.__spin_r || sd.__rev || '');
        const spinB = String(sd.__spin_b || 'trunk');
        const spinT = String(sd.__spin_t || Math.floor(Date.now() / 1000));
        let sum = 0; for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
        const body = new URLSearchParams();
        body.append('av', userId);
        body.append('__user', userId);
        body.append('__a', '1');
        body.append('__rev', spinR);
        body.append('__spin_r', spinR);
        body.append('__spin_b', spinB);
        body.append('__spin_t', spinT);
        body.append('fb_dtsg', dtsg);
        body.append('jazoest', '2' + sum);
        if (lsd) body.append('lsd', lsd);
        body.append('fb_api_caller_class', 'RelayModern');
        body.append('fb_api_req_friendly_name', 'AccountQualityHubAssetOwnerViewV2Query');
        body.append('server_timestamps', 'true');
        // ⚠️ BM ID 是 16 位、超过 Number.MAX_SAFE_INTEGER → 不能走 Number()，会丢精度。
        //    照抄抓包脚本：纯数字就原样拼成 JSON 数字字面量。
        body.append('variables', /^\d+$/.test(String(bmid))
          ? `{"assetOwnerId": ${bmid}}`
          : JSON.stringify({ assetOwnerId: String(bmid) }));
        body.append('doc_id', '6139497919470985');
        return await new Promise((resolve) => {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', 'https://www.facebook.com/api/graphql/', true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.setRequestHeader('X-FB-Friendly-Name', 'AccountQualityHubAssetOwnerViewV2Query');
            if (lsd) xhr.setRequestHeader('X-FB-LSD', lsd);
            xhr.onload = () => resolve({ ok: true, status: xhr.status, text: String(xhr.responseText || '') });
            xhr.onerror = () => resolve({ ok: false, stage: 'xhr' });
            xhr.send(body.toString());
            setTimeout(() => resolve({ ok: false, stage: 'timeout' }), 20000);
          } catch (e) { resolve({ ok: false, stage: 'exception', detail: String((e && e.message) || e) }); }
        });
      }, String(biz.id));

      if (!r || !r.ok) {
        if (_diag < 2) { _log('WARN', `[AccountQuality][GQL] BM ${biz.id} 请求未成功 stage=${(r && r.stage) || '?'} ${(r && r.detail) || ''}`); _diag++; }
        continue;
      }
      let s = String(r.text || '').trim();
      if (s.startsWith('for (;;);')) s = s.slice('for (;;);'.length);
      let j = null;
      try { j = JSON.parse(s); } catch {
        if (_diag < 2) { _log('WARN', `[AccountQuality][GQL] BM ${biz.id} 非 JSON(status=${r.status}): ${s.slice(0, 200)}`); _diag++; }
        continue;
      }
      if (!j || j.errors) {
        if (_diag < 2) { _log('WARN', `[AccountQuality][GQL] BM ${biz.id} FB 报错: ${JSON.stringify(j && j.errors).slice(0, 300)}`); _diag++; }
        continue;
      }
      const info = j && j.data && j.data.assetOwnerData && j.data.assetOwnerData.advertising_restriction_info;
      if (!info) {
        if (_diag < 2) {
          const keys = j && j.data && j.data.assetOwnerData ? Object.keys(j.data.assetOwnerData).join(',') : (j && j.data ? Object.keys(j.data).join(',') : 'null');
          _log('WARN', `[AccountQuality][GQL] BM ${biz.id} 无 advertising_restriction_info；assetOwnerData 字段=[${keys}]`); _diag++;
        }
        continue;
      }
      let out = null;
      if (info.is_restricted === false) {
        out = { status: 'active', evidence: info.restriction_type === 'ALE' ? 'ALE 已恢复' : 'is_restricted=false', policy: '' };
      } else if (info.is_restricted === true) {
        if (info.status === 'APPEAL_PENDING') out = { status: 'restricted', evidence: '申诉审核中', policy: '' };
        else if (info.status === 'APPEAL_REJECTED_NO_RETRY') out = { status: 'disabled', evidence: '申诉被拒', policy: '' };
        else out = { status: 'restricted', evidence: `受限${info.status ? ' ' + info.status : ''}`, policy: '' };
      }
      if (out) { map.set(String(biz.id), { businessId: String(biz.id), ...out }); anyOk = true; }
    }
    return { ok: anyOk, map, detail: anyOk ? '' : 'no conclusive result' };
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

// 🩺 兜底读法：在既有浏览器里逐个 BM 打开 Account Quality 页面、抠 innerText 判定。
//    ⚠️ 必须「浏览器还活着」的时候调用：fetch-adaccounts-graph 收尾会把它关掉。
//    ⚠️ 只在 GraphQL 那条路拿不到结论时才用（页面是 React SPA，常拿到 not_found/unknown）。
async function probeBmAccountQualityViaPageText(browser, items, maxBms = 20) {
  const list = (Array.isArray(items) ? items : []).filter((b) => b && b.id);
  const results = [];
  let rawSample = '';
  if (!browser || !list.length) return { results, rawSample };
  const page = await browser.newPage();
  try {
    for (const biz of list.slice(0, maxBms)) {
      const url = `https://business.facebook.com/accountquality/?business_id=${encodeURIComponent(biz.id)}`;
      let text = '';
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await _sleep(6000);
        text = (await safePageEvaluate(page, () => (document.body ? document.body.innerText : ''))) || '';
      } catch (e) {
        results.push({ businessId: biz.id, status: 'unknown', evidence: `页面读取失败: ${String(e.message || e).slice(0, 150)}`, policy: '' });
        continue;
      }
      if (!rawSample && text) rawSample = text.slice(0, 3000);
      results.push({ businessId: biz.id, ...classifyAccountQuality(text, biz.id, biz.name) });
    }
  } finally {
    try { await page.close(); } catch (_) {}
  }
  return { results, rawSample };
}

// 🩺 在既有浏览器里逐个 BM 判定「账号质量」：先 GraphQL（快且准），拿不到结论的再走页面文本。
//    @param {object} browser  Puppeteer Browser
//    @param {Array<{id:string,name:string}>} items
//    @param {number} maxBms  单次最多查几个
async function probeBmAccountQuality(browser, items, maxBms = 20) {
  const list = (Array.isArray(items) ? items : []).filter((b) => b && b.id).slice(0, maxBms);
  if (!browser || !list.length) return { results: [], rawSample: '' };

  let gqlMap = new Map();
  let gqlDetail = '';
  try {
    const g = await probeBmAccountQualityViaGraphql(browser, list);
    gqlMap = g.map; gqlDetail = g.detail;
  } catch (e) { gqlDetail = String((e && e.message) || e); }
  if (gqlMap.size) _log('INFO', `[AccountQuality] GraphQL 命中 ${gqlMap.size}/${list.length} 个 BM`);

  const pending = list.filter((b) => !gqlMap.has(String(b.id)));
  const merged = new Map(gqlMap);
  let rawSample = '';
  if (pending.length) {
    const { results: pageResults, rawSample: rs } = await probeBmAccountQualityViaPageText(browser, pending, maxBms);
    rawSample = rs;
    (pageResults || []).forEach((r) => merged.set(String(r.businessId), r));
  }
  const results = list.map((b) => merged.get(String(b.id))
    || { businessId: String(b.id), status: 'unknown', evidence: '未取得结果', policy: '' });
  if (gqlDetail && !rawSample) rawSample = `graphql: ${gqlDetail}`;
  return { results, rawSample };
}

// 🩺 「可创建广告号上限」= Business Settings → 商家資訊 里的 Ad account creation limit。
//    ⚠️ 公开 Graph API 没有这个字段（实测 Business 节点上一批候选名全报 nonexisting field，
//       唯一真实存在的是布尔 can_create_ad_account）。数值只来自内部 Comet GraphQL：
//         friendly_name = BusinessCometBizSuiteSettingsBusinessInfoV3ViewContainerQuery
//         doc_id        = 28740350328929733
//         variables     = {"businessID": <bmid>, "overridePrimaryBusinessLocationEligibility": false}
//    响应是**多段流式**（@defer 分片，整体不是合法 JSON），目标字段
//    business.ad_account_creation_limit 落在其中一片 → 直接对整段文本正则抠取。
//    必须在 business.facebook.com 域：同源才能发 /api/graphql/，也才有 fb_dtsg / lsd / USER_ID。
//    @returns {{ ok:boolean, map:Map<string,number>, detail:string }}
async function probeBmAdAccountLimitsViaGraphql(browser, items) {
  const map = new Map();
  const list = (Array.isArray(items) ? items : []).filter((b) => b && b.id);
  if (!browser || !list.length) return { ok: false, map, detail: 'no browser/items' };
  const page = await browser.newPage();
  try {
    await page.goto('https://business.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      const ready = await safePageEvaluate(page, () => {
        const el = document.querySelector('input[name="fb_dtsg"]');
        if (el && el.value) return true;
        try { const d = window.require('DTSGInitialData'); if (d && d.token) return true; } catch {}
        return false;
      });
      if (ready) break;
      await _sleep(500);
    }
    let anyOk = false;
    let _diag = 0;
    for (const biz of list) {
      const r = await safePageEvaluate(page, async (bmid) => {
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
        if (!dtsg || !userId) return { ok: false, stage: 'extract', detail: `dtsg=${dtsg ? 1 : 0} user=${userId || 'n'}` };
        let sum = 0; for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
        const body = new URLSearchParams();
        body.append('__a', '1');
        body.append('__user', userId);
        body.append('fb_dtsg', dtsg);
        body.append('jazoest', '2' + sum);
        if (lsd) body.append('lsd', lsd);
        body.append('fb_api_caller_class', 'RelayModern');
        body.append('fb_api_req_friendly_name', 'BusinessCometBizSuiteSettingsBusinessInfoV3ViewContainerQuery');
        body.append('server_timestamps', 'true');
        // ⚠️ BM ID 是 16 位、超过 Number.MAX_SAFE_INTEGER → 不能走 Number()，会丢精度。
        //    纯数字就原样拼成 JSON 数字字面量。
        body.append('variables', /^\d+$/.test(String(bmid))
          ? `{"businessID": ${bmid}, "overridePrimaryBusinessLocationEligibility": false}`
          : JSON.stringify({ businessID: String(bmid), overridePrimaryBusinessLocationEligibility: false }));
        body.append('doc_id', '28740350328929733');
        return await new Promise((resolve) => {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', 'https://business.facebook.com/api/graphql/', true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.setRequestHeader('X-FB-Friendly-Name', 'BusinessCometBizSuiteSettingsBusinessInfoV3ViewContainerQuery');
            if (lsd) xhr.setRequestHeader('X-FB-LSD', lsd);
            xhr.onload = () => resolve({ ok: true, status: xhr.status, text: String(xhr.responseText || '') });
            xhr.onerror = () => resolve({ ok: false, stage: 'xhr' });
            xhr.send(body.toString());
            setTimeout(() => resolve({ ok: false, stage: 'timeout' }), 20000);
          } catch (e) { resolve({ ok: false, stage: 'exception', detail: String((e && e.message) || e) }); }
        });
      }, String(biz.id));

      if (!r || !r.ok) {
        if (_diag < 2) { _log('WARN', `[AdAccountLimit][GQL] BM ${biz.id} 请求未成功 stage=${(r && r.stage) || '?'} ${(r && r.detail) || ''}`); _diag++; }
        continue;
      }
      // 流式响应里的目标片段形如：{"data":{"ad_account_creation_limit":1},"extensions":{...}}
      const m = String(r.text || '').match(/"ad_account_creation_limit"\s*:\s*(\d+)/);
      if (!m) {
        if (_diag < 2) { _log('WARN', `[AdAccountLimit][GQL] BM ${biz.id} 未命中 ad_account_creation_limit（status=${r.status}）`); _diag++; }
        continue;
      }
      map.set(String(biz.id), Number(m[1]));
      anyOk = true;
    }
    return { ok: anyOk, map, detail: anyOk ? '' : 'no conclusive result' };
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

// 🩺 把「账号质量」探测结果落到云端 businesses 表（aq_status/aq_evidence/aq_policy/aq_updated_at）。
//    只落「有结论」的状态（active/restricted/disabled）；unknown/not_found/no_login 不写，
//    避免把「这次不是管理员/没读到」当成 BM 状态污染其它机器看到的数据。
//    云端 upsert 只在带 aq_status 时才覆盖 → 其它写入方（只带认证状态）不会把它抹掉。
//    失败只告警，绝不影响探测响应。
const AQ_STORABLE = new Set(['active', 'restricted', 'disabled']);
function persistAccountQuality(profileId, results) {
  try {
    const items = (Array.isArray(results) ? results : [])
      .filter((r) => r && r.businessId && AQ_STORABLE.has(String(r.status || '')))
      .map((r) => ({
        id: String(r.businessId),
        businessId: String(r.businessId),
        profileId: String(profileId),
        aq_status: String(r.status || ''),
        aq_evidence: String(r.evidence || ''),
        aq_policy: String(r.policy || ''),
        aq_updated_at: new Date().toISOString(),
      }));
    if (!items.length) return;
    const sBase = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
    fetch(`${sBase}/api/businesses/bulk-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': process.env.PUPPETEER_API_SECRET || '' },
      body: JSON.stringify({ items }),
    }).then((r) => {
      if (!r || !r.ok) _log('WARN', `[AccountQuality] 落库返回 HTTP ${r && r.status}（已忽略）`);
      else _log('INFO', `[AccountQuality] ✅ 账号质量已落库: profile=${profileId} ${items.length} 个 BM`);
    }).catch((e) => _log('WARN', `[AccountQuality] 落库失败（已忽略）: ${e.message}`));
  } catch (e) {
    try { _log('WARN', `[AccountQuality] 落库异常（已忽略）: ${e.message}`); } catch {}
  }
}

// 🩺 BM 创建时间（Business 节点的 created_time）。
//    ⚠️ 实测结论（2026-10-02，profile 5035 真实 token）：me/businesses 上
//       `creation_time` 会被接受但**返回空**，真正有值的是 **`created_time`**
//       （返回形如 "2025-01-09T02:49:57+0000"）。
//    ⚠️ 必须单独请求：字段名写错会让整条请求报 error 100，不能塞进 me/businesses 主 fields。
//    两个字段名都试、合并；都取不到就返回空 Map，主流程不受影响。
async function fetchBmCreationTimes(profForApi, token) {
  if (!profForApi || !token) return new Map();
  const m = new Map();
  for (const field of ['created_time', 'creation_time']) {
    let r = null;
    try {
      r = await callFacebookGraphApi(`me/businesses?fields=id,${field}&limit=100`, 'GET', null, profForApi, token);
    } catch { continue; }
    if (!r || r.error) continue;
    (Array.isArray(r.data) ? r.data : []).forEach(b => {
      if (b && b.id && b[field] && !m.has(String(b.id))) m.set(String(b.id), String(b[field]));
    });
    // 真正取到值才提前结束；否则继续试下一个字段名
    if (m.size) { _log('INFO', `[BM创建时间] 字段 ${field} 命中 ${m.size} 个 BM`); return m; }
  }
  _log('WARN', '[BM创建时间] created_time / creation_time 都取不到（已跳过，不影响主流程）');
  return m;
}

// 🧩 把消息列表打包为 JSON 字符串：优先保留最新消息，超长时从最旧开始丢弃，保证始终是合法 JSON
//    （Graph 返回新→旧；不能用简单的字符串截断，否则 messages_json 变非法 JSON、前端解析为空）
function _packMessagesJson(msgs, maxLen) {
  try {
    const arr = Array.isArray(msgs) ? msgs : [];
    if (!arr.length) return '[]';
    let s = JSON.stringify(arr);
    if (s.length <= maxLen) return s;
    let keep = arr;
    while (keep.length > 1) {
      keep = keep.slice(0, keep.length - 1);
      s = JSON.stringify(keep);
      if (s.length <= maxLen) return s;
    }
    return s;
  } catch {
    return '[]';
  }
}

// 🕒 时区写入规范化
//    「获取信息」写入 ad_accounts.timezone_id 的是「名称+偏移」（如 Asia/Taipei+8），
//    而「更改账单国家/时区」从前端拿到的是 FB 数字时区ID（如 136）→ 两条路径格式不一致，
//    列表里就会同时出现 "Asia/Taipei+8" 和 "136"（旧前端还会把它渲染成 UTC+136）。
//    这里在保存前统一转成「名称+偏移」，与「获取信息」保持一致。
const FB_TZ_ID_TO_IANA = {
  '1': 'America/Los_Angeles', '2': 'America/Denver', '3': 'Pacific/Honolulu',
  '4': 'America/Anchorage', '6': 'America/Chicago', '7': 'America/New_York',
  '8': 'Asia/Dubai', '14': 'Australia/Adelaide', '15': 'Australia/Sydney',
  '17': 'Asia/Dhaka', '22': 'America/Noronha', '24': 'Pacific/Noumea',
  '25': 'America/Sao_Paulo', '37': 'America/Halifax', '57': 'Europe/Paris',
  '58': 'Europe/London', '60': 'Europe/Athens', '71': 'Asia/Kolkata',
  '77': 'Asia/Tokyo', '100': 'Pacific/Auckland', '105': 'Asia/Karachi',
  '109': 'Atlantic/Azores', '116': 'Europe/Moscow', '132': 'Asia/Bangkok',
  '136': 'Asia/Taipei',
};

// 由 IANA 名称算出当前 UTC 偏移，返回 "+8" / "-7" / "+5.5"
function tzUtcOffsetOf(iana) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'longOffset' }).formatToParts(new Date());
    const v = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    const m = v.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return '';
    const mins = Number(m[3] || 0);
    const hours = Number(m[2]) + (mins ? mins / 60 : 0);
    return `${m[1]}${Number.isInteger(hours) ? hours : hours.toFixed(1)}`;
  } catch { return ''; }
}

// 数字时区ID → "名称+偏移"；已经是名称/空值则原样返回
function toDisplayTimezone(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) {
    const iana = FB_TZ_ID_TO_IANA[s];
    if (!iana) return s;
    const off = tzUtcOffsetOf(iana);
    return off ? `${iana}${off}` : iana;
  }
  return s;
}

// 💰 Meta Graph API 的金额字段（amount_spent / balance / spend_cap / min_daily_budget …）单位都是
//    「该货币的最小单位」：两位小数货币（USD/EUR/INR…）返回的是「分」，要 /100；无小数货币
//    （JPY/KRW/VND/IDR…）本身即最小单位，不能再除。
//    实测依据：USD 账号 min_daily_budget=100（=$1.00）、spend_cap=99999999900（Meta 的"无上限"）；
//    IDR 账号 min_daily_budget=18158（=Rp18,158，若按分算只有 Rp181，低于最低日预算，不可能）。
const ZERO_DECIMAL_CURRENCIES = new Set([
    'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'VUV',
    'XAF', 'XOF', 'XPF', 'GNF', 'KMF', 'DJF', 'BIF',
]);
// 最小单位 → 主单位（保留 2 位小数，避免浮点尾数）
function toMajorAmount(amount, currency) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return 0;
    const div = ZERO_DECIMAL_CURRENCIES.has(String(currency || '').trim().toUpperCase()) ? 1 : 100;
    return Math.round((n / div) * 100) / 100;
}

// 主单位 → 最小单位（toMajorAmount 的逆运算，同样要区分无小数货币）
// ⚠️ 非法输入（NaN）返回 NaN 而不是 0：0 在 spend_cap 里是合法值（=取消限额），
//    如果在这里把 NaN 吞成 0，界面上误输入一个字母就会静默把限额清空。
function toMinorAmount(amount, currency) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return NaN;
    const mul = ZERO_DECIMAL_CURRENCIES.has(String(currency || '').trim().toUpperCase()) ? 1 : 100;
    return Math.round(n * mul);
}

// 🧱 兼容旧版 monolith：为本地 SQLite ad_accounts 表自动补齐常用列（原函数在模块抽取时丢失）
async function ensureAdAccountsColumns(database) {
  try {
    const rows = await new Promise((resolve, reject) => {
      database.all(`PRAGMA table_info(ad_accounts)`, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    const existing = new Set(rows.map(r => String(r.name).toLowerCase()));
    const wanted = [
      'token', 'access_token', 'account_id', 'account_email', 'name', 'status', 'account_status',
      'currency', 'timezone_id', 'timezone_name', 'timezone_offset', 'spend', 'amount_spent',
      'balance', 'credit_limit', 'threshold_amount', 'country', 'pages_count', 'pixels_count',
      'campaign_count', 'ad_count', 'bm_count', 'profile_name', 'account', 'platform',
      'funding_source', 'disable_reason', 'is_payment_enabled', 'notes', 'created_at', 'updated_at',
    ];
    for (const col of wanted) {
      if (existing.has(col.toLowerCase())) continue;
      await new Promise(resolve => database.run(`ALTER TABLE ad_accounts ADD COLUMN ${col} TEXT`, () => resolve()));
    }
  } catch (e) {
    try { _log('WARN', `[ensureAdAccountsColumns] 补列失败: ${e.message}`); } catch {}
  }
}

function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.app) _app = deps.app;
  if (deps.PORT) _PORT = deps.PORT;
  if (deps.API_SECRET) _API_SECRET = deps.API_SECRET;
  if (deps.directConnectionFailures) _directConnectionFailures = deps.directConnectionFailures;
  if (deps.S5_TUNNEL_PORT) _S5_TUNNEL_PORT = deps.S5_TUNNEL_PORT;
  if (deps.APP_ROOT) _APP_ROOT = deps.APP_ROOT;
  if (deps.BROWSER_PROFILES_ROOT) _BROWSER_PROFILES_ROOT = deps.BROWSER_PROFILES_ROOT;
  if (deps.FILE_LOG_PATH) _FILE_LOG_PATH = deps.FILE_LOG_PATH;
  if (deps.SCREENSHOT_DIR) _SCREENSHOT_DIR = deps.SCREENSHOT_DIR;
  if (deps.ensureVerificationCodesTable) _ensureVerificationCodesTable = deps.ensureVerificationCodesTable;
}

function registerRoutes() {
  if (!_app) return;

  const app = _app;
  const log = _log;
  const PORT = _PORT;
  const API_SECRET = _API_SECRET;
  const directConnectionFailures = _directConnectionFailures;
  const S5_TUNNEL_PORT = _S5_TUNNEL_PORT;
  const APP_ROOT = _APP_ROOT;
  const BROWSER_PROFILES_ROOT = _BROWSER_PROFILES_ROOT;
  const FILE_LOG_PATH = _FILE_LOG_PATH;
  const SCREENSHOT_DIR = _SCREENSHOT_DIR;
  const ensureVerificationCodesTable = _ensureVerificationCodesTable;
  const sleep = _sleep;

  // 🌐 云端（Storage Server / D1）写入工具：一律「后台执行 + 短超时 + 失败只告警」
  //    背景：这些同步以前都是 await，一旦线上（后端域名）抖动，整个业务请求会被它拖住 ——
  //    实测一次「获取信息」里的像素同步从 21:54:20 卡到 21:57:46（3 分 26 秒），
  //    而它的成败本来只影响云端副本（本地 SQLite 早已写好），不该出现在关键路径上。
  const REMOTE_SYNC_TIMEOUT_MS = Math.max(3000, parseInt(process.env.REMOTE_SYNC_TIMEOUT_MS || '15000', 10) || 15000);
  const syncToCloud = (url, payload, label) => {
    const t0 = Date.now();
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': process.env.PUPPETEER_API_SECRET || '' },
        body: JSON.stringify(payload),
        timeout: REMOTE_SYNC_TIMEOUT_MS
      }).then((r) => {
        if (!r || !r.ok) log('WARN', `[CloudSync] ${label} 返回 HTTP ${r && r.status}（已忽略，本地数据不受影响）`);
        else log('INFO', `[CloudSync] ${label} 已同步到线上（${Date.now() - t0}ms）`);
      }).catch((e) => {
        log('WARN', `[CloudSync] ${label} 同步失败（已忽略，本地数据不受影响）: ${e.message}`);
      });
    } catch (e) {
      log('WARN', `[CloudSync] ${label} 同步异常（已忽略）: ${e.message}`);
    }
  };


// ===== post '/api/facebook/adaccount-settings' (original lines 1808-1838) =====
app.post('/api/facebook/adaccount-settings', async (req, res) => {
    try {
        const { profileId, adaccountId } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: true, timezone_id: null, currency: null, status: 'no_browser' });
        }
        const page = await browserData.browser.newPage();
        let timezone_id = null;
        let currency = null;
        try {
            const act = adaccountId ? `act=${adaccountId}` : '';
            await page.goto(`https://business.facebook.com/adsmanager/settings/account_settings/?${act}`, { waitUntil: 'networkidle2', timeout: 25000 });
            const data = await page.evaluate(() => {
                let tz = null, cur = null;
                const txt = document.body.textContent || '';
                const tm = txt.match(/时区[:：]\s*([\w\-\s\/]+)/) || txt.match(/Timezone[:：]\s*([\w\-\s\/]+)/i);
                if (tm) tz = tm[1].trim();
                const cm = txt.match(/货币[:：]\s*([A-Z]{3})/) || txt.match(/Currency[:：]\s*([A-Z]{3})/i);
                if (cm) cur = cm[1].trim();
                return { tz, cur };
            });
            timezone_id = data.tz;
            currency = data.cur;
        } catch(_){ }
        try { await page.close(); } catch(_){ }
        return res.json({ success: true, timezone_id, currency });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/bm-account-quality' =====
// 🩺 用该配置的浏览器读「Business Portfolio 自身」是否被封/受限。
//    做法：优先调 FB 内部 GraphQL（AccountQualityHubAssetOwnerViewV2Query，只认 BM ID，
//    不需要广告号）→ 拿不到结论才回退打开 Account Quality 页面抠文本。
//    Graph 侧只有 is_disabled_for_integrity_reasons 这一个 BM 级信号（见 bmsUrl）。
//    ⚠️ 只有该 BM 的管理员才看得到 → 非管理员会返回 unknown/not_found（前端显示「无法判定/无权限查询」）。
app.post('/api/facebook/bm-account-quality', async (req, res) => {
    try {
        const { profileId, businesses } = req.body || {};
        if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
        const items = (Array.isArray(businesses) ? businesses : [])
            .map(b => ({ id: String(b?.id || b?.businessId || ''), name: String(b?.name || '') }))
            .filter(b => b.id);
        const browserData = activeBrowsers.get(String(profileId));
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: true, status: 'no_browser', results: [] });
        }
        if (!items.length) return res.json({ success: true, results: [] });

        const { results, rawSample } = await probeBmAccountQuality(browserData.browser, items);
        results.forEach(r => log('INFO', `[AccountQuality] profile=${profileId} BM ${r.businessId} → ${r.status} ${r.evidence || ''}`));
        persistAccountQuality(profileId, results); // 🩺 探测结果落库（云端 aq_* 四列）
        return res.json({ success: true, results, rawSample, truncated: items.length > 20 });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing' (original lines 1839-1865) =====
app.post('/api/facebook/billing', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const browserData = activeBrowsers.get(profileId);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: true, methods: [], status: 'no_browser' });
        }
        const page = await browserData.browser.newPage();
        let methods = [];
        try {
            await page.goto('https://business.facebook.com/adsmanager/billing', { waitUntil: 'networkidle2', timeout: 25000 });
            methods = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                return items.map(el => {
                    const t = el.textContent || '';
                    const type = (t.match(/信用卡|Debit|Visa|Mastercard|Amex/i) || [])[0] || 'Payment';
                    const last4 = (t.match(/\d{4}/) || [])[0] || '';
                    return { type, last4 };
                });
            });
        } catch(_){ }
        try { await page.close(); } catch(_){ }
        return res.json({ success: true, methods });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing/cards/merged' (original lines 1867-1921) =====
app.post('/api/facebook/billing/cards/merged', async (req, res) => {
    try {
        const { profileId, adAccountId } = req.body || {};
        const pid = String(profileId || '');
        const act = String(adAccountId || '');
        const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
        const storageBase = storageServerUrl.replace(/\/$/, '');
        let stash = [];
        let adpos = [];
        try {
            const r = await fetch(`${storageBase}/api/billing-methods`).catch(()=>null);
            const j = r && await r.json().catch(()=>({}));
            stash = Array.isArray(j && j.data) ? j.data : [];
        } catch {}
        try {
            const r = await adposClient.listAllCards({ profileId: pid, per_page: 500 });
            adpos = Array.isArray(r && r.data) ? r.data : [];
        } catch {}
        const merged = [];
        for (const s of stash) {
            merged.push({ last4: String(s.last4||''), brand: String(s.brand||''), holder: '', provider: '', tags: [], cvv: '', cardNumber: '', profile_id: String(s.profile_id||pid), account_id: String(s.account_id||act), billing_address: String(s.billing_address||'') });
        }
        for (const c of adpos) {
            merged.push({
                last4: String(c.last_four_digits || c.last4 || ''),
                brand: String(c.card_type || c.brand || ''),
                holder: String(c.name || ''),
                provider: String(c.provider || ''),
                tags: Array.isArray(c.tags) ? c.tags.map((x)=>String(x)) : [],
                cvv: '',
                cardNumber: String(c.card_number || ''),
                profile_id: pid,
                account_id: act,
                balance: typeof c.available_balance === 'number' ? c.available_balance : undefined,
                currency: String(c.currency || ''),
                status: String(c.status || ''),
                appliedAt: String(c.applied_at || ''),
                singleLimit: typeof c.single_transaction_limit === 'number' ? c.single_transaction_limit : undefined,
                autoTopup: typeof c.auto_topup === 'number' ? c.auto_topup : undefined,
                cardType: String(c.card_type || '')
            });
        }
        const uniq = [];
        const seen = new Set();
        for (const x of merged) {
            const k = String(x.last4||'');
            if (!k || seen.has(k)) continue;
            seen.add(k);
            uniq.push(x);
        }
        return res.json({ success: true, count: uniq.length, cards: uniq });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing/cards' (original lines 1926-2033) =====
app.post('/api/facebook/billing/cards', async (req, res) => {
    try {
        const { profileId, adAccountId } = req.body || {};
        const pid = String(profileId || '');
        const actId = String(adAccountId || '').replace('act_', '');

        log('INFO', `💳 [Profile=${pid}] 开始获取绑卡列表（轻量模式）: act=${actId}`);

        // 1. 确保浏览器正在运行
        const browserData = activeBrowsers.get(pid);
        let browser, page;
        if (browserData && browserData.browser && browserData.browser.isConnected()) {
            browser = browserData.browser;
            page = await browser.newPage();
        } else {
            log('WARN', `⚠️ [Profile=${pid}] 浏览器未运行，启动浏览器...`);
            const launchResp = await fetch(`http://127.0.0.1:${PORT}/api/launch-browser`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                body: JSON.stringify({ profileId: pid })
            });
            const launchJson = await launchResp.json().catch(() => ({}));
            if (!launchJson.success) {
                return res.json({ success: false, methods: [], message: '启动浏览器失败' });
            }
            // 等浏览器就绪
            await new Promise(r => setTimeout(r, 8000));
            const bd2 = activeBrowsers.get(pid);
            if (!bd2 || !bd2.browser || !bd2.browser.isConnected()) {
                return res.json({ success: false, methods: [], message: '浏览器启动后未就绪' });
            }
            browser = bd2.browser;
            page = await browser.newPage();
        }

        // 2. 🚀 通过 navigateToBillingHub 统一导航（先建 adsmanager session）
        log('INFO', `💳 [Profile=${pid}] 导航到 billing_hub...`);
        try {
            await navigateToBillingHub(page, actId);
            await new Promise(r => setTimeout(r, 3000));
        } catch (navErr) {
            log('WARN', `⚠️ [Profile=${pid}] 导航到 billing_hub 失败: ${navErr.message}`);
        }

        // 3. 提取所有信用卡信息
        const cards = await page.evaluate(() => {
            const results = [];
            // 尝试多种选择器匹配信用卡条目
            const selectors = [
                '[role="listitem"]',
                '[data-pagelet*="payment"]',
                '[data-testid*="payment"]',
                'div[class*="payment"]',
                'div[class*="billing"]',
                'div[class*="card"]',
                'div[style*="display"]:not([style*="none"])'
            ];
            const allElements = document.querySelectorAll(selectors.join(','));
            const seen = new Set();
            allElements.forEach(el => {
                const text = (el.textContent || '').trim();
                if (!text || text.length < 10) return;
                // 匹配信用卡品牌
                const brandMatch = text.match(/(Visa|Mastercard|American Express|Amex|Discover|JCB|Diners|UnionPay)/i);
                const brand = brandMatch ? brandMatch[1] : '';
                // 匹配 4 位数字（末四位）
                const last4Match = text.match(/\*{0,4}(\d{4})/);
                const last4 = last4Match ? last4Match[1] : '';
                // 匹配有效期
                const expMatch = text.match(/(\d{2})\/(\d{2,4})/);
                const expMonth = expMatch ? expMatch[1] : '';
                const expYear = expMatch ? expMatch[2] : '';
                const key = brand + last4;
                if (last4 && !seen.has(key)) {
                    seen.add(key);
                    results.push({ brand, last4, exp_month: expMonth, exp_year: expYear });
                }
            });
            // 兜底：找所有包含 **** 或卡号模式的行
            if (results.length === 0) {
                const allText = document.body.innerText || '';
                const lines = allText.split('\n');
                lines.forEach(line => {
                    const m = line.match(/((?:Visa|Mastercard|Amex|American Express|Discover)\s+[\s\*]*(\d{4}))/i);
                    if (m) {
                        results.push({
                            brand: m[1].split(/[\s\*]/)[0],
                            last4: m[2],
                            exp_month: '',
                            exp_year: ''
                        });
                    }
                });
            }
            return results;
        }).catch(err => {
            log('WARN', `⚠️ [Profile=${pid}] evaluate 提取卡片异常: ${err.message}`);
            return [];
        });

        log('INFO', `💳 [Profile=${pid}] 获取到 ${cards.length} 张卡: ${cards.map(c => c.brand+'*'+c.last4).join(', ')}`);
        return res.json({ success: true, count: cards.length, methods: cards });

    } catch (e) {
        log('ERROR', `❌ [Profile=${pid}] 获取卡号列表异常: ${e.message}`);
        return res.status(500).json({ success: false, methods: [], message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing/manual-payment' (original lines 2059-2236) =====
app.post('/api/facebook/billing/manual-payment', async (req, res) => {
    try {
        const { profileId, adAccountId, amount } = req.body || {};
        const pid = String(profileId || '');
        const actId = String(adAccountId || '').replace('act_', '');
        // 🚀 空金额 = auto（自动检测欠款并付清）
        const isAutoPay = !amount || String(amount).trim() === '' || String(amount).trim().toLowerCase() === 'auto';
        let payAmount = isAutoPay ? 0 : parseFloat(amount);
        if (!isAutoPay && (isNaN(payAmount) || payAmount <= 0)) {
            return res.json({ success: false, message: '金额无效' });
        }
        log('INFO', `💵 [Profile=${pid}] 手动付款开始: act=${actId}, amount=${isAutoPay ? 'auto(付清欠款)' : payAmount}`);

        // 确保浏览器运行
        let browserData = activeBrowsers.get(pid);
        let browser, page;
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            log('WARN', `⚠️ [Profile=${pid}] 浏览器未运行，启动浏览器...`);
            const launchResp = await fetch(`http://127.0.0.1:${PORT}/api/launch-browser`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                body: JSON.stringify({ profileId: pid })
            });
            const launchJson = await launchResp.json().catch(() => ({}));
            if (!launchJson.success) return res.json({ success: false, message: '启动浏览器失败' });
            await new Promise(r => setTimeout(r, 8000));
            browserData = activeBrowsers.get(pid);
            if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
                return res.json({ success: false, message: '浏览器启动后未就绪' });
            }
        }
        browser = browserData.browser;
        const pages = await browser.pages();
        page = pages.find(p => p.url().includes('facebook.com')) || pages[0] || await browser.newPage();

        // 🚀 通过 navigateToBillingHub 统一导航
        log('INFO', `💵 [Profile=${pid}] 导航到 billing_hub...`);
        try {
            await navigateToBillingHub(page, actId);
            await new Promise(r => setTimeout(r, 3000));
        } catch (navErr) {
            log('WARN', `⚠️ [Profile=${pid}] 导航到 billing_hub 失败: ${navErr.message}`);
        }

        // 🚀 AutoPay：从页面提取欠款金额
        if (isAutoPay) {
            try {
                const balanceInfo = await page.evaluate(() => {
                    const text = document.body.innerText || '';
                    // 匹配常见余额/欠款格式: $123.45, -$50.00, Amount due: $100
                    const patterns = [
                        /(?:amount due|balance due|outstanding|欠款|应付|total due)[:\s]*\$?([\d,]+\.?\d*)/i,
                        /(?:balance|余额)[:\s]*[-–—]?\s*\$?([\d,]+\.?\d*)/i,
                        /[-–—]\s*\$?([\d,]+\.?\d*)/,
                        /\$?([\d,]+\.?\d*)\s*(?:due|欠款)/i,
                    ];
                    for (const pat of patterns) {
                        const m = text.match(pat);
                        if (m) return { found: true, raw: m[1].replace(/,/g, ''), fullMatch: m[0] };
                    }
                    // 兜底：找页面最大金额数字（有负号或due相关的）
                    const allNums = text.match(/[-–—]?\s*\$?\s*[\d,]+\.?\d*/g) || [];
                    for (const n of allNums) {
                        if (n.includes('-') || n.includes('–') || n.includes('—')) {
                            const num = n.replace(/[-–—\s$,]/g, '');
                            if (!isNaN(parseFloat(num))) return { found: true, raw: num.replace(/,/g,''), fullMatch: n };
                        }
                    }
                    return { found: false, raw: '0' };
                });
                if (balanceInfo.found) {
                    payAmount = Math.abs(parseFloat(balanceInfo.raw));
                    if (payAmount > 0) {
                        log('INFO', `💵 [Profile=${pid}] AutoPay 检测到欠款: $${payAmount}`);
                    } else {
                        log('WARN', `⚠️ [Profile=${pid}] AutoPay 检测欠款为 $0，默认使用 $50`);
                        payAmount = 50;
                    }
                } else {
                    log('WARN', `⚠️ [Profile=${pid}] AutoPay 未检测到欠款金额，默认使用 $50`);
                    payAmount = 50;
                }
            } catch (balErr) {
                log('WARN', `⚠️ [Profile=${pid}] AutoPay 提取欠款异常: ${balErr.message}，默认使用 $50`);
                payAmount = 50;
            }
        }

        // 🚀 自动点击"添加资金"或"Make a Payment"按钮
        let paymentSuccess = false;
        try {
            // 尝试模拟点击付款按钮
            const clickResult = await page.evaluate((amt) => {
                // 尝试多种按钮文本匹配
                const buttonTexts = ['Make a Payment', 'Add Funds', '添加资金', '付款', '手动付款', 'Top Up', 'Make payment'];
                for (const txt of buttonTexts) {
                    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], span[role="button"]'));
                    const found = buttons.find(el => (el.textContent || '').trim().toLowerCase() === txt.toLowerCase());
                    if (found) { found.click(); return 'clicked_' + txt; }
                }
                // 尝试部分匹配
                for (const txt of buttonTexts) {
                    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                    const found = buttons.find(el => (el.textContent || '').toLowerCase().includes(txt.toLowerCase()));
                    if (found) { found.click(); return 'fuzzy_' + txt; }
                }
                return 'no_button_found';
            }, payAmount);
            log('INFO', `💵 [Profile=${pid}] 点击付款按钮: ${clickResult}`);
            await new Promise(r => setTimeout(r, 3000));
        } catch (clickErr) {
            log('WARN', `⚠️ [Profile=${pid}] 点击付款按钮异常: ${clickErr.message}`);
        }

        // 🚀 输入金额
        try {
            const amountResult = await page.evaluate((amt) => {
                // 找金额输入框
                const inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"], input[placeholder*="amount" i], input[placeholder*="金额" i], input[aria-label*="amount" i], input[aria-label*="金额" i]'));
                for (const inp of inputs) {
                    const el = inp;
                    if ((el.placeholder || '').toLowerCase().includes('amount') || (el.placeholder || '').includes('金额') || (el.getAttribute('aria-label') || '').toLowerCase().includes('amount')) {
                        el.click();
                        el.focus();
                        el.value = '';
                        (el).value = String(amt);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return 'entered_' + amt;
                    }
                }
                return 'no_amount_input';
            }, payAmount);
            log('INFO', `💵 [Profile=${pid}] 输入金额: ${amountResult}`);
            await new Promise(r => setTimeout(r, 2000));
        } catch (inputErr) {
            log('WARN', `⚠️ [Profile=${pid}] 输入金额异常: ${inputErr.message}`);
        }

        // 🚀 点击确认付款按钮
        try {
            const confirmResult = await page.evaluate(() => {
                const confirmTexts = ['Pay', 'Confirm', 'Submit', 'Continue', '付款', '确认', '提交', '继续'];
                for (const txt of confirmTexts) {
                    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                    const found = buttons.find(el => (el.textContent || '').trim().toLowerCase() === txt.toLowerCase());
                    if (found) { found.click(); return 'clicked_' + txt; }
                }
                for (const txt of confirmTexts) {
                    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                    const found = buttons.find(el => (el.textContent || '').toLowerCase().includes(txt.toLowerCase()));
                    if (found) { found.click(); return 'fuzzy_' + txt; }
                }
                return 'no_confirm_button';
            });
            log('INFO', `💵 [Profile=${pid}] 确认付款: ${confirmResult}`);
            await new Promise(r => setTimeout(r, 5000));
        } catch (confirmErr) {
            log('WARN', `⚠️ [Profile=${pid}] 确认付款异常: ${confirmErr.message}`);
        }

        // 🚀 检查结果
        const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
        const successKeywords = ['success', 'successful', 'completed', 'Payment Successful', '充值成功', '成功'];
        paymentSuccess = successKeywords.some(kw => pageText.toLowerCase().includes(kw.toLowerCase()));

        log(paymentSuccess ? 'SUCCESS' : 'WARN', `💵 [Profile=${pid}] 付款结果: ${paymentSuccess ? '✅ 成功' : '⚠️ 可能失败'}`);
        return res.json({
            success: paymentSuccess,
            amount: payAmount,
            adAccountId: actId,
            message: paymentSuccess ? `手动付款 $${payAmount} 成功` : '手动付款可能失败，请检查浏览器',
        });
    } catch (e) {
        log('ERROR', `❌ [Profile=${pid}] 手动付款异常: ${e.message}`);
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing/add' (original lines 2243-2913) =====
app.post('/api/facebook/billing/add', async (req, res) => {
    try {
        const { profileId, adAccountId, mode, card, method, channel, tag, currency, timezone_id,
                checkBillingParams, skipIfCardExists, country_code } = req.body || {};
        const pid = String(profileId || '');
        const actId = String(adAccountId || '').replace('act_', '');

        // 🚀 去重检查：优先用 API 确认卡是否真的在 Facebook 上存在（不依赖本地数据库）
        const last4 = (card?.number || method?.last4 || '').slice(-4);
        if (last4) {
            try {
                const billingResp = await fetch(`http://127.0.0.1:${PORT}/api/facebook/billing/cards`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                    body: JSON.stringify({ profileId: pid, adAccountId: actId })
                });
                const billingJson = await billingResp.json().catch(() => ({}));
                const existingMethods = billingJson.methods || billingJson.data || [];
                const alreadyOnFB = existingMethods.some((m) => (m.last4 || '').slice(-4) === last4);
                if (alreadyOnFB) {
                    log('WARN', `⚠️ [Profile=${pid}] 卡末四位 ${last4} 已在 Facebook 账号上存在，跳过`);
                    return res.json({ success: true, card: { last4, status: 'already_exists' }, message: '该卡已在 Facebook 上绑定，跳过' });
                }
            } catch (apiErr) {
                log('WARN', `⚠️ [Profile=${pid}] API 检查绑卡状态失败（回退到本地数据库检查）: ${apiErr.message}`);
                try {
                    const sdbCheck = new sqlite3.Database(dbPath);
                    const existing = await new Promise((resolve, reject) => {
                        sdbCheck.get(`SELECT id FROM billing_methods WHERE profile_id = ? AND account_id = ? AND last4 = ?`, [pid, actId, last4], (err, row) => { sdbCheck.close(); if (err) reject(err); else resolve(row); });
                    });
                    if (existing) {
                        log('WARN', `⚠️ [Profile=${pid}] 卡末四位 ${last4} 已存在于本地数据库，跳过`);
                        return res.json({ success: true, card: { last4, status: 'already_exists' }, message: '该卡已存在（本地），跳过' });
                    }
                } catch {}
            }
        }

        log('INFO', `💳 [Profile=${pid}] 收到信用卡绑定请求: mode=${mode}, actId=${actId}, checkBillingParams=${!!checkBillingParams}, skipIfCardExists=${!!skipIfCardExists}`);

        // 🚀 浏览器模拟绑卡：导航到 billing hub → 点击添加支付方式 → 填充表单 → 提交
        let apiResult = { success: false, message: '' };
        try {
            let browserData = activeBrowsers.get(pid);
            if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
                log('WARN', `⚠️ [Profile=${pid}] 浏览器未启动，尝试自动启动...`);
                const launchResult = await ensureBrowserIsRunning(pid, true);
                if (launchResult.success) {
                    await new Promise(r => setTimeout(r, 2000));
                    browserData = activeBrowsers.get(pid);
                }
            }

            if (browserData && browserData.browser && browserData.browser.isConnected()) {
                const browser = browserData.browser;
                // 🚀 绑卡始终在新标签页执行（同 browser 共享 Cookie，无需复制）
                let page = await browser.newPage();
                // 🚀 直接导航到 billing_hub
                await navigateToBillingHub(page, actId);
                await new Promise(r => setTimeout(r, 2000));

                // 🚀 国家/货币/时区检查（可选）：通过 FB Graph API 查询当前设置，不匹配则修改
                if (checkBillingParams && (country_code || currency || timezone_id)) {
                    try {
                        log('INFO', `💳 [Profile=${pid}] 通过 Graph API 查询广告账户当前国家/货币/时区...`);
                        const fbInfo = await page.evaluate(async (act) => {
                            try {
                                const r = await fetch(`https://graph.facebook.com/v21.0/act_${act}?fields=business_country_code,currency,timezone_name,timezone_offset_hours_utc`, { credentials: 'include' });
                                return await r.json();
                            } catch (e) { return { error: e.message }; }
                        }, actId);
                        if (fbInfo && !fbInfo.error && (fbInfo.business_country_code || fbInfo.currency)) {
                            const curCountry = (fbInfo.business_country_code || '').toUpperCase();
                            const curCurrency = (fbInfo.currency || '').toUpperCase();
                            const curTimezone = String(fbInfo.timezone_offset_hours_utc ?? '');
                            const expCountry = (country_code || '').toUpperCase();
                            const expCurrency = (currency || '').toUpperCase();
                            // 🚀 修复：期望时区直接比较偏移量（带符号），不去除负号
                            // FB 返回的 timezone_offset_hours_utc 是带符号的偏移量（如 "7", "-3", "5.5"）
                            const expTimezone = String(timezone_id || '').trim();
                            const match = (!expCountry || curCountry === expCountry) && (!expCurrency || curCurrency === expCurrency) && (!expTimezone || curTimezone === expTimezone);
                            log('INFO', `💳 [Profile=${pid}] 当前: ${curCountry}/${curCurrency}/${curTimezone} | 期望: ${expCountry}/${expCurrency}/${expTimezone} | ${match ? '✅ 已匹配' : '❌ 不匹配'}`);
                            if (!match) {
                                log('INFO', `💳 [Profile=${pid}] 国家/货币/时区不匹配，调用修改 API...`);
                                const changeResp = await fetch(`http://127.0.0.1:${PORT}/api/facebook/adaccounts/change-billing-country`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                                    body: JSON.stringify({ profileId: pid, adAccountId: actId, country: country_code, currency, timezone_id })
                                });
                                const changeJson = await changeResp.json().catch(() => ({}));
                                log('INFO', `💳 [Profile=${pid}] 修改结果: ${JSON.stringify(changeJson)}`);
                            }
                        } else {
                            log('WARN', `⚠️ [Profile=${pid}] Graph API 查询失败: ${JSON.stringify(fbInfo).substring(0,200)}，直接调 change-billing-country 兜底`);
                            await fetch(`http://127.0.0.1:${PORT}/api/facebook/adaccounts/change-billing-country`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                                body: JSON.stringify({ profileId: pid, adAccountId: actId, country: country_code, currency, timezone_id })
                            }).catch(() => {});
                        }
                    } catch (changeErr) {
                        log('WARN', `⚠️ [Profile=${pid}] 国家/货币/时区检查失败: ${changeErr.message}`);
                    }
                }

                // 🚀 卡片存在检查（可选）：通过 billing/cards API（FB API）查询，有卡则跳过绑卡
                if (skipIfCardExists) {
                    try {
                        log('INFO', `💳 [Profile=${pid}] 通过 billing/cards API 查询已有卡片...`);
                        const cardResp = await fetch(`http://127.0.0.1:${PORT}/api/facebook/billing/cards`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                            body: JSON.stringify({ profileId: pid, adAccountId: actId })
                        });
                        const cardJson = await cardResp.json().catch(() => ({}));
                        const methods = cardJson.methods || cardJson.data || [];
                        if (methods.length > 0) {
                            const msg = `billing/cards API: 已有 ${methods.length} 张卡片，跳过绑卡`;
                            log('INFO', `💳 [Profile=${pid}] ${msg}`);
                            await page.close().catch(() => {});
                            return res.json({ success: true, message: msg, cards: methods, skip: true });
                        }
                        log('INFO', `💳 [Profile=${pid}] billing/cards API: 无已有卡片，继续绑卡`);
                    } catch (cardErr) {
                        log('WARN', `⚠️ [Profile=${pid}] 卡片存在检查失败: ${cardErr.message}`);
                    }
                }

                if (mode === 'manual' && card?.number) {
                    const ccNumber = String(card.number).replace(/\s/g, '');
                    const last4 = ccNumber.slice(-4);
                    const billingStreet = String(card.billing_address || card.billing_street || '');
                    const billingCity = String(card.city || card.billing_city || '');
                    const billingZip = String(card.zip || card.billing_zip || '');
                    const expMonth = String(card.exp_month || '').padStart(2, '0');
                    const expYear = String(card.exp_year || '');
                    const cvv = String(card.cvv || '');

                    // 🚀 手动绑卡（点按钮 + 填表单）
                    log('INFO', `💳 尝试点击添加支付方式...`);

                    let payBtnClicked = false;
                    // 策略1: 使用 clickButtonByText 匹配多语言
                    payBtnClicked = await clickButtonByText(page, ['Add Payment Method', '添加支付方式', '新增付款方式', '新增支付方式', '添加新卡', '添加信用卡', '添加银行卡', '新增信用卡', '新增银行卡', 'Añadir método de pago', 'Agregar método de pago', 'Ajouter un moyen de paiement', 'Zahlungsmethode hinzufügen', 'add payment', 'Add', '添加', 'new', '+', 'Método de pago', 'método de pago']);
                    // 策略2: 兜底 - 找包含 payment/pay/add 关键词的按钮
                    if (!payBtnClicked) {
                        log('INFO', `💳 策略1未找到，尝试兜底策略...`);
                        try {
                            payBtnClicked = await page.evaluate(() => {
                                const keywords = ['payment', 'pay', 'paiement', 'pago', 'zahlung', 'add', 'new', 'create', '添加', '新增'];
                                // 🐛 修复：只找真正的按钮，加尺寸过滤
                                const btns = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
                                for (const b of btns) {
                                    const r = b.getBoundingClientRect();
                                    if (r.width < 40 || r.height < 20) continue;
                                    const t = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('href') || '')).toLowerCase();
                                    let score = 0;
                                    for (const kw of keywords) { if (t.includes(kw)) score++; }
                                    if (score >= 2 && b.offsetParent !== null) { try { b.click(); return true; } catch {} }
                                }
                                // 降级: 找第一个带 payment href 的链接
                                for (const b of btns) {
                                    const href = (b.getAttribute('href') || '').toLowerCase();
                                    if ((href.includes('payment') || href.includes('billing')) && b.offsetParent !== null) { try { b.click(); return true; } catch {} }
                                }
                                return false;
                            });
                        } catch {}
                    }
                    // 策略3: 直接通过 URL 添加 (如果按钮点击失败, 直接导航到添加卡页面)
                    if (!payBtnClicked) {
                        log('INFO', `💳 按钮未找到，尝试直接URL添加...`);
                        try {
                            // Meta 的绑卡弹窗可以通过直接点击 "Add" 链接实现
                            // 重新加载页面并等待更长时间
                            await page.goto(billingUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
                            await new Promise(r => setTimeout(r, 8000));
                            // 再试一次按钮
                            payBtnClicked = await clickButtonByText(page, ['Add Payment Method', '添加支付方式', '新增付款方式', '新增支付方式', '添加新卡', '添加信用卡', '添加银行卡', 'add payment', 'Add', '添加']);
                            if (!payBtnClicked) {
                                // 最终手段: 点击页面上任何蓝色的较大的按钮
                                try {
                                    payBtnClicked = await page.evaluate(() => {
                                        const all = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
                                        for (const b of all) {
                                            const cs = getComputedStyle(b);
                                            const bg = cs.backgroundColor || '';
                                            const w = parseInt(cs.width || '0');
                                            if ((bg.includes('rgb(24, 119, 242)') || bg.includes('#1877f2')) && w > 80) {
                                                try { b.click(); return true; } catch {}
                                            }
                                        }
                                        return false;
                                    });
                                } catch {}
                            }
                        } catch {}
                    }
                    log('INFO', `💳 点击添加支付方式: ${payBtnClicked ? '✅成功' : '❌失败'}`);
                    await new Promise(r => setTimeout(r, 4000));

                    // 🚀 处理国家/货币/时区弹窗（点击继续/下一步按钮）
                    // 用户反馈点添加支付后会弹出国家货币时区表单，需要找到并点击继续
                    try {
                        log('INFO', `💳 检查并处理国家/货币/时区弹窗...`);
                        await new Promise(r => setTimeout(r, 2000));
                        // Meta 的弹窗使用自定义 div combobox（不是原生 select），需要点击展开再选选项
                        let popupHandled = false;
                        // ⑤ Force 模式：先检测语言，只搜匹配的关键词
                        if (!popupHandled) {
                            try {
                                const kwResult = await page.evaluate(() => {
                                    // 检测页面语言
                                    const htmlLang = (document.documentElement.lang || 'en_US').toLowerCase();
                                    const isEnglish = htmlLang.startsWith('en');
                                    const isChinese = htmlLang.startsWith('zh');
                                    // 主关键词：根据语言选择
                                    const primaryKws = isChinese
                                        ? ['下一步', '继续', 'next', 'continue']
                                        : ['next', 'continue', 'proceed', '下一步', '继续'];
                                    // 兜底关键词（只有 primary 没找到时才用）
                                    const fallbackKws = isChinese
                                        ? ['确认', '提交', '开始', '保存', '完成', '知道了', '添加', '设置', 'setup', '设定', 'start', 'set up', 'get started', 'ok', 'got it', 'done']
                                        : ['confirm', 'submit', 'save', 'done', 'ok', 'got it', 'set up', 'start', 'setup', 'get started', 'add', 'create'];
                                    const all = document.querySelectorAll('button, a, div[role="button"], span[role="button"], [onclick]');

                                    // 第〇轮：暴力搜 primaryKws（精确/开头/包含都试，无长度限制）
                                    for (const kw of primaryKws) {
                                        for (const btn of all) {
                                            const txt = (btn.textContent || '').trim().toLowerCase();
                                            if (txt === kw || txt.startsWith(kw) || txt.includes(kw)) {
                                                try { btn.click(); return `优先:${kw}`; } catch(e) { try { btn.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return `优先★:${kw}`; } catch(e2) {} }
                                            }
                                        }
                                    }
                                    // 兜底：其他关键词组（只有 primary 全没找到时才走）
                                    for (const kw of fallbackKws) {
                                        for (const btn of all) {
                                            const txt = (btn.textContent || '').trim().toLowerCase();
                                            if (txt === kw || txt.startsWith(kw)) {
                                                if (txt.includes('cancel') || txt.includes('close') || txt.includes('x')) continue;
                                                try { btn.click(); return `精确:${kw}`; } catch(e) { try { btn.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return `精确★:${kw}`; } catch(e2) {} }
                                            }
                                        }
                                    }
                                    return '';
                                });
                                if (kwResult) {
                                    log('INFO', `💳 国家/货币/时区弹窗: Force暴力 ✅ 点击 "${kwResult}"`);
                                    popupHandled = true;
                                    await new Promise(r => setTimeout(r, 1500));
                                }
                            } catch (e) { log('WARN', `⚠️ Force暴力模式异常: ${e.message}`); }
                        }
                        for (let attempt = 0; attempt < 4; attempt++) {
                            // 🐛 如果弹窗已处理完毕，立即跳出循环
                            if (popupHandled) { log('INFO', `💳 弹窗已处理，跳出循环 (attempt=${attempt})`); break; }
                            // ① 处理自定义 combobox：点击展开 → 选选项
                            // 先点击展开所有相关 combobox
                            await page.evaluate(() => {
                                const selectors = document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]');
                                for (const s of selectors) {
                                    const label = (s.getAttribute('aria-label') || s.getAttribute('aria-labelledby') || s.textContent || '').toLowerCase();
                                    if (label.includes('country') || label.includes('país') || label.includes('currency') || label.includes('moneda') || label.includes('timezone') || label.includes('zona')) {
                                        s.click();
                                    }
                                }
                            });
                            await new Promise(r => setTimeout(r, 1500));
                            // 再选择已展开菜单中的选项
                            await page.evaluate(() => {
                                const menu = document.querySelector('[role="listbox"]:not([aria-hidden="true"]), [role="menu"]:not([aria-hidden="true"])');
                                if (!menu) return;
                                const opts = Array.from(menu.querySelectorAll('[role="option"], [role="menuitem"]'));
                                const txt = menu.textContent?.toLowerCase() || '';
                                let t = null;
                                if (txt.includes('country') || txt.includes('país') || txt.includes('estados')) t = opts.find(o => o.textContent?.includes('United States') || o.textContent?.includes('US') || o.textContent?.includes('EE.UU') || o.textContent?.includes('Estados Unidos'));
                                else if (txt.includes('currency') || txt.includes('moneda')) t = opts.find(o => o.textContent?.includes('USD') || o.textContent?.includes('Dólar'));
                                else if (txt.includes('timezone') || txt.includes('zona') || txt.includes('gmt')) t = opts.find(o => o.textContent?.includes('(GMT') || o.textContent?.includes('America/New') || o.textContent?.includes('Eastern') || o.textContent?.includes('-5'));
                                if (t) t.click();
                                else if (opts.length > 0) opts[0].click();
                            });
                            await new Promise(r => setTimeout(r, 2000));
                            // ② 尝试点继续/保存/下一步按钮
                            const clicked = await clickButtonByText(page, ['Save', 'Continue', 'Next', 'Done', 'Add', 'Save & Continue', 'Apply', 'Submit', 'Confirm', 'Got it', 'OK', '下一步', '继续', '保存', '确认', '提交', '完成', '知道了', '应用', 'Aceptar', 'Siguiente', 'Continuar', 'Guardar', 'Empezar', 'Add payment', 'Add card', 'Add Payment', 'Add Card', 'Pay', '支付', '添加', '新增', 'Set up', 'Get started', 'Start', 'Begin', 'Setup', 'Configure']);
                            if (clicked) { log('INFO', `💳 国家/货币/时区弹窗: 第${attempt+1}次 ✅ 点击继续`); popupHandled = true; await new Promise(r => setTimeout(r, 2000)); break; }
                            // ③ 降级：⭕ 页面中任意可见的蓝色/加粗/大按钮（不限弹窗内）
                            if (!clicked) {
                                try {
                                    const btnClicked = await page.evaluate(() => {
                                        const allBtns = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
                                        // 先找弹窗内的
                                        const dlg = document.querySelector('[role="dialog"], [role="alertdialog"], div[class*="modal"], div[class*="overlay"], div[class*="backdrop"]');
                                        const scope = dlg ? [dlg] : [document];
                                        for (const el of scope) {
                                            const btns = Array.from(el.querySelectorAll('button, div[role="button"], a[role="button"]'));
                                            for (const b of btns.reverse()) {
                                                if (b.offsetParent === null || b.disabled) continue;
                                                const cs = window.getComputedStyle(b);
                                                const txt = (b.textContent || '').trim().toLowerCase();
                                                if (txt.includes('cancel') || txt.includes('close') || txt.includes('x')) continue;
                                                if (cs.backgroundColor?.includes('rgb(24') || cs.fontWeight === '600' || cs.fontWeight === '700' || b.getBoundingClientRect().height > 30) {
                                                    b.scrollIntoView({ block: 'center' });
                                                    b.click();
                                                    return true;
                                                }
                                            }
                                        }
                                        return false;
                                    });
                                    await new Promise(r => setTimeout(r, 1000));
                                    if (btnClicked) { log('INFO', `💳 国家/货币/时区弹窗: 第${attempt+1}次 ✅ 降级点击`); popupHandled = true; await new Promise(r => setTimeout(r, 2000)); break; }
                                } catch {}
                            }
                            // ④ XPath 精准搜文本（兜底弹窗按钮在 Shadow DOM 或复杂嵌套中）
                            if (!popupHandled) {
                                try {
                                    const xpathClicked = await page.evaluate(() => {
                                        const keywords = ['next', 'continue', 'save', 'done', 'add', 'confirm', 'submit', 'apply', 'setup', 'start', 'begin', 'proceed', 'got it', 'ok'];
                                        for (const kw of keywords) {
                                            const xpath = `//*[text()[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${kw}')]]`;
                                            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                            const node = result.singleNodeValue;
                                            if (!node) continue;
                                            // 找到最近的可点击元素
                                            let target = node;
                                            while (target && target !== document.body) {
                                                const tag = (target.tagName || '').toLowerCase();
                                                const role = target.getAttribute('role') || '';
                                                if (tag === 'button' || role === 'button' || role === 'menuitem' || tag === 'a') {
                                                    if (target.offsetParent !== null && !target.disabled) {
                                                        target.scrollIntoView({ block: 'center' });
                                                        target.click();
                                                        return kw;
                                                    }
                                                }
                                                target = target.parentElement;
                                            }
                                            // 直接点击原节点
                                            if (node.offsetParent !== null && typeof node.click === 'function') {
                                                node.scrollIntoView({ block: 'center' });
                                                node.click();
                                                return kw + '(direct)';
                                            }
                                        }
                                        return '';
                                    });
                                    await new Promise(r => setTimeout(r, 1500));
                                    if (xpathClicked) { log('INFO', `💳 国家/货币/时区弹窗: XPath ✅ 点击 "${xpathClicked}"`); popupHandled = true; await new Promise(r => setTimeout(r, 2000)); break; }
                                } catch {}
                            }
                        }
                        // ④ 最终兜底：仍有弹窗则按 Escape
                        if (!popupHandled) {
                            try {
                                const hasModal = await page.evaluate(() => {
                                    return !!document.querySelector('[role="dialog"], [role="alertdialog"], div[class*="modal"]:not([aria-hidden="true"])');
                                });
                                if (hasModal) {
                                    log('WARN', `⚠️ 弹窗未关闭，尝试 Escape 关闭`);
                                    await page.keyboard.press('Escape');
                                    await new Promise(r => setTimeout(r, 2000));
                                }
                            } catch {}
                        }
                        log('INFO', `💳 国家/货币/时区弹窗处理完毕`);
                    } catch (e) { log('WARN', `⚠️ 国家/货币/时区弹窗处理异常: ${e.message}`); }

                    // 🚀 填充卡片信息表单
                    log('INFO', `💳 开始填充卡片信息...`);

                    // 🚀 等新的绑卡弹窗加载（关键！点击"添加支付方式"后可能有多层弹窗 + iframe）
                    await new Promise(r => setTimeout(r, 1500));
                    let iframeFound = false;
                    let formVisible = false;
                    for (let i = 0; i < 15; i++) {
                        // 🐛 修复：国家/货币弹窗在上面已处理完毕，这里只检测不点击任何按钮
                        // 避免误点卡号弹窗本身的按钮导致后续流程异常
                        const iframes = await page.$$('iframe').catch(() => []);
                        if (iframes.length > 0) { iframeFound = true; break; }
                        // 也检查是否有 dialog + input 或 shadow root
                        const { hasDlg, hasInputs, hasShadowInputs } = await page.evaluate(() => {
                            let hasDlg = false, hasInputs = false, hasShadowInputs = false;
                            const dlg = document.querySelector('[role="dialog"], [role="alertdialog"], div[class*="modal"], div[class*="overlay"], div[class*="dialog"]');
                            if (dlg) hasDlg = true;
                            const inputs = document.querySelectorAll('input:not([type="hidden"])');
                            if (inputs.length > 0) hasInputs = true;
                            // 🐛 修复：正确检测 Shadow DOM 中的输入框
                            try {
                                function findShadowInputs(root) {
                                    const all = root.querySelectorAll('*');
                                    for (const el of all) {
                                        if (el.shadowRoot) {
                                            const sInputs = el.shadowRoot.querySelectorAll('input:not([type="hidden"])');
                                            if (sInputs.length > 0) { hasShadowInputs = true; return true; }
                                            if (findShadowInputs(el.shadowRoot)) return true;
                                        }
                                    }
                                    return false;
                                }
                                findShadowInputs(document);
                            } catch {}
                            return { hasDlg, hasInputs, hasShadowInputs };
                        }).catch(() => ({ hasDlg: false, hasInputs: false, hasShadowInputs: false }));
                        if ((hasDlg && hasInputs) || hasShadowInputs) { formVisible = true; break; }
                        // 每 4 秒打印一次状态
                        if (i % 4 === 3) {
                            try {
                                const url = await page.evaluate(() => window.location.href).catch(() => '');
                                log('INFO', `💳 等待弹窗... (第${i+1}秒, url=${url.substring(0, 50)})`);
                            } catch {}
                        }
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    log('INFO', `💳 弹窗检测: iframe=${iframeFound}, form=${formVisible}`);

                    // 诊断表单结构
                    try {
                        const formInfo = await page.evaluate(() => {
                            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), [role="textbox"], [contenteditable="true"]'));
                            return inputs.map(el => ({
                                tag: el.tagName,
                                id: el.id,
                                name: el.getAttribute('name'),
                                placeholder: el.getAttribute('placeholder'),
                                'aria-label': el.getAttribute('aria-label'),
                                type: el.getAttribute('type'),
                                visible: el.offsetParent !== null,
                                rect: el.getBoundingClientRect ? `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}` : ''
                            })).filter(i => i.visible);
                        });
                        log('INFO', `💳 表单字段: ${JSON.stringify(formInfo)}`);
                    } catch {}

                    await fillCardForm(page, { number: ccNumber, expMonth, expYear, cvv, holderName: String(card.holder_name||''), billingStreet, billingCity, billingState: String(card.billing_state||''), billingZip });
                    await fillIframeCardFields(page, ccNumber, expMonth, expYear, cvv);

                    // 🚀 增强填充：直接暴力找所有可见输入框按位置填入
                    try {
                        const fillResult = await page.evaluate(({ cn, em, ey, cv }) => {
                            const logs = [];
                            // 递归搜集所有 input（含 Shadow DOM）
                            function collectInputs(root, depth = 0) {
                                if (depth > 10) return [];
                                const result = [];
                                const inputs = root.querySelectorAll('input:not([type="hidden"])');
                                inputs.forEach(inp => { if (inp.offsetParent !== null || inp.getBoundingClientRect().width > 0) result.push(inp); });
                                const all = root.querySelectorAll('*');
                                for (const el of all) {
                                    if (el.shadowRoot) result.push(...collectInputs(el.shadowRoot, depth + 1));
                                }
                                return result;
                            }
                            const allInputs = collectInputs(document);
                            logs.push(`总计找到 ${allInputs.length} 个可见输入框`);
                            if (allInputs.length === 0) return logs.join('|');
                            // 按位置排序（从上到下）
                            allInputs.sort((a, b) => {
                                const ra = a.getBoundingClientRect();
                                const rb = b.getBoundingClientRect();
                                return (ra.y || 0) - (rb.y || 0) || (ra.x || 0) - (rb.x || 0);
                            });
                            // 对每个 input 尝试填入
                            let filled = 0;
                            for (let i = 0; i < allInputs.length; i++) {
                                const inp = allInputs[i];
                                const key = `${inp.id} ${inp.getAttribute('name')||''} ${inp.getAttribute('placeholder')||''} ${inp.getAttribute('aria-label')||''}`.toLowerCase();
                                const val = inp.value || '';
                                let text = '';
                                // 判断字段类型
                                const isNameField = key.includes('holder')||key.includes('name')||key.includes('nombre')||key.includes('持卡人')||key.includes('姓名')||key.includes('first')||key.includes('last')||key.includes('full');
                                const isCardField = (key.includes('number')||key.includes('cardnum')||key.includes('card')||key.includes('卡号')||key.includes('credit')) && !key.includes('sec')&&!key.includes('cvv')&&!key.includes('cvc');
                                const isExpField = key.includes('exp')||key.includes('month')||key.includes('year')||key.includes('有效期')||key.includes('mm')||key.includes('yy')||key.includes('月')||key.includes('年');
                                const isCvvField = key.includes('cvv')||key.includes('cvc')||key.includes('sec')||key.includes('安全')||key.includes('验证')||key.includes('código');
                                // 已知字段类型：强制覆盖（不管是否有已有值）
                                if (isNameField) text = 'Test User';
                                else if (isCardField) text = cn;
                                else if (isExpField) text = `${em.padStart(2,'0')}/${ey.slice(-2)}`;
                                else if (isCvvField) text = cv;
                                // 未知字段但已有值：跳过
                                else if (val && val.length > 2) { logs.push(`[${i}]已有值跳过:${val.substring(0,4)}`); continue; }
                                // 未知字段按位置推断
                                else if (filled === 0 && i === 0) text = cn;
                                else if (filled === 1 && i === 1) text = `${em.padStart(2,'0')}/${ey.slice(-2)}`;
                                else if (filled === 2 && i === 2) text = cv;
                                else continue;
                                if (text) {
                                    try {
                                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                                        nativeInputValueSetter.call(inp, text);
                                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                                        inp.dispatchEvent(new Event('blur', { bubbles: true }));
                                        filled++;
                                        logs.push(`[${i}]填入:${text.substring(0,4)}... (${key.substring(0,30)})`);
                                    } catch(e2) { logs.push(`[${i}]失败:${e2.message}`); }
                                }
                            }
                            logs.push(`填充完成:${filled}/${allInputs.length}`);
                            return logs.join('|');
                        }, { cn: ccNumber, em: expMonth, ey: expYear, cv: cvv });
                        log('INFO', `💳 增强填充: ${fillResult}`);
                    } catch (e) { log('WARN', `💳 增强填充异常: ${e.message}`); }

                    // 🐛 修复: 填完卡号后等 1 秒让按钮激活
                    await new Promise(r => setTimeout(r, 1000));

                    // 🐛 修复: 用 XPath 直接找文本匹配的按钮（支持 Shadow DOM）
                    let submitClicked = false;
                    const submitPatterns = [
                        'Save', 'Add', 'Submit', 'Confirm', 'Done',
                        '保存', '添加', '提交', '确认', '完成',
                        '继续付款', '确认添加', '添加银行卡', '添加信用卡',
                        '同意并开通', '立即开通',
                        'Agregar', 'Guardar', 'Aceptar', 'Listo', 'Continuar', 'Confirmar'
                    ];
                    // 🐛 XPath 搜索 + Shadow DOM 搜索
                    for (const pattern of submitPatterns) {
                        try {
                            // 主 DOM 的 XPath
                            const xpath = `//*[text()[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${pattern.toLowerCase()}')]]`;
                            const [btn] = await page.$x(xpath);
                            if (btn) {
                                const visible = await page.evaluate(el => {
                                    if (!el.offsetParent) return false;
                                    const r = el.getBoundingClientRect();
                                    return r.width > 30 && r.height > 15;
                                }, btn).catch(() => false);
                                if (visible) {
                                    await btn.click();
                                    log('INFO', `💳 提交绑卡(XPath): "${pattern}" ✅`);
                                    submitClicked = true;
                                    break;
                                }
                            }
                        } catch {}
                        // 🐛 如果 XPath 没找到，搜索 Shadow DOM
                        if (!submitClicked) {
                            try {
                                submitClicked = await page.evaluate((p) => {
                                    function collectBtns(root, result = []) {
                                        const btns = root.querySelectorAll('button, div[role="button"], a[role="button"], input[type="submit"], [type="submit"]');
                                        btns.forEach(b => {
                                            const txt = ((b.textContent||'') + ' ' + (b.getAttribute('aria-label')||'') + ' ' + (b.value||'')).toLowerCase();
                                            const r = b.getBoundingClientRect();
                                            if (txt.includes(p.toLowerCase()) && b.offsetParent !== null && r.width > 30 && r.height > 15) {
                                                result.push(b);
                                            }
                                        });
                                        const all = root.querySelectorAll('*');
                                        for (const el of all) {
                                            if (el.shadowRoot) collectBtns(el.shadowRoot, result);
                                        }
                                        return result;
                                    }
                                    const found = collectBtns(document);
                                    if (found.length > 0) {
                                        found[0].click();
                                        return true;
                                    }
                                    return false;
                                }, pattern);
                                if (submitClicked) { log('INFO', `💳 提交绑卡(Shadow DOM): "${pattern}" ✅`); break; }
                            } catch {}
                        }
                    }

                    // 兜底：可搜索多语言提交按钮列表
                    if (!submitClicked) {
                        try {
                            const fallbackClicked = await page.evaluate(() => {
                                // 🐛 修复：Shadow DOM 递归搜索按钮
                                function collectBtns(root, result = []) {
                                    const btns = root.querySelectorAll('button, div[role="button"], a[role="button"], input[type="submit"], [type="submit"]');
                                    btns.forEach(b => result.push({ el: b, origin: root === document ? 'main' : 'shadow' }));
                                    const all = root.querySelectorAll('*');
                                    for (const el of all) {
                                        if (el.shadowRoot) collectBtns(el.shadowRoot, result);
                                    }
                                    return result;
                                }
                                const allButtons = collectBtns(document);
                                // 兜底1：找任何 form 内的提交/保存按钮（按文本匹配）
                                const submitKeywords = ['add','save','submit','confirm','continue','pay','done','添加','提交','保存','确认','继续','付款','下一步','完成','agregar','guardar','aceptar','listo','continuar','confimar'];
                                const forms = document.querySelectorAll('form');
                                for (const f of forms) {
                                    const btns = f.querySelectorAll('button, div[role="button"], a[role="button"]');
                                    for (const b of btns) {
                                        const txt = (b.textContent || '').toLowerCase().trim();
                                        const label = (b.getAttribute('aria-label') || '').toLowerCase();
                                        const combined = txt + ' ' + label;
                                        if (submitKeywords.some(k => combined.includes(k)) && b.offsetParent !== null) {
                                            b.click(); return 'found_in_form';
                                        }
                                    }
                                }
                                // 🐛 兜底1.5: 搜索全部（含 Shadow DOM）按钮，匹配关键词
                                for (const bEntry of allButtons) {
                                    const b = bEntry.el;
                                    const txt = (b.textContent || '').toLowerCase().trim();
                                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                                    const val = (b.value || '').toLowerCase();
                                    const combined = txt + ' ' + label + ' ' + val;
                                    if (submitKeywords.some(k => combined.includes(k)) && b.offsetParent !== null) {
                                        try { b.click(); return 'found_in_shadow'; } catch {}
                                    }
                                }
                                // 兜底2：在弹窗中找底部的大按钮（通常是保存/添加）
                                const dlg = document.querySelector('[role="dialog"]');
                                if (dlg) {
                                    const btns = Array.from(dlg.querySelectorAll('button, div[role="button"]'));
                                    const bottomBtns = btns.filter(b => {
                                        const r = b.getBoundingClientRect();
                                        return r.top > window.innerHeight * 0.5 && r.width > 80 && r.height > 30 && b.offsetParent !== null;
                                    });
                                    // 取弹窗中靠下最宽的按钮（通常是主操作按钮）
                                    if (bottomBtns.length > 0) {
                                        bottomBtns.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
                                        bottomBtns[0].click(); return 'found_in_dialog';
                                    }
                                }
                                // 兜底3：找整个页面底部最大的按钮
                                const all = Array.from(document.querySelectorAll('button:not([aria-hidden="true"])'));
                                const candidates = all.filter(b => {
                                    const r = b.getBoundingClientRect();
                                    return r.width > 80 && r.height > 30 && r.top > window.innerHeight * 0.3 && b.offsetParent !== null;
                                });
                                if (candidates.length > 0) {
                                    candidates.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
                                    candidates[0].click(); return 'found_fallback';
                                }
                                return 'not_found';
                            });
                            log('INFO', `💳 提交绑卡: 兜底结果=${fallbackClicked}`);
                        } catch(e) { log('WARN', `💳 提交绑卡: 兜底异常=${e.message}`); }
                    } else { log('INFO', `💳 提交绑卡: 已点击提交`); }

                    // 🚀 等待绑卡确认：等待提交完成，确认卡已添加
                    await new Promise(r => setTimeout(r, 5000));
                    let cardConfirmed = false;
                    try {
                        const confirmCheck = await page.evaluate(() => {
                            const body = document.body.textContent || '';
                            // 检查是否出现成功/确认或卡出现在列表中
                            if (body.includes('Success') || body.includes('success') || body.includes('successfully') ||
                                body.includes('añadido') || body.includes('agregado') ||
                                body.includes('Added') || body.includes('added') ||
                                body.includes('成功') || body.includes('已添加') || body.includes('已完成')) return 'success_text';
                            // 检查弹窗是否关闭了（dialog 消失）
                            if (!document.querySelector('[role="dialog"]')) return 'dialog_closed';
                            return 'pending';
                        });
                        log('INFO', `💳 绑卡确认检查: ${confirmCheck}`);
                        if (confirmCheck !== 'pending') cardConfirmed = true;
                    } catch {}
                    if (!cardConfirmed) {
                        log('WARN', `⚠️ 绑卡后未检测到明确确认，额外等待 8 秒...`);
                        await new Promise(r => setTimeout(r, 8000));
                        try {
                            const c2 = await page.evaluate(() => !document.querySelector('[role="dialog"]'));
                            if (c2) cardConfirmed = true;
                        } catch {}
                    }
                    log('INFO', `💳 绑卡确认: ${cardConfirmed ? '✅ 确认' : '⚠️ 不确定'}`);

                    apiResult = { success: cardConfirmed, message: cardConfirmed ? '绑卡流程已执行完毕' : '绑卡可能未完成' };
                } else { apiResult.message = '非手动模式或缺少卡号'; }
            } else { apiResult.message = '浏览器未启动'; }
        } catch (browserError) { log('WARN', `⚠️ 绑卡自动化异常: ${browserError.message}`); apiResult.message = '绑卡自动化异常'; }
        return res.json({ success: apiResult.success !== false, apiResult, message: apiResult.message });
    } catch (e) { log('ERROR', `💳 绑卡失败: ${e.message}`); return res.status(500).json({ success: false, message: String(e.message) }); }
});


// ===== post '/api/facebook/billing/verify-click' (original lines 2919-3160) =====
app.post('/api/facebook/billing/verify-click', async (req, res) => {
    try {
        const { profileId } = req.body || {};
        const browserData = activeBrowsers.get(String(profileId || ''));
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: false, status: 'no_browser' });
        }
        const browser = browserData.browser;
        const pages = await browser.pages();
        if (!pages || !pages.length) return res.json({ success: false, status: 'no_pages' });
        let clicked = false; let source = '';
        const tryClickOnPage = async (page) => {
            try { await page.bringToFront(); } catch {}
            try { await new Promise(r => setTimeout(r, )); } catch {}
            for (let i = 0; i < 16 && !clicked; i++) {
                try { await new Promise(r => setTimeout(r, )); } catch {}
                // 清理常见遮挡
                try { await page.evaluate(() => { const hideByText = (t) => Array.from(document.querySelectorAll('*')).filter(el => (el.textContent||'').includes(t)); hideByText('Google Translate').forEach(el => { try { el.style.setProperty('display','none','important'); } catch(_){} }); }); } catch {}
                // CTA或弹窗
                try {
                    const info = await page.evaluate(() => {
                        const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                        const modal = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                        const scope = modal || document;
                        const btns = Array.from(scope.querySelectorAll('button, div[role="button"], a[role="button"], [aria-label]'));
                        const eq = ['verify','verifier','verificar','verifica'];
                        let t = btns.find(b => eq.includes(norm(b.textContent)));
                        if (!t) t = btns.find(b => /verify payment method|verifier payment method|verify card|verifier la carte|verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.textContent)));
                        if (!t) t = btns.find(b => /verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.getAttribute('aria-label'))));
                        if (t) { try { t.scrollIntoView({ block:'center' }); } catch(_){ } t.click(); return { clicked: true, source: modal ? 'modal' : 'cta' }; }
                        return { clicked: false, source: '' };
                    });
                    if (info && info.clicked) { clicked = true; source = info.source || source; }
                } catch {}
                if (!clicked) {
                    try {
                        const els = await page.$$('button, div[role="button"], a[role="button"], [aria-label]');
                        for (const el of els) {
                            try {
                                const txt = (await page.evaluate(e => (e.textContent||'').trim(), el)) || '';
                                const aria = (await page.evaluate(e => e.getAttribute('aria-label') || '', el)) || '';
                                const t = `${txt}\n${aria}`.toLowerCase();
                                if (/\bverify\b/.test(t) || /验证|确认/.test(t)) {
                                    try { await el.scrollIntoViewIfNeeded(); } catch(_){}
                                    try { await el.click({ delay: 10 }); clicked = true; source = source || 'handle.click'; break; } catch(_){}
                                }
                            } catch {}
                        }
                    } catch {}
                }
                if (clicked) break;
                // 真实鼠标兜底
                try {
                    const handle = await page.evaluateHandle(() => {
                        const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                        const modal = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                        const scope = modal || document;
                        const btns = Array.from(scope.querySelectorAll('button, div[role="button"], a[role="button"], [aria-label]'));
                        const eq = ['verify','verifier','verificar','verifica'];
                        let t = btns.find(b => eq.includes(norm(b.textContent)));
                        if (!t) t = btns.find(b => /verify payment method|verifier payment method|verify card|verifier la carte|verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.textContent)));
                        if (!t) t = btns.find(b => /verify|verifier|verificar|verifica|验证|确认/i.test(norm(b.getAttribute('aria-label'))));
                        if (!t) {
                            const cand = btns.find(b => {
                                const cs = getComputedStyle(b);
                                const bg = (cs.backgroundColor || '').toLowerCase();
                                const bd = (cs.borderColor || '').toLowerCase();
                                return /rgb\(24,\s*119,\s*242\)/i.test(bg) || /rgb\(24,\s*119,\s*242\)/i.test(bd);
                            });
                            t = cand || t;
                        }
                        if (t) { try { t.scrollIntoView({ block:'center' }); } catch(_){} }
                        return t || null;
                    });
                    if (handle && handle.asElement()) {
                        try {
                            await page.evaluate(el => {
                                try { el.removeAttribute('disabled'); } catch(_){}
                                const ev = (n, opts={}) => { try { el.dispatchEvent(new MouseEvent(n, { bubbles:true, cancelable:true, composed:true, ...opts })); } catch(_){} };
                                ev('pointerdown'); ev('mousedown'); ev('pointerup'); ev('mouseup'); ev('click');
                            }, handle);
                            clicked = true; source = source || 'dispatch';
                        } catch {}
                        if (!clicked) {
                            const box = await handle.boundingBox();
                            if (box) {
                                await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                await page.mouse.down();
                                await new Promise(r => setTimeout(r, ));
                                await page.mouse.up();
                                clicked = true; source = source || 'mouse';
                            }
                        }
                        try { await handle.dispose(); } catch {}
                    }
                } catch {}
                if (!clicked) {
                    // 对话框右下角坐标兜底
                    try {
                        const rect = await page.evaluate(() => {
                            const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                            if (!dlg) return null;
                            const r = dlg.getBoundingClientRect();
                            return { left: r.left, top: r.top, width: r.width, height: r.height };
                        });
                        if (rect && rect.width && rect.height) {
                            const x = rect.left + rect.width - 60;
                            const y = rect.top + rect.height - 40;
                            await page.mouse.move(x, y);
                            await page.mouse.down();
                            await new Promise(r => setTimeout(r, ));
                            await page.mouse.up();
                            try { await page.mouse.click(x, y, { clickCount: 2, delay: 20 }); } catch {}
                            clicked = true; source = source || 'corner';
                        }
                    } catch {}
                }
                if (!clicked) {
                    try {
                        const ok = await page.evaluate(() => {
                            const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                            if (!dlg) return false;
                            const dr = dlg.getBoundingClientRect();
                            const inside = (r) => r.left >= dr.left && r.right <= dr.right && r.top >= dr.top && r.bottom <= dr.bottom;
                            const list = Array.from(document.querySelectorAll('*')).filter(el => {
                                const r = el.getBoundingClientRect();
                                if (!r || r.width < 60 || r.height < 32) return false;
                                if (!inside(r)) return false;
                                const cs = getComputedStyle(el);
                                const bg = (cs.backgroundColor || '').toLowerCase();
                                const color = (cs.color || '').toLowerCase();
                                const txt = (el.textContent || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                                const isBlue = /rgb\(24,\s*119,\s*242\)/i.test(bg) || /rgb\(24,\s*119,\s*242\)/i.test(color);
                                const hasTxt = /\bverify\b|\bverifier\b|\bverificar\b|\bverifica\b/.test(txt) || /验证|确认/.test(txt);
                                return isBlue || hasTxt;
                            });
                            const t = list[0];
                            if (t) { try { t.scrollIntoView({ block:'center' }); } catch(_){} ; try { t.click(); return true; } catch(_){} }
                            return false;
                        });
                        if (ok) { clicked = true; source = source || 'modal-scan'; }
                    } catch {}
                }
                if (!clicked) {
                    // 键盘遍历触发
                    try {
                        for (let k = 0; k < 6; k++) { await page.keyboard.press('Tab'); await new Promise(r => setTimeout(r, )); }
                        await page.keyboard.press('Enter');
                    } catch {}
                }
                if (clicked) break;
                // iframe向导
                try {
                    const frames = page.frames();
                    for (const f of frames) {
                        try {
                            const u = String(f.url() || '');
                            if (/payments\.facebook\.com\/business_payments\/wizard|business_payments\/verification/i.test(u)) {
                                const marked = await f.evaluate(() => {
                                    const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                                    const btns = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], [aria-label]'));
                                    let t = btns.find(b => /verify|verifier|verificar|verifica|continue|下一步|继续|确认/i.test(norm(b.textContent)));
                                    if (!t) t = btns.find(b => /verify|verifier|verificar|verifica|continue|下一步|继续|确认/i.test(norm(b.getAttribute('aria-label'))));
                                    if (t) { try { t.setAttribute('data-auto-click-target','1'); t.scrollIntoView({ block:'center' }); } catch(_){}; return true; }
                                    return false;
                                });
                                if (marked) {
                                    const h = await f.$('[data-auto-click-target="1"]');
                                    if (h) {
                                        const box = await h.boundingBox();
                                        if (box) {
                                            await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                            await page.mouse.down();
                                            await new Promise(r => setTimeout(r, ));
                                            await page.mouse.up();
                                            clicked = true; source = source || 'iframe'; break;
                                        }
                                    }
                                }
                            }
                        } catch {}
                    }
                } catch {}
                if (!clicked) {
                    // 页面顶部CTA“Verify payment method”兜底
                    try {
                        const h2 = await page.evaluateHandle(() => {
                            const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
                            const cand = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], [aria-label]')).find(b => /verify payment method|verifier payment method|验证付款方式|验证支付方式/i.test(norm(b.textContent)) || /verify payment method|verifier payment method|验证|确认/i.test(norm(b.getAttribute('aria-label'))));
                            if (cand) { try { cand.setAttribute('data-auto-click-target','1'); cand.scrollIntoView({ block:'center' }); } catch(_){} }
                            return cand || null;
                        });
                        if (h2 && h2.asElement()) {
                            const box = await h2.boundingBox();
                            if (box) {
                                await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                await page.mouse.down();
                                await new Promise(r => setTimeout(r, ));
                                await page.mouse.up();
                                clicked = true; source = source || 'cta-top';
                            }
                            try { await h2.dispose(); } catch {}
                        }
                    } catch {}
                }
            }
        };
        for (const p of pages) {
            try {
                const u = String(p.url() || '');
                const isBilling = /business\.facebook\.com\/billing_hub\/payment_settings|adsmanager\.facebook\.com\/adsmanager\/manage\/billing/i.test(u);
                await tryClickOnPage(p);
                if (clicked) break;
                if (!isBilling) {
                    // 非账单页也尝试一次（弹窗可能在其他页面）
                    await tryClickOnPage(p);
                    if (clicked) break;
                }
            } catch {}
        }
        if (!clicked) {
            try {
                const ok = await pages[0].evaluate(() => {
                    const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal');
                    if (!dlg) return false;
                    const r = dlg.getBoundingClientRect();
                    const el = document.elementFromPoint(Math.floor(r.right - 40), Math.floor(r.bottom - 30));
                    if (el && typeof el.click === 'function') { try { el.click(); return true; } catch(_){} }
                    return false;
                });
                if (ok) clicked = true; source = source || 'elementFromPoint';
            } catch {}
        }
        // 不再进行“直接导航向导页”的兜底，严格模拟人工点击保持在当前页面
        if (clicked) {
            try { await Promise.race([ page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(()=>{}), new Promise(r => setTimeout(r, 1000)) ]); } catch {}
        }
        return res.json({ success: !!clicked, source: String(source||'') });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing/otp/auto-fill' (original lines 3162-3202) =====
app.post('/api/facebook/billing/otp/auto-fill', async (req, res) => {
    try {
        const { profileId, adAccountId, last4, code } = req.body || {};
        const pid = String(profileId || '');
        const aid = String(adAccountId || '');
        const l4 = String(last4 || '').slice(-4);
        const browserData = activeBrowsers.get(pid);
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: false, status: 'no_browser' });
        }
        const debugPort = browserData.debugPort;
        let otp = String(code || '');
        if (!otp) {
            try {
                const http = require('http');
                const qs = encodeURI(`last4=${l4}${pid?`&profileId=${pid}`:''}${aid?`&accountId=${aid}`:''}`);
                const data = await new Promise((resolve, reject) => {
                const reqOpt = { hostname: 'localhost', port: 7070, path: `/api/verification-codes/latest?${qs}`, method: 'GET' };
                    const r = http.request(reqOpt, (resp) => { let raw=''; resp.on('data',d=>raw+=d); resp.on('end',()=>{ try { resolve(JSON.parse(raw)); } catch(e){ reject(e) } }); });
                    r.on('error', reject); r.end();
                });
                if (data && data.success && data.data && data.data.code) { otp = String(data.data.code); }
            } catch {}
        }
        if (!otp) return res.json({ success: false, status: 'missing_code' });
        const http = require('http');
        const payload = JSON.stringify({
            expression: `(() => { const sel = [ 'input[autocomplete=one-time-code]', 'input[name*=code i]', 'input[id*=code i]', 'input[placeholder*=code i]', 'input[aria-label*=code i]', 'input[aria-label*=验证码 i]' ]; let input = null; for (const s of sel) { try { const el = document.querySelector(s); if (el) { input = el; break; } } catch {} } if (!input) { const ins = Array.from(document.querySelectorAll('input')); input = ins.find(i => { const t = (i.getAttribute('name')||i.id||i.placeholder||'').toLowerCase(); return t.includes('code') || t.includes('otp') || t.includes('验证码'); }) || null; } if (input) { try { input.focus(); input.value = '${otp.replace(/'/g,"\\'")}'; const ev = new Event('input',{bubbles:true}); input.dispatchEvent(ev); } catch {} } const btns = Array.from(document.querySelectorAll('button, [role=button], a')); const btn = btns.find(b => /验证|确认|继续|提交|verify|continue|next/i.test((b.textContent||'').trim())) || null; if (btn) { try { btn.click(); } catch {} } return input ? 'filled' : 'not_found'; })()`,
            awaitPromise: false,
            returnByValue: true,
            targetUrlContains: 'payments.facebook.com/business_payments/wizard',
            targetType: 'iframe'
        });
        const opt = { hostname: 'localhost', port: PORT, path: `/api/devtools/${debugPort}/runtime/evaluate`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
        const result = await new Promise((resolve, reject) => { const rq = http.request(opt, (resp)=>{ let raw=''; resp.on('data',d=>raw+=d); resp.on('end',()=>{ try { resolve(JSON.parse(raw)); } catch(e){ reject(e) } }); }); rq.on('error', reject); rq.write(payload); rq.end(); });
        const ok = !!(result && result.success);
        return res.json({ success: ok, status: ok ? 'ok' : 'failed' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing/list-methods' (original lines 3204-3313) =====
app.post('/api/facebook/billing/list-methods', async (req, res) => {
    try {
        const { profileId, adAccountId, url } = req.body || {};
        const bd = activeBrowsers.get(String(profileId || ''));
        if (!bd || !bd.browser || !bd.browser.isConnected()) {
            return res.json({ success: false, status: 'no_browser' });
        }
        const page = await bd.browser.newPage();
        let targetUrl = String(url || '');
        if (!targetUrl) {
            targetUrl = 'https://business.facebook.com/adsmanager/billing';
            try {
                const acc = String(adAccountId || '').trim();
                if (acc) {
                    const actId = acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc);
                    targetUrl = `https://business.facebook.com/adsmanager/manage/billing?act=${encodeURIComponent(actId)}`;
                }
            } catch {}
        }
        try { await page.setDefaultTimeout(60000); } catch {}
        try { await page.setDefaultNavigationTimeout(60000); } catch {}
        try {
            const conn = await mainDbPool.getConnection();
            const row = await new Promise((resolve) => {
                conn.get(`SELECT account_cookies FROM profiles WHERE id = ?`, [String(profileId || '')], (err, r) => resolve(err ? null : r));
            });
            mainDbPool.releaseConnection(conn);
            if (row && row.account_cookies) {
                let cookies = null;
                try { cookies = JSON.parse(row.account_cookies); } catch { cookies = null; }
                if (Array.isArray(cookies) && cookies.length > 0) {
                    for (const ck of cookies) {
                        try {
                            const host = 'business.facebook.com';
                            let domain = ck.domain || host;
                            if (/facebook\.com$/i.test(domain)) domain = '.facebook.com';
                            await page.setCookie({
                                name: ck.name,
                                value: ck.value,
                                domain,
                                path: ck.path || '/',
                                secure: ck.secure !== undefined ? ck.secure : true,
                                httpOnly: !!ck.httpOnly,
                                sameSite: ck.sameSite || 'None',
                                // ⏳ 一律续期到 +100 年：会话级（无 expirationDate）会被浏览器退出时丢弃，
                                //    已过期的会被 Chrome 静默丢弃 —— 两者都不能沿用原始值
                                expires: Math.floor(Date.now() / 1000) + 36500 * 24 * 60 * 60
                            });
                        } catch {}
                    }
                }
            }
        } catch {}
        try { await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 }); } catch {}
        try {
            const needLogin = await page.evaluate(() => {
                const u = location.href || '';
                const hasPwd = !!document.querySelector('input[type="password"], input[name*="pass" i], input[id*="pass" i]');
                const hasEmail = !!document.querySelector('input[name="email"], input[type="email"]');
                return /login|signin|accounts\.facebook/i.test(u) || (hasPwd && hasEmail);
            });
            if (needLogin) { try { await page.close(); } catch {} ; return res.json({ success: false, status: 'not_logged_in' }); }
        } catch {}
        let methods = [];
        try {
            try { await new Promise(r => setTimeout(r, )); } catch {}
            try { await page.waitForSelector('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod', { timeout: 15000 }); } catch {}
            methods = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                const norm = s => String(s||'').toLowerCase();
                const parseBrand = t => (/visa/i.test(t) ? 'Visa' : (/master/i.test(t) ? 'Mastercard' : (/amex/i.test(t) ? 'Amex' : (/debit/i.test(t) ? 'Debit' : ''))));
                return items.map(el => {
                    const t = el.textContent || '';
                    const last4 = (t.match(/\d{4}/) || [])[0] || '';
                    const brand = parseBrand(t);
                    const verified = /已验证|verified/i.test(t);
                    const need_verify = /验证|verify/i.test(t) && !verified;
                    return { text: t.trim(), last4, brand, verified, need_verify };
                });
            });
            if (!methods || !methods.length) {
                const acc = String(adAccountId || '').trim();
                const actId = acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc);
                const hub = buildBillingHubUrl(acc);
                try { await page.goto(hub, { waitUntil: 'networkidle2', timeout: 25000 }); } catch {}
                try { await new Promise(r => setTimeout(r, )); } catch {}
                try {
                    methods = await page.evaluate(() => {
                        const nodes = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod, div'));
                        const parseBrand = t => (/visa/i.test(t) ? 'Visa' : (/master/i.test(t) ? 'Mastercard' : (/amex/i.test(t) ? 'Amex' : (/debit/i.test(t) ? 'Debit' : ''))));
                        const out = [];
                        for (const el of nodes) {
                            const t = (el.textContent || '').trim();
                            if (!t) continue;
                            if (!/visa|master|amex|debit|信用卡/i.test(t)) continue;
                            const last4 = (t.match(/\d{4}/) || [])[0] || '';
                            const brand = parseBrand(t);
                            const verified = /已验证|verified/i.test(t);
                            const need_verify = /验证|verify/i.test(t) && !verified;
                            out.push({ text: t, last4, brand, verified, need_verify });
                        }
                        return out;
                    });
                } catch {}
            }
        } catch {}
        try { await page.close(); } catch {}
        return res.json({ success: Array.isArray(methods), count: Array.isArray(methods) ? methods.length : 0, methods: Array.isArray(methods) ? methods : [] });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing' (original lines 3315-3323) =====
app.post('/api/facebook/billing', async (req, res) => {
    try {
        const { profileId, adAccountId, url } = req.body || {};
        req.body = { profileId, adAccountId, url };
        return app._router.handle({ ...req, method: 'POST', url: '/api/facebook/billing/list-methods' }, res, () => {});
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing/verify-fill' (original lines 3326-3718) =====
app.post('/api/facebook/billing/verify-fill', async (req, res) => {
    try {
        const { profileId, code, token: extTokenRaw, baseUrl: extBaseRaw } = req.body || {};
        const dbg = [];
        const addLog = (m) => { try { console.log(`[verify-fill] ${String(m)}`) } catch {} ; try { dbg.push(String(m)) } catch {} };
        const browserData = activeBrowsers.get(String(profileId || ''));
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            addLog('no_browser');
            return res.json({ success: false, status: 'no_browser', debug: dbg });
        }
        const browser = browserData.browser;
        const pages = await browser.pages();
        if (!pages || !pages.length) { addLog('no_pages'); return res.json({ success: false, status: 'no_pages', debug: dbg }); }
        addLog(`pages=${pages.length}`);
        let uiLast4 = '';
        try {
            for (const page of pages) {
                try {
                    const t = await page.evaluate(() => {
                        const scope = document.querySelector('[role="dialog"], [aria-modal="true"], .uiContextualLayerPositioner, ._dialog, ._modal') || document;
                        const txt = scope ? (scope.textContent || '') : (document.body ? (document.body.textContent || '') : '');
                        return String(txt || '');
                    });
                    const m = t.match(/(?:\.\s*\.\s*\.\s*\.\s*|\.\.\.\.\s*)(\d{4})/) || t.match(/\b(\d{4})\b(?=.*METAPAY)/i) || t.match(/\b(\d{4})\b(?=.*MasterCard)/i);
                    if (m && m[1]) { uiLast4 = String(m[1]); break; }
                } catch {}
            }
        } catch {}
        if (uiLast4) addLog(`ui_last4=${uiLast4}`);

        let codes = [];
        const inputCode = String(code || '').trim();
        if (inputCode) {
            const parts = inputCode.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
            codes = parts;
            addLog(`use_input_code parts=${parts.length}`);
        } else {
            try {
                let filledFromAdpos = false;
                try {
                    const r = await adposClient.listTransactions({ profileId: String(profileId||''), page: 1, per_page: 50 });
                    if (r && r.ok && Array.isArray(r.data)) {
                        const arr = r.data;
                        addLog(`adpos_local txns=${arr.length}`);
                        const filt = Array.isArray(arr) ? arr.filter(it => {
                            if (!uiLast4) return true;
                            const last4 = String((it && (it.last_four_digits || it.card_last4 || (it.card_number ? String(it.card_number).slice(-4) : ''))) || '').replace(/\D/g,'');
                            return !last4 || last4 === uiLast4;
                        }) : arr;
                        if (uiLast4) addLog(`adpos_local filtered=${(filt||[]).length}`);
                        const take = (filt && filt.length ? filt : arr);
                        const sorted = Array.isArray(take) ? take.slice().sort((a,b)=>{
                            const ta = Number(a && (a.transaction_unix_timestamp || (Date.parse(String(a.created_at||a.date||''))||0)));
                            const tb = Number(b && (b.transaction_unix_timestamp || (Date.parse(String(b.created_at||b.date||''))||0)));
                            return tb - ta;
                        }) : take;
                        if (Array.isArray(sorted) && sorted.length) {
                            const top = sorted[0];
                            try { addLog(`adpos_local latest ts=${Number(top && (top.transaction_unix_timestamp||0))} merchant=${String((top && (top.merchant_name||top.description||''))||'').slice(0,80)}`); } catch {}
                        }
                        let codeHit = '';
                        for (const it of (sorted || take || [])) {
                            try {
                                const name = String((it && (it.merchant_name || it.merchant || it.description)) || '').toUpperCase();
                                const m = name.match(/METAPAY\*([A-Z0-9]{4})/i) || name.match(/\bFB[-\s]*([A-Z0-9]{4})\b/i) || (name.includes('FB.ME/CC') ? name.match(/\b([A-Z0-9]{4})\b/) : null) || name.match(/FACEBK\s.*?\b([A-Z0-9]{4})\b/i);
                                if (m && m[1]) { codeHit = String(m[1]); try { addLog(`code_hit_local=${codeHit} merchant=${String((it && (it.merchant_name||it.description||''))||'').slice(0,80)}`); } catch {} ; break; }
                            } catch {}
                        }
                        if (codeHit) { codes = [codeHit]; filledFromAdpos = true; }
                        if (!filledFromAdpos) {
                            const vals = [];
                            for (const it of (sorted || take || [])) {
                                try {
                                    const a = it && (it.amount || it.money || it.value || it.amt);
                                    if (a !== undefined && a !== null) {
                                        const s = String(a).trim();
                                        if (/^\d+(\.|,)\d{1,2}$/.test(s) || /^\d+$/.test(s)) vals.push(s);
                                    }
                                } catch {}
                                if (vals.length >= 2) break;
                            }
                            if (vals.length) { codes = vals.slice(0, 2); filledFromAdpos = true; addLog(`use_amounts_local=${JSON.stringify(codes)}`); }
                            else { try { addLog('no_code_found_local'); } catch {} }
                        }
                    }
                } catch {}
                if (!filledFromAdpos) {
                    const tk = String(extTokenRaw || '').trim();
                    const base = String(extBaseRaw || 'https://api.adpos.io').replace(/\/$/, '');
                    if (tk) {
                        try {
                            const nowSec = Math.floor(Date.now()/1000);
                            const startSec = nowSec - 31*24*60*60;
                            const url = `${base}/v2/cards/transactions?start_timestamp=${startSec}&end_timestamp=${nowSec}&per_page=50&page=1`;
                            addLog(`fetch_external_txns base=${base}`);
                            const rr = await fetch(url, { headers: { 'Authorization': `Bearer ${tk}`, 'Accept': 'application/json' } });
                            const jj = await rr.json().catch(()=>({}));
                            const arr = Array.isArray(jj?.data) ? jj.data : [];
                            addLog(`adpos_external txns=${arr.length}`);
                            const filt = Array.isArray(arr) ? arr.filter(it => {
                                if (!uiLast4) return true;
                                const last4 = String((it && (it.last_four_digits || it.card_last4 || (it.card_number ? String(it.card_number).slice(-4) : ''))) || '').replace(/\D/g,'');
                                return !last4 || last4 === uiLast4;
                            }) : arr;
                            if (uiLast4) addLog(`adpos_external filtered=${(filt||[]).length}`);
                            const take = (filt && filt.length ? filt : arr);
                            const sorted = Array.isArray(take) ? take.slice().sort((a,b)=>{
                                const ta = Number(a && (a.transaction_unix_timestamp || (Date.parse(String(a.created_at||a.date||''))||0)));
                                const tb = Number(b && (b.transaction_unix_timestamp || (Date.parse(String(b.created_at||b.date||''))||0)));
                                return tb - ta;
                            }) : take;
                            if (Array.isArray(sorted) && sorted.length) {
                                const top = sorted[0];
                                try { addLog(`adpos_external latest ts=${Number(top && (top.transaction_unix_timestamp||0))} merchant=${String((top && (top.merchant_name||top.description||''))||'').slice(0,80)}`); } catch {}
                            }
                            let codeHit = '';
                            for (const it of (sorted || take || [])) {
                                try {
                                    const name = String((it && (it.merchant_name || it.merchant || it.description)) || '').toUpperCase();
                                    const m = name.match(/METAPAY\*([A-Z0-9]{4})/i) || name.match(/\bFB[-\s]*([A-Z0-9]{4})\b/i) || (name.includes('FB.ME/CC') ? name.match(/\b([A-Z0-9]{4})\b/) : null) || name.match(/FACEBK\s.*?\b([A-Z0-9]{4})\b/i);
                                    if (m && m[1]) { codeHit = String(m[1]); try { addLog(`code_hit_external=${codeHit} merchant=${String((it && (it.merchant_name||it.description||''))||'').slice(0,80)}`); } catch {} ; break; }
                                } catch {}
                            }
                            if (codeHit) { codes = [codeHit]; filledFromAdpos = true; }
                        } catch {}
                    }
                }
                if (!filledFromAdpos) {
                    const prof = await findProfileById(String(profileId));
                    const notes = String((prof && (prof.notes || prof.account_notes)) || '');
                    const parts = notes.split(/[\s,;|]+/).filter(Boolean);
                    const nums = parts.filter(p => /^(\d+([.,]\d{1,2})?)$/.test(p) || /^\d{4,}$/.test(p)).slice(0, 3);
                    codes = nums; addLog(`use_notes_codes=${JSON.stringify(codes)}`);
                }
            } catch {}
        }




function ensureVerificationCodesTable(db){
    return new Promise((resolve)=>{
        db.serialize(()=>{
            db.run(`CREATE TABLE IF NOT EXISTS verification_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, card_last4 TEXT, code TEXT, merchant TEXT, source TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, [], ()=>resolve())
        })
    })
}
        let status = 'unknown';
        let beforeMethods = [];
        try {
            beforeMethods = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                return items.map(el => {
                    const t = el.textContent || '';
                    const type = (t.match(/信用卡|Debit|Visa|Mastercard|Amex/i) || [])[0] || 'Payment';
                    const last4 = (t.match(/\d{4}/) || [])[0] || '';
                    return { type, last4 };
                });
            });
        } catch {}
        try {
            await new Promise(r => setTimeout(r, ));
            const clickAdd = async () => {
                const selectors = [
                    'button[aria-label*="添加" i]',
                    'button[aria-label*="新增" i]',
                    'button[aria-label*="Add" i]',
                    '[data-testid*="add_payment" i]',
                    '[data-testid*="addPayment" i]',
                    'button:has-text("添加付款方式")',
                    'button:has-text("添加支付")',
                    'button:has-text("Add payment")',
                    'button:has-text("Add a payment")',
                    'div[role="button"]:has-text("添加")'
                ];
                for (const s of selectors) {
                    try {
                        const h = await page.$(s);
                        if (h) { await h.click({ delay: 20 }); return true; }
                    } catch {}
                }
                return false;
            };
            await clickAdd();
            await new Promise(r => setTimeout(r, ));
            if (String(mode || '').toLowerCase() === 'manual') {
                const num = String(card && card.number || '').replace(/\s+/g, '');
                const holder = String(card && card.holder || '');
                const mm = String(card && card.exp_month || '');
                const yy = String(card && card.exp_year || '');
                const cvv = String(card && card.cvv || '');
                const fillField = async (predicates, value, typeDelay) => {
                    for (const p of predicates) {
                        try {
                            const el = await page.$(p);
                            if (el) {
                                try { await el.click({ delay: 20 }); } catch {}
                                try { await el.evaluate(() => { try { (window.getSelection && window.getSelection().removeAllRanges && window.getSelection().removeAllRanges()); } catch {} }); } catch {}
                                try { await el.press('End'); } catch {}
                                try { await el.press('Control+A'); } catch {}
                                try { await el.press('Delete'); } catch {}
                                if (value && value.length) {
                                    try { await el.type(value, { delay: typeDelay || 30 }); } catch { await page.evaluate((v, psel) => { try { const n = document.querySelector(psel); if (n) { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); } } catch {} }, value, p); }
                                }
                                return true;
                            }
                        } catch {}
                    }
                    return false;
                };
                await fillField([
                    'input[name*="card" i][name*="number" i]',
                    'input[id*="card" i][id*="number" i]',
                    'input[autocomplete="cc-number"]',
                    'input[aria-label*="卡号" i]',
                    'input[placeholder*="卡号" i]',
                    'input[placeholder*="Card" i][placeholder*="Number" i]'
                ], num, 20);
                await new Promise(r => setTimeout(r, ));
                await fillField([
                    'input[name*="name" i][name*="card" i]',
                    'input[id*="name" i][id*="card" i]',
                    'input[aria-label*="持卡人" i]',
                    'input[placeholder*="持卡人" i]',
                    'input[autocomplete="cc-name"]'
                ], holder, 20);
                await new Promise(r => setTimeout(r, ));
                const expCombined = `${mm}/${yy}`;
                let expFilled = await fillField([
                    'input[name*="exp" i]',
                    'input[id*="exp" i]',
                    'input[aria-label*="有效期" i]',
                    'input[placeholder*="MM/YY" i]'
                ], expCombined, 20);
                if (!expFilled) {
                    await fillField([
                        'input[name*="mm" i]',
                        'input[id*="mm" i]',
                        'input[aria-label*="月" i]'
                    ], mm, 20);
                    await new Promise(r => setTimeout(r, ));
                    await fillField([
                        'input[name*="yy" i]',
                        'input[id*="yy" i]',
                        'input[aria-label*="年" i]'
                    ], yy, 20);
                }
                await new Promise(r => setTimeout(r, ));
                await fillField([
                    'input[name*="cvc" i]',
                    'input[name*="cvv" i]',
                    'input[id*="cvc" i]',
                    'input[id*="cvv" i]',
                    'input[autocomplete="cc-csc"]',
                    'input[aria-label*="安全码" i]'
                ], cvv, 20);
                if (billing_address && typeof billing_address === 'object') {
                    const addr = billing_address;
                    const addrLine = String(addr.line1 || addr.address || '');
                    const city = String(addr.city || '');
                    const zip = String(addr.postal || addr.zip || '');
                    const country = String(addr.country || '');
                    if (addrLine) { await fillField(['input[name*="address" i]','input[id*="address" i]','input[placeholder*="地址" i]'], addrLine, 20); }
                    if (city) { await fillField(['input[name*="city" i]','input[id*="city" i]','input[placeholder*="城市" i]'], city, 20); }
                    if (zip) { await fillField(['input[name*="postal" i]','input[name*="zip" i]','input[id*="postal" i]','input[id*="zip" i]','input[placeholder*="邮编" i]'], zip, 20); }
                    if (country) { try { const sel = await page.$('select[name*="country" i], select[id*="country" i]'); if (sel) { await sel.select(country); } } catch {} }
                }
            } else {
                if (method && method.last4) {
                    const m4 = String(method.last4);
                    const candidates = [
                        `[data-testid*="payment" i]`,
                        '[role="listitem"]',
                        'div:has-text("Visa")',
                        'div:has-text("Mastercard")',
                        'div:has-text("信用卡")'
                    ];
                    for (const c of candidates) {
                        try {
                            const nodes = await page.$$(c);
                            for (const n of nodes) {
                                const txt = await page.evaluate(el => el.textContent || '', n);
                                if (txt && txt.includes(m4)) { try { await n.click({ delay: 20 }); } catch {} }
                            }
                        } catch {}
                    }
                }
            }
            await new Promise(r => setTimeout(r, ));
            const submitSelectors = [
                'button[type="submit"]',
                'button:has-text("保存")',
                'button:has-text("添加")',
                'button:has-text("确认")',
                'button:has-text("确定")',
                'button:has-text("下一步")',
                'button:has-text("完成")',
                'button:has-text("继续")',
                'button:has-text("提交")',
                '[data-testid*="confirm" i]'
            ];
            let clicked = false;
            for (const s of submitSelectors) {
                try {
                    const h = await page.$(s);
                    if (h) {
                        try { await h.evaluate(el => { try { el.scrollIntoView({ block: 'center' }); } catch {} }); } catch {}
                        await h.click({ delay: 20 });
                        clicked = true;
                        await new Promise(r => setTimeout(r, ));
                        break;
                    }
                } catch {}
            }
            if (!clicked) {
                try {
                    const labels = ['保存','添加','确认','确定','下一步','完成','继续','提交','Save','Add','Confirm','Next','Done','Continue','Submit'];
                    const ok2 = await page.evaluate((labels) => {
                        const nodes = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"], span'));
                        for (const n of nodes) {
                            const txt = (n.textContent || '').trim();
                            if (!txt) continue;
                            if (labels.some(l => txt.includes(l))) {
                                const ds = (n.getAttribute('disabled') || '') || (n.getAttribute('aria-disabled') || '');
                                if (!ds) { try { n.scrollIntoView({ block: 'center' }); } catch {} ; try { n.click(); } catch {} ; return true; }
                            }
                        }
                        return false;
                    }, labels);
                    if (ok2) { clicked = true; await new Promise(r => setTimeout(r, )); }
                } catch {}
            }
            if (!clicked) {
                try { await page.keyboard.press('Enter'); clicked = true; await new Promise(r => setTimeout(r, )); } catch {}
            }
            await new Promise(r => setTimeout(r, ));
        } catch {}
        let methods = [];
        try {
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 25000 });
            methods = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                return items.map(el => {
                    const t = el.textContent || '';
                    const type = (t.match(/信用卡|Debit|Visa|Mastercard|Amex/i) || [])[0] || 'Payment';
                    const last4 = (t.match(/\d{4}/) || [])[0] || '';
                    return { type, last4 };
                });
            });
            try {
                const before = Array.isArray(beforeMethods) ? beforeMethods.map(m=>m.last4).join(',') : '';
                const after = Array.isArray(methods) ? methods.map(m=>m.last4).join(',') : '';
                if (after && before !== after) { ok = true; status = 'added'; }
                else { ok = clicked ? true : false; status = clicked ? 'submitted' : 'unknown'; }
            } catch {}
        } catch {}
        try { await page.close(); } catch {}
        try {
            const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
            const baseUrl = storageServerUrl.replace(/\/$/, '');
            const acc = String(adAccountId || '').trim();
            const actId = acc ? (acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc)) : '';
            const items = (Array.isArray(methods) ? methods : []).map(m => ({
                profileId: String(profileId || ''),
                accountId: actId,
                type: String(m.type || ''),
                last4: String(m.last4 || ''),
                brand: /visa/i.test(String(m.type)) ? 'Visa' : (/master/i.test(String(m.type)) ? 'Mastercard' : ''),
                exp_month: String(card && card.exp_month || ''),
                exp_year: String(card && card.exp_year || ''),
                billing_address: JSON.stringify({
                    provider: String(channel || ''),
                    holder: String(card && card.holder || ''),
                    cardNumber: String(card && card.number || ''),
                    cvv: String(card && card.cvv || ''),
                    tags: Array.isArray(tag) ? tag.map(String) : (tag ? [String(tag)] : [])
                })
            }));
            if (items.length) {
                await fetch(`${baseUrl}/api/billing-methods/bulk-save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).catch(()=>{});
            }
        } catch {}
        try {
            const before = Array.isArray(beforeMethods) ? beforeMethods.map(m=>m.last4).join(',') : '';
            const after = Array.isArray(methods) ? methods.map(m=>m.last4).join(',') : '';
            if (ok && before !== after) { status = 'added'; }
            if (!ok) { status = status === 'unknown' ? 'failed' : status; }
        } catch {}
        return res.json({ success: ok, status, methods });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/billing/verify-click' (original lines 3721-3832) =====
app.post('/api/facebook/billing/verify-click', async (req, res) => {
    try {
        const { profileId, adAccountId, last4, keepOpen, url } = req.body || {};
        const browserData = activeBrowsers.get(String(profileId || ''));
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            return res.json({ success: false, status: 'no_browser' });
        }
        const page = await browserData.browser.newPage();
        let targetUrl = String(url || '');
        if (!targetUrl) {
            targetUrl = 'https://business.facebook.com/adsmanager/billing';
            try {
                const acc = String(adAccountId || '').trim();
                if (acc) {
                    const actId = acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc);
                    targetUrl = `https://business.facebook.com/adsmanager/manage/billing?act=${encodeURIComponent(actId)}`;
                }
            } catch {}
        }
        try { await page.setDefaultTimeout(60000); } catch {}
        try { await page.setDefaultNavigationTimeout(60000); } catch {}
        try {
            const conn = await mainDbPool.getConnection();
            const row = await new Promise((resolve) => {
                conn.get(`SELECT account_cookies FROM profiles WHERE id = ?`, [String(profileId || '')], (err, r) => resolve(err ? null : r));
            });
            mainDbPool.releaseConnection(conn);
            if (row && row.account_cookies) {
                let cookies = null;
                try { cookies = JSON.parse(row.account_cookies); } catch { cookies = null; }
                if (Array.isArray(cookies) && cookies.length > 0) {
                    for (const ck of cookies) {
                        try {
                            const host = 'business.facebook.com';
                            let domain = ck.domain || host;
                            if (/facebook\.com$/i.test(domain)) domain = '.facebook.com';
                            await page.setCookie({
                                name: ck.name,
                                value: ck.value,
                                domain,
                                path: ck.path || '/',
                                secure: ck.secure !== undefined ? ck.secure : true,
                                httpOnly: !!ck.httpOnly,
                                sameSite: ck.sameSite || 'None',
                                // ⏳ 一律续期到 +100 年：会话级（无 expirationDate）会被浏览器退出时丢弃，
                                //    已过期的会被 Chrome 静默丢弃 —— 两者都不能沿用原始值
                                expires: Math.floor(Date.now() / 1000) + 36500 * 24 * 60 * 60
                            });
                        } catch {}
                    }
                }
            }
        } catch {}
        try { await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 }); } catch {}
        try {
            const needLogin = await page.evaluate(() => {
                const u = location.href || '';
                const hasPwd = !!document.querySelector('input[type="password"], input[name*="pass" i], input[id*="pass" i]');
                const hasEmail = !!document.querySelector('input[name="email"], input[type="email"]');
                return /login|signin|accounts\.facebook/i.test(u) || (hasPwd && hasEmail);
            });
            if (needLogin) { if (!keepOpen) { try { await page.close(); } catch {} } ; return res.json({ success: false, status: 'not_logged_in' }); }
        } catch {}
        let verified = 0;
        try {
            try { await new Promise(r => setTimeout(r, )); } catch {}
            try { await page.waitForSelector('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod', { timeout: 15000 }); } catch {}
            const acted = await page.evaluate((l4) => {
                const items = Array.from(document.querySelectorAll('[role="listitem"], [data-testid*="payment_method"], ._paymentMethod'));
                let done = 0;
                const matchText = (el) => (el.textContent || '').toLowerCase();
                const findVerifyBtn = (root) => {
                    const candidates = Array.from(root.querySelectorAll('button, a'));
                    return candidates.find(btn => /验证|verify|确认/i.test(btn.textContent || '')) || null;
                };
                for (const el of items) {
                    const t = matchText(el);
                    const l4s = (t.match(/\d{4}/g) || []).map(s=>s);
                    const hasTarget = l4 ? l4s.includes(String(l4)) : /visa|mastercard|amex|debit|信用卡/i.test(t);
                    if (!hasTarget) continue;
                    const btn = findVerifyBtn(el) || findVerifyBtn(document);
                    if (btn) { try { btn.click(); done++; } catch {} }
                }
                if (done === 0) {
                    const global = Array.from(document.querySelectorAll('button, a')).find(btn => /验证|verify|确认/i.test(btn.textContent || ''));
                    if (global) { try { global.click(); done++; } catch {} }
                }
                return done;
            }, String(last4 || ''));
            verified = Number(acted || 0);
            if (!verified) {
                try {
                    const acc = String(adAccountId || '').trim();
                    const actId = acc.startsWith('act_') ? acc : (acc.match(/^\d+$/) ? `act_${acc}` : acc);
                    const hub = buildBillingHubUrl(acc);
                    await page.goto(hub, { waitUntil: 'networkidle2', timeout: 25000 });
                    try { await new Promise(r => setTimeout(r, )); } catch {}
                    const acted2 = await page.evaluate(() => {
                        let done = 0;
                        const global = Array.from(document.querySelectorAll('button, a')).find(btn => /验证|verify|确认/i.test(btn.textContent || ''));
                        if (global) { try { global.click(); done++; } catch {} }
                        return done;
                    });
                    verified = Number(acted2 || 0);
                } catch {}
            }
        } catch {}
        // 不关闭窗口：根据 keepOpen 控制，默认保持不关闭
        if (!keepOpen) { try { await page.close(); } catch {} }
        return res.json({ success: verified > 0, verified });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'error', error: String(e.message || e) });
    }
});


// ===== post '/api/facebook/fetch-adaccounts-graph' (original lines 4140-5214) =====
app.post('/api/facebook/fetch-adaccounts-graph', async (req, res) => {
    // ⏱️ 统一的收尾日志：不管从哪条 return / 异常退出，都能看到 HTTP 状态码和总耗时，
    //    批量取数"没反应"时不会再只剩最后一行可猜
    const _faT0 = Date.now();
    const _faPid = String((req.body || {}).profileId || '');
    res.on('finish', () => {
        log('INFO', `[FetchAdAccounts] 结束: profileId=${_faPid}, HTTP ${res.statusCode}, 总耗时=${Date.now() - _faT0}ms`);
    });
    try {
        const { profileId, accessToken, fetchAds, withAccountQuality, keepBrowser, withEngagement } = req.body || {};
        log('INFO', `[FetchAdAccounts] Request for profileId: ${profileId}${fetchAds ? ', fetchAds=true' : ''}${withAccountQuality ? ', withAccountQuality=true' : ''}${keepBrowser ? ', keepBrowser=true' : ''}${typeof withEngagement === 'boolean' ? `, withEngagement=${withEngagement}` : ''}`);

        if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });

        // 🚀 获取 Profile 信息，提前初始化变量
        let profName = 'Auto_Pixel';
        let accountDisplay = '';
        let profForApi = null; // 用于后续 API 调用的 profile 对象（必须包含 id 才能触发浏览器回退）
        try {
            const prof = await findProfileById(String(profileId));
            if (prof) {
                profName = String(prof.name || 'Auto_Pixel');
                accountDisplay = String(prof.account || prof.accountName || prof.accountEmail || '');
                profForApi = { id: profileId, token: accessToken || prof.token, name: profName };
            }
        } catch (e) {
            log('WARN', `[FetchAdAccounts] Failed to find profile info: ${e.message}`);
        }

        // 1. 获取活跃浏览器；没有就**自动启动**再继续（不再直接 400）
        //    🐛 以前这里直接返回 400 "Browser not running"：但借用型浏览器空闲满 15s 会被强制回收，
        //       而前端本地 profiles[].status 可能还停留在 RUNNING（于是跳过启动、直接来取数）→
        //       撞上已被回收的浏览器立刻 400，整条取数就断了（实测 18:14:37 一次出现 4 个这种 400）。
        let browserData = activeBrowsers.get(String(profileId));
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            const _autoT0 = Date.now();
            log('WARN', `[FetchAdAccounts] 无可用浏览器，自动启动后再取数: profileId=${profileId}`);
            try {
                const bres = await ensureBrowserIsRunning(String(profileId));
                if (!bres || bres.success === false) {
                    const why = (bres && (bres.error || bres.message)) || '未知原因';
                    log('ERROR', `[FetchAdAccounts] 自动启动浏览器失败: profileId=${profileId}, 原因=${why}`);
                    return res.status(400).json({ success: false, message: `浏览器未运行，自动启动也失败: ${why}` });
                }
                browserData = bres.browserData || activeBrowsers.get(String(profileId));
                log('INFO', `[FetchAdAccounts] 自动启动完成: profileId=${profileId}（耗时 ${Date.now() - _autoT0}ms）`);
            } catch (e) {
                log('ERROR', `[FetchAdAccounts] 自动启动浏览器异常: profileId=${profileId}, 原因=${String(e.message || e)}`);
                return res.status(400).json({ success: false, message: `浏览器未运行，自动启动异常: ${String(e.message || e)}` });
            }
        }
        if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
            log('ERROR', `[FetchAdAccounts] 自动启动后仍无可用浏览器: profileId=${profileId}`);
            return res.status(400).json({ success: false, message: 'Browser not running. Please launch browser first.' });
        }
        const browser = browserData.browser;

        // 2. 获取 Token (如果未提供)
        let token = accessToken;
        if (!token || token === 'BROWSER') {
            // 🚀 优先从本地数据库找已保存的 token
            if (profForApi && profForApi.token && profForApi.token.startsWith('EAA')) {
                // 🔑 本地 token 必须先验活：失效的 token 会让取数静默返回全 0 并谎报成功
                const alive = await isFbTokenAlive(profForApi.token);
                if (alive === false) {
                    log('WARN', `[FetchAdAccounts] 本地数据库 Token 已失效，丢弃并改走其他途径: ${String(profForApi.token).slice(0,15)}...`);
                } else {
                    token = profForApi.token;
                    log('INFO', `[FetchAdAccounts] 从本地数据库获取到 Token: ${token.slice(0,15)}...${alive === null ? '（未能验活，按原逻辑使用）' : ''}`);
                }
            }
            // 🚀 本地没有则尝试从远程云端数据库获取
            if (!token || !token.startsWith('EAA')) {
                try {
                    const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
                    const apiSecret = process.env.PUPPETEER_API_SECRET || '';
                    const sBase = storageServerUrl.replace(/\/$/, '');
                    const cloudResp = await fetch(`${sBase}/api/profiles/${encodeURIComponent(profileId)}`, {
                        headers: { 'X-Api-Secret': apiSecret }
                    });
                    if (cloudResp.ok) {
                        const cloudData = await cloudResp.json();
                        const cloudToken = cloudData?.token || cloudData?.accessToken || '';
                        if (cloudToken && cloudToken.startsWith('EAA')) {
                            // 🔑 云端 token 同样要验活，避免把已经作废的会话当成可用
                            const cloudAlive = await isFbTokenAlive(cloudToken);
                            if (cloudAlive === false) {
                                log('WARN', `[FetchAdAccounts] 云端 Token 已失效，丢弃: ${String(cloudToken).slice(0,15)}...`);
                            } else {
                                token = cloudToken;
                                log('INFO', `[FetchAdAccounts] 从远程云端获取到 Token: ${token.slice(0,15)}...`);
                            }
                        }
                    }
                } catch (e) {
                    log('WARN', `[FetchAdAccounts] 远程云端获取 Token 失败: ${e.message}`);
                }
            }
            if (!token || !token.startsWith('EAA')) {
                log('INFO', `[FetchAdAccounts] 数据库无有效 Token，从浏览器提取...`);
                try {
                const pages = await browser.pages();
                // 🚀 直接导航到广告管理后台触发 API 请求，CDP 拦截提取 Token
                let page = pages.find(p => /adsmanager\.facebook\.com/i.test(p.url()) || /business\.facebook\.com/i.test(p.url()));
                if (!page) {
                    page = await browser.newPage();
                    log('INFO', `[FetchAdAccounts] 新建标签页导航到广告管理后台...`);
                } else {
                    log('INFO', `[FetchAdAccounts] 使用已有的广告管理后台页面...`);
                }
                await page.goto('https://adsmanager.facebook.com/adsmanager/manage/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 4000));
                // 🚀 通过 CDP 网络拦截提取 Token
                token = await extractFbToken(page, 12000);

                log('INFO', `[FetchAdAccounts] Extracted token: ${token ? 'YES (prefix ' + token.slice(0,8) + '...)' : 'NO'}`);

                // 🚀 核心改进：一旦提取到 Token，立即同步到云端服务器
                if (token && token.startsWith('EAA')) {
                    log('INFO', `[FetchAdAccounts] Syncing freshly extracted token to cloud for profile: ${profileId}`);
                    const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
                    const apiSecret = process.env.PUPPETEER_API_SECRET || '';
                    const sBase = storageServerUrl.replace(/\/$/, '');
                    
                    await fetch(`${sBase}/api/profiles/bulk-save`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'X-Api-Secret': apiSecret 
                        },
                        body: JSON.stringify({ 
                            items: [{ id: profileId, token: token }] 
                        })
                    }).catch(err => log('WARN', `[FetchAdAccounts] Failed to sync extracted token to cloud: ${err.message}`));
                }
            } catch (e) {
                log('WARN', `[FetchAdAccounts] Token extraction failed: ${e.message}`);
            }
            } else {
            log('INFO', `[FetchAdAccounts] 使用数据库 Token，跳过浏览器提取`);
            }
        }

        // 🔐 登录状态：本次取数结束时该配置的登录态，回给前端落库。
        //    ok = 直接用有效 Cookie 拿到 Token；relogged = Cookie 失效但本次自动重登成功；
        //    invalid = Cookie 失效且自动重登没救回来（需人工登录）。
        let loginStatus = 'ok';
        // 🚀 如果 Token 提取失败，检查 Cookie 是否有效，无效则自动登录后再重试
        if (!token || token === 'BROWSER') {
            log('WARN', `[FetchAdAccounts] Token 提取失败，检测 Cookie 状态...`);
            let needsLogin = false;
            // 🛡️ 人机验证：Cookie 往往没坏，只是被 FB 拦到安全验证页，要单独成一档，
            //    否则会被记成「登录失效」，误导用户去重新登号（实际只要去点一下验证）。
            let onCheckpointPage = false;
            try {
                const pages = await browser.pages();
                const fbPages = pages.filter(p => /facebook\.com/i.test(p.url()));
                // ⚠️ 原来这里用 find 时直接把 checkpoint 页排除掉了 → 被拦时找不到 fbPage，
                //    判定退化成「未找到 Facebook 页面」，checkpoint 这条信息就整个丢了。
                const checkpointPage = fbPages.find(p => /\/checkpoint\b/i.test(p.url()));
                if (checkpointPage) {
                    onCheckpointPage = true;
                    log('WARN', `[FetchAdAccounts] 检测到人机验证页(checkpoint): ${String(checkpointPage.url()).substring(0, 120)}`);
                }
                const fbPage = fbPages.find(p => !/\/checkpoint\b/i.test(p.url()));
                if (fbPage) {
                    const fbUrl = fbPage.url() || '';
                    let bodyText = '';
                    try { bodyText = await fbPage.content().catch(() => ''); } catch {}
                    const hasLoginForm = bodyText.includes('Log in') || bodyText.includes('登录') || bodyText.includes('password') || bodyText.includes('type="password"');
                    const onLoginPage = /login/i.test(fbUrl) || hasLoginForm;
                    const isLoggedIn = !onLoginPage && (bodyText.includes("What's on your mind") || bodyText.includes('在想什么') || bodyText.includes('Create a post') || bodyText.includes('创建帖子'));
                    const cookieCheck = { onLoginPage, isLoggedIn, hasLoginForm };
                    log('INFO', `[FetchAdAccounts] Cookie 检测: loginPage=${cookieCheck.onLoginPage} loggedIn=${cookieCheck.isLoggedIn} form=${cookieCheck.hasLoginForm}`);
                    needsLogin = cookieCheck.onLoginPage || cookieCheck.hasLoginForm;
                } else {
                    needsLogin = true;
                    log('INFO', `[FetchAdAccounts] 未找到 Facebook 页面，需要登录`);
                }
            } catch (e) {
                log('WARN', `[FetchAdAccounts] Cookie 检测异常: ${e.message}`);
                needsLogin = true;
            }

            if (needsLogin) {
                // 先按最坏情况记：被 checkpoint 拦住时记 checkpoint（要人去过验证），
                // 否则记 invalid（Cookie 失效）；下面自动登录真取到 Token 再翻成 relogged
                loginStatus = onCheckpointPage ? 'checkpoint' : 'invalid';
                log('INFO', `[FetchAdAccounts] Cookie 无效，执行自动登录流程...`);
                try {
                    let fbPage = (await browser.pages()).find(p => /facebook\.com/i.test(p.url()));
                    if (!fbPage) {
                        fbPage = await browser.newPage();
                        await fbPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                    }
                    await new Promise(r => setTimeout(r, 2000));

                    const loginPassword = await (async () => {
                        try { const prof = await findProfileById(String(profileId)); return prof?.accountPassword || prof?.account_password || ''; } catch { return ''; }
                    })();

                    // Tab 2次 + Enter（点 Continue）
                    log('INFO', `[FetchAdAccounts] AutoLogin: Tab 2次 + Enter`);
                    await fbPage.keyboard.press('Tab');
                    await new Promise(r => setTimeout(r, 300));
                    await fbPage.keyboard.press('Tab');
                    await new Promise(r => setTimeout(r, 300));
                    await fbPage.keyboard.press('Enter');
                    await new Promise(r => setTimeout(r, 3000));

                    // 用 CDP $ 检测密码框（不依赖 JS 执行）
                    const hasPass = !!(await fbPage.$('input[type="password"]').catch(() => null));
                    if (hasPass && loginPassword) {
                        log('INFO', `[FetchAdAccounts] AutoLogin: 填入密码`);
                        await fbPage.type('input[type="password"]', loginPassword, { delay: 50 }).catch(() => {});
                        await new Promise(r => setTimeout(r, 500));
                        log('INFO', `[FetchAdAccounts] AutoLogin: Tab 2次 + Enter 提交密码`);
                        await fbPage.keyboard.press('Tab');
                        await new Promise(r => setTimeout(r, 300));
                        await fbPage.keyboard.press('Tab');
                        await new Promise(r => setTimeout(r, 300));
                        await fbPage.keyboard.press('Enter');
                        await new Promise(r => setTimeout(r, 3000));
                    } else {
                        log('INFO', `[FetchAdAccounts] AutoLogin: 无密码框或密码，Tab 2次 + Enter`);
                        await fbPage.keyboard.press('Tab');
                        await new Promise(r => setTimeout(r, 300));
                        await fbPage.keyboard.press('Tab');
                        await new Promise(r => setTimeout(r, 300));
                        await fbPage.keyboard.press('Enter');
                        await new Promise(r => setTimeout(r, 3000));
                    }

                    // 等待导航完成
                    try { await fbPage.waitForNavigation({ timeout: 15000 }).catch(() => {}); } catch {}
                    log('INFO', `[FetchAdAccounts] AutoLogin 完成，URL: ${fbPage.url().substring(0, 100)}`);

                    // 🚀 导航到广告管理后台触发 API 请求（包含 access_token），CDP 才能拦截到
                    try {
                        await fbPage.goto('https://adsmanager.facebook.com/adsmanager/manage/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                    } catch {}

                    // 🚀 通过 CDP 网络拦截重新提取 Token
                    log('INFO', `[FetchAdAccounts] 登录后重新提取 Token...`);
                    token = await extractFbToken(fbPage, 10000);

                    if (token && token.startsWith('EAA')) {
                        log('INFO', `[FetchAdAccounts] 登录后成功提取 Token: ${token.slice(0, 15)}...`);
                        loginStatus = 'relogged';
                    } else {
                        log('WARN', `[FetchAdAccounts] 登录后仍无法提取 Token`);
                        // 自动登录没救回来：本来是被 checkpoint 拦的就维持 checkpoint，
                        // 别降级成 invalid —— 两者要用户做的事完全不同。
                        if (onCheckpointPage) loginStatus = 'checkpoint';
                    }
                } catch (loginErr) {
                    log('WARN', `[FetchAdAccounts] 自动登录流程异常: ${loginErr.message}`);
                }
            }
        }

        if (!token || token === 'BROWSER') {
            return res.status(400).json({ success: false, message: 'Could not extract Access Token from browser.', loginStatus: loginStatus === 'ok' ? 'invalid' : loginStatus });
        }

        // 3. 使用 Token 调用 Graph API (通过浏览器访问)
        // User requested: "Browser address visit graph+token"
        const base = 'https://graph.facebook.com/v21.0';
        // 🚀 V5.6.8: 扩展抓取字段，包含更多广告状态 (ACTIVE, PAUSED, ARCHIVED)
        // 🚀 V5.6.9: 移除 ads{...} 嵌套大字段，避免广告号太多时响应过大导致导航超时
        // ads 数据改为单独请求获取，此处只保留广告计数
        const fields = [
            'account_id', 'name', 'account_status', 'currency', 'timezone_name', 'timezone_id', 'timezone_offset_hours_utc',
            'business_country_code', 'amount_spent', 'balance', 'spend_cap', 'min_daily_budget',
            // 🩺 disable_reason = 广告号「为什么被停用」的官方枚举（1 广告违规 / 3 支付风险 /
            //    6 BM 完整性风险 / 11 BM 政策违规 …）。只有它能区分「广告号自身死」和「BM 被牵连」。
            'disable_reason',
            'funding_source_details', 'business{id,name}', 
            'promotable_pages{id,name,fan_count,is_published,verification_status,access_token}'
        ].join(',');

        const graphUrl = `${base}/me/adaccounts?fields=${fields}&limit=100&access_token=${encodeURIComponent(token)}`;
        // 🚀 像素和数据集单独请求（可选字段，部分 API 版本/Token 不支持，不影响主流程）
        const pixelsUrl = `${base}/me/adaccounts?fields=adspixels{id,name},datasets{id,name}&limit=100&access_token=${encodeURIComponent(token)}`;
        // 🛡️ me/accounts 是「角色维度」的清单（这个账号有角色的主页），多带一个 tasks 就能直接当
        //    「账号权限」用 —— 这样主页列表的权限列不用再单独探一次（并进「获取信息」）。
        const pagesUrl = `${base}/me/accounts?fields=id,name,fan_count,link,category,access_token,tasks&limit=100&access_token=${encodeURIComponent(token)}`;
        // 🩺 is_disabled_for_integrity_reasons = BM 自身「因诚信原因被停用」的 Graph 级信号
        //    （唯一能从 Graph 侧白拿到的 BM 自身状态；更细的受限/申诉状态走内部 GraphQL，见 probeBmAccountQualityViaGraphql）
        // 🩺 business_users = BM 下的成员（邮箱 + 角色 ADMIN/EMPLOYEE + 是否启用）；
        //    pending_users = 已邀请未接受。两者一起给「管理员(权限)」列用。
        const bmsUrl = `${base}/me/businesses?fields=id,name,verification_status,link,is_disabled_for_integrity_reasons,business_users.limit(100){id,name,email,role,active_status},pending_users.limit(100){id,email,role,status}&limit=100&access_token=${encodeURIComponent(token)}`;
        
        log('INFO', `[FetchAdAccounts] Visiting Graph API for Accounts: ${graphUrl}`);
        log('INFO', `[FetchAdAccounts] Visiting Graph API for Pages: ${pagesUrl}`);
        log('INFO', `[FetchAdAccounts] Visiting Graph API for BMs: ${bmsUrl}`);
        
        let json = null;
        let pixelsJson = null;
        let pagesJson = null;
        let bmsJson = null;
        let tokenRetried = false; // 🚀 Token 失效重试标记
        let newGraphUrl = graphUrl, newPagesUrl = pagesUrl, newBmsUrl = bmsUrl, newPixelsUrl = pixelsUrl; // Token 刷新后的URL
        
        // 🚀 在浏览器页面中通过 goto() 调用 Graph API（resp.text() 方式，兼容所有 Chromium 版本，避免 AbortSignal.timeout 兼容问题）
        async function _browserFetchGraph(browser, url, label) {
            let retries = 0;
            const maxRetries = 2;
            while (retries <= maxRetries) {
                let fetchPage = null;
                try {
                    fetchPage = await browser.newPage();
                    const resp = await fetchPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
                    if (!resp) throw new Error('no response');
                    const text = await resp.text();
                    if (!text || text.trim().length === 0) throw new Error('empty response');
                    try {
                        const parsed = JSON.parse(text);
                        log('INFO', `[FetchAdAccounts] ${label} API 请求成功`);
                        return parsed;
                    } catch (parseErr) {
                        const preview = text.substring(0, 300);
                        log('WARN', `[FetchAdAccounts] ${label} API 返回非 JSON: ${preview}`);
                        throw new Error(`Graph API returned non-JSON: ${preview}`);
                    }
                } catch (e) {
                    retries++;
                    if (retries > maxRetries) {
                        log('WARN', `[FetchAdAccounts] ${label} API 请求失败(${retries}次): ${e.message}`);
                        return { _parseError: label, _raw: (e.message || '').substring(0, 200) };
                    }
                    log('INFO', `[FetchAdAccounts] ${label} 重试第${retries}次...`);
                    await new Promise(r => setTimeout(r, 2000));
                } finally {
                    if (fetchPage) try { await fetchPage.close(); } catch {}
                }
            }
        }
        
        try {
            const [accountsResult, pagesResult, bmsResult] = await Promise.all([
                _browserFetchGraph(browser, graphUrl, 'Accounts'),
                _browserFetchGraph(browser, pagesUrl, 'Pages'),
                _browserFetchGraph(browser, bmsUrl, 'BMs')
            ]);
            json = accountsResult;
            pagesJson = pagesResult;
            bmsJson = bmsResult;
            // 像素请求为最佳尝试，失败不影响主流程
            try {
                const pxPage = await browser.newPage();
                try {
                    const pxResp = await pxPage.goto(pixelsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                    if (pxResp) {
                        const pxText = await pxResp.text();
                        pixelsJson = JSON.parse(pxText);
                        if (pixelsJson?.error) pixelsJson = null;
                    }
                } finally { await pxPage.close().catch(() => {}); }
            } catch { pixelsJson = null; }
        } catch (e) {
            log('ERROR', `[FetchAdAccounts] Failed to fetch/parse Graph JSON: ${e.message}`);
            return res.status(500).json({ success: false, message: `Graph Fetch Failed: ${e.message}` });
        }
        // 🚀 检查 parse 失败标记（防御性 JSON.parse 兜底）
        if (!json || json._parseError) {
            const parseFailed = [json, pagesJson, bmsJson].filter(j => j?._parseError);
            log('ERROR', `[FetchAdAccounts] Graph API 返回非 JSON 内容: ${parseFailed.map(j => `[${j._parseError}] ${j._raw}`).join(' | ')}`);
            return res.status(502).json({ success: false, message: `Graph API returned non-JSON response. Check if token/API version is valid.` });
        }

        if (!json || json.error) {
            const errMsg = json?.error?.message || 'Unknown Graph API Error';
            log('ERROR', `[FetchAdAccounts] API Error: ${errMsg}`);
            
            // 🚀 Token 失效/登录过期（session invalidated/expired/login-wall/malformed），导航到 adsmanager 重新提取 token 重试一次
            if (!tokenRetried && (errMsg.includes('session has been invalidated') || errMsg.includes('expired') || errMsg.includes('Error validating access token') || errMsg.includes('Error loading application') || errMsg.includes('Malformed access token') || errMsg.includes('cannot access the app') || errMsg.includes('log in to www.facebook.com'))) {
                log('INFO', `[FetchAdAccounts] Token 失效，导航到 adsmanager 重新提取并重试...`);
                try {
                    // 导航到 adsmanager 刷新 token
                    const refreshPage = await browser.newPage();
                    
                    // 🚀 先设置 CDP 网络监听，再导航（避免错过早期网络请求）
                    let freshToken = '';
                    const rfCdpSession = await refreshPage.target().createCDPSession().catch(() => null);
                    if (rfCdpSession) {
                        const rfTokens = new Set();
                        let rfResolved = false;
                        const rfTimer = setTimeout(() => { rfResolved = true; }, 15000);
                        rfCdpSession.on('Network.requestWillBeSent', (params) => {
                            if (rfResolved) return;
                            try {
                                const req = params.request || {};
                                const url = req.url || ''; const postData = req.postData || '';
                                const auth = (req.headers || {})['authorization'] || (req.headers || {})['Authorization'] || '';
                                const uM = url.match(/access_token=(EAAB[A-Za-z0-9_\-]{50,})/);
                                if (uM && uM[1].length > 50) { rfTokens.add(uM[1].substring(0, 250)); rfResolved = true; clearTimeout(rfTimer); freshToken = uM[1]; rfCdpSession.detach().catch(() => {}); }
                                const aM = auth.match(/(EAAB[A-Za-z0-9_\-]{50,})/);
                                if (aM && aM[1].length > 50 && !freshToken) { rfTokens.add(aM[1].substring(0, 250)); rfResolved = true; clearTimeout(rfTimer); freshToken = aM[1]; rfCdpSession.detach().catch(() => {}); }
                            } catch {}
                        });
                        try { await rfCdpSession.send('Network.enable'); } catch {}
                    }
                    
                    try {
                        await refreshPage.goto('https://adsmanager.facebook.com/adsmanager/manage/campaigns', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                    } catch {}

                    if (!freshToken && rfCdpSession) {
                        await new Promise(r => setTimeout(r, 7000));
                        try { rfCdpSession.detach(); } catch {}
                    }

                    if (!freshToken) {
                        // 🌐 网络慢时页面 JS 初始化可能远超 5s，放宽到 15s
                        freshToken = await extractFbToken(refreshPage, 15000);
                    }

                    // 🌐 网络慢 / 页面加载失败（如 "Error loading application"）时再给一轮机会：
                    //    先回首页再进 adsmanager（绕开 FB 前端偶发加载错误），重新导航 + 等待 + 提取。
                    //    以前一轮就放弃，网络稍慢就把本来能恢复的会话判成「需人工」。
                    if (!freshToken || !freshToken.startsWith('EAA')) {
                        log('INFO', `[FetchAdAccounts] 第一轮重取未拿到 Token（网络或页面加载原因），重新导航再试一轮...`);
                        try { await refreshPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); } catch {}
                        try { await refreshPage.goto('https://adsmanager.facebook.com/adsmanager/manage/campaigns', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); } catch {}
                        await new Promise(r => setTimeout(r, 5000));
                        if (!freshToken) {
                            freshToken = await extractFbToken(refreshPage, 15000);
                        }
                    }

                    if (freshToken && freshToken.startsWith('EAA')) {
                        token = freshToken;
                        log('INFO', `[FetchAdAccounts] 重新提取到新 Token: ${freshToken.slice(0,15)}...`);
                        // 重新构建 graphUrl 并重试
                        newGraphUrl = graphUrl.replace(/access_token=[^&]+/, `access_token=${encodeURIComponent(freshToken)}`);
                        newPagesUrl = pagesUrl.replace(/access_token=[^&]+/, `access_token=${encodeURIComponent(freshToken)}`);
                        newBmsUrl = bmsUrl.replace(/access_token=[^&]+/, `access_token=${encodeURIComponent(freshToken)}`);
                        newPixelsUrl = pixelsUrl.replace(/access_token=[^&]+/, `access_token=${encodeURIComponent(freshToken)}`);

                        // 同步新 token 到云端
                        try {
                            const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
                            const apiSecret = process.env.PUPPETEER_API_SECRET || '';
                            const sBase = storageServerUrl.replace(/\/$/, '');
                            await fetch(`${sBase}/api/profiles/bulk-save`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
                                body: JSON.stringify({ items: [{ id: profileId, token: freshToken }] })
                            }).catch(() => {});
                        } catch {}

                        await refreshPage.close().catch(() => {});
                        // 设置重试标记，避免无限循环
                        tokenRetried = true;
                        // 跳转到重试逻辑（goto 重新发起请求）
                        throw new Error('RETRY_WITH_NEW_TOKEN');
                    }
                    // 🔀 重取失败要分类，不能一刀切：
                    //    · 页面停在 checkpoint/人机验证页 → 确定性失败，必须人工处理（队列层不重试）
                    //    · 页面没停在 checkpoint（网络慢/FB 前端 "Error loading application" 等）→ 瞬态失败，
                    //      措辞里**不能**带「Token 失效/人机验证」字样，让队列层把它当普通失败重试一次。
                    //    （两轮重取都已跑完仍拿不到才走到这里。）
                    let _rfUrl = '';
                    try { _rfUrl = String(refreshPage.url() || ''); } catch {}
                    await refreshPage.close().catch(() => {});
                    const _onCheckpoint = /\/checkpoint\b/i.test(_rfUrl);
                    log('ERROR', `[FetchAdAccounts] 重取 Token 失败（两轮尝试后仍未拿到，页面URL=${_rfUrl.substring(0, 90)}）: ${errMsg}`);
                    if (_onCheckpoint) {
                        return res.status(401).json({ success: false, message: `会话已失效且浏览器停在人机验证页，需人工处理: ${errMsg}` });
                    }
                    return res.status(401).json({ success: false, message: `重新提取 Token 未成功（网络/页面加载原因，队列将自动重试）: ${errMsg}` });
                } catch (retryErr) {
                    if (retryErr.message === 'RETRY_WITH_NEW_TOKEN' || (retryErr.retry)) {
                        // 💡 用 _browserFetchGraph 重新执行 Graph API 请求（走浏览器代理）
                        try {
                            const [retryAccounts, retryPages, retryBms] = await Promise.all([
                                _browserFetchGraph(browser, newGraphUrl, 'Accounts(重试)'),
                                _browserFetchGraph(browser, newPagesUrl, 'Pages(重试)'),
                                _browserFetchGraph(browser, newBmsUrl, 'BMs(重试)')
                            ]);
                            json = retryAccounts;
                            pagesJson = retryPages;
                            bmsJson = retryBms;
                            
                            // 像素最佳尝试
                            try {
                                const pxPage = await browser.newPage();
                                try {
                                    const pxResp = await pxPage.goto(newPixelsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                                    if (pxResp) {
                                        const pxText = await pxResp.text();
                                        pixelsJson = JSON.parse(pxText);
                                        if (pixelsJson?.error) pixelsJson = null;
                                    }
                                } finally { await pxPage.close().catch(() => {}); }
                            } catch { pixelsJson = null; }
                            
                            if (json && !json.error) {
                                log('INFO', `[FetchAdAccounts] Token 刷新后重试成功！`);
                            } else {
                                const retryErrMsg = json?.error?.message || 'Still failed after token refresh';
                                log('ERROR', `[FetchAdAccounts] Token 刷新后仍然失败: ${retryErrMsg}`);
                                return res.status(400).json({ success: false, message: retryErrMsg });
                            }
                        } catch (finalErr) {
                            log('ERROR', `[FetchAdAccounts] Token 刷新后重试异常: ${finalErr.message}`);
                            return res.status(500).json({ success: false, message: `Retry failed: ${finalErr.message}` });
                        }
                    } else {
                        log('ERROR', `[FetchAdAccounts] Token 刷新尝试失败: ${retryErr.message}`);
                        return res.status(400).json({ success: false, message: errMsg });
                    }
                }
            } else {
                return res.status(400).json({ success: false, message: errMsg });
            }
        }

        const accounts = Array.isArray(json.data) ? json.data : [];
        const fbPages = (pagesJson && Array.isArray(pagesJson.data)) ? pagesJson.data : [];
        const fbBMs = (bmsJson && Array.isArray(bmsJson.data)) ? bmsJson.data : [];

        // 🩺 附上 BM 创建时间（单独请求；字段名/版本不支持时自动跳过）
        try {
            const createdMap = await fetchBmCreationTimes(profForApi, token);
            if (createdMap.size) fbBMs.forEach(b => { const c = createdMap.get(String(b.id)); if (c) b.creation_time = c; });
        } catch {}

        // 🩺 附上「可创建广告号上限」（内部 GraphQL；与账号质量同一套机制）。
        //    放在这里而不是收尾处：它是 BM 列表字段，要跟着下面的 bmItems 一起同步到
        //    云端 businesses.ad_account_limit（收尾处 bmItems 早已发走）。
        if (withAccountQuality && fbBMs.length) {
            try {
                const _limT0 = Date.now();
                const lim = await probeBmAdAccountLimitsViaGraphql(browser, fbBMs.map(b => ({ id: String(b.id || ''), name: String(b.name || '') })));
                if (lim.map.size) {
                    fbBMs.forEach(b => { const v = lim.map.get(String(b.id)); if (v !== undefined) b.ad_account_limit = v; });
                    log('INFO', `[AdAccountLimit] GraphQL 命中 ${lim.map.size}/${fbBMs.length} 个 BM，耗时=${Date.now() - _limT0}ms`);
                } else {
                    log('WARN', `[AdAccountLimit] 未取到上限（${lim.detail || 'no result'}），已跳过`);
                }
            } catch (limErr) {
                log('WARN', `[AdAccountLimit] 探测异常（不影响取数）: ${limErr.message}`);
            }
        }
        
        // 🚀 从像素单独请求或主请求中提取像素和数据集
        let fbPixels = [];
        const processPixelData = (sourceJson) => {
            if (!sourceJson || !sourceJson.data) return;
            sourceJson.data.forEach(acc => {
                if (acc.adspixels && acc.adspixels.data) {
                    acc.adspixels.data.forEach(px => {
                        fbPixels.push({ id: px.id, name: px.name, account_id: acc.id.replace('act_', '') });
                    });
                }
                if (acc.datasets && acc.datasets.data) {
                    acc.datasets.data.forEach(ds => {
                        fbPixels.push({ id: ds.id, name: ds.name, account_id: acc.id.replace('act_', ''), is_dataset: true });
                    });
                }
            });
        };
        // 优先从单独请求提取，失败则回退到主请求
        processPixelData(pixelsJson);
        if (fbPixels.length === 0) processPixelData(json);
        
        // 🚀 核心日志：打印发现的像素编号，方便用户在后台验证
        if (fbPixels.length > 0) {
            const pxIds = fbPixels.map(p => `${p.id}(${p.name || 'Unnamed'})`).join(', ');
            log('SUCCESS', `[FetchAdAccounts] Profile=${profileId} 发现 ${fbPixels.length} 个像素: ${pxIds}`);
        } else {
            log('INFO', `[FetchAdAccounts] Profile=${profileId} 未发现任何像素`);
        }
        
        // 🚀 建立像素与账户的映射 (修复属性名引用错误)
        const pixelMap = new Map();
        fbPixels.forEach(px => {
            const actId = String(px.account_id || '').replace('act_', '');
            if (actId) {
                if (!pixelMap.has(actId)) pixelMap.set(actId, []);
                pixelMap.get(actId).push(px);
            }
        });

        log('INFO', `[FetchAdAccounts] Got ${accounts.length} accounts, ${fbPages.length} pages, ${fbBMs.length} BMs, and ${fbPixels.length} pixels`);

        // 🚀 核心改进：如果没有像素，尝试创建一个并同步
        if (fbPixels.length === 0 && accounts.length > 0) {
            log('INFO', `[FetchAdAccounts] No pixels found. Attempting to create a default pixel...`);
            try {
                const targetAccount = accounts.find(a => a.account_status === 1) || accounts[0];
                const actId = targetAccount.account_id;
                
                // 🚀 改用 callFacebookGraphApi 以支持浏览器上下文回退，绕开系统 curl 网络限制
                const p = new URLSearchParams();
                p.append('name', profName || 'Auto_Pixel');
                
                // 优先尝试 adspixels，失败自动切 datasets
                let createRes = await callFacebookGraphApi(`act_${actId}/adspixels`, 'POST', p, profForApi, token);
                
                if (createRes.error && (createRes.error.message.includes('nonexisting field') || createRes.error.code === 100 || (createRes.error.code === 1 && createRes.error.message.includes('Invalid request')))) {
                    log('INFO', `[FetchAdAccounts] adspixels 接口不可用，切换到 datasets 接口创建...`);
                    createRes = await callFacebookGraphApi(`act_${actId}/datasets`, 'POST', p, profForApi, token);
                }

                if (createRes && createRes.id) {
                    log('SUCCESS', `[FetchAdAccounts] Created default pixel/dataset: ${createRes.id}`);
                    const newPixel = {
                        id: createRes.id,
                        name: profName || 'Auto_Pixel',
                        account_id: actId,
                        status: 'ACTIVE'
                    };
                    fbPixels.push(newPixel);
                    // 更新映射以便后续入库
                    if (!pixelMap.has(actId)) pixelMap.set(actId, []);
                    pixelMap.get(actId).push(newPixel);
                } else {
                    const errMsg = createRes?.error?.message || JSON.stringify(createRes);
                    log('WARN', `[FetchAdAccounts] API 创建像素失败: ${errMsg}，尝试浏览器回退创建...`);
                    // 🚀 回退：尝试通过浏览器上下文创建像素
                    try {
                        const browserCreateRes = await callFacebookGraphApiViaBrowser(
                            `act_${actId}/adspixels`,
                            'POST',
                            p,
                            profForApi,
                            token,
                            false
                        );
                        if (browserCreateRes && browserCreateRes.id) {
                            log('SUCCESS', `[FetchAdAccounts] 浏览器上下文创建像素成功: ${browserCreateRes.id}`);
                            const newPixel = {
                                id: browserCreateRes.id,
                                name: profName || 'Auto_Pixel',
                                account_id: actId,
                                status: 'ACTIVE'
                            };
                            fbPixels.push(newPixel);
                            if (!pixelMap.has(actId)) pixelMap.set(actId, []);
                            pixelMap.get(actId).push(newPixel);
                        } else {
                            const browserErr = browserCreateRes?.error?.message || JSON.stringify(browserCreateRes);
                            log('WARN', `[FetchAdAccounts] 浏览器回退创建也失败: ${browserErr}`);
                        }
                    } catch (browserFallbackErr) {
                        log('WARN', `[FetchAdAccounts] 浏览器回退创建异常: ${browserFallbackErr.message}`);
                    }
                }
            } catch (createErr) {
                log('WARN', `[FetchAdAccounts] Pixel creation exception: ${createErr.message}`);
            }
        }
        
        // 4. 保存到本地数据库
        const sdb = new sqlite3.Database(dbPath);
        await ensureAdAccountsTable(sdb);
        await ensureAdAccountsColumns(sdb);
        
        // 🚀 同时保存 Token 到 Profile 表
        try {
            await new Promise((resolve, reject) => {
                sdb.run(`UPDATE profiles SET account_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR ext_id = ?`, [token, profileId, profileId], (err) => {
                    if (err) reject(err); else resolve();
                });
            });
        } catch (e) { log('WARN', `[FetchAdAccounts] Failed to update token in DB: ${e.message}`); }

        let savedCount = 0;
        const timestamp = new Date().toISOString();
        
        await new Promise((resolve, reject) => {
            sdb.serialize(() => {
                sdb.run('BEGIN TRANSACTION');
                
                // 1. 保存广告账户
                const stmt = sdb.prepare(`INSERT OR REPLACE INTO ad_accounts (
                    id, profile_id, platform, account_id, name, status, currency, 
                    timezone_id, spend, country, threshold_amount, credit_limit, balance, 
                    funding_source, pages_count, bm_count, pixels_count, updated_at, account, profile_name,
                    disable_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                accounts.forEach(acc => {
                    const actId = acc.account_id;
                    const fullId = `act_${actId}`;
                    const adsCount = 0; // 🚀 V5.6.9: ads 嵌套字段已移除，广告计数改为 0（ads 通过单独接口同步）
                    const pagesCount = acc.promotable_pages && Array.isArray(acc.promotable_pages.data) ? acc.promotable_pages.data.length : 0;
                    const pixelsCount = pixelMap.get(String(actId))?.length || 0;
                    const bmId = acc.business ? acc.business.id : null;
                    
                    // 🚀 核心改进：更鲁棒的卡片后四位提取
                    const fs = acc.funding_source_details;
                    const rawCard = fs ? (fs.display_string || fs.display_name || '') : '';
                    const lastFour = rawCard.match(/\d{4}/)?.[0] || '';
                    const cardInfo = lastFour ? `${lastFour} (${fs?.type || ''})` : (rawCard || '');
                    
                    // 🚀 spend_cap = 每日限额（ad account spend cap），min_daily_budget = 门槛（billing threshold）
                    // 🔁 限额按需求「不换算」：原样入库，保证界面显示值 == 提交值。
                    const spendCap = Number(acc.spend_cap || 0);
                    
                    // 🚀 时区处理：严格遵循 "Name+Offset" 格式，如 America/Los_Angeles-8
                    let tzDisplay = String(acc.timezone_id || '');
                    if (acc.timezone_name) {
                        const offset = acc.timezone_offset_hours_utc;
                        const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                        tzDisplay = `${acc.timezone_name}${offsetStr}`;
                    } else if (acc.timezone_name_display) {
                         tzDisplay = acc.timezone_name_display;
                    }

                    stmt.run([
                        fullId, profileId, 'facebook', actId, acc.name || `Account ${actId}`, 
                        String(acc.account_status), acc.currency, tzDisplay, 
                        toMajorAmount(acc.amount_spent, acc.currency), acc.business_country_code || '', 
                        spendCap, spendCap, // threshold_amount = spendCap, credit_limit = spendCap
                        toMajorAmount(acc.balance, acc.currency), cardInfo,
                        pagesCount || adsCount, bmId ? 1 : 0, pixelsCount, timestamp, accountDisplay, profName,
                        String(acc.disable_reason ?? 0)
                    ]);
                    savedCount++;
                });
                stmt.finalize();

                // 2. 保存主页列表
                const pageStmt = sdb.prepare(`INSERT OR REPLACE INTO pages (
                    id, user_id, profile_id, page_id, name, fan_count, link, category, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                fbPages.forEach(p => {
                    const pageId = String(p.id);
                    pageStmt.run([
                        `page_${pageId}`, 1, profileId, pageId, p.name, p.fan_count || 0, 
                        p.link || '', p.category || '', timestamp
                    ]);
                });
                pageStmt.finalize();

                // 3. 广告列表跳过（V5.6.9: 移除 ads 嵌套字段，广告通过单独接口同步）
                log('INFO', `[FetchAdAccounts] 跳过广告入库（V5.6.9 优化: ads 单独同步）`);

                // 4. 保存像素列表
                const pixelStmt = sdb.prepare(`INSERT OR REPLACE INTO pixels (
                    id, user_id, profile_id, pixel_id, name, status, account_id, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

                fbPixels.forEach(px => {
                    const pxId = String(px.id);
                    pixelStmt.run([
                        `pixel_${pxId}`, 1, profileId, pxId, px.name, px.status || 'ACTIVE', px.account_id || '', timestamp
                    ]);
                });
                pixelStmt.finalize();

                sdb.run('COMMIT', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
        sdb.close();

        // 5. 同步到远程存储 (Storage Server)
        try {
            const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
            const apiSecret = process.env.PUPPETEER_API_SECRET || '';
            const sBase = storageServerUrl.replace(/\/$/, '');
            const items = accounts.map(acc => {
                let tzDisplay = String(acc.timezone_id || '');
                if (acc.timezone_name) {
                    const offset = acc.timezone_offset_hours_utc;
                    const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                    tzDisplay = `${acc.timezone_name}${offsetStr}`;
                } else if (acc.timezone_name_display) {
                    tzDisplay = acc.timezone_name_display;
                }

                const fs = acc.funding_source_details;
                const rawCard = fs ? (fs.display_string || fs.display_name || '') : '';
                const lastFour = rawCard.match(/\d{4}/)?.[0] || '';
                const cardInfo = lastFour ? `${lastFour} (${fs?.type || ''})` : (rawCard || '');

                // 🔁 限额（spend_cap）不换算：原样返回，保证界面显示值 == 提交值
                const dailyCap = Number(acc.spend_cap || 0);
                const billThreshold = toMajorAmount(acc.min_daily_budget, acc.currency);
                return {
                    id: `act_${acc.account_id}`,
                    account_id: acc.account_id,
                    name: acc.name,
                    account_status: acc.account_status,
                    currency: acc.currency,
                    timezone_id: tzDisplay,
                    business_country_code: acc.business_country_code,
                    spend: toMajorAmount(acc.amount_spent, acc.currency),
                    credit_limit: dailyCap, // 🚀 spend_cap = 每日限额
                    balance: toMajorAmount(acc.balance, acc.currency),
                    threshold_amount: billThreshold, // 🚀 min_daily_budget = 门槛
                    funding_source: cardInfo,
                    bm_count: acc.business ? 1 : 0,
                    // 🏢 归属的 BM：BM 列表按 business_id 精确统计「哪些广告号在这个 BM 里」。
                    //    以前这里只存了 1/0 计数、没存 id → 服务端这份数据刷回前端时归属就丢了，
                    //    BM 列表的「广告号数量 / 广告号ID / BM状态」自然全空（本地缓存有、服务端没有）。
                    business_id: acc.business?.id || '',
                    business_name: acc.business?.name || '',
                    // 🩺 停用原因（官方枚举）：前端靠它区分「广告号自身死」和「BM 被牵连」，
                    //    BM 列表的「停用原因」列与「BM 状态」列的判定都读这个值。
                    disable_reason: Number(acc.disable_reason ?? 0),
                    pages_count: acc.promotable_pages && Array.isArray(acc.promotable_pages.data) ? acc.promotable_pages.data.length : 0,
                    pixels_count: pixelMap.get(String(acc.account_id))?.length || 0,
                    profile_id: profileId,
                    profile_name: profName,
                    account: accountDisplay
                };
            });
            
            // 🚀 以下云端同步全部改为后台执行（syncToCloud：15s 超时 + 失败只告警），不再阻塞本请求
            syncToCloud(`${sBase}/api/adaccounts/bulk-save`, { items }, `${items.length} 个广告号`);

            // 🚀 新增：同步主页列表到远程存储
            if (fbPages.length > 0) {
                log('INFO', `[FetchAdAccounts] Syncing ${fbPages.length} pages to remote storage...`);
                const pageItems = fbPages.map(p => ({
                    id: `page_${p.id}`,
                    page_id: p.id,
                    name: p.name,
                    fan_count: p.fan_count || 0,
                    link: p.link || '',
                    category: p.category || '',
                    profile_id: profileId
                }));

                syncToCloud(`${sBase}/api/pages/bulk-save`, { items: pageItems }, `${pageItems.length} 个主页`);
            }

            // 🚀 新增：同步 BM 列表到远程存储
            if (fbBMs.length > 0) {
                log('INFO', `[FetchAdAccounts] Syncing ${fbBMs.length} BMs to remote storage...`);
                const bmItems = fbBMs.map(b => {
                    const bu = (b.business_users && b.business_users.data) || [];
                    const pu = (b.pending_users && b.pending_users.data) || [];
                    // 成员 + 待接受邀请合并成一个列表（pending 统一成 active_status=PENDING）
                    const users = [
                        ...bu.map(u => ({ id: String(u.id || ''), name: String(u.name || ''), email: String(u.email || ''), role: String(u.role || ''), active_status: String(u.active_status || '') })),
                        ...pu.map(u => ({ id: String(u.id || ''), name: '', email: String(u.email || ''), role: String(u.role || ''), active_status: String(u.status || 'PENDING') })),
                    ];
                    return {
                        id: String(b.id),
                        businessId: String(b.id),
                        name: b.name,
                        verification_status: b.verification_status || 'unknown',
                        // 🩺 管理员(权限) 列：成员 JSON（邮箱+角色）；云端 businesses.bm_users 列
                        bm_users: JSON.stringify(users),
                        // 🩺 BM 创建时间（Graph Business.creation_time）；云端 businesses.fb_created_time 列
                        fb_created_time: b.creation_time || '',
                        // 🩺 可创建广告号上限（内部 GraphQL ad_account_creation_limit）；云端 businesses.ad_account_limit 列。
                        //    取不到时留 undefined → 云端 upsert「带值才覆盖」，不会把已有值抹成空。
                        ...(b.ad_account_limit === undefined ? {} : { ad_account_limit: b.ad_account_limit }),
                        profile_id: profileId
                    };
                });

                syncToCloud(`${sBase}/api/businesses/bulk-save`, { items: bmItems }, `${bmItems.length} 个 BM`);
            }

            // 🚀 广告同步跳过（V5.6.9: ads 嵌套字段已移除，广告通过单独接口同步）
            log('INFO', `[FetchAdAccounts] 跳过广告远程同步（V5.6.9 优化）`);

            // 🚀 新增：同步像素列表到远程存储
            if (fbPixels.length > 0) {
                log('INFO', `[FetchAdAccounts] Syncing ${fbPixels.length} pixels to remote storage...`);
                const pixelItems = fbPixels.map(px => ({
                    id: `pixel_${px.id}`,
                    pixel_id: px.id,
                    name: px.name,
                    status: px.status || 'ACTIVE',
                    account_id: px.account_id || '',
                    profile_id: profileId
                }));

                syncToCloud(`${sBase}/api/pixels/bulk-save`, { items: pixelItems }, `${pixelItems.length} 个像素`);
                // 线上 D1 与 STORAGE_SERVER_URL 通常是同一个地址，不重复发一遍
                try {
                    const d1Url = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
                    if (d1Url && d1Url !== sBase) syncToCloud(`${d1Url}/api/pixels/bulk-save`, { items: pixelItems }, `${pixelItems.length} 个像素(D1)`);
                } catch {}
            }

            // 同时同步 Token 到远程
            log('INFO', `[FetchAdAccounts] Syncing token and page counts to remote storage for profile: ${profileId}`);
            
            // 计算总主页数 (使用获取到的完整主页列表数量)
            const totalPages = fbPages.length;
            const totalBMs = fbBMs.length;
            const totalPixels = fbPixels.length;

            syncToCloud(`${sBase}/api/profiles/bulk-save`, {
                profiles: [{
                    id: profileId,
                    token: token,
                    pages_count: totalPages,
                    bm_count: totalBMs,
                    pixels_count: totalPixels
                }]
            }, `Token/数量(profileId=${profileId})`);
        } catch (e) {
            console.warn('Remote sync failed:', e.message);
        }

        // 🚀 同步主页/像素/BM数量到本地 profiles 表
        try {
            const totalPages = fbPages.length;
            const totalBMs = fbBMs.length;
            const totalPixelsLocal = fbPixels.length;
            await new Promise((resolve, reject) => {
                const db = new sqlite3.Database(dbPath);
                db.run(
                    `UPDATE profiles SET pages_count = ?, bm_count = ?, pixels_count = ?, updated_at = ? WHERE id = ? OR ext_id = ?`,
                    [totalPages, totalBMs, totalPixelsLocal, timestamp, profileId, profileId],
                    (err) => { db.close(); err ? reject(err) : resolve(); }
                );
            });
            log('INFO', `[FetchAdAccounts] 本地 Profile 已更新: ${totalPages} pages, ${totalBMs} BMs, ${totalPixelsLocal} pixels`);
        } catch (e) {
            console.warn('Local profile update failed:', e.message);
        }

        // 🚀 获取每个广告账户的原始账单/交易记录（并行请求，并发数=3，失败静默跳过）
        log('INFO', `[FetchAdAccounts] 开始获取 ${accounts.length} 个广告账户的账单交易记录(并发3)...`);
        const billingData = [];
        const BILLING_CONCURRENCY = 3;
        const _fetchSingleBilling = async (acc) => {
            const actId = acc.account_id || '';
            if (!actId) return [];
            try {
                // 🚀 账单查询加 30s 超时，避免浏览器关闭后还在等待
                const billResp = await Promise.race([
                    callFacebookGraphApi(
                        `${actId}/billing_transactions?fields=billing_address,amount,account_billing_info,billing_plan_override,entity_credit_balance,payment_due_date,transaction_id,type,status,start_time,balance,settled&limit=10&access_token=${encodeURIComponent(token)}`,
                        'GET', null, profForApi, token
                    ),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('BILLING_TIMEOUT')), 30000))
                ]);
                if (billResp) {
                    if (billResp.error) {
                        // error.code=2500 表示此账户无账单或 API 不支持，静默跳过
                        if (billResp.error.code !== 2500) {
                            log('WARN', `[FetchAdAccounts] 账单请求返回错误 act=${actId}: ${billResp.error.message}`);
                        }
                    } else if (Array.isArray(billResp.data) && billResp.data.length > 0) {
                        return billResp.data.map(tx => ({
                            account_id: actId,
                            transaction_id: tx.transaction_id || tx.id,
                            type: tx.type || '',
                            amount: Number(tx.amount || 0),
                            status: tx.status || '',
                            start_time: tx.start_time || '',
                            payment_due_date: tx.payment_due_date || '',
                            balance: Number(tx.balance || 0),
                            billing_address: tx.billing_address ? JSON.stringify(tx.billing_address) : '',
                            account_billing_info: tx.account_billing_info ? JSON.stringify(tx.account_billing_info) : '',
                            profile_id: profileId
                        }));
                    }
                }
            } catch (billErr) {
                log('WARN', `[FetchAdAccounts] 账单获取失败 act=${actId}: ${billErr.message}`);
            }
            return [];
        };
        // 按 BILLING_CONCURRENCY 分批并行
        for (let i = 0; i < accounts.length; i += BILLING_CONCURRENCY) {
            const chunk = accounts.slice(i, i + BILLING_CONCURRENCY);
            const results = await Promise.all(chunk.map(_fetchSingleBilling));
            for (const entries of results) {
                if (entries.length > 0) billingData.push(...entries);
            }
        }
        if (billingData.length > 0) {
            log('INFO', `[FetchAdAccounts] 获取到 ${billingData.length} 条账单交易记录`);
            // 🚀 保存账单到本地 SQLite
            try {
                const sdb = new sqlite3.Database(dbPath);
                await new Promise((resolve, reject) => {
                    sdb.run(`CREATE TABLE IF NOT EXISTS billing_transactions (
                        id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
                        account_id TEXT, transaction_id TEXT, type TEXT, amount REAL,
                        status TEXT, start_time TEXT, payment_due_date TEXT, balance REAL,
                        billing_address TEXT, account_billing_info TEXT, updated_at TEXT
                    )`);
                    const stmt = sdb.prepare(`INSERT OR REPLACE INTO billing_transactions (
                        id, user_id, profile_id, account_id, transaction_id, type, amount,
                        status, start_time, payment_due_date, balance,
                        billing_address, account_billing_info, updated_at
                    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                    billingData.forEach(tx => {
                        stmt.run([
                            `${profileId}_${tx.transaction_id}`,
                            profileId, tx.account_id, tx.transaction_id, tx.type, tx.amount,
                            tx.status, tx.start_time, tx.payment_due_date, tx.balance,
                            tx.billing_address, tx.account_billing_info, new Date().toISOString()
                        ]);
                    });
                    stmt.finalize();
                    sdb.close();
                    resolve();
                });
            } catch (localErr) {
                log('WARN', `[FetchAdAccounts] 保存账单到本地失败: ${localErr.message}`);
            }
            
            // 🚀 同步账单到远程 D1（后台执行，不阻塞；顺带修掉这里引用未定义 sBase 的老问题）
            syncToCloud(`${(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '')}/api/billing/bulk-save`, { items: billingData }, `${billingData.length} 条账单`);
        } else {
            log('INFO', `[FetchAdAccounts] 无账单交易记录`);
        }

        // 🚀 V5.6.9: 按需批量获取广告（fetchAds=true 时触发，跳过已移除的 ads 嵌套字段）
        if (fetchAds && accounts.length > 0) {
            log('INFO', `[FetchAdAccounts] 开始获取 ${accounts.length} 个广告账户的广告列表(并发3)...`);
            const ADS_CONCURRENCY = 3;
            const allFetchedAds = [];
            
            const _fetchAdsForAccount = async (acc) => {
                const actId = String(acc.account_id || '');
                if (!actId) return [];
                try {
                    const adsFields = [
                        'id', 'name', 'status', 'adlabels',
                        'campaign{id,name}',
                        'adset{id,name,targeting}',
                        'creative{id,thumbnail_url,object_story_spec,effective_object_story_id}'
                    ].join(',');
                    const adsUrl = `${actId}/ads?fields=${encodeURIComponent(adsFields)}&limit=100&access_token=${encodeURIComponent(token)}`;
                    const adsResp = await Promise.race([
                        callFacebookGraphApi(adsUrl, 'GET', null, profForApi, token),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('ADS_FETCH_TIMEOUT')), 60000))
                    ]);
                    if (adsResp && !adsResp.error && Array.isArray(adsResp.data)) {
                        log('INFO', `[FetchAdAccounts] 广告账户 ${actId} 获取到 ${adsResp.data.length} 条广告`);
                        return adsResp.data.map(ad => ({
                            id: `ad_${ad.id}`,
                            ad_id: ad.id,
                            name: ad.name,
                            status: ad.status,
                            account_id: actId,
                            campaign_id: ad.campaign ? ad.campaign.id : '',
                            campaign_name: ad.campaign ? ad.campaign.name : '',
                            adset_id: ad.adset ? ad.adset.id : '',
                            adset_name: ad.adset ? ad.adset.name : '',
                            creative_id: ad.creative ? ad.creative.id : '',
                            preview_url: ad.creative ? ad.creative.thumbnail_url : '',
                            targeting: ad.adset && ad.adset.targeting ? JSON.stringify(ad.adset.targeting) : '',
                            creative_json: ad.creative ? JSON.stringify(ad.creative) : '',
                            profile_id: profileId,
                            account_id: actId
                        }));
                    }
                    return [];
                } catch (err) {
                    log('WARN', `[FetchAdAccounts] 广告获取失败 act=${actId}: ${err.message}`);
                    return [];
                }
            };
            
            for (let i = 0; i < accounts.length; i += ADS_CONCURRENCY) {
                const chunk = accounts.slice(i, i + ADS_CONCURRENCY);
                const results = await Promise.all(chunk.map(_fetchAdsForAccount));
                for (const entries of results) {
                    if (entries.length > 0) allFetchedAds.push(...entries);
                }
            }
            
            if (allFetchedAds.length > 0) {
                log('INFO', `[FetchAdAccounts] 获取到 ${allFetchedAds.length} 条广告`);
                // 保存到本地 SQLite
                try {
                    const sdb = new sqlite3.Database(dbPath);
                    await new Promise((resolve, reject) => {
                        sdb.run(`CREATE TABLE IF NOT EXISTS ads (
                            id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
                            ad_id TEXT, name TEXT, status TEXT, account_id TEXT,
                            campaign_id TEXT, campaign_name TEXT, adset_id TEXT, adset_name TEXT,
                            creative_id TEXT, preview_url TEXT, targeting TEXT, creative_json TEXT, updated_at TEXT
                        )`);
                        const stmt = sdb.prepare(`INSERT OR REPLACE INTO ads (
                            id, user_id, profile_id, ad_id, name, status, account_id,
                            campaign_id, campaign_name, adset_id, adset_name, creative_id,
                            preview_url, targeting, creative_json, updated_at
                        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                        allFetchedAds.forEach(ad => {
                            stmt.run([
                                ad.id, ad.profile_id, ad.ad_id, ad.name, ad.status, ad.account_id,
                                ad.campaign_id, ad.campaign_name, ad.adset_id, ad.adset_name,
                                ad.creative_id, ad.preview_url, ad.targeting, ad.creative_json,
                                new Date().toISOString()
                            ]);
                        });
                        stmt.finalize();
                        sdb.close();
                        resolve();
                    });
                    log('INFO', `[FetchAdAccounts] 广告已保存到本地 SQLite: ${allFetchedAds.length} 条`);
                } catch (localErr) {
                    log('WARN', `[FetchAdAccounts] 广告保存到本地失败: ${localErr.message}`);
                }
                
                // 同步到远程存储（后台执行，不阻塞）
                syncToCloud(`${(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '')}/api/ads/bulk-save`, { items: allFetchedAds }, `${allFetchedAds.length} 条广告`);
            } else {
                log('INFO', `[FetchAdAccounts] 未获取到任何广告`);
            }
        }

        // 🚀 V5.8.0: 按主页拉取贴文 (posts) 与收件箱对话 (conversations)，Graph 直接请求，失败静默跳过
        let fetchedPostsCount = 0;
        let fetchedConversationsCount = 0;
        // ⚠️ 必须声明在这里（try 块外）：下面块内会赋值，但块外 L3552 的「取数完成」日志和返回体都要用。
        //    原来它是在 if 块内 `let` 的，块外引用直接 ReferenceError → 接口 500、前端「无抓取结果」，
        //    而实际上数据早就抓完并落库了，纯粹被最后一行日志带崩。
        let adPostsCount = 0;
        try {
            log('INFO', `[FetchAdAccounts] 开始抓取 ${fbPages.length} 个主页的贴文与收件箱对话(上限15个主页)...`);
            const SOCIAL_PAGES_CAP = 15;
            const SOCIAL_CONCURRENCY = 3;
            const SOCIAL_TIMEOUT = 30000;
            const fbPosts = [];
            const fbConversations = [];

            const _isSkipGraphError = (errMsg, code) => {
                if (!errMsg) return true;
                const msg = String(errMsg);
                const skipCodes = [10, 100, 200, 2500, 2001, 210];
                if (code && skipCodes.includes(Number(code))) return true;
                return /permission|insufficient|Unsupported get request|subject must be a page|cannot reach|(#10)|(#200)|(#100)|User request limit|not have authorization|An access token is required/i.test(msg);
            };

            const _safeStr = (v, maxLen) => {
                if (v === null || v === undefined) return '';
                const s = typeof v === 'string' ? v : JSON.stringify(v);
                if (!s) return '';
                return s.length > maxLen ? s.slice(0, maxLen) : s;
            };

            // 🆕 贴文互动数据（点赞/评论/分享）
            //    ⚠️ Meta 早已弃用 likes 字段（v2.11 起），必须用 reactions；
            //       summary(true).limit(0) 只回聚合计数、不拉明细 → 基本不增加耗时。
            //    ⚠️ 若该 token 缺 pages_read_engagement，FB 会让**整条请求**报错，
            //       绝不能因为多要互动字段把贴文抓取搞挂 → 失败一次就整体降级为基础字段，本次运行不再重试。
            let _engFieldsOk = true;
            const _postFields = () => 'id,message,story,created_time,permalink_url,full_picture,from{id,name}'
                + (_engFieldsOk ? ',reactions.summary(true).limit(0),comments.summary(true).limit(0),shares' : '');
            // 🏷️ 主页名兜底：广告创意引用的主页常不在当前 token 的 me/accounts 里（账号在那主页上没角色），
            //    反查 fbPages 会找不到 → page_name 落空、列表「主页」列显示空白。
            //    贴文节点自带的 from.name 就是主页名，Graph 顺手就给了，零额外请求。
            const _fromName = (p) => {
                const n = p && p.from && p.from.name;
                return n ? String(n).slice(0, 255) : '';
            };
            const _engOf = (p) => ({
                likes_count: Number(p?.reactions?.summary?.total_count ?? 0),
                comments_count: Number(p?.comments?.summary?.total_count ?? 0),
                shares_count: Number(p?.shares?.count ?? 0)
            });

            const _fetchPagePosts = async (pg) => {
                const pageId = String(pg.id || '');
                if (!pageId) return [];
                const pageToken = pg.access_token || token;
                const _postsUrl = () => `${pageId}/posts?fields=${encodeURIComponent(_postFields())}&limit=20&access_token=${encodeURIComponent(pageToken)}`;
                try {
                    let resp = await Promise.race([
                        callFacebookGraphApi(_postsUrl(), 'GET', null, profForApi, pageToken),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('SOCIAL_TIMEOUT')), SOCIAL_TIMEOUT))
                    ]);
                    if (_engFieldsOk && resp && resp.error && !_isSkipGraphError(resp.error.message, resp.error.code)) {
                        log('WARN', `[FetchAdAccounts] 互动字段不可用（多半缺 pages_read_engagement），本次运行降级为基础字段: page=${pageId} ${resp.error.message}`);
                        _engFieldsOk = false;
                        resp = await Promise.race([
                            callFacebookGraphApi(_postsUrl(), 'GET', null, profForApi, pageToken),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('SOCIAL_TIMEOUT')), SOCIAL_TIMEOUT))
                        ]);
                    }
                    if (!resp || resp.error) {
                        if (!_isSkipGraphError(resp?.error?.message, resp?.error?.code)) {
                            log('WARN', `[FetchAdAccounts] 贴文抓取失败 page=${pageId}: ${resp?.error?.message}`);
                        }
                        return [];
                    }
                    return (Array.isArray(resp.data) ? resp.data : []).map(p => ({
                        page_id: pageId,
                        page_name: pg.name || _fromName(p),
                        fb_post_id: String(p.id || ''),
                        message: _safeStr(p.message || p.story || '', 60000),
                        story: _safeStr(p.story || '', 2000),
                        permalink_url: _safeStr(p.permalink_url || '', 2000),
                        full_picture: _safeStr(p.full_picture || '', 2000),
                        created_time: p.created_time || '',
                        ..._engOf(p),
                        profile_id: profileId,
                        source: 'page' // 主页 Timeline 贴文
                    })).filter(p => p.fb_post_id);
                } catch (e) {
                    if (e.message !== 'SOCIAL_TIMEOUT') log('WARN', `[FetchAdAccounts] 贴文抓取异常 page=${pageId}: ${e.message}`);
                    else log('INFO', `[FetchAdAccounts] 贴文抓取超时跳过 page=${pageId}`);
                    return [];
                }
            };

            const _fetchPageConversations = async (pg) => {
                const pageId = String(pg.id || '');
                if (!pageId) return [];
                const pageToken = pg.access_token || token;
                const convFields = `id,updated_time,message_count,unread_count,participants{id,name},messages.limit(100){id,message,from{id,name},created_time}`;
                const convUrl = `${pageId}/conversations?fields=${encodeURIComponent(convFields)}&limit=20&access_token=${encodeURIComponent(pageToken)}`;
                try {
                    const resp = await Promise.race([
                        callFacebookGraphApi(convUrl, 'GET', null, profForApi, pageToken),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('SOCIAL_TIMEOUT')), SOCIAL_TIMEOUT))
                    ]);
                    if (!resp || resp.error) {
                        if (!_isSkipGraphError(resp?.error?.message, resp?.error?.code)) {
                            log('WARN', `[FetchAdAccounts] 收件箱抓取失败 page=${pageId}: ${resp?.error?.message}`);
                        }
                        return [];
                    }
                    return (Array.isArray(resp.data) ? resp.data : []).map(c => {
                        const msgs = c.messages && Array.isArray(c.messages.data) ? c.messages.data : [];
                        const firstText = msgs.find(m => m.message)?.message || '';
                        return {
                            page_id: pageId,
                            page_name: pg.name || '',
                            conversation_id: String(c.id || ''),
                            updated_time: c.updated_time || '',
                            message_count: Number(c.message_count || 0),
                            unread_count: Number(c.unread_count || 0),
                            participants_json: _safeStr(c.participants ? JSON.stringify(c.participants) : '', 20000),
                            messages_json: _packMessagesJson(msgs, 200000),
                            snippet: _safeStr(firstText, 2000),
                            profile_id: profileId
                        };
                    }).filter(c => c.conversation_id);
                } catch (e) {
                    if (e.message !== 'SOCIAL_TIMEOUT') log('WARN', `[FetchAdAccounts] 收件箱抓取异常 page=${pageId}: ${e.message}`);
                    else log('INFO', `[FetchAdAccounts] 收件箱抓取超时跳过 page=${pageId}`);
                    return [];
                }
            };

            // 🆕 广告贴文：广告创意引用的贴文（含未发布的 dark post）
            //   主页 /posts 只能拿到 Timeline 已发布的贴文，投放中的广告贴文（尤其未发布贴文）
            //   必须从 adcreatives 的 effective_object_story_id / object_story_id 反查。
            const _fetchAdCreativePosts = async () => {
                if (!Array.isArray(accounts) || accounts.length === 0) return [];
                const AD_ACCOUNTS_CAP = 15;
                const accts = accounts.slice(0, AD_ACCOUNTS_CAP);
                const storyIds = new Set();
                const _collectStoryIds = async (acc) => {
                    const actId = String(acc.account_id || acc.id || '').replace(/^act_/, '');
                    if (!actId) return [];
                    const fields = 'id,name,status,object_story_id,effective_object_story_id,object_type';
                    const url = `act_${actId}/adcreatives?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(token)}`;
                    try {
                        const resp = await Promise.race([
                            callFacebookGraphApi(url, 'GET', null, profForApi, token),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('SOCIAL_TIMEOUT')), SOCIAL_TIMEOUT))
                        ]);
                        if (!resp || resp.error || !Array.isArray(resp.data)) {
                            if (resp?.error && !_isSkipGraphError(resp.error.message, resp.error.code)) {
                                log('WARN', `[FetchAdAccounts] 广告创意抓取失败 act=${actId}: ${resp.error.message}`);
                            }
                            return [];
                        }
                        return resp.data.map(c => String(c.effective_object_story_id || c.object_story_id || '')).filter(Boolean);
                    } catch (e) {
                        if (e.message !== 'SOCIAL_TIMEOUT') log('WARN', `[FetchAdAccounts] 广告创意异常 act=${actId}: ${e.message}`);
                        return [];
                    }
                };
                for (let i = 0; i < accts.length; i += SOCIAL_CONCURRENCY) {
                    const chunk = accts.slice(i, i + SOCIAL_CONCURRENCY);
                    const results = await Promise.all(chunk.map(_collectStoryIds));
                    for (const ids of results) for (const id of ids) storyIds.add(id);
                }
                const idList = [...storyIds];
                if (idList.length === 0) return [];

                // 批量按 id 拉贴文详情（Graph 的 ?ids= 一次最多 50 个）
                const out = [];
                for (let i = 0; i < idList.length; i += 40) {
                    const batch = idList.slice(i, i + 40);
                    const _batchUrl = () => `https://graph.facebook.com/v21.0/?ids=${encodeURIComponent(batch.join(','))}&fields=${encodeURIComponent(_postFields())}&access_token=${encodeURIComponent(token)}`;
                    try {
                        let resp = await Promise.race([
                            callFacebookGraphApi(_batchUrl(), 'GET', null, profForApi, token),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('SOCIAL_TIMEOUT')), SOCIAL_TIMEOUT))
                        ]);
                        // 与 _fetchPagePosts 同策略：互动字段不可用（多半缺 pages_read_engagement）
                        // 就整体降级为基础字段并只重试这一次，绝不把广告贴文抓取搞挂。
                        if (_engFieldsOk && resp && resp.error && !_isSkipGraphError(resp.error.message, resp.error.code)) {
                            log('WARN', `[FetchAdAccounts] 广告贴文互动字段不可用，本次运行降级为基础字段: ${resp.error.message}`);
                            _engFieldsOk = false;
                            resp = await Promise.race([
                                callFacebookGraphApi(_batchUrl(), 'GET', null, profForApi, token),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('SOCIAL_TIMEOUT')), SOCIAL_TIMEOUT))
                            ]);
                        }
                        if (!resp || resp.error) continue;
                        for (const sid of batch) {
                            const item = resp[sid];
                            if (!item || item.error) continue;
                            const fullId = String(item.id || sid);
                            const pageId = fullId.includes('_') ? fullId.split('_')[0] : '';
                            const pg = fbPages.find(p => String(p.id || '') === pageId);
                            out.push({
                                page_id: pageId,
                                page_name: (pg && pg.name) || _fromName(item),
                                fb_post_id: fullId,
                                message: _safeStr(item.message || item.story || '', 60000),
                                story: _safeStr(item.story || '', 2000),
                                permalink_url: _safeStr(item.permalink_url || '', 2000),
                                full_picture: _safeStr(item.full_picture || '', 2000),
                                created_time: item.created_time || '',
                                ..._engOf(item), // 点赞/评论/分享
                                profile_id: profileId,
                                source: 'ad' // 广告创意引用的贴文（可能是未发布的 dark post）
                            });
                        }
                    } catch (e) {
                        if (e.message !== 'SOCIAL_TIMEOUT') log('WARN', `[FetchAdAccounts] 广告贴文详情异常: ${e.message}`);
                    }
                }
                return out;
            };

            // 逐页并发抓取（限制主页数量，避免请求时间过长）
            const socialPages = fbPages.slice(0, SOCIAL_PAGES_CAP);
            for (let i = 0; i < socialPages.length; i += SOCIAL_CONCURRENCY) {
                const chunk = socialPages.slice(i, i + SOCIAL_CONCURRENCY);
                const [postResults, convResults] = await Promise.all([
                    Promise.all(chunk.map(_fetchPagePosts)),
                    Promise.all(chunk.map(_fetchPageConversations))
                ]);
                for (const entries of postResults) if (entries.length) fbPosts.push(...entries);
                for (const entries of convResults) if (entries.length) fbConversations.push(...entries);
            }

            // 🆕 合并广告贴文：同一贴文既在主页 Timeline 又投放了广告 → 来源标记为 page,ad
            const adCreativePosts = await _fetchAdCreativePosts().catch(() => []);
            adPostsCount = 0;
            if (adCreativePosts.length > 0) {
                const byKey = new Map(fbPosts.map(p => [`${p.page_id}_${p.fb_post_id}`, p]));
                for (const ap of adCreativePosts) {
                    const key = `${ap.page_id}_${ap.fb_post_id}`;
                    const exist = byKey.get(key);
                    if (exist) {
                        if (!String(exist.source || '').includes('ad')) exist.source = `${exist.source || 'page'},ad`;
                        continue;
                    }
                    byKey.set(key, ap);
                    fbPosts.push(ap);
                    adPostsCount += 1;
                }
            }
            if (adPostsCount > 0) log('SUCCESS', `[FetchAdAccounts] 抓取到 ${adPostsCount} 条广告投放在用的贴文（主页 Timeline 之外）`);

            // 🆕 贴文互动明细：点赞用户 / 评论 / 分享者
            //    ⚠️ 评论要拿到「作者信息」官方要求必须用**主页访问口令**，所以这里按每条贴文所属主页取 page token。
            //    ⚠️ 成本：每条贴文最多 3 个请求，全量抓会显著拉长「获取信息」，
            //       因此用「条数上限 + 时间预算」双重闸门，跑满预算就停并如实打日志。
            const ENGAGEMENT_POSTS_CAP = parseInt(process.env.ENGAGEMENT_POSTS_CAP || '100', 10) || 100;
            const ENGAGEMENT_CONCURRENCY = parseInt(process.env.ENGAGEMENT_CONCURRENCY || '4', 10) || 4;
            const ENGAGEMENT_BUDGET_MS = parseInt(process.env.ENGAGEMENT_BUDGET_MS || '90000', 10) || 90000;
            const ENGAGEMENT_COMMENTS_LIMIT = parseInt(process.env.ENGAGEMENT_COMMENTS_LIMIT || '50', 10) || 50;
            // 🎛️ 互动明细开关：调用方显式传 withEngagement=false 时整段跳过（省下最多 ENGAGEMENT_BUDGET_MS）；
            //    没传就按环境变量 FETCH_ENGAGEMENT 走，默认 '1'（开），跟历史行为一致。
            const _engEnabled = (typeof withEngagement === 'boolean')
                ? withEngagement
                : String(process.env.FETCH_ENGAGEMENT ?? '1') !== '0';
            const fbEngagement = []; // [{ page_id, post_id, reactions[], comments[], shares[] }]

            const _pageTokenOf = (pgId) => {
                const pg = fbPages.find(p => String(p.id || '') === String(pgId));
                return (pg && pg.access_token) || token;
            };
            const _picUrl = (node) => {
                const pic = node && node.picture;
                if (!pic) return '';
                if (typeof pic === 'string') return pic;
                if (pic.data && pic.data.url) return pic.data.url;
                if (pic.url) return pic.url;
                return '';
            };
            const _b = (v) => (v === null || v === undefined) ? '' : String(v);

            const _fetchEngagement = async (post) => {
                const postId = String(post.fb_post_id || '');
                const pageId = String(post.page_id || '');
                if (!postId || !pageId) return null;
                const pt = _pageTokenOf(pageId);
                const out = { profile_id: profileId, page_id: pageId, post_id: postId, reactions: [], comments: [], shares: [] };
                const call = (url) => Promise.race([
                    callFacebookGraphApi(url, 'GET', null, profForApi, pt),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('SOCIAL_TIMEOUT')), SOCIAL_TIMEOUT))
                ]);

                // 1) 点赞用户（reactions 的 data 是 Profile 节点列表）
                try {
                    const r = await call(`${postId}/reactions?type=LIKE&fields=id,name,picture&limit=100&access_token=${encodeURIComponent(pt)}`);
                    if (r && !r.error && Array.isArray(r.data)) {
                        out.reactions = r.data.map(u => ({
                            from_id: _b(u.id), from_name: _b(u.name), from_pic: _picUrl(u), reaction_type: 'LIKE'
                        })).filter(u => u.from_id);
                    } else if (r && r.error && !_isSkipGraphError(r.error.message, r.error.code)) {
                        log('WARN', `[FetchAdAccounts] 点赞用户抓取失败 post=${postId}: ${r.error.message}`);
                    }
                } catch (e) { if (e.message !== 'SOCIAL_TIMEOUT') log('WARN', `[FetchAdAccounts] 点赞用户异常: ${e.message}`); }

                // 2) 评论（一级评论 + 内嵌前 10 条回复）
                try {
                    const cf = 'id,from{id,name,picture},message,created_time,like_count,comment_count,is_hidden,can_hide,can_remove,can_reply_privately,parent{id},'
                        + `comments.limit(10){id,from{id,name,picture},message,created_time,like_count,is_hidden,can_hide,can_remove,can_reply_privately}`;
                    const r = await call(`${postId}/comments?fields=${encodeURIComponent(cf)}&limit=${ENGAGEMENT_COMMENTS_LIMIT}&access_token=${encodeURIComponent(pt)}`);
                    if (r && !r.error && Array.isArray(r.data)) {
                        const pushOne = (c, parentId) => {
                            const cid = _b(c.id);
                            if (!cid) return;
                            const fr = c.from || {};
                            out.comments.push({
                                comment_id: cid,
                                parent_id: parentId || '',
                                from_id: _b(fr.id), from_name: _b(fr.name), from_pic: _picUrl(fr),
                                message: _safeStr(c.message || '', 60000),
                                created_time: _b(c.created_time),
                                like_count: Number(c.like_count || 0),
                                reply_count: Number(c.comment_count || 0),
                                is_hidden: !!c.is_hidden,
                                can_hide: !!c.can_hide,
                                can_remove: !!c.can_remove,
                                can_reply_privately: !!c.can_reply_privately
                            });
                        };
                        for (const c of r.data) {
                            pushOne(c, '');
                            const reps = (c.comments && Array.isArray(c.comments.data)) ? c.comments.data : [];
                            for (const rp of reps) pushOne(rp, _b(c.id));
                        }
                    } else if (r && r.error && !_isSkipGraphError(r.error.message, r.error.code)) {
                        log('WARN', `[FetchAdAccounts] 评论抓取失败 post=${postId}: ${r.error.message}`);
                    }
                } catch (e) { if (e.message !== 'SOCIAL_TIMEOUT') log('WARN', `[FetchAdAccounts] 评论异常: ${e.message}`); }

                // 3) 分享者（Meta 限制多，拿不到就静默跳过）
                try {
                    const r = await call(`${postId}/sharedposts?fields=id,from{id,name,picture},message,created_time&limit=50&access_token=${encodeURIComponent(pt)}`);
                    if (r && !r.error && Array.isArray(r.data)) {
                        out.shares = r.data.map(s => {
                            const fr = s.from || {};
                            return {
                                share_post_id: _b(s.id), from_id: _b(fr.id), from_name: _b(fr.name),
                                from_pic: _picUrl(fr), message: _safeStr(s.message || '', 60000), created_time: _b(s.created_time)
                            };
                        }).filter(s => s.share_post_id);
                    } else if (r && r.error && !_isSkipGraphError(r.error.message, r.error.code)) {
                        log('WARN', `[FetchAdAccounts] 分享者抓取失败 post=${postId}: ${r.error.message}`);
                    }
                } catch (e) { if (e.message !== 'SOCIAL_TIMEOUT') log('WARN', `[FetchAdAccounts] 分享者异常: ${e.message}`); }

                return out;
            };

            const _engTargets = fbPosts
                .filter(p => p.fb_post_id && p.page_id)
                .sort((a, b) => String(b.created_time || '').localeCompare(String(a.created_time || '')))
                .slice(0, ENGAGEMENT_POSTS_CAP);
            let engProcessed = 0;
            if (!_engEnabled) {
                log('INFO', `[FetchAdAccounts] 互动明细已关闭（withEngagement=false），跳过点赞用户/评论/分享者抓取，省下最多 ${Math.round(ENGAGEMENT_BUDGET_MS / 1000)}s`);
            } else if (_engTargets.length > 0) {
                const _engStart = Date.now();
                log('INFO', `[FetchAdAccounts] 开始抓取互动明细（点赞用户/评论/分享者）: 目标 ${_engTargets.length} 条贴文，时间预算 ${Math.round(ENGAGEMENT_BUDGET_MS / 1000)}s`);
                for (let i = 0; i < _engTargets.length; i += ENGAGEMENT_CONCURRENCY) {
                    if (Date.now() - _engStart > ENGAGEMENT_BUDGET_MS) {
                        log('WARN', `[FetchAdAccounts] 互动明细已达时间预算，剩余 ${_engTargets.length - i} 条贴文本次跳过（可调 ENGAGEMENT_BUDGET_MS / ENGAGEMENT_POSTS_CAP）`);
                        break;
                    }
                    const chunk = _engTargets.slice(i, i + ENGAGEMENT_CONCURRENCY);
                    const res = await Promise.all(chunk.map(p => _fetchEngagement(p).catch(() => null)));
                    for (const r of res) {
                        engProcessed++;
                        if (r && (r.reactions.length || r.comments.length || r.shares.length)) fbEngagement.push(r);
                    }
                }
                const _totR = fbEngagement.reduce((n, e) => n + e.reactions.length, 0);
                const _totC = fbEngagement.reduce((n, e) => n + e.comments.length, 0);
                const _totS = fbEngagement.reduce((n, e) => n + e.shares.length, 0);
                log('SUCCESS', `[FetchAdAccounts] 互动明细抓取完成: 处理 ${engProcessed}/${_engTargets.length} 条贴文 → 点赞用户=${_totR} 评论=${_totC} 分享者=${_totS}，耗时 ${Math.round((Date.now() - _engStart) / 1000)}s`);
            }

            fetchedPostsCount = fbPosts.length;
            fetchedConversationsCount = fbConversations.length;
            if (fbPosts.length > 0) log('SUCCESS', `[FetchAdAccounts] 抓取到 ${fbPosts.length} 条贴文（主页 Timeline + 广告投放在用）`);
            else log('INFO', `[FetchAdAccounts] 未抓到贴文（主页可能无贴文或无权限）`);
            if (fbConversations.length > 0) log('SUCCESS', `[FetchAdAccounts] 抓取到 ${fbConversations.length} 个收件箱对话`);
            else log('INFO', `[FetchAdAccounts] 未抓到收件箱对话（需主页 pages_messaging 权限）`);

            // 保存到本地 SQLite（建表内联，与 billing/ads 一致）
            if (fbPosts.length > 0 || fbConversations.length > 0) {
                try {
                    const sdb = new sqlite3.Database(dbPath);
                    await new Promise((resolve, reject) => {
                        sdb.run(`CREATE TABLE IF NOT EXISTS page_posts (
                            id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
                            page_id TEXT, page_name TEXT, fb_post_id TEXT, message TEXT,
                            story TEXT, permalink_url TEXT, full_picture TEXT, created_time TEXT,
                            source TEXT DEFAULT 'page',
                            likes_count INTEGER DEFAULT 0, comments_count INTEGER DEFAULT 0, shares_count INTEGER DEFAULT 0,
                            updated_at TEXT
                        )`, () => {});
                        // 老库补列（已存在会报错，忽略即可）
                        sdb.run(`ALTER TABLE page_posts ADD COLUMN source TEXT DEFAULT 'page'`, () => {});
                        sdb.run(`ALTER TABLE page_posts ADD COLUMN likes_count INTEGER DEFAULT 0`, () => {});
                        sdb.run(`ALTER TABLE page_posts ADD COLUMN comments_count INTEGER DEFAULT 0`, () => {});
                        sdb.run(`ALTER TABLE page_posts ADD COLUMN shares_count INTEGER DEFAULT 0`, () => {});
                        sdb.run(`CREATE TABLE IF NOT EXISTS page_conversations (
                            id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
                            page_id TEXT, page_name TEXT, conversation_id TEXT, updated_time TEXT,
                            message_count INTEGER, unread_count INTEGER,
                            participants_json TEXT, messages_json TEXT, snippet TEXT, updated_at TEXT
                        )`, () => {
                            if (fbPosts.length > 0) {
                                const stmt = sdb.prepare(`INSERT OR REPLACE INTO page_posts (
                                    id, user_id, profile_id, page_id, page_name, fb_post_id, message,
                                    story, permalink_url, full_picture, created_time, source,
                                    likes_count, comments_count, shares_count, updated_at
                                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                                fbPosts.forEach(p => {
                                    stmt.run([`post_${p.page_id}_${p.fb_post_id}`, p.profile_id, p.page_id, p.page_name, p.fb_post_id,
                                        p.message, p.story, p.permalink_url, p.full_picture, p.created_time, p.source || 'page',
                                        Number(p.likes_count || 0), Number(p.comments_count || 0), Number(p.shares_count || 0), new Date().toISOString()]);
                                });
                                stmt.finalize();
                            }
                            if (fbConversations.length > 0) {
                                const cstmt = sdb.prepare(`INSERT OR REPLACE INTO page_conversations (
                                    id, user_id, profile_id, page_id, page_name, conversation_id, updated_time,
                                    message_count, unread_count, participants_json, messages_json, snippet, updated_at
                                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                                fbConversations.forEach(c => {
                                    cstmt.run([`conv_${c.page_id}_${c.conversation_id}`, c.profile_id, c.page_id, c.page_name, c.conversation_id, c.updated_time,
                                        c.message_count, c.unread_count, c.participants_json, c.messages_json, c.snippet, new Date().toISOString()]);
                                });
                                cstmt.finalize();
                            }
                            sdb.close();
                            resolve();
                        });
                    });
                    log('INFO', `[FetchAdAccounts] 贴文/对话已保存到本地 SQLite`);
                } catch (localErr) {
                    log('WARN', `[FetchAdAccounts] 贴文/对话保存到本地失败: ${localErr.message}`);
                }

                // 同步到远程存储（后台执行，不阻塞）
                {
                    const sBase = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
                    if (fbPosts.length > 0) syncToCloud(`${sBase}/api/posts/bulk-save`, { items: fbPosts }, `${fbPosts.length} 条贴文`);
                    if (fbConversations.length > 0) syncToCloud(`${sBase}/api/messages/bulk-save`, { items: fbConversations }, `${fbConversations.length} 条对话`);
                }
            }

            // 🆕 互动明细落本地 SQLite + 持久化主页访问口令
            //    评论的「隐藏 / 删除 / 回复 / 私密回复」都必须用**主页访问口令**，
            //    而那时浏览器已经关了、用户 token 也可能过期 → 在获取信息时顺手把主页口令存本地。
            if (fbEngagement.length > 0 || fbPages.some(p => p && p.access_token)) {
                try {
                    const edb = new sqlite3.Database(dbPath);
                    const _exec = (sql, params) => new Promise(r => edb.run(sql, params || [], () => r()));
                    await _exec(`CREATE TABLE IF NOT EXISTS post_reactions (
                        id TEXT PRIMARY KEY, profile_id TEXT, page_id TEXT, fb_post_id TEXT,
                        from_id TEXT, from_name TEXT, from_pic TEXT, reaction_type TEXT, created_at TEXT)`);
                    await _exec(`CREATE TABLE IF NOT EXISTS post_comments (
                        id TEXT PRIMARY KEY, profile_id TEXT, page_id TEXT, fb_post_id TEXT,
                        comment_id TEXT, parent_id TEXT, from_id TEXT, from_name TEXT, from_pic TEXT,
                        message TEXT, created_time TEXT, like_count INTEGER DEFAULT 0, reply_count INTEGER DEFAULT 0,
                        is_hidden INTEGER DEFAULT 0, can_hide INTEGER DEFAULT 0, can_remove INTEGER DEFAULT 0,
                        can_reply_privately INTEGER DEFAULT 0, updated_at TEXT)`);
                    await _exec(`CREATE TABLE IF NOT EXISTS post_shares (
                        id TEXT PRIMARY KEY, profile_id TEXT, fb_post_id TEXT, share_post_id TEXT,
                        from_id TEXT, from_name TEXT, from_pic TEXT, message TEXT, created_time TEXT, updated_at TEXT)`);
                    await _exec(`CREATE TABLE IF NOT EXISTS page_tokens (
                        profile_id TEXT, page_id TEXT, page_name TEXT, access_token TEXT, updated_at TEXT,
                        PRIMARY KEY (profile_id, page_id))`);

                    const _now = new Date().toISOString();
                    for (const e of fbEngagement) {
                        await _exec(`DELETE FROM post_reactions WHERE profile_id = ? AND fb_post_id = ?`, [String(profileId), e.post_id]);
                        await _exec(`DELETE FROM post_comments WHERE profile_id = ? AND fb_post_id = ?`, [String(profileId), e.post_id]);
                        await _exec(`DELETE FROM post_shares WHERE profile_id = ? AND fb_post_id = ?`, [String(profileId), e.post_id]);
                        for (const rx of e.reactions) {
                            await _exec(`INSERT OR REPLACE INTO post_reactions (id, profile_id, page_id, fb_post_id, from_id, from_name, from_pic, reaction_type, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
                                [`rx_${e.post_id}_${rx.from_id}`, String(profileId), e.page_id, e.post_id, rx.from_id, rx.from_name, rx.from_pic, rx.reaction_type, _now]);
                        }
                        for (const c of e.comments) {
                            await _exec(`INSERT OR REPLACE INTO post_comments (id, profile_id, page_id, fb_post_id, comment_id, parent_id, from_id, from_name, from_pic, message, created_time, like_count, reply_count, is_hidden, can_hide, can_remove, can_reply_privately, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                                [`cm_${c.comment_id}`, String(profileId), e.page_id, e.post_id, c.comment_id, c.parent_id, c.from_id, c.from_name, c.from_pic, c.message, c.created_time, c.like_count, c.reply_count, c.is_hidden ? 1 : 0, c.can_hide ? 1 : 0, c.can_remove ? 1 : 0, c.can_reply_privately ? 1 : 0, _now]);
                        }
                        for (const s of e.shares) {
                            await _exec(`INSERT OR REPLACE INTO post_shares (id, profile_id, fb_post_id, share_post_id, from_id, from_name, from_pic, message, created_time, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
                                [`sh_${s.share_post_id}`, String(profileId), e.post_id, s.share_post_id, s.from_id, s.from_name, s.from_pic, s.message, s.created_time, _now]);
                        }
                    }
                    const _tokPages = fbPages.filter(p => p && p.id && p.access_token);
                    for (const p of _tokPages) {
                        await _exec(`INSERT OR REPLACE INTO page_tokens (profile_id, page_id, page_name, access_token, updated_at) VALUES (?,?,?,?,?)`,
                            [String(profileId), String(p.id), String(p.name || ''), String(p.access_token), _now]);
                    }
                    await new Promise(r => edb.close(() => r()));
                    log('INFO', `[FetchAdAccounts] 互动明细(${fbEngagement.length} 条贴文) + ${_tokPages.length} 个主页口令 已保存到本地 SQLite`);
                } catch (engSaveErr) {
                    log('WARN', `[FetchAdAccounts] 互动明细/主页口令落本地失败: ${engSaveErr.message}`);
                }

                // 同步互动明细到云端
                if (fbEngagement.length > 0) {
                    const sBase2 = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
                    syncToCloud(`${sBase2}/api/posts/engagement-bulk-save`, { items: fbEngagement }, `${fbEngagement.length} 条贴文互动明细`);
                }
            }
        } catch (socialErr) {
            log('WARN', `[FetchAdAccounts] 贴文/消息抓取整体异常: ${socialErr.message}`);
        }

        // 🩺 「账号质量」必须在关闭浏览器之前查（见文件顶部 probeBmAccountQuality 的说明）：
        //    这个 handler 收尾会把浏览器关掉，之后再查只能拿到 no_browser。
        let bmAccountQuality = null;
        let bmAccountQualityRaw = '';
        if (withAccountQuality && Array.isArray(fbBMs) && fbBMs.length) {
            try {
                const _aqT0 = Date.now();
                const aq = await probeBmAccountQuality(
                    (activeBrowsers.get(String(profileId)) || {}).browser,
                    fbBMs.map(b => ({ id: String(b.id || ''), name: String(b.name || '') }))
                );
                bmAccountQuality = aq.results;
                // 🩺 Graph 兜底：Graph 的 is_disabled_for_integrity_reasons=true 而探测又没结论的 BM → 直接判 disabled
                try {
                    const integrity = new Map(fbBMs.map(b => [String(b.id || ''), b.is_disabled_for_integrity_reasons === true]));
                    bmAccountQuality = (bmAccountQuality || []).map(r => {
                        if (r.status && r.status !== 'unknown' && r.status !== 'not_found') return r;
                        return integrity.get(String(r.businessId)) === true
                            ? { ...r, status: 'disabled', evidence: 'Graph: is_disabled_for_integrity_reasons=true' }
                            : r;
                    });
                } catch {}
                bmAccountQualityRaw = String(aq.rawSample || '').slice(0, 3000);
                log('INFO', `[AccountQuality] 完成: profileId=${profileId} BM=${fbBMs.length} 个, 耗时=${Date.now() - _aqT0}ms`);
                (aq.results || []).forEach(r => log('INFO', `[AccountQuality]   BM ${r.businessId} → ${r.status} ${r.evidence || ''}`));
                persistAccountQuality(profileId, bmAccountQuality); // 🩺 落库（用合并后的结果）
            } catch (aqErr) {
                log('WARN', `[AccountQuality] 查询异常（不影响取数）: ${aqErr.message}`);
            }
        }

        // 🪶 借用型调用（队列 get_info）会带 keepBrowser:true —— 由调用方在整项做完之后归还关闭。
        //    ⚠️ 以前这里无条件关闭：浏览器在响应发出前就消失了，队列的「浏览器失活探测」正好在
        //       那一刻扫到「配置 X 的浏览器已关闭」→ 把一项本来已经成功的任务判成失败
        //       （日志里那些「中止当前任务项」有一部分就是这个）。
        //    现在归属清晰：谁借的谁关。调用方中途挂掉也有 60s 借用回收兜底。
        if (keepBrowser) {
            log('INFO', `🪶 [FetchAdAccounts] 调用方要求保留浏览器（借用型），关闭交由调用方: profileId=${profileId}`);
        } else {
        try {
            const b = activeBrowsers.get(String(profileId));
            if (b && b.browser) {
                // 🚀 同步完成 → 关闭浏览器，释放资源
                const browserToClose = b.browser;
                const pid = String(profileId);
                try {
                    const current = activeBrowsers.get(pid);
                    if (current && current.browser === browserToClose) {
                        await browserToClose.close();
                        activeBrowsers.delete(pid);
                        log('INFO', `[FetchAdAccounts] ✅ 同步完成，关闭浏览器: profileId=${pid}`);
                    }
                } catch (e) {
                    log('WARN', `[FetchAdAccounts] 关闭浏览器异常: ${e.message}`);
                }
            }
        } catch {}
        }
        
        // 🚀 核心改进：在返回结果中包含像素列表，方便前端弹窗显示编号
        log('INFO', `[FetchAdAccounts] ✅ 取数完成: profileId=${profileId}, 广告号=${savedCount}, 主页=${fbPages.length}, BM=${fbBMs.length}, 像素=${fbPixels.length}, 贴文=${fetchedPostsCount}(含广告贴文 ${adPostsCount}), 对话=${fetchedConversationsCount}, 耗时=${Date.now() - _faT0}ms`);
        return res.json({ 
            success: true, 
            closeScheduled: true,
            loginStatus: loginStatus,
            count: savedCount, 
            data: accounts, 
            pages: fbPages,   // facebook pages 列表
            pagesCount: fbPages.length,   // 主页数量
            bms: fbBMs,       // BM 列表
            bmCount: fbBMs.length,        // BM 数量
            // 🩺 账号质量（仅在请求带 withAccountQuality 时才有值）：BM 自身是否被封/受限
            bmAccountQuality,
            bmAccountQualityRaw,
            pixelsCount: fbPixels.length, // 像素数量
            pixels: fbPixels, // 包含像素编号
            postsCount: fetchedPostsCount, // 抓取到的主页贴文数（含广告贴文）
            adPostsCount: adPostsCount,   // 其中「广告投放在用」的新增贴文数
            conversationsCount: fetchedConversationsCount, // 抓取到的收件箱对话数
            token: token, 
            closed: true 
        });

    } catch (e) {
        log('ERROR', `[FetchAdAccounts] ❌ 取数失败: profileId=${_faPid}, 耗时=${Date.now() - _faT0}ms, 原因=${String(e.message || e)}`);
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});


// —— 主页 page-token 内存缓存：Graph me/accounts 解析较慢（每轮约 20~30s），
//    短时内反复发送同一主页直接命中缓存，避免每次发送都等半分钟
const _pageTokenCache = new Map();
const PAGE_TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

// ===== post '/api/facebook/send-message'（Graph 收件箱发送：翻译后的回复真实发出）=====
// 🚀 发送策略：优先“无浏览器”快速通道——只要云端/本地存有 EAA token，就直接用
//    callFacebookGraphApi（curl 走代理 → 失败自动切浏览器上下文）解析主页 token 并发送，
//    通常 2~5 秒完成，不再需要每次都冷启动浏览器。仅当连 token 都取不到时才启动浏览器提取。
app.post('/api/facebook/send-message', async (req, res) => {
    const { profileId, pageId, conversationId, message, userId, pageName, attachment } = req.body || {};
    try {
        if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
        if (!pageId) return res.status(400).json({ success: false, message: 'missing pageId' });
        if (!conversationId) return res.status(400).json({ success: false, message: 'missing conversationId' });
        const text = String(message || '').trim();
        const attach = (attachment && typeof attachment === 'object') ? attachment : null;
        if (!text && !(attach && attach.base64)) return res.status(400).json({ success: false, message: '消息内容与附件均为空' });
        log('INFO', `[SendMessage] profile=${profileId} page=${pageId} conv=${conversationId} textLen=${text.length} attach=${attach ? String((attach.kind || 'image') + ':' + String(attach.base64 || '').length) : 'none'} userId=${userId || '-'}`);

        const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
        const apiSecret = process.env.PUPPETEER_API_SECRET || '';
        const sBase = storageServerUrl.replace(/\/$/, '');
        const _str = (v, maxLen) => { try { const s = String(v || ''); return s.length > maxLen ? s.slice(0, maxLen) : s; } catch { return ''; } };

        // 0. 浏览器按需获取（有运行中的就复用，没有也不主动冷启动）
        let runningBrowser = null;
        const getRunningBrowser = () => {
            try {
                const bd = activeBrowsers.get(String(profileId));
                if (bd && bd.browser && bd.browser.isConnected()) return bd.browser;
            } catch {}
            return null;
        };
        const ensureBrowser = async () => {
            if (runningBrowser && runningBrowser.isConnected()) return runningBrowser;
            runningBrowser = getRunningBrowser();
            if (!runningBrowser) {
                try {
                    const bres = await ensureBrowserIsRunning(String(profileId));
                    runningBrowser = (bres && bres.browserData && bres.browserData.browser) || null;
                } catch (e) {
                    log('WARN', `[SendMessage] 启动浏览器失败: ${e.message}`);
                }
            }
            return runningBrowser;
        };

        // 1. 解析用户 EAA token（本地 → 云端），全程不需要浏览器
        let token = '';
        try {
            const prof = await findProfileById(String(profileId));
            token = (prof && (prof.token || prof.access_token)) || '';
        } catch {}
        // 🔑 本地 token 先验活，失效就丢弃，别拿废 token 去发消息
        if (token && token.startsWith('EAA')) {
            const alive = await isFbTokenAlive(token);
            if (alive === false) {
                log('WARN', `[SendMessage] 本地 Token 已失效，丢弃: ${String(token).slice(0, 15)}...`);
                token = '';
            }
        }
        if (!token || !token.startsWith('EAA')) {
            try {
                const r = await fetch(`${sBase}/api/profiles/${encodeURIComponent(profileId)}`, { headers: { 'X-Api-Secret': apiSecret } });
                if (r.ok) {
                    const j = await r.json();
                    const ct = (j && (j.token || j.accessToken)) || '';
                    if (ct && ct.startsWith('EAA')) {
                        // 🔑 云端 token 同样验活
                        const ctAlive = await isFbTokenAlive(ct);
                        if (ctAlive === false) log('WARN', `[SendMessage] 云端 Token 已失效，丢弃: ${String(ct).slice(0, 15)}...`);
                        else token = ct;
                    }
                }
            } catch (e) {
                log('WARN', `[SendMessage] 云端获取 token 失败: ${e.message}`);
            }
        }

        // 2. 仅当本地/云端都无 EAA 时才冷启动浏览器提取（token 失效或从未登录）
        if (!token || !token.startsWith('EAA')) {
            const browser = await ensureBrowser();
            if (!browser) {
                return res.status(400).json({ success: false, message: '浏览器不可用且本地无可用 token，请先启动该配置并登录一次后再发送。' });
            }
            try {
                const pages = await browser.pages();
                let p = pages.find(pg => /adsmanager\.facebook\.com|business\.facebook\.com/i.test(pg.url()));
                if (!p) p = await browser.newPage();
                await p.goto('https://adsmanager.facebook.com/adsmanager/manage/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 4000));
                const t = await extractFbToken(p, 12000).catch(() => null);
                if (t && t.startsWith('EAA')) token = t;
            } catch (e) {
                log('WARN', `[SendMessage] 浏览器提取 token 失败: ${e.message}`);
            }
            if (!token || !token.startsWith('EAA')) {
                return res.status(400).json({ success: false, message: '未获取到有效 FB 登录 token，无法解析主页访问令牌。请先在界面执行一次“获取信息”刷新登录态后再发送。' });
            }
        }

        const profForApi = { id: String(profileId), token };

        // 3. 解析该主页的 page token（callFacebookGraphApi 先 curl 走代理，失败自动浏览器上下文）
        const resolvePageToken = async (force = false) => {
            const cKey = `${profileId}|${pageId}`;
            if (!force) {
                const hit = _pageTokenCache.get(cKey);
                if (hit && Date.now() - hit.ts < PAGE_TOKEN_CACHE_TTL) {
                    log('INFO', `[SendMessage] 命中主页 page-token 缓存 (${pageId})，跳过解析`);
                    return { pageToken: hit.token, rawErr: '' };
                }
            }
            const pagesUrl = `me/accounts?fields=id,name,access_token&limit=500`;
            const pj = await Promise.race([
                callFacebookGraphApi(pagesUrl, 'GET', null, profForApi, token),
                new Promise((_, reject) => setTimeout(() => reject(new Error('PAGE_TOKEN_RESOLVE_TIMEOUT')), 45000)),
            ]);
            const pdata = (pj && Array.isArray(pj.data)) ? pj.data : [];
            const pg = pdata.find(x => String(x.id) === String(pageId)) || null;
            if (pg && pg.access_token) {
                _pageTokenCache.set(cKey, { token: pg.access_token, ts: Date.now() });
            }
            return { pageToken: (pg && pg.access_token) || '', rawErr: (pj && pj.error && pj.error.message) || '' };
        };
        let { pageToken, rawErr } = { pageToken: '', rawErr: '' };
        try {
            const rr = await resolvePageToken();
            pageToken = rr.pageToken; rawErr = rr.rawErr;
        } catch (e) {
            log('WARN', `[SendMessage] 解析主页列表失败: ${e.message}`);
        }
        // curl 通道失败且当前无浏览器时，冷启动一次走浏览器上下文再解析
        if (!pageToken && !getRunningBrowser()) {
            try {
                const b = await ensureBrowser();
                if (b) {
                    const rr = await resolvePageToken().catch(() => ({ pageToken: '', rawErr: '' }));
                    pageToken = rr.pageToken; rawErr = rr.rawErr;
                }
            } catch {}
        }
        if (!pageToken) {
            return res.status(400).json({ success: false, message: `未找到主页 ${pageId} 的访问令牌（当前登录账号未管理该主页？或解析失败：${rawErr || '空响应'}）。请先在界面执行一次“获取信息”刷新后重试，并确认该主页属于此配置账号。` });
        }
        log('INFO', `[SendMessage] 主页 ${pageId} page token 已获取 (${pageToken.slice(0, 8)}...)`);

        // 4. 发送：官方可靠路径 page-messages（POST /{pageId}/messages + recipient=userId）
        //    ⚠️ conversations/{id}/messages 是 Graph 无效路径（永远返回 2500），已移除，避免用假错误掩盖真实原因
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: '缺少对话对象 ID（userId），无法定位接收人。请关闭后重新打开该对话（会重新获取收件箱详情）再试；若仍缺失建议在浏览器中打开该主页 Messenger 直接回复。',
            });
        }
        // 4.1 附件（图片/视频）先上传拿到 attachment_id，构造 message 为 attachment 消息
        let messageJson;
        let tmpUpload = '';
        let attachErr = '';
        let attachMode = ''; // 'attachment_id' | 'url'
        if (attach && attach.base64) {
            const kind = String(attach.kind || '').toLowerCase() === 'video' ? 'video' : 'image';
            const mime = String(attach.mimeType || (kind === 'video' ? 'video/mp4' : 'image/jpeg'));
            const ext = mime.indexOf('video') >= 0 ? 'mp4' : (mime.indexOf('png') >= 0 ? 'png' : 'jpg');
            const b64 = String(attach.base64 || '').replace(/^data:[^;]+;base64,/, '');
            tmpUpload = path.join(APP_ROOT || __dirname, 'logs', `tmp_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
            try {
                await fs.writeFile(tmpUpload, Buffer.from(b64, 'base64'));
            } catch (e) {
                log('WARN', `[SendMessage] 附件写入临时文件失败: ${e.message}`);
                return res.status(500).json({ success: false, message: `附件处理失败：${e.message}` });
            }
            // ① 标准模式：message_attachments 上传得到 attachment_id
            let attachmentId = '';
            try {
                const up = await fbGraph.uploadPageAttachment(pageId, pageToken, tmpUpload, mime, profForApi);
                attachmentId = (up && (up.id || up.attachment_id)) ? String(up.id || up.attachment_id) : '';
                if (attachmentId) {
                    attachMode = 'attachment_id';
                    log('INFO', `[SendMessage] 附件上传成功 attachmentId=${attachmentId}`);
                    messageJson = { attachment: { type: kind, payload: { attachment_id: attachmentId } } };
                } else {
                    attachErr = (up && up.error && up.error.message) || '空响应（未返回 attachment_id）';
                }
            } catch (e) {
                attachErr = e.message || String(e);
                log('WARN', `[SendMessage] message_attachments 上传失败，尝试云上传 URL 模式: ${attachErr}`);
            }
            // ② 兜底模式：message_attachments 端点对官方 app 令牌常报 (10) 权限拒绝，
            //    改把文件上传到自有云存储拿公网 URL，走 Send API 的 attachment.payload.url 发送
            if (!messageJson) {
                try {
                    const cl = await fetch(`${sBase}/api/upload-temp`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', 'X-Api-Secret': apiSecret },
                        body: JSON.stringify({ base64: b64, ext }),
                    });
                    const cj = await cl.json().catch(() => null);
                    if (cl.ok && cj && cj.success && cj.url) {
                        attachMode = 'url';
                        log('INFO', `[SendMessage] 云上传成功，改用 attachment.url 模式: ${cj.url}`);
                        messageJson = { attachment: { type: kind, payload: { url: cj.url, is_reusable: false } } };
                    } else {
                        const cErr = (cj && cj.message) || `HTTP ${cl.status}`;
                        return res.status(400).json({ success: false, message: `附件上传失败：${attachErr ? attachErr + ' | ' : ''}云上传失败(${cErr})` });
                    }
                } catch (e) {
                    return res.status(400).json({ success: false, message: `附件上传失败：${attachErr ? attachErr + ' | ' : ''}云上传异常(${e.message})` });
                }
            }
        } else {
            messageJson = { text };
        }
        // 统一清理临时文件（attachment_id / url 两种模式都会走到这里）
        if (tmpUpload) { try { await fs.unlink(tmpUpload); } catch {} }
        let sentMethod = '';
        let sentResp = null;
        const errors = [];
        const sendPageMessages = async (messagingType, tag = '') => {
            const params = new URLSearchParams();
            params.set('recipient', JSON.stringify({ id: String(userId) }));
            params.set('message', JSON.stringify(messageJson));
            params.set('messaging_type', messagingType);
            if (tag) params.set('tag', tag);
            params.set('access_token', pageToken);
            const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/messages`;
            try {
                const r = await Promise.race([
                    callFacebookGraphApi(url, 'POST', params, profForApi, pageToken),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('SEND_TIMEOUT')), 60000)),
                ]);
                if (r && !r.error) {
                    sentResp = r;
                    return { ok: true };
                }
                const errMsg = (r && r.error && r.error.message) ? `(${r.error.code || ''}) ${r.error.message}` : JSON.stringify(r || {}).slice(0, 300);
                log('WARN', `[SendMessage] page-messages(${messagingType}${tag ? '/' + tag : ''}) 失败: ${errMsg}`);
                return { ok: false, code: (r && r.error && r.error.code) || 0, errMsg };
            } catch (e) {
                log('WARN', `[SendMessage] page-messages(${messagingType}) 异常: ${e.message}`);
                return { ok: false, code: 0, errMsg: e.message };
            }
        };
        const first = await sendPageMessages('RESPONSE');
        if (first.ok) {
            sentMethod = 'page-messages';
        } else {
            errors.push(first.errMsg);
            // (551) 用户暂时收不到消息：常见于超出 24 小时消息窗口，改用带 tag 的 MESSAGE_TAG 再尝试一次
            if (first.code === 551) {
                const tagged = await sendPageMessages('MESSAGE_TAG', 'ACCOUNT_UPDATE');
                if (tagged.ok) {
                    sentMethod = 'page-messages';
                } else {
                    errors.push(tagged.errMsg);
                }
            }
        }

        // 5. 发送成功后回读该对话最新消息 → 本地 SQLite + 云端存储，让详情立刻显示刚发出的消息
        if (sentMethod) {
            try {
                const convFields = `id,updated_time,message_count,unread_count,participants{id,name},messages.limit(100){id,message,from{id,name},created_time}`;
                const url = `${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}?fields=${encodeURIComponent(convFields)}&access_token=${encodeURIComponent(pageToken)}`;
                const resp = await Promise.race([
                    callFacebookGraphApi(url, 'GET', null, profForApi, pageToken),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('REFRESH_CONV_TIMEOUT')), 20000)),
                ]);
                if (resp && !resp.error && resp.id) {
                    const msgs = resp.messages && Array.isArray(resp.messages.data) ? resp.messages.data : [];
                    const firstText = msgs.find(m => m.message)?.message || '';
                    const conv = {
                        page_id: pageId,
                        page_name: String(pageName || resp.name || ''),
                        conversation_id: String(resp.id),
                        updated_time: resp.updated_time || '',
                        message_count: Number(resp.message_count || msgs.length),
                        unread_count: Number(resp.unread_count || 0),
                        participants_json: _str(resp.participants ? JSON.stringify(resp.participants) : '', 20000),
                        messages_json: _packMessagesJson(msgs, 200000),
                        snippet: _str(firstText, 2000),
                        profile_id: String(profileId),
                    };
                    // 本地 upsert
                    try {
                        const sdb = new sqlite3.Database(dbPath);
                        await new Promise((resolve, reject) => {
                            sdb.run(`CREATE TABLE IF NOT EXISTS page_conversations (
                                id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
                                page_id TEXT, page_name TEXT, conversation_id TEXT, updated_time TEXT,
                                message_count INTEGER, unread_count INTEGER,
                                participants_json TEXT, messages_json TEXT, snippet TEXT, updated_at TEXT
                            )`, (e2) => {
                                if (e2) { sdb.close(); return reject(e2); }
                                const cstmt = sdb.prepare(`INSERT OR REPLACE INTO page_conversations (
                                    id, user_id, profile_id, page_id, page_name, conversation_id, updated_time,
                                    message_count, unread_count, participants_json, messages_json, snippet, updated_at
                                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                                cstmt.run([`conv_${pageId}_${conversationId}`, String(profileId), pageId, conv.page_name, conversationId, conv.updated_time,
                                    conv.message_count, conv.unread_count, conv.participants_json, conv.messages_json, conv.snippet, new Date().toISOString()]);
                                cstmt.finalize(); sdb.close(); resolve();
                            });
                        });
                    } catch (localErr) {
                        log('WARN', `[SendMessage] 回写本地对话失败: ${localErr.message}`);
                    }
                    // 云端 bulk-save（与「获取信息」同一通道）
                    try {
                        await fetch(`${sBase}/api/messages/bulk-save`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
                            body: JSON.stringify({ items: [conv] }),
                        });
                        log('INFO', `[SendMessage] 对话 ${conversationId} 已回写云端（含刚发送的消息）`);
                    } catch (e) {
                        log('WARN', `[SendMessage] 云端回写失败: ${e.message}`);
                    }
                }
            } catch (e) {
                log('WARN', `[SendMessage] 发送后刷新对话失败: ${e.message}`);
            }
        }

        // 6. 保留浏览器（若有被启动/复用），不再主动关闭；空闲由 cleanupIdleInstances 回收
        try {
            const b = activeBrowsers.get(String(profileId));
            if (b && b.browser) {
                b.lastUsed = Date.now();
                log('INFO', `[SendMessage] 发送完成，保留浏览器实例 profileId=${profileId}（供继续查看/发送，空闲后自动回收）`);
            }
        } catch {}

        if (sentMethod) {
            log('INFO', `[SendMessage] ✅ 发送成功 via page-messages msgId=${(sentResp && (sentResp.message_id || sentResp.id)) || '?'} userId=${userId}`);
            return res.json({ success: true, message: '消息已通过 Graph 发送成功', data: sentResp, method: sentMethod, closeScheduled: false });
        }
        const isWindowErr = errors.some(e => /551|24 小时|window/i.test(String(e)));
        const tip = isWindowErr
            ? '（对方与主页超出 24 小时消息窗口，或对方暂时限制接收。可让对方先在 Messenger 给主页发一条消息后再回复；或打开浏览器在该主页 Messenger 中人工发送一次以解锁。）'
            : '常见原因：该主页未开启 pages_messaging（主页收件箱消息）权限、或登录 token 已过期。可在 FB 侧为主页开通收件箱消息权限后重试；若仍失败建议改用浏览器方式在该主页 Messenger 中发送。';
        return res.status(502).json({
            success: false,
            message: `Graph 发送失败：${errors.join('；')}。${tip}`,
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});


// ===== post '/api/facebook/sync-inbox'（轻量收件箱同步：有 EAA token 就纯 Graph 走代理，不启动浏览器）=====
// 供本机 AutoSync 调度器使用：静默、无窗口，仅抓取存有 FB token 的配置的收件箱对话并写库（本地+云端）
app.post('/api/facebook/sync-inbox', async (req, res) => {
    const { profileId, pageId, pageCap, noBrowser, full, onlyUnread } = req.body || {};
    if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
    try {
        // 0. 后台静默模式：AutoSync 调用默认开启（无运行浏览器直接跳过，绝不弹窗）；
        //    前端「重新拉取」手动触发时传 noBrowser=false，允许冷启动浏览器真正抓取最新收件箱
        const noBrowserMode = typeof noBrowser === 'boolean'
            ? noBrowser
            : String(process.env.MSG_AUTO_SYNC_NO_BROWSER || '1') !== '0';
        if (noBrowserMode) {
            let running = false;
            try {
                const bd = activeBrowsers.get(String(profileId));
                running = !!(bd && bd.browser && bd.browser.isConnected());
            } catch {}
            if (!running) {
                log('INFO', `[SyncInbox] profile=${profileId} 浏览器未运行（后台静默模式），跳过本轮`);
                return res.json({ success: true, skipped: 'no-browser-running', profileId, conversations: 0 });
            }
        }
        const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
        const apiSecret = process.env.PUPPETEER_API_SECRET || '';
        const sBase = storageServerUrl.replace(/\/$/, '');
        const _str = (v, maxLen) => { try { const s = String(v || ''); return s.length > maxLen ? s.slice(0, maxLen) : s; } catch { return ''; } };

        // 1. 解析 EAA token（本地→云端），无 token 直接跳过，绝不启动浏览器
        let token = '';
        try {
            const prof = await findProfileById(String(profileId));
            token = (prof && (prof.token || prof.access_token)) || '';
        } catch {}
        if (!token || !token.startsWith('EAA')) {
            try {
                const r = await fetch(`${sBase}/api/profiles/${encodeURIComponent(profileId)}`, { headers: { 'X-Api-Secret': apiSecret } });
                if (r.ok) {
                    const j = await r.json();
                    const ct = (j && (j.token || j.accessToken)) || '';
                    if (ct && ct.startsWith('EAA')) token = ct;
                }
            } catch {}
        }
        if (!token || !token.startsWith('EAA')) {
            log('INFO', `[SyncInbox] profile=${profileId} 本地/云端无 FB token，跳过（不启动浏览器）`);
            return res.json({ success: true, skipped: 'no-token', profileId, conversations: 0 });
        }
        const profForApi = { id: String(profileId), token };

        // 2. 解析该账号可管理的主页列表
        const pagesUrl = `me/accounts?fields=id,name,access_token&limit=500`;
        let pj = null;
        try {
            pj = await Promise.race([
                callFacebookGraphApi(pagesUrl, 'GET', null, profForApi, token),
                new Promise((_, reject) => setTimeout(() => reject(new Error('PAGES_RESOLVE_TIMEOUT')), 30000)),
            ]);
        } catch (e) {
            log('WARN', `[SyncInbox] profile=${profileId} 主页列表解析失败: ${e.message}`);
        }
        const allPages = (pj && Array.isArray(pj.data)) ? pj.data.filter(p => p && p.id && p.access_token) : [];
        const targets = (pageId ? allPages.filter(p => String(p.id) === String(pageId)) : allPages).slice(0, Math.max(1, Number(pageCap) || 5));
        if (!targets.length) {
            log('INFO', `[SyncInbox] profile=${profileId} 无可同步主页（或需 pages_messaging 权限）`);
            return res.json({ success: true, profileId, pages: 0, conversations: 0 });
        }

        // 3. 抓取收件箱对话（每会话取最近 100 条消息）。
        //    AutoSync 默认仅刷新最新一页（快）；前端手动「拉取更新」传 full=true → 按 paging.next 翻页抓取全部会话
        const fullSync = !!(req.body && req.body.full);
        const convFields = `id,updated_time,message_count,unread_count,participants{id,name},messages.limit(100){id,message,from{id,name},created_time}`;

        // 写入一批会话：本地 SQLite + 云端（云端每批≤20，避免单请求过大）
        const saveBatch = async (batch) => {
            if (!batch.length) return;
            try {
                const sdb = new sqlite3.Database(dbPath);
                await new Promise((resolve, reject) => {
                    sdb.run(`CREATE TABLE IF NOT EXISTS page_conversations (
                        id TEXT PRIMARY KEY, user_id INTEGER DEFAULT 1, profile_id TEXT,
                        page_id TEXT, page_name TEXT, conversation_id TEXT, updated_time TEXT,
                        message_count INTEGER, unread_count INTEGER,
                        participants_json TEXT, messages_json TEXT, snippet TEXT, updated_at TEXT
                    )`, (e2) => {
                        if (e2) { sdb.close(); return reject(e2); }
                        const cstmt = sdb.prepare(`INSERT OR REPLACE INTO page_conversations (
                            id, user_id, profile_id, page_id, page_name, conversation_id, updated_time,
                            message_count, unread_count, participants_json, messages_json, snippet, updated_at
                        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                        batch.forEach(c => {
                            cstmt.run([`conv_${c.page_id}_${c.conversation_id}`, c.profile_id, c.page_id, c.page_name, c.conversation_id, c.updated_time,
                                c.message_count, c.unread_count, c.participants_json, c.messages_json, c.snippet, new Date().toISOString()]);
                        });
                        cstmt.finalize(); sdb.close(); resolve();
                    });
                });
            } catch (localErr) {
                log('WARN', `[SyncInbox] 本地写库失败: ${localErr.message}`);
            }
            for (let i = 0; i < batch.length; i += 20) {
                const chunk = batch.slice(i, i + 20);
                try {
                    await fetch(`${sBase}/api/messages/bulk-save`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
                        body: JSON.stringify({ items: chunk }),
                    });
                } catch (e) {
                    log('WARN', `[SyncInbox] 云端同步失败: ${e.message}`);
                }
            }
        };

        let totalConvs = 0;
        let totalPages = 0;
        const syncedPageIds = []; // 成功抓到对话的主页 → 同步后把主页操作员转移给当前配置（谁最新拉取谁操控）
        for (const pg of targets) {
            const firstUrl = `${encodeURIComponent(pg.id)}/conversations?fields=${encodeURIComponent(convFields)}&limit=${fullSync ? 50 : 20}&access_token=${encodeURIComponent(pg.access_token)}`;
            let nextUrl = firstUrl;
            let safety = 0;
            while (nextUrl && (++safety) <= 300) {
                let r = null;
                try {
                    r = await Promise.race([
                        callFacebookGraphApi(nextUrl, 'GET', null, profForApi, pg.access_token),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('CONV_FETCH_TIMEOUT')), 25000)),
                    ]);
                } catch (e) {
                    log('WARN', `[SyncInbox] page=${pg.id} 收件箱抓取异常: ${e.message}`);
                    break;
                }
                if (!r || r.error || !Array.isArray(r.data)) {
                    if (r && r.error) {
                        log('WARN', `[SyncInbox] page=${pg.id} 收件箱抓取失败: (${r.error.code || ''}) ${r.error.message}`);
                    }
                    break;
                }
                const batch = [];
                for (const c of r.data) {
                    if (!c.id) continue;
                    // 仅拉取未读：只更新/写入 unread_count>0 的对话（轻量轮询用，跳过已读对话省请求与流量）
                    if (onlyUnread && !(Number(c.unread_count || 0) > 0)) continue;
                    const msgs = c.messages && Array.isArray(c.messages.data) ? c.messages.data : [];
                    const firstText = msgs.find(m => m.message)?.message || '';
                    batch.push({
                        page_id: String(pg.id),
                        page_name: String(pg.name || ''),
                        conversation_id: String(c.id),
                        updated_time: c.updated_time || '',
                        message_count: Number(c.message_count || 0),
                        unread_count: Number(c.unread_count || 0),
                        participants_json: _str(c.participants ? JSON.stringify(c.participants) : '', 20000),
                        messages_json: _packMessagesJson(msgs, 200000),
                        snippet: _str(firstText, 2000),
                        profile_id: String(profileId),
                    });
                }
                if (batch.length) {
                    await saveBatch(batch);
                    totalConvs += batch.length;
                    if (!syncedPageIds.includes(String(pg.id))) syncedPageIds.push(String(pg.id));
                }
                totalPages += 1;
                const nxt = (r.paging && r.paging.next) ? String(r.paging.next) : '';
                if (!fullSync || !nxt) break;
                nextUrl = nxt;
            }
        }
        if (!totalConvs) {
            log('INFO', `[SyncInbox] profile=${profileId} 抓到 0 个收件箱对话`);
            return res.json({ success: true, profileId, pages: totalPages, conversations: 0 });
        }
        // 主页操作员自动转移：谁最新拉取，谁获得该主页（pages 表）的操控权，
        // 使贴文/获取信息/消息对话等按配置过滤的入口随之切换，并避免旧配置继续值守同一主页
        if (syncedPageIds.length) {
            try {
                const r2 = await fetch(`${sBase}/api/pages/assign-operator`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
                    body: JSON.stringify({ pageIds: syncedPageIds, profileId: String(profileId) }),
                });
                const j2 = await r2.json().catch(() => null);
                if (j2 && j2.success) log('INFO', `[SyncInbox] 已把 ${j2.updated ?? syncedPageIds.length} 个主页操作员转移给 profile=${profileId}`);
            } catch (e) {
                log('WARN', `[SyncInbox] 主页操作员转移失败: ${e.message}`);
            }
        }
        log('INFO', `[SyncInbox] profile=${profileId} 同步完成 conversations=${totalConvs} pages=${totalPages} full=${fullSync}`);
        return res.json({ success: true, profileId, pages: totalPages, conversations: totalConvs, full: fullSync });
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});


// ===== post '/api/facebook/scrape-billing-info' (original lines 5219-5385) =====
app.post('/api/facebook/scrape-billing-info', async (req, res) => {
    try {
        const { profileId, url, accessToken } = req.body || {};
        
        if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
        
        // 解析 asset_id
        let assetId = req.body.assetId;
        if (!assetId && url) {
            const m = url.match(/asset_id=(\d+)/);
            if (m) assetId = m[1];
        }
        if (!assetId && url) {
             const m2 = url.match(/payment_account_id=(\d+)/);
             if (m2) assetId = m2[1];
        }

        if (!assetId) return res.status(400).json({ success: false, message: 'Could not extract asset_id from URL' });
        if (!accessToken) return res.status(400).json({ success: false, message: 'missing accessToken' });

        // 获取浏览器
        let browserRef = null;
        let tempBrowser = null;
        try {
            const browserData = activeBrowsers.get(profileId);
            if (browserData && browserData.browser && browserData.browser.isConnected()) {
                browserRef = browserData.browser;
            } else {
                const effectiveExecutablePath = findChromeExecutable() || null;
                const udDir = browserManager.getUnifiedUserDataDir(profileId, undefined, undefined);
                const launchOpts = { headless: false, args: [`--user-data-dir=${udDir}`], defaultViewport: null, timeout: 30000 };
                if (effectiveExecutablePath) launchOpts.executablePath = effectiveExecutablePath;
                tempBrowser = await puppeteer.launch(launchOpts);
                browserRef = tempBrowser;
            }
        } catch {}

        if (!browserRef || !browserRef.isConnected()) {
            return res.status(500).json({ success: false, message: 'no_browser' });
        }

        const page = await browserRef.newPage();
        try {
            const base = 'https://graph.facebook.com/v20.0';
            // 尝试使用 act_ 前缀，如果 assetId 纯数字
            const targetId = /^\d+$/.test(assetId) ? `act_${assetId}` : assetId;
            // fields: business_country_code (国家), currency (货币), timezone_name (时区名), timezone_id (时区ID), timezone_offset_hours_utc (偏移)
            const apiUrl = `${base}/${targetId}?fields=business_country_code,currency,timezone_name,timezone_id,timezone_offset_hours_utc,name,id,account_id&access_token=${encodeURIComponent(accessToken)}`;
            
            await page.goto(apiUrl, { waitUntil: 'networkidle2', timeout: 15000 });
            
            let raw = await page.evaluate(() => document.body.innerText || document.body.textContent || '{}');
            let json = null;
            try { json = JSON.parse(raw); } catch {}
            
            if (!json || json.error) {
                // 如果出错，尝试不带 act_ 前缀
                if (/act_/.test(targetId)) {
                     const altId = targetId.replace('act_', '');
                     const altUrl = `${base}/${altId}?fields=business_country_code,currency,timezone_name,timezone_id,timezone_offset_hours_utc,name,id,account_id&access_token=${encodeURIComponent(accessToken)}`;
                     await page.goto(altUrl, { waitUntil: 'networkidle2', timeout: 15000 });
                     raw = await page.evaluate(() => document.body.innerText || document.body.textContent || '{}');
                     try { json = JSON.parse(raw); } catch {}
                }
            }
            
            if (!json || json.error) {
                throw new Error(json?.error?.message || 'Graph API Error');
            }
            
            await page.close();
            if (tempBrowser) await tempBrowser.close();

            // 更新数据库
            try {
                const sdb = new sqlite3.Database(dbPath);
                await ensureAdAccountsTable(sdb);
                await new Promise((resolve, reject) => {
                    // 更新字段: country, currency, timezone_id
                    // 匹配: id 或 account_id
                    const updateSql = `UPDATE ad_accounts SET 
                        country = ?, 
                        currency = ?, 
                        timezone_id = ?,
                        updated_at = CURRENT_TIMESTAMP
                        WHERE account_id = ? OR id = ? OR account_id = ? OR id = ?`;
                    
                    const country = json.business_country_code || '';
                    const currency = json.currency || '';
                    
                    // 🚀 时区处理：如果存在 timezone_name，则显示为 "Name+-Offset" 格式
                    let tzVal = String(json.timezone_id || '');
                    if (json.timezone_name) {
                        const offset = json.timezone_offset_hours_utc;
                        const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                        tzVal = `${json.timezone_name}${offsetStr}`;
                    } else if (json.timezone_name_display) {
                        tzVal = json.timezone_name_display;
                    } else if (!tzVal && json.timezone_name) {
                        tzVal = json.timezone_name;
                    }

                    // 匹配ID: 原始assetId, act_assetId, stripped assetId
                    const id1 = assetId;
                    const id2 = `act_${assetId.replace('act_', '')}`;
                    const id3 = assetId.replace('act_', '');
                    
                    sdb.run(updateSql, [country, currency, tzVal, id1, id1, id2, id2], function(err) {
                        if (err) reject(err);
                        else resolve(this.changes);
                    });
                });
                sdb.close();
            } catch (e) {
                console.error('Update DB failed:', e);
            }

            // Sync to remote storage
            try {
                const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
                const sBase = storageServerUrl.replace(/\/$/, '');
                let tzSync = String(json.timezone_id || '');
                if (json.timezone_name) {
                    const offset = json.timezone_offset_hours_utc;
                    const offsetStr = typeof offset === 'number' ? (offset >= 0 ? `+${offset}` : `${offset}`) : '';
                    tzSync = `${json.timezone_name}${offsetStr}`;
                }

                const item = {
                    id: String(json.id || assetId || ''),
                    account_id: String(json.account_id || assetId || ''),
                    name: String(json.name || ''),
                    business_country_code: String(json.business_country_code || ''),
                    currency: String(json.currency || ''),
                    timezone_id: tzSync,
                    profile_id: String(profileId || '')
                };
                await fetch(`${sBase}/api/adaccounts/bulk-save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: [item] })
                });
            } catch (e) { console.error('Remote sync failed:', e); }

            return res.json({ 
                success: true, 
                data: {
                    country: json.business_country_code,
                    currency: json.currency,
                    timezone: json.timezone_name,
                    timezone_id: json.timezone_id,
                    name: json.name,
                    id: json.id,
                    account_id: json.account_id
                }
            });

        } catch (e) {
            try { await page.close(); } catch {}
            try { if (tempBrowser) await tempBrowser.close(); } catch {}
            throw e;
        }
        
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});


// ===== post '/api/facebook/adaccounts/change-billing-country' (original lines 5463-5732) =====
app.post('/api/facebook/adaccounts/change-billing-country', async (req, res) => {
  try {
    const { profileId, adAccountId, country, currency, timezone_id, card, address, city, zip, state, paymentAccountId, lang } = req.body || {};
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' });

    const cc = String(country || '').trim().toUpperCase();
    const actId = String(adAccountId).replace('act_', '');
    const hasCard = card && card.number;
    const hasApiChanges = cc || (currency && currency.trim()) || (timezone_id && String(timezone_id).match(/^\d{1,2}$/));

    log('INFO', `[ChangeBillingCountry] 简化版: profile=${profileId}, act=${actId}, country=${cc}, currency=${currency}, tz=${timezone_id}, address=${address||''}, city=${city||''}, zip=${zip||''}, hasCard=${hasCard}`);

    let apiResult = null;

    if (hasApiChanges) {
      // 🚀 确保浏览器运行
      let browserResult;
      try { browserResult = await ensureBrowserIsRunning(profileId); } catch (e) { browserResult = { success: false, error: e.message }; }
      
      if (browserResult.success) {
        const browser2 = browserResult.browserData.browser;
        // 🚀 始终在新标签页执行（同 browser 共享 Cookie，无需复制）
        let page = await browser2.newPage();

        // 🚀 自动切换 Facebook 语言到英语（确保后续选择国家时不会因为多语言导致匹配错误）
        try {
          const currentHtmlLang = await page.evaluate(() => (document.documentElement.lang || '').toLowerCase().slice(0, 2)).catch(() => '');
          log('INFO', `[ChangeBillingCountry] 当前页面语言: ${currentHtmlLang}`);
          if (currentHtmlLang && currentHtmlLang !== 'zh') {
            log('INFO', `[ChangeBillingCountry] 🌐 非中文界面，自动切换语言到中文...`);
            const langChanged = await ensureFbLanguage(browser2, 'zh_CN');
            log('INFO', `[ChangeBillingCountry] 语言切换结果: ${langChanged ? '✅成功' : '❌失败'}`);
            const newPages = await browser2.pages();
            page = newPages.find(p => p.url().includes('facebook.com')) || await browser2.newPage();
          } else if (!currentHtmlLang) {
            log('INFO', `[ChangeBillingCountry] 无法检测页面语言，尝试强制切换到中文...`);
            await ensureFbLanguage(browser2, 'zh_CN');
            const newPages = await browser2.pages();
            page = newPages.find(p => p.url().includes('facebook.com')) || await browser2.newPage();
          } else {
            log('INFO', `[ChangeBillingCountry] 当前已经是英语界面`);
          }
        } catch (langErr) {
          log('WARN', `[ChangeBillingCountry] 语言切换异常（不影响后续流程）: ${langErr.message}`);
        }

        // 🚀 导航到 adsmanager 页面（同书签运行上下文）
        try {
          await page.goto('https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=' + actId, 
            { waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 5000));
          try { await page.waitForFunction(() => typeof window.dtsg !== 'undefined' && window.dtsg !== '', { timeout: 15000 }); } catch {}
        } catch (navErr) {
          log('WARN', `[ChangeBillingCountry] 导航到 adsmanager 失败: ${navErr.message}`);
        }

        if (!page.url().includes('facebook.com')) {
          await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
        }

        // 👇 提取 fb_dtsg
        const sessionData = await page.evaluate(() => {
          let fbDtsg = (typeof window !== 'undefined' && window.dtsg) || '';
          let userId = '', spinR = '';
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const html = s.innerHTML || '';
            const u = html.match(/"USER_ID":"(\d+)"/) || html.match(/"userID":"(\d+)"/);
            if (u) userId = u[1];
            const sr = html.match(/__spin_r=(\d+)/);
            if (sr) spinR = sr[1];
            if (!fbDtsg) {
              const d = html.match(/"dtsg":\{"token":"([^"]+)"/);
              if (d) fbDtsg = d[1];
            }
          }
          return { fbDtsg, userId, spinR };
        });

        if (!sessionData.fbDtsg) {
          log('WARN', '[ChangeBillingCountry] 首次未获得到 fb_dtsg，尝试重载');
          try {
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
            const fbData = await page.evaluate(() => {
              try { const el = document.querySelector('input[name="fb_dtsg"]'); if (el) return { fbDtsg: el.value }; } catch {}
              try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('fbdtsg_')) return { fbDtsg: localStorage.getItem(k) || '' }; } } catch {}
              const scripts = document.querySelectorAll('script');
              for (const s of scripts) {
                const t = s.textContent || '';
                const m = t.match(/"dtsg":\{"token":"([^"]+)"/);
                if (m) return { fbDtsg: m[1] };
              }
              return { fbDtsg: '' };
            });
            if (fbData.fbDtsg) { sessionData.fbDtsg = fbData.fbDtsg; }
          } catch {}
        }

        // 🚀 1. 如果有货币/时区变动 → 先通过 Graph API 修改（走浏览器 Token）
        if (currency || timezone_id) {
          try {
            let token = '';
            const profile = await findProfileById(profileId).catch(() => null);
            if (profile) token = String(profile?.account_tokens || profile?.token || '').trim();
            if (!token) {
              token = await page.evaluate(() => {
                try { const keys = Object.keys(localStorage); for (const k of keys) { const v = localStorage.getItem(k); if (v && (v.startsWith('EAAB') || v.startsWith('EAA'))) return v; } } catch {}
                try { if (window.__accessToken && String(window.__accessToken).startsWith('EA')) return window.__accessToken; } catch {}
                return '';
              }).catch(() => '');
            }
            if (token) {
              let fbTz = '';
              if (timezone_id) { fbTz = normalizeFbTimezoneId(timezone_id); }
              const tzRes = await page.evaluate(async (p2) => {
                const fd = new URLSearchParams();
                fd.append('access_token', p2.t);
                if (p2.c) fd.append('currency', p2.c);
                if (p2.tz) fd.append('timezone_id', p2.tz);
                try { const r = await fetch('https://graph.facebook.com/v19.0/act_' + p2.a + '?fields=id,name,timezone_id', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fd.toString() }); return await r.json(); } catch (e) { return { error: e.message }; }
              }, { a: actId, t: token, c: currency || '', tz: fbTz });
              log('INFO', `[ChangeBillingCountry] 货币/时区修改结果: ${JSON.stringify(tzRes).substring(0, 150)}`);
              if (tzRes && tzRes.id) {
                apiResult = { ...(apiResult || {}), currencyTimezone: 'success', currencyTimezoneData: tzRes };
              }
            }
          } catch (ctErr) { log('WARN', `[ChangeBillingCountry] 货币/时区修改异常: ${ctErr.message}`); }
        }

        // 🚀 2. 如果有卡信息 → 用 FB.ui(ads_payment) 绑卡
        if (hasCard) {
          const ccNumber = String(card.number).replace(/\s/g, '');
          const last4 = ccNumber.slice(-4);
          const ccIso = cc || card.country_code || (card.billing_address && card.billing_address.country_code) || 'US';

          // 设置弹窗监听（处理 FB.ui 弹出的支付弹窗）
          let popupHandled = false;
          const popupPromise2 = new Promise((resolve) => {
            const handler2 = async (target) => {
              try {
                if (target.type() === 'page') {
                  const pu = target.url();
                  if (pu.includes('payments') || pu.includes('dialog') || pu.includes('checkout')) {
                    popupHandled = true;
                    browser2.removeListener('targetcreated', handler2);
                    try {
                      const popup = await target.page();
                      try { await popup.waitForSelector('input', { timeout: 10000 }); } catch {}
                      try { await new Promise(r => setTimeout(r, 2000)); } catch {}
                      resolve(true);
                    } catch (e) { resolve(false); }
                  }
                }
              } catch {}
            };
            browser2.on('targetcreated', handler2);
            setTimeout(() => {
              if (!popupHandled) { try { browser2.removeListener('targetcreated', handler2); } catch {} resolve(false); }
            }, 30000);
          });

          const fbResult2 = await page.evaluate(async (adAccountId) => {
            return new Promise((resolve) => {
              const tryFbUi = (retries) => {
                try {
                  if (typeof FB !== 'undefined' && typeof FB.ui === 'function') {
                    FB.ui({
                      method: 'ads_payment',
                      account_id: adAccountId,
                      display: 'popup'
                    }, function(response) {
                      try {
                        if (response && response.error_message) {
                          resolve({ success: false, error_message: response.error_message });
                        } else {
                          resolve({ success: true, data: response });
                        }
                      } catch (e) { resolve({ success: false, error_message: String(e) }); }
                    });
                  } else if (retries > 0) {
                    setTimeout(() => tryFbUi(retries - 1), 1000);
                  } else {
                    resolve({ success: false, error_message: 'FB SDK not available on page' });
                  }
                } catch (e) { resolve({ success: false, error_message: String(e) }); }
              };
              tryFbUi(10);
              setTimeout(() => resolve({ success: false, error_message: 'timeout' }), 30000);
            });
          }, 'act_' + actId);

          await popupPromise2;

          if (fbResult2 && fbResult2.success) {
            apiResult = { ...(apiResult || {}), card: 'success', apiSuccess: true, cardData: fbResult2.data };
          } else if (fbResult2 && fbResult2.error_message === 'FB SDK not available on page') {
            log('WARN', `[ChangeBillingCountry] FB SDK 不可用，打开 billing hub 页面`);
            try { await navigateToBillingHub(page, actId, paymentAccountId); } catch {}
            apiResult = { ...(apiResult || {}), card: 'manual', message: '已打开 billing hub 页面' };
          } else {
            const errDetail = fbResult2?.error_message || 'POPUP_NOT_HANDLED';
            apiResult = { ...(apiResult || {}), card: 'failed', cardError: errDetail };
          }
        }

        // 无卡但有国家 → 记录为本地保存，并尝试智能更新
        if (cc && !hasCard) {
          apiResult = { ...(apiResult || {}), countrySaved: 'local_only' };
          try {
            log('INFO', `[ChangeBillingCountry] 尝试智能国家更新(无卡模式): act=${actId}, country=${cc}`);
            const smartRes = await tryUpdateBillingCountrySmart(page, actId, cc, '', '', address, city, zip, state, paymentAccountId, lang);
            log('INFO', `[ChangeBillingCountry] 智能更新结果: ${JSON.stringify(smartRes)}`);
            if (smartRes.api || (smartRes.dsl && !String(smartRes.dsl).startsWith('timeout'))) {
              apiResult.countrySaved = 'smart_updated';
              apiResult.smartResult = smartRes;
            }
          } catch (e) {
            log('WARN', `[ChangeBillingCountry] 智能更新异常: ${e.message}`);
          }
        }
      } else {
        return res.json({ success: false, message: '浏览器未运行', error: browserResult.error });
      }
    }

    // 💾 无论是否成功，都保存到本地 + 云端
    try {
      const sUrl = process.env.STORAGE_SERVER_URL || '';
      const baseUrl = sUrl.replace(/\/$/, '');
      const items = [{ profileId, accountId: String(adAccountId), country: cc, currency: String(currency||''), timezone_id: toDisplayTimezone(timezone_id) }];
      await fetch(baseUrl + '/api/adaccount-settings/bulk-save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) }).catch(()=>{});
    } catch {}

    try {
      const sdb = new sqlite3.Database(dbPath);
      await ensureAdAccountsTable(sdb);
      await ensureAdAccountsColumns(sdb);
      await new Promise((resolve, reject) => {
        sdb.run(`UPDATE ad_accounts SET country = ?, currency = ?, timezone_id = ?, updated_at = CURRENT_TIMESTAMP WHERE (account_id = ? OR id = ?) AND profile_id = ?`,
          [cc, String(currency||''), toDisplayTimezone(timezone_id), String(adAccountId), String(adAccountId), String(profileId)],
          (err) => err ? reject(err) : resolve()
        );
      });
      sdb.close();
    } catch (localErr) { log('WARN', `[ChangeBillingCountry] 本地保存失败: ${localErr.message}`); }

    const apiSuccess = !!(apiResult?.apiSuccess);
    let msg = `国家 ${cc || '保持不变'}`;
    if (currency) msg += `, 货币 ${currency}`;
    if (timezone_id) msg += `, 时区 ${timezone_id}`;
    if (hasCard) msg += apiSuccess ? ', 绑卡成功' : ', 绑卡失败';
    if (!hasApiChanges) msg = '未提交任何修改（缺少国家/货币/时区/卡号）';
    // 🚀 改账单/绑卡成功后同步数据
    if (apiSuccess) {
      const syncToken = req.body.accessToken || req.body.token || '';
      postOperationSync(profileId || adAccountId, syncToken, { syncPages: false, syncPixels: false, syncAdAccounts: true }).catch(() => {});
    }

    return res.json({
      success: true,
      apiSuccess,
      message: apiSuccess ? `账单地址/绑卡成功: ${msg}` : `本地保存成功: ${msg}`,
      data: apiResult
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: String(e.message || e) });
  }
});


// ===== post '/api/facebook/adaccounts/change-currency-timezone' (original lines 5879-6467) =====
app.post('/api/facebook/adaccounts/change-currency-timezone', async (req, res) => {
  console.log('🔥🔥🔥 CHANGE_CURRENCY_TZ CALLED at ' + new Date().toISOString());
  // 🚀 支持传入单个 adAccountId 或 adAccountIds 数组
  let { profileId, adAccountId, adAccountIds, currency, timezone_id, country, address, city, zip, state, paymentAccountId, lang, cookies, business_name } = req.body || {}
  if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' })
  // 🚀 构建 adAccountId 列表
  if (Array.isArray(adAccountIds) && adAccountIds.length > 0) {
    // 支持
  } else if (adAccountId) {
    adAccountIds = [adAccountId];
  } else {
    return res.status(400).json({ success: false, message: 'missing adAccountId/adAccountIds' });
  }
  
  const results = [];
  let cachedToken = '';
  // 🚀 判断是否有地址变更
  const hasAddressChange = !!(address && address.trim()) || !!(city && city.trim()) || !!(zip && zip.trim()) || !!(state && state.trim());
  const hasApiChange = !!((currency && currency.trim()) || normalizeFbTimezoneId(timezone_id) || (country && country.trim()) || hasAddressChange);
  // 🚀 时区值规范化
  const normalizedTz = normalizeFbTimezoneId(timezone_id);
  // 🚑 调试日志：打印时区参数全链路
  log('INFO', `[ChangeCurrency/TZ/DBG] timezone_id原始输入: "${String(timezone_id)}" 类型: ${typeof timezone_id}`);
  log('INFO', `[ChangeCurrency/TZ/DBG] normalizedTz结果: "${normalizedTz}"`);
  log('INFO', `[ChangeCurrency/TZ/DBG] currency原始: "${String(currency||'')}" country原始: "${String(country||'')}" hasAddressChange: ${hasAddressChange}`);
  log('INFO', `[ChangeCurrency/TZ/DBG] hasApiChange: ${hasApiChange} (currency=${!!(currency&&currency.trim())} tz=${!!normalizedTz} country=${!!(country&&country.trim())} addr=${hasAddressChange})`);

  // ============ PHASE 1: 启动一次浏览器 + 提取 Token/fbDtsg ============
  let sharedBrowser = null;
  let sharedPage = null;
  let sharedFbDtsg = '';
  let sharedFbUserId = '';
  let browserStartedOk = false;
  // 🐛 记录浏览器启动失败原因：以前这里吞掉原因，最后只在结果里写"已保存到本地"（还标记成功）
  let browserLaunchError = '';

  // 🚀 Token 回退链：本地库 → 云端 → 浏览器实时提取（Phase1）
  //    findProfileById 本身是「本地库 → 云端」，但云端那一环会被「没有 token 的缓存」挡住，
  //    而且失败时是静默的。这里再补一次「直接问云端」（绕过一切缓存），并把来源写进日志。
  const storedProfile = await findProfileById(profileId).catch(() => null);
  let storedToken = String(storedProfile?.account_tokens || storedProfile?.token || '').trim();
  let tokenSource = storedToken ? '本地库/云端配置' : '';
  if (!storedToken) {
    try {
      const cloudUrl = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
      const cloudSecret = process.env.PUPPETEER_API_SECRET || '';
      const resp = await fetch(`${cloudUrl}/api/profiles/${encodeURIComponent(profileId)}`, {
        headers: { 'Accept': 'application/json', 'X-Api-Secret': cloudSecret },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
      });
      const j = await resp.json().catch(() => null);
      const d = j && (j.data || j);
      const cloudToken = String((d && (d.account_tokens || d.token || (d.account && d.account.tokens))) || '').trim();
      if (cloudToken && /^EAA/i.test(cloudToken)) { storedToken = cloudToken; tokenSource = '云端直取'; }
    } catch (e) {
      log('WARN', `[ChangeCurrency/TZ] 云端直取 token 失败: ${e.message}`);
    }
  }
  if (!cachedToken && storedToken) { cachedToken = storedToken; }
  log('INFO', `[ChangeCurrency/TZ] Token 来源: ${tokenSource || '本地库和云端都没有，稍后从浏览器实时提取'}`);

  // 🚀 启动浏览器的条件：有地址变更，或无 Token 但有 API 变更（需要启动浏览器提取 Token）
  if (adAccountIds.length > 0 && hasApiChange && (hasAddressChange || !cachedToken)) {
    for (let retryAttempt = 1; retryAttempt <= 2; retryAttempt++) {
      if (retryAttempt > 1) {
        log('WARN', `[ChangeCurrency/TZ] 浏览器断开，第${retryAttempt}次重启...`);
        const bd = activeBrowsers.get(String(profileId));
        if (bd && bd.browser) try { await bd.browser.close(); } catch {}
        activeBrowsers.delete(String(profileId));
        await new Promise(r => setTimeout(r, 2000));
      }
      try {
        log('INFO', `[ChangeCurrency/TZ] 📦 Phase1: 启动一次浏览器处理所有 ${adAccountIds.length} 个广告号（地址+货币/时区）`);
        const result = await ensureBrowserIsRunning(profileId, null, cookies, { awaitLogin: true });
        if (!result.success) throw new Error(result.error || 'browser start failed');

        // 🚫 自动登录没成功 → 后面的改国家/货币/时区必然失败：直接关掉本次借来的浏览器并如实返回，
        //    不再往下跑一轮注定失败的账单页导航 + GraphQL（也不白占着这个浏览器）。
        if (result.loginOk === false) {
          log('WARN', `[ChangeCurrency/TZ] 🚫 未登录成功（需人工登录），放弃本次修改 (profileId=${profileId})`);
          try {
            const _bd = activeBrowsers.get(String(profileId));
            if (_bd && _bd.browser) {
              try { logBrowserClose(profileId, '未登录成功，放弃改国家/货币/时区', 'change-currency-timezone'); } catch {}
              try { if (_bd.browser.isConnected()) await _bd.browser.close(); } catch {}
              try { _bd.process?.kill?.(); } catch {}
            }
            activeBrowsers.delete(String(profileId));
          } catch {}
          return res.status(400).json({ success: false, message: '未登录成功（需人工登录），已放弃修改国家/货币/时区' });
        }
        
        sharedBrowser = result.browserData.browser;
        sharedPage = await sharedBrowser.newPage();

        // 语言切换（一次）
        try {
          const targetLang = lang || 'zh_CN';
          const langShort = targetLang.slice(0, 2);
          const currentHtmlLang = await sharedPage.evaluate(() => (document.documentElement.lang || '').toLowerCase().slice(0, 2)).catch(() => '');
          if (currentHtmlLang && currentHtmlLang !== langShort) {
            log('INFO', `[ChangeCurrency/TZ] 切换语言到 ${targetLang}...`);
            await ensureFbLanguage(sharedBrowser, targetLang);
            try { await sharedPage.close(); } catch {}
            sharedPage = await sharedBrowser.newPage();
          }
        } catch (langErr) { log('WARN', `[ChangeCurrency/TZ] 语言切换异常: ${langErr.message}`); }

        // 🚀 使用现成的 extractFbToken + _rawCdpExtractToken 提取 Token（已在批量操作中验证可用）
        // 先用 DOM/localStorage 快速检查
        let tokenCandidates = new Set();
        try {
          const domToken = await sharedPage.evaluate(() => {
            try { for (let i = 0; i < localStorage.length; i++) { const v = localStorage.getItem(localStorage.key(i)); if (!v) continue; if ((v.startsWith('EAA')||v.startsWith('EAAG')) && v.length > 50) return v.substring(0, 200); const at = v.match(/access_token=(EAAB[A-Za-z0-9_\-]{50,200})/); if (at) return at[1]; } } catch {}
            try { for (let i = 0; i < sessionStorage.length; i++) { const v = sessionStorage.getItem(sessionStorage.key(i)); if (v && (v.startsWith('EAA')||v.startsWith('EAAG')) && v.length > 50) return v.substring(0, 200); } } catch {}
            try { for (const s of document.querySelectorAll('script')) { const m = s.innerHTML?.match(/EAAB[A-Za-z0-9_\-]{50,200}/); if (m) return m[0]; } } catch {}
            return '';
          });
          if (domToken) tokenCandidates.add(domToken);
        } catch {}

        // 通过 CDP 网络拦截提取（使用 extractFbToken 内部逻辑）
        try {
          const t = sharedPage.target();
          if (t) {
            const cdpSession = await t.createCDPSession().catch(() => null);
            if (cdpSession) {
              const cdpToken = await _rawCdpExtractToken(cdpSession, 15000);
              cdpSession.detach().catch(() => {});
              if (cdpToken) tokenCandidates.add(cdpToken);
            }
          }
        } catch {}

        // 再导航一次触发 Graph API 请求，同时用 page.on('request') 补充
        const extraTokens = new Set();
        const extraHandler = (request) => {
          try {
            const url = request.url();
            const m = url.match(/access_token=(EAAB[A-Za-z0-9_\-]{50,200})/);
            if (m && m[1] && m[1].length > 50) extraTokens.add(m[1]);
          } catch {}
        };
        sharedPage.on('request', extraHandler);
        // 🩹 页面自愈：新建的 page 在部分 Chrome 版本下第一个导航会因 frame 换进程而报
        //    「Attempted to use detached Frame」，之后这个 page 的 goto/evaluate 全部失效。
        //    线上日志（09-26 00:56）：BillingNav 主/降级/三级全 detached → fbDtsg、Token 全空
        //    → 账单被误判「只存本地」。这里导航失败就关掉重建 page 再试，最多 3 次。
        let _navOk = false;
        for (let _navTry = 1; _navTry <= 3 && !_navOk; _navTry++) {
          try { _navOk = !!(await navigateToBillingHub(sharedPage, adAccountIds[0])); } catch { _navOk = false; }
          if (_navOk) break;
          log('WARN', `[ChangeCurrency/TZ] 账单页导航失败(${_navTry}/3)，重建页面后重试...`);
          try { sharedPage.removeListener('request', extraHandler); } catch {}
          try { await sharedPage.close(); } catch {}
          try {
            sharedPage = await sharedBrowser.newPage();
            sharedPage.on('request', extraHandler);
            await new Promise(r => setTimeout(r, 1500));
          } catch (e2) { log('WARN', `[ChangeCurrency/TZ] 重建页面失败: ${e2.message}`); break; }
        }
        // 兜底：地址写入走的是页面内 fetch('/api/graphql/')，只要 page 在 facebook.com 域内就行，
        //      所以即使 billing_hub 一直打不开，退到根域也比直接放弃强。
        if (!_navOk) {
          try {
            if (!/facebook\.com/i.test(sharedPage.url())) {
              await sharedPage.goto('https://business.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
              log('INFO', '[ChangeCurrency/TZ] BillingNav 全部失败，已退到 business.facebook.com 根域（供地址 GraphQL 使用）');
            }
          } catch (e) { log('WARN', `[ChangeCurrency/TZ] 兜底导航也失败: ${e.message}`); }
        }
        await new Promise(r => setTimeout(r, 5000));
        try { sharedPage.removeListener('request', extraHandler); } catch {}
        for (const t of extraTokens) tokenCandidates.add(t);

        // 补充数据库 Token
        if (storedToken) tokenCandidates.add(storedToken);

        if (tokenCandidates.size > 0) log('INFO', `[ChangeCurrency/TZ] Token 候选集: ${tokenCandidates.size} 个: ${[...tokenCandidates].map(t=>t.substring(0,8)).join(', ')}`);

        // 逐一验证，找第一个有效的
        cachedToken = '';
        // 🐛 以前 catch 是空的：页面 frame 挂掉导致 fetch 跑不起来时，也被当成「Token 过期」，
        //    于是明明有效的 Token 被丢掉 → 整批账单只存本地。现在区分「校验跑不成」和「校验说无效」。
        let _tokenVerifyRan = false;
        for (const candidate of tokenCandidates) {
          if (!candidate || candidate.length <= 50) continue;
          try {
            const vUrl = `https://graph.facebook.com/v21.0/me?fields=id&access_token=${encodeURIComponent(candidate)}`;
            const vRes = await sharedPage.evaluate(async (url) => { try { const r = await fetch(url); return await r.json(); } catch { return null; } }, vUrl);
            _tokenVerifyRan = true;
            if (vRes && !vRes.error) {
              cachedToken = candidate;
              log('INFO', `[ChangeCurrency/TZ] ✅ Token 有效: ${candidate.substring(0,10)}...`);
              break;
            } else {
              log('WARN', `[ChangeCurrency/TZ] Token 过期/无效: ${candidate.substring(0,10)}... (${vRes?.error?.message||'unknown'})`);
            }
          } catch (e) {
            log('WARN', `[ChangeCurrency/TZ] Token 校验跑不了（页面异常，不能据此判定过期）: ${e.message}`);
          }
        }
        // 一次校验都没跑成（页面异常）→ 不能下「全部过期」的结论，沿用本地库 Token 继续，
        // 否则后面的地址 GraphQL（靠 fb_dtsg，不依赖 token）也会被一起带下水。
        if (!cachedToken && !_tokenVerifyRan && storedToken) {
          cachedToken = storedToken;
          log('WARN', `[ChangeCurrency/TZ] ⚠️ Token 未能校验（页面异常），沿用本地库 Token 继续: ${storedToken.substring(0,10)}...`);
        }

        // 无有效 Token → 尝试刷新
        if (!cachedToken) {
          log('WARN', `🚫 所有 ${tokenCandidates.size} 个 Token 均过期，调用刷新机制...`);
          const refreshResult = await retryWithTokenRefresh(profileId, sharedBrowser, sharedPage, async (freshToken) => {
            // 刷新成功后，再次验证
            if (freshToken && freshToken.length > 50) {
              const vUrl2 = `https://graph.facebook.com/v21.0/me?fields=id&access_token=${encodeURIComponent(freshToken)}`;
              const vRes2 = await sharedPage.evaluate(async (url) => { try { const r = await fetch(url); return await r.json(); } catch { return null; } }, vUrl2);
              if (vRes2 && !vRes2.error) { cachedToken = freshToken; return { success: true, token: freshToken }; }
            }
            return { success: false, error: '刷新后 Token 仍无效' };
          }, 3);
          if (refreshResult.loginFailed || !cachedToken) {
            log('WARN', `🚫 Token 刷新失败，保存到本地`);
            cachedToken = null;
          } else {
            log('INFO', `✅ Token 刷新成功`);
          }
        }
        if (cachedToken && cachedToken !== storedToken) {
          try {
            const db = new sqlite3.Database(dbPath);
            db.run(`UPDATE profiles SET account_tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR ext_id = ?`, [cachedToken, profileId, profileId], (err) => { if (err) log('WARN', `[ChangeCurrency/TZ] DB 更新失败: ${err.message}`); db.close(); });
          } catch(e) { log('WARN', `[ChangeCurrency/TZ] 保存 Token 失败: ${e.message}`); }
          // 🚀 同步到 D1 远程数据库
          try {
            const d1Url = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
            const d1ApiSecret = process.env.PUPPETEER_API_SECRET || '';
            fetch(`${d1Url}/api/profiles/bulk-save`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-secret': d1ApiSecret },
              body: JSON.stringify({ items: [{ id: profileId, token: cachedToken }] })
            }).then(r => r.ok ? log('INFO', `✅ Token 已同步到 D1`) : log('WARN', `⚠️ Token D1 同步失败: ${r.status}`)).catch(e => log('WARN', `⚠️ Token D1 同步异常: ${e.message}`));
          } catch(e) { log('WARN', `⚠️ Token D1 同步异常: ${e.message}`); }
        }

        // 提取 fbDtsg + fbUserId
        sharedFbDtsg = await sharedPage.evaluate(() => {
          try { const CD = typeof window.require === 'function' && window.require('CurrentUserInitialData'); if (CD && CD.fbDtsg) return CD.fbDtsg; } catch {}
          const inp = document.querySelector('input[name="fb_dtsg"]'); if (inp && inp.value) return inp.value;
          const attr = document.querySelector('[data-dtsg]'); if (attr) return attr.getAttribute('data-dtsg');
          const m = document.body.innerHTML.match(/"token":"([^"]+)"/); if (m) return m[1];
          if (window.dtsg) return window.dtsg;
          return '';
        }).catch(() => '');
        sharedFbUserId = await sharedPage.evaluate(() => (document.cookie.match(/c_user=(\d+)/) || [])[1] || '').catch(() => '');
        
        log('INFO', `[ChangeCurrency/TZ] ✅ Phase1: token=${cachedToken ? cachedToken.substring(0,10)+'...' : '❌'}, fbDtsg=${sharedFbDtsg ? '✅' : '❌'}, fbUserId=${sharedFbUserId || '❌'}`);
        browserStartedOk = true;
        break;
      } catch (e) {
        const isBrowserDead = e && /Session closed|detached Frame|Protocol error|Target closed|Unable to find page|Page crashed/i.test(e.message);
        if (isBrowserDead && retryAttempt < 2) { log('WARN', `[ChangeCurrency/TZ] 浏览器断开重试...`); continue; }
        log('ERROR', `[ChangeCurrency/TZ] 浏览器启动失败: ${e.message}`);
        browserLaunchError = e.message;
        sharedBrowser = null; sharedPage = null;
        break;
      }
    }
  }

  // ============ PHASE 2: 并行处理所有广告号 ============
  log('INFO', `[ChangeCurrency/TZ] 📦 Phase2: 并行处理 ${adAccountIds.length} 个广告号...`);

  // 🩹 进门条件放宽：地址写入走的是「页面内 fetch('/api/graphql/') + fb_dtsg」，跟 access_token
  //    无关（token 只用于同一段里的货币/时区/国家 REST 调用）。以前必须 cachedToken 才进来，
  //    于是 token 一旦取不到，连纯靠 fb_dtsg 的地址也一起写不进去 —— 表现就是「货币时区变了、
  //    国家账单街道没变」。现在有地址变更时，只要有页面 + fb_dtsg 就进来。
  if (browserStartedOk && sharedPage && sharedFbDtsg && (cachedToken || hasAddressChange)) {
    // 🚀 转发浏览器 console 日志到服务端终端，方便调试方案A的API调用
    const origLogFn = (msg) => { const t = msg.text(); if (t.includes('[ChangeCurrency/TZ/DBG]')) log('INFO', `[Browser] ${t}`); };
    sharedPage.on('console', origLogFn);

    // 方案A: 有浏览器+fbDtsg → 单个 page.evaluate + Promise.all 并行提交
    const batchResult = await sharedPage.evaluate(async (p) => {
      const { accounts, currency, timezoneId, country, address, city, zip, state, token, fbDtsg, businessName, addrCountry } = p;
      const tasks = accounts.map(async (actId) => {
        const cleanId = actId.replace('act_', '');
        const res = { adAccountId: actId, success: false, message: '', apiSuccess: false, apiErrors: [] };
        const apiParts = [];
        // 1. 货币/时区
        if (currency || timezoneId) {
          try {
            const fd = new URLSearchParams(); fd.append('access_token', token);
            if (currency) fd.append('currency', currency);
            if (timezoneId) fd.append('timezone_id', timezoneId);
            console.log(`[ChangeCurrency/TZ/DBG] 方案A发送: act_${cleanId} timezone_id=${timezoneId||'无'} currency=${currency||'无'}`);
            const r = await fetch(`https://graph.facebook.com/v19.0/act_${cleanId}?fields=id,name,timezone_id`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fd.toString() });
            const d = await r.json();
            console.log(`[ChangeCurrency/TZ/DBG] 方案A响应: act_${cleanId} timezone_id=${d?.timezone_id||'无'} status=${JSON.stringify(d).substring(0,150)}`);
            if (d && !d.error) { res.apiSuccess = true; if (currency) apiParts.push(`货币=${currency}`); if (timezoneId) apiParts.push(`时区ID=${timezoneId}`); }
            else { res.apiErrors.push(`货币/时区: ${d?.error?.message||''}`); }
          } catch(e) { res.apiErrors.push(`货币/时区: ${e}`); }
        }
        // 2. 国家
        if (country) {
          try {
            const fd2 = new URLSearchParams(); fd2.append('access_token', token); fd2.append('business_country_code', country);
            const r2 = await fetch(`https://graph.facebook.com/v19.0/act_${cleanId}?fields=id`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fd2.toString() });
            const d2 = await r2.json();
            if (d2 && !d2.error) { res.apiSuccess = true; apiParts.push(`国家=${country}`); }
            else { res.apiErrors.push(`国家: ${d2?.error?.message||''}`); }
          } catch(e) { res.apiErrors.push(`国家: ${e}`); }
        }
        // 3. 地址 → GraphQL
        if (address || city || zip || state) {
          try {
            const gqlInput = {
              billable_account_payment_legacy_account_id: cleanId, payment_account_id: cleanId, device_country: null,
              tax: { business_address: { city: city||'', country_code: addrCountry, state: state||'', street1: address||'', street2: '', zip: zip||'' }, business_name: businessName||'', is_personal_use: false, second_tax_id: '', tax_id: '', tax_registration_status: '' }
            };
            const fd = new URLSearchParams(); fd.append('fb_dtsg', fbDtsg); fd.append('variables', JSON.stringify({input: gqlInput})); fd.append('doc_id', '26388239514182128');
            const gqlR = await fetch('/api/graphql/', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fd.toString() });
            let t = await gqlR.text(); const i = t.indexOf('{'); const gqlD = JSON.parse(i>0?t.substring(i):t);
            if (gqlD && gqlD.data?.billable_account_update?.payment_account?.billable_account?.billable_account_tax_info) { res.apiSuccess = true; apiParts.push('地址✅'); }
            else { res.apiErrors.push(`地址GQL: ${gqlD?.error||JSON.stringify(gqlD).substring(0,200)}`); }
          } catch(e) { res.apiErrors.push(`地址GQL: ${e}`); }
        }
        res.success = res.apiSuccess || apiParts.length > 0;
        res.message = apiParts.length > 0 ? `✅ ${apiParts.join('、')}` : `❌ ${res.apiErrors.join('; ')}`;
        return res;
      });
      return await Promise.all(tasks);
    }, {
      accounts: adAccountIds, currency: (currency&&currency.trim())||'', timezoneId: normalizedTz||'',
      country: (country&&country.trim())||'', address: (address&&address.trim())||'', city: (city&&city.trim())||'',
      zip: (zip&&zip.trim())||'', state: (state&&state.trim())||'', token: cachedToken||'',
      fbDtsg: sharedFbDtsg, businessName: (business_name||''),
      addrCountry: ((country||'US').toUpperCase()==='UK'?'GB':(country||'US').toUpperCase())
    });
    
    // 🚀 打印方案A每个广告号的API执行结果
    for (const br of batchResult) {
      log('INFO', `[ChangeCurrency/TZ] 方案A结果: ${br.adAccountId} apiSuccess=${br.apiSuccess} msg="${br.message}" errors=${JSON.stringify(br.apiErrors||[])}`);
    }
    
    // 🚀 REST API 修改货币/时区失败 → 兜底使用 GraphQL mutation
    const failedCurrencyTz = batchResult.filter(br => br.apiErrors && br.apiErrors.some(e => e.includes('Invalid parameter') || e.includes('1819008')));
    if (failedCurrencyTz.length > 0 && (currency || normalizedTz)) {
      log('INFO', `[ChangeCurrency/TZ] ⚠️ REST API 货币/时区修改失败，兜底使用 GraphQL mutation (${failedCurrencyTz.length} 个广告号)`);
      for (const failItem of failedCurrencyTz) {
        try {
          const cleanId = String(failItem.adAccountId).replace('act_', '');
          const payId = String(adAccountIds.find(a => a === failItem.adAccountId) || cleanId).replace('act_', '');
          const addrCountry = ((country||'US').toUpperCase()==='UK'?'GB':(country||'US').toUpperCase());
          const gqlVariables = JSON.stringify({
            input: {
              billable_account_payment_legacy_account_id: cleanId,
              payment_account_id: payId,
              currency: (currency || 'USD'),
              device_country: null,
              tax: {
                business_address: { city: (city||''), country_code: addrCountry, state: (state||''), street1: (address||''), street2: '', zip: (zip||'') },
                business_name: (business_name||''), is_personal_use: false, second_tax_id: '', tax_id: '', tax_registration_status: ''
              },
              timezone: (normalizedTz || null),
              upl_logging_data: {
                billing_notification_id: '', context: 'billingaccountinfo', credential_type: 'NEW_CREDIT_CARD',
                entry_point: 'ads_manager',
                external_flow_id: 'upl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 36),
                target_name: 'BillingAccountInformationFormMutation',
                user_session_id: 'upl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 36),
                wizard_config_name: '', wizard_name: '', wizard_screen_name: 'account_information_state_display',
                wizard_session_id: 'upl_wizard_' + Date.now() + '_' + Math.floor(Math.random() * 1000000)
              }
            }
          });
          const gqlResult = await sharedPage.evaluate(async (p) => {
            try {
              return await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', p.endpoint, true);
                xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                xhr.withCredentials = true;
                xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ raw: (xhr.responseText||'').substring(0,500), status: xhr.status }); } };
                xhr.onerror = () => resolve({ error: 'xhr_error:'+(xhr.status||'no_status') });
                xhr.ontimeout = () => resolve({ error: 'xhr_timeout' });
                xhr.timeout = 15000;
                xhr.send('fb_dtsg='+encodeURIComponent(p.fbDtsg)+'&variables='+encodeURIComponent(p.variables)+'&doc_id='+encodeURIComponent(p.docId));
              });
            } catch (e) { return { error: 'xhr_exception:'+e.message }; }
          }, { fbDtsg: sharedFbDtsg, variables: gqlVariables, docId: '26388239514182128', endpoint: 'https://business.facebook.com/api/graphql/' });
          
          const gqlOk = gqlResult && !gqlResult.errors && !gqlResult.error;
          log('INFO', `[ChangeCurrency/TZ] GraphQL兜底 ${failItem.adAccountId}: ${gqlOk ? '✅成功' : '❌失败'} ${JSON.stringify(gqlResult).substring(0,200)}`);
          if (gqlOk) {
            failItem.apiSuccess = true;
            failItem.message = (failItem.message||'') + '；⭕GraphQL兜底修改货币/时区成功';
          }
        } catch (gqlErr) {
          log('WARN', `[ChangeCurrency/TZ] GraphQL兜底异常 ${failItem.adAccountId}: ${gqlErr.message}`);
        }
      }
    }
    
    results.push(...batchResult);
    
    // 移除 console 监听
    try { sharedPage.removeListener('console', origLogFn); } catch {}
    
    // [已注释] Token 过期检测 → UI 降级（用户要求注释掉，直接用 API 方式）
    /*
    const allErrStr = batchResult.map(r=>(r.apiErrors||[]).join(' ')).join(' ');
    if (allErrStr.includes('190')||allErrStr.includes('session has been invalidated')||allErrStr.includes('Error validating access token')) {
      log('INFO', `[ChangeCurrency/TZ] 🔌 Token过期，降级到 billing hub UI 交互 (profileId=${profileId})`);
      for (const aid of adAccountIds) {
        try {
          await navigateToBillingHub(sharedPage, aid);
          await new Promise(r => setTimeout(r, 3000));
          const uiResult = await sharedPage.evaluate(async (p) => {
            const { currency, timezoneId } = p;
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            let editBtn = null;
            const allBtns = document.querySelectorAll('div[role="button"], button, span[role="button"], a[role="button"]');
            for (const btn of allBtns) {
              const txt = (btn.textContent || '').trim().toLowerCase();
              const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
              if (txt === 'edit' || txt === '编辑' || aria === 'edit' || aria === '编辑' ||
                  txt.includes('edit business info') || txt.includes('编辑业务信息')) {
                editBtn = btn; break;
              }
            }
            if (!editBtn) return { success: false, error: '未找到 Edit 按钮' };
            editBtn.click();
            await sleep(2000);
            if (currency) {
              const sel = document.querySelector('select[name="currency"]') ||
                          document.querySelector('[data-testid="currency-select"] select') ||
                          document.querySelector('select[aria-label*="currency" i]');
              if (sel) { sel.value = currency; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(500); }
            }
            if (timezoneId) {
              const sel = document.querySelector('select[name="timezone_id"]') ||
                          document.querySelector('[data-testid="timezone-select"] select') ||
                          document.querySelector('select[aria-label*="timezone" i]') ||
                          document.querySelector('select[aria-label*="时区" i]');
              if (sel) { sel.value = timezoneId; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(500); }
            }
            let saveBtn = null;
            for (const btn of document.querySelectorAll('div[role="button"], button, span[role="button"]')) {
              const txt = (btn.textContent || '').trim().toLowerCase();
              if (txt === 'save' || txt === '保存' || txt === 'continue' || txt === '确认' || txt === '下一步' ||
                  txt.includes('save changes') || txt.includes('保存更改')) {
                saveBtn = btn; break;
              }
            }
            if (!saveBtn) return { success: false, error: '未找到 Save 按钮' };
            saveBtn.click();
            await sleep(3000);
            return { success: true, message: 'UI 交互成功' };
          }, { currency: (currency||'').trim(), timezoneId: normalizedTz||'' });
          results.push({ adAccountId: aid, success: uiResult.success, message: uiResult.success ? '✅ 货币/时区(UI交互)' : `❌ ${uiResult.error}`, apiSuccess: true });
        } catch (uiErr) {
          log('WARN', `[ChangeCurrency/TZ] UI 交互失败 ${aid}: ${uiErr.message}`);
          results.push({ adAccountId: aid, success: false, message: `UI交互失败: ${uiErr.message}`, apiSuccess: false });
        }
      }
      return res.json({ success: true, loginFailed: false, message: '已通过 UI 交互完成部分修改', results });
    }
    */
    
  } else if (cachedToken && hasApiChange) {
    // 方案B: 纯 API（无地址变更）→ Node.js 并行 fetch
    // 🚀 先验证 Token 是否有效，避免静默失败
    let tokenValid = true;
    try {
      const verifyUrl = `https://graph.facebook.com/v21.0/me?fields=id&access_token=${encodeURIComponent(cachedToken)}`;
      const verifyRes = await fetch(verifyUrl).then(r => r.json()).catch(() => {});
      if (verifyRes && verifyRes.error) {
        log('WARN', `[ChangeCurrency/TZ] 纯 API Token 过期，尝试启动浏览器 UI 降级`);
        tokenValid = false;
      }
    } catch {}
    if (!tokenValid && sharedBrowser && sharedPage && sharedFbDtsg) {
      // [已注释] 方案B UI 降级（用户要求注释掉，直接用 API 方式）
      log('WARN', `[ChangeCurrency/TZ] 纯 API Token 过期，但浏览器 UI 降级已注释，尝试直接 API`);
      tokenValid = false; // 放行到纯 API
      /*
      // 有浏览器 → 使用 UI 降级
      log('INFO', `[ChangeCurrency/TZ] 降级到 billing hub UI 交互 (方案B)`);
      for (const aid of adAccountIds) {
        try {
          await navigateToBillingHub(sharedPage, aid);
          await new Promise(r => setTimeout(r, 3000));
          const uiResult = await sharedPage.evaluate(async (p) => {
            const { currency, timezoneId } = p;
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            let editBtn = null;
            const allBtns = document.querySelectorAll('div[role="button"], button, span[role="button"], a[role="button"]');
            for (const btn of allBtns) {
              const txt = (btn.textContent || '').trim().toLowerCase();
              const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
              if (txt === 'edit' || txt === '编辑' || aria === 'edit' || aria === '编辑' ||
                  txt.includes('edit business info') || txt.includes('编辑业务信息')) {
                editBtn = btn; break;
              }
            }
            if (!editBtn) return { success: false, error: '未找到 Edit 按钮' };
            editBtn.click();
            await sleep(2000);
            if (currency) {
              const sel = document.querySelector('select[name="currency"]') || document.querySelector('[data-testid*="currency"] select') ||
                          document.querySelector('select[aria-label*="currency" i]');
              if (sel) { sel.value = currency; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(500); }
            }
            if (timezoneId) {
              const sel = document.querySelector('select[name="timezone_id"]') || document.querySelector('[data-testid*="timezone"] select') ||
                          document.querySelector('select[aria-label*="timezone" i]');
              if (sel) { sel.value = timezoneId; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(500); }
            }
            let saveBtn = null;
            for (const btn of document.querySelectorAll('div[role="button"], button, span[role="button"]')) {
              const txt = (btn.textContent || '').trim().toLowerCase();
              if (txt === 'save' || txt === '保存' || txt === 'continue' || txt === '确认' || txt === '下一步' ||
                  txt.includes('save changes') || txt.includes('保存更改')) {
                saveBtn = btn; break;
              }
            }
            if (!saveBtn) return { success: false, error: '未找到 Save 按钮' };
            saveBtn.click();
            await sleep(3000);
            return { success: true, message: 'UI 交互成功' };
          }, { currency: (currency||'').trim(), timezoneId: normalizedTz||'' });
          results.push({ adAccountId: aid, success: uiResult.success, message: uiResult.success ? '✅ 货币/时区(UI交互)' : `❌ ${uiResult.error}`, apiSuccess: true });
        } catch (uiErr) {
          results.push({ adAccountId: aid, success: false, message: `UI交互失败: ${uiErr.message}`, apiSuccess: false });
        }
      }
      */
    } else {
      log('INFO', `[ChangeCurrency/TZ] ⚡ 纯 API 并行: ${adAccountIds.length} 个广告号`);
    const apiTasks = adAccountIds.map(async (aid) => {
      const cleanId = String(aid).replace('act_', '');
      const res = { adAccountId: aid, success: false, message: '', apiSuccess: false };
      const parts = [];
      let apiErr = '';
      try {
        if (currency||normalizedTz) {
          const fd = new URLSearchParams(); fd.append('access_token', cachedToken);
          if (currency&&currency.trim()) fd.append('currency', currency.trim());
          if (normalizedTz) fd.append('timezone_id', normalizedTz);
          // 🚑 调试：打印请求参数
          log('INFO', `[ChangeCurrency/TZ/DBG] 纯API发送: act_${cleanId} timezone_id=${normalizedTz} currency=${currency||'无'}`);
          const r = await fetch(`https://graph.facebook.com/v19.0/act_${cleanId}`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fd.toString() });
          const d = await r.json();
          log('INFO', `[ChangeCurrency/TZ/DBG] 纯API响应: ${JSON.stringify(d).substring(0,200)}`);
          if (d&&!d.error) { res.apiSuccess = true; if (currency) parts.push(`货币=${currency}`); if (normalizedTz) parts.push(`时区ID=${normalizedTz}`); }
          else if (d && d.error) { apiErr = d.error.message || JSON.stringify(d.error); }
        }
        if (country&&country.trim()) {
          const fd2 = new URLSearchParams(); fd2.append('access_token', cachedToken); fd2.append('business_country_code', country.trim());
          const r2 = await fetch(`https://graph.facebook.com/v19.0/act_${cleanId}`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fd2.toString() });
          const d2 = await r2.json();
          if (d2&&!d2.error) { res.apiSuccess = true; parts.push(`国家=${country}`); }
          else if (d2 && d2.error) { apiErr = apiErr || (d2.error.message || JSON.stringify(d2.error)); }
        }
        // 🐛 修复口径：以前无论 Graph 是否报错都写 res.success = true（message 却是"已保存到本地"），
        //    于是"没下发成功"又被当成成功。现在只有真的下发成功才算成功。
        if (res.apiSuccess) {
          res.success = true;
          res.message = `已通过 API 修改: ${parts.join('、') || '无变更'}`;
        } else {
          res.success = false;
          res.message = `未下发到 Meta${apiErr ? `（${apiErr}）` : '（API 未返回成功）'}`;
        }
      } catch(e) {
        res.success = false;
        res.message = `未下发到 Meta（API 请求失败: ${e.message}）`;
      }
      return res;
    });
    results.push(...(await Promise.all(apiTasks)));
    }
  } else {
    // 🐛 修复（静默降级）：以前这里一律 results.push({ success: true, message: '已保存到本地' })，
    //    于是"浏览器起不来 / 拿不到 Token → 改动根本没下发到 Meta"在界面上被统计成"成功"。
    //    现在区分两种情况：有账单变更要下发 → 如实报失败；本来就没有 API 变更（例如只切语言）→ 维持本地保存语义。
    const reason = browserLaunchError
      ? `浏览器启动失败(${browserLaunchError})`
      : (!cachedToken ? '未获取到有效 Token' : '浏览器不可用');
    if (hasApiChange) {
      log('ERROR', `[ChangeCurrency/TZ] ❌ 无法下发到 Meta：${reason}，仅保存到本地`);
      for (const aid of adAccountIds) results.push({
        adAccountId: aid,
        success: false,
        apiSuccess: false,
        appliedLocallyOnly: true,
        message: `未下发到 Meta（${reason}），仅保存到本地`
      });
    } else {
      log('WARN', `[ChangeCurrency/TZ] 无可下发的账单变更（${reason}），仅保存到本地`);
      for (const aid of adAccountIds) results.push({
        adAccountId: aid,
        success: true,
        apiSuccess: false,
        message: '已保存到本地（本次无 API 变更）'
      });
    }
  }

  // [已注释] Phase 2b: 降级处理 - 后续可按需启用
  /*
  // ============ PHASE 2b: 降级 - GraphQL 失败广告号逐个导航重试 ============
  const failedOnes = results.filter(r => !r.success || (r.apiErrors && r.apiErrors.length > 0));
  if (failedOnes.length > 0 && browserStartedOk && sharedPage) {
    log('INFO', `[ChangeCurrency/TZ] 🔄 降级: ${failedOnes.length} 个广告号逐个导航账单页重试...`);
    for (const fa of failedOnes) {
      try {
        log('INFO', `[ChangeCurrency/TZ] 降级导航 ${fa.adAccountId}...`);
        await navigateToBillingHub(sharedPage, fa.adAccountId);
        await new Promise(r => setTimeout(r, 3000));
        const retryDtsg = await sharedPage.evaluate(() => {
          try { const CD = typeof window.require === 'function' && window.require('CurrentUserInitialData'); if (CD && CD.fbDtsg) return CD.fbDtsg; } catch {}
          const inp = document.querySelector('input[name="fb_dtsg"]'); if (inp && inp.value) return inp.value;
          return '';
        }).catch(() => '');
        if (retryDtsg && (address||city||zip||state)) {
          const cleanId = String(fa.adAccountId).replace('act_', '');
          const addrC = ((country||'US').toUpperCase()==='UK'?'GB':(country||'US').toUpperCase());
          const retryRes = await sharedPage.evaluate(async (p) => {
            const {cid,address,city,zip,state,fbDtsg,bName,addrC:ac} = p;
            const gqlInput = { billable_account_payment_legacy_account_id: cid, payment_account_id: cid, device_country: null,
              tax: { business_address: { city: city||'', country_code: ac, state: state||'', street1: address||'', street2: '', zip: zip||'' }, business_name: bName||'', is_personal_use: false, second_tax_id: '', tax_id: '', tax_registration_status: '' } };
            const fd = new URLSearchParams(); fd.append('fb_dtsg', fbDtsg); fd.append('variables', JSON.stringify({input: gqlInput})); fd.append('doc_id', '26388239514182128');
            try { const r = await fetch('/api/graphql/', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fd.toString() }); let t=await r.text(); const i=t.indexOf('{'); return JSON.parse(i>0?t.substring(i):t); } catch(e) { return {error:String(e)}; }
          }, { cid: cleanId, address: address||'', city: city||'', zip: zip||'', state: state||'', fbDtsg: retryDtsg, bName: business_name||'', addrC });
          if (retryRes && retryRes.data?.billable_account_update?.payment_account?.billable_account?.billable_account_tax_info) {
            fa.success = true; fa.message = (fa.message||'')+'；降级重试✅'; fa.apiSuccess = true;
          }
        }
        // 表单兜底
        if (!fa.success && (address||city||zip||state)) {
          try {
            if (address&&address.trim()) { const ai = await sharedPage.$('input[name="business_address"]')||await sharedPage.$('input[placeholder*="address" i]'); if(ai){await ai.click({clickCount:3});await ai.type(address.trim(),{delay:30});} }
            if (city&&city.trim()) { const ci = await sharedPage.$('input[name="city"]')||await sharedPage.$('input[placeholder*="city" i]'); if(ci){await ci.click({clickCount:3});await ci.type(city.trim(),{delay:30});} }
            if (zip&&zip.trim()) { const zi = await sharedPage.$('input[name="zip"]')||await sharedPage.$('input[placeholder*="zip" i]')||await sharedPage.$('input[placeholder*="postal" i]'); if(zi){await zi.click({clickCount:3});await zi.type(zip.trim(),{delay:30});} }
            if (state&&state.trim()) { const ss = await sharedPage.$('select[name*="state" i]')||await sharedPage.$('select[name*="region" i]'); if(ss){await ss.selectOption(state.trim());}else{const si=await sharedPage.$('input[name*="state" i]')||await sharedPage.$('input[placeholder*="state" i]'); if(si){await si.click({clickCount:3});await si.type(state.trim(),{delay:30});} } }
            const sBtns = ['button[data-testid*="save" i]','button[aria-label*="Save" i]','[data-testid*="save-button" i]','div[aria-label*="Save" i][role="button"]'];
            for(const s of sBtns) { const btn = await sharedPage.$(s); if(btn) { await btn.evaluate(b=>b.click()); await new Promise(r=>setTimeout(r,3000)); break; } }
          } catch(e) { log('WARN',`[ChangeCurrency/TZ] 表单失败: ${e.message}`); }
        }
        // 智能更新兜底
        if (!fa.success && (country||address||city||zip||state)) {
          try { const smart = await tryUpdateBillingCountrySmart(sharedPage,fa.adAccountId,country,currency,normalizedTz,address,city,zip,state,null,lang); if(smart&&(smart.api||smart.dsl||smart.form)){fa.success=true;fa.message=(fa.message||'')+'；智能更新✅';} } catch(e){log('WARN',`智能更新:${e.message}`);}
        }
      } catch(e) { log('WARN',`降级 ${fa.adAccountId}: ${e.message}`); }
    }
  }
  */

  // ============ PHASE 3: 保存到本地+云端 ============
  const updFields = {};
  if (currency && currency.trim()) updFields.currency = currency.trim();
  // 🕒 存「名称+偏移」（如 Asia/Taipei+8），不再存 FB 数字时区ID
  if (timezone_id && String(timezone_id).trim()) updFields.timezone_id = toDisplayTimezone(timezone_id);
  if (country && country.trim()) updFields.country = country.trim();
  if (address && address.trim()) updFields.address = address.trim();
  if (city && city.trim()) updFields.city = city.trim();
  if (zip && zip.trim()) updFields.zip = zip.trim();
  
  const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
  const baseUrl = storageServerUrl.replace(/\/$/, '');
  
  if (Object.keys(updFields).length > 0) {
    const items = adAccountIds.map(aid => ({ profileId, accountId: String(aid), ...updFields }));
    try { await fetch(`${baseUrl}/api/adaccount-settings/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) }); } catch {}
    try {
      const sdb = new sqlite3.Database(dbPath);
      await ensureAdAccountsTable(sdb);
      await ensureAdAccountsColumns(sdb);
      const setClauses = Object.keys(updFields).map(k => `${k} = ?`).join(', ');
      const setValues = Object.values(updFields);
      for (const aid of adAccountIds) {
        await new Promise((resolve, reject) => { sdb.run(`UPDATE ad_accounts SET ${setClauses}, updated_at = CURRENT_TIMESTAMP WHERE (account_id = ? OR id = ?) AND profile_id = ?`, [...setValues, String(aid), String(aid), String(profileId)], (err) => err ? reject(err) : resolve()); });
      }
      sdb.close();
    } catch (localErr) { log('WARN', `[AdAccount] 本地更新失败: ${localErr.message}`); }
  }
  
  // 补全未设置 message 的结果
  for (const r of results) {
    if (!r.message) {
      const parts = [];
      if (currency) parts.push(`货币=${currency}`);
      if (timezone_id) parts.push(`时区已保存`);
      if (country) parts.push(`国家已保存`);
      if (address) parts.push(`地址已保存`);
      if (city) parts.push(`城市已保存`);
      if (zip) parts.push(`邮编已保存`);
      r.message = parts.join('；') || '已保存';
    }
  }

  // 🚀 关闭浏览器
  log('INFO', `[ChangeCurrency/TZ] 🔌 所有任务完成，关闭浏览器 (profileId=${profileId})`);
  try { if (sharedBrowser) { try { await sharedBrowser.close(); } catch {} } const bd = activeBrowsers.get(String(profileId)); if (bd && bd.browser) { try { await bd.browser.close(); } catch {} } activeBrowsers.delete(String(profileId)); } catch {}
  // 🐛 修复：以前无论是否真的下发到 Meta 都返回 success: true（completed 也只统计 r.success），
  //    导致"浏览器起不来 → 只存本地"在界面上显示为成功。现在如实返回各维度计数。
  const totalCount = adAccountIds.length;
  const apiSuccessCount = results.filter(r => r.apiSuccess).length;
  const localOnlyCount = results.filter(r => r.appliedLocallyOnly).length;
  const failedCount = results.filter(r => r.success === false && !r.appliedLocallyOnly).length;
  const allOk = totalCount > 0 && localOnlyCount === 0 && failedCount === 0;
  return res.json({
    success: allOk,
    results,
    total: totalCount,
    completed: apiSuccessCount,
    apiSuccessCount,
    localOnlyCount,
    failedCount,
    message: allOk
      ? `已处理 ${totalCount} 个广告号（下发 Meta ${apiSuccessCount} 个）`
      : `已下发 Meta ${apiSuccessCount}/${totalCount}` +
        (localOnlyCount ? `；${localOnlyCount} 个仅保存本地未下发` : '') +
        (failedCount ? `；${failedCount} 个失败` : '')
  });
})


// ===== post '/api/facebook/change-language' (original lines 6470-6490) =====
app.post('/api/facebook/change-language', async (req, res) => {
  try {
    const { profileId, lang } = req.body || {}
    if (!profileId || !lang) return res.status(400).json({ success: false, message: '缺少 profileId 或 lang（如 en_US）' })
    log('INFO', `[ChangeLang] 开始修改语言: profileId=${profileId}, target=${lang}`)

    // 获取浏览器
    const browserData = activeBrowsers.get(profileId)
    if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
      return res.status(400).json({ success: false, message: '该配置无运行中的浏览器，请先启动浏览器' })
    }
    const browser = browserData.browser

    // 直接调用已有的 ensureFbLanguage 函数（与 ChangeBillingCountry/ChangeCurrencyTZ 相同逻辑）
    const success = await ensureFbLanguage(browser, lang)
    
    return res.json({ success, message: success ? `语言已修改为 ${lang}` : '语言修改失败', lang })
  } catch (e) {
    return res.status(500).json({ success: false, message: String(e.message || e) })
  }
})


// ===== post '/api/facebook/adaccounts/spend-cap' =====
// 💰 真正写入广告账户在 Meta 上的「账户花费上限」(spend_cap)。
//    以前这里只调 /api/adaccount-settings/bulk-save 写本地设置表，Facebook 上的限额纹丝不动
//    —— 点下去是个假功能。现在先写 Meta，成功后再同步本地缓存（供界面展示）。
//    ⚠️ 单位：按需求「不换算」——界面输入多少就原样提交多少（0.02 就提交 0.02），
//       读取侧同样不换算，保证提交值与界面显示值一致。
app.post('/api/facebook/adaccounts/spend-cap', async (req, res) => {
  try {
    const { profileId, adAccountId, spend_cap, currency } = req.body || {}
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
    if (spend_cap === undefined || spend_cap === null || String(spend_cap).trim() === '') {
      return res.status(400).json({ success: false, message: 'missing spend_cap' })
    }
    const actId = String(adAccountId).replace(/^act_/, '')
    const cap = Number(spend_cap) // 🔁 不换算：原样提交
    if (!Number.isFinite(cap) || cap < 0) {
      return res.status(400).json({ success: false, message: `限额数值无效: ${String(spend_cap)}` })
    }

    const profile = await findProfileById(profileId).catch(() => null)
    const token = String(profile?.account_tokens || profile?.token || '').trim()
    if (!profile || !token) {
      return res.json({ success: false, message: '缺少可用 TOKEN（无法写入 Meta），请先重新获取 TOKEN' })
    }

    const params = new URLSearchParams()
    params.set('spend_cap', String(cap))
    log('INFO', `[SetSpendCap] 写入 Meta: act_${actId} spend_cap=${cap}（界面输入 ${spend_cap} ${currency || ''}，不换算）`)
    const r = await callFacebookGraphApi(`act_${actId}`, 'POST', params, profile, token)
    if (r && r.error) {
      const msg = `(${r.error.code || ''}) ${r.error.message || ''}`
      log('WARN', `[SetSpendCap] Meta 拒绝 act_${actId}: ${msg}`)
      return res.json({ success: false, message: msg })
    }

    // Meta 写成功后再同步本地/云端设置表；这一步失败不影响真实限额，只影响界面显示
    try {
      const baseUrl = (process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '')
      const items = [{ profileId, accountId: String(adAccountId), spend_cap: cap }]
      await fetch(`${baseUrl}/api/adaccount-settings/bulk-save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
      })
    } catch (e) {
      log('WARN', `[SetSpendCap] Meta 已写入，但本地缓存同步失败（不影响真实限额）: ${e.message}`)
    }

    return res.json({ success: true, spend_cap: cap })
  } catch (e) {
    return res.status(500).json({ success: false, message: String(e.message || e) })
  }
})


// ===== post '/api/facebook/adaccounts/topup' (original lines 6509-6531) =====
app.post('/api/facebook/adaccounts/topup', async (req, res) => {
  try {
    const { profileId, adAccountId, amount } = req.body || {}
    if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
    const storageServerUrl = process.env.STORAGE_SERVER_URL || ''
    const baseUrl = storageServerUrl.replace(/\/$/, '')
    // 读取现有设置
    let current = 0
    try {
      const settingsResp = await fetch(`${baseUrl}/api/adaccounts`)
      const settingsJson = await settingsResp.json()
      const arr = Array.isArray(settingsJson?.data) ? settingsJson.data : []
      const found = arr.find((x) => String(x.profileId) === String(profileId) && String(x.adAccountId) === String(adAccountId))
      current = Number(found?.spend || 0)
    } catch {}
    const items = [{ profileId, accountId: String(adAccountId), amount_spent: Number(current) + Number(amount||0) }]
    const resp = await fetch(`${baseUrl}/api/adaccount-settings/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) })
    const json = await resp.json()
    return res.json({ success: !!json?.success, count: json?.count || items.length })
  } catch (e) {
    return res.status(500).json({ success: false, message: String(e.message || e) })
  }
})


// ===== post '/api/facebook/relogin' (original lines 7460-7589) =====
app.post('/api/facebook/relogin', async (req, res) => {
  try {
    const { profileId } = req.body || {};
    if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
    const browserData = activeBrowsers.get(String(profileId || ''));
    if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
      return res.json({ success: false, status: 'no_browser' });
    }
    const browser = browserData.browser;
    const page = await browser.newPage();
    let clicked = false;
    let loggedIn = false;
    let saved = 0;
    let closed = false;
    try {
      // await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
      // User wants to visit Graph API to get config? 
      // No, this is relogin logic.
      // Let's keep it as is but fix storage url below if needed.
      await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
      const prof = await findProfileById(String(profileId));
      const ok = await autoFillPasswordOnPage(page, prof || {}, String(profileId));
      try { await new Promise(r => setTimeout(r, )); } catch {}
      if (ok) {
        try {
          const info = await page.evaluate(async () => {
            const visible = (el) => {
              const cs = getComputedStyle(el);
              return cs && cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
            };
            const qs = (s) => Array.from(document.querySelectorAll(s));
            const norm = (s) => String(s || '').trim().toLowerCase();
            const btns = [
              ...qs('button[type="submit"]'),
              ...qs('input[type="submit"]'),
              ...qs('#loginbutton'),
              ...qs('button[name="login"]'),
              ...qs('[data-testid*="login" i]'),
              ...qs('button'),
              ...qs('div[role="button"]'),
              ...qs('a[role="button"]')
            ];
            let target = btns.find(b => visible(b) && (/登录|log in|signin|sign in|登入/i.test(norm(b.textContent)) || /登录|log in|signin|sign in|登入/i.test(norm(b.getAttribute('aria-label')))));
            if (!target) target = btns.find(b => visible(b));
            if (target) {
              try { target.scrollIntoView({ block: 'center' }); } catch {}
              try { target.click(); } catch {}
              return { clicked: true, method: 'button' };
            }
            let pwd = document.querySelector('input[type="password"]');
            let form = null;
            if (pwd) form = pwd.form || pwd.closest('form');
            if (!form) {
              const user = document.querySelector('input[name="email"], input[name="username"], input[type="email"]');
              if (user) form = user.form || user.closest('form');
            }
            if (form) {
              try { form.submit(); } catch {}
              try { form.dispatchEvent(new Event('submit', { bubbles: true })); } catch {}
              return { clicked: true, method: 'form' };
            }
            if (pwd) {
              try { pwd.focus(); } catch {}
              try { document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); } catch {}
              return { clicked: true, method: 'enter' };
            }
            return { clicked: false };
          });
          clicked = !!(info && info.clicked);
        } catch {}
        try { await new Promise(r => setTimeout(r, )); } catch {}
        if (!loggedIn) {
          try {
            const pages = await browser.pages();
            let all = [];
            for (const p of pages) { try { const cks = await p.cookies(); all = all.concat(cks); } catch {} }
            const fb = all.filter(c => /facebook\.com$/i.test(String(c.domain||'')));
            const hasCUser = fb.some(c => c.name === 'c_user');
            const hasXs = fb.some(c => c.name === 'xs');
            loggedIn = !!(hasCUser && hasXs);
          } catch {}
        }
        if (clicked && !loggedIn) {
          try { if (page && !page.isClosed()) await page.close(); } catch {}
          try { if (browser && browser.isConnected()) await browser.close(); closed = true; } catch {}
          try { activeBrowsers.delete(String(profileId || '')); } catch {}
        }
        if (!closed && !loggedIn) {
          for (let i = 0; i < 20 && !loggedIn; i++) {
            try {
              const pages = await browser.pages();
              let all = [];
              for (const p of pages) { try { const cks = await p.cookies(); all = all.concat(cks); } catch {} }
              const fb = all.filter(c => /facebook\.com$/i.test(String(c.domain||'')));
              const hasCUser = fb.some(c => c.name === 'c_user');
              const hasXs = fb.some(c => c.name === 'xs');
              loggedIn = !!(hasCUser && hasXs);
            } catch {}
            if (!loggedIn) { try { await new Promise(r => setTimeout(r, )); } catch {} }
          }
        }
        // 登录成功则同步Cookie并关闭浏览器
        if (loggedIn) {
          try {
            const pages = await browser.pages();
            let allCookies = [];
            for (const p of pages) { try { const cks = await p.cookies(); allCookies = allCookies.concat(cks); } catch {} }
            const seen = new Set(); const dedup = [];
            for (const c of allCookies) { const key = `${c.domain}|${c.name}`; if (!seen.has(key)) { seen.add(key); dedup.push(c); } }
            const jsonData = JSON.stringify(dedup);
            const sdb = new sqlite3.Database(dbPath);
            await new Promise((resolve, reject) => {
              sdb.run(`UPDATE profiles SET account_cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [jsonData, profileId], function(err){ if (err) return reject(err); resolve(); });
            });
            await new Promise(r => sdb.close(r));
            saved = dedup.length;
          } catch {}
          try { if (page && !page.isClosed()) await page.close(); } catch {}
          try { if (browser && browser.isConnected()) await browser.close(); closed = true; } catch {}
          try { activeBrowsers.delete(String(profileId || '')); } catch {}
        } else {
          try { if (page && !page.isClosed()) await page.close(); } catch {}
          try { if (browser && browser.isConnected()) await browser.close(); closed = true; } catch {}
          try { activeBrowsers.delete(String(profileId || '')); } catch {}
        }
      }
    } catch {}
    return res.json({ success: true, clicked, loggedIn, saved, closed });
  } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }); }
})


// ===== post '/api/facebook/billing/bind-card-puppeteer' (original lines 8321-8627) =====
app.post('/api/facebook/billing/bind-card-puppeteer', async (req, res) => {
  try {
    const { profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC, ccIso, currency, timezone_id, cardholderName, billingStreet, billingCity, billingZip } = req.body || {};
    if (!profileId || !adAccountId || !ccNumber || !ccYear || !ccMonth || !ccCVC) {
      return res.status(400).json({ success: false, message: '缺少必要参数: profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC' });
    }

    log('INFO', `📌 通过 Puppeteer 绑卡到广告号: ${adAccountId}${currency ? ` + 修改货币=${currency}` : ''}${timezone_id ? ` + 修改时区ID=${timezone_id}` : ''}`);
    log('INFO', `💳 卡号: ****${ccNumber.slice(-4)}, 有效期: ${ccMonth}/${String(ccYear).slice(-2)}, 国家: ${ccIso || 'US'}`);

    const result = await ensureBrowserIsRunning(profileId);
    if (!result.success) {
      return res.status(500).json({ success: false, message: `浏览器启动失败: ${result.error}` });
    }

    const browser = result.browserData.browser;
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();
    const cleanActId = String(adAccountId).replace('act_', '');
    const billingHubUrl = buildBillingHubUrl(adAccountId);

    // 🚀 直接导航到统一账单设置页面
    try {
      await page.goto(billingHubUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      try { await page.waitForFunction(() => typeof window.dtsg !== 'undefined' && window.dtsg !== '', { timeout: 25000 }); } catch {}
      await new Promise(r => setTimeout(r, 5000));
    } catch (navErr) {
      log('WARN', `[bind-card-puppeteer] 导航到 billing_hub 失败: ${navErr.message}`);
    }

    // 获取 session 参数和 Token — 多重回退策略
    const sessionData = await page.evaluate(() => {
      let fbDtsg = '';
      let userId = '';
      // 策略1: window.dtsg
      try { if (window.dtsg) fbDtsg = window.dtsg; } catch {}
      // 策略2: 从 cookie 提取 user_id
      try {
        const c = document.cookie.match(/c_user=(\d+)/);
        if (c) userId = c[1];
      } catch {}
      // 策略3: 从 HTML script 标签中提取
      if (!fbDtsg || !userId) {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const html = s.innerHTML || '';
          if (!fbDtsg) {
            const m = html.match(/"dtsg":\{"token":"([^"]+)"/);
            if (m) fbDtsg = m[1];
          }
          if (!userId) {
            const m = html.match(/"USER_ID":"(\d+)"/) || html.match(/"userID":"(\d+)"/);
            if (m) userId = m[1];
          }
          if (fbDtsg && userId) break;
        }
      }
      // 策略4: 从 nextJS/SSR 数据中提取
      if (!fbDtsg) {
        try {
          const ele = document.getElementById('__NEXT_DATA__') || document.getElementById('__FB_DATA__');
          if (ele) {
            const data = JSON.parse(ele.textContent || '{}');
            fbDtsg = data?.dtsg?.token || data?.fb_dtsg || '';
          }
        } catch {}
      }
      return { fbDtsg, userId };
    });

    if (!sessionData.fbDtsg || !sessionData.userId) {
      // 最后尝试：直接导航到 business.facebook.com 再试
      log('WARN', `[bind-card-puppeteer] 首次提取 session 失败，重试...`);
      try {
        await page.goto(billingHubUrl, 
          { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        const retryData = await page.evaluate(() => {
          let fbDtsg = '';
          let userId = '';
          try { if (window.dtsg) fbDtsg = window.dtsg; } catch {}
          try { const c = document.cookie.match(/c_user=(\d+)/); if (c) userId = c[1]; } catch {}
          if (!fbDtsg) {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const s of scripts) {
              const m = (s.innerHTML || '').match(/"dtsg":\{"token":"([^"]+)"/);
              if (m) { fbDtsg = m[1]; break; }
            }
          }
          return { fbDtsg, userId };
        });
        if (retryData.fbDtsg && retryData.userId) {
          sessionData.fbDtsg = retryData.fbDtsg;
          sessionData.userId = retryData.userId;
        }
      } catch {}
    }

    if (!sessionData.fbDtsg || !sessionData.userId) {
      return res.status(400).json({ success: false, message: '浏览器未登录 Facebook，请先登录' });
    }

    log('INFO', `[bind-card-puppeteer] Session 就绪: userId=${sessionData.userId}, dtsg_prefix=${sessionData.fbDtsg.substring(0,8)}...`);

    // 提取 Token
    let token = '';
    try {
      const profile = await findProfileById(profileId);
      token = String(profile?.account_tokens || profile?.token || '').trim();
    } catch {}
    if (!token) {
      token = await page.evaluate(() => {
        try { const k = Object.keys(localStorage); for (const kk of k) { const v = localStorage.getItem(kk); if (v && (v.startsWith('EAAB') || v.startsWith('EAA'))) return v; } } catch {}
        try { if (window.__accessToken && String(window.__accessToken).startsWith('EA')) return window.__accessToken; } catch {}
        return '';
      }).catch(() => '');
    }

    // 🚀 先修改货币/时区（再绑卡，国家通过绑卡的 billing_address.country_code 设置）
    if (token && (currency || timezone_id)) {
      const cleanId = String(adAccountId).replace('act_', '');
      let fbTimezoneId = '';
      if (timezone_id) { const m = String(timezone_id).match(/^(\d{1,3})$/); if (m && Number(m[1]) >= 1 && Number(m[1]) <= 199) fbTimezoneId = m[1]; }
      try {
        const tzRes = await page.evaluate(async (params) => {
          const { cleanId, token, currency, timezoneId } = params;
          const fd = new URLSearchParams();
          fd.append('access_token', token);
          if (currency) fd.append('currency', currency);
          if (timezoneId) fd.append('timezone_id', timezoneId);
          try { const r = await fetch(`https://graph.facebook.com/v19.0/act_${cleanId}?fields=id,name,timezone_id`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fd.toString() }); return await r.json(); } catch(e) { return {error:e.message}; }
        }, { cleanId, token, currency: currency || '', timezoneId: fbTimezoneId });
        log('INFO', `💰 先修改货币/时区: ${JSON.stringify(tzRes).substring(0, 150)}`);
      } catch(ctErr) { log('WARN', `⚠️ 货币/时区预修改异常: ${ctErr.message}`); }
    }

    const cleanNumber = String(ccNumber).replace(/\s/g, '');
    const first8 = cleanNumber.substring(0, 8);
    const last4 = cleanNumber.slice(-4);
    const countryCode = ccIso || 'US';

    // 通过 page.evaluate 在页面上下文中执行绑卡
    // 先导航到 payment_settings 页面（确保 session 和页面上下文就绪）
    await navigateToBillingHub(page, adAccountId);
    await new Promise(r => setTimeout(r, 3000));

    // 使用原生 fetch 调用 GraphQL mutation
    // 补充 platform_trust_token（从页面 localStorage 尝试提取）
    const cardResult = await page.evaluate((params) => {
      const { actId, userId, fbDtsg, ccNum, ccYear, ccMonth, ccCVC, ccIso, ccFirst8, ccLast4, cardholderName, ccStreet, ccCity, ccZip } = params;
      return new Promise((resolve) => {
        // 设置 30 秒超时
        const timer = setTimeout(() => resolve({ error: 'evaluate timeout' }), 30000);

        // 尝试从页面提取 platform_trust_token（Facebook 存储在 localStorage 中）
        let platformTrustToken = '';
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (/trust.?token/i.test(k)) { platformTrustToken = localStorage.getItem(k) || ''; break; }
          }
          if (!platformTrustToken) {
            const allTrust = Object.keys(localStorage).filter(k => /trust/i.test(k));
            for (const k of allTrust) { const v = localStorage.getItem(k); if (v && v.length > 50) { platformTrustToken = v; break; } }
          }
        } catch(e) {}

        // 尝试从 sessionStorage 提取
        if (!platformTrustToken) {
          try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (/trust/i.test(k)) { platformTrustToken = sessionStorage.getItem(k) || ''; break; } } } catch(e) {}
        }

        // 生成 upl_logging_data（模仿 Facebook 的格式）
        const now = Date.now();
        const extFlowId = `upl_${Math.floor(now/1000)}_${Math.random().toString(16).slice(2, 18)}`;
        const userSessionId = `upl_${Math.floor(now/1000)}_${Math.random().toString(16).slice(2, 18)}`;
        const wizardSessionId = `upl_wizard_${now}_${Math.random().toString(16).slice(2, 18)}`;

        // 构建 variables（尽量匹配 Facebook 的真实请求格式）
        const variables = {
          input: {
            billing_address: { country_code: ccIso, ...(ccStreet ? {street: ccStreet} : {}), ...(ccCity ? {city: ccCity} : {}), ...(ccZip ? {zip: ccZip} : {}) },
            card_data: {
              bin: ccFirst8.substring(0,8),
              cardholder_name: cardholderName || '',
              credit_card_number: { sensitive_string_value: ccNum },
              csc: { sensitive_string_value: ccCVC },
              expiry_month: ccMonth,
              expiry_year: ccYear,
              last_4: ccLast4
            },
            client_info: { color_depth: '32', java_enabled: false, screen_height: '951', screen_width: '886' },
            network_tokenization_consent_given: false,
            payment_account_id: actId,
            payment_intent: 'ADD_PM',
            platform_trust_token: platformTrustToken || '',
            recurring_payment_consent_given: false,
            set_default: false,
            share_to_child_payment_account_id: null,
            skip_cvv_for_eea_save: false,
            upl_logging_data: {
              billing_notification_id: '',
              context: 'billingcreditcard',
              credential_type: 'NEW_CREDIT_CARD',
              entry_point: 'BILLING_HUB',
              external_flow_id: extFlowId,
              target_name: 'useBillingAddCreditCardMutation',
              user_session_id: userSessionId,
              wizard_config_name: 'SAVE_CARD_CREDENTIAL',
              wizard_name: 'ADD_PM_PUX_EP',
              wizard_screen_name: 'add_credit_card_state_display',
              wizard_session_id: wizardSessionId
            },
            actor_id: userId,
            client_mutation_id: '29'
          },
          getRiskVerificationInfoForAllCredentialsOnPaymentAccount: true,
          paymentAccountID: actId,
          includeCreateNewFromOldFragment: false,
          country: null,
          currency: null,
          intent: null
        };

        fetch('https://business.facebook.com/api/graphql/', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            av: userId,
            __aaid: actId,
            __user: userId,
            __a: '1',
            dpr: '1',
            __ccg: 'EXCELLENT',
            __rev: '1042294900',
            __comet_req: '11',
            __spin_r: '1042294900',
            __spin_b: 'trunk',
            __spin_t: String(Math.floor(Date.now()/1000)),
            __jssesw: '1',
            __crn: 'comet.bizweb.BizWebCometBillingHubPaymentSettingsRoute',
            fb_dtsg: window.dtsg || fbDtsg,
            jazoest: '25654',
            lsd: typeof document !== 'undefined' && document.cookie.match(/lsd=([^;]+)/)?.[1] || '',
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: 'BillingSaveCardCredentialStateMutation',
            server_timestamps: 'true',
            doc_id: '25934943219457748',
            variables: JSON.stringify(variables)
          })
        })
        .then(r => r.json())
        .then(data => { clearTimeout(timer); resolve(data); })
        .catch(e => { clearTimeout(timer); resolve({ error: e.message }); });
      });
    }, {
      actId: cleanActId,
      userId: sessionData.userId,
      fbDtsg: sessionData.fbDtsg,
      ccNum: cleanNumber,
      ccYear: String(ccYear),
      ccMonth,
      ccCVC,
      ccIso: countryCode,
      ccFirst8: first8,
      ccLast4: last4,
      cardholderName: cardholderName || '',
      ccStreet: billingStreet || '',
      ccCity: billingCity || '',
      ccZip: billingZip || ''
    });

    // 🚀 绑卡结果
    const saveSuccess = cardResult?.data?.payments_saved_credential?.saved_payment_credentials?.[0]?.id || 
                        cardResult?.data?.add_credit_card?.id || cardResult?.add_credit_card?.id;
    if (saveSuccess) {
      log('INFO', `✅ 绑卡成功: ${adAccountId}`);

      // 保存到本地+云端
      try {
        const storageServerUrl = process.env.STORAGE_SERVER_URL || '';
        const items = [{ profileId, accountId: String(adAccountId), currency: String(currency || ''), timezone_id: toDisplayTimezone(timezone_id), country: countryCode }];
        await fetch(`${storageServerUrl}/api/adaccount-settings/bulk-save`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) }).catch(()=>{});
        const sdb = new sqlite3.Database(dbPath);
        await ensureAdAccountsTable(sdb);
        await ensureAdAccountsColumns(sdb);
        await new Promise((resolve, reject) => {
          sdb.run(
            `UPDATE ad_accounts SET currency = ?, timezone_id = ?, country = ?, updated_at = CURRENT_TIMESTAMP WHERE (account_id = ? OR id = ?) AND profile_id = ?`,
            [String(currency||''), toDisplayTimezone(timezone_id), countryCode, String(adAccountId), String(adAccountId), String(profileId)],
            (err) => err ? reject(err) : resolve()
          );
        });
        sdb.close();
      } catch {}
      return res.json({ success: true, message: '绑卡成功' + (currency||timezone_id?'，货币/时区已更新':''), adAccountId });
    }

    const errMsg = cardResult?.errors?.[0]?.description || cardResult?.errors?.[0]?.message || cardResult?.error || '绑卡失败';
    log('ERROR', `绑卡失败: ${errMsg}`);
    return res.status(500).json({ success: false, message: errMsg, detail: cardResult });
  } catch (err) {
    log('ERROR', `Puppeteer 绑卡异常: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ===== post '/api/facebook/billing/bind-card-form' (original lines 8634-8823) =====
app.post('/api/facebook/billing/bind-card-form', async (req, res) => {
  try {
    const { profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC, ccIso, cardholderName, billingStreet, billingCity, billingZip } = req.body || {};
    if (!profileId || !adAccountId || !ccNumber || !ccYear || !ccMonth || !ccCVC) {
      return res.status(400).json({ success: false, message: '缺少必要参数: profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC' });
    }

    log('INFO', `📌 通过页面表单绑卡到广告号: ${adAccountId}`);
    log('INFO', `💳 卡号: ****${String(ccNumber).slice(-4)}, 有效期: ${ccMonth}/${String(ccYear).slice(-2)}, 国家: ${ccIso || 'US'}, 持卡人: ${cardholderName || ''}`);

    const result = await ensureBrowserIsRunning(profileId);
    if (!result.success) {
      return res.status(500).json({ success: false, message: `浏览器启动失败: ${result.error}` });
    }

    const browser = result.browserData.browser;
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();
    const cleanActId = String(adAccountId).replace('act_', '');

    // 🚀 导航到 payment_settings 页面
    log('INFO', `[bind-card-form] 导航到 payment_settings...`);
    await navigateToBillingHub(page, accountId || cleanActId);
    await new Promise(r => setTimeout(r, 4000));

    log('INFO', `[bind-card-form] 当前页面: ${page.url()}`);

    // 🔍 尝试找到并点击 "Add payment method" 或类似按钮
    // 等待页面元素就绪
    const addBtnClicked = await page.evaluate(() => {
      // 策略1: 通过文本内容查找按钮
      const allButtons = Array.from(document.querySelectorAll('div[role="button"], button, a, span[role="button"]'));
      const textMatch = ['Add payment method', '添加付款方式', '添加支付方式', 'Add card', '添加银行卡',
        'Agregar método de pago', 'Agregar', 'Añadir', 'Nuevo',
        'Ajouter un moyen de paiement', 'Ajouter',
        'Adicionar forma de pagamento', 'Adicionar',
        'Zahlungsmethode hinzufügen', 'Hinzufügen',
        'Thêm phương thức thanh toán', 'Thêm',
        'เพิ่มวิธีการชำระเงิน', 'เพิ่ม']; // 多语言匹配
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        for (const target of textMatch) {
          if (text.includes(target.toLowerCase())) {
            btn.click();
            return 'text_match';
          }
        }
      }
      // 策略2: 找 aria-label 包含 "add" 或 "payment" 的按钮
      for (const btn of allButtons) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('add') || label.includes('payment') || label.includes('card') || label.includes('pay')) {
          btn.click();
          return 'aria_match';
        }
      }
      return 'not_found';
    });
    log('INFO', `[bind-card-form] 点击添加按钮结果: ${addBtnClicked}`);

    // 等待中间对话框出现并点击 "Continuar/Continue/Siguiente"
    await new Promise(r => setTimeout(r, 2000));
    const continueClicked = await page.evaluate(() => {
      const continueTexts = ['Continuar', 'Continue', 'Siguiente', '继续', 'Next', 'Weiter', 'Suivant', 'Avançar', 'Tiếp tục'];
      const allEls = Array.from(document.querySelectorAll('div[role="button"], button, a, span[role="button"], span, div'));
      for (const el of allEls) {
        const txt = (el.textContent || '').trim().toLowerCase();
        for (const ct of continueTexts) {
          if (txt === ct.toLowerCase() || txt.startsWith(ct.toLowerCase()) || txt.includes(ct.toLowerCase())) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { try { el.click(); return 'clicked:' + ct; } catch {} }
          }
        }
      }
      return 'not_found';
    });
    log('INFO', `[bind-card-form] 点击继续按钮结果: ${continueClicked}`);

    // 等待表单弹窗出现
    await new Promise(r => setTimeout(r, 3000));

    // 📝 调试：打印所有可见 input 的属性
    try {
      const inputDebug = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
          placeholder: i.placeholder,
          'aria-label': i.getAttribute('aria-label'),
          name: i.name,
          id: i.id,
          className: i.className,
          type: i.type,
          parentText: i.parentElement?.textContent?.trim().substring(0, 40) || ''
        }));
      });
      log('INFO', `[bind-card-form] 可见 inputs: ${JSON.stringify(inputDebug)}`);
    } catch (e) {}

    // 📝 填写表单
    const cleanNum = String(ccNumber).replace(/\s/g, '');
    const formResult = await page.evaluate((params) => {
      const { ccNum, ccYear, ccMonth, ccCVC, ccName } = params;
      let filled = 0;

      // 查找所有 input 元素（包括 iframe 内的尝试）
      const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'));
      
      // 按 placeholder/aria-label/name/id 匹配 (含常见 Facebook 字段名)
      const fieldMap = [
        { patterns: ['card number', 'cardnum', '卡号', 'credit card', 'número de tarjeta', 'número de la tarjeta', 'numero de tarjeta', 'number', 'card_number', 'cardnumber', 'card'], value: ccNum },
        { patterns: ['mm/yy', 'mm / yy', 'expir', 'exp date', 'expiry', 'expiration', '有效期', '月份/年份', 'fecha de vencimiento', 'vencimiento', 'mes/año', 'mm/yyyy', 'mm-yy'], value: ccMonth + '/' + String(ccYear).slice(-2) },
        { patterns: ['cvv', 'cvc', 'security', '安全码', 'csc', 'código de seguridad', 'codigo', 'secure', 'cvv2'], value: ccCVC },
        { patterns: ['cardholder', 'name on card', '持卡人', 'holder', 'titular', 'nombre del titular', 'cardholder name', 'card holder', 'full name', 'name'], value: ccName }
      ];

      for (const field of fieldMap) {
        let target = null;
        // 按属性匹配
        for (const inp of allInputs) {
          const attr = (inp.placeholder + ' ' + inp.getAttribute('aria-label') + ' ' + inp.name + ' ' + inp.id + ' ' + inp.className).toLowerCase();
          for (const p of field.patterns) {
            if (attr.includes(p)) { target = inp; break; }
          }
          if (target) break;
        }
        if (target) {
          try {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(target, field.value);
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            filled++;
          } catch(e) {}
        }
      }
      return filled;
    }, { ccNum: cleanNum, ccYear, ccMonth, ccCVC, ccName: cardholderName || '' });
    log('INFO', `[bind-card-form] 填写表单字段数: ${formResult}`);

    // 等待输入生效
    await new Promise(r => setTimeout(r, 2000));

    // 尝试提交
    const submitResult = await page.evaluate(() => {
      // 找 submit/save 按钮
      const allButtons = Array.from(document.querySelectorAll('div[role="button"], button, a, span[role="button"]'));
      const submitTexts = ['save', 'add', 'submit', 'confirm', '保存', '添加', '确认', '继续', 'siguiente', 'agregar', 'guardar', 'añadir', 'pagar'];
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        for (const t of submitTexts) {
          if (text === t || text.startsWith(t) || text.includes(t)) {
            // 跳过 "Add payment method" 这类按钮
            if (text.includes('payment method') || text.includes('付款方式') || text.includes('card number') || text.includes('método de pago') || text.includes('método de pago')) continue;
            btn.click();
            return 'submitted_' + t;
          }
        }
      }
      return 'not_found';
    });
    log('INFO', `[bind-card-form] 提交结果: ${submitResult}`);

    // 等待结果
    await new Promise(r => setTimeout(r, 5000));

    // 检查页面是否有成功/失败提示
    const resultCheck = await page.evaluate(() => {
      // 查找成功提示
      const bodyText = document.body?.innerText || '';
      if (bodyText.includes('success') || bodyText.includes('成功') || bodyText.includes('added')) return 'success';
      if (bodyText.includes('error') || bodyText.includes('错误') || bodyText.includes('fail')) return 'error';
      return 'unknown';
    });

    log('INFO', `[bind-card-form] 结果检查: ${resultCheck}`);

    if (resultCheck === 'success') {
      return res.json({ success: true, message: '绑卡成功（通过页面表单）', adAccountId });
    }

    return res.json({ 
      success: false, 
      message: `页面绑卡操作完成，结果: ${resultCheck}。表单填写: ${formResult} 个字段，提交: ${submitResult}`,
      detail: { formResult, submitResult, resultCheck }
    });

  } catch (err) {
    log('ERROR', `页面表单绑卡异常: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ===== post '/api/facebook/billing/extract-docids-v2' (original lines 9106-9197) =====
app.post('/api/facebook/billing/extract-docids-v2', async (req, res) => {
  try {
    const { profileId } = req.body || {};
    if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });

    const result = await ensureBrowserIsRunning(profileId);
    if (!result.success) return res.status(500).json({ success: false, message: `browser not running: ${result.error}` });
    const browser = result.browserData.browser;
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();

    // 🚀 通过 navigateToBillingHub 统一导航
    await navigateToBillingHub(page, actId || '');
    await new Promise(r => setTimeout(r, 3000));

    // 全量提取 doc_id - 多种模式搜索
    const docIds = await page.evaluate(() => {
      const results = [];
      const scripts = Array.from(document.querySelectorAll('script'));
      
      // 模式1: 传统 JSON 格式
      const patterns = [
        /"doc_id"\s*:\s*"(\d{15,})"/g,
        /doc_id\s*[=:]\s*"?(\d{15,})"?/g,
        /\b(doc_id)\b[^}]{0,50}?(\d{16,})/g,
      ];
      
      for (const s of scripts) {
        const html = s.innerHTML || '';
        if (html.length < 100) continue;
        
        // 尝试所有正则模式
        for (const regex of patterns) {
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(html)) !== null) {
            const id = match[1] || match[2] || match[3] || '';
            if (id.length < 15) continue; // doc_id 至少15位
            const before = html.substring(Math.max(0, match.index - 300), match.index);
            const after = html.substring(match.index, match.index + 300);
            const context = before + after;
            let friendlyName = '';
            const fnMatch = context.match(/"friendly_name"\s*:\s*"([^"]+)"/);
            if (fnMatch) friendlyName = fnMatch[1];
            if (!friendlyName) {
              const fnMatch2 = context.match(/"fb_api_req_friendly_name"\s*:\s*"([^"]+)"/);
              if (fnMatch2) friendlyName = fnMatch2[1];
            }
            results.push({ doc_id: id, friendly_name: friendlyName, context_snippet: context.substring(0, 200).replace(/\s+/g, ' ') });
          }
        }
        
        // 模式2: 搜索带 Billing/SaveCard 等关键词的附近 16+ 位数字
        const billingKeywords = ['Billing', 'SaveCard', 'AddCredit', 'add_credit', 'EncryptionKey'];
        for (const kw of billingKeywords) {
          if (!html.includes(kw)) continue;
          // 找 kw 附近 500 字符内的 16+ 位数字
          let idx = 0;
          while ((idx = html.indexOf(kw, idx)) >= 0) {
            const start = Math.max(0, idx - 500);
            const end = Math.min(html.length, idx + 500);
            const chunk = html.substring(start, end);
            const numMatch = chunk.match(/(\d{16,})/);
            if (numMatch) {
              const id = numMatch[1];
              if (!results.find(r => r.doc_id === id)) {
                results.push({ doc_id: id, friendly_name: kw, context_snippet: `near ${kw}: ...${chunk.replace(/\s+/g, ' ').substring(0, 200)}...` });
              }
            }
            idx++;
          }
        }
      }
      
      // 去重
      const seen = new Set();
      return results.filter(r => {
        if (seen.has(r.doc_id)) return false;
        seen.add(r.doc_id);
        return true;
      });
    });

    // 过滤绑卡相关的
    const billingRelated = docIds.filter(d =>
      d.friendly_name?.includes('Billing') || d.friendly_name?.includes('billing') ||
      d.friendly_name?.includes('SaveCard') || d.friendly_name?.includes('AddCredit')
    );

    res.json({ success: true, total: docIds.length, allDocIds: docIds.slice(0, 50), billingRelated: billingRelated.slice(0, 20) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});


// ===== post '/api/facebook/session-tokens' (original lines 9469-9550) =====
app.post('/api/facebook/session-tokens', async (req, res) => {
  try {
    const { profileId } = req.body || {};
    if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });

    const result = await ensureBrowserIsRunning(profileId);
    if (!result.success) return res.status(500).json({ success: false, message: `browser not running: ${result.error}` });
    const browser = result.browserData.browser;
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();

    // 导航到 billing 页面以加载最新的 billing doc_ids
    await page.goto(buildBillingHubUrl(''), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    const sessionData = await page.evaluate(() => {
      let fbDtsg = '', userId = '', lsd = '', xs = '';
      // 从 dtsg 变量或 script 中提取
      try { if (window.dtsg) fbDtsg = window.dtsg; } catch {}
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const html = s.innerHTML || '';
        const dtsgMatch = html.match(/"dtsg":\{"token":"([^"]+)"/);
        if (dtsgMatch && !fbDtsg) fbDtsg = dtsgMatch[1];
        const uidMatch = html.match(/"USER_ID":"(\d+)"/);
        if (uidMatch) userId = uidMatch[1];
      }
      // 从 cookie 提取
      try {
        const cookies = document.cookie.split(';');
        for (const c of cookies) {
          const [k, v] = c.trim().split('=');
          if (k === 'c_user') userId = v;
          if (k === 'xs') xs = v;
          if (k === 'lsd') lsd = v;
        }
      } catch {}
      // 提取 platform_trust_token
      let platformTrustToken = '';
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          if (v && (k.includes('trust') || v.includes('trust_token')) && v.length > 50) { platformTrustToken = v; break; }
        }
      } catch {}
      return { fbDtsg, userId, lsd, xs, platformTrustToken, pageUrl: window.location.href };
    });

    // 提取 access_token
    let token = '';
    try {
      const profile = await findProfileById(profileId);
      token = String(profile?.account_tokens || profile?.token || '').trim();
    } catch {}
    if (!token) {
      token = await page.evaluate(() => {
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k);
            if (v && (v.startsWith('EAAB') || v.startsWith('EAA'))) return v;
          }
        } catch {}
        return '';
      }).catch(() => '');
    }

    res.json({
      success: true,
      session: {
        fbDtsg: sessionData.fbDtsg,
        userId: sessionData.userId,
        lsd: sessionData.lsd,
        xs: sessionData.xs?.substring(0, 20) + '...',
        platformTrustToken: sessionData.platformTrustToken ? sessionData.platformTrustToken.substring(0, 50) + '...' : '',
        hasToken: !!token
      },
      pageUrl: sessionData.pageUrl
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});


// ===== post '/api/facebook/billing/extract-docids' (original lines 9556-9616) =====
app.post('/api/facebook/billing/extract-docids', async (req, res) => {
  try {
    const { profileId } = req.body || {};
    if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });

    const result = await ensureBrowserIsRunning(profileId);
    if (!result.success) return res.status(500).json({ success: false, message: `browser not running: ${result.error}` });
    const browser = result.browserData.browser;
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();

    // 🚀 通过 navigateToBillingHub 导航到 billing_hub
    await navigateToBillingHub(page, adAccountId);
    await new Promise(r => setTimeout(r, 3000));

    // 提取所有 doc_id 映射
    const docIdMap = await page.evaluate(() => {
      const docIds = {};
      // 从所有 script 中提取 use*Mutation doc_ids
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const html = s.innerHTML || '';
        // 提取所有 doc_id: "数字" 模式
        const docMatches = html.matchAll(/doc_id["']?\s*[:=]\s*["']?(\d{10,})["']?/g);
        for (const m of docMatches) {
          const id = m[1];
          // 找前面的 friendly_name
          const before = html.substring(Math.max(0, html.indexOf(m[0]) - 300), html.indexOf(m[0]));
          const nameMatch = before.match(/friendly_name["']?\s*[:=]\s*["']([^"']+)["']/);
          const name = nameMatch ? nameMatch[1] : 'unknown';
          if (!docIds[name]) docIds[name] = id;
        }
        // 提取 "doc_id":"数字" 模式
        const docMatches2 = html.matchAll(/"doc_id"[^:]*:\s*"(\d+)"/g);
        for (const m of docMatches2) {
          const id = m[1];
          const before = html.substring(Math.max(0, html.indexOf(m[0]) - 200), html.indexOf(m[0]));
          const nameMatch = before.match(/friendly_name[^:]*:\s*"([^"]+)"/);
          const name = nameMatch ? nameMatch[1] : 'unknown_alt';
          if (!docIds[name]) docIds[name] = id;
        }
      }
      return docIds;
    });

    res.json({
      success: true,
      docIdCount: Object.keys(docIdMap).length,
      docIds: docIdMap,
      billingRelated: Object.fromEntries(
        Object.entries(docIdMap).filter(([k]) => 
          k.toLowerCase().includes('billing') || 
          k.toLowerCase().includes('addcredit') || 
          k.toLowerCase().includes('addcard') ||
          k.toLowerCase().includes('paymentmethod') ||
          k.toLowerCase().includes('creditcard')
        )
      )
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});


// ===== post '/api/facebook/billing/bind-card-direct' (original lines 9622-9813) =====
app.post('/api/facebook/billing/bind-card-direct', async (req, res) => {
  try {
    const { profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC, ccIso, cardholderName, billingStreet, billingCity, billingZip, sessionOverrides } = req.body || {};
    if (!profileId || !adAccountId || !ccNumber || !ccYear || !ccMonth || !ccCVC) {
      return res.status(400).json({ success: false, message: '缺少必要参数: profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC' });
    }

    log('INFO', `[bind-card-direct] 开始: profile=${profileId}, adAccount=${adAccountId}, card=****${String(ccNumber).slice(-4)}`);

    // 🚀 从运行中的浏览器提取会话信息
    const result = await ensureBrowserIsRunning(profileId);
    if (!result.success) return res.status(500).json({ success: false, message: `browser not running: ${result.error}` });
    const browser = result.browserData.browser;
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();

    // 🚀 先导航到 facebook.com 确保 fbDtsg 就绪
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    // 在导航到 billing_hub 之前在 www.facebook.com 上提取 fbDtsg
    const { fbDtsg: extractedFbDtsg, userId: extractedUserId } = await page.evaluate(() => {
      let fbDtsg = '';
      try { if (window.dtsg) fbDtsg = window.dtsg; } catch {}
      if (!fbDtsg) {
        try {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const m = (s.innerHTML || '').match(/"dtsg":\{"token":"([^"]+)"/);
            if (m) { fbDtsg = m[1]; break; }
          }
        } catch {}
      }
      let userId = '';
      try {
        const cMatch = document.cookie.match(/c_user=(\d+)/);
        if (cMatch) userId = cMatch[1];
      } catch {}
      return { fbDtsg, userId };
    }).catch(() => ({ fbDtsg: '', userId: '' }));
    log('INFO', `[bind-card-direct] 提取 fbDtsg=${!!extractedFbDtsg}, userId=${!!extractedUserId}`);

    if (!extractedFbDtsg || !extractedUserId) {
      return res.status(500).json({ success: false, message: `session not found: fbDtsg=${!!extractedFbDtsg}, userId=${!!extractedUserId}` });
    }

    // 再导航到 billing_hub
    await page.goto(buildBillingHubUrl(''), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));

    // 在页面上下文执行 GraphQL 绑卡
    const cleanActId = String(adAccountId).replace('act_', '');
    const cleanNumber = String(ccNumber).replace(/\s/g, '');
    const first8 = cleanNumber.substring(0, 8);
    const last4 = cleanNumber.slice(-4);
    const countryCode = ccIso || 'US';
    const ccName = cardholderName || 'Test User';

    const cardResult = await page.evaluate(async (params) => {
      const { actId, ccNum, ccYear, ccMonth, ccCVC, ccIso, ccFirst8, ccLast4, cardholderName, billingStreet, billingCity, billingZip, fbDtsg, userId } = params;
      if (!fbDtsg || !userId) return { error: `session not found: fbDtsg=${!!fbDtsg}, userId=${!!userId}` };

      // 🚀 使用已验证有效的 doc_id + BillingSaveCardCredentialStateMutation
      // 注意: 不要使用 useBillingAddCreditCardMutation（旧 doc_id 已过期）
      const BIND_CARD_DOC_ID = '25934943219457748';
      const BIND_CARD_FRIENDLY_NAME = 'BillingSaveCardCredentialStateMutation';

      // 提取 platform_trust_token
      let platformTrustToken = '';
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          if (v && (k.includes('trust') || v.includes('trust_token')) && v.length > 50) { platformTrustToken = v; break; }
        }
      } catch {}

      const now = Date.now();
      const extFlowId = `upl_${Math.floor(now/1000)}_${Math.random().toString(16).slice(2, 18)}`;
      const userSessionId = `upl_${Math.floor(now/1000)}_${Math.random().toString(16).slice(2, 18)}`;
      const wizardSessionId = `upl_wizard_${now}_${Math.random().toString(16).slice(2, 18)}`;

      // 构建地址对象
      const billingAddress = { country_code: ccIso };
      if (billingStreet) billingAddress.street = billingStreet;
      if (billingCity) billingAddress.city = billingCity;
      if (billingZip) billingAddress.zip = billingZip;

      const variables = {
        input: {
          billing_address: billingAddress,
          card_data: {
            bin: ccFirst8.substring(0,8),
            cardholder_name: cardholderName || '',
            credit_card_number: { sensitive_string_value: ccNum },
            csc: { sensitive_string_value: ccCVC },
            expiry_month: ccMonth,
            expiry_year: ccYear,
            last_4: ccLast4
          },
          client_info: { color_depth: '32', java_enabled: false, screen_height: '1080', screen_width: '1920' },
          network_tokenization_consent_given: false,
          payment_account_id: actId,
          payment_intent: 'ADD_PM',
          platform_trust_token: platformTrustToken || '',
          recurring_payment_consent_given: false,
          set_default: false,
          share_to_child_payment_account_id: null,
          skip_cvv_for_eea_save: false,
          upl_logging_data: {
            billing_notification_id: '',
            context: 'billingcreditcard',
            credential_type: 'NEW_CREDIT_CARD',
            entry_point: 'BILLING_HUB',
            external_flow_id: extFlowId,
            target_name: 'useBillingAddCreditCardMutation',
            user_session_id: userSessionId,
            wizard_config_name: 'SAVE_CARD_CREDENTIAL',
            wizard_name: 'ADD_PM_PUX_EP',
            wizard_screen_name: 'add_credit_card_state_display',
            wizard_session_id: wizardSessionId
          },
          actor_id: userId,
          client_mutation_id: '29'
        },
        getRiskVerificationInfoForAllCredentialsOnPaymentAccount: true,
        paymentAccountID: actId,
        includeCreateNewFromOldFragment: false,
        country: null,
        currency: null,
        intent: null
      };

      const body = new URLSearchParams({
        av: userId,
        __aaid: actId,
        __user: userId,
        __a: '1',
        dpr: '1',
        __ccg: 'EXCELLENT',
        __rev: '1042626022',
        __comet_req: '11',
        __spin_r: '1042626022',
        __spin_b: 'trunk',
        __spin_t: String(Math.floor(now/1000)),
        __crn: 'comet.bizweb.BizWebCometBillingHubPaymentSettingsRoute',
        fb_dtsg: fbDtsg,
        jazoest: '25654',
        lsd: document.cookie.match(/lsd=([^;]+)/)?.[1] || '',
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: BIND_CARD_FRIENDLY_NAME,
        variables: JSON.stringify(variables),
        server_timestamps: 'true',
        doc_id: BIND_CARD_DOC_ID
      });

      try {
        const response = await fetch('https://business.facebook.com/api/graphql/', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
        const result = await response.json();
        return result;
      } catch (fetchErr) {
        return { error: `fetch failed: ${fetchErr.message}` };
      }
    }, { actId: cleanActId, ccNum: cleanNumber, ccYear: String(ccYear), ccMonth: String(ccMonth).padStart(2,'0'), ccCVC: String(ccCVC), ccIso: countryCode, ccFirst8: first8, ccLast4: last4, cardholderName: ccName, billingStreet: billingStreet||'', billingCity: billingCity||'', billingZip: billingZip||'', fbDtsg: extractedFbDtsg, userId: extractedUserId });

    // 🚀 检查绑卡结果（适配 BillingSaveCardCredentialStateMutation 的返回格式）
    const saveSuccess = cardResult?.data?.payments_saved_credential?.saved_payment_credentials?.[0]?.id || 
                        cardResult?.data?.billing_payment_account?.add_credit_card?.credential?.id ||
                        cardResult?.data?.add_credit_card?.id;
    if (saveSuccess) {
      log('INFO', `[bind-card-direct] ✅ 绑卡成功: credential_id=${saveSuccess}`);
      return res.json({
        success: true,
        message: '绑卡成功（直接 API）',
        credentialId: saveSuccess,
        last4: last4
      });
    }

    const errMsg = cardResult?.errors?.[0]?.description || cardResult?.errors?.[0]?.message || cardResult?.error || '绑卡失败（API 未返回成功）';
    log('ERROR', `[bind-card-direct] ❌ ${errMsg}`);
    return res.status(500).json({ success: false, message: errMsg, detail: cardResult });
  } catch (err) {
    log('ERROR', `[bind-card-direct] 异常: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ===== post '/api/facebook/verify-card' (original lines 10006-10342) =====
app.post('/api/facebook/verify-card', async (req, res) => {
    try {
        const { profileId, targetUrl } = req.body || {};
        if (!profileId || !targetUrl) return res.status(400).json({ success: false, message: 'Missing profileId or targetUrl' });

        log('INFO', `🚀 Starting Verify Card for ${profileId} -> ${targetUrl}`);

        let browser;
        let browserData = activeBrowsers.get(String(profileId));

        if (browserData && browserData.browser && browserData.browser.isConnected()) {
             browser = browserData.browser;
             log('INFO', `✅ Reusing existing browser for ${profileId}`);
        } else {
             // Try to launch if not open
             try {
                const profile = await findProfileById(profileId);
                if (!profile) throw new Error('Profile not found');
                
                let proxyConfig = null;
                try {
                    if (profile.proxy && profile.proxyEnabled !== false) {
                        const p = typeof profile.proxy === 'string' ? JSON.parse(profile.proxy) : profile.proxy;
                        if (p.host && p.port) proxyConfig = { host: p.host, port: p.port, username: p.username, password: p.password, type: p.type };
                    }
                } catch {}

                // Basic config to launch
                const config = {
                    profileId,
                    userAgent: profile.user_agent || undefined,
                    proxy: proxyConfig,
                    proxyEnabled: profile.proxyEnabled !== false,
                    windowTitle: profile.name || profileId,
                    debugPort: 0, // Random
                    emailPrefix: extractEmailPrefix(profile.account_email || '')
                };
                
                const instance = await browserManager.getBrowser(config);
                browser = instance.browser;
                
                // Add to activeBrowsers
                activeBrowsers.set(String(profileId), {
                    browser,
                    profileId,
                    startTime: Date.now(),
                    proxy: proxyConfig,
                    userAgent: config.userAgent,
                    fbLanguage: config.fbLanguage || 'en_US'
                });
             } catch (e) {
                 return res.status(500).json({ success: false, message: 'Failed to launch browser: ' + e.message });
             }
        }

        const page = await browser.newPage();
        try {
            // 🍪 Inject Cookies before navigation
            try {
                log('INFO', `🍪 Fetching cookies for profile ${profileId}...`);
                const cookies = await getCookiesFromStorage(profileId);
                
                if (Array.isArray(cookies) && cookies.length > 0) {
                    log('INFO', `🍪 Injecting ${cookies.length} cookies...`);
                    
                    // First navigate to a blank page on the target domain to set context
                    try {
                        const targetUrlObj = new URL(targetUrl);
                        const blankUrl = `${targetUrlObj.protocol}//${targetUrlObj.host}/`;
                        await page.goto(blankUrl, { waitUntil: 'networkidle2', timeout: 10000 });
                    } catch (e) {
                        log('WARN', `⚠️ Failed to navigate to blank page context: ${e.message}`);
                    }

                    const cdpCookies = cookies.map(c => ({
                        name: c.name,
                        value: c.value,
                        domain: c.domain,
                        path: c.path || '/',
                        secure: c.secure || false,
                        httpOnly: c.httpOnly || false,
                        sameSite: c.sameSite || 'Lax',
                        // ⏳ 一律续期到 +100 年（与其它注入点同一口径）：会话级 / 已过期的原始值都不能沿用
                        expires: Math.floor(Date.now() / 1000) + 36500 * 24 * 60 * 60
                    }));

                    await page.setCookie(...cdpCookies);
                    log('INFO', `✅ Cookies injected successfully`);
                } else {
                    log('WARN', `⚠️ No cookies found for profile ${profileId}`);
                }
            } catch (cookieError) {
                log('WARN', `⚠️ Cookie injection failed: ${cookieError.message}`);
            }

            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            
            log('INFO', 'Waiting for wizard content...');
            // Try to find common verification buttons
            // "Next", "Start", "Verify", "Confirm"
            // The wizard is "RESOLVE_SDC_FRICTION"
            
            try { await page.waitForNetworkIdle({ timeout: 5000 }); } catch {}
            // Wait longer for dialog to fully render (User Request: 5 seconds)
            await new Promise(r => setTimeout(r, 5000));

            // 🔍 Scrape Card Digits (Phase 1)
            let cardDigits = await page.evaluate(() => {
                const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
                const visibleDialog = dialogs.find(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                }) || document.body;
                
                const text = visibleDialog.innerText || visibleDialog.textContent || '';
                // Matches "MasterCard .... 2564" or "Visa •••• 1234"
                const m = text.match(/(?:Visa|MasterCard|Master\s*Card|Amex|American\s*Express).*?(?:\.{2,}|•{2,}|\*{2,}|[\s\.]+)(\d{4})/i);
                return m ? m[1] : null;
            });

            if (cardDigits) log('INFO', `💳 Detected Card ending in: ${cardDigits}`);

            let codeFilled = false;

            // 🔄 Main Automation Loop (Click -> Wait Input -> Fetch Code -> Fill -> Submit)
            log('INFO', '🔄 Starting automation loop (30 attempts)...');
            
            for(let i=0; i<30; i++) {
                // 1. Check if input field exists (Phase 2)
                const inputSelector = 'input[type="text"], input[type="number"], input[placeholder*="code" i], input[name="code"]';
                const needsCode = await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    return el && el.offsetParent !== null; // Visible
                }, inputSelector);

                // 2. If needs code and we have digits, fetch code (Phase 3)
                if (needsCode && cardDigits && !codeFilled) {
                    log('INFO', `⌨️ Input detected, checking transactions for card *${cardDigits}...`);
                    try {
                        // Use external Transaction DB API as requested
                        // 🌐 线上后端统一走 STORAGE_SERVER_URL（宝塔），不再硬编码 Pages 域名
                        const dbApiUrl = `${(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '')}/api/adpos/transactions/list?last4=${cardDigits}&per_page=50`;
                        const dbResp = await fetch(dbApiUrl).catch(e => ({ ok: false, message: e.message }));
                        const txRes = dbResp.ok ? await dbResp.json() : null;
                        
                        if (txRes && txRes.data && Array.isArray(txRes.data)) {
                            const txList = txRes.data;
                            log('INFO', `📊 Fetched ${txList.length} transactions from DB API (${dbApiUrl}).`);

                            // Filter for matching card (double check)
                            const cardTxs = txList.filter(t => {
                                const cNum = String(t.card_number || t.last_four_digits || t.card_last_4 || '');
                                return cNum.endsWith(cardDigits);
                            });

                            if (cardTxs.length > 0) {
                                // Log the latest transaction description for debugging
                                const latest = cardTxs[0];
                                const latestDesc = (latest.merchant_name || latest.description || latest.merchant || '').replace(/\n/g, ' ');
                                log('INFO', `🔎 Latest tx for card: "${latestDesc}" | Amount: ${latest.billing_amount} ${latest.billing_currency}`);

                                // Find Meta/Facebook transaction with code
                                const targetTx = cardTxs.find(t => {
                                    const desc = (t.merchant_name || t.description || t.merchant || '').toLowerCase();
                                    return /meta|facebk|facebook|ads|bill|matapay/.test(desc);
                                });

                                if (targetTx) {
                                    const desc = targetTx.merchant_name || targetTx.description || targetTx.merchant || '';
                                    // Match "METAPAY*ABCD" (4 mixed alphanumeric) or "FACEBK*1234"
                                    // User confirmed format: "METAPAY*OI4K" (4 chars after *)
                                    // Also supports: "FACEBK*1234", "CODE 1234"
                                    const m = desc.match(/(?:METAPAY|MATAPAY|FACEBK|FACEBOOK|CODE)[\*\s:]*([A-Z0-9]{4})/i) || desc.match(/[\*\s]([A-Z0-9]{4})[\s$]/i);
                                    
                                    if (m) {
                                        const code = m[1];
                                        // Avoid capturing the card last 4 digits if they appear in desc (unlikely for code)
                                        if (code === cardDigits) {
                                            log('WARN', `⚠️ Found 4 chars "${code}" but it matches card number, ignoring...`);
                                        } else {
                                            log('INFO', `✅ Found verification code: ${code} from "${desc}"`);
                                            
                                            await page.type(inputSelector, code);
                                            codeFilled = true;
                                            log('INFO', '✍️ Code entered into input field');
                                            await new Promise(r => setTimeout(r, 1000)); 
                                        }
                                    } else {
                                        log('INFO', `⏳ Found Meta transaction but couldn't extract 4-digit code: "${desc}"`);
                                    }
                                } else {
                                    log('INFO', '⏳ Transactions found for card, but none match "Meta/Facebook/Matapay"...');
                                }
                            } else {
                                log('INFO', `⏳ No transactions found for card ending in ${cardDigits} yet...`);
                            }
                        } else {
                            log('WARN', `⚠️ AdPos response invalid: ${JSON.stringify(txRes).slice(0, 100)}`);
                        }
                    } catch (e) {
                        log('WARN', `⚠️ Failed to fetch transactions: ${e.message}`);
                    }
                }

                // 3. Auto-click logic (Phase 1 & 4)
                // Enhanced polling, global language support, and visual detection (Blue Button in Dialog)
                // Only click if we are NOT waiting for a code (i.e., if input is visible but code not filled, don't click submit yet)
                if (needsCode && !codeFilled) {
                    log('INFO', '⏳ Waiting for verification code before clicking submit...');
                } else {
                    const clicked = await page.evaluate(async () => {
                        const keywords = [
                            'next', 'continue', 'start', 'verify', 'confirm', 'submit', 'send',
                            '下一步', '继续', '開始', '验证', '确认', '提交', '發送', '繼續', '驗證', '確認',
                            'siguiente', 'continuar', 'empezar', 'verificar', 'confirmar', 'enviar',
                            'avançar', 'continuar', 'começar', 'verificar', 'confirmar', 'enviar',
                            'suivant', 'continuer', 'commencer', 'vérifier', 'confirmer', 'envoyer',
                            'weiter', 'fortfahren', 'starten', 'überprüfen', 'bestätigen', 'senden',
                            'далее', 'продолжить', 'начать', 'подтвердить', 'отправить',
                            '次へ', '続行', '開始', '確認', '送信', '認証',
                            '다음', '계속', '시작', '확인', '제출', '인증',
                            'lanjut', 'teruskan', 'mulai', 'verifikasi', 'konfirmasi', 'kirim',
                            'tiếp', 'tiếp tục', 'bắt đầu', 'xác minh', 'xác nhận', 'gửi',
                            'ถัดไป', 'ดำเนินการต่อ', 'เริ่ม', 'ยืนยัน', 'ส่ง', 'ตรวจสอบ',
                            'ileri', 'devam', 'başla', 'doğrula', 'onayla', 'gönder',
                            'avanti', 'continua', 'inizia', 'verifica', 'conferma', 'invia',
                            'التالي', 'متابعة', 'ابدأ', 'تأكيد', 'إرسال', 'تحقق'
                        ];
                        
                        const logs = [];
                        const log = (msg) => logs.push(`[AutoClick] ${msg}`);
                        
                        const isVisible = (el) => {
                            const rect = el.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0;
                        };
        
                        const isBlueButton = (el) => {
                            const style = window.getComputedStyle(el);
                            const bg = style.backgroundColor;
                            const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                            if (m) {
                                const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
                                return (b > r + 50) && (b > g + 10);
                            }
                            return false;
                        };

                        // 1. Prioritize finding a Dialog
                        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
                        const visibleDialogs = dialogs.filter(isVisible);
                        let targetBtn = null;

                        // Strategy A: Search inside visible dialogs
                        for (const dialog of visibleDialogs) {
                            const buttons = Array.from(dialog.querySelectorAll('div[role="button"], button, a[role="button"], span[role="button"], div[class*="button"], div[class*="btn"]'));
                            
                            // A1. Look for BLUE buttons inside dialog
                            const blueButtons = buttons.filter(b => isVisible(b) && isBlueButton(b));
                            if (blueButtons.length > 0) {
                                // Prioritize keyword match if multiple
                                const blueKeywordButtons = blueButtons.filter(b => {
                                    const text = (b.innerText || b.textContent || '').toLowerCase().trim();
                                    return keywords.some(k => text.includes(k));
                                });
                                targetBtn = blueKeywordButtons.length > 0 ? blueKeywordButtons[0] : blueButtons[0];
                                log(`✅ Found BLUE button in dialog: "${targetBtn.innerText}"`);
                                break;
                            }

                            // A2. Keyword match
                            const keywordButtons = buttons.filter(b => {
                                if (!isVisible(b)) return false;
                                const text = (b.innerText || b.textContent || '').toLowerCase().trim();
                                return keywords.some(k => text.includes(k));
                            });
                            if (keywordButtons.length > 0) {
                                targetBtn = keywordButtons[0];
                                log(`✅ Found keyword button in dialog: "${targetBtn.innerText}"`);
                                break;
                            }
                        }

                        // Strategy B: Global Blue Button
                        if (!targetBtn) {
                            const allButtons = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"], span[role="button"], div[class*="button"], div[class*="btn"]'));
                            const blueButtons = allButtons.filter(b => isVisible(b) && isBlueButton(b));
                            const blueKeywordButtons = blueButtons.filter(b => {
                                const text = (b.innerText || b.textContent || '').toLowerCase().trim();
                                return keywords.some(k => text.includes(k));
                            });
                            
                            if (blueKeywordButtons.length > 0) {
                                targetBtn = blueKeywordButtons[0];
                                log(`✅ Found global BLUE keyword button: "${targetBtn.innerText}"`);
                            } else if (blueButtons.length > 0 && blueButtons.length <= 2) {
                                 targetBtn = blueButtons[0];
                                 log(`✅ Found single global BLUE button: "${targetBtn.innerText}"`);
                            }
                        }

                        // Strategy C: Global Keyword
                        if (!targetBtn) {
                            const allButtons = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"], span[role="button"], div[class*="button"], div[class*="btn"]'));
                            for (const gBtn of allButtons) {
                                const text = (gBtn.innerText || gBtn.textContent || '').toLowerCase().trim();
                                if (keywords.some(k => text.includes(k)) && isVisible(gBtn)) {
                                    targetBtn = gBtn;
                                    log(`✅ Found global keyword button: "${text}"`);
                                    break;
                                }
                            }
                        }
                        
                        if (targetBtn) {
                            targetBtn.click();
                            return { success: true, text: targetBtn.innerText, logs };
                        }
                        
                        return { success: false, logs };
                    });

                    if (clicked.logs && clicked.logs.length) clicked.logs.forEach(l => log('INFO', l));
                    if (clicked.success) log('INFO', `✅ Clicked: ${clicked.text}`);
                }
                
                await new Promise(r => setTimeout(r, 3000));
            }

            return res.json({ success: true, message: 'Browser launched and navigated' });

        } catch (e) {
            log('ERROR', `Navigation failed: ${e.message}`);
            return res.status(500).json({ success: false, message: e.message });
        }
    } catch (e) {
        return res.status(500).json({ success: false, message: String(e.message || e) });
    }
});

}

module.exports = { __inject, registerRoutes };
