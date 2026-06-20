#!/usr/bin/env node
/**
 * startup-secrets-check.cjs
 *
 * Standalone script: prints a clear ✅/❌ checklist of every secret this app
 * needs, with instructions for any that are missing.
 *
 * Run manually after every reimport from GitHub:
 *   node startup-secrets-check.cjs
 *
 * Also called automatically by `pnpm run health`.
 *
 * Exit codes:
 *   0 — all CRITICAL and AI secrets present (app can start fully)
 *   1 — one or more CRITICAL or AI secrets missing
 */

"use strict";

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

function has(key) {
  const v = process.env[key];
  return typeof v === "string" && v.trim().length > 0;
}

function isJwtInsecure() {
  const raw = process.env["JWT_SECRET"];
  return !raw || raw === "ib-ai-dev-secret-change-in-production";
}

// ── Secret definitions ────────────────────────────────────────────────────────
//
// tier:
//   CRITICAL — missing → server cannot start
//   AI       — missing → safe mode (all AI routes blocked)
//   SECURITY — missing → insecure fallback, sessions reset on restart
//   OPTIONAL — missing → single feature degraded

const SECRETS = [
  {
    key:     "DATABASE_URL",
    tier:    "CRITICAL",
    present: () => has("DATABASE_URL"),
    found:   "Replit PostgreSQL connected",
    missing: "enable Replit DB integration — server WILL NOT START without this",
    where:   "Auto-set when you enable the Replit PostgreSQL integration",
  },
  {
    key:     "GEMINI_API_KEY",
    tier:    "AI",
    present: () => has("GEMINI_API_KEY"),
    found:   "AI features enabled (image gen, TTS, chat)",
    missing: "all AI routes blocked (safe mode active)",
    where:   "aistudio.google.com → Get API key → copy → Replit Secrets",
  },
  {
    key:     "CEO_PASSWORD",
    tier:    "CRITICAL",
    present: () => has("CEO_PASSWORD"),
    found:   "CEO account bootstrap ready",
    missing: "CEO login WILL FAIL on a fresh import — add before first boot",
    where:   "Replit Secrets → CEO_PASSWORD → any secure password you choose",
  },
  {
    key:     "JWT_SECRET",
    tier:    "SECURITY",
    present: () => !isJwtInsecure(),
    found:   "session tokens signed securely",
    missing: "insecure dev fallback active — sessions reset every restart",
    where:   "Replit Secrets → JWT_SECRET → any random 32+ character string",
  },
  {
    key:     "GROQ_API_KEY",
    tier:    "OPTIONAL",
    present: () => has("GROQ_API_KEY"),
    found:   "fast Llama chat enabled",
    missing: "Gemini fallback active — chat still works without this",
    where:   "console.groq.com → API keys → Replit Secrets",
  },
  {
    key:     "FAL_KEY",
    tier:    "OPTIONAL",
    present: () => has("FAL_KEY"),
    found:   "img2img editing enabled (subject identity preserved)",
    missing: "image editing falls back to text-to-image — identity not preserved",
    where:   "fal.ai → Account → API Keys → Replit Secrets (free $10 credit on signup)",
  },
  {
    key:     "HF_API_KEY",
    tier:    "OPTIONAL",
    present: () => has("HF_API_KEY"),
    found:   "HuggingFace image generation enabled",
    missing: "HF image generation disabled",
    where:   "huggingface.co → Settings → Access Tokens → New token (Read) → Replit Secrets",
  },
  {
    key:     "CEO_RECOVERY_KEY",
    tier:    "OPTIONAL",
    present: () => has("CEO_RECOVERY_KEY"),
    found:   "emergency CEO account reset enabled",
    missing: "emergency CEO reset disabled",
    where:   "Replit Secrets → CEO_RECOVERY_KEY → any secure random string",
  },
  {
    key:     "SESSION_SECRET",
    tier:    "OPTIONAL",
    present: () => has("SESSION_SECRET"),
    found:   "session signing secure",
    missing: "random per-process fallback active",
    where:   "Replit Secrets → SESSION_SECRET → any long random string",
  },
];

// ── Print ─────────────────────────────────────────────────────────────────────

console.log("");
console.log(DIVIDER);
console.log("  IB AI — SECRETS CHECKLIST");
console.log("  Re-add ALL of these after every reimport from GitHub");
console.log(DIVIDER);

let missingCritical = false;
let missingAi       = false;
const missing       = [];

for (const s of SECRETS) {
  const ok = s.present();

  if (!ok) {
    if (s.tier === "CRITICAL") missingCritical = true;
    if (s.tier === "AI")       missingAi       = true;
    missing.push(s);
  }

  const tierTag = s.tier === "CRITICAL" ? " [CRITICAL]"
                : s.tier === "AI"       ? " [AI]"
                : s.tier === "SECURITY" ? " [SECURITY]"
                : " [optional]";

  const label = s.key.padEnd(22);
  if (ok) {
    console.log(`  ✅ ${label} ${s.found}`);
  } else {
    console.log(`  ❌ ${label} missing${tierTag} — ${s.missing}`);
  }
}

console.log(DIVIDER);

if (missing.length === 0) {
  console.log("  ✅ All secrets present — app is fully configured");
} else {
  console.log(`  ❌ ${missing.length} secret(s) missing — add them in Replit Secrets tab:`);
  console.log("");
  for (const s of missing) {
    const tierTag = s.tier === "CRITICAL" ? "[CRITICAL] " : s.tier === "AI" ? "[AI] " : "";
    console.log(`     ${tierTag}${s.key}`);
    console.log(`       → ${s.where}`);
    console.log("");
  }
}

console.log(DIVIDER);
console.log("");

// Exit 1 only when the server genuinely cannot start or will be in safe mode
process.exit(missingCritical || missingAi ? 1 : 0);
