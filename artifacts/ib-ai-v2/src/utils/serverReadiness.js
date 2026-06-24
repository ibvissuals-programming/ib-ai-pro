/**
 * serverReadiness.js — IB AI Assistant
 *
 * Polls /api/system/ready to determine whether the backend is fully up.
 * This endpoint returns real readiness state (DB connected, auth loaded,
 * phase=COMPLETE) — unlike /api/auth/health which always returns { ready: true }.
 *
 * Used for the "server starting" advisory banner on the login page.
 *
 * IMPORTANT: This must NEVER block or gate authentication.
 * Login/signup/recovery attempts work immediately without waiting for this.
 * The login button is NEVER disabled by this check.
 *
 * Endpoint: GET /api/system/ready
 *   Returns { ready: boolean, booting: boolean, phase: string, services: {...} }
 *   ready === true only when phase === "COMPLETE" and all core services are up.
 *
 * Public API:
 *   checkServerHealth() → Promise<{ ready: boolean, timestamp?: number }>
 */

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

const READY_URL        = `${BASE}/api/system/ready`;
const REQUEST_TIMEOUT  = 4_000;

/**
 * Single readiness check — never throws.
 *
 * Returns { ready: true } when the backend reports phase=COMPLETE and all
 * core services are up.
 * Returns { ready: false } on any network error, timeout, bad response, or
 * when the backend is still booting.
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
      res = await fetch(READY_URL, {
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
