import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV } from '../ux-sim/fake-llm.js';

// ELS P0 (OP #127947 · #127912 · #127914) + r2 rework (OP #128306 · JUD-B #128270/#128278/#128283):
// while a turn runs, each utterance the person sent shows on the base screen as its own dim row above the
// input — the original text, the «나:» identity and the «대기 i/n» waiting mark (queueWaitRows) — before ↑
// opens the queue panel. r2 ①: every waiting utterance is delivered exactly once, in FIFO order, proven by
// UNIQUE replies (rules: QW-A→ANS-A, QW-B→ANS-B — a same-reply counter cannot tell A,A from A,B). r2 ②:
// v shows the selected item's full text read-only (multi-line and long text included, ↑↓ scrolling a line
// at a time); the queue is untouched. r2 ③: Enter edit stays the separate path — it takes the item OUT of
// the queue (no drain can send it), the full text lands in the composer and Enter sends it again.
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SLOW = 'QW-SLOW';
const SLOW_MS = '120000';
const running = (screen: string) => /Turn running|● running|응답 중|esc to interrupt/.test(screen);
const promptRow = (screen: string) => screen.split('\n').filter((row) => row.trimStart().startsWith('❯')).at(-1) ?? '';

async function waitDisplayRun(
  steps: Parameters<typeof mockSeatPtySequence>[0]['steps'],
  { rows, cols }: { rows: number; cols: number },
  extraEnv: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'next-queue-wait-display-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    return {
      run: await mockSeatPtySequence({
        executable: process.execPath,
        args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows, cols,
        env: {
          ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          [TEST_FAKE_LLM_DELAY_MS_ENV]: SLOW_MS, [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW,
          ...extraEnv,
        },
        ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
        steps,
      }),
      root,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// r2 ①: unique replies make the drain order and the once-each proof observable on the real screen.
const RULES = JSON.stringify([
  { when: SLOW, text: 'QW-SLOW-DONE' },
  { when: 'QW-A', text: 'ANS-A' },
  { when: 'QW-B', text: 'ANS-B' },
]);

test('waiting rows: one dim row each (원문 · 나: · 대기 i/n), FIFO delivered once each with unique replies, rows clear; v views the full text read-only', async () => {
  const A = ['QW-A 첫째 대기', 'QW-A 둘째 대기', 'QW-A 셋째 대기', 'QW-A 넷째 대기', 'QW-A 다섯째 대기', 'QW-A 여섯째 대기'].join('\n');
  const B = 'QW-B second waiting line';
  const { run } = await waitDisplayRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    { label: 'two waiting', chunks: [A, '\r', B, '\r'], gapMs: 150,
      until: (screen) => screen.includes('대기 1/2 · 나: QW-A 첫째 대기⏎') && screen.includes(`대기 2/2 · 나: ${B}`) },
    // A kept draft survives under the waiting rows; the waiting rows survive the draft being cleared.
    { label: 'draft kept', text: 'QW-DRAFT-KEEP', enter: false,
      until: (screen) => promptRow(screen).includes('QW-DRAFT-KEEP') && screen.includes(`대기 2/2 · 나: ${B}`) },
    { label: 'draft cleared', keys: '\x7f'.repeat('QW-DRAFT-KEEP'.length),
      until: (screen) => !promptRow(screen).includes('QW-DRAFT-KEEP') && screen.includes('대기 1/2') },
    { label: 'panel', keys: '\x1b[A',
      until: (screen) => /steer · QW-A 첫째/.test(screen) && /steer · QW-B second/.test(screen) },
    // r2 ②: v shows A's six lines read-only, paged to what fits — the queue is untouched.
    { label: 'view', keys: 'v',
      until: (screen) => screen.includes('Queue · steer full text 1/2') && screen.includes('lines 1-4/6') && screen.includes('QW-A 넷째 대기') },
    { label: 'view scrolled', keys: '\x1b[B\x1b[B',
      until: (screen) => screen.includes('lines 3-6/6') && screen.includes('QW-A 여섯째 대기') },
    { label: 'view back to list', keys: 'v',
      until: (screen) => /steer · QW-A 첫째/.test(screen) && !screen.includes('lines 1-4/6') },
    // Reading did not consume: the list still holds both items; Esc closes the panel.
    { label: 'panel closed', keys: '\x1b',
      until: (screen) => !/steer · /.test(screen) && screen.includes('대기 1/2 · 나: QW-A 첫째 대기⏎') },
    // Esc interrupts the turn: the queue drains FIFO — A answered first, then B, each exactly once.
    { label: 'delivered', keys: '\x1b',
      until: (screen) => (screen.split('ANS-A').length - 1) >= 1 && (screen.split('ANS-B').length - 1) >= 1 },
  ], { rows: 32, cols: 120 }, { ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: RULES });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  expect(run.exitCode).toBe(0);
  const delivered = frame('delivered');
  // r2 ①: each waiting utterance got its OWN reply exactly once (A,A would also count 2 with a fixed reply).
  expect(delivered.split('ANS-A').length - 1).toBe(1);
  expect(delivered.split('ANS-B').length - 1).toBe(1);
  // FIFO: the older utterance (A) was answered before B, and the waiting rows are gone.
  expect(delivered.indexOf('ANS-A')).toBeLessThan(delivered.indexOf('ANS-B'));
  expect(delivered).not.toMatch(/대기 \d\/\d/);
  // r2 ② evidence: the read-only view paged the full text while the queue kept both items.
  expect(frame('view')).toContain('lines 1-4/6');
  expect(frame('view back to list')).toMatch(/steer · QW-B second/);
}, 90_000);

