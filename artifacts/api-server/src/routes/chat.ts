// ╔══════════════════════════════════════════════════════════════════╗
// ║  ROUTE IMMUTABILITY RULE — IB AI Assistant                     ║
// ║  /api/chat is the ONLY AI execution endpoint.                  ║
// ║  All AI requests MUST route through POST /api/chat.            ║
// ║  Direct or alternative AI execution paths are forbidden.       ║
// ║  Do NOT add: /api/generate, /api/ai, /api/message, or any      ║
// ║  route that calls createChatStream() or the Gemini client.     ║
// ╚══════════════════════════════════════════════════════════════════╝
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { createChatStream, getLastProviderResult, type ChatMessage } from "../services/llm";
import { SYSTEM_PROMPT } from "../prompts/system";
import { logger } from "../lib/logger";
import { policyEngine, deductRequestCredits } from "../middleware/policyEngine";
import { CREDIT_COSTS } from "../lib/userStore";
import { getOrCreateSession, saveMessagePair } from "../services/chatStore";
import { getUserMemoryMap, buildMemoryBlock } from "../services/memoryStore";

const router = Router();

// ─── Adaptive context window ──────────────────────────────────────────────────

type ConversationMode = "coding" | "reasoning" | "chat";

const CONTEXT_LIMITS: Record<ConversationMode, number> = {
  coding: 12,
  reasoning: 10,
  chat: 7,
};

const MAX_CONTENT_LENGTH = 8000;

const CODING_SIGNALS = [
  "code", "debug", "error", "fix", "stack", "function", "variable",
  "class", "import", "syntax", "compile", "runtime", "exception",
  "traceback", "bug", "refactor", "script", "test", "snippet",
  "throws", "undefined", "null",
];

const REASONING_SIGNALS = [
  "explain", "how", "why", "step", "analyze", "understand", "reason",
  "compare", "difference", "describe", "what is", "break down",
  "walk me", "elaborate",
];

/**
 * Detects conversation mode from the last 3 user messages.
 * Requires at least 2 matching signals to qualify as a specialised mode.
 * Falls back to "chat" when signals are ambiguous or absent.
 */
function detectMode(messages: Array<{ role: string; content: string }>): ConversationMode {
  const recentText = messages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content.toLowerCase())
    .join(" ");

  const codingScore = CODING_SIGNALS.filter((s) => recentText.includes(s)).length;
  const reasoningScore = REASONING_SIGNALS.filter((s) => recentText.includes(s)).length;

  if (codingScore >= 2 && codingScore > reasoningScore) return "coding";
  if (reasoningScore >= 2) return "reasoning";
  return "chat";
}

// ─── Date injection (Africa/Lagos, WAT = UTC+1) ───────────────────────────────

const WAT_OFFSET_MS = 60 * 60 * 1000; // UTC+1

function buildDatedSystemPrompt(memoryBlock?: string | null): string {
  const d = new Date(Date.now() + WAT_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");

  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const dayName = DAYS[d.getUTCDay()];
  const month = MONTHS[d.getUTCMonth()];
  const date = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hours = pad(d.getUTCHours());
  const mins = pad(d.getUTCMinutes());

  const dateStr = `${dayName}, ${month} ${date}, ${year}`;
  const timeStr = `${hours}:${mins} WAT (West Africa Time)`;

  let prompt = `${SYSTEM_PROMPT}\n\n## Current Date & Time\n${dateStr} — ${timeStr}`;
  if (memoryBlock) {
    prompt += `\n\n${memoryBlock}`;
  }
  return prompt;
}

// ─── Validation schema ────────────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
});

const ChatRequestSchema = z.object({
  messages:  z.array(MessageSchema).min(1).max(50),
  sessionId: z.string().uuid().optional(),   // existing session to append to
});

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ─── Context builder ──────────────────────────────────────────────────────────

type RawMessage = { role: "user" | "assistant"; content: string };

