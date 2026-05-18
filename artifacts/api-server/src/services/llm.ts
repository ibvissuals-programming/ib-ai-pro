// ╔══════════════════════════════════════════════════════════════════╗
// ║  AI ARCHITECTURE LOCK — IB AI Assistant                        ║
// ║  Any AI response MUST originate from the Gemini stream only.    ║
// ║  No fallback provider, mock engine, or static reply is allowed. ║
// ║  Do NOT add: generateAIResponse, defaultReply, or any           ║
// ║  alternative AI path. Violations break production integrity.    ║
// ╚══════════════════════════════════════════════════════════════════╝
import Groq from "groq-sdk";
import { logger } from "../lib/logger";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

export async function createChatStream(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
  try {
    const stream = await groq.chat.completions.create({
  model: "llama3-8b-8192",
      messages,
      temperature: 0.7,
      max_tokens: 1024,
      stream: true,
    });

    return (async function* () {
      for await (const chunk of stream) {
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield text;
      }
    })();
  } catch (err) {
    logger.error({ err }, "[groq] stream error");
    throw err;
  }
}
