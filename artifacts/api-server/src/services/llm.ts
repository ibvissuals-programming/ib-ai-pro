import { logger } from "../lib/logger";
import { ai } from "@workspace/integrations-gemini-ai";
import { recordCompletion, type AiProvider } from "../lib/aiMetrics";
import { isTransientError, withProviderTimeout } from "../lib/providerGuard";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// ── Per-request provider result ────────────────────────────────────────────────
// Delivered via an onComplete callback instead of a module-level global so that
// concurrent requests never overwrite each other's provider metadata.

export interface LastProviderResult {
  provider: AiProvider;
  fallbackUsed: boolean;
  latencyMs: number;
}

export const CHAT_MODEL = "llama-3.1-8b-instant";
const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";

// Max additional retries after the first attempt (1 = two total attempts).
// Applies only to transient errors (429, 503, network). Non-transient errors
// throw immediately without retry.
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 600;

// Hard deadline for the initial Groq HTTP connection + response headers.
// Does not cover stream reading time — that is guarded by STREAM_INACTIVITY_MS.
const GROQ_TIMEOUT_MS = 30_000;

// Per-chunk inactivity deadline for both Groq and Gemini stream readers.
// If no chunk arrives within this window the provider is considered stalled
// and the stream is aborted. Chosen to match GROQ_TIMEOUT_MS so both
// providers share one consistent timeout budget, and to give enough room
// for the frontend's 55 s total timer to fire and report cleanly first on
// a genuine slow response (not a stall).
const STREAM_INACTIVITY_MS = 30_000;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Stream watchdog ────────────────────────────────────────────────────────────
// Creates a resettable inactivity timer backed by an AbortController.
// Call reset() on every received chunk to push the deadline forward.
// Call clear() in the generator's finally block to cancel the timer.

interface Watchdog {
  signal: AbortSignal;
  reset: () => void;
  clear: () => void;
}

function createWatchdog(ms: number): Watchdog {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const reset = () => {
    if (ctrl.signal.aborted) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), ms);
  };

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  reset(); // arm immediately so the first read is also guarded
  return { signal: ctrl.signal, reset, clear };
}

// ── raceAbort ─────────────────────────────────────────────────────────────────
// Races a promise against an AbortSignal. If the signal fires first, rejects
// with the provided error message. Always cleans up its own abort listener.

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  errorMsg: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(errorMsg));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(errorMsg));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// ── mergeAbortSignal ──────────────────────────────────────────────────────────
// Returns a new AbortSignal that fires when EITHER a or b fires.
// Used to combine the inactivity watchdog with the client-disconnect signal.

function mergeAbortSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  if (a.aborted || b.aborted) {
    ctrl.abort();
    return ctrl.signal;
  }
  a.addEventListener("abort", () => ctrl.abort(), { once: true });
  b.addEventListener("abort", () => ctrl.abort(), { once: true });
  return ctrl.signal;
}

// ── Metrics wrapper ────────────────────────────────────────────────────────────
// Wraps an async generator to record full-stream latency and success/error
// when the consumer finishes reading. Transparent to the caller.

