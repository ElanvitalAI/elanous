import { normalizeServiceName, type CapabilityEntry } from './capability-types.js';

export type CapabilityBackend = CapabilityEntry['backend'];
export type CapabilityMatrix = CapabilityEntry[];

export interface CapabilityReaders {
  readonly codex: () => readonly CapabilityEntry[];
  readonly claude: () => readonly CapabilityEntry[];
  readonly grok: () => readonly CapabilityEntry[];
}

/** List all three backends without changing their configuration or the readers' observations. */
export function buildCapabilityMatrix(readers: CapabilityReaders): CapabilityMatrix {
  return [
    ...readers.codex(),
    ...readers.claude(),
    ...readers.grok(),
  ];
}

/** Only a confirmed ready observation can authorize a backend selection. */
export function pickBackend(matrix: readonly CapabilityEntry[], service: string): CapabilityBackend | null {
  const key = normalizeServiceName(service);
  if (!key) return null;
  for (const backend of ['codex', 'claude', 'grok'] as const) {
    if (matrix.some(entry => entry.backend === backend
      && entry.state === 'ready'
      && normalizeServiceName(entry.service) === key)) return backend;
  }
  return null;
}
