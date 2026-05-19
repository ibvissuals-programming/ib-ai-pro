/**
 * User store — IB AI Assistant persistent identity system.
 *
 * Replaces the localStorage-based auth with a server-side user database.
 * Stores users to disk via atomic JSON writes (write tmp → fsync → rename).
 *
 * Architecture:
 *   - Passwords hashed with Node.js crypto.scryptSync (no external deps)
 *   - UUIDs via crypto.randomUUID()
 *   - CEO role assigned at signup/login if username matches CEO_USERNAME env var
 *   - Credits stored on the user record; 40/24h rolling window for free users
 *   - Write mutex: Promise chain prevents concurrent file writes
 *   - Schema validation on load: invalid/duplicate records are repaired + backed up
 */
import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";
import { isPostgresEnabled } from "./systemConfig";
import { pgLoadAllUsers, pgPersistAllUsers } from "./pgUserStore";

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

export const FREE_CREDITS = 7;
export const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const CREDIT_COSTS = {
  chat: 1,
  image_generate: 1,
  image_edit: 1,
  image_analysis: 1,
} as const;

export type CreditFeature = keyof typeof CREDIT_COSTS;

// ── In-memory store ───────────────────────────────────────────────────────────

const store = new Map<string, User>(); // keyed by userId
let saveScheduled = false;

// ── Write mutex — Promise chain prevents concurrent file writes ───────────────

let persistChain: Promise<void> = Promise.resolve();

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

// ── Schema validation ─────────────────────────────────────────────────────────

function isValidUserRecord(u: unknown): u is User {
  if (!u || typeof u !== "object") return false;
  const r = u as Record<string, unknown>;
  return (
    typeof r["id"] === "string" && r["id"].length > 0 &&
    typeof r["username"] === "string" && r["username"].length > 0 &&
    typeof r["passwordHash"] === "string" && (r["passwordHash"] as string).includes(":") &&
    ["free", "premium", "ceo"].includes(r["role"] as string) &&
    typeof r["credits"] === "number" &&
    typeof r["lastReset"] === "number" &&
    typeof r["createdAt"] === "number"
  );
}

// ── Corruption backup ─────────────────────────────────────────────────────────

async function backupCorruptedFile(): Promise<void> {
  try {
    const timestamp = Date.now();
    const backupPath = USERS_FILE.replace(".json", `.corrupt.${timestamp}.json`);
    await fs.copyFile(USERS_FILE, backupPath);
    logger.warn({ backupPath }, "[userStore] backup created");
  } catch (backupErr) {
    logger.error({ backupErr }, "[userStore] Failed to create corruption backup");
  }
}

// ── Atomic persistence with mutex + fsync ─────────────────────────────────────

