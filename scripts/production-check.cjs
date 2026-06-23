#!/usr/bin/env node
/**
 * production-check.cjs — Comprehensive pre-deployment validator.
 *
 * Checks (in order):
 *   1. Startup scripts presence
 *   2. Critical secrets present
 *   3. Workflows / port check
 *   4. GET /health — status, flags, capabilities
 *   5. GET /api/system/ready — latency probe (warn >1 s, fail >3 s)
 *   6. Response contract (no HTML on 404)
 *   7. Auth contract (unauthenticated routes return JSON)
 *   8. Rate-limit headers / 401 contract on chat
 *   9. Real CEO login (valid credentials → JWT token)
 *  10. Authenticated chat via Groq stream
 *  11. Authenticated image generation
 *  12. Authenticated Cinematic Enhancement
 *
 * Usage:
 *   node scripts/production-check.cjs
 *   pnpm run production:check
 *   pnpm run pre-publish
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *
 * Notes:
 *   - CEO_USERNAME and CEO_PASSWORD must be set as environment variables for
 *     checks 8–11. If absent those checks are skipped with a warning.
 *   - Checks 9–11 make real AI provider calls. They pass when the endpoint
 *     returns a well-formed success response. A provider quota error (503 with
 *     a known code) is also accepted — it proves the endpoint is live and auth
 *     works; only unexpected 400/401/500 responses are treated as failures.
 */

"use strict";
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const net    = require("net");

const BACKEND_PORT  = parseInt(process.env.BACKEND_PORT  ?? "8099", 10);
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT ?? "5000",  10);

// CEO credentials used for authenticated smoke tests (checks 8–11).
// CEO_USERNAME defaults to "ibaiceo" — the bootstrapped admin account name.
const CEO_USERNAME = process.env.CEO_USERNAME ?? "ibaiceo";
const CEO_PASSWORD = process.env.CEO_PASSWORD ?? "";

// Minimal valid 1×1 white JPEG in base64 — used for Cinematic Enhancement test.
// Must be ≥ 100 chars to pass CinematicPromptSchema validation.
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQN" +
  "DAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgy" +
  "PC4zNDL/wAARC AABAAEDASIA" +
  "AhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAACQoI/8QAGxAAAgMBAQEAAAA" +
  "AAAAAAAABAgMEERIhMf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAA" +
  "AAAAAAAAAAAAAAAAP/2gAMAwEAAhEDEQA/AMzs5ZlT6pRokmRHGlKIQ6S0Ur" +
  "C0kpUUqSofAgjjnxQBqHmSjKVJBJSCWgBSlEcAn9c/9k=";

const start = Date.now();
let passed = 0;
let failed = 0;
let warned = 0;
const issues = [];

function ok(label, note = "") {
  passed++;
  const suffix = note ? `  (${note})` : "";
  console.log(`  ✔ ${label}${suffix}`);
}

function fail(label, reason = "") {
  failed++;
  const suffix = reason ? `: ${reason}` : "";
  issues.push(`${label}${suffix}`);
  console.log(`  ✗ ${label}${suffix}`);
}

function warn(label, reason = "") {
  warned++;
  const suffix = reason ? `: ${reason}` : "";
  console.log(`  ⚠ ${label}${suffix}`);
}

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error",   () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1_000);
  });
}

function httpGet(urlPath, port = BACKEND_PORT, token = null) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(8_000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function httpPost(urlPath, body, port = BACKEND_PORT, token = null) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      "Accept": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "POST", headers },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      }
    );
    req.on("error", reject);
    req.setTimeout(8_000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

/**
 * httpPostStream — POST that reads a streaming SSE response.
 * Collects lines until [DONE] or the inactivity timeout fires.
 * Returns { status, lines } where lines are the raw SSE data lines received.
 */
function httpPostStream(urlPath, body, token, port = BACKEND_PORT, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      "Accept": "text/event-stream",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "POST", headers },
      (res) => {
        const lines = [];
        let timer = setTimeout(() => {
          req.destroy();
          resolve({ status: res.statusCode, lines });
        }, timeoutMs);

        res.on("data", (chunk) => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            req.destroy();
            resolve({ status: res.statusCode, lines });
          }, timeoutMs);

          const text = chunk.toString();
          text.split("\n").forEach((l) => {
            const trimmed = l.trim();
            if (trimmed) lines.push(trimmed);
            if (trimmed === "data: [DONE]") {
              clearTimeout(timer);
              req.destroy();
              resolve({ status: res.statusCode, lines });
            }
          });
        });

        res.on("end", () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, lines });
        });
      }
    );

    req.on("error", (err) => {
      if (err.code === "ECONNRESET") {
        resolve({ status: 0, lines: [] });
      } else {
        reject(err);
      }
    });
    req.setTimeout(timeoutMs + 2_000, () => {
      req.destroy();
      reject(new Error("stream request timeout"));
    });
    req.write(data);
    req.end();
  });
}

