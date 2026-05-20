/**
 * editIntelligence.ts — IB AI Edit Intelligence Layer (Phase 1)
 *
 * Modular prompt orchestration layer for image editing.
 *
 * Responsibilities:
 *   1. Classify user edit request into a typed category
 *   2. Apply prompt safety cleanup (prevent common failure patterns)
 *   3. Inject identity preservation rules matched to the category
 *   4. Apply reusable editing templates when keyword-matched
 *   5. Resolve edit strength from prompt vocabulary
 *   6. Build a normalized, enriched instruction for the pipeline
 *   7. Debug-log all decisions server-side (never exposed to frontend)
 *
 * Integration:
 *   The image edit route calls buildEditInstruction() before the pipeline.
 *   Returns enrichedPrompt — drop-in replacement for the user's raw prompt.
 *   All downstream pipeline stages (contracts, mode detection, intensity)
 *   are unchanged — this layer only improves the prompt that enters them.
 *
 * Constraints:
 *   - Pure synchronous — zero AI calls, zero DB access
 *   - Never throws — all errors return original prompt unchanged
 *   - Minimal token overhead — enriched prompt stays under 400 chars per section
 */

import { logger } from "../lib/logger";

// ── Edit categories ───────────────────────────────────────────────────────────

export type EditCategory =
  | "face_enhancement"
  | "cleanup"
  | "relighting"
  | "cinematic_grading"
  | "background_edit"
  | "object_removal"
  | "beauty_retouch"
  | "fashion_enhancement"
  | "realism_enhancement"
  | "general";

// ── Edit strength ─────────────────────────────────────────────────────────────
//
// User-facing strength levels — resolved from prompt vocabulary.
// Advisory only: they shape the enriched prompt but do not force-override
// the pipeline's mode/intensity resolution.
//
//   subtle     → minimal change, maximum identity preservation
//   balanced   → clear improvement, controlled transformation
//   cinematic  → bold cinematic output, identity preserved
//   aggressive → strong transformation, committed to the requested change

export type EditStrength = "subtle" | "balanced" | "cinematic" | "aggressive";

// ── Result type ───────────────────────────────────────────────────────────────

export interface EditInstructionResult {
  enrichedPrompt:    string;
  normalizedPrompt:  string;
  category:          EditCategory;
  strength:          EditStrength;
  preservationRules: string[];
  safetyFixes:       string[];
  templateApplied:   string | null;
}

// ── Category detection ────────────────────────────────────────────────────────
//
// Ordered by specificity — first match wins.
// More specific categories (object_removal, face_enhancement) checked before
// general ones (realism_enhancement) to prevent false assignment.

type CategorySpec = { category: EditCategory; patterns: RegExp[] };

const CATEGORY_SPECS: CategorySpec[] = [
  {
    category: "object_removal",
    patterns: [
      /\b(remove|erase|delete|get\s*rid\s*of)\b.{0,50}\b(watermark|text|logo|object|item|sticker|timestamp|overlay|banner|badge)\b/i,
      /\b(watermark|logo|timestamp|sticker)\b.{0,30}\b(remove|erase|delete|gone|off|out)\b/i,
    ],
  },
  {
    category: "background_edit",
    patterns: [
      /\b(change|replace|swap|transform|remove)\s+(the\s+)?background\b/i,
      /\bnew\s*background\b|\bbackground\s+(to|into)\b/i,
    ],
  },
  {
    category: "beauty_retouch",
    patterns: [
      /\b(beauty|retouch|glam(our)?|flawless|radiant|gorgeous|stunning)\b/i,
      /\b(smooth\s+(the\s+)?skin|skin\s*(smooth|soft|clear|glow|tone|retouch))\b/i,
    ],
  },
  {
    category: "face_enhancement",
    patterns: [
      /\b(face|facial|eyes?|lips?|teeth|jaw|cheek|forehead|eyebrow|eyelash|complexion|chin)\b/i,
      /\b(enhance|fix|improve)\s+(the\s+)?(face|eyes?|lips?|skin|expression)\b/i,
    ],
  },
  {
    category: "fashion_enhancement",
    patterns: [
      /\b(fashion|outfit|clothing|garment|wardrobe|editorial|vogue|runway|magazine|luxury\s*fashion|streetwear)\b/i,
    ],
  },
  {
    category: "cleanup",
    patterns: [
      /\b(clean\s*up|cleanup|fix|denoise|restore|recover|artifact|noise|grain|blemish|spot|acne|wrinkle|scar|mark)\b/i,
      /\b(remove\s+(noise|grain|artifact|blemish|spot|acne|wrinkle))\b/i,
    ],
  },
  {
    category: "relighting",
    patterns: [
      /\b(relight|relighting|lighting|shadow|exposure|bright(en)?|dark(en)?|highlight|illuminate|studio\s*light|golden\s*hour|backlit|rim\s*light)\b/i,
      /\b(add|change|improve)\s+(the\s+)?(light|lighting|glow|sunlight)\b/i,
    ],
  },
  {
    category: "cinematic_grading",
    patterns: [
      /\b(cinematic|color\s*grad(e|ing)?|mood|atmosphere|film\s*look|lut|teal.?orange|noir|film\s*grain|bleach\s*bypass)\b/i,
      /\b(make\s+(it\s+)?(more\s+)?(cinematic|moody|dramatic|atmospheric|filmic))\b/i,
    ],
  },
  {
    category: "realism_enhancement",
    patterns: [
      /\b(realistic|natural|lifelike|photorealistic|photo\s*real)\b/i,
      /\b(make\s+(it\s+)?(look\s+)?(more\s+)?(real|natural|realistic|professional|sharp|detailed))\b/i,
    ],
  },
];

