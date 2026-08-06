#!/usr/bin/env bash
# Start Demo Store (:5500) and Kokoro TTS (:7860).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PO_ROOT="$(cd "$ROOT/.." && pwd)"
PID_FILE="$ROOT/.services.pids"
STORE_HOST=127.0.0.1
STORE_PORT=5500
TTS_HOST=127.0.0.1
TTS_PORT=7860
STORE_URL="http://${STORE_HOST}:${STORE_PORT}"
TTS_URL="http://${TTS_HOST}:${TTS_PORT}"

resolve_tts() {
  if [[ -n "${TTS_ROOT:-}" && -x "${TTS_ROOT}/.venv/bin/python" ]]; then
    echo "$TTS_ROOT"
    return
  fi
  local candidates=(
    "$PO_ROOT/text-to-speech"
    "$PO_ROOT/../experiments/text-to-speech"
    "$HOME/SourceCode/experiments/text-to-speech"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -x "$c/.venv/bin/python" && -f "$c/apps/web/server.py" ]]; then
      echo "$c"
      return
    fi
  done
  return 1
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port"
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
    return $?
  fi
  return 1
}

print_open_help() {
  cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Services ready — open in your browser / tools:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Demo Store (kiosk UI)
    Home:     ${STORE_URL}/
    Home:     ${STORE_URL}/index.html
    Products: ${STORE_URL}/products.html
    Thanks:   ${STORE_URL}/thank-you.html

  Kokoro TTS (speech API)
    Health:   ${TTS_URL}/api/health
    Studio:   ${TTS_URL}/
    Speak:    POST ${TTS_URL}/api/speak

  Stop both services:
    npm run stop:all

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
}

if [[ -f "$PID_FILE" ]]; then
  echo "Note: found $PID_FILE — if ports are busy, run: npm run stop:all" >&2
fi

TTS_ROOT="$(resolve_tts)" || {
  echo "Could not find Kokoro TTS (.venv + apps/web/server.py)." >&2
  echo "Set TTS_ROOT=/path/to/text-to-speech or place it at ../text-to-speech" >&2
  exit 1
}

mkdir -p "$(dirname "$PID_FILE")"
: >"$PID_FILE"

echo "Starting PoC services…"

if port_in_use "$STORE_PORT"; then
  echo "  • Demo Store already running → ${STORE_URL}/"
else
  (
    cd "$ROOT"
    nohup python3 -m http.server "$STORE_PORT" --bind "$STORE_HOST" \
      >"$ROOT/.store.log" 2>&1 &
    echo $! >>"$PID_FILE"
  )
  echo "  • Started Demo Store (pid $(tail -n1 "$PID_FILE")) → ${STORE_URL}/"
fi

if port_in_use "$TTS_PORT"; then
  echo "  • Kokoro TTS already running → ${TTS_URL}/api/health"
else
  (
    cd "$TTS_ROOT/apps/web"
    export PYTHONPATH="$TTS_ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
    nohup "$TTS_ROOT/.venv/bin/python" server.py \
      >"$ROOT/.tts.log" 2>&1 &
    echo $! >>"$PID_FILE"
  )
  echo "  • Started Kokoro TTS (pid $(tail -n1 "$PID_FILE")) → ${TTS_URL}/api/health"
  echo "    TTS root: $TTS_ROOT"
fi

echo
echo "Logs:"
echo "  Demo Store: $ROOT/.store.log"
echo "  Kokoro TTS: $ROOT/.tts.log"

print_open_help
