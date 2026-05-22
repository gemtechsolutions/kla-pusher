/**
 * Stream registry. Pluggable source — currently:
 *
 *   - LocalJsonRegistry: reads ./data/streams.json (an array of StreamMeta).
 *     Useful for dev or when the site-api internal endpoint doesn't exist
 *     yet. The file is hot-reloaded on every poll.
 *
 *   - SiteApiRegistry: pulls from kla-site-api over HTTP using a service
 *     token. Requires GET /private/internal/streams to exist on site-api.
 *
 * The manager calls `list()` once on boot and then on a poll interval; it
 * diffs the returned set against its in-memory state and starts/stops
 * adapters accordingly.
 */
import { existsSync, readFileSync } from 'node:fs';
import { env } from '../env.js';
import type { Logger } from './logger.js';
import type { SiteApiClient } from './site-api-client.js';
import type { StreamMeta } from '../types.js';

export interface Registry {
  list(): Promise<StreamMeta[]>;
}

function filterActive(streams: StreamMeta[], gameIds: readonly string[]): StreamMeta[] {
  return streams.filter(
    (s) => s.status === 'ACTIVE' && (gameIds.length === 0 || gameIds.includes(s.gameId)),
  );
}

export class LocalJsonRegistry implements Registry {
  constructor(
    private readonly filePath: string,
    private readonly gameIds: readonly string[],
    private readonly log: Logger,
  ) {}

  async list(): Promise<StreamMeta[]> {
    if (!existsSync(this.filePath)) {
      this.log.warn('registry file missing; treating as empty', { filePath: this.filePath });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      this.log.warn('registry parse failed; treating as empty', {
        filePath: this.filePath,
        err: String(err),
      });
      return [];
    }
    if (!Array.isArray(parsed)) {
      this.log.warn('registry file is not an array', { filePath: this.filePath });
      return [];
    }
    return filterActive(parsed as StreamMeta[], this.gameIds);
  }
}

export class SiteApiRegistry implements Registry {
  constructor(
    private readonly client: SiteApiClient,
    private readonly gameIds: readonly string[],
  ) {}

  async list(): Promise<StreamMeta[]> {
    const streams = await this.client.listStreams(this.gameIds);
    return filterActive(streams, this.gameIds);
  }
}

export function createRegistry(opts: {
  log: Logger;
  siteApi: SiteApiClient;
}): Registry {
  const { log, siteApi } = opts;
  if (env.registrySource === 'site-api') {
    log.info('using SiteApiRegistry', { baseUrl: env.siteApiBaseUrl, gameIds: env.registryGameIds });
    return new SiteApiRegistry(siteApi, env.registryGameIds);
  }
  log.info('using LocalJsonRegistry', { file: env.streamsRegistryFile, gameIds: env.registryGameIds });
  return new LocalJsonRegistry(env.streamsRegistryFile, env.registryGameIds, log.child('registry:local'));
}
