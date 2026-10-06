import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface DomainItem {
  id: string
  domain?: string
  status?: string
  group?: string
}

export const DomainManager: React.FC = () => {
  const { t } = useTranslation()
  const [apiUrlInput, setApiUrlInput] = useState<string>('')
  const [apiUrl, setApiUrl] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [items, setItems] = useState<DomainItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [groupInput, setGroupInput] = useState<string>('')

  useEffect(() => {
    const envUrl = (import.meta as any).env?.VITE_DOMAIN_API_URL || ''
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('domain_api_url') || '' : ''
    const initial = saved || envUrl
    setApiUrlInput(initial)
    setApiUrl(initial)
  }, [])

  const fetchList = async (base: string) => {
    if (!base) return
    const b = base.replace(/\/$/, '')
    const controller = new AbortController()
    setLoading(true)
    setError('')
    try {
      const tryEndpoints = [`${b}/api/domains`, `${b}/domains`]
      let data: any = null
      for (const url of tryEndpoints) {
        try {
          const r = await fetch(url, { signal: controller.signal })
          if (!r.ok) continue
          const j = await r.json()
          data = j
          break
        } catch {}
      }
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
      const mapped: DomainItem[] = list.map((it: any, idx: number) => ({
        id: String(it.id ?? it.domainId ?? `${Date.now()}_${idx}`),
        domain: String(it.domain ?? it.name ?? ''),
        status: String(it.status ?? ''),
        group: String(it.group ?? '')
      }))
      setItems(mapped)
    } catch (e: any) {
      setError(t('domainManager.fetchError'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (apiUrl) fetchList(apiUrl)
  }, [apiUrl])

  const allChecked = useMemo(() => items.length > 0 && selected.size === items.length, [items, selected])

  const toggleAll = () => {
    if (allChecked) setSelected(new Set())
    else setSelected(new Set(items.map(i => i.id)))
  }

  const toggleOne = (id: string) => {
    setSelected(prev => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }

  const assignGroupLocal = (group: string) => {
    if (!group) return
    setItems(prev => prev.map(i => (selected.has(i.id) ? { ...i, group } : i)))
  }

  const saveApiUrl = () => {
    const v = apiUrlInput.trim()
    setApiUrl(v)
    if (typeof localStorage !== 'undefined') localStorage.setItem('domain_api_url', v)
  }

  const saveGrouping = async () => {
    const group = groupInput.trim()
    if (!group || selected.size === 0 || !apiUrl) {
      assignGroupLocal(group)
      return
    }
    const b = apiUrl.replace(/\/$/, '')
    const body = { ids: Array.from(selected), group }
    try {
      const r = await fetch(`${b}/api/domains/assign-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!r.ok) assignGroupLocal(group)
      else assignGroupLocal(group)
    } catch {
      assignGroupLocal(group)
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-white">{t('domainManager.title')}</h2>
          <p className="text-slate-400">{t('domainManager.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <a className="px-3 py-2 rounded-md bg-indigo-600 text-white" href="https://www.namecheap.com/" target="_blank" rel="noreferrer">{t('domainManager.purchase')}</a>
          <a className="px-3 py-2 rounded-md bg-slate-800 text-slate-200" href="https://www.godaddy.com/" target="_blank" rel="noreferrer">GoDaddy</a>
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 mb-4">
        <div className="flex flex-col md:flex-row md:items-end gap-3">
          <div className="flex-1">
            <label className="block text-sm text-slate-400 mb-1">{t('domainManager.apiLabel')}</label>
            <input value={apiUrlInput} onChange={e => setApiUrlInput(e.target.value)} placeholder={t('domainManager.apiPlaceholder') as string} className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-slate-200" />
          </div>
          <button onClick={saveApiUrl} className="px-3 py-2 rounded-md bg-indigo-600 text-white">{t('domainManager.saveApi')}</button>
          <button onClick={() => fetchList(apiUrlInput)} className="px-3 py-2 rounded-md bg-slate-800 text-slate-200">{t('domainManager.refresh')}</button>
        </div>
        {error && <div className="mt-3 text-sm text-red-400">{error}</div>}
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900">
        <div className="p-3 flex items-center gap-3 border-b border-slate-800">
          <span className="text-slate-400 text-sm">{t('domainManager.batch.selected')}: {selected.size}</span>
          <input value={groupInput} onChange={e => setGroupInput(e.target.value)} placeholder={t('domainManager.batch.groupPlaceholder') as string} className="bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-slate-200 text-sm" />
          <button onClick={saveGrouping} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm">{t('domainManager.batch.assignGroup')}</button>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-slate-800">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-400"><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-400">{t('domainManager.table.id')}</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-400">{t('domainManager.table.domain')}</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-400">{t('domainManager.table.status')}</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-400">{t('domainManager.table.group')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="px-4 py-6 text-slate-400" colSpan={5}>{t('domainManager.loading')}</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-slate-400" colSpan={5}>{t('domainManager.listEmpty')}</td>
                </tr>
              ) : (
                items.map(i => (
                  <tr key={i.id} className="border-t border-slate-800">
                    <td className="px-4 py-2"><input type="checkbox" checked={selected.has(i.id)} onChange={() => toggleOne(i.id)} /></td>
                    <td className="px-4 py-2 text-slate-200 text-sm">{i.id}</td>
                    <td className="px-4 py-2 text-slate-200 text-sm">{i.domain || ''}</td>
                    <td className="px-4 py-2 text-slate-400 text-sm">{i.status || ''}</td>
                    <td className="px-4 py-2 text-slate-200 text-sm">{i.group || ''}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

