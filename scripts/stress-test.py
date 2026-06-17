#!/usr/bin/env python3
"""
Production Stability Stress Test
Tests whether the backend HTTP listener survives 100 concurrent/sequential
chat requests and 10 minutes of post-test monitoring.
"""

import subprocess, sys, os, time, json, threading, urllib.request, urllib.error
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Configuration ─────────────────────────────────────────────────────────────
BASE_URL   = "http://localhost:8099"
TOKEN      = sys.argv[1] if len(sys.argv) > 1 else ""
SEQUENTIAL = 50
CONCURRENT = 50
MONITOR_DURATION_S = 600   # 10 minutes
MONITOR_INTERVAL_S = 30
SNAPSHOT_EVERY_N   = 10

# ── State ─────────────────────────────────────────────────────────────────────
results      = []
snapshots    = []
failures     = []
lock         = threading.Lock()
start_pid    = None

# ── Helpers ───────────────────────────────────────────────────────────────────

def ts():
    return datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]

def log(msg):
    print(f"[{ts()}] {msg}", flush=True)

def get_pid():
    try:
        r = subprocess.run(
            ["ps", "-eo", "pid,args"],
            capture_output=True, text=True
        )
        for line in r.stdout.splitlines():
            if "dist/index.mjs" in line and "grep" not in line:
                return int(line.split()[0])
    except Exception:
        pass
    return None

def port_bound(port=8099):
    """Check /proc/net/tcp directly — port in hex big-endian."""
    hex_port = format(port, '04X')
    for path in ["/proc/net/tcp", "/proc/net/tcp6"]:
        try:
            with open(path) as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 4 and parts[3] == "0A":
                        # local_address is ip:port, port is last 4 hex chars
                        addr_port = parts[1].split(":")
                        if len(addr_port) == 2 and addr_port[1].upper() == hex_port:
                            return True
        except Exception:
            pass
    return False

def socket_count(pid):
    try:
        fds = os.listdir(f"/proc/{pid}/fd")
        return sum(1 for f in fds if "socket" in
                   os.readlink(f"/proc/{pid}/fd/{f}"))
    except Exception:
        return -1

