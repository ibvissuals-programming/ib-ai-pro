/**
 * activityTracker.ts — IB AI Assistant
 *
 * Lightweight in-memory activity tracker for CEO visibility.
 * Tracks lastSeenAt and lastLoginAt per userId — no DB required.
 *
 * "Active" is defined as: lastSeenAt within ACTIVE_THRESHOLD_MS.
 */

import type { UserRole } from "./userStore";

export const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface ActivityRecord {
  userId: string;
  username: string;
  role: UserRole;
  lastSeenAt: number;   // Unix ms — updated on every authenticated request
  lastLoginAt: number;  // Unix ms — updated on successful login
}

const activity = new Map<string, ActivityRecord>();

/**
 * Update lastSeenAt for an authenticated user.
 * Called by the trackActivity middleware on every authenticated request.
 */
export function updateLastSeen(
  userId: string,
  username: string,
  role: UserRole,
): void {
  const existing = activity.get(userId);
  if (existing) {
    existing.lastSeenAt = Date.now();
    existing.username = username; // keep in sync in case of role changes
    existing.role = role;
  } else {
    activity.set(userId, {
      userId,
      username,
      role,
      lastSeenAt: Date.now(),
      lastLoginAt: 0, // will be updated on next login
    });
  }
}

/**
 * Record a successful login. Sets both lastLoginAt and lastSeenAt.
 */
export function recordLogin(
  userId: string,
  username: string,
  role: UserRole,
): void {
  const now = Date.now();
  const existing = activity.get(userId);
  if (existing) {
    existing.lastLoginAt = now;
    existing.lastSeenAt = now;
    existing.username = username;
    existing.role = role;
  } else {
    activity.set(userId, {
      userId,
      username,
      role,
      lastSeenAt: now,
      lastLoginAt: now,
    });
  }
}

/**
 * Return users whose lastSeenAt is within the given threshold (default: 5 min).
 * Sorted by lastSeenAt descending (most recently active first).
 */
export function getActiveUsers(
  thresholdMs = ACTIVE_THRESHOLD_MS,
): ActivityRecord[] {
  const cutoff = Date.now() - thresholdMs;
  return Array.from(activity.values())
    .filter((r) => r.lastSeenAt >= cutoff)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Total number of users tracked (ever seen since server start).
 */
export function getTrackedUserCount(): number {
  return activity.size;
}
