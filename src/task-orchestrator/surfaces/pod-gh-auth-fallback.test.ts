import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_GH_AUTH_SCRIPT } from './self-implement-pod.js';

// PODCRED2 — the in-pod fallback that writes hosts.yml when `gh auth login` fails must accept the real
// installation-token shape (`.` and `-`, hundreds of chars); rejecting it turned every gh hiccup into exit 7.
function runFallback(token: string): { status: number; hosts: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'podcred2-'));
  try {
    const run = Bun.spawnSync(['bun', '-e', APP_GH_AUTH_SCRIPT], { stdin: Buffer.from(`${token}\n`), env: { ...process.env, GH_CONFIG_DIR: join(dir, 'gh') } });
    let hosts: string | null = null;
    try { hosts = readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8'); } catch { /* not written */ }
    return { status: run.exitCode ?? -1, hosts };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('pod gh auth fallback token shape', () => {
  test('a long installation token with dots and dashes is installed', () => {
    const token = `ghs_${'A1b2'.repeat(40)}.${'c-D_e'.repeat(20)}.${'9'.repeat(30)}`;
    const result = runFallback(token);
    expect(result.status).toBe(0);
    expect(result.hosts).toContain(`oauth_token: ${token}\n`);
  });

  test('tokens that could break the YAML line are still refused', () => {
    for (const token of ['', '-leading-dash', 'ghs_x y', 'ghs_x:y', 'ghs_x\ny', ' ghs_leading_space', 'ghs_trailing_space ', '\tghs_tab']) {
      const result = runFallback(token);
      expect(result.status).not.toBe(0);
      expect(result.hosts).toBeNull();
    }
  });
});
