/**
 * Tiny structured logger. Single-line JSON, plus a friendlier prefix when
 * stderr is a TTY (i.e. dev). No external deps.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_LABELS: Record<Level, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

const isTty = process.stderr.isTTY;

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  if (isTty) {
    const payload = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    process.stderr.write(`${ts} ${LEVEL_LABELS[level]} [${scope}] ${message}${payload}\n`);
  } else {
    process.stderr.write(JSON.stringify({ ts, level, scope, message, ...meta }) + '\n');
  }
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
