#!/usr/bin/env node
/**
 * ensure-env.cjs
 *
 * Auto-creates .env from .env.example if .env does not exist.
 * Safe to run multiple times (idempotent).
 * Run: node scripts/ensure-env.cjs
 */

const fs   = require("fs");
const path = require("path");

const root    = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const exPath  = path.join(root, ".env.example");

if (fs.existsSync(envPath)) {
  console.log("[ensure-env] .env already exists — skipping.");
  process.exit(0);
}

if (!fs.existsSync(exPath)) {
  console.error("[ensure-env] .env.example not found — cannot auto-create .env.");
  process.exit(1);
}

fs.copyFileSync(exPath, envPath);
console.log("[ensure-env] .env created from .env.example (all values are empty — fill in Replit Secrets or edit the file).");
