/**
 * multimodalStats.ts — IB AI Assistant
 *
 * GET /api/admin/multimodal-stats
 *
 * CEO-only endpoint returning per-tool multimodal usage analytics:
 *   - generation counts (image, video, TTS, prompt)
 *   - avg latency per tool
 *   - provider readiness + circuit breaker states
 *
 * Data sources:
 *   - toolHealthMonitor (live per-tool metrics from rolling window)
 *   - generationHistoryStore (TTS + video persistent counts)
 *   - circuitBreaker (per-tool circuit state)
 *
 * Auth: requireCeo
 */
import { Router, type Request, type Response } from "express";
import { requireCeo }              from "../middleware/requireCeo";
import { getHealthMatrix }         from "../lib/toolHealthMonitor";
import { getAllCircuitStatuses }    from "../lib/circuitBreaker";
import { isGeminiConfigured }      from "../lib/geminiEnv";
import { getGenerationHistoryCounts } from "../services/generationHistoryStore";
import { logger }                  from "../lib/logger";

const router = Router();

router.get(
  "/admin/multimodal-stats",
  requireCeo,
  async (_req: Request, res: Response) => {
    try {
      const [matrix, historyCounts, circuits] = await Promise.all([
        Promise.resolve(getHealthMatrix()),
        getGenerationHistoryCounts(),
        Promise.resolve(getAllCircuitStatuses()),
      ]);

      const toolStat = (tool: string) => {
        const t = (matrix.tools as Record<string, { totalCalls?: number; successRate?: number; avgLatencyMs?: number; status?: string; lastSuccess?: number }>)?.[tool] ?? {};
        return {
          totalCalls:   t.totalCalls   ?? 0,
          successRate:  t.successRate  ?? null,
          avgLatencyMs: t.avgLatencyMs ?? null,
          status:       t.status       ?? "offline",
          lastSuccess:  t.lastSuccess  ?? null,
        };
      };

      const circuitFor = (tool: string): string =>
        (circuits as Record<string, { state?: string }>)[tool]?.state ?? "closed";

      const geminiReady = isGeminiConfigured();

      res.json({
        success:   true,
        timestamp: Date.now(),
        tools: {
          image: {
            ...toolStat("image"),
            label:    "Image Gen/Edit",
            provider: "gemini + pollinations",
            ready:    geminiReady,
            circuit:  circuitFor("image"),
          },
          tts: {
            ...toolStat("tts"),
            label:          "Text-to-Speech",
            provider:       "gemini-2.0-flash",
            ready:          geminiReady,
            circuit:        circuitFor("tts"),
            persistedCount: historyCounts.tts,
          },
          video: {
            ...toolStat("video"),
            label:          "Video (Veo 2)",
            provider:       "gemini-veo-002",
            ready:          geminiReady,
            circuit:        circuitFor("video"),
            persistedCount: historyCounts.video,
          },
          prompt: {
            ...toolStat("prompt"),
            label:    "Prompt Expansion",
            provider: "gemini-2.5-flash",
            ready:    geminiReady,
            circuit:  circuitFor("prompt"),
          },
        },
        systemScore:  (matrix as { score?: number }).score   ?? null,
        activeTools:  (matrix as { activeTools?: number }).activeTools  ?? 0,
        healthyTools: (matrix as { healthyTools?: number }).healthyTools ?? 0,
      });
    } catch (err) {
      logger.error({ err }, "[multimodalStats] failed");
      res.status(500).json({ success: false, error: "Failed to load multimodal stats" });
    }
  },
);

export default router;
