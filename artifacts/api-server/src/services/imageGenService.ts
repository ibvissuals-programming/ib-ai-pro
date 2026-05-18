/**
 * Image generation service — IB AI Assistant (Production V4)
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, no auth, FLUX model)
 *
 * IMAGE-TO-IMAGE: Strict img2img-only pipeline (text-to-image fallback BLOCKED for edits).
 *   Tier 1 (primary):  Gemini gemini-2.0-flash-preview-image-generation — img2img, image always attached.
 *   Tier 1 retry:      Same model, escalated EXTREME instruction.
 *   Tier 2 (blocked):  Gemini vision describe → FLUX text-to-image — FORBIDDEN for edits.
 *                      Functions remain in codebase but are NOT invoked from editImage().
 *                      Invoking Tier 2 for an edit request violates img2img enforcement.
 *
 * SECURITY RULE: Every edit request MUST pass the original image to the model.
 *                Any code path that generates from text alone is blocked and logged.
 *
 * LAYER 1: Mode classifier (CINEMATIC_EDIT, SCREENSHOT_CLEANUP, AGGRESSIVE_RECONSTRUCTION, etc.)
 * LAYER 2: Intensity levels (LOW / MEDIUM / HIGH / EXTREME) — controls prompt strength
 * LAYER 3: Screenshot cleanup prompts — reconstruct artifacts naturally
 * LAYER 4: Cinematic lighting engine — physically-grounded relighting, not filter-style
 * LAYER 5: Always retry Tier 1 with escalated instruction on no-op or failure
 * LAYER 6: Similarity validation — reject near-identical outputs, retry with stronger guidance
 * LAYER 7: Persistent image history — saved to disk after every successful operation
 */
import { logger } from "../lib/logger";
import {
  classifyEditMode,
  detectEditIntensity,
  buildStrongInstruction,
  getEditModeLabel,
  classifyImageIntent,
  buildEditInstruction,
  getIntentLabel,
  type ImageIntent,
  type EditMode,
  type EditIntensity,
} from "./imageIntentClassifier";
import {
  createJob,
  advanceJob,
  completeJob,
  failJob,
  jobSummary,
  type ImageJob,
  type ModelUsed,
} from "./imageJobManager";
import {
  classifyComplexity,
  classifyJobType,
  complexityTimeout,
} from "./imageComplexityClassifier";
import { saveToHistory } from "./imageHistoryStore";

const REQUEST_TIMEOUT_MS = 35_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
const RESPONSE_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,/;

const MAX_POLLINATIONS_RETRIES = 2;
const POLLINATIONS_RETRY_BASE_MS = 2_000;

type AcceptedMime = (typeof ACCEPTED_MIMES)[number];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 402 || status === 503;
}

function sanitizeProviderError(
  err: unknown,
  context: "generate" | "edit",
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    lower.includes("timeout") ||
    lower.includes("timedout") ||
    lower.includes("timed out") ||
    lower.includes("aborted")
  ) {
    return `Image ${context} temporarily unavailable — please retry in a moment.`;
  }
  if (
    lower.includes("queue full") ||
    lower.includes("402") ||
    lower.includes("overloaded")
  ) {
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
  return `Image ${context} failed. Please try again.`;
}

// ── Prompt Expansion Engine ───────────────────────────────────────────────────

const QUALITY_SUFFIX =
  ", ultra realistic, sharp focus, highly detailed, professional quality, 8k";

