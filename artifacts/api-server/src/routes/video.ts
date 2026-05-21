/**
 * video.ts — IB AI Assistant
 *
 * POST /api/video/generate  — image-to-video via Gemini Veo (async fire-and-forget)
 * GET  /api/video/status/:jobId — job status polling
 * GET  /api/video/serve/:jobId  — stream mp4 video file
 * GET  /api/video/modes     — list available video modes
 * GET  /api/video/capability — provider capability metadata
 * GET  /api/video/history   — persistent generation history for current user
 *
 * Auth: policyEngine (2 credits per generation, CEO = unlimited)
 * Rate: 5 video requests per minute per IP
 */
import * as fs                 from "fs";
import { Router, type Request, type Response } from "express";
import { z }                   from "zod";
import { imageQueue }          from "../services/imageQueue";
import {
  generateVideo, VIDEO_MODES, getVideoModeDescriptions, isVideoEnabled,
  getVideoResult, videoFileExists, getVideoFilePath,
} from "../services/videoService";
import { createJob, advanceJob, completeJob, failJob, getJob, jobSummary } from "../services/imageJobManager";
import { policyEngine, deductRequestCredits, appendCreditHeaders } from "../middleware/policyEngine";
import { addAuditEntry }       from "../lib/auditLog";
import { recordUsage }         from "../lib/usageAnalytics";
import { buildStandardResponse, buildErrorResponse } from "../lib/aiOrchestrator";
import { trackToolExecution }  from "../lib/toolHealthMonitor";
import { logger }              from "../lib/logger";
import { saveVideoHistory, getVideoHistory } from "../services/generationHistoryStore";

const router = Router();

// ── Validation ────────────────────────────────────────────────────────────────

const MAX_IMAGE_B64 = 14_000_000;

const VideoSchema = z.object({
  image:  z.string().min(10, "Image is required").max(MAX_IMAGE_B64, "Image too large"),
  prompt: z.string().min(1, "Prompt is required").max(500, "Prompt too long"),
  mode:   z.enum(VIDEO_MODES).default("subtle_animation"),
});

// ── POST /api/video/generate ──────────────────────────────────────────────────

router.post(
  "/video/generate",
  (req: Request, res: Response, next) => {
    const body = req.body as { image?: unknown };
    if (typeof body.image === "string" && body.image.length > MAX_IMAGE_B64) {
      res.status(413).json({ error: "Image too large (max 10 MB)" });
      return;
    }
    next();
  },
  policyEngine({ cost: 2, rateKey: "video_generate", rateMax: 5, rateWindowMs: 60_000, allowRecovery: true }),
  (req: Request, res: Response) => {
    const parsed = VideoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ...buildErrorResponse("video", "Invalid request"), details: parsed.error.flatten() });
      return;
    }

    const { image, prompt, mode } = parsed.data;
    const userId   = req.user?.userId;
    const username = req.user?.username;

    logger.info({ userId, promptLength: prompt.length, mode }, "[video] generate request");

    const job = createJob({
      jobType:        "VIDEO_JOB",
      complexity:     "HEAVY",
      intent:         "image_to_video",
      prompt:         prompt.slice(0, 200),
      expandedPrompt: "",
      userId,
      source:         "video",
    });

    advanceJob(job, "processing", `Video job queued — mode: ${mode}`);

    // ── Respond immediately ───────────────────────────────────────────────────
    res.json(buildStandardResponse("video", {
      jobId:     job.jobId,
      status:    "processing",
      type:      "video",
      resultUrl: null,
      metadata: {
        videoMode: mode,
        message:   "Video generation started. Poll /api/video/status/:jobId for updates.",
      },
      createdAt: job.timestamp,
      job:       jobSummary(job),
    }, job.jobId));

    // ── Fire-and-forget background generation ─────────────────────────────────
    void (async () => {
      const t0 = Date.now();
      try {
        const result = await imageQueue.run(() =>
          trackToolExecution("video", () =>
            generateVideo({ imageBase64: image, prompt, mode, jobId: job.jobId, userId }),
          ),
        );

        if (result.status === "completed") {
          completeJob(job, "gemini-veo" as never);
          if (userId) recordUsage({ userId, type: "generate", latencyMs: Date.now() - t0 });
          deductRequestCredits(req);
          addAuditEntry("video_success", `Video completed — mode: ${mode}`, { username, ip: req.ip ?? undefined });
          logger.info({ jobId: job.jobId, latencyMs: Date.now() - t0 }, "[video] background generation completed");

          // Save to persistent history
          if (userId) {
            saveVideoHistory({
              userId,
              type:         "video",
              prompt:       prompt.slice(0, 300),
              mode,
              jobId:        job.jobId,
              videoUrl:     `/api/video/serve/${job.jobId}`,
              status:       "completed",
              thumbnailB64: null,
              timestamp:    Date.now(),
            });
          }
        } else {
          // provider_not_configured — infrastructure ready but Veo not enabled
          completeJob(job, "video-stub" as never);
          addAuditEntry("video_request", `Video: ${result.status}`, { username, ip: req.ip ?? undefined });

          if (userId) {
            saveVideoHistory({
              userId,
              type:         "video",
              prompt:       prompt.slice(0, 300),
              mode,
              jobId:        job.jobId,
              videoUrl:     `/api/video/serve/${job.jobId}`,
              status:       "provider_not_configured",
              thumbnailB64: null,
              timestamp:    Date.now(),
            });
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failJob(job, errMsg);
        if (userId) recordUsage({ userId, type: "failure" });
        addAuditEntry("video_failure", `Video failed: ${errMsg.slice(0, 120)}`, { username, ip: req.ip ?? undefined });
        logger.error({ err, jobId: job.jobId }, "[video] background generation failed");

        if (userId) {
          saveVideoHistory({
            userId,
            type:         "video",
            prompt:       prompt.slice(0, 300),
            mode,
            jobId:        job.jobId,
            videoUrl:     `/api/video/serve/${job.jobId}`,
            status:       "failed",
            thumbnailB64: null,
            timestamp:    Date.now(),
          });
        }
      }
    })();
  },
);

