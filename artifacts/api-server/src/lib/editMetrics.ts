/**
 * editMetrics.ts — In-memory edit quality metrics tracker
 *
 * Lightweight, zero-dependency tracker for the CEO Edit Quality Observability panel.
 * Stores rolling stats in memory — reset on server restart, no DB dependency.
 *
 * Tracked:
 *   - Total edits attempted / succeeded / failed
 *   - Retry events (identity drift, stage failure, intensity downgrade)
 *   - Latency samples (rolling avg, p95)
 *   - Mode usage distribution
 *   - Top failure categories
 */

export type RetryReason = "stage_failure" | "intensity_downgrade" | "mode_downgrade" | "timeout";
export type FailureCategory = "model_rejection" | "timeout" | "provider_error" | "validation" | "unknown";

interface LatencySample {
  ms:        number;
  timestamp: number;
}

interface EditMetricsState {
  totalAttempts:   number;
  successes:       number;
  failures:        number;
  retries:         number;
  retryReasons:    Record<RetryReason, number>;
  failureCategories: Record<FailureCategory, number>;
  modeUsage:       Record<string, number>;
  latencySamples:  LatencySample[];
  lastUpdated:     number;
}

const MAX_LATENCY_SAMPLES = 200;

const state: EditMetricsState = {
  totalAttempts:   0,
  successes:       0,
  failures:        0,
  retries:         0,
  retryReasons:    { stage_failure: 0, intensity_downgrade: 0, mode_downgrade: 0, timeout: 0 },
  failureCategories: { model_rejection: 0, timeout: 0, provider_error: 0, validation: 0, unknown: 0 },
  modeUsage:       {},
  latencySamples:  [],
  lastUpdated:     Date.now(),
};

export function recordEditAttempt(mode: string): void {
  state.totalAttempts++;
  state.modeUsage[mode] = (state.modeUsage[mode] ?? 0) + 1;
  state.lastUpdated = Date.now();
}

export function recordEditSuccess(latencyMs: number): void {
  state.successes++;
  state.latencySamples.push({ ms: latencyMs, timestamp: Date.now() });
  if (state.latencySamples.length > MAX_LATENCY_SAMPLES) {
    state.latencySamples.shift();
  }
  state.lastUpdated = Date.now();
}

export function recordEditFailure(category: FailureCategory = "unknown"): void {
  state.failures++;
  state.failureCategories[category]++;
  state.lastUpdated = Date.now();
}

export function recordEditRetry(reason: RetryReason): void {
  state.retries++;
  state.retryReasons[reason]++;
  state.lastUpdated = Date.now();
}

function computeP95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export function getEditMetrics() {
  const latencyMs = state.latencySamples.map((s) => s.ms);
  const avgLatency = latencyMs.length > 0
    ? Math.round(latencyMs.reduce((a, b) => a + b, 0) / latencyMs.length)
    : 0;
  const p95Latency = Math.round(computeP95(latencyMs));

  const successRate = state.totalAttempts > 0
    ? Math.round((state.successes / state.totalAttempts) * 100)
    : 100;

  const retryRate = state.totalAttempts > 0
    ? Math.round((state.retries / state.totalAttempts) * 100)
    : 0;

  // Stability score: weighted combo of successRate, low retryRate, low failure categories
  const stabilityScore = Math.round(
    successRate * 0.6 +
    (100 - Math.min(retryRate * 2, 100)) * 0.25 +
    (state.failures === 0 ? 100 : Math.max(0, 100 - state.failures * 5)) * 0.15,
  );

  const topFailureCategories = Object.entries(state.failureCategories)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k, v]) => ({ category: k, count: v }));

  const modePopularity = Object.entries(state.modeUsage)
    .sort(([, a], [, b]) => b - a)
    .map(([mode, count]) => ({ mode, count }));

  return {
    totalAttempts:       state.totalAttempts,
    successes:           state.successes,
    failures:            state.failures,
    retries:             state.retries,
    successRate,
    retryRate,
    stabilityScore:      Math.min(100, Math.max(0, stabilityScore)),
    avgLatencyMs:        avgLatency,
    p95LatencyMs:        p95Latency,
    retryReasons:        state.retryReasons,
    topFailureCategories,
    modePopularity,
    lastUpdated:         new Date(state.lastUpdated).toISOString(),
  };
}
