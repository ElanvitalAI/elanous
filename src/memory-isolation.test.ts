import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryRoot, saveMemory } from './memory.js';

test('inherited isolated state root confines file memory in a child process', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'memory-isolated-child-'));
  const oldState = process.env.ELANOUS_STATE_DIR;
  const oldXdg = process.env.XDG_DATA_HOME;
  try {
    process.env.ELANOUS_STATE_DIR = isolated;
    process.env.XDG_DATA_HOME = join(isolated, 'wrong-xdg');
    expect(memoryRoot()).toBe(join(isolated, 'elanous', 'memory'));
    const saved = saveMemory({ id: 'isolation-probe', type: 'user', name: 'probe',
      description: 'probe', body: 'synthetic', pinned: true });
    expect(saved.id).toBe('isolation-probe');
  } finally {
    if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg;
    rmSync(isolated, { recursive: true, force: true });
  }
});
