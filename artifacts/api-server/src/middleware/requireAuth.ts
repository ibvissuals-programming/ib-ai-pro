/**
 * Auth middleware — IB AI Assistant.
 *
 * requireAuth:       strict — returns 401 if no valid token. Allows recovery sessions.
 * requireNormalAuth: strict — returns 401 if no valid token, 403 if recoverySession.
 *                    Use on all protected routes EXCEPT POST /api/auth/change-password.
 * optionalAuth:      soft — attaches req.user if token valid, passes through if not.
 *
 * Token is extracted from: Authorization: Bearer <token>
 */
import { type Request, type Response, type NextFunction } from "express";
import { verifyToken, type TokenPayload } from "../lib/token";
import { isSessionActive, touchSession }  from "../lib/sessionStore";

// ── Request type augmentation ─────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function extractToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}

// ── Strict middleware (allows recovery sessions) ──────────────────────────────

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      error: "Authentication required",
      code: "UNAUTHENTICATED",
    });
    return;
  }
  try {
    const payload = verifyToken(token);
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
    req.user = payload;
    next();
  } catch {
    res.status(401).json({
      error: "Invalid or expired session — please log in again",
      code: "TOKEN_INVALID",
    });
  }
}

// ── Normal-session-only middleware (blocks recovery sessions) ─────────────────
//
// Recovery sessions (recoverySession: true in JWT) are restricted to
// POST /api/auth/change-password only. All other protected routes must
// use this middleware to enforce password rotation before full access.

export function requireNormalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      error: "Authentication required",
      code: "UNAUTHENTICATED",
    });
    return;
  }
  let payload: TokenPayload;
  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({
      error: "Invalid or expired session — please log in again",
      code: "TOKEN_INVALID",
    });
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
  if (payload.recoverySession) {
    res.status(403).json({
      error: "Password change required",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    return;
  }
  req.user = payload;
  next();
}

// ── Soft middleware ───────────────────────────────────────────────────────────

export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = extractToken(req);
  if (token) {
    try {
      req.user = verifyToken(token);
    } catch {
      // Invalid token — treat as unauthenticated
    }
  }
  next();
}
