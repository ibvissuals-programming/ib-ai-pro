/**
 * envConfig.ts — IB AI Assistant
 *
 * Centralized environment configuration. Single source of truth for ALL
 * environment variable access across the application.
 *
 * Rules:
 *   - Never throw here — callers decide severity.
 *   - Never log secret VALUES — only boolean presence.
 *   - All env var reads go through this module.
 *   - Boot guard and banner are both exported from here.
 *
 * Required (boot fails if missing):
 *   DATABASE_URL, CEO_USERNAME
 *
 * AI provider (missing → safe mode, never blocks boot):
 *   GEMINI_API_KEY
 *
 * Auth (auto-generated fallback if missing, warns only):
 *   JWT_SECRET, SESSION_SECRET
 *
 * Optional (gracefully disabled if absent):
 *   CEO_RECOVERY_KEY, CEO_PASSWORD, GROQ_API_KEY, REDIS_URL,
 *   VIDEO_ENABLED, VEO_MODEL, IMAGE_QUEUE_CONCURRENCY,
 *   DEFAULT_OBJECT_STORAGE_BUCKET_ID
 */

import { logger } from "./logger";

// ── Typed accessors ───────────────────────────────────────────────────────────
// Use these instead of raw process.env["..."] throughout the application.

export const ENV = {
  // ── Critical — boot fails if missing ──────────────────────────────────────
  DATABASE_URL:     (): string | undefined => process.env["DATABASE_URL"],
  CEO_USERNAME:     (): string | undefined => process.env["CEO_USERNAME"]?.trim().toLowerCase(),

  // ── AI provider — missing enables safe mode (never blocks boot) ───────────
  GEMINI_API_KEY:   (): string | undefined => process.env["GEMINI_API_KEY"],

  // ── Auth secrets — auto-generated fallbacks if missing ───────────────────
  JWT_SECRET:       (): string => process.env["JWT_SECRET"] ?? "ib-ai-dev-secret-change-in-production",
  SESSION_SECRET:   (): string | undefined => process.env["SESSION_SECRET"],

  // ── Optional — gracefully disabled if absent ──────────────────────────────
  CEO_RECOVERY_KEY: (): string | undefined => process.env["CEO_RECOVERY_KEY"],
  CEO_PASSWORD:     (): string | undefined => process.env["CEO_PASSWORD"]?.trim(),
  GROQ_API_KEY:     (): string | undefined => process.env["GROQ_API_KEY"],
  REDIS_URL:        (): string | undefined => process.env["REDIS_URL"],
  HF_API_KEY:       (): string | undefined => process.env["HF_API_KEY"],
  FAL_KEY:          (): string | undefined => process.env["FAL_KEY"],

  // ── Feature flags ─────────────────────────────────────────────────────────
  VIDEO_ENABLED:    (): boolean => process.env["VIDEO_ENABLED"]?.toLowerCase() === "true",
  VEO_MODEL:        (): string => process.env["VEO_MODEL"] ?? "veo-002",
  IMAGE_QUEUE_CONCURRENCY: (): number => Number(process.env["IMAGE_QUEUE_CONCURRENCY"]) || 2,
  DEFAULT_OBJECT_STORAGE_BUCKET_ID: (): string | undefined => process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"],

  // ── Debug / system ────────────────────────────────────────────────────────
  NODE_ENV:    (): string => process.env["NODE_ENV"] ?? "development",
  PORT:        (): number => Number(process.env["PORT"]) || 8080,
  DEBUG_CONTRACT:        (): boolean => process.env["DEBUG_CONTRACT"] === "true",
  MEMORY_INJECTION_DEBUG:(): boolean => process.env["MEMORY_INJECTION_DEBUG"] === "true",
  GEMINI_BASE_URL:       (): string | undefined => process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"],
} as const;

// ── Validation result ─────────────────────────────────────────────────────────

export interface EnvVar {
  key:      string;
  present:  boolean;
  tier:     "critical" | "ai" | "auth" | "optional";
  note:     string;
}

export interface EnvValidationResult {
  valid:   boolean;
  vars:    EnvVar[];
  missing: string[];
}

// ── Snapshot of all env var statuses ─────────────────────────────────────────

