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
 */

const IB_TOKEN_KEY = 'ib_token';
const IB_USER_KEY = 'ib_cached_user';

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

// ── API helpers ───────────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

/**
 * Converts a caught fetch error into a human-readable message.
 * Distinguishes:
 *   - Server unreachable (TypeError / "Failed to fetch")
 *   - Request aborted / timed out (AbortError)
 *   - Any other error (uses err.message directly)
 */
function fetchErrorMessage(err) {
  if (!err) return 'Network error — please try again';
  if (err.name === 'AbortError') return 'Request timed out — please try again';
  // "Failed to fetch" covers CORS failures, DNS failures, backend unreachable
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

// ── Public API ────────────────────────────────────────────────────────────────

export async function signup(username, password) {
  try {
    const res = await post('/auth/register', { username, password });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.error || 'Registration failed' };
    }
    saveToken(data.token);
    saveUser(data.user);
    return { success: true, user: data.user };
  } catch (err) {
    return { success: false, error: fetchErrorMessage(err) };
  }
}

export async function login(username, password) {
  try {
    const res = await post('/auth/login', { username, password });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.error || 'Login failed' };
    }
    saveToken(data.token);
    saveUser(data.user);
    return { success: true, user: data.user, recoveryLogin: data.recoveryLogin ?? false };
  } catch (err) {
    return { success: false, error: fetchErrorMessage(err) };
  }
}

/**
 * recoveryLogin() — CEO recovery path.
 * Sends x-ceo-recovery-key header + username body.
 * Password not required.
 * Returns { success, user?, recoveryLogin?, error? }
 */
export async function recoveryLogin(username, recoveryKey) {
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ceo-recovery-key': recoveryKey,
      },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.error || 'Recovery login failed' };
    }
    saveToken(data.token);
    saveUser(data.user);
    return { success: true, user: data.user, recoveryLogin: true };
  } catch (err) {
    return { success: false, error: fetchErrorMessage(err) };
  }
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
    const res = await fetch(`${BASE}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ newPassword }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.error || 'Password change failed' };
    }
    // If the server issued a fresh normal token (after recovery session), save it
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
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // 403 = recovery session (password change required) — keep token but return null
      // so the app can redirect to the password-change flow
      if (res.status === 403) {
        return null;
      }
      clearToken();
      return null;
    }
    const data = await res.json();
    saveUser(data.user);
    return data.user;
  } catch {
    // Network failure — return cached user so app stays usable offline
    return loadCachedUser();
  }
}
