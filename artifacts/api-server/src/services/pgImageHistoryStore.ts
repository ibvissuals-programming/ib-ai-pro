/**
 * pgImageHistoryStore — PostgreSQL adapter for image history persistence.
 *
 * Provides load, save, and delete operations that mirror the JSON
 * imageHistoryStore API. Called only when USE_POSTGRES_STORAGE=true.
 *
 * Image binary files (.jpg / .png / .webp) remain on disk regardless of
 * storage mode — only the metadata rows move to PostgreSQL.
 */
import { eq } from "drizzle-orm";
import { db, imageHistoryTable } from "@workspace/db";
import { logger } from "../lib/logger";

export interface PgHistoryEntry {
  id:                  string;
  userId:              string;
  type:                "generate" | "edit";
  prompt:              string;
  mode:                string;
  intensity:           string;
  timestamp:           number;
  imageFile:           string;
  mimeType:            string;
  complexity?:         string;
  contractVersionUsed?: string;
  model?:              string;
  status?:             string;
  retryCount?:         number;
  latencyMs?:          number;
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function pgLoadAllHistory(): Promise<PgHistoryEntry[]> {
  const rows = await db.select().from(imageHistoryTable);
  return rows.map((r) => {
    const entry: PgHistoryEntry = {
      id:        r.id,
      userId:    r.userId,
      type:      r.type as "generate" | "edit",
      prompt:    r.prompt,
      mode:      r.mode,
      intensity: r.intensity,
      timestamp: r.timestamp,
      imageFile: r.imageFile,
      mimeType:  r.mimeType,
    };
    if (r.complexity          !== null) entry.complexity          = r.complexity!;
    if (r.contractVersionUsed !== null) entry.contractVersionUsed = r.contractVersionUsed!;
    if (r.model               !== null) entry.model               = r.model!;
    if (r.status              !== null) entry.status              = r.status!;
    if (r.retryCount          !== null) entry.retryCount          = r.retryCount!;
    if (r.latencyMs           !== null) entry.latencyMs           = r.latencyMs!;
    return entry;
  });
}

// ── Save ──────────────────────────────────────────────────────────────────────

export async function pgSaveEntry(entry: PgHistoryEntry): Promise<void> {
  await db.insert(imageHistoryTable).values({
    id:                  entry.id,
    userId:              entry.userId,
    type:                entry.type,
    prompt:              entry.prompt,
    mode:                entry.mode,
    intensity:           entry.intensity,
    timestamp:           entry.timestamp,
    imageFile:           entry.imageFile,
    mimeType:            entry.mimeType,
    complexity:          entry.complexity          ?? null,
    contractVersionUsed: entry.contractVersionUsed ?? null,
    model:               entry.model               ?? null,
    status:              entry.status              ?? null,
    retryCount:          entry.retryCount          ?? null,
    latencyMs:           entry.latencyMs           ?? null,
  });
  logger.info({ id: entry.id, userId: entry.userId }, "[pgImageHistory] Entry saved");
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function pgDeleteEntry(entryId: string): Promise<void> {
  await db.delete(imageHistoryTable).where(eq(imageHistoryTable.id, entryId));
  logger.info({ entryId }, "[pgImageHistory] Entry deleted");
}
