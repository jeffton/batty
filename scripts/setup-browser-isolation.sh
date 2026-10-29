#!/usr/bin/env bash
# Prepare installed Chrome, or the test-only pinned Chromium with --test.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
[[ ${1:-} == '' || ${1:-} == --test ]] || { echo 'Usage: setup-browser-isolation.sh [--test]' >&2; exit 1; }
if ! id batty-browser >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/batty-browser/home --shell /usr/sbin/nologin batty-browser
fi
[[ $(id -u batty-browser) != 0 && $(id -g batty-browser) != 0 ]]
install -d -o root -g root -m 755 /opt/batty-browser /var/lib/batty-browser
install -d -o root -g root -m 711 /var/lib/batty-browser/sessions
install -d -o batty-browser -g batty-browser -m 700 /var/lib/batty-browser/home
if [[ ${1:-} == --test ]]; then
  executable=$(node --input-type=module -e 'import {chromium} from "patchright"; console.log(chromium.executablePath())')
  source=$(dirname "$(dirname "$executable")")
  revision=$(basename "$source")
  [[ "$revision" == chromium-* && -x "$executable" ]]
  if [[ ! -d "/opt/batty-browser/$revision" ]]; then cp -a "$source" "/opt/batty-browser/$revision"; fi
  chown -R root:root "/opt/batty-browser/$revision"
  chmod -R a+rX,go-w "/opt/batty-browser/$revision"
  executable="/opt/batty-browser/$revision/$(basename "$(dirname "$executable")")/$(basename "$executable")"
else
  executable=/opt/google/chrome/chrome
  [[ -x "$executable" && $(realpath "$executable") == "$executable" ]] || { echo 'Install Google Chrome Stable first.' >&2; exit 1; }
  # Keep the package-managed installation in place so APT updates the active path.
  for entry in /opt /opt/google /opt/google/chrome "$executable"; do
    [[ $(stat -c %u "$entry") == 0 && -z $(stat -c %A "$entry" | cut -c6,9 | tr -d '-') ]] || { echo "Unsafe Chrome installation permissions: $entry" >&2; exit 1; }
  done
fi
# Executable-scoped user namespaces; Chromium's namespace/seccomp sandbox stays enabled.
if [[ -d /etc/apparmor.d ]]; then
  printf '%s\n' \
    'abi <abi/4.0>,' \
    'include <tunables/global>' \
    'profile batty-browser /opt/batty-browser/chromium-*/chrome-linux*/chrome flags=(unconfined) {' \
    '  userns,' \
    '}' > /etc/apparmor.d/batty-browser
  chmod 644 /etc/apparmor.d/batty-browser
  apparmor_parser -r /etc/apparmor.d/batty-browser
  # Ubuntu supplies Chrome's exact attachment. Duplicate attachments prevent
  # profile selection, so load the distribution profile instead of shadowing it.
  if [[ -f /etc/apparmor.d/chrome ]]; then
    apparmor_parser -r /etc/apparmor.d/chrome
  else
    printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' \
      'profile batty-system-chrome /opt/google/chrome/chrome flags=(unconfined) {' \
      '  userns,' '}' > /etc/apparmor.d/batty-system-chrome
    chmod 644 /etc/apparmor.d/batty-system-chrome
    apparmor_parser -r /etc/apparmor.d/batty-system-chrome
  fi
fi
runuser -u batty-browser -- test -x "$executable"
echo "Prepared sandboxed browser: $executable"
