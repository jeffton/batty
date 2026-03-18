#!/usr/bin/env bash
set -euo pipefail

step() {
  printf '\n==> %s\n' "$1"
}

cd /root/github/pi-face

step "Installing dependencies"
pnpm install

step "Migrating persisted state"
pnpm exec tsx scripts/migrate-state.ts

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

step "Handing off service reload"
./scripts/handoff-restart.sh

printf '\nDeployed %s successfully\n' "$(git rev-parse --short HEAD)"
