#!/usr/bin/env bash
set -euo pipefail

step() {
  printf '\n==> %s\n' "$1"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'This deployment script requires macOS.\n' >&2
  exit 1
fi
if [[ "$(id -u)" -eq 0 ]]; then
  printf 'Run this script as the macOS user who will run Batty, without sudo.\n' >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
install_root="${BATTY_INSTALL_ROOT:-$HOME/Library/Application Support/Batty/app}"
batty_root="${BATTY_ROOT:-$HOME/Github}"
workspaces_root="${BATTY_WORKSPACES_ROOT:-$HOME/Github}"
label="se.roybot.batty"
launch_agents_dir="$HOME/Library/LaunchAgents"
plist="$launch_agents_dir/${label}.plist"
log_dir="$HOME/Library/Logs/Batty"
cli_path="$HOME/.local/bin/batty"
node_path="$(command -v node)"
release_name="$(git -C "$repo_dir" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
options_dir="$batty_root/.batty"
options_path="$options_dir/options.json"
domain="gui/$(id -u)"
was_running=false

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm is required. Install the packageManager version from package.json first.\n' >&2
  exit 1
fi
if launchctl print "${domain}/${label}" >/dev/null 2>&1; then
  was_running=true
fi

cd "$repo_dir"
step "Installing dependencies"
pnpm install --frozen-lockfile

step "Running checks"
pnpm check

step "Running tests"
test_storage="$(mktemp -t batty-test-local-storage)"
if ! NODE_OPTIONS="${NODE_OPTIONS:-} --localstorage-file=$test_storage" pnpm test; then
  rm -f "$test_storage"
  exit 1
fi
rm -f "$test_storage"

step "Building app"
pnpm build

if [[ ! -f "$options_path" ]]; then
  step "Initializing Batty root configuration"
  mkdir -p "$options_dir"
  OPTIONS_PATH="$options_path" WORKSPACES_ROOT="$workspaces_root" node <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.env.OPTIONS_PATH, `${JSON.stringify({
  workspacesRoots: [process.env.WORKSPACES_ROOT],
  webPushSubject: "mailto:batty@localhost",
}, null, 2)}\n`, { mode: 0o600 });
NODE
fi

step "Packaging release"
BATTY_INSTALL_ROOT="$install_root" "$script_dir/install-release.sh" "$release_name"

step "Installing launch agent and CLI"
mkdir -p "$launch_agents_dir" "$log_dir" "$(dirname "$cli_path")"
PLIST_PATH="$plist" LABEL="$label" NODE_PATH="$node_path" INSTALL_ROOT="$install_root" \
  BATTY_ROOT="$batty_root" LOG_DIR="$log_dir" PATH_VALUE="$PATH" python3 <<'PY'
import os
import plistlib

install_root = os.environ["INSTALL_ROOT"]
current = os.path.join(install_root, "current")
plist = {
    "Label": os.environ["LABEL"],
    "ProgramArguments": [
        os.environ["NODE_PATH"],
        os.path.join(current, "dist/server/main.mjs"),
        os.environ["BATTY_ROOT"],
    ],
    "WorkingDirectory": current,
    "EnvironmentVariables": {
        "BATTY_HOST": "127.0.0.1",
        "BATTY_PORT": "3147",
        "BATTY_SELF_PATH": current,
        "PATH": os.environ["PATH_VALUE"],
    },
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 2,
    "StandardOutPath": os.path.join(os.environ["LOG_DIR"], "batty.log"),
    "StandardErrorPath": os.path.join(os.environ["LOG_DIR"], "batty-error.log"),
}
with open(os.environ["PLIST_PATH"], "wb") as handle:
    plistlib.dump(plist, handle)
PY
cat > "$cli_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$node_path" "$install_root/current/dist/server/cli.mjs" "\$@"
EOF
chmod 755 "$cli_path" "$script_dir/restart-services-macos.sh" \
  "$script_dir/handoff-restart-macos.sh"
plutil -lint "$plist"

if [[ "$was_running" == true ]]; then
  step "Handing off launch agent reload"
  "$script_dir/handoff-restart-macos.sh"
  printf '\nRelease %s will activate after the handoff delay.\n' "$release_name"
else
  step "Starting launch agent"
  "$script_dir/restart-services-macos.sh"
  printf '\nBatty %s is running at http://localhost:3147\n' "$release_name"
  setup_code="$(grep -E 'Setup code:' "$log_dir/batty.log" | tail -1 || true)"
  if [[ -n "$setup_code" ]]; then
    printf '%s\n' "$setup_code"
  fi
fi
