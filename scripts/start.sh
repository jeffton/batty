#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--" ]; then
  shift
fi

pi_face_dir="${1:?Usage: pnpm start -- /path/to/pi-face-root}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"

cd "$repo_dir"
exec node dist/server/main.mjs "$pi_face_dir"
