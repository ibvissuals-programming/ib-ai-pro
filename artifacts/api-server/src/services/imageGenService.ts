/**
 * Image generation service — IB AI Assistant (Production V4)
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, no auth, FLUX model)
 *
 * IMAGE-TO-IMAGE: Two-tier pipeline:
 *   Tier 1 (true img2img): Gemini image model — intent+mode+intensity aware.
 *                          Uses cinematic lighting engine for HIGH/EXTREME modes.
 *   Tier 2 (grounded fallback): Gemini vision describe → FLUX regeneration.
 *
 * LAYER 1: Mode classifier (CINEMATIC_EDIT, SCREENSHOT_CLEANUP, AGGRESSIVE_RECONSTRUCTION, etc.)
 * LAYER 2: Intensity levels (LOW / MEDIUM / HIGH / EXTREME) — controls prompt strength
 * LAYER 3: Screenshot cleanup prompts — reconstruct artifacts naturally
 * LAYER 4: Cinematic lighting engine — physically-grounded relighting, not filter-style
 * LAYER 5: Fast path — SIMPLE/LOW skip retry; only HEAVY/EXTREME retries with stronger prompt
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
// Uses mode+intensity aware instructions (LAYER 4 cinematic lighting engine).
// Model: gemini-2.0-flash-preview-image-generation — Google's dedicated img2img
//        editing model. Accepts image input and outputs a MODIFIED image.
//        gemini-2.5-flash-image is text-to-image only and does not support
//        image input editing — never use it here.
// Returns the result as a data URL, or null to trigger fallback.

const GEMINI_IMG2IMG_MODEL = "gemini-2.0-flash-preview-image-generation";

async function tryGeminiImg2Img(
  parsed: ParsedImage,
  instruction: string,
  timeoutMs: number,
): Promise<string | null> {
  logger.info(
    { model: GEMINI_IMG2IMG_MODEL, instruction: instruction.slice(0, 80) },
    "[imageEdit] IMAGE PASSED THROUGH MODEL — Tier 1 Gemini img2img started",
  );

  try {
    const { ai } = await import("@workspace/integrations-gemini-ai");

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const result = await Promise.race([
      ai.models.generateContent({
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
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          logger.warn({ provider: "gemini", model: GEMINI_IMG2IMG_MODEL, timeoutMs }, "[ai] provider timeout");
          reject(new Error("Gemini img2img timeout"));
        }, timeoutMs);
      }),
    ]);

    if (timeoutId !== undefined) clearTimeout(timeoutId);

    const parts = result.candidates?.[0]?.content?.parts as Array<{
      inlineData?: { mimeType?: string; data?: string };
    }> | undefined;

    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data && part.inlineData?.mimeType) {
          const outputMime = part.inlineData.mimeType;
          const outputBase64 = part.inlineData.data;

          // LAYER 6: Near-identical output detection
          // Threshold tightened: catch exact copies and near-duplicates up to 3% size diff
          if (isNearIdenticalOutput(parsed.base64, outputBase64)) {
            logger.warn(
              { provider: "gemini", model: GEMINI_IMG2IMG_MODEL, outputBytes: outputBase64.length },
              "[imageEdit] NO-OP DETECTED → FIXING PIPELINE — near-identical output, retrying with stronger instruction",
            );
            return null;
          }

          const dataUrl = `data:${outputMime};base64,${outputBase64}`;
          validateImageResponse(dataUrl);
          logger.info(
            {
              model: GEMINI_IMG2IMG_MODEL,
              outputMime,
              inputBytes: parsed.base64.length,
              outputBytes: outputBase64.length,
              instruction: instruction.slice(0, 80),
            },
            "[imageEdit] IMAGE EDIT APPLIED — Gemini img2img transformation confirmed",
          );
          return dataUrl;
        }
      }
    }

    logger.warn(
      { model: GEMINI_IMG2IMG_MODEL },
      "[imageEdit] Gemini img2img returned no image parts — triggering Tier 2 fallback",
    );
    return null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), model: GEMINI_IMG2IMG_MODEL },
      "[imageEdit] Gemini img2img unavailable — triggering Tier 2 fallback",
    );
    return null;
  }
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

  try {
    // ── Tier 1: Gemini img2img with cinematic instruction ──────────────────
    advanceJob(
      job,
      "streaming",
      `Tier 1 — Gemini img2img | ${getEditModeLabel(mode)} | ${intensity} (${timeoutMs}ms)`,
    );

    let img2imgResult = await tryGeminiImg2Img(
      parsed,
      primaryInstruction,
      timeoutMs,
    );

    if (img2imgResult) {
      completeJob(job, "gemini-img2img");
      // LAYER 7: persist to history
      if (userId) {
        saveToHistory({
          userId,
          type: "edit",
          prompt,
          mode: getEditModeLabel(mode),
          intensity,
          b64Image: img2imgResult,
        }).catch((err) =>
          logger.warn({ err }, "[imageHistory] Failed to save edit result"),
        );
      }
      return {
        b64Image: img2imgResult,
        job: jobSummary(job),
        mode: getEditModeLabel(mode),
        intensity,
      };
    }

    // ── LAYER 5+6: Always retry Tier 1 on near-identical / for HIGH/EXTREME/HEAVY ──
    // Any no-op detection triggers a retry with escalated instruction regardless of intensity.
    if (true || shouldRetryTier1(intensity, complexity)) {
      advanceJob(job, "retrying", "Tier 1 retry — escalated cinematic instruction", {
        retryCount: 1,
      });
      img2imgResult = await tryGeminiImg2Img(
        parsed,
        escalatedInstruction,
        timeoutMs,
      );
      if (img2imgResult) {
        completeJob(job, "gemini-img2img");
        if (userId) {
          saveToHistory({
            userId,
            type: "edit",
            prompt,
            mode: getEditModeLabel(mode),
            intensity,
            b64Image: img2imgResult,
          }).catch((err) =>
            logger.warn({ err }, "[imageHistory] Failed to save edit result"),
          );
        }
        return {
          b64Image: img2imgResult,
          job: jobSummary(job),
          mode: getEditModeLabel(mode),
          intensity,
        };
      }
    }

    // ── Tier 2: Gemini vision describe + FLUX regeneration ────────────────
    logger.warn(
      { mode: getEditModeLabel(mode), intensity, complexity },
      "[imageEdit] Tier 1 exhausted — falling back to Tier 2 (Gemini vision → FLUX render)",
    );
    advanceJob(job, "streaming", "Tier 2 — Gemini vision → FLUX render", {
      modelUsed: "gemini-vision",
    });

    let description: string;
    try {
      description = await describeImageForEdit(parsed);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Gemini describe failed";
      failJob(job, reason);
      throw new Error("Image analysis failed. Please retry.");
    }

    // Build a mode-aware FLUX prompt
    const fluxPrompt = buildFluxFallbackPrompt(description, prompt, mode, intensity);

    advanceJob(job, "streaming", "FLUX rendering", { modelUsed: "flux" });
    const fluxResult = await regenerateWithFlux(fluxPrompt);

    completeJob(job, "flux");
    if (userId) {
      saveToHistory({
        userId,
        type: "edit",
        prompt,
        mode: getEditModeLabel(mode),
        intensity,
        b64Image: fluxResult,
      }).catch((err) =>
        logger.warn({ err }, "[imageHistory] Failed to save edit result"),
      );
    }
    return {
      b64Image: fluxResult,
      job: jobSummary(job),
      mode: getEditModeLabel(mode),
      intensity,
    };
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
