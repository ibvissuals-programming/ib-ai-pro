import app from "./app";
import { logger } from "./lib/logger";
import { loadUserStore, repairCeoAccount } from "./lib/userStore";

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

// Step 1: Load persisted users from disk.
await loadUserStore();

// Step 2: Safely repair CEO account — ONLY touches the CEO record.
//   If CEO_PASSWORD env var is set, updates CEO's password hash.
//   Ensures CEO role is correct. Never modifies any other user.
await repairCeoAccount();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
