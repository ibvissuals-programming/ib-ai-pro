/**
 * Image generation service — IB AI Assistant
 *
 * Uses HuggingFace Inference API (free tier) as the primary provider.
 * No fallback AI responses — explicit errors only.
 *
 * Env vars:
 *   HUGGINGFACE_API_KEY  — free token from huggingface.co/settings/tokens
 *                          Required. Without it, HF blocks most requests.
 */
import { logger } from "../lib/logger";

const HF_BASE = "https://api-inference.huggingface.co/models";
const TEXT_TO_IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell";
const IMAGE_TO_IMAGE_MODEL = "timbrooks/instruct-pix2pix";
const REQUEST_TIMEOUT_MS = 28_000;

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
};

export function enhancePrompt(raw: string): string {
  const lower = raw.toLowerCase().trim();

  const styleKey = Object.keys(STYLE_MAP).find((k) => lower.includes(k));
  const stylePrefix = styleKey ? `${STYLE_MAP[styleKey]}, ` : "";

  const alreadyHasQuality =
    lower.includes("quality") ||
    lower.includes("detailed") ||
    lower.includes("professional") ||
    lower.includes("hd") ||
    lower.includes("8k");

  const suffix = alreadyHasQuality ? "" : QUALITY_SUFFIX;
  return `${stylePrefix}${raw.trim()}${suffix}`;
}

// ── HuggingFace fetch helper ───────────────────────────────────────────────────

async function callHuggingFace(
  model: string,
  payload: unknown,
): Promise<string> {
  const token = process.env.HUGGINGFACE_API_KEY;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${HF_BASE}/${model}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        "Image generation timed out — the model took too long. Please try again.",
      );
    }
    throw new Error(
      `Network error reaching HuggingFace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Model loading — HF returns 503 + estimated_time when cold-starting
  if (response.status === 503) {
    const json = (await response.json().catch(() => ({}))) as {
      estimated_time?: number;
      error?: string;
    };
    const wait = json.estimated_time;
    throw new Error(
      wait
        ? `Model is warming up — retry in ${Math.ceil(wait)} seconds`
        : "Image service temporarily unavailable — model loading. Please try again shortly.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "HUGGINGFACE_API_KEY is missing or invalid. Add a free token from huggingface.co/settings/tokens to Replit Secrets.",
    );
  }

  if (response.status === 429) {
    throw new Error(
      "HuggingFace rate limit reached — please wait a moment before generating again.",
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `HuggingFace error ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  // Response is raw binary image bytes
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const ct = response.headers.get("content-type") ?? "image/png";
  const mime = ct.split(";")[0].trim();
  return `data:${mime};base64,${base64}`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate an image from a text prompt using FLUX.1-schnell.
 * Returns a base64 data URL.
 */
export async function generateImage(prompt: string): Promise<string> {
  const enhanced = enhancePrompt(prompt);
  logger.info(
    { model: TEXT_TO_IMAGE_MODEL, prompt: enhanced.slice(0, 100) },
    "[imageGen] generating",
  );

  return callHuggingFace(TEXT_TO_IMAGE_MODEL, {
    inputs: enhanced,
    parameters: {
      // FLUX.1-schnell is optimised for 4 steps at guidance_scale=0
      num_inference_steps: 4,
      guidance_scale: 0,
    },
  });
}

/**
 * Edit an existing image using an instruction prompt (instruct-pix2pix).
 * imageBase64 — raw base64 or data URL.
 * Returns a base64 data URL.
 */
export async function editImage(
  imageBase64: string,
  prompt: string,
): Promise<string> {
  const enhanced = enhancePrompt(prompt);
  logger.info(
    { model: IMAGE_TO_IMAGE_MODEL, prompt: enhanced.slice(0, 100) },
    "[imageGen] editing",
  );

  // Strip the data URL prefix — HF expects raw base64
  const rawBase64 = imageBase64.replace(/^data:[^;]+;base64,/, "");

  return callHuggingFace(IMAGE_TO_IMAGE_MODEL, {
    inputs: rawBase64,
    parameters: {
      prompt: enhanced,
      guidance_scale: 7.5,
      image_guidance_scale: 1.5,
      num_inference_steps: 20,
      strength: 0.6,
    },
  });
}
