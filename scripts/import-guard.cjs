#!/usr/bin/env node
/**
 * import-guard.cjs — Deterministic one-pass import orchestrator.
 *
 * PHASES 1–6 of the import behavior lock.
 *
 * Flow:  scan → validate → fix → report → STOP
 *
 * Guards:
 *   - NEVER re-installs packages if node_modules is valid
 *   - NEVER re-pushes schema if all tables exist
 *   - NEVER requests secrets more than once per session
 *   - NEVER restarts workflows that are already running
 *   - Emits ONE clean status report at the end
 *
 * Usage:
 *   node scripts/import-guard.cjs
 *   node scripts/import-guard.cjs --fix   (auto-fix: install + push if needed)
 */

"use strict";
const { execSync, spawnSync } = require("child_process");
const net         = require("net");
const fs          = require("fs");
const path        = require("path");
// Resolve pg from lib/db where it is declared as a dependency
const pgPath = require.resolve("pg", { paths: [path.join(__dirname, "..", "lib", "db")] });
const { Client }  = require(pgPath);

const ROOT    = path.resolve(__dirname, "..");
const AUTO_FIX = process.argv.includes("--fix");

// ── Required tables ────────────────────────────────────────────────────────────
const REQUIRED_TABLES = [
  "users", "image_history", "admin_logs", "chat_sessions",
  "chat_messages", "user_memory", "image_jobs", "usage_analytics",
];

// ── Required secrets — ALL tiers, complete list ────────────────────────────────
// Collected ONCE and shown upfront so a fresh import can request everything in
// one batch rather than discovering gaps through broken features later.
//
// tiers:
//   CRITICAL  — missing → server cannot start
//   AI        — missing → all AI routes blocked (safe mode)
//   SECURITY  — missing → insecure fallback, sessions reset on restart
//   OPTIONAL  — missing → single feature degraded
const SECRETS_CONFIG = [
  { key: "DATABASE_URL",     tier: "CRITICAL", label: "PostgreSQL connection — auto-set by Replit DB integration" },
  { key: "GEMINI_API_KEY",   tier: "AI",       label: "Image gen, TTS, AI chat — aistudio.google.com → Get API key" },
  { key: "CEO_PASSWORD",     tier: "CRITICAL", label: "Bootstraps admin account on every fresh import — any secure password" },
  { key: "JWT_SECRET",       tier: "SECURITY", label: "Signs session tokens — any random 32+ char string" },
  { key: "GROQ_API_KEY",     tier: "OPTIONAL", label: "Fast Llama chat — console.groq.com → API keys (Gemini fallback works without)" },
  { key: "FAL_KEY",          tier: "OPTIONAL", label: "img2img identity-preserving edits — fal.ai → Account → API Keys (free $10 credit)" },
  { key: "HF_API_KEY",       tier: "OPTIONAL", label: "HuggingFace image gen — huggingface.co → Settings → Access Tokens" },
  { key: "CEO_RECOVERY_KEY", tier: "OPTIONAL", label: "Emergency CEO account reset — any secure random string" },
  { key: "SESSION_SECRET",   tier: "OPTIONAL", label: "Server-side session signing — any long random string" },
];

