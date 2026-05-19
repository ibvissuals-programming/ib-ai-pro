import { pgTable, text, integer, bigint } from "drizzle-orm/pg-core";

export const imageHistoryTable = pgTable("image_history", {
  id:                  text("id").primaryKey(),
  userId:              text("user_id").notNull(),
  type:                text("type").notNull(),
  prompt:              text("prompt").notNull(),
  mode:                text("mode").notNull(),
  intensity:           text("intensity").notNull(),
  timestamp:           bigint("timestamp",             { mode: "number" }).notNull(),
  imageFile:           text("image_file").notNull(),
  mimeType:            text("mime_type").notNull(),
  complexity:          text("complexity"),
  contractVersionUsed: text("contract_version_used"),
  model:               text("model"),
  status:              text("status"),
  retryCount:          integer("retry_count"),
  latencyMs:           integer("latency_ms"),
});

export type PgImageHistory       = typeof imageHistoryTable.$inferSelect;
export type InsertPgImageHistory = typeof imageHistoryTable.$inferInsert;
