// NOTICE-FOLD-1LINE (대표 11-24 12:2x) — mail in the chat folds PER MESSAGE: each mail of a seat-mail digest is its own
// dim «✉ #id from · first line…» row; a click (or the tool fold key) opens that one mail in place and folds it back.
// PERSON-VS-MACHINE (대표 12:1x) — the person's line is «❯ » on a band; a machine row is dim with an icon, never «❯»,
// decided by the structured source, never the text. Expectations are literals (independent of the product's builders).
import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../session/index.js';
import { queueNoticeHead, stripQueueModelContext, withQueueNoticeContext } from '../chat/interjection.js';
import { createNextTuiPublicHistoryView } from './entry.js';
import { foldTargetAtScreenRow, renderNextTuiLogFrame } from './core/render.js';
import { logViewLines } from './chat/log-view.js';
import { nextTuiPublicHistory } from './core/public-history.js';
import { foldExpandedIndexes, queueNoticeMeta, seatMailNoticeParts, toggleNoticePartFold, withNoticeOpenParts } from './chat/notice-fold.js';
import { createNextTuiQueue } from './core/queue.js';
import { createChildNoticeProducers } from './core/notice-producers.js';
import { seatMailBundleText } from './seat-mail-digest.js';

const ANSWER = 'REVIEW-2 handoff is done but the tab is not closed yet.';
const FIRST = [
  'Mail 1: please re-run the focused tests on node-b.',
  'Mail 2: the review for PR #39912 is ready.',
  'Mail 3: the release branch needs a rebase on main before the cut and the pregate receipt must be posted with the head sha too.',
  'Mail 4: close the idle JUD tabs.',
];
const filler = (n: number, size: number) => `MAIL-${n} filler: post the receipt path with the head sha.\n`.repeat(200).slice(0, size);

/** The notice turn's saved row as the queue builds it: four action mails → one digest → the head with per-mail spans. */
const noticeTurn = (lastSize: number) => {
  const queue = createNextTuiQueue();
  const producers = createChildNoticeProducers(queue);
  for (const n of [1, 2, 3, 4]) {
    producers.seatMessageArrived({ id: 140980 + n, sender: `JUD-${n}`, kind: 'request',
      body: `${FIRST[n - 1]}\n${filler(n, n === 4 ? lastSize : 3000)}` });
  }
  const bundle = queue.drainNotices();
  if (bundle.kind !== 'notices') throw new Error('no bundle');
  const text = seatMailBundleText(bundle.notices);
  const items = bundle.notices.map((notice) => queue.get(notice.id)!);
  const meta = queueNoticeMeta(items.map((item) => ({ msgId: item.msgId, sender: item.mail?.sender })), seatMailNoticeParts(text, items));
  return { text, content: withQueueNoticeContext(text, 'seat-mail', meta) };
};
// The live digest that pushed the answer off screen was 13,544 characters; the fourth mail fills it to exactly that.
const probe = noticeTurn(3000);
const { text: DIGEST, content: NOTICE_CONTENT } = noticeTurn(3000 + 13_544 - probe.text.length);
const LINES = [
  '📩 #140981 JUD-1 · Mail 1: please re-run the focused tests on node-b.',
  '📩 #140982 JUD-2 · Mail 2: the review for PR #39912 is ready.',
  '📩 #140983 JUD-3 · Mail 3: the release branch needs a rebase on main before the cut and the pregate…',
  '📩 #140984 JUD-4 · Mail 4: close the idle JUD tabs.',
];

const answered: SerializedMessage[] = [
  { role: 'user', content: 'Please check the JUD tabs and close the idle ones.', ts: '2026-11-24T03:20:00.000Z', from: { kind: 'human' } },
  { role: 'tool', content: '⚙️ ElsControl', ts: '2026-11-24T03:20:05.000Z', toolName: 'ElsControl' },
  { role: 'assistant', content: ANSWER, ts: '2026-11-24T03:21:00.000Z', replyFinal: true },
];
const noticeRow: SerializedMessage = { role: 'user', content: NOTICE_CONTENT, ts: '2026-11-24T03:21:30.000Z', turn_id: '01NOTICEFOLDROW0000000000' as never };
const COLUMNS = 100;
const ROWS = 30;
const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const frameOf = (displayed: readonly SerializedMessage[], expanded: ReadonlySet<string>) => {
  const shown = withNoticeOpenParts(displayed, expanded);
  return { shown, frame: renderNextTuiLogFrame({
    messages: shown, columns: COLUMNS, rows: ROWS, header: ['elanous'], footer: ['─'], promptLine: '› ',
    notices: [], activity: ['⠋ thinking'], scroll: 0,
    // the basic chat (input focus): notices open by row id, tool blocks stay folded — as the entry builds it.
    expandedToolIndexes: foldExpandedIndexes(shown, null, expanded),
  }) };
};
const bodyOf = (frame: ReturnType<typeof frameOf>['frame']) => frame.body.map(plain);

