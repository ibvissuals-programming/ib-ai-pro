/**
 * adaptivePromptReinforcement.ts — IB AI Adaptive Prompt Reinforcement Engine (APRE v1)
 *
 * Transforms weak, vague, or low-quality edit instructions into strong,
 * structured, cinematic, identity-safe professional editing directives.
 *
 * Position in the pipeline:
 *   editIntelligence.ts → [APRE] → cinematic analysis → editImage()
 *
 * Receives the enriched prompt produced by editIntelligence (already
 * safety-cleaned, preservation-injected, template-applied) and further
 * reinforces it with category-specific professional directives.
 *
 * Responsibilities:
 *   1. Detect weak / vague prompts and score specificity (1–100)
 *   2. Expand weak prompts into structured professional instructions
 *   3. Inject category-aware cinematic enhancements
 *   4. Inject strength-calibrated transformation directives
 *   5. Inject human realism rules for person-present categories
 *   6. Deduplicate to prevent clause stacking with editIntelligence output
 *   7. Debug-log all decisions server-side only
 *
 * Constraints:
 *   - Pure synchronous — zero AI calls, zero DB access
 *   - Never throws — all errors return the prompt unchanged
 *   - Additive only — never removes content from editIntelligence output
 *   - Composable — fully independent of editIntelligence internals
 */

import { logger } from "../lib/logger";
import type { EditCategory, EditStrength } from "./editIntelligence";

// ── Public types ──────────────────────────────────────────────────────────────

export interface AdaptiveReinforcementInput {
  prompt:          string;
  category:        EditCategory;
  strength:        EditStrength;
  templateApplied: string | null | undefined;
}

export interface AdaptiveReinforcementResult {
  originalPrompt:       string;
  reinforcedPrompt:     string;
  enhancementsApplied:  string[];
  qualityScore:         number;
}

// ── Weak prompt detection ─────────────────────────────────────────────────────
//
// Patterns that indicate a semantically thin instruction — either too short,
// too generic, or providing no actionable direction to the model.
// Scored against the CORE of the prompt (content before "PRESERVATION RULES:").

const VAGUE_PATTERNS: RegExp[] = [
  /^(make\s+(it|this|him|her|them|the\s+image|photo)\s+(better|good|nice|great|look\s+good|look\s+nice|look\s+better))[.!?]?\s*$/i,
  /^(fix\s+(this|it|the\s+image|photo|picture))[.!?]?\s*$/i,
  /^(improve\s+(this|it|quality|the\s+image|the\s+photo)?)[.!?]?\s*$/i,
  /^(clean\s+(this|it|up|the\s+image|photo)?(\s*up)?)[.!?]?\s*$/i,
  /^(polish\s+(this|it|the\s+image|the\s+photo)?)[.!?]?\s*$/i,
  /^(enhance(\s+(this|it|the\s+image|the\s+photo|image|photo))?)[.!?]?\s*$/i,
  /^(make\s+(this|it)\s+(look\s+)?(more\s+)?(professional|cinematic|dramatic|better|nice|good))[.!?]?\s*$/i,
  /^(just\s+(make\s+(it|this)|fix|clean|improve|enhance)(\s+(better|good|nice|it|this))?)[.!?]?\s*$/i,
  /^(do\s+something\s+(with\s+)?(this|it|the\s+photo|the\s+image)?)[.!?]?\s*$/i,
  /^(make\s+(him|her|them)\s+look\s+(nice|good|better|great|professional))[.!?]?\s*$/i,
  /^(touch\s*up(\s+(this|the\s+image|the\s+photo))?)[.!?]?\s*$/i,
  /^(make\s+this\s+(pop|stand\s+out|shine|glow))[.!?]?\s*$/i,
  /^(retouch(\s+(this|the\s+image|photo))?)[.!?]?\s*$/i,
];

