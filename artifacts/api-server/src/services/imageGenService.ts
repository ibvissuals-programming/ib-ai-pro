/**
 * Image generation service — IB AI Assistant (Production V5)
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, no auth, FLUX model)
 *
 * IMAGE-TO-IMAGE: Single-model deterministic img2img pipeline.
 *   PRIMARY MODEL: gemini-2.5-flash-image
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

// ── Timeout / retry constants ─────────────────────────────────────────────────
// REQUEST_TIMEOUT_MS: per-attempt timeout for Pollinations (text-to-image only).
// EDIT_PIPELINE_HARD_TIMEOUT_MS: absolute wall-clock deadline for the entire
//   editImage() pipeline — no matter how many attempts/verifies are in-flight,
//   the request is aborted and an error is returned after this many ms.
export const REQUEST_TIMEOUT_MS          = 28_000;
export const EDIT_PIPELINE_HARD_TIMEOUT_MS = 40_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
const RESPONSE_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,/;

// Pollinations (text-to-image): 1 retry max — hard limit per requirements.
export const MAX_POLLINATIONS_RETRIES  = 1;
const POLLINATIONS_RETRY_BASE_MS       = 1_500;

// ── Contract versioning ───────────────────────────────────────────────────────
// CONTRACT_VERSION identifies which enforcement ruleset is active.
// It is included in every edit response and surfaced by GET /api/image/contract.
// Increment when the IMG2IMG_MASTER_CONTRACT text is materially updated.
export const CONTRACT_VERSION = "v5" as const;

// PRO_EDIT_MODE — the new system-wide default for all image edits.
// When true:
//   - Default edit strength = HIGH (no silent fallback to MEDIUM or LOW)
//   - Strong tonal transformation and cinematic grading are expected outputs
//   - Visible lighting and contrast changes are REQUIRED, not optional
//   - Identity, background, and pose locks remain active (structural only)
//   - No cleanup, cropping, or content-aware reconstruction operations
//   - AGGRESSIVE_RECONSTRUCTION and CINEMATIC EXTREME run at full intensity
export const PRO_EDIT_MODE = true as const;

const CONTRACT_VERSION_HISTORY: Record<string, string> = {
  v1: "Basic IMG2IMG enforcement — identity lock, background lock, Lightroom-style allowed operations only",
  v2: "Quality verifier system added — retry-once enforcement; identity/background/pose/composition validation",
  v3: "Anti-AI look system added — prevents plastic skin, HDR overprocessing, fake cinematic glow, over-smoothed faces; forces DSLR realism",
  v4: "Retry behavior rule locked — on retry ONLY exposure correction + contrast + white balance; all stylistic enhancement removed on retry",
  v5: "PRO_EDIT_MODE enabled — HIGH is the default minimum strength; AGGRESSIVE_RECONSTRUCTION and CINEMATIC EXTREME run at full intensity; verifier relaxed to allow all tonal/cinematic changes; FAIL-SAFE uncertainty rule replaced with maintain-HIGH policy",
};

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

const GEMINI_IMG2IMG_MODEL = "gemini-2.5-flash-image";

// ── IMG2IMG MASTER CONTRACT ───────────────────────────────────────────────────
// This preamble is prepended to EVERY instruction sent to the img2img model.
// It encodes the pixel-anchor / immutability contract that must hold for every
// edit request, regardless of mode or intensity.
//
// DO NOT remove or shorten this contract. It is the primary mechanism that
// prevents the model from drifting into generative / reconstructive behavior.

export const IMG2IMG_MASTER_CONTRACT = `You are a professional Lightroom-style image editing engine operating in STRICT IMG2IMG MODE ONLY.

Your job is to perform true photographic enhancement only on an existing image.

You are NOT an image generator.
You are NOT a creative or generative model.
You are NOT allowed to reconstruct, reinterpret, or regenerate images.

------------------------------------------------------------
INSTRUCTION PRIORITY HIERARCHY (read this first)
------------------------------------------------------------

When instructions appear to conflict, apply this priority order:

PRIORITY 1 — STRUCTURAL INTEGRITY (absolute, non-negotiable)
→ Face identity and bone structure: MUST be preserved
→ Person identity (who the subject is): MUST be preserved
→ Pose and body position: MUST be preserved
→ Background geometry (objects, layout, spatial positions): MUST be preserved

PRIORITY 2 — VISUAL TRANSFORMATION (high, expected, required)
→ Lighting — direction, intensity, quality, cinematic relighting: MUST change per instruction
→ Color grading — tonal shifts, film palettes, mood: MUST change per instruction
→ Exposure and contrast — shadow depth, highlight recovery: MUST change per instruction
→ Cinematic atmosphere, tone, and mood: MUST change per instruction

CRITICAL DISAMBIGUATION:
"Preserve structure" = preserve face/pose/geometry ONLY.
It does NOT mean preserve lighting, color, mood, or exposure.
Lighting and color are EXPECTED to change strongly.
Near-identical output = FAILURE state.

------------------------------------------------------------
CORE NON-NEGOTIABLE RULE
------------------------------------------------------------

The input image is the ONLY source of truth.

You MUST preserve (STRUCTURAL ELEMENTS ONLY):

- Same identity (exact same person)
- Same face structure (bone structure unchanged)
- Same pose and body position
- Same camera angle
- Same composition
- Same background GEOMETRY — objects, their positions, and scene layout

YOU MUST CHANGE (these are the GOAL of the edit, not optional):
- Lighting direction, intensity, and quality — transform per instruction
- Color palette, tonal mood, and grading — transform per instruction
- Exposure level and contrast shape — transform per instruction
- Cinematic atmosphere and visual mood — transform per instruction

ANY structural deviation = AUTOMATIC FAILURE
ANY near-identical output (no visible change) = FAILURE — do not produce safe-mode results

------------------------------------------------------------
IMAGE IMMUTABILITY CONTRACT
------------------------------------------------------------

You MUST NOT modify:

- Identity
- Face structure
- Body proportions
- Pose
- Scene layout
- Background objects
- Camera framing

------------------------------------------------------------
BACKGROUND LOCK (CRITICAL)
------------------------------------------------------------

Background STRUCTURE must remain:

- Same objects in same positions
- Same spatial layout
- Same scene geometry

STRONGLY EXPECTED changes to background (these ARE the edit goal):
✔ Lighting — direction, intensity, warmth, cinematic quality: ALL allowed and expected
✔ Color grading — mood, palette, tone across entire scene: ALL allowed and expected
✔ Exposure adjustments — lift shadows, recover highlights across frame: ALL allowed
✔ Atmospheric tone — cinematic, moody, dramatic: ALL allowed
✔ Any tonal, colorimetric, or photographic quality change: ALL allowed

FORBIDDEN (structural changes only):
✖ Background replacement with different environment
✖ Scene reconstruction that changes what objects are present
✖ Object removal or addition

------------------------------------------------------------
IDENTITY LOCK (CRITICAL)
------------------------------------------------------------

Face must remain identical:

- Bone structure
- Eyes, nose, lips
- Jawline
- Expression

FORBIDDEN:
✖ Face reshaping
✖ Beautification that alters identity
✖ AI reconstruction of facial features

------------------------------------------------------------
LIGHTROOM MODE (ONLY ALLOWED OPERATIONS)
------------------------------------------------------------

You may perform these photographic edit operations (at STRONG intensity per mode):

✔ Exposure correction — strong lifts, aggressive highlight recovery, intentional over/under exposure
✔ Contrast shaping — deep S-curves, rich shadow depth, punchy highlights, cinematic tonal range
✔ White balance and color temperature — warm to cool shifts, strong tonal color changes
✔ Color grading — STRONG: cinematic palettes (teal-orange, bleach bypass, film emulation), mood transformation
✔ Shadow/highlight shaping — dramatic shadow depth, luminous highlights, split toning
✔ Sharpening and clarity — strong local contrast, texture enhancement, micro-contrast
✔ Noise reduction — clean grain while preserving texture
✔ Skin texture preservation (NO plastic smoothing) — enhance without destroying realism
✔ Lighting transformation — direction changes, cinematic relighting, 3-point lighting simulation: ALL ALLOWED
✔ Cinematic atmosphere — film grain, lens character, anamorphic quality: ALL ALLOWED

STRICT RULE:
You are editing pixels, NOT recreating the image.
Make the edit STRONG and VISIBLE — a near-identical output is a failure.

------------------------------------------------------------
FORBIDDEN OPERATIONS
------------------------------------------------------------

DO NOT:

✖ Regenerate or recreate image
✖ Reconstruct scene
✖ Change background
✖ Alter identity or face
✖ Change pose or composition
✖ Add/remove objects
✖ Convert to AI art, CGI, illustration, or stylized render
✖ Apply fake cinematic HDR glow
✖ Over-smooth skin or remove texture
✖ Reinterpret the image creatively

------------------------------------------------------------
ANTI–AI LOOK SYSTEM
------------------------------------------------------------

Output MUST look like a REAL professional camera edit, NOT AI-generated plastic.

Avoid (realism killers only):

✖ Plastic/porcelain skin (over-smoothed, texture-erased faces)
✖ Over-sharpening to unnatural crispness
✖ Halation halos and fake glowing skin that don't exist in real photography
✖ Unreal depth blur added where none existed in original
✖ AI-hallucinated details reconstructed from nothing

NOTE: Strong contrast curves, cinematic tonal grading, film palettes, and dramatic
lighting are REAL photography techniques — do NOT avoid them. They are the goal.

TARGET OUTPUT:
✔ DSLR / cinema camera quality — rich, punchy, professional
✔ Lightroom / DaVinci Resolve grade — strong, intentional, visible
✔ Physically believable lighting — relit and graded, not untouched

------------------------------------------------------------
IMG2IMG ENFORCEMENT RULE
------------------------------------------------------------

- The input image MUST be used as conditioning input
- If image is missing or invalid → STOP IMMEDIATELY
- NEVER convert image → text → new image

------------------------------------------------------------
QUALITY ENFORCEMENT SYSTEM
------------------------------------------------------------

After editing, the verifier system checks structural integrity only:

✔ Same identity (the verifier checks this — you must preserve it)
✔ Same face structure (the verifier checks this — you must preserve it)
✔ Same pose (the verifier checks this — you must preserve it)
✔ Same background GEOMETRY (the verifier checks this — you must preserve it)
✔ Same composition framing (the verifier checks this — you must preserve it)

NOTE: The verifier does NOT check lighting, color, tone, or grading.
Lighting and color changes will NOT trigger a retry — they are EXPECTED.

If structural mismatch detected:
→ Mark INVALID EDIT
→ The retry system handles this — do NOT pre-emptively reduce visual transformation strength

If second attempt fails:
→ HARD FAIL (NO fallback generation)

Verifier failure:
→ Allow pass-through with warning only

------------------------------------------------------------
RETRY BEHAVIOR RULE
------------------------------------------------------------

If retry is triggered:

ONLY apply:
✔ Exposure correction
✔ Contrast adjustment
✔ White balance correction

NO stylistic enhancement allowed on retry.

------------------------------------------------------------
FAIL-SAFE BEHAVIOR (PRO_EDIT_MODE)
------------------------------------------------------------

If unsure about HOW to apply an edit:
→ Maintain HIGH transformation strength — do NOT reduce edit intensity
→ Do NOT self-downgrade to a safer or weaker version of the edit
→ Only reduce prompt complexity if needed — NEVER reduce image transformation strength
→ A near-identical or minimally changed output is a FAILURE, not a safe choice

If model cannot comply with the structural locks:
→ RETURN ERROR
→ DO NOT generate fallback image
→ DO NOT recreate image

------------------------------------------------------------
VARIANCE ENFORCEMENT SYSTEM (PRO_EDIT_MODE v6)
------------------------------------------------------------

Before producing your output, verify it satisfies the MINIMUM VISUAL CHANGE THRESHOLD.

You must satisfy AT LEAST 3 of the following 5 transformation axes:

AXIS 1 — LIGHTING SHIFT
→ Lighting direction, source quality, or intensity is clearly different from the input
→ A minor brightness nudge does NOT satisfy this axis
→ Acceptable: new key light direction, cinematic rim light, dramatic shadow reshaping

AXIS 2 — COLOR PALETTE SHIFT
→ Color temperature, hue balance, or overall palette is clearly different from the input
→ A near-neutral tweak does NOT satisfy this axis
→ Acceptable: warm-to-cool, neutral-to-cinematic, teal-orange grade, film emulation

AXIS 3 — CONTRAST CURVE SHIFT
→ Shadow depth, highlight brightness, or tonal range separation is clearly different
→ A minor exposure nudge does NOT satisfy this axis
→ Acceptable: deep black point crush, bright luminous highlights, cinematic S-curve

AXIS 4 — EXPOSURE REDISTRIBUTION
→ The overall exposure balance is clearly different — shadows lifted, highlights recovered,
   or intentional exposure shift applied that changes the tonal weight of the image

AXIS 5 — MOOD / ATMOSPHERE CHANGE
→ The overall cinematic or emotional feel of the image is clearly different from the input
→ Acceptable: flat-to-dramatic, bright-to-moody, clinical-to-warm, neutral-to-cinematic

THRESHOLD CHECK:
If your output satisfies fewer than 3 axes → it is a VARIANCE FAILURE
→ Increase transformation strength immediately
→ Do NOT output a near-identical result
→ Do NOT reduce to a "safe" minimal edit

PRO_EDIT_MODE enforcement:
→ Conservative fallback = DISABLED
→ Safe-similarity output = REJECTED (it is not a valid result)
→ HIGH/EXTREME strength MUST satisfy at least 3 axes visibly

------------------------------------------------------------
FINAL OUTPUT GOAL
------------------------------------------------------------

The final image must be:

✔ Structurally identical to input — same person, same pose, same background objects
✔ VISUALLY TRANSFORMED — clearly different lighting, tone, grading, and mood than input
✔ Strongly color graded — professional Lightroom or cinematic DaVinci-quality enhancement
✔ Realistic and camera-authentic — looks like a real DSLR or cinema camera edit

CRITICAL: Near-identical output = FAILURE.
The edit MUST produce a clearly visible visual transformation.
"Safe mode" output (minimal change) is NOT acceptable. It is an edit failure.

NOT:

✖ AI-generated plastic (over-smooth, reconstructed faces)
✖ Structurally reconstructed (identity changed, background replaced)
✖ Near-identical to input (no-op output is a failure, not a safe result)

------------------------------------------------------------
SYSTEM ROLE SUMMARY
------------------------------------------------------------

You are NOT a generator.

You are a professional photographic enhancement engine operating in PRO_EDIT_MODE.

Your job — in strict priority order:
→ [1 — ABSOLUTE] Preserve structural integrity: face identity, pose, background geometry
→ [2 — REQUIRED] Transform visual appearance STRONGLY: lighting, tone, color, mood, contrast
→ [3 — NEVER] Do not reconstruct, regenerate, or replace any structural element

"Preserve structure" = preserve who/what/where. It does NOT restrict how it looks.
Lighting and color must change. Near-identical output is a failure, not a safe result.

------------------------------------------------------------
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

// Verifier has a tight budget — it must never block the response beyond the global
// 40s wall. 8s is enough for a text-only Gemini call with small output.
// LOOSE-tier modes (STYLE_TRANSFER, BACKGROUND_TRANSFORMATION,
// AGGRESSIVE_RECONSTRUCTION) skip verification entirely — their structural
// changes are intentional and the verifier cannot meaningfully check them.
export const VERIFY_TIMEOUT_MS = 8_000;
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
    STRICT: `STRICT CHECKS — structural integrity only (PRO_EDIT_MODE v5):
1. FACE/IDENTITY: If a person is present, they must be the same person (same face shape, bone structure, skin tone). A different person or face replacement = INVALID.
2. BACKGROUND: The background must be the same environment — same objects, same spatial layout. A completely replaced or regenerated background scene = INVALID.
3. OBJECTS: Same main objects must be present in approximately the same positions. Objects being inserted or removed (not requested) = INVALID.
4. POSE: Subject's pose and body position must be preserved. A changed pose = INVALID.
5. COMPOSITION: Same framing and crop. A drastically different camera angle = INVALID.

EXPLICITLY ALLOWED — do NOT fail for any of these (they are expected, valid edits):
✔ Lighting changes — directional light shifts, 3-point lighting, relighting
✔ Exposure adjustments — lifted shadows, recovered highlights, brightened or darkened image
✔ Contrast changes — deep shadows, bright highlights, HDR-style tonal curves
✔ Color grading — teal-orange, warm tones, cool tones, cinematic palette shifts
✔ Cinematic tonal shifts — film grain, anamorphic lens effects, color temperature
✔ Clarity and sharpness improvements — local sharpening, texture enhancement
✔ Mood and atmosphere changes — image looks more dramatic, moody, or cinematic
✔ The image appearing more polished, professional, or AI-enhanced in tonal quality`,

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

  // LOOSE-tier modes (STYLE_TRANSFER, BACKGROUND_TRANSFORMATION,
  // AGGRESSIVE_RECONSTRUCTION) intentionally change structure/identity — skip.
  // Running the verifier on them would only produce false positives and add latency.
  if (tier === "LOOSE") {
    logger.info(
      { tier, mode: modeLabel },
      "[imageQuality] LAYER 8 verifier SKIPPED — LOOSE tier, structural changes are intentional",
    );
    return { valid: true, issues: [], tier, skipped: true, skipReason: "LOOSE tier — structural changes intentional" };
  }

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
  contractVersionUsed: string;
}

// ── GET /api/image/contract — diagnostic snapshot ─────────────────────────────
// Returns a read-only view of all live pipeline constants and enforcement rules.
// Pure function — no side effects, no mutations, no I/O.
// debugMode (requires DEBUG_CONTRACT=true env var) adds version history and
// per-layer enforcement detail for deeper introspection.
export function getContractConfig(debugMode = false): Record<string, unknown> {
  const config: Record<string, unknown> = {
    contract:        IMG2IMG_MASTER_CONTRACT,
    contractVersion: CONTRACT_VERSION,

    pipeline: {
      editPipelineHardTimeoutMs: EDIT_PIPELINE_HARD_TIMEOUT_MS,
      requestTimeoutMs:          REQUEST_TIMEOUT_MS,
      verifyTimeoutMs:           VERIFY_TIMEOUT_MS,
      maxRetries:                MAX_POLLINATIONS_RETRIES,
      model:                     GEMINI_IMG2IMG_MODEL,
      verifierModel:             GEMINI_VERIFY_MODEL,
    },

    complexity: {
      SIMPLE:   { timeoutMs: complexityTimeout("SIMPLE"),   retriesOnNoOp: 0, note: "fast-fail immediately on no-op" },
      STANDARD: { timeoutMs: complexityTimeout("STANDARD"), retriesOnNoOp: 1 },
      HEAVY:    { timeoutMs: complexityTimeout("HEAVY"),    retriesOnNoOp: 1 },
    },

    proEditMode: {
      enabled:                     PRO_EDIT_MODE,
      defaultStrength:             "HIGH",
      aggressiveReconstructionCap: "NONE — runs at full detected intensity",
      cinematicExtremeCap:         "NONE — runs at full EXTREME intensity",
      minimumVisualChangeEnforced: true,
      nearIdenticalOutputIsFailure: true,
    },

    modes: {
      looseTierVerifierSkip:                      true,
      looseTierModes: [
        "STYLE_TRANSFER",
        "BACKGROUND_TRANSFORMATION",
        "AGGRESSIVE_RECONSTRUCTION",
      ],
    },

    safety: {
      fallbackGenerationDisabled:  true,
      modelSwitchingDisabled:      true,
      textToImageFallbackDisabled: true,
    },

    quality: {
      verifierEnabled:            true,
      verifierTimeoutMs:          VERIFY_TIMEOUT_MS,
      verifierModel:              GEMINI_VERIFY_MODEL,
      verifierPassthroughOnError: true,
      retryPolicy:
        "quality-fail → preservation retry (exposure + contrast + WB only). " +
        "no-op + SIMPLE → fast-fail immediately (no retry). " +
        "no-op + STANDARD/HEAVY → escalated retry once.",
    },
  };

  if (debugMode) {
    config.versionHistory = CONTRACT_VERSION_HISTORY;
    config.enforcementLayers = {
      "LAYER 0":   "Complexity classifier — SIMPLE / STANDARD / HEAVY timeout budgets",
      "LAYER 1+2": "Mode + intensity classifier — EditMode + EditIntensity",
      "LAYER 3":   "Screenshot cleanup prompts — reconstruct artifacts naturally",
      "LAYER 4":   "Instruction builder — mode-specific or fast-mode override",
      "LAYER 5":   "Same-model retry with escalated instruction on no-op",
      "LAYER 6":   "Similarity validation — reject near-identical outputs",
      "LAYER 7":   "Persistent image history — saved after every successful operation",
      "LAYER 8":   "Quality Enforcement Verifier — STRICT / IDENTITY / LOOSE tiers",
    };
    config.fastModeRules = {
      triggeredBy: [
        "mode === AGGRESSIVE_RECONSTRUCTION",
        "mode === CINEMATIC_EDIT && intensity === EXTREME",
      ],
      allowedOps: [
        "exposure correction",
        "contrast adjustment",
        "white balance correction",
        "mild sharpening",
      ],
      forbiddenOps: [
        "cinematic reconstruction",
        "heavy style transfer",
        "generative enhancement",
        "background modification",
        "scene rebuilding",
      ],
    };
  }

  return config;
}

// ── Fast-mode instruction builder ─────────────────────────────────────────────
// Used ONLY when the pipeline auto-downgrades a heavy mode (e.g.
// AGGRESSIVE_RECONSTRUCTION or CINEMATIC_EDIT EXTREME) to a safe minimal edit.
//
// This instruction is intentionally narrower than buildStrongInstruction — it
// names the original mode (for transparency) and explicitly forbids all
// generative/reconstructive ops the original mode would have triggered.
// This is the production-safety boundary: even if the model "knows" what
// AGGRESSIVE_RECONSTRUCTION would do, it receives instructions that prohibit it.
//
// ANTI-AI-ARTIFACT RULE is always active: outputs must look like real DSLR
// photographs, not AI-rendered images. No plastic skin, over-smoothing,
// HDR glow, or reconstructed features are permitted.
function buildFastModeInstruction(originalMode: EditMode, userPrompt: string): string {
  return (
    `FAST MODE EDIT — ${getEditModeLabel(originalMode)} was requested but has been auto-downgraded ` +
    `to minimal pixel-level correction for system stability.\n` +
    `\n` +
    `Apply ONLY these four operations:\n` +
    `1. Exposure correction — subtle lift of shadows, gentle highlight recovery\n` +
    `2. Contrast adjustment — natural tonal distribution, no crushing\n` +
    `3. White balance correction — remove color cast, achieve accurate neutral tones\n` +
    `4. Mild sharpening — lightly sharpen edges and texture only\n` +
    `\n` +
    `User instruction (apply intent only within the four allowed operations): "${userPrompt.slice(0, 120)}"\n` +
    `\n` +
    `STRICTLY FORBIDDEN:\n` +
    `- Cinematic reconstruction or Hollywood-grade relighting\n` +
    `- Heavy style transfer or artistic reinterpretation\n` +
    `- Generative enhancement or AI-hallucinated detail\n` +
    `- Background modification of any kind\n` +
    `- Scene rebuilding or subject reconstruction\n` +
    `\n` +
    `ANTI-AI-ARTIFACT RULE (non-negotiable):\n` +
    `- Do NOT create plastic or porcelain skin — preserve real skin texture\n` +
    `- Do NOT over-smooth faces — preserve pores, lines, and natural texture\n` +
    `- Do NOT apply fake HDR glow or artificial depth exaggeration\n` +
    `- Do NOT reconstruct or alter facial features in any way\n` +
    `- Output must look like a real DSLR photo with a Lightroom correction — NOT an AI render\n` +
    `\n` +
    `PRESERVATION RULES (absolute):\n` +
    `- Same face, same identity, same bone structure\n` +
    `- Same pose and body position\n` +
    `- Same background, same composition, same framing\n` +
    `- Do NOT regenerate, restructure, or replace any element`
  );
}

// ── editImage: quality-enforced single-model img2img pipeline ────────────────
//
// CONTRACT:
//   - Input image ALWAYS attached as inlineData conditioning (never dropped).
//   - Only gemini-2.5-flash-image is used for editing.
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

  // ── LAYER 0: Classify complexity and job type ──────────────────────────────
  const intent: ImageIntent  = classifyImageIntent(prompt, true);
  const complexity            = classifyComplexity(prompt);
  const jobType               = classifyJobType(intent, true);
  const timeoutMs             = complexityTimeout(complexity);

  // ── LAYER 1+2: Mode + intensity classification ─────────────────────────────
  let mode: EditMode           = classifyEditMode(prompt, true);
  let intensity: EditIntensity = detectEditIntensity(prompt, mode);

  // ── FAST MODE ENFORCEMENT (auto-downgrade) ─────────────────────────────────
  // AGGRESSIVE_RECONSTRUCTION is a heavy generative operation that risks
  // scene rebuild and identity drift. Auto-downgrade to SUBTLE_ENHANCEMENT.
  //
  // CINEMATIC_EDIT at EXTREME intensity triggers a full Hollywood-grade rebuild
  // prompt that can exceed safe edit time. Cap it at HIGH.
  //
  // These downgrades enforce the "fast, stable, deterministic" contract and
  // ensure the pipeline stays within the 40s global deadline.
  // PRO_EDIT_MODE v5: auto-downgrade blocks REMOVED.
  // AGGRESSIVE_RECONSTRUCTION runs at full detected intensity (HIGH/EXTREME).
  // CINEMATIC_EDIT EXTREME runs without intensity cap.
  // The MINIMUM VISUAL CHANGE THRESHOLD is now enforced — near-identical output
  // is a FAILURE state (Layer 6) that triggers escalated retry, not a downgrade.

  const verifyTier = getVerificationTier(mode);

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
      mode,
      intensity,
      proEditMode: PRO_EDIT_MODE,
    },
    "[imageEdit] pipeline entered — IMG2IMG ONLY + LAYER 8 quality enforcement",
  );

  // ── LAYER 4: Build instructions (PRO_EDIT_MODE v5) ───────────────────────
  // All modes run at full detected intensity — no fast-mode downgrade path.
  // Primary instruction = mode-specific strong instruction at detected intensity.
  // Escalated instruction = same mode at EXTREME, used for no-op recovery.
  const primaryInstruction: string = buildStrongInstruction(mode, intensity, prompt);

  // Escalated instruction — same model, EXTREME strength, used for no-op recovery.
  // VARIANCE ENFORCEMENT: Attempt 1 was a near-identical output (FAILURE STATE).
  // Attempt 2 escalates to EXTREME with explicit variance enforcement — all 5 axes.
  const escalatedInstruction: string = buildStrongInstruction(
    mode,
    "EXTREME",
    prompt +
    " — VARIANCE ENFORCEMENT ACTIVE: The previous attempt produced near-identical output, which is a FAILURE." +
    " This attempt MUST produce a visually transformed result." +
    " Push ALL 5 transformation axes aggressively:" +
    " (1) Strongly relight the scene — change direction or quality of light;" +
    " (2) Shift the color palette — change temperature, hue balance, or apply a cinematic grade;" +
    " (3) Reshape the contrast curve — deep blacks, bright highlights, punchy S-curve;" +
    " (4) Redistribute exposure — lift shadows or recover highlights dramatically;" +
    " (5) Change the mood — the emotional and atmospheric feel must be clearly different." +
    " All 5 axes must be visibly satisfied. Do NOT reproduce the input image with minor tweaks.",
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
  const pipelineStartMs = Date.now();

  const succeedEdit = (b64Image: string, qv: VerificationResult | undefined, retryCount: number): EditResult => {
    const latencyMs = Date.now() - pipelineStartMs;
    completeJob(job, "gemini-img2img");
    if (userId) {
      saveToHistory({
        userId,
        type: "edit",
        prompt,
        mode: getEditModeLabel(mode),
        intensity,
        b64Image,
        complexity,
        contractVersionUsed: CONTRACT_VERSION,
        model: GEMINI_IMG2IMG_MODEL,
        status: "success",
        retryCount,
        latencyMs,
      }).catch((err) => logger.warn({ err }, "[imageHistory] Failed to save edit result"));
    }
    return {
      b64Image,
      job: jobSummary(job),
      mode: getEditModeLabel(mode),
      intensity,
      qualityVerified: qv ? (!qv.skipped && qv.valid) : false,
      qualityIssues:   qv?.issues ?? [],
      contractVersionUsed: CONTRACT_VERSION,
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

  // ── GLOBAL HARD DEADLINE ──────────────────────────────────────────────────
  // Absolute wall-clock limit for the entire editImage pipeline.
  // No individual attempt timeout or verifier delay can exceed this combined cap.
  // If the deadline fires before a result is returned, the job is failed immediately
  // and a graceful error is sent to the caller — no hanging requests.
  let _deadlineTimerId: ReturnType<typeof setTimeout> | undefined;

  const runPipeline = async (): Promise<EditResult> => {
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
        return succeedEdit(r1, qv1, 0);
      }

      if (qv1.valid) {
        return succeedEdit(r1, qv1, 0);
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

    // ── SIMPLE fast-fail on no-op (no retry) ──────────────────────────────────
    // SIMPLE complexity means the model couldn't apply even a trivial single-op
    // edit. Retrying with an EXTREME instruction risks identity drift on a simple
    // request — fail immediately per fast-mode enforcement rules.
    if (r1 === null && attempt2Trigger === "no-op" && complexity === "SIMPLE") {
      const failMsg = "Image editing returned no visible change — please try a more descriptive instruction.";
      failJob(job, "SIMPLE no-op — fast-fail (no retry)");
      logger.warn(
        { complexity, mode: getEditModeLabel(mode), fastFail: true },
        "[imageEdit] SIMPLE no-op fast-fail — skipping retry per fast-mode enforcement",
      );
      throw new Error(failMsg);
    }

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
        return succeedEdit(r2, qv2, 1);
      }

      if (qv2.valid) {
        return succeedEdit(r2, qv2, 1);
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
  }; // end runPipeline

  // ── Race pipeline against hard deadline ───────────────────────────────────
  const deadlinePromise = new Promise<never>((_, reject) => {
    _deadlineTimerId = setTimeout(() => {
      reject(
        new Error(
          `Image editing timed out — the request exceeded ${EDIT_PIPELINE_HARD_TIMEOUT_MS / 1000}s. Please try again.`,
        ),
      );
    }, EDIT_PIPELINE_HARD_TIMEOUT_MS);
  });

  try {
    return await Promise.race([runPipeline(), deadlinePromise]);
  } catch (err) {
    // Deadline fired or runPipeline threw after its own catch (re-throw).
    // Mark failed if not already marked (deadline case won't have done so).
    if (job.status !== "failed") {
      const reason = err instanceof Error ? err.message : "Unknown error";
      failJob(job, reason);
      logger.error(
        { reason, jobId: job.jobId },
        "[imageEdit] global deadline or uncaught error — job marked failed",
      );
    }
    throw err;
  } finally {
    if (_deadlineTimerId !== undefined) clearTimeout(_deadlineTimerId);
  }
}
