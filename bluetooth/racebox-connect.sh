#!/usr/bin/env bash
set -euo pipefail

DEVICE="F0:3A:C0:59:48:B7"
SCAN_DURATION=10
MAX_WAIT=30

log() { echo "[racebox] $(date '+%H:%M:%S') $*"; }

# wait for bluetooth daemon
log "waiting for bluetoothd..."
waited=0
while ! bluetoothctl show &>/dev/null; do
  sleep 1
  waited=$((waited + 1))
  if [ "$waited" -ge "$MAX_WAIT" ]; then
    log "ERROR: bluetoothd not ready after ${MAX_WAIT}s"
    exit 1
  fi
done
log "bluetoothd ready (${waited}s)"

# power on adapter
log "powering on adapter"
bluetoothctl power on

# scan for BLE device
log "scanning for ${SCAN_DURATION}s..."
bluetoothctl --timeout "$SCAN_DURATION" scan on || true

# check device was found
if ! bluetoothctl info "$DEVICE" &>/dev/null; then
  log "ERROR: device $DEVICE not found"
  exit 1
fi
log "device found"

# trust + pair + connect
log "trusting $DEVICE"
bluetoothctl trust "$DEVICE"

log "pairing $DEVICE"
bluetoothctl pair "$DEVICE" || true  # may already be paired

log "connecting $DEVICE"
bluetoothctl connect "$DEVICE"

log "connected"
