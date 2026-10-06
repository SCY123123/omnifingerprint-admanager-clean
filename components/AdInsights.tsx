/**
 * 数据追踪（Meta 广告数据 insights，广告层级）
 *
 * 数据存云端 ad_insights 表：本地后端借用浏览器抓 Graph API 后 bulk-save 推上来
 * （唯一键 profile_id + ad_id + date_preset，重复刷新覆盖更新）。
 * 本页职责：选时间段 + 账户范围 → 汇总卡 + 明细表；「同步广告数据」提交本机队列
 * （fetch_insights，按配置分组借用浏览器，任务在队列页可见、刷新页面不中断）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, RefreshCw, Loader2, Search, AlertCircle,
  DollarSign, Eye, BarChartHorizontal, Target, Coins,
} from 'lucide-react';
import { submitJob, waitForJob, Job } from './jobQueue';

/* ---------- 类型 ---------- */

interface InsightsRow {
  id: number;
  profileId: string;
  accountId: string;
  adId: string;
  adName: string;
  adsetName: string;
  campaignName: string;
  dateStart: string;
  dateStop: string;
  datePreset: string;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  spend: number;
  results: number;
  accountName: string;
  currency: string;
  profileName: string;
  updatedAt: string;
}

/** 云端 /api/adaccounts 返回的原始行（snake_case） */
interface AdAccountRow {
  account_id: string;
  name: string;
  currency: string;
  spend: number;
  status: string;
  profile_id: string;
  profile_name: string;
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

const PRESETS: Array<{ v: string; label: string }> = [
  { v: 'today', label: '今天' },
  { v: 'yesterday', label: '昨天' },
  { v: 'this_week', label: '本周' },
  { v: 'last_7d', label: '近 7 天' },
  { v: 'last_14d', label: '近 14 天' },
  { v: 'last_30d', label: '近 30 天' },
  { v: 'this_month', label: '本月' },
  { v: 'last_month', label: '上月' },
  { v: 'this_quarter', label: '本季度' },
  { v: 'lifetime', label: '累计' },
];

const fmtInt = (n: number) => new Intl.NumberFormat('zh-CN').format(Math.round(Number(n) || 0));
const fmtDec = (n: number, d = 2) => (Number(n) || 0).toFixed(d);

const StatCard: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string }> = ({ icon, label, value, sub, accent }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
    <div className="flex items-center gap-2 text-slate-400 text-xs mb-2">
      <span className={accent || 'text-slate-400'}>{icon}</span>
      {label}
    </div>
    <div className="text-xl font-semibold text-slate-100 tabular-nums">{value}</div>
    {sub && <div className="text-[11px] text-slate-500 mt-1">{sub}</div>}
  </div>
);

/* ---------- 页面 ---------- */

