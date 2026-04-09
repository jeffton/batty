#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

delay_seconds="${1:-20}"
unit="batty-reload-$(date +%s)"

systemd-run \
  --quiet \
  --collect \
  --unit "$unit" \
  /usr/bin/env bash -lc "sleep ${delay_seconds} && ${script_dir}/restart-services.sh"

printf 'Handed off restart to transient unit %s\n' "$unit"
