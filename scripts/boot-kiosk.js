"use strict";

/**
 * Start Demo Store + TTS, then open the kiosk UI in Chrome fullscreen.
 * Used at login / boot and via `npm run start:kiosk` / `npm start`.
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  isWin,
  STORE_ROOT,
  STORE_HOST,
  STORE_PORT,
  STORE_LOG,
  TTS_LOG,
} = require("./paths");

const BOOT_LOG = path.join(STORE_ROOT, ".boot.log");

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(BOOT_LOG, line);
  } catch {
    // ignore log write failures
  }
  console.log(message);
}

function readRegistryDefault(regPath) {
  if (!isWin) return null;
  const result = spawnSync(
    "reg",
    ["query", regPath, "/ve"],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) return null;
  const match = String(result.stdout || "").match(/REG_SZ\s+(.+)$/m);
  if (!match) return null;
  const value = match[1].trim().replace(/^"|"$/g, "");
  return value && fs.existsSync(value) ? value : null;
}

function findBrowser() {
  if (process.env.KIOSK_BROWSER && fs.existsSync(process.env.KIOSK_BROWSER)) {
    return process.env.KIOSK_BROWSER;
  }

  const fromRegistry = [
    readRegistryDefault("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe"),
    readRegistryDefault("HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe"),
    readRegistryDefault("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe"),
  ].filter(Boolean);

  const candidates = isWin
    ? [
        ...fromRegistry,
        path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function waitForHttp(url, timeoutMs = 90000) {
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
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

function openFullscreen(url) {
  const browser = findBrowser();
  const profileDir = path.join(STORE_ROOT, ".kiosk-browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });

  if (!browser) {
    log("No Chrome/Edge found — opening default browser.");
    if (isWin) {
      spawnSync("cmd.exe", ["/c", "start", "", url], { windowsHide: true });
    }
    return false;
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    "--kiosk",
    "--start-fullscreen",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-infobars",
    "--check-for-update-interval=31536000",
    "--autoplay-policy=no-user-gesture-required",
    "--new-window",
    url,
  ];

  log(`Opening kiosk browser: ${browser}`);
  log(`URL: ${url}`);

  if (isWin) {
    // Start-Process returns immediately; `cmd start` can block under npm/node.
    const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(",");
    const ps = `Start-Process -FilePath '${browser.replace(/'/g, "''")}' -ArgumentList @(${argList}) -WindowStyle Maximized`;
    log(`Launch via PowerShell Start-Process`);
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, cwd: STORE_ROOT, encoding: "utf8" }
    );
    if (result.status !== 0) {
      log(`Start-Process failed (status ${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
      log("Trying direct spawn…");
      const child = spawn(browser, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        cwd: STORE_ROOT,
      });
      child.on("error", (err) => log(`Browser spawn error: ${err.message}`));
      child.unref();
    }
  } else {
    const child = spawn(browser, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => log(`Browser spawn error: ${err.message}`));
    child.unref();
  }

  return true;
}

function startServicesInBackground() {
  const startScript = path.join(__dirname, "start-services.js");
  log(`Starting services via ${startScript}`);
  const child = spawn(process.execPath, [startScript], {
    cwd: STORE_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });

  const append = (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    try {
      fs.appendFileSync(BOOT_LOG, text);
    } catch {
      // ignore
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.unref();
  return child;
}

async function main() {
  fs.writeFileSync(BOOT_LOG, "");
  log("Boot kiosk starting…");

  const delaySec = Number(process.env.KIOSK_BOOT_DELAY_SEC || "0");
  if (delaySec > 0) {
    log(`Waiting ${delaySec}s before starting services…`);
    await new Promise((r) => setTimeout(r, delaySec * 1000));
  }

  startServicesInBackground();

  const storeUrl = `http://${STORE_HOST}:${STORE_PORT}/`;
  log(`Waiting for Demo Store at ${storeUrl}`);
  try {
    await waitForHttp(storeUrl, 90000);
  } catch (err) {
    log(String(err.message || err));
    log(`Check logs: ${STORE_LOG} / ${TTS_LOG}`);
    process.exit(1);
  }

  log(`Store ready — launching fullscreen UI`);
  const opened = openFullscreen(storeUrl);
  if (!opened) {
    log("Could not open Chrome/Edge. Set KIOSK_BROWSER to the chrome.exe path.");
    process.exit(1);
  }

  // Give the browser a moment to start before this process exits.
  await new Promise((r) => setTimeout(r, 1500));
  log("Boot kiosk done.");
}

main().catch((err) => {
  console.error(err);
  try {
    fs.appendFileSync(BOOT_LOG, String(err) + "\n");
  } catch {
    // ignore
  }
  process.exit(1);
});
