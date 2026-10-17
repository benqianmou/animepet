#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
whisper_root="${project_root}/whisper.cpp"
server="${whisper_root}/build/bin/whisper-server"
model="${whisper_root}/models/ggml-base.bin"

if [[ ! -x "${server}" ]]; then
  echo "whisper.cpp server not found: ${server}" >&2
  echo "Build it with: cmake -B build -DWHISPER_BUILD_SERVER=ON && cmake --build build -j2" >&2
  exit 1
fi
if [[ ! -f "${model}" ]]; then
  echo "Whisper model not found: ${model}" >&2
  echo "Download it with: bash models/download-ggml-model.sh base" >&2
  exit 1
fi

exec "${server}" \
  -m "${model}" \
  --host 127.0.0.1 \
  --port 8081 \
  --convert
