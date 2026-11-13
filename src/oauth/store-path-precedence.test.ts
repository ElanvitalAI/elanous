import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('explicit default config or state dir outranks XDG auth store', () => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-auth-precedence-'));
  try {
    const script = `
      import { join } from 'node:path';
      import { homedir } from 'node:os';
      import { setElanousConfigDir, resetElanousConfigDir } from ${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.ts'))};
      import { authStorePath } from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
      const selected = join(homedir(), '.elanous');
      const xdg = join(process.env.XDG_CONFIG_HOME, 'elanous', 'auth.json');
      setElanousConfigDir(selected);
      if (authStorePath() !== join(selected, 'auth.json')) throw new Error('explicit config-dir lost to XDG');
      resetElanousConfigDir();
      process.env.ELANOUS_STATE_DIR = selected;
      if (authStorePath() !== join(selected, 'auth.json')) throw new Error('explicit state-dir lost to XDG');
      delete process.env.ELANOUS_STATE_DIR;
      if (authStorePath() !== xdg) throw new Error('implicit default did not use XDG');
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') };
    delete env.ELANOUS_STATE_DIR;
    const result = Bun.spawnSync(['bun', '-e', script], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
