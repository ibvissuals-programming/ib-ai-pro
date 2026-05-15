/**
 * Credit data store — IB AI Assistant freemium system.
 *
 * Lightweight in-memory store backed by an atomic JSON file.
 * No ORM, no external database — reads on startup, writes asynchronously.
 *
 * Architecture rules:
 *   - NEVER block the SSE stream. Credit reads are synchronous (in-memory).
 *   - NEVER deduct credits in this module. Call deductCredits() only after a
 *     successful generation in the route handler.
 *   - Writes are scheduled via setImmediate so they don't delay HTTP responses.
 *   - Atomic: temp-file + rename prevents partial writes.
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../data");
const CREDITS_FILE = path.join(DATA_DIR, "credits.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export type Plan = "free" | "pro" | "max";

export interface UserRecord {
  username: string;
  plan: Plan;
  dailyCreditsUsed: number;
  lastResetDate: string; // YYYY-MM-DD UTC
  totalUsage: number;
}

export interface CreditStatus {
  username: string;
  plan: Plan;
  dailyCreditsUsed: number;
  dailyLimit: number | null; // null = unlimited
  creditsRemaining: number | null; // null = unlimited
  lastResetDate: string;
}

// ── Plan configuration ────────────────────────────────────────────────────────

export const PLAN_DAILY_CREDITS: Record<Plan, number> = {
  free: 5,
  pro: 100,
  max: Infinity,
};

// Credit costs per feature.
// chat = 0 so the core chat engine is always free.
// image_analysis = 2 covers both image prompts + video direction in one call.
export const CREDIT_COSTS = {
  chat: 0,
  image_analysis: 2,
} as const;

// ── In-memory store ───────────────────────────────────────────────────────────

const store = new Map<string, UserRecord>();
let saveScheduled = false;

// ── Date helpers ──────────────────────────────────────────────────────────────

function getTodayUtc(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistStore(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data = JSON.stringify(Array.from(store.values()), null, 2);
    const tmp = CREDITS_FILE + ".tmp";
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, CREDITS_FILE);
  } catch (err) {
    logger.error({ err }, "[credits] Failed to persist store");
  }
}

function scheduleSave(): void {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(async () => {
    saveScheduled = false;
    await persistStore();
  });
}

/**
 * Load credits from disk into the in-memory store.
 * Called once on server startup before accepting requests.
 */
export async function loadStore(): Promise<void> {
  try {
    const data = await fs.readFile(CREDITS_FILE, "utf8");
    const records: UserRecord[] = JSON.parse(data);
    for (const record of records) {
      store.set(record.username, record);
    }
    logger.info({ count: store.size }, "[credits] Loaded user records");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info("[credits] No credits file found — starting fresh");
    } else {
      logger.error({ err }, "[credits] Failed to load credits store");
    }
  }
}

// ── Core helpers ──────────────────────────────────────────────────────────────

function resetIfNewDay(record: UserRecord): void {
  const today = getTodayUtc();
  if (record.lastResetDate !== today) {
    record.dailyCreditsUsed = 0;
    record.lastResetDate = today;
  }
}

function getOrCreate(username: string): UserRecord {
  if (!store.has(username)) {
    store.set(username, {
      username,
      plan: "free",
      dailyCreditsUsed: 0,
      lastResetDate: getTodayUtc(),
      totalUsage: 0,
    });
  }
  return store.get(username)!;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getUserRecord(username: string): UserRecord {
  const record = getOrCreate(username);
  resetIfNewDay(record);
  return record;
}

export function getCreditStatus(username: string): CreditStatus {
  const record = getUserRecord(username);
  const limit = PLAN_DAILY_CREDITS[record.plan];
  const isUnlimited = limit === Infinity;
  return {
    username: record.username,
    plan: record.plan,
    dailyCreditsUsed: record.dailyCreditsUsed,
    dailyLimit: isUnlimited ? null : limit,
    creditsRemaining: isUnlimited ? null : Math.max(0, limit - record.dailyCreditsUsed),
    lastResetDate: record.lastResetDate,
  };
}

export function hasSufficientCredits(username: string, cost: number): boolean {
  if (cost === 0) return true;
  const record = getUserRecord(username);
  const limit = PLAN_DAILY_CREDITS[record.plan];
  if (limit === Infinity) return true;
  return limit - record.dailyCreditsUsed >= cost;
}

/**
 * Deduct credits. Call ONLY after a successful generation.
 * No-ops if cost is 0 or plan is unlimited.
 */
export function deductCredits(username: string, cost: number): void {
  if (cost === 0) return;
  const record = getUserRecord(username);
  const limit = PLAN_DAILY_CREDITS[record.plan];
  if (limit === Infinity) return;
  record.dailyCreditsUsed = Math.min(limit, record.dailyCreditsUsed + cost);
  record.totalUsage += cost;
  scheduleSave();
}

/**
 * Upgrade a user's plan.
 * In production this would be gated behind payment verification.
 */
export function upgradePlan(username: string, plan: Plan): UserRecord {
  const record = getOrCreate(username);
  record.plan = plan;
  scheduleSave();
  return record;
}
