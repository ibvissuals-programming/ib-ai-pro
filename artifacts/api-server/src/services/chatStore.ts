/**
 * chatStore — PostgreSQL persistence layer for chat sessions and messages.
 *
 * Provides:
 *   getOrCreateSession()   — resolve or create a session row
 *   saveMessagePair()      — persist user + assistant message atomically
 *   getUserSessions()      — list a user's sessions (most recent first)
 *   getSessionMessages()   — get all messages in a session (own only)
 *   deleteSession()        — remove a session + its messages
 *   getAllSessions()        — CEO: all sessions with username join
 *
 * Safety rules:
 *   - Never log message content.
 *   - Callers must verify ownership before passing sessionId.
 *   - Binary content (base64 image edits) must be passed as null.
 */
import { eq, desc, and, count } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, chatSessionsTable, chatMessagesTable, usersTable } from "@workspace/db";
import { logger } from "../lib/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionSummaryWithUser extends SessionSummary {
  userId: string;
  username: string;
}

export interface PersistedMessage {
  id: string;
  role: string;
  content: string | null;
  type: string | null;
  providerUsed: string | null;
  fallbackUsed: boolean;
  latencyMs: number | null;
  timestamp: number;
}

// ── Session management ────────────────────────────────────────────────────────

/**
 * Returns an existing session ID if valid for this user, otherwise creates
 * a new session and returns its ID.
 */
export async function getOrCreateSession(opts: {
  sessionId: string | undefined;
  userId: string;
  title: string;
}): Promise<string> {
  if (opts.sessionId) {
    const [existing] = await db
      .select({ id: chatSessionsTable.id })
      .from(chatSessionsTable)
      .where(
        and(
          eq(chatSessionsTable.id, opts.sessionId),
          eq(chatSessionsTable.userId, opts.userId),
        ),
      )
      .limit(1);

    if (existing) return existing.id;
    // Session not found or belongs to another user — fall through to create
  }

  const id = randomUUID();
  const now = Date.now();
  await db.insert(chatSessionsTable).values({
    id,
    userId: opts.userId,
    title: opts.title.slice(0, 120) || "New Chat",
    createdAt: now,
    updatedAt: now,
  });

  logger.debug({ sessionId: id, userId: opts.userId }, "[chatStore] session created");
  return id;
}

// ── Message persistence ────────────────────────────────────────────────────────

/**
 * Saves a user+assistant message pair and updates the session's updatedAt.
 * Content sanitisation rules:
 *   - Never pass base64 image data as content — callers must pass null.
 *   - User message content is truncated to 8000 chars before saving.
 */
export async function saveMessagePair(opts: {
  sessionId: string;
  userId: string;
  userContent: string;
  assistantContent: string | null;
  providerUsed: string | null;
  fallbackUsed: boolean;
  latencyMs: number | null;
}): Promise<void> {
  const now = Date.now();

  await db.insert(chatMessagesTable).values([
    {
      id:           randomUUID(),
      sessionId:    opts.sessionId,
      userId:       opts.userId,
      role:         "user",
      content:      opts.userContent.slice(0, 8_000),
      type:         "text",
      providerUsed: null,
      fallbackUsed: false,
      latencyMs:    null,
      timestamp:    now,
    },
    {
      id:           randomUUID(),
      sessionId:    opts.sessionId,
      userId:       opts.userId,
      role:         "assistant",
      content:      opts.assistantContent,
      type:         "text",
      providerUsed: opts.providerUsed,
      fallbackUsed: opts.fallbackUsed,
      latencyMs:    opts.latencyMs,
      timestamp:    now + 1,
    },
  ]);

  await db
    .update(chatSessionsTable)
    .set({ updatedAt: now })
    .where(eq(chatSessionsTable.id, opts.sessionId));

  logger.debug({ sessionId: opts.sessionId }, "[chatStore] message pair saved");
}

// ── Query helpers ──────────────────────────────────────────────────────────────

/**
 * Returns a user's sessions, most recent first, with message counts.
 */
