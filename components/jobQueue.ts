/**
 * 服务端批量任务队列 —— 前端客户端
 *
 * 任务的真正执行在**本机后端**（POST /api/jobs），本模块只负责：
 *   - 提交任务（不等待执行完成，提交完就可以随便刷新页面）
 *   - 轮询后端拿进度，供导航徽标 + 队列页展示
 *   - 取消单个任务 / 一键取消全部 / 清理已结束
 *
 * 因此前端刷新、切页、断网都不会中断批量执行；后端重启也会自动续跑未完成的任务。
 */

export type JobItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobItem {
  key: string;
  label: string;
  status: JobItemStatus;
  message: string;
  startedAt: number;
  finishedAt: number;
  payload?: any;
}

export interface Job {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  total: number;
  done: number;
  ok: number;
  fail: number;
  concurrency: number;
  error: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  items: JobItem[];
}

export interface QueueState {
  jobs: Job[];
  counts: Record<string, number>;
  concurrency: number;
  updatedAt: number;
}

/** 会真实占用本机浏览器、单个耗时 30~60s 的操作 → 必须走队列 */
export type SlowOpType =
  | 'launch_browser'
  | 'stop_browser'
  | 'get_info'
  | 'fetch_posts'
  | 'fetch_insights'
  | 'fetch_billing'
  | 'create_bm'
  | 'create_bm_bundle'
  | 'create_page'
  | 'create_adaccount'
  | 'generate_invite_links'
  | 'generate_invite_links_to_product'
  | 'grant_page'
  | 'share_partner'
  | 'create_pixel'
  | 'bind_card'
  | 'verify_bm'
  | 'invite_users'
  | 'assign_personal_ad'
  | 'grant_personal_page'
  | 'refresh_info'
  | 'sync_permissions'
  | 'grant_pixels'
  | 'fetch_tokens'
  | 'relogin'
  | 'publish_ads'
  | 'publish_pages'
  | 'grant_personal'
  | 'accept_page_invite'
  | 'smart_publish_bundle';

export const OP_LABELS: Record<string, string> = {
  launch_browser: '启动浏览器',
  stop_browser: '关闭浏览器',
  get_info: '获取信息',
  fetch_posts: '拉取贴文/对话',
  fetch_insights: '同步广告数据',
  fetch_billing: '查询账单信息',
  create_bm: '创建BM',
  create_bm_bundle: '创建BM（含广告号/主页）',
  create_page: '创建主页',
  create_adaccount: '创建广告号',
  generate_invite_links: '生成邀请链接',
  generate_invite_links_to_product: '生成邀请链接并写入商品',
  grant_page: '授权主页',
  share_partner: '分享合作伙伴',
  create_pixel: '创建像素',
  bind_card: '绑卡',
  verify_bm: 'BM认证',
  invite_users: '邀请用户',
  assign_personal_ad: '广告号授权个号',
  grant_personal_page: '主页授权个号',
  refresh_info: '刷新信息',
  sync_permissions: '同步权限',
  grant_pixels: '像素授权',
  fetch_tokens: '获取TOKEN',
  relogin: '批量重登',
  publish_ads: '发布广告',
  publish_pages: '发布/取消发布主页',
  grant_personal: '授权到个人号',
  accept_page_invite: '同意主页邀请',
  smart_publish_bundle: '智能发布（组合步骤）',
};

const LOCAL_API_BASE = (((import.meta as any).env?.VITE_LAUNCH_SERVER_URL) || 'http://localhost:9999').replace(/\/$/, '') + '/api';
const LOCAL_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

const ACTIVE: JobStatus[] = ['queued', 'running'];
const IDLE_POLL_MS = 15000;
const ACTIVE_POLL_MS = 2000;

let state: QueueState = { jobs: [], counts: {}, concurrency: 2, updatedAt: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let inFlight = false;

const emit = () => { listeners.forEach((l) => { try { l(); } catch { } }); };

export function snapshot(): QueueState { return state; }

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!polling) startPolling();
  // 新订阅者立刻拿一次最新状态，避免徽标空白
  void refresh();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stopPolling();
  };
}

export function hasActiveJobs(): boolean {
  return state.jobs.some((j) => ACTIVE.includes(j.status));
}

function startPolling() {
  polling = true;
  schedule(0);
}

function stopPolling() {
  polling = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await refresh();
    if (polling) schedule(hasActiveJobs() ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }, ms);
}

