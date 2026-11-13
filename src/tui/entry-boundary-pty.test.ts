import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { mockSeatPtySequence, type SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';

// Input × state boundary table. Every run exits on the compact primary screen.
const BOUNDARY_CASES = [
  { sidetab: 'closed', output: 'short', exit: 'Ctrl+Q', lines: ['BOUNDARY-SHORT-0', 'BOUNDARY-SHORT-1'] },
  { sidetab: 'open', output: 'short', exit: 'Ctrl+Q', lines: ['BOUNDARY-SHORT-0', 'BOUNDARY-SHORT-1'] },
  { sidetab: 'closed', output: 'long', exit: 'Ctrl+Q', lines: Array.from({ length: 36 }, (_, i) => `BOUNDARY-LONG-${String(i).padStart(2, '0')}`) },
  { sidetab: 'open', output: 'long', exit: 'Ctrl+Q', lines: Array.from({ length: 36 }, (_, i) => `BOUNDARY-LONG-${String(i).padStart(2, '0')}`) },
] as const;

for (const boundary of BOUNDARY_CASES) {
  test(`compact input boundary: sidetab ${boundary.sidetab}, ${boundary.output} output, ${boundary.exit} preserves old lines for PageUp`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'next-boundary-pty-'));
    const raw: string[] = [];
    const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 500, allowProposedApi: true });
    let pending = Promise.resolve();
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      const steps: SeatPtyStep[] = [];
      if (boundary.sidetab === 'open') steps.push({ label: 'sidetab open', chunks: ['\x1c', 'x'], gapMs: 100,
        until: (screen) => screen.includes('항목 없음') });
      steps.push({ label: 'reply', text: 'boundary output probe',
        until: (screen) => screen.includes(boundary.lines.at(-1)!) });
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 8, cols: 40,
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '8',
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: boundary.lines.join('\n') },
        ready: { label: 'boot', until: (screen) => screen.includes('❯') },
        steps,
        quitKeys: '\x11',
        onOutput: (chunk) => { raw.push(chunk); pending = pending.then(() => new Promise<void>((done) => terminal.write(chunk, done))); },
        artifactPath: process.env.ELANOUS_BOUNDARY_ARTIFACT_DIR
          ? join(process.env.ELANOUS_BOUNDARY_ARTIFACT_DIR, `boundary-${boundary.sidetab}-${boundary.output}.json`) : undefined,
      });
      await pending;
      if (process.env.ELANOUS_BOUNDARY_ARTIFACT_DIR) {
        mkdirSync(process.env.ELANOUS_BOUNDARY_ARTIFACT_DIR, { recursive: true });
        writeFileSync(join(process.env.ELANOUS_BOUNDARY_ARTIFACT_DIR, `boundary-${boundary.sidetab}-${boundary.output}.ansi`), raw.join(''));
      }
      expect(run.exitCode).toBe(0);
      expect(run.frames.at(-1)?.screen).toContain('❯');
      if (boundary.sidetab === 'open') expect(run.frames.at(-1)?.screen).toContain('항목 없음');
      const history = Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
        terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
      const oldest = boundary.lines[0]!;
      const newest = boundary.lines.at(-1)!;
      expect(history.some((line) => line.includes(oldest))).toBe(true);
      expect(history.some((line) => line.includes(newest))).toBe(true);
      for (const line of boundary.lines) expect(history.filter((row) => row.includes(line))).toHaveLength(1);
      const visibleAtExit = Array.from({ length: terminal.rows }, (_, row) =>
        terminal.buffer.normal.getLine(terminal.buffer.normal.viewportY + row)?.translateToString(true) ?? '');
      let foundOnPageUp = visibleAtExit.some((line) => line.includes(oldest));
      if (boundary.output === 'long') expect(foundOnPageUp).toBe(false);
      while (!foundOnPageUp && terminal.buffer.normal.viewportY > 0) {
        terminal.scrollPages(-1);
        const visible = Array.from({ length: terminal.rows }, (_, row) =>
          terminal.buffer.normal.getLine(terminal.buffer.normal.viewportY + row)?.translateToString(true) ?? '');
        if (visible.some((line) => line.includes(oldest))) { foundOnPageUp = true; break; }
      }
      expect(foundOnPageUp).toBe(true);
    } finally {
      terminal.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
}
