/**
 * Auth routes — IB AI Assistant persistent identity system.
 *
 * POST /api/auth/register        — create a new account
 * POST /api/auth/login           — authenticate and receive a token (PATH A or B)
 * POST /api/auth/change-password — update password (works for recovery sessions)
 * GET  /api/auth/me              — return current user from token (normal sessions only)
 *
 * JWT claims:
 *   recoverySession: true  — issued via recovery key, ONLY /api/auth/change-password allowed
 *   recoverySession: false — full normal session access
 *
 * Rate limits:
 *   register  — 5 per 5 minutes per IP
 *   login     — 15 per 60 seconds per IP
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  createUser,
  authenticateUser,
  authenticateCeoByRecoveryKey,
  getUserById,
  toPublicUser,
  changeUserPassword,
  CREDIT_COSTS,
  FREE_CREDITS,
  RESET_INTERVAL_MS,
} from "../lib/userStore";
import { signToken } from "../lib/token";
import { requireAuth, requireNormalAuth } from "../middleware/requireAuth";
import { rateLimit } from "../middleware/rateLimit";
import { logger } from "../lib/logger";

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
    const token = signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      recoverySession: false,
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
// Two authentication paths:
//
//   PATH A — Normal login (all users):
//     Body: { username, password }
//     Validates password against scrypt hash in DB.
//     Issues: recoverySession: false
//
//   PATH B — CEO recovery (CEO only):
//     Header: x-ceo-recovery-key: <CEO_RECOVERY_KEY env var>
//     Body:   { username }  (password field ignored / not required)
//     Bypasses password check entirely.
//     Rejected immediately if username !== CEO_USERNAME or key doesn't match.
//     Issues: recoverySession: true  → ONLY /api/auth/change-password is permitted.
//     Never available to normal users under any circumstance.

router.post(
  "/auth/login",
  rateLimit(15, 60_000, "login"),
  async (req: Request, res: Response) => {
    const incomingRecoveryKey = req.headers["x-ceo-recovery-key"];

    // ── PATH B: CEO recovery key flow ──────────────────────────────────────────
    if (incomingRecoveryKey) {
      const configuredKey = process.env["CEO_RECOVERY_KEY"];

      // Recovery key must be configured server-side — if not, refuse with same
      // generic error to avoid leaking that recovery exists.
      if (!configuredKey || typeof incomingRecoveryKey !== "string") {
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }

      // Timing-safe comparison to prevent timing attacks on the recovery key.
      const { timingSafeEqual } = await import("crypto");
      const a = Buffer.from(incomingRecoveryKey);
      const b = Buffer.from(configuredKey);
      const keysMatch =
        a.length === b.length && timingSafeEqual(a, b);

      if (!keysMatch) {
        logger.warn({ ip: req.ip }, "[auth] CEO recovery key mismatch");
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }

      // Key is valid — extract username from body (password not required).
      const username = (req.body as Record<string, unknown>)?.username;
      if (typeof username !== "string" || username.length < 1) {
        res.status(400).json({ error: "Username required" });
        return;
      }

      const user = authenticateCeoByRecoveryKey(username);
      if (!user) {
        // username wasn't the CEO — reject with generic error
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }

      // Recovery token: restricted to change-password only
      const token = signToken({
        userId: user.id,
        username: user.username,
        role: user.role,
        recoverySession: true,
      });

      logger.info(
        { username: user.username, role: user.role },
        "[auth] recovery session issued",
      );

      res.json({
        token,
        user: toPublicUser(user),
        recoveryLogin: true, // hint to frontend: password rotation required
      });
      return;
    }

    // ── PATH A: Normal password login (all users) ───────────────────────────────
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { username, password } = parsed.data;
    const user = authenticateUser(username, password);

    if (!user) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const token = signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      recoverySession: false,
    });

    logger.info({ username: user.username, role: user.role }, "[auth] Login");

    res.json({
      token,
      user: toPublicUser(user),
    });
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
  newPassword: z.string().min(6, "Password must be at least 6 characters").max(128),
});

router.post(
  "/auth/change-password",
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { newPassword } = parsed.data;
    const userId = req.user!.userId;
    const wasRecoverySession = req.user!.recoverySession;

    const ok = await changeUserPassword(userId, newPassword);
    if (!ok) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    logger.info(
      { userId, username: req.user!.username, wasRecoverySession },
      "[auth] password rotation completed",
    );

    // If this was a recovery session, issue a fresh normal JWT immediately.
    // The client must replace its stored token with this new one.
    if (wasRecoverySession) {
      const freshToken = signToken({
        userId: req.user!.userId,
        username: req.user!.username,
        role: req.user!.role,
        recoverySession: false,
      });
      res.json({
        success: true,
        message: "Password updated successfully",
        token: freshToken, // replace the recovery token
      });
      return;
    }

    res.json({ success: true, message: "Password updated successfully" });
  },
);

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// requireNormalAuth blocks recovery sessions — they must change password first.

router.get("/auth/me", requireNormalAuth, (req: Request, res: Response) => {
  const user = getUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
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
