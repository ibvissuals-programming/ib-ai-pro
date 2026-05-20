/**
 * memoryStore — PostgreSQL persistence for user memory key-value pairs.
 *
 * Provides per-user memory slots (e.g. name, preferences, context).
 * Keys are namespaced by userId — no user can read/write another user's memory.
 *
 * Rules:
 *   - Max 50 memory entries per user (oldest pruned on overflow).
 *   - Max 20 entries injected into system prompt (injection cap).
 *   - Key length: 1–80 chars. Value length: 1–500 chars.
 *   - Upsert semantics: writing the same key overwrites the value.
 *   - 'low' confidence entries are never stored — filtered at write time.
 *   - Never log memory values — they may contain PII.
 */
import { eq, and, desc, count } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, userMemoryTable } from "@workspace/db";
import { logger } from "../lib/logger";
import type { MemoryType, MemoryConfidence } from "@workspace/db";

export { type MemoryType, type MemoryConfidence };

export const MEMORY_LIMITS = {
  maxEntriesPerUser:  50, // hard storage cap — oldest pruned on overflow
  maxInjectedEntries: 20, // max entries injected into system prompt — prevents prompt bloat
  maxKeyLength:       80,
  maxValueLength:     500,
} as const;

export interface MemoryEntry {
  id:         string;
  key:        string;
  value:      string;
  type:       MemoryType;
  confidence: MemoryConfidence;
  updatedAt:  number;
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Load all memory entries for a user, newest first.
 */
export async function getUserMemory(userId: string): Promise<MemoryEntry[]> {
  const rows = await db
    .select({
      id:         userMemoryTable.id,
      key:        userMemoryTable.key,
      value:      userMemoryTable.value,
      type:       userMemoryTable.type,
      confidence: userMemoryTable.confidence,
      updatedAt:  userMemoryTable.updatedAt,
    })
    .from(userMemoryTable)
    .where(eq(userMemoryTable.userId, userId))
    .orderBy(desc(userMemoryTable.updatedAt));

  return rows as MemoryEntry[];
}

/**
 * Load memory as a flat key→value map. Used by the chat route for prompt
 * injection and by the extractor for deduplication key lookup.
 * Returns all stored entries (low confidence is never stored, so no filter needed).
 */
export async function getUserMemoryMap(userId: string): Promise<Record<string, string>> {
  const rows = await getUserMemory(userId);
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upsert a memory entry. Trims oldest entries if the per-user cap is exceeded.
 * 'low' confidence entries are rejected — they are never persisted.
 */
export async function setMemory(
  userId:     string,
  key:        string,
  value:      string,
  type:       MemoryType       = "behavioral",
  confidence: MemoryConfidence = "high",
): Promise<MemoryEntry> {
  // Safety gate: low confidence entries must never be stored
  if (confidence === "low") {
    logger.debug({ userId, key }, "[memory] skipped low-confidence entry");
    // Return a synthetic entry — callers don't need to check the result
    return { id: "", key, value, type, confidence, updatedAt: Date.now() };
  }

  const trimmedKey   = key.trim().slice(0, MEMORY_LIMITS.maxKeyLength);
  const trimmedValue = value.trim().slice(0, MEMORY_LIMITS.maxValueLength);
  const now = Date.now();

  // Check if entry already exists for this user+key
  const [existing] = await db
    .select({ id: userMemoryTable.id })
    .from(userMemoryTable)
    .where(
      and(
        eq(userMemoryTable.userId, userId),
        eq(userMemoryTable.key, trimmedKey),
      ),
    )
    .limit(1);

  if (existing) {
    // Update in place — refresh value, type, confidence, and timestamp
    await db
      .update(userMemoryTable)
      .set({ value: trimmedValue, type, confidence, updatedAt: now })
      .where(eq(userMemoryTable.id, existing.id));

    logger.debug({ userId, key: trimmedKey, type, confidence }, "[memory] updated entry");
    return { id: existing.id, key: trimmedKey, value: trimmedValue, type, confidence, updatedAt: now };
  }

  // Insert new entry
  const id = randomUUID();
  await db.insert(userMemoryTable).values({
    id,
    userId,
    key:        trimmedKey,
    value:      trimmedValue,
    type,
    confidence,
    updatedAt:  now,
  });

  logger.debug({ userId, key: trimmedKey, type, confidence }, "[memory] inserted entry");

  // Prune oldest entries if over cap
  const [{ total }] = await db
    .select({ total: count() })
    .from(userMemoryTable)
    .where(eq(userMemoryTable.userId, userId));

  if (total > MEMORY_LIMITS.maxEntriesPerUser) {
    const overflow = total - MEMORY_LIMITS.maxEntriesPerUser;
    const oldest = await db
      .select({ id: userMemoryTable.id })
      .from(userMemoryTable)
      .where(eq(userMemoryTable.userId, userId))
      .orderBy(userMemoryTable.updatedAt)
      .limit(overflow);

    for (const row of oldest) {
      await db.delete(userMemoryTable).where(eq(userMemoryTable.id, row.id));
    }
    logger.debug({ userId, pruned: overflow }, "[memory] pruned oldest entries");
  }

  return { id, key: trimmedKey, value: trimmedValue, type, confidence, updatedAt: now };
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Delete a single memory entry by key. Returns true if deleted, false if not found.
 */
export async function deleteMemory(userId: string, key: string): Promise<boolean> {
  const trimmedKey = key.trim().slice(0, MEMORY_LIMITS.maxKeyLength);

  const [existing] = await db
    .select({ id: userMemoryTable.id })
    .from(userMemoryTable)
    .where(
      and(
        eq(userMemoryTable.userId, userId),
        eq(userMemoryTable.key, trimmedKey),
      ),
    )
    .limit(1);

  if (!existing) return false;

  await db.delete(userMemoryTable).where(eq(userMemoryTable.id, existing.id));
  logger.debug({ userId, key: trimmedKey }, "[memory] deleted entry");
  return true;
}

/**
 * Clear all memory entries for a user. Uses a single bulk delete.
 */
export async function clearUserMemory(userId: string): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(userMemoryTable)
    .where(eq(userMemoryTable.userId, userId));

  if (total === 0) return 0;

  await db.delete(userMemoryTable).where(eq(userMemoryTable.userId, userId));

  logger.debug({ userId, cleared: total }, "[memory] cleared all entries");
  return total;
}

// ── Prompt injection ──────────────────────────────────────────────────────────

/**
 * Build a structured memory block for injection into the system prompt.
 *
 * Accepts a pre-filtered, relevance-scored slice of MemoryEntry rows
 * (produced by memoryRetriever). Entries are grouped into three sections
 * based on type so the model knows how to weight each piece of context.
 *
 * Rules:
 *   - Returns null when the entries array is empty — no injection overhead.
 *   - Never includes raw key names in the model's context — values only, to
 *     avoid the model mechanically echoing storage keys.
 *   - Usage guidance steers the model to apply context naturally, never
 *     robotically ("as you mentioned", "I remember you said", etc.).
 *
 * Observability (no PII in log values):
 *   [mem] inject:final_count — number of entries emitted
 *   [mem] inject:final_chars — total characters in the injected block
 *
 * @param entries  Relevance-scored entries from memoryRetriever.
 * @returns        Formatted string block, or null if nothing to inject.
 */
export function buildMemoryBlock(entries: MemoryEntry[]): string | null {
  if (entries.length === 0) return null;

  // Partition by section —————————————————————————————————————————————————————
  const projectTypes  = new Set<MemoryType>(["project"]);
  const behaviorTypes = new Set<MemoryType>(["behavioral", "behavior", "goal"]);
  // identity, narrative, relationship, preference → Active Relevant Context

  const projects:  string[] = [];
  const behaviors: string[] = [];
  const context:   string[] = [];

  for (const e of entries) {
    const line = `- ${e.value}`;
    if (projectTypes.has(e.type))  projects.push(line);
    else if (behaviorTypes.has(e.type)) behaviors.push(line);
    else context.push(line);
  }

  // Build section blocks (only emit sections with content) ——————————————————
  const sections: string[] = [];

  if (projects.length  > 0) sections.push(`### Current Projects\n${projects.join("\n")}`);
  if (behaviors.length > 0) sections.push(`### Behavioral Guidance\n${behaviors.join("\n")}`);
  if (context.length   > 0) sections.push(`### Active Relevant Context\n${context.join("\n")}`);

  const body = sections.join("\n\n");

  const block = [
    "## User Context",
    "Apply this context naturally during the conversation.",
    "Do not list or quote these entries unless the user explicitly asks.",
    "Never say \"as you mentioned\" or \"I remember you said\" — incorporate context seamlessly.",
    "Never force personalisation into responses where it is not relevant.",
    "",
    body,
  ].join("\n");

  logger.debug(
    { finalCount: entries.length, finalChars: block.length },
    "[mem] inject:final_count",
  );
  logger.debug({ finalChars: block.length }, "[mem] inject:final_chars");

  return block;
}
