/**
 * Credit guard middleware — IB AI Assistant freemium system.
 *
 * Architecture rules:
 *   - requireAuth MUST run before creditGuard. This middleware reads req.user.
 *   - CEO role bypasses ALL credit checks (no limits, no deductions).
 *   - NEVER deduct credits here. Deduction happens AFTER a successful response
 *     via deductRequestCredits(), so failed requests are never charged.
 *   - Returns 402 with structured payload when credits are exhausted so the
 *     frontend can show the upgrade prompt without interrupting active streams.
 */
import { type Request, type Response, type NextFunction } from "express";
import {
  getUserById,
  getUserByIdFromDb,
  hasCredits,
  deductCredits,
  toPublicUser,
  FREE_CREDITS,
} from "../lib/userStore";

// ── Request type augmentation ─────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      creditContext?: {
        userId: string;
        cost: number;
      };
    }
  }
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * creditGuard(cost) — Express middleware that checks and reserves credits.
 *
 * Requires requireAuth to have run first (reads req.user).
 *
 * Usage:
 *   router.post('/route', requireAuth, creditGuard(CREDIT_COSTS.chat), handler)
 *
 * After a successful response, the handler must call:
 *   deductRequestCredits(req)
 */
export function creditGuard(cost: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (cost === 0) {
      next();
      return;
    }

    // requireAuth must precede this middleware
    if (!req.user) {
      res.status(401).json({
        error: "Authentication required",
        code: "UNAUTHENTICATED",
      });
      return;
    }

    // CEO bypasses all credit checks — no limits, no deductions
    if (req.user.role === "ceo") {
      req.creditContext = { userId: req.user.userId, cost: 0 };
      next();
      return;
    }

    // Re-hydrate from PostgreSQL — credit/role state must reflect live DB value.
    const user = await getUserByIdFromDb(req.user.userId);
    if (!user) {
      res.status(401).json({ error: "User not found", code: "USER_NOT_FOUND" });
      return;
    }

    if (!hasCredits(user, cost)) {
      res.status(402).json({
        error: "Insufficient credits",
        code: "CREDITS_EXHAUSTED",
        remaining: user.credits,
        limit: FREE_CREDITS,
        cost,
        plan: user.role,
      });
      return;
    }

    req.creditContext = { userId: req.user.userId, cost };
    next();
  };
}

/**
 * Deduct credits for this request.
 * MUST be called only after a successful generation — never on error paths.
 * No-ops if creditContext is absent or cost is 0 (CEO / unauthenticated).
 */
export function deductRequestCredits(req: Request): void {
  const ctx = req.creditContext;
  if (!ctx || ctx.cost === 0) return;
  deductCredits(ctx.userId, ctx.cost);
}

/**
 * Append credit headers to a successful response so the frontend
 * can sync credit display without a separate polling call.
 */
export async function appendCreditHeaders(req: Request, res: Response): Promise<void> {
  if (!req.user) return;
  try {
    // Re-hydrate from PostgreSQL so credit headers reflect live DB state.
    const user = await getUserByIdFromDb(req.user.userId);
    if (!user) return;
    const pub = toPublicUser(user);
    if (pub.role !== "ceo") {
      res.setHeader("X-Credits-Remaining", String(pub.credits));
      res.setHeader("X-Credits-Limit", String(FREE_CREDITS));
    }
    res.setHeader("X-Credits-Plan", pub.role);
  } catch {
    // Non-critical — header failure never blocks the response
  }
}
