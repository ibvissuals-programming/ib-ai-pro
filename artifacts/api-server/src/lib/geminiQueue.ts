// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Gemini Load Shield — per-user FIFO queue + global concurrency cap      ║
// ║                                                                          ║
// ║  Rules:                                                                  ║
// ║    PER_USER_CAP = 1  — at most 1 active Gemini call per userId           ║
// ║    GLOBAL_CAP   = 3  — at most 3 concurrent Gemini calls system-wide     ║
// ║                                                                          ║
// ║  Never drops a request. Requests that cannot immediately acquire a slot  ║
// ║  are queued and resolved FIFO per user, round-robin across users.        ║
// ║                                                                          ║
// ║  DO NOT call Gemini directly — always go through acquireGeminiSlot().   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { logger } from "./logger";

// ── Tuning constants ──────────────────────────────────────────────────────────

const PER_USER_CAP = 1; // max simultaneous Gemini calls per userId
const GLOBAL_CAP   = 3; // max simultaneous Gemini calls across all users

// ── State ─────────────────────────────────────────────────────────────────────

// Active Gemini call count per userId
const activeByUser = new Map<string, number>();

// Total active Gemini calls across all users
let globalActive = 0;

// Per-user FIFO queue of pending resolver functions.
// Each resolver, when called, unblocks one waiting acquireGeminiSlot() promise.
const userQueues = new Map<string, Array<() => void>>();

// Ordered list of userIds that have at least one entry in userQueues.
// Maintained in insertion order to implement fair round-robin dispatch.
const pendingUsers: string[] = [];

// ── Internal helpers ──────────────────────────────────────────────────────────

function getUserActive(userId: string): number {
  return activeByUser.get(userId) ?? 0;
}

function canAcquire(userId: string): boolean {
  return getUserActive(userId) < PER_USER_CAP && globalActive < GLOBAL_CAP;
}

function markActive(userId: string): void {
  activeByUser.set(userId, getUserActive(userId) + 1);
  globalActive++;
}

function markDone(userId: string): void {
  const cur = getUserActive(userId);
  if (cur <= 1) {
    activeByUser.delete(userId);
  } else {
    activeByUser.set(userId, cur - 1);
  }
  globalActive = Math.max(0, globalActive - 1);
}

// Round-robin flush: one full pass through pendingUsers, giving each user whose
// per-user AND global caps allow it one queued slot to proceed.
function flush(): void {
  if (pendingUsers.length === 0) return;

  // Snapshot so splices inside the loop don't skip entries
  const snapshot = [...pendingUsers];

  for (const uid of snapshot) {
    if (globalActive >= GLOBAL_CAP) break;

    const queue = userQueues.get(uid);
    if (!queue || queue.length === 0) {
      userQueues.delete(uid);
      const idx = pendingUsers.indexOf(uid);
      if (idx !== -1) pendingUsers.splice(idx, 1);
      continue;
    }

    if (getUserActive(uid) >= PER_USER_CAP) continue;

    const resolve = queue.shift()!;

    if (queue.length === 0) {
      userQueues.delete(uid);
      const idx = pendingUsers.indexOf(uid);
      if (idx !== -1) pendingUsers.splice(idx, 1);
    }

    markActive(uid);
    resolve(); // unblock the waiting caller
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Acquire a Gemini execution slot for the given userId.
 *
 * - If per-user cap (1) and global cap (3) both allow it, resolves immediately.
 * - Otherwise, enqueues the request and resolves when a slot opens (FIFO per
 *   user, round-robin across users). Never rejects.
 *
 * Returns a `release()` function that **must** be called in a finally block
 * once the Gemini call finishes (success or error). Failing to call release()
 * will permanently consume a concurrency slot.
 *
 * Logging:
 *   [queue] user queued             — request could not immediately acquire slot
 *   [queue] user processing started — slot acquired, Gemini call may proceed
 *   [queue] user processing finished — slot released, next queued entry unblocked
 */
export async function acquireGeminiSlot(
  userId: string,
  requestId: string,
): Promise<() => void> {

  // release() is the function the caller returns to after Gemini finishes.
  // Defined once here so it is shared between the immediate and queued paths.
  const release = (): void => {
    markDone(userId);
    logger.info(
      {
        requestId,
        userId,
        globalActive,
        userActive: getUserActive(userId),
      },
      "[queue] user processing finished",
    );
    flush();
  };

  // ── Fast path: slot immediately available ─────────────────────────────────
  if (canAcquire(userId)) {
    markActive(userId);
    logger.info(
      {
        requestId,
        userId,
        globalActive,
        userActive: getUserActive(userId),
      },
      "[queue] user processing started",
    );
    return release;
  }

  // ── Slow path: queue the request ──────────────────────────────────────────
  const queueDepth = (userQueues.get(userId)?.length ?? 0) + 1;
  logger.info(
    {
      requestId,
      userId,
      queueDepth,
      globalActive,
      userActive: getUserActive(userId),
    },
    "[queue] user queued",
  );

  return new Promise<() => void>((resolve) => {
    if (!userQueues.has(userId)) {
      userQueues.set(userId, []);
      pendingUsers.push(userId);
    }

    userQueues.get(userId)!.push(() => {
      // Called by flush() after markActive(userId) — active counts already updated.
      logger.info(
        {
          requestId,
          userId,
          globalActive,
          userActive: getUserActive(userId),
        },
        "[queue] user processing started",
      );
      resolve(release);
    });
  });
}
