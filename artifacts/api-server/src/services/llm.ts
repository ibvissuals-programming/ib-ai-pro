import { logger } from "../lib/logger";
import { ai } from "@workspace/integrations-gemini-ai";
import { recordCompletion, type AiProvider } from "../lib/aiMetrics";
import { isTransientError, withProviderTimeout, sanitizeProviderError } from "../lib/providerGuard";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// ── Last-completion tracking ───────────────────────────────────────────────────
// Stores the provider/fallback/latency result of the most recently completed
// stream. Consumed once by the chat route for persistence. Not suitable for
// high-concurrency environments (in-memory, single-process only).

interface LastProviderResult {
  provider: AiProvider;
  fallbackUsed: boolean;
  latencyMs: number;
}

let _lastProviderResult: LastProviderResult | null = null;

/**
 * Returns and clears the result of the most recently completed chat stream.
 * Call immediately after the for-await loop in the chat route.
 */
export function getLastProviderResult(): LastProviderResult | null {
  const r = _lastProviderResult;
  _lastProviderResult = null;
  return r;
}

export const CHAT_MODEL = "llama-3.1-8b-instant";
const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";

// Max additional retries after the first attempt (1 = two total attempts).
// Applies only to transient errors (429, 503, network). Non-transient errors
// throw immediately without retry.
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 600;

// Hard deadline for the initial Groq HTTP connection + response headers.
// Does not cover stream reading time (each chunk is independently read).
const GROQ_TIMEOUT_MS = 30_000;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Metrics wrapper ────────────────────────────────────────────────────────────
// Wraps an async generator to record full-stream latency and success/error
// when the consumer finishes reading. Transparent to the caller.

async function* wrapTracked(
  inner: AsyncIterable<string>,
  provider: AiProvider,
  fallbackTriggered: boolean,
  startMs: number,
): AsyncIterable<string> {
  try {
    for await (const chunk of inner) {
      yield chunk;
    }
    const latencyMs = Date.now() - startMs;
    recordCompletion(provider, fallbackTriggered, latencyMs, true);
    _lastProviderResult = { provider, fallbackUsed: fallbackTriggered, latencyMs };
    logger.debug(
      { provider, fallbackTriggered, latencyMs, success: true },
      "[llm] stream completed",
    );
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    recordCompletion(provider, fallbackTriggered, latencyMs, false);
    logger.debug(
      { provider, fallbackTriggered, latencyMs, success: false },
      "[llm] stream error",
    );
    throw err;
  }
}

// ── Groq streaming ─────────────────────────────────────────────────────────────

