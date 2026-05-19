/**
 * migrationRunner — concurrency-safe JSON → PostgreSQL migration runner.
 *
 * Idempotent: safe to run multiple times (users: ON CONFLICT DO UPDATE,
 * history: ON CONFLICT DO NOTHING).
 * Concurrent runs are rejected — only one migration may run at a time.
 * Audit: writes start / complete / failed entries to adminActionLog.
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";
import { logAdminAction } from "./adminActionLog";
import { setLastMigrationRun } from "./systemConfig";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, "../../data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const HIST_FILE  = path.join(DATA_DIR, "image-history.json");

// ── Concurrency lock ──────────────────────────────────────────────────────────

let _running = false;

export function isMigrationRunning(): boolean { return _running; }

// ── Result types ──────────────────────────────────────────────────────────────

export interface MigrationResult {
  startedAt:  number;
  finishedAt: number;
  durationMs: number;
  users:   { ok: number; skipped: number; failed: number; total: number };
  history: { ok: number; skipped: number; failed: number; total: number };
  success: boolean;
  error?:  string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readJsonFile<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

// ── Core migration ────────────────────────────────────────────────────────────

export async function runMigration(actor: string): Promise<MigrationResult | null> {
  if (_running) return null; // concurrent guard
  _running = true;
  const startedAt = Date.now();

  await logAdminAction("migration_start", actor, { startedAt });
  logger.info({ actor }, "[migrationRunner] Migration started");

  const result: MigrationResult = {
    startedAt,
    finishedAt: 0,
    durationMs: 0,
    users:   { ok: 0, skipped: 0, failed: 0, total: 0 },
    history: { ok: 0, skipped: 0, failed: 0, total: 0 },
    success: false,
  };

  try {
    const { db, usersTable, imageHistoryTable } = await import("@workspace/db");

    // ── Users ──────────────────────────────────────────────────────────────────
    interface JsonUser {
      id?: string; username?: string; passwordHash?: string;
      role?: string; credits?: number; lastReset?: number; createdAt?: number;
    }
    const users = await readJsonFile<JsonUser>(USERS_FILE);
    result.users.total = users.length;

    for (const u of users) {
      if (!u.id || !u.username || !u.passwordHash) { result.users.skipped++; continue; }
      try {
        await db.insert(usersTable).values({
          id:           u.id,
          username:     u.username,
          passwordHash: u.passwordHash,
          role:         (u.role as "free" | "premium" | "ceo") ?? "free",
          credits:      u.credits   ?? 7,
          lastReset:    u.lastReset ?? Date.now(),
          createdAt:    u.createdAt ?? Date.now(),
        }).onConflictDoUpdate({
          target: usersTable.id,
          set: {
            username:     u.username,
            passwordHash: u.passwordHash,
            role:         (u.role as "free" | "premium" | "ceo") ?? "free",
            credits:      u.credits ?? 7,
            lastReset:    u.lastReset ?? Date.now(),
          },
        });
        result.users.ok++;
      } catch { result.users.failed++; }
    }

    // ── Image history ──────────────────────────────────────────────────────────
    interface JsonHistory {
      id?: string; userId?: string; type?: string; prompt?: string;
      mode?: string; intensity?: string; timestamp?: number;
      imageFile?: string; mimeType?: string;
      complexity?: string; contractVersionUsed?: string;
      model?: string; status?: string; retryCount?: number; latencyMs?: number;
    }
    const entries = await readJsonFile<JsonHistory>(HIST_FILE);
    result.history.total = entries.length;

    for (const e of entries) {
      if (!e.id || !e.userId || !e.imageFile) { result.history.skipped++; continue; }
      try {
        await db.insert(imageHistoryTable).values({
          id:                  e.id,
          userId:              e.userId,
          type:                (e.type as "generate" | "edit") ?? "generate",
          prompt:              e.prompt              ?? "",
          mode:                e.mode                ?? "standard",
          intensity:           e.intensity           ?? "MEDIUM",
          timestamp:           e.timestamp           ?? Date.now(),
          imageFile:           e.imageFile,
          mimeType:            e.mimeType            ?? "image/jpeg",
          complexity:          e.complexity          ?? null,
          contractVersionUsed: e.contractVersionUsed ?? null,
          model:               e.model               ?? null,
          status:              e.status              ?? null,
          retryCount:          e.retryCount          ?? null,
          latencyMs:           e.latencyMs           ?? null,
        }).onConflictDoNothing();
        result.history.ok++;
      } catch { result.history.failed++; }
    }

    result.success = true;
    const finishedAt = Date.now();
    result.finishedAt = finishedAt;
    result.durationMs = finishedAt - startedAt;
    await setLastMigrationRun(finishedAt);

    await logAdminAction("migration_complete", actor, {
      durationMs: result.durationMs,
      users:      result.users,
      history:    result.history,
    });
    logger.info({ durationMs: result.durationMs, users: result.users, history: result.history },
      "[migrationRunner] Migration complete");

  } catch (err) {
    result.finishedAt = Date.now();
    result.durationMs = result.finishedAt - startedAt;
    result.error = err instanceof Error ? err.message : String(err);
    await logAdminAction("migration_failed", actor, { error: result.error });
    logger.error({ err }, "[migrationRunner] Migration failed");
  } finally {
    _running = false;
  }

  return result;
}
