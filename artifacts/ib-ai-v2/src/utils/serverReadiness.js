/**
 * serverReadiness.js — IB AI Assistant
 *
 * Informational health check utility only.
 * Used solely for the "server starting" advisory banner on the login page.
 *
 * IMPORTANT: This must NEVER block or gate authentication.
 * Login/signup/recovery attempts work immediately without calling this.
 * The login button must never be disabled due to this check.
 *
 * Public API:
 *   checkServerHealth() → Promise<{ ready: boolean, booting?: boolean, timestamp?: number }>
 *
 * Endpoint: GET /api/system/ready
 *   Returns: { ready, booting, degraded, services: { db, ai, auth }, phase, timestamp }
 *   Always responds synchronously — no DB or AI calls, guaranteed <2s.
 *
 * Fallback: If /api/system/ready is unreachable, falls back to /api/auth/health.
 * The /api/auth/health endpoint always returns ready: true once the process is up.
 */

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

const READY_URL        = `${BASE}/api/system/ready`;
const FALLBACK_URL     = `${BASE}/api/auth/health`;
const REQUEST_TIMEOUT  = 3_000;  // per-request abort timeout

/**
 * Single health check — never throws.
 *
 * Tries /api/system/ready first; falls back to /api/auth/health on any error.
 * Returns { ready: true } when the backend confirms it is available.
 * Returns { ready: false } if unreachable, timed out, or still booting.
 */
export async function checkServerHealth() {
  // ── Primary: /api/system/ready ──────────────────────────────────────────────
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

    if (!res.ok) throw new Error(`status ${res.status}`);

    const text = await res.text().catch(() => '');
    if (!text?.trim()) throw new Error('empty body');

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('invalid json'); }

    // /api/system/ready: ready=true once boot complete or degraded (degraded still usable)
    return {
      ready:     data?.ready === true,
      booting:   data?.booting === true,
      degraded:  data?.degraded === true,
      timestamp: data?.timestamp ?? null,
    };
  } catch {
    // ── Fallback: /api/auth/health ─────────────────────────────────────────────
    // Always returns { ready: true } once the process is up.
    // If this also fails, the backend process is not running yet.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      let res;
      try {
        res = await fetch(FALLBACK_URL, {
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
      try { data = JSON.parse(text); } catch { return { ready: false }; }
      return { ready: data?.ready === true, timestamp: data?.timestamp ?? null };
    } catch {
      return { ready: false };
    }
  }
}
