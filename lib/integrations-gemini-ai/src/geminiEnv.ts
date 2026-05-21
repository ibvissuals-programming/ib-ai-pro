/**
 * geminiEnv.ts — Single source of truth for Gemini environment resolution.
 *
 * Canonical env vars:
 *   GEMINI_API_KEY            — required. The Gemini API key.
 *   AI_INTEGRATIONS_GEMINI_BASE_URL — optional. Override base URL (e.g. Replit proxy).
 *
 * AI_INTEGRATIONS_GEMINI_API_KEY is intentionally NOT read here.
 * If Replit AI proxy is ever enabled, set GEMINI_API_KEY to the proxy key
 * and AI_INTEGRATIONS_GEMINI_BASE_URL to the proxy base URL.
 */

export function resolveGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set — add your Gemini API key to Replit Secrets.",
    );
  }
  return key;
}

export function resolveGeminiBaseUrl(): string | undefined {
  return process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || undefined;
}

export function isGeminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}
