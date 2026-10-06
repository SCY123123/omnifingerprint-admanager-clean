// @ts-nocheck
/**
 * 主页广告贴文 / 消息对话 viewer
 * - PagePostsViewer: 展示各 Facebook 主页的 Timeline 贴文（获取信息时同步）
 * - PageConversationsViewer: 展示主页收件箱对话（获取信息时同步）
 */
import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, ExternalLink, Search, MessageSquare, FileText, X, User, Image as ImageIcon, Languages, Send, Loader2, BellRing, Sparkles, Video, Trash2, FolderOpen, ThumbsUp, MessageCircle, Share2, EyeOff, Eye, Lock, Reply } from 'lucide-react';
import { LOCAL_SERVER_SECRET, getLaunchServerUrl } from '../utils/constants';
import { loadAIReplyPrompt } from './AutoReplySettings';
import * as AIQ from './aiQueue';
import { subscribe as watchSubscribe, snapshot as watchSnapshot, addMany as watchAddMany, removeKeys as watchRemoveKeys, setPollSec as watchSetPollSec, getPollSec as watchGetPollSec, setCooldownSec as watchSetCooldownSec, getCooldownSec as watchGetCooldownSec, runWatch as watchRunNow, getFollowEnabled as watchGetFollowOn, setFollowEnabled as watchSetFollowOn, getFollowMinSec as watchGetFollowMin, setFollowMinSec as watchSetFollowMin, getFollowMaxPerDay as watchGetFollowMax, setFollowMaxPerDay as watchSetFollowMax, addPage as watchAddPage, removePage as watchRemovePage, isPageWatching as watchIsPageOn, snapshotPages as watchSnapPages } from './aiWatch';
import { cacheSentMsg, mergeSentCacheIntoRow } from './sentCache';
import { useAppContext } from './AppContext';

interface PostRow {
  id?: string;
  profile_id: string;
  page_id: string;
  page_name?: string;
  fb_post_id?: string;
  message?: string;
  story?: string;
  permalink_url?: string;
  full_picture?: string;
  created_time?: string;
  /** 贴文来源：page=主页 Timeline / ad=广告创意引用的贴文（含未发布 dark post）/ page,ad=两者都有 */
  source?: string;
  /** 互动数据（获取信息时同步；token 缺 pages_read_engagement 时为 0） */
  likes_count?: number;
  comments_count?: number;
  shares_count?: number;
}

// 互动数据渲染（点赞/评论/分享）—— 全为 0 时显示占位符
const PostEngagement: React.FC<{ likes?: number; comments?: number; shares?: number }> = ({ likes, comments, shares }) => {
  const l = Number(likes || 0), c = Number(comments || 0), s = Number(shares || 0);
  if (!l && !c && !s) return <span className="text-slate-600">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs whitespace-nowrap">
      <span className="inline-flex items-center gap-1 text-sky-300" title="点赞">
        <ThumbsUp className="w-3.5 h-3.5" />{l}
      </span>
      <span className="inline-flex items-center gap-1 text-emerald-300" title="评论">
        <MessageCircle className="w-3.5 h-3.5" />{c}
      </span>
      <span className="inline-flex items-center gap-1 text-amber-300" title="分享">
        <Share2 className="w-3.5 h-3.5" />{s}
      </span>
    </span>
  );
};

// 来源标签渲染（老数据无 source 字段时按「主页」处理）
const POST_SOURCE_STYLE: Record<string, { text: string; cls: string }> = {
  page: { text: '主页', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/40' },
  ad: { text: '广告', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  'page,ad': { text: '主页·广告', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
};
const PostSourceTag: React.FC<{ source?: string }> = ({ source }) => {
  const key = String(source || 'page');
  const s = POST_SOURCE_STYLE[key] || { text: key, cls: 'bg-slate-700/40 text-slate-300 border-slate-600' };
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-xs whitespace-nowrap ${s.cls}`}>{s.text}</span>;
};

interface ConvRow {
  id?: string;
  profile_id: string;
  page_id: string;
  page_name?: string;
  conversation_id?: string;
  updated_time?: string;
  message_count?: number;
  unread_count?: number;
  participants_json?: string;
  messages_json?: string;
  snippet?: string;
}

const fmtTime = (v?: string) => {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtName = (v: string | undefined) => {
  if (!v) return '-';
  return String(v).length > 30 ? String(v).slice(0, 30) + '…' : String(v);
};

// 从 participants_json 中取对话对象（去掉主页自身名称）
const getParticipantNames = (c: ConvRow): string[] => {
  try {
    const raw = JSON.parse(c.participants_json || '{}');
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const self = String(c.page_name || '');
    return list.map((p: any) => String(p?.name || p?.id || '')).filter((n: string) => n && (!self || !n.includes(self)));
  } catch {
    return [];
  }
};

// 解析 messages_json 成 [{id, from, text, time, created}]
const parseMessages = (c: ConvRow): Array<{ id: string; from: string; text: string; time: string; created: string }> => {
  try {
    const raw = JSON.parse(c.messages_json || '[]');
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    return list
      .filter((m: any) => m && (m.message || m.story || m.id))
      .map((m: any) => ({
        id: String(m.id || ''),
        from: String(m?.from?.name || m?.from?.id || '对方'),
        text: String(m.message || m.story || '') || (Array.isArray(m?.attachments) && m.attachments[0] ? (String(m.attachments[0].type || '') === 'video' ? '[视频]' : '[图片]') : ''),
        time: m.created_time ? fmtTime(m.created_time) : '',
        created: m.created_time ? String(m.created_time) : '',
      }));
  } catch {
    return [];
  }
};

const useProfileNameMap = () => {
  const { profiles } = useAppContext();
  return useMemo(() => {
    const m = new Map<string, string>();
    profiles.forEach((p: any) => m.set(String(p.id), String(p.name || p.account_name || '')));
    return m;
  }, [profiles]);
};

const getSbase = () => {
  let sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
  try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = ''; } catch {}
  return sbase;
};

// 拉取主页贴文/收件箱对话（支持按配置与主页过滤；pageId 过滤由后端支持）
const fetchContentRows = async (kind: 'posts' | 'messages', profileId: string, pageId: string, token: string) => {
  const authToken = token || localStorage.getItem('auth_token');
  if (!authToken) return [];
  const params = new URLSearchParams({ _t: String(Date.now()) });
  if (profileId) params.set('profileId', profileId);
  if (pageId) params.set('pageId', pageId);
  const resp = await fetch(`${getSbase()}/api/${kind}?${params.toString()}`, {
    headers: { 'Cache-Control': 'no-cache', 'Authorization': `Bearer ${authToken}` },
  });
  const json = await resp.json();
  return Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
};

const useContentList = (kind: 'posts' | 'messages', profileId: string, pageId: string, opts?: { pollMs?: number }) => {
  const { token } = useAppContext();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const _sigRef = useRef('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await fetchContentRows(kind, profileId, pageId, token || '');
      // 比较签名：变多（新贴文/新对话）才广播，供页面弹通知
      const sig = next.map((r: any) => `${r.updated_time || r.created_time || ''}|${r.snippet || r.message || ''}`).join('###');
      if (_sigRef.current && sig !== _sigRef.current) {
        const grew = next.length >= 0;
        if (grew && next.length > 0) {
          window.dispatchEvent(new CustomEvent(kind === 'messages' ? 'messages-new' : 'posts-new', {
            detail: { total: next.length, newest: next[0] || null },
          }));
        }
      }
      _sigRef.current = sig;
      setRows(next);
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token, kind, profileId, pageId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const ev = kind === 'posts' ? 'posts-refresh' : 'messages-refresh';
    const handler = () => load();
    window.addEventListener(ev, handler as any);
    return () => window.removeEventListener(ev, handler as any);
  }, [load, kind]);

  // 消息页轮询：接近实时的“半实时”通知（页面可见时才轮询）
  useEffect(() => {
    const ms = kind === 'messages' && opts?.pollMs ? opts.pollMs : 0;
    if (!ms) return;
    const h = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      load();
    }, ms);
    return () => clearInterval(h);
  }, [kind, opts?.pollMs, load]);

  return { rows, loading, error, reload: load };
};

// ============ 消息翻译 / 语言检测 / 发送（消息对话页使用） ============
// 可选的译文语言（用于“对方消息→我方阅读语言”与“我方草稿→对方语言”）
const TRANS_LANGS: Record<string, string> = {
  zh: '中文', en: 'English', tr: 'Türkçe', vi: 'Tiếng Việt', ar: 'العربية', fr: 'Français',
  de: 'Deutsch', es: 'Español', pt: 'Português', id: 'Bahasa Indonesia', th: 'ไทย',
  ms: 'Bahasa Melayu', ja: '日本語', ko: '한국어', ru: 'Русский', it: 'Italiano',
  pl: 'Polski', nl: 'Nederlands', uk: 'Українська', fa: 'فارسی',
};
// 翻译引擎（消息对话页「翻译引擎」下拉手动切换；按选择直接用，不做自动降级）
const TRANS_ENGINES: Record<string, string> = {
  ai: 'AI 翻译（Gemini/DeepSeek）',
  google: 'Google 免费翻译',
  libre: 'LibreTranslate（自建）',
  geminiweb: 'Gemini Web（免费）',
};
const TR_ENGINE_KEY = 'fb_tr_engine_v1';
let _trEngine = 'ai';
try { const v = localStorage.getItem(TR_ENGINE_KEY); if (v && TRANS_ENGINES[v]) _trEngine = v; } catch {}
const setTrEngine = (e: string) => {
  _trEngine = TRANS_ENGINES[e] ? e : 'ai';
  try { localStorage.setItem(TR_ENGINE_KEY, _trEngine); } catch {}
};
// 会话内翻译缓存：key = `${引擎}__${to}__${text}`
// 内存层（本次会话）+ localStorage 持久层（跨刷新/跨页面），已翻译的文本不再重复请求翻译接口
// 引擎进 key 是必须的：否则切换引擎后命中旧引擎的译文，开关等于没生效
const TR_PERSIST_KEY = 'fb_tr_persist_v1';
const _trCache = new Map<string, string>();
const _trPersist = new Map<string, string>();
try {
  const raw = localStorage.getItem(TR_PERSIST_KEY);
  if (raw) {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') Object.entries(j).forEach(([k, v]) => { if (k && v) _trPersist.set(String(k), String(v)); });
  }
} catch {}
let _persistTimer: any = null;
const persistTranslations = () => {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const entries = Array.from(_trPersist.entries());
      if (entries.length > 20000) { for (let i = 0; i < entries.length - 20000; i++) _trPersist.delete(entries[i][0]); }
      localStorage.setItem(TR_PERSIST_KEY, JSON.stringify(Object.fromEntries(_trPersist)));
    } catch {}
  }, 400);
};
const _trPending = new Map<string, Promise<string>>();
// 失败负缓存（仅内存，60s）：以前失败会把空串写进 _trCache 且永久命中，
// 结果引擎一挂这些文本就永远空白、切引擎也救不回来。改成只挡 60s，既不刷屏请求又能自动恢复。
const _trFail = new Map<string, number>();
const TR_FAIL_TTL_MS = 60000;

const callTranslateApi = async (texts: string[], to: string, detectOnly = false): Promise<{ translations: string[]; detected: string; detectedName: string }> => {
  const sbase = getSbase();
  const token = localStorage.getItem('auth_token') || '';
  const resp = await fetch(`${sbase}/api/ai/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
    body: JSON.stringify(detectOnly ? { texts: texts.slice(0, 1), detect: true } : { texts, to, engine: _trEngine }),
  });
  const j = await resp.json().catch(() => null);
  if (!j || j.success === false) throw new Error((j && (j.error || j.message)) || `翻译服务调用失败 (HTTP ${resp.status})`);
  return { translations: Array.isArray(j.translations) ? j.translations : [], detected: j.detected || '', detectedName: j.detectedName || '' };
};

// 单条文本翻译（内存 + localStorage 双层缓存；只对缓存未命中的文本发请求，已翻译的不会重复调用）
const translateText = (text: string, to: string): Promise<string> => {
  const t = String(text || '').trim();
  if (!t || !to) return Promise.resolve('');
  const key = `${_trEngine}__${to}__${t}`;
  const hit = _trCache.get(key) !== undefined ? _trCache.get(key) : _trPersist.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const failedAt = _trFail.get(key);
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < TR_FAIL_TTL_MS) return Promise.resolve('');
    _trFail.delete(key);
  }
  let p = _trPending.get(key);
  if (!p) {
    p = callTranslateApi([t], to)
      .then(r => {
        const v = (r.translations && r.translations[0]) || '';
        _trCache.set(key, v);
        if (v) { _trPersist.set(key, v); persistTranslations(); }
        return v;
      })
      .catch(() => {
        // 不写 _trCache（避免永久空串），只记一个 60s 的负缓存
        _trFail.set(key, Date.now());
        return '';
      })
      .finally(() => { _trPending.delete(key); });
    _trPending.set(key, p);
  }
  return p;
};

