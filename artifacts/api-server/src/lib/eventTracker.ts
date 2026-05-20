/**
 * eventTracker.ts — IB AI Assistant real-time event pipeline.
 *
 * Captures structured lifecycle events from:
 *   - Chat request pipeline (started / completed)
 *   - Memory pipeline (extracted / injected / skipped)
 *   - System errors (error_occurred)
 *
 * Architecture:
 *   - In-memory ring buffer: last RING_SIZE events (never persisted)
 *   - SSE pub/sub: registered callbacks receive every new event immediately
 *   - All writes are synchronous — zero async, zero blocking, zero throws
 *   - Failsafe: pushEvent() catches all exceptions silently
 *
 * PHASE 6 contract:
 *   - Never blocks any request path
 *   - SSE subscriber failures are silently caught and unregistered
 *   - No PII in event payloads (userId only, never content/values)
 */

import { logger } from "./logger";

// ── Event types ───────────────────────────────────────────────────────────────

export type EventType =
  | "chat_request_started"
  | "chat_request_completed"
  | "memory_extracted"
  | "memory_injected"
  | "memory_skipped"
  | "error_occurred";

export type EventCategory = "chat" | "mem" | "system";

export interface TrackedEvent {
  id:        number;
  timestamp: number;
  category:  EventCategory;
  type:      EventType;
  userId?:   string;
  latencyMs?: number;
  route?:    string;
  meta?:     Record<string, unknown>;
}

// ── Ring buffer ───────────────────────────────────────────────────────────────

const RING_SIZE = 500;
const _ring: TrackedEvent[] = [];
let _seq = 0;

// ── SSE subscriber registry ───────────────────────────────────────────────────

type EventCallback = (event: TrackedEvent) => void;
const _subscribers = new Set<EventCallback>();

// ── Category helper ───────────────────────────────────────────────────────────

function categoryOf(type: EventType): EventCategory {
  if (type.startsWith("memory") || type === "memory_extracted" ||
      type === "memory_injected" || type === "memory_skipped") return "mem";
  if (type.startsWith("chat")) return "chat";
  return "system";
}

// ── Public write API ──────────────────────────────────────────────────────────

/**
 * Push a lifecycle event into the ring buffer and notify all SSE subscribers.
 * NEVER throws — all errors are swallowed to protect the request path.
 */
export function pushEvent(
  type:    EventType,
  opts:    {
    userId?:   string;
    latencyMs?: number;
    route?:    string;
    meta?:     Record<string, unknown>;
  } = {},
): void {
  try {
    const event: TrackedEvent = {
      id:        ++_seq,
      timestamp: Date.now(),
      category:  categoryOf(type),
      type,
      ...( opts.userId    !== undefined ? { userId:    opts.userId    } : {} ),
      ...( opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {} ),
      ...( opts.route     !== undefined ? { route:     opts.route     } : {} ),
      ...( opts.meta      !== undefined ? { meta:      opts.meta      } : {} ),
    };

    _ring.push(event);
    if (_ring.length > RING_SIZE) _ring.shift();

    // Notify SSE subscribers — failures are caught per-subscriber
    const deadSubs: EventCallback[] = [];
    for (const cb of _subscribers) {
      try {
        cb(event);
      } catch {
        deadSubs.push(cb);
      }
    }
    for (const dead of deadSubs) _subscribers.delete(dead);

  } catch (err) {
    // Absolute last resort: log and swallow — never propagate
    logger.warn({ err }, "[eventTracker] pushEvent failed silently");
  }
}

// ── Public read API ───────────────────────────────────────────────────────────

/**
 * Return the most recent `limit` events, newest first.
 */
export function getRecentEvents(limit = 100): TrackedEvent[] {
  const n = Math.min(Math.max(1, limit), _ring.length);
  return _ring.slice(-n).reverse();
}

/**
 * Total events captured since server start.
 */
export function getTotalEventCount(): number {
  return _seq;
}

/**
 * Count events of a given type in the current ring buffer.
 */
export function countEventsByType(type: EventType): number {
  return _ring.filter((e) => e.type === type).length;
}

/**
 * Count events of a given type in the last N milliseconds.
 */
export function countEventsInWindow(type: EventType, windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return _ring.filter((e) => e.type === type && e.timestamp >= cutoff).length;
}

/**
 * Get the most recent error events (error_occurred).
 */
export function getRecentErrors(limit = 10): TrackedEvent[] {
  return _ring
    .filter((e) => e.type === "error_occurred")
    .slice(-Math.min(limit, 50))
    .reverse();
}

// ── SSE pub/sub ───────────────────────────────────────────────────────────────

/**
 * Register a callback to receive every new event in real time.
 * Used by the SSE endpoint. Failures auto-unregister the subscriber.
 */
export function subscribeToEvents(cb: EventCallback): void {
  _subscribers.add(cb);
}

/**
 * Unregister a callback. Must be called on SSE client disconnect.
 */
export function unsubscribeFromEvents(cb: EventCallback): void {
  _subscribers.delete(cb);
}

/**
 * Number of active SSE subscribers.
 */
export function getSubscriberCount(): number {
  return _subscribers.size;
}
