#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Darwin && $(id -u) != 0 ]] || { echo 'Run as the macOS service user, without sudo.' >&2; exit 1; }
cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

git pull --ff-only
if [[ ${BATTY2_ALLOW_DIRTY:-0} != 1 ]]; then
  [[ -z $(git status --porcelain) ]] || { echo 'Commit changes before deploying (or set BATTY2_ALLOW_DIRTY=1).' >&2; exit 1; }
fi
command -v flock >/dev/null || { echo 'Install the kernel lock helper: brew install flock' >&2; exit 1; }
install_root=${BATTY2_INSTALL_ROOT:-"$HOME/Library/Application Support/Batty2/app"}
data_root=${BATTY2_ROOT:-"$HOME/Library/Application Support/Batty2/root"}
label=${BATTY2_LABEL:-se.roybot.batty}
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/Batty2"
[[ -f "$data_root/.batty/options.json" ]] || { echo "Configure $data_root/.batty/options.json first." >&2; exit 1; }
mkdir -p "$install_root/releases" "$log_dir" "$(dirname "$plist")" "$HOME/.local/bin"
preflight_disk "$install_root" "${BATTY2_DEPLOY_MIN_FREE_KB:-4194304}"
preflight_disk "${TMPDIR:-/tmp}" "${BATTY2_DEPLOY_MIN_FREE_KB:-4194304}"
revision=$(git rev-parse --short HEAD)
if [[ -n $(git status --porcelain) ]]; then revision="$revision-local-$(date +%s)"; fi
build=$(mktemp -d "${TMPDIR:-/tmp}/batty2-build.XXXXXX")
trap 'rm -rf -- "$build"' EXIT
# Explicit dirty deployments include tracked edits and nonignored new files.
git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - | tar -xf - -C "$build"
(cd "$build" && pnpm install --frozen-lockfile && BATTY_BUILD_ID="$revision" pnpm build)
release="$install_root/releases/$revision.$(date +%s)"
mkdir -p "$release/scripts"
cp -R "$build"/{dist,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,README.md} "$release/"
cp "$build/scripts/"{activate-macos.sh,deploy-lib.sh} "$release/scripts/"
printf '%s\n' "$revision" > "$release/BUILD_ID"
write_client_asset_manifest "$release/dist/client/assets" "$release/CLIENT_ASSETS.txt"
copy_retained_client_assets "$install_root/releases" "$release" "$install_root/current"
(cd "$release" && pnpm install --prod --frozen-lockfile)

# Retain the installed listener and other launchd environment settings.
python3 "$build/scripts/configure-macos.py" "$plist" "$release/agent.plist" "$label" \
  "$(command -v node)" "$install_root/current" "$data_root" "$log_dir" "$PATH" "$HOME/.local/bin/batty2"
plutil -lint "$release/agent.plist"
# HTTPS is opt-in; configuration and CA storage stay outside releases/source.
https_root="$(dirname "$install_root")/https"
if [[ -f "$https_root/Caddyfile" ]]; then
  python3 "$build/scripts/configure-macos-https.py" "$https_root" "$release/https-agent.plist" "$label" "$log_dir"
  plutil -lint "$release/https-agent.plist"
fi
# A launchd-owned worker survives stopping Batty, including self-deploy turns.
python3 - "$release" "$install_root" "$plist" "$label.deploy.$(date +%s)" <<'PY'
import plistlib, sys
release, root, agent, label = sys.argv[1:]
with open(release + '/worker.plist', 'wb') as f:
    plistlib.dump({'Label': label, 'RunAtLoad': True,
                  'ProgramArguments': ['/bin/bash', release + '/scripts/activate-macos.sh', root, release, agent],
                  'StandardOutPath': release + '/DEPLOY.log',
                  'StandardErrorPath': release + '/DEPLOY.log'}, f)
PY
launchctl bootstrap "gui/$(id -u)" "$release/worker.plist"
printf 'Reload handed off; activation is pending. Release: %s\nActivation log: %s/DEPLOY.log\nResult: %s/ACTIVATION_RESULT\n' "$release" "$release" "$release"
