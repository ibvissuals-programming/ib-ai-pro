import { pgTable, text, integer, bigint } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id:           text("id").primaryKey(),
  username:     text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role:         text("role").notNull().$type<"free" | "premium" | "ceo">(),
  credits:      integer("credits").notNull().default(7),
  lastReset:    bigint("last_reset",  { mode: "number" }).notNull(),
  createdAt:    bigint("created_at",  { mode: "number" }).notNull(),
});

export type PgUser       = typeof usersTable.$inferSelect;
export type InsertPgUser = typeof usersTable.$inferInsert;
