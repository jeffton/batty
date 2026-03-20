#!/usr/bin/env bash
set -euo pipefail

step() {
  printf '\n==> %s\n' "$1"
}

cd /root/github/batty

step "Installing dependencies"
pnpm install

step "Running checks"
pnpm check

step "Running tests"
pnpm test

step "Building app"
pnpm build

step "Installing systemd unit"
install -m 644 deploy/batty.service /etc/systemd/system/batty.service

step "Installing batty CLI"
cat > /usr/local/bin/batty <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /root/github/batty
exec node dist/server/cli.mjs "$@"
EOF
chmod 755 /usr/local/bin/batty

step "Installing nginx config"
install -m 644 deploy/batty.nginx.conf /etc/nginx/sites-available/batty
ln -snf /etc/nginx/sites-available/batty /etc/nginx/sites-enabled/batty

step "Validating nginx config"
nginx -t

step "Handing off service reload"
./scripts/handoff-restart.sh

printf '\nDeployed %s successfully\n' "$(git rev-parse --short HEAD)"
