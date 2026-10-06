/**
 * OmniFingerprint API Gateway - Shared Utilities
 * 
 * CORS headers, auth parsing, and response helpers shared across route handlers.
 */

/** Standard CORS headers for all API responses */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Secret',
};

/**
 * Parse the Authorization header to extract userId and role.
 * @param {Request} request
 * @returns {{ uid: string, role: string } | null}
 */
export function parseAuth(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  try {
    const tokenData = atob(authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);
    const parts = tokenData.split(':');
    return { uid: parts[0] || '0', role: parts[2] || 'user' };
  } catch {
    return null;
  }
}

/**
 * JSON success response.
 * @param {any} data
 * @param {number} [status=200]
 * @returns {Response}
 */
export function jsonOk(data, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * JSON response with pagination.
 * @param {any[]} results
 * @param {{ page: number, pageSize: number, total: number, totalPages: number }} pagination
 * @returns {Response}
 */
export function jsonPaginated(results, pagination) {
  return new Response(
    JSON.stringify({ success: true, data: results, pagination }, (k, v) =>
      typeof v === 'bigint' ? Number(v) : v
    ),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

/**
 * JSON error response.
 * @param {string} message
 * @param {number} [status=400]
 * @param {string} [step]
 * @param {string} [stack]
 * @returns {Response}
 */
export function jsonError(message, status = 400, step, stack) {
  const body = { success: false, message };
  if (step) body.step = step;
  if (stack) body.stack = stack;
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * JSON message response (for create/update/delete operations).
 * @param {string} message
 * @param {number} [status=200]
 * @returns {Response}
 */
export function jsonMessage(message, status = 200) {
  return new Response(JSON.stringify({ success: true, message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Handle OPTIONS preflight request. Return null if not OPTIONS.
 * @param {Request} request
 * @returns {Response | null}
 */
export function handleOptions(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  return null;
}

/**
 * JSON replacer for BigInt serialization.
 */
export function bigintReplacer(key, value) {
  return typeof value === 'bigint' ? Number(value) : value;
}
