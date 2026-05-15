/**
 * Image Intent Classifier — IB AI Assistant
 *
 * LAYER 1 of the Master Image System.
 * Classifies any image-related request into exactly one of 7 intents.
 *
 * Priority order (most specific → least specific):
 *   1. BACKGROUND_TRANSFORMATION
 *   2. OBJECT_MANIPULATION
 *   3. STYLE_TRANSFER
 *   4. COLOR_MOOD_EDIT
 *   5. IMAGE_ENHANCEMENT
 *   6. IMAGE_EDITING (generic catch-all for edits)
 *   7. IMAGE_GENERATION (no image, or explicit create signals)
 *
 * Safe-mode default (uncertain prompt + image present): IMAGE_ENHANCEMENT
 */

export type ImageIntent =
  | "IMAGE_EDITING"
  | "IMAGE_GENERATION"
  | "STYLE_TRANSFER"
  | "IMAGE_ENHANCEMENT"
  | "OBJECT_MANIPULATION"
  | "BACKGROUND_TRANSFORMATION"
  | "COLOR_MOOD_EDIT";

// ── Rule definitions ──────────────────────────────────────────────────────────

interface IntentRule {
  intent: ImageIntent;
  phrases: string[];
  keywords: string[];
}

const INTENT_RULES: IntentRule[] = [
  // ── 1. BACKGROUND_TRANSFORMATION ──────────────────────────────────────────
  {
    intent: "BACKGROUND_TRANSFORMATION",
    phrases: [
      "remove background",
      "change background",
      "replace background",
      "transparent background",
      "no background",
      "delete background",
      "new background",
      "swap background",
      "different background",
      "cut out background",
    ],
    keywords: ["background", "backdrop", "scene behind", "surroundings"],
  },

  // ── 2. OBJECT_MANIPULATION ────────────────────────────────────────────────
  {
    intent: "OBJECT_MANIPULATION",
    phrases: [
      "add object",
      "remove object",
      "delete object",
      "erase object",
      "add person",
      "remove person",
      "add element",
      "take out",
      "put in",
      "insert into",
    ],
    keywords: ["erase", "insert", "place object", "inpaint"],
  },

  // ── 3. STYLE_TRANSFER ─────────────────────────────────────────────────────
  {
    intent: "STYLE_TRANSFER",
    phrases: [
      "anime version",
      "anime style",
      "make it anime",
      "turn into anime",
      "gta style",
      "gta version",
      "pixar style",
      "pixar version",
      "disney style",
      "cartoon style",
      "comic style",
      "sketch style",
      "oil painting style",
      "watercolor style",
      "studio ghibli",
      "manga style",
      "cyberpunk style",
      "vintage film look",
      "film noir style",
      "3d render style",
      "pixel art style",
      "afro luxury portrait",
      "afro luxury",
      "luxury instagram vibe",
      "viral tiktok",
      "studio portrait edit",
    ],
    keywords: [
      "anime",
      "pixar",
      "gta",
      "disney",
      "cartoon",
      "comic",
      "sketch",
      "watercolor",
      "oil painting",
      "illustration",
      "manga",
      "cyberpunk",
      "vintage",
      "retro",
      "film noir",
      "impressionist",
      "3d render",
      "pixel art",
      "afro luxury",
      "tiktok",
    ],
  },

  // ── 4. COLOR_MOOD_EDIT ────────────────────────────────────────────────────
  {
    intent: "COLOR_MOOD_EDIT",
    phrases: [
      "change color",
      "color grading",
      "color grade",
      "change mood",
      "black and white",
      "grayscale",
      "sepia tone",
      "warm tones",
      "cool tones",
      "teal and orange",
      "luxury vibe",
      "moody vibe",
      "dark mood",
      "bright mood",
      "cinematic look",
      "cinematic grade",
      "cinematic color",
      "afro luxury",
    ],
    keywords: [
      "moody",
      "vibrant",
      "warm",
      "cool",
      "teal",
      "desaturate",
      "saturate",
      "hue",
      "tone",
      "tint",
      "palette",
      "mood",
      "atmosphere",
      "dramatic",
      "grayscale",
      "sepia",
    ],
  },

  // ── 5. IMAGE_ENHANCEMENT ──────────────────────────────────────────────────
  {
    intent: "IMAGE_ENHANCEMENT",
    phrases: [
      "make it sharp",
      "make it sharper",
      "fix lighting",
      "improve lighting",
      "fix quality",
      "improve quality",
      "better quality",
      "more realistic",
      "more detailed",
      "hdr realism",
      "make it hd",
      "make it 4k",
      "make it 8k",
      "ultra realistic",
    ],
    keywords: [
      "sharp",
      "sharpen",
      "fix",
      "repair",
      "restore",
      "upscale",
      "denoise",
      "clarity",
      "crisp",
      "hdr",
      "4k",
      "8k",
    ],
  },

  // ── 6. IMAGE_EDITING (generic) ─────────────────────────────────────────────
  {
    intent: "IMAGE_EDITING",
    phrases: [
      "make it cinematic",
      "cinematic version",
      "luxury aesthetic",
      "studio portrait",
      "studio lighting",
      "make it professional",
      "make it artistic",
    ],
    keywords: [
      "cinematic",
      "luxury",
      "studio",
      "professional",
      "artistic",
      "realistic",
      "surreal",
      "lighting",
      "retouch",
      "recolor",
      "relight",
      "brighten",
      "darken",
      "adjust",
      "modify",
      "alter",
      "update",
      "convert",
    ],
  },
];

