/**
 * migrateToPg — one-time idempotent migration: JSON files → PostgreSQL.
 *
 * Reads users.json and image-history.json from the data/ directory and
 * upserts every record into PostgreSQL. Safe to run multiple times
 * (ON CONFLICT DO NOTHING for history, ON CONFLICT DO UPDATE for users).
 *
 * Run via:
 *   cd artifacts/api-server
 *   npx tsx src/scripts/migrateToPg.ts
 *
 * Pre-flight: DATABASE_URL must be set. The target tables must already exist
 * (run `pnpm --filter @workspace/db run push` first).
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, usersTable, imageHistoryTable } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, "../../../data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const HIST_FILE  = path.join(DATA_DIR, "image-history.json");

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readJsonFile<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`  [skip] ${filePath} not found — nothing to migrate`);
      return [];
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    console.warn(`  [warn] ${filePath} is not an array — skipping`);
    return [];
  }
  return parsed as T[];
}

// ── Users ─────────────────────────────────────────────────────────────────────

interface JsonUser {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  credits: number;
  lastReset: number;
  createdAt: number;
}

async function migrateUsers(): Promise<void> {
  console.log("\n── Users ────────────────────────────────────");
  const users = await readJsonFile<JsonUser>(USERS_FILE);
  if (users.length === 0) { console.log("  No users to migrate."); return; }

  let ok = 0; let skip = 0; let fail = 0;
  for (const u of users) {
    if (!u.id || !u.username || !u.passwordHash) { skip++; continue; }
    try {
      await db
        .insert(usersTable)
        .values({
          id:           u.id,
          username:     u.username,
          passwordHash: u.passwordHash,
          role:         (u.role as "free" | "premium" | "ceo") ?? "free",
          credits:      u.credits   ?? 7,
          lastReset:    u.lastReset ?? Date.now(),
          createdAt:    u.createdAt ?? Date.now(),
        })
        .onConflictDoUpdate({
          target: usersTable.id,
          set: {
            username:     u.username,
            passwordHash: u.passwordHash,
            role:         (u.role as "free" | "premium" | "ceo") ?? "free",
            credits:      u.credits ?? 7,
            lastReset:    u.lastReset ?? Date.now(),
          },
        });
      ok++;
    } catch (err) {
      console.error(`  [error] user ${u.username}:`, (err as Error).message);
      fail++;
    }
  }
  console.log(`  Migrated: ${ok} ok, ${skip} skipped, ${fail} failed (of ${users.length} total)`);
}

// ── Image History ─────────────────────────────────────────────────────────────

interface JsonHistory {
  id: string;
  userId: string;
  type: "generate" | "edit";
  prompt: string;
  mode: string;
  intensity: string;
  timestamp: number;
  imageFile: string;
  mimeType: string;
  complexity?: string;
  contractVersionUsed?: string;
  model?: string;
  status?: string;
  retryCount?: number;
  latencyMs?: number;
}

async function migrateHistory(): Promise<void> {
  console.log("\n── Image History ────────────────────────────");
  const entries = await readJsonFile<JsonHistory>(HIST_FILE);
  if (entries.length === 0) { console.log("  No history to migrate."); return; }

  let ok = 0; let skip = 0; let fail = 0;
  for (const e of entries) {
    if (!e.id || !e.userId || !e.imageFile) { skip++; continue; }
    try {
      await db
        .insert(imageHistoryTable)
        .values({
          id:                  e.id,
          userId:              e.userId,
          type:                e.type ?? "generate",
          prompt:              e.prompt ?? "",
          mode:                e.mode ?? "standard",
          intensity:           e.intensity ?? "normal",
          timestamp:           e.timestamp ?? Date.now(),
          imageFile:           e.imageFile,
          mimeType:            e.mimeType ?? "image/jpeg",
          complexity:          e.complexity          ?? null,
          contractVersionUsed: e.contractVersionUsed ?? null,
          model:               e.model               ?? null,
          status:              e.status              ?? null,
          retryCount:          e.retryCount          ?? null,
          latencyMs:           e.latencyMs           ?? null,
        })
        .onConflictDoNothing();
      ok++;
    } catch (err) {
      console.error(`  [error] entry ${e.id}:`, (err as Error).message);
      fail++;
    }
  }
  console.log(`  Migrated: ${ok} ok, ${skip} skipped, ${fail} failed (of ${entries.length} total)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("IB AI — PostgreSQL Migration");
  console.log("============================");
  if (!process.env["DATABASE_URL"]) {
    console.error("DATABASE_URL not set — aborting");
    process.exit(1);
  }

  await migrateUsers();
  await migrateHistory();

  console.log("\n✓ Migration complete. Set USE_POSTGRES_STORAGE=true to activate PG mode.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
