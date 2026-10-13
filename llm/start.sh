#!/usr/bin/env bash
# Local LLM for the DebugAssist agent: llama.cpp's llama-server with a small GGUF model.
# Serves an OpenAI-compatible API (with tool calling) on http://127.0.0.1:${LLM_PORT:-8081}/v1
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL="${LLM_GGUF:-$DIR/models/Qwen3-1.7B-Q8_0.gguf}"

if [ ! -f "$MODEL" ]; then
  echo "Model not found: $MODEL — run: bash $DIR/setup.sh" >&2
  exit 1
fi

# --reasoning-budget 0 turns off Qwen3's <think> phase: much faster on CPU, fine for tool use.
exec env LD_LIBRARY_PATH="$DIR/bin" "$DIR/bin/llama-server" \
  -m "$MODEL" \
  --host 127.0.0.1 --port "${LLM_PORT:-8081}" \
  --alias "${LLM_ALIAS:-qwen3-1.7b}" \
  --jinja \
  --reasoning-budget 0 \
  -c "${LLM_CTX:-16384}"
