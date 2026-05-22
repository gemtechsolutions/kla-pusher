YARN ?= yarn
PORT ?= 3001

# Deploy targets — override on the command line:
#   EC2_HOST=ec2-user@<eip> SSH_KEY=~/path/to/key.pem make deploy
EC2_HOST ?= ec2-user@13.213.84.178
SSH_KEY  ?= /home/user/Documents/projects/khmer-lotto/kla-devops/production/ec2/.keys/kla-pusher-production.pem

.PHONY: help install dev build start typecheck clean health subscribe-info deploy logs status

help:
	@echo "kla-pusher v2 - Makefile commands"
	@echo ""
	@echo "Development:"
	@echo "  make install     Install dependencies (yarn)"
	@echo "  make dev         Run with tsx watch (TypeScript, hot reload)"
	@echo "  make build       Compile TS to dist/"
	@echo "  make start       Run the compiled service (after build)"
	@echo "  make typecheck   tsc --noEmit"
	@echo "  make clean       Remove node_modules and dist"
	@echo ""
	@echo "Operations:"
	@echo "  make health      curl /_health"
	@echo "  make subscribe-info  Show how the SSE endpoint is consumed"
	@echo ""
	@echo "Production (require EC2_HOST=ec2-user@<eip> SSH_KEY=...):"
	@echo "  make deploy      Build + rsync to the EC2 + restart systemd"
	@echo "  make logs        Tail kla-pusher logs (journalctl -f)"
	@echo "  make status      Show systemd service status"

install:
	$(YARN) install

dev:
	$(YARN) dev

build:
	$(YARN) build

start:
	$(YARN) start

typecheck:
	$(YARN) typecheck

clean:
	rm -rf node_modules dist

health:
	@curl -s http://localhost:$(PORT)/_health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:$(PORT)/_health

subscribe-info:
	@echo "SSE endpoint: GET http://localhost:$(PORT)/sse?streamId=<id>"
	@echo "List active streams: GET http://localhost:$(PORT)/api/streams"
	@echo ""
	@echo "Registry source: \$$REGISTRY_SOURCE (local | site-api)"
	@echo "  local  → ./data/streams.json (array of StreamMeta)"
	@echo "  site-api → GET \$$SITE_API_BASE_URL/api/private/internal/streams"

# Deploy = build locally + rsync dist/ + (re)write systemd unit + restart.
# Pulls EC2_HOST + SSH_KEY from the environment so the script can run
# standalone too. `.env` on the remote is NOT touched; manage it via SSH.
deploy:
	@test -n "$(EC2_HOST)" || { echo "EC2_HOST required: EC2_HOST=ec2-user@<eip> SSH_KEY=path/to/key.pem make deploy"; exit 1; }
	@test -n "$(SSH_KEY)"  || { echo "SSH_KEY required: EC2_HOST=ec2-user@<eip> SSH_KEY=path/to/key.pem make deploy"; exit 1; }
	EC2_HOST="$(EC2_HOST)" SSH_KEY="$(SSH_KEY)" ./scripts/deploy.sh

logs:
	@test -n "$(EC2_HOST)" || { echo "EC2_HOST required"; exit 1; }
	@test -n "$(SSH_KEY)"  || { echo "SSH_KEY required"; exit 1; }
	ssh -i "$(SSH_KEY)" "$(EC2_HOST)" 'sudo journalctl -u kla-pusher -f'

status:
	@test -n "$(EC2_HOST)" || { echo "EC2_HOST required"; exit 1; }
	@test -n "$(SSH_KEY)"  || { echo "SSH_KEY required"; exit 1; }
	ssh -i "$(SSH_KEY)" "$(EC2_HOST)" 'sudo systemctl status kla-pusher --no-pager'