// Terms that indicate specificity — high presence → strong prompt
const SPECIFICITY_TERMS: RegExp[] = [
  /\b(cinematic|tonal(ity)?|color\s*grad(e|ing)?|exposure|contrast|saturation|highlights?|shadows?|midtones?|temperature|lut|grain|vignette|bokeh)\b/i,
  /\b(depth\s*of\s*field|lens\s*flare|film\s*stock|bleach\s*bypass|s.?curve|roll.?off|dynamic\s*range)\b/i,
  /\b(realism|photorealistic|identity|preserve|texture|authentic|natural\s+skin|pore|microstructure)\b/i,
  /\b(three.?point\s*light|key\s*light|fill\s*light|rim\s*light|studio\s*light|soft.?box|directional)\b/i,
  /\b(increase|decrease|reduce|add|remove|enhance|avoid|prevent|maintain|apply|balance|correct)\b/i,
  /\b(teal.?orange|warm|cool|muted|vivid|desaturated|palette|hue|luminance|chroma)\b/i,
];

// Terms that signal vagueness anywhere in the prompt
const VAGUENESS_SIGNALS: RegExp[] = [
  /\bmake\s+(it|this|him|her|them)\s+(better|nice|good|great|look\s+good)\b/i,
  /\bjust\s+(fix|make|clean|improve|enhance)\b/i,
  /\bdo\s+something\b/i,
  /\bmake\s+this\s+pop\b/i,
];

// Categories where people are typically present — human realism rules always applied
const PERSON_PRESENT_CATEGORIES: EditCategory[] = [
  "face_enhancement",
  "beauty_retouch",
  "fashion_enhancement",
  "relighting",
  "realism_enhancement",
  "general",
];

// ── Quality scoring ───────────────────────────────────────────────────────────
//
// Scores the prompt on a 1–100 scale.
// Based on: vagueness detection, specificity vocabulary, actionability, length.
// Template-applied prompts start with a significant bonus.

function scorePromptQuality(
  corePrompt:      string,
  templateApplied: string | null | undefined,
  isWeak:          boolean,
): number {
  let score = 45; // Neutral baseline

  // Template applied = already a professional-grade instruction
  if (templateApplied) score += 20;

  // Vagueness penalty
  if (isWeak) score -= 28;

  // Vagueness signals in full prompt (softer penalty — could be part of longer prompt)
  let vaguenessHits = 0;
  for (const rx of VAGUENESS_SIGNALS) {
    if (rx.test(corePrompt)) vaguenessHits++;
  }
  score -= vaguenessHits * 8;

  // Specificity vocabulary bonus
  let specificityHits = 0;
  for (const rx of SPECIFICITY_TERMS) {
    const matches = corePrompt.match(rx);
    if (matches) specificityHits += matches.length;
  }
  score += Math.min(specificityHits * 4, 25);

  // Word count / length factor
  const wordCount = corePrompt.trim().split(/\s+/).length;
  if (wordCount < 5)        score -= 15;
  else if (wordCount < 10)  score -= 8;
  else if (wordCount >= 30) score += 8;
  else if (wordCount >= 50) score += 12;

  return Math.min(100, Math.max(1, Math.round(score)));
}

// ── Expansion templates ───────────────────────────────────────────────────────
//
// Professional expansions for each category — applied when the core prompt
// is detected as weak/vague. Replaces the thin instruction with a structured,
// model-ready professional directive.

