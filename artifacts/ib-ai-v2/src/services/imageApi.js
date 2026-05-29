import { getAuthHeaders } from '../auth/authService';
import { safeJson, fetchWithTimeout, IMAGE_ANALYZE_MS } from '../utils/apiClient';

const BASE = (import.meta.env.BASE_URL ?? '').replace(/\/$/, '');
const ANALYZE_URL = `${BASE}/api/analyze-image`;

/**
 * Send an image to the backend for visual analysis.
 * Returns a structured object with analysis data and generated prompts.
 *
 * Auth token is sent via Authorization header (replaces x-username).
 * The 402 response (CREDITS_EXHAUSTED) is parsed and re-thrown with
 * err.code set so useChat can handle it distinctly.
 *
 * @param {string} imageBase64 — raw base64 string (no data URL prefix)
 * @param {string} mimeType — e.g. "image/jpeg"
 * @returns {Promise<object>}
 */
export async function analyzeImage(imageBase64, mimeType) {
  let response;
  try {
    response = await fetchWithTimeout(
      ANALYZE_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ imageBase64, mimeType }),
      },
      IMAGE_ANALYZE_MS,
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      const te = new Error('Request timed out — please try again');
      te.name = 'AbortError';
      throw te;
    }
    throw err;
  }

  if (!response.ok) {
    const body = await safeJson(response);
    const err = new Error(body.error || `Image analysis API error ${response.status}`);
    err.code = body.code ?? null;
    err.statusCode = response.status;
    throw err;
  }

  const result = await safeJson(response);
  if (!result || Object.keys(result).length === 0) {
    throw new Error('Image analysis returned an empty response — please try again');
  }
  return result;
}

/**
 * Convert a File object to a base64 string and extract its MIME type.
 * Strips the "data:<mimeType>;base64," prefix.
 *
 * @param {File} file
 * @returns {Promise<{ base64: string, mimeType: string, filename: string, previewUrl: string }>}
 */
export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const [header, base64] = dataUrl.split(',');
      const mimeType = header.match(/:(.*?);/)?.[1] ?? file.type;
      resolve({
        base64,
        mimeType,
        filename: file.name,
        previewUrl: dataUrl,
      });
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE_MB = 4;

/**
 * Validates that a File is an allowed image type within the size limit.
 * Returns null if valid, or an error message string if invalid.
 *
 * @param {File} file
 * @returns {string | null}
 */
export function validateImageFile(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return 'Only JPEG, PNG, WebP, and GIF images are supported.';
  }
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return `Image must be smaller than ${MAX_FILE_SIZE_MB} MB.`;
  }
  return null;
}
