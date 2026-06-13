import { getAuthHeaders } from '../auth/authService';
import {
  safeJson,
  fetchWithTimeout,
  classifyFetchError,
  classifyHttpError,
  IMAGE_GEN_MS,
} from '../utils/apiClient';

const BASE = (import.meta.env.BASE_URL ?? '').replace(/\/$/, '');
const GENERATE_URL         = `${BASE}/api/image/generate`;
const EDIT_URL             = `${BASE}/api/image/edit`;
const HISTORY_URL          = `${BASE}/api/image/history`;
const CINEMATIC_PROMPT_URL = `${BASE}/api/image/cinematic-prompt`;
const PROMPT_EXPAND_URL    = `${BASE}/api/prompt/expand`;

// ── Shared HTTP error handler ─────────────────────────────────────────────────

function handleErrorResponse(res, data) {
  if (res.status === 401) throw new Error('Authentication required. Please log in again.');
  if (res.status === 402) {
    const err = new Error(data?.error ?? 'Insufficient credits');
    err.code = 'CREDITS_EXHAUSTED';
    err.statusCode = 402;
    throw err;
  }
  throw new Error(classifyHttpError(res, data));
}

// ── Shared fetch-error handler ────────────────────────────────────────────────

function throwFetchError(err) {
  const msg = classifyFetchError(err);
  const e = new Error(msg);
  if (err.name === 'AbortError') e.name = 'AbortError';
  throw e;
}

/**
 * Expand a brief idea into a rich professional image generation prompt.
 * Calls POST /api/prompt/expand via Gemini 2.5 Flash.
 *
 * @param {string} prompt — brief idea or subject
 * @param {string} [category] — prompt style category (default: "cinematic")
 * @returns {Promise<{ original: string, expanded: string, category: string, wordsBefore: number, wordsAfter: number, expansionRatio: number }>}
 */
export async function expandPrompt(prompt, category = 'cinematic') {
  let res;
  try {
    res = await fetchWithTimeout(
      PROMPT_EXPAND_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ prompt, category }),
      },
      IMAGE_GEN_MS,
    );
  } catch (err) {
    throwFetchError(err);
  }
  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data);
  return data;
}

/**
 * Generate a new image from a text prompt.
 * @param {string} prompt
 * @returns {Promise<{ b64Image: string, status: string }>}
 */
export async function generateImage(prompt) {
  let res;
  try {
    res = await fetchWithTimeout(
      GENERATE_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ prompt }),
      },
      IMAGE_GEN_MS,
    );
  } catch (err) {
    throwFetchError(err);
  }

  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data);
  return data;
}

/**
 * Edit an existing image using a natural-language instruction.
 * @param {string} imageBase64 — data URL (data:image/...;base64,...)
 * @param {string} prompt — edit instruction
 * @param {string} [editMode]
 * @param {string} [intensity]
 * @param {boolean} [useCinematicAnalysis]
 * @returns {Promise<{ b64Image: string, status: string, mode?: string, intensity?: string }>}
 */
export async function editImage(imageBase64, prompt, editMode, intensity, useCinematicAnalysis, signal) {
  let res;
  const body = { image: imageBase64, prompt };
  if (editMode)             body.editMode             = editMode;
  if (intensity)            body.intensity            = intensity;
  if (useCinematicAnalysis) body.useCinematicAnalysis = true;

  try {
    res = await fetchWithTimeout(
      EDIT_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      },
      IMAGE_GEN_MS,
      signal,
    );
  } catch (err) {
    throwFetchError(err);
  }

  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data);
  if (!data.b64Image && !data.enhancementMode) throw new Error('Image edit returned no result. Please try again.');
  return data;
}

/**
 * Fetch the current user's image generation/edit history.
 * @param {number} [limit=30]
 * @returns {Promise<{ entries: Array, count: number }>}
 */
export async function fetchImageHistory(limit = 30) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${HISTORY_URL}?limit=${limit}`,
      { method: 'GET', headers: { ...getAuthHeaders() } },
      IMAGE_GEN_MS,
    );
  } catch (err) {
    throwFetchError(err);
  }

  const data = await safeJson(res);
  if (!res.ok) {
    if (res.status === 401) throw new Error('Authentication required.');
    throw new Error(classifyHttpError(res, data));
  }
  return data;
}

/**
 * Call the Cinematic Insight Engine — analyse an image and return structured
 * professional editing direction.
 *
 * @param {string} imageDataUrl — data URL (data:image/...;base64,...)
 * @param {AbortSignal} [signal]
 * @returns {Promise<{
 *   sceneDescription: string,
 *   lightingConditions: string,
 *   colorTone: string,
 *   compositionType: string,
 *   mood: string,
 *   cinematicEditPrompt: string,
 *   lightingDirection: string,
 *   colorGrade: string,
 *   exposureGuidance: string,
 *   moodTarget: string,
 * }>}
 */
export async function generateCinematicPrompt(imageDataUrl, signal) {
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image format — expected a data URL.');
  const [, mimeType, imageBase64] = match;

  let res;
  try {
    res = await fetchWithTimeout(
      CINEMATIC_PROMPT_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ imageBase64, mimeType }),
      },
      IMAGE_GEN_MS,
      signal,
    );
  } catch (err) {
    throwFetchError(err);
  }

  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data);
  return data;
}

/**
 * Delete a history entry by ID.
 * @param {string} entryId
 * @returns {Promise<void>}
 */
export async function deleteHistoryEntry(entryId) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${HISTORY_URL}/${encodeURIComponent(entryId)}`,
      { method: 'DELETE', headers: { ...getAuthHeaders() } },
      IMAGE_GEN_MS,
    );
  } catch (err) {
    throwFetchError(err);
  }

  const data = await safeJson(res);
  if (!res.ok) {
    if (res.status === 401) throw new Error('Authentication required.');
    if (res.status === 404) throw new Error('Entry not found.');
    throw new Error(classifyHttpError(res, data));
  }
}
