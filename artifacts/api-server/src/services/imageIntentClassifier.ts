/**
 * Image Intent + Mode Classifier — IB AI Assistant
 *
 * LAYER 1 — Mode Classifier (new taxonomy):
 *   SUBTLE_ENHANCEMENT        — minor fixes: brightness, sharpness, small corrections
 *   CINEMATIC_EDIT            — dramatic cinematic lighting, atmosphere, grading
 *   AGGRESSIVE_RECONSTRUCTION — strong full-image rebuild, remove screenshot feel
 *   SCREENSHOT_CLEANUP        — remove UI overlays, watermarks, text artifacts
 *   WALLPAPER_UPGRADE         — wide/phone wallpaper treatment, dramatic scenery
 *   TEXT_REMOVAL              — remove text, watermarks, overlays
 *   STYLE_TRANSFER            — anime, GTA, Pixar, oil painting, etc.
 *   OBJECT_MANIPULATION       — add/remove/move objects
 *   BACKGROUND_TRANSFORMATION — change/remove background
 *   COLOR_MOOD_EDIT           — color grading, mood adjustment
 *
 * LAYER 2 — Transformation Strength:
 *   LOW     — subtle, minor, gentle
 *   MEDIUM  — default moderate transformation
 *   HIGH    — dramatic, strong cinematic
 *   EXTREME — aggressive, full reconstruction, maximum
 *
 * Backward compat: all v1 exports (ImageIntent, classifyImageIntent,
 * buildEditInstruction, getIntentLabel) are preserved unchanged.
 */

// ── v2 types ──────────────────────────────────────────────────────────────────

export type EditMode =
  | "SUBTLE_ENHANCEMENT"
  | "CINEMATIC_EDIT"
  | "AGGRESSIVE_RECONSTRUCTION"
  | "SCREENSHOT_CLEANUP"
  | "WALLPAPER_UPGRADE"
  | "TEXT_REMOVAL"
  | "STYLE_TRANSFER"
  | "OBJECT_MANIPULATION"
  | "BACKGROUND_TRANSFORMATION"
  | "COLOR_MOOD_EDIT";

export type EditIntensity = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

// ── LAYER 2: Intensity detection ──────────────────────────────────────────────

const EXTREME_SIGNALS = [
  "completely transform",
  "fully reconstruct",
  "maximum cinematic",
  "extreme",
  "totally remake",
  "from scratch",
  "make it unrecognizable",
  "aggressive",
  "fully cinematic",
  "maximum transformation",
  "full reconstruction",
];

const HIGH_SIGNALS = [
  "dramatic",
  "strong",
  "heavy",
  "cinematic",
  "luxury",
  "premium",
  "professional",
  "studio lighting",
  "relight",
  "reconstruct",
  "transform",
  "overhaul",
  "completely",
  "powerful",
  "bold",
  "intense",
  "epic",
];

const LOW_SIGNALS = [
  "slightly",
  "subtle",
  "little",
  "minor",
  "small",
  "gentle",
  "soft",
  "lightly",
  "a bit",
  "just a touch",
  "barely",
  "minimal",
  "tiny",
];

export function detectEditIntensity(
  prompt: string,
  mode: EditMode,
): EditIntensity {
  const lower = prompt.toLowerCase().trim();

  if (EXTREME_SIGNALS.some((s) => lower.includes(s))) return "EXTREME";

  // Screenshot cleanup and aggressive reconstruction are always HIGH minimum
  if (mode === "SCREENSHOT_CLEANUP" || mode === "AGGRESSIVE_RECONSTRUCTION") {
    return HIGH_SIGNALS.some((s) => lower.includes(s)) ? "EXTREME" : "HIGH";
  }

  // Cinematic/wallpaper get HIGH by default (their purpose is transformation)
  if (mode === "CINEMATIC_EDIT" || mode === "WALLPAPER_UPGRADE") {
    if (LOW_SIGNALS.some((s) => lower.includes(s))) return "MEDIUM";
    return HIGH_SIGNALS.some((s) => lower.includes(s)) ? "HIGH" : "HIGH";
  }

  if (LOW_SIGNALS.some((s) => lower.includes(s))) return "LOW";
  // PRO_EDIT_MODE: HIGH is the default minimum — no silent fallback to MEDIUM.
  // MEDIUM is only used when an explicit LOW signal was detected above.
  return "HIGH";
}

// ── LAYER 1: Mode classification rules ───────────────────────────────────────

