import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FingerprintProfile } from '../types';
import { useAppContext } from './AppContext';

interface Props { profiles?: FingerprintProfile[] }

export const FacebookLimits: React.FC<Props> = ({ profiles: propProfiles }) => {
  const ctx = useAppContext();
  const profiles = propProfiles ?? ctx.profiles;
  const { t } = useTranslation();
  const [profileId, setProfileId] = useState<string>('');
  const [accounts, setAccounts] = useState<Array<{ id: string; account_id: string; name: string }>>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const storageUrl = useMemo(() => {
    const u = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
    return String(u || '').replace(/\/$/, '');
  }, []);

  useEffect(() => {
    const firstMeta = profiles.find(p => p.platform?.includes('Meta')) || profiles[0];
    if (firstMeta) setProfileId(firstMeta.id);
  }, [profiles]);

  useEffect(() => {
    if (!profileId) return;
    setLoadingAccounts(true);
    setAccounts([]);
    setSelectedAccountId('');
    fetch(`${storageUrl}/api/facebook/graph-info?profileId=${encodeURIComponent(profileId)}`)
      .then(r => r.json())
      .then(json => {
        const list = (((json||{}).data||{}).adAccounts||{}).data || [];
        const mapped = list.map((a: any) => ({ id: String(a.id||''), account_id: String(a.account_id||''), name: String(a.name||'') }));
        setAccounts(mapped);
      })
      .catch(() => {})
      .finally(() => setLoadingAccounts(false));
  }, [profileId, storageUrl]);

  const loadLimits = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const acc = selectedAccountId || '';
      if (!acc) throw new Error('missing account');
      const url = `${storageUrl}/api/facebook/account-limits?profileId=${encodeURIComponent(profileId)}&accountId=${encodeURIComponent(acc)}`;
      const r = await fetch(url);
      const json = await r.json();
      if (!json || !json.success) throw new Error(String((json&&json.message)||'error'));
      setResult(json.data || null);
    } catch (e: any) {
      setError(String(e && e.message || e || 'error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-white">{t('limits.title')}</h2>
        <p className="text-slate-400">{t('limits.subtitle')}</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <div className="space-y-3">
            <label className="block text-sm text-slate-300">{t('limits.selectProfile')}</label>
            <select value={profileId} onChange={e=>setProfileId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200">
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>

            <label className="block text-sm text-slate-300">{t('limits.selectAccount')}</label>
            <select disabled={loadingAccounts || accounts.length===0} value={selectedAccountId} onChange={e=>setSelectedAccountId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200">
              <option value="">{loadingAccounts ? t('limits.loadingAccounts') : t('limits.pickAccount')}</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name} ({a.account_id || a.id})</option>
              ))}
            </select>

            <button onClick={loadLimits} disabled={!selectedAccountId || loading} className="px-3 py-2 rounded bg-indigo-600 text-white text-sm disabled:opacity-50">
              {t('limits.fetch')}
            </button>
            {error && <div className="text-red-500 text-sm">{error}</div>}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          {!result ? (
            <div className="text-slate-400 text-sm">{t('limits.empty')}</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-slate-400 text-xs">{t('limits.fields.accountName')}</div>
                  <div className="text-slate-200 text-sm">{String(result.name||'')}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs">{t('limits.fields.accountId')}</div>
                  <div className="text-slate-200 text-sm">{String(result.account_id||result.id||'')}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs">{t('limits.fields.currency')}</div>
                  <div className="text-slate-200 text-sm">{String(result.currency||'')}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs">{t('limits.fields.accountStatus')}</div>
                  <div className="text-slate-200 text-sm">{String(result.account_status||'')}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs">{t('limits.fields.amountSpent')}</div>
                  <div className="text-slate-200 text-sm">{String(result.amount_spent||'')}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs">{t('limits.fields.spendCap')}</div>
                  <div className="text-slate-200 text-sm">{String(result.spend_cap||'')}</div>
                </div>
              </div>
              {result.funding_source_details && (
                <div className="mt-2">
                  <div className="text-slate-400 text-xs">{t('limits.fields.fundingSource')}</div>
                  <div className="text-slate-200 text-sm">{String((result.funding_source_details||{}).display_string||'')}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
