#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_root="${BATTY_INSTALL_ROOT:-$HOME/Library/Application Support/Batty/app}"
batty_root="${BATTY_ROOT:-$HOME/Github}"
backend_port="${BATTY_PORT:-3147}"
node_path="${BATTY_NODE:-$(command -v node)}"
log_dir="$HOME/Library/Logs/Batty"
mkdir -p "$log_dir"

nohup /usr/bin/env "BATTY_INSTALL_ROOT=$install_root" "BATTY_ROOT=$batty_root" "BATTY_PORT=$backend_port" "BATTY_NODE=$node_path" \
  "BATTY_SKIP_DRAIN=${BATTY_SKIP_DRAIN:-}" \
  /bin/bash "$script_dir/restart-services-macos.sh" \
  >>"$log_dir/deploy.log" 2>&1 </dev/null &

printf 'Handed off launchd reload (PID %s)\n' "$!"
