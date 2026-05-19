/**
 * memoryStore — PostgreSQL persistence for user memory key-value pairs.
 *
 * Provides per-user memory slots (e.g. name, preferences, context).
 * Keys are namespaced by userId — no user can read/write another user's memory.
 *
 * Rules:
 *   - Max 50 memory entries per user (oldest pruned on overflow).
 *   - Key length: 1–80 chars. Value length: 1–500 chars.
 *   - Upsert semantics: writing the same key overwrites the value.
 *   - Never log memory values — they may contain PII.
 */
import { eq, and, desc, count } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, userMemoryTable } from "@workspace/db";
import { logger } from "../lib/logger";

export const MEMORY_LIMITS = {
  maxEntriesPerUser: 50,
  maxKeyLength: 80,
  maxValueLength: 500,
} as const;

export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  updatedAt: number;
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Load all memory entries for a user, newest first.
 */
export async function getUserMemory(userId: string): Promise<MemoryEntry[]> {
  const rows = await db
    .select({
      id:        userMemoryTable.id,
      key:       userMemoryTable.key,
      value:     userMemoryTable.value,
      updatedAt: userMemoryTable.updatedAt,
    })
    .from(userMemoryTable)
    .where(eq(userMemoryTable.userId, userId))
    .orderBy(desc(userMemoryTable.updatedAt));

  return rows;
}

/**
 * Load memory as a flat key→value map. Used by the chat route for prompt injection.
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
 */
export async function setMemory(
  userId: string,
  key: string,
  value: string,
): Promise<MemoryEntry> {
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
    // Update in place
    await db
      .update(userMemoryTable)
      .set({ value: trimmedValue, updatedAt: now })
      .where(eq(userMemoryTable.id, existing.id));

    logger.debug({ userId, key: trimmedKey }, "[memory] updated entry");
    return { id: existing.id, key: trimmedKey, value: trimmedValue, updatedAt: now };
  }

  // Insert new entry
  const id = randomUUID();
  await db.insert(userMemoryTable).values({
    id,
    userId,
    key: trimmedKey,
    value: trimmedValue,
    updatedAt: now,
  });

  logger.debug({ userId, key: trimmedKey }, "[memory] inserted entry");

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

  return { id, key: trimmedKey, value: trimmedValue, updatedAt: now };
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
 * Clear all memory entries for a user.
 */
export async function clearUserMemory(userId: string): Promise<number> {
  const rows = await db
    .select({ id: userMemoryTable.id })
    .from(userMemoryTable)
    .where(eq(userMemoryTable.userId, userId));

  for (const row of rows) {
    await db.delete(userMemoryTable).where(eq(userMemoryTable.id, row.id));
  }

  logger.debug({ userId, cleared: rows.length }, "[memory] cleared all entries");
  return rows.length;
}

// ── Prompt injection ──────────────────────────────────────────────────────────

/**
 * Build a compact memory block suitable for injection into the system prompt.
 * Returns null if no memories exist (no injection needed).
 */
export function buildMemoryBlock(map: Record<string, string>): string | null {
  const entries = Object.entries(map);
  if (entries.length === 0) return null;

  const lines = entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
  return `## What I remember about you\n${lines}`;
}
