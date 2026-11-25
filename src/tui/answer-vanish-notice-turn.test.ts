// TUI-ANSWER-VANISH ⑤ — OP seat 11-24 11:44 KST (session 6b0273ce): no compaction, no reload drop; a seat-mail
// notice dequeued at idle opened a notice turn and the previous answer left the screen. The saved notice row was
// the whole seat-mail digest (921–13,544 chars live) and the basic chat drew it in full under the answer, so the
// answer was pushed above the viewport. Expectations are literals (independent of the product's fold constants).
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SerializedMessage } from '../session/index.js';
import { appendMessage, createSession, loadSession, rewriteSessionMessages } from '../session/index.js';
import { formatTombstoneLine, interleaveTombstones, loadTombstones } from '../session/message-tombstones.js';
import { createNextTuiPublicHistoryView } from './entry.js';
import { renderNextTuiLogFrame } from './core/render.js';
import { logViewLines } from './chat/log-view.js';
import { chatRowsOnScreen, createTranscriptVanishDetector, type TranscriptVanishEvent } from './core/transcript-vanish.js';

const ANSWER = 'REVIEW-2 handoff is done but the tab is not closed yet.';
const mail = (n: number) => `[from JUD-${n} · action]\nmsg:14098${n} · review request for PR #3991${n}\n`
  + `${'Please re-run the focused tests on node-b and post the receipt path with the head sha. '.repeat(4)}`;
const DIGEST = `[seat-mail digest] 7 mails — 7 need action · 0 info (every mail below needs a reply)\n\n${
  [1, 2, 3, 4, 5, 6, 7].map(mail).join('\n\n')}`;

const answered: SerializedMessage[] = [
  { role: 'user', content: 'Please check the JUD tabs and close the idle ones.', ts: '2026-11-24T02:42:42.543Z' },
  { role: 'tool', content: '⚙️ ElsControl', ts: '2026-11-24T02:42:49.863Z', toolName: 'ElsControl' },
  { role: 'assistant', content: ANSWER, ts: '2026-11-24T02:44:02.199Z', replyFinal: true },
];
// The notice turn's saved user row: the queue's model-only head + the digest body (as the child persisted it).
const noticeRow: SerializedMessage = { role: 'user', content: `[notice · seat-mail]\n\n${DIGEST}`, ts: '2026-11-24T02:44:26.116Z' };
const COLUMNS = 100;
const ROWS = 30;

const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const frameOf = (displayed: readonly SerializedMessage[]) => renderNextTuiLogFrame({
  messages: displayed, columns: COLUMNS, rows: ROWS, header: ['elanous'], footer: ['─'], promptLine: '› ',
  notices: [], activity: ['⠋ thinking'], scroll: 0, expandedToolIndexes: new Set<number>(),
});
const answerOnScreen = (body: readonly string[]) => body.map(plain).some((line) => line.includes('REVIEW-2 handoff is done'));
const detectorFrame = (saved: readonly SerializedMessage[], displayed: readonly SerializedMessage[], body: readonly string[], busy: boolean) => {
  const { onScreen, evaluated } = chatRowsOnScreen({ saved, displayed, screenLines: body, tail: 8,
    renderRow: (row) => logViewLines([row], COLUMNS) });
  return { sessionId: 'sess-1', saved, displayed, onScreen, evaluated, scroll: 0, userScrolled: false, busy,
    turnDoor: 'queue-notice', turnSource: 'seat-mail' };
};

test('answer shown → seat-mail notice dequeued at idle → notice turn starts → the previous answer stays on screen', () => {
  const events: TranscriptVanishEvent[] = [];
  const observe = createTranscriptVanishDetector((event) => events.push(event));
  const view = createNextTuiPublicHistoryView();
  // 1) idle: the answer is on screen.
  const idleView = view(answered, false);
  const idleFrame = frameOf(idleView);
  expect(answerOnScreen(idleFrame.body)).toBe(true);
  observe(detectorFrame(answered, idleView, idleFrame.body, false));
  // 2) the notice turn started (busy) and its saved row arrived on the next reload.
  const saved = [...answered, noticeRow];
  const busyView = view(saved, true, Date.parse('2026-11-24T02:44:26.000Z'));
  const busyFrame = frameOf(busyView);
  expect(answerOnScreen(busyFrame.body)).toBe(true);
  // The notice is one folded line (NOTICE-FOLD-1LINE); the digest's last mail is not drawn in the basic chat.
  expect(busyFrame.body.map(plain).filter((line) => line.startsWith('📩 seat-mail · '))).toHaveLength(1);
  expect(busyFrame.body.map(plain).some((line) => line.includes('msg:140987'))).toBe(false);
  observe(detectorFrame(saved, busyView, busyFrame.body, true));
  expect(events).toEqual([]);
});

