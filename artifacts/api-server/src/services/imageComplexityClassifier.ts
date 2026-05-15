/**
 * Image Complexity Classifier — IB AI Assistant
 *
 * LAYER 0 of the Production Orchestration Engine.
 * Determines request complexity and job type before any processing begins.
 *
 * Complexity determines model routing (Layer 8):
 *   SIMPLE  → Gemini img2img only (fast path, short timeout)
 *   STANDARD → Gemini img2img → FLUX fallback (default path)
 *   HEAVY   → Gemini img2img → enhanced FLUX with richer prompt
 *
 * Job type determines logging and observability:
 *   IMAGE_EDIT_JOB        → user modifying an existing image
 *   IMAGE_GENERATION_JOB  → creating a new image from text
 *   IMAGE_TRANSFORMATION_JOB → full style/format change (GTA, Pixar, anime, etc.)
 */

import type { ImageIntent } from "./imageIntentClassifier";
import type { JobType, RequestComplexity } from "./imageJobManager";

// ── Heavy transformation indicators ────────────────────────────────────────────
// These signals require more compute and a richer FLUX prompt.

const HEAVY_STYLE_KEYWORDS = [
  "gta",
  "pixar",
  "disney",
  "studio ghibli",
  "anime",
  "manga",
  "cyberpunk",
  "3d render",
  "oil painting",
  "film noir",
  "impressionist",
  "pixel art",
  "watercolor",
  "cartoon",
  "hdr",
  "9:16",
  "16:9",
  "wallpaper",
  "cinematic wallpaper",
  "ultra sharp",
  "afro luxury",
  "neon cyberpunk",
];

const HEAVY_COMBO_THRESHOLD = 2; // 2+ style signals = HEAVY

const SIMPLE_SIGNALS = [
  "sharpen",
  "sharp",
  "brighten",
  "darken",
  "fix lighting",
  "fix colors",
  "denoise",
  "clarity",
  "contrast",
  "crop",
  "resize",
  "rotate",
];

// ── Transformation intent types ────────────────────────────────────────────────
// These intents always map to IMAGE_TRANSFORMATION_JOB.

const TRANSFORMATION_INTENTS: ImageIntent[] = [
  "STYLE_TRANSFER",
  "BACKGROUND_TRANSFORMATION",
  "OBJECT_MANIPULATION",
];

// ── Classifiers ────────────────────────────────────────────────────────────────

/**
 * Classify request complexity based on prompt content.
 * Drives model routing in Layer 8.
 */
export function classifyComplexity(prompt: string): RequestComplexity {
  const lower = prompt.toLowerCase().trim();

  // SIMPLE: single-operation enhancement, no style target
  const isSimple =
    SIMPLE_SIGNALS.some((s) => lower.includes(s)) &&
    !HEAVY_STYLE_KEYWORDS.some((k) => lower.includes(k));

  if (isSimple) return "SIMPLE";

  // HEAVY: contains heavy style keywords or 2+ style combinations
  const heavyMatches = HEAVY_STYLE_KEYWORDS.filter((k) => lower.includes(k));
  if (heavyMatches.length >= HEAVY_COMBO_THRESHOLD) return "HEAVY";
  if (heavyMatches.length === 1) {
    // Single heavy style = HEAVY (full style transform)
    return "HEAVY";
  }

  // STANDARD: everything else
  return "STANDARD";
}

/**
 * Classify job type based on intent and whether an image was provided.
 */
export function classifyJobType(intent: ImageIntent, hasImage: boolean): JobType {
  if (!hasImage || intent === "IMAGE_GENERATION") {
    return "IMAGE_GENERATION_JOB";
  }

  if (TRANSFORMATION_INTENTS.includes(intent)) {
    return "IMAGE_TRANSFORMATION_JOB";
  }

  return "IMAGE_EDIT_JOB";
}

/**
 * Return the Gemini timeout in ms appropriate for the complexity level.
 * SIMPLE gets a tighter timeout to fail fast; HEAVY gets more room.
 */
export function complexityTimeout(complexity: RequestComplexity): number {
  switch (complexity) {
    case "SIMPLE":
      return 18_000;
    case "STANDARD":
      return 25_000;
    case "HEAVY":
      return 32_000;
  }
}
