#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/deploy-lib.sh"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

# Disk preflight accepts a realistic threshold and rejects an impossible one.
available_kb=$(df -Pk "$tmp" | awk 'NR == 2 { print $4 }')
preflight_disk "$tmp" "$((available_kb - 100))"
if preflight_disk "$tmp" 999999999999; then
  echo 'Expected disk preflight to reject an impossible threshold.' >&2
  exit 1
fi

# Native video preflight rejects builds lacking the capture demuxer or encoder.
(
  Xvfb() { :; }
  xauth() { :; }
  ffmpeg() { [[ "$*" == *-demuxers* ]] && printf ' D  x11grab X11 capture\n'; return 0; }
  preflight_browser_video
  ffmpeg() { [[ "$*" == *-demuxers* ]] && printf ' D  other Other input\n'; return 0; }
  if preflight_browser_video; then echo 'Accepted FFmpeg without x11grab.' >&2; exit 1; fi
  ffmpeg() { if [[ "$*" == *-demuxers* ]]; then printf ' D  x11grab X11 capture\n'; else return 1; fi; }
  if preflight_browser_video; then echo 'Accepted a missing H.264 encoder.' >&2; exit 1; fi
)

# Health gate requires both a successful response and the exact new build ID.
health_matches_expected '{"ok":true,"buildId":"abc123"}' abc123
if health_matches_expected '{"ok":true,"buildId":"old"}' abc123; then
  echo 'Health gate accepted the wrong build ID.' >&2
  exit 1
fi
if health_matches_expected '{"ok":false,"buildId":"abc123"}' abc123; then
  echo 'Health gate accepted an unhealthy response.' >&2
  exit 1
fi
if health_matches_expected '{invalid' abc123 2>/dev/null; then
  echo 'Health gate accepted malformed JSON.' >&2
  exit 1
fi

# Asset manifests use relative paths on both BSD and GNU find.
mkdir -p "$tmp/manifest assets/nested"
printf 'chunk' > "$tmp/manifest assets/nested/chunk.js"
write_client_asset_manifest "$tmp/manifest assets" "$tmp/manifest.txt"
[[ $(<"$tmp/manifest.txt") == nested/chunk.js ]]
[[ $(canonical_release_path "$tmp/manifest assets") == "$(cd "$tmp/manifest assets" && pwd -P)" ]]

# A release carries only its own chunks and the explicitly listed chunks from
# the two newest retained releases, never inherited/stale assets.
releases="$tmp/releases"
mkdir -p "$releases/r1.1/dist/client/assets" "$releases/r2.2/dist/client/assets" \
  "$releases/r3.3/dist/client/assets" "$releases/r4.4/dist/client/assets"
printf 'new' > "$releases/r4.4/dist/client/assets/new.js"
printf 'old1' > "$releases/r3.3/dist/client/assets/old1.js"
printf 'old2' > "$releases/r2.2/dist/client/assets/old2.js"
printf 'stale' > "$releases/r1.1/dist/client/assets/stale.js"
printf 'new.js\n' > "$releases/r4.4/CLIENT_ASSETS.txt"
printf 'old1.js\n' > "$releases/r3.3/CLIENT_ASSETS.txt"
printf 'old2.js\n' > "$releases/r2.2/CLIENT_ASSETS.txt"
touch "$releases/r2.2/HEALTHY" "$releases/r3.3/HEALTHY"
ln -s "$releases/r3.3" "$tmp/current-for-assets"
copy_retained_client_assets "$releases" "$releases/r4.4" "$tmp/current-for-assets"
[[ -f "$releases/r4.4/dist/client/assets/old1.js" ]]
[[ -f "$releases/r4.4/dist/client/assets/old2.js" ]]
[[ ! -e "$releases/r4.4/dist/client/assets/stale.js" ]]

# The active pre-manifest release gets a one-time migration copy only.
legacy_releases="$tmp/legacy-releases"
mkdir -p "$legacy_releases/legacy.0/dist/client/assets" "$legacy_releases/next.5/dist/client/assets"
printf 'legacy-open-tab' > "$legacy_releases/legacy.0/dist/client/assets/old-client.js"
printf 'next-build' > "$legacy_releases/next.5/dist/client/assets/new-client.js"
printf 'new-client.js\n' > "$legacy_releases/next.5/CLIENT_ASSETS.txt"
ln -s "$legacy_releases/legacy.0" "$tmp/legacy-current"
copy_retained_client_assets "$legacy_releases" "$legacy_releases/next.5" "$tmp/legacy-current"
[[ -f "$legacy_releases/next.5/dist/client/assets/old-client.js" ]]
! grep -q 'old-client.js' "$legacy_releases/next.5/CLIENT_ASSETS.txt"

# An unverified release left by a failed health gate is not a chunk source.
failed_releases="$tmp/failed-releases"
mkdir -p "$failed_releases/good.1/dist/client/assets" \
  "$failed_releases/failed.2/dist/client/assets" \
  "$failed_releases/next.3/dist/client/assets"
printf 'good' > "$failed_releases/good.1/dist/client/assets/good.js"
printf 'failed' > "$failed_releases/failed.2/dist/client/assets/failed.js"
printf 'good.js\n' > "$failed_releases/good.1/CLIENT_ASSETS.txt"
printf 'failed.js\n' > "$failed_releases/failed.2/CLIENT_ASSETS.txt"
printf 'next' > "$failed_releases/next.3/dist/client/assets/next.js"
printf 'next.js\n' > "$failed_releases/next.3/CLIENT_ASSETS.txt"
touch "$failed_releases/good.1/HEALTHY"
ln -s "$failed_releases/failed.2" "$tmp/failed-current"
copy_retained_client_assets "$failed_releases" "$failed_releases/next.3" "$tmp/failed-current"
[[ -f "$failed_releases/next.3/dist/client/assets/good.js" ]]
[[ ! -e "$failed_releases/next.3/dist/client/assets/failed.js" ]]

# Pruning permanently removes obsolete releases without invoking trash.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/trash" <<'MOCK'
#!/usr/bin/env bash
exit 99
MOCK
chmod +x "$tmp/bin/trash"
for release in r1.1 r2.2 r3.3 r4.4; do mkdir -p "$releases/$release"; done
touch "$releases/r2.2/HEALTHY" "$releases/r3.3/HEALTHY"
ln -s "$releases/r4.4" "$tmp/current"
mkdir -p "$releases/failed.5"
printf 'failed.js\n' > "$releases/failed.5/CLIENT_ASSETS.txt"
PATH="$tmp/bin:$PATH" prune_releases "$releases" "$tmp/current"
[[ -d "$releases/r4.4" ]]
[[ -d "$releases/r3.3" ]]
[[ -d "$releases/r2.2" ]]
[[ ! -e "$releases/r1.1" ]]
[[ ! -e "$releases/failed.5" ]]

# An older active release is protected independently of rollback ordering.
ln -sfn "$releases/r2.2" "$tmp/current"
mkdir -p "$releases/r5.5" "$releases/r6.6"
touch "$releases/r5.5/HEALTHY" "$releases/r6.6/HEALTHY"
PATH="$tmp/bin:$PATH" prune_releases "$releases" "$tmp/current"
[[ -d "$releases/r2.2" ]]
[[ -d "$releases/r5.5" ]]
[[ -d "$releases/r6.6" ]]
[[ ! -e "$releases/r3.3" ]]
[[ ! -e "$releases/r4.4" ]]

printf 'deploy lifecycle tests passed\n'
