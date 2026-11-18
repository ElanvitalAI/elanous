import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// NEXT-TUI-TOOL-LOG-NOT-PINNED (OP79969): like classic, a settled turn reads top to bottom as
// user prompt → tool row → answer. Only the status line stays pinned at the bottom.
test('a real isolated Read turn keeps its tool row between the prompt and the answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tool-flow-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const file = join(root, 'flow-notes.txt');
    writeFileSync(file, 'flow line\n');
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 28, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'TOOLFLOW-DONE',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'TOOLFLOW-READ', name: 'Read', args: { file_path: file } }) },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        { label: 'settled', text: 'TOOLFLOW-READ', until: (screen) => screen.includes('TOOLFLOW-DONE') && screen.includes('Read(') },
        // A second, answer-only turn must not drop the first turn's tool row (live check, 11-16 23:0x).
        { label: 'second', text: 'TOOLFLOW-PLAIN', until: (screen) => screen.includes('TOOLFLOW-PLAIN')
          && (screen.match(/TOOLFLOW-DONE/g) ?? []).length >= 2 && (screen.match(/Worked for/g) ?? []).length >= 2 },
      ],
    });
    const lines = (run.frames.find((frame) => frame.label === 'settled')?.screen ?? '').split('\n');
    const row = (needle: string) => lines.findIndex((line) => line.includes(needle));
    expect(run.exitCode).toBe(0);
    expect(lines.some((line) => line.includes('TOOLFLOW-READ'))).toBe(true);
    expect(row('TOOLFLOW-READ')).toBeLessThan(row('Read('));
    expect(row('Read(')).toBeLessThan(row('TOOLFLOW-DONE'));
    const second = (run.frames.find((frame) => frame.label === 'second')?.screen ?? '').split('\n');
    const at = (needle: string) => second.findIndex((line) => line.includes(needle));
    expect(at('TOOLFLOW-READ')).toBeLessThan(at('Read('));
    expect(at('Read(')).toBeLessThan(at('TOOLFLOW-DONE'));
    expect(at('TOOLFLOW-DONE')).toBeLessThan(at('Worked for'));
    // A blank row separates the first turn's marker from the next user row.
    expect(second[at('> TOOLFLOW-PLAIN') - 1]?.trim()).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
