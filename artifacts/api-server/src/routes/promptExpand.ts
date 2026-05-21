/**
 * promptExpand.ts — IB AI Assistant
 *
 * POST /api/prompt/expand      — AI-powered prompt expansion
 * GET  /api/prompt/categories  — list categories with examples
 *
 * Auth: policyEngine (0 credits — utility endpoint)
 * Rate: 30 requests per minute per IP
 * Timeout: 15s via providerGuard
 * Model: Gemini 2.5 Flash text generation
 *
 * Response:
 *   { original, expanded, category, wordsBefore, wordsAfter, expansionRatio }
 *
 * Also used internally by POST /api/image/generate and /api/image/edit
 * when expandPrompt=true is set in the request body.
 */
import { Router, type Request, type Response } from "express";
import { z }               from "zod";
import { expandPrompt, getCategoryMeta, PROMPT_CATEGORIES } from "../lib/promptExpander";
import { policyEngine }    from "../middleware/policyEngine";
import { sanitizeProviderError } from "../lib/providerGuard";
import { buildStandardResponse, buildErrorResponse } from "../lib/aiOrchestrator";
import { logger }          from "../lib/logger";

const router = Router();

// ── Validation ────────────────────────────────────────────────────────────────

const ExpandSchema = z.object({
  prompt:   z.string().min(1, "Prompt is required").max(500, "Prompt too long"),
  category: z.enum(PROMPT_CATEGORIES).default("cinematic"),
});

// ── POST /api/prompt/expand ───────────────────────────────────────────────────

router.post(
  "/prompt/expand",
  policyEngine({ cost: 0, rateKey: "prompt_expand", rateMax: 30, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const parsed = ExpandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ...buildErrorResponse("prompt", "Invalid request"), details: parsed.error.flatten() });
      return;
    }

    const { prompt, category } = parsed.data;

    logger.info(
      { userId: req.user?.userId, category, promptLength: prompt.length },
      "[promptExpand] expand request",
    );

    try {
      const result = await expandPrompt(prompt, category);

      res.json(buildStandardResponse("prompt", {
        original:       result.original,
        expanded:       result.expanded,
        category:       result.category,
        categoryLabel:  result.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        wordsBefore:    result.wordsBefore,
        wordsAfter:     result.wordsAfter,
        expansionRatio: result.expansionRatio,
      }));
    } catch (err: unknown) {
      logger.error({ err }, "[promptExpand] expansion failed");
      res.status(503).json(buildErrorResponse("prompt", err, "gemini-prompt-expander"));
    }
  },
);

// ── GET /api/prompt/categories ────────────────────────────────────────────────
// No auth required — static metadata.

router.get("/prompt/categories", (_req: Request, res: Response) => {
  res.json({
    categories: getCategoryMeta(),
  });
});

export default router;
