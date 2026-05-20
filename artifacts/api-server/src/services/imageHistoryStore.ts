/**
 * Image History Store — IB AI Assistant
 *
 * LAYER 7 — Persistent image history across refresh and login.
 *
 * Architecture:
 *   - Image files stored to Object Storage: images/{entryId}.ext
 *     (falls back to local disk for legacy entries that pre-date Object Storage)
 *   - Metadata stored in PostgreSQL (primary) or data/image-history.json (fallback)
 *   - Max 50 entries per user (oldest trimmed on write)
 *   - Max 500 entries total across all users
 *   - UUID-based IDs (unguessable) — safe to serve without strict auth on file endpoint
 *   - Write mutex prevents concurrent corruption (same pattern as userStore)
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger";
import { isPostgresEnabled } from "../lib/systemConfig";
import { pgLoadAllHistory, pgSaveEntry, pgDeleteEntry } from "./pgImageHistoryStore";
import {
  uploadImageBuffer,
  downloadImageBuffer,
  deleteObjectByName,
  isObjectStorageEnabled,
} from "./objectStore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../data");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const HISTORY_FILE = path.join(DATA_DIR, "image-history.json");

const MAX_PER_USER = 50;
const MAX_TOTAL = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  userId: string;
  type: "generate" | "edit";
  prompt: string;
  mode: string;
  intensity: string;
  timestamp: number;
  /**
   * Storage path for the image.
   * - Object Storage key: "images/{id}.ext"  (contains "/")
   * - Legacy disk filename: "{id}.ext"        (no "/" — pre-Object-Storage entries)
   */
  imageFile: string;
  mimeType: string;
  // Pipeline metadata (added v4) — optional so old persisted entries stay valid
  complexity?: string;
  contractVersionUsed?: string;
  model?: string;
  status?: string;
  retryCount?: number;
  latencyMs?: number;
}

export interface HistoryEntryPublic extends HistoryEntry {
  imageUrl: string; // /api/image/serve/{id}
}

// ── Write mutex ───────────────────────────────────────────────────────────────

let persistChain: Promise<void> = Promise.resolve();

// ── In-memory cache ───────────────────────────────────────────────────────────

let cache: HistoryEntry[] | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function mimeToExt(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

function entryToPublic(entry: HistoryEntry): HistoryEntryPublic {
  return { ...entry, imageUrl: `/api/image/serve/${entry.id}` };
}

/**
 * Returns true if the imageFile field refers to an Object Storage key.
 * Object Storage keys contain "/" (e.g. "images/{id}.jpg").
 * Legacy disk filenames do not (e.g. "{id}.jpg").
 */
export function isObjectStorageKey(imageFile: string): boolean {
  return imageFile.includes("/");
}

// ── Load history from disk ────────────────────────────────────────────────────

async function loadHistory(): Promise<HistoryEntry[]> {
  if (cache !== null) return cache;

  if (isPostgresEnabled()) {
    try {
      cache = await pgLoadAllHistory() as HistoryEntry[];
      logger.info({ count: cache.length }, "[imageHistory] Loaded from PostgreSQL");
      return cache;
    } catch (err) {
      logger.error({ err }, "[imageHistory] PG load failed — JSON fallback");
    }
  }

  let raw: string;
  try {
    raw = await fs.readFile(HISTORY_FILE, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = [];
      return cache;
    }
    logger.error({ err }, "[imageHistory] Failed to read history file");
    cache = [];
    return cache;
  }

  try {
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    logger.error("[imageHistory] Corrupted history file — starting fresh");
    cache = [];
  }

  logger.info({ count: cache.length }, "[imageHistory] Loaded");
  return cache;
}

// ── Atomic persist ────────────────────────────────────────────────────────────

async function persistHistory(entries: HistoryEntry[]): Promise<void> {
  const prev = persistChain;
  let resolveChain!: () => void;
  persistChain = new Promise<void>((r) => {
    resolveChain = r;
  });

  try {
    await prev;
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data = JSON.stringify(entries, null, 2);
    const tmp = HISTORY_FILE + ".tmp";
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(data, "utf8");
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, HISTORY_FILE);
  } catch (err) {
    logger.error({ err }, "[imageHistory] Failed to persist");
  } finally {
    resolveChain();
  }
}

// ── Image file cleanup ────────────────────────────────────────────────────────

