/**
 * Centralized environment configuration — IB AI Assistant.
 *
 * Single source of truth for:
 *   - Build version / date
 *   - Provider availability checks
 *   - Startup health logging
 *
 * Rules:
 *   - Never throw here. Log warnings for missing optional config.
 *   - Only throw if a CRITICAL secret is entirely absent.
 *   - Never log secret values — only boolean presence.
 */
import { logger } from "./logger";
import { isGeminiConfigured } from "./geminiEnv";

export const VERSION = "1.0.0";
export const BUILD_DATE = "2026-05-19";
export const SNAPSHOT = "IB AI STABLE SNAPSHOT v1.0";

export interface ProviderStatus {
  gemini: boolean;
  jwtSecret: boolean;
  ceoRecovery: boolean;
  ceoConfigured: boolean;
}

export function checkProviders(): ProviderStatus {
  const jwtRaw = process.env["JWT_SECRET"];
  return {
    gemini: isGeminiConfigured(),
    // Flag as insecure if still using the well-known dev default
    jwtSecret: !!(jwtRaw && jwtRaw !== "ib-ai-dev-secret-change-in-production"),
    ceoRecovery: !!process.env["CEO_RECOVERY_KEY"],
    ceoConfigured: !!process.env["CEO_USERNAME"],
  };
}

/**
 * logProviderHealth() — call once at server startup.
 *
 * Logs the build banner and a clear warning for every missing/misconfigured
 * provider. Does NOT crash the process — callers decide severity.
 */
export function logProviderHealth(): void {
  const s = checkProviders();
  const env = process.env["NODE_ENV"] || "development";

  logger.info({ snapshot: SNAPSHOT }, "[system] IB AI Stable Build");
  logger.info({ version: VERSION, build: BUILD_DATE, environment: env }, "[system] version");

  if (!s.gemini) {
    logger.warn(
      "[system] Gemini provider NOT configured — AI features will be unavailable",
    );
  } else {
    logger.info("[system] Gemini provider OK");
  }

  if (!s.jwtSecret) {
    const msg =
      env === "production"
        ? "[system] WARN: JWT_SECRET is using dev default — set a strong secret before going live"
        : "[system] JWT_SECRET using dev default (acceptable in development)";
    logger.warn(msg);
  } else {
    logger.info("[system] JWT secret OK");
  }

  if (!s.ceoRecovery) {
    logger.warn("[system] CEO_RECOVERY_KEY missing — recovery mode disabled");
  } else {
    logger.info("[system] CEO recovery key OK");
  }

  if (!s.ceoConfigured) {
    logger.debug("[system] CEO_USERNAME not set (optional — no CEO auto-bootstrap)");
  } else {
    logger.info(`[system] CEO account target configured`);
  }
}
