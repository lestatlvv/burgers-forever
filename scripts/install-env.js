"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  isWin,
  resolveTtsRoot,
  venvPython,
  venvPip,
} = require("./paths");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    // Avoid shell:true — on Windows it mangles -c / quoted args.
    windowsHide: true,
    ...options,
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    fail(`Command failed with exit code ${result.status}`);
  }
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

function main() {
  const ttsRoot = resolveTtsRoot();
  const requirements = path.join(ttsRoot, "requirements.txt");
  const server = path.join(ttsRoot, "apps", "web", "server.py");

  if (!fs.existsSync(requirements) || !fs.existsSync(server)) {
    fail(
      `Could not find text-to-speech at ${ttsRoot}.\n` +
        "Clone it next to burgers-forever, or set TTS_ROOT."
    );
  }

  const python = findSystemPython();
  if (!python) {
    fail("Python 3.12+ not found. Install Python and reopen the terminal.");
  }

  const py = venvPython(ttsRoot);
  const pip = venvPip(ttsRoot);
  const venvDir = path.join(ttsRoot, ".venv");

  console.log(`TTS root: ${ttsRoot}`);

  if (!fs.existsSync(py)) {
    console.log("Creating virtual environment (.venv)…");
    run(python.cmd, [...python.prefixArgs, "-m", "venv", venvDir], {
      cwd: ttsRoot,
    });
  } else {
    console.log("Virtual environment already exists.");
  }

  if (!fs.existsSync(py)) {
    fail(`Expected venv Python at ${py}`);
  }

  console.log("Upgrading pip…");
  run(py, ["-m", "pip", "install", "--upgrade", "pip"], { cwd: ttsRoot });

  console.log("Installing TTS requirements…");
  run(pip, ["install", "-r", requirements], { cwd: ttsRoot });

  console.log("Checking PyTorch import…");
  const torchCheck = spawnSync(
    py,
    ["-c", "import torch; print(torch.__version__)"],
    { encoding: "utf8", windowsHide: true }
  );
  if (torchCheck.status !== 0) {
    console.error(torchCheck.stderr || torchCheck.stdout || "torch import failed");
    if (isWin) {
      fail(
        "PyTorch failed to load. On Windows install Microsoft Visual C++ Redistributable:\n" +
          "  https://aka.ms/vs/17/release/vc_redist.x64.exe\n" +
          "  winget install --id Microsoft.VCRedist.2015+.x64 -e\n" +
          "Then re-run: npm run install:env"
      );
    }
    fail("PyTorch import failed. Fix the error above and retry.");
  }
  console.log(`torch ${String(torchCheck.stdout).trim()} OK`);

  console.log("\nEnvironment ready.");
  console.log("Start both services with: npm start");
}

main();
