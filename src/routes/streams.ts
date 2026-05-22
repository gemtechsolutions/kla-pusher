/**
 * HTTP routes for streams: SSE rooms + diagnostic reads.
 *
 *   GET  /sse?streamId=foo                 join the SSE room for `foo`
 *   GET  /api/streams                      list currently-tracked stream ids
 *   GET  /api/streams/:streamId/latest     latest payload per canonical type
 *   GET  /api/streams/:streamId/results    last N finalized results
 *   GET  /api/streams/:streamId/health     stale/game-end summary
 *   GET  /api/adapters                     installed data adapter ids
 *
 * No legacy paths (/api/event/subscribe, /api/betting-data/...) — those are
 * gone in v2. Frontend's useBettingData must be updated to call /sse here.
 */
import { Router } from 'express';
import type { StreamManager } from '../lib/stream-manager.js';
import type { SseRooms } from '../lib/sse.js';
import type { Logger } from '../lib/logger.js';
import { listAdapterIds } from '../adapters/index.js';

export function createStreamsRouter(opts: {
  manager: StreamManager;
  sse: SseRooms;
  log: Logger;
}): Router {
  const { manager, sse, log } = opts;
  const router = Router();

  router.get('/sse', (req, res) => {
    const streamId = String(req.query.streamId ?? '').trim();
    if (!streamId) {
      res.status(400).json({ error: "query parameter 'streamId' is required" });
      return;
    }
    const runtime = manager.getRuntime(streamId);
    if (!runtime) {
      res.status(404).json({ error: `stream '${streamId}' is not active` });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Initial handshake event with the room snapshot.
    res.write(
      `data: ${JSON.stringify({
        type: 'connected',
        streamId,
        ts: Date.now(),
        data: {
          name: runtime.meta.name,
          dataAdapter: runtime.meta.dataAdapter,
          health: runtime.health.summary(),
          latestTypes: Object.keys(runtime.latest),
        },
      })}\n\n`,
    );

    sse.join(streamId, res);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
    });

    log.debug('sse client attached', { streamId });
  });

  router.get('/api/streams', (_req, res) => {
    res.json(
      manager.snapshot().map((s) => ({
        streamId: s.meta.streamId,
        name: s.meta.name,
        gameId: s.meta.gameId,
        dataAdapter: s.meta.dataAdapter,
        sortOrder: s.meta.sortOrder,
        isStale: s.health.isStale,
        resultsCount: s.resultsCount,
        clients: sse.snapshot()[s.meta.streamId] ?? 0,
      })),
    );
  });

  router.get('/api/streams/:streamId/latest', (req, res) => {
    const runtime = manager.getRuntime(req.params.streamId);
    if (!runtime) {
      res.status(404).json({ error: 'stream not active' });
      return;
    }
    res.json(runtime.latest);
  });

  router.get('/api/streams/:streamId/results', (req, res) => {
    const runtime = manager.getRuntime(req.params.streamId);
    if (!runtime) {
      res.status(404).json({ error: 'stream not active' });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    res.json(runtime.results.slice(0, limit));
  });

  router.get('/api/streams/:streamId/health', (req, res) => {
    const runtime = manager.getRuntime(req.params.streamId);
    if (!runtime) {
      res.status(404).json({ error: 'stream not active' });
      return;
    }
    res.json(runtime.health.summary());
  });

  /**
   * Upstream-provided history snapshot. bc24's INITIALIZE frame ships the
   * last ~60 finalized fights for the channel — used to backfill the chicken
   * ResultsGrid on stream load so the user doesn't wait minutes for live
   * RESULTs to accumulate. Adapters whose upstream doesn't supply history
   * (ds88, pusher-laravel) respond 400 — caller should treat as "no backfill
   * available" and rely on the live SSE feed only.
   */
  router.get('/api/streams/:streamId/upstream-results', (req, res) => {
    const runtime = manager.getRuntime(req.params.streamId);
    if (!runtime) {
      res.status(404).json({ error: 'stream not active' });
      return;
    }
    const fn = runtime.adapter.getUpstreamResults;
    if (typeof fn !== 'function') {
      res.status(400).json({
        error: `adapter '${runtime.meta.dataAdapter}' does not provide upstream results`,
      });
      return;
    }
    try {
      const results = fn.call(runtime.adapter);
      res.json({ results: Array.isArray(results) ? results : [] });
    } catch (err) {
      log.error('upstream-results fetch failed', { streamId: req.params.streamId, err: String(err) });
      res.status(500).json({ error: 'upstream-results fetch failed' });
    }
  });

  /**
   * Fresh-token iframe URL for streams whose adapter mints them (bc24/cc.realtimevideo.cc).
   *
   * The frontend calls this right before mounting the <iframe> so the
   * embedded URL has a play-token with enough TTL remaining to complete
   * the upstream's WebRTC /verify handshake. The adapter refreshes its
   * cached URL on demand if the current token is too close to expiry.
   *
   * Adapters that don't implement getLiveUrl (ds88, pusher-laravel)
   * respond 400 — caller should fall back to the static `iframeUrl` from
   * the public stream payload.
   */
  router.get('/api/streams/:streamId/live-url', async (req, res) => {
    const runtime = manager.getRuntime(req.params.streamId);
    if (!runtime) {
      res.status(404).json({ error: 'stream not active' });
      return;
    }
    const fn = runtime.adapter.getLiveUrl;
    if (typeof fn !== 'function') {
      res.status(400).json({
        error: `adapter '${runtime.meta.dataAdapter}' does not provide a live URL`,
      });
      return;
    }
    try {
      const url = await fn.call(runtime.adapter);
      if (!url) {
        res.status(503).json({ error: 'live URL not yet available; retry shortly' });
        return;
      }
      res.json({ liveUrl: url });
    } catch (err) {
      log.error('live-url fetch failed', { streamId: req.params.streamId, err: String(err) });
      res.status(500).json({ error: 'live URL fetch failed' });
    }
  });

  router.get('/api/adapters', (_req, res) => {
    res.json({ data: listAdapterIds() });
  });

  return router;
}
