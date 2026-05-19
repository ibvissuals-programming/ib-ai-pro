import { getAuthHeaders } from '../auth/authService';
import { safeJson, fetchWithTimeout, IMAGE_GEN_MS } from '../utils/apiClient';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const GENERATE_URL         = `${BASE}/api/image/generate`;
const EDIT_URL             = `${BASE}/api/image/edit`;
const HISTORY_URL          = `${BASE}/api/image/history`;
const CINEMATIC_PROMPT_URL = `${BASE}/api/image/cinematic-prompt`;

function handleErrorResponse(res, data, context) {
  if (res.status === 401) throw new Error('Authentication required. Please log in again.');
  if (res.status === 402) {
    const err = new Error(data.error ?? 'Insufficient credits');
    err.code = 'CREDITS_EXHAUSTED';
    err.statusCode = 402;
    throw err;
  }
  throw new Error(data.error ?? `Server error ${res.status}`);
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
    if (err.name === 'AbortError') throw new Error('Request timed out — the model took too long. Please try again.');
    throw new Error('Network error — could not reach the image service.');
  }

  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data, 'generate');
  return data;
}

/**
 * Edit an existing image using a natural-language instruction.
 * @param {string} imageBase64 — data URL (data:image/...;base64,...)
 * @param {string} prompt — edit instruction
 * @param {string} [cinematicProfile] — optional EditMode override (e.g. "CINEMATIC_EDIT")
 * @param {string} [intensity] — optional intensity override ("LOW"|"MEDIUM"|"HIGH"|"EXTREME")
 * @param {boolean} [useCinematicAnalysis] — if true, backend runs Gemini vision pre-analysis
 * @returns {Promise<{ b64Image: string, status: string, mode?: string, intensity?: string, cinematicAnalysisUsed?: boolean }>}
 */
export async function editImage(imageBase64, prompt, cinematicProfile, intensity, useCinematicAnalysis) {
  let res;
  const body = { image: imageBase64, prompt };
  if (cinematicProfile)      body.cinematicProfile      = cinematicProfile;
  if (intensity)             body.intensity             = intensity;
  if (useCinematicAnalysis)  body.useCinematicAnalysis  = true;

  try {
    res = await fetchWithTimeout(
      EDIT_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
      },
      IMAGE_GEN_MS,
    );
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out — the model took too long. Please try again.');
    throw new Error('Network error — could not reach the image service.');
  }

  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data, 'edit');

  if (!data.b64Image) throw new Error('Image edit returned no result. Please try again.');
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
    if (err.name === 'AbortError') throw new Error('Request timed out loading history.');
    throw new Error('Network error — could not load history.');
  }

  const data = await safeJson(res);
  if (!res.ok) {
    if (res.status === 401) throw new Error('Authentication required.');
    throw new Error(data.error ?? 'Failed to load history.');
  }

  return data;
}

/**
 * Call the Cinematic Insight Engine — analyze an image and return structured
 * professional editing direction: scene description, lighting direction,
 * color grade, exposure guidance, mood target, and a cinematicEditPrompt.
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
    if (err.name === 'AbortError') throw new Error('Cinematic analysis timed out — please try again.');
    throw new Error('Network error — could not reach the cinematic analysis service.');
  }

  const data = await safeJson(res);
  if (!res.ok) handleErrorResponse(res, data, 'cinematic-prompt');
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
      `${HISTORY_URL}/${entryId}`,
      { method: 'DELETE', headers: { ...getAuthHeaders() } },
      IMAGE_GEN_MS,
    );
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out.');
    throw new Error('Network error — could not delete entry.');
  }

  const data = await safeJson(res);
  if (!res.ok) {
    if (res.status === 401) throw new Error('Authentication required.');
    if (res.status === 404) throw new Error('Entry not found.');
    throw new Error(data.error ?? 'Failed to delete entry.');
  }
}
