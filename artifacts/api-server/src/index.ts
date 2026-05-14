import app from "./app";
import { logger } from "./lib/logger";
import { loadStore } from "./lib/credits";

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

// Load the credit store from disk before accepting requests.
// New users always default to the free plan, so the server is safe even
// if the file doesn't exist yet (first run).
await loadStore();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
