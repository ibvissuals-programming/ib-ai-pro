/**
 * Image Generation + Editing Service — IB AI Image Studio
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, FLUX model)
 *
 * IMAGE-TO-IMAGE: Unified cinematic render pipeline.
 *
 *   Pipeline:
 *     1. INPUT IMAGE (validate)
 *     2. RENDER PROMPT (user request + optional AI Director analysis)
 *     3. IMAGE MODEL (gemini-2.5-flash-image with identity lock contract)
 *     4. SIMPLE RETRY (once, if model returns no output)
 *
 *   Identity is the only hard constraint.
 *   Everything else — lighting, color, mood, atmosphere — can change freely.
 */
import { logger } from "../lib/logger";
import { saveToHistory } from "./imageHistoryStore";
import {
  createJob,
  advanceJob,
  completeJob,
  failJob,
  jobSummary,
  type ImageJob,
} from "./imageJobManager";

// ── Constants ─────────────────────────────────────────────────────────────────

export const CONTRACT_VERSION = "v6" as const;

const GEMINI_IMG2IMG_MODEL   = "gemini-2.5-flash-image";
const POLLINATIONS_BASE      = "https://image.pollinations.ai/prompt";
const MAX_IMAGE_BYTES        = 10 * 1024 * 1024;
const ACCEPTED_MIMES         = ["image/png", "image/jpeg", "image/webp"] as const;
const RESPONSE_PATTERN       = /^data:image\/(png|jpeg|jpg|webp);base64,/;
const PIPELINE_TIMEOUT_MS    = 45_000;
const ATTEMPT_TIMEOUT_MS     = 20_000;
export const REQUEST_TIMEOUT_MS = 28_000;
export const MAX_POLLINATIONS_RETRIES = 1;

type AcceptedMime = (typeof ACCEPTED_MIMES)[number];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Edit result ───────────────────────────────────────────────────────────────

export interface EditResult {
  b64Image:            string;
  job:                 ReturnType<typeof jobSummary>;
  mode:                string;
  intensity:           string;
  qualityVerified:     boolean;
  qualityIssues:       string[];
  contractVersionUsed: string;
}

// ── Contract config (diagnostic endpoint) ────────────────────────────────────

export function getContractConfig(_debug?: boolean) {
  return {
    contractVersion:  CONTRACT_VERSION,
    model:            GEMINI_IMG2IMG_MODEL,
    pipeline:         ["INPUT_IMAGE", "RENDER_PROMPT", "IMAGE_MODEL", "SIMPLE_RETRY"],
    identityLock:     true,
    freeToChange:     ["lighting", "color_grading", "exposure", "mood", "atmosphere", "background_style"],
  };
}

// ── Prompt expansion (text-to-image) ─────────────────────────────────────────

const QUALITY_SUFFIX = ", ultra realistic, sharp focus, highly detailed, professional quality, 8k";

