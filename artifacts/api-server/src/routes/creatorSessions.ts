/**
 * creatorSessions.ts — Creator Workflow Sessions + Analytics API
 *
 * CRUD for per-user creator workflow sessions (in-memory, no DB).
 *
 * GET    /api/creator/sessions           — list sessions (sorted: pinned first, then recency)
 * POST   /api/creator/sessions           — create session
 * PATCH  /api/creator/sessions/:id       — rename / pin / update config
 * POST   /api/creator/sessions/:id/duplicate — duplicate a session
 * DELETE /api/creator/sessions/:id       — delete session
 * GET    /api/creator/analytics          — creator analytics (CEO only path)
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { policyEngine } from "../middleware/policyEngine";
import {
  listSessions,
  createSession,
  updateSession,
  duplicateSession,
  deleteSession,
  getGlobalSessionStats,
} from "../lib/creatorSessionStore";
import {
  getAnalytics,
  trackCategoryUsage,
  trackActiveUser,
} from "../lib/creatorAnalytics";

const router = Router();

const SessionConfigSchema = z.object({
  tool:        z.enum(["image", "voice", "video", "chat"]),
  prompt:      z.string().max(1000).optional(),
  editMode:    z.string().max(50).optional(),
  intensity:   z.string().max(20).optional(),
  voiceStyle:  z.string().max(50).optional(),
  videoMode:   z.string().max(50).optional(),
  presetId:    z.string().max(50).optional(),
  notes:       z.string().max(500).optional(),
});

const CreateSchema = z.object({
  name:     z.string().min(1).max(80),
  category: z.enum(["Creator", "Business", "Luxury", "Social", "Voiceover", "Product Ads"]),
  config:   SessionConfigSchema,
});

const UpdateSchema = z.object({
  name:     z.string().min(1).max(80).optional(),
  category: z.enum(["Creator", "Business", "Luxury", "Social", "Voiceover", "Product Ads"]).optional(),
  pinned:   z.boolean().optional(),
  config:   SessionConfigSchema.partial().optional(),
});

const guard = policyEngine({
  cost: 0, rateKey: "creator_sessions", rateMax: 120, rateWindowMs: 60_000, allowRecovery: true,
});

// ── GET /api/creator/sessions ─────────────────────────────────────────────────

router.get("/creator/sessions", guard, (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  trackActiveUser(userId);
  res.json({ sessions: listSessions(userId), count: listSessions(userId).length });
});

// ── POST /api/creator/sessions ────────────────────────────────────────────────

router.post("/creator/sessions", guard, (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const session = createSession(userId, parsed.data);
  trackCategoryUsage(parsed.data.category);
  res.status(201).json({ session });
});

// ── PATCH /api/creator/sessions/:id ──────────────────────────────────────────

router.patch("/creator/sessions/:id", guard, (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const sessionId = String(req.params["id"] ?? "");
  const updated = updateSession(userId, sessionId, parsed.data);
  if (!updated) { res.status(404).json({ error: "Session not found" }); return; }
  res.json({ session: updated });
});

// ── POST /api/creator/sessions/:id/duplicate ─────────────────────────────────

router.post("/creator/sessions/:id/duplicate", guard, (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const sessionId = String(req.params["id"] ?? "");
  const copy = duplicateSession(userId, sessionId);
  if (!copy) { res.status(404).json({ error: "Session not found" }); return; }
  res.status(201).json({ session: copy });
});

// ── DELETE /api/creator/sessions/:id ─────────────────────────────────────────

router.delete("/creator/sessions/:id", guard, (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const sessionId = String(req.params["id"] ?? "");
  const deleted = deleteSession(userId, sessionId);
  if (!deleted) { res.status(404).json({ error: "Session not found" }); return; }
  res.json({ success: true });
});

// ── GET /api/creator/analytics ────────────────────────────────────────────────
// Read-only — no auth required (CEO dashboard uses this)

router.get("/creator/analytics", (_req: Request, res: Response) => {
  res.json({
    success: true,
    ...getAnalytics(),
    globalStats: getGlobalSessionStats(),
  });
});

export default router;
