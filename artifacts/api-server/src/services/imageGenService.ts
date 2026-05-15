/**
 * Image generation service — IB AI Assistant
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, no auth, FLUX model)
 *                 image.pollinations.ai
 *
 * IMAGE-TO-IMAGE: Two-tier approach:
 *   Tier 1 (true img2img): Gemini image model with image input + image output.
 *                           Preserves the actual subject pixel-faithfully.
 *   Tier 2 (grounded fallback): Gemini vision describes the uploaded image,
 *                                then FLUX regenerates grounded to that description.
 *   Hard failure: if both tiers fail, returns error — never silently prompt-only.
 *
 * MIME validation: only image/png, image/jpeg, image/webp accepted.
 * Size limit: base64 payload must not exceed 10 MB decoded.
 * Response validation: output must match ^data:image/(png|jpeg|jpg|webp);base64,
 *
 * PROVIDER RESILIENCE:
 *   Pollinations: up to 2 retries with exponential backoff on 429/402/503.
 *   Gemini: timeout guard on every call.
 *   Observability: [ai] prefix logs for timeout / retry / unavailable events.
 *   Error messages: all raw provider errors are sanitized before propagation.
 */
import { logger } from "../lib/logger";

const REQUEST_TIMEOUT_MS = 35_000;
const GEMINI_TIMEOUT_MS = 25_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB decoded
const ACCEPTED_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
const RESPONSE_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,/;

// ── Pollinations retry config ──────────────────────────────────────────────────
const MAX_POLLINATIONS_RETRIES = 2; // 2 retries after initial attempt = 3 total
const POLLINATIONS_RETRY_BASE_MS = 2_000;

type AcceptedMime = (typeof ACCEPTED_MIMES)[number];

// ── Helpers ────────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when Pollinations returned a status worth retrying */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 402 || status === 503;
}

/**
 * Convert raw provider errors into user-safe messages.
 * Never surfaces internal URLs, JSON bodies, or queue metadata.
 */
function sanitizeProviderError(err: unknown, context: "generate" | "edit"): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timedout") || lower.includes("timed out") || lower.includes("aborted")) {
    return `Image ${context} temporarily unavailable — please retry in a moment.`;
  }
  if (lower.includes("queue full") || lower.includes("402") || lower.includes("overloaded")) {
    return `Image ${context} is temporarily overloaded. Please retry.`;
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return `Image provider rate limit reached. Please retry in a moment.`;
  }
  if (lower.includes("503") || lower.includes("service unavailable")) {
    return `Image provider temporarily unavailable. Please retry.`;
  }
  if (lower.includes("empty response")) {
    return `Image ${context} returned an empty response — please try again.`;
  }
  // Generic fallback — safe enough to surface
  return `Image ${context} failed. Please try again.`;
}

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

// ── Response validation ────────────────────────────────────────────────────────

function validateImageResponse(result: string): void {
  if (!RESPONSE_PATTERN.test(result)) {
    throw new Error(
      "Image response validation failed — unexpected format returned",
    );
  }
}

// ── Pollinations fetch with retry + observability ──────────────────────────────

const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";

