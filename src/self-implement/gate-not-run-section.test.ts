// GATE-CALLERS (OP 10-03): the PR body keeps the «caller tests not run (cap exceeded)» line even when the gate log is cut at 3000 chars.
import { expect, test } from 'bun:test';
import { gateNotRunSection } from './orchestrator.js';

test('lifts the cap-exceeded line into its own PR body section', () => {
  const log = `${'x'.repeat(5000)}\n⚠️ caller test cap exceeded — not run: test/a.test.ts (route), test/b.test.ts (import+route)\nend`;
  expect(gateNotRunSection(log)).toEqual(['', '## Gate · 안 돈 소비자 시험(상한 초과)', '- test/a.test.ts (route), test/b.test.ts (import+route)']);
});

test('no cap line → no section', () => {
  expect(gateNotRunSection('all good')).toEqual([]);
  expect(gateNotRunSection(undefined)).toEqual([]);
});
