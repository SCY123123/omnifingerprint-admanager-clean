'use strict';

const { URL } = require('url');

let _log = () => {};
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _browserManager = null;
let _activeBrowsers = new Map();
let _safePageEvaluate = null;
let _findProfileById = null;
let _extractFbToken = null;
let _autoFillPasswordOnPage = null;
let _callFacebookGraphApi = null;
let _PORT = 0;
let _API_SECRET = '';

function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.sleep) _sleep = deps.sleep;
  if (deps.browserManager) _browserManager = deps.browserManager;
  if (deps.activeBrowsers) _activeBrowsers = deps.activeBrowsers;
  if (deps.safePageEvaluate) _safePageEvaluate = deps.safePageEvaluate;
  if (deps.findProfileById) _findProfileById = deps.findProfileById;
  if (deps.extractFbToken) _extractFbToken = deps.extractFbToken;
  if (deps.autoFillPasswordOnPage) _autoFillPasswordOnPage = deps.autoFillPasswordOnPage;
  if (deps.callFacebookGraphApi) _callFacebookGraphApi = deps.callFacebookGraphApi;
  if (deps.PORT) _PORT = deps.PORT;
  if (deps.API_SECRET) _API_SECRET = deps.API_SECRET;
}

const log = (...args) => _log(...args);
const sleep = (ms) => _sleep(ms);
const safePageEvaluate = (...args) => _safePageEvaluate(...args);
const findProfileById = (...args) => _findProfileById(...args);
const extractFbToken = (...args) => _extractFbToken(...args);
const autoFillPasswordOnPage = (...args) => _autoFillPasswordOnPage(...args);
const callFacebookGraphApi = (...args) => _callFacebookGraphApi(...args);

const GMT_OFFSET_TO_FB_ID = {
  '-12': '3', '-11': '3', '-10': '3', '-9': '4', '-8': '1', '-7': '2', '-6': '6', '-5': '7',
  '-4': '37', '-3': '25', '-2': '22', '-1': '109', '0': '58',
  '1': '57', '2': '60', '3': '116', '4': '8', '5': '105',
  '5.5': '71', '5.75': '71',
  '6': '17', '6.5': '17',
  '7': '132', '8': '136', '8.75': '136',
  '9': '77', '9.5': '14',
  '10': '15', '10.5': '15',
  '11': '24',
  '12': '100', '12.75': '100', '13': '100', '14': '100'
};

const BILLING_CACHE_PREFIX = 'billing_cache_';
const BILLING_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

// ============================================================
// clickButtonByText — 通过可见文本点击按钮
// ============================================================
async function clickButtonByText(page, patterns) {
    for (let i = 0; i < 5; i++) {
        const selectorInfo = await page.evaluate(p => {
            const n = s => String(s || '').trim().toLowerCase();
            const dlg = document.querySelector('[role="dialog"],[role="alertdialog"]');
            const scope = dlg ? [dlg] : [document];

            const interactive = Array.from(scope[0].querySelectorAll('button, div[role="button"], a[role="button"], [role="menuitem"]'));
            const debugInfo = [];
            for (const el of interactive) {
                const t = n(el.textContent) + ' ' + n(el.getAttribute('aria-label'));
                const r = el.getBoundingClientRect();
                const w = r.width || 0;
                const h = r.height || 0;
                const visible = el.offsetParent !== null;
                const disabled = el.disabled;
                const matched = p.some(q => typeof q === 'string' && t.includes(n(q)));
                if (w >= 30 && h >= 15 && visible && matched) {
                    debugInfo.push(`MATCH: txt="${n(el.textContent).substring(0,30)}" w=${w} h=${h} visible=${visible}`);
                } else if (w >= 30 && h >= 15 && visible) {
                    debugInfo.push(`SKIP: txt="${n(el.textContent).substring(0,30)}" w=${w} h=${h} noMatch`);
                }
                if (w >= 30 && h >= 15 && t.includes('add') && visible) {
                    if (!p.some(q => typeof q === 'string' && t.includes(n(q)))) {
                        debugInfo.push(`TRACE: txt="${n(el.textContent).substring(0,40)}" has_add_but_not_matched_p`);
                    }
                }
            }
            if (debugInfo.length > 0) { window.__clickDebug = debugInfo; }
            for (const el of interactive) {
                const t = n(el.textContent) + ' ' + n(el.getAttribute('aria-label'));
                const r = el.getBoundingClientRect();
                const w = r.width || 0;
                const h = r.height || 0;
                if (w < 30 || h < 15) continue;
                for (const q of p) {
                    if (typeof q === 'string' && t.includes(n(q)) && el.offsetParent !== null && !el.disabled) {
                        el.setAttribute('data-click-target', '1');
                        el.scrollIntoView({ block: 'center', behavior: 'instant' });
                        return { found: true, strategy: 'interactive' };
                    }
                }
            }

            if (dlg) {
                const dlgBtns = dlg.querySelectorAll('button');
                for (const b of dlgBtns) {
                    try {
                        const bg = window.getComputedStyle(b).backgroundColor || '';
                        if (bg.includes('53, 120') || bg.includes('24, 119') || bg.includes('0, 132') || bg.includes('0, 149')) {
                            b.setAttribute('data-click-target', '1');
                            b.scrollIntoView({ block: 'center', behavior: 'instant' });
                            return { found: true, strategy: 'dlg_blue' };
                        }
                    } catch {}
                }
                if (dlgBtns.length > 0) {
                    const lastBtn = dlgBtns[dlgBtns.length - 1];
                    const txt = n(lastBtn.textContent);
                    if (!txt.includes('cancel') && !txt.includes('close') && !txt.includes('x') && lastBtn.offsetParent !== null) {
                        lastBtn.setAttribute('data-click-target', '1');
                        lastBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
                        return { found: true, strategy: 'dlg_last' };
                    }
                }
            }

            const ariaEls = scope[0].querySelectorAll('[aria-label]');
            for (const el of ariaEls) {
                const r = el.getBoundingClientRect();
                if (r.width < 30 || r.height < 15) continue;
                const label = n(el.getAttribute('aria-label'));
                for (const q of p) {
                    if (typeof q === 'string' && label.includes(n(q)) && el.offsetParent !== null && !el.disabled) {
                        el.setAttribute('data-click-target', '1');
                        el.scrollIntoView({ block: 'center', behavior: 'instant' });
                        return { found: true, strategy: 'aria_fallback' };
                    }
                }
            }

            return { found: false };
        }, patterns);

        if (selectorInfo.found) {
            const handle = await page.evaluateHandle(() => {
                const el = document.querySelector('[data-click-target="1"]');
                if (el) { el.removeAttribute('data-click-target'); }
                return el;
            });
            if (handle && handle.asElement()) {
                await handle.asElement().click().catch(() => {
                    page.evaluate(() => {
                        const el = document.querySelector('[data-click-target="1"]');
                        if (el) {
                            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                            el.removeAttribute('data-click-target');
                        }
                    }).catch(() => {});
                });
                try { await handle.dispose(); } catch {}
                return true;
            }
            await page.evaluate(() => {
                const el = document.querySelector('[data-click-target="1"]');
                if (el) { el.click(); el.removeAttribute('data-click-target'); }
            }).catch(() => {});
            return true;
        }

        await new Promise(r => setTimeout(r, 1500));
    }
    return false;
}

// ============================================================
// fillCardForm — 填写信用卡表单
// ============================================================
async function fillCardForm(page, card) {
    const firstNames = ['James','Robert','John','Michael','David','William','Richard','Joseph','Thomas','Christopher','Mary','Patricia','Jennifer','Linda','Barbara','Elizabeth','Susan','Jessica','Sarah','Karen','Alex','Emma','Olivia','Sophia','Isabella','Mia','Charlotte','Amelia','Harper','Evelyn'];
    const lastNames = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson'];
    const rFirstName = firstNames[Math.floor(Math.random()*firstNames.length)];
    const rLastName = lastNames[Math.floor(Math.random()*lastNames.length)];
    const holderName = card.holderName || `${rFirstName} ${rLastName}`;
    log('INFO', `💳 随机持卡人: ${holderName}`);

    await page.evaluate(({hName, ccNum, expM, expY, cvv, street, city, state, zip}) => {
        function collectInputs(root, result = []) {
            const inputs = root.querySelectorAll('input:not([type="hidden"])');
            inputs.forEach(inp => result.push(inp));
            const all = root.querySelectorAll('*');
            for (const el of all) {
                if (el.shadowRoot) collectInputs(el.shadowRoot, result);
            }
            return result;
        }
        const allInputs = collectInputs(document);
        for (const inp of allInputs) {
            const key = `${inp.id} ${inp.getAttribute('name')||''} ${inp.getAttribute('placeholder')||''} ${inp.getAttribute('aria-label')||''}`.toLowerCase();
            let val = '';
            if (key.includes('holder')||key.includes('name')||key.includes('cardholder')||key.includes('full name')||key.includes('nombre')||key.includes('持卡人')||key.includes('姓名')) val = hName;
            else if (key.includes('street')||key.includes('address')||key.includes('dirección')||key.includes('街道')||key.includes('地址')) val = street || '123 Main St';
            else if (key.includes('city')||key.includes('ciudad')||key.includes('城市')||key.includes('市')) val = city || 'New York';
            else if (key.includes('state')||key.includes('estado')||key.includes('州')||key.includes('省')||key.includes('地区')) val = state || 'NY';
            else if (key.includes('zip')||key.includes('postal')||key.includes('postcode')||key.includes('código')||key.includes('邮编')||key.includes('邮政编码')||key.includes('编码')) val = zip || '10001';
            else continue;
            if (val) {
                inp.value = val;
                inp.dispatchEvent(new Event('input', {bubbles: true}));
                inp.dispatchEvent(new Event('change', {bubbles: true}));
            }
        }
    }, {hName: holderName, ccNum: card.number, expM: card.expMonth, expY: card.expYear, cvv: card.cvv, street: card.billingStreet, city: card.billingCity, state: card.billingState, zip: card.billingZip});

    try {
        const allInputsJs = await page.evaluate(() => {
            function collectInputs(root, result = []) {
                const inputs = root.querySelectorAll('input:not([type="hidden"])');
                inputs.forEach(inp => result.push(inp));
                const all = root.querySelectorAll('*');
                for (const el of all) {
                    if (el.shadowRoot) collectInputs(el.shadowRoot, result);
                }
                return result;
            }
            const inputs = collectInputs(document);
            return inputs.map((inp, idx) => {
                const combo = `${inp.id} ${inp.getAttribute('name')||''} ${inp.getAttribute('placeholder')||''} ${inp.getAttribute('aria-label')||''}`.toLowerCase();
                const rect = inp.getBoundingClientRect();
                return { idx, id: inp.id, name: inp.getAttribute('name'), placeholder: inp.getAttribute('placeholder'), ariaLabel: inp.getAttribute('aria-label'), value: inp.value, visible: inp.offsetParent !== null, combo, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
            }).filter(i => i.visible && i.w > 5 && i.h > 5);
        }).catch(() => []);

        log('INFO', `💳 Shadow DOM 字段诊断: ${JSON.stringify(allInputsJs)}`);

        for (const fieldInfo of allInputsJs) {
            if (fieldInfo.value) continue;
            const combo = fieldInfo.combo;
            let t = '';
            if (combo.includes('holder')||combo.includes('name')||combo.includes('nombre')||combo.includes('持卡人')||combo.includes('姓名')) t = holderName;
            else if (combo.includes('number')||combo.includes('card')||combo.includes('卡号')) t = String(card.number||'');
            else if (combo.includes('expiration')||combo.includes('expiry')||combo.includes('exp_date')) t = `${String(card.expMonth||'').padStart(2,'0')}/${String(card.expYear||'').slice(-2)}`;
            else if ((combo.includes('month')||combo.includes('mm')||combo.includes('月')) && combo.includes('exp')) t = String(card.expMonth||'').padStart(2,'0');
            else if ((combo.includes('year')||combo.includes('yy')||combo.includes('年')) && combo.includes('exp')) t = String(card.expYear||'').slice(-2);
            else if (combo.includes('month')||combo.includes('mm')||combo.includes('月')) t = String(card.expMonth||'').padStart(2,'0');
            else if (combo.includes('year')||combo.includes('yy')||combo.includes('年')) t = String(card.expYear||'').slice(-2);
            else if (combo.includes('exp')||combo.includes('有效期')) t = `${String(card.expMonth||'').padStart(2,'0')}/${String(card.expYear||'').slice(-2)}`;
            else if (combo.includes('cvv')||combo.includes('cvc')||combo.includes('sec')||combo.includes('安全码')||combo.includes('验证码')||combo.includes('código')) t = String(card.cvv||'');
            else if (combo.includes('zip')||combo.includes('postal')||combo.includes('邮编')||combo.includes('邮政编码')) t = card.billingZip || '10001';
            if (t) {
                log('INFO', `💳 键盘填入(Shadow): ${combo.substring(0,40)} -> ${t.substring(0,4)}...`);
                await page.evaluate(({ idx: fieldIdx, text }) => {
                    function collectInputs(root, result = []) {
                        const inputs = root.querySelectorAll('input:not([type="hidden"])');
                        inputs.forEach(inp => result.push(inp));
                        const all = root.querySelectorAll('*');
                        for (const el of all) {
                            if (el.shadowRoot) collectInputs(el.shadowRoot, result);
                        }
                        return result;
                    }
                    const allInputs = collectInputs(document);
                    const inp = allInputs[fieldIdx];
                    if (inp) {
                        inp.focus();
                        inp.click();
                        inp.value = text;
                        inp.dispatchEvent(new Event('input', {bubbles: true}));
                        inp.dispatchEvent(new Event('change', {bubbles: true}));
                    }
                }, { idx: fieldInfo.idx, text: t }).catch(() => {});
                await new Promise(r => setTimeout(r, 200));
            }
        }
    } catch(e) { log('WARN', `💳 Shadow DOM 填入异常: ${e.message}`); }
}

// ============================================================
// fillIframeCardFields — 填写 iframe 中的卡字段
// ============================================================
async function fillIframeCardFields(page, cn, em, ey, cv) {
    let filled = 0;
    await new Promise(r => setTimeout(r, 3000));
    let iframes = [];
    for (let attempt = 0; attempt < 5; attempt++) {
        iframes = await page.$$('iframe');
        if (iframes.length > 0) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    log('INFO', `💳 iframe 检测: 共 ${iframes.length} 个`);
    for(const ifr of iframes){
        try{
            const f = await ifr.contentFrame();
            if(!f) continue;
            const inputs = await f.$$('input');
            if (inputs.length === 0) continue;
            log('INFO', `💳 iframe 发现 ${inputs.length} 个输入框`);
            for(const inp of inputs){
                try{
                    const combo=`${await inp.evaluate(el=>el.id||el.name)} ${await inp.evaluate(el=>el.getAttribute('placeholder')||'')} ${await inp.evaluate(el=>el.getAttribute('aria-label')||'')}`.toLowerCase();
                    let v='';
                    if(combo.includes('number')||combo.includes('card')||combo.includes('卡号')) v=cn;
                    else if(combo.includes('month')||combo.includes('月')||combo.includes('mm')) v=String(em||'').padStart(2,'0');
                    else if(combo.includes('year')||combo.includes('年')||combo.includes('yy')) v=String(ey||'').slice(-2);
                    else if(combo.includes('cvv')||combo.includes('cvc')||combo.includes('安全')) v=String(cv||'');
                    if(v){
                        await inp.click();
                        await new Promise(r => setTimeout(r, 100));
                        await f.keyboard.type(v, {delay: 25});
                        filled++;
                    }
                }catch{}
            }
        }catch{}
    }
    log('INFO', `💳 iframe 填入完成: 共 ${filled} 个字段`);
}

// ============================================================
// tryUpdateCurrencyTimezone — 通过 Graph API 更新货币/时区
// ============================================================
async function tryUpdateCurrencyTimezone(page, pid, actId, currency, timezone_id) { if(!currency&&!timezone_id)return;try{let t='';const p=await findProfileById(pid).catch(()=>null);if(p)t=String(p?.account_tokens||p?.token||'').trim();if(!t){t=await page.evaluate(()=>{try{for(const k of Object.keys(localStorage)){const v=localStorage.getItem(k);if(v&&(v.startsWith('EAAB')||v.startsWith('EAA')))return v}}catch{}return ''}).catch(()=>'')}if(t){let tz='';if(timezone_id){const m=String(timezone_id).match(/^(\d{1,3})$/);if(m&&Number(m[1])>=1&&Number(m[1])<=199)tz=m[1]}const r=await page.evaluate(async p2=>{const fd=new URLSearchParams();fd.append('access_token',p2.t);if(p2.c)fd.append('currency',p2.c);if(p2.tz)fd.append('timezone_id',p2.tz);try{const r=await fetch('https://graph.facebook.com/v21.0/act_'+p2.a,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:fd.toString()});return await r.json()}catch(e){return{error:e.message}}},{a:actId,t:t,c:currency||'',tz:tz});log('INFO',`💰 [Profile=${pid}] 货币/时区修改: ${JSON.stringify(r).substring(0,150)}`)}}catch(ctErr){log('WARN',`⚠️ [Profile=${pid}] 货币/时区异常: ${ctErr.message}`)} }

// ============================================================
// detectCardBrand — 检测卡品牌
// ============================================================
function detectCardBrand(number) { const n = String(number||'').replace(/\D/g,''); if(/^4/.test(n))return 'Visa'; if(/^5[1-5]/.test(n))return 'Mastercard'; if(/^3[47]/.test(n))return 'Amex'; if(/^6/.test(n))return 'Discover'; return ''; }

// ============================================================
// normalizeFbTimezoneId — 将时区值规范化为 FB 内部 timezone_id
// ============================================================
function normalizeFbTimezoneId(input) {
  if (input === null || input === undefined || input === '') return '';
  const s = String(input).trim();
  if (!s) return '';

  let numStr = s;
  let isNegative = false;
  let hasSign = false;
  if (s.startsWith('-')) { isNegative = true; hasSign = true; numStr = s.slice(1); }
  else if (s.startsWith('+')) { hasSign = true; numStr = s.slice(1); }

  const num = parseFloat(numStr);
  if (isNaN(num)) return '';

  const offset = isNegative ? -num : num;
  const isFloat = !Number.isInteger(num);

  if (isNegative) {
    const fbId = GMT_OFFSET_TO_FB_ID[String(offset)];
    return fbId ? String(fbId) : '';
  }

  if (isFloat) {
    const fbId = GMT_OFFSET_TO_FB_ID[String(offset)];
    return fbId ? String(fbId) : '';
  }

  if (hasSign) {
    const fbId = GMT_OFFSET_TO_FB_ID[String(offset)];
    return fbId ? String(fbId) : '';
  }

  if (num === 0) {
    return '58';
  }
  if (num >= 1 && num <= 199) {
    return String(num);
  }
  return '';
}

// ============================================================
// Billing Cache 辅助函数
// ============================================================
function getBillingCacheKey(profileId, actId) {
  return `${BILLING_CACHE_PREFIX}${profileId}_${actId}`;
}

function getBillingCache(profileId, actId) {
  try {
    const key = getBillingCacheKey(profileId, actId);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() > data.expiry) { localStorage.removeItem(key); return null; }
    return data.value;
  } catch { return null; }
}

