#!/usr/bin/env bash
set -euo pipefail
install_root=$1
release=$2
plist=$3
printf 'PENDING\n' > "$release/ACTIVATION_RESULT"
trap 'printf "FAILED\n" > "$release/ACTIVATION_RESULT"' ERR
source "$(dirname "$0")/deploy-lib.sh"
# launchd does not inherit the caller's PATH.
export PATH="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PATH' "$release/agent.plist")"
# Separate handoffs must not race symlink/agent changes or rollback each other.
if [[ ${BATTY2_ACTIVATION_LOCKED:-0} != 1 ]]; then
  if env BATTY2_ACTIVATION_LOCKED=1 flock --exclusive --nonblock "$install_root/activation.lock" /bin/bash "$0" "$@"; then
    exit 0
  else
    status=$?
    printf 'FAILED\n' > "$release/ACTIVATION_RESULT"
    echo 'Activation failed; see the worker log (another activation may hold the lock).' >&2
    exit "$status"
  fi
fi
label=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$release/agent.plist")
port=$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:BATTY_PORT' "$release/agent.plist")
host=$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:BATTY_HOST' "$release/agent.plist")
case "$host" in
  0.0.0.0) host=127.0.0.1 ;;
  ::) host=::1 ;;
esac
if [[ "$host" == *:* ]]; then host="[$host]"; fi
domain="gui/$(id -u)"
revision=$(<"$release/BUILD_ID")
previous=
[[ ! -L "$install_root/current" ]] || previous=$(canonical_release_path "$install_root/current")
[[ ! -f "$plist" ]] || cp "$plist" "$release/previous-agent.plist"
was_loaded=0
if launchctl print "$domain/$label" >/dev/null 2>&1; then was_loaded=1; fi

switch_release() {
  python3 - "$install_root" "$1" <<'PY'
import os, sys
root, release = sys.argv[1:]
next_path = root + '/next'
if os.path.lexists(next_path): os.unlink(next_path)
os.symlink(release, next_path)
os.replace(next_path, root + '/current')
PY
}
stop_agent() {
  launchctl bootout "$domain/$label"
  # bootout returns before launchd removes the terminating job.
  while launchctl print "$domain/$label" >/dev/null 2>&1; do sleep 0.1; done
}
rollback() {
  local status=$?
  trap - ERR
  printf 'FAILED\n' > "$release/ACTIVATION_RESULT"
  echo 'Activation failed; restoring previous installation.' >&2
  if launchctl print "$domain/$label" >/dev/null 2>&1; then stop_agent; fi
  if [[ -n "$previous" ]]; then switch_release "$previous"; else rm -f "$install_root/current"; fi
  if [[ -f "$release/previous-agent.plist" ]]; then
    cp "$release/previous-agent.plist" "$plist"
    if (( was_loaded )); then launchctl bootstrap "$domain" "$plist"; fi
  else
    rm -f "$plist"
  fi
  exit "$status"
}
trap rollback ERR
if (( was_loaded )); then stop_agent; fi
switch_release "$release"
cp "$release/agent.plist" "$plist"
launchctl bootstrap "$domain" "$plist"
for attempt in {1..60}; do
  response=$(curl --fail --silent --max-time 2 --noproxy '*' "http://$host:$port/healthz" || true)
  if [[ -n "$response" ]] && health_matches_expected "$response" "$revision"; then
    touch "$release/HEALTHY"
    printf 'SUCCEEDED\n' > "$release/ACTIVATION_RESULT"
    trap - ERR
    prune_releases "$install_root/releases" "$install_root/current"
    printf 'Batty2 %s healthy on port %s.\n' "$revision" "$port"
    exit 0
  fi
  sleep 1
done
echo 'Service health/build ID verification failed.' >&2
false
