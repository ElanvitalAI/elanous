import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// MSG-SOURCE-HIERARCHY: the harness's own turn (here a ScheduleWakeup firing) is a system message. It used to draw as
// «> [예약 깨움 w1] …» in the person's band; now the structured source draws one dim line and is saved with the turn.
test('a waker turn is saved as from.kind system and draws as a dim line, not as the person', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-message-source-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    let screen = '';
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 120,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAST_WAKEUP_CLOCK: '1', ELANOUS_TUI_GOAL_CONTINUE: '0',
        ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: JSON.stringify([{ when: '[예약 깨움', text: 'SRC-WOKE' }, { when: 'SRC-WAIT', text: 'SRC-WAITING' }]),
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'SRC-WAIT', name: 'ScheduleWakeup', args: { delaySeconds: 60, reason: 'SRC check' } }),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: (current) => /Ctrl\+Q (종료|quit)/.test(current) },
      steps: [
        { label: 'wait', text: 'SRC-WAIT please', until: (current) => current.includes('SRC-WAITING') },
        { label: 'woke', keys: '', until: (current) => { screen = current; return current.includes('SRC-WOKE') && /Worked for/.test(current.slice(current.indexOf('SRC-WOKE'))); } },
      ],
    });
    expect(run.exitCode).toBe(0);
    const transcript = screen.slice(0, screen.lastIndexOf('SRC-WOKE'));
    // TUI-NOTICE-QUIET (대표 11-24): the resume banner is bookkeeping — logged (tui.notice suppressed), not drawn.
    expect(transcript).not.toContain('↻ Resuming (scheduled check)');
    expect(transcript).not.toMatch(/^❯ \[예약 깨움/mu);
    // The person's own turn still draws as the person.
    expect(screen).toMatch(/^❯ SRC-WAIT please/mu);
    const sessionFile = readdirSync(join(root, 'sessions')).find((name) => name.endsWith('.jsonl'))!;
    const users = readFileSync(join(root, 'sessions', sessionFile), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { role: string; content: string; from?: unknown }).filter((row) => row.role === 'user');
    expect(users.find((row) => row.content.startsWith('SRC-WAIT'))?.from).toBeUndefined();
    expect(users.find((row) => row.content.startsWith('[예약 깨움'))?.from).toEqual({ kind: 'system', origin: 'scheduled' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
