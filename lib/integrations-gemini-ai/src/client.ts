import { GoogleGenAI } from "@google/genai";

function createAiClient(): GoogleGenAI {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  if (!baseUrl) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_BASE_URL must be set. Did you forget to provision the Gemini AI integration?",
    );
  }

  if (!apiKey) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_API_KEY must be set. Did you forget to provision the Gemini AI integration?",
    );
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: "",
      baseUrl,
    },
  });
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
