const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const ANALYZE_URL = `${BASE}/api/analyze-image`;

// Image analysis can take longer than chat — allow up to 60 seconds
const TIMEOUT_MS = 60_000;

/**
 * Send an image to the backend for visual analysis.
 * Returns a structured object with analysis data and generated prompts.
 *
 * Passes the username as x-username header so the credit guard middleware
 * can check and deduct credits. The 402 response (CREDITS_EXHAUSTED) is
 * parsed and re-thrown with err.code set so useChat can handle it distinctly.
 *
 * @param {string} imageBase64 — raw base64 string (no data URL prefix)
 * @param {string} mimeType — e.g. "image/jpeg"
 * @param {string} [username] — current user's username for credit tracking
 * @returns {Promise<object>}
 */
export async function analyzeImage(imageBase64, mimeType, username) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers = { 'Content-Type': 'application/json' };
  if (username) {
    headers['x-username'] = username;
  }

  let response;
  try {
    response = await fetch(ANALYZE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ imageBase64, mimeType }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Parse structured error body for credit exhaustion detection.
    // Other errors are surfaced as generic API errors.
    let body;
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    const err = new Error(body.error || `Image analysis API error ${response.status}`);
    err.code = body.code ?? null;
    err.statusCode = response.status;
    throw err;
  }

  return response.json();
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
