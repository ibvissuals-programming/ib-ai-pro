/**
 * creatorSessionStore.ts — Creator Workflow Session Store
 *
 * In-memory per-user session persistence. Supports save/rename/duplicate/load/delete
 * with per-user caps and automatic pruning of oldest non-pinned sessions.
 *
 * No DB migration required — pure in-memory with restart-resilient architecture.
 * Sessions survive within the process lifetime; reconnects start fresh (acceptable
 * for a lightweight workflow bookmark system).
 */
import crypto from "crypto";
import { logger } from "./logger";

const MAX_SESSIONS_PER_USER = 20;

export type WorkflowTool     = "image" | "voice" | "video" | "chat";
export type WorkflowCategory = "Creator" | "Business" | "Luxury" | "Social" | "Voiceover" | "Product Ads";

export interface SessionConfig {
  tool:        WorkflowTool;
  prompt?:     string;
  editMode?:   string;
  intensity?:  string;
  voiceStyle?: string;
  videoMode?:  string;
  presetId?:   string;
  notes?:      string;
}

export interface CreatorSession {
  id:        string;
  userId:    string;
  name:      string;
  category:  WorkflowCategory;
  pinned:    boolean;
  createdAt: number;
  updatedAt: number;
  config:    SessionConfig;
}

// Map<userId, Map<sessionId, CreatorSession>>
const store = new Map<string, Map<string, CreatorSession>>();

function getUserStore(userId: string): Map<string, CreatorSession> {
  if (!store.has(userId)) store.set(userId, new Map());
  return store.get(userId)!;
}

export function listSessions(userId: string): CreatorSession[] {
  return Array.from(getUserStore(userId).values()).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

export function getSession(userId: string, sessionId: string): CreatorSession | null {
  return getUserStore(userId).get(sessionId) ?? null;
}

export function createSession(
  userId: string,
  input: { name: string; category: WorkflowCategory; config: SessionConfig },
): CreatorSession {
  const us = getUserStore(userId);

  if (us.size >= MAX_SESSIONS_PER_USER) {
    const oldest = Array.from(us.values())
      .filter(s => !s.pinned)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) us.delete(oldest.id);
  }

  const session: CreatorSession = {
    id:        crypto.randomUUID(),
    userId,
    name:      input.name.slice(0, 80),
    category:  input.category,
    pinned:    false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config:    input.config,
  };

  us.set(session.id, session);
  logger.debug({ userId, sessionId: session.id }, "[creatorSessions] created");
  return session;
}

export function updateSession(
  userId: string,
  sessionId: string,
  updates: {
    name?:     string;
    category?: WorkflowCategory;
    pinned?:   boolean;
    config?:   Partial<SessionConfig>;
  },
): CreatorSession | null {
  const us = getUserStore(userId);
  const existing = us.get(sessionId);
  if (!existing) return null;

  const updated: CreatorSession = {
    ...existing,
    name:      updates.name     !== undefined ? updates.name.slice(0, 80) : existing.name,
    category:  updates.category ?? existing.category,
    pinned:    updates.pinned   ?? existing.pinned,
    config:    updates.config   ? { ...existing.config, ...updates.config } : existing.config,
    updatedAt: Date.now(),
  };
  us.set(sessionId, updated);
  return updated;
}

export function duplicateSession(userId: string, sessionId: string): CreatorSession | null {
  const existing = getSession(userId, sessionId);
  if (!existing) return null;
  return createSession(userId, {
    name:     `${existing.name} (copy)`,
    category: existing.category,
    config:   { ...existing.config },
  });
}

export function deleteSession(userId: string, sessionId: string): boolean {
  return getUserStore(userId).delete(sessionId);
}

export function getSessionCount(userId: string): number {
  return getUserStore(userId).size;
}

export function getGlobalSessionStats(): { totalUsers: number; totalSessions: number } {
  let totalSessions = 0;
  for (const us of store.values()) totalSessions += us.size;
  return { totalUsers: store.size, totalSessions };
}
