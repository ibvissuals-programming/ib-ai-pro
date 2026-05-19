import { pgTable, text, bigint, boolean, integer } from "drizzle-orm/pg-core";

export const chatMessagesTable = pgTable("chat_messages", {
  id:           text("id").primaryKey(),
  sessionId:    text("session_id").notNull(),
  userId:       text("user_id").notNull(),
  role:         text("role").notNull(),          // 'user' | 'assistant'
  content:      text("content"),                 // null for binary (image-edit-result)
  type:         text("type"),                    // nullable message type
  providerUsed: text("provider_used"),           // 'groq' | 'gemini' | null
  fallbackUsed: boolean("fallback_used").notNull().default(false),
  latencyMs:    integer("latency_ms"),
  timestamp:    bigint("timestamp", { mode: "number" }).notNull(),
});

export type ChatMessageRow       = typeof chatMessagesTable.$inferSelect;
export type InsertChatMessageRow = typeof chatMessagesTable.$inferInsert;