function setBillingCache(profileId, actId, data) {
  try {
    const key = getBillingCacheKey(profileId, actId);
    localStorage.setItem(key, JSON.stringify({ value: data, expiry: Date.now() + BILLING_CACHE_TTL }));
  } catch {}
}

// ============================================================
// buildBillingHubUrl — 生成 billing_hub 页面 URL
// ============================================================
function buildBillingHubUrl(actId, paymentAccountId, locale) {
  const cleanId = String(actId || '').replace(/^act_/, '');
  const payId = String(paymentAccountId || cleanId).replace(/^act_/, '');
  const loc = locale ? `&locale=${locale}` : '';
  if (!payId) return `https://business.facebook.com/latest/billing_hub/payment_settings/?locale=en_US${loc}`;
  return `https://business.facebook.com/latest/billing_hub/payment_settings/?payment_account_id=${payId}&asset_id=${payId}${loc}`;
}

// ============================================================
// navigateToBillingHub — 带降级逻辑的 billing_hub 导航
// ============================================================
async function navigateToBillingHub(page, actId, paymentAccountId, locale) {
  const cleanId = String(actId || '').replace(/^act_/, '');
  const payId = String(paymentAccountId || cleanId).replace(/^act_/, '');
  if (!locale) {
    try {
      for (const [pid, entry] of _activeBrowsers) {
        if (entry.browser && entry.browser.isConnected()) {
          const pages = await entry.browser.pages().catch(() => []);
          if (pages.some(p => p === page || p.target() === page?.target())) {
            locale = entry.fbLanguage || 'en_US';
            break;
          }
        }
      }
    } catch {}
  }
  locale = locale || 'en_US';
  const primaryUrl = buildBillingHubUrl(actId, paymentAccountId, locale);
  const fallbackUrl = payId
    ? `https://business.facebook.com/latest/billing_hub/payment_settings/?payment_account_id=${payId}&asset_id=${payId}&locale=${locale}`
    : `https://business.facebook.com/latest/billing_hub/payment_settings/?locale=${locale}`;

  const isPageUsable = async () => {
    try {
      const text = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      if (!text) return false;
      if (text.includes('目前无法显示') || text.includes('can\'t display') || text.includes('could not be loaded') || 
          text.includes('content is not available') || text.includes('not available') || text.includes('try again later') ||
          text.includes('链接可能已过期') || text.includes('link may have expired') || text.includes('指定用户可见') ||
          text.includes('only visible to') || text.includes('需要获得权限') || text.includes('need permission') ||
          text.includes('access is restricted') || text.includes('access denied') || text.includes('you don\'t have permission') ||
          text.includes('cannot be displayed')) return false;
      return true;
    } catch { return false; }
  };

  try {
    await page.goto(primaryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    if (await isPageUsable()) {
      log('INFO', `[BillingNav] 导航成功: ${primaryUrl}`);
      return true;
    }
    log('WARN', `[BillingNav] 主地址加载但内容不可用，降级到: ${fallbackUrl}`);
  } catch (e) {
    log('WARN', `[BillingNav] 主地址失败: ${e.message}，降级到: ${fallbackUrl}`);
  }

  try {
    await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    if (await isPageUsable()) {
      log('INFO', `[BillingNav] 降级导航成功: ${fallbackUrl}`);
      return true;
    }
    log('WARN', `[BillingNav] 降级地址也加载但内容不可用: ${fallbackUrl}`);
  } catch (e2) {
    log('WARN', `[BillingNav] 降级也失败: ${e2.message}`);
  }

  const manageUrl = `https://adsmanager.facebook.com/adsmanager/manage/accounts?nav_entry_point=ads_ecosystem_navigation_menu&nav_source=ads_manager&act=${payId || ''}`;
  try {
    await page.goto(manageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    log('INFO', `[BillingNav] 三级降级导航到 manage/accounts: ${manageUrl}`);
    return true;
  } catch (e3) {
    log('WARN', `[BillingNav] 三级降级也失败: ${e3.message}`);
    return false;
  }
}

// ============================================================
// retryWithTokenRefresh — 通用 Token 刷新重试辅助函数
// ============================================================
async function retryWithTokenRefresh(profileId, browser, page, apiCallFn, maxRetries = 3) {
    let lastError = '';
    const cdpTokenSet = new Set();
    const cdpHandler = (request) => {
      try {
        const url = request.url();
        if (url.includes('graph.facebook.com') && url.includes('access_token=')) {
          const m = url.match(/access_token=(EAAB[A-Za-z0-9_\-]{50,200})/);
          if (m && m[1] && m[1].length > 50) cdpTokenSet.add(m[1]);
        }
      } catch {}
    };
    try { page.on('request', cdpHandler); } catch {}
    const cleanupCdp = () => { try { page.removeListener('request', cdpHandler); } catch {} };
    setTimeout(cleanupCdp, 60000);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        log('INFO', `🔄 [Profile=${profileId}] Token 重试第 ${attempt}/${maxRetries} 次`);
        let token = '';
        if (page && typeof page.target === 'function') {
          try { token = await extractFbToken(page, 10000); } catch {}
        }
        if (!token || token.length <= 50) {
          for (const t of cdpTokenSet) {
            if (t && t.length > 50) { token = t; break; }
          }
        }
        if (!token || token.length <= 50) {
          try {
            token = await page.evaluate(async () => {
                try {
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        const v = localStorage.getItem(k) || '';
                        if (v.startsWith('EAAB') || v.startsWith('EAAG')) return v.substring(0, 200);
                        const at = v.match(/access_token=(EAAB[A-Za-z0-9_\-]{50,200})/);
                        if (at) return at[1];
                    }
                } catch {}
                try {
                    for (let i = 0; i < sessionStorage.length; i++) {
                        const k = sessionStorage.key(i);
                        const v = sessionStorage.getItem(k) || '';
                        if (v.startsWith('EAAB') || v.startsWith('EAAG')) return v.substring(0, 200);
                    }
                } catch {}
                try {
                    const d = document.cookie.split(';').find(c => c.trim().startsWith('act='));
                    if (d) return decodeURIComponent(d.split('=')[1]);
                } catch {}
                try {
                    for (const s of document.querySelectorAll('script')) {
                        const m = s.innerHTML?.match(/EAAB[A-Za-z0-9_\-]{50,200}/);
                        if (m) return m[0];
                    }
                } catch {}
                return '';
            });
          } catch {}
        }

        if (token && token.length > 50) {
            try {
                const verifyUrl = `https://graph.facebook.com/v21.0/me?fields=id&access_token=${encodeURIComponent(token)}`;
                const verifyRes = await safePageEvaluate(page, async (url) => {
                    try { const r = await fetch(url); return await r.json(); } catch { return null; }
                }, verifyUrl);
                if (verifyRes && !verifyRes.error) {
                    log('INFO', `🔑 [Profile=${profileId}] Token 有效 (len=${token.length})，执行 API 调用`);
                    const apiResult = await apiCallFn(token, browser, page);
                    if (apiResult && !apiResult.error && apiResult.success !== false) {
                        return apiResult;
                    }
                    const apiErr = apiResult?.error?.code || apiResult?.error?.message || '';
                    if (!apiErr.toString().includes('190') && !apiErr.toString().includes('session')) {
                        return apiResult;
                    }
                    lastError = apiErr.toString();
                    log('WARN', `🚫 [Profile=${profileId}] Token 仍然 190，继续重试`);
                } else {
                    log('WARN', `⚠️ [Profile=${profileId}] Token 验证失败，尝试重新提取`);
                }
            } catch {}
        } else {
            log('WARN', `⚠️ [Profile=${profileId}] 未找到有效 Token`);
        }

        if (attempt < maxRetries) {
            try {
                await page.goto('https://www.facebook.com/adsmanager', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 4000));
            } catch {}
        }

        if (attempt === maxRetries - 1) {
            try {
                const fbCookies = await page.cookies('https://www.facebook.com', 'https://facebook.com').catch(() => []);
                const arr = Array.isArray(fbCookies) ? fbCookies : [];
                const cUser = arr.find(c => c.name === 'c_user');
                const xs = arr.find(c => c.name === 'xs');
                if (!cUser?.value || !xs?.value) {
                    log('WARN', `🚫 [Profile=${profileId}] Cookie 已失效，自动登录...`);
                    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                    await new Promise(r => setTimeout(r, 3000));
                    const profileObj = await findProfileById(profileId);
                    if (profileObj) {
                        try { await autoFillPasswordOnPage(page, profileObj, profileId); } catch {}
                        log('INFO', `🔐 [Profile=${profileId}] 自动填密码完成，等待登录...`);
                        await new Promise(r => setTimeout(r, 8000));
                    }
                }
            } catch {}
        }
    }
    log('WARN', `🚫 [Profile=${profileId}] Token 重试 ${maxRetries} 次均失败，返回 loginFailed`);
    return { success: false, loginFailed: true, message: `Token 过期，重试 ${maxRetries} 次后仍然失败` };
}

