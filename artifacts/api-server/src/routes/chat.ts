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
import { createChatStream, type LastProviderResult, type ChatMessage } from "../services/llm";
import { SYSTEM_PROMPT } from "../prompts/system";
import { logger } from "../lib/logger";
import { policyEngine, deductRequestCredits } from "../middleware/policyEngine";
import { CREDIT_COSTS } from "../lib/userStore";
import { isGeminiConfigured } from "../lib/geminiEnv";
import { isSafeMode } from "../lib/safeMode";
import { getOrCreateSession, saveMessagePair } from "../services/chatStore";
import { getUserMemory, buildMemoryBlock } from "../services/memoryStore";
import { retrieveRelevantMemories } from "../services/memoryRetriever";
import { extractAndStoreMemory } from "../services/memoryExtractor";
import { pushEvent } from "../lib/eventTracker";
import { incChatRequest, incChatMessage } from "../lib/statsCounter";
import { normalizeAIError } from "../lib/aiOrchestrator";

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
    rateMax: 60,        // 60 per 30 s window = 2/s average; handles 50-message bursts cleanly
    rateWindowMs: 30_000,
    allowRecovery: true,
  }),
  async (req: Request, res: Response) => {
    const parsed = ChatRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        mode: "chat",
        error: "Invalid request",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { messages: rawMessages, sessionId: incomingSessionId } = parsed.data;

    // ── Provider pre-check — fail fast before any work begins ─────────────────
    // policyEngine handles auth/rate/credits but not provider availability.
    // Chat bypasses canCreateJob() (image/tts/video only), so we check here.
    if (isSafeMode() || !isGeminiConfigured()) {
      res.status(503).json({
        success: false,
        mode:    "chat",
        error:   "AI provider not configured. GEMINI_API_KEY is required.",
        code:    "provider_not_configured",
      });
      return;
    }

    // ── Phase 4: Request timing ────────────────────────────────────────────────
    const tStart  = Date.now();
    const userId  = req.user?.userId;
    incChatRequest();
    pushEvent("chat_request_started", { userId, route: "/api/chat" });

    logger.info(
      { userId, messageCount: rawMessages.length },
      "[chat] request received",
    );

    // Capture the last user message for session title + persistence.
    // Uses raw input — not the context-windowed version.
    const lastUserContent =
      [...rawMessages].reverse().find((m) => m.role === "user")?.content ?? "";
    const sessionTitle = lastUserContent.slice(0, 60) || "New Chat";

    // ── Phase 4+5: Memory retrieval with timing ───────────────────────────────
    // Load user memory, score for relevance, and inject into system prompt.
    // retrieval is synchronous + pure (no DB/Gemini); total overhead is one
    // DB read (getUserMemory). Falls back to no injection on any error.
    let memoryBlock: string | null = null;
    let tMemRetrievalMs = 0;
    if (userId) {
      const tMemStart = Date.now();
      logger.info({ userId }, "[mem] pipeline:start");
      try {
        const allEntries  = await getUserMemory(userId);
        const relevant    = retrieveRelevantMemories(lastUserContent, rawMessages, allEntries);
        memoryBlock       = buildMemoryBlock(relevant);
        tMemRetrievalMs   = Date.now() - tMemStart;

        const injectedChars = memoryBlock?.length ?? 0;

        logger.info(
          {
            userId,
            retrieved_count: allEntries.length,
            injected_count:  relevant.length,
            injected_chars:  injectedChars,
            skipped_count:   Math.max(0, allEntries.length - relevant.length),
            retrieval_ms:    tMemRetrievalMs,
          },
          "[mem] pipeline:result",
        );

        // MEMORY_INJECTION_DEBUG — prints the full block to logs (never sent to user)
        if (process.env["MEMORY_INJECTION_DEBUG"] === "true" && memoryBlock) {
          logger.info({ memoryBlock }, "[mem] DEBUG:injection_block");
        }

        // Phase 2 events — memory_injected / memory_skipped
        if (relevant.length > 0) {
          pushEvent("memory_injected", {
            userId,
            latencyMs: tMemRetrievalMs,
            meta: { injected: relevant.length, total: allEntries.length, chars: injectedChars },
          });
        } else if (allEntries.length > 0) {
          pushEvent("memory_skipped", {
            userId,
            meta: { reason: "no_relevant_entries", total: allEntries.length },
          });
        }
      } catch (memErr) {
        tMemRetrievalMs = Date.now() - tMemStart;
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

    // ── Stream lifecycle controller ────────────────────────────────────────────
    // A single AbortController governs the entire provider stream. It fires on
    // client disconnect so the provider's read loop is interrupted at the next
    // raceAbort call rather than waiting for a chunk that may never arrive.
    const streamController = new AbortController();
    let clientDisconnected = false;

    const onClientClose = () => {
      clientDisconnected = true;
      streamController.abort();
      logger.debug({ userId }, "[chat] client disconnected — aborting provider stream");
    };
    req.on("close", onClientClose);

    let streamSucceeded = false;
    let accumContent = "";
    let resolvedSessionId: string | undefined;
    // Phase 4: AI model timing — declared here so finally can read them
    let tAiStart = 0;
    // Provider result delivered via callback — avoids module-global race under concurrency.
    let providerResult: LastProviderResult | null = null;

    try {
      tAiStart = Date.now();

      // If the client already disconnected during memory retrieval, skip the
      // LLM call entirely — there is nobody to receive the response.
      if (clientDisconnected) {
        logger.debug({ userId }, "[chat] client gone before LLM call — skipping");
        return;
      }

      const stream = await createChatStream(
        messages,
        streamController.signal,
        (r) => { providerResult = r; },
      );

      for await (const chunk of stream) {
        if (clientDisconnected) break;
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
      if (clientDisconnected) {
        // Client disconnected mid-stream — not an error, just cleanup.
        // The provider stream was already aborted via streamController.
        logger.debug({ userId }, "[chat] stream cancelled by client disconnect");
      } else {
        // Genuine provider or timeout error — log and emit error SSE.
        pushEvent("error_occurred", {
          userId,
          route: "/api/chat",
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err: errMsg }, "LLM stream error");

        // ── [DIAG] Pre-normalizeAIError ── temporary forensic logging ──────────
        logger.error(
          {
            RAW_CHAT_ERROR_TYPE:  err instanceof Error ? err.constructor.name : typeof err,
            RAW_CHAT_ERROR_MSG:   errMsg,
            RAW_CHAT_ERROR_STACK: err instanceof Error
              ? err.stack?.split("\n").slice(0, 3).join(" → ")
              : undefined,
          },
          "[DIAG] pre-normalizeAIError",
        );
        // ── end [DIAG] ───────────────────────────────────────────────────────────

        // Sanitize: never send raw provider error messages to clients.
        // Map the actual error to a canonical code (rate_limit, quota_exceeded,
        // provider_unavailable, timeout, etc.) so the frontend shows an
        // accurate, user-safe message.
        const { code: errCode } = normalizeAIError(err, "chat");

        // ── [DIAG] Post-normalizeAIError ── temporary forensic logging ─────────
        logger.error({ CLASSIFIED_CHAT_ERROR: errCode }, "[DIAG] post-normalizeAIError");
        // ── end [DIAG] ───────────────────────────────────────────────────────────
        res.write(
          sseEvent({
            error: true,
            code: errCode,
          })
        );
      }
    } finally {
      // Remove the close listener — it fires once at most, but removing it
      // keeps the req event emitter tidy on normal completion.
      req.off("close", onClientClose);

      if (streamSucceeded) {
        // ── Phase 4: Latency breakdown ───────────────────────────────────────
        const tAiMs    = Date.now() - tAiStart;
        const tTotalMs = Date.now() - tStart;
        logger.info(
          { retrieval: tMemRetrievalMs, model: tAiMs, total: tTotalMs },
          "[chat] latency_breakdown",
        );
        pushEvent("chat_request_completed", {
          userId,
          latencyMs: tTotalMs,
          route: "/api/chat",
          meta: { retrieval: tMemRetrievalMs, model: tAiMs },
        });
        // Count user message + assistant message
        incChatMessage();
        incChatMessage();

        deductRequestCredits(req);

        // Fire-and-forget persistence — never blocks the stream response.
        // Only runs when session was successfully resolved and there is content.
        if (resolvedSessionId && userId && lastUserContent) {
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

        // Fire-and-forget memory extraction — runs after [DONE], zero latency impact.
        // Passes the full conversation including the just-completed assistant turn so
        // the extractor has the most complete context for signal detection.
        if (userId && accumContent) {
          const fullTurn: Array<{ role: "user" | "assistant"; content: string }> = [
            ...rawMessages,
            { role: "assistant", content: accumContent },
          ];
          extractAndStoreMemory(userId, fullTurn).catch(
            (e: unknown) => logger.warn({ err: e }, "[extractor] unhandled error"),
          );
        }
      }
      res.end();
    }
  },
);

export default router;
