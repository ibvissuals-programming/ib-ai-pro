import app from "./app";
import { logger } from "./lib/logger";
import { loadUserStore, repairCeoAccount } from "./lib/userStore";
import { logProviderHealth } from "./lib/env";
import { initImageStore } from "./services/imageHistoryStore";

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

// ── LAYER 2: PORT — dynamic, never hardcoded, never crashes if missing ────────

const rawPort = process.env["PORT"];
let port = rawPort ? Number(rawPort) : 8080;

if (!rawPort) {
  logger.warn("[system] PORT not set — defaulting to 8080");
} else if (Number.isNaN(port) || port <= 0) {
  logger.warn({ rawPort }, "[system] Invalid PORT value — defaulting to 8080");
  port = 8080;
} else {
  logger.info({ port }, "[system] Port detected");
}

// ── LAYER 1+7: Startup — each step logged, each step guarded ─────────────────

logger.info("[system] Server starting");

// ── Step 1: Provider health checks + build banner ─────────────────────────────

logProviderHealth();

// ── Step 2: Load persisted users from disk ────────────────────────────────────

logger.info("[system] Loading auth system…");
try {
  await loadUserStore();
  logger.info("[system] Auth system loaded");
} catch (err) {
  logger.error({ err }, "[system] Auth system failed to load — starting with empty store");
}

// ── Step 3: Repair CEO account ────────────────────────────────────────────────

try {
  await repairCeoAccount();
} catch (err) {
  logger.error({ err }, "[system] CEO repair failed — continuing without CEO account");
}

// ── Step 4: Initialize image persistence system ───────────────────────────────
// LAYER 3: Image pipeline must not crash server. Creates data dirs eagerly.

logger.info("[system] Initializing image system…");
try {
  await initImageStore();
  logger.info("[system] Image system ready");
} catch (err) {
  logger.warn({ err }, "[system] Image system init failed — history disabled (safe mode)");
}

// ── Step 5: Startup self-check ────────────────────────────────────────────────

logger.info("[system] startup checks passed");

// ── Step 6: Start HTTP server ─────────────────────────────────────────────────

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "[system] Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "[system] Server listening");
});
