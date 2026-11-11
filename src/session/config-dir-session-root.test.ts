import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { elanousInvocation } from '../instance/spawn-elanous.js';
import { createSession, loadSession, sessionRoot } from './index.js';

const root = mkdtempSync(join(tmpdir(), 'next-tui-session-root-'));
const previousStateDir = process.env.ELANOUS_STATE_DIR;
const previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
const previousConfigDir = getElanousConfigDirOverride();

afterEach(() => {
  resetElanousConfigDir();
  if (previousConfigDir) setElanousConfigDir(previousConfigDir);
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
  rmSync(root, { recursive: true, force: true });
});

test('Next TUI parent and stamped REPL child resolve one explicit config-dir session', () => {
  delete process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_STATE_DIR = join(root, 'inherited-state');
  const configDir = join(root, 'explicit-config');
  setElanousConfigDir(configDir);
  const session = createSession({ source: 'tui' });
  expect(sessionRoot()).toBe(join(configDir, 'sessions'));
  expect(existsSync(join(configDir, 'sessions', `${session.id}.jsonl`))).toBe(true);

  const child = elanousInvocation([], { bin: 'child.ts' });
  expect(child.env.ELANOUS_STATE_DIR).toBe(configDir);
  resetElanousConfigDir();
  process.env.ELANOUS_STATE_DIR = child.env.ELANOUS_STATE_DIR;
  expect(loadSession(session.id)?.meta.id).toBe(session.id);
});
