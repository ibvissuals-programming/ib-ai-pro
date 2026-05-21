import app from "./app";
import { logger } from "./lib/logger";
import { loadUserStore, repairCeoAccount } from "./lib/userStore";
import { logProviderHealth } from "./lib/env";
import { initImageStore } from "./services/imageHistoryStore";
import { setBootDegraded } from "./lib/bootState";
import { loadSystemConfig, isPostgresEnabled, getLastMigrationRun } from "./lib/systemConfig";
import { runMigration } from "./lib/migrationRunner";
import { recoverStalledJobs } from "./services/imageJobManager";
import { cleanOldAudioFiles } from "./services/ttsService";
import { runStartupIntegrityCheck } from "./lib/startupIntegrityCheck";
import { enableSafeMode } from "./lib/safeMode";
import { isGeminiConfigured } from "./lib/geminiEnv";

// ── Global error handlers ─────────────────────────────────────────────────────

process.on("uncaughtException", (err: Error) => {
  logger.error(
    { err: { name: err.name, message: err.message } },
    "[system] uncaughtException"
  );
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.error(
    { message: reason instanceof Error ? reason.message : String(reason) },
    "[system] unhandledRejection"
  );
});

// ── PORT SETUP (Render-safe) ─────────────────────────────────────────────────

const port = Number(process.env.PORT) || 8080;

// ── BOOTSTRAP FUNCTION ────────────────────────────────────────────────────────

async function bootstrap() {
  logger.info("[system] Server starting");

  // 0. Load system config (storage mode etc.) — must run before loadUserStore()
  try {
    await loadSystemConfig();
  } catch (err) {
    logger.warn({ err }, "[system] System config load failed — using defaults");
  }

  // 1. Provider health check + safe mode gate
  logProviderHealth();
  if (!isGeminiConfigured()) {
    enableSafeMode("GEMINI_API_KEY is not set — set the secret and restart to enable AI features");
  }

  // 2. Load users
  try {
    await loadUserStore();
    logger.info("[system] Auth loaded");
  } catch (err) {
    setBootDegraded();
    logger.error({ err }, "[system] Auth failed (non-fatal)");
  }

  // 3. CEO account repair
  try {
    await repairCeoAccount();
  } catch (err) {
    setBootDegraded();
    logger.error({ err }, "[system] CEO repair failed (non-fatal)");
  }

  // 3b. Startup integrity check — silent, auto-repairs index inconsistencies
  try {
    await runStartupIntegrityCheck();
  } catch (err) {
    logger.warn({ err }, "[system] Startup integrity check threw unexpectedly (non-fatal)");
  }

  // 4. Auto-migrate JSON → PostgreSQL on first boot with PG enabled
  if (isPostgresEnabled() && getLastMigrationRun() === null) {
    logger.info("[system] PostgreSQL enabled — running initial JSON→PG migration");
    try {
      const result = await runMigration("system:auto");
      if (result) {
        logger.info(
          {
            users: result.users,
            history: result.history,
            durationMs: result.durationMs,
          },
          "[system] Initial migration complete"
        );
      }
    } catch (err) {
      logger.warn({ err }, "[system] Auto-migration failed (non-fatal) — PG still active");
    }
  }

  // 5. Image system
  try {
    await initImageStore();
    logger.info("[system] Image system ready");
  } catch (err) {
    setBootDegraded();
    logger.warn({ err }, "[system] Image system disabled");
  }

  // 6. Recover stalled jobs from previous run
  try {
    await recoverStalledJobs();
  } catch (err) {
    logger.warn({ err }, "[system] Stalled job recovery failed (non-fatal)");
  }

  // 7. TTS audio TTL cleanup
  try {
    cleanOldAudioFiles();
  } catch (err) {
    logger.debug({ err }, "[system] TTS audio cleanup failed (non-fatal)");
  }

  logger.info("[system] Startup complete");

  // ── CLEAN SERVER START ─────────────────────────────────────────────────────

  app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "[system] Server listening");
  });
}

// Start system
bootstrap().catch((err) => {
  logger.error({ err }, "[system] Fatal startup error");
  process.exit(1);
});