const STYLE_MAP: Record<string, string> = {
  portrait:     "studio portrait photography, professional lighting, shallow depth of field, bokeh, DSLR, sharp eyes",
  landscape:    "scenic landscape photography, golden hour, vivid colors, wide angle lens, epic scale, dramatic sky",
  product:      "professional product photography, clean white background, studio lighting, sharp details, commercial grade",
  anime:        "anime style illustration, clean line art, vibrant colors, studio quality, detailed background, cel shaded",
  manga:        "manga style illustration, black and white ink, dynamic line weight, expressive characters",
  cartoon:      "cartoon illustration style, bold outlines, flat colors, exaggerated proportions, clean and playful",
  sketch:       "pencil sketch illustration, fine line art, cross-hatching, artistic detail, hand-drawn quality",
  watercolor:   "watercolor illustration, soft washes, painterly texture, artistic brushwork, delicate color bleeding",
  "oil painting": "classical oil painting style, rich textures, impasto technique, museum quality",
  illustration: "professional illustration, detailed artwork, polished digital art, vibrant palette, editorial quality",
  "pixel art":  "pixel art style, 16-bit aesthetic, clean pixels, retro game art, detailed sprite work",
  "3d render":  "3D CGI render, photorealistic materials, global illumination, ray tracing, studio quality",
  "studio ghibli": "Studio Ghibli animation style, painterly backgrounds, soft color palette, whimsical atmosphere",
  impressionist: "impressionist painting style, loose brushwork, light and color play, Monet-inspired, painterly texture",
  "film noir":  "film noir black and white, dramatic shadows, high contrast, moody atmosphere, 1940s cinematic style",
  cinematic:    "cinematic portrait, dramatic 3-point lighting, shallow depth of field, teal-orange color grading, ultra realistic, film grain",
  luxury:       "luxury editorial photography, high-end fashion lighting, soft shadows, premium aesthetic, studio grade, elegant composition",
  "afro luxury": "afro luxury portrait, warm golden tones, cultural elegance, premium styling, rich textures, regal composition, editorial quality",
  cyberpunk:    "cyberpunk aesthetic, neon lights, futuristic cityscape glow, electric blues and magentas, rain-slicked reflections",
  gta:          "GTA V loading screen art style, hyper-detailed illustration, dramatic pose, sharp lines, bold colors",
  pixar:        "Pixar animation style, 3D CGI, expressive character, warm lighting, vibrant colors, movie quality render",
  disney:       "Disney animation style, classic character design, expressive features, magical atmosphere, rich color palette",
  vintage:      "vintage film photography, warm grain, faded highlights, desaturated shadows, nostalgic 35mm aesthetic",
  moody:        "moody low-light photography, dramatic contrast, deep shadows, rich midtones, cinematic tension",
  dramatic:     "dramatic lighting photography, strong directional light, deep shadows, powerful contrast, theatrical atmosphere",
  neon:         "neon-lit photography, vivid electric colors, night scene, reflective surfaces, urban nightlife glow",
  tiktok:       "viral TikTok visual style, sharp contrast, bright attention-focused colors, bold composition, high energy",
  instagram:    "Instagram editorial style, perfect lighting, aesthetically curated, aspirational composition, premium lifestyle",
};