function detectCategory(prompt: string): EditCategory {
  for (const { category, patterns } of CATEGORY_SPECS) {
    if (patterns.some((p) => p.test(prompt))) return category;
  }
  return "general";
}

// ── Edit strength detection ───────────────────────────────────────────────────
//
// Ordered: aggressive → cinematic → subtle → balanced (default).
// More specific strength markers override general ones.

type StrengthSpec = { strength: EditStrength; patterns: RegExp[] };

const STRENGTH_SPECS: StrengthSpec[] = [
  {
    strength: "aggressive",
    patterns: [
      /\b(completely\s+transform|total\s+transformation|extreme|full\s+transformation|completely\s+change|reimagine|overhaul|radical)\b/i,
      /\b(max(imum)?|hard|intense|powerful|strong)\s+(edit|transform|change|effect|grade)\b/i,
    ],
  },
  {
    strength: "cinematic",
    patterns: [
      /\b(cinematic|dramatic\s+light(ing)?|color\s*grad(e|ing)?|atmosphere|moody|hollywood|film\s*grade)\b/i,
    ],
  },
  {
    strength: "subtle",
    patterns: [
      /\b(subtle|slight|gentle|minor|small|light|soft|natural|barely|minimal|minimally|touch\s*up|a\s*little|just\s+a\s+bit)\b/i,
    ],
  },
];

function detectStrength(prompt: string): EditStrength {
  for (const { strength, patterns } of STRENGTH_SPECS) {
    if (patterns.some((p) => p.test(prompt))) return strength;
  }
  return "balanced";
}

// ── Prompt safety rules ───────────────────────────────────────────────────────
//
// Substitutes patterns that commonly cause:
//   - Face replacement or swap
//   - Gender drift
//   - Body distortion
//   - Over-sharpening (AI halo artifacts)
//   - Plastic / AI-looking skin (extreme smoothing)
//   - Anatomy corruption
//
// Each rule carries a label for debug tracing.
// All patterns use global flag for multi-occurrence replacement.

interface SafetyRule {
  label:       string;
  pattern:     RegExp;
  replacement: string;
}

const SAFETY_RULES: SafetyRule[] = [
  {
    label:       "face_replacement_prevention",
    pattern:     /\b(change|replace|swap|alter)\s+(the\s+)?face\b/gi,
    replacement: "enhance the face",
  },
  {
    label:       "different_person_prevention",
    pattern:     /\bmake\s+(them|him|her|me|the\s+person)\s+look\s+like\s+(a\s+)?different\s+person\b/gi,
    replacement: "enhance the natural appearance",
  },
  {
    label:       "gender_drift_prevention",
    pattern:     /\bmake\s+(them|him|her)\s+look\s+(more\s+)?(male|female|masculine|feminine|like\s+a\s+(man|woman|boy|girl))\b/gi,
    replacement: "apply subtle styling enhancement",
  },
  {
    label:       "over_sharpening_prevention",
    pattern:     /\b(ultra|maximum|max|extreme|hyper)\s*sharp(en)?\b/gi,
    replacement: "professional natural sharpening",
  },
  {
    label:       "ai_skin_prevention",
    pattern:     /\bmake\s+(the\s+)?skin\s+(completely\s+)?(smooth|perfect|flawless|poreless|airbrushed)\b/gi,
    replacement: "smooth skin naturally while preserving texture",
  },
  {
    label:       "body_distortion_prevention",
    pattern:     /\b(change|alter|reshape|transform)\s+(the\s+)?(body|figure|shape|physique|anatomy|weight|size)\b/gi,
    replacement: "enhance the overall appearance",
  },
  {
    label:       "ethnicity_change_prevention",
    pattern:     /\b(change|alter|make\s+(them|him|her|me))\s+(look\s+)?(more\s+)?(asian|black|white|hispanic|indian|african|european|lighter|darker\s+skin)\b/gi,
    replacement: "apply natural color grade",
  },
];

