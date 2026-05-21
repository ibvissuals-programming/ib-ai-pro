/**
 * video.ts — IB AI Assistant
 *
 * POST /api/video/generate  — image-to-video generation pipeline
 * GET  /api/video/status/:jobId — job status polling
 * GET  /api/video/modes     — list available video modes
 *
 * Auth: policyEngine (2 credits per generation, CEO = unlimited)
 * Rate: 5 video requests per minute per IP
 * Queue: routed through imageQueue for concurrency control
 * Storage: Object Storage or local filesystem (when provider connected)
 * Recovery: DB-backed jobs survive server restarts
 *
 * Response: standardized job response
 *   { jobId, status, type, resultUrl, metadata, createdAt }
 *
 * NOTE: Video generation is infrastructure-ready.
 * Set VIDEO_ENABLED=true + VIDEO_PROVIDER_URL + VIDEO_PROVIDER_KEY to activate.
 */
import { Router, type Request, type Response } from "express";
import { z }                   from "zod";
import { imageQueue }          from "../services/imageQueue";
import { generateVideo, VIDEO_MODES, getVideoModeDescriptions } from "../services/videoService";
import { createJob, advanceJob, completeJob, failJob, getJob, jobSummary } from "../services/imageJobManager";
import { policyEngine, deductRequestCredits, appendCreditHeaders } from "../middleware/policyEngine";
import { addAuditEntry }       from "../lib/auditLog";
import { recordUsage }         from "../lib/usageAnalytics";
import { sanitizeProviderError } from "../lib/providerGuard";
import { buildStandardResponse, buildErrorResponse } from "../lib/aiOrchestrator";
import { logger }              from "../lib/logger";

const router = Router();

// ── Validation ────────────────────────────────────────────────────────────────

const MAX_IMAGE_B64 = 14_000_000;

const VideoSchema = z.object({
  image:  z.string().min(10, "Image is required").max(MAX_IMAGE_B64, "Image too large"),
  prompt: z.string().min(1, "Prompt is required").max(500, "Prompt too long"),
  mode:   z.enum(VIDEO_MODES).default("cinematic_motion"),
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
  async (req: Request, res: Response) => {
    const parsed = VideoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ...buildErrorResponse("video", "Invalid request"), details: parsed.error.flatten() });
      return;
    }

    const { image, prompt, mode } = parsed.data;
    const userId = req.user?.userId;

    logger.info(
      { userId, promptLength: prompt.length, mode },
      "[video] generate request",
    );

    const job = createJob({
      jobType:        "VIDEO_JOB",
      complexity:     "HEAVY",
      intent:         "image_to_video",
      prompt:         prompt.slice(0, 200),
      expandedPrompt: "",
      userId,
      source:         "video",
    });

    advanceJob(job, "processing", `Video job started — mode: ${mode}`);

    try {
      const t0 = Date.now();

      const result = await imageQueue.run(() =>
        generateVideo({ imageBase64: image, prompt, mode, jobId: job.jobId, userId }),
      );

      if (result.status === "completed") {
        completeJob(job, "video-provider" as any);
      } else {
        // provider_not_configured — not a failure, just a configuration gap
        completeJob(job, "video-stub" as any);
      }

      if (userId) {
        recordUsage({ userId, type: "generate", latencyMs: Date.now() - t0 });
      }

      if (result.status === "completed") {
        deductRequestCredits(req);
        appendCreditHeaders(req, res);
      }

      addAuditEntry("video_request", `Video job ${result.status}`, {
        username: req.user?.username,
        ip:       req.ip ?? undefined,
      });

      res.json(buildStandardResponse("video", {
        jobId:     job.jobId,
        status:    result.status,
        type:      "video",
        resultUrl: result.videoUrl ?? null,
        metadata: {
          videoMode:       mode,
          durationSeconds: result.durationSeconds ?? null,
          resolution:      result.resolution      ?? null,
          message:         result.message,
        },
        createdAt: job.timestamp,
        job:       jobSummary(job),
      }, job.jobId));
    } catch (err: unknown) {
      failJob(job, err instanceof Error ? err.message : String(err));

      if (userId) {
        recordUsage({ userId, type: "failure" });
      }

      logger.error({ err, jobId: job.jobId }, "[video] generation failed");
      res.status(503).json(buildErrorResponse("video", err, "video-provider"));
    }
  },
);

// ── GET /api/video/status/:jobId ──────────────────────────────────────────────

router.get(
  "/video/status/:jobId",
  policyEngine({ cost: 0, rateKey: "video_status", rateMax: 60, rateWindowMs: 60_000, allowRecovery: true }),
  (req: Request, res: Response) => {
    const jobId = String(req.params["jobId"] ?? "");
    const job = getJob(jobId);

    if (!job) {
      res.status(404).json({ error: "Job not found or expired" });
      return;
    }

    // Only the job owner or CEO can view
    if (job.userId && job.userId !== req.user?.userId && req.user?.role !== "ceo") {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    res.json(buildStandardResponse("video", {
      jobId:     job.jobId,
      status:    job.status,
      type:      "video",
      createdAt: job.timestamp,
      job:       jobSummary(job),
    }, job.jobId));
  },
);

// ── GET /api/video/modes ──────────────────────────────────────────────────────
// No auth required.

router.get("/video/modes", (_req: Request, res: Response) => {
  const descriptions = getVideoModeDescriptions();
  res.json({
    modes: VIDEO_MODES.map((id) => ({
      id,
      description: descriptions[id],
    })),
  });
});

export default router;