async function call(path: string, init?: RequestInit, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  // 🔐 带上登录身份：本机队列按 user_id 隔离任务（切账号后不会再看到别人的任务）
  let auth = '';
  try { auth = localStorage.getItem('auth_token') || ''; } catch { }
  try {
    const resp = await fetch(`${LOCAL_API_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Secret': LOCAL_SECRET,
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(init?.headers || {}),
      },
    });
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

export async function refresh(): Promise<QueueState> {
  if (inFlight) return state;
  inFlight = true;
  try {
    const json = await call('/jobs?limit=100');
    if (json && json.success) {
      state = {
        jobs: Array.isArray(json.jobs) ? json.jobs : [],
        counts: json.counts || {},
        concurrency: json.concurrency || state.concurrency,
        updatedAt: Date.now(),
      };
      emit();
    }
    // ⛔ 失败（超时 / 连接被拒 / 接口异常）一律静默，保留上一次的数据，不做任何"后端是否在线"的判定。
    //    原因：批量或连续启动浏览器会占满浏览器对同一 origin 的并发连接（6 条），
    //    轮询请求排队到超时是正常现象，据此判定"9999 不在线"纯属误报。
  } catch {
    /* 静默：等下一次轮询 */
  } finally {
    inFlight = false;
  }
  return state;
}

/**
 * 提交一个批量任务。
 * @param items 每项 = 一个配置的一个动作；payload 由后端按类型分发给对应接口
 */
export async function submitJob(opts: {
  type: SlowOpType;
  title?: string;
  items: Array<{ key: string; label?: string; payload: any }>;
  concurrency?: number;
  /**
   * 整批共享的公共数据（例如「发布广告」的 campaignTree + 素材 base64）。
   * 后端只存一份并在执行时按项合并，避免每个配置都重复带上几十 MB 的素材。
   */
  shared?: any;
}): Promise<Job> {
  const json = await call('/jobs', {
    method: 'POST',
    body: JSON.stringify({
      type: opts.type,
      title: opts.title,
      items: opts.items,
      concurrency: opts.concurrency,
      shared: opts.shared,
    }),
  }, 120000);
  if (!json || !json.success) throw new Error((json && json.message) || '提交任务失败');
  await refresh();
  return json.job as Job;
}

/**
 * 🚦 长请求闸门（本机 9999 专用）。
 *
 * 为什么需要：Chrome 对**同一个 origin**（http://localhost:9999）最多只开 6 条
 * HTTP/1.1 连接。启动浏览器 / 取 Token 这类长任务一旦同时挂满 6 条，页面上所有打向
 * 9999 的请求（队列轮询、列表刷新、启动）都会在浏览器本地排队、一个字节都发不出去 ——
 * 表现就是「点了启动没反应、Network 里压根没有请求」。
 * 所以这里把长任务限制为最多同时 3 条，永远给轮询 / 短请求留出连接。
 */
const MAX_LONG_REQUESTS = 3;
let longReqActive = 0;
const longReqWaiters: Array<() => void> = [];

export async function withLongRequestSlot<T>(fn: () => Promise<T>): Promise<T> {
  // while 而不是 if：被唤醒后要重新确认真的有空位（避免并发释放时的抢位）
  while (longReqActive >= MAX_LONG_REQUESTS) {
    await new Promise<void>((resolve) => longReqWaiters.push(resolve));
  }
  longReqActive++;
  try {
    return await fn();
  } finally {
    longReqActive = Math.max(0, longReqActive - 1);
    const next = longReqWaiters.shift();
    if (next) { try { next(); } catch { } }
  }
}

/**
 * 等待某个任务跑到终态（done / failed / cancelled）。
 * onTick 会在每次轮询后回调，用于把队列进度同步到调用方的界面文案。
 */
export function waitForJob(id: string, onTick?: (job: Job | null) => void): Promise<Job | null> {
  return new Promise((resolve) => {
    const finish = (j: Job | null) => { try { unsub(); } catch { } resolve(j); };
    const unsub = subscribe(() => {
      const j = snapshot().jobs.find((x) => x.id === id) || null;
      if (onTick) { try { onTick(j); } catch { } }
      if (j && (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')) finish(j);
    });
  });
}

export async function cancelJob(id: string): Promise<void> {
  await call(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  await refresh();
}

export async function cancelAll(): Promise<void> {
  await call('/jobs/cancel-all', { method: 'POST' });
  await refresh();
}

export async function clearFinished(): Promise<void> {
  await call('/jobs/clear-finished', { method: 'POST' });
  await refresh();
}

export async function setQueueConcurrency(n: number): Promise<number> {
  const json = await call('/jobs/settings', { method: 'POST', body: JSON.stringify({ concurrency: n }) });
  await refresh();
  return (json && json.concurrency) || n;
}

/**
 * 取某个配置「最近一次抓取的原始结果」。
 * 队列 worker 只把数据抓回来并暂存在后端；前端拿到这份数据后再写回浏览器本地缓存
 * （资产页读的是 localStorage 的 cache:adaccounts / pages / businesses / pixels / ads）。
 */
export async function getLastAssets(profileId: string): Promise<any | null> {
  try {
    const json = await call(`/jobs/last-assets?profileId=${encodeURIComponent(profileId)}`, undefined, 20000);
    return json && json.found ? json.data : null;
  } catch {
    return null;
  }
}
