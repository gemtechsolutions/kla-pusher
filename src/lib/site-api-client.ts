/**
 * HTTP client for kla-site-api. Used for:
 *   - listStreams: stream registry sync (when REGISTRY_SOURCE=site-api).
 *   - finalizeGame3Round: POST canonical declare-winner payload to persist
 *     results in DynamoDB.
 *
 * The site-api service-token endpoint isn't built yet — these methods log and
 * fail gracefully so the service stays runnable until it lands.
 */
import { env } from '../env.js';
import type { Logger } from './logger.js';
import type { RoundFinalization, StreamMeta } from '../types.js';

export class SiteApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly log: Logger,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.serviceToken) h['X-Service-Token'] = this.serviceToken;
    return h;
  }

  /**
   * Fetch the streams registry from site-api. Used by `SiteApiRegistry`.
   *
   * Expects: GET /api/internal/streams?gameId=...
   * Auth: `X-Service-Token` header (set in `headers()`). The endpoint sits
   * under /api/internal (not /api/private/internal) because API Gateway
   * applies Cognito to /api/private/*; /api/internal bypasses that and
   * relies on site-api's own X-Service-Token middleware.
   */
  async listStreams(gameIds: readonly string[]): Promise<StreamMeta[]> {
    const out: StreamMeta[] = [];
    for (const gameId of gameIds) {
      const url = `${this.baseUrl}/api/internal/streams?gameId=${encodeURIComponent(gameId)}`;
      try {
        const resp = await fetch(url, { headers: this.headers() });
        if (!resp.ok) {
          this.log.warn('listStreams non-ok', { gameId, status: resp.status });
          continue;
        }
        const body = (await resp.json()) as StreamMeta[];
        out.push(...body);
      } catch (err) {
        this.log.warn('listStreams failed', { gameId, err: String(err) });
      }
    }
    return out;
  }

  /**
   * POST a finalized round to site-api so it persists in game_rounds.
   *
   * Retried up to 3 times with exponential backoff (250ms, 750ms, 2250ms).
   * Site-api finalize is idempotent (keyed on streamId+upstreamEventId), so
   * retrying after partial success is safe — the second call just reflects
   * the existing row.
   *
   * Expects: POST /api/internal/game-3/rounds/finalize
   */
  async finalizeGame3Round(payload: RoundFinalization, maxAttempts: number = 3): Promise<boolean> {
    const url = `${this.baseUrl}/api/internal/game-3/rounds/finalize`;
    let backoffMs = 250;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
        });
        if (resp.ok) {
          if (attempt > 1) {
            this.log.info('finalize succeeded after retry', { attempt, streamId: payload.streamId });
          }
          return true;
        }
        // 4xx is permanent; don't retry. 5xx + 429 are transient.
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          this.log.warn('finalize non-retriable', {
            status: resp.status,
            streamId: payload.streamId,
            attempt,
          });
          return false;
        }
        this.log.warn('finalize transient failure', {
          status: resp.status,
          streamId: payload.streamId,
          attempt,
        });
      } catch (err) {
        this.log.warn('finalize threw', {
          streamId: payload.streamId,
          attempt,
          err: String(err),
        });
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs *= 3;
      }
    }
    this.log.error('finalize gave up after retries', {
      streamId: payload.streamId,
      attempts: maxAttempts,
    });
    return false;
  }
}

export function createSiteApiClient(log: Logger): SiteApiClient {
  return new SiteApiClient(env.siteApiBaseUrl, env.siteApiServiceToken, log);
}
