import React, { useEffect, useState } from 'react'
import { Plus, Save, X, CreditCard, Trash2, RefreshCw, List, Grid3X3, Clock, Tag, Hash, Globe, Pencil, Eye, EyeOff, AlertTriangle, Upload } from 'lucide-react'

interface CardRow {
    id?: string
    card_id?: string
    alias?: string
    last_four_digits?: string
    card_last4?: string
    status?: string  // active | pending | inactive
    currency?: string
    exp_month?: string
    exp_year?: string
    brand?: string
    billing_address?: string
    zip?: string
    channel?: string
    tags?: string[]
    savedAt?: string
    // 🚀 新增：存储完整卡号以便完整显示
    cardNumber?: string
    holder?: string
    cvv?: string
    // 🚀 绑卡状态追踪
    bindStatus?: 'success' | 'failed' | 'pending' | ''
    bindMessage?: string
  }

interface CardFormData {
  number: string
  holder: string
  expMonth: string
  expYear: string
  cvv: string
  alias: string
  billingAddress: string
  zip: string
  channel: string
  tags: string
}

export const Cards: React.FC<{ token?: string }> = ({ token: passedToken }) => {
  const [list, setList] = useState<CardRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [perPage, setPerPage] = useState(15)
  const [page, setPage] = useState(1)
  const [metaInfo, setMetaInfo] = useState<any>(null)
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add')
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingCard, setEditingCard] = useState<CardRow | null>(null)
  const [localCards, setLocalCards] = useState<CardRow[]>([])
  const [activeView, setActiveView] = useState<'remote' | 'local'>('local')
  const [localViewMode, setLocalViewMode] = useState<'grid' | 'list'>('grid')

  // 🚀 全局完整卡号显示开关
  const [showFullNumbers, setShowFullNumbers] = useState<boolean>(() => {
    try { return localStorage.getItem('settings:showFullCardNumbers') === 'true' } catch { return false }
  });

  const [retrying, setRetrying] = useState<boolean>(false);

  // 🚀 导入卡片
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importChannel, setImportChannel] = useState('');
  const [importTags, setImportTags] = useState('');
  const [showChannelSuggest, setShowChannelSuggest] = useState(false);
  const [showTagSuggest, setShowTagSuggest] = useState(false);
  const [importing, setImporting] = useState(false);

  // 收集已有渠道和标签用于建议
  const existingChannels = [...new Set(localCards.map(c => c.channel).filter(Boolean))];
  const existingTags = [...new Set(localCards.flatMap(c => c.tags || []))];

  // 🚀 解析导入文本并保存
  const handleImportCards = () => {
    if (!importText.trim()) { alert('请粘贴卡片数据'); return; }
    setImporting(true);
    try {
      const raw = importText.replace(/\r/g, '').replace(/\s+$/, '');
      // 拆分行，然后去掉每行行首的时间标记 [2026/7/1 23:02] 崔:
      const lines = raw.split('\n').map(l => {
        const trimmed = l.trim();
        return trimmed.replace(/^\s*\[.*?\]\s*\S*:\s*/, '').trim();
      }).filter(l => l && l.includes('|'));
      const newCards: CardRow[] = [];
      const errors: string[] = [];

      for (const line of lines) {
        const parts = line.split('|').map(p => p.trim());
        // 只取前三段：卡号|月/年|CVV，其余忽略
        if (parts.length < 3) { errors.push(`格式错误: ${line.substring(0, 40)}`); continue; }

        const cardNumber = parts[0].replace(/\s/g, '');
        const expParts = parts[1].split('/');
        const expMonth = expParts[0]?.padStart(2, '0') || '';
        let expYear = expParts[1] || '';
        if (expYear.length === 2) expYear = '20' + expYear;
        const cvv = parts[2] || '';

        if (cardNumber.length < 13) { errors.push(`卡号太短: ${cardNumber.substring(0, 8)}...`); continue; }

        const last4 = cardNumber.slice(-4);
        newCards.push({
          id: `imp_${cardNumber}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
          cardNumber,
          last_four_digits: last4,
          card_last4: last4,
          cvv,
          exp_month: expMonth,
          exp_year: expYear,
          brand: '',
          status: 'active',
          holder: '',
          alias: `Card ${last4}`.trim(),
          channel: importChannel,
          tags: importTags ? importTags.split(/[,，\s]+/).map((t: string) => t.trim()).filter(Boolean) : [],
          billing_address: JSON.stringify({ number: cardNumber, cvv })
        });
      }

      if (newCards.length === 0) {
        alert(`未解析到有效卡片！\n${errors.slice(0, 5).join('\n')}`);
        setImporting(false);
        return;
      }

      // 保存到本地状态
      const updated = [...localCards, ...newCards];
      setLocalCards(updated);
      try { localStorage.setItem('local-cards', JSON.stringify(updated)); } catch {}

      // 保存到 billingMethodsByProfile
      try {
        const billingMethods = localStorage.getItem('billingMethodsByProfile');
        let byProfile: Record<string, any[]> = {};
        if (billingMethods) { try { byProfile = JSON.parse(billingMethods); } catch {} }
        const pid = 'local';
        if (!byProfile[pid]) byProfile[pid] = [];
        for (const c of newCards) {
          byProfile[pid].push({
            id: c.id, profile_id: pid, last4: c.card_last4, brand: c.brand, status: 'active',
            exp_month: c.exp_month, exp_year: c.exp_year, savedAt: new Date().toISOString(),
            channel: c.channel, tags: c.tags,
            alias: c.alias, billing_address: JSON.stringify({ number: c.cardNumber, cvv: c.cvv, tags: c.tags })
          });
        }
        localStorage.setItem('billingMethodsByProfile', JSON.stringify(byProfile));
      } catch {}

      // 同步线上 D1
      try {
        const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const sbase = isLocalDev ? (((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '').replace(/\/$/, '') : '';
        const authToken = localStorage.getItem('auth_token');
        if (authToken) {
          fetch(`${sbase}/api/billing-methods/bulk-save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({
              items: newCards.map(c => ({
                  id: c.id, profile_id: 'local', last4: c.card_last4, brand: c.brand, status: 'active',
                  exp_month: c.exp_month, exp_year: c.exp_year, channel: c.channel,
                  tags: c.tags,
                  billing_address: JSON.stringify({ number: c.cardNumber, cvv: c.cvv, tags: c.tags })
                }))
            })
          }).catch(() => {});
        }
      } catch {}

      const summary = `成功导入 ${newCards.length} 张卡片`;
      const errMsg = errors.length > 0 ? `\n跳过 ${errors.length} 条（前5条：\n${errors.slice(0, 5).join('\n')}）` : '';
      alert(summary + errMsg);
      setShowImport(false);
      setImportText('');
      setImportChannel('');
      setImportTags('');
    } catch (e: any) {
      alert('导入失败: ' + e.message);
    } finally {
      setImporting(false);
    }
  };

  // 🚀 批量选择
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const toggleCardSelect = (id: string) => {
    setSelectedCards(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selectedCards.size === localCards.length) { setSelectedCards(new Set()); }
    else { setSelectedCards(new Set(localCards.map(c => c.id))); }
  };

  // 🚀 保存卡片到 localStorage
  const saveLocalCards = (cards: CardRow[]) => {
    try { localStorage.setItem('local-cards', JSON.stringify(cards)); } catch {}
  };

  // 🚀 重试绑卡
  const retryBindCard = async (card: CardRow) => {
    if (!card.cardNumber || !card.exp_month || !card.exp_year || !card.cvv) {
      alert('卡片信息不全（缺少完整卡号/有效期/CVV），无法重试绑卡');
      return;
    }
    const adAccountId = prompt('请输入目标广告号ID:', '');
    if (!adAccountId) return;
    setRetrying(true);
    try {
      const launchUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
      const resp = await fetch(`${launchUrl}/api/facebook/billing/bind-card-puppeteer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: String(card.id || '').split('_')[0] || '1',
          adAccountId,
          ccNumber: card.cardNumber.replace(/\s/g, ''),
          ccYear: String(card.exp_year).slice(-2),
          ccMonth: String(card.exp_month).padStart(2, '0'),
          ccCVC: card.cvv,
          ccIso: 'US'
        })
      });
      const json = await resp.json();
      if (json.success) {
        setLocalCards(prev => prev.map(c => c.id === card.id ? { ...c, bindStatus: 'success', bindMessage: '绑卡成功', status: 'active' } : c));
        saveLocalCards(localCards.map(c => c.id === card.id ? { ...c, bindStatus: 'success', bindMessage: '绑卡成功', status: 'active' } : c));
        alert('重试绑卡成功！');
      } else {
        const errMsg = json.message || json.apiResult?.message || JSON.stringify(json);
        setLocalCards(prev => prev.map(c => c.id === card.id ? { ...c, bindStatus: 'failed', bindMessage: errMsg } : c));
        saveLocalCards(localCards.map(c => c.id === card.id ? { ...c, bindStatus: 'failed', bindMessage: errMsg } : c));
        alert('重试绑卡失败: ' + errMsg);
      }
    } catch (e: any) {
      setLocalCards(prev => prev.map(c => c.id === card.id ? { ...c, bindStatus: 'failed', bindMessage: e.message } : c));
      saveLocalCards(localCards.map(c => c.id === card.id ? { ...c, bindStatus: 'failed', bindMessage: e.message } : c));
      alert('重试绑卡异常: ' + e.message);
    } finally {
      setRetrying(false);
    }
  };

  const [form, setForm] = useState<CardFormData>({
    number: '', holder: '', expMonth: '', expYear: '', cvv: '', alias: '', billingAddress: '',
    zip: '', channel: '', tags: ''
  })

  const getToken = () => {
    if (passedToken) return passedToken
    const envTok = String((((import.meta as any).env?.VITE_ADPOS_TOKEN) || (process.env.ADPOS_TOKEN as any) || ''))
    if (envTok) return envTok
    try { const ls = localStorage.getItem('ADPOS_TOKEN') || '' ; if (ls) return ls } catch {}
    return ''
  }

  // 🚀 切换全局显示开关
  const toggleShowFullNumbers = () => {
    const next = !showFullNumbers;
    setShowFullNumbers(next);
    try { localStorage.setItem('settings:showFullCardNumbers', String(next)); } catch {}
  };

  // 🚀 获取卡号显示文本
  const getCardDisplay = (c: CardRow): string => {
    if (showFullNumbers && c.cardNumber) return c.cardNumber;
    if (c.card_last4 || c.last4) return `**** **** **** ${c.card_last4 || c.last4}`;
    return '**** **** **** ****';
  };

  // 加载本地已保存的卡片
  useEffect(() => {
    const loadCards = async () => {
      const all: CardRow[] = [];
      
      // 1. 从 localStorage 加载
      try {
        const stored = localStorage.getItem('billingMethodsByProfile');
        if (stored) {
          const byProfile = JSON.parse(stored);
          Object.values(byProfile).forEach((cards: any) => {
            if (Array.isArray(cards)) {
              cards.forEach((c: any) => {
                const tags = Array.isArray(c.tags) ? c.tags : [];
                let holder = '', cardNum = '', cvvVal = '';
                try {
                  const addr = typeof c.billing_address === 'string' ? JSON.parse(c.billing_address) : (c.billing_address || {});
                  holder = String(addr.holder || '');
                  cardNum = String(addr.number || '');
                  cvvVal = String(addr.cvv || '');
                } catch {}
                all.push({
                  id: c.id || c.card_id || '',
                  card_last4: c.last4 || '',
                  brand: c.brand || '',
                  status: c.status || 'pending_verification',
                  exp_month: c.exp_month || '',
                  exp_year: c.exp_year || '',
                  zip: c.zip || '',
                  channel: c.channel || '',
                  tags,
                  savedAt: c.savedAt || '',
                  billing_address: typeof c.billing_address === 'string' ? c.billing_address : JSON.stringify(c.billing_address || ''),
                  alias: c.alias || `末四位 ${c.last4 || '****'}`,
                  cardNumber: cardNum,
                  holder,
                  cvv: cvvVal,
                });
              });
            }
          });
        }
      } catch {}
      
      // 2. 从服务器 API 拉取（线上同源路径，本地用 VITE_STORAGE_SERVER_URL）
      try {
        const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const sbase = isLocalDev ? (((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '').replace(/\/$/, '') : '';
        const authToken = localStorage.getItem('auth_token');
        const resp = await fetch(`${sbase}/api/billing-methods`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (resp.ok) {
          const json = await resp.json();
          const listData = Array.isArray(json?.data) ? json.data : [];
          listData.forEach((x: any) => {
            const expm = String(x.exp_month || '').padStart(2, '0');
            const expy = String(x.exp_year || '');
            let holder = '', provider = '', zip = '', channel = '', cardNum = '', cvvVal = '';
            let tags: string[] = [];
            try {
              const addr = typeof x.billing_address === 'string' ? JSON.parse(x.billing_address) : (x.billing_address || {});
              holder = String(addr.holder || '');
              provider = String(addr.provider || '');
              cardNum = String(addr.number || '');
              cvvVal = String(addr.cvv || '');
              tags = Array.isArray(addr.tags) ? addr.tags.map(String) : [];
              zip = String(addr.zip || '');
            } catch {}
            if (!all.some(existing => existing.id === String(x.id))) {
              all.push({
                id: String(x.id || `srv_${Date.now()}`),
                card_last4: x.last4 || '',
                brand: x.brand || '',
                status: x.status || 'active',
                exp_month: expm,
                exp_year: expy,
                zip, channel, tags,
                cardNumber: cardNum, holder,
                cvv: cvvVal,
                savedAt: x.created_at || '',
                alias: `末四位 ${x.last4 || '****'}`,
              });
            }
          });
        }
      } catch {}
      
      setLocalCards(all);
    };
    loadCards();
  }, []);

  useEffect(() => {
    if (activeView !== 'remote') return;
    const run = async () => {
      setLoading(true)
      setError('')
      try {
        const base = 'https://api.adpos.io'
        const token = getToken()
        const headers: any = token ? { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } : { 'Accept': 'application/json' }
        const url = `${base}/cards?page=${page}&per_page=${perPage}`
        const r = await fetch(url, { headers })
        if (!r.ok) { setError(`请求失败：${r.status}`); setList([]); return }
        const j = await r.json().catch(()=>({}))
        const arr = Array.isArray(j?.data) ? j.data : []
        setList(arr as any[])
        setMetaInfo(j?.meta || null)
      } catch (e:any) {
        setError(String(e?.message || '加载失败'))
      } finally { setLoading(false) }
    }
    run()
  }, [page, perPage, activeView])

  // 🚀 打开新增表单
  const openAddForm = () => {
    setForm({ number: '', holder: '', expMonth: '', expYear: '', cvv: '', alias: '', billingAddress: '', zip: '', channel: '', tags: '' });
    setEditingCard(null);
    setFormMode('add');
    setShowForm(true);
  };

  // 🚀 打开编辑表单（预填所有信息）
  const openEditForm = (card: CardRow) => {
    let holder = card.holder || '';
    let cardNum = card.cardNumber || '';
    let billingAddr = '';
    try {
      const addr = typeof card.billing_address === 'string' ? JSON.parse(card.billing_address) : (card.billing_address || {});
      if (!holder) holder = String(addr.holder || '');
      if (!cardNum) cardNum = String(addr.number || '');
      billingAddr = String(addr.address || '');
    } catch {}
    setForm({
      number: cardNum,
      holder: holder,
      expMonth: card.exp_month || '',
      expYear: card.exp_year || '',
      cvv: card.cvv || '',
      alias: card.alias || '',
      billingAddress: billingAddr,
      zip: card.zip || '',
      channel: card.channel || '',
      tags: Array.isArray(card.tags) ? card.tags.join(', ') : (card.tags || ''),
    });
    setEditingCard(card);
    setFormMode('edit');
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingCard(null);
    setForm({ number: '', holder: '', expMonth: '', expYear: '', cvv: '', alias: '', billingAddress: '', zip: '', channel: '', tags: '' });
  };

  // 🚀 保存卡片（共用：新增 & 编辑）
  const saveCard = () => {
    if (!form.number) return;
    setSaving(true);
    try {
      const last4 = form.number.slice(-4);
      const now = new Date().toISOString();
      const tagsArr = form.tags ? form.tags.split(',').map(s => s.trim()).filter(Boolean) : [];

      const entry: CardRow = {
        id: editingCard?.id || `local_${Date.now()}`,
        alias: form.alias || `卡末四位 ${last4}`,
        card_last4: last4,
        brand: detectCardBrand(form.number),
        status: 'active',
        exp_month: form.expMonth,
        exp_year: form.expYear,
        zip: form.zip,
        channel: form.channel,
        tags: tagsArr,
        savedAt: editingCard?.savedAt || now,
        cardNumber: form.number,
        holder: form.holder,
        cvv: form.cvv,
        billing_address: form.billingAddress || '{}',
      };

      let updated: CardRow[];
      if (formMode === 'edit') {
        updated = localCards.map(c => c.id === editingCard?.id ? { ...c, ...entry } : c);
      } else {
        updated = [...localCards, entry];
      }
      setLocalCards(updated);

      // 保存到 localStorage
      const billingMethods = localStorage.getItem('billingMethodsByProfile');
      let byProfile: Record<string, any[]> = {};
      if (billingMethods) {
        try { byProfile = JSON.parse(billingMethods); } catch {}
      }
      const pid = 'local';
      if (!byProfile[pid]) byProfile[pid] = [];
      if (formMode === 'edit') {
        byProfile[pid] = byProfile[pid].map((c: any) => c.id === editingCard?.id ? {
          ...c, last4, brand: entry.brand, status: 'active',
          exp_month: form.expMonth, exp_year: form.expYear,
          zip: form.zip, channel: form.channel, tags: tagsArr,
          alias: form.alias,
          billing_address: { number: form.number, holder: form.holder, address: form.billingAddress, tags: tagsArr, cvv: form.cvv }
        } : c);
      } else {
        byProfile[pid].push({
          id: entry.id, profile_id: pid, last4, brand: entry.brand, status: 'active',
          exp_month: form.expMonth, exp_year: form.expYear,
          zip: form.zip, channel: form.channel, tags: tagsArr,
          savedAt: now, alias: form.alias,
          billing_address: { number: form.number, holder: form.holder, address: form.billingAddress, tags: tagsArr, cvv: form.cvv }
        });
      }
      localStorage.setItem('billingMethodsByProfile', JSON.stringify(byProfile));
      
      // 同步线上 D1
      try {
        const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const sbase = isLocalDev ? (((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '').replace(/\/$/, '') : '';
        const authToken = localStorage.getItem('auth_token');
        fetch(`${sbase}/api/billing-methods/bulk-save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({
            items: [{
              id: entry.id, profile_id: pid, last4, brand: entry.brand, status: 'active',
              exp_month: form.expMonth, exp_year: form.expYear,
              zip: form.zip, alias: form.alias,
              billing_address: JSON.stringify({ number: form.number, holder: form.holder, address: form.billingAddress, tags: tagsArr })
            }]
          })
        });
      } catch {}

      closeForm();
      setActiveView('local');
    } catch (e: any) {
      setError('保存失败: ' + (e.message || ''));
    } finally {
      setSaving(false);
    }
  };

  // 🚀 删除本地卡片（增强：按 id + last4 双重匹配，清除所有来源）
  const deleteLocalCard = (id: string, last4?: string) => {
    const targetId = id;
    const targetLast4 = last4 || '';
    
    // 从当前状态移除
    setLocalCards(prev => prev.filter(c => c.id !== targetId));

    // 从 localStorage 所有 profile 下彻底删除（按 id 和 last4）
    const billingMethods = localStorage.getItem('billingMethodsByProfile');
    if (billingMethods) {
      try {
        let byProfile = JSON.parse(billingMethods);
        for (const pid of Object.keys(byProfile)) {
          if (Array.isArray(byProfile[pid])) {
            byProfile[pid] = byProfile[pid].filter((c: any) => {
              // 按 id 或 last4 匹配
              if (c.id === targetId) return false;
              if (targetLast4 && (c.last4 === targetLast4 || c.card_last4 === targetLast4)) return false;
              return true;
            });
          }
        }
        localStorage.setItem('billingMethodsByProfile', JSON.stringify(byProfile));
      } catch {}
    }

    // 清除旧的缓存格式（兼容老数据）
    try {
      const stored = localStorage.getItem('local-cards');
      if (stored) {
        let oldCards = JSON.parse(stored);
        if (Array.isArray(oldCards)) {
          oldCards = oldCards.filter((c: any) => c.id !== targetId);
          localStorage.setItem('local-cards', JSON.stringify(oldCards));
        }
      }
    } catch {}

    // 同步删除线上 D1
    try {
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const sbase = isLocalDev ? (((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '').replace(/\/$/, '') : '';
      const authToken = localStorage.getItem('auth_token');
      fetch(`${sbase}/api/billing-methods/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ ids: [targetId] })
      });
    } catch {}
  };

  // 🚀 批量删除选中卡片
  const batchDeleteCards = () => {
    if (selectedCards.size === 0) return;
    if (!confirm(`确定删除选中的 ${selectedCards.size} 张卡片？`)) return;
    const ids = new Set(selectedCards);
    setLocalCards(prev => prev.filter(c => !ids.has(c.id)));

    // 从 localStorage 彻底删除
    const billingMethods = localStorage.getItem('billingMethodsByProfile');
    if (billingMethods) {
      try {
        let byProfile = JSON.parse(billingMethods);
        for (const pid of Object.keys(byProfile)) {
          if (Array.isArray(byProfile[pid])) {
            byProfile[pid] = byProfile[pid].filter((c: any) => !ids.has(c.id));
          }
        }
        localStorage.setItem('billingMethodsByProfile', JSON.stringify(byProfile));
      } catch {}
    }
    try {
      const stored = localStorage.getItem('local-cards');
      if (stored) {
        let oldCards = JSON.parse(stored);
        if (Array.isArray(oldCards)) {
          oldCards = oldCards.filter((c: any) => !ids.has(c.id));
          localStorage.setItem('local-cards', JSON.stringify(oldCards));
        }
      }
    } catch {}
    setSelectedCards(new Set());

    // 🚀 同步删除线上 D1 数据库
    try {
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const sbase = isLocalDev ? (((import.meta as any).env?.VITE_STORAGE_SERVER_URL) || '').replace(/\/$/, '') : '';
      const authToken = localStorage.getItem('auth_token');
      if (authToken) {
        fetch(`${sbase}/api/billing-methods/batch-delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ ids: [...ids] })
        }).catch(() => {});
      }
    } catch {}
  };

  // 🚀 清除所有本地旧数据
  const clearAllLocalData = () => {
    if (!confirm('确定清除所有本地卡片数据？此操作不可撤销。')) return;
    setLocalCards([]);
    try {
      localStorage.removeItem('billingMethodsByProfile');
      localStorage.removeItem('local-cards');
      localStorage.removeItem('settings:cardApiConfig');
      window.dispatchEvent(new Event('cards-refresh'));
    } catch {}
  };

  // 🚀 卡片表单组件（新增 & 编辑复用）
  const renderCardForm = () => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeForm}>
      <div className="rounded-xl border border-indigo-600/30 bg-slate-900 p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-indigo-400" />
            {formMode === 'add' ? '新增信用卡' : '编辑信用卡'}
          </h3>
          <button onClick={closeForm} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">卡号</label>
            <input type="text" value={form.number} onChange={e => setForm({...form, number: e.target.value.replace(/\D/g,'')})} maxLength={16} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white font-mono" placeholder="4242424242424242" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">持卡人姓名</label>
            <input type="text" value={form.holder} onChange={e => setForm({...form, holder: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white" placeholder="John Doe" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">有效期 (月)</label>
            <select value={form.expMonth} onChange={e => setForm({...form, expMonth: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white">
              <option value="">月</option>
              {Array.from({length:12}, (_,i) => String(i+1).padStart(2,'0')).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">有效期 (年)</label>
            <select value={form.expYear} onChange={e => setForm({...form, expYear: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white">
              <option value="">年</option>
              {Array.from({length:10}, (_,i) => String(new Date().getFullYear() + i)).map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">CVV</label>
            <input type="text" value={form.cvv} onChange={e => setForm({...form, cvv: e.target.value.replace(/\D/g,'')})} maxLength={4} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white font-mono" placeholder="123" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">别名（可选）</label>
            <input type="text" value={form.alias} onChange={e => setForm({...form, alias: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white" placeholder="Visa 金卡" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">账单地址（可选）</label>
            <input type="text" value={form.billingAddress} onChange={e => setForm({...form, billingAddress: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white" placeholder="123 Main St, City, ZIP" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">邮编</label>
            <input type="text" value={form.zip} onChange={e => setForm({...form, zip: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white font-mono" placeholder="10001" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">渠道</label>
            <input type="text" value={form.channel} onChange={e => setForm({...form, channel: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white" placeholder="stripe, adyen" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">标签（逗号分隔）</label>
            <input type="text" value={form.tags} onChange={e => setForm({...form, tags: e.target.value})} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white" placeholder="visa, 主卡, 高额度" />
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={saveCard} disabled={!form.number || !form.holder || saving} className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 text-white rounded-lg text-sm transition-all">
            <Save className="w-4 h-4" />
            {saving ? '保存中...' : (formMode === 'edit' ? '保存修改' : '保存卡片')}
          </button>
          <button onClick={closeForm} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm transition-all">取消</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="px-4">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveView('remote')}
            className={`px-3 py-1.5 rounded-lg text-xs transition-all ${activeView === 'remote' ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-600/30' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            外部卡库 (AdPos)
          </button>
          <button
            onClick={() => setActiveView('local')}
            className={`px-3 py-1.5 rounded-lg text-xs transition-all ${activeView === 'local' ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-600/30' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            本地卡片 ({localCards.length})
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* 🚀 完整卡号显示开关 */}
          <button onClick={toggleShowFullNumbers} className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-all ${showFullNumbers ? 'bg-amber-600/20 text-amber-300 border border-amber-600/30' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            {showFullNumbers ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showFullNumbers ? '隐藏卡号' : '显示完整卡号'}
          </button>
          <button onClick={openAddForm} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs transition-all">
            <Plus className="w-3.5 h-3.5" />
            新增卡片
          </button>
        </div>
      </div>

      {/* 🚀 卡片表单弹窗（新增 & 编辑复用） */}
      {showForm && renderCardForm()}

      {/* 🚀 导入卡片弹窗 */}
      {showImport && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowImport(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-lg w-full mx-4 max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-slate-100">导入卡片</h3>
              <button onClick={() => setShowImport(false)} className="text-slate-400 hover:text-slate-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-3">自动识别前三段：<br />卡号|月/年|CVV，后续内容忽略</p>
            <div className="flex items-center gap-2 mb-3">
              <button onClick={() => document.getElementById('import-file-input')?.click()} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-sky-800/30 text-sky-300 hover:bg-sky-700/50 transition-all">
                <Upload className="w-3.5 h-3.5" />
                选择 txt 文件
              </button>
              <span className="text-xs text-slate-500">{importing ? `正在解析...` : importText ? `${importText.split('\n').filter(l => l.includes('|')).length} 行含卡号数据` : '未选择文件'}</span>
              <input id="import-file-input" type="file" accept=".txt" className="hidden" onChange={async e => {
                const file = e.target.files?.[0];
                if (!file) return;
                setImporting(true);
                try { setImportText(await file.text()); } catch {}
                setImporting(false);
                e.target.value = '';
              }} />
            </div>
            <textarea
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder={`4685840210414713|01/2029|927|VISA|...\n5264081466258738|10/2028|467|MASTERCARD|...`}
              className="w-full h-48 px-3 py-2 rounded-lg bg-slate-800 text-slate-100 text-xs font-mono border border-slate-700 focus:border-indigo-500 outline-none resize-none"
              spellCheck={false}
            />
            <div className="grid grid-cols-2 gap-3 mt-3">
              {/* 渠道 */}
              <div className="relative">
                <label className="text-[11px] text-slate-400 block mb-1">渠道 (可选)</label>
                <input value={importChannel} onChange={e => { setImportChannel(e.target.value); setShowChannelSuggest(true); }}
                  onFocus={() => setShowChannelSuggest(true)} onBlur={() => setTimeout(() => setShowChannelSuggest(false), 200)}
                  placeholder="如 pingcheck.cc" className="w-full px-2 py-1.5 rounded bg-slate-800 text-slate-100 text-xs border border-slate-700 focus:border-indigo-500 outline-none" />
                {showChannelSuggest && existingChannels.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg overflow-hidden z-10 max-h-32 overflow-y-auto">
                    {existingChannels.filter(c => c.includes(importChannel)).map(c => (
                      <div key={c} onMouseDown={() => { setImportChannel(c); setShowChannelSuggest(false); }} className="px-2 py-1 text-xs text-slate-200 hover:bg-slate-700 cursor-pointer">{c}</div>
                    ))}
                  </div>
                )}
              </div>
              {/* 标签 */}
              <div className="relative">
                <label className="text-[11px] text-slate-400 block mb-1">标签 (可选, 多标签用逗号隔开)</label>
                <input value={importTags} onChange={e => { setImportTags(e.target.value); setShowTagSuggest(true); }}
                  onFocus={() => setShowTagSuggest(true)} onBlur={() => setTimeout(() => setShowTagSuggest(false), 200)}
                  placeholder="如 VISA,DEBIT" className="w-full px-2 py-1.5 rounded bg-slate-800 text-slate-100 text-xs border border-slate-700 focus:border-indigo-500 outline-none" />
                {showTagSuggest && existingTags.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg overflow-hidden z-10 max-h-32 overflow-y-auto">
                    {existingTags.filter(t => t.includes(importTags)).map(t => (
                      <div key={t} onMouseDown={() => { const cur = importTags.split(/[,，\s]+/).filter(Boolean).slice(0,-1).concat(t).join(', '); setImportTags(cur); setShowTagSuggest(false); }} className="px-2 py-1 text-xs text-slate-200 hover:bg-slate-700 cursor-pointer">{t}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs text-slate-500">自动识别时间戳标记</span>
              <div className="flex gap-2">
                <button onClick={() => setShowImport(false)} className="px-3 py-1.5 rounded-lg text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 transition-all">取消</button>
                <button onClick={handleImportCards} disabled={importing} className="px-3 py-1.5 rounded-lg text-xs bg-emerald-600 text-white hover:bg-emerald-500 transition-all disabled:opacity-50">
                  {importing ? '导入中...' : '确认导入'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 外部卡库视图 */}
      {activeView === 'remote' && (
        <>
          <div className="flex items-center gap-3 mb-3">
            <select value={perPage} onChange={e=>{ setPerPage(Number(e.target.value)); setPage(1) }} className="px-2 py-2 rounded bg-slate-800 text-slate-100 text-sm">
              <option value={15}>15</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <div className="flex items-center gap-2">
              <button onClick={()=> setPage(p=> Math.max(1, p-1))} className="px-2 py-1 rounded bg-slate-800 text-slate-100 text-xs">上一页</button>
              <button onClick={()=> setPage(p=> p+1)} className="px-2 py-1 rounded bg-slate-800 text-slate-100 text-xs">下一页</button>
              <span className="text-xs text-slate-400">{getToken()? '令牌已设置' : '令牌缺失'}</span>
            </div>
          </div>
          {metaInfo && metaInfo.pagination && (
            <div className="text-xs text-slate-400 mb-2">共 {Number(metaInfo.pagination.total||0)} 项，当前 {Number(metaInfo.pagination.count||0)} 条，页 {Number(metaInfo.pagination.current_page||page)} / {Number(metaInfo.pagination.total_pages||1)}，每页 {Number(metaInfo.pagination.per_page||perPage)}</div>
          )}
          {error && <div className="text-rose-400 text-sm mb-2">{error}</div>}
          {loading ? (
            <div className="text-slate-300 text-center py-8">加载中...</div>
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-auto">
              <table className="min-w-full text-sm text-slate-200">
                <thead className="bg-slate-800 text-slate-300">
                  <tr>
                    <th className="px-3 py-2 text-left">卡ID</th>
                    <th className="px-3 py-2 text-left">别名</th>
                    <th className="px-3 py-2 text-left">卡末四位</th>
                    <th className="px-3 py-2 text-left">状态</th>
                    <th className="px-3 py-2 text-left">币种</th>
                  </tr>
                </thead>
                <tbody>
                  {list.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-slate-500">无卡片数据</td>
                    </tr>
                  ) : list.map((c:any, idx:number)=> (
                    <tr key={String(c.card_id||c.id||idx)} className="border-t border-slate-800">
                      <td className="px-3 py-2">{String(c.card_id || c.id || '')}</td>
                      <td className="px-3 py-2">{String(c.alias || c.name || '')}</td>
                      <td className="px-3 py-2">{String(c.last_four_digits || c.card_last4 || '')}</td>
                      <td className="px-3 py-2">{String(c.status || '')}</td>
                      <td className="px-3 py-2">{String((c.currency||'')||'')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* 本地卡片视图 */}
      {activeView === 'local' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <button onClick={() => setLocalViewMode('grid')} className={`px-2.5 py-1.5 rounded-lg text-xs transition-all ${localViewMode === 'grid' ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-600/30' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
                <Grid3X3 className="w-3.5 h-3.5 inline mr-1" />卡片
              </button>
              <button onClick={() => setLocalViewMode('list')} className={`px-2.5 py-1.5 rounded-lg text-xs transition-all ${localViewMode === 'list' ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-600/30' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
                <List className="w-3.5 h-3.5 inline mr-1" />列表
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowImport(true)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-emerald-800/30 text-emerald-300 hover:bg-emerald-700/50 transition-all">
                <Upload className="w-3.5 h-3.5" />
                导入
              </button>
              <button onClick={() => window.dispatchEvent(new Event('cards-refresh'))} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all">
                <RefreshCw className="w-3.5 h-3.5" />
                刷新
              </button>
              {selectedCards.size > 0 && (
                <button onClick={batchDeleteCards} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-rose-600/30 text-rose-300 hover:bg-rose-600/50 transition-all">
                  <Trash2 className="w-3.5 h-3.5" />
                  删除 ({selectedCards.size})
                </button>
              )}
              <button onClick={clearAllLocalData} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-rose-800/30 text-rose-300 hover:bg-rose-700/50 transition-all">
                <AlertTriangle className="w-3.5 h-3.5" />
                清除旧数据
              </button>
              <span className="text-xs text-slate-500">{showFullNumbers ? '完整卡号可见' : '卡号已隐藏'} · 共 {localCards.length} 张</span>
            </div>
          </div>

          {localCards.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="mb-3">暂无本地卡片</p>
              <button onClick={openAddForm} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs transition-all">
                <Plus className="w-3.5 h-3.5" /> 新增卡片
              </button>
            </div>
          ) : localViewMode === 'grid' ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {localCards.map((c: any) => (
                <div key={c.id} className="rounded-xl border border-slate-800 bg-slate-950 p-4 relative group">
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                    <button onClick={() => openEditForm(c)} className="text-indigo-400 hover:text-indigo-300">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => deleteLocalCard(c.id)} className="text-rose-400 hover:text-rose-300">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="absolute top-2 left-2">
                    <input type="checkbox" checked={selectedCards.has(c.id)} onChange={() => toggleCardSelect(c.id)} className="w-3.5 h-3.5 accent-indigo-500 cursor-pointer" />
                  </div>
                  <div className="flex items-center gap-2 mb-3 pl-5">
                    <CreditCard className="w-5 h-5 text-indigo-400" />
                    <span className="text-xs text-slate-500">{c.brand || 'Card'}</span>
                    <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${
                      c.bindStatus === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                      c.bindStatus === 'failed' ? 'bg-rose-500/20 text-rose-400' :
                      c.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                    }`}>
                      {c.bindStatus === 'success' ? '绑定成功' :
                       c.bindStatus === 'failed' ? '绑定失败' :
                       c.status === 'active' ? '已激活' : '待验证'}
                    </span>
                  </div>
                  {/* 🚀 卡号显示：完整或掩码 */}
                  <div className={`text-lg tracking-widest font-mono ${showFullNumbers ? 'text-emerald-300' : 'text-white'}`}>
                    {getCardDisplay(c)}
                  </div>
                  {showFullNumbers && c.cvv && <div className="text-xs text-slate-400 mt-0.5 font-mono">CVV: {c.cvv}</div>}
                  {c.exp_month && c.exp_year && (
                    <div className="text-xs text-slate-400 mt-1">有效期: {c.exp_month}/{c.exp_year}</div>
                  )}
                  {c.holder && <div className="text-xs text-slate-500 mt-0.5">{c.holder}</div>}
                  {c.alias && <div className="text-xs text-slate-500 mt-0.5">{c.alias}</div>}
                  <div className="mt-2 space-y-1 text-[11px] text-slate-500">
                    {c.zip && <div><Hash className="w-3 h-3 inline mr-1" />邮编: {c.zip}</div>}
                    {c.channel && <div><Globe className="w-3 h-3 inline mr-1" />渠道: {c.channel}</div>}
                    {c.tags && Array.isArray(c.tags) && c.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {c.tags.map((tag: string, i: number) => (
                          <span key={i} className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400"><Tag className="w-2.5 h-2.5 inline mr-0.5" />{tag}</span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-1"><Clock className="w-3 h-3" />{c.savedAt ? new Date(c.savedAt).toLocaleString() : '—'}</div>
                    <div className="text-[10px] text-slate-600 font-mono">ID: {String(c.id).slice(-12)}</div>
                    {c.bindStatus === 'failed' && c.bindMessage && (
                      <div className="text-[10px] text-rose-400/80 mt-1 border border-rose-800/30 bg-rose-950/30 rounded px-1.5 py-1">{c.bindMessage.substring(0, 80)}</div>
                    )}
                    {c.bindStatus === 'failed' && (
                      <button onClick={() => retryBindCard(c)} disabled={retrying} className="mt-1 w-full flex items-center justify-center gap-1 px-2 py-1 rounded bg-rose-600/20 text-rose-400 hover:bg-rose-600/40 text-[11px] transition-all disabled:opacity-50">
                        <RefreshCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
                        {retrying ? '重试中...' : '重试绑卡'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-auto">
              <table className="min-w-full text-sm text-slate-200">
                <thead className="bg-slate-800 text-slate-300">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] w-8">
                      <input type="checkbox" checked={selectedCards.size === localCards.length && localCards.length > 0} onChange={toggleSelectAll} className="w-3 h-3 accent-indigo-500 cursor-pointer" />
                    </th>
                    <th className="px-3 py-2 text-left text-[11px]">ID</th>
                    <th className="px-3 py-2 text-left text-[11px]">保存时间</th>
                    <th className="px-3 py-2 text-left text-[11px]">卡号</th>
                    <th className="px-3 py-2 text-left text-[11px]">CVV</th>
                    <th className="px-3 py-2 text-left text-[11px]">持卡人</th>
                    <th className="px-3 py-2 text-left text-[11px]">品牌</th>
                    <th className="px-3 py-2 text-left text-[11px]">渠道</th>
                    <th className="px-3 py-2 text-left text-[11px]">有效期</th>
                    <th className="px-3 py-2 text-left text-[11px]">账单地址</th>
                    <th className="px-3 py-2 text-left text-[11px]">状态</th>
                    <th className="px-3 py-2 text-left text-[11px]">标签</th>
                    <th className="px-3 py-2 text-left text-[11px]">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {localCards.map((c: any, idx: number) => (
                    <tr key={c.id} className="border-t border-slate-800">
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selectedCards.has(c.id)} onChange={() => toggleCardSelect(c.id)} className="w-3 h-3 accent-indigo-500 cursor-pointer" />
                      </td>
                      {/* 🚀 ID：从 1 开始递增 */}
                      <td className="px-3 py-2 text-xs text-slate-400 font-mono">{idx + 1}</td>
                      {/* 保存时间 */}
                      <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{c.savedAt ? new Date(c.savedAt).toLocaleString() : '—'}</td>
                      {/* 卡号 */}
                      <td className={`px-3 py-2 font-mono text-xs ${showFullNumbers ? 'text-emerald-300' : ''}`}>{getCardDisplay(c)}</td>
                      {/* CVV */}
                      <td className="px-3 py-2 text-xs font-mono">{showFullNumbers && c.cvv ? c.cvv : c.cvv ? '***' : '—'}</td>
                      {/* 持卡人 */}
                      <td className="px-3 py-2 text-xs">{c.holder || '—'}</td>
                      {/* 品牌 */}
                      <td className="px-3 py-2 text-xs">{c.brand || '—'}</td>
                      {/* 渠道 */}
                      <td className="px-3 py-2 text-xs text-slate-400">{c.channel || '—'}</td>
                      {/* 有效期 */}
                      <td className="px-3 py-2 text-xs">{c.exp_month && c.exp_year ? `${c.exp_month}/${c.exp_year}` : '—'}</td>
                      {/* 账单地址 */}
                      <td className="px-3 py-2 max-w-[100px] truncate text-xs text-slate-400">
                        {(() => {
                          try {
                            const addr = typeof c.billing_address === 'string' ? JSON.parse(c.billing_address) : (c.billing_address || {});
                            return String(addr.address || addr.city || addr.line1 || '');
                          } catch {
                            return typeof c.billing_address === 'string' && c.billing_address.length > 3 ? c.billing_address.slice(0, 20) : (c.billing_address || '—');
                          }
                        })() || '—'}
                      </td>
                      {/* 状态 */}
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-0.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full inline-block w-fit ${
                            c.bindStatus === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                            c.bindStatus === 'failed' ? 'bg-rose-500/20 text-rose-400' :
                            c.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                          }`}>
                            {c.bindStatus === 'success' ? '绑定成功' :
                             c.bindStatus === 'failed' ? '绑定失败' :
                             c.status === 'active' ? '已激活' : '待验证'}
                          </span>
                          {c.bindStatus === 'failed' && c.bindMessage && (
                            <span className="text-[9px] text-rose-400/70 max-w-[120px] truncate" title={c.bindMessage}>{c.bindMessage.substring(0, 30)}</span>
                          )}
                        </div>
                      </td>
                      {/* 标签 */}
                      <td className="px-3 py-2">
                        {c.tags && Array.isArray(c.tags) && c.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {c.tags.map((tag: string, i: number) => (
                              <span key={i} className="px-1 py-0.5 rounded bg-slate-800 text-[9px] text-slate-400">{tag}</span>
                            ))}
                          </div>
                        ) : '—'}
                      </td>
                      {/* 操作 */}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <button onClick={() => openEditForm(c)} className="px-2 py-1 rounded bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/40 text-xs transition-all">
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button onClick={() => deleteLocalCard(c.id, c.card_last4 || c.last4)} className="px-2 py-1 rounded bg-rose-600/20 text-rose-400 hover:bg-rose-600/40 text-xs transition-all">
                            <Trash2 className="w-3 h-3" />
                          </button>
                          {c.bindStatus === 'failed' && (
                            <button onClick={() => retryBindCard(c)} disabled={retrying} className="px-2 py-1 rounded bg-rose-600/30 text-rose-400 hover:bg-rose-600/50 text-[10px] transition-all disabled:opacity-50 flex items-center gap-1">
                              <RefreshCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
                              {retrying ? '...' : '重试'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 工具函数
function detectCardBrand(number: string): string {
  const n = number.replace(/\D/g, '');
  if (/^4/.test(n)) return 'Visa';
  if (/^5[1-5]/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'Amex';
  if (/^6011|^65/.test(n)) return 'Discover';
  if (/^62/.test(n)) return 'UnionPay';
  if (/^35[2-8]/.test(n)) return 'JCB';
  return 'Card';
}
