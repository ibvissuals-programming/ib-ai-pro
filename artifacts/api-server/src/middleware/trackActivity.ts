/**
 * trackActivity.ts — IB AI Assistant
 *
 * Router-level middleware that updates lastSeenAt for every request
 * that carries a valid Bearer token. Decodes the token independently
 * (like optionalAuth) so it can run at the top of the router before
 * individual route auth middleware fires.
 *
 * Never throws, never rejects — purely informational.
 */
import { type Request, type Response, type NextFunction } from "express";
import { updateLastSeen } from "../lib/activityTracker";
import { verifyToken } from "../lib/token";

function extractToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function trackActivity(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = extractToken(req);
  if (token) {
    try {
      const payload = verifyToken(token);
      updateLastSeen(payload.userId, payload.username, payload.role);
    } catch {
      // Invalid / expired token — auth middleware will handle rejection
    }
  }
  next();
}
