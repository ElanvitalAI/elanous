// TG-SAVED-ZERO 무대 — save(me) 대화의 가짜 저장 메시지로 흡수 경로를 세 번 지난다.
// ① 다른 주체가 이미 흡수한 판 · ② 사흘 0 관측 그대로(필터로 비어 커서만 전진) · ③ 판정선(저장 1건이 다음 흡수에 원장으로).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTelegramSaved, readSavedCursor, renderCollectTelegramSavedResult, savedMessageToRaws, type SavedMessage } from '../src/intake-plane/collect-telegram-saved.js';
import { ingestIntakeItems, listIntakeItems, markIntakeItem, pickAbsorbQueue } from '../src/intake-plane/items.js';

const root = mkdtempSync(join(tmpdir(), 'tg-saved-zero-'));
const saved: SavedMessage[] = [
  { id: 8959, date: '2026-10-22T00:05:00.000Z', text: 'https://example.com/first 메모', urls: [] },
  { id: 8975, date: '2026-10-23T00:05:00.000Z', text: '', urls: [] },
  { id: 9092, date: '2026-10-24T00:05:00.000Z', text: '   ', urls: [] },
  { id: 9200, date: '2026-10-25T00:05:00.000Z', text: 'https://example.com/next 다음 것', urls: [] },
];

// 대표가 텔레그램에서 «저장한» 목록의 창 — 지금 창 안의 메시지만 fetch 가 돌려준다.
let visibleUpTo = 8959;
const fetchSaved = async (minId: number) => saved.filter((m) => m.id > minId && m.id <= visibleUpTo);
const run = (max = 300) => collectTelegramSaved(root, fetchSaved, { max });

// ① 다른 주체(queue)가 8959 를 먼저 가져가 흡수까지 끝낸 판 — collect 는 «이미 끝난 것» 만 본다.
ingestIntakeItems(root, 'telegram-saved', savedMessageToRaws(saved[0]!));
for (const item of pickAbsorbQueue(root, { max: 10, laneMax: 30 })) markIntakeItem(root, item.id, { status: 'absorbed' });
const consumed = await run();
console.log('=== ① 같은 항목을 다른 주체(queue)가 먼저 흡수한 판 — «원장 입력 있음 · 새 0»');
console.log(renderCollectTelegramSavedResult(consumed));

// ② 사흘 0 의 관측 그대로 — 커서는 8959→9092 로 전진했는데 원장 입력 0(빈 메시지가 필터에 걸림)
visibleUpTo = 9092;
const filtered = await run();
console.log('=== ② 사흘 0 관측 그대로 — 커서만 8959 → 9092 로 전진 · 원장 입력 0');
console.log(renderCollectTelegramSavedResult(filtered));
console.log(`   (원장 줄 수 ${listIntakeItems(root).length} — 그대로)`);

// ③ 판정 — 대표가 저장한 다음 메시지 1건(id 9200)이 다음 흡수에 원장으로 들어간다
visibleUpTo = 9200;
const next = await run();
console.log('=== ③ 판정 — 대표가 저장한 메시지 1건(id 9200)이 다음 흡수에 원장으로 들어감');
console.log(renderCollectTelegramSavedResult(next));

const links = listIntakeItems(root).map((i) => i.url);
console.log(`\n[ledger] 원장 링크 ${JSON.stringify(links)} · 커서 ${readSavedCursor(root)}`);
const ok = filtered.raws === 0 && filtered.cursorAfter === 9092 && filtered.messages === 2
  && (next.ingest?.added ?? 0) === 1 && links.filter((u) => u === 'https://example.com/next').length === 1
  && consumed.ingest?.seen === 1;
console.log(ok ? '[verdict] 판정선 통과 — 저장 메시지 1건이 다음 흡수에 원장으로 들어갔다' : '[verdict] 판정선 실패');
process.exitCode = ok ? 0 : 1;