test('the head carries the queue item\'s structured fields and reads back; the model text keeps the full body', () => {
  const content = withQueueNoticeContext('body line', 'seat-mail', { count: 4, senders: ['JUD-1', 'JUD-2', 'JUD-1', 'bad name]'],
    msgIds: [140981, 140982], parts: [{ msgId: 140981, sender: 'JUD-1', start: 0, length: 4 }] });
  expect(content).toBe('[notice · seat-mail · 4 msg · from JUD-1,JUD-2 · #140981,#140982 · parts 140981/JUD-1/0+4]\n\nbody line');
  expect(stripQueueModelContext(content)).toBe('body line');
  expect(queueNoticeHead(content)).toEqual({ source: 'seat-mail', body: 'body line', count: 4, senders: ['JUD-1', 'JUD-2'],
    msgIds: [140981, 140982], parts: [{ msgId: 140981, sender: 'JUD-1', start: 0, length: 4 }] });
  expect(withQueueNoticeContext('x', 'capsule-done')).toBe('[notice · capsule-done]\n\nx');
  expect(queueNoticeHead('[notice · capsule-done]\n\nx')).toEqual({ source: 'capsule-done', body: 'x' });
  // A span past the saved body is not trusted.
  expect(queueNoticeHead('[notice · seat-mail · parts 1/JUD-1/0+99]\n\nshort')?.parts).toBeUndefined();
  // The digest's spans are each mail's own body, found from the queue items (not by splitting the text).
  const parts = queueNoticeHead(NOTICE_CONTENT)!.parts!;
  expect(parts.map((part) => [part.msgId, part.sender])).toEqual([[140981, 'JUD-1'], [140982, 'JUD-2'], [140983, 'JUD-3'], [140984, 'JUD-4']]);
  expect(DIGEST.slice(parts[1]!.start, parts[1]!.start + parts[1]!.length)).toBe(`${FIRST[1]}\n${filler(2, 3000)}`);
});

test('a 13,544-char 4-mail digest renders as exactly 4 truncated «✉ #id from · …» lines', () => {
  expect(DIGEST.length).toBe(13_544);
  const [row] = nextTuiPublicHistory([noticeRow]);
  // The saved row (what the model and the session keep) is untouched — only the drawing folds.
  expect(row!.content).toBe(NOTICE_CONTENT);
  const lines = logViewLines([row!], COLUMNS);
  expect(lines.map(plain)).toEqual([...LINES, '']);
  // Mail rows are muted: dim, no band, never the person's «❯».
  for (const line of lines.slice(0, 4)) {
    expect(line).toStartWith('\x1b[2m📩 ');
    expect(line).not.toContain('48;5;');
    expect(line).not.toContain('❯');
  }
});

test('click on line 2 → only message 2 opens in place; click again → 4 lines', () => {
  const view = createNextTuiPublicHistoryView();
  const displayed = view([...answered, noticeRow], false);
  const expanded = new Set<string>();
  const folded = frameOf(displayed, expanded);
  const at = bodyOf(folded.frame).indexOf(LINES[1]!);
  expect(at).toBeGreaterThan(0);
  expect(bodyOf(folded.frame).filter((line) => line.startsWith('📩 '))).toEqual(LINES);
  const click = (state: ReturnType<typeof frameOf>, bodyRow: number) => {
    const target = foldTargetAtScreenRow(state.frame.logWindow.foldTargets, state.frame.logWindow, state.frame.logWindow.bodyTop + bodyRow);
    expect(target).toMatchObject({ kind: 'tool', index: 3, part: 140982 });
    return toggleNoticePartFold(expanded, state.shown, 3, (target as { part?: number }).part);
  };
  expect(click(folded, at)).toBe(true);
  expect([...expanded]).toEqual(['01NOTICEFOLDROW0000000000#140982']);
  const open = frameOf(displayed, expanded);
  const openLines = logViewLines([open.shown[3]!], COLUMNS).map(plain);
  expect(openLines[0]).toBe(LINES[0]);
  expect(openLines[1]).toBe('📩 #140982 JUD-2 ·');
  expect(openLines[2]).toBe(`  ${FIRST[1]}`);
  expect(openLines.filter((line) => line.includes('MAIL-2 filler')).length).toBeGreaterThan(30);
  expect(openLines.some((line) => line.includes('MAIL-1 filler') || line.includes('MAIL-3 filler') || line.includes('MAIL-4 filler'))).toBe(false);
  expect(openLines.slice(-3)).toEqual([LINES[2], LINES[3], '']);
  // Click again on a row of the open mail → back to its one line.
  const inside = bodyOf(open.frame).findIndex((line) => line.includes('MAIL-2 filler'));
  expect(inside).toBeGreaterThanOrEqual(0);
  expect(click(open, inside)).toBe(true);
  expect([...expanded]).toEqual([]);
  expect(bodyOf(frameOf(displayed, expanded).frame).filter((line) => line.startsWith('📩 '))).toEqual(LINES);
});

