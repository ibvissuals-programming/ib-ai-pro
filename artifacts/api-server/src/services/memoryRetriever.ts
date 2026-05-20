/**
 * memoryRetriever — lightweight relevance scoring for memory injection.
 *
 * Runs synchronously in the hot path (before stream start) so it must be
 * fast, pure, and allocation-light. No DB calls, no Gemini calls, no await.
 *
 * Scoring model (all components 0–1, combined as weighted sum):
 *   keywordScore  × 0.50  — overlap between query tokens and memory key+value
 *   typeScore     × 0.30  — type priority (project > behavioral > identity > …)
 *   recencyScore  × 0.20  — decay over time; fresh entries rank higher
 *
 * Hard caps applied after scoring:
 *   MAX_INJECTED  = 8 entries
 *   MAX_CHARS     = 2500 total key+value characters
 *
 * Observability (no PII in any log):
 *   [mem] retrieve:start    — total memories available
 *   [mem] retrieve:scored   — top-5 keys + scores (keys only, no values)
 *   [mem] retrieve:selected — final count + total chars
 *
 * Fallback contract:
 *   Any error returns [] — caller must handle gracefully (chat continues normally).
 */

import { logger } from "../lib/logger";
import type { MemoryEntry, MemoryType } from "./memoryStore";

// ── Caps ──────────────────────────────────────────────────────────────────────

const MAX_INJECTED = 8;
const MAX_CHARS    = 2500;

// ── Type priority weights (1 = lowest, 5 = highest) ──────────────────────────

const TYPE_WEIGHT: Record<MemoryType, number> = {
  // Canonical v2
  project:      5,
  behavioral:   4,
  identity:     3,
  relationship: 2,
  narrative:    1,
  // Legacy aliases (backward compat with pre-v2 stored entries)
  goal:         4,
  behavior:     4,
  preference:   3,
};

// ── Recency decay ─────────────────────────────────────────────────────────────

/**
 * Returns a score 0.0–1.0 based on how recently an entry was updated.
 * Fresh entries (< 24h) always score 1.0. Entries older than 90 days score 0.1.
 */
function recencyScore(updatedAt: number): number {
  const ageHours = (Date.now() - updatedAt) / 3_600_000;

  if (ageHours < 24)    return 1.0;   // updated today — max freshness
  if (ageHours < 168)   return 0.70;  // within a week
  if (ageHours < 720)   return 0.40;  // within a month
  if (ageHours < 2160)  return 0.20;  // within 90 days
  return 0.10;                         // older — lowest priority
}

// ── Keyword scoring ───────────────────────────────────────────────────────────

/**
 * Tokenises a query string and counts how many tokens appear in the memory
 * entry's key or value. Returns a score 0.0–1.0.
 *
 * Tokens shorter than 3 chars are dropped (removes "is", "a", "to", etc.).
 * Matching is substring (includes), so "react" matches "reactjs".
 */
function keywordScore(queryTokens: Set<string>, entry: MemoryEntry): number {
  if (queryTokens.size === 0) return 0;

  const haystack = `${entry.key} ${entry.value}`.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits++;
  }
  return hits / queryTokens.size;
}

// ── Token extraction ──────────────────────────────────────────────────────────

function extractTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length >= 3),
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * retrieveRelevantMemories
 *
 * Scores all stored memory entries against the current conversational context,
 * applies hard caps, and returns the top N most relevant entries.
 *
 * @param userMessage   The current (latest) user message text.
 * @param recentTurns   Recent conversation turns (last few user+assistant pairs).
 * @param memories      Full list of stored MemoryEntry rows for this user.
 * @returns             Sorted, capped slice of the most relevant entries.
 *                      Returns [] on any error.
 */
export function retrieveRelevantMemories(
  userMessage: string,
  recentTurns: Array<{ role: string; content: string }>,
  memories:    MemoryEntry[],
): MemoryEntry[] {
  try {
    if (memories.length === 0) return [];

    logger.info(
      { totalMemories: memories.length, msgLen: userMessage.length },
      "[mem] retrieve:start",
    );

    // Build query context from current message + last 4 conversation messages.
    // Wider context improves recall for long conversations.
    const queryText = [
      userMessage,
      ...recentTurns.slice(-4).map((t) => t.content),
    ].join(" ");

    const queryTokens = extractTokens(queryText);

    // Score every entry
    const scored = memories.map((entry) => {
      const kw      = keywordScore(queryTokens, entry);
      const typeW   = (TYPE_WEIGHT[entry.type] ?? 2) / 5;  // normalise 0–1
      const recency = recencyScore(entry.updatedAt);

      // keyword is primary signal; type weight + recency break ties and ensure
      // active project context is always represented even off-topic turns.
      const score = kw * 0.50 + typeW * 0.30 + recency * 0.20;
      return { entry, score };
    });

    // Sort descending
    scored.sort((a, b) => b.score - a.score);

    logger.debug(
      {
        topKeys: scored
          .slice(0, 5)
          .map((s) => ({ key: s.entry.key, score: Number(s.score.toFixed(3)) })),
      },
      "[mem] retrieve:scored",
    );

    // Apply hard caps: MAX_INJECTED entries and MAX_CHARS total
    const selected: MemoryEntry[] = [];
    let totalChars = 0;

    for (const { entry } of scored) {
      if (selected.length >= MAX_INJECTED) break;
      const entryChars = entry.key.length + entry.value.length + 4; // 4 = "- : \n"
      if (totalChars + entryChars > MAX_CHARS) continue;
      selected.push(entry);
      totalChars += entryChars;
    }

    logger.info(
      { selected: selected.length, totalChars },
      "[mem] retrieve:selected",
    );

    return selected;
  } catch (err) {
    logger.warn({ err }, "[mem] retrieve:error — falling back to empty");
    return [];
  }
}
