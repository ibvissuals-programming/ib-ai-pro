import { Router, type IRouter } from "express";
import { getBootState } from "../lib/bootState";
import { isPostgresEnabled } from "../lib/systemConfig";
import { checkObjectStorageHealth, isObjectStorageEnabled } from "../services/objectStore";

const router: IRouter = Router();

// ── LAYER 6: Health check — always returns, never throws ─────────────────────
// Returns uptime, boot state, and storage connectivity so monitoring tools can
// detect whether the server is healthy or in degraded mode.
//
// GET /health   — standard health endpoint
// GET /healthz  — alias (Kubernetes-style)

router.get(["/health", "/healthz"], async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let degraded = false;

  // ── PostgreSQL check ─────────────────────────────────────────────────────
  if (isPostgresEnabled()) {
    try {
      const { pool } = await import("@workspace/db");
      await pool.query("SELECT 1");
      checks["postgres"] = { ok: true };
    } catch (err) {
      checks["postgres"] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      degraded = true;
    }
  }

  // ── Object Storage check ─────────────────────────────────────────────────
  if (isObjectStorageEnabled()) {
    try {
      const result = await checkObjectStorageHealth();
      checks["objectStorage"] = result;
      if (!result.ok) degraded = true;
    } catch (err) {
      checks["objectStorage"] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      degraded = true;
    }
  }

  res.json({
    status: degraded ? "degraded" : "ok",
    uptime: Math.floor(process.uptime()),
    boot: getBootState(),
    mode: "full",
    checks,
  });
});

export default router;
