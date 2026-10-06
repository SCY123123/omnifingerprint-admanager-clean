import React, { useState, useEffect } from 'react';
import { Globe, RefreshCw, Plus, Pencil, Trash2, X } from 'lucide-react';

const CACHE_KEY = 'omnifingerprint_billing_template_cache';

interface BillingData {
  country: string;
  currency: string;
  timezone: string;
  lang: string;
  business_name: string;
}
interface NamedTemplate {
  name: string;
  data: BillingData;
}

const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', DE: 'EUR', FR: 'EUR', IT: 'EUR',
  ES: 'EUR', NL: 'EUR', JP: 'JPY', SG: 'SGD', HK: 'HKD', KR: 'KRW', TW: 'TWD',
  IN: 'INR', BR: 'BRL', MX: 'MXN', CH: 'CHF', NZ: 'NZD', ZA: 'ZAR', AE: 'AED',
  SA: 'SAR', IL: 'ILS', TR: 'TRY', RU: 'RUB', PL: 'PLN', TH: 'THB', VN: 'VND',
  ID: 'IDR', MY: 'MYR', PH: 'PHP', IE: 'EUR', PT: 'EUR', GR: 'EUR', CZ: 'CZK',
  HU: 'HUF', RO: 'RON', BG: 'BGN', UA: 'UAH', SE: 'SEK', NO: 'NOK', DK: 'DKK',
};
const TZ_OPTIONS = [
  { label: '(GMT-12:00) Baker Island', val: '3' },
  { label: '(GMT-11:00) Pago Pago', val: '3' },
  { label: '(GMT-10:00) Honolulu', val: '3' },
  { label: '(GMT-08:00) Anchorage', val: '4' },
  { label: '(GMT-07:00) Los Angeles', val: '1' },
  { label: '(GMT-06:00) Denver', val: '2' },
  { label: '(GMT-05:00) Chicago', val: '6' },
  { label: '(GMT-04:00) New York', val: '7' },
  { label: '(GMT-03:00) Halifax', val: '37' },
  { label: '(GMT-03:00) Brasilia', val: '25' },
  { label: '(GMT-02:00) Noronha', val: '22' },
  { label: '(GMT+00:00) Azores', val: '109' },
  { label: '(GMT+01:00) London', val: '58' },
  { label: '(GMT+02:00) Paris', val: '57' },
  { label: '(GMT+03:00) Athens', val: '60' },
  { label: '(GMT+03:00) Moscow', val: '116' },
  { label: '(GMT+04:00) Dubai', val: '8' },
  { label: '(GMT+05:00) Karachi', val: '105' },
  { label: '(GMT+05:30) New Delhi', val: '71' },
  { label: '(GMT+06:00) Dhaka', val: '17' },
  { label: '(GMT+07:00) Bangkok', val: '132' },
  { label: '(GMT+08:00) Taipei', val: '136' },
  { label: '(GMT+09:00) Tokyo', val: '77' },
  { label: '(GMT+10:00) Sydney', val: '15' },
  { label: '(GMT+11:00) Noumea', val: '24' },
  { label: '(GMT+12:00) Auckland', val: '100' },
];
const inputCls = 'w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm';
const labelCls = 'text-xs text-slate-400 mb-0.5 block';

