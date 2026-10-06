/**
 * 充值中心（U 充值 · TRC20-USDT）
 *
 * 流程：输入金额 → 服务端生成带 4 位随机小数的应付金额（全局唯一，链上自动定位订单）
 *       → 转账到收款地址 → TronGrid 自动对账到账（管理员手动确认兜底）
 *
 * 管理端（superadmin）：收款地址 / TronGrid Key / 金额上下限配置 + 手动确认/拒绝。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wallet, Copy, CheckCircle2, XCircle, Clock, Loader2, RefreshCw, ShieldCheck,
  AlertTriangle, ExternalLink, Coins,
} from 'lucide-react';
import { useAppContext } from './AppContext';

/* ---------- 类型 ---------- */

interface Order {
  id: number;
  orderNo: string;
  userId: number;
  baseAmount: number;
  amount: number;
  amountStr: string;
  network: string;
  walletAddress: string;
  status: string;
  txHash: string;
  confirmedAt: string;
  expiresAt: string;
  createdAt: string;
  userEmail?: string;
}

interface ActiveOrder {
  orderId: number;
  orderNo: string;
  amountStr: string;
  network: string;
  walletAddress: string;
  expiresAt: string;
}

/* ---------- 通用 ---------- */

const authedFetch = async (path: string, init?: RequestInit) => {
  const token = localStorage.getItem('auth_token') || '';
  const resp = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const j = await resp.json().catch(() => null);
  if (!resp.ok || !j?.success) throw new Error(j?.message || `HTTP ${resp.status}`);
  return j;
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { icon: React.ReactNode; cls: string; text: string }> = {
    confirmed: { icon: <CheckCircle2 className="w-3.5 h-3.5" />, cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', text: '已到账' },
    pending: { icon: <Clock className="w-3.5 h-3.5" />, cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', text: '待到账' },
    rejected: { icon: <XCircle className="w-3.5 h-3.5" />, cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30', text: '已拒绝' },
    expired: { icon: <XCircle className="w-3.5 h-3.5" />, cls: 'bg-slate-500/10 text-slate-400 border-slate-600/40', text: '已过期' },
  };
  const it = map[status] || { icon: <Clock className="w-3.5 h-3.5" />, cls: 'bg-slate-500/10 text-slate-400 border-slate-600/40', text: status };
  return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] whitespace-nowrap ${it.cls}`}>{it.icon}{it.text}</span>;
};

const CopyBtn: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="复制"
      className={`inline-flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 transition-colors ${className || ''}`}
      onClick={async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(text); } catch {
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        }
        setCopied(true); setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

const fmtTime = (iso: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/* ---------- 页面 ---------- */

export const RechargeCenter: React.FC = () => {
  const { user } = useAppContext();
  const isSuperadmin = user?.role === 'superadmin';

  const [balance, setBalance] = useState<number | null>(null);
  const [cfg, setCfg] = useState<{ walletAddress: string; network: string; minAmount: number; maxAmount: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState<ActiveOrder | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  // 管理端
  const [adminCfg, setAdminCfg] = useState<{ walletAddress: string; tronGridKey: string; minAmount: string; maxAmount: string }>({ walletAddress: '', tronGridKey: '', minAmount: '10', maxAmount: '100000' });
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgSavedTip, setCfgSavedTip] = useState('');
  const [actingId, setActingId] = useState<number>(0);

  const loadAll = useCallback(async () => {
    try {
      const [cfgRes, orderRes] = await Promise.all([
        authedFetch('/recharge/config'),
        authedFetch('/recharge/orders'),
      ]);
      setCfg(cfgRes.data);
      setBalance(Number(cfgRes.data?.balance) || 0);
      setOrders(orderRes.data?.orders || []);
      setError('');
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // 有待到账订单时 15s 轮询刷新（对账到账后状态自动变「已到账」）
  const hasPending = useMemo(() => orders.some((o) => o.status === 'pending') || !!active, [orders, active]);
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => { loadAll(); }, 15000);
    return () => clearInterval(t);
  }, [hasPending, loadAll]);

  // 管理端配置加载
  useEffect(() => {
    if (!isSuperadmin) return;
    authedFetch('/recharge/admin/config').then((r) => {
      const d = r.data || {};
      setAdminCfg({ walletAddress: d.walletAddress || '', tronGridKey: '', minAmount: String(d.minAmount ?? 10), maxAmount: String(d.maxAmount ?? 100000) });
    }).catch(() => {});
  }, [isSuperadmin]);

  const createOrder = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) { setError('请输入有效的充值金额'); return; }
    setCreating(true); setError('');
    try {
      const r = await authedFetch('/recharge/create', { method: 'POST', body: JSON.stringify({ amount: n }) });
      const d = r.data;
      setActive({ orderId: d.orderId, orderNo: d.orderNo, amountStr: d.amountStr, network: d.network, walletAddress: d.walletAddress, expiresAt: d.expiresAt });
      setAmount('');
      loadAll();
    } catch (e: any) {
      setError(e?.message || '创建订单失败');
    } finally {
      setCreating(false);
    }
  };

  const saveAdminCfg = async () => {
    setSavingCfg(true); setCfgSavedTip('');
    try {
      const payload: any = {
        walletAddress: adminCfg.walletAddress,
        minAmount: Number(adminCfg.minAmount) || 10,
        maxAmount: Number(adminCfg.maxAmount) || 100000,
      };
      // Key 输入框留空 = 不修改（避免误清）
      if (adminCfg.tronGridKey.trim()) payload.tronGridKey = adminCfg.tronGridKey.trim();
      await authedFetch('/recharge/admin/config', { method: 'POST', body: JSON.stringify(payload) });
      setAdminCfg((c) => ({ ...c, tronGridKey: '' }));
      setCfgSavedTip('已保存');
      setTimeout(() => setCfgSavedTip(''), 2000);
      loadAll();
    } catch (e: any) {
      setCfgSavedTip(e?.message || '保存失败');
    } finally {
      setSavingCfg(false);
    }
  };

  const adminAct = async (orderId: number, action: 'confirm' | 'reject') => {
    setActingId(orderId);
    try {
      await authedFetch(`/recharge/admin/${action}`, { method: 'POST', body: JSON.stringify({ orderId }) });
      loadAll();
    } catch (e: any) {
      alert(e?.message || '操作失败');
    } finally {
      setActingId(0);
    }
  };

  const quickAmounts = [50, 100, 200, 500, 1000];

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
      {/* 头部 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <Wallet className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">充值中心</h1>
            <div className="text-xs text-slate-500">TRC20-USDT 充值 · 按金额自动对账到账</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[11px] text-slate-500">账户余额 (USDT)</div>
            <div className="text-xl font-semibold text-emerald-400 font-mono">{balance === null ? '—' : balance.toFixed(2)}</div>
          </div>
          <button onClick={loadAll} className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors" title="刷新">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {/* 充值表单 + 当前订单 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="text-sm font-medium text-slate-200 mb-3">发起充值</div>
          <div className="flex items-center rounded-xl border border-slate-700 bg-slate-950/60 focus-within:border-indigo-500 transition-colors">
            <span className="pl-3 pr-1 text-slate-500"><Coins className="w-4 h-4" /></span>
            <input
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={`输入金额（${cfg?.minAmount ?? 10} ~ ${cfg?.maxAmount ?? 100000}）`}
              className="flex-1 bg-transparent py-2.5 pr-2 text-sm text-slate-100 placeholder-slate-600 outline-none"
            />
            <span className="pr-3 text-xs text-slate-500 font-mono">USDT</span>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {quickAmounts.map((q) => (
              <button key={q} type="button" onClick={() => setAmount(String(q))}
                className="px-3 py-1 rounded-lg text-xs border border-slate-700 text-slate-300 hover:border-indigo-500 hover:text-indigo-300 transition-colors">
                {q}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={creating || !String(amount).trim()}
            onClick={createOrder}
            className="mt-4 w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            生成充值订单
          </button>
          <div className="mt-3 text-[11px] leading-relaxed text-slate-500">
            系统会在你输入的金额后追加 4 位随机小数（例如 100 → 100.3748），用于链上唯一识别这笔订单。转账时请务必按页面显示的<b className="text-slate-400">完整金额</b>转账，含小数位。
          </div>
        </div>

        {/* 当前待付款订单 */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="text-sm font-medium text-slate-200 mb-3">待付款订单</div>
          {active ? (
            <ActiveOrderCard order={active} onClose={() => setActive(null)} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-10 h-10 rounded-xl bg-slate-800/60 border border-slate-700 flex items-center justify-center text-slate-500 mb-2">
                <Clock className="w-5 h-5" />
              </div>
              <div className="text-sm text-slate-400">暂无待付款订单</div>
              <div className="text-xs text-slate-600 mt-1">左侧输入金额生成订单后，这里会显示收款信息</div>
            </div>
          )}
        </div>
      </div>

      {/* 订单记录 */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
          <div className="text-sm font-medium text-slate-200">充值记录</div>
          {hasPending && <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500"><Loader2 className="w-3 h-3 animate-spin" />每 15 秒自动刷新对账结果</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800 bg-slate-950/40">
                <th className="px-5 py-2.5 font-medium">订单号</th>
                {isSuperadmin && <th className="px-4 py-2.5 font-medium">用户</th>}
                <th className="px-4 py-2.5 font-medium">应付金额</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">交易哈希</th>
                <th className="px-4 py-2.5 font-medium">创建时间</th>
                {isSuperadmin && <th className="px-4 py-2.5 font-medium text-right">操作</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {orders.length === 0 ? (
                <tr><td colSpan={isSuperadmin ? 7 : 6} className="px-5 py-10 text-center text-slate-500 text-sm">还没有充值记录</td></tr>
              ) : orders.map((o) => (
                <tr key={o.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-slate-400">{o.orderNo}</td>
                  {isSuperadmin && <td className="px-4 py-3 text-xs text-slate-400">{o.userEmail || `#${o.userId}`}</td>}
                  <td className="px-4 py-3 font-mono text-slate-100">{o.amountStr}</td>
                  <td className="px-4 py-3"><StatusBadge status={o.status} /></td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {o.txHash ? (
                      o.txHash === 'manual'
                        ? <span className="text-slate-500">人工确认</span>
                        : <a href={`https://tronscan.org/#/transaction/${o.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300">
                            {o.txHash.slice(0, 10)}…{o.txHash.slice(-6)}<ExternalLink className="w-3 h-3" />
                          </a>
                    ) : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{fmtTime(o.createdAt)}</td>
                  {isSuperadmin && (
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {o.status === 'pending' ? (
                        <>
                          <button onClick={() => adminAct(o.id, 'confirm')} disabled={actingId === o.id}
                            className="mr-1.5 px-2 py-1 rounded-md text-[11px] bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors">
                            确认到账
                          </button>
                          <button onClick={() => adminAct(o.id, 'reject')} disabled={actingId === o.id}
                            className="px-2 py-1 rounded-md text-[11px] bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 disabled:opacity-40 transition-colors">
                            拒绝
                          </button>
                        </>
                      ) : <span className="text-slate-600 text-[11px]">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 管理端配置 */}
      {isSuperadmin && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-4 h-4 text-indigo-400" />
            <div className="text-sm font-medium text-slate-200">系统配置（仅管理员）</div>
          </div>
          <div className="text-[11px] text-slate-500 mb-4">
            TronGrid API Key 在 trongrid.io 免费注册获取；不填也能对账（无 Key 有限流），建议配置。
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs text-slate-400 mb-1.5 block">USDT 收款地址（TRC20）</span>
              <input value={adminCfg.walletAddress} onChange={(e) => setAdminCfg((c) => ({ ...c, walletAddress: e.target.value }))}
                placeholder="T 开头的 TRON 地址"
                className="w-full px-3 py-2 rounded-lg bg-slate-950/60 border border-slate-700 focus:border-indigo-500 text-sm text-slate-100 placeholder-slate-600 outline-none font-mono" />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400 mb-1.5 block">TronGrid API Key（留空 = 不修改）</span>
              <input value={adminCfg.tronGridKey} onChange={(e) => setAdminCfg((c) => ({ ...c, tronGridKey: e.target.value }))}
                placeholder="已配置" type="password"
                className="w-full px-3 py-2 rounded-lg bg-slate-950/60 border border-slate-700 focus:border-indigo-500 text-sm text-slate-100 placeholder-slate-600 outline-none font-mono" />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400 mb-1.5 block">单笔最低金额 (USDT)</span>
              <input value={adminCfg.minAmount} onChange={(e) => setAdminCfg((c) => ({ ...c, minAmount: e.target.value }))} type="number" min="1"
                className="w-full px-3 py-2 rounded-lg bg-slate-950/60 border border-slate-700 focus:border-indigo-500 text-sm text-slate-100 outline-none font-mono" />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400 mb-1.5 block">单笔最高金额 (USDT)</span>
              <input value={adminCfg.maxAmount} onChange={(e) => setAdminCfg((c) => ({ ...c, maxAmount: e.target.value }))} type="number" min="1"
                className="w-full px-3 py-2 rounded-lg bg-slate-950/60 border border-slate-700 focus:border-indigo-500 text-sm text-slate-100 outline-none font-mono" />
            </label>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button onClick={saveAdminCfg} disabled={savingCfg}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium transition-colors">
              {savingCfg ? <Loader2 className="w-4 h-4 animate-spin" /> : null}保存配置
            </button>
            {cfgSavedTip && <span className="text-xs text-emerald-400">{cfgSavedTip}</span>}
          </div>
        </div>
      )}
    </div>
  );
};

/* ---------- 待付款订单卡片（含倒计时）---------- */

const ActiveOrderCard: React.FC<{ order: ActiveOrder; onClose: () => void }> = ({ order, onClose }) => {
  const [leftSec, setLeftSec] = useState(() => Math.max(0, Math.floor((Date.parse(order.expiresAt) - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      const s = Math.max(0, Math.floor((Date.parse(order.expiresAt) - Date.now()) / 1000));
      setLeftSec(s);
      if (s <= 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [order.expiresAt]);

  const mm = String(Math.floor(leftSec / 60)).padStart(2, '0');
  const ss = String(leftSec % 60).padStart(2, '0');
  const expired = leftSec <= 0;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-400">应付金额（务必完整复制，含小数）</span>
          <span className={`text-xs font-mono ${expired ? 'text-rose-400' : 'text-amber-300'}`}>
            {expired ? '已过期' : `剩余 ${mm}:${ss}`}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-semibold text-emerald-400 font-mono tracking-wide">{order.amountStr}</span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-slate-600 text-[11px] text-slate-300">{order.network}</span>
        </div>
        <div className="border-t border-slate-700/50 pt-3">
          <div className="text-[11px] text-slate-400 mb-1.5">收款地址（{order.network} 网络）</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-slate-200 font-mono break-all leading-relaxed">{order.walletAddress}</code>
            <CopyBtn text={order.walletAddress} />
          </div>
        </div>
        <div className="border-t border-slate-700/50 pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">金额（复制金额）</span>
            <CopyBtn text={order.amountStr} />
          </div>
        </div>
      </div>
      <div className="text-[11px] leading-relaxed text-slate-500">
        到账确认由链上自动对账完成（通常 1~3 分钟），无需人工操作。请勿修改金额小数位，否则无法自动匹配。
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-slate-600">{order.orderNo}</span>
        <button onClick={onClose} className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors">关闭</button>
      </div>
    </div>
  );
};
