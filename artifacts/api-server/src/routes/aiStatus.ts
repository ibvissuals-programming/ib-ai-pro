/**
 * AI Status route — IB AI Assistant
 *
 * GET /api/system/ai-status
 *
 * CEO-only endpoint. Returns live AI provider routing status:
 * active provider, availability flags, last fallback timestamp,
 * average latency per provider, and aggregate success/fallback rates.
 *
 * Data is in-memory and ephemeral — resets on server restart.
 * No secrets or user data are included in the response.
 */
import { Router, type Request, type Response } from "express";
import { requireCeo } from "../middleware/requireCeo";
import { getAiStatus, getRawMetrics } from "../lib/aiMetrics";

const router = Router();

// ── GET /api/system/ai-status ─────────────────────────────────────────────────

router.get("/system/ai-status", requireCeo, (_req: Request, res: Response) => {
  res.json(getAiStatus());
});

// ── GET /api/system/ai-metrics ────────────────────────────────────────────────
// Extended raw counters for CEO diagnostics. Includes per-provider request
// counts, error counts, and total latency alongside the summary status.

router.get("/system/ai-metrics", requireCeo, (_req: Request, res: Response) => {
  const status = getAiStatus();
  const raw = getRawMetrics();

  res.json({
    timestamp: Date.now(),
    status,
    raw: {
      groq: raw.groq,
      gemini: raw.gemini,
      fallbackCount: raw.fallbackCount,
      lastFallbackAt: raw.lastFallbackAt,
    },
  });
});

export default router;
