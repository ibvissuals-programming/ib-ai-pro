/**
 * sessionStore.ts — In-memory session tracking (zero external dependencies).
 *
 * Sessions are created at login/register and stored in memory.
 * Each session carries a sessionId embedded in the JWT so requireAuth
 * can immediately detect revoked sessions without touching a DB.
 *
 * Sessions expire after SESSION_TTL_MS (mirrors the 30-day JWT expiry).
 * No persistence — sessions reset on restart; users simply re-login.
 *
 * Index: userId → Set<sessionId> for O(1) user-scoped operations.
 */
import { randomUUID } from "crypto";
import { logger } from "./logger";
import type { UserRole } from "./userStore";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Session {
  sessionId:    string;
  userId:       string;
  username:     string;
  role:         UserRole;
  createdAt:    number;
  lastActiveAt: number;
  ipAddress?:   string;
  userAgent?:   string;
  isActive:     boolean;
}

// Mirrors JWT 30-day expiry
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── In-memory store ────────────────────────────────────────────────────────────

const sessions          = new Map<string, Session>();
const userSessionIndex  = new Map<string, Set<string>>(); // userId → Set<sessionId>

// ── Session lifecycle ─────────────────────────────────────────────────────────

export function createSession(params: {
  userId:      string;
  username:    string;
  role:        UserRole;
  ipAddress?:  string;
  userAgent?:  string;
}): Session {
  const sessionId = randomUUID();
  const now       = Date.now();

  const session: Session = {
    sessionId,
    userId:       params.userId,
    username:     params.username,
    role:         params.role,
    createdAt:    now,
    lastActiveAt: now,
    ipAddress:    params.ipAddress,
    userAgent:    params.userAgent,
    isActive:     true,
  };

  sessions.set(sessionId, session);

  if (!userSessionIndex.has(params.userId)) {
    userSessionIndex.set(params.userId, new Set());
  }
  userSessionIndex.get(params.userId)!.add(sessionId);

  logger.debug(
    { sessionId, userId: params.userId, role: params.role },
    "[sessionStore] session created",
  );

  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/**
 * Returns true if the session exists, is active, and has not expired.
 * Idempotently marks expired sessions inactive on first check.
 */
export function isSessionActive(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session)           return false;
  if (!session.isActive)  return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    session.isActive = false;
    return false;
  }
  return true;
}

/**
 * Refresh the lastActiveAt timestamp for an active session.
 * Called by requireAuth on every authenticated request.
 */
export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session?.isActive) {
    session.lastActiveAt = Date.now();
  }
}

/**
 * Revoke a single session by ID. Returns false if not found.
 */
export function revokeSession(sessionId: string, revokedBy?: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.isActive = false;
  logger.info(
    { sessionId, userId: session.userId, revokedBy },
    "[sessionStore] session revoked",
  );
  return true;
}

/**
 * Revoke all active sessions for a specific user.
 * Returns the number of sessions revoked.
 */
export function revokeAllUserSessions(userId: string, revokedBy?: string): number {
  const ids = userSessionIndex.get(userId);
  if (!ids) return 0;
  let count = 0;
  for (const id of ids) {
    const s = sessions.get(id);
    if (s?.isActive) {
      s.isActive = false;
      count++;
    }
  }
  if (count > 0) {
    logger.info(
      { userId, count, revokedBy },
      "[sessionStore] all user sessions revoked",
    );
  }
  return count;
}

/**
 * Revoke ALL active sessions system-wide (CEO admin action).
 * Returns the number of sessions revoked.
 */
export function revokeAllSessions(revokedBy?: string): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.isActive) {
      s.isActive = false;
      count++;
    }
  }
  if (count > 0) {
    logger.warn({ count, revokedBy }, "[sessionStore] ALL sessions revoked system-wide");
  }
  return count;
}

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * Returns all sessions (active and inactive) for a specific user.
 */
export function getUserSessions(userId: string): Session[] {
  const ids = userSessionIndex.get(userId);
  if (!ids) return [];
  return Array.from(ids)
    .map((id) => sessions.get(id))
    .filter((s): s is Session => s !== undefined);
}

/**
 * Returns all sessions across all users. CEO admin view only.
 */
export function getAllSessions(): Session[] {
  return Array.from(sessions.values());
}

/**
 * Summary stats exposed by admin/health endpoints.
 */
export function getSessionStats(): { total: number; active: number; revoked: number } {
  let active = 0;
  let revoked = 0;
  for (const s of sessions.values()) {
    if (s.isActive) active++;
    else            revoked++;
  }
  return { total: sessions.size, active, revoked };
}
