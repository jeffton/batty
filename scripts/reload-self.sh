#!/usr/bin/env bash
set -euo pipefail

cd /root/github/pi-face
pnpm exec tsx scripts/migrate-state.ts
pnpm build
./scripts/handoff-restart.sh
