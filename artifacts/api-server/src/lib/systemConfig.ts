/**
 * systemConfig — runtime storage mode configuration.
 *
 * Persisted to data/system-config.json so changes survive restarts.
 * Readable and writable at runtime — no server restart required to toggle.
 *
 * Boot order: loadSystemConfig() MUST be called before loadUserStore()
 * so isPostgresEnabled() returns the correct value at startup.
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR  = path.join(__dirname, "../../data");
const CONFIG_FILE = path.join(CONFIG_DIR, "system-config.json");

export type StorageMode = "json" | "postgres" | "hybrid";

interface SystemConfigData {
  storageMode: StorageMode;
  lastMigrationRun: number | null;
  updatedAt: number;
}

// ── In-memory state (mutated by setters) ─────────────────────────────────────

let _config: SystemConfigData = {
  storageMode:      "json",
  lastMigrationRun: null,
  updatedAt:        Date.now(),
};

// ── Persistence ───────────────────────────────────────────────────────────────

async function saveConfig(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(_config, null, 2), "utf8");
  } catch (err) {
    logger.error({ err }, "[systemConfig] Failed to persist config");
  }
}

// ── Initialization ────────────────────────────────────────────────────────────

/**
 * Load stored configuration from disk, falling back to env-var bootstrap on
 * first run. Call once at server startup before loadUserStore().
 */
export async function loadSystemConfig(): Promise<void> {
  try {
    const raw    = await fs.readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SystemConfigData>;
    _config = {
      storageMode:      parsed.storageMode      ?? "json",
      lastMigrationRun: parsed.lastMigrationRun ?? null,
      updatedAt:        parsed.updatedAt        ?? Date.now(),
    };
    logger.info({ storageMode: _config.storageMode }, "[systemConfig] Loaded from file");
  } catch (err: unknown) {
    // First run — bootstrap from env var, then persist
    const envMode = process.env["USE_POSTGRES_STORAGE"];
    if (envMode === "true" || envMode === "postgres") {
      _config.storageMode = "postgres";
    } else if (envMode === "hybrid") {
      _config.storageMode = "hybrid";
    }
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err }, "[systemConfig] Could not read config — defaulting");
    }
    logger.info({ storageMode: _config.storageMode }, "[systemConfig] Fresh start (env bootstrap)");
    await saveConfig(); // Write initial config
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True when PG should be the primary persistence target. */
export function isPostgresEnabled(): boolean {
  return _config.storageMode === "postgres" || _config.storageMode === "hybrid";
}

export function getStorageMode(): StorageMode {
  return _config.storageMode;
}

export function getLastMigrationRun(): number | null {
  return _config.lastMigrationRun;
}

export function getSystemConfigSnapshot(): SystemConfigData {
  return { ..._config };
}

export async function setStorageMode(mode: StorageMode): Promise<void> {
  _config.storageMode = mode;
  _config.updatedAt   = Date.now();
  await saveConfig();
  logger.info({ mode }, "[systemConfig] Storage mode updated");
}

export async function setLastMigrationRun(timestamp: number): Promise<void> {
  _config.lastMigrationRun = timestamp;
  _config.updatedAt        = Date.now();
  await saveConfig();
}
