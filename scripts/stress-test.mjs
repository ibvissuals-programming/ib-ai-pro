#!/usr/bin/env node
/**
 * Production Stability Stress Test
 * 50 sequential + 50 concurrent chat requests, then 10-min post-test monitor.
 * Verdict: STABLE FOR PUSH or DO NOT PUSH
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { execSync } from "node:child_process";

const BASE_URL   = "http://localhost:8099";
const TOKEN      = process.argv[2] ?? "";
const SEQUENTIAL  = 50;
const CONCURRENT  = 50;
const MONITOR_S   = 600;  // 10 minutes
const INTERVAL_S  = 30;
const SNAP_EVERY  = 10;

const results  = [];
const snapshots = [];
const failures  = [];
let   startPid  = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace("T", " ").slice(11, 23);
}
function log(msg) { process.stdout.write(`[${ts()}] ${msg}\n`); }

function getPid() {
  try {
    const out = execSync("ps -eo pid,args 2>/dev/null", { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (line.includes("dist/index.mjs") && !line.includes("grep")) {
        return parseInt(line.trim().split(/\s+/)[0], 10);
      }
    }
  } catch {}
  return null;
}

function portBound(port = 8099) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const lines = fs.readFileSync(path, "utf8").split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4 && parts[3] === "0A") {
          const addrParts = parts[1].split(":");
          if (addrParts.length >= 2 && addrParts[addrParts.length - 1].toUpperCase() === hexPort) {
            return true;
          }
        }
      }
    } catch {}
  }
  return false;
}

function socketCount(pid) {
  try {
    const fds = fs.readdirSync(`/proc/${pid}/fd`);
    let count = 0;
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`).includes("socket")) count++;
      } catch {}
    }
    return count;
  } catch { return -1; }
}

function memRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/VmRSS:\s+(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  } catch { return -1; }
}

// Simple HTTP request returning { status, body, latencyMs }
function httpRequest(url, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const client = url.startsWith("https") ? https : http;
    const req = client.request(url, {
      method:  opts.method  ?? "GET",
      headers: opts.headers ?? {},
      timeout: opts.timeout ?? 30000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  () => {
        resolve({
          status:    res.statusCode,
          body:      Buffer.concat(chunks).toString("utf8"),
          latencyMs: Date.now() - t0,
        });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", (e) => resolve({ status: 0, body: "", latencyMs: Date.now() - t0, error: e.message }));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function healthCheck() {
  const r = await httpRequest(`${BASE_URL}/health`, { timeout: 5000 });
  try {
    const d = JSON.parse(r.body);
    return { ok: r.status === 200, latencyMs: r.latencyMs, status: d.status ?? "?" };
  } catch {
    return { ok: false, latencyMs: r.latencyMs, status: r.error ?? "parse-error" };
  }
}

async function sendChat(seqId) {
  const body = JSON.stringify({
    messages: [{ role: "user", content: `stress test message ${seqId}` }],
  });
  const r = await httpRequest(`${BASE_URL}/api/chat`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${TOKEN}`,
      "Accept":        "text/event-stream",
    },
    body,
    timeout: 30000,
  });

  let code = null;
  for (const line of r.body.split("\n")) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      try {
        const d = JSON.parse(l.slice(5).trim());
        if (d.error)           code = d.code ?? "unknown_error";
        else if (d.done)       code = code ?? "ok";
        else if (d.content)    code = code ?? "streaming";
        else if (d.sessionId)  code = code ?? "ok";
      } catch {}
    }
  }
  code = code ?? (r.status === 200 ? "ok" : `http_${r.status}`);

  const ok = r.status === 200 && code !== "provider_unavailable";
  return { id: seqId, ok, code, httpStatus: r.status, latencyMs: r.latencyMs, error: r.error };
}

async function takeSnapshot(label, pid) {
  const currentPid = getPid();
  const h = await healthCheck();
  // Event-loop proxy: time a second health request
  const h2 = await healthCheck();

  const snap = {
    label,
    time:        ts(),
    pid,
    pidAlive:    currentPid !== null,
    pidChanged:  currentPid !== null && currentPid !== pid ? `was ${pid} now ${currentPid}` : null,
    port8099:    portBound(8099),
    sockets:     currentPid ? socketCount(currentPid) : -1,
    memRssKb:    currentPid ? memRssKb(currentPid) : -1,
    healthOk:    h.ok,
    healthMs:    h.latencyMs,
    healthStatus: h.status,
    loopDelayMs: h2.latencyMs,
  };
  return snap;
}

function printSnapshot(snap) {
  const p = snap.pidAlive  ? "✔" : "✗";
  const o = snap.port8099  ? "✔" : "✗";
  const h = snap.healthOk  ? "✔" : "✗";
  log(`  SNAPSHOT [${snap.label}]`);
  log(`    PID alive:  ${p}  PID=${snap.pid}${snap.pidChanged ? "  ⚠ " + snap.pidChanged : ""}`);
  log(`    Port 8099:  ${o}`);
  log(`    Sockets:    ${snap.sockets}`);
  log(`    Mem RSS:    ${snap.memRssKb} kB  (${(snap.memRssKb/1024).toFixed(0)} MB)`);
  log(`    Health:     ${h}  ${snap.healthMs} ms / ${snap.healthStatus}`);
  log(`    Loop delay: ${snap.loopDelayMs} ms`);
}

function captureFail(pid, label) {
  log(`  === FAILURE CONTEXT [${label}] ===`);
  try {
    const fds = fs.readdirSync(`/proc/${pid}/fd`);
    const socks = fds.filter(f => { try { return fs.readlinkSync(`/proc/${pid}/fd/${f}`).includes("socket"); } catch { return false; } });
    log(`  FDs: ${fds.length} total, ${socks.length} sockets: [${socks.join(",")}]`);
  } catch (e) { log(`  FD table: ${e.message}`); }
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    for (const line of status.split("\n")) {
      if (/State|VmRSS|Threads/.test(line)) log(`  ${line}`);
    }
  } catch (e) { log(`  /proc/${pid}/status: ${e.message}`); }
  try {
    const tcp = fs.readFileSync("/proc/net/tcp", "utf8");
    const listeners = tcp.split("\n").filter(l => l.includes("0A"));
    log(`  TCP listeners (${listeners.length}):`);
    listeners.slice(0, 8).forEach(l => log(`    ${l.trim()}`));
  } catch (e) { log(`  /proc/net/tcp: ${e.message}`); }
}

// ── Phases ────────────────────────────────────────────────────────────────────

async function phaseSequential(pid) {
  log(`\n${"=".repeat(60)}`);
  log(`PHASE 1: ${SEQUENTIAL} SEQUENTIAL REQUESTS`);
  log("=".repeat(60));
  const codes = {};
  for (let i = 1; i <= SEQUENTIAL; i++) {
    const r = await sendChat(i);
    results.push(r);
    codes[r.code] = (codes[r.code] ?? 0) + 1;
    const s = r.ok ? "✔" : "✗";
    log(`  [${String(i).padStart(3)}] ${s}  http=${r.httpStatus}  code=${r.code}  ${r.latencyMs}ms${r.error ? "  ERR="+r.error : ""}`);
    if (i % SNAP_EVERY === 0) {
      const snap = await takeSnapshot(`seq-${i}`, pid);
      snapshots.push(snap);
      printSnapshot(snap);
      if (!snap.port8099) {
        log(`  ✗✗✗ PORT 8099 GONE at seq request ${i}`);
        failures.push({ phase: "sequential", atReq: i, snap });
        captureFail(pid, `seq-${i}`);
      }
    }
  }
  log(`\n  Sequential summary: ${JSON.stringify(codes)}`);
  return codes;
}

async function phaseConcurrent(pid) {
  log(`\n${"=".repeat(60)}`);
  log(`PHASE 2: ${CONCURRENT} CONCURRENT REQUESTS (20 workers)`);
  log("=".repeat(60));

  const tasks = Array.from({ length: CONCURRENT }, (_, i) => SEQUENTIAL + i + 1);
  const BATCH = 20;
  const codes = {};
  let done = 0;

  for (let b = 0; b < tasks.length; b += BATCH) {
    const batch = tasks.slice(b, b + BATCH);
    const settled = await Promise.all(batch.map(id => sendChat(id)));
    for (const r of settled) {
      results.push(r);
      codes[r.code] = (codes[r.code] ?? 0) + 1;
      done++;
      const s = r.ok ? "✔" : "✗";
      log(`  [c${String(r.id).padStart(3)}] ${s}  http=${r.httpStatus}  code=${r.code}  ${r.latencyMs}ms${r.error ? "  ERR="+r.error : ""}`);
    }
    if (done % SNAP_EVERY === 0) {
      const snap = await takeSnapshot(`conc-${done}`, pid);
      snapshots.push(snap);
      printSnapshot(snap);
      if (!snap.port8099) {
        log(`  ✗✗✗ PORT 8099 GONE at concurrent request ${done}`);
        failures.push({ phase: "concurrent", atReq: done, snap });
        captureFail(pid, `conc-${done}`);
      }
    }
  }
  log(`\n  Concurrent summary: ${JSON.stringify(codes)}`);
  return codes;
}

async function phaseMonitor(pid) {
  log(`\n${"=".repeat(60)}`);
  log(`PHASE 3: POST-TEST MONITOR (${MONITOR_S}s, every ${INTERVAL_S}s)`);
  log("=".repeat(60));

  const deadline = Date.now() + MONITOR_S * 1000;
  let tick = 0;

  while (Date.now() < deadline) {
    tick++;
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const snap = await takeSnapshot(`monitor-${tick}`, pid);
    snapshots.push(snap);
    printSnapshot(snap);

    // Send one chat per tick to keep server exercised
    const r = await sendChat(200 + tick);
    const s = r.ok ? "✔" : "✗";
    log(`    Monitor chat: ${s}  code=${r.code}  ${r.latencyMs}ms${r.error ? "  ERR="+r.error : ""}`);

    const bad = !snap.pidAlive || !snap.port8099 || !snap.healthOk;
    if (bad) {
      log(`  ✗✗✗ FAILURE at monitor tick ${tick}`);
      failures.push({ phase: "monitor", tick, snap });
      captureFail(pid, `monitor-${tick}`);
    }

    log(`    ${remaining}s remaining`);
    if (Date.now() < deadline) await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!TOKEN) { log("ERROR: pass JWT token as argument"); process.exit(1); }

  log("=".repeat(60));
  log("PRODUCTION STABILITY STRESS TEST");
  log("=".repeat(60));

  // ── Pre-flight ──────────────────────────────────────────────────────────────
  log("\n--- PRE-FLIGHT ---");
  const pid = getPid();
  startPid = pid;
  if (!pid) { log("✗ ABORT: no node process found"); process.exit(1); }
  log(`  PID: ${pid}`);

  const portOk = portBound(8099);
  log(`  Port 8099: ${portOk ? "✔ LISTEN in /proc/net/tcp" : "✗ not found in /proc/net/tcp"}`);

  const h = await healthCheck();
  if (!h.ok) { log(`  ✗ health not responding: ${h.status}`); process.exit(1); }
  log(`  Health: ✔ (${h.latencyMs} ms / ${h.status})`);

  const pre = await sendChat(0);
  log(`  Chat pre-flight: http=${pre.httpStatus}  code=${pre.code}  ${pre.latencyMs}ms${pre.error ? "  ERR="+pre.error : ""}`);
  if (pre.code === "provider_unavailable") {
    log("  ✗ ABORT: pre-flight returned provider_unavailable");
    process.exit(1);
  }

  const snap0 = await takeSnapshot("baseline", pid);
  snapshots.push(snap0);
  printSnapshot(snap0);

  // ── Phases ──────────────────────────────────────────────────────────────────
  const codesSeq  = await phaseSequential(pid);
  const codesConc = await phaseConcurrent(pid);

  const snapPost = await takeSnapshot("post-load", pid);
  snapshots.push(snapPost);
  printSnapshot(snapPost);

  await phaseMonitor(pid);

  // ── Final report ─────────────────────────────────────────────────────────────
  log(`\n${"=".repeat(60)}`);
  log("FINAL REPORT");
  log("=".repeat(60));

  const finalPid  = getPid();
  const finalPort = portBound(8099);
  const finalH    = await healthCheck();
  const finalChat = await sendChat(999);

  const provUnav = results.filter(r => r.code === "provider_unavailable");
  const allCodes = {};
  for (const r of results) allCodes[r.code] = (allCodes[r.code] ?? 0) + 1;

  log(`  Start PID:              ${startPid}`);
  log(`  Final PID:              ${finalPid}  ${finalPid === startPid ? "✔ unchanged" : "✗ CHANGED"}`);
  log(`  Port 8099 final:        ${finalPort ? "✔ LISTEN" : "✗ GONE"}`);
  log(`  Health final:           ${finalH.ok ? "✔" : "✗"}  ${finalH.latencyMs} ms`);
  log(`  Final chat code:        ${finalChat.code}  http=${finalChat.httpStatus}`);
  log(`  Total requests sent:    ${results.length}`);
  log(`  provider_unavailable:   ${provUnav.length}`);
  log(`  Code breakdown:         ${JSON.stringify(allCodes)}`);
  log(`  Recorded failures:      ${failures.length}`);
  for (const f of failures) log(`    - ${JSON.stringify(f)}`);

  log(`\n  Snapshot trail:`);
  for (const s of snapshots) {
    const pp = s.pidAlive ? "✔" : "✗";
    const po = s.port8099 ? "✔" : "✗";
    const ph = s.healthOk ? "✔" : "✗";
    log(`    [${s.label.padEnd(20)}] PID=${pp} PORT=${po} HEALTH=${ph} mem=${s.memRssKb}kB soc=${s.sockets} loop=${s.loopDelayMs}ms`);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────────
  log(`\n${"=".repeat(60)}`);
  const pidStable   = finalPid !== null && finalPid === startPid;
  const portStable  = finalPort;
  const healthStbl  = finalH.ok;
  const noProvUnav  = provUnav.length === 0;
  const chatReaches = finalChat.code !== "provider_unavailable";
  const noFails     = failures.length === 0;
  const passed      = pidStable && portStable && healthStbl && noProvUnav && chatReaches;

  const verdict = passed && noFails
    ? "STABLE FOR PUSH"
    : passed && !noFails
    ? "STABLE FOR PUSH (with warnings)"
    : "DO NOT PUSH";
  const sym = passed && noFails ? "✔✔✔" : passed ? "✔⚠" : "✗✗✗";

  log(`  ${sym}  VERDICT: ${verdict}`);
  log(``);
  log(`  PID stable:              ${pidStable  ? "✔" : "✗"}`);
  log(`  Port 8099 stable:        ${portStable ? "✔" : "✗"}`);
  log(`  Health stable:           ${healthStbl ? "✔" : "✗"}`);
  log(`  No provider_unavailable: ${noProvUnav ? "✔" : "✗"} (${provUnav.length} occurred)`);
  log(`  Chat reaches backend:    ${chatReaches ? "✔" : "✗"}`);
  log(`  No monitor failures:     ${noFails    ? "✔" : "✗"} (${failures.length} recorded)`);
  log("=".repeat(60));

  process.exit(passed && noFails ? 0 : 1);
}

main().catch(e => { log(`FATAL: ${e.stack}`); process.exit(1); });
