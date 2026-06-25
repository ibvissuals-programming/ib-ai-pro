/**
 * Saved Library routes — IB AI
 *
 * POST   /api/library      — save a text or image item (authenticated)
 * GET    /api/library      — list saved items for the user, newest first
 * DELETE /api/library/:id  — delete a saved item (own only)
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db, savedItemsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { policyEngine } from "../middleware/policyEngine";
import { logger } from "../lib/logger";

const router = Router();

// ── POST /api/library ─────────────────────────────────────────────────────────

const SaveBodySchema = z.object({
  type:     z.enum(["text", "image"]),
  content:  z.string().min(1).max(4_000_000),
  metadata: z.record(z.unknown()).optional().default({}),
});

router.post(
  "/library",
  policyEngine({ cost: 0, rateKey: "library_save", rateMax: 60, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }

    const parsed = SaveBodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() }); return; }

    const { type, content, metadata } = parsed.data;
    const id = `lib_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      await db.insert(savedItemsTable).values({
        id,
        userId,
        type,
        content,
        metadata: JSON.stringify(metadata),
        createdAt: Date.now(),
      });
      res.status(201).json({ success: true, id });
    } catch (err) {
      logger.error({ err, userId }, "[library] Failed to save item");
      res.status(500).json({ error: "Failed to save item" });
    }
  },
);

// ── GET /api/library ──────────────────────────────────────────────────────────

router.get(
  "/library",
  policyEngine({ cost: 0, rateKey: "library_list", rateMax: 60, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }

    try {
      const rows = await db
        .select()
        .from(savedItemsTable)
        .where(eq(savedItemsTable.userId, userId))
        .orderBy(desc(savedItemsTable.createdAt));

      const items = rows.map((r) => ({
        id:        r.id,
        type:      r.type,
        content:   r.content,
        metadata:  r.metadata ? JSON.parse(r.metadata) : {},
        createdAt: r.createdAt,
      }));

      res.json({ items, count: items.length });
    } catch (err) {
      logger.error({ err, userId }, "[library] Failed to list items");
      res.status(500).json({ error: "Failed to load library" });
    }
  },
);

// ── DELETE /api/library/:id ───────────────────────────────────────────────────

const DeleteParamsSchema = z.object({
  id: z.string().min(1).max(128),
});

router.delete(
  "/library/:id",
  policyEngine({ cost: 0, rateKey: "library_delete", rateMax: 30, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }

    const parsed = DeleteParamsSchema.safeParse(req.params);
    if (!parsed.success) { res.status(400).json({ error: "Invalid item ID" }); return; }

    try {
      const result = await db
        .delete(savedItemsTable)
        .where(and(eq(savedItemsTable.id, parsed.data.id), eq(savedItemsTable.userId, userId)))
        .returning({ id: savedItemsTable.id });

      if (result.length === 0) {
        res.status(404).json({ error: "Item not found or not yours" });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      logger.error({ err, userId }, "[library] Failed to delete item");
      res.status(500).json({ error: "Failed to delete item" });
    }
  },
);

export default router;
