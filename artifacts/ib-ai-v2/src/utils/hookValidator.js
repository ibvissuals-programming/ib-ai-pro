/**
 * hookValidator.js — post-generation hook compliance filter
 *
 * Scans completed hook-list AI responses for rule violations and applies
 * deterministic corrections so compliance is enforced even when the model
 * ignores prompt instructions.
 *
 * Rules enforced:
 *   1. Banned openers  — hooks must not start with any phrase in BANNED_OPENERS
 *   2. Word limit      — hooks must be ≤ MAX_HOOK_WORDS (15)
 *
 * Fix strategy:
 *   - Banned opener  → strip the banned prefix, capitalize the remainder
 *   - Over word limit → truncate at word 15, append "..."
 */

const BANNED_OPENERS = [
  'imagine ',
  'have you ever ',
  'picture yourself ',
  'what if you could ',
  'close your eyes',
  'what would it feel',
];

const MAX_HOOK_WORDS = 15;

function countWords(text) {
  return text
    .replace(/[^\w\s'-]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripBannedOpener(hookText) {
  const lower = hookText.toLowerCase().trimStart();
  for (const banned of BANNED_OPENERS) {
    if (lower.startsWith(banned)) {
      const remainder = hookText.trimStart().slice(banned.length).trimStart();
      if (!remainder) return null;
      return { original: hookText, opener: banned.trim(), fixed: capitalize(remainder) };
    }
  }
  return null;
}

function truncateToWordLimit(hookText, limit) {
  const words = hookText.trim().split(/\s+/);
  if (words.length <= limit) return { fixed: hookText, trimmed: false };
  const truncated = words.slice(0, limit).join(' ').replace(/[,.]$/, '') + '...';
  return { fixed: truncated, trimmed: true };
}

/**
 * isHookBlock(content)
 * Returns true when the response looks like a numbered hook list
 * (at least 2 lines that start with a digit + label pattern).
 */
export function isHookBlock(content) {
  const matches = content.match(/^\s*\d+[\.\)]\s+(?:\*\*)?[\w-]+(?:\*\*)?:?/gm);
  return Array.isArray(matches) && matches.length >= 2;
}

/**
 * applyHookCorrections(content)
 *
 * Scans `content` for hook-list lines, applies banned-opener strips and
 * word-limit truncations, and returns:
 *   { content: string, corrections: Array<{original, fixed, reasons}> }
 *
 * If no violations are found, `corrections` is empty and `content` is
 * returned unchanged.
 */
export function applyHookCorrections(content) {
  if (!isHookBlock(content)) return { content, corrections: [] };

  const corrections = [];

  // Match lines like: "4. **Aspiration:** hook text" or "4.  Aspiration: hook text"
  // Capture: prefix (number + label) and hook text separately.
  const hookLineRegex = /^(\s*\d+[\.\)]\s+(?:\*\*[^*\n]+\*\*:?\s*|[\w-]+:\s*)?)"?([^"\n]{8,})"?\s*$/gm;

  const fixed = content.replace(hookLineRegex, (match, prefix, hookText) => {
    let text = hookText.trim();
    const originalText = text;
    const correctionReasons = [];

    const openerFix = stripBannedOpener(text);
    if (openerFix) {
      text = openerFix.fixed;
      correctionReasons.push(`banned opener "${openerFix.opener}" stripped`);
    }

    const wordCount = countWords(text);
    if (wordCount > MAX_HOOK_WORDS) {
      const { fixed: truncated } = truncateToWordLimit(text, MAX_HOOK_WORDS);
      text = truncated;
      correctionReasons.push(`truncated from ${wordCount}w to ${MAX_HOOK_WORDS}w`);
    }

    if (correctionReasons.length > 0) {
      corrections.push({ original: originalText, fixed: text, reasons: correctionReasons });
      return prefix + text;
    }

    return match;
  });

  return { content: fixed, corrections };
}
