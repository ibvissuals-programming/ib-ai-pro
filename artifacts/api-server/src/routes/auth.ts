/**
 * Auth routes — IB AI Assistant persistent identity system.
 *
 * POST /api/auth/register        — create a new account
 * POST /api/auth/login           — authenticate and receive a token (password only)
 * POST /api/auth/change-password — update password (normal sessions only)
 * POST /api/auth/reset-password  — self-service password reset (only recovery mechanism)
 * GET  /api/auth/me              — return current user from token (normal sessions only)
 *
 * JWT claims:
 *   recoverySession: false — only valid session type; recovery key login is permanently disabled
 *
 * Rate limits:
 *   register  — 5 per 5 minutes per IP
 *   login     — 15 per 60 seconds per IP
 */
import { timingSafeEqual } from "crypto";
import { Router, type Request, type Response, type RequestHandler } from "express";
import { z } from "zod";
import {
  createUser,
  authenticateUser,
  authenticateUserFromDb,
  getUserById,
  getUserByIdFromDb,
  getUserByUsername,
  toPublicUser,
  changeUserPassword,
  updatePasswordHashInDbOnly,
  checkCurrentPasswordFromDb,
  CREDIT_COSTS,
  FREE_CREDITS,
  RESET_INTERVAL_MS,
} from "../lib/userStore";
import { signToken } from "../lib/token";
import { requireAuth, requireNormalAuth } from "../middleware/requireAuth";
import { rateLimit } from "../middleware/rateLimit";
import { logger } from "../lib/logger";
import { addAuditEntry } from "../lib/auditLog";
import {
  incLoginSuccess,
  incLoginFailure,
  incSignupSuccess,
  incSignupFailure,
  incAuthError,
} from "../lib/statsCounter";
import { recordLogin }  from "../lib/activityTracker";
import { createSession } from "../lib/sessionStore";
import { emit }          from "../lib/eventBus";

const router = Router();

// ── GET /auth/health ──────────────────────────────────────────────────────────
//
// Lightweight readiness probe — no DB, no Gemini, never fails.
// Called by the frontend before every login/signup attempt to confirm
// the backend is fully up before sending credentials.
// Must ALWAYS return 200 with valid JSON even during cold starts.

router.get("/auth/health", (_req, res) => {
  try {
    res.json({ status: "ok", ready: true, timestamp: Date.now() });
  } catch {
    // Belt-and-suspenders: even if res.json somehow throws, send raw string
    res.status(200).end('{"status":"ok","ready":true,"timestamp":0}');
  }
});

// ── Validation schemas ────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(6).max(128),
});

const LoginSchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(128),
});

// ── POST /api/auth/register ───────────────────────────────────────────────────

router.post(
  "/auth/register",
  rateLimit(5, 5 * 60_000, "register"),
  (req: Request, res: Response) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { username, password } = parsed.data;
    const result = createUser(username, password);

    if (!result.success) {
      res.status(409).json({ error: result.error });
      return;
    }

    const { user } = result;
    const regSession = createSession({
      userId:    user.id,
      username:  user.username,
      role:      user.role,
      ipAddress: req.ip ?? undefined,
      userAgent: req.headers["user-agent"] ?? undefined,
    });
    const token = signToken({
      userId:          user.id,
      username:        user.username,
      role:            user.role,
      recoverySession: false,
      sessionId:       regSession.sessionId,
    });

    incSignupSuccess();
    addAuditEntry("signup_success", `New account: ${user.username}`, {
      username: user.username,
      ip: req.ip ?? undefined,
    });
    emit({
      eventType: "register_success",
      source:    "auth_route",
      userId:    user.id,
      action:    "register",
      status:    "success",
      metadata:  { username: user.username, role: user.role, sessionId: regSession.sessionId },
    });
    logger.info({ username: user.username, role: user.role }, "[auth] Registered");

    res.status(201).json({
      token,
      user: toPublicUser(user),
    });
  },
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────
//
// Single authentication path — password only:
//
//   Body: { username, password }
//   Validates password against scrypt hash in PostgreSQL.
//   Issues: recoverySession: false
//
// Recovery key login is PERMANENTLY DISABLED.
// Any request with x-ceo-recovery-key header receives 410 Gone.
// Use POST /api/auth/reset-password (requires valid session + current password).