async function* wrapTracked(
  inner: AsyncIterable<string>,
  provider: AiProvider,
  fallbackTriggered: boolean,
  startMs: number,
  onComplete?: (result: LastProviderResult) => void,
): AsyncIterable<string> {
  try {
    for await (const chunk of inner) {
      yield chunk;
    }
    const latencyMs = Date.now() - startMs;
    recordCompletion(provider, fallbackTriggered, latencyMs, true);
    // Deliver result via callback — no module-level global, safe for concurrent requests.
    onComplete?.({ provider, fallbackUsed: fallbackTriggered, latencyMs });
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

async function createGroqStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<AsyncIterable<string>> {
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

      // Watchdog: aborts if no chunk arrives within STREAM_INACTIVITY_MS.
      // Combined with the external signal so a client disconnect also
      // interrupts the read loop immediately instead of waiting for a chunk.
      const watchdog = createWatchdog(STREAM_INACTIVITY_MS);
      const combined = signal
        ? mergeAbortSignal(watchdog.signal, signal)
        : watchdog.signal;

      return (async function* () {
        try {
          while (true) {
            const { value, done } = await raceAbort(
              reader.read(),
              combined,
              "stream inactivity timeout",
            );
            // Chunk arrived — push the deadline forward.
            watchdog.reset();

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
          watchdog.clear();
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

async function createGeminiStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<AsyncIterable<string>> {
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

  // Obtain the raw iterator so we can race each .next() call against the
  // watchdog and disconnect signals. The SDK's for-await loop cannot be
  // interrupted externally, but manual iteration can be.
  const iter = stream[Symbol.asyncIterator]();

  const watchdog = createWatchdog(STREAM_INACTIVITY_MS);
  const combined = signal
    ? mergeAbortSignal(watchdog.signal, signal)
    : watchdog.signal;

  return (async function* () {
    try {
      while (true) {
        // Cast to a known shape so TypeScript can narrow after the done check.
        const iterResult = await raceAbort(
          iter.next() as Promise<IteratorResult<{ text?: string }>>,
          combined,
          "stream inactivity timeout",
        );
        // Chunk arrived — push the deadline forward.
        watchdog.reset();

        if (iterResult.done) break;
        const text = iterResult.value.text;
        if (text) yield text;
      }
    } finally {
      watchdog.clear();
      // Best-effort cleanup: signal the SDK iterator we are done so it can
      // release internal resources (e.g. cancel an in-flight HTTP request).
      iter.return?.(undefined);
    }
  })();
}

// ── Public API — Groq with Gemini fallback ────────────────────────────────────
//
// Routing logic:
//   1. If GROQ_API_KEY is absent → route directly to Gemini.
//   2. If GROQ_API_KEY is present → try Groq first.
//      - Any Groq failure (transient OR non-transient) → Gemini fallback.
//        This ensures a misconfigured Groq key (401/400/bad model) never
//        breaks chat — Gemini is always the safety net.
//      - Only throws to the caller when Gemini also fails.
//
// Instrumentation:
//   - Every routing path records provider, fallback flag, latency, and
//     success/error to aiMetrics via wrapTracked().
//   - Per-request routing selection logs are DEBUG (not INFO).
//   - Errors, warnings, and fallback events remain at WARN/INFO.
//   - API keys and message content are never logged.
//
// signal: optional AbortSignal from the chat route. Fires when the client
//   disconnects. Propagated to each provider's stream reader so orphaned
//   coroutines are terminated immediately rather than waiting for the next
//   chunk boundary.
//
// Throws only when the active provider(s) genuinely fail — never silently.

export async function createChatStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
  onComplete?: (result: LastProviderResult) => void,
): Promise<AsyncIterable<string>> {
  const hasGroqKey = !!process.env.GROQ_API_KEY;
  const requestStartMs = Date.now();

  // ── Fast path: Groq key absent — route directly to Gemini ────────────────────
  if (!hasGroqKey) {
    logger.debug(
      { provider: "gemini", model: GEMINI_FALLBACK_MODEL, reason: "groq_key_absent" },
      "[llm] routing to Gemini (Groq not configured)",
    );
    try {
      const stream = await createGeminiStream(messages, signal);
      logger.debug({ model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini stream ready");
      return wrapTracked(stream, "gemini", false, requestStartMs, onComplete);
    } catch (geminiErr) {
      const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      recordCompletion("gemini", false, Date.now() - requestStartMs, false);
      logger.error({ err: msg, model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini failed — no fallback available");
      logger.debug(
        { provider: "gemini", rawError: msg },
        "[llm:debug] propagating original Gemini error to chat boundary",
      );
      throw geminiErr;
    }
  }

  // ── Groq key present — try Groq first ────────────────────────────────────────
  let groqErrMsg = "";
  let groqErrIsTransient = false;
  const groqStartMs = Date.now();
  logger.debug({ model: CHAT_MODEL, provider: "groq" }, "[llm] routing to Groq (primary)");

  try {
    const stream = await createGroqStream(messages, signal);
    logger.debug({ model: CHAT_MODEL }, "[llm] Groq stream ready");
    return wrapTracked(stream, "groq", false, requestStartMs, onComplete);
  } catch (groqErr) {
    groqErrMsg = groqErr instanceof Error ? groqErr.message : String(groqErr);
    groqErrIsTransient = isTransientError(groqErr);
    recordCompletion("groq", false, Date.now() - groqStartMs, false);

    const logLevel = groqErrIsTransient ? "warn" : "error";
    logger[logLevel](
      { err: groqErrMsg, model: CHAT_MODEL, fallback: GEMINI_FALLBACK_MODEL, transient: groqErrIsTransient },
      "[llm] Groq failure — activating Gemini fallback",
    );
  }

  // ── Gemini fallback ────────────────────────────────────────────────────────
  logger.info(
    { model: GEMINI_FALLBACK_MODEL, trigger: "groq_transient_failure" },
    "[llm] Gemini fallback activated",
  );

  try {
    const stream = await createGeminiStream(messages, signal);
    logger.debug({ model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini fallback stream ready");
    return wrapTracked(stream, "gemini", true, requestStartMs, onComplete);
  } catch (geminiErr) {
    const geminiErrMsg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
    recordCompletion("gemini", true, Date.now() - requestStartMs, false);
    logger.error(
      { geminiErr: geminiErrMsg, groqErr: groqErrMsg },
      "[llm] Both providers failed — no AI response possible",
    );
    logger.debug(
      { provider: "both", groqRawError: groqErrMsg, geminiRawError: geminiErrMsg },
      "[llm:debug] both providers failed — propagating Gemini error for classification",
    );
    throw new Error(`Both providers failed. Gemini: ${geminiErrMsg}.`);
  }
}
