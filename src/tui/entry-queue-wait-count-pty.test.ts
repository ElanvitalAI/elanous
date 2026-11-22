import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV } from '../ux-sim/fake-llm.js';

// OP #129544 (대표 ①②③, on top of #39556): while a turn runs the base screen keeps — ① one dim
// row per waiting person utterance, each «대기 i/n · 나: 원문», visually apart from the active
// turn (dim + its own waiting mark, never looking active) — ② a head row «사람 대기 N개» counting
// PERSON utterances, separate from the alarm/notice queued count — ③ when the turn ends the
// oldest waiting utterance goes active first and the remaining count updates (FIFO, N 갱신).
// OP #129538: the same session captures the base-screen evidence for the ops check (three
// waiting person rows visible with their marks).
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SLOW = 'QW2-SLOW';
// 15s: long enough to type into, short enough for the natural-end step within the test budget
// (#39579's lesson — a 120s slow mock blew the 60s step timeout).
const SLOW_MS = '15000';
const running = (screen: string) => /Turn running|● running|응답 중|esc to interrupt/.test(screen);

async function waitCountRun(
  steps: Parameters<typeof mockSeatPtySequence>[0]['steps'],
  { rows, cols }: { rows: number; cols: number },
  extraEnv: Record<string, string> = {},
  artifactPath?: string,
  onOutput?: (chunk: string, atMs: number) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'next-queue-wait-count-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    return {
      run: await mockSeatPtySequence({
        executable: process.execPath,
        args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows, cols, steps,
        ...(artifactPath ? { artifactPath } : {}),
        ...(onOutput ? { onOutput } : {}),
        env: {
          ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          [TEST_FAKE_LLM_DELAY_MS_ENV]: SLOW_MS, [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW,
          ...extraEnv,
        },
        ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      }),
      root,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// Unique replies prove per-utterance delivery order (the #39556 r2 lesson: a shared reply
// cannot tell A,A from A,B).
const RULES = JSON.stringify([
  { when: SLOW, text: 'QW2-SLOW-DONE' },
  { when: 'QW2-A', text: 'ANS2-A' },
  { when: 'QW2-B', text: 'ANS2-B' },
  { when: 'QW2-C', text: 'ANS2-C' },
]);

// ①+②: two and three consecutive person rows — each its own «대기 i/n» row under the
// «사람 대기 N개» head row; the active turn stays visually apart (the waiting rows are dim
// with their own mark — nothing active-looking). ③: the turn ends by itself, the oldest
// waiting utterance goes active first, each answered once in FIFO order, the count drops to
// zero and every waiting row clears.
test('OP #129544 ①②③: consecutive person utterances — head row 사람 대기 N개, one dim 대기 i/n row each, natural turn end drains FIFO and clears the rows', async () => {
  const { run } = await waitCountRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    // ② first: TWO consecutive person lines → head row says 2, each line its own row.
    { label: 'two waiting', chunks: ['QW2-A 첫째 사람 줄', '\r', 'QW2-B 둘째 사람 줄', '\r'], gapMs: 150,
      until: (screen) => screen.includes('사람 대기 2개') && screen.includes('대기 1/2 · 나: QW2-A 첫째 사람 줄') && screen.includes('대기 2/2 · 나: QW2-B 둘째 사람 줄') },
    // OP #129538 evidence frame: three waiting person rows with marks on the base screen.
    { label: 'three waiting', chunks: ['QW2-C 셋째 사람 줄', '\r'], gapMs: 150,
      until: (screen) => screen.includes('사람 대기 3개') && screen.includes('대기 3/3 · 나: QW2-C 셋째 사람 줄') },
    // ③ the slow turn ends by itself → A (oldest) goes active first, FIFO, each exactly once,
    // and the waiting rows + count clear from the base screen.
    { label: 'drained', until: (screen) => (screen.split('ANS2-A').length - 1) >= 1 && (screen.split('ANS2-B').length - 1) >= 1 && (screen.split('ANS2-C').length - 1) >= 1, timeoutMs: 90_000 },
    { label: 'cleared', until: (screen) => !screen.includes('사람 대기') && !/대기 \d\/\d/.test(screen), timeoutMs: 30_000 },
    // OP #129538/#129544 evidence: the run keeps every frame's screen verbatim (kept root).
  ], { rows: 32, cols: 120 }, { ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: RULES }, '/tmp/qwc-run1-evidence.json');
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  expect(run.exitCode).toBe(0);
  const two = frame('two waiting');
  // ① each person row is its own row with its own waiting mark; the active turn is elsewhere.
  expect(two).toContain('대기 1/2 · 나: QW2-A 첫째 사람 줄');
  expect(two).toContain('대기 2/2 · 나: QW2-B 둘째 사람 줄');
  // ② the head row counts person utterances (2), not the alarm queued count.
  expect(two).toContain('사람 대기 2개');
  // ③ FIFO once-each: A before B before C; nothing waited after the drain.
  const drained = frame('drained');
  expect(drained.split('ANS2-A').length - 1).toBe(1);
  expect(drained.split('ANS2-B').length - 1).toBe(1);
  expect(drained.split('ANS2-C').length - 1).toBe(1);
  expect(drained.indexOf('ANS2-A')).toBeLessThan(drained.indexOf('ANS2-B'));
  expect(drained.indexOf('ANS2-B')).toBeLessThan(drained.indexOf('ANS2-C'));
  // The count and every waiting row cleared once nothing waited.
  expect(frame('cleared')).not.toMatch(/사람 대기 \d개/);
}, 120_000);

