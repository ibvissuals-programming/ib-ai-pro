import app from "./app";
import { logger } from "./lib/logger";
import { loadUserStore, repairCeoAccount } from "./lib/userStore";
import { logProviderHealth } from "./lib/env";
import { validateEnvBootstrap } from "./bootstrap/envBootstrap";
import { initImageStore } from "./services/imageHistoryStore";
import { markBootPhase, markBootDegraded } from "./lib/bootController";
import { loadSystemConfig, isPostgresEnabled, getLastMigrationRun } from "./lib/systemConfig";
import { runMigration } from "./lib/migrationRunner";
import { recoverStalledJobs } from "./services/imageJobManager";
import { cleanOldAudioFiles } from "./services/ttsService";
import { runStartupIntegrityCheck } from "./lib/startupIntegrityCheck";
import { enableSafeMode } from "./lib/safeMode";
import { runStartupHealthTests } from "./lib/startupHealthTest";

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

// ── PORT SETUP ────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 8080;

// ── BOOTSTRAP FUNCTION ────────────────────────────────────────────────────────

async function bootstrap() {
  logger.info("[system] Server starting");

  // STEP 0 — System config (storage mode etc.) — must run before loadUserStore()
  try {
    await loadSystemConfig();
  } catch (err) {
    logger.warn({ err }, "[system] System config load failed — using defaults");
  }
  markBootPhase("CONFIG");

  // STEP 1 — Environment validation + boot status banner (runs exactly once, cached)
  const bootStatus = validateEnvBootstrap();

  // STEP 2 — Auth system + DB load
  try {
    await loadUserStore();
    logger.info("[system] Auth loaded");
  } catch (err) {
    markBootDegraded("Auth system failed to load");
    logger.error({ err }, "[system] Auth failed (non-fatal)");
  }

  // STEP 3 — CEO account repair (create if missing, fix role if wrong)
  try {
    await repairCeoAccount();
  } catch (err) {
    markBootDegraded("CEO account repair failed");
    logger.error({ err }, "[system] CEO repair failed (non-fatal)");
  }

  // STEP 3b — User store index sync
  try {
    await runStartupIntegrityCheck();
  } catch (err) {
    logger.warn({ err }, "[system] Startup integrity check threw unexpectedly (non-fatal)");
  }

  markBootPhase("AUTH");

  // STEP 4 — AI provider checks (Gemini / safe mode)
  // Runs AFTER auth is fully loaded — AI failures must never block auth boot.
  // Use cached bootstrap result — no re-read of process.env.
  logProviderHealth();
  if (bootStatus.safeMode) {
    enableSafeMode("GEMINI_API_KEY is not set — set the secret and restart to enable AI features");
  }
  markBootPhase("AI");

  // STEP 5 — AI subsystem initialization
  try {
    await initImageStore();
    logger.info("[system] Image system ready");
  } catch (err) {
    markBootDegraded("Image subsystem failed to initialize");
    logger.warn({ err }, "[system] Image system disabled");
  }

  // Recover stalled jobs from previous run
  try {
    await recoverStalledJobs();
  } catch (err) {
    logger.warn({ err }, "[system] Stalled job recovery failed (non-fatal)");
  }

  // TTS audio TTL cleanup
  try {
    cleanOldAudioFiles();
  } catch (err) {
    logger.debug({ err }, "[system] TTS audio cleanup failed (non-fatal)");
  }

  markBootPhase("SYSTEMS");

  // Auto-migrate JSON → PostgreSQL on first boot with PG enabled
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

  logger.info("[system] Startup complete");

  // ── SERVER START ──────────────────────────────────────────────────────────

  app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "[system] Server listening");

    // Mark boot COMPLETE — /api/system/ready will return ready=true from here
    markBootPhase("COMPLETE");

    // STEP 6 — Automated health test suite runs after server is fully up
    runStartupHealthTests().catch((err) => {
      logger.error({ err }, "[healthTest] Unhandled error in startup health tests");
    });
  });
}

// Start system
bootstrap().catch((err) => {
  logger.error({ err }, "[system] Fatal startup error");
  process.exit(1);
});
