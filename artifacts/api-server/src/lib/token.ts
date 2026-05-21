/**
 * Lightweight signed token — IB AI Assistant auth system.
 *
 * No external JWT library. Uses Node.js built-in crypto:
 *   - HMAC-SHA256 with JWT_SECRET env var
 *   - Format: base64url(JSON payload) + "." + base64url(HMAC signature)
 *   - 30-day expiry
 *
 * recoverySession flag:
 *   true  = issued via CEO recovery key — ONLY allows POST /api/auth/change-password
 *   false = normal authenticated session — full access
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { UserRole } from "./userStore";

const SECRET =
  process.env["JWT_SECRET"] ?? "ib-ai-dev-secret-change-in-production";
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Token payload ─────────────────────────────────────────────────────────────

export interface TokenPayload {
  userId:          string;
  username:        string;
  role:            UserRole;
  recoverySession: boolean;  // true = restricted to password change only
  sessionId?:      string;   // present in tokens issued after sessionStore was added
  iat:             number;   // issued at (Unix ms)
  exp:             number;   // expires at (Unix ms)
}

// ── Sign ──────────────────────────────────────────────────────────────────────

export function signToken(
  payload: Omit<TokenPayload, "iat" | "exp">,
): string {
  const now = Date.now();
  const full: TokenPayload = { ...payload, iat: now, exp: now + EXPIRY_MS };
  const data = Buffer.from(JSON.stringify(full)).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

// ── Verify ────────────────────────────────────────────────────────────────────

export function verifyToken(token: string): TokenPayload {
  const dot = token.lastIndexOf(".");
  if (dot === -1) throw new Error("Malformed token");

  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac("sha256", SECRET).update(data).digest("base64url");

  const sigBuf = Buffer.from(sig, "base64url");
  const expBuf = Buffer.from(expected, "base64url");

  if (
    sigBuf.length !== expBuf.length ||
    !timingSafeEqual(sigBuf, expBuf)
  ) {
    throw new Error("Invalid token signature");
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString());
  } catch {
    throw new Error("Malformed token payload");
  }

  if (payload.exp < Date.now()) {
    throw new Error("Token expired");
  }

  return payload;
}
