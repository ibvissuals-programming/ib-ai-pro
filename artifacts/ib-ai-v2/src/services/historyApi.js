/**
 * historyApi.js — IB AI Assistant
 *
 * Frontend service for persistent TTS and Video generation history.
 * Reads from /api/tts/history and /api/video/history endpoints.
 */
import { getAuthHeaders } from '../auth/authService';

/**
 * Fetch the current user's TTS history (newest first, max 20).
 * @returns {Promise<Array>} Array of TTS history entries
 */
export async function fetchTtsHistory() {
  const res = await fetch('/api/tts/history', { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`TTS history fetch failed: ${res.status}`);
  const data = await res.json();
  return data.history ?? [];
}

/**
 * Fetch the current user's Video history (newest first, max 20).
 * @returns {Promise<Array>} Array of video history entries
 */
export async function fetchVideoHistory() {
  const res = await fetch('/api/video/history', { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Video history fetch failed: ${res.status}`);
  const data = await res.json();
  return data.history ?? [];
}

/**
 * Fetch creator presets for a given tool type.
 * @param {'image'|'video'|'voice'} type
 * @returns {Promise<Array>} Array of preset objects
 */
export async function fetchPresets(type) {
  const res = await fetch(`/api/presets/${type}`);
  if (!res.ok) throw new Error(`Presets fetch failed: ${res.status}`);
  const data = await res.json();
  return data.presets ?? [];
}

/**
 * Fetch multimodal stats for CEO dashboard.
 * @returns {Promise<object>} Multimodal analytics payload
 */
export async function fetchMultimodalStats() {
  const res = await fetch('/api/admin/multimodal-stats', { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Multimodal stats fetch failed: ${res.status}`);
  return res.json();
}
