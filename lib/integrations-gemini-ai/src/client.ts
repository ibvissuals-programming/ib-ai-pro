import { GoogleGenAI } from "@google/genai";
import { resolveGeminiKey, resolveGeminiBaseUrl } from "./geminiEnv";

function createAiClient(): GoogleGenAI {
  const apiKey = resolveGeminiKey();
  const baseUrl = resolveGeminiBaseUrl();

  if (baseUrl) {
    return new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: "", baseUrl },
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
