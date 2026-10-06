// @ts-nocheck
/**
 * 批量 AI 持续监听：对勾选的对话定时从 Facebook 拉取单个会话（所属主页）的新消息，
 * 检测到“对方新发来的文字消息”且不在冷却期内 → 自动把该对话加入 AI 回复队列智能回复。
 * - 模块级：切页面不中断；值守队列写入 localStorage，刷新后自动恢复
 * - 队列上报本机 PUP(9999)：AutoSync 只同步值守队列里的配置，不再扫描已删除/残留目录
 * - 防回环：每个对话自动回复后有 cooldownSec 冷却；同一对话已在 AI 队列则去重
 * - 默认提示词来自「提示词设置」（AI 回复提示词）
 */
import { enqueue as AIQEnqueue } from './aiQueue';
import { readUserSetting, writeUserSetting, pushUserSetting, subscribeUserSettings } from './userSettings';

export interface WatchInput {
  key: string;
  profileId: string;
  pageId: string;
  conversationId: string;
  pageName?: string;
  peerName?: string;
  userId?: string;
}

export interface WatchEntry extends WatchInput {
  hasBaseline: boolean;   // 是否已完成首次基线（首次只记录快照，不回复历史）
  lastPeerTs: number;     // 最近一次见过的“对方文字消息”时间（epoch ms）
  lastPeerText: string;
  lastAutoTs: number;     // 上次自动回复触发时间（epoch ms）
  lastError: string;
  lastCheckTs: number;
  createdAt: number;
  enabled: boolean;
  autoOfPage?: string; // 由哪个「主页级值守」(page:profile::page) 自动创建的对话监听
  // —— 空闲自动跟进（对方长时间未回复 → 主动 AI 跟进一次） ——
  lastFollowTs: number;   // 上次主动跟进时间（epoch ms）
  followDate: string;     // 上次跟进所属日期 YYYY-MM-DD（按天计数）
  followCount: number;    // 当天已跟进次数
}

// —— 主页级“全自动值守” ——
// 某主页被加入值守后：该主页现有+未来新出现的对话都会自动纳入 AI 持续监听（无需逐个手动添加）
export interface PageWatch {
  key: string;        // `page:${profileId}::${pageId}`
  profileId: string;
  pageId: string;
  pageName?: string;
  enabled: boolean;
  createdAt: number;
}

let pageEntries: PageWatch[] = [];

export function addPage(profileId: string, pageId: string, pageName?: string): PageWatch {
  const key = `page:${profileId}::${pageId}`;
  // 抢占：同一主页只允许一个配置值守——“谁最新开启/拉取，谁操控”。
  // 自动停用其它配置对该主页的值守，并移除其派生的对话监听（人工单独勾选的保留）
  const stale = pageEntries.filter(p => p.pageId === String(pageId) && p.profileId !== String(profileId));
  for (const s of stale) {
    pageEntries = pageEntries.filter(p => p.key !== s.key);
    entries = entries.filter(e => !(e.autoOfPage === s.key));
  }
  let found = pageEntries.find(p => p.key === key);
  if (found) {
    found.enabled = true;
    found.pageName = pageName || found.pageName;
  } else {
    found = { key, profileId, pageId, pageName: pageName || '', enabled: true, createdAt: Date.now() };
    pageEntries.push(found);
  }
  emit();
  restartTimer();
  queueChanged();
  return { ...found };
}

/** 停止该主页值守；一并移除由值守自动创建的对话条目（人工单独添加的仍保留） */
export function removePage(profileId: string, pageId: string) {
  const key = `page:${profileId}::${pageId}`;
  pageEntries = pageEntries.filter(p => p.key !== key);
  entries = entries.filter(e => e.autoOfPage !== key);
  emit();
  if (!entries.some(e => e.enabled) && !pageEntries.some(p => p.enabled)) stopTimer();
  queueChanged();
}

export function togglePage(profileId: string, pageId: string, on: boolean) {
  const found = pageEntries.find(p => p.profileId === String(profileId) && p.pageId === String(pageId));
  if (!found) return;
  found.enabled = on;
  if (on) restartTimer();
  emit();
  queueChanged();
}

export function isPageWatching(profileId: string, pageId: string): boolean {
  return pageEntries.some(p => p.profileId === String(profileId) && p.pageId === String(pageId) && p.enabled);
}