const GENERATION_SIGNALS = [
  "generate",
  "create",
  "make a ",
  "make me a",
  "make an ",
  "draw a",
  "draw me",
  "produce",
  "new image",
  "new picture",
  "render a",
  "design a",
  "imagine a",
];

const EDIT_OVERRIDE_SIGNALS = [
  "edit",
  "change",
  "modify",
  "transform",
  "make it",
  "make this",
  "style it",
  "fix",
  "improve",
  "enhance",
  "add",
  "remove",
  "apply",
];

// ── Main classifier ────────────────────────────────────────────────────────────

/**
 * Classify a user prompt into one of 7 image intents.
 *
 * @param prompt - The user's text instruction
 * @param hasImage - Whether an image was uploaded with the request
 */
export function classifyImageIntent(prompt: string, hasImage: boolean): ImageIntent {
  const lower = prompt.toLowerCase().trim().replace(/\s+/g, " ");

  // No image → pure generation
  if (!hasImage) {
    return "IMAGE_GENERATION";
  }

  // Explicit generation signal without any edit override → generation
  const hasGenSignal = GENERATION_SIGNALS.some((s) => lower.includes(s));
  const hasEditOverride = EDIT_OVERRIDE_SIGNALS.some((s) => lower.includes(s));
  if (hasGenSignal && !hasEditOverride) {
    return "IMAGE_GENERATION";
  }

  // Walk intent rules in priority order
  for (const rule of INTENT_RULES) {
    if (rule.phrases.some((p) => lower.includes(p))) {
      return rule.intent;
    }
    if (rule.keywords.some((k) => lower.includes(k))) {
      return rule.intent;
    }
  }

  // Safe-mode default: IMAGE_ENHANCEMENT
  return "IMAGE_ENHANCEMENT";
}

// ── Intent → Gemini edit instruction ─────────────────────────────────────────

/**
 * Build an intent-aware instruction string for Gemini's image edit prompt.
 * This replaces the generic "Edit this image: [prompt]" with a precisely
 * scoped instruction matched to what the user actually wants.
 */
export function buildEditInstruction(intent: ImageIntent, userPrompt: string): string {
  const p = userPrompt.trim();

  switch (intent) {
    case "STYLE_TRANSFER":
      return `Transform this image into the following style: ${p}. Preserve the subject's identity, facial features, and body. Apply only the style — do not alter the person's face or change who they are.`;

    case "IMAGE_ENHANCEMENT":
      return `Enhance this image: ${p}. Improve sharpness, lighting, clarity, and overall quality. Preserve the exact composition, subject identity, and content — do not add or remove anything.`;

    case "OBJECT_MANIPULATION":
      return `Perform the following object-level edit on this image: ${p}. Be precise and surgical — only affect the targeted object(s). Preserve everything else including the subject's face and identity.`;

    case "BACKGROUND_TRANSFORMATION":
      return `Change the background of this image: ${p}. Keep the foreground subject (person, object) completely intact — same pose, same face, same appearance. Only modify what is behind the subject.`;

    case "COLOR_MOOD_EDIT":
      return `Apply the following color and mood transformation to this image: ${p}. Adjust tones, lighting mood, and color grading only. Preserve the subject's identity, expression, and composition.`;

    case "IMAGE_EDITING":
    default:
      return `Edit this image: ${p}. Preserve the same person, face, identity, and overall composition. Apply only the requested visual change.`;
  }
}

// ── Human-readable label ──────────────────────────────────────────────────────

export function getIntentLabel(intent: ImageIntent): string {
  const labels: Record<ImageIntent, string> = {
    IMAGE_EDITING: "Image Editing",
    IMAGE_GENERATION: "Image Generation",
    STYLE_TRANSFER: "Style Transfer",
    IMAGE_ENHANCEMENT: "Image Enhancement",
    OBJECT_MANIPULATION: "Object Manipulation",
    BACKGROUND_TRANSFORMATION: "Background Transformation",
    COLOR_MOOD_EDIT: "Color & Mood Edit",
  };
  return labels[intent];
}
