import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FingerprintProfile, Platform, ProxyConfig } from '../types';
import { ChevronLeft, Info, Globe, Shield, Wifi, Rocket, User, StickyNote, Tag, Users, HardDrive, Copy, Shuffle } from 'lucide-react';

interface ProfileCreatorProps {
  onCancel: () => void;
  onSave: (formData: any) => void;
  existingGroups: string[];
  initialData?: FingerprintProfile | null;
}

const userAgents: { [key: string]: string[] } = {
  windows: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  ],
  macos: [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  ],
  linux: [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
  ],
  android: [
    'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 11; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36'
  ],
  ios: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.7 Mobile/15E148 Safari/604.1'
  ]
};

const languages = [
  { label: '英语 (美国)', value: 'en-US' },
  { label: '英语 (英国)', value: 'en-GB' },
  { label: '中文 (简体)', value: 'zh-CN' },
  { label: '中文 (繁体)', value: 'zh-TW' },
  { label: '日语', value: 'ja-JP' },
  { label: '韩语', value: 'ko-KR' },
  { label: '法语', value: 'fr-FR' },
  { label: '德语', value: 'de-DE' },
  { label: '俄语', value: 'ru-RU' },
  { label: '西班牙语', value: 'es-ES' },
  { label: '葡萄牙语', value: 'pt-PT' },
  { label: '意大利语', value: 'it-IT' },
  { label: '越南语', value: 'vi-VN' },
  { label: '泰语', value: 'th-TH' },
  { label: '印度尼西亚语', value: 'id-ID' },
  { label: '阿拉伯语', value: 'ar-SA' },
  { label: '土耳其语', value: 'tr-TR' }
];

const getRandomUA = (os: FingerprintProfile['os']) => {
  let targetOS = os === 'random' ? (['windows', 'macos', 'linux', 'android', 'ios'][Math.floor(Math.random() * 5)] as any) : os;
  const list = userAgents[targetOS as keyof typeof userAgents] || userAgents.windows;
  return list[Math.floor(Math.random() * list.length)];
};

