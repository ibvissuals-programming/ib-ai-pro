/**
 * Auth service — IB AI Assistant.
 *
 * Replaces localStorage-only auth with server-side API calls.
 * JWT token stored in localStorage under IB_TOKEN_KEY.
 *
 * Public API (unchanged interface for useAuth.js compatibility):
 *   signup(username, password) → { success, error?, isStartupError? }
 *   login(username, password)  → { success, error?, recoveryLogin?, isStartupError? }
 *   recoveryLogin(username, key) → { success, error?, recoveryLogin?, isStartupError? }
 *   changePassword(newPassword) → { success, error? }
 *   logout()
 *   getCurrentUser()           → { id, username, role, credits } | null
 *   isAuthenticated()          → boolean
 *   getToken()                 → string | null
 *   getAuthHeaders()           → { Authorization: 'Bearer ...' } | {}
 *
 * Startup safety:
 *   All mutating auth functions (login/signup/recoveryLogin) run a health
 *   pre-check before sending credentials. If the server isn't ready, or if
 *   a startup-class error occurs (empty body, network, timeout, 5xx), the
 *   call is retried up to MAX_AUTH_RETRIES times with RETRY_DELAY_MS between
 *   attempts. Hard auth failures (401/400/409) are never retried.
 *
 *   isStartupError: true is set on the result so the UI can show
 *   "Connecting to server..." instead of a generic auth error.
 */

import { fetchWithTimeout, AUTH_TIMEOUT_MS } from '../utils/apiClient';
import { checkServerHealth } from '../utils/serverReadiness';

const IB_TOKEN_KEY = 'ib_token';
const IB_USER_KEY = 'ib_cached_user';

const MAX_AUTH_RETRIES = 3;
const RETRY_DELAY_MS   = 1_000;

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

function clearToken() {
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

/**
 * Safely parse the JSON body of a Response without ever throwing.
 *
 * Reads the body as text first, then attempts JSON.parse.
 * Returns a fallback object on any failure so callers always get an object.
 *
 * Handles:
 *   - empty body (proxy errors, crashed backend)
 *   - non-JSON body (HTML error pages, plain-text errors)
 *   - truncated JSON (network interruption mid-stream)
 *   - wrong content-type
 */
async function safeParseJson(res) {
  let text;
  try {
    text = await res.text();
  } catch {
    return { error: 'Failed to read server response' };
  }

  if (!text || !text.trim()) {
    return { error: 'Server returned an empty response' };
  }

  const ct = res.headers?.get?.('content-type') ?? '';
  if (ct && !ct.includes('application/json') && !ct.includes('text/plain')) {
    return { error: 'Invalid server response (unexpected content type)' };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: 'Invalid server response' };
  }
}

// ── API helpers ───────────────────────────────────────────────────────────────

/**
 * POST to a backend auth endpoint with a timeout.
 * Uses fetchWithTimeout so requests never hang indefinitely.
 */
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

/**
 * Converts a caught fetch/parse error into a human-readable message.
 *
 * Distinguishes:
 *   - Request aborted / timed out (AbortError)
 *   - JSON parse failure (SyntaxError) — "Invalid server response"
 *   - Server unreachable (TypeError / "Failed to fetch")
 *   - Any other error (uses err.message directly)
 */
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

/** Pause between retry attempts */
function retryDelay() {
  return new Promise(r => setTimeout(r, RETRY_DELAY_MS));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * signup() — create a new account.
 *
 * Startup safety:
 *   - Health pre-check before sending credentials
 *   - Up to MAX_AUTH_RETRIES on startup-class failures (network, 5xx, empty body)
 *   - Immediate return (no retry) on 400 / 409 (validation / duplicate)
 *   - isStartupError: true on all startup-class failures so the UI can show
 *     "Connecting to server..." instead of a generic auth error
 */
export async function signup(username, password) {
  const health = await checkServerHealth();
  if (!health.ready) {
    return { success: false, error: 'Server is starting up — please try again', isStartupError: true };
  }

  for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
    let res, data;
    try {
      res  = await post('/auth/register', { username, password });
      data = await safeParseJson(res);
    } catch (err) {
      if (attempt === MAX_AUTH_RETRIES) {
        return { success: false, error: fetchErrorMessage(err), isStartupError: true };
      }
      await retryDelay();
      continue;
    }

    if (!res.ok) {
      // Hard validation / conflict — never retry
      if (res.status === 400 || res.status === 409) {
        return { success: false, error: data.error || 'Registration failed' };
      }
      // Server error (5xx, etc.) — startup class
      if (attempt < MAX_AUTH_RETRIES) { await retryDelay(); continue; }
      return { success: false, error: data.error || 'Server is starting up — please try again', isStartupError: true };
    }

    // 200/201 but fields missing — startup class (empty body race)
    if (!data.token || !data.user) {
      if (attempt < MAX_AUTH_RETRIES) { await retryDelay(); continue; }
      return { success: false, error: data.error || 'Server is starting up — please try again', isStartupError: true };
    }

    saveToken(data.token);
    saveUser(data.user);
    return { success: true, user: data.user };
  }

  return { success: false, error: 'Server is starting up — please try again', isStartupError: true };
}