// The narrow screen keeps the contract: the head row survives the cap, the rest is counted
// with the ↑ panel path (the #39556 cap contract unchanged, one head row above it).
test('narrow screen: the 사람 대기 N개 head row survives the 2-row cap — the rest counted via the panel', async () => {
  const { run } = await waitCountRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    { label: 'four waiting', chunks: ['QW2-A 원문 하나', '\r', 'QW2-B 원문 둘', '\r', 'QW2-C 원문 셋', '\r', 'QW2-D 원문 넷', '\r'], gapMs: 150,
      until: (screen) => screen.includes('사람 대기 4개') && screen.includes('대기 2/4') && screen.includes('대기 외 2건 · ↑ 패널에서 전문') },
    { label: 'panel', keys: '\x1b[A', until: (screen) => /steer · QW2-A/.test(screen) && /steer · QW2-D/.test(screen) },
  ], { rows: 20, cols: 60 }, { ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: RULES });
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  expect(run.exitCode).toBe(0);
  const narrow = frame('four waiting');
  expect(narrow).toContain('사람 대기 4개');
  expect(narrow).toContain('대기 외 2건 · ↑ 패널에서 전문');
  expect(narrow).not.toMatch(/대기 3\/4 · 나: QW2-C/);
  expect(frame('panel')).toContain('steer · QW2-D 원문 넷');
}, 90_000);

