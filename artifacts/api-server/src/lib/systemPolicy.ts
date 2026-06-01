/**
 * systemPolicy.ts — SINGLE SOURCE OF TRUTH for all runtime policy decisions.
 *
 * All routes, services, and managers must call this module for eligibility
 * checks. No local rule logic is permitted outside this module.
 *
 * Exposed API:
 *   canCreateJob(params)        — AI job creation eligibility
 *   canExecuteAuthAction(user, action) — auth action permission
 *   isSafeModeActive()          — re-exported safe mode flag
 *   validateRequestContext(ctx) — per-request cross-cutting validation
 *
 * All decisions are emitted to the eventBus for full observability.
 * Underlying logic (safeMode, geminiEnv) is unchanged and still enforced.
 */
import { isSafeMode, getSafeModeInfo } from "./safeMode";
import { isGeminiConfigured }          from "./geminiEnv";
import { emit }                        from "./eventBus";
import type { TokenPayload }           from "./token";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AIMode = "image" | "tts" | "video";

export type AuthAction =
  | "login"
  | "register"
  | "change_password"
  | "view_sessions"
  | "revoke_session"
  | "revoke_all_sessions"
  | "view_admin";

export interface PolicyResult {
  allowed:    boolean;
  reason:     string;
  code:       string;
  httpStatus: number;
}

const ALLOWED: PolicyResult = {
  allowed:    true,
  reason:     "",
  code:       "ok",
  httpStatus: 200,
};

// ── AI job creation policy ────────────────────────────────────────────────────

/**
 * Returns whether an AI job may be created.
 *
 * Checks (in order):
 *   1. Safe mode — blocks ALL AI jobs when Gemini is unconfigured at startup
 *   2. Gemini API key presence (image + tts modes)
 *   3. Video provider availability (video mode, injected by caller)
 *
 * The `isVideoEnabled` param is injected by the video route to prevent
 * a lib → services circular import. Pass `undefined` for non-video modes.
 */
export function canCreateJob(params: {
  mode:            AIMode;
  userId?:         string;
  source?:         string;
  isVideoEnabled?: boolean;
}): PolicyResult {
  const { mode, userId, source = "route", isVideoEnabled } = params;

  emit({
    eventType: "job_creation_attempt",
    source,
    userId,
    action:   `create_${mode}_job`,
    status:   "info",
    metadata: { mode },
  });

  // ── Guard 1: safe mode ───────────────────────────────────────────────────────
  if (isSafeMode()) {
    const info = getSafeModeInfo();
    emit({
      eventType: "job_blocked_by_policy",
      source,
      userId,
      action:    `create_${mode}_job`,
      status:    "blocked",
      metadata:  { mode, reason: "safe_mode", safeModeReason: info.reason },
      errorCode: "provider_not_configured",
    });
    return {
      allowed:    false,
      reason:     `AI provider not configured. ${info.reason}`,
      code:       "provider_not_configured",
      httpStatus: 503,
    };
  }

  // ── Guard 2: Gemini key (image + tts) ────────────────────────────────────────
  if (mode === "image" || mode === "tts") {
    if (!isGeminiConfigured()) {
      emit({
        eventType: "provider_blocked",
        source,
        userId,
        action:    `create_${mode}_job`,
        status:    "blocked",
        metadata:  { mode, provider: "gemini" },
        errorCode: "provider_not_configured",
      });
      return {
        allowed:    false,
        reason:     `provider_not_configured: Gemini API key is required for ${mode === "tts" ? "voice" : "image"} generation`,
        code:       "provider_not_configured",
        httpStatus: 503,
      };
    }
  }

  // ── Guard 3: video provider availability (injected by caller) ────────────────
  // When VIDEO_ENABLED is not set, Veo is not provisioned for this API key.
  // Return feature_disabled (501) so the frontend shows an appropriate message
  // rather than the misleading "provider not configured" (503).
  if (mode === "video" && isVideoEnabled === false) {
    emit({
      eventType: "provider_blocked",
      source,
      userId,
      action:    "create_video_job",
      status:    "blocked",
      metadata:  { mode: "video", provider: "gemini-veo", reason: "VIDEO_ENABLED not set" },
      errorCode: "feature_disabled",
    });
    return {
      allowed:    false,
      reason:     "feature_disabled: Image-to-Video requires Veo API access (VIDEO_ENABLED not set)",
      code:       "feature_disabled",
      httpStatus: 501,
    };
  }

  return ALLOWED;
}

// ── Auth action policy ────────────────────────────────────────────────────────

/**
 * Returns whether an authenticated user may perform a given auth action.
 *
 * Rules:
 *   - Recovery sessions restricted to change_password only
 *   - revoke_all_sessions and view_admin require CEO role
 *   - All other actions permitted for any authenticated user
 */
export function canExecuteAuthAction(
  user:   Pick<TokenPayload, "role" | "recoverySession">,
  action: AuthAction,
): PolicyResult {
  if (user.recoverySession && action !== "change_password") {
    return {
      allowed:    false,
      reason:     "Recovery sessions are restricted to password change only",
      code:       "RECOVERY_SESSION_RESTRICTED",
      httpStatus: 403,
    };
  }

  if (action === "view_admin" || action === "revoke_all_sessions") {
    if (user.role !== "ceo") {
      return {
        allowed:    false,
        reason:     "CEO role required",
        code:       "INSUFFICIENT_ROLE",
        httpStatus: 403,
      };
    }
  }

  return ALLOWED;
}

// ── Safe mode re-export ───────────────────────────────────────────────────────

export function isSafeModeActive(): boolean {
  return isSafeMode();
}

// ── Per-request context validation ───────────────────────────────────────────

export interface RequestContext {
  sessionId?:       string;
  userId?:          string;
  role?:            string;
  recoverySession?: boolean;
}

/**
 * Cross-cutting per-request policy validation.
 * Currently a pass-through placeholder for future expansion
 * (IP allow-lists, geo-restrictions, rate policies, etc.).
 */
export function validateRequestContext(_ctx: RequestContext): PolicyResult {
  return ALLOWED;
}
