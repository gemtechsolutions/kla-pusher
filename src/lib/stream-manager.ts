/**
 * Orchestrator. Owns the per-stream runtime state and reconciles it against
 * the registry on each poll tick.
 *
 * Responsibilities:
 *   - For each ACTIVE stream from the registry, instantiate the adapter,
 *     wire its `emit` to the SSE room and disk store, and call `start()`.
 *   - For streams removed from the registry, stop the adapter, close the
 *     SSE room, and drop in-memory state.
 *   - For streams whose `dataConfig` changed, restart the adapter.
 *   - Run a fast health tick that emits `stream-stale` when appropriate.
 *   - Forward `RoundFinalization` from adapters to site-api.
 *
 * Adapters never see SSE / disk / HTTP directly; they only call the
 * `AdapterReport` callbacks we hand them.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.js';
import type { Registry } from './registry.js';
import type { SiteApiClient } from './site-api-client.js';
import type { SseRooms } from './sse.js';
import type { StreamMeta, CanonicalEvent } from '../types.js';
import { StreamHealth } from './health.js';
import { StreamStore } from './store.js';
import { getAdapterFactory } from '../adapters/index.js';
import type { AdapterReport, DataAdapter } from '../adapters/index.js';

const HEALTH_TICK_MS = 30_000;

interface StreamRuntime {
  meta: StreamMeta;
  /** Hash of the (dataAdapter, dataConfig) we started the adapter with. */
  signature: string;
  adapter: DataAdapter;
  health: StreamHealth;
  store: StreamStore;
  /** In-memory mirror of disk latest.json for /api/streams/:id/latest. */
  latest: Record<string, CanonicalEvent>;
  /** Last N finalized results for /api/streams/:id/results. */
  results: unknown[];
}

function signatureOf(meta: StreamMeta): string {
  return createHash('sha256')
    .update(meta.dataAdapter + '\0' + JSON.stringify(meta.dataConfig ?? {}))
    .digest('hex');
}

export class StreamManager {
  private readonly streams = new Map<string, StreamRuntime>();
  private healthTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly dataRoot: string;

  constructor(
    private readonly registry: Registry,
    private readonly sse: SseRooms,
    private readonly siteApi: SiteApiClient,
    private readonly log: Logger,
    private readonly pollIntervalMs: number,
    dataRoot: string,
  ) {
    this.dataRoot = dataRoot;
    mkdirSync(this.dataRoot, { recursive: true });
  }

  /** Boot: do an initial reconcile and start the timers. */
  async start(): Promise<void> {
    await this.reconcile();
    this.pollTimer = setInterval(() => {
      this.reconcile().catch((err) => this.log.error('reconcile failed', { err: String(err) }));
    }, this.pollIntervalMs);
    this.healthTimer = setInterval(() => this.healthTick(), HEALTH_TICK_MS);
  }

  /** Graceful shutdown. Stops all adapters and clears timers. */
  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    const tasks: Array<Promise<void>> = [];
    for (const runtime of this.streams.values()) {
      tasks.push(Promise.resolve(runtime.adapter.stop()).then(() => undefined));
    }
    await Promise.allSettled(tasks);
    this.streams.clear();
  }

  /** Diagnostics: every active stream + its current health. */
  snapshot(): Array<{ meta: StreamMeta; health: ReturnType<StreamHealth['summary']>; latest: Record<string, CanonicalEvent>; resultsCount: number }> {
    return Array.from(this.streams.values()).map((r) => ({
      meta: r.meta,
      health: r.health.summary(),
      latest: r.latest,
      resultsCount: r.results.length,
    }));
  }

  getRuntime(streamId: string): StreamRuntime | undefined {
    return this.streams.get(streamId);
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  private async reconcile(): Promise<void> {
    const desired = await this.registry.list();
    const desiredById = new Map(desired.map((s) => [s.streamId, s]));

    // Stop streams no longer in the registry, or whose adapter/config changed.
    for (const [id, runtime] of this.streams) {
      const next = desiredById.get(id);
      if (!next) {
        await this.tearDown(id, 'removed-from-registry');
        continue;
      }
      const nextSig = signatureOf(next);
      if (nextSig !== runtime.signature) {
        await this.tearDown(id, 'config-changed');
      }
    }

    // Start streams that are newly active (or were just torn down).
    for (const meta of desired) {
      if (this.streams.has(meta.streamId)) continue;
      await this.spinUp(meta);
    }
  }

  private async spinUp(meta: StreamMeta): Promise<void> {
    const factory = getAdapterFactory(meta.dataAdapter);
    if (!factory) {
      this.log.warn('unknown dataAdapter; skipping stream', {
        streamId: meta.streamId,
        dataAdapter: meta.dataAdapter,
      });
      return;
    }

    const log = this.log.child(`stream:${meta.streamId}`);
    const store = new StreamStore(this.dataRoot, meta.streamId, log);
    const latest = store.loadLatest();
    const results = store.loadResults();
    const health = new StreamHealth();

    // Closure-captured runtime stub so the report callbacks can refer to it
    // before it's added to the map.
    const runtimeRef: { current: StreamRuntime | null } = { current: null };

    const report: AdapterReport = {
      emit: (event) => {
        const r = runtimeRef.current;
        if (!r) return;
        // Track latest payload per canonical type so we can serve a snapshot.
        r.latest[event.type] = event;
        r.store.saveLatest(r.latest);
        if (event.type === 'declare-winner') {
          r.health.noteDeclareWinner();
          r.results.unshift({
            streamId: event.streamId,
            ts: event.ts,
            data: event.data,
            upstreamRef: event.upstreamRef,
          });
          r.store.saveResults(r.results);
        } else {
          r.health.noteEvent(event.type);
        }
        this.sse.broadcast(event.streamId, event);
      },
      finalize: (round) => {
        // Fire-and-forget; failures are logged inside the client.
        void this.siteApi.finalizeGame3Round(round);
      },
    };

    let adapter: DataAdapter;
    try {
      adapter = factory.create(meta, report, log);
    } catch (err) {
      this.log.error('adapter factory threw; skipping stream', {
        streamId: meta.streamId,
        dataAdapter: meta.dataAdapter,
        err: String(err),
      });
      return;
    }

    const runtime: StreamRuntime = {
      meta,
      signature: signatureOf(meta),
      adapter,
      health,
      store,
      latest,
      results,
    };
    runtimeRef.current = runtime;
    this.streams.set(meta.streamId, runtime);

    try {
      await adapter.start();
      this.log.info('stream spun up', { streamId: meta.streamId, dataAdapter: meta.dataAdapter });
    } catch (err) {
      this.log.error('adapter start failed', { streamId: meta.streamId, err: String(err) });
      this.streams.delete(meta.streamId);
    }
  }

  private async tearDown(streamId: string, reason: string): Promise<void> {
    const runtime = this.streams.get(streamId);
    if (!runtime) return;
    this.streams.delete(streamId);
    try {
      await runtime.adapter.stop();
    } catch (err) {
      this.log.warn('adapter stop threw', { streamId, err: String(err) });
    }
    this.sse.closeRoom(streamId, reason);
    this.log.info('stream torn down', { streamId, reason });
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  private healthTick(): void {
    for (const runtime of this.streams.values()) {
      const event = runtime.health.tick(runtime.meta.streamId);
      if (event) this.sse.broadcast(runtime.meta.streamId, event);
    }
  }
}

export function dataRoot(): string {
  return join(process.cwd(), 'data');
}
