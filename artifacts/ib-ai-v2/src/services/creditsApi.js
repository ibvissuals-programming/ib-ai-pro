const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * Fetch the current credit status for a user.
 *
 * @param {string} username
 * @returns {Promise<{
 *   username: string,
 *   plan: 'free'|'pro'|'max',
 *   dailyCreditsUsed: number,
 *   dailyLimit: number|null,
 *   creditsRemaining: number|null,
 *   lastResetDate: string
 * }>}
 */
export async function fetchCredits(username) {
  if (!username) throw new Error('Username required');

  const res = await fetch(`${BASE}/api/credits/${encodeURIComponent(username)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Credits API error ${res.status}`);
  }

  return res.json();
}

/**
 * Upgrade a user's plan.
 * NOTE: In production, this call would be preceded by payment verification
 * (Stripe webhook or similar). For now it updates the plan directly for demo.
 *
 * @param {string} username
 * @param {'free'|'pro'|'max'} plan
 */
export async function upgradePlan(username, plan) {
  const res = await fetch(`${BASE}/api/credits/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, plan }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Upgrade API error ${res.status}`);
  }

  return res.json();
}