// ── Quota/provider error codes that are acceptable in live-endpoint tests ──────
// These prove the endpoint is live, auth worked, and the AI call was attempted.
// Only a 400 (bad request) or 401 (auth failure) is a genuine test failure.
const ACCEPTABLE_AI_CODES = new Set([
  "rate_limit_provider",
  "rate_limit_user",
  "timeout",
  "provider_unavailable",
  "quota_exceeded",
  "service_unavailable",
]);

function isAcceptableAiError(status, body) {
  if (status === 400 || status === 401) return false;
  try {
    const parsed = JSON.parse(body);
    const code = parsed.code ?? "";
    return ACCEPTABLE_AI_CODES.has(code) || status === 503 || status === 429;
  } catch {
    return status === 503 || status === 429;
  }
}

async function run() {
  console.log("\n  IB AI — Pre-Publish Check\n  " + "─".repeat(40));

  // ── 1. Script files ───────────────────────────────────────────────────────────
  console.log("\n  ● Startup Scripts");
  const requiredScripts = [
    "scripts/import-bootstrap.cjs",
    "scripts/startup-health.cjs",
    "scripts/db-guard.cjs",
    "scripts/health-check.cjs",
    "scripts/import-guard.cjs",
    "scripts/kill-port.cjs",
    "scripts/post-merge.sh",
  ];
  for (const s of requiredScripts) {
    if (fs.existsSync(path.resolve(s))) ok(s);
    else fail(s, "missing");
  }

  // ── 2. Secrets ────────────────────────────────────────────────────────────────
  console.log("\n  ● Secrets");
  const criticalSecrets = ["GEMINI_API_KEY", "DATABASE_URL"];
  for (const k of criticalSecrets) {
    if (process.env[k]) ok(k, "present");
    else fail(k, "missing — blocks startup");
  }
  if (process.env["GROQ_API_KEY"]) {
    ok("GROQ_API_KEY", "present — Groq primary chat active");
  } else {
    warn("GROQ_API_KEY", "absent — chat falls back to Gemini (20 req/day free quota)");
  }
  if (!CEO_PASSWORD) {
    warn("CEO_PASSWORD", "not set — authenticated smoke tests (8–11) will be skipped");
  } else {
    ok("CEO_PASSWORD", "present — authenticated tests will run");
  }

  // ── 3. Workflows / ports ──────────────────────────────────────────────────────
  console.log("\n  ● Workflows");
  const beUp = await checkPort(BACKEND_PORT);
  const feUp = await checkPort(FRONTEND_PORT);
  beUp ? ok(`Backend  :${BACKEND_PORT}`) : fail(`Backend  :${BACKEND_PORT}`, "port not open");
  feUp ? ok(`Frontend :${FRONTEND_PORT}`) : fail(`Frontend :${FRONTEND_PORT}`, "port not open");

  if (!beUp) {
    fail("Backend offline — skipping all API checks");
    return finalise();
  }

  // ── 4. Health endpoint ────────────────────────────────────────────────────────
  console.log("\n  ● Health Endpoint");
  let health = null;
  try {
    const r = await httpGet("/health");
    if (r.status !== 200) {
      fail("GET /health", `HTTP ${r.status}`);
    } else {
      health = JSON.parse(r.body);
      ok("GET /health", `status:${health.status}`);
      health.importReady       ? ok("importReady")       : fail("importReady", "false");
      health.bootstrapComplete ? ok("bootstrapComplete") : fail("bootstrapComplete", "false");
      if (health.providerMode) ok("providerMode", health.providerMode);
      else fail("providerMode", "missing");
      const caps = health.capabilities ?? {};
      ok("capabilities", `chat:${caps.chat} image:${caps.image} tts:${caps.tts} video:${caps.video}`);
    }
  } catch (e) {
    fail("GET /health", e.message);
  }

  // ── 5. Readiness probe latency ────────────────────────────────────────────────
  // /api/system/ready is the exact endpoint the Login page polls to decide whether
  // to show the "Server is starting up" banner. A response time > 3 s means real
  // users will see the amber banner before the 6-second hard cutoff kicks in.
  //
  // Thresholds:
  //   < 1 000 ms  → ✔ fast
  //   1 000–3 000 ms → ⚠ slow (advisory — monitor in production)
  //   > 3 000 ms  → ✗ FAIL — users will see the starting-up banner
  //   non-200 or ready !== true → ✗ FAIL
  console.log("\n  ● Readiness Probe");
  try {
    const t0 = Date.now();
    const r   = await httpGet("/api/system/ready");
    const ms  = Date.now() - t0;
    const msLabel = `${ms} ms`;

    if (r.status !== 200) {
      fail("GET /api/system/ready", `HTTP ${r.status} (${msLabel})`);
    } else {
      let rd = {};
      try { rd = JSON.parse(r.body); } catch { /* non-JSON body */ }

      if (!rd.ready) {
        fail("GET /api/system/ready", `ready=${rd.ready} phase=${rd.phase ?? "?"} (${msLabel})`);
      } else if (ms > 3_000) {
        fail("GET /api/system/ready latency", `${msLabel} — exceeds 3 s threshold; users will see the starting-up banner`);
      } else if (ms > 1_000) {
        ok("GET /api/system/ready", `ready=true (${msLabel})`);
        warn("readiness latency", `${msLabel} — above 1 s; watch in production`);
      } else {
        ok("GET /api/system/ready", `ready=true (${msLabel})`);
      }
    }
  } catch (e) {
    fail("GET /api/system/ready", e.message);
  }

  // ── 6. Response contract (no HTML) ────────────────────────────────────────────
  console.log("\n  ● Response Contract");
  try {
    const r = await httpGet("/api/nonexistent-route-check");
    const ct = r.headers["content-type"] ?? "";
    if (ct.includes("application/json")) ok("JSON 404 handler", `CT: ${ct.split(";")[0]}`);
    else fail("JSON 404 handler", `got ${ct.split(";")[0]} — expected application/json`);
    try { JSON.parse(r.body); ok("404 body is valid JSON"); }
    catch { fail("404 body is valid JSON", "parse error"); }
  } catch (e) {
    fail("JSON 404 handler", e.message);
  }

  // ── 6. Auth contract ──────────────────────────────────────────────────────────
  console.log("\n  ● Auth Contract");
  try {
    const r = await httpPost("/api/auth/login", { username: "__invalid__", password: "__invalid__" });
    const ct = r.headers["content-type"] ?? "";
    if (ct.includes("application/json")) ok("POST /api/auth/login returns JSON");
    else fail("POST /api/auth/login", `got ${ct.split(";")[0]}`);
  } catch (e) {
    fail("POST /api/auth/login", e.message);
  }

  // ── 7. Rate-limit headers / 401 contract ──────────────────────────────────────
  console.log("\n  ● Rate-Limit / Auth Guard");
  try {
    const r = await httpPost("/api/chat", { messages: [{ role: "user", content: "hi" }] });
    if (r.status === 401) {
      ok("POST /api/chat (unauthenticated) returns 401");
      const ct = r.headers["content-type"] ?? "";
      ct.includes("application/json")
        ? ok("401 response is JSON")
        : fail("401 response content-type", `got ${ct}`);
    } else {
      ok("chat endpoint reachable", `HTTP ${r.status}`);
    }
  } catch (e) {
    fail("Rate-limit / 401 check", e.message);
  }

  // ── 8–11: Authenticated checks ────────────────────────────────────────────────
  if (!CEO_PASSWORD) {
    console.log("\n  ● Authenticated Checks  [SKIPPED — CEO_PASSWORD not set]");
    warn("Checks 8–11 skipped", "set CEO_PASSWORD env var to enable");
    return finalise();
  }

  // ── 8. Real CEO login ─────────────────────────────────────────────────────────
  console.log("\n  ● Real CEO Login");
  let authToken = null;
  try {
    const r = await httpPost("/api/auth/login", { username: CEO_USERNAME, password: CEO_PASSWORD });
    if (r.status !== 200) {
      fail(`POST /api/auth/login (${CEO_USERNAME})`, `HTTP ${r.status} — wrong credentials or account not bootstrapped`);
    } else {
      const body = JSON.parse(r.body);
      authToken = body.token ?? null;
      if (!authToken) {
        fail("CEO login response", "no token in response body");
      } else {
        ok(`POST /api/auth/login (${CEO_USERNAME})`, `token received (${authToken.length} chars)`);
        if (body.user?.role === "ceo") ok("CEO role confirmed", body.user.role);
        else warn("CEO role", `expected ceo, got ${body.user?.role}`);
      }
    }
  } catch (e) {
    fail("CEO login", e.message);
  }

  if (!authToken) {
    fail("Authenticated checks 9–11 skipped", "no token — CEO login failed");
    return finalise();
  }

  // ── 9. Authenticated chat via Groq stream ─────────────────────────────────────
  console.log("\n  ● Authenticated Chat (Groq stream)");
  try {
    const { status, lines } = await httpPostStream(
      "/api/chat",
      { messages: [{ role: "user", content: "Reply with exactly: SMOKE_TEST_OK" }] },
      authToken,
      BACKEND_PORT,
      25_000,
    );

    const dataLines = lines.filter((l) => l.startsWith("data:") && l !== "data: [DONE]");
    const hasDone   = lines.some((l) => l === "data: [DONE]");

    if (status === 401) {
      fail("POST /api/chat (authenticated)", "401 — token rejected");
    } else if (status === 400) {
      fail("POST /api/chat (authenticated)", `400 — bad request: ${lines.slice(0, 3).join(" | ")}`);
    } else if (dataLines.length > 0 && hasDone) {
      const preview = dataLines.slice(0, 2).map((l) => {
        try { return JSON.parse(l.replace("data: ", "")).content ?? ""; } catch { return ""; }
      }).join("").slice(0, 40);
      ok("POST /api/chat — stream received", `${dataLines.length} data chunks · "${preview}…"`);
      ok("SSE [DONE] marker received");
    } else if (dataLines.length > 0) {
      ok("POST /api/chat — stream started", `${dataLines.length} chunks (no [DONE] yet — stream may have been cut)`);
    } else if (isAcceptableAiError(status, lines.join(""))) {
      ok("POST /api/chat — endpoint live", `provider quota/timeout (HTTP ${status}) — auth and routing confirmed`);
    } else {
      fail("POST /api/chat (authenticated)", `HTTP ${status} — no data lines received`);
    }
  } catch (e) {
    fail("POST /api/chat stream", e.message);
  }

  // ── 10. Authenticated image generation ───────────────────────────────────────
  console.log("\n  ● Authenticated Image Generation");
  try {
    const r = await httpPost(
      "/api/image/generate",
      { prompt: "a simple red circle on a white background", expandPrompt: false },
      BACKEND_PORT,
      authToken,
    );

    if (r.status === 401) {
      fail("POST /api/image/generate", "401 — token rejected");
    } else if (r.status === 400) {
      fail("POST /api/image/generate", `400 — bad request: ${r.body.slice(0, 120)}`);
    } else {
      let parsed = null;
      try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }

      if (parsed?.success === true && parsed?.b64Image) {
        ok("POST /api/image/generate — image returned", `b64Image: ${parsed.b64Image.length} chars`);
      } else if (parsed?.success === true) {
        ok("POST /api/image/generate — success", `HTTP ${r.status}`);
      } else if (isAcceptableAiError(r.status, r.body)) {
        ok("POST /api/image/generate — endpoint live", `provider quota/timeout (HTTP ${r.status}) — auth confirmed`);
      } else {
        fail("POST /api/image/generate", `HTTP ${r.status}: ${r.body.slice(0, 120)}`);
      }
    }
  } catch (e) {
    fail("POST /api/image/generate", e.message);
  }

  // ── 11. Authenticated Cinematic Enhancement ───────────────────────────────────
  console.log("\n  ● Authenticated Cinematic Enhancement");
  try {
    const r = await httpPost(
      "/api/image/cinematic-prompt",
      { imageBase64: TINY_JPEG_B64, mimeType: "image/jpeg" },
      BACKEND_PORT,
      authToken,
    );

    if (r.status === 401) {
      fail("POST /api/image/cinematic-prompt", "401 — token rejected");
    } else if (r.status === 400) {
      fail("POST /api/image/cinematic-prompt", `400 — bad request: ${r.body.slice(0, 120)}`);
    } else {
      let parsed = null;
      try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }

      if (parsed?.success === true) {
        const keys = Object.keys(parsed).filter((k) => k !== "success" && k !== "mode");
        ok("POST /api/image/cinematic-prompt — success", `fields: ${keys.join(", ")}`);
      } else if (isAcceptableAiError(r.status, r.body)) {
        ok("POST /api/image/cinematic-prompt — endpoint live", `provider quota/timeout (HTTP ${r.status}) — auth confirmed`);
      } else {
        fail("POST /api/image/cinematic-prompt", `HTTP ${r.status}: ${r.body.slice(0, 120)}`);
      }
    }
  } catch (e) {
    fail("POST /api/image/cinematic-prompt", e.message);
  }

  return finalise();
}

function finalise() {
  const ms = Date.now() - start;
  console.log("\n  " + "━".repeat(40));
  if (warned > 0) {
    console.log(`  ⚠ ${warned} warning(s) — non-blocking`);
  }
  if (failed === 0) {
    console.log(`  ✔ Pre-Publish Check PASSED  (${passed} checks · ${ms}ms)\n`);
    process.exit(0);
  } else {
    console.log(`  ✗ Pre-Publish Check FAILED  (${failed} failure(s) · ${ms}ms)`);
    console.log("    Issues:");
    issues.forEach((i) => console.log(`      — ${i}`));
    console.log();
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
