import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerIntakeCommands } from '../src/cli/intake-cli.js';
import {
  canonicalUrl, ingestIntakeItems, intakeItemId, intakeLedgerDir, listIntakeItems, loadIntakeLedger, markIntakeItem, pickAbsorbQueue, shapeIntakeItem,
} from '../src/intake-plane/items.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), 'intake-items-')); roots.push(r); return r; };
const quiet = () => {};

test('같은 대상의 다른 URL 모양은 한 정규 URL 이 된다', () => {
  const yt = 'https://www.youtube.com/watch?v=D-Z5HnLW_ho';
  expect(canonicalUrl('https://youtu.be/D-Z5HnLW_ho?si=abc')).toBe(yt);
  expect(canonicalUrl('https://m.youtube.com/shorts/D-Z5HnLW_ho')).toBe(yt);
  expect(canonicalUrl('https://www.youtube.com/watch?v=D-Z5HnLW_ho&t=30&feature=share')).toBe(yt);
  expect(canonicalUrl('https://twitter.com/someone/status/12345?s=20')).toBe('https://x.com/i/status/12345');
  expect(canonicalUrl('https://github.com/Owner/Repo.git')).toBe('https://github.com/owner/repo');
  expect(canonicalUrl('https://github.com/owner/repo/tree/main/src')).toBe('https://github.com/owner/repo');
  expect(canonicalUrl('https://www.example.com/a/?utm_source=x&b=2&a=1#frag')).toBe('https://example.com/a?a=1&b=2');
  expect(canonicalUrl('not a url')).toBeUndefined();
  expect(canonicalUrl('ftp://example.com/x')).toBeUndefined();
});

test('id 는 정규 URL 에서 나온다 · URL 이 없으면 입력원 ⊕ 본문', () => {
  expect(intakeItemId('x', { url: 'https://youtu.be/D-Z5HnLW_ho' })).toBe(intakeItemId('youtube', { url: 'https://www.youtube.com/watch?v=D-Z5HnLW_ho' }));
  expect(intakeItemId('memo', { text: '읽어 볼 것' })).not.toBe(intakeItemId('telegram-saved', { text: '읽어 볼 것' }));
});

test('개인 메모 입력원은 user-private 이고 URL·본문이 없으면 버린다', () => {
  const now = '2026-09-26T00:00:00.000Z';
  expect(shapeIntakeItem('telegram-saved', { text: '메모' }, now)?.privacy).toBe('user-private');
  expect(shapeIntakeItem('youtube', { url: 'https://youtu.be/D-Z5HnLW_ho' }, now)?.privacy).toBe('public');
  expect(shapeIntakeItem('youtube', { url: 'https://youtu.be/D-Z5HnLW_ho' }, now)?.kind).toBe('video');
  expect(shapeIntakeItem('x', {}, now)).toBeNull();
});

test('같은 항목이 다시 오면 새로 만들지 않고 신호·입력원을 합친다', () => {
  const r = root();
  const url = 'https://www.youtube.com/watch?v=D-Z5HnLW_ho';
  expect(ingestIntakeItems(r, 'youtube', [{ url, signals: { vph: 100 } }], '2026-09-25T00:00:00.000Z', quiet)).toMatchObject({ added: 1, merged: 0 });
  expect(ingestIntakeItems(r, 'x', [{ url: 'https://youtu.be/D-Z5HnLW_ho', signals: { likes: 50 } }], '2026-09-26T00:00:00.000Z', quiet)).toMatchObject({ added: 0, merged: 1 });
  const items = listIntakeItems(r);
  expect(items).toHaveLength(1);
  expect(items[0].sources).toEqual(['youtube', 'x']);
  expect(items[0].signals).toEqual({ 'youtube.vph': 100, 'x.likes': 50 });
  expect(items[0].observedAt).toBe('2026-09-25T00:00:00.000Z');
});

test('흡수가 끝난 것은 다시 와도 «seen» — 상태를 되돌리지 않는다', () => {
  const r = root();
  const url = 'https://github.com/owner/repo';
  ingestIntakeItems(r, 'github', [{ url }], undefined, quiet);
  const id = listIntakeItems(r)[0].id;
  expect(markIntakeItem(r, id, { status: 'absorbed', output: { kind: 'note', ref: 'note.md' } })).toBe(true);
  expect(ingestIntakeItems(r, 'github', [{ url, signals: { stars: 10 } }], undefined, quiet)).toMatchObject({ seen: 1, merged: 0, added: 0 });
  const item = listIntakeItems(r)[0];
  expect(item.status).toBe('absorbed');
  expect(item.outputs).toEqual([{ kind: 'note', ref: 'note.md' }]);
  expect(markIntakeItem(r, 'nope', { status: 'absorbed' })).toBe(false);
});

test('한 번이라도 개인 입력원에서 왔으면 공개로 풀리지 않는다', () => {
  const r = root();
  const url = 'https://example.com/post';
  ingestIntakeItems(r, 'telegram-saved', [{ url }], undefined, quiet);
  ingestIntakeItems(r, 'x', [{ url }], undefined, quiet);
  expect(listIntakeItems(r)[0].privacy).toBe('user-private');
});

test('깨진 원장 줄은 건너뛰고 센다', () => {
  const r = root();
  ingestIntakeItems(r, 'x', [{ url: 'https://x.com/a/status/1' }], undefined, quiet);
  appendFileSync(join(intakeLedgerDir(r), 'items.jsonl'), '{broken\n');
  const { items, badLines } = loadIntakeLedger(r);
  expect(items.size).toBe(1);
  expect(badLines).toBe(1);
});

