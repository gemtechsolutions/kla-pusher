#!/usr/bin/env bash
# kla-pusher: build locally, push artifacts to the EC2, restart the service.
#
# Required env vars:
#   EC2_HOST  e.g. ec2-user@1.2.3.4 (or the EIP from terraform output)
#   SSH_KEY   path to the .pem (terraform-managed key sits at
#             ../../kla-devops/production/ec2/.keys/kla-pusher-production.pem)
#
# What this does:
#   1. Builds dist/ locally (yarn build).
#   2. Rsyncs dist/, package.json, yarn.lock to /opt/kla-pusher on the box
#      using `sudo rsync` so we can write into the kla-pusher-owned dir.
#   3. Installs production deps with yarn (auto-installs yarn on first run).
#   4. Writes/updates the systemd unit and restarts kla-pusher.
#
# .env is NOT touched. Manage it on the box separately — it holds secrets
# (BC24_PASSWORD, SITE_API_SERVICE_TOKEN) that should never be in this repo.

set -euo pipefail

: "${EC2_HOST:?Set EC2_HOST=ec2-user@<ip>}"
: "${SSH_KEY:?Set SSH_KEY=path/to/key.pem}"

REMOTE_DIR=/opt/kla-pusher
SERVICE=kla-pusher
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

# Repo root (where package.json lives) — script may be invoked from anywhere.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Building dist/ locally"
yarn build

# `rsync` is installed by the EC2's user_data on first boot (see
# kla-devops/production/ec2/main.tf). If you're deploying onto an older
# box that pre-dates that change, SSH in once and `sudo dnf install -y rsync`.

echo "==> Syncing dist/ → $EC2_HOST:$REMOTE_DIR/dist/"
rsync -azL --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --rsync-path="sudo rsync" \
  dist/ "$EC2_HOST:$REMOTE_DIR/dist/"

echo "==> Syncing package.json + yarn.lock"
rsync -azL \
  -e "ssh ${SSH_OPTS[*]}" \
  --rsync-path="sudo rsync" \
  package.json yarn.lock "$EC2_HOST:$REMOTE_DIR/"

echo "==> Installing prod deps + restarting $SERVICE"
ssh "${SSH_OPTS[@]}" "$EC2_HOST" bash -s <<'REMOTE'
set -euxo pipefail

# Files just landed owned by root (we rsync'd with sudo); fix ownership so
# the kla-pusher service user can read them.
sudo chown -R kla-pusher:kla-pusher /opt/kla-pusher
cd /opt/kla-pusher

# Yarn isn't in AL2023's default repos; install on first run.
if ! command -v yarn >/dev/null 2>&1; then
  sudo npm install -g yarn
fi

# Clean the yarn cache before installing — the 8GB root volume fills up
# fast otherwise, especially because esbuild's optionalDependencies pull
# prebuilts for every platform.
sudo -u kla-pusher yarn cache clean

# Production install:
#   --frozen-lockfile  fail if yarn.lock is out of sync (never silently resolve a different tree on prod)
#   --ignore-optional  skip esbuild platform prebuilts we don't need (linux-x64/win32/openbsd/etc)
sudo -u kla-pusher yarn install --production --frozen-lockfile --ignore-optional

# Systemd unit — re-written every deploy so changes here propagate without
# a separate provisioning step. `EnvironmentFile=-` (leading dash) means
# the service still starts if .env is missing, so the first deploy doesn't
# fail before you've populated secrets.
sudo tee /etc/systemd/system/kla-pusher.service >/dev/null <<'UNIT'
[Unit]
Description=kla-pusher — real-time betting events relay
After=network.target

[Service]
Type=simple
User=kla-pusher
WorkingDirectory=/opt/kla-pusher
EnvironmentFile=-/opt/kla-pusher/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
# bc24 + many SSE clients can need a lot of fds.
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable kla-pusher
sudo systemctl restart kla-pusher
sleep 2
sudo systemctl is-active kla-pusher
REMOTE

echo ""
echo "==> Deploy complete."
echo "    Tail logs:   ssh ${SSH_OPTS[*]} $EC2_HOST 'sudo journalctl -u $SERVICE -f'"
echo "    Status:      ssh ${SSH_OPTS[*]} $EC2_HOST 'sudo systemctl status $SERVICE --no-pager'"
