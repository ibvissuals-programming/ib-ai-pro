/**
 * Auth service — IB AI Assistant.
 *
 * Replaces localStorage-only auth with server-side API calls.
 * JWT token stored in localStorage under IB_TOKEN_KEY.
 *
 * Public API (unchanged interface for useAuth.js compatibility):
 *   signup(username, password) → { success, error? }
 *   login(username, password)  → { success, error?, recoveryLogin? }
 *   recoveryLogin(username, key) → { success, error?, recoveryLogin? }
 *   changePassword(newPassword) → { success, error? }
 *   logout()
 *   getCurrentUser()           → { id, username, role, credits } | null
 *   isAuthenticated()          → boolean
 *   getToken()                 → string | null
 *   getAuthHeaders()           → { Authorization: 'Bearer ...' } | {}
 *
 * Flow:
 *   Auth functions attempt immediately — no health pre-check, no polling.
 *   A single retry is performed only on genuine network-level failures
 *   (fetch throws: AbortError, TypeError). Hard server responses (400/401/409)
 *   are never retried.
 */

import { fetchWithTimeout, AUTH_TIMEOUT_MS } from '../utils/apiClient';

const IB_TOKEN_KEY = 'ib_token';
const IB_USER_KEY = 'ib_cached_user';

const RETRY_DELAY_MS = 800;

const BASE = (() => {
  try {
    return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, '');
  } catch {
    return '';
  }
})();

// ── Token storage ─────────────────────────────────────────────────────────────

export function getToken() {
  try { return localStorage.getItem(IB_TOKEN_KEY); }
  catch { return null; }
}

function saveToken(token) {
  try { localStorage.setItem(IB_TOKEN_KEY, token); }
  catch { /* ignore */ }
}

export function clearToken() {
  try {
    localStorage.removeItem(IB_TOKEN_KEY);
    localStorage.removeItem(IB_USER_KEY);
  } catch { /* ignore */ }
}

function saveUser(user) {
  try { localStorage.setItem(IB_USER_KEY, JSON.stringify(user)); }
  catch { /* ignore */ }
}

function loadCachedUser() {
  try { return JSON.parse(localStorage.getItem(IB_USER_KEY)) || null; }
  catch { return null; }
}

// ── Auth headers ──────────────────────────────────────────────────────────────

export function getAuthHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Safe JSON parsing ─────────────────────────────────────────────────────────