const Section: React.FC<{ icon: React.ElementType, title: string, accent?: 'indigo' | 'emerald' | 'violet' | 'amber' | 'rose' | 'cyan', children: React.ReactNode }> = ({ icon: Icon, title, accent = 'indigo', children }) => {
  const accentMap: Record<string, { border: string, bg: string, text: string }> = {
    indigo: { border: 'border-l-indigo-500', bg: 'bg-indigo-500/10', text: 'text-indigo-400' },
    emerald: { border: 'border-l-emerald-500', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
    violet: { border: 'border-l-violet-500', bg: 'bg-violet-500/10', text: 'text-violet-400' },
    amber: { border: 'border-l-amber-500', bg: 'bg-amber-500/10', text: 'text-amber-400' },
    rose: { border: 'border-l-rose-500', bg: 'bg-rose-500/10', text: 'text-rose-400' },
    cyan: { border: 'border-l-cyan-500', bg: 'bg-cyan-500/10', text: 'text-cyan-400' },
  };
  const a = accentMap[accent] || accentMap.indigo;
  return (
    <div className={`bg-slate-900/80 rounded-xl ${a.border} border border-slate-800/60 overflow-hidden backdrop-blur-sm`}>
      <div className="px-6 py-4 border-b border-slate-800/60 bg-slate-900/50">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${a.bg}`}>
            <Icon className={`w-4 h-4 ${a.text}`} />
          </div>
          <h3 className="text-base font-semibold text-white">{title}</h3>
        </div>
      </div>
      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
          {children}
        </div>
      </div>
    </div>
  );
};

const FormField: React.FC<{ label: string, helperText?: string, children: React.ReactNode, fullWidth?: boolean, required?: boolean }> = ({ label, helperText, children, fullWidth, required }) => (
    <div className={fullWidth ? 'md:col-span-2' : ''}>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          {label}
          {required && <span className="text-rose-400 ml-1">*</span>}
        </label>
        {children}
        {helperText && <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">{helperText}</p>}
    </div>
);

const ToggleSwitch: React.FC<{ enabled: boolean, onChange: (enabled: boolean) => void }> = ({ enabled, onChange }) => (
    <button type="button" onClick={() => onChange(!enabled)} className={`relative inline-flex items-center h-6 rounded-full w-11 transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-700'}`}>
        <span className={`inline-block w-4 h-4 transform bg-white rounded-full transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
);

export const ProfileCreator: React.FC<ProfileCreatorProps> = ({ onCancel, onSave, existingGroups, initialData }) => {
    const { t } = useTranslation();
    const isEditing = !!initialData;

    const [formData, setFormData] = useState({
        batchCount: 1,
        name: '',
        group: '',
        tags: '',
        owner: t('profileCreator.currentUser'),
        os: 'random' as 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'random',
        userAgent: '',
        resolution: '1920x1080',
        timezone: 'Asia/Shanghai',
        language: 'zh-CN',
        fbLanguage: 'en_US',
        fingerprintProtection: { canvas: 'random', webgl: 'random', audio: 'random' },
        proxyEnabled: false,
        proxy: { type: 'http', host: '', port: '', username: '', password: '' } as ProxyConfig,
        extId: '', // Added extId to store the unique identifier
        // FIX: Expanded startupWebsites to include all rendered options for type safety and correctness.
        startupWebsites: { google: false, facebook: false, twitter: false, instagram: false, linkedin: false, youtube: false, tiktok: false, amazon: false, custom: '' },
        account: { name: '', email: '', password: '', twoFactorSecret: '', cookies: '' },
        token: '',
        notes: ''
    });
  const [totpCode, setTotpCode] = useState('');
  const [totpLeft, setTotpLeft] = useState(0);
  // 🐛 用户是否手动动过「启用代理」开关：动过就以开关为准（关掉就必须能关掉）。
  //    以前只靠「host+port 有值就强制启用」，导致编辑一个有代理的配置、把开关关掉保存后
  //    又被自动打开 —— 看起来就是「关闭代理保存不成功」。
  const [proxyTouched, setProxyTouched] = useState(false);

    const copyText = (text: string) => { try { navigator.clipboard.writeText(text); } catch {} };
    const base32ToBytes = (s: string) => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const cleaned = s.replace(/\s+/g, '').toUpperCase();
      const bytes: number[] = [];
      let buffer = 0, bits = 0;
      for (let i = 0; i < cleaned.length; i++) {
        const val = alphabet.indexOf(cleaned[i]);
        if (val < 0) continue;
        buffer = (buffer << 5) | val;
        bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 0xff); }
      }
      return new Uint8Array(bytes);
    };
    const computeTotp = async (secret: string) => {
      try {
        const step = 30;
        const epoch = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epoch / step);
        setTotpLeft(step - (epoch % step));
        const msg = new ArrayBuffer(8);
        const view = new DataView(msg);
        view.setUint32(0, Math.floor(counter / 0x100000000));
        view.setUint32(4, counter >>> 0);
        const keyData = base32ToBytes(secret);
        const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
        const offset = sig[19] & 0x0f;
        const bin = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | (sig[offset + 3]);
        setTotpCode(String(bin % 1000000).padStart(6, '0'));
      } catch { setTotpCode(''); }
    };

    useEffect(() => {
      let mounted = true;
      const tick = () => { const sec = formData.account.twoFactorSecret; if (sec) computeTotp(sec); else { setTotpCode(''); setTotpLeft(0);} };
      tick();
      const timer = setInterval(tick, 1000);
      return () => { mounted = false; clearInterval(timer); };
    }, [formData.account.twoFactorSecret]);

    useEffect(() => {
       if (isEditing && initialData) {
            // FIX: Refactored startup URL processing for type safety and to fix a logical flaw.
            const presetSites = { google: false, facebook: false, twitter: false, instagram: false, linkedin: false, youtube: false, tiktok: false, amazon: false };
            const customUrls: string[] = [];

            initialData.startupUrls?.forEach(url => {
                const domainMatch = url.match(/:\/\/(?:www\.)?([^/]+)/);
                if (domainMatch) {
                    const domain = domainMatch[1].split('.')[0];
                    if (domain in presetSites) {
                       presetSites[domain as keyof typeof presetSites] = true;
                    } else {
                       customUrls.push(url);
                    }
                } else {
                    customUrls.push(url); // Add malformed or non-standard URLs to custom list
                }
            });

            const startupWebsites = {
                ...presetSites,
                custom: customUrls.join('\n'),
            };

            const computedProxyEnabled = (initialData.proxyEnabled ?? !!initialData.proxy?.host);
            setFormData({
                batchCount: 1,
                name: initialData.name || '',
                group: initialData.group || '',
                tags: (initialData.tags || []).join(', '),
                owner: initialData.owner || t('profileCreator.currentUser'),
                os: initialData.os || 'random',
                userAgent: initialData.userAgent || '',
                resolution: initialData.resolution || '1920x1080',
                timezone: initialData.timezone || 'Asia/Shanghai',
                language: initialData.language || 'zh-CN,zh;q=0.9',
                fbLanguage: initialData.fbLanguage || 'en_US',
                fingerprintProtection: initialData.fingerprintProtection || { canvas: 'random', webgl: 'random', audio: 'random' },
                proxyEnabled: computedProxyEnabled,
                extId: initialData.extId || '',
                proxy: {
                  type: initialData.proxy?.type || 'http',
                  host: initialData.proxy?.host || '',
                  port: initialData.proxy?.port || '',
                  username: initialData.proxy?.username || '',
                  password: initialData.proxy?.password || '',
                  provider: initialData.proxy?.provider || '',
                  residentialOptions: {
                    zone: initialData.proxy?.residentialOptions?.zone || '',
                    country: initialData.proxy?.residentialOptions?.country || '',
                    city: initialData.proxy?.residentialOptions?.city || '',
                    session: initialData.proxy?.residentialOptions?.session || '',
                    rotation: (initialData.proxy?.residentialOptions?.rotation as any) || undefined
                  }
                },
                startupWebsites: startupWebsites,
                // FIX: Ensure all account properties are defined as strings, providing defaults for missing optional values from initialData.
                account: {
                  name: initialData.account?.name ?? '',
                  email: initialData.account?.email ?? '',
                  password: initialData.account?.password ?? '',
                  twoFactorSecret: initialData.account?.twoFactorSecret ?? '',
                  cookies: initialData.account?.cookies ?? ''
                },
                token: initialData.token || '',
                notes: initialData.notes || '',
            });
       }
    }, [initialData, isEditing, t]);


  // 切换操作系统就重新生成 UA（新建 / 编辑一视同仁）：OS 和 UA 必须成套，否则一眼就是伪装。
  // ⚠️ 会覆盖手工改过的 UA —— 想保手改值就别动操作系统，或改完再点「随机 UA」。
  // ⚠️ 首次挂载必须跳过：编辑态要保留配置里原有的 UA，不能被随机值覆盖掉。
  const uaAutoGenMounted = useRef(false);
  useEffect(() => {
      if (!uaAutoGenMounted.current) {
          uaAutoGenMounted.current = true;
          if (isEditing) return; // 编辑态：沿用配置里的 UA，等用户真的改了系统再重新生成
      }
      setFormData(prev => ({ ...prev, userAgent: getRandomUA(prev.os) }));
  }, [formData.os]);

  useEffect(() => {
    const t = formData.proxy.type;
    const hasPort = String(formData.proxy.port || '').trim().length > 0;
    let def = '';
    if (t === 'https') def = '443';
    else if (t === 'http') def = '80';
    else if (t === 'socks5') def = '1080';
    // 编辑现有配置时不自动覆写端口，避免把原始空值/特殊端口误改成默认值
    if (!isEditing && !hasPort && def) {
      setFormData(prev => ({ ...prev, proxy: { ...prev.proxy, port: def } }));
    }
  }, [formData.proxy.type, formData.proxy.port, isEditing]);
    
    const handleChange = (section: string, field: string, value: any) => {
        setFormData(prev => ({
            ...prev,
            [section]: { ...((prev as any)[section] || {}), [field]: value }
        }));
    };
    
    const handleRootChange = (field: string, value: any) => {
        setFormData(prev => ({ ...prev, [field]: value }));
    };

    const handleProxyPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const s = e.clipboardData.getData('text').trim();
        if (!s) return;
        const parse = (raw: string) => {
          let type: 'http'|'https'|'socks5'|'residential' = 'http';
          let rest = raw;
          const schemeMatch = raw.match(/^(https?|socks5|residential):\/\//i);
          if (schemeMatch) {
            const sch = schemeMatch[1].toLowerCase();
            type = sch === 'https' ? 'https' : (sch === 'socks5' ? 'socks5' : (sch === 'residential' ? 'residential' : 'http'));
            rest = raw.replace(/^(https?|socks5|residential):\/\//i, '');
          }
          let username = '';
          let password = '';
          let host = '';
          let port = '';
          let query = '';
          if (rest.includes('?')) {
            const [before, q] = rest.split('?');
            rest = before;
            query = q;
          }
          if (rest.includes('@')) {
            const [cred, hostpart] = rest.split('@');
            const [u, p] = cred.split(':');
            username = u || '';
            password = p || '';
            const [h, pt] = hostpart.split(':');
            host = h || '';
            port = pt || '';
          } else {
            const parts = rest.split(':');
            if (parts.length === 2) {
              host = parts[0]; port = parts[1];
            } else if (parts.length === 4) {
              host = parts[0]; port = parts[1]; username = parts[2]; password = parts[3];
              // 🚀 智能识别：如果是 4 段式且没有指定协议，且端口较大，很可能是 SOCKS5 住宅代理
              if (!schemeMatch && parseInt(port, 10) > 1000) {
                type = 'socks5';
              }
            } else if (parts.length === 1) {
              host = parts[0];
            }
          }
          const opts: any = {};
          if (query) {
            const params = new URLSearchParams(query);
            if (params.get('zone')) opts.zone = params.get('zone') || undefined;
            if (params.get('country')) opts.country = params.get('country') || undefined;
            if (params.get('city')) opts.city = params.get('city') || undefined;
            if (params.get('session')) opts.session = params.get('session') || undefined;
            const rot = params.get('rotation');
            if (rot) opts.rotation = rot === 'sticky' ? 'sticky' : 'auto';
            const prov = params.get('provider');
            if (prov) opts.provider = prov || undefined;
          }
          return { type, host, port, username, password, options: opts };
        };
        const p = parse(s);
        const portNum = parseInt(p.port || '0', 10);
        if (p.host && (!p.port || (portNum > 0 && portNum < 65536))) {
          e.preventDefault();
          const defPort = (() => {
            if (p.type === 'https') return '443';
            if (p.type === 'http') return '80';
            if (p.type === 'socks5') return '1080';
            return '';
          })();
          setFormData(prev => ({
            ...prev,
            proxyEnabled: true,
            proxy: {
              ...prev.proxy,
              type: p.type,
              host: p.host,
              port: p.port || prev.proxy.port || defPort,
              username: p.username || '',
              password: p.password || '',
              provider: p.options.provider || prev.proxy.provider,
              residentialOptions: Object.keys(p.options).length ? {
                ...(prev.proxy.residentialOptions || {}),
                zone: p.options.zone,
                country: p.options.country,
                city: p.options.city,
                session: p.options.session,
                rotation: p.options.rotation
              } : prev.proxy.residentialOptions
            }
          }));
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        
        const startupUrls = Object.entries(formData.startupWebsites)
            .filter(([key, value]) => key !== 'custom' && value)
            .map(([key]) => `https://www.${key}.com`);

        if (formData.startupWebsites.custom) {
            startupUrls.push(...formData.startupWebsites.custom.split('\n').filter(url => url.trim() !== ''));
        }

        const finalData = {
            ...formData,
            id: isEditing ? initialData.id : undefined,
            extId: formData.extId,
            // 🚀 修正：手动动过开关就**完全以开关为准**（关掉代理必须能关掉）；
            //    没动过开关时保留旧的兜底 —— 手填了 host+port 就顺手启用，
            //    否则「填了代理保存后不生效」（proxy_enabled 存 0，启动时被跳过）。
            proxyEnabled: proxyTouched
                ? Boolean(formData.proxyEnabled)
                : (Boolean(formData.proxyEnabled) || !!(formData.proxy?.host && formData.proxy?.port)),
            tags: formData.tags.split(',').map(t => t.trim()).filter(Boolean),
            startupUrls: startupUrls,
        };
        onSave(finalData);
    };

    return (
        <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-300">
            {/* 顶部导航 */}
            <div className="bg-slate-900/90 rounded-xl border border-slate-800/60 p-5 backdrop-blur-sm">
                <div className="flex items-center justify-between">
                    <div>
                        <button onClick={onCancel} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors mb-2">
                            <ChevronLeft className="w-4 h-4" /> {t('profileCreator.backButton')}
                        </button>
                        <h2 className="text-2xl font-bold text-white">{isEditing ? t('profileCreator.editTitle') : t('profileCreator.title')}</h2>
                        <p className="text-slate-400 mt-1 text-sm">{isEditing ? t('profileCreator.editSubtitle') : t('profileCreator.subtitle')}</p>
                    </div>
                    <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500">
                        <span className="px-2 py-1 rounded bg-slate-800">{isEditing ? '编辑模式' : '创建模式'}</span>
                    </div>
                </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
                <Section icon={Info} title="基本信息" accent="indigo">
                    {!isEditing && (
                        <FormField label="批量创建数量" helperText="一次创建多个配置（最多 100 个）">
                            <input type="number" min="1" max="100" value={formData.batchCount} onChange={e => handleRootChange('batchCount', parseInt(e.target.value))} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all hover:border-slate-600" />
                        </FormField>
                    )}
                    <FormField label="配置名称" helperText={isEditing ? '' : '浏览器配置的显示名称'} required fullWidth={!isEditing}>
                        <input type="text" placeholder="e.g. US-FB-Account-01" required value={formData.name} onChange={e => handleRootChange('name', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all hover:border-slate-600" />
                    </FormField>
                </Section>

                {/* 分组与标签 */}
                <Section icon={Users} title="分组管理" accent="emerald">
                    <FormField label="分组" helperText="选择已有分组或输入新分组名">
                        <input list="existing-groups" value={formData.group} placeholder="选择或输入分组" onChange={e => handleRootChange('group', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all hover:border-slate-600" />
                        <datalist id="existing-groups">
                            {existingGroups.map(g => <option key={g} value={g} />)}
                        </datalist>
                    </FormField>
                    <FormField label="标签" helperText="用逗号分隔多个标签">
                        <input type="text" value={formData.tags} placeholder="重要, 美国, 测试" onChange={e => handleRootChange('tags', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all hover:border-slate-600" />
                    </FormField>
                    <FormField label="所有者">
                        <input type="text" value={formData.owner} onChange={e => handleRootChange('owner', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all hover:border-slate-600" />
                    </FormField>
                </Section>

                {/* 浏览器指纹 */}
                <Section icon={HardDrive} title="浏览器指纹" accent="violet">
                    <FormField label="操作系统">
                        <select value={formData.os} onChange={e => handleRootChange('os', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-violet-500/50 outline-none transition-all hover:border-slate-600">
                            <option value="random">🎲 随机</option>
                            <option value="windows">Windows</option>
                            <option value="macos">macOS</option>
                            <option value="linux">Linux</option>
                            <option value="android">Android</option>
                            <option value="ios">iOS</option>
                        </select>
                    </FormField>
                    <FormField label="分辨率">
                        <select value={formData.resolution} onChange={e => handleRootChange('resolution', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-violet-500/50 outline-none transition-all hover:border-slate-600">
                            <option>1920x1080</option>
                            <option>2560x1440</option>
                            <option>1366x768</option>
                            <option>1536x864</option>
                        </select>
                    </FormField>
                    <FormField label="时区">
                        <input type="text" value={formData.timezone} placeholder="Asia/Shanghai" onChange={e => handleRootChange('timezone', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-violet-500/50 outline-none transition-all hover:border-slate-600" />
                    </FormField>
                    <FormField label="语言">
                        <select value={formData.language} onChange={e => handleRootChange('language', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-violet-500/50 outline-none transition-all hover:border-slate-600">
                            {languages.map(lang => (
                                <option key={lang.value} value={lang.value}>{lang.label}</option>
                            ))}
                        </select>
                    </FormField>
                    <FormField label="FB语言">
                        <select value={formData.fbLanguage} onChange={e => handleRootChange('fbLanguage', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-violet-500/50 outline-none transition-all hover:border-slate-600">
                            <option value="en_US">英文 (English)</option>
                            <option value="zh_CN">中文 (简体)</option>
                        </select>
                    </FormField>
                    <FormField label="UserAgent" helperText="可手动编辑；切换操作系统或点「随机」会重新生成" fullWidth>
                        <div className="flex gap-2">
                            <textarea
                                value={formData.userAgent}
                                onChange={e => handleRootChange('userAgent', e.target.value)}
                                rows={2}
                                placeholder="Mozilla/5.0 (...)"
                                className="flex-1 bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 font-mono text-xs resize-none focus:ring-2 focus:ring-violet-500/50 outline-none transition-all hover:border-slate-600"
                            />
                            <button
                                type="button"
                                title="按当前操作系统随机生成一个 UserAgent"
                                onClick={() => handleRootChange('userAgent', getRandomUA(formData.os))}
                                className="p-2 rounded-lg bg-violet-600/20 border border-violet-500/40 text-violet-300 hover:text-white hover:bg-violet-600/40 transition-all shrink-0 self-start"
                            >
                                <Shuffle className="w-4 h-4" />
                            </button>
                            <button type="button" onClick={() => copyText(formData.userAgent)} className="p-2 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-all shrink-0 self-start">
                                <Copy className="w-4 h-4" />
                            </button>
                        </div>
                    </FormField>
                </Section>
                
                <Section icon={Shield} title="指纹保护" accent="amber">
                    {[
                        { key: 'canvas', label: 'Canvas 指纹', desc: '随机化 Canvas 渲染数据' },
                        { key: 'webgl', label: 'WebGL 指纹', desc: '随机化 WebGL 图像数据' },
                        { key: 'audio', label: 'Audio 指纹', desc: '随机化音频上下文数据' },
                    ].map(({ key, label, desc }) => (
                        <div key={key} className="md:col-span-2 flex items-center justify-between p-4 bg-slate-800/40 rounded-lg border border-slate-700/40 hover:border-slate-600/60 transition-all">
                            <div>
                                <p className="font-medium text-slate-200 text-sm">{label}</p>
                                <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
                            </div>
                            <ToggleSwitch
                                enabled={(formData.fingerprintProtection as any)[key] === 'random'}
                                onChange={val => handleChange('fingerprintProtection', key, val ? 'random' : 'off')}
                            />
                        </div>
                    ))}
                </Section>
                
                <Section icon={Wifi} title="代理设置" accent="rose">
                    <div className="md:col-span-2 flex items-center gap-4 p-3 bg-slate-800/30 rounded-lg border border-slate-700/30">
                        <ToggleSwitch enabled={formData.proxyEnabled} onChange={val => { setProxyTouched(true); handleRootChange('proxyEnabled', val); }} />
                        <div>
                            <label className="text-sm font-medium text-slate-200">启用代理</label>
                            <p className="text-xs text-slate-500">开启后浏览器将通过代理访问网络</p>
                        </div>
                    </div>
                    {formData.proxyEnabled && (
                        <>
                            <FormField label="代理类型">
                                <select value={formData.proxy.type} onChange={e => handleChange('proxy', 'type', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-rose-500/50 outline-none transition-all hover:border-slate-600">
                                    <option value="http">HTTP</option>
                                    <option value="https">HTTPS</option>
                                    <option value="socks5">SOCKS5</option>
                                    <option value="residential">🌐 住宅代理</option>
                                </select>
                            </FormField>
                            <FormField label="主机 : 端口" helperText="支持一键粘贴 socks5://user:pass@host:port 格式">
                                <div className="grid grid-cols-2 gap-2">
                                    <input type="text" value={formData.proxy.host} onPaste={handleProxyPaste} onChange={e => handleChange('proxy', 'host', e.target.value)} placeholder="host" className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-rose-500/50 outline-none transition-all hover:border-slate-600" />
                                    <input type="text" value={formData.proxy.port} onChange={e => handleChange('proxy', 'port', e.target.value)} placeholder="port" className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-rose-500/50 outline-none transition-all hover:border-slate-600" />
                                </div>
                            </FormField>
                            <FormField label="用户名 : 密码">
                                <div className="grid grid-cols-2 gap-2">
                                    <input type="text" value={formData.proxy.username} onChange={e => handleChange('proxy', 'username', e.target.value)} placeholder="username" className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-rose-500/50 outline-none transition-all hover:border-slate-600" />
                                    <input type="password" value={formData.proxy.password} onChange={e => handleChange('proxy', 'password', e.target.value)} placeholder="password" className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-rose-500/50 outline-none transition-all hover:border-slate-600" />
                                </div>
                            </FormField>
                            {formData.proxy.type === 'residential' && (
                                <div className="md:col-span-2 p-4 bg-slate-800/30 rounded-lg border border-slate-700/40">
                                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">住宅代理选项</p>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="block text-xs text-slate-500 mb-1">Provider</label>
                                            <input type="text" value={formData.proxy.provider || ''} onChange={e => handleChange('proxy', 'provider', e.target.value)} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-3 py-2 text-sm" />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-slate-500 mb-1">Zone</label>
                                            <input type="text" value={formData.proxy.residentialOptions?.zone || ''} onChange={e => setFormData(prev => ({ ...prev, proxy: { ...prev.proxy, residentialOptions: { ...(prev.proxy.residentialOptions||{}), zone: e.target.value } } }))} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-3 py-2 text-sm" />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-slate-500 mb-1">Country</label>
                                            <input type="text" value={formData.proxy.residentialOptions?.country || ''} onChange={e => setFormData(prev => ({ ...prev, proxy: { ...prev.proxy, residentialOptions: { ...(prev.proxy.residentialOptions||{}), country: e.target.value } } }))} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-3 py-2 text-sm" />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-slate-500 mb-1">City</label>
                                            <input type="text" value={formData.proxy.residentialOptions?.city || ''} onChange={e => setFormData(prev => ({ ...prev, proxy: { ...prev.proxy, residentialOptions: { ...(prev.proxy.residentialOptions||{}), city: e.target.value } } }))} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-3 py-2 text-sm" />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-slate-500 mb-1">Session</label>
                                            <input type="text" value={formData.proxy.residentialOptions?.session || ''} onChange={e => setFormData(prev => ({ ...prev, proxy: { ...prev.proxy, residentialOptions: { ...(prev.proxy.residentialOptions||{}), session: e.target.value } } }))} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-3 py-2 text-sm" />
                                        </div>
                                        <div>
                                            <label className="block text-xs text-slate-500 mb-1">Rotation</label>
                                            <select value={formData.proxy.residentialOptions?.rotation || ''} onChange={e => setFormData(prev => ({ ...prev, proxy: { ...prev.proxy, residentialOptions: { ...(prev.proxy.residentialOptions||{}), rotation: (e.target.value as any) } } }))} className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-3 py-2 text-sm">
                                                <option value="">-</option>
                                                <option value="auto">auto</option>
                                                <option value="sticky">sticky</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </Section>

                {/* 启动网站 */}
                <Section icon={Rocket} title="启动网站" accent="amber">
                    <FormField label="常用网站" fullWidth>
                        <div className="flex flex-wrap gap-2">
                            {(['google', 'facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'tiktok', 'amazon'] as const).map(site => (
                                <button
                                    type="button"
                                    key={site}
                                    onClick={() => handleChange('startupWebsites', site, !formData.startupWebsites[site])}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                        formData.startupWebsites[site]
                                            ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/50 shadow-sm shadow-indigo-500/10'
                                            : 'bg-slate-800/50 text-slate-400 border border-slate-700/50 hover:border-slate-600'
                                    }`}
                                >
                                    {site}
                                </button>
                            ))}
                        </div>
                    </FormField>
                    <FormField label="自定义网址" helperText="每行一个 URL" fullWidth>
                        <textarea rows={3} value={formData.startupWebsites.custom} onChange={e => handleChange('startupWebsites', 'custom', e.target.value)} placeholder="https://example.com" className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all hover:border-slate-600" />
                    </FormField>
                </Section>

                {/* 账号信息 */}
                <Section icon={User} title="账号信息" accent="cyan">
                    <FormField label="账号名称" helperText="用于识别账号">
                        <input type="text" value={formData.account.name} onChange={e => handleChange('account', 'name', e.target.value)} placeholder="Account Name" className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all hover:border-slate-600" />
                    </FormField>
                    <FormField label="Token">
                        <input type="text" value={formData.token} onChange={e => handleRootChange('token', e.target.value)} placeholder="Facebook Access Token" className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm font-mono focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all hover:border-slate-600" />
                    </FormField>
                    <FormField label="邮箱">
                        <div className="flex items-center gap-2">
                            <input type="email" value={formData.account.email} onChange={e => handleChange('account', 'email', e.target.value)} placeholder="user@example.com" className="flex-1 bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all hover:border-slate-600" />
                            {formData.account.email && <button type="button" onClick={() => copyText(formData.account.email)} className="p-2.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-all"><Copy className="w-4 h-4" /></button>}
                        </div>
                    </FormField>
                    <FormField label="密码">
                        <div className="flex items-center gap-2">
                            <input type="text" value={formData.account.password} onChange={e => handleChange('account', 'password', e.target.value)} placeholder="••••••••" className="flex-1 bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all hover:border-slate-600" />
                            {formData.account.password && <button type="button" onClick={() => copyText(formData.account.password)} className="p-2.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-all"><Copy className="w-4 h-4" /></button>}
                        </div>
                    </FormField>
                    <FormField label="双因素密钥 (2FA TOTP)" helperText="Base32 格式密钥，自动计算 6 位动态码">
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <input type="text" value={formData.account.twoFactorSecret} onChange={e => handleChange('account', 'twoFactorSecret', e.target.value)} placeholder="JBSWY3DPEHPK3PXP" className="flex-1 bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm font-mono focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all hover:border-slate-600" />
                                {formData.account.twoFactorSecret && <button type="button" onClick={() => copyText(formData.account.twoFactorSecret)} className="p-2.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-all"><Copy className="w-4 h-4" /></button>}
                            </div>
                            {totpCode && (
                                <div className="flex items-center gap-3 px-3 py-2 bg-indigo-900/20 rounded-lg border border-indigo-800/30">
                                    <span className="text-lg font-bold tracking-widest text-indigo-300 font-mono">{totpCode}</span>
                                    <span className="text-xs text-slate-400">剩余 {totpLeft}s</span>
                                    <button type="button" onClick={() => copyText(totpCode)} className="p-1.5 rounded bg-slate-800 text-slate-400 hover:text-white transition-all"><Copy className="w-3.5 h-3.5" /></button>
                                </div>
                            )}
                        </div>
                    </FormField>
                    <FormField label="Cookies" helperText="粘贴 Cookie 字符串（JSON 格式）" fullWidth>
                        <textarea rows={3} value={formData.account.cookies} onChange={e => handleChange('account', 'cookies', e.target.value)} placeholder='[{"name":"c_user","value":"..."}]' className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm font-mono focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all hover:border-slate-600" />
                    </FormField>
                </Section>

                {/* 备注 */}
                <Section icon={StickyNote} title="备注" accent="emerald">
                    <FormField label="备注信息" fullWidth>
                        <textarea rows={4} value={formData.notes} onChange={e => handleRootChange('notes', e.target.value)} placeholder="记录账号备注、操作说明等..." className="w-full bg-slate-950/80 border border-slate-700/80 text-white rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all hover:border-slate-600 resize-none" />
                    </FormField>
                </Section>

                {/* 操作按钮 */}
                <div className="flex flex-col sm:flex-row justify-end gap-3 pt-4">
                    <button type="button" onClick={onCancel} className="w-full sm:w-auto px-6 py-2.5 bg-slate-800/80 text-slate-300 rounded-lg hover:bg-slate-700 hover:text-white border border-slate-700/60 transition-all text-sm">
                        {t('profileCreator.cancelButton')}
                    </button>
                    <button type="submit" className="w-full sm:w-auto px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-lg hover:from-indigo-500 hover:to-violet-500 transition-all shadow-lg shadow-indigo-900/30 text-sm font-medium">
                        {isEditing ? t('profileCreator.saveButton') : t('profileCreator.createButton')}
                    </button>
                </div>
            </form>
        </div>
    );
};
