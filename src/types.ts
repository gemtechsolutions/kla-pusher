/**
 * Core domain types for kla-pusher v2.
 *
 * The service translates many upstream betting-event protocols into a single
 * canonical event vocabulary that SSE clients consume. New providers add
 * adapters; the vocabulary and HTTP surface do not change.
 */

// ---------------------------------------------------------------------------
// Stream registry
// ---------------------------------------------------------------------------

export type StreamStatus = 'ACTIVE' | 'INACTIVE';

/**
 * Stream record as kla-pusher sees it. Mirrors the site-api `Stream` model
 * (minus the video-side fields, which we don't need here).
 */
export interface StreamMeta {
  streamId: string;
  name: string;
  gameId: string;
  dataAdapter: string;
  dataConfig: Record<string, unknown>;
  status: StreamStatus;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Canonical event vocabulary
// ---------------------------------------------------------------------------

/**
 * The set of event types SSE clients can receive. Adapters translate their
 * upstream events into these. Core (stream-manager / health) emits the
 * `stream-*` and `game-ended` types.
 */
export type CanonicalEventType =
  | 'betting-status'
  | 'place-bet'
  | 'event-status'
  | 'declare-winner'
  | 'send-notification'
  | 'jump-number'
  | 'refresh-all'
  | 'change-team'
  | 'game-ended'
  | 'stream-stale'
  | 'stream-removed';

export interface CanonicalEvent {
  type: CanonicalEventType;
  streamId: string;
  /** Adapter-emitted payload; shape depends on `type`. */
  data: unknown;
  /** Unix milliseconds. */
  ts: number;
  /** Optional upstream identifier for forensics (eventId, etc.). */
  upstreamRef?: string;
}

/**
 * Payload shape kla-pusher derives for `declare-winner` and forwards to the
 * site-api finalize endpoint. Adapters set the fields they can fill in.
 */
export interface RoundFinalization {
  streamId: string;
  upstreamEventId: string;
  winner: string;
  declaredAt: number; // unix seconds
  raw: unknown;
}
