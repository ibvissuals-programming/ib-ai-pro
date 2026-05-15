// ╔══════════════════════════════════════════════════════════════════╗
// ║  RUNTIME AI PROVIDER GUARD — IB AI Assistant                   ║
// ║  Enforces Gemini as the ONLY valid AI execution path.          ║
// ║  Called before every API call. Cannot be bypassed at runtime.  ║
// ╚══════════════════════════════════════════════════════════════════╝

const GEMINI_MODEL_PREFIX = "gemini-";

class AiProviderViolation extends Error {
  readonly code = "AI_PROVIDER_VIOLATION";
  constructor(reason: string) {
    super(`AI_PROVIDER_VIOLATION: ${reason}`);
    this.name = "AiProviderViolation";
  }
}

export function assertGeminiProvider(model: string): void {
  if (!process.env.AI_INTEGRATIONS_GEMINI_BASE_URL) {
    throw new AiProviderViolation(
      "AI_INTEGRATIONS_GEMINI_BASE_URL is not set — Gemini provider is not configured",
    );
  }

  if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
    throw new AiProviderViolation(
      "AI_INTEGRATIONS_GEMINI_API_KEY is not set — Gemini provider is not configured",
    );
  }

  if (!model.startsWith(GEMINI_MODEL_PREFIX)) {
    throw new AiProviderViolation(
      `model "${model}" is not a Gemini model — only models prefixed with "${GEMINI_MODEL_PREFIX}" are permitted`,
    );
  }
}
