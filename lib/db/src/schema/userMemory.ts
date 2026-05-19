import { pgTable, text, bigint } from "drizzle-orm/pg-core";

/**
 * user_memory — per-user persistent key-value memory store.
 *
 * Columns:
 *   type       — semantic category of the memory entry (preference|project|behavior|goal)
 *   confidence — extraction confidence level (high|medium); low entries are never stored
 *
 * Both columns default to 'preference' / 'high' so all existing rows remain valid
 * and manually-set entries (via POST /api/memory) work without supplying these fields.
 */
export const userMemoryTable = pgTable("user_memory", {
  id:         text("id").primaryKey(),
  userId:     text("user_id").notNull(),
  key:        text("key").notNull(),
  value:      text("value").notNull(),
  type:       text("type").notNull().default("preference"),
  confidence: text("confidence").notNull().default("high"),
  updatedAt:  bigint("updated_at", { mode: "number" }).notNull(),
});

export type UserMemory       = typeof userMemoryTable.$inferSelect;
export type InsertUserMemory = typeof userMemoryTable.$inferInsert;

export type MemoryType       = "preference" | "project" | "behavior" | "goal";
export type MemoryConfidence = "high" | "medium" | "low";
