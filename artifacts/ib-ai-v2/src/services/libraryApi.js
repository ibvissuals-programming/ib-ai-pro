import { getAuthHeaders } from '../auth/authService';

const BASE = (import.meta.env.BASE_URL ?? '').replace(/\/$/, '');

export async function fetchLibrary() {
  const res = await fetch(`${BASE}/api/library`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error('Failed to load library');
  return res.json();
}

export async function saveLibraryItem({ type, content, metadata = {} }) {
  const res = await fetch(`${BASE}/api/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ type, content, metadata }),
  });
  if (!res.ok) throw new Error('Failed to save item');
  return res.json();
}

export async function deleteLibraryItem(id) {
  const res = await fetch(`${BASE}/api/library/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error('Failed to delete item');
  return res.json();
}
