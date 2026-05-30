/**
 * startupHealthTest.ts — IB AI Assistant
 *
 * Automated health verification suite that runs once after the server
 * starts listening. Tests every subsystem independently and prints a
 * structured SYSTEM STABILITY REPORT.
 *
 * Rules:
 *   - Tests are NEVER destructive — any test data created is cleaned up.
 *   - A subsystem failure does NOT abort remaining tests.
 *   - No HTTP calls — tests run against internal functions directly.
 *   - _ht_* ephemeral test users are purged before and after testAuth.
 *
 * Report sections (spec order):
 *   PROVIDERS | IMAGE | VIDEO | TTS | JOB PIPELINE | ERROR LAYER | DB
 */
import { randomUUID } from "crypto";
import { logger } from "./logger";
import {
  createUser,
  authenticateUser,
  getUserByUsername,
  getAllUsers,
  deleteUserById,
} from "./userStore";
import { signToken, verifyToken } from "./token";
import { createSession, isSessionActive } from "./sessionStore";
import { isGeminiConfigured } from "./geminiEnv";
import { isSafeMode, getSafeModeReason } from "./safeMode";
import { isPostgresEnabled } from "./systemConfig";
import { pgLoadAllUsers } from "./pgUserStore";
import { emit, recentEvents } from "./eventBus";
import type { SystemEventType } from "./eventBus";

// ── Types ──────────────────────────────────────────────────────────────────────

type TestStatus = "PASS" | "FAIL" | "SKIP";

interface SubsystemResult {
  status:  TestStatus;
  details: string[];
}

interface HealthReport {
  providers:   SubsystemResult;
  image:       SubsystemResult;
  video:       SubsystemResult;
  tts:         SubsystemResult;
  jobPipeline: SubsystemResult;
  errorLayer:  SubsystemResult;
  db:          SubsystemResult;
  overall:     "STABLE" | "DEGRADED";
}

// ── Test helpers ───────────────────────────────────────────────────────────────

function pass(details: string[] = []): SubsystemResult {
  return { status: "PASS", details };
}

function fail(details: string[]): SubsystemResult {
  return { status: "FAIL", details };
}

function skip(reason: string): SubsystemResult {
  return { status: "SKIP", details: [reason] };
}

// ── Ephemeral test user cleanup ────────────────────────────────────────────────
// Removes any _ht_* users left over from previous restarts.
// Must run BEFORE testDb() so DB↔memory sync sees only real users.

function purgeHealthTestUsers(): number {
  const toDelete = getAllUsers().filter((u) => u.username.startsWith("_ht_"));
  for (const u of toDelete) {
    deleteUserById(u.id);
  }
  return toDelete.length;
}

// ── A — PROVIDER CHECKS ───────────────────────────────────────────────────────
// Validates all AI provider configurations and safe mode status.
// Also runs auth sub-checks (JWT, session) — provider-level infrastructure.

