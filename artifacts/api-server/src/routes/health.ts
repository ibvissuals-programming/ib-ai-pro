import { Router, type IRouter } from "express";

const router: IRouter = Router();

// ── LAYER 6: Health check — always returns, never throws ─────────────────────
// Returns uptime and mode so Replit and monitoring tools can detect boot state.

router.get(["/health", "/healthz"], (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    mode: "full",
  });
});

export default router;
