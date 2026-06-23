/**
 * envBootstrap.ts — Zero-config boot stabilization layer.
 *
 * Single entry point for ALL environment validation at startup.
 * Runs exactly once per process (result cached via bootstrapCache.ts).
 *
 * Variable classifications are driven by requiredSecrets.ts — the single
 * source of truth. Do not add raw process.env checks outside that file.
 *
 * Tiers:
 *   CRITICAL  — DATABASE_URL: missing → halt (process.exit)
 *   AI        — GEMINI_API_KEY, GROQ_API_KEY: missing → SAFE_MODE
 *   SECURITY  — JWT_SECRET: missing → insecure dev fallback, warn loudly
 *   OPTIONAL  — SESSION_SECRET, CEO_RECOVERY_KEY: missing → warn only
 *
 * Exports:
 *   validateEnvBootstrap()  — run once at startup, prints banner, caches result
 *   getEnvStatus()          — returns cached status (or runs validation if needed)
 *   isBootstrapReady()      — true when REQUIRED vars are present
 */

import { randomBytes } from "crypto";
import { logger } from "../lib/logger";
import {
  CRITICAL_SECRETS,
  AI_SECRETS,
  SECURITY_SECRETS,
  OPTIONAL_SECRETS,
  getSecretDef,
} from "../lib/requiredSecrets";
import {
  getCachedBootstrap,
  setCachedBootstrap,
  isBootstrapCached,
  type BootstrapStatus,
} from "./bootstrapCache";

// ── Auto-generation for optional-but-critical keys ────────────────────────────

/**
 * Auto-generates CEO_RECOVERY_KEY if absent.
 *
 * Sets the value in process.env for this server session only — it is NOT
 * persisted to disk or Replit Secrets automatically.  The generated key is
 * logged ONCE with a prominent "save this" banner so the operator can add it
 * to Replit Secrets for persistence across restarts.
 *
 * Why here: called before buildStatus() so every downstream consumer —
 * the secrets checklist, health endpoint, env.ts, and the auth recovery path —
 * all see the key as present without any additional changes.
 *
 * Behaviour:
 *   - CEO_RECOVERY_KEY already set → no-op, no log.
 *   - CEO_RECOVERY_KEY absent → generate 64 hex chars, set process.env,
 *     log prominently once.
 */
