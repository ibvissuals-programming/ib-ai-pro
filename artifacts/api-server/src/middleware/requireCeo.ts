/**
 * requireCeo.ts — IB AI Assistant
 *
 * Middleware that enforces CEO-only access on admin endpoints.
 * Stacks on top of requireAuth — verifies both valid JWT and role === "ceo".
 *
 * Rejects with:
 *   401 — no token / invalid token
 *   401 — token valid but session has been revoked
 *   403 — valid token but role is not "ceo"
 */
import { type Request, type Response, type NextFunction } from "express";
import { verifyToken } from "../lib/token";
import { isSessionActive, touchSession } from "../lib/sessionStore";

function extractToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function requireCeo(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({ error: "Invalid or expired session", code: "TOKEN_INVALID" });
    return;
  }

  if (payload.sessionId) {
    if (!isSessionActive(payload.sessionId)) {
      res.status(401).json({
        error: "Session has been revoked — please log in again",
        code:  "SESSION_REVOKED",
      });
      return;
    }
    touchSession(payload.sessionId);
  }

  if (payload.role !== "ceo") {
    res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
    return;
  }

  req.user = payload;
  next();
}
