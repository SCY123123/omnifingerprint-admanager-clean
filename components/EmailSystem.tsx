import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Mail,
  RefreshCw,
  Copy,
  Trash2,
  Inbox,
  Loader2,
  Clock,
  History,
  PlusCircle,
  AtSign,
  HelpCircle,
  AlertTriangle,
  ShieldCheck,
  Settings,
  Link2,
  Check,
  ExternalLink
} from 'lucide-react';

interface Message {
  id: string;
  from: { address: string; name: string };
  subject: string;
  intro: string;
  createdAt: string;
  seen: boolean;
  links: string[];
}

interface MessageDetail extends Message {
  text: string;
  html: string[];
}

// 🎯 自有域名收信（2026-09 切换）
//    链路：本域名 MX(catch-all) → Cloudflare Email Routing → Email Worker
//          → POST /api/private-emails/ingest → MySQL → 本页轮询 /api/private-emails/list
//    ⚠️ 不再走 mail.tm：那是第三方域名，无法自定义；这里地址固定用自己的域名。
const MAIL_DOMAIN = (import.meta as any).env?.VITE_MAIL_DOMAIN || ''; // 你的私有收信域名（构建时注入）
const API_BASE = '/api/private-emails';

// 服务端返回的 sender 形如 `"Name" <a@b.com>` 或纯地址，两种都要拆得开
const parseSender = (raw: string): { name: string; address: string } => {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), address: m[2].trim() };
  return { name: '', address: s };
};

// 服务端列表行 → 组件内部结构
const toMessage = (row: any): Message => ({
  id: String(row.id),
  from: parseSender(row.sender),
  subject: row.subject || '(无主题)',
  intro: '',
  createdAt: row.created_at || '',
  seen: Number(row.is_seen) === 1,
  // 服务端已从正文提取好链接（FB 邀请链接排最前），卡片直接展示+复制
  links: Array.isArray(row.links) ? row.links : [],
});

