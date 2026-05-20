/**
 * health.ts — IB AI Assistant
 *
 * GET /health   — full system health check
 * GET /healthz  — Kubernetes-style alias
 *
 * Response sections:
 *   checks.postgres       — DB connectivity
 *   checks.objectStorage  — object storage (when enabled)
 *   checks.queue          — image job queue metrics (in-memory, synchronous)
 *   checks.provider       — AI provider status (in-memory, synchronous)
 *   checks.storage        — storage mode summary (in-memory, synchronous)
 *
 * Rules:
 *   - Never throws — always returns JSON
 *   - DB check is async but bounded (SELECT 1 with implicit timeout)
 *   - Queue, provider, and storage sections are synchronous (no blocking)
 *   - Degraded = any check returns ok: false
 */
import { Router, type IRouter } from "express";
import { getBootState }                      from "../lib/bootState";
import { isPostgresEnabled }                  from "../lib/systemConfig";
import { checkObjectStorageHealth, isObjectStorageEnabled } from "../services/objectStore";
import { imageQueue }                         from "../services/imageQueue";
import { getJobMetrics }                      from "../services/imageJobManager";
import { getAiStatus }                        from "../lib/aiMetrics";

const router: IRouter = Router();

router.get(["/health", "/healthz"], async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let degraded = false;

  // ── PostgreSQL ────────────────────────────────────────────────────────────
  if (isPostgresEnabled()) {
    try {
      const { pool } = await import("@workspace/db");
      const t0 = Date.now();
      await pool.query("SELECT 1");
      checks["postgres"] = { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      checks["postgres"] = {
        ok:    false,
        error: err instanceof Error ? err.message : String(err),
      };
      degraded = true;
    }
  }

  // ── Object Storage ────────────────────────────────────────────────────────
  if (isObjectStorageEnabled()) {
    try {
      const result = await checkObjectStorageHealth();
      checks["objectStorage"] = result;
      if (!result.ok) degraded = true;
    } catch (err) {
      checks["objectStorage"] = {
        ok:    false,
        error: err instanceof Error ? err.message : String(err),
      };
      degraded = true;
    }
  }

  // ── Image Queue (synchronous — in-memory) ─────────────────────────────────
  try {
    const qm  = imageQueue.getMetrics();
    const jm  = getJobMetrics();
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

  // ── AI Provider Status (synchronous — in-memory) ──────────────────────────
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
      successRateGroq:   ai.successRateGroq,
      successRateGemini: ai.successRateGemini,
    };
  } catch {
    checks["provider"] = { ok: false };
  }

  // ── Storage Mode (synchronous — in-memory) ────────────────────────────────
  checks["storage"] = {
    ok:                   true,
    postgresEnabled:      isPostgresEnabled(),
    objectStorageEnabled: isObjectStorageEnabled(),
  };

  // ── AI Systems (synchronous — in-memory, non-blocking) ────────────────────
  // Reports readiness of each AI subsystem without making any external calls.
  let systemsDegraded = false;
  try {
    const aiSt     = getAiStatus();
    const geminiOk = aiSt.geminiAvailable;
    if (!geminiOk) systemsDegraded = true;
    checks["systems"] = {
      image:  { ok: geminiOk, description: "Image generation & editing pipeline" },
      tts:    { ok: geminiOk, description: "Text-to-Speech — Gemini 2.0 Flash" },
      video:  { ok: true,      description: "Image-to-Video — provider-ready infrastructure" },
      prompt: { ok: geminiOk, description: "Smart Prompt Expansion — Gemini 2.5 Flash" },
    };
  } catch {
    systemsDegraded = true;
    checks["systems"] = {
      image:  { ok: false },
      tts:    { ok: false },
      video:  { ok: false },
      prompt: { ok: false },
    };
  }

  const bootState = getBootState();
  const bootField = bootState === "degraded" ? "degraded" : "success";

  res.json({
    status:   (degraded || systemsDegraded) ? "degraded" : "ok",
    boot:     bootField,
    uptime:   Math.floor(process.uptime()),
    mode:     "full",
    systems:  checks["systems"],
    queue:    checks["queue"]    ?? { ok: false },
    storage:  checks["storage"]  ?? { ok: false },
    database: checks["postgres"] ?? { ok: true, note: "postgres not enabled" },
    checks,
  });
});

export default router;
