#!/usr/bin/env node
/**
 * startup-health.cjs — Fast pre-flight check for every backend boot.
 *
 * PHASE 5: Runs on every backend start to verify the environment is
 * ready before routes are registered.
 *
 * Checks (must complete in < 3s):
 *   ✔ DB connectivity         (SELECT 1)
 *   ✔ Gemini key              (env var present)
 *   ✔ Storage directories     (data/, data/images/, data/audio/)
 *   ✔ Required secrets        (GEMINI_API_KEY, DATABASE_URL)
 *   ✔ AI services availability (derived from env)
 *
 * Usage:
 *   node scripts/startup-health.cjs
 *   node scripts/startup-health.cjs --json
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const pgPath = require.resolve("pg", { paths: [path.join(__dirname, "..", "lib", "db")] });
const { Client } = require(pgPath);

const ROOT      = path.resolve(__dirname, "..");
const DATA_DIR  = path.join(ROOT, "artifacts", "data");
const JSON_MODE = process.argv.includes("--json");

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkDb() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return { ok: false, error: "DATABASE_URL not set" };
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 2500 });
  try {
    await client.connect();
    const t0 = Date.now();
    await client.query("SELECT 1");
    await client.end();
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    try { await client.end(); } catch (_) {}
    return { ok: false, error: err.message };
  }
}

function checkGemini() {
  return { ok: !!process.env.GEMINI_API_KEY };
}

function checkStorage() {
  const dirs = [
    DATA_DIR,
    path.join(DATA_DIR, "images"),
    path.join(DATA_DIR, "audio"),
  ];
  const missing = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      try { fs.mkdirSync(d, { recursive: true }); }
      catch { missing.push(d); }
    }
  }
  return { ok: missing.length === 0, created: dirs.length - missing.length };
}

function checkSecrets() {
  const required = { GEMINI_API_KEY: !!process.env.GEMINI_API_KEY, DATABASE_URL: !!process.env.DATABASE_URL };
  const optional = {
    JWT_SECRET:       !!process.env.JWT_SECRET,
    CEO_RECOVERY_KEY: !!process.env.CEO_RECOVERY_KEY,
    GROQ_API_KEY:     !!process.env.GROQ_API_KEY,
  };
  const criticalOk = Object.values(required).every(Boolean);
  return { ok: criticalOk, required, optional };
}

function checkAiServices() {
  const gemini = !!process.env.GEMINI_API_KEY;
  const groq   = !!process.env.GROQ_API_KEY;
  return {
    ok: gemini, // Gemini is the only required AI provider
    gemini:       { ok: gemini, provider: "gemini-primary" },
    groq:         { ok: groq, note: groq ? "available" : "optional — system works without it" },
    tts:          { ok: gemini, note: gemini ? "ready" : "needs GEMINI_API_KEY" },
    imageGen:     { ok: true,   note: "always available (Pollinations)" },
    imageEdit:    { ok: gemini, note: gemini ? "ready" : "needs GEMINI_API_KEY" },
    promptExpand: { ok: gemini, note: gemini ? "ready" : "needs GEMINI_API_KEY" },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  const [db, storage, secrets, ai] = await Promise.all([
    checkDb(),
    Promise.resolve(checkStorage()),
    Promise.resolve(checkSecrets()),
    Promise.resolve(checkAiServices()),
  ]);
  const gemini = checkGemini();

  const allOk = db.ok && gemini.ok && storage.ok && secrets.ok && ai.ok;
  const elapsed = Date.now() - t0;

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: allOk, db, gemini, storage, secrets, ai, durationMs: elapsed }, null, 2));
    process.exit(allOk ? 0 : 1);
  }

  const icon = (ok) => ok ? "✔" : "✗";

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  IB AI — Startup Health");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  ${icon(db.ok)}  DB          ${db.ok ? `connected (${db.latencyMs}ms)` : db.error}`);
  console.log(`  ${icon(gemini.ok)}  Gemini      ${gemini.ok ? "GEMINI_API_KEY present" : "GEMINI_API_KEY missing"}`);
  console.log(`  ${icon(storage.ok)}  Storage     ${storage.ok ? `directories ready (${storage.created} dirs)` : "failed to create dirs"}`);
  console.log(`  ${icon(secrets.ok)}  Secrets     ${secrets.ok ? "critical secrets present" : "CRITICAL secrets missing"}`);
  console.log(`  ${icon(ai.ok)}  AI Services ${ai.ok ? "gemini-primary mode ready" : "AI unavailable — GEMINI_API_KEY missing"}`);
  if (!ai.groq.ok) {
    console.log(`       ℹ  Groq: optional — chat will use Gemini fallback`);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  ${icon(allOk)} ${allOk ? "READY" : "NOT READY"} (${elapsed}ms)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[startup-health] Fatal:", err.message);
  process.exit(1);
});
