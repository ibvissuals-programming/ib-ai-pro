/**
 * requiredSecrets.ts — Single source of truth for all environment variables.
 *
 * Every service that checks an env var should reference this list rather than
 * scattering raw process.env reads. This gives migration forks one place to
 * look to understand every secret the server needs and why.
 *
 * Tiers:
 *   CRITICAL  — missing → server cannot start (process.exit)
 *   AI        — missing → SAFE_MODE (AI features disabled, server still boots)
 *   SECURITY  — missing → insecure dev fallback used, warn loudly
 *   OPTIONAL  — missing → single feature degraded, warn once
 */

export type SecretTier = "CRITICAL" | "AI" | "SECURITY" | "OPTIONAL";

export interface SecretDefinition {
  key: string;
  tier: SecretTier;
  description: string;
  setup: string;
  example?: string;
}

export const REQUIRED_SECRETS: SecretDefinition[] = [
  {
    key: "DATABASE_URL",
    tier: "CRITICAL",
    description:
      "PostgreSQL connection string. Provisioned automatically by Replit.",
    setup:
      "Enable the Replit PostgreSQL integration — DATABASE_URL is set automatically.",
    example: "postgresql://user:pass@host:5432/dbname",
  },
  {
    key: "GEMINI_API_KEY",
    tier: "AI",
    description:
      "Google Gemini API key. Powers image generation, TTS, and AI chat fallback.",
    setup:
      "Add GEMINI_API_KEY to Replit Secrets (Google AI Studio → API keys → Create).",
    example: "AIza...",
  },
  {
    key: "GROQ_API_KEY",
    tier: "AI",
    description:
      "Groq API key for fast chat completions (Llama 3.1). Gemini is used as fallback if absent.",
    setup:
      "Add GROQ_API_KEY to Replit Secrets (console.groq.com → API keys). Optional — Gemini fallback is automatic.",
    example: "gsk_...",
  },
  {
    key: "JWT_SECRET",
    tier: "SECURITY",
    description: "Secret used to sign and verify user session tokens.",
    setup:
      "Add JWT_SECRET to Replit Secrets — any random string of 32+ characters.",
    example: "change-me-to-a-long-random-string-32-chars-minimum",
  },
  {
    key: "CEO_RECOVERY_KEY",
    tier: "OPTIONAL",
    description: "Emergency key to reset the CEO (admin) account password.",
    setup:
      "Add CEO_RECOVERY_KEY to Replit Secrets — any secure random string.",
    example: "recovery-secret-string",
  },
  {
    key: "SESSION_SECRET",
    tier: "OPTIONAL",
    description:
      "Secret for server-side session signing. Falls back to a random value per process.",
    setup:
      "Add SESSION_SECRET to Replit Secrets — any long random string.",
    example: "session-secret-string",
  },
  {
    key: "HF_API_KEY",
    tier: "OPTIONAL",
    description:
      "HuggingFace API token. Powers image generation (FLUX.1-schnell). Image generation is disabled if absent.",
    setup:
      "Add HF_API_KEY to Replit Secrets (huggingface.co → Settings → Access Tokens → New token, role: Read).",
    example: "hf_...",
  },
];

export const CRITICAL_SECRETS = REQUIRED_SECRETS.filter(
  (s) => s.tier === "CRITICAL"
);
export const AI_SECRETS = REQUIRED_SECRETS.filter((s) => s.tier === "AI");
export const SECURITY_SECRETS = REQUIRED_SECRETS.filter(
  (s) => s.tier === "SECURITY"
);
export const OPTIONAL_SECRETS = REQUIRED_SECRETS.filter(
  (s) => s.tier === "OPTIONAL"
);

export function getSecretDef(key: string): SecretDefinition | undefined {
  return REQUIRED_SECRETS.find((s) => s.key === key);
}
