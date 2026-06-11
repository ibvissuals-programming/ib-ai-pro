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

// ── Shared HTTP error handler ─────────────────────────────────────────────────
// Called only when a response EXISTS and res.ok === false.
// HTTP status always takes priority — classifyHttpError handles the mapping.

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
// Called only from catch blocks where fetch() itself threw (no response exists).
// Preserves AbortError.name so callers can distinguish cancel from failure.

function throwFetchError(err) {
  const msg = classifyFetchError(err);
  const e = new Error(msg);
  if (err.name === 'AbortError') e.name = 'AbortError';
  throw e;
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
 * @param {string} [editMode] — "portrait_safe" | "cinematic" | "style_transfer" | "creative"
 * @param {string} [intensity] — optional intensity override ("LOW"|"MEDIUM"|"HIGH"|"EXTREME")
 * @param {boolean} [useCinematicAnalysis] — if true, backend runs Gemini vision pre-analysis
 * @returns {Promise<{ b64Image: string, status: string, mode?: string, intensity?: string, cinematicAnalysisUsed?: boolean }>}
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
 * @param {number} [limit=30] — max entries to return
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
 * Call the Cinematic Insight Engine — analyze an image and return structured
 * professional editing direction.
 *
 * @param {string} imageDataUrl — data URL (data:image/...;base64,...)
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
export async function generateCinematicPrompt(imageDataUrl) {
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
