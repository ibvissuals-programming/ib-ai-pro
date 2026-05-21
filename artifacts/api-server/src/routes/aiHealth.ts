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

const TOOL_NAMES = ["groq", "gemini", "tts", "image", "video", "prompt"] as const;

const router = Router();

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
  const matrix   = getHealthMatrix();
  const score    = getSystemScore();
  const circuits = getAllCircuitStatuses();

  // Merge health matrix + circuit states into a per-tool shape
  const tools: Record<string, unknown> = {};
  for (const tool of TOOL_NAMES) {
    const h = matrix[tool];
    const c = circuits[tool];
    tools[tool] = {
      status:        h.status,
      successRate:   h.successRate,
      latency:       h.latency,
      circuit:       c?.state ?? "closed",
      fallbackCount: h.fallbackCount,
      totalCalls:    h.totalCalls,
      lastError:     h.lastError,
    };
  }

  const payload: Record<string, unknown> = {
    tools,
    systemScore: score,
    timestamp:   new Date().toISOString(),
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
