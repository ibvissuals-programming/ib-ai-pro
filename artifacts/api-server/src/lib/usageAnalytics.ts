/**
 * usageAnalytics.ts — IB AI Assistant
 *
 * Persistent per-user per-day usage analytics.
 * All writes are fire-and-forget — they NEVER block a response or throw.
 *
 * DB table: usage_analytics (userId + day composite primary key)
 *
 * Tracked per user per day:
 *   - generations (text-to-image count)
 *   - edits (image-to-image count)
 *   - failures (total failed operations)
 *   - totalLatencyMs (sum of provider latency for avg calculation)
 *   - queueWaitMs (sum of time spent waiting in queue)
 */
import { db, usageAnalyticsTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { logger } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UsageEvent {
  userId:      string;
  type:        "generate" | "edit" | "failure";
  latencyMs?:  number;
  queueWaitMs?: number;
}

export interface AnalyticsSummary {
  totalGenerations: number;
  totalEdits:       number;
  totalFailures:    number;
  avgLatencyMs:     number | null;
  successRate:      number | null;
  activeDays:       number;
}

// ── Key helpers ───────────────────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function makeId(userId: string, day: string): string {
  return `${userId}_${day}`;
}

// ── Write path (fire-and-forget) ──────────────────────────────────────────────

/**
 * Record a usage event. Always synchronous from the caller's perspective.
 * DB write happens asynchronously and never throws to the caller.
 */
export function recordUsage(event: UsageEvent): void {
  void _persistUsage(event).catch((err: unknown) => {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, "[usageAnalytics] persist failed (non-fatal)");
  });
}

async function _persistUsage(event: UsageEvent): Promise<void> {
  const day  = todayKey();
  const id   = makeId(event.userId, day);
  const now  = Date.now();

  const genDelta     = event.type === "generate" ? 1 : 0;
  const editDelta    = event.type === "edit"     ? 1 : 0;
  const failDelta    = event.type === "failure"  ? 1 : 0;
  const latency      = event.latencyMs   ?? 0;
  const queueWait    = event.queueWaitMs ?? 0;

  await db
    .insert(usageAnalyticsTable)
    .values({
      id,
      userId:         event.userId,
      day,
      generations:    genDelta,
      edits:          editDelta,
      failures:       failDelta,
      totalLatencyMs: latency,
      queueWaitMs:    queueWait,
      updatedAt:      now,
    })
    .onConflictDoUpdate({
      target: usageAnalyticsTable.id,
      set: {
        generations:    sql`${usageAnalyticsTable.generations}    + ${genDelta}`,
        edits:          sql`${usageAnalyticsTable.edits}          + ${editDelta}`,
        failures:       sql`${usageAnalyticsTable.failures}       + ${failDelta}`,
        totalLatencyMs: sql`${usageAnalyticsTable.totalLatencyMs} + ${latency}`,
        queueWaitMs:    sql`${usageAnalyticsTable.queueWaitMs}    + ${queueWait}`,
        updatedAt:      now,
      },
    });
}

// ── Read paths ─────────────────────────────────────────────────────────────────

/** System-wide analytics summary across all users and all time. */
export async function getSystemAnalyticsSummary(): Promise<AnalyticsSummary> {
  try {
    const rows = await db
      .select()
      .from(usageAnalyticsTable)
      .orderBy(desc(usageAnalyticsTable.day));

    const totalGenerations = rows.reduce((s, r) => s + r.generations, 0);
    const totalEdits       = rows.reduce((s, r) => s + r.edits,       0);
    const totalFailures    = rows.reduce((s, r) => s + r.failures,    0);
    const totalLatencyMs   = rows.reduce((s, r) => s + r.totalLatencyMs, 0);
    const totalOps         = totalGenerations + totalEdits;

    return {
      totalGenerations,
      totalEdits,
      totalFailures,
      avgLatencyMs: totalOps > 0 ? Math.round(totalLatencyMs / totalOps) : null,
      successRate:  totalOps > 0
        ? Math.round(((totalOps - totalFailures) / totalOps) * 100)
        : null,
      activeDays: new Set(rows.map((r) => r.day)).size,
    };
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, "[usageAnalytics] getSystemAnalyticsSummary failed");
    return { totalGenerations: 0, totalEdits: 0, totalFailures: 0, avgLatencyMs: null, successRate: null, activeDays: 0 };
  }
}

/** Per-day analytics rows for a single user, newest first. */
export async function getUserAnalytics(userId: string): Promise<object[]> {
  try {
    return await db
      .select()
      .from(usageAnalyticsTable)
      .where(eq(usageAnalyticsTable.userId, userId))
      .orderBy(desc(usageAnalyticsTable.day));
  } catch {
    return [];
  }
}

/** All analytics rows grouped by userId, newest day first. */
export async function getAllUserAnalytics(): Promise<object[]> {
  try {
    return await db
      .select()
      .from(usageAnalyticsTable)
      .orderBy(desc(usageAnalyticsTable.day));
  } catch {
    return [];
  }
}

/** Per-user summary collapsed across all days. */
export async function getUserSummaries(): Promise<object[]> {
  try {
    const rows = await db
      .select({
        userId:         usageAnalyticsTable.userId,
        generations:    sql<number>`sum(${usageAnalyticsTable.generations})::int`,
        edits:          sql<number>`sum(${usageAnalyticsTable.edits})::int`,
        failures:       sql<number>`sum(${usageAnalyticsTable.failures})::int`,
        totalLatencyMs: sql<number>`sum(${usageAnalyticsTable.totalLatencyMs})::bigint`,
        activeDays:     sql<number>`count(distinct ${usageAnalyticsTable.day})::int`,
        lastActive:     sql<string>`max(${usageAnalyticsTable.day})`,
      })
      .from(usageAnalyticsTable)
      .groupBy(usageAnalyticsTable.userId);

    return rows.map((r) => {
      const ops = r.generations + r.edits;
      return {
        ...r,
        avgLatencyMs: ops > 0 ? Math.round(r.totalLatencyMs / ops) : null,
        successRate:  ops > 0 ? Math.round(((ops - r.failures) / ops) * 100) : null,
      };
    });
  } catch {
    return [];
  }
}
