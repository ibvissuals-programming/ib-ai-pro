/**
 * memoryExtractor — autonomous memory extraction from completed conversation turns.
 *
 * Lifecycle (fire-and-forget, always runs after [DONE] is sent to client):
 *   1. Skip guards — short/trivial messages exit immediately
 *   2. Fresh key reload from DB — ensures dedup hints are never stale
 *   3. Gemini generateContent call — low-temperature, JSON-only output
 *   4. Parse + validate candidates
 *   5. Confidence + type allowlist filter
 *   6. Upsert into user_memory via setMemory
 *
 * Observability: every lifecycle stage emits a structured log entry with
 * userId, candidate counts, elapsed ms, and skip reasons. No more silent failures.
 *
 * Performance contract:
 *   - Zero impact on streaming latency (runs entirely after res.end())
 *   - Single Gemini generateContent call per turn, capped at 512 output tokens
 *   - Never throws — all errors are caught and logged at WARN
 */
import { ai } from "@workspace/integrations-gemini-ai";
import { logger } from "../lib/logger";
import { setMemory, getUserMemoryMap } from "./memoryStore";
import { pushEvent } from "../lib/eventTracker";
import type { MemoryType, MemoryConfidence } from "./memoryStore";
import type { ChatMessage } from "./llm";

// ── Constants ─────────────────────────────────────────────────────────────────

const EXTRACTOR_MODEL    = "gemini-2.5-flash";
const MAX_CANDIDATES     = 5;
const MIN_LAST_MSG_CHARS = 20;   // skip "ok", "yes", "k", "sure", "thanks", etc.
const MIN_TOTAL_CHARS    = 35;   // minimum signal mass across the whole conversation
const EXTRACTION_TURNS   = 8;    // analyse last N user+assistant pairs (16 messages)

// Canonical v2 types — only these are accepted from Gemini output
const CANONICAL_TYPES = new Set<MemoryType>([
  "behavioral",
  "identity",
  "project",
  "narrative",
  "relationship",
]);

// Only storable confidences — "low" is intentionally absent
const STORABLE_CONFIDENCES = new Set<MemoryConfidence>(["high", "medium"]);

// ── Lifecycle log tags ────────────────────────────────────────────────────────

const L = {
  START:       "[mem] extraction:start",
  SKIP_SHORT:  "[mem] extraction:skip_short_message",
  SKIP_SIGNAL: "[mem] extraction:skip_no_signal",
  REQ:         "[mem] extraction:gemini_request",
  RES:         "[mem] extraction:gemini_response",
  PARSE_OK:    "[mem] extraction:parse_success",
  PARSE_FAIL:  "[mem] extraction:parse_failed",
  FILTERED:    "[mem] extraction:candidates_filtered",
  WRITE_OK:    "[mem] extraction:db_write_success",
  WRITE_FAIL:  "[mem] extraction:db_write_failed",
  COMPLETE:    "[mem] extraction:complete",
} as const;

// ── Extraction prompt ─────────────────────────────────────────────────────────

function buildExtractionPrompt(
  messages:     ChatMessage[],
  existingKeys: string[],
): string {
  const transcript = messages
    .filter((m) => m.role !== "system")
    .slice(-(EXTRACTION_TURNS * 2))
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 600)}`)
    .join("\n\n");

  const keyHint = existingKeys.length > 0
    ? `\nAlready stored keys — if updating the same concept, reuse the EXACT existing key name to prevent duplicates: ${existingKeys.join(", ")}`
    : "";

  return `You are a memory extraction assistant. Analyse the conversation and extract persistent facts about the user worth remembering long-term.

Return ONLY a valid JSON array. No markdown, no code fences, no explanation — raw JSON only.

Each item:
{
  "key": "snake_case_concept_name",
  "value": "clean factual statement, max 80 chars",
  "type": "behavioral | identity | project | narrative | relationship",
  "confidence": "high | medium"
}

