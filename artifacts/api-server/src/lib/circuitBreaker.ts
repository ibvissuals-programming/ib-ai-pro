/**
 * circuitBreaker.ts — IB AI Assistant
 *
 * Per-tool circuit breaker. Prevents hammering a failing provider.
 *
 * States:
 *   closed    — operating normally
 *   open      — fast-fail until cooldown elapses
 *   half-open — one test call allowed; success → closed, failure → re-opens
 *
 * Thresholds (conservative, non-disruptive):
 *   Opens after  FAILURE_THRESHOLD (5) failures in the last WINDOW_SIZE (20) calls
 *   Stays open   OPEN_DURATION_MS (30 s)
 *   Auto-resets  to half-open after cooldown
 *
 * Contract:
 *   - checkCircuit()        — call BEFORE executing a tool fn
 *   - recordCircuitOutcome() — call AFTER execution (success or failure)
 *   - Does NOT throw — callers decide what to do with { allowed: false }
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitStatus {
  state:        CircuitState;
  failureCount: number;
  windowSize:   number;
  openedAt:     number | null;
  totalTripped: number;
  cooldownMs:   number | null;
}

interface CircuitData {
  state:        CircuitState;
  window:       boolean[];
  openedAt:     number | null;
  totalTripped: number;
  halfOpenTest: boolean;
}

const ALL_TOOLS      = ["groq", "gemini", "tts", "image", "video", "prompt"] as const;
type  ToolName       = typeof ALL_TOOLS[number];

const WINDOW_SIZE       = 20;
const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS  = 30_000;

function fresh(): CircuitData {
  return { state: "closed", window: [], openedAt: null, totalTripped: 0, halfOpenTest: false };
}

const circuits = new Map<ToolName, CircuitData>(ALL_TOOLS.map((t) => [t, fresh()]));

function get(tool: ToolName): CircuitData {
  let c = circuits.get(tool);
  if (!c) { c = fresh(); circuits.set(tool, c); }
  return c;
}

function failures(w: boolean[]): number {
  return w.filter((v) => !v).length;
}

// ── Check (may transition open → half-open) ───────────────────────────────────

export function checkCircuit(tool: ToolName): { allowed: boolean; state: CircuitState } {
  const c   = get(tool);
  const now = Date.now();

  if (c.state === "open") {
    if (c.openedAt !== null && now - c.openedAt >= OPEN_DURATION_MS) {
      c.state       = "half-open";
      c.halfOpenTest = false;
      return { allowed: true, state: "half-open" };
    }
    return { allowed: false, state: "open" };
  }

  if (c.state === "half-open") {
    if (c.halfOpenTest) return { allowed: false, state: "open" };
    c.halfOpenTest = true;
    return { allowed: true, state: "half-open" };
  }

  return { allowed: true, state: "closed" };
}

// ── Record outcome ─────────────────────────────────────────────────────────────

export function recordCircuitOutcome(tool: ToolName, success: boolean): void {
  const c = get(tool);

  if (c.state === "half-open") {
    c.halfOpenTest = false;
    if (success) {
      c.state    = "closed";
      c.window   = [];
      c.openedAt = null;
    } else {
      c.state      = "open";
      c.openedAt   = Date.now();
      c.totalTripped++;
    }
    return;
  }

  c.window.push(success);
  if (c.window.length > WINDOW_SIZE) c.window.shift();

  if (c.state === "closed" && failures(c.window) >= FAILURE_THRESHOLD) {
    c.state      = "open";
    c.openedAt   = Date.now();
    c.totalTripped++;
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getCircuitStatus(tool: ToolName): CircuitStatus {
  const c   = get(tool);
  const now = Date.now();
  return {
    state:        c.state,
    failureCount: failures(c.window),
    windowSize:   c.window.length,
    openedAt:     c.openedAt,
    totalTripped: c.totalTripped,
    cooldownMs:
      c.state === "open" && c.openedAt !== null
        ? Math.max(0, OPEN_DURATION_MS - (now - c.openedAt))
        : null,
  };
}

export function getAllCircuitStatuses(): Record<string, CircuitStatus> {
  const out: Record<string, CircuitStatus> = {};
  for (const t of ALL_TOOLS) out[t] = getCircuitStatus(t);
  return out;
}
