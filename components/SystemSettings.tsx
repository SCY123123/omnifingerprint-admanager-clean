import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, RefreshCw, Globe, Server, Shield, Database, Monitor, CheckCircle, XCircle, HardDrive, Activity, CreditCard, Key } from 'lucide-react';

interface ServerConfig {
  launchServerUrl: string;
  storageServerUrl: string;
  apiSecret: string;
  webhookUrl: string;
}

interface BrowserSettings {
  autoClearCache: boolean;
  autoCloseTimeout: number;
  screenshotOnError: boolean;
  userDataDir: string;
  browserType: 'chrome' | 'edge' | 'omnifp';
  maxConcurrentLaunches: number;
  forceWindowSize: string;
  omnifpSync: boolean;
}

interface S5TunnelConfig {
  host: string;
  port: number;
  type: 'socks5' | 'http';
}

interface CardApiConfig {
  provider: string;         // stripe | paypal | custom
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  baseUrl: string;          // custom provider URL
  defaultBillingAddress: string;
  testMode: boolean;
}

interface SystemInfo {
  launchServerOnline: boolean;
  storageServerOnline: boolean;
  omnifpOnline: boolean;
  dbSize: string;
  profileCount: number;
  adAccountCount: number;
  pageCount: number;
  pixelCount: number;
  billingMethodCount: number;
}

