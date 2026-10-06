function loadEnvIfNeeded() {
  try {
    const fs = require('fs');
    const path = require('path');
    const root = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
    const files = [path.join(root, '.env.local'), path.join(root, '.env')];
    const need = ['ADPOS_API_BASE_URL', 'ADPOS_EMAIL', 'ADPOS_PASSWORD'];
    const missing = need.filter(k => !process.env[k]);
    if (!missing.length) return;
    for (const f of files) {
      try {
        if (!fs.existsSync(f)) continue;
        const txt = fs.readFileSync(f, 'utf8');
        const lines = String(txt || '').split(/\r?\n/);
        for (const line of lines) {
          const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
          if (!m) continue;
          const k = m[1];
          let v = m[2];
          if (v && (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
          if (v && (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          if (need.includes(k) && !process.env[k]) process.env[k] = v;
        }
      } catch {}
    }
  } catch {}
}

loadEnvIfNeeded();

module.exports = {
  requestPaymentManagementToken: async ({ profileId, adAccountId }) => {
    try {
      const base = (process.env.ADPOS_API_BASE_URL || 'https://api.adpos.io').replace(/\/$/, '');
      const email = process.env.ADPOS_EMAIL;
      const password = process.env.ADPOS_PASSWORD;
      if (!email || !password) {
        return { token: '', metadata: { error: 'missing_credentials' }, expiresAt: null };
      }
      const url = `${base}/auth/access-token`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const json = await resp.json().catch(() => ({}));
      const data = json && json.data ? json.data : json;
      const token = data && data.access_token ? String(data.access_token) : '';
      const type = data && data.token_type ? String(data.token_type) : '';
      if (!token) {
        return { token: '', metadata: { error: 'no_access_token', status: resp.status }, expiresAt: null };
      }
      return { token, metadata: { token_type: type || 'Bearer', provider: 'adpos' }, expiresAt: null };
    } catch (e) {
      return { token: '', metadata: { error: String(e && e.message || e) }, expiresAt: null };
    }
  }
};
