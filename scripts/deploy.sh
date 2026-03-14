#!/usr/bin/env bash
set -euo pipefail

step() {
  printf '\n==> %s\n' "$1"
}

cd /root/github/pi-face

step "Installing dependencies"
pnpm install

step "Running checks"
pnpm check

step "Running tests"
pnpm test

step "Building app"
pnpm build

step "Installing systemd unit"
install -m 644 deploy/pi-face.service /etc/systemd/system/pi-face.service

step "Installing nginx config"
install -m 644 deploy/pi-face.nginx.conf /etc/nginx/sites-available/pi-face
ln -snf /etc/nginx/sites-available/pi-face /etc/nginx/sites-enabled/pi-face

step "Validating nginx config"
nginx -t

step "Reloading services"
systemctl daemon-reload
systemctl enable pi-face.service >/dev/null
systemctl restart pi-face.service
systemctl reload nginx

step "Verifying deployment"
systemctl is-active --quiet pi-face.service
curl --fail --silent --show-error --head --max-time 10 http://127.0.0.1/ >/dev/null

printf '\nDeployed %s successfully\n' "$(git rev-parse --short HEAD)"
