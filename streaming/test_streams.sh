#!/usr/bin/env bash
###############################################################################
# test_streams.sh — Quick preview of SRT streams via ffplay (run on Mac)
#
# This is NOT required for production use. OBS connects directly to the
# Jetson's SRT streams. This script is only for debugging/testing without OBS.
#
# Usage: ./test_streams.sh [num_streams]
#   num_streams defaults to 2
###############################################################################
set -euo pipefail

NUM_STREAMS=${1:-2}
BASE_PORT=9000

echo "Starting ${NUM_STREAMS} SRT listener(s)..."
echo ""

PIDS=()
for i in $(seq 0 $((NUM_STREAMS - 1))); do
  port=$((BASE_PORT + i))
  echo "Listening on srt://0.0.0.0:${port} ..."
  ffplay -window_title "Camera $((i + 1)) (port ${port})" \
    -fflags nobuffer -flags low_delay -framedrop \
    -probesize 32 -analyzeduration 0 \
    -i "srt://0.0.0.0:${port}?mode=listener" &
  PIDS+=($!)
done

echo ""
echo "All listeners started. PIDs: ${PIDS[*]}"
echo ""
echo "For OBS: add Media Source → uncheck Local File"
echo "  Input: srt://0.0.0.0:PORT?mode=listener"
echo "  (use ports ${BASE_PORT} through $((BASE_PORT + NUM_STREAMS - 1)))"
echo ""
echo "Press Ctrl+C to stop all."

cleanup() {
  echo "Stopping all listeners..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  wait
}
trap cleanup SIGINT SIGTERM

wait
