import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV } from '../ux-sim/fake-llm.js';

// ELN-QUEUE-ITEM-CONTROLS (내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG` §6): during a running turn, Up on an
// empty composer opens the queue panel; Tab moves an item between steer and queue, Delete cancels it, Enter takes
// it back into the composer for editing (it leaves the queue, so no drain can send it meanwhile).
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SLOW = 'QC-SLOW';
// 출처: src/tui/entry-steer-pty.test.ts SLOW_MS — long enough to type during the first model request.
const SLOW_MS = '8000';
// The footer says «Turn running» only where the wide sentence fits with the folder and version (≥120 columns and a
// short enough path); otherwise the short clause «● running 3s». Either one means the turn is running.
// A running turn: the footer's turn clause, or (status line at the bottom, #38392) the progress row above the input.
const running = (screen: string) => /Turn running|● running|응답 중|esc to interrupt/.test(screen);
const promptRow = (screen: string) => screen.split('\n').filter((row) => row.trimStart().startsWith('❯')).at(-1) ?? '';

test('queue panel: Up opens it during a turn, Tab moves steer↔queue, Delete cancels, Enter edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-queue-controls-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 32, cols: 120,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'QC-DONE', [TEST_FAKE_LLM_DELAY_MS_ENV]: SLOW_MS, [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW,
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        { label: 'slow', text: `${SLOW} 시작`, until: running },
        { label: 'two sent', chunks: ['QC-ONE 첫 말', '\r', 'QC-TWO 둘째 말', '\r'], gapMs: 150,
          until: (screen) => /Steer 2|S2·Q0|Queue 2|Q2/.test(screen) },
        { label: 'panel', keys: '\x1b[A', until: (screen) => screen.includes('QC-ONE') && screen.includes('QC-TWO') && /steer ·|queued ·/.test(screen) },
        // The open panel takes the footer's place, so the rows themselves are the evidence.
        { label: 'toggled', keys: '\t', until: (screen) => /queued · QC-ONE/.test(screen) && /steer · QC-TWO/.test(screen) },
        // The selection followed QC-ONE to its new row; Delete cancels it.
        { label: 'cancelled', keys: '\x1b[3~', until: (screen) => !screen.includes('QC-ONE') && /steer · QC-TWO/.test(screen) },
        { label: 'edit', keys: '\r', until: (screen) => screen.includes('Editing queued item') },
      ],
    });
    const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
    expect(run.exitCode).toBe(0);
    // Both sends wait as steers by default (#38023) and the footer splits the count.
    expect(frame('two sent')).toMatch(/Steer 2|S2·Q0/);
    expect(frame('panel')).toContain('Tab steer↔queue · Delete cancel · Enter edit · Esc close');
    // Tab moved QC-ONE to queue; steer rows stay first (invariant 1).
    const toggled = frame('toggled').split('\n');
    expect(toggled.findIndex((row) => row.includes('steer · QC-TWO'))).toBeLessThan(toggled.findIndex((row) => row.includes('queued · QC-ONE')));
    // Enter took the remaining item into the composer and closed the panel; nothing is left to drain.
    const edited = frame('edit');
    expect(promptRow(edited)).toContain('QC-TWO');
    expect(edited).not.toContain('steer · QC-TWO');
    expect(edited).not.toMatch(/Steer [1-9]|Queue [1-9]|S[1-9]·|Q[1-9]\b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

test('#38095 r1: typing with the panel open closes it and goes to the composer; Backspace and Enter never touch an item', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-queue-controls-typing-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const waiting = (count: number) => (screen: string) => new RegExp(`Steer ${count} · Queue 0|S${count}·Q0`).test(screen);
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 32, cols: 120,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'QC-DONE', [TEST_FAKE_LLM_DELAY_MS_ENV]: SLOW_MS, [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW,
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        { label: 'slow', text: `${SLOW} 시작`, until: running },
        { label: 'one sent', text: 'QC-KEEP 남길 말', until: waiting(1) },
        { label: 'panel', keys: '\x1b[A', until: (screen) => /steer · QC-KEEP/.test(screen) },
        // A letter closes the panel and lands in the composer.
        { label: 'typed', text: 'x', enter: false, until: (screen) => promptRow(screen).includes('x') && !/steer · QC-KEEP/.test(screen) },
        // Backspace deletes the letter; the waiting item is still there.
        { label: 'backspace', keys: '\x7f', until: (screen) => !promptRow(screen).includes('x') && waiting(1)(screen) },
        // A new line sent with Enter is a new item; the draft and the old item are both kept.
        { label: 'new line', text: 'QC-NEW 새 말', until: waiting(2) },
      ],
    });
    const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
    expect(run.exitCode).toBe(0);
    expect(frame('typed')).not.toContain('Editing queued item');
    expect(frame('backspace')).not.toContain('Queued item cancelled');
    expect(frame('new line')).toMatch(/Steer 2 · Queue 0|S2·Q0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

// ELN-QUEUE-ITEM-CONTROLS live check (11-18, #38369): Esc on the open panel must close only the panel — the turn keeps
// running and nothing leaves the queue. It used to reach the busy-turn handler first: the turn stopped and an item went
// to the composer. Ctrl+C remains the interrupt with the panel open; with no panel, Esc interrupts as before.
const ESC_ENV = (root: string) => ({
  ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
  ELANOUS_TEST_FAKE_LLM_RESPONSE: 'QC-DONE', [TEST_FAKE_LLM_DELAY_MS_ENV]: SLOW_MS, [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW,
});
const twoWaiting = (screen: string) => /Steer 2 · Queue 0|S2·Q0/.test(screen);
const stopped = (screen: string) => /중단|Stopped|Interrupted|cancelled/.test(screen);
async function escRun(steps: Parameters<typeof mockSeatPtySequence>[0]['steps']) {
  const root = mkdtempSync(join(tmpdir(), 'next-queue-controls-esc-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    return await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 32, cols: 120, env: ESC_ENV(root),
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const toPanel = [
  { label: 'slow', text: `${SLOW} 시작`, until: running },
  { label: 'two sent', chunks: ['QC-ONE 첫 말', '\r', 'QC-TWO 둘째 말', '\r'], gapMs: 150, until: twoWaiting },
  { label: 'panel', keys: '\x1b[A', until: (screen: string) => /steer · QC-ONE/.test(screen) && /steer · QC-TWO/.test(screen) },
];

test('Esc on the open queue panel closes it; the turn keeps running and both items still wait', async () => {
  // The turn's own progress row («⠇ Thinking (7s • esc to interrupt) · 2 queued») is the running evidence: the footer
  // keeps the panel's «Queue closed» answer as its status until the next event, so the footer is not the place to look.
  const progress = (screen: string) => {
    const match = /\((\d+)s • esc to interrupt\) · 2 queued/.exec(screen);
    return match ? Number(match[1]) : undefined;
  };
  let secondsAtEsc: number | undefined;
  // 출처: #38369 — the progress row counts whole seconds; this many more after Esc = the same turn kept running.
  const STILL_RUNNING_SECONDS = 2;
  // 출처: #38369 — room for those seconds plus a slow frame on a loaded host.
  const STILL_RUNNING_TIMEOUT_MS = 8000;
  const run = await escRun([
    ...toPanel,
    { label: 'esc', keys: '\x1b', until: (screen) => {
      if (/steer · QC-ONE/.test(screen) || !screen.includes('Queue closed')) return false;
      secondsAtEsc = progress(screen);
      return secondsAtEsc !== undefined;
    } },
    { label: 'still running', text: '', enter: false, until: (screen) => (progress(screen) ?? -1) >= (secondsAtEsc ?? 0) + STILL_RUNNING_SECONDS,
      timeoutMs: STILL_RUNNING_TIMEOUT_MS },
  ]);
  expect(run.exitCode).toBe(0);
  const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
  for (const label of ['esc', 'still running']) {
    expect(stopped(frame(label))).toBe(false);
    expect(frame(label)).not.toContain('Editing queued item');
    expect(frame(label)).toMatch(/Steer 2 · Queue 0|S2·Q0/);
  }
  expect(progress(frame('still running'))! - secondsAtEsc!).toBeGreaterThanOrEqual(STILL_RUNNING_SECONDS);
}, 90_000);

test('Ctrl+C with the queue panel open still interrupts the turn', async () => {
  const run = await escRun([...toPanel, { label: 'ctrl-c', keys: '\x03', until: stopped }]);
  expect(run.exitCode).toBe(0);
  expect(stopped(run.frames.find((entry) => entry.label === 'ctrl-c')?.screen ?? '')).toBe(true);
}, 90_000);

test('Esc with no panel open still interrupts the running turn (unchanged)', async () => {
  const run = await escRun([
    { label: 'slow', text: `${SLOW} 시작`, until: running },
    { label: 'esc', keys: '\x1b', until: stopped },
  ]);
  expect(run.exitCode).toBe(0);
  expect(stopped(run.frames.find((entry) => entry.label === 'esc')?.screen ?? '')).toBe(true);
}, 90_000);
