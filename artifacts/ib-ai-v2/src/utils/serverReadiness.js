/**
 * serverReadiness.js — IB AI Assistant
 *
 * Informational health check utility only.
 * Used solely for UI status indicators (e.g. "server online/offline" badge).
 *
 * IMPORTANT: This must NEVER block or gate authentication.
 * Login/signup/recovery attempt immediately without calling this.
 *
 * Public API:
 *   checkServerHealth() → Promise<{ ready: boolean, timestamp?: number }>
 */

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

const HEALTH_URL        = `${BASE}/api/auth/health`;
const HEALTH_TIMEOUT_MS = 4_000;

/**
 * Single health check — never throws.
 *
 * Returns { ready: true, timestamp } when the backend confirms it is up.
 * Returns { ready: false } on any error (network, timeout, bad JSON, wrong status).
 *
 * Informational use only — do NOT use to gate auth attempts.
 *
 * cache: 'no-store' prevents the browser returning a cached 304 (no body),
 * which would cause res.text() to return '' and falsely report not-ready.
 */
export async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(HEALTH_URL, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      });
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
