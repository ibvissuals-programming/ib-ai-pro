/**
 * generationHistoryStore.ts — IB AI Assistant
 *
 * Lightweight JSON-backed history store for TTS and Video generations.
 * Persists across sessions without requiring new DB tables.
 *
 * Architecture:
 *   - One JSON file per tool: data/tts-history.json, data/video-history.json
 *   - Max 20 entries per user, 100 total
 *   - Write mutex prevents concurrent corruption
 *   - TTL: entries older than 7 days auto-purged on write
 *   - Audio/video files served separately via existing serve endpoints
 */

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, "../../data");

const MAX_PER_USER = 20;
const MAX_TOTAL    = 100;
const TTL_MS       = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TtsHistoryEntry {
  id:          string;
  userId:      string;
  type:        "tts";
  text:        string;          // truncated to 300 chars
  voiceStyle:  string;
  voiceLabel:  string;
  jobId:       string;
  audioUrl:    string;          // /api/tts/serve/:jobId
  durationMs:  number;
  textLength:  number;
  timestamp:   number;
}

export interface VideoHistoryEntry {
  id:           string;
  userId:       string;
  type:         "video";
  prompt:       string;         // truncated to 300 chars
  mode:         string;
  jobId:        string;
  videoUrl:     string | null;  // /api/video/serve/:jobId — null when no file was written
  status:       "completed" | "failed" | "provider_not_configured";
  thumbnailB64: string | null;  // base64 JPEG thumbnail from source image
  timestamp:    number;
}

export type GenerationHistoryEntry = TtsHistoryEntry | VideoHistoryEntry;

// ── Write mutex ───────────────────────────────────────────────────────────────

const chains: Record<string, Promise<void>> = {
  tts:   Promise.resolve(),
  video: Promise.resolve(),
};

function withMutex(tool: "tts" | "video", fn: () => Promise<void>): Promise<void> {
  const next = (chains[tool] ?? Promise.resolve()).then(fn).catch((err) => {
    logger.error({ err, tool }, "[genHistory] mutex error");
  });
  chains[tool] = next;
  return next;
}

// ── File helpers ───────────────────────────────────────────────────────────────

function filePath(tool: "tts" | "video"): string {
  return path.join(DATA_DIR, `${tool}-history.json`);
}

async function loadAll(tool: "tts" | "video"): Promise<GenerationHistoryEntry[]> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(filePath(tool), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAll(tool: "tts" | "video", entries: GenerationHistoryEntry[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(filePath(tool), JSON.stringify(entries, null, 2), "utf8");
}

// ── TTL cleanup ────────────────────────────────────────────────────────────────

function purgeOld(entries: GenerationHistoryEntry[]): GenerationHistoryEntry[] {
  const cutoff = Date.now() - TTL_MS;
  return entries.filter((e) => e.timestamp > cutoff);
}

// ── Trim to limits ─────────────────────────────────────────────────────────────

function trimEntries(entries: GenerationHistoryEntry[], userId: string): GenerationHistoryEntry[] {
  // Enforce per-user limit
  const userEntries    = entries.filter((e) => e.userId === userId);
  const otherEntries   = entries.filter((e) => e.userId !== userId);
  const trimmedUser    = userEntries.slice(0, MAX_PER_USER);
  const combined       = [...trimmedUser, ...otherEntries];
  // Enforce global total (newest first)
  return combined.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_TOTAL);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Save a TTS generation record. Fire-and-forget safe. */
export function saveTtsHistory(entry: Omit<TtsHistoryEntry, "id">): void {
  withMutex("tts", async () => {
    const all = await loadAll("tts");
    const purged = purgeOld(all);
    const record: TtsHistoryEntry = { ...entry, id: randomUUID() };
    const updated = trimEntries([record, ...purged], entry.userId);
    await saveAll("tts", updated);
  }).catch(() => {});
}

/** Save a Video generation record. Fire-and-forget safe. */
export function saveVideoHistory(entry: Omit<VideoHistoryEntry, "id">): void {
  withMutex("video", async () => {
    const all = await loadAll("video");
    const purged = purgeOld(all);
    const record: VideoHistoryEntry = { ...entry, id: randomUUID() };
    const updated = trimEntries([record, ...purged], entry.userId);
    await saveAll("video", updated);
  }).catch(() => {});
}

/** Get TTS history for a specific user (newest first, max 20). */
export async function getTtsHistory(userId: string): Promise<TtsHistoryEntry[]> {
  const all = await loadAll("tts");
  return (all as TtsHistoryEntry[])
    .filter((e) => e.userId === userId && e.timestamp > Date.now() - TTL_MS)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_PER_USER);
}

/** Get Video history for a specific user (newest first, max 20). */
export async function getVideoHistory(userId: string): Promise<VideoHistoryEntry[]> {
  const all = await loadAll("video");
  return (all as VideoHistoryEntry[])
    .filter((e) => e.userId === userId && e.timestamp > Date.now() - TTL_MS)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_PER_USER);
}

/** Total counts across all users — for CEO analytics. */
export async function getGenerationHistoryCounts(): Promise<{ tts: number; video: number }> {
  const [ttsAll, videoAll] = await Promise.all([loadAll("tts"), loadAll("video")]);
  const cutoff = Date.now() - TTL_MS;
  return {
    tts:   ttsAll.filter((e) => e.timestamp > cutoff).length,
    video: videoAll.filter((e) => e.timestamp > cutoff).length,
  };
}
