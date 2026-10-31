import { expect, test } from 'bun:test';
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
  const privateFrame = 'Update available · account token abc123';
  const result = await runVisibleAgentMission({
    agent: 'claude', pty: { snapshot: () => privateFrame, write: () => {}, isAlive: () => true },
    mission: 'Write a note.', outputPath: '/tmp/startup-timeout.md', handleTrust: () => false,
    sleep: async () => {}, readyTimeoutMs: 10, pollMs: 0,
  });
  expect(result.error).not.toContain('abc123');
  expect(result.error).not.toContain(privateFrame);
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
    promptReturned: true,
    completionMarker: true,
    initialScreen: '\u001b[32m\n›\n\u001b[0m',
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
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'Codex task.', parallelMission: 'Claude task.',
    context: { callId: 'parent-call', parentSessionId: 'parent-session' },
    spawnVisible: agent => {
      const session = { id: `${agent}-pty`, cwd: '/tmp' };
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
      const outputPath = `/tmp/${agent}-pair-result.md`;
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

  await started.completion;
  expect(completedMarkers).toEqual(['codex', 'claude']);
  expect(notifications.drainForParentSession('parent-session')).toHaveLength(1);
  expect(notifications.drainForParentSession('other-parent')).toEqual([]);
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

test('does not submit a mission that is not visible in the PTY', async () => {
  const writes: string[] = [];
  const result = await runVisibleAgentMission({
    pty: { snapshot: () => '\n›\n', write: bytes => writes.push(bytes), isAlive: () => true },
    mission: 'Write a note.', outputPath: '/tmp/not-visible.md', handleTrust: () => false,
    sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); }, pollMs: 0, visibilityTimeoutMs: 5,
  });

  expect(result).toMatchObject({ ok: false, promptReady: true, missionVisible: false, promptReturned: false, completionMarker: false });
  expect(result.error).toContain('not visible');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('Write a note.');
});
