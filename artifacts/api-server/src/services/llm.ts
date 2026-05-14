// ╔══════════════════════════════════════════════════════════════════╗
// ║  AI ARCHITECTURE LOCK — IB AI v3                                ║
// ║  Any AI response MUST originate from the Gemini stream only.    ║
// ║  No fallback provider, mock engine, or static reply is allowed. ║
// ║  Do NOT add: generateAIResponse, defaultReply, or any           ║
// ║  alternative AI path. Violations break production integrity.    ║
// ╚══════════════════════════════════════════════════════════════════╝
import { ai } from "@workspace/integrations-gemini-ai";
import { logger } from "../lib/logger";
import { assertGeminiProvider } from "../lib/aiGuard";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const CHAT_MODEL = "gemini-2.5-flash";
export const MAX_TOKENS = 8192;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 600;

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("rate limit") ||
      msg.includes("overloaded")
    );
  }
  return false;
}

export async function createChatStream(
  messages: ChatMessage[],
): Promise<AsyncIterable<string>> {
  // Gemini takes system instruction separately from conversation turns
  const systemMessage = messages.find((m) => m.role === "system");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      // Gemini uses "model" where most other providers use "assistant"
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));

  // Runtime guard — throws AI_PROVIDER_VIOLATION before any API call if
  // env vars are missing or the model is not a Gemini model.
  assertGeminiProvider(CHAT_MODEL);

  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const stream = await ai.models.generateContentStream({
        model: CHAT_MODEL,
        contents: turns,
        config: {
          maxOutputTokens: MAX_TOKENS,
          temperature: 0.7,
          ...(systemMessage
            ? { systemInstruction: systemMessage.content }
            : {}),
        },
      });

      return (async function* () {
        for await (const chunk of stream) {
          const text = chunk.text;
          if (text) yield text;
        }
      })();
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt >= MAX_RETRIES) {
        throw err;
      }
      const backoff = RETRY_DELAY_MS * 2 ** (attempt - 1);
      logger.warn({ attempt, backoff }, "Gemini transient error — retrying");
      await delay(backoff);
    }
  }

  throw new Error("Exceeded max retries for Gemini request");
}