── TYPE DEFINITIONS ──────────────────────────────────────────────────────────

  behavioral   — how the user consistently works, communicates, or approaches problems
                 (e.g. "prefers bullet-point answers", "always tests before shipping")
  identity     — who they are: role, expertise, domain, technology background
                 (e.g. "senior frontend developer", "uses React and TypeScript")
  project      — something actively being built, launched, or worked on right now,
                 including startup/company names, fundraising stage, business model,
                 target market, revenue milestones, and launch timelines
                 (e.g. "building a SaaS fintech dashboard with Next.js",
                  "startup called NovaPay in B2B payments", "raising a $1.5M pre-seed round")
  narrative    — ongoing story or creative session canon: character names, world-building
                 elements, plot facts the user has established across multiple turns
                 (e.g. "protagonist is named Kira", "story set in Lagos 2047")
  relationship — meaningful people or collaborations explicitly mentioned more than once
                 (e.g. "co-founder is called Tunde")

── CONFIDENCE RULES ──────────────────────────────────────────────────────────

  high   — assign when ANY of the following is true:
           • User makes an explicit first-person declaration of fact
             ("I am building X", "I use Y", "I always Z", "My goal is W")
           • The same fact appears in multiple turns
           • User directly confirms something ("yes, exactly", "that's right")

  medium — assign ONLY when:
           • Strongly implied across multiple turns by a clear persistent pattern
           • NOT a single mention — patterns require at least two signals

  DO NOT return low confidence entries — omit them entirely.

── NARRATIVE CONTINUITY RULES ────────────────────────────────────────────────

  • Preserve established canon — never contradict existing narrative entries
  • Only extract character/world details the USER explicitly established
    (ignore things the assistant invented or suggested)
  • If a user corrects a previously stated fact, use the existing key name
    so the update overwrites rather than duplicates
  • Never invent facts not present in the conversation

── DO NOT STORE ──────────────────────────────────────────────────────────────

  • One-time task requests ("write me X", "help me with Y")
  • Transient emotions or moods ("I'm feeling tired today")
  • Sensitive personal data: health conditions, personal bank/card details, home address
  • Questions the user asked (not declarations about themselves)
  • Facts stated by the assistant — only facts stated by the user
  • Generic filler ("that's interesting", "I see")
  • Anything weakly implied or uncertain → omit entirely
${keyHint}

If nothing meets the criteria, return an empty array: []

── CONVERSATION ──────────────────────────────────────────────────────────────

