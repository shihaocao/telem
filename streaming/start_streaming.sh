#!/usr/bin/env bash
# Stream all webcams from Jetson to Mac over UDP
# Each camera gets its own port: 9000, 9001, 9002, ...
set -euo pipefail

export TAILSCALE_HOST=100.99.198.13
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

# Configure C930e: narrow FOV via zoom, fixed exposure
for dev in "${DEVICES[@]}"; do
  if v4l2-ctl -d "$dev" --all 2>/dev/null | grep -q "C930e"; then
    v4l2-ctl -d "$dev" \
      --set-ctrl=zoom_absolute=200 \
      --set-ctrl=exposure_auto=1 \
      --set-ctrl=exposure_absolute=10 \
      --set-ctrl=gain=0
    echo "Configured ${dev} (C930e): zoom=200, manual exposure"
    break
  fi
done

# Detect best MJPEG resolution for a device (must be under MJPG section)
detect_res() {
  local dev="$1"
  local formats
  formats=$(v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null)

  # Extract only the MJPG section
  local mjpg_section
  mjpg_section=$(echo "$formats" | sed -n '/MJPG/,/^\[/p')

  if [ -z "$mjpg_section" ]; then
    echo "none"
    return
  fi

  for res in 1920x1080 1280x720; do
    if echo "$mjpg_section" | grep -q "${res}"; then
      echo "$res"
      return
    fi
  done

  echo "none"
}

PIDS=()
for i in "${!DEVICES[@]}"; do
  dev="${DEVICES[$i]}"
  port=$((BASE_PORT + i))

  res=$(detect_res "$dev")
  if [ "$res" = "none" ]; then
    echo "Skipping ${dev}: no MJPEG 1080p or 720p support"
    continue
  fi

  w=${res%x*}
  h=${res#*x}
  if [ "$i" -eq 0 ]; then
    echo "Streaming ${dev} (MJPEG ${res} + audio) → udp://${TAILSCALE_HOST}:${port} ..."
    gst-launch-1.0 -e \
      v4l2src device="${dev}" \
      ! "image/jpeg,width=${w},height=${h},framerate=30/1" \
      ! jpegdec ! nvvidconv flip-method=2 ! 'video/x-raw(memory:NVMM)' \
      ! nvv4l2h264enc maxperf-enable=true ratecontrol-enable=true EnableTwopassCBR=false peak-bitrate=8000000 bitrate=4000000 iframeinterval=30 insert-sps-pps=true \
      ! h264parse ! mux. \
      alsasrc device=hw:C930e,0 provide-clock=false slave-method=none \
      ! queue ! audioconvert ! audioresample \
      ! 'audio/x-raw,rate=48000,channels=1' \
      ! voaacenc bitrate=128000 \
      ! aacparse ! mux. \
      mpegtsmux name=mux alignment=7 \
      ! udpsink host="${TAILSCALE_HOST}" port="${port}" sync=false &
  else
    echo "Streaming ${dev} (MJPEG ${res}) → udp://${TAILSCALE_HOST}:${port} ..."
    gst-launch-1.0 -e \
      v4l2src device="${dev}" \
      ! "image/jpeg,width=${w},height=${h},framerate=30/1" \
      ! jpegdec ! nvvidconv flip-method=2 ! 'video/x-raw(memory:NVMM)' \
      ! nvv4l2h264enc maxperf-enable=true ratecontrol-enable=true EnableTwopassCBR=false peak-bitrate=8000000 bitrate=4000000 iframeinterval=30 insert-sps-pps=true \
      ! h264parse ! mpegtsmux alignment=7 \
      ! udpsink host="${TAILSCALE_HOST}" port="${port}" sync=false &
  fi
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