function snapshotEnv(): EnvVar[] {
  const jwtRaw    = process.env["JWT_SECRET"];
  const jwtFallback = !jwtRaw || jwtRaw === "ib-ai-dev-secret-change-in-production";

  return [
    {
      key:     "DATABASE_URL",
      present: !!process.env["DATABASE_URL"],
      tier:    "critical",
      note:    "PostgreSQL connection — required for auth and storage",
    },
    {
      key:     "CEO_USERNAME",
      present: !!process.env["CEO_USERNAME"],
      tier:    "critical",
      note:    "CEO account identity — required for admin bootstrap",
    },
    {
      key:     "GEMINI_API_KEY",
      present: !!process.env["GEMINI_API_KEY"],
      tier:    "ai",
      note:    "Gemini AI provider — missing disables all AI routes (safe mode)",
    },
    {
      key:     "JWT_SECRET",
      present: !jwtFallback,
      tier:    "auth",
      note:    jwtFallback
        ? "using auto-generated fallback (tokens reset on restart)"
        : "custom secret set",
    },
    {
      key:     "SESSION_SECRET",
      present: !!process.env["SESSION_SECRET"],
      tier:    "auth",
      note:    "optional — session integrity may be reduced if absent",
    },
    {
      key:     "CEO_RECOVERY_KEY",
      present: !!process.env["CEO_RECOVERY_KEY"],
      tier:    "optional",
      note:    "optional — emergency CEO account recovery disabled if absent",
    },
    {
      key:     "CEO_PASSWORD",
      present: !!process.env["CEO_PASSWORD"],
      tier:    "optional",
      note:    "optional — CEO bootstrap password (auto-generated if absent)",
    },
    {
      key:     "GROQ_API_KEY",
      present: !!process.env["GROQ_API_KEY"],
      tier:    "optional",
      note:    "optional — Groq provider disabled, Gemini used as fallback",
    },
    {
      key:     "REDIS_URL",
      present: !!process.env["REDIS_URL"],
      tier:    "optional",
      note:    "optional — in-memory queue used if absent",
    },
  ];
}

// ── validateEnv() — call once at startup ─────────────────────────────────────
//
// Logs clear per-variable warnings and returns validity flag.
// Only DATABASE_URL and CEO_USERNAME are critical (boot fails).
// Everything else is warned and degraded gracefully.

export function validateEnv(): EnvValidationResult {
  const vars    = snapshotEnv();
  const missing: string[] = [];
  let   valid   = true;

  for (const v of vars) {
    if (!v.present) {
      missing.push(v.key);

      if (v.tier === "critical") {
        logger.error(`[envConfig] Missing required environment variable: ${v.key} — ${v.note}`);
        valid = false;
      } else if (v.tier === "ai") {
        logger.warn(`[envConfig] Missing environment variable: ${v.key} — ${v.note}`);
      } else if (v.tier === "auth") {
        logger.warn(`[envConfig] Missing environment variable: ${v.key} — ${v.note}`);
      }
    }
  }

  return { valid, vars, missing };
}

// ── printBootStatusBanner() — grouped "IB AI BOOT STATUS" banner ─────────────
//
// Prints a single human-readable summary of all env var statuses at boot.
// Call after validateEnv() so callers have the validation result to pass in.

export function printBootStatusBanner(result: EnvValidationResult): void {
  const LINE = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  const geminiPresent  = result.vars.find((v) => v.key === "GEMINI_API_KEY")?.present ?? false;
  const jwtPresent     = result.vars.find((v) => v.key === "JWT_SECRET")?.present ?? false;
  const dbPresent      = result.vars.find((v) => v.key === "DATABASE_URL")?.present ?? false;
  const recoveryPresent= result.vars.find((v) => v.key === "CEO_RECOVERY_KEY")?.present ?? false;

  const aiStatus     = geminiPresent  ? "ENABLED"  : "SAFE MODE (AI routes disabled)";
  const authStatus   = dbPresent      ? "SECURE"   : "DEGRADED (no database)";
  const recoveryStatus = recoveryPresent ? "ENABLED" : "DISABLED (CEO_RECOVERY_KEY not set)";
  const jwtStatus    = jwtPresent     ? "CUSTOM"   : "AUTO-GENERATED (resets on restart)";

  const overallStatus = result.valid ? "READY" : "DEGRADED — see errors above";

  const varLines = result.vars.map((v) => {
    const icon   = v.present ? "✔" : (v.tier === "critical" ? "✗" : "⚠");
    const status = v.present ? "loaded" : `missing (${v.note})`;
    const padded = v.key.padEnd(32);
    return `  ${icon} ${padded} ${status}`;
  });

  logger.info(LINE);
  logger.info("IB AI BOOT STATUS");
  logger.info(LINE);
  logger.info("  Environment Variables:");
  for (const line of varLines) {
    logger.info(line);
  }
  logger.info(LINE);
  logger.info(`  AI Provider:     ${aiStatus}`);
  logger.info(`  Auth System:     ${authStatus}`);
  logger.info(`  JWT Token:       ${jwtStatus}`);
  logger.info(`  CEO Recovery:    ${recoveryStatus}`);
  logger.info(LINE);
  logger.info(`  BOOT: ${overallStatus}`);
  logger.info(LINE);
}
