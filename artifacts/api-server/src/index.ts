import app from "./app";
import { logger } from "./lib/logger";
import { loadUserStore, repairCeoAccount } from "./lib/userStore";
import { logProviderHealth } from "./lib/env";
import { initImageStore } from "./services/imageHistoryStore";
import { setBootDegraded } from "./lib/bootState";

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

  // 1. Provider health check
  logProviderHealth();

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

  // 4. Image system
  try {
    await initImageStore();
    logger.info("[system] Image system ready");
  } catch (err) {
    setBootDegraded();
    logger.warn({ err }, "[system] Image system disabled");
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
