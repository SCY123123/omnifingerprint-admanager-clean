import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Upload, Download, Settings, Trash2, CheckSquare, Square, X, Pencil, Search, Copy } from 'lucide-react'
import { getCache, setCache } from '../utils/apiCache'

interface PaymentCard {
  id: string
  last4: string
  network?: string
  holder: string
  expiry: string
  limit?: number
  balance?: number
  provider?: string
  tags?: string[]
  cardNumber?: string
  cvv?: string
  zip?: string
  profileId?: string
  accountId?: string
  currency?: string
  status?: string
  appliedAt?: string
  singleLimit?: number
  autoTopup?: number
  cardType?: string
}

interface ApiConfig {
  baseUrl: string
  apiKey: string
}

const maskLast4 = (last4: string): string => `**** **** **** ${String(last4 || '').slice(-4)}`
const extractLast4 = (num: string): string => {
  const digits = String(num || '').replace(/\D/g, '')
  return digits.slice(-4)
}
const detectNetwork = (num: string): string => {
  const n = String(num || '').replace(/\D/g, '')
  if (/^4\d{12,18}$/.test(n)) return 'Visa'
  if (/^(5[1-5]\d{14}|2(2[2-9]\d{12}|[3-6]\d{13}|7[01]\d{12}|720\d{12}))$/.test(n)) return 'Mastercard'
  if (/^3[47]\d{13}$/.test(n)) return 'Amex'
  if (/^6\d{15,}$/.test(n)) return 'Discover'
  return ''
}

const normalizeCardNumber = (s: string): string => String(s || '').replace(/\D/g, '')
const formatCardNumber = (s: string): string => {
  const d = normalizeCardNumber(s)
  return d.replace(/(.{4})/g, '$1 ').trim()
}
const luhnValid = (s: string): boolean => {
  const d = normalizeCardNumber(s)
  if (d.length < 12) return false
  let sum = 0
  let dbl = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (dbl) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    dbl = !dbl
  }
  return sum % 10 === 0
}
const cvvValid = (cvv: string, network: string): boolean => {
  const d = String(cvv || '').replace(/\D/g, '')
  if (/amex/i.test(network)) return d.length === 4
  return d.length === 3
}

const LOCAL_SERVER_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

