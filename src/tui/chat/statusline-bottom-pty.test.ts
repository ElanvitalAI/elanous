// DESIGN §2b (대표 11-18): the status line is the last row, under the input (Claude Code's place) — `position: bottom`,
// the default. The progress row stays above the input; while a turn runs the bottom line does not repeat the turn.
// `position: above-input` keeps the old place. Real PTY at 24 rows, 80 and 120 columns.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV } from '../../ux-sim/fake-llm.js';

const REPO_CLI = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');
const SLOW = 'SB-SLOW';
// 출처: entry-steer-pty.test.ts SLOW_MS — long enough to look at the screen during the first model request.
const SLOW_MS = '8000';
// 출처: #38292 footer-24-rows-pty.test.ts — the slow first request (SLOW_MS) plus the reply and a loaded host.
const SETTLE_TIMEOUT_MS = 20_000;

/** The non-empty rows of the screen, top to bottom. */
const rowsOf = (screen: string) => screen.split('\n').map((row) => row.trimEnd()).filter((row) => row.trim() !== '');
const promptIndex = (rows: readonly string[]) => rows.map((row) => row.trimStart().startsWith('❯')).lastIndexOf(true);

async function session(cols: number, extraYaml?: string) {
  const root = mkdtempSync(join(tmpdir(), 'sb-'));
  const folder = basename(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  if (extraYaml) writeFileSync(join(root, 'statusline.yaml'), extraYaml);
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'SB short reply', [TEST_FAKE_LLM_DELAY_MS_ENV]: SLOW_MS, [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW,
      },
      ready: { label: 'boot', until: (screen) => screen.includes(folder) && promptIndex(rowsOf(screen)) >= 0 },
      steps: [
        { label: 'running', text: `${SLOW} go`, until: (screen) => /esc to interrupt/.test(screen) && screen.includes(folder) },
        // Settled: the reply is on screen and no progress row is left (wherever the status line sits).
        { label: 'answered', text: '', enter: false, until: (screen) => screen.includes('SB short reply') && !/esc to interrupt/.test(screen), timeoutMs: SETTLE_TIMEOUT_MS },
      ],
    });
    return { run, folder };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const cols of [80, 120]) {
  test(`${cols}×24: the status line is the last row, under the input — idle, running and after the turn`, async () => {
    const { run, folder } = await session(cols);
    expect(run.exitCode).toBe(0);
    for (const label of ['boot', 'running', 'answered']) {
      const rows = rowsOf(run.frames.find((frame) => frame.label === label)?.screen ?? '');
      // TUI-STATUS-3ROW: the last two rows are the status — the seat row (folder · build) over the work row — and the
      // input is the row right above them.
      const seatRow = rows.at(-2) ?? '';
      expect(seatRow).toContain(folder);
      expect(seatRow).toMatch(/\bdev\b/);
      expect(rows.at(-1)).toMatch(/\bQueue \d+ · Bg \d+\b/);
      expect(promptIndex(rows)).toBe(rows.length - 3);
    }
    // While the turn runs, the progress row (above the input) says it; the bottom line does not repeat the turn.
    const running = rowsOf(run.frames.find((frame) => frame.label === 'running')!.screen);
    const progress = running.findIndex((row) => /esc to interrupt/.test(row));
    expect(progress).not.toBe(-1);
    expect(progress).toBeLessThan(promptIndex(running));
    expect(running.at(-1)).not.toMatch(/running|Turn |Thinking|Responding/);
    expect(running.at(-2)).not.toMatch(/running|Turn |Thinking|Responding/);
  }, 90_000);
}

test('position: above-input keeps the old place — the status line is above the input, the input is last', async () => {
  const { run, folder } = await session(120, 'position: above-input\n');
  expect(run.exitCode).toBe(0);
  const rows = rowsOf(run.frames.find((frame) => frame.label === 'boot')!.screen);
  expect(promptIndex(rows)).toBe(rows.length - 1);
  const statusAt = rows.findIndex((row) => row.includes(folder) && /\bdev\b/.test(row));
  expect(statusAt).not.toBe(-1);
  expect(statusAt).toBeLessThan(promptIndex(rows));
}, 90_000);

// #38392 r2 ①: on a 24-row screen an open panel never takes the status line away — it stays the last row.
test('80×24 with the command picker open: the status line is still the last row, the input right above it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sbp-'));
  const folder = basename(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: (screen) => screen.includes(folder) && promptIndex(rowsOf(screen)) !== -1 },
      steps: [{ label: 'picker', text: '/', enter: false, until: (screen) => screen.includes('/help') }],
    });
    expect(run.exitCode).toBe(0);
    const rows = rowsOf(run.frames.find((frame) => frame.label === 'picker')!.screen);
    expect(rows.at(-2)).toContain(folder);
    expect(promptIndex(rows)).toBe(rows.length - 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
