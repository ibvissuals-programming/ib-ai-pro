/**
 * Image Generation + Editing Service — IB AI Image Studio
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, FLUX model)
 *
 * IMAGE-TO-IMAGE: Unified cinematic render pipeline.
 *
 *   Pipeline (free — no billing required):
 *     1. INPUT IMAGE (validate)
 *     2. RENDER PROMPT (editIntelligence + APRE + FRAE enrichment)
 *     3. GEMINI VISION ANALYSIS (gemini-2.5-flash, text output only — free)
 *     4. POLLINATIONS FLUX GENERATION (free)
 *     5. SIMPLE RETRY (once, if generation returns no output)
 *
 *   Identity is the only hard constraint.
 *   Everything else — lighting, color, mood, atmosphere — can change freely.
 */
import { logger } from "../lib/logger";
import { saveToHistory } from "./imageHistoryStore";
import { pushRenderTelemetry } from "../lib/renderTelemetry";
import {
  createJob,
  advanceJob,
  completeJob,
  failJob,
  jobSummary,
  type ImageJob,
} from "./imageJobManager";

// ── Constants ─────────────────────────────────────────────────────────────────

export const CONTRACT_VERSION = "v6" as const;

// Free pipeline: gemini-2.5-flash (vision → text, free tier) + Pollinations FLUX (free)
const FREE_EDIT_ANALYSIS_MODEL   = "gemini-2.5-flash";
const FREE_EDIT_ANALYSIS_TIMEOUT = 30_000;
const POLLINATIONS_BASE          = "https://image.pollinations.ai/prompt";
const MAX_IMAGE_BYTES            = 10 * 1024 * 1024;
const ACCEPTED_MIMES             = ["image/png", "image/jpeg", "image/webp"] as const;
const RESPONSE_PATTERN           = /^data:image\/(png|jpeg|jpg|webp);base64,/;
const PIPELINE_TIMEOUT_MS        = 150_000;  // single-pass: analysis (~30s) + Pollinations (~65s) + buffer
const STAGE_TIMEOUT_MS           = 95_000;   // per-pass hard cap for free pipeline
const ATTEMPT_TIMEOUT_MS         = 95_000;   // kept for non-pipeline callers
export const REQUEST_TIMEOUT_MS = 65_000;
export const MAX_POLLINATIONS_RETRIES = 1;

type AcceptedMime = (typeof ACCEPTED_MIMES)[number];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Edit result ───────────────────────────────────────────────────────────────

export interface StageDebugRecord {
  status:   "success" | "failed" | "skipped";
  time_ms:  number;
  effect:   "cleanup" | "enhancement" | "color_grading" | "style_transfer" | "creative_pass" | "none";
  reason?:  string;
}

export interface PipelineDebug {
  mode:            string;
  pipeline_status: "success" | "partial" | "failed";
  stages: {
    stage_1_cleanup:     StageDebugRecord;
    stage_2_enhancement: StageDebugRecord;
    stage_3_cinematic:   StageDebugRecord;
  };
  bottleneck:     string;
  recommendation: string;
}

export interface ExplanationResult {
  mode:               string;
  intensity:          string;
  stageSummary:       string[];
  temperatureSummary: string;
  decisionFlow:       string;
  notes?:             string[];
}

export interface EditResult {
  b64Image:            string;
  job:                 ReturnType<typeof jobSummary>;
  mode:                string;
  intensity:           string;
  qualityVerified:     boolean;
  qualityIssues:       string[];
  contractVersionUsed: string;
  pipelineDebug?:      PipelineDebug;
  explanation?:        ExplanationResult;
}

// ── Contract config (diagnostic endpoint) ────────────────────────────────────

export function getContractConfig(_debug?: boolean) {
  return {
    contractVersion:  CONTRACT_VERSION,
    model:            `${FREE_EDIT_ANALYSIS_MODEL} → pollinations-flux`,
    pipeline:         ["INPUT_IMAGE", "EDIT_MODE_RESOLVE", "RENDER_PROMPT", "GEMINI_VISION_ANALYSIS", "POLLINATIONS_GENERATION"],
    editModes: {
      portrait_safe:  { identityLock: "MAXIMUM", description: "Enhancement only — face, body, structure fully preserved" },
      cinematic:      { identityLock: "MEDIUM",  description: "Cinematic lighting, color grading, mood — identity preserved" },
      style_transfer: { identityLock: "FLEXIBLE", description: "Full artistic/aesthetic transformation — loose subject preservation" },
      creative:       { identityLock: "MINIMAL", description: "Full creative freedom — complete transformation allowed" },
    },
    autoDetect:       true,
    freeToChange:     ["lighting", "color_grading", "exposure", "mood", "atmosphere", "background_style"],
  };
}

// ── Prompt expansion (text-to-image) ─────────────────────────────────────────

const QUALITY_SUFFIX = ", ultra realistic, sharp focus, highly detailed, professional quality, 8k";

const STYLE_MAP: Record<string, string> = {
  portrait:     "studio portrait photography, professional lighting, shallow depth of field, bokeh, DSLR, sharp eyes",
  landscape:    "scenic landscape photography, golden hour, vivid colors, wide angle lens, epic scale, dramatic sky",
  product:      "professional product photography, clean white background, studio lighting, sharp details, commercial grade",
  anime:        "anime style illustration, clean line art, vibrant colors, studio quality, detailed background, cel shaded",
  manga:        "manga style illustration, black and white ink, dynamic line weight, expressive characters",
  cartoon:      "cartoon illustration style, bold outlines, flat colors, exaggerated proportions, clean and playful",
  sketch:       "pencil sketch illustration, fine line art, cross-hatching, artistic detail, hand-drawn quality",
  watercolor:   "watercolor illustration, soft washes, painterly texture, artistic brushwork, delicate color bleeding",
  "oil painting": "classical oil painting style, rich textures, impasto technique, museum quality",
  illustration: "professional illustration, detailed artwork, polished digital art, vibrant palette, editorial quality",
  "pixel art":  "pixel art style, 16-bit aesthetic, clean pixels, retro game art, detailed sprite work",
  "3d render":  "3D CGI render, photorealistic materials, global illumination, ray tracing, studio quality",
  "studio ghibli": "Studio Ghibli animation style, painterly backgrounds, soft color palette, whimsical atmosphere",
  impressionist: "impressionist painting style, loose brushwork, light and color play, Monet-inspired, painterly texture",
  "film noir":  "film noir black and white, dramatic shadows, high contrast, moody atmosphere, 1940s cinematic style",
  cinematic:    "cinematic portrait, dramatic 3-point lighting, shallow depth of field, teal-orange color grading, ultra realistic, film grain",
  luxury:       "luxury editorial photography, high-end fashion lighting, soft shadows, premium aesthetic, studio grade, elegant composition",
  "afro luxury": "afro luxury portrait, warm golden tones, cultural elegance, premium styling, rich textures, regal composition, editorial quality",
  cyberpunk:    "cyberpunk aesthetic, neon lights, futuristic cityscape glow, electric blues and magentas, rain-slicked reflections",
  gta:          "GTA V loading screen art style, hyper-detailed illustration, dramatic pose, sharp lines, bold colors",
  pixar:        "Pixar animation style, 3D CGI, expressive character, warm lighting, vibrant colors, movie quality render",
  disney:       "Disney animation style, classic character design, expressive features, magical atmosphere, rich color palette",
  vintage:      "vintage film photography, warm grain, faded highlights, desaturated shadows, nostalgic 35mm aesthetic",
  moody:        "moody low-light photography, dramatic contrast, deep shadows, rich midtones, cinematic tension",
  dramatic:     "dramatic lighting photography, strong directional light, deep shadows, powerful contrast, theatrical atmosphere",
  neon:         "neon-lit photography, vivid electric colors, night scene, reflective surfaces, urban nightlife glow",
  tiktok:       "viral TikTok visual style, sharp contrast, bright attention-focused colors, bold composition, high energy",
  instagram:    "Instagram editorial style, perfect lighting, aesthetically curated, aspirational composition, premium lifestyle",
};