const STYLE_MAP: Record<string, string> = {
  portrait:
    "studio portrait photography, professional lighting, shallow depth of field, bokeh, DSLR, sharp eyes, clean backdrop",
  landscape:
    "scenic landscape photography, golden hour, vivid colors, wide angle lens, epic scale, dramatic sky",
  product:
    "professional product photography, clean white background, studio lighting, sharp details, commercial grade",
  food: "food photography, natural light, shallow depth of field, appetizing, editorial, recipe magazine quality",
  interior:
    "interior design photography, natural lighting, architectural digest style, warm tones, inviting atmosphere",
  art: "digital art, highly detailed, concept art, artstation trending, professional illustration",
  anime:
    "anime style illustration, clean line art, vibrant colors, studio quality, detailed background, cinematic composition, cel shaded",
  manga:
    "manga style illustration, black and white ink, dynamic line weight, expressive characters, screen tone shading",
  cartoon:
    "cartoon illustration style, bold outlines, flat colors, exaggerated proportions, clean and playful",
  sketch:
    "pencil sketch illustration, fine line art, cross-hatching, artistic detail, hand-drawn quality",
  watercolor:
    "watercolor illustration, soft washes, painterly texture, artistic brushwork, delicate color bleeding",
  "oil painting":
    "classical oil painting style, rich textures, impasto technique, museum quality, old masters technique",
  illustration:
    "professional illustration, detailed artwork, polished digital art, vibrant palette, editorial quality",
  "pixel art":
    "pixel art style, 16-bit aesthetic, clean pixels, retro game art, detailed sprite work",
  "3d render":
    "3D CGI render, photorealistic materials, global illumination, ray tracing, studio quality render",
  "studio ghibli":
    "Studio Ghibli animation style, painterly backgrounds, soft color palette, whimsical atmosphere, hand-drawn aesthetic",
  impressionist:
    "impressionist painting style, loose brushwork, light and color play, Monet-inspired, painterly texture",
  "film noir":
    "film noir black and white, dramatic shadows, high contrast, moody atmosphere, 1940s cinematic style",
  cinematic:
    "cinematic portrait, dramatic 3-point lighting, shallow depth of field, anamorphic lens flares, teal-orange color grading, ultra realistic, film grain, 8k detail",
  luxury:
    "luxury editorial photography, high-end fashion lighting, soft shadows, premium aesthetic, studio grade, elegant composition, immaculate detail",
  "afro luxury":
    "afro luxury portrait, warm golden tones, cultural elegance, premium styling, rich textures, regal composition, editorial quality, high-end lighting",
  cyberpunk:
    "cyberpunk aesthetic, neon lights, futuristic cityscape glow, electric blues and magentas, rain-slicked reflections, high-tech dystopia",
  gta: "GTA V loading screen art style, hyper-detailed illustration, dramatic pose, sharp lines, bold colors, action composition",
  pixar:
    "Pixar animation style, 3D CGI, expressive character, warm lighting, vibrant colors, movie quality render, emotional depth",
  disney:
    "Disney animation style, classic character design, expressive features, magical atmosphere, rich color palette, storybook quality",
  vintage:
    "vintage film photography, warm grain, faded highlights, desaturated shadows, nostalgic 35mm aesthetic, soft vignette",
  retro:
    "retro aesthetic, warm tones, analog grain, vintage color palette, nostalgic atmosphere, classic style",
  moody:
    "moody low-light photography, dramatic contrast, deep shadows, rich midtones, emotional atmosphere, cinematic tension",
  dramatic:
    "dramatic lighting photography, strong directional light, deep shadows, powerful contrast, theatrical atmosphere",
  hdr: "HDR realism, ultra detail, high dynamic range, every texture visible, professional photography, extreme clarity",
  neon: "neon-lit photography, vivid electric colors, night scene, reflective surfaces, urban nightlife atmosphere, glow effects",
  "dark mode":
    "dark moody aesthetic, near-black backgrounds, selective illumination, dramatic shadows, premium dark tone",
  tiktok:
    "viral TikTok visual style, sharp contrast, bright attention-focused colors, bold composition, high energy, trending aesthetic",
  viral:
    "viral social media content style, eye-catching composition, bold colors, high contrast, maximum visual impact",
  instagram:
    "Instagram editorial style, perfect lighting, aesthetically curated, aspirational composition, premium lifestyle feel",
  logo: "clean vector logo design, minimalist, professional branding, crisp edges, white background, scalable design",
};

