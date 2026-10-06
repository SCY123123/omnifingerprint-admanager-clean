import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Store, RefreshCw, Loader2, Plus, Trash2, CheckCircle2, PackageCheck, Ban, Link2, Copy, Check, ClipboardList, Tag, Info, LogOut, KeyRound, ShoppingBag, AlertTriangle, Layers, Pencil, X } from 'lucide-react';

/**
 * 商城管理后台（独立入口 /#shop-admin，独立账号体系）
 * - 认证：商城专用账号（shop_admins 表），与主系统用户完全隔离；
 *         token 存 localStorage 的 shop_admin_token，与主系统 auth_token 互不相通
 * - 商品管理：新增/编辑/下架/删除；从 BM 一键上架（businesses 表里已提取到邀请链接的 BM）
 * - 订单管理：人工确认收款 → 发货（发货后买家在商城页即可复制邀请链接）
 * - 收款方式说明：买家下单弹窗展示
 */

const sbase = (String((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, ''));
const api = (path: string) => `${sbase}/api${path}`;

// ⚠️ 商城 token 的存储 key 与主系统 auth_token 完全不同 —— 两套登录态互不影响
const TOKEN_KEY = 'shop_admin_token';
const shopToken = () => localStorage.getItem(TOKEN_KEY) || '';
const authHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${shopToken()}` });

const ORDER_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待收款', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  paid: { label: '已收款·待发货', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  delivered: { label: '已发货', cls: 'bg-green-500/10 text-green-400 border-green-500/30' },
  cancelled: { label: '已取消', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
};

const CopyBtn: React.FC<{ text: string; title?: string }> = ({ text, title }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      title={title || '复制'}
      className={`p-1 rounded-md border shrink-0 ${copied ? 'bg-green-600/20 text-green-400 border-green-500/40' : 'bg-slate-900 text-slate-400 hover:text-indigo-400 border-slate-700'}`}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
};

const ShopAdmin: React.FC = () => {
  const [tab, setTab] = useState<'products' | 'orders'>('orders');
  const [products, setProducts] = useState<any[]>([]);
  const [importableBms, setImportableBms] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [payInfo, setPayInfo] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [busyKey, setBusyKey] = useState('');

  // 块（货架）：标题/说明/自定义长宽，商品归类到块、块内自动排列
  const [blocks, setBlocks] = useState<any[]>([]);
  const [blockForm, setBlockForm] = useState<any | null>(null);
  const [showBlockPanel, setShowBlockPanel] = useState(false);

  // 独立登录态
  const [username, setUsername] = useState('');          // 已登录的商城管理员
  const [authChecked, setAuthChecked] = useState(false); // 是否已完成 token 校验
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [pwdOld, setPwdOld] = useState('');
  const [pwdNew, setPwdNew] = useState('');

  // 新增/编辑表单
  const [form, setForm] = useState<any | null>(null);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUsername('');
    setProducts([]); setOrders([]); setImportableBms([]); setBlocks([]);
  }, []);

  const adminGet = useCallback(async (path: string) => {
    const r = await fetch(api(path), { headers: { 'Authorization': `Bearer ${shopToken()}` } });
    if (r.status === 401) { logout(); throw new Error('登录已失效，请重新登录'); }
    return r.json();
  }, [logout]);
  const adminPost = useCallback(async (path: string, body: any) => {
    const r = await fetch(api(path), { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    if (r.status === 401) { logout(); throw new Error('登录已失效，请重新登录'); }
    return r.json();
  }, [logout]);

  // 启动时用商城自己的 /me 校验 token（不经过主系统）
  useEffect(() => {
    if (!shopToken()) { setAuthChecked(true); return; }
    (async () => {
      try {
        const r = await fetch(api('/shop/admin/me'), { headers: { 'Authorization': `Bearer ${shopToken()}` } });
        if (!r.ok) { logout(); } else {
          const j = await r.json();
          if (j && j.success) setUsername(j.data?.username || ''); else logout();
        }
      } catch { /* 网络异常时先保留 token，后续请求再判定 */ }
      finally { setAuthChecked(true); }
    })();
  }, [logout]);

  const doLogin = async () => {
    if (!loginUser.trim() || !loginPass) { setLoginError('请输入账号和密码'); return; }
    setLoginBusy(true); setLoginError('');
    try {
      const r = await fetch(api('/shop/admin/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser.trim(), password: loginPass }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.success === false) throw new Error((j && j.message) || `登录失败 (${r.status})`);
      localStorage.setItem(TOKEN_KEY, j.data.token);
      setUsername(j.data.username || loginUser.trim());
      setLoginPass('');
    } catch (e: any) {
      setLoginError((e && e.message) || '登录失败');
    } finally { setLoginBusy(false); }
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [pj, oj] = await Promise.all([
        adminGet('/shop/admin/products'),
        adminGet(`/shop/admin/orders${statusFilter ? `?status=${statusFilter}` : ''}`),
      ]);
      if (pj && pj.success) { setProducts(pj.data || []); setImportableBms(pj.importable_bms || []); setBlocks(pj.blocks || []); }
      if (oj && oj.success) { setOrders(oj.data || []); setPayInfo(oj.pay_info || ''); }
    } catch { /* 401 已由 adminGet 统一登出 */ } finally { setLoading(false); }
  }, [adminGet, statusFilter]);

  useEffect(() => { if (username) loadAll(); }, [username, loadAll]);

  const act = async (key: string, path: string, body: any, done?: () => void) => {
    setBusyKey(key);
    try {
      const j = await adminPost(path, body);
      if (j && j.success === false) alert(j.message || '操作失败');
      if (done) done(); else loadAll();
    } catch (e: any) { alert((e && e.message) || '操作失败'); }
    finally { setBusyKey(''); }
  };

  const changePassword = async () => {
    if (pwdNew.length < 6) { alert('新密码至少 6 位'); return; }
    setBusyKey('pwd');
    try {
      const j = await adminPost('/shop/admin/change-password', { old_password: pwdOld, new_password: pwdNew });
      if (j && j.success) {
        alert('密码已修改，请用新密码重新登录');
        setShowChangePwd(false); setPwdOld(''); setPwdNew('');
        logout();
      } else alert((j && j.message) || '修改失败');
    } catch (e: any) { alert((e && e.message) || '修改失败'); }
    finally { setBusyKey(''); }
  };

  const saveProduct = async () => {
    if (!form) return;
    const f = form;
    if (!String(f.title || '').trim()) { alert('请填写标题'); return; }
    // 把「BM 组」拍平成条目数组（后端按 bm_id 归组，库存 = 组数）
    const items: any[] = [];
    for (const g of (f.groups || [])) {
      const bm = String(g.bm_id || '').trim();
      for (const l of (g.links || [])) {
        const link = String(l.invite_link || '').trim();
        if (!bm && !link) continue;
        items.push({ id: l.id, bm_id: bm, invite_link: link });
      }
    }
    const payload: any = { ...f, items };
    delete payload.groups;
    setBusyKey('form');
    try {
      const j = await adminPost('/shop/admin/products/save', payload);
      if (j && j.success === false) { alert(j.message || '保存失败'); return; }
      setForm(null);
      loadAll();
    } finally { setBusyKey(''); }
  };

  const saveBlock = async () => {
    if (!blockForm) return;
    if (!String(blockForm.title || '').trim()) { alert('请填写块标题'); return; }
    setBusyKey('block');
    try {
      const j = await adminPost('/shop/admin/blocks/save', blockForm);
      if (j && j.success === false) { alert(j.message || '保存失败'); return; }
      setBlockForm(null);
      loadAll();
    } catch (e: any) { alert((e && e.message) || '保存失败'); }
    finally { setBusyKey(''); }
  };

  const deleteBlock = async (b: any) => {
    if (!window.confirm(`删除块「${b.title}」？块内商品会回到「未分组」，商品不会被删除。`)) return;
    await act(`blk${b.id}`, '/shop/admin/blocks/delete', { id: b.id });
  };

  // 商品按块分组（块/商品均已按 sort_order 由后端排序返回）
  const grouped = useMemo(() => {
    const byBlock = new Map<number, any[]>();
    const ungrouped: any[] = [];
    const ids = new Set(blocks.map((b) => Number(b.id)));
    for (const p of products) {
      const bid = p.block_id === null || p.block_id === undefined ? null : Number(p.block_id);
      if (bid !== null && ids.has(bid)) {
        if (!byBlock.has(bid)) byBlock.set(bid, []);
        byBlock.get(bid)!.push(p);
      } else ungrouped.push(p);
    }
    return { byBlock, ungrouped };
  }, [products, blocks]);

  const focusBlock = (id: number | string) => {
    const el = document.getElementById(`block-sec-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 块内在售商品数（客户端统计，避免依赖 /blocks 接口）
  const blockCount = (id: number | string) =>
    products.filter((p) => Number(p.block_id) === Number(id) && p.status === 'available').length;

  const stockText = (p: any) => (p.stock === null || p.stock === undefined ? '不限' : String(p.stock));

  // 商品 BM 组编辑：一个 BMID 一组（=1 件），组内可填多条链接
  const addGroup = () => setForm((f: any) => (f ? { ...f, groups: [...(f.groups || []), { bm_id: '', links: [{ invite_link: '' }] }] } : f));
  const delGroup = (gi: number) => setForm((f: any) => (f ? { ...f, groups: (f.groups || []).filter((_: any, i: number) => i !== gi) } : f));
  const updGroupBm = (gi: number, val: string) =>
    setForm((f: any) => (f ? { ...f, groups: (f.groups || []).map((g: any, i: number) => (i === gi ? { ...g, bm_id: val } : g)) } : f));
  const addLink = (gi: number) =>
    setForm((f: any) => (f ? { ...f, groups: (f.groups || []).map((g: any, i: number) => (i === gi ? { ...g, links: [...(g.links || []), { invite_link: '' }] } : g)) } : f));
  const updLink = (gi: number, li: number, val: string) =>
    setForm((f: any) => (f ? { ...f, groups: (f.groups || []).map((g: any, i: number) => (i === gi ? { ...g, links: (g.links || []).map((l: any, j: number) => (j === li ? { ...l, invite_link: val } : l)) } : g)) } : f));
  const delLink = (gi: number, li: number) =>
    setForm((f: any) => (f ? { ...f, groups: (f.groups || []).map((g: any, i: number) => (i === gi ? { ...g, links: (g.links || []).filter((_: any, j: number) => j !== li) } : g)) } : f));
  const validGroupCount = (groups: any[]) =>
    (groups || []).filter((g) => String((g && g.bm_id) || '').trim() || ((g && g.links) || []).some((l: any) => String((l && l.invite_link) || '').trim())).length;

  // 编辑回填：把后端扁平 items 按 bm_id 聚成「BM 组」（一个 BMID 一组）
  const seedForm = (p: any) => {
    const flat = (p.items && p.items.length)
      ? p.items
      : (p.invite_link ? [{ bm_id: p.bm_id || '', invite_link: p.invite_link }] : []);
    const groups: any[] = [];
    const map = new Map();
    for (const it of flat) {
      const key = String(it.bm_id || '').trim() || `#${it.id ?? Math.random()}`;
      if (!map.has(key)) { const g = { bm_id: it.bm_id || '', links: [] }; map.set(key, g); groups.push(g); }
      map.get(key).links.push({ id: it.id, invite_link: it.invite_link || '', status: it.status });
    }
    if (!groups.length) groups.push({ bm_id: '', links: [{ invite_link: '' }] });
    return { ...p, groups };
  };

  // 列表展示用：把扁平条目按 BM 组聚合统计（组数 = 库存口径）
  const groupStats = (items: any[]) => {
    const set = new Set<string>();
    let links = 0, delivered = false, reserved = false;
    for (const it of (items || [])) {
      set.add(String(it.bm_id || '').trim() || `#${it.id}`);
      links++;
      if (it.status === 'delivered') delivered = true;
      if (it.status === 'reserved') reserved = true;
    }
    return { groups: set.size, links, delivered, reserved };
  };

  const renderProductRow = (p: any) => (
    <tr key={p.id} className="hover:bg-slate-800/30">
      <td className="px-4 py-3 text-xs text-slate-500">{p.id}</td>
      <td className="px-4 py-3 text-slate-200">{p.title}</td>
      <td className="px-4 py-3 text-emerald-400 font-bold whitespace-nowrap">{Number(p.price).toFixed(2)} {p.currency}</td>
      <td className="px-4 py-3 text-xs text-slate-400 uppercase">{p.product_type}</td>
      <td className="px-4 py-3 text-xs whitespace-nowrap">
        <span className={p.stock === 0 ? 'text-rose-400 font-bold' : 'text-slate-300'}>
          {p.stock === 0 ? '售罄' : stockText(p)}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className={`px-2 py-0.5 text-xs rounded-full border ${
          p.status === 'available' ? 'bg-green-500/10 text-green-400 border-green-500/30'
            : p.status === 'sold' ? 'bg-slate-500/10 text-slate-400 border-slate-500/30'
            : 'bg-rose-500/10 text-rose-400 border-rose-500/30'}`}>
          {p.status === 'available' ? '在售' : p.status === 'sold' ? '已售' : '已下架'}
        </span>
      </td>
      <td className="px-4 py-3 max-w-[240px]">
        {p.items && p.items.length > 0 ? (() => {
          const s = groupStats(p.items);
          return (
            <span className="text-xs text-slate-300"
              title={(p.items || []).map((it: any) => `${it.bm_id || '-'}${it.status !== 'available' ? `（${it.status === 'delivered' ? '已发货' : '已预留'}）` : ''}`).join('\n')}>
              {s.groups} 组 BM（{s.links} 条链接）
              {s.delivered && <span className="text-green-400"> · 已有发货</span>}
              {s.reserved && <span className="text-amber-400"> · 有预留</span>}
            </span>
          );
        })() : p.invite_link ? (
          <div className="flex items-center gap-1">
            <a href={p.invite_link} target="_blank" rel="noopener noreferrer" title={p.invite_link}
              className="text-xs font-mono text-indigo-300 hover:underline truncate min-w-0">{p.invite_link}</a>
            <CopyBtn text={p.invite_link} />
          </div>
        ) : <span className="text-xs text-slate-600">-</span>}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <button onClick={() => { setForm(seedForm(p)); setShowAddForm(true); }}
            className="px-2.5 py-1.5 text-xs rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:text-indigo-300">编辑</button>
          {p.status === 'available' && (
            <button onClick={() => act(`dl${p.id}`, '/shop/admin/products/delete', { id: p.id })}
              disabled={busyKey === `dl${p.id}`}
              className="px-2.5 py-1.5 text-xs rounded-md bg-slate-800 border border-slate-700 text-slate-400 hover:text-amber-400">下架</button>
          )}
          {p.status !== 'available' && (
            <button onClick={() => { const rest: any = { ...p }; delete rest.items; act(`rs${p.id}`, '/shop/admin/products/save', { ...rest, status: 'available' }); }}
              disabled={busyKey === `rs${p.id}`}
              className="px-2.5 py-1.5 text-xs rounded-md bg-green-600/20 border border-green-500/30 text-green-300">重新上架</button>
          )}
          <button onClick={() => { if (window.confirm(`删除商品「${p.title}」？`)) act(`hd${p.id}`, '/shop/admin/products/delete', { id: p.id, hard: true }); }}
            disabled={busyKey === `hd${p.id}`}
            className="p-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-500 hover:text-rose-400" title="删除">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );

  const renderGroupTable = (rows: any[]) => (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">标题</th>
              <th className="px-4 py-3">价格</th>
              <th className="px-4 py-3">类型</th>
              <th className="px-4 py-3">库存</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">BM 条目</th>
              <th className="px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-600 text-xs">该块暂无商品</td></tr>
            ) : rows.map(renderProductRow)}
          </tbody>
        </table>
      </div>
    </div>
  );

  // -------- 登录校验中 --------
  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  // -------- 独立登录页（未登录只显示这个，不暴露任何商城数据）--------
  if (!username) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-7">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-indigo-600/20 flex items-center justify-center border border-indigo-500/30">
              <ShoppingBag className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">商城管理后台</h1>
              <p className="text-xs text-slate-500">独立账号 · 与主系统隔离</p>
            </div>
          </div>
          <div className="space-y-3">
            <input
              value={loginUser} onChange={(e) => setLoginUser(e.target.value)} placeholder="商城管理员账号"
              autoComplete="off"
              className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500"
            />
            <input
              value={loginPass} onChange={(e) => setLoginPass(e.target.value)} type="password" placeholder="密码"
              onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }}
              className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500"
            />
            {loginError && (
              <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {loginError}
              </div>
            )}
            <button onClick={doLogin} disabled={loginBusy}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg inline-flex items-center justify-center gap-2 disabled:opacity-50">
              {loginBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} 登录
            </button>
          </div>
          <p className="text-[11px] text-slate-600 mt-5 leading-relaxed">
            此入口仅供商城销售/客服使用，账号独立于主系统。买家下单请访问{' '}
            <a href="#shop" className="text-indigo-400 hover:underline">商城首页</a>。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-4 lg:p-6">
      <div className="max-w-7xl mx-auto bg-slate-950/50 rounded-xl border border-slate-800 p-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-indigo-600/20 flex items-center justify-center border border-indigo-500/30">
            <Store className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">商城订单管理</h2>
            <p className="text-sm text-slate-400">
              人工确认收款 → 发货；商品自动从 BM 邀请链接上架
              <span className="ml-2 text-slate-500">· {username}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setTab('orders')} className={`px-3 py-2 rounded-lg text-sm font-bold border inline-flex items-center gap-1.5 ${tab === 'orders' ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
            <ClipboardList className="w-4 h-4" /> 订单 {orders.length > 0 ? `(${orders.length})` : ''}
          </button>
          <button onClick={() => setTab('products')} className={`px-3 py-2 rounded-lg text-sm font-bold border inline-flex items-center gap-1.5 ${tab === 'products' ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
            <Tag className="w-4 h-4" /> 商品
          </button>
          <button onClick={loadAll} className="p-2 rounded-lg bg-slate-800 text-slate-300 border border-slate-700">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => setShowChangePwd(true)} title="修改密码"
            className="p-2 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 hover:text-indigo-300">
            <KeyRound className="w-4 h-4" />
          </button>
          <button onClick={logout} title="退出登录"
            className="p-2 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 hover:text-rose-400">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ============ 订单 ============ */}
      {tab === 'orders' && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {['', 'pending', 'paid', 'delivered', 'cancelled'].map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${statusFilter === s ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                {s === '' ? '全部' : (ORDER_STATUS[s] || { label: s }).label}
              </button>
            ))}
          </div>
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                    <th className="px-4 py-3">订单号</th>
                    <th className="px-4 py-3">商品</th>
                    <th className="px-4 py-3">单价</th>
                    <th className="px-4 py-3">数量</th>
                    <th className="px-4 py-3">总额</th>
                    <th className="px-4 py-3">联系方式</th>
                    <th className="px-4 py-3">状态</th>
                    <th className="px-4 py-3">时间</th>
                    <th className="px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {orders.length === 0 ? (
                    <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500 text-xs">暂无订单</td></tr>
                  ) : orders.map((o) => {
                    const st = ORDER_STATUS[o.status] || { label: o.status, cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' };
                    const contact = Number(o.is_anonymous) === 1 ? '(匿名)' : [o.contact_email, o.contact_phone].filter(Boolean).join(' / ') || '-';
                    return (
                      <tr key={o.id} className="hover:bg-slate-800/30">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs text-white">{o.order_no}</span>
                            <CopyBtn text={o.order_no} />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-300">{o.product_title}</td>
                        <td className="px-4 py-3 text-emerald-400 font-bold whitespace-nowrap">{Number(o.price).toFixed(2)} {o.currency}</td>
                        <td className="px-4 py-3 text-slate-300 whitespace-nowrap">×{Math.max(Number(o.quantity) || 1, 1)}</td>
                        <td className="px-4 py-3 text-emerald-400 font-bold whitespace-nowrap">
                          {(o.total !== undefined ? Number(o.total) : (Number(o.price) || 0) * Math.max(Number(o.quantity) || 1, 1)).toFixed(2)} {o.currency}
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs max-w-[220px] break-all">{contact}</td>
                        <td className="px-4 py-3"><span className={`px-2 py-0.5 text-xs rounded-full border whitespace-nowrap ${st.cls}`}>{st.label}</span></td>
                        <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{o.created_at ? new Date(o.created_at).toLocaleString() : '-'}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {o.status === 'pending' && (
                              <button onClick={() => act(`cp${o.id}`, '/shop/admin/orders/confirm-paid', { id: o.id })}
                                disabled={busyKey === `cp${o.id}`}
                                title="人工确认已收款"
                                className="px-2.5 py-1.5 text-xs rounded-md bg-blue-600/20 border border-blue-500/30 text-blue-300 hover:bg-blue-600/30 inline-flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5" /> 确认收款
                              </button>
                            )}
                            {(o.status === 'paid' || o.status === 'pending') && (
                              <button onClick={() => { if (window.confirm('确认发货？发货后买家可复制邀请链接')) act(`dl${o.id}`, '/shop/admin/orders/deliver', { id: o.id }); }}
                                disabled={busyKey === `dl${o.id}`}
                                className="px-2.5 py-1.5 text-xs rounded-md bg-green-600/20 border border-green-500/30 text-green-300 hover:bg-green-600/30 inline-flex items-center gap-1">
                                <PackageCheck className="w-3.5 h-3.5" /> 发货
                              </button>
                            )}
                            {o.status !== 'delivered' && o.status !== 'cancelled' && (
                              <button onClick={() => { const note = window.prompt('取消原因（可空）：') ?? undefined; if (note !== null) act(`cn${o.id}`, '/shop/admin/orders/cancel', { id: o.id, note }); }}
                                disabled={busyKey === `cn${o.id}`}
                                className="p-1.5 text-xs rounded-md bg-slate-800 border border-slate-700 text-slate-400 hover:text-rose-400" title="取消订单">
                                <Ban className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {o.status === 'delivered' && o.deliver_content && (
                              <div className="flex items-center gap-1 max-w-[200px]">
                                <Link2 className="w-3 h-3 text-indigo-400 shrink-0" />
                                <a href={o.deliver_content} target="_blank" rel="noopener noreferrer" title={o.deliver_content}
                                  className="text-xs font-mono text-indigo-300 hover:underline truncate min-w-0">{o.deliver_content}</a>
                                <CopyBtn text={o.deliver_content} title="复制发货内容" />
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 收款方式说明 */}
          <div className="mt-6 bg-slate-900/40 border border-slate-800 rounded-xl p-5">
            <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2"><Info className="w-4 h-4 text-indigo-400" /> 收款方式说明（买家下单时展示）</h3>
            <textarea value={payInfo} onChange={(e) => setPayInfo(e.target.value)} rows={3}
              placeholder="如：USDT-TRC20 地址 TXxxx... / 支付宝 xxx / 加微信 xxx 确认"
              className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 mb-3" />
            <button onClick={() => act('payinfo', '/shop/admin/pay-info', { pay_info: payInfo })}
              disabled={busyKey === 'payinfo'}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg">保存说明</button>
          </div>
        </div>
      )}

      {/* ============ 商品 ============ */}
      {tab === 'products' && (
        <div className="flex gap-5 items-start">
          {/* 主区：商品 + 块分组 */}
          <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <button onClick={() => { setForm({ title: '', description: '', price: 0, currency: 'USDT', product_type: 'bm', block_id: null, sort_order: 0, groups: [{ bm_id: '', links: [{ invite_link: '' }] }] }); setShowAddForm(true); }}
              className="px-3 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg inline-flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> 新增商品
            </button>
            <button onClick={() => setShowBlockPanel(!showBlockPanel)} className={`px-3 py-2 text-sm font-bold rounded-lg inline-flex items-center gap-1.5 border ${showBlockPanel ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40' : 'bg-slate-800 text-slate-200 border-slate-700'}`}>
              <Layers className="w-4 h-4" /> 块管理 {blocks.length > 0 ? `(${blocks.length})` : ''}
            </button>
            <button onClick={() => setShowImport(!showImport)} className="px-3 py-2 bg-slate-800 text-slate-200 text-sm font-bold border border-slate-700 rounded-lg inline-flex items-center gap-1.5">
              <Link2 className="w-4 h-4" /> 从 BM 导入 {importableBms.length > 0 ? `(${importableBms.length})` : ''}
            </button>
          </div>

          {/* 块（货架）管理：标题/说明/自定义长宽/排序 */}
          {showBlockPanel && (
            <div className="mb-6 bg-slate-900/60 border border-indigo-500/30 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white flex items-center gap-2"><Layers className="w-4 h-4 text-indigo-400" /> 块（货架）管理</h3>
                <button onClick={() => setBlockForm({ title: '', description: '', width_px: 380, min_height_px: 0, sort_order: (blocks.length + 1) * 10 })}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 text-white inline-flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> 新增块
                </button>
              </div>

              {blockForm && (
                <div className="mb-4 bg-slate-950/60 border border-slate-800 rounded-lg p-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                    <input value={blockForm.title || ''} onChange={(e) => setBlockForm({ ...blockForm, title: e.target.value })} placeholder="块标题 *"
                      className="px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
                    <input type="number" value={blockForm.sort_order ?? 0} onChange={(e) => setBlockForm({ ...blockForm, sort_order: Number(e.target.value) })} placeholder="排序（越小越前）"
                      className="px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white" />
                    <label className="flex items-center gap-2 text-xs text-slate-400">
                      宽度(px)
                      <input type="number" min={200} max={2000} value={blockForm.width_px ?? 380} onChange={(e) => setBlockForm({ ...blockForm, width_px: Number(e.target.value) })}
                        className="flex-1 px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white" />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-slate-400">
                      最小高度(px)
                      <input type="number" min={0} max={2000} value={blockForm.min_height_px ?? 0} onChange={(e) => setBlockForm({ ...blockForm, min_height_px: Number(e.target.value) })}
                        className="flex-1 px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white" />
                    </label>
                  </div>
                  <textarea value={blockForm.description || ''} onChange={(e) => setBlockForm({ ...blockForm, description: e.target.value })} rows={2} placeholder="块说明（显示在块标题下方）"
                    className="w-full px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 mb-3" />
                  <div className="flex gap-2">
                    <button onClick={saveBlock} disabled={busyKey === 'block'} className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg disabled:opacity-50">{blockForm.id ? '保存块' : '创建块'}</button>
                    <button onClick={() => setBlockForm(null)} className="px-4 py-2 bg-slate-800 text-slate-300 text-sm border border-slate-700 rounded-lg">取消</button>
                  </div>
                </div>
              )}

              {blocks.length === 0 ? (
                <p className="text-xs text-slate-500">暂无块。点击「新增块」创建货架，商品可归入其中并自动排列。</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {blocks.map((b) => (
                    <div key={b.id} className="flex flex-wrap items-center gap-3 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
                      <span className="text-sm text-white font-bold">{b.title}</span>
                      <span className="text-xs text-slate-500">宽 {b.width_px}px · 最小高 {b.min_height_px}px · 排序 {b.sort_order}</span>
                      <span className="text-xs text-slate-500">在售 {blockCount(b.id)}</span>
                      {b.description && <span className="text-xs text-slate-600 truncate max-w-[240px]" title={b.description}>{b.description}</span>}
                      <div className="flex-1" />
                      <button onClick={() => setBlockForm({ ...b })} className="px-2.5 py-1.5 text-xs rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:text-indigo-300 inline-flex items-center gap-1">
                        <Pencil className="w-3 h-3" /> 编辑
                      </button>
                      <button onClick={() => deleteBlock(b)} disabled={busyKey === `blk${b.id}`} className="p-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-500 hover:text-rose-400" title="删除块">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {showImport && (
            <div className="mb-6 bg-slate-900/60 border border-indigo-500/30 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white">可上架的 BM（已提取邀请链接且未上架）</h3>
                {importableBms.length > 0 && (
                  <button
                    onClick={async () => {
                      if (!window.confirm(`一键上架全部 ${importableBms.length} 个 BM？`)) return;
                      setBusyKey('import-all');
                      try {
                        for (const bm of importableBms) {
                          await adminPost('/shop/admin/products/save', {
                            title: `BM ${bm.bm_id}${bm.name ? ` · ${bm.name}` : ''}`,
                            description: `Business Manager 账号${bm.invite_email ? `（邀请邮箱 ${bm.invite_email}）` : ''}。购买后通过邀请链接接受加入即可获得管理权限。`,
                            price: 0,
                            currency: 'USDT',
                            product_type: 'bm',
                            invite_link: bm.invite_link,
                            bm_id: bm.bm_id,
                            profile_id: bm.profile_id,
                            items: [{ bm_id: bm.bm_id, invite_link: bm.invite_link }],
                          });
                        }
                        setShowImport(false);
                        loadAll();
                      } finally { setBusyKey(''); }
                    }}
                    disabled={busyKey === 'import-all' || importableBms.length === 0}
                    className="px-3 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 text-white disabled:opacity-50">
                    一键全部上架
                  </button>
                )}
              </div>
              {importableBms.length === 0 ? (
                <p className="text-xs text-slate-500">暂无可导入的 BM。先在「资产查看器」BM 列表点「生成邀请链接」。</p>
              ) : (
                <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto custom-scrollbar">
                  {importableBms.map((bm) => (
                    <div key={`${bm.bm_id}-${bm.profile_id}`} className="flex flex-wrap items-center gap-2 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
                      <span className="text-sm text-white font-bold">BM {bm.bm_id}</span>
                      <span className="text-xs text-slate-400">{bm.name || ''}</span>
                      {bm.invite_email && <span className="text-xs text-slate-500">{bm.invite_email}</span>}
                      <span className="flex-1 min-w-[120px] text-xs font-mono text-indigo-300 truncate" title={bm.invite_link}>{bm.invite_link}</span>
                      <button
                        onClick={() => act(`imp${bm.bm_id}`, '/shop/admin/products/save', {
                          title: `BM ${bm.bm_id}${bm.name ? ` · ${bm.name}` : ''}`,
                          description: `Business Manager 账号${bm.invite_email ? `（邀请邮箱 ${bm.invite_email}）` : ''}。购买后通过邀请链接接受加入即可获得管理权限。`,
                          price: 0,
                          currency: 'USDT',
                          product_type: 'bm',
                          invite_link: bm.invite_link,
                          bm_id: bm.bm_id,
                          profile_id: bm.profile_id,
                          items: [{ bm_id: bm.bm_id, invite_link: bm.invite_link }],
                        })}
                        disabled={busyKey === `imp${bm.bm_id}`}
                        className="px-2.5 py-1.5 text-xs font-bold rounded-md bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/30 whitespace-nowrap">
                        上架
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-xs text-slate-500 mt-3">上架后请到商品列表改价格（默认 0，0 元商品买家仍会正常下单）。</p>
            </div>
          )}

          {/* 新增/编辑商品：弹窗 */}
          {showAddForm && form && (
            <div className="fixed inset-0 z-[100] flex items-start justify-center p-4">
              <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => { setShowAddForm(false); setForm(null); }}></div>
              <div className="relative w-full max-w-3xl max-h-[92vh] overflow-y-auto custom-scrollbar bg-slate-900 border border-slate-700 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-white">{form.id ? '编辑商品' : '新增商品'}</h3>
                <button onClick={() => { setShowAddForm(false); setForm(null); }} title="关闭"
                  className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <input value={form.title || ''} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="标题 *"
                  className="px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
                <div className="flex gap-2">
                  <input type="number" step="0.01" value={form.price ?? 0} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} placeholder="价格"
                    className="w-32 px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white" />
                  <input value={form.currency || 'USDT'} onChange={(e) => setForm({ ...form, currency: e.target.value })} placeholder="币种"
                    className="w-24 px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white" />
                  <select value={form.product_type || 'bm'} onChange={(e) => setForm({ ...form, product_type: e.target.value })}
                    className="flex-1 px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white">
                    <option value="bm">BM</option>
                    <option value="adaccount">广告号</option>
                    <option value="page">主页</option>
                    <option value="other">其他</option>
                  </select>
                </div>
              </div>
              <textarea value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="商品描述"
                className="w-full px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 mb-3" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <label className="flex items-center gap-2 text-xs text-slate-400">
                  归属块
                  <select value={form.block_id ?? ''} onChange={(e) => setForm({ ...form, block_id: e.target.value === '' ? null : Number(e.target.value) })}
                    className="flex-1 px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white">
                    <option value="">未分组</option>
                    {blocks.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-400">
                  排序
                  <input type="number" value={form.sort_order ?? 0} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} placeholder="越小越前"
                    className="flex-1 px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white" />
                </label>
              </div>

              {/* BM 组：一个 BMID = 1 件，组内可填多条链接（发货时整组一起发） */}
              <div className="mb-3 bg-slate-950/50 border border-slate-800 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-400">
                    BM 组（一个 BMID = 1 件，可含多条链接）· 共 <b className="text-indigo-300">{validGroupCount(form.groups)}</b> 组
                  </span>
                  <button onClick={addGroup} className="px-2.5 py-1 text-xs font-bold rounded-md bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 inline-flex items-center gap-1">
                    <Plus className="w-3 h-3" /> 添加一组 BM
                  </button>
                </div>
                <div className="flex flex-col gap-3">
                  {(form.groups || []).map((g: any, gi: number) => (
                    <div key={gi} className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <input value={g.bm_id || ''} onChange={(e) => updGroupBm(gi, e.target.value)} placeholder="BMID"
                          className="w-48 px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
                        <button onClick={() => addLink(gi)} className="px-2 py-1.5 text-xs rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:text-indigo-300 inline-flex items-center gap-1">
                          <Plus className="w-3 h-3" /> 添加链接
                        </button>
                        <div className="flex-1" />
                        <button onClick={() => delGroup(gi)} className="p-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-500 hover:text-rose-400" title="移除该 BM 组">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex flex-col gap-2 pl-2 border-l border-slate-800">
                        {(g.links || []).map((l: any, li: number) => (
                          <div key={li} className="flex flex-wrap items-center gap-2">
                            <input value={l.invite_link || ''} onChange={(e) => updLink(gi, li, e.target.value)} placeholder="邀请链接"
                              className="flex-1 min-w-[200px] px-3 py-2 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white font-mono placeholder-slate-500" />
                            {l.status && l.status !== 'available' && (
                              <span className={`px-2 py-0.5 text-[11px] rounded-full border ${l.status === 'delivered' ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-amber-500/10 text-amber-400 border-amber-500/30'}`}>
                                {l.status === 'delivered' ? '已发货' : '已预留'}
                              </span>
                            )}
                            <button onClick={() => delLink(gi, li)} className="p-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-500 hover:text-rose-400" title="移除该链接">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        {(g.links || []).length === 0 && <p className="text-xs text-slate-600">该 BM 暂无链接，点「添加链接」。</p>}
                      </div>
                    </div>
                  ))}
                  {(form.groups || []).length === 0 && <p className="text-xs text-slate-600">暂无 BM 组，点「添加一组 BM」录入 BMID 与链接。</p>}
                </div>
                <p className="text-[11px] text-slate-600 mt-2">库存 = BM 组数（自动），售出后自动减少、取消自动回补；下单 1 件即发该 BM 的全部链接。</p>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={saveProduct} disabled={busyKey === 'form'} className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg disabled:opacity-50">保存</button>
                <button onClick={() => { setShowAddForm(false); setForm(null); }} className="px-5 py-2.5 bg-slate-800 text-slate-300 text-sm border border-slate-700 rounded-lg">取消</button>
              </div>
              </div>
            </div>
          )}

          {/* 商品列表：按块分组，每组一个锚点区块 */}
          {blocks.map((b) => (
            <div key={b.id} id={`block-sec-${b.id}`} className="mb-6 scroll-mt-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Layers className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-bold text-white">{b.title}</h3>
                <span className="text-xs text-slate-500">宽 {b.width_px}px · 最小高 {b.min_height_px}px · 排序 {b.sort_order}</span>
                <button onClick={() => { setBlockForm({ ...b }); setShowBlockPanel(true); }} className="text-xs text-indigo-400 hover:underline">编辑块</button>
              </div>
              {b.description && <p className="text-xs text-slate-500 mb-2">{b.description}</p>}
              {renderGroupTable(grouped.byBlock.get(Number(b.id)) || [])}
            </div>
          ))}

          {/* 未分组商品（无任何块时也展示全部商品） */}
          {(grouped.ungrouped.length > 0 || blocks.length === 0) && (
            <div id="block-sec-ungrouped" className="mb-6 scroll-mt-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Tag className="w-4 h-4 text-slate-400" />
                <h3 className="text-sm font-bold text-white">未分组</h3>
                <span className="text-xs text-slate-500">{grouped.ungrouped.length} 个商品</span>
              </div>
              {renderGroupTable(grouped.ungrouped)}
            </div>
          )}
          </div>

          {/* 右侧：快速定位到块标题 */}
          {blocks.length > 0 && (
            <aside className="hidden lg:block w-52 shrink-0 sticky top-4">
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
                <h4 className="text-xs font-bold text-slate-400 mb-3 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5" /> 块目录
                </h4>
                <nav className="flex flex-col gap-1">
                  {blocks.map((b) => (
                    <button key={b.id} onClick={() => focusBlock(b.id)}
                      className="text-left text-xs px-2.5 py-1.5 rounded-md text-slate-300 hover:bg-indigo-600/20 hover:text-indigo-300 truncate"
                      title={b.title}>
                      {b.title} <span className="text-slate-600">({blockCount(b.id)})</span>
                    </button>
                  ))}
                  {grouped.ungrouped.length > 0 && (
                    <button onClick={() => focusBlock('ungrouped')}
                      className="text-left text-xs px-2.5 py-1.5 rounded-md text-slate-400 hover:bg-indigo-600/20 hover:text-indigo-300">
                      未分组 <span className="text-slate-600">({grouped.ungrouped.length})</span>
                    </button>
                  )}
                </nav>
                <button onClick={() => { setShowBlockPanel(true); setBlockForm({ title: '', description: '', width_px: 380, min_height_px: 0, sort_order: (blocks.length + 1) * 10 }); }}
                  className="mt-3 w-full py-1.5 text-xs font-bold rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-indigo-300 inline-flex items-center justify-center gap-1">
                  <Plus className="w-3 h-3" /> 新增块
                </button>
              </div>
            </aside>
          )}
        </div>
      )}

      {/* 修改密码 */}
      {showChangePwd && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowChangePwd(false)}></div>
          <div className="relative w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6">
            <h3 className="text-base font-bold text-white mb-4">修改商城管理员密码</h3>
            <div className="space-y-3 mb-4">
              <input type="password" value={pwdOld} onChange={(e) => setPwdOld(e.target.value)} placeholder="原密码"
                className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
              <input type="password" value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} placeholder="新密码（至少 6 位）"
                className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
            </div>
            <div className="flex gap-2">
              <button onClick={changePassword} disabled={busyKey === 'pwd'}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg disabled:opacity-50">确认修改</button>
              <button onClick={() => { setShowChangePwd(false); setPwdOld(''); setPwdNew(''); }}
                className="px-4 py-2.5 bg-slate-800 text-slate-300 text-sm border border-slate-700 rounded-lg">取消</button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};

export default ShopAdmin;
