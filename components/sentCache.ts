// @ts-nocheck
/**
 * 本地“已发送”持久缓存。
 * - 任何发送成功（手动 / AI 回复队列 / 持续监听）都立即写入，页面刷新后仍显示；
 * - 读取会话行时并入（merge）；云端出现同正文±窗口内的正式消息后自动收敛清除，不产生残留。
 * 该模块不依赖 UI / React，供消息页与 aiQueue / aiWatch 共用。
 *
 * ⚠️ 隔离：以前用固定的全局 localStorage 键 —— 同一台机器换个账号登录就能读到
 *    上一个账号的已发送内容。现在经 userSettings 按登录用户命名空间读写，
 *    并在后台同步到云端 user_settings（按 user_id 隔离），换设备也能拿回来。
 */

import { readUserSetting, writeUserSetting, pushUserSetting } from './userSettings';

const SENT_CACHE_KEY = 'fb_msg_sent_cache_v1';

// 云端同步做 3s 去抖：发消息是高频动作，不然每条都打一次网络
let _pushTimer: any = null;
let _pendingValue: string | null = null;
function _pushDebounced(value: string) {
  _pendingValue = value;
  if (_pushTimer) return;
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    const v = _pendingValue;
    _pendingValue = null;
    if (v !== null) pushUserSetting(SENT_CACHE_KEY, v);
  }, 3000);
}

const _key = (c: { page_id?: string; conversation_id?: string }) =>
  `${String(c.page_id || '')}::${String(c.conversation_id || '')}`;

const _epoch = (s?: string) => { const t = Date.parse(String(s || '')); return Number.isNaN(t) ? 0 : t; };

export const loadSentCache = (): Record<string, any[]> => {
  try { const j = JSON.parse(readUserSetting(SENT_CACHE_KEY) || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
};
export const saveSentCache = (c: Record<string, any[]>) => {
  let v = '{}';
  try { v = JSON.stringify(c); } catch { return; }
  writeUserSetting(SENT_CACHE_KEY, v);
  _pushDebounced(v);
};

/** 发送成功：写一条缓存 */
export function cacheSentMsg(conv: { page_id?: string; conversation_id?: string; page_name?: string } | null | undefined,
  msg?: { id?: string; message?: string; story?: string; from?: any; created_time?: string } | null): void {
  if (!conv || !conv.conversation_id || !msg) return;
  if (!msg.message && !msg.story) return;
  const c = loadSentCache();
  const key = _key(conv);
  const arr = c[key] || [];
  arr.push({
    id: msg.id || `local_${Date.now()}`,
    message: msg.message || msg.story || '',
    story: '',
    from: msg.from || { name: String(conv.page_name || '我'), id: String(conv.page_id || '') },
    created_time: msg.created_time || new Date().toISOString(),
  });
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  c[key] = arr.filter((m: any) => _epoch(m.created_time) >= cutoff).slice(-60);
  saveSentCache(c);
}

/** 把该会话缓存消息并入行：跳过内存已有的同 id 乐观消息；云端正式消息命中 → 收敛清除对应缓存项 */
export function mergeSentCacheIntoRow<T extends { conversation_id?: string; page_id?: string; messages_json?: string; updated_time?: string }>(row: T): T {
  if (!row || !row.conversation_id) return row;
  const cache = loadSentCache();
  const list = cache[_key(row)];
  if (!list || !list.length) return row;
  let hasWrapper = false;
  let src: any[] = [];
  try {
    const p = JSON.parse(row.messages_json || '[]');
    hasWrapper = Array.isArray(p?.data);
    src = hasWrapper ? p.data : p;
    if (!Array.isArray(src)) src = [];
  } catch { return row; }
  const survivors: any[] = [];
  let converged = false;
  for (const cm of list) {
    const cmId = String(cm?.id || '');
    const cmText = String(cm?.message || cm?.story || '').trim();
    const cmTs = _epoch(cm.created_time);
    const sameIdInRow = cmId && src.some((m: any) => String(m?.id || '') === cmId);
    const formalInRow = !sameIdInRow && cmText && src.some((m: any) =>
      String(m?.message || m?.story || '').trim() === cmText && Math.abs(_epoch(m.created_time) - cmTs) < 150000);
    if (formalInRow) { converged = true; continue; }
    if (!sameIdInRow) survivors.push(cm);
  }
  if (!survivors.length) {
    if (converged) { const c2 = loadSentCache(); c2[_key(row)] = []; saveSentCache(c2); }
    return row;
  }
  if (converged) { const c2 = loadSentCache(); c2[_key(row)] = survivors; saveSentCache(c2); }
  const merged = [...src, ...survivors];
  let out = { ...row, messages_json: JSON.stringify(hasWrapper ? { data: merged } : merged) };
  const tailTs = String(survivors[survivors.length - 1]?.created_time || '');
  if (tailTs && tailTs > String(out.updated_time || '')) out = { ...out, updated_time: tailTs };
  return out;
}

/** 移除某会话全部本地缓存（如用户主动清空时） */
export function clearSentCacheFor(pageId?: string, conversationId?: string): void {
  if (!pageId || !conversationId) return;
  const c = loadSentCache();
  delete c[_key({ page_id: pageId, conversation_id: conversationId })];
  saveSentCache(c);
}