export function enhancePrompt(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const matchedKey = Object.keys(STYLE_MAP)
    .filter((k) => lower.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  const styleExpansion = matchedKey ? `${STYLE_MAP[matchedKey]}, ` : "";
  const alreadyHasQuality =
    lower.includes("quality") || lower.includes("detailed") ||
    lower.includes("professional") || lower.includes(" hd") ||
    lower.includes("8k") || lower.includes("4k") || lower.includes("ultra");
  const suffix = alreadyHasQuality ? "" : QUALITY_SUFFIX;
  return `${styleExpansion}${raw.trim()}${suffix}`;
}

// ── Edit mode system ──────────────────────────────────────────────────────────
//
// Four modes control how strongly identity is preserved during img2img edits.
// Each mode has its own contract (system prompt) sent to the model.
//
//   portrait_safe   — max identity lock, enhancement only
//   cinematic       — medium lock, lighting/mood/color free (legacy default)
//   style_transfer  — loose lock, full aesthetic transformation
//   creative        — minimal lock, full artistic freedom

export type EditMode = "portrait_safe" | "cinematic" | "style_transfer" | "creative" | "polish" | "social" | "luxury" | "restore";

// Mode → display label (returned in EditResult.mode for frontend badges)
const MODE_LABELS: Record<EditMode, string> = {
  portrait_safe:  "Portrait Safe",
  cinematic:      "Cinematic",
  style_transfer: "Style Transfer",
  creative:       "Creative",
  polish:         "Polish",
  social:         "Social",
  luxury:         "Luxury",
  restore:        "Restore",
};

// ── Mode contracts ─────────────────────────────────────────────────────────────

const CONTRACT_PORTRAIT_SAFE = `You are a professional photo retouching specialist.

TASK: Apply subtle, natural-looking enhancements to this photograph.
OUTPUT STANDARD: "Natural, polished photograph — enhanced but not transformed."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY LOCK — MAXIMUM STRENGTH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Preserve EXACTLY (no exceptions):
• Face identity — same person, same features
• Facial geometry — eyes, nose, lips, jaw, cheekbones, forehead proportions
• Age appearance and ethnicity
• Hairstyle shape and color
• Body structure, pose, and proportions
• Natural skin texture and character

ALLOWED CHANGES — enhancement only:
• Subtle lighting correction (softer shadows, gentle fill light)
• Skin smoothing and blemish removal (preserve natural texture)
• Object or unwanted element removal
• Tone and color balance (keep natural — no dramatic grading)
• Sharpness and clarity refinements

NOT ALLOWED:
• Cinematic or dramatic color grading
• Strong lighting transformation
• Style or artistic transformation
• Background replacement (unless explicitly requested)
• Any structural change to face or body

OUTPUT RULES:
• Result must look like a professionally enhanced version of the same photo
• Viewer should think "same photo, looks better" — not "different image"
• If the edit instruction exceeds enhancement scope, apply the closest safe version

EDIT INSTRUCTION:
`;

const CONTRACT_CINEMATIC = `You are a cinematic photograph renderer and color grading specialist.

TASK: Re-render this image with cinematic transformation as described below.
OUTPUT STANDARD: "Cinematic wallpaper-grade photography."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUALITY BASELINE — every output must have
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Cinematic lighting — directional, with clear shadow separation (not flat)
• Film-grade color grading — controlled palette, tonal depth, not washed out
• Controlled dynamic range — shadow detail preserved, highlights not blown
• Depth and dimension — realistic, never flat/2D
• Professional photography composition and framing

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY LOCK — MEDIUM STRENGTH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Preserve:
• Same person / face identity (recognizable as the same individual)
• Facial geometry (general structure — eyes, nose, lips, jaw)
• Age and ethnicity

Free to transform:
• Lighting — direction, quality, intensity, color temperature (go bold)
• Color grading — palette, hue balance, saturation, film stock simulation
• Exposure — shadows, highlights, contrast, tone curve
• Mood and atmosphere — dramatic, warm, cold, cinematic, moody
• Background and environment — style, content, depth
• Lens behavior — depth of field, grain, lens character, flares
• Objects and scene elements

OUTPUT RULES:
• This must be a real cinematic re-render — NOT a filter or overlay
• Do NOT preserve flat lighting — transform it meaningfully
• The viewer must immediately see a different visual world (new light, new color, new mood)
• When a person is present: they must remain recognizable as the same individual

EDIT INSTRUCTION:
`;

const CONTRACT_STYLE_TRANSFER = `You are a professional visual artist and photo stylization specialist.

TASK: Apply a powerful stylistic or artistic transformation to this image.
OUTPUT STANDARD: "Editorial-grade stylized art — bold aesthetic transformation."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY LOCK — FLEXIBLE (loose preservation)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Preserve loosely:
• Subject silhouette and approximate positioning
• General facial structure if a person is present (not exact geometry)

Free to transform fully:
• Artistic style — illustration, painting, editorial, fashion, anime, cinematic
• Color palette — strong aesthetic changes, bold color grading, full palette shifts
• Texture and surface rendering — painterly, illustrated, photographic
• Lighting — dramatic, stylized, non-photorealistic
• Background — complete transformation
• Clothing and accessories — fashion-forward stylization
• Mood and overall aesthetic — total reimagination within the requested style

OUTPUT RULES:
• The stylistic transformation must be powerful and immediately apparent
• Do NOT produce a subtle result — commit fully to the requested style
• Subject should remain thematically present but need not be strictly photorealistic
• Editorial quality: treat this as a professional art direction commission

EDIT INSTRUCTION:
`;

const CONTRACT_CREATIVE = `You are a creative AI artist with full freedom to transform this image.

TASK: Apply a complete creative transformation as described below.
OUTPUT STANDARD: "AI creative art — bold, imaginative, fully transformed output."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY LOCK — MINIMAL (optional)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Identity preservation is OPTIONAL — prioritize the creative instruction above all
• If the instruction explicitly asks to keep a person recognizable, honor it loosely
• Otherwise, full artistic transformation of the subject is permitted

Free to transform:
• Everything — environment, lighting, color, style, identity, background, mood
• Artistic medium — concept art, surreal, fantasy, sci-fi, abstract, illustration
• Subject interpretation — translate the subject into the requested style freely
• Scale, composition, and framing — dramatic reframing is acceptable

OUTPUT RULES:
• Prioritize the user's creative instruction above all constraints
• Do NOT play it safe — commit fully to the creative direction
• Produce a high-quality, visually striking, well-composed result
• Professional art quality: sharp, detailed, imaginative

EDIT INSTRUCTION:
`;

// ── Contract selector ─────────────────────────────────────────────────────────

function contractForMode(mode: EditMode): string {
  switch (mode) {
    case "portrait_safe":  return CONTRACT_PORTRAIT_SAFE;
    case "cinematic":      return CONTRACT_CINEMATIC;
    case "style_transfer": return CONTRACT_STYLE_TRANSFER;
    case "creative":       return CONTRACT_CREATIVE;
    case "polish":         return CONTRACT_PORTRAIT_SAFE;
    case "social":         return CONTRACT_CINEMATIC;
    case "luxury":         return CONTRACT_CINEMATIC;
    case "restore":        return CONTRACT_PORTRAIT_SAFE;
  }
}

// ── Mode downgrade chain (used by failsafe retry) ─────────────────────────────
// creative → style_transfer → social → cinematic → luxury → polish → restore → portrait_safe

function downgradedMode(mode: EditMode): EditMode {
  const chain: Record<EditMode, EditMode> = {
    creative:      "style_transfer",
    style_transfer: "social",
    social:        "cinematic",
    cinematic:     "luxury",
    luxury:        "polish",
    polish:        "restore",
    restore:       "portrait_safe",
    portrait_safe: "portrait_safe",
  };
  return chain[mode];
}

// ── Intent detector — auto-assigns edit mode from prompt keywords ──────────────

const PORTRAIT_SAFE_PATTERNS = [
  // Core enhancement vocabulary — morphologically aware.
  // Handles suffixed forms: "naturally" (natural+ly), "enhancing" (enhance+ing),
  // "softly" (soft+ly), "refined" (refine+d), "smoothing" (smooth+ing), etc.
  /\b(enhanc(?:e|es|ed|ing|ement)|retouch(?:ed|ing)?|clean(?:\s*up|ed|ing)|touch(?:\s*up|ed)?|smooth(?:ed|ing|ly)?|subtle|refin(?:e|es|ed|ing)|polish(?:ed|ing)?|natur(?:al(?:ly)?)|freshen(?:ed|ing)?|soft(?:en(?:ed|ing)?|ly)?|gentle(?:ly)?)\b/i,
  // Removal operations — blemish, noise, artefacts
  /\b(remove\s+(?:the\s+)?(watermark|text|logo|blemish|spot|acne|wrinkle|noise|grain))\b/i,
  // Fix + target — allows intervening pronoun/article: "fix her face", "fix the skin"
  /\bfix\s+(?:\w+\s+)?(skin|face|eyes|blemish|lighting)\b/i,
  // Make + result — direct and indirect: "make it cleaner", "make her face look better"
  /\bmake\s+(?:\w+\s+){0,2}(?:look\s+)?(better|brighter|cleaner|sharper|clearer|more\s+natur(?:al(?:ly)?)?)\b/i,
  // Skin-specific micro-operations
  /\bskin\s*(smooth(?:ed|ing)?|soften(?:ed|ing)?|clear(?:ed|ing)?)\b/i,
  // "look better", "looking better", "look more natural"
  /\blook(?:ing)?\s+(?:better|more\s+natur(?:al(?:ly)?)?)\b/i,
  // "improve her appearance", "improve the skin", "improve face quality"
  /\bimprov(?:e|es|ed|ing)\s+(?:\w+\s+){0,2}(?:look|appearance|skin|face|complexion|quality)\b/i,
];

const CINEMATIC_PATTERNS = [
  // Core cinematic vocabulary. Fixes word-boundary gap: "mood lighting" /
  // "studio lighting" / "dramatic lighting" now match (was: \blight\b failed
  // on "lighting"). Adds bidirectional teal/orange and atmospheric variants.
  /\b(cinematic|film\s*look|color\s*grad|mood\s*light(?:ing)?|dramatic\s*light(?:ing)?|studio\s*light(?:ing)?|atmospher(?:ic(?:ally)?)?|teal.?orange|orange.?teal)\b/i,
  // Weather / time-of-day moods + extended atmospheric vocabulary.
  // Adds: "neon lighting", "atmospheric", "mood lighting" phrase form.
  /\b(noir|golden\s*hour|blue\s*hour|sunset|sunrise|overcast|neon\s*light(?:ing)?|moody|foggy|hazy|atmospheric|mood\s+light(?:ing)?)\b/i,
  // Intent phrases — extends to handle intervening words and adverb forms.
  // "make it more dramatic", "make the scene dramatically different"
  /\bmake\s+(?:\w+\s+){0,2}(?:more\s+)?(?:cinematic|dramatic(?:ally)?|moody|atmospheric|professional)\b/i,
  // Technical / optical vocabulary
  /\b(film\s*grain|depth\s*of\s*field|bokeh|lens\s*flare|color\s*grade)\b/i,
  // Morphological dramatic variants — "dramatically lit", "dramatize", "dramatized"
  // Not in pattern 3 (which requires "make ..."). Standalone adverb coverage.
  /\bdramat(?:ic(?:ally)?|ize[ds]?)\b/i,
  // Compound lighting phrases — requires the word "light/lighting" as qualifier
  // to avoid firing on "studio shoot" (bare "studio" alone is NOT matched here).
  /\b(low[\s-]key\s+light(?:ing)?|high[\s-]contrast\s+light(?:ing)?|film\s+light(?:ing)?|hard\s+light(?:ing)?|directional\s+light(?:ing)?)\b/i,
];

const STYLE_TRANSFER_PATTERNS = [
  // Artistic medium vocabulary (unchanged)
  /\b(watercolor|oil\s*paint|sketch|pencil|drawing|illustration|anime|manga|cartoon|comic|ghibli)\b/i,
  // Fashion / editorial vocabulary (unchanged)
  /\b(fashion|editorial|vogue|runway|magazine|high\s*fashion|luxury\s*fashion)\b/i,
  // Aesthetic style vocabulary (unchanged)
  /\b(vintage\s*style|retro\s*style|cyberpunk|steampunk|gothic|cottagecore)\b/i,
  // "look like a painting" extended with "as a painting / as concept art /
  // rendered as anime" — covers "as X" transformation phrasing.
  /\b(?:look\s*like|render(?:ed)?\s+as|as)\s+(?:a\s+|an\s+)?(painting|illustration|drawing|sketch|anime|cartoon|concept\s+art|oil\s+painting|mural)\b/i,
  // Stylization vocabulary — morphological: stylize / stylized / stylizing
  /\b(art\s*style|artistic\s*style|styliz(?:e|ed|ing))\b/i,
  // Fashion-forward aesthetic phrases — more specific than bare "fashion" /
  // "editorial" (which pattern 2 already covers).
  /\b(fashion[\s-]forward|editorial\s+(?:look|style|feel|aesthetic)|vogue\s+(?:style|aesthetic|look)|runway\s+(?:look|feel|aesthetic))\b/i,
  // Style reinterpretation verbs — no overlap with portrait_safe vocabulary.
  /\b(restyle(?:d|ing)?|reinterpret(?:ed|ing)?)\b/i,
];

// ── Creative pattern sets ─────────────────────────────────────────────────────
//
// Two-layer system:
//   STRONG (+2 per match) — a single hit self-qualifies as creative.
//   SOFT   (+1 per match) — two hits needed to self-qualify.
//
// Fast-path: if creative score >= 2, return "creative" immediately.
// Override:  if portrait_safe score >= 3, identity preservation always wins.

const CREATIVE_STRONG_PATTERNS: RegExp[] = [
  // Transformation verbs — standalone (no "completely" prefix required)
  /\btransform(?:s|ed|ing|ation)?\b/i,
  /\breimagin(?:e|es|ed|ing)\b/i,
  /\bredesign(?:s|ed|ing)?\b/i,
  /\bconvert\s+(?:\w+\s+){0,3}into\b/i,
  /\bturn(?:ed|ing)?\s+(?:\w+\s+){0,2}into\b/i,
  // Subject placement — any subject (broadened from pronoun-only)
  /\bplace\s+(?:\w+\s+){0,3}in\b/i,
  /\bput\s+(?:\w+\s+){0,3}in\b/i,
  /\b(transport\s*to|move\s*to)\b/i,
  // World / genre vocabulary
  /\b(surreal(?:ist(?:ic)?|ly)?|fantasy|alien|sci[\s-]fi|futuristic|magical|enchanted|mythical|mytholog(?:ical(?:ly)?|y)|post[\s-]?apocalyptic)\b/i,
  // Abstract and dream vocabulary
  /\babstract\b/i,
  /\bdream(?:like|world|scape|y)?\b/i,
  // Background replacement
  /\b(change\s+(?:the\s+)?background\s+to|replace\s+(?:the\s+)?background|new\s+background)\b/i,
  // Digital art / concept art / AI art
  /\b(concept\s*art|digital\s*art|abstract\s*art|abstract\s*background|ai\s+art)\b/i,
  // Strong restructuring phrases kept from prior version
  /\b(change\s*everything|total\s*transformation)\b/i,
];

const CREATIVE_SOFT_PATTERNS: RegExp[] = [
  // Cinematic only when paired with transformation language
  /\bcinematic\s+(?:transform(?:ation)?|rework|version|concept|interpretation)\b/i,
  // Conceptual / narrative framing
  /\bconceptual(?:ly)?\b/i,
  /\bvisual\s+narrative\b/i,
  // Style reinterpretation verbs (also scored in STYLE_TRANSFER P7 — overlap intentional:
  // two soft signals together self-qualify as creative; one alone stays style_transfer)
  /\breinterpret(?:ed|ing)?\b/i,
  /\brestyle(?:d|ing)?\b/i,
  // Explicit creative/artistic version phrasing
  /\b(?:artistic|creative)\s+version\b/i,
];

export function detectEditMode(prompt: string): EditMode {
  const scores: Record<EditMode, number> = {
    portrait_safe:  0,
    cinematic:      0,
    style_transfer: 0,
    creative:       0,
    polish:         0,
    social:         0,
    luxury:         0,
    restore:        0,
  };

  for (const p of PORTRAIT_SAFE_PATTERNS)   if (p.test(prompt)) scores.portrait_safe++;
  for (const p of CINEMATIC_PATTERNS)        if (p.test(prompt)) scores.cinematic++;
  for (const p of STYLE_TRANSFER_PATTERNS)   if (p.test(prompt)) scores.style_transfer++;
  for (const p of CREATIVE_STRONG_PATTERNS)  if (p.test(prompt)) scores.creative += 2;
  for (const p of CREATIVE_SOFT_PATTERNS)    if (p.test(prompt)) scores.creative++;

  // CREATIVE fast-path: a single STRONG hit (+2) or two SOFT hits (+1+1) self-
  // qualify. Bypasses the standard scoring competition entirely.
  // Exception: portrait_safe >= 3 means identity preservation always wins.
  if (scores.creative >= 2) {
    return scores.portrait_safe >= 3 ? "portrait_safe" : "creative";
  }

  // Standard priority resolution when creative has not self-qualified.
  // Default to "polish" on zero score — matches production spec UNCERTAIN_FALLBACK.
  // polish and portrait_safe share the same contract; "polish" is the spec-canonical label.
  // Priority on tie: portrait_safe > style_transfer > cinematic > creative
  const max = Math.max(scores.portrait_safe, scores.cinematic, scores.style_transfer, scores.creative);
  if (max === 0)                             return "polish";
  if (scores.portrait_safe  === max)         return "portrait_safe";
  if (scores.style_transfer === max)         return "style_transfer";
  if (scores.cinematic      === max)         return "cinematic";
  return "creative";
}

// ── Render prompt normalizer ───────────────────────────────────────────────────
//
// Converts any user prompt into a clean cinematic render instruction.
// Maps shorthand ("noir", "sunset", etc.) to explicit visual direction.

const PROMPT_NORMALIZATIONS: Array<{ pattern: RegExp; expansion: string }> = [
  // Lighting moods
  { pattern: /\bnoir\b/i,                      expansion: "noir cinematic lighting — deep shadows, high contrast, desaturated tones, dramatic 1940s atmosphere" },
  { pattern: /\bsunset\b/i,                    expansion: "golden hour cinematic lighting — warm orange and amber tones, long shadows, soft directional light, atmospheric haze" },
  { pattern: /\bgolden hour\b/i,               expansion: "golden hour cinematic lighting — warm glowing tones, soft directional light, long shadows" },
  { pattern: /\bbluehour\b|\bblue hour\b/i,    expansion: "blue hour twilight lighting — cool blues and purples, soft diffused light, cinematic dusk atmosphere" },
  { pattern: /\bmoody\b/i,                     expansion: "moody cinematic atmosphere — rich shadows, muted tones, emotional depth, dramatic tension" },
  { pattern: /\bdramatic\b/i,                  expansion: "dramatic cinematic lighting — strong directional light, deep shadow contrast, theatrical atmosphere" },
  { pattern: /\bstudio\b/i,                    expansion: "professional studio lighting — clean three-point lighting setup, controlled shadows, editorial photography quality" },
  { pattern: /\bovercast\b|\bcloudy\b/i,        expansion: "overcast natural lighting — soft diffused daylight, even shadows, muted cinematic tones" },
  { pattern: /\bneon\b/i,                      expansion: "neon-lit scene — vivid electric colors, urban night atmosphere, reflective surfaces, cinematic glow" },
  // Color styles
  { pattern: /\bcyberpunk\b/i,                 expansion: "cyberpunk aesthetic — neon-lit scene, electric blues and magentas, futuristic glow, urban night atmosphere" },
  { pattern: /\bvintage\b|\bretro\b/i,         expansion: "vintage film look — warm grain, faded highlights, nostalgic 35mm color rendering" },
  { pattern: /\bwarm\b/i,                      expansion: "warm cinematic tones — golden light, amber shadows, cozy inviting atmosphere" },
  { pattern: /\bcool\b|\bcold\b/i,             expansion: "cool cinematic tones — desaturated blues, cold crisp shadows, clean clinical atmosphere" },
  { pattern: /\bcinematic\b/i,                 expansion: "cinematic transformation — professional 3-point lighting, teal-orange color grade, deep shadow contrast, film grain" },
  { pattern: /\bblack.?and.?white\b|\bmonochrome\b|\bbw\b/i, expansion: "cinematic black and white — rich tonal contrast, deep blacks, luminous highlights, classic silver gelatin film look" },
  { pattern: /\bfuturist\w*/i,                 expansion: "futuristic cinematic aesthetic — cool blue-silver tones, metallic sheen, high-tech environment lighting" },
  // Artistic styles
  { pattern: /\bwatercolor\b/i,                expansion: "watercolor artistic rendering — soft painted washes, painterly texture, preserved subject identity and facial structure" },
  { pattern: /\bsketch\b|\bdrawing\b/i,        expansion: "pencil sketch artistic rendering — fine line art, hand-drawn quality, preserved subject identity" },
  { pattern: /\boil paint\w*/i,                expansion: "oil painting style — rich impasto texture, painterly brushwork, cinematic compositional lighting" },
  // Partial / targeted edits
  { pattern: /\bbackground\b/i,                expansion: "background transformation — transform the background environment fully with cinematic depth, preserve subject exactly" },
  { pattern: /\bhair\b/i,                      expansion: "hair style transformation — transform hair appearance with cinematic lighting, preserve face and identity exactly" },
  { pattern: /\beyes\b/i,                      expansion: "eye enhancement — transform eye appearance and expression lighting, preserve full facial identity exactly" },
  { pattern: /\bclothing\b|\boutfit\b|\bwear\b/i, expansion: "clothing transformation — transform outfit with cinematic styling, preserve body and identity exactly" },
];

export function normalizeCinematicPrompt(userPrompt: string): string {
  let normalized = userPrompt.trim();

  for (const { pattern, expansion } of PROMPT_NORMALIZATIONS) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, expansion);
      break;
    }
  }

  return `A cinematic re-render of the same person/scene with: ${normalized}`;
}