// 批量翻译（chunk 并发，避免打爆翻译接口）
const translateBatch = async (texts: string[], to: string, onOne?: (text: string, trans: string) => void): Promise<void> => {
  const uniq = Array.from(new Set(texts.map(t => String(t || '').trim()).filter(Boolean)));
  for (let i = 0; i < uniq.length; i += 8) {
    const chunk = uniq.slice(i, i + 8);
    await Promise.all(chunk.map(async t => {
      const v = await translateText(t, to);
      if (onOne && v) onOne(t, v);
    }));
  }
};

// 检测语言（用于“自动(对方语言)”回复目标）
const detectLanguage = (text: string): Promise<string> => {
  const t = String(text || '').trim();
  if (!t) return Promise.resolve('');
  return callTranslateApi([t], 'zh', true)
    .then(r => r.detected || '')
    .catch(() => '');
};

// 会话内 peer（对话对象）提取：优先返回 psid，其次 name
const getPeer = (c: ConvRow): { id: string; name: string } => {
  try {
    const raw = JSON.parse(c.participants_json || '{}');
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const self = String(c.page_name || '');
    const others = list.filter((p: any) => p && !self.includes(String(p?.name || '')));
    const p0 = others[0] || list[0];
    return { id: p0 ? String(p0.id || '') : '', name: p0 ? String(p0.name || p0.id || '') : '' };
  } catch {
    return { id: '', name: '' };
  }
};

// 会话最后一条消息归属与文本（列表消息预览标记 我/对方 + 用最后一条文字作预览内容）
const lastMsgSender = (c: ConvRow): { from: string; tag: 'self' | 'peer' | ''; text: string } => {
  const fallback = { from: '', tag: '' as const, text: c.snippet ? String(c.snippet) : '' };
  try {
    const msgs = parseMessages(c).filter(m => m.text);
    if (!msgs.length) return fallback;
    let last = msgs[0];
    for (const m of msgs) {
      if (String(m.time || '') >= String(last.time || '')) last = m;
    }
    const f = String(last.from || '');
    const self = f.includes('|')
      || (!!c.page_name && f === String(c.page_name))
      || (!!c.page_id && f === String(c.page_id));
    return { from: f, tag: self ? 'self' : 'peer', text: String(last.text || '') };
  } catch {
    return fallback;
  }
};

// 判定该对话“待我方回复”：最后一条文字消息是对方发的，或存在未读数
const isUnrepliedConv = (c: ConvRow): boolean => lastMsgSender(c).tag === 'peer' || Number(c.unread_count || 0) > 0;

// 构造一条与 Graph 形态一致的本地乐观消息（解析器可识别 message/created_time，能正常渲染并沉底）
const makeLocalMsg = (out: string, conv: ConvRow) => ({
  id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  message: out,
  from: { name: String(conv.page_name || '我'), id: String(conv.page_id || '') },
  created_time: new Date().toISOString(),
});

// 向会话 messages_json 追加一条消息（保留 {data} wrapper 形态），返回新 ConvRow
const withLocalMsg = (conv: ConvRow, msg: any): ConvRow => {
  try {
    const raw = JSON.parse(conv.messages_json || '[]');
    const hasWrapper = Array.isArray(raw?.data);
    const src = hasWrapper ? raw.data : Array.isArray(raw) ? raw : [];
    const arr = Array.isArray(src) ? [...src, msg] : [msg];
    return { ...conv, messages_json: JSON.stringify(hasWrapper ? { data: arr } : arr), updated_time: String(msg.created_time || '') };
  } catch {
    return conv;
  }
};

// 从会话 messages_json 中移除某条（发送失败回滚用，按 id 匹配）
const withoutMsg = (conv: ConvRow, id: string): ConvRow => {
  try {
    const raw = JSON.parse(conv.messages_json || '[]');
    const hasWrapper = Array.isArray(raw?.data);
    const src = hasWrapper ? raw.data : Array.isArray(raw) ? raw : [];
    const arr = Array.isArray(src) ? src.filter((m: any) => String(m?.id || '') !== id) : [];
    return { ...conv, messages_json: JSON.stringify(hasWrapper ? { data: arr } : arr) };
  } catch {
    return conv;
  }
};

// 会话本地“已发送”持久缓存与合并逻辑在 sentCache.ts（与 aiQueue/aiWatch 共用，保证刷新后仍可见）

// 对话行唯一键（用于列表 overlay：发送成功后让该行预览立刻变成刚发的最新消息）
const ovKey = (c: { page_id?: string; conversation_id?: string }) =>
  `${String(c.page_id || '')}::${String(c.conversation_id || '')}`;

// 含配置的完整对话键（队列去重/勾选用：profile::page::conv）
const convRowKey = (c: { profile_id?: string; page_id?: string; conversation_id?: string }) =>
  `${String(c.profile_id || '')}::${String(c.page_id || '')}::${String(c.conversation_id || '')}`;

// 转成 AI 回复队列任务输入（含收件人 id 快照）
const toWatchInput = (c: ConvRow): any => {
  const peer = getPeer(c);
  const peers = getParticipantNames(c);
  return {
    key: convRowKey(c),
    profileId: String(c.profile_id || ''),
    pageId: String(c.page_id || ''),
    conversationId: String(c.conversation_id || ''),
    pageName: String(c.page_name || ''),
    userId: peer.id,
    peerName: peer.name || peers.join(', ') || String(c.conversation_id || '').slice(0, 12),
  };
};
const toTaskInput = (c: ConvRow): any => ({ ...toWatchInput(c), messages_json: String(c.messages_json || '') });

// 本机浏览器服务的发送接口
const LOCAL_API_BASE = 'http://localhost:9999/api';
const LOCAL_API_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';
const sendFbMessage = async (payload: { profileId: string; pageId: string; conversationId: string; message: string; userId?: string; pageName?: string; attachment?: { base64: string; mimeType?: string; kind?: string } }, timeoutMs = 150000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${LOCAL_API_BASE}/facebook/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_API_SECRET },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let j: any = null;
    try { j = await resp.json(); } catch {}
    if (!resp.ok || !j || j.success === false) {
      throw new Error((j && j.message) || (j && j.error) || `发送失败(HTTP ${resp.status})`);
    }
    return j;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('发送超时，已自动放弃本次发送（本机浏览器服务处理较慢）。若消息实际已发出，可稍后点「拉取更新」确认。');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

// ============ AI 自动回复（围绕提示词 + 该对话近期记录生成一条回复） ============
const callAIReplyApi = async (system: string, historyText: string, timeoutMs = 60000): Promise<string> => {
  const sbase = getSbase();
  const token = localStorage.getItem('auth_token') || '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${sbase}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.7,
        messages: [
          { role: 'system', content: `${system}\n\n重要：你只需输出要发送给客户的一条回复正文，不要调用任何工具/函数，不要输出引号、JSON 或解释。` },
          { role: 'user', content: historyText },
        ],
      }),
    });
    const j = await resp.json();
    if (!j || j.success === false) throw new Error((j && (j.error || j.message)) || 'AI 服务调用失败');
    return String(j.message || '').trim();
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('AI 生成超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

// 根据对话行拼装“近期聊天记录”文本（对方可识别名字，最近 N 条）
const buildConversationHistory = (row: ConvRow, max = 16): string => {
  const pageName = String(row.page_name || '我');
  const msgs = parseMessages(row).slice(-max);
  const selfName = String(row.page_name || '');
  const lines = msgs.map(m => {
    const isSelf = !m.from || m.from === selfName || (m.from && String(row.page_name || '').includes(m.from));
    return `${isSelf ? `主页(${pageName})` : `对方(${m.from})`}: ${m.text}`;
  });
  return [`这是主页「${pageName}」与客户的 Messenger 对话记录（越靠后越新）：`, ...lines, '', '请根据以上内容与你的角色设定，给出作为主页方现在应该回复客户的一条正文。'].join('\n');
};

// ============ 贴文/对话数量统计（供 配置/广告号/主页/BM 列表展示） ============
// 模块级缓存：同一会话内多次打开列表不重复拉取全量
let _countsCache: { ts: number; posts: any[]; messages: any[] } = { ts: 0, posts: [], messages: [] };

export const useContentCounts = () => {
  const { token } = useAppContext();
  const [maps, setMaps] = useState<{
    profile: Record<string, { posts: number; messages: number }>;
    page: Record<string, { posts: number; messages: number }>;
  }>({ profile: {}, page: {} });

  const load = useCallback(async () => {
    try {
      if (!token && !localStorage.getItem('auth_token')) return;
      if (!_countsCache.ts || Date.now() - _countsCache.ts > 20000) {
        const [posts, messages] = await Promise.all([
          fetchContentRows('posts', '', '', token || '').catch(() => []),
          fetchContentRows('messages', '', '', token || '').catch(() => []),
        ]);
        _countsCache = { ts: Date.now(), posts, messages };
      }
      const profile: Record<string, { posts: number; messages: number }> = {};
      const page: Record<string, { posts: number; messages: number }> = {};
      const bump = (m: Record<string, { posts: number; messages: number }>, key: string, kind: 'posts' | 'messages') => {
        if (!key) return;
        const cur = m[key] || { posts: 0, messages: 0 };
        cur[kind] += 1;
        m[key] = cur;
      };
      _countsCache.posts.forEach((r: any) => {
        const pk = String(r.profile_id || '');
        bump(profile, pk, 'posts');
        bump(page, `${pk}|${String(r.page_id || '')}`, 'posts');
      });
      _countsCache.messages.forEach((r: any) => {
        const pk = String(r.profile_id || '');
        bump(profile, pk, 'messages');
        bump(page, `${pk}|${String(r.page_id || '')}`, 'messages');
      });
      setMaps({ profile, page });
    } catch {}
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const events = ['posts-refresh', 'messages-refresh', 'content-counts-refresh', 'adaccounts-refresh', 'pages-refresh', 'businesses-refresh'];
    const handler = () => {
      _countsCache.ts = 0; // 强制重新拉取
      load();
    };
    events.forEach((e) => window.addEventListener(e, handler as any));
    return () => events.forEach((e) => window.removeEventListener(e, handler as any));
  }, [load]);

  return maps;
};

// ============ 跳转 helper：从各列表跳转到贴文/对话页并预置筛选 ============
interface SocialPrefill { profileId?: string; pageId?: string; pageName?: string }

const readSocialPrefill = (key: string): SocialPrefill => {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      localStorage.removeItem(key);
      return JSON.parse(raw) || {};
    }
  } catch {}
  return {};
};

export const jumpToPosts = (prefill: SocialPrefill) => {
  try { localStorage.setItem('postsFilter', JSON.stringify(prefill || {})); } catch {}
  (window as any).setActiveTab?.('meta-posts');
};
export const jumpToMessages = (prefill: SocialPrefill) => {
  try { localStorage.setItem('messagesFilter', JSON.stringify(prefill || {})); } catch {}
  (window as any).setActiveTab?.('meta-messages');
};

const ProfileFilter: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const { profiles } = useAppContext();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
    >
      <option value="">全部配置</option>
      {profiles.map((p: any) => (
        <option key={p.id} value={p.id}>
          {p.name || p.account_name || `配置 ${p.id}`}
        </option>
      ))}
    </select>
  );
};

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <div className="text-center py-16 text-slate-500 text-sm">
    <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
    {text}
    <div className="mt-2 text-xs opacity-70">可在「获取信息」时自动拉取主页贴文 / 收件箱对话后刷新查看</div>
  </div>
);

// ==================== 贴文互动明细（点赞用户 / 评论 / 分享者）====================
interface EngReaction { from_id: string; from_name?: string; from_pic?: string; reaction_type?: string }
interface EngComment {
  comment_id: string; parent_id?: string; from_id: string; from_name?: string; from_pic?: string;
  message?: string; created_time?: string; like_count?: number; reply_count?: number;
  is_hidden?: number; can_hide?: number; can_remove?: number; can_reply_privately?: number;
}
interface EngShare { share_post_id: string; from_id?: string; from_name?: string; from_pic?: string; message?: string; created_time?: string }

const EngAvatar: React.FC<{ url?: string; name?: string; size?: number; onClick?: () => void; title?: string }> = ({ url, name, size = 36, onClick, title }) => {
  const [broken, setBroken] = useState(false);
  const initial = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  const style: React.CSSProperties = { width: size, height: size };
  const inner = (url && !broken)
    ? <img src={url} alt={name || ''} style={style} onError={() => setBroken(true)} className="rounded-full object-cover bg-slate-700 shrink-0" />
    : <span style={style} className="rounded-full bg-slate-700 text-slate-300 flex items-center justify-center text-sm font-medium shrink-0">{initial}</span>;
  if (!onClick) return inner;
  return (
    <button type="button" onClick={onClick} title={title} className="rounded-full ring-2 ring-transparent hover:ring-sky-500/60 transition cursor-pointer shrink-0">
      {inner}
    </button>
  );
};

