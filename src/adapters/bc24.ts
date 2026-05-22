/**
 * `bc24` adapter — for the bc24.me / api.bc24.me / cc.realtimevideo.cc stack
 * (white-labelled as "SB24"). One shared bc24 viewer account is logged in
 * once on startup; the resulting `p_token` JWT authenticates the Socket.IO
 * connection. The adapter then filters the firehose to a single configured
 * `channelId` and translates bc24's events into our canonical vocabulary.
 *
 * Capture notes (from a live debugging session):
 *
 *   1. Login is a classic form POST, not a JSON API:
 *        POST https://bc24.me/login
 *        Content-Type: application/x-www-form-urlencoded
 *        Body: username=<u>&password=<p>&ORIGIN=SB24
 *      Response: 302 → /  with `Set-Cookie: p_token=<JWT>; Path=/`.
 *      The token's `exp` is iat+3600 (1 hour TTL).
 *
 *   2. WS auth:
 *        wss://api.bc24.me/socket.io/?EIO=4&transport=websocket
 *        ← 0{sid,...}
 *        → 40{"auth":{"token":"<p_token>"}}    (Socket.IO v4 auth payload)
 *
 *   3. Event vocabulary (firehose across all channels — adapter filters):
 *        - PAYOUT       {channelId, meron, wala}                   → place-bet
 *        - GAME_STATUS  {channelId, gameStatus, gameId, fightNo}   → betting-status
 *        - RESULT       {channelId, gameId, fightNo, color, result}→ declare-winner
 *        - NEW_GAME     {channelId, gameId, status:"WAITING", ...} → (ignored)
 *        - INITIALIZE   {socketId, lastGame, lastGroupResult}      → bootstrap
 *        - USER_LIMIT   {accountId, channelId, limit}              → (ignored)
 *
 *   4. Status enum: WAITING → OPEN → CLOSED → FINISH. No LAST_CALL state.
 *
 * Config shape (`dataConfig` on the stream record):
 *
 *   { "channelId": 21 }
 *
 * Credentials are global (one bc24 account per kla-pusher process) and live
 * in env vars BC24_USERNAME / BC24_PASSWORD / BC24_ORIGIN — NOT in the
 * per-stream dataConfig. Adding more bc24 streams to the registry only needs
 * a new channelId.
 */
import { io, type Socket } from 'socket.io-client';
import type { AdapterReport, DataAdapter, DataAdapterFactory } from './base.js';
import type { CanonicalEvent, RoundFinalization, StreamMeta } from '../types.js';
import type { Logger } from '../lib/logger.js';
import { env } from '../env.js';

interface Bc24Config {
  /** Channel id to filter the firehose down to. Coerced to string for compare. */
  channelId: string;
}

function parseConfig(raw: unknown): Bc24Config {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('bc24: dataConfig must be an object');
  }
  const v = raw as Record<string, unknown>;
  const cid = v.channelId;
  if (typeof cid !== 'string' && typeof cid !== 'number') {
    throw new Error('bc24: channelId must be string or number');
  }
  return { channelId: String(cid) };
}

// -- bc24 frame shapes (only the fields we read) ----------------------------

interface PayoutFrame {
  channelId: number | string;
  meron?: number;
  wala?: number;
}

interface GameStatusFrame {
  channelId: number | string;
  gameStatus: string;
  gameId: number | string;
  fightNo?: number;
}

interface ResultFrame {
  channelId: number | string;
  gameId: number | string;
  fightNo?: number;
  result: string;  // "MERON" | "WALA" | "TIE"
  color?: string;
}

/** Per-fight context bc24 stamps onto INITIALIZE.lastGame and NEW_GAME — the
 *  fixed posted payout (e.g. 1.95), the operator's betting limits, and a
 *  channel-level enabled flag. None of these come on PAYOUT/GAME_STATUS/RESULT,
 *  so we cache them once and re-emit on every place-bet tick. */
interface GameContextFields {
  channelId?: number | string;
  gameId?: number | string;
  fightNo?: number;
  status?: string;
  channelStatus?: string;        // "ACTIVE" | "INACTIVE"
  payout?: { meron?: number; wala?: number };
  meron?: number;                // live implied odds (parimutuel)
  wala?: number;
  amountMin?: number;
  amountMax?: number;
  totalBetFight?: number;
  totalWinDay?: number;
  liveUrl?: string;
}

