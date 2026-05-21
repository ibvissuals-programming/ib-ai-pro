/**
 * aiHealth.ts — IB AI Assistant
 *
 * GET /api/ai/health — Live AI tool health matrix + system stability score
 *
 * Auth: open — observability endpoint, no auth required
 * No credits consumed, no side effects.
 *
 * Response shape:
 *   {
 *     groq:        { status, latency, successRate, lastError, totalCalls, ... },
 *     gemini:      { ... },
 *     tts:         { ... },
 *     image:       { ... },
 *     video:       { ... },
 *     prompt:      { ... },
 *     systemScore: { global, breakdown: { successRate, latencyStability, fallbackRate, errorFrequency } }
 *   }
 *
 * Status values:
 *   healthy   — successRate > 90%
 *   degraded  — successRate 50–90%
 *   failing   — successRate < 50%
 *   offline   — no calls recorded yet
 *
 * Optional debug envelope:
 *   Header: x-ai-debug: true
 *   Adds _debug field with sliding window data, raw counts, score weights,
 *   request timestamp, and server uptime. Never exposes API keys or user data.
 */
import { Router, type Request, type Response } from "express";
import {
  getHealthMatrix,
  getSystemScore,
  getDebugData,
} from "../lib/toolHealthMonitor";

const router = Router();

router.get("/ai/health", (_req: Request, res: Response) => {
  const matrix = getHealthMatrix();
  const score  = getSystemScore();

  const payload: Record<string, unknown> = {
    ...matrix,
    systemScore: score,
  };

  if (_req.headers["x-ai-debug"] === "true") {
    payload["_debug"] = getDebugData();
  }

  res.json(payload);
});

export default router;
