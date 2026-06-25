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
 *
 * Supported model output formats (all auto-detected):
 *   Format A — digit+dot prefix, inline label+text:
 *              "4. **Aspiration:** Imagine sinking..."
 *   Format B — bold label on own line, hook text next line:
 *              "**4-Aspiration**\nImagine sinking..."
 *   Format C — bold label on own line, bold hook text next line:
 *              "**4-Aspiration**\n**Imagine sinking...**"
 *   Format D — bold label+colon inline, no digit prefix:
 *              "**4-Aspiration:** Imagine sinking..."
 *
 * Matching: word-boundary aware — "imagine" matches "Imagine your..." and
 * "Imagine:" but not "imaginary...". Trailing punctuation after the banned
 * word (colon, comma, period) is consumed along with any following whitespace.
 */

const BANNED_OPENERS = [
  'imagine',
  'have you ever',
  'picture yourself',
  'picture a ',
  'what if you could',
  'what if ',
  'close your eyes',
  'what would it feel',
  'dream of',
  'envision',
  'think about',
];

const MAX_HOOK_WORDS = 15;

// Format A: digit + dot/paren + optional bold label + hook text (single line)
// e.g. "4. **Aspiration:** hook text"  or  "4.  Aspiration: hook text"
const FORMAT_A_RE = /^(\s*\d+[\.\)]\s+(?:\*\*[^*\n]+\*\*:?\s*|[\w-]+:\s*)?)"?([^"\n]{8,})"?\s*$/;

// Format D: bold label (colon INSIDE bold markers) + hook text (single line)
// e.g. "**4-Aspiration:** hook text"  — raw chars: **1-Aspiration:**<space>text
// The colon is part of the bold-wrapped label, so it appears before the closing **.
const FORMAT_D_RE = /^(\s*\*\*[\d\-\w]+:?\s*\*\*\s*)"?([^"\n]{8,})"?\s*$/;

// Label-only line (Format B/C): the whole line is just a label with no hook text.
// e.g. "**4-Aspiration**"  or  "**4. Aspiration:**"
const LABEL_ONLY_RE = /^\s*(?:\*{1,2})?(?:\d+[\.\)\-]\s*)?(?:\*{1,2})?[\w-]+(?:\*{1,2})?[:\s]*(?:\*{1,2})?\s*$/;

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

/**
 * Word-boundary-aware banned opener check.
 *
 * For single-word banned openers (e.g. "imagine", "envision"), the character
 * immediately after the matched word must be a non-letter so we don't strip
 * "imaginary". Multi-word openers ending with a space are already precise.
 */
function stripBannedOpener(hookText) {
  const lower = hookText.toLowerCase().trimStart();

  for (const banned of BANNED_OPENERS) {
    if (!lower.startsWith(banned)) continue;

    const afterIndex = banned.length;
    const charAfter  = lower[afterIndex] ?? '';

    const endsWithSpace = banned[banned.length - 1] === ' ';
    if (!endsWithSpace && /[a-z]/i.test(charAfter)) continue;

    // Consume any trailing punctuation + whitespace attached to the banned phrase.
    const remainder = hookText
      .trimStart()
      .slice(afterIndex)
      .replace(/^[^\w\s]*\s*/, '')
      .trimStart();

    if (!remainder) return null;
    return { original: hookText, opener: banned.trim(), fixed: capitalize(remainder) };
  }

  return null;
}

function applyCorrectionsToHookText(text) {
  let result = text.trim();
  const reasons = [];

  const openerFix = stripBannedOpener(result);
  if (openerFix) {
    result = openerFix.fixed;
    reasons.push(`banned opener "${openerFix.opener}" stripped`);
  }

  const wordCount = countWords(result);
  if (wordCount > MAX_HOOK_WORDS) {
    const words = result.trim().split(/\s+/);
    result = words.slice(0, MAX_HOOK_WORDS).join(' ').replace(/[,.]$/, '') + '...';
    reasons.push(`truncated from ${wordCount}w to ${MAX_HOOK_WORDS}w`);
  }

  return { fixed: result, reasons };
}

