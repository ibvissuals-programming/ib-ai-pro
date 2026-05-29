import { getAuthHeaders } from '../auth/authService';
import { safeJson, fetchWithTimeout, API_TIMEOUT_MS } from '../utils/apiClient';

const BASE = (import.meta.env.BASE_URL ?? '').replace(/\/$/, '');

/**
 * Fetch the current credit status for the authenticated user.
 * Uses /api/auth/me (token-based) for accurate server-side data.
 *
 * Falls back to /api/credits/:username for backward compatibility
 * when username is provided and token is unavailable.
 *
 * @param {string} [username] — kept for API compat, token takes priority
 * @returns {Promise<{
 *   username: string,
 *   plan: string,
 *   creditsRemaining: number|null,
 *   dailyLimit: number|null,
 *   nextResetAt: number|null
 * }>}
 */
export async function fetchCredits(username) {
  const authHeaders = getAuthHeaders();

  if (authHeaders.Authorization) {
    const res = await fetchWithTimeout(
      `${BASE}/api/auth/me`,
      { headers: authHeaders },
      API_TIMEOUT_MS,
    );
    if (res.ok) {
      const data = await safeJson(res);
      if (!data || !data.user) throw new Error('Invalid response from server');
      const { user, credits } = data;
      return {
        username: user.username,
        plan: user.role,
        creditsRemaining: credits.remaining,
        dailyLimit: credits.limit,
        nextResetAt: credits.nextResetAt,
      };
    }
  }

  if (!username) throw new Error('Username required');

  const res = await fetchWithTimeout(
    `${BASE}/api/credits/${encodeURIComponent(username)}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    API_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(`Credits API error ${res.status}`);
  }

  const data = await safeJson(res);
  if (!data) throw new Error('Invalid response from credits API');
  return data;
}

/**
 * Upgrade a user's plan.
 *
 * @param {string} username
 * @param {'free'|'premium'|'ceo'} plan
 */
export async function upgradePlan(username, plan) {
  const res = await fetchWithTimeout(
    `${BASE}/api/credits/upgrade`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ username, plan }),
    },
    API_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await safeJson(res);
    throw new Error(body.error || `Upgrade API error ${res.status}`);
  }

  const data = await safeJson(res);
  if (!data) throw new Error('Invalid response from upgrade API');
  return data;
}
