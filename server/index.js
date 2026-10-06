const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

console.log = () => {};
console.debug = () => {};

const profilesDir = path.join(process.cwd(), '.profiles');
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir);

function parseResolution(res) {
  if (!res) return undefined;
  const m = String(res).match(/(\d+)x(\d+)/i);
  if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  return undefined;
}

function parseCookiesString(raw, defaultDomain) {
  const cookies = [];
  if (!raw) return cookies;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(c => ({
        name: c.name || c.key,
        value: c.value,
        domain: c.domain || defaultDomain,
        path: c.path || '/',
      }));
    }
  } catch {}
  const lines = String(raw).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 7) {
      const domain = parts[0] || defaultDomain;
      const name = parts[5];
      const value = parts[6];
      cookies.push({ name, value, domain, path: '/' });
    }
  }
  return cookies;
}

app.post('/launch', async (req, res) => {
  const profile = req.body;
  try {
    const userDataDir = path.join(profilesDir, String(profile.id || 'unknown'));
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    const args = [];
    if (profile.proxy && profile.proxy.host && profile.proxy.port) {
      const scheme = profile.proxy.type === 'socks5' ? 'socks5' : 'http';
      let proxyHost = `${profile.proxy.host}:${profile.proxy.port}`;
      if (profile.proxy.username && profile.proxy.password) {
        proxyHost = `${encodeURIComponent(profile.proxy.username)}:${encodeURIComponent(profile.proxy.password)}@${proxyHost}`;
      }
      args.push(`--proxy-server=${scheme}://${proxyHost}`);
    }
    const extDirCommon = path.join(process.cwd(), 'extensions', 'common');
    if (fs.existsSync(extDirCommon)) {
      args.push(`--disable-extensions-except=${extDirCommon}`);
      args.push(`--load-extension=${extDirCommon}`);
    }

    let effectiveExecutablePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;
    try {
      const candidates = [
        process.env.CHROME_PATH,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA || 'C:\\Users\\Administrator\\AppData\\Local'}\\Google\\Chrome\\Application\\chrome.exe`,
        (() => { try { return puppeteer.executablePath(); } catch(_) { return null; } })()
      ].filter(Boolean);
      effectiveExecutablePath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || effectiveExecutablePath;
    } catch {}

    const launchOpts = {
      headless: false,
      userDataDir,
      args,
      defaultViewport: parseResolution(profile.resolution) || { width: 1280, height: 800 },
    };
    if (effectiveExecutablePath) launchOpts.executablePath = effectiveExecutablePath;

    const browser = await puppeteer.launch(launchOpts);

    const startupUrls = Array.isArray(profile.startupUrls) && profile.startupUrls.length ? profile.startupUrls : ['about:blank'];
    const pages = [];
    for (let i = 0; i < Math.min(startupUrls.length, 6); i++) {
      const page = await browser.newPage();
      if (profile.userAgent) await page.setUserAgent(profile.userAgent);
      const url = startupUrls[i];
      await page.goto(url, { waitUntil: 'networkidle2' });
      await page.evaluate(seq => { try { document.title = `[${seq}] ` + document.title; } catch {} }, profile.seq || '');
      pages.push(page);
    }

    // Inject cookies on first page domain if provided
    if (profile.account && profile.account.cookies && pages[0]) {
      const firstURL = pages[0].url();
      const domainFromURL = (() => { try { const u = new URL(firstURL); return u.hostname; } catch { return undefined; } })();
      const cookies = parseCookiesString(profile.account.cookies, domainFromURL);
      if (cookies.length) {
        try { await pages[0].setCookie(...cookies); } catch {}
      }
    }

    // Autofill credentials on each page (best-effort)
    if (profile.account && (profile.account.email || profile.account.name) && profile.account.password) {
      for (const page of pages) {
        try {
          await page.evaluate(({ email, name }) => {
            const user = email || name || '';
            const inputs = Array.from(document.querySelectorAll('input'));
            const userInput = inputs.find(i => /email|user|login|username/i.test(i.name) || /email|user|login|username/i.test(i.id));
            if (userInput) userInput.value = user;
          }, { email: profile.account.email, name: profile.account.name });
          const passHandle = await page.$('input[type="password"], input[name*="pass" i], input[id*="pass" i]');
          if (passHandle) {
            await passHandle.type(profile.account.password, { delay: 50 });
          }
        } catch {}
      }
    }

    res.json({ ok: true, message: 'Launched', windows: pages.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const PORT = process.env.LAUNCH_PORT || 3301;
app.listen(PORT, () => {
  console.log(`Launch server listening on http://localhost:${PORT}`);
});
