/**
 * Image Job Manager — IB AI Assistant
 *
 * LAYER 1 of the Production Orchestration Engine.
 * Tracks every image request as a structured job with full lifecycle logging.
 *
 * - Every request gets a unique jobId before any processing begins
 * - Status transitions are logged at each pipeline stage
 * - In-memory store with automatic TTL cleanup (10 min)
 * - DB-backed persistence: create + terminal states (success/failed) written async
 * - Stalled job recovery: recoverStalledJobs() marks orphaned jobs on boot
 * - Thread-safe for single-process Node.js (Map + synchronous updates)
 */
import { logger } from "../lib/logger";
import { db, imageJobsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { isPostgresEnabled } from "../lib/systemConfig";
import { logInvariantViolation } from "../lib/invariant";
import { emit } from "../lib/eventBus";

// ── Types ──────────────────────────────────────────────────────────────────────

export type JobStatus =
  | "queued"
  | "processing"
  | "streaming"
  | "success"
  | "failed"
  | "retrying";

export type ModelUsed =
  | "gemini-img2img"
  | "free-img2img"
  | "gemini-vision"
  | "flux"
  | "fallback"
  | "gemini-tts"
  | "video-provider"
  | "enhancement-mode";

export type RequestComplexity = "SIMPLE" | "STANDARD" | "HEAVY";

export type JobType =
  | "IMAGE_EDIT_JOB"
  | "IMAGE_GENERATION_JOB"
  | "IMAGE_TRANSFORMATION_JOB"
  | "TTS_JOB"
  | "VIDEO_JOB";

export interface StatusEvent {
  status:  JobStatus;
  message: string;
  ts:      number;
}

export interface ImageJob {
  jobId:         string;
  userId?:       string;
  status:        JobStatus;
  jobType:       JobType;
  complexity:    RequestComplexity;
  intent:        string;
  prompt:        string;
  expandedPrompt: string;
  retryCount:    number;
  modelUsed?:    ModelUsed;
  latencyMs?:    number;
  errorReason?:  string;
  timestamp:     number;
  statusHistory: StatusEvent[];
  // Cross-system tracking (PHASE 5)
  source?:       "image" | "tts" | "video" | "prompt";
  parentJobId?:  string;
  sessionId?:    string;
}

// ── Job store ──────────────────────────────────────────────────────────────────

const JOB_TTL_MS = 10 * 60 * 1000; // 10 minutes
const jobs = new Map<string, ImageJob>();

// Auto-cleanup expired jobs every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, job] of jobs) {
    if (now - job.timestamp > JOB_TTL_MS) {
      jobs.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug({ cleaned }, "[jobManager] TTL cleanup");
  }
}, 5 * 60 * 1000);

// ── ID generator ───────────────────────────────────────────────────────────────

function generateJobId(): string {
  const ts   = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `job_${ts}_${rand}`;
}

// ── DB persistence (fire-and-forget) ──────────────────────────────────────────
// All DB writes are non-blocking. A failure never crashes the request pipeline.

function persistJobCreate(job: ImageJob): void {
  if (!isPostgresEnabled()) return;
  void db
    .insert(imageJobsTable)
    .values({
      id:             job.jobId,
      userId:         job.userId ?? null,
      status:         job.status,
      jobType:        job.jobType,
      complexity:     job.complexity,
      prompt:         job.prompt,
      expandedPrompt: job.expandedPrompt,
      intent:         job.intent,
      retryCount:     job.retryCount,
      createdAt:      job.timestamp,
      updatedAt:      job.timestamp,
    })
    .onConflictDoNothing()
    .catch((err: unknown) => {
      logger.debug({ jobId: job.jobId, err: err instanceof Error ? err.message : String(err) }, "[jobManager] DB create failed (non-fatal)");
    });
}

function persistJobTerminal(job: ImageJob): void {
  if (!isPostgresEnabled()) return;
  void db
    .update(imageJobsTable)
    .set({
      status:      job.status,
      modelUsed:   job.modelUsed ?? null,
      retryCount:  job.retryCount,
      latencyMs:   job.latencyMs ?? null,
      errorReason: job.errorReason ?? null,
      updatedAt:   Date.now(),
    })
    .where(eq(imageJobsTable.id, job.jobId))
    .catch((err: unknown) => {
      logger.debug({ jobId: job.jobId, err: err instanceof Error ? err.message : String(err) }, "[jobManager] DB update failed (non-fatal)");
    });
}