// JUD-C #130094 ①② (OP #130100, on top of #129544 ③): the same real-PTY run asserts EVERY
// activation step — ① the head row «사람 대기 N개» drops per turn (N=3 → 2 → 1 → gone) while
// the oldest waiting row goes active first (FIFO: A then B then C; the activated row leaves
// the waiting rows, the rest re-index) — and ② the waiting rows carry their color SGR in the
// RAW PTY bytes while the active replies stay plain (a waiting row never looks active).
test('turn-by-turn: each activation drops 사람 대기 N and moves the FIFO row; waiting rows carry the SGR, replies stay plain', async () => {
  let raw = '';
  // Every turn (SLOW and A/B/C alike) holds ~6s: each intermediate screen persists long
  // enough for the step poller to catch and assert it.
  const { run } = await waitCountRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    { label: 'three waiting', chunks: ['QW2-A 첫째 사람 줄', '\r', 'QW2-B 둘째 사람 줄', '\r', 'QW2-C 셋째 사람 줄', '\r'], gapMs: 150,
      until: (screen) => screen.includes('사람 대기 3개') && screen.includes('대기 3/3 · 나: QW2-C 셋째 사람 줄') },
    // ① slow ends → A (oldest) activates: N 3 → 2, A's waiting row is gone, B/C re-index.
    { label: 'a active', until: (screen) => screen.includes('사람 대기 2개') && screen.includes('대기 1/2 · 나: QW2-B 둘째 사람 줄') && screen.includes('대기 2/2 · 나: QW2-C 셋째 사람 줄') && !/대기 \d\/\d · 나: QW2-A/.test(screen) && !screen.includes('ANS2-A') },
    // ① A's reply lands → B activates: N 2 → 1, only C waits.
    { label: 'b active', until: (screen) => (screen.split('ANS2-A').length - 1) >= 1 && screen.includes('사람 대기 1개') && screen.includes('대기 1/1 · 나: QW2-C 셋째 사람 줄') && !/대기 \d\/\d · 나: QW2-[AB]/.test(screen) && !screen.includes('ANS2-B') },
    // ① B's reply lands → C activates: the head row and every waiting row are gone.
    { label: 'c active', until: (screen) => (screen.split('ANS2-B').length - 1) >= 1 && !/사람 대기 \d개/.test(screen) && !/대기 \d\/\d/.test(screen) && !screen.includes('ANS2-C') },
    { label: 'drained', until: (screen) => (screen.split('ANS2-C').length - 1) >= 1, timeoutMs: 90_000 },
  ], { rows: 32, cols: 120 }, {
    ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: RULES,
    [TEST_FAKE_LLM_DELAY_WHEN_ENV]: 'QW2',
    [TEST_FAKE_LLM_DELAY_MS_ENV]: '6000',
  }, '/tmp/qwc-turnbyturn-evidence.json', (chunk) => { raw += chunk; });
  // JUD-C #130310 ① / OP #130315 ①: persist the RAW PTY bytes (escapes included) as a file bound
  // to this exact-head run — the dim waiting-row SGR vs the plain active replies, byte-wise.
  writeFileSync('/tmp/qwc-turnbyturn-raw.txt', raw);
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  expect(run.exitCode).toBe(0);
  // ① each captured step, in order: 3 → 2 → 1 → gone, FIFO activation each step.
  const three = frame('three waiting');
  expect(three).toContain('사람 대기 3개');
  expect(three).toContain('대기 1/3 · 나: QW2-A 첫째 사람 줄');
  expect(three).toContain('대기 2/3 · 나: QW2-B 둘째 사람 줄');
  expect(three).toContain('대기 3/3 · 나: QW2-C 셋째 사람 줄');
  const aActive = frame('a active');
  expect(aActive).toContain('사람 대기 2개');
  expect(aActive).toContain('대기 1/2 · 나: QW2-B 둘째 사람 줄');
  expect(aActive).toContain('대기 2/2 · 나: QW2-C 셋째 사람 줄');
  expect(aActive).not.toMatch(/대기 \d\/\d · 나: QW2-A/);
  expect(aActive).not.toContain('ANS2-A');
  const bActive = frame('b active');
  expect(bActive.split('ANS2-A').length - 1).toBeGreaterThanOrEqual(1);
  expect(bActive).toContain('사람 대기 1개');
  expect(bActive).toContain('대기 1/1 · 나: QW2-C 셋째 사람 줄');
  expect(bActive).not.toMatch(/대기 \d\/\d · 나: QW2-[AB]/);
  expect(bActive).not.toContain('ANS2-B');
  const cActive = frame('c active');
  expect(cActive.split('ANS2-B').length - 1).toBeGreaterThanOrEqual(1);
  expect(cActive).not.toMatch(/사람 대기 \d개/);
  expect(cActive).not.toMatch(/대기 \d\/\d/);
  expect(cActive).not.toContain('ANS2-C');
  expect(frame('drained').split('ANS2-C').length - 1).toBeGreaterThanOrEqual(1);
  // ② a color SGR escape (truecolor `38;2;r;g;b` or 256-color `38;5;n`) sits immediately before
  // every occurrence of every waiting mark in the raw PTY bytes, and before none of the
  // replies — the waiting rows are the dim-looking ones, the active replies stay plain.
  const occurrences = (text: string, corpus: string) => {
    const found: number[] = [];
    let index = corpus.indexOf(text);
    while (index !== -1) { found.push(index); index = corpus.indexOf(text, index + 1); }
    return found;
  };
  const colorSgrJustBefore = (corpus: string, index: number) =>
    /\x1b\[(?:38;2;\d{1,3};\d{1,3};\d{1,3}|38;5;\d{1,3})m$/.test(corpus.slice(Math.max(0, index - 32), index));
  for (const mark of [
    '사람 대기 3개', '사람 대기 2개', '사람 대기 1개',
    '대기 1/3 · 나: QW2-A 첫째 사람 줄', '대기 2/3 · 나: QW2-B 둘째 사람 줄', '대기 3/3 · 나: QW2-C 셋째 사람 줄',
    '대기 1/2 · 나: QW2-B 둘째 사람 줄', '대기 2/2 · 나: QW2-C 셋째 사람 줄', '대기 1/1 · 나: QW2-C 셋째 사람 줄',
  ]) {
    const found = occurrences(mark, raw);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((index) => colorSgrJustBefore(raw, index))).toBe(true);
  }
  for (const reply of ['ANS2-A', 'ANS2-B', 'ANS2-C']) {
    const found = occurrences(reply, raw);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((index) => !colorSgrJustBefore(raw, index))).toBe(true);
  }
  // OP #130683 (JUD-C #130680 필수 — r4): the contract is the WAITING human rows vs the ACTIVE
  // (currently-processing) human row — not the assistant replies. Parse both rows' own SGR run
  // from the same raw PTY bytes: every waiting mark sits right after the dim decoration (a
  // fg-color run — `38;5;n` here; a truecolor `38;2;r;g;b` run is the same decoration at another
  // color level), while the active human utterance row — the QW2-SLOW line that started the
  // running turn, its composer echo and its chat row — never does: its own run is the plain
  // input/chat attributes, so the two human-row attribute sets differ.
  const dimColorRunBefore = (corpus: string, index: number) =>
    /\x1b\[(?:38;2;\d{1,3};\d{1,3};\d{1,3}|38;5;\d{1,3})m$/.test(corpus.slice(Math.max(0, index - 32), index)); // 출처: #39585 — 32-char lookback = the row's own paint run (the \x1b[..H cursor move and \x1b[2K clear never end in `m`), same granularity as the ② helper
  const activeHumanRow = occurrences(`${SLOW} 시작`, raw);
  const waitingRow = occurrences('대기 1/3 · 나: QW2-A 첫째 사람 줄', raw);
  expect(activeHumanRow.length).toBeGreaterThan(0);
  expect([
    waitingRow.every((index) => dimColorRunBefore(raw, index)),
    activeHumanRow.every((index) => !dimColorRunBefore(raw, index)),
  ]).toEqual([true, true]);
}, 120_000);
