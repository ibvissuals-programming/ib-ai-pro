import app from "./app";
import { logger } from "./lib/logger";
import { loadUserStore, repairCeoAccount } from "./lib/userStore";
import { logProviderHealth } from "./lib/env";

// ── Process-level failure guards — registered FIRST ───────────────────────────
// Catch any unhandled error that escapes normal try/catch so we get a log
// entry instead of a silent crash. We do NOT exit — live requests continue.

process.on("uncaughtException", (err: Error) => {
  logger.error(
    { err: { name: err.name, message: err.message } },
    "[system] uncaughtException — process may be unstable",
  );
});

process.on("unhandledRejection", (reason: unknown) => {
  const message =
    reason instanceof Error ? reason.message : String(reason);
  logger.error({ message }, "[system] unhandledRejection");
});

// ── Validate PORT ─────────────────────────────────────────────────────────────

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── Provider health checks + build banner ─────────────────────────────────────
logProviderHealth();

// ── Step 1: Load persisted users from disk ────────────────────────────────────
await loadUserStore();

// ── Step 2: Safely repair CEO account ────────────────────────────────────────
await repairCeoAccount();

// ── Step 3: Startup self-check ────────────────────────────────────────────────
logger.info("[system] startup checks passed");

// ── Step 4: Start server ──────────────────────────────────────────────────────
app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "[system] Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "[system] Server listening");
});