function applyPromptSafety(prompt: string): { cleaned: string; fixes: string[] } {
  let cleaned = prompt;
  const fixes: string[] = [];

  for (const rule of SAFETY_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(cleaned)) {
      rule.pattern.lastIndex = 0;
      cleaned = cleaned.replace(rule.pattern, rule.replacement);
      fixes.push(rule.label);
    }
    rule.pattern.lastIndex = 0;
  }

  return { cleaned, fixes };
}

// ── Identity preservation rules by category ───────────────────────────────────
//
// Injected into the enriched prompt as an explicit preservation block.
// Each rule is a direct instruction to the model — concise and unambiguous.

const PRESERVATION_BY_CATEGORY: Record<EditCategory, string[]> = {
  face_enhancement: [
    "preserve original facial identity and bone structure",
    "maintain ethnicity, age appearance, and natural skin character",
    "do not alter facial geometry or proportions",
  ],
  cleanup: [
    "preserve all facial features and identity",
    "maintain original skin texture and character",
    "do not change any structural element of the image",
  ],
  relighting: [
    "preserve face geometry, body proportions, and subject identity",
    "maintain pose and framing through the lighting change",
  ],
  cinematic_grading: [
    "preserve subject identity and recognizability",
    "maintain face structure — only color, tone, and mood may change",
  ],
  background_edit: [
    "preserve the subject exactly — face, body, clothing, and pose are locked",
    "only transform the background environment",
  ],
  object_removal: [
    "preserve all surrounding content and identity",
    "only remove the specified element and reconstruct naturally",
  ],
  beauty_retouch: [
    "preserve natural skin texture — no plastic, poreless, or AI-looking skin",
    "maintain original facial identity and ethnic features",
    "do not over-smooth or remove defining skin character",
  ],
  fashion_enhancement: [
    "preserve face and body identity exactly",
    "maintain natural proportions and pose",
  ],
  realism_enhancement: [
    "preserve original facial identity and composition",
    "maintain natural proportions — only quality and realism may improve",
  ],
  general: [
    "preserve subject identity, facial structure, and composition",
    "do not alter ethnicity, age, or body proportions",
  ],
};

// ── Editing templates ─────────────────────────────────────────────────────────
//
// Applied when the user prompt keyword-matches a known template.
// Template instruction replaces the normalized prompt.
// Preservation rules are still injected on top of the template.

interface EditTemplate {
  name:        string;
  triggers:    RegExp[];
  instruction: string;
}

const EDIT_TEMPLATES: EditTemplate[] = [
  {
    name:     "portrait_polish",
    triggers: [/\bportrait\s+polish\b/i, /\bpolish\s+(this\s+)?portrait\b/i],
    instruction:
      "Apply professional portrait retouching: natural skin smoothing, subtle eye enhancement, gentle blemish removal, soft fill-light correction. The output must look like a professionally retouched photograph of the same person.",
  },
  {
    name:     "cinematic_realism",
    triggers: [/\bcinematic\s+realism\b/i, /\brealism\s+cinematic\b/i],
    instruction:
      "Apply cinematic transformation with photorealistic integrity: dramatic directional lighting, controlled film-stock color grade, deep shadow separation, teal-orange tone balance, subtle grain. Subject identity fully preserved.",
  },
  {
    name:     "luxury_social",
    triggers: [/\bluxury\s+social\b/i, /\bluxury\s+(editorial|look|aesthetic|style)\b/i],
    instruction:
      "Apply luxury editorial photography treatment: warm soft-box lighting, premium skin-tone grade, aspirational lifestyle color palette, fashion-forward atmosphere, clean composition. Preserve subject identity and natural appearance.",
  },
  {
    name:     "natural_skin_cleanup",
    triggers: [/\bnatural\s+skin\s+cleanup\b/i, /\bskin\s+cleanup\s+natural\b/i],
    instruction:
      "Apply natural skin cleanup: even skin tone, reduce blemishes and redness, gentle highlight recovery. Preserve natural skin texture including pores and character detail. Do not create smooth, plastic, or airbrushed skin.",
  },
  {
    name:     "professional_lighting",
    triggers: [/\bprofessional\s+lighting\s+(enhancement|fix|correction)\b/i, /\bpro\s+lighting\b/i],
    instruction:
      "Apply professional studio lighting correction: balanced three-point setup, reduce harsh specular reflections, add gentle fill to shadow side, improve subject-background separation. Preserve complete subject identity.",
  },
];

