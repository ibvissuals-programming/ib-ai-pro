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

// ── CINEMATIC DIRECTOR LAYER ──────────────────────────────────────────────────
// Converts vague or generic user prompts into explicit cinematic visual transformation
// briefs before they reach the instruction builder.
//
// Applied only to visual-transformation modes. Structural modes (SCREENSHOT_CLEANUP,
// TEXT_REMOVAL, OBJECT_MANIPULATION, BACKGROUND_TRANSFORMATION) pass through unchanged
// because their operation is geometric, not aesthetic.
//
// Flow: user prompt → buildCinematicDirectorBrief → buildStrongInstruction → model

const DIRECTOR_SKIP_MODES: EditMode[] = [
  "SCREENSHOT_CLEANUP",
  "TEXT_REMOVAL",
  "OBJECT_MANIPULATION",
  "BACKGROUND_TRANSFORMATION",
];

// Prompt already has explicit visual direction — enhance without overriding user intent.
const EXPLICIT_VISUAL_SIGNALS = [
  "teal", "orange", "warm", "cool", "golden", "moody", "cinematic",
  "film", "grunge", "vintage", "kodak", "fuji", "fujifilm", "bleach",
  "bypass", "dramatic", "dark", "bright", "vibrant", "muted", "desaturated",
  "soft light", "hard light", "rim light", "backlight", "studio",
  "natural light", "golden hour", "blue hour", "overcast", "high contrast",
  "low contrast", "editorial", "fashion", "noir", "moody blue", "split tone",
  "color grade", "colour grade", "lut", "preset", "palette",
];

// Prompt is intentionally vague — full director brief injection required.
const VAGUE_SIGNALS = [
  "enhance", "improve", "make it better", "make better", "make it good",
  "make it look good", "make it look nice", "make it nice", "make it look great",
  "fix", "touch up", "edit this", "edit it", "clean it up", "upgrade",
  "beautify", "refresh", "polish", "boost", "make it pop", "make it professional",
  "make it look professional", "make it look real",
];

interface DirectorStyle {
  name:       string;
  lighting:   string;
  colorGrade: string;
  exposure:   string;
  mood:       string;
  brief:      string;
}

const DIRECTOR_STYLES: Record<string, DirectorStyle> = {
  PORTRAIT_CINEMATIC: {
    name:       "PORTRAIT CINEMATIC",
    lighting:   "soft window key light from the side with gentle fill, subtle practical rim light separating subject from background",
    colorGrade: "warm film tones — Kodak Portra-style skin rendering, creamy luminous highlights, controlled cool blue-shadow grade",
    exposure:   "lifted shadows revealing natural detail, recovered highlights with filmic rolloff, rich midtone depth",
    mood:       "intimate, premium editorial portrait — warm, polished, professional DSLR feel",
    brief:      "cinematic portrait enhancement — soft side key light, warm Kodak film grade, lifted shadow detail, intimate editorial mood",
  },
  EDITORIAL_HIGH_CONTRAST: {
    name:       "EDITORIAL HIGH-CONTRAST",
    lighting:   "hard directional key light from above or side, deep crisp shadow definition, strong light-to-dark ratio",
    colorGrade: "high-contrast editorial palette — clean bright whites, deep crushed blacks, desaturated neutral color tone, sharp tonal separation",
    exposure:   "precise deep shadow crush, bright controlled highlights with no blowout, strong tonal weight separation",
    mood:       "fashion magazine, commercial editorial, bold confident presence — high-impact visual authority",
    brief:      "editorial high-contrast — hard directional light, deep shadow crush, clean desaturated magazine tone, fashion-quality finish",
  },
  FILM_STILL: {
    name:       "FILM STILL (MOVIE LOOK)",
    lighting:   "dramatic 3-point cinematic lighting — powerful directional key light, controlled fill to shape shadow depth, strong rim backlight separating subject from background",
    colorGrade: "teal & orange cinematic grade — deep teal shadows, warm neutral-to-golden skin highlights, desaturated neutral midtones",
    exposure:   "filmic exposure — intentional shadow depth, luminous controlled highlights, rich cinematic midtones with HDR tonal range",
    mood:       "cinematic film still — $100M production quality, emotionally evocative, dramatically relit and graded",
    brief:      "film still — dramatic 3-point cinematic lighting, teal-orange grade, deep shadows with rim separation, movie-quality mood",
  },
  NATURAL_DSLR_PLUS: {
    name:       "NATURAL DSLR REALISM+",
    lighting:   "enhanced natural light quality — soft golden-hour directional warmth or clean diffused daylight with gentle shadow definition",
    colorGrade: "natural color lift — accurate warm skin tones, subtle film warmth, clean white balance correction, gentle clarity and micro-contrast boost",
    exposure:   "balanced natural exposure — lifted shadow detail, soft highlight rolloff, open airy midtones, lifestyle-quality tonal balance",
    mood:       "professional lifestyle DSLR — real, clean, naturally beautiful, Lightroom-quality enhancement with cinematic polish",
    brief:      "natural DSLR realism plus — enhanced natural light, clean warm color lift, open airy exposure, professional lifestyle editorial feel",
  },
  LOW_LIGHT_DRAMA: {
    name:       "LOW-LIGHT DRAMA",
    lighting:   "low-key dramatic lighting — powerful rim/edge light defining subject against dark background, deep shadow fill with minimal ambient fill",
    colorGrade: "moody cinematic palette — deep desaturated blue-black shadows, cool atmospheric midtones, subtle warm accent highlight on skin or key subject",
    exposure:   "dramatic dark exposure — intentional deep shadow crush, selective tight highlights, high dynamic range contrast with dark tonal weight",
    mood:       "dark cinematic tension — moody, atmospheric, intense — thriller, noir, or dramatic portrait aesthetic",
    brief:      "low-light drama — rim-lit subject against deep dark background, moody cool shadow palette, tense cinematic atmosphere",
  },
};

