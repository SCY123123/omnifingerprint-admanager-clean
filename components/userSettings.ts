// @ts-nocheck
/**
 * 用户级设置：**按登录用户隔离 + 云端同步**。
 *
 * 背景：AI 提示词 / 值守队列 / 已发送缓存以前都存在固定的全局 localStorage 键上，
 * 同一台机器换个账号登录就会直接读到上一个账号的数据（越权），而且换设备就丢。
 *
 * 本模块的做法：
 * - 本地键一律加用户命名空间（`msg_ai_prompt::u3`）→ 同机切号彻底隔离；
 * - 值同时存云端 `user_settings`（按 user_id 隔离）→ 换设备能拉回来；
 * - 部署前遗留的无命名空间旧键做一次性迁移：搬给第一个登录的用户后立即删除，
 *   避免后续别的账号继承。
 */

const SETTINGS_EV = 'user-settings-updated';

const getSbase = () => {
  let s = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
  try { if (s && (/localhost|127\.0\.0\.1/i.test(s) || /api\.adpos\.io/i.test(s))) s = ''; } catch { }
  return s;
};

/** 当前登录用户 id（从 auth_token 的 `id:email:role` 结构解出）；未登录返回 '' */
export function currentUserId(): string {
  try {
    const t = localStorage.getItem('auth_token') || '';
    if (!t) return '';
    const parts = atob(t).split(':');
    return String(parts[0] || '');
  } catch { return ''; }
}

/**
 * 按用户命名空间的本地键。
 * 未登录时用 `::uanon` 而不是原键名 —— 否则登录前写入会落到**无命名空间的全局键**上，
 * 就又变成「谁都能读到」的那个坑了。
 */
export function userLocalKey(key: string): string {
  return `${key}::u${currentUserId() || 'anon'}`;
}

const _ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { } },
  del(k: string) { try { localStorage.removeItem(k); } catch { } },
};

/** 同步读本用户的值（不做迁移；迁移在 pullUserSettings 里统一处理） */
export function readUserSetting(key: string): string | null {
  return _ls.get(userLocalKey(key));
}

// 记录各键最近一次本地写入时间：拉取云端回来的值是「启动那一刻的快照」，
// 若期间用户已经本地写过（例如刚发了消息），不能用快照把它盖回去。
const _writeAt: Record<string, number> = {};

/** 同步写本用户的值（云端同步由 pushUserSetting 负责，调用方自行决定是否推送） */
export function writeUserSetting(key: string, value: string): void {
  _writeAt[key] = Date.now();
  _ls.set(userLocalKey(key), value);
}

export function removeUserSetting(key: string): void {
  _ls.del(userLocalKey(key));
}

async function pushUserSettings(items: Array<{ key: string; value: string }>): Promise<boolean> {
  const token = localStorage.getItem('auth_token') || '';
  if (!token || !items.length) return false;
  try {
    const resp = await fetch(`${getSbase()}/api/settings/bulk-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items }),
    });
    const j = await resp.json().catch(() => ({}));
    return !!(j && j.success);
  } catch { return false; }
}

/** 后台推送单键（失败只告警，不影响本地） */
export async function pushUserSetting(key: string, value: string): Promise<boolean> {
  return pushUserSettings([{ key, value }]);
}

/**
 * 启动/登录后调用：把云端设置拉到本地命名空间；云端没有则把本地值（或旧全局键）推上去。
 * @param keys 需要同步的键名（不带用户后缀）
 */
export async function pullUserSettings(keys: string[]): Promise<boolean> {
  const uid = currentUserId();
  const token = localStorage.getItem('auth_token') || '';
  if (!uid || !token || !keys.length) return false;

  const startedAt = Date.now();
  let cloud = {};
  try {
    const qs = `?keys=${encodeURIComponent(keys.join(','))}`;
    const resp = await fetch(`${getSbase()}/api/settings${qs}`, {
      headers: { 'Cache-Control': 'no-cache', Authorization: `Bearer ${token}` },
    });
    const j = await resp.json();
    if (!j || !j.success) return false;
    cloud = j.data || {};
  } catch { return false; }

  const toPush: Array<{ key: string; value: string }> = [];
  for (const key of keys) {
    const nk = `${key}::u${uid}`;
    const cv = cloud[key];
    if (cv !== undefined && cv !== null && String(cv) !== '') {
      // 云端为准；但拉取期间用户已本地改过 → 保留本地（稍后会自己推上去）
      if ((_writeAt[key] || 0) > startedAt) continue;
      _ls.set(nk, String(cv));
    } else {
      // 云端没有：本地命名空间值优先，其次才是部署前遗留的全局键
      const local = _ls.get(nk);
      if (local !== null && local !== '') {
        toPush.push({ key, value: local });
      } else {
        const legacy = _ls.get(key);
        if (legacy !== null && legacy !== '') {
          _ls.set(nk, legacy);
          toPush.push({ key, value: legacy });
        }
      }
      // 旧全局键一律清掉：否则下一个登录的账号会把上一个人的数据迁成自己的
      _ls.del(key);
    }
  }
  if (toPush.length) await pushUserSettings(toPush);
  try { window.dispatchEvent(new CustomEvent(SETTINGS_EV, { detail: { keys } })); } catch { }
  return true;
}

/** 订阅设置更新（拉取完成后通知 UI 重新读取） */
export function subscribeUserSettings(fn: () => void): () => void {
  const h = () => { try { fn(); } catch { } };
  try { window.addEventListener(SETTINGS_EV, h); } catch { }
  return () => { try { window.removeEventListener(SETTINGS_EV, h); } catch { } };
}

/** 需要云端同步的键名清单（集中登记，App 启动时统一拉取） */
export const SYNCED_SETTING_KEYS = [
  'msg_ai_prompt',        // AI 自动回复提示词
  'fb_msg_sent_cache_v1', // 已发送消息缓存
  'aiwatch.pages.v1',     // AI 值守队列：主页级
  'aiwatch.entries.v1',   // AI 值守队列：对话级
];
