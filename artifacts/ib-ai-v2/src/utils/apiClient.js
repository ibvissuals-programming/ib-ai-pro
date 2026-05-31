/**
 * Shared API client utilities — IB AI Assistant.
 *
 * Provides:
 *   safeJson(res)                        — Response → object, never throws
 *   fetchWithTimeout(url, opts, ms)      — fetch + AbortController timeout
 *   classifyFetchError(err)              — Error → human-readable string
 *
 * Timeout constants (ms):
 *   AUTH_TIMEOUT_MS    = 15 000   login, signup, session checks
 *   API_TIMEOUT_MS     = 30 000   credits, general API calls
 *   IMAGE_ANALYZE_MS   = 60 000   image analysis pipeline
 *   IMAGE_GEN_MS       = 120 000  image generation / editing
 *
 * NOTE: IMAGE_GEN_MS must remain > backend PIPELINE_TIMEOUT_MS (90 s).
 * The backend pipeline timer starts after auth/validation processing,
 * so with a matching 90 s client timeout the AbortError fires first and
 * the user sees a generic "timed out" message instead of the backend's
 * helpful specific error. 120 s ensures the backend always wins the race.
 */

export const AUTH_TIMEOUT_MS  = 15_000;
export const API_TIMEOUT_MS   = 30_000;
export const IMAGE_ANALYZE_MS = 60_000;
export const IMAGE_GEN_MS     = 120_000;

/**
 * Safely parse a Response as JSON without throwing.
 *
 * Reads the body as text first, validates content-type,
 * then attempts JSON.parse. Returns an empty object on any failure
 * so callers always get a plain object back.
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

/**
 * fetch() wrapped with an AbortController timeout.
 *
 * The timer is always cleared — whether fetch succeeds, fails,
 * or the timeout fires first. Throws AbortError on timeout.
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

/**
 * Classify a caught fetch / network error into a human-readable message.
 *
 * Maps:
 *   AbortError   → "Request timed out — please try again"
 *   SyntaxError  → "Invalid server response — please try again"
 *   TypeError    → "Cannot reach server — please check your connection or try again"
 *   otherwise    → err.message or generic fallback
 *
 * @param {unknown} err
 * @returns {string}
 */
export function classifyFetchError(err) {
  if (!err) return 'Network error — please try again';
  if (err.name === 'AbortError') return 'Request timed out — please try again';
  if (err instanceof SyntaxError || err.name === 'SyntaxError') {
    return 'Invalid server response — please try again';
  }
  if (
    err.name === 'TypeError' ||
    (typeof err.message === 'string' &&
      (err.message.includes('fetch') ||
       err.message.includes('Failed') ||
       err.message.includes('NetworkError') ||
       err.message.includes('Load failed')))
  ) {
    return 'Cannot reach server — please check your connection or try again';
  }
  return err.message || 'Network error — please try again';
}
