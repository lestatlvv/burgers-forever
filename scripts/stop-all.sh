#!/usr/bin/env bash
# Stop Demo Store (:5500) and Kokoro TTS (:7860).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.services.pids"
STORE_PORT=5500
TTS_PORT=7860

kill_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.2
    kill -9 "$pid" 2>/dev/null || true
    echo "Stopped pid $pid"
  fi
}

kill_port() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    echo "Freed port $port (fuser)"
    return
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)"
  fi
  if [[ -z "$pids" ]]; then
    echo "Nothing listening on :$port"
    return
  fi
  local pid
  for pid in $pids; do
    kill_pid "$pid"
  done
  echo "Freed port $port"
}

if [[ -f "$PID_FILE" ]]; then
  while read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    kill_pid "$pid"
  done <"$PID_FILE"
  rm -f "$PID_FILE"
fi

kill_port "$STORE_PORT"
kill_port "$TTS_PORT"
echo "All services stopped."