// ============================================================
// ensureFbLanguage — 修改 Facebook 语言
// ============================================================
async function ensureFbLanguage(browser, targetLang = 'en_US') {
  log('INFO', `[FB-Lang] 开始修改语言 -> ${targetLang}`);
  const page = await browser.newPage();
  try {
    await page.goto('https://www.facebook.com/settings/?tab=language', {
      waitUntil: 'networkidle2', timeout: 30000
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    const currentLang = await page.evaluate(() => document.documentElement.lang || '').catch(() => '');
    log('INFO', `[FB-Lang] 当前页面 lang=${currentLang}`);
    if (currentLang && currentLang.startsWith(targetLang.split('_')[0])) {
      log('INFO', `[FB-Lang] ✅ 已经是目标语言`);
      return true;
    }

    log('INFO', `[FB-Lang] 🏆策略0 CDP 捕获 + XHR...`);
    let cdpSession = null;
    let cdpDone = false;
    try {
      cdpSession = await page.target().createCDPSession();
      await cdpSession.send('Network.enable');

      let bootloaderParams = null;
      let capturedSession = { fbDtsg: '', userId: '', docId: '' };

      cdpSession.on('Network.requestWillBeSent', (params) => {
        try {
          if (!params.request.url.includes('/api/graphql/') || params.request.method !== 'POST') return;
          const pd = params.request.postData || '';
          if (!pd.includes('__dyn=')) return;
          const e = (k) => { const m = new RegExp(k+'=([^&]+)').exec(pd); return m ? decodeURIComponent(m[1]) : ''; };

          if (!bootloaderParams && e('__dyn')) {
            bootloaderParams = {
              __dyn: e('__dyn'), __csr: e('__csr'), __rev: e('__rev'),
              __s: e('__s'), __hs: e('__hs'), __hsi: e('__hsi'),
              __ccg: e('__ccg') || 'EXCELLENT',
              __aaid: e('__aaid') || '0',
              dpr: e('dpr') || '2',
            };
            capturedSession.fbDtsg = e('fb_dtsg');
            capturedSession.userId = e('__user') || e('av');
            const friendlyName = e('fb_api_req_friendly_name');
            const docIdMatch = pd.match(/doc_id=(\d+)/);
            if (docIdMatch) {
              if (friendlyName && (friendlyName.includes('ScrollablePicker') || friendlyName.toLowerCase().includes('language'))) {
                capturedSession.docId = docIdMatch[1];
                log('INFO', `[FB-Lang] ✅ CDP 捕获语言选择器: doc_id=${capturedSession.docId}, friendly=${friendlyName}`);
              } else {
                log('INFO', `[FB-Lang] 👀 CDP 跳过非语言突变: friendly=${friendlyName || '(none)'}, doc_id=${docIdMatch[1]}`);
              }
            }
            log('INFO', `[FB-Lang] ✅ CDP 捕获: rev=${bootloaderParams.__rev}, dyn=${!!bootloaderParams.__dyn}, fbDtsg=${!!capturedSession.fbDtsg}, userId=${!!capturedSession.userId}`);
          }
        } catch {}
      });

      await page.goto('https://www.facebook.com/settings/?tab=language', {
        waitUntil: 'domcontentloaded', timeout: 15000
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      if (!bootloaderParams) {
        log('INFO', `[FB-Lang] reload 重试...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
      }

      for (let i = 0; i < 35 && !bootloaderParams; i++) await new Promise(r => setTimeout(r, 200));

      if (!bootloaderParams || !capturedSession.fbDtsg || !capturedSession.userId) {
        log('WARN', `[FB-Lang] ⚠️ 策略0 CDP 未捕获到完整参数: bootloader=${!!bootloaderParams}, fbDtsg=${!!capturedSession.fbDtsg}, userId=${!!capturedSession.userId}`);
      } else {
        log('INFO', `[FB-Lang] 🏆策略0 捕获完成，发送 XHR...`);

        const finalDocId = capturedSession.docId || '23915562351374516';
        if (capturedSession.docId) {
          log('INFO', `[FB-Lang] ✅ 使用 CDP 捕获的 doc_id=${finalDocId}`);
        } else {
          log('INFO', `[FB-Lang] ⚠️ CDP 未捕获到 doc_id，使用硬编码 ${finalDocId}`);
        }

        const allLocales = [
          'af_ZA','sq_AL','ar_AR','hy_AM','az_AZ','eu_ES','be_BY','bn_IN','bs_BA','bg_BG',
          'ca_ES','ckb_IQ','zh_CN','zh_HK','zh_TW','co_FR','hr_HR','cs_CZ','da_DK','nl_NL',
          'en_GB','en_US','eo_EO','et_EE','fo_FO','fil_PH','fi_FI','fr_FR','fy_NL','gl_ES',
          'ka_GE','de_DE','el_GR','gu_IN','ht_HT','ha_NG','he_IL','hi_IN','hu_HU','is_IS',
          'ig_NG','id_ID','ga_IE','it_IT','ja_JP','jv_ID','kn_IN','kk_KZ','km_KH','rw_RW',
          'ko_KR','ku_TR','ky_KG','lo_LA','la_VA','lv_LV','lt_LT','lb_LU','mk_MK','mg_MG',
          'ms_MY','ml_IN','mt_MT','mi_NZ','mr_IN','mn_MN','my_MM','ne_NP','nb_NO','nn_NO',
          'ny_MW','or_IN','ps_AF','fa_IR','pl_PL','pt_BR','pt_PT','pa_IN','ro_RO','ru_RU',
          'sa_IN','sn_ZW','sd_IN','si_LK','sk_SK','sl_SI','so_SO','es_ES','es_LA','es_MX',
          'sw_KE','sv_SE','tg_TJ','ta_IN','te_IN','th_TH','tr_TR','tk_TM','uk_UA','ur_PK',
          'ug_CN','uz_UZ','vi_VN','cy_GB','wo_SN','xh_ZA','yi_DE','yo_NG','zu_ZA'
        ];
        const selectionState = allLocales.map(code => ({
          is_selected: code === targetLang,
          option_id: code
        }));
        const variables = {
          input: {
            actor_id: capturedSession.userId,
            client_mutation_id: '1',
            additional_params: {},
            entry_point: 'privacy_checkup',
            node_id: 'ACCOUNT_AND_APP_LANGUAGE',
            selected_id: targetLang,
            selection_state: selectionState
          }
        };

        const apiResult = await page.evaluate(async (p) => {
          try {
            return await new Promise((resolve) => {
              const xhr = new XMLHttpRequest();
              xhr.open('POST', 'https://www.facebook.com/api/graphql/', true);
              xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
              xhr.withCredentials = true;
              xhr.onload = () => {
                try { resolve({ ok: true, data: JSON.parse(xhr.responseText) }); }
                catch { resolve({ ok: false, raw: (xhr.responseText||'').substring(0,300), status: xhr.status }); }
              };
              xhr.onerror = () => resolve({ ok: false, error: 'xhr_error' });
              xhr.ontimeout = () => resolve({ ok: false, error: 'timeout' });
              xhr.timeout = 15000;
              const bl = p.bl;
              const parts = [
                '__a=1', '__aaid='+encodeURIComponent(bl.__aaid||'0'),
                '__user='+encodeURIComponent(p.uid), 'av='+encodeURIComponent(p.uid),
                '__req='+String(Math.floor(Math.random()*90)+10),
                bl.__hs?'__hs='+encodeURIComponent(bl.__hs):'',
                'dpr='+encodeURIComponent(bl.dpr||'2'),
                bl.__ccg?'__ccg='+encodeURIComponent(bl.__ccg):'',
                bl.__rev?'__rev='+encodeURIComponent(bl.__rev):'',
                bl.__s?'__s='+encodeURIComponent(bl.__s):'',
                bl.__hsi?'__hsi='+encodeURIComponent(bl.__hsi):'',
                bl.__dyn?'__dyn='+encodeURIComponent(bl.__dyn):'',
                bl.__csr?'__csr='+encodeURIComponent(bl.__csr):'',
                'fb_dtsg='+encodeURIComponent(p.dtsg),
                'fb_api_req_friendly_name='+encodeURIComponent('useCometUSFScrollablePickerMutation'),
                'variables='+encodeURIComponent(p.vars),
                'server_timestamps=true',
                'doc_id='+encodeURIComponent(p.docId)
              ];
              xhr.send(parts.filter(Boolean).join('&'));
            });
          } catch(e) { return { ok:false, error: e.message }; }
        }, {
          bl: bootloaderParams,
          uid: capturedSession.userId,
          dtsg: capturedSession.fbDtsg,
          vars: JSON.stringify(variables),
          docId: finalDocId
        });

        log('INFO', `[FB-Lang] 🏆策略0 XHR 结果: ${JSON.stringify(apiResult).substring(0, 300)}`);

        if (apiResult?.ok && apiResult.data?.data?.xfb_update_usf_scrollable_picker) {
          const picker = apiResult.data.data.xfb_update_usf_scrollable_picker;
          const isTargetSelected = picker.isSelected === true ||
            (picker.headerOptions && picker.headerOptions.some(o => o.optionID === targetLang && o.isSelected === true));
          if (isTargetSelected) {
            log('INFO', `[FB-Lang] ✅ 策略0 XHR 成功! ${targetLang} 已选中`);
            await page.evaluate((l) => { document.cookie = `locale=${l}; domain=.facebook.com; path=/; max-age=86400`; }, targetLang);
            await new Promise(r => setTimeout(r, 500));
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
            const verifyLang = await page.evaluate(() => document.documentElement.lang).catch(() => '');
            log('INFO', `[FB-Lang] 🏆策略0 验证 lang=${verifyLang}`);
            if (verifyLang && verifyLang.startsWith(targetLang.split('_')[0])) {
              log('INFO', `[FB-Lang] ✅ 策略0 语言修改成功!`);
              return true;
            }
          } else {
            log('WARN', `[FB-Lang] ⚠️ 策略0 目标语言未被选中`);
          }
        } else {
          log('WARN', `[FB-Lang] ⚠️ 策略0 XHR 失败: ${JSON.stringify(apiResult).substring(0, 200)}`);
        }
      }
    } catch (cdpErr) {
      log('WARN', `[FB-Lang] ⚠️ 策略0 异常: ${cdpErr.message}`);
    } finally {
      if (cdpSession) { try { await cdpSession.detach(); } catch {} }
    }

    log('INFO', `[FB-Lang] 尝试 UI 交互修改语言...`);
    try {
      const pageStructure = await page.evaluate(() => {
        const allText = document.body.innerText || '';
        const hasSelector = !!document.querySelector('[role="listbox"], [role="combobox"], [role="radiogroup"]');
        return { hasSelector, textSample: allText.substring(0, 300) };
      });
      log('INFO', `[FB-Lang] 页面结构: hasSelector=${pageStructure.hasSelector}, text=${pageStructure.textSample.substring(0,100)}`);

      await page.evaluate((lang) => {
        const targetTexts = ['English (US)', 'English', 'English US', lang];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
          const txt = (node.textContent || '').trim();
          if (txt === 'English (US)' || txt === 'English' || txt === lang) {
            const parent = node.parentElement;
            if (parent) {
              parent.click();
              parent.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              parent.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              return { clicked: txt };
            }
          }
        }
        return { clicked: false, partial: false };
      }, targetLang);

      await new Promise(r => setTimeout(r, 2000));

      const saved = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], [data-testid], a[role="button"]');
        for (const b of buttons) {
          const txt = (b.textContent || b.getAttribute('aria-label') || '').toLowerCase();
          if (txt.includes('save') || txt.includes('保存') || txt.includes('ok') || txt.includes('确定') || txt.includes('done') || txt.includes('完成')) {
            if (b.offsetParent !== null) {
              b.click();
              return true;
            }
          }
        }
        return false;
      });
      log('INFO', `[FB-Lang] 保存按钮: ${saved ? '已点击' : '未找到'}`);

      if (saved) {
        await new Promise(r => setTimeout(r, 3000));
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        const uiLang = await page.evaluate(() => document.documentElement.lang).catch(() => '');
        log('INFO', `[FB-Lang] UI 方法验证 lang=${uiLang}`);
        if (uiLang && uiLang.startsWith(targetLang.split('_')[0])) { return true; }
      }
    } catch (uiErr) {
      log('WARN', `[FB-Lang] UI 方法异常: ${uiErr.message}`);
    }

    log('INFO', `[FB-Lang] 尝试 language.php...`);
    try {
      await page.goto(`https://www.facebook.com/language.php?locale2=${targetLang}`, {
        waitUntil: 'domcontentloaded', timeout: 20000
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      const confirmed = await page.evaluate(() => {
        const btns = document.querySelectorAll('button, [role="button"], a[role="button"]');
        for (const b of btns) {
          const t = (b.textContent || b.getAttribute('aria-label') || '').toLowerCase();
          if (t.includes('keep') || t.includes('save') || t.includes('ok') || t.includes('确定') || t.includes('确认')) {
            if (b.offsetParent !== null) { b.click(); return b.textContent?.substring(0,20) || 'clicked'; }
          }
        }
        return false;
      });
      log('INFO', `[FB-Lang] language.php 确认: ${JSON.stringify(confirmed)}`);
      await new Promise(r => setTimeout(r, 3000));

      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      const langPhp = await page.evaluate(() => document.documentElement.lang).catch(() => '');
      log('INFO', `[FB-Lang] language.php 验证 lang=${langPhp}`);
      if (langPhp && langPhp.startsWith(targetLang.split('_')[0])) { return true; }
    } catch (lpErr) {
      log('WARN', `[FB-Lang] language.php 异常: ${lpErr.message}`);
    }

    log('INFO', `[FB-Lang] 尝试 Cookie+刷新...`);
    await page.evaluate((lang) => {
      document.cookie = `locale=${lang}; domain=.facebook.com; path=/; max-age=86400`;
    }, targetLang);
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    const lang2 = await page.evaluate(() => document.documentElement.lang).catch(() => '');
    log('INFO', `[FB-Lang] Cookie 方法验证 lang=${lang2}`);
    if (lang2 && lang2.startsWith(targetLang.split('_')[0])) { return true; }

    return false;
  } catch (e) {
    log('ERROR', `[FB-Lang] 异常: ${e.message}`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

// ============================================================
// tryUpdateBillingCountrySmart — 智能国家更新（fbspider 方案 + 多语言兜底）
// ============================================================
async function tryUpdateBillingCountrySmart(page, actId, country, currency, timezone_id, address, city, zip, state, paymentAccountId, lang) {
  log('INFO', `[BSmart] 开始智能更新国家: act=${actId}, country=${country}, currency=${currency}, tz=${timezone_id}`);
  const results = { api: null, dsl: null, form: null };

  // ============================================================
  // 🏆 策略1（fbspider 方案）: 使用 fbDtsg 调用内部 GraphQL API
  // ============================================================
  if (country) {
    try {
      await navigateToBillingHub(page, actId, paymentAccountId);
      await new Promise(r => setTimeout(r, 3000));

      log('INFO', `[BSmart] 🏆策略1 已导航到账单页面，提取 fbDtsg 中...`);

      const fbContext = await page.evaluate(() => {
        try {
          let fbDtsg = '';
          let userId = '';
          let businessId = '';

          try {
            if (window.require) {
              const req = window.require('CurrentUserInitialData');
              if (req) {
                if (req.fbDtsg) fbDtsg = req.fbDtsg;
                if (req.USER_ID) userId = req.USER_ID;
              }
            }
          } catch {}

          if (!fbDtsg) {
            try {
              for (const k of Object.keys(localStorage)) {
                const v = localStorage.getItem(k);
                if (k === 'fb_dtsg') { fbDtsg = v; break; }
              }
            } catch {}
          }

          if (!fbDtsg || !userId) {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
              const txt = s.textContent || s.innerText || '';
              if (!fbDtsg) { const m = txt.match(/"token":"([^"]+)"/); if (m) fbDtsg = m[1]; }
              if (!userId) { const m = txt.match(/"USER_ID":"(\d+)"/); if (m) userId = m[1]; }
              if (!businessId) { const m = txt.match(/"business_id":"(\d+)"/); if (m) businessId = m[1]; }
              if (fbDtsg && userId) break;
            }
          }

          if (!businessId) {
            const m = window.location.href.match(/payment_account_id=(\d+)/);
            if (m) businessId = m[1];
          }

          return { fbDtsg: fbDtsg || '', userId: userId || '', businessId: businessId || '', url: window.location.href };
        } catch (e) { return { fbDtsg: '', userId: '', businessId: '', error: e.message, url: window.location.href }; }
      });

      log('INFO', `[BSmart] fbDtsg 提取结果: userId=${(fbContext.userId||'').substring(0,8)}..., fbDtsg=${(fbContext.fbDtsg||'').substring(0,15)}..., bizId=${fbContext.businessId}`);

      if (fbContext.fbDtsg) {
        const cleanId = String(actId).replace(/^act_/, '');
        const WORKING_DOC_ID = '26388239514182128';

        let apiResult = null;
        const apiEndpoints = [
          'https://business.facebook.com/api/graphql/',
          '/api/graphql/',
          'https://www.facebook.com/api/graphql/'
        ];

        const addrCountry = ((country || 'US').toUpperCase() === 'UK' ? 'GB' : (country || 'US').toUpperCase());
        const payId = String(paymentAccountId || cleanId).replace(/^act_/, '');
        const variables = JSON.stringify({
          input: {
            billable_account_payment_legacy_account_id: cleanId,
            payment_account_id: payId,
            currency: (currency || 'USD'),
            device_country: null,
            tax: {
              business_address: {
                city: (city || ''),
                country_code: addrCountry,
                state: (state || ''),
                street1: (address || ''),
                street2: '',
                zip: (zip || '')
              },
              business_name: '',
              is_personal_use: false,
              second_tax_id: '',
              tax_id: '',
              tax_registration_status: ''
            },
            timezone: (timezone_id || null),
            upl_logging_data: {
              billing_notification_id: '',
              context: 'billingaccountinfo',
              credential_type: 'NEW_CREDIT_CARD',
              entry_point: 'ads_manager',
              external_flow_id: 'upl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 36),
              target_name: 'BillingAccountInformationFormMutation',
              user_session_id: 'upl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 36),
              wizard_config_name: '',
              wizard_name: '',
              wizard_screen_name: 'account_information_state_display',
              wizard_session_id: 'upl_wizard_' + Date.now() + '_' + Math.floor(Math.random() * 1000000)
            }
          }
        });

        for (const doc_id of [WORKING_DOC_ID]) {
          apiResult = await page.evaluate(async (payload) => {
            try {
              return await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', payload.endpoint, true);
                xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                xhr.withCredentials = true;
                xhr.onload = () => {
                  try { resolve(JSON.parse(xhr.responseText)); }
                  catch { resolve({ raw: (xhr.responseText || '').substring(0, 500), status: xhr.status }); }
                };
                xhr.onerror = () => resolve({ error: 'xhr_error:' + (xhr.status || 'no_status'), endpoint: payload.endpoint });
                xhr.ontimeout = () => resolve({ error: 'xhr_timeout' });
                xhr.timeout = 8000;
                const b = 'fb_dtsg=' + encodeURIComponent(payload.fb_dtsg) +
                          '&variables=' + encodeURIComponent(payload.variables) +
                          '&doc_id=' + encodeURIComponent(payload.doc_id);
                xhr.send(b);
              });
            } catch (e) { return { error: 'xhr_exception:' + e.message }; }
          }, { fb_dtsg: fbContext.fbDtsg, variables, doc_id, endpoint: apiEndpoints[0] });

          log('INFO', `[BSmart] 🏆策略1 doc_id=${doc_id} 结果: ${JSON.stringify(apiResult).substring(0, 200)}`);

          const hasErrors = apiResult && (apiResult.errors || apiResult.error);
          if (!hasErrors) {
            results.api = 'graphql_success';
            log('INFO', `[BSmart] ✅ 策略1 doc_id=${doc_id} 调用成功`);
            break;
          } else {
            log('WARN', `[BSmart] ⚠️ 策略1 doc_id=${doc_id} 失败`);
            results.api = 'graphql_failed';
          }
        }

        if (!results.api || results.api === 'graphql_failed') {
          log('WARN', `[BSmart] ⚠️ 策略1 所有 doc_id 均失败，使用 XUI 兜底`);
        }
      } else {
        log('WARN', `[BSmart] ⚠️ 策略1 未提取到 fbDtsg，跳过`);
        results.api = 'no_fbdtsg';
      }

      await new Promise(r => setTimeout(r, 2000));

    } catch (e) {
      log('WARN', `[BSmart] ❌ 策略1 异常: ${e.message}`);
      results.api = 'error:' + e.message;
    }
  }

  // ============================================================
  // 🏆 策略2（DOM 操作兜底）: XUI combobox 键盘搜索交互
  // ============================================================
  if (country && (!results.api || results.api === 'graphql_failed' || results.api === 'no_fbdtsg' || results.api === 'error')) {
    const BTN_EDIT = ['Editar', 'Edit', 'Modifier', 'Bearbeiten', 'Modifica', '编辑', '編集', '편집', 'แก้ไข', 'Chỉnh sửa', 'កែសម្រួល', 'Sunting', 'संपादित करें', 'Düzenle', 'تعديل', 'Редактировать', 'Bewerken', 'Edytuj', 'Redigera', 'Rediger', 'Muokkaa', 'Upravit', 'Editează', 'Szerkesztés', 'Επεξεργασία', 'ערוך', 'Editar'];
    const BTN_SAVE = ['Guardar', 'Salvar', 'Save', 'Enregistrer', 'Speichern', 'Salva', '保存', '保存', '저장', 'บันทึก', 'Lưu', 'រក្សាទុក', 'Simpan', 'सहेजें', 'Kaydet', 'حفظ', 'Сохранить', 'Opslaan', 'Zapisz', 'Spara', 'Gem', 'Tallenna', 'Uložit', 'Salvează', 'Mentés', 'Αποθήκευση', 'שמור'];
    const COUNTRY_LABELS = [/pa[íi]s/i, /pays/i, /country/i, /paese/i, /land/i, /negara/i, /ülke/i, /страна/i, /国/i, /ประเทศ/i, /quốc gia/i, /ប្រទេស/i, /देश/i, /بلد/i, /χώρα/i];
    const STATE_LABELS = [/estado/i, /[êe]tat/i, /state/i, /prov[ií]nc/i, /provin/i, /bundesland/i, /staat/i, /州/i, /省/i, /รัฐ/i, /tiểu bang/i, /negeri/i, /ولاية/i, /штат/i, /область/i];
    const CURRENCY_LABELS = [/moeda/i, /devise/i, /currency/i, /moneda/i, /valuta/i, /w[iü]hrung/i, /通貨/i, /通貨/i, /货币/i, /munten/i, /döviz/i, /валюта/i];
    const TIMEZONE_LABELS = [/fuso[-\s]?hor[áa]rio/i, /fuseau/i, /timezone/i, /time zone/i, /zona horaria/i, /zeitzone/i, /fuso orario/i, /タイムゾーン/i, /时区/i, /時差/i, /time zone/i];

    const detectedRaw = lang || await page.evaluate(() => {
      const htmlLang = (document.documentElement.lang || '').toLowerCase().slice(0, 2);
      if (htmlLang && ['pt','en','fr','es','de','it','nl','ja','ko','zh','th','vi','km','my','hi','ms','id','tr','ar','ru','pl'].includes(htmlLang)) return htmlLang;
      const body = (document.body && document.body.innerText || '');
      if (/pa[íi]s|região|estado|moeda|fuso/i.test(body)) return 'pt';
      if (/pays|région|état|devise|fuseau/i.test(body)) return 'fr';
      if (/pa[íi]s|región|estado|moneda|zona horaria/i.test(body)) return 'es';
      if (/country|state|currency|timezone|time zone/i.test(body)) return 'en';
      if (/国家|地区|货币|时区|州[^0-9a-zA-Z]|省[^0-9a-zA-Z]/i.test(body)) return 'zh';
      return '';
    });
    const detectedLang = (detectedRaw || '').replace(/_.*$/, '').slice(0, 2);
    log('INFO', `[BSmart] 策略2 检测语言: ${detectedLang || '未检测到，使用默认'}（原始: ${detectedRaw || '?'}）`);

    const COUNTRY_MAPS = {
      en: {
        'US': 'United States', 'AF': 'Afghanistan', 'AL': 'Albania', 'DE': 'Germany',
        'AD': 'Andorra', 'AO': 'Angola', 'AI': 'Anguilla', 'AQ': 'Antarctica',
        'AG': 'Antigua and Barbuda', 'SA': 'Saudi Arabia', 'DZ': 'Algeria', 'AR': 'Argentina',
        'AM': 'Armenia', 'AW': 'Aruba', 'AU': 'Australia', 'AT': 'Austria',
        'AZ': 'Azerbaijan', 'BS': 'Bahamas', 'BH': 'Bahrain', 'BD': 'Bangladesh',
        'BB': 'Barbados', 'BE': 'Belgium', 'BZ': 'Belize', 'BJ': 'Benin',
        'BM': 'Bermuda', 'BY': 'Belarus', 'BO': 'Bolivia', 'BA': 'Bosnia and Herzegovina',
        'BW': 'Botswana', 'BR': 'Brazil', 'BN': 'Brunei', 'BG': 'Bulgaria',
        'BF': 'Burkina Faso', 'BI': 'Burundi', 'BT': 'Bhutan', 'CV': 'Cape Verde',
        'CM': 'Cameroon', 'KH': 'Cambodia', 'CA': 'Canada', 'QA': 'Qatar',
        'KZ': 'Kazakhstan', 'TD': 'Chad', 'CL': 'Chile', 'CN': 'China',
        'CY': 'Cyprus', 'CO': 'Colombia', 'KM': 'Comoros', 'CG': 'Congo',
        'CD': 'Congo (DRC)', 'KP': 'North Korea', 'KR': 'South Korea', 'CR': 'Costa Rica',
        'CI': 'Côte d\'Ivoire', 'HR': 'Croatia', 'CU': 'Cuba', 'CW': 'Curaçao',
        'DK': 'Denmark', 'DJ': 'Djibouti', 'DM': 'Dominica', 'DO': 'Dominican Republic',
        'EC': 'Ecuador', 'EG': 'Egypt', 'SV': 'El Salvador', 'GQ': 'Equatorial Guinea',
        'ER': 'Eritrea', 'EE': 'Estonia', 'SZ': 'Eswatini', 'ET': 'Ethiopia',
        'FJ': 'Fiji', 'PH': 'Philippines', 'FI': 'Finland', 'FR': 'France',
        'GA': 'Gabon', 'GM': 'Gambia', 'GE': 'Georgia', 'GH': 'Ghana',
        'GI': 'Gibraltar', 'GR': 'Greece', 'GD': 'Grenada', 'GL': 'Greenland',
        'GP': 'Guadeloupe', 'GU': 'Guam', 'GT': 'Guatemala', 'GG': 'Guernsey',
        'GN': 'Guinea', 'GW': 'Guinea-Bissau', 'GY': 'Guyana', 'HT': 'Haiti',
        'HN': 'Honduras', 'HK': 'Hong Kong', 'HU': 'Hungary', 'IS': 'Iceland',
        'IN': 'India', 'ID': 'Indonesia', 'IR': 'Iran', 'IQ': 'Iraq',
        'IE': 'Ireland', 'IM': 'Isle of Man', 'IL': 'Israel', 'IT': 'Italy',
        'JM': 'Jamaica', 'JP': 'Japan', 'JE': 'Jersey', 'JO': 'Jordan',
        'KH': 'Cambodia', 'KM': 'Comoros', 'KW': 'Kuwait', 'KG': 'Kyrgyzstan',
        'LA': 'Laos', 'LV': 'Latvia', 'LB': 'Lebanon', 'LI': 'Liechtenstein',
        'LT': 'Lithuania', 'LU': 'Luxembourg', 'MO': 'Macau', 'MG': 'Madagascar',
        'MW': 'Malawi', 'MY': 'Malaysia', 'MV': 'Maldives', 'ML': 'Mali',
        'MT': 'Malta', 'MH': 'Marshall Islands', 'MQ': 'Martinique', 'MR': 'Mauritania',
        'MU': 'Mauritius', 'YT': 'Mayotte', 'MX': 'Mexico', 'FM': 'Micronesia',
        'MD': 'Moldova', 'MC': 'Monaco', 'MN': 'Mongolia', 'ME': 'Montenegro',
        'MS': 'Montserrat', 'MA': 'Morocco', 'MZ': 'Mozambique', 'MM': 'Myanmar',
        'NA': 'Namibia', 'NR': 'Nauru', 'NP': 'Nepal', 'NL': 'Netherlands',
        'NC': 'New Caledonia', 'NZ': 'New Zealand', 'NI': 'Nicaragua', 'NE': 'Niger',
        'NG': 'Nigeria', 'NO': 'Norway', 'OM': 'Oman', 'PK': 'Pakistan',
        'PW': 'Palau', 'PS': 'Palestine', 'PA': 'Panama', 'PG': 'Papua New Guinea',
        'PY': 'Paraguay', 'PE': 'Peru', 'PF': 'French Polynesia', 'PL': 'Poland',
        'PT': 'Portugal', 'PR': 'Puerto Rico', 'RE': 'Réunion', 'RO': 'Romania',
        'RU': 'Russia', 'RW': 'Rwanda', 'BL': 'Saint Barthélemy', 'KN': 'Saint Kitts and Nevis',
        'LC': 'Saint Lucia', 'MF': 'Saint Martin', 'PM': 'Saint Pierre and Miquelon',
        'VC': 'Saint Vincent and the Grenadines', 'WS': 'Samoa', 'SM': 'San Marino',
        'ST': 'São Tomé and Príncipe', 'SA': 'Saudi Arabia', 'SN': 'Senegal',
        'RS': 'Serbia', 'SC': 'Seychelles', 'SL': 'Sierra Leone', 'SG': 'Singapore',
        'SX': 'Sint Maarten', 'SK': 'Slovakia', 'SI': 'Slovenia', 'SB': 'Solomon Islands',
        'SO': 'Somalia', 'ZA': 'South Africa', 'SS': 'South Sudan', 'ES': 'Spain',
        'LK': 'Sri Lanka', 'SD': 'Sudan', 'SR': 'Suriname', 'SE': 'Sweden',
        'CH': 'Switzerland', 'SY': 'Syria', 'TW': 'Taiwan', 'TJ': 'Tajikistan',
        'TZ': 'Tanzania', 'TH': 'Thailand', 'TL': 'Timor-Leste', 'TG': 'Togo',
        'TO': 'Tonga', 'TT': 'Trinidad and Tobago', 'TN': 'Tunisia', 'TR': 'Turkey',
        'TM': 'Turkmenistan', 'TC': 'Turks and Caicos Islands', 'TV': 'Tuvalu',
        'UG': 'Uganda', 'UA': 'Ukraine', 'AE': 'United Arab Emirates',
        'GB': 'United Kingdom', 'UY': 'Uruguay', 'UZ': 'Uzbekistan', 'VU': 'Vanuatu',
        'VA': 'Vatican City', 'VE': 'Venezuela', 'VN': 'Vietnam', 'VG': 'Virgin Islands (British)',
        'VI': 'Virgin Islands (US)', 'YE': 'Yemen', 'ZM': 'Zambia', 'ZW': 'Zimbabwe'
      },
      pt: {
        'US': 'Estados Unidos', 'AF': 'Afeganistão', 'AL': 'Albânia', 'DE': 'Alemanha',
        'AD': 'Andorra', 'AO': 'Angola', 'AI': 'Anguila', 'AQ': 'Antártida',
        'AG': 'Antígua e Barbuda', 'SA': 'Arábia Saudita', 'DZ': 'Argélia', 'AR': 'Argentina',
        'AM': 'Armênia', 'AW': 'Aruba', 'AU': 'Austrália', 'AT': 'Áustria',
        'AZ': 'Azerbaijão', 'BS': 'Bahamas', 'BH': 'Bahrein', 'BD': 'Bangladesh',
        'BB': 'Barbados', 'BE': 'Bélgica', 'BZ': 'Belize', 'BJ': 'Benin',
        'BM': 'Bermudas', 'BY': 'Bielorrússia', 'BO': 'Bolívia', 'BA': 'Bósnia e Herzegovina',
        'BW': 'Botsuana', 'BR': 'Brasil', 'BN': 'Brunei', 'BG': 'Bulgária',
        'BF': 'Burquina Faso', 'BI': 'Burundi', 'BT': 'Butão', 'CV': 'Cabo Verde',
        'CM': 'Camarões', 'KH': 'Camboja', 'CA': 'Canadá', 'QA': 'Catar',
        'KZ': 'Cazaquistão', 'TD': 'Chade', 'CL': 'Chile', 'CN': 'China',
        'CY': 'Chipre', 'VA': 'Cidade do Vaticano', 'CO': 'Colômbia', 'KM': 'Comores',
        'CG': 'Congo', 'CD': 'Congo-Kinshasa', 'KR': 'Coreia do Sul', 'KP': 'Coreia do Norte',
        'CR': 'Costa Rica', 'CI': 'Costa do Marfim', 'HR': 'Croácia', 'CU': 'Cuba',
        'CW': 'Curaçao', 'DK': 'Dinamarca', 'DJ': 'Djibuti', 'DM': 'Dominica',
        'EG': 'Egito', 'SV': 'El Salvador', 'AE': 'Emirados Árabes Unidos',
        'EC': 'Equador', 'ER': 'Eritreia', 'SK': 'Eslováquia', 'SI': 'Eslovênia',
        'ES': 'Espanha', 'SZ': 'Essuatíni', 'EE': 'Estônia', 'ET': 'Etiópia',
        'FI': 'Finlândia', 'FJ': 'Fiji', 'PH': 'Filipinas', 'FR': 'França', 'GA': 'Gabão',
        'GM': 'Gâmbia', 'GH': 'Gana', 'GE': 'Geórgia', 'GI': 'Gibraltar', 'GD': 'Granada',
        'GR': 'Grécia', 'GL': 'Groenlândia', 'GP': 'Guadalupe', 'GU': 'Guão',
        'GT': 'Guatemala', 'GG': 'Guernsey', 'GY': 'Guiana', 'GF': 'Guiana Francesa',
        'GN': 'Guiné', 'GQ': 'Guiné Equatorial', 'GW': 'Guiné-Bissau',
        'HT': 'Haiti', 'NL': 'Países Baixos', 'HN': 'Honduras', 'HK': 'Hong Kong',
        'HU': 'Hungria', 'YE': 'Iêmen', 'KY': 'Ilhas Cayman', 'FK': 'Ilhas Malvinas',
        'FO': 'Ilhas Faroé', 'IN': 'Índia', 'ID': 'Indonésia', 'IR': 'Irã',
        'IQ': 'Iraque', 'IE': 'Irlanda', 'IS': 'Islândia', 'IL': 'Israel',
        'IT': 'Itália', 'JM': 'Jamaica', 'JP': 'Japão', 'JE': 'Jersey',
        'JO': 'Jordânia', 'KW': 'Kuwait', 'LA': 'Laos', 'LV': 'Letônia',
        'LB': 'Líbano', 'LR': 'Libéria', 'LY': 'Líbia', 'LI': 'Liechtenstein',
        'LT': 'Lituânia', 'LU': 'Luxemburgo', 'MO': 'Macau', 'MK': 'Macedônia do Norte',
        'MG': 'Madagascar', 'MY': 'Malásia', 'MW': 'Malaui', 'MV': 'Maldivas',
        'ML': 'Mali', 'MT': 'Malta', 'MA': 'Marrocos', 'MQ': 'Martinica',
        'MU': 'Maurício', 'MR': 'Mauritânia', 'YT': 'Mayotte', 'MX': 'México',
        'MM': 'Mianmar', 'FM': 'Micronésia', 'MZ': 'Moçambique', 'MD': 'Moldávia',
        'MC': 'Mônaco', 'MN': 'Mongólia', 'ME': 'Montenegro', 'MS': 'Montserrat',
        'NA': 'Namíbia', 'NR': 'Nauru', 'NP': 'Nepal', 'NI': 'Nicarágua',
        'NE': 'Níger', 'NG': 'Nigéria', 'NO': 'Noruega', 'NC': 'Nova Caledônia',
        'NZ': 'Nova Zelândia', 'OM': 'Omã', 'PW': 'Palau', 'PA': 'Panamá',
        'PG': 'Papua-Nova Guiné', 'PK': 'Paquistão', 'PY': 'Paraguai', 'PE': 'Peru',
        'PF': 'Polinésia Francesa', 'PL': 'Polônia', 'PR': 'Porto Rico', 'PT': 'Portugal',
        'KE': 'Quênia', 'KG': 'Quirguistão', 'KI': 'Quiribati', 'GB': 'Reino Unido',
        'CF': 'República Centro-Africana', 'DO': 'República Dominicana', 'CZ': 'República Tcheca',
        'RE': 'Reunião', 'RO': 'Romênia', 'RW': 'Ruanda', 'RU': 'Rússia',
        'EH': 'Saara Ocidental', 'WS': 'Samoa', 'AS': 'Samoa Americana', 'SM': 'San Marino',
        'SH': 'Santa Helena', 'LC': 'Santa Lúcia', 'BL': 'São Bartolomeu',
        'KN': 'São Cristóvão e Neves', 'MF': 'São Martinho', 'PM': 'São Pedro e Miquelão',
        'ST': 'São Tomé e Príncipe', 'VC': 'São Vicente e Granadinas', 'SC': 'Seychelles',
        'SL': 'Serra Leoa', 'RS': 'Sérvia', 'SG': 'Singapura', 'SX': 'São Martinho (Países Baixos)',
        'SY': 'Síria', 'SO': 'Somália', 'LK': 'Sri Lanka', 'SD': 'Sudão',
        'SS': 'Sudão do Sul', 'SE': 'Suécia', 'CH': 'Suíça', 'SR': 'Suriname',
        'TH': 'Tailândia', 'TW': 'Taiwan', 'TJ': 'Tajiquistão', 'TZ': 'Tanzânia',
        'IO': 'Território Britânico do Oceano Índico', 'TL': 'Timor-Leste', 'TG': 'Togo',
        'TK': 'Tokelau', 'TO': 'Tonga', 'TT': 'Trinidad e Tobago', 'TN': 'Tunísia',
        'TM': 'Turcomenistão', 'TR': 'Turquia', 'TV': 'Tuvalu', 'UA': 'Ucrânia',
        'UG': 'Uganda', 'UY': 'Uruguai', 'UZ': 'Uzbequistão', 'VU': 'Vanuatu',
        'VE': 'Venezuela', 'VN': 'Vietnã', 'VG': 'Ilhas Virgens Britânicas',
        'VI': 'Ilhas Virgens Americanas', 'ZM': 'Zâmbia', 'ZW': 'Zimbábue'
      },
      fr: {
        'US': 'États-Unis', 'AF': 'Afghanistan', 'AL': 'Albanie', 'DE': 'Allemagne',
        'AD': 'Andorre', 'AO': 'Angola', 'AI': 'Anguilla', 'AQ': 'Antarctique',
        'AG': 'Antigua-et-Barbuda', 'SA': 'Arabie saoudite', 'DZ': 'Algérie', 'AR': 'Argentine',
        'AM': 'Arménie', 'AW': 'Aruba', 'AU': 'Australie', 'AT': 'Autriche',
        'AZ': 'Azerbaïdjan', 'BS': 'Bahamas', 'BH': 'Bahreïn', 'BD': 'Bangladesh',
        'BB': 'Barbade', 'BE': 'Belgique', 'BZ': 'Belize', 'BJ': 'Bénin',
        'BM': 'Bermudes', 'BY': 'Biélorussie', 'BO': 'Bolivie', 'BA': 'Bosnie-Herzégovine',
        'BW': 'Botswana', 'BR': 'Brésil', 'BN': 'Brunei', 'BG': 'Bulgarie',
        'BF': 'Burkina Faso', 'BI': 'Burundi', 'BT': 'Bhoutan', 'CV': 'Cap-Vert',
        'CM': 'Cameroun', 'KH': 'Cambodge', 'CA': 'Canada', 'QA': 'Qatar',
        'KZ': 'Kazakhstan', 'TD': 'Tchad', 'CL': 'Chili', 'CN': 'Chine',
        'CY': 'Chypre', 'VA': 'Vatican', 'CO': 'Colombie', 'KM': 'Comores',
        'CG': 'Congo', 'CD': 'République démocratique du Congo', 'KR': 'Corée du Sud',
        'KP': 'Corée du Nord', 'CR': 'Costa Rica', 'CI': 'Côte d\'Ivoire', 'HR': 'Croatie',
        'CU': 'Cuba', 'CW': 'Curaçao', 'DK': 'Danemark', 'DJ': 'Djibouti', 'DM': 'Dominique',
        'EG': 'Égypte', 'SV': 'Salvador', 'AE': 'Émirats arabes unis', 'EC': 'Équateur',
        'ER': 'Érythrée', 'SK': 'Slovaquie', 'SI': 'Slovénie', 'ES': 'Espagne',
        'SZ': 'Eswatini', 'EE': 'Estonie', 'ET': 'Éthiopie', 'FI': 'Finlande',
        'FJ': 'Fidji', 'PH': 'Philippines', 'FR': 'France', 'GA': 'Gabon', 'GM': 'Gambie',
        'GH': 'Ghana', 'GE': 'Géorgie', 'GI': 'Gibraltar', 'GD': 'Grenade', 'GR': 'Grèce',
        'GL': 'Groenland', 'GP': 'Guadeloupe', 'GU': 'Guam', 'GT': 'Guatemala',
        'GG': 'Guernesey', 'GY': 'Guyana', 'GF': 'Guyane française', 'GN': 'Guinée',
        'GQ': 'Guinée équatoriale', 'GW': 'Guinée-Bissau', 'HT': 'Haïti', 'NL': 'Pays-Bas',
        'HN': 'Honduras', 'HK': 'Hong Kong', 'HU': 'Hongrie', 'YE': 'Yémen',
        'KY': 'Îles Caïmans', 'FK': 'Îles Malouines', 'FO': 'Îles Féroé', 'IN': 'Inde',
        'ID': 'Indonésie', 'IR': 'Iran', 'IQ': 'Irak', 'IE': 'Irlande', 'IS': 'Islande',
        'IL': 'Israël', 'IT': 'Italie', 'JM': 'Jamaïque', 'JP': 'Japon', 'JE': 'Jersey',
        'JO': 'Jordanie', 'KW': 'Koweït', 'LA': 'Laos', 'LS': 'Lesotho', 'LV': 'Lettonie',
        'LB': 'Liban', 'LR': 'Liberia', 'LY': 'Libye', 'LI': 'Liechtenstein', 'LT': 'Lituanie',
        'LU': 'Luxembourg', 'MO': 'Macao', 'MK': 'Macédoine du Nord', 'MG': 'Madagascar',
        'MY': 'Malaisie', 'MW': 'Malawi', 'MV': 'Maldives', 'ML': 'Mali', 'MT': 'Malte',
        'MA': 'Maroc', 'MQ': 'Martinique', 'MU': 'Maurice', 'MR': 'Mauritanie', 'YT': 'Mayotte',
        'MX': 'Mexique', 'MM': 'Birmanie', 'FM': 'Micronésie', 'MZ': 'Mozambique',
        'MD': 'Moldavie', 'MC': 'Monaco', 'MN': 'Mongolie', 'ME': 'Monténégro',
        'MS': 'Montserrat', 'NA': 'Namibie', 'NR': 'Nauru', 'NP': 'Népal', 'NI': 'Nicaragua',
        'NE': 'Niger', 'NG': 'Nigeria', 'NO': 'Norvège', 'NC': 'Nouvelle-Calédonie',
        'NZ': 'Nouvelle-Zélande', 'OM': 'Oman', 'PW': 'Palaos', 'PA': 'Panama',
        'PG': 'Papouasie-Nouvelle-Guinée', 'PK': 'Pakistan', 'PY': 'Paraguay', 'PE': 'Pérou',
        'PF': 'Polynésie française', 'PL': 'Pologne', 'PR': 'Porto Rico', 'PT': 'Portugal',
        'KE': 'Kenya', 'KG': 'Kirghizistan', 'KI': 'Kiribati', 'GB': 'Royaume-Uni',
        'CF': 'République centrafricaine', 'DO': 'République dominicaine', 'CZ': 'République tchèque',
        'RE': 'La Réunion', 'RO': 'Roumanie', 'RW': 'Rwanda', 'RU': 'Russie',
        'EH': 'Sahara occidental', 'WS': 'Samoa', 'AS': 'Samoa américaines', 'SM': 'Saint-Marin',
        'SH': 'Sainte-Hélène', 'LC': 'Sainte-Lucie', 'BL': 'Saint-Barthélemy',
        'KN': 'Saint-Christophe-et-Niévès', 'MF': 'Saint-Martin', 'PM': 'Saint-Pierre-et-Miquelon',
        'ST': 'Sao Tomé-et-Principe', 'VC': 'Saint-Vincent-et-les-Grenadines', 'SC': 'Seychelles',
        'SL': 'Sierra Leone', 'RS': 'Serbie', 'SG': 'Singapour', 'SX': 'Saint-Martin (Pays-Bas)',
        'SY': 'Syrie', 'SO': 'Somalie', 'LK': 'Sri Lanka', 'SD': 'Soudan',
        'SS': 'Soudan du Sud', 'SE': 'Suède', 'CH': 'Suisse', 'SR': 'Suriname',
        'TH': 'Thaïlande', 'TW': 'Taïwan', 'TJ': 'Tadjikistan', 'TZ': 'Tanzanie',
        'IO': 'Territoire britannique de l\'océan Indien', 'TL': 'Timor oriental', 'TG': 'Togo',
        'TK': 'Tokelau', 'TO': 'Tonga', 'TT': 'Trinité-et-Tobago', 'TN': 'Tunisie',
        'TM': 'Turkménistan', 'TR': 'Turquie', 'TV': 'Tuvalu', 'UA': 'Ukraine',
        'UG': 'Ouganda', 'UY': 'Uruguay', 'UZ': 'Ouzbékistan', 'VU': 'Vanuatu',
        'VE': 'Venezuela', 'VN': 'Vietnam', 'VG': 'Îles Vierges britanniques',
        'VI': 'Îles Vierges américaines', 'ZM': 'Zambie', 'ZW': 'Zimbabwe'
      },
      es: {
        'US': 'Estados Unidos', 'AF': 'Afganistán', 'AL': 'Albania', 'DE': 'Alemania',
        'AD': 'Andorra', 'AO': 'Angola', 'AI': 'Anguila', 'AQ': 'Antártida',
        'AG': 'Antigua y Barbuda', 'SA': 'Arabia Saudita', 'DZ': 'Argelia', 'AR': 'Argentina',
        'AM': 'Armenia', 'AW': 'Aruba', 'AU': 'Australia', 'AT': 'Austria',
        'AZ': 'Azerbaiyán', 'BS': 'Bahamas', 'BH': 'Baréin', 'BD': 'Bangladés',
        'BB': 'Barbados', 'BE': 'Bélgica', 'BZ': 'Belice', 'BJ': 'Benín',
        'BM': 'Bermudas', 'BY': 'Bielorrusia', 'BO': 'Bolivia', 'BA': 'Bosnia y Herzegovina',
        'BW': 'Botsuana', 'BR': 'Brasil', 'BN': 'Brunéi', 'BG': 'Bulgaria',
        'BF': 'Burkina Faso', 'BI': 'Burundi', 'BT': 'Bután', 'CV': 'Cabo Verde',
        'CM': 'Camerún', 'KH': 'Camboya', 'CA': 'Canadá', 'QA': 'Catar',
        'KZ': 'Kazajistán', 'TD': 'Chad', 'CL': 'Chile', 'CN': 'China',
        'CY': 'Chipre', 'VA': 'Ciudad del Vaticano', 'CO': 'Colombia', 'KM': 'Comoras',
        'CG': 'Congo', 'CD': 'República Democrática del Congo', 'KR': 'Corea del Sur',
        'KP': 'Corea del Norte', 'CR': 'Costa Rica', 'CI': 'Costa de Marfil', 'HR': 'Croacia',
        'CU': 'Cuba', 'CW': 'Curazao', 'DK': 'Dinamarca', 'DJ': 'Yibuti', 'DM': 'Dominica',
        'EG': 'Egipto', 'SV': 'El Salvador', 'AE': 'Emiratos Árabes Unidos', 'EC': 'Ecuador',
        'ER': 'Eritrea', 'SK': 'Eslovaquia', 'SI': 'Eslovenia', 'ES': 'España',
        'SZ': 'Esuatini', 'EE': 'Estonia', 'ET': 'Etiopía', 'FI': 'Finlandia',
        'FJ': 'Fiyi', 'PH': 'Filipinas', 'FR': 'Francia', 'GA': 'Gabón', 'GM': 'Gambia',
        'GH': 'Ghana', 'GE': 'Georgia', 'GI': 'Gibraltar', 'GD': 'Granada', 'GR': 'Grecia',
        'GL': 'Groenlandia', 'GP': 'Guadalupe', 'GU': 'Guam', 'GT': 'Guatemala',
        'GG': 'Guernsey', 'GY': 'Guyana', 'GF': 'Guyana Francesa', 'GN': 'Guinea',
        'GQ': 'Guinea Ecuatorial', 'GW': 'Guinea-Bisáu', 'HT': 'Haití', 'NL': 'Países Bajos',
        'HN': 'Honduras', 'HK': 'Hong Kong', 'HU': 'Hungría', 'YE': 'Yemen',
        'IN': 'India', 'ID': 'Indonesia', 'IR': 'Irán', 'IQ': 'Irak', 'IE': 'Irlanda',
        'IS': 'Islandia', 'IL': 'Israel', 'IT': 'Italia', 'JM': 'Jamaica', 'JP': 'Japón',
        'JE': 'Jersey', 'JO': 'Jordania', 'KW': 'Kuwait', 'LA': 'Laos', 'LS': 'Lesoto',
        'LV': 'Letonia', 'LB': 'Líbano', 'LR': 'Liberia', 'LY': 'Libia', 'LI': 'Liechtenstein',
        'LT': 'Lituania', 'LU': 'Luxemburgo', 'MO': 'Macao', 'MK': 'Macedonia del Norte',
        'MG': 'Madagascar', 'MY': 'Malasia', 'MW': 'Malaui', 'MV': 'Maldivas',
        'ML': 'Mali', 'MT': 'Malta', 'MA': 'Marruecos', 'MQ': 'Martinica',
        'MU': 'Mauricio', 'MR': 'Mauritania', 'YT': 'Mayotte', 'MX': 'México',
        'MM': 'Myanmar', 'FM': 'Micronesia', 'MZ': 'Mozambique', 'MD': 'Moldavia',
        'MC': 'Mónaco', 'MN': 'Mongolia', 'ME': 'Montenegro', 'MS': 'Montserrat',
        'NA': 'Namibia', 'NR': 'Nauru', 'NP': 'Nepal', 'NI': 'Nicaragua',
        'NE': 'Níger', 'NG': 'Nigeria', 'NO': 'Noruega', 'NC': 'Nueva Caledonia',
        'NZ': 'Nueva Zelanda', 'OM': 'Omán', 'PW': 'Palaos', 'PA': 'Panamá',
        'PG': 'Papúa Nueva Guinea', 'PK': 'Pakistán', 'PY': 'Paraguay', 'PE': 'Perú',
        'PF': 'Polinesia Francesa', 'PL': 'Polonia', 'PR': 'Puerto Rico', 'PT': 'Portugal',
        'KE': 'Kenia', 'KG': 'Kirguistán', 'KI': 'Kiribati', 'GB': 'Reino Unido',
        'CF': 'República Centroafricana', 'DO': 'República Dominicana', 'CZ': 'República Checa',
        'RE': 'Reunión', 'RO': 'Rumanía', 'RW': 'Ruanda', 'RU': 'Rusia',
        'EH': 'Sáhara Occidental', 'WS': 'Samoa', 'AS': 'Samoa Americana', 'SM': 'San Marino',
        'SH': 'Santa Elena', 'LC': 'Santa Lucía', 'BL': 'San Bartolomé',
        'KN': 'San Cristóbal y Nieves', 'MF': 'San Martín', 'PM': 'San Pedro y Miquelón',
        'ST': 'Santo Tomé y Príncipe', 'VC': 'San Vicente y las Granadinas', 'SC': 'Seychelles',
        'SL': 'Sierra Leona', 'RS': 'Serbia', 'SG': 'Singapur', 'SX': 'San Martín (Países Bajos)',
        'SY': 'Siria', 'SO': 'Somalia', 'LK': 'Sri Lanka', 'SD': 'Sudán',
        'SS': 'Sudán del Sur', 'SE': 'Suecia', 'CH': 'Suiza', 'SR': 'Surinam',
        'TH': 'Tailandia', 'TW': 'Taiwán', 'TJ': 'Tayikistán', 'TZ': 'Tanzania',
        'TL': 'Timor Oriental', 'TG': 'Togo', 'TK': 'Tokelau', 'TO': 'Tonga',
        'TT': 'Trinidad y Tobago', 'TN': 'Túnez', 'TM': 'Turkmenistán', 'TR': 'Turquía',
        'TV': 'Tuvalu', 'UA': 'Ucrania', 'UG': 'Uganda', 'UY': 'Uruguay',
        'UZ': 'Uzbekistán', 'VU': 'Vanuatu', 'VE': 'Venezuela', 'VN': 'Vietnam',
        'VG': 'Islas Vírgenes Británicas', 'VI': 'Islas Vírgenes Estadounidenses',
        'ZM': 'Zambia', 'ZW': 'Zimbabue'
      },
      it: { 'US': 'Stati Uniti', 'GB': 'Regno Unito', 'DE': 'Germania', 'FR': 'Francia', 'ES': 'Spagna', 'IT': 'Italia', 'BR': 'Brasile', 'AR': 'Argentina', 'JP': 'Giappone', 'CN': 'Cina', 'KR': 'Corea del Sud', 'IN': 'India', 'CA': 'Canada', 'AU': 'Australia', 'MX': 'Messico', 'RU': 'Russia', 'CH': 'Svizzera', 'NL': 'Paesi Bassi', 'SE': 'Svezia', 'NO': 'Norvegia', 'PT': 'Portogallo', 'TR': 'Turchia', 'AE': 'Emirati Arabi Uniti', 'SA': 'Arabia Saudita', 'IL': 'Israele', 'JP': 'Giappone' },
      de: { 'US': 'Vereinigte Staaten', 'GB': 'Vereinigtes Königreich', 'DE': 'Deutschland', 'FR': 'Frankreich', 'ES': 'Spanien', 'IT': 'Italien', 'BR': 'Brasilien', 'AR': 'Argentinien', 'JP': 'Japan', 'CN': 'China', 'KR': 'Südkorea', 'IN': 'Indien', 'CA': 'Kanada', 'AU': 'Australien', 'MX': 'Mexiko', 'RU': 'Russland', 'CH': 'Schweiz', 'NL': 'Niederlande', 'SE': 'Schweden', 'NO': 'Norwegen', 'PT': 'Portugal', 'TR': 'Türkei', 'AE': 'Vereinigte Arabische Emirate', 'SA': 'Saudi-Arabien', 'IL': 'Israel' },
      ja: { 'US': 'アメリカ合衆国', 'GB': 'イギリス', 'DE': 'ドイツ', 'FR': 'フランス', 'ES': 'スペイン', 'IT': 'イタリア', 'BR': 'ブラジル', 'JP': '日本', 'CN': '中国', 'KR': '韓国', 'IN': 'インド', 'CA': 'カナダ', 'AU': 'オーストラリア', 'RU': 'ロシア', 'CH': 'スイス', 'TH': 'タイ', 'VN': 'ベトナム', 'PH': 'フィリピン', 'MY': 'マレーシア', 'ID': 'インドネシア', 'AE': 'アラブ首長国連邦', 'TR': 'トルコ', 'SA': 'サウジアラビア' },
      ko: { 'US': '미국', 'GB': '영국', 'DE': '독일', 'FR': '프랑스', 'ES': '스페인', 'IT': '이탈리아', 'BR': '브라질', 'JP': '일본', 'CN': '중국', 'KR': '대한민국', 'IN': '인도', 'CA': '캐나다', 'AU': '호주', 'RU': '러시아', 'CH': '스위스', 'TH': '태국', 'VN': '베트남', 'PH': '필리핀', 'MY': '말레이시아', 'ID': '인도네시아', 'AE': '아랍에미리트', 'TR': '터키' },
      zh: { 'US': '美国', 'GB': '英国', 'DE': '德国', 'FR': '法国', 'ES': '西班牙', 'IT': '意大利', 'BR': '巴西', 'JP': '日本', 'CN': '中国', 'KR': '韩国', 'IN': '印度', 'CA': '加拿大', 'AU': '澳大利亚', 'RU': '俄罗斯', 'CH': '瑞士', 'TH': '泰国', 'VN': '越南', 'PH': '菲律宾', 'MY': '马来西亚', 'ID': '印度尼西亚', 'AE': '阿拉伯联合酋长国', 'TR': '土耳其', 'SA': '沙特阿拉伯', 'SG': '新加坡',
        'AF': '阿富汗', 'AL': '阿尔巴尼亚', 'DZ': '阿尔及利亚', 'AD': '安道尔', 'AO': '安哥拉', 'AI': '安圭拉',
        'AQ': '南极洲', 'AG': '安提瓜和巴布达', 'AR': '阿根廷', 'AM': '亚美尼亚', 'AW': '阿鲁巴',
        'AT': '奥地利', 'AZ': '阿塞拜疆', 'BS': '巴哈马', 'BH': '巴林', 'BD': '孟加拉国',
        'BB': '巴巴多斯', 'BY': '白俄罗斯', 'BE': '比利时', 'BZ': '伯利兹', 'BJ': '贝宁',
        'BM': '百慕大', 'BT': '不丹', 'BO': '玻利维亚', 'BA': '波斯尼亚和黑塞哥维那',
        'BW': '博茨瓦纳', 'BV': '布韦岛', 'BN': '文莱', 'BG': '保加利亚', 'BF': '布基纳法索',
        'BI': '布隆迪', 'CV': '佛得角', 'KH': '柬埔寨', 'CM': '喀麦隆', 'KY': '开曼群岛',
        'CF': '中非共和国', 'TD': '乍得', 'CL': '智利', 'CX': '圣诞岛', 'CC': '科科斯群岛',
        'CO': '哥伦比亚', 'KM': '科摩罗', 'CG': '刚果（布）', 'CD': '刚果（金）', 'CK': '库克群岛',
        'CR': '哥斯达黎加', 'CI': '科特迪瓦', 'HR': '克罗地亚', 'CU': '古巴', 'CW': '库拉索',
        'CY': '塞浦路斯', 'CZ': '捷克', 'DK': '丹麦', 'DJ': '吉布提', 'DM': '多米尼克',
        'DO': '多米尼加共和国', 'EC': '厄瓜多尔', 'EG': '埃及', 'SV': '萨尔瓦多',
        'GQ': '赤道几内亚', 'ER': '厄立特里亚', 'EE': '爱沙尼亚', 'SZ': '斯威士兰',
        'ET': '埃塞俄比亚', 'FK': '福克兰群岛', 'FO': '法罗群岛', 'FJ': '斐济',
        'FI': '芬兰', 'GF': '法属圭亚那', 'PF': '法属波利尼西亚', 'GA': '加蓬',
        'GM': '冈比亚', 'GE': '格鲁吉亚', 'GH': '加纳', 'GI': '直布罗陀',
        'GR': '希腊', 'GL': '格陵兰', 'GD': '格林纳达', 'GP': '瓜德罗普',
        'GU': '关岛', 'GT': '危地马拉', 'GG': '根西岛', 'GN': '几内亚',
        'GW': '几内亚比绍', 'GY': '圭亚那', 'HT': '海地', 'HM': '赫德岛和麦克唐纳群岛',
        'HN': '洪都拉斯', 'HK': '中国香港', 'HU': '匈牙利', 'IS': '冰岛',
        'IR': '伊朗', 'IQ': '伊拉克', 'IE': '爱尔兰', 'IM': '马恩岛',
        'IL': '以色列', 'JM': '牙买加', 'JE': '泽西岛', 'JO': '约旦',
        'KZ': '哈萨克斯坦', 'KE': '肯尼亚', 'KI': '基里巴斯', 'KW': '科威特',
        'KG': '吉尔吉斯斯坦', 'LA': '老挝', 'LV': '拉脱维亚', 'LB': '黎巴嫩',
        'LS': '莱索托', 'LR': '利比里亚', 'LY': '利比亚', 'LI': '列支敦士登',
        'LT': '立陶宛', 'LU': '卢森堡', 'MO': '中国澳门', 'MG': '马达加斯加',
        'MW': '马拉维', 'MV': '马尔代夫', 'ML': '马里', 'MT': '马耳他',
        'MH': '马绍尔群岛', 'MQ': '马提尼克', 'MR': '毛里塔尼亚', 'MU': '毛里求斯',
        'YT': '马约特', 'MX': '墨西哥', 'FM': '密克罗尼西亚', 'MD': '摩尔多瓦',
        'MC': '摩纳哥', 'MN': '蒙古', 'ME': '黑山', 'MS': '蒙特塞拉特',
        'MA': '摩洛哥', 'MZ': '莫桑比克', 'MM': '缅甸', 'NA': '纳米比亚',
        'NR': '瑙鲁', 'NP': '尼泊尔', 'NL': '荷兰', 'NC': '新喀里多尼亚',
        'NZ': '新西兰', 'NI': '尼加拉瓜', 'NE': '尼日尔', 'NG': '尼日利亚',
        'NU': '纽埃', 'NF': '诺福克岛', 'KP': '朝鲜', 'MK': '北马其顿',
        'MP': '北马里亚纳群岛', 'NO': '挪威', 'OM': '阿曼', 'PK': '巴基斯坦',
        'PW': '帕劳', 'PS': '巴勒斯坦', 'PA': '巴拿马', 'PG': '巴布亚新几内亚',
        'PY': '巴拉圭', 'PE': '秘鲁', 'PN': '皮特凯恩群岛', 'PL': '波兰',
        'PT': '葡萄牙', 'PR': '波多黎各', 'QA': '卡塔尔', 'RE': '留尼汪',
        'RO': '罗马尼亚', 'RW': '卢旺达', 'BL': '圣巴泰勒米', 'SH': '圣赫勒拿',
        'KN': '圣基茨和尼维斯', 'LC': '圣卢西亚', 'MF': '圣马丁', 'PM': '圣皮埃尔和密克隆',
        'VC': '圣文森特和格林纳丁斯', 'WS': '萨摩亚', 'SM': '圣马力诺',
        'ST': '圣多美和普林西比', 'SN': '塞内加尔', 'RS': '塞尔维亚',
        'SC': '塞舌尔', 'SL': '塞拉利昂', 'SX': '荷属圣马丁',
        'SK': '斯洛伐克', 'SI': '斯洛文尼亚', 'SB': '所罗门群岛',
        'SO': '索马里', 'ZA': '南非', 'GS': '南乔治亚和南桑威奇群岛',
        'SS': '南苏丹', 'LK': '斯里兰卡', 'SD': '苏丹', 'SR': '苏里南',
        'SJ': '斯瓦尔巴和扬马延', 'SE': '瑞典', 'SY': '叙利亚',
        'TW': '中国台湾', 'TJ': '塔吉克斯坦', 'TZ': '坦桑尼亚',
        'TL': '东帝汶', 'TG': '多哥', 'TK': '托克劳', 'TO': '汤加',
        'TT': '特立尼达和多巴哥', 'TN': '突尼斯', 'TM': '土库曼斯坦',
        'TC': '特克斯和凯科斯群岛', 'TV': '图瓦卢', 'UG': '乌干达',
        'UA': '乌克兰', 'UY': '乌拉圭', 'UZ': '乌兹别克斯坦',
        'VU': '瓦努阿图', 'VA': '梵蒂冈', 'VE': '委内瑞拉',
        'VG': '英属维尔京群岛', 'VI': '美属维尔京群岛', 'WF': '瓦利斯和富图纳',
        'EH': '西撒哈拉', 'YE': '也门', 'ZM': '赞比亚', 'ZW': '津巴布韦',
        'AX': '奥兰群岛' },
      th: { 'US': 'สหรัฐอเมริกา', 'GB': 'สหราชอาณาจักร', 'DE': 'เยอรมนี', 'FR': 'ฝรั่งเศส', 'JP': 'ญี่ปุ่น', 'CN': 'จีน', 'KR': 'เกาหลีใต้', 'IN': 'อินเดีย', 'TH': 'ไทย', 'VN': 'เวียดนาม', 'MY': 'มาเลเซีย', 'ID': 'อินโดนีเซีย', 'KH': 'กัมพูชา', 'MM': 'พม่า', 'LA': 'ลาว', 'AE': 'สหรัฐอาหรับเอมิเรตส์', 'SG': 'สิงคโปร์', 'PH': 'ฟิลิปปินส์' },
      vi: { 'US': 'Hoa Kỳ', 'GB': 'Vương quốc Anh', 'DE': 'Đức', 'FR': 'Pháp', 'JP': 'Nhật Bản', 'CN': 'Trung Quốc', 'KR': 'Hàn Quốc', 'IN': 'Ấn Độ', 'TH': 'Thái Lan', 'VN': 'Việt Nam', 'MY': 'Malaysia', 'ID': 'Indonesia', 'KH': 'Campuchia', 'MM': 'Myanmar', 'LA': 'Lào', 'AE': 'Các Tiểu vương quốc Ả Rập Thống nhất', 'SG': 'Singapore', 'PH': 'Philippines' },
      ms: { 'US': 'Amerika Syarikat', 'GB': 'United Kingdom', 'DE': 'Jerman', 'FR': 'Perancis', 'JP': 'Jepun', 'CN': 'China', 'KR': 'Korea Selatan', 'IN': 'India', 'TH': 'Thailand', 'VN': 'Vietnam', 'MY': 'Malaysia', 'ID': 'Indonesia', 'AE': 'Emiriah Arab Bersatu', 'SG': 'Singapura', 'PH': 'Filipina' },
      id: { 'US': 'Amerika Serikat', 'GB': 'Inggris', 'DE': 'Jerman', 'FR': 'Perancis', 'JP': 'Jepang', 'CN': 'Cina', 'KR': 'Korea Selatan', 'IN': 'India', 'TH': 'Thailand', 'VN': 'Vietnam', 'MY': 'Malaysia', 'ID': 'Indonesia', 'AE': 'Uni Emirat Arab', 'SG': 'Singapura', 'PH': 'Filipina' },
      tr: { 'US': 'Amerika Birleşik Devletleri', 'GB': 'Birleşik Krallık', 'DE': 'Almanya', 'FR': 'Fransa', 'JP': 'Japonya', 'CN': 'Çin', 'KR': 'Güney Kore', 'IN': 'Hindistan', 'TH': 'Tayland', 'AE': 'Birleşik Arap Emirlikleri', 'RU': 'Rusya', 'SA': 'Suudi Arabistan' },
      ar: { 'US': 'الولايات المتحدة', 'GB': 'المملكة المتحدة', 'DE': 'ألمانيا', 'FR': 'فرنسا', 'JP': 'اليابان', 'CN': 'الصين', 'KR': 'كوريا الجنوبية', 'IN': 'الهند', 'AE': 'الإمارات العربية المتحدة', 'SA': 'المملكة العربية السعودية', 'TR': 'تركيا', 'RU': 'روسيا' },
      ru: { 'US': 'Соединенные Штаты', 'GB': 'Великобритания', 'DE': 'Германия', 'FR': 'Франция', 'JP': 'Япония', 'CN': 'Китай', 'KR': 'Южная Корея', 'IN': 'Индия', 'TH': 'Таиланд', 'AE': 'Объединенные Арабские Эмираты', 'TR': 'Турция', 'RU': 'Россия', 'SA': 'Саудовская Аравия' },
      nl: { 'US': 'Verenigde Staten', 'GB': 'Verenigd Koninkrijk', 'DE': 'Duitsland', 'FR': 'Frankrijk', 'ES': 'Spanje', 'IT': 'Italië', 'JP': 'Japan', 'CN': 'China', 'KR': 'Zuid-Korea', 'AE': 'Verenigde Arabische Emiraten' },
      pl: { 'US': 'Stany Zjednoczone', 'GB': 'Wielka Brytania', 'DE': 'Niemcy', 'FR': 'Francja', 'JP': 'Japonia', 'CN': 'Chiny', 'KR': 'Korea Południowa', 'AE': 'Zjednoczone Emiraty Arabskie', 'RU': 'Rosja' },
      zh: {
        'US': '美国', 'GB': '英国', 'CA': '加拿大', 'AU': '澳大利亚', 'DE': '德国', 'FR': '法国',
        'IT': '意大利', 'ES': '西班牙', 'NL': '荷兰', 'CH': '瑞士', 'SE': '瑞典', 'NO': '挪威',
        'DK': '丹麦', 'JP': '日本', 'SG': '新加坡', 'HK': '香港', 'TW': '台湾', 'KR': '韩国',
        'IN': '印度', 'BR': '巴西', 'MX': '墨西哥', 'RU': '俄罗斯', 'ZA': '南非', 'AE': '阿联酋',
        'SA': '沙特阿拉伯', 'IL': '以色列', 'TR': '土耳其', 'PL': '波兰', 'CZ': '捷克', 'HU': '匈牙利',
        'RO': '罗马尼亚', 'BG': '保加利亚', 'UA': '乌克兰', 'GR': '希腊', 'PT': '葡萄牙', 'IE': '爱尔兰',
        'NZ': '新西兰', 'AR': '阿根廷', 'CL': '智利', 'CO': '哥伦比亚', 'PE': '秘鲁', 'VE': '委内瑞拉',
        'MY': '马来西亚', 'ID': '印度尼西亚', 'TH': '泰国', 'VN': '越南', 'PH': '菲律宾', 'EG': '埃及',
        'NG': '尼日利亚', 'KE': '肯尼亚', 'PK': '巴基斯坦', 'BD': '孟加拉国', 'LK': '斯里兰卡'
      }
    };

    let ccode = (country || 'US').toUpperCase();
    if (ccode === 'UK') ccode = 'GB';
    const searchCandidates = [];
    if (detectedLang && COUNTRY_MAPS[detectedLang]?.[ccode]) {
      searchCandidates.push(COUNTRY_MAPS[detectedLang][ccode]);
    }
    const withAccent = searchCandidates[0];
    if (withAccent) {
      const noAccent = withAccent.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (noAccent !== withAccent) searchCandidates.push(noAccent);
    }
    if (COUNTRY_MAPS.pt?.[ccode] && !searchCandidates.includes(COUNTRY_MAPS.pt[ccode])) {
      searchCandidates.push(COUNTRY_MAPS.pt[ccode]);
    }
    if (ccode === 'US' && detectedLang === 'en') {
      if (!searchCandidates.includes('United States of America')) searchCandidates.push('United States of America');
    }
    if (ccode === 'US' && detectedLang === 'pt') {
      const fullPT = 'Estados Unidos da América';
      if (!searchCandidates.includes(fullPT)) searchCandidates.push(fullPT);
    }
    if (ccode === 'US' && detectedLang === 'zh') {
      if (!searchCandidates.includes('美国')) searchCandidates.push('美国');
    }
    if (searchCandidates.length === 0) searchCandidates.push(ccode);

    log('INFO', `[BSmart] 策略2 检测语言=${detectedLang || '?'} → 国家搜索: ${searchCandidates.join(' → ')}`);

    try {
      const editClicked = await page.evaluate((editArr) => {
        const btns = document.querySelectorAll('div[role=button]');
        for (const b of btns) {
          const txt = (b.textContent || '').trim();
          if (editArr.includes(txt)) {
            b.click();
            return 'clicked:' + txt;
          }
        }
        return 'not_found';
      }, BTN_EDIT);
      log('INFO', `[BSmart] 策略2 Editar 点击: ${editClicked}`);
      await new Promise(r => setTimeout(r, 3000));

      const comboFound = await page.evaluate(() => {
        return new Promise((resolve) => {
          let waited = 0;
          const interval = setInterval(() => {
            const combos = document.querySelectorAll('[role=combobox]');
            for (const c of combos) {
              const txt = (c.textContent || '').trim();
              if (txt.includes('País') || txt.includes('país') || txt.includes('Pays') || txt.includes('pays') || txt.includes('região') || txt.includes('région') ||
                  txt.includes('Country') || txt.includes('country') || txt.includes('国家') || txt.includes('地区') ||
                  txt.includes('Land') || txt.includes('Staat') || txt.includes('paese') || txt.includes('país') ||
                  txt.includes('negara') || txt.includes('ülke') || txt.includes('страна') ||
                  txt.includes('ประเทศ') || txt.includes('quốc gia') || txt.includes('ប្រទេស') ||
                  txt.includes('देश') || txt.includes('بلد') || txt.includes('χώρα') ||
                  txt.includes('나라') || txt.includes('国') || txt.includes('ประเทศ')) {
                const r = c.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  clearInterval(interval);
                  resolve({ id: c.id, x: r.x, y: r.y, w: r.width, h: r.height });
                  return;
                }
              }
            }
            waited += 500;
            if (waited >= 15000) {
              clearInterval(interval);
              resolve(null);
            }
          }, 500);
        });
      });

      if (comboFound && comboFound.w > 0) {
        // ... XUI interaction logic ...
        log('INFO', `[BSmart] 策略2 找到国家组合框: ${JSON.stringify(comboFound)}`);
        await page.mouse.click(comboFound.x + 50, comboFound.y + comboFound.h / 2);
        await new Promise(r => setTimeout(r, 800));

        const activeId = await page.evaluate(() => {
          const el = document.activeElement;
          return el ? (el.id || el.getAttribute('role') || el.tagName) : 'none';
        });
        log('INFO', `[BSmart] 策略2 焦点元素: ${activeId}`);

        const getCountryText = () => page.evaluate(() => {
          for (const c of document.querySelectorAll('[role=combobox]')) {
            const txt = (c.textContent || '').trim().toLowerCase();
            for (const p of [/pa[íi]s/i, /pays/i, /country/i, /paese/i, /land/i, /negara/i, /ülke/i, /страна/i, /国/i, /ประเทศ/i, /quốc gia/i, /ប្រទេស/i, /देश/i, /بلد/i, /χώρα/i]) {
              if (p.test(txt)) return (c.textContent || '').trim();
            }
          }
          return '';
        });

        const originalCountryText = await getCountryText();
        log('INFO', `[BSmart] 策略2 搜索前国家文本: ${originalCountryText}`);

        const selectCountry = async (searchName) => {
          await page.mouse.click(comboFound.x + comboFound.w / 2, comboFound.y + comboFound.h / 2);
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 400));
          await page.keyboard.type(searchName, { delay: 30 });
          await new Promise(r => setTimeout(r, 1500));

          const selected = await page.evaluate((sn) => {
            const input = document.querySelector('[role=combobox] input, [role=combobox] [contenteditable], [role=textbox] input');
            if (!input) return false;
            try {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(input, sn);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              }
            } catch {}
            return false;
          }, searchName);

          if (selected) {
            log('INFO', `[BSmart] 策略2 NativeInputValueSetter 设置 "${searchName}"`);
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('ArrowDown');
            await new Promise(r => setTimeout(r, 200));
            await page.keyboard.press('ArrowDown');
            await new Promise(r => setTimeout(r, 200));
            await page.keyboard.press('ArrowDown');
            await new Promise(r => setTimeout(r, 200));
            await page.keyboard.press('ArrowDown');
            await new Promise(r => setTimeout(r, 200));
            await page.keyboard.press('Tab');
            await new Promise(r => setTimeout(r, 1000));
            return true;
          }

          log('WARN', `[BSmart] 策略2 NativeInputValueSetter 失败，键盘输入兜底`);
          await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 400));
          await page.keyboard.type(searchName, { delay: 25 });
          await new Promise(r => setTimeout(r, 1500));
          for (let i = 0; i < 30; i++) { await page.keyboard.press('ArrowDown'); await new Promise(r => setTimeout(r, 100)); }
          await page.keyboard.press('Tab');
          await new Promise(r => setTimeout(r, 1000));
          return false;
        };

        let countryMatched = false;

        if (detectedLang === 'en' && ccode === 'US') {
          log('INFO', `[BSmart] 策略2 英语+US 特殊模式，尝试输入 U + ArrowDown×7...`);
          await page.mouse.click(comboFound.x + comboFound.w / 2, comboFound.y + comboFound.h / 2);
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 400));
          await page.keyboard.type('U', { delay: 50 });
          await new Promise(r => setTimeout(r, 1500));
          for (let i = 0; i < 7; i++) {
            await page.keyboard.press('ArrowDown');
            await new Promise(r => setTimeout(r, 150));
          }
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 1500));
          const usText = await getCountryText();
          if (usText && (usText.toLowerCase().includes('united states') || usText !== originalCountryText)) {
            countryMatched = true;
            log('INFO', `[BSmart] 策略2 英语+US特殊模式 命中: ${usText}`);
            results.dsl = 'selected_us_via_u:' + usText;
          } else {
            log('WARN', `[BSmart] 策略2 英语+US特殊模式 未命中，回退到全名搜索`);
          }
        }

        if (!countryMatched) {
          for (let ci = 0; ci < searchCandidates.length; ci++) {
            const searchName = searchCandidates[ci];
            log('INFO', `[BSmart] 策略2 尝试国家搜索[${ci+1}/${searchCandidates.length}]: ${searchName}`);
            await selectCountry(searchName);
            const newText = await getCountryText();
            const diff = newText !== originalCountryText;
            const containsSearch = newText.toLowerCase().includes(searchName.toLowerCase());
            if (diff && containsSearch) {
              countryMatched = true;
              log('INFO', `[BSmart] 策略2 国家搜索[${ci+1}] 命中: ${newText}`);
              break;
            }
            log('WARN', `[BSmart] 策略2 国家搜索[${ci+1}] 未命中，继续尝试`);
          }
        }

        const finalCountryText = await getCountryText();
        results.dsl = 'selected:' + (finalCountryText || originalCountryText);

        await page.mouse.click(1, 1);
        await new Promise(r => setTimeout(r, 500));

        const fieldsFilled = [];

        if (address) {
          const addrOk = await page.evaluate((addr) => {
            const allInputs = document.querySelectorAll('input:not([type="hidden"]), textarea');
            for (const inp of allInputs) {
              const r = inp.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              let ph = (inp.placeholder || '').trim().toLowerCase();
              let al = (inp.getAttribute('aria-label') || '').trim().toLowerCase();
              const lb = inp.getAttribute('aria-labelledby');
              if (lb) {
                const labelEl = document.getElementById(lb);
                if (labelEl) {
                  const lt = (labelEl.textContent || '').trim().toLowerCase();
                  if (lt.includes('endereço') || lt.includes('address') || lt === 'endereço') al = 'endereço';
                }
              }
              if (!ph && !al) {
                const parent = inp.closest('[class*="x"], [class*="ui"], [class*="form"], div');
                if (parent) {
                  const prevSib = inp.previousElementSibling;
                  if (prevSib) {
                    const psText = (prevSib.textContent || '').trim().toLowerCase();
                    if (psText.includes('endereço') || psText.includes('address') || psText.includes('street')) {
                      al = 'endereço';
                    }
                  }
                  const labels = parent.querySelectorAll('span, label, div[class*="label"]');
                  for (const lbl of labels) {
                    const lt = (lbl.textContent || '').trim().toLowerCase();
                    if (lt === 'endereço' || lt === 'endereço da empresa' || lt.includes('endereço') || lt === 'address' || lt.startsWith('address')) {
                      al = 'endereço';
                      break;
                    }
                  }
                }
              }
              if (ph.startsWith('endereço') || ph.startsWith('address') || ph.startsWith('street') ||
                  al.includes('endereço') || al === 'address' || al.startsWith('address')) {
                const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                s.call(inp, addr);
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
            const visibleInputs = [];
            for (const inp of document.querySelectorAll('input:not([type="hidden"])')) {
              const r = inp.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.top > 50) visibleInputs.push(inp);
            }
            if (visibleInputs.length >= 3) {
              let addrInput = null;
              for (let i = 0; i < visibleInputs.length; i++) {
                const inp = visibleInputs[i];
                const ph = (inp.placeholder || '').trim().toLowerCase();
                if (!ph && !inp.getAttribute('aria-label') && !inp.value) {
                  if (i >= 1) { addrInput = inp; break; }
                }
              }
              if (!addrInput && visibleInputs.length >= 3) addrInput = visibleInputs[visibleInputs.length - 3];
              if (addrInput) {
                const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                s.call(addrInput, addr);
                addrInput.dispatchEvent(new Event('input', { bubbles: true }));
                addrInput.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
            return false;
          }, address);
          log('INFO', `[BSmart] 策略2 地址填写: ${addrOk}`);
          if (addrOk) fieldsFilled.push('addr');
        }

        if (city) {
          const cityInfo = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea');
            for (const inp of inputs) {
              const r = inp.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const ph = (inp.placeholder || '').trim().toLowerCase();
              const al = (inp.getAttribute('aria-label') || '').trim().toLowerCase();
              const nm = (inp.name || '').toLowerCase();
              if (ph === 'cidade' || ph.startsWith('cidade') || ph === 'city' || ph.startsWith('city') ||
                  al === 'cidade' || al.startsWith('cidade') || al === 'city' || al.startsWith('city') ||
                  nm === 'cidade' || nm === 'city') {
                return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, id: inp.id || '' };
              }
            }
            return null;
          });
          if (cityInfo && cityInfo.w > 0) {
            log('INFO', `[BSmart] 策略2 城市输入框: id=${cityInfo.id}`);
            await page.mouse.click(cityInfo.x, cityInfo.y);
            await new Promise(r => setTimeout(r, 300));
            await page.mouse.click(cityInfo.x, cityInfo.y);
            await new Promise(r => setTimeout(r, 150));
            await page.mouse.click(cityInfo.x, cityInfo.y);
            await new Promise(r => setTimeout(r, 200));
            await page.keyboard.press('Delete');
            await new Promise(r => setTimeout(r, 300));
            await page.keyboard.type(city, { delay: 80 });
            await new Promise(r => setTimeout(r, 3500));
            await page.evaluate(({ inpId, val, x, y }) => {
              let inp = null;
              if (inpId) inp = document.getElementById(inpId);
              if (!inp) {
                const all = document.querySelectorAll('input:not([type="hidden"])');
                for (const i of all) {
                  const r = i.getBoundingClientRect();
                  if (Math.abs(r.x + r.width/2 - x) < 20 && Math.abs(r.y + r.height/2 - y) < 20) {
                    inp = i; break;
                  }
                }
              }
              if (inp) {
                const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                s.call(inp, val);
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                inp.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
              }
            }, { inpId: cityInfo.id, val: city, x: cityInfo.x, y: cityInfo.y });
            await new Promise(r => setTimeout(r, 500));
            fieldsFilled.push('city');
          } else {
            log('WARN', `[BSmart] 策略2 未找到城市输入框`);
          }
        }

        {
          const estadoResult = await page.evaluate(() => {
            const combos = document.querySelectorAll('[role=combobox]');
            for (const c of combos) {
              const r = c.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0 || r.top < 0) continue;
              const txt = (c.textContent || '').trim().toLowerCase();
              if (txt.includes('país') || txt.includes('pays') || txt.includes('moeda') || txt.includes('devise') || txt.includes('fuso') || txt.includes('fuseau')) continue;
              if ((txt === 'estado' || txt.startsWith('estado') && !txt.includes('estados')) ||
                  txt === 'état' || txt.startsWith('état') ||
                  txt === 'state' || txt.startsWith('provín') || txt.startsWith('provin')) {
                return { id: c.id, text: (c.textContent || '').trim().substring(0, 40), top: r.top, x: r.x, y: r.y, w: r.width, h: r.height };
              }
            }
            const visible = [];
            for (const c of combos) {
              const r = c.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0 || r.top < 0) continue;
              visible.push({ id: c.id, text: (c.textContent || '').trim().substring(0, 40), top: r.top, x: r.x, y: r.y, w: r.width, h: r.height });
            }
            visible.sort((a, b) => a.top - b.top);
            for (let i = 3; i < visible.length; i++) {
              const v = visible[i];
              if (v.top > 400) return { type: 'pos_' + (i+1), ...v };
            }
            return null;
          });

          if (estadoResult) {
            log('INFO', `[BSmart] 策略2 找到 Estado combobox`);
            await page.mouse.click(estadoResult.x + estadoResult.w / 2, estadoResult.y + estadoResult.h / 2);
            await new Promise(r => setTimeout(r, 1500));
            await page.keyboard.press('ArrowDown');
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 1000));
            fieldsFilled.push('estado');
          } else {
            log('WARN', `[BSmart] 策略2 未找到 Estado combobox`);
          }
        }

        if (zip) {
          const zipResult = await page.evaluate((zp) => {
            const vis = [];
            for (const inp of document.querySelectorAll('input:not([type="hidden"])')) {
              const r = inp.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0 || r.top < 50 || inp.readOnly) continue;
              vis.push({ el: inp, top: r.top, val: inp.value });
            }
            vis.sort((a, b) => a.top - b.top);
            for (let i = vis.length - 1; i >= 0; i--) {
              if (!vis[i].val) {
                const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                s.call(vis[i].el, zp);
                vis[i].el.dispatchEvent(new Event('input', { bubbles: true }));
                vis[i].el.dispatchEvent(new Event('change', { bubbles: true }));
                vis[i].el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
                return 'filled:' + zp + '@pos' + i;
              }
            }
            return 'no_empty';
          }, zip);
          log('INFO', `[BSmart] 策略2 CEP 填写: ${zipResult}`);
          if (zipResult && zipResult !== 'no_empty') fieldsFilled.push('zip');
        }

        log('INFO', `[BSmart] 策略2 地址字段填写: ${JSON.stringify(fieldsFilled)}`);
        await new Promise(r => setTimeout(r, 800));

        const saveClicked = await page.evaluate((saveArr) => {
          const btns1 = document.querySelectorAll('[role=button], button');
          for (const b of btns1) {
            const txt = (b.textContent || '').trim();
            if (saveArr.includes(txt)) {
              try { b.click(); return 'clicked:' + txt; } catch {}
            }
          }
          for (const b of document.querySelectorAll('[role=button], button, div[role=button]')) {
            const txt = (b.textContent || '').trim();
            for (const s of saveArr) {
              if (txt.includes(s) || txt.toLowerCase().includes(s.toLowerCase())) {
                try { b.click(); return 'clicked_fuzzy:' + s; } catch {}
              }
            }
          }
          for (const sel of ['span', 'div', 'a']) {
            for (const el of document.querySelectorAll(sel)) {
              const txt = (el.textContent || '').trim();
              const isClickable = el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.getAttribute('role') === 'button' || el.tagName === 'A' || el.classList.contains('x1n2onr6');
              if (!isClickable) continue;
              for (const s of saveArr) {
                if (txt.includes(s) || txt.toLowerCase().includes(s.toLowerCase())) {
                  try { el.click(); return 'clicked_deep:' + s; } catch {}
                }
              }
            }
          }
          return 'not_found';
        }, BTN_SAVE);
        log('INFO', `[BSmart] 策略2 Salvar 点击: ${saveClicked}`);
        await new Promise(r => setTimeout(r, 4000));

        const saveVerified = await page.evaluate((editArr) => {
          for (const b of document.querySelectorAll('[role=button], button, span, div, a')) {
            const txt = (b.textContent || '').trim();
            for (const e of editArr) {
              if (txt.includes(e) || txt.toLowerCase().includes(e.toLowerCase())) {
                const r = b.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return 'verified:' + txt;
              }
            }
          }
          return 'not_found';
        }, BTN_EDIT);
        if (saveVerified && saveVerified.startsWith('verified:')) {
          log('INFO', `[BSmart] 策略2 保存已验证: ${saveVerified}`);
          results.form = 'saved_and_verified';
        } else {
          log('WARN', `[BSmart] 策略2 保存后未检测到 Editar 按钮，重试...`);
          const retryClick = await page.evaluate((saveArr) => {
            for (const b of document.querySelectorAll('[role=button], button, span, div, a')) {
              const txt = (b.textContent || '').trim();
              for (const s of saveArr) {
                if (txt.includes(s) || txt.toLowerCase().includes(s.toLowerCase())) {
                  const r = b.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) { try { b.click(); return 'retry_clicked:' + s; } catch {} }
                }
              }
            }
            return 'retry_not_found';
          }, BTN_SAVE);
          log('INFO', `[BSmart] 策略2 重试点击: ${retryClick}`);
          await new Promise(r => setTimeout(r, 3000));
          if (retryClick.startsWith('retry_clicked:')) results.form = 'saved_retry';
        }
      } else {
        log('WARN', `[BSmart] 策略2 未找到国家组合框`);
        results.dsl = 'no_combobox_found';
      }
    } catch (e) {
      log('WARN', `[BSmart] 策略2 异常: ${e.message}`);
      results.dsl = 'error:' + e.message;
    }
  }

  const strategy2Saved = results.dsl && typeof results.dsl === 'string' && results.dsl.includes('selected:');

  if (!strategy2Saved) {
    if (address || city || zip || country) {
      try {
        const cleanId = String(actId).replace('act_', '');
        await page.goto(`https://www.facebook.com/ads/manager/accounts/settings?act=${cleanId}`, {
          waitUntil: 'domcontentloaded', timeout: 8000
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));

        const fillResult = await page.evaluate(async (formData) => {
          return new Promise((resolve) => {
          const { fc, faddr, fcity, fzip } = formData;
          function doFill() {
            const filled = [];
            if (fc) {
              const el = document.querySelector('select[name="country"]');
              if (el) {
                const opts = Array.from(el.options);
                const m = opts.find(o => o.value.toUpperCase() === fc);
                if (m) { el.value = m.value; el.dispatchEvent(new Event('change', { bubbles: true })); filled.push('country'); }
                else if (opts.length > 0) { el.selectedIndex = 0; el.dispatchEvent(new Event('change', { bubbles: true })); filled.push('country_def'); }
              }
            }
            if (faddr) {
              for (const s of ['input[name="business_address"]','input[placeholder*="address" i]','input[aria-label*="address" i]','input[name="address"]','textarea[name="address"]']) {
                const e = document.querySelector(s); if (e) { e.value = faddr; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); filled.push('addr'); break; }
              }
            }
            if (fcity) {
              for (const s of ['input[name="city"]','input[placeholder*="city" i]','input[aria-label*="city" i]']) {
                const e = document.querySelector(s); if (e) { e.value = fcity; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); filled.push('city'); break; }
              }
            }
            if (fzip) {
              for (const s of ['input[name="zip"]','input[name="postal_code"]','input[placeholder*="zip" i]','input[placeholder*="postal" i]','input[aria-label*="zip" i]','input[aria-label*="postal" i]']) {
                const e = document.querySelector(s); if (e) { e.value = fzip; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); filled.push('zip'); break; }
              }
            }
            return filled.length > 0 ? filled : null;
          }
          let r = doFill();
          if (r) { resolve(r); return; }
          let obs = null;
          const tid = setTimeout(() => { if (obs) obs.disconnect(); resolve(['timeout']); }, 5000);
          obs = new MutationObserver(() => { const rr = doFill(); if (rr) { clearTimeout(tid); if (obs) obs.disconnect(); resolve(rr); } });
          obs.observe(document.body, { childList: true, subtree: true });
        });
      }, { fc: (country || '').toUpperCase(), faddr: address || '', fcity: city || '', fzip: zip || '' });
      log('INFO', `[BSmart] 表单填充结果: ${JSON.stringify(fillResult)}`);
      results.form = fillResult;
    } catch (e) { log('WARN', `[BSmart] 表单策略异常: ${e.message}`); results.form = 'error:' + e.message; }
  }
  }

  return results;
}

