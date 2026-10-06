// @ts-nocheck
/**
 * AI 自动回复素材库（云端为准，按 user_id 隔离 + 本地 IndexedDB 缓存）
 *
 * 以前这里是「本机 IndexedDB 全局共享」——同一台机器换个账号登录就能看到、
 * 并让 AI 附带上一个账号的素材。现在：
 * - 云端 `ai_assets` 表按 user_id 隔离，是数据的唯一真相；
 * - 本地 IndexedDB 只做缓存（库名带用户后缀），离线/网络失败时兜底；
 * - 超过云端单次请求上限的大文件（MariaDB max_allowed_packet 16MB）只留本机，
 *   标记 `localOnly` 并在界面上提示。
 */

import { currentUserId } from './userSettings';

export interface MediaAsset {
  id: string;        // m_<ts>_<rand>
  name: string;      // 文件名（去扩展名）
  kind: 'image' | 'video';
  mimeType: string;
  desc: string;      // 用途/内容描述（供 AI 判断）
  base64: string;    // dataURL 原始内容
  size: number;      // 字节
  createdAt: number;
  /** 体积超过云端同步上限 → 只存本机，别的设备看不到 */
  localOnly?: boolean;
}

// ⚠️ MariaDB max_allowed_packet = 16MB，base64 会膨胀约 1.37 倍，所以原始大小卡 8MB
const CLOUD_MAX_BYTES = 8 * 1024 * 1024;

const getSbase = () => {
  let s = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
  try { if (s && (/localhost|127\.0\.0\.1/i.test(s) || /api\.adpos\.io/i.test(s))) s = ''; } catch { }
  return s;
};
const _authToken = () => { try { return localStorage.getItem('auth_token') || ''; } catch { return ''; } };

// 库名按用户区分：同机切号后互不可见
const dbName = () => `aiReplyMedia::u${currentUserId() || 'anon'}`;
const STORE = 'assets';

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  try {
    const req = indexedDB.open(dbName(), 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  } catch (e) { reject(e); }
});

