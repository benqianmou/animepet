#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target="$project_root/voice/katou-reference.wav"
source_file=${1:-}

if [[ -z "$source_file" ]]; then
    default_pack="${HOME}/Projects/katovoice"
    if [[ -d "$default_pack" ]]; then
        source_file=$(find "$default_pack" -type f \( -iname '*.wav' -o -iname '*.flac' -o -iname '*.mp3' -o -iname '*.ogg' -o -iname '*.m4a' \) -print -quit)
    fi
fi

if [[ -z "$source_file" || ! -f "$source_file" ]]; then
    cat >&2 <<'EOF'
No audio reference was found. Pass an authorized WAV, FLAC, MP3, OGG, or M4A file explicitly.

The current katovoice package contains FMOD .bank assets, which must be decoded to a normal audio file before import.
EOF
    exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "ffmpeg is required to prepare the reference WAV." >&2
    exit 1
fi

mkdir -p "$project_root/voice"
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$source_file" -map a:0 -ac 1 -ar 32000 -c:a pcm_s16le "$target"

echo "Reference audio written to $target"
echo "Set tts_enabled = true and enter this clip's exact transcript in tts_prompt_text."
