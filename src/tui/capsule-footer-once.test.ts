// CAPSULE-FOOTER-ONCE (대표 11-24 13:0x «끝난 서브에이전트 줄이 턴마다 바닥에 남는다»): the footer shows only running
// capsules; a finished one is written once into the transcript at that moment and leaves the footer. Literals (rule 11).
import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../session/index.js';
import type { CapsuleEvent } from '../turn-capsule/contract.js';
import { CapsuleActivity } from './chat/capsule-activity.js';
import { withCapsuleDone, type TranscriptMarker } from './chat/capsule-transcript.js';
import { createNextTuiHistoryCache } from './core/render.js';

const strip = (line: string) => Bun.stripANSI(line).trimEnd();
const progress = (capsuleId: string, at: number, line: string): CapsuleEvent =>
  ({ type: 'capsule-progress', capsuleId, sessionId: 's1', kind: 'agent', at, line });
const done = (capsuleId: string, label: string, seconds: number, status: 'ok' | 'failed' = 'ok'): CapsuleEvent =>
  ({ type: 'capsule-done', capsuleId, sessionId: 's1', kind: 'agent', startedAt: 0, endedAt: seconds * 1000, status, summary: `${label} · ${status} · ${seconds}s` });

/** The same two steps entry.ts runs: capsule event → footer rows / transcript markers; then a frame's transcript. */
function screen() {
  const activity = new CapsuleActivity('s1');
  let markers: TranscriptMarker[] = [];
  const messages: SerializedMessage[] = [
    { role: 'user', content: '정리해 줘', ts: '1' },
    { role: 'assistant', content: '서브에이전트 셋에 나눠 맡겼다', ts: '2', replyFinal: true },
  ];
  const history = createNextTuiHistoryCache();
  return {
    messages,
    feed(event: CapsuleEvent) {
      const finished = activity.accept(event);
      if (finished) markers = withCapsuleDone(markers, messages.length - 1, finished);
    },
    footer: () => activity.runningLines(),
    transcript: (expandMarkers = false) => history({ messages, turnEndMarkers: markers, expandMarkers, columns: 80, rows: 24, header: [], footer: [],
      promptLine: '❯ ', notices: [], activity: [], scroll: 0, expandedToolIndexes: new Set<number>(), messageBlocks: [] }).lines.map(strip),
  };
}

test('a running capsule shows in the footer as one live row and disappears when it completes', () => {
  const s = screen();
  s.feed(progress('a', 1, '노랑 칸 병합 분류 · started'));
  s.feed(progress('b', 2, '착지 사슬 점검 · started'));
  s.feed(progress('b', 3, '착지 사슬 점검 · #1 Bash'));
  expect(s.footer()).toEqual(['🤖 2 running · 착지 사슬 점검 · Bash']);
  s.feed(done('a', '노랑 칸 병합 분류', 222));
  expect(s.footer()).toEqual(['🤖 1 running · 착지 사슬 점검 · Bash']);
  s.feed(done('b', '착지 사슬 점검', 300));
  expect(s.footer()).toEqual([]);
});

test('a finished capsule: no done row in the footer on the next 3 renders; exactly one 🤖 done row in the transcript at the completion point', () => {
  const s = screen();
  s.feed(progress('a', 1, '노랑 칸 병합 분류 · started'));
  s.feed(done('a', '노랑 칸 병합 분류', 222));
  for (let render = 0; render < 3; render += 1) {
    expect(s.footer()).toEqual([]);
    const transcript = s.transcript();
    expect(transcript.filter((row) => row.startsWith('🤖'))).toEqual(['🤖 노랑 칸 병합 분류 · ok · 222s']);
    // At the completion point: right after the last message of that moment.
    expect(transcript.indexOf('🤖 노랑 칸 병합 분류 · ok · 222s')).toBeGreaterThan(transcript.findIndex((row) => row.includes('서브에이전트 셋에')));
  }
  // A late event of the finished capsule does not bring it back.
  s.feed(progress('a', 9, '노랑 칸 병합 분류 · #5 Bash'));
  s.feed(done('a', '노랑 칸 병합 분류', 222));
  expect(s.footer()).toEqual([]);
  expect(s.transcript().filter((row) => row.startsWith('🤖'))).toEqual(['🤖 노랑 칸 병합 분류 · ok · 222s']);
});

test('consecutive completions fold into one dim row; log focus unfolds it; a failure gets its own warning row', () => {
  const s = screen();
  s.feed(done('a', '노랑 칸 병합 분류', 222));
  s.feed(done('b', '착지 사슬 점검', 300));
  s.feed(done('c', '리뷰 요약', 148));
  expect(s.transcript().filter((row) => row.startsWith('🤖'))).toEqual(['🤖 3 done · 노랑 칸 병합 분류 +2 · 670s']);
  expect(s.transcript(true).slice(-4)).toEqual([
    '🤖 3 done · 노랑 칸 병합 분류 +2 · 670s',
    '  🤖 노랑 칸 병합 분류 · ok · 222s',
    '  🤖 착지 사슬 점검 · ok · 300s',
    '  🤖 리뷰 요약 · ok · 148s',
  ]);
  s.feed(done('d', '발행 노트', 30, 'failed'));
  const rows = s.transcript().filter((row) => row.includes('🤖'));
  expect(rows).toEqual(['🤖 3 done · 노랑 칸 병합 분류 +2 · 670s', '⚠ 🤖 발행 노트 · failed · 30s']);
  expect(s.footer()).toEqual([]);
});

test('a new message between completions starts a new row (folding never crosses the conversation)', () => {
  const s = screen();
  s.feed(done('a', '노랑 칸 병합 분류', 222));
  s.messages.push({ role: 'user', content: '다음', ts: '3' });
  s.feed(done('b', '착지 사슬 점검', 300));
  expect(s.transcript().filter((row) => row.startsWith('🤖'))).toEqual(['🤖 노랑 칸 병합 분류 · ok · 222s', '🤖 착지 사슬 점검 · ok · 300s']);
});
