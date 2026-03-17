#!/usr/bin/env bash
# Stream all webcams from Jetson to Mac over UDP
# Each camera gets its own port: 9000, 9001, 9002, ...
set -euo pipefail

export SRT_TAILSCALE_HOST=100.99.198.13
BASE_PORT=9000

# Find all video capture devices (skip metadata/control nodes)
DEVICES=()
for dev in /dev/video*; do
  [ -e "$dev" ] || continue
  if v4l2-ctl -d "$dev" --all 2>/dev/null | grep -q "Format Video Capture:"; then
    DEVICES+=("$dev")
  fi
done

if [ ${#DEVICES[@]} -eq 0 ]; then
  echo "No video capture devices found"
  exit 1
fi

echo "Found ${#DEVICES[@]} camera(s): ${DEVICES[*]}"

PIDS=()
for i in "${!DEVICES[@]}"; do
  dev="${DEVICES[$i]}"
  port=$((BASE_PORT + i))
  echo "Streaming ${dev} → udp://${SRT_TAILSCALE_HOST}:${port} ..."
  gst-launch-1.0 -e \
    v4l2src device="${dev}" \
    ! image/jpeg,width=1920,height=1080,framerate=30/1 \
    ! jpegdec ! nvvidconv ! 'video/x-raw(memory:NVMM)' \
    ! nvv4l2h264enc bitrate=8000000 iframeinterval=15 insert-sps-pps=true \
    ! h264parse ! mpegtsmux alignment=7 \
    ! udpsink host="${SRT_TAILSCALE_HOST}" port="${port}" sync=false &
  PIDS+=($!)
done

echo "All streams started. PIDs: ${PIDS[*]}"
echo "Press Ctrl+C to stop all."

cleanup() {
  echo "Stopping all streams..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  wait
}
trap cleanup SIGINT SIGTERM

wait
