/**
 * Credit guard middleware — IB AI Pro freemium system.
 *
 * Architecture rules:
 *   - NEVER deduct credits here. Deduction happens AFTER a successful response
 *     via deductRequestCredits(), so failed requests are never charged.
 *   - Requests with no x-username header pass through (guest/unauthenticated).
 *   - Returns 402 with structured payload when credits are exhausted so the
 *     frontend can show the upgrade modal without interrupting active streams.
 *   - This middleware is completely isolated from the SSE streaming pipeline.
 *     It only runs on non-streaming endpoints (/api/analyze-image).
 */
import { type Request, type Response, type NextFunction } from "express";
import {
  getUserRecord,
  hasSufficientCredits,
  deductCredits,
  getCreditStatus,
  PLAN_DAILY_CREDITS,
} from "../lib/credits";

// ── Request type augmentation ─────────────────────────────────────────────────
// Carries credit context from the guard to the route handler so the handler
// can call deductRequestCredits() after a successful response.

declare global {
  namespace Express {
    interface Request {
      creditContext?: {
        username: string;
        cost: number;
      };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractUsername(req: Request): string | null {
  const raw = req.headers["x-username"];
  if (!raw || typeof raw !== "string") return null;
  const clean = raw.trim().toLowerCase();
  return clean.length > 0 && clean.length <= 60 ? clean : null;
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * creditGuard(cost) — returns an Express middleware that checks and reserves
 * credits for the request.
 *
 * Usage:
 *   router.post('/analyze-image', creditGuard(CREDIT_COSTS.image_analysis), handler)
 *
 * After a successful response, the handler must call:
 *   deductRequestCredits(req)
 */
export function creditGuard(cost: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Free operations bypass the guard entirely
    if (cost === 0) {
      next();
      return;
    }

    const username = extractUsername(req);

    // No username → allow through (unauthenticated guest, no credit tracking)
    if (!username) {
      next();
      return;
    }

    const record = getUserRecord(username);
    const limit = PLAN_DAILY_CREDITS[record.plan];
    const isUnlimited = limit === Infinity;
    const remaining = isUnlimited ? null : Math.max(0, limit - record.dailyCreditsUsed);

    if (!hasSufficientCredits(username, cost)) {
      res.status(402).json({
        error: "Insufficient credits",
        code: "CREDITS_EXHAUSTED",
        remaining: remaining ?? 0,
        limit: isUnlimited ? null : limit,
        plan: record.plan,
        cost,
      });
      return;
    }

    // Attach context — route handler calls deductRequestCredits() on success
    req.creditContext = { username, cost };
    next();
  };
}

/**
 * Deduct credits from the request's credit context.
 *
 * MUST be called only after a successful generation — never on error paths.
 * No-ops if creditContext is absent (unauthenticated requests).
 */
export function deductRequestCredits(req: Request): void {
  const ctx = req.creditContext;
  if (!ctx) return;
  deductCredits(ctx.username, ctx.cost);
}

/**
 * Append credit headers to a successful response for the frontend to consume.
 * Keeps the frontend credit display in sync without a separate polling call.
 */
export function appendCreditHeaders(req: Request, res: Response): void {
  const username = extractUsername(req);
  if (!username) return;
  try {
    const status = getCreditStatus(username);
    if (status.creditsRemaining !== null) {
      res.setHeader("X-Credits-Remaining", String(status.creditsRemaining));
      res.setHeader("X-Credits-Limit", String(status.dailyLimit));
    }
    res.setHeader("X-Credits-Plan", status.plan);
  } catch {
    // Non-critical — do not disrupt the response
  }
}