export async function getUserSessions(
  userId: string,
  limit = 50,
): Promise<SessionSummary[]> {
  const rows = await db
    .select({
      id:           chatSessionsTable.id,
      title:        chatSessionsTable.title,
      createdAt:    chatSessionsTable.createdAt,
      updatedAt:    chatSessionsTable.updatedAt,
      messageCount: count(chatMessagesTable.id),
    })
    .from(chatSessionsTable)
    .leftJoin(
      chatMessagesTable,
      eq(chatMessagesTable.sessionId, chatSessionsTable.id),
    )
    .where(eq(chatSessionsTable.userId, userId))
    .groupBy(chatSessionsTable.id)
    .orderBy(desc(chatSessionsTable.updatedAt))
    .limit(Math.min(limit, 100));

  return rows.map((r) => ({
    id:           r.id,
    title:        r.title,
    createdAt:    r.createdAt,
    updatedAt:    r.updatedAt,
    messageCount: r.messageCount,
  }));
}

/**
 * Returns all messages in a session. Verifies userId ownership unless
 * isCeo is true (CEO can read any session).
 */
export async function getSessionMessages(
  sessionId: string,
  userId: string,
  isCeo = false,
): Promise<PersistedMessage[]> {
  // Ownership check
  if (!isCeo) {
    const [session] = await db
      .select({ id: chatSessionsTable.id })
      .from(chatSessionsTable)
      .where(
        and(
          eq(chatSessionsTable.id, sessionId),
          eq(chatSessionsTable.userId, userId),
        ),
      )
      .limit(1);

    if (!session) return [];
  }

  const rows = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.sessionId, sessionId))
    .orderBy(chatMessagesTable.timestamp)
    .limit(500);

  return rows.map((r) => ({
    id:           r.id,
    role:         r.role,
    content:      r.content,
    type:         r.type,
    providerUsed: r.providerUsed,
    fallbackUsed: r.fallbackUsed,
    latencyMs:    r.latencyMs,
    timestamp:    r.timestamp,
  }));
}

/**
 * Deletes a session and all its messages. Returns true if deleted, false
 * if not found / not owned by this user.
 */
export async function deleteSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const [session] = await db
    .select({ id: chatSessionsTable.id })
    .from(chatSessionsTable)
    .where(
      and(
        eq(chatSessionsTable.id, sessionId),
        eq(chatSessionsTable.userId, userId),
      ),
    )
    .limit(1);

  if (!session) return false;

  await db
    .delete(chatMessagesTable)
    .where(eq(chatMessagesTable.sessionId, sessionId));

  await db
    .delete(chatSessionsTable)
    .where(eq(chatSessionsTable.id, sessionId));

  logger.debug({ sessionId, userId }, "[chatStore] session deleted");
  return true;
}

/**
 * CEO only: returns all sessions across all users, most recent first.
 * Joins with users table to include username.
 */
export async function getAllSessions(limit = 100): Promise<SessionSummaryWithUser[]> {
  const rows = await db
    .select({
      id:           chatSessionsTable.id,
      title:        chatSessionsTable.title,
      createdAt:    chatSessionsTable.createdAt,
      updatedAt:    chatSessionsTable.updatedAt,
      userId:       chatSessionsTable.userId,
      username:     usersTable.username,
      messageCount: count(chatMessagesTable.id),
    })
    .from(chatSessionsTable)
    .leftJoin(usersTable,         eq(usersTable.id,          chatSessionsTable.userId))
    .leftJoin(chatMessagesTable,  eq(chatMessagesTable.sessionId, chatSessionsTable.id))
    .groupBy(chatSessionsTable.id, usersTable.username)
    .orderBy(desc(chatSessionsTable.updatedAt))
    .limit(Math.min(limit, 200));

  return rows.map((r) => ({
    id:           r.id,
    title:        r.title,
    createdAt:    r.createdAt,
    updatedAt:    r.updatedAt,
    userId:       r.userId,
    username:     r.username ?? r.userId,
    messageCount: r.messageCount,
  }));
}
