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
// These keywords signal the user wants the image MODIFIED, not just analyzed.
// If an image is attached AND any of these appear in the prompt, the request
// routes to /api/image/edit instead of /api/analyze-image.

const EDIT_INTENT_KEYWORDS = [
  // Direct edit verbs
  'edit', 'change', 'remove', 'replace', 'enhance', 'transform', 'retouch',
  'recolor', 'colorize', 'relight', 'upscale', 'sharpen', 'brighten', 'darken',
  'adjust', 'fix', 'improve', 'modify', 'alter', 'update', 'convert',
  // Transformation phrases
  'make it', 'make this', 'make the', 'turn into', 'turn this', 'turn it',
  'style it', 'style as', 'render as', 'render in', 'apply', 'add',
  // Style/aesthetic targets
  'cinematic', 'studio', 'professional', 'artistic', 'realistic', 'surreal',
  'cartoon', 'anime', 'sketch', 'watercolor', 'oil painting', 'illustration',
  'black and white', 'vintage', 'retro', 'futuristic', 'minimal', 'luxury',
  'dramatic', 'moody', 'vibrant', 'soft', 'dark mode', 'neon',
  // Subject modifications
  'outfit', 'background', 'hair', 'face', 'skin', 'lighting', 'color',
  'clothing', 'expression', 'pose', 'style', 'filter', 'effect', 'texture',
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
