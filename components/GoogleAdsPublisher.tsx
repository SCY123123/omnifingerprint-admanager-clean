import React, { useState, useEffect, useCallback } from 'react';
import { X, Plus, Copy, Trash2, Send, Upload, CheckSquare, Square, Globe, Search, Settings } from 'lucide-react';
const uid = () => Math.random().toString(36).slice(2, 8);

// ===== 类型定义 =====
export interface GoogleAdPublishData {
  publishMethod: 'api' | 'puppeteer';
  launchBrowser: boolean;
  campaignTree: GoogleCampaignData[];
  customerId?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  developerToken?: string;
}

export interface GoogleCampaignData {
  id: string;
  name: string;
  type: 'SEARCH' | 'DISPLAY' | 'VIDEO' | 'PERFORMANCE_MAX' | 'SHOPPING';
  budget: string;
  budgetType: 'DAILY' | 'LIFETIME';
  biddingStrategy: 'MANUAL_CPC' | 'TARGET_CPA' | 'TARGET_ROAS' | 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS' | 'ENHANCED_CPC' | '';
  targetCpa?: string;
  targetRoas?: string;
  status: 'ACTIVE' | 'PAUSED';
  startDate: string;
  endDate?: string;
  networkSetting: 'SEARCH' | 'DISPLAY' | 'SEARCH_DISPLAY' | 'YOUTUBE';
  languages?: string;
  locations?: string;
  adGroups: GoogleAdGroupData[];
}

export interface GoogleAdGroupData {
  id: string;
  name: string;
  type: 'SEARCH' | 'DISPLAY' | 'VIDEO';
  status: 'ACTIVE' | 'PAUSED';
  cpcBid?: string;
  cpmBid?: string;
  cpaBid?: string;
  keywords: GoogleKeywordData[];
  ads: GoogleAdData[];
}

export interface GoogleKeywordData {
  id?: string;
  text: string;
  matchType: 'EXACT' | 'PHRASE' | 'BROAD';
}

export interface GoogleAdData {
  id: string;
  name: string;
  adType: 'RESPONSIVE_SEARCH_AD' | 'EXPANDED_TEXT_AD' | 'RESPONSIVE_DISPLAY_AD' | 'VIDEO_AD' | 'DISPLAY_AD';
  headlines: string[];
  descriptions: string[];
  finalUrl: string;
  finalMobileUrl?: string;
  path1?: string;
  path2?: string;
  displayUrl?: string;
  businessName?: string;
  ctaText?: string;
  imageHash?: string;
  videoId?: string;
  status: 'ACTIVE' | 'PAUSED';
  mediaFiles?: File[];
}

// ===== 默认值 =====
function createDefaultAd(): GoogleAdData {
  return {
    id: uid(), name: '广告 1', adType: 'RESPONSIVE_SEARCH_AD',
    headlines: ['标题 1', '标题 2', '标题 3'],
    descriptions: ['描述内容'],
    finalUrl: 'https://example.com',
    status: 'PAUSED'
  };
}

function createDefaultKeyword(): GoogleKeywordData {
  return { text: '', matchType: 'PHRASE' };
}

function createDefaultAdGroup(name?: string): GoogleAdGroupData {
  return {
    id: uid(), name: name || '广告组 1', type: 'SEARCH', status: 'PAUSED',
    keywords: [createDefaultKeyword()],
    ads: [createDefaultAd()]
  };
}

function createDefaultCampaign(name?: string): GoogleCampaignData {
  return {
    id: uid(), name: name || '广告系列 1', type: 'SEARCH',
    budget: '100', budgetType: 'DAILY',
    biddingStrategy: 'MANUAL_CPC', status: 'PAUSED',
    startDate: new Date().toISOString().slice(0,10),
    networkSetting: 'SEARCH',
    adGroups: [createDefaultAdGroup('广告组 1')]
  };
}

