"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const {
  isWin,
  STORE_HOST,
  STORE_PORT,
  TTS_HOST,
  TTS_PORT,
  PID_FILE,
} = require("./paths");

function killPid(pid) {
  if (!pid || Number.isNaN(pid)) return;
  try {
    if (isWin) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    console.log(`Stopped pid ${pid}`);
  } catch {
    // process may already be gone
  }
}

function pidsOnPort(port) {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8",
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (pid) pids.add(pid);
      }
      return [...pids];
    }

    try {
      const out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t`, {
        encoding: "utf8",
      });
      return out
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter(Boolean);
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

function portInUse(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function freePort(port, host) {
  const pids = pidsOnPort(port);
  if (!pids.length) {
    if (!(await portInUse(port, host))) {
      console.log(`Nothing listening on :${port}`);
      return;
    }
  }
  for (const pid of pids) {
    killPid(pid);
  }
  console.log(`Freed port ${port}`);
}

async function main() {
  if (fs.existsSync(PID_FILE)) {
    const pids = fs
      .readFileSync(PID_FILE, "utf8")
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter(Boolean);
    for (const pid of pids) {
      killPid(pid);
    }
    fs.unlinkSync(PID_FILE);
  }

  await freePort(STORE_PORT, STORE_HOST);
  await freePort(TTS_PORT, TTS_HOST);
  console.log("All services stopped.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
