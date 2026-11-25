// TUI-LONG-PASTE-SPIN (대표 11-25 «아예 죽는 문제 · 크리티컬») — a long paste on a huge transcript during a running turn
// must cost a bounded amount per frame. Deterministic counters (rows actually wrapped), never wall-clock.
// Expectations are independent literals.
import { describe, expect, test } from 'bun:test';
import type { SerializedMessage } from '../session/index.js';
import { logViewLines, logViewLinesWithInsertions, logViewRowRenderMisses } from './chat/log-view.js';
import { createNextTuiHistoryCache } from './core/render.js';
import { displayRowsAfterReload } from './core/compact-display.js';
import { nextTuiPublicHistory } from './core/public-history.js';
import { degradedTail, pendingEchoSettled } from './entry.js';

const ts = (i: number) => new Date(Date.UTC(2026, 10, 25, 0, 0, i)).toISOString();
const ANSWER = '## 작업 현황\n\n- 착지 대기 PR 세 건을 판정국에 넘겼다 · 리뷰 결과를 기다린다\n- 발행 예행은 22:00 에 시작한다\n\n| 칸 | 상태 |\n|---|---|\n| 착지 | 진행 중 |\n\n본문 문장은 길게 이어져서 터미널 폭을 넘기면 줄이 바뀌어야 한다. 한국어 단어 경계를 지켜야 한다.';
const TOOL_OUT = JSON.stringify({ output: Array.from({ length: 40 }, (_, i) => `${i + 1}\t결과 줄 ${i + 1} — 받은 우편과 칸 상태를 대조했다`).join('\n'), totalLines: 40 });
/** The pasted report: 48 lines of box-drawing table rows and Korean prose (3.5 KB+). */
const PASTE = Array.from({ length: 48 }, (_, i) => i % 4 === 0
  ? `│ ├──────────────────────────────────────── 구간 ${i}`
  : `│ - ${i}번째 줄: 재기동하면 압축된 저장 기록 대신 표시 스냅숏을 먼저 그리고, 그 뒤에 새로 생긴 줄만 덧붙입니다.`).join('\n');

/** ~1,000 exchanges: user · tool · assistant — well over 4,500 rendered rows at 120 columns. */
function bigTranscript(): SerializedMessage[] {
  const rows: SerializedMessage[] = [];
  for (let k = 0; k < 330; k += 1) {
    rows.push({ role: 'user', content: `질문 ${k}: 상태 알려줘`, ts: ts(k * 3) });
    rows.push({ role: 'tool', content: '⚙️ MsgList', ts: ts(k * 3 + 1), toolName: 'MsgList', toolResult: TOOL_OUT } as SerializedMessage);
    rows.push({ role: 'assistant', content: ANSWER, ts: ts(k * 3 + 2), replyFinal: true } as SerializedMessage);
  }
  return rows;
}

const frameInput = (messages: readonly SerializedMessage[]) => ({ messages, columns: 120, rows: 50, header: [], footer: [], promptLine: '',
  notices: [], activity: [], scroll: 0, expandedToolIndexes: new Set<number>(), turnEndMarkers: [], messageBlocks: [] });

describe('bounded frame cost on a huge transcript', () => {
  test('discovery-only history is scanned linearly, including when no later real tool exists', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ role: 'tool', content: '', toolName: 'ToolSearch', toolResult: `lookup ${i}` } as SerializedMessage));
    let indexedReads = 0;
    const observed = new Proxy(rows, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) indexedReads += 1;
      return Reflect.get(target, key, receiver);
    } });
    createNextTuiHistoryCache()(frameInput(observed));
    expect(indexedReads).toBeLessThan(20 * rows.length);
  });

  test('first render wraps every row once; a new array of the same rows wraps none', () => {
    const rows = bigTranscript();
    const before = logViewRowRenderMisses();
    const lines = logViewLines(rows, 120);
    expect(lines.length).toBeGreaterThan(4500);
    expect(logViewRowRenderMisses() - before).toBe(990);
    const again = logViewRowRenderMisses();
    expect(logViewLines([...rows], 120)).toEqual(lines);
    expect(logViewRowRenderMisses() - again).toBe(0);
  });

  test('running turn + 48-line paste: 60 frames with a fresh array each frame wrap only the pasted row', () => {
    const rows = bigTranscript();
    const prepare = createNextTuiHistoryCache();
    prepare(frameInput(rows));
    const echo: SerializedMessage = { role: 'user', content: PASTE, ts: ts(5000) };
    expect(new TextEncoder().encode(PASTE).length).toBeGreaterThan(3500); // bytes, like the live 3.6 KB paste
    const before = logViewRowRenderMisses();
    // The old echo path built `[...messages, echo]` on every 250 ms tick — 60 ticks = 15 s of a running turn.
    for (let frame = 0; frame < 60; frame += 1) prepare(frameInput([...rows, echo]));
    expect(logViewRowRenderMisses() - before).toBe(1);
  });

  test('a column change re-wraps each row exactly once (the memo is keyed by width)', () => {
    const rows = bigTranscript().slice(0, 30);
    logViewLines(rows, 120);
    const before = logViewRowRenderMisses();
    logViewLines(rows, 80);
    logViewLines(rows, 80);
    expect(logViewRowRenderMisses() - before).toBe(30);
    expect(logViewLines(rows, 80)).not.toEqual(logViewLines(rows, 120));
  });

  test('the public view keeps one copy per saved row across recomputes (row memo still hits)', () => {
    const rows = bigTranscript().slice(0, 30);
    rows.push({ role: 'user', content: '[queue-notice: 1 queued]\n\n원래 질문', ts: ts(900) } as SerializedMessage);
    const first = nextTuiPublicHistory(rows);
    const second = nextTuiPublicHistory([...rows]);
    expect(second.every((row, index) => row.role === 'system' || row === first[index])).toBe(true);
  });

  test('expanding one tool block re-wraps that row only', () => {
    const rows = bigTranscript().slice(0, 30);
    logViewLinesWithInsertions(rows, 120, new Set());
    const before = logViewRowRenderMisses();
    logViewLinesWithInsertions(rows, 120, new Set([1]));
    expect(logViewRowRenderMisses() - before).toBe(1);
  });
});

