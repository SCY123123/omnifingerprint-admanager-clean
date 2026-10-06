import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ShoppingCart, Copy, Check, Search, RefreshCw, Loader2, Package, Link2, ExternalLink, ShieldCheck, X, Minus, Plus, ClipboardList, KeyRound, LogOut, User } from 'lucide-react';

/**
 * BM 商城（买家侧，独立入口 /#shop）
 * - 商品按「块（货架）」渲染：块有标题/说明/自定义长宽，块内商品自动排列
 * - 下单可选数量（受库存限制）；邮箱或电话留空=匿名下单（凭订单号查单）
 * - 填了邮箱/电话 → 自动创建买家账号并直接登录（右上角可查我的订单、设置/修改密码）
 * - 买家账号体系与商城管理员、主系统账号三方互不相通
 */

const TOKEN_KEY = 'shop_buyer_token';
const buyerToken = () => localStorage.getItem(TOKEN_KEY) || '';

const PAY_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待收款', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  paid: { label: '已收款·待发货', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  delivered: { label: '已发货', cls: 'bg-green-500/10 text-green-400 border-green-500/30' },
  cancelled: { label: '已取消', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
};
const statusView = (s?: string) => PAY_STATUS[String(s || '')] || { label: String(s || ''), cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' };

const CopyBtn: React.FC<{ text: string; title?: string }> = ({ text, title }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      title={title || '复制'}
      className={`p-1.5 rounded-md border shrink-0 ${copied ? 'bg-green-600/20 text-green-400 border-green-500/40' : 'bg-slate-900 text-slate-400 hover:text-indigo-400 border-slate-700'}`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

interface ShopOrder {
  order_no: string; product_title?: string; price?: number; currency?: string;
  quantity?: number; total?: number; status?: string; deliver_content?: string; created_at?: string;
}

const Shop: React.FC = () => {
  const [products, setProducts] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 买家登录态
  const [buyer, setBuyer] = useState<{ account: string; has_password: boolean } | null>(null);
  const [showOrders, setShowOrders] = useState(false);
  const [myOrders, setMyOrders] = useState<ShopOrder[]>([]);
  const [localOrders, setLocalOrders] = useState<ShopOrder[]>([]); // 本机下单记录（含匿名订单，无账号也能看到）
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [payInfo, setPayInfo] = useState('');
  const [activeBlock, setActiveBlock] = useState(''); // 右侧滑杆当前高亮的块

  // 未登录时的查单
  const [guestOrders, setGuestOrders] = useState<ShopOrder[]>([]);
  const [queryNo, setQueryNo] = useState('');
  const [queryContact, setQueryContact] = useState('');
  const [querying, setQuerying] = useState(false);

  // 登录 / 改密
  const [showLogin, setShowLogin] = useState(false);
  const [loginAccount, setLoginAccount] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [pwdOld, setPwdOld] = useState('');
  const [pwdNew, setPwdNew] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  // 下单
  const [buying, setBuying] = useState<any | null>(null);
  const [qty, setQty] = useState(1);
  const [buyEmail, setBuyEmail] = useState('');
  const [buyPhone, setBuyPhone] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [orderDone, setOrderDone] = useState<any | null>(null);

  const loadProducts = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/shop/products');
      const j = await r.json();
      if (!j || j.success === false) throw new Error((j && j.message) || '加载失败');
      setProducts(Array.isArray(j.data) ? j.data : []);
      setBlocks(Array.isArray(j.blocks) ? j.blocks : []);
    } catch (e: any) { setError((e && e.message) || '加载失败'); }
    finally { setLoading(false); }
  }, []);

  // 启动：校验买家 token
  useEffect(() => {
    if (!buyerToken()) return;
    (async () => {
      try {
        const r = await fetch('/api/shop/buyer/me', { headers: { Authorization: 'Bearer ' + buyerToken() } });
        if (!r.ok) { localStorage.removeItem(TOKEN_KEY); setBuyer(null); return; }
        const j = await r.json();
        if (j && j.success) setBuyer(j.data);
      } catch { /* 忽略网络抖动 */ }
    })();
  }, []);

  const loadMyOrders = useCallback(async () => {
    if (!buyerToken()) { setMyOrders([]); return; }
    setOrdersLoading(true);
    try {
      const r = await fetch('/api/shop/buyer/orders', { headers: { Authorization: 'Bearer ' + buyerToken() } });
      if (r.status === 401) { localStorage.removeItem(TOKEN_KEY); setBuyer(null); return; }
      const j = await r.json();
      if (j && j.success) { setMyOrders(j.data || []); if (j.pay_info) setPayInfo(j.pay_info); }
    } catch { /* 忽略 */ } finally { setOrdersLoading(false); }
  }, []);

  // 本机缓存的订单号（含匿名下单）——无账号也能看到自己下过的单
  const loadLocalOrders = useCallback(async () => {
    let nos: string[] = [];
    try { nos = JSON.parse(localStorage.getItem('shop:my_orders') || '[]'); } catch { /* 忽略 */ }
    nos = (nos || []).filter(Boolean).slice(0, 50);
    if (!nos.length) { setLocalOrders([]); return; }
    try {
      const r = await fetch(`/api/shop/orders/query?order_nos=${encodeURIComponent(nos.join(','))}`);
      const j = await r.json();
      if (j && j.success) setLocalOrders(Array.isArray(j.data) ? j.data : []);
    } catch { /* 忽略网络抖动 */ }
  }, []);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { if (buyer) loadMyOrders(); }, [buyer, loadMyOrders]);
  useEffect(() => { loadLocalOrders(); }, [loadLocalOrders]);
  useEffect(() => { if (showOrders) loadLocalOrders(); }, [showOrders, loadLocalOrders]);

  // 合并展示：账号订单 + 本机订单（去重，按时间倒序）
  const mergeOrders = (a: ShopOrder[], b: ShopOrder[]) => {
    const map = new Map<string, ShopOrder>();
    for (const o of [...a, ...b]) { if (o && o.order_no && !map.has(o.order_no)) map.set(o.order_no, o); }
    return Array.from(map.values()).sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')));
  };
  const displayOrders = useMemo(() => mergeOrders(myOrders, localOrders), [myOrders, localOrders]);
  const guestDisplay = useMemo(() => mergeOrders(guestOrders, localOrders), [guestOrders, localOrders]);

  // 右侧块定位滑杆：滚动时高亮当前块
  const jumpToBlock = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  useEffect(() => {
    const ids = blocks.map((b) => `shop-block-${b.id}`);
    if (products.some((p) => p.block_id === null || p.block_id === undefined)) ids.push('shop-block-ungrouped');
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    const ob = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActiveBlock(visible[0].target.id);
    }, { rootMargin: '-20% 0px -60% 0px', threshold: 0 });
    els.forEach((el) => ob.observe(el));
    return () => ob.disconnect();
  }, [blocks, products]);

  const saveGuestOrderNo = (no: string) => {
    try {
      const nos: string[] = JSON.parse(localStorage.getItem('shop:my_orders') || '[]');
      localStorage.setItem('shop:my_orders', JSON.stringify([no, ...nos.filter(n => n !== no)].slice(0, 20)));
    } catch {}
  };

  const doGuestQuery = async () => {
    const no = queryNo.trim(), contact = queryContact.trim();
    if (!no && !contact) { alert('请输入订单号或邮箱/电话'); return; }
    setQuerying(true);
    try {
      const q = no ? `order_no=${encodeURIComponent(no)}` : `contact=${encodeURIComponent(contact)}`;
      const r = await fetch(`/api/shop/orders/query?${q}`);
      const j = await r.json();
      if (!j || j.success === false) throw new Error((j && j.message) || '查询失败');
      setGuestOrders(Array.isArray(j.data) ? j.data : []);
      if (j.pay_info) setPayInfo(j.pay_info);
      if (no) saveGuestOrderNo(no);
    } catch (e: any) { alert((e && e.message) || '查询失败'); }
    finally { setQuerying(false); }
  };

  const submitOrder = async () => {
    if (!buying) return;
    setOrdering(true);
    try {
      const r = await fetch('/api/shop/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: buying.id, quantity: qty, contact_email: buyEmail.trim(), contact_phone: buyPhone.trim() }),
      });
      const j = await r.json();
      if (!j || j.success === false) throw new Error((j && j.message) || '下单失败');
      // 下单即登录：后端返回买家 token 时直接写入本地登录态
      if (j.data.buyer_token) {
        localStorage.setItem(TOKEN_KEY, j.data.buyer_token);
        setBuyer({ account: j.data.buyer_account, has_password: !!j.data.buyer_has_password });
      }
      setOrderDone(j.data);
      if (j.data.pay_info) setPayInfo(j.data.pay_info);
      saveGuestOrderNo(j.data.order_no);
      loadLocalOrders();
      loadProducts();
    } catch (e: any) { alert((e && e.message) || '下单失败'); }
    finally { setOrdering(false); }
  };

  const doLogin = async () => {
    if (!loginAccount.trim() || !loginPass) { setAuthError('请输入账号和密码'); return; }
    setAuthBusy(true); setAuthError('');
    try {
      const r = await fetch('/api/shop/buyer/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: loginAccount.trim(), password: loginPass }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.success === false) throw new Error((j && j.message) || '登录失败');
      localStorage.setItem(TOKEN_KEY, j.data.token);
      setBuyer({ account: j.data.account, has_password: true });
      setShowLogin(false); setLoginPass('');
    } catch (e: any) { setAuthError((e && e.message) || '登录失败'); }
    finally { setAuthBusy(false); }
  };

  const savePassword = async () => {
    if (pwdNew.length < 6) { alert('新密码至少 6 位'); return; }
    setAuthBusy(true);
    try {
      const r = await fetch('/api/shop/buyer/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + buyerToken() },
        body: JSON.stringify({ old_password: pwdOld, new_password: pwdNew }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.success === false) throw new Error((j && j.message) || '操作失败');
      alert(j.message || '已保存');
      setBuyer(prev => prev ? { ...prev, has_password: true } : prev);
      setShowPwd(false); setPwdOld(''); setPwdNew('');
    } catch (e: any) { alert((e && e.message) || '操作失败'); }
    finally { setAuthBusy(false); }
  };

  const doLogout = () => { localStorage.removeItem(TOKEN_KEY); setBuyer(null); setMyOrders([]); };

  const stockOf = (p: any) => (p.stock === null || p.stock === undefined ? Infinity : Number(p.stock));
  const soldOut = (p: any) => stockOf(p) <= 0;

  // 发货内容解析：每组「BMID: x」+ 若干「链接: url」行，组间空行分隔；旧格式整段即单个链接
  const parseDeliver = (s: string) => {
    const raw = String(s || '').trim();
    if (!raw) return [] as { bm: string; links: string[] }[];
    return raw.split(/\n\s*\n/).map((g) => g.trim()).filter(Boolean).map((grp) => {
      const bm = (grp.match(/BMID:\s*(.+)/i) || [])[1]?.trim() || '';
      const links = grp.split(/\r?\n/)
        .map((l) => (l.match(/^链接:\s*(.+)$/) || [])[1])
        .map((s) => (s || '').trim())
        .filter(Boolean) as string[];
      if (!links.length) {
        const single = grp.match(/^(https?:\/\/\S+)$/);
        if (single) links.push(single[1]);
      }
      return { bm, links };
    });
  };

  const openBuy = (p: any) => { setBuying(p); setQty(1); setBuyEmail(buyer?.account?.includes('@') ? buyer.account : ''); setBuyPhone(''); setOrderDone(null); };

  // 订单卡片（登录后与查单结果共用）
  const OrderCard: React.FC<{ o: ShopOrder }> = ({ o }) => {
    const st = statusView(o.status);
    return (
      <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-white">{o.order_no}</span>
            <CopyBtn text={o.order_no} title="复制订单号" />
          </div>
          <span className={`px-2 py-0.5 text-xs rounded-full border ${st.cls}`}>{st.label}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
          <span>{o.product_title || '-'}</span>
          <span>×{o.quantity || 1}</span>
          <span className="font-bold text-emerald-400">{Number(o.total ?? o.price ?? 0).toFixed(2)} {o.currency}</span>
          {o.created_at && <span>{new Date(o.created_at).toLocaleString()}</span>}
        </div>
        {o.status === 'delivered' && o.deliver_content && parseDeliver(o.deliver_content).length > 0 && (
          <div className="mt-3 bg-indigo-600/10 border border-indigo-500/30 rounded-lg px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="flex items-center gap-1.5 text-xs font-bold text-indigo-300">
                <Link2 className="w-4 h-4" /> 发货内容{parseDeliver(o.deliver_content).length > 1 ? `（${parseDeliver(o.deliver_content).length} 组）` : ''}
              </span>
              <CopyBtn text={o.deliver_content} title="复制全部" />
            </div>
            <div className="flex flex-col gap-2">
              {parseDeliver(o.deliver_content).map((it, i) => (
                <div key={i} className="flex flex-col gap-1">
                  {it.bm && <span className="font-mono text-xs text-slate-300">BMID: {it.bm}</span>}
                  {it.links.map((link, j) => (
                    <div key={j} className="flex flex-wrap items-center gap-2 text-xs">
                      <a href={link} target="_blank" rel="noopener noreferrer" title={link}
                        className="font-mono text-indigo-300 hover:underline break-all flex-1 min-w-0">{link}</a>
                      <a href={link} target="_blank" rel="noopener noreferrer" title="打开"
                        className="p-1 rounded-md bg-slate-900 text-slate-400 hover:text-indigo-400 border border-slate-700 shrink-0">
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <CopyBtn text={link} title="复制链接" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
        {o.status === 'pending' && payInfo && (
          <div className="mt-3 text-xs text-amber-300/90 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2 whitespace-pre-wrap">{payInfo}</div>
        )}
      </div>
    );
  };

  // 商品卡片
  const ProductCard: React.FC<{ p: any }> = ({ p }) => {
    const out = soldOut(p);
    const st = stockOf(p);
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-2 hover:border-indigo-500/40 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-bold text-white leading-snug">{p.title}</h3>
          <span className="px-2 py-0.5 text-[10px] rounded-full border border-slate-700 bg-slate-800 text-slate-400 uppercase shrink-0">{p.product_type}</span>
        </div>
        {p.description && <p className="text-xs text-slate-400 whitespace-pre-wrap break-words leading-relaxed line-clamp-3">{p.description}</p>}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <div>
            <div className="text-lg font-bold text-emerald-400">{Number(p.price).toFixed(2)} <span className="text-xs text-slate-500">{p.currency}</span></div>
            <div className="text-[10px] text-slate-500">{st === Infinity ? '库存充足' : `剩余 ${Math.max(st, 0)} 件`}</div>
          </div>
          <button
            onClick={() => openBuy(p)}
            disabled={out}
            className={`px-3 py-1.5 text-sm font-bold rounded-lg ${out ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
          >
            {out ? '已售罄' : '立即购买'}
          </button>
        </div>
      </div>
    );
  };

  const ungrouped = products.filter(p => p.block_id === null || p.block_id === undefined);

  return (
    <div className="min-h-[calc(100vh-64px)] lg:min-h-[calc(100vh-48px)] bg-slate-950/50 rounded-xl border border-slate-800 p-6">
      {/* 顶部：标题 + 右上角订单按钮 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-indigo-600/20 flex items-center justify-center border border-indigo-500/30">
            <ShoppingCart className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">BM 商城</h2>
            <p className="text-sm text-slate-400">Business Manager / 广告账号 · 下单即购，可留邮箱或电话自动记录订单</p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start md:self-auto">
          <button onClick={() => { loadProducts(); }} className="p-2.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700" title="刷新商品">
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => { setShowOrders(true); if (buyer) loadMyOrders(); loadLocalOrders(); }}
            className="px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold inline-flex items-center gap-2"
          >
            <ClipboardList className="w-4 h-4" />
            我的订单
            {displayOrders.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-white/20">{displayOrders.length}</span>
            )}
          </button>
          {buyer ? (
            <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-slate-400 px-2">
              <User className="w-3.5 h-3.5" /> {buyer.account}
            </span>
          ) : (
            <button onClick={() => { setShowLogin(true); setAuthError(''); }} className="px-3 py-2.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 text-sm">
              登录
            </button>
          )}
        </div>
      </div>

      {error && <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-sm text-rose-200">{error}</div>}

      {/* 商品区：按块渲染，块内自动排列 */}
      {loading && products.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-slate-500"><Loader2 className="w-8 h-8 animate-spin" /></div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-500">
          <Package className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">暂无在售商品，请稍后再来</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-5 items-start">
          {blocks.map((b) => {
            const items = products.filter(p => Number(p.block_id) === Number(b.id));
            if (items.length === 0) return null;
            return (
              <section
                key={b.id}
                id={`shop-block-${b.id}`}
                className="bg-slate-900/40 border border-slate-800 rounded-2xl p-4 scroll-mt-6"
                style={{ width: Number(b.width_px) || 380, maxWidth: '100%', minHeight: Number(b.min_height_px) || 0 }}
              >
                <div className="mb-3">
                  <h3 className="text-base font-bold text-white">{b.title}</h3>
                  {b.description && <p className="text-xs text-slate-400 mt-1 whitespace-pre-wrap break-words">{b.description}</p>}
                </div>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
                  {items.map(p => <ProductCard key={p.id} p={p} />)}
                </div>
              </section>
            );
          })}
          {ungrouped.length > 0 && (
            <section id="shop-block-ungrouped" className="bg-slate-900/40 border border-slate-800 rounded-2xl p-4 scroll-mt-6" style={{ width: 760, maxWidth: '100%' }}>
              <h3 className="text-base font-bold text-white mb-3">其他商品</h3>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
                {ungrouped.map(p => <ProductCard key={p.id} p={p} />)}
              </div>
            </section>
          )}
        </div>
      )}

      {/* 右侧块定位滑杆：每个块一个可点击节点，滚动时高亮当前块 */}
      {blocks.length > 0 && (
        <div className="hidden lg:flex fixed right-4 top-1/2 -translate-y-1/2 z-40 flex-col items-center py-4 px-1.5 rounded-full bg-slate-900/85 border border-slate-700 backdrop-blur shadow-lg max-h-[80vh] overflow-y-auto custom-scrollbar">
          <div className="absolute left-1/2 -translate-x-1/2 top-6 bottom-6 w-px bg-slate-700" aria-hidden="true"></div>
          {[
            ...blocks.map((b) => ({ id: `shop-block-${b.id}`, title: b.title })),
            ...(ungrouped.length > 0 ? [{ id: 'shop-block-ungrouped', title: '其他商品' }] : []),
          ].map((it) => {
            const active = activeBlock === it.id;
            return (
              <button key={it.id} onClick={() => jumpToBlock(it.id)} title={it.title}
                className="group relative flex items-center justify-center w-8 h-8 shrink-0">
                <span className={`w-2.5 h-2.5 rounded-full border transition-all ${active ? 'bg-indigo-400 border-indigo-300 scale-125' : 'bg-slate-600 border-slate-500 group-hover:bg-indigo-400 group-hover:border-indigo-300'}`}></span>
                <span className={`pointer-events-none absolute right-9 whitespace-nowrap text-xs px-2 py-1 rounded-md bg-slate-800 text-slate-200 border border-slate-700 shadow transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                  {it.title}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ===== 我的订单 面板（右上角按钮唤出）===== */}
      {showOrders && (
        <div className="fixed inset-0 z-[100]">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowOrders(false)}></div>
          <div className="absolute right-0 top-0 h-full w-full max-w-lg bg-slate-900 border-l border-slate-800 flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-slate-800">
              <h3 className="text-base font-bold text-white flex items-center gap-2"><ClipboardList className="w-4 h-4 text-indigo-400" /> 我的订单</h3>
              <div className="flex items-center gap-2">
                {buyer && (
                  <>
                    <button onClick={() => { setShowPwd(true); setPwdOld(''); setPwdNew(''); }} title={buyer.has_password ? '修改密码' : '设置密码'}
                      className="p-2 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 hover:text-indigo-300">
                      <KeyRound className="w-4 h-4" />
                    </button>
                    <button onClick={doLogout} title="退出登录"
                      className="p-2 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 hover:text-rose-400">
                      <LogOut className="w-4 h-4" />
                    </button>
                  </>
                )}
                <button onClick={() => setShowOrders(false)} className="p-2 text-slate-500 hover:text-white"><X className="w-5 h-5" /></button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-3">
              {buyer ? (
                <>
                  <div className="flex items-center justify-between text-xs text-slate-400 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
                    <span className="inline-flex items-center gap-1.5"><User className="w-3.5 h-3.5" /> {buyer.account}</span>
                    {!buyer.has_password && <span className="text-amber-400">建议先设置密码（换设备可登录）</span>}
                  </div>
                  {ordersLoading && displayOrders.length === 0 ? (
                    <div className="flex justify-center py-10 text-slate-500"><Loader2 className="w-7 h-7 animate-spin" /></div>
                  ) : displayOrders.length === 0 ? (
                    <p className="text-xs text-slate-500 text-center py-8">还没有订单</p>
                  ) : displayOrders.map(o => <OrderCard key={o.order_no} o={o} />)}
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-500">未登录。用本机下过的单会自动列在下面（含匿名下单）；也可用订单号或下单填的邮箱/电话查询，或<span className="text-indigo-400">用密码登录</span>查看全部订单。</p>
                  <div className="space-y-2">
                    <input value={queryNo} onChange={(e) => setQueryNo(e.target.value)} placeholder="订单号，如 SMUK..."
                      className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
                    <div className="flex items-center gap-2">
                      <input value={queryContact} onChange={(e) => setQueryContact(e.target.value)} placeholder="或 下单填的邮箱 / 电话"
                        className="flex-1 px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
                      <button onClick={doGuestQuery} disabled={querying}
                        className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg inline-flex items-center gap-1.5 disabled:opacity-50">
                        {querying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} 查询
                      </button>
                    </div>
                    <button onClick={() => { setShowLogin(true); setAuthError(''); }} className="w-full py-2.5 bg-slate-800 text-slate-200 border border-slate-700 rounded-lg text-sm font-bold">
                      用密码登录
                    </button>
                  </div>
                  {guestDisplay.length > 0 && <p className="text-[11px] text-slate-600 pt-1">本机订单（含匿名下单）</p>}
                  {guestDisplay.map(o => <OrderCard key={o.order_no} o={o} />)}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== 买家登录 ===== */}
      {showLogin && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowLogin(false)}></div>
          <div className="relative w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6">
            <button onClick={() => setShowLogin(false)} className="absolute top-4 right-4 text-slate-500 hover:text-white"><X className="w-5 h-5" /></button>
            <h3 className="text-base font-bold text-white mb-4">买家登录</h3>
            <div className="space-y-3">
              <input value={loginAccount} onChange={(e) => setLoginAccount(e.target.value)} placeholder="下单时的邮箱或电话"
                className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
              <input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)} placeholder="密码"
                onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }}
                className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
              {authError && <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">{authError}</div>}
              <button onClick={doLogin} disabled={authBusy}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg disabled:opacity-50">
                {authBusy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : null} 登录
              </button>
            </div>
            <p className="text-[11px] text-slate-600 mt-4">没设置过密码？先用下单时的邮箱/电话下单（会自动登录），再在「我的订单」里设置密码。</p>
          </div>
        </div>
      )}

      {/* ===== 设置 / 修改密码 ===== */}
      {showPwd && buyer && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowPwd(false)}></div>
          <div className="relative w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6">
            <h3 className="text-base font-bold text-white mb-1">{buyer.has_password ? '修改密码' : '设置密码'}</h3>
            <p className="text-xs text-slate-500 mb-4">账号：{buyer.account}</p>
            <div className="space-y-3 mb-4">
              {buyer.has_password && (
                <input type="password" value={pwdOld} onChange={(e) => setPwdOld(e.target.value)} placeholder="原密码"
                  className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
              )}
              <input type="password" value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} placeholder="新密码（至少 6 位）"
                className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
            </div>
            <button onClick={savePassword} disabled={authBusy}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg disabled:opacity-50">
              {authBusy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : null} 确认
            </button>
          </div>
        </div>
      )}

      {/* ===== 下单弹窗（可选数量）===== */}
      {buying && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setBuying(null)}></div>
          <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6">
            <button onClick={() => setBuying(null)} className="absolute top-4 right-4 text-slate-500 hover:text-white"><X className="w-5 h-5" /></button>
            {!orderDone ? (
              <>
                <h3 className="text-lg font-bold text-white mb-1">确认下单</h3>
                <p className="text-sm text-slate-400 mb-4">{buying.title}</p>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm text-slate-400">单价 {Number(buying.price).toFixed(2)} {buying.currency}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setQty(q => Math.max(1, q - 1))} className="p-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-300"><Minus className="w-3.5 h-3.5" /></button>
                    <input type="number" min={1} max={stockOf(buying) === Infinity ? 999 : stockOf(buying)} value={qty}
                      onChange={(e) => setQty(Math.min(Math.max(parseInt(e.target.value, 10) || 1, 1), stockOf(buying) === Infinity ? 999 : stockOf(buying)))}
                      className="w-16 px-2 py-1.5 bg-slate-800/70 border border-slate-700 rounded-md text-sm text-white text-center" />
                    <button onClick={() => setQty(q => Math.min(q + 1, stockOf(buying) === Infinity ? 999 : stockOf(buying)))}
                      className="p-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-300"><Plus className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
                <div className="text-2xl font-bold text-emerald-400 mb-4">
                  {(Number(buying.price) * qty).toFixed(2)} <span className="text-sm text-slate-500">{buying.currency}</span>
                </div>
                <div className="space-y-3 mb-4">
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">邮箱（选填，填了就自动记录订单并登录）</label>
                    <input value={buyEmail} onChange={(e) => setBuyEmail(e.target.value)} placeholder="you@example.com"
                      className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">电话（选填，也可作账号）</label>
                    <input value={buyPhone} onChange={(e) => setBuyPhone(e.target.value)} placeholder="+8613800000000"
                      className="w-full px-3 py-2.5 bg-slate-800/70 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500" />
                  </div>
                  <p className="text-xs text-slate-500 flex items-start gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-600" />
                    两项都留空＝匿名下单：请保存好订单号，凭订单号在「我的订单」里查询。
                  </p>
                </div>
                <button onClick={submitOrder} disabled={ordering}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl inline-flex items-center justify-center gap-2 disabled:opacity-50">
                  {ordering ? <Loader2 className="w-4 h-4 animate-spin" /> : null} 提交订单
                </button>
              </>
            ) : (
              <>
                <h3 className="text-lg font-bold text-white mb-4">下单成功</h3>
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 mb-4">
                  <div className="text-xs text-slate-500 mb-1">订单号（请保存，凭此查单收货）</div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-mono font-bold text-white">{orderDone.order_no}</span>
                    <CopyBtn text={orderDone.order_no} title="复制订单号" />
                  </div>
                  <div className="text-xs text-slate-400 mt-2">
                    {orderDone.product_title} ×{orderDone.quantity} · <span className="text-emerald-400 font-bold">{Number(orderDone.total ?? 0).toFixed(2)} {orderDone.currency}</span>
                  </div>
                </div>
                {orderDone.buyer_token && (
                  <div className="mb-4 text-xs text-green-300 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 flex items-start gap-2">
                    <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>已自动登录（{orderDone.buyer_account}）{orderDone.buyer_has_password ? '' : '。建议到「我的订单 → 设置密码」，换设备也能登录。'}</span>
                  </div>
                )}
                {payInfo && (
                  <div className="mb-4">
                    <div className="text-xs text-slate-500 mb-1">收款方式</div>
                    <div className="text-sm text-amber-300/90 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2 whitespace-pre-wrap">{payInfo}</div>
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => { setBuying(null); setShowOrders(true); loadMyOrders(); }}
                    className="flex-1 py-3 bg-slate-800 text-slate-200 border border-slate-700 font-bold rounded-xl">查看我的订单</button>
                  <button onClick={() => setBuying(null)} className="flex-1 py-3 bg-indigo-600 text-white font-bold rounded-xl">继续购物</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Shop;