// ── GET /api/video/status/:jobId ──────────────────────────────────────────────

router.get(
  "/video/status/:jobId",
  policyEngine({ cost: 0, rateKey: "video_status", rateMax: 120, rateWindowMs: 60_000, allowRecovery: true }),
  (req: Request, res: Response) => {
    const jobId = String(req.params["jobId"] ?? "");
    const job = getJob(jobId);

    if (!job) {
      res.status(404).json({ error: "Job not found or expired" });
      return;
    }

    if (job.userId && job.userId !== req.user?.userId && req.user?.role !== "ceo") {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const videoResult = getVideoResult(jobId);

    const responseStatus =
      videoResult?.status === "completed"               ? "completed"               :
      videoResult?.status === "provider_not_configured" ? "provider_not_configured" :
      videoResult?.status === "failed"                  ? "failed"                  :
      job.status === "failed"                           ? "failed"                  :
      "processing";

    res.json(buildStandardResponse("video", {
      jobId,
      status:    responseStatus,
      type:      "video",
      resultUrl: videoResult?.url ?? null,
      metadata: {
        videoMode:       videoResult?.mode,
        durationSeconds: videoResult?.durationSeconds ?? null,
        message:
          responseStatus === "completed"               ? "Video ready"                                :
          responseStatus === "provider_not_configured" ? "Veo not enabled for this API key"          :
          responseStatus === "failed"                  ? "Generation failed — please try again"      :
          "Processing… check back in a few seconds",
      },
      createdAt: job.timestamp,
      job:       jobSummary(job),
    }, jobId));
  },
);

// ── GET /api/video/serve/:jobId ───────────────────────────────────────────────

router.get(
  "/video/serve/:jobId",
  (req: Request, res: Response) => {
    const id = String(req.params["jobId"] ?? "");

    if (!/^job_[a-z0-9_]+$/.test(id)) {
      res.status(400).json({ error: "Invalid video ID" });
      return;
    }

    if (!videoFileExists(id)) {
      res.status(404).json({ error: "Video not found or expired" });
      return;
    }

    const filePath = getVideoFilePath(id);

    try {
      const stat = fs.statSync(filePath);
      res.setHeader("Content-Type",   "video/mp4");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `inline; filename="${id}.mp4"`);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("Accept-Ranges", "bytes");

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch (err) {
      logger.error({ err, id }, "[video] serve failed");
      res.status(500).json({ error: "Failed to serve video" });
    }
  },
);

// ── GET /api/video/modes ──────────────────────────────────────────────────────

router.get("/video/modes", (_req: Request, res: Response) => {
  const descriptions = getVideoModeDescriptions();
  res.json({
    modes:          VIDEO_MODES.map((id) => ({ id, description: descriptions[id] })),
    providerReady:  isVideoEnabled(),
    model:          "veo-002",
  });
});

// ── GET /api/video/capability ─────────────────────────────────────────────────

router.get("/video/capability", (_req: Request, res: Response) => {
  res.json({
    featureEnabled:  isVideoEnabled(),
    provider:        "gemini-veo",
    model:           "veo-002",
    veoAccessNote:   isVideoEnabled()
      ? "GEMINI_API_KEY is set. Veo access depends on API key permissions."
      : "GEMINI_API_KEY not configured.",
    durationSeconds: 5,
    resolution:      "1280x720",
    asyncJob:        true,
    pollEndpoint:    "/api/video/status/:jobId",
    serveEndpoint:   "/api/video/serve/:jobId",
  });
});

// ── GET /api/video/history ────────────────────────────────────────────────────

router.get(
  "/video/history",
  policyEngine({ cost: 0, rateKey: "video_history", rateMax: 60, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const history = await getVideoHistory(userId);
      res.json({ success: true, history, count: history.length });
    } catch (err) {
      logger.error({ err, userId }, "[video] history fetch failed");
      res.json({ success: true, history: [], count: 0 });
    }
  },
);

export default router;
