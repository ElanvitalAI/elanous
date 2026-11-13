import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { mockSeatPtySequence, type SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';

type RawEvent = { data: string } | { resize: { cols: number; rows: number } };

async function probe(name: string, steps: SeatPtyStep[], env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'next-scrollback-jud5682-'));
  const raw: RawEvent[] = [];
  const artifactDir = process.env.ELANOUS_SCROLLBACK_JUD5682_ARTIFACT_DIR;
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, cols: 40, rows: 8,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '8',
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ...env },
      ready: { label: 'boot', until: (screen) => screen.includes('❯') },
      steps, quitKeys: '\x11',
      onOutput: (data) => raw.push({ data }),
      onResize: (cols, rows) => raw.push({ resize: { cols, rows } }),
      artifactPath: artifactDir ? join(artifactDir, `${name}.json`) : undefined,
    });
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, `${name}.ansi`), raw.flatMap((event) => 'data' in event ? [event.data] : []).join(''));
      writeFileSync(join(artifactDir, `${name}.events.json`), JSON.stringify(raw, null, 2));
    }
    const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 500, allowProposedApi: true });
    try {
      for (const event of raw) {
        if ('resize' in event) terminal.resize(event.resize.cols, event.resize.rows);
        else await new Promise<void>((done) => terminal.write(event.data, done));
      }
      const history = Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
        terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
      return { run, history };
    } finally { terminal.dispose(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('scrollback state machine PTY: unfinished stream input and sidetab chrome stay out of resize segments', async () => {
  const { run, history } = await probe('volatile-stream-boundaries', [
    { label: 'unfinished stream', text: 'stream probe', until: (screen) => screen.includes('STREAM-ONLY') && screen.includes('턴 스트리밍') },
    { label: 'unsent input', text: 'DRAFT-ONLY', enter: false, until: (screen) => screen.includes('DRAFT-ONLY') },
    { label: 'layout', chunks: ['\x1c', 'x'], gapMs: 100, until: (screen) => screen.includes('│') && screen.includes('❯') },
    { label: 'physical resize', resize: { cols: 50, rows: 8 }, chunks: ['', ''], gapMs: 350,
      until: (screen) => screen.includes('│') && screen.includes('❯') },
  ], { ELANOUS_TEST_FAKE_LLM_SCRIPT: 'stall:STREAM-ONLY', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'NEVER-FINAL' });
  expect(run.exitCode).toBe(0);
  const layout = history.indexOf('── layout chat 26x8 ──');
  const resized = history.indexOf('── resize 50x8 ──');
  expect(history).toContain('── layout chat 26x8 ──');
  expect(resized).toBeGreaterThan(layout);
  expect(history.slice(0, layout).some((row) => row.includes('STREAM-ONLY') || row.includes('DRAFT-ONLY'))).toBe(false);
  expect(history.slice(layout + 1, resized).some((row) => row.includes('STREAM-ONLY') || row.includes('DRAFT-ONLY') || row.includes('세션 ·'))).toBe(false);
}, 120_000);

test('scrollback state machine PTY: folding an already committed tool result never replays old chat', async () => {
  const prelude = Array.from({ length: 36 }, (_, index) => `FOLD-HISTORY-${String(index).padStart(2, '0')}-{step}`);
  const toolLines = Array.from({ length: 24 }, (_, index) => `FOLD-TOOL-${String(index).padStart(2, '0')}`);
  const command = `printf '%s\\n' ${toolLines.map((line) => `'${line}'`).join(' ')}`;
  const { run, history } = await probe('fold-committed-result', [
    { label: 'committed prelude', text: 'prelude', until: (screen) => screen.includes('FOLD-HISTORY-35-1') },
    { label: 'foldable tool settled', text: 'fold probe', until: (screen) => screen.includes('FOLD-HISTORY-35-2') },
    { label: 'browse tool result', chunks: [
      ...Array.from({ length: 3 }, () => '\x1b[5~'), ...Array.from({ length: 5 }, () => '\x1b[A')], gapMs: 100,
      until: (screen) => screen.includes('턴 로그') && screen.includes('Bash') },
    { label: 'expand committed tool', chunks: ['\r', ''], gapMs: 350, until: (screen) => screen.includes('❯') },
    { label: 'return to tail', chunks: Array.from({ length: 5 }, () => '\x1b[6~'), gapMs: 100,
      until: (screen) => screen.includes('❯') },
  ], { ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'fold probe', name: 'Bash', args: { command } }),
    ELANOUS_TEST_FAKE_LLM_RESPONSE: prelude.join('\n') });
  expect(run.exitCode).toBe(0);
  expect(run.frames.find((frame) => frame.label === 'expand committed tool')?.screen).toContain('FOLD-TOOL-23');
  expect(history.filter((row) => row.includes('▸ 도구 Bash') && row.includes('(접힘)'))).toHaveLength(1);
  for (const line of prelude) {
    const firstTurn = line.replace('{step}', '1');
    expect(history.filter((row) => row.includes(firstTurn))).toHaveLength(1);
  }
}, 120_000);
