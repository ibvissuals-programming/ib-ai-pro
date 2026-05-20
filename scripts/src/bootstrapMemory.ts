/**
 * bootstrapMemory.ts — IB AI Bootstrap Memory Seeder
 *
 * Seeds core CEO identity and system context into the PostgreSQL memory table.
 * Safe to run multiple times — checks for existing keys before inserting and
 * never overwrites existing entries.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:memory
 *
 * Guard: exits immediately unless NODE_ENV=development or SEED_MEMORY_FORCE=true.
 */

import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { db, userMemoryTable, pool } from "@workspace/db";

// ── Environment guard ──────────────────────────────────────────────────────────

const isDev   = process.env["NODE_ENV"] === "development";
const isForce = process.env["SEED_MEMORY_FORCE"] === "true";

if (!isDev && !isForce) {
  console.error(
    "[bootstrapMemory] Blocked: NODE_ENV is not 'development' and SEED_MEMORY_FORCE is not 'true'.",
  );
  console.error(
    "  To run manually: SEED_MEMORY_FORCE=true pnpm --filter @workspace/scripts run seed:memory",
  );
  process.exit(1);
}

// ── CEO target ─────────────────────────────────────────────────────────────────
//
// This is the primary CEO/founder account. The userId is stable — it was set
// at account creation and is the target for all bootstrap memory seeds.
// If the CEO account is ever recreated, update this constant and re-run the seeder.

const CEO_USER_ID = "e66361c6-3db4-4309-af86-dd009485add3";

// ── Seed entries ───────────────────────────────────────────────────────────────

type SeedEntry = {
  key:        string;
  value:      string;
  type:       string;
  confidence: string;
};

const SEED_ENTRIES: SeedEntry[] = [
  {
    key:        "ceo_identity",
    value:      "CEO and founder of IB AI Studio Lab. Builder and operator of AI systems — not an end-user. Owns product architecture, roadmap, and execution. All interactions should assume this context by default.",
    type:       "identity",
    confidence: "high",
  },
  {
    key:        "ib_ai_system_identity",
    value:      "IB AI Studio Lab is an AI operating system being built as a SaaS platform for creators, businesses, and automation workflows. Core pillars: multimodal AI chat, autonomous memory, prompt engineering tools, and agentic automation.",
    type:       "project",
    confidence: "high",
  },
  {
    key:        "product_vision",
    value:      "The product vision is to build IB AI into a full AI operating system: persistent memory across sessions, multimodal input/output, autonomous agent pipelines, and a scalable SaaS delivery layer accessible to non-technical creators and businesses.",
    type:       "project",
    confidence: "high",
  },
  {
    key:        "default_behavioral_guidelines",
    value:      "Prefers direct, execution-focused communication. Systems thinker focused on architecture, scalability, and leverage. Skip basics and explanations unless explicitly requested. Respond as a product architect and technical partner, not a tutorial assistant.",
    type:       "behavioral",
    confidence: "high",
  },
];

// ── Seeder ────────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  console.log("[bootstrapMemory] Starting — target userId:", CEO_USER_ID);
  console.log("[bootstrapMemory] Entries to seed:", SEED_ENTRIES.length);
  console.log("");

  let inserted = 0;
  let skipped  = 0;

  for (const entry of SEED_ENTRIES) {
    const [existing] = await db
      .select({ id: userMemoryTable.id })
      .from(userMemoryTable)
      .where(
        and(
          eq(userMemoryTable.userId, CEO_USER_ID),
          eq(userMemoryTable.key,    entry.key),
        ),
      )
      .limit(1);

    if (existing) {
      console.log(`  [skip]   ${entry.key} — already exists (id: ${existing.id})`);
      skipped++;
      continue;
    }

    const id  = randomUUID();
    const now = Date.now();

    await db.insert(userMemoryTable).values({
      id,
      userId:     CEO_USER_ID,
      key:        entry.key,
      value:      entry.value,
      type:       entry.type,
      confidence: entry.confidence,
      updatedAt:  now,
    });

    console.log(`  [insert] ${entry.key} — inserted (id: ${id})`);
    inserted++;
  }

  console.log("");
  console.log(`[bootstrapMemory] Done — inserted: ${inserted} | skipped: ${skipped}`);
}

// ── Run ────────────────────────────────────────────────────────────────────────

seed()
  .catch((err) => {
    console.error("[bootstrapMemory] Fatal error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