function evictImageFile(entry: HistoryEntry): void {
  if (isObjectStorageKey(entry.imageFile)) {
    deleteObjectByName(entry.imageFile).catch(() => {});
  } else {
    fs.unlink(path.join(IMAGES_DIR, entry.imageFile)).catch(() => {});
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * LAYER 3: Eagerly create data directories at startup so later writes never
 * fail with ENOENT. Safe to call multiple times (mkdir is idempotent).
 */
export async function initImageStore(): Promise<void> {
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  // Touch the history file if it doesn't exist yet
  try {
    await fs.access(HISTORY_FILE);
  } catch {
    await fs.writeFile(HISTORY_FILE, "[]", "utf8");
  }
  logger.info(
    {
      dataDir: DATA_DIR,
      imagesDir: IMAGES_DIR,
      objectStorage: isObjectStorageEnabled(),
    },
    "[imageHistory] Store initialized",
  );
}

/**
 * Save a generated or edited image to persistent history.
 * Uploads the image to Object Storage (or disk as fallback) and appends metadata.
 */
export async function saveToHistory(params: {
  userId: string;
  type: "generate" | "edit";
  prompt: string;
  mode: string;
  intensity: string;
  b64Image: string; // full data URL: data:image/...;base64,...
  // Optional pipeline metadata
  complexity?: string;
  contractVersionUsed?: string;
  model?: string;
  status?: string;
  retryCount?: number;
  latencyMs?: number;
}): Promise<HistoryEntryPublic> {
  const { userId, type, prompt, mode, intensity, b64Image,
          complexity, contractVersionUsed, model, status, retryCount, latencyMs } = params;

  // Parse data URL
  const commaIdx = b64Image.indexOf(",");
  if (commaIdx === -1) throw new Error("Invalid image data URL");
  const header = b64Image.slice(0, commaIdx);
  const base64 = b64Image.slice(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+);/);
  const mimeType = mimeMatch?.[1] ?? "image/jpeg";

  const id = randomUUID();
  const ext = mimeToExt(mimeType);
  const imageBuffer = Buffer.from(base64, "base64");

  let imageFile: string;

  if (isObjectStorageEnabled()) {
    // Object Storage path — survives container restarts
    imageFile = `images/${id}${ext}`;
    try {
      await uploadImageBuffer(imageFile, imageBuffer, mimeType);
      logger.info({ userId, imageFile }, "[imageHistory] Image uploaded to Object Storage");
    } catch (err) {
      logger.error({ err, userId }, "[imageHistory] Object Storage upload failed — disk fallback");
      // Fall back to local disk
      imageFile = `${id}${ext}`;
      const filePath = path.join(IMAGES_DIR, imageFile);
      await fs.mkdir(IMAGES_DIR, { recursive: true });
      await fs.writeFile(filePath, imageBuffer);
    }
  } else {
    // Local disk fallback (ephemeral — for dev without Object Storage)
    imageFile = `${id}${ext}`;
    const filePath = path.join(IMAGES_DIR, imageFile);
    try {
      await fs.mkdir(IMAGES_DIR, { recursive: true });
      await fs.writeFile(filePath, imageBuffer);
    } catch (err) {
      logger.error({ err, userId }, "[imageHistory] Failed to write image file");
      throw new Error("Failed to save image");
    }
  }

  const entry: HistoryEntry = {
    id,
    userId,
    type,
    prompt,
    mode,
    intensity,
    timestamp: Date.now(),
    imageFile,
    mimeType,
    // Pipeline metadata — stored when provided by the caller
    ...(complexity !== undefined && { complexity }),
    ...(contractVersionUsed !== undefined && { contractVersionUsed }),
    ...(model !== undefined && { model }),
    ...(status !== undefined && { status }),
    ...(retryCount !== undefined && { retryCount }),
    ...(latencyMs !== undefined && { latencyMs }),
  };

  const entries = await loadHistory();
  entries.push(entry);

  // Trim: keep max MAX_PER_USER per user (remove oldest)
  const evictedEntries: HistoryEntry[] = [];
  const userEntries = entries.filter((e) => e.userId === userId);
  if (userEntries.length > MAX_PER_USER) {
    const toRemove = userEntries
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, userEntries.length - MAX_PER_USER);
    for (const old of toRemove) {
      const idx = entries.findIndex((e) => e.id === old.id);
      if (idx !== -1) entries.splice(idx, 1);
      evictedEntries.push(old);
    }
  }

  // Trim: global max
  if (entries.length > MAX_TOTAL) {
    const globalOld = entries
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, entries.length - MAX_TOTAL);
    for (const old of globalOld) {
      const idx = entries.findIndex((e) => e.id === old.id);
      if (idx !== -1) entries.splice(idx, 1);
      evictedEntries.push(old);
    }
  }

  // Delete image files for evicted entries (fire and forget)
  for (const evicted of evictedEntries) {
    evictImageFile(evicted);
  }

  cache = entries;

  if (isPostgresEnabled()) {
    try {
      await pgSaveEntry(entry);
      for (const evicted of evictedEntries) {
        await pgDeleteEntry(evicted.id);
      }
    } catch (pgErr) {
      logger.warn({ pgErr }, "[imageHistory] PG save failed — JSON fallback");
      await persistHistory(entries);
    }
  } else {
    await persistHistory(entries);
  }

  logger.info(
    { userId, type, mode, intensity, id, imageFile },
    "[imageHistory] Saved entry",
  );

  return entryToPublic(entry);
}

