#!/usr/bin/env node
/**
 * import-bootstrap.cjs — Fresh-import detector + one-pass validator.
 *
 * PHASE 2: Detects whether this is a fresh Replit import and performs
 * exactly what is needed — no more, no less.
 *
 * Detection criteria for "fresh import":
 *   - node_modules/.pnpm missing  (packages not installed)
 *   - OR DB tables are missing    (schema not pushed)
 *
 * Actions (guarded — each step skipped if already done):
 *   1. Install packages only if node_modules invalid
 *   2. Push schema only if tables missing
 *   3. Print concise system report
 *   4. STOP — no loops, no recursive calls
 *
 * Usage:
 *   node scripts/import-bootstrap.cjs
 *   node scripts/import-bootstrap.cjs --dry-run   (report only, no fixes)
 */

"use strict";
const { execSync } = require("child_process");
const net          = require("net");
const fs           = require("fs");
const path         = require("path");

const pgPath = require.resolve("pg", { paths: [path.join(__dirname, "..", "lib", "db")] });
const { Client } = require(pgPath);

const ROOT    = path.resolve(__dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

const REQUIRED_TABLES = [
  "users", "image_history", "admin_logs", "chat_sessions",
  "chat_messages", "user_memory", "image_jobs", "usage_analytics",
];

const OPTIONAL_SECRETS = [
  "GROQ_API_KEY", "VIDEO_ENABLED", "VEO_MODEL", "REDIS_URL",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function nodeModulesValid() {
  return fs.existsSync(path.join(ROOT, "pnpm-lock.yaml")) &&
         fs.existsSync(path.join(ROOT, "node_modules", ".pnpm"));
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.setTimeout(600);
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error",   () => { s.destroy(); resolve(false); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

async function getTableState() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return { connected: false, missing: REQUIRED_TABLES };
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const ph = REQUIRED_TABLES.map((_, i) => `$${i + 1}`).join(", ");
    const r  = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${ph})`,
      REQUIRED_TABLES
    );
    await client.end();
    const found   = r.rows.map((x) => x.table_name);
    const missing = REQUIRED_TABLES.filter((t) => !found.includes(t));
    return { connected: true, found, missing };
  } catch (err) {
    try { await client.end(); } catch (_) {}
    return { connected: false, error: err.message, missing: REQUIRED_TABLES };
  }
}

function isFreshImport(pkgsValid, dbMissing) {
  return !pkgsValid || dbMissing.length > 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  IB AI — Import Bootstrap");
  if (DRY_RUN) console.log("  (dry-run mode — no changes will be made)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // ── Step 1: Packages ───────────────────────────────────────────────────────
  const pkgsValid = nodeModulesValid();
  if (pkgsValid) {
    console.log("  ✔ Packages     node_modules valid — skipping install");
  } else if (!DRY_RUN) {
    console.log("  ↻ Packages     installing (first-time setup)...");
    execSync("pnpm install --frozen-lockfile", { stdio: "inherit", cwd: ROOT });
    console.log("  ✔ Packages     installed");
  } else {
    console.log("  ✗ Packages     node_modules missing — would install");
  }

  // ── Step 2: Database ───────────────────────────────────────────────────────
  const dbState = await getTableState();
  if (!dbState.connected) {
    console.log(`  ✗ Database     cannot connect — ${dbState.error || "DATABASE_URL not set"}`);
  } else if (dbState.missing.length === 0) {
    console.log(`  ✔ Database     all ${REQUIRED_TABLES.length} tables present — skipping push`);
  } else if (!DRY_RUN) {
    console.log(`  ↻ Database     missing ${dbState.missing.length} tables — pushing schema...`);
    execSync("node scripts/db-guard.cjs", { stdio: "inherit", cwd: ROOT });
    console.log("  ✔ Database     schema deployed");
  } else {
    console.log(`  ✗ Database     missing tables: ${dbState.missing.join(", ")} — would push`);
  }

  // ── Step 3: Workflows (detect duplicates) ──────────────────────────────────
  const [b1, b2, f1, f2] = await Promise.all([
    isPortOpen(8099), isPortOpen(8080),
    isPortOpen(5000), isPortOpen(23765),
  ]);
  const bePort = b1 ? 8099 : b2 ? 8080 : null;
  const fePort = f1 ? 5000 : f2 ? 23765 : null;
  const beCount = [b1, b2].filter(Boolean).length;
  const feCount = [f1, f2].filter(Boolean).length;

  if (beCount > 1 || feCount > 1) {
    console.log("  ! Workflows    duplicate instances detected — check workflow panel");
  } else if (bePort && fePort) {
    console.log(`  ✔ Workflows    backend :${bePort} | frontend :${fePort}`);
  } else {
    const down = [!bePort && "backend", !fePort && "frontend"].filter(Boolean).join(", ");
    console.log(`  ! Workflows    ${down} not running — start via Replit workflow panel`);
  }

  // ── Step 4: Secrets — full audit, ALL tiers, shown upfront in one pass ───────
  //
  // On a fresh import the agent must see every secret at once so it can request
  // them all in a single batch — not discover gaps later through broken features.
  //
  // Tiers:
  //   CRITICAL  — missing → server cannot start
  //   AI        — missing → all AI routes blocked (safe mode)
  //   SECURITY  — missing → insecure fallback, sessions reset on restart
  //   OPTIONAL  — missing → single feature degraded
  const ALL_SECRETS = [
    { key: "DATABASE_URL",     tier: "CRITICAL", note: "PostgreSQL connection — auto-set by Replit DB integration" },
    { key: "GEMINI_API_KEY",   tier: "AI",       note: "Image gen, TTS, AI chat — aistudio.google.com → Get API key" },
    { key: "CEO_PASSWORD",     tier: "CRITICAL", note: "Bootstraps admin account on every fresh import — any secure password" },
    { key: "JWT_SECRET",       tier: "SECURITY", note: "Signs session tokens — any random 32+ char string" },
    { key: "GROQ_API_KEY",     tier: "OPTIONAL", note: "Fast Llama chat — console.groq.com → API keys (Gemini fallback works without)" },
    { key: "FAL_KEY",          tier: "OPTIONAL", note: "img2img identity-preserving edits — fal.ai → Account → API Keys (free $10 credit)" },
    { key: "HF_API_KEY",       tier: "OPTIONAL", note: "HuggingFace image generation — huggingface.co → Settings → Access Tokens" },
    { key: "CEO_RECOVERY_KEY", tier: "OPTIONAL", note: "Emergency CEO account reset — any secure random string" },
    { key: "SESSION_SECRET",   tier: "OPTIONAL", note: "Server-side session signing — any long random string" },
  ];

  const missingSecrets  = ALL_SECRETS.filter((s) => !process.env[s.key]);
  const presentSecrets  = ALL_SECRETS.filter((s) => !!process.env[s.key]);
  const missingCritical = missingSecrets.filter((s) => s.tier === "CRITICAL" || s.tier === "AI");
  const missingOptional = missingSecrets.filter((s) => s.tier === "SECURITY" || s.tier === "OPTIONAL");

  console.log("");
  console.log("  ── Secrets checklist (add ALL of these on a fresh import) ──");
  for (const s of ALL_SECRETS) {
    const ok      = !!process.env[s.key];
    const tierTag = s.tier === "CRITICAL" ? "[CRITICAL]"
                  : s.tier === "AI"       ? "[AI]      "
                  : s.tier === "SECURITY" ? "[SECURITY]"
                  :                         "[optional]";
    const label   = s.key.padEnd(22);
    if (ok) {
      console.log(`  ✅ ${tierTag} ${label} present`);
    } else {
      console.log(`  ❌ ${tierTag} ${label} MISSING — ${s.note}`);
    }
  }

  if (missingSecrets.length === 0) {
    console.log("  ✔ Secrets      all present — fully configured");
  } else {
    console.log(`  ✗ Secrets      ${missingCritical.length} required + ${missingOptional.length} optional missing`);
    console.log("  Add them all via Replit Secrets tab to avoid discovering gaps later.");
  }
  console.log("");

  const geminiOk = !!process.env.GEMINI_API_KEY;
  const dbOk     = !!process.env.DATABASE_URL;

  // ── Step 5: Import summary ─────────────────────────────────────────────────
  const fresh = isFreshImport(pkgsValid, dbState.missing);
  const allOk = pkgsValid && dbState.connected && dbState.missing.length === 0 && geminiOk && dbOk;

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (fresh) {
    console.log(`  ↻ Fresh import detected — setup ${DRY_RUN ? "needed" : "complete"}`);
  } else {
    console.log("  ✔ Existing environment detected — no reinstall needed");
  }
  if (allOk || DRY_RUN) {
    console.log(`  ✔ Import READY (${Date.now() - t0}ms)`);
  } else {
    console.log(`  ✗ Import INCOMPLETE — resolve issues above`);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[import-bootstrap] Fatal:", err.message);
  process.exit(1);
});