export const AdInsights: React.FC = () => {
  const [accounts, setAccounts] = useState<AdAccountRow[]>([]);
  const [preset, setPreset] = useState('last_7d');
  const [accountFilter, setAccountFilter] = useState('');
  const [rows, setRows] = useState<InsightsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const j = await authedFetch('/adaccounts');
      if (mounted.current) setAccounts(Array.isArray(j.data) ? j.data : []);
    } catch (e: any) {
      if (mounted.current) setError(String(e.message || e));
    }
  }, []);

  const loadInsights = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ preset });
      if (accountFilter) qs.set('accounts', accountFilter);
      const j = await authedFetch(`/insights?${qs.toString()}`);
      if (mounted.current) setRows(Array.isArray(j.data) ? j.data : []);
    } catch (e: any) {
      if (mounted.current) { setError(String(e.message || e)); setRows([]); }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [preset, accountFilter]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadInsights(); }, [loadInsights]);

  /** 提交「同步广告数据」队列任务：按配置分组，同一配置共用一次浏览器会话 */
  const syncData = async () => {
    if (syncing) return;
    setError('');
    const scope = accountFilter ? accounts.filter(a => String(a.account_id) === accountFilter) : accounts;
    if (!scope.length) { setError('暂无广告账户，请先在「广告账户」页获取信息'); return; }
    const byProfile = new Map<string, { label: string; ids: string[] }>();
    scope.forEach(a => {
      const pid = String(a.profile_id || '');
      if (!pid) return;
      if (!byProfile.has(pid)) byProfile.set(pid, { label: String(a.profile_name || pid), ids: [] });
      byProfile.get(pid)!.ids.push(String(a.account_id).replace(/^act_/i, ''));
    });
    const items = [...byProfile.entries()].map(([pid, g]) => ({
      key: pid,
      label: g.label,
      payload: { profileId: pid, adAccountIds: g.ids, datePreset: preset },
    }));
    if (!items.length) { setError('广告账户缺少所属配置信息，无法同步'); return; }
    setSyncing(true); setSyncMsg('提交中...'); setJob(null);
    try {
      const presetLabel = PRESETS.find(p => p.v === preset)?.label || preset;
      const j = await submitJob({
        type: 'fetch_insights',
        title: `同步广告数据（${presetLabel}）`,
        items,
        concurrency: 2,
      });
      setJob(j);
      setSyncMsg(`0/${items.length}`);
      const done = await waitForJob(j.id, (cur) => {
        if (cur) setSyncMsg(`${cur.done}/${cur.total}`);
      });
      setSyncMsg(done && done.status === 'done' ? '同步完成' : '同步未完成');
      await loadInsights();
    } catch (e: any) {
      setError(String(e.message || e));
      setSyncMsg('');
    } finally {
      if (mounted.current) setSyncing(false);
    }
  };

  const displayRows = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(r => [r.adName, r.adsetName, r.campaignName, r.accountName, r.accountId, r.adId, r.profileName]
      .some(v => String(v || '').toLowerCase().includes(kw)));
  }, [rows, search]);

  const totals = useMemo(() => {
    const spend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0);
    const imp = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
    const clicks = rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
    const results = rows.reduce((s, r) => s + (Number(r.results) || 0), 0);
    const curs = [...new Set(rows.map(r => String(r.currency || '').trim()).filter(Boolean))];
    return {
      spend, imp, clicks, results,
      ctr: imp > 0 ? (clicks / imp) * 100 : 0,
      currency: curs.length === 1 ? curs[0] : curs.length > 1 ? '混合币种' : '',
    };
  }, [rows]);

  const presetLabel = PRESETS.find(p => p.v === preset)?.label || preset;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">
      {/* 头部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
            <Activity className="w-5 h-5 text-indigo-400" />数据追踪
          </h2>
          <p className="text-xs text-slate-500 mt-1">Meta 广告层级数据（展示 / 点击 / 花费 / 转化），按时间段存储，切换时间段后需重新同步</p>
        </div>
        <div className="flex items-center gap-2">
          {syncing && (
            <span className="text-xs text-indigo-300 bg-indigo-500/10 border border-indigo-500/30 rounded-md px-2 py-1">
              <Loader2 className="w-3 h-3 inline animate-spin mr-1" />同步中 {syncMsg}
            </span>
          )}
          {!syncing && syncMsg === '同步完成' && (
            <span className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-2 py-1">{syncMsg}</span>
          )}
          <button
            onClick={loadInsights}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="刷新列表"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={syncData}
            disabled={syncing || loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            同步广告数据
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {/* 控制条 */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
        >
          {PRESETS.map(p => <option key={p.v} value={p.v}>{p.label}</option>)}
        </select>
        <select
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 max-w-xs focus:outline-none focus:border-indigo-500"
        >
          <option value="">全部账户（{accounts.length}）</option>
          {accounts.map(a => (
            <option key={`${a.profile_id}-${a.account_id}`} value={String(a.account_id)}>
              {a.name || a.account_id}（{a.profile_name || a.profile_id}）
            </option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索广告 / 广告组 / 系列 / 账户"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* 汇总卡 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard icon={<DollarSign className="w-4 h-4" />} label="总花费" accent="text-emerald-400"
          value={`${fmtDec(totals.spend)}${totals.currency === '混合币种' ? '' : totals.currency ? ' ' + totals.currency : ''}`}
          sub={totals.currency === '混合币种' ? '账户币种不一致，仅供参考' : `${rows.length} 条广告`} />
        <StatCard icon={<Eye className="w-4 h-4" />} label="展示" accent="text-sky-400" value={fmtInt(totals.imp)} />
        <StatCard icon={<BarChartHorizontal className="w-4 h-4" />} label="点击" accent="text-indigo-400" value={fmtInt(totals.clicks)} />
        <StatCard icon={<Target className="w-4 h-4" />} label="平均 CTR" accent="text-amber-400" value={`${fmtDec(totals.ctr)}%`} />
        <StatCard icon={<Coins className="w-4 h-4" />} label="转化" accent="text-fuchsia-400" value={fmtDec(totals.results)} />
      </div>

      {/* 明细表 */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="px-4 py-3 font-medium whitespace-nowrap">广告</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">广告组</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">系列</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">账户</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">展示</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">点击</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">CTR</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">CPC</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">CPM</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">花费</th>
                <th className="px-4 py-3 font-medium text-right whitespace-nowrap">转化</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 inline animate-spin mr-2" />加载中...
                </td></tr>
              ) : displayRows.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-slate-500">
                  {rows.length === 0
                    ? `「${presetLabel}」暂无数据 —— 点击右上角「同步广告数据」拉取`
                    : '没有匹配的记录'}
                </td></tr>
              ) : displayRows.map(r => (
                <tr key={r.id} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                  <td className="px-4 py-3 max-w-[220px]">
                    <div className="text-slate-200 truncate" title={r.adName}>{r.adName || r.adId}</div>
                    <div className="text-[11px] text-slate-500 truncate" title={`${r.dateStart || ''} ~ ${r.dateStop || ''}`}>
                      {r.dateStart && r.dateStop ? `${r.dateStart} ~ ${r.dateStop}` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-400 max-w-[180px] truncate" title={r.adsetName}>{r.adsetName || '—'}</td>
                  <td className="px-4 py-3 text-slate-400 max-w-[180px] truncate" title={r.campaignName}>{r.campaignName || '—'}</td>
                  <td className="px-4 py-3 max-w-[160px]">
                    <div className="text-slate-300 truncate" title={r.accountName}>{r.accountName || r.accountId}</div>
                    <div className="text-[11px] text-slate-500 truncate" title={r.profileName}>{r.profileName || r.profileId}</div>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-300 tabular-nums">{fmtInt(r.impressions)}</td>
                  <td className="px-4 py-3 text-right text-slate-300 tabular-nums">{fmtInt(r.clicks)}</td>
                  <td className="px-4 py-3 text-right text-slate-300 tabular-nums">{fmtDec(r.ctr)}%</td>
                  <td className="px-4 py-3 text-right text-slate-300 tabular-nums">{fmtDec(r.cpc)}{r.currency ? ` ${r.currency}` : ''}</td>
                  <td className="px-4 py-3 text-right text-slate-300 tabular-nums">{fmtDec(r.cpm)}{r.currency ? ` ${r.currency}` : ''}</td>
                  <td className="px-4 py-3 text-right font-medium text-emerald-300 tabular-nums">{fmtDec(r.spend)}{r.currency ? ` ${r.currency}` : ''}</td>
                  <td className="px-4 py-3 text-right text-slate-300 tabular-nums">{r.results ? fmtDec(r.results) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && displayRows.length > 0 && (
          <div className="px-4 py-2 text-xs text-slate-500 border-t border-slate-800">
            共 {displayRows.length} 条（{presetLabel}）{totals.currency === '混合币种' ? ' · 汇总数据为多币种混合' : ''}
          </div>
        )}
      </div>
    </div>
  );
};
