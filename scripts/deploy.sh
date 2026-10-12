#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh
git pull --ff-only
git diff --quiet && git diff --cached --quiet || { echo 'Commit changes before deploying.' >&2; exit 1; }

releases_dir=/opt/batty2/releases
minimum_free_kb=${BATTY2_DEPLOY_MIN_FREE_KB:-4194304}
preflight_disk /opt/batty2 "$minimum_free_kb"
preflight_disk /tmp "$minimum_free_kb"

revision=$(git rev-parse --short HEAD)
build=$(mktemp -d /tmp/batty2-build.XXXXXX)
trap 'rm -rf -- "$build"' EXIT
git archive HEAD | tar -x -C "$build"
(
  cd "$build"
  pnpm install --frozen-lockfile
  pnpm check
  BATTY_BUILD_ID="$revision" pnpm build
  node scripts/verify-offline.mjs
)
release="/opt/batty2/releases/${revision}.$(date +%s)"
previous_release=
if [[ -L /opt/batty2/current ]]; then
  previous_release=$(readlink -f /opt/batty2/current)
fi
mkdir -p "$release"
cp -a "$build"/{dist,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,README.md} "$release/"
# Keep this release's own immutable chunks identifiable. Copy only chunks
# produced by the two retained releases, not inherited assets recursively.
write_client_asset_manifest "$release/dist/client/assets" "$release/CLIENT_ASSETS.txt"
copy_retained_client_assets "$releases_dir" "$release" /opt/batty2/current
printf '%s\n' "$revision" > "$release/BUILD_ID"
(cd "$release" && pnpm install --prod --frozen-lockfile)
ln -sfn "$release" /opt/batty2/next
mv -Tf /opt/batty2/next /opt/batty2/current
install -m 755 scripts/batty2 /usr/local/bin/batty2
systemctl restart batty2.service
for attempt in {1..60}; do
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
