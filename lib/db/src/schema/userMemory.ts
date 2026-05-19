import { pgTable, text, bigint } from "drizzle-orm/pg-core";

export const userMemoryTable = pgTable("user_memory", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull(),
  key:       text("key").notNull(),
  value:     text("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type UserMemory       = typeof userMemoryTable.$inferSelect;
export type InsertUserMemory = typeof userMemoryTable.$inferInsert;
