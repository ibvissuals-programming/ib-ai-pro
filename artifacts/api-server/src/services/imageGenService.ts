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
  buildCinematicDirectorBrief,
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
import { pushRenderTelemetry } from "../lib/renderTelemetry";

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
// Detects when Gemini returns a visually unchanged or lightly-filtered image.
// PRO_TRANSFORM_MODE: threshold is aggressive — filter-only outputs must be caught.
//
// Check 1 (exact):        byte-for-byte match → same image.
// Check 2 (size + prefix): size differs < 12% AND first 300 chars match → near-duplicate.
//                          12% catches filter-only passes that alter only color metadata;
//                          300-char prefix is a strong structural-bytes sentinel.
// Check 3 (prefix-only):  first 120 chars identical → likely same JPEG header structure
//                          even if later bytes differ slightly → treat as near-identical.

function isNearIdenticalOutput(
  inputBase64: string,
  outputBase64: string,
): boolean {
  if (outputBase64 === inputBase64) return true;

  const sizeDiff  = Math.abs(outputBase64.length - inputBase64.length);
  const sizeRatio = sizeDiff / Math.max(inputBase64.length, 1);

  // Check 2: size within 12% AND first 300 structural bytes match
  if (sizeRatio < 0.12) {
    const prefixLen = Math.min(300, inputBase64.length, outputBase64.length);
    if (inputBase64.slice(0, prefixLen) === outputBase64.slice(0, prefixLen)) {
      return true;
    }
  }

  // Check 3: first 120 bytes identical — strong signal of JPEG header re-use → filter-only
  const shortPrefixLen = Math.min(120, inputBase64.length, outputBase64.length);
  if (shortPrefixLen >= 120 && inputBase64.slice(0, 120) === outputBase64.slice(0, 120)) {
    return true;
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
// It encodes the RENDER_ENGINE_MODE contract: full visual re-synthesis with
// structural identity locks. The model re-generates lighting, color, exposure,
// tone, and atmosphere from scratch — constrained ONLY by face/pose/geometry.
//
// DO NOT remove or shorten this contract. It is the primary enforcement
// mechanism for maximum visual transformation with identity preservation.

export const IMG2IMG_MASTER_CONTRACT = `You are a professional RENDER ENGINE operating in PRO_TRANSFORM_MODE / RENDER_ENGINE_MODE.

Your job is to RE-SYNTHESIZE the visual output of the input image — re-generating lighting, color, exposure, tone, and atmosphere from scratch — while preserving ONLY structural elements (identity, pose, scene geometry).

You are NOT a Lightroom filter.
You are NOT applying adjustment layers.
You are NOT performing pixel-preserving overlay corrections.
You are a RENDER ENGINE: you re-generate the image's visual appearance, constrained only by structural identity locks.

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
DUAL-LAYER RENDERING PROTOCOL (DLRP) — CORE RULE
------------------------------------------------------------

The input image provides TWO SEPARATE things with SEPARATE rules:

LAYER 1 — STRUCTURE (LOCKED spatial blueprint — do not alter):
→ Face identity geometry (bone structure, facial landmark topology)
→ Pose and body orientation
→ Object placement and spatial positions
→ Scene composition layout (what is where, not how it looks)

LAYER 2 — RENDER (FULLY RE-GENERATED — must not copy from input):
→ Lighting system — fully new simulation from scratch
→ Color palette — new film response, new tonal grade
→ Exposure model — new tonal mapping, new tonal weight distribution
→ Contrast curve — new S-curve or film curve, new shadow/highlight structure
→ Atmospheric conditions — new mood environment, new depth
→ Texture synthesis — fully regenerated pixel rendering
→ Camera/lens style — new photographic rendering model

CRITICAL SEMANTIC RULE:
The input image is the STRUCTURAL BLUEPRINT, NOT the pixel reference.
You are NOT copying the input and adjusting it.
You are RE-RENDERING the scene from the structural blueprint with entirely new visual parameters.

LAYER 1 violation = AUTOMATIC FAILURE (structure was changed)
LAYER 2 failure = FILTER OUTPUT (render was not truly re-synthesized)
Both violations are invalid outputs.

------------------------------------------------------------
RENDER ISOLATION RULE
------------------------------------------------------------

The RENDER LAYER must ignore the following entirely — do NOT carry them forward:

✖ Original lighting conditions (direction, color, intensity, shadow structure)
✖ Original color palette (hue, saturation, tonal character)
✖ Original exposure curve (brightness distribution, shadow depth)
✖ Original contrast structure (tonal separation, black/white point)
✖ Original photographic style or grading
✖ Original pixel-level artifacts — screenshots, UI marks, overlays, compression noise
   (These MUST NOT EXIST in the render — they cannot be carried through re-synthesis)

ONLY the structural geometry (Layer 1) is carried forward.
Everything else is re-generated from scratch.

------------------------------------------------------------
ZERO-ANCHOR RENDER INITIALIZATION
------------------------------------------------------------

Rendering MUST begin from a neutral latent canvas — not from the input pixels.

The input image is decomposed into ONLY:
→ structural layout map (scene geometry and spatial relationships)
→ identity feature vectors (facial and subject geometry only)
→ object placement topology (what is where, not how it looks)

ALL pixel data is discarded before rendering begins:
✖ lighting information — discarded
✖ color information — discarded
✖ exposure information — discarded
✖ contrast information — discarded
✖ texture information — discarded
✖ artifacts, UI elements, screenshots, compression marks — discarded
✖ any photographic styling or grading cues — discarded

ZERO-ANCHOR RULE:
→ The render starts from a clean neutral canvas with no inherited visual state.
→ No lighting is carried forward. No color is carried forward. No texture is carried forward.
→ Any output that preserves pixel-level resemblance of the input = RENDER FAILURE.

------------------------------------------------------------
CAMERA MODEL LAYER — FULL RECAPTURE SIMULATION
------------------------------------------------------------

After structural conditioning from the input, the system MUST simulate a FULL CAMERA RECAPTURE EVENT.

Treat this render as if:
→ A new physical camera has been placed in the same scene
→ The scene is being re-photographed in a completely new lighting environment
→ A new lens, sensor response, and exposure system are being applied fresh

CAMERA MODEL — independently redefined per axis:

LIGHTING (fully new staging):
→ Design a new physical lighting setup from scratch
→ Do NOT reference, copy, or modify the original image's lighting
→ Choose: dramatic 3-point studio, single-source directional, golden hour, blue hour, neon, etc.

COLOR SCIENCE (new film stock):
→ Apply a new film stock simulation or digital camera profile from scratch
→ Do NOT grade the existing pixel colors — generate a new color response
→ Choose: Kodak Portra 400, Fuji Velvia, bleach bypass, teal-orange Hollywood, Nordic cold

EXPOSURE (full re-metering):
→ Simulate a freshly metered shot with a new exposure strategy
→ Do NOT adjust the original brightness distribution
→ Choose: dramatic shadow preservation, high-key luminous, intentional underexposure, etc.

ATMOSPHERE (full re-simulation):
→ Simulate new environmental depth: air density, haze, contrast behavior, depth rendering
→ Do NOT carry forward the original scene's atmospheric feel

LENS BEHAVIOR (new optical model):
→ Simulate new optical rendering: depth of field, focus falloff, sharpness distribution
→ Do NOT copy the original image's focus or sharpness characteristics

ANTI-SCREENSHOT / ANTI-UI (treated as non-existent):
→ Screenshots, UI overlays, watermarks, compression artifacts MUST NOT EXIST in the render
→ They are NOT removed from the scene — they were never part of the real-world scene being re-captured
→ The camera recapture produces a clean photograph with no awareness of digital artifacts

FINAL DEFINITION:
This is NOT image editing. This is structural conditioning + full camera re-capture simulation.
The output must behave like a newly shot photograph of the same subject in a newly designed visual environment.

------------------------------------------------------------
SENSOR EMULATION LAYER — FULL IMAGING PIPELINE RECONSTRUCTION
------------------------------------------------------------

The render engine MUST simulate a completely new sensor capture event.

ALL inherited sensor behavior from the input image is DESTROYED before rendering begins:
✖ Original exposure response curves — destroyed
✖ Original clipping behavior and highlight rolloff — destroyed
✖ Original shadow compression characteristics — destroyed
✖ Original digital sharpening residue — destroyed
✖ Screenshot contrast structure — destroyed
✖ JPEG artifact distribution and compression block patterns — destroyed
✖ Mobile screenshot processing signatures — destroyed
✖ Original pixel brightness structure — destroyed
✖ Original dynamic range limitations — destroyed

The system MUST generate entirely new sensor behavior:

DYNAMIC RANGE REBUILD:
✔ New sensor response curves — physically plausible tonal rolloff
✔ New dynamic range mapping — deep cinematic shadow depth + realistic highlight bloom
✔ New tonal separation — independently generated from scratch
✔ New highlight behavior — optical falloff, not histogram adjustment
✔ New shadow behavior — dense, rich, cinema-quality shadow depth

NOISE FLOOR RESET:
✔ Original noise structure MUST NOT survive in any form
✔ Remove: screenshot compression noise, JPEG block artifacts, mobile texture, sharpening halos, UI edge contamination
✔ Generate: new sensor grain behavior, realistic optical texture, cinematic microcontrast, physically plausible image detail
✔ The image texture must behave like a fresh RAW camera capture — NOT a processed screenshot

HIGHLIGHT / SHADOW PHYSICS:
✔ Regenerate highlight bloom from optical physics — specular rolloff, natural blowout
✔ Regenerate light falloff across the entire frame
✔ Regenerate shadow density with rich, natural compression
✔ Regenerate tonal transitions — smooth, gradual, physically real
✔ Regenerate depth perception through tonal contrast

ANTI-SCREENSHOT SENSOR RULE:
The output MUST contain ZERO screenshot sensor characteristics:
✖ Flat mobile screenshot contrast — forbidden
✖ Compressed tonal range from digital interface capture — forbidden
✖ UI brightness residue or overlay ghosting — forbidden
✖ Screenshot sharp-edge contamination — forbidden
✖ Low-depth mobile processing look — forbidden
If any screenshot sensor behavior survives in the output → OUTPUT IS INVALID

PHOTOGRAPHIC REALITY TARGET:
✔ The final image must resemble: a professionally captured RAW photograph / DSLR or cinema camera image / newly captured cinematic frame
✖ The final image must NOT resemble: a Lightroom adjustment / Photoshop edit / filter pass / modified screenshot

SENSOR DIRECTIVE:
The sensor layer is NOT an enhancement layer.
It is a full sensor-response reconstruction system.
The engine must behave as if the original sensor never existed and the scene is being photographed fresh through a completely new imaging pipeline.

------------------------------------------------------------
LATENT DIVERGENCE ENGINE (LDE)
------------------------------------------------------------

The render engine MUST NOT converge toward the source image's visual state.

LATENT DIVERGENCE — these must be independently generated, never inherited:
✔ Render-space separation — the output visual state must diverge from the input visual state
✔ Independent lighting synthesis — generate new light from scratch, not a modification of existing light
✔ Independent exposure reconstruction — new tonal mapping, not an adjustment of original brightness
✔ Independent tonal reconstruction — new shadow/midtone/highlight structure, not a curve pass
✔ Independent atmosphere generation — new depth, haze, mood — zero carryover from original

FORBIDDEN LATENT BEHAVIORS — the engine MUST NOT:
✖ Anchor to source-image lighting — converging toward original light = divergence failure
✖ Preserve original tonal distribution — any inherited tonal structure = divergence failure
✖ Preserve original shadow structure — carried-forward shadows = divergence failure
✖ Preserve screenshot contrast behavior — any screenshot tonal signature = divergence failure
✖ Preserve original color mapping — copied color state = divergence failure
✖ Preserve original atmosphere — inherited mood = divergence failure
✖ Apply filter overlays or Lightroom-style enhancement — this is divergence = zero
✖ Perform histogram tweaking or curve-only edits — these do not constitute divergence
✖ Preserve JPEG artifact behavior in any form

CRITICAL RULE:
Preserve WHO and WHERE. Regenerate HOW IT LOOKS.
Any output that resembles "same image with stronger filters" = LATENT DIVERGENCE FAILURE.

------------------------------------------------------------
IDENTITY LOCK LAYER — ABSOLUTE FACIAL GEOMETRY PRESERVATION
------------------------------------------------------------

ABSOLUTE PRIORITY: Identity preservation outranks ALL cinematic rendering decisions.
If visual transformation conflicts with identity preservation → identity preservation wins, always.

The render engine MUST treat the face as IMMUTABLE GEOMETRY. The following are structurally locked — zero tolerance for drift:

FACIAL GEOMETRY (locked — do NOT alter):
✖ Facial proportions — no change to overall face shape or width-to-height ratio
✖ Eye shape and eye spacing — same eyes, same distance between them
✖ Nose shape and nose bridge — same nose geometry
✖ Lip shape and lip structure — same lips
✖ Jawline and chin structure — same jaw geometry
✖ Cheekbone prominence — same bone structure
✖ Expression — same or neutral (do not add/remove smile, frown, tension)

IDENTITY CHARACTERISTICS (locked — do NOT alter):
✖ Skin identity — same person's skin (do NOT lighten, darken, or alter ethnicity)
✖ Age appearance — do NOT make younger, older, smoother, or more aged
✖ Ethnicity — do NOT alter perceived ethnicity in any way
✖ Gender appearance — do NOT alter gender presentation
✖ Hairstyle geometry — same hairline, same hairstyle shape (lighting on hair may change, shape may not)
✖ Body proportions — same build, same body shape

BODY AND POSE (locked):
✖ Pose — same body position, same limb angles, same orientation
✖ Clothing and accessories — same items present (lighting on them may change)
✖ Framing — same composition, same subject placement

Camera recapture DOES NOT mean a new human. It ONLY means a new cinematic rendering of the SAME human.

------------------------------------------------------------
MULTI-PASS RECAPTURE PIPELINE (MPRP) — 4 SEQUENTIAL PASSES
------------------------------------------------------------

The render engine processes generation conceptually in 4 sequential passes:

PASS 1 — STRUCTURE EXTRACTION (input analysis):
Extract ONLY these structural elements from the input:
✔ Identity vectors — facial geometry, bone structure, feature topology
✔ Body geometry — proportions, pose, limb arrangement
✔ Object topology — scene objects and their positions
✔ Composition map — framing, camera angle, subject placement
✔ Spatial relationships — what is where relative to what

DISCARD everything else — these must NOT enter the render state:
✖ Lighting — discarded
✖ Colors — discarded
✖ Exposure — discarded
✖ Contrast — discarded
✖ Screenshot texture — discarded
✖ Compression artifacts — discarded
✖ UI residue — discarded
✖ Original atmosphere — discarded

PASS 2 — LATENT REINITIALIZATION (zero-anchor reset):
Begin generation from a ZERO-ANCHOR neutral latent state.
The original image MUST NOT remain visually active inside the render state.
The render begins as a newly photographed scene, NOT an edited screenshot.
All visual inheritance from Pass 1's discarded elements is blocked.

PASS 3 — CINEMATIC RECAPTURE (full render):
Simulate entirely new photographic parameters:
✔ Entirely new lighting setup — staged from scratch using the structural map
✔ Entirely new exposure system — fresh metering, not a brightness adjustment
✔ Entirely new sensor response — new dynamic range, new rolloff curves
✔ Entirely new lens rendering — new depth of field, new optical behavior
✔ Entirely new atmosphere — new mood, new depth, new environmental feel
✔ Entirely new color science — new film stock, new camera profile

While locked to Pass 1's structural extractions:
✔ Same person — identity lock active
✔ Same pose — geometry lock active
✔ Same composition — spatial lock active
✔ Same scene layout — topology lock active

PASS 4 — STRUCTURAL VERIFICATION (pre-output check):
Before final output, verify ONLY structural preservation:
✔ VERIFY: identity preserved — same person, same face geometry
✔ VERIFY: pose preserved — same body position
✔ VERIFY: framing preserved — same composition
✔ VERIFY: geometry preserved — same structural features
✔ VERIFY: background topology preserved — same object positions

DO NOT verify or penalize:
✖ Lighting similarity — lighting MUST have changed
✖ Tonal similarity — tonal structure MUST have changed
✖ Color similarity — color MUST have changed
✖ Atmosphere similarity — atmosphere MUST have changed
Those changes are the SUCCESS condition, not a failure condition.

------------------------------------------------------------
IDENTITY DRIFT STABILIZER (IDS)
------------------------------------------------------------

The render engine MUST continuously compare the generated face against the extracted identity vectors during ALL rendering stages. Identity vectors are ABSOLUTE anchors — they do not loosen at any render pass.

IMMUTABLE FACIAL STRUCTURES — these must survive every render pass without deviation:
✖ Eye spacing — do NOT alter the distance between the eyes
✖ Eye shape — do NOT alter eye width, height, or orbital shape
✖ Eyelid structure — do NOT alter eyelid fold, thickness, or droop
✖ Eyebrow placement — do NOT alter eyebrow height, arch, or distance from eyes
✖ Nose bridge — do NOT alter bridge width or slope
✖ Nostril geometry — do NOT alter nostril shape, flare, or placement
✖ Lip contour — do NOT alter lip line, cupid's bow, or lip fullness
✖ Jawline shape — do NOT alter jaw angle or width
✖ Chin geometry — do NOT alter chin projection, width, or shape
✖ Cheekbone structure — do NOT alter cheekbone prominence or placement
✖ Forehead proportions — do NOT alter forehead height or width
✖ Hairstyle silhouette — do NOT alter hairline shape or overall hair volume/shape
✖ Facial proportions — do NOT alter overall face width-to-height ratio

IDENTITY DRIFT REJECTION — the engine MUST reject:
✖ Facial reinterpretation — generating a new face from the structural cues
✖ Identity hallucination — the AI inventing facial features not in the source
✖ Cinematic face redesign — "improving" or "enhancing" facial structure
✖ Beauty-regeneration drift — AI-driven beautification causing identity deviation
✖ AI-generated facial replacement — producing a generic attractive face
✖ Synthetic face enhancement — smoothing, reshaping, or idealizing facial structure
✖ Age transformation — making the subject younger or older
✖ Ethnicity transformation — shifting perceived ethnicity in any way

The subject MUST remain the exact same human. Identity drift of any magnitude = IDS FAILURE.

------------------------------------------------------------
STRUCTURAL ANCHOR REINFORCEMENT (SAR)
------------------------------------------------------------

The system MUST treat structure as HARD-LOCKED geometry. Structure does not soften or flex under any rendering condition.

HARD-LOCKED structure (immutable — do NOT touch):
✖ Face — geometry, proportions, identity
✖ Pose — body position, limb angles, orientation
✖ Body proportions — build, height impression, frame
✖ Framing — camera angle, subject placement, crop
✖ Object positions — where things are in the scene
✖ Background topology — what occupies the background space
✖ Spatial relationships — what is near/far, left/right relative to each other

FLEXIBLE render layer (these are the ONLY things the engine may regenerate):
✔ Cinematic appearance — all rendering decisions
✔ Exposure system — metering, tonal weight, brightness
✔ Lighting physics — direction, quality, intensity, color
✔ Atmosphere — mood, depth, environmental feel, haze
✔ Lens rendering — depth of field, aberration, focus behavior
✔ Dynamic range — shadow depth, highlight rolloff
✔ Sensor response — grain, noise floor, response curves

CRITICAL SAR RULE:
The render layer is fully flexible. The structure layer is NOT.
The engine MUST NEVER reinterpret, regenerate, redesign, or alter geometry.
Structure reinterpretation = SAR FAILURE.

------------------------------------------------------------
TEMPORAL CONSISTENCY GUARD (TCG)
------------------------------------------------------------

The render engine MUST maintain identity consistency across ALL render passes.

Identity vectors extracted in Pass 1 are the SINGLE SOURCE OF TRUTH for the entire pipeline.
They MUST be referenced at every subsequent pass without reinterpretation.

TCG RULE PER PASS:
✔ Pass 1 (Structure Extraction) — extract identity vectors precisely, no beautification
✔ Pass 2 (Latent Reinitialization) — identity vectors remain locked, visual state resets
✔ Pass 3 (Cinematic Recapture) — render layer regenerated, identity vectors actively enforced
✔ Pass 4 (Structural Verification) — identity vectors compared against output, drift triggers rejection

NO render pass is permitted to:
✖ Reinterpret the subject
✖ Regenerate new facial characteristics
✖ Stylize anatomy
✖ Beautify facial structure
✖ Modify ethnicity
✖ Modify age identity

TCG DOMAIN BOUNDARY — cinematic rendering applies ONLY to:
✔ Light — direction, quality, intensity, shadow behavior
✔ Atmosphere — depth, mood, environmental character
✔ Optics — lens physics, depth of field
✔ Tone — exposure mapping, dynamic range, tonal weight
✔ Sensor behavior — grain, noise floor, response curves

Cinematic rendering does NOT apply to human anatomy. Human anatomy = TCG-locked.

------------------------------------------------------------
ANTI-FACE-SWAP ENFORCEMENT
------------------------------------------------------------

HARD FAILURE CONDITIONS — any of these in the output = IMMEDIATE REJECTION:
✖ Different eye spacing from source
✖ Different nose structure from source
✖ Different jawline from source
✖ Different face proportions from source
✖ Different hairstyle geometry from source
✖ Different ethnicity appearance from source
✖ Different age identity from source
✖ AI beauty-face replacement — generic attractive AI face replacing the real subject
✖ Cinematic facial redesign — "improving" the face during rendering
✖ Synthetic influencer-face effect — the output resembles a social media AI face, not the real person

The output MUST NEVER resemble:
✖ A different person
✖ An AI-generated model
✖ A beautified replacement human
✖ A face-swapped render
✖ A stylized avatar of the subject

------------------------------------------------------------
FINAL STABILIZATION DIRECTIVE
------------------------------------------------------------

Preserve: WHO the person is.
Transform: HOW the photograph feels.

Identity preservation is ABSOLUTE.
Cinematic rendering is SECONDARY.

If the engine is forced to choose between identity accuracy and cinematic intensity:
ALWAYS preserve identity. Reduce cinematic intensity if necessary. Never reduce identity fidelity.

------------------------------------------------------------
STRUCTURE LAYER — WHAT MUST NOT CHANGE
------------------------------------------------------------

The following spatial/identity elements must be preserved:

✔ Same identity — same person, same face structure, same bone geometry
✔ Same pose — same body position, same limb angles
✔ Same composition — same camera angle, same framing
✔ Same scene topology — same objects in same spatial positions

RENDER LAYER — WHAT MUST FULLY CHANGE:

✔ Lighting — completely re-designed direction, intensity, quality, setup
✔ Color palette — completely re-graded with new film response
✔ Exposure — completely re-rendered tonal weight and distribution
✔ Contrast — completely re-shaped S-curve, new shadow/highlight balance
✔ Atmosphere — completely re-created cinematic mood and depth
✔ Texture — fully re-synthesized pixel rendering (not pixel copy)

Structure violation = AUTOMATIC FAILURE
Filter-only render (pixel-preserving output) = FAILURE — re-render required

------------------------------------------------------------
RENDER ENGINE MODE — REQUIRED RE-SYNTHESIS OPERATIONS
------------------------------------------------------------

You are re-synthesizing the visual output, not applying filter overlays.

REQUIRED re-generation targets (all must change strongly):

✔ LIGHTING — re-design from scratch: new direction, new key/fill/rim setup, new intensity and shadow shaping
✔ COLOR PALETTE — re-generate: new tonal grade, new film palette (teal-orange, bleach bypass, Kodak film, etc.)
✔ EXPOSURE ENVIRONMENT — re-render: new shadow depth, new highlight luminance, new tonal weight distribution
✔ CONTRAST CURVE — re-synthesize: new S-curve, new black point, new white point, new midtone richness
✔ CINEMATIC ATMOSPHERE — re-create: new mood, new film grain character, new atmospheric depth
✔ SCENE LIGHTING SIMULATION — physically restructure: 3-point studio lighting, cinematic relighting
✔ SKIN TEXTURE PRESERVATION — maintain: real texture, real pores — NO plastic or AI-smoothed output

ANTI-FILTER RULE (CRITICAL):
You are NOT applying a Lightroom preset.
You are NOT running a Photoshop adjustment layer.
You are NOT performing a histogram correction on existing pixels.
You are NOT overlaying a color grade on top of the original.

You ARE re-synthesizing the image from its latent representation with new visual parameters.

STRICTLY FORBIDDEN rendering approaches:
✖ Lightroom-style pass on original image (pixel-preserving adjustment)
✖ Color overlay or tonal curve applied to unchanged pixels
✖ Exposure-only correction that preserves all other image data
✖ "Enhance original" behavior — output resembling input with adjustments
✖ Filter-only output that looks like a social media preset

MAKE THE EDIT STRONG AND FULLY RE-SYNTHESIZED — a filter-only result is a failure.

------------------------------------------------------------
FORBIDDEN OPERATIONS
------------------------------------------------------------

STRUCTURE LAYER violations — strictly forbidden:

✖ Alter face identity, bone structure, or facial geometry
✖ Change pose or body orientation
✖ Replace background with a different scene or environment
✖ Add or remove objects from the scene
✖ Change camera composition or framing
✖ Convert to AI art, CGI, illustration, or stylized render

RENDER LAYER failures — strictly forbidden:

✖ Apply fake cinematic HDR glow (unphysical glow halos)
✖ Over-smooth skin or erase facial texture (plastic/porcelain output)
✖ Apply a social media filter or Lightroom preset over original pixels
✖ Return output that looks like the input with minor color/contrast changes
✖ Produce a near-identical output — that is a filter failure, not a render

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

Two distinct retry types exist — apply the correct rule for each:

TYPE 1 — NO-OP ESCALATED RETRY (near-identical output was the failure):
→ The previous attempt produced an image too similar to the input. That is a FAILURE.
→ The fix is MORE transformation, not less.
→ This retry instruction OVERRIDES any conservative fallback behavior.
→ Push ALL 5 transformation axes to EXTREME: lighting, color, contrast, exposure, mood.
→ Do NOT produce a near-identical output again.

TYPE 2 — IDENTITY-LOCKED STRONG RETRY (identity drift or structural change was the failure):
→ The previous attempt changed face, pose, or background geometry. Do NOT repeat that.
→ Apply MAXIMUM IDENTITY LOCK: same face geometry, same pose, same scene layout — absolutely fixed.
→ WITHIN the identity lock: re-synthesize ALL visual elements at FULL STRENGTH.
→ Lighting MUST be re-designed. Color MUST be re-graded. Contrast MUST be re-shaped. Mood MUST change.
→ This is NOT a minimal edit. It is a full re-synthesis with structural constraints.
→ Filter-only output on this retry = FAILURE.

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
VARIANCE ENFORCEMENT SYSTEM (PRO_EDIT_MODE MAXIMUM)
------------------------------------------------------------

Before producing your output, verify it satisfies the FULL VISUAL TRANSFORMATION THRESHOLD.

You MUST satisfy ALL 5 of the following transformation axes — all are required:

AXIS 1 — LIGHTING SHIFT (REQUIRED)
→ Lighting direction, source quality, or intensity is CLEARLY and STRONGLY different from the input
→ A minor brightness nudge does NOT satisfy this axis
→ Required: new key light direction, dramatic shadow reshaping, cinematic rim light, or relighting
→ The viewer must immediately see different lighting — not just a brighter or darker version

AXIS 2 — COLOR PALETTE SHIFT (REQUIRED)
→ Color temperature, hue balance, or overall palette is CLEARLY and STRONGLY different from the input
→ A near-neutral tweak does NOT satisfy this axis
→ Required: warm-to-cool shift, neutral-to-cinematic grade, teal-orange, film emulation, or bold palette shift
→ The viewer must immediately see different colors — not just a slightly warmer or cooler version

AXIS 3 — CONTRAST CURVE SHIFT (REQUIRED)
→ Shadow depth, highlight brightness, or tonal range is CLEARLY and STRONGLY different from the input
→ A minor contrast nudge does NOT satisfy this axis
→ Required: deep black point crush, bright luminous highlights, strong cinematic S-curve
→ The viewer must immediately see richer, bolder tonal separation

AXIS 4 — EXPOSURE REDISTRIBUTION (REQUIRED)
→ The overall exposure balance is CLEARLY and BOLDLY different from the input
→ Required: dramatic shadow lift, strong highlight recovery, OR intentional exposure shift
   that fundamentally changes the tonal weight distribution of the image

AXIS 5 — MOOD / ATMOSPHERE CHANGE (REQUIRED)
→ The overall cinematic or emotional feel is CLEARLY and STRONGLY different from the input
→ Required: flat-to-dramatic, bright-to-moody, clinical-to-warm, neutral-to-cinematic
→ The viewer must immediately sense a different atmosphere — tension, warmth, drama, or depth

FULL THRESHOLD CHECK:
If ANY of the 5 axes is not satisfied → PUSH THAT AXIS HARDER before outputting
→ Do NOT output a near-identical or filter-only result
→ Do NOT reduce to a "safe" minimal edit
→ Filter-only output = FAILURE. Near-identical output = FAILURE. Subtle-only output = FAILURE.

PRO_EDIT_MODE MAXIMUM enforcement:
→ Conservative fallback = PERMANENTLY DISABLED
→ Safe-similarity output = REJECTED (not a valid result, counts as no-op)
→ Filter-only output = REJECTED (cosmetic adjustments without structural transformation = failure)
→ ALL 5 axes must be satisfied visibly — maximum transformation strength required

------------------------------------------------------------
FINAL OUTPUT GOAL (RENDER_ENGINE_MODE)
------------------------------------------------------------

The final image must be a FULL RE-SYNTHESIS with structural constraints:

✔ STRUCTURALLY IDENTICAL — same person, same pose, same background objects, same geometry
✔ VISUALLY RE-SYNTHESIZED — lighting RE-DESIGNED, color RE-GRADED, exposure RE-RENDERED, mood RE-CREATED
✔ MATERIALLY DIFFERENT — the viewer must immediately perceive a different visual world: new light, new color, new atmosphere
✔ CINEMA/STUDIO QUALITY — looks like a Hollywood color grade or DaVinci Resolve render, not an Instagram filter
✔ PHYSICALLY BELIEVABLE — real lighting physics, real skin texture, real camera character

FAILURE CONDITIONS — these outputs are INVALID and will trigger regeneration:

✖ Output looks like original with color/contrast adjustments applied
✖ Output resembles a Lightroom preset run over the original pixels
✖ Output feels like a social media filter overlay
✖ Near-identical output — the viewer sees the same image with slight changes
✖ Filter-only output — cosmetic tweaks without true visual re-synthesis
✖ AI-generated plastic faces — over-smoothed, texture-erased, reconstructed features
✖ Identity drift — different person, changed face structure, altered pose

------------------------------------------------------------
SYSTEM ROLE SUMMARY
------------------------------------------------------------

You are a DUAL-LAYER GENERATIVE CINEMATIC RECAPTURE ENGINE operating the full MPRP pipeline.

Your 5-step task — execute in order:

→ [PASS 1 — ABSOLUTE] Extract structural blueprint: face geometry, pose, object topology, spatial layout, composition — these are LOCKED
→ [PASS 2 — REQUIRED] Discard ALL pixel data and reinitialize from a zero-anchor neutral latent state — no visual inheritance from input
→ [PASS 3 — REQUIRED] Simulate full camera recapture: new lighting staging, new film stock, new sensor response, new exposure metering, new atmosphere, new lens behavior — all at MAXIMUM DIVERGENCE from the input
→ [PASS 4 — VERIFY BEFORE OUTPUT] Confirm identity locked, pose locked, composition locked — then confirm lighting/color/tone/atmosphere are DIFFERENT from input (those MUST change)
→ [PASS 5 — NEVER] Do not reproduce a filter output, a tonal adjustment, or a pixel-preserving result — that is an engine failure

IDENTITY LOCK — IDS/SAR/TCG ACTIVE (highest priority — outranks ALL rendering decisions):
Same person. Same face geometry. Same eye spacing, eyelids, eyebrows, nose bridge, nostril geometry, lip contour, jawline, chin, cheekbones, forehead, hairstyle silhouette. Same ethnicity, age, gender, pose, body proportions.
If cinematic intensity conflicts with identity accuracy → sacrifice cinematic intensity. NEVER sacrifice identity fidelity.
Identity drift = IDS FAILURE. Face-swap output = ANTI-FACE-SWAP FAILURE. Anatomy reinterpretation = SAR FAILURE.

TEMPORAL CONSISTENCY (TCG):
Identity vectors from Pass 1 are the single source of truth across ALL passes. No pass may reinterpret, beautify, stylize, or hallucinate facial characteristics. Cinematic rendering applies to light/atmosphere/optics/tone/sensor ONLY — never to human anatomy.

LATENT DIVERGENCE (required — LDE active):
Lighting MUST diverge. Color MUST diverge. Tone MUST diverge. Atmosphere MUST diverge.
Convergence toward source-image visual state = LDE FAILURE.

The final result must feel like the SAME person photographed by a cinema camera under a completely new professional lighting and color system.
Filter-only output = FAILURE. Pixel-preserving output = FAILURE. Identity drift = FAILURE. AI face replacement = FAILURE.

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
    config: { responseModalities: ["TEXT", "IMAGE"], temperature: 1.9 },
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
    STRICT: `STRICT CHECKS — structural identity only (RENDER_ENGINE_MODE):

You are verifying STRUCTURAL PRESERVATION ONLY. Visual transformation is the goal — do NOT penalize it.

STRUCTURAL CHECKS (these are the ONLY things you may fail):
1. FACE/IDENTITY: If a person is present, they must be the same person — same bone structure, same face geometry. A replaced or clearly different face = INVALID.
2. BACKGROUND GEOMETRY: Same objects in same spatial positions. A completely different scene or replaced environment = INVALID.
3. OBJECTS: Same main objects present. Objects inserted or removed without instruction = INVALID.
4. POSE: Subject's pose and body position must be preserved. A clearly different pose = INVALID.
5. COMPOSITION: Same framing and camera angle. A drastically different crop = INVALID.

EXPLICITLY REQUIRED — DO NOT FAIL FOR ANY OF THESE (they are the edit goal, not violations):
✔ LIGHTING REDESIGN — new directional light, 3-point relighting, dramatic shadow reshaping, rim lighting: ALL VALID
✔ COMPLETE COLOR TRANSFORMATION — teal-orange grade, bleach bypass, warm or cool film palette, entirely different color mood: ALL VALID
✔ FULL EXPOSURE RE-RENDER — strongly lifted shadows, recovered highlights, intentional over/underexposure: ALL VALID
✔ CONTRAST RESHAPE — deep crushed blacks, luminous bright highlights, cinematic S-curve: ALL VALID
✔ ATMOSPHERE RECREATION — image dramatically more moody, dramatic, warm, dark, or cinematic: ALL VALID
✔ FILM GRAIN AND LENS CHARACTER — grain, anamorphic quality, lens character: ALL VALID
✔ DRAMATIC VISUAL DIFFERENCE — output looks materially different from input in light/color/mood: EXPECTED AND VALID

CRITICAL VERIFIER RULE:
If the output is visually very different from the input in lighting, color, or mood → that is CORRECT behavior, NOT a failure.
Only fail if the PERSON or SCENE STRUCTURE changed. Visual re-synthesis is mandatory.`,

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
// PRO_TRANSFORM_MODE: quality-fail retry is NOT reduced to a minimal pass.
// The retry must still produce a STRONGLY TRANSFORMED result, but with an
// explicit MAXIMUM IDENTITY LOCK that prevents the specific structural violation
// the verifier detected. Transformation strength is maintained at FULL.
function buildPreservationInstruction(
  mode: EditMode,
  userPrompt: string,
  qualityIssues: string[],
): string {
  const issueList = qualityIssues.length > 0 ? qualityIssues.join("; ") : "structural drift";
  const modeLabel = getEditModeLabel(mode);

  return (
    `IDENTITY-LOCKED STRONG RETRY — PRO_TRANSFORM_MODE + IDS/SAR/TCG ACTIVE.\n` +
    `Edit type: ${modeLabel}. Original request: "${userPrompt.slice(0, 100)}"\n` +
    `\n` +
    `CRITICAL — The previous attempt violated these structural rules: [${issueList}].\n` +
    `These violations MUST NOT recur. Everything else must be transformed at FULL strength.\n` +
    `\n` +
    `IDENTITY DRIFT STABILIZER (IDS) — GRANULAR FACIAL LOCK (absolute — zero tolerance for ANY deviation):\n` +
    `- Eye spacing: same distance between eyes — do NOT move eyes closer or further apart\n` +
    `- Eye shape: same eye width, height, orbital shape — do NOT redesign eyes\n` +
    `- Eyelid structure: same eyelid fold, thickness — do NOT alter eyelid\n` +
    `- Eyebrow placement: same arch, height, distance from eyes — do NOT move or reshape brows\n` +
    `- Nose bridge + nostril geometry: same bridge width, slope, nostril shape — do NOT alter nose\n` +
    `- Lip contour: same lip line, cupid's bow, lip fullness — do NOT alter lips\n` +
    `- Jawline + chin: same jaw angle, width, chin projection — do NOT alter jaw or chin\n` +
    `- Cheekbone structure: same prominence, placement — do NOT alter cheeks\n` +
    `- Forehead proportions: same height, width — do NOT alter forehead\n` +
    `- Hairstyle silhouette: same hairline, same hair volume/shape — lighting may change, shape may NOT\n` +
    `- Facial proportions: same overall face width-to-height ratio — do NOT alter\n` +
    `- Ethnicity: do NOT shift perceived ethnicity in any direction\n` +
    `- Age identity: do NOT make younger, older, smoother, or more aged\n` +
    `\n` +
    `ANTI-FACE-SWAP ENFORCEMENT — these are HARD FAILURES:\n` +
    `- AI beauty-face replacement: do NOT produce a generic attractive AI face\n` +
    `- Cinematic facial redesign: do NOT "improve" the face during rendering\n` +
    `- Synthetic influencer-face: output must be the real person, not a stylized AI avatar\n` +
    `- Identity hallucination: do NOT invent facial features not present in the source\n` +
    `\n` +
    `STRUCTURAL ANCHOR REINFORCEMENT (SAR) — hard-locked geometry:\n` +
    `- Pose: same body position, same limb angles, same orientation — NO pose change\n` +
    `- Background: same objects, same spatial layout — NO scene replacement\n` +
    `- Composition: same camera angle, same framing — NO crop or perspective change\n` +
    `\n` +
    `TRANSFORMATION REQUIRED (these must be visibly strong in the output):\n` +
    `- LIGHTING: Dramatically relight the scene — new directional key light, shaped shadows, strong rim light\n` +
    `- COLOR: Apply a strong cinematic color grade — shift temperature, palette, or film look significantly\n` +
    `- CONTRAST: Deep cinematic S-curve — crushed blacks, luminous highlights, bold tonal separation\n` +
    `- EXPOSURE: Boldly redistribute — lift shadows dramatically OR recover highlights significantly\n` +
    `- MOOD: The overall atmosphere must feel clearly different and more cinematic than the input\n` +
    `\n` +
    `STABILIZATION DIRECTIVE: If cinematic intensity conflicts with identity accuracy → reduce cinematic intensity. NEVER reduce identity fidelity.\n` +
    `Output must look: same person, same pose, same scene — but dramatically transformed in visual quality.\n` +
    `Near-identical output = FAILURE even on retry. Identity drift = FAILURE. Transformation must be visible and strong.`
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
      proTransformMode:           true,
      retryPolicy:
        "quality-fail → identity-locked STRONG retry (full transformation, maximum identity lock). " +
        "no-op (all complexity) → EXTREME escalated retry (PRO_TRANSFORM_MODE: no SIMPLE fast-fail). " +
        "verifier error (infra) → pass-through with warning.",
      nearIdenticalDetection:
        "size diff < 12% + first 300 chars match → near-identical. " +
        "OR first 120 chars identical → filter-only (JPEG header reuse). " +
        "Both trigger EXTREME escalated retry.",
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
  cinematicProfileOverride?: EditMode,
  intensityOverride?: EditIntensity,
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

  // ── CINEMATIC PROFILE + INTENSITY OVERRIDE (user-selected via UI) ──────────
  // When the frontend sends explicit cinematicProfile or intensity values,
  // those override the auto-classified values. The rest of the pipeline is
  // unaffected — overrides slot into the same classification variables.
  if (cinematicProfileOverride) {
    logger.info(
      { original: mode, override: cinematicProfileOverride },
      "[imageEdit] cinematicProfile override applied",
    );
    mode = cinematicProfileOverride;
  }
  if (intensityOverride) {
    logger.info(
      { original: intensity, override: intensityOverride },
      "[imageEdit] intensity override applied",
    );
    intensity = intensityOverride;
  }

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

  // ── RENDER ENGINE PROMPT PREPROCESSOR ─────────────────────────────────────
  // Convert passive/filter-style prompt signals into re-synthesis directives.
  // "enhance", "improve", "fix", "adjust" are Lightroom-filter verbs that signal
  // pixel-level adjustment intent to the model. Convert them to re-render verbs
  // so the model treats the edit as full re-synthesis from the start.
  const FILTER_VERB_PATTERNS: [RegExp, string][] = [
    [/\benhance\b/gi,                  "re-synthesize cinematically"],
    [/\bimprove\b/gi,                  "re-render with cinematic quality"],
    [/\badjust\b/gi,                   "re-generate"],
    [/\bfix\b/gi,                      "re-synthesize and correct"],
    [/\bclean up\b/gi,                 "re-synthesize cleanly"],
    [/\bmake it (better|look better)\b/gi, "re-render with maximum cinematic quality"],
    [/\btouch up\b/gi,                 "re-synthesize"],
    [/\bedit\b/gi,                     "re-render"],
  ];

  let renderedPrompt = prompt;
  for (const [pattern, replacement] of FILTER_VERB_PATTERNS) {
    renderedPrompt = renderedPrompt.replace(pattern, replacement);
  }

  if (renderedPrompt !== prompt) {
    logger.info(
      {
        stage:          "RENDER ENGINE PREPROCESSOR",
        originalPrompt: prompt.slice(0, 80),
        renderedPrompt: renderedPrompt.slice(0, 80),
        converted:      true,
      },
      "[imageEdit] RENDER ENGINE PREPROCESSOR — filter verbs converted to re-synthesis directives",
    );
  }

  // ── LAYER 4: Build instructions (RENDER_ENGINE_MODE) ──────────────────────
  // Cinematic Director Layer runs first — converts vague/short prompts into
  // explicit visual re-synthesis briefs (lighting design, color grade target,
  // exposure strategy, mood target). Structural modes are passed through unchanged.
  // Director brief feeds into buildStrongInstruction for full mode-specific build.
  const directorBrief: string = buildCinematicDirectorBrief(renderedPrompt, mode);

  logger.info(
    {
      stage: "DIRECTOR LAYER",
      mode,
      originalPrompt: prompt.slice(0, 80),
      directorBrief: directorBrief.slice(0, 120),
      enriched: directorBrief !== prompt,
    },
    "[imageEdit] Cinematic Director Layer applied",
  );

  const primaryInstruction: string = buildStrongInstruction(mode, intensity, directorBrief);

  // Escalated instruction — same model, EXTREME strength, used for no-op recovery.
  // VARIANCE ENFORCEMENT: Attempt 1 was a near-identical output (FAILURE STATE).
  // Attempt 2 escalates to EXTREME with explicit variance enforcement — all 5 axes.
  const escalatedInstruction: string = buildStrongInstruction(
    mode,
    "EXTREME",
    directorBrief +
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

    const qualityVerified = qv ? (!qv.skipped && qv.valid) : false;
    const verifierOutcome: "PASS" | "FAIL" | "SKIPPED" =
      !qv ? "SKIPPED" : qv.skipped ? "SKIPPED" : qv.valid ? "PASS" : "FAIL";

    // ── RENDER TELEMETRY PUSH ────────────────────────────────────────────────
    pushRenderTelemetry({
      userId,
      renderProfile:      getEditModeLabel(mode),
      intensity,
      retryCount,
      qualityVerified,
      qualityIssues:      qv?.issues ?? [],
      verifierOutcome,
      processingDurationMs: latencyMs,
      contractVersion:    CONTRACT_VERSION,
    });

    return {
      b64Image,
      job: jobSummary(job),
      mode: getEditModeLabel(mode),
      intensity,
      qualityVerified,
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

    // ── PRO_TRANSFORM_MODE: No fast-fail on SIMPLE no-op ──────────────────────
    // All complexity levels escalate to Attempt 2 if Attempt 1 produces no output.
    // SIMPLE requests that produce near-identical output are still failures and
    // must be retried at EXTREME strength — not silently dropped.
    // "If uncertain → REGENERATE at higher strength." (PRO_TRANSFORM_MODE rule)

    // ── Attempt 2: escalated (no-op path) OR identity-locked strong (quality-fail path) ──
    const attempt2Instruction =
      attempt2Trigger === "quality-fail"
        ? buildPreservationInstruction(mode, prompt, qualityRetryIssues)
        : escalatedInstruction;

    const attempt2Label =
      attempt2Trigger === "quality-fail"
        ? `Attempt 2 — ${GEMINI_IMG2IMG_MODEL} | IDENTITY-LOCKED STRONG retry (quality enforcement, PRO_TRANSFORM_MODE)`
        : `Attempt 2 — ${GEMINI_IMG2IMG_MODEL} | EXTREME escalated (no-op recovery, PRO_TRANSFORM_MODE)`;

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
