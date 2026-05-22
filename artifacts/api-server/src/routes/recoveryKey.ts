/**
 * recoveryKey.ts — CEO recovery key rotation.
 *
 * POST /api/ceo/rotate-recovery-key
 *   Requires CEO JWT auth (requireCeo middleware).
 *   Generates a new cryptographically-secure 64-hex-char key,
 *   activates it in-memory immediately for the current session,
 *   and returns it ONCE for the operator to persist in Replit Secrets.
 *
 * The key is NOT written to disk or database.
 * To make rotation permanent across restarts the operator must
 * update CEO_RECOVERY_KEY in Replit Secrets manually.
 *
 * Safe when CEO_RECOVERY_KEY is currently unset — server never crashes.
 */

import { Router } from "express";
import { randomBytes } from "crypto";
import { requireCeo } from "../middleware/requireCeo";

const router = Router();

// Non-persistent rotation counter — resets to 0 on server restart.
let rotationVersion = 0;

router.post("/ceo/rotate-recovery-key", requireCeo, (_req, res) => {
  const newKey = randomBytes(32).toString("hex"); // 64 hex chars

  rotationVersion += 1;

  // Activate in-memory immediately so the new key works for the current
  // server session without a restart.  Not persisted — operator must save
  // to Replit Secrets for the change to survive a restart.
  process.env["CEO_RECOVERY_KEY"] = newKey;

  res.json({
    success: true,
    key: newKey,
    version: rotationVersion,
    warning:
      "Save this key to Replit Secrets as CEO_RECOVERY_KEY immediately. " +
      "It will not be shown again and will be lost on server restart.",
    note: "In-memory activation is immediate. Replit Secrets update required for persistence.",
  });
});

export default router;
