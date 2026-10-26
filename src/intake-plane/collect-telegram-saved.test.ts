import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectTelegramSaved, diagnoseSavedCollect, readSavedCursor, renderCollectTelegramSavedResult, savedMessageToRaws,
  type FetchSavedMessages, type SavedMessage,
} from './collect-telegram-saved.js';
import { ingestIntakeItems, listIntakeItems, markIntakeItem } from './items.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), 'intake-tg-zero-')); roots.push(r); return r; };

/** 커서를 사흘 0 직전의 실제 값(8959)으로 심는다 — telegram-saved.cursor.json 형식은 그대로. */
function seedCursor(r: string, lastId: number): void {
  mkdirSync(join(r, 'intake'), { recursive: true });
  writeFileSync(join(r, 'intake', 'telegram-saved.cursor.json'), JSON.stringify({ lastId, at: '2026-10-21T00:00:00.000Z' }) + '\n');
}

const msg = (id: number, text: string, urls: string[] = []): SavedMessage => ({ id, date: '2026-10-24T00:00:00.000Z', text, urls });
const fake = (all: SavedMessage[]): FetchSavedMessages & { calls: [number, number][] } => {
  const calls: [number, number][] = [];
  const f = (async (minId: number, limit: number) => { calls.push([minId, limit]); return all.filter((m) => m.id > minId).slice(0, limit); }) as FetchSavedMessages & { calls: [number, number][] };
  f.calls = calls;
  return f;
};

test('TG-SAVED-ZERO: 커서는 8959→9092 로 전진했는데 원장 입력 0 — 필터로 버린 수를 따로 센다', async () => {
  const r = root();
  seedCursor(r, 8959);
  const res = await collectTelegramSaved(r, fake([msg(9060, '   '), msg(9080, ''), msg(9092, '')]), { max: 300 });

  expect(res).toMatchObject({ cursorBefore: 8959, cursorAfter: 9092, messages: 3, droppedByFilter: 3, raws: 0, dryRun: false });
  expect(res.ingest).toMatchObject({ shaped: 0, added: 0, merged: 0, seen: 0, skipped: 0 });
  // 「메시지 3」과 「원장 입력 0」은 다른 축이다 — 커서는 원장 입력과 독립으로 전진한다.
  expect(readSavedCursor(r)).toBe(9092);
  expect(listIntakeItems(r)).toHaveLength(0);
  expect(diagnoseSavedCollect(res)).toBe('filtered-out');

  const text = renderCollectTelegramSavedResult(res);
  expect(text).toContain('읽음 3');
  expect(text).toContain('필터로 버림 3');
  expect(text).toContain('원장 입력 0');
  expect(text).toContain('커서 8959 → 9092');
  expect(text).toContain('필터 때문이다');
  expect(text).not.toContain('다른 주체');
});

test('TG-SAVED-ZERO: 원장 입력은 있는데 새 것 0 — 다른 주체(queue)가 이미 가져간 것으로 갈린다', async () => {
  const r = root();
  seedCursor(r, 8959);
  ingestIntakeItems(r, 'telegram-saved', [{ url: 'https://example.com/taken', observedAt: '2026-10-22T00:00:00.000Z' }]);
  const id = listIntakeItems(r).find((item) => item.url === 'https://example.com/taken')!.id;
  markIntakeItem(r, id, { status: 'absorbed', output: { kind: 'note', ref: '/notes/taken.md' } });

  const res = await collectTelegramSaved(r, fake([msg(9092, 'https://example.com/taken')]), { max: 300 });
  expect(res).toMatchObject({ cursorBefore: 8959, cursorAfter: 9092, messages: 1, droppedByFilter: 0, raws: 1 });
  expect(res.ingest).toMatchObject({ added: 0, merged: 0, seen: 1 });
  expect(diagnoseSavedCollect(res)).toBe('already-consumed');

  const text = renderCollectTelegramSavedResult(res);
  expect(text).toContain('이미 끝난 것 1');
  expect(text).toContain('새 0');
  expect(text).toContain('다른 주체');
  expect(text).not.toContain('필터 때문이다');
});

