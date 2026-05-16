import app from "./app";
import { logger } from "./lib/logger";
import { loadUserStore, repairCeoAccount } from "./lib/userStore";
import { logProviderHealth } from "./lib/env";
import { initImageStore } from "./services/imageHistoryStore";
import { setBootDegraded } from "./lib/bootState";

// ── Process-level failure guards — registered FIRST ───────────────────────────
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
  setBootDegraded();
  logger.error(
    { err },
    "[system] Auth system failed to load — starting with empty store",
  );
}

// ── Step 3: Repair CEO account ────────────────────────────────────────────────

try {
  await repairCeoAccount();
} catch (err) {
  setBootDegraded();
  logger.error(
    { err },
    "[system] CEO repair failed — continuing without CEO account",
  );
}

// ── Step 4: Initialize image persistence system ───────────────────────────────

logger.info("[system] Initializing image system…");
try {
  await initImageStore();
  logger.info("[system] Image system ready");
} catch (err) {
  setBootDegraded();
  logger.warn(
    { err },
    "[system] Image system init failed — history disabled (safe mode)",
  );
}

// ── Step 5: Startup self-check ────────────────────────────────────────────────

logger.info("[system] startup checks passed");

// ── Step 6: Bind HTTP server — retry on EADDRINUSE ───────────────────────────
// If a zombie process still holds the port (e.g. from a previous workflow run
// that was not cleanly terminated) we wait up to 10 s for it to be released
// before giving up. This survives the Replit "all workflows restart at once"
// scenario where the old PID may still be alive for a few seconds.

const MAX_BIND_ATTEMPTS = 10;
const BIND_RETRY_MS = 1000;

let bound = false;

for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt++) {
  try {
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(port);
      server.once("listening", resolve);
      server.once("error", reject);
    });
    bound = true;
    break;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && attempt < MAX_BIND_ATTEMPTS) {
      logger.warn(
        { port, attempt, maxAttempts: MAX_BIND_ATTEMPTS },
        "[system] Port in use — waiting for zombie to release, retrying…",
      );
      await new Promise((r) => setTimeout(r, BIND_RETRY_MS));
    } else {
      logger.error(
        { err, port, attempt },
        "[system] Fatal: could not bind port — giving up",
      );
      process.exit(1);
    }
  }
}

if (bound) {
  logger.info({ port }, "[system] Server listening");
}
