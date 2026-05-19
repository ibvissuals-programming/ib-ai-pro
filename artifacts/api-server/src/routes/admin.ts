/**
 * Admin routes — IB AI Assistant CEO Dashboard
 *
 * ALL endpoints require: valid JWT + role === "ceo"
 *
 * GET /api/admin/stats          — system stats snapshot
 * GET /api/admin/active-users   — users seen within last 5 minutes
 * GET /api/admin/logs           — recent audit log entries (?limit=50)
 * GET /api/admin/health         — uptime, memory, status flags
 * GET /api/admin/users          — full user directory (read-only, no passwords)
 */
import { Router, type Request, type Response } from "express";
import { requireCeo } from "../middleware/requireCeo";
import { getAuditLog, getAuditLogSize } from "../lib/auditLog";
import {
  getTodayStats,
  getTotalLoginsToday,
  getTotalImagesGeneratedToday,
  getTotalErrorsToday,
} from "../lib/statsCounter";
import {
  getActiveUsers,
  getAllActivity,
  getTrackedUserCount,
  ACTIVE_THRESHOLD_MS,
} from "../lib/activityTracker";
import { getAllUsers } from "../lib/userStore";
import { getBootState } from "../lib/bootState";
import { getRenderTelemetry, getRenderTelemetryStats, type RenderTelemetryEntry } from "../lib/renderTelemetry";

const router = Router();

// ── GET /api/admin/stats ──────────────────────────────────────────────────────

router.get("/admin/stats", requireCeo, (_req: Request, res: Response) => {
  const stats = getTodayStats();
  const boot  = getBootState();

  res.json({
    timestamp: Date.now(),
    today: {
      totalLoginsToday:          getTotalLoginsToday(),
      totalImagesGeneratedToday: getTotalImagesGeneratedToday(),
      totalErrorsToday:          getTotalErrorsToday(),
      breakdown: {
        loginSuccess:        stats.loginSuccess,
        loginFailure:        stats.loginFailure,
        signupSuccess:       stats.signupSuccess,
        signupFailure:       stats.signupFailure,
        imageGenerated:      stats.imageGenerated,
        imageGenerateFailed: stats.imageGenerateFailed,
        imageEdited:         stats.imageEdited,
        imageEditFailed:     stats.imageEditFailed,
        imageAnalyzed:       stats.imageAnalyzed,
        imageAnalysisFailed: stats.imageAnalysisFailed,
        systemErrors:        stats.systemErrors,
        authErrors:          stats.authErrors,
      },
    },
    users: {
      trackedSinceStart: getTrackedUserCount(),
      activeNow:         getActiveUsers().length,
    },
    system: {
      backendStatus:       boot,
      imagePipelineStatus: boot === "success" ? "operational" : "degraded",
      authStatus:          boot === "success" ? "operational" : "degraded",
    },
    auditLog: {
      totalEntries: getAuditLogSize(),
    },
  });
});

// ── GET /api/admin/active-users ───────────────────────────────────────────────

router.get("/admin/active-users", requireCeo, (_req: Request, res: Response) => {
  const active = getActiveUsers(ACTIVE_THRESHOLD_MS);

  res.json({
    timestamp: Date.now(),
    thresholdMs: ACTIVE_THRESHOLD_MS,
    count: active.length,
    users: active.map((u) => ({
      userId:      u.userId,
      username:    u.username,
      role:        u.role,
      lastSeenAt:  u.lastSeenAt,
      lastLoginAt: u.lastLoginAt,
    })),
  });
});

// ── GET /api/admin/logs ───────────────────────────────────────────────────────

router.get("/admin/logs", requireCeo, (req: Request, res: Response) => {
  const rawLimit = Number(req.query["limit"]) || 50;
  const limit    = Math.max(1, Math.min(rawLimit, 500));
  const entries  = getAuditLog(limit);

  res.json({
    timestamp: Date.now(),
    limit,
    count: entries.length,
    entries,
  });
});

// ── GET /api/admin/health ─────────────────────────────────────────────────────