export const SystemSettings: React.FC = () => {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resettingTunnel, setResettingTunnel] = useState(false);
  const [activeTab, setActiveTab] = useState<'server' | 'browser' | 'cardapi' | 'info'>('server');
  const [systemInfo, setSystemInfo] = useState<SystemInfo>({
    launchServerOnline: false,
    storageServerOnline: false,
    omnifpOnline: false,
    dbSize: '0 B',
    profileCount: 0,
    adAccountCount: 0,
    pageCount: 0,
    pixelCount: 0,
    billingMethodCount: 0,
  });
  const [testingDb, setTestingDb] = useState(false);

  const [config, setConfig] = useState<ServerConfig>(() => {
    try {
      const saved = localStorage.getItem('settings:serverConfig');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      launchServerUrl: (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999',
      storageServerUrl: (import.meta as any).env?.VITE_STORAGE_SERVER_URL || 'http://localhost:7000',
      apiSecret: (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '',
      webhookUrl: '',
    };
  });

  const [browserSettings, setBrowserSettings] = useState<BrowserSettings>(() => {
    try {
      const saved = localStorage.getItem('settings:browserSettings');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      autoClearCache: true,
      autoCloseTimeout: 30,
      screenshotOnError: true,
      userDataDir: '',
      browserType: 'chrome',
      maxConcurrentLaunches: 5,
      forceWindowSize: '',
      omnifpSync: false,
    };
  });

  // 🧵 执行队列并发数（批量任务同时跑几个）
  const [queueConc, setQueueConc] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('settings:queueConcurrency'));
      if (v >= 1 && v <= 10) return v;
    } catch {}
    return 2;
  });

  const [cardApiConfig, setCardApiConfig] = useState<CardApiConfig>(() => {
    try {
      const saved = localStorage.getItem('settings:cardApiConfig');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      provider: 'stripe',
      apiKey: '',
      apiSecret: '',
      webhookSecret: '',
      baseUrl: '',
      defaultBillingAddress: '',
      testMode: true,
    };
  });

  const [s5Tunnel, setS5Tunnel] = useState<S5TunnelConfig>(() => {
    try {
      const saved = localStorage.getItem('settings:s5Tunnel');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { host: '127.0.0.1', port: 10808, type: 'socks5' };
  });

  // 保存服务器配置
  const saveServerConfig = async () => {
    setSaving(true);
    try {
      localStorage.setItem('settings:serverConfig', JSON.stringify(config));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('保存配置失败', e);
    } finally {
      setSaving(false);
    }
  };

  // 保存浏览器设置
  const saveBrowserSettings = async () => {
    setSaving(true);
    try {
      localStorage.setItem('settings:browserSettings', JSON.stringify(browserSettings));
      // 🚀 同步并发数到后端 Puppeteer 服务
      try {
        const launchBase = config.launchServerUrl.replace(/\/$/, '') + '/api';
        await fetch(`${launchBase}/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': config.apiSecret },
          body: JSON.stringify({ maxConcurrentLaunches: browserSettings.maxConcurrentLaunches })
        });
      } catch {}
      // 🧵 同步执行队列并发数（批量任务并发）
      try {
        localStorage.setItem('settings:queueConcurrency', String(queueConc));
        const launchBase = config.launchServerUrl.replace(/\/$/, '') + '/api';
        await fetch(`${launchBase}/jobs/settings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': config.apiSecret },
          body: JSON.stringify({ concurrency: queueConc })
        });
      } catch {}
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('保存设置失败', e);
    } finally {
      setSaving(false);
    }
  };

  // 保存卡片 API 配置
  const saveCardApiConfig = async () => {
    setSaving(true);
    try {
      localStorage.setItem('settings:cardApiConfig', JSON.stringify(cardApiConfig));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('保存卡片 API 配置失败', e);
    } finally {
      setSaving(false);
    }
  };

  // 保存 S5 隧道配置到后端
  const saveS5Tunnel = async () => {
    setSaving(true);
    try {
      localStorage.setItem('settings:s5Tunnel', JSON.stringify(s5Tunnel));
      // 同步到后端 Launch Server
      try {
        const launchBase = config.launchServerUrl.replace(/\/$/, '') + '/api';
        await fetch(`${launchBase}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': config.apiSecret },
          body: JSON.stringify({ s5TunnelHost: s5Tunnel.host, s5TunnelPort: s5Tunnel.port, s5TunnelType: s5Tunnel.type })
        });
      } catch (e) {
        console.warn('同步 S5 配置到后端失败，将在下次启动时生效', e);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('保存 S5 配置失败', e);
    } finally {
      setSaving(false);
    }
  };

  // 🔄 一键重置代理隧道 — 电脑休眠唤醒后隧道掉线时使用
  const resetProxyTunnels = async () => {
    setResettingTunnel(true);
    try {
      const launchBase = config.launchServerUrl.replace(/\/$/, '') + '/api';
      const r = await fetch(`${launchBase}/proxy/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': config.apiSecret },
        body: JSON.stringify({ reason: '前端手动重置' }),
        signal: AbortSignal.timeout(15000)
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.success) {
        alert(j.message || '代理隧道已重置');
      } else {
        alert(`重置失败: ${j.error || ('HTTP ' + r.status)}`);
      }
    } catch (e: any) {
      alert(`重置失败: ${e?.message || '未知错误'}`);
    } finally {
      setResettingTunnel(false);
    }
  };

  // 从后端加载 S5 隧道配置
  const loadS5TunnelFromBackend = async () => {
    try {
      const launchBase = config.launchServerUrl.replace(/\/$/, '') + '/api';
      const r = await fetch(`${launchBase}/config`, {
        headers: { 'X-Api-Secret': config.apiSecret },
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.success) {
          const tunnelType = (j.s5TunnelType || s5Tunnel.type || 'socks5').toLowerCase();
          const loaded: S5TunnelConfig = {
            host: j.s5TunnelHost || s5Tunnel.host,
            port: j.s5TunnelPort || s5Tunnel.port,
            type: (tunnelType === 'http' ? 'http' : 'socks5'),
          };
          setS5Tunnel(loaded);
          localStorage.setItem('settings:s5Tunnel', JSON.stringify(loaded));
        }
      }
    } catch (e) {
      console.debug('从后端加载 S5 配置失败，使用本地存储值', e);
    }
  };

  // 测试卡片 API 连接
  const testCardApi = async () => {
    setTestingDb(true);
    try {
      const base = cardApiConfig.baseUrl || 'https://api.stripe.com';
      const r = await fetch(`${base}/v1/balance`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'Authorization': `Bearer ${cardApiConfig.apiKey}` }
      });
      if (r.status === 200 || r.status === 401) {
        alert(cardApiConfig.apiKey ? 'API 密钥有效，连接成功' : '请先填写 API 密钥');
      } else {
        alert(`连接失败: HTTP ${r.status}`);
      }
    } catch (e: any) {
      alert(`连接测试失败: ${e?.message || '未知错误'}`);
    } finally {
      setTestingDb(false);
    }
  };

  // 测试所有服务器连接
  const testConnections = async () => {
    setTestingDb(true);
    const info = { ...systemInfo };

    // 测试 Launch Server
    try {
      const base = config.launchServerUrl.replace(/\/$/, '');
      const r = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'X-Api-Secret': config.apiSecret }
      });
      info.launchServerOnline = r.ok;
    } catch {
      info.launchServerOnline = false;
    }

    // 测试 Storage Server
    try {
      const base = config.storageServerUrl.replace(/\/$/, '');
      const r = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      info.storageServerOnline = r.ok;
    } catch {
      info.storageServerOnline = false;
    }

    // 🦎 测试 OmniFingerprint 指纹浏览器（通过后端代理，避免 CORS 问题）
    try {
      const base = config.launchServerUrl.replace(/\/$/, '');
      const r = await fetch(`${base}/api/health/omnifp`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'X-Api-Secret': config.apiSecret }
      });
      const j = await r.json();
      info.omnifpOnline = j?.online === true;
    } catch {
      info.omnifpOnline = false;
    }

    // 获取数据库统计
    try {
      const r = await fetch(`/api/adaccounts?_t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
      });
      const j = await r.json();
      if (j?.success && Array.isArray(j?.data)) {
        info.adAccountCount = j.data.length;
      }
    } catch {}

    try {
      const r = await fetch(`/api/profiles?_t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
      });
      const j = await r.json();
      if (j?.success && Array.isArray(j?.data)) {
        info.profileCount = j.data.length;
      }
    } catch {}

    try {
      const r = await fetch(`/api/pages?_t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
      });
      const j = await r.json();
      if (j?.success && Array.isArray(j?.data)) {
        info.pageCount = j.data.length;
      }
    } catch {}

    try {
      const r = await fetch(`/api/billing-methods`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
      });
      const j = await r.json();
      if (j?.success && Array.isArray(j?.data)) {
        info.billingMethodCount = j.data.length;
      }
    } catch {}

    setSystemInfo(info);
    setTestingDb(false);
  };

  useEffect(() => {
    testConnections();
    loadS5TunnelFromBackend();
  }, []);

  const tabs = [
    { id: 'server' as const, label: '服务器配置', icon: Server },
    { id: 'cardapi' as const, label: '卡密API', icon: CreditCard },
    { id: 'browser' as const, label: '浏览器设置', icon: Monitor },
    { id: 'info' as const, label: '系统信息', icon: Activity },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-white">系统设置</h2>
          <p className="text-slate-400">管理系统服务器配置、浏览器参数与全局信息</p>
        </div>
        <div className="flex gap-2">
          <button onClick={testConnections} disabled={testingDb} className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm transition-all">
            <RefreshCw className={`w-4 h-4 ${testingDb ? 'animate-spin' : ''}`} />
            刷新状态
          </button>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-2 mb-6 border-b border-slate-800 pb-2">
        {tabs.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                activeTab === tab.id
                  ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 服务器配置 */}
      {activeTab === 'server' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
              <Globe className="w-5 h-5 text-indigo-400" />
              后端服务器
            </h3>
            <div className="grid gap-4 max-w-xl">
              <div>
                <label className="block text-sm text-slate-300 mb-1">Launch Server URL（浏览器控制服务）</label>
                <input
                  type="text"
                  value={config.launchServerUrl}
                  onChange={e => setConfig({ ...config, launchServerUrl: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                  placeholder="http://localhost:9999"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">Storage Server URL（数据存储服务）</label>
                <input
                  type="text"
                  value={config.storageServerUrl}
                  onChange={e => setConfig({ ...config, storageServerUrl: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                  placeholder="http://localhost:7000"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">API 密钥</label>
                <input
                  type="password"
                  value={config.apiSecret}
                  onChange={e => setConfig({ ...config, apiSecret: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white font-mono"
                  placeholder="api_secret"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">Webhook URL（可选）</label>
                <input
                  type="text"
                  value={config.webhookUrl}
                  onChange={e => setConfig({ ...config, webhookUrl: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                  placeholder="https://hooks.example.com/..."
                />
              </div>
            </div>
            <div className="mt-6 flex gap-3">
              <button onClick={saveServerConfig} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition-all disabled:opacity-50">
                <Save className="w-4 h-4" />
                {saving ? '保存中...' : (saved ? '已保存 ✓' : '保存配置')}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
              <Server className="w-5 h-5 text-indigo-400" />
              服务状态
            </h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">
                <span className="text-sm text-slate-300">Launch Server</span>
                <span className={`flex items-center gap-1.5 text-sm ${systemInfo.launchServerOnline ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {systemInfo.launchServerOnline ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  {systemInfo.launchServerOnline ? '在线' : '离线'}
                </span>
              </div>
              <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">
                <span className="text-sm text-slate-300">Storage Server</span>
                <span className={`flex items-center gap-1.5 text-sm ${systemInfo.storageServerOnline ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {systemInfo.storageServerOnline ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  {systemInfo.storageServerOnline ? '在线' : '离线'}
                </span>
              </div>
              <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">
                <span className="text-sm text-slate-300">OmniFingerprint 指纹浏览器</span>
                <span className={`flex items-center gap-1.5 text-sm ${systemInfo.omnifpOnline ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {systemInfo.omnifpOnline ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  {systemInfo.omnifpOnline ? '在线' : '离线'}
                </span>
              </div>
            </div>
          </div>

          {/* 🔌 S5 隧道配置 */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
              <Shield className="w-5 h-5 text-indigo-400" />
              本地隧道代理
            </h3>
            <p className="text-sm text-slate-400 mb-4">
              配置本地 SOCKS5 或 HTTP 代理（Clash / V2Ray / Astrill），浏览器无法直连远程代理时自动通过此隧道转发
            </p>
            <div className="grid gap-4 max-w-xl">
              <div>
                <label className="block text-sm text-slate-300 mb-1">代理主机 (Host)</label>
                <input
                  type="text"
                  value={s5Tunnel.host}
                  onChange={e => setS5Tunnel({ ...s5Tunnel, host: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white font-mono"
                  placeholder="127.0.0.1"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">代理端口 (Port)</label>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={s5Tunnel.port}
                  onChange={e => setS5Tunnel({ ...s5Tunnel, port: parseInt(e.target.value) || 10808 })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white font-mono"
                  placeholder="10808"
                />
                <p className="text-xs text-slate-500 mt-1">默认 10808（Clash / V2Ray 标准端口），Astrill 常见端口 3213/3205/6583/24152，修改后需保存配置方可生效</p>
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">代理类型 (Type)</label>
                <select
                  value={s5Tunnel.type}
                  onChange={e => setS5Tunnel({ ...s5Tunnel, type: e.target.value as 'socks5' | 'http' })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                >
                  <option value="socks5">SOCKS5</option>
                  <option value="http">HTTP (CONNECT)</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">SOCKS5 用于 Clash / V2Ray；HTTP 用于 Astrill 等 HTTP 代理</p>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button onClick={saveS5Tunnel} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition-all disabled:opacity-50">
                <Save className="w-4 h-4" />
                {saving ? '保存中...' : (saved ? '已保存 ✓' : '保存隧道配置')}
              </button>
              <button
                onClick={resetProxyTunnels}
                disabled={resettingTunnel}
                title="电脑休眠/断网后浏览器代理隧道掉线无法恢复时，点此重置：会断开隧道上的旧连接（本地监听端口保留），浏览器下次请求自动重建链路"
                className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm transition-all disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${resettingTunnel ? 'animate-spin' : ''}`} />
                {resettingTunnel ? '重置中...' : '重置代理隧道'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 卡密 API 设置 */}
      {activeTab === 'cardapi' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-indigo-400" />
              信用卡 API 配置
            </h3>
            <div className="grid gap-4 max-w-xl">
              <div>
                <label className="block text-sm text-slate-300 mb-1">服务提供商</label>
                <select
                  value={cardApiConfig.provider}
                  onChange={e => setCardApiConfig({ ...cardApiConfig, provider: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                >
                  <option value="stripe">Stripe</option>
                  <option value="paypal">PayPal Braintree</option>
                  <option value="custom">自定义</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">API 公钥 (Publishable Key)</label>
                <input
                  type="password"
                  value={cardApiConfig.apiKey}
                  onChange={e => setCardApiConfig({ ...cardApiConfig, apiKey: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white font-mono"
                  placeholder="pk_live_xxxxx"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">API 密钥 (Secret Key)</label>
                <input
                  type="password"
                  value={cardApiConfig.apiSecret}
                  onChange={e => setCardApiConfig({ ...cardApiConfig, apiSecret: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white font-mono"
                  placeholder="sk_live_xxxxx"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">Webhook 签名密钥</label>
                <input
                  type="password"
                  value={cardApiConfig.webhookSecret}
                  onChange={e => setCardApiConfig({ ...cardApiConfig, webhookSecret: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white font-mono"
                  placeholder="whsec_xxxxx"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">自定义 API 地址 (仅自定义模式)</label>
                <input
                  type="text"
                  value={cardApiConfig.baseUrl}
                  onChange={e => setCardApiConfig({ ...cardApiConfig, baseUrl: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                  placeholder="https://api.your-provider.com/v1"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">默认账单地址</label>
                <input
                  type="text"
                  value={cardApiConfig.defaultBillingAddress}
                  onChange={e => setCardApiConfig({ ...cardApiConfig, defaultBillingAddress: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                  placeholder="123 Main St, City, Country"
                />
              </div>
              <label className="flex items-center justify-between mt-2">
                <span className="text-sm text-slate-300">测试模式 (Sandbox)</span>
                <input
                  type="checkbox"
                  checked={cardApiConfig.testMode}
                  onChange={e => setCardApiConfig({ ...cardApiConfig, testMode: e.target.checked })}
                  className="w-4 h-4 accent-indigo-500"
                />
              </label>
            </div>
            <div className="mt-6 flex gap-3">
              <button onClick={saveCardApiConfig} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition-all disabled:opacity-50">
                <Save className="w-4 h-4" />
                {saving ? '保存中...' : (saved ? '已保存 ✓' : '保存配置')}
              </button>
              <button onClick={testCardApi} disabled={testingDb} className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm transition-all disabled:opacity-50">
                <Key className="w-4 h-4" />
                {testingDb ? '测试中...' : '测试连接'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 浏览器设置 */}
      {activeTab === 'browser' && (
        <div className="space-y-6">
          {/* 浏览器引擎 */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
              <Monitor className="w-5 h-5 text-indigo-400" />
              浏览器引擎
            </h3>
            <div className="max-w-xl">
              <label className="block text-sm text-slate-300 mb-3">默认浏览器类型</label>
              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  { value: 'chrome', label: 'Google Chrome', desc: 'Chromium 内核，兼容性最好', icon: Globe },
                  { value: 'edge', label: 'Microsoft Edge', desc: '基于 Chromium，支持原生 SOCKS5', icon: Monitor },
                  { value: 'omnifp', label: 'OmniFingerprint 指纹浏览器', desc: '指纹浏览器，适合多开管理', icon: Shield },
                ].map(opt => {
                  const Icon = opt.icon;
                  const active = browserSettings.browserType === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setBrowserSettings({ ...browserSettings, browserType: opt.value as BrowserSettings['browserType'] })}
                      className={`flex flex-col items-start gap-2 p-4 rounded-xl border text-left transition-all ${
                        active
                          ? 'bg-indigo-600/20 border-indigo-600/40 text-indigo-200'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      <div>
                        <div className="text-sm font-medium">{opt.label}</div>
                        <div className="text-xs opacity-70 mt-0.5">{opt.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-slate-500">可通过环境变量 <code className="bg-slate-800 px-1 rounded">BROWSER_TYPE</code> 覆盖此设置</p>
            </div>

            {/* 指纹浏览器数据同步开关 */}
            <div className="mt-4 max-w-xl">
              <label className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800">
                <div>
                  <span className="text-sm text-slate-300">指纹浏览器数据同步</span>
                  <p className="text-xs text-slate-500 mt-0.5">开启后，启动浏览器时自动将代理/UA 配置同步到指纹浏览器环境</p>
                </div>
                <input
                  type="checkbox"
                  checked={browserSettings.omnifpSync}
                  onChange={e => setBrowserSettings({ ...browserSettings, omnifpSync: e.target.checked })}
                  className="w-4 h-4 accent-indigo-500"
                />
              </label>
            </div>
          </div>

          {/* 并发与性能 */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
              <Activity className="w-5 h-5 text-indigo-400" />
              并发与性能
            </h3>
            <div className="grid gap-5 max-w-xl">
              <div>
                <label className="block text-sm text-slate-300 mb-1">最大并发启动数（建议 3~10）</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={browserSettings.maxConcurrentLaunches}
                  onChange={e => setBrowserSettings({ ...browserSettings, maxConcurrentLaunches: Number(e.target.value) })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                />
                <p className="text-xs text-slate-500 mt-1">同时启动的浏览器数量，过高可能导致系统卡顿</p>
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">全局并发数（同时在跑的操作数上限，建议 1~3）</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={queueConc}
                  onChange={e => {
                    const v = Math.max(1, Math.min(10, Number(e.target.value) || 1));
                    setQueueConc(v);
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                />
                <p className="text-xs text-slate-500 mt-1">
                  所有批量任务（获取信息 / 建BM / 建主页 / 发布广告等）合起来同时跑几个操作。
                  例如设为 3：不管提交几个任务，全局最多只有 3 个操作在跑，其余排队。
                  任务由本机后端执行，可在左侧「执行队列」查看进度与取消。
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">强制窗口大小（留空=自适应，如 1920x1080）</label>
                <input
                  type="text"
                  value={browserSettings.forceWindowSize}
                  onChange={e => setBrowserSettings({ ...browserSettings, forceWindowSize: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                  placeholder="留空则跟随窗口自适应"
                />
              </div>
              <label className="flex items-center justify-between">
                <span className="text-sm text-slate-300">启动时自动清除缓存</span>
                <input
                  type="checkbox"
                  checked={browserSettings.autoClearCache}
                  onChange={e => setBrowserSettings({ ...browserSettings, autoClearCache: e.target.checked })}
                  className="w-4 h-4 accent-indigo-500"
                />
              </label>
              <label className="flex items-center justify-between">
                <span className="text-sm text-slate-300">出错时自动截图</span>
                <input
                  type="checkbox"
                  checked={browserSettings.screenshotOnError}
                  onChange={e => setBrowserSettings({ ...browserSettings, screenshotOnError: e.target.checked })}
                  className="w-4 h-4 accent-indigo-500"
                />
              </label>
              <div>
                <label className="block text-sm text-slate-300 mb-1">闲置自动关闭时间（分钟，0=不关闭）</label>
                <input
                  type="number"
                  min="0"
                  max="120"
                  value={browserSettings.autoCloseTimeout}
                  onChange={e => setBrowserSettings({ ...browserSettings, autoCloseTimeout: Number(e.target.value) })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">用户数据目录（留空使用默认）</label>
                <input
                  type="text"
                  value={browserSettings.userDataDir}
                  onChange={e => setBrowserSettings({ ...browserSettings, userDataDir: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white"
                  placeholder="C:\data\browser-profiles"
                />
              </div>
            </div>
            <div className="mt-6">
              <button onClick={saveBrowserSettings} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition-all disabled:opacity-50">
                <Save className="w-4 h-4" />
                {saving ? '保存中...' : (saved ? '已保存 ✓' : '保存设置')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 系统信息 */}
      {activeTab === 'info' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
              <Database className="w-5 h-5 text-indigo-400" />
              数据库概览
            </h3>
            <div className="grid sm:grid-cols-3 gap-4">
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <HardDrive className="w-4 h-4" />
                  账号配置
                </div>
                <div className="text-2xl font-semibold text-white">{systemInfo.profileCount}</div>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <Database className="w-4 h-4" />
                  广告账号
                </div>
                <div className="text-2xl font-semibold text-white">{systemInfo.adAccountCount}</div>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <Globe className="w-4 h-4" />
                  主页
                </div>
                <div className="text-2xl font-semibold text-white">{systemInfo.pageCount}</div>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <Shield className="w-4 h-4" />
                  绑定卡片
                </div>
                <div className="text-2xl font-semibold text-white">{systemInfo.billingMethodCount}</div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
              <Activity className="w-5 h-5 text-indigo-400" />
              关于系统
            </h3>
            <div className="max-w-xl space-y-3 text-sm">
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400">系统版本</span>
                <span className="text-slate-200 font-mono">v1.0.6</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400">前端框架</span>
                <span className="text-slate-200 font-mono">React 18 + Vite</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400">后端引擎</span>
                <span className="text-slate-200 font-mono">Puppeteer + Node.js</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400">数据库</span>
                <span className="text-slate-200 font-mono">SQLite (本地) + Cloudflare D1 (云端)</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-400">部署平台</span>
                <span className="text-slate-200 font-mono">Cloudflare Pages</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
