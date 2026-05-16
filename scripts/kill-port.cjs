#!/usr/bin/env node
// kill-port.js <port>
// Kills the process listening on the given TCP port using /proc/net/tcp(6).
// Requires only Node.js built-ins — no lsof, fuser, or netstat needed.
const fs = require("fs");
const port = parseInt(process.argv[2], 10);
if (!port || isNaN(port)) process.exit(0);

const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
console.log(`[kill-port] scanning for PID on port ${port} (hex ${hexPort})`);

function findInodes(file) {
  const inodes = [];
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      if (p[3] !== "0A") continue;
      const localAddr = p[1] || "";
      if (!localAddr.endsWith(":" + hexPort)) continue;
      if (p[9]) inodes.push(p[9]);
    }
  } catch (_) {}
  return inodes;
}

function killByInodes(inodes) {
  if (inodes.length === 0) return;
  const inodeSet = new Set(inodes.map((i) => `socket:[${i}]`));
  let procDirs;
  try {
    procDirs = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch (_) {
    return;
  }
  for (const pid of procDirs) {
    try {
      const fds = fs.readdirSync(`/proc/${pid}/fd`);
      for (const fd of fds) {
        try {
          const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (inodeSet.has(link)) {
            console.log(
              `[kill-port] SIGKILL → PID ${pid} (${link}) — port ${port}`,
            );
            try {
              process.kill(parseInt(pid, 10), "SIGKILL");
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
}

const inodes = [
  ...findInodes("/proc/net/tcp"),
  ...findInodes("/proc/net/tcp6"),
];

killByInodes(inodes);
if (inodes.length === 0) {
  console.log(`[kill-port] port ${port} is free`);
}
setTimeout(() => process.exit(0), 200);
