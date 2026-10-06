import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Globe, BarChart3, Settings, LogOut, Cpu, Languages, Menu, X, ChevronDown, Wallet, Home, MessageSquare, Shield, ShieldCheck, Users, Phone, RefreshCw, Terminal, ListChecks } from 'lucide-react';
import { Platform } from '../types';
import { trackNav } from '../services/analytics';
import { AIChat } from './AIChat';
import { subscribe as subscribeJobs, snapshot as jobsSnapshot } from './jobQueue';
import { useAppContext } from './AppContext';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  title: string;
  onLogout?: () => void;
}

interface MenuItem {
    id: string;
    icon?: React.ElementType;
    label: string;
    children?: MenuItem[];
    adminOnly?: boolean;
}

const languages: { [key: string]: string } = {
  en: 'English',
  zh: '中文 (Chinese)',
  es: 'Español (Spanish)',
  de: 'Deutsch (German)',
  fr: 'Français (French)',
  hi: 'हिन्दी (Hindi)',
  ja: '日本語 (Japanese)',
  pt: 'Português (Portuguese)',
  ru: 'Русский (Russian)'
};


export const Layout = ({ children, activeTab, onTabChange, title, onLogout }: LayoutProps) => {
  const { user, token } = useAppContext();
  const { t, i18n } = useTranslation();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [backendUrl, setBackendUrl] = useState<string>('');
  const [adAccountsTotal, setAdAccountsTotal] = useState<number>(0);
  const [pagesTotal, setPagesTotal] = useState<number>(0);
  const [adsTotal, setAdsTotal] = useState<number>(0);
  const [bmsTotal, setBmsTotal] = useState<number>(0);
  // 🧵 执行队列徽标：进行中（排队+执行）的任务数
  const [, setJobTick] = useState(0);
  useEffect(() => subscribeJobs(() => setJobTick((n) => n + 1)), []);
  const jobActive = jobsSnapshot().jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  
  const platforms: string[] = useMemo(() => (Object.values(Platform).filter(p => p !== Platform.NONE) as string[]), []);

  const menuItems: MenuItem[] = [
    { id: 'dashboard', icon: BarChart3, label: t('sidebar.dashboard') },
    // 🧵 批量任务执行队列（任务跑在本机后端，导航徽标显示进行中的数量）
    { id: 'job-queue', icon: ListChecks, label: '执行队列' },
    { id: 'official-home', icon: Home, label: '官方首页' },
    { id: 'domain', icon: Globe, label: t('sidebar.domain') },
    { id: 'proxy-nav', icon: Globe, label: t('sidebar.proxyNav') },
    { id: 'servers', icon: Layers, label: t('sidebar.servers') },
    { id: 'email-system', icon: MessageSquare, label: '临时邮箱' },
    { id: 'sms-service', icon: Phone, label: '接码系统' },
    { id: 'captcha-service', icon: ShieldCheck, label: '验证码识别' },
    ...(user?.role === 'superadmin' ? [
      { id: 'super-admin', icon: ShieldCheck, label: '系统管理' },
      { id: 'users', icon: Users, label: '用户管理', adminOnly: true }
    ] : [
      { id: 'users', icon: Users, label: '团队管理', adminOnly: true }
    ]),
    { 
      id: 'platforms', 
      icon: Globe, 
      label: t('sidebar.platforms'),
      children: platforms.map(p => {
        if (p === Platform.META) {
          return {
            id: 'meta', // Simple ID for the collapsible menu
            label: p,
              children: [
                { id: 'meta-profiles', label: t('sidebar.meta.profiles') },
                { id: 'meta-pages', label: `${t('sidebar.meta.pages')} (${pagesTotal})` },
                { id: 'meta-posts', label: '主页广告贴文' },
                { id: 'meta-messages', label: '消息对话' },
                { id: 'meta-ai-prompt', label: '提示词设置' },
                { id: 'meta-ai-queue', label: 'AI 回复队列' },
                { id: 'meta-bms', label: `${t('sidebar.meta.bms')} (${bmsTotal})` },
                { id: 'meta-adAccounts', label: `${t('sidebar.meta.adAccounts')} (${adAccountsTotal})` },
                { id: 'meta-ads', label: `广告 (${adsTotal})` },
                { id: 'meta-insights', label: '数据追踪' },
                { id: 'meta-billing', label: '账单查询' },
              ]
            };
        }
        if (p === Platform.TIKTOK) {
          return {
            id: 'tiktok',
            label: p,
            children: [
              { id: 'tiktok-profiles', label: '账号列表' },
              { id: 'tiktok-registration', label: '账号注册' },
              { id: 'tiktok-ads', label: '广告发布' }
            ]
          };
        }
        if (p === Platform.INSTAGRAM) {
          return {
            id: 'instagram',
            label: p,
            children: [
              { id: 'instagram-profiles', label: '账号列表' },
              { id: 'instagram-registration', label: '账号注册' }
            ]
          };
        }
        if (p === Platform.X) {
          return {
            id: 'x',
            label: p,
            children: [
              { id: 'x-profiles', label: '账号列表' },
              { id: 'x-registration', label: '账号注册' }
            ]
          };
        }
        if (p === Platform.GOOGLE) {
          return {
            id: 'google',
            label: p,
            children: [
              { id: 'google-profiles', label: '账号列表' },
              { id: 'google-adAccounts', label: '广告账户' },
            ]
          };
        }
        return { id: p, label: p };
      })
    },
    { id: 'cloudflare', icon: Globe, label: t('sidebar.cloudflare') },
    { 
      id: 'automation-group', 
      icon: Cpu, 
      label: t('sidebar.automation'),
      children: [
        { id: 'ad-publish-hub', label: '智能发布平台' },
        { id: 'automation', label: '广告发布' },
        { id: 'ad-templates', label: t('sidebar.adTemplates') },
        { id: 'page-template', label: '主页创建模板' },
        { id: 'billing-template', label: '账单地址模板' },
        { id: 'card-bind-template', label: '绑卡表单模板' },
      ]
    },
    { id: 'billing', icon: Wallet, label: t('sidebar.payment'), children: [
        { id: 'recharge', label: 'U 充值' },
        { id: 'payment', label: '卡片管理' },
        { id: 'payment-transactions', label: '交易记录' }
      ] },
    { id: 'settings', icon: Settings, label: t('sidebar.settings') },
    { id: 'browser-logs', icon: Terminal, label: '执行日志' },
  ];

  const [openMenus, setOpenMenus] = useState<Set<string>>(() => new Set(['platforms', 'meta', 'billing', 'automation-group']));
  
  useEffect(() => {
    if (platforms.includes(activeTab) && activeTab !== Platform.META) {
      setOpenMenus(prev => new Set(prev).add('platforms'));
    }
    if (activeTab.startsWith('meta-')) {
      setOpenMenus(prev => new Set(prev).add('platforms').add('meta'));
    }
    if (activeTab.startsWith('tiktok-')) {
      setOpenMenus(prev => new Set(prev).add('platforms').add('tiktok'));
    }
    if (activeTab === 'automation' || activeTab === 'ad-templates') {
      setOpenMenus(prev => new Set(prev).add('automation-group'));
    }
  }, [activeTab]);

  useEffect(() => {
    const url = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || '';
    setBackendUrl(url);
    if (!url) { setBackendOnline(false); return; }
    const base = url.replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    fetch(`${base}/health`, { 
      signal: controller.signal,
      headers: {
        'X-Api-Secret': (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || ''
      }
    }).then(r => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(() => setBackendOnline(true)).catch(() => setBackendOnline(false)).finally(() => clearTimeout(timer));
  }, []);

  useEffect(() => {
    const fetchAdAccountsTotal = async () => {
      if (!token) return;
      try {
        const base = '';
        const resp = await fetch(`${base}/api/adaccounts?_t=${Date.now()}`, { 
          headers: { 
            'Cache-Control': 'no-cache',
            'Authorization': `Bearer ${token}`
          } 
        });
        const json = await resp.json();
        const list = Array.isArray(json?.data) ? json.data : [];
        setAdAccountsTotal(list.length);
      } catch {}
    };
    fetchAdAccountsTotal();
    const handler = () => fetchAdAccountsTotal();
    window.addEventListener('adaccounts-refresh', handler);
    return () => window.removeEventListener('adaccounts-refresh', handler);
  }, [token]);

  useEffect(() => {
    const fetchPagesTotal = async () => {
      if (!token) return;
      try {
        const base = '';
        const resp = await fetch(`${base}/api/pages?_t=${Date.now()}`, {
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Cache-Control': 'no-cache'
          }
        });
        const json = await resp.json();
        const list = (json && Array.isArray(json.data)) ? json.data : (Array.isArray(json) ? json : []);
        setPagesTotal(list.length);
      } catch {}
    };
    const fetchBmsTotal = async () => {
      if (!token) return;
      try {
        const base = '';
        const resp = await fetch(`${base}/api/businesses?_t=${Date.now()}`, {
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Cache-Control': 'no-cache'
          }
        });
        const json = await resp.json();
        const list = (json && Array.isArray(json.data)) ? json.data : (Array.isArray(json) ? json : []);
        const valid = list.filter((x: any) => x && (x.businessId || x.id));
        setBmsTotal(valid.length);
      } catch {}
    };
    const fetchAdsTotal = async () => {
      if (!token) return;
      try {
        const base = '';
        const resp = await fetch(`${base}/api/ads?_t=${Date.now()}`, {
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Cache-Control': 'no-cache'
          }
        });
        const json = await resp.json();
        const list = (json && Array.isArray(json.data)) ? json.data : (Array.isArray(json) ? json : []);
        setAdsTotal(list.length);
      } catch {}
    };
    fetchPagesTotal();
    fetchBmsTotal();
    fetchAdsTotal();
    const pagesHandler = () => fetchPagesTotal();
    const bmsHandler = () => fetchBmsTotal();
    const adsHandler = () => fetchAdsTotal();
    window.addEventListener('pages-refresh', pagesHandler);
    window.addEventListener('businesses-refresh', bmsHandler);
    window.addEventListener('adaccounts-refresh', adsHandler); // Also refresh ads on account refresh
    return () => {
      window.removeEventListener('pages-refresh', pagesHandler);
      window.removeEventListener('businesses-refresh', bmsHandler);
      window.removeEventListener('adaccounts-refresh', adsHandler);
    };
  }, [token]);

  
  
  const handleTabChange = (tab: string) => {
    try { trackNav(activeTab, tab, i18n.language, { title }); } catch {}
    onTabChange(tab);
    if(window.innerWidth < 1024) {
      setIsSidebarOpen(false);
    }
  };
  
  const toggleMenu = (id: string) => {
    setOpenMenus(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 1024) {
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden">
      {/* Overlay for mobile sidebar */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-20 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        ></div>
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 ${isSidebarCollapsed ? 'w-16' : 'w-64'} bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 z-30
                    transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0
                    ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="p-4 flex items-center gap-3">
          <button onClick={() => setIsSidebarCollapsed(v => !v)} className="p-2 text-slate-300 hover:text-white hidden lg:block">
            <Menu className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-2.5 space-y-1.5 overflow-y-auto">
          {menuItems.filter(item => !item.adminOnly || (user && (user.role === 'admin' || user.role === 'superadmin'))).map((item) => {
            if (!item.children) {
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    if (item.id === 'official-home') {
                      window.open('/home.html', '_blank');
                      return;
                    }
                    if (item.id === 'cloudflare') {
                      handleTabChange('cloudflare');
                      if (window.innerWidth < 1024) { setIsSidebarOpen(false); }
                      return;
                    }
                    handleTabChange(item.id);
                  }}
                  className={`w-full flex items-center ${isSidebarCollapsed ? 'justify-center' : 'gap-3'} px-3 py-2.5 rounded-lg transition-all duration-200 ${
                    activeTab === item.id
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/50'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  <item.icon className="w-5 h-5" />
                  {!isSidebarCollapsed && <span className="font-medium text-left">{item.label}</span>}
                  {item.id === 'job-queue' && jobActive > 0 && (
                    isSidebarCollapsed ? (
                      <span className="absolute -mt-5 ml-4 min-w-[16px] h-4 px-1 rounded-full bg-indigo-500 text-white text-[10px] leading-4 text-center">{jobActive}</span>
                    ) : (
                      <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-indigo-500 text-white text-[11px] leading-5 text-center">{jobActive}</span>
                    )
                  )}
                </button>
              );
            }
            
            const isMenuOpen = openMenus.has(item.id);
            const isMenuActive = (item.id === 'platforms' && (platforms.includes(activeTab) || activeTab.startsWith('meta-')));

            return (
              <div key={item.id}>
                <button
                  onClick={() => toggleMenu(item.id)}
                  className={`w-full flex items-center justify-between ${isSidebarCollapsed ? '' : 'gap-3'} px-3 py-2.5 rounded-lg transition-all duration-200 ${
                    isMenuActive
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  <div className={`flex items-center ${isSidebarCollapsed ? 'justify-center w-full' : 'gap-3'}`}>
                    <item.icon className="w-5 h-5" />
                    {!isSidebarCollapsed && <span className="font-medium">{item.label}</span>}
                  </div>
                  {!isSidebarCollapsed && <ChevronDown className={`w-4 h-4 transition-transform ${isMenuOpen ? 'rotate-180' : ''}`} />}
                </button>
                {isMenuOpen && (
                  <div className="pl-5 pt-1.5 space-y-0.5">
                    {item.children.map(platformItem => {
                      if (platformItem.children) { // This is Meta with a submenu
                        const isSubMenuOpen = openMenus.has(platformItem.id);
                        const isSubMenuActive = activeTab.startsWith(platformItem.id + "-");

                        return (
                          <div key={platformItem.id}>
                            <button
                              onClick={() => toggleMenu(platformItem.id)}
                              className={`w-full flex items-center justify-between gap-3 px-3 py-1.5 rounded-md text-sm transition-colors ${
                                isSubMenuActive ? 'text-white' : 'text-slate-400 hover:bg-slate-700 hover:text-slate-100'
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <span className={`w-1.5 h-1.5 rounded-full ${isSubMenuActive ? 'bg-white' : 'bg-current opacity-50'}`}></span>
                                <span>{platformItem.label}</span>
                              </div>
                              <ChevronDown className={`w-4 h-4 transition-transform ${isSubMenuOpen ? 'rotate-180' : ''}`} />
                            </button>
                            {isSubMenuOpen && (
                              <div className="pl-6 pt-1 space-y-0.5">
                                {platformItem.children.map(subItem => {
                                  const isActive = activeTab === subItem.id;
                                  return (
                                  <button
                                      key={subItem.id}
                                      onClick={() => handleTabChange(subItem.id)}
                                      className={`w-full text-left px-3 py-1.5 rounded text-xs transition-colors ${
                                        isActive ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-700'
                                      }`}
                                  >
                                      {subItem.label}
                                      {subItem.id === 'meta-pages' && pagesTotal > 0 && (
                                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800 text-[10px]">
                                          {pagesTotal}
                                        </span>
                                      )}
                                      {subItem.id === 'meta-bms' && bmsTotal > 0 && (
                                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800 text-[10px]">
                                          {bmsTotal}
                                        </span>
                                      )}
                                      {subItem.id === 'meta-adAccounts' && adAccountsTotal > 0 && (
                                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800 text-[10px]">
                                          {adAccountsTotal}
                                        </span>
                                      )}
                                  </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      }

                      // This is a regular platform item
                      const isActive = activeTab === platformItem.id;
                      return (
                        <button
                          key={platformItem.id}
                          onClick={() => handleTabChange(platformItem.id)}
                          className={`w-full flex items-center gap-3 px-4 py-2 rounded-md text-sm transition-colors ${
                            isActive
                              ? 'bg-indigo-600 text-white'
                              : 'text-slate-400 hover:bg-slate-700 hover:text-slate-100'
                          }`}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50"></span>
                          <span>{platformItem.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {!isSidebarCollapsed && (
        <div className="p-3 space-y-3 border-t border-slate-800">
          <div className="px-4 py-2 bg-slate-800/50 rounded-lg border border-slate-700/50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">
                {user?.username?.substring(0, 1).toUpperCase() || user?.email?.substring(0, 1).toUpperCase() || 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{user?.username || user?.email || '用户'}</p>
                <p className="text-[10px] text-slate-400 truncate">{user?.email || ''}</p>
                <p className="text-[10px] text-slate-500 truncate">
                  {user?.role === 'superadmin' ? '超级管理员' : user?.role === 'admin' ? '团队管理员' : '团队成员'}
                </p>
              </div>
            </div>
          </div>
          
          {/* 🚀 刷新数据按钮 - 局部静默刷新 */}
          <button onClick={() => { 
            // 清除所有 API 缓存
            Object.keys(localStorage).filter(k => k.startsWith('apiCache:')).forEach(k => localStorage.removeItem(k));
            // 触发各组件刷新事件（局部刷新，不刷新整个页面）
            window.dispatchEvent(new Event('profiles-refresh'));
            window.dispatchEvent(new Event('adaccounts-refresh'));
          }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800/50 transition-all" title="清除缓存并刷新数据">
            <RefreshCw className="w-3.5 h-3.5" />
            <span>刷新数据</span>
          </button>

          <div className="relative">
             <Languages className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
             <select
                value={i18n.language}
                onChange={(e) => i18n.changeLanguage(e.target.value)}
                className="w-full appearance-none bg-slate-800 border border-slate-700 text-slate-300 rounded-lg pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
             >
               {Object.keys(languages).map((lang) => (
                 <option key={lang} value={lang}>
                   {languages[lang]}
                 </option>
               ))}
             </select>
          </div>
          <button 
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-3 text-slate-400 hover:text-rose-400 hover:bg-rose-950/30 rounded-lg transition-colors"
          >
            <LogOut className="w-5 h-5" />
            <span className="font-medium">{t('sidebar.signOut')}</span>
          </button>
        </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto relative">
         {/* Mobile Header */}
        <header className="sticky top-0 lg:hidden py-3 px-0 bg-slate-950/80 backdrop-blur-sm border-b border-slate-800 flex items-center z-10">
            <button onClick={() => setIsSidebarOpen(true)} className="p-2 mr-2 text-slate-300">
                <Menu className="w-6 h-6" />
            </button>
            <h2 className="text-lg font-semibold text-white truncate">{title}</h2>
         </header>

        

        <div className="w-full py-3 sm:py-4 lg:py-6">
          {children}
        </div>

        <AIChat />
      </main>
    </div>
  );
};
