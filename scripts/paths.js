"use strict";

const fs = require("fs");
const path = require("path");

const isWin = process.platform === "win32";
const STORE_ROOT = path.resolve(__dirname, "..");
const PO_ROOT = path.resolve(STORE_ROOT, "..");

const STORE_HOST = "127.0.0.1";
const STORE_PORT = 5500;
const TTS_HOST = "127.0.0.1";
const TTS_PORT = 7860;

const PID_FILE = path.join(STORE_ROOT, ".services.pids");
const STORE_LOG = path.join(STORE_ROOT, ".store.log");
const TTS_LOG = path.join(STORE_ROOT, ".tts.log");

function resolveTtsRoot() {
  if (process.env.TTS_ROOT) {
    return path.resolve(process.env.TTS_ROOT);
  }
  const candidates = [
    path.join(PO_ROOT, "text-to-speech"),
    path.join(PO_ROOT, "..", "experiments", "text-to-speech"),
    path.join(process.env.HOME || process.env.USERPROFILE || "", "SourceCode", "experiments", "text-to-speech"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "apps", "web", "server.py"))) {
      return candidate;
    }
  }
  return path.join(PO_ROOT, "text-to-speech");
}

function venvPython(ttsRoot) {
  return isWin
    ? path.join(ttsRoot, ".venv", "Scripts", "python.exe")
    : path.join(ttsRoot, ".venv", "bin", "python");
}

function venvPip(ttsRoot) {
  return isWin
    ? path.join(ttsRoot, ".venv", "Scripts", "pip.exe")
    : path.join(ttsRoot, ".venv", "bin", "pip");
}

module.exports = {
  isWin,
  STORE_ROOT,
  PO_ROOT,
  STORE_HOST,
  STORE_PORT,
  TTS_HOST,
  TTS_PORT,
  PID_FILE,
  STORE_LOG,
  TTS_LOG,
  resolveTtsRoot,
  venvPython,
  venvPip,
};
