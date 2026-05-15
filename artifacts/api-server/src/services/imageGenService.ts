/**
 * Image generation service — IB AI Assistant
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, no auth, FLUX model)
 *                 image.pollinations.ai
 *
 * IMAGE-TO-IMAGE: Gemini vision analyzes the uploaded image to extract a
 *                 faithful description (preserving face/person details), then
 *                 FLUX regenerates grounded to that description + edit prompt.
 *                 Uploaded image is ALWAYS used — never silently ignored.
 *
 * No external API keys required for image generation.
 * Gemini API (already integrated) used for image description in edit flow.
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

// ── IMAGE-TO-IMAGE: Gemini-grounded regeneration ──────────────────────────────
// Uses Gemini vision to describe the uploaded image (preserving face/person
// details), then builds a grounded edit prompt for FLUX generation.
// The uploaded image is ALWAYS used — never silently ignored.
// Hard failure returned if no image is supplied.

const GEMINI_DESCRIBE_TIMEOUT_MS = 20_000;

/**
 * describeImageForEdit() — extract a faithful visual description from the
 * uploaded image using Gemini vision. Result is incorporated into the FLUX
 * generation prompt so the edit is grounded to the actual image content
 * (face, hair, clothing, setting) rather than generating random subjects.
 *
 * Non-fatal: if Gemini fails, returns empty string and caller falls back.
 */
async function describeImageForEdit(imageDataUrl: string): Promise<string> {
  // Parse data URL → mime type + raw base64
  const commaIdx = imageDataUrl.indexOf(",");
  if (commaIdx === -1) return "";

  const header = imageDataUrl.slice(0, commaIdx);
  const base64 = imageDataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+);/);
  const mimeType = (mimeMatch?.[1] ?? "image/jpeg") as
    | "image/jpeg"
    | "image/png"
    | "image/webp"
    | "image/gif";

  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowedMimes.includes(mimeType)) return "";

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Gemini describe timeout")),
        GEMINI_DESCRIBE_TIMEOUT_MS,
      ),
    );

    const describePromise = ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: base64 } },
            {
              text: "Describe this image in 2-3 sentences for use as an AI image generation prompt. Focus on: the main subject (if a person — describe their face shape, hair color/style, skin tone, expression, clothing, age group), the setting/background, and the lighting. Be specific and visual. Output only the description, no preamble.",
            },
          ],
        },
      ],
      config: { temperature: 0.2, maxOutputTokens: 250 },
    });

    const result = await Promise.race([describePromise, timeoutPromise]);
    const description = (result.text ?? "").trim();

    logger.info(
      { descriptionLength: description.length },
      "[imageGen] Gemini image description obtained",
    );
    return description;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[imageGen] Gemini describe failed — falling back to prompt-only edit",
    );
    return "";
  }
}

export async function editImage(
  imageBase64: string,
  prompt: string,
): Promise<string> {
  // Hard failure: image is required for edit operations
  if (!imageBase64 || imageBase64.trim().length < 10) {
    throw new Error("No image supplied for editing");
  }

  // Use Gemini to extract a faithful description of the uploaded image.
  // This grounds the FLUX generation to the actual subject (face, person,
  // scene) rather than producing a random unrelated image.
  const imageDescription = await describeImageForEdit(imageBase64);

  let editPrompt: string;
  if (imageDescription) {
    // Grounded edit: combine image description + user's edit instruction
    editPrompt = `${imageDescription}. Apply this edit: ${prompt.trim()}, highly detailed, sharp focus, professional quality`;
    logger.info(
      { imageDescribed: true, prompt: prompt.slice(0, 80) },
      "[imageGen] building grounded edit prompt",
    );
  } else {
    // Fallback: Gemini unavailable — use prompt alone with explicit note
    editPrompt = `${prompt.trim()}, highly detailed, sharp focus, professional quality`;
    logger.warn(
      { prompt: prompt.slice(0, 80) },
      "[imageGen] editing without image description (Gemini unavailable)",
    );
  }

  const enhanced = enhancePrompt(editPrompt);
  const seed = Math.floor(Math.random() * 2_000_000_000);

  const imageUrl =
    `${POLLINATIONS_BASE}/${encodeURIComponent(enhanced)}` +
    `?model=flux&width=1024&height=1024&nologo=true&seed=${seed}&enhance=false`;

  logger.info(
    { provider: "pollinations", seed, prompt: enhanced.slice(0, 100) },
    "[imageGen] editing (Gemini-grounded regeneration)",
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
