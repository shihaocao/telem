#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "=== installing server deps ==="
cd "$ROOT/server" && npm install

echo "=== installing bluetooth deps ==="
cd "$ROOT/bluetooth" && npm install

echo "=== installing racebox-connect ==="
sudo cp "$ROOT/bluetooth/racebox-connect.sh" /usr/local/bin/racebox-connect.sh
sudo chmod +x /usr/local/bin/racebox-connect.sh
sudo cp "$ROOT/bluetooth/racebox-connect.service" /etc/systemd/system/

echo "=== installing telem-server ==="
sudo cp "$ROOT/bluetooth/telem-server.service" /etc/systemd/system/

echo "=== installing racebox-bridge ==="
sudo cp "$ROOT/bluetooth/racebox-bridge.service" /etc/systemd/system/

echo "=== installing serial-bridge ==="
sudo cp "$ROOT/server/serial-bridge.service" /etc/systemd/system/

echo "=== installing video-streaming ==="
sudo cp "$ROOT/streaming/video-streaming.service" /etc/systemd/system/

echo "=== reloading systemd ==="
sudo systemctl daemon-reload

echo "=== enabling services ==="
sudo systemctl enable racebox-connect.service
sudo systemctl enable telem-server.service
sudo systemctl enable racebox-bridge.service
sudo systemctl enable serial-bridge.service
sudo systemctl enable video-streaming.service

echo "=== starting services ==="
sudo systemctl start racebox-connect.service
sudo systemctl start telem-server.service
sudo systemctl start racebox-bridge.service
sudo systemctl start serial-bridge.service
sudo systemctl start video-streaming.service

echo "=== status ==="
sudo systemctl status racebox-connect.service --no-pager || true
sudo systemctl status telem-server.service --no-pager || true
sudo systemctl status racebox-bridge.service --no-pager || true
sudo systemctl status serial-bridge.service --no-pager || true
sudo systemctl status video-streaming.service --no-pager || true
