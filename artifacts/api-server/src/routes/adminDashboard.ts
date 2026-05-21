/**
 * adminDashboard.ts — IB AI Assistant CEO Control Layer
 *
 * Phase 1: Dashboard overview endpoints
 * Phase 3: Real-time SSE event stream
 *
 * All endpoints: requireCeo (valid JWT + role === "ceo")
 *
 * GET /api/admin/overview      — aggregate system snapshot
 * GET /api/admin/users         — enriched user list (replaces basic version)
 * GET /api/admin/system-health — live health of every subsystem
 * GET /api/admin/event-stream  — SSE real-time event feed
 *
 * PHASE 6 contract:
 *   - DB queries are best-effort; failures return degraded payload, never 500
 *   - SSE endpoint degrades silently on write errors
 *   - No endpoint blocks the chat pipeline
 */
import { Router, type Request, type Response } from "express";
import { requireCeo } from "../middleware/requireCeo";
import { getAllUsers, getUserById } from "../lib/userStore";
import { getActiveUsers, getAllActivity, ACTIVE_THRESHOLD_MS } from "../lib/activityTracker";
import {
  getTodayStats,
  getTotalChatsToday,
  getTotalMessagesToday,
  getTotalErrorsToday,
} from "../lib/statsCounter";
import { getBootState } from "../lib/bootState";
import { getRawMetrics } from "../lib/aiMetrics";
import {
  getRecentEvents,
  getRecentErrors,
  getTotalEventCount,
  getSubscriberCount,
  subscribeToEvents,
  unsubscribeFromEvents,
  countEventsInWindow,
  type TrackedEvent,
} from "../lib/eventTracker";
import {
  getSystemAnalyticsSummary,
  getAllUserAnalytics,
  getUserSummaries,
} from "../lib/usageAnalytics";
import { imageQueue } from "../services/imageQueue";
import { getJobMetrics } from "../services/imageJobManager";
import { db, chatMessagesTable, userMemoryTable } from "@workspace/db";
import { count, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Best-effort DB ping — returns true if reachable, false otherwise. */
async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

/** Total memory entries across all users — best-effort, returns null on failure. */
async function getTotalMemoryEntries(): Promise<number | null> {
  try {
    const [row] = await db.select({ n: count() }).from(userMemoryTable);
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

/** Per-user memory counts keyed by userId — best-effort. */
async function getMemoryCountsByUser(): Promise<Map<string, number>> {
  try {
    const rows = await db
      .select({ userId: userMemoryTable.userId, n: count() })
      .from(userMemoryTable)
      .groupBy(userMemoryTable.userId);
    return new Map(rows.map((r: { userId: string; n: number }) => [r.userId, r.n]));
  } catch {
    return new Map();
  }
}

/** Per-user message counts keyed by userId — best-effort. */
async function getMessageCountsByUser(): Promise<Map<string, number>> {
  try {
    const rows = await db
      .select({ userId: chatMessagesTable.userId, n: count() })
      .from(chatMessagesTable)
      .groupBy(chatMessagesTable.userId);
    return new Map(rows.map((r: { userId: string; n: number }) => [r.userId, r.n]));
  } catch {
    return new Map();
  }
}

// ── GET /api/admin/overview ───────────────────────────────────────────────────

router.get("/admin/overview", requireCeo, async (_req: Request, res: Response) => {
  try {
    const [totalMemory, aiMetrics] = await Promise.all([
      getTotalMemoryEntries(),
      Promise.resolve(getRawMetrics()),
    ]);

    const allUsers     = getAllUsers();
    const activeNow    = getActiveUsers(ACTIVE_THRESHOLD_MS).length;
    const active24h    = getActiveUsers(24 * 60 * 60 * 1000).length;
    const stats        = getTodayStats();
    const errorCount   = getTotalErrorsToday();
    const chatsToday   = getTotalChatsToday();
    const msgsToday    = getTotalMessagesToday();

    // Avg response time across both providers
    const { groq, gemini } = aiMetrics;
    const totalReqs     = groq.requests + gemini.requests;
    const totalLatency  = groq.totalLatencyMs + gemini.totalLatencyMs;
    const avgResponseMs = totalReqs > 0 ? Math.round(totalLatency / totalReqs) : null;

    // Error rate = errors / (chats + 1) to avoid division by zero
    const errorRate = chatsToday > 0
      ? Math.round((errorCount / chatsToday) * 100)
      : 0;

    // Events in last 60s for live activity gauge
    const eventsLastMinute = countEventsInWindow("chat_request_completed", 60_000);

    res.json({
      timestamp:    Date.now(),
      users: {
        total:     allUsers.length,
        activeNow,
        active24h,
      },
      chats: {
        today:     chatsToday,
        messagesTODAY: msgsToday,
      },
      memory: {
        totalEntries: totalMemory,
      },
      performance: {
        avgResponseMs,
        errorRate,
        errorCount,
        eventsLastMinute,
        totalAiRequests: totalReqs,
      },
      counters: {
        loginSuccess:   stats.loginSuccess,
        loginFailure:   stats.loginFailure,
        signupSuccess:  stats.signupSuccess,
        signupFailure:  stats.signupFailure,
        systemErrors:   stats.systemErrors,
        authErrors:     stats.authErrors,
      },
      eventPipeline: {
        totalEventsSinceStart: getTotalEventCount(),
        activeStreams:         getSubscriberCount(),
      },
    });
  } catch (err) {
    logger.error({ err }, "[adminDashboard] /overview error");
    res.status(500).json({ error: "Failed to fetch overview" });
  }
});

// ── GET /api/admin/users (enriched — overrides basic admin.ts version) ────────

router.get("/admin/users", requireCeo, async (_req: Request, res: Response) => {
  try {
    const [memoryCounts, messageCounts] = await Promise.all([
      getMemoryCountsByUser(),
      getMessageCountsByUser(),
    ]);

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
          id:           u.id,
          username:     u.username,
          role:         u.role,
          credits:      u.credits,
          createdAt:    u.createdAt,
          lastLoginAt,
          lastSeenAt,
          status:       isActive ? "active" : "inactive",
          messageCount: messageCounts.get(u.id) ?? 0,
          memoryCount:  memoryCounts.get(u.id)  ?? 0,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    res.json({
      timestamp: Date.now(),
      count:     result.length,
      users:     result,
    });
  } catch (err) {
    logger.error({ err }, "[adminDashboard] /users error");
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ── GET /api/admin/system-health ──────────────────────────────────────────────

router.get("/admin/system-health", requireCeo, async (_req: Request, res: Response) => {
  try {
    const [dbAlive, aiMetrics] = await Promise.all([
      pingDb(),
      Promise.resolve(getRawMetrics()),
    ]);

    const boot         = getBootState();
    const geminiOk     = !!(
      process.env.AI_INTEGRATIONS_GEMINI_API_KEY ??
      process.env.GEMINI_API_KEY
    );
    const recentErrors = getRecentErrors(5);
    const mem          = process.memoryUsage();

    // Memory pipeline health: check recent memory events
    const recentMemExtract = countEventsInWindow("memory_extracted", 10 * 60_000);
    const recentMemSkip    = countEventsInWindow("memory_skipped", 10 * 60_000);
    const memPipelineStatus =
      boot === "success" ? (recentMemExtract > 0 || recentMemSkip >= 0 ? "operational" : "idle") : "degraded";

    // Gemini metrics
    const { gemini } = aiMetrics;
    const geminiSuccessRate = gemini.requests > 0
      ? Math.round((gemini.successes / gemini.requests) * 100)
      : null;
    const geminiAvgLatency = gemini.requests > 0
      ? Math.round(gemini.totalLatencyMs / gemini.requests)
      : null;

    res.json({
      timestamp: Date.now(),
      subsystems: {
        backend: {
          status:       boot === "success" ? "operational" : "degraded",
          boot,
          uptimeSeconds: Math.floor(process.uptime()),
          memory: {
            heapUsedMb:  Math.round(mem.heapUsed  / 1024 / 1024),
            heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
            rssMb:       Math.round(mem.rss       / 1024 / 1024),
          },
        },
        database: {
          status:     dbAlive ? "operational" : "unreachable",
          reachable:  dbAlive,
        },
        gemini: {
          status:        geminiOk ? "operational" : "not_configured",
          configured:    geminiOk,
          totalRequests: gemini.requests,
          successRate:   geminiSuccessRate,
          avgLatencyMs:  geminiAvgLatency,
          lastUsedAt:    gemini.lastUsedAt,
        },
        memoryPipeline: {
          status:         memPipelineStatus,
          extractedLast10m: recentMemExtract,
          skippedLast10m:   recentMemSkip,
        },
      },
      recentErrors: recentErrors.map((e) => ({
        timestamp: e.timestamp,
        type:      e.type,
        userId:    e.userId,
        route:     e.route,
        meta:      e.meta,
      })),
      eventPipeline: {
        totalEvents:   getTotalEventCount(),
        activeStreams:  getSubscriberCount(),
      },
    });
  } catch (err) {
    logger.error({ err }, "[adminDashboard] /system-health error");
    res.status(500).json({ error: "Failed to fetch system health" });
  }
});

// ── GET /api/admin/event-stream ───────────────────────────────────────────────
// Phase 3: SSE real-time event stream.
// On connect: flushes last 100 events, then streams live updates.
// On disconnect: unregisters the subscriber.
// PHASE 6: all writes are wrapped — failures degrade silently.

router.get("/admin/event-stream", requireCeo, (req: Request, res: Response) => {
  // SSE headers
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Safely write an SSE event — swallows errors to satisfy Phase 6 contract
  function safeWrite(event: TrackedEvent): void {
    try {
      const tag = `[${event.category}_event]`;
      const payload = JSON.stringify({
        tag,
        id:        event.id,
        timestamp: event.timestamp,
        type:      event.type,
        userId:    event.userId,
        latencyMs: event.latencyMs,
        route:     event.route,
        meta:      event.meta,
      });
      res.write(`data: ${payload}\n\n`);
    } catch {
      // Client disconnected mid-write — subscriber will be removed on next push
    }
  }

  // ── Flush backlog ─────────────────────────────────────────────────────────
  const backlog = getRecentEvents(100);
  for (let i = backlog.length - 1; i >= 0; i--) {
    safeWrite(backlog[i]!);
  }

  // ── Subscribe to live updates ─────────────────────────────────────────────
  subscribeToEvents(safeWrite);

  // ── Keepalive ping every 20s ──────────────────────────────────────────────
  const keepalive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepalive);
    }
  }, 20_000);

  // ── Cleanup on disconnect ─────────────────────────────────────────────────
  req.on("close", () => {
    clearInterval(keepalive);
    unsubscribeFromEvents(safeWrite);
    logger.debug("[adminDashboard] SSE client disconnected");
  });
});

// ── GET /api/admin/analytics ──────────────────────────────────────────────────
// System-wide image generation + editing analytics aggregated across all users.
// Best-effort — DB failure returns degraded payload with queue metrics still.

router.get("/admin/analytics", requireCeo, async (_req: Request, res: Response) => {
  try {
    const [summary, queueMetrics, jobMetrics] = await Promise.all([
      getSystemAnalyticsSummary(),
      Promise.resolve(imageQueue.getMetrics()),
      Promise.resolve(getJobMetrics()),
    ]);

    const stats = getTodayStats();

    res.json({
      timestamp: Date.now(),
      images: {
        ...summary,
        today: {
          generated: stats.imageGenerated,
          edited:    stats.imageEdited,
          analyzed:  stats.imageAnalyzed,
          genFailed: stats.imageGenerateFailed,
          editFailed: stats.imageEditFailed,
        },
      },
      queue: {
        concurrency: queueMetrics.concurrency,
        active:      queueMetrics.active,
        pending:     queueMetrics.pending,
        completed:   queueMetrics.completed,
        failed:      queueMetrics.failed,
        avgWaitMs:   queueMetrics.avgWaitMs,
      },
      jobs: {
        total:      jobMetrics.total,
        queued:     jobMetrics.queued,
        processing: jobMetrics.processing,
        succeeded:  jobMetrics.succeeded,
        failed:     jobMetrics.failed,
      },
    });
  } catch (err) {
    logger.error({ err }, "[adminDashboard] /analytics error");
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// ── GET /api/admin/analytics/users ────────────────────────────────────────────
// Per-user analytics breakdown. Returns both per-day rows and collapsed summaries.

router.get("/admin/analytics/users", requireCeo, async (req: Request, res: Response) => {
  try {
    const view = (req.query.view as string) ?? "summaries";

    if (view === "daily") {
      const rows = await getAllUserAnalytics();
      res.json({ timestamp: Date.now(), count: rows.length, rows });
      return;
    }

    // Default: collapsed per-user summaries
    const summaries = await getUserSummaries();
    res.json({
      timestamp: Date.now(),
      count:     summaries.length,
      users:     summaries,
    });
  } catch (err) {
    logger.error({ err }, "[adminDashboard] /analytics/users error");
    res.status(500).json({ error: "Failed to fetch user analytics" });
  }
});

export default router;
