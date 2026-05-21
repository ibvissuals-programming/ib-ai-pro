/**
 * toolHealthMonitor.ts — IB AI Assistant
 *
 * Real-time in-memory health profiler for all AI tools.
 * Tracks latency, success/failure rates, fallback usage, and retry counts
 * per tool and computes a live system stability score.
 *
 * Tools tracked:
 *   groq    — Groq LLM (Llama) streaming
 *   gemini  — Gemini text/vision fallback + prompt expand + cinematic
 *   tts     — Text-to-speech (Gemini 2.0 Flash audio)
 *   image   — Image generation (Pollinations) + image editing (Gemini)
 *   video   — Image-to-video pipeline
 *   prompt  — Prompt expansion (Gemini 2.5 Flash)
 *
 * Architecture rules:
 *   - ONLY write path: recordToolCall() / trackToolExecution()
 *   - ONLY read path:  getHealthMatrix() / getSystemScore() / getDebugData()
 *   - NO external deps — purely in-memory, resets on server restart
 *   - trackToolExecution() NEVER modifies tool output — forwards result unchanged
 *   - All operations are synchronous (except trackToolExecution which is async)
 *   - Never log API keys, prompts, or user content
 */
import { logger } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolName =
  | "groq"
  | "gemini"
  | "tts"
  | "image"
  | "video"
  | "prompt";

export type ToolStatus = "healthy" | "degraded" | "failing" | "offline";

export interface RecordOptions {
  errorMessage?: string;
  fallback?:     boolean;
  retryCount?:   number;
}

interface WindowEntry {
  ts:        number;
  success:   boolean;
  latencyMs: number;
}

interface ToolHealthState {
  totalCalls:     number;
  successCount:   number;
  failureCount:   number;
  totalLatencyMs: number;
  latencySamples: number[];
  lastError:      string | null;
  lastSuccessAt:  number | null;
  lastFailureAt:  number | null;
  fallbackCount:  number;
  retryCount:     number;
  window:         WindowEntry[];
}

// ── Config ────────────────────────────────────────────────────────────────────

const ALL_TOOLS: ToolName[] = ["groq", "gemini", "tts", "image", "video", "prompt"];

const WINDOW_SIZE      = 100;   // sliding window depth per tool
const LATENCY_SAMPLES  = 20;    // rolling samples for latency stats

// Status thresholds (% success rate over recent window)
const THRESHOLD_HEALTHY  = 90;
const THRESHOLD_DEGRADED = 50;

// Latency score: 0 ms = 100 pts, LATENCY_CEILING ms = 0 pts (linear)
const LATENCY_CEILING_MS = 5_000;

// ── Registry ──────────────────────────────────────────────────────────────────

function freshState(): ToolHealthState {
  return {
    totalCalls:     0,
    successCount:   0,
    failureCount:   0,
    totalLatencyMs: 0,
    latencySamples: [],
    lastError:      null,
    lastSuccessAt:  null,
    lastFailureAt:  null,
    fallbackCount:  0,
    retryCount:     0,
    window:         [],
  };
}

const registry = new Map<ToolName, ToolHealthState>(
  ALL_TOOLS.map((name) => [name, freshState()])
);

function getState(tool: ToolName): ToolHealthState {
  let s = registry.get(tool);
  if (!s) { s = freshState(); registry.set(tool, s); }
  return s;
}

// ── Write path ────────────────────────────────────────────────────────────────

/**
 * recordToolCall — single write path for all tool health data.
 * Called by trackToolExecution and by aiMetrics for LLM providers.
 */
export function recordToolCall(
  tool:      ToolName,
  latencyMs: number,
  success:   boolean,
  opts:      RecordOptions = {},
): void {
  const s = getState(tool);

  s.totalCalls++;
  s.totalLatencyMs += latencyMs;

  s.latencySamples.push(latencyMs);
  if (s.latencySamples.length > LATENCY_SAMPLES) s.latencySamples.shift();

  s.window.push({ ts: Date.now(), success, latencyMs });
  if (s.window.length > WINDOW_SIZE) s.window.shift();

  if (success) {
    s.successCount++;
    s.lastSuccessAt = Date.now();
  } else {
    s.failureCount++;
    s.lastFailureAt = Date.now();
    if (opts.errorMessage) {
      s.lastError = opts.errorMessage.slice(0, 200);
    }
  }

  if (opts.fallback)    s.fallbackCount += 1;
  if (opts.retryCount)  s.retryCount    += opts.retryCount;
}

// ── trackToolExecution ────────────────────────────────────────────────────────

/**
 * Wrap any async tool call. Times execution, records result into the registry.
 * Result and thrown errors are forwarded completely unchanged to the caller.
 *
 * Usage:
 *   const result = await trackToolExecution("tts", () => generateSpeech(text, voice, jobId));
 *   const data   = await trackToolExecution("image", () => generateImage(prompt, userId));
 */
export async function trackToolExecution<T>(
  tool: ToolName,
  fn:   () => Promise<T>,
  opts: RecordOptions = {},
): Promise<T> {
  const startMs = Date.now();
  try {
    const result = await fn();
    recordToolCall(tool, Date.now() - startMs, true, opts);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordToolCall(tool, Date.now() - startMs, false, { ...opts, errorMessage: msg });
    throw err;
  }
}

// ── Read helpers ──────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function windowSuccessRate(s: ToolHealthState): number {
  if (s.window.length === 0) return 0;
  return Math.round((s.window.filter((e) => e.success).length / s.window.length) * 100);
}

function avgLatency(s: ToolHealthState): number | null {
  if (s.latencySamples.length === 0) return null;
  return Math.round(s.latencySamples.reduce((a, b) => a + b, 0) / s.latencySamples.length);
}