export function enhancePrompt(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const matchedKey = Object.keys(STYLE_MAP)
    .filter((k) => lower.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  const styleExpansion = matchedKey ? `${STYLE_MAP[matchedKey]}, ` : "";
  const alreadyHasQuality =
    lower.includes("quality") ||
    lower.includes("detailed") ||
    lower.includes("professional") ||
    lower.includes(" hd") ||
    lower.includes("8k") ||
    lower.includes("4k") ||
    lower.includes("ultra");
  const suffix = alreadyHasQuality ? "" : QUALITY_SUFFIX;
  return `${styleExpansion}${raw.trim()}${suffix}`;
}

// ── Preservation Lock ────────────────────────────────────────────────────────

const HARD_LOCK_SIGNALS = [
  "preserve",
  "keep exactly",
  "do not change",
  "don't change",
  "protect",
  "leave unchanged",
  "keep the same",
  "maintain exactly",
  "do not modify",
];

function detectPreservationLock(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return HARD_LOCK_SIGNALS.some((s) => lower.includes(s));
}

function buildStructuredPrompt(
  prompt: string,
  hasPreservationLock: boolean,
): string {
  const preservationLayer = hasPreservationLock
    ? "STRICT PRESERVATION — do not alter face, clothing, logos, text, or pose: "
    : "Preserve face identity, clothing textures, logos, and pose — ";
  const coreExpanded = enhancePrompt(prompt);
  return `${preservationLayer}${coreExpanded}`;
}

// ── Response validation ───────────────────────────────────────────────────────

function validateImageResponse(result: string): void {
  if (!RESPONSE_PATTERN.test(result)) {
    throw new Error(
      "Image response validation failed — unexpected format returned",
    );
  }
}

// ── LAYER 6: Near-identical output detection ──────────────────────────────────
// Detects when Gemini returns a visually unchanged image.
// Check 1 (exact): byte-for-byte match → same image.
// Check 2 (size + prefix): size differs < 3% AND first 800 chars match → near-duplicate.

function isNearIdenticalOutput(
  inputBase64: string,
  outputBase64: string,
): boolean {
  // Exact byte match — Gemini returned the original unchanged
  if (outputBase64 === inputBase64) return true;

  const sizeDiff = Math.abs(outputBase64.length - inputBase64.length);
  const sizeRatio = sizeDiff / Math.max(inputBase64.length, 1);

  // Tightened from 1.5% → 3%: catch more near-duplicate re-encodings
  if (sizeRatio < 0.03) {
    // Sizes nearly identical — check a larger prefix window (800 chars)
    const prefixLen = Math.min(800, inputBase64.length, outputBase64.length);
    if (inputBase64.slice(0, prefixLen) === outputBase64.slice(0, prefixLen)) {
      return true;
    }
  }

  return false;
}

// ── Pollinations fetch ────────────────────────────────────────────────────────

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
        logger.warn(
          { attempt: attempt + 1, provider: "pollinations" },
          "[ai] provider timeout",
        );
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
        {
          attempt: attempt + 1,
          status: response.status,
          provider: "pollinations",
        },
        "[ai] retry attempt",
      );
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    return response;
  }

  logger.warn({ provider: "pollinations" }, "[ai] provider unavailable");
  throw new Error(sanitizeProviderError(lastErr, context));
}

// ── TEXT-TO-IMAGE ─────────────────────────────────────────────────────────────

export async function generateImage(
  prompt: string,
  userId?: string,
): Promise<string> {
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
    logger.error(
      { status: response.status, provider: "pollinations" },
      "[ai] provider unavailable",
    );
    throw new Error(sanitizeProviderError(new Error(raw), "generate"));
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
  const result = `data:${mime};base64,${base64}`;
  validateImageResponse(result);

  logger.info({ bytes: buffer.byteLength, mime }, "[imageGen] generation complete");

  // LAYER 7: Persist to history
  if (userId) {
    saveToHistory({
      userId,
      type: "generate",
      prompt,
      mode: "IMAGE_GENERATION",
      intensity: "MEDIUM",
      b64Image: result,
    }).catch((err) =>
      logger.warn({ err }, "[imageHistory] Failed to save generate result"),
    );
  }

  return result;
}

// ── IMAGE INPUT: parse and validate ──────────────────────────────────────────

interface ParsedImage {
  mimeType: AcceptedMime;
  base64: string;
}

