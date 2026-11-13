import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { ansi } from '../tui-terminal-contract.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

function isolatedRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  return root;
}

test('actual showNextTui open sidetab first paint preserves prior shell rows once', async () => {
  const root = isolatedRoot('next-firstpaint-sidetab-');
  const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 200, allowProposedApi: true });
  let pending = Promise.resolve();
  const code = `process.stdout.write('SHELL-PRIOR-A\\r\\nSHELL-PRIOR-B\\r\\n'); await import(${JSON.stringify(join(import.meta.dir, 'entry.ts'))}).then(({ showNextTui }) => showNextTui({ sidetabMode: 'open', compactHeight: 8 }));`;
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath, args: ['-e', code], root, cols: 40, rows: 8,
      env: { ELANOUS_CONFIG_DIR: root, ELANOUS_SESSION_ROOT: join(root, 'sessions') },
      ready: { label: 'open sidetab first paint', until: (screen) => screen.includes('│') && screen.includes('❯') },
      steps: [{ label: 'first frame', keys: '', until: (screen) => screen.includes('│') && screen.includes('❯') }],
      onOutput: (chunk) => { pending = pending.then(() => new Promise<void>((done) => terminal.write(chunk, done))); },
    });
    await pending;
    expect(run.exitCode).toBe(0);
    const history = Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
      terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
    expect(history.filter((row) => row.includes('SHELL-PRIOR-A'))).toHaveLength(1);
    expect(history.filter((row) => row.includes('SHELL-PRIOR-B'))).toHaveLength(1);
  } finally {
    terminal.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('actual showNextTui compact to general and back restores mouse capture', async () => {
  const root = isolatedRoot('next-mouse-roundtrip-');
  const raw: string[] = [];
  const resizeOffsets: number[] = [];
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, cols: 40, rows: 8,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '8' },
      ready: { label: 'compact boot', until: (screen) => screen.includes('❯') },
      steps: [
        { label: 'general mouse on', resize: { cols: 40, rows: 12 }, chunks: ['', ''], gapMs: 350,
          until: (screen) => screen.includes('❯') && raw.slice(resizeOffsets[0]).join('').includes(ansi.mouseOn) },
        { label: 'compact mouse off', resize: { cols: 40, rows: 8 }, chunks: ['', ''], gapMs: 350,
          until: (screen) => screen.includes('❯') && raw.slice(resizeOffsets[1]).join('').includes(ansi.mouseOff) },
      ],
      onOutput: (chunk) => raw.push(chunk),
      onResize: () => resizeOffsets.push(raw.length),
    });
    expect(run.exitCode).toBe(0);
    expect(raw.slice(resizeOffsets[0], resizeOffsets[1]).join('')).toContain(ansi.mouseOn);
    expect(raw.slice(resizeOffsets[1]).join('')).toContain(ansi.mouseOff);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('mouse wheel scrolls older chat after compact to general transition', async () => {
  const root = isolatedRoot('next-mouse-scroll-transition-');
  const raw: string[] = [];
  const resizeOffsets: number[] = [];
  const reply = Array.from({ length: 45 }, (_, index) => `MOUSE-TRANSITION-${String(index).padStart(2, '0')}`).join('\n');
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, cols: 80, rows: 8,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '8',
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: reply },
      ready: { label: 'compact boot', until: (screen) => screen.includes('❯') },
      steps: [
        { label: 'settled compact reply', text: 'mouse transition probe',
          until: (screen) => screen.includes('MOUSE-TRANSITION-44') && screen.includes('턴 완료') },
        { label: 'general after compact', resize: { cols: 80, rows: 24 }, chunks: ['', ''], gapMs: 350,
          until: (screen) => screen.includes('MOUSE-TRANSITION-44') && raw.slice(resizeOffsets[0]).join('').includes(ansi.mouseOn) },
        { label: 'wheel up in general', keys: '\x1b[<64;30;10M',
          until: (screen) => screen.includes('MOUSE-TRANSITION-41') && !screen.includes('MOUSE-TRANSITION-44') },
      ],
      onOutput: (chunk) => raw.push(chunk),
      onResize: () => resizeOffsets.push(raw.length),
    });
    expect(run.exitCode).toBe(0);
    expect(raw.slice(resizeOffsets[0]).join('')).toContain(ansi.mouseOn);
    expect(run.frames.at(-1)?.screen).not.toContain('MOUSE-TRANSITION-44');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
