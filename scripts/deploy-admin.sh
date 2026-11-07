#!/usr/bin/env bash
# Install a completed release. Dependency resolution and builds run as the caller.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Release installation requires root.' >&2; exit 1; }
source "$(dirname "$0")/deploy-lib.sh"
staged=$1
revision=$2
releases_dir=/opt/batty2/releases
release="$releases_dir/${revision}.$(date +%s)"
previous_release=
if [[ -L /opt/batty2/current ]]; then
  previous_release=$(readlink -f /opt/batty2/current)
fi
prepare_release_files "$staged" "$release" "$releases_dir" /opt/batty2/current
ln -sfn "$release" /opt/batty2/next
mv -Tf /opt/batty2/next /opt/batty2/current
install -m 755 "$(dirname "$0")/batty2" /usr/local/bin/batty2
systemctl restart batty2.service
# Durable schema migrations can rebuild large tables before the listener opens.
for attempt in {1..300}; do
  response=$(curl --fail --silent http://127.0.0.1:3148/healthz || true)
  if [[ -n "$response" ]] && health_matches_expected "$response" "$revision"; then
    touch /opt/batty2/current/HEALTHY
    if [[ -n "$previous_release" && ! -f "$previous_release/HEALTHY" && ! -f "$previous_release/CLIENT_ASSETS.txt" ]]; then
      touch "$previous_release/HEALTHY"
    fi
    prune_releases "$releases_dir" /opt/batty2/current
    exit 0
  fi
  sleep 1
done
journalctl -u batty2.service -n 50 --no-pager
exit 1
