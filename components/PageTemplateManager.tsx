import React, { useState, useEffect } from 'react';
import { FileText, Save, CheckCircle, RefreshCw, Plus, Pencil, Trash2 } from 'lucide-react';
import { PageCreator, PageCreationData } from './PageCreator';

const CACHE_KEY = 'omnifingerprint_page_template_cache';

interface NamedTemplate {
  name: string;
  data: PageCreationData;
}

export const PageTemplateManager: React.FC = () => {
  const [templates, setTemplates] = useState<NamedTemplate[]>([]);
  const [activeName, setActiveName] = useState('');
  const [loading, setLoading] = useState(true);
  const [showPageCreator, setShowPageCreator] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | undefined>(undefined);

  const getBase = () => {
    const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
    return String(serverUrl || '').replace(/\/$/, '');
  };
  const getAuthToken = () => localStorage.getItem('auth_token');

  // 写入缓存 + D1
  const persist = async (tpls: NamedTemplate[], active: string) => {
    const payload = { templates: tpls, activeTemplate: active };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    try {
      const authToken = getAuthToken();
      await fetch(`${getBase()}/api/publish-configs/page`, {
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
      const r = await fetch(`${getBase()}/api/publish-configs/page`, {
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

  // PageCreator 确认：新增或编辑模板
  const handleSave = async (data: PageCreationData) => {
    const name = data.name || `主页模板 ${templates.length + 1}`;
    const newTpl: NamedTemplate = { name, data };
    let nu: NamedTemplate[];
    if (editingIndex !== undefined) {
      nu = templates.map((t, i) => i === editingIndex ? newTpl : t);
    } else {
      nu = [...templates, newTpl];
    }
    setTemplates(nu);
    setActiveName(name);
    await persist(nu, name);
    setShowPageCreator(false);
    setEditingIndex(undefined);
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

  const setActive = async (name: string) => {
    setActiveName(name);
    await persist(templates, name);
  };

  if (loading) return <div className="p-6 text-slate-400">加载中...</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6 text-indigo-400" />
          <h1 className="text-2xl font-bold text-white">主页创建模板</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={silentSync} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition-colors" title="静默刷新">
            <RefreshCw className="w-3.5 h-3.5" /> 刷新
          </button>
          <button onClick={() => { setEditingIndex(undefined); setShowPageCreator(true); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition-all">
            <Plus className="w-4 h-4" /> 新建模板
          </button>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950 text-slate-400 font-medium">
            <tr><th className="px-6 py-4">模板名称</th><th className="px-6 py-4">分类</th><th className="px-6 py-4">网站</th><th className="px-6 py-4 text-right">操作</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {templates.length === 0 ? (
              <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-500">暂无模板，点击右上角「新建模板」创建</td></tr>
            ) : templates.map((tpl, idx) => (
              <tr key={idx} className={`hover:bg-slate-800/50 transition-colors ${activeName === tpl.name ? 'bg-indigo-500/10' : ''}`}>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400"><FileText className="w-4 h-4" /></div>
                    <span className="text-slate-200 font-medium">{tpl.name}</span>
                    {activeName === tpl.name && <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded">使用中</span>}
                  </div>
                </td>
                <td className="px-6 py-4 text-slate-400">{tpl.data.category}</td>
                <td className="px-6 py-4 text-slate-400">{tpl.data.website || '-'}</td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    {activeName !== tpl.name && <button onClick={() => setActive(tpl.name)} className="px-2.5 py-1 text-[10px] bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 rounded-lg">启用</button>}
                    <button onClick={() => { setEditingIndex(idx); setShowPageCreator(true); }} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => deleteTemplate(idx)} className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showPageCreator && (
        <PageCreator
          profileIds={['template']}
          initialData={editingIndex !== undefined ? templates[editingIndex].data : undefined}
          onCancel={() => { setShowPageCreator(false); setEditingIndex(undefined); }}
          onConfirm={handleSave}
        />
      )}
    </div>
  );
};
