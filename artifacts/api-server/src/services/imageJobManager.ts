/**
 * Image Job Manager — IB AI Assistant
 *
 * LAYER 1 of the Production Orchestration Engine.
 * Tracks every image request as a structured job with full lifecycle logging.
 *
 * - Every request gets a unique jobId before any processing begins
 * - Status transitions are logged at each pipeline stage
 * - In-memory store with automatic TTL cleanup (10 min)
 * - Zero external dependencies — no DB or queue required
 * - Thread-safe for single-process Node.js (Map + synchronous updates)
 */
import { logger } from "../lib/logger";

// ── Types ──────────────────────────────────────────────────────────────────────

export type JobStatus =
  | "queued"
  | "processing"
  | "streaming"
  | "success"
  | "failed"
  | "retrying";

export type ModelUsed = "gemini-img2img" | "gemini-vision" | "flux" | "fallback";

export type RequestComplexity = "SIMPLE" | "STANDARD" | "HEAVY";

export type JobType =
  | "IMAGE_EDIT_JOB"
  | "IMAGE_GENERATION_JOB"
  | "IMAGE_TRANSFORMATION_JOB";

export interface StatusEvent {
  status: JobStatus;
  message: string;
  ts: number;
}

export interface ImageJob {
  jobId: string;
  status: JobStatus;
  jobType: JobType;
  complexity: RequestComplexity;
  intent: string;
  prompt: string;
  expandedPrompt: string;
  retryCount: number;
  modelUsed?: ModelUsed;
  latencyMs?: number;
  errorReason?: string;
  timestamp: number;
  statusHistory: StatusEvent[];
}

// ── Job store ──────────────────────────────────────────────────────────────────

const JOB_TTL_MS = 10 * 60 * 1000; // 10 minutes
const jobs = new Map<string, ImageJob>();

// Auto-cleanup expired jobs every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.timestamp > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── ID generator ───────────────────────────────────────────────────────────────

function generateJobId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `job_${ts}_${rand}`;
}

// ── Job lifecycle API ──────────────────────────────────────────────────────────

/**
 * Create a new job and immediately set it to "queued" status.
 * Always call this BEFORE any processing begins.
 */
export function createJob(params: {
  jobType: JobType;
  complexity: RequestComplexity;
  intent: string;
  prompt: string;
  expandedPrompt: string;
}): ImageJob {
  const jobId = generateJobId();
  const now = Date.now();

  const initialEvent: StatusEvent = {
    status: "queued",
    message: `Job queued — ${params.jobType} / ${params.complexity}`,
    ts: now,
  };

  const job: ImageJob = {
    jobId,
    status: "queued",
    jobType: params.jobType,
    complexity: params.complexity,
    intent: params.intent,
    prompt: params.prompt,
    expandedPrompt: params.expandedPrompt,
    retryCount: 0,
    timestamp: now,
    statusHistory: [initialEvent],
  };

  jobs.set(jobId, job);

  logger.info(
    {
      jobId,
      jobType: params.jobType,
      complexity: params.complexity,
      intent: params.intent,
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
  job: ImageJob,
  status: JobStatus,
  message: string,
  extras?: Partial<Pick<ImageJob, "modelUsed" | "retryCount" | "expandedPrompt">>,
): void {
  job.status = status;
  if (extras?.modelUsed !== undefined) job.modelUsed = extras.modelUsed;
  if (extras?.retryCount !== undefined) job.retryCount = extras.retryCount;
  if (extras?.expandedPrompt !== undefined) job.expandedPrompt = extras.expandedPrompt;

  job.statusHistory.push({ status, message, ts: Date.now() });

  logger.info(
    {
      jobId: job.jobId,
      status,
      retryCount: job.retryCount,
      modelUsed: job.modelUsed,
    },
    `[job] ${message}`,
  );
}

/**
 * Mark a job as successful and record final observability metrics.
 */
export function completeJob(job: ImageJob, modelUsed: ModelUsed): void {
  const latencyMs = Date.now() - job.timestamp;
  job.status = "success";
  job.modelUsed = modelUsed;
  job.latencyMs = latencyMs;
  job.statusHistory.push({
    status: "success",
    message: `Complete via ${modelUsed} in ${latencyMs}ms`,
    ts: Date.now(),
  });

  logger.info(
    {
      jobId: job.jobId,
      intent: job.intent,
      complexity: job.complexity,
      modelUsed,
      latencyMs,
      retryCount: job.retryCount,
      expandedPromptLength: job.expandedPrompt.length,
    },
    "[job] success — observability record",
  );
}

/**
 * Mark a job as failed and record the reason.
 */
export function failJob(job: ImageJob, reason: string): void {
  const latencyMs = Date.now() - job.timestamp;
  job.status = "failed";
  job.latencyMs = latencyMs;
  job.errorReason = reason;
  job.statusHistory.push({
    status: "failed",
    message: `Failed after ${latencyMs}ms — ${reason}`,
    ts: Date.now(),
  });

  logger.error(
    {
      jobId: job.jobId,
      intent: job.intent,
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
    jobId: job.jobId,
    status: job.status,
    jobType: job.jobType,
    complexity: job.complexity,
    intent: job.intent,
    modelUsed: job.modelUsed ?? null,
    retryCount: job.retryCount,
    latencyMs: job.latencyMs ?? null,
    statusHistory: job.statusHistory,
  };
}