async function safeParseJson(res) {
  let text;
  try {
    text = await res.text();
  } catch {
    return { error: 'Cannot reach server — please try again' };
  }

  if (!text || !text.trim()) {
    // Empty body — proxy error, cold start, or connection refused
    return { error: 'Cannot reach server — please try again' };
  }

  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON body (e.g. HTML proxy error page)
    return { error: 'Cannot reach server — please try again' };
  }
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function post(path, body, extraHeaders) {
  return fetchWithTimeout(
    `${BASE}/api${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    },
    AUTH_TIMEOUT_MS,
  );
}

function fetchErrorMessage(err) {
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

/** True for errors where a single retry is warranted (network-level only). */
function isNetworkError(err) {
  return (
    err?.name === 'AbortError' ||
    err?.name === 'TypeError' ||
    (typeof err?.message === 'string' &&
      (err.message.includes('fetch') ||
       err.message.includes('Failed') ||
       err.message.includes('NetworkError') ||
       err.message.includes('Load failed')))
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * signup() — create a new account.
 *
 * Attempts immediately. One retry on network-level failure only.
 * Hard server errors (400/409) are returned immediately without retry.
 */
export async function signup(username, password) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res, data;
    try {
      res  = await post('/auth/register', { username, password });
      data = await safeParseJson(res);
    } catch (err) {
      if (attempt === 1 && isNetworkError(err)) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { success: false, error: fetchErrorMessage(err) };
    }

    if (!res.ok) {
      // Hard validation / conflict — never retry
      if (res.status === 400 || res.status === 409) {
        return { success: false, error: data.error || 'Registration failed' };
      }
      return { success: false, error: data.error || 'Server error — please try again' };
    }

    if (!data.token || !data.user) {
      return { success: false, error: data.error || 'Unexpected server response — please try again' };
    }

    saveToken(data.token);
    saveUser(data.user);
    return { success: true, user: data.user };
  }

  return { success: false, error: 'Cannot reach server — please try again' };
}

/**
 * login() — authenticate with username + password.
 *
 * Attempts immediately. One retry on network-level failure only.
 * Hard auth failures (401/400) are returned immediately without retry.
 */
export async function login(username, password) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res, data;
    try {
      res  = await post('/auth/login', { username, password });
      data = await safeParseJson(res);
    } catch (err) {
      if (attempt === 1 && isNetworkError(err)) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { success: false, error: fetchErrorMessage(err) };
    }

    if (!res.ok) {
      // Hard auth failure — never retry
      if (res.status === 401 || res.status === 400) {
        return { success: false, error: data.error || 'Invalid username or password' };
      }
      return { success: false, error: data.error || 'Server error — please try again' };
    }

    if (!data.token || !data.user) {
      return { success: false, error: data.error || 'Unexpected server response — please try again' };
    }

    saveToken(data.token);
    saveUser(data.user);
    return { success: true, user: data.user, recoveryLogin: data.recoveryLogin ?? false };
  }

  return { success: false, error: 'Cannot reach server — please try again' };
}

/**
 * recoveryLogin() — validate recovery inputs locally only.
 *
 * Recovery key login via the /auth/login endpoint is disabled.
 * The recovery key is ONLY used in recoveryResetPassword() which calls
 * POST /auth/reset-password directly with the key in a request header.
 *
 * This function purely validates that the caller supplied non-empty
 * username and key before showing the set-password form.  No network
 * call is made here.
 */
export function recoveryLogin(username, recoveryKey) {
  if (!username || !username.trim()) {
    return Promise.resolve({ success: false, error: 'Username is required' });
  }
  if (!recoveryKey || !recoveryKey.trim()) {
    return Promise.resolve({ success: false, error: 'Recovery key is required' });
  }
  // Return success so the Login page can show the set-password form.
  // The actual key is forwarded by recoveryResetPassword().
  return Promise.resolve({ success: true, recoveryLogin: true });
}

/**
 * recoveryResetPassword() — reset CEO password using a recovery key.
 *
 * Sends POST /api/auth/reset-password with the recovery key in the
 * x-ceo-recovery-key header and the new password in the body.
 * No session token is issued — the user must log in normally afterward.
 *
 * One retry on network-level failures only.
 */
export async function recoveryResetPassword(username, recoveryKey, newPassword) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res, data;
    try {
      res = await fetchWithTimeout(
        `${BASE}/api/auth/reset-password`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-ceo-recovery-key': recoveryKey,
          },
          body: JSON.stringify({ username, newPassword }),
        },
        AUTH_TIMEOUT_MS,
      );
      data = await safeParseJson(res);
    } catch (err) {
      if (attempt === 1 && isNetworkError(err)) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { success: false, error: fetchErrorMessage(err) };
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 400 || res.status === 503) {
        return { success: false, error: data.error || 'Recovery reset failed' };
      }
      return { success: false, error: data.error || 'Server error — please try again' };
    }

    return { success: true };
  }

  return { success: false, error: 'Cannot reach server — please try again' };
}

/**
 * changePassword() — change the current user's password.
 * Requires a valid session token (including recovery sessions).
 */
export async function changePassword(newPassword) {
  const token = getToken();
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const res = await fetchWithTimeout(
      `${BASE}/api/auth/change-password`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newPassword }),
      },
      AUTH_TIMEOUT_MS,
    );
    const data = await safeParseJson(res);
    if (!res.ok) {
      return { success: false, error: data.error || 'Password change failed' };
    }
    if (data.token) {
      saveToken(data.token);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: fetchErrorMessage(err) };
  }
}

export function logout() {
  clearToken();
}

/**
 * Returns the cached user object from localStorage.
 */
export function getCurrentUser() {
  const token = getToken();
  if (!token) return null;
  return loadCachedUser();
}

export function isAuthenticated() {
  return !!getToken() && !!loadCachedUser();
}

/**
 * checkServerReady() — lightweight readiness probe.
 *
 * Calls /api/auth/health before login/signup so the user sees
 * "Server is starting…" instead of a cryptic network error when
 * the backend is still booting.
 *
 * Returns true if the server responded with { ready: true }.
 * Returns false on timeout, network failure, or non-OK response.
 * Never throws.
 */
export async function checkServerReady() {
  try {
    const res = await fetchWithTimeout(
      `${BASE}/api/auth/health`,
      { method: 'GET' },
      4_000, // short timeout — health endpoint must be instant
    );
    if (!res.ok) return false;
    const data = await safeParseJson(res);
    return data?.ready === true;
  } catch {
    return false;
  }
}

/**
 * Verify the current token against the server and refresh the cached user.
 */
export async function verifySession() {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetchWithTimeout(
      `${BASE}/api/auth/me`,
      { headers: { Authorization: `Bearer ${token}` } },
      AUTH_TIMEOUT_MS,
    );
    if (!res.ok) {
      if (res.status === 401) {
        // Token is definitively invalid or expired — clear it
        clearToken();
        return null;
      }
      // 403, 5xx, or other errors: do NOT clear the token.
      // Return the cached user so transient server errors don't log the user out.
      return loadCachedUser();
    }
    const data = await safeParseJson(res);
    if (data.user) {
      saveUser(data.user);
      return data.user;
    }
    return loadCachedUser();
  } catch {
    return loadCachedUser();
  }
}
