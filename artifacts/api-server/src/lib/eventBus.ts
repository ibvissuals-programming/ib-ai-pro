/**
 * eventBus.ts — In-memory structured event bus (zero external dependencies).
 *
 * Every critical system action emits a structured SystemEvent here.
 * Events are stored in a fixed-size circular buffer (MAX_EVENTS = 500).
 * No persistence — buffer is cleared on process restart (by design).
 *
 * This is the PRIMARY structured observability layer. Pino log output
 * remains for human-readable streams; eventBus serves machine-readable
 * consumption (admin endpoints, health checks, audit queries).
 */
import { logger } from "./logger";

// ── Event types ────────────────────────────────────────────────────────────────

export type EventStatus = "success" | "failure" | "blocked" | "info";

export type SystemEventType =
  // Auth
  | "login_attempt"
  | "login_success"
  | "login_failure"
  | "register_success"
  | "password_change_attempt"
  | "password_change_success"
  | "password_change_failure"
  | "password_reset_attempt"
  | "password_reset_success"
  | "password_reset_failure"
  // AI System
  | "job_creation_attempt"
  | "job_blocked_by_policy"
  | "job_created"
  | "job_completed"
  | "job_failed"
  | "provider_blocked"
  | "safe_mode_triggered"
  // Session
  | "session_created"
  | "session_revoked"
  | "session_revoke_all"
  | "session_validation_failed"
  // System
  | "startup_integrity_check"
  | "invariant_violation"
  | "index_repair_action";

export interface SystemEvent {
  timestamp:  number;
  eventType:  SystemEventType;
  source:     string;
  userId?:    string;
  action:     string;
  status:     EventStatus;
  metadata:   Record<string, unknown>;
  errorCode?: string;
}

// ── Circular buffer ────────────────────────────────────────────────────────────

const MAX_EVENTS   = 500;
const eventBuffer: SystemEvent[] = [];
let   totalEmitted = 0;

// ── Emit ──────────────────────────────────────────────────────────────────────

export function emit(event: Omit<SystemEvent, "timestamp">): void {
  const full: SystemEvent = { ...event, timestamp: Date.now() };
  if (eventBuffer.length >= MAX_EVENTS) {
    eventBuffer.shift();
  }
  eventBuffer.push(full);
  totalEmitted++;
  logger.debug(
    { eventType: event.eventType, source: event.source, status: event.status },
    "[eventBus]",
  );
}

// ── Query ─────────────────────────────────────────────────────────────────────

export function recentEvents(limit = 50): SystemEvent[] {
  const n = Math.min(limit, eventBuffer.length);
  return eventBuffer.slice(-n);
}

export function filterEventsByType(type: SystemEventType): SystemEvent[] {
  return eventBuffer.filter((e) => e.eventType === type);
}

export function filterEventsByUserId(userId: string): SystemEvent[] {
  return eventBuffer.filter((e) => e.userId === userId);
}

export function getEventStats(): { buffered: number; totalEmitted: number } {
  return { buffered: eventBuffer.length, totalEmitted };
}
