import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskNotificationQueue } from '../agent/task-notification.js';
import { startClassicSidetabMissionPair } from '../dashboard/classic-sidetab-mission-pair.js';
import { createClassicSidetabMissionPairSessionRegistry } from '../dashboard/classic-sidetab-mission.js';
import { classifyAgentStartupScreen, isAgentInputPrompt, runVisibleAgentMission } from './visible-agent-mission.js';

test('visible agent readiness recognizes real Codex and Claude prompt placeholders', () => {
  expect(isAgentInputPrompt('› Ask Codex to do anything')).toBe(true);
  expect(isAgentInputPrompt('❯ Try "fix typecheck errors"')).toBe(true);
  expect(isAgentInputPrompt('\u001b[32m❯ Try "fix typecheck errors"\u001b[0m')).toBe(true);
});

test('visible agent readiness recognizes Grok Build bordered composer, not its banner alone', () => {
  const grokWelcome = [
    '  Resume session                               ctrl+r',
    '  New worktree                                 ctrl+w',
    '  Changelog',
    '  Quit                                         ctrl+q',
    '  ╭──────────────────────────────────────────────────────────────────────────╮',
    '  │ ❯                                                                        │',
    '  ╰───────────────────────────────────── Grok 4.7 (medium) · always-approve ─╯',
    '  Grok Build  1.0.70 [stable]',
  ].join('\n');
  expect(isAgentInputPrompt(grokWelcome)).toBe(true);
  expect(isAgentInputPrompt('Grok Build  1.0.70 [stable]')).toBe(false);
});

test('Grok directory trust screen is classified before a predetermined response is enabled', () => {
  const fakeHerdrTrustScreen = [
    'Do you trust the contents of this directory?',
    '/worktrees/demo-a4',
    'Grok Build may run or modify contents in this directory.',
    'Yes, proceed y / No, quit n',
  ].join('\n');
  expect(classifyAgentStartupScreen('grok', fakeHerdrTrustScreen)).toBe('grok-workspace-trust');
  expect(classifyAgentStartupScreen('grok', 'Do you trust the contents of this directory?\nGrok Build may run or modify contents in this directory.')).toBeUndefined();
  expect(classifyAgentStartupScreen('grok', 'Yes, proceed y / No, quit n')).toBeUndefined();
});

