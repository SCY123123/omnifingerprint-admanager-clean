import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const CloudflareManager: React.FC = () => {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [zonesMap, setZonesMap] = useState<Record<string, any[]>>({});

  const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
  const base = String(serverUrl || '').replace(/\/$/, '');

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/api/profiles`);
      const json = await r.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      setAccounts(list.filter((p: any) => String(p.platform) === 'Cloudflare'));
    } catch {
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!name && !email) { alert(t('cloudflare.add.validationEnterUsernameOrEmail')); return; }
    setSaving(true);
    try {
      const payload = { name: name || email, platform: 'Cloudflare', account: { name: name || email, email, password }, token: apiKey };
      await fetch(`${base}/api/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      setName(''); setEmail(''); setPassword(''); setApiKey('');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const testZones = async (acc: any) => {
    const token = String(acc?.token || '');
    if (!token) return;
    try {
      const r = await fetch('https://api.cloudflare.com/client/v4/zones', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      const items = Array.isArray(j?.result) ? j.result : [];
      setZonesMap(prev => ({ ...prev, [String(acc.id)]: items }));
    } catch {}
  };

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-white">{t('cloudflare.main.title')}</h2>
          <p className="text-slate-400">{t('cloudflare.main.subtitle')}</p>
        </div>
        <button onClick={() => window.open('https://dash.cloudflare.com','_blank','noopener,noreferrer')} className="px-3 py-2 rounded bg-slate-800 text-slate-200 text-sm">{t('cloudflare.main.openConsole')}</button>
      </div>

      <div className="space-y-6">
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <div className="text-slate-200 font-medium mb-3">{t('cloudflare.add.panelTitle')}</div>
          <div className="space-y-3">
            <input value={name} onChange={e=>setName(e.target.value)} placeholder={t('cloudflare.add.labels.username')} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder={t('cloudflare.add.labels.email')} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder={t('cloudflare.add.labels.password')} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
            <input value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={t('cloudflare.add.labels.apiKey')} className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2" />
            <div className="flex justify-end">
              <button onClick={save} disabled={saving} className="px-4 py-2 rounded bg-indigo-600 text-white disabled:opacity-50">{t('cloudflare.add.actions.save')}</button>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-slate-200 font-medium">{t('cloudflare.list.panelTitle')}</div>
            <button onClick={load} disabled={loading} className="px-3 py-2 rounded bg-slate-800 text-slate-200 text-sm disabled:opacity-50">{t('cloudflare.list.actions.refresh')}</button>
          </div>
          {accounts.length === 0 ? (
            <div className="text-slate-400 text-sm">{t('cloudflare.list.empty')}</div>
          ) : (
            <div className="overflow-x-auto rounded border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-950 text-slate-200">
                  <tr>
                    <th className="px-4 py-2">{t('cloudflare.list.table.name')}</th>
                    <th className="px-4 py-2">{t('cloudflare.list.table.email')}</th>
                    <th className="px-4 py-2">{t('cloudflare.list.table.apiKey')}</th>
                    <th className="px-4 py-2">{t('cloudflare.list.table.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-900 text-slate-300">
                  {accounts.map(acc => {
                    const zones = zonesMap[String(acc.id)] || [];
                    return (
                      <tr key={acc.id}>
                        <td className="px-4 py-2">{acc.account?.name || acc.name}</td>
                        <td className="px-4 py-2">{acc.account?.email || '-'}</td>
                        <td className="px-4 py-2">{acc.token ? t('cloudflare.list.status.tokenSet') : '-'}</td>
                        <td className="px-4 py-2">
                          <button onClick={()=>testZones(acc)} className="px-2 py-1 text-xs rounded bg-indigo-600 text-white">{t('cloudflare.list.actions.testApi')}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {Object.keys(zonesMap).length > 0 && (
            <div className="mt-4 rounded border border-slate-800 bg-slate-950 p-4">
              <div className="text-slate-200 font-medium mb-2">{t('cloudflare.zones.title')}</div>
              {Object.entries(zonesMap).map(([id, zones]) => (
                <div key={id} className="mb-3">
                  <div className="text-slate-400 text-xs mb-1">{t('cloudflare.zones.accountPrefix')} {id}</div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {(zones as any[]).slice(0,9).map(z => (
                      <div key={z.id} className="px-3 py-2 rounded bg-slate-800 text-slate-200 text-xs">{z.name}</div>
                    ))}
                    {(zones as any[]).length === 0 && <div className="text-slate-500 text-sm">{t('cloudflare.zones.empty')}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
