"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const {
  isWin,
  STORE_ROOT,
  STORE_HOST,
  STORE_PORT,
  TTS_HOST,
  TTS_PORT,
  PID_FILE,
  STORE_LOG,
  TTS_LOG,
  resolveTtsRoot,
  venvPython,
} = require("./paths");

function fail(message) {
  console.error(message);
  process.exit(1);
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

function httpOk(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function killPort(port) {
  try {
    if (isWin) {
      const out = spawnSync(
        "cmd.exe",
        ["/c", `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /T /F`],
        { encoding: "utf8", windowsHide: true }
      );
      // Fallback via PowerShell if needed
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ],
        { windowsHide: true }
      );
      return out.status === 0;
    }
    spawnSync("sh", ["-c", `lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill -9`], {
      windowsHide: true,
    });
  } catch {
    // ignore
  }
  return false;
}

async function ensureFreshListener(port, host, healthUrl, label) {
  const listening = await portInUse(port, host);
  if (!listening) {
    return false;
  }
  if (await httpOk(healthUrl)) {
    console.log(`  • ${label} already running → ${healthUrl}`);
    return true;
  }
  console.warn(`  • ${label} port ${port} is occupied but not healthy — restarting…`);
  killPort(port);
  await new Promise((r) => setTimeout(r, 500));
  return false;
}

function waitForHttp(url, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tryOnce, 500);
    };
    tryOnce();
  });
}

function appendPid(pid) {
  fs.appendFileSync(PID_FILE, `${pid}\n`);
}

function findSystemPython() {
  const candidates = isWin
    ? [
        ["py", ["-3"]],
        ["python", []],
        ["python3", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];
  for (const [cmd, prefixArgs] of candidates) {
    const probe = spawnSync(cmd, [...prefixArgs, "--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (probe.status === 0) {
      return { cmd, prefixArgs };
    }
  }
  return null;
}

function startLoggedDetached(command, args, logPath, options = {}) {
  const out = fs.openSync(logPath, "a");
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      // Avoid shell:true — on Windows it mangles args and triggers DEP0190.
      ...options,
    });
    child.unref();
    return child;
  } finally {
    // Child keeps duplicated fds; close the parent's copies so this process can exit.
    fs.closeSync(out);
  }
}

async function main() {
  const ttsRoot = resolveTtsRoot();
  const py = venvPython(ttsRoot);
  const serverPy = path.join(ttsRoot, "apps", "web", "server.py");

  if (!fs.existsSync(py) || !fs.existsSync(serverPy)) {
    fail(
      `TTS environment not ready at ${ttsRoot}.\n` +
        "Run first: npm run install:env"
    );
  }

  fs.writeFileSync(PID_FILE, "");

  const storeUrl = `http://${STORE_HOST}:${STORE_PORT}`;
  const ttsUrl = `http://${TTS_HOST}:${TTS_PORT}`;

  console.log("Starting PoC services…");

  if (await ensureFreshListener(STORE_PORT, STORE_HOST, `${storeUrl}/`, "Demo Store")) {
    // already healthy
  } else {
    const python = findSystemPython();
    if (!python) {
      fail("Python not found. Install Python 3.12+ and reopen the terminal.");
    }
    fs.writeFileSync(STORE_LOG, "");
    const child = startLoggedDetached(
      python.cmd,
      [...python.prefixArgs, "-m", "http.server", String(STORE_PORT), "--bind", STORE_HOST],
      STORE_LOG,
      { cwd: STORE_ROOT }
    );
    appendPid(child.pid);
    console.log(`  • Started Demo Store (pid ${child.pid}) → ${storeUrl}/`);
  }

  if (await ensureFreshListener(TTS_PORT, TTS_HOST, `${ttsUrl}/api/health`, "Kokoro TTS")) {
    // already healthy
  } else {
    fs.writeFileSync(TTS_LOG, "");
    const env = {
      ...process.env,
      PYTHONPATH: [
        path.join(ttsRoot, "src"),
        process.env.PYTHONPATH || "",
      ]
        .filter(Boolean)
        .join(path.delimiter),
    };
    const child = startLoggedDetached(py, [serverPy], TTS_LOG, {
      cwd: path.join(ttsRoot, "apps", "web"),
      env,
      shell: false,
    });
    appendPid(child.pid);
    console.log(`  • Started Kokoro TTS (pid ${child.pid}) → ${ttsUrl}/api/health`);
    console.log(`    TTS root: ${ttsRoot}`);
  }

  try {
    await waitForHttp(`${storeUrl}/`);
    await waitForHttp(`${ttsUrl}/api/health`, 120000);
  } catch (err) {
    console.error(`\nWarning: ${err.message}`);
    console.error(`Check logs:\n  ${STORE_LOG}\n  ${TTS_LOG}`);
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Services ready — open in your browser:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Demo Store (kiosk UI)
    Home:     ${storeUrl}/
    Products: ${storeUrl}/products.html

  Kokoro TTS (speech API)
    Health:   ${ttsUrl}/api/health
    Studio:   ${ttsUrl}/

  Stop both services:
    npm run stop:all

  Logs:
    Demo Store: ${STORE_LOG}
    Kokoro TTS: ${TTS_LOG}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