function autoGenerateRecoveryKey(): void {
  const existing = process.env["CEO_RECOVERY_KEY"];
  if (typeof existing === "string" && existing.trim().length > 0) return;

  const key = randomBytes(32).toString("hex"); // 64 hex chars
  process.env["CEO_RECOVERY_KEY"] = key;

  const D = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
  logger.warn(D);
  logger.warn("[system] CEO_RECOVERY_KEY was not set — auto-generated for this session");
  logger.warn("[system] ▶  SAVE THIS to Replit Secrets as CEO_RECOVERY_KEY:");
  logger.warn(`[system]    ${key}`);
  logger.warn("[system]    A NEW key is generated on every restart until saved.");
  logger.warn("[system]    Any recovery reset done this session will stop working");
  logger.warn("[system]    after the next restart unless you save the key above.");
  logger.warn(D);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function checkVar(key: string): boolean {
  const val = process.env[key];
  return typeof val === "string" && val.trim().length > 0;
}

function isJwtInsecure(): boolean {
  const raw = process.env["JWT_SECRET"];
  return !raw || raw === "ib-ai-dev-secret-change-in-production";
}

function buildStatus(): BootstrapStatus {
  const db       = checkVar("DATABASE_URL");
  const gemini   = checkVar("GEMINI_API_KEY");
  const groq     = checkVar("GROQ_API_KEY");
  const jwt      = checkVar("JWT_SECRET") && !isJwtInsecure();
  const session  = checkVar("SESSION_SECRET");
  const ceoUser  = checkVar("CEO_USERNAME");
  const recovery = checkVar("CEO_RECOVERY_KEY");
  const hfKey    = checkVar("HF_API_KEY");
  const falKey   = checkVar("FAL_KEY");

  const missing:  string[] = [];
  const warnings: string[] = [];
  const critical: string[] = [];

  // CRITICAL — halt if missing
  if (!db)      critical.push("DATABASE_URL");
  if (!ceoUser) critical.push("CEO_USERNAME");

  // AI — safe mode if missing
  if (!gemini) missing.push("GEMINI_API_KEY");
  if (!groq)   missing.push("GROQ_API_KEY");

  // SECURITY — insecure fallback if missing
  if (!jwt) warnings.push("JWT_SECRET");

  // OPTIONAL — feature degraded if missing
  if (!session)  warnings.push("SESSION_SECRET");
  if (!recovery) warnings.push("CEO_RECOVERY_KEY");
  if (!hfKey)    warnings.push("HF_API_KEY");
  if (!falKey)   warnings.push("FAL_KEY");

  const ready    = db && ceoUser;
  const safeMode = !gemini;
  const aiMode: "FULL" | "SAFE_MODE" = gemini ? "FULL" : "SAFE_MODE";

  return {
    ready:    !!ready,
    safeMode,
    aiMode,
    vars: {
      DATABASE_URL:     db,
      GEMINI_API_KEY:   gemini,
      GROQ_API_KEY:     groq,
      JWT_SECRET:       jwt,
      SESSION_SECRET:   session,
      CEO_USERNAME:     ceoUser,
      CEO_RECOVERY_KEY: recovery,
    },
    missing,
    warnings,
    critical,
    checkedAt: Date.now(),
  };
}

function printSetupInstructions(keys: string[]): void {
  for (const key of keys) {
    const def = getSecretDef(key);
    if (def) {
      logger.error(
        `  [setup] ${key}: ${def.description}`
      );
      logger.error(
        `  [setup] → ${def.setup}`
      );
    }
  }
}

function printSecretsChecklist(): void {
  const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  const checks: Array<{ key: string; present: boolean; note: string; missingNote: string }> = [
    {
      key:         "DATABASE_URL",
      present:     checkVar("DATABASE_URL"),
      note:        "Replit PostgreSQL connected",
      missingNote: "enable Replit DB integration — CRITICAL, server will not start",
    },
    {
      key:         "GEMINI_API_KEY",
      present:     checkVar("GEMINI_API_KEY"),
      note:        "AI features enabled (image gen, TTS, chat fallback)",
      missingNote: "add in Replit Secrets → safe mode active, all AI routes blocked",
    },
    {
      key:         "GROQ_API_KEY",
      present:     checkVar("GROQ_API_KEY"),
      note:        "fast Llama chat enabled",
      missingNote: "Gemini fallback active — chat still works (optional)",
    },
    {
      key:         "JWT_SECRET",
      present:     !isJwtInsecure(),
      note:        "token signing secure",
      missingNote: "add in Replit Secrets → insecure dev fallback active (sessions reset on restart)",
    },
    {
      key:         "CEO_PASSWORD",
      present:     checkVar("CEO_PASSWORD"),
      note:        "CEO account bootstrap ready",
      missingNote: "add in Replit Secrets → CEO login disabled on fresh import (required once per reimport)",
    },
    {
      key:         "FAL_KEY",
      present:     checkVar("FAL_KEY"),
      note:        "img2img editing enabled (identity-preserving)",
      missingNote: "image editing falls back to text-to-image — subject identity not preserved (optional)",
    },
    {
      key:         "HF_API_KEY",
      present:     checkVar("HF_API_KEY"),
      note:        "HuggingFace image generation enabled",
      missingNote: "HF image generation disabled (optional)",
    },
    {
      key:         "CEO_RECOVERY_KEY",
      present:     checkVar("CEO_RECOVERY_KEY"),
      note:        "emergency CEO account reset enabled",
      missingNote: "emergency CEO reset disabled (optional)",
    },
    {
      key:         "SESSION_SECRET",
      present:     checkVar("SESSION_SECRET"),
      note:        "session signing secure",
      missingNote: "random session fallback active (optional)",
    },
  ];

  logger.info(DIVIDER);
  logger.info("  SECRETS CHECKLIST — re-add all of these after every reimport from GitHub");
  logger.info(DIVIDER);
  for (const { key, present, note, missingNote } of checks) {
    const label = key.padEnd(22);
    if (present) {
      logger.info(`  ✅ ${label} ${note}`);
    } else {
      logger.warn(`  ❌ ${label} missing — ${missingNote}`);
    }
  }
  logger.info(DIVIDER);
}

function printBootstrapBanner(s: BootstrapStatus): void {
  const tick = (v: boolean) => (v ? "✓" : "✗");
  const LINE = "========================";

  const hfKey  = checkVar("HF_API_KEY");
  const falKey = checkVar("FAL_KEY");

  logger.info(LINE);
  logger.info("=== IB AI BOOT STRAP ===");
  logger.info(LINE);
  logger.info(`DATABASE:  ${tick(s.vars.DATABASE_URL)}`);
  logger.info(`GEMINI:    ${tick(s.vars.GEMINI_API_KEY)}`);
  logger.info(`GROQ:      ${tick(s.vars.GROQ_API_KEY)}`);
  logger.info(`JWT:       ${tick(s.vars.JWT_SECRET)}`);
  logger.info(`SESSION:   ${tick(s.vars.SESSION_SECRET)}`);
  logger.info(`RECOVERY:  ${tick(s.vars.CEO_RECOVERY_KEY)}`);
  logger.info(`HF_API_KEY:${tick(hfKey)}  ${hfKey ? "image generation enabled" : "image generation disabled"}`);
  logger.info(`FAL_KEY:   ${tick(falKey)}  ${falKey ? "image editing enabled" : "image editing disabled"}`);
  logger.info(`AI MODE:   ${s.aiMode}`);
  logger.info(LINE);

  printSecretsChecklist();

  if (s.critical.length > 0) {
    logger.error(
      { missing: s.critical },
      "[bootstrap] CRITICAL secrets missing — system cannot start"
    );
    logger.error("[bootstrap] Setup instructions:");
    printSetupInstructions(s.critical);
  }

  if (s.missing.length > 0) {
    // Only log "SAFE MODE active" when Gemini specifically is absent — Groq being
    // absent does not activate safe mode (Gemini fallback is used automatically).
    const geminiMissing = s.missing.includes("GEMINI_API_KEY");
    const msg = geminiMissing
      ? "[bootstrap] AI provider secrets missing — SAFE MODE active"
      : "[bootstrap] Optional AI provider secrets absent — Gemini fallback active";
    logger.warn({ missing: s.missing }, msg);
    for (const key of s.missing) {
      const def = getSecretDef(key);
      if (def) {
        logger.warn(`  [setup] ${key}: ${def.setup}`);
      }
    }
  }

  if (s.warnings.length > 0) {
    logger.warn(
      { optional: s.warnings },
      "[bootstrap] Optional/security secrets absent — some features degraded"
    );
    for (const key of s.warnings) {
      const def = getSecretDef(key);
      if (def) {
        logger.warn(`  [setup] ${key}: ${def.setup}`);
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run env validation once. If cache already populated this is a no-op.
 * Prints the boot banner and returns the status.
 *
 * Halts the process (exit 1) only when DATABASE_URL or CEO_USERNAME is absent.
 * Missing GEMINI_API_KEY activates SAFE_MODE but never halts boot.
 */
export function validateEnvBootstrap(): BootstrapStatus {
  if (isBootstrapCached()) {
    return getCachedBootstrap()!;
  }

  // Auto-generate CEO_RECOVERY_KEY before buildStatus() so every downstream
  // consumer (checklist, health endpoint, auth recovery path) sees it as present.
  autoGenerateRecoveryKey();

  const status = buildStatus();
  printBootstrapBanner(status);
  setCachedBootstrap(status);

  if (!status.ready) {
    logger.error(
      "[bootstrap] Cannot start — critical env vars missing. Halting."
    );
    logger.error(
      "[bootstrap] See setup instructions above, then restart the server."
    );
    process.exit(1);
  }

  return status;
}

/**
 * Return the cached status. If validation has not run yet, runs it now.
 * Safe to call from any module at any time.
 */
export function getEnvStatus(): BootstrapStatus {
  return getCachedBootstrap() ?? validateEnvBootstrap();
}

/**
 * True when all REQUIRED vars are present (DATABASE_URL + CEO_USERNAME).
 * Does not re-validate if already cached.
 */
export function isBootstrapReady(): boolean {
  return getEnvStatus().ready;
}
