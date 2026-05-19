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

  // Default: treat unmatched prompts as CINEMATIC_EDIT — NOT SUBTLE_ENHANCEMENT.
  // Generic prompts ("make it look better", "enhance", "improve") should receive
  // full cinematic transformation treatment. SUBTLE_ENHANCEMENT is only reached
  // when explicitly matched by its own phrases/keywords above (sharp, fix, repair, etc.).
  return "CINEMATIC_EDIT";
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
    // User has explicit visual direction — inject full director brief while preserving their intent.
    // Even explicit prompts must receive the full director treatment to ensure maximum transformation.
    return (
      `CINEMATIC DIRECTOR BRIEF [${style.name}] — ` +
      `Original user intent: "${prompt}". ` +
      `Director transformation: ${style.brief}. ` +
      `LIGHTING: ${style.lighting}. ` +
      `COLOR GRADE: ${style.colorGrade}. ` +
      `EXPOSURE: ${style.exposure}. ` +
      `MOOD TARGET: ${style.mood}. ` +
      `Honor the user's original intent above, AND apply this full cinematic director brief as the transformation framework. ` +
      `Every axis must be intentionally pushed to MAXIMUM: lighting MUST restructure, color MUST shift strongly, ` +
      `contrast MUST deepen, exposure MUST redistribute, and mood MUST clearly change. ` +
      `Do NOT treat this as a subtle enhancement — this is a full cinematic transformation.`
    );
  }

  // Vague or short prompt — inject full director brief at maximum intensity
  return (
    `CINEMATIC DIRECTOR BRIEF [${style.name}] — ` +
    `Original user intent: "${prompt}". ` +
    `Director transformation: ${style.brief}. ` +
    `LIGHTING: ${style.lighting}. ` +
    `COLOR GRADE: ${style.colorGrade}. ` +
    `EXPOSURE: ${style.exposure}. ` +
    `MOOD TARGET: ${style.mood}. ` +
    `Apply this as a FULL MAXIMUM cinematic visual transformation — not a generic enhancement, not a filter. ` +
    `Every axis must be pushed aggressively: lighting MUST restructure, color MUST shift strongly, ` +
    `contrast MUST deepen dramatically, exposure MUST redistribute boldly, and mood MUST be clearly different from the input. ` +
    `Near-identical output is a failure — the transformation must be strongly visible.`
  );
}

