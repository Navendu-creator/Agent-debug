#!/usr/bin/env bash
# Starts the Nagent backend (8080) and frontend (5173). Ollama runs separately (`ollama serve`).
set -e

cd "$(dirname "$0")"
PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT INT TERM

port_busy() { ss -lnt | grep -q ":$1 "; }

OLLAMA_URL=$(grep -E '^OLLAMA_BASE_URL=' backend/.env 2>/dev/null | cut -d= -f2-)
OLLAMA_URL=${OLLAMA_URL:-http://127.0.0.1:11434}
if curl -fsS -m 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  echo "Ollama reachable at $OLLAMA_URL"
else
  echo "⚠ Ollama not reachable at $OLLAMA_URL — run 'ollama serve' (or use demo analysis in the UI)"
fi

if port_busy 8080; then
  echo "Backend already running on 8080."
else
  echo "Starting backend on 8080..."
  npm --prefix backend run dev &
  PIDS+=($!)
fi
  
npm --prefix project run dev -- --host 127.0.0.1 --port 5173
