/**
 * Chat History routes — IB AI Assistant
 *
 * User endpoints (any authenticated user — own data only):
 *   GET    /api/chat/sessions              — list user's sessions
 *   GET    /api/chat/sessions/:id/messages — get messages in a session
 *   DELETE /api/chat/sessions/:id          — delete a session
 *
 * CEO endpoint (requireCeo):
 *   GET    /api/admin/chat-sessions        — all sessions across all users
 *   GET    /api/admin/chat-sessions/:id/messages — any session's messages
 */
import { Router, type Request, type Response } from "express";
import { requireCeo } from "../middleware/requireCeo";
import { policyEngine } from "../middleware/policyEngine";
import { logger } from "../lib/logger";
import {
  getUserSessions,
  getSessionMessages,
  deleteSession,
  getAllSessions,
} from "../services/chatStore";

const router = Router();

// ── Rate-limit config for history reads ───────────────────────────────────────

const historyPolicy = policyEngine({
  cost: 0,
  rateKey: "chat_history",
  rateMax: 60,
  rateWindowMs: 60_000,
  allowRecovery: true,
});

// ── GET /api/chat/sessions ─────────────────────────────────────────────────────

router.get(
  "/chat/sessions",
  historyPolicy,
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const limitRaw = req.query["limit"] as string | undefined;
    const limit = limitRaw ? Math.min(Number(limitRaw) || 50, 100) : 50;

    try {
      const sessions = await getUserSessions(userId, limit);
      res.json(sessions);
    } catch (err) {
      logger.error({ err }, "[chatHistory] failed to list sessions");
      res.status(500).json({ error: "Failed to load sessions" });
    }
  },
);

// ── GET /api/chat/sessions/:id/messages ───────────────────────────────────────

router.get(
  "/chat/sessions/:id/messages",
  historyPolicy,
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const sessionId = req.params["id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing session ID" });
      return;
    }

    try {
      const messages = await getSessionMessages(sessionId, userId, false);
      res.json(messages);
    } catch (err) {
      logger.error({ err, sessionId }, "[chatHistory] failed to get messages");
      res.status(500).json({ error: "Failed to load messages" });
    }
  },
);

// ── DELETE /api/chat/sessions/:id ─────────────────────────────────────────────

router.delete(
  "/chat/sessions/:id",
  historyPolicy,
  async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const sessionId = req.params["id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing session ID" });
      return;
    }

    try {
      const deleted = await deleteSession(sessionId, userId);
      if (!deleted) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, sessionId }, "[chatHistory] failed to delete session");
      res.status(500).json({ error: "Failed to delete session" });
    }
  },
);

// ── GET /api/admin/chat-sessions ──────────────────────────────────────────────

router.get(
  "/admin/chat-sessions",
  requireCeo,
  async (req: Request, res: Response) => {
    const limitRaw = req.query["limit"] as string | undefined;
    const limit = limitRaw ? Math.min(Number(limitRaw) || 100, 200) : 100;

    try {
      const sessions = await getAllSessions(limit);
      res.json(sessions);
    } catch (err) {
      logger.error({ err }, "[chatHistory] CEO: failed to list all sessions");
      res.status(500).json({ error: "Failed to load sessions" });
    }
  },
);

// ── GET /api/admin/chat-sessions/:id/messages ─────────────────────────────────

router.get(
  "/admin/chat-sessions/:id/messages",
  requireCeo,
  async (req: Request, res: Response) => {
    const userId = req.user?.userId ?? "";
    const sessionId = req.params["id"] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: "Missing session ID" });
      return;
    }

    try {
      const messages = await getSessionMessages(sessionId, userId, true);
      res.json(messages);
    } catch (err) {
      logger.error({ err, sessionId }, "[chatHistory] CEO: failed to get messages");
      res.status(500).json({ error: "Failed to load messages" });
    }
  },
);

export default router;
