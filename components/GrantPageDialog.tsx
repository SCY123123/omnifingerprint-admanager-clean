import React, { useState } from 'react';
import { LOCAL_SERVER_SECRET, getLaunchServerUrl } from '../utils/constants';
import type { PageRow, BusinessRow } from '../types';

interface GrantPageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  pagesDb: PageRow[];
  businessesDb: BusinessRow[];
  defaultProfileId: string;
  onRefresh: () => void;
}

export const GrantPageDialog: React.FC<GrantPageDialogProps> = ({
  isOpen, onClose, pagesDb, businessesDb, defaultProfileId, onRefresh
}) => {
  const [grantPageId, setGrantPageId] = useState('');
  const [grantBmId, setGrantBmId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleGrant = async () => {
    if (!grantPageId || !grantBmId) { setError('请输入主页 ID 和 BM ID'); return; }
    const lurl = getLaunchServerUrl();
    try {
      setCreating(true); setError('');
      const resp = await fetch(`${lurl}/api/facebook/businesses/grant-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ profileId: defaultProfileId, pageId: grantPageId, businessId: grantBmId })
      });
      const json = await resp.json();
      if (json.success) {
        alert(`主页 ${grantPageId} 已成功授权给 BM ${grantBmId}`);
        setGrantPageId('');
        setGrantBmId('');
        onClose();
        onRefresh();
      } else {
        setError(`授权失败: ${json.message || '未知错误'}`);
      }
    } catch (e) { setError(`请求失败: ${(e as Error).message}`); }
    finally { setCreating(false); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">授权主页给BM</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-300 mb-1">主页 ID</label>
            <input value={grantPageId} onChange={e => setGrantPageId(e.target.value)} placeholder="输入主页 ID" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
          </div>
          {pagesDb.filter(p => grantPageId === '' || p.pageId === grantPageId).slice(0, 5).map(p => (
            <div key={p.pageId} className="text-xs text-slate-400">{p.pageId} — {p.pageName}</div>
          ))}
          <div>
            <label className="block text-sm text-slate-300 mb-1">BM ID</label>
            <input value={grantBmId} onChange={e => setGrantBmId(e.target.value)} placeholder="输入 BM ID" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
          </div>
          {businessesDb.filter(b => grantBmId === '' || b.bmId === grantBmId).slice(0, 5).map(b => (
            <div key={b.bmId} className="text-xs text-slate-400">{b.bmId} — {b.profileName}</div>
          ))}
          <p className="text-xs text-slate-500">授权后将允许 BM 管理该主页的广告投放</p>
          <div className="flex gap-2">
            <select value={grantPageId ? 'selected' : ''} onChange={e => { const pid = e.target.value; if (pid) setGrantPageId(pid); }} className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
              <option value="">从列表选主页</option>
              {pagesDb.slice(0, 20).map(p => <option key={p.pageId} value={p.pageId}>{p.pageName || p.pageId}</option>)}
            </select>
            <select value={grantBmId ? 'selected' : ''} onChange={e => { const bid = e.target.value; if (bid) setGrantBmId(bid); }} className="w-1/2 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
              <option value="">从列表选BM</option>
              {businessesDb.slice(0, 20).map(b => <option key={b.bmId} value={b.bmId}>{b.profileName || b.bmId}</option>)}
            </select>
          </div>
          {error && <div className="text-rose-400 text-sm">{error}</div>}
          <button onClick={handleGrant} disabled={creating || !grantPageId || !grantBmId} className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-50">{creating ? '授权中…' : '授权'}</button>
        </div>
      </div>
    </div>
  );
};