test('the full digest drawn under the answer (pre-fix view) pushes it off screen and the detector names it', () => {
  const events: TranscriptVanishEvent[] = [];
  const observe = createTranscriptVanishDetector((event) => events.push(event));
  const view = createNextTuiPublicHistoryView();
  const idleView = view(answered, false);
  observe(detectorFrame(answered, idleView, frameOf(idleView).body, false));
  const saved = [...answered, noticeRow];
  // What the basic chat drew before the fix: the notice row's whole body.
  const unfolded = view(saved, true, Date.parse('2026-11-24T02:44:26.000Z'))
    .map((row, index) => index === 3 ? { ...row, content: DIGEST } : row);
  const body = frameOf(unfolded).body;
  expect(answerOnScreen(body)).toBe(false);
  observe(detectorFrame(saved, unfolded, body, true));
  // Both rows of the previous exchange left the screen: the person's question and the answer.
  expect(events.map((event) => `${event.role}:${event.cause}`).sort()).toEqual(['assistant:slice-window', 'user:slice-window']);
  expect(events.find((event) => event.role === 'assistant')).toMatchObject({
    sessionId: 'sess-1', role: 'assistant', cause: 'slice-window', turnDoor: 'queue-notice', turnSource: 'seat-mail',
    createdAt: '2026-11-24T02:44:02.199Z', chars: 55, scrollOffset: 0,
    preview: 'REVIEW-2 handoff is done but the tab is not closed yet.',
  });
});

test('a row gone from the saved history is named by the reload that dropped it', () => {
  const events: TranscriptVanishEvent[] = [];
  const observe = createTranscriptVanishDetector((event) => events.push(event));
  const view = createNextTuiPublicHistoryView();
  const idleView = view(answered, false);
  observe(detectorFrame(answered, idleView, frameOf(idleView).body, false));
  const after = answered.slice(0, 1);
  const afterView = view(after, false);
  observe({ ...detectorFrame(after, afterView, frameOf(afterView).body, false), reload: 'compaction' });
  expect(events.map((event) => [event.role, event.cause, event.preview])).toEqual([
    ['assistant', 'compaction', 'REVIEW-2 handoff is done but the tab is not closed yet.'],
  ]);
});

test('a history rewrite that drops a chat row leaves a tombstone that session show prints in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'answer-vanish-tomb-'));
  try {
    const id = createSession({ source: 'tui' }, root).id;
    for (const row of answered) appendMessage(id, row, root);
    const saved = loadSession(id, root)!.messages;
    rewriteSessionMessages(id, saved.filter((row) => row.role !== 'assistant'), root, 'compaction');
    const stones = loadTombstones(id, root);
    expect(stones.map((stone) => [stone.role, stone.cause, stone.createdAt, stone.chars, stone.preview])).toEqual([
      ['assistant', 'compaction', '2026-11-24T02:44:02.199Z', 55, 'REVIEW-2 handoff is done but the tab is not closed yet.'],
    ]);
    expect(readFileSync(join(root, `${id}.tombstones.jsonl`), 'utf-8').split('\n').filter(Boolean).length).toBe(1);
    const shown = interleaveTombstones(loadSession(id, root)!.messages, stones)
      .map((entry) => entry.kind === 'removed' ? formatTombstoneLine(entry.stone).replace(/\d\d:\d\d/, 'HH:MM') : entry.message.role);
    expect(shown).toEqual(['user', 'tool',
      '[removed HH:MM · compaction] assistant · 55 chars · REVIEW-2 handoff is done but the tab is not closed yet.']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rewrite that keeps every chat row writes no tombstone', () => {
  const root = mkdtempSync(join(tmpdir(), 'answer-vanish-tomb-'));
  try {
    const id = createSession({ source: 'tui' }, root).id;
    for (const row of answered) appendMessage(id, row, root);
    rewriteSessionMessages(id, loadSession(id, root)!.messages.filter((row) => row.role !== 'tool'), root, 'compaction');
    expect(loadTombstones(id, root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bottom-pinned flow: an older exchange scrolling up under a newer answer on screen is not a vanish', () => {
  const exchange = (n: number): SerializedMessage[] => [
    { role: 'user', content: `Question number ${n} about the landing queue state.`, ts: `2026-11-25T01:${String(10 + n * 2).padStart(2, '0')}:00.000Z` },
    { role: 'assistant', content: `Answer number ${n}: ${'the queue moved one step forward and the receipt is posted. '.repeat(8)}`,
      ts: `2026-11-25T01:${String(11 + n * 2).padStart(2, '0')}:00.000Z`, replyFinal: true },
  ];
  const events: TranscriptVanishEvent[] = [];
  const observe = createTranscriptVanishDetector((event) => events.push(event));
  const view = createNextTuiPublicHistoryView();
  const before = [0, 1, 2, 3].flatMap(exchange);
  const beforeView = view(before, false);
  const beforeBody = frameOf(beforeView).body;
  expect(beforeBody.map(plain).some((line) => line.includes('Question number 2 about'))).toBe(true);
  observe(detectorFrame(before, beforeView, beforeBody, false));
  const after = [...before, ...[4, 5].flatMap(exchange)];
  const afterView = view(after, false);
  const afterBody = frameOf(afterView).body;
  // The older exchange left the top edge; the newest answer is on screen.
  expect(afterBody.map(plain).some((line) => line.includes('Question number 2 about'))).toBe(false);
  expect(afterBody.map(plain).some((line) => line.includes('Answer number 5:'))).toBe(true);
  observe(detectorFrame(after, afterView, afterBody, false));
  expect(events).toEqual([]);
});
