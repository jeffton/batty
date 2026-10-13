#!/usr/bin/env bash

# Deployment lifecycle helpers shared by Linux and macOS.

canonical_release_path() {
  (cd "$1" && pwd -P)
}

preflight_disk() {
  local path=$1
  local minimum_kb=$2
  local available_kb
  available_kb=$(df -Pk "$path" | awk 'NR == 2 { print $4 }')
  if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || (( available_kb < minimum_kb )); then
    printf 'Insufficient disk space on %s: %s KiB available, %s KiB required.\n' \
      "$path" "${available_kb:-unknown}" "$minimum_kb" >&2
    return 1
  fi
}

health_matches_expected() {
  local response=$1
  local expected_build_id=$2
  node -e '
    const health = JSON.parse(process.argv[1]);
    process.exit(health.ok === true && health.buildId === process.argv[2] ? 0 : 1);
  ' "$response" "$expected_build_id"
}

newest_release_paths() {
  local releases_dir=$1 release name timestamp
  for release in "$releases_dir"/*; do
    [[ -d "$release" ]] || continue
    name=${release##*/}
    timestamp=${name##*.}
    printf '%s\t%s\n' "$timestamp" "$release"
  done | LC_ALL=C sort -rn | cut -f2-
}

write_client_asset_manifest() {
  local assets_dir=$1
  local manifest=$2
  (cd "$assets_dir" && find . -type f | cut -c3- | LC_ALL=C sort) > "$manifest"
}

copy_retained_client_assets() {
  local releases_dir=$1
  local new_release=$2
  local active_release=$3
  local target_assets="$new_release/dist/client/assets"
  local retained=0 release manifest asset canonical_active=
  if [[ -e "$active_release" || -L "$active_release" ]]; then
    canonical_active=$(canonical_release_path "$active_release")
  fi

  while IFS= read -r release; do
    [[ -n "$release" && "$release" != "$new_release" ]] || continue
    manifest="$release/CLIENT_ASSETS.txt"
    if [[ ! -f "$release/HEALTHY" && ( "$(canonical_release_path "$release")" != "$canonical_active" || -f "$manifest" ) ]]; then
      continue
    fi

    if [[ ! -f "$manifest" ]]; then
      # One-time migration: legacy releases have no ownership manifest. Copy
      # the active release's assets for its open clients, but never inherit
      # this catch-all set again on subsequent deployments.
      [[ "$(canonical_release_path "$release")" == "$canonical_active" ]] || continue
      cp -a "$release/dist/client/assets/." "$target_assets/"
      retained=$((retained + 1))
      if (( retained >= 2 )); then break; fi
      continue
    fi

    while IFS= read -r asset; do
      [[ -n "$asset" ]] || continue
      mkdir -p "$target_assets/$(dirname "$asset")"
      if [[ ! -e "$target_assets/$asset" ]]; then
        cp "$release/dist/client/assets/$asset" "$target_assets/$asset"
      fi
    done < "$manifest"

    retained=$((retained + 1))
    if (( retained >= 2 )); then break; fi
  done < <(newest_release_paths "$releases_dir")
}

prune_releases() {
  local releases_dir=$1
  local active_release=$2
  local keep=0 release canonical_active
  canonical_active=$(canonical_release_path "$active_release")

  while IFS= read -r release; do
    [[ -d "$release" ]] || continue
    if [[ "$(canonical_release_path "$release")" == "$canonical_active" ]]; then
      continue
    fi
    # Pre-manifest releases predate the health marker. Keep two legacy rollback
    # candidates during migration; new unverified releases are never retained.
    if [[ ! -f "$release/HEALTHY" && -f "$release/CLIENT_ASSETS.txt" ]]; then
      rm -rf -- "$release"
      continue
    fi
    keep=$((keep + 1))
    if (( keep > 2 )); then
      rm -rf -- "$release"
    fi
  done < <(newest_release_paths "$releases_dir")
}
