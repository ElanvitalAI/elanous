import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { userConfigPath } from '../user-config.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(120_000);

const entry = resolve(import.meta.dir, '../../bin/elanous.mjs');

function run(args: string[], configDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bun', [entry, '--config-dir', configDir, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('grounding sources cli', () => {
  test('add then list via the real entrypoint leaves ~/.elanous unchanged', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'grounding-sources-cli-'));
    const repo = mkdtempSync(join(tmpdir(), 'grounding-sources-cli-repo-'));
    writeFileSync(join(repo, 'README'), 'cli\n');
    const beforePath = userConfigPath();
    let beforeBytes: string | undefined;
    try { beforeBytes = readFileSync(beforePath, 'utf8'); } catch { beforeBytes = undefined; }
    try {
      const added = run(['grounding', 'sources', 'add', repo, '--json'], configDir);
      expect(added.status).toBe(0);
      const listed = run(['grounding', 'sources', 'list', '--json'], configDir);
      expect(listed.status).toBe(0);
      const rows = JSON.parse(listed.stdout) as Array<{ path?: string }>;
      const hits = rows.filter((row) => row.path === repo);
      expect(hits).toHaveLength(1);
      let afterBytes: string | undefined;
      try { afterBytes = readFileSync(beforePath, 'utf8'); } catch { afterBytes = undefined; }
      expect(afterBytes).toBe(beforeBytes);
      expect(userConfigPath()).toBe(beforePath);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
