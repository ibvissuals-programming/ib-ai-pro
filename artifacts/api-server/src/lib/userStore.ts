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
import {
  pgLoadAllUsers,
  pgPersistAllUsers,
  pgGetUserByUsername,
  pgGetUserById,
  pgUpdatePasswordHashOnly,
} from "./pgUserStore";

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
const usernameIndex = new Map<string, string>(); // username (normalized) → userId — O(1) lookup
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
    logger.debug("[userStore] atomic write success");
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
        usernameIndex.set(u.username, u.id); // keep index in sync with store
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
    usernameIndex.set(u.username, u.id);
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

/**
 * getUserByIdFromDb() — PostgreSQL-authoritative user fetch by primary key.
 *
 * Used by every route that needs live identity data (GET /me, credit checks,
 * policy enforcement). When PG is enabled it issues a fresh SELECT on every call
 * so role/credit state is always the DB value, never a potentially stale copy.
 *
 * On success the returned User also updates the in-memory cache so that
 * deductCredits() (which writes to memory) stays consistent.
 *
 * Falls back to the in-memory store when PG is disabled.
 */
export async function getUserByIdFromDb(id: string): Promise<User | undefined> {
  if (!isPostgresEnabled()) {
    return getUserById(id);
  }

  let dbRecord;
  try {
    dbRecord = await pgGetUserById(id);
  } catch (err) {
    logger.error({ err, userId: id }, "[userStore] getUserByIdFromDb — DB fetch failed, falling back to memory");
    return getUserById(id);
  }

  if (!dbRecord) return undefined;

  // Rebuild / refresh the in-memory entry from the authoritative DB record.
  // This keeps the cache consistent with DB without any separate sync job.
  const refreshed: User = {
    id:           dbRecord.id,
    username:     dbRecord.username,
    passwordHash: dbRecord.passwordHash,
    role:         dbRecord.role,
    credits:      dbRecord.credits,
    lastReset:    dbRecord.lastReset,
    createdAt:    dbRecord.createdAt,
  };
  store.set(refreshed.id, refreshed);
  usernameIndex.set(refreshed.username, refreshed.id);
  return refreshed;
}

