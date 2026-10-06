import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { pullUserSettings, SYNCED_SETTING_KEYS } from './components/userSettings';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { ProfileManager } from './components/ProfileManager';
import { AdAutomation } from './components/AdAutomation';
import { AssetViewer } from './components/AssetViewer';
import { DomainManager } from './components/DomainManager';
import { ProxyManager } from './components/ProxyManager';
import { Payment } from './components/Payment';
import { Cards } from './components/Cards.tsx';
import { SystemSettings } from './components/SystemSettings';
import { Transactions } from './components/Transactions.tsx';
import { FacebookLimits } from './components/FacebookLimits';
import { LoginPage } from './components/LoginPage';
import { UserManagement } from './components/UserManagement';
import { TemplateManager } from './components/TemplateManager';
import { PageTemplateManager } from './components/PageTemplateManager';
import { BillingTemplateManager } from './components/BillingTemplateManager';
import { CardBindTemplateManager } from './components/CardBindTemplateManager';
import { AdPublishHub } from './components/AdPublishHub';
import { RechargeCenter } from './components/RechargeCenter';
import { AdInsights } from './components/AdInsights';
import { BillingQuery } from './components/BillingQuery';
import EmailSystem from './components/EmailSystem';
import Shop from './components/Shop';
import ShopAdmin from './components/ShopAdmin';
import SmsService from './components/SmsService';
import CaptchaService from './components/CaptchaService';
import { fetchWithCache, getCache, setCache, clearCache } from './utils/apiCache'
import { TikTokRegistration } from './components/tiktok/TikTokRegistration';
import { TikTokAdPublisher } from './components/tiktok/TikTokAdPublisher';
import { XRegistration } from './components/x/XRegistration';
import { InsRegistration } from './components/ins/InsRegistration';
import { GoogleAdsAccountViewer } from './components/GoogleAdsAccountViewer';
import { PagePostsViewer, PageConversationsViewer } from './components/PageSocialViewers';
import AutoReplySettings from './components/AutoReplySettings';
import AutoReplyQueuePage from './components/AutoReplyQueuePage';
import JobQueuePage from './components/JobQueuePage';
import { BrowserLogs } from './components/BrowserLogs';
import { ToastProvider } from './components/Toast';
import { AppProvider } from './components/AppContext';
import { BrowserStatus, FingerprintProfile, Platform, AccountStatus } from './types';
import { Play, Square, ShieldCheck, Pencil, Wallet, Loader2, Monitor, Send } from 'lucide-react';

const LOCAL_SERVER_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

const ProxyNav = () => {
  const { t } = useTranslation();
  const [online, setOnline] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const target = (process as any)?.env?.NAV_PROXY_TARGET || '';

  const test = async () => {
    setTesting(true);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let ok = false;
      try {
        const r = await fetch('/nav/health', { signal: controller.signal });
        ok = r.ok;
      } catch {}
      if (!ok) {
        try {
          const r2 = await fetch('/nav', { signal: controller.signal });
          ok = r2.ok;
        } catch {}
      }
      setOnline(ok);
      clearTimeout(timer);
    } catch {
      setOnline(false);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-white">{t('proxyNav.title')}</h2>
        <p className="text-slate-400">{t('proxyNav.subtitle')}</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-slate-300 font-medium">{t('proxyNav.currentTarget')}</span>
            <span className="px-2 py-1 text-xs rounded bg-slate-700 text-slate-200">{target || t('proxyNav.statusUnknown')}</span>
          </div>
          <button onClick={test} disabled={testing} className="px-3 py-2 rounded bg-indigo-600 text-white text-sm disabled:opacity-50">
            {t('proxyNav.test')}
          </button>
          <div className="mt-3 text-sm">
            {online === true && <span className="text-green-500">{t('proxyNav.statusOnline')}</span>}
            {online === false && <span className="text-red-500">{t('proxyNav.statusOffline')}</span>}
            {online === null && <span className="text-slate-400">{t('proxyNav.statusUnknown')}</span>}
          </div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <div className="text-slate-200 font-medium mb-2">{t('sidebar.proxyNav')}</div>
          <div className="text-slate-400 text-sm">{t('proxyNav.help')}</div>
        </div>
      </div>
    </div>
  );
};

