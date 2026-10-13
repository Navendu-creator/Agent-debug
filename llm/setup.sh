#!/usr/bin/env bash
# Downloads the llama.cpp server binary and the default small model (Qwen3 1.7B, Q8_0, ~1.8 GB).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LLAMA_TAG="b11205"
MODEL_URL="https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf"
MODEL_SHA256="061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a"
MODEL="$DIR/models/Qwen3-1.7B-Q8_0.gguf"

mkdir -p "$DIR/bin" "$DIR/models"

if [ ! -x "$DIR/bin/llama-server" ]; then
  echo "Downloading llama.cpp $LLAMA_TAG..."
  tmp="$(mktemp)"
  curl -fSL --retry 5 -o "$tmp" \
    "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-ubuntu-x64.tar.gz"
  tar -xzf "$tmp" -C "$DIR/bin" --strip-components=1
  rm -f "$tmp"
fi

if ! echo "$MODEL_SHA256  $MODEL" | sha256sum -c --status 2>/dev/null; then
  echo "Downloading model (~1.8 GB)..."
  curl -fSL --retry 5 -C - -o "$MODEL" "$MODEL_URL"
  echo "$MODEL_SHA256  $MODEL" | sha256sum -c
fi

echo "Ready. Start with: bash $DIR/start.sh"
