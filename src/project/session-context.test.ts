import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from './project-store.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { resolveSessionProjectContext } from './session-context.js';
import { createSession, updateSessionMeta } from '../session/index.js';

test('assigned conversation uses its project folder and optional AGENTS.md; unassigned retains default', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-context-'));
  const oldSession = process.env.ELANOUS_SESSION_ROOT;
  try {
    setElanousConfigDir(join(root, 'config'));
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const folder = join(root, 'folder');
    mkdirSync(folder);
    const project = new ProjectStore(join(root, 'config')).create({ name: 'demo', primaryFolder: folder });
    const assigned = createSession({ projectId: project.id });
    const unassigned = createSession();
    expect(resolveSessionProjectContext(assigned.id)).toEqual({ cwd: folder });
    expect(resolveSessionProjectContext(unassigned.id)).toBeNull();
    writeFileSync(join(folder, 'AGENTS.md'), 'Follow project guidance.\n');
    expect(resolveSessionProjectContext(assigned.id)).toEqual({ cwd: folder,
      instructions: `Project instructions (${join(folder, 'AGENTS.md')}):\nFollow project guidance.\n` });
    updateSessionMeta(assigned.id, meta => { delete meta.projectId; });
    expect(resolveSessionProjectContext(assigned.id)).toBeNull();
    const missing = createSession({ projectId: '00000000-0000-4000-8000-000000000000' });
    expect(resolveSessionProjectContext(missing.id)).toBeNull();
  } finally {
    resetElanousConfigDir();
    if (oldSession === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldSession;
    rmSync(root, { recursive: true, force: true });
  }
});
