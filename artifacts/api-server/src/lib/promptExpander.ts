/**
 * promptExpander.ts — IB AI Assistant
 *
 * Smart Prompt Generation Engine.
 * Converts brief ideas into professional-grade, richly detailed prompts
 * using Gemini 2.5 Flash text generation.
 *
 * Architecture rules:
 *   - Non-blocking: fast path, 15s timeout via providerGuard
 *   - Opt-in: only called when expandPrompt=true is set on the request
 *   - Standalone: also exposed as POST /api/prompt/expand for direct use
 *
 * Categories:
 *   cinematic        — film lighting, color grading, lens characteristics
 *   portrait         — studio photography, skin detail, compositional rules
 *   fashion_editorial — Vogue-grade styling, editorial vocabulary
 *   creative_fantasy  — epic concept art, magical world-building
 *   realism_boost    — photorealism specs, material rendering, technical detail
 *   social_media_viral — platform-optimized visual energy, trend vocabulary
 */
import { ai }                  from "@workspace/integrations-gemini-ai";
import { withProviderTimeout } from "./providerGuard";
import { logger }              from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export const PROMPT_CATEGORIES = [
  "cinematic",
  "portrait",
  "fashion_editorial",
  "creative_fantasy",
  "realism_boost",
  "social_media_viral",
] as const;

export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<PromptCategory, string> = {
  cinematic:          "Cinematic Enhancement",
  portrait:           "Portrait Enhancement",
  fashion_editorial:  "Fashion / Editorial",
  creative_fantasy:   "Creative Fantasy",
  realism_boost:      "Photorealism Boost",
  social_media_viral: "Social Media Viral",
};

export const CATEGORY_DESCRIPTIONS: Record<PromptCategory, string> = {
  cinematic:
    "Adds film lighting, color grading, lens characteristics, and cinematic atmosphere",
  portrait:
    "Adds studio lighting setup, lens choice, background treatment, and skin rendering quality",
  fashion_editorial:
    "Adds Vogue-grade styling, dramatic editorial lighting, and fashion industry vocabulary",
  creative_fantasy:
    "Adds epic scale, magical atmosphere, detailed world-building, and painterly quality",
  realism_boost:
    "Adds photorealism specs, material rendering, lighting physics, and technical photography detail",
  social_media_viral:
    "Adds vibrant energy, platform-optimized composition, trend vocabulary, and scroll-stopping direction",
};

const CATEGORY_EXAMPLES: Record<PromptCategory, { input: string; output: string }> = {
  cinematic: {
    input:  "make cinematic",
    output: "cinematic film lighting, dramatic tonal contrast, shallow depth of field, professional teal-orange color grading, atmospheric shadows, anamorphic lens distortion, ultra-realistic rendering",
  },
  portrait: {
    input:  "professional headshot",
    output: "professional studio portrait, three-point lighting setup with soft key light, clean white seamless background, 85mm portrait lens, shallow depth of field, sharp eye focus, natural skin tone rendering, editorial quality",
  },
  fashion_editorial: {
    input:  "fashion photo",
    output: "high fashion editorial photography, Vogue aesthetic, dramatic directional lighting, strong shadows, bold composition, luxury styling, confident posture, fashion forward",
  },
  creative_fantasy: {
    input:  "magic forest",
    output: "epic fantasy concept art, enchanted ancient forest, bioluminescent flora, volumetric god rays, mystical atmosphere, rich environmental detail, painterly digital art quality",
  },
  realism_boost: {
    input:  "portrait photo",
    output: "photorealistic portrait, Canon 5D Mark IV, 85mm f/1.4, ISO 100, natural window light, Rembrandt lighting, micro-detail skin texture, catchlights in eyes, 8K resolution",
  },
  social_media_viral: {
    input:  "aesthetic photo",
    output: "vibrant high-contrast aesthetic photography, Instagram-worthy composition, dynamic leading lines, punchy color palette, golden hour warmth, scroll-stopping visual energy, trend-forward styling",
  },
};

export interface ExpandedPrompt {
  original:       string;
  expanded:       string;
  category:       PromptCategory;
  wordsBefore:    number;
  wordsAfter:     number;
  expansionRatio: number;
}

