import { NEXT_TUI_TITLE } from '../core/render.js';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNextTuiHelpLines, NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../core/registry.js';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';
import { renderNextTuiStatus, runNextTuiStatusBranchRoute } from './status.js';

const REPO_CLI = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');

test('status slash is registered as a lazy branch module', async () => {
  for (const command of ['/status', '/st']) {
    expect(resolveNextTuiRoute(command, NEXT_TUI_INPUT_CONTEXT)?.id).toBe('status');
  }
  expect(buildNextTuiHelpLines().join('\n')).toContain('/status · /st — Model · connection settings · account status');
  const branch = await import(new URL('./status.js', import.meta.url).href);
  expect(branch.runNextTuiStatusBranchRoute).toBe(runNextTuiStatusBranchRoute);
});

test('status simulation shows model, configured connection and selected account together', async () => {
  const lines: string[] = [];
  await runNextTuiStatusBranchRoute('/st', { addLines: (...items) => lines.push(...items) }, () => ({
    provider: 'openai-codex',
    model: 'gpt-sim',
    auth: 'oauth',
    account: { name: 'team-sim', source: 'env' },
  }));

  expect(lines).toEqual([...renderNextTuiStatus({
    provider: 'openai-codex',
    model: 'gpt-sim',
    auth: 'oauth',
    account: { name: 'team-sim', source: 'env' },
  })]);
  expect(lines.join('\n')).toContain('Model: openai-codex / gpt-sim');
  expect(lines.join('\n')).toContain('Connection: OAuth configured · no live connection check');
  expect(lines.join('\n')).toContain('Account: team-sim (selected by env)');
});

test('status never prints credentials and fails closed on missing account metadata', () => {
  const lines = renderNextTuiStatus({
    provider: 'openai-codex', model: 'gpt-sim', auth: 'none', account: null,
  });
  expect(lines.join('\n')).toContain('Connection: Not set');
  expect(lines.join('\n')).toContain('Account: Cannot look up account name for this provider');
  expect(lines.join('\n')).not.toContain('token');
  expect(lines.join('\n')).not.toContain('secret');
});

test('status strips terminal control characters from displayed values', () => {
  const lines = renderNextTuiStatus({
    provider: 'openai-codex\u001b[2J', model: 'gpt\n-sim', auth: 'oauth',
    account: { name: 'team\u0007-sim', source: 'env' },
  });
  expect(lines.join('\n')).not.toContain('\u001b');
  expect(lines.join('\n')).not.toContain('\u0007');
  expect(lines.join('\n')).toContain('gpt -sim');
});

test('status passes the active session to its live snapshot reader', async () => {
  const lines: string[] = [];
  const sessions: Array<string | undefined> = [];
  await runNextTuiStatusBranchRoute('/status', { addLines: (...items) => lines.push(...items), sessionId: 'session-live' }, (sessionId) => {
    sessions.push(sessionId);
    return { provider: 'openai-codex', model: 'gpt-live', auth: 'none', account: { name: 'team-live', source: 'env' } };
  });
  expect(sessions).toEqual(['session-live']);
  expect(lines.join('\n')).toContain('gpt-live');
});

test('isolated next-TUI PTY shares live model status between /st and /status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tui-status-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      llm: { provider: 'openai-codex', model: 'status-sim-model' },
    }));
    const evidence = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      ready: { label: 'boot', until: (screen) => screen.split('\n').includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q quit') },
      steps: [{
        label: 'status-default',
        text: '/st',
        until: (screen) => screen.includes('Model · connection · account status')
          && screen.includes('status-sim-model')
          && screen.includes('Connection: Not set')
          && screen.includes('Account: default'),
      }, {
        label: 'model-deep',
        text: '/model deep',
        // Wide footer «Turn Model: deep …» or the short clause «● Model: deep …» (narrow screen or long path).
        until: (screen) => screen.includes('Model: deep · applies next turn'),
      }, {
        label: 'status-after-model',
        text: '/status',
        until: (screen) => screen.includes('Model · connection · account status')
          && screen.includes('Model: openai-codex / gpt-6.1-sol')
          && screen.includes('Connection: Not set')
          && screen.includes('Account: default'),
      }],
    });
    const screen = evidence.frames.find((frame) => frame.label === 'status-after-model')?.screen ?? '';
    expect(evidence.exitCode).toBe(0);
    expect(screen).toContain('Model: openai-codex / gpt-6.1-sol');
    expect(screen).toContain('Connection: Not set');
    expect(screen).toContain('Account: default');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);
