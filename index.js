// Pusher/Laravel Echo listener service - Version 2
// Connects using Pusher protocol to match Laravel Echo

const { Pusher } = require('pusher-js');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Persistence file paths
const DATA_DIR = path.join(__dirname, 'data');
const BETTING_DATA_FILE = path.join(DATA_DIR, 'latest-betting-data.json');
const RESULTS_FILE = path.join(DATA_DIR, 'game-results.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load persisted data
let latestBettingData = {};
let gameResults = [];

try {
  if (fs.existsSync(BETTING_DATA_FILE)) {
    latestBettingData = JSON.parse(fs.readFileSync(BETTING_DATA_FILE, 'utf8'));
    console.log('📂 Loaded persisted betting data');
  }
  if (fs.existsSync(RESULTS_FILE)) {
    gameResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    console.log(`📂 Loaded ${gameResults.length} persisted results`);
  }
} catch (err) {
  console.error('Failed to load persisted data:', err);
}

const clients = new Set();
let currentEventId = null;
let subscribedChannels = {};
let lastEventTimestamp = Date.now();
let gameEndDetected = false;
let gameEndTime = null; // Track when game ended for grace period

console.log('🚀 Starting Pusher Listener Service (v2)...');

// Connect to Pusher using custom WebSocket host
const pusher = new Pusher('shifenkey123', {
  wsHost: 'ws.web-services.live',
  wsPort: 6001,
  wssPort: 6001,
  forceTLS: true,
  encrypted: true,
  disableStats: true,
  enabledTransports: ['ws', 'wss'],
  cluster: 'ap1'
});

pusher.connection.bind('connected', () => {
  console.log('✅ Connected to Pusher WebSocket server');
});

pusher.connection.bind('disconnected', () => {
  console.log('❌ Disconnected from Pusher');
});

pusher.connection.bind('error', (err) => {
  console.error('❌ Pusher connection error:', err);
});

// Function to subscribe to channels for a specific event
function subscribeToEvent(eventId) {
  if (currentEventId === eventId) {
    console.log(`Already subscribed to event: ${eventId}`);
    return;
  }

  console.log(`📺 Subscribing to event: ${eventId}`);
  currentEventId = eventId;

  const channelNames = [
    `betting-status-${eventId}`,
    `place-bet-${eventId}`,
    `event-status-${eventId}`,
    `declare-winner-${eventId}`,
    `send-notification-${eventId}`,
    `jump-number-${eventId}`,
    `refresh-all-${eventId}`,
    `change-team-${eventId}`
  ];

  channelNames.forEach(channelName => {
    console.log(`   Subscribing to: ${channelName}`);

    const channel = pusher.subscribe(channelName);

    channel.bind('pusher:subscription_succeeded', () => {
      console.log(`   ✓ Subscribed to ${channelName}`);
    });

    channel.bind('pusher:subscription_error', (err) => {
      console.error(`   ✗ Failed to subscribe to ${channelName}:`, err);
    });

    // Listen for ALL events on this channel
    channel.bind_global((eventName, data) => {
      console.log(`📨 [${channelName}] Event: ${eventName}`, data);

      const payload = {
        channel: channelName,
        event: eventName,
        data: data,
        timestamp: Date.now(),
        eventId: eventId
      };

      // Update last event timestamp
      lastEventTimestamp = Date.now();

      // Reset game end detection when we receive any event (new game started)
      if (gameEndDetected && eventName !== 'App\\Events\\DeclareWinner') {
        console.log('✅ New game activity detected - resetting grace period');
        gameEndDetected = false;
        gameEndTime = null;
      }

      // Store latest data
      latestBettingData[`${channelName}:${eventName}`] = payload;

      // Persist betting data to disk
      fs.writeFileSync(BETTING_DATA_FILE, JSON.stringify(latestBettingData, null, 2));

      // Detect game end and notify frontend to prepare for stream switch
      if (eventName === 'App\\Events\\DeclareWinner') {
        console.log('🏁 Game ended - starting 3-minute grace period before stream switch');
        gameEndDetected = true;
        gameEndTime = Date.now();

        // Broadcast game-end event to frontend
        broadcastToClients({
          type: 'game-ended',
          eventId: eventId,
          timestamp: Date.now(),
          message: 'Current game has ended, waiting for next game to start'
        });
      }

      // Detect betting closed
      if (eventName === 'App\\Events\\Bet' && data.status === 'CLOSED') {
        console.log('🔒 Betting closed for this round');
      }

      // Store game results when winner is declared
      if (eventName === 'App\\Events\\DeclareWinner') {
        const result = {
          roundId: eventId,
          eventId: eventId,
          winner: data.winner?.toLowerCase() || 'unknown',
          timestamp: Date.now() / 1000,
          finalMeron: data.finalMeron,
          finalWala: data.finalWala,
          finalDraw: data.finalDraw,
        };

        // Add to results array (keep last 50)
        gameResults.unshift(result);
        if (gameResults.length > 50) {
          gameResults = gameResults.slice(0, 50);
        }

        // Persist results to disk
        fs.writeFileSync(RESULTS_FILE, JSON.stringify(gameResults, null, 2));

        console.log('🏆 Winner stored:', result);
      }

      // Broadcast to SSE clients
      broadcastToClients(payload);
    });

    subscribedChannels[channelName] = channel;
  });
}

// Broadcast to all SSE clients
function broadcastToClients(message) {
  const payload = JSON.stringify(message);
  console.log(`📡 Broadcasting to ${clients.size} clients:`, message.event);

  if (clients.size === 0) {
    console.warn('⚠️ No SSE clients connected to receive broadcast');
  }

  clients.forEach(client => {
    try {
      client.write(`data: ${payload}\n\n`);
      console.log('✅ Sent to client successfully');
    } catch (err) {
      console.error('Error broadcasting to client:', err);
      clients.delete(client);
    }
  });
}

// REST API endpoints

// Get current event ID
app.get('/api/event/current', (req, res) => {
  res.json({
    eventId: currentEventId,
    subscribedChannels: Object.keys(subscribedChannels)
  });
});

// Set event ID to subscribe to
app.post('/api/event/subscribe', (req, res) => {
  const { eventId } = req.body;
  if (!eventId) {
    return res.status(400).json({ error: 'eventId required' });
  }

  subscribeToEvent(eventId);
  res.json({ success: true, eventId, channels: Object.keys(subscribedChannels) });
});

// Get latest betting data for all channels
app.get('/api/betting-data/latest', (req, res) => {
  res.json(latestBettingData);
});

// Server-Sent Events endpoint for real-time updates (must be BEFORE :channel route)
app.get('/api/betting-data/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial data
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    currentEventId,
    channels: Object.keys(subscribedChannels),
    pusherState: pusher.connection.state
  })}\n\n`);

  // Add client to set
  clients.add(res);
  console.log(`👤 SSE Client connected. Total clients: ${clients.size}`);

  // Remove client on disconnect
  req.on('close', () => {
    clients.delete(res);
    console.log(`👤 SSE Client disconnected. Total clients: ${clients.size}`);
  });
});

// Get latest data for specific channel
app.get('/api/betting-data/:channel', (req, res) => {
  const { channel } = req.params;
  const matchingKeys = Object.keys(latestBettingData).filter(k => k.startsWith(channel));

  if (matchingKeys.length === 0) {
    return res.status(404).json({ error: 'No data for this channel' });
  }

  const data = {};
  matchingKeys.forEach(key => {
    data[key] = latestBettingData[key];
  });

  res.json(data);
});

// Get game results history
app.get('/api/results', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(gameResults.slice(0, limit));
});

// Get results for today
app.get('/api/results/today', (req, res) => {
  const today = new Date().setHours(0, 0, 0, 0) / 1000;
  const todayResults = gameResults.filter(r => r.timestamp >= today);
  res.json(todayResults);
});

// Get stream health status
app.get('/api/stream/health', (req, res) => {
  const timeSinceLastEvent = Date.now() - lastEventTimestamp;
  const isStale = timeSinceLastEvent > 60000; // 60 seconds

  res.json({
    currentEventId,
    lastEventTimestamp,
    timeSinceLastEvent,
    isStale,
    gameEndDetected,
    subscribedChannels: Object.keys(subscribedChannels),
    recommendation: isStale ? 'switch-stream' : 'continue',
    message: isStale
      ? 'No events received for 60+ seconds - consider switching streams'
      : 'Stream is healthy'
  });
});

// Monitor for stale data and broadcast alerts
setInterval(() => {
  const timeSinceLastEvent = Date.now() - lastEventTimestamp;
  const GRACE_PERIOD = 180000; // 3 minutes (180 seconds)
  const STALE_THRESHOLD = 60000; // 60 seconds

  // If game ended, check if we're past the grace period
  if (gameEndDetected && gameEndTime) {
    const timeSinceGameEnd = Date.now() - gameEndTime;

    if (timeSinceGameEnd < GRACE_PERIOD) {
      // Still within grace period - don't trigger switch
      console.log(`⏳ Grace period: ${Math.round((GRACE_PERIOD - timeSinceGameEnd) / 1000)}s remaining until stream switch check`);
      return;
    }

    // Grace period expired, now check if data is still stale
    if (timeSinceLastEvent > STALE_THRESHOLD) {
      console.warn(`⚠️ Grace period expired and no events for ${Math.round(timeSinceLastEvent / 1000)}s - triggering stream switch`);

      // Broadcast stale stream warning
      broadcastToClients({
        type: 'stream-stale',
        eventId: currentEventId,
        timeSinceLastEvent,
        timeSinceGameEnd,
        timestamp: Date.now(),
        message: 'Game ended and no new game started - stream may have switched'
      });

      gameEndDetected = true; // Prevent repeated warnings
    }
  } else if (!gameEndDetected && timeSinceLastEvent > STALE_THRESHOLD) {
    // No recent game end, but data is stale - unusual situation
    console.warn(`⚠️ No events for ${Math.round(timeSinceLastEvent / 1000)}s - stream may be inactive`);

    broadcastToClients({
      type: 'stream-stale',
      eventId: currentEventId,
      timeSinceLastEvent,
      timestamp: Date.now(),
      message: 'No betting data received - stream may have issues'
    });

    gameEndDetected = true; // Set flag to prevent repeated warnings
  }
}, 30000); // Check every 30 seconds

// Test endpoint: Trigger a fake winner event
app.post('/api/test/winner', (req, res) => {
  const { winner = 'meron', finalMeron = '150000.00', finalWala = '200000.00', finalDraw = '0.00' } = req.body;

  const testEvent = {
    channel: `declare-winner-${currentEventId}`,
    event: 'App\\Events\\DeclareWinner',
    data: {
      declareData: {
        result: winner.toUpperCase(),
        finalMeron,
        finalWala,
        finalDraw,
      },
      eventId: currentEventId,
    },
    timestamp: Date.now(),
    eventId: currentEventId,
  };

  console.log('🧪 Test winner event triggered:', winner);
  broadcastToClients(testEvent);

  res.json({ success: true, event: testEvent });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎮 Pusher Listener Service running on port ${PORT}`);
  console.log(`📡 WebSocket: wss://ws.web-services.live:6001`);
  console.log(`🔑 App Key: shifenkey123`);
  console.log(`\n📝 API Endpoints:`);
  console.log(`   GET  http://localhost:${PORT}/api/event/current`);
  console.log(`   POST http://localhost:${PORT}/api/event/subscribe`);
  console.log(`   GET  http://localhost:${PORT}/api/betting-data/latest`);
  console.log(`   GET  http://localhost:${PORT}/api/betting-data/stream (SSE)`);
  console.log(`\n💡 To subscribe to an event, POST to /api/event/subscribe with { "eventId": "69c3877f7f569" }`);
  console.log(`\nWaiting for connection...`);
});
