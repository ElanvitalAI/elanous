// DECISION-TO-BUS-AUTO — the pure halves of kit/decision-bus (the full path is the sim scene DECISION-BUS-TWO-SOURCES).
// Expectations are independent literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBus } from '../../op-context-bus/bus.js';
import type { DecisionEntry } from '../../decisions/decision-ledger.js';
import { changeLogRows, crownRecordInput, decisionBusPolicyOf, decisionPointer, docRowPointer, newChangeLogRows, pointDecisionToBus, unreadDecisionCard } from './index.js';

const MD = [
  '# Plan', '', '| 표 | 아님 |', '|---|---|', '| not | a log |', '',
  '## 8b. 변경 이력 (11-28)', '', '| 시각 | 무엇 | 왜(\u{1F451} 원문) |', '|---|---|---|', '| 19:1x | 문서 먼저 | «문서 먼저» |', '| 19:2x | 공개 웹 원장 하나 | «WEB-DEPLOY-ONE-PLACE» |', '',
  '```', '| 19:9x | fenced | «no» |', '```',
  '### 세부', '- 하위 절도 이력 안', '',
  '## 9. 칸 지도', '| 칸 | 주인 |', '|---|---|', '| X | OP |',
  '## Change log', '- 2026-11-07 — RFC 신설', '  - indented continuation',
].join('\n');

const decided = (over: Partial<DecisionEntry> = {}): DecisionEntry => ({
  id: 'D-20261128-07', title: '인프라 칸 주인', category: 'scope', scqa: { s: 's', c: 'c' },
  options: [{ key: 'a', label: 'TC 로', consequence: 'x' }, { key: 'b', label: 'MK 로', consequence: 'y' }], recommendation: { option: 'a', why: 'w' },
  raisedBy: { agent: 'OP' }, status: 'decided', choice: 'a', note: 'MK 는 문서 전담', decidedAt: '2026-11-28T11:00:00.000Z',
  decidedBy: { kind: 'human', via: 'telegram' }, history: [], ...over,
});

describe('change-log rows', () => {
  test('only rows under a 변경 이력 / Change log heading · fenced and other tables skipped · sub-heading keeps the log open · top-level bullets', () => {
    expect(changeLogRows('docs/conductor/P.md', MD).map((r) => r.cells.join(' | '))).toEqual([
      '19:1x | 문서 먼저 | «문서 먼저»', '19:2x | 공개 웹 원장 하나 | «WEB-DEPLOY-ONE-PLACE»', '하위 절도 이력 안', '2026-11-07 — RFC 신설',
    ]);
  });
  test('new rows = rows the parent did not hold', () => {
    const before = MD.replace('| 19:2x | 공개 웹 원장 하나 | «WEB-DEPLOY-ONE-PLACE» |\n', '');
    expect(newChangeLogRows('docs/conductor/P.md', before, MD).map((r) => r.cells[0])).toEqual(['19:2x']);
    expect(newChangeLogRows('docs/conductor/P.md', MD, MD)).toEqual([]);
  });
  test('row pointer: the \u{1F451} column is the quote · the rest is the summary · key = doc ⊕ row hash', () => {
    const row = changeLogRows('docs/conductor/P.md', MD)[0]!;
    const p = docRowPointer(row, 'abcdef0123456789abcdef0123456789abcdef01', 'OP');
    expect(p.owner).toBe('OP');
    expect(p.body).toBe('\u{1F451} 결정(문서 이력) · 19:1x · 문서 먼저 · «문서 먼저» · 정본 docs/conductor/P.md §8b. 변경 이력 (11-28) @abcdef012345');
    expect(p.key).toBe(`doc:docs/conductor/P.md#${row.hash}`);
    expect(p.type).toBe('decision');
  });
});

describe('ledger pointer', () => {
  test('a decided card → one pointer · open / historical import → none', () => {
    expect(decisionPointer(decided(), 'OP')!.body).toBe('\u{1F451} 결정 D-20261128-07 · 인프라 칸 주인 → a: TC 로 · \u{1F451} 직접(telegram) · «MK 는 문서 전담» · 정본 eln decisions show D-20261128-07');
    expect(decisionPointer(decided({ status: 'open' }), 'OP')).toBeNull();
    expect(decisionPointer(decided({ decidedBy: { kind: 'imported', source: 'markdown D1' } }), 'OP')).toBeNull();
  });
  test('idempotent by decision id', () => {
    const root = mkdtempSync(join(tmpdir(), 'decision-bus-'));
    try {
      expect(pointDecisionToBus(root, decided(), 'HQ', 'OP', Date.parse('2026-11-28T11:00:00Z'))!.kind).toBe('posted');
      expect(pointDecisionToBus(root, decided(), 'HQ', 'OP', Date.parse('2026-11-28T11:05:00Z'))!.kind).toBe('duplicate');
      expect(readBus(root, 'HQ')).toHaveLength(1);
      expect(unreadDecisionCard(root, { space: 'HQ', reader: 'OP', unreadH: 24 }, Date.parse('2026-11-28T12:00:00Z'))).toBeNull();
      expect(unreadDecisionCard(root, { space: 'HQ', reader: 'OP', unreadH: 24 }, Date.parse('2026-11-29T12:00:00Z'))!.ids).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('crown record + policy', () => {
  test('crown fields: words in the note · canon in scqa.a · one ref per words · SCQA stops dropped', () => {
    const r = crownRecordInput({ summary: 'MK 는 문서 P0 전담. 인프라는 TC.', quote: 'MK 는 문서만 하세요. 인프라 주지 마세요. 세 번째.', at: '2026-11-28T10:10:00.000Z', doc: 'docs/conductor/X.md §8b', seat: 'OP' });
    expect(r.note).toBe('MK 는 문서만 하세요. 인프라 주지 마세요. 세 번째.');
    expect(r.source).toBe('ceo-relay:OP');
    expect(r.input.scqa).toEqual({ s: 'MK 는 문서 P0 전담 인프라는 TC', c: '\u{1F451} 원문 «MK 는 문서만 하세요 인프라 주지 마세요 세 번째»', a: '정본 docs/conductor/X.md §8b' });
    expect(r.ref).toBe(crownRecordInput({ summary: 'other', quote: 'MK 는 문서만 하세요. 인프라 주지 마세요. 세 번째.', at: '2026-11-28T11:00:00.000Z', seat: 'OP' }).ref);
    expect(() => crownRecordInput({ summary: 's', quote: ' ', at: '2026-11-28T10:10:00.000Z', seat: 'OP' })).toThrow('--quote');
  });
  test('policy: every number from the node input · a missing one is refused', () => {
    expect(decisionBusPolicyOf({ space: 'hq', reader: 'op', lookback_h: 24, unread_h: 24, max_per_tick: 40, ref: 'origin/main', docs: 'docs/conductor/' }))
      .toEqual({ space: 'HQ', reader: 'OP', lookbackH: 24, unreadH: 24, maxPerTick: 40, ref: 'origin/main', docs: 'docs/conductor' });
    expect(() => decisionBusPolicyOf({ space: 'HQ', reader: 'OP', lookback_h: 24, max_per_tick: 40, ref: 'origin/main', docs: 'docs/conductor' })).toThrow('unread_h');
  });
});