function parseAndValidateImage(imageDataUrl: string): ParsedImage {
  const commaIdx = imageDataUrl.indexOf(",");
  if (commaIdx === -1) {
    throw new Error("No image supplied for editing");
  }

  const header = imageDataUrl.slice(0, commaIdx);
  const base64 = imageDataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+);/);
  const mimeType = mimeMatch?.[1] as string | undefined;

  if (!mimeType || !(ACCEPTED_MIMES as readonly string[]).includes(mimeType)) {
    logger.warn({ mimeType }, "[imageEdit] edit rejected — unsupported MIME type");
    throw new Error(
      `Unsupported image type: ${mimeType ?? "unknown"}. Accepted: PNG, JPEG, WebP.`,
    );
  }

  const decodedBytes = Math.floor(base64.length * 0.75);
  if (decodedBytes > MAX_IMAGE_BYTES) {
    logger.warn(
      { decodedBytes },
      "[imageEdit] edit rejected — image exceeds 10 MB size limit",
    );
    throw Object.assign(
      new Error("Image too large — maximum size is 10 MB"),
      { statusCode: 413 },
    );
  }

  return { mimeType: mimeType as AcceptedMime, base64 };
}

// ── TIER 1: Gemini img2img ────────────────────────────────────────────────────
// Model priority order (both pass the original image as inlineData):
//   PRIMARY:  gemini-2.0-flash-preview-image-generation (Google dedicated img2img model)
//   FALLBACK: gemini-2.5-flash-image (Replit proxy alias — also called with image input)
//
// CRITICAL: tryGeminiImg2Img does NOT catch errors.
//   → null return = "response had no image parts" or "near-identical output"
//   → thrown error  = real API failure (propagates to caller for logging)
//   Callers must wrap in try-catch and log the real error body.

const GEMINI_IMG2IMG_MODEL   = "gemini-2.0-flash-preview-image-generation";
const GEMINI_IMG2IMG_FALLBACK = "gemini-2.5-flash-image";