function toolStatus(s: ToolHealthState): ToolStatus {
  if (s.totalCalls === 0)                      return "offline";
  const rate = windowSuccessRate(s);
  if (rate >= THRESHOLD_HEALTHY)               return "healthy";
  if (rate >= THRESHOLD_DEGRADED)              return "degraded";
  return "failing";
}

// ── Public read paths ─────────────────────────────────────────────────────────

export interface ToolHealthSummary {
  status:        ToolStatus;
  latency:       number | null;
  successRate:   number | null;
  lastError:     string | null;
  totalCalls:    number;
  failureCount:  number;
  fallbackCount: number;
  retryCount:    number;
  lastSuccessAt: number | null;
}

export interface HealthMatrix {
  groq:   ToolHealthSummary;
  gemini: ToolHealthSummary;
  tts:    ToolHealthSummary;
  image:  ToolHealthSummary;
  video:  ToolHealthSummary;
  prompt: ToolHealthSummary;
}

function toSummary(s: ToolHealthState): ToolHealthSummary {
  return {
    status:        toolStatus(s),
    latency:       avgLatency(s),
    successRate:   s.totalCalls > 0 ? windowSuccessRate(s) : null,
    lastError:     s.lastError,
    totalCalls:    s.totalCalls,
    failureCount:  s.failureCount,
    fallbackCount: s.fallbackCount,
    retryCount:    s.retryCount,
    lastSuccessAt: s.lastSuccessAt,
  };
}

export function getHealthMatrix(): HealthMatrix {
  return {
    groq:   toSummary(getState("groq")),
    gemini: toSummary(getState("gemini")),
    tts:    toSummary(getState("tts")),
    image:  toSummary(getState("image")),
    video:  toSummary(getState("video")),
    prompt: toSummary(getState("prompt")),
  };
}

// ── System stability score ────────────────────────────────────────────────────
//
// GlobalScore = weighted average of four sub-scores (all 0–100):
//   success rate     40% — overall cross-tool success rate
//   latency stability 30% — average latency vs ceiling (lower = better)
//   fallback rate    20% — frequency of Groq→Gemini fallbacks
//   error frequency  10% — overall failure call percentage

export interface SystemScore {
  global: number;
  breakdown: {
    successRate:      number;
    latencyStability: number;
    fallbackRate:     number;
    errorFrequency:   number;
  };
}

export function getSystemScore(): SystemScore {
  const states = ALL_TOOLS.map((n) => getState(n));

  // success rate score
  const totalCalls   = states.reduce((a, s) => a + s.totalCalls,   0);
  const totalSuccess = states.reduce((a, s) => a + s.successCount, 0);
  const successRateScore = totalCalls > 0
    ? Math.round((totalSuccess / totalCalls) * 100)
    : 100;

  // latency stability score
  const allSamples = states.flatMap((s) => s.latencySamples);
  let latencyStability = 100;
  if (allSamples.length > 0) {
    const avg = allSamples.reduce((a, b) => a + b, 0) / allSamples.length;
    latencyStability = clamp(Math.round(100 - (avg / LATENCY_CEILING_MS) * 100), 0, 100);
  }

  // fallback rate score (each 1% of calls being a fallback costs 2 pts)
  const totalFallbacks  = states.reduce((a, s) => a + s.fallbackCount, 0);
  const fallbackRateScore = totalCalls > 0
    ? clamp(Math.round(100 - (totalFallbacks / totalCalls) * 100 * 2), 0, 100)
    : 100;

  // error frequency score
  const totalFailures    = states.reduce((a, s) => a + s.failureCount, 0);
  const errorFrequencyScore = totalCalls > 0
    ? clamp(Math.round(100 - (totalFailures / totalCalls) * 100), 0, 100)
    : 100;

  const global = clamp(
    Math.round(
      successRateScore   * 0.40 +
      latencyStability   * 0.30 +
      fallbackRateScore  * 0.20 +
      errorFrequencyScore * 0.10,
    ),
    0,
    100,
  );

  return {
    global,
    breakdown: {
      successRate:      successRateScore,
      latencyStability,
      fallbackRate:     fallbackRateScore,
      errorFrequency:   errorFrequencyScore,
    },
  };
}

// ── Debug data ────────────────────────────────────────────────────────────────

export interface DebugData {
  recentWindow:       Record<ToolName, WindowEntry[]>;
  perToolRawCounts:   Record<ToolName, { totalCalls: number; success: number; failures: number; fallbacks: number; retries: number }>;
  systemScoreWeights: { success: number; latency: number; fallback: number; errors: number };
  requestTimestamp:   string;
  uptimeMs:           number;
}

const MONITOR_START = Date.now();

export function getDebugData(): DebugData {
  const recentWindow     = {} as Record<ToolName, WindowEntry[]>;
  const perToolRawCounts = {} as Record<ToolName, { totalCalls: number; success: number; failures: number; fallbacks: number; retries: number }>;

  for (const name of ALL_TOOLS) {
    const s = getState(name);
    recentWindow[name]     = s.window.slice(-10);
    perToolRawCounts[name] = {
      totalCalls: s.totalCalls,
      success:    s.successCount,
      failures:   s.failureCount,
      fallbacks:  s.fallbackCount,
      retries:    s.retryCount,
    };
  }

  return {
    recentWindow,
    perToolRawCounts,
    systemScoreWeights: { success: 0.40, latency: 0.30, fallback: 0.20, errors: 0.10 },
    requestTimestamp:   new Date().toISOString(),
    uptimeMs:           Date.now() - MONITOR_START,
  };
}

// Keep logger in scope for future per-tool anomaly logging
void logger;
