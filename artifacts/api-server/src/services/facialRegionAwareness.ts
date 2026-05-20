/**
 * facialRegionAwareness.ts — IB AI Facial Region Awareness Engine (FRAE v1)
 *
 * Upgrades the editing system from generic prompt-aware editing to
 * subject-aware facial editing with identity preservation and
 * region-priority enhancement logic.
 *
 * Position in the pipeline:
 *   editIntelligence → APRE → [FRAE] → cinematic engine → editImage()
 *
 * Receives the original user prompt, editIntelligence result, and APRE result.
 * Wraps the APRE-reinforced prompt with targeted facial region directives and
 * identity preservation rules when a portrait-oriented edit is detected.
 *
 * Responsibilities:
 *   1. Detect portrait-oriented edit requests from category + prompt vocab
 *   2. Assign an enhancement profile (portrait_polish, beauty_retouch, etc.)
 *   3. Select and prioritize facial regions based on category + prompt keywords
 *   4. Inject identity preservation rules for portrait edits
 *   5. Inject targeted region-specific enhancement directives
 *   6. Deduplicate against existing APRE + editIntelligence content
 *   7. Debug-log all decisions server-side only
 *
 * Constraints:
 *   - Synchronous only — zero AI calls, zero DB access, zero async
 *   - Never throws — all errors return the APRE prompt unchanged
 *   - Additive only — never removes content from upstream layers
 *   - Modular — fully independent of APRE and editIntelligence internals
 *   - Preserves all existing pipeline contracts (auth, SSE, image contracts)
 */

import { logger } from "../lib/logger";
import type { EditInstructionResult } from "./editIntelligence";
import type { AdaptiveReinforcementResult } from "./adaptivePromptReinforcement";

// ── Public types ──────────────────────────────────────────────────────────────

export type FacialRegion =
  | "eyes"
  | "skin"
  | "lips"
  | "hair"
  | "jawline"
  | "lighting_depth"
  | "facial_texture"
  | "facial_symmetry";

export type EnhancementProfile =
  | "portrait_polish"
  | "beauty_retouch"
  | "cinematic_portrait"
  | "fashion_luxury"
  | "realism"
  | "general_portrait"
  | "none";

export interface FacialRegionInput {
  originalPrompt:    string;
  intelligenceResult: EditInstructionResult;
  apreResult:        AdaptiveReinforcementResult;
}

export interface FacialRegionResult {
  enhancedPrompt:    string;
  portraitDetected:  boolean;
  targetedRegions:   FacialRegion[];
  preservationRules: string[];
  enhancementProfile: EnhancementProfile;
}

// ── Portrait detection ────────────────────────────────────────────────────────
//
// Categories that inherently operate on human subjects

import type { EditCategory } from "./editIntelligence";

const PORTRAIT_CATEGORIES: EditCategory[] = [
  "face_enhancement",
  "beauty_retouch",
  "fashion_enhancement",
  "realism_enhancement",
  "relighting",
];

// Vocabulary patterns that indicate a person / face is the subject
const PORTRAIT_VOCAB: RegExp[] = [
  /\b(portrait|face|facial|person|people|subject|model|woman|man|him|her|them|their)\b/i,
  /\b(eyes?|gaze|iris|eyelash|eyebrow|brow|lids?)\b/i,
  /\b(skin|pore|complexion|tone|texture|dermis|blemish|wrinkle)\b/i,
  /\b(lips?|mouth|smile|teeth|chin|jaw|jawline|cheek|forehead)\b/i,
  /\b(hair|strand|tress|brunette|blonde|redhead)\b/i,
  /\b(retouch|beauty|makeup|glamour|editorial|headshot)\b/i,
];

function detectPortrait(
  prompt: string,
  category: EditCategory,
): boolean {
  if (PORTRAIT_CATEGORIES.includes(category)) return true;
  return PORTRAIT_VOCAB.some((rx) => rx.test(prompt));
}

// ── Enhancement profile assignment ───────────────────────────────────────────

function resolveProfile(
  category:        EditCategory,
  isPortrait:      boolean,
  prompt:          string,
): EnhancementProfile {
  if (!isPortrait) return "none";

  if (category === "face_enhancement")   return "portrait_polish";
  if (category === "beauty_retouch")     return "beauty_retouch";
  if (category === "fashion_enhancement") return "fashion_luxury";
  if (category === "realism_enhancement") return "realism";

  // relighting + cinematic_grading — check for portrait intent
  if (category === "relighting" || category === "cinematic_grading") {
    return "cinematic_portrait";
  }

  return "general_portrait";
}

