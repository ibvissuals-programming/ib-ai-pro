/**
 * Memory routes — IB AI user memory system
 *
 * All endpoints require: valid JWT (any authenticated user — own data only)
 *
 * GET    /api/memory           — list all memory entries for current user
 * POST   /api/memory           — set/upsert a memory entry { key, value }
 * DELETE /api/memory/:key      — delete a single entry by key
 * DELETE /api/memory           — clear all memory for current user
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { policyEngine } from "../middleware/policyEngine";
import { logger } from "../lib/logger";
import {
  getUserMemory,
  setMemory,
  deleteMemory,
  clearUserMemory,
  MEMORY_LIMITS,
} from "../services/memoryStore";

const router = Router();

const memoryPolicy = policyEngine({
  cost: 0,
  rateKey: "memory",
  rateMax: 60,
  rateWindowMs: 60_000,
  allowRecovery: true,
});

const SetMemorySchema = z.object({
  key:   z.string().min(1).max(MEMORY_LIMITS.maxKeyLength),
  value: z.string().min(1).max(MEMORY_LIMITS.maxValueLength),
});

// ── GET /api/memory ───────────────────────────────────────────────────────────

router.get("/memory", memoryPolicy, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const entries = await getUserMemory(userId);
    res.json({ count: entries.length, entries });
  } catch (err) {
    logger.error({ err }, "[memory] GET failed");
    res.status(500).json({ error: "Failed to load memory" });
  }
});

// ── POST /api/memory ──────────────────────────────────────────────────────────

router.post("/memory", memoryPolicy, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsed = SetMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { key, value } = parsed.data;

  try {
    const entry = await setMemory(userId, key, value);
    res.status(200).json({ ok: true, entry });
  } catch (err) {
    logger.error({ err }, "[memory] POST failed");
    res.status(500).json({ error: "Failed to save memory" });
  }
});

// ── DELETE /api/memory/:key ───────────────────────────────────────────────────

router.delete("/memory/:key", memoryPolicy, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const key = Array.isArray(req.params["key"]) ? req.params["key"][0] : req.params["key"];
  if (!key) {
    res.status(400).json({ error: "Missing key" });
    return;
  }

  try {
    const deleted = await deleteMemory(userId, key);
    if (!deleted) {
      res.status(404).json({ error: "Memory key not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "[memory] DELETE key failed");
    res.status(500).json({ error: "Failed to delete memory" });
  }
});

// ── DELETE /api/memory ────────────────────────────────────────────────────────

router.delete("/memory", memoryPolicy, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const cleared = await clearUserMemory(userId);
    res.json({ ok: true, cleared });
  } catch (err) {
    logger.error({ err }, "[memory] DELETE all failed");
    res.status(500).json({ error: "Failed to clear memory" });
  }
});

export default router;
