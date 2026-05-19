import { pgTable, text, bigint, jsonb, serial } from "drizzle-orm/pg-core";

export const adminLogsTable = pgTable("admin_logs", {
  id:        serial("id").primaryKey(),
  action:    text("action").notNull(),
  actor:     text("actor").notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  details:   jsonb("details").$type<Record<string, unknown>>(),
});

export type PgAdminLog       = typeof adminLogsTable.$inferSelect;
export type InsertPgAdminLog = typeof adminLogsTable.$inferInsert;
