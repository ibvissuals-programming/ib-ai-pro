/**
 * aiOrchestrator.ts — IB AI Assistant
 *
 * Lightweight orchestration layer that unifies all AI job types under
 * a single internal interface. Wraps existing systems — does not replace them.
 *
 * Responsibilities:
 *   1. createAIJob()         — unified job creation with cross-system tracking + idempotency
 *   2. buildStandardResponse() — backward-compatible response normalizer
 *   3. normalizeAIError()    — canonical error code mapper + structured logging
 *
 * Architecture rules:
 *   - NEVER replaces existing createJob / imageQueue / providerGuard
 *   - NEVER breaks existing route signatures
 *   - All functions are pure helpers — no side effects beyond logging
 *
 * Cross-system tracking fields stored on every job:
 *   source      — which AI system originated the job
 *   parentJobId — optional link to a preceding job (e.g. image → video)
 *   sessionId   — optional session-level grouping
 */
import { logger }         from "./logger";
import { createJob, getJob, type ImageJob } from "../services/imageJobManager";
import type { JobType, RequestComplexity }   from "../services/imageJobManager";
import type { AISource }                     from "./aiJobStates";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AIMode =
  | "chat"
  | "vision"
  | "image"
  | "tts"
  | "video"
  | "prompt";

export type AIErrorCode =
  | "provider_unavailable"
  | "provider_not_configured"
  | "rate_limit"
  | "feature_disabled"
  | "timeout"
  | "invalid_request"
  | "internal_error";

export interface AIJobOptions {
  type:           JobType;
  complexity:     RequestComplexity;
  intent:         string;
  prompt:         string;
  userId?:        string;
  source?:        AISource;
  parentJobId?:   string;
  sessionId?:     string;
  idempotencyKey?: string;
}

export interface StandardAIResponse extends Record<string, unknown> {
  success: true;
  mode:    AIMode;
  jobId?:  string;
}

export interface StandardAIError {
  success: false;
  mode:    AIMode;
  error:   string;
  code:    AIErrorCode;
}

export interface NormalizedAIError {
  code:    AIErrorCode;
  message: string;
}

// ── Idempotency guard ─────────────────────────────────────────────────────────
// Prevents duplicate job creation when a client retries within the dedup window.
// Entries expire automatically via the TTL interval.

const DEDUP_WINDOW_MS = 5_000;
const dedupMap = new Map<string, { jobId: string; ts: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dedupMap) {
    if (now - entry.ts > DEDUP_WINDOW_MS * 2) dedupMap.delete(key);
  }
}, 30_000);

// ── createAIJob ───────────────────────────────────────────────────────────────
// Unified job creation entrypoint. Wraps existing createJob() with:
//   - Cross-system tracking (source, parentJobId, sessionId)
//   - Optional idempotency deduplication (5s window)
//
// Usage:
//   const job = createAIJob({
//     type:     "TTS_JOB",
//     complexity: "STANDARD",
//     intent:   "text_to_speech",
//     prompt:   text.slice(0, 200),
//     userId,
//     source:   "tts",
//     idempotencyKey: `${userId}:tts:${quickHash(text)}`,
//   });

export function createAIJob(options: AIJobOptions): ImageJob {
  // Idempotency check — return existing active job if within window
  if (options.idempotencyKey) {
    const existing = dedupMap.get(options.idempotencyKey);
    if (existing && Date.now() - existing.ts < DEDUP_WINDOW_MS) {
      const job = getJob(existing.jobId);
      if (job && job.status !== "failed") {
        logger.debug(
          { jobId: job.jobId, key: options.idempotencyKey },
          "[orchestrator] idempotency hit — returning existing job",
        );
        return job;
      }
    }
  }

  const job = createJob({
    jobType:        options.type,
    complexity:     options.complexity,
    intent:         options.intent,
    prompt:         options.prompt,
    expandedPrompt: "",
    userId:         options.userId,
    source:         options.source,
    parentJobId:    options.parentJobId,
    sessionId:      options.sessionId,
  });

  if (options.idempotencyKey) {
    dedupMap.set(options.idempotencyKey, { jobId: job.jobId, ts: Date.now() });
  }

  logger.debug(
    {
      jobId:      job.jobId,
      type:       options.type,
      source:     options.source,
      parentJobId: options.parentJobId ?? null,
      sessionId:  options.sessionId ?? null,
    },
    "[orchestrator] job created",
  );

  return job;
}