const WEAK_PROMPT_EXPANSIONS: Record<EditCategory, string> = {
  face_enhancement:
    "Enhance the portrait naturally with professional retouching. Improve facial clarity, lighting balance, and skin refinement while preserving exact facial geometry, ethnicity, age appearance, and identity. Apply clean tonal correction and subtle, controlled sharpening without over-processing.",

  beauty_retouch:
    "Apply natural beauty retouching: even skin tone, subtle blemish reduction, enhanced facial clarity, and preserved skin texture. Improve complexion quality while maintaining natural pores, character marks, and authentic skin detail. Avoid plastic, airbrushed, or poreless skin.",

  relighting:
    "Improve the lighting with professional cinematic balance: reduce harsh shadows, add realistic fill light, enhance subject-background separation. Maintain consistent light directionality, natural depth, and dimensional realism. Preserve complete subject identity and pose.",

  cinematic_grading:
    "Apply professional cinematic color grading: controlled tonal contrast, film-grade color balance, deep shadow separation with clean highlight roll-off. Create a dramatic yet photorealistic mood — rich, cinematic, and visually compelling while preserving subject identity.",

  background_edit:
    "Transform the background environment with cinematic depth and realistic integration. Render the new environment with matched environmental lighting and natural spatial depth. Preserve the subject exactly — face, body, clothing, and pose fully locked.",

  object_removal:
    "Remove the unwanted element surgically and reconstruct the area using natural surrounding content. Ensure seamless texture, color, and luminance matching. Zero visible artifacts, transition edges, or blur marks.",

  cleanup:
    "Remove all unwanted elements, artifacts, and distractions, then reconstruct the clean image base naturally. Eliminate noise, compression artifacts, and imperfections. Preserve all subject identity, facial structure, and image integrity.",

  fashion_enhancement:
    "Apply luxury fashion photography treatment: premium fabric texture rendering, editorial lighting quality, and aspirational color grade. Enhance garment presentation with professional styling. Preserve garment structure, drape, and complete subject identity.",

  realism_enhancement:
    "Enhance photographic realism: improve tonal range, refine texture detail, correct color balance, and increase natural sharpness. Output must pass as a high-quality DSLR photograph — authentic, detailed, and professionally processed. Preserve all identity and composition.",

  general:
    "Enhance the image with professional quality improvements: balanced lighting, refined tonal contrast, improved natural sharpness, and accurate color correction. Produce a polished, professional result while preserving all subject identity, composition, and natural proportions.",
};

// ── Category-aware enhancement addenda ───────────────────────────────────────
//
// Specific professional directives injected per category.
// These are added AFTER the core instruction (or expansion) to provide
// detailed model guidance that goes beyond what editIntelligence already covers.

const CATEGORY_ENHANCEMENTS: Record<EditCategory, string[]> = {
  face_enhancement: [
    "Enhance eye clarity and natural expression without altering eye shape, color, or spacing.",
    "Apply natural skin refinement only — maintain all defining facial character and structure.",
  ],
  beauty_retouch: [
    "Preserve natural pore texture throughout — no smoothing that removes skin character.",
    "Balance complexion evenly without flattening natural skin variation and tonal depth.",
  ],
  relighting: [
    "Ensure shadow direction is cinematically consistent and physically motivated.",
    "Balance highlights carefully — avoid specular blow-out or over-exposed skin.",
    "Maintain natural spatial depth and realistic subject-to-background separation.",
  ],
  cinematic_grading: [
    "Apply controlled tonal contrast — avoid crushing blacks or clipping highlights.",
    "Film-grade color separation across shadows, midtones, and highlights.",
    "Realistic palette — rich and cinematic without oversaturation or hyper-stylization.",
  ],
  background_edit: [
    "Ensure realistic edge integration between subject and new background at full resolution.",
    "Match the background environment lighting direction to the subject's existing light angle.",
  ],
  object_removal: [
    "Avoid blur, smear, or seam artifacts around the removal area.",
    "Reconstruct using exact local texture, luminance, and color from surrounding content.",
  ],
  cleanup: [
    "Avoid introducing blur artifacts from noise reduction — preserve edge sharpness.",
    "Reconstruct damaged or artifact-laden areas with natural local texture matching.",
  ],
  fashion_enhancement: [
    "Preserve fabric texture, drape, and garment structure with full realistic fidelity.",
    "Apply premium tonal balance — luxury editorial color rendering with cinematic quality.",
  ],
  realism_enhancement: [
    "Preserve authentic texture including natural skin imperfections and defining character.",
    "Avoid over-processing — output must look like a real, unedited DSLR photograph.",
  ],
  general: [
    "Maintain authentic image character, natural proportions, and subject identity throughout.",
  ],
};

// ── Human realism rules ───────────────────────────────────────────────────────
//
// Always injected when the category implies a person is present.
// Prevents the most common AI failure modes: face drift, skin plasticization,
// over-sharpening artifacts, anatomy distortion.

const HUMAN_REALISM_RULES: string[] = [
  "Preserve original facial identity — same person, same features, same ethnic appearance.",
  "Avoid AI-looking skin: no plastic texture, no poreless smoothness, no unnatural uniformity.",
  "Avoid over-sharpening that creates halation halos, edge ringing, or skin grain amplification.",
  "Maintain realistic anatomy — no warped, stretched, or distorted facial or body features.",
  "Preserve natural skin imperfections and character that define the person's authentic appearance.",
];

