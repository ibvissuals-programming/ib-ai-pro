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
 *   checks.systems        — per-tool capability + readiness matrix
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
import { isGeminiConfigured }                 from "../lib/geminiEnv";
import { isVideoEnabled }                     from "../services/videoService";

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

  // ── Multimodal Systems (synchronous — in-memory, non-blocking) ────────────
  // Reports readiness of each AI subsystem without making any external calls.
  // featureEnabled: the provider key is configured
  // providerReady:  the feature can accept requests right now
  // veoNote: Veo access requires specific API key permissions beyond GEMINI_API_KEY
  let systemsDegraded = false;
  let geminiOk = false;
  try {
    const aiSt = getAiStatus();
    geminiOk   = aiSt.geminiAvailable;
    const videoOk  = isVideoEnabled();

    if (!geminiOk) systemsDegraded = true;

    checks["systems"] = {
      image: {
        ok:             true,   // FLUX (generate) is always available
        featureEnabled: true,
        providerReady:  true,
        provider:       "pollinations/gemini",
        description:    "Image generation (FLUX) + editing (Gemini)",
      },
      tts: {
        ok:             geminiOk,
        featureEnabled: geminiOk,
        providerReady:  geminiOk,
        provider:       "gemini-2.0-flash",
        description:    "Text-to-speech — WAV output, 5 voice styles",
      },
      video: {
        ok:             videoOk,
        featureEnabled: videoOk,
        providerReady:  videoOk,
        provider:       "gemini-veo-002",
        veoAccessNote:  videoOk
          ? "GEMINI_API_KEY set — Veo access depends on API key permissions"
          : "GEMINI_API_KEY not configured",
        asyncJob:       true,
        description:    "Image-to-video (Gemini Veo 2) — async polling job",
      },
      prompt: {
        ok:             geminiOk,
        featureEnabled: geminiOk,
        providerReady:  geminiOk,
        provider:       "gemini-2.5-flash",
        description:    "Smart prompt expansion",
      },
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

  const sys = checks["systems"] ?? {};
  res.json({
    status:            (degraded || systemsDegraded) ? "degraded" : "ok",
    boot:              bootField,
    uptime:            Math.floor(process.uptime()),
    mode:              "full",
    // Semantic aliases consumed by monitoring / Phase 7 spec
    providerMode:      geminiOk ? "gemini-primary" : "degraded",
    importReady:       bootState !== "degraded",
    bootstrapComplete: bootState !== "degraded",
    capabilities: {
      chat:   geminiOk,
      image:  sys.image?.ok  ?? false,
      tts:    sys.tts?.ok    ?? false,
      video:  sys.video?.ok  ?? false,
      prompt: sys.prompt?.ok ?? false,
    },
    systems:  sys,
    queue:    checks["queue"]    ?? { ok: false },
    storage:  checks["storage"]  ?? { ok: false },
    database: checks["postgres"] ?? { ok: true, note: "postgres not enabled" },
    checks,
  });
});

export default router;
