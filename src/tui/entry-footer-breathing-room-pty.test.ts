import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// TUI-FOOTER-BREATHING-ROOM ⑤ (대표 r2): real-PTY captures of the breathing bottom — ③ the conversation-end
// margin, ② one blank row, the old separator right over the input, the input, ① the thin separator
// under it, the bottom status line last (DESIGN §2b) — at 80 · 120 · 200 columns on a 40-row screen,
// folding back to today's tight layout at 24 rows ④. Expected values are literal; the #38392 separator lock keeps its narrow case.
const entry = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const rowsOf = (screen: string): string[] => screen.split('\n');
const promptRowIndex = (screen: string): number => {
  const lines = rowsOf(screen);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/(?:^|│)❯/.test(lines[index]!)) return index;
  }
  return -1;
};
const chatPart = (line: string): string => (line.includes('│') ? line.slice(line.indexOf('│') + 1) : line);
const breathing = (screen: string, cols: number): boolean => {
  const prompt = promptRowIndex(screen);
  const lines = rowsOf(screen);
  return prompt >= 0
    && chatPart(lines[prompt - 1] ?? '') === '─'.repeat(cols) // the old separator stays right over the input (대표 r2)
    && (lines[prompt - 2] ?? 'not blank').trim() === '' // ② the blank row above the separator
    && (lines[prompt - 3] ?? 'not blank').trim() === '' // ③ the conversation-end margin
    && chatPart(lines[prompt + 1] ?? '') === '─'.repeat(cols); // ① the thin separator under the input
};
const folded = (screen: string, cols: number): boolean => {
  const prompt = promptRowIndex(screen);
  return prompt >= 0 && chatPart(rowsOf(screen)[prompt - 1] ?? '') === '─'.repeat(cols);
};

