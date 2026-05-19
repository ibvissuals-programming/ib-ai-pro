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
const PIPELINE_TIMEOUT_MS    = 45_000;
const ATTEMPT_TIMEOUT_MS     = 20_000;
export const REQUEST_TIMEOUT_MS = 28_000;
export const MAX_POLLINATIONS_RETRIES = 1;

type AcceptedMime = (typeof ACCEPTED_MIMES)[number];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Edit result ───────────────────────────────────────────────────────────────

export interface EditResult {
  b64Image:            string;
  job:                 ReturnType<typeof jobSummary>;
  mode:                string;
  intensity:           string;
  qualityVerified:     boolean;
  qualityIssues:       string[];
  contractVersionUsed: string;
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
): Promise<string | null> {
  if (!parsed.base64 || parsed.base64.length < 1000) {
    throw new Error("Invalid image input — image data too short.");
  }

  const { ai } = await import("@workspace/integrations-gemini-ai");

  const fullInstruction = contract + instruction;

  logger.info(
    { model: GEMINI_IMG2IMG_MODEL, instructionLen: instruction.length },
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
      config: { responseModalities: ["TEXT", "IMAGE"], temperature: 1.0 },
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

// ── IMAGE-TO-IMAGE PIPELINE ───────────────────────────────────────────────────

export async function editImage(
  imageDataUrl:  string,
  prompt:        string,
  userId?:       string,
  editMode?:     EditMode | string,
  _intensity?:   string,
): Promise<EditResult> {

  const parsed  = parseAndValidateImage(imageDataUrl);
  const jobType = "IMAGE_EDIT_JOB" as const;

  // ── Step 1: Resolve edit mode ─────────────────────────────────────────────
  // If the caller supplied a valid mode, use it. Otherwise auto-detect from prompt.
  const VALID_MODES: EditMode[] = ["portrait_safe", "cinematic", "style_transfer", "creative"];
  const resolvedMode: EditMode =
    editMode && VALID_MODES.includes(editMode as EditMode)
      ? (editMode as EditMode)
      : detectEditMode(prompt);

  const modeLabel  = MODE_LABELS[resolvedMode];
  const intensity  = "HIGH";

  logger.info(
    { resolvedMode, autoDetected: !editMode || !VALID_MODES.includes(editMode as EditMode), prompt: prompt.slice(0, 80) },
    "[imageEdit] edit mode resolved",
  );

  // ── Step 2: Build render prompt ───────────────────────────────────────────
  const renderPrompt = normalizeCinematicPrompt(prompt);

  const job: ImageJob = createJob({
    jobType,
    complexity: "STANDARD",
    intent: modeLabel,
    prompt,
    expandedPrompt: renderPrompt,
  });

  advanceJob(job, "processing", `Mode: ${modeLabel} — calling ${GEMINI_IMG2IMG_MODEL}`);

  const pipelineStartMs = Date.now();

  const succeedEdit = (b64Image: string, retryCount: number, usedMode: EditMode): EditResult => {
    const usedLabel  = MODE_LABELS[usedMode];
    const latencyMs  = Date.now() - pipelineStartMs;
    completeJob(job, "gemini-img2img");
    pushRenderTelemetry({
      userId,
      renderProfile:        usedLabel,
      intensity,
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
        userId, type: "edit", prompt, mode: usedLabel, intensity, b64Image,
        complexity: "STANDARD", contractVersionUsed: CONTRACT_VERSION,
        model: GEMINI_IMG2IMG_MODEL, status: "success", retryCount, latencyMs,
      }).catch((err) => logger.warn({ err }, "[imageHistory] Failed to save edit result"));
    }
    return {
      b64Image,
      job:                 jobSummary(job),
      mode:                usedLabel,
      intensity,
      qualityVerified:     false,
      qualityIssues:       [],
      contractVersionUsed: CONTRACT_VERSION,
    };
  };

  const runPipeline = async (): Promise<EditResult> => {
    try {
      // ── Step 3: Attempt 1 — use resolved mode contract ───────────────────
      advanceJob(job, "streaming", `Attempt 1 — ${modeLabel} mode`);
      const contract1 = contractForMode(resolvedMode);

      let result: string | null = null;
      try {
        result = await runImg2Img(parsed, renderPrompt, ATTEMPT_TIMEOUT_MS, contract1);
      } catch (err) {
        logger.error({ err }, "[imageEdit] Attempt 1 failed with API error");
      }

      if (result) return succeedEdit(result, 0, resolvedMode);

      // ── Step 4: Failsafe retry — downgrade mode, simplify prompt ─────────
      const fallbackMode   = downgradedMode(resolvedMode);
      const fallbackLabel  = MODE_LABELS[fallbackMode];
      advanceJob(job, "retrying", `Attempt 2 — downgrading to ${fallbackLabel} mode`);
      logger.info(
        { from: resolvedMode, to: fallbackMode },
        "[imageEdit] Attempt 1 produced no output — downgrading mode and retrying",
      );

      const contract2   = contractForMode(fallbackMode);
      const retryPrompt = renderPrompt + " Apply this transformation clearly and visibly.";

      let retryResult: string | null = null;
      try {
        retryResult = await runImg2Img(parsed, retryPrompt, ATTEMPT_TIMEOUT_MS, contract2);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failJob(job, msg);
        throw new Error("Image editing failed. Please try again.");
      }

      if (retryResult) return succeedEdit(retryResult, 1, fallbackMode);

      // Both attempts produced no output
      failJob(job, "Both attempts returned no image output");
      throw new Error("Image editing failed — model returned no output after 2 attempts. Please try a clearer instruction.");

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
