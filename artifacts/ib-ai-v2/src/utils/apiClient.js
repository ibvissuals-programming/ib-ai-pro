/**
 * Shared API client utilities — IB AI Assistant.
 *
 * Error taxonomy — three strictly separated categories:
 *
 *   ABORT         AbortError — request was cancelled or our timeout fired.
 *                 → "Request cancelled"
 *                 Never retry — the timeout will fire again immediately.
 *
 *   NETWORK_ERROR fetch() threw TypeError — DNS failure, connection refused,
 *                 network offline, CORS block.  No response object exists.
 *                 → "Cannot reach server..."
 *                 May retry once on genuine transient failures.
 *
 *   HTTP_ERROR    Response exists with 4xx/5xx status.
 *                 HTTP status ALWAYS takes priority over body parsing.
 *                 → status-specific message (classifyHttpError)
 *
 *   PARSE_ERROR   Response exists but body was empty or non-JSON.
 *                 NEVER treated as a network error — the server was reachable.
 *                 safeJson() returns {} and the caller handles via classifyHttpError.
 *
 * CRITICAL RULE: "Cannot reach server" must ONLY appear when fetch() throws
 * and no response object exists.  It must NEVER be used when:
 *   - a status code exists (use classifyHttpError instead)
 *   - JSON parsing fails (safeJson → {} → classifyHttpError handles it)
 *
 * Timeout constants (ms):
 *   AUTH_TIMEOUT_MS    = 15 000   login, signup, session checks
 *   API_TIMEOUT_MS     = 30 000   credits, general API calls
 *   IMAGE_ANALYZE_MS   = 60 000   image analysis pipeline
 *   IMAGE_GEN_MS       = 120 000  image generation / editing
 *
 * NOTE: IMAGE_GEN_MS must remain > backend PIPELINE_TIMEOUT_MS (90 s).
 */

export const AUTH_TIMEOUT_MS  = 15_000;
export const API_TIMEOUT_MS   = 30_000;
export const IMAGE_ANALYZE_MS = 60_000;
export const IMAGE_GEN_MS     = 120_000;

// ── Internal debug log ────────────────────────────────────────────────────────
// Called by classifyFetchError and classifyHttpError so every classified error
// emits a consistent structured entry in the browser console.

function _apiDebugLog(errorType, status) {
  console.log('[API DEBUG]', { layer: 'global', status: status ?? null, errorType });
}

// ── Safe JSON parse ───────────────────────────────────────────────────────────

/**
 * Safely parse a Response as JSON without throwing.
 *
 * Returns {} on ANY body-read or parse failure.
 *
 * IMPORTANT: a response object means the server was reachable.
 * This function NEVER returns a "Cannot reach server" string — that message
 * belongs exclusively to classifyFetchError (when fetch() itself throws).
 * Callers must use classifyHttpError(res, data) for error messages.
 *
 * @param {Response} res
 * @returns {Promise<object>}
 */
export async function safeJson(res) {
  let text;
  try {
    text = await res.text();
  } catch {
    return {};
  }

  if (!text || !text.trim()) return {};

  const ct = res.headers?.get?.('content-type') ?? '';
  if (ct && !ct.includes('application/json') && !ct.includes('text/plain')) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

/**
 * fetch() wrapped with an AbortController timeout.
 *
 * Throws AbortError if the timeout fires before the response arrives.
 * All other fetch errors propagate as-is.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Error classifiers ─────────────────────────────────────────────────────────

/**
 * Classify a thrown fetch error into a human-readable message.
 *
 * ONLY call this from a catch block where fetch() itself threw — i.e. where
 * NO response object was ever created.  If a response exists, use
 * classifyHttpError() instead; calling this function with a response in scope
 * is a bug (it would map a reachable-server error to "Cannot reach server").
 *
 *   AbortError   → "Request cancelled"          (timeout or external abort)
 *   TypeError    → "Cannot reach server..."     (no network path to server)
 *   SyntaxError  → "Invalid server response..." (malformed response pre-body)
 *   other        → err.message or generic fallback
 *
 * @param {unknown} err
 * @returns {string}
 */
export function classifyFetchError(err) {
  if (!err) {
    _apiDebugLog('NETWORK_ERROR', null);
    return 'Network error — please try again';
  }

  // AbortError: our timeout fired or an external signal cancelled the request.
  // NOT a network failure — do not retry, do not say "Cannot reach server".
  if (err.name === 'AbortError') {
    _apiDebugLog('ABORT', null);
    return 'Request cancelled';
  }

  if (err instanceof SyntaxError || err.name === 'SyntaxError') {
    _apiDebugLog('PARSE_ERROR', null);
    return 'Invalid server response — please try again';
  }

  // TypeError: fetch() threw before any response was received.
  // This is the ONLY case that maps to "Cannot reach server".
  if (
    err.name === 'TypeError' ||
    (typeof err.message === 'string' &&
      (err.message.includes('fetch') ||
       err.message.includes('Failed') ||
       err.message.includes('NetworkError') ||
       err.message.includes('Load failed')))
  ) {
    _apiDebugLog('NETWORK_ERROR', null);
    return 'Cannot reach server — please check your connection or try again';
  }

  _apiDebugLog('NETWORK_ERROR', null);
  return err.message || 'Network error — please try again';
}

/**
 * Classify an HTTP error response (response EXISTS, res.ok === false).
 *
 * HTTP status ALWAYS takes priority over body content.
 * Parsing errors (safeJson returned {}) are handled via the status fallback.
 *
 * CRITICAL: Call this whenever res.ok is false and a response object exists.
 * Never fall through to classifyFetchError when a response exists.
 *
 *   401 → Authentication required
 *   429 → Too many requests
 *   5xx → Server error (uses body error if present)
 *   4xx → body error or generic HTTP error
 *
 * @param {Response} res  - the Response object (must exist, res.ok === false)
 * @param {object}   data - parsed body from safeJson (may be {})
 * @returns {string}
 */
export function classifyHttpError(res, data) {
  const status = res.status;
  _apiDebugLog('HTTP_ERROR', status);
  if (status === 401) return data?.error || 'Authentication required — please log in again';
  if (status === 429) return 'Too many requests — please wait a moment and try again';
  if (status >= 500)  return data?.error || 'Server error — please try again';
  return data?.error || `Request failed (${status})`;
}