def mem_rss_kb(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except Exception:
        return -1

def health_latency_ms():
    """Returns (ok, latency_ms). ok=True means port is bound and responding."""
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(f"{BASE_URL}/health")
        with urllib.request.urlopen(req, timeout=5) as r:
            body = r.read()
            ms = int((time.monotonic() - t0) * 1000)
            data = json.loads(body)
            return True, ms, data.get("status", "?")
    except Exception as e:
        ms = int((time.monotonic() - t0) * 1000)
        return False, ms, str(e)

def take_snapshot(label, pid):
    snap = {
        "label":     label,
        "time":      ts(),
        "pid":       pid,
        "pid_alive": False,
        "port_8099": False,
        "sockets":   -1,
        "mem_rss_kb": -1,
        "health_ok": False,
        "health_ms": -1,
        "health_status": "",
    }
    current_pid = get_pid()
    snap["pid_alive"] = current_pid is not None
    if current_pid and current_pid != pid:
        snap["pid_changed"] = f"WARN: was {pid}, now {current_pid}"
    snap["port_8099"]   = port_bound(8099)
    if current_pid:
        snap["sockets"]    = socket_count(current_pid)
        snap["mem_rss_kb"] = mem_rss_kb(current_pid)
    ok, ms, status = health_latency_ms()
    snap["health_ok"]     = ok
    snap["health_ms"]     = ms
    snap["health_status"] = status

    # Event-loop delay proxy: time a fast OPTIONS / HEAD to /health
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(f"{BASE_URL}/health", method="HEAD")
        with urllib.request.urlopen(req, timeout=5) as r:
            pass
        snap["loop_delay_ms"] = int((time.monotonic() - t0) * 1000)
    except Exception:
        snap["loop_delay_ms"] = -1

    return snap

def print_snapshot(snap):
    pid_ok  = "✔" if snap["pid_alive"]  else "✗"
    port_ok = "✔" if snap["port_8099"]  else "✗"
    hlt_ok  = "✔" if snap["health_ok"]  else "✗"
    warn    = snap.get("pid_changed", "")
    log(f"  SNAPSHOT [{snap['label']}]")
    log(f"    PID alive:    {pid_ok}  PID={snap['pid']}")
    log(f"    Port 8099:    {port_ok}")
    log(f"    Sockets:      {snap['sockets']}")
    log(f"    Mem RSS:      {snap['mem_rss_kb']} kB")
    log(f"    Health:       {hlt_ok}  ({snap['health_ms']} ms / {snap['health_status']})")
    log(f"    Loop delay:   {snap['loop_delay_ms']} ms")
    if warn:
        log(f"    ⚠ PID CHANGED: {warn}")

# ── Chat request ──────────────────────────────────────────────────────────────

def send_chat(seq_id):
    """
    Send one SSE chat request. Reads until stream closes.
    Returns dict: {id, ok, code, http_status, latency_ms, error}
    """
    payload = json.dumps({
        "messages": [{"role": "user", "content": f"stress test message {seq_id}"}]
    }).encode()
    t0 = time.monotonic()
    result = {"id": seq_id, "ok": False, "code": None,
              "http_status": None, "latency_ms": 0, "error": None}
    try:
        req = urllib.request.Request(
            f"{BASE_URL}/api/chat",
            data=payload,
            headers={
                "Content-Type":  "application/json",
                "Authorization": f"Bearer {TOKEN}",
                "Accept":        "text/event-stream",
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            result["http_status"] = r.status
            body = b""
            while True:
                chunk = r.read(4096)
                if not chunk:
                    break
                body += chunk
            ms = int((time.monotonic() - t0) * 1000)
            result["latency_ms"] = ms
            text = body.decode(errors="replace")
            # Parse SSE lines for error code
            for line in text.splitlines():
                if line.startswith("data:"):
                    try:
                        d = json.loads(line[5:].strip())
                        if d.get("error"):
                            result["code"] = d.get("code", "unknown_error")
                        elif d.get("done"):
                            result["code"] = "ok"
                        elif "content" in d:
                            result["code"] = result["code"] or "streaming"
                    except Exception:
                        pass
            if result["code"] is None:
                result["code"] = "ok" if result["http_status"] == 200 else "empty"
            result["ok"] = result["http_status"] == 200 and result["code"] != "provider_unavailable"
    except urllib.error.HTTPError as e:
        result["http_status"] = e.code
        result["error"]       = f"HTTP {e.code}"
        result["ok"]          = False
    except Exception as e:
        result["error"]       = str(e)[:120]
        result["ok"]          = False
    result["latency_ms"] = int((time.monotonic() - t0) * 1000)
    return result

# ── Test phases ───────────────────────────────────────────────────────────────

def phase_sequential(pid):
    log(f"\n{'='*60}")
    log(f"PHASE 1: {SEQUENTIAL} SEQUENTIAL REQUESTS")
    log('='*60)
    codes = {}
    for i in range(1, SEQUENTIAL + 1):
        r = send_chat(i)
        with lock:
            results.append(r)
            codes[r["code"]] = codes.get(r["code"], 0) + 1
        status = "✔" if r["ok"] else "✗"
        log(f"  [{i:3d}] {status}  http={r['http_status']}  code={r['code']}  {r['latency_ms']}ms"
            + (f"  ERR={r['error']}" if r["error"] else ""))
        if i % SNAPSHOT_EVERY_N == 0:
            snap = take_snapshot(f"seq-{i}", pid)
            with lock:
                snapshots.append(snap)
            print_snapshot(snap)
            # FAIL-FAST: listener gone
            if not snap["port_8099"]:
                log("  ✗✗✗ PORT 8099 GONE — recording failure")
                with lock:
                    failures.append({"phase": "sequential", "at_req": i, "snap": snap})
    log(f"\n  Sequential summary: {codes}")
    return codes

def phase_concurrent(pid):
    log(f"\n{'='*60}")
    log(f"PHASE 2: {CONCURRENT} CONCURRENT REQUESTS")
    log('='*60)
    codes = {}
    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {pool.submit(send_chat, SEQUENTIAL + i): i
                   for i in range(1, CONCURRENT + 1)}
        completed = 0
        for fut in as_completed(futures):
            r = fut.result()
            completed += 1
            with lock:
                results.append(r)
                codes[r["code"]] = codes.get(r["code"], 0) + 1
            status = "✔" if r["ok"] else "✗"
            log(f"  [c{r['id']:3d}] {status}  http={r['http_status']}  code={r['code']}  {r['latency_ms']}ms"
                + (f"  ERR={r['error']}" if r["error"] else ""))
            if completed % SNAPSHOT_EVERY_N == 0:
                snap = take_snapshot(f"conc-{completed}", pid)
                with lock:
                    snapshots.append(snap)
                print_snapshot(snap)
                if not snap["port_8099"]:
                    log("  ✗✗✗ PORT 8099 GONE — recording failure")
                    with lock:
                        failures.append({"phase": "concurrent", "at_req": completed, "snap": snap})
    log(f"\n  Concurrent summary: {codes}")
    return codes

def phase_monitor(pid):
    log(f"\n{'='*60}")
    log(f"PHASE 3: POST-TEST MONITOR ({MONITOR_DURATION_S}s every {MONITOR_INTERVAL_S}s)")
    log('='*60)
    deadline = time.monotonic() + MONITOR_DURATION_S
    tick     = 0
    while time.monotonic() < deadline:
        tick += 1
        remaining = int(deadline - time.monotonic())
        snap = take_snapshot(f"monitor-{tick}", pid)
        with lock:
            snapshots.append(snap)
        print_snapshot(snap)
        # Additionally send one chat request every monitor tick to keep the server exercised
        r = send_chat(200 + tick)
        chat_ok = "✔" if r["ok"] else "✗"
        log(f"    Monitor chat: {chat_ok}  code={r['code']}  {r['latency_ms']}ms"
            + (f"  ERR={r['error']}" if r["error"] else ""))
        if not snap["port_8099"] or not snap["pid_alive"] or not snap["health_ok"]:
            log(f"  ✗✗✗ FAILURE at monitor tick {tick}")
            with lock:
                failures.append({"phase": "monitor", "tick": tick, "snap": snap})
            # Capture full failure context
            capture_failure_context(pid, tick)
        log(f"    {remaining}s remaining in monitor phase")
        if time.monotonic() < deadline:
            time.sleep(MONITOR_INTERVAL_S)

def capture_failure_context(pid, label):
    log(f"\n  === FAILURE CONTEXT (label={label}) ===")
    # TCP listener table
    for path in ["/proc/net/tcp", "/proc/net/tcp6"]:
        try:
            with open(path) as f:
                lines = [l for l in f if l.split()[3:4] == ["0A"]] if False else f.readlines()
            log(f"  {path}: {len(lines)} lines")
            for line in lines[:5]:
                log(f"    {line.rstrip()}")
        except Exception as e:
            log(f"  {path}: {e}")
    # FD table of pid
    try:
        fds = os.listdir(f"/proc/{pid}/fd")
        sockets = [f for f in fds if "socket" in os.readlink(f"/proc/{pid}/fd/{f}")]
        log(f"  /proc/{pid}/fd: {len(fds)} total, {len(sockets)} sockets: {sockets[:10]}")
    except Exception as e:
        log(f"  FD table: {e}")
    # Status
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if any(k in line for k in ["State", "VmRSS", "Threads"]):
                    log(f"  {line.rstrip()}")
    except Exception as e:
        log(f"  Status: {e}")
    # Recent backend log
    try:
        r = subprocess.run(["tail", "-20", "/tmp/logs/IB_AI_Backend_20260617_011119_047.log"],
                           capture_output=True, text=True)
        log(f"  Backend log tail:\n{r.stdout[-2000:]}")
    except Exception as e:
        log(f"  Log tail: {e}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global start_pid
    if not TOKEN:
        log("ERROR: pass JWT token as first argument")
        sys.exit(1)

    log("=" * 60)
    log("PRODUCTION STABILITY STRESS TEST")
    log("=" * 60)

    # PRE-FLIGHT
    log("\n--- PRE-FLIGHT ---")
    pid = get_pid()
    start_pid = pid
    if not pid:
        log("✗ ABORT: No node process found running dist/index.mjs")
        sys.exit(1)
    log(f"  PID: {pid}")

    # Port check
    if not port_bound(8099):
        log("  WARN: /proc/net/tcp port 8099 not found — using health as proxy")
    else:
        log("  Port 8099: ✔")

    # Health check
    ok, ms, status = health_latency_ms()
    if not ok:
        log(f"  ✗ Health not responding: {status}")
        sys.exit(1)
    log(f"  Health: ✔ ({ms} ms / {status})")

    # One chat request pre-flight
    r = send_chat(0)
    log(f"  Chat pre-flight: http={r['http_status']}  code={r['code']}  {r['latency_ms']}ms"
        + (f"  ERR={r['error']}" if r["error"] else ""))
    if r["code"] == "provider_unavailable":
        log("  ✗ ABORT: pre-flight returned provider_unavailable (backend not reachable)")
        sys.exit(1)

    # Baseline snapshot
    snap0 = take_snapshot("baseline", pid)
    snapshots.append(snap0)
    print_snapshot(snap0)

    # ── PHASE 1: Sequential ──────────────────────────────────────────────────
    codes_seq = phase_sequential(pid)

    # ── PHASE 2: Concurrent ──────────────────────────────────────────────────
    codes_conc = phase_concurrent(pid)

    # Post-load snapshot
    snap_post = take_snapshot("post-load", pid)
    with lock:
        snapshots.append(snap_post)
    print_snapshot(snap_post)

    # ── PHASE 3: 10-minute post-test monitor ─────────────────────────────────
    phase_monitor(pid)

    # ── FINAL REPORT ─────────────────────────────────────────────────────────
    log(f"\n{'='*60}")
    log("FINAL REPORT")
    log('='*60)

    final_pid  = get_pid()
    final_port = port_bound(8099)
    ok, ms, _  = health_latency_ms()
    final_chat = send_chat(999)

    all_ok    = [r for r in results if r["ok"]]
    prov_unav = [r for r in results if r["code"] == "provider_unavailable"]
    all_codes = {}
    for r in results:
        all_codes[r["code"]] = all_codes.get(r["code"], 0) + 1

    log(f"  Start PID:          {start_pid}")
    log(f"  Final PID:          {final_pid}  {'✔ unchanged' if final_pid == start_pid else '✗ CHANGED'}")
    log(f"  Port 8099 bound:    {'✔' if final_port else '✗'}")
    log(f"  Health responds:    {'✔' if ok else '✗'}  ({ms} ms)")
    log(f"  Final chat:         code={final_chat['code']}  http={final_chat['http_status']}")
    log(f"  Total requests:     {len(results)}")
    log(f"  Requests reached backend: {len(all_ok) + len([r for r in results if r['code'] in ('rate_limit','provider_not_configured','model_overloaded','ok','streaming')])}")
    log(f"  provider_unavailable:    {len(prov_unav)}")
    log(f"  Code breakdown:     {all_codes}")
    log(f"  Recorded failures:  {len(failures)}")
    for f in failures:
        log(f"    - {f}")

    log(f"\n  Snapshot trail:")
    for s in snapshots:
        pid_ok  = "✔" if s["pid_alive"] else "✗"
        port_ok = "✔" if s["port_8099"] else "✗"
        hlt_ok  = "✔" if s["health_ok"] else "✗"
        log(f"    [{s['label']:20s}] PID={pid_ok} PORT={port_ok} HEALTH={hlt_ok} "
            f"mem={s['mem_rss_kb']}kB sockets={s['sockets']} loop={s['loop_delay_ms']}ms")

    # ── VERDICT ───────────────────────────────────────────────────────────────
    log(f"\n{'='*60}")
    pid_stable   = final_pid == start_pid and final_pid is not None
    port_stable  = final_port
    health_ok    = ok
    no_prov_unav = len(prov_unav) == 0
    no_failures  = len(failures)  == 0
    chat_reached = final_chat["code"] != "provider_unavailable"

    passed = pid_stable and port_stable and health_ok and no_prov_unav and chat_reached

    if passed and no_failures:
        verdict = "STABLE FOR PUSH"
        sym = "✔✔✔"
    elif passed and not no_failures:
        verdict = "STABLE FOR PUSH (with warnings)"
        sym = "✔⚠"
    else:
        verdict = "DO NOT PUSH"
        sym = "✗✗✗"

    log(f"  {sym}  VERDICT: {verdict}")
    log(f"")
    log(f"  PID stable:              {'✔' if pid_stable   else '✗'}")
    log(f"  Port 8099 stable:        {'✔' if port_stable  else '✗'}")
    log(f"  Health stable:           {'✔' if health_ok    else '✗'}")
    log(f"  No provider_unavailable: {'✔' if no_prov_unav else '✗'} ({len(prov_unav)} occurred)")
    log(f"  Chat reaches backend:    {'✔' if chat_reached else '✗'}")
    log(f"  No monitor failures:     {'✔' if no_failures  else '✗'} ({len(failures)} recorded)")
    log('='*60)

    sys.exit(0 if (passed and no_failures) else 1)

if __name__ == "__main__":
    main()
