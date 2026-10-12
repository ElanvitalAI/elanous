import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

type Probe = { manifest?: string; logs?: string; state?: string };

function probe(options: { treeDerivedTest: boolean; stateDir?: string }): { output: Probe; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'pty-manifest-path-home-'));
  mkdirSync(join(home, '.elanous'));
  writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({
    instance: { treeDerivedTest: options.treeDerivedTest },
  }));
  writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({
    tree: '/another/tree/leader',
    promotedAt: 'test',
  }));

  const script = `
    const { ptyManifestDbPath } = require(${JSON.stringify(`${process.cwd()}/src/pty-shell/pty-manifest.ts`)});
    const { logsDbPath } = require(${JSON.stringify(`${process.cwd()}/src/mss/logging/log-store.ts`)});
    const { elanousStateRoot } = require(${JSON.stringify(`${process.cwd()}/src/autopilot/state-paths.ts`)});
    console.log(JSON.stringify({ manifest: ptyManifestDbPath(), logs: logsDbPath(), state: elanousStateRoot() }));
  `;
  const result = spawnSync('bun', ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      ELANOUS_STATE_DIR: options.stateDir ?? '',
      ELANOUS_CONFIG_DIR: '',
      ELANOUS_NEXUS_DIR: '',
      ELANOUS_SESSION_ROOT: '',
    },
  });
  expect(result.status).toBe(0);
  return {
    output: JSON.parse((result.stdout ?? '').trim().split('\n').pop() ?? '{}') as Probe,
    home,
  };
}

describe('ptyManifestDbPath instance resolution', () => {
  test('source process without ELANOUS_STATE_DIR uses the operating house for all stores', () => {
    const { output, home } = probe({ treeDerivedTest: true });
    try {
      expect(output.state).toBe(join(home, '.elanous'));
      expect(output.manifest).toBe(join(output.state!, 'pty', 'manifest.db'));
      expect(output.logs).toBe(join(output.state!, 'logs', 'logs.db'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  test('explicit ELANOUS_STATE_DIR preserves the manifest path exactly', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pty-manifest-explicit-'));
    const { output, home } = probe({ treeDerivedTest: true, stateDir });
    try {
      expect(output.state).toBe(stateDir);
      expect(output.manifest).toBe(join(stateDir, 'pty', 'manifest.db'));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('retired treeDerivedTest:false does not alter the explicit-only universe rule', () => {
    const { output, home } = probe({ treeDerivedTest: false });
    try {
      expect(output.state).toBe(join(home, '.elanous'));
      expect(output.manifest).toBe(join(output.state!, 'pty', 'manifest.db'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
