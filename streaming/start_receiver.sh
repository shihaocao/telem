#!/usr/bin/env bash
# Generate SDP files for RTP streams, start audio receiver, and open OBS
# Usage: ./start_receiver.sh [num_streams]
#   num_streams defaults to 2
set -euo pipefail

NUM_STREAMS=${1:-2}
BASE_PORT=9000
SDP_DIR="$(cd "$(dirname "$0")" && pwd)/sdp"

mkdir -p "$SDP_DIR"

for i in $(seq 0 $((NUM_STREAMS - 1))); do
  port=$((BASE_PORT + i * 2))
  cat > "$SDP_DIR/camera_$((i + 1)).sdp" <<EOF
v=0
m=video ${port} RTP/AVP 96
c=IN IP4 0.0.0.0
a=rtpmap:96 H264/90000
EOF
  chmod 644 "$SDP_DIR/camera_$((i + 1)).sdp"
  echo "Created $SDP_DIR/camera_$((i + 1)).sdp (port ${port})"
done

# Audio receiver — plays raw PCM from Jetson mic locally
AUDIO_PORT=$((BASE_PORT + NUM_STREAMS * 2))
echo "Receiving audio on udp://0.0.0.0:${AUDIO_PORT} ..."
ffplay -nodisp -fflags nobuffer -flags low_delay \
  -probesize 32 -analyzeduration 0 \
  -f s16le -ar 48000 -ch_layout mono \
  -infbuf -framedrop \
  "udp://0.0.0.0:${AUDIO_PORT}" &
AUDIO_PID=$!

echo ""
echo "SDP files ready in $SDP_DIR"
echo "Audio playing locally from port ${AUDIO_PORT} — capture in OBS via Audio Output Capture"
echo ""
echo "Opening OBS..."
open -a OBS

cleanup() {
  echo "Stopping audio receiver..."
  kill "$AUDIO_PID" 2>/dev/null
  wait
}
trap cleanup SIGINT SIGTERM

wait
