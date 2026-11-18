import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence, type SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';

const entry = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const rowsOf = (screen: string): string[] => screen.split('\n');
const promptRow = (screen: string): number => {
  const lines: string[] = rowsOf(screen);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line: string = lines[index]!;
    if (/(?:^|│)❯/.test(line)) return index;
  }
  return -1;
};
const separator = (screen: string): string => rowsOf(screen)[promptRow(screen) - 1] ?? '';
const chatPart = (line: string): string => line.includes('│') ? line.slice(line.indexOf('│') + 1) : line;
const hasSeparator = (screen: string): boolean => promptRow(screen) >= 0 && /^─+$/.test(chatPart(separator(screen)));

async function observe(name: string, steps: SeatPtyStep[]) {
  const root = mkdtempSync(join(tmpdir(), `next-separator-${name}-`));
  const raw: string[] = [];
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [entry, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, cols: 40, rows: 8,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'ready', until: hasSeparator, timeoutMs: 10_000 }, // Source: #37917 PTY test design: 10s boot fail-fast budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
      steps, exitTimeoutMs: 5_000,
      onOutput: chunk => raw.push(chunk),
    });
    if (process.env.ELANOUS_SEPARATOR_PTY_OUT) {
      const out = process.env.ELANOUS_SEPARATOR_PTY_OUT;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${name}.json`), JSON.stringify(run, null, 2));
      writeFileSync(join(out, `${name}.ansi`), raw.join(''));
    }
    expect(run.exitCode).toBe(0);
    return run.frames;
  } finally {
    // mockSeatPtySequence closes its own PTY on timeout; remove only this test's root.
    rmSync(root, { recursive: true, force: true });
  }
}

test('actual entry keeps the minimum-height prompt and omits decoration for a crowded command footer', async () => {
  // Source: entry accepts >=6 rows; OP74082 asks for this exact display/omission boundary.
  const height = 6;
  const frames = await observe('height', [
    { label: 'minimum height', resize: { cols: 40, rows: height }, chunks: ['', ''], gapMs: 200, until: hasSeparator, timeoutMs: 5_000 }, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
    { label: 'crowded command footer', text: '/', enter: false,
      until: screen => screen.includes('/help —') && promptRow(screen) >= 0 && !hasSeparator(screen), timeoutMs: 5_000 }, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
    { label: 'footer dismissed', keys: '\x1b', until: hasSeparator, timeoutMs: 5_000 }, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
  ]);
  const minimum = frames.find(frame => frame.label === 'minimum height')!.screen;
  expect(rowsOf(minimum)).toHaveLength(height);
  // DESIGN §2b (#38392): the status line is the last row; the input sits right above it.
  expect(promptRow(minimum)).toBe(height - 2);
  expect(separator(minimum)).toBe('─'.repeat(40));
  const crowded = frames.find(frame => frame.label === 'crowded command footer')!.screen;
  // At six rows the command title clips; the actual first menu item still renders.
  expect(crowded).toContain('/help —');
  expect(crowded).toContain('❯ /');
  expect(hasSeparator(crowded)).toBe(false);
  expect(hasSeparator(frames.at(-1)!.screen)).toBe(true);
}, 30_000);

test('actual entry sizes the separator to the chat pane through sidebar and width round trips', async () => {
  // Source: OP73500 requires 40/100 columns; OP74082 adds actual sidebar/resize regression.
  const widths = [100, 40, 100] as const;
  const frames = await observe('width', [
    { label: 'wide', resize: { cols: widths[0], rows: 24 }, chunks: ['', ''], gapMs: 200,
      until: screen => hasSeparator(screen) && Bun.stringWidth(separator(screen)) === widths[0], timeoutMs: 5_000 }, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
    { label: 'sidebar open', text: '/side open', until: screen => hasSeparator(screen) && separator(screen).includes('│'), timeoutMs: 5_000 }, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
    ...widths.slice(1).map((cols, index): SeatPtyStep => ({
      label: `sidebar resize ${index}`, resize: { cols, rows: 24 }, chunks: ['', ''], gapMs: 200,
      until: screen => hasSeparator(screen) && separator(screen).includes('│') && Bun.stringWidth(separator(screen)) === cols,
      timeoutMs: 5_000, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
    })),
  ]);
  for (const [index, frame] of frames.slice(1).entries()) {
    const line = separator(frame.screen);
    const width = index <= 1 ? widths[0] : widths[index - 1]!;
    expect(Bun.stringWidth(line)).toBe(width);
    if (index > 0) {
      const left = line.slice(0, line.indexOf('│'));
      expect(chatPart(line)).toBe('─'.repeat(width - Bun.stringWidth(left) - Bun.stringWidth('│')));
      expect(chatPart(line)).not.toBe('─'.repeat(width));
    }
    // DESIGN §2b (#38392): the status line is the last row; the input sits right above it.
    expect(promptRow(frame.screen)).toBe(24 - 2);
  }
}, 30_000);
