import { describe, expect, test } from 'bun:test';
import { formatPaneStatus, paneStatus } from './pane-status.js';

// ELS-PANE-STATUS literals: screens as the els server's PTY renders them (eln working row · prompt · exited · no PTY).
const now = 1_000_000;

describe('els status <pane> — from the PTY the server owns', () => {
  test('eln running a tool: working · tool name and row time · input empty · last output 3s ago', () => {
    const screen = [
      'I will run the tests now.',
      '⠹ Running Bash(bun test src/els) (1m 05s • esc to interrupt)',
      '────────────────',
      '❯ ',
      'Turn running · Model openai-codex/gpt-5 · Queue 0',
    ].join('\n');
    const status = paneStatus({ pane: 'p-1', alive: true, exited: false, screen, lastOutputAt: now - 3_000, now });
    expect(status).toEqual({
      pane: 'p-1', state: 'working', reason: 'screen: ⠹ Running Bash(bun test src/els) (1m 05s • esc to interrupt)',
      inputEmpty: true, lastOutputAgoSec: 3, tool: { name: 'Bash', elapsed: '1m 05s' },
    });
    expect(formatPaneStatus(status)).toBe('p-1 working · Bash 1m 05s · input empty · last output 3s ago');
  });

  test('idle with a half-typed line: idle · input has text · no tool', () => {
    const screen = ['✻ Worked for 12s', '────────────────', '❯ fix the flaky test', 'idle · Model openai-codex/gpt-5'].join('\n');
    const status = paneStatus({ pane: 'p-2', alive: true, exited: false, screen, lastOutputAt: now - 90_000, now });
    expect(status).toMatchObject({ state: 'idle', inputEmpty: false, tool: null, lastOutputAgoSec: 90 });
    expect(formatPaneStatus(status)).toBe('p-2 idle · input has text · last output 90s ago');
  });

  test('what it cannot tell is unknown with a reason — never a guess', () => {
    expect(paneStatus({ pane: 'p-3', alive: true, exited: false, screen: 'make: *** [all] Error 2', lastOutputAt: undefined, now }))
      .toMatchObject({ state: 'unknown', reason: 'no working row and no prompt recognised on screen', inputEmpty: 'unknown', lastOutputAgoSec: null });
    expect(paneStatus({ pane: 'p-4', alive: false, exited: false, screen: undefined, lastOutputAt: undefined, now }))
      .toMatchObject({ state: 'unknown', reason: 'no live PTY (restored after restart: cwd only)' });
    expect(paneStatus({ pane: 'p-5', alive: true, exited: false, screen: undefined, lastOutputAt: now, now }))
      .toMatchObject({ state: 'unknown', reason: 'the screen could not be rendered' });
    expect(paneStatus({ pane: 'p-6', alive: false, exited: true, screen: undefined, lastOutputAt: now - 5_000, now }))
      .toMatchObject({ state: 'exited', lastOutputAgoSec: 5 });
    expect(formatPaneStatus(paneStatus({ pane: 'p-3', alive: true, exited: false, screen: '$', lastOutputAt: undefined, now })))
      .toBe('p-3 unknown · input unknown · last output unknown · (no working row and no prompt recognised on screen)');
  });
});
