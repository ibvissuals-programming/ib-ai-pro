import { logger } from "../lib/logger";
import { ai } from "@workspace/integrations-gemini-ai";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const CHAT_MODEL = "llama-3.1-8b-instant";
const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 600;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err: any): boolean {
  const msg = String(err?.message || err).toLowerCase();
  return msg.includes("429") || msg.includes("rate") || msg.includes("overloaded");
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

  while (attempt < MAX_RETRIES) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
      });

      if (!response.ok || !response.body) {
        // Read error body for proper diagnostics before throwing
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
      attempt++;

      if (!isRetryable(err) || attempt >= MAX_RETRIES) {
        logger.error({ err, attempt }, "[groq] failed — not retrying");
        throw err;
      }

      logger.warn({ attempt }, "[groq] retryable error — retrying");
      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error("Groq failed after all retries");
}

// ── Gemini fallback streaming ──────────────────────────────────────────────────

async function createGeminiStream(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
  const systemMessage = messages.find((m) => m.role === "system");
  const conversationMessages = messages.filter((m) => m.role !== "system");

  // Map OpenAI-style roles to Gemini roles (assistant → model)
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

// ── Public API — Groq with Gemini fallback ────────────────────────────────────

/**
 * createChatStream()
 *
 * Routing logic:
 *   1. If GROQ_API_KEY is present → try Groq (llama-3.1-8b-instant) first,
 *      fall back to Gemini (gemini-2.5-flash) only on real failure.
 *   2. If GROQ_API_KEY is absent → route directly to Gemini with a clear log.
 *      No spurious "Groq started → Groq failed" noise.
 *
 * Throws only when the active provider(s) genuinely fail — never silently.
 */
export async function createChatStream(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
  const hasGroqKey = !!process.env.GROQ_API_KEY;

  // ── Fast path: Groq key absent — route directly to Gemini ────────────────────
  if (!hasGroqKey) {
    logger.info(
      { provider: "gemini", model: GEMINI_FALLBACK_MODEL, reason: "groq_key_absent" },
      "[llm] routing: Groq not configured — Gemini is primary for this deployment",
    );
    try {
      const stream = await createGeminiStream(messages);
      logger.info({ model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini stream ready");
      return stream;
    } catch (geminiErr) {
      const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      logger.error({ err: msg, model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini failed — no fallback available");
      throw new Error(`AI provider failed: ${msg}`);
    }
  }

  // ── Groq key present — try Groq first ────────────────────────────────────────
  let groqErrMsg = "";
  logger.info({ model: CHAT_MODEL, provider: "groq" }, "[llm] routing: Groq selected as primary");
  try {
    const stream = await createGroqStream(messages);
    logger.info({ model: CHAT_MODEL }, "[llm] Groq success — primary provider active");
    return stream;
  } catch (groqErr) {
    groqErrMsg = groqErr instanceof Error ? groqErr.message : String(groqErr);
    logger.warn(
      { err: groqErrMsg, model: CHAT_MODEL, fallback: GEMINI_FALLBACK_MODEL },
      "[llm] Groq failed — activating Gemini fallback",
    );
  }

  // ── Gemini fallback (triggered by Groq failure) ───────────────────────────────
  logger.info(
    { model: GEMINI_FALLBACK_MODEL, trigger: "groq_failure", groqErr: groqErrMsg },
    "[llm] Gemini fallback activated",
  );
  try {
    const stream = await createGeminiStream(messages);
    logger.info({ model: GEMINI_FALLBACK_MODEL }, "[llm] Gemini fallback stream ready");
    return stream;
  } catch (geminiErr) {
    const geminiErrMsg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
    logger.error(
      { groqErr: groqErrMsg, geminiErr: geminiErrMsg },
      "[llm] Both providers failed — no AI response possible",
    );
    throw new Error(
      `Both AI providers failed. Groq: ${groqErrMsg}. Gemini: ${geminiErrMsg}.`,
    );
  }
}
