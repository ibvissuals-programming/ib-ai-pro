/**
 * Credits API routes — IB AI Assistant freemium system.
 *
 * GET  /api/credits/:username  — fetch a user's current credit status
 * POST /api/credits/upgrade    — change a user's plan (demo; replace with
 *                                payment verification in production)
 *
 * These routes are read-heavy and synchronous (in-memory store).
 * They do not touch the SSE streaming pipeline.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getCreditStatus, upgradePlan, PLAN_DAILY_CREDITS } from "../lib/credits";
import type { Plan } from "../lib/credits";
import { logger } from "../lib/logger";

const router = Router();

// ── GET /api/credits/:username ────────────────────────────────────────────────

router.get("/credits/:username", (req: Request, res: Response) => {
  const username = req.params.username?.trim().toLowerCase();

  if (!username || username.length > 60) {
    res.status(400).json({ error: "Invalid username" });
    return;
  }

  const status = getCreditStatus(username);
  res.json(status);
});

// ── POST /api/credits/upgrade ─────────────────────────────────────────────────

const UpgradeSchema = z.object({
  username: z.string().min(1).max(60).transform((s) => s.trim().toLowerCase()),
  plan: z.enum(["free", "pro", "max"]),
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

  try {
    const record = upgradePlan(username, plan as Plan);
    const limit = PLAN_DAILY_CREDITS[plan as Plan];

    logger.info({ username, plan }, "[credits] Plan upgraded");

    res.json({
      success: true,
      username: record.username,
      plan: record.plan,
      dailyLimit: limit === Infinity ? null : limit,
    });
  } catch (err) {
    logger.error({ err, username, plan }, "[credits] Upgrade failed");
    res.status(500).json({ error: "Upgrade failed" });
  }
});

export default router;
