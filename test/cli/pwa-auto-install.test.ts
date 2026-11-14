import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPwaBuild } from '../../src/cli/pwa-build.js';
import { simCli } from '../../src/ux-sim/in-process-cli.js';

function coldTree() {
  const cwd = mkdtempSync(join(tmpdir(), 'pwa-auto-install-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { next: '1', react: '1', '@dagrejs/dagre': '1' } }));
  writeFileSync(join(cwd, 'bun.lock'), 'synthetic locked fixture');
  const install = () => {
    for (const name of ['next', 'react', '@dagrejs/dagre']) {
      const path = join(cwd, 'node_modules', name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), '{}');
    }
  };
  return { cwd, install, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const quiet = { log: () => {}, error: () => {} };

test('cold PWA build installs locked dependencies, rechecks, then builds in the same cwd', async () => {
  const fixture = coldTree();
  const calls: string[] = [];
  try {
    const result = await runPwaBuild({ cwd: fixture.cwd, out: quiet, spawnFn: async (cmd, args, cwd) => {
      expect(cwd).toBe(fixture.cwd);
      calls.push(`${cmd} ${args.join(' ')}`);
      if (args[0] === 'install') fixture.install();
      return 0;
    } });
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(['bun install --frozen-lockfile', 'bun run build']);
  } finally { fixture.cleanup(); }
});

test('failed install does not reach build and a later call can retry', async () => {
  const fixture = coldTree();
  const calls: string[] = [];
  try {
    const failed = await runPwaBuild({ cwd: fixture.cwd, out: quiet, spawnFn: async (_cmd, args) => {
      calls.push(args.join(' '));
      return 7;
    } });
    expect(failed.exitCode).toBe(7);
    expect(calls).toEqual(['install --frozen-lockfile']);
    const retried = await runPwaBuild({ cwd: fixture.cwd, out: quiet, spawnFn: async (_cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'install') fixture.install();
      return 0;
    } });
    expect(retried.exitCode).toBe(0);
    expect(calls.slice(1)).toEqual(['install --frozen-lockfile', 'run build']);
  } finally { fixture.cleanup(); }
});

test('install exit zero without dependencies, and rejected build, never report success', async () => {
  const fixture = coldTree();
  let builds = 0;
  try {
    const missing = await runPwaBuild({ cwd: fixture.cwd, out: quiet, spawnFn: async (_cmd, args) => {
      if (args[0] === 'run' && args[1] === 'build') builds++;
      return 0;
    } });
    expect(missing.exitCode).toBe(1);
    expect(builds).toBe(0);
    fixture.install();
    const rejected = await runPwaBuild({ cwd: fixture.cwd, out: quiet, spawnFn: async () => 9 });
    expect(rejected.exitCode).toBe(9);
  } finally { fixture.cleanup(); }
});

test('missing lockfile refuses installation before any process is spawned', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pwa-no-lock-'));
  let calls = 0;
  try {
    writeFileSync(join(cwd, 'package.json'), '{}');
    const result = await runPwaBuild({ cwd, out: quiet, spawnFn: async () => { calls++; return 0; } });
    expect(result.exitCode).toBe(1);
    expect(calls).toBe(0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('actual nexus build entry fails on cold install failure and succeeds on retry with a fake bun', async () => {
  const fixture = coldTree();
  const bin = join(fixture.cwd, 'fake-bin');
  mkdirSync(bin);
  const fakeBun = join(bin, 'bun');
  writeFileSync(fakeBun, `#!/bin/sh
set -eu
if [ "$1" = install ]; then
  if [ -e fail-install ]; then exit 7; fi
  for dep in next react @dagrejs/dagre; do mkdir -p "node_modules/$dep"; printf '{}' > "node_modules/$dep/package.json"; done
  exit 0
fi
if [ "$1" = run ] && [ "$2" = build ]; then mkdir -p out; printf '<html></html>' > out/index.html; exit 0; fi
exit 9
`);
  chmodSync(fakeBun, 0o700);
  const run = () => simCli(['nexus', 'build', '--cwd', fixture.cwd], {
    mode: 'spawn', allowPaths: [['nexus', 'build']], timeoutMs: 30_000,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  try {
    writeFileSync(join(fixture.cwd, 'fail-install'), '1');
    const failed = await run();
    expect(failed.exitCode).toBe(7);
    expect(failed.stdout + failed.stderr).toContain('dependency install failed');
    rmSync(join(fixture.cwd, 'fail-install'));
    const retried = await run();
    expect(retried.exitCode).toBe(0);
    expect(retried.stdout + retried.stderr).toContain('build succeeded');
  } finally { fixture.cleanup(); }
});
