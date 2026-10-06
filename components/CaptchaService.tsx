import React, { useState, useEffect } from 'react';
import { ShieldCheck, Key, Zap, RefreshCw, CheckCircle2, AlertCircle, ExternalLink, Activity } from 'lucide-react';

const CaptchaService: React.FC = () => {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('captcha_solver_key') || '');
  const [balance, setBalance] = useState<string>('0');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');

  const platforms = [
    {
      name: 'YesCaptcha',
      desc: '国内访问流畅，支持 reCAPTCHA, hCaptcha, FunCaptcha 等多种类型，响应速度快。',
      url: 'https://yescaptcha.com/i/S9L8M2', // 示例链接
      type: '推荐'
    },
    {
      name: '2Captcha',
      desc: '全球老牌平台，支持几乎所有验证码类型，按量计费，API 兼容性极强。',
      url: 'https://2captcha.com/',
      type: '稳定'
    },
    {
      name: 'CapSolver',
      desc: '专注于 AI 识别，针对 TikTok 滑块和 X 验证有极高的成功率。',
      url: 'https://www.capsolver.com/',
      type: 'AI'
    }
  ];

  const checkBalance = async () => {
    if (!apiKey) return;
    setLoading(true);
    try {
      // 模拟调用或通过中转接口获取
      const storageUrl = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '').replace(/\/$/, '');
      const targetUrl = `https://api.yescaptcha.com/getBalance`;
      
      const resp = await fetch(`${storageUrl}/api/sms-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          targetUrl, 
          method: 'POST',
          body: { clientKey: apiKey }
        })
      });
      const json = await resp.json();
      if (json.success && json.data.errorId === 0) {
        setBalance(json.data.balance || '0');
        setStatus('success');
      } else {
        setStatus('error');
      }
    } catch (err) {
      setStatus('error');
    } finally {
      setLoading(false);
    }
  };

  const saveApiKey = () => {
    localStorage.setItem('captcha_solver_key', apiKey);
    checkBalance();
    alert('验证码识别 API Key 已保存');
  };

  useEffect(() => {
    if (apiKey) checkBalance();
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 space-y-8 pb-12">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold text-white flex items-center gap-3">
          <ShieldCheck className="w-8 h-8 text-amber-500" />
          验证码识别系统 (V5.6.6)
        </h2>
        <p className="text-slate-400">
          配置自动识别 API，在账号注册流程中自动绕过人机验证。
        </p>
      </div>

      {/* API Configuration */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-amber-500/10 rounded-xl">
              <Key className="w-8 h-8 text-amber-500" />
            </div>
            <div>
              <h3 className="text-2xl font-bold text-white">API 配置</h3>
              <p className="text-sm text-slate-500 mt-1">当前支持 YesCaptcha / 2Captcha 协议</p>
            </div>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="text-right">
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">账户余额</div>
              <div className="text-2xl font-mono text-emerald-400 font-bold">
                {balance} <span className="text-xs font-normal text-slate-500">Credits</span>
              </div>
            </div>
            <button 
              onClick={checkBalance}
              disabled={loading}
              className="p-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition-all shadow-inner"
            >
              <RefreshCw className={`w-6 h-6 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="md:col-span-3 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">Client Key (API密钥)</label>
              <div className="flex gap-3">
                <input 
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="粘贴您的 API 密钥..."
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:border-amber-500 focus:outline-none transition-all font-mono"
                />
                <button 
                  onClick={saveApiKey}
                  className="px-8 py-3 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-amber-600/20"
                >
                  保存并同步
                </button>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-slate-500 flex items-center gap-1.5">
                <Activity className="w-4 h-4" />
                状态: 
              </span>
              {status === 'success' && <span className="text-emerald-400 font-medium flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> 正常连接</span>}
              {status === 'error' && <span className="text-rose-400 font-medium flex items-center gap-1"><AlertCircle className="w-4 h-4" /> 认证失败</span>}
              {status === 'idle' && <span className="text-slate-400 font-medium italic">等待配置</span>}
            </div>
          </div>

          <div className="bg-slate-950/50 rounded-2xl p-4 border border-slate-800 flex flex-col justify-center items-center text-center space-y-2">
            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">自动化状态</div>
            <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.6)]"></div>
            <div className="text-xs text-slate-300">已集成至注册流程</div>
          </div>
        </div>
      </section>

      {/* Support Platforms */}
      <section className="space-y-4">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <Zap className="w-5 h-5 text-amber-500" />
          推荐识别平台
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {platforms.map(p => (
            <div key={p.name} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 hover:border-amber-500/50 transition-all group">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h4 className="text-xl font-bold text-white group-hover:text-amber-500 transition-colors">{p.name}</h4>
                  <span className="inline-block mt-2 px-2 py-0.5 bg-amber-500/10 text-amber-500 text-[10px] rounded-full border border-amber-500/20">
                    {p.type}
                  </span>
                </div>
                <button 
                  onClick={() => window.open(p.url, '_blank')}
                  className="p-2 bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors"
                >
                  <ExternalLink className="w-5 h-5" />
                </button>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                {p.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Guide Notice */}
      <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-2xl p-6 flex gap-5 items-start">
        <div className="p-2 bg-indigo-500/20 rounded-lg">
          <ShieldCheck className="w-6 h-6 text-indigo-400" />
        </div>
        <div className="text-sm">
          <h4 className="text-indigo-400 font-bold mb-2 text-base">自动化集成说明</h4>
          <ul className="text-slate-400 space-y-2 list-disc list-inside">
            <li>系统会自动检测页面上的 <code className="text-indigo-300">reCAPTCHA</code> 和 <code className="text-indigo-300">hCaptcha</code>。</li>
            <li>一旦检测到验证码，系统会异步发起识别任务并自动注入 Token。</li>
            <li>建议保持账户余额充足，以免自动化流程中断。</li>
            <li>您的 API Key 仅保存在浏览器本地，确保资产隐私。</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default CaptchaService;
