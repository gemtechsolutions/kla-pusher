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
# .env is NOT touched — manage it on the box separately. It holds
# non-secret config (PORT, REGISTRY_SOURCE, URLs) and the BC24_* credentials
# until those move to Secrets Manager too.
#
# .env.secrets IS managed: render-env.sh fetches it from AWS Secrets Manager
# on every kla-pusher start (via systemd ExecStartPre). The instance profile
# grants read on the `kla-secrets-production` ARN only.

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

echo "==> Syncing scripts/render-env.sh"
rsync -azL \
  -e "ssh ${SSH_OPTS[*]}" \
  --rsync-path="sudo rsync" \
  --chmod=0755 \
  scripts/render-env.sh "$EC2_HOST:$REMOTE_DIR/render-env.sh"

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

# awscli + jq feed render-env.sh which the systemd unit runs as
# ExecStartPre. New instances get these from user_data, but older boxes
# created before that change need them installed on first deploy.
if ! command -v aws >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  sudo dnf install -y awscli jq
fi

# render-env.sh needs to be owned by root so the kla-pusher user can't
# tamper with the script that writes its own env. Executable only.
sudo chown root:root /opt/kla-pusher/render-env.sh
sudo chmod 0755 /opt/kla-pusher/render-env.sh

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
# Hand-managed non-secret config (PORT, REGISTRY_SOURCE, BC24_*, URLs).
EnvironmentFile=-/opt/kla-pusher/.env
# Secret bundle written by render-env.sh on every start. Loaded after .env
# so it wins on overlapping keys (e.g. SITE_API_SERVICE_TOKEN).
EnvironmentFile=-/opt/kla-pusher/.env.secrets
# Refresh secrets from AWS Secrets Manager before each start. Runs as root
# (script chowns the output to kla-pusher:kla-pusher with 0600). If the
# call fails, the service won't start — that's intentional: we'd rather
# refuse to boot than silently run with stale credentials.
ExecStartPre=/opt/kla-pusher/render-env.sh
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