test('approved Grok worktree trust receives one response and does not consume startup readiness time', async () => {
  let now = 0;
  let screen = [
    'Do you trust the contents of this directory?',
    '/worktrees/demo-a4',
    'Grok Build may run or modify contents in this directory.',
    'Yes, proceed y / No, quit n',
  ].join('\n');
  let trustAcceptedAt: number | undefined;
  let submitted = 0;
  let resultReady = false;
  let markerReady = false;
  const writes: string[] = [];
  const startupScreens: string[] = [];
  const markerText = (): string | undefined => writes.find(write => write.startsWith('Say M-'))?.match(/M-[a-f0-9]{12}/)?.[0];
  const result = await runVisibleAgentMission({
    agent: 'grok', allowWorkspaceTrustOnce: true, now: () => now,
    pty: {
      snapshot: () => screen,
      write: bytes => {
        writes.push(bytes);
        if (bytes === 'y\r') { trustAcceptedAt = now; return; }
        if (bytes === '\r') {
          submitted++;
          if (submitted === 1) { resultReady = true; screen = '❯ Ask Grok to do anything'; }
          else { markerReady = true; screen = `└ ${markerText()}`; }
          return;
        }
        screen += bytes;
      },
      isAlive: () => true,
    },
    mission: 'Write the demo result.', outputPath: '/tmp/grok-trust-once.md',
    handleTrust: () => false,
    onStartupScreen: startup => startupScreens.push(startup),
    readFile: path => {
      const marker = markerText();
      if (marker && path.endsWith(`.completion-${marker}`)) {
        if (markerReady) return marker;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (resultReady) return '# candidate\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => {
      now += 10;
      if (trustAcceptedAt !== undefined && now - trustAcceptedAt >= 30) screen = '❯ Ask Grok to do anything';
    },
    readyTimeoutMs: 20, workspaceTrustTimeoutMs: 100, pollMs: 10,
  });

  expect(result.ok).toBe(true);
  expect(writes.filter(write => write === 'y\r')).toHaveLength(1);
  expect(startupScreens).toEqual(['grok-workspace-trust']);
});

test('demo Codex hook review chooses continue-without-trusting exactly once', async () => {
  const writes: string[] = [];
  let screen = "Hooks need review\n1 hook is new or changed.\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting (hooks won't run)\nenter confirm · esc skip";
  let enterCount = 0;
  let fileReady = false;
  let markerReady = false;
  let trustHandlerCalls = 0;
  const markerText = (): string | undefined => writes.find(write => write.startsWith('Say M-'))?.match(/M-[a-f0-9]{12}/)?.[0];
  const result = await runVisibleAgentMission({
    agent: 'codex', allowDemoStartupDismissalsOnce: true,
    pty: {
      snapshot: () => screen,
      write: bytes => {
        writes.push(bytes);
        if (bytes === '3') { screen = '› Ask Codex to do anything'; return; }
        if (bytes === '\r') {
          enterCount++;
          if (enterCount === 1) { fileReady = true; screen = '› Ask Codex to do anything'; }
          else { markerReady = true; screen = `└ ${markerText()}`; }
          return;
        }
        screen += bytes;
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/codex-hooks-review.md',
    handleTrust: () => { if (screen.includes('Hooks need review')) trustHandlerCalls++; return false; },
    readFile: path => {
      const marker = markerText();
      if (marker && path.endsWith(`.completion-${marker}`)) {
        if (markerReady) return marker;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (fileReady) return '# Result\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => {}, pollMs: 0,
  });

  expect(result).toMatchObject({ ok: true, promptReady: true, missionVisible: true, promptReturned: true, completionMarker: true });
  expect(writes.filter(write => write === '3')).toHaveLength(1);
  expect(writes).not.toContain('2');
  expect(trustHandlerCalls).toBe(0);
});

test('non-demo Codex hook review remains available to the existing trust handler', async () => {
  let now = 0;
  let trustHandlerCalls = 0;
  const writes: string[] = [];
  const result = await runVisibleAgentMission({
    agent: 'codex', now: () => now,
    pty: {
      snapshot: () => "Hooks need review\n1 hook is new or changed.\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting (hooks won't run)",
      write: bytes => { writes.push(bytes); return true; },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/non-demo-codex-hooks.md',
    handleTrust: () => { trustHandlerCalls++; return true; },
    sleep: async ms => { now += ms || 1; }, pollMs: 0, readyTimeoutMs: 20,
  });

  expect(result).toMatchObject({ ok: false, failureStage: 'prompt-readiness' });
  expect(trustHandlerCalls).toBe(1);
  expect(writes).not.toContain('3');
});

test.each([
  { label: 'workspace-trust wait cap', workspaceTrustTimeoutMs: 15, completionTimeoutMs: 100 },
  { label: 'overall completion cap', workspaceTrustTimeoutMs: 100, completionTimeoutMs: 15 },
])('Grok trust prompt clearing after the $label still fails closed', async ({ workspaceTrustTimeoutMs, completionTimeoutMs }) => {
  let now = 0;
  let screen = 'Do you trust the contents of this directory?\nGrok Build may run or modify contents in this directory.\nYes, proceed y / No, quit n';
  const writes: string[] = [];
  const result = await runVisibleAgentMission({
    agent: 'grok', allowWorkspaceTrustOnce: true, now: () => now,
    pty: {
      snapshot: () => screen,
      write: bytes => { writes.push(bytes); return true; },
      isAlive: () => true,
    },
    mission: 'Write the demo result.', outputPath: '/tmp/grok-trust-deadline.md',
    handleTrust: () => false,
    sleep: async ms => {
      now += ms || 1;
      if (now >= Math.min(workspaceTrustTimeoutMs, completionTimeoutMs)) screen = '❯ Ask Grok to do anything';
    },
    readyTimeoutMs: 10, workspaceTrustTimeoutMs, completionTimeoutMs, pollMs: 0,
  });

  expect(result).toMatchObject({
    ok: false, failureStage: 'prompt-readiness',
    error: 'Grok workspace-trust screen did not clear before its bounded wait expired',
    initialScreen: expect.stringContaining('Do you trust the contents of this directory?'),
  });
  expect(writes).toContain('y\r');
  expect(writes.some(write => write.includes('Write the result to the exact file path'))).toBe(false);
});

test('demo Claude update notice receives one Escape dismissal before mission input', async () => {
  const writes: string[] = [];
  let screen = 'Updated to latest. Got 5 features, 88 bugfixes, and 29 other changes.';
  let enterCount = 0;
  let fileReady = false;
  let markerReady = false;
  const markerText = (): string | undefined => writes.find(write => write.startsWith('Say M-'))?.match(/M-[a-f0-9]{12}/)?.[0];
  const result = await runVisibleAgentMission({
    agent: 'claude', allowDemoStartupDismissalsOnce: true,
    pty: {
      snapshot: () => screen,
      write: bytes => {
        writes.push(bytes);
        if (bytes === '\u001b') { screen = '❯ '; return; }
        if (bytes === '\r') {
          enterCount++;
          if (enterCount === 1) { fileReady = true; screen = '❯ Ask Claude Code to do anything'; }
          else { markerReady = true; screen = `└ ${markerText()}`; }
          return;
        }
        screen += bytes;
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/claude-update-notice.md',
    handleTrust: () => false,
    readFile: path => {
      const marker = markerText();
      if (marker && path.endsWith(`.completion-${marker}`)) {
        if (markerReady) return marker;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (fileReady) return '# Result\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => {}, pollMs: 0,
  });

  expect(result).toMatchObject({ ok: true, promptReady: true, missionVisible: true, promptReturned: true, completionMarker: true });
  expect(writes.filter(write => write === '\u001b')).toHaveLength(1);
});

test('Grok directory trust is not answered outside an approved worktree', async () => {
  const writes: string[] = [];
  let now = 0;
  const screen = 'Do you trust the contents of this directory?\nGrok Build may run or modify contents in this directory.\nYes, proceed y / No, quit n';
  const result = await runVisibleAgentMission({
    agent: 'grok', allowWorkspaceTrustOnce: false, now: () => now,
    pty: { snapshot: () => screen, write: bytes => { writes.push(bytes); }, isAlive: () => true },
    mission: 'Write the demo result.', outputPath: '/tmp/grok-trust-not-approved.md', handleTrust: () => false,
    sleep: async ms => { now += ms || 1; }, readyTimeoutMs: 20, pollMs: 10,
  });
  expect(result).toMatchObject({ ok: false, failureStage: 'prompt-readiness', startupScreen: 'grok-workspace-trust' });
  expect(writes).not.toContain('y\r');
});

test('visible mission lets backend skip a Codex update modal before waiting for its prompt', async () => {
  const writes: string[] = [];
  const detected: string[] = [];
  let screen = 'Update available · 0.165.0 → 0.166.0\nenter continue · esc skip';
  let enterCount = 0;
  let fileReady = false;
  let sleepCount = 0;
  const result = await runVisibleAgentMission({
    agent: 'codex',
    pty: {
      snapshot: () => screen,
      write: bytes => {
        writes.push(bytes);
        if (bytes === '\u001b') return;
        if (bytes !== '\r') { screen += bytes; return; }
        enterCount++;
        if (enterCount === 1) { fileReady = true; screen = '\n› Ask Codex to do anything\n'; }
        else {
          const marker = writes.find(write => write.startsWith('Say M-'))?.match(/M-[a-f0-9]{12}/)?.[0];
          screen += `\n└ ${marker}\n`;
        }
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/codex-update-modal.md',
    onStartupScreen: screenName => detected.push(screenName),
    handleTrust: (currentScreen, write) => {
      if (/update available/i.test(currentScreen) && /\besc\s+skip\b/i.test(currentScreen)) { write('\u001b'); return true; }
      return false;
    },
    readFile: () => {
      if (fileReady) return '# Result\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => { if (++sleepCount === 2) screen = '\n› Ask Codex to do anything\n'; }, pollMs: 0,
  });

  expect(result).toMatchObject({ ok: true, promptReady: true, missionVisible: true, promptReturned: true, completionMarker: true });
  expect(result.initialScreen).toBe('Update available · 0.165.0 → 0.166.0\nenter continue · esc skip');
  expect(writes.filter(write => write === '\u001b')).toHaveLength(1);
  expect(detected).toEqual(['codex-update-choice']);
  expect(result.startupScreen).toBeUndefined();
  expect(writes.some(write => write.startsWith('Write the result to the exact file path'))).toBe(true);
});

test('startup screen classification names only known Claude blockers', () => {
  expect(classifyAgentStartupScreen('claude', 'Sign in to Claude Code at claude.ai/login')).toBe('claude-login');
  expect(classifyAgentStartupScreen('claude', 'Quick safety check\nYes, I trust this folder')).toBe('claude-workspace-trust');
  expect(classifyAgentStartupScreen('claude', 'Update available')).toBe('claude-update-choice');
  expect(classifyAgentStartupScreen('claude', 'private prompt with token')).toBeUndefined();
});

test('Codex update classifier requires an explicit Escape skip action', () => {
  expect(classifyAgentStartupScreen('codex', 'Update available · press Enter to continue')).toBeUndefined();
  expect(classifyAgentStartupScreen('codex', 'Update available · esc skip')).toBe('codex-update-choice');
  expect(classifyAgentStartupScreen('codex', 'Update\u001b[31m available · esc skip')).toBe('codex-update-choice');
});

test('preserves a classified startup screen if the PTY exits before prompt readiness', async () => {
  let aliveChecks = 0;
  let screen = 'Update available · esc skip';
  const result = await runVisibleAgentMission({
    agent: 'codex', pty: {
      snapshot: () => screen,
      write: () => {},
      isAlive: () => ++aliveChecks === 1,
    },
    mission: 'Write a note.', outputPath: '/tmp/codex-exits-on-update.md',
    handleTrust: () => false,
    sleep: async () => { screen = 'Update available · esc skip'; }, pollMs: 0,
  });
  expect(result).toMatchObject({ ok: false, startupScreen: 'codex-update-choice', error: 'Agent PTY exited before its prompt appeared' });
});

test('classifies the final frame when the PTY is already dead at the first readiness check', async () => {
  const detected: string[] = [];
  const result = await runVisibleAgentMission({
    agent: 'codex', pty: { snapshot: () => 'Update available · esc skip', write: () => {}, isAlive: () => false },
    mission: 'Write a note.', outputPath: '/tmp/codex-already-dead.md', handleTrust: () => false,
    onStartupScreen: screen => detected.push(screen),
  });
  expect(result.startupScreen).toBe('codex-update-choice');
  expect(detected).toEqual(['codex-update-choice']);
});

test('emits only one screen-class event when startup blockers change', async () => {
  let aliveChecks = 0;
  let screen = 'Sign in to Claude Code at claude.ai/login';
  const detected: string[] = [];
  const result = await runVisibleAgentMission({
    agent: 'claude', pty: {
      snapshot: () => screen,
      write: () => {},
      isAlive: () => { aliveChecks++; if (aliveChecks === 3) screen = 'Update available'; return aliveChecks < 3; },
    },
    mission: 'Write a note.', outputPath: '/tmp/claude-changing-blocker.md',
    handleTrust: currentScreen => {
      if (/sign in/i.test(currentScreen)) screen = 'Quick safety check · Yes, I trust this folder';
      return /sign in|Quick safety check/i.test(currentScreen);
    },
    onStartupScreen: startup => detected.push(startup), sleep: async () => {}, pollMs: 0,
  });
  expect(result.startupScreen).toBe('claude-update-choice');
  expect(detected).toEqual(['claude-login']);
});

test('Codex prompt is ready even when a dismissed update banner remains in the same frame', async () => {
  const writes: string[] = [];
  let screen = 'Update available · esc skip\n› Ask Codex to do anything';
  let enterCount = 0;
  let fileReady = false;
  const result = await runVisibleAgentMission({
    agent: 'codex',
    pty: {
      snapshot: () => screen,
      write: bytes => {
        writes.push(bytes);
        if (bytes === '\u001b') return;
        if (bytes === '\r') {
          enterCount++;
          if (enterCount === 1) { fileReady = true; screen = '› Ask Codex to do anything'; }
          else {
            const marker = writes.find(write => write.startsWith('Say M-'))?.match(/M-[a-f0-9]{12}/)?.[0];
            screen += `\n└ ${marker}`;
          }
          return;
        }
        screen += bytes;
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/codex-update-banner-and-prompt.md', handleTrust: () => false,
    readFile: () => {
      if (fileReady) return '# Result\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }, sleep: async () => {}, pollMs: 0,
  });
  expect(result).toMatchObject({ ok: true, promptReady: true, missionVisible: true, promptReturned: true, completionMarker: true });
  expect(writes.filter(write => write === '\u001b')).toHaveLength(1);
});

test('startup timeout error never includes arbitrary PTY frame contents', async () => {
  const privateFrame = 'Update available · account token abc123 · ghp_faketoken1234567890 · ghp-faketoken1234567890 · \u001b[32mPASSWORD\u001b[0m="correct horse battery staple" · API_TOKEN="another multi word secret" · Authorization: Bearer "bearer phrase secret"';
  const result = await runVisibleAgentMission({
    agent: 'claude', pty: { snapshot: () => privateFrame, write: () => {}, isAlive: () => true },
    mission: 'Write a note.', outputPath: '/tmp/startup-timeout.md', handleTrust: () => false,
    sleep: async () => {}, readyTimeoutMs: 10, pollMs: 0,
  });
  expect(result.error).not.toContain('abc123');
  expect(result.error).not.toContain(privateFrame);
  expect(result.failureStage).toBe('prompt-readiness');
  expect(result.failureScreen).not.toContain('abc123');
  expect(result.failureScreen).not.toContain('correct horse battery staple');
  expect(result.failureScreen).not.toContain('another multi word secret');
  expect(result.failureScreen).not.toContain('bearer phrase secret');
  expect(result.failureScreen).not.toContain('ghp_faketoken1234567890');
  expect(result.failureScreen).not.toContain('ghp-faketoken1234567890');
  expect(result.failureScreen).toContain('PASSWORD=[redacted credential]');
});

test('visible mission requires a visible request, result file, idle prompt, and output-only marker', async () => {
  const writes: string[] = [];
  let screen = '\n›\n';
  let enterCount = 0;
  let fileReady = false;
  let fileReads = 0;
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => `\u001b[32m${screen}\u001b[0m`,
      write: (bytes) => {
        writes.push(bytes);
        if (bytes !== '\r') { screen += bytes; return; }
        enterCount++;
        if (enterCount === 1) {
          fileReady = true;
          screen = '\n› Ask Codex to do anything\n';
        } else {
          const marker = writes.find(write => write.startsWith('Say M-'))?.match(/M-[a-f0-9]{12}/)?.[0];
          screen += `\n└ ${marker}\n`;
        }
      },
      isAlive: () => true,
    },
    mission: 'Write a short demo note.',
    outputPath: '/tmp/demo1104-result.md',
    handleTrust: () => false,
    readFile: (path) => {
      if (path === '/tmp/demo1104-result.md' && fileReady) {
        fileReads++;
        return fileReads === 1 ? '# Partial result\n' : '# Demo result\nSecond line\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => {},
    pollMs: 0,
  });

  expect(result).toEqual({
    ok: true,
    path: '/tmp/demo1104-result.md',
    content: '# Demo result\nSecond line\n',
    firstLine: '# Demo result',
    promptReady: true,
    missionVisible: true,
    missionTyped: true,
    missionSubmitted: true,
    promptReturned: true,
    completionMarker: true,
    initialScreen: '\n›\n',
  });
  expect(writes).toHaveLength(4);
  expect(writes[0]).toContain('/tmp/demo1104-result.md');
  expect(writes[0]).toContain('Write a short demo note.');
  expect(writes[1]).toBe('\r');
  expect(writes[2]).toMatch(/^Say M-[a-f0-9]{12} alone and write it to the exact file path /);
  expect(writes[2]).not.toContain('\r');
  expect(writes[3]).toBe('\r');
  expect(fileReads).toBe(2);
});

test('marker request appearing only in input is not accepted as completion output', async () => {
  let screen = '\n›\n';
  let enterCount = 0;
  let fileReady = false;
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => screen,
      write: bytes => {
        if (bytes !== '\r') { screen += bytes; return; }
        enterCount++;
        if (enterCount === 1) { fileReady = true; screen = '\n› Ask Codex to do anything\n'; }
        // The second Enter accepts the marker request but the child emits no marker.
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/marker-input-only.md', handleTrust: () => false,
    readFile: () => {
      if (fileReady) return '# Result\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }, sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
    pollMs: 0, completionTimeoutMs: 8,
  });

  expect(result).toMatchObject({ ok: false, promptReady: true, missionVisible: true, promptReturned: true, completionMarker: false });
  expect(result.failureStage).toBe('marker-completion');
  expect(result.failureScreen).toBeDefined();
  expect(result.error).toContain('completion marker');
  expect(screen).toMatch(/Say M-[a-f0-9]{12} alone and write it to the exact file path /);
  expect(screen).not.toMatch(/^\s*(?:[•⏺└│╰⎿]\s*)?M-[a-f0-9]{12}\s*$/m);
});

test('does not request completion marker when the mission result file is missing', async () => {
  const writes: string[] = [];
  let screen = '\n›\n';
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => screen,
      write: bytes => { writes.push(bytes); if (bytes === '\r') screen = '\n› Ask Codex to do anything\n'; else screen += bytes; },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/missing.md', handleTrust: () => false,
    readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
    pollMs: 0, completionTimeoutMs: 8,
  });

  expect(result).toMatchObject({ ok: false, promptReady: true, missionVisible: true, promptReturned: false, completionMarker: false });
  expect(result.error).toContain('result file');
  expect(writes.every(write => !write.startsWith('Say M-'))).toBe(true);
});

test('does not treat a result file as complete until the agent returns to its prompt', async () => {
  let fileReady = false;
  let screen = '\n›\n';
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => screen,
      write: bytes => {
        if (bytes === '\r') { fileReady = true; screen = '\nWorking…\n'; }
        else screen += bytes;
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/no-prompt-return.md', handleTrust: () => false,
    readFile: () => {
      if (fileReady) return '# Result\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
    pollMs: 0, completionTimeoutMs: 8,
  });

  expect(result).toMatchObject({ ok: false, promptReady: true, missionVisible: true, promptReturned: false, completionMarker: false });
  expect(result.error).toContain('return to its input prompt');
});

test('preserves observed mission stages when the PTY throws after mission input is visible', async () => {
  let screen = '\n›\n';
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => screen,
      write: bytes => {
        if (bytes === '\r') throw new Error('PTY write failed');
        screen += bytes;
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/pty-fails-after-visible.md', handleTrust: () => false,
    readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    sleep: async () => {}, pollMs: 0,
  });

  expect(result).toMatchObject({ ok: false, promptReady: true, missionVisible: true, promptReturned: false, completionMarker: false });
  expect(result.error).toBe('PTY write failed');
});

test('does not accept a random marker that wrapped into its own input row', async () => {
  const writes: string[] = [];
  let screen = '\n›\n';
  let enterCount = 0;
  let fileReady = false;
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => screen,
      write: bytes => {
        writes.push(bytes);
        if (bytes !== '\r') {
          screen += bytes;
          if (bytes.startsWith('Say M-')) screen += `\n${bytes.match(/M-[a-f0-9]{12}/)?.[0]}\n`;
          return;
        }
        enterCount++;
        if (enterCount === 1) { fileReady = true; screen = '\n› Ask Codex to do anything\n'; }
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/wrapped-marker.md', handleTrust: () => false,
    readFile: () => {
      if (fileReady) return '# Result\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => {}, pollMs: 0,
  });

  expect(result).toMatchObject({ ok: false, promptReady: true, missionVisible: true, promptReturned: true, completionMarker: false });
  expect(result.error).toContain('before submission');
  expect(writes).toHaveLength(3);
  expect(writes[2]).toMatch(/^Say M-[a-f0-9]{12} alone and write it to the exact file path /);
  const requestedMarker = writes[2]?.match(/^Say (M-[a-f0-9]{12}) alone and write it/)?.[1];
  expect(screen).toContain(`\n${requestedMarker}\n`);
});

test('refuses to reuse a pre-existing result path', async () => {
  const writes: string[] = [];
  const result = await runVisibleAgentMission({
    pty: { snapshot: () => '\n›\n', write: bytes => writes.push(bytes), isAlive: () => true },
    mission: 'Write a note.', outputPath: '/tmp/old-result.md', handleTrust: () => false,
    readFile: () => '# Old result\n', sleep: async () => {}, pollMs: 0,
  });

  expect(result).toMatchObject({ ok: false, promptReady: true, promptReturned: false, completionMarker: false });
  expect(result.error).toContain('already exists');
  expect(writes).toHaveLength(0);
});

test('SIDETAB-MARKER-BACKGROUND-DETECT: keeps polling a delayed sidecar when the detached PTY snapshot is unavailable', async () => {
  let screen = '\n›\n';
  let enterCount = 0;
  let resultReady = false;
  let markerPath: string | undefined;
  let markerValue: string | undefined;
  let markerSubmitted = false;
  let markerReads = 0;
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => {
        if (markerSubmitted) throw new Error('detached PTY snapshot unavailable');
        return screen;
      },
      write: bytes => {
        if (bytes !== '\r') {
          screen += bytes;
          if (bytes.startsWith('Say M-')) {
            markerValue = bytes.match(/M-[a-f0-9]{12}/)?.[0];
            markerPath = bytes.match(/exact file path (\S+?)\.$/)?.[1];
          }
          return;
        }
        enterCount++;
        if (enterCount === 1) { resultReady = true; screen = '\n› Ask Codex to do anything\n'; }
        else markerSubmitted = true;
      },
      isAlive: () => true,
    },
    mission: 'Write a delayed detached result.', outputPath: '/tmp/delayed-detached-result.md', handleTrust: () => false,
    readFile: path => {
      if (path === '/tmp/delayed-detached-result.md' && resultReady) return '# Delayed detached result\n';
      if (path === markerPath && markerValue && markerSubmitted && ++markerReads >= 2) return `${markerValue}\n`;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => {}, pollMs: 0, readyTimeoutMs: 20, visibilityTimeoutMs: 20, completionTimeoutMs: 20,
  });

  expect(result).toMatchObject({ ok: true, promptReturned: true, completionMarker: true });
  expect(markerReads).toBeGreaterThanOrEqual(2);
});

test('SIDETAB-MARKER-BACKGROUND-DETECT: observes detached completion marker through its unique sidecar', async () => {
  const writes: string[] = [];
  let screen = '\n›\n';
  let enterCount = 0;
  let fileReady = false;
  let markerFile: string | undefined;
  let markerValue: string | undefined;
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => screen,
      write: bytes => {
        writes.push(bytes);
        if (bytes !== '\r') {
          screen += bytes;
          if (bytes.startsWith('Say M-')) {
            const marker = bytes.match(/M-[a-f0-9]{12}/)?.[0];
            markerFile = bytes.match(/exact file path (\S+?)\.$/)?.[1];
            markerValue = marker;
          }
          return;
        }
        enterCount++;
        if (enterCount === 1) { fileReady = true; screen = '\n› Ask Codex to do anything\n'; }
        else screen = '\n› Ask Codex to do anything\n';
      },
      isAlive: () => true,
    },
    mission: 'Write a detached result.', outputPath: '/tmp/detached-result.md', handleTrust: () => false,
    readFile: path => {
      if (path === '/tmp/detached-result.md' && fileReady) return '# Detached result\n';
      if (path === markerFile && markerValue) return `${markerValue}\n`;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async () => {}, pollMs: 0, completionTimeoutMs: 20,
  });

  expect(result).toMatchObject({ ok: true, promptReady: true, missionVisible: true, promptReturned: true, completionMarker: true });
  expect(markerFile).toMatch(/^\/tmp\/detached-result\.md\.completion-M-[a-f0-9]{12}$/);
  expect(writes.filter(write => write === '\r')).toHaveLength(2);
});

test('SIDETAB-MARKER-BACKGROUND-DETECT: Codex-first/Claude-second detached PTYs each complete and notify the parent once', async () => {
  const notifications = new TaskNotificationQueue();
  notifications.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const sessions = new Map<string, { id: string; cwd: string }>();
  const completedMarkers: string[] = [];
  const workspaceDir = mkdtempSync(join(tmpdir(), 'visible-agent-pair-workspace-'));
  execFileSync('git', ['init', '--quiet', workspaceDir]);
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(workspaceDir, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', workspaceDir, 'add', 'base.txt']);
  execFileSync('git', ['-C', workspaceDir, 'commit', '--quiet', '-m', 'candidate base']);
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'Codex task.', parallelMission: 'Claude task.',
    context: { callId: 'parent-call', parentSessionId: 'parent-session' },
    spawnVisible: agent => {
      const session = { id: `${agent}-pty`, cwd: workspaceDir };
      sessions.set(session.id, session);
      return session;
    },
    runVisible: async (agent, mission, session) => {
      let screen = '\n›\n';
      let enterCount = 0;
      let resultReady = false;
      let markerPath: string | undefined;
      let markerValue: string | undefined;
      let markerSubmitted = false;
      const outputPath = join(workspaceDir, `${agent}-pair-result.md`);
      const result = await runVisibleAgentMission({
        pty: {
          snapshot: () => screen,
          write: bytes => {
            if (bytes !== '\r') {
              screen += bytes;
              if (bytes.startsWith('Say M-')) {
                markerValue = bytes.match(/M-[a-f0-9]{12}/)?.[0];
                markerPath = bytes.match(/exact file path (\S+?)\.$/)?.[1];
              }
              return;
            }
            enterCount++;
            if (enterCount === 1) { resultReady = true; screen = '\n› Ask Codex to do anything\n'; }
            else { markerSubmitted = true; screen = '\n› Ask Codex to do anything\n'; }
          },
          isAlive: () => true,
        },
        mission, outputPath, handleTrust: () => false,
        readFile: path => {
          if (path === outputPath && resultReady) return `# ${agent} result\n`;
          if (path === markerPath && markerSubmitted && markerValue) return `${markerValue}\n`;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        sleep: async () => {}, pollMs: 0, completionTimeoutMs: 20,
      });
      if (result.completionMarker) completedMarkers.push(agent);
      return result;
    },
    registry,
    hasSession: sessionId => sessions.has(sessionId),
    killSession: sessionId => { sessions.delete(sessionId); },
    enqueue: notification => notifications.enqueue(notification),
    createId: (() => { let id = 0; return () => `pair-mission-${++id}`; })(),
  });

  try {
    await started.completion;
    expect(completedMarkers).toEqual(['codex', 'claude']);
    expect(notifications.drainForParentSession('parent-session')).toHaveLength(1);
    expect(notifications.drainForParentSession('other-parent')).toEqual([]);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('SIDETAB-MARKER-BACKGROUND-DETECT: three-act single-hand restart order preserves detached marker completion', async () => {
  const completed: string[] = [];
  for (const agent of ['codex', 'claude', 'codex']) {
    let screen = '\n›\n';
    let resultReady = false;
    let markerPath: string | undefined;
    let markerValue: string | undefined;
    let markerSubmitted = false;
    const outputPath = `/tmp/${agent}-restart-${completed.length}.md`;
    const result = await runVisibleAgentMission({
      pty: {
        snapshot: () => screen,
        write: bytes => {
          if (bytes !== '\r') {
            screen += bytes;
            if (bytes.startsWith('Say M-')) {
              markerValue = bytes.match(/M-[a-f0-9]{12}/)?.[0];
              markerPath = bytes.match(/exact file path (\S+?)\.$/)?.[1];
            }
            return;
          }
          if (!resultReady) { resultReady = true; screen = '\n› Ask Codex to do anything\n'; }
          else { markerSubmitted = true; screen = '\n› Ask Codex to do anything\n'; }
        },
        isAlive: () => true,
      },
      mission: `${agent} restart act ${completed.length + 1}`, outputPath, handleTrust: () => false,
      readFile: path => {
        if (path === outputPath && resultReady) return `# ${agent} restart result\n`;
        if (path === markerPath && markerSubmitted && markerValue) return `${markerValue}\n`;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      sleep: async () => {}, pollMs: 0, completionTimeoutMs: 20,
    });
    expect(result.completionMarker).toBe(true);
    completed.push(agent);
  }
  expect(completed).toEqual(['codex', 'claude', 'codex']);
});

test('SIDETAB-CHILD-PTY-INPUT-VISIBILITY: readiness and input failures return stage plus first and final screen tails without failing a successful candidate', async () => {
  const mission = 'Read package.json and report only package name/version.';
  const agents = ['claude', 'codex', 'grok'] as const;
  const records: Array<{ agent: typeof agents[number]; submitted: string; path: string; exitCode: number | null; ok: boolean; failureStage?: string }> = [];
  const files = new Map<string, string>();
  for (const agent of agents) {
    const outputPath = `/tmp/${agent}-input-visibility.md`;
    let screen = agent === 'grok'
      ? '  │ ❯                                                                        │\n'
      : '\n› Ask Codex to do anything\n';
    let submitted = '';
    let enters = 0;
    let alive = true;
    let code: number | null = null;
    let markerPath = '';
    let markerText = '';
    const result = await runVisibleAgentMission({
      agent,
      pty: {
        snapshot: () => screen,
        write: bytes => {
          if (bytes === '\r') {
            enters += 1;
            submitted ||= screen;
            if (agent === 'claude') {
              alive = false;
              code = 1;
              screen = 'Mission text was not visible in the agent PTY before submission\n';
              return true;
            }
            if (enters === 1) files.set(outputPath, `# ${agent} package name elanous version 0.2.45\n`);
            else if (markerPath && markerText) files.set(markerPath, `${markerText}\n`);
            screen = agent === 'grok' ? '  │ ❯                                                                        │\n' : '\n› Ask Codex to do anything\n';
            return true;
          }
          if (agent === 'claude') {
            alive = false;
            code = 1;
            screen = 'Mission text was not visible in the agent PTY before submission\n';
            return true;
          }
          screen += bytes;
          if (bytes.startsWith('Say M-')) {
            markerText = bytes.match(/M-[a-f0-9]{12}/)?.[0] ?? '';
            markerPath = bytes.match(/exact file path (\S+?)\.$/)?.[1] ?? '';
          }
          return true;
        },
        isAlive: () => alive,
        exitCode: () => code,
      },
      mission,
      outputPath,
      handleTrust: () => false,
      readFile: path => {
        const body = files.get(path);
        if (body !== undefined) return body;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      sleep: async () => { await new Promise(resolve => setTimeout(resolve, 2)); },
      pollMs: 1,
      visibilityTimeoutMs: 8,
      completionTimeoutMs: 30,
    });
    records.push({ agent, submitted, path: result.path, exitCode: result.exitCode ?? null, ok: result.ok, ...(result.failureStage ? { failureStage: result.failureStage } : {}) });
    if (agent === 'claude') {
      expect(result).toMatchObject({
        ok: false,
        promptReady: true,
        missionVisible: false,
        missionTyped: true,
        missionSubmitted: false,
        failureStage: 'mission-visibility',
        exitCode: 1,
      });
      expect(result.initialScreen).toContain('›');
      expect(result.failureScreen).toContain('Mission text was not visible');
      expect(result.error).toContain('not visible');
    } else {
      expect(result.ok).toBe(true);
      expect(result.failureStage).toBeUndefined();
      expect(result.path).toBe(outputPath);
      expect(result.content).toContain(agent);
      expect(result.exitCode).toBeNull();
      expect(submitted).toContain(mission);
    }
  }
  expect(records.map(record => record.agent)).toEqual(['claude', 'codex', 'grok']);
  expect(records.filter(record => record.ok).map(record => record.agent)).toEqual(['codex', 'grok']);
  expect(records.find(record => record.agent === 'claude')?.failureStage).toBe('mission-visibility');
});

test('does not submit a mission that is not visible in the PTY', async () => {
  const writes: string[] = [];
  const result = await runVisibleAgentMission({
    pty: { snapshot: () => '\n›\n', write: bytes => writes.push(bytes), isAlive: () => true },
    mission: 'Write a note.', outputPath: '/tmp/not-visible.md', handleTrust: () => false,
    sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); }, pollMs: 0, visibilityTimeoutMs: 5,
  });

  expect(result).toMatchObject({ ok: false, promptReady: true, missionVisible: false, missionTyped: true, missionSubmitted: false, promptReturned: false, completionMarker: false });
  expect(result.error).toContain('not visible');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('Write a note.');
});

test('types long UTF-8 missions in bounded PTY chunks and records typed/submitted states', async () => {
  const writes: string[] = [];
  let screen = '\n› Ask Codex to do anything\n';
  let screenAtSubmit = '';
  let resultReady = false;
  let markerPath: string | undefined;
  let markerText: string | undefined;
  let markerSubmitted = false;
  const sleeps: number[] = [];
  const outputPath = '/tmp/chunked-mission.md';
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => screen,
      write: bytes => {
        writes.push(bytes);
        if (bytes === '\r') {
          if (!resultReady) { screenAtSubmit = screen; resultReady = true; screen = '\n› Ask Codex to do anything\n'; }
          else { markerSubmitted = true; screen = `\n└ ${markerText}\n`; }
        } else {
          screen += bytes;
          if (bytes.startsWith('Say M-')) {
            markerText = bytes.match(/M-[a-f0-9]{12}/)?.[0];
            markerPath = bytes.match(/exact file path (\S+?)\.$/)?.[1];
          }
        }
        return true;
      },
      isAlive: () => true,
    },
    mission: `Write a note with UTF-8 payload: ${'한글🙂'.repeat(180)}`,
    outputPath,
    handleTrust: () => false,
    readFile: path => {
      if (path === outputPath && resultReady) return '# Chunked result\n';
      if (path === markerPath && markerSubmitted && markerText) return `${markerText}\n`;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    sleep: async ms => { sleeps.push(ms); },
    pollMs: 0,
    completionTimeoutMs: 30,
  });

  expect(result).toMatchObject({ ok: true, promptReady: true, missionVisible: true, missionTyped: true, missionSubmitted: true, promptReturned: true, completionMarker: true });
  const missionSubmit = writes.indexOf('\r');
  const missionChunks = writes.slice(0, missionSubmit);
  expect(missionChunks.every(write => Buffer.byteLength(write, 'utf8') <= 256)).toBe(true);
  expect(screenAtSubmit).toContain(`Write a note with UTF-8 payload: ${'한글🙂'.repeat(180)}`);
  expect(sleeps).toContain(10);
});

test('reports the failed input stage and last observed screen when the PTY rejects a write', async () => {
  const secret = 'sk-123456789abcdefgh';
  const phrase = 'correct horse battery staple';
  let snapshots = 0;
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => { if (++snapshots > 1) throw new Error('closed PTY'); return `\n› Ask Codex to do anything\nOPENAI_API_KEY=${secret}\nPASSWORD="${phrase}"\nAPI_TOKEN="another multi word secret"\nAuthorization: Bearer "bearer phrase secret"\n`; },
      write: () => false, isAlive: () => true,
    },
    mission: 'Read package.json and report only package name/version.', outputPath: '/tmp/rejected-write.md',
    handleTrust: () => false,
  });
  expect(result).toMatchObject({
    ok: false, promptReady: true, failureStage: 'mission-write',
    missionTyped: false, missionSubmitted: false,
    failureScreen: '\n› Ask Codex to do anything\nOPENAI_API_KEY=[redacted credential]\nPASSWORD=[redacted credential]\nAPI_TOKEN=[redacted credential]\nAuthorization: Bearer [redacted]\n',
  });
  expect(result.error).toMatch(/Mission input write was rejected after 0\/\d+ UTF-8 bytes/);
  expect(result.missionVisible).toBe(false);
  expect(result.failureScreen).not.toContain(secret);
  expect(result.initialScreen).toContain('PASSWORD=[redacted credential]');
  expect(result.initialScreen).toContain('API_TOKEN=[redacted credential]');
  expect(result.initialScreen).not.toContain(phrase);
  expect(result.initialScreen).not.toContain('another multi word secret');
  expect(result.initialScreen).not.toContain('bearer phrase secret');
  expect(result.initialScreen).not.toContain(secret);
});

test('uses one absolute safety cap across readiness and mission visibility', async () => {
  const started = Date.now();
  const result = await runVisibleAgentMission({
    pty: { snapshot: () => '\n› Ask Codex to do anything\n', write: () => true, isAlive: () => true },
    mission: 'Write a note.', outputPath: '/tmp/shared-cap.md', handleTrust: () => false,
    sleep: async ms => { await new Promise(resolve => setTimeout(resolve, Math.min(ms || 2, 2))); },
    pollMs: 0, visibilityTimeoutMs: 1_000, completionTimeoutMs: 20,
  });
  expect(Date.now() - started).toBeLessThan(250);
  expect(result).toMatchObject({ ok: false, failureStage: 'mission-visibility' });
});

test('visibility receives only the time remaining after readiness uses the shared deadline', async () => {
  let snapshots = 0;
  const started = Date.now();
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => ++snapshots === 1 ? 'Starting up...' : '\n› Ask Codex to do anything\n',
      write: () => true, isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/readiness-spent-cap.md', handleTrust: () => false,
    sleep: async ms => { await new Promise(resolve => setTimeout(resolve, Math.min(ms, 65))); },
    readyTimeoutMs: 1_000, visibilityTimeoutMs: 1_000, completionTimeoutMs: 100, pollMs: 65,
  });
  expect(result).toMatchObject({ ok: false, failureStage: 'mission-visibility' });
  expect(Date.now() - started).toBeLessThan(155);
});

test('records marker-write rejection instead of waiting for an impossible echo', async () => {
  let screen = '\n›\n';
  let missionSubmitted = false;
  const result = await runVisibleAgentMission({
    pty: {
      snapshot: () => screen,
      write: bytes => {
        if (bytes === '\r') { missionSubmitted = true; screen = '\n›\n'; return true; }
        if (bytes.startsWith('Say M-')) return false;
        screen += bytes;
        return true;
      },
      isAlive: () => true,
    },
    mission: 'Write a note.', outputPath: '/tmp/marker-write-rejected.md',
    handleTrust: () => false,
    readFile: () => missionSubmitted ? '# Result\n' : (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); })(),
    sleep: async () => {}, pollMs: 0,
  });
  expect(result).toMatchObject({ ok: false, firstLine: '# Result', failureStage: 'marker-write', error: 'Completion marker input write was rejected by the agent PTY' });
});
