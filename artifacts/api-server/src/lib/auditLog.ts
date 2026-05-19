/**
 * auditLog.ts — IB AI Assistant
 *
 * Lightweight in-memory circular audit log for CEO visibility.
 * Stores up to MAX_ENTRIES events (oldest are evicted automatically).
 * Zero external dependencies — pure in-process memory.
 *
 * Event types:
 *   login_success | login_failure | signup_success | signup_failure
 *   image_generate_success | image_generate_failure
 *   image_edit_success | image_edit_failure
 *   image_analysis_success | image_analysis_failure
 *   auth_error | system_error
 */

export type AuditEventType =
  | "login_success"
  | "login_failure"
  | "signup_success"
  | "signup_failure"
  | "image_generate_success"
  | "image_generate_failure"
  | "image_edit_success"
  | "image_edit_failure"
  | "image_analysis_success"
  | "image_analysis_failure"
  | "auth_error"
  | "system_error";

export interface AuditEntry {
  id: number;
  timestamp: number;          // Unix ms
  type: AuditEventType;
  username?: string;
  ip?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const MAX_ENTRIES = 500;
const log: AuditEntry[] = [];
let nextId = 1;

/**
 * Record an audit event. Never throws — silently drops oldest entry when full.
 */
export function addAuditEntry(
  type: AuditEventType,
  message: string,
  opts: { username?: string; ip?: string; metadata?: Record<string, unknown> } = {},
): void {
  const entry: AuditEntry = {
    id: nextId++,
    timestamp: Date.now(),
    type,
    message,
    ...( opts.username ? { username: opts.username } : {} ),
    ...( opts.ip       ? { ip: opts.ip }             : {} ),
    ...( opts.metadata ? { metadata: opts.metadata } : {} ),
  };

  log.push(entry);

  // Evict oldest entry when over capacity
  if (log.length > MAX_ENTRIES) {
    log.shift();
  }
}

/**
 * Return the most recent `limit` audit entries, newest first.
 */
export function getAuditLog(limit = 50): AuditEntry[] {
  const clamped = Math.max(1, Math.min(limit, MAX_ENTRIES));
  return log.slice(-clamped).reverse();
}

/**
 * Total number of stored entries (up to MAX_ENTRIES).
 */
export function getAuditLogSize(): number {
  return log.length;
}
