import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, Server, Upload } from 'lucide-react';
import * as XLSX from 'xlsx';

const INIT_FORM = {type:'http',host:'',port:'',username:'',password:'',provider:'',zone:'',country:'',city:'',session:'',rotation:'',label:'',channel:'',category:'',raw:''};

export const ProxyManager: React.FC = () => {
  const { t } = useTranslation();
  const [items, setItems] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string>('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<typeof INIT_FORM>({...INIT_FORM});
  const [editId, setEditId] = useState<string>('');
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{success:number;errors:number} | null>(null);

  const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
  const base = String(serverUrl || '').replace(/\/$/, '');
  const CACHE_KEY = 'omnifingerprint_proxy_cache';

  // 静默同步：从服务器拉取数据并更新 localStorage（不显示 loading）
  const silentSync = async () => {
    try {
      const authToken = localStorage.getItem('auth_token');
      const r = await fetch(`${base}/api/proxies`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const j = await r.json();
      const data = Array.isArray(j?.data) ? j.data : [];
      // 对比缓存，有变化才更新 UI
      const old = JSON.stringify(items);
      const nu = JSON.stringify(data);
      if (nu !== old) setItems(data);
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch {}
  };

  // 首次加载：先读缓存（立即展示），再静默同步
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // 首次加载先读缓存
      if (firstLoad) {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          try { setItems(JSON.parse(cached)); } catch {}
        }
        setFirstLoad(false);
      }
      await silentSync();
    } catch {
      if (!silent) setItems([]);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const parseProxy = (s: string) => {
    const str = String(s||'').trim();
    if (!str) return {} as any;
    let type = 'http';
    let rest = str;
    const m = str.match(/^(https?|socks5|residential):\/\//i);
    if (m) { const sch = m[1].toLowerCase(); type = sch==='socks5'?'socks5':(sch==='residential'?'residential':'http'); rest = str.replace(/^(https?|socks5|residential):\/\//i,''); }
    let username = '', password = '', host = '', port = '', query = '';
    if (rest.includes('?')) { const parts = rest.split('?'); rest = parts[0]; query = parts[1]||''; }
    if (rest.includes('@')) {
      const [cred, hostpart] = rest.split('@');
      const [u,p] = cred.split(':'); username = u||''; password = p||'';
      const [h,pt] = hostpart.split(':'); host = h||''; port = pt||'';
    } else {
      const parts = rest.split(':');
      if (parts.length===2) { host = parts[0]; port = parts[1]; }
      if (parts.length===4) { host=parts[0]; port=parts[1]; username=parts[2]; password=parts[3]; }
    }
    const opts:any = {}; if (query) { const qs = new URLSearchParams(query); opts.zone = qs.get('zone')||''; opts.country = qs.get('country')||''; opts.city = qs.get('city')||''; opts.session = qs.get('session')||''; const rot = qs.get('rotation'); opts.rotation = rot==='sticky'?'sticky':(rot==='auto'?'auto':''); }
    return { type, host, port, username, password, zone: opts.zone, country: opts.country, city: opts.city, session: opts.session, rotation: opts.rotation };
  };

  const save = async () => {
    if (!form.host || !form.port) return;
    setSaving(true);
    try {
      const authToken = localStorage.getItem('auth_token');
      let payload:any = { ...form };
      delete payload.raw;
      if (editId) {
        await fetch(`${base}/api/proxies/${editId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify(payload) });
      } else {
        await fetch(`${base}/api/proxies`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify(payload) });
      }
      setForm({...INIT_FORM});
      setEditId('');
      setShowModal(false);
      await silentSync();
    } finally {
      setSaving(false);
    }
  };

  const smartParse = (raw: string): any[] => {
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const results: any[] = [];
    for (const line of lines) {
      // 跳过注释/标题行
      if (line.startsWith('#') || line.startsWith('//') || line.startsWith('类型') || line.startsWith('type') || line.startsWith('host') || line.startsWith('代理')) continue;
      // 尝试 tab/逗号分隔的结构化格式: type\thost\tport\tuser\tpass\tprovider\tcountry...
      if (line.includes('\t') || (line.includes(',') && line.split(',').length >= 3)) {
        const sep = line.includes('\t') ? '\t' : ',';
        const parts = line.split(sep).map(s => s.trim());
        if (parts.length >= 2) {
          results.push({ type: parts[0] || 'http', host: parts[1], port: parts[2] || '', username: parts[3] || '', password: parts[4] || '', provider: parts[5] || '', country: parts[6] || '', city: parts[7] || '', label: parts[8] || '', channel: parts[9] || '', category: parts[10] || '' });
          continue;
        }
      }
      // 标准代理格式: socks5://user:pass@host:port 或 host:port:user:pass 等
      const parsed = parseProxy(line);
      if (parsed.host && parsed.port) results.push({ ...parsed, provider: '', zone: '', country: '', city: '', session: '', rotation: '', label: '', channel: '', category: '' });
    }
    return results;
  };

  const handleImport = async (file: File) => {
    setImportResult(null);
    setImporting(true);
    try {
      const authToken = localStorage.getItem('auth_token');
      let items: any[] = [];

      if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        // Excel 解析
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
        const headers = rows[0]?.map((h: any) => String(h||'').toLowerCase().trim()) || [];
        const colMap: Record<string, number> = {};
        const knownKeys = ['type','host','port','username','password','proxy','provider','zone','country','city','session','rotation','label','channel','category'];
        for (const k of knownKeys) {
          const idx = headers.findIndex(h => h===k || h.includes(k) || k.includes(h));
          if (idx >= 0) colMap[k] = idx;
        }
        // 如果没匹配到列名，尝试用顺序: host, port, username, password
        if (!colMap.host && !colMap.proxy) {
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[0]) continue;
            const raw = String(row[0]||'').trim();
            if (raw.includes(':') || raw.includes('@')) {
              const parsed = parseProxy(raw);
              if (parsed.host) items.push({ ...parsed, label: String(row[1]||''), provider: String(row[2]||''), country: String(row[3]||''), channel: String(row[4]||''), category: String(row[5]||'') });
            } else if (row.length >= 2) {
              items.push({ type: String(row[0]||'http'), host: String(row[1]||''), port: String(row[2]||''), username: String(row[3]||''), password: String(row[4]||''), provider: String(row[5]||''), country: String(row[6]||''), city: String(row[7]||''), label: String(row[8]||''), channel: String(row[9]||''), category: String(row[10]||'') });
            }
          }
        } else {
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row) continue;
            const rawProxy = colMap.proxy !== undefined ? String(row[colMap.proxy]||'').trim() : '';
            if (rawProxy && (rawProxy.includes(':') || rawProxy.includes('@'))) {
              const base = parseProxy(rawProxy);
              const extra: any = {};
              for (const k of knownKeys) {
                if (k === 'proxy') continue;
                if (colMap[k] !== undefined) extra[k] = String(row[colMap[k]]||'');
              }
              items.push({ ...base, ...extra });
            } else {
              items.push({
                type: colMap.type !== undefined ? String(row[colMap.type]||'http') : 'http',
                host: colMap.host !== undefined ? String(row[colMap.host]||'') : '',
                port: colMap.port !== undefined ? String(row[colMap.port]||'') : '',
                username: colMap.username !== undefined ? String(row[colMap.username]||'') : '',
                password: colMap.password !== undefined ? String(row[colMap.password]||'') : '',
                provider: colMap.provider !== undefined ? String(row[colMap.provider]||'') : '',
                zone: colMap.zone !== undefined ? String(row[colMap.zone]||'') : '',
                country: colMap.country !== undefined ? String(row[colMap.country]||'') : '',
                city: colMap.city !== undefined ? String(row[colMap.city]||'') : '',
                session: colMap.session !== undefined ? String(row[colMap.session]||'') : '',
                rotation: colMap.rotation !== undefined ? String(row[colMap.rotation]||'') : '',
                label: colMap.label !== undefined ? String(row[colMap.label]||'') : '',
                channel: colMap.channel !== undefined ? String(row[colMap.channel]||'') : '',
                category: colMap.category !== undefined ? String(row[colMap.category]||'') : '',
              });
            }
          }
        }
      } else {
        // TXT/CSV 解析
        const text = await file.text();
        items = smartParse(text);
      }

      if (items.length === 0) {
        setImportResult({ success: 0, errors: 1 });
        setImporting(false);
        return;
      }

      const r = await fetch(`${base}/api/proxies/batch-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ items })
      });
      const j = await r.json();
      setImportResult({ success: j.imported || 0, errors: j.errors || 0 });
      await silentSync();
    } catch (e: any) {
      setImportResult({ success: 0, errors: 1 });
    } finally {
      setImporting(false);
    }
  };

  const test = async (it: any) => {
    setTestingId(String(it.id));
    try {
      const authToken = localStorage.getItem('auth_token');
      const r = await fetch(`${base}/api/proxies/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ host: it.host, port: it.port }) });
      const j = await r.json();
      setItems(prev => prev.map(p => p.id === it.id ? { ...p, testResult: j } : p));
    } finally {
      setTestingId('');
    }
  };

  const openAdd = () => {
    setForm({...INIT_FORM});
    setEditId('');
    setShowModal(true);
  };

  const openEdit = (it: any) => {
    setForm({ type: it.type||'http', host: it.host||'', port: String(it.port||''), username: it.username||'', password: it.password||'', provider: it.provider||'', zone: it.zone||'', country: it.country||'', city: it.city||'', session: it.session||'', rotation: it.rotation||'', label: it.label||'', channel: it.channel||'', category: it.category||'', raw: '' });
    setEditId(String(it.id));
    setShowModal(true);
  };

  const inputCls = 'w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-3 py-2';
  const labelCls = 'block text-sm text-slate-300 mb-1';

  return (
    <div className="max-w-6xl mx-auto px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-white">IP 代理管理</h2>
          <p className="text-slate-400 text-sm">管理所有代理配置，支持标签/渠道/分类标记</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => { silentSync(); }} className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-all" title="静默刷新，不显示加载状态">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
            刷新
          </button>
          <button onClick={()=>setShowImport(true)} className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-all">
            <Upload className="w-4 h-4" />
            导入代理
          </button>
          <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-all shadow-lg shadow-indigo-600/20">
            <Plus className="w-4 h-4" />
            添加代理
          </button>
        </div>
      </div>

      {/* Proxy List */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
        <div className="flex items-center justify-between mb-3">
          <div className="text-slate-200 font-medium">代理列表 ({items.length})</div>
        </div>
        {items.length === 0 ? (
          <div className="text-slate-400 text-sm py-8 text-center">
            {loading ? '加载中...' : '暂无代理，点击右上角"添加代理"按钮添加'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-950 text-slate-200">
                <tr>
                    <th className="px-4 py-2">标签</th>
                    <th className="px-4 py-2">ID</th>
                    <th className="px-4 py-2">类型</th>
                    <th className="px-4 py-2">主机:端口</th>
                    <th className="px-4 py-2">渠道</th>
                    <th className="px-4 py-2">分类</th>
                    <th className="px-4 py-2">提供商</th>
                    <th className="px-4 py-2">位置</th>
                    <th className="px-4 py-2">创建时间</th>
                    <th className="px-4 py-2">操作</th>
                    <th className="px-4 py-2">测试结果</th>
                  </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900 text-slate-300">
                {items.map(it => (
                  <tr key={it.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-4 py-2 font-medium text-slate-100">{it.label || '-'}</td>
                    <td className="px-4 py-2 text-xs text-slate-500 font-mono">{String(it.id).substring(0, 14)}...</td>
                    <td className="px-4 py-2">{it.type}</td>
                    <td className="px-4 py-2 font-mono text-xs">{it.host}:{it.port}</td>
                    <td className="px-4 py-2">{it.channel || '-'}</td>
                    <td className="px-4 py-2">{it.category || '-'}</td>
                    <td className="px-4 py-2">{it.provider || '-'}</td>
                    <td className="px-4 py-2">{[it.country, it.city].filter(Boolean).join(' / ') || '-'}</td>
                    <td className="px-4 py-2 text-xs text-slate-400">{it.created_at ? new Date(it.created_at).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '-'}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        <button onClick={()=>test(it)} disabled={testingId===it.id} className="px-2 py-1 text-xs rounded bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/40 disabled:opacity-50 transition-colors">测试</button>
                        <button onClick={()=>openEdit(it)} className="px-2 py-1 text-xs rounded bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors">编辑</button>
                        <button onClick={async()=>{ 
                          if (!window.confirm('确认删除该代理？')) return;
                          const authToken = localStorage.getItem('auth_token');
                          await fetch(`${base}/api/proxies/${it.id}`, { 
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${authToken}` }
                          }); 
                          await silentSync(); 
                        }} className="px-2 py-1 text-xs rounded bg-rose-600/20 text-rose-400 hover:bg-rose-600/40 transition-colors">删除</button>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {it.testResult ? (
                        it.testResult.success 
                          ? <span className="text-emerald-400">可用 ({it.testResult.latency}ms)</span>
                          : <span className="text-rose-400">不可用</span>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center p-6 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Server className="w-5 h-5 text-indigo-400" />
                <h3 className="text-lg font-bold text-white">{editId ? '编辑代理' : '添加代理'}</h3>
              </div>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-white transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6">
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>标签 (备注名)</label>
                  <input value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))} placeholder="如: 美国711-01" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>渠道</label>
                  <select value={form.channel} onChange={e=>setForm(f=>({...f,channel:e.target.value}))} className={inputCls}>
                    <option value="">不设置</option>
                    <option value="711Proxy">711Proxy</option>
                    <option value="IP2World">IP2World</option>
                    <option value="Proxy302">Proxy302</option>
                    <option value="BrightData">BrightData</option>
                    <option value="Oxylabs">Oxylabs</option>
                    <option value="SmartProxy">SmartProxy</option>
                    <option value="Soax">Soax</option>
                    <option value="其他">其他</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>分类</label>
                  <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} className={inputCls}>
                    <option value="">不设置</option>
                    <option value="机房IP">机房IP</option>
                    <option value="住宅IP">住宅IP</option>
                    <option value="移动IP">移动IP</option>
                    <option value="数据中心">数据中心</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>类型</label>
                  <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} className={inputCls}>
                    <option value="http">http</option>
                    <option value="socks5">socks5</option>
                    <option value="residential">residential</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className={labelCls}>代理字符串 (粘贴后自动解析填充下方字段)</label>
                  <input value={form.raw} onChange={e=>{
                    const v = e.target.value;
                    const parsed = v.trim() ? parseProxy(v) : {};
                    setForm(f=>({...f, raw: v, ...parsed }));
                  }} placeholder="支持: socks5://user:pass@host:port 或 host:port:user:pass 或 http://user:pass@host:port" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>主机</label>
                  <input value={form.host} onChange={e=>setForm(f=>({...f,host:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>端口</label>
                  <input value={form.port} onChange={e=>setForm(f=>({...f,port:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>用户名</label>
                  <input value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>密码</label>
                  <input value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>提供商</label>
                  <input value={form.provider} onChange={e=>setForm(f=>({...f,provider:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>国家</label>
                  <input value={form.country} onChange={e=>setForm(f=>({...f,country:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>城市</label>
                  <input value={form.city} onChange={e=>setForm(f=>({...f,city:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Zone</label>
                  <input value={form.zone} onChange={e=>setForm(f=>({...f,zone:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Session</label>
                  <input value={form.session} onChange={e=>setForm(f=>({...f,session:e.target.value}))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>轮换</label>
                  <select value={form.rotation} onChange={e=>setForm(f=>({...f,rotation:e.target.value}))} className={inputCls}>
                    <option value="">不设置</option>
                    <option value="auto">auto</option>
                    <option value="sticky">sticky</option>
                  </select>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button onClick={() => setShowModal(false)} className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white transition-colors">取消</button>
                <button onClick={save} disabled={saving} className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50 transition-all shadow-lg shadow-indigo-600/20">
                  {saving ? '保存中...' : (editId ? '更新' : '保存')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => { setShowImport(false); setImportResult(null); }}>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center p-6 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Upload className="w-5 h-5 text-indigo-400" />
                <h3 className="text-lg font-bold text-white">导入代理</h3>
              </div>
              <button onClick={() => { setShowImport(false); setImportResult(null); }} className="text-slate-400 hover:text-white transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="text-sm text-slate-400 space-y-1">
                <p>支持格式：</p>
                <ul className="list-disc list-inside space-y-0.5 text-slate-500">
                  <li><strong className="text-slate-300">TXT</strong> — 每行一个代理，支持 socks5://user:pass@host:port 或 host:port:user:pass</li>
                  <li><strong className="text-slate-300">Excel (.xlsx/.xls)</strong> — 自动识别列名 (host,port,username,password 等)，或按顺序识别</li>
                  <li><strong className="text-slate-300">CSV (逗号分隔)</strong> — 与 TXT 一样自动解析，支持 tab/逗号分隔的结构化数据</li>
                </ul>
              </div>
              <label className="block cursor-pointer">
                <div className="border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-xl p-8 text-center transition-colors">
                  <Upload className="w-10 h-10 mx-auto mb-3 text-slate-500" />
                  <p className="text-slate-300 font-medium">点击选择文件 或 拖放文件到这里</p>
                  <p className="text-xs text-slate-500 mt-1">支持 .txt / .xlsx / .xls / .csv</p>
                </div>
                <input type="file" accept=".txt,.xlsx,.xls,.csv" className="hidden" disabled={importing} onChange={async e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  await handleImport(file);
                  e.target.value = '';
                }} />
              </label>
              {importing && (
                <div className="flex items-center justify-center gap-2 text-slate-300">
                  <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  正在导入...
                </div>
              )}
              {importResult && (
                <div className={`p-4 rounded-xl text-sm ${importResult.errors > 0 && importResult.success === 0 ? 'bg-rose-600/20 text-rose-300' : 'bg-emerald-600/20 text-emerald-300'}`}>
                  {importResult.success > 0 ? `✅ 成功导入 ${importResult.success} 条代理` : ''}
                  {importResult.errors > 0 ? (importResult.success > 0 ? `，${importResult.errors} 条失败` : `❌ 导入失败，请检查文件格式`) : ''}
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button onClick={() => { setShowImport(false); setImportResult(null); }} className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white transition-colors">关闭</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
