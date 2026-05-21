import { isGeminiConfigured } from "./geminiEnv";
import { recordToolCall }    from "./toolHealthMonitor";
import { appendCall }        from "./toolTelemetryStore";

/**
 * AI Routing Metrics — IB AI Assistant
 *
 * In-memory singleton tracking per-provider routing performance.
 * Ephemeral — data resets on server restart. No external dependencies.
 *
 * Architecture rules:
 *   - recordCompletion() is the ONLY write path. Call it after every AI request.
 *   - Never log API keys, full prompts, or user content here.
 *   - All operations are synchronous — no async, no risk of concurrent mutation.
 *   - getAiStatus() is safe to call on every request (read-only, O(1)).
 */

export type AiProvider = "groq" | "gemini";

// ── Per-provider counters ──────────────────────────────────────────────────────

interface ProviderStats {
  requests: number;
  successes: number;
  errors: number;
  totalLatencyMs: number;
  lastUsedAt: number | null;
}

function freshStats(): ProviderStats {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    totalLatencyMs: 0,
    lastUsedAt: null,
  };
}

const providerStats: Record<AiProvider, ProviderStats> = {
  groq: freshStats(),
  gemini: freshStats(),
};

// ── Fallback counters ─────────────────────────────────────────────────────────

let fallbackCount = 0;
let lastFallbackAt: number | null = null;

// ── Write path ────────────────────────────────────────────────────────────────

/**
 * recordCompletion — call once per AI request when the stream finishes or errors.
 *
 * @param provider         Which provider served (or attempted) the request.
 * @param fallbackTriggered Whether this request involved a Groq→Gemini fallback.
 * @param latencyMs        Total duration from routing start to stream completion.
 * @param success          true if the stream completed without error.
 */
export function recordCompletion(
  provider: AiProvider,
  fallbackTriggered: boolean,
  latencyMs: number,
  success: boolean,
): void {
  const p = providerStats[provider];
  p.requests++;
  p.totalLatencyMs += latencyMs;
  p.lastUsedAt = Date.now();

  if (success) {
    p.successes++;
  } else {
    p.errors++;
  }

  if (fallbackTriggered) {
    fallbackCount++;
    lastFallbackAt = Date.now();
  }

  // Forward to unified tool health monitor (Groq + Gemini LLM paths)
  recordToolCall(provider, latencyMs, success, { fallback: fallbackTriggered });
  // Forward to rolling telemetry store
  appendCall(provider, latencyMs, success);
}

// ── Read paths ────────────────────────────────────────────────────────────────

export interface AiStatus {
  activeProvider: AiProvider | "none";
  groqAvailable: boolean;
  geminiAvailable: boolean;
  lastFallback: number | null;
  avgLatencyGroq: number | null;
  avgLatencyGemini: number | null;
  successRateGroq: number | null;
  successRateGemini: number | null;
  fallbackRate: number | null;
  totalRequests: number;
  fallbackCount: number;
}

/**
 * getAiStatus — returns the shape required by GET /api/system/ai-status.
 * Read-only, O(1). Safe to call on every request.
 */
export function getAiStatus(): AiStatus {
  const groqConfigured = !!process.env["GROQ_API_KEY"];
  const geminiConfigured = isGeminiConfigured();

  const groq = providerStats.groq;
  const gemini = providerStats.gemini;

  const avgLatencyGroq =
    groq.requests > 0 ? Math.round(groq.totalLatencyMs / groq.requests) : null;
  const avgLatencyGemini =
    gemini.requests > 0
      ? Math.round(gemini.totalLatencyMs / gemini.requests)
      : null;

  const successRateGroq =
    groq.requests > 0
      ? Math.round((groq.successes / groq.requests) * 100)
      : null;
  const successRateGemini =
    gemini.requests > 0
      ? Math.round((gemini.successes / gemini.requests) * 100)
      : null;

  const totalRequests = groq.requests + gemini.requests;
  const fallbackRate =
    totalRequests > 0
      ? Math.round((fallbackCount / totalRequests) * 100)
      : null;

  // Active provider = whichever was used most recently
  let activeProvider: AiProvider | "none" = "none";
  if (
    groq.lastUsedAt !== null &&
    (gemini.lastUsedAt === null || groq.lastUsedAt >= gemini.lastUsedAt)
  ) {
    activeProvider = "groq";
  } else if (gemini.lastUsedAt !== null) {
    activeProvider = "gemini";
  }

  return {
    activeProvider,
    groqAvailable: groqConfigured,
    geminiAvailable: geminiConfigured,
    lastFallback: lastFallbackAt,
    avgLatencyGroq,
    avgLatencyGemini,
    successRateGroq,
    successRateGemini,
    fallbackRate,
    totalRequests,
    fallbackCount,
  };
}

export interface RawAiMetrics {
  groq: ProviderStats;
  gemini: ProviderStats;
  fallbackCount: number;
  lastFallbackAt: number | null;
}

/**
 * getRawMetrics — returns a snapshot of raw counters.
 * Intended for the CEO dashboard extended view.
 */
export function getRawMetrics(): RawAiMetrics {
  return {
    groq: { ...providerStats.groq },
    gemini: { ...providerStats.gemini },
    fallbackCount,
    lastFallbackAt,
  };
}