export const BillingTemplateManager: React.FC = () => {
  const [templates, setTemplates] = useState<NamedTemplate[]>([]);
  const [activeName, setActiveName] = useState('');
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | undefined>(undefined);
  const [form, setForm] = useState<BillingData>({ country: 'US', currency: 'USD', timezone: '1', lang: '', business_name: '' });

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
      await fetch(`${getBase()}/api/publish-configs/billing`, {
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
      const r = await fetch(`${getBase()}/api/publish-configs/billing`, {
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

  const load = async () => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const v = JSON.parse(cached);
        if (v.templates) { setTemplates(v.templates); setActiveName(v.activeTemplate || ''); }
      }
    } catch {}
    setLoading(false);
    await silentSync();
  };
  useEffect(() => { load(); }, []);

  const openNew = () => {
    setEditingIdx(undefined);
    setForm({ country: 'US', currency: 'USD', timezone: '1', lang: '' });
    setShowModal(true);
  };

  const openEdit = (idx: number) => {
    setEditingIdx(idx);
    setForm({ ...templates[idx].data });
    setShowModal(true);
  };

  const saveModal = async () => {
    const name = editingIdx !== undefined ? templates[editingIdx].name : `账单模板 ${templates.length + 1}`;
    const newTpl: NamedTemplate = { name, data: { ...form } };
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

  if (loading) return <div className="p-6 text-slate-400">加载中...</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Globe className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-bold text-white">账单地址模板</h1>
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
              <th className="px-6 py-4">配置</th>
              <th className="px-6 py-4">状态</th>
              <th className="px-6 py-4 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {templates.length === 0 ? (
              <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-500">暂无模板，点击右上角「新建模板」创建</td></tr>
            ) : templates.map((tpl, idx) => (
              <tr key={idx} className={`hover:bg-slate-800/50 transition-colors ${activeName === tpl.name ? 'bg-emerald-500/5' : ''}`}>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="text-slate-200 font-medium">{tpl.name}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-slate-400 font-mono text-xs">
                  {tpl.data.country} / {tpl.data.currency} / TZ{tpl.data.timezone} / {tpl.data.lang} / {tpl.data.business_name || '（无公司名）'}
                </td>
                <td className="px-6 py-4">
                  {activeName === tpl.name ? (
                    <span className="text-[10px] px-2 py-0.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded font-medium">使用中</span>
                  ) : (
                    <button onClick={() => setActive(tpl.name)} className="text-[10px] px-2 py-1 bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 rounded-lg">启用</button>
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
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-medium text-white">{editingIdx !== undefined ? '编辑模板' : '新建模板'}</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>国家</label>
                  <select value={form.country} onChange={e => setForm(p => ({ ...p, country: e.target.value, currency: COUNTRY_CURRENCY[e.target.value] || p.currency }))} className={inputCls}>
                    {Object.keys(COUNTRY_CURRENCY).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>货币</label>
                  <select value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))} className={inputCls}>
                    {[...new Set(Object.values(COUNTRY_CURRENCY))].sort().map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>时区</label>
                  <select value={form.timezone} onChange={e => setForm(p => ({ ...p, timezone: e.target.value }))} className={inputCls}>
                    {TZ_OPTIONS.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>FB界面语言</label>
                  <select value={form.lang} onChange={e => setForm(p => ({ ...p, lang: e.target.value }))} className={inputCls}>
                    <option value="">不修改</option>
                    <option value="en_US">English (US)</option>
                    <option value="zh_CN">简体中文</option>
                    <option value="es_ES">Español (ES)</option>
                    <option value="fr_FR">Français (FR)</option>
                    <option value="pt_BR">Português (BR)</option>
                    <option value="de_DE">Deutsch (DE)</option>
                    <option value="it_IT">Italiano (IT)</option>
                    <option value="ja_JP">日本語</option>
                    <option value="ko_KR">한국어</option>
                    <option value="th_TH">ภาษาไทย</option>
                    <option value="vi_VN">Tiếng Việt</option>
                    <option value="id_ID">Bahasa Indonesia</option>
                    <option value="ms_MY">Bahasa Melayu</option>
                    <option value="ar_AR">العربية</option>
                    <option value="tr_TR">Türkçe</option>
                    <option value="ru_RU">Русский</option>
                    <option value="pl_PL">Polski</option>
                    <option value="nl_NL">Nederlands</option>
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>公司名称（账单）</label>
                <input value={form.business_name} onChange={e => setForm(p => ({ ...p, business_name: e.target.value }))}
                  placeholder="留空不修改" className={inputCls} />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setShowModal(false)} className="px-4 py-2 bg-slate-800 text-slate-200 rounded-xl hover:bg-slate-700 text-sm">取消</button>
                <button onClick={saveModal} className="px-5 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 text-sm font-medium">保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
