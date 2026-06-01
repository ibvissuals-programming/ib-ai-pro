/**
 * ttsApi.js — IB AI Assistant
 *
 * Client for the TTS (text-to-speech) API.
 *
 * Endpoints:
 *   POST /api/tts/generate  → generateSpeech(text, voiceStyle)
 *   GET  /api/tts/voices    → listVoices()
 *   GET  /api/tts/serve/:id → getAudioUrl(jobId)  [direct URL, not fetched]
 *
 * Error taxonomy: ABORT / NETWORK_ERROR from classifyFetchError (fetch threw,
 * no response); HTTP_ERROR from classifyHttpError (response exists, !res.ok).
 * Parse failures (empty/non-JSON body) are handled by safeJson → {} → HTTP fallback.
 */
import { getAuthHeaders } from '../auth/authService';
import {
  safeJson,
  fetchWithTimeout,
  classifyFetchError,
  classifyHttpError,
} from '../utils/apiClient';

const BASE           = (import.meta.env.BASE_URL ?? '').replace(/\/$/, '');
const GENERATE_URL   = `${BASE}/api/tts/generate`;
const VOICES_URL     = `${BASE}/api/tts/voices`;
const TTS_TIMEOUT_MS = 60_000;

// ── Shared HTTP error handler ─────────────────────────────────────────────────
// Called only when a response EXISTS and res.ok === false.

function handleErrorResponse(res, data) {
  if (res.status === 401) throw new Error('Authentication required. Please log in again.');
  if (res.status === 402) {
    const err = new Error(data?.error ?? 'Insufficient credits');
    err.code = 'CREDITS_EXHAUSTED';
    err.statusCode = 402;
    throw err;
  }
  if (res.status === 501) {
    throw new Error('Text-to-speech is not available in this environment.');
  }
  throw new Error(classifyHttpError(res, data));
}

// ── Shared fetch-error handler ────────────────────────────────────────────────
// Called only from catch blocks where fetch() threw — no response exists.
// Preserves AbortError.name so callers can distinguish cancel from failure.

function throwFetchError(err) {
  const msg = classifyFetchError(err);
  const e = new Error(msg);
  if (err.name === 'AbortError') e.name = 'AbortError';
  throw e;
}

/**
 * Generate speech from text.
 * @param {string} text — input text (max 1000 chars)
 * @param {string} [voiceStyle] — voice style id (defaults to "neutral_assistant")
 * @returns {Promise<{ jobId: string, status: string, resultUrl: string, metadata: object }>}
 */
export async function generateSpeech(text, voiceStyle = 'neutral_assistant') {
  let res;
  try {
    res = await fetchWithTimeout(
      GENERATE_URL,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body:    JSON.stringify({ text, voiceStyle }),
      },
      TTS_TIMEOUT_MS,
    );
  } catch (err) {
    throwFetchError(err);
  }

  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data);
  return data;
}

/**
 * List available voice styles.
 * @returns {Promise<{ voices: Array<{ id, label, description }> }>}
 */
export async function listVoices() {
  let res;
  try {
    res = await fetchWithTimeout(VOICES_URL, { headers: getAuthHeaders() }, 10_000);
  } catch (err) {
    throwFetchError(err);
  }
  const data = await safeJson(res);
  if (!res.ok) throw new Error(classifyHttpError(res, data));
  return data;
}

/**
 * Returns the audio streaming URL for a completed TTS job.
 * The URL is a direct stream — use as <audio src="..."> or for download.
 * @param {string} jobId
 * @returns {string}
 */
export function getAudioUrl(jobId) {
  return `${BASE}/api/tts/serve/${jobId}`;
}
