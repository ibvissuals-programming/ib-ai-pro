/**
 * Image generation + editing routes — IB AI Assistant
 *
 * POST /api/image/generate  — text-to-image via FLUX (Pollinations)
 * POST /api/image/edit      — image-to-image (true img2img or grounded fallback)
 *
 * ISOLATION: These routes are fully independent of /api/chat and the Gemini
 * integration. They share no state, no handlers, and no response logic.
 *
 * Auth: requireNormalAuth enforced — recovery sessions are blocked (must change
 *       password first). Image uploads validated: MIME + 10 MB size limit.
 * Credits: image_generate = 3, image_edit = 5 (deducted after success).
 * Rate limit: 10 generate / 10 edit per minute per IP.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateImage, editImage, type EditResult } from "../services/imageGenService";
import { logger } from "../lib/logger";
import { requireNormalAuth } from "../middleware/requireAuth";
import { creditGuard, deductRequestCredits, appendCreditHeaders } from "../middleware/creditGuard";
import { rateLimit } from "../middleware/rateLimit";
import { CREDIT_COSTS } from "../lib/userStore";

const router = Router();

const MAX_IMAGE_B64_CHARS = 14_000_000; // ~10 MB decoded

// ── Validation schemas ────────────────────────────────────────────────────────

const GenerateSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(500, "Prompt too long"),
});

const EditSchema = z.object({
  image: z.string().min(10, "Image is required"),
  prompt: z
    .string()
    .min(1, "Edit instruction is required")
    .max(2000, "Prompt too long"),
});

// ── User-safe error sanitizer for route layer ─────────────────────────────────
// The service layer already sanitizes most errors; this catches anything else.

function toRouteError(err: unknown, context: "generate" | "edit"): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Already-sanitized messages from service layer pass through unchanged
  if (
    msg.includes("Unsupported image type") ||
    msg.includes("No image supplied") ||
    msg.includes("Image too large") ||
    msg.includes("temporarily") ||
    msg.includes("overloaded") ||
    msg.includes("Please retry") ||
    msg.includes("please try again") ||
    msg.includes("Please try again") ||
    msg.includes("rate limit")
  ) {
    return msg;
  }
  // Catch-all for unexpected errors
  return `Image ${context} failed. Please try again.`;
}

// ── POST /api/image/generate ──────────────────────────────────────────────────

router.post(
  "/image/generate",
  requireNormalAuth,
  rateLimit(10, 60_000, "image_generate"),
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
      const message = toRouteError(err, "generate");
      res.status(503).json({ error: message });
    }
  },
);

// ── POST /api/image/edit ──────────────────────────────────────────────────────

router.post(
  "/image/edit",
  requireNormalAuth,
  rateLimit(10, 60_000, "image_edit"),
  (req: Request, res: Response, next) => {
    // 413 guard: check base64 payload size before creditGuard or heavy processing
    const body = req.body as { image?: unknown };
    if (typeof body.image === "string" && body.image.length > MAX_IMAGE_B64_CHARS) {
      logger.warn(
        { chars: body.image.length },
        "[imageEdit] edit rejected — payload too large",
      );
      res.status(413).json({ error: "Payload Too Large — image exceeds 10 MB" });
      return;
    }
    next();
  },
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
      const result: EditResult = await editImage(parsed.data.image, parsed.data.prompt);
      deductRequestCredits(req);
      appendCreditHeaders(req, res);
      res.json({ b64Image: result.b64Image, status: "success", job: result.job });
    } catch (err: unknown) {
      logger.error({ err }, "[imageGen] edit failed");
      const message = toRouteError(err, "edit");
      const status =
        err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 413
          ? 413
          : 503;
      res.status(status).json({ error: message });
    }
  },
);

export default router;
