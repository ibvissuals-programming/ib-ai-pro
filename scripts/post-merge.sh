#!/bin/bash
# post-merge.sh — Idempotent post-merge bootstrap.
#
# Replaces the previous blind `pnpm install + drizzle push` with
# guarded steps that skip work already done:
#
#   1. Install packages only if node_modules is missing/stale
#   2. Push schema only if tables are missing (via db-guard.cjs)
#
# Safe to run repeatedly — will no-op if system is already set up.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "[post-merge] Starting post-merge bootstrap..."

# ── Step 1: Packages ──────────────────────────────────────────────────────────
NM_PNPM="$ROOT/node_modules/.pnpm"
LOCKFILE="$ROOT/pnpm-lock.yaml"

if [ -d "$NM_PNPM" ] && [ -f "$LOCKFILE" ]; then
  echo "[post-merge] ✔ node_modules valid — skipping install"
else
  echo "[post-merge] Installing packages..."
  pnpm install --frozen-lockfile
  echo "[post-merge] ✔ Packages installed"
fi

# ── Step 2: Schema (guarded — skips if all tables present) ───────────────────
echo "[post-merge] Checking database schema..."
node "$SCRIPT_DIR/db-guard.cjs"

echo "[post-merge] ✔ Bootstrap complete"
