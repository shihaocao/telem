#!/usr/bin/env bash
# Stream all webcams + audio from Jetson to Mac over SRT (MPEG-TS)
# Ports: 9000, 9001 for video (max 2 cameras), 9002 for audio
set -euo pipefail

export TAILSCALE_HOST=100.99.198.13
BASE_PORT=9000
AUDIO_PORT=9002
MAX_VIDEO_STREAMS=2
SRT_LATENCY=50

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

# Find C930e device
C930E_DEV=""
for dev in "${DEVICES[@]}"; do
  if v4l2-ctl -d "$dev" --all 2>/dev/null | grep -q "C930e"; then
    C930E_DEV="$dev"
    break
  fi
done

PIDS=()
STREAM_COUNT=0
for i in "${!DEVICES[@]}"; do
  if [ "$STREAM_COUNT" -ge "$MAX_VIDEO_STREAMS" ]; then
    echo "Reached max video streams ($MAX_VIDEO_STREAMS), skipping remaining cameras"
    break
  fi

  dev="${DEVICES[$i]}"
  port=$((BASE_PORT + STREAM_COUNT))

  res=$(detect_res "$dev")
  if [ "$res" = "none" ]; then
    echo "Skipping ${dev}: no MJPEG 1080p or 720p support"
    continue
  fi

  w=${res%x*}
  h=${res#*x}


  if [ "$STREAM_COUNT" -eq 0 ]; then
    # First stream: video only (with clock overlay)
    echo "Streaming ${dev} (MJPEG ${res}) → srt://${TAILSCALE_HOST}:${port} ..."
    gst-launch-1.0 -e \
      v4l2src device="${dev}" \
      ! "image/jpeg,width=${w},height=${h},framerate=30/1" \
      ! jpegdec \
      ! clockoverlay time-format="%Y-%m-%d %H:%M:%S %Z" halignment=left valignment=bottom font-desc="monospace 6" shaded-background=true \
      ! nvvidconv ! 'video/x-raw(memory:NVMM)' \
      ! nvv4l2h264enc maxperf-enable=true ratecontrol-enable=true EnableTwopassCBR=false peak-bitrate=8000000 bitrate=4000000 iframeinterval=30 insert-sps-pps=true \
      ! h264parse ! queue max-size-time=500000000 leaky=downstream ! mpegtsmux alignment=7 \
      ! srtsink uri="srt://${TAILSCALE_HOST}:${port}?mode=caller" latency=${SRT_LATENCY} sync=false &
  else
    # Subsequent streams: video only
    echo "Streaming ${dev} (MJPEG ${res}) → srt://${TAILSCALE_HOST}:${port} ..."
    gst-launch-1.0 -e \
      v4l2src device="${dev}" \
      ! "image/jpeg,width=${w},height=${h},framerate=30/1" \
      ! jpegdec ! nvvidconv flip-method=2 ! 'video/x-raw(memory:NVMM)' \
      ! nvv4l2h264enc maxperf-enable=true ratecontrol-enable=true EnableTwopassCBR=false peak-bitrate=8000000 bitrate=4000000 iframeinterval=30 insert-sps-pps=true \
      ! h264parse ! queue max-size-time=500000000 leaky=downstream ! mpegtsmux alignment=7 \
      ! srtsink uri="srt://${TAILSCALE_HOST}:${port}?mode=caller" latency=${SRT_LATENCY} sync=false &
  fi
  PIDS+=($!)
  STREAM_COUNT=$((STREAM_COUNT + 1))
done

# Audio-only stream on fixed port 9002
echo "Streaming audio (LavMicro-U) → srt://${TAILSCALE_HOST}:${AUDIO_PORT} ..."
gst-launch-1.0 -e \
  alsasrc device=hw:LavMicroU,0 provide-clock=true slave-method=skew \
  ! queue max-size-time=500000000 leaky=downstream ! audioconvert ! audioresample \
  ! 'audio/x-raw,rate=48000,channels=1' \
  ! voaacenc bitrate=64000 \
  ! aacparse ! mpegtsmux \
  ! srtsink uri="srt://${TAILSCALE_HOST}:${AUDIO_PORT}?mode=caller" latency=${SRT_LATENCY} sync=false &
PIDS+=($!)

# Apply C930e settings after pipelines open the device
if [ -n "$C930E_DEV" ]; then
  (sleep 3 && v4l2-ctl -d "$C930E_DEV" \
    --set-ctrl=zoom_absolute=100 \
    --set-ctrl=exposure_auto=1 \
    --set-ctrl=exposure_absolute=3 \
    --set-ctrl=gain=32 \
    --set-ctrl=backlight_compensation=0 \
    --set-ctrl=brightness=128 \
    && echo "Applied C930e settings") &
  PIDS+=($!)
fi

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

# Wait for any child to exit — if a pipeline dies, kill everything and fail
while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Process $pid died, shutting down all streams"
      cleanup
      exit 1
    fi
  done
  sleep 1
done
