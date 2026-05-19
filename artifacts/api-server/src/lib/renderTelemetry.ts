/**
 * renderTelemetry — in-memory render pipeline telemetry store.
 *
 * Captures structured diagnostic data after every editImage() call:
 *   renderProfile, intensity, retryCount, verifierOutcome,
 *   processingDurationMs, qualityVerified, qualityIssues, contractVersion.
 *
 * Ring buffer — newest entries kept. Never blocks the edit pipeline.
 * Thread-safe for single-process Node.js. No persistence (restarts clear it).
 */

export type VerifierOutcome = "PASS" | "FAIL" | "SKIPPED";

export interface RenderTelemetryEntry {
  id: string;
  timestamp: number;
  userId?: string;
  renderProfile: string;
  intensity: string;
  retryCount: number;
  qualityVerified: boolean;
  qualityIssues: string[];
  verifierOutcome: VerifierOutcome;
  processingDurationMs: number;
  contractVersion: string;
  promptUsed?: string;
  cinematicAnalysisUsed?: boolean;
}

const MAX_ENTRIES = 200;
const _entries: RenderTelemetryEntry[] = [];
let _seq = 0;

function nextId(): string {
  _seq += 1;
  return `rt-${Date.now()}-${_seq}`;
}

export function pushRenderTelemetry(
  entry: Omit<RenderTelemetryEntry, "id" | "timestamp">,
): void {
  _entries.push({ id: nextId(), timestamp: Date.now(), ...entry });
  if (_entries.length > MAX_ENTRIES) _entries.shift();
}

export function getRenderTelemetry(limit = 50): RenderTelemetryEntry[] {
  const n = Math.min(Math.max(1, limit), _entries.length);
  return _entries.slice(-n).reverse();
}

export interface RenderTelemetryStats {
  total: number;
  avgDurationMs: number;
  passRate: number;
  retryRate: number;
  profileDistribution: Record<string, number>;
  intensityDistribution: Record<string, number>;
  verifierOutcomeDistribution: Record<VerifierOutcome, number>;
}

export function getRenderTelemetryStats(): RenderTelemetryStats {
  const total = _entries.length;

  if (total === 0) {
    return {
      total: 0,
      avgDurationMs: 0,
      passRate: 0,
      retryRate: 0,
      profileDistribution: {},
      intensityDistribution: {},
      verifierOutcomeDistribution: { PASS: 0, FAIL: 0, SKIPPED: 0 },
    };
  }

  const passed  = _entries.filter((e) => e.qualityVerified).length;
  const retried = _entries.filter((e) => e.retryCount > 0).length;
  const totalMs = _entries.reduce((s, e) => s + e.processingDurationMs, 0);

  const profileDistribution: Record<string, number> = {};
  const intensityDistribution: Record<string, number> = {};
  const verifierOutcomeDistribution: Record<VerifierOutcome, number> = { PASS: 0, FAIL: 0, SKIPPED: 0 };

  for (const e of _entries) {
    profileDistribution[e.renderProfile]   = (profileDistribution[e.renderProfile]   ?? 0) + 1;
    intensityDistribution[e.intensity]     = (intensityDistribution[e.intensity]     ?? 0) + 1;
    verifierOutcomeDistribution[e.verifierOutcome] += 1;
  }

  return {
    total,
    avgDurationMs: Math.round(totalMs / total),
    passRate:      Math.round((passed  / total) * 100),
    retryRate:     Math.round((retried / total) * 100),
    profileDistribution,
    intensityDistribution,
    verifierOutcomeDistribution,
  };
}