test('자동 흡수 대기열: 사용자가 남긴 것 먼저 · 점수 순 · 상한 · 고른 것은 queued 로 다시 안 고른다', () => {
  const r = root();
  ingestIntakeItems(r, 'youtube', [
    { url: 'https://youtu.be/aaaaaaaaaaa', signals: { score: 5 } },
    { url: 'https://youtu.be/bbbbbbbbbbb', signals: { score: 9 } },
    { url: 'https://youtu.be/ccccccccccc', signals: { score: 1 } },
  ], undefined, quiet);
  ingestIntakeItems(r, 'telegram-saved', [{ url: 'https://youtu.be/ddddddddddd' }, { text: '메모만' }], undefined, quiet);
  ingestIntakeItems(r, 'github', [{ url: 'https://github.com/a/b', signals: { score: 100 } }], undefined, quiet);
  const dry = pickAbsorbQueue(r, { max: 2, kind: 'video', dryRun: true });
  expect(dry.map((i) => i.url)).toEqual(['https://www.youtube.com/watch?v=ddddddddddd', 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'https://www.youtube.com/watch?v=aaaaaaaaaaa']);
  expect(listIntakeItems(r, { status: 'queued' })).toHaveLength(0);
  const first = pickAbsorbQueue(r, { max: 2, kind: 'video' });
  expect(first).toHaveLength(3);
  expect(listIntakeItems(r, { status: 'queued' })).toHaveLength(3);
  expect(pickAbsorbQueue(r, { max: 3, kind: 'video' }).map((i) => i.url)).toEqual(['https://www.youtube.com/watch?v=ccccccccccc']);
});

test('텔레그램 저장 레인은 일반 상한 밖 · 레인 상한 별도 · 저장이 없으면 일반 상한 그대로', () => {
  const r = root();
  const saved = Array.from({ length: 12 }, (_, n) => ({ url: `https://example.com/saved/${n}` }));
  const x = Array.from({ length: 12 }, (_, n) => ({ url: `https://x.com/example/status/${n + 100}` }));
  ingestIntakeItems(r, 'telegram-saved', saved, '2026-09-27T00:00:00.000Z', quiet);
  ingestIntakeItems(r, 'x', x, '2026-09-27T00:00:00.000Z', quiet);

  const defaultLane = pickAbsorbQueue(r, { max: 10, dryRun: true });
  expect(defaultLane).toHaveLength(22);
  expect(defaultLane.slice(0, 12).every((i) => i.sources.includes('telegram-saved'))).toBe(true);
  expect(defaultLane.slice(12).every((i) => i.source === 'x')).toBe(true);

  const limitedLane = pickAbsorbQueue(r, { max: 10, laneMax: 5, dryRun: true });
  expect(limitedLane).toHaveLength(15);
  expect(limitedLane.slice(0, 5).every((i) => i.sources.includes('telegram-saved'))).toBe(true);
  expect(limitedLane.slice(5).every((i) => i.source === 'x')).toBe(true);

  const xOnly = root();
  ingestIntakeItems(xOnly, 'x', x, '2026-09-27T00:00:00.000Z', quiet);
  expect(pickAbsorbQueue(xOnly, { max: 10 })).toHaveLength(10);

  const manySaved = root();
  ingestIntakeItems(manySaved, 'telegram-saved', Array.from({ length: 32 }, (_, n) => ({ url: `https://example.com/more-saved/${n}` })), '2026-09-27T00:00:00.000Z', quiet);
  expect(pickAbsorbQueue(manySaved, { max: 10, dryRun: true })).toHaveLength(30);
});

test('memo 는 일반 몫 앞자리이고, 저장 링크가 뒤늦게 합쳐져도 레인이다', () => {
  const r = root();
  ingestIntakeItems(r, 'x', [
    { url: 'https://x.com/example/status/200' },
    { url: 'https://x.com/example/status/201' },
  ], '2026-09-27T00:00:00.000Z', quiet);
  ingestIntakeItems(r, 'telegram-saved', [{ url: 'https://x.com/example/status/200' }], '2026-09-27T00:00:01.000Z', quiet);
  ingestIntakeItems(r, 'memo', [{ url: 'https://example.com/memo' }], '2026-09-27T00:00:00.000Z', quiet);
  const picked = pickAbsorbQueue(r, { max: 1, dryRun: true });
  expect(picked.map((i) => i.url)).toEqual(['https://x.com/i/status/200', 'https://example.com/memo']);
});

test('intake queue CLI 는 일반 상한과 별도로 --lane-max 를 받는다', () => {
  const program = new Command();
  registerIntakeCommands(program);
  const queue = program.commands.find((c) => c.name() === 'intake')?.commands.find((c) => c.name() === 'queue');
  expect(queue?.options.map((o) => o.long)).toContain('--max');
  expect(queue?.options.map((o) => o.long)).toContain('--lane-max');
});

test('queued 로 하루 넘게 묶인 항목(흡수 도중 죽은 판)은 다시 고른다', () => {
  const r = root();
  ingestIntakeItems(r, 'youtube', [{ url: 'https://youtu.be/eeeeeeeeeee' }], '2026-09-20T00:00:00.000Z', quiet);
  expect(pickAbsorbQueue(r, { max: 5 }, '2026-09-20T01:00:00.000Z')).toHaveLength(1);
  expect(pickAbsorbQueue(r, { max: 5 }, '2026-09-20T12:00:00.000Z')).toHaveLength(0);   // 아직 하루 안 됨
  expect(pickAbsorbQueue(r, { max: 5 }, '2026-09-21T02:00:00.000Z')).toHaveLength(1);   // 하루 넘음 → 다시
});