const PostEngagementPanel: React.FC<{ post: PostRow; onClose: () => void }> = ({ post, onClose }) => {
  const { token } = useAppContext();
  const postProfileId = String(post.profile_id || '');
  const [tab, setTab] = useState<'reactions' | 'comments' | 'shares'>('comments');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<{ reactions: EngReaction[]; comments: EngComment[]; shares: EngShare[] }>({ reactions: [], comments: [], shares: [] });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [showHidden, setShowHidden] = useState(true);
  const [replyTo, setReplyTo] = useState<EngComment | null>(null);
  const [replyText, setReplyText] = useState('');
  const [dmTo, setDmTo] = useState<EngComment | null>(null);
  const [dmText, setDmText] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const authToken = token || localStorage.getItem('auth_token') || '';
      const qs = new URLSearchParams({ postId: String(post.fb_post_id || ''), _t: String(Date.now()) });
      if (postProfileId) qs.set('profileId', postProfileId);
      const resp = await fetch(`${getSbase()}/api/posts/engagement?${qs.toString()}`, {
        headers: { 'Cache-Control': 'no-cache', Authorization: `Bearer ${authToken}` },
      });
      const j = await resp.json();
      if (j && j.success && j.data) {
        setRows({ reactions: j.data.reactions || [], comments: j.data.comments || [], shares: j.data.shares || [] });
      } else setErr((j && (j.message || j.error)) || '加载失败');
    } catch (e: any) { setErr(e?.message || '加载失败'); }
    finally { setLoading(false); }
  }, [post.fb_post_id, postProfileId, token]);

  useEffect(() => { load(); }, [load]);

  // 评论类操作统一走本地后端（需要主页访问口令，云端没有）
  const callLocal = async (path: string, body: any) => {
    const resp = await fetch(`${getLaunchServerUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
      body: JSON.stringify({ profileId: postProfileId, ...body }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || !j || !j.success) throw new Error((j && j.message) || `本地后端返回 HTTP ${resp.status}`);
    return j;
  };

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 5000); };

  // 在 FB 端操作成功后，同步更新云端副本，避免下次打开面板看到旧状态
  const syncCloudPatch = (commentId: string, op: 'delete' | 'hide' | 'unhide') => {
    const authToken = token || localStorage.getItem('auth_token') || '';
    fetch(`${getSbase()}/api/posts/comment/patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ profileId: postProfileId, commentId, op }),
    }).catch(() => { });
  };

  const doHide = async (c: EngComment, want: boolean) => {
    setBusy(c.comment_id);
    try {
      await callLocal('/api/facebook/comment/hide', { commentId: c.comment_id, hidden: want });
      syncCloudPatch(c.comment_id, want ? 'hide' : 'unhide');
      setRows(prev => ({ ...prev, comments: prev.comments.map(x => x.comment_id === c.comment_id ? { ...x, is_hidden: want ? 1 : 0 } : x) }));
      flash(want ? '已隐藏该评论' : '已取消隐藏');
    } catch (e: any) { flash(`操作失败：${e?.message || e}`); }
    finally { setBusy(''); }
  };

  const doDelete = async (c: EngComment) => {
    if (!window.confirm('确定删除该评论？删除后不可恢复（会同步到 Facebook）。')) return;
    setBusy(c.comment_id);
    try {
      await callLocal('/api/facebook/comment/delete', { commentId: c.comment_id });
      syncCloudPatch(c.comment_id, 'delete');
      setRows(prev => ({ ...prev, comments: prev.comments.filter(x => x.comment_id !== c.comment_id && x.parent_id !== c.comment_id) }));
      flash('已删除该评论');
    } catch (e: any) { flash(`删除失败：${e?.message || e}`); }
    finally { setBusy(''); }
  };

  const doReply = async (c: EngComment) => {
    const text = replyText.trim();
    if (!text) return;
    setBusy(c.comment_id);
    try {
      await callLocal('/api/facebook/comment/reply', { commentId: c.comment_id, message: text });
      setReplyTo(null); setReplyText('');
      flash('回复已发送');
      setTimeout(load, 1500);
    } catch (e: any) { flash(`回复失败：${e?.message || e}`); }
    finally { setBusy(''); }
  };

  const doPrivateReply = async (c: EngComment) => {
    const text = dmText.trim();
    if (!text) return;
    setBusy(c.comment_id);
    try {
      await callLocal('/api/facebook/comment/private-reply', { commentId: c.comment_id, message: text });
      setDmTo(null); setDmText('');
      flash('私聊已发送：消息会进对方 Messenger，同时出现在「消息对话」里');
    } catch (e: any) { flash(`私聊失败：${e?.message || e}`); }
    finally { setBusy(''); }
  };

  const topComments = rows.comments.filter(c => !c.parent_id);
  const repliesOf = (id: string) => rows.comments.filter(c => c.parent_id === id);
  const shownComments = showHidden ? topComments : topComments.filter(c => !c.is_hidden);

  const tabBtn = (key: 'reactions' | 'comments' | 'shares', label: string, count: number, Icon: any) => (
    <button onClick={() => setTab(key)}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border ${tab === key ? 'bg-sky-600/20 text-sky-300 border-sky-500/50' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'}`}>
      <Icon className="w-3.5 h-3.5" /> {label}<span className="text-xs opacity-70">{count}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-slate-200 font-medium flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-sky-400 shrink-0" /> 贴文互动明细
            <span className="text-xs text-slate-500 truncate">#{post.fb_post_id}</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-slate-800">
          {tabBtn('reactions', '点赞用户', rows.reactions.length, ThumbsUp)}
          {tabBtn('comments', '评论', rows.comments.length, MessageCircle)}
          {tabBtn('shares', '分享者', rows.shares.length, Share2)}
          <span className="flex-1" />
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
        </div>

        {notice && <div className="mx-5 mt-3 text-xs text-sky-300 bg-sky-500/10 border border-sky-500/30 rounded-lg px-3 py-2">{notice}</div>}
        {err && <div className="mx-5 mt-3 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div>}

        <div className="p-5 overflow-y-auto flex-1">
          {loading && <div className="text-center py-10 text-slate-500 text-sm"><Loader2 className="w-5 h-5 mx-auto mb-2 animate-spin" />加载中…</div>}

          {!loading && tab === 'reactions' && (
            rows.reactions.length === 0
              ? <div className="text-center py-10 text-slate-500 text-sm">没有抓到点赞用户（可能该主页口令缺 pages_read_engagement 权限，或这条贴文没有点赞）</div>
              : <>
                <div className="text-xs text-slate-500 mb-3">点赞用户仅可查看：Facebook 没有开放「给点赞者发消息」的接口。</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {rows.reactions.map(r => (
                    <div key={r.from_id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700 min-w-0">
                      <EngAvatar url={r.from_pic} name={r.from_name} size={30} />
                      <span className="text-sm text-slate-200 truncate" title={r.from_name}>{r.from_name || r.from_id}</span>
                    </div>
                  ))}
                </div>
              </>
          )}

          {!loading && tab === 'shares' && (
            rows.shares.length === 0
              ? <div className="text-center py-10 text-slate-500 text-sm">没有抓到分享者（Meta 对分享者接口限制较严，多数情况只能拿到总数）</div>
              : <>
                <div className="text-xs text-slate-500 mb-3">分享者仅可查看：Facebook 没有开放「给分享者发消息」的接口。</div>
                <div className="space-y-2">
                  {rows.shares.map(s => (
                    <div key={s.share_post_id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700">
                      <EngAvatar url={s.from_pic} name={s.from_name} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-slate-200 truncate">{s.from_name || s.from_id}</div>
                        {s.message && <div className="text-xs text-slate-400 truncate">{s.message}</div>}
                      </div>
                      <div className="text-xs text-slate-500 whitespace-nowrap">{fmtTime(s.created_time)}</div>
                    </div>
                  ))}
                </div>
              </>
          )}

          {!loading && tab === 'comments' && (
            <>
              <div className="flex items-center justify-between mb-3">
                <label className="text-xs text-slate-400 inline-flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={showHidden} onChange={() => setShowHidden(v => !v)} className="accent-sky-500" />
                  显示已隐藏的评论
                </label>
                <span className="text-xs text-slate-500">点击评论者头像可私聊</span>
              </div>
              {shownComments.length === 0
                ? <div className="text-center py-10 text-slate-500 text-sm">没有抓到评论</div>
                : <div className="space-y-2">
                  {shownComments.map(c => {
                    const reps = repliesOf(c.comment_id);
                    return (
                      <div key={c.comment_id} className={`rounded-lg border ${c.is_hidden ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-700 bg-slate-800/50'}`}>
                        <div className="flex gap-3 p-3">
                          <EngAvatar url={c.from_pic} name={c.from_name} size={36}
                            onClick={c.can_reply_privately ? () => { setDmTo(c); setDmText(''); } : undefined}
                            title={c.can_reply_privately ? '点击私聊（私密回复）' : '该评论不支持私聊'} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm text-slate-200">{c.from_name || c.from_id}</span>
                              <span className="text-xs text-slate-500">{fmtTime(c.created_time)}</span>
                              {c.is_hidden ? <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">已隐藏</span> : null}
                              {!!c.like_count && <span className="text-xs text-slate-500">赞 {c.like_count}</span>}
                            </div>
                            <div className="text-sm text-slate-300 whitespace-pre-wrap mt-1">{c.message || '(无内容)'}</div>
                            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                              <button onClick={() => { setReplyTo(c); setReplyText(''); }} disabled={!!busy}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-700 disabled:opacity-40">
                                <Reply className="w-3 h-3" /> 回复
                              </button>
                              {c.can_reply_privately ? (
                                <button onClick={() => { setDmTo(c); setDmText(''); }} disabled={!!busy}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-sky-600/60 text-sky-300 hover:bg-sky-600/20 disabled:opacity-40">
                                  <Lock className="w-3 h-3" /> 私聊
                                </button>
                              ) : null}
                              {c.can_hide ? (
                                <button onClick={() => doHide(c, !c.is_hidden)} disabled={busy === c.comment_id}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-slate-600 text-slate-300 hover:bg-slate-700 disabled:opacity-40">
                                  {c.is_hidden ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}{c.is_hidden ? '取消隐藏' : '隐藏'}
                                </button>
                              ) : null}
                              {c.can_remove ? (
                                <button onClick={() => doDelete(c)} disabled={busy === c.comment_id}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-rose-600/60 text-rose-300 hover:bg-rose-600/20 disabled:opacity-40">
                                  <Trash2 className="w-3 h-3" /> 删除
                                </button>
                              ) : null}
                              {busy === c.comment_id && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                            </div>

                            {replyTo && replyTo.comment_id === c.comment_id && (
                              <div className="mt-2 flex gap-2">
                                <input value={replyText} onChange={e => setReplyText(e.target.value)} placeholder="以主页身份公开回复…"
                                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-sky-500" />
                                <button onClick={() => doReply(c)} disabled={!replyText.trim()}
                                  className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs disabled:opacity-40">发送</button>
                                <button onClick={() => setReplyTo(null)} className="px-2 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-xs">取消</button>
                              </div>
                            )}
                          </div>
                        </div>

                        {reps.length > 0 && (
                          <div className="pl-14 pr-3 pb-3 space-y-2">
                            {reps.map(rp => (
                              <div key={rp.comment_id} className="flex gap-2.5">
                                <EngAvatar url={rp.from_pic} name={rp.from_name} size={26}
                                  onClick={rp.can_reply_privately ? () => { setDmTo(rp); setDmText(''); } : undefined}
                                  title={rp.can_reply_privately ? '点击私聊（私密回复）' : undefined} />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs text-slate-300">{rp.from_name || rp.from_id}</span>
                                    <span className="text-xs text-slate-500">{fmtTime(rp.created_time)}</span>
                                    {!!rp.like_count && <span className="text-xs text-slate-500">赞 {rp.like_count}</span>}
                                  </div>
                                  <div className="text-xs text-slate-400 whitespace-pre-wrap">{rp.message || '(无内容)'}</div>
                                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                    {rp.can_hide ? (
                                      <button onClick={() => doHide(rp, !rp.is_hidden)} disabled={busy === rp.comment_id}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-slate-600 text-slate-300 hover:bg-slate-700 disabled:opacity-40">
                                        {rp.is_hidden ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}{rp.is_hidden ? '取消隐藏' : '隐藏'}
                                      </button>
                                    ) : null}
                                    {rp.can_remove ? (
                                      <button onClick={() => doDelete(rp)} disabled={busy === rp.comment_id}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-rose-600/60 text-rose-300 hover:bg-rose-600/20 disabled:opacity-40">
                                        <Trash2 className="w-3 h-3" /> 删除
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              }
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 text-xs text-slate-500">
          互动明细在「获取信息」时同步；隐藏 / 删除 / 回复 / 私聊需要该配置已跑过一次「获取信息」（主页口令存在本地）。
        </div>
      </div>

      {dmTo && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={(e) => { e.stopPropagation(); setDmTo(null); }}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
              <div className="text-slate-200 font-medium flex items-center gap-2"><Lock className="w-4 h-4 text-sky-400" /> 私聊（私密回复）</div>
              <button onClick={() => setDmTo(null)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-3">
              <div className="flex items-center gap-3">
                <EngAvatar url={dmTo.from_pic} name={dmTo.from_name} size={40} />
                <div className="min-w-0">
                  <div className="text-sm text-slate-200 truncate">{dmTo.from_name || dmTo.from_id}</div>
                  <div className="text-xs text-slate-500 truncate">{dmTo.message}</div>
                </div>
              </div>
              <textarea value={dmText} onChange={e => setDmText(e.target.value)} rows={4}
                placeholder="以主页身份发送私密消息…（对方会在 Messenger 收到）"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500" />
              <div className="text-xs text-slate-500">Facebook 只允许在对方评论后 7 天内发私密回复；发送后该消息也会出现在「消息对话」列表中。</div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setDmTo(null)} className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-sm">取消</button>
                <button onClick={() => doPrivateReply(dmTo)} disabled={!dmText.trim() || busy === dmTo.comment_id}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm disabled:opacity-40">
                  <Send className="w-3.5 h-3.5" /> 发送私聊
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ==================== 主页广告贴文 ====================
export const PagePostsViewer: React.FC = () => {
  const pNameMap = useProfileNameMap();
  const [filter, setFilter] = useState<SocialPrefill>(() => readSocialPrefill('postsFilter'));
  const profileId = filter.profileId || '';
  const pageId = filter.pageId || '';
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'' | 'page' | 'ad'>(''); // 来源筛选：''=全部
  const [detail, setDetail] = useState<PostRow | null>(null);
  const [engPost, setEngPost] = useState<PostRow | null>(null); // 互动明细面板
  const { rows, loading, error, reload } = useContentList('posts', profileId, pageId);

  // —— 多选 + 批量删除云端贴文存档 ——
  const [selPosts, setSelPosts] = useState<Set<string>>(new Set());
  const [deletingPosts, setDeletingPosts] = useState(false);
  const postId = (p: PostRow) => String((p as any).id ?? p.fb_post_id ?? `${p.page_id}_${p.fb_post_id}`);
  const toggleAllPosts = () => {
    setSelPosts(prev => {
      const next = new Set(prev);
      const allOn = filtered.length > 0 && filtered.every((p: PostRow) => next.has(postId(p)));
      filtered.forEach((p: PostRow) => { if (allOn) next.delete(postId(p)); else next.add(postId(p)); });
      return next;
    });
  };
  const batchDeletePosts = async () => {
    const targets = filtered.filter((p: PostRow) => selPosts.has(postId(p)));
    if (!targets.length) return;
    if (!window.confirm(`确定删除选中的 ${targets.length} 条贴文存档？仅删除系统内保存的记录，不会影响 Facebook 上的原文，可重新拉取恢复。`)) return;
    setDeletingPosts(true);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const resp = await fetch(`${getSbase()}/api/posts/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
        body: JSON.stringify({ ids: targets.map(p => String((p as any).id)).filter(Boolean) }),
      });
      const j = await resp.json();
      if (j && j.success) {
        setSelPosts(new Set());
        reload();
      } else {
        alert((j && (j.message || j.error)) || '删除失败，请重试');
      }
    } catch (e: any) {
      alert('请求失败：' + (e?.message || String(e)));
    } finally {
      setDeletingPosts(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (sourceFilter) {
      list = list.filter((r: PostRow) => String(r.source || 'page').split(',').includes(sourceFilter));
    }
    if (!q) return list;
    return list.filter((r: PostRow) =>
      [r.page_name, r.message, r.story, r.page_id].some(v => v && String(v).toLowerCase().includes(q))
    );
  }, [rows, search, sourceFilter]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <FileText className="w-5 h-5 text-sky-400" /> 主页广告贴文
        </h2>
        <span className="px-2 py-0.5 text-xs rounded-full bg-slate-800 text-slate-400">{rows.length} 条</span>
        <div className="flex-1" />
        <div className="flex items-center rounded-lg border border-slate-700 overflow-hidden text-xs">
          {([['', '全部来源'], ['page', '主页贴文'], ['ad', '广告贴文']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setSourceFilter(v)}
              className={`px-2.5 py-1.5 whitespace-nowrap ${sourceFilter === v ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索主页/内容…"
            className="bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
        {filter.pageName && (
          <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 text-xs">
            主页：{filter.pageName}
            <button onClick={() => setFilter(f => ({ ...f, pageId: '', pageName: '' }))} title="清除主页筛选" className="p-0.5 hover:text-white"><X className="w-3.5 h-3.5" /></button>
          </span>
        )}
        {selPosts.size > 0 && (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-200 px-2.5 py-1.5 rounded-lg bg-sky-600/15 border border-sky-500/40">已选 {selPosts.size} 条</span>
            <button onClick={() => setSelPosts(new Set())} className="px-2 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-xs hover:bg-slate-800">清除选择</button>
            <button onClick={batchDeletePosts} disabled={deletingPosts} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> {deletingPosts ? '删除中…' : '删除选中贴文'}
            </button>
          </span>
        )}
        <ProfileFilter value={profileId} onChange={(v) => setFilter(f => ({ profileId: v, pageId: '', pageName: '' }))} />
        <button onClick={reload} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
        </button>
      </div>

      {error && <div className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-3">{error}</div>}

      {!loading && filtered.length === 0 && <EmptyState text={search ? '无匹配贴文' : '暂无贴文数据'} />}

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
              <th className="px-4 py-2.5 w-8">
                <input type="checkbox"
                  checked={filtered.length > 0 && filtered.every((p: PostRow) => selPosts.has(postId(p)))}
                  onChange={toggleAllPosts} title="全选当前列表"
                  className="accent-sky-500 cursor-pointer" />
              </th>
              <th className="px-4 py-2.5">发布时间</th>
              <th className="px-4 py-2.5">配置</th>
              <th className="px-4 py-2.5">主页</th>
              <th className="px-4 py-2.5">来源</th>
              <th className="px-4 py-2.5 w-32">互动</th>
              <th className="px-4 py-2.5">内容</th>
              <th className="px-4 py-2.5 w-24">原文</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p: PostRow, idx: number) => {
              return (
                <tr key={p.fb_post_id || idx} onClick={() => setDetail(p)} className="border-b border-slate-800/60 hover:bg-slate-800/50 cursor-pointer">
                  <td className="px-4 py-2.5 w-8" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox"
                      checked={selPosts.has(postId(p))}
                      onChange={() => setSelPosts(prev => { const n = new Set(prev); const k = postId(p); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                      title="勾选（勾选后可批量删除）"
                      className="accent-sky-500 cursor-pointer" />
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{fmtTime(p.created_time) || '-'}</td>
                  <td className="px-4 py-2.5 text-slate-300">{pNameMap.get(String(p.profile_id)) || `配置 ${p.profile_id}`}</td>
                  <td className="px-4 py-2.5 text-slate-200 max-w-[140px] truncate" title={p.page_name}>{p.page_name || '-'}</td>
                  <td className="px-4 py-2.5"><PostSourceTag source={p.source} /></td>
                  <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setEngPost(p)}
                      title="查看互动明细（点赞用户 / 评论 / 分享者）"
                      className="rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-slate-700/60 transition cursor-pointer">
                      <PostEngagement likes={p.likes_count} comments={p.comments_count} shares={p.shares_count} />
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-slate-300 max-w-[480px] truncate" title={p.message}>
                    {p.full_picture && <ImageIcon className="inline w-3.5 h-3.5 mr-1 text-slate-500" />}
                    {p.message ? fmtName(p.message) : (p.story ? `(故事) ${fmtName(p.story)}` : '(无文字内容)')}
                  </td>
                  <td className="px-4 py-2.5">
                    {p.permalink_url ? (
                      <a href={p.permalink_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
              <div className="text-slate-200 font-medium flex items-center gap-2">
                <FileText className="w-4 h-4 text-sky-400" /> 贴文详情
                <span className="text-xs text-slate-500">#{detail.fb_post_id}</span>
              </div>
              <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 overflow-y-auto space-y-4 text-sm">
              <div className="text-xs text-slate-400 space-x-4">
                <span>{pNameMap.get(String(detail.profile_id)) || `配置 ${detail.profile_id}`}</span>
                <span className="text-sky-400">{detail.page_name}</span>
                <span>{fmtTime(detail.created_time)}</span>
                <PostSourceTag source={detail.source} />
              </div>
              {detail.full_picture && (
                <div className="rounded-lg overflow-hidden border border-slate-800">
                  <img src={detail.full_picture} alt="post" className="max-h-72 w-full object-contain bg-slate-950" onError={(e: any) => { e.target.style.display = 'none'; }} />
                </div>
              )}
              <div className="text-slate-200 whitespace-pre-wrap">{detail.message || detail.story || '(无文字内容)'}</div>
              <div className="flex items-center gap-4 px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700">
                <span className="text-xs text-slate-400">互动数据</span>
                <PostEngagement likes={detail.likes_count} comments={detail.comments_count} shares={detail.shares_count} />
              </div>
              {detail.permalink_url && (
                <a href={detail.permalink_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600/20 text-sky-400 border border-sky-600/30 hover:bg-sky-600/30">
                  <ExternalLink className="w-3.5 h-3.5" /> 查看原文
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {engPost && <PostEngagementPanel post={engPost} onClose={() => setEngPost(null)} />}
    </div>
  );
};

// ==================== 消息对话 ====================
export const PageConversationsViewer: React.FC = () => {
  const pNameMap = useProfileNameMap();
  const [filter, setFilter] = useState<SocialPrefill>(() => readSocialPrefill('messagesFilter'));
  const profileId = filter.profileId || '';
  const pageId = filter.pageId || '';
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<ConvRow | null>(null);
  const { rows, loading, error, reload } = useContentList('messages', profileId, pageId, { pollMs: 20000 });
  const [notice, setNotice] = useState('');

  // —— 自动关闭对话详情开关（开启后发送消息成功才自动关闭详情；默认关闭）
  const AUTO_CLOSE_KEY = 'msg_auto_close_detail';
  const [autoCloseDetail, setAutoCloseDetail] = useState<boolean>(() => { try { return localStorage.getItem(AUTO_CLOSE_KEY) === '1'; } catch { return false; } });
  const toggleAutoClose = () => setAutoCloseDetail(v => {
    const nv = !v;
    try { localStorage.setItem(AUTO_CLOSE_KEY, nv ? '1' : '0'); } catch {}
    return nv;
  });

  // —— 译文语言偏好（off = 只看原文）
  const LANG_KEY = 'msgTransLang';
  const [lang, setLang] = useState<string>(() => { try { return localStorage.getItem(LANG_KEY) || 'zh'; } catch { return 'zh'; } });
  useEffect(() => { try { localStorage.setItem(LANG_KEY, lang); } catch {} }, [lang]);
  const [trMap, setTrMap] = useState<Record<string, string>>({}); // 预览 snippet -> 译文
  const [trBusy, setTrBusy] = useState(false);
  const [transEngine, setTransEngineState] = useState<string>(_trEngine); // 翻译引擎（与模块级 _trEngine 同步）

  // 列表预览自动翻译
  useEffect(() => {
    if (lang === 'off') return;
    let alive = true;
    const need = rows.map((c: any) => lastMsgSender(c).text || String(c?.snippet || '')).filter(Boolean);
    if (!need.length) return;
    setTrBusy(true);
    translateBatch(need, lang, (orig, trans) => { if (alive) setTrMap(p => ({ ...p, [orig]: trans })); })
      .catch(() => {})
      .finally(() => { if (alive) setTrBusy(false); });
    return () => { alive = false; };
    // transEngine 进依赖：切换引擎后要用新引擎把列表重新翻一遍
  }, [rows, lang, transEngine]);

  // —— 详情翻译：打开对话即自动翻译（默认开启），新收到的消息随轮询自动补译
  const [dTrOn, setDTrOn] = useState(false);
  const [dTr, setDTr] = useState<Record<string, string>>({});
  const [dTrBusy, setDTrBusy] = useState(false);
  const runDetailTr = (conv: ConvRow | null) => {
    if (!conv || lang === 'off') return;
    const texts = parseMessages(conv).map(m => m.text).filter(Boolean);
    if (!texts.length) return;
    setDTrBusy(true);
    translateBatch(texts, lang, (orig, trans) => setDTr(p => (p[orig] && p[orig] !== '' ? p : { ...p, [orig]: trans })))
      .catch(() => {})
      .finally(() => setDTrBusy(false));
  };
  // 打开详情：默认自动开启译文并翻译该会话全部消息
  const openDetail = (c: ConvRow) => {
    setDetail(c); setDTr({}); setReply(''); setSendErr(''); setSendOk('');
    const on = lang !== 'off';
    setDTrOn(on);
    if (on) runDetailTr(c);
  };
  // 切换翻译引擎：已翻好的文本要按新引擎重译 —— 清空现有译文并立刻重跑（引擎已进缓存 key，不会命中旧译文）
  const changeTransEngine = (e: string) => {
    setTrEngine(e);
    setTransEngineState(e);
    setTrMap({});
    setDTr({});
    if (detail && lang !== 'off') runDetailTr(detail);
  };
  // 详情打开期间，列表每 20s 轮询到该会话的新消息 → 无缝并入当前详情（实时跟上对方回复）
  useEffect(() => {
    if (!detail) return;
    const match = rows.find(r => String(r.conversation_id || '') === String(detail.conversation_id) && String(r.page_id || '') === String(detail.page_id));
    if (!match) return;
    // 只允许“确实更新”的云端行替换当前详情：
    // 发送请求还在进行时（详情带 local_* 乐观消息、updated_time 是刚发的本地时间），
    // 云端旧行必须被忽略，否则乐观回显会被每 20s 的轮询立刻刷掉
    const isNewer = String(match.updated_time || '') > String(detail.updated_time || '');
    if (!isNewer) return;
    // 替换前保留云端行尚未收到的本地乐观消息（local_*），避免自己刚发的气泡短暂消失；
    // 若云端行已含同正文的正式消息（发送后回读写入），则本地占位视为已收敛、不再重复合并
    const detailLocals = parseMessages(detail).filter(m => m.id.startsWith('local_'));
    // 用云端行替换前先并入本地“已发送”持久缓存，保证刚发消息在回读/同步完成前重开也可见
    const cacheMerged = (row: ConvRow) => mergeSentCacheIntoRow(row);
    if (detailLocals.length) {
      const matchMsgs = parseMessages(match);
      const absent = detailLocals.filter(lm => !matchMsgs.some(mm => mm.id === lm.id || (mm.text === lm.text && mm.time === lm.time)));
      if (absent.length) {
        let merged: ConvRow = match;
        for (const lm of absent) {
          merged = withLocalMsg(merged, { id: lm.id, message: lm.text, from: { name: lm.from }, created_time: lm.created });
        }
        setDetail(cacheMerged(merged));
        return;
      }
    }
    setDetail(cacheMerged(match));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  // 译文开启时：详情内容变化（轮询并入新消息 / 乐观回显刚发的消息）→ 自动补译新增文本
  useEffect(() => {
    if (!detail || !dTrOn || lang === 'off') return;
    runDetailTr(detail);
  }, [detail, dTrOn, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleDetailTr = () => setDTrOn(v => !v);

  // 详情消息按时间正序渲染（旧在上、新在下，自己刚发送的落到底部而不是顶部）；
  // 内容变化（轮询并入/乐观回显）时自动滚动到底部
  const msgBodyRef = useRef<HTMLDivElement>(null);
  const dMsgs = useMemo(() => {
    if (!detail) return [];
    const arr = parseMessages(detail);
    return [...arr].sort((a, b) =>
      String(a.created || '').localeCompare(String(b.created || '')) ||
      String(a.time || '').localeCompare(String(b.time || ''))
    );
  }, [detail]);
  useEffect(() => {
    if (!detail || !msgBodyRef.current) return;
    const raf = requestAnimationFrame(() => { const el = msgBodyRef.current; if (el) el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(raf);
  }, [detail, dMsgs]);

  // —— 手动「重新拉取」：调本机 9999 sync-inbox 从 Facebook 抓取该配置/该主页最新收件箱并写库，
  //    随后刷新列表与详情（无浏览器运行时会自动冷启动一次，抓取到才回来）
  const [syncing, setSyncing] = useState(false);
  const syncNow = async (targetPageId?: string) => {
    if (syncing) return;
    const pid = profileId || String((rows[0] as any)?.profile_id || '');
    if (!pid) { setNotice('请先选择要拉取的配置'); setTimeout(() => setNotice(''), 5000); return; }
    setSyncing(true); setNotice('');
    try {
      const resp = await fetch(`${LOCAL_API_BASE}/facebook/sync-inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_API_SECRET },
        body: JSON.stringify({ profileId: pid, pageId: targetPageId || pageId || '', pageCap: 10, noBrowser: false, full: true }),
      });
      const j = await resp.json().catch(() => null);
      if (!resp.ok || !j || j.success === false) throw new Error((j && j.message) || `同步失败(HTTP ${resp.status})`);
      let msg = '';
      if (j.skipped === 'no-token') msg = '该配置无 FB token，无法拉取。请先启动浏览器登录该配置一次。';
      else if (j.skipped === 'no-browser-running') msg = '浏览器未运行且未冷启动，未拉到新数据。';
      else msg = (j.conversations != null) ? `已从 Facebook 拉取 ${j.conversations} 个对话，正在刷新…` : '已触发重新拉取，正在刷新…';
      setNotice(msg);
      setTimeout(() => { setNotice(''); reload(); }, 1500);
    } catch (err: any) {
      setNotice(`拉取失败：${err?.message || err}（请确认本机服务 9999 已启动）`);
      setTimeout(() => { setNotice(''); reload(); }, 6000);
    } finally {
      setSyncing(false);
    }
  };

  // —— 回复发送（Graph 方式，默认自动翻译成对方语言）
  const [reply, setReply] = useState('');
  const [target, setTarget] = useState('auto');
  const [autoTranslate, setAutoTranslate] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [sendOk, setSendOk] = useState('');
  // 列表行「乐观覆盖」：发送中的本地预览即时反映到列表，云端正式数据回来后自动移除
  const [overlay, setOverlay] = useState<Record<string, ConvRow>>({});
  // —— 批量勾选 / 分页 / AI 回复队列 ——
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => {
    try { const v = Number(localStorage.getItem('msg_page_size') || 0); return v >= 5 && v <= 500 ? v : 15; } catch { return 15; }
  });
  const changePageSize = (n: number) => {
    setPageSize(n);
    setPageNo(1);
    setSel(new Set());
    try { localStorage.setItem('msg_page_size', String(n)); } catch { /* 忽略隐私模式 */ }
  };
  const [senderFilter, setSenderFilter] = useState<'all' | 'self' | 'peer'>('all');
  const [jumpInput, setJumpInput] = useState('');
  // 批量回复范围：all=勾选全部；unread=仅未读/待回复（最后一条消息是对方发的或有未读数）
  const [bulkScope, setBulkScope] = useState<'all' | 'unread'>('all');
  const [rateSec, setRateSec] = useState(Math.max(1, Math.round(AIQ.getDelayMs() / 1000)));
  const [qTick, setQTick] = useState(0);
  const taskStateByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of AIQ.snapshot()) m[t.key] = t.status;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qTick]);
  // 队列有变化 → 刷新任务状态；同时把队列中的回复实时“乐观”反映到对应行的本地预览：
  // 入队/生成中=占位文案；AI 生成完成=立即显示回复正文；发送完成=正式回读收敛；失败/取消=还原该行预览
  useEffect(() => AIQ.subscribe(() => setQTick(n => n + 1)), []);
  // 已完成任务的通知只提示一次，避免 rows 轮询变化时 effect 重放导致“正在刷新…”无限闪烁
  const queueDoneNotified = useRef<Set<string>>(new Set());
  useEffect(() => {
    const qs = AIQ.snapshot();
    if (!qs.length) return;
    let changed = false;
    let doneCount = 0;
    for (const t of qs) {
      const row = rows.find(r => convRowKey(r) === t.key);
      if (!row) continue;
      const key = ovKey(row);
      if (t.status === 'done' && t.reply) {
        // 该正文已随云端正式行返回 → 移除本地 overlay 让其收敛，否则每轮 rows 变化会重复叠加。
        // 持久缓存已由 aiQueue 模块在发送成功时自行写入，这里不再重复写
        if (!queueDoneNotified.current.has(t.uid)) {
          queueDoneNotified.current.add(t.uid);
          doneCount += 1;
          changed = true;
        }
        const already = parseMessages(row).some(m => m.text === t.reply);
        if (!already) {
          setOverlay(p => ({ ...p, [key]: withLocalMsg(row, makeLocalMsg(t.reply, row)) }));
        } else {
          setOverlay(p => { const n = { ...p }; delete n[key]; return n; });
        }
      } else if (t.status === 'sending' && t.reply) {
        // AI 已完成生成、正在发送：本地预览立即显示回复内容（正文已并入则跳过，防重复）
        const already = parseMessages(row).some(m => m.text === t.reply);
        if (!already) {
          setOverlay(p => ({ ...p, [key]: withLocalMsg(row, makeLocalMsg(t.reply, row)) }));
        }
      } else if (t.status === 'queued' || t.status === 'generating') {
        // 入队即占位：本地预览先显示生成中的提示，不用等 AI 返回
        const cur = overlay[key];
        const curTxt = cur ? lastMsgSender(cur).text : '';
        if (!curTxt.includes('AI 回复生成中')) {
          setOverlay(p => ({ ...p, [key]: withLocalMsg(row, makeLocalMsg('（AI 回复生成中…）', row)) }));
        }
      } else if (t.status === 'error' || t.status === 'cancelled') {
        const cur = overlay[key];
        const curTxt = cur ? lastMsgSender(cur).text : '';
        if (curTxt.includes('AI 回复生成中') || (t.reply && curTxt.includes(t.reply))) {
          setOverlay(p => { const n = { ...p }; delete n[key]; return n; });
        }
      }
    }
    if (changed) {
      setNotice(`AI 回复队列：${doneCount} 条已发送完成，正在刷新…`);
      const timer = setTimeout(() => { setNotice(''); reload(); }, 900);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qTick, rows]);

  // —— 持续监听状态（模块级 aiWatch） ——
  const [wTick, setWTick] = useState(0);
  useEffect(() => watchSubscribe(() => setWTick(n => n + 1)), []);
  const watchingKeys = useMemo(() => new Set(watchSnapshot().filter(e => e.enabled).map(e => e.key)), [wTick]);
  // 值守运行状态摘要：最近一次检查时间 + 当前报错原因（让“有没有真的去拉取/为什么没拉到”可见）
  const watchStatus = useMemo(() => {
    const list = watchSnapshot().filter(e => e.enabled);
    const errs = [...new Set(list.map(e => e.lastError).filter(Boolean))].slice(0, 2);
    const lastTs = list.reduce((m, e) => Math.max(m, Number(e.lastCheckTs) || 0), 0);
    const age = lastTs ? Math.round((Date.now() - lastTs) / 1000) : -1;
    const lastTxt = list.length && list.some(e => (e.lastPeerTs || 0) > 0) ? '已建基线，等待对方新消息' : '尚未完成首次基线检查';
    return { errs, lastTxt, age };
  }, [wTick]);
  // 值守定时/冷却的本地编辑态：监听页面内改动，也从「AI 回复队列」页改动后同步
  const [wpoll, setWpoll] = useState(watchGetPollSec());
  const [wcoold, setWcoold] = useState(watchGetCooldownSec());
  const [wchecking, setWchecking] = useState(false);
  // 空闲自动跟进（对方长时间未回复 → 主动 AI 跟进）设置
  const [wfollowOn, setWfollowOn] = useState(watchGetFollowOn());
  const [wfollowMin, setWfollowMin] = useState(Math.round(watchGetFollowMin() / 60));
  const [wfollowMax, setWfollowMax] = useState(watchGetFollowMax());
  useEffect(() => {
    setWpoll(watchGetPollSec()); setWcoold(watchGetCooldownSec());
    setWfollowOn(watchGetFollowOn()); setWfollowMin(Math.round(watchGetFollowMin() / 60)); setWfollowMax(watchGetFollowMax());
  }, [wTick]);

  // —— 主页级“全部对话值守”（本配置当前列表出现的所有主页 → 主页所有对话自动接管） ——
  // pageSet: rows 里出现的 page_id -> page_name（对话可能来自该配置的多个主页）
  const pageSet = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      const pid = String((r as any).page_id || '');
      if (pid) m.set(pid, String((r as any).page_name || ''));
    }
    return m;
  }, [rows]);
  // 当前配置下已开启的主页级值守
  const watchingPages = useMemo(
    () => watchSnapPages().filter(p => p.enabled && String(p.profileId) === String(profileId)),
    [wTick, profileId],
  );
  // 仅统计“手动勾选”的单独对话（主页值守自动派生的不算）
  const manualWatchCount = useMemo(
    () => watchSnapshot().filter(e => e.enabled && !e.autoOfPage).length,
    [wTick],
  );
  const allPagesOn = pageSet.size > 0 && [...pageSet.keys()].every(pid => watchIsPageOn(profileId, pid));
  const togglePageWatch = async () => {
    if (!profileId) {
      setNotice('请先在上方选择要值守的配置'); setTimeout(() => setNotice(''), 3000); return;
    }
    if (!pageSet.size) {
      setNotice('当前配置尚无对话数据，请先点「拉取更新」同步主页收件箱'); setTimeout(() => setNotice(''), 4000); return;
    }
    const turnOn = !allPagesOn;
    if (turnOn) {
      for (const [pid, pname] of pageSet) watchAddPage(profileId, pid, pname);
    } else {
      watchingPages.forEach(p => watchRemovePage(p.profileId, p.pageId));
    }
    setWTick(v => v + 1);
    if (!turnOn) {
      setNotice(`已关闭本配置 ${watchingPages.length || pageSet.size} 个主页的全部对话值守（单独勾选的对话监听不受影响，可随时重新开启）`);
      setTimeout(() => setNotice(''), 4000);
      return;
    }
    setNotice(`已开启 ${pageSet.size} 个主页的全部对话值守：正在首轮拉取，未回复的对话将整段合并、按 AI 队列发送间隔逐个自动回复（新对话自动纳入）…`);
    setTimeout(() => setNotice(''), 5000);
    try {
      const n = await watchRunNow();
      reload();
      setWTick(v => v + 1);
      setNotice(n
        ? `全部对话值守首轮完成：已将 ${n} 个未回复对话加入 AI 队列，正在按发送间隔逐条 AI 回复（可在「AI 回复队列」页查看/取消）`
        : '全部对话值守首轮完成：暂无未回复对话，之后每轮自动拉取并回复新消息');
      setTimeout(() => setNotice(''), 7000);
    } catch {
      setNotice('值守首轮拉取失败（本机 9999 未启动？），可在「AI 回复队列」页查看详情');
      setTimeout(() => setNotice(''), 5000);
    }
  };

  // 对方最近一条入站文本（用于“自动对方语言”）
  const lastIncoming = useMemo(() => {
    if (!detail) return '';
    const msgs = parseMessages(detail).filter(m => m.from && m.from !== detail.page_name && !String(m.from).includes('|'));
    const last = msgs[msgs.length - 1];
    return (last && last.text) || detail.snippet || '';
  }, [detail]);

  // 半实时轮询到新消息 → 横幅 + 系统通知
  useEffect(() => {
    const onNew = (e: Event) => {
      const d = (e as CustomEvent).detail;
      const snip = d && d.newest && (d.newest.snippet || '');
      setNotice(`检测到新消息${d && d.total ? `（当前共 ${d.total} 个对话）` : ''}，列表已自动刷新`);
      setTimeout(() => setNotice(''), 8000);
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('收到新主页消息', { body: snip ? String(snip).slice(0, 80) : '有新对话消息' });
        }
      } catch {}
    };
    window.addEventListener('messages-new', onNew as any);
    return () => window.removeEventListener('messages-new', onNew as any);
  }, []);

  // 云端正式数据回来后，自动移除列表乐观 overlay（该行 updated_time 已追平/超过本地乐观版本）
  useEffect(() => {
    setOverlay(prev => {
      const keys = Object.keys(prev);
      if (!keys.length) return prev;
      const next = { ...prev };
      let changed = false;
      for (const k of keys) {
        const r = rows.find(rr => ovKey(rr) === k);
        if (r && String(r.updated_time || '') >= String(prev[k].updated_time || '')) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSend = async () => {
    const raw = reply.trim();
    if (!raw || sending || !detail) return;
    const conv = detail;
    const key = ovKey(conv);
    setSending(true); setSendErr(''); setSendOk('');
    // 1) 先准备发送正文（语言检测/翻译，通常很快；失败也不阻塞发送）
    let langTarget = target;
    let out = raw;
    let translated = false;
    try {
      if (langTarget === 'auto') {
        const detected = await detectLanguage(lastIncoming || conv.snippet || '');
        langTarget = detected || 'zh';
      }
      if (autoTranslate) {
        const t = await translateText(raw, langTarget);
        if (t) { out = t; translated = true; }
      }
    } catch { /* 忽略：按原样发送 */ }
    // 2) 关键：正式发送前立刻把消息插入详情底部 + 覆盖列表该行预览（本地先显示，后台再发）
    const localMsg = makeLocalMsg(out, conv);
    const optimistic = withLocalMsg(conv, localMsg);
    setDetail(optimistic);
    setOverlay(p => ({ ...p, [key]: optimistic }));
    setReply('');
    try {
      const peer = getPeer(conv);
      await sendFbMessage({
        profileId: String(conv.profile_id || profileId || ''),
        pageId: String(conv.page_id || ''),
        conversationId: String(conv.conversation_id || ''),
        message: out,
        pageName: String(conv.page_name || ''),
        ...(peer.id ? { userId: peer.id } : {}),
      });
      // 3) 发送成功：若开启「自动关闭对话详情」则关闭，顶部横幅提示；列表预览因 overlay 已即时显示刚发消息
      if (autoCloseDetail) setDetail(null);
      cacheSentMsg(conv, localMsg);
      const okMsg = `已发送${translated ? `（自动译为${TRANS_LANGS[langTarget] || langTarget}）` : ''}`;
      setNotice(okMsg);
      setTimeout(() => { setNotice(''); reload(); }, 1200);
    } catch (err: any) {
      // 4) 发送失败 / 超时自动放弃：撤下刚插入的乐观气泡与列表预览，避免“假发送”误导
      setDetail(prev => (prev ? withoutMsg(prev, localMsg.id) : prev));
      setOverlay(p => {
        const next = { ...p };
        delete next[key];
        return next;
      });
      setSendErr(err?.message || '发送失败，请检查本机浏览器服务(9999)是否已启动');
    } finally {
      setSending(false);
    }
  };

  // AI 生成回复填充输入框（不自动发送，由用户确认后手动点发送）
  const [aiGen, setAiGen] = useState(false);
  const genReplyFill = async () => {
    if (!detail || aiGen) return;
    setAiGen(true); setSendErr(''); setSendOk('');
    try {
      const mj = typeof detail.messages_json === 'string' ? detail.messages_json : JSON.stringify(detail.messages_json || []);
      const peer = getPeer(detail);
      const text = await AIQ.generateReplyOnly({
        key: `${detail.profile_id}::${detail.page_id}::${detail.conversation_id}`,
        profileId: String(detail.profile_id || profileId || ''),
        pageId: String(detail.page_id || ''),
        conversationId: String(detail.conversation_id || ''),
        pageName: String(detail.page_name || ''),
        ...(peer.id ? { userId: peer.id } : {}),
        messages_json: mj,
      });
      if (!text) throw new Error('AI 未返回内容，请检查「提示词设置」或稍后重试');
      setReply(text);
      setNotice('AI 已生成回复，请确认后手动发送');
      setTimeout(() => setNotice(''), 4000);
    } catch (err: any) {
      setSendErr(`AI 生成失败：${err?.message || err}`);
    } finally {
      setAiGen(false);
    }
  };

  // 发送图片 / 视频：本地先显示占位气泡 → 后端上传并发送 → 成功关弹层并刷新
  const sendMediaFile = async (kind: 'image' | 'video', file: File) => {
    if (!file || sending || !detail) return;
    if (file.size > 9 * 1024 * 1024) {
      setSendErr('文件过大（单个 ≤ 9MB），请压缩后再发送');
      return;
    }
    const conv = detail;
    const key = ovKey(conv);
    setSending(true); setSendErr(''); setSendOk('');
    // 转 base64 dataURL 交由本机服务上传到 Facebook
    let b64 = '';
    try {
      b64 = await new Promise<string>((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result || ''));
        rd.onerror = () => reject(new Error('读取文件失败'));
        rd.readAsDataURL(file);
      });
    } catch (e: any) {
      setSending(false);
      setSendErr(e?.message || '读取文件失败');
      return;
    }
    const tag = kind === 'video' ? '[视频]' : '[图片]';
    const localMsg = makeLocalMsg(tag, conv);
    const optimistic = withLocalMsg(conv, localMsg);
    setDetail(optimistic);
    setOverlay(p => ({ ...p, [key]: optimistic }));
    try {
      const peer = getPeer(conv);
      await sendFbMessage({
        profileId: String(conv.profile_id || profileId || ''),
        pageId: String(conv.page_id || ''),
        conversationId: String(conv.conversation_id || ''),
        message: '',
        pageName: String(conv.page_name || ''),
        ...(peer.id ? { userId: peer.id } : {}),
        attachment: { base64: b64, mimeType: file.type || (kind === 'video' ? 'video/mp4' : 'image/jpeg'), kind },
      });
      if (autoCloseDetail) setDetail(null);
      cacheSentMsg(conv, localMsg);
      const okMsg = kind === 'video' ? '视频已发送' : '图片已发送';
      setNotice(okMsg);
      setTimeout(() => { setNotice(''); reload(); }, 1200);
    } catch (err: any) {
      setDetail(prev => (prev ? withoutMsg(prev, localMsg.id) : prev));
      setOverlay(p => {
        const n = { ...p };
        delete n[key];
        return n;
      });
      setSendErr(err?.message || '发送失败，请检查本机浏览器服务(9999)是否已启动');
    } finally {
      setSending(false);
    }
  };

  // 单条「AI 回复」→ 加入 AI 回复队列（可在导航「AI 回复队列」实时查看/取消）
  const aiReply = (c: ConvRow) => {
    if (AIQ.enqueue([toTaskInput(c)]).length === 0) {
      setNotice('该对话已在 AI 回复队列中，请勿重复添加');
      setTimeout(() => setNotice(''), 3000);
      return;
    }
    setNotice('已加入 AI 回复队列（可在「AI 回复队列」页查看/取消）');
    setTimeout(() => setNotice(''), 3000);
  };

  // 批量 AI 回复：将当前勾选对话整体入队（可选“仅未读/待回复”范围），按设定间隔逐条生成与发送
  const batchAIReply = () => {
    const targets = pageRows.filter(r => sel.has(convRowKey(r)));
    if (!targets.length) {
      setNotice('请先勾选要 AI 回复的对话');
      setTimeout(() => setNotice(''), 3000);
      return;
    }
    let effective = targets;
    let skipped = 0;
    if (bulkScope === 'unread') {
      effective = targets.filter(r => isUnrepliedConv(r));
      skipped = targets.length - effective.length;
    }
    if (!effective.length) {
      setNotice('勾选的对话都是已回复/最后一条为我方消息，无需 AI 回复');
      setTimeout(() => setNotice(''), 3500);
      return;
    }
    AIQ.setDelayMs(rateSec * 1000);
    const added = AIQ.enqueue(effective.map(r => toTaskInput(r)));
    if (added.length) {
      setNotice(`已将 ${added.length} 个待回复对话加入 AI 回复队列（间隔 ${rateSec} 秒${skipped ? `，跳过 ${skipped} 个已回复` : ''}，可在「AI 回复队列」页取消）`);
      setTimeout(() => { setNotice(''); setSel(new Set()); }, 3000);
    } else {
      setNotice('所选对话都已存在于队列中，无需重复添加');
      setTimeout(() => setNotice(''), 3000);
    }
  };

  // 全选当前页
  const toggleSelectPage = () => {
    const keys = pageRows.map(r => convRowKey(r));
    const allOn = keys.length > 0 && keys.every(k => sel.has(k));
    setSel(prev => {
      const next = new Set(prev);
      keys.forEach(k => { if (allOn) next.delete(k); else next.add(k); });
      return next;
    });
  };

  // 批量删除选中对话的云端存档（仅删数据库记录，Facebook 真实对话不受影响，可重新拉取恢复）
  const [deletingMsgs, setDeletingMsgs] = useState(false);
  const batchDeleteMsgs = async () => {
    const targets = pageRows.filter(r => sel.has(convRowKey(r)));
    if (!targets.length) return;
    if (!window.confirm(`确定从系统删除选中的 ${targets.length} 个对话存档？不会删除 Facebook 上的真实对话，删除后点“拉取更新”可重新同步恢复。`)) return;
    setDeletingMsgs(true);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const resp = await fetch(`${getSbase()}/api/messages/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
        body: JSON.stringify({ ids: targets.map(r => String((r as any).id)).filter(Boolean) }),
      });
      const j = await resp.json();
      if (j && j.success) {
        setSel(new Set());
        setNotice(`已删除 ${j.deletedMessages ?? targets.length} 个对话存档`);
        setTimeout(() => setNotice(''), 3000);
        reload();
      } else {
        alert((j && (j.message || j.error)) || '删除失败，请重试');
      }
    } catch (e: any) {
      alert('请求失败：' + (e?.message || String(e)));
    } finally {
      setDeletingMsgs(false);
    }
  };

  // 先并入列表乐观 overlay（发送中的本地预览即时反映到列表），云端正式数据回来后由 reconcile 清理；
  // 再并入本地“已发送”持久缓存：即使云端回写尚未完成，重开列表/详情仍能看到刚发的消息
  const mergedRows = useMemo(() => rows.map(r => mergeSentCacheIntoRow(overlay[ovKey(r)] || r)), [rows, overlay]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mergedRows;
    return mergedRows.filter((c: ConvRow) =>
      [c.page_name, c.snippet, c.page_id, lastMsgSender(c).text].some(v => v && String(v).toLowerCase().includes(q))
    );
  }, [mergedRows, search]);

  // 对话列表按最近更新时间倒序（最新对话置顶）
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => String(b.updated_time || '').localeCompare(String(a.updated_time || '')));
  }, [filtered]);

  // —— 按“最后一条消息是我/对方”筛选 ——
  const senderFiltered = useMemo(() => {
    if (senderFilter === 'all') return sorted;
    return sorted.filter((c: ConvRow) => lastMsgSender(c).tag === senderFilter);
  }, [sorted, senderFilter]);

  // —— 分页（当前页数据） ——
  const totalPages = Math.max(1, Math.ceil(senderFiltered.length / pageSize));
  const curPage = Math.min(pageNo, totalPages);
  const pageRows = useMemo(() => {
    const p = Math.min(pageNo, totalPages);
    return senderFiltered.slice((p - 1) * pageSize, p * pageSize);
  }, [senderFiltered, pageNo, totalPages, pageSize]);
  useEffect(() => { if (pageNo > totalPages) setPageNo(totalPages); }, [pageNo, totalPages]);
  const goPage = (p: number) => { const v = Math.max(1, Math.min(totalPages, Math.floor(p) || 1)); setPageNo(v); setSel(new Set()); };
  // 「跳至第 N 页」应用（回车/点按钮共用）：非法输入不跳转、不清空，方便直接改
  const applyJump = () => {
    const n = Math.floor(Number(jumpInput));
    if (!Number.isFinite(n) || n < 1) return;
    goPage(n);
    setJumpInput('');
  };
  // 搜索框回车：立即定位到结果的第一页并失焦（列表本身是实时过滤）
  const applySearch = () => { setPageNo(1); setSel(new Set()); };

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-emerald-400" /> 消息对话
        </h2>
        <span className="px-2 py-0.5 text-xs rounded-full bg-slate-800 text-slate-400">
          {rows.length} 个{senderFiltered.length !== rows.length ? ` · 当前 ${senderFiltered.length}` : ''}
        </span>
        <label className="flex items-center gap-1 text-xs text-slate-400 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700" title="按最后一条消息的归属筛选">
          预览
          <select value={senderFilter} onChange={(e) => { setSenderFilter(e.target.value as any); setPageNo(1); setSel(new Set()); }}
            className="bg-transparent text-slate-200 text-xs focus:outline-none">
            <option value="all">全部</option>
            <option value="self">我发送</option>
            <option value="peer">对方发送</option>
          </select>
        </label>
        <div className="flex-1" />
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPageNo(1); setSel(new Set()); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applySearch(); (e.currentTarget as HTMLInputElement).blur(); } }}
            placeholder="搜索对话…（回车定位）"
            className="bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-400 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700">
          <Languages className="w-3.5 h-3.5 text-indigo-400" />
          <select value={lang} onChange={(e) => { setLang(e.target.value); if (detail && dTrOn) setDTr({}); }} title="消息译文语言（对方消息翻译成的语言）"
            className="bg-transparent text-slate-200 text-xs focus:outline-none">
            <option value="off">原文</option>
            {Object.entries(TRANS_LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {filter.pageName && (
          <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-xs">
            主页：{filter.pageName}
            <button onClick={() => setFilter(f => ({ ...f, pageId: '', pageName: '' }))} title="清除主页筛选" className="p-0.5 hover:text-white"><X className="w-3.5 h-3.5" /></button>
          </span>
        )}
        <ProfileFilter value={profileId} onChange={(v) => setFilter(f => ({ profileId: v, pageId: '', pageName: '' }))} />
        <button onClick={() => togglePageWatch()} disabled={!profileId || !pageSet.size}
          title="对当前配置在列表中出现的全部主页开启“全部对话值守”：每轮自动拉取这些主页的收件箱，发现未回复的对话整段合并成一条 AI 回复、按 AI 队列发送间隔逐个发送；之后对方发来的新消息也自动回复，新对话自动纳入。开启后无需逐个勾选对话。"
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border disabled:opacity-50 disabled:cursor-not-allowed ${(pageSet.size > 0 && (watchingPages.length > 0 || allPagesOn)) ? 'border-amber-500/60 bg-amber-600/20 text-amber-300 hover:bg-amber-600/30' : 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700'}`}>
          <BellRing className={`w-3.5 h-3.5 ${allPagesOn ? 'animate-pulse' : ''}`} />
          {allPagesOn ? `关闭全部对话值守（${watchingPages.length} 页）` : '开启全部对话值守'}
        </button>
        <button onClick={() => syncNow()} disabled={syncing || loading} title="从 Facebook 重新拉取该配置的最新收件箱对话并刷新列表（无浏览器运行时会自动打开一次）"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? '拉取中…' : '拉取更新'}
        </button>
      </div>

      {sel.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg bg-indigo-600/10 border border-indigo-500/40 text-sm text-indigo-200">
          <span>已选 <b className="text-white">{sel.size}</b> 个对话</span>
          <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none" title="开启后只对“最后一条是对方发的 / 带未读标记”的勾选对话执行，已回复过的对话自动跳过">
            <input type="checkbox"
              checked={bulkScope === 'unread'}
              onChange={(e) => setBulkScope(e.target.checked ? 'unread' : 'all')}
              className="accent-emerald-500 cursor-pointer" />
            仅未读/待回复
          </label>
          {bulkScope === 'unread' && (() => {
            const n = pageRows.filter(r => sel.has(convRowKey(r)) && isUnrepliedConv(r)).length;
            return <span className="text-[11px] text-slate-500">勾选 {sel.size} 个，其中待回复 {n} 个（批量 AI 回复/批量持续监听均只处理待回复项）</span>;
          })()}
          <span className="flex items-center gap-1.5 text-xs text-slate-300">
            发送间隔
            <input type="number" min={1} max={600} value={rateSec}
              onChange={(e) => setRateSec(Math.max(1, Number(e.target.value) || 1))}
              className="w-16 bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500" />
            秒
          </span>
          <button onClick={batchAIReply}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium">
            <Sparkles className="w-3.5 h-3.5" /> 批量 AI 回复
          </button>
          <button onClick={() => {
            const all = pageRows.filter(r => sel.has(convRowKey(r)));
            const targets = bulkScope === 'unread' ? all.filter(r => isUnrepliedConv(r)) : all;
            const skipped = all.length - targets.length;
            if (!targets.length) {
              setNotice('勾选的对话都是已回复/最后一条为我方消息，未开启监听（取消“仅未读/待回复”后可全选）');
              setTimeout(() => setNotice(''), 4000);
              return;
            }
            const added = watchAddMany(targets.map(r => toWatchInput(r)));
            setSel(new Set());
            setNotice(added.length
              ? `已开启 ${added.length} 个待回复对话的持续监听${skipped ? `，跳过 ${skipped} 个已回复` : ''}：检测到对方新消息将 AI 自动回复（可在「AI 回复队列」页查看/取消）`
              : '所选对话都已在监听中');
            setTimeout(() => setNotice(''), 4500);
          }}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-xs font-medium">
            <BellRing className="w-3.5 h-3.5" /> 批量持续监听
          </button>
          <button onClick={() => {
            const keys = pageRows.filter(r => sel.has(convRowKey(r))).map(r => convRowKey(r));
            watchRemoveKeys(keys);
            setSel(new Set());
            setNotice(`已关闭 ${keys.length} 个对话的持续监听`);
            setTimeout(() => setNotice(''), 3000);
          }}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border border-slate-600 text-slate-300 text-xs hover:bg-slate-800">
            关闭选中监听
          </button>
          <button onClick={batchDeleteMsgs} disabled={deletingMsgs} title="仅删除系统内保存的对话存档，不影响 Facebook 真实对话"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white text-xs font-medium disabled:opacity-50">
            <Trash2 className="w-3.5 h-3.5" /> {deletingMsgs ? '删除中…' : '批量删除存档'}
          </button>
          <button onClick={() => setSel(new Set())}
            className="px-2 py-1 rounded-lg border border-slate-600 text-slate-300 text-xs hover:bg-slate-800">清除选择</button>
        </div>
      )}

      {(watchingKeys.size > 0 || watchingPages.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
          <span className="inline-flex flex-wrap items-center gap-1.5 font-medium">
            <BellRing className="h-3.5 w-3.5 text-amber-400 animate-pulse" />
            自动值守中：
            {watchingPages.length > 0 && (
              <span><b className="text-amber-100">{watchingPages.length}</b> 个主页（全部对话）</span>
            )}
            {watchingPages.length > 0 && manualWatchCount > 0 && <span>·</span>}
            {manualWatchCount > 0 && (
              <span><b className="text-amber-100">{manualWatchCount}</b> 个单独对话</span>
            )}
            <span className="font-normal text-amber-200/70">（每轮自动拉取 → 未回复对话整段合并入队 → 按 AI 队列发送间隔逐个回复）</span>
          </span>
          <label className="flex items-center gap-1 text-amber-200/80">检查间隔
            <select value={wpoll} onChange={(e) => setWpoll(Number(e.target.value))}
              onBlur={() => watchSetPollSec(wpoll)}
              className="bg-slate-800 border border-amber-700/50 rounded px-1 py-0.5 text-amber-100 focus:outline-none">
              {[15, 20, 30, 60, 120, 300].map((s) => <option key={s} value={s}>{s}s</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-amber-200/80">回复冷却
            <select value={wcoold} onChange={(e) => setWcoold(Number(e.target.value))}
              onBlur={() => watchSetCooldownSec(wcoold)}
              className="bg-slate-800 border border-amber-700/50 rounded px-1 py-0.5 text-amber-100 focus:outline-none">
              {[60, 120, 300, 600, 1800, 3600].map((s) => <option key={s} value={s}>{s}s</option>)}
            </select>
          </label>
          <button onClick={async () => {
            if (wchecking) return;
            setWchecking(true);
            setNotice('值守检查中：正在对各监听主页执行拉取同步…');
            setTimeout(() => setNotice(''), 2000);
            try {
              const n = await watchRunNow();
              reload(); // 拉取写库后立即刷新当前列表，让云端新数据马上可见
              setNotice(n ? `值守检查完成：已自动回复 ${n} 条，列表已刷新` : '值守检查完成：无新消息需回复，列表已刷新');
              setTimeout(() => setNotice(''), 4000);
            } catch {
              setNotice('值守检查失败（本机 9999 未启动？）');
              setTimeout(() => setNotice(''), 4000);
            } finally { setWchecking(false); setWTick(v => v + 1); }
          }} disabled={wchecking}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-500/60 text-amber-200 hover:bg-amber-500/15 disabled:opacity-50"
            title="现在立刻对所有监听主页执行一轮：拉取同步 → 比对未回复/对方新消息 → 入 AI 队列按发送间隔回复，完成后刷新列表">
            {wchecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} 立即检查
          </button>
          {watchingPages.length > 0 && (
            <button onClick={() => {
              watchingPages.forEach(p => watchRemovePage(p.profileId, p.pageId));
              setWTick(v => v + 1);
              setNotice('已关闭本配置的全部对话值守（单独勾选的对话监听不受影响）');
              setTimeout(() => setNotice(''), 4000);
            }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-500/60 text-amber-200 hover:bg-amber-500/15"
              title="关闭本配置下所有主页的“全部对话值守”并移除自动纳入的对话监听（人工单独勾选的监听保留）">
              <X className="w-3.5 h-3.5" /> 关闭全部对话值守
            </button>
          )}
          <span className="w-full text-[11px] leading-4 text-amber-200/60">
            最近检查：{watchStatus.age < 0 ? '尚未执行' : watchStatus.age + ' 秒前'}｜{watchStatus.lastTxt}
            {watchStatus.errs.length > 0 && (
              <span className="block text-rose-300/90">上次检查报错：{watchStatus.errs.join('；')}（详见「AI 回复队列」页每行状态）</span>
            )}
          </span>
          <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-amber-500/20 pt-1.5">
            <label className="flex cursor-pointer select-none items-center gap-1.5" title="我方已回复过、但对方超过设定时间仍未回复时，主动 AI 发一条礼貌跟进。默认关闭——对真人客户过高频率主动消息容易被举报/封号">
              <input type="checkbox" checked={wfollowOn}
                onChange={(e) => { const v = e.target.checked; setWfollowOn(v); watchSetFollowOn(v); setWTick(t => t + 1); }}
                className="accent-amber-500 cursor-pointer" />
              对方未回复时主动 AI 跟进
            </label>
            <label className="flex items-center gap-1 text-amber-200/80" title="对方超过该时长仍未回复我方最后一条消息时，自动跟进">
              超过
              <select value={wfollowMin} disabled={!wfollowOn}
                onChange={(e) => setWfollowMin(Number(e.target.value))}
                onBlur={() => watchSetFollowMin(wfollowMin)}
                className="bg-slate-800 border border-amber-700/50 rounded px-1 py-0.5 text-amber-100 focus:outline-none disabled:opacity-40">
                {[10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} 分钟</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1 text-amber-200/80" title="同一对话每天最多主动跟进的条数，防骚扰">
              每天至多
              <select value={wfollowMax} disabled={!wfollowOn}
                onChange={(e) => setWfollowMax(Number(e.target.value))}
                onBlur={() => watchSetFollowMax(wfollowMax)}
                className="bg-slate-800 border border-amber-700/50 rounded px-1 py-0.5 text-amber-100 focus:outline-none disabled:opacity-40">
                {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n} 条</option>)}
              </select>
            </label>
            <span className="text-[11px] text-amber-200/50">跟进仍走 AI 队列（按发送间隔节流），仅对我方已回复过的对话触发，且首条跟进要等对方消息超过该时长后才发。</span>
          </span>
        </div>
      )}

      {notice && (
        <div className="fixed bottom-5 right-5 z-[1000] flex max-w-sm items-start gap-2 rounded-xl border border-emerald-500/50 bg-slate-900/95 px-4 py-3 text-sm text-emerald-300 shadow-2xl shadow-black/40 backdrop-blur animate-[fadeIn_.2s_ease-out]">
          <BellRing className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{notice}</span>
          <button onClick={() => setNotice('')} className="ml-auto shrink-0 text-emerald-400 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
      )}

      {error && <div className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-3">{error}</div>}

      {!loading && filtered.length === 0 && (
        <EmptyState text={search ? '无匹配对话' : '暂无收件箱对话'} />
      )}
      {!loading && filtered.length > 0 && senderFiltered.length === 0 && (
        <EmptyState text={senderFilter === 'self' ? '当前没有“我发送”的对话预览（切到“全部”或换页查看）' : '当前没有“对方发送”的对话预览（切到“全部”或换页查看）'} />
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-800">
              <th className="px-4 py-2.5 w-8">
                <input type="checkbox"
                  checked={pageRows.length > 0 && pageRows.every(r => sel.has(convRowKey(r)))}
                  onChange={toggleSelectPage} title="全选当前页"
                  className="accent-emerald-500 cursor-pointer" />
              </th>
              <th className="px-4 py-2.5">最近消息</th>
              <th className="px-4 py-2.5">配置</th>
              <th className="px-4 py-2.5">主页</th>
              <th className="px-4 py-2.5">对话对象</th>
              <th className="px-4 py-2.5">消息预览{lang !== 'off' && !trBusy ? '（已译）' : ''}</th>
              <th className="px-4 py-2.5">条数</th>
              <th className="px-4 py-2.5">未读</th>
              <th className="px-4 py-2.5">操作</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((c: ConvRow, idx: number) => {
              const peers = getParticipantNames(c);
              const sender = lastMsgSender(c);
              const orig = sender.text || (c.snippet ? String(c.snippet) : '');
              const tr = lang !== 'off' ? (trMap[orig] || '') : '';
              const shown = tr && tr !== orig ? tr : (orig ? fmtName(orig) : '(无文字消息)');
              const qk = convRowKey(c);
              const qst = taskStateByKey[qk] || '';
              const qBusy = qst === 'queued' || qst === 'generating' || qst === 'sending';
              return (
                <tr key={c.conversation_id || idx} onClick={() => openDetail(c)} className="border-b border-slate-800/60 hover:bg-slate-800/50 cursor-pointer">
                  <td className="px-4 py-2.5 w-8" onClick={e => e.stopPropagation()}>
                    <input type="checkbox"
                      checked={sel.has(qk)}
                      onChange={() => setSel(prev => { const n = new Set(prev); if (n.has(qk)) n.delete(qk); else n.add(qk); return n; })}
                      title="勾选（勾选后可批量 AI 回复）"
                      className="accent-emerald-500 cursor-pointer" />
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{fmtTime(c.updated_time) || '-'}</td>
                  <td className="px-4 py-2.5 text-slate-300">{pNameMap.get(String(c.profile_id)) || `配置 ${c.profile_id}`}</td>
                  <td className="px-4 py-2.5 text-slate-200 max-w-[140px] truncate" title={c.page_name}>{c.page_name || '-'}</td>
                  <td className="px-4 py-2.5 text-slate-300 max-w-[160px] truncate" title={peers.join(', ')}>
                    <User className="inline w-3.5 h-3.5 mr-1 text-slate-500" />
                    {peers.length ? peers.join(', ') : (c.conversation_id || '').slice(0, 12)}
                  </td>
                  <td className="px-4 py-2.5 max-w-[320px]">
                    <div className="flex items-center gap-1.5">
                      {sender.tag === 'self' && <span className="shrink-0 text-[11px] font-medium text-slate-300 mr-0.5">我：</span>}
                      {sender.tag === 'peer' && (
                        <span className="shrink-0 text-[11px] font-medium text-emerald-400/90 mr-0.5" title={sender.from}>{String(sender.from).slice(0, 12) || '对方'}：</span>
                      )}
                      <div className="truncate" title={tr && tr !== orig ? `原文：${orig}` : (orig || '')}>
                        {shown}
                      </div>
                    </div>
                    {tr && tr !== orig && orig && (
                      <div className="text-[10px] text-indigo-400/70 truncate" title={orig}>{orig}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">{c.message_count ?? '-'}</td>
                  <td className="px-4 py-2.5">
                    {Number(c.unread_count || 0) > 0 ? (
                      <span className="px-1.5 py-0.5 text-xs rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">{c.unread_count}</span>
                    ) : (
                      <span className="text-slate-600">0</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {watchingKeys.has(qk) && (
                        <span title="值守中：拉取到未回复/对方新消息将整段合并 AI 自动回复"
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-600/15 border border-amber-500/40 text-amber-300 text-[11px]">
                          <BellRing className="w-3 h-3 animate-pulse" />
                        </span>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); aiReply(c); }}
                        disabled={qBusy}
                        title="AI 自动回复：抓取该对话记录，按「提示词设置」生成一条回复并加入发送队列"
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 hover:bg-slate-800/60 disabled:opacity-60 disabled:cursor-wait"
                      >
                        {qBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                        {qBusy ? (qst === 'queued' ? '队列中…' : qst === 'generating' ? '生成中…' : '发送中…') : 'AI 回复'}
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); syncNow(String(c.page_id || '')); }}
                        disabled={syncing}
                        title="仅从 Facebook 重新拉取该对话所属主页的最新消息并刷新"
                        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(senderFiltered.length > 0 || loading === false) && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
          {totalPages > 1 && (
            <button onClick={() => goPage(curPage - 1)} disabled={curPage <= 1}
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed">
              上一页
            </button>
          )}
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const start = Math.max(1, Math.min(curPage - 3, totalPages - Math.min(totalPages, 7) + 1));
                const n = start + i;
                return (
                  <button key={n} onClick={() => goPage(n)}
                    className={`w-8 h-8 rounded-lg text-xs border ${n === curPage ? 'bg-emerald-600 border-emerald-500 text-white' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}>
                    {n}
                  </button>
                );
              })}
            </div>
          )}
          {totalPages > 1 && (
            <button onClick={() => goPage(curPage + 1)} disabled={curPage >= totalPages}
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed">
              下一页
            </button>
          )}
          <span className="text-xs text-slate-500 mx-1">第 {curPage} / {totalPages} 页 · {senderFiltered.length} 条</span>
          <label className="flex items-center gap-1 text-xs text-slate-400 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700" title="每页显示的对话条数（选择后自动记住）">
            每页
            <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}
              className="bg-transparent text-slate-200 text-xs focus:outline-none">
              {[10, 15, 20, 30, 50, 100, 200, 500].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            条
          </label>
          {totalPages > 1 && (
            <span className="flex items-center gap-1 text-xs text-slate-400">
              跳至
              <input type="number" min={1} max={totalPages} value={jumpInput} inputMode="numeric"
                onChange={(e) => setJumpInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyJump(); (e.currentTarget as HTMLInputElement).blur(); } }}
                title="输入页码后按回车或点「跳转」"
                className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500" />
              页
              <button onClick={applyJump}
                className="px-2 py-1 rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 text-xs">
                跳转
              </button>
            </span>
          )}
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
              <div className="text-slate-200 font-medium flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-emerald-400" /> 对话详情
                <span className="text-xs text-slate-500">{detail.page_name} · #{detail.conversation_id}</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={toggleAutoClose}
                  className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border ${autoCloseDetail ? 'border-emerald-500/50 bg-emerald-600/20 text-emerald-300' : 'border-slate-600 bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                  title="开启后，发送消息成功会自动关闭对话详情；关闭则发送成功后仍停留在详情">
                  <FolderOpen className={`w-3.5 h-3.5 ${autoCloseDetail ? '' : 'opacity-60'}`} /> 自动关闭 {autoCloseDetail ? '开' : '关'}
                </button>
                {lang !== 'off' && (
                  <button onClick={toggleDetailTr} disabled={dTrBusy}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-indigo-500/50 bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 disabled:opacity-50">
                    {dTrBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                    {dTrOn ? '收起译文' : '显示译文'}
                  </button>
                )}
                <button onClick={() => syncNow(String(detail.page_id || ''))} disabled={syncing}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50" title="从 Facebook 重新拉取该主页的最新收件箱对话并刷新">
                  <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? '拉取中…' : '重新拉取'}
                </button>
                <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="flex items-center gap-1 text-xs text-slate-400 px-5 py-2 border-b border-slate-800/60">
              <User className="w-3.5 h-3.5" /> 对话对象：{getParticipantNames(detail).join(', ') || '未知'}
            </div>
            <div ref={msgBodyRef} className="flex-1 overflow-y-auto p-5 space-y-3 text-sm bg-slate-950/40">
              {dMsgs.length === 0 && <div className="text-slate-500 text-center py-10">暂无消息内容（抓取时仅保存了对话概要）</div>}
              {dMsgs.map((m) => {
                const wantTr = dTrOn && lang !== 'off';
                const tr = wantTr ? (dTr[m.text] || '') : '';
                const trPending = wantTr && !!m.text && !tr && dTrBusy;
                return (
                  <div key={m.id} className={`flex flex-col ${m.from.includes('|') || m.from === detail.page_name ? '' : 'items-end'}`}>
                    <div className="text-[11px] text-slate-500 mb-0.5">{m.from} · {m.time}</div>
                    <div className={`px-3.5 py-2 rounded-2xl max-w-[85%] break-words border ${m.from === detail.page_name ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-emerald-600/20 border-emerald-600/30 text-emerald-50'}`}>
                      {m.text || '(图片/表情等非文字消息)'}
                      {tr && tr !== m.text && (
                        <div className="mt-1 pt-1.5 border-t border-white/10 text-[12px] text-indigo-300/90 leading-snug">{tr}</div>
                      )}
                      {trPending && <div className="mt-1 text-[11px] text-indigo-400/50 animate-pulse">翻译中…</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-slate-800 px-4 py-3 space-y-2">
              {sendErr && <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{sendErr}</div>}
              {sendOk && <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">{sendOk}</div>}
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-slate-400">
                  发送到
                  <select value={target} onChange={(e) => setTarget(e.target.value)}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500">
                    <option value="auto">自动（对方语言）</option>
                    {Object.entries(TRANS_LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-400">
                  翻译引擎
                  <select value={transEngine} onChange={(e) => changeTransEngine(e.target.value)}
                    title="AI＝Gemini/DeepSeek（按量付费）；Google 免费翻译＝clients5 免费端点；LibreTranslate＝宝塔自建；Gemini Web＝宝塔上的 gemini-web2api 桥（免费）。选中哪个就用哪个，不会自动降级"
                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500">
                    {Object.entries(TRANS_ENGINES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-400 select-none">
                  <input type="checkbox" checked={autoTranslate} onChange={(e) => setAutoTranslate(e.target.checked)}
                    className="accent-indigo-500" />
                  发送前翻译成目标语言
                </label>
              </div>
              <div className="flex items-end gap-1.5">
                <div className="flex flex-col gap-1 pb-1">
                  <button onClick={genReplyFill} disabled={aiGen || sending} title="AI 生成回复填充到输入框（不会自动发送，确认后手动发送）"
                    className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-indigo-200 disabled:opacity-40">
                    {aiGen ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  </button>
                  <label title="发送图片（≤9MB）" className="cursor-pointer flex items-center justify-center w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-emerald-300 disabled:opacity-40">
                    <ImageIcon className="w-4 h-4" />
                    <input type="file" accept="image/*" disabled={sending} className="hidden"
                      onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) sendMediaFile('image', f); }} />
                  </label>
                  <label title="发送视频（≤9MB）" className="cursor-pointer flex items-center justify-center w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-emerald-300 disabled:opacity-40">
                    <Video className="w-4 h-4" />
                    <input type="file" accept="video/*" disabled={sending} className="hidden"
                      onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) sendMediaFile('video', f); }} />
                  </label>
                </div>
                <textarea value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    // 裸 Enter 发送；Shift/Ctrl(⌘)+Enter 保留默认行为即换行
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      if (!sending && reply.trim()) doSend();
                    }
                  }}
                  rows={2} placeholder={(autoTranslate ? '输入回复内容（将自动翻译后发送）…' : '输入回复内容…') + '（Enter 发送 / Ctrl+Enter 换行）'}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none" />
                <button onClick={doSend} disabled={sending || !reply.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed">
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} 发送
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