// ── System prompts ────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS: Record<PromptCategory, string> = {
  cinematic: `You are an expert cinematographer and AI image prompt engineer.
Your task: transform a brief idea into a rich, detailed cinematic image generation prompt.
Rules:
- Keep the core subject recognisable and expand everything around it aggressively
- Add: specific lighting direction, lens type and focal length, color grade style, atmosphere, shadow quality, film stock or rendering quality
- Use precise professional film and photography vocabulary — be specific, not generic
- Avoid vague filler phrases
- Output ONLY the expanded prompt — no explanations, no labels, no quotes
- Target 120–150 words`,

  portrait: `You are an expert portrait photographer and AI image prompt engineer.
Your task: transform a brief idea into a rich, detailed portrait photography prompt.
Rules:
- Keep the core subject and expand aggressively with professional studio detail
- Add: lighting setup (key light position, fill ratio, rim light), specific lens and aperture, background treatment, skin rendering quality, eye sharpness, depth of field
- Use precise photography studio vocabulary — name specific equipment and techniques
- Avoid vague filler phrases
- Output ONLY the expanded prompt — no explanations, no labels, no quotes
- Target 120–150 words`,

  fashion_editorial: `You are a fashion director and AI image prompt engineer working for a luxury magazine.
Your task: transform a brief idea into a rich, detailed high-fashion editorial photography prompt.
Rules:
- Keep the core subject and expand aggressively into editorial territory
- Add: Vogue-grade lighting setup, dramatic composition, luxury styling direction, colour palette, editorial atmosphere, specific fashion vocabulary
- Reference specific fashion aesthetics, designers, or publications where relevant
- Avoid vague filler phrases
- Output ONLY the expanded prompt — no explanations, no labels, no quotes
- Target 120–150 words`,

  creative_fantasy: `You are an epic fantasy concept artist and AI image prompt engineer.
Your task: transform a brief idea into a rich, detailed fantasy concept art prompt.
Rules:
- Keep the core subject and expand aggressively with world-building and atmospheric detail
- Add: magical atmosphere, epic scale, environmental storytelling, specific lighting (volumetric rays, bioluminescence, fire, moonlight), colour mood, painterly art style and rendering quality
- Use specific concept art and fantasy illustration vocabulary
- Avoid vague filler phrases
- Output ONLY the expanded prompt — no explanations, no labels, no quotes
- Target 120–150 words`,

  realism_boost: `You are a photorealism specialist and AI image prompt engineer.
Your task: transform a brief idea into a rich, technically detailed photorealistic image prompt.
Rules:
- Keep the core subject and expand aggressively with camera and lighting physics
- Add: specific camera model, lens focal length and aperture, ISO, lighting setup and direction, material rendering detail, surface texture, depth of field, resolution spec
- Use precise technical photography and CGI rendering vocabulary
- Avoid vague filler phrases
- Output ONLY the expanded prompt — no explanations, no labels, no quotes
- Target 120–150 words`,

  social_media_viral: `You are a social media content strategist and visual designer.
Your task: transform a brief idea into a rich, detailed social media image prompt optimised for engagement.
Rules:
- Keep the core subject and expand aggressively with platform-optimised visual energy
- Add: colour strategy (punchy vs warm vs pastel), composition direction, lighting quality, trend vocabulary, emotional hook, aspect ratio consideration, specific visual energy level
- Reference current visual trends and scroll-stopping techniques specifically
- Avoid vague filler phrases
- Output ONLY the expanded prompt — no explanations, no labels, no quotes
- Target 120–150 words`,
};

// ── Core expansion ────────────────────────────────────────────────────────────

const EXPANDER_TIMEOUT_MS = 15_000;

export async function expandPrompt(
  prompt:   string,
  category: PromptCategory,
): Promise<ExpandedPrompt> {
  logger.debug(
    { category, promptLength: prompt.length },
    "[promptExpander] expanding prompt",
  );

  const userMessage =
    `Transform this brief idea into a rich, professional image generation prompt. ` +
    `Expand it fully with specific visual detail.\n\n` +
    `Idea: ${prompt}`;

  const response = await withProviderTimeout(
    () => ai.models.generateContent({
      model:    "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config:   {
        systemInstruction: SYSTEM_INSTRUCTIONS[category],
        maxOutputTokens:   512,
        temperature:       0.75,
      },
    }),
    EXPANDER_TIMEOUT_MS,
    "gemini-prompt-expander",
  );

  const expanded = ((response as { text?: string }).text ?? "").trim();

  if (!expanded) {
    throw new Error("Prompt expander returned empty result — using original");
  }

  const wordsBefore    = prompt.split(/\s+/).filter(Boolean).length;
  const wordsAfter     = expanded.split(/\s+/).filter(Boolean).length;
  const expansionRatio = wordsBefore > 0 ? Math.round((wordsAfter / wordsBefore) * 10) / 10 : 1;

  logger.info(
    { category, wordsBefore, wordsAfter, expansionRatio },
    "[promptExpander] expansion complete",
  );

  return { original: prompt, expanded, category, wordsBefore, wordsAfter, expansionRatio };
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

export function getCategoryMeta(): Array<{
  id:          PromptCategory;
  label:       string;
  description: string;
  example:     { input: string; output: string };
}> {
  return PROMPT_CATEGORIES.map((id) => ({
    id,
    label:       CATEGORY_LABELS[id],
    description: CATEGORY_DESCRIPTIONS[id],
    example:     CATEGORY_EXAMPLES[id],
  }));
}
