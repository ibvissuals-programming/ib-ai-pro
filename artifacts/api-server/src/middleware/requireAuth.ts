/**
 * Auth middleware — IB AI Assistant.
 *
 * requireAuth: strict — returns 401 if no valid token.
 * optionalAuth: soft — attaches req.user if token valid, passes through if not.
 *
 * Token is extracted from: Authorization: Bearer <token>
 */
import { type Request, type Response, type NextFunction } from "express";
import { verifyToken, type TokenPayload } from "../lib/token";

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

// ── Strict middleware ─────────────────────────────────────────────────────────

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
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({
      error: "Invalid or expired session — please log in again",
      code: "TOKEN_INVALID",
    });
  }
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
