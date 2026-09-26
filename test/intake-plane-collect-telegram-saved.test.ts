import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectTelegramSaved, readSavedCursor, savedMessageToRaws, type FetchSavedMessages, type SavedMessage,
} from '../src/intake-plane/collect-telegram-saved.js';
import { listIntakeItems } from '../src/intake-plane/items.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), 'intake-tg-')); roots.push(r); return r; };

const msg = (id: number, text: string, urls: string[] = []): SavedMessage => ({ id, date: `2026-09-2${id % 10}T00:00:00.000Z`, text, urls });
const fake = (all: SavedMessage[]): FetchSavedMessages & { calls: [number, number][] } => {
  const calls: [number, number][] = [];
  const f = (async (minId: number, limit: number) => { calls.push([minId, limit]); return all.filter((m) => m.id > minId).slice(0, limit); }) as FetchSavedMessages & { calls: [number, number][] };
  f.calls = calls;
  return f;
};

test('링크마다 한 줄 · 메모 문장은 text 로 · 링크 없는 메모는 note 한 줄', () => {
  expect(savedMessageToRaws(msg(1, '나중에 볼 것 https://youtu.be/D-Z5HnLW_ho.'))).toEqual([
    { url: 'https://youtu.be/D-Z5HnLW_ho', text: '나중에 볼 것', observedAt: '2026-09-21T00:00:00.000Z' },
  ]);
  expect(savedMessageToRaws(msg(2, '', ['https://github.com/a/b', 'https://github.com/a/b']))).toHaveLength(1);
  expect(savedMessageToRaws(msg(3, '에이전트 하니스 아이디어 메모'))).toEqual([{ text: '에이전트 하니스 아이디어 메모', kind: 'note', observedAt: '2026-09-23T00:00:00.000Z' }]);
  expect(savedMessageToRaws(msg(4, '   '))).toEqual([]);
});

test('커서 이후만 읽고, 두 번 돌려도 새 항목이 없다', async () => {
  const r = root();
  const all = [msg(10, 'a https://example.com/1'), msg(11, 'b https://example.com/2'), msg(12, '메모만')];
  const f = fake(all);
  const first = await collectTelegramSaved(r, f, { max: 50 });
  expect(first).toMatchObject({ cursorBefore: 0, cursorAfter: 12, messages: 3, raws: 3 });
  expect(first.ingest).toMatchObject({ added: 3 });
  expect(readSavedCursor(r)).toBe(12);
  const second = await collectTelegramSaved(r, f, { max: 50 });
  expect(second).toMatchObject({ cursorBefore: 12, cursorAfter: 12, messages: 0 });
  expect(f.calls).toEqual([[0, 50], [12, 50]]);
  expect(listIntakeItems(r)).toHaveLength(3);
});

test('쌓인 메시지는 max 개씩 따라잡는다', async () => {
  const r = root();
  const f = fake([1, 2, 3, 4, 5].map((i) => msg(i, `m https://example.com/${i}`)));
  await collectTelegramSaved(r, f, { max: 2 });
  expect(readSavedCursor(r)).toBe(2);
  await collectTelegramSaved(r, f, { max: 2 });
  expect(readSavedCursor(r)).toBe(4);
});

test('원장 항목은 user-private 이다', async () => {
  const r = root();
  await collectTelegramSaved(r, fake([msg(1, '볼 것 https://example.com/x')]), { max: 10 });
  expect(listIntakeItems(r).every((i) => i.privacy === 'user-private' && i.source === 'telegram-saved')).toBe(true);
});

test('dry-run 은 원장·커서를 바꾸지 않는다', async () => {
  const r = root();
  const res = await collectTelegramSaved(r, fake([msg(1, 'https://example.com/x')]), { max: 10, dryRun: true });
  expect(res).toMatchObject({ messages: 1, raws: 1, dryRun: true });
  expect(res.ingest).toBeUndefined();
  expect(readSavedCursor(r)).toBe(0);
  expect(listIntakeItems(r)).toHaveLength(0);
});

test('⛔ 읽기 모듈은 보내기·지우기 경로를 쓰지 않는다', () => {
  const src = readFileSync(join(import.meta.dir, '../src/intake-plane/collect-telegram-saved.ts'), 'utf8');
  for (const forbidden of ['sendMessage', 'sendFile', 'deleteMessages', 'forwardMessages', 'editMessage', 'invoke(', 'Api.']) {
    expect(src.includes(forbidden)).toBe(false);
  }
  expect(src).toContain("getMessages('me'");
});