// ── Response validation ───────────────────────────────────────────────────────

function validateImageResponse(result: string): void {
  if (!RESPONSE_PATTERN.test(result)) {
    throw new Error("Image response validation failed — unexpected format returned");
  }
}

// ── Image input parser + validator ────────────────────────────────────────────

interface ParsedImage {
  mimeType: AcceptedMime;
  base64:   string;
}

function parseAndValidateImage(imageDataUrl: string): ParsedImage {
  const commaIdx = imageDataUrl.indexOf(",");
  if (commaIdx === -1) throw new Error("No image supplied for editing");

  const header    = imageDataUrl.slice(0, commaIdx);
  const base64    = imageDataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+);/);
  const mimeType  = mimeMatch?.[1] as string | undefined;

  if (!mimeType || !(ACCEPTED_MIMES as readonly string[]).includes(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType ?? "unknown"}. Accepted: PNG, JPEG, WebP.`);
  }

  const decodedBytes = Math.floor(base64.length * 0.75);
  if (decodedBytes > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Image too large — maximum size is 10 MB"), { statusCode: 413 });
  }

  return { mimeType: mimeType as AcceptedMime, base64 };
}

// ── Pollinations (text-to-image only) ────────────────────────────────────────
//
// Cooldown: Pollinations blocks rapid consecutive calls from the same server IP
// (returns 429 or 503 on the second call within ~3 s). The module-level tracker
// enforces a minimum inter-request gap BEFORE each fetch attempt so queued jobs
// never hit the provider faster than it allows.

const POLLINATIONS_COOLDOWN_MS = 5_000;   // measured from last COMPLETED request
let lastPollinationsCallMs    = 0;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 402 || status === 503;
}

function isQuotaOrRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("quota") ||
    lower.includes("resource_exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  );
}

async function pollinationsFetch(url: string): Promise<Response> {
  // Enforce minimum inter-request cooldown measured from the last COMPLETED
  // request. Pollinations rate-limits the server IP on rapid consecutive calls;
  // waiting 5 s since the last successful completion prevents it.
  const now = Date.now();
  const sinceLastCall = now - lastPollinationsCallMs;
  if (lastPollinationsCallMs > 0 && sinceLastCall < POLLINATIONS_COOLDOWN_MS) {
    const waitMs = POLLINATIONS_COOLDOWN_MS - sinceLastCall;
    logger.debug({ waitMs, provider: "pollinations" }, "[imageGen] cooldown wait before fetch");
    await delay(waitMs);
  }

  let lastErr: Error = new Error("Unknown error");
  let lastStatus     = 0;

  for (let attempt = 0; attempt <= MAX_POLLINATIONS_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(1500 * 2 ** (attempt - 1));
      logger.warn({ attempt, provider: "pollinations" }, "[ai] retry attempt");
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "image/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error("Image generation timed out — the provider did not respond in time. Please try again.");
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    if (isRetryableStatus(response.status)) {
      lastStatus = response.status;
      lastErr    = new Error(`HTTP ${response.status}`);
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    // Record completion time AFTER a successful response so the cooldown is
    // measured from the moment Pollinations last served a result.
    lastPollinationsCallMs = Date.now();
    return response;
  }

  logger.warn({ provider: "pollinations", lastStatus }, "[ai] provider unavailable");
  // Pollinations returns 429 or 503 on rapid consecutive calls from the same IP.
  // Classify both as rate_limit so normalizeAIError maps to "Too many requests"
  // rather than "provider_unavailable", giving users the correct retry guidance.
  if (lastStatus === 429 || lastStatus === 503) {
    throw new Error("Image generation rate limit — please wait a moment and try again.");
  }
  throw new Error("Image generation is temporarily unavailable. Please retry.");
}

// ── TEXT-TO-IMAGE ─────────────────────────────────────────────────────────────

export async function generateImage(prompt: string, userId?: string): Promise<string> {
  const enhanced = enhancePrompt(prompt);
  const seed     = Math.floor(Math.random() * 2_000_000_000);
  const url      = `${POLLINATIONS_BASE}/${encodeURIComponent(enhanced)}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}&enhance=false`;

  logger.info({ provider: "pollinations", seed, prompt: enhanced.slice(0, 100) }, "[imageGen] generating");

  const response = await pollinationsFetch(url);
  if (!response.ok) {
    throw new Error("Image generation is temporarily unavailable. Please retry.");
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 500) {
    throw new Error("Image generation returned an empty response — please try again.");
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const ct     = response.headers.get("content-type") ?? "image/jpeg";
  const mime   = ct.split(";")[0].trim();
  const result = `data:${mime};base64,${base64}`;
  validateImageResponse(result);

  logger.info({ bytes: buffer.byteLength, mime }, "[imageGen] generation complete");

  if (userId) {
    saveToHistory({ userId, type: "generate", prompt, mode: "IMAGE_GENERATION", intensity: "HIGH", b64Image: result })
      .catch((err) => logger.warn({ err }, "[imageHistory] Failed to save generate result"));
  }

  return result;
}

// ── FREE IMG2IMG — Gemini vision analysis (text, free) + Pollinations FLUX ────
//
// Replaces the billing-dependent Gemini img2img model (gemini-2.5-flash-image).
// Two-step free pipeline:
//   1. gemini-2.5-flash (image → text description, free tier)
//   2. Pollinations FLUX (text → image, free)
//
// All prompt enrichment layers (editIntelligence, APRE, FRAE) produce the
// instruction; Gemini vision uses it to describe how the source image should
// look after the edit; Pollinations generates the result from that description.

const MODE_STYLE_DIRECTIVES: Record<EditMode, string> = {
  portrait_safe:  "Preserve the subject's exact appearance — natural soft enhancement only: soft fill light, gentle skin smoothing, balanced exposure. Do not alter face, identity, body, or pose.",
  cinematic:      "Apply a Hollywood cinematic grade: dramatic teal-orange color palette, deep rich shadows, open luminous highlights, film-stock texture, directional key lighting. Preserve subject identity.",
  style_transfer: "Apply a full artistic style transformation. Completely change the visual aesthetic per the instruction. Subject shape preserved but style fully transformed.",
  creative:       "Bold creative transformation. Full artistic freedom. Strong stylistic changes per the instruction. Expressive and distinctive result.",
  polish:         "Natural polish: even skin tone, natural skin smoothing with pores preserved, soft balanced lighting, subtle blemish reduction, elegant and understated. Preserve all identity.",
  social:         "Social media optimized: vibrant punchy color grade, lifted midtones, clean bright highlights, high clarity, Instagram and TikTok quality. Natural skin tones preserved.",
  luxury:         "Luxury editorial fashion: creamy warm highlights, deep refined shadows, ultra-clean skin rendering, premium aspirational lighting, high-fashion campaign quality. Preserve identity.",
  restore:        "Photo restoration: remove noise and compression artifacts, recover sharpness, correct exposure, fix color cast. Keep the scene authentic and natural.",
};

const MODE_INTENSITY_ADDENDUM: Record<IntensityLevel, string> = {
  LOW:     " Apply the transformation very subtly — minimal visible changes, preserve source fidelity.",
  MEDIUM:  "",
  HIGH:    " Apply the transformation strongly — clear, visible cinematic impact.",
  EXTREME: " Apply the transformation aggressively — maximum stylistic impact, push the aesthetic fully.",
};

async function runFreeImg2Img(
  parsed:      ParsedImage,
  mode:        EditMode,
  intensity:   IntensityLevel,
  instruction: string,
  timeoutMs:   number,
): Promise<string | null> {
  if (!parsed.base64 || parsed.base64.length < 1000) {
    throw new Error("Invalid image input — image data too short.");
  }

  const { ai } = await import("@workspace/integrations-gemini-ai");

  const modeDirective   = MODE_STYLE_DIRECTIVES[mode];
  const intensityAddend = MODE_INTENSITY_ADDENDUM[intensity];

  const ANALYSIS_PROMPT = `You are a professional image analyst and AI art director.

