#!/usr/bin/env bash
set -euo pipefail

cd /root/github/pi-face

systemctl daemon-reload
systemctl enable batty.service >/dev/null
systemctl restart batty.service
systemctl reload nginx

systemctl is-active --quiet batty.service
curl --fail --silent --show-error --head --max-time 10 http://127.0.0.1:3147/healthz >/dev/null
curl --fail --silent --show-error --head --max-time 10 http://127.0.0.1/ >/dev/null