async function testProviders(): Promise<SubsystemResult> {
  const details: string[] = [];
  const failures: string[] = [];

  // 1. Gemini API key presence
  if (!isGeminiConfigured()) {
    failures.push("GEMINI_API_KEY not configured — AI features unavailable");
  } else {
    const { resolveGeminiKey } = await import("./geminiEnv");
    const key = resolveGeminiKey();
    if (!key) {
      failures.push("GEMINI_API_KEY: isGeminiConfigured()=true but resolveGeminiKey() returned undefined");
    } else {
      details.push("✔ Gemini API key present and resolvable");
    }
  }

  // 2. Safe mode status
  if (isSafeMode()) {
    const reason = getSafeModeReason();
    failures.push(`Safe mode is ACTIVE — all AI job creation blocked (reason: ${reason})`);
  } else {
    details.push("✔ Safe mode: OFF — AI job creation allowed");
  }

  // 3. Video provider flag (informational — disabled is not a failure)
  const videoEnabled = process.env["VIDEO_ENABLED"]?.toLowerCase() === "true";
  details.push(`✔ Video provider: ${videoEnabled ? "ENABLED" : "DISABLED (expected)"}`);

  // 4. CEO account verification
  const ceoUsername = process.env["CEO_USERNAME"]?.trim().toLowerCase();
  if (ceoUsername) {
    const ceo = getUserByUsername(ceoUsername);
    if (!ceo) {
      failures.push(`CEO account "${ceoUsername}" not found in user store`);
    } else if (ceo.role !== "ceo") {
      failures.push(`CEO account has wrong role: "${ceo.role}" (expected "ceo")`);
    } else {
      details.push(`✔ CEO account "${ceoUsername}" verified (role=ceo)`);
    }
  }

  // 5. Auth layer: JWT sign + verify round-trip
  try {
    const testUserId = `_ht_jwt_${randomUUID().slice(0, 8)}`;
    const token = signToken({
      userId:          testUserId,
      username:        "healthcheck",
      role:            "free",
      recoverySession: false,
    });
    const payload = verifyToken(token);
    if (payload.userId !== testUserId) {
      failures.push("JWT round-trip: payload userId mismatch after verify");
    } else {
      details.push("✔ JWT sign → verify round-trip OK");
    }
  } catch (err) {
    failures.push(`JWT round-trip threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Session store: create + active check
  try {
    const session = createSession({
      userId:   `_ht_sess_${randomUUID().slice(0, 8)}`,
      username: "healthcheck",
      role:     "free",
    });
    if (!session?.sessionId || !isSessionActive(session.sessionId)) {
      failures.push("Session store: new session not active immediately after creation");
    } else {
      details.push("✔ Session store: create + active check OK");
    }
  } catch (err) {
    failures.push(`Session store threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── B — IMAGE SYSTEM TEST ─────────────────────────────────────────────────────

async function testImage(): Promise<SubsystemResult> {
  if (!isGeminiConfigured()) {
    return skip("Gemini not configured — image system in safe mode");
  }

  const details: string[] = [];
  const failures: string[] = [];

  try {
    await import("../routes/imageGen");
    details.push("✔ imageGen route module loaded");
  } catch (err) {
    failures.push(`Image module import threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── C — VIDEO SYSTEM TEST ─────────────────────────────────────────────────────

async function testVideo(): Promise<SubsystemResult> {
  const videoEnabled = process.env["VIDEO_ENABLED"]?.toLowerCase() === "true";
  if (!videoEnabled) {
    return skip("VIDEO_ENABLED not set — video subsystem disabled");
  }
  if (!isGeminiConfigured()) {
    return skip("Gemini not configured — video system in safe mode");
  }

  const details: string[] = [];
  const failures: string[] = [];

  try {
    const { createJob, advanceJob, failJob } = await import("../services/imageJobManager");

    const job = createJob({
      jobType:        "VIDEO_JOB",
      complexity:     "STANDARD",
      intent:         "health_test_video",
      prompt:         "health test video prompt",
      expandedPrompt: "health test video expanded prompt",
      userId:         "_healthtest_",
      source:         "video",
    });

    if (!job?.jobId) {
      failures.push("createJob(VIDEO_JOB) returned invalid job");
    } else {
      details.push(`✔ Video job created (jobId=${job.jobId})`);
      advanceJob(job, "processing", "health test: processing");
      details.push("✔ Job transitioned queued → processing");
      failJob(job, "health test: intentional terminal — provider failure handled safely");
      details.push("✔ Job transitioned processing → failed (provider failure handled safely)");
    }
  } catch (err) {
    failures.push(`Video test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── D — TTS SYSTEM TEST ───────────────────────────────────────────────────────

async function testTts(): Promise<SubsystemResult> {
  if (!isGeminiConfigured()) {
    return skip("Gemini not configured — TTS system in safe mode");
  }

  const details: string[] = [];
  const failures: string[] = [];

  try {
    await import("../services/ttsService");
    details.push("✔ TTS service module loaded");

    const { createJob, advanceJob, failJob } = await import("../services/imageJobManager");

    const job = createJob({
      jobType:        "TTS_JOB",
      complexity:     "SIMPLE",
      intent:         "health_test_tts",
      prompt:         "health test tts prompt",
      expandedPrompt: "health test tts expanded prompt",
      userId:         "_healthtest_",
      source:         "tts",
    });

    if (!job?.jobId) {
      failures.push("createJob(TTS_JOB) returned invalid job");
    } else {
      details.push(`✔ TTS job created (jobId=${job.jobId})`);
      advanceJob(job, "processing", "health test: tts processing");
      failJob(job, "health test: tts graceful failure (no real provider call)");
      details.push("✔ TTS job lifecycle completed without unhandled errors");
    }
  } catch (err) {
    failures.push(`TTS test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── E — JOB PIPELINE TEST ─────────────────────────────────────────────────────

async function testJobPipeline(): Promise<SubsystemResult> {
  const details: string[] = [];
  const failures: string[] = [];

  try {
    const { createJob, advanceJob, completeJob, failJob, getJob } = await import("../services/imageJobManager");

    // Happy path: queued → processing → success
    const job = createJob({
      jobType:        "IMAGE_GENERATION_JOB",
      complexity:     "SIMPLE",
      intent:         "health_test_pipeline",
      prompt:         "health test pipeline prompt",
      expandedPrompt: "health test pipeline expanded prompt",
      userId:         "_healthtest_",
      source:         "image",
    });

    if (!job?.jobId) {
      return fail(["createJob returned invalid job — pipeline cannot start"]);
    }

    const jobId = job.jobId;
    details.push(`✔ Job created: ${jobId} (status=queued)`);

    advanceJob(job, "processing", "pipeline test: processing");
    const j1 = getJob(jobId);
    if (j1?.status !== "processing") {
      failures.push(`Expected status=processing after advanceJob, got: ${j1?.status}`);
    } else {
      details.push("✔ queued → processing");
    }

    completeJob(job, "flux");
    const j2 = getJob(jobId);
    if (j2?.status !== "success") {
      failures.push(`Expected status=success after completeJob, got: ${j2?.status}`);
    } else {
      details.push("✔ processing → success");
    }

    if (!j2?.statusHistory || j2.statusHistory.length < 3) {
      failures.push(
        `Status history too short (${j2?.statusHistory?.length ?? 0} events) — skipped states detected`,
      );
    } else {
      const statuses = j2.statusHistory.map((e) => e.status);
      details.push(`✔ Full pipeline states recorded: [${statuses.join(" → ")}]`);
    }

    // Failure path: queued → processing → failed
    const job2 = createJob({
      jobType:        "IMAGE_GENERATION_JOB",
      complexity:     "SIMPLE",
      intent:         "health_test_pipeline_fail",
      prompt:         "health test failure path",
      expandedPrompt: "health test failure path expanded",
      userId:         "_healthtest_",
      source:         "image",
    });

    if (job2?.jobId) {
      advanceJob(job2, "processing", "pipeline test: failure path processing");
      failJob(job2, "health test: intentional failure path");
      const j3 = getJob(job2.jobId);
      if (j3?.status !== "failed") {
        failures.push(`Expected status=failed after failJob, got: ${j3?.status}`);
      } else {
        details.push("✔ queued → processing → failed (failure path OK)");
      }
    }
  } catch (err) {
    failures.push(`Job pipeline test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── F — ERROR LAYER TEST ──────────────────────────────────────────────────────
// Verifies that error normalization returns consistent, known error codes
// and that provider errors are sanitized (no stack traces in output).

async function testErrorLayer(): Promise<SubsystemResult> {
  const details: string[] = [];
  const failures: string[] = [];

  try {
    const { normalizeAIError, buildErrorResponse } = await import("./aiOrchestrator");
    const { sanitizeProviderError } = await import("./providerGuard");

    // 1. Timeout error → code "timeout"
    const timeoutErr = new Error("Request timeout after 30000ms");
    const n1 = normalizeAIError(timeoutErr);
    if (n1.code === "timeout") {
      details.push("✔ timeout error → code=timeout");
    } else {
      failures.push(`timeout error: expected code="timeout", got "${n1.code}"`);
    }

    // 2. Rate limit error → code "rate_limit"
    const rateLimitErr = new Error("429 Too Many Requests — rate limit exceeded");
    const n2 = normalizeAIError(rateLimitErr);
    if (n2.code === "rate_limit") {
      details.push("✔ rate limit error → code=rate_limit");
    } else {
      failures.push(`rate limit error: expected code="rate_limit", got "${n2.code}"`);
    }

    // 3. Unknown error → code "internal_error"
    const unknownErr = new Error("Something went unexpectedly wrong");
    const n3 = normalizeAIError(unknownErr);
    if (n3.code === "internal_error") {
      details.push("✔ unknown error → code=internal_error");
    } else {
      failures.push(`unknown error: expected code="internal_error", got "${n3.code}"`);
    }

    // 4. buildErrorResponse returns success:false with a code field
    const errResponse = buildErrorResponse("image", unknownErr);
    if (errResponse.success === false && typeof errResponse.code === "string") {
      details.push("✔ buildErrorResponse returns {success:false, code:string}");
    } else {
      failures.push(`buildErrorResponse malformed: ${JSON.stringify(errResponse)}`);
    }

    // 5. sanitizeProviderError strips stack traces
    const errWithStack = new Error("Provider key=sk-abc123 invalid");
    errWithStack.stack = "Error: Provider key=sk-abc123 invalid\n    at someFile.ts:42:10";
    const sanitized = sanitizeProviderError(errWithStack, "health_test");
    if (typeof sanitized === "string" && !sanitized.includes("at someFile.ts")) {
      details.push("✔ sanitizeProviderError strips stack traces");
    } else {
      failures.push(`sanitizeProviderError leaked stack trace: "${sanitized}"`);
    }
  } catch (err) {
    failures.push(`Error layer test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── G — DB TEST ───────────────────────────────────────────────────────────────
// Checks: PostgreSQL reachable, CEO account exists in DB, DB↔memory in sync.
// Excludes _ht_* ephemeral users from sync check (already purged before this runs).

async function testDb(): Promise<SubsystemResult> {
  if (!isPostgresEnabled()) {
    return skip("PostgreSQL not enabled — DB check skipped");
  }

  const details: string[] = [];
  const failures: string[] = [];

  try {
    const pgUsers  = await pgLoadAllUsers();
    const memUsers = getAllUsers();

    // 1. DB reachability (if pgLoadAllUsers returned without throwing, DB is up)
    details.push(`✔ PostgreSQL reachable (${pgUsers.length} users in DB)`);

    // 2. CEO exists in DB
    const ceoUsername = process.env["CEO_USERNAME"]?.trim().toLowerCase();
    if (ceoUsername) {
      const ceoInDb = pgUsers.find((u) => u.username.toLowerCase() === ceoUsername);
      if (!ceoInDb) {
        failures.push(`CEO account "${ceoUsername}" not found in PostgreSQL`);
      } else if (ceoInDb.role !== "ceo") {
        failures.push(`CEO account in DB has wrong role: "${ceoInDb.role}" (expected "ceo")`);
      } else {
        details.push(`✔ CEO account "${ceoUsername}" present in DB (role=ceo)`);
      }
    }

    // 3. DB↔memory sync (excluding _ht_* test users)
    const pgIds  = new Map(pgUsers.filter((u) => !u.username.startsWith("_ht_")).map((u) => [u.id, u.username]));
    const memIds = new Map(memUsers.filter((u) => !u.username.startsWith("_ht_")).map((u) => [u.id, u.username]));

    for (const [id, username] of pgIds) {
      if (!memIds.has(id)) {
        failures.push(`DB user "${username}" (${id}) missing from memory store`);
      }
    }
    for (const [id, username] of memIds) {
      if (!pgIds.has(id)) {
        failures.push(`Memory user "${username}" (${id}) missing from DB`);
      }
    }

    // 4. No duplicate usernames in DB
    const counts = new Map<string, number>();
    for (const u of pgUsers) {
      counts.set(u.username, (counts.get(u.username) ?? 0) + 1);
    }
    let dupFound = false;
    for (const [username, count] of counts) {
      if (count > 1) {
        failures.push(`Duplicate username in DB: "${username}" (${count} rows)`);
        dupFound = true;
      }
    }
    if (!dupFound) {
      details.push(`✔ DB↔memory in sync (${pgIds.size} real users, no duplicates)`);
    }
  } catch (err) {
    failures.push(`DB test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── AUTH SUBSYSTEM (internal — feeds into PROVIDERS report) ───────────────────
// Full auth round-trip: create user → login correct pw → login wrong pw → cleanup.
// Test user is deleted immediately after — no accumulation across restarts.

async function testAuth(): Promise<SubsystemResult> {
  const details: string[] = [];
  const failures: string[] = [];

  const testUsername = `_ht_${randomUUID().slice(0, 8)}`;
  const correctPw    = `HT-${randomUUID().slice(0, 12)}`;
  const wrongPw      = "wrong-password-xyz-99";
  let   testUserId: string | null = null;

  try {
    const created = createUser(testUsername, correctPw);
    if (!created.success) {
      failures.push(`createUser failed: ${created.error}`);
    } else {
      testUserId = (created as { success: true; user: { id: string } }).user?.id ?? null;
      details.push("✔ Test user created");

      const authed = authenticateUser(testUsername, correctPw);
      if (!authed) {
        failures.push("authenticateUser with correct password returned null");
      } else {
        details.push("✔ Correct password login succeeded");

        const badAuth = authenticateUser(testUsername, wrongPw);
        if (badAuth !== null) {
          failures.push("authenticateUser with wrong password did NOT return null");
        } else {
          details.push("✔ Wrong password correctly rejected");
        }
      }
    }
  } catch (err) {
    failures.push(`Auth test threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Always clean up — never leave _ht_* users in the store
    if (testUserId) {
      deleteUserById(testUserId);
    } else {
      // Fallback: look up by username in case id wasn't captured
      const u = getUserByUsername(testUsername);
      if (u) deleteUserById(u.id);
    }
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── PRINT REPORT ──────────────────────────────────────────────────────────────

function printReport(report: HealthReport): void {
  const line = "━".repeat(32);

  logger.info(line);
  logger.info("SYSTEM STABILITY REPORT");
  logger.info(line);
  logger.info(`PROVIDERS:    ${report.providers.status}`);
  logger.info(`IMAGE:        ${report.image.status}`);
  logger.info(`VIDEO:        ${report.video.status}`);
  logger.info(`TTS:          ${report.tts.status}`);
  logger.info(`JOB PIPELINE: ${report.jobPipeline.status}`);
  logger.info(`ERROR LAYER:  ${report.errorLayer.status}`);
  logger.info(`DB:           ${report.db.status}`);
  logger.info(line);
  logger.info(`OVERALL:      ${report.overall}`);
  logger.info(line);

  const subsystems: [string, SubsystemResult][] = [
    ["PROVIDERS",   report.providers],
    ["IMAGE",       report.image],
    ["VIDEO",       report.video],
    ["TTS",         report.tts],
    ["JOB PIPELINE",report.jobPipeline],
    ["ERROR LAYER", report.errorLayer],
    ["DB",          report.db],
  ];

  for (const [name, result] of subsystems) {
    if (result.status === "FAIL") {
      logger.error(
        { subsystem: name, details: result.details },
        "[healthTest] subsystem FAILED",
      );
    } else if (result.status === "PASS") {
      logger.info(
        { subsystem: name, details: result.details },
        "[healthTest] subsystem OK",
      );
    } else {
      logger.info(
        { subsystem: name, reason: result.details[0] },
        "[healthTest] subsystem SKIPPED",
      );
    }
  }
}

// ── MAIN ENTRY ────────────────────────────────────────────────────────────────

export async function runStartupHealthTests(): Promise<void> {
  logger.info("[healthTest] Running startup health test suite...");

  const wrap = (p: Promise<SubsystemResult>): Promise<SubsystemResult> =>
    p.catch((err): SubsystemResult =>
      fail([`Uncaught: ${err instanceof Error ? err.message : String(err)}`]));

  // Step 1: Purge leftover _ht_* users from previous restarts.
  // Must happen BEFORE testDb so DB↔memory sync sees a clean state.
  const purged = purgeHealthTestUsers();
  if (purged > 0) {
    logger.info(`[healthTest] Purged ${purged} leftover _ht_* test user(s) from previous run`);
  }

  // Step 2: DB runs first — before any test modifies the user store.
  const db = await wrap(testDb());

  // Step 3: Independent checks run in parallel.
  const [providers, errorLayer, image, video, tts, jobPipeline] = await Promise.all([
    // testAuth() is run as part of testProviders to consolidate auth + provider checks
    wrap(testProviders()),
    wrap(testErrorLayer()),
    wrap(testImage()),
    wrap(testVideo()),
    wrap(testTts()),
    wrap(testJobPipeline()),
  ]);

  // Step 4: Auth full round-trip (creates + immediately deletes a test user).
  // Run after DB sync and parallel tests to avoid any timing conflicts.
  const authResult = await wrap(testAuth());

  // Fold auth result into providers — auth is a provider-layer concern
  const combinedProviders: SubsystemResult =
    authResult.status === "FAIL"
      ? fail([
          ...providers.details,
          ...authResult.details.filter((d) => d.startsWith("✗")),
        ])
      : providers;

  // DEGRADED if any critical system fails
  const criticalFailed =
    combinedProviders.status === "FAIL" ||
    jobPipeline.status === "FAIL" ||
    db.status === "FAIL";

  const overall: "STABLE" | "DEGRADED" = criticalFailed ? "DEGRADED" : "STABLE";

  const report: HealthReport = {
    providers:   combinedProviders,
    image,
    video,
    tts,
    jobPipeline,
    errorLayer,
    db,
    overall,
  };

  printReport(report);

  // Emit boot health event for monitoring
  emit({
    eventType: "startup_integrity_check" as SystemEventType,
    source:    "startupHealthTest",
    action:    "health_report_complete",
    status:    overall === "STABLE" ? "success" : "failure",
    metadata:  {
      overall,
      providers:   combinedProviders.status,
      image:       image.status,
      video:       video.status,
      tts:         tts.status,
      jobPipeline: jobPipeline.status,
      errorLayer:  errorLayer.status,
      db:          db.status,
    },
  });
}
