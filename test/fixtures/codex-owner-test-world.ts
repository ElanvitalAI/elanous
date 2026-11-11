import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setUserConfigOverlay } from '../../src/user-config.js';

/** Synthetic Codex owner and access-only snapshot for an already isolated test root. */
export function installCodexOwnerTestWorld(root: string, mode: 'owner' | 'mirror' = 'owner'): () => void {
  const priorAccessOnly = process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  const priorMirrorPath = process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH;
  const priorCodexHome = process.env.CODEX_HOME;
  const ownerHost = 'codex-test-owner';
  const mirrorPath = join(root, 'codex-owner-mirror', 'auth.json');
  const expiresAt = Date.now() + 4 * 60 * 60_000;
  const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString('base64url')}.test`;
  mkdirSync(join(root, 'codex-owner-mirror'), { recursive: true, mode: 0o700 });
  writeFileSync(mirrorPath, JSON.stringify({
    version: 1,
    providers: { 'openai-codex': {
      authMode: 'chatgpt',
      tokens: { accessToken, refreshToken: '', refresh_token: '', expiresAt, tokenType: 'Bearer' },
    } },
  }), { mode: 0o600 });
  process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH = mirrorPath;
  if (mode === 'mirror') {
    process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
    delete process.env.CODEX_HOME; // Access-only resolver otherwise gives CODEX_HOME precedence.
  }
  else delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  const priorOverlay = setUserConfigOverlay((config) => ({ ...config,
    llm: { ...config.llm, codexTokenOwnerHost: ownerHost },
    hq: { ...config.hq, hostName: mode === 'owner' ? ownerHost : 'codex-test-client' },
  }));
  return () => {
    setUserConfigOverlay(priorOverlay);
    if (priorAccessOnly === undefined) delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
    else process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = priorAccessOnly;
    if (priorMirrorPath === undefined) delete process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH;
    else process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH = priorMirrorPath;
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
  };
}
