/**
 * Auth routes — IB AI Assistant persistent identity system.
 *
 * POST /api/auth/register  — create a new account
 * POST /api/auth/login     — authenticate and receive a token
 * GET  /api/auth/me        — return current user from token
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  createUser,
  authenticateUser,
  getUserById,
  toPublicUser,
  CREDIT_COSTS,
  FREE_CREDITS,
  RESET_INTERVAL_MS,
} from "../lib/userStore";
import { signToken } from "../lib/token";
import { requireAuth } from "../middleware/requireAuth";
import { logger } from "../lib/logger";

const router = Router();

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

router.post("/auth/register", (req: Request, res: Response) => {
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
  });

  logger.info({ username: user.username, role: user.role }, "[auth] Registered");

  res.status(201).json({
    token,
    user: toPublicUser(user),
  });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post("/auth/login", (req: Request, res: Response) => {
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
  });

  logger.info({ username: user.username, role: user.role }, "[auth] Login");

  res.json({
    token,
    user: toPublicUser(user),
  });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

router.get("/auth/me", requireAuth, (req: Request, res: Response) => {
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