// ===== 语言下拉列表 =====
const GOOGLE_ADS_LANGUAGES = [
  { code: 'zh-CN', name: '中文(简体)' }, { code: 'zh-TW', name: '中文(繁体)' },
  { code: 'en', name: '英语' }, { code: 'ja', name: '日语' },
  { code: 'ko', name: '韩语' }, { code: 'de', name: '德语' },
  { code: 'fr', name: '法语' }, { code: 'es', name: '西班牙语' },
  { code: 'pt', name: '葡萄牙语' }, { code: 'ru', name: '俄语' },
  { code: 'vi', name: '越南语' }, { code: 'th', name: '泰语' },
  { code: 'id', name: '印尼语' }, { code: 'ms', name: '马来语' },
  { code: 'ar', name: '阿拉伯语' }, { code: 'hi', name: '印地语' }
];

// ===== 匹配类型 =====
const MATCH_TYPES = [
  { value: 'EXACT', label: '完全匹配', desc: '[关键词]' },
  { value: 'PHRASE', label: '词组匹配', desc: '"关键词"' },
  { value: 'BROAD', label: '广泛匹配', desc: '关键词' }
];

const AD_TYPES = [
  { value: 'RESPONSIVE_SEARCH_AD', label: '自适应搜索广告' },
  { value: 'EXPANDED_TEXT_AD', label: '加大型文字广告' },
  { value: 'RESPONSIVE_DISPLAY_AD', label: '自适应展示广告' },
  { value: 'DISPLAY_AD', label: '展示广告' },
  { value: 'VIDEO_AD', label: '视频广告' }
];

interface GoogleAdsPublisherProps {
  onClose: () => void;
  onConfirm: (data: GoogleAdPublishData) => Promise<void>;
  profileIds?: string[];
}

