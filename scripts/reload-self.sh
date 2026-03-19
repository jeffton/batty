#!/usr/bin/env bash
set -euo pipefail

cd /root/github/batty
pnpm build
./scripts/handoff-restart.sh