// ── Region targeting ──────────────────────────────────────────────────────────
//
// Base regions by enhancement profile — ordered by priority (index 0 = highest)

const PROFILE_BASE_REGIONS: Record<EnhancementProfile, FacialRegion[]> = {
  portrait_polish:    ["eyes", "skin", "facial_texture", "facial_symmetry"],
  beauty_retouch:     ["skin", "facial_texture", "eyes", "lips"],
  cinematic_portrait: ["lighting_depth", "facial_texture", "eyes"],
  fashion_luxury:     ["hair", "eyes", "skin", "lips"],
  realism:            ["facial_texture", "skin", "facial_symmetry"],
  general_portrait:   ["skin", "eyes", "facial_texture"],
  none:               [],
};

// Keyword → additional regions to inject if not already targeted
const KEYWORD_REGION_MAP: Array<{ pattern: RegExp; regions: FacialRegion[] }> = [
  { pattern: /\b(eyes?|gaze|iris|catchlight|lash|brow)\b/i,        regions: ["eyes"] },
  { pattern: /\b(skin|pore|complexion|tone|blemish|texture)\b/i,   regions: ["skin", "facial_texture"] },
  { pattern: /\b(lips?|mouth|smile)\b/i,                            regions: ["lips"] },
  { pattern: /\b(hair|strand|tress)\b/i,                            regions: ["hair"] },
  { pattern: /\b(jaw|chin|face\s+shape|jawline)\b/i,                regions: ["jawline"] },
  { pattern: /\b(light|shadow|depth|cinematic|dramatic|religh)\b/i, regions: ["lighting_depth"] },
  { pattern: /\b(symmetry|proportion|balance|structure)\b/i,        regions: ["facial_symmetry"] },
];

function selectRegions(
  profile: EnhancementProfile,
  prompt:  string,
): FacialRegion[] {
  if (profile === "none") return [];

  const base = [...PROFILE_BASE_REGIONS[profile]];
  const regionSet = new Set<FacialRegion>(base);

  // Augment with keyword-driven regions
  for (const { pattern, regions } of KEYWORD_REGION_MAP) {
    if (pattern.test(prompt)) {
      for (const r of regions) regionSet.add(r);
    }
  }

  // Return in priority order: base regions first, then keyword additions
  const ordered: FacialRegion[] = [];
  for (const r of base) {
    if (regionSet.has(r)) { ordered.push(r); regionSet.delete(r); }
  }
  for (const r of regionSet) ordered.push(r);

  return ordered;
}

// ── Region enhancement directives ────────────────────────────────────────────
//
// Precise, model-actionable directives per facial region.
// Written to guide the vision model without over-constraining creative intent.

const REGION_DIRECTIVES: Record<FacialRegion, string> = {
  eyes:
    "Enhance eye clarity and natural luminosity — authentic iris detail, natural catchlights, refined lash definition — without altering eye shape, color, spacing, or emotional expression.",

  skin:
    "Refine skin quality with full natural texture preservation — reduce surface noise and uneven tone while retaining authentic pores, character marks, and natural skin variation throughout.",

  lips:
    "Enhance lip definition and natural color saturation without altering lip shape, size, volume, or facial expression.",

  hair:
    "Enhance hair detail, strand definition, natural shine, and volume with luxury editorial quality — preserve exact hair color, style, cut, and natural movement.",

  jawline:
    "Preserve exact jawline definition and natural facial bone structure — do not reshape, slim, extend, or alter the jaw or chin geometry in any way.",

  lighting_depth:
    "Apply cinematic lighting depth — enhance dimensional separation between facial planes, natural shadow gradation, and realistic skin luminance — maintain consistent and physically motivated light direction.",

  facial_texture:
    "Preserve authentic facial texture throughout — natural microdetail, skin grain, character marks, and subtle surface variation must remain intact, realistic, and free of artificial smoothing.",

  facial_symmetry:
    "Maintain natural facial symmetry and proportions — correct minor processing artifacts only. Do not alter bone structure, feature spacing, or the natural asymmetry that defines this person.",
};

// ── Identity preservation rules ───────────────────────────────────────────────
//
// Always injected when a portrait is detected.
// Addresses the most critical identity-drift failure modes in face editing.

const IDENTITY_PRESERVATION_RULES: string[] = [
  "Preserve exact subject identity — same face, same person, same defining features.",
  "Preserve bone structure, natural facial proportions, and spatial relationships between features.",
  "Preserve ethnicity and all characteristics that make this face uniquely recognizable.",
  "Avoid AI-generated facial reconstruction — no synthetic beauty reshaping or feature hallucination.",
  "Avoid face reshaping, face slimming, or any alteration of natural facial geometry.",
];

