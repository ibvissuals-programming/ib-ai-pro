/**
 * Cinematic Insight Engine — IB AI Assistant
 *
 * Uses Gemini vision to analyze an image and produce structured professional
 * editing direction: lighting redesign, color grade, exposure guidance, mood
 * target, and a ready-to-use cinematic edit prompt.
 *
 * Two entry points:
 *   generateCinematicInsight()        — standalone analysis
 *   buildDirectorEnhancedPrompt()     — merge insight into an edit instruction
 *
 * IDENTITY RULE: All guidance produced by this engine respects the contract —
 * it enhances lighting, color, and mood ONLY. Subject identity, face geometry,
 * pose, and background structure are NEVER altered.
 */
import { logger } from "../lib/logger";

export const CINEMATIC_INSIGHT_MODEL   = "gemini-2.5-flash";
export const CINEMATIC_INSIGHT_TIMEOUT = 25_000;

// ── Output schema ─────────────────────────────────────────────────────────────

export interface CinematicInsight {
  sceneDescription:   string;
  lightingConditions: string;
  colorTone:          string;
  compositionType:    string;
  mood:               string;
  cinematicEditPrompt: string;
  lightingDirection:  string;
  colorGrade:         string;
  exposureGuidance:   string;
  moodTarget:         string;
}

// ── Gemini prompt ─────────────────────────────────────────────────────────────

const INSIGHT_PROMPT = `You are a professional cinematographer and photo colorist. Analyze this image and return ONLY valid JSON — no markdown fences, no preamble, no explanation.

Use this exact schema:
{
  "sceneDescription": "<subject, environment, context — 1 sentence>",
  "lightingConditions": "<current lighting: quality (hard/soft), direction, source type, shadow depth>",
  "colorTone": "<current palette: temperature (warm/cool/neutral), dominant hues, saturation level>",
  "compositionType": "<framing style, depth of field, camera angle, focal point>",
  "mood": "<current emotional atmosphere: neutral, warm, cold, dramatic, clinical, moody, etc.>",
  "cinematicEditPrompt": "<professional edit instruction for a photo editing AI: specific relighting, cinematic color grade, exposure redistribution, mood transformation. Must preserve subject identity. 2-3 sentences.>",
  "lightingDirection": "<specific redesign: new key light position, fill ratio, rim/hair light, color temperature of lights, shadow quality>",
  "colorGrade": "<precise recommendation: film stock emulation, color science (teal-orange, bleach bypass, Kodak Portra, etc.), shadow color, highlight color>",
  "exposureGuidance": "<redistribution: shadow lift target, highlight recovery, contrast curve shape, overall exposure direction>",
  "moodTarget": "<target after editing — one of: dramatic, intimate, editorial, cinematic, moody, vibrant, dark, golden, clean>"
}

Base every field on what is actually visible in this image. Be specific. Respond ONLY with the JSON object.`.trim();

// ── Core analysis function ────────────────────────────────────────────────────

export async function generateCinematicInsight(
  base64:   string,
  mimeType: string,
): Promise<CinematicInsight> {
  const { ai } = await import("@workspace/integrations-gemini-ai");

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const result = await Promise.race([
    ai.models.generateContent({
      model: CINEMATIC_INSIGHT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: INSIGHT_PROMPT },
          ],
        },
      ],
      config: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Cinematic insight timed out after ${CINEMATIC_INSIGHT_TIMEOUT}ms`)),
        CINEMATIC_INSIGHT_TIMEOUT,
      );
    }),
  ]);

  if (timeoutId !== undefined) clearTimeout(timeoutId);

  const raw = (result.text ?? "").trim()
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(raw) as CinematicInsight;
    logger.info(
      { model: CINEMATIC_INSIGHT_MODEL, moodTarget: parsed.moodTarget },
      "[cinematicInsight] analysis complete",
    );
    return parsed;
  } catch {
    logger.error({ raw: raw.slice(0, 300) }, "[cinematicInsight] JSON parse failed");
    throw new Error("Cinematic insight analysis returned unparseable output");
  }
}

// ── Director prompt builder ───────────────────────────────────────────────────
//
// Merges user request with Gemini-generated cinematic direction into a single
// enriched edit instruction. This feeds into buildStrongInstruction() as the
// user prompt, preserving all downstream enforcement layers (mode, intensity,
// variance enforcement, identity lock).

export function buildDirectorEnhancedPrompt(
  userPrompt: string,
  insight:    CinematicInsight,
): string {
  return (
    `USER REQUEST: ${userPrompt}. ` +
    `AI DIRECTOR BRIEF — ` +
    `Scene: ${insight.sceneDescription}. ` +
    `Current lighting: ${insight.lightingConditions}. ` +
    `LIGHTING REDESIGN: ${insight.lightingDirection}. ` +
    `COLOR GRADE: ${insight.colorGrade}. ` +
    `EXPOSURE: ${insight.exposureGuidance}. ` +
    `TARGET MOOD: ${insight.moodTarget}. ` +
    `CINEMATIC DIRECTION: ${insight.cinematicEditPrompt}`
  );
}