/**
 * isHookBlock(content)
 * Returns true when the response looks like a numbered/labeled hook list
 * in any of the supported formats.
 */
export function isHookBlock(content) {
  // Format A: "1. **Curiosity:** ..."
  const fmtA = content.match(/^\s*\d+[\.\)]\s+(?:\*\*)?[\w-]+(?:\*\*)?:?/gm);
  if (Array.isArray(fmtA) && fmtA.length >= 2) return true;

  // Format D: "**1-Curiosity:** ..." — colon is INSIDE bold markers before closing **
  const fmtD = content.match(/^\s*\*\*[\d\-\w]+:?\s*\*\*/gm);
  if (Array.isArray(fmtD) && fmtD.length >= 2) return true;

  // Format B/C: label alone on its own line (e.g. "**4-Aspiration**")
  const fmtBC = content.match(/^\s*\*{1,2}\d+[\.\)\-]\s*[\w-]+\*{1,2}\s*$/gm);
  if (Array.isArray(fmtBC) && fmtBC.length >= 2) return true;

  return false;
}

/**
 * applyHookCorrections(content)
 *
 * Scans `content` for hook-list lines across all supported formats, applies
 * banned-opener strips and word-limit truncations, and returns:
 *   { content: string, corrections: Array<{original, fixed, reasons}> }
 *
 * If no violations are found, `corrections` is empty and `content` is
 * returned unchanged.
 */
export function applyHookCorrections(content) {
  if (!isHookBlock(content)) return { content, corrections: [] };

  const corrections = [];
  const lines = content.split('\n');
  const result = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── Format A: "4. **Aspiration:** hook text" ─────────────────────────────
    const matchA = line.match(FORMAT_A_RE);
    if (matchA) {
      const [, prefix, hookText] = matchA;
      const original = hookText.trim().replace(/^"+|"+$/g, '');
      const { fixed, reasons } = applyCorrectionsToHookText(original);
      if (reasons.length > 0) {
        corrections.push({ original, fixed, reasons });
        result.push(prefix + fixed);
      } else {
        result.push(line);
      }
      i++;
      continue;
    }

    // ── Format D: "**4-Aspiration:** hook text" ──────────────────────────────
    const matchD = line.match(FORMAT_D_RE);
    if (matchD) {
      const [, prefix, hookText] = matchD;
      const original = hookText.trim().replace(/^"+|"+$/g, '');
      const { fixed, reasons } = applyCorrectionsToHookText(original);
      if (reasons.length > 0) {
        corrections.push({ original, fixed, reasons });
        result.push(prefix + fixed);
      } else {
        result.push(line);
      }
      i++;
      continue;
    }

    // ── Format B/C: label-only line → hook text on next non-empty line ───────
    if (LABEL_ONLY_RE.test(line) && line.trim().length >= 4) {
      result.push(line);
      i++;
      // Skip blank lines between label and hook text
      while (i < lines.length && lines[i].trim() === '') {
        result.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const hookLine = lines[i];
        // Strip bold markers and surrounding quotes to get raw hook text
        const rawHookText = hookLine.trim()
          .replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '')
          .replace(/^"+|"+$/g, '')
          .trim();
        if (rawHookText.length >= 8) {
          const original = rawHookText;
          const { fixed, reasons } = applyCorrectionsToHookText(original);
          if (reasons.length > 0) {
            corrections.push({ original, fixed, reasons });
            const hasBoldOpen  = hookLine.trimStart().startsWith('**');
            const hasBoldClose = hookLine.trimEnd().endsWith('**');
            result.push((hasBoldOpen ? '**' : '') + fixed + (hasBoldClose ? '**' : ''));
          } else {
            result.push(hookLine);
          }
          i++;
          continue;
        }
        result.push(hookLine);
        i++;
      }
      continue;
    }

    result.push(line);
    i++;
  }

  return { content: result.join('\n'), corrections };
}