// ── Clause deduplication ──────────────────────────────────────────────────────
//
// Identical strategy as APRE — fingerprint-based word-overlap dedup.
// Prevents stacking with preservation rules already injected upstream.

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "this", "that", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "not", "no", "any", "all", "as", "by",
  "from", "into", "through", "same", "only", "also", "both", "each",
  "more", "most", "other", "such", "than", "then", "so",
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

function deduplicateAdditions(base: string, additions: string[]): string[] {
  const baseClauses = base
    .split(/[.]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  const seenFingerprints: string[][] = baseClauses.map(fingerprint);
  const kept: string[] = [];

  for (const addition of additions) {
    const fp = fingerprint(addition);
    if (fp.length < 2) { kept.push(addition); continue; }

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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a facial-region-aware enhancement prompt.
 *
 * Takes the outputs of editIntelligence and APRE. If a portrait/face-oriented
 * edit is detected, appends:
 *   - Identity preservation rules (deduped against upstream content)
 *   - Targeted region-specific enhancement directives (deduped)
 *
 * If no portrait is detected, returns the APRE prompt unchanged.
 *
 * NEVER throws — on any internal error, returns the APRE prompt unchanged.
 */
export function buildFacialRegionEnhancement(
  opts: FacialRegionInput,
): FacialRegionResult {
  const { originalPrompt, intelligenceResult, apreResult } = opts;

  try {
    const category = intelligenceResult.category;
    const basePrompt = apreResult.reinforcedPrompt;

    // ── Step 1: Portrait detection ────────────────────────────────────────────
    const portraitDetected = detectPortrait(originalPrompt, category);

    if (!portraitDetected) {
      logger.debug(
        { category, prompt: originalPrompt.slice(0, 60) },
        "[FRAE] portrait analysis complete — no portrait detected, passthrough",
      );
      return {
        enhancedPrompt:    basePrompt,
        portraitDetected:  false,
        targetedRegions:   [],
        preservationRules: [],
        enhancementProfile: "none",
      };
    }

    // ── Step 2: Enhancement profile ───────────────────────────────────────────
    const profile = resolveProfile(category, portraitDetected, originalPrompt);

    // ── Step 3: Region selection ──────────────────────────────────────────────
    const targetedRegions = selectRegions(profile, originalPrompt);

    // ── Step 4: Build candidate additions ────────────────────────────────────
    const candidates: string[] = [
      ...IDENTITY_PRESERVATION_RULES,
      ...targetedRegions.map((r) => REGION_DIRECTIVES[r]),
    ];

    // ── Step 5: Deduplicate against full base prompt ──────────────────────────
    const uniqueAdditions = deduplicateAdditions(basePrompt, candidates);

    // Separate preservation rules from region directives for structured output
    const preservationRulesApplied = uniqueAdditions.filter((a) =>
      IDENTITY_PRESERVATION_RULES.includes(a),
    );
    const regionDirectivesApplied = uniqueAdditions.filter((a) =>
      !IDENTITY_PRESERVATION_RULES.includes(a),
    );

    const allAdditions = [...preservationRulesApplied, ...regionDirectivesApplied];
    const enhancedPrompt =
      allAdditions.length > 0
        ? `${basePrompt} ${allAdditions.join(" ")}`
        : basePrompt;

    // ── Step 6: Debug logging ─────────────────────────────────────────────────
    logger.debug(
      {
        category,
        profile,
        portraitDetected,
        targetedRegions,
        preservationRulesCount: preservationRulesApplied.length,
        regionDirectivesCount:  regionDirectivesApplied.length,
        baseLength:             basePrompt.length,
        enhancedLength:         enhancedPrompt.length,
      },
      "[FRAE] portrait analysis complete",
    );

    logger.info(
      {
        profile,
        targetedRegions,
        additionsApplied: allAdditions.length,
        enhanced:         enhancedPrompt !== basePrompt,
      },
      "[FRAE] region targeting applied",
    );

    return {
      enhancedPrompt,
      portraitDetected,
      targetedRegions,
      preservationRules: preservationRulesApplied,
      enhancementProfile: profile,
    };

  } catch (err) {
    // Absolute failsafe — never break the edit pipeline
    logger.warn(
      { err, promptSlice: opts.originalPrompt.slice(0, 80) },
      "[FRAE] buildFacialRegionEnhancement threw — returning APRE prompt unchanged",
    );

    return {
      enhancedPrompt:    opts.apreResult.reinforcedPrompt,
      portraitDetected:  false,
      targetedRegions:   [],
      preservationRules: [],
      enhancementProfile: "none",
    };
  }
}
