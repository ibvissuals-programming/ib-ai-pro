/**
 * geminiEnv.ts — Gemini env resolver for api-server.
 *
 * Single import point for all Gemini key checks in this package.
 * Canonical secret: GEMINI_API_KEY
 * Optional URL override: AI_INTEGRATIONS_GEMINI_BASE_URL
 */

export function isGeminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export function resolveGeminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || undefined;
}
