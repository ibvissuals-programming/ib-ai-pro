/**
 * tts.ts — IB AI Assistant
 *
 * POST /api/tts/generate  — text-to-speech via Gemini 2.0 Flash audio
 * GET  /api/tts/serve/:id — stream WAV audio file
 * GET  /api/tts/voices    — list available voice styles
 * GET  /api/tts/history   — persistent generation history for current user
 *
 * Auth: policyEngine (1 credit per generation, CEO = unlimited)
 * Rate: 20 TTS requests per minute per IP
 * Queue: routed through imageQueue for concurrency control
 * Storage: local filesystem artifacts/data/audio/{jobId}.wav
 *
 * Response: standardized job response
 *   { jobId, status, type, resultUrl, metadata, createdAt }
 */
import * as fs                 from "fs";
import { Router, type Request, type Response } from "express";
import { z }                   from "zod";
import { imageQueue }          from "../services/imageQueue";
import { generateSpeech, getAudioFilePath, audioFileExists, VOICE_STYLES } from "../services/ttsService";
import { createJob, advanceJob, completeJob, failJob, jobSummary } from "../services/imageJobManager";
import { policyEngine, deductRequestCredits, appendCreditHeaders } from "../middleware/policyEngine";
import { addAuditEntry }       from "../lib/auditLog";
import { recordUsage }         from "../lib/usageAnalytics";
import { sanitizeProviderError } from "../lib/providerGuard";
import { buildStandardResponse, buildErrorResponse } from "../lib/aiOrchestrator";
import { isGeminiConfigured } from "../lib/geminiEnv";
import { isSafeMode, buildSafeModeError } from "../lib/safeMode";
import { trackToolExecution }    from "../lib/toolHealthMonitor";
import { logger }              from "../lib/logger";
import { saveTtsHistory, getTtsHistory } from "../services/generationHistoryStore";
import { trackVoiceUsage, trackFunnel } from "../lib/creatorAnalytics";

const router = Router();

// ── Validation ────────────────────────────────────────────────────────────────

const TtsSchema = z.object({
  text:       z.string().min(1, "Text is required").max(1_000, "Text too long (max 1000 chars)"),
  voiceStyle: z.enum(VOICE_STYLES).default("neutral_assistant"),
});

// ── Voice label lookup ────────────────────────────────────────────────────────

const VOICE_LABELS: Record<string, string> = {
  cinematic_narration: "Cinematic Narration",
  female_soft:         "Female Soft",
  male_deep:           "Male Deep",
  energetic_social:    "Energetic Social",
  neutral_assistant:   "Neutral Assistant",
};

// ── POST /api/tts/generate ────────────────────────────────────────────────────

