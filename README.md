# Pusher Betting Data Listener Service

This Node.js service connects to the sultadahan247.live Laravel Echo WebSocket server and streams real-time betting data to your frontend.

## Quick Start

```bash
# First-time setup
make setup

# Start the service
make start

# Subscribe to an event
make subscribe EVENT_ID=69c3877f7f569

# Check latest betting data
make check
```

For all available commands, run `make help`.

## Manual Setup

### Install Dependencies
```bash
npm install
```

### Environment Variables

Create a `.env` file:

```env
PORT=3001
SOCKET_HOST=wss://ws.web-services.live:6001
APP_KEY=shifenkey123
```

### Running Locally

```bash
# Direct
node index.js

# Or using make
make start

# Or with auto-reload
make dev
```

## API Endpoints

### Subscribe to Event

```bash
POST /api/event/subscribe
Content-Type: application/json

{
  "eventId": "69c3877f7f569"
}
```

### Get Current Event

```bash
GET /api/event/current
```

### Get Latest Betting Data

```bash
GET /api/betting-data/latest
```

### Server-Sent Events (Real-time Stream)

```bash
GET /api/betting-data/stream
```

## How It Works

1. Connects to `wss://ws.web-services.live:6001` using Pusher protocol
2. Subscribes to 8 channels for each event:
   - `betting-status-{eventId}`
   - `place-bet-{eventId}` (contains betting data)
   - `event-status-{eventId}`
   - `declare-winner-{eventId}`
   - `send-notification-{eventId}`
   - `jump-number-{eventId}`
   - `refresh-all-{eventId}`
   - `change-team-{eventId}`
3. Broadcasts received data via Server-Sent Events (SSE)

## Deployment

Since this requires a long-running WebSocket connection, deploy to:

- **Railway**: `railway up`
- **Render**: Connect GitHub repo and deploy
- **AWS EC2/Lightsail**: Use PM2 for process management
- **DigitalOcean Droplet**: Use PM2 for process management

### Using PM2 (Production)

```bash
npm install -g pm2
pm2 start index-v2.js --name pusher-listener
pm2 save
pm2 startup
```

## Frontend Integration

Update your frontend's `.env`:

```env
VITE_BETTING_DATA_API=https://your-deployed-service.com
```

The React hook `useBettingData()` will automatically connect to the SSE stream.

## Data Structure

The service receives betting data in this format:

```json
{
  "channel": "place-bet-69c3877f7f569",
  "event": "App\\Events\\PlaceBet",
  "data": {
    "betData": {
      "betMeron": "154106.00",
      "betWala": "155483.00",
      "betDraw": "0.00",
      "percentMeron": "182.80",
      "percentWala": "181.19",
      "myBetMeron": "147243.00",
      "myBetWala": "147444.00",
      "myBetDraw": "0.00",
      "gbbetMeron": "147243.00",
      "gbbetWala": "147444.00",
      "actualMeron": "6863.00",
      "actualWala": "8039.00"
    },
    "eventId": "69c3877f7f569"
  },
  "timestamp": 1774451080313,
  "eventId": "69c3877f7f569"
}
```

## Troubleshooting

- **No data received**: Make sure the eventId is current (changes each round)
- **Connection issues**: Check firewall settings for WebSocket connections
- **CORS errors**: Service has CORS enabled, check your frontend URL