const BACKEND_PORTS  = [8099, 8080];
const FRONTEND_PORTS = [5000, 23765];

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(symbol, label, msg) {
  const pad = label.padEnd(14);
  console.log(`  ${symbol} ${pad} ${msg}`);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: "127.0.0.1" });
    sock.setTimeout(600);
    sock.on("connect", () => { sock.destroy(); resolve(true);  });
    sock.on("error",   () => { sock.destroy(); resolve(false); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

function nodeModulesValid() {
  // Quick validity check: pnpm lockfile exists + node_modules/.pnpm dir exists
  const lockfile = path.join(ROOT, "pnpm-lock.yaml");
  const nmPnpm   = path.join(ROOT, "node_modules", ".pnpm");
  return fs.existsSync(lockfile) && fs.existsSync(nmPnpm);
}

async function existingTables() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return { connected: false, tables: [] };
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const ph = REQUIRED_TABLES.map((_, i) => `$${i + 1}`).join(", ");
    const r  = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (${ph})`,
      REQUIRED_TABLES
    );
    await client.end();
    return { connected: true, tables: r.rows.map((x) => x.table_name) };
  } catch (err) {
    try { await client.end(); } catch (_) {}
    return { connected: false, error: err.message, tables: [] };
  }
}

function checkSecrets() {
  const missingSecretsCache = [];
  for (const s of SECRETS_CONFIG) {
    if (!process.env[s.key]) missingSecretsCache.push(s);
  }
  return missingSecretsCache;
}

function runCmd(cmd, label) {
  const result = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: ROOT });
  if (result.status !== 0) {
    console.error(`  ✗ ${label} failed (exit ${result.status})`);
    return false;
  }
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const issues = [];

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  IB AI — Import Guard (one-pass)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // ── PHASE 1: Packages ──────────────────────────────────────────────────────
  if (nodeModulesValid()) {
    log("✔", "Packages", "node_modules valid — skipping install");
  } else {
    if (AUTO_FIX) {
      log("↻", "Packages", "node_modules missing — installing...");
      runCmd("pnpm install --frozen-lockfile", "pnpm install");
    } else {
      log("✗", "Packages", "node_modules invalid — run: pnpm install");
      issues.push("packages");
    }
  }

  // ── PHASE 2: Workflows (port check — no restarts if already up) ────────────
  const [bePorts, fePorts] = await Promise.all([
    Promise.all(BACKEND_PORTS.map(isPortOpen)),
    Promise.all(FRONTEND_PORTS.map(isPortOpen)),
  ]);
  const beUp = bePorts.some(Boolean);
  const feUp = fePorts.some(Boolean);
  const bePort = BACKEND_PORTS[bePorts.findIndex(Boolean)] ?? null;
  const fePort = FRONTEND_PORTS[fePorts.findIndex(Boolean)] ?? null;

  if (beUp && feUp) {
    log("✔", "Workflows", `already running — backend :${bePort} | frontend :${fePort}`);
  } else {
    const down = [!beUp && "backend", !feUp && "frontend"].filter(Boolean).join(", ");
    log("✗", "Workflows", `${down} not running — start via Replit workflow panel`);
    issues.push("workflows");
  }

  // ── PHASE 3: Database + schema guard ──────────────────────────────────────
  const dbState = await existingTables();

  if (!dbState.connected) {
    const msg = dbState.error
      ? `cannot connect — ${dbState.error}`
      : "DATABASE_URL not set";
    log("✗", "Database", msg);
    issues.push("database-connection");
  } else {
    const missing = REQUIRED_TABLES.filter((t) => !dbState.tables.includes(t));
    if (missing.length === 0) {
      log("✔", "Database", `connected, all ${REQUIRED_TABLES.length} tables present — skipping push`);
    } else {
      log("!", "Database", `missing tables: ${missing.join(", ")}`);
      if (AUTO_FIX) {
        log("↻", "Database", "running schema push...");
        runCmd("node scripts/db-guard.cjs", "db-guard");
      } else {
        log("✗", "Database", "run: node scripts/db-guard.cjs");
        issues.push("database-schema");
      }
    }
  }

  // ── PHASE 4: Secrets — full checklist, ALL tiers, shown upfront ───────────
  // Print every secret (present and missing) so a fresh import reveals the
  // complete picture in one pass — no discovering gaps through broken features.
  const missingSecretsCache = checkSecrets();
  const criticalMissing = missingSecretsCache.filter(
    (s) => s.tier === "CRITICAL" || s.tier === "AI"
  );
  const otherMissing = missingSecretsCache.filter(
    (s) => s.tier === "SECURITY" || s.tier === "OPTIONAL"
  );

  console.log("");
  console.log("  ── Secrets checklist (add ALL of these on a fresh import) ──");
  for (const s of SECRETS_CONFIG) {
    const ok      = !!process.env[s.key];
    const tierTag = s.tier === "CRITICAL" ? "[CRITICAL]"
                  : s.tier === "AI"       ? "[AI]      "
                  : s.tier === "SECURITY" ? "[SECURITY]"
                  :                         "[optional]";
    const keyLabel = s.key.padEnd(22);
    if (ok) {
      console.log(`  ✅ ${tierTag} ${keyLabel} present`);
    } else {
      console.log(`  ❌ ${tierTag} ${keyLabel} MISSING — ${s.label}`);
    }
  }
  console.log("");

  if (missingSecretsCache.length === 0) {
    log("✔", "Secrets", "all present — fully configured");
  } else {
    if (criticalMissing.length > 0) {
      log("✗", "Secrets", `${criticalMissing.length} required missing: ${criticalMissing.map((s) => s.key).join(", ")}`);
      issues.push("secrets-critical");
    }
    if (otherMissing.length > 0) {
      log("!", "Secrets", `${otherMissing.length} optional/security missing — features degraded`);
    }
  }

  // ── PHASE 5: AI provider guard ─────────────────────────────────────────────
  const geminiOk = !!process.env.GEMINI_API_KEY;
  if (geminiOk) {
    log("✔", "AI Provider", "GEMINI_API_KEY present — Gemini provider ready");
  } else {
    log("✗", "AI Provider", "GEMINI_API_KEY missing — AI features unavailable");
  }

  // ── PHASE 6 + 7: Final report ──────────────────────────────────────────────
  const elapsed = Date.now() - t0;
  const ready   = issues.length === 0;

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (ready) {
    console.log(`  ✔ System READY (${elapsed}ms)`);
  } else {
    console.log(`  ✗ System NOT READY — issues: ${issues.join(", ")}`);
    console.log(`    Re-run with --fix to auto-resolve resolvable issues`);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  process.exit(ready ? 0 : 1);
}

main().catch((err) => {
  console.error("[import-guard] Fatal:", err.message);
  process.exit(1);
});
