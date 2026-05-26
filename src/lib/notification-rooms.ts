/**
 * Per-role SSE rooms for the notifications channel.
 *
 * Mirrors {@link SseRooms} but keyed on role rather than streamId, and lets
 * one client join multiple roles at once (a super-admin sees notifications
 * targeted to both `admin` and `super-admin`).
 */
import type { Response } from 'express';
import type { Logger } from './logger.js';

export interface NotificationPayload {
  notificationId: string;
  title: string;
  body: string;
  link?: string | null;
  targetRoles: string[];
  createdAt: string;
  createdBy: string;
  createdByName?: string | null;
  expiresAt?: number | null;
}

interface Client {
  res: Response;
  roles: Set<string>;
}

export class NotificationRooms {
  private readonly rooms = new Map<string, Set<Client>>();

  constructor(private readonly log: Logger) {}

  join(roles: string[], res: Response): Client {
    const client: Client = { res, roles: new Set(roles) };
    for (const role of client.roles) {
      let room = this.rooms.get(role);
      if (!room) {
        room = new Set();
        this.rooms.set(role, room);
      }
      room.add(client);
    }
    this.log.info('notif client joined', { roles: [...client.roles], totals: this.snapshot() });
    res.on('close', () => this.leave(client));
    return client;
  }

  leave(client: Client): void {
    for (const role of client.roles) {
      const room = this.rooms.get(role);
      if (!room) continue;
      room.delete(client);
      if (room.size === 0) this.rooms.delete(role);
    }
    this.log.info('notif client left', { roles: [...client.roles], totals: this.snapshot() });
  }

  /**
   * Fan a notification out to every client whose roles intersect targetRoles.
   * De-duplicates so a client subscribed to both `admin` and `super-admin`
   * receives a notification targeted at both only once.
   */
  broadcast(notification: NotificationPayload, targetRoles: string[]): number {
    const seen = new Set<Client>();
    for (const role of targetRoles) {
      const room = this.rooms.get(role);
      if (!room) continue;
      for (const client of room) {
        if (seen.has(client)) continue;
        seen.add(client);
      }
    }
    if (seen.size === 0) return 0;
    const payload = `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;
    let delivered = 0;
    for (const client of seen) {
      try {
        client.res.write(payload);
        delivered++;
      } catch (err) {
        this.log.warn('notif write failed; dropping client', { err: String(err) });
        this.leave(client);
      }
    }
    return delivered;
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [role, room] of this.rooms) out[role] = room.size;
    return out;
  }
}
