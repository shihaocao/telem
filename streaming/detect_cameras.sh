#!/usr/bin/env bash
# Detect all video devices and list their capabilities
set -euo pipefail

if ! command -v v4l2-ctl &>/dev/null; then
  echo "v4l2-ctl not found. Install with: sudo apt install v4l-utils"
  exit 1
fi

echo "=== Connected Video Devices ==="
echo
v4l2-ctl --list-devices 2>/dev/null || echo "(no devices found)"
echo

for dev in /dev/video*; do
  [ -e "$dev" ] || continue
  echo "=== $dev ==="
  v4l2-ctl -d "$dev" --list-formats-ext 2>/dev/null || echo "  (cannot open)"
  echo
done
