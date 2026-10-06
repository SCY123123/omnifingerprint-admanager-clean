// @ts-nocheck
/**
 * AI 回复队列（导航页）：查看批量/单条 AI 回复任务的实时状态，
 * 可取消单个/全部任务、调整发送间隔、清理已完成记录。
 * 状态来自模块级 aiQueue（与消息对话页共享，切页面不中断执行）。
 */
import React, { useEffect, useState } from 'react';
import { Sparkles, X, Ban, Trash2, PlayCircle, Loader2, CheckCircle2, AlertCircle, Clock, Send, BellRing, Pause, Play } from 'lucide-react';
import { subscribe, snapshot, cancelTask, cancelAll, clearFinished, setDelayMs, getDelayMs } from './aiQueue';
import { subscribe as watchSubscribe, snapshot as watchSnapshot, toggleAll as watchToggleAll, toggle as watchToggle, removeKeys as watchRemoveKeys, setPollSec, setCooldownSec, getPollSec, getCooldownSec, runWatch, snapshotPages as pageWatchSnapshot, removePage as pageWatchRemove } from './aiWatch';

const fmtClock = (t: number) => {
  if (!t) return '-';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getHours()}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const STATUS_META: Record<string, { label: string; cls: string; icon?: any }> = {
  queued: { label: '排队中', cls: 'bg-slate-700/50 text-slate-300', icon: Clock },
  generating: { label: 'AI 生成中', cls: 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40', icon: Loader2 },
  sending: { label: '发送中', cls: 'bg-amber-600/20 text-amber-300 border border-amber-500/40', icon: Send },
  done: { label: '已发送', cls: 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40', icon: CheckCircle2 },
  error: { label: '失败', cls: 'bg-rose-600/20 text-rose-300 border border-rose-500/40', icon: AlertCircle },
  cancelled: { label: '已取消', cls: 'bg-slate-700/40 text-slate-500', icon: X },
};

export default function AutoReplyQueuePage() {
  const [tick, setTick] = useState(0);
  const [delay, setDelay] = useState(Math.round(getDelayMs() / 1000));
  useEffect(() => subscribe(() => setTick(n => n + 1)), []);
  const tasks = snapshot();
  // —— 持续监听状态 ——
  const [wtick, setWTick] = useState(0);
  const [wpoll, setWpoll] = useState(getPollSec());
  const [wcoold, setWcoold] = useState(getCooldownSec());
  const [wbusy, setWbusy] = useState(false);
  useEffect(() => watchSubscribe(() => setWTick(n => n + 1)), []);
  const watchEntries = watchSnapshot();
  const watchPages = pageWatchSnapshot();
  const watchActive = watchEntries.some(e => e.enabled) || watchPages.some(p => p.enabled);
  const doWatchOnce = async () => {
    if (wbusy) return;
    setWbusy(true);
    try { await runWatch(); } catch {}
    setWbusy(false);
  };
  const actives = tasks.filter(t => t.status === 'queued' || t.status === 'generating' || t.status === 'sending').length;
  const runningTask = tasks.find(t => t.status === 'generating' || t.status === 'sending');

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-emerald-400" /> AI 智能回复队列
        </h2>
        <span className="px-2 py-0.5 text-xs rounded-full bg-slate-800 text-slate-400">{tasks.length} 条记录</span>
        {actives > 0 && <span className="px-2 py-0.5 text-xs rounded-full bg-indigo-600/20 text-indigo-300 border border-indigo-500/40">{actives} 条进行中</span>}
        <div className="flex-1" />
        <span className="flex items-center gap-1.5 text-xs text-slate-400">
          发送间隔
          <input type="number" min={1} max={600} value={delay}
            onChange={(e) => { const v = Math.max(1, Number(e.target.value) || 1); setDelay(v); setDelayMs(v * 1000); }}
            className="w-16 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500" />
          秒
        </span>
        <button onClick={() => { clearFinished(); }}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-800">
          <Trash2 className="w-3.5 h-3.5" /> 清理已完成
        </button>
        <button onClick={() => cancelAll()}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-600/20 border border-rose-500/40 text-rose-300 text-xs hover:bg-rose-600/30 disabled:opacity-50">
          <Ban className="w-3.5 h-3.5" /> 取消全部
        </button>
      </div>

      {/* —— 批量 AI 持续监听 —— */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.03] overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-amber-500/20 bg-amber-500/10">
          <span className="inline-flex items-center gap-1.5 text-amber-200 font-medium text-sm">
            <BellRing className="w-4 h-4" /> 批量 AI 持续监听（自动值守）
          </span>
          <span className="text-xs text-amber-200/70">{watchEntries.filter(e => e.enabled).length} 个对话监听中</span>
          <div className="flex-1" />
          <span className="flex items-center gap-1 text-xs text-amber-200/80">
            轮询
            <input type="number" min={10} max={3600} value={wpoll}
              onChange={(e) => { const v = Math.max(10, Number(e.target.value) || 60); setWpoll(v); }}
              onBlur={() => setPollSec(wpoll)}
              onKeyDown={(e) => { if (e.key === 'Enter') setPollSec(wpoll); }}
              className="w-16 bg-slate-900 border border-amber-500/30 rounded px-1.5 py-0.5 text-xs text-amber-100 focus:outline-none focus:border-amber-400" />
            秒
          </span>
          <span className="flex items-center gap-1 text-xs text-amber-200/80">
            冷却
            <input type="number" min={10} max={86400} value={wcoold}
              onChange={(e) => { const v = Math.max(10, Number(e.target.value) || 120); setWcoold(v); }}
              onBlur={() => setCooldownSec(wcoold)}
              onKeyDown={(e) => { if (e.key === 'Enter') setCooldownSec(wcoold); }}
              className="w-16 bg-slate-900 border border-amber-500/30 rounded px-1.5 py-0.5 text-xs text-amber-100 focus:outline-none focus:border-amber-400" />
            秒
          </span>
          <button onClick={doWatchOnce}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-200 text-xs hover:bg-amber-500/30 disabled:opacity-50">
            {wbusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} 立即检查一次
          </button>
          <button onClick={() => watchToggleAll(!watchActive)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-600 text-slate-300 text-xs hover:bg-slate-800">
            {watchActive ? <Pause className="w-3.5 h-3.5" /> : <PlayCircle className="w-3.5 h-3.5" />}
            {watchActive ? '暂停全部' : '恢复全部'}
          </button>
        </div>
        {/* —— 主页级全自动值守（在「主页」列表点“监听主页”开启）—— */}
        {watchPages.length > 0 && (
          <div className="px-4 py-2 border-b border-amber-500/10">
            <div className="text-[11px] text-amber-200/60 mb-1.5">
              主页值守：开启后该主页当前+新出现的所有对话都会自动纳入监听，检测到客户新消息即按提示词 AI 自动回复
            </div>
            <div className="flex flex-wrap gap-2">
              {watchPages.map(p => (
                <span key={p.key} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/40 text-sm text-emerald-200">
                  <span className={`w-2 h-2 rounded-full ${p.enabled ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
                  <span className="max-w-[180px] truncate" title={p.pageName}>{p.pageName || p.pageId}</span>
                  <span className="text-[11px] text-emerald-200/60">#{p.profileId}·{p.pageId}</span>
                  {!p.enabled && <span className="text-[11px] text-slate-400">已暂停</span>}
                  <button onClick={() => pageWatchRemove(p.profileId, p.pageId)}
                    className="px-2 py-0.5 rounded-md text-xs border border-rose-500/30 text-rose-300 hover:bg-rose-600/20">
                    停止值守
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        {watchEntries.length === 0 ? (
          <div className="px-4 py-5 text-center text-slate-500 text-sm">
            暂无监听任务。回到「消息对话」页勾选若干对话 → 点 <b className="text-amber-300">批量持续监听</b>：
            系统会定时拉取这些对话所属主页的新消息，检测到对方新回复后按「提示词设置」自动 AI 回复（含冷却防回环）。
          </div>
        ) : (
          watchEntries.map(e => (
            <div key={e.key} className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-amber-500/10 text-sm">
              <span className={`w-2 h-2 rounded-full ${e.enabled ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
              <span className="text-slate-200 max-w-[200px] truncate" title={`${e.pageName || ''} / ${e.peerName || e.key}`}>
                {e.peerName || '对话'} {e.pageName ? <span className="text-slate-500 text-xs">· {e.pageName}</span> : null}
              </span>
              <span className="text-[11px] text-slate-400">
                {e.enabled ? '自动值守' : '已暂停'}
                {!e.hasBaseline && ' · 首次基线'}
              </span>
              <span className="text-[11px] text-slate-500">上次检查 {fmtClock(e.lastCheckTs)}</span>
              {e.lastPeerText && <span className="text-[11px] text-emerald-300/70 max-w-[180px] truncate" title={e.lastPeerText}>对方最新：{e.lastPeerText}</span>}
              {e.lastAutoTs > 0 && <span className="text-[11px] text-indigo-300/70">上次自动回复 {fmtClock(e.lastAutoTs)}</span>}
              {e.lastError && <span className="text-[11px] text-rose-300/80" title={e.lastError}>{e.lastError}</span>}
              <span className="ml-auto flex items-center gap-1.5">
                <button onClick={() => watchToggle(e.key, !e.enabled)}
                  className="px-2 py-0.5 rounded-md text-xs border border-slate-700 text-slate-300 hover:bg-slate-800">
                  {e.enabled ? '暂停' : '恢复'}
                </button>
                <button onClick={() => watchRemoveKeys([e.key])}
                  className="px-2 py-0.5 rounded-md text-xs border border-rose-500/30 text-rose-300 hover:bg-rose-600/20">
                  移除
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {runningTask && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-500/40 bg-indigo-600/10 text-indigo-200 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> 正在执行：{runningTask.peer}
          <span className="text-xs text-indigo-300/70">（发送间隔 {delay} 秒 / 可在本页随时取消）</span>
        </div>
      )}

      {tasks.length === 0 && (
        <div className="text-slate-500 text-sm text-center py-16">
          队列为空。回到「消息对话」页，对某个对话点 <b className="text-emerald-400">AI 回复</b> 或勾选多个对话后点
          <b className="text-indigo-400"> 批量 AI 回复</b>，即可在这里查看进度与取消。
        </div>
      )}

      {tasks.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
                <th className="px-4 py-2.5">对话对象</th>
                <th className="px-4 py-2.5">状态</th>
                <th className="px-4 py-2.5">回复内容（预览）</th>
                <th className="px-4 py-2.5">入队时间</th>
                <th className="px-4 py-2.5">完成时间</th>
                <th className="px-4 py-2.5">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map(t => {
                const meta = STATUS_META[t.status] || STATUS_META.queued;
                const Icon = meta.icon || Clock;
                const canCancel = t.status === 'queued' || t.status === 'generating' || t.status === 'sending';
                return (
                  <tr key={t.uid} className="border-b border-slate-800/60 hover:bg-slate-800/40">
                    <td className="px-4 py-2.5 text-slate-200 max-w-[220px] truncate" title={t.peer}>{t.peer}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs ${meta.cls}`}>
                        <Icon className={`w-3 h-3 ${t.status === 'generating' || t.status === 'sending' ? 'animate-spin' : ''}`} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 max-w-[300px]">
                      {t.status === 'done' && t.reply && <div className="text-emerald-200/90 line-clamp-2">{t.reply}</div>}
                      {t.status === 'error' && <div className="text-rose-300/90 line-clamp-2" title={t.error}>{t.error}</div>}
                      {t.status === 'generating' && <div className="text-slate-400 animate-pulse">正在按提示词生成回复…</div>}
                      {t.status === 'sending' && <div className="text-amber-200/90 line-clamp-2">{t.reply}</div>}
                      {t.status === 'cancelled' && <div className="text-slate-500">已取消</div>}
                      {t.status === 'queued' && <div className="text-slate-500">等待执行…</div>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap text-xs">{fmtClock(t.createdAt)}</td>
                    <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap text-xs">{fmtClock(t.finishedAt)}</td>
                    <td className="px-4 py-2.5">
                      {canCancel && (
                        <button onClick={() => cancelTask(t.uid)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-rose-500/40 text-rose-300 hover:bg-rose-600/20">
                          <X className="w-3 h-3" /> 取消
                        </button>
                      )}
                      {!canCancel && <span className="text-xs text-slate-600">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
