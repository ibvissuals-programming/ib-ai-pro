/**
 * aiJobStates.ts — IB AI Assistant
 *
 * Canonical job state definitions shared across all AI systems.
 * (Image, TTS, Video, Prompt Expansion)
 *
 * Lifecycle:
 *   QUEUED → PROCESSING → COMPLETED
 *                       ↘ FAILED
 *
 * Maps from internal JobStatus values (which may include legacy
 * variants like "success", "retrying", "streaming") to the four
 * canonical states exposed in the standardized API response.
 */

// ── Canonical 4-state lifecycle ───────────────────────────────────────────────

export enum AI_JOB_STATES {
  QUEUED     = "queued",
  PROCESSING = "processing",
  COMPLETED  = "completed",
  FAILED     = "failed",
}

// ── Transition rules ──────────────────────────────────────────────────────────

export const AI_JOB_TRANSITIONS: Record<AI_JOB_STATES, AI_JOB_STATES[]> = {
  [AI_JOB_STATES.QUEUED]:     [AI_JOB_STATES.PROCESSING, AI_JOB_STATES.FAILED],
  [AI_JOB_STATES.PROCESSING]: [AI_JOB_STATES.COMPLETED, AI_JOB_STATES.FAILED],
  [AI_JOB_STATES.COMPLETED]:  [],
  [AI_JOB_STATES.FAILED]:     [],
};

// ── Canonical state mapping ───────────────────────────────────────────────────
// Maps existing JobStatus variants to canonical AI_JOB_STATES.
// Internal statuses include legacy values: "success", "retrying", "streaming", "pending".

export function toCanonicalState(status: string): AI_JOB_STATES {
  switch (status) {
    case "queued":
    case "pending":
      return AI_JOB_STATES.QUEUED;

    case "processing":
    case "streaming":
    case "retrying":
      return AI_JOB_STATES.PROCESSING;

    case "success":
    case "completed":
      return AI_JOB_STATES.COMPLETED;

    case "failed":
      return AI_JOB_STATES.FAILED;

    default:
      return AI_JOB_STATES.PROCESSING;
  }
}

// ── State predicates ──────────────────────────────────────────────────────────

export function isTerminalState(state: AI_JOB_STATES): boolean {
  return state === AI_JOB_STATES.COMPLETED || state === AI_JOB_STATES.FAILED;
}

export function isActiveState(state: AI_JOB_STATES): boolean {
  return state === AI_JOB_STATES.QUEUED || state === AI_JOB_STATES.PROCESSING;
}

// ── AI source types ───────────────────────────────────────────────────────────

export type AISource = "image" | "tts" | "video" | "prompt";
