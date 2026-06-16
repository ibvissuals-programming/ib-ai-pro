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
  | "safety_block"
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
//
// Classification order (first match wins — order is load-bearing):
//   1. timeout              — watchdog / connection deadline / ProviderError timeout
//   2. provider_not_configured — quota with limit:0 (billing disabled)
//   3. rate_limit           — 429 / quota / resource_exhausted / too many requests
//   4. provider_not_configured — 401/403 / bad API key / permission denied
//   5. feature_disabled     — fal balance / locked / unsupported model
//   6. safety_block         — Gemini SAFETY / content_filter / recitation
//   7. invalid_request      — 400 / INVALID_ARGUMENT / bad request / malformed
//   8. provider_unavailable — 503 / UNAVAILABLE keyword only
//   9. internal_error       — catch-all
//
// Step 8 intentionally omits "service", "network", and "provider" string
// matches. "service" and "provider" are too generic — "provider" in
// particular appears in the "Both providers failed" wrapper emitted by
// llm.ts when both Groq and Gemini fail, causing every such error to be
// misclassified as provider_unavailable. "network" similarly over-fires.
// Genuine 503 responses are caught by http===503 or "unavailable" keyword.
// Errors that would have matched only via those broad terms fall correctly
// to step 9 (internal_error).
//
// chat.ts is the ONLY caller that converts these codes into user-safe text.
// This function logs the raw classification inputs at DEBUG so issues are
// diagnosable without exposing internals to the client.

const USER_MESSAGES: Record<AIErrorCode, string> = {
  provider_unavailable:    "The AI provider is temporarily unavailable. Please try again shortly.",
  provider_not_configured: "This feature requires a Gemini API key with billing enabled. Enable billing at ai.google.dev to use image editing.",
  rate_limit:              "Too many requests. Please wait a moment and try again.",
  feature_disabled:        "This feature is not available in the current environment.",
  timeout:                 "The request timed out. Please try again.",
  invalid_request:         "The request could not be processed. Please check your input.",
  safety_block:            "Your message was blocked by the AI safety filter. Please rephrase and try again.",
  internal_error:          "An unexpected error occurred. Please try again.",
};

// ── HTTP status extraction ─────────────────────────────────────────────────────
// Extracts the first 4xx/5xx status code from a provider error message.
// Handles formats produced by llm.ts:
//   "Groq API error 429: {..."     → 429
//   "[400 Bad Request] {..."       → 400
//   "HTTP 503 Service Unavailable" → 503
// Returns null when no status code is present.

function extractHttpStatus(lower: string): number | null {
  const m = lower.match(/(?:error|http|status)[:\s]+([45]\d{2})\b/) ||
            lower.match(/\[([45]\d{2})\s/) ||
            lower.match(/\b([45]\d{2})\b/);
  return m ? parseInt(m[1]!, 10) : null;
}

// ── Provider name extraction ──────────────────────────────────────────────────
// Best-effort: extracts the originating provider from the error message for
// the debug log. Not used for classification.

function extractProvider(lower: string): string {
  if (lower.includes("groq"))                                          return "groq";
  if (lower.includes("generativelanguage") ||
      lower.includes("googlegenerat") ||
      lower.includes("gemini"))                                        return "gemini";
  if (lower.includes("both providers"))                                return "both";
  return "unknown";
}

export function normalizeAIError(err: unknown, system = "unknown"): NormalizedAIError {
  const raw    = err instanceof Error ? err.message : String(err);
  const lower  = raw.toLowerCase();
  const http   = extractHttpStatus(lower);

  // ── 1. Timeout ────────────────────────────────────────────────────────────────
  let code: AIErrorCode;
  if (
    lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline") ||
    lower.includes("stream inactivity")
  )
    code = "timeout";

  // ── 2. provider_not_configured — quota with billing disabled (limit: 0) ───────
  else if (
    (lower.includes("quota") || lower.includes("resource_exhausted")) &&
    lower.includes("limit: 0")
  )
    code = "provider_not_configured";

  // ── 3. rate_limit — 429 / resource_exhausted / quota (without limit:0) ────────
  else if (
    lower.includes("rate limit") || lower.includes("rate-limit") ||
    lower.includes("ratelimit")  || lower.includes("too many requests") ||
    lower.includes("resource_exhausted") ||
    http === 429 || lower.includes("quota")
  )
    code = "rate_limit";

  // ── 4. provider_not_configured — bad key / auth failure (401/403) ─────────────
  else if (
    lower.includes("provider_not_configured") ||
    lower.includes("api key not valid")  || lower.includes("invalid api key") ||
    lower.includes("api key invalid")    || lower.includes("unauthenticated") ||
    lower.includes("permission_denied")  ||
    http === 401 || http === 403
  )
    code = "provider_not_configured";

  // ── 5. feature_disabled — balance / locked / unsupported model ────────────────
  else if (
    lower.includes("exhausted balance") || lower.includes("user is locked") ||
    (lower.includes("fal") &&
      (lower.includes("402") || lower.includes("403") || lower.includes("credit"))) ||
    lower.includes("feature_disabled") || lower.includes("not available") ||
    lower.includes("unsupported_model") || lower.includes("not supported")
  )
    code = "feature_disabled";

  // ── 6. safety_block — content policy / safety filter ─────────────────────────
  // Gemini: "Candidate was blocked due to SAFETY", "finish_reason: SAFETY"
  // Groq:   finish_reason "content_filter" (body text from SSE error)
  // Gemini: "RECITATION" (copyright reproduction refusal)
  else if (
    (lower.includes("safety") &&
      (lower.includes("block") || lower.includes("filter") ||
       lower.includes("candidate") || lower.includes("finish_reason"))) ||
    lower.includes("content_filter") || lower.includes("recitation")
  )
    code = "safety_block";

  // ── 7. invalid_request — 400 / INVALID_ARGUMENT / bad input ──────────────────
  // Covers:  "Groq API error 400: ...", "[400 Bad Request] ...",
  //          "INVALID_ARGUMENT", "bad request", "malformed", bare http===400
  else if (
    lower.includes("invalid_argument") || lower.includes("invalid") ||
    lower.includes("bad request")      || lower.includes("malformed") ||
    http === 400
  )
    code = "invalid_request";

  // ── 8. provider_unavailable — 503 / UNAVAILABLE keyword only ─────────────────
  // "service", "network", "provider" intentionally omitted — see comment above.
  else if (
    lower.includes("unavailable") ||
    http === 503
  )
    code = "provider_unavailable";

  // ── 9. catch-all ──────────────────────────────────────────────────────────────
  else
    code = "internal_error";

  // ── Debug log — raw classification inputs (never surfaced to clients) ─────────
  logger.debug(
    {
      system,
      rawErrorType:        err instanceof Error ? err.constructor.name : typeof err,
      detectedProvider:    extractProvider(lower),
      httpStatus:          http,
      classificationResult: code,
      rawMessage:          raw.slice(0, 300),
    },
    `[AI_ERROR:debug][${system.toUpperCase()}] raw error classification`,
  );

  // ── Structured error log ───────────────────────────────────────────────────────
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
