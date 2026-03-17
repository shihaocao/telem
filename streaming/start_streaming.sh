#!/usr/bin/env bash
# Stream webcam from Jetson to Mac over UDP
set -euo pipefail

export SRT_TAILSCALE_HOST=100.99.198.13
PORT=9000
DEVICE=/dev/video0

echo "Streaming ${DEVICE} → udp://${SRT_TAILSCALE_HOST}:${PORT} ..."
gst-launch-1.0 -e \
  v4l2src device="${DEVICE}" \
  ! image/jpeg,width=1920,height=1080,framerate=30/1 \
  ! jpegdec ! nvvidconv ! 'video/x-raw(memory:NVMM)' \
  ! nvv4l2h264enc bitrate=8000000 iframeinterval=15 insert-sps-pps=true \
  ! h264parse ! mpegtsmux alignment=7 \
  ! udpsink host="${SRT_TAILSCALE_HOST}" port="${PORT}" sync=false