test('the previous answer stays on screen when the notice turn starts (100x30)', () => {
  const view = createNextTuiPublicHistoryView();
  const answerOn = (body: readonly string[]) => body.some((line) => line.includes('REVIEW-2 handoff is done'));
  expect(answerOn(bodyOf(frameOf(view(answered, false), new Set()).frame))).toBe(true);
  const busy = view([...answered, noticeRow], true, Date.parse('2026-11-24T03:21:29.000Z'));
  const body = bodyOf(frameOf(busy, new Set()).frame);
  expect(answerOn(body)).toBe(true);
  expect(body.filter((line) => line.startsWith('📩 '))).toEqual(LINES);
});

test('the person\'s line is «❯ » with the user style and never folds; a machine row is dim, iconed, without «❯»', () => {
  const saved = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const own: SerializedMessage = { role: 'user', content: 'line one\nline two\nline three\nline four\nline five', ts: '2', from: { kind: 'human' } };
    const ownLines = logViewLines([own], COLUMNS);
    expect(ownLines.map(plain).map((line) => line.trimEnd())).toEqual(['❯ line one', '  line two', '  line three', '  line four', '  line five', '']);
    expect(ownLines[0]).toStartWith('\x1b[48;5;');
    expect(ownLines[0]).toContain('\x1b[1m❯\x1b[22m line one');
    // A seat-mail notice row: «✉ » dim, no «❯», no band.
    const mail = logViewLines([{ role: 'user', content: '[notice · seat-mail]\n\n[from REL · info]\nmsg:1 · preflight', ts: '3' }], COLUMNS);
    expect(mail).toEqual(['\x1b[2m📩 seat-mail · [from REL · info]\x1b[22m', '']);
    // A notice whose text starts with «❯» is still a machine row: the source decides, not the text.
    const lookalike = logViewLines([{ role: 'user', content: '[notice · seat-mail]\n\n❯ looks like a prompt', ts: '4' }], COLUMNS);
    expect(lookalike).toEqual(['\x1b[2m📩 seat-mail · ❯ looks like a prompt\x1b[22m', '']);
    // A typed line that looks like a notice head stays the person's line when the row says a person sent it.
    const typed: SerializedMessage = { role: 'user', content: '[notice · seat-mail]\n\nhello', ts: '5', from: { kind: 'human' } };
    const typedLines = logViewLines([typed], COLUMNS).map(plain);
    expect(typedLines[0]!.trimEnd()).toBe('❯ [notice · seat-mail]');
    expect(toggleNoticePartFold(new Set(), [own, typed], 0, undefined)).toBe(false);
    expect(toggleNoticePartFold(new Set(), [own, typed], 1, undefined)).toBe(false);
    // Other machine rows keep the muted one-line style with their icon: the seat's own continuation, a capsule result.
    // (A scheduled «Resuming» row is bookkeeping and draws nothing — TUI-NOTICE-QUIET #39935.)
    expect(logViewLines([{ role: 'user', content: 'x', ts: '6', from: { kind: 'system', origin: 'scheduled' } }], COLUMNS)).toEqual(['No chat history']);
    expect(logViewLines([{ role: 'user', content: 'x', ts: '6', from: { kind: 'system', origin: 'goal-continue' } }], COLUMNS))
      .toEqual(['\x1b[2m↻ Continuing\x1b[22m', '']);
    expect(logViewLines([{ role: 'user', content: '[notice · capsule-done]\n\n캡슐 완료: review ok', ts: '7' }], COLUMNS))
      .toEqual(['\x1b[2m🤖 capsule-done · 캡슐 완료: review ok\x1b[22m', '']);
    expect(logViewLines([{ role: 'user', content: '[notice · capsule-done · 1 failed]\n\n캡슐 완료: review failed', ts: '8' }], COLUMNS))
      .toEqual(['\x1b[33m⚠ capsule-done · 1 failed · 캡슐 완료: review failed\x1b[39m', '']);
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});
