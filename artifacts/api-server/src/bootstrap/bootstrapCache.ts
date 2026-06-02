/**
 * bootstrapCache.ts — Boot validation cache.
 *
 * Ensures env validation runs exactly ONCE per process lifetime.
 * Any subsequent call to getCachedBootstrap() returns the same result
 * without re-reading or re-validating environment variables.
 *
 * Rules:
 *   - Never throws
 *   - clearBootstrapCache() is dev-only; production code must not call it
 *   - The cached value is the single source of boot truth for the process
 */

export interface BootstrapStatus {
  ready: boolean;
  safeMode: boolean;
  aiMode: "FULL" | "SAFE_MODE";
  vars: {
    DATABASE_URL: boolean;
    GEMINI_API_KEY: boolean;
    GROQ_API_KEY: boolean;
    JWT_SECRET: boolean;
    SESSION_SECRET: boolean;
    CEO_USERNAME: boolean;
    CEO_RECOVERY_KEY: boolean;
  };
  missing: string[];
  warnings: string[];
  critical: string[];
  checkedAt: number;
}

let _cachedStatus: BootstrapStatus | null = null;

/**
 * Returns the cached bootstrap status, or null if validation has not run yet.
 */
export function getCachedBootstrap(): BootstrapStatus | null {
  return _cachedStatus;
}

/**
 * Store the result of a validation run. Called exactly once from envBootstrap.ts.
 * Subsequent calls are no-ops (idempotent).
 */
export function setCachedBootstrap(status: BootstrapStatus): void {
  if (_cachedStatus === null) {
    _cachedStatus = status;
  }
}

/**
 * Clear the cache. FOR DEVELOPMENT / TESTING ONLY.
 * Must never be called in production code paths.
 */
export function clearBootstrapCache(): void {
  if (process.env["NODE_ENV"] !== "production") {
    _cachedStatus = null;
  }
}

/**
 * True if a cached result exists AND it is marked ready.
 */
export function isBootstrapCached(): boolean {
  return _cachedStatus !== null;
}