const ServersPanel = () => {
  const { t } = useTranslation();
  const [launchUrl, setLaunchUrl] = useState<string>('');
  const [storageUrl, setStorageUrl] = useState<string>('');
  const [launchOnline, setLaunchOnline] = useState<boolean | null>(null);
  const [storageOnline, setStorageOnline] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'status'|'ssh'|'purchase'>('status');
  const [servers, setServers] = useState<Array<{name:string;host:string;user:string;port:number;publicKey:string}>>([]);
  const [form, setForm] = useState<{name:string;host:string;user:string;port:number;publicKey:string}>({name:'',host:'',user:'root',port:22,publicKey:''});

  useEffect(() => {
    const l = (process.env as any).LAUNCH_SERVER_URL || '';
    const s = (process.env as any).STORAGE_SERVER_URL || '';
    setLaunchUrl(l);
    setStorageUrl(s);
    try {
      const raw = localStorage.getItem('serversConfig');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setServers(parsed);
      }
    } catch {}
    const check = (url: string, set: (v: boolean) => void) => {
      if (!url) { set(false); return; }
      const base = url.replace(/\/$/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      fetch(`${base}/health`, { signal: controller.signal })
        .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(() => set(true))
        .catch(() => set(false))
        .finally(() => clearTimeout(timer));
    };
    check(l, v => setLaunchOnline(v));
    check(s, v => setStorageOnline(v));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('serversConfig', JSON.stringify(servers));
    } catch {}
  }, [servers]);

  const addServer = () => {
    if (!form.name || !form.host || !form.user || !form.publicKey) return;
    setServers(prev => [...prev, { ...form }]);
    setForm({name:'',host:'',user:'root',port:22,publicKey:''});
  };

  const removeServer = (idx: number) => {
    setServers(prev => prev.filter((_, i) => i !== idx));
  };

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-white">{t('servers.title')}</h2>
          <p className="text-slate-400">{t('servers.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setTab('status')} className={`px-3 py-2 rounded-md text-sm ${tab==='status'?'bg-indigo-600 text-white':'bg-slate-800 text-slate-300'}`}>{t('servers.tabs.status')}</button>
          <button onClick={() => setTab('ssh')} className={`px-3 py-2 rounded-md text-sm ${tab==='ssh'?'bg-indigo-600 text-white':'bg-slate-800 text-slate-300'}`}>{t('servers.tabs.ssh')}</button>
          <button onClick={() => setTab('purchase')} className={`px-3 py-2 rounded-md text-sm ${tab==='purchase'?'bg-indigo-600 text-white':'bg-slate-800 text-slate-300'}`}>{t('servers.tabs.purchase')}</button>
        </div>
      </div>

      {tab === 'status' && (
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-slate-300 font-medium">Launch Server</span>
              <span className={`px-2 py-1 text-xs rounded ${launchOnline ? 'bg-green-600 text-white' : launchOnline === false ? 'bg-red-600 text-white' : 'bg-slate-700 text-slate-200'}`}>{launchOnline ? 'Online' : launchOnline === false ? 'Offline' : 'Unknown'}</span>
            </div>
            <div className="text-slate-400 text-sm break-all">{launchUrl || t('servers.notConfigured.launch')}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-slate-300 font-medium">Storage Server</span>
              <span className={`px-2 py-1 text-xs rounded ${storageOnline ? 'bg-green-600 text-white' : storageOnline === false ? 'bg-red-600 text-white' : 'bg-slate-700 text-slate-200'}`}>{storageOnline ? 'Online' : storageOnline === false ? 'Offline' : 'Unknown'}</span>
            </div>
            <div className="text-slate-400 text-sm break-all">{storageUrl || t('servers.notConfigured.storage')}</div>
          </div>
        </div>
      )}

      {tab === 'ssh' && (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
            <h3 className="text-lg font-medium text-white mb-4">{t('servers.ssh.title')}</h3>
            <div className="space-y-3 text-sm text-slate-300">
              <div>{t('servers.ssh.guide1')}</div>
              <div className="rounded bg-slate-800 text-slate-200 p-3 font-mono text-xs">ssh-keygen -t rsa -b 4096 -C "email@example.com"</div>
              <div>{t('servers.ssh.guide2')}</div>
            </div>
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input value={form.name} onChange={(e)=>setForm(f=>({...f,name:e.target.value}))} placeholder={t('servers.form.name')} className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200" />
                <input value={form.host} onChange={(e)=>setForm(f=>({...f,host:e.target.value}))} placeholder={t('servers.form.host')} className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200" />
                <input value={form.user} onChange={(e)=>setForm(f=>({...f,user:e.target.value}))} placeholder={t('servers.form.user')} className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200" />
                <input value={String(form.port)} onChange={(e)=>setForm(f=>({...f,port:Number(e.target.value)||22}))} placeholder={t('servers.form.port')} className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200" />
              </div>
              <textarea value={form.publicKey} onChange={(e)=>setForm(f=>({...f,publicKey:e.target.value}))} placeholder={t('servers.form.publicKey')} rows={4} className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 w-full" />
              <div className="flex gap-2">
                <button onClick={addServer} className="px-3 py-2 rounded bg-indigo-600 text-white text-sm">{t('servers.actions.add')}</button>
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
            <h3 className="text-lg font-medium text-white mb-4">{t('servers.ssh.listTitle')}</h3>
            {servers.length === 0 ? (
              <div className="text-slate-400 text-sm">{t('servers.ssh.empty')}</div>
            ) : (
              <div className="space-y-3">
                {servers.map((s, idx) => (
                  <div key={idx} className="rounded border border-slate-800 bg-slate-950 p-4">
                    <div className="flex items-center justify-between">
                      <div className="text-slate-200 font-medium">{s.name}</div>
                      <div className="flex gap-2">
                        <button onClick={()=>removeServer(idx)} className="px-2 py-1 text-xs rounded bg-red-600 text-white">{t('servers.actions.delete')}</button>
                      </div>
                    </div>
                    <div className="mt-2 text-slate-400 text-xs">{s.user}@{s.host}:{s.port}</div>
                    <div className="mt-2 text-slate-300 text-xs break-all">{s.publicKey}</div>
                    <div className="mt-3 text-xs text-slate-400">{t('servers.ssh.installHint')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'purchase' && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[{n:'AWS Lightsail',u:'https://lightsail.aws.amazon.com/'},{n:'DigitalOcean',u:'https://www.digitalocean.com/products/droplets'},{n:'Vultr',u:'https://www.vultr.com/'},{n:'Hetzner',u:'https://www.hetzner.com/cloud'},{n:'Oracle Cloud',u:'https://www.oracle.com/cloud/free/'},{n:'Linode',u:'https://www.linode.com/'}].map(p=> (
            <div key={p.n} className="rounded-lg border border-slate-800 bg-slate-900 p-6">
              <div className="text-slate-200 font-medium mb-2">{p.n}</div>
              <div className="text-slate-400 text-sm mb-3">{t('servers.purchase.desc')}</div>
              <button onClick={()=>window.open(p.u,'_blank','noopener,noreferrer')} className="px-3 py-2 rounded bg-indigo-600 text-white text-sm">{t('servers.purchase.open')}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// 🎯 TikTok 广告发布页面组件
const TikTokAdContent: React.FC<{ profiles: FingerprintProfile[]; token: string | null }> = ({ profiles, token }) => {
    const { t } = useTranslation();
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [showPublisher, setShowPublisher] = useState(false);
    const [localProfiles, setLocalProfiles] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchProfiles = async () => {
            // 🚀 立即显示本地缓存（5分钟有效），随后从线上 D1 数据库静默更新
            const cacheKey = 'local_profiles_cache';
            const cachedRaw = localStorage.getItem(cacheKey);
            if (cachedRaw) {
                try {
                    const cached = JSON.parse(cachedRaw);
                    if (cached.ts && Date.now() - cached.ts < 5 * 60 * 1000 && Array.isArray(cached.data)) {
                        setLocalProfiles(cached.data);
                        setLoading(false);
                    }
                } catch {}
            }
            try {
                // 🚀 线上走同源 API（Cloudflare D1），本地开发用 storageUrl
                const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
                const d1Base = isLocalDev ? storageUrl : '';
                const remoteApi = d1Base ? d1Base.replace(/\/$/, '') + '/api/profiles' : '/api/profiles';
                const resp = await fetch(remoteApi, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
                });
                const data = await resp.json();
                if (data.success) {
                    const tikTokProfiles = (data.data || []).filter((p: any) =>
                        (p.platform || '').toLowerCase().includes('tiktok')
                    );
                    const finalProfiles = tikTokProfiles.length > 0 ? tikTokProfiles : (data.data || []);
                    setLocalProfiles(finalProfiles);
                    try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: finalProfiles })); } catch {}
                }
            } catch (err) {
                console.error('Failed to fetch profiles:', err);
            } finally {
                setLoading(false);
            }
        };
        fetchProfiles();
    }, []);

    const toggleSelect = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const selectAll = () => {
        if (selectedIds.size === localProfiles.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(localProfiles.map(p => p.id)));
        }
    };

    const handleBatchPublish = () => {
        if (selectedIds.size === 0) {
            alert('请至少选择一个环境');
            return;
        }
        setShowPublisher(true);
    };

    return (
        <div className="max-w-6xl mx-auto px-4">
            {showPublisher && (
                <TikTokAdPublisher
                    profileIds={Array.from(selectedIds)}
                    onCancel={() => setShowPublisher(false)}
                    onComplete={() => setShowPublisher(false)}
                />
            )}
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-semibold text-white flex items-center gap-2">
                        <Play className="w-5 h-5 text-rose-500" /> TikTok 批量广告发布
                    </h2>
                    <p className="text-slate-400 text-sm">选择环境并配置广告参数，批量发布到 TikTok Ads</p>
                </div>
                <button
                    onClick={handleBatchPublish}
                    disabled={selectedIds.size === 0}
                    className="px-5 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 rounded-xl transition-all shadow-lg shadow-rose-600/20 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <Send className="w-4 h-4" />
                    批量发布广告 ({selectedIds.size})
                </button>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
                <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <button onClick={selectAll}
                            className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors">
                            {selectedIds.size === localProfiles.length ? '取消全选' : '全选'}
                        </button>
                        <span className="text-xs text-slate-500">
                            {selectedIds.size}/{localProfiles.length} 已选
                        </span>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 text-rose-400 animate-spin" />
                        <span className="ml-2 text-slate-400 text-sm">加载环境中...</span>
                    </div>
                ) : localProfiles.length === 0 ? (
                    <div className="text-center py-20">
                        <Monitor className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                        <p className="text-slate-500 text-sm mb-2">暂无可用环境</p>
                        <p className="text-slate-600 text-xs">请先在TikTok账号列表中创建或导入环境</p>
                    </div>
                ) : (
                    <div className="divide-y divide-slate-800/50">
                        {localProfiles.map((profile: any) => (
                            <div key={profile.id}
                                onClick={() => toggleSelect(profile.id)}
                                className={`flex items-center gap-4 px-4 py-3 cursor-pointer transition-colors hover:bg-slate-800/30 ${selectedIds.has(profile.id) ? 'bg-rose-600/5' : ''}`}>
                                <input type="checkbox"
                                    checked={selectedIds.has(profile.id)}
                                    onChange={() => toggleSelect(profile.id)}
                                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-rose-500 shrink-0" />
                                <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-rose-400 text-xs font-bold border border-slate-700">
                                    {profile.id.slice(-2)}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium text-white truncate">{profile.name || `Profile #${profile.id}`}</div>
                                    <div className="text-[11px] text-slate-500 truncate">
                                        {profile.account?.email || profile.account_email || '无账号'} · {profile.proxy?.host || '无代理'}
                                    </div>
                                </div>
                                <span className="text-[10px] text-slate-600 bg-slate-800 px-2 py-0.5 rounded-full">#{profile.id}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

const App = () => {
  // 🚀 修正：优先尝试从 localStorage 读取上次选中的 tab，没有则默认 adaccounts
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const fromHash = window.location.hash.replace(/^#/, '').trim();
      if (fromHash) return fromHash;
      return localStorage.getItem('ui:activeTab') || 'adaccounts';
    } catch { return 'adaccounts'; }
  });
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);
  const [user, setUser] = useState<any>(null);
  const [token, setToken] = useState<string | null>(null);
  const { t } = useTranslation();

  const [profiles, setProfiles] = useState<FingerprintProfile[]>([]);
  // 🚀 静默 revalidate：水位（服务器时间）+ 全量重载触发器
  const profilesWatermarkRef = React.useRef<string>('');
  const profilesLenRef = React.useRef(0);
  const [profilesReloadKey, setProfilesReloadKey] = useState(0);
  useEffect(() => { profilesLenRef.current = profiles.length; }, [profiles.length]);

  // Check for existing session
  useEffect(() => {
    const savedToken = localStorage.getItem('auth_token');
    if (savedToken) {
      fetch('/api/auth/me', {
        headers: {
          'Authorization': `Bearer ${savedToken}`
        }
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setIsAuthenticated(true);
          setUser(data.user);
          setToken(savedToken);
          // 🔐 按登录用户拉取「用户级设置」（AI 提示词 / 已发送缓存…），避免同机切号串数据
          pullUserSettings(SYNCED_SETTING_KEYS);
        } else {
          localStorage.removeItem('auth_token');
        }
      })
      .catch(() => {
        localStorage.removeItem('auth_token');
      })
      .finally(() => {
        setIsInitializing(false);
      });
    } else {
      setIsInitializing(false);
    }
  }, []);

  const handleLogin = (newToken: string, newUser: any) => {
    localStorage.setItem('auth_token', newToken);
    setToken(newToken);
    setUser(newUser);
    setIsAuthenticated(true);
    // 🔐 登录后立刻拉本用户的设置（AI 提示词 / 已发送缓存…）
    pullUserSettings(SYNCED_SETTING_KEYS);
  };

  const handleLogout = () => {
    localStorage.removeItem('auth_token');
    setToken(null);
    setUser(null);
    setIsAuthenticated(false);
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    // 使用相对路径以确保总是访问当前域名
    const baseUrl = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const seedDemoProfiles = (): FingerprintProfile[] => {
      const now = new Date().toLocaleString();
      return Array.from({ length: 5 }).map((_, i) => ({
        id: `demo_${i+1}`,
        name: `演示配置 ${String(i+1).padStart(2,'0')}`,
        platform: Platform.META,
        status: BrowserStatus.IDLE,
        accountStatus: AccountStatus.UNKNOWN,
        userAgent: '',
        ipAddress: 'N/A',
        cookiesCount: 0,
        lastActive: now,
        group: 'Demo',
        account: { name: '', email: '', password: '', twoFactorSecret: '' } as any,
        notes: '',
        token: '',
        createdAt: now,
        updatedAt: now,
        assets: { pagesCount: 2 + (i % 2), adAccountsCount: 1, bmId: `bm_demo_${i+1}` } as any
      }));
    };
    // 🚀 使用本地缓存先展示数据，后台异步刷新
    const cacheKey = `profiles:${token?.slice(-8) || 'anon'}`;
    const cached = getCache<FingerprintProfile[]>(cacheKey);
    if (cached && cached.length > 0) {
      setProfiles(cached);
    }

    // 🚀 全量加载：全局 profiles 被各列表用来反查归属邮箱 / 配置名 / token，
    //    只拉首屏 50 条会导致匹配不到（见 ProfileManager / AssetViewer 里的相关注释）。
    //    后端不分页即返回全部（实测该账号 367 条 ≈ 1.4MB，一次性加载 + 本地缓存）。
    fetch(`${baseUrl}/api/profiles?_t=${Date.now()}`, { 
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }).then(r => r.json()).then(async json => {
      if (json && json.success && Array.isArray(json.data)) {
        // 🚀 记下服务器时间作为水位：之后轮询只问"这个时间之后变了哪些行"
        if (json.serverTime) profilesWatermarkRef.current = String(json.serverTime);
        const incoming = json.data as any[];
        const mapped: FingerprintProfile[] = incoming.map((p, idx) => ({
          id: String(p.id ?? ''),
          name: String(p.name ?? `Imported ${idx+1}`),
          platform: (p.platform as Platform) || Platform.META,
          status: BrowserStatus.IDLE,
          accountStatus: (p.accountStatus as AccountStatus) || AccountStatus.UNKNOWN,
          userAgent: String(p.userAgent ?? ''),
          ipAddress: String(p.ipAddress ?? 'N/A'),
          cookiesCount: Number(p.cookiesCount ?? 0),
          lastActive: String(p.lastActive ?? 'Never'),
          group: String(p.group ?? ''),
          tags: Array.isArray(p.tags) ? p.tags : (p.tags_col ? String(p.tags_col).split(',').filter(Boolean) : []),
          account: p.account,
          notes: String(p.notes ?? ''),
          token: String(p.token ?? ''),
          createdAt: String((p as any).createdAt ?? ''),
          updatedAt: String((p as any).updatedAt ?? ''),
          ownerName: String(p.ownerName ?? p.owner_name ?? 'N/A'),
          ownerEmail: String(p.ownerEmail ?? p.owner_email ?? 'N/A'),
          loginStatus: String((p as any).loginStatus ?? ''),
          assets: (p as any).assets || undefined
        }));

        try {
          // 🚀 不传 profileIds，后端按 user_id 过滤，避免分页导致统计不全
          const [ar, pr] = await Promise.all([
            fetch(`${baseUrl}/api/adaccounts?_t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${token}` } }),
            fetch(`${baseUrl}/api/pages?_t=${Date.now()}`, { headers: { 'Authorization': `Bearer ${token}` } })
          ]);
          const [aj, pj] = await Promise.all([ar.json(), pr.json()]);
          const adMap = new Map<string, number>();
          const pageMap = new Map<string, number>();
          const bmMap = new Map<string, string>();

          if (aj && aj.success && Array.isArray(aj.data)) {
            aj.data.forEach((row: any) => {
              const pid = String(row.profileId || '');
              if (!pid) return;
              adMap.set(pid, (adMap.get(pid) || 0) + 1);
              if (row.bm_count) bmMap.set(pid, row.bm_id || 'Active');
            });
          }
          // 🚀 从 pages 表按 profileId 统计页面数量（pages 表有 real 数据）
          if (pj && pj.success && Array.isArray(pj.data)) {
            pj.data.forEach((row: any) => {
              const pid = String(row.profileId || row.profile_id || '');
              if (!pid) return;
              pageMap.set(pid, (pageMap.get(pid) || 0) + 1);
            });
          }

          mapped.forEach(m => {
            const c = adMap.get(m.id) || 0;
            const pc = pageMap.get(m.id) || 0;
            const b = bmMap.get(m.id);
            m.assets = { 
              ...(m.assets || {}), 
              adAccountsCount: c,
              pagesCount: pc,
              bmId: b
            } as any;
          });
        } catch {}

        // 🚀 更新缓存（保存到 localStorage，使用合并后的数据包含资产信息）
        setProfiles(prev => {
          const prevMap = new Map(prev.map(p => [String(p.id), p]));
          const merged = mapped.map(m => {
            const prevP = prevMap.get(String(m.id));
            if (prevP && prevP.assets) {
              return { ...m, assets: { ...m.assets, ...prevP.assets } };
            }
            return m;
          });
          const result = merged.length > 0 ? merged : seedDemoProfiles();
          setCache(cacheKey, result, 5 * 60 * 1000);
          return result;
        });
      }
    }).catch(() => {
      // 🚀 API 不可用（503 冷启动）时，检查缓存或用演示数据兜底
      setProfiles(prev => {
        if (prev.length > 0) return prev;
        const cached = getCache<FingerprintProfile[]>(cacheKey);
        if (cached && cached.length > 0) return cached;
        return seedDemoProfiles();
      });
    }).finally(() => clearTimeout(timer));
    return () => clearTimeout(timer);
  }, [isAuthenticated, token, profilesReloadKey]);

  // 🚀 静默 revalidate（本地优先 + stale-while-revalidate）：
  //    · 水位增量：只拉 `since=水位` 之后变更的行，无变更时响应约 0.2KB → 云端几乎零压力
  //    · diff 合并：只有真的变化的行才换新对象（未变行保持同一引用，React 跳过重渲染）→ 画面不闪
  //    · 门控：页面不可见时暂停，切回标签页立刻补一次；失败按 10s→20s→40s（上限 60s）退避
  //    · 兜底对齐：返回的 total 与本地条数不一致（别人新增/删除过）→ 触发一次全量重载
  useEffect(() => {
    if (!isAuthenticated) return;
    const baseUrl = '';
    const BASE_MS = 5000;
    let failCount = 0;
    let timer: any = null;
    let stopped = false;

    const schedule = (ms: number) => {
      if (stopped) return;
      timer = setTimeout(run, ms);
    };

    const run = async () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) { schedule(BASE_MS); return; }
      let nextDelay = BASE_MS;
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 10000);
        const since = profilesWatermarkRef.current;
        const resp = await fetch(`${baseUrl}/api/profiles?light=1${since ? `&since=${encodeURIComponent(since)}` : ''}&_t=${Date.now()}`, {
          signal: controller.signal,
          headers: { 'Authorization': `Bearer ${token}` }
        });
        clearTimeout(t);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        failCount = 0;
        if (json && json.success) {
          if (json.serverTime) profilesWatermarkRef.current = String(json.serverTime);
          const rows: any[] = Array.isArray(json.data) ? json.data : [];
          let needFullReload = false;
          if (!json.unchanged && rows.length) {
            setProfiles(prev => {
              const prevMap = new Map(prev.map(p => [String(p.id), p]));
              let changed = false;
              for (const r of rows) {
                const pid = String(r.id ?? '');
                const old = prevMap.get(pid);
                if (!old) { needFullReload = true; continue; } // 出现本地没有的行 → 交给全量重载
                const cc = Number(r.cookiesCount ?? 0);
                const ls = String(r.loginStatus ?? '');
                if (old.cookiesCount !== cc || String(old.loginStatus ?? '') !== ls) {
                  prevMap.set(pid, { ...old, cookiesCount: cc, loginStatus: ls });
                  changed = true;
                }
              }
              return changed ? Array.from(prevMap.values()) : prev;
            });
          }
          // 行数对不上说明有别处新增/删除 → 全量对齐一次（正常稳定态下永远不会触发）
          if (!needFullReload && typeof json.total === 'number' && profilesLenRef.current > 0 && json.total !== profilesLenRef.current) {
            needFullReload = true;
          }
          if (needFullReload) setProfilesReloadKey(k => k + 1);
        }
      } catch {
        failCount++;
        // 失败退避：10s / 20s / 40s，上限 60s（成功后自动回到 5s）
        nextDelay = Math.min(BASE_MS * Math.pow(2, failCount), 60000);
      }
      schedule(nextDelay);
    };

    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        clearTimeout(timer);
        run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    schedule(BASE_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isAuthenticated, token, profilesReloadKey]);

  // ⛔ 已移除「空闲 15 分钟后自动整页刷新」的逻辑：
  //    批量任务现在跑在本机服务端队列里，前端刷新与否都不影响执行，
  //    挂机后突然整页重载反而会打断正在看的进度、丢掉页面上的临时状态。


  const getTitle = (): string => {
    const platforms: string[] = (Object.values(Platform).filter(p => p !== Platform.NONE) as string[]);
    
    const mainTitles: { [key: string]: string } = {
      dashboard: t('sidebar.dashboard'),
      'job-queue': '执行队列',
      automation: t('sidebar.automation'),
      'ad-templates': t('sidebar.adTemplates'),
      domain: t('sidebar.domain'),
      'proxy-nav': t('sidebar.proxyNav'),
      payment: t('sidebar.payment'),
      recharge: '充值中心',
      'payment-transactions': '交易记录',
      'payment-transactions-local': '本地交易记录',
      settings: t('sidebar.settings'),
      servers: t('sidebar.servers'),
      'email-system': '临时邮箱系统',
      'sms-service': '电话接码系统',
      'captcha-service': '验证码自动识别',
    };
    
    if (activeTab.startsWith('meta-')) {
      switch(activeTab) {
        case 'meta-profiles': return `${t('profileManager.title')}: ${Platform.META}`;
        case 'meta-pages': return t('assetViewer.titlePages');
        case 'meta-posts': return '主页广告贴文';
        case 'meta-messages': return '消息对话';
        case 'meta-ai-prompt': return '提示词设置';
        case 'meta-ai-queue': return 'AI 回复队列';
        case 'meta-bms': return t('assetViewer.titleBMs');
        case 'meta-adAccounts': return t('assetViewer.titleAdAccounts');
        case 'meta-ads': return '广告';
        case 'meta-insights': return '数据追踪';
        case 'meta-billing': return '账单查询';
        case 'meta-limits': return t('limits.title');
      }
    }

    if (activeTab === 'tiktok-registration') {
      return 'TikTok 账号注册';
    }

    if (activeTab === 'tiktok-ads') {
      return 'TikTok 广告发布';
    }

    if (activeTab === 'instagram-registration') {
      return 'Instagram 账号注册';
    }

    if (activeTab === 'x-registration') {
      return 'X (Twitter) 账号注册';
    }

    if (activeTab === 'tiktok-profiles') {
      return 'TikTok 账号列表';
    }

    if (activeTab === 'instagram-profiles') {
      return 'Instagram 账号列表';
    }

    if (activeTab === 'x-profiles') {
      return 'X (Twitter) 账号列表';
    }

    if (activeTab === 'google-profiles') {
      return 'Google Ads 账号列表';
    }

    if (activeTab === 'google-adAccounts') {
      return 'Google Ads 广告账户';
    }

    if (platforms.includes(activeTab)) {
        return `${t('profileManager.title')}: ${activeTab}`;
    }

    return mainTitles[activeTab] || t('sidebar.dashboard');
  };


  const renderContent = () => {
    if (activeTab.startsWith('meta-')) {
        switch(activeTab) {
            case 'meta-profiles': 
                return <ProfileManager platform={Platform.META} />;
            case 'pages':
            case 'meta-pages':
                return <AssetViewer assetType="pages" />;
            case 'meta-posts':
                return <PagePostsViewer />;
            case 'meta-messages':
                return <PageConversationsViewer />;
            case 'meta-ai-prompt':
                return <AutoReplySettings />;
            case 'meta-ai-queue':
                return <AutoReplyQueuePage />;
            case 'ads':
              case 'meta-ads':
                return <AssetViewer assetType="ads" />;
              case 'bms':
              case 'meta-bms':
                return <AssetViewer assetType="bms" />;
              case 'meta-adAccounts':
                return <AssetViewer assetType="adAccounts" />;
            case 'meta-insights':
                return <AdInsights />;
            case 'meta-billing':
                return <BillingQuery />;
            case 'meta-limits':
                return <FacebookLimits />;
        }
    }

    if (activeTab === 'tiktok-registration') {
      return <TikTokRegistration />;
    }

    if (activeTab === 'tiktok-ads') {
      return <TikTokAdContent profiles={profiles} token={token} />;
    }

    if (activeTab === 'instagram-registration') {
      return <InsRegistration />;
    }

    if (activeTab === 'x-registration') {
      return <XRegistration />;
    }

    if (activeTab === 'tiktok-profiles') {
      return <ProfileManager platform={Platform.TIKTOK} />;
    }

    if (activeTab === 'instagram-profiles') {
      return <ProfileManager platform={Platform.INSTAGRAM} />;
    }

    if (activeTab === 'x-profiles') {
      return <ProfileManager platform={Platform.X} />;
    }

    if (activeTab === 'google-profiles') {
      return <ProfileManager platform={Platform.GOOGLE} />;
    }

    if (activeTab === 'google-adAccounts') {
      return <GoogleAdsAccountViewer />;
    }

    const platforms: string[] = (Object.values(Platform).filter(p => p !== Platform.NONE && p !== Platform.META && p !== Platform.TIKTOK) as string[]);

    if (platforms.includes(activeTab)) {
        return <ProfileManager platform={activeTab as Platform} />;
    }

    switch (activeTab) {
      case 'dashboard':
        return <Dashboard />;
      case 'job-queue':
        return <JobQueuePage />;
      case 'automation':
        return <AdAutomation />;
      case 'ad-publish-hub':
        return <AdPublishHub />;
      case 'ad-templates':
        return <TemplateManager token={token} />;
      case 'page-template':
        return <PageTemplateManager />;
      case 'billing-template':
        return <BillingTemplateManager />;
      case 'card-bind-template':
        return <CardBindTemplateManager />;
      case 'browser-logs':
        return <BrowserLogs />;
      case 'proxy-nav':
        return <ProxyManager />;
      case 'payment':
        return <Cards token={token ?? undefined} />;
      case 'recharge':
        return <RechargeCenter />;
      case 'payment-transactions':
        return <Transactions token={token ?? undefined} />;
      case 'payment-transactions-local':
        return <Transactions autoLocal token={token ?? undefined} />;
      case 'domain':
        return <DomainManager />;
      case 'servers':
        return <ServersPanel />;
      case 'email-system':
        return <EmailSystem />;
      case 'sms-service':
        return <SmsService />;
      case 'captcha-service':
        return <CaptchaService />;
      case 'users':
        return (user?.role === 'admin' || user?.role === 'superadmin') ? <UserManagement token={token} /> : <Dashboard />;
      case 'super-admin':
        return user?.role === 'superadmin' ? <UserManagement superAdmin token={token} /> : <Dashboard />;
      case 'settings':
        return <SystemSettings />;
      default:
        return <Dashboard />;
    }
  };

  useEffect(() => {
    try {
      const fromHash = window.location.hash.replace(/^#/, '').trim();
      if (fromHash) {
        setActiveTab(fromHash);
      } else {
        const saved = localStorage.getItem('ui:activeTab');
        if (saved) setActiveTab(saved);
      }
    } catch {}
    (window as any).setActiveTab = (tab: string) => setActiveTab(tab as any);
    const handler = (e: any) => {
      setActiveTab('meta-ads');
      try { localStorage.setItem('adsFilter', JSON.stringify(e?.detail || {})); } catch {}
    };
    const onHashChange = () => {
      try {
        const h = window.location.hash.replace(/^#/, '').trim();
        if (h) setActiveTab(h);
      } catch {}
    };
    window.addEventListener('open-ads-list', handler as any);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('open-ads-list', handler as any);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem('ui:activeTab', activeTab); } catch {}
    try {
      const h = window.location.hash.replace(/^#/, '').trim();
      // 🛒 商城是独立入口（#shop 买家 / #shop-admin 管理后台），不能被主系统的 tab 同步覆盖掉
      if (h === 'shop' || h === 'shop-admin') return;
      window.location.hash = `#${activeTab}`;
    } catch {}
  }, [activeTab]);

  // 🛒 商城独立入口：完全脱离主系统（无侧边栏、无主系统登录态、无用户共享）
  //    放在 isInitializing 之前 —— 商城不依赖主系统的会话恢复
  try {
    const shopEntry = window.location.hash.replace(/^#/, '').trim();
    if (shopEntry === 'shop' || shopEntry === 'shop-admin') {
      return (
        <ToastProvider>
          {shopEntry === 'shop' ? (
            <div className="min-h-screen bg-slate-950">
              <div className="max-w-7xl mx-auto p-4 lg:p-6">
                <Shop />
              </div>
            </div>
          ) : (
            <ShopAdmin />
          )}
        </ToastProvider>
      );
    }
  } catch {}

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-slate-400 animate-pulse text-sm">正在恢复会话...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <ToastProvider>
      <AppProvider
        initialUser={user}
        initialToken={token}
        initialProfiles={profiles}
      >
        <Layout 
          activeTab={activeTab} 
          onTabChange={setActiveTab} 
          title={getTitle()}
          onLogout={handleLogout}
        >
          {renderContent()}
        </Layout>
      </AppProvider>
    </ToastProvider>
  );
};

export default App;
const AdsPortal = ({ profiles, token }: { profiles: FingerprintProfile[], token?: string | null }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<{ profileId?: string; adAccountId?: string }>({});
  const [manualAccessToken, setManualAccessToken] = useState<string>('');
  const [adsLoading, setAdsLoading] = useState(false);
  const [adsError, setAdsError] = useState('');
  const [ads, setAds] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [linkDomain, setLinkDomain] = useState<string>('');
  const [hasPreviewOnly, setHasPreviewOnly] = useState<boolean>(false);
  const [creativeType, setCreativeType] = useState<string>('');
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [selectedAd, setSelectedAd] = useState<any | null>(null);
  const [adsetNames, setAdsetNames] = useState<Record<string, string>>({});
  const [campaignNames, setCampaignNames] = useState<Record<string, string>>({});
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState('');
  const [insightsDatePreset, setInsightsDatePreset] = useState('last_7d');
  const [adInsights, setAdInsights] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [batchInfo, setBatchInfo] = useState<{ total: number; done: number; failed: number } | null>(null);
  const [batchFailedIds, setBatchFailedIds] = useState<string[]>([]);
  const [adSeqMap, setAdSeqMap] = useState<Record<string, number>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem('adsFilter');
      const obj = raw ? JSON.parse(raw) : {};
      setFilter(obj);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('adsPortal:filters');
      const obj = raw ? JSON.parse(raw) : null;
      if (obj) {
        setSearchTerm(String(obj.searchTerm||''));
        setStatusFilter(String(obj.statusFilter||''));
        setLinkDomain(String(obj.linkDomain||''));
        setHasPreviewOnly(!!obj.hasPreviewOnly);
        setCreativeType(String(obj.creativeType||''));
      }
    } catch {}
  }, []);
  useEffect(() => {
    const key = `adSeq:ads:${String(filter.adAccountId||'')}`;
    try {
      const raw = localStorage.getItem(key);
      setAdSeqMap(raw ? JSON.parse(raw) : {});
    } catch { setAdSeqMap({}); }
  }, [filter.adAccountId]);
  useEffect(() => {
    const key = `adSeq:ads:${String(filter.adAccountId||'')}`;
    const next: Record<string, number> = { ...adSeqMap };
    const values = Object.values(next) as number[];
    let maxSeq: number = values.length ? Math.max(...values) : 0;
    ads.forEach((a: any) => {
      const id = String(a.id||'');
      if (id && next[id] == null) { maxSeq = maxSeq + 1; next[id] = maxSeq; }
    });
    setAdSeqMap(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  }, [ads, filter.adAccountId]);
  useEffect(() => {
    const pid = String(filter.profileId || '');
    if (!pid) return;
    const p = profiles.find(pr => pr.id === pid);
    const tok = p && typeof p.token === 'string' ? p.token : '';
    if (tok) setManualAccessToken(tok);
  }, [filter, profiles]);
  useEffect(() => {
    const obj = { searchTerm, statusFilter, linkDomain, hasPreviewOnly, creativeType };
    try { localStorage.setItem('adsPortal:filters', JSON.stringify(obj)); } catch {}
  }, [searchTerm, statusFilter, linkDomain, hasPreviewOnly, creativeType]);
  const fetchAds = async () => {
    const actRaw = String(filter.adAccountId || '').trim();
    if (!actRaw || !manualAccessToken) return;
    setAdsLoading(true);
    setAdsError('');
    setAds([]);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      // 线上部署时使用相对路径访问后端代理
      const sbase = ''; 
      const qs = (u: string) => `${u}${u.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      const proxyGet = async (url: string) => {
        const resp = await fetch(`${sbase}/api/graph`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }, 
          body: JSON.stringify({ url }) 
        });
        const json = await resp.json();
        if (!json || !json.success) throw new Error('proxy_failed');
        const data = json.data ?? {};
        if (data && data.error && data.error.message) throw new Error(data.error.message);
        return data;
      };
      const fetchAll = async (initialUrl: string) => {
        let items: any[] = [];
        let url = initialUrl;
        for (let i = 0; i < 10; i++) {
          const data = await proxyGet(url);
          const part = Array.isArray((data as any).data) ? (data as any).data : [];
          items = items.concat(part);
          const next = (data as any)?.paging?.next;
          if (!next) break;
          url = next;
        }
        return items;
      };
      const accId = actRaw.startsWith('act_') ? actRaw : (/^\d+$/.test(actRaw) ? `act_${actRaw}` : actRaw);
      const url = qs(`${base}/${accId}/ads?fields=id,name,status,effective_status,created_time,adset_id,campaign_id,creative{id,name,thumbnail_url,preview_shareable_url,object_story_spec}&limit=50`);
      const list = await fetchAll(url);
      setAds(list);
      const adsetIds = Array.from(new Set(list.map((a:any)=>String(a.adset_id||'')).filter(Boolean)));
      const campIds = Array.from(new Set(list.map((a:any)=>String(a.campaign_id||'')).filter(Boolean)));
      const loadNames = async (ids: string[], target: 'adset'|'campaign') => {
        if (!ids.length) return;
        const cacheKey = target === 'adset' ? `adsPortal:names:adset:${accId}` : `adsPortal:names:campaign:${accId}`;
        let cache: Record<string,string> = {};
        try { const raw = localStorage.getItem(cacheKey); cache = raw ? JSON.parse(raw) : {}; } catch {}
        const maps: Record<string,string> = { ...cache };
        const toFetch = ids.filter(id => !(id in cache));
        const chunks: string[][] = [];
        for (let i=0;i<toFetch.length;i+=50) chunks.push(toFetch.slice(i,i+50));
        for (const ch of chunks) {
          const u = qs(`${base}/?ids=${encodeURIComponent(ch.join(','))}&fields=name`);
          const data = await proxyGet(u) as any;
          Object.keys(data || {}).forEach(k => { maps[k] = String(data[k]?.name || ''); });
        }
        if (target === 'adset') setAdsetNames(maps); else setCampaignNames(maps);
        try { localStorage.setItem(cacheKey, JSON.stringify(maps)); } catch {}
      };
      await loadNames(adsetIds,'adset');
      await loadNames(campIds,'campaign');
    } catch (e: any) {
      setAdsError(e?.message || '拉取失败');
    } finally {
      setAdsLoading(false);
    }
  };
  const filtered = ads.filter((a: any) => {
    const qok = (() => {
      if (!searchTerm) return true;
      const q = searchTerm.toLowerCase();
      const fields = ['id','name','status','effective_status','campaign_id','adset_id'].map(k => String(a[k]||'').toLowerCase());
      return fields.some(s => s.includes(q));
    })();
    const sok = statusFilter ? String(a.effective_status||a.status||'').toUpperCase() === statusFilter.toUpperCase() : true;
    const dok = linkDomain ? String(a.creative?.object_story_spec?.link_data?.link||'').toLowerCase().includes(linkDomain.toLowerCase()) : true;
    const pok = hasPreviewOnly ? !!a.creative?.preview_shareable_url : true;
    const typeOk = (() => {
      if (!creativeType) return true;
      const spec = a.creative?.object_story_spec || {};
      const isCarousel = !!spec.carousel_data;
      const isVideo = !!spec.video_data;
      const t = isCarousel ? 'carousel' : (isVideo ? 'video' : 'image');
      return t === creativeType;
    })();
    return qok && sok && dok && pok && typeOk;
  });
  const visibleAds = filtered.filter(a=> statusFilter ? String(a.effective_status||a.status||'').toUpperCase()===statusFilter.toUpperCase() : true);
  const toggleSelection = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };
  const toggleSelectAll = () => {
    const ids = visibleAds.map((a:any)=>String(a.id));
    if (selectedIds.size === ids.length && ids.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(ids));
    }
  };
  const batchUpdateStatus = async (status: 'ACTIVE'|'PAUSED'|'DELETED'|'ARCHIVED') => {
    if (selectedIds.size === 0 || !manualAccessToken) return;
    if (status === 'DELETED') {
      const ok = window.confirm(t('ads.batch.deleteConfirm', { count: selectedIds.size }));
      if (!ok) return;
    }
    setBatchLoading(true);
    setBatchError('');
    setBatchFailedIds([]);
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const ids = Array.from(selectedIds);
      const formFor = (st: string) => { const f = new URLSearchParams(); f.set('status', st); f.set('access_token', manualAccessToken); return f; };
      const tasks = ids.map(id => fetch(`${base}/${id}`, { method: 'POST', body: formFor(status) }).then(r=>r.json().then(json=>({ id, json }))).catch(()=>({ id, error: { message: 'network' } })));
      const results = await Promise.allSettled(tasks);
      const failedIds: string[] = [];
      results.forEach(r => {
        if (r.status !== 'fulfilled') { const v: any = (r as any).reason; if (v?.id) failedIds.push(String(v.id)); else failedIds.push('unknown'); return; }
        const v: any = (r as any).value; if (v?.json?.error) failedIds.push(String(v.id));
      });
      if (failedIds.length > 0) setBatchError(`部分失败：${failedIds.length}/${ids.length}`);
      setBatchInfo({ total: ids.length, done: ids.length, failed: failedIds.length });
      setBatchFailedIds(failedIds);
      setAds(prev => prev.map(a => selectedIds.has(String(a.id)) ? { ...a, status: status, effective_status: status } : a));
    } catch (e: any) {
      setBatchError(e?.message || '批量更新失败');
    } finally {
      setBatchLoading(false);
    }
  };
  const openSelectedInAdsManager = () => {
    const actRaw = String(filter.adAccountId || '').trim();
    if (!actRaw || selectedIds.size===0) return;
    const act = actRaw;
    const all = Array.from(selectedIds);
    const ids = all.slice(0, 50).join(',');
    if (all.length > 50) { try { alert(t('ads.batch.openLimitWarn', { count: all.length })); } catch {} }
    const u = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}&selected_ad_ids=${ids}`;
    window.open(u, '_blank', 'noopener,noreferrer');
  };
  const copySelectedIds = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    try { await navigator.clipboard.writeText(ids.join('\n')); } catch {}
  };
  const invertSelection = () => {
    const ids = visibleAds.map((a:any)=>String(a.id));
    const next = new Set<string>();
    ids.forEach(id => { if (!selectedIds.has(id)) next.add(id); });
    setSelectedIds(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); toggleSelectAll(); }
      if (e.ctrlKey && e.key.toLowerCase() === 'i') { e.preventDefault(); invertSelection(); }
      if (e.key === 'Escape') { clearSelection(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleAds, selectedIds]);
  const exportSelected = () => {
    const list = visibleAds.filter((a:any)=>selectedIds.has(String(a.id)));
    if (!list.length) return;
    const headers = ['id','name','effective_status','status','adset_id','campaign_id','created_time','creative_id','preview_shareable_url'];
    const esc = (v: any) => { const s = String(v ?? ''); const needs = /[",\n]/.test(s); return needs ? '"' + s.replace(/"/g,'""') + '"' : s; };
    const lines: string[] = []; lines.push(headers.join(','));
    list.forEach((a: any) => {
      const row = [a.id,a.name,a.effective_status,a.status,a.adset_id,a.campaign_id,a.created_time,a.creative?.id,a.creative?.preview_shareable_url].map(esc).join(',');
      lines.push(row);
    });
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='ads-selected.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };
  const copySelectedPreviewLinks = async () => {
    const urls = visibleAds.filter((a:any)=>selectedIds.has(String(a.id))).map((a:any)=>String(a?.creative?.preview_shareable_url||'')).filter(Boolean);
    if (!urls.length) return;
    try { await navigator.clipboard.writeText(urls.join('\n')); } catch {}
  };
  const openSelectedPreviews = () => {
    const urls = visibleAds.filter((a:any)=>selectedIds.has(String(a.id))).map((a:any)=>String(a?.creative?.preview_shareable_url||'')).filter(Boolean);
    urls.slice(0,10).forEach(u => { try { window.open(u, '_blank', 'noopener,noreferrer'); } catch {} });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const batchExportInsights = async () => {
    if (selectedIds.size === 0 || !manualAccessToken) return;
    setBatchLoading(true);
    setBatchError('');
    try {
      const base = 'https://graph.facebook.com/v20.0';
      const sbase = ''; 
      const qs = (u: string) => `${u}${u.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
      const proxyGet = async (url: string) => {
        const resp = await fetch(`${sbase}/api/graph`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }, 
          body: JSON.stringify({ url }) 
        });
        const json = await resp.json();
        if (!json || !json.success) throw new Error('proxy_failed');
        const data = json.data ?? {}; if ((data as any).error && (data as any).error.message) throw new Error((data as any).error.message); return data;
      };
      const metrics = ['impressions','clicks','spend','ctr'].join(',');
      const items: Array<{ adId: string; date: string; impressions: any; clicks: any; spend: any; ctr: any }> = [];
      const ids = Array.from(selectedIds);
      for (const id of ids) {
        try {
          const url = qs(`${base}/${id}/insights?fields=${encodeURIComponent(metrics)}&date_preset=${encodeURIComponent(insightsDatePreset)}&period=day`);
          const data = await proxyGet(url);
          const list = Array.isArray((data as any)?.data) ? (data as any).data : [];
          list.forEach((m: any) => {
            const date = m?.date_start || m?.date || m?.end_time || '';
            items.push({ adId: id, date, impressions: m?.impressions || '', clicks: m?.clicks || '', spend: m?.spend || '', ctr: m?.ctr || '' });
          });
        } catch {}
      }
      if (items.length) {
        const headers = ['ad_id','date','impressions','clicks','spend','ctr'];
        const esc = (v: any) => { const s = String(v ?? ''); const needs = /[",\n]/.test(s); return needs ? '"' + s.replace(/"/g,'""') + '"' : s; };
        const lines: string[] = []; lines.push(headers.join(','));
        items.forEach(row => { lines.push([row.adId,row.date,row.impressions,row.clicks,row.spend,row.ctr].map(esc).join(',')); });
        const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=`ads-insights-${insightsDatePreset}.csv`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        setBatchInfo({ total: ids.length, done: ids.length, failed: ids.length - (items.length ? 0 : ids.length) });
      }
    } catch (e: any) {
      setBatchError(e?.message || '导出失败');
    } finally {
      setBatchLoading(false);
    }
  };
  const exportAds = () => {
    if (!filtered.length) return;
    const headers = ['id','name','effective_status','status','adset_id','campaign_id','created_time','creative_id','creative_name','link','preview_shareable_url'];
    const esc = (v: any) => {
      const s = String(v ?? '');
      const needs = /[",\n]/.test(s);
      return needs ? '"' + s.replace(/"/g,'""') + '"' : s;
    };
    const lines: string[] = [];
    lines.push(headers.join(','));
    filtered.forEach((a: any) => {
      const row = [
        a.id,
        a.name,
        a.effective_status,
        a.status,
        a.adset_id,
        a.campaign_id,
        a.created_time,
        a.creative?.id,
        a.creative?.name,
        a.creative?.object_story_spec?.link_data?.link,
        a.creative?.preview_shareable_url
      ].map(esc).join(',');
      lines.push(row);
    });
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ads.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const act = String(filter.adAccountId || '');
  const url = act ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}` : '';

  const rowToggleStatus = (pid: string) => {
    // 根据用户要求，直接请求本地 localhost 端口
    const baseUrl = 'http://localhost:9999/api';
    if (!pid) return;
    const prof = profiles.find(p => p.id === pid);
    const isRunning = prof && prof.status === BrowserStatus.RUNNING;
    if (isRunning) {
      fetch(`${baseUrl}/stop-browser`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET
        }, 
        body: JSON.stringify({ profileId: pid }) 
      }).then(r=>r.json()).catch(()=>{});
    } else {
      const payload: any = { profileId: pid, chrome115Config: { windowTitle: String(pid) } };
      fetch(`${baseUrl}/launch-browser`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET
        }, 
        body: JSON.stringify(payload) 
      }).then(r=>r.json()).catch(()=>{});
    }
  };
  const rowGetAndSaveTokens = async (pid: string) => {
    const baseUrl = 'http://localhost:9999/api';
    if (!pid) return;
    try {
      const tResp = await fetch(`${baseUrl}/facebook/tokens`, { 
        method: 'POST', 
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Secret': LOCAL_SERVER_SECRET
        }, 
        body: JSON.stringify({ profileId: pid, targetUrl: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns', strictEAAB: true }) 
      });
      const tJson = await tResp.json();
      if (!tJson || !tJson.success) return;
      const tokens = tJson.tokens || {};
      try { 
        await fetch(`${baseUrl}/facebook/save-tokens`, { 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'X-Api-Secret': LOCAL_SERVER_SECRET
          }, 
          body: JSON.stringify({ profileId: pid, tokens }) 
        }); 
      } catch {}
    } catch {}
  };
  const rowCheckLoginStatus = (pid: string) => {
    const baseUrl = 'http://localhost:9999/api';
    if (!pid) return;
    fetch(`${baseUrl}/facebook/check-login`, { 
      method: 'POST', 
      headers: { 
        'Content-Type': 'application/json',
        'X-Api-Secret': LOCAL_SERVER_SECRET
      }, 
      body: JSON.stringify({ profileId: pid }) 
    }).then(r=>r.json()).catch(()=>null);
  };
  const rowEditProfile = (pid: string) => {
    if (!pid) return;
    try { (window as any).setActiveTab && (window as any).setActiveTab('meta-profiles'); } catch {}
    try { window.dispatchEvent(new CustomEvent('open-profile-edit', { detail: { profileId: pid } })); } catch {}
  };
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-slate-300 text-sm">{t('ads.toolbar.accountLabel')}：<span className="font-mono text-slate-200">{act || '-'}</span></div>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500">{t('ads.batch.openManager')}</a>
        )}
      </div>
      <div className="flex gap-2">
        <input value={manualAccessToken} onChange={e=>setManualAccessToken(e.target.value)} placeholder="粘贴EAAG..." className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded" />
        <button onClick={fetchAds} disabled={!manualAccessToken || !act || adsLoading} className="px-3 py-1.5 rounded bg-indigo-600 text-white disabled:opacity-50">{adsLoading?'拉取中…':t('ads.toolbar.fetchAds')}</button>
        <button onClick={() => { try { (window as any).setActiveTab && (window as any).setActiveTab('meta-adAccounts'); } catch {} }} className="px-3 py-1.5 rounded bg-slate-800 text-slate-200">{t('ads.toolbar.backToAccounts')}</button>
        <button onClick={exportAds} disabled={filtered.length===0} className="px-3 py-1.5 rounded bg-slate-800 text-slate-200 disabled:opacity-50">{t('ads.toolbar.export')}</button>
      </div>
      {adsError && <div className="text-rose-400 text-sm">{adsError}</div>}
      <div className="p-3 border border-slate-800 rounded bg-slate-900">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          <input value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} placeholder={t('ads.filters.searchPlaceholder')} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded" />
          <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded">
            <option value="">{t('ads.filters.status.all')}</option>
            <option value="ACTIVE">{t('ads.filters.status.ACTIVE')}</option>
            <option value="PAUSED">{t('ads.filters.status.PAUSED')}</option>
            <option value="DELETED">{t('ads.filters.status.DELETED')}</option>
            <option value="ARCHIVED">{t('ads.filters.status.ARCHIVED')}</option>
            <option value="IN_PROCESS">{t('ads.filters.status.IN_PROCESS')}</option>
          </select>
          <input value={linkDomain} onChange={e=>setLinkDomain(e.target.value)} placeholder={t('ads.filters.linkKeyword')} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded" />
          <label className="inline-flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={hasPreviewOnly} onChange={e=>setHasPreviewOnly(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
            {t('ads.filters.previewOnly')}
          </label>
          <select value={creativeType} onChange={e=>setCreativeType(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded">
            <option value="">{t('ads.filters.creativeType.title')}</option>
            <option value="image">{t('ads.filters.creativeType.image')}</option>
            <option value="video">{t('ads.filters.creativeType.video')}</option>
            <option value="carousel">{t('ads.filters.creativeType.carousel')}</option>
          </select>
        </div>
      </div>
      {selectedIds.size>0 && (
        <div className="bg-indigo-900/30 border border-indigo-500/30 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="bg-indigo-600 text-white text-xs font-bold px-2 py-1 rounded-md">{selectedIds.size}</span>
            <span className="text-sm text-indigo-200">{t('ads.batch.selected')}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={()=>batchUpdateStatus('ACTIVE')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border-blue-600/30" disabled={batchLoading || !manualAccessToken}>{batchLoading?t('ads.batch.running'):t('ads.batch.activate')}</button>
            <button onClick={()=>batchUpdateStatus('PAUSED')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600" disabled={batchLoading || !manualAccessToken}>{t('ads.batch.pause')}</button>
            <button onClick={()=>batchUpdateStatus('ARCHIVED')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600" disabled={batchLoading || !manualAccessToken}>{t('ads.batch.archive')}</button>
            <button onClick={()=>batchUpdateStatus('DELETED')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-rose-600/20 text-rose-400 hover:bg-rose-600/30 border-rose-600/30" disabled={batchLoading || !manualAccessToken}>{t('ads.batch.delete')}</button>
            <button onClick={openSelectedInAdsManager} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600">{t('ads.batch.openManager')}</button>
            <button onClick={exportSelected} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600">{t('ads.batch.exportSelected')}</button>
            <button onClick={copySelectedIds} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600">{t('ads.batch.copyIds')}</button>
            <button onClick={batchExportInsights} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600">{t('ads.batch.exportInsights')}</button>
            <button onClick={copySelectedPreviewLinks} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600">{t('ads.batch.copyPreviews')}</button>
            <button onClick={openSelectedPreviews} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600">{t('ads.batch.openPreviews')}</button>
            <button onClick={clearSelection} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600">{t('ads.batch.clearSelection')}</button>
            <button onClick={invertSelection} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border bg-slate-700 text-slate-300 hover:bg-slate-600 border-slate-600">{t('ads.batch.invertSelection')}</button>
          </div>
          <div className="flex items-center gap-3">
            {batchError && <div className="text-rose-400 text-xs">{batchError}</div>}
            {batchInfo && <div className="text-indigo-200 text-xs">{t('ads.batch.summary', { done: batchInfo.done, total: batchInfo.total, failed: batchInfo.failed })}</div>}
            {batchFailedIds.length>0 && (
              <button onClick={()=>{ try { navigator.clipboard.writeText(batchFailedIds.join('\n')); } catch {} }} className="px-2 py-1 rounded bg-slate-800 text-slate-200 text-xs">{t('ads.batch.copyFailedIds')}</button>
            )}
          </div>
        </div>
      )}
      <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 font-medium">
              <tr>
                <th className="px-6 py-4 w-10">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === visibleAds.length && visibleAds.length>0}
                    onChange={toggleSelectAll}
                    disabled={visibleAds.length===0}
                    className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900 disabled:opacity-50"
                  />
                </th>
                <th className="px-6 py-4 text-center">{t('ads.table.id')}</th>
                <th className="px-6 py-4">{t('ads.table.name')}</th>
                <th className="px-6 py-4">{t('ads.table.status')}</th>
                <th className="px-6 py-4">{t('ads.table.adset')}</th>
                <th className="px-6 py-4">{t('ads.table.adsetName')}</th>
                <th className="px-6 py-4">{t('ads.table.campaign')}</th>
                <th className="px-6 py-4">{t('ads.table.campaignName')}</th>
                <th className="px-6 py-4">{t('ads.table.created')}</th>
                <th className="px-6 py-4">{t('ads.table.preview')}</th>
                <th className="px-6 py-4">{t('ads.table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {visibleAds.length>0 ? visibleAds.map(a=> (
                <tr key={a.id} className={`transition-colors ${selectedIds.has(String(a.id)) ? 'bg-indigo-900/20' : 'hover:bg-slate-800/50'}`}>
                  <td className="px-6 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(String(a.id))}
                      onChange={()=>toggleSelection(String(a.id))}
                      className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900"
                    />
                  </td>
                  <td className="px-6 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-slate-300 font-mono">{String(a.id)}</span>
                      {String(filter.profileId||'') && (
                        <div className="flex items-center justify-end gap-2">
                          {(() => { const prof = profiles.find(pr => pr.id === String(filter.profileId)); const isRunning = !!prof && prof.status === BrowserStatus.RUNNING; return (
                            <button onClick={() => rowToggleStatus(String(filter.profileId))} className={`p-2 rounded-lg transition-colors ${isRunning ? 'bg-rose-900/20 text-rose-400 hover:bg-rose-900/40' : 'bg-emerald-900/20 text-emerald-400 hover:bg-emerald-900/40'}`} title={isRunning ? '停止浏览器' : '启动浏览器'}>
                              {isRunning ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                            </button>
                          ); })()}
                          <button onClick={() => rowEditProfile(String(filter.profileId))} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors" title="编辑配置">
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => rowGetAndSaveTokens(String(filter.profileId))} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors" title="获取TOKEN并保存">
                            <Wallet className="w-4 h-4" />
                          </button>
                          <button onClick={() => rowCheckLoginStatus(String(filter.profileId))} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors" title="检查登录状态">
                            <ShieldCheck className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-3">{a.name || ''}</td>
                  <td className="px-6 py-3">{a.effective_status || a.status || ''}</td>
                  <td className="px-6 py-3 font-mono text-slate-400">{a.adset_id || ''}</td>
                  <td className="px-6 py-3">{adsetNames[String(a.adset_id||'')] || ''}</td>
                  <td className="px-6 py-3 font-mono text-slate-400">{a.campaign_id || ''}</td>
                  <td className="px-6 py-3">{campaignNames[String(a.campaign_id||'')] || ''}</td>
                  <td className="px-6 py-3 font-mono text-slate-400">{a.created_time || ''}</td>
                  <td className="px-6 py-3">
                    {a.creative?.preview_shareable_url ? (
                      <div className="flex items-center gap-2">
                        <a href={a.creative.preview_shareable_url} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 underline">{t('ads.table.preview')}</a>
                        <button onClick={()=>{ try { navigator.clipboard.writeText(String(a.creative.preview_shareable_url)); } catch {} }} className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 text-[11px]">{t('ads.actions.copy')}</button>
                      </div>
                    ) : ''}
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => { setSelectedAd(a); setIsDetailsOpen(true); }} className="px-2 py-1 rounded bg-slate-800 text-slate-200 hover:bg-slate-700">查看</button>
                      {String(act) && (
                        <a href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${String(act)}&selected_ad_ids=${a.id}`} target="_blank" rel="noreferrer" className="px-2 py-1 rounded bg-slate-800 text-slate-200 hover:bg-slate-700">{t('ads.actions.manage')}</a>
                      )}
                    </div>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={10} className="text-center py-12 text-slate-500">{t('ads.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {isDetailsOpen && selectedAd && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">{t('ads.details.title')}</h3>
              <button onClick={() => setIsDetailsOpen(false)} className="text-slate-400 hover:text-white p-2">{t('ads.details.close')}</button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-slate-400 text-sm">{t('ads.details.fields.id')}</div>
                  <div className="text-white font-mono">{selectedAd.id}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">{t('ads.details.fields.name')}</div>
                  <div className="text-white">{selectedAd.name || ''}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">{t('ads.details.fields.status')}</div>
                  <div className="text-white">{selectedAd.effective_status || selectedAd.status || ''}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">{t('ads.details.fields.created')}</div>
                  <div className="text-white font-mono">{selectedAd.created_time || ''}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">{t('ads.details.fields.adset')}</div>
                  <div className="text-white font-mono">{selectedAd.adset_id || ''}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-sm">{t('ads.details.fields.campaign')}</div>
                  <div className="text-white font-mono">{selectedAd.campaign_id || ''}</div>
                </div>
              </div>
              {selectedAd.creative && (
                <div className="border-t border-slate-800 pt-4 space-y-2">
                  <div className="text-slate-400 text-sm">{t('ads.details.fields.creative')}</div>
                  <div className="text-slate-300 text-sm">{selectedAd.creative.name || selectedAd.creative.id}</div>
                  {selectedAd.creative.thumbnail_url && (
                    <img src={selectedAd.creative.thumbnail_url} alt="thumb" className="max-h-40 rounded border border-slate-800" />
                  )}
                  {selectedAd.creative.preview_shareable_url && (
                    <a href={selectedAd.creative.preview_shareable_url} target="_blank" rel="noreferrer" className="inline-block px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500">{t('ads.table.preview')}</a>
                  )}
                  {selectedAd.creative.object_story_spec && (
                    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <div className="text-slate-400 text-sm">{t('ads.details.fields.link')}</div>
                        <div className="text-slate-200 break-all font-mono">
                          {selectedAd.creative.object_story_spec.link_data?.link || ''}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400 text-sm">{t('ads.details.fields.title')}</div>
                        <div className="text-slate-200">
                          {selectedAd.creative.object_story_spec.link_data?.name || ''}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400 text-sm">{t('ads.details.fields.description')}</div>
                        <div className="text-slate-200">
                          {selectedAd.creative.object_story_spec.link_data?.description || ''}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400 text-sm">{t('ads.details.fields.message')}</div>
                        <div className="text-slate-200">
                          {selectedAd.creative.object_story_spec.link_data?.message || ''}
                        </div>
                      </div>
                      {Array.isArray(selectedAd.creative.object_story_spec?.carousel_data?.child_attachments) && selectedAd.creative.object_story_spec.carousel_data.child_attachments.length>0 && (
                        <div className="md:col-span-2">
                          <div className="text-slate-400 text-sm mb-2">{t('ads.details.fields.carousel')}</div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {selectedAd.creative.object_story_spec.carousel_data.child_attachments.map((att:any,idx:number)=> (
                              <div key={idx} className="border border-slate-800 rounded p-2">
                                {att.image_url && <img src={att.image_url} alt="att" className="max-h-32 w-full object-cover rounded" />}
                                <div className="text-slate-300 text-xs mt-1 truncate">{att.link || ''}</div>
                                <div className="text-slate-400 text-[11px] truncate">{att.name || ''}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="border-t border-slate-800 pt-4 space-y-2">
                <div className="flex items-center gap-2">
                  <select value={insightsDatePreset} onChange={e=>setInsightsDatePreset(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded">
                    <option value="last_7d">最近7天</option>
                    <option value="last_28d">最近28天</option>
                    <option value="yesterday">昨天</option>
                    <option value="today">今天</option>
                  </select>
                  <button onClick={async ()=>{
                    if (!selectedAd || !manualAccessToken) return;
                    setInsightsLoading(true); setInsightsError(''); setAdInsights([]);
                    try {
                      const base = 'https://graph.facebook.com/v20.0';
                      const sbase = ''; 
                      const qs = (u: string) => `${u}${u.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(manualAccessToken)}`;
                      const proxyGet = async (url: string) => {
                        const resp = await fetch(`${sbase}/api/graph`, { 
                          method: 'POST', 
                          headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                          }, 
                          body: JSON.stringify({ url }) 
                        });
                        const json = await resp.json();
                        if (!json || !json.success) throw new Error('proxy_failed');
                        const data = json.data ?? {}; if (data && (data as any).error && (data as any).error.message) throw new Error((data as any).error.message); return data;
                      };
                      const metrics = ['impressions','clicks','spend','ctr'].join(',');
                      const url = qs(`${base}/${selectedAd.id}/insights?fields=${encodeURIComponent(metrics)}&date_preset=${encodeURIComponent(insightsDatePreset)}&period=day`);
                      const data = await proxyGet(url);
                      const list = Array.isArray((data as any)?.data) ? (data as any).data : [];
                      setAdInsights(list);
                    } catch(e:any) { setInsightsError(e?.message || '拉取失败'); } finally { setInsightsLoading(false); }
                  }} className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded disabled:opacity-50" disabled={!manualAccessToken || insightsLoading}>{insightsLoading?'拉取中…':'拉取洞察'}</button>
                  <button onClick={()=>{
                    if (!Array.isArray(adInsights) || adInsights.length===0) return;
                    const headers = ['date','impressions','clicks','spend','ctr'];
                    const lines: string[] = []; lines.push(headers.join(','));
                    adInsights.forEach((m:any)=>{
                      const date = m?.date_start || m?.date || m?.end_time || '';
                      const row = [date, m?.impressions||'', m?.clicks||'', m?.spend||'', m?.ctr||''].join(',');
                      lines.push(row);
                    });
                    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=`ad-${selectedAd.id}-insights.csv`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                  }} className="px-3 py-1.5 bg-slate-800 text-slate-200 rounded disabled:opacity-50" disabled={adInsights.length===0}>导出洞察</button>
                </div>
                {insightsError && <div className="text-rose-400 text-sm">{insightsError}</div>}
                {adInsights.length>0 && (
                  <div className="mt-2 bg-slate-950 border border-slate-800 rounded p-2">
                    {adInsights.slice(0,6).map((m:any,idx:number)=> (
                      <div key={idx} className="grid grid-cols-5 gap-2 text-xs text-slate-300">
                        <span className="font-mono text-slate-400">{m?.date_start || m?.date || m?.end_time || ''}</span>
                        <span className="font-mono text-slate-200">{m?.impressions || ''}</span>
                        <span className="font-mono text-slate-200">{m?.clicks || ''}</span>
                        <span className="font-mono text-slate-200">{m?.spend || ''}</span>
                        <span className="font-mono text-slate-200">{m?.ctr || ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="p-6 border-t border-slate-800 flex justify-end">
              <button onClick={() => setIsDetailsOpen(false)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
