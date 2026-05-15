/**
 * Credits API routes — IB AI Assistant.
 *
 * GET  /api/credits/:username  — fetch a user's current credit status
 *                                (username-based for backward compat with frontend)
 * POST /api/credits/upgrade    — change a user's role
 *
 * NOTE: Prefer GET /api/auth/me for new integrations — it includes the full
 * user object and is token-authenticated. This endpoint keeps the old
 * username-based URL working for the existing useCredits hook.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  getUserByUsername,
  setUserRole,
  toPublicUser,
  FREE_CREDITS,
  RESET_INTERVAL_MS,
} from "../lib/userStore";
import type { UserRole } from "../lib/userStore";
import { logger } from "../lib/logger";

const router = Router();

// ── GET /api/credits/:username ────────────────────────────────────────────────

router.get("/credits/:username", (req: Request, res: Response) => {
  const username = req.params.username?.trim().toLowerCase();

  if (!username || username.length > 60) {
    res.status(400).json({ error: "Invalid username" });
    return;
  }

  const user = getUserByUsername(username);
  if (!user) {
    // Return a default-looking response for unknown users (non-breaking)
    res.json({
      username,
      plan: "free",
      creditsRemaining: FREE_CREDITS,
      dailyLimit: FREE_CREDITS,
      nextResetAt: Date.now() + RESET_INTERVAL_MS,
    });
    return;
  }

  const pub = toPublicUser(user);
  const isCeo = pub.role === "ceo";

  res.json({
    username: pub.username,
    plan: pub.role,
    creditsRemaining: isCeo ? null : pub.credits,
    dailyLimit: isCeo ? null : FREE_CREDITS,
    nextResetAt: isCeo ? null : user.lastReset + RESET_INTERVAL_MS,
  });
});

// ── POST /api/credits/upgrade ─────────────────────────────────────────────────

const UpgradeSchema = z.object({
  username: z.string().min(1).max(60).transform((s) => s.trim().toLowerCase()),
  plan: z.enum(["free", "premium", "ceo"]),
});

router.post("/credits/upgrade", (req: Request, res: Response) => {
  const parsed = UpgradeSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
    return;
  }

  const { username, plan } = parsed.data;
  const user = getUserByUsername(username);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  setUserRole(user.id, plan as UserRole);
  logger.info({ username, plan }, "[credits] Role updated");

  res.json({
    success: true,
    username: user.username,
    plan,
  });
});

export default router;
