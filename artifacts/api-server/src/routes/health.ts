import { Router, type IRouter } from "express";
import { getBootState } from "../lib/bootState";

const router: IRouter = Router();

// ── LAYER 6: Health check — always returns, never throws ─────────────────────
// Returns uptime, boot state and mode so Replit and monitoring tools can
// detect whether the server booted fully or in degraded mode.

router.get(["/health", "/healthz"], (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    boot: getBootState(),
    mode: "full",
  });
});

export default router;
