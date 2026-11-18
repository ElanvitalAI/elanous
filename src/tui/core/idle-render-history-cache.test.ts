/**
 * TUI-IDLE-CPU-SPIN — an idle Next TUI with the sidetab open re-renders every second; the transcript
 * must not be re-wrapped on those ticks. We drive the same two steps entry.ts render() runs per frame
 * (public history view → history cache) and count how many distinct prepared histories come back:
 * a cache miss re-wraps every message (logViewLinesWithInsertions) and returns a new object.
 */
import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import { createNextTuiPublicHistoryView } from '../entry.js';
import { createNextTuiHistoryCache } from './render.js';

function koreanHistory(count: number): SerializedMessage[] {
  return Array.from({ length: count }, (_, index) => index % 2 === 0
    ? { role: 'user' as const, content: `질문 ${index} 사이드탭이 열린 채로 가만히 두면 화면이 어떻게 되나요`, ts: String(index) }
    : { role: 'assistant' as const, content: `답변 ${index}\t들여쓴 줄 한국어 문장이 길게 이어져 줄바꿈이 여러 번 일어납니다`, ts: String(index), replyFinal: true });
}

function frame(messages: readonly SerializedMessage[]) {
  // 출처: 내부 문서 `ELS-SIDETAB-SERVER` — sidetab open narrows the chat column (80 wide, 30-wide panel + divider).
  return { messages, columns: 49, rows: 24, header: [], footer: [], promptLine: '❯ ', notices: [], activity: [],
    scroll: 0, expandedToolIndexes: new Set<number>(), messageBlocks: [] };
}

test('idle sidetab ticks reuse the wrapped history: 200 Korean messages, 60 ticks, at most one re-wrap', () => {
  const messages = koreanHistory(200);
  const publicView = createNextTuiPublicHistoryView();
  const prepareHistory = createNextTuiHistoryCache();
  const prepared = new Set<object>();
  let renders = 0;
  const render = () => {
    renders++;
    prepared.add(prepareHistory(frame(publicView(messages, false))));
  };
  render();
  // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «기존 1초 갱신» — one minute of idle sidetab ticks.
  for (let tick = 0; tick < 60; tick++) render();
  // 출처: 내부 문서 `ELS-SIDETAB-SERVER` — first paint plus 60 idle ticks.
  expect(renders).toBeLessThanOrEqual(61);
  // 출처: 내부 문서 `ELS-SIDETAB-SERVER` — only the first paint may wrap the transcript.
  expect(prepared.size).toBeLessThanOrEqual(1);
});

test('the memoised public view still reflects new messages, busy flips and tab expansion', () => {
  const messages = koreanHistory(4);
  const publicView = createNextTuiPublicHistoryView();
  const first = publicView(messages, false);
  expect(publicView(messages, false)).toBe(first);
  expect(first[1]?.content).toBe('답변 1    들여쓴 줄 한국어 문장이 길게 이어져 줄바꿈이 여러 번 일어납니다');
  messages.push({ role: 'user', content: '새 질문', ts: '99' });
  const grown = publicView(messages, false);
  expect(grown).not.toBe(first);
  expect(grown.at(-1)?.content).toBe('새 질문');
  expect(publicView(messages, true)).not.toBe(grown);
});
