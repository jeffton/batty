#!/usr/bin/env bash
set -euo pipefail

cd /root/github/pi-face
pnpm install
pnpm check
pnpm test
pnpm build
install -m 644 deploy/pi-face.service /etc/systemd/system/pi-face.service
install -m 644 deploy/pi-face.nginx.conf /etc/nginx/sites-available/pi-face
ln -snf /etc/nginx/sites-available/pi-face /etc/nginx/sites-enabled/pi-face
nginx -t
systemctl daemon-reload
systemctl enable --now pi-face.service
systemctl restart pi-face.service
systemctl reload nginx
