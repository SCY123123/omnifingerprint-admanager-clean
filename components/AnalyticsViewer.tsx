import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface EventItem {
  id: string
  seq?: number
  event_name: string
  from_tab: string
  to_tab: string
  user_agent: string
  locale: string
  ip: string
  extra: any
  created_at: string
}

export const AnalyticsViewer: React.FC = () => {
  const { t } = useTranslation()
  const [items, setItems] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState<Set<string>>(new Set())

  const loadBlacklist = async () => {
    try {
      const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/'
      const base = String(serverUrl || '').replace(/\/$/, '')
      const r = await fetch(`${base}/api/analytics/blacklist`)
      const json = await r.json()
      const list = Array.isArray(json?.data) ? json.data : []
      setBlocked(new Set(list.map((x: any) => String(x.ip || ''))))
    } catch {}
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/'
      const base = String(serverUrl || '').replace(/\/$/, '')
      const r = await fetch(`${base}/api/analytics/events?limit=200`)
      if (!r.ok) throw new Error(String(r.status))
      const json = await r.json()
      const data = Array.isArray(json?.data) ? json.data : []
      setItems(data)
    } catch (e: any) {
      setError(String(e?.message || e || 'error'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(); loadBlacklist(); }, [])

  const doBlock = async (ip: string) => {
    try {
      const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/'
      const base = String(serverUrl || '').replace(/\/$/, '')
      await fetch(`${base}/api/analytics/blacklist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) })
      await loadBlacklist()
    } catch {}
  }

  const doUnblock = async (ip: string) => {
    try {
      const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/'
      const base = String(serverUrl || '').replace(/\/$/, '')
      await fetch(`${base}/api/analytics/blacklist/${encodeURIComponent(ip)}`, { method: 'DELETE' })
      await loadBlacklist()
    } catch {}
  }

  const ipCounts = (() => {
    const m = new Map<string, number>()
    items.forEach(it => {
      const k = String(it.ip || '')
      if (!k) return
      m.set(k, (m.get(k) || 0) + 1)
    })
    return Array.from(m.entries()).sort((a,b)=> b[1]-a[1]).slice(0,10)
  })()

  const pageCounts = (() => {
    const m = new Map<string, number>()
    items.forEach(it => {
      const k = String(it.to_tab || '')
      if (!k) return
      m.set(k, (m.get(k) || 0) + 1)
    })
    return Array.from(m.entries()).sort((a,b)=> b[1]-a[1]).slice(0,10)
  })()

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-slate-200 font-medium">{t('analytics.title', { defaultValue: '导航追踪' })}</div>
          <button onClick={load} className="px-3 py-2 rounded bg-indigo-600 text-white text-sm">{t('common.refresh', { defaultValue: '刷新' })}</button>
        </div>
        {!loading && !error && items.length === 0 && (
          <div className="text-slate-400 text-sm">{t('analytics.empty', { defaultValue: '暂无数据' })}</div>
        )}
        {error && (
          <div className="text-red-500 text-sm">{t('analytics.error', { defaultValue: '加载失败' })}: {error}</div>
        )}
        {loading && (
          <div className="text-slate-400 text-sm">{t('common.loading', { defaultValue: '加载中...' })}</div>
        )}
        {!loading && items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="bg-slate-950 text-slate-400 font-medium uppercase tracking-wider">
                <tr>
                  <th className="px-6 py-4">{t('analytics.table.seq', { defaultValue: 'ID' })}</th>
                  <th className="px-6 py-4">{t('analytics.table.time', { defaultValue: '时间' })}</th>
                  <th className="px-6 py-4">{t('analytics.table.event', { defaultValue: '事件' })}</th>
                  <th className="px-6 py-4">{t('analytics.table.from', { defaultValue: '来源' })}</th>
                  <th className="px-6 py-4">{t('analytics.table.to', { defaultValue: '目标' })}</th>
                  <th className="px-6 py-4">{t('analytics.table.locale', { defaultValue: '语言' })}</th>
                  <th className="px-6 py-4">IP</th>
                  <th className="px-6 py-4">UA</th>
                  <th className="px-6 py-4">{t('analytics.ops.title', { defaultValue: '操作' })}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {items.map(it => (
                  <tr key={it.id} className="hover:bg-slate-800/30">
                    <td className="px-6 py-3 text-slate-300">{String(it.id || '')}</td>
                    <td className="px-6 py-3 text-slate-300">{it.created_at}</td>
                    <td className="px-6 py-3 text-slate-300">{it.event_name}</td>
                    <td className="px-6 py-3 text-slate-300">{it.from_tab}</td>
                    <td className="px-6 py-3 text-slate-300">{it.to_tab}</td>
                    <td className="px-6 py-3 text-slate-300">{it.locale}</td>
                    <td className="px-6 py-3 text-slate-300">{it.ip}</td>
                    <td className="px-6 py-3 text-slate-400 break-all">{it.user_agent}</td>
                    <td className="px-6 py-3 text-slate-300">
                      {!blocked.has(String(it.ip || '')) ? (
                        <button onClick={()=>doBlock(String(it.ip || ''))} className="px-2 py-1 rounded bg-red-600 text-white text-xs">{t('analytics.ops.block', { defaultValue: '拉黑' })}</button>
                      ) : (
                        <button onClick={()=>doUnblock(String(it.ip || ''))} className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-xs">{t('analytics.ops.unblock', { defaultValue: '取消拉黑' })}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && ipCounts.length > 0 && (
          <div className="mt-6">
          <div className="text-slate-200 font-medium mb-2">{t('analytics.stats.title', { defaultValue: 'IP 访问次数 Top10' })}</div>
          <div className="rounded border border-slate-800 bg-slate-950 p-4 grid md:grid-cols-2 gap-3">
            {ipCounts.map(([ip, cnt]) => (
              <div key={ip} className="flex items-center justify-between text-sm">
                <span className="text-slate-300">{ip}</span>
                <span className="px-2 py-1 rounded bg-slate-800 text-slate-200">{cnt}</span>
              </div>
            ))}
          </div>
          </div>
        )}
        {!loading && ipCounts.length === 0 && pageCounts.length > 0 && (
          <div className="mt-6">
            <div className="text-slate-200 font-medium mb-2">{t('analytics.stats.pages', { defaultValue: '页面访问次数 Top10' })}</div>
            <div className="rounded border border-slate-800 bg-slate-950 p-4 grid md:grid-cols-2 gap-3">
              {pageCounts.map(([page, cnt]) => (
                <div key={page} className="flex items-center justify-between text-sm">
                  <span className="text-slate-300">{page}</span>
                  <span className="px-2 py-1 rounded bg-slate-800 text-slate-200">{cnt}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
