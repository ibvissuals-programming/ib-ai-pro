/**
 * Image History routes — IB AI Assistant
 *
 * GET  /api/image/history        — fetch authenticated user's image history
 * DELETE /api/image/history/:id  — delete a history entry (own only)
 * GET  /api/image/serve/:id      — serve image file (UUID-secured, no auth required)
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { promises as fs } from "fs";
import {
  getUserHistory,
  deleteHistoryEntry,
  getImageFilePath,
} from "../services/imageHistoryStore";
import { policyEngine } from "../middleware/policyEngine";
import { logger } from "../lib/logger";

const router = Router();

// ── GET /api/image/history ─────────────────────────────────────────────────
//
// Returns authenticated user's image history.
//
// Query params:
//   ?limit=N       — max entries (default 30, cap 50)
//   ?meta=true     — return metadata-only view (no imageUrl, no raw image fields).
//                    Returns: jobId, timestamp, mode, intensity, complexity,
//                    contractVersionUsed, status, retryCount, latency, model.
//                    Designed for audit logs and dashboards — no image bytes served.

router.get(
  "/image/history",
  policyEngine({ cost: 0, rateKey: "image_history", rateMax: 60, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const limitRaw = req.query["limit"];
    const limit = typeof limitRaw === "string" ? Math.min(Number(limitRaw) || 30, 50) : 30;

    const metaOnly = req.query["meta"] === "true";

    try {
      const entries = await getUserHistory(userId, limit);

      if (metaOnly) {
        // Metadata-only view — no image URLs or image file references
        const meta = entries.map((e) => ({
          jobId:               e.id,
          timestamp:           e.timestamp,
          mode:                e.mode,
          intensity:           e.intensity,
          complexity:          e.complexity     ?? null,
          contractVersionUsed: e.contractVersionUsed ?? null,
          status:              e.status         ?? null,
          retryCount:          e.retryCount     ?? null,
          latency:             e.latencyMs      ?? null,
          model:               e.model          ?? null,
        }));
        res.json({ entries: meta, count: meta.length, metaOnly: true });
        return;
      }

      res.json({ entries, count: entries.length });
    } catch (err) {
      logger.error({ err, userId }, "[imageHistory] Failed to get history");
      res.status(500).json({ error: "Failed to load image history" });
    }
  },
);

// ── DELETE /api/image/history/:id ─────────────────────────────────────────

const DeleteParamsSchema = z.object({
  id: z.string().min(1).max(128),
});

router.delete(
  "/image/history/:id",
  policyEngine({ cost: 0, rateKey: "image_history_delete", rateMax: 30, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const parsed = DeleteParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }

    try {
      const deleted = await deleteHistoryEntry(userId, parsed.data.id);
      if (!deleted) {
        res.status(404).json({ error: "Entry not found or not yours" });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      logger.error({ err, userId }, "[imageHistory] Failed to delete entry");
      res.status(500).json({ error: "Failed to delete entry" });
    }
  },
);

// ── GET /api/image/serve/:id ──────────────────────────────────────────────
// Serves image files directly. No auth required — UUIDs are unguessable.

const ServeParamsSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-f0-9-]+$/, "Invalid image ID"),
});

router.get("/image/serve/:id", async (req: Request, res: Response) => {
  const parsed = ServeParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid image ID" });
    return;
  }

  try {
    const filePath = await getImageFilePath(parsed.data.id);
    if (!filePath) {
      res.status(404).json({ error: "Image not found" });
      return;
    }

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      res.status(404).json({ error: "Image file not found" });
      return;
    }

    // Determine content type from extension
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "jpg";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
    };
    const contentType = mimeMap[ext] ?? "image/jpeg";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const data = await fs.readFile(filePath);
    res.send(data);
  } catch (err) {
    logger.error({ err }, "[imageHistory] Failed to serve image");
    res.status(500).json({ error: "Failed to serve image" });
  }
});

export default router;
