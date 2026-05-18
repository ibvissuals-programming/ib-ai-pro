// ╔══════════════════════════════════════════════════════════════════╗
// ║  AI ARCHITECTURE LOCK — IB AI Assistant                        ║
// ║  Any AI response MUST originate from the Gemini stream only.    ║
// ║  No fallback provider, mock engine, or static reply is allowed. ║
// ║  Do NOT add: generateAIResponse, defaultReply, or any           ║
// ║  alternative AI path. Violations break production integrity.    ║
// ╚══════════════════════════════════════════════════════════════════╝
import { logger } from "../lib/logger";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const CHAT_MODEL = "llama3-8b-8192";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 600;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err: any): boolean {
  const msg = String(err?.message || err).toLowerCase();
  return msg.includes("429") || msg.includes("rate") || msg.includes("overloaded");
}

export async function createChatStream(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY");
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
        throw new Error(`Groq API error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      return (async function* () {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });

          const lines = chunk.split("\n").filter(Boolean);

          for (const line of lines) {
            if (line.includes("data: ")) {
              const data = line.replace("data: ", "").trim();
              if (data === "[DONE]") return;

              try {
                const json = JSON.parse(data);
                const text = json?.choices?.[0]?.delta?.content;
                if (text) yield text;
              } catch {}
            }
          }
        }
      })();
    } catch (err) {
      attempt++;

      if (!isRetryable(err) || attempt >= MAX_RETRIES) {
        logger.error({ err }, "[groq] failed");
        throw err;
      }

      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error("Groq failed after retries");
                                       }
