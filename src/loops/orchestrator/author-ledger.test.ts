import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { AuthorLedger, type AuthorRequest } from './author-ledger.js';

const approved: AuthorRequest = {
  seat: 'MK', cellId: 'AUTHOR-PAR', version: '0.2.16', title: '첫 제목', text: '사람 문면',
  check: { verdict: 'approved', signals: [], ratio: 0 },
};
function withLedger(work: (ledger: AuthorLedger, root: string, setTime: (at: string) => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'author-ledger-'));
  let clock = '2026-10-04T00:00:00.000Z';
  const ledger = new AuthorLedger({ path: join(root, 'orchestrator', 'author-ledger.sqlite'), now: () => new Date(clock) });
  try { work(ledger, root, at => { clock = at; }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('five verbatim inputs alone determine idempotence; changed title is a new snapshot', () => withLedger(ledger => {
  const first = ledger.request(approved);
  expect(first).toMatchObject({ duplicate: false, status: 'queued-for-author', title: '첫 제목' });
  expect(ledger.request({ ...approved, check: { verdict: 'resubmit', signals: ['changed check'], ratio: 1 } }))
    .toMatchObject({ id: first.id, duplicate: true, status: 'queued-for-author', check: approved.check });
  const second = ledger.request({ ...approved, title: '바뀐 제목' });
  expect(second.id).not.toBe(first.id);
  expect(second.duplicate).toBe(false);
  for (const input of [
    { ...approved, seat: 'UX' }, { ...approved, cellId: 'B' },
    { ...approved, version: '0.2.17' }, { ...approved, text: '다른 문면' },
  ]) expect(ledger.request(input).id).not.toBe(first.id);
  expect(ledger.get(first.id).history).toHaveLength(1);
}));

test('resubmit, confirm and uncheckable snapshots are held and cannot enter authoring', () => withLedger(ledger => {
  for (const verdict of ['resubmit', 'confirm', 'uncheckable'] as const) {
    const row = ledger.request({ ...approved, text: verdict, check: { verdict, signals: [{ expression: 'bun test', reason: 'command', at: '2026-10-04T00:00:00Z' }], ratio: null } });
    expect(row.status).toBe('held');
    expect(ledger.get(row.id).check).toEqual({ verdict, signals: [{ expression: 'bun test', reason: 'command', at: '2026-10-04T00:00:00Z' }], ratio: null });
    expect(() => ledger.transition(row.id, 'queued-for-author', { by: 'MK', detail: '' })).toThrow('invalid author transition');
    expect(() => ledger.transition(row.id, 'authoring', { by: 'MK', detail: '' })).toThrow('invalid author transition');
  }
}));

test('raw title and text with backticks, newlines, emoji and whitespace survive UTF-8 round trip', () => withLedger(ledger => {
  const title = '  제목 `x` 🔥\n다음 줄  ';
  const text = '  첫 줄 `foo()`\n둘째 줄 🧪\r\n마지막  ';
  const row = ledger.request({ ...approved, title, text });
  const after = new AuthorLedger({ path: ledger.path }).get(row.id);
  expect(Buffer.from(after.title)).toEqual(Buffer.from(title));
  expect(Buffer.from(after.text)).toEqual(Buffer.from(text));
  const db = new Database(ledger.path);
  try {
    const stored = db.query('SELECT title, text FROM requests WHERE id = ?').get(row.id) as { title: string; text: string };
    expect(Buffer.from(stored.title)).toEqual(Buffer.from(title));
    expect(Buffer.from(stored.text)).toEqual(Buffer.from(text));
  } finally { db.close(); }
}));

test('only permitted transitions persist; supersession records old and new goal refs and changed text hash', () => withLedger(ledger => {
  const old = ledger.request(approved);
  expect(() => ledger.transition(old.id, 'enqueued', { by: 'MK', detail: { queueId: 'q1' } })).toThrow('invalid author transition');
  const authoring = ledger.transition(old.id, 'authoring', { by: 'MK', detail: { queueId: 'premature-q', goalRef: 'premature-goal' } });
  expect(authoring.queueId).toBeNull();
  expect(authoring.goalRef).toBeNull();
  expect(ledger.get(old.id).history.at(-1)?.detail).toEqual({});
  expect(() => ledger.transition(old.id, 'authored', { by: 'MK', detail: {} })).toThrow('goalRef is required');
  expect(ledger.get(old.id).status).toBe('authoring');
  expect(ledger.transition(old.id, 'authored', { by: 'MK', detail: { goalRef: 'goal-old', queueId: 'premature-q' } }))
    .toMatchObject({ goalRef: 'goal-old', queueId: null });
  expect(ledger.get(old.id).history.at(-1)?.detail).toEqual({ goalRef: 'goal-old' });
  expect(() => ledger.transition(old.id, 'enqueued', { by: 'MK', detail: {} })).toThrow('queueId is required');
  expect(ledger.transition(old.id, 'enqueued', { by: 'MK', detail: { queueId: 'q1', goalRef: 'unconfirmed-goal' } }))
    .toMatchObject({ goalRef: 'goal-old', queueId: 'q1' });
  expect(ledger.get(old.id).history.at(-1)?.detail).toEqual({ queueId: 'q1' });
  const changed = ledger.request({ ...approved, text: '새 문면' });
  ledger.transition(changed.id, 'authoring', { by: 'MK', detail: '' });
  ledger.transition(changed.id, 'authored', { by: 'MK', detail: { goalRef: 'goal-new' } });
  const textHash = createHash('sha256').update('새 문면').digest('hex');
  expect(() => ledger.transition(old.id, 'superseded-by-cell-change', { by: 'MK', detail: { supersededBy: 'goal-new' } })).toThrow('supersededBy and textHash are required');
  const historyBefore = ledger.get(old.id).history;
  const otherVersion = ledger.request({ ...approved, version: '0.2.17', text: '다른 판 문면' });
  ledger.transition(otherVersion.id, 'authoring', { by: 'MK', detail: '' });
  ledger.transition(otherVersion.id, 'authored', { by: 'MK', detail: { goalRef: 'goal-other-version' } });
  for (const detail of [
    { supersededBy: 'goal-other-version', textHash: createHash('sha256').update('다른 판 문면').digest('hex') },
    { supersededBy: 'goal-new', textHash: createHash('sha256').update('다른 문면').digest('hex') },
    { supersededBy: 'nonexistent-goal', textHash },
  ]) {
    expect(() => ledger.transition(old.id, 'superseded-by-cell-change', { by: 'MK', detail }))
      .toThrow('must match a changed authored snapshot');
    expect(ledger.get(old.id)).toMatchObject({ status: 'enqueued', supersededBy: null, textHash: null, history: historyBefore });
  }
  expect(ledger.transition(old.id, 'superseded-by-cell-change', { by: 'MK', detail: { supersededBy: 'goal-new', textHash } }))
    .toMatchObject({ status: 'superseded-by-cell-change', goalRef: 'goal-old', queueId: 'q1', supersededBy: 'goal-new', textHash });
  expect(ledger.get(old.id).history.map(row => row.toStatus)).toEqual([
    'queued-for-author', 'authoring', 'authored', 'enqueued', 'superseded-by-cell-change',
  ]);
  expect(ledger.get(old.id).history.at(-1)?.detail).toEqual({ supersededBy: 'goal-new', textHash });
  expect(() => ledger.transition(old.id, 'authoring', { by: 'MK', detail: '' })).toThrow('invalid author transition');
  const cancelled = ledger.request({ ...approved, cellId: 'cancelled' });
  ledger.transition(cancelled.id, 'cancelled', { by: 'MK', detail: 'retry possible' });
  expect(ledger.get(cancelled.id).history.at(-1)?.toStatus).toBe('cancelled');
  const retry = ledger.request({ ...approved, cellId: 'retry' });
  ledger.transition(retry.id, 'failed', { by: 'MK', detail: { reason: 'retry later' } });
  expect(ledger.get(retry.id).history.at(-1)).toMatchObject({ fromStatus: 'queued-for-author', toStatus: 'failed', detail: { reason: 'retry later' } });
}));

test('TPS counts distinct authored cells, depth dedupes snapshots, measured zero differs from missing evidence', () => withLedger((ledger, _, setTime) => {
  expect(ledger.metrics({ since: new Date('2026-10-04T00:00:00Z'), until: new Date('2026-10-04T00:00:10Z') })).toEqual({
    tps: { value: null, reason: '못 쟀다(원장 결손)' }, latencyMs: { value: null, reason: '못 쟀다(원장 결손)' }, depthBySeat: { value: null, reason: '못 쟀다(원장 결손)' },
  });
  const first = ledger.request(approved);
  ledger.request({ ...approved, title: '바뀐 제목' });
  const second = ledger.request({ ...approved, cellId: 'B' });
  const held = ledger.request({ ...approved, cellId: 'C', check: { verdict: 'resubmit', signals: [], ratio: null } });
  expect(held.status).toBe('held');
  expect(ledger.metrics({ since: new Date('2026-10-04T00:00:00Z'), until: new Date('2026-10-04T00:00:10Z') }))
    .toEqual({ tps: { value: 0 }, latencyMs: { value: null, reason: '못 쟀다(원장 결손)' }, depthBySeat: { value: { MK: 2 } } });
  setTime('2026-10-04T00:00:02.000Z');
  for (const row of [first, second]) {
    ledger.transition(row.id, 'authoring', { by: 'MK', detail: '' });
    ledger.transition(row.id, 'authored', { by: 'MK', detail: { goalRef: row.id } });
  }
  const measured = ledger.metrics({ since: new Date('2026-10-04T00:00:00Z'), until: new Date('2026-10-04T00:00:10Z') });
  expect(measured).toEqual({ tps: { value: 0.2 }, latencyMs: { value: 2000 }, depthBySeat: { value: { MK: 1 } } });
  ledger.transition(ledger.request({ ...approved, title: '바뀐 제목' }).id, 'authoring', { by: 'MK', detail: '' });
  const withOnlyAuthoring = ledger.metrics({ since: new Date('2026-10-04T00:00:00Z'), until: new Date('2026-10-04T00:00:10Z') });
  expect(withOnlyAuthoring.depthBySeat).toEqual({ value: { MK: 1 } });
  setTime('2026-10-04T00:00:04.000Z');
  ledger.transition(second.id, 'enqueued', { by: 'MK', detail: { queueId: 'q2' } });
  expect(ledger.metrics({ since: new Date('2026-10-04T00:00:03Z'), until: new Date('2026-10-04T00:00:13Z') }))
    .toEqual({ tps: { value: 0 }, latencyMs: { value: null, reason: '못 쟀다(원장 결손)' }, depthBySeat: { value: { MK: 1 } } });
  expect(ledger.metrics({ since: new Date('2026-10-04T00:00:05Z'), until: new Date('2026-10-04T00:00:15Z') }))
    .toEqual({ tps: { value: null, reason: '못 쟀다(원장 결손)' }, latencyMs: { value: null, reason: '못 쟀다(원장 결손)' }, depthBySeat: { value: null, reason: '못 쟀다(원장 결손)' } });
}));

test('historical depth uses the last history state before until, not the current request status', () => withLedger((ledger, _, setTime) => {
  const window = { since: new Date('2026-10-04T00:00:00Z'), until: new Date('2026-10-04T00:00:10Z') };
  const first = ledger.request(approved);
  ledger.request({ ...approved, title: '새 제목' });
  const second = ledger.request({ ...approved, cellId: 'B' });
  setTime('2026-10-04T00:00:02.000Z');
  ledger.transition(first.id, 'authoring', { by: 'MK', detail: '' });
  const before = ledger.metrics(window);
  expect(before.depthBySeat).toEqual({ value: { MK: 2 } });
  setTime('2026-10-04T00:00:10.000Z');
  ledger.transition(first.id, 'authored', { by: 'MK', detail: { goalRef: 'goal-first' } });
  ledger.transition(second.id, 'failed', { by: 'MK', detail: 'retry later' });
  expect(ledger.metrics(window)).toEqual(before);
  setTime('2026-10-04T00:00:11.000Z');
  ledger.transition(ledger.request({ ...approved, title: '새 제목' }).id, 'cancelled', { by: 'MK', detail: 'changed' });
  ledger.request({ ...approved, cellId: 'late' });
  expect(ledger.metrics(window)).toEqual(before);
  expect(ledger.metrics({ since: window.since, until: new Date('2026-10-04T00:00:12Z') }).depthBySeat)
    .toEqual({ value: { MK: 1 } });
}));

test('default ledger path follows the effective instance root without opening it', () => {
  expect(new AuthorLedger().path).toBe(join(effectiveInstanceRoot(), 'orchestrator', 'author-ledger.sqlite'));
});

test('unopenable ledger reports null rather than 0, and created file is 0600', () => withLedger((ledger, root) => {
  ledger.request(approved);
  expect(statSync(ledger.path).mode & 0o777).toBe(0o600);
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'occupied');
  const broken = new AuthorLedger({ path: join(file, 'author-ledger.sqlite') });
  expect(broken.metrics({ since: new Date('2026-10-04T00:00:00Z'), until: new Date('2026-10-04T00:00:10Z') }))
    .toEqual({ tps: { value: null, reason: '못 쟀다(원장 결손)' }, latencyMs: { value: null, reason: '못 쟀다(원장 결손)' }, depthBySeat: { value: null, reason: '못 쟀다(원장 결손)' } });
  expect(readFileSync(file, 'utf8')).toBe('occupied');
}));

test('terminal states (failed · cancelled · superseded-by-cell-change) accept no further transition and keep the replacement record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'author-ledger-terminal-'));
  try {
    const ledger = new AuthorLedger({ path: join(dir, 'ledger.sqlite') });
    const base = { seat: 'MK', cellId: 'T1', version: '0.2.16', text: '사람 말', check: { verdict: 'approved' as const, signals: [], ratio: 0 } };
    const old = ledger.request({ ...base, title: '첫 제목' });
    ledger.transition(old.id, 'authoring', { by: 'MK', detail: 'start' });
    ledger.transition(old.id, 'authored', { by: 'MK', detail: { goalRef: 'goal-old' } });
    const next = ledger.request({ ...base, title: '첫 제목', text: '바뀐 사람 말' });
    ledger.transition(next.id, 'authoring', { by: 'MK', detail: 'start' });
    ledger.transition(next.id, 'authored', { by: 'MK', detail: { goalRef: 'goal-new' } });
    const textHash = createHash('sha256').update('바뀐 사람 말', 'utf8').digest('hex');
    ledger.transition(old.id, 'superseded-by-cell-change', { by: 'MK', detail: { supersededBy: 'goal-new', textHash } });
    for (const to of ['failed', 'cancelled', 'authoring'] as const) {
      expect(() => ledger.transition(old.id, to, { by: 'MK', detail: { reason: 'late' } })).toThrow('invalid author transition');
    }
    expect(ledger.get(old.id)).toMatchObject({ status: 'superseded-by-cell-change' });
    expect(ledger.get(old.id).history.at(-1)).toMatchObject({ toStatus: 'superseded-by-cell-change', detail: { supersededBy: 'goal-new', textHash } });
    const cancelled = ledger.request({ ...base, cellId: 'T2', title: 't2' });
    ledger.transition(cancelled.id, 'cancelled', { by: 'MK', detail: 'stop' });
    expect(() => ledger.transition(cancelled.id, 'failed', { by: 'MK', detail: { reason: 'x' } })).toThrow('invalid author transition');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
