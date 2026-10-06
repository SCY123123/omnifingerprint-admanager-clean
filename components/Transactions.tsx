import React, { useEffect, useState } from 'react'

interface Txn {
  id?: string
  amount?: number
  currency?: string
  status?: string
  created_at?: string
  card_id?: string
  last_four_digits?: string
}

export const Transactions: React.FC<{ autoLocal?: boolean, token?: string | null }> = ({ autoLocal, token }) => {
  const [list, setList] = useState<Txn[]>([])
  const [perPage, setPerPage] = useState(100)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [cards, setCards] = useState<any[]>([])
  const [selectedCardId, setSelectedCardId] = useState('')
  const [rangeDays, setRangeDays] = useState(30)
  const [startDate, setStartDate] = useState<string>('')
  const [endDate, setEndDate] = useState<string>('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [cardNumberFilter, setCardNumberFilter] = useState('')
  const [aliasFilter, setAliasFilter] = useState('')
  const [tagsFilter, setTagsFilter] = useState('')
  const [binCodeFilter, setBinCodeFilter] = useState('')
  const [metaInfo, setMetaInfo] = useState<any>(null)
  const [page, setPage] = useState(1)
  const [accountInfo, setAccountInfo] = useState<any>(null)
  const [cardTagsOptions, setCardTagsOptions] = useState<string[]>([])
  const [cardBinOptions, setCardBinOptions] = useState<string[]>([])
  const [aliasOptions, setAliasOptions] = useState<string[]>([])
  const [last4Options, setLast4Options] = useState<string[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [autoSaveLocal, setAutoSaveLocal] = useState(false)
  const [autoRefreshH, setAutoRefreshH] = useState<number>(0)
  const [autoRefreshM, setAutoRefreshM] = useState<number>(0)
  const [autoRefreshS, setAutoRefreshS] = useState<number>(0)
  const [autoSaveH, setAutoSaveH] = useState<number>(0)
  const [autoSaveM, setAutoSaveM] = useState<number>(0)
  const [autoSaveS, setAutoSaveS] = useState<number>(0)
  const profileIdForPrefs = 'default'
  const getToken = () => {
    const envTok = String((((import.meta as any).env?.VITE_ADPOS_TOKEN) || (process.env.ADPOS_TOKEN as any) || ''))
    if (envTok) return envTok
    try { const ls = localStorage.getItem('ADPOS_TOKEN') || '' ; if (ls) return ls } catch {}
    return ''
  }

  useEffect(() => {
    const run = async () => {
      setLoading(true)
      setError('')
      try { await fetchExternalAndSave() } catch (e:any) { setError(String(e?.message||'加载失败')) }
      finally { setLoading(false) }
    }
    run()
  }, [perPage, selectedCardId, rangeDays, startDate, endDate, statusFilter, cardNumberFilter, aliasFilter, tagsFilter, binCodeFilter, refreshKey, page])

  useEffect(() => {
    setPage(1)
  }, [selectedCardId, rangeDays, startDate, endDate, statusFilter, cardNumberFilter, aliasFilter, tagsFilter, binCodeFilter])

  useEffect(() => {
    const run = async () => {
      try {
        const base = 'https://api.adpos.io'
        const token = getToken()
        const headers: any = token ? { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } : { 'Accept': 'application/json' }
        const url = `${base}/cards?page=1&per_page=500`
        const r = await fetch(url, { headers })
        if (!r.ok) return
        const j = await r.json().catch(()=>({}))
        const arr = Array.isArray(j?.data) ? j.data : []
        setCards(arr as any[])
        try {
          const tagSet = new Set<string>()
          const aliasSet = new Set<string>()
          const l4Set = new Set<string>()
          ;(arr as any[]).forEach((c:any)=>{
            const tags = Array.isArray(c?.tags) ? c.tags.map(String) : []
            tags.forEach(t=> tagSet.add(t))
            const alias = String(c?.alias || c?.name || '').trim()
            if (alias) aliasSet.add(alias)
            const last4 = String(c?.last_four_digits || c?.card_last4 || '').trim()
            if (last4) l4Set.add(last4)
          })
          setCardTagsOptions(Array.from(tagSet))
          setAliasOptions(Array.from(aliasSet))
          setLast4Options(Array.from(l4Set))
        } catch {}
      } catch {}
    }
    run()
  }, [])

  useEffect(() => {
    const run = async () => {
      try {
        const base = 'https://api.adpos.io'
        const token = getToken()
        const headers: any = token ? { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } : { 'Accept': 'application/json' }
        const r = await fetch(`${base}/cards/cardbins`, { headers })
        if (!r.ok) return
        const j = await r.json().catch(()=>({}))
        const arr = Array.isArray(j?.data) ? j.data : []
        const bins = Array.isArray(arr) ? arr.map((x:any)=> String(x?.code || x)).filter(Boolean) : []
        setCardBinOptions(bins)
      } catch {}
    }
    run()
  }, [])

  useEffect(() => {
    const run = async () => {
      try {
        const base = 'https://api.adpos.io'
        const token = getToken()
        const headers: any = token ? { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } : { 'Accept': 'application/json' }
        const r = await fetch(`${base}/account`, { headers })
        const j = await r.json().catch(()=>({}))
        setAccountInfo(j?.data || null)
      } catch {}
    }
    run()
  }, [])

  const loadLocal = async () => {
    try {
      setLoading(true); setError('')
      const storageBase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || (process.env.STORAGE_SERVER_URL as any) || '') as string
      let sbase = String(storageBase||'').replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const url = (sbase ? `${sbase}/api/adpos/transactions/list` : `/api/adpos/transactions/list`)
      const qs = new URLSearchParams()
      if (statusFilter) qs.set('status', statusFilter)
      if (cardNumberFilter) { const t = String(cardNumberFilter).trim(); if (t && t.length<=4) qs.set('last4', t) }
      if (startDate && endDate) {
        const st = new Date(startDate); st.setHours(0,0,0,0)
        const et = new Date(endDate); et.setHours(23,59,59,999)
        qs.set('start_timestamp', String(Math.floor(st.getTime()/1000)))
        qs.set('end_timestamp', String(Math.floor(et.getTime()/1000)))
      }
      qs.set('page', String(page)); qs.set('per_page', String(Math.min(perPage,200)))
      const authToken = token || localStorage.getItem('auth_token');
      const r = await fetch(`${url}?${qs.toString()}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
      if (!r.ok) { setError(`本地读取失败：${r.status}`); setLoading(false); return }
      const j = await r.json().catch(()=>({}))
      const arr = Array.isArray(j?.data) ? j.data : []
      setList(arr as any[])
      setMetaInfo(j?.meta || null)
    } catch (e:any) { setError(String(e?.message||'本地读取失败')) } finally { setLoading(false) }
  }

  const saveLocal = async () => {
    try {
      setLoading(true); setError('')
      const payload = { items: list }
      const storageBase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || (process.env.STORAGE_SERVER_URL as any) || '') as string
      let sbase = String(storageBase||'').replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const url = (sbase ? `${sbase}/api/adpos/transactions/save-batch` : `/api/adpos/transactions/save-batch`)
      const authToken = token || localStorage.getItem('auth_token');
      const r = await fetch(url, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }, 
        body: JSON.stringify(payload) 
      })
      const j = await r.json().catch(()=>({}))
      if (!r.ok || !j?.success) { setError(`保存失败：${r.status}`) }
    } catch (e:any) { setError(String(e?.message||'保存失败')) } finally { setLoading(false) }
  }

  const fetchExternalAndSave = async () => {
    try {
      setLoading(true); setError('')
      const base = 'https://api.adpos.io'
      const token = getToken()
      const headers: any = token ? { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } : { 'Accept': 'application/json' }
      const nowSec = Math.floor(Date.now() / 1000)
      const endSec = (()=>{ if (endDate) { const d = new Date(endDate) ; d.setHours(23,59,59,999) ; return Math.floor(d.getTime()/1000) } return nowSec })()
      const maxRange = 31*24*60*60
      const startRaw = (()=>{ if (startDate) { const d = new Date(startDate) ; d.setHours(0,0,0,0) ; return Math.floor(d.getTime()/1000) } return (endSec - rangeDays*24*60*60) })()
      const startSec = Math.max(endSec - maxRange, startRaw)
      if (startSec > endSec) { setError('时间范围不合法'); setLoading(false); return }
      const qs = new URLSearchParams()
      qs.set('page', String(page))
      qs.set('per_page', String(Math.min(perPage,200)))
      qs.set('start_timestamp', String(startSec))
      qs.set('end_timestamp', String(endSec))
      if (statusFilter) qs.set('status', statusFilter)
      if (cardNumberFilter) { const t = String(cardNumberFilter).trim(); if (t && t.length<=4) qs.set('last4', t) }
      if (selectedCardId) qs.set('card_id', selectedCardId)
      if (token) qs.set('token', token)
      const storageBase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || (process.env.STORAGE_SERVER_URL as any) || '') as string
      let sbase = String(storageBase||'').replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const urlExt = (sbase ? `${sbase}/api/adpos/transactions/fetch-save` : `/api/adpos/transactions/fetch-save`)
      const authTokenHeader = token || localStorage.getItem('auth_token');
      const resp = await fetch(`${urlExt}?${qs.toString()}`, {
        headers: { 'Authorization': `Bearer ${authTokenHeader}` }
      })
      if (!resp.ok) { setError(`请求失败：${resp.status}`); setLoading(false); return }
      const json = await resp.json().catch(()=>({}))
      const arr = Array.isArray(json?.data) ? json.data : []
      setMetaInfo(json?.meta || null)
      try { await loadLocal() } catch {}
    } catch (e:any) { setError(String(e?.message||'外部拉取失败')) } finally { setLoading(false) }
  }



  const loadPrefs = async () => {
    try {
      const storageBase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || (process.env.STORAGE_SERVER_URL as any) || '') as string
      let sbase = String(storageBase||'').replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const url = (sbase ? `${sbase}/api/adpos/prefs?profileId=${encodeURIComponent(profileIdForPrefs)}` : `/api/adpos/prefs?profileId=${encodeURIComponent(profileIdForPrefs)}`)
      const authToken = token || localStorage.getItem('auth_token');
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
      const j = await r.json().catch(()=>({}))
      const d = j?.data || {}
      setAutoRefresh(!!d.auto_refresh)
      setAutoSaveLocal(!!d.auto_save_local)
      setAutoRefreshH(Number(d.auto_refresh_hours||0))
      setAutoRefreshM(Number(d.auto_refresh_minutes||0))
      setAutoRefreshS(Number(d.auto_refresh_seconds||0))
      setAutoSaveH(Number(d.auto_save_hours||0))
      setAutoSaveM(Number(d.auto_save_minutes||0))
      setAutoSaveS(Number(d.auto_save_seconds||0))
    } catch {}
  }

  const savePrefs = async (next: { auto_refresh?: boolean, auto_save_local?: boolean, auto_refresh_hours?: number, auto_refresh_minutes?: number, auto_refresh_seconds?: number, auto_save_hours?: number, auto_save_minutes?: number, auto_save_seconds?: number }) => {
    try {
      const storageBase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || (process.env.STORAGE_SERVER_URL as any) || '') as string
      let sbase = String(storageBase||'').replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const url = (sbase ? `${sbase}/api/adpos/prefs` : `/api/adpos/prefs`)
      const authToken = token || localStorage.getItem('auth_token');
      const body = {
        profileId: profileIdForPrefs,
        auto_refresh: next.auto_refresh ?? autoRefresh,
        auto_save_local: next.auto_save_local ?? autoSaveLocal,
        auto_refresh_hours: next.auto_refresh_hours ?? autoRefreshH,
        auto_refresh_minutes: next.auto_refresh_minutes ?? autoRefreshM,
        auto_refresh_seconds: next.auto_refresh_seconds ?? autoRefreshS,
        auto_save_hours: next.auto_save_hours ?? autoSaveH,
        auto_save_minutes: next.auto_save_minutes ?? autoSaveM,
        auto_save_seconds: next.auto_save_seconds ?? autoSaveS
      }
      const r = await fetch(url, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }, 
        body: JSON.stringify(body) 
      })
      await r.json().catch(()=>({}))
    } catch {}
  }

  useEffect(() => { loadPrefs() }, [])

  useEffect(() => {
    if (autoLocal) { loadLocal() }
  }, [autoLocal])

  useEffect(() => {
    const ms = (autoRefreshH*3600 + autoRefreshM*60 + autoRefreshS) * 1000
    if (autoRefresh && ms > 0) {
      const t = setInterval(() => { fetchExternalAndSave().catch(()=>{}) }, ms)
      return () => clearInterval(t)
    }
  }, [autoRefresh, autoRefreshH, autoRefreshM, autoRefreshS, selectedCardId, rangeDays, startDate, endDate, statusFilter, cardNumberFilter, aliasFilter, tagsFilter, binCodeFilter, perPage, page])

  useEffect(() => {
    const ms = (autoSaveH*3600 + autoSaveM*60 + autoSaveS) * 1000
    if (autoSaveLocal && ms > 0) {
      const t = setInterval(() => { saveLocal().catch(()=>{}) }, ms)
      return () => clearInterval(t)
    }
  }, [autoSaveLocal, autoSaveH, autoSaveM, autoSaveS])

  

  return (
    <div className="px-4">
      {accountInfo && (
        <div className="mb-3 text-xs text-slate-400">账户：{String(accountInfo.name||'')}（{String(accountInfo.email||'')}）｜余额：{String(accountInfo.balance||'')}｜授权：{String(accountInfo.authorizations||'')}</div>
      )}
      <div className="mb-4 flex items-center gap-3 relative">
        <select value={perPage} onChange={e=>{ setPerPage(Number(e.target.value)) }} className="px-2 py-2 rounded bg-slate-800 text-slate-100 text-sm">
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
        </select>
        <button onClick={()=> setFiltersOpen(o=>!o)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-100 text-sm">筛选</button>
        {filtersOpen && (
          <div className="absolute top-full left-0 mt-2 z-50 flex flex-wrap items-center gap-3 px-3 py-2 rounded border border-slate-700 bg-slate-800 shadow-xl">
            <select value={selectedCardId} onChange={e=>{ setSelectedCardId(e.target.value) }} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm">
              <option value="">全部卡片</option>
              {cards.map((c:any, idx:number)=>{
                const id = String(c.card_id || c.id || '')
                const alias = String(c.alias || c.name || '')
                const last4 = String(c.last_four_digits || c.card_last4 || '')
                return (<option key={id||idx} value={id}>{alias || id} {last4 ? `- ${last4}` : ''}</option>)
              })}
            </select>
            <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm">
              <option value="">全部状态</option>
              <option value="approved">approved</option>
              <option value="declined">declined</option>
            </select>
            <select value={aliasFilter} onChange={e=>setAliasFilter(e.target.value)} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm">
              <option value="">全部别名</option>
              {aliasOptions.map(a=> (<option key={a} value={a}>{a}</option>))}
            </select>
            <select value="" onChange={e=>{ const v = e.target.value ; if (v) setTagsFilter(t=> t ? `${t},${v}` : v) }} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm">
              <option value="">选择标签</option>
              {cardTagsOptions.map((t)=> (<option key={t} value={t}>{t}</option>))}
            </select>
            <select value="" onChange={e=>{ const v = e.target.value ; if (v) setBinCodeFilter(t=> t ? `${t},${v}` : v) }} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm">
              <option value="">选择卡BIN</option>
              {cardBinOptions.map((b)=> (<option key={b} value={b}>{b}</option>))}
            </select>
            <select value={cardNumberFilter} onChange={e=>setCardNumberFilter(e.target.value)} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm">
              <option value="">全部末四位</option>
              {last4Options.map(l=> (<option key={l} value={l}>{l}</option>))}
            </select>
            <select value={rangeDays} onChange={e=>setRangeDays(Number(e.target.value))} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm">
              <option value={7}>近7天</option>
              <option value={14}>近14天</option>
              <option value={30}>近30天</option>
            </select>
            <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm" />
            <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} className="px-2 py-2 rounded bg-slate-900 text-slate-100 text-sm" />
          </div>
        )}
        
        
        <button onClick={()=>{ fetchExternalAndSave().catch(()=>{}) }} className="px-3 py-1.5 rounded bg-slate-800 text-slate-100 text-sm">刷新</button>
        
        
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={autoRefresh} onChange={e=>{ const v = e.target.checked; setAutoRefresh(v) }} /> 自动刷新
        </label>
        <div className="flex items-center gap-1 text-xs text-slate-300">
          <input type="number" min={0} value={autoRefreshH} onChange={e=>{ const v = Math.max(0, Number(e.target.value||0)); setAutoRefreshH(v) }} className="w-16 px-2 py-1 rounded bg-slate-800 text-slate-100" placeholder="时" />
          <input type="number" min={0} value={autoRefreshM} onChange={e=>{ const v = Math.max(0, Number(e.target.value||0)); setAutoRefreshM(v) }} className="w-16 px-2 py-1 rounded bg-slate-800 text-slate-100" placeholder="分" />
          <input type="number" min={0} value={autoRefreshS} onChange={e=>{ const v = Math.max(0, Number(e.target.value||0)); setAutoRefreshS(v) }} className="w-16 px-2 py-1 rounded bg-slate-800 text-slate-100" placeholder="秒" />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={autoSaveLocal} onChange={e=>{ const v = e.target.checked; setAutoSaveLocal(v) }} /> 自动保存本地
        </label>
        <div className="flex items-center gap-1 text-xs text-slate-300">
          <input type="number" min={0} value={autoSaveH} onChange={e=>{ const v = Math.max(0, Number(e.target.value||0)); setAutoSaveH(v) }} className="w-16 px-2 py-1 rounded bg-slate-800 text-slate-100" placeholder="时" />
          <input type="number" min={0} value={autoSaveM} onChange={e=>{ const v = Math.max(0, Number(e.target.value||0)); setAutoSaveM(v) }} className="w-16 px-2 py-1 rounded bg-slate-800 text-slate-100" placeholder="分" />
          <input type="number" min={0} value={autoSaveS} onChange={e=>{ const v = Math.max(0, Number(e.target.value||0)); setAutoSaveS(v) }} className="w-16 px-2 py-1 rounded bg-slate-800 text-slate-100" placeholder="秒" />
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-300">
          <button onClick={()=> savePrefs({})} className="px-2 py-1 rounded bg-slate-800 text-slate-100">保存偏好</button>
        </div>
        
      </div>
      {metaInfo && metaInfo.pagination && (
        <div className="text-xs text-slate-400 mb-2">共 {Number(metaInfo.pagination.total||0)} 项，当前 {Number(metaInfo.pagination.count||0)} 条，页 {Number(metaInfo.pagination.current_page||1)} / {Number(metaInfo.pagination.total_pages||1)}，每页 {Number(metaInfo.pagination.per_page||perPage)}</div>
      )}
      {error && <div className="text-rose-400 text-sm mb-2">{error}</div>}
      {loading ? (
        <div className="text-slate-300">加载中...</div>
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-auto">
          <table className="min-w-full text-sm text-slate-200">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-3 py-2 text-left">时间</th>
                <th className="px-3 py-2 text-left">卡号</th>
                <th className="px-3 py-2 text-left">别名</th>
                <th className="px-3 py-2 text-left">用户名</th>
                <th className="px-3 py-2 text-left">商家</th>
                <th className="px-3 py-2 text-left">交易金额</th>
                <th className="px-3 py-2 text-left">交易币种</th>
                <th className="px-3 py-2 text-left">账单金额</th>
                <th className="px-3 py-2 text-left">账单币种</th>
                <th className="px-3 py-2 text-left">交易国家</th>
                <th className="px-3 py-2 text-left">状态</th>
                <th className="px-3 py-2 text-left">账单状态</th>
                <th className="px-3 py-2 text-left">类型</th>
                <th className="px-3 py-2 text-left">失败原因</th>
                <th className="px-3 py-2 text-left">卡末四位</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-slate-500">无交易数据</td>
                </tr>
              ) : list.map((x:any, idx:number)=> (
                <tr key={String(x.id||idx)} className="border-t border-slate-800">
                  <td className="px-3 py-2">{String(x.created_at || x.date || (typeof x.transaction_unix_timestamp === 'number' ? new Date(Number(x.transaction_unix_timestamp)*1000).toLocaleString() : ''))}</td>
                  <td className="px-3 py-2">{String(x.card_number || '')}</td>
                  <td className="px-3 py-2">{String(x.alias || '')}</td>
                  <td className="px-3 py-2">{String(x.username || '')}</td>
                  <td className="px-3 py-2">{String(x.merchant_name || '')}</td>
                  <td className="px-3 py-2">{typeof x.transaction_amount === 'number' ? x.transaction_amount : (x.transaction_amount||'')}</td>
                  <td className="px-3 py-2">{String(x.transaction_currency || '')}</td>
                  <td className="px-3 py-2">{typeof x.billing_amount === 'number' ? x.billing_amount : (x.billing_amount||'')}</td>
                  <td className="px-3 py-2">{String(x.billing_currency || '')}</td>
                  <td className="px-3 py-2">{String(x.transaction_country || '')}</td>
                  <td className="px-3 py-2">{String(x.status || '')}</td>
                  <td className="px-3 py-2">{String(x.billing_status || '')}</td>
                  <td className="px-3 py-2">{String(x.transaction_type || '')}</td>
                  <td className="px-3 py-2">{String(x.fail_reason || '')}</td>
                  <td className="px-3 py-2">{String(x.last_four_digits || x.card_last4 || '')}</td>
                </tr>
              ))}
          </tbody>
          </table>
          <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-slate-800 bg-slate-900">
            <button onClick={()=> setPage(p=> Math.max(1, p-1))} className="px-2 py-1 rounded bg-slate-800 text-slate-100 text-xs">上一页</button>
            <input type="number" min={1} value={page} onChange={e=>{ const v = Math.max(1, Number(e.target.value||1)); setPage(v) }} className="w-20 px-2 py-1 rounded bg-slate-800 text-slate-100 text-xs" />
            <button onClick={()=> setPage(p=> p+1)} className="px-2 py-1 rounded bg-slate-800 text-slate-100 text-xs">下一页</button>
          </div>
        </div>
      )}
    </div>
  )
}