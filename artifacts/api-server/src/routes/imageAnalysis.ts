/**
 * imageAnalysis.ts — IB AI Assistant
 *
 * POST /api/analyze-image — Gemini vision analysis of uploaded images.
 *
 * Auth: policyEngine (CREDIT_COSTS.image_analysis per request, CEO = unlimited)
 * Rate: 10 requests per minute per IP
 * Timeout: 55s via withProviderTimeout (providerGuard)
 * Model: gemini-2.5-flash
 *
 * Contract compliance:
 *   - Success: buildStandardResponse("image", analysisData)
 *   - Error:   buildErrorResponse("image", err, "gemini-vision") — no raw provider leakage
 *   - Timeout: uses withProviderTimeout — consistent with all other AI tools
 *   - JSON parse failure: buildErrorResponse — no ad-hoc shapes
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ai } from "@workspace/integrations-gemini-ai";
import { assertGeminiProvider } from "../lib/aiGuard";
import { logger } from "../lib/logger";
import { policyEngine, deductRequestCredits, appendCreditHeaders } from "../middleware/policyEngine";
import { CREDIT_COSTS } from "../lib/credits";
import { buildStandardResponse, buildErrorResponse } from "../lib/aiOrchestrator";
import { withProviderTimeout } from "../lib/providerGuard";

const router = Router();

const VISION_MODEL = "gemini-2.5-flash";

const MAX_BASE64_LEN = 5_600_000;
const ANALYSIS_TIMEOUT_MS = 55_000;

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

const AnalyzeImageSchema = z.object({
  imageBase64: z.string().min(100).max(MAX_BASE64_LEN),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
});

const ANALYSIS_PROMPT = `
Analyze this image and return ONLY a valid JSON object with no markdown fences, no explanation, no preamble. Use this exact schema:

{
  "analysis": {
    "subject": "<main subjects, people, objects>",
    "lighting": "<lighting quality and source>",
    "mood": "<emotional atmosphere>",
    "composition": "<framing, depth, angle>",
    "colors": "<dominant color palette>",
    "style": "<photographic or artistic style>",
    "environment": "<setting and background>"
  },
  "prompts": {
    "imageEdit": {
      "cinematic": "<cinematic photo enhancement — camera, lighting, grade, lens>",
      "luxury": "<luxury portrait or brand aesthetic prompt>",
      "wallpaper": "<high-resolution desktop wallpaper prompt>",
      "canva": "<Canva design-ready prompt with layout and style>",
      "tiktok": "<TikTok vertical format visual prompt>"
    },
    "videoEdit": "<full professional video direction: camera movement, lighting grade, transitions, pacing, mood, format>",
    "variants": {
      "viral": "<viral social media edit — hooks, energy, format>",
      "luxuryBrand": "<luxury brand advertisement — restraint, elegance, product focus>",
      "cinematic": "<cinematic film scene — narrative, arc, visual metaphor>",
      "aesthetic": "<aesthetic editorial montage — color story, texture, mood>"
    }
  }
}

Make each prompt specific, vivid, and directly informed by what is visible in this image. Respond with ONLY the JSON.
`.trim();

router.post(
  "/analyze-image",
  policyEngine({ cost: CREDIT_COSTS.image_analysis, rateKey: "image_analysis", rateMax: 10, rateWindowMs: 60_000, allowRecovery: true }),
  async (req: Request, res: Response) => {
    const parsed = AnalyzeImageSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        ...buildErrorResponse("image", "Invalid request"),
        details: parsed.error.flatten(),
      });
      return;
    }

    const { imageBase64, mimeType } = parsed.data;

    try {
      assertGeminiProvider(VISION_MODEL);

      const result = await withProviderTimeout(
        () => ai.models.generateContent({
          model: VISION_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType, data: imageBase64 } },
                { text: ANALYSIS_PROMPT },
              ],
            },
          ],
          config: {
            temperature: 0.3,
            maxOutputTokens: 4096,
          },
        }),
        ANALYSIS_TIMEOUT_MS,
        "gemini-vision",
      ) as Awaited<ReturnType<typeof ai.models.generateContent>>;

      const rawText = (result.text ?? "").trim();

      const jsonText = rawText
        .replace(/^```json?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

      let analysisData: Record<string, unknown>;
      try {
        analysisData = JSON.parse(jsonText) as Record<string, unknown>;
      } catch {
        logger.error({ rawText }, "[imageAnalysis] Gemini returned non-JSON");
        res.status(502).json(buildErrorResponse("image", new Error("Analysis response could not be parsed"), "gemini-vision"));
        return;
      }

      deductRequestCredits(req);
      appendCreditHeaders(req, res);

      res.json(buildStandardResponse("image", analysisData));
    } catch (err: unknown) {
      logger.error({ err }, "[imageAnalysis] analysis error");
      const errResponse = buildErrorResponse("image", err, "gemini-vision");
      const status = errResponse.code === "timeout" ? 504 : 503;
      res.status(status).json(errResponse);
    }
  },
);

export default router;
