/**
 * Per-stream staleness + game-end detection.
 *
 * Mirrors the v1 behavior: after a `declare-winner` we enter a grace period
 * where it's normal to see no events. If no fresh events arrive after the
 * grace period, emit a `stream-stale` so the frontend can recommend a switch.
 */
import type { CanonicalEvent } from '../types.js';

const STALE_THRESHOLD_MS = 60_000;
const GAME_END_GRACE_MS = 180_000;

export interface HealthSummary {
  lastEventTs: number;
  timeSinceLastEventMs: number;
  isStale: boolean;
  gameEndDetected: boolean;
  gameEndTs: number | null;
}

export class StreamHealth {
  private lastEventTs: number = Date.now();
  private gameEndTs: number | null = null;
  private staleAlertSent = false;

  /** Call whenever a real upstream event arrives. */
  noteEvent(type: CanonicalEvent['type']): void {
    this.lastEventTs = Date.now();
    // A new game's place-bet / event-status / etc. clears the prior grace state.
    if (this.gameEndTs && type !== 'declare-winner') {
      this.gameEndTs = null;
    }
    this.staleAlertSent = false;
  }

  noteDeclareWinner(): void {
    this.lastEventTs = Date.now();
    this.gameEndTs = Date.now();
    this.staleAlertSent = false;
  }

  /**
   * Called by the manager every tick. Returns an event to broadcast if the
   * health state crossed a threshold this tick; otherwise null.
   */
  tick(streamId: string): CanonicalEvent | null {
    const now = Date.now();
    const timeSinceLastEvent = now - this.lastEventTs;

    if (this.gameEndTs !== null) {
      const sinceGameEnd = now - this.gameEndTs;
      if (sinceGameEnd < GAME_END_GRACE_MS) return null;
      if (timeSinceLastEvent <= STALE_THRESHOLD_MS) return null;
      if (this.staleAlertSent) return null;
      this.staleAlertSent = true;
      return {
        type: 'stream-stale',
        streamId,
        data: {
          reason: 'grace-expired',
          timeSinceLastEventMs: timeSinceLastEvent,
          timeSinceGameEndMs: sinceGameEnd,
        },
        ts: now,
      };
    }

    if (timeSinceLastEvent > STALE_THRESHOLD_MS && !this.staleAlertSent) {
      this.staleAlertSent = true;
      return {
        type: 'stream-stale',
        streamId,
        data: { reason: 'no-events', timeSinceLastEventMs: timeSinceLastEvent },
        ts: now,
      };
    }

    return null;
  }

  summary(): HealthSummary {
    const now = Date.now();
    const timeSinceLastEventMs = now - this.lastEventTs;
    return {
      lastEventTs: this.lastEventTs,
      timeSinceLastEventMs,
      isStale: timeSinceLastEventMs > STALE_THRESHOLD_MS,
      gameEndDetected: this.gameEndTs !== null,
      gameEndTs: this.gameEndTs,
    };
  }
}
