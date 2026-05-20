import { pgTable, text, integer, bigint } from "drizzle-orm/pg-core";

export const usageAnalyticsTable = pgTable("usage_analytics", {
  id:             text("id").primaryKey(),
  userId:         text("user_id").notNull(),
  day:            text("day").notNull(),
  generations:    integer("generations").notNull().default(0),
  edits:          integer("edits").notNull().default(0),
  failures:       integer("failures").notNull().default(0),
  totalLatencyMs: bigint("total_latency_ms", { mode: "number" }).notNull().default(0),
  queueWaitMs:    bigint("queue_wait_ms",    { mode: "number" }).notNull().default(0),
  updatedAt:      bigint("updated_at",       { mode: "number" }).notNull(),
});

export type PgUsageAnalytics       = typeof usageAnalyticsTable.$inferSelect;
export type InsertPgUsageAnalytics = typeof usageAnalyticsTable.$inferInsert;
