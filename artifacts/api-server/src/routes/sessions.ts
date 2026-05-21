/**
 * sessions.ts — Session management routes.
 *
 * GET  /api/auth/sessions            — list sessions (own; CEO: all system-wide)
 * POST /api/auth/sessions/revoke     — revoke a specific sessionId
 * POST /api/auth/sessions/revoke-all — revoke all sessions (own; CEO options below)
 *
 * CEO revoke-all body options:
 *   {}                         — revoke CEO's own sessions
 *   { targetUserId: "..." }    — revoke all sessions for that user
 *   { allUsers: true }         — revoke ALL sessions system-wide
 *
 * Auth: requireNormalAuth (recovery sessions are blocked everywhere here)
 * Policy: canExecuteAuthAction() enforced per action
 */
import { Router, type Request, type Response } from "express";
import { z }                   from "zod";
import { requireNormalAuth }   from "../middleware/requireAuth";
import {
  getUserSessions,
  getAllSessions,
  revokeSession,
  revokeAllUserSessions,
  revokeAllSessions,
  getSessionStats,
} from "../lib/sessionStore";
import { canExecuteAuthAction } from "../lib/systemPolicy";
import { emit }                 from "../lib/eventBus";
import { logger }               from "../lib/logger";

const router = Router();

// ── GET /api/auth/sessions ────────────────────────────────────────────────────

router.get("/auth/sessions", requireNormalAuth, (req: Request, res: Response) => {
  const policy = canExecuteAuthAction(req.user!, "view_sessions");
  if (!policy.allowed) {
    res.status(policy.httpStatus).json({ error: policy.reason, code: policy.code });
    return;
  }

  const isCeo     = req.user!.role === "ceo";
  const sessions  = isCeo ? getAllSessions() : getUserSessions(req.user!.userId);

  res.json({
    sessions,
    ...(isCeo ? { stats: getSessionStats() } : {}),
  });
});

// ── POST /api/auth/sessions/revoke ────────────────────────────────────────────

const RevokeSchema = z.object({
  sessionId: z.string().uuid("sessionId must be a valid UUID"),
});

router.post(
  "/auth/sessions/revoke",
  requireNormalAuth,
  (req: Request, res: Response) => {
    const policy = canExecuteAuthAction(req.user!, "revoke_session");
    if (!policy.allowed) {
      res.status(policy.httpStatus).json({ error: policy.reason, code: policy.code });
      return;
    }

    const parsed = RevokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { sessionId } = parsed.data;
    const isCeo         = req.user!.role === "ceo";

    // Non-CEO can only revoke their own sessions
    if (!isCeo) {
      const ownSessions = getUserSessions(req.user!.userId);
      const owns        = ownSessions.some((s) => s.sessionId === sessionId);
      if (!owns) {
        emit({
          eventType: "session_validation_failed",
          source:    "sessions_route",
          userId:    req.user!.userId,
          action:    "revoke_session",
          status:    "failure",
          metadata:  { sessionId, reason: "not_owner" },
          errorCode: "FORBIDDEN",
        });
        res.status(403).json({
          error: "You can only revoke your own sessions",
          code:  "FORBIDDEN",
        });
        return;
      }
    }

    const ok = revokeSession(sessionId, req.user!.userId);

    emit({
      eventType: "session_revoked",
      source:    "sessions_route",
      userId:    req.user!.userId,
      action:    "revoke_session",
      status:    ok ? "success" : "failure",
      metadata:  { sessionId, found: ok },
    });

    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    logger.info({ sessionId, revokedBy: req.user!.userId }, "[sessions] session revoked");

    res.json({ success: true, sessionId });
  },
);

// ── POST /api/auth/sessions/revoke-all ────────────────────────────────────────

const RevokeAllSchema = z.object({
  targetUserId: z.string().optional(),
  allUsers:     z.boolean().optional(),
});

router.post(
  "/auth/sessions/revoke-all",
  requireNormalAuth,
  (req: Request, res: Response) => {
    const parsed = RevokeAllSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { targetUserId, allUsers } = parsed.data;
    const isCeo        = req.user!.role === "ceo";
    const callerUserId = req.user!.userId;

    // CEO-only actions: revoke other users or all users
    const isCeoOnlyAction =
      allUsers === true ||
      (typeof targetUserId === "string" && targetUserId !== callerUserId);

    if (isCeoOnlyAction) {
      const policy = canExecuteAuthAction(req.user!, "revoke_all_sessions");
      if (!policy.allowed) {
        res.status(policy.httpStatus).json({ error: policy.reason, code: policy.code });
        return;
      }
    }

    let count: number;
    let scope: string;

    if (isCeo && allUsers) {
      count = revokeAllSessions(callerUserId);
      scope = "all_users";
    } else if (isCeo && typeof targetUserId === "string") {
      count = revokeAllUserSessions(targetUserId, callerUserId);
      scope = `user:${targetUserId}`;
    } else {
      count = revokeAllUserSessions(callerUserId, callerUserId);
      scope = "self";
    }

    emit({
      eventType: "session_revoke_all",
      source:    "sessions_route",
      userId:    callerUserId,
      action:    "revoke_all_sessions",
      status:    "success",
      metadata:  { scope, count, isCeo },
    });

    logger.info({ callerUserId, scope, count }, "[sessions] bulk revoke");

    res.json({ success: true, revoked: count, scope });
  },
);

export default router;