// Returns edited data URL, or null if the response had no usable image output.
// THROWS on API error — callers must catch and log.
async function tryGeminiImg2Img(
  parsed: ParsedImage,
  instruction: string,
  timeoutMs: number,
  model: string = GEMINI_IMG2IMG_MODEL,
): Promise<string | null> {

  // ── IMAGE EDIT PIPELINE START ─────────────────────────────────────────────
  logger.info(
    { stage: "PIPELINE START", model, mimeType: parsed.mimeType, inputBytes: parsed.base64.length },
    "[imageEdit] IMAGE EDIT PIPELINE START",
  );

  // ── IMAGE VALIDATED ───────────────────────────────────────────────────────
  if (!parsed.base64 || parsed.base64.length < 1000) {
    throw new Error(
      `INVALID IMAGE INPUT — base64 too short (${parsed.base64?.length ?? 0} chars). Image must be at least 1000 chars.`,
    );
  }
  if (!parsed.mimeType) {
    throw new Error("INVALID IMAGE INPUT — MIME type missing.");
  }
  // Verify the raw base64 has only valid characters (catch JSON corruption early)
  if (!/^[A-Za-z0-9+/=]+$/.test(parsed.base64.slice(0, 64))) {
    throw new Error("INVALID IMAGE INPUT — base64 appears corrupted (invalid characters at start).");
  }
  logger.info(
    { stage: "IMAGE VALIDATED", model, inputBytes: parsed.base64.length, mimeType: parsed.mimeType },
    "[imageEdit] IMAGE VALIDATED",
  );

  const { ai } = await import("@workspace/integrations-gemini-ai");

  // ── MODEL REQUEST BUILT ───────────────────────────────────────────────────
  const requestPayload = {
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } },
          { text: instruction },
        ],
      },
    ],
    config: { responseModalities: ["TEXT", "IMAGE"] },
  };
  logger.info(
    {
      stage: "MODEL REQUEST BUILT",
      model,
      instruction: instruction.slice(0, 120),
      inlineDataPresent: true,
      inlineDataBytes: parsed.base64.length,
    },
    "[imageEdit] MODEL REQUEST BUILT",
  );

  // ── MODEL CALL SENT ───────────────────────────────────────────────────────
  logger.info({ stage: "MODEL CALL SENT", model, timeoutMs }, "[imageEdit] MODEL CALL SENT");

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // NOTE: errors are NOT caught here — they propagate to the caller.
  const result = await Promise.race([
    ai.models.generateContent(requestPayload),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Gemini img2img timeout after ${timeoutMs}ms (model: ${model})`));
      }, timeoutMs);
    }),
  ]);

  if (timeoutId !== undefined) clearTimeout(timeoutId);

  // ── MODEL RESPONSE RECEIVED ───────────────────────────────────────────────
  const candidate   = result.candidates?.[0];
  const finishReason = (candidate as { finishReason?: string })?.finishReason ?? "UNKNOWN";
  const rawParts = candidate?.content?.parts as Array<{
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
  }> | undefined;
  const textParts  = rawParts?.filter((p) => p.text).map((p) => p.text).join("") ?? "";
  const imageParts = rawParts?.filter((p) => p.inlineData?.data) ?? [];

  logger.info(
    {
      stage: "MODEL RESPONSE RECEIVED",
      model,
      finishReason,
      totalParts: rawParts?.length ?? 0,
      imageParts: imageParts.length,
      textPreview: textParts.slice(0, 120),
    },
    "[imageEdit] MODEL RESPONSE RECEIVED",
  );

  if (imageParts.length === 0) {
    logger.warn(
      { model, finishReason, textPreview: textParts.slice(0, 200), rawPartsCount: rawParts?.length ?? 0 },
      "[imageEdit] model returned NO image parts — response logged above",
    );
    return null;
  }

  // ── Validate and return first usable image part ───────────────────────────
  for (const part of imageParts) {
    const outputMime   = part.inlineData!.mimeType!;
    const outputBase64 = part.inlineData!.data!;

    // LAYER 6: Near-identical output detection
    if (isNearIdenticalOutput(parsed.base64, outputBase64)) {
      logger.warn(
        { model, inputBytes: parsed.base64.length, outputBytes: outputBase64.length },
        "[imageEdit] IMG2IMG FAILED → NO-OP DETECTED — output identical to input",
      );
      return null;
    }

    const dataUrl = `data:${outputMime};base64,${outputBase64}`;
    validateImageResponse(dataUrl);
    logger.info(
      {
        stage: "IMG2IMG SUCCESS",
        model,
        outputMime,
        inputBytes: parsed.base64.length,
        outputBytes: outputBase64.length,
        instruction: instruction.slice(0, 80),
      },
      "[imageEdit] IMG2IMG SUCCESS — transformation confirmed, output differs from input",
    );
    return dataUrl;
  }

  return null;
}

// ── TIER 2: Gemini vision describe + FLUX regeneration ───────────────────────

async function describeImageForEdit(parsed: ParsedImage): Promise<string> {
  const DESCRIBE_TIMEOUT_MS = 25_000;
  const { ai } = await import("@workspace/integrations-gemini-ai");

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

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
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        logger.warn({ provider: "gemini" }, "[ai] provider timeout");
        reject(new Error("Gemini describe timeout"));
      }, DESCRIBE_TIMEOUT_MS);
    }),
  ]);

  if (timeoutId !== undefined) clearTimeout(timeoutId);

  const description = ((result as { text?: string }).text ?? "").trim();
  if (!description) {
    throw new Error("Image analysis returned empty description");
  }

  logger.info(
    { descriptionLength: description.length },
    "[imageEdit] grounded fallback — description ready",
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
    logger.error(
      { status: response.status, provider: "pollinations" },
      "[ai] provider unavailable",
    );
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

// ── EditResult ────────────────────────────────────────────────────────────────

export interface EditResult {
  b64Image: string;
  job: ReturnType<typeof jobSummary>;
  mode: string;
  intensity: string;
}

// ── LAYER 5: Intensity → complexity mapping ───────────────────────────────────
// Determines whether to retry Tier 1 with a stronger prompt or go straight to Tier 2.

function shouldRetryTier1(
  intensity: EditIntensity,
  complexity: ReturnType<typeof classifyComplexity>,
): boolean {
  // Only HIGH/EXTREME or HEAVY complexity retries with stronger prompt
  return intensity === "HIGH" || intensity === "EXTREME" || complexity === "HEAVY";
}

// ── editImage: full orchestration pipeline ────────────────────────────────────

export async function editImage(
  imageBase64: string,
  prompt: string,
  userId?: string,
): Promise<EditResult> {
  if (!imageBase64 || imageBase64.trim().length < 10) {
    logger.warn("[imageEdit] edit rejected — no image supplied");
    throw new Error("No image supplied for editing");
  }

  const parsed = parseAndValidateImage(imageBase64);

  // ── LAYER 0: Classify complexity and job type ──────────────────────────────
  const intent: ImageIntent = classifyImageIntent(prompt, true);
  const complexity = classifyComplexity(prompt);
  const jobType = classifyJobType(intent, true);
  const timeoutMs = complexityTimeout(complexity);

  // ── LAYER 1+2: Mode + intensity classification ─────────────────────────────
  const mode: EditMode = classifyEditMode(prompt, true);
  const intensity: EditIntensity = detectEditIntensity(prompt, mode);

  // ── LAYER 4: Build cinematic/mode-aware instruction (replaces generic prompt) ─
  const primaryInstruction = buildStrongInstruction(mode, intensity, prompt);

  // Escalated instruction for LAYER 6 retry (stronger for non-EXTREME → push to EXTREME)
  const escalatedIntensity: EditIntensity =
    intensity === "EXTREME" ? "EXTREME" : "EXTREME";
  const escalatedInstruction = buildStrongInstruction(
    mode,
    escalatedIntensity,
    prompt +
      " — IMPORTANT: this edit MUST be visually transformative. Make a strong, clearly visible change.",
  );

  // Legacy preservation lock (still respected)
  const hasPreservationLock = detectPreservationLock(prompt);
  const expandedPrompt = buildStructuredPrompt(prompt, hasPreservationLock);

  // Create job
  const job: ImageJob = createJob({
    jobType,
    complexity,
    intent: getEditModeLabel(mode),
    prompt,
    expandedPrompt,
  });

  advanceJob(
    job,
    "processing",
    `Mode: ${getEditModeLabel(mode)} | Intensity: ${intensity} | Complexity: ${complexity}${hasPreservationLock ? " | LOCK" : ""}`,
  );

  // ── Shared success handler ────────────────────────────────────────────────
  const succeedEdit = (b64Image: string): EditResult => {
    completeJob(job, "gemini-img2img");
    if (userId) {
      saveToHistory({
        userId,
        type: "edit",
        prompt,
        mode: getEditModeLabel(mode),
        intensity,
        b64Image,
      }).catch((err) => logger.warn({ err }, "[imageHistory] Failed to save edit result"));
    }
    return { b64Image, job: jobSummary(job), mode: getEditModeLabel(mode), intensity };
  };

  try {
    // ── Attempt 1: Primary model (gemini-2.0-flash-preview-image-generation), primary instruction ──
    advanceJob(job, "streaming", `Attempt 1 — ${GEMINI_IMG2IMG_MODEL} | ${getEditModeLabel(mode)} | ${intensity}`);
    let r1: string | null = null;
    try {
      r1 = await tryGeminiImg2Img(parsed, primaryInstruction, timeoutMs, GEMINI_IMG2IMG_MODEL);
    } catch (err1) {
      logger.error(
        {
          attempt: 1,
          model: GEMINI_IMG2IMG_MODEL,
          error: err1 instanceof Error ? err1.message : String(err1),
        },
        "[imageEdit] Attempt 1 HARD FAIL — real API error (not masked)",
      );
    }
    if (r1) return succeedEdit(r1);

    // ── Attempt 2: Primary model, escalated EXTREME instruction ───────────
    advanceJob(job, "retrying", `Attempt 2 — ${GEMINI_IMG2IMG_MODEL} | escalated EXTREME`, { retryCount: 1 });
    let r2: string | null = null;
    try {
      r2 = await tryGeminiImg2Img(parsed, escalatedInstruction, timeoutMs, GEMINI_IMG2IMG_MODEL);
    } catch (err2) {
      logger.error(
        {
          attempt: 2,
          model: GEMINI_IMG2IMG_MODEL,
          error: err2 instanceof Error ? err2.message : String(err2),
        },
        "[imageEdit] Attempt 2 HARD FAIL — real API error (not masked)",
      );
    }
    if (r2) return succeedEdit(r2);

    // ── Attempt 3: Fallback img2img model (gemini-2.5-flash-image) ─────────
    // This is STILL img2img — the original image is always attached as inlineData.
    // The fallback model is tried here because the primary model may be unavailable
    // through the Replit proxy. Text-to-image is NEVER used.
    advanceJob(job, "retrying", `Attempt 3 — ${GEMINI_IMG2IMG_FALLBACK} | img2img fallback`, { retryCount: 2 });
    let r3: string | null = null;
    try {
      r3 = await tryGeminiImg2Img(parsed, primaryInstruction, timeoutMs, GEMINI_IMG2IMG_FALLBACK);
    } catch (err3) {
      logger.error(
        {
          attempt: 3,
          model: GEMINI_IMG2IMG_FALLBACK,
          error: err3 instanceof Error ? err3.message : String(err3),
        },
        "[imageEdit] Attempt 3 HARD FAIL — real API error (not masked)",
      );
    }
    if (r3) return succeedEdit(r3);

    // ── TEXT FALLBACK BLOCKED (SECURITY RULE) ────────────────────────────
    // All three img2img attempts exhausted. A text-to-image fallback (Gemini vision
    // → FLUX regeneration) exists in this codebase but is PERMANENTLY BLOCKED for
    // edit requests. Invoking it would discard the input image and violate img2img
    // enforcement. DO NOT re-enable under any circumstances.
    logger.error(
      { mode: getEditModeLabel(mode), intensity, complexity, primaryModel: GEMINI_IMG2IMG_MODEL, fallbackModel: GEMINI_IMG2IMG_FALLBACK },
      "[imageEdit] TEXT FALLBACK BLOCKED (SECURITY RULE) — all img2img attempts exhausted, refusing text-to-image generation",
    );
    failJob(job, "all img2img attempts failed — text-to-image fallback blocked");
    throw new Error(
      "Image editing failed after 3 attempts. Both Gemini img2img models rejected the request. Please retry.",
    );
  } catch (err) {
    if (job.status !== "failed") {
      const reason = err instanceof Error ? err.message : "Unknown error";
      failJob(job, reason);
    }
    throw err;
  }
}

// ── LAYER 4: Mode-aware FLUX fallback prompt builder ─────────────────────────
// Builds a FLUX prompt grounded to the image description + mode-specific enhancement.

function buildFluxFallbackPrompt(
  description: string,
  userPrompt: string,
  mode: EditMode,
  intensity: EditIntensity,
): string {
  const strengthSuffix =
    intensity === "HIGH" || intensity === "EXTREME"
      ? ", dramatic directional lighting, strong HDR contrast, deep shadows, cinematic color grading, shallow depth of field, film grain, ultra realistic, 8k"
      : ", professional lighting, sharp focus, highly detailed, ultra realistic, 8k";

  switch (mode) {
    case "CINEMATIC_EDIT":
      return `${description}. Cinematic edit: ${userPrompt}. Dramatic 3-point studio lighting, HDR contrast, teal-orange film grade, anamorphic bokeh${strengthSuffix}`;

    case "SCREENSHOT_CLEANUP":
    case "TEXT_REMOVAL":
      return `${description}. Clean professional photo version, all UI elements and text removed, natural reconstruction${strengthSuffix}`;

    case "AGGRESSIVE_RECONSTRUCTION":
      return `${description}. Fully reconstructed cinematic version: ${userPrompt}. Hollywood lighting, dramatic shadows, premium film grade${strengthSuffix}`;

    case "WALLPAPER_UPGRADE":
      return `${description}. Premium wallpaper version: ${userPrompt}. Cinematic depth, dramatic lighting, epic composition${strengthSuffix}`;

    case "STYLE_TRANSFER":
      return `${description}. Style transfer: ${userPrompt}${strengthSuffix}`;

    default:
      return `${description}. Apply this edit: ${enhancePrompt(userPrompt)}`;
  }
}
