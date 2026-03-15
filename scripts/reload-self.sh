#!/usr/bin/env bash
set -euo pipefail

cd /root/github/pi-face
pnpm build
./scripts/handoff-restart.sh
