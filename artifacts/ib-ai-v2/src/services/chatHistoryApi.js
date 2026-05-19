/**
 * chatHistoryApi — frontend client for chat session persistence endpoints.
 *
 * All calls include the JWT auth token. Errors are thrown as plain Error objects.
 *
 * Exports:
 *   fetchSessions()              — GET /api/chat/sessions
 *   fetchSessionMessages(id)     — GET /api/chat/sessions/:id/messages
 *   fetchLatestSession()         — fetches sessions then loads the most recent one
 *   deleteSession(id)            — DELETE /api/chat/sessions/:id
 */
import { getAuthHeaders } from '../auth/authService';

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

export async function fetchSessions() {
  const res = await fetch(`${BASE}/api/chat/sessions?limit=50`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSessionMessages(sessionId) {
  const res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/messages`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  const res = await fetch(`${BASE}/api/chat/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
