import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';
import { StatCard } from './StatCard';
import { Users, CreditCard, CheckCircle, Activity, Download, Server, ShieldCheck } from 'lucide-react';

const data = [
  { name: 'Mon', spend: 4000, clicks: 2400, conversions: 240 },
  { name: 'Tue', spend: 3000, clicks: 1398, conversions: 210 },
  { name: 'Wed', spend: 2000, clicks: 9800, conversions: 290 },
  { name: 'Thu', spend: 2780, clicks: 3908, conversions: 200 },
  { name: 'Fri', spend: 1890, clicks: 4800, conversions: 181 },
  { name: 'Sat', spend: 2390, clicks: 3800, conversions: 250 },
  { name: 'Sun', spend: 3490, clicks: 4300, conversions: 310 },
];

export const Dashboard = () => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<{ total: number; platformBreakdown: Record<string, number>; statusBreakdown: Record<string, number> } | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    if (!token) { setStatsLoading(false); return; }
    fetch('/api/profiles/stats', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(json => { if (json?.success) setStats(json.data); })
      .catch(() => {})
      .finally(() => setStatsLoading(false));
  }, []);

  const totalProfiles = stats ? stats.total.toLocaleString() : (statsLoading ? '...' : '0');
  const metaCount = stats?.platformBreakdown?.['Meta (Facebook/Instagram)'] || 0;
  const tiktokCount = stats?.platformBreakdown?.TikTok || 0;
  const googleCount = stats?.platformBreakdown?.Google || 0;
  const activeCount = stats?.statusBreakdown?.Active || 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-white">{t('dashboard.title')}</h2>
        <p className="text-slate-400 mt-1">{t('dashboard.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title={t('dashboard.totalProfiles')} value={totalProfiles} icon={Users} change={`${metaCount} Meta / ${tiktokCount} TikTok`} positive={true} />
        <StatCard title="活跃配置" value={String(activeCount)} icon={CreditCard} change={stats ? `共 ${stats.total} 个` : ''} positive={true} />
        <StatCard title="平台分布" value={String(metaCount + tiktokCount + googleCount)} icon={Activity} change={`Google ${googleCount}`} positive={true} />
        <StatCard title={t('dashboard.avgROI')} value="340%" icon={CheckCircle} change="+1.2%" positive={true} />
      </div>

      {/* 🚀 新增：本地服务端下载卡片 */}
      <div className="bg-gradient-to-r from-indigo-900/40 to-slate-900 border border-indigo-500/30 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-5">
          <div className="w-14 h-14 bg-indigo-600/20 rounded-full flex items-center justify-center border border-indigo-500/20">
            <Server className="w-8 h-8 text-indigo-400" />
          </div>
          <div>
            <h3 className="text-xl font-bold text-white">本地控制端 (Puppeteer Server)</h3>
            <p className="text-slate-400 mt-1">启动本地浏览器自动化、Cookie 同步、广告管理的核心组件</p>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
          <a 
            href="/api/download/server" 
            className="flex items-center justify-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg transition-all shadow-lg shadow-indigo-500/20"
          >
            <Download className="w-5 h-5" />
            下载 Windows EXE (纯净版)
          </a>
          <div className="flex items-center gap-2 text-xs text-slate-500 px-2">
            <ShieldCheck className="w-4 h-4" />
            安全认证 · 无需安装
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-96">
        {/* Main Chart */}
        <div className="lg:col-span-2 bg-slate-900 p-4 rounded-xl border border-slate-800">
          <h3 className="text-lg font-semibold text-white mb-4">{t('dashboard.trafficSpendTrends')}</h3>
          <div className="h-full pb-6">
             <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <defs>
                  <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorSpend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="name" stroke="#64748b" />
                <YAxis stroke="#64748b" />
                <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f1f5f9' }}
                    itemStyle={{ color: '#f1f5f9' }}
                />
                <Area type="monotone" dataKey="clicks" stroke="#6366f1" fillOpacity={1} fill="url(#colorClicks)" />
                <Area type="monotone" dataKey="spend" stroke="#10b981" fillOpacity={1} fill="url(#colorSpend)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Secondary Chart */}
        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
          <h3 className="text-lg font-semibold text-white mb-4">{t('dashboard.conversionBreakdown')}</h3>
          <div className="h-full pb-6">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="name" stroke="#64748b" tick={{fontSize: 12}} />
                <Tooltip
                    cursor={{fill: '#1e293b'}}
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f1f5f9' }}
                />
                <Legend wrapperStyle={{ paddingTop: '10px'}} />
                <Bar dataKey="conversions" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
