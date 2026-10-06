'use strict';

// ============================================================================
// Debug / DevTools / RPA Routes - extracted from puppeteer-api-server.js
// ============================================================================

const http = require('http');
const sqlite3 = require('sqlite3').verbose();

const browserManagerModule = require('./browser-manager');
const { activeBrowsers, ensureBrowserIsRunning } = browserManagerModule;
const billingModule = require('./facebook-billing');
const { navigateToBillingHub } = billingModule;

// Injected variables
let _log = () => {};
let _app = null;
let _dbPath = '';

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.app) _app = deps.app;
  if (deps.dbPath) _dbPath = deps.dbPath;
}

const log = (...args) => _log(...args);
const sleep = (ms) => _sleep(ms);

function registerRoutes() {
  if (!_app) return;

  // 🐛 Debug: 导航到 URL
  _app.post('/api/debug-navigate', async (req, res) => {
    const { profileId, url } = req.body;
    if (!profileId || !url) return res.status(400).json({ error: 'missing profileId or url' });
    const b = activeBrowsers.get(String(profileId));
    if (!b || !b.browser) return res.status(404).json({ error: 'no browser' });
    try {
      const pages = await b.browser.pages();
      // 找到主 Facebook 页面（非诊断页）
      let page = null;
      for (const p of pages) {
        try {
          const url = p.url();
          if (url.includes('facebook.com') || url === 'about:blank' || (url !== 'about:blank' && !url.includes('localhost'))) {
            page = p; break;
          }
        } catch {}
      }
      if (!page) page = pages[0];
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return res.json({ success: true, url: page.url() });
    } catch (e) {
      return res.json({ error: e.message });
    }
  });

  // 🐛 Debug: 检查页面 DOM 状态
  _app.post('/api/debug-page-state', async (req, res) => {
    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'missing profileId' });
    const b = activeBrowsers.get(String(profileId));
    if (!b || !b.browser) return res.status(404).json({ error: 'no browser' });
    try {
      const pages = await b.browser.pages();
      // 检查所有标签页
      const results = [];
      for (const p of pages) {
        try {
          const state = await p.evaluate(() => ({
            url: location.href,
            title: document.title,
            inputCount: document.querySelectorAll('input').length,
            inputs: Array.from(document.querySelectorAll('input')).slice(0,8).map(i => ({
              placeholder: i.placeholder, 'aria-label': i.getAttribute('aria-label'),
              name: i.name, id: i.id, type: i.type, value: (i.value||'').slice(0,20),
              visible: i.offsetParent !== null
            })),
            buttons: Array.from(document.querySelectorAll('div[role="button"], button')).slice(0,20).map(b => ({
              text: (b.textContent||'').trim().slice(0,50),
              'aria-label': b.getAttribute('aria-label') || '',
              visible: b.offsetParent !== null
            })),
            bodySnippet: (document.body?.innerText||'').slice(0,300)
          }));
          results.push(state);
        } catch { results.push({ url: 'CLOSED/DETACHED' }); }
      }
      return res.json({ success: true, pages: results, profileId });
    } catch (e) {
      return res.json({ error: e.message });
    }
  });

  // 发布广告（占位返回）
  _app.post('/api/facebook/adaccounts/ads/publish', async (req, res) => {
    try {
      const { profileId, adAccountId, creative } = req.body || {}
      if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' })
      return res.json({ success: true })
    } catch (e) { return res.status(500).json({ success: false, message: String(e.message || e) }) }
  })

  // 获取/刷新TOKEN（占位）
  _app.post('/api/facebook/tokens/refresh', async (req, res) => {
    return res.status(404).json({ success: false, message: 'removed' })
  })

  // 🍪 同步当前浏览器Cookie到卡片配置（profiles.account_cookies）
  _app.post('/api/sync-cookies-to-card', async (req, res) => {
      const { profileId } = req.body || {};
      try {
          if (!profileId) return res.status(400).json({ success: false, message: '缺少 profileId' });
          const browserData = activeBrowsers.get(profileId);
          if (!browserData || !browserData.browser || !browserData.browser.isConnected()) {
              return res.status(404).json({ success: false, message: '未找到运行中的浏览器实例' });
          }

          const browser = browserData.browser;
          const pages = await browser.pages();
          let allCookies = [];
          for (const page of pages) {
              try {
                  const cks = await page.cookies();
                  allCookies = allCookies.concat(cks);
              } catch {}
          }
          // 去重
          const seen = new Set();
          const dedup = [];
          for (const c of allCookies) {
              const key = `${c.domain}|${c.name}`;
              if (!seen.has(key)) { seen.add(key); dedup.push(c); }
          }

          // 🔐 闸门：与 cookie-manager.syncCookiesToStorage 同一口径 ——
          //    没有 c_user/xs（未登录 / 中间态）一律不许写库，否则会把登录态覆盖成匿名态。
          //    🐛 实测 2026-09-27 profile 4067：会话被 FB 作废（190）后，浏览器 cookie jar 只剩
          //       datr/sb/locale/ps_n/pas/fr/dpr/wd 这类匿名 Cookie（9~10 个）。
          //       这个接口此前**完全没有校验**，直接 UPDATE profiles.account_cookies，
          //       一旦在未登录态被调用就会把卡片里的正常登录态冲掉。
          const hasSession = dedup.some(c => c.name === 'c_user' && c.value) && dedup.some(c => c.name === 'xs' && c.value);
          if (!hasSession) {
              log('WARN', `[Sync] 拒绝写入卡片配置: 缺少核心登录字段 c_user/xs，防止覆盖正常登录态 (profileId=${profileId}, count=${dedup.length})`);
              return res.status(409).json({
                  success: false,
                  profileId,
                  saved: 0,
                  message: `浏览器当前不是登录态（只有 ${dedup.length} 个非登录 Cookie），已拒绝覆盖卡片里的 Cookie。请先在浏览器里登录成功再同步`,
              });
          }

          // 写入到新数据库的 profiles.account_cookies
          const jsonData = JSON.stringify(dedup);
          async function updateDb(){
              const db = new sqlite3.Database(_dbPath);
              await new Promise((resolve, reject) => {
                  db.run(`UPDATE profiles SET account_cookies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [jsonData, profileId], function(err){
                      if (err) return reject(err);
                      resolve();
                  });
              });
              db.close();
          }
          await updateDb();

          res.json({ success: true, profileId, saved: dedup.length, cookies: dedup, message: 'Cookie已同步到卡片配置' });
      } catch (error) {
          res.status(500).json({ success: false, message: '同步失败', error: error.message });
      }
  });

  // RPA 路由
  _app.post('/api/rpa/run', async (req, res) => {
      const { profileId, steps = [], newPage } = req.body || {};
      const logs = [];
      try {
          const active = activeBrowsers.get(profileId);
          if (!active || !active.browser) return res.status(400).json({ success: false, message: 'browser not running', profileId });
          const browser = active.browser;
          let page;
          if (newPage) {
              page = await browser.newPage();
          } else {
              const pages = await browser.pages();
              page = pages[0] || await browser.newPage();
          }
          for (const step of steps) {
              try {
                  const a = step.action;
                  if (a === 'goto') {
                      await page.goto(step.url, { waitUntil: step.waitUntil || 'networkidle2', timeout: step.timeout || 30000 });
                      logs.push(`goto:${step.url}`);
                  } else if (a === 'waitForSelector') {
                      await page.waitForSelector(step.selector, { timeout: step.timeout || 30000 });
                      logs.push(`wait:${step.selector}`);
                  } else if (a === 'click') {
                      await page.click(step.selector, step.options || {});
                      logs.push(`click:${step.selector}`);
                  } else if (a === 'type') {
                      await page.type(step.selector, step.text || '', step.options || {});
                      logs.push(`type:${step.selector}`);
                  } else if (a === 'evaluate') {
                      const r = await page.evaluate(step.script || (() => null));
                      logs.push(`eval:${String(r).slice(0,80)}`);
                  } else if (a === 'screenshot') {
                      const buf = await page.screenshot({ fullPage: !!step.fullPage });
                      logs.push(`screenshot:${buf.length}`);
                  } else if (a === 'delay') {
                      await new Promise(r => setTimeout(r, step.ms || 500));
                      logs.push(`delay:${step.ms || 500}`);
                  }
              } catch (e) {
                  logs.push(`error:${e.message}`);
                  return res.status(500).json({ success: false, profileId, logs, message: e.message });
              }
          }
          const url = page.url();
          return res.json({ success: true, profileId, url, logs });
      } catch (e) {
          return res.status(500).json({ success: false, profileId, message: e.message });
      }
  });

  // 📋 会话管理API
  _app.get('/api/sessions', (req, res) => { res.status(404).end() });

  // 🔧 DevTools代理API - 用于线上域名访问本地DevTools
  _app.get('/api/devtools/:debugPort/json/list', async (req, res) => {
      try {
          const { debugPort } = req.params;
          const http = require('http');
          
          console.log(`🔧 DevTools代理请求: localhost:${debugPort}/json/list`);
          
          const options = {
              hostname: 'localhost',
              port: debugPort,
              path: `/json/list?t=${Date.now()}`,
              method: 'GET'
          };
          
          const request = http.request(options, (response) => {
              let data = '';
              response.on('data', (chunk) => {
                  data += chunk;
              });
              response.on('end', () => {
                  try {
                      const jsonData = JSON.parse(data);
                      res.json(jsonData);
                  } catch (parseError) {
                      console.error('❌ JSON解析失败:', parseError.message);
                      res.status(500).json({
                          success: false,
                          error: 'JSON解析失败',
                          message: parseError.message
                      });
                  }
              });
          });
          
          request.on('error', (error) => {
              console.error(`❌ DevTools代理失败:`, error.message);
              res.status(500).json({
                  success: false,
                  error: 'DevTools代理失败',
                  message: error.message
              });
          });
          
          request.end();
      } catch (error) {
          console.error(`❌ DevTools代理失败:`, error.message);
          res.status(500).json({
              success: false,
              error: 'DevTools代理失败',
              message: error.message
          });
      }
  });

  _app.get('/api/devtools/:debugPort/json/version', async (req, res) => {
      try {
          const { debugPort } = req.params;
          const http = require('http');
          
          console.log(`🔧 DevTools代理请求: localhost:${debugPort}/json/version`);
          
          const options = {
              hostname: 'localhost',
              port: debugPort,
              path: '/json/version',
              method: 'GET'
          };
          
          const request = http.request(options, (response) => {
              let data = '';
              response.on('data', (chunk) => {
                  data += chunk;
              });
              response.on('end', () => {
                  try {
                      const jsonData = JSON.parse(data);
                      res.json(jsonData);
                  } catch (parseError) {
                      console.error('❌ JSON解析失败:', parseError.message);
                      res.status(500).json({
                          success: false,
                          error: 'JSON解析失败',
                          message: parseError.message
                      });
                  }
              });
          });
          
          request.on('error', (error) => {
              console.error(`❌ DevTools代理失败:`, error.message);
              res.status(500).json({
                  success: false,
                  error: 'DevTools代理失败',
                  message: error.message
              });
          });
          
          request.end();
      } catch (error) {
          console.error(`❌ DevTools代理失败:`, error.message);
          res.status(500).json({
              success: false,
              error: 'DevTools代理失败',
              message: error.message
          });
      }
  });

  // 🔧 DevTools WebSocket代理 - 用于Runtime.evaluate等操作
  _app.post('/api/devtools/:debugPort/runtime/evaluate', async (req, res) => {
      try {
          const { debugPort } = req.params;
          const { expression, awaitPromise = false, returnByValue = true, targetUrlContains = '', targetType = '' } = req.body;
          const WebSocket = require('ws');
          
          console.log(`🔧 DevTools Runtime.evaluate代理: localhost:${debugPort}`);
          
          // 首先获取可用的targets
          const http = require('http');
          const targets = await new Promise((resolve, reject) => {
              const options = {
                  hostname: 'localhost',
                  port: debugPort,
                  path: `/json/list?t=${Date.now()}`,
                  method: 'GET'
              };
              
              const request = http.request(options, (response) => {
                  let data = '';
                  response.on('data', (chunk) => {
                      data += chunk;
                  });
                  response.on('end', () => {
                      try {
                          const jsonData = JSON.parse(data);
                          resolve(jsonData);
                      } catch (parseError) {
                          reject(parseError);
                      }
                  });
              });
              
              request.on('error', (error) => {
                  reject(error);
              });
              
              request.end();
          });
          
          if (!Array.isArray(targets) || targets.length === 0) {
              throw new Error('未找到可用的调试页面');
          }
          
          let candidates = targets.filter(item => item.webSocketDebuggerUrl);
          if (targetType) {
              candidates = candidates.filter(item => String(item.type || '').toLowerCase() === String(targetType).toLowerCase());
          }
          if (targetUrlContains) {
              candidates = candidates.filter(item => String(item.url || '').includes(String(targetUrlContains)));
          }
          if (!candidates.length) {
              candidates = targets.filter(item => item.type === 'page' && item.url && !String(item.url).startsWith('devtools://') && !String(item.url).startsWith('chrome-extension://'));
          }
          const target = candidates[0];
          
          if (!target || !target.webSocketDebuggerUrl) {
              throw new Error('调试目标缺少 WebSocket 地址');
          }
          
          // 通过WebSocket执行Runtime.evaluate
          const result = await new Promise((resolve, reject) => {
              let settled = false;
              let evalMessageId = null;
              let messageId = 1;
              const socket = new WebSocket(target.webSocketDebuggerUrl);
              
              const cleanup = () => {
                  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                      socket.close();
                  }
              };
              
              const timeout = setTimeout(() => {
                  if (!settled) {
                      settled = true;
                      cleanup();
                      reject(new Error('Runtime.evaluate 超时'));
                  }
              }, 8000);
              
              socket.onopen = () => {
                  socket.send(JSON.stringify({ id: messageId++, method: 'Runtime.enable' }));
                  evalMessageId = messageId++;
                  socket.send(JSON.stringify({
                      id: evalMessageId,
                      method: 'Runtime.evaluate',
                      params: {
                          expression: expression,
                          awaitPromise: awaitPromise,
                          returnByValue: returnByValue
                      }
                  }));
              };
              
              socket.onmessage = event => {
                  if (settled) return;
                  
                  try {
                      const data = JSON.parse(event.data);
                      if (data.id === evalMessageId) {
                          settled = true;
                          clearTimeout(timeout);
                          cleanup();
                          
                          if (data.error) {
                              reject(new Error(data.error.message || 'Runtime.evaluate 执行失败'));
                              return;
                          }
                          
                          resolve(data.result);
                      }
                  } catch (parseError) {
                      console.warn('⚠️ WebSocket消息解析失败:', parseError.message);
                  }
              };
              
              socket.onerror = error => {
                  if (!settled) {
                      settled = true;
                      clearTimeout(timeout);
                      cleanup();
                      reject(new Error(`WebSocket连接失败: ${error.message}`));
                  }
              };
              
              socket.onclose = () => {
                  if (!settled) {
                      settled = true;
                      clearTimeout(timeout);
                      reject(new Error('WebSocket连接意外关闭'));
                  }
              };
          });
          
          res.json({
              success: true,
              result: result
          });
          
      } catch (error) {
          console.error(`❌ DevTools Runtime.evaluate代理失败:`, error.message);
          res.status(500).json({
              success: false,
              error: 'DevTools Runtime.evaluate代理失败',
              message: error.message
          });
      }
  });

  // Debug: 截图当前页面
  _app.post('/api/debug/screenshot', async (req, res) => {
    try {
      const { profileId } = req.body || {};
      if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
      const result = await ensureBrowserIsRunning(profileId);
      if (!result.success) return res.status(500).json({ success: false, message: `browser not running: ${result.error}` });
      const browser = result.browserData.browser;
      const pages = await browser.pages();
      const page = pages.find(p => p.url().includes('facebook.com')) || pages[0];
      await new Promise(r => setTimeout(r, 2000));
      const inputs = await page.evaluate(() => {
        const all = document.querySelectorAll('input:not([type="hidden"])');
        return Array.from(all).map(inp => ({ id: inp.id, name: inp.getAttribute('name')||'', placeholder: inp.getAttribute('placeholder')||'', type: inp.type, className: inp.className?.substring?.(0,80)||'' }));
      });
      const url = page.url();
      const title = await page.title();
      const buttons = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"], button'));
        return btns.slice(0,30).map(b => ({ text: (b.textContent||'').trim().substring(0,50), role: b.getAttribute('role')||'', aria: b.getAttribute('aria-label')||'' }));
      });
      res.json({ success: true, url, title, inputs: inputs.slice(0,50), buttons: buttons.slice(0,20) });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // Debug: 在当前页面填写并提交卡号
  _app.post('/api/debug/bind-card', async (req, res) => {
    try {
      const { profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC, ccIso, cardholderName, billingStreet, billingCity, billingZip } = req.body || {};
      if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' });

      const result = await ensureBrowserIsRunning(profileId);
      if (!result.success) return res.status(500).json({ success: false, message: `browser not running: ${result.error}` });
      const browser = result.browserData.browser;
      const pages = await browser.pages();
      let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();

      const cleanActId = String(adAccountId).replace('act_', '');
      await navigateToBillingHub(page, adAccountId);
      await new Promise(r => setTimeout(r, 5000));

      // 点击添加支付方式
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"], button, a'));
        const targets = ['Add payment method', '添加付款方式', '添加支付方式', 'Add card'];
        for (const btn of btns) {
          const txt = (btn.textContent||'').trim().toLowerCase();
          if (targets.some(t => txt.includes(t.toLowerCase()))) { btn.click(); return true; }
        }
        return false;
      });
      await new Promise(r => setTimeout(r, 3000));

      // 🚀 处理国家/货币/时区中间表单（点击"添加支付方式"后弹出的第一步）
      const handleCcyTzForm = async () => {
        await new Promise(r => setTimeout(r, 2000));
        const hasSelectorForm = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
          if (!dialog) return { hasCcyTz: false, hasContinueBtn: false, selectCount: 0, elements: [] };
          const html = dialog.innerHTML.substring(0, 5000);
          const allBtns = Array.from(dialog.querySelectorAll('div[role="button"], button'));
          const allLabels = Array.from(dialog.querySelectorAll('span, label, div'));
          const labelTexts = allLabels.map(l => (l.textContent||'').trim().toLowerCase()).filter(Boolean);
          
          const isPaymentWizard = html.includes('add_pm_nux') || labelTexts.some(t => 
            t.includes('add payment') || t.includes('添加支付') || t.includes('支付方式') || t.includes('payment method')
          );
          
          const hasCcyTz = isPaymentWizard || html.includes('billing_hub/wizard') || labelTexts.some(t => 
            t.includes('country') || t.includes('currency') || t.includes('timezone') || t.includes('国家') || t.includes('货币') || t.includes('时区') || t.includes('billing')
          );
          
          const continueBtns = allBtns.filter(b => {
            const txt = (b.textContent||'').trim().toLowerCase();
            return txt.includes('continue') || txt.includes('next') || txt.includes('继续') || txt.includes('下一步');
          });
          
          const elements = Array.from(dialog.querySelectorAll('div[role="button"], button, select, input, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="textbox"]'))
            .slice(0, 40)
            .map(el => ({
              tag: el.tagName,
              text: (el.textContent||'').trim().substring(0, 40),
              role: el.getAttribute('role')||'',
              ariaLabel: el.getAttribute('aria-label')||'',
              dataTestid: el.getAttribute('data-testid')||''
            }));
          
          return { 
            hasCcyTz, 
            continueBtnCount: continueBtns.length,
            continueBtnText: continueBtns[0]?.textContent?.trim()?.substring(0, 50) || '',
            elements: elements.slice(0, 20)
          };
        });

        if (hasSelectorForm.hasCcyTz && hasSelectorForm.continueBtnCount > 0) {
          await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!dialog) return;
            const btns = Array.from(dialog.querySelectorAll('div[role="button"], button'));
            for (const b of btns) {
              const txt = (b.textContent||'').trim().toLowerCase();
              if (txt.includes('continue') || txt.includes('next') || txt.includes('继续') || txt.includes('下一步')) {
                b.click(); return;
              }
            }
          });
          await new Promise(r => setTimeout(r, 3000));
          return true;
        }
        
        return false;
      };
      await handleCcyTzForm();

      // 🚀 填写卡信息表单（弹窗里的 cardNumber/expiration/securityCode 等）
      const fillCardDialog = async () => {
        await new Promise(r => setTimeout(r, 2000));
        const hasCardFields = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
          if (!dialog) return false;
          const inputs = dialog.querySelectorAll('input[name="cardNumber"], input[name="expiration"], input[name="securityCode"], input[name="firstName"]');
          return inputs.length >= 2;
        });

        if (!hasCardFields) return false;

        await new Promise(r => setTimeout(r, 500));
        const dialog2 = await page.$('[role="dialog"], [aria-modal="true"]');
        if (dialog2) {
          const cardInput = await dialog2.$('input[name="cardNumber"]');
          if (cardInput) {
            await cardInput.click({delay: 200});
            await cardInput.type(String(ccNumber).replace(/\s/g, ''), {delay: 15});
          }
          const expInput = await dialog2.$('input[name="expiration"]');
          if (expInput) {
            await expInput.click({delay: 100});
            await expInput.type(`${ccMonth}/${String(ccYear).slice(-2)}`, {delay: 15});
          }
          const cvcInput = await dialog2.$('input[name="securityCode"]');
          if (cvcInput) {
            await cvcInput.click({delay: 100});
            await cvcInput.type(String(ccCVC), {delay: 15});
          }
          const nameInput = await dialog2.$('input[name="firstName"]');
          if (nameInput) {
            await nameInput.click({delay: 100});
            await nameInput.type(cardholderName || 'Test User', {delay: 10});
          }
        }
        
        await new Promise(r => setTimeout(r, 1000));

        // 点击保存/添加按钮
        await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
          if (!dialog) return;
          const btns = Array.from(dialog.querySelectorAll('div[role="button"], button'));
          for (const b of btns) {
            const txt = (b.textContent||'').trim().toLowerCase();
            if (txt.includes('add') || txt.includes('save') || txt.includes('添加') || txt.includes('保存') || txt.includes('confirm') || txt.includes('确认')) {
              b.click(); return;
            }
          }
        });
        await new Promise(r => setTimeout(r, 3000));
        return true;
      };
      
      const cardFilled = await fillCardDialog();

      // 检查当前是否弹出了 modal 或 iframe
      const modalInfo = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
        const frames = document.querySelectorAll('iframe');
        const allDivs = document.querySelectorAll('div[contenteditable="true"], div[role="textbox"], div[data-testid*="card" i], div[data-testid*="cc" i], input:not([type="hidden"]), select, textarea');
        return {
          dialogCount: dialogs.length,
          iframeCount: frames.length,
          iframeSrcs: Array.from(frames).slice(0,5).map(f => f.src?.substring(0,120)||''),
          inputs: Array.from(allDivs).slice(0,30).map(i => ({ 
            tag: i.tagName, 
            id: i.id, 
            name: i.getAttribute('name')||'', 
            placeholder: i.getAttribute('placeholder')||'',
            'aria-label': i.getAttribute('aria-label')||'',
            contenteditable: i.getAttribute('contenteditable')||'',
            role: i.getAttribute('role')||'',
            'data-testid': i.getAttribute('data-testid')||'',
            className: (i.className||'').substring(0,60) 
          })),
          dialogHTML: dialogs.length > 0 ? dialogs[0].innerHTML.substring(0,3000) : ''
        };
      });

      // 如果有 iframe, 尝试切换到 iframe
      if (modalInfo.iframeCount > 0) {
        for (const frame of page.mainFrame().childFrames()) {
          const url = frame.url();
          if (url.includes('facebook') || url.includes('payments')) {
            const frameInputs = await frame.evaluate(() => {
              return Array.from(document.querySelectorAll('div[contenteditable="true"], div[role="textbox"], input:not([type="hidden"])')).map(i => ({ 
                tag: i.tagName, 
                id: i.id, 
                placeholder: i.getAttribute('placeholder')||'',
                'aria-label': i.getAttribute('aria-label')||'',
                contenteditable: i.getAttribute('contenteditable')||'',
                name: i.getAttribute('name')||''
              }));
            });
            if (frameInputs.length > 0) {
              modalInfo.inputs = [...modalInfo.inputs, ...frameInputs.map(i => ({...i, source: 'iframe'}))];
              // 尝试在 iframe 内填卡号
              if (ccNumber) {
                const cc = String(ccNumber).replace(/\s/g, '');
                for (const inp of await frame.$$('div[contenteditable="true"], div[role="textbox"], input:not([type="hidden"])')) {
                  const placeholder = await inp.evaluate(el => el.getAttribute('placeholder')||'');
                  const id = await inp.evaluate(el => el.id||'');
                  const name = await inp.evaluate(el => el.getAttribute('name')||'');
                  const ariaLabel = await inp.evaluate(el => el.getAttribute('aria-label')||'');
                  const combo = `${id} ${placeholder} ${name} ${ariaLabel}`.toLowerCase();
                  if (combo.includes('card') || combo.includes('number') || combo.includes('cc ')) {
                    await inp.click({delay: 100});
                    const ct = await inp.evaluate(el => el.getAttribute('contenteditable'));
                    if (ct === 'true') {
                      await inp.evaluate((el, val) => { el.textContent = val; el.dispatchEvent(new Event('input', {bubbles:true})); }, cc);
                    } else {
                      await inp.type(cc, {delay: 20});
                    }
                    modalInfo.cardFilled = true;
                    break;
                  }
                }
                // 填 CVV
                if (ccCVC) {
                  for (const inp of await frame.$$('div[contenteditable="true"], div[role="textbox"], input:not([type="hidden"])')) {
                    const placeholder = await inp.evaluate(el => el.getAttribute('placeholder')||'');
                    const id = await inp.evaluate(el => el.id||'');
                    const ariaLabel = await inp.evaluate(el => el.getAttribute('aria-label')||'');
                    const combo = `${id} ${placeholder} ${ariaLabel}`.toLowerCase();
                    if (combo.includes('cvv') || combo.includes('cvc') || combo.includes('security')) {
                      await inp.click({delay: 100});
                      const ct = await inp.evaluate(el => el.getAttribute('contenteditable'));
                      if (ct === 'true') {
                        await inp.evaluate((el, val) => { el.textContent = val; el.dispatchEvent(new Event('input', {bubbles:true})); }, String(ccCVC));
                      } else {
                        await inp.type(String(ccCVC), {delay: 20});
                      }
                      modalInfo.cvvFilled = true;
                      break;
                    }
                  }
                }
              }
              break;
            }
          }
        }
      }

      res.json({ success: true, url: page.url(), modalInfo });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // 🚀 监听绑卡网络请求 V2：在浏览器内部 hook fetch/XHR 精准捕获绑卡 GraphQL 请求
  _app.post('/api/debug/capture-bind-card-v2', async (req, res) => {
    try {
      const { profileId, adAccountId, ccNumber, ccYear, ccMonth, ccCVC, ccIso, cardholderName, billingStreet, billingCity, billingZip } = req.body || {};
      if (!profileId || !adAccountId) return res.status(400).json({ success: false, message: 'missing profileId/adAccountId' });

      const result = await ensureBrowserIsRunning(profileId);
      if (!result.success) return res.status(500).json({ success: false, message: `browser not running: ${result.error}` });
      const browser = result.browserData.browser;
      const pages = await browser.pages();
      let page = pages.find(p => p.url().includes('facebook.com')) || await browser.newPage();

      const cleanActId = String(adAccountId).replace('act_', '');
      log('INFO', `[capture-bind-card-v2] 开始: profile=${profileId}, adAccount=${cleanActId}, card=****${String(ccNumber).slice(-4)}`);

      // 🚀 导航到支付设置页面
      await navigateToBillingHub(page, cleanActId);
      await new Promise(r => setTimeout(r, 5000));
      log('INFO', `[capture-bind-card-v2] 已导航到 payment_settings`);

      // 🚀 在浏览器内安装请求钩子（hook fetch + XHR）
      await page.evaluate(() => {
        window.__capturedRequests = [];
        window.__capturedResponses = [];
        const MAX_BODY = 15000;

        // Hook fetch
        const origFetch = window.fetch;
        window.fetch = async (...args) => {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          let bodyStr = '';
          if (args[1]?.body) {
            try {
              if (typeof args[1].body === 'string') bodyStr = args[1].body;
              else if (args[1].body instanceof URLSearchParams) bodyStr = args[1].body.toString();
              else if (args[1].body.toString) bodyStr = args[1].body.toString();
            } catch(e) { bodyStr = '(body error)'; }
          }
          if (url.includes('graphql') || url.includes('api/')) {
            const headers = args[1]?.headers || {};
            window.__capturedRequests.push({
              url: url.substring(0, 500),
              method: 'POST',
              headers: {
                'content-type': headers['content-type'] || headers['Content-Type'] || '',
                'x-fb-friendly-name': headers['x-fb-friendly-name'] || '',
              },
              postData: bodyStr.substring(0, MAX_BODY)
            });
          }
          const resp = await origFetch.apply(window, args);
          if (url.includes('graphql') || url.includes('api/')) {
            const clone = resp.clone();
            clone.text().then(body => {
              if (body && body.length < 100000) {
                window.__capturedResponses.push({
                  url: url.substring(0, 300),
                  status: resp.status,
                  body: body.substring(0, 8000)
                });
              }
            }).catch(() => {});
          }
          return resp;
        };

        // Hook XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this._captureUrl = typeof url === 'string' ? url : (url ? url.toString() : '');
          this._captureMethod = method;
          this._captureRequestHeaders = {};
          const origSetHeader = this.setRequestHeader.bind(this);
          this.setRequestHeader = function(key, val) {
            this._captureRequestHeaders[key] = val;
            origSetHeader(key, val);
          };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
          const url = this._captureUrl || '';
          if (url.includes('graphql') || url.includes('api/')) {
            let bodyStr = '';
            try { bodyStr = body ? (typeof body === 'string' ? body : String(body)) : ''; } catch(e) {}
            window.__capturedRequests.push({
              url: url.substring(0, 500),
              method: this._captureMethod || 'POST',
              headers: this._captureRequestHeaders || {},
              postData: bodyStr.substring(0, MAX_BODY)
            });
            this.addEventListener('load', () => {
              const respBody = this.responseText || '';
              if (respBody && respBody.length < 100000) {
                window.__capturedResponses.push({
                  url: url.substring(0, 300),
                  status: this.status,
                  body: respBody.substring(0, 8000)
                });
              }
            });
          }
          return origSend.apply(this, arguments);
        };
      });
      log('INFO', `[capture-bind-card-v2] 请求钩子已安装`);

      // 🚀 点击添加支付方式
      const addBtnClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"], button, a'));
        const targets = ['Add payment method', '添加付款方式', '添加支付方式', 'Add card'];
        for (const btn of btns) {
          const txt = (btn.textContent||'').trim().toLowerCase();
          if (targets.some(t => txt.includes(t.toLowerCase()))) { btn.click(); return true; }
        }
        return false;
      });
      log('INFO', `[capture-bind-card-v2] 点击添加支付方式: ${addBtnClicked}`);
      await new Promise(r => setTimeout(r, 3000));

      // 🚀 处理国家/货币/时区中间表单
      const handleCcyTzForm = async () => {
        await new Promise(r => setTimeout(r, 2000));
        const hasSelectorForm = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
          if (!dialog) return { hasForm: false, continueCount: 0, dialogHtml: '' };
          const html = dialog.innerHTML.substring(0, 5000);
          const isPaymentWizard = html.includes('add_pm_nux') || html.includes('billing_hub/wizard') || html.includes('AddPayment');
          const allBtns = Array.from(dialog.querySelectorAll('div[role="button"], button'));
          const continueBtns = allBtns.filter(b => {
            const txt = (b.textContent||'').trim().toLowerCase();
            return txt.includes('continue') || txt.includes('next') || txt.includes('继续') || txt.includes('下一步');
          });
          return { hasForm: isPaymentWizard, continueCount: continueBtns.length, dialogHtml: html.substring(0, 800) };
        });
        log('INFO', `[capture-bind-card-v2] 检测中间表单: ${JSON.stringify(hasSelectorForm)}`);

        if (hasSelectorForm.hasForm && hasSelectorForm.continueCount > 0) {
          if (ccIso) {
            await page.evaluate((iso) => {
              const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
              if (!dialog) return;
              const selects = dialog.querySelectorAll('select');
              for (const sel of selects) {
                const parent = sel.closest('[class*="country"], [class*="billing"]') || sel.parentElement;
                const txt = (parent?.textContent||'').toLowerCase();
                if (txt.includes('country') || txt.includes('国家')) {
                  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
                  nativeSetter?.call(sel, iso);
                  sel.dispatchEvent(new Event('change', {bubbles: true}));
                  break;
                }
              }
            }, ccIso);
            await new Promise(r => setTimeout(r, 1000));
          }
          await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!dialog) return;
            const btns = Array.from(dialog.querySelectorAll('div[role="button"], button'));
            for (const b of btns) {
              const txt = (b.textContent||'').trim().toLowerCase();
              if (txt.includes('continue') || txt.includes('next') || txt.includes('继续') || txt.includes('下一步')) {
                b.click(); return;
              }
            }
          });
          await new Promise(r => setTimeout(r, 4000));
          return true;
        }
        return false;
      };
      await handleCcyTzForm();

      // 🚀 填写卡信息
      const fillCardForm = async () => {
        await new Promise(r => setTimeout(r, 2000));
        const dialog2 = await page.$('[role="dialog"], [aria-modal="true"]');
        if (!dialog2) {
          log('WARN', `[capture-bind-card-v2] 未找到弹窗`);
          return false;
        }
        
        const cardInput = await dialog2.$('input[name="cardNumber"]');
        if (cardInput) {
          await cardInput.click({delay: 200});
          await cardInput.type(String(ccNumber).replace(/\s/g, ''), {delay: 10});
          log('INFO', `[capture-bind-card-v2] 已填卡号`);
        }
        const expInput = await dialog2.$('input[name="expiration"]');
        if (expInput) {
          await expInput.click({delay: 100});
          await expInput.type(`${ccMonth}/${String(ccYear).slice(-2)}`, {delay: 10});
          log('INFO', `[capture-bind-card-v2] 已填有效期`);
        }
        const cvcInput = await dialog2.$('input[name="securityCode"]');
        if (cvcInput) {
          await cvcInput.click({delay: 100});
          await cvcInput.type(String(ccCVC), {delay: 10});
          log('INFO', `[capture-bind-card-v2] 已填CVC`);
        }
        const nameInput = await dialog2.$('input[name="firstName"]');
        if (nameInput) {
          await nameInput.click({delay: 100});
          await nameInput.type(cardholderName || 'Test User', {delay: 10});
          log('INFO', `[capture-bind-card-v2] 已填持卡人`);
        }
        return true;
      };
      const filled = await fillCardForm();
      log('INFO', `[capture-bind-card-v2] 填卡完成: ${filled}`);

      // 🚀 点击添加/保存按钮
      await new Promise(r => setTimeout(r, 1000));
      await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (!dialog) return;
        const btns = Array.from(dialog.querySelectorAll('div[role="button"], button'));
        for (const b of btns) {
          const txt = (b.textContent||'').trim().toLowerCase();
          if (txt.includes('add') || txt.includes('save') || txt.includes('confirm') || txt.includes('添加') || txt.includes('保存') || txt.includes('确认')) {
            b.click(); return;
          }
        }
      });
      log('INFO', `[capture-bind-card-v2] 已点击提交按钮，等待响应...`);

      // 🚀 等待请求完成
      await new Promise(r => setTimeout(r, 10000));

      // 🚀 提取捕获的请求
      const captureResult = await page.evaluate(() => {
        return {
          requests: (window.__capturedRequests || []).slice(0, 30),
          responses: (window.__capturedResponses || []).slice(0, 20),
          count: window.__capturedRequests?.length || 0,
          responseCount: window.__capturedResponses?.length || 0
        };
      });

      log('INFO', `[capture-bind-card-v2] 捕获完成: ${captureResult.count} 请求, ${captureResult.responseCount} 响应`);

      // 🚀 获取页面最终状态
      const finalUrl = page.url();
      const finalDialog = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (!d) return null;
        const allText = d.textContent?.substring(0, 500) || '';
        const success = allText.includes('success') || allText.includes('added') || allText.includes('成功') || allText.includes('添加');
        const error = d.querySelector('[class*="error"], [class*="alert"]')?.textContent?.trim()?.substring(0, 200) || '';
        return { text: allText, success, error };
      });

      res.json({
        success: true,
        finalUrl,
        finalDialog,
        capturedCount: captureResult.count,
        capturedRequests: captureResult.requests,
        capturedResponses: captureResult.responses
      });
    } catch(e) { log('ERROR', `[capture-bind-card-v2] 异常: ${e.message}`); res.status(500).json({ success: false, message: e.message }); }
  });
}

module.exports = { __inject, registerRoutes };
