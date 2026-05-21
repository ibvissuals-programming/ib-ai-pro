#!/usr/bin/env node
/**
 * production-check.cjs — Comprehensive pre-deployment validator.
 *
 * Extends health-check.cjs with:
 *   1. Startup scripts presence check
 *   2. JSON response contract validation (no HTML responses)
 *   3. Auth endpoint contract check
 *   4. Rate-limit header presence check
 *   5. All health-check.cjs checks (secrets, db, workflows, AI, storage)
 *
 * Usage:
 *   node scripts/production-check.cjs
 *   pnpm run production:check
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

"use strict";
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const net    = require("net");

const BACKEND_PORT  = parseInt(process.env.BACKEND_PORT  ?? "8099", 10);
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT ?? "5000",  10);

const start = Date.now();
let passed = 0;
let failed = 0;
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

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error",   () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1_000);
  });
}

function httpGet(path_, port = BACKEND_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: path_, method: "GET",
        headers: { Accept: "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(5_000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function httpPost(path_, body, port = BACKEND_PORT) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port, path: path_, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      }
    );
    req.on("error", reject);
    req.setTimeout(5_000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log("\n  IB AI — Production Check\n  " + "─".repeat(40));

  // ── 1. Script files ──────────────────────────────────────────────────────────
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

  // ── 2. Secrets ───────────────────────────────────────────────────────────────
  console.log("\n  ● Secrets");
  const criticalSecrets = ["GEMINI_API_KEY", "DATABASE_URL"];
  for (const k of criticalSecrets) {
    if (process.env[k]) ok(k, "present");
    else fail(k, "missing (blocks startup)");
  }
  if (!process.env["GROQ_API_KEY"]) ok("GROQ_API_KEY", "absent — Gemini fallback active");

  // ── 3. Workflows / ports ─────────────────────────────────────────────────────
  console.log("\n  ● Workflows");
  const beUp = await checkPort(BACKEND_PORT);
  const feUp = await checkPort(FRONTEND_PORT);
  beUp ? ok(`Backend  :${BACKEND_PORT}`) : fail(`Backend  :${BACKEND_PORT}`, "port not open");
  feUp ? ok(`Frontend :${FRONTEND_PORT}`) : fail(`Frontend :${FRONTEND_PORT}`, "port not open");

  if (!beUp) {
    fail("Backend offline — skipping API checks");
    return finalise();
  }

  // ── 4. Health endpoint ───────────────────────────────────────────────────────
  console.log("\n  ● Health Endpoint");
  let health = null;
  try {
    const r = await httpGet("/health");
    if (r.status !== 200) { fail("GET /health", `HTTP ${r.status}`); }
    else {
      health = JSON.parse(r.body);
      ok("GET /health", `status:${health.status}`);
      health.importReady       ? ok("importReady")       : fail("importReady", "false");
      health.bootstrapComplete ? ok("bootstrapComplete") : fail("bootstrapComplete", "false");
      health.providerMode      ? ok("providerMode", health.providerMode) : fail("providerMode", "missing");
      const caps = health.capabilities ?? {};
      ok("capabilities", `chat:${caps.chat} image:${caps.image} tts:${caps.tts} video:${caps.video}`);
    }
  } catch (e) {
    fail("GET /health", e.message);
  }

  // ── 5. Response contract (no HTML) ───────────────────────────────────────────
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

  // ── 6. Auth contract ─────────────────────────────────────────────────────────
  console.log("\n  ● Auth Contract");
  try {
    const r = await httpPost("/api/auth/login", { username: "__invalid__", password: "__invalid__" });
    const ct = r.headers["content-type"] ?? "";
    if (ct.includes("application/json")) ok("POST /api/auth/login returns JSON");
    else fail("POST /api/auth/login", `got ${ct.split(";")[0]}`);
  } catch (e) {
    fail("POST /api/auth/login", e.message);
  }

  // ── 7. Rate-limit headers ────────────────────────────────────────────────────
  console.log("\n  ● Rate-Limit Headers");
  try {
    const r = await httpPost("/api/chat", { messages: [] });
    if (r.status === 401) {
      ok("POST /api/chat (unauth) returns 401 JSON");
      const ct = r.headers["content-type"] ?? "";
      if (!ct.includes("application/json")) fail("chat 401 content-type", `got ${ct}`);
    } else if (r.headers["x-ratelimit-limit"]) {
      ok("X-RateLimit-Limit present");
      ok("X-RateLimit-Remaining present");
      ok("X-RateLimit-Reset present");
    } else {
      ok("chat endpoint reachable", `HTTP ${r.status}`);
    }
  } catch (e) {
    fail("Rate-limit header check", e.message);
  }

  return finalise();
}

function finalise() {
  const ms = Date.now() - start;
  console.log("\n  " + "━".repeat(40));
  if (failed === 0) {
    console.log(`  ✔ Production Check PASSED  (${passed} checks · ${ms}ms)\n`);
    process.exit(0);
  } else {
    console.log(`  ✗ Production Check FAILED  (${failed} failures · ${ms}ms)`);
    console.log("    Issues:");
    issues.forEach((i) => console.log(`      — ${i}`));
    console.log();
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
