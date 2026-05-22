/**
 * Environment loading + validation. Loaded once at boot; downstream modules
 * import `env` instead of touching process.env directly.
 */
import 'dotenv/config';

function requireInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name} is not a number: ${raw}`);
  }
  return n;
}

function requireString(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Required env var missing: ${name}`);
}

function requireOneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = (process.env[name] ?? fallback) as T;
  if (!allowed.includes(v)) {
    throw new Error(`Env var ${name} must be one of ${allowed.join(',')}; got '${v}'`);
  }
  return v;
}

export const env = {
  port: requireInt('PORT', 3001),
  registrySource: requireOneOf('REGISTRY_SOURCE', ['local', 'site-api'] as const, 'local'),
  streamsRegistryFile: requireString('STREAMS_REGISTRY_FILE', './data/streams.json'),
  siteApiBaseUrl: requireString('SITE_API_BASE_URL', 'http://localhost:4000'),
  siteApiServiceToken: process.env.SITE_API_SERVICE_TOKEN ?? '',
  registryGameIds: (process.env.REGISTRY_GAME_IDS ?? 'kla-chicken')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  registryPollIntervalMs: requireInt('REGISTRY_POLL_INTERVAL_MS', 30_000),

  // bc24 — credentials for the shared viewer account. Empty strings mean
  // "bc24 not configured" — the adapter will refuse to start in that case
  // rather than POSTing empty credentials.
  bc24LoginUrl: requireString('BC24_LOGIN_URL', 'https://bc24.me/login'),
  bc24SocketUrl: requireString('BC24_SOCKET_URL', 'wss://api.bc24.me'),
  bc24Origin: requireString('BC24_ORIGIN', 'SB24'),
  bc24Username: process.env.BC24_USERNAME ?? '',
  bc24Password: process.env.BC24_PASSWORD ?? '',
} as const;

export type Env = typeof env;
