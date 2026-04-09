#!/usr/bin/env bash
set -euo pipefail

step() {
  printf '\n==> %s\n' "$1"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
install_root="${BATTY_INSTALL_ROOT:-/opt/batty}"
release_name="$(git -C "$repo_dir" rev-parse --short HEAD)"

cd "$repo_dir"

step "Installing dependencies"
pnpm install

step "Running checks"
pnpm check

step "Running tests"
pnpm test

step "Building app"
pnpm build

step "Packaging release"
"$repo_dir/scripts/install-release.sh" "$release_name"

step "Installing systemd unit"
install -m 644 deploy/batty.service /etc/systemd/system/batty.service

step "Installing batty CLI"
cat > /usr/local/bin/batty <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node ${install_root}/current/dist/server/cli.mjs "\$@"
EOF
chmod 755 /usr/local/bin/batty

step "Installing nginx config"
install -m 644 deploy/batty.nginx.conf /etc/nginx/sites-available/batty
ln -snf /etc/nginx/sites-available/batty /etc/nginx/sites-enabled/batty

step "Validating nginx config"
nginx -t

step "Handing off service reload"
"$repo_dir/scripts/handoff-restart.sh"

printf '\nDeployed %s successfully\n' "$release_name"
