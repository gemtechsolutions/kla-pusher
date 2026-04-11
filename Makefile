.PHONY: help install dev start stop restart logs clean test subscribe check

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	npm install

dev: ## Run in development mode with auto-reload
	npm run dev

run: ## Start the service
	node index.js

start-bg: ## Start the service in background with PM2
	pm2 start index.js --name pusher-listener
	pm2 save

stop: ## Stop the background service
	pm2 stop pusher-listener

restart: ## Restart the background service
	pm2 restart pusher-listener

logs: ## View service logs (PM2)
	pm2 logs pusher-listener

status: ## Check service status
	pm2 status pusher-listener

clean: ## Clean node_modules and reinstall
	rm -rf node_modules package-lock.json
	npm install

subscribe: ## Subscribe to current event (requires EVENT_ID)
	@if [ -z "$(EVENT_ID)" ]; then \
		echo "Usage: make subscribe EVENT_ID=69c3877f7f569"; \
		exit 1; \
	fi
	curl -X POST http://localhost:3001/api/event/subscribe \
		-H "Content-Type: application/json" \
		-d '{"eventId": "$(EVENT_ID)"}'

check: ## Check latest betting data
	curl http://localhost:3001/api/betting-data/latest | jq

current: ## Get current event info
	curl http://localhost:3001/api/event/current | jq

test-connection: ## Test WebSocket connection
	@echo "Testing connection to http://localhost:3001..."
	@curl -s http://localhost:3001/api/event/current > /dev/null && \
		echo "✅ Service is running!" || \
		echo "❌ Service is not responding"

setup: install ## First-time setup
	@echo "✅ Dependencies installed"
	@echo ""
	@echo "Next steps:"
	@echo "  1. Update .env with your configuration"
	@echo "  2. Run 'make start' to start the service"
	@echo "  3. Run 'make subscribe EVENT_ID=<eventId>' to subscribe to events"
	@echo "  4. Run 'make check' to see betting data"

# Production targets
prod-install: ## Install PM2 globally for production
	npm install -g pm2

prod-start: ## Start in production mode with PM2
	pm2 start index.js --name pusher-listener -i 1
	pm2 save
	pm2 startup

prod-stop: ## Stop production service
	pm2 stop pusher-listener
	pm2 delete pusher-listener

prod-logs: ## Tail production logs
	pm2 logs pusher-listener --lines 100
