import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCodexTokenOwnerHost } from '../../src/oauth/codex-owner-mirror.js';
import { loadFreshCodexAuthState } from '../../src/oauth/codex.js';
import { installCodexOwnerTestWorld } from './codex-owner-test-world.js';
import { getUserConfig, setUserConfigOverlay } from '../../src/user-config.js';

test('isolated Codex world owns refresh only on its owner and gives clients an access-only mirror', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-owner-test-world-'));
  const priorAccessOnly = process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  const priorMirrorPath = process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH;
  const priorOverlay = setUserConfigOverlay((config) => ({ ...config,
    llm: { ...config.llm, codexTokenOwnerHost: 'previous-fixture-owner' },
    hq: { ...config.hq, hostName: 'previous-fixture-owner' },
  }));
  try {
    const restoreOwner = installCodexOwnerTestWorld(root);
    try {
      expect(isCodexTokenOwnerHost()).toBe(true);
      expect(process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY).toBeUndefined();
    } finally { restoreOwner(); }
    const restoreClient = installCodexOwnerTestWorld(root, 'mirror');
    try {
      expect(isCodexTokenOwnerHost()).toBe(false);
      const state = await loadFreshCodexAuthState();
      expect(state?.tokens.accessToken.startsWith('e30.')).toBe(true);
      expect(state?.tokens.refreshToken).toBe('');
    } finally { restoreClient(); }
    expect(process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY).toBe(priorAccessOnly);
    expect(process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH).toBe(priorMirrorPath);
    expect(getUserConfig().llm.codexTokenOwnerHost).toBe('previous-fixture-owner');
    expect(isCodexTokenOwnerHost()).toBe(true);
  } finally {
    setUserConfigOverlay(priorOverlay);
    rmSync(root, { recursive: true, force: true });
  }
});
