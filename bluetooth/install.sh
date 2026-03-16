#!/usr/bin/env bash
set -euo pipefail

sudo cp racebox-connect.sh /usr/local/bin/racebox-connect.sh
sudo chmod +x /usr/local/bin/racebox-connect.sh

sudo cp racebox-connect.service /etc/systemd/system/racebox-connect.service
sudo systemctl daemon-reload
sudo systemctl enable racebox-connect.service
sudo systemctl start racebox-connect.service

echo "installed and started racebox-connect.service"
sudo systemctl status racebox-connect.service
