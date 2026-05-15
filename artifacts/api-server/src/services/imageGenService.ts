/**
 * Image generation service — IB AI Assistant
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, no auth, FLUX model)
 *                 image.pollinations.ai
 *
 * IMAGE-TO-IMAGE: Pollinations.ai (regeneration-based enhancement)
 *                 No API key required. Incorporates the edit instruction
 *                 into an enhanced prompt and generates a new image.
 *
 * No external API keys required for any functionality.
 */
import { logger } from "../lib/logger";

const REQUEST_TIMEOUT_MS = 35_000;

// ── Prompt enhancer ────────────────────────────────────────────────────────────

const QUALITY_SUFFIX =
  ", high quality, sharp focus, detailed, professional photography";

const STYLE_MAP: Record<string, string> = {
  portrait: "studio portrait, cinematic lighting, bokeh, DSLR photography",
  landscape: "scenic landscape, golden hour, vivid colors, wide angle lens",
  product: "professional product photography, clean background, studio lighting",
  art: "digital art, highly detailed, concept art, artstation trending",
  anime: "anime style, vibrant colors, studio ghibli aesthetic, illustration",
  logo: "clean vector logo, minimalist, professional branding, white background",
  interior: "interior design photography, natural lighting, architectural digest",
  food: "food photography, natural light, shallow depth of field, appetizing",
  cinematic: "cinematic shot, anamorphic lens, film grain, dramatic lighting",
  luxury: "luxury aesthetic, high-end, polished, editorial photography",
};

export function enhancePrompt(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const styleKey = Object.keys(STYLE_MAP).find((k) => lower.includes(k));
  const stylePrefix = styleKey ? `${STYLE_MAP[styleKey]}, ` : "";
  const alreadyHasQuality =
    lower.includes("quality") ||
    lower.includes("detailed") ||
    lower.includes("professional") ||
    lower.includes(" hd") ||
    lower.includes("8k") ||
    lower.includes("4k");
  const suffix = alreadyHasQuality ? "" : QUALITY_SUFFIX;
  return `${stylePrefix}${raw.trim()}${suffix}`;
}

// ── TEXT-TO-IMAGE: Pollinations.ai ────────────────────────────────────────────
// Free, no auth required. Uses FLUX model. Returns binary JPEG.
// Verified reachable: image.pollinations.ai returns HTTP 200 + image/jpeg.

const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";

export async function generateImage(prompt: string): Promise<string> {
  const enhanced = enhancePrompt(prompt);
  const seed = Math.floor(Math.random() * 2_000_000_000);

  const imageUrl =
    `${POLLINATIONS_BASE}/${encodeURIComponent(enhanced)}` +
    `?model=flux&width=1024&height=1024&nologo=true&seed=${seed}&enhance=false`;

  logger.info(
    { provider: "pollinations", seed, prompt: enhanced.slice(0, 100) },
    "[imageGen] generating",
  );

  let response: Response;
  try {
    response = await fetch(imageUrl, {
      method: "GET",
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        "Image generation timed out (35s) — Pollinations may be busy. Please try again.",
      );
    }
    throw new Error(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Image generation failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 500) {
    throw new Error(
      "Image generation returned an empty response — please try again.",
    );
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const ct = response.headers.get("content-type") ?? "image/jpeg";
  const mime = ct.split(";")[0].trim();

  logger.info(
    { bytes: buffer.byteLength, mime },
    "[imageGen] generation complete",
  );
  return `data:${mime};base64,${base64}`;
}

// ── IMAGE-TO-IMAGE: Pollinations regeneration ─────────────────────────────────
// No API key required. Builds a descriptive prompt from the edit instruction
// and generates a new image via FLUX. Always returns an image — never text.

export async function editImage(
  _imageBase64: string,
  prompt: string,
): Promise<string> {
  // Build an edit-oriented prompt: treat the instruction as the desired output
  const editPrompt = `${prompt.trim()}, highly detailed, sharp focus, professional quality`;
  const enhanced = enhancePrompt(editPrompt);
  const seed = Math.floor(Math.random() * 2_000_000_000);

  const imageUrl =
    `${POLLINATIONS_BASE}/${encodeURIComponent(enhanced)}` +
    `?model=flux&width=1024&height=1024&nologo=true&seed=${seed}&enhance=false`;

  logger.info(
    { provider: "pollinations", seed, prompt: enhanced.slice(0, 100) },
    "[imageGen] editing (regeneration)",
  );

  let response: Response;
  try {
    response = await fetch(imageUrl, {
      method: "GET",
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        "Image editing timed out (35s) — Pollinations may be busy. Please try again.",
      );
    }
    throw new Error(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Image editing failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 500) {
    throw new Error(
      "Image editing returned an empty response — please try again.",
    );
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const ct = response.headers.get("content-type") ?? "image/jpeg";
  const mime = ct.split(";")[0].trim();

  logger.info({ bytes: buffer.byteLength, mime }, "[imageGen] edit complete");
  return `data:${mime};base64,${base64}`;
}
