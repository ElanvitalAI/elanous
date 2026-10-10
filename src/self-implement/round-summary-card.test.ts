import { describe, expect, it } from 'bun:test';
import { renderRoundSummaryCard, type RoundSummaryEntry } from './round-summary-card.js';

describe('round summary card', () => {
  it('returns nothing without recorded rounds and preserves gate/review order and ids', () => {
    expect(renderRoundSummaryCard([])).toBe('');
    const card = renderRoundSummaryCard([
      { round: 1, kind: 'gate', tried: 'compile', failedIds: ['a@x (introduced)', 'b@y (unknown)'], filesTouched: ['x'] },
      { round: 2, kind: 'review', tried: 'repair', failedIds: ['MF-123'], filesTouched: ['y'] },
    ]);
    expect(card).toStartWith('[라운드 요약 카드 — 이미 해 본 수와 결과]');
    expect(card.indexOf('라운드 1 · gate')).toBeLessThan(card.indexOf('라운드 2 · review'));
    expect(card).toContain('a@x (introduced), b@y (unknown)');
    expect(card).toContain('라운드 2 · review · 해 본 수: repair · 실패 id: MF-123 · 손댄 파일: y');
  });

  it('distinguishes unmeasured from measured zero and displays optional findings only when present', () => {
    const card = renderRoundSummaryCard([
      { round: 0, kind: 'gate' },
      { round: 1, kind: 'gate', failedIds: [], filesTouched: [], premiseFindings: [] },
      { round: 2, kind: 'review', failedIds: ['MF-1'], rung: 'next', premiseFindings: ['counterexample'] },
    ]);
    expect(card).toContain('라운드 0 · gate · 해 본 수: 못 쟀다 · 실패 id: 못 쟀다 · 손댄 파일: 못 쟀다');
    expect(card).toContain('라운드 1 · gate · 해 본 수: 못 쟀다 · 실패 id: 0건 · 손댄 파일: 0건 · premiseFindings: 0건');
    expect(card).toContain('라운드 2 · review · 해 본 수: 못 쟀다 · 실패 id: MF-1 · 손댄 파일: 못 쟀다 · rung: next · premiseFindings: counterexample');
    expect(card.split('\n')[1]).not.toContain('rung:');
    expect(card.split('\n')[1]).not.toContain('premiseFindings:');
  });

  it('recognizes the last failure set in an earlier non-adjacent round regardless of order', () => {
    const entries: RoundSummaryEntry[] = [
      { round: 1, kind: 'gate', failedIds: ['b', 'a'] },
      { round: 2, kind: 'gate', failedIds: ['c'] },
      { round: 3, kind: 'gate', failedIds: ['a', 'b'] },
    ];
    const card = renderRoundSummaryCard(entries);
    expect(card).toContain('이 실패 집합은 라운드 1 에서도 같았다');
    expect(card).toContain('이렇게 하라: (F1) base(origin/main)에서 같은 시험을 돌려');
    expect(card).toContain('호출자와 `git log -S <심볼>`');
    expect(card).toContain('(F2) docs/의 매뉴얼·FINDING');
    expect(card).toContain('파일:줄·명령 출력');
    expect(renderRoundSummaryCard(entries.slice(0, 2))).not.toContain('이 실패 집합은');
    expect(renderRoundSummaryCard([{ round: 0, kind: 'gate', failedIds: [] }, { round: 1, kind: 'gate', failedIds: [] }])).not.toContain('이 실패 집합은');
  });

  it('keeps the latest round number within a small budget even when repetition guidance is longer', () => {
    const card = renderRoundSummaryCard([
      { round: 0, kind: 'gate', failedIds: ['repeat'] },
      { round: 1, kind: 'gate', failedIds: ['repeat'] },
    ], { maxChars: 100 });
    expect(card.length).toBeLessThanOrEqual(100);
    expect(card).toContain('라운드 1 · gate');
    expect(card).toContain('라운드 0 실패 반복');
    const tighter = renderRoundSummaryCard([
      { round: 0, kind: 'gate', failedIds: ['repeat'] },
      { round: 1, kind: 'gate', failedIds: ['repeat'] },
    ], { maxChars: 65 });
    expect(tighter.length).toBeLessThanOrEqual(65);
    expect(tighter).toContain('라운드 1 · gate');
  });

  it('keeps F1 and F2 actionable when repeated failure IDs exceed the default budget', () => {
    const longId = `same-${'x'.repeat(1800)}`;
    const card = renderRoundSummaryCard([
      { round: 0, kind: 'gate', failedIds: [longId] },
      { round: 1, kind: 'gate', failedIds: [longId] },
    ]);
    expect(card.length).toBeLessThanOrEqual(1500);
    expect(card).toContain('…(앞 라운드 1개 생략)');
    expect(card).toContain('라운드 1 · gate');
    expect(card).toContain('이 실패 집합은 라운드 0 에서도 같았다');
    expect(card).toContain('(F1) base(origin/main)에서 같은 시험을 돌려');
    expect(card).toContain('호출자와 `git log -S <심볼>`');
    expect(card).toContain('(F2) docs/의 매뉴얼·FINDING');
    expect(card).toContain('PR 본문 «남은 것»');
  });

  it('normalizes newlines in every rendered field to one line per round', () => {
    const card = renderRoundSummaryCard([
      { round: 0, kind: 'gate', tried: 'ran\n  test', failedIds: ['id\n one'],
        filesTouched: ['src/\nfile.ts'], rung: 'first\n second', premiseFindings: ['fact\n found'] },
    ]);
    expect(card.split('\n')).toHaveLength(2);
    expect(card.split('\n')[1]).toBe('라운드 0 · gate · 해 본 수: ran test · 실패 id: id one · 손댄 파일: src/ file.ts · rung: first second · premiseFindings: fact found');
  });

  it('drops oldest rounds before the latest within the default 1500-character budget', () => {
    const entries = Array.from({ length: 20 }, (_, round): RoundSummaryEntry => ({
      round, kind: 'gate', failedIds: [`id-${round}-${'x'.repeat(100)}`],
    }));
    const card = renderRoundSummaryCard(entries);
    expect(card.length).toBeLessThanOrEqual(1500);
    expect(card).toContain('…(앞 라운드 ');
    expect(card).toContain('라운드 19 · gate');
    expect(card).not.toContain('라운드 0 · gate');
    expect(renderRoundSummaryCard(entries, { maxChars: 300 }).length).toBeLessThanOrEqual(300);
  });
});
