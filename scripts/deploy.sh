#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh
# Validate source and production offline behavior before pushing (see AGENTS.md).
# Keep Git, dependency installation and builds under the invoking user's UID.
git pull --ff-only
git diff --quiet && git diff --cached --quiet || { echo 'Commit changes before deploying.' >&2; exit 1; }
admin=()
if [[ $(id -u) != 0 ]]; then
  sudo -n true
  admin=(sudo -n)
fi
minimum_free_kb=${BATTY2_DEPLOY_MIN_FREE_KB:-4194304}
preflight_disk /opt/batty2 "$minimum_free_kb"
preflight_disk /tmp "$minimum_free_kb"
preflight_browser_video
"${admin[@]}" bash scripts/setup-chrome.sh

revision=$(git rev-parse --short HEAD)
build=$(mktemp -d /tmp/batty2-build.XXXXXX)
trap 'rm -rf -- "$build"' EXIT
git archive HEAD | tar -x -C "$build"
(
  cd "$build"
  pnpm install --frozen-lockfile
  "${admin[@]}" bash scripts/setup-browser-isolation.sh
  BATTY_BUILD_ID="$revision" pnpm build
)
staged="$build/release"
mkdir "$staged"
cp -a "$build"/{dist,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,README.md} "$staged/"
write_client_asset_manifest "$staged/dist/client/assets" "$staged/CLIENT_ASSETS.txt"
printf '%s\n' "$revision" > "$staged/BUILD_ID"
(cd "$staged" && pnpm install --prod --frozen-lockfile)
"${admin[@]}" bash scripts/deploy-admin.sh "$staged" "$revision"
