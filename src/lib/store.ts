/**
 * Per-stream disk persistence. One subdirectory per streamId under data/:
 *
 *   data/{streamId}/latest.json     ← latest payload per canonical type
 *   data/{streamId}/results.json    ← last N finalized results
 *
 * Keeps the simple JSON-file shape from v1, but namespaced so multiple
 * streams don't clobber each other. Writes are synchronous + best-effort;
 * if a stream is removed from the registry its directory can be deleted.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalEvent } from '../types.js';
import type { Logger } from './logger.js';

const MAX_RESULTS = 50;

export class StreamStore {
  private readonly dir: string;

  constructor(
    rootDir: string,
    private readonly streamId: string,
    private readonly log: Logger,
  ) {
    this.dir = join(rootDir, streamId);
    mkdirSync(this.dir, { recursive: true });
  }

  private path(file: string): string {
    return join(this.dir, file);
  }

  loadLatest(): Record<string, CanonicalEvent> {
    return this.readJson<Record<string, CanonicalEvent>>('latest.json', {});
  }

  loadResults(): unknown[] {
    return this.readJson<unknown[]>('results.json', []);
  }

  saveLatest(latest: Record<string, CanonicalEvent>): void {
    this.writeJson('latest.json', latest);
  }

  saveResults(results: unknown[]): void {
    this.writeJson('results.json', results.slice(0, MAX_RESULTS));
  }

  destroy(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn('failed to remove stream dir', { streamId: this.streamId, err: String(err) });
    }
  }

  private readJson<T>(file: string, fallback: T): T {
    const p = this.path(file);
    if (!existsSync(p)) return fallback;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch (err) {
      this.log.warn('failed to parse JSON file; using fallback', { file: p, err: String(err) });
      return fallback;
    }
  }

  private writeJson(file: string, body: unknown): void {
    try {
      writeFileSync(this.path(file), JSON.stringify(body, null, 2));
    } catch (err) {
      this.log.warn('failed to write JSON file', { file, err: String(err) });
    }
  }
}