router.post(
  "/auth/login",
  rateLimit(15, 60_000, "login"),
  async (req: Request, res: Response) => {
    // ── Top-level crash guard — NOTHING in this handler may produce an empty response ──
    try {
      // ── Password login (all users) ────────────────────────────────────────────
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          code: "invalid_request",
          error: "Invalid request",
        });
        return;
      }

      const { username, password } = parsed.data;

      logger.info({ username, ip: req.ip }, "[auth] login_attempt");
      emit({
        eventType: "login_attempt",
        source:    "auth_route",
        action:    "login",
        status:    "info",
        metadata:  { username, ip: req.ip },
      });

      // ── DB-authoritative authentication (single source of truth: PostgreSQL) ───
      //    authenticateUserFromDb() fetches a fresh row from PG on every attempt —
      //    the in-memory cache is NEVER used for password verification.
      let authResult;
      try {
        authResult = await authenticateUserFromDb(username, password);
      } catch (authErr) {
        logger.error({ err: authErr, username }, "[auth] login_crash_prevented — authenticateUserFromDb threw");
        res.status(500).json({ success: false, code: "internal_error", error: "Login service temporarily unavailable" });
        return;
      }

      if (!authResult.ok) {
        // Map reason → HTTP status and structured log (client always gets the same generic 401)
        const reason = authResult.reason;

        if (reason === "invalid_hash" || reason === "db_error") {
          logger.error({ username, reason, ip: req.ip }, "[auth] login_crash_prevented — auth subsystem error");
          res.status(500).json({ success: false, code: "internal_error", error: "Login service temporarily unavailable" });
          return;
        }

        // reason is "not_found" | "password_mismatch"
        incLoginFailure();
        incAuthError();
        logger.warn({ username, reason, ip: req.ip }, "[auth] Login failed");
        addAuditEntry("login_failure", `Login failed: ${username} (${reason})`, {
          username,
          ip: req.ip ?? undefined,
        });
        emit({
          eventType: "login_failure",
          source:    "auth_route",
          action:    "login",
          status:    "failure",
          metadata:  { username, ip: req.ip, reason },
          errorCode: "INVALID_CREDENTIALS",
        });
        res.status(401).json({ success: false, code: "auth_failed", error: "Invalid username or password" });
        return;
      }

      const user = authResult.user;

      // ── Issue session + token ──────────────────────────────────────────────────
      const loginSession = createSession({
        userId:    user.id,
        username:  user.username,
        role:      user.role,
        ipAddress: req.ip ?? undefined,
        userAgent: req.headers["user-agent"] ?? undefined,
      });
      const token = signToken({
        userId:          user.id,
        username:        user.username,
        role:            user.role,
        recoverySession: false,
        sessionId:       loginSession.sessionId,
      });

      incLoginSuccess();
      addAuditEntry("login_success", `Login: ${user.username}`, {
        username: user.username,
        ip: req.ip ?? undefined,
        metadata: { role: user.role },
      });
      emit({
        eventType: "login_success",
        source:    "auth_route",
        userId:    user.id,
        action:    "login",
        status:    "success",
        metadata:  { username: user.username, role: user.role, sessionId: loginSession.sessionId },
      });
      recordLogin(user.id, user.username, user.role);
      logger.info({ username: user.username, role: user.role }, "[auth] Login");

      res.json({
        token,
        user: toPublicUser(user),
      });

    } catch (unexpectedErr) {
      // Belt-and-suspenders: catch anything that slips through the inner guards.
      // NEVER let the connection close without a response.
      logger.error(
        { err: unexpectedErr instanceof Error ? { message: unexpectedErr.message } : String(unexpectedErr), ip: req.ip },
        "[auth] login_crash_prevented — unexpected error in login handler",
      );
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          code:    "internal_error",
          error:   "Login service temporarily unavailable",
        });
      }
    }
  },
);

