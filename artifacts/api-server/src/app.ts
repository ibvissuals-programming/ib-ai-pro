import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getBootState } from "./lib/bootState";
import { isPostgresEnabled } from "./lib/systemConfig";
import { checkObjectStorageHealth, isObjectStorageEnabled } from "./services/objectStore";
import { imageQueue } from "./services/imageQueue";
import { getJobMetrics } from "./services/imageJobManager";
import { getAiStatus } from "./lib/aiMetrics";
import { pool } from "@workspace/db";

const app: Express = express();

// Trust the first hop (Replit's reverse proxy) so req.ip returns the real
// client IP instead of the proxy address — required for rate limiting.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Raise JSON body limit to 8 MB to accommodate base64 image payloads sent
// to /api/analyze-image. Default of 100 kb causes 413 on any real image.
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

// ── LAYER 6: Root health check — always responds, never behind /api ───────────
// Probes PostgreSQL and Object Storage on each request so monitors and
// deployment health checks get an accurate connectivity report.
// Also exposes in-memory queue, provider, and storage status (synchronous).
app.get(["/health", "/healthz"], async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let degraded = false;

  // PostgreSQL (async, bounded)
  if (isPostgresEnabled()) {
    try {
      const t0 = Date.now();
      await pool.query("SELECT 1");
      checks["postgres"] = { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      checks["postgres"] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      degraded = true;
    }
  }

  // Object Storage (async, bounded)
  if (isObjectStorageEnabled()) {
    try {
      const result = await checkObjectStorageHealth();
      checks["objectStorage"] = result;
      if (!result.ok) degraded = true;
    } catch (err) {
      checks["objectStorage"] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      degraded = true;
    }
  }

  // Image Queue (synchronous — in-memory)
  try {
    const qm = imageQueue.getMetrics();
    const jm = getJobMetrics();
    checks["queue"] = {
      ok:          true,
      concurrency: qm.concurrency,
      active:      qm.active,
      pending:     qm.pending,
      completed:   qm.completed,
      failed:      qm.failed,
      avgWaitMs:   qm.avgWaitMs,
      jobs: {
        total:      jm.total,
        queued:     jm.queued,
        processing: jm.processing,
        succeeded:  jm.succeeded,
        failed:     jm.failed,
      },
    };
  } catch {
    checks["queue"] = { ok: false };
  }

  // AI Provider Status (synchronous — in-memory)
  try {
    const ai = getAiStatus();
    checks["provider"] = {
      ok:               true,
      activeProvider:   ai.activeProvider,
      geminiConfigured: ai.geminiAvailable,
      groqConfigured:   ai.groqAvailable,
      totalRequests:    ai.totalRequests,
      fallbackCount:    ai.fallbackCount,
      avgLatencyGemini: ai.avgLatencyGemini,
      avgLatencyGroq:   ai.avgLatencyGroq,
    };
  } catch {
    checks["provider"] = { ok: false };
  }

  // Storage Mode (synchronous — in-memory)
  checks["storage"] = {
    ok:                   true,
    postgresEnabled:      isPostgresEnabled(),
    objectStorageEnabled: isObjectStorageEnabled(),
  };

  res.json({
    status: degraded ? "degraded" : "ok",
    uptime: Math.floor(process.uptime()),
    boot:   getBootState(),
    mode:   "full",
    checks,
  });
});

app.use("/api", router);

// ── Global JSON error handler ─────────────────────────────────────────────────
// Catches body-parser SyntaxErrors (malformed request JSON) and any other
// unhandled errors. Ensures every error response is valid JSON — never HTML.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: NextFunction): void => {
  // body-parser signals JSON parse failures with type "entity.parse.failed"
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    logger.warn({ err: err.message }, "[app] malformed JSON body rejected");
    res.status(400).json({ error: "Invalid JSON in request body" });
    return;
  }

  const status = err.status ?? err.statusCode ?? 500;
  logger.error({ err: err.message, status }, "[app] unhandled error");
  res.status(status).json({ error: err.message || "Internal server error" });
});

export default app;
