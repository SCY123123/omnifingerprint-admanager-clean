import React, { useState } from 'react';
import { LOCAL_SERVER_SECRET, getLaunchServerUrl, selectionKeyOf, TZ_OPTIONS } from '../utils/constants';
import type { BusinessRow } from '../types';

interface CreateAdAccountDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sortedData: BusinessRow[];
  selectedIds: Set<string>;
  uniqueIdKey: string;
  onRefresh: () => void;
}

export const CreateAdAccountDialog: React.FC<CreateAdAccountDialogProps> = ({
  isOpen, onClose, sortedData, selectedIds, uniqueIdKey, onRefresh
}) => {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [timezone, setTimezone] = useState('1');
  const [count, setCount] = useState('1');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    // ⚠️ selectedIds 存的是「配置ID::资产ID」复合键，必须用同一个键匹配
    const bmItems = sortedData.filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)) && (item.bmId || item.businessId));
    if (bmItems.length === 0) { setError('请先在 BM 列表中勾选目标 BM'); return; }
    if (!name) { setError('请输入广告账户名称'); return; }
    const lurl = getLaunchServerUrl();
    setLoading(true); setError('');
    try {
      let successCount = 0;
      for (const bm of bmItems) {
        const bmId = String(bm.bmId || bm.businessId || bm.id || '');
        const pid = String(bm.profileId || bm.profile_id || '');
        const cnt = Math.max(1, Math.min(10, Number(count) || 1));
        for (let i = 0; i < cnt; i++) {
          const n = cnt > 1 ? `${name}-${i+1}` : name;
          try {
            const resp = await fetch(`${lurl}/api/facebook/businesses/create-adaccount`, {
              method:'POST', headers:{'Content-Type':'application/json','X-Api-Secret':LOCAL_SERVER_SECRET},
              body: JSON.stringify({ profileId: pid, businessId: bmId, name: n, timezoneId: Number(timezone), currency })
            });
            const json = await resp.json();
            if (json.success) successCount++;
          } catch {}
        }
      }
      if (successCount > 0) {
        alert(`成功创建 ${successCount} 个广告账户`);
        setName(''); setCurrency('USD'); setTimezone('1'); setCount('1');
        onClose();
        onRefresh();
      } else {
        setError('创建失败，请检查 BM 是否勾选正确');
      }
    } finally { setLoading(false); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">创建广告账户（BM 下）</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-300 mb-1">选择 BM</label>
            <p className="text-xs text-slate-500 mb-2">请先在 BM 列表中勾选目标 BM，再点击此按钮</p>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">广告账户名称</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="My Ad Account" className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm text-slate-300 mb-1">货币</label>
              <select value={currency} onChange={e => setCurrency(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                {['USD','EUR','GBP','JPY','CNY','AUD','CAD','BRL','INR','KRW','MXN','TWD','SGD','HKD','NZD','CHF','SEK','NOK','DKK','PLN','TRY','ZAR'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-1">时区</label>
              {/* 🐛 原来是个自由文本输入框、默认值 '0'，而 Meta 的 POST /{bm}/adaccount 要求
                  timezone_id 是有效的时区枚举（从 1 开始），传 0 会直接报
                  (#100) Must include a valid timezone ID、广告号建不出来。
                  这里改用项目里已有的权威枚举表（与「修改时区」对话框同源）。 */}
              <select value={timezone} onChange={e => setTimezone(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
                {TZ_OPTIONS.map(tz => <option key={tz.val} value={tz.val}>{tz.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">创建数量</label>
            <input type="number" min="1" max="10" value={count} onChange={e => setCount(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm" />
          </div>
          {error && <div className="text-rose-400 text-sm">{error}</div>}
          <button onClick={handleCreate} disabled={loading || !name} className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-50">{loading ? '创建中…' : '创建'}</button>
        </div>
      </div>
    </div>
  );
};