describe('the echo retires when the saved row carries a triage card', () => {
  const card = '<!-- bulk-triage-card -->\n📋 받은 것 42 → 처리 묶음 42 (P0 1 · P1 41 · P2 0 · P3 0 · noise 0)\n<!-- /bulk-triage-card -->';
  test('saved = card + the person\'s text → settled', () => {
    const saved: SerializedMessage[] = [{ role: 'assistant', content: 'a', ts: ts(1) }, { role: 'user', content: `${card}\n\n${PASTE}`, ts: ts(2) }];
    expect(pendingEchoSettled(saved, 1, PASTE)).toBe(true);
  });
  test('not saved yet → not settled; a different line → not settled', () => {
    const saved: SerializedMessage[] = [{ role: 'user', content: '다른 질문', ts: ts(1) }];
    expect(pendingEchoSettled(saved, 0, PASTE)).toBe(false);
    expect(pendingEchoSettled([], 0, PASTE)).toBe(false);
  });
  test('rows before the echo start never count', () => {
    const saved: SerializedMessage[] = [{ role: 'user', content: PASTE, ts: ts(1) }, { role: 'assistant', content: 'b', ts: ts(2) }];
    expect(pendingEchoSettled(saved, 1, PASTE)).toBe(false);
  });
});

describe('degraded tail', () => {
  test('keeps indexes, hides all but the newest 200 rows, same array per input', () => {
    const rows = bigTranscript();
    const tail = degradedTail(rows);
    expect(tail.length).toBe(990);
    expect(tail.slice(0, 790).every((row) => row.role === 'system')).toBe(true);
    expect(tail[790]).toBe(rows[790]);
    expect(tail[989]).toBe(rows[989]);
    expect(degradedTail(rows)).toBe(tail);
    const small = rows.slice(0, 150);
    expect(degradedTail(small)).toBe(small);
  });
});

// OP froze again 11-25 12:12 (pid 33035): `compact-display-kept {at:"message-block", kept:1}` every ~170 ms — each
// block reloaded the store (fresh row objects) and the merge handed the renderer a whole new transcript.
describe('store reloads are idempotent for the screen', () => {
  const stored = (): SerializedMessage[] => bigTranscript().map((row, index) => ({ ...row, turn_id: `t-${index}` }) as SerializedMessage);
  test('compacted session: two reloads of the same store → the second changes no row object and re-wraps nothing', () => {
    const shown = stored();
    const kept: SerializedMessage = { role: 'user', content: '저장소에는 없는 줄', ts: ts(9000), turn_id: 'gone' } as SerializedMessage;
    const displayed = [...shown.slice(0, 500), kept, ...shown.slice(500)];
    const first = displayRowsAfterReload({ sameSession: true, compacted: true, displayed, reloaded: stored(), knownSummaryId: 's1' });
    expect(first.keptMissing).toBe(1);
    expect(first.rows.every((row, index) => row === displayed[index])).toBe(true);
    logViewLines(first.rows, 120);
    const before = logViewRowRenderMisses();
    const second = displayRowsAfterReload({ sameSession: true, compacted: true, displayed: first.rows, reloaded: stored(), knownSummaryId: 's1' });
    expect(second.rows.every((row, index) => row === first.rows[index])).toBe(true);
    expect(second.rows.length).toBe(991);
    expect((second as { compactedBy?: string }).compactedBy).toBeUndefined();
    logViewLines(second.rows, 120);
    expect(logViewRowRenderMisses() - before).toBe(0);
  });

  test('a changed row takes the store object, an appended row is added — nothing else moves', () => {
    const displayed = stored().slice(0, 30);
    const next = stored().slice(0, 31);
    next[29] = { ...next[29]!, content: `${next[29]!.content}\n추가 문단` } as SerializedMessage;
    const merged = displayRowsAfterReload({ sameSession: true, compacted: false, displayed, reloaded: next });
    expect(merged.rows.slice(0, 29).every((row, index) => row === displayed[index])).toBe(true);
    expect(merged.rows[29]).toBe(next[29]);
    expect(merged.rows[30]).toBe(next[30]);
  });

  test('another session never reuses displayed rows', () => {
    const displayed = stored().slice(0, 5);
    const other = stored().slice(0, 5);
    const merged = displayRowsAfterReload({ sameSession: false, compacted: true, displayed, reloaded: other });
    expect(merged.rows[0]).toBe(other[0]);
  });
});
