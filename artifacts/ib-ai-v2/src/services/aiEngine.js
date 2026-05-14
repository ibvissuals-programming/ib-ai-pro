// ╔══════════════════════════════════════════════════════════════════╗
// ║  AI ARCHITECTURE LOCK — IB AI v3                                ║
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