function selectDirectorStyle(prompt: string, mode: EditMode): DirectorStyle {
  const lower = prompt.toLowerCase();

  // Mode-level overrides — some modes have a natural best-fit style
  if (mode === "AGGRESSIVE_RECONSTRUCTION") return DIRECTOR_STYLES["FILM_STILL"]!;
  if (mode === "WALLPAPER_UPGRADE")          return DIRECTOR_STYLES["FILM_STILL"]!;

  // Dark / moody / shadow signals
  if (/dark|moody|shadow|night|noir|gritty|low.?light|thriller|intense/.test(lower)) {
    return DIRECTOR_STYLES["LOW_LIGHT_DRAMA"]!;
  }
  // Editorial / fashion / commercial signals
  if (/fashion|editorial|magazine|commercial|bold|high.?contrast|catalog/.test(lower)) {
    return DIRECTOR_STYLES["EDITORIAL_HIGH_CONTRAST"]!;
  }
  // Cinematic / film / movie signals
  if (/cinematic|film|movie|scene|hollywood|director|grade|blockbuster/.test(lower)) {
    return DIRECTOR_STYLES["FILM_STILL"]!;
  }
  // Natural / outdoor / lifestyle signals
  if (/natural|outdoor|sunlight|daylight|golden hour|lifestyle|real|candid/.test(lower)) {
    return DIRECTOR_STYLES["NATURAL_DSLR_PLUS"]!;
  }
  // Portrait / face / person signals → portrait cinematic as default for people
  if (/portrait|headshot|face|selfie|profile|person|human|model|subject/.test(lower)) {
    return DIRECTOR_STYLES["PORTRAIT_CINEMATIC"]!;
  }

  // Generic vague prompts default to FILM_STILL — most visually impactful
  return DIRECTOR_STYLES["FILM_STILL"]!;
}

export function buildCinematicDirectorBrief(
  prompt: string,
  mode: EditMode,
): string {
  // Pass-through for structural modes — director aesthetics are irrelevant
  if (DIRECTOR_SKIP_MODES.includes(mode)) return prompt;

  const lower = prompt.toLowerCase().trim();

  const isExplicit = EXPLICIT_VISUAL_SIGNALS.some((s) => lower.includes(s));
  const isVague    = VAGUE_SIGNALS.some((s) => lower.includes(s)) || lower.length < 20;

  const style = selectDirectorStyle(prompt, mode);

  if (isExplicit && !isVague) {
    // User already has clear visual direction — augment without overriding
    return (
      `${prompt}. ` +
      `Apply with ${style.lighting}. ` +
      `Color grade: ${style.colorGrade}. ` +
      `Exposure strategy: ${style.exposure}. ` +
      `Mood: ${style.mood}.`
    );
  }

  // Vague or short prompt — inject full director brief
  return (
    `CINEMATIC DIRECTOR BRIEF [${style.name}] — ` +
    `Original user intent: "${prompt}". ` +
    `Director transformation: ${style.brief}. ` +
    `LIGHTING: ${style.lighting}. ` +
    `COLOR GRADE: ${style.colorGrade}. ` +
    `EXPOSURE: ${style.exposure}. ` +
    `MOOD TARGET: ${style.mood}. ` +
    `Apply this as a full cinematic visual transformation — not a generic enhancement. ` +
    `Every axis must be intentionally pushed: lighting, color, contrast, exposure, and mood must ALL visibly change.`
  );
}

