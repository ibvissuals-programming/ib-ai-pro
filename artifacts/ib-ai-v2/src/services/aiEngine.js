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
export function hasEditIntent(text) {
  if (!text || !text.trim()) return false;
  const lower = normalize(text);
  return EDIT_INTENT_KEYWORDS.some((kw) => lower.includes(kw));
}
