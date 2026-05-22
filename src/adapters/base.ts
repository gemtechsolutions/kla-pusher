/**
 * DataAdapter interface — what every data-plane provider implementation
 * exposes to the core. Each adapter is responsible for:
 *
 *   1. Opening / closing the upstream connection (WebSocket, polling, etc).
 *   2. Translating upstream event names + payloads into the canonical
 *      vocabulary (see types.ts).
 *   3. Calling `emit(canonical)` for every translated event.
 *   4. Reporting a `RoundFinalization` payload via the manager when a winner
 *      is declared (the manager then forwards to site-api).
 *
 * Adapters MUST NOT touch SSE, disk, HTTP, or the registry. They get only
 * config + a `report` callback.
 */
import type { CanonicalEvent, RoundFinalization, StreamMeta } from '../types.js';
import type { Logger } from '../lib/logger.js';

export interface AdapterReport {
  /** Emit a canonical event for this stream's SSE room. */
  emit(event: CanonicalEvent): void;
  /** Hand a finalized round to the manager (forwarded to site-api). */
  finalize(round: RoundFinalization): void;
}

export interface DataAdapterFactory {
  /** Identifier matching the stream record's `dataAdapter` field. */
  readonly id: string;
  create(stream: StreamMeta, report: AdapterReport, log: Logger): DataAdapter;
}

export interface DataAdapter {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  /**
   * Optional: return the upstream-provided iframe URL with a fresh play-token.
   *
   * Only adapters whose stream is served via a short-lived token-gated iframe
   * (e.g. bc24/cc.realtimevideo.cc — 60-second WebRTC play tokens) implement
   * this. If the adapter's cached URL has too little TTL remaining, it should
   * refresh on demand before returning. Returns null when no URL is known
   * yet (cold start, upstream not connected, etc.). Adapters without iframe
   * semantics simply omit this method.
   */
  getLiveUrl?(): Promise<string | null>;
  /**
   * Optional: snapshot of recent finalized fights provided by the upstream.
   * bc24 ships ~60 historical results in its INITIALIZE frame, perfect for
   * backfilling the chicken ResultsGrid on stream load. Adapters whose
   * upstream doesn't supply a history feed simply omit this method.
   *
   * Returns shape is intentionally `unknown[]` — each adapter formats its
   * own row and the consuming endpoint passes the payload through verbatim,
   * letting the frontend decide what to render.
   */
  getUpstreamResults?(): unknown[];
}
