/**
 * envBootstrap.ts — Zero-config boot stabilization layer.
 *
 * Single entry point for ALL environment validation at startup.
 * Runs exactly once per process (result cached via bootstrapCache.ts).
 *
 * Classification:
 *   REQUIRED  — DATABASE_URL, CEO_USERNAME: missing → halt (process.exit)
 *   AI        — GEMINI_API_KEY: missing → SAFE_MODE (never halts boot)
 *   OPTIONAL  — SESSION_SECRET, CEO_RECOVERY_KEY: missing → warn only
 *
 * Exports:
 *   validateEnvBootstrap()  — run once at startup, prints banner, caches result
 *   getEnvStatus()          — returns cached status (or runs validation if needed)
 *   isBootstrapReady()      — true when REQUIRED vars are present
 */

import { logger } from "../lib/logger";
import {
  getCachedBootstrap,
  setCachedBootstrap,
  isBootstrapCached,
  type BootstrapStatus,
} from "./bootstrapCache";

// ── Internal helpers ──────────────────────────────────────────────────────────

function checkVar(key: string): boolean {
  const val = process.env[key];
  return typeof val === "string" && val.trim().length > 0;
}

function buildStatus(): BootstrapStatus {
  const db       = checkVar("DATABASE_URL");
  const gemini   = checkVar("GEMINI_API_KEY");
  const session  = checkVar("SESSION_SECRET");
  const ceoUser  = checkVar("CEO_USERNAME");
  const recovery = checkVar("CEO_RECOVERY_KEY");

  const missing:  string[] = [];
  const warnings: string[] = [];
  const critical: string[] = [];

  if (!db)       critical.push("DATABASE_URL");
  if (!ceoUser)  critical.push("CEO_USERNAME");
  if (!gemini)   missing.push("GEMINI_API_KEY");
  if (!session)  warnings.push("SESSION_SECRET");
  if (!recovery) warnings.push("CEO_RECOVERY_KEY");

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

function printBootstrapBanner(s: BootstrapStatus): void {
  const tick  = (v: boolean) => (v ? "✓" : "✗");
  const LINE  = "========================";

  logger.info(LINE);
  logger.info("=== IB AI BOOT STRAP ===");
  logger.info(LINE);
  logger.info(`DATABASE:  ${tick(s.vars.DATABASE_URL)}`);
  logger.info(`GEMINI:    ${tick(s.vars.GEMINI_API_KEY)}`);
  logger.info(`SESSION:   ${tick(s.vars.SESSION_SECRET)}`);
  logger.info(`RECOVERY:  ${tick(s.vars.CEO_RECOVERY_KEY)}`);
  logger.info(`AI MODE:   ${s.aiMode}`);
  logger.info(LINE);

  if (s.critical.length > 0) {
    logger.error(
      { missing: s.critical },
      "[bootstrap] CRITICAL secrets missing — system cannot start"
    );
  }
  if (s.missing.length > 0) {
    logger.warn(
      { missing: s.missing },
      "[bootstrap] AI provider secrets missing — SAFE MODE active"
    );
  }
  if (s.warnings.length > 0) {
    logger.warn(
      { optional: s.warnings },
      "[bootstrap] Optional secrets absent — some features degraded"
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run env validation once.  If cache already populated this is a no-op.
 * Prints the boot banner and returns the status.
 *
 * Halts the process (exit 1) only when DATABASE_URL or CEO_USERNAME is absent.
 * Missing GEMINI_API_KEY activates SAFE_MODE but never halts boot.
 */
export function validateEnvBootstrap(): BootstrapStatus {
  if (isBootstrapCached()) {
    return getCachedBootstrap()!;
  }

  const status = buildStatus();
  printBootstrapBanner(status);
  setCachedBootstrap(status);

  if (!status.ready) {
    logger.error(
      "[bootstrap] Cannot start — critical env vars missing. Halting."
    );
    process.exit(1);
  }

  return status;
}

/**
 * Return the cached status.  If validation has not run yet, runs it now.
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