export function snapshotPages(): PageWatch[] { return pageEntries.map(p => ({ ...p })); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const getSbase = () => {
  let s = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
  try { if (s && /localhost|127\.0\.0\.1|api\.adpos\.io/i.test(s)) s = ''; } catch {}
  return s;
};
const LOCAL_API_BASE = 'http://localhost:9999/api';
const LOCAL_API_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

// —— 浏览器自动启动（值守时发现浏览器未运行则自动拉起该配置） ——
const lastAutoLaunchAt = new Map<string, number>();
const AUTO_LAUNCH_COOLDOWN_MS = 120 * 1000; // 同一配置 2 分钟内最多自动启动一次，避免频繁弹窗
async function tryLaunchBrowser(profileId: string, pageName?: string): Promise<'ok' | 'error' | 'cooldown'> {
  const now = Date.now();
  const last = lastAutoLaunchAt.get(String(profileId)) || 0;
  if (now - last < AUTO_LAUNCH_COOLDOWN_MS) return 'cooldown';
  lastAutoLaunchAt.set(String(profileId), now);
  try {
    const resp = await fetch(`${LOCAL_API_BASE}/launch-browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_API_SECRET },
      body: JSON.stringify({ profileId, pageName: pageName || '' }),
    });
    const j = await resp.json().catch(() => null);
    return resp.ok && j && j.success ? 'ok' : 'error';
  } catch { return 'error'; }
}

let entries: WatchEntry[] = [];
let pollSec = 60;      // 每轮轮询间隔（秒）
let cooldownSec = 120; // 同一对话自动回复后的冷却（秒）
// —— 空闲自动跟进：我方已回复过、但对方超过 followMinSec 未再回复时，主动 AI 跟进一条 ——
let followEnabled = false; // 默认关闭（对真人客户主动跟进有骚扰风险，请按业务需要显式开启）
let followMinSec = 30 * 60; // 对方未回复多久后跟进（默认 30 分钟）
let followMaxPerDay = 3;    // 同一对话每天最多主动跟进条数
let timer: any = null;
let running = false;

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => { listeners.forEach(l => { try { l(); } catch {} }); };

export function subscribe(fn: Listener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function snapshot(): WatchEntry[] { return entries.map(e => ({ ...e })); }
export function isWatching(key: string): boolean { return entries.some(e => e.key === key && e.enabled); }
export function getPollSec() { return pollSec; }
export function getCooldownSec() { return cooldownSec; }
export function setPollSec(v: number) { pollSec = Math.max(10, Math.min(3600, Number(v) || 60)); restartTimer(); emit(); }
export function setCooldownSec(v: number) { cooldownSec = Math.max(10, Math.min(86400, Number(v) || 120)); emit(); }
export function getFollowEnabled() { return followEnabled; }
export function getFollowMinSec() { return followMinSec; }
export function getFollowMaxPerDay() { return followMaxPerDay; }
export function setFollowEnabled(v: boolean) { followEnabled = !!v; emit(); }
export function setFollowMinSec(v: number) { followMinSec = Math.max(10 * 60, Math.min(24 * 3600, Number(v) * 60 || followMinSec)); emit(); }
export function setFollowMaxPerDay(v: number) { followMaxPerDay = Math.max(1, Math.min(10, Number(v) || 3)); emit(); }

const toEpoch = (iso?: string) => { const t = Date.parse(String(iso || '')); return Number.isNaN(t) ? 0 : t; };

const makeEntry = (it: WatchInput): WatchEntry => ({
  ...it,
  hasBaseline: false,
  lastPeerTs: 0,
  lastPeerText: '',
  lastAutoTs: 0,
  lastError: '',
  lastCheckTs: 0,
  createdAt: Date.now(),
  enabled: true,
  lastFollowTs: 0,
  followDate: '',
  followCount: 0,
});

/** 开启监听（已存在的项跳过；同 key 已禁用则重新启用并重置基线） */
export function addMany(inputs: WatchInput[]): WatchEntry[] {
  const added: WatchEntry[] = [];
  for (const it of inputs) {
    const found = entries.find(e => e.key === it.key);
    if (found) {
      if (!found.enabled) { found.enabled = true; found.hasBaseline = false; found.lastPeerTs = 0; added.push(found); }
      continue;
    }
    const e = makeEntry(it);
    entries.push(e);
    added.push(e);
  }
  emit();
  if (added.length) restartTimer();
  queueChanged();
  return added;
}

export function removeKeys(keys: string[]) {
  entries = entries.filter(e => !keys.includes(e.key));
  emit();
  restartTimer(); // 若主页级值守仍在，timer 应继续跑
  queueChanged();
}

export function toggle(key: string, on: boolean) {
  const e = entries.find(x => x.key === key);
  if (!e) return;
  e.enabled = on;
  if (on) { e.hasBaseline = false; e.lastPeerTs = 0; restartTimer(); } else { e.hasBaseline = true; }
  emit();
  queueChanged();
}

export function toggleAll(on: boolean) {
  entries.forEach(e => { e.enabled = on; if (on) { e.hasBaseline = false; e.lastPeerTs = 0; } });
  restartTimer();
  emit();
  queueChanged();
}

export function clearAll() { entries = []; restartTimer(); emit(); queueChanged(); }

function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
const anyActive = () => entries.some(e => e.enabled) || pageEntries.some(p => p.enabled);
function restartTimer() {
  stopTimer();
  // 只要还有对话级监听 或 主页级值守（哪怕尚无自动派生对话条目）都要周期性执行
  if (anyActive()) timer = setInterval(() => { runWatch(); }, Math.max(10, pollSec) * 1000);
}

// —— 网络 ——
async function syncLocalProfile(pageId: string, profileId: string, pageName?: string): Promise<'ok' | 'no-browser' | 'error'> {
  const doSync = async (): Promise<'ok' | 'no-browser' | 'error'> => {
    try {
      const resp = await fetch(`${LOCAL_API_BASE}/facebook/sync-inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_API_SECRET },
        body: JSON.stringify({
          profileId, pageId,
          pageCap: 50,            // 覆盖更多会话，确保被监听对话即使排在较后也能被同步到
          noBrowser: true,
          full: false,
          onlyUnread: false,      // 关键：监听比对不能按 unread_count 过滤——Graph 的 unread_count 经常恒为 0，
                                  // 若过滤会把“对方已发新消息但标记未及时刷新”的对话漏掉，导致永不触发
        }),
      });
      const j = await resp.json().catch(() => null);
      if (!resp.ok || !j || j.success === false) return 'error';
      if (j.skipped === 'no-browser-running') return 'no-browser';
      return 'ok';
    } catch { return 'error'; }
  };
  let r = await doSync();
  if (r !== 'no-browser') return r;
  // 浏览器未运行：自动启动该配置浏览器并等待就绪后重试一次
  const la = await tryLaunchBrowser(profileId, pageName);
  if (la !== 'ok') return 'no-browser';
  for (let i = 0; i < 8; i++) { // 最长约 24s 等待浏览器起来
    await sleep(3000);
    r = await doSync();
    if (r !== 'no-browser') return r;
  }
  return 'no-browser';
}

