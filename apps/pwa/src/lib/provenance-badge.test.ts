import { expect, test } from 'bun:test';
import { projectPwaProvenanceBadge } from './provenance-badge.js';

test('PWA projects the four non-real RFC provenance sources into their requested badges', () => {
  expect(['sim', 'replay', 'injected', 'shadow'].map(projectPwaProvenanceBadge)).toEqual([
    { kind: 'badge', source: 'sim', icon: '🧪', label: '시뮬' },
    { kind: 'badge', source: 'replay', icon: '🎞', label: '재생' },
    { kind: 'badge', source: 'injected', icon: '💉', label: '주입' },
    { kind: 'badge', source: 'shadow', icon: '👻', label: '그림자' },
  ]);
});

test('real and synthetic-probe remain distinguishable and do not masquerade as one of the four badges', () => {
  expect(projectPwaProvenanceBadge('real')).toEqual({ kind: 'unbadged', source: 'real' });
  expect(projectPwaProvenanceBadge('synthetic-probe')).toEqual({ kind: 'unbadged', source: 'synthetic-probe' });
});

test('missing or unrecognized provenance fails closed as unknown', () => {
  expect(projectPwaProvenanceBadge(undefined)).toEqual({
    kind: 'unknown', source: 'unknown', icon: '?', label: '출처 미상',
  });
  expect(projectPwaProvenanceBadge('future-source')).toEqual({
    kind: 'unknown', source: 'future-source', icon: '?', label: '출처 미상',
  });
});