export default function GoogleAdsPublisher({ onClose, onConfirm, profileIds }: GoogleAdsPublisherProps) {
  const [tree, setTree] = useState<GoogleCampaignData[]>([createDefaultCampaign()]);
  const [selectedCampaignIdx, setSelectedCampaignIdx] = useState(0);
  const [selectedAdGroupIdx, setSelectedAdGroupIdx] = useState(0);
  const [selectedAdIdx, setSelectedAdIdx] = useState(0);
  const [selectedType, setSelectedType] = useState<'campaign' | 'adgroup' | 'ad'>('campaign');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [publishMethod, setPublishMethod] = useState<'api' | 'puppeteer'>('api');
  const [launchBrowser, setLaunchBrowser] = useState(true);

  const campaign = tree[selectedCampaignIdx] || tree[0];
  const adGroup = campaign?.adGroups?.[selectedAdGroupIdx];
  const ad = adGroup?.ads?.[selectedAdIdx];

  // ===== 更新函数 =====
  const updateCampaign = useCallback((idx: number | undefined, updates: Partial<GoogleCampaignData>) => {
    setTree(prev => { const n = [...prev]; const i = idx ?? selectedCampaignIdx; if (n[i]) { n[i] = { ...n[i], ...updates }; } return n; });
  }, [selectedCampaignIdx]);

  const updateAdGroup = useCallback((ci: number, gi: number, updates: Partial<GoogleAdGroupData>) => {
    setTree(prev => { const n = [...prev]; const ags = [...(n[ci]?.adGroups || [])]; if (ags[gi]) { ags[gi] = { ...ags[gi], ...updates }; } n[ci] = { ...n[ci], adGroups: ags }; return n; });
  }, []);

  const updateAd = useCallback((ci: number, gi: number, ai: number, updates: Partial<GoogleAdData>) => {
    setTree(prev => { const n = [...prev]; const ags = [...(n[ci]?.adGroups || [])]; const ads = [...(ags[gi]?.ads || [])]; if (ads[ai]) { ads[ai] = { ...ads[ai], ...updates }; } ags[gi] = { ...ags[gi], ads }; n[ci] = { ...n[ci], adGroups: ags }; return n; });
  }, []);

  const updateKeyword = useCallback((ci: number, gi: number, ki: number, updates: Partial<GoogleKeywordData>) => {
    setTree(prev => { const n = [...prev]; const ags = [...(n[ci]?.adGroups || [])]; const kws = [...(ags[gi]?.keywords || [])]; if (kws[ki]) { kws[ki] = { ...kws[ki], ...updates }; } ags[gi] = { ...ags[gi], keywords: kws }; n[ci] = { ...n[ci], adGroups: ags }; return n; });
  }, []);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm({ publishMethod, launchBrowser, campaignTree: tree, customerId: '', clientId: '', clientSecret: '', refreshToken: '', developerToken: '' });
    } catch (e) { console.error(e); }
    setIsSubmitting(false);
  };

  // ===== 渲染 =====
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-[95vw] max-w-[1600px] overflow-hidden shadow-2xl flex flex-col h-[95vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h2 className="font-bold text-white">Google Ads 批量发布广告</h2>
          <div className="flex items-center gap-2">
            <select value={publishMethod} onChange={e => setPublishMethod(e.target.value as any)} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white">
              <option value="api">API 模式</option>
              <option value="puppeteer">Puppeteer 模式</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-slate-400"><input type="checkbox" checked={launchBrowser} onChange={e => setLaunchBrowser(e.target.checked)} className="w-3 h-3 rounded border-slate-700 bg-slate-800 text-indigo-600" />启动浏览器</label>
            <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded-lg"><X className="w-4 h-4 text-slate-400" /></button>
          </div>
        </div>
        <div className="flex flex-1 overflow-hidden">
          {/* 左侧树 */}
          <div className="w-72 bg-slate-950 border-r border-slate-800 overflow-y-auto p-3 space-y-2">
            <div className="flex items-center justify-between mb-2"><span className="text-xs font-bold text-slate-400 uppercase">广告系列</span>
              <button onClick={() => { const c = createDefaultCampaign(); setTree(prev => [...prev, c]); setSelectedCampaignIdx(tree.length); setSelectedType('campaign'); }} className="text-[9px] text-indigo-500/50 hover:text-indigo-400"><Plus className="w-3 h-3 inline" /> 系列</button>
            </div>
            {tree.map((c, ci) => (
              <div key={c.id}>
                <div onClick={() => { setSelectedCampaignIdx(ci); setSelectedAdGroupIdx(0); setSelectedAdIdx(0); setSelectedType('campaign'); }} className={`flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all group ${selectedType === 'campaign' && selectedCampaignIdx === ci ? 'bg-indigo-600/15 border border-indigo-500/30' : 'hover:bg-slate-800/50 border border-transparent'}`}>
                  <div className="w-5 h-5 rounded bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-[9px] text-indigo-400 font-bold shrink-0">{ci + 1}</div>
                  <span className="text-xs text-slate-300 truncate flex-1">{c.name || '广告系列'}</span>
                  <span className="text-[8px] text-slate-600 bg-slate-800 px-1.5 py-0.5 rounded">{c.type}</span>
                  {tree.length > 1 && <button onClick={(ev) => { ev.stopPropagation(); setTree(prev => prev.filter((_, i) => i !== ci)); if (selectedCampaignIdx >= ci && selectedCampaignIdx > 0) setSelectedCampaignIdx(prev => prev - 1); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-rose-400"><Trash2 className="w-3 h-3" /></button>}
                  <button onClick={(ev) => { ev.stopPropagation(); const qty = parseInt(prompt('复制数量:', '1') || '1') || 1; setTree(prev => { const n = [...prev]; for (let i = 0; i < qty; i++) { n.splice(ci + 1 + i, 0, { ...JSON.parse(JSON.stringify(c)), id: uid(), name: c.name + '_' + (i + 1) }); } return n; }); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-emerald-400"><Copy className="w-3 h-3" /></button>
                </div>
                <div className="ml-5 mt-0.5 space-y-0.5">
                  {c.adGroups.map((ag, gi) => (
                    <div key={ag.id}>
                      <div onClick={() => { setSelectedCampaignIdx(ci); setSelectedAdGroupIdx(gi); setSelectedAdIdx(0); setSelectedType('adgroup'); }} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-all group ${selectedType === 'adgroup' && selectedCampaignIdx === ci && selectedAdGroupIdx === gi ? 'bg-teal-600/15 border border-teal-500/30' : 'hover:bg-slate-800/50 border border-transparent'}`}>
                        <span className="text-[10px] text-slate-500 truncate flex-1">{ag.name || '广告组'}</span>
                        {c.adGroups.length > 1 && <button onClick={(ev) => { ev.stopPropagation(); updateCampaign(ci, { adGroups: c.adGroups.filter((_, i) => i !== gi) }); if (selectedAdGroupIdx >= gi && selectedAdGroupIdx > 0) setSelectedAdGroupIdx(prev => prev - 1); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-rose-400"><Trash2 className="w-[11px] h-[11px]" /></button>}
                        <button onClick={(ev) => { ev.stopPropagation(); const qty = parseInt(prompt('复制数量:', '1') || '1') || 1; setTree(prev => { const n = [...prev]; const ags = [...n[ci].adGroups]; for (let i = 0; i < qty; i++) { ags.splice(gi + 1 + i, 0, { ...JSON.parse(JSON.stringify(ag)), id: uid(), name: ag.name + '_' + (i + 1) }); } n[ci] = { ...n[ci], adGroups: ags }; return n; }); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-emerald-400"><Copy className="w-[11px] h-[11px]" /></button>
                      </div>
                      <div className="ml-4 mt-0.5 space-y-0.5">
                        {ag.ads.map((adItem, ai) => (
                          <div key={adItem.id} onClick={() => { setSelectedCampaignIdx(ci); setSelectedAdGroupIdx(gi); setSelectedAdIdx(ai); setSelectedType('ad'); }} className={`flex items-center gap-2 px-2.5 py-1 rounded-lg cursor-pointer transition-all group ${selectedType === 'ad' && selectedCampaignIdx === ci && selectedAdGroupIdx === gi && selectedAdIdx === ai ? 'bg-amber-600/15 border border-amber-500/30' : 'hover:bg-slate-800/50 border border-transparent'}`}>
                            <span className="text-[10px] text-slate-500 truncate flex-1">{adItem.name || '广告'}</span>
                            {ag.ads.length > 1 && <button onClick={(ev) => { ev.stopPropagation(); updateAdGroup(ci, gi, { ads: ag.ads.filter((_, i) => i !== ai) }); if (selectedAdIdx >= ai && selectedAdIdx > 0) setSelectedAdIdx(prev => prev - 1); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-rose-400"><Trash2 className="w-[10px] h-[10px]" /></button>}
                            <button onClick={(ev) => { ev.stopPropagation(); const qty = parseInt(prompt('复制数量:', '1') || '1') || 1; setTree(prev => { const n = [...prev]; const ags = [...n[ci].adGroups]; const ads = [...ags[gi].ads]; for (let i = 0; i < qty; i++) { ads.splice(ai + 1 + i, 0, { ...JSON.parse(JSON.stringify(adItem)), id: uid(), name: adItem.name + '_' + (i + 1) }); } ags[gi] = { ...ags[gi], ads }; n[ci] = { ...n[ci], adGroups: ags }; return n; }); }} className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-emerald-400"><Copy className="w-[10px] h-[10px]" /></button>
                          </div>
                        ))}
                        <button onClick={() => { updateAdGroup(ci, gi, { ads: [...ag.ads, createDefaultAd()] }); setSelectedAdIdx(ag.ads.length); setSelectedType('ad'); }} className="text-[8px] text-teal-500/40 hover:text-teal-400 ml-5 py-0.5">+ 广告</button>
                      </div>
                    </div>
                  ))}
                  <button onClick={() => { updateCampaign(ci, { adGroups: [...c.adGroups, createDefaultAdGroup('广告组 ' + (c.adGroups.length + 1))] }); setSelectedAdGroupIdx(c.adGroups.length); setSelectedType('adgroup'); }} className="text-[9px] text-indigo-500/50 hover:text-indigo-400 ml-5 py-0.5">+ 广告组</button>
                </div>
              </div>
            ))}
          </div>
          {/* 右侧编辑面板 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {selectedType === 'campaign' && campaign && (
              <div className="space-y-6">
                <h3 className="text-sm font-bold text-white mb-3">🎯 广告系列设置</h3>
                <div className="grid grid-cols-4 gap-4">
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">系列名称</label><input value={campaign.name} onChange={e => updateCampaign(selectedCampaignIdx, { name: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告系列类型</label><select value={campaign.type} onChange={e => updateCampaign(selectedCampaignIdx, { type: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="SEARCH">搜索广告</option><option value="DISPLAY">展示广告</option><option value="VIDEO">视频广告</option><option value="PERFORMANCE_MAX">效果最大化</option><option value="SHOPPING">购物广告</option></select></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">预算</label><div className="flex gap-2"><input type="number" value={campaign.budget} onChange={e => updateCampaign(selectedCampaignIdx, { budget: e.target.value })} className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /><select value={campaign.budgetType} onChange={e => updateCampaign(selectedCampaignIdx, { budgetType: e.target.value as any })} className="w-24 bg-slate-950 border border-slate-800 rounded-xl px-2 py-2 text-sm text-white"><option value="DAILY">每日</option><option value="LIFETIME">总预算</option></select></div></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">出价策略</label><select value={campaign.biddingStrategy} onChange={e => updateCampaign(selectedCampaignIdx, { biddingStrategy: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="">默认</option><option value="MANUAL_CPC">手动 CPC</option><option value="ENHANCED_CPC">增强型 CPC</option><option value="TARGET_CPA">目标 CPA</option><option value="TARGET_ROAS">目标 ROAS</option><option value="MAXIMIZE_CLICKS">争取点击量最大化</option><option value="MAXIMIZE_CONVERSIONS">争取转化量最大化</option></select></div>
                </div>
                <div className="grid grid-cols-4 gap-4">
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">网络设置</label><select value={campaign.networkSetting} onChange={e => updateCampaign(selectedCampaignIdx, { networkSetting: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="SEARCH">Google 搜索</option><option value="SEARCH_DISPLAY">搜索+展示网络</option><option value="DISPLAY">展示网络</option><option value="YOUTUBE">YouTube</option></select></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">开始日期</label><input type="date" value={campaign.startDate} onChange={e => updateCampaign(selectedCampaignIdx, { startDate: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white [color-scheme:dark]" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">结束日期</label><input type="date" value={campaign.endDate || ''} onChange={e => updateCampaign(selectedCampaignIdx, { endDate: e.target.value || undefined })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white [color-scheme:dark]" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">状态</label><select value={campaign.status} onChange={e => updateCampaign(selectedCampaignIdx, { status: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="ACTIVE">启用</option><option value="PAUSED">暂停</option></select></div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {campaign.biddingStrategy === 'TARGET_CPA' && <div className="space-y-2"><label className="text-xs font-medium text-slate-400">目标 CPA (USD)</label><input type="number" value={campaign.targetCpa || ''} onChange={e => updateCampaign(selectedCampaignIdx, { targetCpa: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>}
                  {campaign.biddingStrategy === 'TARGET_ROAS' && <div className="space-y-2"><label className="text-xs font-medium text-slate-400">目标 ROAS (%)</label><input type="number" value={campaign.targetRoas || ''} onChange={e => updateCampaign(selectedCampaignIdx, { targetRoas: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>}
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">语言</label><div className="flex flex-wrap gap-1 p-2 bg-slate-950 border border-slate-800 rounded-xl min-h-[38px]">{campaign.languages ? campaign.languages.split(',').filter(Boolean).map(lc => { const l = GOOGLE_ADS_LANGUAGES.find(x => x.code === lc); return l ? <span key={lc} className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-600/20 border border-indigo-500/30 rounded text-[10px] text-indigo-300">{l.name}<button onClick={() => updateCampaign(selectedCampaignIdx, { languages: campaign.languages.split(',').filter(x => x !== lc).join(',') })} className="text-indigo-400 hover:text-indigo-200 ml-0.5">✕</button></span> : null; }) : <span className="text-[10px] text-slate-600 italic">未选择</span>}</div><select onChange={e => { const v = e.target.value; if (!v) return; const cur = (campaign.languages||'').split(',').filter(Boolean); if (!cur.includes(v)) { cur.push(v); updateCampaign(selectedCampaignIdx, { languages: cur.join(',') }); } }} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-[9px] text-white"><option value="">+ 添加语言</option>{GOOGLE_ADS_LANGUAGES.filter(l => !(campaign.languages||'').split(',').includes(l.code)).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}</select></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">地理位置 (用逗号分隔)</label><input type="text" value={campaign.locations || ''} onChange={e => updateCampaign(selectedCampaignIdx, { locations: e.target.value })} placeholder="US, GB, CA" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                </div>
              </div>
            )}
            {selectedType === 'adgroup' && adGroup && campaign && (
              <div className="space-y-6">
                <h3 className="text-sm font-bold text-white mb-3">📁 广告组设置</h3>
                <div className="grid grid-cols-4 gap-4">
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告组名称</label><input value={adGroup.name} onChange={e => updateAdGroup(selectedCampaignIdx, selectedAdGroupIdx, { name: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">类型</label><select value={adGroup.type} onChange={e => updateAdGroup(selectedCampaignIdx, selectedAdGroupIdx, { type: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="SEARCH">搜索</option><option value="DISPLAY">展示</option><option value="VIDEO">视频</option></select></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">CPC 出价 (USD)</label><input type="number" value={adGroup.cpcBid || ''} onChange={e => updateAdGroup(selectedCampaignIdx, selectedAdGroupIdx, { cpcBid: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">状态</label><select value={adGroup.status} onChange={e => updateAdGroup(selectedCampaignIdx, selectedAdGroupIdx, { status: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="ACTIVE">启用</option><option value="PAUSED">暂停</option></select></div>
                </div>
                {/* 关键词 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between"><label className="text-xs font-medium text-slate-400">关键词</label><button onClick={() => updateAdGroup(selectedCampaignIdx, selectedAdGroupIdx, { keywords: [...adGroup.keywords, createDefaultKeyword()] })} className="text-[9px] text-indigo-500/40 hover:text-indigo-400">+ 添加关键词</button></div>
                  <div className="grid grid-cols-[1fr_100px] gap-2">{adGroup.keywords.map((kw, ki) => (<React.Fragment key={ki}>
                    <div className="flex gap-1"><input value={kw.text} onChange={e => updateKeyword(selectedCampaignIdx, selectedAdGroupIdx, ki, { text: e.target.value })} placeholder="输入关键词" className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white" /><button onClick={() => updateAdGroup(selectedCampaignIdx, selectedAdGroupIdx, { keywords: adGroup.keywords.filter((_, i) => i !== ki) })} className="text-slate-600 hover:text-rose-400"><Trash2 className="w-3 h-3" /></button></div>
                    <select value={kw.matchType} onChange={e => updateKeyword(selectedCampaignIdx, selectedAdGroupIdx, ki, { matchType: e.target.value as any })} className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[10px] text-white"><option value="EXACT">[完全]</option><option value="PHRASE">"词组"</option><option value="BROAD">广泛</option></select>
                  </React.Fragment>))}</div>
                </div>
                {/* 广告列表预览 */}
                <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告数: {adGroup.ads.length}</label></div>
              </div>
            )}
            {selectedType === 'ad' && ad && adGroup && (
              <div className="space-y-6">
                <h3 className="text-sm font-bold text-white mb-3">🎨 广告设置</h3>
                <div className="grid grid-cols-4 gap-4">
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告名称</label><input value={ad.name} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { name: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">广告类型</label><select value={ad.adType} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { adType: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white">{AD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">最终到达网址</label><input value={ad.finalUrl} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { finalUrl: e.target.value })} placeholder="https://" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">状态</label><select value={ad.status} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { status: e.target.value as any })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"><option value="ACTIVE">启用</option><option value="PAUSED">暂停</option></select></div>
                </div>
                {/* 标题 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between"><label className="text-xs font-medium text-slate-400">标题 ({ad.adType === 'RESPONSIVE_SEARCH_AD' ? '最多15个' : ad.adType === 'RESPONSIVE_DISPLAY_AD' ? '最多5个' : '2个'})</label><button onClick={() => { if (ad.headlines.length < 15) updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { headlines: [...ad.headlines, ''] }); }} className="text-[9px] text-indigo-500/40 hover:text-indigo-400">+</button></div>
                  {ad.headlines.map((h, hi) => (<div key={hi} className="flex gap-1"><input value={h} onChange={e => { const n = [...ad.headlines]; n[hi] = e.target.value; updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { headlines: n }); }} placeholder={`标题 ${hi + 1}`} className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white" /><button onClick={() => { if (ad.headlines.length > 1) updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { headlines: ad.headlines.filter((_, i) => i !== hi) }); }} className="text-slate-600 hover:text-rose-400"><Trash2 className="w-3 h-3" /></button></div>))}
                </div>
                {/* 描述 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between"><label className="text-xs font-medium text-slate-400">描述 ({ad.adType === 'RESPONSIVE_SEARCH_AD' ? '最多4个' : '1个'})</label><button onClick={() => { if (ad.descriptions.length < 4) updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { descriptions: [...ad.descriptions, ''] }); }} className="text-[9px] text-indigo-500/40 hover:text-indigo-400">+</button></div>
                  {ad.descriptions.map((d, di) => (<div key={di} className="flex gap-1"><input value={d} onChange={e => { const n = [...ad.descriptions]; n[di] = e.target.value; updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { descriptions: n }); }} placeholder={`描述 ${di + 1}`} className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white" /><button onClick={() => { if (ad.descriptions.length > 1) updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { descriptions: ad.descriptions.filter((_, i) => i !== di) }); }} className="text-slate-600 hover:text-rose-400"><Trash2 className="w-3 h-3" /></button></div>))}
                </div>
                <div className="grid grid-cols-4 gap-4">
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">显示路径 1</label><input value={ad.path1 || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { path1: e.target.value })} placeholder="path1" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">显示路径 2</label><input value={ad.path2 || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { path2: e.target.value })} placeholder="path2" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">显示网址</label><input value={ad.displayUrl || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { displayUrl: e.target.value })} placeholder="example.com" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">移动端网址</label><input value={ad.finalMobileUrl || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { finalMobileUrl: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                </div>
                {(ad.adType === 'RESPONSIVE_DISPLAY_AD') && (
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2"><label className="text-xs font-medium text-slate-400">商家名称</label><input value={ad.businessName || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { businessName: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                    <div className="space-y-2"><label className="text-xs font-medium text-slate-400">CTA 按钮文字</label><input value={ad.ctaText || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { ctaText: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                  </div>
                )}
                {ad.adType === 'VIDEO_AD' && (
                  <div className="space-y-2"><label className="text-xs font-medium text-slate-400">YouTube 视频 ID</label><input value={ad.videoId || ''} onChange={e => updateAd(selectedCampaignIdx, selectedAdGroupIdx, selectedAdIdx, { videoId: e.target.value })} placeholder="dQw4w9WgXcQ" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white" /></div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-950">
          <span className="text-[10px] text-slate-500">总计: {tree.reduce((s,c) => s + c.adGroups.reduce((ss,a) => ss + a.ads.length, 0), 0)} 条广告</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">取消</button>
            <button onClick={handleSubmit} disabled={isSubmitting} className={`px-6 py-2 text-sm font-medium rounded-xl transition-all ${isSubmitting ? 'bg-slate-700 text-slate-400' : 'bg-indigo-600 text-white hover:bg-indigo-500'}`}>{isSubmitting ? '发布中...' : '发布广告'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
