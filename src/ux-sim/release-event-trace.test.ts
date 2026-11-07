import { expect, test } from 'bun:test';
import { checkReleaseEventTrace, type ReleaseEventExpectation, type ReleaseEventRecord } from './release-event-trace.js';

test('release event trace matches ordered data fields while ignoring undeclared fields', () => {
  const actual: ReleaseEventRecord[] = [
    { event: 'node-start', node: 'cutoff', runId: 'run-1', seq: 1 },
    { event: 'node-end', node: 'cutoff', outcome: 'ok', extra: 'kept' },
    { event: 'edge-selected', from: 'cutoff', to: 'export-check', outcome: 'ok' },
  ];
  const expected: ReleaseEventExpectation[] = [
    { event: 'node-start', node: 'cutoff' },
    { event: 'node-end', node: 'cutoff', outcome: 'ok' },
    { event: 'edge-selected', from: 'cutoff', to: 'export-check' },
  ];
  expect(checkReleaseEventTrace(actual, expected)).toMatchObject({ pass: true, matched: 3, missing: [] });
});

test('release event trace only relaxes order inside a concurrent group', () => {
  const actual: ReleaseEventRecord[] = [
    { event: 'node-start', node: 'prefetch' },
    { event: 'node-start', node: 'checklist-gate' },
    { event: 'node-end', node: 'prefetch', outcome: 'ok' },
    { event: 'node-end', node: 'checklist-gate', outcome: 'ok' },
  ];
  const expected: ReleaseEventExpectation[] = [
    { concurrent: [{ event: 'node-start', node: 'checklist-gate' }, { event: 'node-start', node: 'prefetch' }] },
    { concurrent: [{ event: 'node-end', node: 'checklist-gate' }, { event: 'node-end', node: 'prefetch' }] },
  ];
  expect(checkReleaseEventTrace(actual, expected)).toMatchObject({ pass: true, matched: 4, missing: [] });
});

test('release event trace rejects reordered sequential events and incorrect payload values', () => {
  const actual: ReleaseEventRecord[] = [
    { event: 'node-end', node: 'gate', outcome: 'fail' },
    { event: 'node-start', node: 'gate-bisect' },
  ];
  expect(checkReleaseEventTrace(actual, [
    { event: 'node-start', node: 'gate' },
    { event: 'node-end', node: 'gate', outcome: 'ok' },
  ])).toMatchObject({ pass: false, matched: 0 });
});

test('concurrent expectations cannot reuse one actual event to satisfy duplicates', () => {
  expect(checkReleaseEventTrace([{ event: 'node-start', node: 'pwa' }], [
    { concurrent: [{ event: 'node-start', node: 'pwa' }, { event: 'node-start', node: 'pwa' }] },
  ])).toMatchObject({ pass: false, matched: 1, missing: [{ expectationIndex: 0, event: { event: 'node-start', node: 'pwa' } }] });
});

test('concurrent matching preserves a unique specific candidate for its constrained expectation', () => {
  expect(checkReleaseEventTrace([
    { event: 'node-start', node: 'gate' },
    { event: 'node-start', node: 'pwa' },
  ], [{ concurrent: [
    { event: 'node-start' },
    { event: 'node-start', node: 'gate' },
  ] }])).toMatchObject({ pass: true, matched: 2, missing: [] });
});

test('concurrent matching consumes the earliest valid group before later sequential expectations', () => {
  const actual: ReleaseEventRecord[] = [
    { event: 'node-start', node: 'gate' },
    { event: 'node-start', node: 'pwa' },
    { event: 'marker' },
    { event: 'node-start', node: 'gate' },
  ];
  expect(checkReleaseEventTrace(actual, [
    { concurrent: [{ event: 'node-start' }, { event: 'node-start', node: 'gate' }] },
    { event: 'marker' },
  ])).toMatchObject({ pass: true, matched: 3, missing: [] });
});
