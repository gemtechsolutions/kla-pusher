import { Router } from 'express';
import type { StreamManager } from '../lib/stream-manager.js';

export function createHealthRouter(manager: StreamManager): Router {
  const router = Router();

  router.get('/_health', (_req, res) => {
    res.json({
      status: 'ok',
      streams: manager.snapshot().length,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  return router;
}
