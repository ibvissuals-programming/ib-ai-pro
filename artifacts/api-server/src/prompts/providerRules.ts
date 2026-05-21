/**
 * providerRules.ts — Production Multimodal AI Behavioral Spec
 *
 * Single source of truth for AI provider behavioral rules across all modalities.
 * Referenced by imageGenService, ttsService, videoService, and their routes.
 *
 * PRIORITY ORDER (highest to lowest):
 *   1. Successfully produce output (no failures)
 *   2. Maintain provider compatibility (Gemini / TTS / Veo safe usage)
 *   3. Reduce latency and retry risk
 *   4. Only then optimize quality
 *
 * HARD CONSTRAINTS:
 *   - If any instruction is unclear, choose the simplest valid interpretation
 *   - Do NOT over-enhance or over-generate complexity
 *   - Prefer stable, conservative outputs over experimental ones
 *   - Never assume unsupported features exist (especially video or advanced editing)
 */

import type { EditMode } from "../services/imageGenService";
import type { VoiceStyle } from "../services/ttsService";
import type { VideoMode } from "../services/videoService";

// ── Image rules ───────────────────────────────────────────────────────────────
//
//   - Preserve identity exactly (no facial changes)
//   - Only improve lighting, clarity, and composition
//   - Avoid heavy stylization unless explicitly requested
//   - If uncertain → default to POLISH mode (safest)

export const IMAGE_RULES = {
  UNCERTAIN_FALLBACK:  "polish"          as EditMode,
  IDENTITY_LOCK:       "MAXIMUM"         as const,
  DEFAULT_INSTRUCTION: "Improve lighting, clarity, and composition only. Preserve all identity exactly.",
} as const;

// ── Voice rules ───────────────────────────────────────────────────────────────
//
//   - Use clear, neutral pacing unless style is specified
//   - Avoid dramatic exaggeration unless CINEMATIC is explicitly requested
//   - Keep output clean and readable for TTS synthesis

export const VOICE_RULES = {
  UNCERTAIN_FALLBACK:  "neutral_assistant" as VoiceStyle,
  DRAMATIC_STYLE:      "cinematic_narration" as VoiceStyle,
} as const;

// ── Video rules ───────────────────────────────────────────────────────────────
//
//   - If video generation is uncertain or unsupported, fallback to:
//     "subtle cinematic motion only"
//   - Avoid complex motion instructions unless required
//   - Keep camera movement minimal and stable

export const VIDEO_RULES = {
  UNCERTAIN_FALLBACK:  "subtle_animation" as VideoMode,
  COMPLEX_MODES:       ["social_motion", "zoom_parallax"] as VideoMode[],
  SAFE_MODES:          ["subtle_animation", "cinematic_motion"] as VideoMode[],
} as const;

// ── Fail-safe resolvers ───────────────────────────────────────────────────────
//
// Each resolver accepts an incoming value and returns it if valid,
// or the safe conservative fallback if the value is absent or unrecognized.

const VALID_EDIT_MODES: EditMode[] = [
  "portrait_safe", "cinematic", "style_transfer", "creative",
  "polish", "social", "luxury", "restore",
];

const VALID_VOICE_STYLES: VoiceStyle[] = [
  "cinematic_narration", "female_soft", "male_deep",
  "energetic_social", "neutral_assistant",
];

const VALID_VIDEO_MODES: VideoMode[] = [
  "cinematic_motion", "zoom_parallax", "social_motion", "subtle_animation",
];

export function resolveSafeImageMode(mode: string | null | undefined): EditMode {
  if (mode && (VALID_EDIT_MODES as string[]).includes(mode)) {
    return mode as EditMode;
  }
  return IMAGE_RULES.UNCERTAIN_FALLBACK;
}

export function resolveSafeTtsStyle(style: string | null | undefined): VoiceStyle {
  if (style && (VALID_VOICE_STYLES as string[]).includes(style)) {
    return style as VoiceStyle;
  }
  return VOICE_RULES.UNCERTAIN_FALLBACK;
}

export function resolveSafeVideoMode(mode: string | null | undefined): VideoMode {
  if (mode && (VALID_VIDEO_MODES as string[]).includes(mode)) {
    return mode as VideoMode;
  }
  return VIDEO_RULES.UNCERTAIN_FALLBACK;
}
