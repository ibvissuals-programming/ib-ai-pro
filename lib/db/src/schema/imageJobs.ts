import { pgTable, text, integer, bigint } from "drizzle-orm/pg-core";

export const imageJobsTable = pgTable("image_jobs", {
  id:             text("id").primaryKey(),
  userId:         text("user_id"),
  status:         text("status").notNull(),
  jobType:        text("job_type").notNull(),
  complexity:     text("complexity").notNull(),
  prompt:         text("prompt").notNull(),
  expandedPrompt: text("expanded_prompt").notNull().default(""),
  intent:         text("intent").notNull().default(""),
  modelUsed:      text("model_used"),
  retryCount:     integer("retry_count").notNull().default(0),
  latencyMs:      integer("latency_ms"),
  errorReason:    text("error_reason"),
  createdAt:      bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:      bigint("updated_at", { mode: "number" }).notNull(),
});

export type PgImageJob       = typeof imageJobsTable.$inferSelect;
export type InsertPgImageJob = typeof imageJobsTable.$inferInsert;
