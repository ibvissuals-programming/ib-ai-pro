/**
 * creatorSessionsApi.js — Creator Session API Client
 *
 * Wraps /api/creator/sessions CRUD endpoints.
 */
import { getAuthHeaders } from '../auth/authService';

const BASE = '/api/creator/sessions';

export async function listCreatorSessions() {
  const res = await fetch(BASE, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to load sessions: ${res.status}`);
  return res.json();
}

export async function createCreatorSession(payload) {
  const res = await fetch(BASE, {
    method:  'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return res.json();
}

export async function updateCreatorSession(id, updates) {
  const res = await fetch(`${BASE}/${id}`, {
    method:  'PATCH',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body:    JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update session: ${res.status}`);
  return res.json();
}

export async function duplicateCreatorSession(id) {
  const res = await fetch(`${BASE}/${id}/duplicate`, {
    method:  'POST',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to duplicate session: ${res.status}`);
  return res.json();
}

export async function deleteCreatorSession(id) {
  const res = await fetch(`${BASE}/${id}`, {
    method:  'DELETE',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`);
  return res.json();
}

export async function getCreatorAnalytics() {
  const res = await fetch('/api/creator/analytics');
  if (!res.ok) throw new Error(`Failed to load analytics: ${res.status}`);
  return res.json();
}
