/**
 * In-memory rate limiter — IB AI Assistant.
 *
 * Lightweight sliding-window counter with per-IP / per-route tracking.
 * No external dependencies. Safe for single-process deployments.
 *
 * Usage:
 *   router.post("/auth/login", rateLimit(15, 60_000, "login"), handler)
 *
 * Cleanup:
 *   Expired entries are purged every 5 minutes to prevent unbounded growth.
 */
import { type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

// Purge expired entries every 5 minutes — prevents memory growth over time.
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows.entries()) {
    if (now >= w.resetAt) windows.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * rateLimit(maxRequests, windowMs, routeKey)
 *
 * Returns Express middleware that enforces a fixed-window rate limit.
 *
 * @param maxRequests - max number of requests allowed per window
 * @param windowMs    - window duration in milliseconds
 * @param routeKey    - short identifier for the route (used in log + key)
 */
export function rateLimit(
  maxRequests: number,
  windowMs: number,
  routeKey: string,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // CEO role bypasses rate limits entirely (dev/admin testing)
    if ((req as Request & { user?: { role?: string } }).user?.role === "ceo") {
      next();
      return;
    }

    // Prefer X-Forwarded-For when behind a proxy (trust proxy set in app.ts)
    const raw = req.ip || req.socket?.remoteAddress || "unknown";
    const ip = raw.replace(/^::ffff:/, ""); // normalise IPv4-mapped IPv6

    const key = `${routeKey}:${ip}`;
    const now = Date.now();

    const w = windows.get(key);

    if (!w || now >= w.resetAt) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (w.count >= maxRequests) {
      const retryAfter = Math.ceil((w.resetAt - now) / 1000);
      logger.warn(
        { ip, route: routeKey, count: w.count, retryAfter },
        "[rateLimit] limit reached",
      );
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "Too many requests. Please try again later.",
        retryAfter,
      });
      return;
    }

    w.count++;
    next();
  };
}
