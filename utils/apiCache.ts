// 前端 API 缓存工具 - 自动管理 TTL、版本号和预加载

interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number // ms
}

const CACHE_PREFIX = 'apiCache:'
const DEFAULT_TTL = 5 * 60 * 1000 // 5 分钟

// 🚀 读取缓存
export function getCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const entry: CacheEntry<T> = JSON.parse(raw)
    if (Date.now() - entry.timestamp > entry.ttl) {
      localStorage.removeItem(CACHE_PREFIX + key)
      return null
    }
    return entry.data
  } catch {
    return null
  }
}

// 🚀 写入缓存
export function setCache<T>(key: string, data: T, ttl = DEFAULT_TTL): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now(), ttl }
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry))
  } catch {
    // localStorage 满时静默失败
  }
}

// 🚀 清除缓存
export function clearCache(key?: string): void {
  if (key) {
    localStorage.removeItem(CACHE_PREFIX + key)
  } else {
    Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k))
  }
}

// 🚀 缓存优先的 fetch（先返回缓存，后台刷新）
export async function fetchWithCache<T>(
  url: string,
  cacheKey: string,
  options?: RequestInit,
  ttl = DEFAULT_TTL,
  onData?: (data: T) => void // 首次加载回调
): Promise<{ data: T; fromCache: boolean }> {
  // 1. 先尝试缓存
  const cached = getCache<T>(cacheKey)
  if (cached !== null) {
    // 后台异步刷新
    refreshCache(url, cacheKey, options, ttl)
    return { data: cached, fromCache: true }
  }

  // 2. 无缓存，直接拉取
  const resp = await fetch(url, options)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const json = await resp.json()
  const data = (json?.success && Array.isArray(json?.data)) ? json.data : json

  setCache(cacheKey, data, ttl)
  onData?.(data as T)
  return { data: data as T, fromCache: false }
}

// 🚀 后台刷新缓存（静默）
async function refreshCache(url: string, cacheKey: string, options?: RequestInit, ttl = DEFAULT_TTL): Promise<void> {
  try {
    const resp = await fetch(url, options)
    if (!resp.ok) return
    const json = await resp.json()
    const data = (json?.success && Array.isArray(json?.data)) ? json.data : json
    setCache(cacheKey, data, ttl)
  } catch {
    // 静默失败，保留旧缓存
  }
}
