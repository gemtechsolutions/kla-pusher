/**
 * Server-Sent Events room manager.
 *
 * Each `streamId` has its own room. Clients join via `GET /sse?streamId=foo`;
 * a client only sees events for the stream it joined. The stream-manager
 * calls `broadcast(streamId, event)` to fan out a canonical event to every
 * client in that room.
 */
import type { Response } from 'express';
import type { CanonicalEvent } from '../types.js';
import type { Logger } from './logger.js';

export class SseRooms {
  private readonly rooms = new Map<string, Set<Response>>();

  constructor(private readonly log: Logger) {}

  join(streamId: string, res: Response): void {
    let room = this.rooms.get(streamId);
    if (!room) {
      room = new Set();
      this.rooms.set(streamId, room);
    }
    room.add(res);
    this.log.info('sse client joined', { streamId, roomSize: room.size });

    res.on('close', () => this.leave(streamId, res));
  }

  leave(streamId: string, res: Response): void {
    const room = this.rooms.get(streamId);
    if (!room) return;
    room.delete(res);
    this.log.info('sse client left', { streamId, roomSize: room.size });
    if (room.size === 0) this.rooms.delete(streamId);
  }

  /**
   * Send a canonical event to everyone in a room. Silently drops clients
   * whose sockets have failed.
   */
  broadcast(streamId: string, event: CanonicalEvent): void {
    const room = this.rooms.get(streamId);
    if (!room || room.size === 0) return;

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of room) {
      try {
        res.write(payload);
      } catch (err) {
        this.log.warn('sse write failed; dropping client', { streamId, err: String(err) });
        room.delete(res);
      }
    }
  }

  /**
   * Tear down a room when its stream is removed from the registry. Sends a
   * final `stream-removed` event to give clients a chance to switch.
   */
  closeRoom(streamId: string, reason: string): void {
    const room = this.rooms.get(streamId);
    if (!room) return;

    const farewell: CanonicalEvent = {
      type: 'stream-removed',
      streamId,
      data: { reason },
      ts: Date.now(),
    };
    const payload = `data: ${JSON.stringify(farewell)}\n\n`;
    for (const res of room) {
      try {
        res.write(payload);
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.rooms.delete(streamId);
    this.log.info('sse room closed', { streamId, reason });
  }

  /**
   * Diagnostics: how many clients are in each room.
   */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, room] of this.rooms) out[id] = room.size;
    return out;
  }
}
