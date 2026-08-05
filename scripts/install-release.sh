#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
install_root="${BATTY_INSTALL_ROOT:-/opt/batty}"
release_name="${1:-$(git -C "$repo_dir" rev-parse --short HEAD)}"
releases_dir="${install_root}/releases"
current_link="${install_root}/current"

mkdir -p "$install_root" "$releases_dir"
if [[ "$(uname -s)" == "Darwin" ]]; then
  lock_file="${install_root}/.install-release.lock"
  if ! shlock -f "$lock_file" -p $$; then
    printf 'Another Batty release installation is in progress\n' >&2
    exit 1
  fi
else
  exec 9>"${install_root}/.install-release.lock"
  flock 9
fi

if [[ -e "$current_link" && ! -L "$current_link" ]]; then
  printf 'Refusing to replace non-symlink %s\n' "$current_link" >&2
  exit 1
fi

staging_dir="$(mktemp -d "${releases_dir}/.${release_name}.staging.XXXXXX")"
suffix="${staging_dir##*.staging.}"
release_dir="${releases_dir}/${release_name}.${suffix}"
next_current="${install_root}/.current.${release_name}.${suffix}"

cleanup() {
  rm -rf "$staging_dir"
  rm -f "$next_current"
  if [[ -n "${lock_file:-}" ]]; then
    rm -f "$lock_file"
  fi
}
trap cleanup EXIT

mkdir -p "$staging_dir/dist"

cp "$repo_dir/README.md" "$staging_dir/README.md"
cp "$repo_dir/package.json" "$staging_dir/package.json"
cp "$repo_dir/pnpm-lock.yaml" "$staging_dir/pnpm-lock.yaml"
cp "$repo_dir/pnpm-workspace.yaml" "$staging_dir/pnpm-workspace.yaml"
cp -R "$repo_dir/patches" "$staging_dir/patches"
cp -R "$repo_dir/dist/client" "$staging_dir/dist/client"
cp -R "$repo_dir/dist/server" "$staging_dir/dist/server"

(
  cd "$staging_dir"
  pnpm install --prod --frozen-lockfile --ignore-scripts
  pnpm exec playwright install chromium
)

mv "$staging_dir" "$release_dir"
ln -s "$release_dir" "$next_current"
if [[ "$(uname -s)" == "Darwin" ]]; then
  mv -fh "$next_current" "$current_link"
else
  mv -Tf "$next_current" "$current_link"
fi

printf 'Installed Batty release to %s\n' "$release_dir"
printf 'Updated current symlink to %s\n' "$current_link"
