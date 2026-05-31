/**
 * serverReadiness.js — IB AI Assistant
 *
 * Informational health check utility only.
 * Used solely for the "server starting" advisory banner on the login page.
 *
 * IMPORTANT: This must NEVER block or gate authentication.
 * Login/signup/recovery attempts work immediately without waiting for this.
 * The login button is NEVER disabled by this check.
 *
 * Endpoint: GET /api/auth/health
 *   Always returns { ready: true, status: "ok" } the moment the backend
 *   process is up. No DB calls, no AI calls, never hangs.
 *
 * Public API:
 *   checkServerHealth() → Promise<{ ready: boolean, timestamp?: number }>
 */

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

const HEALTH_URL       = `${BASE}/api/auth/health`;
const REQUEST_TIMEOUT  = 4_000;

/**
 * Single health check — never throws.
 *
 * Returns { ready: true } when the backend process is up and responding.
 * Returns { ready: false } on any network error, timeout, or bad response.
 *
 * Informational use only — do NOT use to gate auth attempts.
 *
 * cache: 'no-store' prevents the browser returning a cached 304 (no body),
 * which would cause res.text() to return '' and falsely report not-ready.
 */
export async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    let res;
    try {
      res = await fetch(HEALTH_URL, {
        method:  'GET',
        signal:  controller.signal,
        cache:   'no-store',
        headers: { 'Accept': 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return { ready: false };

    const text = await res.text().catch(() => '');
    if (!text?.trim()) return { ready: false };

    let data;
    try { data = JSON.parse(text); }
    catch { return { ready: false }; }

    return { ready: data?.ready === true, timestamp: data?.timestamp ?? null };
  } catch {
    return { ready: false };
  }
}