const MODE_RULES: Array<{
  mode: EditMode;
  phrases: string[];
  keywords: string[];
}> = [
  {
    mode: "SCREENSHOT_CLEANUP",
    phrases: [
      "clean up screenshot",
      "remove ui",
      "remove interface",
      "remove status bar",
      "clean screenshot",
      "remove overlay",
      "remove watermark",
      "remove text overlay",
      "clean this up",
      "remove the text",
      "remove notification",
      "make it look real",
      "remove the ui",
      "no watermark",
      "remove caption",
      "clean the phone",
      "remove the bar",
    ],
    keywords: [
      "screenshot",
      "watermark",
      "overlay",
      "status bar",
      "notification",
      "ui element",
      "interface",
      "caption",
      "sticker",
      "label",
    ],
  },
  {
    mode: "TEXT_REMOVAL",
    phrases: [
      "remove text",
      "erase text",
      "delete text",
      "remove the words",
      "remove writing",
      "erase writing",
      "clean the text",
      "remove logo text",
      "remove the logo",
    ],
    keywords: [],
  },
  {
    mode: "BACKGROUND_TRANSFORMATION",
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
  {
    mode: "OBJECT_MANIPULATION",
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
  {
    mode: "STYLE_TRANSFER",
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
      "film noir",
      "impressionist",
      "3d render",
      "pixel art",
    ],
  },
  {
    mode: "WALLPAPER_UPGRADE",
    phrases: [
      "make it a wallpaper",
      "phone wallpaper",
      "desktop wallpaper",
      "cinematic wallpaper",
      "wallpaper edit",
      "9:16 format",
      "16:9 format",
      "landscape wallpaper",
      "portrait wallpaper",
    ],
    keywords: ["wallpaper"],
  },
  {
    mode: "AGGRESSIVE_RECONSTRUCTION",
    phrases: [
      "remove screenshot feel",
      "make it look real",
      "make it cinematic",
      "cinematic version",
      "fully reconstruct",
      "completely remake",
      "heavy edit",
      "transform completely",
      "aggressive edit",
    ],
    keywords: [
      "reconstruct",
      "rebuild",
      "remake",
      "remaster",
    ],
  },
  {
    mode: "CINEMATIC_EDIT",
    phrases: [
      "cinematic look",
      "cinematic lighting",
      "add cinematic",
      "luxury aesthetic",
      "studio lighting",
      "dramatic lighting",
      "relight",
      "hollywood lighting",
      "film look",
      "professional lighting",
      "make it luxury",
      "premium look",
      "cinematic grade",
      "cinematic color",
    ],
    keywords: [
      "cinematic",
      "relight",
      "dramatic",
      "luxury",
      "studio",
      "hollywood",
      "filmic",
      "anamorphic",
      "hdr",
      "depth of field",
    ],
  },
  {
    mode: "COLOR_MOOD_EDIT",
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
      "moody vibe",
      "dark mood",
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
      "grayscale",
      "sepia",
    ],
  },
  {
    mode: "SUBTLE_ENHANCEMENT",
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
      "make it hd",
      "make it 4k",
      "make it 8k",
    ],
    keywords: [
      "sharpen",
      "sharp",
      "fix",
      "repair",
      "restore",
      "denoise",
      "clarity",
      "crisp",
      "enhance",
      "improve",
      "brighten",
      "darken",
      "contrast",
    ],
  },
];

export function classifyEditMode(
  prompt: string,
  hasImage: boolean,
): EditMode {
  if (!hasImage) return "SUBTLE_ENHANCEMENT";

  const lower = prompt.toLowerCase().trim().replace(/\s+/g, " ");

  for (const rule of MODE_RULES) {
    if (rule.phrases.some((p) => lower.includes(p))) return rule.mode;
    if (rule.keywords.length > 0 && rule.keywords.some((k) => lower.includes(k))) return rule.mode;
  }

  return "SUBTLE_ENHANCEMENT";
}

// ── LAYER 4: Strong cinematic instruction builder ─────────────────────────────

