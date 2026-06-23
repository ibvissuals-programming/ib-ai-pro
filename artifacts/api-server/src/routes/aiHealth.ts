/**
 * aiHealth.ts — IB AI Assistant
 *
 * Two read-only observability endpoints:
 *
 *   GET /api/ai/health
 *     — Full health matrix + system score (original endpoint)
 *     — Optional header: x-ai-debug: true  → adds raw debug envelope
 *
 *   GET /api/ai/system-health
 *     — Per-tool: status, successRate, latency, circuit state, fallbackCount, totalCalls
 *     — Provider capability matrix: featureEnabled, providerReady, configRequired
 *     — System score breakdown
 *     — Optional ?debug=true  → adds last 10 calls + circuit details per tool
 *
 * Auth: open — no token required, no credits consumed, no side effects.
 *
 * Status values: healthy (>90%) · degraded (50-90%) · failing (<50%) · offline (no calls)
 * Circuit states: closed · open · half-open
 */
import { Router, type Request, type Response } from "express";
import {
  getHealthMatrix,
  getSystemScore,
  getDebugData,
} from "../lib/toolHealthMonitor";
import { getAllCircuitStatuses } from "../lib/circuitBreaker";
import { getAllLastNCalls }      from "../lib/toolTelemetryStore";
import { isGeminiConfigured }   from "../lib/geminiEnv";
import { isVideoEnabled }       from "../services/videoService";
import { getCeoBootstrapState } from "../lib/userStore";

const TOOL_NAMES = ["groq", "gemini", "tts", "image", "video", "prompt"] as const;

const router = Router();

// ── Capability matrix ─────────────────────────────────────────────────────────
// Static per-tool capability metadata (provider, model, config requirements).

function buildCapabilityMatrix() {
  const geminiOk = isGeminiConfigured();
  const videoOk  = isVideoEnabled();

  return {
    groq: {
      featureEnabled:  !!process.env["GROQ_API_KEY"],
      providerReady:   !!process.env["GROQ_API_KEY"],
      provider:        "groq",
      model:           "llama-3.1-70b-versatile",
      configRequired:  !process.env["GROQ_API_KEY"] ? ["GROQ_API_KEY"] : [],
      description:     "LLM streaming (primary chat provider)",
    },
    gemini: {
      featureEnabled:  geminiOk,
      providerReady:   geminiOk,
      provider:        "google-gemini",
      model:           "gemini-2.5-flash",
      configRequired:  !geminiOk ? ["GEMINI_API_KEY"] : [],
      description:     "Gemini text/vision fallback + chat",
    },
    tts: {
      featureEnabled:  geminiOk,
      providerReady:   geminiOk,
      provider:        "google-gemini",
      model:           "gemini-2.0-flash (audio modality)",
      configRequired:  !geminiOk ? ["GEMINI_API_KEY"] : [],
      description:     "Text-to-speech — WAV output",
    },
    image: {
      featureEnabled:  true,   // Pollinations is always available for generation
      providerReady:   true,
      provider:        "pollinations (generate) / google-gemini (edit)",
      model:           "FLUX / gemini-2.5-flash-image",
      configRequired:  !geminiOk ? ["GEMINI_API_KEY (for editing)"] : [],
      description:     "Image generation (FLUX) + editing (Gemini)",
    },
    video: {
      featureEnabled:  videoOk,
      providerReady:   videoOk,
      veoAccessNote:   videoOk
        ? "GEMINI_API_KEY set — Veo access depends on API key permissions"
        : "GEMINI_API_KEY not configured",
      provider:        "google-gemini-veo",
      model:           "veo-002",
      configRequired:  !videoOk ? ["GEMINI_API_KEY"] : [],
      asyncJob:        true,
      description:     "Image-to-video (Gemini Veo 2) — async polling job",
    },
    prompt: {
      featureEnabled:  geminiOk,
      providerReady:   geminiOk,
      provider:        "google-gemini",
      model:           "gemini-2.5-flash",
      configRequired:  !geminiOk ? ["GEMINI_API_KEY"] : [],
      description:     "Smart prompt expansion",
    },
  };
}

// ── GET /api/ai/health ────────────────────────────────────────────────────────