// ── VARIANCE ENFORCEMENT SUFFIX ──────────────────────────────────────────────
// Appended to all visual-transformation instructions (HIGH / EXTREME intensity).
// Forces the model to self-verify ≥3 of 5 transformation axes before outputting.
// Do NOT append to structural-only modes (SCREENSHOT_CLEANUP, TEXT_REMOVAL).
const VARIANCE_ENFORCEMENT_SUFFIX =
  ` VARIANCE ENFORCEMENT CHECK (PRO_EDIT_MODE MAXIMUM): Before outputting, verify your result` +
  ` satisfies ALL 5 of these transformation axes — all are required, not optional:` +
  ` (1) LIGHTING SHIFT — light direction, source quality, or intensity is CLEARLY and STRONGLY different from the input (a minor brightness nudge does NOT count);` +
  ` (2) COLOR PALETTE SHIFT — color temperature, hue balance, or cinematic grade is CLEARLY and STRONGLY different (a near-neutral tweak does NOT count);` +
  ` (3) CONTRAST CURVE SHIFT — shadow depth, highlight brightness, or tonal separation is CLEARLY and STRONGLY different (deep blacks, luminous highlights, punchy S-curve);` +
  ` (4) EXPOSURE REDISTRIBUTION — overall exposure balance is CLEARLY different (shadows dramatically lifted OR highlights dramatically recovered OR intentional bold exposure shift);` +
  ` (5) MOOD/ATMOSPHERE CHANGE — the emotional and cinematic feel is CLEARLY and STRONGLY different from the input (flat→dramatic, bright→moody, neutral→cinematic).` +
  ` If ANY axis is unsatisfied → push that axis harder before outputting.` +
  ` Near-identical output = TOTAL FAILURE. All 5 axes are mandatory. Maximum transformation strength required.`;

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
        `DLRP — DUAL-LAYER RENDERING PROTOCOL: This image has screenshot artifacts, UI overlays, or digital interface remnants. ` +
        `RENDER LAYER DIRECTIVE: These artifacts MUST NOT EXIST in the output — they are not "removed," they were never part of the real scene. ` +
        `Re-synthesize the entire scene as if it was captured by a real camera with no digital interface present. ` +
        `STRUCTURE LAYER (preserve): main subject identity, pose, face geometry, background spatial layout, scene composition. ` +
        `RENDER LAYER (re-generate): all lighting, color, texture, and atmosphere — fully re-synthesized without artifacts. ` +
        `ALL of the following must not exist in the render: status bars, notification icons, navigation chrome, app overlays, ` +
        `text annotations, watermarks, stickers, emoji overlays, compression artifacts, and interface elements. ` +
        `Additional instruction: ${p}. ` +
        `Final output must look like a native professional camera photograph — zero digital artifact, zero interface remnant, zero screenshot signature.`
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
      const extremeLine =
        intensity === "EXTREME"
          ? `RENDER ENGINE — EXTREME RE-SYNTHESIS: re-generate this image as a frame from a $200M Hollywood production.`
          : intensity === "LOW" || intensity === "MEDIUM"
          ? `RENDER ENGINE — FULL RE-SYNTHESIS: re-generate this image with strong cinematic visual re-rendering.`
          : `RENDER ENGINE — CINEMATIC RE-SYNTHESIS: re-generate this image with Hollywood-grade visual re-rendering.`;
      return (
        `${extremeLine} Target instruction: ${p}. ` +
        `\n\nRENDER ENGINE ANTI-FILTER RULE: Do NOT apply a color filter, Lightroom preset, or adjustment layer. ` +
        `Do NOT perform pixel-preserving corrections. ` +
        `RE-SYNTHESIZE the entire visual output — re-generate lighting, color, exposure, and atmosphere from scratch. ` +
        `\n\nLIGHTING RE-DESIGN: Completely restructure the scene lighting. Re-design a dramatic 3-point setup: ` +
        `powerful directional key light from a new angle, controlled fill to shape shadow depth, ` +
        `strong rim/backlight that clearly separates subject from background. ` +
        `The light direction and quality in the output MUST be materially different from the input — not a brightness change. ` +
        `\n\nCOLOR RE-GENERATION: Re-synthesize the color palette from scratch using a strong cinematic film grade. ` +
        `Choose from: teal-orange Hollywood grade, bleach bypass, warm editorial Kodak palette, cold moody Nordic look, ` +
        `or rich film emulation. The overall color temperature and hue balance MUST be clearly different from the input. ` +
        `\n\nCONTRAST RE-RENDER: Fully re-render the tonal curve. Apply a deep cinematic S-curve: ` +
        `crushed rich blacks, luminous controlled highlights, bold midtone separation. ` +
        `The tonal range MUST be dramatically broader and more cinematic than the input. ` +
        `\n\nATMOSPHERE RE-CREATION: Re-synthesize the image's atmosphere — add subtle anamorphic lens bloom on highlights, ` +
        `light organic film grain, and cinematic depth. The emotional/cinematic feel MUST be clearly different. ` +
        `\n\nFINAL CHECK: The output must look like a Hollywood cinematographer physically relit and re-graded this scene — ` +
        `NOT a social media filter, NOT a pixel-adjusted copy, NOT a near-identical enhanced version. ` +
        `If it resembles the input with adjustments applied → it is a render failure. ` +
        `\n\nIDENTITY LOCK (absolute): Subject face, identity, bone structure, pose, clothing, and logos must remain unchanged.` +
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
          `Apply a STRONG full cinematic photo transformation to this exact image: ${p}. ` +
          `This is NOT a subtle enhancement — every axis must produce a CLEARLY VISIBLE and STRONG change: ` +
          `LIGHTING: Restructure the lighting — change its direction, intensity, and quality dramatically. ` +
          `Add a strong directional key light with deep shadow shaping. Lighting must be visibly different from the input. ` +
          `CONTRAST: Apply a deep cinematic S-curve — crushed blacks, punchy bright highlights, rich midtone separation. ` +
          `The tonal range must be significantly broader and bolder than the input. ` +
          `COLOR GRADE: Apply a STRONG visible tonal transformation — use a cinematic film palette (teal-orange, bleach bypass, ` +
          `warm editorial, moody cool, or Kodak film emulation). The color mood MUST clearly change from the input. ` +
          `EXPOSURE: Boldly redistribute exposure — aggressively lift shadow detail OR dramatically recover blown highlights ` +
          `OR apply intentional exposure shift. The overall tonal weight must be clearly different. ` +
          `SHARPENING: Apply strong local contrast enhancement, crisp texture detail, and micro-contrast lift. ` +
          `Output must look like a professionally Lightroom-graded and cinematically relit photograph — ` +
          `strongly different from the input in lighting, color, contrast, and mood. ` +
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
