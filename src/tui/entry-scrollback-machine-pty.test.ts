import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { sidetabWidthForTerminal } from '../sidetab-core/model.js';
import { mockSeatPtySequence, type SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';

type RawEvent = { data: string } | { resize: { cols: number; rows: number } };
const reply = Array.from({ length: 36 }, (_, index) => `MACHINE-${String(index).padStart(2, '0')}`);
const toggle = (label: string, open: boolean): SeatPtyStep => ({
  label, chunks: ['\x1c', 'x'], gapMs: 100,
  until: (screen) => open ? screen.includes('│') : !screen.includes('│') && screen.includes('❯'),
});
const settleResize = (label: string, cols: number, rows: number, open: boolean): SeatPtyStep => ({
  label, resize: { cols, rows }, chunks: ['', ''], gapMs: 350,
  until: (screen) => screen.includes('❯') && (!open || screen.includes('│')),
});

// Remaining rows of 내부 문서 `next-tui-scrollback-state-machine` §4.
const TRANSITIONS: { name: string; steps: SeatPtyStep[]; layoutChanges: string[]; resizeMarker: string | null }[] = [
  { name: 'sidetab width open-close-reopen', steps: [
    { label: 'reply', text: 'long before side toggle', until: (screen: string) => screen.includes(reply.at(-1)!) && screen.includes("완료 ·") },
    toggle('open', true), toggle('close', false), toggle('reopen', true),
  ], layoutChanges: ['open', 'close', 'reopen'], resizeMarker: null },
  { name: 'open sidetab physical width resize', steps: [
    toggle('open', true),
    { label: 'reply', text: 'long before resize', until: (screen: string) => screen.includes(reply.at(-1)!) && screen.includes("완료 ·") },
    settleResize('width 50', 50, 8, true),
  ], layoutChanges: ['open'], resizeMarker: '── resize 50x8 ──' },
  { name: 'reply settlement with sidetab toggle', steps: [
    { label: 'reply and toggle', text: 'long during side toggle', chunks: ['\x1c', 'x'], gapMs: 100,
      until: (screen: string) => screen.includes('│') && screen.includes(reply.at(-1)!) },
  ], layoutChanges: ['reply and toggle'], resizeMarker: null },
  { name: 'compact-general-compact height roundtrip', steps: [
    { label: 'reply', text: 'long before mode roundtrip', until: (screen: string) => screen.includes(reply.at(-1)!) && screen.includes("완료 ·") },
    settleResize('general 40x12', 40, 12, false),
    settleResize('compact 40x8', 40, 8, false),
  ], layoutChanges: [], resizeMarker: '── resize 40x8 ──' },
  { name: 'PageUp width resize then return to tail', steps: [
    { label: 'reply', text: 'long before PageUp', until: (screen: string) => screen.includes(reply.at(-1)!) && screen.includes("완료 ·") },
    { label: 'PageUp', keys: '\x1b[5~', until: (screen: string) => screen.includes('턴 로그') && !screen.includes(reply.at(-1)!) },
    settleResize('resize while scrolled', 50, 8, false),
    { label: 'return to tail', chunks: Array.from({ length: 5 }, () => '\x1b[6~'), gapMs: 100,
      until: (screen: string) => screen.includes('❯') },
  ], layoutChanges: [], resizeMarker: '── resize 50x8 ──' },
];

for (const scenario of TRANSITIONS) {
  test(`scrollback state machine PTY: ${scenario.name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'next-scrollback-machine-'));
    const raw: RawEvent[] = [];
    const artifactDir = process.env.ELANOUS_SCROLLBACK_MACHINE_ARTIFACT_DIR;
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, cols: 40, rows: 8,
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_NEXT_TUI_COMPACT_HEIGHT: '8',
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: reply.join('\n') },
        ready: { label: 'boot', until: (screen) => screen.includes('❯') },
        steps: [...scenario.steps], quitKeys: '\x11',
        onOutput: (data) => raw.push({ data }),
        onResize: (cols, rows) => raw.push({ resize: { cols, rows } }),
        artifactPath: artifactDir ? join(artifactDir, `${scenario.name.replaceAll(' ', '-')}.json`) : undefined,
      });
      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true });
        const name = scenario.name.replaceAll(' ', '-');
        writeFileSync(join(artifactDir, `${name}.ansi`), raw.flatMap((event) => 'data' in event ? [event.data] : []).join(''));
        writeFileSync(join(artifactDir, `${name}.events.json`), JSON.stringify(raw, null, 2));
      }
      const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 500, allowProposedApi: true });
      try {
        for (const event of raw) {
          if ('resize' in event) terminal.resize(event.resize.cols, event.resize.rows);
          else await new Promise<void>((done) => terminal.write(event.data, done));
        }
        expect(run.exitCode).toBe(0);
        const history = Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
          terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
        for (const line of reply) expect(history.filter((row) => row.includes(line))).toHaveLength(1);
        let recovered = false;
        while (terminal.buffer.normal.viewportY > 0) {
          terminal.scrollPages(-1);
          const visible = Array.from({ length: terminal.rows }, (_, index) =>
            terminal.buffer.normal.getLine(terminal.buffer.normal.viewportY + index)?.translateToString(true) ?? '');
          if (visible.some((row) => row.includes(reply[0]!))) { recovered = true; break; }
        }
        expect(recovered).toBe(true);
        if (scenario.resizeMarker) expect(history.filter((row) => row === scenario.resizeMarker)).toHaveLength(1);
        const expectedLayouts = new Map<string, number>();
        for (const label of scenario.layoutChanges) {
          const frame = run.frames.find((item) => item.label === label);
          expect(frame).toBeDefined();
          if (frame!.screen.includes('│')) expect(frame!.screen.split('\n')[0]).toContain('세션');
          const width = 40;
          const chatWidth = frame!.screen.includes('│') ? width - sidetabWidthForTerminal(width) - 1 : width;
          const marker = `── layout chat ${chatWidth}x8 ──`;
          expectedLayouts.set(marker, (expectedLayouts.get(marker) ?? 0) + 1);
        }
        for (const [marker, count] of expectedLayouts) expect(history.filter((row) => row === marker)).toHaveLength(count);
        if (scenario.name === 'reply settlement with sidetab toggle')
          expect(history.findIndex((row) => row.startsWith('── layout chat'))).toBeLessThan(
            history.findIndex((row) => row.includes(reply[0]!)));
      } finally { terminal.dispose(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
}
