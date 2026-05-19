/**
 * adminActionLog — CEO admin control action audit log.
 *
 * Separate from auditLog.ts (which tracks user activity events).
 * This module logs admin-initiated control actions:
 *   storage mode changes, migrations, user role/credit adjustments, etc.
 *
 * Primary store: PostgreSQL admin_logs table (when PG mode is active).
 * Fallback:      in-memory ring buffer, max 500 entries.
 */
import { logger } from "./logger";
import { isPostgresEnabled } from "./systemConfig";

export type AdminAction =
  | "storage_mode_change"
  | "migration_start"
  | "migration_complete"
  | "migration_failed"
  | "user_role_change"
  | "user_credit_adjust"
  | "system_config_change"
  | "admin_error";

export interface AdminActionEntry {
  id:        number;
  action:    AdminAction | string;
  actor:     string;           // username of the acting CEO
  timestamp: number;
  details:   Record<string, unknown>;
}

const MAX_ENTRIES = 500;
const _log: AdminActionEntry[] = [];
let   _seq = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record an admin control action. Never throws.
 * Writes to in-memory ring buffer always; also writes to PG when enabled.
 */
export async function logAdminAction(
  action:  AdminAction | string,
  actor:   string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const entry: AdminActionEntry = {
    id:        ++_seq,
    action,
    actor,
    timestamp: Date.now(),
    details,
  };

  // Always write to in-memory ring buffer (fast path)
  _log.push(entry);
  if (_log.length > MAX_ENTRIES) _log.shift();

  // Write to PG when active (non-blocking — failures are logged, not thrown)
  if (isPostgresEnabled()) {
    try {
      const { db, adminLogsTable } = await import("@workspace/db");
      await db.insert(adminLogsTable).values({
        action:    entry.action,
        actor:     entry.actor,
        timestamp: entry.timestamp,
        details:   entry.details,
      });
    } catch (err) {
      logger.warn({ err }, "[adminActionLog] PG write failed — in-memory only");
    }
  }
}

/** Returns the most recent `limit` entries, newest first. */
export function getAdminActionLog(limit = 50): AdminActionEntry[] {
  const clamped = Math.max(1, Math.min(limit, MAX_ENTRIES));
  return _log.slice(-clamped).reverse();
}

export function getAdminActionLogSize(): number {
  return _log.length;
}
