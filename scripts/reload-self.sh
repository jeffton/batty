#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
release_name="$(git -C "$repo_dir" rev-parse --short HEAD)"

cd "$repo_dir"
pnpm build
"$repo_dir/scripts/install-release.sh" "$release_name"
"$repo_dir/scripts/handoff-restart.sh"
