/**
 * pgUserStore — PostgreSQL adapter for user persistence.
 *
 * Provides load and persist operations that mirror the JSON userStore API.
 * Called only when USE_POSTGRES_STORAGE=true.
 *
 * Uses the in-memory Map in userStore.ts as the read cache — only the
 * persistence layer (load at boot, save on mutation) goes through PG.
 */
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "./logger";

type UserRole = "free" | "premium" | "ceo";

export interface PgUserRecord {
  id:           string;
  username:     string;
  passwordHash: string;
  role:         UserRole;
  credits:      number;
  lastReset:    number;
  createdAt:    number;
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function pgLoadAllUsers(): Promise<PgUserRecord[]> {
  const rows = await db.select().from(usersTable);
  return rows.map((r) => ({
    id:           r.id,
    username:     r.username,
    passwordHash: r.passwordHash,
    role:         r.role,
    credits:      r.credits,
    lastReset:    r.lastReset,
    createdAt:    r.createdAt,
  }));
}

// ── Persist ───────────────────────────────────────────────────────────────────

/**
 * Upsert all users in memory to PostgreSQL.
 * Equivalent to the JSON "write full file" strategy — atomic at the row level
 * via ON CONFLICT DO UPDATE.
 */
export async function pgPersistAllUsers(users: PgUserRecord[]): Promise<void> {
  if (users.length === 0) return;

  for (const user of users) {
    await db
      .insert(usersTable)
      .values({
        id:           user.id,
        username:     user.username,
        passwordHash: user.passwordHash,
        role:         user.role,
        credits:      user.credits,
        lastReset:    user.lastReset,
        createdAt:    user.createdAt,
      })
      .onConflictDoUpdate({
        target: usersTable.id,
        set: {
          // password_hash is intentionally excluded from the conflict update.
          // All password changes must go through pgUpdatePasswordHashOnly() so that
          // a bulk upsert (e.g. triggered by a new user registering) can NEVER
          // silently revert a password that was written via a direct DB update.
          username:  user.username,
          role:      user.role,
          credits:   user.credits,
          lastReset: user.lastReset,
        },
      });
  }

  logger.info({ count: users.length }, "[pgUserStore] Users upserted to PostgreSQL (passwordHash excluded from conflict update)");
}

// ── Single-user fetch by userId (fresh DB read — used by session hydration) ───

/**
 * pgGetUserById() — fetch one user row directly from PostgreSQL by primary key.
 *
 * Used by getUserByIdFromDb() so that every identity-bearing route
 * (GET /me, credit checks, policy engine) always reads live DB state.
 *
 * Returns null if the user does not exist in the DB.
 */
export async function pgGetUserById(userId: string): Promise<PgUserRecord | null> {
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id:           r.id,
    username:     r.username,
    passwordHash: r.passwordHash,
    role:         r.role,
    credits:      r.credits,
    lastReset:    r.lastReset,
    createdAt:    r.createdAt,
  };
}

// ── Single-field update: password_hash only ───────────────────────────────────

/**
 * pgUpdatePasswordHashOnly() — update ONLY the password_hash column for one user.
 *
 * No other column is touched.  Memory store is intentionally NOT updated —
 * PostgreSQL is the single source of truth for credentials.
 *
 * The caller must verify the user exists before calling this function.
 */
export async function pgUpdatePasswordHashOnly(
  userId:       string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, userId));
  logger.info(
    { userId },
    "[pgUserStore] password_hash updated (PostgreSQL only — memory not mutated)",
  );
}

// ── Single-user fetch by username (fresh DB read — used by auth flow) ─────────

/**
 * pgGetUserByUsername() — fetch one user row directly from PostgreSQL by username.
 *
 * Used by authenticateUserFromDb() to guarantee the password_hash used for
 * verification is always the live DB value, never a stale in-memory copy.
 *
 * Returns null if the user does not exist in the DB.
 */
export async function pgGetUserByUsername(username: string): Promise<PgUserRecord | null> {
  const normalized = username.trim().toLowerCase();
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, normalized))
    .limit(1);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id:           r.id,
    username:     r.username,
    passwordHash: r.passwordHash,
    role:         r.role,
    credits:      r.credits,
    lastReset:    r.lastReset,
    createdAt:    r.createdAt,
  };
}