// ── POST /api/auth/change-password ────────────────────────────────────────────
//
// Works for both normal and recovery sessions (uses requireAuth, not requireNormalAuth).
//
// Recovery session flow:
//   1. CEO logs in via recovery key → gets recoverySession: true JWT
//   2. POST /api/auth/change-password with new password
//   3. Server issues a fresh recoverySession: false JWT in the response
//   4. Frontend replaces the stored token — full access restored
//
// Body: { newPassword: string (min 6) }
// Auth: requireAuth (valid JWT — both session types accepted)

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128).optional(),
  newPassword: z.string().min(6, "Password must be at least 6 characters").max(128),
});

router.post(
  "/auth/change-password",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: "invalid_request",
        error: "Invalid request",
      });
      return;
    }

    const { currentPassword, newPassword } = parsed.data;
    const userId = req.user!.userId;
    const wasRecoverySession = req.user!.recoverySession;

    emit({
      eventType: "password_change_attempt",
      source:    "auth_route",
      userId,
      action:    "change_password",
      status:    "info",
      metadata:  { username: req.user!.username, wasRecoverySession },
    });

    // Normal sessions must supply and verify their current password
    if (!wasRecoverySession) {
      if (!currentPassword) {
        res.status(400).json({ success: false, code: "invalid_request", error: "Current password is required" });
        return;
      }
      // Always verify against PostgreSQL — never the in-memory cache
      const pwValid = await checkCurrentPasswordFromDb(userId, currentPassword);
      if (!pwValid) {
        addAuditEntry("password_change_failure", `Incorrect current password: ${req.user!.username}`, {
          username: req.user!.username,
          ip: req.ip ?? undefined,
        });
        emit({
          eventType: "password_change_failure",
          source:    "auth_route",
          userId,
          action:    "change_password",
          status:    "failure",
          metadata:  { username: req.user!.username, reason: "incorrect_current_password" },
          errorCode: "INVALID_CREDENTIALS",
        });
        res.status(401).json({ success: false, code: "password_mismatch", error: "Current password is incorrect" });
        return;
      }
      // Prevent reuse of current password
      if (currentPassword === newPassword) {
        res.status(400).json({ success: false, code: "invalid_request", error: "New password must be different from the current password" });
        return;
      }
    }

    const ok = await changeUserPassword(userId, newPassword);
    if (!ok) {
      res.status(404).json({ success: false, code: "user_not_found", error: "User not found" });
      return;
    }

    addAuditEntry("password_changed", `Password changed: ${req.user!.username}`, {
      username: req.user!.username,
      ip: req.ip ?? undefined,
      metadata: { wasRecoverySession },
    });

    emit({
      eventType: "password_change_success",
      source:    "auth_route",
      userId,
      action:    "change_password",
      status:    "success",
      metadata:  { username: req.user!.username, wasRecoverySession },
    });

    logger.info(
      { userId, username: req.user!.username, wasRecoverySession },
      "[auth] password rotation completed",
    );

    // If this was a recovery session, issue a fresh normal JWT immediately.
    // The client must replace its stored token with this new one.
    if (wasRecoverySession) {
      const freshSession = createSession({
        userId:    req.user!.userId,
        username:  req.user!.username,
        role:      req.user!.role,
        ipAddress: req.ip ?? undefined,
        userAgent: req.headers["user-agent"] ?? undefined,
      });
      const freshToken = signToken({
        userId:          req.user!.userId,
        username:        req.user!.username,
        role:            req.user!.role,
        recoverySession: false,
        sessionId:       freshSession.sessionId,
      });
      res.json({
        success: true,
        message: "Password updated successfully. Please log in again with your new password.",
        token: freshToken,
      });
      return;
    }

    res.json({
      success: true,
      message: "Password updated successfully. Please log in again with your new password.",
    });
  },
);

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
//
// Two paths, same endpoint:
//
//   A) Authenticated reset (normal sessions only):
//      - Headers: Authorization: Bearer <token>
//      - Body:    { currentPassword, newPassword }
//      - currentPassword verified against PostgreSQL hash (not memory cache)
//
//   B) CEO recovery reset (no session required):
//      - Headers: x-ceo-recovery-key: <key>
//      - Body:    { username, newPassword }
//      - Recovery key validated via timing-safe compare against CEO_RECOVERY_KEY env var
//      - Only CEO accounts may use recovery reset
//
// Security guarantees:
//   - currentPassword always verified against fresh PostgreSQL hash
//   - Recovery key never used as a login path — it ONLY resets password_hash
//   - Identical old/new passwords rejected on normal path
//   - Only password_hash is updated — id, role, username, createdAt untouched
//   - No hash values appear in logs at any point

const ResetPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128).optional(),
  username:        z.string().min(1).max(64).optional(),
  newPassword:     z.string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

/** Allow either a valid normal-session JWT or an x-ceo-recovery-key header. */
const requireNormalAuthOrRecoveryKey: RequestHandler = (req, res, next) => {
  if (req.headers["x-ceo-recovery-key"]) {
    return next(); // validated inside the route handler
  }
  return (requireNormalAuth as RequestHandler)(req, res, next);
};

router.post(
  "/auth/reset-password",
  requireNormalAuthOrRecoveryKey,
  rateLimit(5, 60_000, "reset_password"),
  async (req: Request, res: Response) => {
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code:    "invalid_request",
        error:   "Invalid request",
      });
      return;
    }

    const { currentPassword, username: bodyUsername, newPassword } = parsed.data;
    const recoveryKey = req.headers["x-ceo-recovery-key"] as string | undefined;

    // ── PATH B: CEO recovery key reset ────────────────────────────────────────
    if (recoveryKey) {
      const configuredKey = process.env["CEO_RECOVERY_KEY"];
      if (!configuredKey) {
        logger.warn({ ip: req.ip }, "[auth] recovery reset attempted — CEO_RECOVERY_KEY not configured");
        res.status(503).json({
          success: false,
          code:    "recovery_disabled",
          error:   "Recovery key is not configured on this server",
        });
        return;
      }

      if (!bodyUsername) {
        res.status(400).json({
          success: false,
          code:    "invalid_request",
          error:   "Username is required for recovery reset",
        });
        return;
      }

      // Timing-safe key comparison (guards against length-difference oracle)
      const keyBufA = Buffer.from(recoveryKey);
      const keyBufB = Buffer.from(configuredKey);
      const keyValid =
        keyBufA.length === keyBufB.length &&
        timingSafeEqual(keyBufA, keyBufB);

      if (!keyValid) {
        logger.warn({ ip: req.ip, username: bodyUsername }, "[auth] invalid recovery key attempt");
        addAuditEntry("recovery_reset_failure", `Invalid recovery key: ${bodyUsername}`, {
          ip: req.ip ?? undefined,
        });
        res.status(401).json({
          success: false,
          code:    "invalid_recovery_key",
          error:   "Invalid recovery key",
        });
        return;
      }

      // Key is valid — target user must be CEO
      const targetUser = getUserByUsername(bodyUsername.trim().toLowerCase());
      if (!targetUser || targetUser.role !== "ceo") {
        // Return same error to avoid username enumeration
        res.status(401).json({
          success: false,
          code:    "invalid_recovery_key",
          error:   "Invalid recovery key",
        });
        return;
      }

      const ok = await updatePasswordHashInDbOnly(targetUser.id, newPassword);
      if (!ok) {
        res.status(500).json({ success: false, code: "internal_error", error: "Password update failed" });
        return;
      }

      addAuditEntry("recovery_reset_success", `Password reset via recovery key: ${targetUser.username}`, {
        ip: req.ip ?? undefined,
      });
      emit({
        eventType: "password_reset_success",
        source:    "auth_route",
        userId:    targetUser.id,
        action:    "reset_password",
        status:    "success",
        metadata:  { username: targetUser.username, method: "recovery_key" },
      });
      logger.info({ username: targetUser.username }, "[auth] password reset via recovery key");

      res.json({ success: true, message: "Password updated successfully" });
      return;
    }

    // ── PATH A: Authenticated reset ───────────────────────────────────────────
    if (!req.user) {
      res.status(401).json({ success: false, code: "unauthorized", error: "Authentication required" });
      return;
    }

    if (!currentPassword) {
      res.status(400).json({
        success: false,
        code:    "invalid_request",
        error:   "Current password is required",
      });
      return;
    }

    const userId   = req.user.userId;
    const username = req.user.username;

    emit({
      eventType: "password_reset_attempt",
      source:    "auth_route",
      userId,
      action:    "reset_password",
      status:    "info",
      metadata:  { username },
    });

    // Identical password guard
    if (currentPassword === newPassword) {
      res.status(400).json({
        success: false,
        code:    "invalid_request",
        error:   "New password must be different from the current password",
      });
      return;
    }

    // Current password verification — always against PostgreSQL hash (never memory cache)
    const passwordValid = await checkCurrentPasswordFromDb(userId, currentPassword);
    if (!passwordValid) {
      addAuditEntry("password_reset_failure", `Incorrect current password: ${username}`, {
        username,
        ip: req.ip ?? undefined,
      });
      emit({
        eventType: "password_reset_failure",
        source:    "auth_route",
        userId,
        action:    "reset_password",
        status:    "failure",
        metadata:  { username, reason: "incorrect_current_password" },
        errorCode: "INVALID_CREDENTIALS",
      });
      res.status(401).json({ success: false, code: "invalid_current_password", error: "Current password is incorrect" });
      return;
    }

    // Update ONLY PostgreSQL password_hash — all other fields and memory are untouched
    const ok = await updatePasswordHashInDbOnly(userId, newPassword);
    if (!ok) {
      emit({
        eventType: "password_reset_failure",
        source:    "auth_route",
        userId,
        action:    "reset_password",
        status:    "failure",
        metadata:  { username, reason: "user_not_found" },
        errorCode: "USER_NOT_FOUND",
      });
      res.status(404).json({ success: false, code: "user_not_found", error: "User not found" });
      return;
    }

    addAuditEntry("password_reset_success", `Password reset: ${username}`, {
      username,
      ip: req.ip ?? undefined,
    });
    emit({
      eventType: "password_reset_success",
      source:    "auth_route",
      userId,
      action:    "reset_password",
      status:    "success",
      metadata:  { username, role: req.user.role },
    });

    logger.info({ userId, username }, "[auth] password reset completed");

    res.json({ success: true, message: "Password updated successfully" });
  },
);

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// requireNormalAuth blocks recovery sessions — they must change password first.

router.get("/auth/me", requireNormalAuth, async (req: Request, res: Response) => {
  // Re-hydrate from PostgreSQL — identity endpoint always reflects live DB state.
  const user = await getUserByIdFromDb(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    return;
  }

  const pub = toPublicUser(user);
  const nextReset = user.lastReset + RESET_INTERVAL_MS;

  res.json({
    user: pub,
    credits: {
      remaining: pub.role === "ceo" ? null : pub.credits,
      limit: pub.role === "ceo" ? null : FREE_CREDITS,
      nextResetAt: pub.role === "ceo" ? null : nextReset,
      costs: CREDIT_COSTS,
    },
  });
});

export default router;