Analyze this image and write a detailed text-to-image generation prompt that recreates this exact scene with the following transformation applied.

EDIT INSTRUCTION: ${instruction}

STYLE DIRECTIVE: ${modeDirective}${intensityAddend}

Your output must be a single detailed text-to-image generation prompt (comma-separated descriptors, 120-200 words) that:
1. Precisely describes the primary subject — if a person: exact apparent age, ethnicity, hair color and style, eye color, skin tone, clothing, pose, and expression. If a scene: objects, environment, setting.
2. Describes the original composition, framing, and camera angle.
3. Applies the edit instruction and style directive faithfully.
4. Maintains photorealistic quality unless the instruction calls for a different style.
5. Ends with: "ultra high quality, sharp focus, highly detailed, professional photography, 8k"

Output ONLY the generation prompt text. No explanations, no preamble, no markdown.`.trim();

  logger.info(
    { model: FREE_EDIT_ANALYSIS_MODEL, mode, intensity, instructionLen: instruction.length },
    "[imageEdit] free pipeline: analyzing image with Gemini vision",
  );

  let analysisTimeoutId: ReturnType<typeof setTimeout> | undefined;

  // Step 1: Gemini vision → text description (TEXT output only = FREE)
  let generationPrompt: string;
  try {
    const analysisResult = await Promise.race([
      ai.models.generateContent({
        model:    FREE_EDIT_ANALYSIS_MODEL,
        contents: [{
          role:  "user",
          parts: [
            { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } },
            { text: ANALYSIS_PROMPT },
          ],
        }],
        config: { temperature: 0.4, maxOutputTokens: 512 },
      }),
      new Promise<never>((_, reject) => {
        analysisTimeoutId = setTimeout(
          () => reject(new Error(`Vision analysis timed out after ${FREE_EDIT_ANALYSIS_TIMEOUT}ms`)),
          FREE_EDIT_ANALYSIS_TIMEOUT,
        );
      }),
    ]);
    if (analysisTimeoutId !== undefined) clearTimeout(analysisTimeoutId);

    const textPart = (analysisResult.candidates?.[0]?.content?.parts as Array<{text?: string}> | undefined)
      ?.find((p) => p.text);
    generationPrompt = textPart?.text?.trim() ?? "";

    if (!generationPrompt || generationPrompt.length < 30) {
      logger.warn("[imageEdit] free pipeline: Gemini analysis returned empty — using enriched instruction as fallback");
      generationPrompt = `${instruction}, ${modeDirective.split('.')[0]}, ultra high quality, professional photography, sharp focus, 8k`;
    }
  } catch (err) {
    if (analysisTimeoutId !== undefined) clearTimeout(analysisTimeoutId);
    logger.warn({ err }, "[imageEdit] free pipeline: Gemini analysis failed — using enriched instruction as fallback");
    generationPrompt = `${instruction}, ${modeDirective.split('.')[0]}, ultra high quality, professional photography, sharp focus, 8k`;
  }

  logger.info(
    { promptLen: generationPrompt.length, preview: generationPrompt.slice(0, 100) },
    "[imageEdit] free pipeline: generation prompt ready — calling Pollinations FLUX",
  );

  // Step 2: Pollinations FLUX (FREE)
  // generateImage() returns a data URL; we need the remaining portion of timeoutMs.
  // pollinationsFetch already uses REQUEST_TIMEOUT_MS (65s) internally.
  void timeoutMs; // governed by REQUEST_TIMEOUT_MS; parameter kept for signature compat
  return generateImage(generationPrompt);
}

// ── IMG2IMG — legacy Gemini img2img (kept for reference, not called in free pipeline) ──

async function runImg2Img(
  parsed:      ParsedImage,
  instruction: string,
  timeoutMs:   number,
  contract:    string,
  temperature: number = 1.0,
): Promise<string | null> {
  if (!parsed.base64 || parsed.base64.length < 1000) {
    throw new Error("Invalid image input — image data too short.");
  }

  const { ai } = await import("@workspace/integrations-gemini-ai");

  const fullInstruction = contract + instruction;

  logger.info(
    { model: "gemini-2.5-flash-image", instructionLen: instruction.length, temperature },
    "[imageEdit] legacy runImg2Img — NOTE: use runFreeImg2Img for free-tier pipeline",
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const result = await Promise.race([
    ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } },
          { text: fullInstruction },
        ],
      }],
      config: { responseModalities: ["TEXT", "IMAGE"], temperature },
    }),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Img2img timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);

  if (timeoutId !== undefined) clearTimeout(timeoutId);

  const candidate = result.candidates?.[0];
  const rawParts  = candidate?.content?.parts as Array<{
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
  }> | undefined;

  const imageParts = rawParts?.filter((p) => p.inlineData?.data) ?? [];

  if (imageParts.length === 0) {
    const textPreview = rawParts?.filter((p) => p.text).map((p) => p.text).join("").slice(0, 200) ?? "";
    logger.warn({ finishReason: (candidate as { finishReason?: string })?.finishReason, textPreview }, "[imageEdit] model returned no image parts");
    return null;
  }

  const part       = imageParts[0]!;
  const outputMime = part.inlineData!.mimeType!;
  const outputData = part.inlineData!.data!;
  const dataUrl    = `data:${outputMime};base64,${outputData}`;
  validateImageResponse(dataUrl);

  logger.info({ outputMime, outputBytes: outputData.length }, "[imageEdit] img2img success");
  return dataUrl;
}

// ── Multi-stage pipeline contracts ────────────────────────────────────────────
//
// Three specialized contracts applied in sequence.
// Each stage's output data URL becomes the next stage's input image.

const STAGE_1_CLEANUP_CONTRACT = `You are a precision inpainting and image reconstruction engine.

