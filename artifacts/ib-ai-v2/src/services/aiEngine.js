// ╔══════════════════════════════════════════════════════════════════╗
// ║  AI ARCHITECTURE LOCK — IB AI Assistant                        ║
// ║  This file handles UI mode detection ONLY.                      ║
// ║  It MUST NOT generate, simulate, or return AI responses.        ║
// ║  All AI responses originate exclusively from /api/chat → Gemini.║
// ║  Do NOT add: generateAIResponse, mock replies, or fallbacks.    ║
// ╚══════════════════════════════════════════════════════════════════╝
const normalize = (text) => text.toLowerCase().trim().replace(/\s+/g, ' ');

export function detectMode(input) {
  const text = normalize(input);

  // ── Image generation intent (checked FIRST to avoid overlap with prompt_engineering) ──
  // Matches phrases like "generate an image of X", "create an image of X", "draw me a sunset".
  // Requires the generation verb at the START of the message so it doesn't match
  // embedded phrases like "Create a scroll-stopping, cinematic AI image for TikTok…"
  // (those contain adjectives between the article "a/an" and the noun "image",
  //  so the tightly-grouped regex pattern below won't fire on them).
  if (
    /^(please\s+)?(generate|create|make)\s+(me\s+)?(a|an)\s+(image|picture|photo|illustration|drawing)(\s|$)/.test(text) ||
    /^draw\s+(me\s+)?(a|an\s+|\s)/.test(text)
  ) return 'image_generation';

  if (
    text.includes('generate a prompt') ||
    text.includes('improve this prompt') ||
    text.includes('optimize prompt') ||
    text.includes('rewrite this prompt') ||
    text.includes('make this prompt better') ||
    text.includes('enhance this prompt') ||
    text.includes('make this better') ||
    text.includes('improve this') ||
    text.includes('optimize this')
  ) return 'prompt_engineering';

  return 'chat';
}

// ── Image prompt extractor ─────────────────────────────────────────────────────
// Strips leading generation trigger phrases to isolate the core image subject.
// e.g. "generate an image of a sunset" → "a sunset"
//      "draw me a golden retriever"    → "a golden retriever"
//      "create a picture showing the Eiffel Tower" → "the Eiffel Tower"

export function extractImagePrompt(text) {
  const lower = normalize(text);
  const stripped = lower
    .replace(/^(please\s+)?(generate|create|make)\s+(me\s+)?(a|an\s+)?(image|picture|photo|illustration|drawing)\s+(of\s+|showing\s+|depicting\s+|with\s+|for\s+me\s+of\s+)?/, '')
    .replace(/^draw\s+(me\s+)?(a|an\s+)?/, '')
    .trim();
  return stripped || lower;
}

// ── Image edit intent detection ────────────────────────────────────────────────
// Covers all 7 intent types from the Master Image System:
//   1. IMAGE EDITING        — direct modification verbs
//   2. IMAGE GENERATION     — not flagged here (no image = generation)
//   3. STYLE TRANSFER       — style/aesthetic targets
//   4. IMAGE ENHANCEMENT    — quality/sharpness/fix keywords
//   5. OBJECT MANIPULATION  — add/remove specific elements
//   6. BACKGROUND TRANSFORM — background-related keywords
//   7. COLOR / MOOD EDIT    — tone, mood, grading keywords
//
// If an image is attached AND any of these appear in the prompt, the request
// routes to /api/image/edit instead of /api/analyze-image.

const EDIT_INTENT_KEYWORDS = [
  // Direct edit verbs
  'edit', 'change', 'remove', 'replace', 'enhance', 'transform', 'retouch',
  'recolor', 'colorize', 'relight', 'upscale', 'sharpen', 'brighten', 'darken',
  'adjust', 'fix', 'improve', 'modify', 'alter', 'update', 'convert',
  'erase', 'inpaint', 'restore', 'repair', 'denoise',

  // Transformation phrases
  'make it', 'make this', 'make the', 'turn into', 'turn this', 'turn it',
  'style it', 'style as', 'render as', 'render in', 'apply', 'add',
  'put in', 'take out', 'insert',

  // Style Transfer — all major style targets
  'cinematic', 'studio', 'professional', 'artistic', 'realistic', 'surreal',
  'cartoon', 'anime', 'sketch', 'watercolor', 'oil painting', 'illustration',
  'black and white', 'vintage', 'retro', 'futuristic', 'minimal', 'luxury',
  'dramatic', 'moody', 'vibrant', 'soft', 'dark mode', 'neon',
  'pixar', 'disney', 'gta', 'cyberpunk', 'afro', 'tiktok', 'viral',
  'manga', 'comic', 'pixel art', 'film noir', 'impressionist', '3d render',
  'studio ghibli', 'hdr', 'hdr realism',

  // Enhancement
  'sharp', 'hd', '4k', '8k', 'clarity', 'crisp', 'quality', 'detailed',

  // Background
  'background', 'backdrop',

  // Color / Mood
  'color', 'tone', 'tint', 'hue', 'palette', 'mood', 'atmosphere',
  'warm', 'cool', 'cold', 'teal', 'sepia', 'grayscale', 'saturate',
  'desaturate',

  // Subject modifications
  'outfit', 'hair', 'face', 'skin', 'lighting', 'clothing', 'expression',
  'pose', 'filter', 'effect', 'texture', 'portrait', 'style',
];

/**
 * Returns true if the text contains any image-editing intent keyword.
 * Used to route image + text messages to the edit pipeline instead of analysis.
 *
 * @param {string} text
 * @returns {boolean}
 */
// ── TikTok URL detection ───────────────────────────────────────────────────────
// ⚠️ Best-effort feature — depends on unofficial tikwm.com proxy.
// Returns the first TikTok URL found in the text, or null.

export function detectTikTokUrl(text) {
  if (!text || !text.trim()) return null;
  const match = text.match(/https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s)>\]"']+/i);
  return match ? match[0].replace(/[.,;!?]+$/, '') : null;
}

export function hasEditIntent(text) {
  if (!text || !text.trim()) return false;
  const lower = normalize(text);
  return EDIT_INTENT_KEYWORDS.some((kw) => lower.includes(kw));
}
