import { expect, test } from 'bun:test';
import { formatInlinePanel } from './inline-panel.js';
import { QUEUE_PANEL_HINT, QUEUE_VIEW_HINT, queueFullTextView, queuePanelKey, queuePanelMove, queuePanelOrder, queuePanelSpec, queueWaitRows, type QueuePanelItem, type QueuePanelViewing } from './queue-panel.js';

const item = (id: string, seq: number, extra: Partial<QueuePanelItem> = {}): QueuePanelItem => ({
  id, seq, kind: 'user', delivery: 'queue', mode: 'chat', status: 'queued', text: `text ${id}`, ...extra,
});
const key = (name: string, shift = false) => ({ name, shift, alt: false, ctrl: false });

const items: QueuePanelItem[] = [
  item('n1', 1, { kind: 'notice', text: '하니스 자식 완료' }),
  item('q2', 2),
  item('s3', 3, { delivery: 'steer' }),
  item('q4', 4, { mode: 'command', text: '/status' }),
  item('d5', 5, { status: 'delivered' }),
  item('x6', 6, { replacementCandidateFor: 'q2', text: '아까 q2 대신 이걸로' }),
];

test('invariant 1: panel and drain order is user > notice, then steer > queue, then seq; only queued rows show', () => {
  expect(queuePanelOrder(items).map((row) => row.id)).toEqual(['s3', 'q2', 'q4', 'x6', 'n1']);
});


test('rows show delivery, kind, mode and the supersede hint in English', () => {
  const lines = formatInlinePanel(queuePanelSpec(items, 0), queuePanelOrder(items).length + 2).join('\n');
  expect(lines).toContain('▸ steer · text s3');
  expect(lines).toContain('queued · text q2');
  expect(lines).not.toContain('editing');
  expect(lines).toContain('queued · /status — command');
  expect(lines).toContain('queued · 아까 q2 대신 이걸로 — may replace q2');
  expect(lines).toContain('queued · 하니스 자식 완료 — notice');
  expect(lines).toContain(QUEUE_PANEL_HINT);
});

test('invariant 10: a supersede hint is only a mark — the panel never retires the old item by itself', () => {
  const order = queuePanelOrder(items);
  expect(order.find((row) => row.id === 'q2')?.status).toBe('queued');
  // Retiring needs an explicit person action on that row (cancel), never the hint alone.
  expect(queuePanelKey(key('delete'), items, order.findIndex((row) => row.id === 'q2'))).toEqual({ kind: 'cancel', id: 'q2' });
});

test('keys: Tab toggles steer↔queue, refuses steering a slash or shell item, Delete cancels, Enter edits, Esc closes, typing passes', () => {
  const order = queuePanelOrder(items);
  const at = (id: string) => order.findIndex((row) => row.id === id);
  expect(queuePanelKey(key('tab'), items, at('q2'))).toEqual({ kind: 'toggle-delivery', id: 'q2', to: 'steer' });
  expect(queuePanelKey(key('tab'), items, at('s3'))).toEqual({ kind: 'toggle-delivery', id: 's3', to: 'queue' });
  expect(queuePanelKey(key('tab'), items, at('q4'))).toMatchObject({ kind: 'refused', id: 'q4' });
  expect(queuePanelKey(key('enter'), items, at('x6'))).toEqual({ kind: 'edit', id: 'x6', text: '아까 q2 대신 이걸로' });
  expect(queuePanelKey(key('escape'), items, at('q2'))).toEqual({ kind: 'closed' });
  // Not a panel key → pass: the panel closes and the key is typed (#38095 r1). Backspace never cancels.
  for (const name of ['backspace', 'a', '/', 'space']) expect(queuePanelKey(key(name), items, at('q2'))).toEqual({ kind: 'pass' });
  expect(queuePanelKey(key('tab', true), items, at('q2'))).toEqual({ kind: 'pass' });
  expect(queuePanelKey(key('delete'), items, at('q2'))).toEqual({ kind: 'cancel', id: 'q2' });
  expect(queuePanelKey(key('mouse'), items, at('q2'))).toBeNull();
  expect(queuePanelMove(items, 0, 'up')).toBe(order.length - 1);
  expect(queuePanelMove(items, order.length - 1, 'down')).toBe(0);
});

