/**
 * User store — IB AI Assistant persistent identity system.
 *
 * Replaces the localStorage-based auth with a server-side user database.
 * Stores users to disk via atomic JSON writes (same pattern as credits.ts).
 *
 * Architecture:
 *   - Passwords hashed with Node.js crypto.scryptSync (no external deps)
 *   - UUIDs via crypto.randomUUID()
 *   - CEO role assigned at signup/login if username matches CEO_USERNAME env var
 *   - Credits stored on the user record; 40/24h rolling window for free users
 */
import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export type UserRole = "free" | "premium" | "ceo";

export interface User {
  id: string;
  username: string;
  passwordHash: string; // format: "salt:hash" (hex), both from scrypt
  role: UserRole;
  credits: number;
  lastReset: number; // Unix timestamp ms — for rolling 24h window
  createdAt: number;
}

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  credits: number;
  lastReset: number;
}

// ── Credit constants ──────────────────────────────────────────────────────────

export const FREE_CREDITS = 40;
export const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const CREDIT_COSTS = {
  chat: 1,
  image_generate: 3,
  image_edit: 5,
  image_analysis: 2,
} as const;

export type CreditFeature = keyof typeof CREDIT_COSTS;

// ── In-memory store ───────────────────────────────────────────────────────────

const store = new Map<string, User>(); // keyed by userId
let saveScheduled = false;

// ── Password helpers ──────────────────────────────────────────────────────────

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, storedHex] = stored.split(":");
  if (!salt || !storedHex) return false;
  try {
    const hash = scryptSync(password, salt, 64);
    const storedBuf = Buffer.from(storedHex, "hex");
    if (hash.length !== storedBuf.length) return false;
    return timingSafeEqual(hash, storedBuf);
  } catch {
    return false;
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistStore(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data = JSON.stringify(Array.from(store.values()), null, 2);
    const tmp = USERS_FILE + ".tmp";
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, USERS_FILE);
  } catch (err) {
    logger.error({ err }, "[userStore] Failed to persist");
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

export async function loadUserStore(): Promise<void> {
  try {
    const data = await fs.readFile(USERS_FILE, "utf8");
    const users: User[] = JSON.parse(data);
    for (const user of users) {
      store.set(user.id, user);
    }
    logger.info({ count: store.size }, "[userStore] Loaded users");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info("[userStore] No users file — starting fresh");
    } else {
      logger.error({ err }, "[userStore] Failed to load users");
    }
  }
}

// ── CEO detection ─────────────────────────────────────────────────────────────

function isCeoUsername(username: string): boolean {
  const ceo = process.env["CEO_USERNAME"]?.trim().toLowerCase();
  return !!ceo && username.toLowerCase() === ceo;
}

// ── Credit logic ──────────────────────────────────────────────────────────────

function refillIfExpired(user: User): void {
  if (user.role === "ceo") return;
  const now = Date.now();
  if (now - user.lastReset >= RESET_INTERVAL_MS) {
    user.credits = FREE_CREDITS;
    user.lastReset = now;
    scheduleSave();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getUserById(id: string): User | undefined {
  const user = store.get(id);
  if (user) refillIfExpired(user);
  return user;
}

export function getUserByUsername(username: string): User | undefined {
  const normalized = username.trim().toLowerCase();
  for (const user of store.values()) {
    if (user.username === normalized) {
      refillIfExpired(user);
      return user;
    }
  }
  return undefined;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    credits: user.role === "ceo" ? Infinity : user.credits,
    lastReset: user.lastReset,
  };
}

export function createUser(
  username: string,
  password: string,
): { success: true; user: User } | { success: false; error: string } {
  const normalized = username.trim().toLowerCase();

  if (normalized.length < 3 || normalized.length > 32) {
    return { success: false, error: "Username must be 3–32 characters" };
  }
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    return {
      success: false,
      error: "Username may only contain letters, numbers, and underscores",
    };
  }
  if (password.length < 6) {
    return { success: false, error: "Password must be at least 6 characters" };
  }
  if (getUserByUsername(normalized)) {
    return { success: false, error: "Username already taken" };
  }

  const role: UserRole = isCeoUsername(normalized) ? "ceo" : "free";

  const user: User = {
    id: randomUUID(),
    username: normalized,
    passwordHash: hashPassword(password),
    role,
    credits: FREE_CREDITS,
    lastReset: Date.now(),
    createdAt: Date.now(),
  };

  store.set(user.id, user);
  scheduleSave();
  logger.info({ username: normalized, role }, "[userStore] User created");
  return { success: true, user };
}

export function authenticateUser(
  username: string,
  password: string,
): User | null {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;

  // Apply CEO override at every login (env var may be set after account creation)
  if (isCeoUsername(user.username) && user.role !== "ceo") {
    user.role = "ceo";
    scheduleSave();
    logger.info({ username: user.username }, "[userStore] CEO role applied");
  }

  return user;
}

export function hasCredits(user: User, cost: number): boolean {
  if (user.role === "ceo") return true;
  if (cost === 0) return true;
  refillIfExpired(user);
  return user.credits >= cost;
}

export function deductCredits(userId: string, cost: number): void {
  if (cost === 0) return;
  const user = store.get(userId);
  if (!user) return;
  if (user.role === "ceo") return;
  refillIfExpired(user);
  user.credits = Math.max(0, user.credits - cost);
  scheduleSave();
}

export function setUserRole(userId: string, role: UserRole): void {
  const user = store.get(userId);
  if (!user) return;
  user.role = role;
  scheduleSave();
}