test('TG-SAVED-ZERO: 커서 이후 새 저장 메시지가 없으면 그 까닭을 «새 메시지 없음»으로 따로 말한다', async () => {
  const r = root();
  seedCursor(r, 8959);
  // minId 배타 — 8959 이하의 옛 메시지는 다시 오지 않는다.
  const res = await collectTelegramSaved(r, fake([msg(8959, 'https://example.com/old')]), { max: 300 });
  expect(res).toMatchObject({ cursorBefore: 8959, cursorAfter: 8959, messages: 0, droppedByFilter: 0, raws: 0 });
  expect(diagnoseSavedCollect(res)).toBe('no-new-messages');
  expect(renderCollectTelegramSavedResult(res)).toContain('커서는 이미 다른 주체가 넘겼을 수 있다');
});

test('TG-SAVED-ZERO: 판정: 대표가 저장한 메시지 1건이 다음 흡수에 들어감 — 칸 문면의 판정선을 시험필요하면 실물', async () => {
  const r = root();
  seedCursor(r, 8959);
  const all: SavedMessage[] = [msg(9060, ''), msg(9092, '')];

  // 첫 흡수 — 커서만 9092 로 움직이고 원장 입력은 0(필터).
  const first = await collectTelegramSaved(r, fake(all), { max: 300 });
  expect(first).toMatchObject({ cursorBefore: 8959, cursorAfter: 9092, messages: 2, droppedByFilter: 2, raws: 0 });
  expect(readSavedCursor(r)).toBe(9092);

  // 대표가 그 뒤에 저장한 메시지 1건 — 다음 흡수가 원장에 실제로 넣는다.
  all.push(msg(9093, '판정선 링크 https://example.com/judged'));
  const next = await collectTelegramSaved(r, fake(all), { max: 300 });
  expect(next).toMatchObject({ cursorBefore: 9092, cursorAfter: 9093, messages: 1, droppedByFilter: 0, raws: 1 });
  expect(next.ingest).toMatchObject({ shaped: 1, added: 1, merged: 0, seen: 0, skipped: 0 });
  expect(diagnoseSavedCollect(next)).toBe('new-items');

  const landed = listIntakeItems(r);
  expect(landed).toHaveLength(1);
  expect(landed[0]).toMatchObject({
    url: 'https://example.com/judged', source: 'telegram-saved', sources: ['telegram-saved'],
    kind: 'article', privacy: 'user-private', status: 'new', text: '판정선 링크',
  });
  expect(readSavedCursor(r)).toBe(9093);

  // 원장은 덧붙이기만 하는 한 줄 JSONL · 커서 파일 모양도 그대로.
  const lines = readFileSync(join(r, 'intake', 'items.jsonl'), 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).id).toBe(landed[0]!.id);
  const cursorFile = JSON.parse(readFileSync(join(r, 'intake', 'telegram-saved.cursor.json'), 'utf8'));
  expect(Object.keys(cursorFile).sort()).toEqual(['at', 'lastId']);
  expect(cursorFile.lastId).toBe(9093);
});

test('TG-SAVED-ZERO: minId 배타 · dry-run 무쓰기 · max 계약은 그대로다', async () => {
  const r = root();
  seedCursor(r, 8959);
  const f = fake([msg(9060, 'https://example.com/a'), msg(9092, 'https://example.com/b')]);
  const dry = await collectTelegramSaved(r, f, { max: 7, dryRun: true });
  // minId 배타 = id > minId — fetch 는 커서 값을 그대로 받는다.
  expect(f.calls).toEqual([[8959, 7]]);
  expect(dry).toMatchObject({ messages: 2, droppedByFilter: 0, raws: 2, dryRun: true });
  expect(dry.ingest).toBeUndefined();
  expect(readSavedCursor(r)).toBe(8959);
  expect(listIntakeItems(r)).toHaveLength(0);
  expect(renderCollectTelegramSavedResult(dry)).toContain('dry-run');

  // savedMessageToRaws 계약: 링크마다 한 줄 · 링크 없는 메모는 note 한 줄 · 빈 메시지는 0줄.
  expect(savedMessageToRaws(msg(1, '메모 https://example.com/a https://example.com/b'))).toHaveLength(2);
  expect(savedMessageToRaws(msg(2, '메모만'))).toEqual([{ text: '메모만', kind: 'note', observedAt: '2026-10-24T00:00:00.000Z' }]);
  expect(savedMessageToRaws(msg(3, ''))).toEqual([]);
});
