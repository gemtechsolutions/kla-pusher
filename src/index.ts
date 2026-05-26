/**
 * Bootstrap. Wires env → libs → routes → Express, starts the manager, and
 * installs signal handlers for clean shutdown.
 */
import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { createLogger } from './lib/logger.js';
import { SseRooms } from './lib/sse.js';
import { createSiteApiClient } from './lib/site-api-client.js';
import { createRegistry } from './lib/registry.js';
import { StreamManager, dataRoot } from './lib/stream-manager.js';
import { createStreamsRouter } from './routes/streams.js';
import { createHealthRouter } from './routes/health.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { NotificationRooms } from './lib/notification-rooms.js';

async function main(): Promise<void> {
  const log = createLogger('kla-pusher');
  log.info('booting', { env: { ...env, siteApiServiceToken: env.siteApiServiceToken ? '<set>' : '' } });

  const siteApi = createSiteApiClient(log.child('site-api'));
  const registry = createRegistry({ log, siteApi });
  const sse = new SseRooms(log.child('sse'));
  const notificationRooms = new NotificationRooms(log.child('notif'));
  const manager = new StreamManager(
    registry,
    sse,
    siteApi,
    log.child('manager'),
    env.registryPollIntervalMs,
    dataRoot(),
  );

  await manager.start();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(createHealthRouter(manager));
  app.use(createStreamsRouter({ manager, sse, log: log.child('routes') }));
  app.use(createNotificationsRouter({ rooms: notificationRooms, log: log.child('notif-routes') }));

  const server = app.listen(env.port, () => {
    log.info('listening', { port: env.port });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutdown requested', { signal });
    server.close();
    await manager.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal boot error:', err);
  process.exit(1);
});
