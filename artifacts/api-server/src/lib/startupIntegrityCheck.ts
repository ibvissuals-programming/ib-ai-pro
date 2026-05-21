/**
 * startupIntegrityCheck.ts — Silent startup integrity verification.
 *
 * Called once after loadUserStore() + repairCeoAccount() completes.
 * Never throws — all issues are logged as SYSTEM_INVARIANT_VIOLATION.
 *
 * Checks:
 *   1. In-memory usernameIndex is fully synchronized with the user store
 *   2. No duplicate usernames exist in the store
 *   3. CEO account exists exactly once with the correct role
 *   4. If PG is enabled, all PG users are reflected in the in-memory store
 *
 * Auto-repairs:
 *   - Missing or stale index entries are rebuilt from the store
 *   - Duplicate index entries pointing to wrong user are corrected
 */
import { logger } from "./logger";
import { logInvariantViolation } from "./invariant";
import { pgLoadAllUsers } from "./pgUserStore";
import { isPostgresEnabled } from "./systemConfig";
import { getAllUsers, runIndexIntegrityCheck } from "./userStore";
import { emit } from "./eventBus";

export interface IntegrityCheckResult {
  passed:           boolean;
  violations:       string[];
  repaired:         number;
  ceoVerified:      boolean;
  userCount:        number;
  pgUserCount:      number | null;
  duplicatesFound:  number;
}

export async function runStartupIntegrityCheck(): Promise<IntegrityCheckResult> {
  const violations: string[] = [];
  let repaired         = 0;
  let duplicatesFound  = 0;
  let ceoVerified      = false;
  let pgUserCount: number | null = null;

  // ── Step 1: In-memory index integrity ────────────────────────────────────────
  const indexResult = runIndexIntegrityCheck();
  violations.push(...indexResult.violations);
  repaired += indexResult.repaired;

  // ── Step 2: Duplicate username scan in memory ─────────────────────────────────
  const allUsers = getAllUsers();
  const usernameCounts = new Map<string, number>();
  for (const u of allUsers) {
    usernameCounts.set(u.username, (usernameCounts.get(u.username) ?? 0) + 1);
  }
  for (const [username, count] of usernameCounts) {
    if (count > 1) {
      logInvariantViolation(
        `Duplicate username in in-memory store: "${username}" (${count} entries)`,
        { username, count },
      );
      violations.push(`duplicate_username_in_memory:${username}`);
      duplicatesFound += count - 1;
    }
  }

  // ── Step 3: CEO account verification ──────────────────────────────────────────
  const ceoUsername = process.env["CEO_USERNAME"]?.trim().toLowerCase();
  if (ceoUsername) {
    const ceoEntries = allUsers.filter((u) => u.username === ceoUsername);
    if (ceoEntries.length === 0) {
      logInvariantViolation(
        `CEO account "${ceoUsername}" not found in store after startup`,
        { ceoUsername },
      );
      violations.push(`ceo_missing`);
    } else if (ceoEntries.length > 1) {
      logInvariantViolation(
        `CEO account "${ceoUsername}" has ${ceoEntries.length} duplicate entries`,
        { ceoUsername, count: ceoEntries.length },
      );
      violations.push(`ceo_duplicate:${ceoEntries.length}`);
      duplicatesFound += ceoEntries.length - 1;
    } else {
      const ceo = ceoEntries[0];
      if (ceo.role !== "ceo") {
        logInvariantViolation(
          `CEO user "${ceoUsername}" has wrong role: "${ceo.role}" (expected "ceo")`,
          { ceoUsername, role: ceo.role },
        );
        violations.push(`ceo_wrong_role:${ceo.role}`);
      } else {
        ceoVerified = true;
      }
    }
  }

  // ── Step 4: PostgreSQL cross-check ───────────────────────────────────────────
  if (isPostgresEnabled()) {
    try {
      const pgUsers = await pgLoadAllUsers();
      pgUserCount = pgUsers.length;

      // Every PG user must be reflected in memory
      const inMemoryIds = new Set(allUsers.map((u) => u.id));
      for (const pgUser of pgUsers) {
        if (!inMemoryIds.has(pgUser.id)) {
          logInvariantViolation(
            `PG user "${pgUser.username}" (${pgUser.id}) is not in the in-memory store`,
            { pgUserId: pgUser.id, username: pgUser.username },
          );
          violations.push(`pg_user_missing_from_memory:${pgUser.username}`);
        }
      }

      // No duplicate usernames in PG
      const pgUsernameCounts = new Map<string, number>();
      for (const u of pgUsers) {
        pgUsernameCounts.set(u.username, (pgUsernameCounts.get(u.username) ?? 0) + 1);
      }
      for (const [username, count] of pgUsernameCounts) {
        if (count > 1) {
          logInvariantViolation(
            `Duplicate username in PostgreSQL: "${username}" (${count} rows)`,
            { username, count },
          );
          violations.push(`pg_duplicate_username:${username}`);
          duplicatesFound += count - 1;
        }
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[integrity] PG cross-check skipped — could not load PG users (non-fatal)",
      );
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────────
  const passed    = violations.length === 0;
  const userCount = allUsers.length;

  if (passed) {
    logger.info(
      { userCount, pgUserCount, ceoVerified },
      "[integrity] Startup integrity check passed",
    );
  } else {
    logger.warn(
      { violations: violations.length, repaired, duplicatesFound, userCount, pgUserCount },
      "[integrity] Startup integrity check completed with violations — see SYSTEM_INVARIANT_VIOLATION logs above",
    );
  }

  emit({
    eventType: "startup_integrity_check",
    source:    "startupIntegrityCheck",
    action:    "startup_check",
    status:    passed ? "success" : "failure",
    metadata:  { userCount, pgUserCount, ceoVerified, violations: violations.length, repaired, duplicatesFound },
  });

  return { passed, violations, repaired, ceoVerified, userCount, pgUserCount, duplicatesFound };
}
