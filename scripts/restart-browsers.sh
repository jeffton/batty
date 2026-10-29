#!/usr/bin/env bash
# Linux production maintenance. Invoke through systemd-run so it survives Batty stopping.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
root=${1:?Usage: restart-browsers.sh BATTY_ROOT}
node=${BATTY_NODE:-/usr/bin/node}
service=batty2.service
release=/opt/batty2/current
systemctl stop "$service"
# Restore the service even if browser shutdown reports an error; do not hide that error.
trap 'systemctl start "$service"' EXIT
"$node" "$release/dist/server/close-browsers.mjs" "$root"
systemctl start "$service"
trap - EXIT
