#!/usr/bin/env bash
set -euo pipefail

systemctl daemon-reload
systemctl enable batty.service >/dev/null
systemctl restart batty.service
systemctl reload nginx

wait_for_url() {
  local url="$1"
  local attempts=30
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl --fail --silent --head --max-time 2 "$url" >/dev/null; then
      return
    fi
    sleep 1
  done

  curl --fail --silent --show-error --head --max-time 10 "$url" >/dev/null
}

systemctl is-active --quiet batty.service
wait_for_url http://127.0.0.1:3147/healthz
wait_for_url http://127.0.0.1/

install_root="${BATTY_INSTALL_ROOT:-/opt/batty}"
releases_dir="${install_root}/releases"
current_release="$(readlink -f "${install_root}/current")"
previous_release=""
for candidate in "$releases_dir"/*; do
  if [[ -d "$candidate" && "$candidate" != "$current_release" ]]; then
    if [[ -z "$previous_release" || "$candidate" -nt "$previous_release" ]]; then
      previous_release="$candidate"
    fi
  fi
done
for candidate in "$releases_dir"/*; do
  if [[ -d "$candidate" && "$candidate" != "$current_release" && "$candidate" != "$previous_release" ]]; then
    rm -rf "$candidate"
  fi
done
