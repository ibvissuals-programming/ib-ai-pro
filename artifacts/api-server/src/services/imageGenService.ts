/**
 * Image generation service — IB AI Assistant
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, no auth, FLUX model)
 *                 image.pollinations.ai — verified working in this environment
 *
 * IMAGE-TO-IMAGE: HuggingFace router (free account token required)
 *                 router.huggingface.co — verified working endpoint (401 with bad key)
 *                 NOTE: api-inference.huggingface.co is blocked by env proxy; use router instead
 *
 * Env vars:
 *   HUGGINGFACE_API_KEY — required ONLY for /api/image/edit
 *                         Free token: huggingface.co/settings/tokens
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

// ── IMAGE-TO-IMAGE: HuggingFace router ────────────────────────────────────────
// Uses router.huggingface.co — verified reachable (returns 401 with invalid key).
// api-inference.huggingface.co is blocked by this environment's proxy; do NOT use it.
// Requires HUGGINGFACE_API_KEY (free account, no payment needed).

const HF_ROUTER_BASE = "https://router.huggingface.co/hf-inference/models";
const IMAGE_TO_IMAGE_MODEL = "timbrooks/instruct-pix2pix";

export async function editImage(
  imageBase64: string,
  prompt: string,
): Promise<string> {
  const token = process.env.HUGGINGFACE_API_KEY;
  if (!token) {
    throw new Error(
      "Image editing requires a free HuggingFace token. " +
        "Add HUGGINGFACE_API_KEY to Replit Secrets — " +
        "get a free token at huggingface.co/settings/tokens.",
    );
  }

  const enhanced = enhancePrompt(prompt);
  // Strip data URL prefix — HuggingFace expects raw base64
  const rawBase64 = imageBase64.replace(/^data:[^;]+;base64,/, "");

  logger.info(
    {
      provider: "huggingface-router",
      model: IMAGE_TO_IMAGE_MODEL,
      prompt: enhanced.slice(0, 100),
    },
    "[imageGen] editing",
  );

  let response: Response;
  try {
    response = await fetch(`${HF_ROUTER_BASE}/${IMAGE_TO_IMAGE_MODEL}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: rawBase64,
        parameters: {
          prompt: enhanced,
          guidance_scale: 7.5,
          image_guidance_scale: 1.5,
          num_inference_steps: 20,
          strength: 0.6,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        "Image editing timed out (35s) — the model may be busy. Please try again.",
      );
    }
    throw new Error(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "HUGGINGFACE_API_KEY is invalid or expired. " +
        "Get a new free token at huggingface.co/settings/tokens.",
    );
  }

  if (response.status === 503) {
    const json = (await response.json().catch(() => ({}))) as {
      estimated_time?: number;
    };
    const wait = json.estimated_time;
    throw new Error(
      wait
        ? `Model warming up — retry in ${Math.ceil(wait)} seconds`
        : "Image editing service temporarily unavailable — please try again.",
    );
  }

  if (response.status === 429) {
    throw new Error(
      "HuggingFace rate limit reached — please wait before editing again.",
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
  const ct = response.headers.get("content-type") ?? "image/png";
  const mime = ct.split(";")[0].trim();

  logger.info({ bytes: buffer.byteLength, mime }, "[imageGen] edit complete");
  return `data:${mime};base64,${base64}`;
}
