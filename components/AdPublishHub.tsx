// @ts-nocheck
/**
 * 智能广告发布平台（统一发布台）
 *
 * 布局骨架：PageHeader → Toolbar → Content(表格) → FooterBar   ｜  Aside(发布记录)
 * 设计 token：slate-950 底色 / slate-800 边框 / indigo-600 主操作 / emerald·rose·amber 表状态
 *
 * 平台接入状态：
 *   · Meta   —— 已接入：复用 FacebookAdPublisher 表单 + publish_ads 队列任务
 *   · Google / TikTok / X —— 占位（结构就位，接入时补各自分支）
 *
 * ⚠️ 本组件既跑在主系统里（自动化 → 智能发布平台），也跑在独立入口 /adpublish。
 *    独立入口没有主系统的 AppProvider 数据，所以 profiles 为空时会自己拉一份。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Megaphone, Search, RefreshCw, Loader2, CheckCircle2, XCircle, Ban, Clock,
  PlusCircle, Info, Inbox, History,
} from 'lucide-react';
import { useAppContext } from './AppContext';
import { FacebookAdPublisher } from './FacebookAdPublisher';
import { submitJob, waitForJob, snapshot, subscribe, OP_LABELS } from './jobQueue';

type Platform = 'meta' | 'google' | 'tiktok' | 'x';

const PLATFORMS: Array<{ id: Platform; label: string; ready: boolean; note: string }> = [
  { id: 'meta', label: 'Meta', ready: true, note: 'Facebook / Instagram 广告' },
  { id: 'google', label: 'Google', ready: false, note: '待接入：现有 GoogleAdsPublisher 组件尚未接到本页' },
  { id: 'tiktok', label: 'TikTok', ready: false, note: '待接入：导航「TikTok → 广告发布」里已有独立入口' },
  { id: 'x', label: 'X', ready: false, note: '待接入：目前只有账号注册，还没有广告发布能力' },
];

interface AccRow {
  profileId: string;
  adAccountId: string;
  name?: string;
  currency?: string;
  country?: string;
}

/* ---------- 展示型小组件 ---------- */

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { icon: React.ReactNode; cls: string; text: string }> = {
    done: { icon: <CheckCircle2 className="w-3.5 h-3.5" />, cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', text: '完成' },
    failed: { icon: <XCircle className="w-3.5 h-3.5" />, cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30', text: '失败' },
    cancelled: { icon: <Ban className="w-3.5 h-3.5" />, cls: 'bg-slate-500/10 text-slate-400 border-slate-600/40', text: '已取消' },
    running: { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, cls: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30', text: '进行中' },
  };
  const it = map[status] || { icon: <Clock className="w-3.5 h-3.5" />, cls: 'bg-slate-500/10 text-slate-400 border-slate-600/40', text: '排队中' };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] ${it.cls}`}>
      {it.icon}{it.text}
    </span>
  );
};

const EmptyState: React.FC<{ icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }> = ({ icon, title, hint, action }) => (
  <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
    <div className="w-12 h-12 rounded-2xl bg-slate-800/60 border border-slate-700 flex items-center justify-center text-slate-500 mb-3">
      {icon}
    </div>
    <div className="text-sm text-slate-300">{title}</div>
    {hint && <div className="text-xs text-slate-500 mt-1 max-w-md leading-relaxed">{hint}</div>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const AdPublishHub: React.FC = () => {
  const { profiles } = useAppContext();
  // 独立入口（/adpublish）没有主系统的 profiles → 自己拉一份，仅用于把 profileId 显示成配置名
  const [fetchedProfiles, setFetchedProfiles] = useState<any[]>([]);
  useEffect(() => {
    if ((profiles || []).length > 0) return;
    (async () => {
      try {
        const base = String((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '').replace(/\/$/, '');
        const token = localStorage.getItem('auth_token') || '';
        const r = await fetch(`${base}/api/profiles`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const j = await r.json().catch(() => null);
        const arr = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.profiles) ? j.profiles : (Array.isArray(j) ? j : []));
        setFetchedProfiles(arr);
      } catch { /* 拉不到就只显示配置 ID */ }
    })();
  }, [profiles]);
  const allProfiles = (profiles && profiles.length ? profiles : fetchedProfiles);

  const [platform, setPlatform] = useState<Platform>('meta');
  const [accounts, setAccounts] = useState<AccRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [showPublisher, setShowPublisher] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [, setTick] = useState(0);

  const loadAccounts = () => {
    setLoading(true);
    try {
      const raw = JSON.parse(localStorage.getItem('cache:adaccounts') || '[]');
      const list: AccRow[] = (Array.isArray(raw) ? raw : [])
        .map((a: any) => ({
          profileId: String(a.profileId || a.profile_id || ''),
          adAccountId: String(a.adAccountId || a.account_id || a.id || '').replace(/^act_/, ''),
          name: a.name || a.adAccountName || '',
          currency: a.currency || '',
          country: a.business_country_code || a.country || '',
        }))
        .filter((a: AccRow) => a.profileId && a.adAccountId);
      setAccounts(list);
    } catch {
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
    const unsub = subscribe(() => setTick((t) => t + 1));
    const onFocus = () => loadAccounts();
    window.addEventListener('focus', onFocus);
    return () => { unsub(); window.removeEventListener('focus', onFocus); };
  }, []);

  const profileNameOf = (pid: string) => {
    const p = (allProfiles || []).find((x: any) => String(x.id) === String(pid));
    return (p && (p.name || p.email)) || pid;
  };

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return accounts;
    return accounts.filter((a) =>
      [a.adAccountId, a.name, a.profileId, profileNameOf(a.profileId)]
        .map((v) => String(v || '').toLowerCase())
        .some((v) => v.includes(kw)),
    );
  }, [accounts, keyword, allProfiles]);

  const selectedRows = useMemo(
    () => accounts.filter((a) => selected.has(`${a.profileId}::${a.adAccountId}`)),
    [accounts, selected],
  );
  const selectedProfileIds = useMemo(
    () => Array.from(new Set(selectedRows.map((a) => a.profileId))),
    [selectedRows],
  );

  const toggle = (row: AccRow) => {
    const key = `${row.profileId}::${row.adAccountId}`;
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const allChecked = filtered.length > 0 && filtered.every((a) => selected.has(`${a.profileId}::${a.adAccountId}`));
  const toggleAll = () => {
    setSelected((prev) => {
      if (allChecked) {
        const next = new Set(prev);
        filtered.forEach((a) => next.delete(`${a.profileId}::${a.adAccountId}`));
        return next;
      }
      return new Set([...prev, ...filtered.map((a) => `${a.profileId}::${a.adAccountId}`)]);
    });
  };

  const handleMetaConfirm = async (data: any) => {
    if (selectedRows.length === 0) { setNotice('请先选择要发布的广告号'); return; }
    setBusy(true);
    setNotice('');
    try {
      const mediaBase64 = data?.mediaFile
        ? await new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.readAsDataURL(data.mediaFile);
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = (e) => reject(e);
          })
        : undefined;
      const { mediaFile: _mf, ...rest } = data || {};
      const items = selectedRows.map((a) => ({
        key: `${a.profileId}::${a.adAccountId}`,
        label: a.name || a.adAccountId,
        payload: { profileId: a.profileId, adAccountId: a.adAccountId },
      }));
      const job = await submitJob({
        type: 'publish_ads',
        title: `发布广告（${items.length} 个广告号）`,
        items,
        shared: { ...rest, mediaBase64 },
      });
      setShowPublisher(false);
      setNotice(`已提交 ${items.length} 个广告号到执行队列（${job.id}）。右侧「发布记录」与左侧「执行队列」都能看进度。`);
      void waitForJob(job.id).then((j) => {
        if (j) setNotice(`发布结束：成功 ${j.ok}/${j.total}${j.fail ? `，失败 ${j.fail}（明细见「执行队列」）` : ''}`);
      });
    } catch (e: any) {
      setNotice(`提交失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const jobs = useMemo(
    () => (snapshot().jobs || []).filter((j: any) => j.type === 'publish_ads').slice(0, 20),
    [snapshot().updatedAt],
  );

  const cur = PLATFORMS.find((p) => p.id === platform)!;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* ===== PageHeader ===== */}
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="px-6 py-3 flex items-center gap-3 flex-wrap">
          <div className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
            <Megaphone className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mr-2">
            <h1 className="text-base font-semibold text-white leading-tight">智能广告发布平台</h1>
            <p className="text-[11px] text-slate-500 leading-tight">一个入口发布到多平台 · 执行走本机队列</p>
          </div>

          <div className="flex-1" />

          {/* 平台切换（segmented） */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-800/60 border border-slate-700">
            {PLATFORMS.map((p) => {
              const on = platform === p.id;
              return (
                <button key={p.id} onClick={() => setPlatform(p.id)}
                  className={`relative px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    on ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                  }`}>
                  {p.label}
                  {!p.ready && (
                    <span className={`ml-1.5 text-[9px] px-1 py-0.5 rounded ${on ? 'bg-white/20 text-white' : 'bg-amber-500/15 text-amber-400'}`}>
                      待接入
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {notice && (
        <div className="px-6 pt-4">
          <div className="flex items-start gap-2 text-xs text-slate-300 bg-slate-800/60 border border-slate-700 rounded-xl px-3 py-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-indigo-400" />
            <span className="leading-relaxed">{notice}</span>
          </div>
        </div>
      )}

      <main className="p-6 grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-5 items-start">
        {/* ===== 左：选广告号 ===== */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
          {/* Toolbar */}
          <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索广告号 / 名称 / 配置"
                className="pl-8 pr-3 py-1.5 w-64 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500/60 focus:outline-none" />
            </div>
            <span className="text-xs text-slate-500">
              共 <span className="text-slate-300">{filtered.length}</span> 个广告号
              {keyword && filtered.length !== accounts.length && <span className="text-slate-600">（筛选自 {accounts.length}）</span>}
            </span>
            <div className="flex-1" />
            <button onClick={loadAccounts}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700 text-slate-300 text-xs flex items-center gap-1.5 transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
            </button>
          </div>

          {!cur.ready && (
            <div className="px-4 py-3 border-b border-slate-800 flex items-start gap-2 text-xs text-amber-300/90 bg-amber-500/5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{cur.note}</span>
            </div>
          )}

          {/* Content */}
          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-9 rounded-lg bg-slate-800/40 animate-pulse" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Inbox className="w-5 h-5" />}
              title={accounts.length === 0 ? '本地还没有广告号缓存' : '没有匹配的广告号'}
              hint={accounts.length === 0
                ? '先去「Meta → 广告号」页执行一次「获取信息」，抓回来的广告号会写进本地缓存，这里即可选用。'
                : '换个关键词试试，或点右上角「刷新」重新读取缓存。'}
              action={accounts.length === 0
                ? <button onClick={loadAccounts} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs">重新读取缓存</button>
                : null}
            />
          ) : (
            <div className="max-h-[calc(100vh-330px)] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur text-[10px] uppercase tracking-wider text-slate-500">
                  <tr className="border-b border-slate-800">
                    <th className="px-3 py-2.5 w-9">
                      <input type="checkbox" checked={allChecked} onChange={toggleAll}
                        className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 accent-indigo-600" />
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium">广告号</th>
                    <th className="px-3 py-2.5 text-left font-medium">名称</th>
                    <th className="px-3 py-2.5 text-left font-medium">配置</th>
                    <th className="px-3 py-2.5 text-left font-medium">国家</th>
                    <th className="px-3 py-2.5 text-left font-medium">货币</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {filtered.map((a) => {
                    const key = `${a.profileId}::${a.adAccountId}`;
                    const on = selected.has(key);
                    return (
                      <tr key={key} onClick={() => toggle(a)}
                        className={`cursor-pointer transition-colors ${on ? 'bg-indigo-500/[0.07]' : 'hover:bg-slate-800/40'}`}>
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={on} readOnly
                            className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 accent-indigo-600" />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-400">act_{a.adAccountId}</td>
                        <td className="px-3 py-2 text-slate-200 truncate max-w-[220px]">{a.name || <span className="text-slate-600">—</span>}</td>
                        <td className="px-3 py-2 text-slate-400 truncate max-w-[160px]">{profileNameOf(a.profileId)}</td>
                        <td className="px-3 py-2 text-slate-400">{a.country || <span className="text-slate-600">—</span>}</td>
                        <td className="px-3 py-2 text-slate-400">{a.currency || <span className="text-slate-600">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* FooterBar */}
          <div className="px-4 py-3 border-t border-slate-800 bg-slate-900/60 flex items-center gap-3">
            <div className="text-xs text-slate-500">
              已选 <span className="text-indigo-300 font-medium">{selectedRows.length}</span> 个广告号
              {selectedProfileIds.length > 0 && <span> · 涉及 {selectedProfileIds.length} 个配置</span>}
            </div>
            <div className="flex-1" />
            <button disabled={!cur.ready || busy || selectedRows.length === 0}
              onClick={() => setShowPublisher(true)}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium flex items-center gap-2 transition-colors">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
              创建发布
            </button>
          </div>
        </section>

        {/* ===== 右：发布记录 ===== */}
        <aside className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
            <History className="w-4 h-4 text-slate-400" />
            <span className="text-sm text-slate-200 font-medium">发布记录</span>
            <span className="text-[11px] text-slate-500">最近 20 条</span>
          </div>
          {jobs.length === 0 ? (
            <EmptyState icon={<History className="w-5 h-5" />} title="还没有发布记录"
              hint="在上面选好广告号、点「创建发布」，提交后会实时出现在这里。" />
          ) : (
            <div className="p-3 space-y-2 max-h-[calc(100vh-230px)] overflow-auto">
              {jobs.map((j: any) => {
                const pct = j.total ? Math.round(((j.done || 0) / j.total) * 100) : 0;
                const failedItems = (j.items || []).filter((it: any) => it.status === 'failed');
                return (
                  <div key={j.id} className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={j.status} />
                      <span className="text-xs text-slate-200 truncate flex-1">
                        {j.title || OP_LABELS[j.type] || j.type}
                      </span>
                      <span className="text-[11px] text-slate-500 shrink-0">{j.ok ?? 0}/{j.total ?? 0}</span>
                    </div>

                    {(j.status === 'running' || j.status === 'queued') && (
                      <div className="mt-2 h-1 rounded-full bg-slate-800 overflow-hidden">
                        <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    )}

                    {failedItems.slice(0, 2).map((it: any) => (
                      <div key={it.key} className="mt-1.5 text-[11px] text-rose-400/90 leading-snug line-clamp-2">
                        ✗ {it.label}：{it.message}
                      </div>
                    ))}

                    <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-600 font-mono">
                      <span>{j.id}</span>
                      {j.createdAt ? <span>· {new Date(j.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </main>

      {showPublisher && (
        <FacebookAdPublisher
          profileIds={selectedProfileIds}
          onCancel={() => setShowPublisher(false)}
          onConfirm={handleMetaConfirm}
        />
      )}
    </div>
  );
};

export default AdPublishHub;