/**
 * login() — authenticate with username + password.
 *
 * Startup safety:
 *   - Health pre-check before sending credentials
 *   - Up to MAX_AUTH_RETRIES on startup-class failures (network, 5xx, empty body)
 *   - Immediate return (no retry) on 401 / 400 (wrong credentials / bad request)
 *   - isStartupError: true on all startup-class failures
 */
export async function login(username, password) {
  const health = await checkServerHealth();
  if (!health.ready) {
    return { success: false, error: 'Server is starting up — please try again', isStartupError: true };
  }

  for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
    let res, data;
    try {
      res  = await post('/auth/login', { username, password });
      data = await safeParseJson(res);
    } catch (err) {
      if (attempt === MAX_AUTH_RETRIES) {
        return { success: false, error: fetchErrorMessage(err), isStartupError: true };
      }
      await retryDelay();
      continue;
    }

    if (!res.ok) {
      // Hard auth failure — never retry
      if (res.status === 401 || res.status === 400) {
        return { success: false, error: data.error || 'Invalid username or password' };
      }
      // Server error (5xx, etc.) — startup class
      if (attempt < MAX_AUTH_RETRIES) { await retryDelay(); continue; }
      return { success: false, error: data.error || 'Server is starting up — please try again', isStartupError: true };
    }

    // 200 OK but fields missing — startup class (empty body race)
    if (!data.token || !data.user) {
      if (attempt < MAX_AUTH_RETRIES) { await retryDelay(); continue; }
      return { success: false, error: data.error || 'Server is starting up — please try again', isStartupError: true };
    }

    saveToken(data.token);
    saveUser(data.user);
    return { success: true, user: data.user, recoveryLogin: data.recoveryLogin ?? false };
  }

  return { success: false, error: 'Server is starting up — please try again', isStartupError: true };
}

/**
 * recoveryLogin() — CEO recovery path.
 * Sends x-ceo-recovery-key header + username body.
 * Password not required.
 * Returns { success, user?, recoveryLogin?, error?, isStartupError? }
 *
 * Startup safety:
 *   - Health pre-check before sending credentials
 *   - Up to MAX_AUTH_RETRIES on startup-class failures
 *   - Immediate return (no retry) on 401 / 400 (bad key / bad request)
 */
export async function recoveryLogin(username, recoveryKey) {
  const health = await checkServerHealth();
  if (!health.ready) {
    return { success: false, error: 'Server is starting up — please try again', isStartupError: true };
  }

  for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
    let res, data;
    try {
      res = await fetchWithTimeout(
        `${BASE}/api/auth/login`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-ceo-recovery-key': recoveryKey,
          },
          body: JSON.stringify({ username }),
        },
        AUTH_TIMEOUT_MS,
      );
      data = await safeParseJson(res);
    } catch (err) {
      if (attempt === MAX_AUTH_RETRIES) {
        return { success: false, error: fetchErrorMessage(err), isStartupError: true };
      }
      await retryDelay();
      continue;
    }

    if (!res.ok) {
      // Hard auth failure — never retry
      if (res.status === 401 || res.status === 400) {
        return { success: false, error: data.error || 'Invalid recovery key' };
      }
      // Server error — startup class
      if (attempt < MAX_AUTH_RETRIES) { await retryDelay(); continue; }
      return { success: false, error: data.error || 'Server is starting up — please try again', isStartupError: true };
    }

    if (!data.token || !data.user) {
      if (attempt < MAX_AUTH_RETRIES) { await retryDelay(); continue; }
      return { success: false, error: data.error || 'Server is starting up — please try again', isStartupError: true };
    }

    saveToken(data.token);
    saveUser(data.user);
    return { success: true, user: data.user, recoveryLogin: true };
  }

  return { success: false, error: 'Server is starting up — please try again', isStartupError: true };
}

/**
 * changePassword() — change the current user's password.
 * Requires a valid session token (including recovery sessions).
 *
 * After a successful recovery-session password change, the server issues
 * a fresh normal JWT. This function saves it, replacing the restricted token.
 *
 * Returns { success, error? }
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
 * For a verified server-side check, use verifySession() instead.
 * Kept synchronous so existing components work without changes.
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
 * Call this on app mount to ensure the session is still valid.
 *
 * NOTE: Recovery sessions will get a 403 from /api/auth/me (which uses
 * requireNormalAuth). This is correct — they should be redirected to change-password.
 *
 * @returns {Promise<{id, username, role, credits}|null>}
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
      if (res.status === 403) {
        return null;
      }
      clearToken();
      return null;
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
