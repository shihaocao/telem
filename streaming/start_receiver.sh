#!/usr/bin/env bash
# Receive multiple video streams from Jetson over UDP
# Usage: ./start_srt_server.sh [num_streams]
#   num_streams defaults to 2
set -euo pipefail

NUM_STREAMS=${1:-2}

BASE_PORT=9000

PIDS=()
for i in $(seq 0 $((NUM_STREAMS - 1))); do
  port=$((BASE_PORT + i))
  echo "Listening for stream $((i + 1)) on udp://0.0.0.0:${port} ..."
  ffplay -window_title "Camera $((i + 1)) (port ${port})" \
    -fflags nobuffer -flags low_delay -framedrop \
    -probesize 32 -analyzeduration 0 \
    "udp://0.0.0.0:${port}" &
  PIDS+=($!)
done

echo "All receivers started. PIDs: ${PIDS[*]}"
echo "Press Ctrl+C to stop all."

cleanup() {
  echo "Stopping all receivers..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  wait
}
trap cleanup SIGINT SIGTERM

wait