function matchTemplate(prompt: string): EditTemplate | null {
  for (const tpl of EDIT_TEMPLATES) {
    if (tpl.triggers.some((rx) => rx.test(prompt))) return tpl;
  }
  return null;
}

// ── Strength guidance addendum ────────────────────────────────────────────────
//
// Appended to the enriched prompt to signal desired transformation strength.
// Kept short to minimize token cost.

const STRENGTH_ADDENDUM: Record<EditStrength, string> = {
  subtle:     "Apply subtle, minimal changes — keep the result very close to the original.",
  balanced:   "Apply a balanced transformation — clear visible improvement without over-processing.",
  cinematic:  "Apply a cinematic-grade transformation — bold, visually striking, film-quality result.",
  aggressive: "Apply a strong, decisive transformation — commit fully to the requested direction.",
};

// ── Public API ────────────────────────────────────────────────────────────────

export interface BuildEditInstructionOptions {
  userPrompt: string;
}

/**
 * Build a normalized, safety-cleaned, identity-aware edit instruction.
 *
 * Called by the image edit route before the pipeline.
 * Returns enrichedPrompt as a drop-in replacement for the user's raw prompt.
 *
 * NEVER throws — on any internal error, returns the original prompt unchanged
 * so the pipeline always has a valid instruction to work with.
 */
export function buildEditInstruction(
  opts: BuildEditInstructionOptions,
): EditInstructionResult {
  const { userPrompt } = opts;

  try {
    // ── Step 1: Safety cleanup ───────────────────────────────────────────────
    const { cleaned: safePrompt, fixes: safetyFixes } = applyPromptSafety(userPrompt);

    // ── Step 2: Classify ────────────────────────────────────────────────────
    const category = detectCategory(safePrompt);
    const strength  = detectStrength(safePrompt);

    // ── Step 3: Template match ───────────────────────────────────────────────
    const template = matchTemplate(safePrompt);

    // ── Step 4: Build normalized prompt ─────────────────────────────────────
    // Template instruction replaces the prompt body when matched.
    // Otherwise the safety-cleaned prompt is the base.
    const normalizedPrompt = template ? template.instruction : safePrompt;

    // ── Step 5: Assemble enriched prompt ────────────────────────────────────
    //
    // Structure:
    //   [EDIT INSTRUCTION] [PRESERVATION RULES] [STRENGTH GUIDANCE]
    //
    // Preservation rules are explicit directives in the model-visible text.
    // Strength guidance signals transformation strength to the model.

    const preservationRules = PRESERVATION_BY_CATEGORY[category];

    const preservationBlock =
      `PRESERVATION RULES: ${preservationRules.join(". ")}.`;

    const enrichedPrompt = [
      normalizedPrompt,
      preservationBlock,
      STRENGTH_ADDENDUM[strength],
    ].join(" ");

    // ── Step 6: Debug log (server-side only) ────────────────────────────────
    logger.debug(
      {
        originalPrompt:   userPrompt.slice(0, 120),
        normalizedPrompt: normalizedPrompt.slice(0, 120),
        category,
        strength,
        templateApplied:  template?.name ?? null,
        safetyFixes,
        preservationCount: preservationRules.length,
        enrichedLength:    enrichedPrompt.length,
      },
      "[editIntelligence] instruction built",
    );

    return {
      enrichedPrompt,
      normalizedPrompt,
      category,
      strength,
      preservationRules,
      safetyFixes,
      templateApplied: template?.name ?? null,
    };

  } catch (err) {
    // Absolute failsafe — never break the edit pipeline
    logger.warn(
      { err, promptSlice: userPrompt.slice(0, 80) },
      "[editIntelligence] buildEditInstruction threw — returning original prompt unchanged",
    );

    return {
      enrichedPrompt:    userPrompt,
      normalizedPrompt:  userPrompt,
      category:          "general",
      strength:          "balanced",
      preservationRules: PRESERVATION_BY_CATEGORY.general,
      safetyFixes:       [],
      templateApplied:   null,
    };
  }
}