router.get("/ai/health", (req: Request, res: Response) => {
  const matrix = getHealthMatrix();
  const score  = getSystemScore();

  const payload: Record<string, unknown> = { ...matrix, systemScore: score };

  if (req.headers["x-ai-debug"] === "true") {
    payload["_debug"] = getDebugData();
  }

  res.json(payload);
});

// ── GET /api/ai/system-health ─────────────────────────────────────────────────

router.get("/ai/system-health", (req: Request, res: Response) => {
  const matrix       = getHealthMatrix();
  const score        = getSystemScore();
  const circuits     = getAllCircuitStatuses();
  const capabilities = buildCapabilityMatrix();

  // Merge health matrix + circuit states + capabilities into a per-tool shape
  const tools: Record<string, unknown> = {};
  for (const tool of TOOL_NAMES) {
    const h   = matrix[tool];
    const c   = circuits[tool];
    const cap = capabilities[tool];
    tools[tool] = {
      status:        h.status,
      successRate:   h.successRate,
      latency:       h.latency,
      circuit:       c?.state ?? "closed",
      circuitTripped: (circuits[tool] as { totalTripped?: number })?.totalTripped ?? 0,
      fallbackCount: h.fallbackCount,
      retryCount:    h.retryCount,
      totalCalls:    h.totalCalls,
      failureCount:  h.failureCount,
      lastError:     h.lastError,
      lastSuccessAt: h.lastSuccessAt,
      // Capability matrix
      featureEnabled: cap.featureEnabled,
      providerReady:  cap.providerReady,
      provider:       cap.provider,
      model:          cap.model,
      configRequired: cap.configRequired,
      description:    cap.description,
    };
  }

  // ── Import / bootstrap readiness fields (Phase 6) ────────────────────────
  const geminiOk  = isGeminiConfigured();
  const dbOk      = !!process.env["DATABASE_URL"];
  const ceoState  = getCeoBootstrapState();

  const missingOptionalServices: string[] = [];
  if (!process.env["GROQ_API_KEY"])  missingOptionalServices.push("groq");
  if (!isVideoEnabled())             missingOptionalServices.push("veo");
  if (!process.env["REDIS_URL"])     missingOptionalServices.push("redis");

  const setupWarnings: string[] = [];
  if (!process.env["CEO_RECOVERY_KEY"]) setupWarnings.push("CEO_RECOVERY_KEY not set — emergency recovery disabled");
  if (!ceoState.ready)                  setupWarnings.push("CEO account not yet bootstrapped");
  if (ceoState.tempPassword)            setupWarnings.push("CEO using auto-generated temp password — set CEO_PASSWORD to change it");

  const payload: Record<string, unknown> = {
    status:          (geminiOk && dbOk) ? "healthy" : "degraded",
    providerMode:    !!process.env["GROQ_API_KEY"]
      ? "groq-primary"
      : geminiOk ? "gemini-primary" : "offline",
    importReady:     geminiOk && dbOk,
    bootstrapComplete: ceoState.ready,
    missingOptionalServices,
    setupWarnings,
    editingPipeline: {
      status:             (geminiOk) ? "healthy" : "degraded",
      identityProtection: true,
      validationLayer:    true,
      retryProtection:    true,
      modeSystem:         true,
      modes:              ["portrait_safe", "cinematic", "style_transfer", "creative", "polish", "social", "luxury", "restore"],
      stageCount:         3,
      timeoutMs:          90000,
    },
    creatorSystem: {
      status:           "healthy",
      sessionStore:     true,
      workflowLauncher: true,
      memoryLayer:      true,
      mobileOptimized:  true,
      analytics:        true,
      exportShare:      true,
    },
    tools,
    capabilities,
    systemScore: score,
    timestamp:   new Date().toISOString(),
    providers: {
      gemini: { configured: geminiOk },
      groq:   { configured: !!process.env["GROQ_API_KEY"], note: "optional — system works without it" },
      veo:    { configured: isVideoEnabled(), note: "Veo access gated by API key permissions" },
    },
  };

  if (req.query["debug"] === "true") {
    payload["_debug"] = {
      lastCalls:      getAllLastNCalls(10),
      circuitDetails: circuits,
    };
  }

  res.json(payload);
});

export default router;
