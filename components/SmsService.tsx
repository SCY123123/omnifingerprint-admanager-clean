import React, { useState, useEffect } from 'react';
import { Phone, ExternalLink, Shield, Zap, Gift, CreditCard, Key, Globe, RefreshCw, MessageSquare, Copy, CheckCircle2, AlertCircle } from 'lucide-react';

const SmsService: React.FC = () => {
  const [platform, setPlatform] = useState<'sms_activate' | 'five_sim'>(() => (localStorage.getItem('sms_platform') as any) || 'sms_activate');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(`${platform}_key`) || '');
  const [balance, setBalance] = useState<string>('0');
  const [loading, setLoading] = useState(false);
  const [currentNumber, setCurrentNumber] = useState<{ id: string; number: string } | null>(null);
  const [smsCode, setSmsCode] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [selectedCountry, setSelectedCountry] = useState('0'); 
  const [selectedService, setSelectedService] = useState('fb'); 

  const storageUrl = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '').replace(/\/$/, '');

  // 监听平台切换，更新 Key
  useEffect(() => {
    const savedKey = localStorage.getItem(`${platform}_key`) || '';
    setApiKey(savedKey);
    localStorage.setItem('sms_platform', platform);
    // 重置状态
    setBalance('0');
    setCurrentNumber(null);
    setSmsCode('');
    setStatus('');
    if (savedKey) checkBalance(savedKey);
  }, [platform]);

  const countries = {
    sms_activate: [
      { id: '0', name: '俄罗斯 (Russia)' },
      { id: '6', name: '印度尼西亚 (Indonesia)' },
      { id: '1', name: '乌克兰 (Ukraine)' },
      { id: '2', name: '哈萨克斯坦 (Kazakhstan)' },
      { id: '15', name: '波兰 (Poland)' },
      { id: '22', name: '印度 (India)' },
      { id: '86', name: '意大利 (Italy)' },
      { id: '187', name: '美国 (USA)' },
    ],
    five_sim: [
      { id: 'russia', name: '俄罗斯 (Russia)' },
      { id: 'indonesia', name: '印度尼西亚 (Indonesia)' },
      { id: 'ukraine', name: '乌克兰 (Ukraine)' },
      { id: 'kazakhstan', name: '哈萨克斯坦 (Kazakhstan)' },
      { id: 'poland', name: '波兰 (Poland)' },
      { id: 'india', name: '印度 (India)' },
      { id: 'italy', name: '意大利 (Italy)' },
      { id: 'usa', name: '美国 (USA)' },
    ]
  };

  const services = {
    sms_activate: [
      { id: 'fb', name: 'Facebook' },
      { id: 'ot', name: 'TikTok' },
      { id: 'ig', name: 'Instagram' },
      { id: 'tw', name: 'X (Twitter)' },
      { id: 'go', name: 'Google' },
      { id: 'tg', name: 'Telegram' },
      { id: 'wa', name: 'WhatsApp' },
    ],
    five_sim: [
      { id: 'facebook', name: 'Facebook' },
      { id: 'tiktok', name: 'TikTok' },
      { id: 'instagram', name: 'Instagram' },
      { id: 'twitter', name: 'X (Twitter)' },
      { id: 'google', name: 'Google' },
      { id: 'telegram', name: 'Telegram' },
      { id: 'whatsapp', name: 'WhatsApp' },
    ]
  };

  const callSmsApi = async (action: string, params: Record<string, string> = {}, currentKey?: string) => {
    const keyToUse = currentKey || apiKey;
    if (!keyToUse) {
      alert('请先设置 API Key');
      return null;
    }
    setLoading(true);
    try {
      let targetUrl = '';
      let headers: Record<string, string> = {};
      let method = 'GET';

      if (platform === 'sms_activate') {
        const query = new URLSearchParams({ api_key: keyToUse, action, ...params }).toString();
        targetUrl = `https://api.sms-activate.org/stubs/handler_api.php?${query}`;
      } else {
        // 5SIM API Logic
        headers = { 'Authorization': `Bearer ${keyToUse}`, 'Accept': 'application/json' };
        if (action === 'getBalance') {
          targetUrl = 'https://5sim.net/v1/user/profile';
        } else if (action === 'getNumber') {
          targetUrl = `https://5sim.net/v1/user/buy/activation/${params.country}/any/${params.service}`;
        } else if (action === 'getStatus') {
          targetUrl = `https://5sim.net/v1/user/check/${params.id}`;
        } else if (action === 'cancel') {
          targetUrl = `https://5sim.net/v1/user/cancel/${params.id}`;
        } else if (action === 'finish') {
          targetUrl = `https://5sim.net/v1/user/finish/${params.id}`;
        }
      }
      
      const resp = await fetch(`${storageUrl}/api/sms-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl, headers, method })
      });
      const json = await resp.json();
      return json.data;
    } catch (err) {
      console.error('SMS API Error:', err);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const checkBalance = async (key?: string) => {
    const res = await callSmsApi('getBalance', {}, key);
    if (platform === 'sms_activate') {
      if (res && typeof res === 'string' && res.startsWith('ACCESS_BALANCE:')) {
        setBalance(res.split(':')[1]);
      }
    } else {
      if (res && res.balance !== undefined) {
        setBalance(String(res.balance));
      }
    }
  };

  const getNumber = async () => {
    const res = await callSmsApi('getNumber', {
      service: selectedService,
      country: selectedCountry
    });

    if (platform === 'sms_activate') {
      if (res && typeof res === 'string' && res.startsWith('ACCESS_NUMBER:')) {
        const [, id, number] = res.split(':');
        setCurrentNumber({ id, number });
        setSmsCode('');
        setStatus('等待短信...');
      } else {
        alert('获取号码失败: ' + (res || '未知错误'));
      }
    } else {
      if (res && res.id && res.phone) {
        setCurrentNumber({ id: String(res.id), number: res.phone });
        setSmsCode('');
        setStatus('等待短信...');
      } else {
        alert('获取号码失败: ' + (res?.errors || '未知错误'));
      }
    }
  };

  const checkSms = async () => {
    if (!currentNumber) return;
    const res = await callSmsApi('getStatus', { id: currentNumber.id });

    if (platform === 'sms_activate') {
      if (res === 'STATUS_WAIT_CODE') {
        setStatus('短信尚未到达，请稍后再试...');
      } else if (res && typeof res === 'string' && res.startsWith('STATUS_OK:')) {
        const code = res.split(':')[1];
        setSmsCode(code);
        setStatus('✅ 验证码获取成功！');
      } else {
        setStatus('状态: ' + (res || '请求失败'));
      }
    } else {
      if (res && res.status === 'RECEIVED' && res.sms && res.sms.length > 0) {
        setSmsCode(res.sms[0].code);
        setStatus('✅ 验证码获取成功！');
      } else if (res && res.status === 'PENDING') {
        setStatus('短信尚未到达，请稍后再试...');
      } else {
        setStatus('状态: ' + (res?.status || '请求失败'));
      }
    }
  };

  const cancelNumber = async () => {
    if (!currentNumber) return;
    const action = platform === 'sms_activate' ? 'setStatus' : 'cancel';
    const params = platform === 'sms_activate' ? { id: currentNumber.id, status: '8' } : { id: currentNumber.id };
    
    const res = await callSmsApi(action, params);
    if (res === 'ACCESS_CANCEL' || (platform === 'five_sim' && res && res.status === 'CANCELED')) {
      setCurrentNumber(null);
      setStatus('已取消号码');
    } else {
      alert('取消失败: ' + (res || '接口返回异常'));
    }
  };

  const finishNumber = async () => {
    if (!currentNumber) return;
    const action = platform === 'sms_activate' ? 'setStatus' : 'finish';
    const params = platform === 'sms_activate' ? { id: currentNumber.id, status: '6' } : { id: currentNumber.id };

    const res = await callSmsApi(action, params);
    if (res === 'ACCESS_READY' || (platform === 'five_sim' && res && res.status === 'FINISHED')) {
      setCurrentNumber(null);
      setStatus('流程已完成');
    } else {
      alert('完成失败: ' + (res || '接口返回异常'));
    }
  };

  const saveApiKey = () => {
    localStorage.setItem(`${platform}_key`, apiKey);
    checkBalance();
    alert('API Key 已保存并更新余额');
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // 可选：添加一个小气泡提示
  };
  const paidPlatforms = [
    {
      name: 'SMS-Activate',
      desc: '全球最大的接码平台，支持多种支付方式，号码量大。',
      url: 'https://sms-activate.org/',
      features: ['多国号码', '支持支付宝', '租用功能', 'API集成'],
      tags: ['推荐', '老牌']
    },
    {
      name: '5SIM',
      desc: '性价比极高，覆盖全球多个国家，支持多种主流应用。',
      url: 'https://5sim.net/',
      features: ['价格低廉', '覆盖广', '响应快'],
      tags: ['性价比']
    },
    {
      name: 'VAK-SMS',
      desc: '支持俄罗斯、哈萨克斯坦等地区，注册特定平台成功率高。',
      url: 'https://vak-sms.com/',
      features: ['特定地区优选', '快速稳定'],
      tags: ['稳定']
    },
    {
      name: 'Grizzly SMS',
      desc: '新兴的接码平台，支持大量流行社交媒体和支付服务。',
      url: 'https://grizzlysms.com/',
      features: ['社交媒体优化', '支持广泛'],
      tags: ['新兴']
    }
  ];

  const freePlatforms = [
    {
      name: 'Receive-SMS-Free',
      desc: '提供免费的公共号码，适用于非敏感账号注册。',
      url: 'https://receive-sms-free.cc/',
      type: '免费'
    },
    {
      name: 'SMSReceiveFree',
      desc: '老牌免费接码网站，提供美国和加拿大号码。',
      url: 'https://smsreceivefree.com/',
      type: '免费'
    },
    {
      name: 'Z-SMS',
      desc: '在线接收短信验证码，支持中国、缅甸等地区号码。',
      url: 'https://www.z-sms.com/',
      type: '免费'
    },
    {
      name: '云接码',
      desc: '中文界面，提供大量国内和国际免费接码服务。',
      url: 'https://www.yunjiema.net/',
      type: '免费'
    }
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 space-y-8 pb-12">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold text-white flex items-center gap-3">
          <Phone className="w-8 h-8 text-indigo-500" />
          接码系统 (V5.4.1)
        </h2>
        <p className="text-slate-400">
          集成主流付费与免费接码平台，支持 API 自动化接码。
        </p>
      </div>

      {/* 🚀 API 自动化接码区域 */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <Zap className="w-6 h-6 text-indigo-500" />
            </div>
            <div className="flex flex-col">
              <select 
                value={platform}
                onChange={(e) => setPlatform(e.target.value as any)}
                className="bg-transparent text-xl font-bold text-white focus:outline-none cursor-pointer hover:text-indigo-400 transition-colors"
              >
                <option value="sms_activate" className="bg-slate-900 text-white">SMS-Activate API</option>
                <option value="five_sim" className="bg-slate-900 text-white">5SIM API</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">
                {platform === 'sms_activate' ? '当前使用: 全球领先接码平台' : '当前使用: 高性价比接码平台'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-slate-500 uppercase tracking-wider">当前余额</div>
              <div className="text-xl font-mono text-emerald-400 font-bold">{balance} <span className="text-xs font-normal text-slate-500">{platform === 'sms_activate' ? 'RUB' : 'Points'}</span></div>
            </div>
            <button 
              onClick={() => checkBalance()} 
              disabled={loading}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-all"
              title="刷新余额"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左侧：配置面板 */}
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                <Key className="w-4 h-4 text-indigo-400" />
                API Key ({platform === 'sms_activate' ? 'SMS-Activate' : '5SIM'})
              </label>
              <div className="flex gap-2">
                <input 
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="输入您的 API 密钥..."
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
                />
                <button 
                  onClick={saveApiKey}
                  className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  保存
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <Globe className="w-4 h-4 text-indigo-400" />
                  选择国家
                </label>
                <select 
                  value={selectedCountry}
                  onChange={(e) => setSelectedCountry(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none appearance-none"
                >
                  {countries[platform].map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-indigo-400" />
                  选择服务
                </label>
                <select 
                  value={selectedService}
                  onChange={(e) => setSelectedService(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none appearance-none"
                >
                  {services[platform].map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>

            <button 
              onClick={getNumber}
              disabled={loading || !!currentNumber}
              className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
                !!currentNumber 
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/20'
              }`}
            >
              <Phone className="w-5 h-5" />
              {loading ? '获取中...' : '获取新号码'}
            </button>
          </div>

          {/* 右侧：操作面板 */}
          <div className="lg:col-span-2 bg-slate-950/50 border border-slate-800 rounded-xl p-6 flex flex-col justify-center min-h-[200px] relative overflow-hidden">
            {!currentNumber ? (
              <div className="text-center space-y-2">
                <div className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Phone className="w-6 h-6 text-slate-600" />
                </div>
                <p className="text-slate-400 font-medium">尚未获取号码</p>
                <p className="text-xs text-slate-600">点击左侧“获取新号码”开始</p>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">当前号码</div>
                    <div className="flex items-center gap-3">
                      <div className="text-3xl font-mono text-white font-bold tracking-tighter">
                        +{currentNumber.number}
                      </div>
                      <button 
                        onClick={() => copyToClipboard(currentNumber.number)}
                        className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-md transition-colors"
                        title="复制号码"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button 
                      onClick={checkSms}
                      disabled={loading}
                      className="flex-1 md:flex-none px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-lg flex items-center gap-2 shadow-lg shadow-emerald-600/20 transition-all"
                    >
                      <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                      手动刷新短信
                    </button>
                    <button 
                      onClick={cancelNumber}
                      disabled={loading}
                      className="flex-1 md:flex-none px-4 py-2 bg-rose-600/10 hover:bg-rose-600/20 text-rose-500 text-sm font-bold rounded-lg transition-all border border-rose-500/20"
                    >
                      取消/释放
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center space-y-2 min-h-[120px]">
                    <div className="text-xs text-slate-500 uppercase tracking-wider">验证码内容</div>
                    {smsCode ? (
                      <div className="flex items-center gap-3">
                        <span className="text-4xl font-mono text-emerald-400 font-black tracking-widest">{smsCode}</span>
                        <button 
                          onClick={() => copyToClipboard(smsCode)}
                          className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-md transition-colors"
                        >
                          <Copy className="w-5 h-5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-2 h-2 bg-amber-500 rounded-full animate-ping"></div>
                        <span className="text-slate-400 text-sm animate-pulse">{status}</span>
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center space-y-3">
                    <div className="text-xs text-slate-500 uppercase tracking-wider">操作</div>
                    {smsCode ? (
                      <button 
                        onClick={finishNumber}
                        className="w-full py-2 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-sm font-bold rounded-lg border border-emerald-500/20 transition-all flex items-center justify-center gap-2"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        标记完成
                      </button>
                    ) : (
                      <div className="text-center px-4">
                        <p className="text-xs text-slate-500 leading-relaxed">系统将每 5 秒自动尝试拉取一次短信内容...</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Paid Platforms Grid */}
      <section className="space-y-4">
        <div className="flex items-center gap-2 text-indigo-400 font-semibold">
          <CreditCard className="w-5 h-5" />
          备用付费平台 (跳转访问)
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {paidPlatforms.map((p) => (
            <div key={p.name} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-indigo-500/50 transition-all group cursor-pointer" onClick={() => window.open(p.url, '_blank')}>
              <div className="flex justify-between items-start mb-2">
                <h3 className="font-bold text-white group-hover:text-indigo-400 transition-colors">{p.name}</h3>
                <ExternalLink className="w-4 h-4 text-slate-600 group-hover:text-indigo-400" />
              </div>
              <p className="text-slate-500 text-xs line-clamp-2">{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Free Platforms Grid */}
      <section className="space-y-4">
        <div className="flex items-center gap-2 text-emerald-400 font-semibold">
          <Gift className="w-5 h-5" />
          免费公共平台 (仅适用于临时测试)
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {freePlatforms.map((p) => (
            <div 
              key={p.name} 
              onClick={() => window.open(p.url, '_blank')}
              className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:bg-slate-800/50 cursor-pointer transition-all text-center group"
            >
              <div className="text-white font-medium mb-1 group-hover:text-emerald-400">{p.name}</div>
              <div className="text-slate-500 text-[10px] mb-2 line-clamp-1">{p.desc}</div>
              <span className="text-[9px] uppercase tracking-wider bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded border border-emerald-500/20">
                {p.type}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Security Notice */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex gap-4 items-start">
        <AlertCircle className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />
        <div className="text-sm">
          <h4 className="text-amber-500 font-bold mb-1">安全提示</h4>
          <p className="text-slate-400 leading-relaxed">
            1. **免费接码平台**的号码是公共的，请勿用于注册包含敏感信息的重要资产账号。<br />
            2. **API 自动化**：目前已集成 SMS-Activate 官方 API，您的 Key 仅保存在浏览器本地，不会上传至服务器。<br />
            3. 对于 FB/TikTok 注册，建议优先选择**俄罗斯、印度尼西亚、意大利**等地区的号码，成功率更高。
          </p>
        </div>
      </div>
    </div>
  );
};

export default SmsService;
