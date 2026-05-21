/**
 * providerGuard.ts — IB AI Assistant
 *
 * Provider resilience utilities:
 *   - withProviderTimeout: hard deadline on any async provider call
 *   - withProviderRetry: exponential-backoff retry for transient failures
 *   - isTransientError: classify retryable vs fatal errors
 *   - sanitizeProviderError: strip stack traces / internal details from user-facing messages
 *
 * Architecture rules:
 *   - NEVER expose raw provider error messages, stack traces, or API paths to users
 *   - NEVER throw from sanitizeProviderError — always return a string
 *   - All retries are bounded — no infinite loops
 *   - Timeouts use a race pattern; the underlying promise is abandoned (not cancelled)
 */
import { logger } from "./logger";

// ── ProviderError ─────────────────────────────────────────────────────────────

export type ProviderErrorType =
  | "timeout"
  | "rate_limit"
  | "unavailable"
  | "quota"
  | "error";

export class ProviderError extends Error {
  public readonly provider:  string;
  public readonly errorType: ProviderErrorType;

  constructor(provider: string, type: ProviderErrorType, message: string) {
    super(message);
    this.name      = "ProviderError";
    this.provider  = provider;
    this.errorType = type;
  }
}

// ── Transient error classifier ─────────────────────────────────────────────────

const TRANSIENT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /429/,
  /quota/i,
  /overloaded/i,
  /UNAVAILABLE/,
  /503/,
  /timeout/i,
  /timed out/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /socket hang up/i,
  /temporarily/i,
  // Fetch / Web API network errors
  /network error/i,
  /failed to fetch/i,
  /fetch failed/i,
  /AbortError/,
  /load failed/i,
];

export function isTransientError(err: unknown): boolean {
  // ProviderError with a transient type is always transient
  if (err instanceof ProviderError) {
    return (
      err.errorType === "timeout" ||
      err.errorType === "rate_limit" ||
      err.errorType === "unavailable" ||
      err.errorType === "quota"
    );
  }
  // DOMException / AbortError from fetch abort
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "AbortError"
  ) {
    return true;
  }
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit/i.test(msg) || /429/.test(msg) || /quota/i.test(msg);
}

// ── Timeout wrapper ────────────────────────────────────────────────────────────

/**
 * Race fn() against a deadline. Throws ProviderError('timeout') if exceeded.
 * The underlying promise is abandoned but not cancelled.
 */
export function withProviderTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  provider: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ProviderError(
          provider,
          "timeout",
          `${provider} request timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    fn().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err: unknown)   => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

/**
 * Retry fn() on transient errors with exponential backoff.
 * Non-transient errors (model errors, validation errors) are rethrown immediately.
 *
 * @param fn       The async operation to retry
 * @param retries  Number of additional attempts after the first failure
 * @param delayMs  Base delay in ms (doubles each attempt)
 * @param provider Provider name for logging
 */
export async function withProviderRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
  provider: string,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;

      if (!isTransientError(err) || attempt === retries) {
        throw err;
      }

      const wait = delayMs * Math.pow(2, attempt);
      logger.warn(
        { provider, attempt: attempt + 1, retries, waitMs: wait },
        "[providerGuard] transient error — retrying",
      );

      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw lastErr;
}

// ── Error sanitizer ───────────────────────────────────────────────────────────

/**
 * Convert any provider error into a safe, user-facing message.
 * NEVER exposes stack traces, API keys, internal paths, or raw model errors.
 *
 * @param err     The error to sanitize
 * @param context Short description of the operation ("image edit", "generate", etc.)
 */
export function sanitizeProviderError(err: unknown, context: string): string {
  if (err instanceof ProviderError) {
    switch (err.errorType) {
      case "timeout":
        return `${context} timed out. Please try again.`;
      case "rate_limit":
        return "Service is busy. Please try again in a moment.";
      case "quota":
        return "Usage limit reached. Please try again later.";
      case "unavailable":
        return "AI service is temporarily unavailable. Please try again.";
      default:
        return `${context} failed. Please try again.`;
    }
  }

  if (isRateLimitError(err)) {
    return "Service is busy. Please try again in a moment.";
  }

  if (isTransientError(err)) {
    return "Service temporarily unavailable. Please try again.";
  }

  const msg = err instanceof Error ? err.message : "";

  // Pass through already-sanitized messages from the service layer
  if (
    msg.includes("Unsupported image type") ||
    msg.includes("No image supplied") ||
    msg.includes("Image too large") ||
    msg.includes("temporarily") ||
    msg.includes("overloaded") ||
    msg.includes("Please retry") ||
    msg.includes("please try again") ||
    msg.includes("Please try again") ||
    msg.includes("rate limit")
  ) {
    return msg;
  }

  // Catch-all — never expose internals
  return `${context} failed. Please try again.`;
}