async function persistStore(): Promise<void> {
  // Chain onto the previous write — guarantees serial execution
  const prev = persistChain;
  let resolveChain!: () => void;
  persistChain = new Promise<void>((r) => { resolveChain = r; });

  try {
    await prev; // wait for any in-progress write to finish

    if (isPostgresEnabled()) {
      try {
        await pgPersistAllUsers(Array.from(store.values()));
        return;
      } catch (pgErr) {
        logger.warn({ pgErr }, "[userStore] PG write failed — JSON fallback");
      }
    }

    // JSON atomic write (primary when PG disabled, fallback when PG fails)
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data = JSON.stringify(Array.from(store.values()), null, 2);
    const tmp = USERS_FILE + ".tmp";

    // Open for write, fsync before rename to guarantee crash safety
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(data, "utf8");
      await fh.datasync(); // flush to disk before rename
    } finally {
      await fh.close();
    }

    await fs.rename(tmp, USERS_FILE);
    logger.info("[userStore] atomic write success");
  } catch (err) {
    logger.error({ err }, "[userStore] Failed to persist");
  } finally {
    resolveChain();
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

// ── Load with schema validation ───────────────────────────────────────────────

export async function loadUserStore(): Promise<void> {
  if (isPostgresEnabled()) {
    try {
      const users = await pgLoadAllUsers();
      for (const u of users) {
        store.set(u.id, u);
      }
      logger.info({ count: store.size }, "[userStore] Loaded from PostgreSQL");
      return;
    } catch (err) {
      logger.error({ err }, "[userStore] PG load failed — JSON fallback");
    }
  }

  let raw: string;
  try {
    raw = await fs.readFile(USERS_FILE, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info("[userStore] No users file — starting fresh");
      return;
    }
    logger.error({ err }, "[userStore] Failed to read users file");
    return;
  }

  // ── Validate JSON ─────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error("[userStore] corruption detected — invalid JSON");
    await backupCorruptedFile();
    return;
  }

  if (!Array.isArray(parsed)) {
    logger.error("[userStore] corruption detected — root is not an array");
    await backupCorruptedFile();
    return;
  }

  // ── Validate individual records ───────────────────────────────────────────
  const valid: User[] = [];
  let invalidCount = 0;
  for (const u of parsed) {
    if (isValidUserRecord(u)) {
      valid.push(u);
    } else {
      invalidCount++;
      logger.warn({ record: JSON.stringify(u).slice(0, 80) }, "[userStore] skipping invalid record");
    }
  }

  // ── Deduplicate by id and username (keep first occurrence) ────────────────
  const seenIds = new Set<string>();
  const seenUsernames = new Set<string>();
  let dupCount = 0;
  for (const u of valid) {
    if (seenIds.has(u.id) || seenUsernames.has(u.username)) {
      logger.warn({ username: u.username }, "[userStore] duplicate detected — skipping");
      dupCount++;
      continue;
    }
    seenIds.add(u.id);
    seenUsernames.add(u.username);
    store.set(u.id, u);
  }

  logger.info(
    { count: store.size, invalid: invalidCount, duplicates: dupCount },
    "[userStore] Loaded users",
  );

  // ── If any corruption found: backup + persist cleaned version ─────────────
  if (invalidCount > 0 || dupCount > 0) {
    logger.warn("[userStore] corruption detected — backing up and repairing");
    await backupCorruptedFile();
    await persistStore();
    logger.info("[userStore] repaired file persisted");
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

// ── CEO admin read-only view ───────────────────────────────────────────────────

export interface AdminUserView {
  id: string;
  username: string;
  role: UserRole;
  credits: number | null; // null = CEO (unlimited)
  createdAt: number;
}

/**
 * Returns all registered users for the CEO admin directory.
 * Password hashes are NEVER included. Read-only snapshot of the in-memory store.
 */
export function getAllUsers(): AdminUserView[] {
  return Array.from(store.values()).map((u) => ({
    id:       u.id,
    username: u.username,
    role:     u.role,
    credits:  u.role === "ceo" ? null : u.credits,
    createdAt: u.createdAt,
  }));
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

  // Apply CEO role at every login — env var may be set after account creation
  if (isCeoUsername(user.username) && user.role !== "ceo") {
    user.role = "ceo";
    scheduleSave();
    logger.info({ username: user.username }, "[userStore] CEO role applied");
  }

  return user;
}

/**
 * authenticateCeoByRecoveryKey()
 *
 * PATH B — zero-lockout CEO recovery.
 * Bypasses password check ONLY when:
 *   1. username matches CEO_USERNAME env var
 *   2. caller has already verified the recovery key matches CEO_RECOVERY_KEY
 *
 * This function NEVER accepts a recovery key itself — that check must be done
 * by the caller (route layer) so the key never enters this module.
 *
 * If the CEO account doesn't exist yet (e.g. fresh deploy), it will be
 * bootstrapped with a placeholder hash; caller should prompt password reset.
 *
 * Normal users: always returns null — no bypass possible.
 */
export function authenticateCeoByRecoveryKey(
  username: string,
): User | null {
  if (!isCeoUsername(username)) {
    logger.warn(
      { username },
      "[userStore] Recovery key used for non-CEO username — rejected",
    );
    return null;
  }

  let user = getUserByUsername(username);

  // Bootstrap CEO if somehow missing (e.g. fresh deploy, corrupted DB)
  if (!user) {
    const placeholder = `recovery-bootstrap-${randomUUID()}`;
    user = {
      id: randomUUID(),
      username: username.trim().toLowerCase(),
      passwordHash: hashPassword(placeholder), // unknown password until set
      role: "ceo",
      credits: FREE_CREDITS,
      lastReset: Date.now(),
      createdAt: Date.now(),
    };
    store.set(user.id, user);
    scheduleSave();
    logger.warn(
      { username },
      "[userStore] CEO bootstrapped via recovery key — set a real password",
    );
  }

  // Always ensure role is ceo regardless of stored value
  if (user.role !== "ceo") {
    user.role = "ceo";
    scheduleSave();
    logger.info({ username }, "[userStore] CEO role corrected via recovery");
  }

  logger.info({ username }, "[userStore] CEO authenticated via recovery key");
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

/**
 * adjustCredits() — add or remove credits from a user (CEO admin action).
 *
 * - CEO users are not modified (they have unlimited credits)
 * - Credits floor at 0 (no negative balances)
 * - Returns the new credit balance (or Infinity for CEO)
 */
export function adjustCredits(userId: string, delta: number): number {
  const user = store.get(userId);
  if (!user) throw new Error(`User not found: ${userId}`);
  if (user.role === "ceo") return Infinity;
  refillIfExpired(user);
  user.credits = Math.max(0, user.credits + delta);
  scheduleSave();
  return user.credits;
}

export function setUserRole(userId: string, role: UserRole): void {
  const user = store.get(userId);
  if (!user) return;
  user.role = role;
  scheduleSave();
}

/**
 * changeUserPassword() — safely update a user's password hash.
 *
 * - Rehashes using scrypt (same algorithm as createUser)
 * - Persists to disk atomically with mutex (no race conditions)
 * - Never stores plaintext
 * - Returns false if user not found or password too short
 */
export async function changeUserPassword(
  userId: string,
  newPassword: string,
): Promise<boolean> {
  const user = store.get(userId);
  if (!user) {
    logger.warn({ userId }, "[userStore] changeUserPassword — user not found");
    return false;
  }
  if (newPassword.length < 6) {
    logger.warn({ userId }, "[userStore] changeUserPassword — password too short");
    return false;
  }
  user.passwordHash = hashPassword(newPassword);
  // Persist immediately and await (not deferred) for password changes
  await persistStore();
  logger.info({ userId, username: user.username }, "[userStore] Password changed");
  return true;
}

// ── CEO account repair ────────────────────────────────────────────────────────

/**
 * repairCeoAccount() — called once at server startup, after loadUserStore().
 *
 * Safe, targeted repair that ONLY touches the CEO account:
 *   1. If CEO_USERNAME is not set → skips entirely (no-op).
 *   2. If CEO account does not exist AND CEO_PASSWORD is set → creates it.
 *   3. If CEO account exists:
 *      - Ensures role === "ceo" (upgrades if it was somehow demoted).
 *      - If CEO_PASSWORD is set → updates password hash (one-time repair).
 *   4. NO other user record is ever read, modified, or deleted.
 *
 * CEO_PASSWORD is consumed safely: it resets the hash, then you can
 * remove the env var — the account will keep working with the new password.
 */
export async function repairCeoAccount(): Promise<void> {
  const ceoUsername = process.env["CEO_USERNAME"]?.trim().toLowerCase();

  if (!ceoUsername) {
    return; // CEO_USERNAME not configured — nothing to repair
  }

  const ceoPassword = process.env["CEO_PASSWORD"]?.trim();
  const existing = getUserByUsername(ceoUsername);

  if (!existing) {
    if (ceoPassword) {
      // CEO account was never created — bootstrap it now
      const user: User = {
        id: randomUUID(),
        username: ceoUsername,
        passwordHash: hashPassword(ceoPassword),
        role: "ceo",
        credits: FREE_CREDITS,
        lastReset: Date.now(),
        createdAt: Date.now(),
      };
      store.set(user.id, user);
      await persistStore();
      logger.info({ username: ceoUsername }, "[ceoRepair] CEO account created");
    } else {
      logger.warn(
        { username: ceoUsername },
        "[ceoRepair] CEO account not found — set CEO_PASSWORD env var to create it",
      );
    }
    return;
  }

  // CEO account exists — apply targeted repairs only
  let changed = false;

  if (existing.role !== "ceo") {
    existing.role = "ceo";
    changed = true;
    logger.info({ username: ceoUsername }, "[ceoRepair] CEO role corrected");
  }

  if (ceoPassword) {
    existing.passwordHash = hashPassword(ceoPassword);
    changed = true;
    logger.info(
      { username: ceoUsername },
      "[ceoRepair] CEO password hash updated (remove CEO_PASSWORD env var after successful login)",
    );
  }

  if (changed) {
    await persistStore();
  }

  logger.info(
    { username: ceoUsername, role: existing.role },
    "[ceoRepair] CEO account verified OK",
  );
}
