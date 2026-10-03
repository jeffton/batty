#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_root="${BATTY_INSTALL_ROOT:-$HOME/Library/Application Support/Batty/app}"
batty_root="${BATTY_ROOT:-$HOME/Github}"
backend_port="${BATTY_PORT:-3147}"
node_path="${BATTY_NODE:-$(command -v node)}"
log_dir="$HOME/Library/Logs/Batty"
domain="gui/$(id -u)"
label="se.roybot.batty-reload-$(uuidgen)"
mkdir -p "$log_dir"
plist_dir="$(mktemp -d "$log_dir/reload.XXXXXX")"
plist="$plist_dir/worker.plist"
trap 'rm -rf "$plist_dir"' EXIT

# launchd must own the worker independently of the Batty job it will unload.
PLIST_PATH="$plist" RELOAD_LABEL="$label" RELOAD_DOMAIN="$domain" SCRIPT_DIR="$script_dir" \
  LOG_DIR="$log_dir" PATH_VALUE="$PATH" BATTY_INSTALL_ROOT="$install_root" \
  BATTY_ROOT="$batty_root" BATTY_PORT="$backend_port" BATTY_NODE="$node_path" \
  BATTY_RESTART_SESSION_FILE="${PI_SESSION_FILE:-}" \
  BATTY_RESTART_AFTER_ENTRY_ID="${PI_RESTART_AFTER_ENTRY_ID:-}" \
  BATTY_SKIP_DRAIN="${BATTY_SKIP_DRAIN:-}" python3 <<'PY'
import os
import plistlib

env = os.environ
log = os.path.join(env["LOG_DIR"], "deploy.log")
service = env["RELOAD_DOMAIN"] + "/" + env["RELOAD_LABEL"]
plist = {
    "Label": env["RELOAD_LABEL"],
    "ProgramArguments": [
        "/bin/bash", "-c",
        '"$@"; status=$?; printf "Batty reload finished (exit %s)\\n" "$status"; '
        'launchctl bootout "$BATTY_RELOAD_SERVICE"; exit "$status"',
        "batty-reload", "/bin/bash",
        os.path.join(env["SCRIPT_DIR"], "restart-services-macos.sh"),
    ],
    "EnvironmentVariables": {
        **{key: env[key] for key in (
            "BATTY_INSTALL_ROOT", "BATTY_ROOT", "BATTY_PORT", "BATTY_NODE", "BATTY_SKIP_DRAIN",
            "BATTY_RESTART_SESSION_FILE", "BATTY_RESTART_AFTER_ENTRY_ID",
        )},
        "BATTY_RELOAD_SERVICE": service,
        "PATH": env["PATH_VALUE"],
    },
    "RunAtLoad": True,
    "KeepAlive": False,
    "StandardOutPath": log,
    "StandardErrorPath": log,
}
with open(env["PLIST_PATH"], "wb") as handle:
    plistlib.dump(plist, handle)
PY

launchctl bootstrap "$domain" "$plist"
printf 'Handed off launchd reload to %s\n' "$label"
