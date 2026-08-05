#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
delay_seconds="${1:-20}"
log_dir="$HOME/Library/Logs/Batty"
mkdir -p "$log_dir"

nohup /bin/bash -c 'sleep "$1"; exec "$2"' _ "$delay_seconds" \
  "$script_dir/restart-services-macos.sh" \
  >>"$log_dir/deploy.log" 2>&1 </dev/null &

printf 'Handed off launchd reload (PID %s)\n' "$!"