// ============================================================
// postOperationSync — 后操作同步
// ============================================================
async function postOperationSync(profileId, token, options = {}) {
    const { syncPages = true, syncPixels = true, syncAdAccounts = true } = options;
    const tasks = [];
    if (syncPages) tasks.push('pages');
    if (syncPixels) tasks.push('pixels');
    if (syncAdAccounts) tasks.push('adaccounts');
    log('INFO', `[Sync] postOperationSync: profileId=${profileId}, tasks=[${tasks.join(',')}]`);
    const existing = _activeBrowsers.get(profileId);
    if (!existing || !existing.browser || !existing.browser.isConnected()) {
        log('WARN', `[Sync] postOperationSync 跳过: profileId=${profileId} 浏览器未运行`);
        if (token) {
            try {
                const remoteUrl = process.env.STORAGE_SERVER_URL || '';
                const apiSecret = process.env.PUPPETEER_API_SECRET || '';
                const profileObj = { id: profileId, token };
                const meResp = await callFacebookGraphApi('me?fields=id,name,email', 'GET', null, profileObj).catch(() => null);
                if (meResp && meResp.id) {
                    await fetch(`${remoteUrl}/api/fb-api/sync`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
                        body: JSON.stringify({ profileId, token, pages: true, pixels: true, accounts: true })
                    }).catch(() => {});
                    log('INFO', `[Sync] postOperationSync 远程同步完成`);
                }
            } catch {}
        }
        return;
    }
    try {
        if (token) {
            fetch(`http://127.0.0.1:${_PORT}/api/facebook/fetch-adaccounts-graph`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': _API_SECRET },
                body: JSON.stringify({ profileId, accessToken: token, syncPages, syncPixels })
            }).catch(() => {});
        }
    } catch { log('WARN', `[Sync] postOperationSync 异常`); }
}

module.exports = {
  __inject,
  clickButtonByText,
  fillCardForm,
  fillIframeCardFields,
  detectCardBrand,
  normalizeFbTimezoneId,
  getBillingCache,
  getBillingCacheKey,
  setBillingCache,
  buildBillingHubUrl,
  navigateToBillingHub,
  retryWithTokenRefresh,
  ensureFbLanguage,
  tryUpdateBillingCountrySmart,
  postOperationSync,
  tryUpdateCurrencyTimezone,
};