OPERATING MODE: Maximum precision — deterministic reconstruction.
TASK: Remove all unwanted elements and reconstruct the clean image base with perfect fidelity.
OUTPUT STANDARD: "Surgically clean source image — artifacts removed, structure intact."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SPECIALIST BEHAVIOR — INPAINTING MODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Detect and remove: overlaid text, emoji, stickers, watermarks, UI chrome, compression blocks
• Reconstruct removed areas using surrounding context — fill must be seamless and natural
• Correct distracting background elements that compete with the primary subject
• Neutralize over-processing: recover crushed blacks, restore blown highlights to natural values
• Eliminate visible JPEG / compression noise while preserving edge detail

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRECISION RULES — NO CREATIVE DEVIATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• ZERO stylistic changes — no color shifts, no mood alteration, no artistic interpretation
• ZERO lighting modification — ambient, shadows, and highlights remain as-is
• ZERO identity change — facial structure, age, ethnicity, body unchanged
• If the image is already clean: output it nearly unchanged — do not invent improvements
• Reconstruction fills must match the local texture, color, and luminance context exactly

RECONSTRUCTION TARGET (context only — preserve faithfully, do NOT transform):
`;

const STAGE_2_ENHANCEMENT_CONTRACT = `You are a computational photography realism engine operating in controlled enhancement mode.