export function enhancePrompt(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const matchedKey = Object.keys(STYLE_MAP)
    .filter((k) => lower.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  const styleExpansion = matchedKey ? `${STYLE_MAP[matchedKey]}, ` : "";
  const alreadyHasQuality =
    lower.includes("quality") || lower.includes("detailed") ||
    lower.includes("professional") || lower.includes(" hd") ||
    lower.includes("8k") || lower.includes("4k") || lower.includes("ultra");
  const suffix = alreadyHasQuality ? "" : QUALITY_SUFFIX;
  return `${styleExpansion}${raw.trim()}${suffix}`;
}

// ── Master identity lock contract ─────────────────────────────────────────────
//
// This is the only hard constraint. It is prepended to every img2img instruction.
// Lighting, color, mood, and atmosphere are explicitly free to change.

const IDENTITY_LOCK_CONTRACT = `You are a cinematic photograph renderer.

TASK: Re-render this image with the visual changes described below.
OUTPUT GOAL: "Same person, new cinematic photograph."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY LOCK — absolute, non-negotiable
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Preserve exactly:
• Same person / face identity
• Same facial geometry (eyes, nose, lips, jaw, cheekbones, forehead)
• Same age appearance and ethnicity
• Same hairstyle shape
• Same body structure and pose (if visible)
• Same background scene geometry and spatial layout

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FREE TO CHANGE — everything else
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Change freely:
• Lighting (direction, quality, intensity, color temperature)
• Color grading (palette, hue balance, saturation, film stock simulation)
• Exposure (shadows, highlights, contrast, tone curve shape)
• Mood and atmosphere (dramatic, warm, cold, cinematic, moody)
• Environment style and cinematic character
• Lens behavior (depth of field, grain, lens character)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• The result must be a real cinematic transformation — not a filter
• The viewer must see a clearly different visual world (new light, new color, new mood)
• The person must be immediately recognizable as the same individual
• Do NOT apply a cosmetic overlay to the original pixels
• Do NOT produce a near-identical result with minor adjustments

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EDIT INSTRUCTION:
`;

// ── Render prompt normalizer ───────────────────────────────────────────────────
//
// Converts any user prompt into a clean cinematic render instruction.
// Maps shorthand ("noir", "sunset", etc.) to explicit visual direction.

const PROMPT_NORMALIZATIONS: Array<{ pattern: RegExp; expansion: string }> = [
  { pattern: /\bnoir\b/i,             expansion: "noir cinematic lighting — deep shadows, high contrast, desaturated tones, dramatic 1940s atmosphere" },
  { pattern: /\bsunset\b/i,           expansion: "golden hour cinematic lighting — warm orange and amber tones, long shadows, soft directional light" },
  { pattern: /\bgolden hour\b/i,      expansion: "golden hour cinematic lighting — warm glowing tones, soft directional light, long shadows" },
  { pattern: /\bbluehour\b|\bblue hour\b/i, expansion: "blue hour twilight lighting — cool blues and purples, soft diffused light, cinematic dusk atmosphere" },
  { pattern: /\bmoody\b/i,            expansion: "moody cinematic atmosphere — rich shadows, muted tones, emotional depth, dramatic tension" },
  { pattern: /\bdramatic\b/i,         expansion: "dramatic cinematic lighting — strong directional light, deep shadow contrast, theatrical atmosphere" },
  { pattern: /\bcyberpunk\b/i,        expansion: "cyberpunk aesthetic — neon-lit scene, electric blues and magentas, futuristic glow, urban night atmosphere" },
  { pattern: /\bvintage\b|\bretro\b/i, expansion: "vintage film look — warm grain, faded highlights, nostalgic 35mm color rendering" },
  { pattern: /\bwarm\b/i,             expansion: "warm cinematic tones — golden light, amber shadows, cozy inviting atmosphere" },
  { pattern: /\bcool\b/i,             expansion: "cool cinematic tones — desaturated blues, cold shadows, clean crisp atmosphere" },
  { pattern: /\bcinematic\b/i,        expansion: "cinematic transformation — professional 3-point lighting, teal-orange color grade, deep shadow contrast, film grain" },
  { pattern: /\bwatercolor\b/i,       expansion: "watercolor artistic rendering — soft painted washes, painterly texture — preserve subject identity and facial structure" },
  { pattern: /\bsketch\b/i,           expansion: "pencil sketch artistic rendering — fine line art, hand-drawn quality — preserve subject identity" },
];

export function normalizeCinematicPrompt(userPrompt: string): string {
  let normalized = userPrompt.trim();

  for (const { pattern, expansion } of PROMPT_NORMALIZATIONS) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, expansion);
      break;
    }
  }

  return `A cinematic re-render of the same person/scene with: ${normalized}`;
}

// ── Response validation ───────────────────────────────────────────────────────

function validateImageResponse(result: string): void {
  if (!RESPONSE_PATTERN.test(result)) {
    throw new Error("Image response validation failed — unexpected format returned");
  }
}

// ── Image input parser + validator ────────────────────────────────────────────

interface ParsedImage {
  mimeType: AcceptedMime;
  base64:   string;
}