async function createGroqStream(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY — cannot use Groq provider");
  }

  const systemMessage = messages.find((m) => m.role === "system");
  const cleaned = messages.filter((m) => m.role !== "system");

  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      // Hard deadline on the HTTP connection + response phase.
      // Prevents the Groq fetch from hanging indefinitely on network issues.
      const response = await withProviderTimeout(
        () => fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: CHAT_MODEL,
            messages: [
              ...(systemMessage ? [systemMessage] : []),
              ...cleaned,
            ],
            temperature: 0.7,
            stream: true,
          }),
        }),
        GROQ_TIMEOUT_MS,
        "groq",
      );

      if (!response.ok || !response.body) {
        const errBody = await response.text().catch(() => "(unreadable)");
        logger.error(
          { status: response.status, body: errBody },
          "[groq] API rejected request",
        );
        throw new Error(`Groq API error ${response.status}: ${errBody}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      return (async function* () {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n").filter(Boolean);

            for (const line of lines) {
              if (!line.includes("data: ")) continue;
              const data = line.replace("data: ", "").trim();
              if (data === "[DONE]") return;

              try {
                const json = JSON.parse(data);
                const text = json?.choices?.[0]?.delta?.content;
                if (text) yield text;
              } catch {
                // skip malformed SSE lines
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      })();
    } catch (err) {
      // Non-transient errors (401, 400, 404, invalid model) must NOT be retried
      // and must NOT trigger Gemini fallback — they indicate misconfiguration.
      if (!isTransientError(err)) {
        logger.error({ err, attempt }, "[groq] non-transient error — not retrying");
        throw err;
      }

      attempt++;

      if (attempt > MAX_RETRIES) {
        logger.error({ err, attempt }, "[groq] transient error — max retries exhausted");
        throw err;
      }

      logger.warn({ attempt, maxRetries: MAX_RETRIES }, "[groq] transient error — retrying");
      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error("Groq failed after all retries");
}

// ── Gemini fallback streaming ──────────────────────────────────────────────────

async function createGeminiStream(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
  const systemMessage = messages.find((m) => m.role === "system");
  const conversationMessages = messages.filter((m) => m.role !== "system");

  const contents = conversationMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const stream = await ai.models.generateContentStream({
    model: GEMINI_FALLBACK_MODEL,
    contents,
    config: {
      ...(systemMessage ? { systemInstruction: systemMessage.content } : {}),
      maxOutputTokens: 8192,
    },
  });

  return (async function* () {
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield text;
    }
  })();
}

// ── Public API — Groq with conditional Gemini fallback ────────────────────────
//
// Routing logic:
//   1. If GROQ_API_KEY is absent → route directly to Gemini.
//   2. If GROQ_API_KEY is present → try Groq first.
//      - Transient errors (429, 503, timeout, network reset) → Gemini fallback.
//      - Non-transient errors (401, 400, 404, invalid model) → throw immediately.
//        Non-transient failures indicate misconfiguration and must NOT be masked
//        by silently routing to Gemini.
//
// Instrumentation:
//   - Every routing path records provider, fallback flag, latency, and
//     success/error to aiMetrics via wrapTracked().
//   - Per-request routing selection logs are DEBUG (not INFO).
//   - Errors, warnings, and fallback events remain at WARN/INFO.
//   - API keys and message content are never logged.
//
// Throws only when the active provider(s) genuinely fail — never silently.

export async function createChatStream(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
  const hasGroqKey = !!process.env.GROQ_API_KEY;
  const requestStartMs = Date.now();

  // ── Fast path: Groq key absent — route directly to Gemini ────────────────────
  if (!hasGroqKey) {
    logger.debug(
      { provider: "gemini", model: GEMINI_FALLBACK_MODEL, reason: "groq_key_absent" },
      "[llm] routing to Gemini (Groq not configured)",
    );
    try {
      const stream = await createGeminiStream(messages);
      logger.debug({ model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini stream ready");
      return wrapTracked(stream, "gemini", false, requestStartMs);
    } catch (geminiErr) {
      const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      recordCompletion("gemini", false, Date.now() - requestStartMs, false);
      logger.error({ err: msg, model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini failed — no fallback available");
      throw new Error(`AI provider failed: ${sanitizeProviderError(geminiErr, "chat")}`);
    }
  }

  // ── Groq key present — try Groq first ────────────────────────────────────────
  let groqErrMsg = "";
  let groqErrIsTransient = false;
  const groqStartMs = Date.now();
  logger.debug({ model: CHAT_MODEL, provider: "groq" }, "[llm] routing to Groq (primary)");

  try {
    const stream = await createGroqStream(messages);
    logger.debug({ model: CHAT_MODEL }, "[llm] Groq stream ready");
    return wrapTracked(stream, "groq", false, requestStartMs);
  } catch (groqErr) {
    groqErrMsg = groqErr instanceof Error ? groqErr.message : String(groqErr);
    groqErrIsTransient = isTransientError(groqErr);
    recordCompletion("groq", false, Date.now() - groqStartMs, false);

    if (!groqErrIsTransient) {
      // Non-transient: misconfiguration or bad request — do not mask with fallback.
      logger.error(
        { err: groqErrMsg, model: CHAT_MODEL, reason: "non_transient" },
        "[llm] Groq non-transient error — not falling back to Gemini",
      );
      throw new Error(`Chat provider error: ${sanitizeProviderError(groqErr, "chat")}`);
    }

    logger.warn(
      { err: groqErrMsg, model: CHAT_MODEL, fallback: GEMINI_FALLBACK_MODEL },
      "[llm] Groq transient failure — activating Gemini fallback",
    );
  }

  // ── Gemini fallback (triggered only by transient Groq failure) ─────────────
  logger.info(
    { model: GEMINI_FALLBACK_MODEL, trigger: "groq_transient_failure" },
    "[llm] Gemini fallback activated",
  );

  try {
    const stream = await createGeminiStream(messages);
    logger.debug({ model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini fallback stream ready");
    return wrapTracked(stream, "gemini", true, requestStartMs);
  } catch (geminiErr) {
    const geminiErrMsg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
    recordCompletion("gemini", true, Date.now() - requestStartMs, false);
    logger.error(
      { geminiErr: geminiErrMsg },
      "[llm] Both providers failed — no AI response possible",
    );
    throw new Error(
      `Both AI providers failed. Groq: ${sanitizeProviderError(new Error(groqErrMsg), "chat")}. Gemini: ${sanitizeProviderError(geminiErr, "chat")}.`,
    );
  }
}