test('r2 ③: Enter edit is the separate path — the item leaves the queue (not delivered), the full text returns in the composer, Enter sends it again', async () => {
  const A = 'QW-A 편집용 원문\nQW-A 편집 둘째 줄';
  const B = 'QW-B 편집 참고로 남는 줄';
  const { run } = await waitDisplayRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    { label: 'two waiting', chunks: [A, '\r', B, '\r'], gapMs: 150,
      until: (screen) => screen.includes('대기 1/2 · 나: QW-A 편집용 원문⏎') && screen.includes('대기 2/2') },
    { label: 'panel', keys: '\x1b[A', until: (screen) => /steer · QW-A 편집용/.test(screen) },
    // Enter edit: A is taken OUT of the queue — the waiting rows drop to 1/1 with only B left.
    { label: 'edited out', keys: '\r', until: (screen) => screen.includes('대기 1/1 · 나: QW-B 편집 참고로 남는 줄') },
    // The interrupt drains B only — A must NOT be delivered (it left the queue as «edited»).
    { label: 'delivered B', keys: '\x1b',
      until: (screen) => (screen.split('ANS-B').length - 1) >= 1 && !screen.includes('대기 1/1') },
    // The composer still holds A's full text; Enter sends it as a fresh utterance.
    { label: 're-sent A', keys: '\r', until: (screen) => (screen.split('ANS-A').length - 1) >= 1 },
  ], { rows: 32, cols: 120 }, { ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: RULES });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  expect(run.exitCode).toBe(0);
  const deliveredB = frame('delivered B');
  expect(deliveredB.split('ANS-B').length - 1).toBe(1);
  expect(deliveredB.includes('ANS-A')).toBe(false);
  const resentA = frame('re-sent A');
  expect(resentA.split('ANS-A').length - 1).toBe(1);
  // The edited-out item was never drained: B answered first, A only after the person re-sent it.
  expect(resentA.indexOf('ANS-B')).toBeLessThan(resentA.indexOf('ANS-A'));
}, 90_000);

test('narrow screen: waiting rows cap at two, the rest counted with an ↑ panel path to the full texts', async () => {
  const { run } = await waitDisplayRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    { label: 'three waiting', chunks: ['QW-A 원문 하나', '\r', 'QW-B 원문 둘', '\r', 'QW-C 원문 셋', '\r'], gapMs: 150,
      until: (screen) => screen.includes('대기 1/3 · 나: QW-A 원문 하나') && screen.includes('대기 2/3 · 나: QW-B 원문 둘')
        && screen.includes('대기 외 1건 · ↑ 패널에서 전문') },
    { label: 'panel', keys: '\x1b[A', until: (screen) => /steer · QW-A/.test(screen) && /steer · QW-C/.test(screen) },
  ], { rows: 20, cols: 60 });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  expect(run.exitCode).toBe(0);
  const narrow = frame('three waiting');
  expect(narrow).toContain('대기 외 1건 · ↑ 패널에서 전문');
  expect(narrow).not.toMatch(/대기 3\/3 · 나: QW-C/);
  // ↑ 패널은 잘린 세 번째 원문까지 전문으로 보여 준다.
  expect(frame('panel')).toContain('steer · QW-C 원문 셋');
}, 90_000);

// OP #128451 (JUD-B #128446 · node-b real-PTY repro): on a 60-column screen the full-text view wraps a
// wide-syllable line by TERMINAL CELLS — the end marker (-TAILEND) stays visible, wrapped or scrolled.
// The old code-point wrap left one 97-cell line the render cut at the width (RED at 44919e10b3c → GREEN).
test('r2 ② wrap: a 60-column full-text view wraps wide syllables — the end marker stays on screen', async () => {
  const A = `QW-A ${'가나다라마바사아자차카타파하'.repeat(3)}-TAILEND`;
  const { run } = await waitDisplayRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    { label: 'queued', chunks: [A, '\r'], until: (screen) => screen.includes('대기 1/1') },
    { label: 'panel', keys: '\x1b[A', until: (screen) => /steer · QW-A/.test(screen) },
    { label: 'view', keys: 'v', until: (screen) => screen.includes('-TAILEND') },
    { label: 'down', keys: '\x1b[B', until: (screen) => screen.includes('-TAILEND') },
  ], { rows: 32, cols: 60 });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  expect(run.exitCode).toBe(0);
  // The wrapped second line carries the whole marker; the queue keeps the item (title 1/1).
  expect(frame('view')).toContain('Queue · steer full text 1/1');
  expect(frame('view')).toContain('-TAILEND');
  expect(frame('down')).toContain('-TAILEND'); // a line of scroll keeps the tail on screen too
}, 90_000);