async function fetchCloudRows(profileId: string, pageId: string): Promise<any[]> {
  try {
    const token = localStorage.getItem('auth_token') || '';
    const params = new URLSearchParams({ _t: String(Date.now()) });
    if (profileId) params.set('profileId', profileId);
    if (pageId) params.set('pageId', pageId);
    const resp = await fetch(`${getSbase()}/api/messages?${params.toString()}`, {
      headers: { 'Cache-Control': 'no-cache', Authorization: token ? `Bearer ${token}` : '' },
    });
    const j = await resp.json().catch(() => null);
    if (!j) return [];
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.rows)) return j.rows;
    if (Array.isArray(j.data)) return j.data;
    if (Array.isArray(j.items)) return j.items;
    return [];
  } catch { return []; }
}

// 解析 messages_json → [{ text, timeEpoch, isSelf }]
const parseOf = (row: any, pageName: string, pageId: string) => {
  const out: Array<{ text: string; ts: number; isSelf: boolean }> = [];
  try {
    const raw = JSON.parse(String(row.messages_json || '[]'));
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    for (const m of list) {
      if (!m || (!m.message && !m.story)) continue;
      const from = String(m?.from?.name || m?.from?.id || '');
      const isSelf = from.includes('|') || (pageName && from === pageName) || (pageId && from === pageId);
      const ts = toEpoch(m.created_time);
      out.push({ text: String(m.message || m.story || ''), ts, isSelf });
    }
  } catch {}
  return out;
};

