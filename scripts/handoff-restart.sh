#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_root="${BATTY_INSTALL_ROOT:-/opt/batty}"
batty_root="${BATTY_ROOT:-/root/github}"
backend_port="${BATTY_PORT:-3147}"
node_path="${BATTY_NODE:-$(command -v node)}"
unit="batty-reload-$(date +%s)"

systemd-run \
  --quiet \
  --collect \
  --unit "$unit" \
  --setenv="BATTY_INSTALL_ROOT=$install_root" \
  --setenv="BATTY_ROOT=$batty_root" \
  --setenv="BATTY_PORT=$backend_port" \
  --setenv="BATTY_NODE=$node_path" \
  --setenv="BATTY_SKIP_DRAIN=${BATTY_SKIP_DRAIN:-}" \
  /bin/bash "$script_dir/restart-services.sh"

printf 'Handed off restart to transient unit %s\n' "$unit"
