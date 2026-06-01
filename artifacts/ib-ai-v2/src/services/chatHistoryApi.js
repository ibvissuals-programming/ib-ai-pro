/**
 * chatHistoryApi — frontend client for chat session persistence endpoints.
 *
 * All calls include the JWT auth token. Network and HTTP errors are classified
 * through the shared apiClient taxonomy (ABORT / NETWORK_ERROR / HTTP_ERROR).
 * Errors are thrown as plain Error objects with human-readable messages.
 *
 * Exports:
 *   fetchSessions()              — GET /api/chat/sessions
 *   fetchSessionMessages(id)     — GET /api/chat/sessions/:id/messages
 *   fetchLatestSession()         — fetches sessions then loads the most recent one
 *   deleteSession(id)            — DELETE /api/chat/sessions/:id
 */
import { getAuthHeaders } from '../auth/authService';
import {
  safeJson,
  fetchWithTimeout,
  classifyFetchError,
  classifyHttpError,
  API_TIMEOUT_MS,
} from '../utils/apiClient';

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

export async function fetchSessions() {
  let res;
  try {
    res = await fetchWithTimeout(
      `${BASE}/api/chat/sessions?limit=50`,
      { headers: getAuthHeaders() },
      API_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(classifyFetchError(err));
  }
  const data = await safeJson(res);
  if (!res.ok) throw new Error(classifyHttpError(res, data));
  return data;
}

export async function fetchSessionMessages(sessionId) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      { headers: getAuthHeaders() },
      API_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(classifyFetchError(err));
  }
  const data = await safeJson(res);
  if (!res.ok) throw new Error(classifyHttpError(res, data));
  return data;
}

/**
 * Returns the most recent session with its messages, or null if none exist.
 */
export async function fetchLatestSession() {
  const sessions = await fetchSessions();
  if (!sessions?.length) return null;
  const latest = sessions[0];
  const messages = await fetchSessionMessages(latest.id);
  return { ...latest, messages };
}

export async function deleteSession(sessionId) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE', headers: getAuthHeaders() },
      API_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(classifyFetchError(err));
  }
  const data = await safeJson(res);
  if (!res.ok) throw new Error(classifyHttpError(res, data));
}
