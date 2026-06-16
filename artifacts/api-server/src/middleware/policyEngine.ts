/**
 * AUTH POLICY ENGINE — IB AI Assistant single source of truth.
 *
 * One middleware call replaces the combination of:
 *   requireNormalAuth + rateLimit(n, ms, key) + creditGuard(cost)
 *
 * Decision order (strict):
 *   1. Token authentication
 *   2. Recovery-session guard (unless allowRecovery = true)
 *   3. Role evaluation — CEO bypasses steps 4 & 5 entirely
 *   4. Rate limit check
 *   5. Credit availability check
 *
 * CEO role bypasses ALL restrictions (rate limits, credits, quotas).
 * Credits are NEVER deducted here — call deductRequestCredits(req) after
 * a successful response.
 *
 * Usage:
 *   router.post(
 *     "/route",
 *     policyEngine({ cost: CREDIT_COSTS.chat, rateKey: "chat", rateMax: 30, rateWindowMs: 60_000 }),
 *     handler,
 *   )
 *
 * After success in the handler:
 *   deductRequestCredits(req);   // no-op for CEO
 *   appendCreditHeaders(req, res);
 */

import { type Request, type Response, type NextFunction } from "express";
import { verifyToken, type TokenPayload } from "../lib/token";
import {
  getUserById,
  getUserByIdFromDb,
  hasCredits,
  toPublicUser,
  FREE_CREDITS,
} from "../lib/userStore";
import { logger } from "../lib/logger";

// ── Re-export credit helpers so routes only need one import ───────────────────

export { deductRequestCredits, appendCreditHeaders } from "./creditGuard";

// ── Request augmentation (in addition to requireAuth declaration) ─────────────

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      creditContext?: { userId: string; cost: number };
      policyResult?: PolicyResult;
    }
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PolicyOptions {
  /** Credit cost for this operation (0 = free). */
  cost: number;
  /** Short key used for per-IP rate limit bucketing. */
  rateKey: string;
  /** Max requests per window for non-CEO users. */
  rateMax: number;
  /** Window duration in milliseconds. */
  rateWindowMs: number;
  /**
   * When true, recovery sessions (must-change-password) are allowed through.
   * Default: false — normal behaviour blocks them with 403.
   */
  allowRecovery?: boolean;
}

export interface PolicyResult {
  userId: string;
  username: string;
  role: string;
  isCeo: boolean;
  bypassCredits: boolean;
  bypassRateLimit: boolean;
  creditsBefore: number | null; // null for CEO
  cost: number;
}

// ── Sliding-window rate limit state ──────────────────────────────────────────

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows.entries()) {
    if (now >= w.resetAt) windows.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ── Token extraction helper ───────────────────────────────────────────────────

function extractToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}

// ── Policy engine middleware factory ─────────────────────────────────────────

/**
 * policyEngine(options) — single Express middleware that enforces:
 *   authentication → role → rate limit → credits
 *
 * Attaches req.user, req.creditContext, and req.policyResult.
 * Returns early with structured JSON errors on any violation.
 */
