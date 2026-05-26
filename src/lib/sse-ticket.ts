/**
 * Short-lived HMAC tickets that authenticate SSE connections.
 *
 * Browsers' EventSource API can't set Authorization headers, so we accept an
 * opaque ticket as a query param instead. site-api mints the ticket from the
 * caller's Cognito session and signs it with the shared service token; this
 * module verifies that signature.
 *
 * Format: ``<base64url(payload)>.<base64url(hmacSha256(secret, payload))>``
 * Payload: ``{ "userId": string, "roles": string[], "exp": number (unix sec) }``
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TicketPayload {
  userId: string;
  roles: string[];
  exp: number;
}

export class TicketError extends Error {}

function b64urlDecode(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function verifyTicket(raw: string, secret: string): TicketPayload {
  if (!secret) throw new TicketError('ticket verification not configured');
  if (!raw || typeof raw !== 'string') throw new TicketError('ticket missing');

  const parts = raw.split('.');
  if (parts.length !== 2) throw new TicketError('malformed ticket');
  const [encodedPayload, encodedSig] = parts;

  const expected = createHmac('sha256', secret).update(encodedPayload).digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(encodedSig);
  } catch {
    throw new TicketError('malformed ticket signature');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new TicketError('invalid ticket signature');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(encodedPayload).toString('utf-8'));
  } catch {
    throw new TicketError('malformed ticket payload');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as TicketPayload).userId !== 'string' ||
    !Array.isArray((parsed as TicketPayload).roles) ||
    typeof (parsed as TicketPayload).exp !== 'number'
  ) {
    throw new TicketError('invalid ticket payload');
  }
  const payload = parsed as TicketPayload;
  if (payload.exp * 1000 < Date.now()) {
    throw new TicketError('ticket expired');
  }
  return payload;
}
