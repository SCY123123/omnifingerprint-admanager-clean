/**
 * OmniFingerprint API Gateway - Route Registry & Dispatcher
 *
 * Maps URL paths + HTTP methods to handler functions.
 */

/** @typedef {(ctx: { request: Request, env: any, url: URL }) => Promise<Response>} Handler */

/** @type {Map<string, Map<string, Handler>>} */
const routes = new Map();

/**
 * Register a route handler.
 * @param {string} path - URL path (e.g., '/api/auth/me')
 * @param {string|string[]} methods - HTTP method(s)
 * @param {Handler} handler
 */
export function register(path, methods, handler) {
  if (!routes.has(path)) routes.set(path, new Map());
  const methodMap = routes.get(path);
  const methodList = Array.isArray(methods) ? methods : [methods];
  for (const m of methodList) {
    methodMap.set(m.toUpperCase(), handler);
  }
}

/**
 * Register multiple routes at once.
 * @param {Array<{ path: string, methods: string|string[], handler: Handler }>} routeDefs
 */
export function registerAll(routeDefs) {
  for (const def of routeDefs) {
    register(def.path, def.methods, def.handler);
  }
}

/**
 * Dispatch an incoming request to the matching handler.
 * @param {string} pathname
 * @param {string} method
 * @param {{ request: Request, env: any, url: URL }} ctx
 * @returns {Promise<Response | null>} null if no route matched
 */
export async function dispatch(pathname, method, ctx) {
  // 1. Exact match
  const methodMap = routes.get(pathname);
  if (methodMap) {
    const handler = methodMap.get(method);
    if (handler) return handler(ctx);
  }

  // 2. Prefix match (/api/profiles/123 -> /api/profiles/:id)
  // Scan all registered paths for prefix patterns
  for (const [pattern, methodMap] of routes) {
    if (pattern.includes(':id') || pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/:id/g, '([^/]+)').replace(/\*/g, '.*') + '$'
      );
      const match = pathname.match(regex);
      if (match) {
        const handler = methodMap.get(method);
        if (handler) return handler(ctx);
      }
    }
  }

  return null; // No match
}

/**
 * Check if a pathname starts with a given prefix.
 * Used by legacy handlers to find their route.
 * @param {string} pathname
 * @param {string} prefix
 * @returns {boolean}
 */
export function pathStartsWith(pathname, prefix) {
  return pathname.startsWith(prefix);
}

/**
 * Check if a pathname contains a substring.
 * Used by legacy handlers.
 * @param {string} pathname
 * @param {string} substr
 * @returns {boolean}
 */
export function pathIncludes(pathname, substr) {
  return pathname.includes(substr);
}