${transcript}`;
}

// ── Candidate validation ──────────────────────────────────────────────────────

interface RawCandidate {
  key:        unknown;
  value:      unknown;
  type:       unknown;
  confidence: unknown;
}

function isShapedCandidate(item: unknown): item is RawCandidate {
  if (typeof item !== "object" || item === null) return false;
  const o = item as Record<string, unknown>;
  return (
    typeof o["key"]        === "string" &&
    typeof o["value"]      === "string" &&
    typeof o["type"]       === "string" &&
    typeof o["confidence"] === "string"
  );
}

// ── Key normalisation ─────────────────────────────────────────────────────────

function normaliseKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 80);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * extractAndStoreMemory
 *
 * Analyses the completed conversation turn and autonomously stores
 * persistent facts about the user. Always fire-and-forget; never throws.
 *
 * @param userId    Authenticated user ID
 * @param messages  Full message array including the just-completed assistant turn
 */
export async function extractAndStoreMemory(
  userId:   string,
  messages: ChatMessage[],
): Promise<void> {
  const t0 = Date.now();

  // ── Skip guard 1: must have at least one user message ─────────────────────
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length < 1) return;

  const lastUserMsg    = userMessages[userMessages.length - 1]!;
  const lastMsgLen     = lastUserMsg.content.trim().length;
  const totalUserChars = userMessages.reduce((sum, m) => sum + m.content.length, 0);

  // ── Skip guard 2: last message too short (trivial reply) ──────────────────
  if (lastMsgLen < MIN_LAST_MSG_CHARS) {
    logger.info(
      { [L.SKIP_SHORT]: true, userId, lastMsgLen, minRequired: MIN_LAST_MSG_CHARS },
      L.SKIP_SHORT,
    );
    pushEvent("memory_skipped", {
      userId,
      meta: { reason: "short_message", lastMsgLen, minRequired: MIN_LAST_MSG_CHARS },
    });
    return;
  }

  // ── Skip guard 3: total conversation signal too thin ──────────────────────
  if (totalUserChars < MIN_TOTAL_CHARS) {
    logger.info(
      { [L.SKIP_SIGNAL]: true, userId, totalUserChars, minRequired: MIN_TOTAL_CHARS },
      L.SKIP_SIGNAL,
    );
    pushEvent("memory_skipped", {
      userId,
      meta: { reason: "low_signal", totalUserChars, minRequired: MIN_TOTAL_CHARS },
    });
    return;
  }

  logger.info({ userId, lastMsgLen, totalUserChars, turns: userMessages.length }, L.START);

  try {
    // ── Fresh key reload ─────────────────────────────────────────────────────
    // The memMap passed from chat.ts was loaded at request start and may be stale
    // (prior async extractions may have run since). Reload now for accurate dedup hints.
    const freshMemMap  = await getUserMemoryMap(userId);
    const existingKeys = Object.keys(freshMemMap);

    // ── Gemini call ──────────────────────────────────────────────────────────
    const prompt = buildExtractionPrompt(messages, existingKeys);
    logger.info({ userId, existingKeyCount: existingKeys.length }, L.REQ);

    let raw = "";
    try {
      const response = await ai.models.generateContent({
        model:    EXTRACTOR_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config:   {
          // 2048 gives headroom for up to 5 JSON entries (~400 chars) plus
          // Gemini 2.5 Flash's internal reasoning tokens, which consume budget
          // before any output is written — 512 was too small and truncated arrays.
          maxOutputTokens: 2048,
          temperature:     0.1,   // low temp → deterministic, structured JSON
        },
      });
      raw = (response.text ?? "").trim();
    } catch (geminiErr) {
      logger.warn({ userId, err: geminiErr, elapsedMs: Date.now() - t0 }, "[mem] extraction:gemini_failed");
      return;
    }

    const geminiElapsed = Date.now() - t0;
    logger.info({ userId, responseLen: raw.length, elapsedMs: geminiElapsed }, L.RES);

    if (!raw) {
      logger.info({ userId }, "[mem] extraction:gemini_empty");
      return;
    }

    // ── Parse ────────────────────────────────────────────────────────────────
    // Strip markdown code fences the model occasionally adds despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/,           "")
      .trim();

    let candidates: unknown;
    try {
      candidates = JSON.parse(cleaned);
    } catch {
      logger.warn({ userId, preview: raw.slice(0, 300) }, L.PARSE_FAIL);
      return;
    }

    if (!Array.isArray(candidates)) {
      logger.warn({ userId, type: typeof candidates }, L.PARSE_FAIL);
      return;
    }

    logger.info({ userId, rawCount: candidates.length }, L.PARSE_OK);

    // ── Filter + write ───────────────────────────────────────────────────────
    let accepted = 0;
    let rejected = 0;
    let written  = 0;
    let failed   = 0;

    for (const item of candidates.slice(0, MAX_CANDIDATES)) {
      if (!isShapedCandidate(item)) { rejected++; continue; }

      const confidence = item.confidence as MemoryConfidence;
      const type       = item.type       as MemoryType;

      // Allowlist: only canonical types and storable confidences pass
      if (!STORABLE_CONFIDENCES.has(confidence)) { rejected++; continue; }
      if (!CANONICAL_TYPES.has(type as MemoryType)) { rejected++; continue; }

      const key   = normaliseKey(String(item.key));
      const value = String(item.value).trim().slice(0, 500);
      if (!key || !value) { rejected++; continue; }

      accepted++;

      try {
        await setMemory(userId, key, value, type, confidence);
        logger.info({ userId, key, type, confidence }, L.WRITE_OK);
        written++;
      } catch (writeErr) {
        logger.warn({ userId, key, err: writeErr }, L.WRITE_FAIL);
        failed++;
      }
    }

    logger.info(
      { userId, rawCount: candidates.length, accepted, rejected, written, failed },
      L.FILTERED,
    );

    const elapsedMs = Date.now() - t0;
    logger.info(
      { userId, written, elapsedMs },
      L.COMPLETE,
    );

    // Phase 2+5: emit memory_extracted event if anything was stored
    if (written > 0) {
      pushEvent("memory_extracted", {
        userId,
        meta: { written, accepted, rejected },
      });
    }
  } catch (err) {
    // Outer safety net — extraction must never affect the chat pipeline
    logger.warn({ userId, err, elapsedMs: Date.now() - t0 }, "[mem] extraction:unhandled_error");
  }
}
