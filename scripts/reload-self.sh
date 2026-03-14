#!/usr/bin/env bash
set -euo pipefail

cd /root/github/pi-face
pnpm build
systemctl restart pi-face.service
