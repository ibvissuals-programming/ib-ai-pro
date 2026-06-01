/**
 * historyApi.js — IB AI Assistant
 *
 * Frontend service for persistent TTS and Video generation history.
 * Reads from /api/tts/history and /api/video/history endpoints.
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

/**
 * Fetch the current user's TTS history (newest first, max 20).
 * @returns {Promise<Array>} Array of TTS history entries
 */
export async function fetchTtsHistory() {
  let res;
  try {
    res = await fetchWithTimeout(
      `${BASE}/api/tts/history`,
      { headers: getAuthHeaders() },
      API_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(classifyFetchError(err));
  }
  const data = await safeJson(res);
  if (!res.ok) throw new Error(classifyHttpError(res, data));
  return data.history ?? [];
}

/**
 * Fetch the current user's Video history (newest first, max 20).
 * @returns {Promise<Array>} Array of video history entries
 */
export async function fetchVideoHistory() {
  let res;
  try {
    res = await fetchWithTimeout(
      `${BASE}/api/video/history`,
      { headers: getAuthHeaders() },
      API_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(classifyFetchError(err));
  }
  const data = await safeJson(res);
  if (!res.ok) throw new Error(classifyHttpError(res, data));
  return data.history ?? [];
}

/**
 * Fetch creator presets for a given tool type.
 * @param {'image'|'video'|'voice'} type
 * @returns {Promise<Array>} Array of preset objects
 */
export async function fetchPresets(type) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${BASE}/api/presets/${encodeURIComponent(type)}`,
      {},
      API_TIMEOUT_MS,
    );
  } catch (err) {
    throw new Error(classifyFetchError(err));
  }
  const data = await safeJson(res);
  if (!res.ok) throw new Error(classifyHttpError(res, data));
  return data.presets ?? [];
}

/**
 * Fetch multimodal stats for CEO dashboard.
 * @returns {Promise<object>} Multimodal analytics payload
 */
export async function fetchMultimodalStats() {
  let res;
  try {
    res = await fetchWithTimeout(
      `${BASE}/api/admin/multimodal-stats`,
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