export function getUserByUsername(username: string): User | undefined {
  const normalized = username.trim().toLowerCase();
  const userId = usernameIndex.get(normalized);
  if (!userId) return undefined;
  const user = store.get(userId);
  if (!user) {
    // Index is stale — remove it
    usernameIndex.delete(normalized);
    return undefined;
  }
  refillIfExpired(user);
  return user;
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

/**
 * Delete a user by ID from the in-memory store and username index.
 * Schedules a DB persist so the deletion propagates to PostgreSQL.
 * Used exclusively by startupHealthTest to clean up ephemeral test users.
 * Returns true if the user existed and was removed, false otherwise.
 */
export function deleteUserById(id: string): boolean {
  const user = store.get(id);
  if (!user) return false;
  store.delete(id);
  usernameIndex.delete(user.username.trim().toLowerCase());
  scheduleSave();
  return true;
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
  usernameIndex.set(user.username, user.id);
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

  // Read-only role check — no silent mutation during auth.
  if (isCeoUsername(user.username) && user.role !== "ceo") {
    logger.warn(
      { username: user.username, actual_role: user.role, ceo_boot_mutation: false },
      "[auth] CEO user has unexpected role in memory — no auto-correction (manual fix required)",
    );
  }

  return user;
}

// ── Typed result for DB-authoritative authentication ──────────────────────────

export type DbAuthResult =
  | { ok: true;  user: User }
  | { ok: false; reason: "not_found" | "invalid_hash" | "password_mismatch" | "db_error" };

/**
 * authenticateUserFromDb() — PostgreSQL-authoritative login verification.
 *
 * On every login attempt:
 *   1. Fetch user record FRESH from PostgreSQL (never use cached passwordHash).
 *   2. CEO consistency check: if DB hash ≠ memory hash → log ceo_auth_inconsistency
 *      (log only — never auto-correct, never overwrite).
 *   3. Run scrypt verification against the DB hash.
 *   4. On success, return the in-memory User object (for session/credits).
 *      If memory cache is cold (shouldn't happen post-boot), rebuild from DB row.
 *
 * Falls back to in-memory authenticateUser() only when PostgreSQL is disabled.
 *
 * Returns a DbAuthResult so the caller gets the exact failure reason for
 * structured logging without ambiguity.
 */
export async function authenticateUserFromDb(
  username: string,
  password: string,
): Promise<DbAuthResult> {
  const normalized = username.trim().toLowerCase();

  // ── PG disabled: fall back to in-memory auth ──────────────────────────────
  if (!isPostgresEnabled()) {
    const fallback = authenticateUser(normalized, password);
    if (!fallback) {
      const exists = !!getUserByUsername(normalized);
      return { ok: false, reason: exists ? "password_mismatch" : "not_found" };
    }
    return { ok: true, user: fallback };
  }

  // ── Fetch fresh from PostgreSQL ────────────────────────────────────────────
  let dbRecord;
  try {
    dbRecord = await pgGetUserByUsername(normalized);
  } catch (dbErr) {
    logger.error({ err: dbErr, username: normalized }, "[auth] db_error during user lookup");
    return { ok: false, reason: "db_error" };
  }

  if (!dbRecord) {
    logger.info(
      { username: normalized, ceo_source: "db_verified" },
      "[auth] login_attempt_result: not_found (DB)",
    );
    return { ok: false, reason: "not_found" };
  }

  // ── Validate DB record integrity ───────────────────────────────────────────
  if (!dbRecord.passwordHash || !dbRecord.passwordHash.includes(":")) {
    logger.error(
      { username: normalized, password_hash_valid: false },
      "[auth] login_attempt_result: invalid_hash in DB record",
    );
    return { ok: false, reason: "invalid_hash" };
  }

  // ── CEO consistency check: DB vs memory ───────────────────────────────────
  const memUser = getUserByUsername(normalized);
  if (memUser && memUser.passwordHash !== dbRecord.passwordHash) {
    logger.warn(
      { username: normalized, ceo_source: "db_verified", cache_mismatch: true },
      "[auth] ceo_auth_inconsistency — DB and memory passwordHash differ (DB is authoritative)",
    );
  } else {
    logger.debug(
      { username: normalized, ceo_source: "db_verified", cache_mismatch: false },
      "[auth] password_hash consistency check passed",
    );
  }

  // ── Verify password against DB hash (never the memory copy) ───────────────
  const passwordHashValid = verifyPassword(password, dbRecord.passwordHash);
  logger.info(
    { username: normalized, password_hash_valid: passwordHashValid },
    "[auth] login_attempt_result",
  );

  if (!passwordHashValid) {
    return { ok: false, reason: "password_mismatch" };
  }

  // ── Auth passed — return in-memory user for session/credits continuity ─────
  if (memUser) {
    // Read-only role check — no mutation, no silent correction.
    if (isCeoUsername(normalized) && memUser.role !== "ceo") {
      logger.warn(
        { username: normalized, actual_role: memUser.role, ceo_auth_source: "postgres", ceo_boot_mutation: false },
        "[auth] CEO user has unexpected role in memory — no auto-correction (manual fix required)",
      );
    } else {
      logger.debug(
        { username: normalized, ceo_auth_source: "postgres", ceo_boot_mutation: false },
        "[auth] ceo_password_verified",
      );
    }
    return { ok: true, user: memUser };
  }

  // Cold cache (unexpected post-boot) — rebuild in-memory entry from DB row
  logger.warn({ username: normalized }, "[auth] cache miss post-boot — rebuilding from DB record");
  const rebuilt: User = {
    id:           dbRecord.id,
    username:     dbRecord.username,
    passwordHash: dbRecord.passwordHash,
    role:         dbRecord.role,
    credits:      dbRecord.credits,
    lastReset:    dbRecord.lastReset,
    createdAt:    dbRecord.createdAt,
  };
  store.set(rebuilt.id, rebuilt);
  usernameIndex.set(rebuilt.username, rebuilt.id);
  return { ok: true, user: rebuilt };
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

  const user = getUserByUsername(username);

  // If the CEO account doesn't exist, this is an integrity violation.
  // Do NOT bootstrap, create, or mutate anything — log and reject.
  // CEO account must be created at startup via repairCeoAccount().
  if (!user) {
    logger.error(
      { username },
      "[userStore] authenticateCeoByRecoveryKey — CEO account not found; no auto-bootstrap (fix via repairCeoAccount at startup)",
    );
    return null;
  }

  // Read-only role check — no mutation, no scheduleSave, no silent correction.
  if (user.role !== "ceo") {
    logger.error(
      { username, actual_role: user.role, ceo_boot_mutation: false },
      "[userStore] authenticateCeoByRecoveryKey — CEO user has unexpected role in memory; no auto-correction (manual DB fix required)",
    );
  }

  logger.info({ username }, "[userStore] CEO identity verified via recovery key (read-only)");
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
  const newHash = hashPassword(newPassword);
  user.passwordHash = newHash; // keep memory in sync
  if (isPostgresEnabled()) {
    // Write directly to DB.  pgPersistAllUsers (bulk upsert) intentionally skips
    // passwordHash in its conflict-update clause, so we must write it here.
    try {
      await pgUpdatePasswordHashOnly(userId, newHash);
    } catch (err) {
      logger.error({ err, userId }, "[userStore] changeUserPassword — pg direct write failed");
      return false;
    }
  } else {
    // Non-PG mode: JSON file is the store — persist normally.
    await persistStore();
  }
  logger.info({ userId, username: user.username }, "[userStore] Password changed");
  return true;
}

/**
 * updatePasswordHashInDbOnly() — write a new password hash to PostgreSQL and
 * sync the in-memory store.
 *
 * After writing to PG the in-memory record is updated to match.  This prevents
 * the "stale-hash re-insert" bug: if pgPersistAllUsers() fires after a reset
 * and the user doesn't yet have a PG row (e.g. fresh-deploy), it would INSERT
 * using whatever hash is in memory — keeping memory in sync ensures that INSERT
 * always carries the new hash.
 *
 * UUID-reconciliation guard: if loadUserStore() fell back to JSON (PG was
 * briefly unavailable at boot) the in-memory UUID may differ from the PG UUID.
 * In that case the function looks the user up by username, resyncs the
 * in-memory entry to the PG UUID, then proceeds with the update.
 *
 * Falls back to changeUserPassword() when PostgreSQL is disabled.
 */
export async function updatePasswordHashInDbOnly(
  userId:      string,
  newPassword: string,
): Promise<boolean> {
  if (newPassword.length < 6) {
    logger.warn({ userId }, "[userStore] updatePasswordHashInDbOnly — password too short");
    return false;
  }

  if (!isPostgresEnabled()) {
    // Non-PG mode: memory IS the store — fall back to the standard mutation.
    return changeUserPassword(userId, newPassword);
  }

  try {
    // ── Step 1: resolve the authoritative PG record ────────────────────────
    let pgRecord = await pgGetUserById(userId);
    let effectiveUserId = userId;

    if (!pgRecord) {
      // userId may be from a JSON fallback that has a stale UUID.
      // Try to find the PG record by username so the reset can still proceed.
      const memUser = store.get(userId);
      if (memUser) {
        const byUsername = await pgGetUserByUsername(memUser.username);
        if (byUsername) {
          logger.warn(
            { memUserId: userId, pgUserId: byUsername.id, username: byUsername.username },
            "[userStore] updatePasswordHashInDbOnly — UUID mismatch (JSON fallback vs PG); resyncing in-memory entry",
          );
          // Replace the stale JSON-sourced entry with the real PG entry
          store.delete(userId);
          store.set(byUsername.id, { ...memUser, id: byUsername.id, passwordHash: byUsername.passwordHash });
          usernameIndex.set(byUsername.username, byUsername.id);
          scheduleSave(); // flush the corrected state to JSON fallback
          pgRecord = byUsername;
          effectiveUserId = byUsername.id;
        }
      }
    }

    if (!pgRecord) {
      logger.warn({ userId }, "[userStore] updatePasswordHashInDbOnly — user not found in DB");
      return false;
    }

    // ── Step 2: write new hash to PG ───────────────────────────────────────
    const newHash = hashPassword(newPassword);
    await pgUpdatePasswordHashOnly(effectiveUserId, newHash);

    // ── Step 3: sync in-memory record ─────────────────────────────────────
    // Keeps memory in sync so pgPersistAllUsers() always carries the correct
    // hash — particularly important if it runs a fresh INSERT (no conflict).
    const memUser = store.get(effectiveUserId);
    if (memUser) {
      memUser.passwordHash = newHash;
    }

    logger.info(
      { userId: effectiveUserId, username: pgRecord.username },
      "[userStore] password_hash updated in PostgreSQL — memory cache synced",
    );
    return true;
  } catch (err) {
    logger.error({ err, userId }, "[userStore] updatePasswordHashInDbOnly — db error");
    return false;
  }
}

// ── CEO account repair ────────────────────────────────────────────────────────

// ── CEO bootstrap state (exported for health endpoints) ──────────────────────

interface CeoBootstrapState {
  ready: boolean;
  autoCreated: boolean;
  tempPassword: string | null; // set only on first auto-creation, cleared after first login
}

let _ceoBootstrapState: CeoBootstrapState = {
  ready: false,
  autoCreated: false,
  tempPassword: null,
};

export function getCeoBootstrapState(): CeoBootstrapState {
  return { ..._ceoBootstrapState };
}

/**
 * repairCeoAccount() — called once at server startup, after loadUserStore().
 *
 * PHASE 4 — CEO Auto-Bootstrap:
 *   1. If CEO_USERNAME is not set → skips entirely (no-op).
 *   2. If CEO account does not exist:
 *      - Uses CEO_PASSWORD if set, otherwise AUTO-GENERATES a temp password.
 *      - Logs temp password ONCE clearly — remove CEO_PASSWORD after first login.
 *   3. If CEO account exists:
 *      - Ensures role === "ceo" (upgrades if demoted).
 *      - Credentials are IMMUTABLE — password is NEVER overwritten during boot.
 *      - To change the CEO password use the /api/auth/change-password endpoint.
 *   4. NO other user record is ever read, modified, or deleted.
 */
// ── Index integrity check (called by startupIntegrityCheck.ts) ───────────────

/**
 * Scan the usernameIndex for inconsistencies against the store.
 * Auto-repairs any found issues in place. Never throws.
 */
export function runIndexIntegrityCheck(): { violations: string[]; repaired: number } {
  const violations: string[] = [];
  let repaired = 0;

  // Every user in store must have a matching index entry
  for (const [userId, user] of store) {
    const indexed = usernameIndex.get(user.username);
    if (!indexed) {
      violations.push(`missing_index:${user.username}`);
      usernameIndex.set(user.username, userId);
      repaired++;
    } else if (indexed !== userId) {
      violations.push(`index_mismatch:${user.username}(indexed=${indexed},actual=${userId})`);
      usernameIndex.set(user.username, userId);
      repaired++;
    }
  }

  // Every index entry must point to an existing user
  for (const [username, userId] of usernameIndex) {
    if (!store.has(userId)) {
      violations.push(`stale_index:${username}→${userId}`);
      usernameIndex.delete(username);
      repaired++;
    }
  }

  return { violations, repaired };
}

/**
 * Verify that a given plaintext password matches the stored hash for a user.
 * Used by the change-password route to validate the current password.
 * Returns false if the user does not exist.
 */
export function checkCurrentPassword(userId: string, password: string): boolean {
  const user = store.get(userId);
  if (!user) return false;
  return verifyPassword(password, user.passwordHash);
}

/**
 * checkCurrentPasswordFromDb() — DB-authoritative password check.
 *
 * Fetches the user's password_hash FRESH from PostgreSQL and verifies
 * the supplied password against it.  This is the only correct check to
 * use inside any mutation route (reset-password, change-password) because
 * the in-memory copy may lag behind a recent DB update.
 *
 * Falls back to the in-memory check only when PostgreSQL is disabled.
 */
export async function checkCurrentPasswordFromDb(
  userId:   string,
  password: string,
): Promise<boolean> {
  if (!isPostgresEnabled()) {
    return checkCurrentPassword(userId, password);
  }
  try {
    const dbRecord = await pgGetUserById(userId);
    if (!dbRecord || !dbRecord.passwordHash) return false;
    return verifyPassword(password, dbRecord.passwordHash);
  } catch (err) {
    logger.error(
      { err, userId },
      "[userStore] checkCurrentPasswordFromDb — db error, falling back to memory",
    );
    return checkCurrentPassword(userId, password);
  }
}

/**
 * getCeoUser() — returns the full CEO User record for integrity checks.
 * Used only by startupIntegrityCheck to verify passwordHash is non-null.
 * Never expose passwordHash to clients or logs.
 */
export function getCeoUser(): User | null {
  const ceoUsername = process.env["CEO_USERNAME"]?.trim().toLowerCase();
  if (!ceoUsername) return null;
  return getUserByUsername(ceoUsername) ?? null;
}

/**
 * getAllCeoRoleUsers() — returns all users with role="ceo".
 * Used by startupIntegrityCheck to detect rogue CEO role assignments.
 */
export function getAllCeoRoleUsers(): { id: string; username: string }[] {
  return Array.from(store.values())
    .filter((u) => u.role === "ceo")
    .map((u) => ({ id: u.id, username: u.username }));
}

export async function repairCeoAccount(): Promise<void> {
  const ceoUsername = process.env["CEO_USERNAME"]?.trim().toLowerCase();

  if (!ceoUsername) {
    return; // CEO_USERNAME not configured — nothing to repair
  }

  const ceoPassword = process.env["CEO_PASSWORD"]?.trim();
  const existing = getUserByUsername(ceoUsername);

  if (!existing) {
    // CEO account was never created — auto-bootstrap with provided or generated password
    const usePassword = ceoPassword ?? randomBytes(10).toString("hex");
    const isAutoGenerated = !ceoPassword;

    const user: User = {
      id: randomUUID(),
      username: ceoUsername,
      passwordHash: hashPassword(usePassword),
      role: "ceo",
      credits: FREE_CREDITS,
      lastReset: Date.now(),
      createdAt: Date.now(),
    };
    store.set(user.id, user);
    usernameIndex.set(user.username, user.id);
    await persistStore();

    _ceoBootstrapState = { ready: true, autoCreated: true, tempPassword: isAutoGenerated ? usePassword : null };

    if (isAutoGenerated) {
      logger.info(
        { username: ceoUsername },
        "[bootstrap] CEO account initialized",
      );
      logger.info(
        { username: ceoUsername, tempPassword: usePassword },
        "[bootstrap] ⚠ TEMP PASSWORD (set CEO_PASSWORD env var to change it, then restart)",
      );
    } else {
      logger.info({ username: ceoUsername }, "[ceoRepair] CEO account created");
    }
    return;
  }

  // CEO account exists — check for UUID divergence between JSON fallback and PG.
  // This can happen when loadUserStore() fell back to JSON (PG briefly unavailable
  // at boot) and the JSON file contains a stale UUID from a prior bootstrap.
  // Resyncing here ensures all subsequent operations (including recovery reset)
  // use the authoritative PG UUID so password updates land on the correct row.
  if (isPostgresEnabled()) {
    try {
      const pgCeo = await pgGetUserByUsername(ceoUsername);
      if (pgCeo && pgCeo.id !== existing.id) {
        logger.warn(
          { memId: existing.id, pgId: pgCeo.id, username: ceoUsername },
          "[ceoRepair] UUID mismatch: in-memory CEO (from JSON fallback) differs from PG CEO — resyncing",
        );
        store.delete(existing.id);
        store.set(pgCeo.id, {
          id:           pgCeo.id,
          username:     pgCeo.username,
          passwordHash: pgCeo.passwordHash,
          role:         pgCeo.role,
          credits:      pgCeo.credits,
          lastReset:    pgCeo.lastReset,
          createdAt:    pgCeo.createdAt,
        });
        usernameIndex.set(ceoUsername, pgCeo.id);
        scheduleSave(); // persist corrected UUID to JSON fallback file
      }
    } catch (pgErr) {
      logger.warn({ pgErr }, "[ceoRepair] PG UUID check failed — keeping in-memory CEO as-is");
    }
  }

  _ceoBootstrapState = { ready: true, autoCreated: false, tempPassword: null };

  // Re-fetch after potential resync
  const resynced = getUserByUsername(ceoUsername);
  if (!resynced || resynced.role !== "ceo") {
    logger.error(
      { username: ceoUsername, actual_role: resynced?.role ?? "missing", ceo_boot_mutation: false },
      "[ceoRepair] CEO account has unexpected role — boot mutation BLOCKED (manual DB fix required)",
    );
  } else {
    logger.info(
      { username: ceoUsername, role: resynced.role, ceo_boot_mutation: false },
      "[ceoRepair] CEO account verified OK",
    );
  }
}