// ELS P0 (OP #127947 · #127912): the base screen's waiting rows — one per waiting user utterance.
test('waiting rows: one row per waiting user utterance — original text (⏎ join), «나:» identity, «대기 i/n» mark, FIFO; notices and delivered excluded', () => {
  const waiting: QueuePanelItem[] = [
    item('n1', 1, { kind: 'notice', text: 'OP 우편 도착' }),
    item('q2', 2, { text: '첫째 줄\n둘째 줄' }),
    item('s3', 3, { delivery: 'steer', text: '조향 원문' }),
    item('d5', 5, { status: 'delivered', text: '이미 전달' }),
  ];
  expect(queueWaitRows(waiting, false)).toEqual([
    // OP #129544 ②: the head row says how many PERSON utterances wait — the notice/alarm
    // queued count lives on its own surface and must not cover these.
    '사람 대기 2개',
    '대기 1/2 · 나: 조향 원문',
    '대기 2/2 · 나: 첫째 줄⏎둘째 줄',
  ]);
});

// OP #129544 ②: one waiting utterance still gets its head row — the person count is
// always readable at a glance, however many rows fit below.
test('waiting rows: the head row counts person utterances even when only one waits', () => {
  expect(queueWaitRows([item('q9', 9, { text: '하나뿐인 대기' })], false)).toEqual([
    '사람 대기 1개',
    '대기 1/1 · 나: 하나뿐인 대기',
  ]);
});

test('waiting rows: capped — 3 rows on a roomy screen, 2 on a compact one, the rest counted with an ↑ panel path; nothing waiting means no rows', () => {
  const four: QueuePanelItem[] = [1, 2, 3, 4].map((seq) => item(`w${seq}`, seq, { text: `원문 ${seq}` }));
  expect(queueWaitRows(four, false)).toEqual([
    '사람 대기 4개',
    '대기 1/4 · 나: 원문 1',
    '대기 2/4 · 나: 원문 2',
    '대기 3/4 · 나: 원문 3',
    '대기 외 1건 · ↑ 패널에서 전문',
  ]);
  expect(queueWaitRows(four, true)).toEqual([
    '사람 대기 4개',
    '대기 1/4 · 나: 원문 1',
    '대기 2/4 · 나: 원문 2',
    '대기 외 2건 · ↑ 패널에서 전문',
  ]);
  expect(queueWaitRows([], false)).toEqual([]);
  expect(queueWaitRows([item('n1', 1, { kind: 'notice', text: 'only a notice' })], false)).toEqual([]);
});

// ELS-QUEUE-WAIT-DISPLAY r2 (OP #128306 ② · JUD-B #128270): v = the non-destructive full-text view.
test('view keys: list v opens the selected item read-only; view mode scrolls, v/Enter/Delete go back, Esc closes; typing passes', () => {
  const order = queuePanelOrder(items);
  const at = (id: string) => order.findIndex((row) => row.id === id);
  const viewing: QueuePanelViewing = { id: 'q2', scroll: 3 };
  expect(queuePanelKey(key('v'), items, at('q2'))).toEqual({ kind: 'view', id: 'q2' });
  // Reading is not typing either: a modified v is a pass, not the view.
  expect(queuePanelKey({ name: 'v', shift: false, alt: true, ctrl: false }, items, at('q2'))).toEqual({ kind: 'pass' });
  // View mode: ↑↓ scroll a line, v/Enter/Delete return to the list (no edit, no cancel), Esc closes the panel.
  expect(queuePanelKey(key('up'), items, at('q2'), viewing)).toEqual({ kind: 'view-scroll', delta: -1 });
  expect(queuePanelKey(key('down'), items, at('q2'), viewing)).toEqual({ kind: 'view-scroll', delta: 1 });
  for (const name of ['v', 'enter', 'return', 'delete']) {
    expect(queuePanelKey(key(name), items, at('q2'), viewing)).toEqual({ kind: 'view-close' });
  }
  expect(queuePanelKey(key('escape'), items, at('q2'), viewing)).toEqual({ kind: 'closed' });
  expect(queuePanelKey(key('backspace'), items, at('q2'), viewing)).toEqual({ kind: 'pass' });
  expect(queuePanelKey(key('mouse'), items, at('q2'), viewing)).toBeNull();
  // Without a view open the destructive keys keep their list meaning (#38095 r1 contract unchanged).
  expect(queuePanelKey(key('delete'), items, at('q2'))).toEqual({ kind: 'cancel', id: 'q2' });
  expect(queuePanelKey(key('enter'), items, at('x6'))).toEqual({ kind: 'edit', id: 'x6', text: '아까 q2 대신 이걸로' });
});

