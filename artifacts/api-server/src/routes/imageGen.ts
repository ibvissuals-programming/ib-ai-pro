/**
 * Image generation + editing routes — IB AI Assistant
 *
 * POST /api/image/generate  — text-to-image via FLUX (Pollinations)
 * POST /api/image/edit      — image-to-image via Pollinations regeneration (no key required)
 *
 * ISOLATION: These routes are fully independent of /api/chat and the Gemini
 * integration. They share no state, no handlers, and no response logic.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateImage, editImage } from "../services/imageGenService";
import { logger } from "../lib/logger";

const router = Router();

// ── Per-IP rate limiting ───────────────────────────────────────────────────────
// 1 request per 10 s per IP. Resets on server restart — intentional.
// Prevents accidental spam without a database dependency.

const lastRequestMap = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;

function getClientId(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

function checkRateLimit(clientId: string): boolean {
  const last = lastRequestMap.get(clientId) ?? 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_MS) return false;
  lastRequestMap.set(clientId, now);
  // Prune old entries to prevent memory leak on long-running server
  if (lastRequestMap.size > 5_000) {
    const cutoff = now - 60_000;
    for (const [id, ts] of lastRequestMap) {
      if (ts < cutoff) lastRequestMap.delete(id);
    }
  }
  return true;
}

// ── Validation schemas ────────────────────────────────────────────────────────

const GenerateSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(500, "Prompt too long"),
});

const EditSchema = z.object({
  image: z.string().min(1, "Image is required"),
  prompt: z
    .string()
    .min(1, "Edit instruction is required")
    .max(500, "Prompt too long"),
});

// ── POST /api/image/generate ──────────────────────────────────────────────────

router.post("/image/generate", async (req: Request, res: Response) => {
  const clientId = getClientId(req);

  if (!checkRateLimit(clientId)) {
    res.status(429).json({
      error:
        "Too many requests — please wait 10 seconds between image generations.",
    });
    return;
  }

  const parsed = GenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  try {
    const b64Image = await generateImage(parsed.data.prompt);
    res.json({ b64Image, status: "success" });
  } catch (err: unknown) {
    logger.error({ err }, "[imageGen] generate failed");
    const message =
      err instanceof Error ? err.message : "Image generation failed";
    res.status(503).json({ error: message });
  }
});

// ── POST /api/image/edit ──────────────────────────────────────────────────────

router.post("/image/edit", async (req: Request, res: Response) => {
  const clientId = getClientId(req);

  if (!checkRateLimit(clientId)) {
    res.status(429).json({
      error: "Too many requests — please wait 10 seconds between edits.",
    });
    return;
  }

  const parsed = EditSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  try {
    const b64Image = await editImage(parsed.data.image, parsed.data.prompt);
    res.json({ b64Image, status: "success" });
  } catch (err: unknown) {
    logger.error({ err }, "[imageGen] edit failed");
    const message = err instanceof Error ? err.message : "Image editing failed";
    res.status(503).json({ error: message });
  }
});

export default router;