export function buildStrongInstruction(
  mode: EditMode,
  intensity: EditIntensity,
  userPrompt: string,
): string {
  const p = userPrompt.trim();

  switch (mode) {
    case "SCREENSHOT_CLEANUP":
      return (
        `This image contains screenshot artifacts, UI overlays, text elements, or digital interface remnants. ` +
        `REMOVE ALL of the following: status bars, notification icons, navigation chrome, app overlays, ` +
        `text annotations, watermarks, stickers, emoji overlays, compression artifacts, and interface elements. ` +
        `Reconstruct ALL removed areas naturally using intelligent contextual fill — the repaired regions ` +
        `must seamlessly blend with the surrounding environment, matching lighting, texture, and depth. ` +
        `Additional instruction: ${p}. ` +
        `Final result must look like an original professional camera photograph with zero digital artifact or interface remnant. ` +
        `Preserve the main subject identity completely.`
      );

    case "TEXT_REMOVAL":
      return (
        `Remove all text, watermarks, logos, written words, and typographic elements from this image. ` +
        `Reconstruct all removed areas with natural contextual fill matching the surrounding environment. ` +
        `Additional instruction: ${p}. ` +
        `The result must look like a clean photograph with no traces of text or overlays. ` +
        `Preserve the main subject and composition completely.`
      );

    case "AGGRESSIVE_RECONSTRUCTION": {
      const strengthLine =
        intensity === "EXTREME"
          ? `COMPLETELY REBUILD the lighting from scratch. Apply extreme HDR contrast. Deep shadows, bright highlights.`
          : `Strongly rebuild the lighting. Apply strong HDR contrast with rich shadow depth.`;
      return (
        `Perform aggressive cinematic reconstruction: ${p}. ` +
        strengthLine + ` ` +
        `Physically simulate a 3-point lighting setup: powerful key light, controlled fill, strong rim/backlight. ` +
        `Apply professional film-grade color grading: deep rich shadows, controlled highlights, cinematic midtones. ` +
        `Add optical depth of field — sharp subject, natural background separation. ` +
        `Reconstruct any screenshot artifacts, UI overlays, or digital noise with photorealistic texture. ` +
        `Add subtle lens bloom on the brightest highlights and fine film grain. ` +
        `Final output must look like a frame from a high-budget film production, not a phone photo or screenshot. ` +
        `Subject identity, face, clothing, logos, and pose must remain completely unchanged.`
      );
    }

    case "CINEMATIC_EDIT": {
      if (intensity === "LOW" || intensity === "MEDIUM") {
        return (
          `Apply cinematic enhancement: ${p}. ` +
          `Add directional studio lighting with natural shadow definition. ` +
          `Apply gentle HDR contrast and subtle film-grade color grading. ` +
          `Slightly increase depth of field separation. ` +
          `Subject identity, face, clothing, and pose must remain completely unchanged.`
        );
      }
      const extremeLine =
        intensity === "EXTREME"
          ? `Apply EXTREME cinematic transformation — this should look like a $200M Hollywood film frame.`
          : `Apply strong Hollywood-grade cinematic transformation.`;
      return (
        `${extremeLine} Edit: ${p}. ` +
        `Apply a professional 3-point lighting setup: powerful directional key light, soft fill light to control shadow depth, ` +
        `and a strong rim/backlight to separate the subject from the background. ` +
        `Shape HDR contrast: deep rich shadows, luminous controlled highlights, cinematic midtone richness. ` +
        `Apply optical depth of field — sharp subject with natural background separation. ` +
        `Color grade with premium film palette: deep cool shadows, warm neutral skin tones, controlled highlights. ` +
        `Add subtle anamorphic lens bloom on the brightest highlights and light organic film grain. ` +
        `This must look physically relit by a Hollywood cinematographer — NOT a social media filter or Instagram edit. ` +
        `Subject identity, face, clothing, logos, and pose must remain completely unchanged.`
      );
    }

    case "WALLPAPER_UPGRADE":
      return (
        `Transform this image into a premium wallpaper: ${p}. ` +
        `Apply dramatic wide-cinematic color grading with deep shadows and vivid highlights. ` +
        `Enhance depth of field for cinematic separation. ` +
        `Add subtle environmental lighting — make the scene feel physically lit and atmospheric. ` +
        `Sharpen key subjects, add gentle HDR enhancement to the environment. ` +
        `Final result should feel like a premium editorial wallpaper with cinematic production value. ` +
        `Preserve all subjects, faces, and logos.`
      );

    case "STYLE_TRANSFER":
      return (
        `Transform this image into the following style: ${p}. ` +
        `Fully commit to the style — make it unmistakably that aesthetic, not a subtle filter. ` +
        `Preserve the subject's identity, facial features, body proportions, and clothing. ` +
        `Apply only the style transformation — do not alter who the person is.`
      );

    case "OBJECT_MANIPULATION":
      return (
        `Perform the following object-level edit on this image: ${p}. ` +
        `Be precise and surgical — only affect the targeted object(s). ` +
        `Reconstruct any affected areas naturally with contextual fill. ` +
        `Preserve everything else including the subject's face, identity, and composition.`
      );

    case "BACKGROUND_TRANSFORMATION":
      return (
        `Change the background of this image: ${p}. ` +
        `Keep the foreground subject completely intact — same pose, same face, same appearance, same lighting on the subject. ` +
        `Only modify what is behind the subject. Blend the subject naturally into the new background with matching lighting.`
      );

    case "COLOR_MOOD_EDIT":
      return (
        `Apply the following color and mood transformation: ${p}. ` +
        `Adjust tones, lighting mood, and color grading to match the requested atmosphere. ` +
        `Make the color change visible and intentional — not a subtle shift. ` +
        `Preserve the subject's identity, expression, and composition entirely.`
      );

    case "SUBTLE_ENHANCEMENT":
    default: {
      // Anti-AI artifact rule — appended to all SUBTLE_ENHANCEMENT outputs.
      // The model must produce a DSLR-style Lightroom correction, not an AI render.
      const antiAiRule =
        ` ANTI-AI-ARTIFACT RULE (non-negotiable): ` +
        `Do NOT create plastic, porcelain, or over-smoothed skin — preserve every pore, line, and natural skin texture. ` +
        `Do NOT apply fake HDR glow, artificial depth exaggeration, or cinematic bokeh not present in the original. ` +
        `Do NOT reconstruct or alter any facial feature. ` +
        `Output must look like a real DSLR photograph with a professional Lightroom correction — NOT an AI-rendered image.`;

      if (intensity === "HIGH" || intensity === "EXTREME") {
        return (
          `Apply strong professional photo enhancement to this exact image: ${p}. ` +
          `Perform these operations only — in order of priority: ` +
          `(1) Correct exposure: lift shadows, recover highlights, balance midtones. ` +
          `(2) Normalize contrast: deep controlled blacks, clean whites, rich midtone separation. ` +
          `(3) White balance: remove color cast, achieve neutral accurate skin tones. ` +
          `(4) Sharpening: apply professional local sharpening to edges and textures. ` +
          `(5) Local color grading: subtle non-destructive tonal refinement for professional quality. ` +
          `(6) Noise reduction: clean sensor noise while preserving fine texture detail. ` +
          `Output must be a professionally corrected photograph — the same scene, same subject, same composition, same background. ` +
          `Face, identity, pose, body, background, and framing must be completely unchanged.` +
          antiAiRule
        );
      }
      return (
        `Apply subtle professional photo enhancement to this exact image: ${p}. ` +
        `Perform these operations only: ` +
        `(1) Exposure correction: subtle lift of underexposed areas, gentle recovery of blown highlights. ` +
        `(2) Contrast: gentle normalization for clean tonal distribution. ` +
        `(3) White balance: correct any color cast for neutral, accurate tones. ` +
        `(4) Mild sharpening: lightly sharpen key areas of texture and detail. ` +
        `(5) Noise reduction: reduce visible grain while preserving natural texture. ` +
        `Output must look like the same photograph — professionally corrected but structurally identical. ` +
        `Do not change the face, identity, pose, background, objects, composition, or framing.` +
        antiAiRule
      );
    }
  }
}