router.post(
  "/tts/generate",
  policyEngine({ cost: 1, rateKey: "tts_generate", rateMax: 20, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const parsed = TtsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ...buildErrorResponse("tts", "Invalid request"), details: parsed.error.flatten() });
      return;
    }

    if (isSafeMode()) {
      res.status(503).json(buildSafeModeError("tts"));
      return;
    }
    if (!isGeminiConfigured()) {
      res.status(503).json(buildErrorResponse("tts", "provider_not_configured: Gemini API key is required for voice generation", "gemini-tts"));
      return;
    }

    const { text, voiceStyle } = parsed.data;
    const userId = req.user?.userId;

    logger.info(
      { userId, textLength: text.length, voiceStyle },
      "[tts] generate request",
    );

    // Create tracked job
    const job = createJob({
      jobType:        "TTS_JOB",
      complexity:     text.length > 500 ? "HEAVY" : text.length > 150 ? "STANDARD" : "SIMPLE",
      intent:         "text_to_speech",
      prompt:         text.slice(0, 200),
      expandedPrompt: "",
      userId,
      source:         "tts",
    });

    advanceJob(job, "processing", `TTS started — voice: ${voiceStyle}`);

    try {
      const t0 = Date.now();

      const result = await imageQueue.run(() =>
        trackToolExecution("tts", () => generateSpeech(text, voiceStyle, job.jobId)),
      );

      const latencyMs = Date.now() - t0;
      completeJob(job, "gemini-tts" as any);
      trackVoiceUsage(voiceStyle);
      trackFunnel("voice");

      if (userId) {
        recordUsage({ userId, type: "generate", latencyMs });
      }

      deductRequestCredits(req);
      appendCreditHeaders(req, res);

      addAuditEntry("tts_success", "TTS generated", {
        username: req.user?.username,
        ip:       req.ip ?? undefined,
      });

      // Save to persistent history (fire-and-forget)
      if (userId) {
        saveTtsHistory({
          userId,
          type:       "tts",
          text:       text.slice(0, 300),
          voiceStyle,
          voiceLabel: VOICE_LABELS[voiceStyle] ?? voiceStyle,
          jobId:      job.jobId,
          audioUrl:   `/api/tts/serve/${job.jobId}`,
          durationMs: result.durationEstimateMs,
          textLength: result.textLength,
          timestamp:  Date.now(),
        });
      }

      res.json(buildStandardResponse("tts", {
        jobId:     job.jobId,
        status:    "success",
        type:      "tts",
        resultUrl: `/api/tts/serve/${job.jobId}`,
        metadata: {
          voiceStyle:         result.voiceStyle,
          voiceName:          result.voiceName,
          durationMs:         result.durationEstimateMs,
          textLength:         result.textLength,
          mimeType:           result.mimeType,
          sampleRate:         result.sampleRate,
        },
        createdAt: job.timestamp,
        job:       jobSummary(job),
      }, job.jobId));
    } catch (err: unknown) {
      failJob(job, err instanceof Error ? err.message : String(err));

      if (userId) {
        recordUsage({ userId, type: "failure" });
      }

      addAuditEntry("tts_failure", `TTS failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`, {
        username: req.user?.username,
        ip:       req.ip ?? undefined,
      });

      logger.error({ err, jobId: job.jobId }, "[tts] generation failed");

      const errStr = String(err instanceof Error ? err.message : err);
      const isModelUnsupported = errStr.includes("UNSUPPORTED_MODEL") || errStr.includes("not supported");
      if (isModelUnsupported) {
        res.status(501).json({
          success:  false,
          mode:     "tts",
          error:    "Text-to-speech is not available in this environment.",
          code:     "FEATURE_DISABLED",
        });
        return;
      }

      res.status(503).json(buildErrorResponse("tts", err, "gemini-tts"));
    }
  },
);

// ── GET /api/tts/serve/:id ─────────────────────────────────────────────────────
// No auth required — job IDs are cryptographically unguessable UUIDs.

router.get(
  "/tts/serve/:id",
  (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");

    if (!/^job_[a-z0-9_]+$/.test(id)) {
      res.status(400).json({ error: "Invalid audio ID" });
      return;
    }

    if (!audioFileExists(id)) {
      res.status(404).json({ error: "Audio not found or expired" });
      return;
    }

    const filePath = getAudioFilePath(id);

    try {
      const stat = fs.statSync(filePath);
      res.setHeader("Content-Type",   "audio/wav");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `inline; filename="${id}.wav"`);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("Accept-Ranges", "bytes");

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch (err) {
      logger.error({ err, id }, "[tts] serve failed");
      res.status(500).json({ error: "Failed to serve audio" });
    }
  },
);

// ── GET /api/tts/voices ───────────────────────────────────────────────────────

router.get("/tts/voices", (_req: Request, res: Response) => {
  res.json({
    voices: [
      { id: "cinematic_narration", label: "Cinematic Narration", description: "Deep, gravelly, dramatic narrator voice" },
      { id: "female_soft",         label: "Female Soft",         description: "Warm, gentle, expressive female voice" },
      { id: "male_deep",           label: "Male Deep",           description: "Strong, authoritative deep male voice" },
      { id: "energetic_social",    label: "Energetic Social",    description: "Upbeat, expressive, high-energy voice" },
      { id: "neutral_assistant",   label: "Neutral Assistant",   description: "Clear, professional, neutral voice" },
    ],
  });
});

// ── GET /api/tts/history ──────────────────────────────────────────────────────
// Returns the current user's persistent TTS generation history.

router.get(
  "/tts/history",
  policyEngine({ cost: 0, rateKey: "tts_history", rateMax: 60, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const history = await getTtsHistory(userId);
      res.json({ success: true, history, count: history.length });
    } catch (err) {
      logger.error({ err, userId }, "[tts] history fetch failed");
      res.json({ success: true, history: [], count: 0 });
    }
  },
);

export default router;
