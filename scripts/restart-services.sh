#!/usr/bin/env bash
set -euo pipefail

cd /root/github/batty

if systemctl list-unit-files pi-face.service --no-legend | grep -q '^pi-face\.service'; then
  systemctl disable --now pi-face.service >/dev/null
  rm -f /etc/systemd/system/pi-face.service
fi

systemctl daemon-reload
systemctl enable batty.service >/dev/null
systemctl restart batty.service
systemctl reload nginx

systemctl is-active --quiet batty.service
curl --fail --silent --show-error --head --max-time 10 http://127.0.0.1:3147/healthz >/dev/null
curl --fail --silent --show-error --head --max-time 10 http://127.0.0.1/ >/dev/null