// ── buildStandardResponse ─────────────────────────────────────────────────────
// Wraps an existing response payload in the standardized shape WITHOUT
// removing or nesting existing fields (backward compatible).
//
// Result shape:
//   { success: true, mode: "...", jobId?: "...", ...existingData }
//
// NOTE: if existingData contains a key that conflicts with "success" or "mode",
//       the existingData value takes precedence (it is spread last).
//       For edit routes where "mode" means "CINEMATIC_EDIT", pass the payload
//       with the field already renamed to "editMode" before calling this.

export function buildStandardResponse<T extends Record<string, unknown>>(
  mode:  AIMode,
  data:  T,
  jobId?: string,
): { success: true; mode: AIMode } & T {
  return {
    success: true as const,
    mode,
    ...(jobId ? { jobId } : {}),
    ...data,
  } as { success: true; mode: AIMode } & T;
}

// ── normalizeAIError ──────────────────────────────────────────────────────────
// Maps provider/runtime errors to canonical error codes.
// Logs with the standardized format: [AI_ERROR][CODE][SYSTEM]
// Returns a user-safe message (no stack traces, no internal details).

const USER_MESSAGES: Record<AIErrorCode, string> = {
  provider_unavailable:    "The AI provider is temporarily unavailable. Please try again shortly.",
  provider_not_configured: "This feature requires a Gemini API key with billing enabled. Enable billing at ai.google.dev to use image editing.",
  rate_limit:              "Too many requests. Please wait a moment and try again.",
  feature_disabled:        "This feature is not available in the current environment.",
  timeout:                 "The request timed out. Please try again.",
  invalid_request:         "The request could not be processed. Please check your input.",
  internal_error:          "An unexpected error occurred. Please try again.",
};

export function normalizeAIError(err: unknown, system = "unknown"): NormalizedAIError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  let code: AIErrorCode;
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline"))
    code = "timeout";
  else if ((lower.includes("quota") || lower.includes("resource_exhausted")) && lower.includes("limit: 0"))
    code = "provider_not_configured";
  else if (lower.includes("rate limit") || lower.includes("rate-limit") || lower.includes("ratelimit") || lower.includes("too many requests") || lower.includes("resource_exhausted") || lower.includes("429") || lower.includes("quota"))
    code = "rate_limit";
  else if (
    lower.includes("provider_not_configured") ||
    lower.includes("api key not valid") || lower.includes("invalid api key") ||
    lower.includes("permission_denied") || lower.includes("api key invalid") ||
    (lower.includes("403") && lower.includes("api")) ||
    (lower.includes("401") && lower.includes("api"))
  )
    code = "provider_not_configured";
  else if (lower.includes("exhausted balance") || lower.includes("user is locked") ||
    (lower.includes("fal") && (lower.includes("402") || lower.includes("403") || lower.includes("credit"))))
    code = "feature_disabled";
  else if (lower.includes("feature_disabled") || lower.includes("not available") || lower.includes("unsupported_model") || lower.includes("not supported"))
    code = "feature_disabled";
  else if (lower.includes("invalid") || lower.includes("bad request") || lower.includes("malformed"))
    code = "invalid_request";
  else if (
    lower.includes("unavailable") || lower.includes("provider") ||
    lower.includes("503") || lower.includes("service") || lower.includes("network")
  )
    code = "provider_unavailable";
  else
    code = "internal_error";

  // Standardized error log format: [AI_ERROR][CODE][SYSTEM]
  logger.error(
    { system, code, rawMessage: raw.slice(0, 200) },
    `[AI_ERROR][${code.toUpperCase()}][${system.toUpperCase()}]`,
  );

  return { code, message: USER_MESSAGES[code]! };
}

// ── buildErrorResponse ────────────────────────────────────────────────────────
// Builds a standardized error response. Wraps normalizeAIError.

export function buildErrorResponse(
  mode:   AIMode,
  err:    unknown,
  system?: string,
): StandardAIError {
  const { code, message } = normalizeAIError(err, system ?? mode);
  return { success: false, mode, error: message, code };
}

// ── Utility ───────────────────────────────────────────────────────────────────
// Fast non-crypto hash for idempotency keys. Not security-sensitive.

export function quickHash(input: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(input.length, 256); i++) {
    h = Math.imul(31, h) + input.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}
