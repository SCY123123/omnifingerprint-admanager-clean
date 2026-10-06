import React, { useState, useEffect } from 'react';
import { RefreshCw, ChevronRight } from 'lucide-react';
import { FingerprintProfile, Platform } from '../types';

const LOCAL_SERVER_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';
const LOCAL_SERVER_URL = process.env.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';
import { useAppContext } from './AppContext';

interface Props {
  profiles?: FingerprintProfile[];
  token?: string | null;
}

type ViewLevel = 'accounts' | 'campaigns' | 'adGroups' | 'ads';

export function GoogleAdsAccountViewer({ profiles: propProfiles }: Props) {
  const ctx = useAppContext();
  const profiles = propProfiles ?? ctx.profiles;
  const token = ctx.token;
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [adGroups, setAdGroups] = useState<any[]>([]);
  const [loadingAdGroups, setLoadingAdGroups] = useState(false);
  const [ads, setAds] = useState<any[]>([]);
  const [loadingAds, setLoadingAds] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<string>('');
  const [selectedAdGroup, setSelectedAdGroup] = useState<string>('');
  const [serverUrl, setServerUrl] = useState(LOCAL_SERVER_URL);
  const [credentials, setCredentials] = useState({ clientId: '', clientSecret: '', refreshToken: '', developerToken: '' });
  const [showCredForm, setShowCredForm] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('settings:google-ads-credentials');
      if (saved) {
        const c = JSON.parse(saved);
        setCredentials(c);
      }
    } catch {}
    try {
      const s = localStorage.getItem('settings:serverUrl');
      if (s) setServerUrl(s);
    } catch {}
  }, []);

  const saveCredentials = (c: typeof credentials) => {
    setCredentials(c);
    localStorage.setItem('settings:google-ads-credentials', JSON.stringify(c));
  };

  const googleProfiles = profiles.filter(p => p.platform === Platform.GOOGLE);

  const listAccounts = async () => {
    setLoading(true); setError('');
    try {
      const resp = await fetch(`${serverUrl}/api/google-ads/list-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify(credentials)
      });
      const r = await resp.json();
      if (r.success) setAccounts(r.customers || []);
      else setError(r.message || '获取账户列表失败');
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const listCampaigns = async (customerId: string) => {
    setSelectedCustomerId(customerId); setSelectedCampaign(''); setSelectedAdGroup('');
    setAdGroups([]); setAds([]);
    setLoadingCampaigns(true);
    try {
      const q = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.start_date, campaign.end_date, campaign.optimization_score FROM campaign ORDER BY campaign.name`;
      const resp = await fetch(`${serverUrl}/api/google-ads/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ ...credentials, customerId, query: q })
      });
      const r = await resp.json();
      if (r.success) setCampaigns(r.results || []);
      else setError(r.message || '获取广告系列失败');
    } catch (e: any) { setError(e.message); }
    setLoadingCampaigns(false);
  };

  const listAdGroups = async (campaignId: string) => {
    setSelectedCampaign(campaignId); setSelectedAdGroup('');
    setAds([]);
    setLoadingAdGroups(true);
    try {
      const q = `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, ad_group.cpm_bid_micros, campaign.id FROM ad_group WHERE campaign.id = ${campaignId} ORDER BY ad_group.name`;
      const resp = await fetch(`${serverUrl}/api/google-ads/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ ...credentials, customerId: selectedCustomerId, query: q })
      });
      const r = await resp.json();
      if (r.success) setAdGroups(r.results || []);
      else setError(r.message || '获取广告组失败');
    } catch (e: any) { setError(e.message); }
    setLoadingAdGroups(false);
  };

  const listAds = async (adGroupId: string) => {
    setSelectedAdGroup(adGroupId);
    setLoadingAds(true);
    try {
      const q = `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group.id FROM ad_group_ad WHERE ad_group.id = ${adGroupId} ORDER BY ad_group_ad.ad.id`;
      const resp = await fetch(`${serverUrl}/api/google-ads/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ ...credentials, customerId: selectedCustomerId, query: q })
      });
      const r = await resp.json();
      if (r.success) setAds(r.results || []);
      else setError(r.message || '获取广告失败');
    } catch (e: any) { setError(e.message); }
    setLoadingAds(false);
  };

  const microsToAmount = (m: string | number) => {
    const n = Number(m || 0);
    return (n / 1000000).toFixed(2);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Google Ads 广告账户</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowCredForm(!showCredForm)} className="px-3 py-1.5 text-xs bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700">凭证设置</button>
          <button onClick={listAccounts} disabled={loading} className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50 flex items-center gap-1"><RefreshCw className="w-3 h-3" />{loading ? '加载中...' : '刷新'}</button>
        </div>
      </div>

      {showCredForm && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-medium text-white">Google Ads API 凭证</h3>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Client ID" value={credentials.clientId} onChange={e => saveCredentials({...credentials, clientId: e.target.value})} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white" />
            <input placeholder="Client Secret" type="password" value={credentials.clientSecret} onChange={e => saveCredentials({...credentials, clientSecret: e.target.value})} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white" />
            <input placeholder="Refresh Token" type="password" value={credentials.refreshToken} onChange={e => saveCredentials({...credentials, refreshToken: e.target.value})} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white" />
            <input placeholder="Developer Token" type="password" value={credentials.developerToken} onChange={e => saveCredentials({...credentials, developerToken: e.target.value})} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white" />
          </div>
          <p className="text-[10px] text-slate-500">凭证会保存在浏览器本地，不会发送到第三方</p>
        </div>
      )}

      {error && <div className="bg-rose-900/30 border border-rose-800 rounded-lg p-3 text-xs text-rose-300">{error}</div>}

      {googleProfiles.length === 0 && !loading && accounts.length === 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
          <p className="text-sm text-slate-500">没有 Google Ads 配置。请先在「账号列表」中添加 Google Ads 配置。</p>
        </div>
      )}

      {accounts.length === 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-medium text-white mb-3">关联的 Google Ads 配置</h3>
          <div className="space-y-1">{googleProfiles.map(p => (
            <div key={p.id} className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-300">#{p.id} {p.name || '未命名'}</span>
              <button onClick={() => listCampaigns(p.customer_id || '')} className="text-[10px] text-indigo-400 hover:text-indigo-300">查看广告</button>
            </div>
          ))}</div>
        </div>
      )}

      {/* 广告账户列表 */}
      {accounts.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 text-sm font-medium text-white">广告账户</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-950 text-slate-400 text-[10px] uppercase"><th className="px-4 py-2 text-left">客户ID</th><th className="px-4 py-2 text-left">名称</th><th className="px-4 py-2 text-left">币种</th><th className="px-4 py-2 text-left">时区</th><th className="px-4 py-2 text-left">自动标记</th><th className="px-4 py-2"></th></tr></thead>
              <tbody>{accounts.map((a, i) => (
                <tr key={i} className="border-t border-slate-800 hover:bg-slate-800/50">
                  <td className="px-4 py-2.5 font-mono text-indigo-300">{a.customerId}</td>
                  <td className="px-4 py-2.5 text-white">{a.details?.descriptiveName || '-'}</td>
                  <td className="px-4 py-2.5 text-slate-400">{a.details?.currencyCode || '-'}</td>
                  <td className="px-4 py-2.5 text-slate-400">{a.details?.timeZone || '-'}</td>
                  <td className="px-4 py-2.5 text-slate-400">{a.details?.autoTaggingEnabled ? '是' : '否'}</td>
                  <td className="px-4 py-2.5"><button onClick={() => listCampaigns(a.customerId)} className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1">查看系列 <ChevronRight className="w-3 h-3" /></button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* 广告系列列表 */}
      {(loadingCampaigns || campaigns.length > 0 || selectedCustomerId) && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 text-sm font-medium text-white">广告系列 {selectedCustomerId && <span className="text-[10px] text-slate-500">(客户: {selectedCustomerId})</span>}</div>
          {loadingCampaigns ? <div className="p-4 text-xs text-slate-500">加载中...</div> : campaigns.length === 0 ? <div className="p-4 text-xs text-slate-500">无广告系列</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-950 text-slate-400 text-[10px] uppercase"><th className="px-4 py-2 text-left">ID</th><th className="px-4 py-2 text-left">名称</th><th className="px-4 py-2 text-left">类型</th><th className="px-4 py-2 text-left">状态</th><th className="px-4 py-2 text-left">开始</th><th className="px-4 py-2 text-left">结束</th><th className="px-4 py-2 text-left">优化评分</th><th className="px-4 py-2"></th></tr></thead>
              <tbody>{campaigns.map((r, i) => {
                const c = r.campaign || {};
                return <tr key={i} className="border-t border-slate-800 hover:bg-slate-800/50">
                  <td className="px-4 py-2 font-mono text-slate-400">{c.id || '-'}</td>
                  <td className="px-4 py-2 text-white">{c.name || '-'}</td>
                  <td className="px-4 py-2"><span className="px-2 py-0.5 bg-indigo-600/20 border border-indigo-500/30 rounded text-[9px] text-indigo-300">{c.advertisingChannelType || '-'}</span></td>
                  <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-[9px] ${c.status === 'ENABLED' ? 'bg-emerald-600/20 text-emerald-300' : c.status === 'PAUSED' ? 'bg-amber-600/20 text-amber-300' : 'bg-slate-700 text-slate-400'}`}>{c.status || '-'}</span></td>
                  <td className="px-4 py-2 text-slate-400">{c.startDate || '-'}</td>
                  <td className="px-4 py-2 text-slate-400">{c.endDate || '-'}</td>
                  <td className="px-4 py-2 text-slate-400">{c.optimizationScore != null ? (Number(c.optimizationScore) * 100).toFixed(0) + '%' : '-'}</td>
                  <td className="px-4 py-2"><button onClick={() => listAdGroups(c.id)} className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1">广告组 <ChevronRight className="w-3 h-3" /></button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {/* 广告组列表 */}
      {(loadingAdGroups || adGroups.length > 0) && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 text-sm font-medium text-white">广告组</div>
          {loadingAdGroups ? <div className="p-4 text-xs text-slate-500">加载中...</div> : adGroups.length === 0 ? <div className="p-4 text-xs text-slate-500">无广告组</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-950 text-slate-400 text-[10px] uppercase"><th className="px-4 py-2 text-left">ID</th><th className="px-4 py-2 text-left">名称</th><th className="px-4 py-2 text-left">类型</th><th className="px-4 py-2 text-left">状态</th><th className="px-4 py-2 text-left">CPC</th><th className="px-4 py-2 text-left">CPM</th><th className="px-4 py-2"></th></tr></thead>
              <tbody>{adGroups.map((r, i) => {
                const ag = r.adGroup || {};
                return <tr key={i} className="border-t border-slate-800 hover:bg-slate-800/50">
                  <td className="px-4 py-2 font-mono text-slate-400">{ag.id || '-'}</td>
                  <td className="px-4 py-2 text-white">{ag.name || '-'}</td>
                  <td className="px-4 py-2 text-slate-400">{ag.type || '-'}</td>
                  <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-[9px] ${ag.status === 'ENABLED' ? 'bg-emerald-600/20 text-emerald-300' : 'bg-amber-600/20 text-amber-300'}`}>{ag.status || '-'}</span></td>
                  <td className="px-4 py-2 text-slate-400">{ag.cpcBidMicros ? `$${microsToAmount(ag.cpcBidMicros)}` : '-'}</td>
                  <td className="px-4 py-2 text-slate-400">{ag.cpmBidMicros ? `$${microsToAmount(ag.cpmBidMicros)}` : '-'}</td>
                  <td className="px-4 py-2"><button onClick={() => listAds(ag.id)} className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1">广告 <ChevronRight className="w-3 h-3" /></button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {/* 广告列表 */}
      {(loadingAds || ads.length > 0) && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 text-sm font-medium text-white">广告</div>
          {loadingAds ? <div className="p-4 text-xs text-slate-500">加载中...</div> : ads.length === 0 ? <div className="p-4 text-xs text-slate-500">无广告</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-950 text-slate-400 text-[10px] uppercase"><th className="px-4 py-2 text-left">ID</th><th className="px-4 py-2 text-left">名称</th><th className="px-4 py-2 text-left">类型</th><th className="px-4 py-2 text-left">状态</th><th className="px-4 py-2 text-left">目标网址</th><th className="px-4 py-2 text-left">标题预览</th></tr></thead>
              <tbody>{ads.map((r, i) => {
                const a = r.adGroupAd?.ad || {};
                const adStatus = r.adGroupAd?.status || '';
                const headlines = (a.responsiveSearchAd?.headlines || []).map((h: any) => h.text).join(' | ');
                return <tr key={i} className="border-t border-slate-800 hover:bg-slate-800/50">
                  <td className="px-4 py-2 font-mono text-slate-400">{a.id || '-'}</td>
                  <td className="px-4 py-2 text-white">{a.name || '-'}</td>
                  <td className="px-4 py-2 text-slate-400">{a.type?.replace('_', ' ') || '-'}</td>
                  <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-[9px] ${adStatus === 'ENABLED' ? 'bg-emerald-600/20 text-emerald-300' : 'bg-amber-600/20 text-amber-300'}`}>{adStatus || '-'}</span></td>
                  <td className="px-4 py-2 text-slate-400 max-w-[200px] truncate">{(a.finalUrls || [''])[0] || '-'}</td>
                  <td className="px-4 py-2 text-slate-400 max-w-[250px] truncate">{headlines || '-'}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          )}
        </div>
      )}
    </div>
  );
}