async function pollinationsFetch(
  imageUrl: string,
  context: "generate" | "edit",
): Promise<Response> {
  let lastErr: Error = new Error("Unknown error");

  for (let attempt = 0; attempt <= MAX_POLLINATIONS_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = POLLINATIONS_RETRY_BASE_MS * 2 ** (attempt - 1);
      logger.warn(
        { attempt, backoff, provider: "pollinations" },
        "[ai] retry attempt",
      );
      await delay(backoff);
    }

    let response: Response;
    try {
      response = await fetch(imageUrl, {
        method: "GET",
        headers: { Accept: "image/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        logger.warn({ attempt: attempt + 1, provider: "pollinations" }, "[ai] provider timeout");
        // Timeouts are not retried — provider is busy; surface clean message
        throw new Error(sanitizeProviderError(err, context));
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    if (isRetryableStatus(response.status)) {
      const text = await response.text().catch(() => "");
      lastErr = new Error(`HTTP ${response.status}: ${text.slice(0, 80)}`);
      logger.warn(
        { attempt: attempt + 1, status: response.status, provider: "pollinations" },
        "[ai] retry attempt",
      );
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    // Non-retryable HTTP error or success
    return response;
  }

  logger.warn({ provider: "pollinations" }, "[ai] provider unavailable");
  throw new Error(sanitizeProviderError(lastErr, context));
}

// ── TEXT-TO-IMAGE: Pollinations.ai ────────────────────────────────────────────
// Free, no auth required. Uses FLUX model. Returns binary JPEG.

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

  const response = await pollinationsFetch(imageUrl, "generate");

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const raw = `HTTP ${response.status}: ${text.slice(0, 80)}`;
    logger.error({ status: response.status, provider: "pollinations" }, "[ai] provider unavailable");
    throw new Error(sanitizeProviderError(new Error(raw), "generate"));
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 500) {
    throw new Error("Image generation returned an empty response — please try again.");
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const ct = response.headers.get("content-type") ?? "image/jpeg";
  const mime = ct.split(";")[0].trim();

  const result = `data:${mime};base64,${base64}`;
  validateImageResponse(result);

  logger.info(
    { bytes: buffer.byteLength, mime },
    "[imageGen] generation complete",
  );
  return result;
}

// ── IMAGE INPUT: parse and validate ───────────────────────────────────────────

interface ParsedImage {
  mimeType: AcceptedMime;
  base64: string;
}

function parseAndValidateImage(imageDataUrl: string): ParsedImage {
  // Hard failure if not a data URL
  const commaIdx = imageDataUrl.indexOf(",");
  if (commaIdx === -1) {
    throw new Error("No image supplied for editing");
  }

  const header = imageDataUrl.slice(0, commaIdx);
  const base64 = imageDataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+);/);
  const mimeType = mimeMatch?.[1] as string | undefined;

  // MIME validation — only png, jpeg, webp accepted
  if (!mimeType || !(ACCEPTED_MIMES as readonly string[]).includes(mimeType)) {
    logger.warn({ mimeType }, "[imageEdit] edit rejected — unsupported MIME type");
    throw new Error(
      `Unsupported image type: ${mimeType ?? "unknown"}. Accepted: PNG, JPEG, WebP.`,
    );
  }

  // Size limit — reject payloads > 10 MB decoded
  const decodedBytes = Math.floor(base64.length * 0.75);
  if (decodedBytes > MAX_IMAGE_BYTES) {
    logger.warn(
      { decodedBytes },
      "[imageEdit] edit rejected — image exceeds 10 MB size limit",
    );
    throw Object.assign(new Error("Image too large — maximum size is 10 MB"), {
      statusCode: 413,
    });
  }

  return { mimeType: mimeType as AcceptedMime, base64 };
}

// ── TIER 1: True img2img via Gemini image model ────────────────────────────────
// Sends the uploaded image as input and requests an image output from Gemini.
// Returns the result as a data URL, or null if this path is unavailable.

async function tryGeminiImg2Img(
  parsed: ParsedImage,
  prompt: string,
): Promise<string | null> {
  try {
    const { ai } = await import("@workspace/integrations-gemini-ai");

    const result = await Promise.race([
      ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } },
              {
                text: `Edit this image: ${prompt.trim()}. Preserve the same person, face, identity, and overall composition. Apply only the requested visual change.`,
              },
            ],
          },
        ],
        config: { responseModalities: ["IMAGE"] },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          logger.warn({ provider: "gemini" }, "[ai] provider timeout");
          reject(new Error("Gemini img2img timeout"));
        }, GEMINI_TIMEOUT_MS),
      ),
    ]);

    // Look for image output in response parts
    const parts = result.candidates?.[0]?.content?.parts as Array<{
      inlineData?: { mimeType?: string; data?: string };
    }> | undefined;

    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data && part.inlineData?.mimeType) {
          const outputMime = part.inlineData.mimeType;
          const outputBase64 = part.inlineData.data;
          const dataUrl = `data:${outputMime};base64,${outputBase64}`;
          validateImageResponse(dataUrl);
          logger.info(
            { outputMime, bytes: outputBase64.length },
            "[imageEdit] using true img2img",
          );
          return dataUrl;
        }
      }
    }

    // Response contained no image output — model returned text only
    logger.info("[imageEdit] Gemini img2img returned no image — trying grounded fallback");
    return null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), provider: "gemini" },
      "[imageEdit] Gemini img2img unavailable — trying grounded fallback",
    );
    return null;
  }
}

