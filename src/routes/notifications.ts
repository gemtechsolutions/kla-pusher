/**
 * Notification fan-out endpoints.
 *
 *   GET  /sse/notifications?ticket=<...>             join per-role SSE rooms
 *   POST /api/internal/notifications/broadcast       service-to-service push
 *
 * The SSE endpoint requires a short-lived HMAC ticket minted by site-api
 * (see lib/sse-ticket.ts). The internal broadcast endpoint requires the
 * shared `X-Service-Token` header.
 */
import { Router } from 'express';
import { env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { NotificationRooms, NotificationPayload } from '../lib/notification-rooms.js';
import { TicketError, verifyTicket } from '../lib/sse-ticket.js';

export function createNotificationsRouter(opts: {
  rooms: NotificationRooms;
  log: Logger;
}): Router {
  const { rooms, log } = opts;
  const router = Router();

  router.get('/sse/notifications', (req, res) => {
    const ticket = String(req.query.ticket ?? '').trim();
    let payload;
    try {
      payload = verifyTicket(ticket, env.siteApiServiceToken);
    } catch (err) {
      const reason = err instanceof TicketError ? err.message : 'invalid ticket';
      res.status(401).json({ error: reason });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(
      `event: connected\ndata: ${JSON.stringify({
        userId: payload.userId,
        roles: payload.roles,
        ts: Date.now(),
      })}\n\n`,
    );

    rooms.join(payload.roles, res);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15_000);
    req.on('close', () => clearInterval(keepAlive));
  });

  router.post('/api/internal/notifications/broadcast', (req, res) => {
    if (!env.siteApiServiceToken) {
      res.status(401).json({ error: 'service token not configured' });
      return;
    }
    const supplied = req.header('X-Service-Token') ?? '';
    if (supplied !== env.siteApiServiceToken) {
      res.status(401).json({ error: 'invalid service token' });
      return;
    }

    const body = req.body as { notification?: NotificationPayload; targetRoles?: string[] };
    if (!body?.notification?.notificationId || !Array.isArray(body.targetRoles)) {
      res.status(400).json({ error: 'expected { notification, targetRoles }' });
      return;
    }

    const delivered = rooms.broadcast(body.notification, body.targetRoles);
    log.info('notification broadcast', {
      notificationId: body.notification.notificationId,
      targetRoles: body.targetRoles,
      delivered,
    });
    res.json({ delivered });
  });

  return router;
}
