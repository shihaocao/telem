#!/usr/bin/env bash

SERVICES=(racebox-connect telem-server racebox-bridge video-streaming)

for svc in "${SERVICES[@]}"; do
  state=$(systemctl is-active "$svc.service" 2>/dev/null)
  case "$state" in
    active)   icon="[ok]" ;;
    *)        icon="[!!]" ;;
  esac
  uptime=$(systemctl show "$svc.service" --property=ActiveEnterTimestamp --value 2>/dev/null)
  restarts=$(systemctl show "$svc.service" --property=NRestarts --value 2>/dev/null)
  printf "%-20s %s  %-12s  restarts: %s  since: %s\n" "$svc" "$icon" "$state" "$restarts" "$uptime"
done

echo ""
echo "tail logs:"
for svc in "${SERVICES[@]}"; do
  echo "  journalctl -u $svc.service -f"
done
echo "  journalctl -u racebox-connect -u telem-server -u racebox-bridge -u video-streaming -f  # all"