router.get("/admin/health", requireCeo, (_req: Request, res: Response) => {
  const mem  = process.memoryUsage();
  const boot = getBootState();

  res.json({
    timestamp:   Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      heapUsedMb:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb:       Math.round(mem.rss       / 1024 / 1024),
      externalMb:  Math.round(mem.external  / 1024 / 1024),
    },
    activeUsers: getActiveUsers().length,
    status: {
      boot,
      backend:       boot === "success" ? "operational" : "degraded",
      imagePipeline: boot === "success" ? "operational" : "degraded",
      auth:          boot === "success" ? "operational" : "degraded",
    },
    auditLogEntries: getAuditLogSize(),
  });
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
// Read-only user directory. No passwords, no secrets.
// Merges userStore records with in-memory activity data to produce status fields.

router.get("/admin/users", requireCeo, (_req: Request, res: Response) => {
  const users      = getAllUsers();
  const activityMap = new Map(getAllActivity().map((a) => [a.userId, a]));
  const now         = Date.now();

  const result = users
    .map((u) => {
      const act         = activityMap.get(u.id);
      const lastSeenAt  = act?.lastSeenAt  ?? null;
      const lastLoginAt = act?.lastLoginAt ?? null;
      const isActive    = lastSeenAt != null && (now - lastSeenAt) < ACTIVE_THRESHOLD_MS;

      return {
        id:          u.id,
        username:    u.username,
        role:        u.role,
        credits:     u.credits,
        createdAt:   u.createdAt,
        lastLoginAt,
        lastSeenAt,
        status:      isActive ? "active" : "inactive",
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt); // newest first

  res.json({
    timestamp: Date.now(),
    count:     result.length,
    users:     result,
  });
});

// ── GET /api/admin/render-analytics ──────────────────────────────────────────
// Returns in-memory render telemetry: aggregate stats + recent entries.
// Data is lost on restart — telemetry is ephemeral, not persisted.

router.get("/admin/render-analytics", requireCeo, (req: Request, res: Response) => {
  const rawLimit = Number(req.query["limit"]) || 50;
  const limit    = Math.max(1, Math.min(rawLimit, 200));

  res.json({
    timestamp: Date.now(),
    stats:     getRenderTelemetryStats(),
    entries:   getRenderTelemetry(limit),
  });
});

// ── GET /api/admin/cinematic-insights ─────────────────────────────────────────
// Cinematic Prompt Engine analytics: total edits, most used styles,
// average processing time, success rate, last 20 edits.
// Shapes telemetry data into the spec-required format.

router.get("/admin/cinematic-insights", requireCeo, (_req: Request, res: Response) => {
  const stats   = getRenderTelemetryStats();
  const entries = getRenderTelemetry(200);

  // Most used styles — sort profile distribution descending
  const mostUsedStyles = Object.entries(stats.profileDistribution ?? {})
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .map(([style, count]) => ({ style, count }));

  // Last 20 edits — shape into concise per-edit records
  const last20 = entries.slice(0, 20).map((e: RenderTelemetryEntry) => ({
    id:                   e.id,
    timestamp:            e.timestamp,
    renderProfile:        e.renderProfile,
    intensity:            e.intensity,
    processingDurationMs: e.processingDurationMs,
    verifierOutcome:      e.verifierOutcome,
    retryCount:           e.retryCount,
    cinematicAnalysisUsed: e.cinematicAnalysisUsed ?? false,
    promptUsed:           e.promptUsed
      ? e.promptUsed.slice(0, 120) + (e.promptUsed.length > 120 ? "…" : "")
      : undefined,
  }));

  res.json({
    timestamp:           Date.now(),
    totalEdits:          stats.total,
    averageProcessingMs: stats.avgDurationMs,
    successRate:         stats.passRate,
    retryRate:           stats.retryRate,
    mostUsedStyles,
    cinematicAnalysisEdits: entries.filter((e: RenderTelemetryEntry) => e.cinematicAnalysisUsed).length,
    last20Edits:         last20,
  });
});

export default router;
