// CEO 11-24 «불필요한 보안 강화 금지»: same UID = trusted local operator; other UIDs refused; one redacted audit line per call.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditOperator, localOperatorAllowed, LOCAL_OPERATOR_OPS } from './local-operator.js';

test('same UID is allowed with no key; a different or unknown UID is refused', () => {
  expect(localOperatorAllowed(501, 501)).toBe(true);
  expect(localOperatorAllowed(502, 501)).toBe(false);
  expect(localOperatorAllowed(0, 501)).toBe(false);
  expect(localOperatorAllowed(undefined, 501)).toBe(false);
  expect(localOperatorAllowed(501, undefined)).toBe(false);
  expect(LOCAL_OPERATOR_OPS).toEqual(['read', 'status', 'send']);
});

test('audit writes one JSON line per call with the text length, never the text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-operator-'));
  try {
    auditOperator(dir, { op: 'read', pane: 'p1', uid: 501, pid: 42, result: 'allowed' });
    auditOperator(dir, { op: 'send', pane: 'p1', uid: 501, pid: 42, chars: 12, result: 'queued' });
    const rows = readFileSync(join(dir, 'local-operator-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(({ time, ...rest }) => rest)).toEqual([
      { op: 'read', pane: 'p1', uid: 501, pid: 42, result: 'allowed' },
      { op: 'send', pane: 'p1', uid: 501, pid: 42, chars: 12, result: 'queued' },
    ]);
    // An unwritable audit directory never throws (audit is a record, not a gate).
    expect(() => auditOperator(join(dir, 'missing', 'deeper'), { op: 'status', result: 'allowed' })).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
