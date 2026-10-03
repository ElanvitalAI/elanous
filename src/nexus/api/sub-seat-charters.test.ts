import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { listSubSeatCharters } from './sub-seat-charters.js';

test('임시 헌장에서 TC 하위 둘과 제목을 읽고 XX 는 무시한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'sub-seat-charters-'));
  try {
    for (const seat of ['TC', 'XX']) mkdirSync(join(root, seat));
    writeFileSync(join(root, 'TC', 'rel.md'), '# TC/rel — 릴리스·인프라 운영 하위 자리\n');
    writeFileSync(join(root, 'TC', 'docs.md'), '제목 없음\n');
    writeFileSync(join(root, 'XX', 'a.md'), '# XX/a — 무시\n');
    expect(listSubSeatCharters(root)).toEqual([
      { id: 'TC/docs', seat: 'TC', sub: 'docs', title: 'TC/docs' },
      { id: 'TC/rel', seat: 'TC', sub: 'rel', title: '릴리스·인프라 운영 하위 자리' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('헌장 루트를 못 읽으면 빈 배열과 charters-unreadable 사건', () => {
  const root = join(tmpdir(), `absent-charters-${crypto.randomUUID()}`);
  const before = debug.events(500).length;
  let unreadable = false;
  expect(listSubSeatCharters(root, () => { unreadable = true; })).toEqual([]);
  expect(unreadable).toBe(true);
  expect(debug.events(500).slice(before)).toContainEqual(expect.objectContaining({ category: 'ops.seats', event: 'charters-unreadable' }));
});