// 简单的跨模块订阅：上传/删除后通知 AIQ 下一轮重新读取
type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => { listeners.forEach(l => { try { l(); } catch { } }); };
export function subscribeMedia(fn: Listener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

// ---------- 本地缓存读写 ----------
async function readLocal(): Promise<MediaAsset[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch { return []; }
}

async function writeLocal(asset: MediaAsset): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(asset);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteLocal(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 用云端列表整体覆盖本地缓存 */
async function replaceLocal(list: MediaAsset[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      for (const a of list) store.put(a);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { }
}

// ---------- 一次性迁移：部署前那个「全局共享」的老库 ----------
// 老库名不带用户后缀，里面混着所有账号的素材，无法分辨归属 —— 与 localStorage 的迁移一致：
// 搬给第一个登录的用户，搬完立刻删掉老库，避免后续别的账号继承。
const LEGACY_DB = 'aiReplyMedia';
const MIGRATED_FLAG = 'ai_media_migrated_v1';

const _lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const _lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { } };

async function migrateLegacyOnce(): Promise<void> {
  try {
    if (_lsGet(MIGRATED_FLAG)) return;
    if (!currentUserId()) return; // 还没登录先不动
    let created = false;
    const legacy = await new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(LEGACY_DB); // 不带版本号：库不存在时会新建（onupgradeneeded 触发）
        req.onupgradeneeded = () => { created = true; };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    if (!legacy) return;
    if (created) {
      try { legacy.close(); } catch { }
      try { indexedDB.deleteDatabase(LEGACY_DB); } catch { }
      _lsSet(MIGRATED_FLAG, '1');
      return;
    }
    const old = await new Promise<MediaAsset[]>((resolve) => {
      try {
        if (!legacy.objectStoreNames.contains(STORE)) return resolve([]);
        const tx = legacy.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
    try { legacy.close(); } catch { }
    for (const a of old) {
      if (!a || !a.id) continue;
      try { await writeLocal(a); } catch { }
      try { await pushCloud([a]); } catch { }
    }
    try { indexedDB.deleteDatabase(LEGACY_DB); } catch { }
    _lsSet(MIGRATED_FLAG, '1');
    if (old.length) emit();
  } catch { }
}

// ---------- 云端交互 ----------
/** 拉取云端素材；失败返回 null（调用方回退本地缓存） */
async function fetchCloud(): Promise<MediaAsset[] | null> {
  const token = _authToken();
  if (!token) return null;
  try {
    const resp = await fetch(`${getSbase()}/api/ai-assets?_t=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache', Authorization: `Bearer ${token}` },
    });
    const j = await resp.json();
    if (!j || !j.success || !Array.isArray(j.data)) return null;
    return j.data;
  } catch { return null; }
}

/** 按 id 推送/删除云端；返回是否成功 */
async function pushCloud(items: MediaAsset[]): Promise<boolean> {
  const token = _authToken();
  if (!token || !items.length) return false;
  try {
    const resp = await fetch(`${getSbase()}/api/ai-assets/bulk-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items }),
    });
    const j = await resp.json().catch(() => ({}));
    return !!(j && j.success);
  } catch { return false; }
}

async function deleteCloud(ids: string[]): Promise<void> {
  const token = _authToken();
  if (!token || !ids.length) return;
  try {
    await fetch(`${getSbase()}/api/ai-assets/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids }),
    });
  } catch { }
}

/**
 * 读素材清单：云端为准，成功后回写本地缓存；云端不可用则退回本地缓存。
 * 本地缓存里 `localOnly` 的超大素材会一并合进来（云端没有它们）。
 */
export async function getAllMedia(): Promise<MediaAsset[]> {
  await migrateLegacyOnce();
  const local = await readLocal();
  const cloud = await fetchCloud();
  if (cloud === null) {
    return local.sort((a, b) => b.createdAt - a.createdAt);
  }
  const localOnly = local.filter(a => a.localOnly);
  await replaceLocal(cloud);
  // 本机专属素材重新写回缓存（replaceLocal 把它们清掉了）
  for (const a of localOnly) { try { await writeLocal(a); } catch { } }
  return [...cloud, ...localOnly].sort((a, b) => b.createdAt - a.createdAt);
}

export async function addMedia(asset: MediaAsset): Promise<void> {
  const tooBig = Number(asset.size || 0) > CLOUD_MAX_BYTES;
  const rec: MediaAsset = tooBig ? { ...asset, localOnly: true } : { ...asset, localOnly: false };
  try { await writeLocal(rec); emit(); } catch { }
  if (tooBig) return; // 超限只留本机
  const ok = await pushCloud([rec]);
  // 推送失败（网络/体积）→ 标记本机专属，避免用户以为已经同步
  if (!ok) {
    try { await writeLocal({ ...rec, localOnly: true }); emit(); } catch { }
  }
}

export async function removeMedia(id: string): Promise<void> {
  const local = await readLocal();
  const target = local.find(a => a.id === id);
  try { await deleteLocal(id); emit(); } catch { }
  if (target && !target.localOnly) await deleteCloud([id]);
}

export async function removeAllMedia(): Promise<void> {
  const local = await readLocal();
  const ids = local.filter(a => !a.localOnly).map(a => a.id);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    emit();
  } catch { }
  await deleteCloud(ids);
}

/** 供 AI 队列生成时的素材清单文本（只给描述/名字，不给体积内容，避免撑爆上下文） */
export async function buildMediaPrompt(): Promise<string> {
  const list = await getAllMedia();
  if (!list.length) return '';
  const lines = list.map((m, i) =>
    `- ${i + 1}. id=${m.id}（${m.kind === 'image' ? '图片' : '视频'}，文件名「${m.name}」）用途描述：${m.desc || '（未填写）'}`
  );
  return [
    '',
    '你有一个可发送给客户的媒体素材库（无需你提供文件内容）：',
    ...lines,
    '规则：',
    '- 若客户正在向主页方索要图片/视频/实物照片/资料文件（例如“发一下你们的产品图/价格表/实拍视频”），应选择最合适的一份媒体随回复一同发送；',
    '- 需要附带媒体时，在你的回复正文之后单独另起一行输出 `[MEDIA:<id>]`，且只能输出一次、只选一份；',
    '- 客户没有索要媒体、或索要内容在素材库中找不到对应项时，不要输出 `[MEDIA:...]`。',
  ].join('\n');
}
