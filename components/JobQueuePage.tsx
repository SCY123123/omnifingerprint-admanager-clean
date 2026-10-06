/**
 * 执行队列（导航页）
 *
 * 展示本机后端任务队列里的所有批量任务：进度、成功/失败、逐项明细。
 * 支持单独取消、一键取消全部、清理已结束记录、调整队列并发。
 *
 * ⚠️ 任务是由后端执行的：本页只是「查看器」，关掉页面/刷新浏览器都不会中断任务。
 */
import React, { useEffect, useState } from 'react';
import { ListChecks, X, Ban, Trash2, Loader2, CheckCircle2, AlertCircle, Clock, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { subscribe, snapshot, cancelJob, cancelAll, clearFinished, refresh, setQueueConcurrency, OP_LABELS, type Job, type JobItem } from './jobQueue';

const fmtClock = (t?: number | null) => {
  if (!t) return '-';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getHours()}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const fmtDuration = (a?: number | null, b?: number | null) => {
  if (!a) return '-';
  const end = b || Date.now();
  const s = Math.max(0, Math.round((end - a) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
};

const JOB_STATUS: Record<string, { label: string; cls: string; icon: any }> = {
  queued: { label: '排队中', cls: 'bg-slate-700/50 text-slate-300', icon: Clock },
  running: { label: '执行中', cls: 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40', icon: Loader2 },
  done: { label: '已完成', cls: 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40', icon: CheckCircle2 },
  failed: { label: '有失败', cls: 'bg-rose-600/20 text-rose-300 border border-rose-500/40', icon: AlertCircle },
  cancelled: { label: '已取消', cls: 'bg-slate-700/40 text-slate-500', icon: X },
};

const ITEM_STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: '排队', cls: 'text-slate-400' },
  running: { label: '执行中', cls: 'text-indigo-300' },
  done: { label: '成功', cls: 'text-emerald-300' },
  failed: { label: '失败', cls: 'text-rose-300' },
  cancelled: { label: '已取消', cls: 'text-slate-500' },
};

const isActive = (j: Job) => j.status === 'queued' || j.status === 'running';

export default function JobQueuePage() {
  const [, setTick] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [conc, setConc] = useState<number>(2);
  const [busy, setBusy] = useState(false);

  useEffect(() => subscribe(() => setTick((n) => n + 1)), []);
  const state = snapshot();
  const jobs = state.jobs;
  useEffect(() => { setConc(state.concurrency || 2); }, [state.concurrency]);

  const activeCount = jobs.filter(isActive).length;
  const report = (m: string) => { try { window.alert(m); } catch { } };

  const applyConc = async (v: number) => {
    const n = Math.max(1, Math.min(10, Number(v) || 2));
    setConc(n);
    try { await setQueueConcurrency(n); } catch (e: any) { report('设置并发失败：' + (e?.message || e)); }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <ListChecks className="w-5 h-5 text-indigo-400" /> 执行队列
        </h2>
        <span className="px-2 py-0.5 text-xs rounded-full bg-slate-800 text-slate-400">{jobs.length} 条记录</span>
        {activeCount > 0 && <span className="px-2 py-0.5 text-xs rounded-full bg-indigo-600/20 text-indigo-300 border border-indigo-500/40">{activeCount} 条进行中</span>}
        <div className="flex-1" />
        <span className="flex items-center gap-1.5 text-xs text-slate-400" title="全局并发：所有任务合起来同时在跑的操作数上限，多出来的排队等待">
          全局并发
          <input type="number" min={1} max={10} value={conc}
            onChange={(e) => applyConc(Number(e.target.value))}
            className="w-14 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500" />
        </span>
        <button onClick={() => { void refresh(); }}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-800">
          <RefreshCw className="w-3.5 h-3.5" /> 刷新
        </button>
        <button disabled={busy || activeCount === 0}
          onClick={async () => {
            if (!window.confirm(`确定取消全部 ${activeCount} 个进行中的任务？`)) return;
            setBusy(true);
            try { await cancelAll(); } catch (e: any) { report('取消失败：' + (e?.message || e)); }
            setBusy(false);
          }}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-rose-700/60 text-rose-300 text-xs hover:bg-rose-900/20 disabled:opacity-40">
          <Ban className="w-3.5 h-3.5" /> 全部取消
        </button>
        <button onClick={async () => { try { await clearFinished(); } catch { } }}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-800">
          <Trash2 className="w-3.5 h-3.5" /> 清理已完成
        </button>
      </div>

      <p className="text-xs text-slate-500">
        任务由本机后端执行并落盘：刷新页面、切换菜单、甚至重启后端都不会中断；未完成的任务会在后端启动后自动续跑。
      </p>

      {jobs.length === 0 && (
        <div className="text-sm text-slate-500 border border-dashed border-slate-800 rounded-xl p-8 text-center">
          暂无任务。批量获取信息、创建 BM/主页、发布广告、批量启停浏览器等操作会自动进入这里排队执行。
        </div>
      )}

      <div className="space-y-3">
        {jobs.map((job) => {
          const meta = JOB_STATUS[job.status] || JOB_STATUS.queued;
          const Icon = meta.icon;
          const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
          const open = !!expanded[job.id];
          return (
            <div key={job.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="p-3 flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${meta.cls}`}>
                  <Icon className={`w-3 h-3 ${job.status === 'running' ? 'animate-spin' : ''}`} /> {meta.label}
                </span>
                <span className="text-sm text-slate-200 font-medium">{job.title || OP_LABELS[job.type] || job.type}</span>
                <span className="px-2 py-0.5 text-[11px] rounded bg-slate-800 text-slate-400">{OP_LABELS[job.type] || job.type}</span>
                <span className="text-xs text-slate-400">
                  {job.done}/{job.total}
                  {job.ok > 0 && <span className="text-emerald-400"> · 成功 {job.ok}</span>}
                  {job.fail > 0 && <span className="text-rose-400"> · 失败 {job.fail}</span>}
                </span>
                <span className="text-xs text-slate-500">开始 {fmtClock(job.startedAt || job.createdAt)} · 耗时 {fmtDuration(job.startedAt, job.finishedAt)}</span>
                <div className="flex-1" />
                <button onClick={() => setExpanded((p) => ({ ...p, [job.id]: !p[job.id] }))}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-700 text-slate-400 text-xs hover:bg-slate-800">
                  {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} 明细
                </button>
                {isActive(job) && (
                  <button onClick={async () => { try { await cancelJob(job.id); } catch (e: any) { report('取消失败：' + (e?.message || e)); } }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-700/60 text-rose-300 text-xs hover:bg-rose-900/20">
                    <Ban className="w-3.5 h-3.5" /> 取消
                  </button>
                )}
              </div>

              <div className="px-3 pb-3">
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div className={`h-full ${job.status === 'failed' ? 'bg-rose-500' : job.status === 'cancelled' ? 'bg-slate-600' : 'bg-indigo-500'}`}
                    style={{ width: `${pct}%` }} />
                </div>
              </div>

              {job.error && <div className="px-3 pb-3 text-xs text-rose-300">任务错误：{job.error}</div>}

              {open && (
                <div className="border-t border-slate-800 max-h-80 overflow-y-auto">
                  {job.items.map((it: JobItem, idx: number) => {
                    const s = ITEM_STATUS[it.status] || ITEM_STATUS.queued;
                    return (
                      <div key={`${it.key}_${idx}`} className="px-3 py-2 flex items-start gap-2 text-xs border-b border-slate-800/60 last:border-b-0">
                        <span className={`w-12 shrink-0 ${s.cls}`}>{s.label}</span>
                        <span className="text-slate-300 shrink-0">{it.label || it.key}</span>
                        <span className="text-slate-500 break-all">{it.message}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
