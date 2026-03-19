#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--" ]; then
  shift
fi

batty_dir="${1:?Usage: pnpm dev -- /path/to/batty-root}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
printf -v batty_dir_quoted '%q' "$batty_dir"

cd "$repo_dir"
exec pnpm exec concurrently -k -n client,server "vp dev" "tsx watch src/server/main.ts ${batty_dir_quoted}"
