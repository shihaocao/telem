#!/usr/bin/env bash
# Receive video stream from Jetson over UDP
set -euo pipefail

PORT=9000

echo "Listening for stream on udp://0.0.0.0:${PORT} ..."
ffplay -fflags nobuffer -flags low_delay -framedrop \
  -probesize 32 -analyzeduration 0 \
  "udp://0.0.0.0:${PORT}"
