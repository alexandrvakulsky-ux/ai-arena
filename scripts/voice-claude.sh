#!/usr/bin/env bash
# Voice prompt for Claude Code — record speech, transcribe via OpenAI Whisper, print transcript.
#
# Usage:
#   vc                      # record, print transcript to stdout
#   claude -p "$(vc)"       # use as a one-shot Claude prompt
#   vc | claude             # pipe transcript to Claude interactive session
#
# Requirements:
#   - OPENAI_API_KEY in environment or /workspace/.env
#   - parecord (WSLg PulseAudio, installed via pulseaudio-utils) OR sox
#   - WSLg audio: container must mount /mnt/wslg/runtime-dir and set PULSE_SERVER

set -euo pipefail

# Load env vars from /workspace/.env if present
if [ -f /workspace/.env ]; then
    set -a
    # shellcheck disable=SC1091
    source <(grep -E '^[A-Z_]+=.' /workspace/.env | grep -v '^#')
    set +a
fi

WHISPER_KEY="${OPENAI_API_KEY:-}"
if [ -z "$WHISPER_KEY" ]; then
    echo "Error: OPENAI_API_KEY not set. Add it to /workspace/.env" >&2
    exit 1
fi

TMPFILE=$(mktemp /tmp/voice-XXXXXX.wav)
cleanup() { rm -f "$TMPFILE"; }
trap cleanup EXIT

# Detect recording method
PULSE_SOCK="${PULSE_SERVER#unix:}"
CAN_PARECORD=false
CAN_SOX=false

if command -v parecord &>/dev/null && [ -S "$PULSE_SOCK" ] 2>/dev/null; then
    CAN_PARECORD=true
elif command -v sox &>/dev/null; then
    CAN_SOX=true
fi

if ! $CAN_PARECORD && ! $CAN_SOX; then
    echo "Error: no audio recording tool available." >&2
    echo "  - For WSL2: ensure container mounts /mnt/wslg/runtime-dir and PULSE_SERVER is set" >&2
    echo "  - parecord (pulseaudio-utils) or sox must be installed in the container" >&2
    exit 1
fi

echo "Recording... press Enter to stop" >&2

if $CAN_PARECORD; then
    parecord --format=s16le --rate=16000 --channels=1 --file-format=wav "$TMPFILE" &
    REC_PID=$!
    read -r < /dev/tty
    kill "$REC_PID" 2>/dev/null; wait "$REC_PID" 2>/dev/null || true
else
    sox -d -r 16000 -c 1 -e signed-integer -b 16 "$TMPFILE" &
    REC_PID=$!
    read -r < /dev/tty
    kill "$REC_PID" 2>/dev/null; wait "$REC_PID" 2>/dev/null || true
fi

if [ ! -s "$TMPFILE" ]; then
    echo "Error: no audio recorded (file is empty)" >&2
    exit 1
fi

echo "Transcribing..." >&2

RESPONSE=$(curl -sf https://api.openai.com/v1/audio/transcriptions \
    -H "Authorization: Bearer $WHISPER_KEY" \
    -F "file=@${TMPFILE};type=audio/wav" \
    -F "model=whisper-1")

TRANSCRIPT=$(echo "$RESPONSE" | jq -r '.text // empty')

if [ -z "$TRANSCRIPT" ]; then
    echo "Error: transcription failed. API response:" >&2
    echo "$RESPONSE" >&2
    exit 1
fi

echo "$TRANSCRIPT"
