/**
 * Adapter registry. Map of `dataAdapter` id → factory.
 *
 * Adding a new provider:
 *   1. Write a file in this folder implementing `DataAdapterFactory`.
 *   2. Add it to the map below.
 *   3. Set a stream's `dataAdapter` to the new id via the admin UI.
 *
 * Current production: only `bc24` (bc24.me / api.bc24.me / cc.realtimevideo.cc,
 * white-labelled as SB24). The legacy `ds88` and `pusher-laravel` adapters
 * were removed when the platform standardised on the sb24 pipeline.
 */
import { bc24Factory } from './bc24.js';
import type { DataAdapterFactory } from './base.js';

const REGISTRY: DataAdapterFactory[] = [bc24Factory];

const byId: Record<string, DataAdapterFactory> = Object.fromEntries(
  REGISTRY.map((f) => [f.id, f]),
);

export function getAdapterFactory(id: string): DataAdapterFactory | undefined {
  return byId[id];
}

export function listAdapterIds(): string[] {
  return REGISTRY.map((f) => f.id);
}

export type { DataAdapter, DataAdapterFactory, AdapterReport } from './base.js';
