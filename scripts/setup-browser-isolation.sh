#!/usr/bin/env bash
# Run as root after installing/updating Patchright Chromium. Never relax /root permissions.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
if ! id batty-browser >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/batty-browser/home --shell /usr/sbin/nologin batty-browser
fi
[[ $(id -u batty-browser) != 0 && $(id -g batty-browser) != 0 ]]
install -d -o root -g root -m 755 /opt/batty-browser /var/lib/batty-browser
install -d -o root -g root -m 711 /var/lib/batty-browser/sessions
install -d -o batty-browser -g batty-browser -m 700 /var/lib/batty-browser/home
executable=$(node --input-type=module -e 'import {chromium} from "patchright"; console.log(chromium.executablePath())')
source=$(dirname "$(dirname "$executable")")
revision=$(basename "$source")
[[ "$revision" == chromium-* && -x "$executable" ]]
if [[ ! -d "/opt/batty-browser/$revision" ]]; then
  cp -a "$source" "/opt/batty-browser/$revision"
fi
chown -R root:root "/opt/batty-browser/$revision"
chmod -R a+rX,go-w "/opt/batty-browser/$revision"
# Namespace permission only for root-controlled browser binaries. Chromium still
# applies its namespace/seccomp sandbox; this does not disable Ubuntu's policy globally.
if [[ -d /etc/apparmor.d ]]; then
  printf '%s\n' \
    'abi <abi/4.0>,' \
    'include <tunables/global>' \
    'profile batty-browser /opt/batty-browser/chromium-*/chrome-linux*/chrome flags=(unconfined) {' \
    '  userns,' \
    '}' > /etc/apparmor.d/batty-browser
  chmod 644 /etc/apparmor.d/batty-browser
  apparmor_parser -r /etc/apparmor.d/batty-browser
fi
runuser -u batty-browser -- test -x "/opt/batty-browser/$revision/$(basename "$(dirname "$executable")")/$(basename "$executable")"
echo "Installed sandboxed browser executable: /opt/batty-browser/$revision"
