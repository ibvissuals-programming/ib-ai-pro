/**
 * serverReadiness.js — IB AI Assistant
 *
 * Polls /api/auth/health before any auth request to confirm the backend
 * is fully up. Prevents login/signup from firing into a cold-starting
 * server and getting empty-response errors misread as auth failures.
 *
 * Public API:
 *   checkServerHealth()            → Promise<{ ready: boolean, timestamp?: number }>
 *   waitForServerReady(onProgress) → Promise<boolean>  (true = ready, false = timed out)
 *
 * Constants (exported for UI use):
 *   HEALTH_POLL_INTERVAL_MS  — delay between poll attempts (2 500 ms)
 *   HEALTH_MAX_ATTEMPTS      — max polls before giving up   (6 → 15 s total)
 */

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

const HEALTH_URL          = `${BASE}/api/auth/health`;
const HEALTH_TIMEOUT_MS   = 4_000;

export const HEALTH_POLL_INTERVAL_MS = 2_500;
export const HEALTH_MAX_ATTEMPTS     = 6;        // 6 × 2.5 s = 15 s max wait

/**
 * Single health check — never throws.
 *
 * Returns { ready: true, timestamp } when the backend confirmed it is up.
 * Returns { ready: false } on any error (network, timeout, bad JSON, wrong status).
 */
export async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(HEALTH_URL, { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return { ready: false };

    const text = await res.text().catch(() => '');
    if (!text || !text.trim()) return { ready: false };

    let data;
    try { data = JSON.parse(text); }
    catch { return { ready: false }; }

    return { ready: data?.ready === true, timestamp: data?.timestamp ?? null };
  } catch {
    return { ready: false };
  }
}

/**
 * Poll /api/auth/health until the server is ready or max attempts are reached.
 *
 * @param {(attempt: number, max: number) => void} [onProgress]
 *   Called before each retry (not on the first attempt) so the UI can
 *   show a connecting indicator.
 * @param {number} [maxAttempts]
 * @returns {Promise<boolean>}  true = server is ready, false = timed out
 */
export async function waitForServerReady(onProgress, maxAttempts = HEALTH_MAX_ATTEMPTS) {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) onProgress?.(i, maxAttempts);

    const result = await checkServerHealth();
    if (result.ready) return true;

    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }
  }
  return false;
}
