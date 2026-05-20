/**
 * Image generation + editing routes — IB AI Assistant
 *
 * POST /api/image/generate  — text-to-image via FLUX (Pollinations)
 * POST /api/image/edit      — unified cinematic img2img pipeline
 *                             Single model: gemini-2.5-flash-image
 *                             Flow: INPUT → RENDER PROMPT → IMAGE MODEL → SIMPLE RETRY
 *
 * ISOLATION: These routes are fully independent of /api/chat and the Gemini
 * integration. They share no state, no handlers, and no response logic.
 *
 * Auth: policyEngine enforced — recovery sessions are blocked (must change
 *       password first). Image uploads validated: MIME + 10 MB size limit.
 * Credits: 1 per operation (deducted after success only). CEO role = unlimited.
 * Rate limit: 10 generate / 10 edit per minute per IP (CEO bypassed).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateImage, editImage, detectEditMode, getContractConfig, type EditResult } from "../services/imageGenService";
import { generateCinematicInsight, buildDirectorEnhancedPrompt } from "../services/cinematicInsightEngine";
import { buildEditInstruction } from "../services/editIntelligence";
import { buildAdaptiveEditPrompt } from "../services/adaptivePromptReinforcement";
import { buildFacialRegionEnhancement } from "../services/facialRegionAwareness";
import { logger } from "../lib/logger";
import { policyEngine, deductRequestCredits, appendCreditHeaders } from "../middleware/policyEngine";
import { CREDIT_COSTS } from "../lib/userStore";
import { addAuditEntry } from "../lib/auditLog";
import {
  incImageGenerated,
  incImageGenFailed,
  incImageEdited,
  incImageEditFailed,
} from "../lib/statsCounter";

const router = Router();

const MAX_IMAGE_B64_CHARS = 14_000_000; // ~10 MB decoded

// ── Validation schemas ────────────────────────────────────────────────────────

const GenerateSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(500, "Prompt too long"),
});

const VALID_CINEMATIC_PROFILES = [
  "SUBTLE_ENHANCEMENT",
  "CINEMATIC_EDIT",
  "AGGRESSIVE_RECONSTRUCTION",
  "SCREENSHOT_CLEANUP",
  "WALLPAPER_UPGRADE",
  "TEXT_REMOVAL",
  "STYLE_TRANSFER",
  "OBJECT_MANIPULATION",
  "BACKGROUND_TRANSFORMATION",
  "COLOR_MOOD_EDIT",
] as const;

const VALID_INTENSITIES = ["LOW", "MEDIUM", "HIGH", "EXTREME"] as const;

const VALID_EDIT_MODES = ["portrait_safe", "cinematic", "style_transfer", "creative"] as const;

const EditSchema = z.object({
  image: z.string().min(10, "Image is required"),
  prompt: z
    .string()
    .min(1, "Edit instruction is required")
    .max(2000, "Prompt too long"),
  editMode: z.enum(VALID_EDIT_MODES).optional(),
  cinematicProfile: z.enum(VALID_CINEMATIC_PROFILES).optional(),
  intensity: z.enum(VALID_INTENSITIES).optional(),
  useCinematicAnalysis: z.boolean().optional(),
});

const CINEMATIC_PROMPT_ALLOWED_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const CinematicPromptSchema = z.object({
  imageBase64: z.string().min(100).max(14_000_000),
  mimeType: z.enum(CINEMATIC_PROMPT_ALLOWED_MIMES),
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

// ── GET /api/image/contract ───────────────────────────────────────────────────
// Read-only diagnostic endpoint — returns the live runtime configuration of
// the image editing pipeline. No auth required. No side effects. Pure snapshot.
//
// Query params:
//   ?debug=true  — requires DEBUG_CONTRACT=true env var. Adds version history,
//                  per-layer enforcement details, and fast-mode rule breakdown.

router.get(
  "/image/contract",
  (_req: Request, res: Response) => {
    const debugMode =
      _req.query.debug === "true" &&
      process.env["DEBUG_CONTRACT"] === "true";

    logger.info(
      { debugMode, ip: _req.ip },
      "[contractDiag] GET /api/image/contract",
    );

    const config = getContractConfig(debugMode);
    res.json(config);
  },
);

// ── POST /api/image/generate ──────────────────────────────────────────────────

router.post(
  "/image/generate",
  policyEngine({ cost: CREDIT_COSTS.image_generate, rateKey: "image_generate", rateMax: 10, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const parsed = GenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    logger.info(
      { userId: req.user?.userId, promptLength: parsed.data.prompt.length, prompt: parsed.data.prompt.slice(0, 80) },
      "[imageGen] generate request received",
    );

    try {
      const b64Image = await generateImage(parsed.data.prompt, req.user?.userId);
      deductRequestCredits(req);
      appendCreditHeaders(req, res);
      incImageGenerated();
      addAuditEntry("image_generate_success", "Image generated", {
        username: req.user?.username,
        ip: req.ip ?? undefined,
      });
      res.json({ b64Image, status: "success" });
    } catch (err: unknown) {
      incImageGenFailed();
      addAuditEntry("image_generate_failure", `Image generate failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`, {
        username: req.user?.username,
        ip: req.ip ?? undefined,
      });
      logger.error({ err }, "[imageGen] generate failed");
      const message = toRouteError(err, "generate");
      res.status(503).json({ error: message });
    }
  },
);

// ── POST /api/image/edit ──────────────────────────────────────────────────────

router.post(
  "/image/edit",
  (req: Request, res: Response, next) => {
    // 413 guard: fast-reject oversized payloads before policy engine processing
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
  policyEngine({ cost: CREDIT_COSTS.image_edit, rateKey: "image_edit", rateMax: 10, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const parsed = EditSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    logger.info(
      { userId: req.user?.userId, promptLength: parsed.data.prompt.length, hasImage: !!parsed.data.image, prompt: parsed.data.prompt.slice(0, 80) },
      "[imageEdit] edit request received",
    );

    const { useCinematicAnalysis, editMode } = parsed.data;

    // ── Mode resolution (MUST run before any enrichment) ─────────────────────
    // detectEditMode runs ONCE here on the raw user prompt.
    // It NEVER runs inside editImage() on the enriched/effectivePrompt.
    // Client-supplied editMode is the highest-priority override.
    const overrideUsed      = editMode !== undefined;
    const resolvedEditMode  = editMode ?? detectEditMode(parsed.data.prompt);

    logger.debug(
      {
        rawPrompt:    parsed.data.prompt.slice(0, 80),
        resolvedMode: resolvedEditMode,
        overrideUsed,
      },
      "[MODE_RESOLVED] mode resolved from raw prompt",
    );

    // ── Edit Intelligence Layer ───────────────────────────────────────────────
    // Phase 1: normalize, classify, safety-clean, and inject preservation rules
    // into the user's prompt before it enters the pipeline. Non-throwing —
    // falls back to original prompt on any internal error.
    const intelligence = buildEditInstruction({ userPrompt: parsed.data.prompt });

    logger.info(
      {
        category:       intelligence.category,
        strength:       intelligence.strength,
        template:       intelligence.templateApplied,
        safetyFixes:    intelligence.safetyFixes.length,
        enrichedLength: intelligence.enrichedPrompt.length,
      },
      "[imageEdit] intelligence layer applied",
    );

    // ── Adaptive Prompt Reinforcement Engine (APRE v1) ────────────────────────
    // Receives editIntelligence output. Detects weak prompts, expands them
    // into structured professional instructions, injects category-aware
    // cinematic enhancements, human realism rules, and strength directives.
    // Deduplicates against editIntelligence content. Non-throwing.
    const apre = buildAdaptiveEditPrompt({
      prompt:          intelligence.enrichedPrompt,
      category:        intelligence.category,
      strength:        intelligence.strength,
      templateApplied: intelligence.templateApplied,
    });
    // ── Facial Region Awareness Engine (FRAE v1) ──────────────────────────────
    // Detects portrait-oriented edits, selects prioritized facial regions,
    // injects identity preservation rules and targeted region directives.
    // Operates on the APRE-reinforced prompt. Synchronous, non-throwing.
    const frae = buildFacialRegionEnhancement({
      originalPrompt:     parsed.data.prompt,
      intelligenceResult: intelligence,
      apreResult:         apre,
    });
    let effectivePrompt = frae.enhancedPrompt;

    // ── AI Director pre-analysis ──────────────────────────────────────────────
    // When useCinematicAnalysis=true, call the Cinematic Insight Engine before
    // editImage() to generate director-grade prompt enrichment. Wraps the
    // FRAE-enhanced prompt for best results. Non-fatal: falls through to the
    // FRAE-enhanced prompt if analysis fails.
    let cinematicAnalysisApplied = false;
    if (useCinematicAnalysis) {
      const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(parsed.data.image);
      if (dataUrlMatch) {
        const [, mimeType, base64] = dataUrlMatch;
        try {
          const insight = await generateCinematicInsight(base64, mimeType);
          effectivePrompt = buildDirectorEnhancedPrompt(frae.enhancedPrompt, insight);
          cinematicAnalysisApplied = true;
          logger.info(
            { moodTarget: insight.moodTarget, promptLen: effectivePrompt.length },
            "[imageEdit] cinematic analysis injected",
          );
        } catch (err) {
          logger.warn({ err }, "[imageEdit] cinematic analysis failed — using APRE-reinforced prompt");
        }
      }
    }

    try {
      const result: EditResult = await editImage(
        parsed.data.image,
        effectivePrompt,
        req.user?.userId,
        resolvedEditMode,
        parsed.data.intensity,
      );
      deductRequestCredits(req);
      appendCreditHeaders(req, res);
      incImageEdited();
      addAuditEntry("image_edit_success", "Image edited", {
        username: req.user?.username,
        ip: req.ip ?? undefined,
      });
      res.json({
        b64Image:               result.b64Image,
        status:                 "success",
        job:                    result.job,
        mode:                   result.mode,
        intensity:              result.intensity,
        qualityVerified:        result.qualityVerified,
        qualityIssues:          result.qualityIssues,
        contractVersionUsed:    result.contractVersionUsed,
        cinematicAnalysisUsed:  cinematicAnalysisApplied,
        editIntelligence: {
          category:        intelligence.category,
          strength:        intelligence.strength,
          templateApplied: intelligence.templateApplied,
          safetyFixes:     intelligence.safetyFixes,
        },
        adaptiveReinforcement: {
          qualityScore:        apre.qualityScore,
          enhancementsApplied: apre.enhancementsApplied,
          reinforced:          apre.reinforcedPrompt !== apre.originalPrompt,
        },
        facialRegionAwareness: {
          portraitDetected:   frae.portraitDetected,
          targetedRegions:    frae.targetedRegions,
          enhancementProfile: frae.enhancementProfile,
        },
      });
    } catch (err: unknown) {
      incImageEditFailed();
      addAuditEntry("image_edit_failure", `Image edit failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`, {
        username: req.user?.username,
        ip: req.ip ?? undefined,
      });
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

// ── POST /api/image/cinematic-prompt ─────────────────────────────────────────
// Standalone Cinematic Insight Engine endpoint.
// Accepts a raw base64 image + mimeType, returns structured cinematic
// edit direction: scene description, lighting direction, color grade,
// exposure guidance, mood target, and a ready-to-use cinematicEditPrompt.

router.post(
  "/image/cinematic-prompt",
  policyEngine({ cost: CREDIT_COSTS.image_analysis, rateKey: "cinematic_prompt", rateMax: 10, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const parsed = CinematicPromptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    logger.info(
      { userId: req.user?.userId, mimeType: parsed.data.mimeType },
      "[cinematicPrompt] analysis request",
    );

    try {
      const insight = await generateCinematicInsight(parsed.data.imageBase64, parsed.data.mimeType);
      deductRequestCredits(req);
      appendCreditHeaders(req, res);
      res.json(insight);
    } catch (err: unknown) {
      logger.error({ err }, "[cinematicPrompt] analysis failed");
      const message = err instanceof Error ? err.message : "Unknown error";
      const isTimeout = message.includes("timed out");
      res.status(isTimeout ? 504 : 500).json({
        error: isTimeout ? "Cinematic analysis timed out — please try again" : "Cinematic analysis failed",
      });
    }
  },
);

export default router;