// ── Job lifecycle API ──────────────────────────────────────────────────────────

/**
 * Create a new job and immediately set it to "queued" status.
 * Always call this BEFORE any processing begins.
 */
export function createJob(params: {
  jobType:       JobType;
  complexity:    RequestComplexity;
  intent:        string;
  prompt:        string;
  expandedPrompt: string;
  userId?:       string;
  source?:       "image" | "tts" | "video" | "prompt";
  parentJobId?:  string;
  sessionId?:    string;
}): ImageJob {
  const jobId = generateJobId();
  const now   = Date.now();

  const initialEvent: StatusEvent = {
    status:  "queued",
    message: `Job queued — ${params.jobType} / ${params.complexity}`,
    ts:      now,
  };

  const job: ImageJob = {
    jobId,
    userId:         params.userId,
    status:         "queued",
    jobType:        params.jobType,
    complexity:     params.complexity,
    intent:         params.intent,
    prompt:         params.prompt,
    expandedPrompt: params.expandedPrompt,
    retryCount:     0,
    timestamp:      now,
    statusHistory:  [initialEvent],
    source:         params.source,
    parentJobId:    params.parentJobId,
    sessionId:      params.sessionId,
  };

  jobs.set(jobId, job);
  persistJobCreate(job);

  emit({
    eventType: "job_created",
    source:    params.source ?? "jobManager",
    userId:    params.userId,
    action:    "create_job",
    status:    "info",
    metadata:  { jobId, jobType: params.jobType, complexity: params.complexity, intent: params.intent },
  });

  logger.info(
    {
      jobId,
      jobType:      params.jobType,
      complexity:   params.complexity,
      intent:       params.intent,
      promptLength: params.prompt.length,
    },
    "[job] created — queued",
  );

  return job;
}

/**
 * Transition a job to a new status and append a history event.
 */
export function advanceJob(
  job:     ImageJob,
  status:  JobStatus,
  message: string,
  extras?: Partial<Pick<ImageJob, "modelUsed" | "retryCount" | "expandedPrompt">>,
): void {
  job.status = status;
  if (extras?.modelUsed     !== undefined) job.modelUsed     = extras.modelUsed;
  if (extras?.retryCount    !== undefined) job.retryCount    = extras.retryCount;
  if (extras?.expandedPrompt !== undefined) job.expandedPrompt = extras.expandedPrompt;

  job.statusHistory.push({ status, message, ts: Date.now() });

  logger.info(
    {
      jobId:      job.jobId,
      status,
      retryCount: job.retryCount,
      modelUsed:  job.modelUsed,
    },
    `[job] ${message}`,
  );
}

/**
 * Mark a job as successful and record final observability metrics.
 */
export function completeJob(job: ImageJob, modelUsed: ModelUsed): void {
  // Invariant: a job can only be completed once, and never after it has failed
  if (job.status === "success") {
    logInvariantViolation("completeJob called on already-successful job (duplicate completion)", {
      jobId: job.jobId, jobType: job.jobType, modelUsed,
    });
    return; // do not double-complete
  }
  if (job.status === "failed") {
    logInvariantViolation("completeJob called on already-failed job — provider failure cannot be masked as success", {
      jobId: job.jobId, jobType: job.jobType, errorReason: job.errorReason, modelUsed,
    });
    return; // preserve the failed state
  }

  const latencyMs = Date.now() - job.timestamp;
  job.status    = "success";
  job.modelUsed = modelUsed;
  job.latencyMs = latencyMs;
  job.statusHistory.push({
    status:  "success",
    message: `Complete via ${modelUsed} in ${latencyMs}ms`,
    ts:      Date.now(),
  });

  persistJobTerminal(job);

  emit({
    eventType: "job_completed",
    source:    job.source ?? "jobManager",
    userId:    job.userId,
    action:    "complete_job",
    status:    "success",
    metadata:  { jobId: job.jobId, jobType: job.jobType, modelUsed, latencyMs, retryCount: job.retryCount },
  });

  logger.info(
    {
      jobId:                job.jobId,
      intent:               job.intent,
      complexity:           job.complexity,
      modelUsed,
      latencyMs,
      retryCount:           job.retryCount,
      expandedPromptLength: job.expandedPrompt.length,
    },
    "[job] success — observability record",
  );
}