// ── Strength-calibrated reinforcement ─────────────────────────────────────────
//
// Strength directives from APRE are more specific than editIntelligence's
// addendum — they give the model clearer transformation boundaries.

const STRENGTH_DIRECTIVES: Record<EditStrength, string> = {
  subtle:
    "Apply the minimum effective change — the result must feel like a subtle professional polish, not a transformation. Maximum realism priority: output must look indistinguishable from a carefully retouched original.",
  balanced:
    "Apply clear, controlled improvement — a visible and meaningful upgrade without over-processing, dramatic departure, or any loss of natural authenticity.",
  cinematic:
    "Apply bold cinematic direction — dramatic, film-quality, and strongly atmospheric. Commit to the cinematic vision fully while maintaining photorealism and subject identity.",
  aggressive:
    "Apply the strongest transformation within identity-safe bounds. Decisive, fully committed output — do not hedge or soften the requested change. Execute completely.",
};

// ── Clause deduplication ──────────────────────────────────────────────────────
//
// Prevents semantic stacking when editIntelligence preservation rules and
// APRE enhancements express similar concepts.
// Strategy: fingerprint each clause by its significant words; skip new
// clauses whose fingerprint overlaps ≥60% with an already-seen fingerprint.

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "this", "that", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "not", "no", "any", "all", "as", "by",
  "from", "into", "through", "during", "before", "after", "above", "below",
  "up", "down", "out", "off", "over", "under", "same", "only", "also",
  "both", "each", "more", "most", "other", "such", "than", "then", "so",
]);

function fingerprint(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

function overlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const common = b.filter((w) => setA.has(w));
  return common.length / Math.min(a.length, b.length);
}

