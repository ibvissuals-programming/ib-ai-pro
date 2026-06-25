import { pgTable, text, bigint } from "drizzle-orm/pg-core";

export const savedItemsTable = pgTable("saved_items", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull(),
  type:      text("type").notNull().$type<"text" | "image">(),
  content:   text("content").notNull(),
  metadata:  text("metadata"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type PgSavedItem       = typeof savedItemsTable.$inferSelect;
export type InsertPgSavedItem = typeof savedItemsTable.$inferInsert;
