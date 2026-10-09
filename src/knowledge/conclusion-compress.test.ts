import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, listChecklist } from '../release-loop/checklist.js';
import { compressConclusions, type ConclusionBatch } from './conclusion-compress.js';

const roots: string[] = [];
afterEach(() => { resetElanousConfigDir(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-compress-'));
  roots.push(dir);
  setElanousConfigDir(dir);
  addItem('0.2.17', { id: 'KNOW-COMPRESS', title: '압축' });
  addItem('0.2.17', { id: 'NEXT', title: '다음' });
  return dir;
}
const body = '원본 회의 글 문맥과 토론을 보존한다. '.repeat(150);
function batch(): ConclusionBatch {
  return { version: '0.2.17', day: '2026-10-04', records: [
    { source: 'channel', cell: 'KNOW-COMPRESS', kind: 'decision', conclusion: '원본은 보관하고 근거는 위로 올린다', ref: 'https://github.com/org/repo/issues/16815#issuecomment-123', createdAt: '2026-10-04T10:00:00Z', body },
    { source: 'channel', cell: 'NEXT', kind: 'evidence', conclusion: '다음 판에서 재검증한다', ref: 'https://github.com/org/repo/issues/16815#issuecomment-124', createdAt: '2026-10-04T20:00:00Z', body },
    { source: 'run-log', cell: 'KNOW-COMPRESS', kind: 'lesson', conclusion: '끝난 런에서 로그 전체를 반복해서 읽지 않는다', ref: 'self-dev-runs/run-1.json', status: 'done', body },
  ] };
}

test('one channel day and a finished run publish small cell conclusions with retraceable originals', () => {
  const dir = setup();
  const input = batch();
  const receipt = compressConclusions(input);
  expect(receipt.lines).toHaveLength(3);
  expect(receipt.conclusionBytes * 10).toBeLessThanOrEqual(receipt.originalBytes);
  expect(readFileSync(receipt.archive, 'utf8')).toBe(JSON.stringify(input));
  expect(receipt.archive.startsWith(join(dir, 'knowledge-compress/archive'))).toBe(true);
  const items = listChecklist('0.2.17').items;
  expect(items[0]?.evidence).toContain('https://github.com/org/repo/issues/16815#issuecomment-123');
  expect(items[0]?.evidence).toContain('knowledge-compress/archive/');
  expect(items[0]?.evidence).toContain('#record-3');
  expect(items[1]?.evidence).toContain('https://github.com/org/repo/issues/16815#issuecomment-124');
  compressConclusions(input);
  expect(listChecklist('0.2.17').items.map(item => item.evidence)).toEqual(items.map(item => item.evidence));
});

test('invalid links, unfinished runs, missing cells and non-compressed output leave no archive or ledger changes', () => {
  const dir = setup();
  const input = batch();
  for (const invalid of [
    { ...input, records: input.records.map((r, i) => i === 0 ? { ...r, createdAt: '2026-10-05T00:00:00Z' } : r) },
    { ...input, records: input.records.map((r, i) => i === 0 ? { ...r, ref: 'https://example.com/not-a-comment' } : r) },
    { ...input, records: input.records.map((r, i) => i === 1 ? { ...r, cell: 'MISSING' } : r) },
    { ...input, records: input.records.map((r, i) => i === 2 ? { ...r, status: 'running' } : r) },
    { ...input, records: [{ ...input.records[0]!, body: 'tiny' }] },
  ]) expect(() => compressConclusions(invalid)).toThrow();
  expect(listChecklist('0.2.17').items.every(item => item.evidence === undefined)).toBe(true);
  expect(existsSync(join(dir, 'knowledge-compress'))).toBe(false);
});