function deduplicateAdditions(
  base: string,
  additions: string[],
): string[] {
  // Build fingerprints from base clauses so we can compare
  const baseClauses = base
    .split(/[.]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  const seenFingerprints: string[][] = baseClauses.map(fingerprint);

  const kept: string[] = [];

  for (const addition of additions) {
    const fp = fingerprint(addition);
    if (fp.length < 2) {
      // Very short — keep unconditionally
      kept.push(addition);
      continue;
    }

    const isDuplicate = seenFingerprints.some(
      (seenFp) => overlapRatio(fp, seenFp) >= 0.60,
    );

    if (!isDuplicate) {
      kept.push(addition);
      seenFingerprints.push(fp);
    }
  }

  return kept;
}

// ── Core prompt extraction ────────────────────────────────────────────────────
//
// Extracts the user-intent portion of the enriched prompt (before the
// "PRESERVATION RULES:" tag added by editIntelligence) for accurate weakness
// detection. Falls back to the full prompt if no tag is found.

function extractCoreInstruction(enrichedPrompt: string): string {
  const tagIdx = enrichedPrompt.indexOf("PRESERVATION RULES:");
  if (tagIdx > 0) {
    return enrichedPrompt.slice(0, tagIdx).trim();
  }
  return enrichedPrompt.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build an adaptively reinforced edit instruction.
 *
 * Takes the enriched prompt from editIntelligence and adds:
 *   - Weak-prompt expansion (replaces thin core instruction)
 *   - Category-specific professional directives
 *   - Human realism rules (for person-present categories)
 *   - Strength-calibrated transformation boundaries
 *   - Deduplication against editIntelligence content
 *
 * NEVER throws — on any internal error, returns the original prompt unchanged.
 */
export function buildAdaptiveEditPrompt(
  opts: AdaptiveReinforcementInput,
): AdaptiveReinforcementResult {
  const { prompt, category, strength, templateApplied } = opts;

  try {
    const enhancementsApplied: string[] = [];

    // ── Step 1: Extract core instruction for weak-prompt detection ────────────
    const coreInstruction = extractCoreInstruction(prompt);

    // ── Step 2: Detect weakness ───────────────────────────────────────────────
    // Check the core instruction (not the PRESERVATION RULES block) for vagueness
    const isWeak =
      !templateApplied &&
      VAGUE_PATTERNS.some((rx) => rx.test(coreInstruction));

    // ── Step 3: Score quality ─────────────────────────────────────────────────
    const qualityScore = scorePromptQuality(prompt, templateApplied, isWeak);

    // ── Step 4: Build the reinforced prompt ───────────────────────────────────
    //
    // Layering:
    //   [base]         = prompt from editIntelligence (preserves all its content)
    //   [expansion]    = replaces thin core instruction if weak (prepended)
    //   [enhancements] = category-specific addenda (appended, deduped)
    //   [realism]      = human realism rules for person categories (appended, deduped)
    //   [strength]     = strength directive (appended, deduped)

    let reinforcedPrompt = prompt;

    // ── Step 4a: Weak prompt expansion ───────────────────────────────────────
    if (isWeak) {
      const expansion = WEAK_PROMPT_EXPANSIONS[category];
      // Prepend the expansion before the preservation rules block
      const tagIdx = reinforcedPrompt.indexOf("PRESERVATION RULES:");
      if (tagIdx > 0) {
        const preservationBlock = reinforcedPrompt.slice(tagIdx);
        reinforcedPrompt = `${expansion} ${preservationBlock}`;
      } else {
        reinforcedPrompt = `${expansion} ${reinforcedPrompt}`;
      }
      enhancementsApplied.push("weak_prompt_expansion");
    }

    // Candidates for deduplication-aware append
    const candidateAdditions: string[] = [];

    // ── Step 4b: Category-specific enhancements ───────────────────────────────
    const catEnhancements = CATEGORY_ENHANCEMENTS[category] ?? [];
    candidateAdditions.push(...catEnhancements);

    // ── Step 4c: Human realism rules (person-present categories only) ─────────
    const needsHumanRealism = PERSON_PRESENT_CATEGORIES.includes(category);
    if (needsHumanRealism) {
      candidateAdditions.push(...HUMAN_REALISM_RULES);
    }

    // ── Step 4d: Strength directive ───────────────────────────────────────────
    candidateAdditions.push(STRENGTH_DIRECTIVES[strength]);

    // ── Step 4e: Deduplicate additions against base ───────────────────────────
    const uniqueAdditions = deduplicateAdditions(reinforcedPrompt, candidateAdditions);

    if (uniqueAdditions.length > 0) {
      reinforcedPrompt = `${reinforcedPrompt} ${uniqueAdditions.join(" ")}`;

      // Track what was actually added
      if (catEnhancements.some((e) => uniqueAdditions.includes(e))) {
        enhancementsApplied.push(`category_enhancements:${category}`);
      }
      if (needsHumanRealism && HUMAN_REALISM_RULES.some((r) => uniqueAdditions.includes(r))) {
        enhancementsApplied.push("human_realism_rules");
      }
      if (uniqueAdditions.includes(STRENGTH_DIRECTIVES[strength])) {
        enhancementsApplied.push(`strength_directive:${strength}`);
      }
    }

    // ── Step 5: Debug log (server-side only) ──────────────────────────────────
    logger.debug(
      {
        category,
        strength,
        isWeak,
        qualityScore,
        enhancementCount:  enhancementsApplied.length,
        enhancements:      enhancementsApplied,
        coreLength:        coreInstruction.length,
        reinforcedLength:  reinforcedPrompt.length,
        templateApplied:   templateApplied ?? null,
      },
      "[APRE] reinforcement applied",
    );

    logger.info(
      {
        category,
        strength,
        qualityScore,
        enhancementCount: enhancementsApplied.length,
        reinforced:       reinforcedPrompt !== prompt,
      },
      "[imageEdit] APRE reinforcement complete",
    );

    return {
      originalPrompt:      prompt,
      reinforcedPrompt,
      enhancementsApplied,
      qualityScore,
    };

  } catch (err) {
    // Absolute failsafe — never break the edit pipeline
    logger.warn(
      { err, promptSlice: prompt.slice(0, 80) },
      "[APRE] buildAdaptiveEditPrompt threw — returning original prompt unchanged",
    );

    return {
      originalPrompt:      prompt,
      reinforcedPrompt:    prompt,
      enhancementsApplied: [],
      qualityScore:        50,
    };
  }
}
