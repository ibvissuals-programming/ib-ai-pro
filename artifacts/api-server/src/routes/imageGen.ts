/**
 * Image generation + editing routes — IB AI Assistant
 *
 * POST /api/image/generate  — text-to-image via FLUX (Pollinations)
 * POST /api/image/edit      — image-to-image via Pollinations regeneration
 *
 * ISOLATION: These routes are fully independent of /api/chat and the Gemini
 * integration. They share no state, no handlers, and no response logic.
 *
 * Auth: requireAuth enforced on both routes.
 * Credits: image_generate = 3, image_edit = 5 (deducted after success).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateImage, editImage } from "../services/imageGenService";
import { logger } from "../lib/logger";
import { requireAuth } from "../middleware/requireAuth";
import { creditGuard, deductRequestCredits, appendCreditHeaders } from "../middleware/creditGuard";
import { CREDIT_COSTS } from "../lib/userStore";

const router = Router();

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

router.post(
  "/image/generate",
  requireAuth,
  creditGuard(CREDIT_COSTS.image_generate),
  async (req: Request, res: Response) => {
    const parsed = GenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    try {
      const b64Image = await generateImage(parsed.data.prompt);
      deductRequestCredits(req);
      appendCreditHeaders(req, res);
      res.json({ b64Image, status: "success" });
    } catch (err: unknown) {
      logger.error({ err }, "[imageGen] generate failed");
      const message =
        err instanceof Error ? err.message : "Image generation failed";
      res.status(503).json({ error: message });
    }
  },
);

// ── POST /api/image/edit ──────────────────────────────────────────────────────

router.post(
  "/image/edit",
  requireAuth,
  creditGuard(CREDIT_COSTS.image_edit),
  async (req: Request, res: Response) => {
    const parsed = EditSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    try {
      const b64Image = await editImage(parsed.data.image, parsed.data.prompt);
      deductRequestCredits(req);
      appendCreditHeaders(req, res);
      res.json({ b64Image, status: "success" });
    } catch (err: unknown) {
      logger.error({ err }, "[imageGen] edit failed");
      const message = err instanceof Error ? err.message : "Image editing failed";
      res.status(503).json({ error: message });
    }
  },
);

export default router;
