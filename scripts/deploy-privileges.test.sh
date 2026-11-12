#!/usr/bin/env bash
# Exercise non-root deployment without writing installation paths or services.
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/repo/scripts" "$fixture/bin" "$fixture/archive/scripts"
cp "$source_dir"/{deploy.sh,deploy-lib.sh} "$fixture/repo/scripts/"
cat > "$fixture/bin/id" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "${TEST_ADMIN:-1001}"
SCRIPT
cat > "$fixture/bin/sudo" <<'SCRIPT'
#!/usr/bin/env bash
[[ $1 == -n ]] || exit 21
shift
TEST_ADMIN=0 exec "$@"
SCRIPT
cat > "$fixture/bin/git" <<'SCRIPT'
#!/usr/bin/env bash
case $1 in
  pull|diff) exit 0 ;;
  rev-parse) echo test123 ;;
  archive) tar -c -C "$FIXTURE/archive" . ;;
  *) exit 22 ;;
esac
SCRIPT
cat > "$fixture/bin/pnpm" <<'SCRIPT'
#!/usr/bin/env bash
[[ $(id -u) == 1001 ]] || exit 23
case $1 in
  install)
    [[ $(<patches/dependency.patch) == 'dependency patch' ]] || exit 25
    mkdir -p node_modules; printf 'dependencies' > node_modules/fixture
    ;;
  build) mkdir -p dist/client/assets; printf 'client' > dist/client/assets/client.js ;;
  *) exit 24 ;;
esac
SCRIPT
cat > "$fixture/bin/ffmpeg" <<'SCRIPT'
#!/usr/bin/env bash
if [[ $* == *-demuxers* ]]; then printf ' D  x11grab X11 capture\n'; fi
SCRIPT
for executable in Xvfb xauth; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture/bin/$executable"
done
cat > "$fixture/repo/scripts/setup-chrome.sh" <<'SCRIPT'
#!/usr/bin/env bash
[[ $(id -u) == 0 ]]
SCRIPT
cp "$fixture/repo/scripts/setup-chrome.sh" "$fixture/archive/scripts/setup-browser-isolation.sh"
cat > "$fixture/repo/scripts/deploy-admin.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && $2 == test123 ]]
[[ -f $1/dist/client/assets/client.js && -f $1/node_modules/fixture ]]
[[ $(<"$1/patches/dependency.patch") == 'dependency patch' ]]
[[ $(<"$1/BUILD_ID") == test123 && $(<"$1/CLIENT_ASSETS.txt") == client.js ]]
printf 'installed\n' > "$FIXTURE/result"
SCRIPT
for file in package.json pnpm-lock.yaml pnpm-workspace.yaml README.md; do
  printf 'fixture\n' > "$fixture/archive/$file"
done
mkdir -p "$fixture/archive/patches"
printf 'dependency patch' > "$fixture/archive/patches/dependency.patch"
chmod +x "$fixture/bin/"*
FIXTURE="$fixture" PATH="$fixture/bin:$PATH" BATTY2_DEPLOY_MIN_FREE_KB=1 bash "$fixture/repo/scripts/deploy.sh"
[[ $(<"$fixture/result") == installed ]]
# Exercise the actual install operation with the service's private umask. The
# resulting release contains public code, not runtime credentials/state.
if [[ $(id -u) == 0 ]]; then
  source "$source_dir/deploy-lib.sh"
  (
    umask 0077
    mkdir -p "$fixture/private-stage/dist/server"
    printf 'server code\n' > "$fixture/private-stage/dist/server/main.mjs"
    printf '#!/bin/sh\nexit 0\n' > "$fixture/private-stage/tool"
    chmod u+x "$fixture/private-stage/tool"
    mkdir -p "$fixture/releases/old.1/dist/client/assets/nested" "$fixture/private-stage/dist/client/assets"
    printf 'old client\n' > "$fixture/releases/old.1/dist/client/assets/nested/old.js"
    printf 'nested/old.js\n' > "$fixture/releases/old.1/CLIENT_ASSETS.txt"
    touch "$fixture/releases/old.1/HEALTHY"
    ln -s "$fixture/releases/old.1" "$fixture/current"
    prepare_release_files "$fixture/private-stage" "$fixture/installed" "$fixture/releases" "$fixture/current"
  )
  [[ $(stat -c %u "$fixture/installed/dist/server/main.mjs") == 0 ]]
  [[ $(stat -c %a "$fixture/installed/dist/server/main.mjs") == 644 ]]
  [[ $(stat -c %a "$fixture/installed/dist/server") == 755 ]]
  [[ $(stat -c %a "$fixture/installed/tool") == 755 ]]
  chmod 711 "$fixture"
  runuser -u nobody -- test -r "$fixture/installed/dist/server/main.mjs"
  runuser -u nobody -- test -r "$fixture/installed/dist/client/assets/nested/old.js"
  # Legacy releases copy directory modes as well as file modes.
  mv "$fixture/releases/old.1/CLIENT_ASSETS.txt" "$fixture/old-manifest.txt"
  (umask 0077; prepare_release_files "$fixture/private-stage" "$fixture/legacy" "$fixture/releases" "$fixture/current")
  runuser -u nobody -- test -r "$fixture/legacy/dist/client/assets/nested/old.js"
fi
printf 'non-root deployment privilege separation passed\n'
