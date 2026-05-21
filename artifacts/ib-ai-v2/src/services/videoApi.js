/**
 * videoApi.js — IB AI Assistant
 *
 * Client for the video generation API.
 *
 * Endpoints:
 *   POST /api/video/generate  → startVideoGeneration(imageBase64, prompt, mode)
 *   GET  /api/video/status/:jobId → pollVideoStatus(jobId)
 *   GET  /api/video/capability    → getVideoCapability()
 *   GET  /api/video/modes         → listVideoModes()
 *
 * Async pattern:
 *   startVideoGeneration() returns immediately with { jobId, status: "processing" }
 *   Poll pollVideoStatus() every 5 seconds until status is "completed" | "failed" | "provider_not_configured"
 *   On "completed": resultUrl is the video stream URL
 */
import { getAuthHeaders } from '../auth/authService';
import { safeJson, fetchWithTimeout } from '../utils/apiClient';

const BASE              = import.meta.env.BASE_URL.replace(/\/$/, '');
const GENERATE_URL      = `${BASE}/api/video/generate`;
const CAPABILITY_URL    = `${BASE}/api/video/capability`;
const MODES_URL         = `${BASE}/api/video/modes`;
const VIDEO_TIMEOUT_MS  = 30_000;    // route responds immediately — short timeout
const STATUS_TIMEOUT_MS = 10_000;

function handleErrorResponse(res, data) {
  if (res.status === 401) throw new Error('Authentication required. Please log in again.');
  if (res.status === 402) {
    const err = new Error(data.error ?? 'Insufficient credits');
    err.code = 'CREDITS_EXHAUSTED';
    err.statusCode = 402;
    throw err;
  }
  if (res.status === 413) throw new Error('Image too large — please use an image under 10 MB.');
  throw new Error(data.error ?? `Server error ${res.status}`);
}

/**
 * Start video generation (async — returns immediately with jobId + "processing").
 * @param {string} imageBase64 — data URL (data:image/...;base64,...)
 * @param {string} prompt — motion instruction
 * @param {string} [mode] — "cinematic_motion" | "zoom_parallax" | "social_motion" | "subtle_animation"
 * @returns {Promise<{ jobId: string, status: string, metadata: object }>}
 */
export async function startVideoGeneration(imageBase64, prompt, mode = 'cinematic_motion') {
  let res;
  try {
    res = await fetchWithTimeout(
      GENERATE_URL,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body:    JSON.stringify({ image: imageBase64, prompt, mode }),
      },
      VIDEO_TIMEOUT_MS,
    );
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw new Error('Network error — could not reach the video service.');
  }

  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data);
  return data;
}

/**
 * Poll for video job status.
 * @param {string} jobId
 * @returns {Promise<{ status: string, resultUrl: string|null, metadata: object }>}
 */
export async function pollVideoStatus(jobId) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${BASE}/api/video/status/${encodeURIComponent(jobId)}`,
      { headers: getAuthHeaders() },
      STATUS_TIMEOUT_MS,
    );
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Status check timed out.');
    throw new Error('Network error checking video status.');
  }

  const data = await safeJson(res);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Video job not found — it may have expired.');
    throw new Error(data.error ?? `Status check failed (${res.status})`);
  }
  return data;
}

/**
 * Check video provider capability.
 * @returns {Promise<{ featureEnabled: boolean, provider: string, model: string }>}
 */
export async function getVideoCapability() {
  try {
    const res = await fetchWithTimeout(CAPABILITY_URL, { headers: getAuthHeaders() }, 8_000);
    const data = await safeJson(res);
    return res.ok ? data : { featureEnabled: false };
  } catch {
    return { featureEnabled: false };
  }
}

/**
 * List available video modes.
 * @returns {Promise<{ modes: Array<{ id, description }>, providerReady: boolean }>}
 */
export async function listVideoModes() {
  try {
    const res = await fetchWithTimeout(MODES_URL, {}, 8_000);
    return await safeJson(res);
  } catch {
    return { modes: [], providerReady: false };
  }
}

/**
 * Returns the video streaming URL for a completed job.
 * @param {string} jobId
 * @returns {string}
 */
export function getVideoUrl(jobId) {
  return `${BASE}/api/video/serve/${jobId}`;
}
