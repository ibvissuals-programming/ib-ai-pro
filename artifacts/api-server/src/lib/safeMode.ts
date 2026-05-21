/**
 * safeMode.ts — Global AI safe mode flag.
 *
 * Safe mode is activated at startup when the Gemini provider is not configured.
 * While active, ALL AI job creation is blocked immediately at the route layer —
 * no jobs are queued, no credits are consumed, no provider calls are made.
 *
 * Safe mode persists until the process is restarted with a valid GEMINI_API_KEY.
 * It cannot be disabled at runtime without a restart (by design).
 */
import { logger } from "./logger";
import { emit }   from "./eventBus";

let _active = false;
let _reason = "";
let _activatedAt: number | null = null;

export function isSafeMode(): boolean {
  return _active;
}

export function getSafeModeReason(): string {
  return _reason;
}

export function getSafeModeInfo(): { active: boolean; reason: string; activatedAt: number | null } {
  return { active: _active, reason: _reason, activatedAt: _activatedAt };
}

/**
 * Enable safe mode. Idempotent — calling multiple times with different reasons
 * only updates if not already active.
 */
export function enableSafeMode(reason: string): void {
  if (!_active) {
    _active      = true;
    _reason      = reason;
    _activatedAt = Date.now();
    logger.warn(
      { reason },
      "[safeMode] SAFE MODE ENABLED — all AI job creation is blocked",
    );
    emit({
      eventType: "safe_mode_triggered",
      source:    "safeMode",
      action:    "enable_safe_mode",
      status:    "blocked",
      metadata:  { reason },
      errorCode: "provider_not_configured",
    });
  }
}

/**
 * Build a structured 503 response body for safe mode rejections.
 * Used by routes to return a consistent error without importing full orchestrator.
 */
export function buildSafeModeError(mode: string): {
  success: false;
  mode: string;
  error: string;
  code: string;
} {
  return {
    success: false,
    mode,
    error: `AI provider not configured. ${_reason}`,
    code: "provider_not_configured",
  };
}