const EmailSystem: React.FC = () => {
  const [address, setAddress] = useState<string>('');
  const [editingAddress, setEditingAddress] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<MessageDetail | null>(null);
  const [msgLoading, setMsgLoading] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  // 复制成功的瞬时反馈：记录被复制的 key，1.5 秒后还原图标
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 静默轮询失败时只在「一封都还没收到」的情况下报错，避免每 5 秒闪一次红
  const hasDataRef = useRef(false);

  const saveToHistory = (addr: string) => {
    setHistory(prev => {
      const filtered = prev.filter(item => (typeof item === 'string' ? item : item.address) !== addr);
      const newItem = { address: addr, createdAt: new Date().toISOString() };
      const next = [newItem, ...filtered].slice(0, 20);
      localStorage.setItem('mailtm_history', JSON.stringify(next));
      return next;
    });
  };

  /** 生成/切换邮箱地址。自建模式无账号、无密码、无 token：地址本身就是凭证。 */
  const setupAccount = (customUser?: string) => {
    const user = String(customUser || '').trim().replace(/@.*$/, '').replace(/[^a-zA-Z0-9._-]/g, '');
    const name = user || (() => {
      // 高熵生成，降低碰撞率（沿用原来的规则）
      const ts = Date.now().toString(36).slice(-6);
      const rs = Math.random().toString(36).slice(-8).padStart(8, '0');
      const r2 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      return `tk_${ts}${rs}${r2}`;
    })();
    const target = `${name}@${MAIL_DOMAIN}`;
    setAddress(target);
    setMessages([]);
    setSelectedMessage(null);
    setError(null);
    localStorage.setItem('mailtm_address', target);
    hasDataRef.current = false;
    saveToHistory(target);
  };

  const clearAndReset = () => {
    localStorage.removeItem('mailtm_address');
    setupAccount();
  };

  const fetchMessages = useCallback(async (isSilent = false) => {
    if (!address) return;
    if (!isSilent) {
      setRefreshing(true);
      setError(null);
    }
    try {
      const resp = await fetch(`${API_BASE}/list?address=${encodeURIComponent(address)}`, {
        headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data || data.success === false) throw new Error((data && data.message) || '查询失败');
      const list = Array.isArray(data.data) ? data.data : [];
      setMessages(list.map(toMessage));
      hasDataRef.current = true;
      setError(null);
    } catch (err: any) {
      if (!isSilent || !hasDataRef.current) {
        setError(`收信服务连接失败（${err && err.message ? err.message : '未知原因'}），正在自动重连...`);
      }
    } finally {
      if (!isSilent) setRefreshing(false);
    }
  }, [address]);

  const fetchMessageDetail = async (id: string) => {
    setMsgLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/detail?id=${encodeURIComponent(id)}`);
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || data.success === false) {
        throw new Error((data && data.message) || `加载失败 (${resp.status})`);
      }
      const row = data.data || {};
      setSelectedMessage({
        ...toMessage(row),
        seen: true,
        text: row.content_text || '(无正文)',
        // 服务端会顺手标已读，这里同步本地列表的已读状态
        html: row.content_html ? [String(row.content_html)] : [],
      });
      setMessages(prev => prev.map(m => (m.id === String(id) ? { ...m, seen: true } : m)));
      setError(null);
    } catch (err: any) {
      setError(err && err.message ? err.message : '加载邮件失败');
    } finally {
      setMsgLoading(false);
    }
  };

  const handleRandomGenerate = () => setupAccount();

  useEffect(() => {
    const savedHistory = localStorage.getItem('mailtm_history');
    if (savedHistory) {
      try { setHistory(JSON.parse(savedHistory)); } catch (e) { setHistory([]); }
    }
    const handleHistoryUpdate = (e: any) => { if (e.detail) setHistory(e.detail); };
    window.addEventListener('mailtm_history_updated', handleHistoryUpdate);
    return () => window.removeEventListener('mailtm_history_updated', handleHistoryUpdate);
  }, []);

  useEffect(() => {
    const savedAddr = localStorage.getItem('mailtm_address');
    if (savedAddr) setAddress(savedAddr);
    else setupAccount();
  }, []);

  useEffect(() => { setEditingAddress(address); }, [address]);

  useEffect(() => {
    if (!address) return;
    fetchMessages(true);
    const timer = setInterval(() => fetchMessages(true), 5000);
    return () => clearInterval(timer);
  }, [address, fetchMessages]);

  // 复制到剪贴板：优先 Clipboard API；在 http / iframe / 无权限时会失败，
  // 此时回退到隐藏 textarea + execCommand（老办法，兼容性最好），避免「点了没反应」。
  const writeClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 落到下面的回退方案 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  };

  const copyToClipboard = async (text: string, key?: string) => {
    const ok = await writeClipboard(text);
    if (!key) return;
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    setCopiedKey(key);
    copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
    if (!ok) console.warn('[mail] 复制失败：', text);
  };

  // 链接按钮组：完整显示链接文本（自动换行）+ 打开 + 一键复制。
  // FB 邀请链接很长，用 break-all 保证「完整显示」而不是截断。
  const LinkChips: React.FC<{ links: string[]; max?: number; idPrefix: string }> = ({ links, max = 99, idPrefix }) => {
    if (!links || links.length === 0) return null;
    const shown = links.slice(0, max);
    return (
      <div className="mt-2 flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
        {shown.map((lnk, i) => {
          const key = `${idPrefix}-${i}`;
          const copied = copiedKey === key;
          const isInvite = /business\.facebook\.com.*invitation/i.test(lnk);
          return (
            <div
              key={key}
              className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                isInvite ? 'bg-indigo-600/10 border-indigo-500/30' : 'bg-slate-800/70 border-slate-700'
              }`}
            >
              <Link2 className={`w-3.5 h-3.5 shrink-0 ${isInvite ? 'text-indigo-400' : 'text-slate-400'}`} />
              <a
                href={lnk}
                target="_blank"
                rel="noopener noreferrer"
                title={lnk}
                className="text-[11px] text-slate-300 hover:text-indigo-300 break-all leading-snug flex-1 min-w-0"
              >
                {lnk}
              </a>
              <a
                href={lnk}
                target="_blank"
                rel="noopener noreferrer"
                title="打开链接"
                className="p-1.5 rounded-md bg-slate-900 text-slate-400 hover:text-indigo-400 border border-slate-700 shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <button
                onClick={() => copyToClipboard(lnk, key)}
                title="复制链接"
                className={`p-1.5 rounded-md border shrink-0 ${
                  copied ? 'bg-green-600/20 text-green-400 border-green-500/40' : 'bg-slate-900 text-slate-400 hover:text-indigo-400 border-slate-700'
                }`}
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          );
        })}
        {links.length > shown.length && (
          <span className="text-[10px] text-slate-500 pl-1">还有 {links.length - shown.length} 个链接，点击邮件查看全部</span>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] lg:h-[calc(100vh-48px)] bg-slate-950/50 rounded-xl border border-slate-800 overflow-hidden relative mx-auto w-full">
      <div className="shrink-0 p-6 border-b border-slate-800 bg-slate-900/50">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-600/20 flex items-center justify-center border border-indigo-500/30">
              <Mail className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                临时邮箱系统
                <span className="px-2 py-0.5 text-[10px] bg-indigo-500/20 text-indigo-400 rounded-full border border-indigo-500/20 uppercase">
                  V6.0.0
                </span>
              </h2>
              <p className="text-sm text-slate-400">自有域名 @{MAIL_DOMAIN} · 5秒极速同步</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => setShowHelp(true)} className="p-2.5 rounded-lg bg-slate-800 text-indigo-400 border border-slate-700">
              <HelpCircle className="w-5 h-5" />
            </button>

            <div className="relative">
              <button onClick={() => setShowHistory(!showHistory)} className="p-2.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700">
                <History className="w-5 h-5" />
              </button>
              {showHistory && history.length > 0 && (
                <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden">
                  <div className="p-3 border-b border-slate-800 text-xs font-bold text-slate-500 flex justify-between">
                     <span>最近使用</span>
                     <button onClick={() => { setHistory([]); localStorage.removeItem('mailtm_history'); }} className="text-rose-500"><Trash2 className="w-3 h-3"/></button>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
                    {history.map((item, idx) => {
                      const addr = typeof item === 'string' ? item : item.address;
                      return (
                        <button
                          key={addr + idx}
                          onClick={() => { setupAccount(addr.split('@')[0]); setShowHistory(false); }}
                          className="w-full text-left px-4 py-3 text-sm text-slate-300 hover:bg-indigo-600/20 border-b border-slate-800/50 last:border-0"
                        >
                          {addr}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <button onClick={() => fetchMessages()} disabled={refreshing} className="p-2.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700">
              <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>

            <button
              onClick={handleRandomGenerate}
              className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white font-bold rounded-lg"
            >
              <PlusCircle className="w-5 h-5" />
              随机生成
            </button>
          </div>
        </div>
      </div>

      <div className="shrink-0 px-6 py-4 border-b border-slate-800/50">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 flex items-center bg-slate-800/50 rounded-xl border border-indigo-500/20 px-6 py-3">
            <div className="flex flex-col flex-1">
              <span className="text-[10px] text-indigo-400 font-bold uppercase mb-0.5">活跃邮箱地址</span>
              <input
                type="text"
                value={editingAddress}
                onChange={(e) => setEditingAddress(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') setupAccount(editingAddress.split('@')[0]); }}
                className="text-lg font-mono text-white bg-transparent border-none p-0 focus:ring-0 w-full"
              />
            </div>
            <button
              onClick={() => copyToClipboard(editingAddress || address, 'active-addr')}
              title={copiedKey === 'active-addr' ? '已复制' : '复制邮箱地址'}
              className={`p-2.5 rounded-lg border ml-4 inline-flex items-center gap-1.5 transition-colors ${
                copiedKey === 'active-addr'
                  ? 'bg-green-600/20 text-green-400 border-green-500/40'
                  : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-indigo-300'
              }`}
            >
              {copiedKey === 'active-addr' ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
              {copiedKey === 'active-addr' && <span className="text-xs font-bold whitespace-nowrap">已复制</span>}
            </button>
          </div>
          <div className="flex items-center justify-between bg-slate-900/50 rounded-xl border border-slate-800 px-6 py-3">
             <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${error ? 'bg-rose-500' : 'bg-green-500'}`}></div>
                <div className="flex flex-col">
                   <span className="text-[10px] text-slate-500 uppercase">收信状态</span>
                   <span className={`text-xs font-bold ${error ? 'text-rose-400' : 'text-green-400'}`}>{error ? '连接波动' : '稳定在线'}</span>
                </div>
             </div>
             <button onClick={() => setupAccount(address.split('@')[0])} className="p-2 text-slate-500">
                <Settings className="w-4 h-4" />
             </button>
          </div>
        </div>
        {error && (
          <div className="mt-4 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-rose-200">{error}</p>
              <div className="mt-3 flex gap-2">
                <button onClick={() => fetchMessages()} className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-md text-xs font-bold">重试</button>
                <button onClick={clearAndReset} className="px-3 py-1.5 bg-rose-600 text-white rounded-md text-xs font-bold">重置</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-64 border-r border-slate-800 flex flex-col bg-slate-900/20 overflow-hidden shrink-0">
          <div className="p-4 border-b border-slate-800/50 bg-slate-900/30">
            <h3 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-2">
              <AtSign className="w-3 h-3" /> 本地历史记录
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {history.length === 0 ? <div className="p-8 text-center text-slate-600 text-xs">暂无记录</div> : (
              <div className="divide-y divide-slate-800/30">
                {history.map((item, idx) => {
                  const addr = typeof item === 'string' ? item : item.address;
                  const time = typeof item === 'string' ? null : item.createdAt;
                  return (
                    <div key={addr + idx} onClick={() => setupAccount(addr.split('@')[0])}
                      className={`p-4 cursor-pointer transition-all hover:bg-slate-800/40 ${address === addr ? 'bg-indigo-600/10 border-l-4 border-l-indigo-500' : 'border-l-4 border-l-transparent'}`}>
                      <div className="flex flex-col gap-1">
                        <span className={`text-sm font-mono truncate ${address === addr ? 'text-indigo-400 font-bold' : 'text-slate-300'}`}>{addr}</span>
                        <span className="text-[10px] text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> {time ? new Date(time).toLocaleString() : '未知'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="w-80 border-r border-slate-800 flex flex-col bg-slate-950/30 overflow-hidden shrink-0">
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                {refreshing ? <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" /> : <Inbox className="w-8 h-8 text-slate-600" />}
                <p className="text-xs text-slate-500 mt-4">等待邮件中...</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800/50">
                {messages.map((msg) => (
                  <div key={msg.id} onClick={() => fetchMessageDetail(msg.id)}
                    className={`p-4 cursor-pointer hover:bg-slate-800/50 ${selectedMessage?.id === msg.id ? 'bg-indigo-600/10 border-l-4 border-l-indigo-500' : 'border-l-4 border-l-transparent'}`}>
                    <div className="flex justify-between items-start mb-1">
                      <span className={`text-sm font-bold truncate ${msg.seen ? 'text-slate-500' : 'text-white'}`}>{msg.from.name || msg.from.address}</span>
                      <span className="text-[10px] text-slate-500">{msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString() : ''}</span>
                    </div>
                    <h4 className="text-xs truncate text-slate-300">{msg.subject || '(无主题)'}</h4>
                    {/* 卡片上直接显示提取到的链接（邀请链接高亮），不用点开详情 */}
                    <LinkChips links={msg.links} max={2} idPrefix={`m${msg.id}`} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col bg-slate-950/50 overflow-hidden">
          {msgLoading ? <div className="h-full flex items-center justify-center"><Loader2 className="w-10 h-10 animate-spin" /></div> : selectedMessage ? (
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              <div className="p-8">
                <div className="mb-6 pb-6 border-b border-slate-800 flex justify-between items-start">
                  <div>
                    <h1 className="text-2xl font-bold text-white mb-4">{selectedMessage.subject}</h1>
                    <div className="flex items-center gap-2 text-sm text-slate-400">
                      <span className="font-bold text-white">{selectedMessage.from.name || selectedMessage.from.address}</span>
                      {selectedMessage.from.name && <span>&lt;{selectedMessage.from.address}&gt;</span>}
                    </div>
                  </div>
                  <button onClick={() => setSelectedMessage(null)} className="p-2 text-slate-500 hover:text-rose-500"><Trash2 className="w-5 h-5" /></button>
                </div>
                {/* 详情顶部：全部提取链接（复制/打开），不用去 iframe 正文里找 */}
                <LinkChips links={selectedMessage.links} idPrefix={`d${selectedMessage.id}`} />
                <div className={`bg-white rounded-xl overflow-hidden ${selectedMessage.links.length > 0 ? 'mt-4' : 'mb-8'}`}>
                  {selectedMessage.html && selectedMessage.html.length > 0 ? (
                    <iframe
                      title="email"
                      // 邮件 HTML 大多没自带样式：注入基础排版，正文窄屏可读、图片不溢出、链接新窗口打开
                      srcDoc={`<base target="_blank"><style>body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6;color:#0f172a;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%!important}pre{white-space:pre-wrap}</style>${selectedMessage.html[0]}`}
                      className="w-full min-h-[600px] border-none"
                    />
                  ) : (
                    // 纯文本邮件：用正常字体显示（等宽字体会让人误以为是源码）
                    <div className="p-6 text-slate-800 whitespace-pre-wrap break-words text-sm leading-relaxed">{selectedMessage.text}</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-slate-600">
              <ShieldCheck className="w-12 h-12 mb-4 opacity-20" />
              <p>请选择一封邮件查看详情</p>
            </div>
          )}
        </div>
      </div>

      {showHelp && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowHelp(false)}></div>
          <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl p-6">
            <h3 className="text-xl font-bold text-white mb-4">使用说明 (V6.0.0)</h3>
            <div className="space-y-4 text-slate-300 text-sm">
              <p>自有域名收信：地址固定为 @{MAIL_DOMAIN}，无需注册与密码，知道地址即可收信。</p>
              <div className="p-3 bg-black rounded font-mono text-[10px] text-indigo-400">
                [ADDR] {address}
              </div>
              <p className="text-xs text-slate-500">邮件由 Cloudflare Email Routing 接收后转发到本系统，页面每 5 秒自动同步一次。</p>
            </div>
            <button onClick={() => setShowHelp(false)} className="w-full mt-6 py-3 bg-indigo-600 text-white font-bold rounded-xl">关闭</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmailSystem;
