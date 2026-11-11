import { projectPwaProvenanceBadge } from '../../apps/pwa/src/lib/provenance-badge.js';

export interface PwaProvenanceEvent {
  readonly eventId: string;
  readonly provenance?: {
    readonly universe?: string;
    readonly source?: unknown;
    readonly device?: string;
    readonly scenario?: string;
    readonly lease?: string;
    readonly clock?: 'real' | 'sim';
  };
}

export type PwaProvenanceBadgeEvent = PwaProvenanceEvent & {
  readonly badge: ReturnType<typeof projectPwaProvenanceBadge>;
};

/** Replay provenance-bearing PWA event rows through the production badge projection, without a screen or network. */
export function runPwaProvenanceBadgeWorld(events: readonly PwaProvenanceEvent[]): PwaProvenanceBadgeEvent[] {
  return events.map((event) => ({
    ...event,
    badge: projectPwaProvenanceBadge(event.provenance?.source),
  }));
}
