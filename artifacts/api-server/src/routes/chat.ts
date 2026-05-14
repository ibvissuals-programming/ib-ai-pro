// ╔══════════════════════════════════════════════════════════════════╗
// ║  ROUTE IMMUTABILITY RULE — IB AI Pro                           ║
// ║  /api/chat is the ONLY AI execution endpoint.                  ║
// ║  All AI requests MUST route through POST /api/chat.            ║
// ║  Direct or alternative AI execution paths are forbidden.       ║
// ║  Do NOT add: /api/generate, /api/ai, /api/message, or any      ║
// ║  route that calls createChatStream() or the Gemini client.     ║
// ╚══════════════════════════════════════════════════════════════════╝
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { createChatStream, type ChatMessage } from "../services/llm";
import { SYSTEM_PROMPT } from "../prompts/system";
import { logger } from "../lib/logger";

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

// ─── Date injection ───────────────────────────────────────────────────────────
// Builds a safe UTC date/time string injected into the system prompt at request
// time. Uses only UTC math — no locale-sensitive calls (toLocaleDateString,
// toLocaleTimeString) that could throw in constrained Node.js ICU environments.
// This ensures date/time utility queries ("what's today's date?") always return
// accurate information without depending on Gemini's training data cutoff.

function buildDatedSystemPrompt(): string {
  const d = new Date();
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
  const timeStr = `${hours}:${mins} UTC`;

  return `${SYSTEM_PROMPT}\n\n## Current Date & Time\n${dateStr} — ${timeStr}`;
}

// ─── Validation schema ────────────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
});

const ChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(50),
});

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ─── Context builder (single authority) ──────────────────────────────────────

type RawMessage = { role: "user" | "assistant"; content: string };

/**
 * The ONLY function that assembles messages sent to Gemini.
 *
 * Pipeline:
 *   1. Trim whitespace from every message's content.
 *   2. Cap content at MAX_CONTENT_LENGTH characters.
 *   3. Drop messages empty after trimming.
 *   4. Remove consecutive duplicates (same role + same content).
 *   5. Detect conversation mode from cleaned messages.
 *   6. Apply the adaptive context window for that mode.
 *   7. Prepend the system prompt with current UTC date/time injected.
 */
function buildContext(raw: RawMessage[]): ChatMessage[] {
  // Runtime array guard — Zod validates before this is called, but defend
  // against any edge case where a non-array value reaches this function.
  const safeRaw = Array.isArray(raw) ? raw : [];

  const cleaned = safeRaw
    .map((m) => ({
      ...m,
      // typeof guard: ensure content is a string before calling .trim(),
      // preventing a crash if null/undefined slips through at JS runtime.
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

  logger.debug({ mode, window, total: cleaned.length }, "context built");

  return [
    { role: "system", content: buildDatedSystemPrompt() },
    ...cleaned.slice(-window),
  ];
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post("/chat", async (req: Request, res: Response) => {
  const parsed = ChatRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
    return;
  }

  const messages = buildContext(parsed.data.messages);

  // Set SSE headers before any async work so the client gets a 200 immediately
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Write an SSE comment immediately so the proxy and browser know the stream is alive.
  // This prevents any upstream timeout before the LLM returns the first token.
  res.write(": connected\n\n");

  try {
    const stream = await createChatStream(messages);

    for await (const chunk of stream) {
      res.write(sseEvent({ content: chunk }));
    }

    res.write("data: [DONE]\n\n");
  } catch (err: unknown) {
    logger.error({ err }, "LLM stream error");

    const code =
      err instanceof Error && "code" in err
        ? (err as { code?: string }).code
        : "unknown";

    res.write(sseEvent({ error: true, code }));
  } finally {
    res.end();
  }
});

export default router;
