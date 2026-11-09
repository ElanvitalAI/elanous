import { expect, test } from 'bun:test';
import {
  evaluateCliChildAdoption,
  type CliChildEvent,
} from './in-process-cli-539-file-adoption-sim.js';

test('adopted files require one real child start and close linked to the same run', () => {
  const events: CliChildEvent[] = [
    { eventId: 'run-a:cli-child:child-started', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-started', pid: 101 },
    { eventId: 'run-a:cli-child:child-closed', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-closed', pid: 101, exitCode: 0, signal: null, timedOut: false },
    { eventId: 'run-b:cli-child:child-started', runId: 'run-b', sourceFile: 'test/b.test.ts', type: 'child-started', pid: 102 },
    { eventId: 'run-b:cli-child:child-closed', runId: 'run-b', sourceFile: 'test/b.test.ts', type: 'child-closed', pid: 102, exitCode: 0, signal: null, timedOut: false },
  ];
  expect(evaluateCliChildAdoption([
    { sourceFile: 'test/a.test.ts', runId: 'run-a' },
    { sourceFile: 'test/b.test.ts', runId: 'run-b' },
  ], events)).toEqual({ ok: true, targetFiles: 2, realChildren: 2, findings: [] });
});

test('duplicate child and unclosed child are visible failures, not a green count', () => {
  const runId = 'run-dup';
  const sourceFile = 'test/a.test.ts';
  const events: CliChildEvent[] = [
    { eventId: 'start-1', runId, sourceFile, type: 'child-started', pid: 101 },
    { eventId: 'start-2', runId, sourceFile, type: 'child-started', pid: 102 },
  ];
  const result = evaluateCliChildAdoption([{ sourceFile, runId }], events);
  expect(result.ok).toBe(false);
  expect(result.realChildren).toBe(2);
  expect(result.findings).toContain(`${sourceFile} run=${runId}: expected 1 child start, got 2`);
  expect(result.findings).toContain(`${sourceFile} run=${runId}: expected 1 child close, got 0`);
});

test('missing pid and events without a matching target fail closed', () => {
  const events: CliChildEvent[] = [
    { eventId: 'no-pid', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-started' },
    { eventId: 'orphan', runId: 'run-other', sourceFile: 'test/other.test.ts', type: 'child-closed', exitCode: 0 },
  ];
  const result = evaluateCliChildAdoption([{ sourceFile: 'test/a.test.ts', runId: 'run-a' }], events);
  expect(result.ok).toBe(false);
  expect(result.findings).toContain('invalid real child pid test/a.test.ts run=run-a');
  expect(result.findings).toContain('event outside target cohort test/other.test.ts run=run-other');
});

test('start and close events must refer to the same child process', () => {
  const result = evaluateCliChildAdoption([{ sourceFile: 'test/a.test.ts', runId: 'run-a' }], [
    { eventId: 'start', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-started', pid: 101 },
    { eventId: 'close', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-closed', pid: 102, exitCode: 0 },
  ]);
  expect(result.ok).toBe(false);
  expect(result.findings).toContain('test/a.test.ts run=run-a: child pid changed across lifecycle');
});

test('a close event before start is rejected even when counts and pid eventually match', () => {
  const result = evaluateCliChildAdoption([{ sourceFile: 'test/a.test.ts', runId: 'run-a' }], [
    { eventId: 'close', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-closed', pid: 101, exitCode: 0 },
    { eventId: 'start', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-started', pid: 101 },
  ]);
  expect(result.ok).toBe(false);
  expect(result.findings).toContain('test/a.test.ts run=run-a: child close preceded start');
});

test('non-finite and fractional values are not real process identifiers', () => {
  const result = evaluateCliChildAdoption([
    { sourceFile: 'test/a.test.ts', runId: 'run-a' },
    { sourceFile: 'test/b.test.ts', runId: 'run-b' },
  ], [
    { eventId: 'a-start', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-started', pid: Infinity },
    { eventId: 'a-close', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-closed', pid: Infinity, exitCode: 0 },
    { eventId: 'b-start', runId: 'run-b', sourceFile: 'test/b.test.ts', type: 'child-started', pid: 1.5 },
    { eventId: 'b-close', runId: 'run-b', sourceFile: 'test/b.test.ts', type: 'child-closed', pid: 1.5, exitCode: 0 },
  ]);
  expect(result.ok).toBe(false);
  expect(result.findings.filter((finding) => finding.includes('invalid') && finding.includes('pid'))).toHaveLength(4);
});

test('unknown lifecycle event types cannot stand in for a child close', () => {
  const result = evaluateCliChildAdoption([{ sourceFile: 'test/a.test.ts', runId: 'run-a' }], [
    { eventId: 'start', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-started', pid: 101 },
    { eventId: 'future-event', runId: 'run-a', sourceFile: 'test/a.test.ts', type: 'child-exited' as never, pid: 101 },
  ]);
  expect(result.ok).toBe(false);
  expect(result.findings).toContain('unknown child event type child-exited test/a.test.ts run=run-a');
  expect(result.findings).toContain('test/a.test.ts run=run-a: expected 1 child close, got 0');
});
