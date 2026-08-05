#!/usr/bin/env bash
set -euo pipefail

label="se.roybot.batty"
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/${label}.plist"

if launchctl print "${domain}/${label}" >/dev/null 2>&1; then
  launchctl kickstart -k "${domain}/${label}"
else
  launchctl bootstrap "$domain" "$plist"
  launchctl enable "${domain}/${label}"
  launchctl kickstart -k "${domain}/${label}"
fi

for ((attempt = 1; attempt <= 30; attempt++)); do
  if curl --fail --silent --head --max-time 2 http://127.0.0.1:3147/healthz >/dev/null; then
    exit 0
  fi
  sleep 1
done

curl --fail --silent --show-error --head --max-time 10 http://127.0.0.1:3147/healthz >/dev/null
