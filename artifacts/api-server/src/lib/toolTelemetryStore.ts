/**
 * toolTelemetryStore.ts — IB AI Assistant
 *
 * Rolling in-memory call log per tool. Stores the last MAX_ENTRIES calls.
 * Used by the debug endpoint and the system-health API.
 *
 * Persistence: in-memory only — resets on restart.
 * Stub exports are provided for future DB/Redis integration (replace
 * appendCall / getLastNCalls / getCallStats with async equivalents).
 *
 * Architecture rules:
 *   - Write path: appendCall()  — called after every trackToolExecution
 *   - Read path:  getLastNCalls(), getCallStats(), getAllCallStats()
 *   - No external dependencies
 */

export type ToolName = "groq" | "gemini" | "tts" | "image" | "video" | "prompt";

export interface TelemetryEntry {
  ts:           number;
  success:      boolean;
  latencyMs:    number;
  errorMessage: string | null;
}

export interface CallStats {
  totalCalls:   number;
  successRate:  number | null;
  avgLatencyMs: number | null;
  failureCount: number;
}

const MAX_ENTRIES = 100;
const ALL_TOOLS: ToolName[] = ["groq", "gemini", "tts", "image", "video", "prompt"];

const store = new Map<ToolName, TelemetryEntry[]>(ALL_TOOLS.map((t) => [t, []]));

// ── Write ─────────────────────────────────────────────────────────────────────

export function appendCall(
  tool:         ToolName,
  latencyMs:    number,
  success:      boolean,
  errorMessage: string | null = null,
): void {
  let buf = store.get(tool);
  if (!buf) { buf = []; store.set(tool, buf); }
  buf.push({ ts: Date.now(), success, latencyMs, errorMessage });
  if (buf.length > MAX_ENTRIES) buf.shift();
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getLastNCalls(tool: ToolName, n: number): TelemetryEntry[] {
  return (store.get(tool) ?? []).slice(-n);
}

export function getCallStats(tool: ToolName): CallStats {
  const buf = store.get(tool) ?? [];
  if (buf.length === 0) {
    return { totalCalls: 0, successRate: null, avgLatencyMs: null, failureCount: 0 };
  }
  const successes    = buf.filter((e) => e.success).length;
  const totalLatency = buf.reduce((a, e) => a + e.latencyMs, 0);
  return {
    totalCalls:   buf.length,
    successRate:  Math.round((successes / buf.length) * 100),
    avgLatencyMs: Math.round(totalLatency / buf.length),
    failureCount: buf.length - successes,
  };
}

export function getAllCallStats(): Record<string, CallStats> {
  const out: Record<string, CallStats> = {};
  for (const t of ALL_TOOLS) out[t] = getCallStats(t);
  return out;
}

export function getAllLastNCalls(n: number): Record<string, TelemetryEntry[]> {
  const out: Record<string, TelemetryEntry[]> = {};
  for (const t of ALL_TOOLS) out[t] = getLastNCalls(t, n);
  return out;
}
