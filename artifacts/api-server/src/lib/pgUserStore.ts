/**
 * pgUserStore — PostgreSQL adapter for user persistence.
 *
 * Provides load and persist operations that mirror the JSON userStore API.
 * Called only when USE_POSTGRES_STORAGE=true.
 *
 * Uses the in-memory Map in userStore.ts as the read cache — only the
 * persistence layer (load at boot, save on mutation) goes through PG.
 */
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
          username:     user.username,
          passwordHash: user.passwordHash,
          role:         user.role,
          credits:      user.credits,
          lastReset:    user.lastReset,
        },
      });
  }

  logger.info({ count: users.length }, "[pgUserStore] Users upserted to PostgreSQL");
}