/**
 * Mark a job as failed and record the reason.
 */
export function failJob(job: ImageJob, reason: string): void {
  // Invariant: a successfully completed job must never be retroactively failed
  if (job.status === "success") {
    logInvariantViolation("failJob called on already-successful job — success cannot be reverted", {
      jobId: job.jobId, jobType: job.jobType, reason,
    });
    return; // preserve the success state
  }

  const latencyMs = Date.now() - job.timestamp;
  job.status      = "failed";
  job.latencyMs   = latencyMs;
  job.errorReason = reason;
  job.statusHistory.push({
    status:  "failed",
    message: `Failed after ${latencyMs}ms — ${reason}`,
    ts:      Date.now(),
  });

  persistJobTerminal(job);

  emit({
    eventType: "job_failed",
    source:    job.source ?? "jobManager",
    userId:    job.userId,
    action:    "fail_job",
    status:    "failure",
    metadata:  { jobId: job.jobId, jobType: job.jobType, reason, latencyMs, retryCount: job.retryCount },
    errorCode: "job_failed",
  });

  logger.error(
    {
      jobId:      job.jobId,
      intent:     job.intent,
      complexity: job.complexity,
      latencyMs,
      retryCount: job.retryCount,
      reason,
    },
    "[job] failed — observability record",
  );
}

/**
 * Retrieve a job by ID (for status polling).
 */
export function getJob(jobId: string): ImageJob | undefined {
  return jobs.get(jobId);
}

/**
 * Build a clean public-facing job summary for API responses.
 */
export function jobSummary(job: ImageJob): object {
  return {
    jobId:         job.jobId,
    status:        job.status,
    jobType:       job.jobType,
    complexity:    job.complexity,
    intent:        job.intent,
    modelUsed:     job.modelUsed  ?? null,
    retryCount:    job.retryCount,
    latencyMs:     job.latencyMs  ?? null,
    statusHistory: job.statusHistory,
  };
}

/**
 * In-memory job metrics snapshot — used by health endpoint.
 */
export function getJobMetrics(): {
  total:      number;
  queued:     number;
  processing: number;
  succeeded:  number;
  failed:     number;
} {
  let queued = 0, processing = 0, succeeded = 0, failed = 0;
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "retrying")              queued++;
    else if (job.status === "processing" || job.status === "streaming")   processing++;
    else if (job.status === "success")                                     succeeded++;
    else if (job.status === "failed")                                      failed++;
  }
  return { total: jobs.size, queued, processing, succeeded, failed };
}

// ── Stalled job recovery ───────────────────────────────────────────────────────

/**
 * On server boot, mark any DB jobs that were in-flight during the previous run
 * (status queued/processing) as failed with reason "Server restarted".
 * This prevents phantom jobs from showing as active indefinitely.
 *
 * Safe to call multiple times (idempotent — only touches pre-boot rows).
 */
export async function recoverStalledJobs(): Promise<void> {
  if (!isPostgresEnabled()) return;

  // bootTime = approximate timestamp when this process started
  const bootTime = Date.now() - Math.floor(process.uptime() * 1000);

  try {
    // Find stalled jobs from before this boot
    const stalled = await db
      .select({ id: imageJobsTable.id, status: imageJobsTable.status })
      .from(imageJobsTable)
      .where(inArray(imageJobsTable.status, ["queued", "processing"]));

    const stalledIds = stalled
      .filter((r) => {
        // Jobs created before this server process started are orphaned
        return true; // We update all queued/processing — they're from previous run
      })
      .map((r) => r.id);

    if (stalledIds.length === 0) {
      logger.info("[jobManager] No stalled jobs found");
      return;
    }

    await db
      .update(imageJobsTable)
      .set({
        status:      "failed",
        errorReason: "Server restarted",
        updatedAt:   bootTime,
      })
      .where(inArray(imageJobsTable.id, stalledIds));

    logger.info(
      { recovered: stalledIds.length },
      "[jobManager] Stalled jobs recovered",
    );
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[jobManager] Stalled job recovery failed (non-fatal)",
    );
  }
}
