/**
 * bootController.ts — IB AI Assistant
 *
 * Single source of truth for system boot state.
 * Tracks each bootstrap phase and exposes isSystemOperational() / isDegradedMode().
 *
 * Boot phases (in declaration order):
 *   CONFIG  — system config loaded (before auth)
 *   AUTH    — user store + CEO account ready
 *   AI      — AI provider verified (safe mode set if missing)
 *   SYSTEMS — image queue / TTS / job recovery complete
 *   COMPLETE — server is listening and fully ready
 *
 * Boot timeout guard:
 *   If COMPLETE is not reached within 10 seconds, the system forces COMPLETE
 *   with degraded=true. This prevents any "waiting forever" state.
 *
 * Backward compatibility:
 *   markBootDegraded() internally calls setBootDegraded() from bootState.ts
 *   so all existing route imports of bootState.ts continue to work.
 *
 * Rules:
 *   - Never throws
 *   - All reads (isSystemOperational, isDegradedMode, getBootStatus) are synchronous
 *   - Boot timeout uses .unref() so it does NOT prevent process exit
 */

import { setBootDegraded } from "./bootState";

export type BootPhase = "CONFIG" | "AUTH" | "AI" | "SYSTEMS" | "COMPLETE";

const PHASE_ORDER: BootPhase[] = ["CONFIG", "AUTH", "AI", "SYSTEMS", "COMPLETE"];
const BOOT_TIMEOUT_MS = 10_000;

interface BootState {
  currentPhase:      BootPhase | "PENDING";
  phasesComplete:    Set<BootPhase>;
  degraded:          boolean;
  degradedReasons:   string[];
  startedAt:         number;
  completedAt:       number | null;
  timedOut:          boolean;
}

const _state: BootState = {
  currentPhase:    "PENDING",
  phasesComplete:  new Set(),
  degraded:        false,
  degradedReasons: [],
  startedAt:       Date.now(),
  completedAt:     null,
  timedOut:        false,
};

// ── 10-second global boot timeout ─────────────────────────────────────────────
// If the server does not reach COMPLETE within 10s, it enters degraded mode.
// .unref() so this timer does NOT prevent the Node.js process from exiting
// if something else shuts it down before the timeout fires.

const _bootTimeoutHandle = setTimeout(() => {
  if (_state.currentPhase !== "COMPLETE") {
    _state.currentPhase = "COMPLETE";
    _state.completedAt  = Date.now();
    _state.timedOut     = true;
    if (!_state.degraded) {
      _state.degraded = true;
      _state.degradedReasons.push(
        `Boot timeout — system entered degraded mode after ${BOOT_TIMEOUT_MS}ms (phase was: ${_state.currentPhase})`
      );
      setBootDegraded();
    }
  }
}, BOOT_TIMEOUT_MS).unref();

// ── Phase transitions ─────────────────────────────────────────────────────────

/**
 * Mark a boot phase as complete. Phases may be marked in any order,
 * but COMPLETE is treated specially: clears the timeout and records completedAt.
 */
export function markBootPhase(phase: BootPhase): void {
  _state.phasesComplete.add(phase);
  // Only advance currentPhase if it is the next one in the declared order
  const nextIndex = PHASE_ORDER.indexOf(phase);
  const currentIndex = _state.currentPhase === "PENDING"
    ? -1
    : PHASE_ORDER.indexOf(_state.currentPhase as BootPhase);
  if (nextIndex > currentIndex) {
    _state.currentPhase = phase;
  }
  if (phase === "COMPLETE") {
    clearTimeout(_bootTimeoutHandle);
    if (!_state.completedAt) {
      _state.completedAt = Date.now();
    }
  }
}

/**
 * Record a degraded condition. Calls setBootDegraded() for backward compat
 * with existing bootState.ts imports across routes.
 */
export function markBootDegraded(reason: string): void {
  if (!_state.degradedReasons.includes(reason)) {
    _state.degraded = true;
    _state.degradedReasons.push(reason);
  }
  setBootDegraded(); // keep bootState.ts in sync
}

// ── Operational queries ───────────────────────────────────────────────────────

/** True only when COMPLETE was reached AND no degraded conditions were recorded. */
export function isSystemOperational(): boolean {
  return _state.phasesComplete.has("COMPLETE") && !_state.degraded;
}

/** True if any degraded condition was recorded. */
export function isDegradedMode(): boolean {
  return _state.degraded;
}

/** True when the boot sequence finished (either normally or via timeout). */
export function isBootComplete(): boolean {
  return _state.phasesComplete.has("COMPLETE") || _state.timedOut;
}

/** True while any phase is still pending. */
export function isBooting(): boolean {
  return !isBootComplete();
}

/**
 * Structured boot status snapshot — used by /api/system/ready and health routes.
 */
export interface BootStatusSnapshot {
  phase:           string;
  complete:        boolean;
  booting:         boolean;
  degraded:        boolean;
  degradedReasons: string[];
  uptimeMs:        number;
  timedOut:        boolean;
  phasesComplete:  string[];
}

export function getBootStatus(): BootStatusSnapshot {
  return {
    phase:           _state.currentPhase,
    complete:        isBootComplete(),
    booting:         isBooting(),
    degraded:        _state.degraded,
    degradedReasons: [..._state.degradedReasons],
    uptimeMs:        Date.now() - _state.startedAt,
    timedOut:        _state.timedOut,
    phasesComplete:  [..._state.phasesComplete],
  };
}
