// @ts-nocheck
/**
 * AI 自动回复队列（模块级，独立于组件生命周期）
 * - 消息对话页「AI 回复 / 批量 AI 回复」把任务加入本队列，逐个顺序执行；
 * - 任务之间按 delayMs 间隔发送（发送频率控制，防刷屏）；
 * - 导航「AI 回复队列」页可实时查看状态并取消单个/全部任务。
 * 任务在页面切换/关闭后仍继续执行（不依赖 React 组件状态）。
 */
import { loadAIReplyPrompt } from './AutoReplySettings';
import { cacheSentMsg } from './sentCache';
import { buildMediaPrompt, getAllMedia } from './mediaStore';

export type QueueStatus = 'queued' | 'generating' | 'sending' | 'done' | 'error' | 'cancelled';

export interface QueueTask {
  uid: string;
  key: string; // profileId::pageId::conversationId
  peer: string; // 对话对象显示名
  status: QueueStatus;
  reply: string;
  error: string;
  createdAt: number;
  finishedAt: number;
  inputs: TaskInput;
}

export interface TaskInput {
  key: string;
  profileId: string;
  pageId: string;
  conversationId: string;
  pageName?: string;
  userId?: string;
  peerName?: string;
  messages_json?: string;
  /** 附加给 AI 的场景指令（如“对方未回复，主动跟进”），拼在提示词之后 */
  extraInstruction?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// —— 只生成不发送：对话详情「AI 回复」按钮用，把生成文本填充进输入框由用户手动发送 ——
// 注意：填充的是中文草稿（操作员可检查内容），点发送后若开启「发送前翻译」会自动译成对方语言
export async function generateReplyOnly(it: TaskInput): Promise<string> {
  const base = loadAIReplyPrompt(it.pageName);
  const system = `${base}${it.extraInstruction ? `\n\n${it.extraInstruction}` : ''}\n\n重要：本次生成的是给操作员预览的回复草稿，请用简体中文输出这条回复正文（发送前系统会自动翻译成对方的语言）。`;
  const history = buildHistory(it);
  if (!history.trim()) throw new Error('当前对话暂无可用消息记录，无法生成回复');
  const raw = await callAIReplyApi(system, history);
  return String(raw || '').replace(/\[MEDIA:([A-Za-z0-9_\-]+)\]/g, '').trim();
}

const getSbase = () => {
  let s = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
  try { if (s && /localhost|127\.0\.0\.1|api\.adpos\.io/i.test(s)) s = ''; } catch {}
  return s;
};
const LOCAL_API_BASE = 'http://localhost:9999/api';
const LOCAL_API_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

// 解析该对话 messages_json 为 [{from,text}]（最近 N 条），供生成历史上下文
const buildHistory = (it: TaskInput, max = 16): string => {
  const pageName = String(it.pageName || '本主页');
  let msgs: Array<{ from: string; text: string }> = [];
  try {
    const raw = JSON.parse(it.messages_json || '[]');
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    msgs = list
      .filter((m: any) => m && (m.message || m.story))
      .map((m: any) => ({
        from: String(m?.from?.name || m?.from?.id || '对方'),
        text: String(m.message || m.story || ''),
      }))
      .slice(-max);
  } catch {}
  if (!msgs.length) return '';
  const lines = msgs.map(m => {
    const isSelf = m.from === pageName || (pageName && m.from.includes(pageName));
    return `${isSelf ? `主页(${pageName})` : `对方(${m.from})`}: ${m.text}`;
  });
  return [`这是主页「${pageName}」与客户的 Messenger 对话记录（越靠后越新）：`, ...lines, '', '请根据以上内容与你的角色设定，给出作为主页方现在应该回复客户的一条正文。'].join('\n');
};

// 调云端 AI 对话接口生成一条回复
const callAIReplyApi = async (system: string, historyText: string, signal?: AbortSignal): Promise<string> => {
  const sbase = getSbase();
  const token = localStorage.getItem('auth_token') || '';
  const timer = setTimeout(() => { try { signal?.abort(); } catch {} }, 60000);
  try {
    const resp = await fetch(`${sbase}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
      signal,
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

// 经本机浏览器服务发送一条消息
const sendFbMessage = async (payload: any, timeoutMs = 150000): Promise<any> => {
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
    if (err?.name === 'AbortError') throw new Error('发送超时，已自动放弃本次发送。若消息实际已发出，可稍后点「拉取更新」确认。');
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

// —— 模块状态（跨组件共享） ——
type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => { listeners.forEach(l => { try { l(); } catch {} }); };

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function snapshot(): QueueTask[] { return tasks.map(t => ({ ...t, inputs: { ...t.inputs } })); }

let tasks: QueueTask[] = [];
let running = false;
let stopped = false;
let delayMs = 5000; // 相邻两条发送的间隔（毫秒）
let abortCtrl: AbortController | null = null;

export function getDelayMs() { return delayMs; }
export function setDelayMs(v: number) { delayMs = Math.max(0, Math.min(3600000, Number(v) || 0)); }

const uid = () => `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** 加入队列并启动执行（自动去重：同一对话已在队列或进行中则不重复入队） */
export function enqueue(inputs: TaskInput[]): QueueTask[] {
  const now = Date.now();
  const added: QueueTask[] = [];
  for (const it of inputs) {
    if (tasks.some(t => t.key === it.key && (t.status === 'queued' || t.status === 'generating' || t.status === 'sending'))) continue;
    const t: QueueTask = {
      uid: uid(),
      key: it.key,
      peer: it.peerName || it.conversationId || '',
      status: 'queued',
      reply: '',
      error: '',
      createdAt: now,
      finishedAt: 0,
      inputs: { ...it },
    };
    tasks.push(t);
    added.push(t);
  }
  emit();
  pump();
  return added;
}

export function cancelTask(tuid: string) {
  const t = tasks.find(x => x.uid === tuid);
  if (!t || t.status === 'done' || t.status === 'error' || t.status === 'cancelled') return;
  if (t.status === 'queued') {
    t.status = 'cancelled';
    t.finishedAt = Date.now();
  } else {
    // 生成/发送中：标记取消，由执行循环在该条结束后判定（正在进行的请求无法中途打断）
    t.status = 'cancelled';
    t.finishedAt = Date.now();
    try { abortCtrl?.abort(); } catch {}
  }
  emit();
}

export function cancelAll() {
  stopped = true;
  try { abortCtrl?.abort(); } catch {}
  tasks.forEach(t => {
    if (t.status === 'queued' || t.status === 'generating' || t.status === 'sending') {
      t.status = 'cancelled';
      t.finishedAt = Date.now();
    }
  });
  emit();
}

/** 清理已结束（done/error/cancelled）的任务记录 */
export function clearFinished() {
  tasks = tasks.filter(t => t.status !== 'done' && t.status !== 'error' && t.status !== 'cancelled');
  emit();
}

async function pump() {
  if (running) return;
  running = true;
  abortCtrl = null;
  try {
    while (!stopped) {
      const next = tasks.find(t => t.status === 'queued');
      if (!next) break;
      const it = next.inputs;
      const started = Date.now();
      next.status = 'generating';
      emit();
      try {
        const base = loadAIReplyPrompt(it.pageName);
        const extra = it.extraInstruction ? `\n\n${it.extraInstruction}` : '';
        const system = `${base}${extra}`;
        const history = buildHistory(it);
        if (!history.trim()) throw new Error('该对话暂无可用消息记录，请先点「拉取更新」');
        // 素材库：如已上传图片/视频，让 AI 在回复末尾用 [MEDIA:<id>] 自主决定是否附带媒体
        const mediaPrompt = await buildMediaPrompt();
        abortCtrl = new AbortController();
        const replyRaw = await callAIReplyApi(system + mediaPrompt, history, abortCtrl.signal);
        if (!replyRaw && !stopped) throw new Error('AI 未返回回复内容，请检查「提示词设置」或稍后重试');
        const mediaTag = String(replyRaw || '').match(/\[MEDIA:([A-Za-z0-9_\-]+)\]/);
        const reply = String(replyRaw || '').replace(/\[MEDIA:([A-Za-z0-9_\-]+)\]/g, '').trim();
        let attachment: { base64: string; mimeType?: string; kind?: string } | null = null;
        if (mediaTag && mediaTag[1]) {
          try {
            const all = await getAllMedia();
            const found = all.find(a => a.id === mediaTag![1]);
            if (found) attachment = { base64: found.base64, mimeType: found.mimeType, kind: found.kind };
          } catch {}
        }
        if (!stopped) {
          next.status = 'sending';
          next.reply = reply || '[媒体]';
          emit();
          await sendFbMessage({
            profileId: it.profileId,
            pageId: it.pageId,
            conversationId: it.conversationId,
            message: reply,
            pageName: it.pageName || '',
            ...(it.userId ? { userId: it.userId } : {}),
            ...(attachment ? { attachment } : {}),
          });
          // 发送成功即写本地持久缓存：不依赖任何页面是否打开/停留，刷新后本地仍显示这条回复
          cacheSentMsg(
            { page_id: it.pageId, conversation_id: it.conversationId, page_name: it.pageName || '' },
            { id: `local_${Date.now()}_${next.uid}`, message: reply || (attachment ? `[已发送${attachment.kind === 'video' ? '视频' : '图片'}]` : ''), from: { name: it.pageName || '我', id: it.pageId }, created_time: new Date().toISOString() },
          );
        }
        next.status = stopped ? 'cancelled' : 'done';
      } catch (e: any) {
        next.status = stopped ? 'cancelled' : 'error';
        next.error = e?.message || String(e);
      }
      next.finishedAt = Date.now();
      emit();
      if (stopped) break;
      const el = Date.now() - started;
      const wait = delayMs - el;
      if (wait > 0) await sleep(wait);
    }
  } finally {
    running = false;
    stopped = false;
    abortCtrl = null;
    emit();
  }
}