async function observe(name: string, cols: number, rows: number, env: Record<string, string>, steps: Parameters<typeof mockSeatPtySequence>[0]['steps']) {
  const root = mkdtempSync(join(tmpdir(), `footer-room-${name}-`));
  const raw: string[] = [];
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [entry, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, cols, rows, env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ...env,
      },
      ready: { label: 'ready', until: (screen) => breathing(screen, cols), timeoutMs: 10_000 }, // Source: #37917 PTY test design: 10s boot fail-fast budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
      steps, exitTimeoutMs: 5_000,
      onOutput: (chunk) => raw.push(chunk),
    });
    if (process.env.ELANOUS_FOOTER_BREATHING_PTY_OUT) {
      const out = process.env.ELANOUS_FOOTER_BREATHING_PTY_OUT;
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

test('a roomy screen breathes at 80 · 120 · 200 columns and folds to today\'s layout at 24 rows', async () => {
  const frames = await observe('widths', 80, 40, {}, [
    { label: '120 columns', resize: { cols: 120, rows: 40 }, chunks: ['', ''], gapMs: 200, until: (screen) => breathing(screen, 120), timeoutMs: 5_000 }, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
    { label: '200 columns', resize: { cols: 200, rows: 40 }, chunks: ['', ''], gapMs: 200, until: (screen) => breathing(screen, 200), timeoutMs: 5_000 }, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
    { label: '24 rows folds', resize: { cols: 80, rows: 24 }, chunks: ['', ''], gapMs: 200, until: (screen) => folded(screen, 80), timeoutMs: 5_000 }, // Source: #38392 fold boundary (24 rows keeps today's layout) · #37917 PTY test design: 5s local frame-transition budget, not a product SLA.
  ]);
  for (const [cols, label] of [[80, 'ready'], [120, '120 columns'], [200, '200 columns']] as const) {
    const screen = frames.find((frame) => frame.label === label)!.screen;
    const lines = rowsOf(screen);
    const prompt = promptRowIndex(screen);
    expect(lines).toHaveLength(40);
    expect(prompt).toBe(40 - 4); // input · separator · two status rows (TUI-STATUS-3ROW: seat · work)
    expect(chatPart(lines[prompt - 1]!)).toBe('─'.repeat(cols)); // the old rule over the input (대표 r2)
    expect(lines[prompt - 2]!.trim()).toBe(''); // ②
    expect(lines[prompt - 3]!.trim()).toBe(''); // ③
    expect(chatPart(lines[prompt + 1]!)).toBe('─'.repeat(cols)); // ①
    expect(chatPart(lines[39]!).trim()).not.toBe(''); // DESIGN §2b: the bottom status line is the last row
  }
  const narrow = frames.find((frame) => frame.label === '24 rows folds')!.screen;
  const lines = rowsOf(narrow);
  const prompt = promptRowIndex(narrow);
  expect(lines).toHaveLength(24);
  expect(prompt).toBe(24 - 3); // today's tight layout: the separator sits above the input
  expect(chatPart(lines[prompt - 1]!)).toBe('─'.repeat(80));
  expect(chatPart(lines[23]!).trim()).not.toBe('');
}, 45_000);

test('the fold boundary is exactly the compact height: breathing at 25 rows, folded tight at 24, breathing back at 25', async () => {
  // The self-review shouldFix: the 24-row capture checked the input's position but not that the two
  // spare rows actually fold away. With the screen filled by a reply, resizing across the boundary
  // proves both sides: at 25 rows the margin and blank row sit between the transcript's end and the
  // separator; at 24 rows the transcript's end lands right on the separator with no spare rows.
  const reply = Array.from({ length: 36 }, (_, index) => `boundary-filler-${String(index).padStart(2, '0')}`).join('\n');
  const frames = await observe('boundary', 80, 40, { ELANOUS_TEST_FAKE_LLM_RESPONSE: reply }, [
    { label: 'fill', text: 'fill the screen', until: (screen) => screen.includes('boundary-filler-35') && breathing(screen, 80), timeoutMs: 10_000 }, // Source: #37917 PTY test design: 10s local turn budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
    { label: '25 rows breathe', resize: { cols: 80, rows: 25 }, chunks: ['', ''], gapMs: 200, until: (screen) => breathing(screen, 80), timeoutMs: 5_000 }, // Source: #38392 fold boundary (25 rows = first breathing height) · #37917 PTY test design: 5s local frame-transition budget, not a product SLA.
    { label: '24 rows fold', resize: { cols: 80, rows: 24 }, chunks: ['', ''], gapMs: 200, until: (screen) => folded(screen, 80), timeoutMs: 5_000 }, // Source: #38392 fold boundary (24 rows keeps today's layout) · #37917 PTY test design: 5s local frame-transition budget, not a product SLA.
    { label: 'back to 25', resize: { cols: 80, rows: 25 }, chunks: ['', ''], gapMs: 200, until: (screen) => breathing(screen, 80), timeoutMs: 5_000 }, // Source: #38392 fold boundary (25 rows = first breathing height) · #37917 PTY test design: 5s local frame-transition budget, not a product SLA.
  ]);
  const at25 = frames.find((frame) => frame.label === '25 rows breathe')!.screen;
  {
    const lines = rowsOf(at25);
    const prompt = promptRowIndex(at25);
    expect(lines).toHaveLength(25);
    expect(prompt).toBe(25 - 4); // input · ① separator · two status rows
    expect(chatPart(lines[prompt + 1]!)).toBe('─'.repeat(80)); // the separator under the input
    expect(lines[prompt - 2]!.trim()).toBe(''); // ② the blank row
    expect(lines[prompt - 3]!.trim()).toBe(''); // ③ the conversation-end margin
    expect(chatPart(lines[prompt - 4]!).trim()).not.toBe(''); // the transcript sits above the margin, not in it
  }
  const at24 = frames.find((frame) => frame.label === '24 rows fold')!.screen;
  {
    const lines = rowsOf(at24);
    const prompt = promptRowIndex(at24);
    expect(lines).toHaveLength(24);
    expect(prompt).toBe(24 - 3); // today's tight layout: the separator sits directly above the input
    expect(chatPart(lines[prompt - 1]!)).toBe('─'.repeat(80)); // the separator over the input
    expect(chatPart(lines[prompt - 2]!).trim()).not.toBe(''); // the transcript's end lands right on the separator — the spare rows folded away
  }
  const back25 = frames.find((frame) => frame.label === 'back to 25')!.screen;
  {
    const lines = rowsOf(back25);
    const prompt = promptRowIndex(back25);
    expect(lines).toHaveLength(25);
    expect(lines[prompt - 2]!.trim()).toBe(''); // the spare rows returned the moment the height crossed back over the boundary
    expect(lines[prompt - 3]!.trim()).toBe('');
  }
}, 60_000);

test('the breathing rows and the separator are plain structure, not color: a NO_COLOR terminal keeps them', async () => {
  // A light terminal cannot rely on the divider's dim color: the rows themselves carry the layout.
  const frames = await observe('no-color', 80, 40, { NO_COLOR: '1' }, [
    { label: 'plain re-capture', chunks: [''], until: (screen) => breathing(screen, 80), timeoutMs: 5_000 }, // Source: #37917 PTY test design: 5s local frame-transition budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
  ]);
  const screen = frames[0]!.screen;
  const lines = rowsOf(screen);
  const prompt = promptRowIndex(screen);
  expect(lines).toHaveLength(40);
  expect(prompt).toBe(40 - 4);
  expect(lines[prompt - 1]!).toBe('─'.repeat(80)); // the old rule over the input, literal in NO_COLOR
  expect(lines[prompt - 2]!.trim()).toBe('');
  expect(lines[prompt - 3]!.trim()).toBe('');
  expect(lines[prompt + 1]!).toBe('─'.repeat(80)); // no SGR in a NO_COLOR render: the row is the literal rule
  expect(lines[39]!.trim()).not.toBe('');
}, 30_000);

test('a conversation that fills the screen keeps the breathing rows between its end and the separator', async () => {
  // The self-review shouldFix: the captures above boot into an empty transcript, so they prove the rows
  // only with nothing above. A 36-line reply overflows a 40-row screen: the transcript scrolls, the
  // conversation's end lands right over the margin row, and the breathing rows must hold there too.
  const reply = Array.from({ length: 36 }, (_, index) => `breathing-filler-${String(index).padStart(2, '0')}`).join('\n');
  const frames = await observe('filled', 80, 40, { ELANOUS_TEST_FAKE_LLM_RESPONSE: reply }, [
    { label: 'fill', text: 'fill the screen', until: (screen) => screen.includes('breathing-filler-35') && breathing(screen, 80), timeoutMs: 10_000 }, // Source: #37917 PTY test design: 10s local turn budget, not a product SLA; src/ux-sim/mock-seat-pty-sequence.ts capture deadline.
  ]);
  const screen = frames.at(-1)!.screen;
  const lines = rowsOf(screen);
  const prompt = promptRowIndex(screen);
  expect(lines).toHaveLength(40);
  expect(prompt).toBe(40 - 4); // input · ① separator · two status rows (TUI-STATUS-3ROW) — the block kept its rows
  expect(chatPart(lines[prompt - 1]!)).toBe('─'.repeat(80)); // the old rule right over the input (대표 r2)
  expect(lines[prompt - 2]!.trim()).toBe(''); // ② the blank row
  expect(lines[prompt - 3]!.trim()).toBe(''); // ③ the conversation-end margin
  expect(chatPart(lines[prompt - 4]!).includes('✻')).toBe(true); // the transcript's last row — the turn marker — sits right over the margin
  expect(chatPart(lines[prompt - 6]!)).toContain('breathing-filler-35'); // the overflowing reply fills the screen right under the marker
  expect(chatPart(lines[39]!).trim()).not.toBe(''); // DESIGN §2b: the bottom status line stays last
}, 45_000);