export const Payment: React.FC = () => {
  const { t } = useTranslation()
  const [cards, setCards] = useState<PaymentCard[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [apiOpen, setApiOpen] = useState(false)
  const [apiCfg, setApiCfg] = useState<ApiConfig>({ baseUrl: '', apiKey: '' })
  const [importText, setImportText] = useState('')
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<boolean | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortKey, setSortKey] = useState<'holder'|'provider'|'balance'|'limit'>('holder')
  const [sortDir, setSortDir] = useState<'asc'|'desc'>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(9)
  const [editOpen, setEditOpen] = useState(false)
  const [editCard, setEditCard] = useState<PaymentCard | null>(null)
  const [viewMode, setViewMode] = useState<'grid'|'list'>('grid')
  const [profiles, setProfiles] = useState<any[]>([])
  const [adAccounts, setAdAccounts] = useState<any[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [createError, setCreateError] = useState('')
  const [showSensitive, setShowSensitive] = useState<boolean>(()=>{ try { return localStorage.getItem('paymentSensitiveVisible')==='1' } catch { return true } })
  const [filterProfileId, setFilterProfileId] = useState('')
  const [filterAccountId, setFilterAccountId] = useState('')
  const [editError, setEditError] = useState('')
  const [pushingId, setPushingId] = useState<string>('')

  const [newCard, setNewCard] = useState<PaymentCard>({
    id: '',
    last4: '',
    network: '',
    cardNumber: '',
    holder: '',
    expiry: '',
    limit: undefined,
    balance: undefined,
    provider: '',
    tags: [],
    zip: ''
  })

  useEffect(() => {
    try {
      const cfg = localStorage.getItem('paymentApiConfig')
      if (cfg) {
        const parsed = JSON.parse(cfg)
        if (parsed && typeof parsed === 'object') setApiCfg({ baseUrl: String(parsed.baseUrl || ''), apiKey: String(parsed.apiKey || '') })
      }
    } catch {}
    try {
      let sbase = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || (process.env.STORAGE_SERVER_URL as any) || '') as string).replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const authToken = localStorage.getItem('auth_token');
      const authHeaders = { 'Authorization': `Bearer ${authToken}` };

      // 🚀 缓存：先展示本地数据，后台刷新
      const cachedCards = getCache<PaymentCard[]>('billing-methods');
      if (cachedCards) setCards(cachedCards);
      const cachedProfiles = getCache<any[]>('payment:profiles');
      if (cachedProfiles) setProfiles(cachedProfiles);
      const cachedAccounts = getCache<any[]>('payment:adaccounts');
      if (cachedAccounts) setAdAccounts(cachedAccounts);

      fetch(`${sbase}/api/profiles`, { headers: authHeaders }).then(r=>r.json()).then(json=>{ 
        if (json && json.success && Array.isArray(json.data)) { setProfiles(json.data); setCache('payment:profiles', json.data) }
      }).catch(()=>{})
      fetch(`${sbase}/api/adaccounts`, { headers: authHeaders }).then(r=>r.json()).then(json=>{ 
        if (json && json.success && Array.isArray(json.data)) { setAdAccounts(json.data); setCache('payment:adaccounts', json.data) }
      }).catch(()=>{})
      fetch(`${sbase}/api/billing-methods`, { headers: authHeaders }).then(r=>r.json()).then(async json=>{ 
        const list = Array.isArray(json?.data) ? json.data : []
        const mapped: PaymentCard[] = list.map((x: any) => {
          const expm = String(x.exp_month || '').padStart(2, '0')
          const expy = String(x.exp_year || '')
          const yy = expy.length === 4 ? expy.slice(-2) : expy
          let holder = ''
          let provider = ''
          let tags: string[] = []
          let cvv = ''
          let cardNumber = ''
          let zip = ''
          try {
            const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {})
            holder = String(addr.holder || '')
            provider = String(addr.provider || '')
            tags = Array.isArray(addr.tags) ? addr.tags.map(String) : []
            cvv = String(addr.cvv || '')
            cardNumber = String(addr.cardNumber || '')
            zip = String(addr.zip || '')
          } catch {}
          return {
            id: String(x.id || x.method_id || `pc_${Date.now()}`),
            last4: String(x.last4 || x.card_last4 || x.last_four || ''),
            network: String(x.brand || x.network || ''),
            holder,
            expiry: expm && yy ? `${expm}/${yy}` : '',
            limit: undefined,
            balance: undefined,
            provider,
            tags,
            cvv,
            cardNumber,
            zip,
            profileId: String(x.profile_id || ''),
            accountId: String(x.account_id || '')
          } as PaymentCard
        })
        setCards(mapped)
        setCache('billing-methods', mapped)
      }).catch(()=>{})
    } catch {}
  }, [])

  useEffect(() => {
    if (cards.length > 0) setCache('billing-methods', cards)
  }, [cards.length > 0])

  // 当前页的过滤 + 排序逻辑（提取为 useMemo，避免 grid/table 重复）
  const filterSortCards = (list: PaymentCard[]) => {
    const q = searchTerm.trim().toLowerCase()
    return list
      .filter(c => {
        if (!q) return true
        const tags = (c.tags || []).join(',').toLowerCase()
        const last4 = String(c.last4||'').toLowerCase()
        const network = String(c.network||'').toLowerCase()
        const cardNum = String(c.cardNumber||'').toLowerCase()
        const cvv = String(c.cvv||'').toLowerCase()
        return String(c.holder||'').toLowerCase().includes(q) || String(c.provider||'').toLowerCase().includes(q) || tags.includes(q) || last4.includes(q) || network.includes(q) || cardNum.includes(q) || cvv.includes(q)
      })
      .filter(c => !filterProfileId || String(c.profileId||'')===String(filterProfileId))
      .filter(c => !filterAccountId || String(c.accountId||'')===String(filterAccountId))
      .sort((a,b)=>{
        const va = (a[sortKey] ?? '') as any
        const vb = (b[sortKey] ?? '') as any
        const na = typeof va === 'number' ? va : String(va).toLowerCase()
        const nb = typeof vb === 'number' ? vb : String(vb).toLowerCase()
        const cmp = na > nb ? 1 : na < nb ? -1 : 0
        return sortDir === 'asc' ? cmp : -cmp
      })
  }
  const filteredSortedCards = useMemo(() => filterSortCards(cards), [cards, searchTerm, filterProfileId, filterAccountId, sortKey, sortDir])
  const pageCards = useMemo(() => filteredSortedCards.slice((page-1)*pageSize, (page-1)*pageSize + pageSize), [filteredSortedCards, page, pageSize])

  const allSelected = useMemo(() => pageCards.length > 0 && selected.size === pageCards.length, [pageCards, selected])
  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(pageCards.map(c => c.id)))
  }
  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreate = async () => {
    setCreateError('')
    const id = `pc_${Date.now()}`
    const last4 = newCard.last4 || extractLast4(newCard.cardNumber || '')
    const network = newCard.network || detectNetwork(newCard.cardNumber || '')
    const entry: PaymentCard = { id, last4, network, holder: newCard.holder, expiry: newCard.expiry, limit: newCard.limit, balance: newCard.balance, provider: newCard.provider, tags: (newCard.tags || []).filter(Boolean), cvv: newCard.cvv || '', cardNumber: newCard.cardNumber || '', zip: newCard.zip || '' }
    const numOk = (()=>{ try { return luhnValid(entry.cardNumber||'') } catch { return false } })()
    const cvvOk = cvvValid(entry.cvv||'', entry.network||'')
    const expOk = (()=>{ const p = parseExpiry(entry.expiry||''); const mm = Number(p.month||0); const yy = Number(p.year||0); if (!mm || mm<1 || mm>12 || !yy) return false; const now = new Date(); const curY = now.getFullYear(); const curM = now.getMonth()+1; if (yy < curY) return false; if (yy === curY && mm < curM) return false; return true })()
    if (!numOk) { setCreateError('卡号不合法'); return }
    if (!cvvOk) { setCreateError('CVV不合法'); return }
    if (!expOk) { setCreateError('到期日期不合法'); return }
    try {
      let sbase = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || (process.env.STORAGE_SERVER_URL as any) || '') as string).replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const exp = parseExpiry(entry.expiry)
      const items = [{
        id: entry.id,
        profileId: String(selectedProfileId || ''),
        accountId: String(selectedAccountId || ''),
        type: entry.network ? 'card' : 'card',
        last4: String(entry.last4 || ''),
        brand: String(entry.network || ''),
        exp_month: String(exp.month || ''),
        exp_year: String(exp.year || ''),
        billing_address: JSON.stringify({ provider: entry.provider || '', holder: entry.holder || '', tags: (entry.tags||[]), cardNumber: entry.cardNumber || '', cvv: entry.cvv || '', zip: entry.zip || '' })
      }]
      const authToken = localStorage.getItem('auth_token');
      const resp = await fetch(`${sbase}/api/billing-methods/bulk-save`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }, 
        body: JSON.stringify({ items }) 
      })
      if (!resp.ok) { setCreateError('保存到服务器失败'); return }
      try {
        const r = await fetch(`${sbase}/api/billing-methods`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        })
        if (r.ok) {
          const j = await r.json()
          const list = Array.isArray(j?.data) ? j.data : []
          const mapped: PaymentCard[] = list.map((x: any) => {
            const expm = String(x.exp_month || '').padStart(2, '0')
            const expy = String(x.exp_year || '')
            const yy = expy.length === 4 ? expy.slice(-2) : expy
            let holder = ''
            let provider = ''
            let tags: string[] = []
            let cvv = ''
            let cardNumber = ''
            let zip = ''
            try {
              const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {})
              holder = String(addr.holder || '')
              provider = String(addr.provider || '')
              tags = Array.isArray(addr.tags) ? addr.tags.map(String) : []
              cvv = String(addr.cvv || '')
              cardNumber = String(addr.cardNumber || '')
              zip = String(addr.zip || '')
            } catch {}
            return {
              id: String(x.id || `pc_${Date.now()}`),
              last4: String(x.last4 || ''),
              network: String(x.brand || ''),
              holder,
              expiry: expm && yy ? `${expm}/${yy}` : '',
              limit: undefined,
              balance: undefined,
              provider,
              tags,
              cvv,
              cardNumber,
              zip,
              profileId: String(x.profile_id || ''),
              accountId: String(x.account_id || '')
            } as PaymentCard
          })
          if (mapped.length) setCards(mapped)
          else setCards(prev => [entry, ...prev])
        } else {
          setCards(prev => [entry, ...prev])
        }
      } catch {
        setCards(prev => [entry, ...prev])
      }
    } catch {}
    setNewCard({ id: '', last4: '', network: '', cardNumber: '', holder: '', expiry: '', limit: undefined, balance: undefined, provider: '', tags: [], zip: '' })
    setSelectedProfileId('')
    setSelectedAccountId('')
    setCreateOpen(false)
  }

  const handleDeleteSelected = async () => {
    if (!selected.size) return
    const ids = Array.from(selected)
    try {
      let sbase = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || (process.env.STORAGE_SERVER_URL as any) || '') as string).replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const authToken = localStorage.getItem('auth_token');
      await fetch(`${sbase}/api/billing-methods/batch-delete`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }, 
        body: JSON.stringify({ ids }) 
      })
    } catch {}
    const toDelete = new Set(ids)
    setCards(prev => prev.filter(c => !toDelete.has(c.id)))
    setSelected(new Set())
  }

  const handleExport = () => {
    const list = (selected.size ? cards.filter(c => selected.has(c.id)) : cards)
    const payload = list.map(c => ({ id: c.id, profileId: c.profileId, accountId: c.accountId, last4: c.last4, network: c.network, holder: c.holder, expiry: c.expiry, limit: c.limit, balance: c.balance, provider: c.provider, tags: c.tags, cardNumber: c.cardNumber, cvv: c.cvv }))
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `PaymentCards_${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const parseExpiry = (exp: string): { month?: string; year?: string } => {
    const s = String(exp || '').trim()
    const m = s.match(/^(\d{2})[\/-]?(\d{2,4})$/)
    if (m) {
      const mm = m[1]
      let yy = m[2]
      if (yy && yy.length === 2) yy = String(2000 + parseInt(yy, 10))
      return { month: mm, year: yy }
    }
    return {}
  }

  const saveSelectedToDb = async () => {
    const list = (selected.size ? cards.filter(c => selected.has(c.id)) : cards)
    if (!list.length) return
    try {
      const sbase = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || (process.env.STORAGE_SERVER_URL as any) || '') as string).replace(/\/$/, '')
      const items = list.map(c => {
        const exp = parseExpiry(c.expiry)
        return {
          id: c.id,
          profileId: '',
          accountId: '',
          type: c.network ? 'card' : 'card',
          last4: String(c.last4 || ''),
          brand: String(c.network || ''),
          exp_month: String(exp.month || ''),
          exp_year: String(exp.year || ''),
          billing_address: JSON.stringify({ provider: c.provider || '', holder: c.holder || '', tags: (c.tags||[]), cardNumber: c.cardNumber || '', cvv: c.cvv || '', zip: c.zip || '' })
        }
      })
      const authToken = localStorage.getItem('auth_token');
      await fetch(`${sbase}/api/billing-methods/bulk-save`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }, 
        body: JSON.stringify({ items }) 
      })
      alert('已保存到数据库')
    } catch {
      alert('保存到数据库失败')
    }
  }

  const handleImportText = () => {
    try {
      const arr = JSON.parse(importText)
      if (!Array.isArray(arr)) return
      let sbase = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || (process.env.STORAGE_SERVER_URL as any) || '') as string).replace(/\/$/, '')
      try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = '' } catch {}
      const items = arr.map((x: any, i: number) => {
        const last4 = String(x.last4 || extractLast4(x.cardNumber || ''))
        const brand = String(x.network || detectNetwork(x.cardNumber || '')) || ''
        const exp = parseExpiry(String(x.expiry || ''))
        return { id: String(x.id || `pc_${Date.now()}_${i}`), profileId: '', accountId: '', type: 'card', last4, brand, exp_month: String(exp.month || ''), exp_year: String(exp.year || ''), billing_address: JSON.stringify({ provider: String(x.provider || ''), holder: String(x.holder || ''), tags: Array.isArray(x.tags) ? x.tags.map(String) : [], cardNumber: String(x.cardNumber || ''), cvv: String(x.cvv || ''), zip: String(x.zip || '') }) }
      })
      const authToken = localStorage.getItem('auth_token');
      fetch(`${sbase}/api/billing-methods/bulk-save`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        }, 
        body: JSON.stringify({ items }) 
      })
        .then(() => fetch(`${sbase}/api/billing-methods`, { headers: { 'Authorization': `Bearer ${authToken}` } }))
        .then(r=>r.json())
        .then(json=>{
          const list = Array.isArray(json?.data) ? json.data : []
          const mapped: PaymentCard[] = list.map((x: any) => {
            const expm = String(x.exp_month || '').padStart(2, '0')
            const expy = String(x.exp_year || '')
            const yy = expy.length === 4 ? expy.slice(-2) : expy
            let holder = ''
            let provider = ''
            let tags: string[] = []
            let cvv = ''
            let cardNumber = ''
            let zip = ''
            try { const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {}); holder = String(addr.holder || ''); provider = String(addr.provider || ''); tags = Array.isArray(addr.tags) ? addr.tags.map(String) : []; cvv = String(addr.cvv || ''); cardNumber = String(addr.cardNumber || ''); zip = String(addr.zip || '') } catch {}
            return { id: String(x.id || `pc_${Date.now()}`), last4: String(x.last4 || ''), network: String(x.brand || ''), holder, expiry: expm && yy ? `${expm}/${yy}` : '', limit: undefined, balance: undefined, provider, tags, cvv, cardNumber, zip }
          })
          setCards(mapped)
        })
      setImportText('')
      setImportOpen(false)
    } catch {}
  }

  const handleSaveApi = () => {
    try {
      localStorage.setItem('paymentApiConfig', JSON.stringify(apiCfg))
    } catch {}
    setApiOpen(false)
  }

  const handleTestApi = async () => {
    setTesting(true)
    setTestOk(null)
    try {
      const base = apiCfg.baseUrl.replace(/\/$/, '')
      const r = await fetch(`${base}/health`, { headers: { Authorization: apiCfg.apiKey ? `Bearer ${apiCfg.apiKey}` : '' } })
      setTestOk(r.ok)
    } catch {
      setTestOk(false)
    } finally {
      setTesting(false)
    }
  }

  const pushCardToAdAccount = async (card: PaymentCard) => {
    if (!selectedProfileId || !selectedAccountId) { alert('请选择配置与广告账户'); return }
    if (!card) return
    setPushingId(card.id)
    try {
      let base = (((import.meta as any).env?.VITE_LAUNCH_SERVER_URL) || (process.env.LAUNCH_SERVER_URL as any) || '').replace(/\/$/, '')
      try {
        if (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:' && base.startsWith('http://')) {
          base = base.replace(/^http:/, 'https:').replace(/:9999$/, ':9443')
        }
        if (base && /localhost|127\.0\.0\.1/i.test(base)) base = ''
      } catch {}
      const authToken = localStorage.getItem('auth_token');
      const resp = await fetch(`${base}/api/facebook/billing/add`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'X-Api-Secret': LOCAL_SERVER_SECRET
        }, 
        body: JSON.stringify({ profileId: selectedProfileId, adAccountId: selectedAccountId, mode: 'sync' }) 
      })
      const rj = await resp.json().catch(()=>({}))
      const status = String(rj && rj.status || '')
      if (status === 'no_browser') { alert('目标未启动浏览器，请先到配置页启动'); return }
      if (status === 'not_logged_in') { alert('浏览器未登录，请先登录后再重试'); return }
      alert('已提交至广告号')
    } catch {
      alert('提交失败')
    } finally {
      setPushingId('')
    }
  }

  const autoVerifyCard = async () => { alert('自动验证已禁用') }
  const launchBillingPage = async () => {
    try {
      if (!selectedProfileId || !selectedAccountId) { alert('请选择配置与广告账户'); return }
      let baseUrl = 'http://localhost:9999/api';
      const target = 'https://facebook.com/'
      const payload: any = { profileId: selectedProfileId, startUrls: [target], strictStartUrls: true, strictVerifyOnly: true }
      await fetch(`${baseUrl}/launch-browser`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET
        }, 
        body: JSON.stringify(payload) 
      })
      alert('已启动账单页')
    } catch {
      alert('启动失败')
    }
  }

  return (
    <div className="px-4">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-white">{t('payment.title')}</h2>
        <p className="text-slate-400">{t('payment.subtitle')}</p>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-indigo-600 text-white">
          <Plus className="w-4 h-4" />{t('payment.actions.new')}
        </button>
        <button onClick={() => setImportOpen(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-slate-800 text-slate-100">
          <Upload className="w-4 h-4" />{t('payment.actions.import')}
        </button>
        <button onClick={handleExport} className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-slate-800 text-slate-100">
          <Download className="w-4 h-4" />{t('payment.actions.export')}
        </button>
        <button onClick={() => setApiOpen(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-slate-800 text-slate-100">
          <Settings className="w-4 h-4" />{t('payment.actions.apiSettings')}
        </button>
        <div className="relative ml-2">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-slate-400" />
          <input value={searchTerm} onChange={e=>{setSearchTerm(e.target.value); setPage(1)}} placeholder={t('payment.actions.search') as string} className="pl-8 pr-3 py-2 rounded-md bg-slate-800 text-slate-100" />
        </div>
        <div className="ml-2 flex items-center gap-2">
          <select value={sortKey} onChange={e=>setSortKey(e.target.value as any)} className="px-2 py-2 rounded bg-slate-800 text-slate-100 text-sm">
            <option value="holder">{t('payment.fields.holder')}</option>
            <option value="provider">{t('payment.fields.provider')}</option>
            <option value="balance">{t('payment.fields.balance')}</option>
            <option value="limit">{t('payment.fields.limit')}</option>
          </select>
          <select value={sortDir} onChange={e=>setSortDir(e.target.value as any)} className="px-2 py-2 rounded bg-slate-800 text-slate-100 text-sm">
            <option value="asc">ASC</option>
            <option value="desc">DESC</option>
          </select>
        </div>
        <div className="ml-2 flex items-center gap-2">
          <button onClick={()=>setViewMode('grid')} className={`px-3 py-2 rounded-md text-sm ${viewMode==='grid'?'bg-indigo-600 text-white':'bg-slate-800 text-slate-100'}`}>{t('payment.view.grid')}</button>
          <button onClick={()=>{setViewMode('list'); setPage(1)}} className={`px-3 py-2 rounded-md text-sm ${viewMode==='list'?'bg-indigo-600 text-white':'bg-slate-800 text-slate-100'}`}>{t('payment.view.list')}</button>
          <button onClick={()=>{ const nv = !showSensitive; setShowSensitive(nv); try { localStorage.setItem('paymentSensitiveVisible', nv ? '1' : '0') } catch {} }} className={`px-3 py-2 rounded-md text-sm ${showSensitive?'bg-green-600 text-white':'bg-slate-800 text-slate-100'}`}>{showSensitive ? '敏感显示: 开' : '敏感显示: 关'}</button>
          <button onClick={async()=>{
            try {
              if (!selectedProfileId || !selectedAccountId) { alert('请选择配置与广告账户'); return }
              let baseUrl = 'http://localhost:9999/api';
              const mergedResp = await fetch(`${baseUrl}/facebook/billing/cards/merged`, { 
                method: 'POST', 
                headers: { 
                  'Content-Type': 'application/json',
                  'X-Api-Secret': LOCAL_SERVER_SECRET
                }, 
                body: JSON.stringify({ profileId: selectedProfileId, adAccountId: selectedAccountId }) 
              }).then(r=>r.json()).catch(()=>({}))
              const list = Array.isArray(mergedResp?.cards) ? mergedResp.cards : []
              const mapped: PaymentCard[] = list.map((x: any) => {
                const expm = String(x.exp_month || '').padStart(2, '0')
                const expy = String(x.exp_year || '')
                const yy = expy.length === 4 ? expy.slice(-2) : expy
                let holder = ''
                let provider = ''
                let tags: string[] = []
                let cvv = ''
                let cardNumber = ''
                let zip = ''
                try { const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {}); holder = String(addr.holder || ''); provider = String(addr.provider || ''); tags = Array.isArray(addr.tags) ? addr.tags.map(String) : []; cvv = String(addr.cvv || ''); cardNumber = String(addr.cardNumber || ''); zip = String(addr.zip || '') } catch {}
                const bal = typeof x.balance === 'number' ? x.balance : undefined
                const currency = String((x.currency || '')).toUpperCase()
                const status = String(x.status || '')
                const appliedAt = String(x.appliedAt || '')
                const singleLimit = typeof x.singleLimit === 'number' ? x.singleLimit : undefined
                const autoTopup = typeof x.autoTopup === 'number' ? x.autoTopup : undefined
                const cardType = String(x.cardType || '')
                return { id: String(x.id || `pc_${Date.now()}`), last4: String(x.last4 || ''), network: String(x.brand || ''), holder, expiry: expm && yy ? `${expm}/${yy}` : '', limit: undefined, balance: bal, provider, tags, cvv, cardNumber: cardNumber || String(x.cardNumber || ''), zip, profileId: String(x.profile_id||''), accountId: String(x.account_id||''), currency, status, appliedAt, singleLimit, autoTopup, cardType } as PaymentCard
              })
              setCards(mapped)
            } catch { alert('刷新账单失败') }
          }} className={`px-3 py-2 rounded-md text-sm bg-slate-800 text-slate-100`}>刷新账单</button>
          <button onClick={launchBillingPage} className={`px-3 py-2 rounded-md text-sm bg-indigo-600 text-white`}>启动账单页</button>
        </div>
        <div className="ml-2 flex items-center gap-2">
          <select value={filterProfileId} onChange={e=>{ setFilterProfileId(e.target.value); setPage(1) }} className="px-2 py-2 rounded bg-slate-800 text-slate-100 text-sm">
            <option value="">按配置筛选</option>
            {profiles.map((p:any)=> (<option key={p.id} value={p.id}>{p.name || p.id}</option>))}
          </select>
          <select value={filterAccountId} onChange={e=>{ setFilterAccountId(e.target.value); setPage(1) }} className="px-2 py-2 rounded bg-slate-800 text-slate-100 text-sm">
            <option value="">按广告账户筛选</option>
            {adAccounts.map((a:any)=> (<option key={a.adAccountId} value={a.adAccountId}>{a.adAccountId} {a.adAccountName ? `- ${a.adAccountName}` : ''}</option>))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-3 text-slate-300">
          <button onClick={toggleAll} className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-slate-800 text-slate-100">
            {allSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
            {t('payment.list.selected')}: {selected.size}
          </button>
          <button onClick={handleDeleteSelected} className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-red-600 text-white">
            <Trash2 className="w-4 h-4" />{t('payment.actions.deleteSelected')}
          </button>
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-slate-300 text-center">
          {t('payment.list.noData')}
        </div>
      ) : (
        <>
        {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {pageCards.map(card => {
            const checked = selected.has(card.id)
            return (
              <div key={card.id} className={`rounded-lg border ${checked ? 'border-indigo-600' : 'border-slate-800'} bg-slate-900 p-3`}>
                <div className="flex items-center justify-between mb-2">
                  <button onClick={() => toggleOne(card.id)} className={`p-1.5 rounded ${checked ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200'}`}>
                    {checked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                  </button>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">{card.provider || '—'}</span>
                  <button onClick={()=>{setEditCard(card); setEditOpen(true)}} className="p-1.5 rounded bg-slate-800 text-slate-200"><Pencil className="w-3 h-3" /></button>
                  <button disabled={pushingId===card.id} onClick={()=>pushCardToAdAccount(card)} className={`p-1.5 rounded ${pushingId===card.id?'bg-slate-700 text-slate-400':'bg-slate-800 text-slate-200'}`}>提交至广告号</button>
                  
                  <button onClick={async()=>{ try { 
                    const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, ''); 
                    const authToken = localStorage.getItem('auth_token');
                    await fetch(`${sbase}/api/billing-methods/batch-delete`, { 
                      method: 'POST', 
                      headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                      }, 
                      body: JSON.stringify({ ids: [card.id] }) 
                    }); 
                  } catch {} finally { setCards(prev => prev.filter(x => x.id !== card.id)) } }} className="p-1.5 rounded bg-red-600 text-white"><Trash2 className="w-3 h-3" /></button>
                </div>
                </div>
                <div className="text-base font-medium text-white mb-1">{maskLast4(card.last4)} <span className="ml-2 text-xs text-slate-400">{card.network || ''}</span></div>
                <div className="text-xs text-slate-300 flex items-center gap-3">
                  <span>币种: {card.currency || '—'}</span>
                  <span>状态: {card.status || '—'}</span>
                </div>
                <div className="text-xs text-slate-300 flex items-center gap-2">{t('payment.fields.cardNumber')}: {showSensitive ? (card.cardNumber ? formatCardNumber(card.cardNumber) : '—') : '—'}
                  {showSensitive && card.cardNumber ? (
                    <button onClick={()=>{ try { navigator.clipboard.writeText(normalizeCardNumber(card.cardNumber)) } catch {} }} className="px-1 py-0.5 rounded bg-slate-800 text-[11px] text-slate-200 inline-flex items-center gap-1"><Copy className="w-3 h-3" />复制</button>
                  ) : null}
                </div>
                <div className="text-xs text-slate-300 flex items-center gap-2">{t('payment.fields.cvv')}: {showSensitive ? (card.cvv || '—') : '—'}
                  {showSensitive && card.cvv ? (
                    <button onClick={()=>{ try { navigator.clipboard.writeText(String(card.cvv)) } catch {} }} className="px-1 py-0.5 rounded bg-slate-800 text-[11px] text-slate-200 inline-flex items-center gap-1"><Copy className="w-3 h-3" />复制</button>
                  ) : null}
                </div>
                <div className="text-xs text-slate-300">{t('payment.fields.holder')}: {card.holder || '—'}</div>
                <div className="text-xs text-slate-300">{t('payment.fields.expiry')}: {card.expiry || '—'}</div>
                <div className="text-xs text-slate-300">{t('payment.fields.limit')}: {typeof card.limit === 'number' ? card.limit : '—'}</div>
                <div className="text-xs text-slate-300">{t('payment.fields.balance')}: {typeof card.balance === 'number' ? card.balance : '—'}</div>
                <div className="text-xs text-slate-300">邮编: {card.zip || '—'}</div>
                {card.tags && card.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {card.tags.map(tag => (
                      <span key={tag} className="px-1.5 py-0.5 rounded bg-slate-800 text-[11px] text-slate-300">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        ) : (
          <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-auto">
            <table className="min-w-full text-sm text-slate-200">
              <thead className="bg-slate-800 text-slate-300">
                <tr>
                  <th className="px-3 py-2 text-left w-12">{t('payment.list.selected')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.table.last4')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.fields.cardNumber')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.fields.cvv')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.table.network')}</th>
                  <th className="px-3 py-2 text-left">配置</th>
                  <th className="px-3 py-2 text-left">广告账户</th>
                  <th className="px-3 py-2 text-left">{t('payment.fields.holder')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.fields.expiry')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.fields.provider')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.fields.limit')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.fields.balance')}</th>
                  <th className="px-3 py-2 text-left">邮编</th>
                  <th className="px-3 py-2 text-left">{t('payment.fields.tags')}</th>
                  <th className="px-3 py-2 text-left">{t('payment.table.actions')}</th>
                </tr>
              </thead>
              <tbody>
              {pageCards.map(card => {
                  const checked = selected.has(card.id)
                  return (
                    <tr key={card.id} className="border-t border-slate-800">
                      <td className="px-3 py-2">
                        <button onClick={() => toggleOne(card.id)} className={`p-1.5 rounded ${checked ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200'}`}>
                          {checked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-2">{maskLast4(card.last4)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span>{showSensitive ? (card.cardNumber || '—') : '—'}</span>
                          {showSensitive && card.cardNumber ? (
                            <button onClick={()=>{ try { navigator.clipboard.writeText(card.cardNumber) } catch {} }} className="px-1 py-0.5 rounded bg-slate-800 text-[11px] text-slate-200 inline-flex items-center gap-1"><Copy className="w-3 h-3" />复制</button>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span>{showSensitive ? (card.cvv || '—') : '—'}</span>
                          {showSensitive && card.cvv ? (
                            <button onClick={()=>{ try { navigator.clipboard.writeText(String(card.cvv)) } catch {} }} className="px-1 py-0.5 rounded bg-slate-800 text-[11px] text-slate-200 inline-flex items-center gap-1"><Copy className="w-3 h-3" />复制</button>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2">{card.network || '—'}</td>
                      <td className="px-3 py-2">{String(card.currency||'')}</td>
                      <td className="px-3 py-2">{String(card.status||'')}</td>
                      <td className="px-3 py-2">{card.profileId || '—'}</td>
                      <td className="px-3 py-2">{card.accountId || '—'}</td>
                      <td className="px-3 py-2">{card.holder || '—'}</td>
                      <td className="px-3 py-2">{card.expiry || '—'}</td>
                      <td className="px-3 py-2">{card.provider || '—'}</td>
                      <td className="px-3 py-2">{typeof card.limit === 'number' ? card.limit : '—'}</td>
                      <td className="px-3 py-2">{typeof card.balance === 'number' ? card.balance : '—'}</td>
                      <td className="px-3 py-2">{card.zip || '—'}</td>
                      <td className="px-3 py-2">
                        {(card.tags||[]).length ? (
                          <div className="flex flex-wrap gap-1">
                            {(card.tags||[]).map(tag => (
                              <span key={tag} className="px-1.5 py-0.5 rounded bg-slate-800 text-[11px] text-slate-300">{tag}</span>
                            ))}
                          </div>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={()=>{setEditCard(card); setEditOpen(true)}} className="px-2 py-1 rounded bg-slate-800 text-slate-100 text-xs inline-flex items-center gap-1"><Pencil className="w-3 h-3" />{t('payment.actions.edit')}</button>
                        <button disabled={pushingId===card.id} onClick={()=>pushCardToAdAccount(card)} className={`ml-2 px-2 py-1 rounded ${pushingId===card.id?'bg-slate-700 text-slate-400':'bg-slate-800 text-slate-100'} text-xs`}>提交至广告号</button>
                        <button onClick={autoVerifyCard} className="ml-2 px-2 py-1 rounded bg-indigo-600 text-white text-xs">自动验证</button>
                        <button onClick={async()=>{ try { 
                          const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || 'http://localhost:7000').replace(/\/$/, ''); 
                          const authToken = localStorage.getItem('auth_token');
                          await fetch(`${sbase}/api/billing-methods/batch-delete`, { 
                            method: 'POST', 
                            headers: { 
                              'Content-Type': 'application/json',
                              'Authorization': `Bearer ${authToken}`
                            }, 
                            body: JSON.stringify({ ids: [card.id] }) 
                          }); 
                        } catch {} finally { setCards(prev => prev.filter(x => x.id !== card.id)) } }} className="px-2 py-1 rounded bg-red-600 text-white text-xs inline-flex items-center gap-1"><Trash2 className="w-3 h-3" />{t('payment.actions.deleteSelected')}</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-slate-400">{t('payment.list.selected')}: {selected.size}</div>
          <div className="flex items-center gap-2">
            <button disabled={page===1} onClick={()=>setPage(p=>Math.max(1,p-1))} className="px-3 py-1.5 rounded bg-slate-800 text-slate-100 text-sm">Prev</button>
            <span className="text-slate-300 text-sm">{page}</span>
            <button onClick={()=>setPage(p=>p+1)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-100 text-sm">Next</button>
            <select value={pageSize} onChange={e=>{setPageSize(Number(e.target.value)); setPage(1)}} className="px-2 py-1.5 rounded bg-slate-800 text-slate-100 text-sm">
              <option value={6}>6</option>
              <option value={9}>9</option>
              <option value={12}>12</option>
            </select>
          </div>
        </div>
        </>
      )}

      {createOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center">
          <div className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-medium text-white">{t('payment.actions.new')}</h3>
              <button onClick={() => setCreateOpen(false)} className="p-2 text-slate-300 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <input value={newCard.cardNumber || ''} onChange={e => setNewCard(v => ({ ...v, cardNumber: e.target.value, last4: extractLast4(e.target.value), network: detectNetwork(e.target.value) }))} placeholder={t('payment.fields.cardNumber') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <input value={newCard.holder} onChange={e => setNewCard(v => ({ ...v, holder: e.target.value }))} placeholder={t('payment.fields.holder') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <div className="grid grid-cols-2 gap-3">
                <input value={newCard.expiry} onChange={e => setNewCard(v => ({ ...v, expiry: e.target.value }))} placeholder={t('payment.fields.expiry') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
                <input value={newCard.cvv || ''} onChange={e => setNewCard(v => ({ ...v, cvv: e.target.value }))} placeholder={t('payment.fields.cvv') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              </div>
            <div className="grid grid-cols-2 gap-3">
              <input value={typeof newCard.limit === 'number' ? String(newCard.limit) : ''} onChange={e => setNewCard(v => ({ ...v, limit: e.target.value ? Number(e.target.value) : undefined }))} placeholder={t('payment.fields.limit') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <input value={typeof newCard.balance === 'number' ? String(newCard.balance) : ''} onChange={e => setNewCard(v => ({ ...v, balance: e.target.value ? Number(e.target.value) : undefined }))} placeholder={t('payment.fields.balance') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <select value={selectedProfileId} onChange={e=>{ setSelectedProfileId(e.target.value); setSelectedAccountId('') }} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200">
                <option value="">选择配置(可选)</option>
                {profiles.map((p:any)=> (<option key={p.id} value={p.id}>{p.name || p.id}</option>))}
              </select>
              <select value={selectedAccountId} onChange={e=>setSelectedAccountId(e.target.value)} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200">
                <option value="">选择广告账户(可选)</option>
                {adAccounts
                  .filter((a:any)=> !selectedProfileId || String(a.profileId||'')===String(selectedProfileId))
                  .map((a:any)=> {
                    const displayName = String(a.account || a.profileName || a.adAccountName || '未命名');
                    const id = String(a.adAccountId || a.account_id || a.id || '');
                    return (
                      <option key={id} value={id}>{id} - {displayName}</option>
                    )
                  })}
              </select>
            </div>
            <input value={newCard.provider || ''} onChange={e => setNewCard(v => ({ ...v, provider: e.target.value }))} placeholder={t('payment.fields.provider') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
            <input value={(newCard.tags || []).join(', ')} onChange={e => setNewCard(v => ({ ...v, tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} placeholder={t('payment.fields.tags') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
            <input value={newCard.zip || ''} onChange={e => setNewCard(v => ({ ...v, zip: e.target.value }))} placeholder="邮编 (ZIP)" className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setCreateOpen(false)} className="px-4 py-2 rounded bg-slate-800 text-slate-100">{t('payment.create.cancel')}</button>
              <button onClick={handleCreate} className="px-4 py-2 rounded bg-indigo-600 text-white">{t('payment.create.create')}</button>
            </div>
            {createError && <div className="mt-2 text-sm text-rose-400">{createError}</div>}
          </div>
        </div>
      )}

      {importOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center">
          <div className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-medium text-white">{t('payment.actions.import')}</h3>
              <button onClick={() => setImportOpen(false)} className="p-2 text-slate-300 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-slate-400 mb-2">{t('payment.import.hint')}</p>
            <textarea value={importText} onChange={e => setImportText(e.target.value)} placeholder={t('payment.import.pasteJson') as string} className="w-full h-32 px-3 py-2 rounded bg-slate-800 text-slate-200"></textarea>
            <div className="mt-3">
              <input type="file" accept=".json,.csv,.xlsx,.xls" onChange={async e => {
                const f = e.target.files && e.target.files[0]
                if (!f) return
                const ext = f.name.toLowerCase().split('.').pop() || ''
                if (ext === 'json') {
                  const text = await f.text()
                  try {
                    const arr = JSON.parse(text)
                    if (Array.isArray(arr)) {
                      const sbase = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || (process.env.STORAGE_SERVER_URL as any) || '') as string).replace(/\/$/, '')
                      const items = arr.map((x: any, i: number) => {
                        const last4 = String(x.last4 || extractLast4(x.cardNumber || ''))
                        const brand = String(x.network || detectNetwork(x.cardNumber || '')) || ''
                        const exp = parseExpiry(String(x.expiry || ''))
                      return { id: String(x.id || `pc_${Date.now()}_${i}`), profileId: '', accountId: '', type: 'card', last4, brand, exp_month: String(exp.month || ''), exp_year: String(exp.year || ''), billing_address: JSON.stringify({ provider: String(x.provider || ''), holder: String(x.holder || ''), tags: Array.isArray(x.tags) ? x.tags.map(String) : [], cardNumber: String(x.cardNumber || ''), cvv: String(x.cvv || ''), zip: String(x.zip || '') }) }
                      })
                      await fetch(`${sbase}/api/billing-methods/bulk-save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
                      const jr = await fetch(`${sbase}/api/billing-methods`)
                      const json2 = await jr.json()
                      const list = Array.isArray(json2?.data) ? json2.data : []
                      const mapped = list.map((x: any) => {
                        const expm = String(x.exp_month || '').padStart(2, '0')
                        const expy = String(x.exp_year || '')
                        const yy = expy.length === 4 ? expy.slice(-2) : expy
                        let holder = ''
                        let provider = ''
                        let tags: string[] = []
                        let cvv = ''
                        let cardNumber = ''
                        let zip = ''
                        try { const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {}); holder = String(addr.holder || ''); provider = String(addr.provider || ''); tags = Array.isArray(addr.tags) ? addr.tags.map(String) : []; cvv = String(addr.cvv || ''); cardNumber = String(addr.cardNumber || ''); zip = String(addr.zip || '') } catch {}
                        return { id: String(x.id || `pc_${Date.now()}`), last4: String(x.last4 || ''), network: String(x.brand || ''), holder, expiry: expm && yy ? `${expm}/${yy}` : '', limit: undefined, balance: undefined, provider, tags, cvv, cardNumber, zip }
                      })
                      setCards(mapped)
                      setImportOpen(false)
                    }
                  } catch {}
                } else {
                  try {
                    const XLSX = await import('xlsx')
                    const data = new Uint8Array(await f.arrayBuffer())
                    const wb = XLSX.read(data, { type: 'array' })
                    const ws = wb.Sheets[wb.SheetNames[0]]
                    const json = XLSX.utils.sheet_to_json(ws)
                    const sbase = ((((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || (process.env.STORAGE_SERVER_URL as any) || '') as string).replace(/\/$/, '')
                    const items = (Array.isArray(json)?json:[]).map((x: any, i: number) => {
                      const cardNum = String(x.cardNumber || x.CardNumber || '')
                      const last4 = String(x.last4 || extractLast4(cardNum))
                      const brand = String(x.network || detectNetwork(cardNum)) || ''
                      const exp = parseExpiry(String(x.expiry || x.Expiry || ''))
                      return { id: String(x.id || `pc_${Date.now()}_${i}`), profileId: '', accountId: '', type: 'card', last4, brand, exp_month: String(exp.month || ''), exp_year: String(exp.year || ''), billing_address: JSON.stringify({ provider: String(x.provider || x.Provider || ''), holder: String(x.holder || x.Holder || ''), tags: Array.isArray(x.tags) ? x.tags.map(String) : [], cardNumber: cardNum, cvv: String(x.cvv || x.CVV || ''), zip: String(x.zip || '') }) }
                    })
                    await fetch(`${sbase}/api/billing-methods/bulk-save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
                    const jr = await fetch(`${sbase}/api/billing-methods`)
                    const json2 = await jr.json()
                    const list = Array.isArray(json2?.data) ? json2.data : []
                    const mapped = list.map((x: any) => {
                      const expm = String(x.exp_month || '').padStart(2, '0')
                      const expy = String(x.exp_year || '')
                      const yy = expy.length === 4 ? expy.slice(-2) : expy
                      let holder = ''
                      let provider = ''
                      let tags: string[] = []
                      let zip = ''
                      try { const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {}); holder = String(addr.holder || ''); provider = String(addr.provider || ''); tags = Array.isArray(addr.tags) ? addr.tags.map(String) : []; zip = String(addr.zip || '') } catch {}
                      return { id: String(x.id || `pc_${Date.now()}`), last4: String(x.last4 || ''), network: String(x.brand || ''), holder, expiry: expm && yy ? `${expm}/${yy}` : '', limit: undefined, balance: undefined, provider, tags, zip }
                    })
                    setCards(mapped)
                    setImportOpen(false)
                  } catch {}
                }
              }} className="w-full text-sm text-slate-300" />
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setImportOpen(false)} className="px-4 py-2 rounded bg-slate-800 text-slate-100">{t('payment.create.cancel')}</button>
              <button onClick={handleImportText} className="px-4 py-2 rounded bg-indigo-600 text-white">{t('payment.actions.import')}</button>
            </div>
          </div>
        </div>
      )}

      {apiOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center">
          <div className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-medium text-white">{t('payment.actions.apiSettings')}</h3>
              <button onClick={() => setApiOpen(false)} className="p-2 text-slate-300 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <input value={apiCfg.baseUrl} onChange={e => setApiCfg(v => ({ ...v, baseUrl: e.target.value }))} placeholder={t('payment.api.baseUrl') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <input value={apiCfg.apiKey} onChange={e => setApiCfg(v => ({ ...v, apiKey: e.target.value }))} placeholder={t('payment.api.apiKey') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
            </div>
            <div className="mt-5 flex justify-between items-center">
              <div className="flex items-center gap-3">
                <button disabled={testing} onClick={handleTestApi} className="px-3 py-2 rounded bg-slate-800 text-slate-100">{t('payment.api.test')}</button>
                {testOk !== null && (
                  <span className={`text-sm ${testOk ? 'text-green-400' : 'text-red-400'}`}>{testOk ? t('payment.api.ok') : t('payment.api.fail')}</span>
                )}
              </div>
              <div className="flex gap-3">
                <button onClick={() => setApiOpen(false)} className="px-4 py-2 rounded bg-slate-800 text-slate-100">{t('payment.create.cancel')}</button>
                <button onClick={handleSaveApi} className="px-4 py-2 rounded bg-indigo-600 text-white">{t('payment.api.save')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {editOpen && editCard && (
        <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center">
          <div className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-medium text-white">{t('payment.actions.edit')}</h3>
              <button onClick={() => setEditOpen(false)} className="p-2 text-slate-300 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <input value={maskLast4(editCard.last4)} disabled className="w-full px-3 py-2 rounded bg-slate-800 text-slate-400" placeholder="卡号后四位" />
              <input value={editCard.network || ''} disabled className="w-full px-3 py-2 rounded bg-slate-800 text-slate-400" placeholder="卡品牌" />
              <input value={editCard.cardNumber || ''} onChange={e => setEditCard(v=>v?{...v, cardNumber:e.target.value, last4: extractLast4(e.target.value), network: detectNetwork(e.target.value)}:v)} placeholder={t('payment.fields.cardNumber') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <input value={editCard.holder} onChange={e => setEditCard(v=>v?{...v, holder:e.target.value}:v)} placeholder={t('payment.fields.holder') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <input value={editCard.expiry} onChange={e => setEditCard(v=>v?{...v, expiry:e.target.value}:v)} placeholder={t('payment.fields.expiry') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <input value={editCard.cvv || ''} onChange={e => setEditCard(v=>v?{...v, cvv:e.target.value}:v)} placeholder={t('payment.fields.cvv') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <div className="grid grid-cols-2 gap-3">
                <input value={typeof editCard.limit === 'number' ? String(editCard.limit) : ''} onChange={e => setEditCard(v=>v?{...v, limit:e.target.value ? Number(e.target.value) : undefined}:v)} placeholder={t('payment.fields.limit') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
                <input value={typeof editCard.balance === 'number' ? String(editCard.balance) : ''} onChange={e => setEditCard(v=>v?{...v, balance:e.target.value ? Number(e.target.value) : undefined}:v)} placeholder={t('payment.fields.balance') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              </div>
              <input value={editCard.provider || ''} onChange={e => setEditCard(v=>v?{...v, provider:e.target.value}:v)} placeholder={t('payment.fields.provider') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <input value={(editCard.tags || []).join(', ')} onChange={e => setEditCard(v=>v?{...v, tags:e.target.value.split(',').map(s=>s.trim()).filter(Boolean)}:v)} placeholder={t('payment.fields.tags') as string} className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
              <input value={editCard.zip || ''} onChange={e => setEditCard(v=>v?{...v, zip:e.target.value}:v)} placeholder="邮编 (ZIP)" className="w-full px-3 py-2 rounded bg-slate-800 text-slate-200" />
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setEditOpen(false)} className="px-4 py-2 rounded bg-slate-800 text-slate-100">{t('payment.create.cancel')}</button>
              <button onClick={async () => { if (!editCard) return; setEditError(''); const numOk = luhnValid(editCard.cardNumber||''); const cvvOk = cvvValid(editCard.cvv||'', editCard.network||''); const expOk = (()=>{ const p = parseExpiry(editCard.expiry||''); const mm = Number(p.month||0); const yy = Number(p.year||0); if (!mm || mm<1 || mm>12 || !yy) return false; const now = new Date(); const curY = now.getFullYear(); const curM = now.getMonth()+1; if (yy < curY) return false; if (yy === curY && mm < curM) return false; return true })(); if (!numOk) { setEditError('卡号不合法'); return } if (!cvvOk) { setEditError('CVV不合法'); return } if (!expOk) { setEditError('到期日期不合法'); return } try { const sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || 'http://localhost:7000').replace(/\/$/, ''); const exp = parseExpiry(editCard.expiry || ''); const item = { id: editCard.id, profileId: '', accountId: '', type: editCard.network ? 'card' : 'card', last4: String(editCard.last4 || ''), brand: String(editCard.network || ''), exp_month: String(exp.month || ''), exp_year: String(exp.year || ''), billing_address: JSON.stringify({ provider: editCard.provider || '', holder: editCard.holder || '', tags: (editCard.tags||[]), cardNumber: editCard.cardNumber || '', cvv: editCard.cvv || '', zip: editCard.zip || '' }) }; await fetch(`${sbase}/api/billing-methods/bulk-save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [item] }) }); const r = await fetch(`${sbase}/api/billing-methods`); if (r.ok) { const j = await r.json(); const list = Array.isArray(j?.data) ? j.data : []; const mapped: PaymentCard[] = list.map((x: any) => { const expm = String(x.exp_month || '').padStart(2, '0'); const expy = String(x.exp_year || ''); const yy = expy.length === 4 ? expy.slice(-2) : expy; let holder = ''; let provider = ''; let tags: string[] = []; let cvv = ''; let cardNumber = ''; let zip = ''; try { const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {}); holder = String(addr.holder || ''); provider = String(addr.provider || ''); tags = Array.isArray(addr.tags) ? addr.tags.map(String) : []; cvv = String(addr.cvv || ''); cardNumber = String(addr.cardNumber || ''); zip = String(addr.zip || ''); } catch {} return { id: String(x.id || `pc_${Date.now()}`), last4: String(x.last4 || ''), network: String(x.brand || ''), holder, expiry: expm && yy ? `${expm}/${yy}` : '', limit: undefined, balance: undefined, provider, tags, cvv, cardNumber, zip } as PaymentCard }); setCards(mapped); } else { setCards(prev => prev.map(c => c.id === editCard.id ? { ...c, holder: editCard.holder, expiry: editCard.expiry, limit: editCard.limit, balance: editCard.balance, provider: editCard.provider, tags: editCard.tags, cvv: editCard.cvv, cardNumber: editCard.cardNumber, zip: editCard.zip } : c)); } } catch { setCards(prev => prev.map(c => c.id === editCard.id ? { ...c, holder: editCard.holder, expiry: editCard.expiry, limit: editCard.limit, balance: editCard.balance, provider: editCard.provider, tags: editCard.tags, cvv: editCard.cvv, cardNumber: editCard.cardNumber, zip: editCard.zip } : c)); } setEditOpen(false); }} className="px-4 py-2 rounded bg-indigo-600 text-white">{t('payment.actions.save')}</button>
            {editError && <div className="mt-2 text-sm text-rose-400">{editError}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
