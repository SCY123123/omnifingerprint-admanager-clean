import React, { useState, useEffect, useMemo } from 'react';
import { CreditCard, Search, RefreshCw, Plus, Pencil, Trash2, X } from 'lucide-react';

const CACHE_KEY = 'omnifingerprint_card_template_cache';

interface CardData {
  selectedCardIds: string[];
  iterateMode: 'all' | 'cycle';
}
interface NamedTemplate {
  name: string;
  data: CardData;
}

interface CardRow {
  id?: string; card_id?: string; alias?: string; cardNumber?: string;
  holder?: string; channel?: string; tags?: string[];
}

const inputCls = 'w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm';

export const CardBindTemplateManager: React.FC = () => {
  const [templates, setTemplates] = useState<NamedTemplate[]>([]);
  const [activeName, setActiveName] = useState('');
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | undefined>(undefined);

  // 弹窗内编辑状态
  const [localCards, setLocalCards] = useState<CardRow[]>([]);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [iterateMode, setIterateMode] = useState<'all' | 'cycle'>('cycle');
  const [cardSearch, setCardSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  const allChannels = useMemo(() => {
    const set = new Set<string>();
    localCards.forEach(c => { if (c.channel) set.add(c.channel); });
    return Array.from(set).sort();
  }, [localCards]);
  const allTags = useMemo(() => {
    const set = new Set<string>();
    localCards.forEach(c => (c.tags||[]).forEach(t => set.add(t)));
    return Array.from(set).sort();
  }, [localCards]);

  const filteredCards = localCards.filter(c => {
    const q = cardSearch.toLowerCase();
    if (q && !(c.alias||'').toLowerCase().includes(q) && !(c.cardNumber||'').includes(q) && !(c.channel||'').toLowerCase().includes(q)) return false;
    if (channelFilter && c.channel !== channelFilter) return false;
    if (tagFilter && !(c.tags||[]).includes(tagFilter)) return false;
    return true;
  });

  const getBase = () => {
    const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
    return String(serverUrl || '').replace(/\/$/, '');
  };
  const getAuthToken = () => localStorage.getItem('auth_token');

  const persist = async (tpls: NamedTemplate[], active: string) => {
    const payload = { templates: tpls, activeTemplate: active };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    try {
      const authToken = getAuthToken();
      await fetch(`${getBase()}/api/publish-configs/card`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ value: payload })
      });
    } catch {}
  };

  const silentSync = async () => {
    try {
      const authToken = getAuthToken();
      if (!authToken) return;
      const r = await fetch(`${getBase()}/api/publish-configs/card`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const j = await r.json();
      if (j.success && j.data?.value) {
        const v = j.data.value;
        if (v.templates) { setTemplates(v.templates); setActiveName(v.activeTemplate || ''); }
        localStorage.setItem(CACHE_KEY, JSON.stringify(v));
      }
    } catch {}
  };

  // 静默同步卡片列表（从 billingMethodsByProfile + 服务器合并）
  const syncCards = async () => {
    const all: CardRow[] = [];
    // 1. 从 localStorage billingMethodsByProfile
    try {
      const stored = localStorage.getItem('billingMethodsByProfile');
      if (stored) {
        const byProfile = JSON.parse(stored);
        Object.values(byProfile).forEach((cards: any) => {
          if (Array.isArray(cards)) cards.forEach((c: any) => {
            const tags = Array.isArray(c.tags) ? c.tags : [];
            let holder = '', cardNum = '', cvvVal = '';
            try { const addr = typeof c.billing_address === 'string' ? JSON.parse(c.billing_address) : (c.billing_address || {}); holder = String(addr.holder || ''); cardNum = String(addr.number || ''); cvvVal = String(addr.cvv || ''); } catch {}
            all.push({ id: c.id || c.card_id || '', card_last4: c.last4 || '', brand: c.brand || '', status: c.status || 'pending_verification', exp_month: c.exp_month || '', exp_year: c.exp_year || '', zip: c.zip || '', channel: c.channel || '', tags, savedAt: c.savedAt || '', billing_address: typeof c.billing_address === 'string' ? c.billing_address : JSON.stringify(c.billing_address || ''), alias: c.alias || `末四位 ${c.last4 || '****'}`, cardNumber: cardNum, holder, cvv: cvvVal });
          });
        });
      }
    } catch {}
    // 2. 从服务器 API
    try {
      const sbase = getBase();
      const authToken = getAuthToken();
      if (authToken) {
        const resp = await fetch(`${sbase}/api/billing-methods`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (resp.ok) {
          const json = await resp.json();
          const listData = Array.isArray(json?.data) ? json.data : [];
          listData.forEach((x: any) => {
            if (all.some(e => e.id === String(x.id))) return;
            let holder = '', cardNum = '', cvvVal = '', zip = '', channel = ''; let tags: string[] = [];
            try { const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {}); holder = String(addr.holder || ''); cardNum = String(addr.number || ''); cvvVal = String(addr.cvv || ''); tags = Array.isArray(addr.tags) ? addr.tags.map(String) : []; zip = String(addr.zip || ''); channel = String(addr.channel || ''); } catch {}
            all.push({ id: String(x.id || `srv_${Date.now()}`), card_last4: x.last4 || '', brand: x.brand || '', status: x.status || 'active', exp_month: String(x.exp_month || '').padStart(2,'0'), exp_year: String(x.exp_year || ''), zip, channel, tags, cardNumber: cardNum, holder, cvv: cvvVal, savedAt: x.created_at || '', alias: `末四位 ${x.last4 || '****'}` });
          });
        }
      }
    } catch {}
    // 保存到 local-cards
    localStorage.setItem('local-cards', JSON.stringify(all));
    setLocalCards(all);
  };

  const load = async () => {
    // 先读 local-cards 缓存
    try { const raw = localStorage.getItem('local-cards'); if (raw) setLocalCards(JSON.parse(raw)); } catch {}
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const v = JSON.parse(cached);
        if (v.templates) { setTemplates(v.templates); setActiveName(v.activeTemplate || ''); }
      }
    } catch {}
    setLoading(false);
    // 静默同步卡片
    await syncCards();
    // 静默同步模板
    await silentSync();
  };
  useEffect(() => { load(); }, []);

  const openNew = () => {
    setEditingIdx(undefined);
    setSelectedCardIds(new Set());
    setIterateMode('all');
    setCardSearch(''); setChannelFilter(''); setTagFilter('');
    setShowModal(true);
  };

  const openEdit = (idx: number) => {
    setEditingIdx(idx);
    const d = templates[idx].data;
    setSelectedCardIds(new Set(d.selectedCardIds || []));
    setIterateMode(d.iterateMode || 'all');
    setCardSearch(''); setChannelFilter(''); setTagFilter('');
    setShowModal(true);
  };

  const saveModal = async () => {
    const name = editingIdx !== undefined ? templates[editingIdx].name : `绑卡模板 ${templates.length + 1}`;
    const newData: CardData = { selectedCardIds: Array.from(selectedCardIds), iterateMode };
    const newTpl: NamedTemplate = { name, data: newData };
    let nu: NamedTemplate[];
    let active = activeName;
    if (editingIdx !== undefined) {
      nu = templates.map((t, i) => i === editingIdx ? newTpl : t);
      active = nu[editingIdx].name;
    } else {
      nu = [...templates, newTpl];
      active = newTpl.name;
    }
    setTemplates(nu);
    setActiveName(active);
    setShowModal(false);
    await persist(nu, active);
  };

  const deleteTemplate = async (idx: number) => {
    if (!window.confirm(`确定删除「${templates[idx].name}」？`)) return;
    const nu = templates.filter((_, i) => i !== idx);
    let active = activeName;
    if (active === templates[idx].name || !nu.find(t => t.name === active)) {
      active = nu.length > 0 ? nu[0].name : '';
    }
    setTemplates(nu);
    setActiveName(active);
    await persist(nu, active);
  };

  const rename = async (idx: number) => {
    const name = prompt('新名称：', templates[idx].name);
    if (!name || name === templates[idx].name) return;
    const nu = templates.map((t, i) => i === idx ? { ...t, name } : t);
    const active = activeName === templates[idx].name ? name : activeName;
    setTemplates(nu);
    setActiveName(active);
    await persist(nu, active);
  };

  const setActive = async (name: string) => {
    setActiveName(name);
    await persist(templates, name);
  };

  const toggleCard = (id: string) => {
    setSelectedCardIds(prev => { const nu = new Set(prev); if (nu.has(id)) nu.delete(id); else nu.add(id); return nu; });
  };

  // 选择渠道或标签筛选时自动全选所有匹配卡片
  useEffect(() => {
    if (channelFilter || tagFilter) {
      const ids = filteredCards.map(c => c.id || c.card_id || '').filter(Boolean);
      setSelectedCardIds(new Set(ids));
    }
  }, [channelFilter, tagFilter]);

  if (loading) return <div className="p-6 text-slate-400">加载中...</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <CreditCard className="w-6 h-6 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">绑卡表单模板</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={silentSync} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs"><RefreshCw className="w-3.5 h-3.5" /> 刷新</button>
          <button onClick={openNew} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm"><Plus className="w-4 h-4" /> 新建模板</button>
        </div>
      </div>

      {/* 模板列表表格 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950 text-slate-400 font-medium">
            <tr>
              <th className="px-6 py-4">模板名称</th>
              <th className="px-6 py-4">卡片配置</th>
              <th className="px-6 py-4">状态</th>
              <th className="px-6 py-4 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {templates.length === 0 ? (
              <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-500">暂无模板，点击右上角「新建模板」创建</td></tr>
            ) : templates.map((tpl, idx) => (
              <tr key={idx} className={`hover:bg-slate-800/50 transition-colors ${activeName === tpl.name ? 'bg-amber-500/5' : ''}`}>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="text-slate-200 font-medium">{tpl.name}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-xs text-slate-400">
                  {tpl.data.selectedCardIds?.length || 0} 张卡片
                  {tpl.data.iterateMode === 'cycle' ? ' · 遍历分配' : ' · 全部绑定'}
                </td>
                <td className="px-6 py-4">
                  {activeName === tpl.name ? (
                    <span className="text-[10px] px-2 py-0.5 bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded font-medium">使用中</span>
                  ) : (
                    <button onClick={() => setActive(tpl.name)} className="text-[10px] px-2 py-1 bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 rounded-lg">启用</button>
                  )}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => rename(idx)} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => openEdit(idx)} className="px-2.5 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg">编辑</button>
                    <button onClick={() => deleteTemplate(idx)} className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 编辑弹窗 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-white">{editingIdx !== undefined ? '编辑模板' : '新建模板'}</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              {/* 筛选栏 */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[120px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                  <input value={cardSearch} onChange={e => setCardSearch(e.target.value)} placeholder="搜索别名/卡号..." className={`${inputCls} pl-8 text-xs`} />
                </div>
                <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)} className={`${inputCls} text-xs w-auto`}>
                  <option value="">渠道</option>
                  {allChannels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
                </select>
                <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} className={`${inputCls} text-xs w-auto`}>
                  <option value="">标签</option>
                  {allTags.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-slate-400 whitespace-nowrap">
                  <input type="checkbox" checked={iterateMode === 'cycle'} onChange={e => setIterateMode(e.target.checked ? 'cycle' : 'all')} className="rounded border-slate-600 bg-slate-800 text-indigo-600 w-3.5 h-3.5" />
                  遍历分配
                </label>
              </div>
              {/* 卡片列表 */}
              <div className="max-h-52 overflow-y-auto custom-scrollbar rounded-lg border border-slate-700 divide-y divide-slate-700/50">
                {filteredCards.length === 0 ? (
                  <div className="p-4 text-center text-slate-500 text-xs">暂无匹配卡片</div>
                ) : filteredCards.map(card => {
                  const cid = card.id || card.card_id || '';
                  return (
                    <label key={cid} className={`flex items-center gap-2 px-3 py-2 cursor-pointer ${selectedCardIds.has(cid) ? 'bg-indigo-500/15' : 'hover:bg-slate-800/50'}`}>
                      <input type="checkbox" checked={selectedCardIds.has(cid)} onChange={() => toggleCard(cid)} className="rounded border-slate-600 bg-slate-800 text-indigo-600 w-3 h-3" />
                      <CreditCard className="w-3 h-3 text-slate-400 shrink-0" />
                      <span className="text-xs text-white font-mono">{card.alias || (card.cardNumber ? card.cardNumber.slice(-4).padStart(4,'•') : cid.slice(0,8))}</span>
                      {card.channel && <span className="text-[10px] bg-slate-700 text-slate-300 px-1 rounded">{card.channel}</span>}
                      {(card.tags||[]).map(t => <span key={t} className="text-[10px] bg-indigo-600/20 text-indigo-300 px-1 rounded">{t}</span>)}
                    </label>
                  );
                })}
              </div>
              {/* 底部信息 */}
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-slate-400">已选 <span className="text-indigo-400 font-medium">{selectedCardIds.size}</span> 张</span>
                <div className="flex gap-3">
                  <button onClick={() => setShowModal(false)} className="px-4 py-2 bg-slate-800 text-slate-200 rounded-xl hover:bg-slate-700 text-sm">取消</button>
                  <button onClick={saveModal} className="px-5 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 text-sm font-medium">保存</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