export function getEditModeLabel(mode: EditMode): string {
  const labels: Record<EditMode, string> = {
    SUBTLE_ENHANCEMENT: "Subtle Enhancement",
    CINEMATIC_EDIT: "Cinematic Edit",
    AGGRESSIVE_RECONSTRUCTION: "Aggressive Reconstruction",
    SCREENSHOT_CLEANUP: "Screenshot Cleanup",
    WALLPAPER_UPGRADE: "Wallpaper Upgrade",
    TEXT_REMOVAL: "Text Removal",
    STYLE_TRANSFER: "Style Transfer",
    OBJECT_MANIPULATION: "Object Manipulation",
    BACKGROUND_TRANSFORMATION: "Background Transformation",
    COLOR_MOOD_EDIT: "Color & Mood Edit",
  };
  return labels[mode];
}

// ── v1 backward-compat exports (unchanged) ────────────────────────────────────

export type ImageIntent =
  | "IMAGE_EDITING"
  | "IMAGE_GENERATION"
  | "STYLE_TRANSFER"
  | "IMAGE_ENHANCEMENT"
  | "OBJECT_MANIPULATION"
  | "BACKGROUND_TRANSFORMATION"
  | "COLOR_MOOD_EDIT";

interface IntentRule {
  intent: ImageIntent;
  phrases: string[];
  keywords: string[];
}

const INTENT_RULES: IntentRule[] = [
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

export function classifyImageIntent(
  prompt: string,
  hasImage: boolean,
): ImageIntent {
  const lower = prompt.toLowerCase().trim().replace(/\s+/g, " ");

  if (!hasImage) return "IMAGE_GENERATION";

  const hasGenSignal = GENERATION_SIGNALS.some((s) => lower.includes(s));
  const hasEditOverride = EDIT_OVERRIDE_SIGNALS.some((s) => lower.includes(s));
  if (hasGenSignal && !hasEditOverride) return "IMAGE_GENERATION";

  for (const rule of INTENT_RULES) {
    if (rule.phrases.some((p) => lower.includes(p))) return rule.intent;
    if (rule.keywords.some((k) => lower.includes(k))) return rule.intent;
  }

  return "IMAGE_ENHANCEMENT";
}

export function buildEditInstruction(
  intent: ImageIntent,
  userPrompt: string,
): string {
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
