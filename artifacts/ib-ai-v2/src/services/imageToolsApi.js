const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const GENERATE_URL = `${BASE}/api/image/generate`;
const EDIT_URL = `${BASE}/api/image/edit`;
const TIMEOUT_MS = 32_000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a new image from a text prompt.
 * @param {string} prompt
 * @returns {Promise<{ b64Image: string, status: string }>}
 */
export async function generateImage(prompt) {
  let res;
  try {
    res = await fetchWithTimeout(GENERATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out — the model took too long. Please try again.');
    }
    throw new Error('Network error — could not reach the image service.');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error ?? `Server error ${res.status}`);
  }

  return data;
}

/**
 * Edit an existing image using a natural-language instruction.
 * @param {string} imageBase64 — data URL (data:image/...;base64,...)
 * @param {string} prompt — edit instruction
 * @returns {Promise<{ b64Image: string, status: string }>}
 */
export async function editImage(imageBase64, prompt) {
  let res;
  try {
    res = await fetchWithTimeout(EDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageBase64, prompt }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out — the model took too long. Please try again.');
    }
    throw new Error('Network error — could not reach the image service.');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error ?? `Server error ${res.status}`);
  }

  return data;
}