interface GroupResultEntry {
  id?: number | string;
  channelId?: number | string;
  fightNo?: number;
  status?: string;               // typically "FINISH"
  result?: string;               // "MERON" | "WALA" | "TIE"
  color?: string;
  createdAt?: string;
}

interface InitializeFrame {
  socketId?: string;
  lastGame?: GameContextFields;
  /** Last ~60 finalized fights for this channel — perfect for backfilling
   *  the chicken ResultsGrid on stream load. Only present in INITIALIZE. */
  lastGroupResult?: GroupResultEntry[];
  /**
   * Top-level `liveUrl` carries the player URL WITH a fresh 60s play-token in
   * the query string (`?token=eyJ...`). `lastGame.liveUrl` is token-less and
   * not usable for /verify — only this one is. Present on the first
   * INITIALIZE after a fresh socket connect.
   */
  liveUrl?: string;
  /** Top-level channelId — identifies which channel `liveUrl` applies to. */
  channelId?: number | string;
}

interface NewGameFrame extends GameContextFields {
  channelId: number | string;
}

/** Decode the `exp` (seconds) out of a JWT in a URL `?token=...` query param.
 *  Returns 0 if anything is malformed — caller treats that as "expires now". */
function extractTokenExpFromUrl(url: string): number {
  try {
    const u = new URL(url);
    const token = u.searchParams.get('token');
    if (!token) return 0;
    const payload = JSON.parse(
      Buffer.from(
        (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString('utf8'),
    );
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** bc24 → our canonical winner names. */
const RESULT_TO_WINNER: Record<string, string> = {
  MERON: 'meron',
  WALA: 'wala',
  TIE: 'draw',
};

/** bc24 status strings we map to our `open` / `close` canonical values.
 *  `WAITING` is bc24's "round created but bets not yet accepted" — treat as
 *  closed so the UI doesn't enable bet buttons. `FINISH` is post-result and
 *  only ever appears in history, never in a live GAME_STATUS frame. */
function mapStatus(bc24Status: string): 'open' | 'close' {
  return bc24Status === 'OPEN' ? 'open' : 'close';
}

/**
 * Log in with the shared viewer credentials. Returns `{ token, expEpochMs }`.
 *
 * bc24's `/login` is a cookie-setting form POST that 302-redirects on success.
 * The token comes back in `Set-Cookie: p_token=...`. Reads the header directly
 * because using a cookie jar would obscure the expiry, which we need for the
 * refresh schedule.
 */
async function bc24Login(log: Logger): Promise<{ token: string; expEpochMs: number }> {
  if (!env.bc24Username || !env.bc24Password) {
    throw new Error('bc24: BC24_USERNAME / BC24_PASSWORD env vars are not set');
  }

  const body = new URLSearchParams({
    username: env.bc24Username,
    password: env.bc24Password,
    ORIGIN: env.bc24Origin,
  });

  // `redirect: 'manual'` so we can read the 302 response without fetching
  // the redirect target (we don't need /).
  const resp = await fetch(env.bc24LoginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // bc24 inspects Origin in its CSRF check (observed in browser flow).
      'Origin': new URL(env.bc24LoginUrl).origin,
      'Referer': env.bc24LoginUrl,
    },
    body,
    redirect: 'manual',
  });

  if (resp.status !== 302 && resp.status !== 200) {
    throw new Error(`bc24: login returned ${resp.status}`);
  }

  // fetch concatenates duplicate Set-Cookie headers with commas — workable
  // here because JWT base64 never contains a comma in the token portion.
  const setCookie = resp.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/p_token=([^;,\s]+)/);
  if (!match) {
    throw new Error(`bc24: no p_token in Set-Cookie (status=${resp.status})`);
  }
  const token = match[1];

  // Decode the JWT payload to read exp. Don't verify (we don't have the
  // signing secret) — bc24 just told us the value, so trust it locally.
  let expEpochMs = Date.now() + 30 * 60 * 1000;  // safe default: 30 min
  try {
    const payloadB64 = token.split('.')[1] ?? '';
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    if (typeof payload.exp === 'number') {
      expEpochMs = payload.exp * 1000;
    }
  } catch (err) {
    log.warn('could not decode p_token exp; using 30-min default', { err: String(err) });
  }

  log.info('bc24 login ok', {
    username: env.bc24Username,
    expEpochMs,
    ttlSec: Math.round((expEpochMs - Date.now()) / 1000),
  });
  return { token, expEpochMs };
}

class Bc24Adapter implements DataAdapter {
  private socket: Socket | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Most recent status emitted per gameId, to dedupe `betting-status` events. */
  private lastStatus: 'open' | 'close' | null = null;
  private lastGameId: string | null = null;
  private winnerEmittedForGame: string | null = null;
  /** Last odds tick — re-emitted on GAME_STATUS so subscribers always see
   *  fresh odds alongside a status flip. */
  private lastOdds: { meron: number; wala: number } | null = null;
  /** Fresh-token iframe URL captured from INITIALIZE frames; consumed by
   *  `getLiveUrl()` and surfaced to the chicken player. */
  private liveUrl: string | null = null;
  private liveUrlExpEpochMs = 0;
  /** Cached bc24 session token. Lasts 1 hour; we reuse it across short-lived
   *  socket connections used to mint play-tokens so we don't hammer /login. */
  private sessionToken: string | null = null;
  private sessionTokenExp = 0;
  /** bc24-only metadata captured from INITIALIZE.lastGame / NEW_GAME / GAME_STATUS / RESULT.
   *  None of these arrive on the high-frequency PAYOUT events, so we cache the
   *  last known value and re-emit it alongside every place-bet so the frontend
   *  always has the current per-fight context (fightNo, fixed payout, limits, etc.). */
  private fightNo: number | null = null;
  private fixedPayout: { meron: number; wala: number } | null = null;
  private limits: {
    amountMin?: number;
    amountMax?: number;
    totalBetFight?: number;
    totalWinDay?: number;
  } = {};
  private channelStatus: string | null = null;
  /** Historical fights bc24 sends in INITIALIZE.lastGroupResult; exposed via
   *  `getUpstreamResults()` so the chicken player can backfill its grid on
   *  load instead of waiting for live RESULT events to accumulate. */
  private upstreamResults: GroupResultEntry[] = [];
  /** Promise gating an in-flight mint. Concurrent `getLiveUrl()` callers
   *  coalesce onto one socket open so a thundering herd of viewers doesn't
   *  spawn N short-lived sockets per click. */
  private refreshingPromise: Promise<void> | null = null;

  constructor(
    private readonly stream: StreamMeta,
    private readonly cfg: Bc24Config,
    private readonly report: AdapterReport,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.disconnect();
      } catch (err) {
        this.log.warn('disconnect failed', { err: String(err) });
      }
      this.socket = null;
    }
    this.lastStatus = null;
    this.lastGameId = null;
    this.winnerEmittedForGame = null;
    this.lastOdds = null;
    this.liveUrl = null;
    this.liveUrlExpEpochMs = 0;
    this.sessionToken = null;
    this.sessionTokenExp = 0;
    this.fightNo = null;
    this.fixedPayout = null;
    this.limits = {};
    this.channelStatus = null;
    this.upstreamResults = [];
  }

  /** Log in, open the WS, schedule the next refresh. Idempotent under
   *  reconnects: kills any existing socket/timer first. */
  private async connect(): Promise<void> {
    if (this.stopped) return;

    // Tear down a prior connection so reconnects don't leak handles.
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.disconnect();
      } catch { /* ignore */ }
      this.socket = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    const { token, expEpochMs } = await bc24Login(this.log);

    // Captured connect payload from the browser:
    //   40{"token":"<jwt>","channelId":43}
    // socket.io-client serializes `auth` as `40<JSON.stringify(auth)>`, so
    // passing the channelId alongside the token gets us the same wire shape.
    // bc24 apparently uses the channelId on connect to register the socket
    // as a "player" for that channel — without it, PLAYER_REFRESH was being
    // silently ignored even though the firehose of PAYOUT events flowed.
    const channelIdNum = Number(this.cfg.channelId);
    const authPayload: Record<string, unknown> = { token };
    if (Number.isFinite(channelIdNum)) authPayload.channelId = channelIdNum;

    this.socket = io(env.bc24SocketUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: authPayload,
      // bc24 is single-account; if it kicks us we want to re-login on every
      // reconnect (the cached token may be invalidated). Disable socket.io's
      // built-in reconnect and drive reconnects manually from the
      // disconnect/connect_error handlers.
      reconnection: false,
    });

    this.socket.on('connect', () => {
      this.log.info('bc24 ws connected', { sid: this.socket?.id });
      // bc24 holds back the per-channel INITIALIZE bootstrap (which carries the
      // fresh-token `liveUrl`) until the client explicitly asks for it.
      // Captured from a working browser session: `42["PLAYER_REFRESH",{channelId}]`
      // is the trigger — the server responds with an INITIALIZE event.
      this.requestPlayerRefresh();
    });
    this.socket.on('disconnect', (reason) => {
      this.log.warn('bc24 ws disconnected', { reason });
      this.scheduleReconnect(2_000);
    });
    this.socket.on('connect_error', (err) => {
      this.log.error('bc24 ws connect error', { err: String(err) });
      this.scheduleReconnect(5_000);
    });

    // bc24's events are top-level Socket.IO events on the root namespace.
    this.socket.on('INITIALIZE', (frame: InitializeFrame) => this.handleInitialize(frame));
    this.socket.on('PAYOUT', (frame: PayoutFrame) => this.handlePayout(frame));
    this.socket.on('GAME_STATUS', (frame: GameStatusFrame) => this.handleGameStatus(frame));
    this.socket.on('NEW_GAME', (frame: NewGameFrame) => this.handleNewGame(frame));
    this.socket.on('RESULT', (frame: ResultFrame) => this.handleResult(frame));
    this.socket.on('USER_LIMIT', () => { /* ignored — bc24-side account limits */ });

    // Schedule a refresh 10 minutes before token expiry. If something goes
    // wrong with the schedule, the disconnect handler will eventually
    // re-login anyway when bc24 kicks an expired token.
    const refreshAtMs = Math.max(expEpochMs - 10 * 60 * 1000, Date.now() + 60_000);
    this.refreshTimer = setTimeout(() => {
      this.log.info('bc24 token refresh due — reconnecting');
      this.connect().catch((err) => {
        this.log.error('bc24 refresh failed', { err: String(err) });
        this.scheduleReconnect(15_000);
      });
    }, refreshAtMs - Date.now());
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.log.error('bc24 reconnect failed; will retry', { err: String(err) });
        this.scheduleReconnect(Math.min(delayMs * 2, 60_000));
      });
    }, delayMs);
  }

  // -- event handlers -------------------------------------------------------

  /** Only true if the frame is for the channel this adapter cares about. */
  private isOurChannel(channelId: number | string | undefined): boolean {
    return channelId != null && String(channelId) === this.cfg.channelId;
  }

  private handleInitialize(frame: InitializeFrame): void {
    // NOTE: we intentionally do NOT capture `frame.liveUrl` here. bc24 ties
    // the play-token to the socket session, so this persistent socket's
    // INITIALIZE always carries the SAME (already-used) token — surfacing
    // it would re-create the stale-token bug. Fresh play-tokens are minted
    // on demand by `mintFreshLiveUrl()` via a short-lived dedicated socket.

    // History backfill — replace, don't merge: bc24 sends the authoritative
    // last-60 each time. Filter to our channel since `lastGroupResult` may
    // include other channels in some replay scenarios.
    if (Array.isArray(frame.lastGroupResult)) {
      this.upstreamResults = frame.lastGroupResult.filter((r) =>
        this.isOurChannel(r.channelId),
      );
    }

    // Per-fight context (fightNo, payout, limits, channelStatus, odds, status)
    // — INITIALIZE.lastGame is the snapshot, so we absorb everything we can.
    const lg = frame.lastGame;
    if (lg && this.isOurChannel(lg.channelId)) {
      this.absorbContext(lg);
      // Emit a place-bet so subscribers that joined before the first live
      // PAYOUT/GAME_STATUS see the enriched snapshot immediately.
      this.emitPlaceBet(this.lastStatus ?? 'close');
    }
  }

  /** NEW_GAME fires when a round is created but not yet OPEN. It carries the
   *  same per-fight context that INITIALIZE.lastGame does (payout, limits, etc).
   *  We absorb it but don't emit a `betting-status` yet — bc24's WAITING isn't
   *  actionable for our open/close model; that flip happens on GAME_STATUS:OPEN. */
  private handleNewGame(frame: NewGameFrame): void {
    if (!this.isOurChannel(frame.channelId)) return;
    this.absorbContext(frame);
    // Refresh subscribers with the new fightNo/payout context.
    this.emitPlaceBet(this.lastStatus ?? 'close');
  }

  /** Copy every known per-fight field from a bc24 context blob into the cache.
   *  Only updates fields that are actually present — bc24 sends slightly
   *  different subsets on different events (INITIALIZE.lastGame is fullest,
   *  NEW_GAME is similar, GAME_STATUS only carries fightNo/status). */
  private absorbContext(ctx: GameContextFields): void {
    if (typeof ctx.gameId === 'string' || typeof ctx.gameId === 'number') {
      this.lastGameId = String(ctx.gameId);
    }
    if (typeof ctx.fightNo === 'number') this.fightNo = ctx.fightNo;
    if (typeof ctx.meron === 'number' && typeof ctx.wala === 'number') {
      this.lastOdds = { meron: ctx.meron, wala: ctx.wala };
    }
    if (ctx.payout && typeof ctx.payout.meron === 'number' && typeof ctx.payout.wala === 'number') {
      this.fixedPayout = { meron: ctx.payout.meron, wala: ctx.payout.wala };
    }
    if (typeof ctx.amountMin === 'number') this.limits.amountMin = ctx.amountMin;
    if (typeof ctx.amountMax === 'number') this.limits.amountMax = ctx.amountMax;
    if (typeof ctx.totalBetFight === 'number') this.limits.totalBetFight = ctx.totalBetFight;
    if (typeof ctx.totalWinDay === 'number') this.limits.totalWinDay = ctx.totalWinDay;
    if (typeof ctx.channelStatus === 'string') this.channelStatus = ctx.channelStatus;
    if (typeof ctx.status === 'string') {
      this.lastStatus = mapStatus(ctx.status);
    }
  }

  /** Snapshot of the bc24-only metadata for the chicken history endpoint
   *  and any frontend consumers. Returned by `getUpstreamResults()` below. */
  getUpstreamResults(): GroupResultEntry[] {
    return this.upstreamResults.slice();
  }

  /**
   * Return the iframe URL with a freshly-minted play-token.
   *
   * bc24 ties each play-token to a socket session — emitting PLAYER_REFRESH
   * on our long-lived data socket returns the SAME token every time, because
   * the server caches "this session's play-token" once it's been minted.
   * So we open a short-lived dedicated socket per call, send PLAYER_REFRESH,
   * capture the INITIALIZE.liveUrl, and disconnect. Each fresh socket
   * session gets its own fresh token.
   *
   * The persistent socket stays running — it carries the high-volume data
   * events (PAYOUT / GAME_STATUS / RESULT) and we don't want to interrupt
   * it. Two sockets per stream is acceptable; bc24's account-level cost is
   * one extra WS connection per /live-url call (short-lived).
   *
   * Concurrent callers coalesce onto a single in-flight mint so a thundering
   * herd of viewers doesn't open one socket per click.
   */
  async getLiveUrl(): Promise<string | null> {
    if (this.refreshingPromise) {
      await this.refreshingPromise;
      return this.liveUrl;
    }
    this.refreshingPromise = this.mintFreshLiveUrl()
      .catch((err) => {
        this.log.warn('bc24 mintFreshLiveUrl failed', { err: String(err) });
      })
      .finally(() => {
        this.refreshingPromise = null;
      });
    await this.refreshingPromise;
    return this.liveUrl;
  }

  /** Open a one-shot bc24 socket, send PLAYER_REFRESH, capture the
   *  INITIALIZE.liveUrl (with fresh play-token), close. Updates
   *  `this.liveUrl` + `this.liveUrlExpEpochMs` on success. */
  private async mintFreshLiveUrl(): Promise<void> {
    if (!env.bc24Username || !env.bc24Password) {
      this.log.warn('bc24 mint skipped: credentials missing');
      return;
    }
    const sessionToken = await this.getOrRefreshSessionToken();
    const channelIdNum = Number(this.cfg.channelId);
    if (!Number.isFinite(channelIdNum)) {
      this.log.warn('bc24 mint skipped: non-numeric channelId', { channelId: this.cfg.channelId });
      return;
    }

    await new Promise<void>((resolve) => {
      const mintSocket: Socket = io(env.bc24SocketUrl, {
        path: '/socket.io',
        transports: ['websocket'],
        auth: { token: sessionToken, channelId: channelIdNum },
        reconnection: false,
        forceNew: true,  // don't share the long-lived socket's session
      });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { mintSocket.removeAllListeners(); mintSocket.disconnect(); } catch { /* ignore */ }
        resolve();
      };
      const timer = setTimeout(() => {
        this.log.warn('bc24 mint timed out');
        finish();
      }, 5_000);

      mintSocket.on('connect', () => {
        mintSocket.emit('PLAYER_REFRESH', { channelId: channelIdNum });
      });
      mintSocket.on('connect_error', (err) => {
        this.log.warn('bc24 mint connect_error', { err: String(err) });
        clearTimeout(timer);
        finish();
      });
      mintSocket.on('INITIALIZE', (frame: InitializeFrame) => {
        if (
          this.isOurChannel(frame.channelId) &&
          typeof frame.liveUrl === 'string' &&
          frame.liveUrl.length > 0
        ) {
          this.liveUrl = frame.liveUrl;
          this.liveUrlExpEpochMs = extractTokenExpFromUrl(frame.liveUrl);
          this.log.info('bc24 liveUrl minted (fresh socket)', {
            ttlSec: Math.round((this.liveUrlExpEpochMs - Date.now()) / 1000),
          });
          clearTimeout(timer);
          finish();
        }
      });
    });
  }

  /** Reuse the same 1-hour session token across many mint sockets so we
   *  don't hit `/login` on every viewer page-load. Re-login when the cached
   *  token has less than 5 minutes of TTL remaining. */
  private async getOrRefreshSessionToken(): Promise<string> {
    const STALE_MS = 5 * 60 * 1000;
    if (this.sessionToken && this.sessionTokenExp - Date.now() > STALE_MS) {
      return this.sessionToken;
    }
    const { token, expEpochMs } = await bc24Login(this.log);
    this.sessionToken = token;
    this.sessionTokenExp = expEpochMs;
    return token;
  }

  /** Ask bc24 to re-bootstrap this channel — fires the events the browser
   *  fires after connect. The server responds with `INITIALIZE` carrying a
   *  fresh-token `liveUrl`. Safe to call repeatedly. */
  private requestPlayerRefresh(): void {
    if (!this.socket || this.socket.disconnected) return;
    const channelIdNum = Number(this.cfg.channelId);
    if (!Number.isFinite(channelIdNum)) {
      this.log.warn('bc24 channelId not numeric; skipping PLAYER_REFRESH', {
        channelId: this.cfg.channelId,
      });
      return;
    }
    this.log.info('bc24 emit PLAYER_REFRESH', { channelId: channelIdNum });
    // Mirror the browser's sequence — we don't know which of these actually
    // triggers INITIALIZE, but sending the same events the browser does is
    // the closest approximation to "behaving like a normal client".
    this.socket.emit('PLAYER_REFRESH', { channelId: channelIdNum });
    this.socket.emit('PLAYER_REFRESH_BET_GAME_HISTORY_LIST', { channelId: channelIdNum });
  }

  private handlePayout(frame: PayoutFrame): void {
    if (!this.isOurChannel(frame.channelId)) return;
    if (typeof frame.meron === 'number' && typeof frame.wala === 'number') {
      this.lastOdds = { meron: frame.meron, wala: frame.wala };
    }
    this.emitPlaceBet(this.lastStatus ?? 'close');
  }

  private handleGameStatus(frame: GameStatusFrame): void {
    if (!this.isOurChannel(frame.channelId)) return;

    const gameId = String(frame.gameId);
    const status = mapStatus(frame.gameStatus);
    if (typeof frame.fightNo === 'number') this.fightNo = frame.fightNo;

    // Round rollover — reset winner-emitted tracking so the next RESULT
    // for this round fires exactly once.
    if (this.lastGameId !== gameId) {
      this.lastGameId = gameId;
      this.winnerEmittedForGame = null;
      this.lastStatus = null;  // force a `betting-status` emit on first frame of new round
    }

    // Emit place-bet first (carries the live status alongside odds, like ds88).
    // This keeps frontend snapshot logic identical across adapters.
    this.emitPlaceBet(status);

    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.report.emit({
        type: 'betting-status',
        streamId: this.stream.streamId,
        data: {
          status,
          roundId: gameId,
          eventId: this.cfg.channelId,
          // bc24 enrichment so subscribers can render "Fight #N" alongside
          // the status flip without a separate place-bet.
          fightNo: this.fightNo,
        },
        ts: Date.now(),
        upstreamRef: gameId,
      });
    }
  }

  private handleResult(frame: ResultFrame): void {
    if (!this.isOurChannel(frame.channelId)) return;

    const gameId = String(frame.gameId);
    if (this.winnerEmittedForGame === gameId) return;
    this.winnerEmittedForGame = gameId;
    if (typeof frame.fightNo === 'number') this.fightNo = frame.fightNo;

    const winner = RESULT_TO_WINNER[frame.result?.toUpperCase()] ?? frame.result.toLowerCase();

    // bc24 doesn't send final pool totals in RESULT — leave them as the most
    // recent odds tick the UI saw. Site-api accepts missing finals.
    const data = {
      declareData: {
        result: winner,
        finalMeron: this.lastOdds ? String(this.lastOdds.meron) : '0',
        finalWala: this.lastOdds ? String(this.lastOdds.wala) : '0',
        finalDraw: '0',
      },
      // Per-fight identifier so subscribers can dedupe by event. Previously
      // this was `this.cfg.channelId`, which is constant per stream — every
      // declare-winner emission collided with the prior one, and the chicken
      // ResultsGrid lost the latest fights as a result.
      eventId: gameId,
      roundId: gameId,
      fightNo: this.fightNo,
      color: frame.color,
    };
    this.report.emit({
      type: 'declare-winner',
      streamId: this.stream.streamId,
      data,
      ts: Date.now(),
      upstreamRef: gameId,
    });
    this.report.emit({
      type: 'game-ended',
      streamId: this.stream.streamId,
      data: { winner, roundId: gameId },
      ts: Date.now(),
      upstreamRef: gameId,
    });

    const finalization: RoundFinalization = {
      streamId: this.stream.streamId,
      upstreamEventId: gameId,
      winner,
      declaredAt: Math.floor(Date.now() / 1000),
      raw: frame,
    };
    this.report.finalize(finalization);
  }

  /** Build and emit the canonical `place-bet` event. bc24 doesn't publish
   *  bet *volume* totals, so betMeron/betWala fields stay at '0' — the UI
   *  reads odds out of percentMeron/percentWala (* 100 to match ds88's
   *  percentage scale, since the frontend divides by 100).
   *
   *  bc24-specific enrichment fields (`fightNo`, `payout`, `limits`,
   *  `channelStatus`) live alongside the canonical fields. They're optional
   *  in the frontend types — ds88/pusher-laravel just don't populate them. */
  private emitPlaceBet(status: 'open' | 'close'): void {
    const odds = this.lastOdds ?? { meron: 0, wala: 0 };
    const placeBet: CanonicalEvent = {
      type: 'place-bet',
      streamId: this.stream.streamId,
      data: {
        betData: {
          betMeron: '0',
          betWala: '0',
          betDraw: '0',
          // Frontend computes oddsMeron = percentMeron / 100, so multiply by 100.
          percentMeron: (odds.meron * 100).toFixed(2),
          percentWala: (odds.wala * 100).toFixed(2),
          myBetMeron: '0',
          myBetWala: '0',
          myBetDraw: '0',
          gbbetMeron: '0',
          gbbetWala: '0',
          actualMeron: '0',
          actualWala: '0',
        },
        eventId: this.cfg.channelId,
        roundId: this.lastGameId,
        // bc24's `fightNo` is the operator's per-round counter (1, 2, 3...).
        // We map it onto the canonical `roundNumber` slot ds88 fills with
        // `fightNumber.number`, so the chicken UI's existing `roundNumber`
        // consumer needs no special-casing.
        roundNumber: this.fightNo,
        status,
        // bc24 enrichment — see class field docs.
        fightNo: this.fightNo,
        payout: this.fixedPayout,
        limits: this.limitsForEmit(),
        channelStatus: this.channelStatus,
      },
      ts: Date.now(),
      upstreamRef: this.lastGameId ?? this.cfg.channelId,
    };
    this.report.emit(placeBet);
  }

  /** Return the limits cache only if it has at least one field — keeps the
   *  emitted payload free of empty objects when bc24 hasn't filled them yet. */
  private limitsForEmit(): typeof this.limits | null {
    return Object.keys(this.limits).length > 0 ? this.limits : null;
  }
}

export const bc24Factory: DataAdapterFactory = {
  id: 'bc24',
  create(stream, report, log) {
    const cfg = parseConfig(stream.dataConfig);
    return new Bc24Adapter(stream, cfg, report, log.child(`adapter:bc24:${stream.streamId}`));
  },
};
