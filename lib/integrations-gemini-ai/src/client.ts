import { GoogleGenAI } from "@google/genai";

function createAiClient(): GoogleGenAI {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY must be set. Please add your Gemini API key to the Replit Secrets.",
    );
  }

  if (baseUrl) {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        apiVersion: "",
        baseUrl,
      },
    });
  }

  return new GoogleGenAI({ apiKey });
}

let _client: GoogleGenAI | null = null;

export const ai = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    if (!_client) {
      _client = createAiClient();
    }
    const value = (_client as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") {
      return value.bind(_client);
    }
    return value;
  },
});
