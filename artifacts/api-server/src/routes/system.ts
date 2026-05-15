/**
 * System routes — IB AI Assistant.
 *
 * GET /api/system/version  — build metadata, provider readiness, uptime
 *
 * Public (no auth required) — returns no secrets, only boolean status.
 */
import { Router } from "express";
import { VERSION, BUILD_DATE, checkProviders } from "../lib/env";

const router = Router();

const BOOT_TIME = Date.now();

router.get("/system/version", (_req, res) => {
  const s = checkProviders();
  res.json({
    version: VERSION,
    build: BUILD_DATE,
    environment: process.env["NODE_ENV"] || "development",
    uptime: Math.floor((Date.now() - BOOT_TIME) / 1000),
    img2imgEnabled: s.gemini,
    recoveryEnabled: s.ceoRecovery,
  });
});

export default router;
