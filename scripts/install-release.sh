#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
install_root="${BATTY_INSTALL_ROOT:-/opt/batty}"
release_name="${1:-$(git -C "$repo_dir" rev-parse --short HEAD)}"
release_dir="${install_root}/releases/${release_name}"

mkdir -p "$install_root" "${install_root}/releases"

tmp_dir="$(mktemp -d "${install_root}/.release-${release_name}.XXXXXX")"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

rm -rf "$release_dir"
mkdir -p "$tmp_dir/dist"

cp "$repo_dir/README.md" "$tmp_dir/README.md"
cp "$repo_dir/package.json" "$tmp_dir/package.json"
cp -R "$repo_dir/dist/client" "$tmp_dir/dist/client"
cp -R "$repo_dir/dist/server" "$tmp_dir/dist/server"

mv "$tmp_dir" "$release_dir"
ln -sfn "$release_dir" "${install_root}/current"

printf 'Installed Batty release to %s\n' "$release_dir"
printf 'Updated current symlink to %s\n' "${install_root}/current"
