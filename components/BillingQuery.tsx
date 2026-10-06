/**
 * 账单查询（Meta 广告号账单 / 花费信息）
 *
 * 数据存云端 ad_accounts 表的 spend / balance / threshold_amount / funding_source 等列
 * （本地后端抓 billing-info 后 bulk-save 更新，与「广告账户」页同一份数据）。
 * 本页职责：只读展示 + 「刷新账单数据」提交本机队列（fetch_billing，按配置分组）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CreditCard, RefreshCw, Loader2, Search, AlertCircle, Wallet, CheckCircle2, XCircle,
} from 'lucide-react';
import { submitJob, waitForJob, Job } from './jobQueue';

/* ---------- 类型 ---------- */

/** 云端 /api/adaccounts 返回的原始行（snake_case，a.* 全列） */
interface AdAccountRow {
  account_id: string;
  name: string;
  status: string;
  currency: string;
  spend: number;
  balance: number;
  threshold_amount: number;
  credit_limit: number;
  funding_source: string;
  profile_id: string;
  profile_name: string;
  owner_email?: string;
  updated_at?: string;
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

/** Meta account_status 数字映射（1 Active / 2 Disabled / 3 Unsettled 等） */
const STATUS_MAP: Record<string, { text: string; cls: string }> = {
  '1': { text: 'Active', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  '2': { text: 'Disabled', cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
  '3': { text: 'Unsettled', cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
  '7': { text: 'Risk Review', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  '8': { text: 'Grace Period', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  '9': { text: 'Pending Settlement', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  '100': { text: 'Pending Closure', cls: 'bg-slate-500/10 text-slate-400 border-slate-600/40' },
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const key = String(status || '').trim();
  const it = STATUS_MAP[key] || { text: key || '—', cls: 'bg-slate-500/10 text-slate-400 border-slate-600/40' };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] whitespace-nowrap ${it.cls}`}>
      {key === '1' ? <CheckCircle2 className="w-3 h-3" /> : key === '2' || key === '3' ? <XCircle className="w-3 h-3" /> : null}
      {it.text}
    </span>
  );
};

const fmtInt = (n: number) => new Intl.NumberFormat('zh-CN').format(Math.round(Number(n) || 0));
const fmtDec = (n: number, d = 2) => (Number(n) || 0).toFixed(d);

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 花费 / 上限用量进度条 */
const UsageBar: React.FC<{ spend: number; threshold: number; currency: string }> = ({ spend, threshold, currency }) => {
  if (!threshold || threshold <= 0) return <span className="text-slate-500 text-xs">—</span>;
  const pct = Math.min((spend / threshold) * 100, 100);
  const color = pct >= 80 ? 'bg-rose-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="min-w-[110px]">
      <div className="flex justify-between text-[11px] text-slate-400 tabular-nums mb-1">
        <span>{fmtDec(spend)}</span>
        <span className="text-slate-500">/ {fmtDec(threshold)}{currency ? ` ${currency}` : ''}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

/* ---------- 页面 ---------- */

export const BillingQuery: React.FC = () => {
  const [accounts, setAccounts] = useState<AdAccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const loadAccounts = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const j = await authedFetch('/adaccounts');
      if (mounted.current) setAccounts(Array.isArray(j.data) ? j.data : []);
    } catch (e: any) {
      if (mounted.current) { setError(String(e.message || e)); setAccounts([]); }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  /** 提交「查询账单信息」队列任务：按配置分组借用浏览器抓 Graph，结果 bulk-save 回云端 */
  const syncBilling = async () => {
    if (syncing) return;
    setError('');
    const byProfile = new Map<string, { label: string; ids: string[] }>();
    accounts.forEach(a => {
      const pid = String(a.profile_id || '');
      if (!pid) return;
      if (!byProfile.has(pid)) byProfile.set(pid, { label: String(a.profile_name || pid), ids: [] });
      byProfile.get(pid)!.ids.push(String(a.account_id).replace(/^act_/i, ''));
    });
    if (!byProfile.size) { setError('暂无广告账户，请先在「广告账户」页获取信息'); return; }
    const items = [...byProfile.entries()].map(([pid, g]) => ({
      key: pid,
      label: g.label,
      payload: { profileId: pid, adAccountIds: g.ids },
    }));
    setSyncing(true); setSyncMsg('提交中...'); setJob(null);
    try {
      const j = await submitJob({ type: 'fetch_billing', title: '查询账单信息', items, concurrency: 2 });
      setJob(j);
      setSyncMsg(`0/${items.length}`);
      const done = await waitForJob(j.id, (cur) => {
        if (cur) setSyncMsg(`${cur.done}/${cur.total}`);
      });
      setSyncMsg(done && done.status === 'done' ? '刷新完成' : '刷新未完成');
      await loadAccounts();
    } catch (e: any) {
      setError(String(e.message || e));
      setSyncMsg('');
    } finally {
      if (mounted.current) setSyncing(false);
    }
  };

  const displayRows = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const filtered = kw
      ? accounts.filter(a => [a.name, a.account_id, a.profile_name, a.funding_source, a.owner_email]
        .some(v => String(v || '').toLowerCase().includes(kw)))
      : accounts;
    // 花费降序（本地排，云端默认按 updated_at）
    return [...filtered].sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0));
  }, [accounts, search]);

  const totals = useMemo(() => {
    const spend = accounts.reduce((s, a) => s + (Number(a.spend) || 0), 0);
    const balance = accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
    const active = accounts.filter(a => String(a.status).trim() === '1').length;
    const curs = [...new Set(accounts.map(a => String(a.currency || '').trim()).filter(Boolean))];
    return { spend, balance, active, currency: curs.length === 1 ? curs[0] : curs.length > 1 ? '混合币种' : '' };
  }, [accounts]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">
      {/* 头部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-indigo-400" />账单查询
          </h2>
          <p className="text-xs text-slate-500 mt-1">广告号花费 / 花销上限 / 待结余额 / 支付方式，数据同步自 Facebook 账单信息</p>
        </div>
        <div className="flex items-center gap-2">
          {syncing && (
            <span className="text-xs text-indigo-300 bg-indigo-500/10 border border-indigo-500/30 rounded-md px-2 py-1">
              <Loader2 className="w-3 h-3 inline animate-spin mr-1" />刷新中 {syncMsg}
            </span>
          )}
          {!syncing && (syncMsg === '刷新完成' || syncMsg === '刷新未完成') && (
            <span className={`text-xs rounded-md px-2 py-1 border ${syncMsg === '刷新完成'
              ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
              : 'text-amber-300 bg-amber-500/10 border-amber-500/30'}`}>{syncMsg}</span>
          )}
          <button
            onClick={loadAccounts}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="刷新列表"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={syncBilling}
            disabled={syncing || loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            刷新账单数据
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {/* 汇总卡 + 搜索 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2"><Wallet className="w-4 h-4" />广告账户</div>
          <div className="text-xl font-semibold text-slate-100 tabular-nums">{accounts.length}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2"><CheckCircle2 className="w-4 h-4 text-emerald-400" />Active</div>
          <div className="text-xl font-semibold text-slate-100 tabular-nums">{totals.active}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2"><CreditCard className="w-4 h-4 text-emerald-400" />总花费</div>
          <div className="text-xl font-semibold text-slate-100 tabular-nums">
            {fmtDec(totals.spend)}{totals.currency === '混合币种' ? '' : totals.currency ? ` ${totals.currency}` : ''}
          </div>
          {totals.currency === '混合币种' && <div className="text-[11px] text-slate-500 mt-1">账户币种不一致，仅供参考</div>}
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 text-slate-400 text-xs mb-2"><AlertCircle className="w-4 h-4 text-amber-400" />总待结余额</div>
          <div className="text-xl font-semibold text-slate-100 tabular-nums">
            {fmtDec(totals.balance)}{totals.currency === '混合币种' ? '' : totals.currency ? ` ${totals.currency}` : ''}
          </div>
        </div>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索账户名 / 账户 ID / 配置 / 支付方式"
          className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* 明细表 */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="px-4 py-3 font-medium whitespace-nowrap">账户</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">状态</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">已花费</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">花费 / 上限</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">待结余额</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">支付方式</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">所属配置</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 inline animate-spin mr-2" />加载中...
                </td></tr>
              ) : displayRows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-500">
                  {accounts.length === 0 ? '暂无广告账户 —— 请先在「广告账户」页获取信息' : '没有匹配的记录'}
                </td></tr>
              ) : displayRows.map((a, i) => (
                <tr key={`${a.profile_id}-${a.account_id}-${i}`} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                  <td className="px-4 py-3 max-w-[220px]">
                    <div className="text-slate-200 truncate" title={a.name}>{a.name || '—'}</div>
                    <div className="text-[11px] text-slate-500 truncate">act_{String(a.account_id || '').replace(/^act_/i, '')}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={String(a.status || '')} /></td>
                  <td className="px-4 py-3 text-right font-medium text-emerald-300 tabular-nums whitespace-nowrap">
                    {fmtDec(a.spend)}{a.currency ? ` ${a.currency}` : ''}
                  </td>
                  <td className="px-4 py-3">
                    <UsageBar spend={Number(a.spend) || 0} threshold={Number(a.threshold_amount) || 0} currency={String(a.currency || '')} />
                  </td>
                  <td className="px-4 py-3 text-right text-slate-300 tabular-nums whitespace-nowrap">
                    {fmtDec(a.balance)}{a.currency ? ` ${a.currency}` : ''}
                  </td>
                  <td className="px-4 py-3 text-slate-400 max-w-[180px]">
                    <div className="truncate" title={a.funding_source || ''}>{a.funding_source || '—'}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-400 max-w-[160px]">
                    <div className="truncate" title={a.profile_name || a.profile_id}>{a.profile_name || a.profile_id || '—'}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmtTime(a.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && displayRows.length > 0 && (
          <div className="px-4 py-2 text-xs text-slate-500 border-t border-slate-800">
            共 {displayRows.length} 个账户 · 按花费降序{totals.currency === '混合币种' ? ' · 汇总数据为多币种混合' : ''}
          </div>
        )}
      </div>
    </div>
  );
};
