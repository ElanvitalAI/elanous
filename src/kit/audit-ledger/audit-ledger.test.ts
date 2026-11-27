// kit/audit-ledger — expectations are independent literals (no product constants reused).
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, appendAuditLine, appendAuditLineSafe, appendAuditSafe, auditRow, readAuditTail } from './index.js';

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'kit-audit-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });

test('appendAudit writes one line {schema, at, ...row} and creates missing parent dirs', () => {
  const p = join(tmp(), 'deep', 'er', 'x-audit.jsonl');
  appendAudit(p, 'demo.row/1', { kind: 'sign', subject: 'A-7' });
  const lines = readFileSync(p, 'utf8').split('\n');
  expect(lines.length).toBe(2);
  expect(lines[1]).toBe('');
  const row = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(Object.keys(row)).toEqual(['schema', 'at', 'kind', 'subject']);
  expect(row.schema).toBe('demo.row/1');
  expect(row.kind).toBe('sign');
  expect(row.subject).toBe('A-7');
  expect(typeof row.at).toBe('string');
});

test('a row that carries its own at or ts keeps it — no second clock', () => {
  expect(auditRow('s/1', { at: '2026-11-27T01:02:03.000Z', n: 1 })).toEqual({ schema: 's/1', at: '2026-11-27T01:02:03.000Z', n: 1 });
  expect(auditRow('s/1', { ts: '2026-11-27T04:05:06.000Z' })).toEqual({ schema: 's/1', ts: '2026-11-27T04:05:06.000Z' });
  expect(auditRow('s/1', { n: 2 }, new Date('2026-01-02T03:04:05.000Z'))).toEqual({ schema: 's/1', at: '2026-01-02T03:04:05.000Z', n: 2 });
});

test('appendAuditLine keeps the caller line byte-for-byte and adds a missing newline once', () => {
  const p = join(tmp(), 'line.jsonl');
  appendAuditLine(p, '{"ts":"t1","result":"denied"}\n');
  appendAuditLine(p, '{"ts":"t2","result":"executed"}');
  expect(readFileSync(p, 'utf8')).toBe('{"ts":"t1","result":"denied"}\n{"ts":"t2","result":"executed"}\n');
});

test('mode applies to a newly created ledger', () => {
  const p = join(tmp(), 'secret-audit.jsonl');
  appendAuditLine(p, '{"a":1}', { mode: 0o600 });
  expect(statSync(p).mode & 0o777).toBe(0o600);
});

test('rotation boundary: a write that would pass maxBytes moves the file to .1 first; keep caps generations', () => {
  const p = join(tmp(), 'rot.jsonl');
  // 출처: #40410 rotation fixture — a 30-byte file holds three 10-byte lines; two generations kept
  const rot = { maxBytes: 30, keep: 2 };
  const line = 'x'.repeat(9);                                   // 10 bytes with newline
  appendAuditLine(p, line, rot);
  appendAuditLine(p, line, rot);
  appendAuditLine(p, line, rot);           // exactly 30 bytes — no rotation yet
  expect(statSync(p).size).toBe(30);
  expect(existsSync(`${p}.1`)).toBe(false);
  appendAuditLine(p, 'y'.repeat(9), rot);  // would be 40 → rotate
  expect(readFileSync(p, 'utf8')).toBe('yyyyyyyyy\n');
  expect(statSync(`${p}.1`).size).toBe(30);
  for (const c of ['a', 'b', 'c']) appendAuditLine(p, c.repeat(25), rot);
  expect(readFileSync(p, 'utf8')).toBe(`${'c'.repeat(25)}\n`);
  expect(readFileSync(`${p}.1`, 'utf8')).toBe(`${'b'.repeat(25)}\n`);
  expect(readFileSync(`${p}.2`, 'utf8')).toBe(`${'a'.repeat(25)}\n`);
  expect(existsSync(`${p}.3`)).toBe(false);
});

test('maxBytes 0 never rotates (ledgers rewritten in place)', () => {
  const p = join(tmp(), 'norot.jsonl');
  for (let i = 0; i < 5; i++) appendAuditLine(p, 'z'.repeat(99), { maxBytes: 0 });
  expect(statSync(p).size).toBe(500);
  expect(existsSync(`${p}.1`)).toBe(false);
});

test('readAuditTail skips malformed, half-written and non-object lines and honours limit', () => {
  const p = join(tmp(), 'tail.jsonl');
  writeFileSync(p, '{"n":1}\nnot json\n[1,2]\n{"n":2}\n\n{"n":3}\n{"n":4');
  expect(readAuditTail(p)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  expect(readAuditTail(p, 2)).toEqual([{ n: 2 }, { n: 3 }]);
  expect(readAuditTail(join(tmp(), 'absent.jsonl'))).toEqual([]);
});

test('fail-soft writers return false on an unwritable dir; strict writers throw', () => {
  const d = tmp();
  chmodSync(d, 0o500);
  const p = join(d, 'sub', 'nope.jsonl');
  if (process.getuid?.() === 0) return;                          // root ignores modes — nothing to prove
  expect(appendAuditSafe(p, 'demo/1', { a: 1 })).toBe(false);
  expect(appendAuditLineSafe(p, '{"a":1}')).toBe(false);
  expect(() => appendAudit(p, 'demo/1', { a: 1 })).toThrow();
  expect(() => appendAuditLine(p, '{"a":1}')).toThrow();
});

test('fail-soft row writer returns false on an unserializable row instead of throwing', () => {
  const p = join(tmp(), 'cyc.jsonl');
  const row: Record<string, unknown> = { a: 1 }; row.self = row;
  expect(appendAuditSafe(p, 'demo/1', row)).toBe(false);
  expect(existsSync(p)).toBe(false);
  expect(appendAuditSafe(p, 'demo/1', { ok: true })).toBe(true);
});
