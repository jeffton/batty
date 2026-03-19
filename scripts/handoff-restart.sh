#!/usr/bin/env bash
set -euo pipefail

cd /root/github/batty

delay_seconds="${1:-20}"
unit="batty-reload-$(date +%s)"

systemd-run \
  --quiet \
  --collect \
  --unit "$unit" \
  /usr/bin/env bash -lc "sleep ${delay_seconds} && /root/github/batty/scripts/restart-services.sh"

printf 'Handed off restart to transient unit %s\n' "$unit"