// 从 participants_json 兜底解析“对方”用户 id（排除主页自身）
const peerIdOf = (row: any, selfId: string, selfName: string): string => {
  try {
    const raw = JSON.parse(String(row.participants_json || '{}'));
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    for (const p of list) {
      const id = String(p?.id || '');
      const name = String(p?.name || '');
      if (id && id !== String(selfId) && name !== String(selfName)) return id;
    }
  } catch {}
  return '';
};

/** 单轮监听（对外也可手动触发一次） */
export async function runWatch(): Promise<number> {
  if (running) return 0;
  const actives = entries.filter(e => e.enabled);
  const activePages = pageEntries.filter(p => p.enabled);
  if (!actives.length && !activePages.length) return 0;
  running = true;
  let triggered = 0;
  try {
    // 按 配置::主页 分组，每组先同步一次收件箱（写库云端），再从云端读取比对；
    // 主页级值守(pageEntries)即使没有任何对话级 entry，也要建立自己的分组
    const groups = new Map<string, WatchEntry[]>();
    for (const e of actives) {
      const g = `${e.profileId}::${e.pageId}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(e);
    }
    for (const pg of activePages) {
      const g = `${pg.profileId}::${pg.pageId}`;
      if (!groups.has(g)) groups.set(g, []);
    }
    for (const [gKey, group] of groups) {
      const [profileId, pageId] = gKey.split('::');
      const first = group[0];
      const pageActive = pageEntries.find(p => p.enabled && String(p.profileId) === String(profileId) && String(p.pageId) === String(pageId));
      const scopeName = (first && first.pageName) || (pageActive && pageActive.pageName) || '';
      const sync = await syncLocalProfile(pageId, profileId, scopeName);
      if (sync === 'error') {
        group.forEach(e => { e.lastError = '拉取该主页失败（本机服务 9999 未运行？）'; e.lastCheckTs = Date.now(); });
        emit();
        continue;
      }
      if (sync === 'no-browser') {
        group.forEach(e => { e.lastError = '已尝试自动启动浏览器但仍未就绪（请检查弹出的浏览器是否已登录 Facebook）'; e.lastCheckTs = Date.now(); });
        emit();
        continue;
      }
      await sleep(600); // 稍等云端写入传播，避免读到同步前的旧行
      const rows = await fetchCloudRows(profileId, pageId);
      if (!rows.length) { group.forEach(e => { e.lastError = '同步后云端仍无该主页对话数据'; e.lastCheckTs = Date.now(); }); emit(); continue; }
      // 主页级全页值守：把该主页云端列表里出现的对话自动纳入监听
      // （对话级值守只处理被勾选的对话；主页级值守 = 覆盖该主页所有对话，
      //   现存未回复 + 之后新来的对话都会自动 AI 回复；发送节奏交给 AI 队列的发送间隔）
      if (pageActive) {
        const existingKeys = new Set(entries.map(e => e.key));
        const now = Date.now();
        for (const row of rows) {
          const cid = String(row.conversation_id || '');
          if (!cid) continue;
          const ckey = `${profileId}::${pageId}::${cid}`;
          if (existingKeys.has(ckey)) continue;
          const pageSelf = pageActive.pageName || String(row.page_name || '');
          const auto = makeEntry({
            key: ckey,
            profileId,
            pageId,
            conversationId: cid,
            pageName: pageSelf,
            userId: peerIdOf(row, String(pageId), pageSelf), // 从 participants 兜底解析对方 id
          });
          auto.autoOfPage = pageActive.key;
          // 基线直接对齐到当前快照（避免下一轮把它当“新消息”再触发一次）
          const msgs = parseOf(row, pageSelf, String(pageId));
          const peer = msgs.filter(m => !m.isSelf && m.text && m.ts > 0);
          let peerMax = 0, lastText = '';
          for (const m of peer) if (m.ts > peerMax) { peerMax = m.ts; lastText = m.text; }
          let mineMax = 0;
          for (const m of msgs) if (m.isSelf && m.ts > mineMax) mineMax = m.ts;
          auto.hasBaseline = true;
          auto.lastPeerTs = peerMax;
          auto.lastPeerText = lastText;
          auto.lastCheckTs = now;
          entries.push(auto);
          existingKeys.add(ckey);
          // —— 全页值守：现存未回复（对方最后一条文字在我方最后回复之后）→ 整段合并入队，
          //    由 AI 队列按发送间隔逐个回复（每对话只回一次；入队即记 lastAutoTs 防重复）——
          if (peerMax > 0 && peerMax > mineMax && lastText) {
            const added = AIQEnqueue([{
              key: ckey,
              profileId,
              pageId,
              conversationId: cid,
              pageName: pageSelf,
              userId: auto.userId || '',
              peerName: '',
              messages_json: String(row.messages_json || ''),
            }]);
            auto.lastAutoTs = now;
            if (added.length) { auto.lastError = ''; triggered += 1; }
            else auto.lastError = 'AI 队列已有该对话（去重），稍后自动发送';
          } else {
            auto.lastError = peerMax ? '对方最后一条已回复过，无需重复' : (mineMax ? '最后一条为我方消息，等待对方回复' : '该对话暂无文字消息');
          }
        }
      }
      for (const e of group) {
        const row = rows.find(r => String(r.conversation_id || '') === e.conversationId)
          || rows.find(r => String(r.page_id || '') === e.pageId && String(r.conversation_id || '') === e.conversationId);
        if (!row) { e.lastError = '云端未返回该对话，可能尚未同步'; e.lastCheckTs = Date.now(); continue; }
        const msgs = parseOf(row, String(e.pageName || ''), String(e.pageId || ''));
        const peer = msgs.filter(m => !m.isSelf && m.text && m.ts > 0);
        let maxTs = 0, lastText = '';
        for (const m of peer) if (m.ts > maxTs) { maxTs = m.ts; lastText = m.text; }
        let mineMax = 0;
        for (const m of msgs) if (m.isSelf && m.ts > mineMax) mineMax = m.ts;
        const rowJson = String(row.messages_json || '');
        if (!e.hasBaseline) {
          // 首次纳入：记录基线，但如果“对方最后一条文字晚于我方最后回复”（现存未回复）→
          // 也整段合并入队回复一次，而不是静默吞掉——值守开启后现存未回复消息同样按队列发送间隔逐个回复
          e.hasBaseline = true;
          e.lastPeerTs = maxTs;
          e.lastPeerText = lastText;
          if (maxTs > 0 && maxTs > mineMax && lastText) {
            const added = AIQEnqueue([{
              key: e.key,
              profileId: e.profileId,
              pageId: e.pageId,
              conversationId: e.conversationId,
              pageName: e.pageName || '',
              userId: e.userId || '',
              peerName: e.peerName || '',
              messages_json: rowJson,
            }]);
            e.lastAutoTs = Date.now();
            if (added.length) { e.lastError = ''; triggered += 1; }
            else e.lastError = 'AI 队列已有该对话（去重），稍后自动发送';
          } else {
            e.lastError = maxTs ? '对方最后一条已回复过，无需重复' : (mineMax ? '最后一条为我方消息，等待对方回复' : '该对话暂无文字消息，等待新消息');
          }
        } else if (maxTs > e.lastPeerTs) {
          // —— 对方发来新文字消息 → 立即入队 AI 回复（按队列间隔执行） ——
          const inCooldown = e.lastAutoTs > 0 && (Date.now() - e.lastAutoTs) < cooldownSec * 1000;
          e.lastPeerText = lastText;
          e.lastPeerTs = maxTs;
          if (!inCooldown && lastText) {
            const added = AIQEnqueue([{
              key: e.key,
              profileId: e.profileId,
              pageId: e.pageId,
              conversationId: e.conversationId,
              pageName: e.pageName || '',
              userId: e.userId || '',
              peerName: e.peerName || '',
              messages_json: String(row.messages_json || ''),
            }]);
            e.lastAutoTs = Date.now();
            if (added.length) { e.lastError = ''; triggered += 1; }
            else e.lastError = 'AI 队列已有该对话（去重），冷却内不再触发';
          } else {
            e.lastError = inCooldown ? `冷却中（${cooldownSec}s）` : '对方新消息为媒体/无文字，暂不触发';
          }
        } else {
          // —— 对方没有新消息：检查是否需要“空闲主动跟进” ——
          // 前提：已建基线 && 我方回复过对方最后一条（lastAutoTs >= lastPeerTs）&& 对方超过跟进间隔仍未回复
          //       && 上次跟进也已超过间隔 && 当天跟进次数未达上限
          e.lastError = '';
          const now = Date.now();
          const replied = e.lastAutoTs > 0 && e.lastAutoTs >= e.lastPeerTs;
          const idleMin = Math.round((now - e.lastPeerTs) / 60000);
          if (followEnabled && replied && e.lastPeerTs > 0
            && now - e.lastPeerTs >= followMinSec * 1000
            && now - (e.lastFollowTs || 0) >= followMinSec * 1000) {
            const today = new Date().toISOString().slice(0, 10);
            const cnt = e.followDate === today ? e.followCount : 0;
            if (cnt < followMaxPerDay) {
              const added = AIQEnqueue([{
                key: e.key,
                profileId: e.profileId,
                pageId: e.pageId,
                conversationId: e.conversationId,
                pageName: e.pageName || '',
                userId: e.userId || '',
                peerName: e.peerName || '',
                messages_json: String(row.messages_json || ''),
                extraInstruction:
                  `【主动跟进】对方（${e.peerName || '客户'}）的最后一条消息是「${e.lastPeerText || ''}」，`
                  + `距今已 ${idleMin} 分钟未再回复。请以主页身份主动发一条简短、礼貌的跟进消息`
                  + `（自然询问是否需要帮助 / 推动对话继续）。不要重复上一句说过的话，不要催促或施压，`
                  + `正文不超过 2 句。`,
              }]);
              if (added.length) {
                e.lastFollowTs = now;
                e.lastAutoTs = now; // 与自动回复共用冷却基准
                e.followDate = today;
                e.followCount = cnt + 1;
                e.lastError = `对方 ${idleMin} 分钟未回复，已主动跟进（今日 ${e.followCount}/${followMaxPerDay}）`;
                triggered += 1;
              } else {
                e.lastError = 'AI 队列已有该对话（去重），跟进跳过';
              }
            } else {
              e.lastError = `今日跟进已达上限（${followMaxPerDay} 条）`;
            }
          } else if (followEnabled && replied && e.lastPeerTs > 0) {
            const waitMin = Math.max(1, Math.ceil(((e.lastPeerTs + followMinSec * 1000) - now) / 60000));
            const waitFollow = Math.max(1, Math.ceil(((e.lastFollowTs || 0) + followMinSec * 1000 - now) / 60000));
            const nextMin = Math.min(waitMin, waitFollow);
            e.lastError = `对方已 ${idleMin} 分钟未回复，将于 ${nextMin} 分钟后自动跟进（可关）`;
          }
        }
        e.lastCheckTs = Date.now();
      }
      emit();
    }
  } finally {
    running = false;
    persistQueue(); // 保存最新基线/冷却状态，刷新后不重复触发历史消息
  }
  return triggered;
}

// ===================== 值守队列：按用户隔离持久化 + 上报本机 PUP =====================
// AutoSync 只同步「值守队列」中的配置（见 puppeteer-api-server.js /api/watch-active）
//
// ⚠️ 隔离：以前用固定的全局 localStorage 键 —— 同一台机器换个账号登录，
//    不但能看到别人的值守列表，还会**接着替别人的主页自动发 AI 回复**（最危险的一处）。
//    现在经 userSettings 按登录用户读写，并在后台同步到云端（按 user_id 隔离）。
const LS_PAGES_KEY = 'aiwatch.pages.v1';
const LS_ENTRIES_KEY = 'aiwatch.entries.v1';

// 值守队列变动很频繁（勾选/停用/自动派生都会触发）→ 云端同步做 2s 去抖
let _pushTimer: any = null;
let _pendingPush: { pages: string; entries: string } | null = null;
function _pushQueueDebounced(pages: string, entriesJson: string) {
  _pendingPush = { pages, entries: entriesJson };
  if (_pushTimer) return;
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    const p = _pendingPush;
    _pendingPush = null;
    if (!p) return;
    pushUserSetting(LS_PAGES_KEY, p.pages);
    pushUserSetting(LS_ENTRIES_KEY, p.entries);
  }, 2000);
}

function persistQueue() {
  try {
    // 自动派生的对话条目在停用后不再保留（刷新后由主页值守按需重建）；
    // 人工添加的对话与全部主页值守原样保留（含停用项，便于重新开启）
    const keep = entries.filter(e => !e.autoOfPage || e.enabled);
    const pagesJson = JSON.stringify(pageEntries);
    const entriesJson = JSON.stringify(keep);
    writeUserSetting(LS_PAGES_KEY, pagesJson);
    writeUserSetting(LS_ENTRIES_KEY, entriesJson);
    _pushQueueDebounced(pagesJson, entriesJson);
  } catch {}
}

const normPage = (p: any): PageWatch | null => {
  if (!p || typeof p !== 'object') return null;
  const profileId = String(p.profileId || '');
  const pageId = String(p.pageId || '');
  if (!profileId || !pageId) return null;
  return {
    key: String(p.key || `page:${profileId}::${pageId}`),
    profileId,
    pageId,
    pageName: String(p.pageName || ''),
    enabled: p.enabled !== false,
    createdAt: Number(p.createdAt) || Date.now(),
  };
};

const normEntry = (e: any): WatchEntry | null => {
  if (!e || typeof e !== 'object') return null;
  const profileId = String(e.profileId || '');
  const pageId = String(e.pageId || '');
  const conversationId = String(e.conversationId || '');
  if (!profileId || !pageId || !conversationId) return null;
  return {
    key: String(e.key || `${profileId}::${pageId}::${conversationId}`),
    profileId,
    pageId,
    conversationId,
    pageName: String(e.pageName || ''),
    peerName: String(e.peerName || ''),
    userId: String(e.userId || ''),
    hasBaseline: !!e.hasBaseline,
    lastPeerTs: Number(e.lastPeerTs) || 0,
    lastPeerText: String(e.lastPeerText || ''),
    lastAutoTs: Number(e.lastAutoTs) || 0,
    lastError: String(e.lastError || ''),
    lastCheckTs: Number(e.lastCheckTs) || 0,
    createdAt: Number(e.createdAt) || Date.now(),
    enabled: e.enabled !== false,
    autoOfPage: e.autoOfPage ? String(e.autoOfPage) : undefined,
    lastFollowTs: Number(e.lastFollowTs) || 0,
    followDate: String(e.followDate || ''),
    followCount: Number(e.followCount) || 0,
  };
};

function reportQueue() {
  const ids = new Set<string>();
  pageEntries.filter(p => p.enabled).forEach(p => ids.add(String(p.profileId)));
  entries.filter(e => e.enabled).forEach(e => ids.add(String(e.profileId)));
  const profileIds = [...ids].filter(Boolean);
  fetch(`${LOCAL_API_BASE}/watch-active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_API_SECRET },
    body: JSON.stringify({ profileIds }),
  }).catch(() => {});
}

