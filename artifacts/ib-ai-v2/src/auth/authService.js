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
//
// IMPORTANT: safeParseJson() receives a Response that already exists.
// It must NEVER return a "Cannot reach server" message — a response was
// received, so the server WAS reachable.  The caller is responsible for
// mapping HTTP status codes to user-facing error messages.
// An empty object {} is returned on any body-read or parse failure so the
// caller's own status-based fallback (e.g. 'Invalid username or password')
// fires correctly.

async function safeParseJson(res) {
  let text;
  try {
    text = await res.text();
  } catch {
    // Body read failed — return empty object; caller decides message from res.status
    return {};
  }

  if (!text || !text.trim()) {
    // Empty body — return empty object; caller decides message from res.status
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON body (e.g. HTML proxy error page) — return empty object
    return {};
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

// ── Error classification ───────────────────────────────────────────────────────
//
// Three strictly separate cases:
//
//   AbortError  — request was cancelled (timeout or external abort signal)
//                 → "Request cancelled"  — never retry
//
//   TypeError   — fetch() threw before any response arrived (DNS failure,
//                 connection refused, network offline, CORS block)
//                 → "Cannot reach server"  — retry once
//
//   response exists (4xx / 5xx) — server was reachable; show its error
//                 → caller maps status → message; NEVER reaches this function

function fetchErrorMessage(err) {
  if (!err) return 'Network error — please try again';
  // AbortError: request was cancelled (our own timeout or an external signal).
  // Not a network failure — the connection reached the server or was cut.
  if (err.name === 'AbortError') return 'Request cancelled';
  if (err instanceof SyntaxError || err.name === 'SyntaxError') {
    return 'Invalid server response — please try again';
  }
  // TypeError: fetch() threw — no response object was ever created.
  // This is the ONLY case that maps to "Cannot reach server".
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

/**
 * True only for genuine network-level failures where a single retry is warranted.
 *
 * AbortError is intentionally EXCLUDED — it means the request was cancelled
 * (our own timeout fired or an external signal aborted it).  Retrying an
 * aborted request immediately would just time out again and double the wait.
 * AbortError is handled as a terminal "Request cancelled" response instead.
 */
function isNetworkError(err) {
  if (!err) return false;
  // AbortError is NOT a retryable network error — see comment above.
  if (err.name === 'AbortError') return false;
  return (
    err.name === 'TypeError' ||
    (typeof err.message === 'string' &&
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
        return { success: false, error: data.error || data.message || 'Registration failed' };
      }
      return { success: false, error: data.error || data.message || 'Service temporarily unavailable' };
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
        return { success: false, error: data.error || data.message || 'Invalid username or password' };
      }
      // 503 from the Vite proxy means the backend process is still starting up.
      // Unlike network-level errors (TypeError), the proxy returns a real HTTP
      // response so fetch() never throws — the catch-based retry never fires.
      // Retry once explicitly here so a login attempt made during the brief
      // startup window succeeds automatically instead of surfacing the error.
      if (res.status === 503 && attempt === 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { success: false, error: data.error || data.message || 'Service temporarily unavailable' };
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
        return { success: false, error: data.error || data.message || 'Recovery reset failed' };
      }
      return { success: false, error: data.error || data.message || 'Service temporarily unavailable' };
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
