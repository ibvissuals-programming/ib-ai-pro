/**
 * env.ts — Build metadata and provider health logging.
 *
 * Single source of truth for:
 *   - Build version / date
 *   - Provider availability checks (reads from requiredSecrets.ts)
 *   - Startup health logging
 *
 * Rules:
 *   - Never throw here. Log warnings for missing optional config.
 *   - Never log secret values — only boolean presence.
 *   - Secret definitions live in requiredSecrets.ts, not here.
 */
import { logger } from "./logger";
import { isGeminiConfigured } from "./geminiEnv";
import { getSecretDef } from "./requiredSecrets";

export const VERSION   = "1.0.0";
export const BUILD_DATE = "2026-05-19";
export const SNAPSHOT  = "IB AI STABLE SNAPSHOT v1.0";

export interface ProviderStatus {
  gemini:       boolean;
  groq:         boolean;
  jwtSecret:    boolean;
  ceoRecovery:  boolean;
  ceoConfigured: boolean;
}

export function checkProviders(): ProviderStatus {
  const jwtRaw = process.env["JWT_SECRET"];
  return {
    gemini:        isGeminiConfigured(),
    groq:          !!(process.env["GROQ_API_KEY"]?.trim()),
    jwtSecret:     !!(jwtRaw && jwtRaw !== "ib-ai-dev-secret-change-in-production"),
    ceoRecovery:   !!process.env["CEO_RECOVERY_KEY"],
    ceoConfigured: !!process.env["CEO_USERNAME"],
  };
}

/**
 * logProviderHealth() — call once at server startup.
 *
 * Logs the build banner and a clear warning for every missing/misconfigured
 * provider, including the setup instruction from requiredSecrets.ts.
 * Does NOT crash the process — callers decide severity.
 */
export function logProviderHealth(): void {
  const s   = checkProviders();
  const env = process.env["NODE_ENV"] || "development";

  logger.info({ snapshot: SNAPSHOT }, "[system] IB AI Stable Build");
  logger.info({ version: VERSION, build: BUILD_DATE, environment: env }, "[system] version");

  if (!s.gemini) {
    const def = getSecretDef("GEMINI_API_KEY");
    logger.warn("[system] Gemini provider NOT configured — AI features will be unavailable");
    if (def) logger.warn(`  [setup] → ${def.setup}`);
  } else {
    logger.info("[system] Gemini provider OK");
  }

  if (!s.groq) {
    const def = getSecretDef("GROQ_API_KEY");
    logger.warn("[system] Groq provider NOT configured — chat will use Gemini fallback");
    if (def) logger.warn(`  [setup] → ${def.setup}`);
  } else {
    logger.info("[system] Groq provider OK");
  }

  if (!s.jwtSecret) {
    const def = getSecretDef("JWT_SECRET");
    const msg =
      env === "production"
        ? "[system] CRITICAL: JWT_SECRET is missing or using dev default — set a strong secret before going live"
        : "[system] JWT_SECRET using dev default (acceptable in development)";
    logger.warn(msg);
    if (def) logger.warn(`  [setup] → ${def.setup}`);
  } else {
    logger.info("[system] JWT secret OK");
  }

  if (!s.ceoRecovery) {
    const def = getSecretDef("CEO_RECOVERY_KEY");
    logger.warn("[system] CEO_RECOVERY_KEY missing — recovery mode disabled");
    if (def) logger.warn(`  [setup] → ${def.setup}`);
  } else {
    logger.info("[system] CEO recovery key OK");
  }

  if (!s.ceoConfigured) {
    logger.debug("[system] CEO_USERNAME not set (optional — no CEO auto-bootstrap)");
  } else {
    logger.info("[system] CEO account target configured");
  }
}