function queueChanged() {
  persistQueue();
  reportQueue();
}

/** 账号配置被删除时调用：清理该配置下的主页值守与对话监听并重新上报队列 */
export function removeByProfileIds(ids: Array<string | number>) {
  const set = new Set(ids.map(String).filter(Boolean));
  if (!set.size) return;
  pageEntries = pageEntries.filter(p => !set.has(String(p.profileId)));
  entries = entries.filter(e => !set.has(String(e.profileId)));
  emit();
  if (!entries.some(e => e.enabled) && !pageEntries.some(p => p.enabled)) stopTimer();
  queueChanged();
}

function restoreQueue() {
  // ⚠️ 必须「整体替换」而不是「有值才覆盖」：切账号时要能清掉上一个人的内存队列，
  //    否则即便本地键隔离了，A 的值守仍会在 B 的会话里继续跑。
  let nextPages: PageWatch[] = [];
  let nextEntries: WatchEntry[] = [];
  try {
    const arr = JSON.parse(readUserSetting(LS_PAGES_KEY) || '[]');
    if (Array.isArray(arr)) nextPages = arr.map(normPage).filter(Boolean) as PageWatch[];
  } catch {}
  try {
    const arr = JSON.parse(readUserSetting(LS_ENTRIES_KEY) || '[]');
    if (Array.isArray(arr)) nextEntries = arr.map(normEntry).filter(Boolean) as WatchEntry[];
  } catch {}
  pageEntries = nextPages;
  entries = nextEntries;
  if (pageEntries.some(p => p.enabled) || entries.some(e => e.enabled)) restartTimer();
  else stopTimer();
  emit();
  queueChanged(); // 刷新后立刻把值守队列上报本机 PUP，保证 AutoSync 命中正确配置
}
restoreQueue();

// 切账号 / 云端拉取完成后，重建「本用户」的值守队列（拉到之前不能沿用上一个人的）
try { subscribeUserSettings(restoreQueue); } catch { }
