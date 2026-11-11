import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { NEXT_TUI_TITLE } from './core/render.js';

function latestTurnIsSettled(screen: string, reply: string, expectedReplies: number): boolean {
  const replies = screen.split(reply).length - 1;
  if (replies !== expectedReplies) return false;
  const lastReply = screen.lastIndexOf(reply);
  const tail = screen.slice(lastReply + reply.length);
  const terminal = /(?:턴 완료|응답 완료|✔ 완료)(?:\s|$)/.exec(tail);
  if (!terminal) return false;
  const nextPrompt = tail.search(/\n(?:❯ |나: )/);
  return nextPrompt < 0 || terminal.index < nextPrompt;
}

test('next TUI edits at the cursor and applies Ctrl+W/U in a real PTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-input-edit-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 80,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'typed', text: 'alpha beta gamma', enter: false, until: '❯ alpha beta gamma' },
        { label: 'cursor-left', keys: '\x1b[D', until: '❯ alpha beta gamma' },
        { label: 'insert-at-cursor', keys: 'X', until: '❯ alpha beta gammXa' },
        { label: 'Ctrl+W', keys: '\x17', until: '❯ alpha beta a' },
        { label: 'Ctrl+U', keys: '\x15', until: (s) => s.endsWith('❯ ') },
      ],
    });
    expect(run.frames.map((f) => f.label)).toEqual(['boot', 'typed', 'cursor-left', 'insert-at-cursor', 'Ctrl+W', 'Ctrl+U']);
    expect(run.frames[3]?.screen).toContain('alpha beta gammXa');
    expect(run.frames[4]?.screen).not.toContain('gamm');
    expect(run.frames[5]?.screen).toEndWith('❯ ');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('classic and next PTYs recall submitted prompts with Up and restore the draft with Down', async () => {
  const runMode = async (mode: 'classic' | 'next') => {
    const root = mkdtempSync(join(tmpdir(), `tui-input-history-${mode}-`));
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      const reply = 'history-reply';
      const next = mode === 'next';
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', mode],
        artifactPath: process.env.NT3_NEXT_TUI_HISTORY_RECEIPT_DIR
          ? join(process.env.NT3_NEXT_TUI_HISTORY_RECEIPT_DIR, `${mode}.json`)
          : undefined,
        root, rows: 24, cols: 80,
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: reply },
        ready: { label: `${mode} boot`, until: (screen) => next
          ? screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Enter 전송')
          : (screen.includes('elanous | daemon') || screen.includes('Opening web setup…')) && screen.includes('❯') },
        steps: [
          { label: 'first submitted prompt', text: 'first remembered', until: (s) => latestTurnIsSettled(s, reply, 1) },
          { label: 'second submitted prompt', text: 'second remembered', until: (s) => latestTurnIsSettled(s, reply, 2) },
          { label: 'unsent draft', text: 'current draft', enter: false, until: '❯ current draft' },
          { label: 'Up recalls latest prompt', keys: '\x1b[A', until: '❯ second remembered' },
          { label: 'Down restores draft', keys: '\x1b[B', until: '❯ current draft' },
        ],
      });
      expect(run.frames.find((frame) => frame.label === 'Up recalls latest prompt')?.screen).toContain('❯ second remembered');
      expect(run.frames.find((frame) => frame.label === 'Down restores draft')?.screen).toContain('❯ current draft');
      expect(run.exitCode).toBe(0);
      return run;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const classic = await runMode('classic');
  const next = await runMode('next');
  for (const mode of [classic, next]) {
    expect(mode.frames.find((frame) => frame.label === 'Up recalls latest prompt')?.screen).toContain('second remembered');
    expect(mode.frames.find((frame) => frame.label === 'Down restores draft')?.screen).toContain('current draft');
  }
}, 90_000);
