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
 * LAYER 8: Quality Enforcement Verifier — post-edit Gemini vision check for
 *           identity drift, scene regeneration, background replacement.
 *           Mode-aware tiers: STRICT / IDENTITY / LOOSE.
 *           Verifier failure → pass-through (never blocks on infra noise).
 *           Quality failure → preservation retry → second fail → hard reject.
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

// ── IMG2IMG MASTER CONTRACT ───────────────────────────────────────────────────
// This preamble is prepended to EVERY instruction sent to the img2img model.
// It encodes the pixel-anchor / immutability contract that must hold for every
// edit request, regardless of mode or intensity.
//
// DO NOT remove or shorten this contract. It is the primary mechanism that
// prevents the model from drifting into generative / reconstructive behavior.

const IMG2IMG_MASTER_CONTRACT = `SYSTEM ROLE: You are a deterministic Lightroom-style photo correction engine operating in STRICT IMG2IMG MODE ONLY.

You are NOT a generative model. You are NOT a creative model. You are NOT allowed to reconstruct, reinterpret, or regenerate images.
Your ONLY job: enhance real images while preserving structure completely.
Your purpose: perform real photographic enhancement using controlled, realistic adjustments — exactly like Lightroom or Photoshop.

════════════════════════════════════════
IMAGE IMMUTABILITY CONTRACT (ABSOLUTE)
════════════════════════════════════════
The input image is the ONLY source of truth. It is a real photograph and MUST remain structurally unchanged.

You MUST preserve 100%:
✔ Same identity (exact person)
✔ Same face structure (bone structure unchanged)
✔ Same pose and body position
✔ Same camera angle
✔ Same composition
✔ Same background and environment

ANY deviation = INVALID OUTPUT. No exceptions.

════════════════════════════════════════
BACKGROUND FREEZE (CRITICAL)
════════════════════════════════════════
Background must remain EXACTLY the same:
- structurally identical
- object-for-object preserved (every object stays in exactly the same position)
- spatially unchanged

ONLY allowed changes:
✔ lighting correction across the existing background
✔ color tone adjustment consistent with the existing background

FORBIDDEN:
✖ replacing background
✖ modifying environment
✖ adding or removing objects
✖ scene reconstruction of any kind

ANY background replacement or reconstruction = AUTOMATIC FAILURE.

════════════════════════════════════════
IDENTITY PROTECTION (CRITICAL — NEVER VIOLATE)
════════════════════════════════════════
Face must remain identical:
✔ Bone structure — locked
✔ Eyes, nose, lips — locked
✔ Jawline — locked
✔ Proportions — locked
✔ Expression — locked

FORBIDDEN:
✖ beautification that changes identity
✖ AI face reconstruction
✖ smoothing that removes real skin texture or pores

════════════════════════════════════════
IMG2IMG ENFORCEMENT RULE
════════════════════════════════════════
The input image MUST be used as conditioning input.

If image is not used directly:
→ FAIL IMMEDIATELY

If image is missing or invalid:
→ STOP IMMEDIATELY — no fallback generation permitted

NEVER convert image → text → new image.

════════════════════════════════════════
LIGHTROOM MODE — ONLY ALLOWED OPERATIONS
════════════════════════════════════════
You are restricted to NON-DESTRUCTIVE photo editing. You are editing pixels, NOT recreating the image.

✔ Exposure correction — lift underexposed areas, recover blown highlights
✔ Contrast adjustment — natural tonal distribution, not crushing
✔ White balance correction — remove color cast, achieve accurate neutral tones
✔ Color grading — natural, cinematic but realistic, non-destructive
✔ Shadow/highlight balancing
✔ Mild natural sharpening — edges and texture only, not face-wide
✔ Noise reduction — reduce grain while preserving real skin texture and pores
✔ Skin texture preservation — DO NOT smooth into plastic; preserve pores and natural imperfections
✔ Lighting normalization — normalize existing light WITHOUT changing its direction

STRICT RULE: NO structural modification is allowed under any circumstances.

════════════════════════════════════════
FORBIDDEN OPERATIONS
════════════════════════════════════════
✖ regenerate the image
✖ recreate the scene
✖ change the background
✖ change the identity
✖ change the pose
✖ add or remove objects
✖ rebuild the composition
✖ convert to AI art, illustration, or CGI
✖ produce any stylized reinterpretation
✖ perform global scene reconstruction
✖ apply enhancements that make the image look AI-generated

════════════════════════════════════════
ANTI-AI LOOK SYSTEM (CRITICAL)
════════════════════════════════════════
Output MUST NOT look AI-generated. It MUST look like a real camera edit.

AVOID:
✖ plastic skin or poreless smoothing
✖ over-sharpening or sharpening halos
✖ HDR overprocessing (crushed blacks, blown highlights)
✖ fake cinematic glow or artificial bloom
✖ artificial depth exaggeration or fake bokeh
✖ overly smooth faces
✖ unrealistic contrast curves

TARGET:
✔ Real DSLR / iPhone edited photograph
✔ Lightroom / Photoshop natural finish
✔ Output indistinguishable from real camera photo post-processing

════════════════════════════════════════
QUALITY ENFORCEMENT SYSTEM
════════════════════════════════════════
After generating output, an independent quality layer will verify:
✔ identity match
✔ face consistency
✔ pose consistency
✔ background unchanged
✔ composition unchanged

If ANY mismatch is detected:
→ the edit will be marked INVALID EDIT
→ a retry will be triggered ONCE at reduced intensity (exposure + contrast + white balance ONLY)
→ second failure = HARD FAIL (no fallback generation delivered)

Verifier failure (technical error):
→ pass-through with warning only

The safest strategy: make the minimum change needed to apply the requested enhancement, and preserve everything else exactly. Produce output that will PASS this verification on the first attempt.

════════════════════════════════════════
RETRY BEHAVIOR RULE
════════════════════════════════════════
If a retry is triggered (quality fail or no-op detection):

Reduce ALL edits to ONLY:
✔ exposure correction
✔ contrast adjustment
✔ white balance correction

NO stylistic enhancement is permitted on retry.
NO color grading, sharpening, or lighting effects on retry.
Apply the absolute minimum adjustment needed to produce a visible but safe result.

════════════════════════════════════════
FAIL-SAFE RULE
════════════════════════════════════════
If transformation requires changing a LOCKED attribute:
→ DO NOT proceed
→ apply MINIMAL safe enhancement only (exposure + contrast + white balance)

If unsure whether a change violates a lock:
→ choose the safest option — the least change possible
→ NEVER attempt reconstruction

If the edit cannot be performed without structural alteration:
→ return an error — NO fallback models, NO regeneration

════════════════════════════════════════
FINAL OUTPUT TARGET
════════════════════════════════════════
Output must be:
✔ naturally edited photograph
✔ realistic lighting and color correction
✔ identical structure to input
✔ indistinguishable from real Lightroom edit

NOT:
✖ AI-generated image
✖ reconstructed scene
✖ altered identity
✖ new or replaced background

You are performing controlled photographic enhancement ONLY.
→ Preserve reality. Enhance subtly. Never rebuild.

SPECIFIC EDIT INSTRUCTION:
`;

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
  // The full instruction sent to the model = IMG2IMG_MASTER_CONTRACT (pixel-anchor
  // immutability rules, forbidden operations, hard constraints) + the mode-specific
  // instruction. The contract is prepended on every call — it cannot be bypassed.
  const fullInstruction = IMG2IMG_MASTER_CONTRACT + instruction;

  const requestPayload = {
    model: GEMINI_IMG2IMG_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } },
          { text: fullInstruction },
        ],
      },
    ],
    config: { responseModalities: ["TEXT", "IMAGE"] },
  };

  logger.info(
    {
      stage: "IMG2IMG MODE ACTIVE",
      model: GEMINI_IMG2IMG_MODEL,
      contractPrepended: true,
      contractBytes: IMG2IMG_MASTER_CONTRACT.length,
      instruction: instruction.slice(0, 120),
      fullInstructionBytes: fullInstruction.length,
      inlineDataPresent: true,
      inlineDataBytes: parsed.base64.length,
      timeoutMs,
    },
    "[imageEdit] IMG2IMG MODE ACTIVE — master contract + instruction sent, image attached",
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

// ── LAYER 8: Quality Enforcement Verifier ────────────────────────────────────
//
// After every successful img2img call, compare input vs output using Gemini
// vision to detect identity drift, scene regeneration, or structural changes.
//
// Verification is mode-aware (3 tiers):
//   STRICT   — SUBTLE_ENHANCEMENT, CINEMATIC_EDIT, COLOR_MOOD_EDIT, WALLPAPER_UPGRADE
//              Checks: identity, pose, background, objects, composition
//              Allows: lighting, color grading, sharpness, exposure
//
//   IDENTITY — SCREENSHOT_CLEANUP, TEXT_REMOVAL, OBJECT_MANIPULATION
//              Checks: identity (if person), pose, overall scene structure
//              Allows: text/overlay removal, object edits per instruction
//
//   LOOSE    — BACKGROUND_TRANSFORMATION, STYLE_TRANSFER, AGGRESSIVE_RECONSTRUCTION
//              Checks: face/identity only (if person present)
//              Allows: background, style, composition, artistic changes
//
// VERIFIER ERROR POLICY:
//   If Gemini fails to respond (network error / timeout / unparseable output):
//   → log warning, mark skipped=true, treat as PASS — never block on infra noise
//
// QUALITY FAILURE POLICY:
//   Attempt 1 output fails quality check → trigger Attempt 2 with preservation prompt
//   Attempt 2 output also fails           → hard FAIL with rejection message

const VERIFY_TIMEOUT_MS = 20_000;
const GEMINI_VERIFY_MODEL = "gemini-2.5-flash";

type VerificationTier = "STRICT" | "IDENTITY" | "LOOSE";

interface VerificationResult {
  valid: boolean;
  issues: string[];
  tier: VerificationTier;
  skipped: boolean;
  skipReason?: string;
}

function getVerificationTier(mode: EditMode): VerificationTier {
  switch (mode) {
    case "SUBTLE_ENHANCEMENT":
    case "CINEMATIC_EDIT":
    case "COLOR_MOOD_EDIT":
    case "WALLPAPER_UPGRADE":
      return "STRICT";

    case "SCREENSHOT_CLEANUP":
    case "TEXT_REMOVAL":
    case "OBJECT_MANIPULATION":
      return "IDENTITY";

    case "BACKGROUND_TRANSFORMATION":
    case "STYLE_TRANSFER":
    case "AGGRESSIVE_RECONSTRUCTION":
      return "LOOSE";

    default:
      return "STRICT";
  }
}

function buildVerificationPrompt(
  tier: VerificationTier,
  modeLabel: string,
  userPrompt: string,
): string {
  const tierRules: Record<VerificationTier, string> = {
    STRICT: `STRICT CHECKS — all must pass:
1. FACE/IDENTITY: If a person is present, they must be the same person (same face shape, skin tone). Any face swap or identity change = INVALID.
2. BACKGROUND: The background layout must be the same environment. A replaced or regenerated background = INVALID.
3. OBJECTS: Same main objects must be present in approximately the same positions. Inserted or removed objects = INVALID.
4. POSE: Subject's pose must be preserved. Changed pose = INVALID.
5. COMPOSITION: Same framing and crop. Drastically different angle = INVALID.
Allowed: lighting changes, color grading, sharpness adjustment, exposure correction, color tone shifts.`,

    IDENTITY: `IDENTITY CHECKS — must pass:
1. FACE/IDENTITY: If a person is present, they must be recognizably the same person. Identity drift = INVALID.
2. SCENE STRUCTURE: The overall environment must be recognizably the same. A completely different scene = INVALID.
3. POSE: Subject's pose must be preserved.
Allowed: lighting, color, sharpness, text/overlay removal, object changes matching the instruction.`,

    LOOSE: `LOOSE CHECKS — only the most critical:
1. FACE/IDENTITY: If a person is present, they must be recognizably the same person. Complete face replacement = INVALID.
Allowed: style changes, background replacement, composition changes, artistic reinterpretation — all acceptable for this edit type.`,
  };

  return `You are a strict image edit quality validator for a professional photo system.

IMAGE 1 = original input image.
IMAGE 2 = edited output image.

EDIT MODE: ${modeLabel}
USER INSTRUCTION: "${userPrompt.slice(0, 200)}"

Apply these validation rules:
${tierRules[tier]}

IMPORTANT: Do not fail an edit because it looks more polished or AI-enhanced in style. Only fail if the specific structural checks above are violated.

Respond with EXACTLY one JSON line:
{"valid":true,"issues":[]}
or
{"valid":false,"issues":["specific issue"]}

Valid issue examples: "face changed", "identity drift", "background replaced with new scene", "main subject replaced", "pose changed", "scene completely regenerated", "different person present"

Output ONLY the JSON. No markdown. No explanation.`;
}

async function verifyEditOutput(
  inputParsed: ParsedImage,
  outputDataUrl: string,
  mode: EditMode,
  userPrompt: string,
): Promise<VerificationResult> {
  const tier      = getVerificationTier(mode);
  const modeLabel = getEditModeLabel(mode);

  const commaIdx = outputDataUrl.indexOf(",");
  if (commaIdx === -1) {
    return { valid: false, issues: ["output image format invalid"], tier, skipped: false };
  }
  const outputBase64    = outputDataUrl.slice(commaIdx + 1);
  const outputMimeMatch = outputDataUrl.slice(0, commaIdx).match(/data:([^;]+);/);
  const outputMime      = (outputMimeMatch?.[1] ?? "image/jpeg") as AcceptedMime;

  logger.info(
    {
      tier,
      mode: modeLabel,
      inputBytes: inputParsed.base64.length,
      outputBytes: outputBase64.length,
      verifyModel: GEMINI_VERIFY_MODEL,
    },
    "[imageQuality] LAYER 8 verifier invoked",
  );

  const verificationPrompt = buildVerificationPrompt(tier, modeLabel, userPrompt);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const { ai } = await import("@workspace/integrations-gemini-ai");

    const result = await Promise.race([
      ai.models.generateContent({
        model: GEMINI_VERIFY_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: inputParsed.mimeType, data: inputParsed.base64 } },
              { inlineData: { mimeType: outputMime, data: outputBase64 } },
              { text: verificationPrompt },
            ],
          },
        ],
        config: { temperature: 0.1, maxOutputTokens: 200 },
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Verifier timeout after ${VERIFY_TIMEOUT_MS}ms`)),
          VERIFY_TIMEOUT_MS,
        );
      }),
    ]);

    if (timeoutId !== undefined) clearTimeout(timeoutId);

    const rawText = ((result as { text?: string }).text ?? "").trim();
    // Strip markdown fences if the model wraps output
    const jsonStr = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    let parsed: { valid: boolean; issues: unknown };
    try {
      parsed = JSON.parse(jsonStr) as { valid: boolean; issues: unknown };
    } catch {
      logger.warn(
        { rawText: rawText.slice(0, 300) },
        "[imageQuality] verifier response not parseable — treating as PASS",
      );
      return { valid: true, issues: [], tier, skipped: true, skipReason: "json parse error" };
    }

    const valid  = parsed.valid === true;
    const issues = Array.isArray(parsed.issues)
      ? (parsed.issues as unknown[]).map(String)
      : [];

    logger.info(
      { valid, issues, tier, mode: modeLabel },
      valid
        ? "[imageQuality] PASS — edit meets quality standards"
        : "[imageQuality] FAIL — quality violation detected",
    );

    return { valid, issues, tier, skipped: false };

  } catch (err) {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { reason, tier, mode: modeLabel },
      "[imageQuality] verifier error — treating as PASS to avoid blocking valid edits",
    );
    return { valid: true, issues: [], tier, skipped: true, skipReason: reason };
  }
}

// Builds the quality-retry instruction for Attempt 2 when Attempt 1 failed the
// LAYER 8 quality check (identity drift, background replaced, pose changed, etc.).
//
// RETRY BEHAVIOR RULE: per the IMG2IMG contract, a quality-fail retry is reduced
// to ONLY: exposure correction + contrast adjustment + white balance correction.
// NO stylistic enhancement, color grading, sharpening, or lighting effects are
// permitted on retry. The goal is the safest possible minimal adjustment that
// preserves full structural integrity.
function buildPreservationInstruction(
  mode: EditMode,
  userPrompt: string,
  qualityIssues: string[],
): string {
  const issueContext =
    qualityIssues.length > 0
      ? `The previous attempt introduced these problems: ${qualityIssues.join(", ")}. These MUST NOT appear in the output.`
      : "";

  return (
    `QUALITY-FAIL RETRY — reduced to minimal safe enhancement ONLY.\n` +
    `Original edit type: ${getEditModeLabel(mode)}. Original request: "${userPrompt.slice(0, 100)}"\n` +
    (issueContext ? `${issueContext}\n` : "") +
    `\n` +
    `RETRY BEHAVIOR RULE — apply ONLY these three operations:\n` +
    `1. Exposure correction (subtle lift of shadows, gentle recovery of highlights)\n` +
    `2. Contrast adjustment (natural tonal distribution — no crushing)\n` +
    `3. White balance correction (remove color cast, achieve neutral accurate tones)\n` +
    `\n` +
    `NO stylistic enhancement on retry.\n` +
    `NO color grading, sharpening, lighting effects, or cinematic treatment on retry.\n` +
    `Apply the absolute minimum adjustment needed to produce a visible but structurally safe result.\n` +
    `\n` +
    `ABSOLUTE PRESERVATION RULES (non-negotiable):\n` +
    `- Keep the exact same face, identity, and bone structure\n` +
    `- Keep the exact same pose and body position\n` +
    `- Keep the exact same background — object-for-object, spatially unchanged\n` +
    `- Keep the exact same composition and camera angle\n` +
    `- Do NOT replace, regenerate, reconstruct, or restructure ANY element`
  );
}

// ── EditResult ────────────────────────────────────────────────────────────────

export interface EditResult {
  b64Image: string;
  job: ReturnType<typeof jobSummary>;
  mode: string;
  intensity: string;
  qualityVerified: boolean;
  qualityIssues: string[];
}

// ── editImage: quality-enforced single-model img2img pipeline ────────────────
//
// CONTRACT:
//   - Input image ALWAYS attached as inlineData conditioning (never dropped).
//   - Only gemini-2.0-flash-preview-image-generation is used for editing.
//   - gemini-2.5-flash is used for post-edit quality verification only (no image output).
//
// PIPELINE FLOW:
//   Attempt 1 (primary instruction)
//     → null (no-op)         → Attempt 2 [escalated EXTREME, no quality retry]
//     → image                → LAYER 8 quality verify
//         → PASS             → succeedEdit ✓
//         → FAIL             → Attempt 2 [preservation instruction, quality retry]
//         → verifier error   → succeedEdit with warning (pass-through)
//
//   Attempt 2 (escalated OR preservation, depending on trigger)
//     → null                 → FAIL immediately
//     → image                → LAYER 8 quality verify
//         → PASS             → succeedEdit ✓
//         → FAIL             → FAIL (quality enforcement rejection)
//         → verifier error   → succeedEdit with warning
//
// WHAT THIS FUNCTION WILL NEVER DO:
//   - Use a second img2img model.
//   - Describe the image and regenerate from text.
//   - Use FLUX or any text-to-image provider as a substitute for editing.

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
      verifyModel: GEMINI_VERIFY_MODEL,
    },
    "[imageEdit] pipeline entered — IMG2IMG ONLY + LAYER 8 quality enforcement",
  );

  // ── LAYER 0: Classify complexity and job type ──────────────────────────────
  const intent: ImageIntent  = classifyImageIntent(prompt, true);
  const complexity            = classifyComplexity(prompt);
  const jobType               = classifyJobType(intent, true);
  const timeoutMs             = complexityTimeout(complexity);

  // ── LAYER 1+2: Mode + intensity classification ─────────────────────────────
  const mode: EditMode           = classifyEditMode(prompt, true);
  const intensity: EditIntensity = detectEditIntensity(prompt, mode);
  const verifyTier               = getVerificationTier(mode);

  // ── LAYER 4: Build instructions ────────────────────────────────────────────
  const primaryInstruction = buildStrongInstruction(mode, intensity, prompt);

  // Escalated instruction — same model, stronger prompt, used for no-op recovery
  const escalatedInstruction = buildStrongInstruction(
    mode,
    "EXTREME",
    prompt + " — IMPORTANT: this edit MUST be visually transformative. Make a strong, clearly visible change.",
  );

  const hasPreservationLock = detectPreservationLock(prompt);
  const expandedPrompt      = buildStructuredPrompt(prompt, hasPreservationLock);

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
    `Mode: ${getEditModeLabel(mode)} | Intensity: ${intensity} | Complexity: ${complexity} | VerifyTier: ${verifyTier}${hasPreservationLock ? " | LOCK" : ""}`,
  );

  // ── succeedEdit: completes job, persists history, builds return value ───────
  const succeedEdit = (b64Image: string, qv?: VerificationResult): EditResult => {
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
    return {
      b64Image,
      job: jobSummary(job),
      mode: getEditModeLabel(mode),
      intensity,
      qualityVerified: qv ? (!qv.skipped && qv.valid) : false,
      qualityIssues:   qv?.issues ?? [],
    };
  };

  // ── Attempt 2 trigger tracking ─────────────────────────────────────────────
  // "no-op"        — Attempt 1 returned null (no image parts / near-identical)
  //                  or threw an API error. Attempt 2 uses escalated instruction.
  // "quality-fail" — Attempt 1 returned an image that failed LAYER 8 quality
  //                  check. Attempt 2 uses preservation instruction.
  type Attempt2Trigger = "no-op" | "quality-fail";
  let attempt2Trigger: Attempt2Trigger = "no-op";
  let qualityRetryIssues: string[] = [];

  const attemptErrors: string[] = [];

  try {
    // ── Attempt 1: primary instruction ────────────────────────────────────────
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
      // Keep attempt2Trigger = "no-op"
    }

    if (r1) {
      // ── LAYER 8: Quality verification on Attempt 1 output ───────────────────
      advanceJob(job, "streaming", "Attempt 1 image received — running LAYER 8 quality check");
      const qv1 = await verifyEditOutput(parsed, r1, mode, prompt);

      if (qv1.skipped) {
        logger.warn(
          { skipReason: qv1.skipReason },
          "[imageQuality] verifier skipped on Attempt 1 — passing through",
        );
        return succeedEdit(r1, qv1);
      }

      if (qv1.valid) {
        return succeedEdit(r1, qv1);
      }

      // Quality check failed — trigger preservation retry
      qualityRetryIssues = qv1.issues;
      attempt2Trigger    = "quality-fail";
      logger.warn(
        { issues: qv1.issues, tier: qv1.tier, mode: getEditModeLabel(mode) },
        "[imageQuality] Attempt 1 REJECTED by quality verifier — preservation retry triggered",
      );
    }
    // r1 === null (no-op) falls through with attempt2Trigger = "no-op"

    // ── Attempt 2: escalated (no-op path) OR preservation (quality-fail path) ──
    const attempt2Instruction =
      attempt2Trigger === "quality-fail"
        ? buildPreservationInstruction(mode, prompt, qualityRetryIssues)
        : escalatedInstruction;

    const attempt2Label =
      attempt2Trigger === "quality-fail"
        ? `Attempt 2 — ${GEMINI_IMG2IMG_MODEL} | PRESERVATION retry (quality enforcement)`
        : `Attempt 2 — ${GEMINI_IMG2IMG_MODEL} | EXTREME escalated (no-op recovery)`;

    advanceJob(job, "retrying", attempt2Label, { retryCount: 1 });

    let r2: string | null = null;
    try {
      r2 = await tryGeminiImg2Img(parsed, attempt2Instruction, timeoutMs);
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      attemptErrors.push(`Attempt 2 [${GEMINI_IMG2IMG_MODEL}]: ${msg2}`);
      logger.error(
        { attempt: 2, model: GEMINI_IMG2IMG_MODEL, trigger: attempt2Trigger, error: msg2 },
        "[imageEdit] Attempt 2 HARD FAIL — real API error",
      );
    }

    if (r2) {
      // ── LAYER 8: Quality verification on Attempt 2 output ───────────────────
      advanceJob(job, "streaming", "Attempt 2 image received — running LAYER 8 quality check");
      const qv2 = await verifyEditOutput(parsed, r2, mode, prompt);

      if (qv2.skipped) {
        logger.warn(
          { skipReason: qv2.skipReason, trigger: attempt2Trigger },
          "[imageQuality] verifier skipped on Attempt 2 — passing through",
        );
        return succeedEdit(r2, qv2);
      }

      if (qv2.valid) {
        return succeedEdit(r2, qv2);
      }

      // Attempt 2 also failed quality — hard reject
      const rejectionReason =
        `Quality enforcement rejection: both attempts introduced protected-element changes ` +
        `(${qv2.issues.join(", ")}). ` +
        `Tier: ${qv2.tier}. Trigger: ${attempt2Trigger}.`;

      logger.error(
        {
          issues: qv2.issues,
          tier: qv2.tier,
          trigger: attempt2Trigger,
          attempt1Issues: qualityRetryIssues,
          mode: getEditModeLabel(mode),
        },
        "[imageQuality] QUALITY ENFORCEMENT REJECTION — both attempts failed quality check",
      );

      failJob(job, rejectionReason);
      throw new Error(
        `Image editing rejected — the model altered protected elements (${qv2.issues.join(", ")}) ` +
        `that must be preserved. Please use a more specific instruction or try a different image.`,
      );
    }

    // ── ALL ATTEMPTS EXHAUSTED — FAIL IMMEDIATELY ─────────────────────────────
    // No fallback. No text-to-image. No second model. Hard stop.
    const failReason =
      attemptErrors.length > 0
        ? `img2img failed after 2 attempts:\n${attemptErrors.join("\n")}`
        : attempt2Trigger === "quality-fail"
          ? "quality retry returned no image output — model could not produce a structure-preserving edit."
          : "img2img returned no image output after 2 attempts (no-op or near-identical) — please retry with a clearer instruction.";

    logger.error(
      {
        model: GEMINI_IMG2IMG_MODEL,
        mode: getEditModeLabel(mode),
        intensity,
        complexity,
        attempt2Trigger,
        attemptErrors,
        fallback: "NONE — permanently removed",
      },
      "[imageEdit] IMG2IMG FAILED — no fallback, returning error to caller",
    );

    failJob(job, failReason);
    throw new Error(
      attemptErrors.length > 0
        ? `Image editing failed — ${failReason}`
        : attempt2Trigger === "quality-fail"
          ? "Image editing failed — could not produce a structure-preserving result. Please try a more specific instruction."
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
