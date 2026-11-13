import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { discoverPostOfficeUrl, readPostOffice } from '../msg/msg-post-office.js';
import { setTestStateRoot } from './paths.js';
import { runNexus } from './index.js';

test('isolated Nexus boot owns the resident message SSE listener until release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-msg-sse-resident-'));
  setElanousConfigDir(root);
  setTestStateRoot(root);
  let handle: Awaited<ReturnType<typeof runNexus>>;
  try {
    handle = await runNexus({ detachForTesting: true, skipHttpServer: true, skipRuntimeApi: true,
      skipSupervisor: true, mcpEnabled: false, skipRestoreFromPending: true, skipEnvMigration: true,
      cleanGhostTailscaleServeFn: async () => {},
      msgSseForTesting: { stateRoot: root, token: 'fake-nexus-token', port: 0 },
    });
    expect(handle).toBeDefined();
    const info = readPostOffice(root);
    expect(info).not.toBeNull();
    expect(await discoverPostOfficeUrl(root)).toBe(info!.url);
    const stream = await fetch(`${info?.url}/stream?to=TC&since=0`, { headers: { Authorization: 'Bearer fake-nexus-token' } });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    // release is `() => void | Promise<void>` (PR #36421 made the shutdown
    // path async via the Guardian train-worker drain) — the post-office clear
    // is only observable after the returned promise settles.
    await handle?.release();
    handle = undefined;
    expect(readPostOffice(root)).toBeNull();
  } finally {
    handle?.release();
    setTestStateRoot(null);
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});