OPERATING MODE: Physically-grounded realism — no subjective aesthetics.
TASK: Improve the photographic fidelity and visual quality of this image to professional standards.
OUTPUT STANDARD: "Premium RAW-processed photograph — technically flawless, natural realism."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SPECIALIST BEHAVIOR — REALISM ENGINE MODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Lighting correction: simulate natural ambient fill, reduce harsh specular shadows, model soft diffuse wrap
• Dynamic range: recover crushed shadows and blown highlights using tone-curve expansion
• Facial rendering: sharpen iris micro-detail, improve eyelash separation, refine skin microstructure
• Skin texture: smooth unevenness while preserving pores, hair follicle detail, and natural skin topography
• Global sharpness: apply adaptive unsharp masking — increase acuity without introducing halation
• Depth separation: gentle bokeh or luminance falloff to distinguish subject plane from background
• Chromatic accuracy: neutralize color casts, correct white balance to D65 daylight standard

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT RULES — CONTROLLED REALISM ONLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• DO NOT apply cinematic color grading, LUTs, or stylistic tone shifts
• DO NOT alter facial geometry, age, ethnicity, or subject identity
• DO NOT introduce film grain, haze, vignette, or atmospheric effects
• Output must pass as a professionally retouched photograph from a high-end DSLR sensor

REALISM ENHANCEMENT — instruction:
`;

const STAGE_3_CINEMATIC_CONTRACT = `You are a Hollywood digital intermediate colorist and cinematic image finishing engine.

OPERATING MODE: Full artistic expressiveness — deliberate aesthetic transformation.
TASK: Apply a professional cinematic grade and atmosphere to this image as described below.
OUTPUT STANDARD: "Digital intermediate — film-release grade cinematic image."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SPECIALIST BEHAVIOR — CINEMATIC GRADING ENGINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Primary color grade: apply a film-stock LUT simulation — rich shadows, controlled midtones, open highlights
• Mood palette: intentionally shift the color palette to match the requested mood (warm, cold, moody, neutral, dramatic)
• Tone mapping: S-curve contrast with shoulder roll-off — avoid crushing blacks or clipping whites
• Atmosphere: add haze, fog, or environmental depth to extend spatial dimension
• Vignette: subtle optical falloff at corners if it improves composition focus (never forced)
• Film character: introduce gentle grain, halation, or lens softness to create organic film texture
• Lighting direction: add or shift light sources to match the cinematic mood if needed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Preserve subject identity — same person, same facial geometry
• Do NOT alter facial structure or body proportions
• Do NOT distort photorealism unless the instruction explicitly calls for it

