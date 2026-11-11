import { expect, test } from 'bun:test';
import { runPwaProvenanceBadgeWorld, type PwaProvenanceEvent } from './pwa-provenance-badge-world.js';

test('pwa-provenance-badge-world replays RFC §3 sources through the production PWA projection', () => {
  const events: PwaProvenanceEvent[] = [
    { eventId: 'sim-event', provenance: { universe: 'test', source: 'sim', device: 'fake-pwa', scenario: 'badge-matrix', clock: 'sim' } },
    { eventId: 'replay-event', provenance: { universe: 'test', source: 'replay', device: 'fake-pwa', scenario: 'badge-matrix', clock: 'sim' } },
    { eventId: 'injected-event', provenance: { universe: 'test', source: 'injected', device: 'fake-pwa', scenario: 'badge-matrix', clock: 'sim' } },
    { eventId: 'shadow-event', provenance: { universe: 'test', source: 'shadow', device: 'fake-pwa', scenario: 'badge-matrix', clock: 'sim' } },
    { eventId: 'real-event', provenance: { universe: 'prod', source: 'real', clock: 'real' } },
    { eventId: 'probe-event', provenance: { universe: 'prod', source: 'synthetic-probe', clock: 'real' } },
  ];

  const projection = runPwaProvenanceBadgeWorld(events);

  expect(projection.map(({ badge }) => badge)).toEqual([
    { kind: 'badge', source: 'sim', icon: '🧪', label: '시뮬' },
    { kind: 'badge', source: 'replay', icon: '🎞', label: '재생' },
    { kind: 'badge', source: 'injected', icon: '💉', label: '주입' },
    { kind: 'badge', source: 'shadow', icon: '👻', label: '그림자' },
    { kind: 'unbadged', source: 'real' },
    { kind: 'unbadged', source: 'synthetic-probe' },
  ]);
  expect(projection.map(({ eventId }) => eventId)).toEqual(events.map(({ eventId }) => eventId));
  expect(projection[0]?.provenance).toEqual(events[0]?.provenance);
  expect(projection[4]?.provenance?.source).toBe('real');
  expect(projection[5]?.provenance?.source).toBe('synthetic-probe');
});

test('missing provenance is shown as unknown and cannot be mistaken for a real event', () => {
  const [missing, malformed] = runPwaProvenanceBadgeWorld([
    { eventId: 'missing-event' },
    { eventId: 'malformed-event', provenance: { source: 'future-source' } },
  ]);

  expect(missing?.badge).toEqual({ kind: 'unknown', source: 'unknown', icon: '?', label: '출처 미상' });
  expect(malformed?.badge).toEqual({ kind: 'unknown', source: 'future-source', icon: '?', label: '출처 미상' });
});
