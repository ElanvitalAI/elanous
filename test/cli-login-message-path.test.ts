import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexLoginSuccessMessage } from '../src/index.js';
import { codexFreshLoginAuthLabel } from '../src/codex/setup.js';
import { authStorePath } from '../src/oauth/store.js';
import { resetEffectiveInstanceRoot } from '../src/instance/resolve.js';

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.HOME;
const originalStateDir = process.env.ELANOUS_STATE_DIR;

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  resetEffectiveInstanceRoot();
});

// bun test stamps ELANOUS_STATE_DIR before the case runs (preload, or the
// deterministic runner). authStorePath follows that instance root, so HOME
// and XDG_CONFIG_HOME do not choose the suffix.
function stampedStateRoot(): string {
  const raw = process.env.ELANOUS_STATE_DIR?.trim();
  if (!raw) throw new Error('ELANOUS_STATE_DIR is not stamped');
  // A root '/' stamp stays '/' — stripping trailing slashes must not make it empty.
  return resolve(raw.replace(/\/+$/, '') || '/');
}

function stampedAuthPath(): string {
  return join(stampedStateRoot(), 'auth.json');
}

describe('Codex fresh-login token path messages', () => {
  test.each([
    ['without XDG_CONFIG_HOME', undefined],
    ['with XDG_CONFIG_HOME', 'xdg-config'],
  ])('%s reports authStorePath()', (_name, xdgDir) => {
    const root = mkdtempSync(join(tmpdir(), 'cli-login-message-env-'));
    try {
      process.env.HOME = root;
      delete process.env.ELANOUS_STATE_DIR;
      resetEffectiveInstanceRoot();
      if (xdgDir === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = join(root, xdgDir);

      const expected = authStorePath();
      expect(expected).toBe(stampedAuthPath());
      // The negatives only guard against HOME/XDG choosing the suffix. When the
      // stamped root itself ends with /.elanous (or <xdgDir>/elanous), the real
      // path correctly following the stamp ends with that suffix — validate
      // against the configured stamp instead of assuming a non-default root.
      const stampedRoot = stampedStateRoot();
      if (!stampedRoot.endsWith('/.elanous')) expect(expected.endsWith('/.elanous/auth.json')).toBe(false);
      if (xdgDir !== undefined && !stampedRoot.endsWith(`${xdgDir}/elanous`)) {
        expect(expected.includes(`${xdgDir}/elanous/auth.json`)).toBe(false);
      }
      expect(codexLoginSuccessMessage()).toContain(`Tokens at ${expected}`);
      expect(codexFreshLoginAuthLabel()).toContain(`tokens at ${expected}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