CINEMATIC GRADING INSTRUCTION:
`;

// ── Stage runner — executes one stage using a data URL as input ───────────────

async function runStage(
  inputDataUrl: string,
  instruction:  string,
  contract:     string,
  stageNum:     number,
  temperature:  number = 1.0,
): Promise<string | null> {
  const parsed = parseAndValidateImage(inputDataUrl);
  logger.info(
    { stageNum, instructionLen: instruction.length, inputBytes: parsed.base64.length, temperature },
    `[imageEdit] running stage ${stageNum}`,
  );
  return runImg2Img(parsed, instruction, STAGE_TIMEOUT_MS, contract, temperature);
}

// ── Mode stage plan ───────────────────────────────────────────────────────────
//
// Returns an ordered list of stage descriptors for the given edit mode.
// Each descriptor carries the contract and an instruction builder.

// ── Stage specialization temperatures ────────────────────────────────────────
//
// Each stage is tuned to behave like a different AI expert system via temperature.
//
//  Stage 1 — Inpainting specialist (0.35):  deterministic, precision reconstruction,
//            minimal creative deviation, maximum fidelity to source content.
//
//  Stage 2 — Realism enhancer (0.65):       controlled realism improvement, physically
//            grounded lighting, no subjective aesthetics, balanced quality output.
//
//  Stage 3 — Cinematic/artistic engine (1.0): full artistic expressiveness, film-stock
//            simulation, deliberate aesthetic interpretation, diffusion-style output.

const STAGE_TEMPERATURES = {
  cleanup:    0.35,
  enhancement: 0.65,
  cinematic:   1.0,
} as const;

// ── Intensity system ──────────────────────────────────────────────────────────

export type IntensityLevel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

const VALID_INTENSITIES: IntensityLevel[] = ["LOW", "MEDIUM", "HIGH", "EXTREME"];

export function resolveIntensity(raw: string | undefined): IntensityLevel {
  if (!raw) return "MEDIUM";
  const upper = raw.toUpperCase();
  return (VALID_INTENSITIES as string[]).includes(upper) ? (upper as IntensityLevel) : "MEDIUM";
}

export function downgradedIntensity(intensity: IntensityLevel): IntensityLevel {
  switch (intensity) {
    case "EXTREME": return "HIGH";
    case "HIGH":    return "MEDIUM";
    case "MEDIUM":  return "LOW";
    case "LOW":     return "LOW";
  }
}

// ── Control hierarchy — Stage 3 temperature ───────────────────────────────────
//
//  HIERARCHY:
//    1. editMode  — PRIMARY DRIVER — defines pipeline structure, contract, identity lock
//    2. intensity — SECONDARY MODIFIER — adjusts output strength within mode boundaries
//    3. stages    — INTERNAL EXECUTION — not user-controlled
//
//  TEMPERATURE RULE:
//    Stage 3 temp = STAGE_3_BASE[mode] + INTENSITY_MODIFIER[intensity]
//    Clamped to [0.3, 1.3].
//
//  Mode wins for structure. Intensity only adjusts strength inside the mode's boundaries.
//  portrait_safe has no Stage 3 — intensity affects only Stage 2 enhancement for that mode.

const STAGE_3_BASE_TEMPERATURES: Record<EditMode, number> = {
  portrait_safe:  0.80,
  cinematic:      1.00,
  style_transfer: 1.05,
  creative:       1.10,
  polish:         0.75,
  social:         0.90,
  luxury:         0.85,
  restore:        0.70,
};

const INTENSITY_TEMPERATURE_MODIFIERS: Record<IntensityLevel, number> = {
  LOW:     -0.20,
  MEDIUM:   0.00,
  HIGH:    +0.10,
  EXTREME: +0.20,
};

function computeStage3Temperature(mode: EditMode, intensity: IntensityLevel): number {
  const raw = STAGE_3_BASE_TEMPERATURES[mode] + INTENSITY_TEMPERATURE_MODIFIERS[intensity];
  return Math.min(1.3, Math.max(0.3, raw));
}

// ── Explainability layer ──────────────────────────────────────────────────────

const MODE_EXPLANATION: Record<EditMode, string> = {
  portrait_safe:  "Prioritized identity preservation and minimal stylistic deviation",
  cinematic:      "Enabled full cinematic grading in Stage 3",
  style_transfer: "Skipped enhancement stage to prioritize artistic transformation",
  creative:       "Allowed maximum stylistic freedom across Stage 2 and Stage 3",
  polish:         "Applied natural skin cleanup, lighting balance, and sharpness refinement",
  social:         "Applied punchy mobile-optimized enhancement with vibrant controlled tones",
  luxury:         "Applied ultra-clean premium aesthetic with soft highlights and campaign quality",
  restore:        "Applied precision cleanup: noise reduction, blur recovery, artifact removal",
};

const INTENSITY_EXPLANATION: Record<IntensityLevel, string> = {
  LOW:     "Minimized stylistic changes and increased realism",
  MEDIUM:  "Balanced transformation strength",
  HIGH:    "Increased cinematic and stylistic impact in Stage 3",
  EXTREME: "Strong artistic transformation with reduced constraints in Stage 3",
};

const STAGE_EFFECT_LABELS: Partial<Record<StageDebugRecord["effect"], string>> = {
  cleanup:        "Cleaned artifacts and preserved identity",
  enhancement:    "Enhanced lighting, contrast, and clarity",
  color_grading:  "Applied cinematic color grading and mood adjustment",
  style_transfer: "Applied artistic style transformation",
  creative_pass:  "Applied creative stylistic transformation",
};

function buildExplanation(params: {
  requestedMode: EditMode;
  usedMode:      EditMode;
  intensity:     IntensityLevel;
  pipelineDebug: PipelineDebug | undefined;
  retryCount:    number;
}): ExplanationResult {
  const { requestedMode, usedMode, intensity, pipelineDebug, retryCount } = params;

  // Stage summary — only include stages that ran successfully
  const stageSummary: string[] = [];
  if (pipelineDebug) {
    const { stage_1_cleanup, stage_2_enhancement, stage_3_cinematic } = pipelineDebug.stages;
    if (stage_1_cleanup.status === "success") {
      stageSummary.push(`Stage 1: ${STAGE_EFFECT_LABELS[stage_1_cleanup.effect] ?? "Processed"}`);
    }
    if (stage_2_enhancement.status === "success") {
      stageSummary.push(`Stage 2: ${STAGE_EFFECT_LABELS[stage_2_enhancement.effect] ?? "Processed"}`);
    }
    if (stage_3_cinematic.status === "success") {
      stageSummary.push(`Stage 3: ${STAGE_EFFECT_LABELS[stage_3_cinematic.effect] ?? "Processed"}`);
    }
  }

  // Temperature summary
  const NO_STAGE3_MODES: EditMode[] = ["portrait_safe", "polish", "restore"];
  let temperatureSummary: string;
  if (NO_STAGE3_MODES.includes(usedMode)) {
    temperatureSummary = `No Stage 3 executed — ${usedMode} mode preserves identity with cleanup and enhancement only`;
  } else {
    const s3Temp = computeStage3Temperature(usedMode, intensity);
    temperatureSummary = `Final Stage 3 temperature set to ${s3Temp.toFixed(2)} (${usedMode} base + ${intensity} intensity modifier)`;
  }

  // Notes — only when something non-nominal occurred
  const notes: string[] = [];
  if (retryCount >= 1) {
    notes.push("Stage 3 retry triggered due to no output from initial attempt");
  }
  if (retryCount >= 2 && usedMode === requestedMode) {
    const downgraded = downgradedIntensity(intensity);
    notes.push(`Intensity downgraded from ${intensity} to ${downgraded} after Stage 3 retry failure`);
  }
  if (usedMode !== requestedMode) {
    notes.push(`Mode fallback applied: ${requestedMode} → ${usedMode}`);
  }

  return {
    mode:               MODE_EXPLANATION[usedMode],
    intensity:          INTENSITY_EXPLANATION[intensity],
    stageSummary,
    temperatureSummary,
    decisionFlow:       "editMode → intensity → stage pipeline → temperature computation → final render",
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// Instruction addenda injected into Stage 1 based on intensity
const S1_INTENSITY_ADDENDUM: Record<IntensityLevel, string> = {
  LOW:     " Apply very strict reconstruction — preserve maximum source fidelity, zero tolerance for deviation.",
  MEDIUM:  "",
  HIGH:    " Apply reconstruction with slightly flexible tolerance to prepare for a strong transformation.",
  EXTREME: " Apply reconstruction with flexible tolerance — the image will undergo aggressive transformation next.",
};

// Instruction addenda injected into Stage 2 based on intensity
const S2_INTENSITY_ADDENDUM: Record<IntensityLevel, string> = {
  LOW:     " Keep enhancement very subtle — apply minimal contrast and sharpening only.",
  MEDIUM:  "",
  HIGH:    " Apply stronger lighting correction, higher contrast, and increased sharpening for a vivid base.",
  EXTREME: " Apply maximum enhancement — push contrast, dynamic range, and sharpening to professional limits.",
};

type StageDescriptor = {
  stageNum:    number;
  label:       string;
  contract:    string;
  temperature: number;
  instruction: (userPrompt: string) => string;
};

function buildStagePlan(mode: EditMode, intensity: IntensityLevel): StageDescriptor[] {
  const s3Temp = computeStage3Temperature(mode, intensity);

  const s1: StageDescriptor = {
    stageNum:    1,
    label:       "Inpainting Specialist",
    contract:    STAGE_1_CLEANUP_CONTRACT,
    temperature: STAGE_TEMPERATURES.cleanup,
    instruction: (p) => `Final edit goal (context only — do not apply yet): ${p}${S1_INTENSITY_ADDENDUM[intensity]}`,
  };

  const s2: StageDescriptor = {
    stageNum:    2,
    label:       "Realism Enhancer",
    contract:    STAGE_2_ENHANCEMENT_CONTRACT,
    temperature: STAGE_TEMPERATURES.enhancement,
    instruction: (_) => `Enhance this image: improve lighting, contrast, dynamic range, sharpness, and skin texture naturally. Do not apply artistic styling.${S2_INTENSITY_ADDENDUM[intensity]}`,
  };

  const s2Polish: StageDescriptor = {
    stageNum:    2,
    label:       "Polish Engine",
    contract:    STAGE_2_ENHANCEMENT_CONTRACT,
    temperature: STAGE_TEMPERATURES.enhancement,
    instruction: (_) => `Polish this image naturally: gentle skin cleanup, blemish and redness reduction, natural skin smoothing with texture preserved, balanced lighting, sharpness refinement. Preserve all identity. Do not apply artistic styling.${S2_INTENSITY_ADDENDUM[intensity]}`,
  };

  const s3Cinematic: StageDescriptor = {
    stageNum:    3,
    label:       "Cinematic Engine",
    contract:    STAGE_3_CINEMATIC_CONTRACT,
    temperature: s3Temp,
    instruction: (p) => p,
  };

  const s3Social: StageDescriptor = {
    stageNum:    3,
    label:       "Social Engine",
    contract:    STAGE_3_CINEMATIC_CONTRACT,
    temperature: s3Temp,
    instruction: (p) => `${p} Apply vibrant mobile-optimized color enhancement: punchy contrast, lifted midtones, controlled vibrant saturation, sharp clean highlights, Instagram/TikTok tuned color grade. Preserve skin tone and subject identity exactly.`,
  };

  const s3Luxury: StageDescriptor = {
    stageNum:    3,
    label:       "Luxury Engine",
    contract:    STAGE_3_CINEMATIC_CONTRACT,
    temperature: s3Temp,
    instruction: (p) => `${p} Apply luxury editorial color grade: creamy soft highlights, warm-neutral fill light, ultra-refined skin rendering, muted elegant shadows, aspirational lifestyle atmosphere, premium fashion campaign quality. Preserve identity with precision.`,
  };

  const s3StyleTransfer: StageDescriptor = {
    stageNum:    3,
    label:       "Style Engine",
    contract:    CONTRACT_STYLE_TRANSFER,
    temperature: s3Temp,
    instruction: (p) => p,
  };

  const s3Creative: StageDescriptor = {
    stageNum:    3,
    label:       "Creative Engine",
    contract:    CONTRACT_CREATIVE,
    temperature: s3Temp,
    instruction: (p) => p,
  };

  switch (mode) {
    case "portrait_safe":  return [s1, s2];
    case "cinematic":      return [s1, s2, s3Cinematic];
    case "style_transfer": return [s1, s3StyleTransfer];
    case "creative":       return [s1, s2, s3Creative];
    case "polish":         return [s1, s2Polish];
    case "social":         return [s1, s2, s3Social];
    case "luxury":         return [s1, s2, s3Luxury];
    case "restore":        return [s1];
  }
}

// ── IMAGE-TO-IMAGE PIPELINE ───────────────────────────────────────────────────

export async function editImage(
  imageDataUrl:  string,
  prompt:        string,
  userId?:       string,
  editMode:      EditMode = "cinematic",
  intensity?:    string,
): Promise<EditResult> {

  const parsed  = parseAndValidateImage(imageDataUrl);
  const jobType = "IMAGE_EDIT_JOB" as const;

  // ── Step 1: Resolve edit mode ─────────────────────────────────────────────
  // Mode is always resolved by the route layer (imageGen.ts) before this
  // function is called. detectEditMode() is NOT called here. editMode is
  // authoritative — no recomputation, no fallback.
  const resolvedMode: EditMode = editMode;

  // ── Step 1b: Resolve intensity ────────────────────────────────────────────
  const resolvedIntensity: IntensityLevel = resolveIntensity(intensity);
  const modeLabel = MODE_LABELS[resolvedMode];

  logger.info(
    {
      resolvedMode,
      resolvedIntensity,
      prompt: prompt.slice(0, 80),
    },
    "[imageEdit] edit mode and intensity resolved",
  );

  // ── Step 2: Build render prompt ───────────────────────────────────────────
  // normalizeCinematicPrompt is applied at the route layer (imageGen.ts) on
  // the raw user prompt before enrichment begins. By this point, prompt is
  // the fully enriched effectivePrompt (editIntelligence + APRE + FRAE).
  // Re-expanding here fires on pipeline-injected vocabulary and contradicts
  // FRAE preservation directives. Pass through unchanged.
  const renderPrompt = prompt;

  const job: ImageJob = createJob({
    jobType,
    complexity: "STANDARD",
    intent: modeLabel,
    prompt,
    expandedPrompt: renderPrompt,
  });

  advanceJob(job, "processing", `Mode: ${modeLabel} | Intensity: ${resolvedIntensity} — free pipeline: vision analysis + Pollinations generation`);

  const pipelineStartMs = Date.now();

  const succeedEdit = (b64Image: string, retryCount: number, usedMode: EditMode, pipelineDebug?: PipelineDebug): EditResult => {
    const usedLabel  = MODE_LABELS[usedMode];
    const latencyMs  = Date.now() - pipelineStartMs;
    completeJob(job, "free-img2img");
    pushRenderTelemetry({
      userId,
      renderProfile:        usedLabel,
      intensity:            resolvedIntensity,
      retryCount,
      qualityVerified:      false,
      qualityIssues:        [],
      verifierOutcome:      "SKIPPED",
      processingDurationMs: latencyMs,
      contractVersion:      CONTRACT_VERSION,
      promptUsed:           renderPrompt,
      cinematicAnalysisUsed: false,
    });
    if (userId) {
      saveToHistory({
        userId, type: "edit", prompt, mode: usedLabel, intensity: resolvedIntensity, b64Image,
        complexity: "STANDARD", contractVersionUsed: CONTRACT_VERSION,
        model: `${FREE_EDIT_ANALYSIS_MODEL}→pollinations-flux`, status: "success", retryCount, latencyMs,
      }).catch((err) => logger.warn({ err }, "[imageHistory] Failed to save edit result"));
    }
    const explanation = buildExplanation({
      requestedMode: resolvedMode,
      usedMode,
      intensity:     resolvedIntensity,
      pipelineDebug,
      retryCount,
    });
    return {
      b64Image,
      job:                 jobSummary(job),
      mode:                usedLabel,
      intensity:           resolvedIntensity,
      qualityVerified:     false,
      qualityIssues:       [],
      contractVersionUsed: CONTRACT_VERSION,
      pipelineDebug,
      explanation,
    };
  };

  // ── Free single-pass pipeline ─────────────────────────────────────────────
  // Replaces the multi-stage Gemini img2img pipeline (billing required) with:
  //   Pass 1: Gemini vision → text analysis (free) → Pollinations FLUX (free)
  //   Pass 2 (retry on null): Same, once more.
  //
  // The 3-stage pipeline (3 × ~65s = 195s) is not used — single-pass gives
  // 90s total and removes the billing dependency entirely.

  const runFreePipeline = async (): Promise<EditResult> => {
    advanceJob(job, "processing", `Pass 1 — analyzing image`);

    let result: string | null = null;
    try {
      result = await runFreeImg2Img(parsed, resolvedMode, resolvedIntensity, renderPrompt, STAGE_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failJob(job, msg);
      throw err;
    }

    if (result) {
      logger.info({ mode: resolvedMode, intensity: resolvedIntensity }, "[imageEdit] free pipeline pass 1 succeeded");
      return succeedEdit(result, 0, resolvedMode, undefined);
    }

    // Pass 2: single retry on null result
    advanceJob(job, "retrying", "Pass 2 — retrying generation");
    logger.info({ jobId: job.jobId }, "[imageEdit] free pipeline: pass 1 returned null — retrying");

    let retryResult: string | null = null;
    try {
      retryResult = await runFreeImg2Img(
        parsed,
        resolvedMode,
        resolvedIntensity,
        renderPrompt + " Apply this transformation clearly and visibly.",
        STAGE_TIMEOUT_MS,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failJob(job, msg);
      throw err;
    }

    if (retryResult) {
      logger.info({ mode: resolvedMode }, "[imageEdit] free pipeline pass 2 (retry) succeeded");
      return succeedEdit(retryResult, 1, resolvedMode, undefined);
    }

    failJob(job, "Free pipeline: both passes returned no image");
    throw new Error("Image editing failed — please try again with a different instruction or image.");
  };

  // Race against global pipeline deadline
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadlinePromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new Error(`Image editing timed out — the request exceeded ${PIPELINE_TIMEOUT_MS / 1000}s. Please try again.`));
    }, PIPELINE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([runFreePipeline(), deadlinePromise]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

// ── Phase 2 — Identity Lock Prompt ───────────────────────────────────────────
//
// Deterministic identity preservation string injected into all edit requests.
// Encodes the full set of identity-critical preservation directives.

const IDENTITY_LOCK_RULES = [
  "Preserve exact subject identity — same face, same person, same defining features",
  "Preserve bone structure, natural facial proportions, and spatial relationships between all features",
  "Preserve ethnicity and all characteristics that make this face uniquely recognizable",
  "Preserve hairstyle shape, color, and natural movement unless explicitly instructed to change it",
  "Preserve clothing, pose, and body proportions unless explicitly instructed to change them",
  "Preserve camera angle, subject framing, and background composition",
  "Enhancement ≠ regeneration — this is an edit, not a reimagination — preserve subject realism throughout",
] as const;

export function buildIdentityLockPrompt(): string {
  return `IDENTITY LOCK ACTIVE: ${IDENTITY_LOCK_RULES.join(". ")}.`;
}

// ── Phase 4 — Stable Edit Prompt Builder ─────────────────────────────────────
//
// Single-call wrapper for the full deterministic edit prompt pipeline:
//   user request → safety-clean → classify → identity lock → mode template → realism constraints
//
// Runs the complete editIntelligence → APRE → FRAE chain and returns
// a fully constructed, pipeline-ready prompt. Non-throwing.

export interface StableEditPromptResult {
  finalPrompt:  string;
  category:     string;
  strength:     string;
  identityLock: string;
  safetyFixes:  string[];
}

export async function buildStableEditPrompt(
  userRequest: string,
): Promise<StableEditPromptResult> {
  try {
    const { buildEditInstruction } = await import("./editIntelligence");
    const { buildAdaptiveEditPrompt } = await import("./adaptivePromptReinforcement");
    const { buildFacialRegionEnhancement } = await import("./facialRegionAwareness");

    const intelligence = buildEditInstruction({ userPrompt: userRequest });
    const apre = buildAdaptiveEditPrompt({
      prompt:          intelligence.enrichedPrompt,
      category:        intelligence.category,
      strength:        intelligence.strength,
      templateApplied: intelligence.templateApplied,
    });
    const frae = buildFacialRegionEnhancement({
      originalPrompt:     userRequest,
      intelligenceResult: intelligence,
      apreResult:         apre,
    });
    const identityLock = buildIdentityLockPrompt();

    return {
      finalPrompt:  frae.enhancedPrompt,
      category:     intelligence.category,
      strength:     intelligence.strength,
      identityLock,
      safetyFixes:  intelligence.safetyFixes,
    };
  } catch (err) {
    logger.warn({ err }, "[buildStableEditPrompt] pipeline threw — returning original request");
    return {
      finalPrompt:  userRequest,
      category:     "general",
      strength:     "balanced",
      identityLock: buildIdentityLockPrompt(),
      safetyFixes:  [],
    };
  }
}
