/**
 * Admin routes — IB AI Assistant CEO Dashboard
 *
 * ALL endpoints require: valid JWT + role === "ceo"
 *
 * GET   /api/admin/stats                      — system stats snapshot
 * GET   /api/admin/active-users              — users seen within last 5 minutes
 * GET   /api/admin/logs                      — recent audit log entries (?limit=50)
 * GET   /api/admin/health                    — uptime, memory, status flags
 * GET   /api/admin/users                     — full user directory (read-only, no passwords)
 * PATCH /api/admin/users/:userId/credits     — adjust user credits by delta (+/-)
 * PATCH /api/admin/users/:userId/role        — set user role (free | premium only)
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
import { getAllUsers, getUserById, adjustCredits, setUserRole } from "../lib/userStore";
import { getUserHistory } from "../services/imageHistoryStore";
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

// ── GET /api/admin/users/:userId/history ──────────────────────────────────────
// Returns the CEO view of a specific user's image generation history.
// Reuses getUserHistory() from imageHistoryStore — admin-only wrapper.

router.get("/admin/users/:userId/history", requireCeo, async (req: Request, res: Response) => {
  const userId = String(req.params["userId"]);
  const rawLimit = Number(req.query["limit"]) || 20;
  const limit = Math.max(1, Math.min(rawLimit, 50));

  const user = getUserById(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    const entries = await getUserHistory(userId, limit);
    res.json({ userId, username: user.username, entries, count: entries.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to load user history" });
  }
});

// ── PATCH /api/admin/users/:userId/credits ────────────────────────────────────
// Adjust a user's credit balance by delta. Positive = add, negative = deduct.
// CEO users are not modified. Credits floor at 0 (no negatives).

router.patch("/admin/users/:userId/credits", requireCeo, (req: Request, res: Response) => {
  const userId = String(req.params["userId"]);
  const { delta }  = req.body as { delta?: unknown };

  if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0) {
    res.status(400).json({ error: "delta must be a non-zero integer" });
    return;
  }
  if (Math.abs(delta) > 1_000) {
    res.status(400).json({ error: "delta must be between -1000 and 1000" });
    return;
  }

  const user = getUserById(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (user.role === "ceo") {
    res.status(400).json({ error: "CEO users have unlimited credits — no adjustment needed" });
    return;
  }

  try {
    const newCredits = adjustCredits(userId, delta);
    res.json({ userId, credits: newCredits, delta });
  } catch (err) {
    res.status(500).json({ error: "Failed to adjust credits" });
  }
});

// ── PATCH /api/admin/users/:userId/role ───────────────────────────────────────
// Set a user's role to "free" or "premium". Cannot demote/promote CEO.

router.patch("/admin/users/:userId/role", requireCeo, (req: Request, res: Response) => {
  const userId = String(req.params["userId"]);
  const { role }   = req.body as { role?: unknown };

  if (role !== "free" && role !== "premium") {
    res.status(400).json({ error: "role must be 'free' or 'premium'" });
    return;
  }

  const user = getUserById(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (user.role === "ceo") {
    res.status(403).json({ error: "Cannot change role of CEO account" });
    return;
  }

  setUserRole(userId, role);
  res.json({ userId, role });
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
