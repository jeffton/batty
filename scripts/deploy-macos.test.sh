#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo 'macOS required.' >&2; exit 1; }
script_dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/app/releases/old.1" "$tmp/app/releases/new.2"
export MOCK_STATE="$tmp/state"
export MOCK_HEALTH_URL=http://127.0.0.1:3147/healthz
printf 'loaded' > "$MOCK_STATE"
cat > "$tmp/bin/launchctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case $1 in
  print) [[ $(<"$MOCK_STATE") == loaded ]] ;;
  bootout) printf 'stopped' > "$MOCK_STATE" ;;
  bootstrap)
    if [[ -f "$MOCK_STATE.fail" ]]; then rm "$MOCK_STATE.fail"; exit 5; fi
    printf 'loaded' > "$MOCK_STATE"
    ;;
  *) exit 99 ;;
esac
MOCK
cat > "$tmp/bin/curl" <<'MOCK'
#!/usr/bin/env bash
[[ ${!#} == "$MOCK_HEALTH_URL" ]] || exit 1
printf '{"ok":true,"buildId":"new"}'
MOCK
chmod +x "$tmp/bin/"*
release="$tmp/app/releases/new.2"
printf 'new\n' > "$release/BUILD_ID"
printf 'old\n' > "$tmp/agent.plist"
cp "$tmp/agent.plist" "$tmp/original.plist"
python3 - "$release/agent.plist" "$tmp/bin:$PATH" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as f:
    plistlib.dump({'Label': 'test.batty', 'EnvironmentVariables': {'PATH': sys.argv[2], 'BATTY_PORT': '3147', 'BATTY_HOST': '127.0.0.1'}}, f)
PY
ln -s "$tmp/app/releases/old.1" "$tmp/app/current"
# Failed bootstrap restores both the old symlink and the original agent.
touch "$MOCK_STATE.fail"
if bash "$script_dir/activate-macos.sh" "$tmp/app" "$release" "$tmp/agent.plist"; then
  echo 'Expected activation failure.' >&2; exit 1
fi
[[ $(readlink "$tmp/app/current") == "$tmp/app/releases/old.1" ]]
cmp "$tmp/agent.plist" "$tmp/original.plist"
[[ $(<"$MOCK_STATE") == loaded ]]
[[ ! -f "$release/HEALTHY" ]]
[[ $(<"$release/ACTIVATION_RESULT") == FAILED ]]
# Successful activation verifies health and marks the release.
bash "$script_dir/activate-macos.sh" "$tmp/app" "$release" "$tmp/agent.plist"
[[ $(readlink "$tmp/app/current") == "$release" ]]
[[ -f "$release/HEALTHY" ]]
cmp "$tmp/agent.plist" "$release/agent.plist"
[[ $(<"$release/ACTIVATION_RESULT") == SUCCEEDED ]]

# First installation has no agent/current, defaults to 3147 and shares the
# configured listener with the CLI outside launchd.
cat > "$tmp/cli-node" <<'MOCK'
#!/bin/bash
printf '%s:%s\n' "$BATTY_HOST" "$BATTY_PORT"
MOCK
chmod +x "$tmp/cli-node"
rm "$tmp/agent.plist" "$tmp/app/current" "$release/previous-agent.plist" "$release/HEALTHY"
printf 'stopped' > "$MOCK_STATE"
python3 "$script_dir/configure-macos.py" "$tmp/agent.plist" "$release/agent.plist" \
  test.batty "$tmp/cli-node" "$tmp/app/current" "$tmp/data root" "$tmp/logs" "$tmp/bin:$PATH" "$tmp/cli"
[[ $("$tmp/cli") == 127.0.0.1:3147 ]]
touch "$MOCK_STATE.fail"
if bash "$script_dir/activate-macos.sh" "$tmp/app" "$release" "$tmp/agent.plist"; then
  echo 'Expected first-install activation failure.' >&2; exit 1
fi
[[ ! -e "$tmp/agent.plist" && ! -L "$tmp/app/current" ]]
[[ $(<"$release/ACTIVATION_RESULT") == FAILED ]]
bash "$script_dir/activate-macos.sh" "$tmp/app" "$release" "$tmp/agent.plist"
[[ $(readlink "$tmp/app/current") == "$release" ]]
[[ $(<"$release/ACTIVATION_RESULT") == SUCCEEDED ]]

# Existing environment settings survive generation; an omitted port receives
# the Mac installation default, while an explicit port is retained.
python3 - "$tmp/agent.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as f:
    plistlib.dump({'Program': '/obsolete/executable', 'EnvironmentVariables': {'CUSTOM_SETTING': 'keep', 'BATTY_HOST': 'localhost'}}, f)
PY
python3 "$script_dir/configure-macos.py" "$tmp/agent.plist" "$release/agent.plist" \
  test.batty "$tmp/cli-node" "$tmp/app/current" "$tmp/data root" "$tmp/logs" "$tmp/bin:$PATH" "$tmp/cli"
[[ $("$tmp/cli") == localhost:3147 ]]
[[ $(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CUSTOM_SETTING' "$release/agent.plist") == keep ]]
/usr/libexec/PlistBuddy -c 'Set :EnvironmentVariables:BATTY_PORT 4444' "$release/agent.plist"
cp "$release/agent.plist" "$tmp/agent.plist"
python3 "$script_dir/configure-macos.py" "$tmp/agent.plist" "$release/agent.plist" \
  test.batty "$tmp/cli-node" "$tmp/app/current" "$tmp/data root" "$tmp/logs" "$tmp/bin:$PATH" "$tmp/cli"
[[ $("$tmp/cli") == localhost:4444 ]]
python3 - "$release/agent.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    assert 'Program' not in plistlib.load(f)
PY

# Stored environment overrides select the runtime listener for both the CLI
# and activation, including bracketed IPv6 health URLs.
mkdir -p "$tmp/data root/.batty"
printf '{"BATTY_HOST":"::1","BATTY_PORT":"4555"}' > "$tmp/data root/.batty/environment.json"
python3 "$script_dir/configure-macos.py" "$tmp/agent.plist" "$release/agent.plist" \
  test.batty "$tmp/cli-node" "$tmp/app/current" "$tmp/data root" "$tmp/logs" "$tmp/bin:$PATH" "$tmp/cli"
[[ $("$tmp/cli") == ::1:4555 ]]
export MOCK_HEALTH_URL='http://[::1]:4555/healthz'
bash "$script_dir/activate-macos.sh" "$tmp/app" "$release" "$tmp/agent.plist"
[[ $(<"$release/ACTIVATION_RESULT") == SUCCEEDED ]]
# An overlapping handoff fails without changing the live agent or release.
cp "$tmp/agent.plist" "$tmp/before-overlap.plist"
flock --exclusive "$tmp/app/activation.lock" /bin/bash -c 'touch "$MOCK_STATE.locked"; sleep 2' &
holder=$!
while [[ ! -f "$MOCK_STATE.locked" ]]; do sleep 0.1; done
if bash "$script_dir/activate-macos.sh" "$tmp/app" "$release" "$tmp/agent.plist"; then
  echo 'Expected concurrent activation rejection.' >&2; exit 1
fi
[[ $(<"$release/ACTIVATION_RESULT") == FAILED ]]
[[ $(readlink "$tmp/app/current") == "$release" ]]
cmp "$tmp/agent.plist" "$tmp/before-overlap.plist"
wait "$holder"
printf 'macOS activation tests passed\n'