function buildContext(raw: RawMessage[], memoryBlock?: string | null): ChatMessage[] {
  const safeRaw = Array.isArray(raw) ? raw : [];

  const cleaned = safeRaw
    .map((m) => ({
      ...m,
      content: (typeof m.content === "string" ? m.content : "")
        .trim()
        .slice(0, MAX_CONTENT_LENGTH),
    }))
    .filter((m) => m.content.length > 0)
    .filter((m, i, arr) => {
      if (i === 0) return true;
      const prev = arr[i - 1]!;
      return !(prev.role === m.role && prev.content === m.content);
    });

  const mode = detectMode(cleaned);
  const window = CONTEXT_LIMITS[mode];

  logger.debug({ mode, window, total: cleaned.length, hasMemory: !!memoryBlock }, "context built");

  return [
    { role: "system", content: buildDatedSystemPrompt(memoryBlock) },
    ...cleaned.slice(-window),
  ];
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post(
  "/chat",
  policyEngine({
    cost: CREDIT_COSTS.chat,
    rateKey: "chat",
    rateMax: 30,
    rateWindowMs: 60_000,
    allowRecovery: true,
  }),
  async (req: Request, res: Response) => {
    const parsed = ChatRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { messages: rawMessages, sessionId: incomingSessionId } = parsed.data;

    logger.info(
      { userId: req.user?.userId, messageCount: rawMessages.length },
      "[chat] request received",
    );

    // Capture the last user message for session title + persistence.
    // Uses raw input — not the context-windowed version.
    const lastUserContent =
      [...rawMessages].reverse().find((m) => m.role === "user")?.content ?? "";
    const sessionTitle = lastUserContent.slice(0, 60) || "New Chat";

    // Load user memory for context injection — fire-and-forget safe fallback.
    // Memory is secondary context only; conversation history remains primary.
    let memoryBlock: string | null = null;
    if (req.user?.userId) {
      try {
        const memMap = await getUserMemoryMap(req.user.userId);
        const memCount = Object.keys(memMap).length;
        memoryBlock = buildMemoryBlock(memMap);
        if (memCount > 0) {
          logger.debug({ userId: req.user.userId, memCount }, "[chat] memory injected");
        }
      } catch (memErr) {
        logger.warn({ err: memErr }, "[chat] memory load failed — continuing without it");
      }
    }

    const messages = buildContext(rawMessages, memoryBlock);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    let streamSucceeded = false;
    let accumContent = "";
    let resolvedSessionId: string | undefined;

    try {
      const stream = await createChatStream(messages);

      for await (const chunk of stream) {
        accumContent += chunk;
        res.write(sseEvent({ content: chunk }));
      }

      // Resolve (or create) the session and send the ID to the client
      // before [DONE] so it can be stored immediately.
      if (req.user?.userId) {
        try {
          resolvedSessionId = await getOrCreateSession({
            sessionId: incomingSessionId,
            userId: req.user.userId,
            title: sessionTitle,
          });
          res.write(sseEvent({ sessionId: resolvedSessionId }));
        } catch (sessionErr) {
          logger.error({ err: sessionErr }, "[chat] session resolution failed — skipping");
        }
      }

      res.write("data: [DONE]\n\n");
      streamSucceeded = true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg }, "LLM stream error");

      res.write(
        sseEvent({
          error: true,
          code: errMsg,
        })
      );
    } finally {
      if (streamSucceeded) {
        deductRequestCredits(req);

        // Fire-and-forget persistence — never blocks the stream response.
        // Only runs when session was successfully resolved and there is content.
        if (resolvedSessionId && req.user?.userId && lastUserContent) {
          const providerResult = getLastProviderResult();
          const userId = req.user.userId;
          const sid = resolvedSessionId;

          saveMessagePair({
            sessionId:        sid,
            userId,
            userContent:      lastUserContent,
            assistantContent: accumContent || null,
            providerUsed:     providerResult?.provider ?? null,
            fallbackUsed:     providerResult?.fallbackUsed ?? false,
            latencyMs:        providerResult?.latencyMs ?? null,
          }).catch((e: unknown) => logger.error({ err: e }, "[chat] message persist failed"));
        }
      }
      res.end();
    }
  },
);

export default router;