export function policyEngine(opts: PolicyOptions) {
  const { cost, rateKey, rateMax, rateWindowMs, allowRecovery = false } = opts;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const start = Date.now();

    // ── Step 1: Authentication ─────────────────────────────────────────────

    const token = extractToken(req);
    if (!token) {
      logger.warn({ route: rateKey }, "[policy] unauthenticated request");
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
      logger.warn({ route: rateKey }, "[policy] invalid token");
      res.status(401).json({
        error: "Invalid or expired session — please log in again",
        code: "TOKEN_INVALID",
      });
      return;
    }

    // ── Step 2: Recovery-session guard ────────────────────────────────────

    if (!allowRecovery && payload.recoverySession) {
      logger.warn(
        { userId: payload.userId, route: rateKey },
        "[policy] recovery session blocked",
      );
      res.status(403).json({
        error: "Password change required",
        code: "PASSWORD_CHANGE_REQUIRED",
      });
      return;
    }

    req.user = payload;

    // ── Step 3: Role evaluation ───────────────────────────────────────────

    const isCeo = payload.role === "ceo";

    // ── Step 4: Rate limit (CEO bypassed) ─────────────────────────────────

    if (!isCeo && rateMax > 0) {
      // Key by authenticated userId — each user gets their own independent bucket.
      // This prevents IP-sharing (NAT, corporate proxies) from causing users to
      // exhaust each other's quota, and ensures rate-limit state never leaks
      // between accounts even on the same machine.
      const key = `${rateKey}:${payload.userId}`;
      const now = Date.now();
      const w = windows.get(key);

      if (!w || now >= w.resetAt) {
        const newW = { count: 1, resetAt: now + rateWindowMs };
        windows.set(key, newW);
        res.setHeader("X-RateLimit-Limit",     String(rateMax));
        res.setHeader("X-RateLimit-Remaining", String(rateMax - 1));
        res.setHeader("X-RateLimit-Reset",     String(Math.ceil(newW.resetAt / 1000)));
      } else if (w.count >= rateMax) {
        const retryAfter = Math.ceil((w.resetAt - now) / 1000);
        logger.warn(
          { ip, route: rateKey, count: w.count, retryAfter },
          "[policy] rate limit reached",
        );
        res.setHeader("X-RateLimit-Limit",     String(rateMax));
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader("X-RateLimit-Reset",     String(Math.ceil(w.resetAt / 1000)));
        res.setHeader("Retry-After",           String(retryAfter));
        res.status(429).json({
          error: "Too many requests. Please try again later.",
          retryAfter,
        });
        return;
      } else {
        w.count++;
        res.setHeader("X-RateLimit-Limit",     String(rateMax));
        res.setHeader("X-RateLimit-Remaining", String(rateMax - w.count));
        res.setHeader("X-RateLimit-Reset",     String(Math.ceil(w.resetAt / 1000)));
      }
    }

    // ── Step 5: Credit check (CEO bypassed) ───────────────────────────────

    let creditsBefore: number | null = null;

    if (!isCeo && cost > 0) {
      // Re-hydrate from PostgreSQL — credit/role state must reflect live DB value.
      const user = await getUserByIdFromDb(payload.userId);
      if (!user) {
        logger.warn({ userId: payload.userId }, "[policy] user not found");
        res.status(401).json({ error: "User not found", code: "USER_NOT_FOUND" });
        return;
      }

      if (!hasCredits(user, cost)) {
        const pub = toPublicUser(user);
        logger.info(
          { userId: payload.userId, credits: pub.credits, cost, route: rateKey },
          "[policy] insufficient credits",
        );
        res.status(402).json({
          error: "Insufficient credits",
          code: "CREDITS_EXHAUSTED",
          remaining: pub.credits,
          limit: FREE_CREDITS,
          cost,
          plan: pub.role,
        });
        return;
      }

      creditsBefore = toPublicUser(user).credits;
    }

    // ── Attach context ────────────────────────────────────────────────────

    req.creditContext = {
      userId: payload.userId,
      cost: isCeo ? 0 : cost,
    };

    const result: PolicyResult = {
      userId: payload.userId,
      username: payload.username,
      role: payload.role,
      isCeo,
      bypassCredits: isCeo,
      bypassRateLimit: isCeo,
      creditsBefore,
      cost: isCeo ? 0 : cost,
    };

    req.policyResult = result;

    logger.debug(
      {
        userId: result.userId,
        username: result.username,
        role: result.role,
        isCeo,
        bypassCredits: result.bypassCredits,
        bypassRateLimit: result.bypassRateLimit,
        creditsBefore,
        cost: result.cost,
        route: rateKey,
        latencyMs: Date.now() - start,
      },
      "[policy] request allowed",
    );

    next();
  };
}
