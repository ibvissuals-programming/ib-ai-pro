#!/usr/bin/env node
/**
 * db-guard.cjs — Idempotent schema migration guard.
 *
 * PHASE 3 of the import behavior lock.
 *
 * Rules:
 *   - Connects to PostgreSQL using DATABASE_URL.
 *   - Checks whether all required tables already exist.
 *   - If ALL tables are present → skips drizzle push entirely.
 *   - If ANY table is missing → runs `pnpm --filter @workspace/db run push`.
 *   - Never runs a full push on an already-migrated database.
 *
 * Usage:
 *   node scripts/db-guard.cjs
 *   node scripts/db-guard.cjs --force   (bypass guard and always push)
 */

"use strict";
const { execSync } = require("child_process");
const path         = require("path");
// Resolve pg from lib/db where it is declared as a dependency
const pgPath = require.resolve("pg", { paths: [path.join(__dirname, "..", "lib", "db")] });
const { Client }   = require(pgPath);

const REQUIRED_TABLES = [
  "users",
  "image_history",
  "admin_logs",
  "chat_sessions",
  "chat_messages",
  "user_memory",
  "image_jobs",
  "usage_analytics",
];

const FORCE = process.argv.includes("--force");

async function checkTables(client) {
  const placeholders = REQUIRED_TABLES.map((_, i) => `$${i + 1}`).join(", ");
  const result = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN (${placeholders})`,
    REQUIRED_TABLES
  );
  return result.rows.map((r) => r.table_name);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[db-guard] ✗ DATABASE_URL is not set — cannot check schema");
    process.exit(1);
  }

  if (FORCE) {
    console.log("[db-guard] --force flag set — running schema push unconditionally");
    runPush();
    return;
  }

  const client = new Client({ connectionString: dbUrl });

  try {
    await client.connect();
    const existing = await checkTables(client);
    await client.end();

    const missing = REQUIRED_TABLES.filter((t) => !existing.includes(t));

    if (missing.length === 0) {
      console.log(
        `[db-guard] ✔ All ${REQUIRED_TABLES.length} tables present — skipping schema push`
      );
      return;
    }

    console.log(`[db-guard] Missing tables: ${missing.join(", ")}`);
    console.log("[db-guard] Running schema push...");
    runPush();
  } catch (err) {
    try { await client.end(); } catch (_) {}
    console.error("[db-guard] ✗ DB connection failed:", err.message);
    console.log("[db-guard] Attempting schema push anyway (DB may be starting up)...");
    runPush();
  }
}

function runPush() {
  try {
    execSync("pnpm --filter @workspace/db run push", {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    console.log("[db-guard] ✔ Schema push complete");
  } catch (err) {
    console.error("[db-guard] ✗ Schema push failed:", err.message);
    process.exit(1);
  }
}

main();
