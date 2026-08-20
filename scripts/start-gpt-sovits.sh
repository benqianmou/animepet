#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gpt_root=${GPT_SOVITS_ROOT:-"$project_root/../GPT-SoVITS"}
python_bin="$gpt_root/.venv/bin/python"
host=${GPT_SOVITS_HOST:-127.0.0.1}
port=${GPT_SOVITS_PORT:-9880}

if [[ ! -x "$python_bin" ]]; then
    echo "GPT-SoVITS Python environment not found: $python_bin" >&2
    echo "Create the environment in $gpt_root first." >&2
    exit 1
fi

if ! "$python_bin" -c 'import torchcodec' >/dev/null 2>&1; then
    echo "Installing torchcodec into the GPT-SoVITS environment..."
    uv pip install --python "$python_bin" torchcodec
fi

cd "$gpt_root"
exec "$python_bin" api_v2.py -a "$host" -p "$port"
