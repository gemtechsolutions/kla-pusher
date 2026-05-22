# kla-pusher (v2)

Multi-stream betting-event fan-out. Subscribes to N upstream data sources via pluggable adapters, broadcasts a canonical event vocabulary over per-stream SSE rooms.

See [`docs/stream-pipeline-redesign.md`](../kla-site-api/docs/stream-pipeline-redesign.md) for the wider design.

## What changed from v1

| | v1 (legacy, removed) | v2 |
|---|---|---|
| Language | JS | TypeScript |
| Layout | one `index.js` | `src/` modules (lib, adapters, routes) |
| Subscriptions | one global `eventId` | one per `ACTIVE` stream in the registry |
| SSE | one global stream | per-stream rooms keyed by `streamId` |
| Event names | raw `App\\Events\\PlaceBet` | canonical `place-bet`, `declare-winner`, etc. |
| Result persistence | local JSON only | local JSON + POST to site-api finalize endpoint |
| Stream source | hardcoded env vars | pluggable Registry (local JSON file or site-api) |

## Architecture

```
            ┌──────────────────────┐
            │  Registry            │  ← local JSON file (dev) or site-api (prod)
            └──────────┬───────────┘
                       │ list() every 30s
                       ▼
        ┌─────────────────────────────┐
        │  StreamManager              │  reconciles registry → adapters
        │   Map<streamId, runtime>    │
        └──┬──────────┬──────────┬────┘
           │          │          │
           ▼          ▼          ▼
   Adapter A    Adapter B    Adapter C        ← one per active stream
   (pusher-     (...)        (...)              each holds its own
    laravel)                                    upstream connection
        \         │          /
         \        │         /        emit(canonical) + finalize()
          ▼       ▼        ▼
        ┌─────────────────────┐
        │  SseRooms           │     fan-out to per-stream SSE clients
        │  Map<streamId, Set> │
        └─────────────────────┘
```

Adapters never touch SSE, disk, or HTTP — only the `AdapterReport` callbacks the manager hands them.

## Canonical event vocabulary

SSE clients always receive `{ type, streamId, data, ts, upstreamRef? }`:

| Type | Source |
|---|---|
| `place-bet`, `betting-status`, `event-status`, `declare-winner`, `send-notification`, `jump-number`, `refresh-all`, `change-team` | Adapter, translated from upstream |
| `game-ended` | Adapter derives from `declare-winner` |
| `stream-stale` | Manager's `StreamHealth` after grace expires |
| `stream-removed` | Manager when registry no longer includes the stream |

## Endpoints

```
GET  /_health                          {status, streams, uptimeSec}
GET  /sse?streamId=foo                 SSE room for one stream
GET  /api/streams                      list active streams + client counts
GET  /api/streams/:id/latest           latest payload per canonical type
GET  /api/streams/:id/results          last N finalized results (?limit=N)
GET  /api/streams/:id/health           per-stream stale/game-end summary
GET  /api/adapters                     installed data adapter ids
```

None of v1's legacy endpoints (`/api/event/subscribe`, `/api/betting-data/stream`, `/api/betting-data/latest`, `/api/results`, `/api/stream/health`, `/api/test/winner`) are kept. The frontend `useBettingData` hook must be updated to call `/sse?streamId=...`.

## Configuration

`.env`:

```
PORT=3001
REGISTRY_SOURCE=local              # "local" or "site-api"
STREAMS_REGISTRY_FILE=./data/streams.json
SITE_API_BASE_URL=http://localhost:4000
SITE_API_SERVICE_TOKEN=
REGISTRY_GAME_IDS=game-3
REGISTRY_POLL_INTERVAL_MS=30000
```

### Local registry shape

`data/streams.json` is an array of `StreamMeta` objects:

```json
[
  {
    "streamId": "sputnikview-acf",
    "name": "Sputnikview ACF",
    "gameId": "game-3",
    "dataAdapter": "pusher-laravel",
    "dataConfig": {
      "socketHost": "wss://ws.web-services.live:6001",
      "appKey": "shifenkey123",
      "eventId": "69c408bc63c83"
    },
    "status": "ACTIVE",
    "sortOrder": 10
  }
]
```

Hot-reloaded on every registry tick (default 30s).

### Site-api registry

Set `REGISTRY_SOURCE=site-api`. Requires `GET /private/internal/streams?gameId=...` to exist on kla-site-api with `X-Service-Token` auth — **not built yet**. Until it lands, stay on `local`.

## Adding a new data provider

1. Implement `DataAdapterFactory` in `src/adapters/<name>.ts`. Translate upstream events into the canonical vocabulary. Never call SSE / disk directly — use the `report` callbacks.
2. Register the factory in `src/adapters/index.ts`.
3. Set a stream's `dataAdapter` to your new id in the admin UI.

No core/HTTP/SSE changes needed.

## Run

```
yarn install
yarn dev           # tsx watch
# or
yarn build && yarn start
```

Health:

```
make health
```
