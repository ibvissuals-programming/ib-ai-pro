import { pgTable, text, bigint } from "drizzle-orm/pg-core";

export const chatSessionsTable = pgTable("chat_sessions", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").notNull(),
  title:     text("title").notNull().default("New Chat"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type ChatSession       = typeof chatSessionsTable.$inferSelect;
export type InsertChatSession = typeof chatSessionsTable.$inferInsert;
