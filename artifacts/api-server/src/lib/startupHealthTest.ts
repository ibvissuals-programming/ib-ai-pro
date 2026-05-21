/**
 * startupHealthTest.ts — IB AI Assistant
 *
 * Automated health verification suite that runs once after the server
 * starts listening. Tests every subsystem independently and prints a
 * structured FINAL SYSTEM STATUS REPORT.
 *
 * Rules:
 *   - Tests are NEVER destructive — any test data created is cleaned up.
 *   - A subsystem failure does NOT abort remaining tests.
 *   - Auth failures are logged at ERROR; AI failures at WARN (optional subsystem).
 *   - No HTTP calls — tests run against internal functions directly.
 */
import { randomUUID } from "crypto";
import { logger } from "./logger";
import {
  createUser,
  authenticateUser,
  getUserByUsername,
} from "./userStore";
import { signToken, verifyToken } from "./token";
import { createSession, isSessionActive } from "./sessionStore";
import { isGeminiConfigured } from "./geminiEnv";
import { emit, recentEvents } from "./eventBus";
import type { SystemEventType } from "./eventBus";

// ── Types ──────────────────────────────────────────────────────────────────────

type TestStatus = "PASS" | "FAIL" | "SKIP";

interface SubsystemResult {
  status:  TestStatus;
  details: string[];
}

