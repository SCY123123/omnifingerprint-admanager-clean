import React, { useState, useEffect } from 'react';
import { 
  FileText, Pencil, Trash2, Plus, Search, RefreshCw
} from 'lucide-react';
import { FacebookAdPublisher } from './FacebookAdPublisher';

interface AdTemplate {
  id: number;
  name: string;
  is_default: number;
  config: string;
  updated_at: string;
}

const CACHE_KEY = 'omnifingerprint_ad_templates_cache';

export const TemplateManager: React.FC<{ token?: string | null }> = ({ token }) => {
  const [templates, setTemplates] = useState<AdTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTemplate, setEditingTemplate] = useState<AdTemplate | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPublisher, setShowPublisher] = useState(false);

  // 静默同步：从服务器拉取模板列表并更新 localStorage
  const silentSync = async () => {
    try {
      const authToken = token || localStorage.getItem('auth_token');
      if (!authToken) return;
      const r = await fetch('/api/ad-templates', {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const j = await r.json();
      if (j.success) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(j.data));
        setTemplates(j.data);
      }
    } catch {}
  };

  const fetchTemplates = async () => {
    // 先读本地缓存 -> 立即显示
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setTemplates(parsed);
        }
      }
    } catch {}
    setLoading(false);
    // 后台静默同步
    try {
      const authToken = token || localStorage.getItem('auth_token');
      const response = await fetch('/api/ad-templates', {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (data.success) {
        setTemplates(data.data);
        localStorage.setItem(CACHE_KEY, JSON.stringify(data.data));
      }
    } catch (error) {
      console.error('Failed to fetch templates:', error);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, [token]);

  const handleOpenEditor = (template: AdTemplate | null) => {
    setEditingTemplate(template);
    setShowPublisher(true);
  };

  const deleteTemplate = async (id: number) => {
    if (!window.confirm('确定要删除该模板吗？')) return;
    try {
      const authToken = token || localStorage.getItem('auth_token');
      const response = await fetch(`/api/ad-templates/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (data.success) {
        // 更新本地缓存
        const updated = templates.filter(t => t.id !== id);
        localStorage.setItem(CACHE_KEY, JSON.stringify(updated));
        setTemplates(updated);
      }
    } catch (error) {
      alert('删除失败');
    }
  };

  const filteredTemplates = templates.filter(tpl => 
    tpl.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-white">广告发布模板管理</h2>
          <p className="text-slate-400">管理发布广告时的默认配置参数，提升操作效率</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={silentSync}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition-colors"
            title="静默刷新"
          >
            <RefreshCw className="w-3.5 h-3.5" /> 刷新
          </button>
          <button
            onClick={() => handleOpenEditor(null)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-all"
          >
            <Plus className="w-4 h-4" />
            新建模板
          </button>
        </div>
      </div>

      <div className="mb-6 relative">
        <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          placeholder="搜索模板名称..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"
        />
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 font-medium">
              <tr>
                <th className="px-6 py-4">模板名称</th>
                <th className="px-6 py-4">状态</th>
                <th className="px-6 py-4">最近更新</th>
                <th className="px-6 py-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {loading ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-500">加载中...</td></tr>
              ) : filteredTemplates.length === 0 ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-500">未找到相关模板</td></tr>
              ) : (
                filteredTemplates.map((tpl) => (
                  <tr key={tpl.id} className="hover:bg-slate-800/50 transition-colors group">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                          <FileText className="w-4 h-4" />
                        </div>
                        <div className="text-slate-200 font-medium">{tpl.name}</div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {tpl.is_default === 1 ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                          默认使用
                        </span>
                      ) : (
                        <span className="text-slate-600 text-[10px] font-medium uppercase tracking-widest">普通</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-slate-500 font-mono text-xs">
                      {new Date(tpl.updated_at).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleOpenEditor(tpl)}
                          className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                          title="编辑配置"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => deleteTemplate(tpl.id)}
                          className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors"
                          title="删除模板"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showPublisher && (
        <FacebookAdPublisher
          templateMode
          initialTemplate={editingTemplate}
          profileIds={['template']}
          onCancel={() => { setShowPublisher(false); setEditingTemplate(null); }}
          onConfirm={() => { setShowPublisher(false); setEditingTemplate(null); fetchTemplates(); }}
        />
      )}
    </div>
  );
};
