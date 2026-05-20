/**
 * Image Generation + Editing Service — IB AI Image Studio
 *
 * TEXT-TO-IMAGE:  Pollinations.ai (free, FLUX model)
 *
 * IMAGE-TO-IMAGE: Unified cinematic render pipeline.
 *
 *   Pipeline:
 *     1. INPUT IMAGE (validate)
 *     2. RENDER PROMPT (user request + optional AI Director analysis)
 *     3. IMAGE MODEL (gemini-2.5-flash-image with identity lock contract)
 *     4. SIMPLE RETRY (once, if model returns no output)
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

const GEMINI_IMG2IMG_MODEL   = "gemini-2.5-flash-image";
const POLLINATIONS_BASE      = "https://image.pollinations.ai/prompt";
const MAX_IMAGE_BYTES        = 10 * 1024 * 1024;
const ACCEPTED_MIMES         = ["image/png", "image/jpeg", "image/webp"] as const;
const RESPONSE_PATTERN       = /^data:image\/(png|jpeg|jpg|webp);base64,/;
const PIPELINE_TIMEOUT_MS    = 90_000;   // 3 stages × ~25 s + buffer
const STAGE_TIMEOUT_MS       = 25_000;   // per-stage hard cap
const ATTEMPT_TIMEOUT_MS     = 25_000;   // kept for non-pipeline callers
export const REQUEST_TIMEOUT_MS = 28_000;
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
    model:            GEMINI_IMG2IMG_MODEL,
    pipeline:         ["INPUT_IMAGE", "EDIT_MODE_RESOLVE", "RENDER_PROMPT", "IMAGE_MODEL", "MODE_DOWNGRADE_RETRY"],
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

export type EditMode = "portrait_safe" | "cinematic" | "style_transfer" | "creative";

// Mode → display label (returned in EditResult.mode for frontend badges)
const MODE_LABELS: Record<EditMode, string> = {
  portrait_safe:  "Portrait Safe",
  cinematic:      "Cinematic",
  style_transfer: "Style Transfer",
  creative:       "Creative",
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
  }
}

// ── Mode downgrade chain (used by failsafe retry) ─────────────────────────────
// creative → style_transfer → cinematic → portrait_safe

function downgradedMode(mode: EditMode): EditMode {
  const chain: EditMode[] = ["portrait_safe", "cinematic", "style_transfer", "creative"];
  const idx = chain.indexOf(mode);
  return idx > 0 ? chain[idx - 1]! : "portrait_safe";
}

// ── Intent detector — auto-assigns edit mode from prompt keywords ──────────────

const PORTRAIT_SAFE_PATTERNS = [
  /\b(enhance|retouch|cleanup|clean\s*up|touch\s*up|smooth|subtle|refine|polish|natural|freshen)\b/i,
  /\b(remove\s+(watermark|text|logo|blemish|spot|acne|wrinkle|noise|grain))\b/i,
  /\b(fix\s+(skin|face|eyes|blemish|lighting))\b/i,
  /\b(make\s+(it\s+)?(brighter|cleaner|sharper|clearer|more\s+natural))\b/i,
  /\bskin\s*(smooth|soften|clear)\b/i,
];

const CINEMATIC_PATTERNS = [
  /\b(cinematic|film\s*look|color\s*grad|mood\s*light|dramatic\s*light|studio\s*light|atmosphere|teal.?orange)\b/i,
  /\b(noir|golden\s*hour|blue\s*hour|sunset|sunrise|overcast|neon\s*light|moody|foggy|hazy)\b/i,
  /\b(make\s+(it\s+)?(more\s+)?(cinematic|dramatic|moody|atmospheric|professional))\b/i,
  /\b(film\s*grain|depth\s*of\s*field|bokeh|lens\s*flare|color\s*grade)\b/i,
];

const STYLE_TRANSFER_PATTERNS = [
  /\b(watercolor|oil\s*paint|sketch|pencil|drawing|illustration|anime|manga|cartoon|comic|ghibli)\b/i,
  /\b(fashion|editorial|vogue|runway|magazine|high\s*fashion|luxury\s*fashion)\b/i,
  /\b(vintage\s*style|retro\s*style|cyberpunk|steampunk|gothic|cottagecore)\b/i,
  /\b(look\s*like\s*(a|an)\s*(painting|illustration|drawing|sketch|anime|cartoon))\b/i,
  /\b(art\s*style|artistic\s*style|stylize|stylized)\b/i,
];

const CREATIVE_PATTERNS = [
  /\b(reimagine|completely\s*transform|change\s*everything|total\s*transformation)\b/i,
  /\b(put\s*(them|him|her|me|it)\s*in|place\s*(them|him|her|me|it)\s*in|transport\s*to|move\s*to)\b/i,
  /\b(fantasy|surreal|alien|sci\s*fi|futuristic|magical|enchanted|mythical|post.?apocalyptic)\b/i,
  /\b(concept\s*art|digital\s*art|abstract\s*art|abstract\s*background)\b/i,
  /\b(change\s*(the\s*)?background\s+to|replace\s*(the\s*)?background|new\s*background)\b/i,
];

export function detectEditMode(prompt: string): EditMode {
  const scores: Record<EditMode, number> = {
    portrait_safe:  0,
    cinematic:      0,
    style_transfer: 0,
    creative:       0,
  };

  for (const p of PORTRAIT_SAFE_PATTERNS)  if (p.test(prompt)) scores.portrait_safe++;
  for (const p of CINEMATIC_PATTERNS)       if (p.test(prompt)) scores.cinematic++;
  for (const p of STYLE_TRANSFER_PATTERNS)  if (p.test(prompt)) scores.style_transfer++;
  for (const p of CREATIVE_PATTERNS)        if (p.test(prompt)) scores.creative++;

  const max = Math.max(...Object.values(scores));

  if (max === 0) return "cinematic"; // default for ambiguous prompts

  // Priority order on tie: portrait_safe > cinematic > style_transfer > creative
  if (scores.portrait_safe  === max) return "portrait_safe";
  if (scores.cinematic       === max) return "cinematic";
  if (scores.style_transfer  === max) return "style_transfer";
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 402 || status === 503;
}

async function pollinationsFetch(url: string): Promise<Response> {
  let lastErr: Error = new Error("Unknown error");

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
        throw new Error("Image generation temporarily unavailable — please retry in a moment.");
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    if (isRetryableStatus(response.status)) {
      lastErr = new Error(`HTTP ${response.status}`);
      if (attempt < MAX_POLLINATIONS_RETRIES) continue;
      break;
    }

    return response;
  }

  logger.warn({ provider: "pollinations" }, "[ai] provider unavailable");
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

// ── IMG2IMG — single attempt via Gemini ───────────────────────────────────────

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
    { model: GEMINI_IMG2IMG_MODEL, instructionLen: instruction.length, temperature },
    "[imageEdit] calling img2img model",
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const result = await Promise.race([
    ai.models.generateContent({
      model: GEMINI_IMG2IMG_MODEL,
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
  let temperatureSummary: string;
  if (usedMode === "portrait_safe") {
    temperatureSummary = "No Stage 3 executed — portrait_safe mode preserves identity with cleanup and enhancement only";
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

  const s3Cinematic: StageDescriptor = {
    stageNum:    3,
    label:       "Cinematic Engine",
    contract:    STAGE_3_CINEMATIC_CONTRACT,
    temperature: s3Temp,
    instruction: (p) => p,
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

  advanceJob(job, "processing", `Mode: ${modeLabel} | Intensity: ${resolvedIntensity} — calling ${GEMINI_IMG2IMG_MODEL}`);

  const pipelineStartMs = Date.now();

  const succeedEdit = (b64Image: string, retryCount: number, usedMode: EditMode, pipelineDebug?: PipelineDebug): EditResult => {
    const usedLabel  = MODE_LABELS[usedMode];
    const latencyMs  = Date.now() - pipelineStartMs;
    completeJob(job, "gemini-img2img");
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
        model: GEMINI_IMG2IMG_MODEL, status: "success", retryCount, latencyMs,
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

  const runPipeline = async (): Promise<EditResult> => {
    try {
      const stages    = buildStagePlan(resolvedMode, resolvedIntensity);
      const lastStage = stages[stages.length - 1]!;

      // ── Per-stage debug records (all start as skipped) ────────────────────
      type StageKey = "stage_1_cleanup" | "stage_2_enhancement" | "stage_3_cinematic";

      const stageRecords: Record<StageKey, StageDebugRecord> = {
        stage_1_cleanup:     { status: "skipped", time_ms: 0, effect: "none", reason: "not_run" },
        stage_2_enhancement: { status: "skipped", time_ms: 0, effect: "none", reason: "not_run" },
        stage_3_cinematic:   { status: "skipped", time_ms: 0, effect: "none", reason: "not_run" },
      };

      const stageKeyOf = (n: number): StageKey =>
        n === 1 ? "stage_1_cleanup" : n === 2 ? "stage_2_enhancement" : "stage_3_cinematic";

      const effectOf = (n: number): StageDebugRecord["effect"] => {
        if (n === 1) return "cleanup";
        if (n === 2) return "enhancement";
        if (resolvedMode === "style_transfer") return "style_transfer";
        if (resolvedMode === "creative")       return "creative_pass";
        return "color_grading";
      };

      // ── Build final debug summary from collected records ──────────────────
      const buildDebug = (
        pipelineStatus: PipelineDebug["pipeline_status"],
        completedCount: number,
        overrideMode?:  EditMode,
      ): PipelineDebug => {
        const usedLabel  = MODE_LABELS[overrideMode ?? resolvedMode];
        const entries    = Object.entries(stageRecords) as [StageKey, StageDebugRecord][];
        const failed     = entries.filter(([, r]) => r.status === "failed");
        const succeeded  = entries.filter(([, r]) => r.status === "success");

        const bottleneck =
          failed.length > 0
            ? failed[0]![0].replace(/_/g, " ")
            : succeeded.length > 0
            ? succeeded.sort(([, a], [, b]) => b.time_ms - a.time_ms)[0]![0].replace(/_/g, " ")
            : "none";

        let recommendation: string;
        if (pipelineStatus === "success") {
          recommendation = `Pipeline ran cleanly — ${completedCount} stage(s) completed`;
        } else if (stageRecords.stage_3_cinematic.status === "failed" && completedCount > 0) {
          recommendation = "Cinematic grading failed — output is enhanced but not color graded. Try a simpler instruction or switch to Cinematic mode.";
        } else if (stageRecords.stage_2_enhancement.status === "failed" && stageRecords.stage_1_cleanup.status === "success") {
          recommendation = "Enhancement pass failed — output is cleaned but not enhanced. Try Portrait Safe mode for more stable results.";
        } else if (stageRecords.stage_1_cleanup.status === "failed") {
          recommendation = "Cleanup stage failed — try a less complex image or simpler instruction.";
        } else {
          recommendation = "Full pipeline failed — model may be overloaded. Try a simpler instruction or a different edit mode.";
        }

        return { mode: usedLabel, pipeline_status: pipelineStatus, stages: stageRecords, bottleneck, recommendation };
      };

      // ── Multi-stage execution ─────────────────────────────────────────────
      let currentDataUrl: string = imageDataUrl;
      let stagesCompleted        = 0;

      for (const stage of stages) {
        advanceJob(
          job,
          stage.stageNum < stages.length ? "processing" : "streaming",
          `Stage ${stage.stageNum}/${stages.length} — ${stage.label}`,
        );

        const key          = stageKeyOf(stage.stageNum);
        const instruction  = stage.instruction(renderPrompt);
        const stageStartMs = Date.now();
        let stageOut: string | null = null;
        let failureReason: string | undefined;

        try {
          stageOut = await runStage(currentDataUrl, instruction, stage.contract, stage.stageNum, stage.temperature);
          if (!stageOut) failureReason = "model_rejection";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failureReason = msg.toLowerCase().includes("timeout") ? "timeout" : "model_rejection";
          logger.error({ err, stageNum: stage.stageNum }, "[imageEdit] stage threw — continuing with prior output");
        }

        const stageMs = Date.now() - stageStartMs;

        if (stageOut) {
          currentDataUrl = stageOut;
          stagesCompleted++;
          stageRecords[key] = { status: "success", time_ms: stageMs, effect: effectOf(stage.stageNum) };
          logger.info({ stageNum: stage.stageNum, stagesCompleted, time_ms: stageMs }, "[imageEdit] stage completed");
        } else {
          stageRecords[key] = { status: "failed", time_ms: stageMs, effect: "none", reason: failureReason };
          logger.warn({ stageNum: stage.stageNum, reason: failureReason }, "[imageEdit] stage returned no image — using prior output");
        }
      }

      // ── At least one stage produced output — pipeline success / partial ───
      if (stagesCompleted > 0) {
        const pipelineStatus = stagesCompleted === stages.length ? "success" : "partial";
        return succeedEdit(currentDataUrl, 0, resolvedMode, buildDebug(pipelineStatus, stagesCompleted));
      }

      // ── Failsafe: all stages returned null — retry Stage 3 once ──────────
      if (lastStage.stageNum === 3) {
        advanceJob(job, "retrying", `Failsafe — retrying Stage 3 (${lastStage.label})`);
        logger.info("[imageEdit] All stages returned null — retrying Stage 3");

        const retryStartMs = Date.now();
        let retryOut: string | null = null;
        try {
          retryOut = await runStage(
            imageDataUrl,
            lastStage.instruction(renderPrompt) + " Apply this transformation clearly and visibly.",
            lastStage.contract,
            3,
            lastStage.temperature,
          );
        } catch (err) {
          logger.error({ err }, "[imageEdit] Stage 3 retry threw");
        }

        if (retryOut) {
          stageRecords.stage_3_cinematic = {
            status: "success", time_ms: Date.now() - retryStartMs,
            effect: effectOf(3), reason: "retry_succeeded",
          };
          return succeedEdit(retryOut, 1, resolvedMode, buildDebug("partial", 1));
        }
        stageRecords.stage_3_cinematic.reason = "weak_transformation";

        // ── Intensity-downgrade failsafe: retry Stage 3 at reduced intensity ─
        const downgradedInt = downgradedIntensity(resolvedIntensity);
        if (downgradedInt !== resolvedIntensity) {
          const intRetryTemp = computeStage3Temperature(resolvedMode, downgradedInt);
          advanceJob(job, "retrying", `Intensity downgrade (${resolvedIntensity} → ${downgradedInt}) — retrying Stage 3`);
          logger.info(
            { from: resolvedIntensity, to: downgradedInt, temperature: intRetryTemp },
            "[imageEdit] intensity downgrade — retrying Stage 3",
          );
          let intRetryOut: string | null = null;
          try {
            intRetryOut = await runStage(
              imageDataUrl,
              lastStage.instruction(renderPrompt) + " Apply this transformation clearly and visibly.",
              lastStage.contract,
              3,
              intRetryTemp,
            );
          } catch (err) {
            logger.error({ err }, "[imageEdit] Stage 3 intensity-downgrade retry threw");
          }
          if (intRetryOut) {
            stageRecords.stage_3_cinematic = {
              status: "success", time_ms: 0,
              effect: effectOf(3), reason: "intensity_downgrade_succeeded",
            };
            return succeedEdit(intRetryOut, 2, resolvedMode, buildDebug("partial", 1));
          }
        }
      }

      // ── Final fallback: downgrade mode, single-shot attempt ───────────────
      const fallbackMode  = downgradedMode(resolvedMode);
      const fallbackLabel = MODE_LABELS[fallbackMode];
      advanceJob(job, "retrying", `Downgrading to ${fallbackLabel} mode`);
      logger.info({ from: resolvedMode, to: fallbackMode }, "[imageEdit] downgrading mode for final attempt");

      const fallbackContract = contractForMode(fallbackMode);
      let fallbackOut: string | null = null;
      try {
        fallbackOut = await runImg2Img(
          parsed,
          renderPrompt + " Apply this transformation clearly and visibly.",
          STAGE_TIMEOUT_MS,
          fallbackContract,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failJob(job, msg);
        throw new Error("Image editing failed. Please try again.");
      }

      if (fallbackOut) return succeedEdit(fallbackOut, 2, fallbackMode, buildDebug("partial", 0, fallbackMode));

      failJob(job, "All pipeline stages and fallback returned no image output");
      throw new Error("Image editing failed — model returned no output after the full pipeline. Please try a different instruction.");

    } catch (err) {
      if (job.status !== "failed") {
        failJob(job, err instanceof Error ? err.message : "Unknown error");
      }
      throw err;
    }
  };

  // Race against global pipeline deadline
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadlinePromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new Error(`Image editing timed out — the request exceeded ${PIPELINE_TIMEOUT_MS / 1000}s. Please try again.`));
    }, PIPELINE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([runPipeline(), deadlinePromise]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}
