import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { createSession, updateSessionMeta } from '../session/index.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const promptAtBottom = (screen: string): boolean => screen.split('\n').slice(-2).some((line) => line.includes('❯'));

test('open side tab first PTY frame retains pre-TUI shell history across repaint and toggle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-sidetab-shell-history-'));
  const sessionsRoot = join(root, 'sessions');
  const marker = 'UX_PRE_TUI_SHELL_MARKER_1112';
  const events: Array<{ kind: 'output'; chunk: string } | { kind: 'resize'; cols: number; rows: number }> = [];
  const captures: Array<{ label: string; eventCount: number }> = [];
  const raw: string[] = [];
  let repaintStart = 0;
  try {
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const session = createSession({ source: 'tui' }, sessionsRoot);
    updateSessionMeta(session.id, (meta) => { meta.uiState = { ...meta.uiState, sidetabOpen: true }; }, sessionsRoot);
    const command = `printf '\n${marker}\n'; exec ${quote(process.execPath)} ${quote(BIN)} ${quote(`--test=${root}`)} --config-dir ${quote(root)} --test-state-dir ${quote(root)} --resume ${quote(session.id)} --tui next`;
    const repainted = (screen: string): boolean => {
      const afterResize = raw.slice(repaintStart).join('');
      return afterResize.includes('세션') && afterResize.includes('❯')
        && screen.includes('항목 없음') && promptAtBottom(screen);
    };
    const captureAt = (label: string, predicate: (screen: string) => boolean) => (screen: string): boolean => {
      if (!predicate(screen)) return false;
      captures.push({ label, eventCount: events.length });
      return true;
    };
    const run = await mockSeatPtySequence({
      executable: '/bin/sh', args: ['-c', command], root, rows: 8, cols: 40,
      env: { ELANOUS_SESSION_ROOT: sessionsRoot, ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '8',
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'first compact open', until: captureAt('first compact open', (screen) => screen.includes('항목 없음') && promptAtBottom(screen)) },
      steps: [
        { label: 'general open', resize: { cols: 80, rows: 24 }, until: captureAt('general open', repainted) },
        { label: 'compact again open', resize: { cols: 40, rows: 8 }, until: captureAt('compact again open', repainted) },
        { label: 'side tab closed', keys: '\x1c', until: captureAt('side tab closed', (screen) => !screen.includes('항목 없음') && promptAtBottom(screen)) },
        { label: 'side tab reopened', keys: '\x1c', until: captureAt('side tab reopened', (screen) => screen.includes('항목 없음') && promptAtBottom(screen)) },
      ],
      quitKeys: '\x11',
      onOutput: (chunk) => { raw.push(chunk); events.push({ kind: 'output', chunk }); },
      onResize: (cols, rows) => { repaintStart = raw.length; events.push({ kind: 'resize', cols, rows }); },
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames.map((frame) => frame.label)).toEqual([
      'first compact open', 'general open', 'compact again open', 'side tab closed', 'side tab reopened',
    ]);
    for (const frame of run.frames) expect(promptAtBottom(frame.screen)).toBe(true);
    expect(run.frames[0]!.screen).toContain('항목 없음');
    expect(run.frames[1]!.screen).toContain('항목 없음');
    expect(run.frames[2]!.screen).toContain('항목 없음');
    expect(run.frames[3]!.screen).not.toContain('항목 없음');
    expect(run.frames[4]!.screen).toContain('항목 없음');
    expect(captures.map(({ label }) => label)).toEqual(run.frames.map(({ label }) => label));
    for (const capture of captures) {
      const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 200, allowProposedApi: true });
      try {
        for (const event of events.slice(0, capture.eventCount)) {
          if (event.kind === 'resize') terminal.resize(event.cols, event.rows);
          else await new Promise<void>((done) => terminal.write(event.chunk, done));
        }
        const history = Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
          terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
        expect(history.filter((line) => line.includes(marker)), capture.label).toHaveLength(1);
        const viewportContainsMarker = (): boolean => Array.from({ length: terminal.rows }, (_, row) =>
          terminal.buffer.normal.getLine(terminal.buffer.normal.viewportY + row)?.translateToString(true) ?? '').join('\n').includes(marker);
        let markerReachable = viewportContainsMarker();
        while (terminal.buffer.normal.viewportY > 0 && !markerReachable) {
          terminal.scrollPages(-1);
          markerReachable = viewportContainsMarker();
        }
        expect(markerReachable, capture.label).toBe(true);
      } finally {
        terminal.dispose();
      }
    }
    if (process.env.ELANOUS_SIDETAB_SHELL_HISTORY_OUT) {
      const out = process.env.ELANOUS_SIDETAB_SHELL_HISTORY_OUT;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'pty.ansi'), raw.join(''));
      writeFileSync(join(out, 'frames.json'), JSON.stringify({ sessionId: session.id, frames: run.frames, exitCode: run.exitCode }, null, 2));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
