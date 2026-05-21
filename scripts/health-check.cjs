#!/usr/bin/env node
/**
 * health-check.cjs — Single-pass system validator.
 *
 * PHASE 6 of the import behavior lock.
 *
 * Checks (in order, stops early on fatal failures):
 *   1. Required environment secrets
 *   2. PostgreSQL connectivity + table existence
 *   3. API /health endpoint
 *
 * Output format (PHASE 7):
 *   ✔/✗ Workflows    (inferred from port availability)
 *   ✔/✗ Database     (connectivity + schema)
 *   ✔/✗ API          (/health endpoint)
 *   ✔/✗ Secrets      (required env vars)
 *   System ready / NOT READY
 *
 * Usage:
 *   node scripts/health-check.cjs
 *   node scripts/health-check.cjs --json   (machine-readable output)
 */

"use strict";
const http   = require("http");
const https  = require("https");
const net    = require("net");
const path   = require("path");
// Resolve pg from lib/db where it is declared as a dependency
const pgPath = require.resolve("pg", { paths: [path.join(__dirname, "..", "lib", "db")] });
const { Client } = require(pgPath);

const JSON_MODE = process.argv.includes("--json");

// ── Config ────────────────────────────────────────────────────────────────────

const REQUIRED_SECRETS = [
  { key: "GEMINI_API_KEY",    label: "Gemini AI key",        critical: true  },
  { key: "JWT_SECRET",        label: "JWT secret",           critical: false },
  { key: "CEO_RECOVERY_KEY",  label: "CEO recovery key",     critical: false },
  { key: "CEO_USERNAME",      label: "CEO username",         critical: false },
  { key: "DATABASE_URL",      label: "PostgreSQL URL",       critical: true  },
];

const REQUIRED_TABLES = [
  "users", "image_history", "admin_logs", "chat_sessions",
  "chat_messages", "user_memory", "image_jobs", "usage_analytics",
];

const BACKEND_PORTS  = [8099, 8080];
const FRONTEND_PORTS = [5000, 23765];

// ── Helpers ───────────────────────────────────────────────────────────────────

function icon(ok) { return ok ? "✔" : "✗"; }

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: "127.0.0.1" });
    sock.setTimeout(800);
    sock.on("connect", () => { sock.destroy(); resolve(true);  });
    sock.on("error",   () => { sock.destroy(); resolve(false); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

function fetchJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end",  () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ── Checks ────────────────────────────────────────────────────────────────────

function checkSecrets() {
  const results = [];
  let allCriticalOk = true;

  for (const { key, label, critical } of REQUIRED_SECRETS) {
    const present = !!process.env[key];
    if (!present && critical) allCriticalOk = false;
    results.push({ key, label, present, critical });
  }

  return { ok: allCriticalOk, results };
}

async function checkDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return { ok: false, error: "DATABASE_URL not set", tables: [] };

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const placeholders = REQUIRED_TABLES.map((_, i) => `$${i + 1}`).join(", ");
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (${placeholders})`,
      REQUIRED_TABLES
    );
    await client.end();

    const found   = result.rows.map((r) => r.table_name);
    const missing = REQUIRED_TABLES.filter((t) => !found.includes(t));
    return { ok: missing.length === 0, found, missing };
  } catch (err) {
    try { await client.end(); } catch (_) {}
    return { ok: false, error: err.message, tables: [] };
  }
}

async function checkWorkflows() {
  const backendPort  = await Promise.any(BACKEND_PORTS.map(isPortOpen)).catch(() => false);
  const frontendPort = await Promise.any(FRONTEND_PORTS.map(isPortOpen)).catch(() => false);

  // Find which specific ports are open
  const backendOpen  = (await Promise.all(BACKEND_PORTS.map(isPortOpen))).findIndex(Boolean);
  const frontendOpen = (await Promise.all(FRONTEND_PORTS.map(isPortOpen))).findIndex(Boolean);

  return {
    ok: backendPort && frontendPort,
    backend:  { ok: backendPort,  port: backendOpen  >= 0 ? BACKEND_PORTS[backendOpen]   : null },
    frontend: { ok: frontendPort, port: frontendOpen >= 0 ? FRONTEND_PORTS[frontendOpen] : null },
  };
}

async function checkApi(backendPort) {
  if (!backendPort) return { ok: false, error: "backend not reachable" };
  try {
    const { status, data } = await fetchJson(`http://127.0.0.1:${backendPort}/health`);
    return {
      ok:      status === 200 && data?.status !== undefined,
      status:  data?.status,
      gemini:  data?.checks?.provider?.geminiConfigured,
      uptime:  data?.uptime,
      httpCode: status,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  // Run checks in parallel where possible
  const [secretsResult, dbResult, workflowResult] = await Promise.all([
    Promise.resolve(checkSecrets()),
    checkDatabase(),
    checkWorkflows(),
  ]);

  const apiResult = await checkApi(workflowResult.backend?.port);

  const allOk =
    secretsResult.ok &&
    dbResult.ok &&
    workflowResult.ok &&
    apiResult.ok;

  if (JSON_MODE) {
    console.log(JSON.stringify({
      ok: allOk,
      secrets:   secretsResult,
      database:  dbResult,
      workflows: workflowResult,
      api:       apiResult,
      durationMs: Date.now() - t0,
    }, null, 2));
    process.exit(allOk ? 0 : 1);
  }

  // ── Human-readable output (PHASE 7 format) ────────────────────────────────
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  IB AI — System Health Check");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Workflows
  const wfIcon = icon(workflowResult.ok);
  const beStr  = workflowResult.backend.ok
    ? `backend :${workflowResult.backend.port}` : "backend DOWN";
  const feStr  = workflowResult.frontend.ok
    ? `frontend :${workflowResult.frontend.port}` : "frontend DOWN";
  console.log(`  ${wfIcon} Workflows    ${beStr} | ${feStr}`);

  // Database
  const dbIcon = icon(dbResult.ok);
  const dbStr  = dbResult.ok
    ? `connected (${dbResult.found?.length ?? 0}/${REQUIRED_TABLES.length} tables)`
    : dbResult.error || `missing: ${dbResult.missing?.join(", ")}`;
  console.log(`  ${dbIcon} Database     ${dbStr}`);

  // API
  const apiIcon = icon(apiResult.ok);
  const apiStr  = apiResult.ok
    ? `${apiResult.status} (uptime ${apiResult.uptime}s, gemini: ${apiResult.gemini ? "✔" : "✗"})`
    : apiResult.error || `HTTP ${apiResult.httpCode}`;
  console.log(`  ${apiIcon} API          ${apiStr}`);

  // Secrets
  const secIcon = icon(secretsResult.ok);
  const missing = secretsResult.results.filter((r) => !r.present);
  const secStr  = secretsResult.ok
    ? "all required secrets present"
    : `missing: ${missing.map((r) => r.key).join(", ")}`;
  console.log(`  ${secIcon} Secrets      ${secStr}`);

  // Optional secrets detail
  if (!secretsResult.ok) {
    for (const r of secretsResult.results) {
      if (!r.present) {
        const tag = r.critical ? " [CRITICAL]" : " [optional]";
        console.log(`       ✗ ${r.key}${tag} — ${r.label}`);
      }
    }
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (allOk) {
    console.log("  ✔ System READY  (" + (Date.now() - t0) + "ms)");
  } else {
    console.log("  ✗ System NOT READY — fix issues above");
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[health-check] Fatal error:", err.message);
  process.exit(1);
});
