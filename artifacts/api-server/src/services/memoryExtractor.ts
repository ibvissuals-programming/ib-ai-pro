/**
 * memoryExtractor — autonomous memory extraction from completed conversation turns.
 *
 * After each assistant response, this service:
 *   1. Analyses the last 3 conversation turns (6 messages max)
 *   2. Asks Gemini to identify memory-worthy persistent facts about the user
 *   3. Filters to high/medium confidence only — low confidence is discarded
 *   4. Upserts into user_memory via setMemory (dedup by key is handled there)
 *
 * MUST always be called fire-and-forget — never awaited in the chat pipeline.
 * All errors are caught and logged; this function never throws.
 *
 * Performance contract:
 *   - Runs entirely after [DONE] is sent to the client
 *   - Zero impact on streaming latency
 *   - Single Gemini generateContent call, capped at 512 output tokens
 */
import { ai } from "@workspace/integrations-gemini-ai";
import { logger } from "../lib/logger";
import { setMemory, getUserMemoryMap } from "./memoryStore";
import type { MemoryType, MemoryConfidence } from "./memoryStore";
import type { ChatMessage } from "./llm";

const EXTRACTOR_MODEL     = "gemini-2.5-flash";
const MAX_CANDIDATES      = 5;
const MIN_LAST_MSG_CHARS  = 25;  // minimum chars in the LAST user message — skips "ok", "yes", "sure"
const MIN_TOTAL_CHARS     = 40;  // minimum total user chars across the whole conversation
const EXTRACTION_TURNS    = 3;   // analyse last N user+assistant pairs (6 messages)
const VALID_TYPES         = new Set<MemoryType>(["preference", "project", "behavior", "goal"]);
// Only storable confidences — "low" is intentionally excluded so the set
// doubles as a clear allowlist: anything not in here is discarded.
const STORABLE_CONFIDENCES = new Set<MemoryConfidence>(["high", "medium"]);

// ── Extraction prompt ─────────────────────────────────────────────────────────

function buildExtractionPrompt(
  recentMessages: ChatMessage[],
  existingKeys:   string[],
): string {
  const transcript = recentMessages
    .filter((m) => m.role !== "system")
    .slice(-(EXTRACTION_TURNS * 2))
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 600)}`)
    .join("\n\n");

  const keyHint = existingKeys.length > 0
    ? `\nAlready stored keys — reuse these exact names if updating the same concept (do not create duplicates): ${existingKeys.join(", ")}`
    : "";

  return `You are a memory extraction assistant. Analyse this conversation and extract persistent facts worth remembering about the user.

Return ONLY a valid JSON array. No markdown, no code fences, no explanation — raw JSON only.

Each item in the array:
{
  "key": "snake_case_concept",
  "value": "clean factual statement, max 80 chars",
  "type": "preference | project | behavior | goal",
  "confidence": "high | medium"
}

Type definitions:
  preference — tools, languages, styles, formats, topics the user consistently favours
  project    — a specific thing they are actively building or working on
  behavior   — how they tend to communicate, work, or approach problems
  goal       — something they are trying to achieve long-term

Confidence rules:
  high   — explicitly stated by the user, repeated across turns, or directly confirmed
  medium — strongly and clearly implied by a persistent pattern in this session

DO NOT include:
  - One-time requests ("write me a poem about X")
  - Transient emotions or moods
  - Sensitive data: health, finances, location, relationships, age
  - Facts about the assistant, not the user
  - Questions the user asked (not facts about them)
  - Anything uncertain or weakly implied → omit entirely, do NOT include with low confidence
${keyHint}

If nothing is worth storing, return an empty array: []

Conversation:
${transcript}`;
}

// ── Candidate validation ──────────────────────────────────────────────────────

interface RawCandidate {
  key:        unknown;
  value:      unknown;
  type:       unknown;
  confidence: unknown;
}

function isValidCandidate(item: unknown): item is RawCandidate {
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
 * Analyses the completed conversation turn and autonomously stores any
 * persistent facts about the user into their memory profile.
 *
 * Skip guards (both must pass):
 *   - Last user message must be >= MIN_LAST_MSG_CHARS (filters "ok", "yes", "sure")
 *   - Total user content across all messages must be >= MIN_TOTAL_CHARS
 *
 * Key hint freshness:
 *   The existingMemMap passed from the chat route was loaded at request start and
 *   may be stale if previous async extractions have since written new entries.
 *   We reload a fresh key list from the DB right before calling Gemini so the
 *   dedup hint is always current. This is a cheap background SELECT.
 *
 * @param userId         Authenticated user ID
 * @param messages       Full message array (including the just-completed assistant turn)
 * @param existingMemMap Snapshot from request start — used only as a fast-path
 *                       skip check; fresh keys are always reloaded before extraction
 */
export async function extractAndStoreMemory(
  userId:         string,
  messages:       ChatMessage[],
  existingMemMap: Record<string, string>,
): Promise<void> {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length < 1) return;

  // Guard 1 — last user message must be substantive (not "ok", "yes", "sure", "k", etc.)
  const lastUserMsg = userMessages[userMessages.length - 1]!;
  if (lastUserMsg.content.trim().length < MIN_LAST_MSG_CHARS) return;

  // Guard 2 — total user content across conversation must meet minimum signal threshold
  const totalUserChars = userMessages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalUserChars < MIN_TOTAL_CHARS) return;

  try {
    // Reload fresh keys from DB — the passed-in map may be stale if a prior
    // async extraction ran between this request's start and now.
    const freshMemMap  = await getUserMemoryMap(userId);
    const existingKeys = Object.keys(freshMemMap);

    const prompt = buildExtractionPrompt(messages, existingKeys);

    const response = await ai.models.generateContent({
      model:    EXTRACTOR_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config:   {
        maxOutputTokens: 512,
        temperature:     0.1,  // low temperature → deterministic, structured JSON output
      },
    });

    // Gemini SDK exposes .text as a shorthand for the first candidate's text
    const raw = (response.text ?? "").trim();
    if (!raw) return;

    // Strip markdown code fences the model occasionally adds despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/,           "")
      .trim();

    let candidates: unknown;
    try {
      candidates = JSON.parse(cleaned);
    } catch {
      logger.warn({ preview: raw.slice(0, 200) }, "[extractor] JSON parse failed — skipping");
      return;
    }

    if (!Array.isArray(candidates)) {
      logger.warn("[extractor] response was not an array — skipping");
      return;
    }

    let stored = 0;

    for (const item of candidates.slice(0, MAX_CANDIDATES)) {
      if (!isValidCandidate(item)) continue;

      const confidence = item.confidence as MemoryConfidence;
      const type       = item.type       as MemoryType;

      // Allowlist check — only "high" and "medium" are storable
      if (!STORABLE_CONFIDENCES.has(confidence)) continue;
      if (!VALID_TYPES.has(type)) continue;

      const key   = normaliseKey(String(item.key));
      const value = String(item.value).trim().slice(0, 500);

      if (!key || !value) continue;

      await setMemory(userId, key, value, type, confidence);
      stored++;
    }

    if (stored > 0) {
      logger.info({ userId, stored }, "[extractor] memories stored from conversation");
    }
  } catch (err) {
    // Intentionally silent — extraction failure must never affect the chat pipeline
    logger.warn({ err }, "[extractor] extraction failed — chat unaffected");
  }
}