/**
 * Get a user's history, newest first.
 */
export async function getUserHistory(
  userId: string,
  limit = 30,
): Promise<HistoryEntryPublic[]> {
  const entries = await loadHistory();
  return entries
    .filter((e) => e.userId === userId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map(entryToPublic);
}

/**
 * Delete a history entry (only if it belongs to userId).
 * Returns true if deleted.
 */
export async function deleteHistoryEntry(
  userId: string,
  entryId: string,
): Promise<boolean> {
  const entries = await loadHistory();
  const idx = entries.findIndex(
    (e) => e.id === entryId && e.userId === userId,
  );
  if (idx === -1) return false;

  const [removed] = entries.splice(idx, 1);
  cache = entries;

  if (isPostgresEnabled()) {
    try {
      await pgDeleteEntry(entryId);
    } catch (pgErr) {
      logger.warn({ pgErr }, "[imageHistory] PG delete failed — JSON fallback");
      await persistHistory(entries);
    }
  } else {
    await persistHistory(entries);
  }

  // Delete image file (fire and forget — handles both Object Storage and disk)
  evictImageFile(removed);

  logger.info({ userId, entryId }, "[imageHistory] Deleted entry");
  return true;
}

// ── Pipeline stats snapshot (for admin Control Center) ────────────────────────

export interface HistoryStatsSnapshot {
  total:       number;
  byMode:      Record<string, number>;
  byIntensity: Record<string, number>;
  byStatus:    Record<string, number>;
  byType:      Record<string, number>;
  successRate: number;
  retryRate:   number;
  avgLatencyMs: number | null;
  topMode:     string | null;
  topIntensity: string | null;
}

/**
 * Compute read-only pipeline statistics from the in-memory cache.
 * Returns a zero-filled snapshot if no history is loaded yet.
 */
export function getHistoryStatsSnapshot(): HistoryStatsSnapshot {
  const entries: HistoryEntry[] = cache ?? [];

  const byMode:      Record<string, number> = {};
  const byIntensity: Record<string, number> = {};
  const byStatus:    Record<string, number> = {};
  const byType:      Record<string, number> = {};

  let latencySum = 0;
  let latencyCount = 0;
  let retryCount = 0;

  for (const e of entries) {
    byMode[e.mode]           = (byMode[e.mode]           ?? 0) + 1;
    byIntensity[e.intensity] = (byIntensity[e.intensity] ?? 0) + 1;
    byType[e.type]           = (byType[e.type]           ?? 0) + 1;
    if (e.status) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    if (e.latencyMs != null) { latencySum += e.latencyMs; latencyCount++; }
    if ((e.retryCount ?? 0) > 0) retryCount++;
  }

  const total = entries.length;
  const successCount = byStatus["success"] ?? 0;

  function topKey(map: Record<string, number>): string | null {
    const keys = Object.keys(map);
    if (!keys.length) return null;
    return keys.reduce((a, b) => map[a] > map[b] ? a : b);
  }

  return {
    total,
    byMode,
    byIntensity,
    byStatus,
    byType,
    successRate:  total > 0 ? Math.round((successCount / total) * 1000) / 10 : 0,
    retryRate:    total > 0 ? Math.round((retryCount  / total) * 1000) / 10 : 0,
    avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    topMode:      topKey(byMode),
    topIntensity: topKey(byIntensity),
  };
}

/**
 * Get the raw HistoryEntry for an image by ID.
 * Returns null if not found.
 */
export async function getImageEntry(entryId: string): Promise<HistoryEntry | null> {
  const entries = await loadHistory();
  return entries.find((e) => e.id === entryId) ?? null;
}

/**
 * Get the absolute file path for an image entry by ID.
 * Returns null if not found or if the entry uses Object Storage.
 * @deprecated Use getImageEntry() and check isObjectStorageKey() instead.
 */
export async function getImageFilePath(entryId: string): Promise<string | null> {
  const entry = await getImageEntry(entryId);
  if (!entry) return null;
  if (isObjectStorageKey(entry.imageFile)) return null; // Object Storage entries have no disk path
  return path.join(IMAGES_DIR, entry.imageFile);
}
