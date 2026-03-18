#!/usr/bin/env bash
# Generate SDP files for RTP streams and open OBS
# Usage: ./start_receiver.sh [num_streams]
#   num_streams defaults to 2
set -euo pipefail

NUM_STREAMS=${1:-2}
BASE_PORT=9000
SDP_DIR="$(cd "$(dirname "$0")" && pwd)/sdp"

mkdir -p "$SDP_DIR"

for i in $(seq 0 $((NUM_STREAMS - 1))); do
  port=$((BASE_PORT + i))
  cat > "$SDP_DIR/camera_$((i + 1)).sdp" <<EOF
v=0
m=video ${port} RTP/AVP 96
c=IN IP4 0.0.0.0
a=rtpmap:96 H264/90000
EOF
  echo "Created $SDP_DIR/camera_$((i + 1)).sdp (port ${port})"
done

echo ""
echo "SDP files ready in $SDP_DIR"
echo "In OBS, add Media Source → Local File → point to each .sdp file"
echo "FFmpeg options: protocol_whitelist=file,udp,rtp fflags=nobuffer flags=low_delay probesize=32 analyzeduration=0"
echo ""
echo "Opening OBS..."
open -a OBS
