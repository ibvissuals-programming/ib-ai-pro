/**
 * adminSystem — System Control Center routes.
 *
 * ALL endpoints require: valid JWT + role === "ceo"
 *
 * GET  /api/admin/system/health    — extended system health + storage status
 * GET  /api/admin/pipeline/stats   — pipeline analytics from history cache
 * POST /api/admin/storage/mode     — change storage mode at runtime
 * POST /api/admin/storage/migrate  — run JSON → PG migration (concurrency-safe)
 * GET  /api/admin/action-logs      — admin control action audit log
 */
import { Router, type Request, type Response } from "express";
import { requireCeo } from "../middleware/requireCeo";
import {
  getStorageMode,
  setStorageMode,
  isPostgresEnabled,
  getLastMigrationRun,
  getSystemConfigSnapshot,
  type StorageMode,
} from "../lib/systemConfig";
import { logAdminAction, getAdminActionLog } from "../lib/adminActionLog";
import { runMigration, isMigrationRunning } from "../lib/migrationRunner";
import { getHistoryStatsSnapshot } from "../services/imageHistoryStore";
import { getAllUsers } from "../lib/userStore";
import { getActiveUsers, getTrackedUserCount } from "../lib/activityTracker";
import { getBootState } from "../lib/bootState";
import { isGeminiConfigured } from "../lib/geminiEnv";

const router = Router();

// ── Helper: get acting CEO username ──────────────────────────────────────────

function actorName(req: Request): string {
  const u = (req as Request & { user?: { username?: string } }).user;
  return u?.username ?? "ceo";
}

// ── GET /api/admin/system/health ──────────────────────────────────────────────

router.get("/admin/system/health", requireCeo, async (req: Request, res: Response) => {
  // ── DB connectivity check ─────────────────────────────────────────────────
  let dbStatus: "connected" | "disconnected" | "unchecked" = "unchecked";
  if (isPostgresEnabled()) {
    try {
      const { db } = await import("@workspace/db");
      await db.execute({ sql: "SELECT 1", params: [] } as never);
      dbStatus = "connected";
    } catch {
      dbStatus = "disconnected";
    }
  }

  // ── AI provider status ────────────────────────────────────────────────────
  const gemini = isGeminiConfigured() ? "active" : "missing";

  // ── Users ─────────────────────────────────────────────────────────────────
  const allUsers     = getAllUsers();
  const activeNow    = getActiveUsers().length;

  // ── Pipeline ──────────────────────────────────────────────────────────────
  const pipeline = getHistoryStatsSnapshot();

  // ── Memory ────────────────────────────────────────────────────────────────
  const mem = process.memoryUsage();

  res.json({
    timestamp: Date.now(),
    storage: {
      mode:             getStorageMode(),
      dbStatus,
      lastMigrationRun: getLastMigrationRun(),
      migrationRunning: isMigrationRunning(),
    },
    ai: { gemini },
    pipeline: {
      status:       pipeline.total > 0 ? "active" : "idle",
      totalImages:  pipeline.total,
      successRate:  pipeline.successRate,
      avgLatencyMs: pipeline.avgLatencyMs,
      retryRate:    pipeline.retryRate,
      topMode:      pipeline.topMode,
    },
    backend: {
      status:        getBootState() === "success" ? "operational" : "degraded",
      uptimeSeconds: Math.floor(process.uptime()),
      boot:          getBootState(),
      memory: {
        heapUsedMb:  Math.round(mem.heapUsed  / 1_048_576),
        heapTotalMb: Math.round(mem.heapTotal / 1_048_576),
        rssMb:       Math.round(mem.rss       / 1_048_576),
      },
    },
    users: {
      total:     allUsers.length,
      activeNow,
      tracked:   getTrackedUserCount(),
    },
  });
});

// ── GET /api/admin/pipeline/stats ─────────────────────────────────────────────

router.get("/admin/pipeline/stats", requireCeo, (_req: Request, res: Response) => {
  const snap = getHistoryStatsSnapshot();
  res.json({
    timestamp: Date.now(),
    ...snap,
  });
});

// ── POST /api/admin/storage/mode ──────────────────────────────────────────────

const VALID_MODES: StorageMode[] = ["json", "postgres", "hybrid"];

router.post("/admin/storage/mode", requireCeo, async (req: Request, res: Response) => {
  const { mode } = req.body as { mode?: unknown };

  if (!mode || !VALID_MODES.includes(mode as StorageMode)) {
    res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(", ")}` });
    return;
  }

  const prevMode = getStorageMode();
  await setStorageMode(mode as StorageMode);

  await logAdminAction("storage_mode_change", actorName(req), {
    from: prevMode,
    to:   mode,
  });

  res.json({
    ok:        true,
    mode:      getStorageMode(),
    updatedAt: Date.now(),
    message:   `Storage mode changed from ${prevMode} → ${mode}`,
  });
});

// ── POST /api/admin/storage/migrate ──────────────────────────────────────────

router.post("/admin/storage/migrate", requireCeo, async (req: Request, res: Response) => {
  if (isMigrationRunning()) {
    res.status(409).json({
      ok:     false,
      status: "already_running",
      error:  "A migration is already in progress — please wait for it to finish.",
    });
    return;
  }

  const actor = actorName(req);

  // Run migration asynchronously so the HTTP response returns immediately,
  // then the client can poll /admin/system/health to see migrationRunning status.
  runMigration(actor).catch((err) => {
    logAdminAction("admin_error", actor, {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  });

  res.json({
    ok:      true,
    status:  "started",
    message: "Migration started — poll /api/admin/system/health for status.",
  });
});

// ── GET /api/admin/action-logs ────────────────────────────────────────────────

router.get("/admin/action-logs", requireCeo, (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query["limit"]) || 50, 200);
  const entries = getAdminActionLog(limit);
  res.json({ count: entries.length, entries });
});

export default router;
