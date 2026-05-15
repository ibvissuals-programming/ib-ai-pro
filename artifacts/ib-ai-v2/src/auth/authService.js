/**
 * Auth service — IB AI Assistant.
 *
 * Replaces localStorage-only auth with server-side API calls.
 * JWT token stored in localStorage under IB_TOKEN_KEY.
 *
 * Public API (unchanged interface for useAuth.js compatibility):
 *   signup(username, password) → { success, error? }
 *   login(username, password)  → { success, error? }
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
    return { success: false, error: 'Network error — please try again' };
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
    return { success: false, error: 'Network error — please try again' };
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
    return { success: false, error: 'Network error — please try again' };
  }
}

/**
 * changePassword() — change the current user's password.
 * Requires a valid session token.
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
    return { success: true };
  } catch (err) {
    return { success: false, error: 'Network error — please try again' };
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
