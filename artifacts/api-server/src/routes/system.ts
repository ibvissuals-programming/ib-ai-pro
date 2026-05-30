/**
 * System routes — IB AI Assistant.
 *
 * GET /api/system/version  — build metadata, provider readiness, uptime
 * GET /api/system/ready    — fast boot probe (always responds <2s, no DB/AI calls)
 *
 * Public (no auth required) — returns no secrets, only boolean status.
 */
import { Router } from "express";
import { VERSION, BUILD_DATE, SNAPSHOT, checkProviders } from "../lib/env";
import { getBootStatus, isSystemOperational, isDegradedMode, isBooting } from "../lib/bootController";
import { isGeminiConfigured } from "../lib/geminiEnv";

const router = Router();

const BOOT_TIME = Date.now();

router.get("/system/version", (_req, res) => {
  const s = checkProviders();
  res.json({
    version: VERSION,
    build: BUILD_DATE,
    snapshot: SNAPSHOT,
    environment: process.env["NODE_ENV"] || "development",
    uptime: Math.floor((Date.now() - BOOT_TIME) / 1000),
    img2imgEnabled: s.gemini,
    recoveryEnabled: s.ceoRecovery,
  });
});

// ── GET /api/system/ready ─────────────────────────────────────────────────────
//
// Lightweight boot probe. Rules:
//   - Always responds (never hangs, no DB calls, no AI calls)
//   - Synchronous reads only — guaranteed <2s response time
//   - Used by the frontend serverReadiness utility to gate the "starting" banner
//   - ready=true once COMPLETE phase is reached AND system is not degraded
//   - ready=true is also forced once the 10s boot timeout guard fires (degraded mode)
//
// Response shape consumed by serverReadiness.js:
//   { ready, booting, degraded, services: { db, ai, auth }, phase, timestamp }

router.get("/system/ready", (_req, res) => {
  const boot    = getBootStatus();
  const gemini  = isGeminiConfigured();
  const dbSet   = !!process.env["DATABASE_URL"];

  // ready=true if fully operational OR if in degraded mode (still usable, auth works)
  // Never return ready=false once the boot timeout has fired — that would freeze the UI.
  const ready = isSystemOperational() || isDegradedMode() || boot.timedOut;

  res.json({
    ready,
    booting:   isBooting(),
    degraded:  isDegradedMode(),
    services: {
      db:   dbSet,
      ai:   gemini,
      auth: true,   // auth is always available; never blocked by boot state
    },
    phase:     boot.phase,
    uptimeMs:  boot.uptimeMs,
    timestamp: Date.now(),
  });
});

export default router;
