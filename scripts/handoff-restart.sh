#!/usr/bin/env bash
set -euo pipefail

cd /root/github/pi-face

delay_seconds="${1:-20}"
unit="pi-face-reload-$(date +%s)"

systemd-run \
  --quiet \
  --collect \
  --unit "$unit" \
  /usr/bin/env bash -lc "sleep ${delay_seconds} && /root/github/pi-face/scripts/restart-services.sh"

printf 'Handed off restart to transient unit %s\n' "$unit"
