import { expect, test } from 'bun:test';
import { isAgentInputPrompt, runVisibleAgentMission } from './visible-agent-mission.js';

test('visible agent readiness recognizes real Codex and Claude prompt placeholders', () => {
  expect(isAgentInputPrompt('› Ask Codex to do anything')).toBe(true);
  expect(isAgentInputPrompt('❯ Try "fix typecheck errors"')).toBe(true);
  expect(isAgentInputPrompt('\u001b[32m❯ Try "fix typecheck errors"\u001b[0m')).toBe(true);
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
  });
  expect(writes).toHaveLength(4);
  expect(writes[0]).toContain('/tmp/demo1104-result.md');
  expect(writes[0]).toContain('Write a short demo note.');
  expect(writes[1]).toBe('\r');
  expect(writes[2]).toMatch(/^Say M-[a-f0-9]{12} alone\.$/);
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
  expect(screen).toMatch(/Say M-[a-f0-9]{12} alone\./);
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
  expect(writes[2]).toMatch(/^Say M-[a-f0-9]{12} alone\.$/);
  const requestedMarker = writes[2]?.match(/^Say (M-[a-f0-9]{12}) alone\.$/)?.[1];
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
