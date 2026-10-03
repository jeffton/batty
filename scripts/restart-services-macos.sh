#!/usr/bin/env bash
set -euo pipefail

label="se.roybot.batty"
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/${label}.plist"
install_root="${BATTY_INSTALL_ROOT:-$HOME/Library/Application Support/Batty/app}"
batty_root="${BATTY_ROOT:-$HOME/Github}"
backend_port="${BATTY_PORT:-3147}"
node_path="${BATTY_NODE:-$(command -v node)}"

if launchctl print "${domain}/${label}" >/dev/null 2>&1; then
  if [[ "${BATTY_SKIP_DRAIN:-}" != "1" ]]; then
    checkpoint_args=()
    if [[ -n "${BATTY_RESTART_SESSION_FILE:-}" || -n "${BATTY_RESTART_AFTER_ENTRY_ID:-}" ]]; then
      checkpoint_args=(--session "${BATTY_RESTART_SESSION_FILE:-}" --after-entry "${BATTY_RESTART_AFTER_ENTRY_ID:-}")
    fi
    "$node_path" "$install_root/current/dist/server/cli.mjs" --root "$batty_root" drain "${checkpoint_args[@]}"
  fi
  launchctl bootout "${domain}/${label}"
  # bootout returns before launchd finishes terminating and removing the job.
  while launchctl print "${domain}/${label}" >/dev/null 2>&1; do
    sleep 0.1
  done
fi

launchctl bootstrap "$domain" "$plist"
launchctl enable "${domain}/${label}"
launchctl kickstart -k "${domain}/${label}"

for ((attempt = 1; attempt <= 30; attempt++)); do
  if curl --fail --silent --head --max-time 2 "http://127.0.0.1:${backend_port}/healthz" >/dev/null; then
    exit 0
  fi
  sleep 1
done

curl --fail --silent --show-error --head --max-time 10 "http://127.0.0.1:${backend_port}/healthz" >/dev/null
