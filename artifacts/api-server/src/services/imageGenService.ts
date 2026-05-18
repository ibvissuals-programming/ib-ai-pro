/**
 * Image generation service — IB AI Assistant (Production V5)
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, no auth, FLUX model)
 *
 * IMAGE-TO-IMAGE: Single-model deterministic img2img pipeline.
 *   PRIMARY MODEL: gemini-2.0-flash-preview-image-generation
 *   RETRY:         Same model, escalated EXTREME instruction (no-op recovery only)
 *   FALLBACK:      NONE — if the primary model fails, the request fails immediately.
 *
 * ══════════════════════════════════════════════════════════════════════
 * IMG2IMG ENFORCEMENT CONTRACT (non-negotiable)
 * ══════════════════════════════════════════════════════════════════════
 * 1. The input image MUST be passed as inlineData conditioning on every call.
 * 2. If the model cannot accept image input → it MUST NOT be used.
 * 3. Text-to-image fallback for edit requests is PERMANENTLY REMOVED.
 *    describeImageForEdit / regenerateWithFlux / buildFluxFallbackPrompt
 *    DO NOT EXIST in this file. Do not re-add them.
 * 4. A second model (gemini-2.5-flash-image) is NOT a fallback for edits.
 *    It was removed. Do not re-add it.
 * 5. On total failure: throw immediately. No approximation. No simulation.
 * ══════════════════════════════════════════════════════════════════════
 *
 * LAYER 1: Mode classifier (CINEMATIC_EDIT, SCREENSHOT_CLEANUP, etc.)
 * LAYER 2: Intensity levels (LOW / MEDIUM / HIGH / EXTREME)
 * LAYER 3: Screenshot cleanup prompts — reconstruct artifacts naturally
 * LAYER 4: Cinematic lighting engine — physically-grounded relighting
 * LAYER 5: Same-model retry with EXTREME instruction on no-op detection
 * LAYER 6: Similarity validation — reject near-identical outputs
 * LAYER 7: Persistent image history — saved after every successful operation
 */
import { logger } from "../lib/logger";
import {
  classifyEditMode,
  detectEditIntensity,
  buildStrongInstruction,
  getEditModeLabel,
  classifyImageIntent,
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
  if (outputBase64 === inputBase64) return true;

  const sizeDiff = Math.abs(outputBase64.length - inputBase64.length);
  const sizeRatio = sizeDiff / Math.max(inputBase64.length, 1);

  if (sizeRatio < 0.03) {
    const prefixLen = Math.min(800, inputBase64.length, outputBase64.length);
    if (inputBase64.slice(0, prefixLen) === outputBase64.slice(0, prefixLen)) {
      return true;
    }
  }

  return false;
}

// ── Pollinations fetch ────────────────────────────────────────────────────────
// Used only by generateImage (text-to-image). NOT used by editImage.

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

// ── IMG2IMG PRIMARY MODEL ─────────────────────────────────────────────────────
// The ONLY model used for image editing in this system.
// All edits MUST pass the original image as inlineData conditioning.
// A second model MUST NOT be substituted here under any circumstances.

const GEMINI_IMG2IMG_MODEL = "gemini-2.0-flash-preview-image-generation";

