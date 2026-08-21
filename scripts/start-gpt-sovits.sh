#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gpt_root=${GPT_SOVITS_ROOT:-"$project_root/../GPT-SoVITS"}
python_bin="$gpt_root/.venv/bin/python"
host=${GPT_SOVITS_HOST:-127.0.0.1}
port=${GPT_SOVITS_PORT:-9880}
cache_root=${GPT_SOVITS_CACHE_DIR:-"$project_root/target/tmp/gpt-sovits-cache"}
source_config=${GPT_SOVITS_CONFIG:-"$gpt_root/GPT_SoVITS/configs/tts_infer.yaml"}
runtime_config="$cache_root/tts_infer.yaml"

if [[ ! -x "$python_bin" ]]; then
    echo "GPT-SoVITS Python environment not found: $python_bin" >&2
    echo "Create the environment in $gpt_root first." >&2
    exit 1
fi

if ! "$python_bin" -c 'import torchcodec' >/dev/null 2>&1; then
    echo "Installing torchcodec into the GPT-SoVITS environment..."
    uv pip install --python "$python_bin" torchcodec
fi

# Some Python audio dependencies compile caches on first launch. Keep them in the
# project so startup also works in sandboxed/read-only home environments.
export MPLCONFIGDIR=${MPLCONFIGDIR:-"$cache_root/matplotlib"}
export NUMBA_CACHE_DIR=${NUMBA_CACHE_DIR:-"$cache_root/numba"}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-"$cache_root/xdg"}
mkdir -p "$MPLCONFIGDIR" "$NUMBA_CACHE_DIR" "$XDG_CACHE_HOME"
cp "$source_config" "$runtime_config"

cd "$gpt_root"
exec "$python_bin" api_v2.py -a "$host" -p "$port" -c "$runtime_config"