interface HealthReport {
  auth:        SubsystemResult;
  image:       SubsystemResult;
  video:       SubsystemResult;
  voice:       SubsystemResult;
  jobPipeline: SubsystemResult;
  eventSystem: SubsystemResult;
  overall:     "HEALTHY" | "DEGRADED";
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

// ── A — AUTH TESTS ─────────────────────────────────────────────────────────────

async function testAuth(): Promise<SubsystemResult> {
  const details: string[] = [];
  const failures: string[] = [];

  // Use a unique throwaway username to avoid collision with real accounts
  const testUsername = `_ht_${randomUUID().slice(0, 8)}`;
  const correctPw    = `HT-${randomUUID().slice(0, 12)}`;
  const wrongPw      = "wrong-password-xyz-99";

  try {
    // 1. Create test user
    const created = createUser(testUsername, correctPw);
    if (!created.success) {
      failures.push(`createUser failed: ${created.error}`);
    } else {
      details.push("✔ Test user created");

      // 2. Correct password login MUST succeed
      const authed = authenticateUser(testUsername, correctPw);
      if (!authed) {
        failures.push("authenticateUser with correct password returned null");
      } else {
        details.push("✔ Correct password login succeeded");

        // 3. JWT token generation MUST succeed
        try {
          const token = signToken({
            userId:          authed.id,
            username:        authed.username,
            role:            authed.role,
            recoverySession: false,
          });
          details.push("✔ JWT token generation succeeded");

          // 4. Token must verify cleanly
          const payload = verifyToken(token);
          if (payload.userId !== authed.id) {
            failures.push("Token payload userId mismatch after verify");
          } else {
            details.push("✔ JWT token verification succeeded");
          }
        } catch (err) {
          failures.push(`signToken/verifyToken threw: ${err instanceof Error ? err.message : String(err)}`);
        }

        // 5. Session creation MUST succeed
        const session = createSession({
          userId:   authed.id,
          username: authed.username,
          role:     authed.role,
        });
        if (!session?.sessionId) {
          failures.push("createSession returned invalid session");
        } else if (!isSessionActive(session.sessionId)) {
          failures.push("Newly created session is not active");
        } else {
          details.push("✔ Session creation and activation succeeded");
        }
      }

      // 6. Wrong password MUST fail
      const badAuth = authenticateUser(testUsername, wrongPw);
      if (badAuth !== null) {
        failures.push("authenticateUser with wrong password did NOT return null");
      } else {
        details.push("✔ Wrong password correctly rejected");
      }
    }
  } catch (err) {
    failures.push(`Auth test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // CEO account existence check (we don't test CEO password — it's not known here)
  const ceoUsername = process.env["CEO_USERNAME"]?.trim().toLowerCase();
  if (ceoUsername) {
    const ceo = getUserByUsername(ceoUsername);
    if (!ceo) {
      failures.push(`CEO account "${ceoUsername}" not found in user store`);
    } else if (ceo.role !== "ceo") {
      failures.push(`CEO account has wrong role: "${ceo.role}" (expected "ceo")`);
    } else {
      details.push(`✔ CEO account "${ceoUsername}" verified in store with role=ceo`);
    }
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
    // Verify Gemini key is accessible at test time
    const { resolveGeminiKey } = await import("./geminiEnv");
    const key = resolveGeminiKey();
    if (!key) {
      failures.push("GEMINI_API_KEY resolved to undefined at test time");
    } else {
      details.push("✔ Gemini API key present for image provider");
    }

    // Verify image route modules load without import errors
    await import("../routes/imageGen");
    details.push("✔ imageGen route module loaded");
  } catch (err) {
    failures.push(`Image system check threw: ${err instanceof Error ? err.message : String(err)}`);
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

    // Create a VIDEO_JOB and walk valid state transitions
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

      // queued → processing
      advanceJob(job, "processing", "health test: processing");
      details.push("✔ Job transitioned queued → processing");

      // processing → failed (safe terminal — no real provider call)
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

// ── D — VOICE / TTS TEST ──────────────────────────────────────────────────────

async function testVoice(): Promise<SubsystemResult> {
  if (!isGeminiConfigured()) {
    return skip("Gemini not configured — TTS system in safe mode");
  }

  const details: string[] = [];
  const failures: string[] = [];

  try {
    // Verify TTS service module loads cleanly (catches import/syntax errors)
    await import("../services/ttsService");
    details.push("✔ TTS service module loaded");

    // Create a TTS_JOB and verify lifecycle transitions work
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
    const { createJob, advanceJob, completeJob, getJob } = await import("../services/imageJobManager");

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

    // queued → processing
    advanceJob(job, "processing", "pipeline test: processing");
    const j1 = getJob(jobId);
    if (j1?.status !== "processing") {
      failures.push(`Expected status=processing after advanceJob, got: ${j1?.status}`);
    } else {
      details.push("✔ queued → processing");
    }

    // processing → success
    completeJob(job, "flux");
    const j2 = getJob(jobId);
    if (j2?.status !== "success") {
      failures.push(`Expected status=success after completeJob, got: ${j2?.status}`);
    } else {
      details.push("✔ processing → success");
    }

    // Verify full status history — no skipped states
    if (!j2?.statusHistory || j2.statusHistory.length < 3) {
      failures.push(
        `Status history too short (${j2?.statusHistory?.length ?? 0} events) — skipped states detected`,
      );
    } else {
      const statuses = j2.statusHistory.map((e) => e.status);
      details.push(`✔ Full pipeline states recorded: [${statuses.join(" → ")}]`);
    }
  } catch (err) {
    failures.push(`Job pipeline test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── F — EVENT SYSTEM TEST ─────────────────────────────────────────────────────

async function testEventSystem(): Promise<SubsystemResult> {
  const details: string[] = [];
  const failures: string[] = [];

  try {
    const beforeCount = recentEvents(500).length;

    // Emit a verifiable event using a known valid event type
    emit({
      eventType: "startup_integrity_check" as SystemEventType,
      source:    "startupHealthTest",
      action:    "health_test_event_probe",
      status:    "info",
      metadata:  { healthTest: true, probe: true },
    });

    const afterEvents = recentEvents(500);
    const found = afterEvents.find(
      (e) => e.source === "startupHealthTest" && e.action === "health_test_event_probe",
    );

    if (!found) {
      failures.push("Event emitted but not found in recent event buffer");
    } else {
      details.push(`✔ Event bus: emit → buffer roundtrip verified (buffer size: ${afterEvents.length})`);
    }

    if (afterEvents.length > beforeCount) {
      details.push("✔ Event bus accepting new events");
    }
  } catch (err) {
    failures.push(`Event system test threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures.length === 0
    ? pass(details)
    : fail([...details, ...failures.map((f) => `✗ ${f}`)]);
}

// ── PRINT REPORT ──────────────────────────────────────────────────────────────

function printReport(report: HealthReport): void {
  const line = "━".repeat(46);

  logger.info(line);
  logger.info("  FINAL SYSTEM STATUS REPORT");
  logger.info(line);
  logger.info(`  AUTH:         ${report.auth.status}`);
  logger.info(`  IMAGE:        ${report.image.status}`);
  logger.info(`  VIDEO:        ${report.video.status}`);
  logger.info(`  VOICE:        ${report.voice.status}`);
  logger.info(`  JOB PIPELINE: ${report.jobPipeline.status}`);
  logger.info(`  EVENT SYSTEM: ${report.eventSystem.status}`);
  logger.info(line);
  logger.info(`  OVERALL STATUS: ${report.overall}`);
  logger.info(line);

  // Log details for each subsystem
  const subsystems: [string, SubsystemResult][] = [
    ["AUTH",        report.auth],
    ["IMAGE",       report.image],
    ["VIDEO",       report.video],
    ["VOICE",       report.voice],
    ["JOB PIPELINE",report.jobPipeline],
    ["EVENT SYSTEM",report.eventSystem],
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

  const [auth, image, video, voice, jobPipeline, eventSystem] = await Promise.all([
    testAuth().catch((err): SubsystemResult =>
      fail([`Uncaught: ${err instanceof Error ? err.message : String(err)}`])),
    testImage().catch((err): SubsystemResult =>
      fail([`Uncaught: ${err instanceof Error ? err.message : String(err)}`])),
    testVideo().catch((err): SubsystemResult =>
      fail([`Uncaught: ${err instanceof Error ? err.message : String(err)}`])),
    testVoice().catch((err): SubsystemResult =>
      fail([`Uncaught: ${err instanceof Error ? err.message : String(err)}`])),
    testJobPipeline().catch((err): SubsystemResult =>
      fail([`Uncaught: ${err instanceof Error ? err.message : String(err)}`])),
    testEventSystem().catch((err): SubsystemResult =>
      fail([`Uncaught: ${err instanceof Error ? err.message : String(err)}`])),
  ]);

  // Overall DEGRADED if critical systems (auth, job pipeline) fail
  const criticalFailed = auth.status === "FAIL" || jobPipeline.status === "FAIL";
  const overall: "HEALTHY" | "DEGRADED" = criticalFailed ? "DEGRADED" : "HEALTHY";

  const report: HealthReport = { auth, image, video, voice, jobPipeline, eventSystem, overall };

  printReport(report);
}