// ── VARIANCE ENFORCEMENT SUFFIX ──────────────────────────────────────────────
// Appended to all visual-transformation instructions (HIGH / EXTREME intensity).
// Forces the model to self-verify ≥3 of 5 transformation axes before outputting.
// Do NOT append to structural-only modes (SCREENSHOT_CLEANUP, TEXT_REMOVAL).
const VARIANCE_ENFORCEMENT_SUFFIX =
  ` VARIANCE ENFORCEMENT CHECK (PRO_EDIT_MODE): Before outputting, confirm your result` +
  ` satisfies AT LEAST 3 of these 5 transformation axes:` +
  ` (1) LIGHTING SHIFT — direction, source, or intensity is clearly different;` +
  ` (2) COLOR PALETTE SHIFT — temperature, hue, or cinematic grade is clearly different;` +
  ` (3) CONTRAST CURVE SHIFT — shadow depth, highlights, or tonal range is clearly different;` +
  ` (4) EXPOSURE REDISTRIBUTION — overall exposure balance is clearly different;` +
  ` (5) MOOD/ATMOSPHERE CHANGE — emotional or cinematic feel is clearly different.` +
  ` If fewer than 3 axes are satisfied → increase transformation strength and apply a stronger edit.` +
  ` Near-identical output = VARIANCE FAILURE. Minimum 3 axes required.`;

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
        `Subject identity, face, clothing, logos, and pose must remain completely unchanged.` +
        VARIANCE_ENFORCEMENT_SUFFIX
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
        `Subject identity, face, clothing, logos, and pose must remain completely unchanged.` +
        VARIANCE_ENFORCEMENT_SUFFIX
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
        `Preserve all subjects, faces, and logos.` +
        VARIANCE_ENFORCEMENT_SUFFIX
      );

    case "STYLE_TRANSFER":
      return (
        `Transform this image into the following style: ${p}. ` +
        `Fully commit to the style — make it unmistakably that aesthetic, not a subtle filter. ` +
        `Preserve the subject's identity, facial features, body proportions, and clothing. ` +
        `Apply only the style transformation — do not alter who the person is.` +
        VARIANCE_ENFORCEMENT_SUFFIX
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
        `Preserve the subject's identity, expression, and composition entirely.` +
        VARIANCE_ENFORCEMENT_SUFFIX
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
          `Perform these operations at FULL VISIBLE STRENGTH — in order of priority: ` +
          `(1) Exposure: aggressive shadow lift, strong highlight recovery, intentional midtone shaping. ` +
          `(2) Contrast: deep rich blacks, punchy highlights, cinematic S-curve tonal range — make it clearly visible. ` +
          `(3) White balance and color temperature: strong warm-to-cool or cool-to-warm shift as appropriate — visible change required. ` +
          `(4) Sharpening and clarity: strong local contrast enhancement, crisp texture detail, micro-contrast lift. ` +
          `(5) Color grading: STRONG visible tonal transformation — apply a cinematic film palette, moody grade, or professional Lightroom preset. The color mood must clearly change. ` +
          `(6) Noise reduction: clean grain while preserving natural film texture. ` +
          `Output must look like a professionally graded photograph — same structural composition and subject identity, ` +
          `but clearly different and better: stronger lighting, richer color, deeper contrast, more cinematic mood. ` +
          `REQUIRED: The output must look visibly different from the input — stronger, moodier, more professional. ` +
          `PRESERVE ONLY: face identity, pose, body position, background objects and layout, and composition framing.` +
          antiAiRule +
          VARIANCE_ENFORCEMENT_SUFFIX
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
