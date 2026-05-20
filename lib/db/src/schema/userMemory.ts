import { pgTable, text, bigint } from "drizzle-orm/pg-core";

/**
 * user_memory — per-user persistent key-value memory store.
 *
 * Columns:
 *   type       — canonical memory category (see MemoryType)
 *   confidence — extraction confidence (high|medium); low is never stored
 *
 * The type column is a plain text field — no enum constraint in the DB.
 * Legacy rows with old type values (preference/behavior/goal) remain valid.
 * New extractions use the canonical five-category system.
 */
export const userMemoryTable = pgTable("user_memory", {
  id:         text("id").primaryKey(),
  userId:     text("user_id").notNull(),
  key:        text("key").notNull(),
  value:      text("value").notNull(),
  type:       text("type").notNull().default("behavioral"),
  confidence: text("confidence").notNull().default("high"),
  updatedAt:  bigint("updated_at", { mode: "number" }).notNull(),
});

export type UserMemory       = typeof userMemoryTable.$inferSelect;
export type InsertUserMemory = typeof userMemoryTable.$inferInsert;

/**
 * Canonical memory categories (v2).
 *
 *   behavioral   — how the user works, communicates, or approaches problems
 *   identity     — who they are: role, expertise, domain, background
 *   project      — something actively being built, launched, or worked on
 *   narrative    — story/creative session canon: characters, world, events
 *   relationship — meaningful people or collaborations they've mentioned
 *
 * Legacy types (kept for backward-compat with rows written before v2):
 *   preference | behavior | goal
 */
export type MemoryType =
  | "behavioral"
  | "identity"
  | "project"
  | "narrative"
  | "relationship"
  | "preference"    // legacy
  | "behavior"      // legacy
  | "goal";         // legacy

export type MemoryConfidence = "high" | "medium" | "low";