// ── TIER 2: Gemini vision description + FLUX regeneration ─────────────────────
// Gemini analyzes the uploaded image to extract a faithful description,
// which is combined with the edit prompt for grounded FLUX generation.
// Hard failure if Gemini is unavailable (no silent prompt-only fallback).

async function describeImageForEdit(parsed: ParsedImage): Promise<string> {
  const { ai } = await import("@workspace/integrations-gemini-ai");

  const result = await Promise.race([
    ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } },
            {
              text: "Describe this image in 2-3 sentences for use as an AI image generation prompt. Focus on: the main subject (if a person — describe their face shape, hair color/style, skin tone, expression, clothing, age group), the setting/background, and the lighting. Be specific and visual. Output only the description, no preamble.",
            },
          ],
        },
      ],
      config: { temperature: 0.2, maxOutputTokens: 250 },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        logger.warn({ provider: "gemini" }, "[ai] provider timeout");
        reject(new Error("Gemini describe timeout"));
      }, GEMINI_TIMEOUT_MS),
    ),
  ]);

  const description = ((result as { text?: string }).text ?? "").trim();
  if (!description) {
    throw new Error("Image analysis returned empty description");
  }

  logger.info(
    { descriptionLength: description.length },
    "[imageEdit] using grounded fallback",
  );
  return description;
}

async function regenerateWithFlux(editPrompt: string): Promise<string> {
  const enhanced = enhancePrompt(editPrompt);
  const seed = Math.floor(Math.random() * 2_000_000_000);

  const imageUrl =
    `${POLLINATIONS_BASE}/${encodeURIComponent(enhanced)}` +
    `?model=flux&width=1024&height=1024&nologo=true&seed=${seed}&enhance=false`;

  logger.info(
    { provider: "pollinations", seed, prompt: enhanced.slice(0, 100) },
    "[imageGen] editing (Gemini-grounded regeneration)",
  );

  const response = await pollinationsFetch(imageUrl, "edit");

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const raw = `HTTP ${response.status}: ${text.slice(0, 80)}`;
    logger.error({ status: response.status, provider: "pollinations" }, "[ai] provider unavailable");
    throw new Error(sanitizeProviderError(new Error(raw), "edit"));
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 500) {
    throw new Error("Image editing returned an empty response — please try again.");
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const ct = response.headers.get("content-type") ?? "image/jpeg";
  const mime = ct.split(";")[0].trim();
  const result = `data:${mime};base64,${base64}`;

  validateImageResponse(result);
  logger.info({ bytes: buffer.byteLength, mime }, "[imageGen] edit complete");
  return result;
}

// ── editImage: main entry point ────────────────────────────────────────────────

export async function editImage(
  imageBase64: string,
  prompt: string,
): Promise<string> {
  // Hard failure: image is required for edit operations
  if (!imageBase64 || imageBase64.trim().length < 10) {
    logger.warn("[imageEdit] edit rejected — no image supplied");
    throw new Error("No image supplied for editing");
  }

  // Parse + validate MIME type and size
  const parsed = parseAndValidateImage(imageBase64);

  // ── Tier 1: Attempt true img2img via Gemini image model ──────────────────
  const img2imgResult = await tryGeminiImg2Img(parsed, prompt);
  if (img2imgResult) {
    return img2imgResult;
  }

  // ── Tier 2: Gemini description + FLUX regeneration ────────────────────────
  // Hard failure if Gemini description fails — no silent prompt-only fallback.
  let description: string;
  try {
    description = await describeImageForEdit(parsed);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[imageEdit] image analysis failed",
    );
    throw new Error("Image analysis failed. Please retry.");
  }

  const editPrompt = `${description}. Apply this edit: ${prompt.trim()}, highly detailed, sharp focus, professional quality`;
  return regenerateWithFlux(editPrompt);
}