function parseAndValidateImage(imageDataUrl: string): ParsedImage {
  const commaIdx = imageDataUrl.indexOf(",");
  if (commaIdx === -1) throw new Error("No image supplied for editing");

  const header    = imageDataUrl.slice(0, commaIdx);
  const base64    = imageDataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+);/);
  const mimeType  = mimeMatch?.[1] as string | undefined;

  if (!mimeType || !(ACCEPTED_MIMES as readonly string[]).includes(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType ?? "unknown"}. Accepted: PNG, JPEG, WebP.`);
  }

  const decodedBytes = Math.floor(base64.length * 0.75);
  if (decodedBytes > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Image too large — maximum size is 10 MB"), { statusCode: 413 });
  }

  return { mimeType: mimeType as AcceptedMime, base64 };
}

// ── Pollinations (text-to-image only) ────────────────────────────────────────

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 402 || status === 503;
}

async function pollinationsFetch(url: string): Promise<Response> {
  let lastErr: Error = new Error("Unknown error");

  for (let attempt = 0; attempt <= MAX_POLLINATIONS_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(1500 * 2 ** (attempt - 1));
      logger.warn({ attempt, provider: "pollinations" }, "[ai] retry attempt");
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "image/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error("Image generation temporarily unavailable — please retry in a moment.");
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    if (isRetryableStatus(response.status)) {
      lastErr = new Error(`HTTP ${response.status}`);
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    return response;
  }

  logger.warn({ provider: "pollinations" }, "[ai] provider unavailable");
  throw new Error("Image generation is temporarily unavailable. Please retry.");
}

// ── TEXT-TO-IMAGE ─────────────────────────────────────────────────────────────

export async function generateImage(prompt: string, userId?: string): Promise<string> {
  const enhanced = enhancePrompt(prompt);
  const seed     = Math.floor(Math.random() * 2_000_000_000);
  const url      = `${POLLINATIONS_BASE}/${encodeURIComponent(enhanced)}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}&enhance=false`;

  logger.info({ provider: "pollinations", seed, prompt: enhanced.slice(0, 100) }, "[imageGen] generating");

  const response = await pollinationsFetch(url);
  if (!response.ok) {
    throw new Error("Image generation is temporarily unavailable. Please retry.");
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 500) {
    throw new Error("Image generation returned an empty response — please try again.");
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const ct     = response.headers.get("content-type") ?? "image/jpeg";
  const mime   = ct.split(";")[0].trim();
  const result = `data:${mime};base64,${base64}`;
  validateImageResponse(result);

  logger.info({ bytes: buffer.byteLength, mime }, "[imageGen] generation complete");

  if (userId) {
    saveToHistory({ userId, type: "generate", prompt, mode: "IMAGE_GENERATION", intensity: "HIGH", b64Image: result })
      .catch((err) => logger.warn({ err }, "[imageHistory] Failed to save generate result"));
  }

  return result;
}

// ── IMG2IMG — single attempt via Gemini ───────────────────────────────────────

async function runImg2Img(
  parsed:      ParsedImage,
  instruction: string,
  timeoutMs:   number,
): Promise<string | null> {
  if (!parsed.base64 || parsed.base64.length < 1000) {
    throw new Error("Invalid image input — image data too short.");
  }

  const { ai } = await import("@workspace/integrations-gemini-ai");

  const fullInstruction = IDENTITY_LOCK_CONTRACT + instruction;

  logger.info(
    { model: GEMINI_IMG2IMG_MODEL, instructionLen: instruction.length },
    "[imageEdit] calling img2img model",
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const result = await Promise.race([
    ai.models.generateContent({
      model: GEMINI_IMG2IMG_MODEL,
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } },
          { text: fullInstruction },
        ],
      }],
      config: { responseModalities: ["TEXT", "IMAGE"], temperature: 1.0 },
    }),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Img2img timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);

  if (timeoutId !== undefined) clearTimeout(timeoutId);

  const candidate = result.candidates?.[0];
  const rawParts  = candidate?.content?.parts as Array<{
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
  }> | undefined;

  const imageParts = rawParts?.filter((p) => p.inlineData?.data) ?? [];

  if (imageParts.length === 0) {
    const textPreview = rawParts?.filter((p) => p.text).map((p) => p.text).join("").slice(0, 200) ?? "";
    logger.warn({ finishReason: (candidate as { finishReason?: string })?.finishReason, textPreview }, "[imageEdit] model returned no image parts");
    return null;
  }

  const part       = imageParts[0]!;
  const outputMime = part.inlineData!.mimeType!;
  const outputData = part.inlineData!.data!;
  const dataUrl    = `data:${outputMime};base64,${outputData}`;
  validateImageResponse(dataUrl);

  logger.info({ outputMime, outputBytes: outputData.length }, "[imageEdit] img2img success");
  return dataUrl;
}

// ── IMAGE-TO-IMAGE PIPELINE ───────────────────────────────────────────────────

export async function editImage(
  imageDataUrl:        string,
  prompt:              string,
  userId?:             string,
  _cinematicProfile?:  string,
  _intensity?:         string,
): Promise<EditResult> {

  const parsed     = parseAndValidateImage(imageDataUrl);
  const jobType    = "IMAGE_EDIT_JOB" as const;
  const mode       = "CINEMATIC_EDIT";
  const intensity  = "HIGH";

  // ── Step 2: Build render prompt ───────────────────────────────────────────
  const renderPrompt = normalizeCinematicPrompt(prompt);

  const job: ImageJob = createJob({
    jobType,
    complexity: "STANDARD",
    intent: mode,
    prompt,
    expandedPrompt: renderPrompt,
  });

  advanceJob(job, "processing", `Render prompt built — calling ${GEMINI_IMG2IMG_MODEL}`);

  const pipelineStartMs = Date.now();

  const succeedEdit = (b64Image: string, retryCount: number): EditResult => {
    const latencyMs = Date.now() - pipelineStartMs;
    completeJob(job, "gemini-img2img");
    if (userId) {
      saveToHistory({
        userId, type: "edit", prompt, mode, intensity, b64Image,
        complexity: "STANDARD", contractVersionUsed: CONTRACT_VERSION,
        model: GEMINI_IMG2IMG_MODEL, status: "success", retryCount, latencyMs,
      }).catch((err) => logger.warn({ err }, "[imageHistory] Failed to save edit result"));
    }
    return {
      b64Image,
      job:                 jobSummary(job),
      mode,
      intensity,
      qualityVerified:     false,
      qualityIssues:       [],
      contractVersionUsed: CONTRACT_VERSION,
    };
  };

  const runPipeline = async (): Promise<EditResult> => {
    try {
      // ── Step 3: Attempt 1 ────────────────────────────────────────────────
      advanceJob(job, "streaming", `Attempt 1 — ${GEMINI_IMG2IMG_MODEL}`);

      let result: string | null = null;
      try {
        result = await runImg2Img(parsed, renderPrompt, ATTEMPT_TIMEOUT_MS);
      } catch (err) {
        logger.error({ err }, "[imageEdit] Attempt 1 failed with API error");
      }

      if (result) return succeedEdit(result, 0);

      // ── Step 4: Simple retry ─────────────────────────────────────────────
      advanceJob(job, "retrying", `Attempt 2 — increasing cinematic strength`);
      logger.info("[imageEdit] Attempt 1 produced no output — retrying with increased strength");

      const retryPrompt = renderPrompt +
        " Push the cinematic transformation harder — stronger lighting contrast, bolder color grade, more dramatic mood shift. Make the visual change clearly visible.";

      let retryResult: string | null = null;
      try {
        retryResult = await runImg2Img(parsed, retryPrompt, ATTEMPT_TIMEOUT_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failJob(job, msg);
        throw new Error("Image editing failed. Please try again.");
      }

      if (retryResult) return succeedEdit(retryResult, 1);

      // Both attempts produced no output
      failJob(job, "Both attempts returned no image output");
      throw new Error("Image editing failed — model returned no output after 2 attempts. Please try a clearer instruction.");

    } catch (err) {
      if (job.status !== "failed") {
        failJob(job, err instanceof Error ? err.message : "Unknown error");
      }
      throw err;
    }
  };

  // Race against global pipeline deadline
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadlinePromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new Error(`Image editing timed out — the request exceeded ${PIPELINE_TIMEOUT_MS / 1000}s. Please try again.`));
    }, PIPELINE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([runPipeline(), deadlinePromise]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}