// Returns edited data URL, or null if the response had no usable image output
// (no-op / near-identical). THROWS on real API error — callers must catch.
async function tryGeminiImg2Img(
  parsed: ParsedImage,
  instruction: string,
  timeoutMs: number,
): Promise<string | null> {

  // ── IMG2IMG INPUT VALIDATED ───────────────────────────────────────────────
  logger.info(
    {
      stage: "IMG2IMG INPUT VALIDATED",
      model: GEMINI_IMG2IMG_MODEL,
      mimeType: parsed.mimeType,
      inputBytes: parsed.base64.length,
    },
    "[imageEdit] IMG2IMG INPUT VALIDATED",
  );

  if (!parsed.base64 || parsed.base64.length < 1000) {
    throw new Error(
      `INVALID IMAGE INPUT — base64 too short (${parsed.base64?.length ?? 0} chars). Image must be at least 1000 chars.`,
    );
  }
  if (!parsed.mimeType) {
    throw new Error("INVALID IMAGE INPUT — MIME type missing.");
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(parsed.base64.slice(0, 64))) {
    throw new Error("INVALID IMAGE INPUT — base64 appears corrupted (invalid characters at start).");
  }

  const { ai } = await import("@workspace/integrations-gemini-ai");

  // ── IMG2IMG MODE ACTIVE ───────────────────────────────────────────────────
  const requestPayload = {
    model: GEMINI_IMG2IMG_MODEL,
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
      stage: "IMG2IMG MODE ACTIVE",
      model: GEMINI_IMG2IMG_MODEL,
      instruction: instruction.slice(0, 120),
      inlineDataPresent: true,
      inlineDataBytes: parsed.base64.length,
      timeoutMs,
    },
    "[imageEdit] IMG2IMG MODE ACTIVE — image attached as conditioning input",
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const result = await Promise.race([
    ai.models.generateContent(requestPayload),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Gemini img2img timeout after ${timeoutMs}ms (model: ${GEMINI_IMG2IMG_MODEL})`));
      }, timeoutMs);
    }),
  ]);

  if (timeoutId !== undefined) clearTimeout(timeoutId);

  // ── MODEL RESPONSE RECEIVED ───────────────────────────────────────────────
  const candidate    = result.candidates?.[0];
  const finishReason = (candidate as { finishReason?: string })?.finishReason ?? "UNKNOWN";
  const rawParts     = candidate?.content?.parts as Array<{
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
  }> | undefined;
  const textParts  = rawParts?.filter((p) => p.text).map((p) => p.text).join("") ?? "";
  const imageParts = rawParts?.filter((p) => p.inlineData?.data) ?? [];

  logger.info(
    {
      stage: "MODEL RESPONSE RECEIVED",
      model: GEMINI_IMG2IMG_MODEL,
      finishReason,
      totalParts: rawParts?.length ?? 0,
      imageParts: imageParts.length,
      textPreview: textParts.slice(0, 120),
    },
    "[imageEdit] MODEL RESPONSE RECEIVED",
  );

  if (imageParts.length === 0) {
    logger.warn(
      {
        model: GEMINI_IMG2IMG_MODEL,
        finishReason,
        textPreview: textParts.slice(0, 200),
        rawPartsCount: rawParts?.length ?? 0,
      },
      "[imageEdit] model returned NO image parts",
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
        {
          model: GEMINI_IMG2IMG_MODEL,
          inputBytes: parsed.base64.length,
          outputBytes: outputBase64.length,
        },
        "[imageEdit] NO-OP DETECTED — output identical to input, will retry with escalated prompt",
      );
      return null;
    }

    const dataUrl = `data:${outputMime};base64,${outputBase64}`;
    validateImageResponse(dataUrl);

    logger.info(
      {
        stage: "IMG2IMG SUCCESS",
        model: GEMINI_IMG2IMG_MODEL,
        outputMime,
        outputBytes: outputBase64.length,
        instruction: instruction.slice(0, 80),
      },
      "[imageEdit] IMG2IMG SUCCESS — transformation confirmed, output differs from input",
    );
    return dataUrl;
  }

  return null;
}

// ── EditResult ────────────────────────────────────────────────────────────────

export interface EditResult {
  b64Image: string;
  job: ReturnType<typeof jobSummary>;
  mode: string;
  intensity: string;
}

// ── editImage: deterministic single-model img2img pipeline ───────────────────
//
// CONTRACT:
//   - Input image is ALWAYS attached as inlineData conditioning (never dropped).
//   - Only gemini-2.0-flash-preview-image-generation is used.
//   - Attempt 1: primary instruction.
//   - Attempt 2: same model, EXTREME escalated instruction (no-op recovery only).
//   - On failure after both attempts: throw immediately. No fallback. No generation.
//
// WHAT THIS FUNCTION WILL NEVER DO:
//   - Call a second model.
//   - Describe the image and regenerate from text.
//   - Use FLUX or any external text-to-image provider as a substitute.
//   - Return a synthetically generated image when an edit was requested.

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

  logger.info(
    {
      userId,
      promptLength: prompt.length,
      prompt: prompt.slice(0, 80),
      imageMime: parsed.mimeType,
      imageBytes: parsed.base64.length,
      imageAttached: true,
      model: GEMINI_IMG2IMG_MODEL,
    },
    "[imageEdit] pipeline entered — IMG2IMG ONLY, single model, image validated and attached",
  );

  // ── LAYER 0: Classify complexity and job type ──────────────────────────────
  const intent: ImageIntent = classifyImageIntent(prompt, true);
  const complexity           = classifyComplexity(prompt);
  const jobType              = classifyJobType(intent, true);
  const timeoutMs            = complexityTimeout(complexity);

  // ── LAYER 1+2: Mode + intensity classification ─────────────────────────────
  const mode: EditMode        = classifyEditMode(prompt, true);
  const intensity: EditIntensity = detectEditIntensity(prompt, mode);

  // ── LAYER 4: Build cinematic/mode-aware instruction ────────────────────────
  const primaryInstruction = buildStrongInstruction(mode, intensity, prompt);

  // Escalated instruction for same-model no-op retry (Attempt 2)
  const escalatedInstruction = buildStrongInstruction(
    mode,
    "EXTREME",
    prompt +
      " — IMPORTANT: this edit MUST be visually transformative. Make a strong, clearly visible change.",
  );

  const hasPreservationLock  = detectPreservationLock(prompt);
  const expandedPrompt       = buildStructuredPrompt(prompt, hasPreservationLock);

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

  const attemptErrors: string[] = [];

  try {
    // ── Attempt 1: Primary model, primary instruction ──────────────────────────
    advanceJob(
      job,
      "streaming",
      `Attempt 1 — ${GEMINI_IMG2IMG_MODEL} | ${getEditModeLabel(mode)} | ${intensity}`,
    );

    let r1: string | null = null;
    try {
      r1 = await tryGeminiImg2Img(parsed, primaryInstruction, timeoutMs);
    } catch (err1) {
      const msg1 = err1 instanceof Error ? err1.message : String(err1);
      attemptErrors.push(`Attempt 1 [${GEMINI_IMG2IMG_MODEL}]: ${msg1}`);
      logger.error(
        { attempt: 1, model: GEMINI_IMG2IMG_MODEL, error: msg1 },
        "[imageEdit] Attempt 1 HARD FAIL — real API error",
      );
    }
    if (r1) return succeedEdit(r1);

    // ── Attempt 2: Same model, EXTREME escalated instruction ──────────────────
    // Triggered only when Attempt 1 returned null (no-op / no image parts).
    // This is NOT a fallback to a different model — it is a prompt-level retry
    // on the identical model to recover from near-identical or empty output.
    advanceJob(
      job,
      "retrying",
      `Attempt 2 — ${GEMINI_IMG2IMG_MODEL} | EXTREME escalated (no-op recovery)`,
      { retryCount: 1 },
    );

    let r2: string | null = null;
    try {
      r2 = await tryGeminiImg2Img(parsed, escalatedInstruction, timeoutMs);
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      attemptErrors.push(`Attempt 2 [${GEMINI_IMG2IMG_MODEL} escalated]: ${msg2}`);
      logger.error(
        { attempt: 2, model: GEMINI_IMG2IMG_MODEL, error: msg2 },
        "[imageEdit] Attempt 2 HARD FAIL — real API error",
      );
    }
    if (r2) return succeedEdit(r2);

    // ── ALL ATTEMPTS EXHAUSTED — FAIL IMMEDIATELY ─────────────────────────────
    // No fallback. No text-to-image. No second model. Hard stop.
    const failReason =
      attemptErrors.length > 0
        ? `img2img failed after 2 attempts:\n${attemptErrors.join("\n")}`
        : "img2img returned no image output after 2 attempts (no-op or near-identical) — please retry with a clearer instruction.";

    logger.error(
      {
        model: GEMINI_IMG2IMG_MODEL,
        mode: getEditModeLabel(mode),
        intensity,
        complexity,
        attemptErrors,
        fallback: "NONE — text-to-image fallback permanently removed",
      },
      "[imageEdit] IMG2IMG FAILED — no fallback, returning error to caller",
    );

    failJob(job, failReason);
    throw new Error(
      attemptErrors.length > 0
        ? `Image editing failed — ${failReason}`
        : "Image editing failed after 2 attempts — model returned no visible change. Please retry with a clearer instruction.",
    );
  } catch (err) {
    if (job.status !== "failed") {
      const reason = err instanceof Error ? err.message : "Unknown error";
      failJob(job, reason);
    }
    throw err;
  }
}
