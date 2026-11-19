// ELS-FIRST-RUN acceptance — red tests for the first `els` run on an empty ledger (OP orders/ELS-FIRST-RUN-UX-1119, UX seat).
// These run red until the HAND-ELN-ELS implementation lands: the hint line is English (this file fixes the wording), the
// SGR bytes must reach the attached terminal untouched, and key→screen latency must stay under 50ms p95.
// 출처: ~/elanous-hq/seat-state/OP/orders/ELS-FIRST-RUN-UX-1119.md «① 수용 시험» — red on main, green after the implementation PR.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';
import { requestEls } from '../els/client.js';
import { elsSocketPath } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

// NUMGUARD — timeout literals get named constants (동작 0 변경, OP ⚡ #38964 수리 · #38971 상수화 꼴)
/** 출처: #37153 live PTY readiness bound — 셸 프롬프트(`│…$`)가 화면에 뜰 때까지의 여유. */
const READY_TIMEOUT_MS = 30_000;
/** 출처: #37153 live PTY step bound — ready 직후 즉시 렌더되는 정지 화면(안내줄), 왕복 불필요. */
const HINT_TIMEOUT_MS = 5_000;
/** 출처: #37153 live PTY step bound — 셸 프롬프트로 한 번 왕복하는 여유. */
const STEP_TIMEOUT_MS = 15_000;
/** 출처: #37153 live PTY 시험 감싸개 — mock PTY 시퀀스 전체 상한(ready+steps+quit). */
const TEST_TIMEOUT_MS = 120_000;
/** 출처: #37153 live PTY p95 시험 감싸개 — 20샘플 지연 측정 전체 상한. */
const P95_TEST_TIMEOUT_MS = 300_000;

/** The one-line English hint the status line must show verbatim (UX-fixed wording — OP order ②). */
export const FIRST_RUN_HINT = 'ctrl+b c new shell · a chat · s list · j/k move · x close · q quit · ? help';

/** The production ledger this test must never touch (~/.elanous/els/journal.json → ELANOUS_STATE_DIR). */
const prodJournal = process.env.HOME ? join(process.env.HOME, '.elanous', 'els', 'journal.json') : '';
const prodPaneCount = (): number => {
  try { return (JSON.parse(readFileSync(prodJournal, 'utf8')) as { panes: unknown[] }).panes.length; } catch { return 0; }
};

test('first run: bare els on an empty state dir opens exactly one shell pane, attaches to it, and the English hint line is the last line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-first-'));
  const folder = basename(root);
  const panesBefore = prodPaneCount();
  let pid = 0;
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side'],
      root, rows: 24, cols: 120,
      env: { SHELL: '/bin/sh', NODE_ENV: 'development' },
      ready: { label: 'shell-attached', timeoutMs: READY_TIMEOUT_MS, until: (screen) => screen.split('\n').some((line) => line.includes('│') && line.includes('$')) }, // 출처: #37153 live PTY readiness bound
      steps: [
        // ② the hint line, verbatim, as the visible last line of the screen
        { label: 'hint-line', text: '', until: (screen) => screen.split('\n').at(-1) === FIRST_RUN_HINT, timeoutMs: HINT_TIMEOUT_MS }, // 출처: #37153 live PTY step bound — ready 직후 즉시 렌더되는 정지 화면, 왕복 불필요
      ],
      quitKeys: '\u0002q',
    });
    expect(run.exitCode).toBe(0);
    // ① exactly one pane, alive — the ledger (`ls`) is the truth, not the paint
    const socket = elsSocketPath(root);
    pid = Number((await requestEls(socket, { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
    expect(Number.isNaN(pid)).toBe(false);
    const listed = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { ptyId: string; state: string }[] };
    expect(listed.panes).toHaveLength(1);
    expect(listed.panes.map((p) => [p.state === 'exited', p.ptyId !== ''])).toEqual([[false, true]]);
    // ⑤ the run left the production ledger untouched
    expect(prodPaneCount()).toBe(panesBefore);
    // evidence: the last screen keeps the marker for the report
    expect(run.frames.at(-1)!.screen).toContain(folder);
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test('first run: SGR colours survive the attach — \\e[31m…\\e[0m from the pane reaches the terminal bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-sgr-'));
  let pid = 0;
  try {
    let sawRed = false;
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side'],
      root, rows: 24, cols: 120,
      env: { SHELL: '/bin/sh', NODE_ENV: 'development' },
      ready: { label: 'shell-attached', timeoutMs: READY_TIMEOUT_MS, until: (screen) => screen.split('\n').some((line) => line.includes('│') && line.includes('$')) }, // 출처: #37153 live PTY readiness bound
      onOutput: (chunk) => { if (chunk.includes('\u001b[31m')) sawRed = true; },
      steps: [
        { label: 'red-printed', text: `printf '\\e[31mred\\e[0m'`, until: (screen) => screen.split('\n').some((line) => line.includes('│red')), timeoutMs: STEP_TIMEOUT_MS }, // 출처: #37153 live PTY step bound — 셸 프롬프트 왕복 여유
      ],
      quitKeys: '\u0002q',
    });
    expect(run.exitCode).toBe(0);
    // ③ the attach view must forward the pane's SGR escape bytes, not strip them
    expect(sawRed).toBe(true);
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test('first run: key→screen echo latency p95 ≤ 50ms (20 samples, measured on the raw attach frames)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-p95-'));
  let pid = 0;
  try {
    // The device measures write→output-chunk latencies (onStepInput fires after the typed text, before Enter).
    const samples: number[] = [];
    let typedAt = 0;
    // Current-step marker + first-matching-chunk filter: only the FIRST chunk containing THIS step's marker
    // (e.g. LAT_7_) after the key (onStepInput) is a sample. The elanous TUI repaints the pane on a ~150ms
    // cadence, so later chunks re-emit the same marker line at +150/235/272ms — harness repaint noise,
    // not key→screen-echo latency (which arrives within ~2-5ms of the key).
    let currentMarker = '';
    let armed = false;
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side'],
      root, rows: 24, cols: 120,
      env: { SHELL: '/bin/sh', NODE_ENV: 'development' },
      ready: { label: 'shell-attached', timeoutMs: READY_TIMEOUT_MS, until: (screen) => screen.split('\n').some((line) => line.includes('│') && line.includes('$')) }, // 출처: #37153 live PTY readiness bound
      onStepInput: (label, atMs) => { typedAt = atMs; currentMarker = `LAT_${label.slice('lat-'.length)}_`; armed = true; },
      onOutput: (chunk, atMs) => {
        if (armed && chunk.includes(currentMarker)) { samples.push(atMs - typedAt); armed = false; }
      },
      steps: Array.from({ length: 20 }, (_, i) => ({
        label: `lat-${i}`,
        // `text` is written, then (after 150ms) Enter; the echo of the marker line is the measured frame
        text: `echo LAT_${i}_${Date.now() % 1000}`,
        until: (screen: string) => screen.split('\n').some((line: string) => line.includes(`│LAT_${i}_`)),
        timeoutMs: STEP_TIMEOUT_MS, // 출처: #37153 live PTY step bound — 셸 프롬프트 왕복 여유
      })),
      quitKeys: '\u0002q',
    });
    expect(run.exitCode).toBe(0);
    expect(samples.length).toBeGreaterThanOrEqual(10);
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
    // ④ OP order: keys must show up on screen within 50ms p95
    expect(p95).toBeLessThanOrEqual(50);
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, P95_TEST_TIMEOUT_MS);