test('queueFullTextView: real newlines break lines, long lines hard-wrap by terminal cells, scroll clamps to what fits, gone items fall back to null', () => {
  const wrap: QueuePanelItem[] = [item('w1', 1, { text: '열\n\n긴行' }), item('w2', 2, { text: '가'.repeat(30) })];
  // Multi-line: one line per newline (the empty line kept); short text fits — no position line, scroll clamped to 0.
  const multi = queueFullTextView(wrap, { id: 'w1', scroll: 99 }, 40, 4);
  expect(multi?.lines).toEqual(['열', '', '긴行']);
  expect(multi?.position).toBeNull();
  expect(multi?.scroll).toBe(0);
  // Cell wrap: 30 syllables are 60 cells — at 12 columns that is 5 lines of 6 syllables (12 cells) each
  // (OP #128451: code-point wrap made 97-cell single lines the terminal then cut — 한글 counts 2 cells).
  const single = queueFullTextView(wrap, { id: 'w2', scroll: 0 }, 12, 2);
  expect(single?.lines.map((line) => Bun.stringWidth(line))).toEqual([12, 12]);
  expect(single?.total).toBe(5);
  expect(single?.position).toBe('lines 1-2/5 · ↑↓ scroll');
  expect(single?.hint).toBe(QUEUE_VIEW_HINT);
  // The clamp is reported back so the caller can write it into the state; the view shows the last page.
  const scrolled = queueFullTextView(wrap, { id: 'w2', scroll: 99 }, 12, 2);
  expect(scrolled?.scroll).toBe(3);
  // Title index counts the whole FIFO order (steer first); delivered/cancelled/missing items are gone → null.
  expect(queueFullTextView(items, { id: 'd5', scroll: 0 }, 40, 4)).toBeNull();
  expect(queueFullTextView(items, { id: '없는항목', scroll: 0 }, 40, 4)).toBeNull();
  expect(queueFullTextView(items, { id: 'q2', scroll: 0 }, 40, 4)?.title).toBe('Queue · queued full text 2/5');
});

// OP #128451 (JUD-B #128446 · node-b real-PTY repro at 60 columns): a wide line wraps by CELLS so the whole
// text — end marker included — stays on screen. Code-point wrap left one 97-cell line the render cut (RED).
test('queueFullTextView: wide syllables wrap by cells — the end marker survives (OP #128451)', () => {
  const wide = item('w', 1, { delivery: 'steer', text: `QW-A ${'가나다라마바사아자차카타파하'.repeat(3)}-TAILEND` });
  const view = queueFullTextView([wide], { id: 'w', scroll: 0 }, 60, 4);
  expect(view?.total).toBe(2); // 97 cells → 60 + 37, not one line the terminal would cut
  expect(view?.lines.every((line) => Bun.stringWidth(line) <= 60)).toBe(true);
  expect(view?.lines.at(-1)).toContain('-TAILEND');
});
