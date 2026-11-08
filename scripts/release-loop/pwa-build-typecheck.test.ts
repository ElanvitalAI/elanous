import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pwaBuildTypecheckAffected, pwaBuildTypecheckProgramFiles, pwaBuildTypecheckProgramFilesForIntegration,
  pwaBuildTypecheckRemoteArgv, runPwaBuildTypecheck,
} from './pwa-build-typecheck.js';
import { runCommand, type CommandRunner } from './node-verdict.js';
import type { RemoteRunOptions } from '../../src/self-implement/gate-remote.js';

const head = 'a'.repeat(40);
const main = 'b'.repeat(40);

function fakeGit(changed: string): CommandRunner {
  return (command, args) => {
    expect(command).toBe('git');
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${head}\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { status: 0, stdout: `${main}\n`, stderr: '' };
    if (args[0] === 'merge-base') return { status: 0, stdout: `${main}\n`, stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: changed, stderr: '' };
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
}

test('PWA typecheck impact includes direct app changes and every transitive program path', () => {
  const pwaProgramFiles = new Set(['src/nexus/api/http-server.ts', 'scripts/release-loop/export-check-node.ts']);
  expect(pwaBuildTypecheckAffected(['apps/pwa/src/app/page.tsx'], pwaProgramFiles)).toBe(true);
  expect(pwaBuildTypecheckAffected(['src/nexus/api/http-server.ts'], pwaProgramFiles)).toBe(true);
  expect(pwaBuildTypecheckAffected(['scripts/release-loop/export-check-node.ts'], pwaProgramFiles)).toBe(true);
  expect(pwaBuildTypecheckAffected(['packages/pwa-shared/types.ts'], new Set(['packages/pwa-shared/types.ts']))).toBe(true);
  expect(pwaBuildTypecheckAffected(['src/release-loop/unrelated.ts', 'scripts/other.ts'], pwaProgramFiles)).toBe(false);
});

test('PWA TypeScript program records repository imports resolved through the app tsconfig', () => {
  const files = pwaBuildTypecheckProgramFiles(process.cwd());
  expect(files.has('apps/pwa/src/lib/graph-edge-route.test.ts')).toBe(true);
  expect(files.has('src/self-implement/run-step-projection.ts')).toBe(true);
}, 30_000);

test('integrated PWA import graph includes files introduced only by combining target config and PR files', () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-integration-graph-'));
  const runGit = (args: string[]) => {
    const result = runCommand('git', args, root);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  mkdirSync(join(root, 'apps', 'pwa', 'src'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'apps', 'pwa', 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'apps', 'pwa', 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(root, 'apps', 'pwa', 'src', 'app.ts'), 'export const app = true;\n');
  runGit(['init', '-q']);
  runGit(['config', 'user.name', 'PWA graph test']);
  runGit(['config', 'user.email', 'pwa-graph-test@example.invalid']);
  runGit(['add', '.']);
  runGit(['commit', '-qm', 'base']);
  const base = runGit(['rev-parse', 'HEAD']);
  runGit(['switch', '-qc', 'head']);
  writeFileSync(join(root, 'src', 'introduced.ts'), 'export const introduced = true;\n');
  runGit(['add', '.']);
  runGit(['commit', '-qm', 'PR source file']);
  const head = runGit(['rev-parse', 'HEAD']);
  runGit(['switch', '-qc', 'target', base]);
  writeFileSync(join(root, 'apps', 'pwa', 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true },
    include: ['src/**/*.ts', '../../src/**/*.ts'],
  }));
  runGit(['add', '.']);
  runGit(['commit', '-qm', 'target widens PWA program']);
  const target = runGit(['rev-parse', 'HEAD']);
  runGit(['switch', '-q', 'head']);
  try {
    expect(pwaBuildTypecheckProgramFiles(root).has('src/introduced.ts')).toBe(false);
    expect(pwaBuildTypecheckProgramFilesForIntegration(root, target, head).has('src/introduced.ts')).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PWA preflight runs the latest-main merge typecheck on aws2 and returns the remote result', () => {
  let request: RemoteRunOptions | undefined;
  const result = runPwaBuildTypecheck({ repo: process.cwd(), host: 'aws2', mirror: '~/mirror/elanous-agent.git' }, {
    run: fakeGit('src/nexus/api/http-server.ts\n'),
    pwaProgramFiles: new Set(['src/nexus/api/http-server.ts']),
    baselinePwaProgramFiles: new Set(['src/deleted-pwa-import.ts']),
    targetPwaProgramFiles: new Set(['src/main-only-pwa-import.ts']),
    integratedPwaProgramFiles: new Set(['packages/newly-included-pwa-import/types.ts']),
    runRemote: (options) => {
      request = options;
      return { kind: 'ran', rc: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), commit: head, host: 'aws2', ms: 5 };
    },
  });
  expect(result).toMatchObject({ status: 'passed', host: 'aws2' });
  expect(request).toMatchObject({ repo: process.cwd(), host: 'aws2', commit: head, installPwa: false });
  expect(request?.argv).toEqual(pwaBuildTypecheckRemoteArgv());
  const remoteScript = Array.isArray(request?.argv) ? request.argv.join(' ') : '';
  expect(remoteScript).toContain('git -c user.name="PWA typecheck" -c user.email="pwa-typecheck@example.invalid" merge --no-commit --no-ff origin/main');
  expect(remoteScript).toContain('git checkout --detach origin/main');
  expect(remoteScript).toContain('comm -23 "$PWA_TMP/merged.errors" "$PWA_TMP/main.errors"');
  expect(remoteScript).toContain('sort > "$PWA_TMP/main.errors"');
  expect(remoteScript).not.toContain('sort -u');
  expect(remoteScript).toContain('pwa-typecheck.XXXXXX');
  expect(remoteScript).toContain('bun run --cwd apps/pwa typecheck');
});

test('remote PWA comparator accepts only baseline diagnostics at the same source locations', () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-typecheck-script-test-'));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  const gitPath = join(bin, 'git');
  writeFileSync(gitPath, `#!/bin/sh\ncase "$*" in\n  *"merge --no-commit"*) touch "$STATE/merged" ;;\n  *"merge --abort"*|*"reset --hard"*) rm -f "$STATE/merged" ;;\n  *"checkout --detach"*) touch "$STATE/main" ;;\nesac\nexit 0\n`);
  const bunPath = join(bin, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\ncase "$*" in\n  *install*) exit 0 ;;\nesac\nif [ -f "$STATE/merged" ]; then\n  if [ "${'${MOVE_ERROR:-0}'}" = 1 ]; then printf '%s\\n' 'apps/pwa/a.ts(11,3): error TS2322: baseline'; else printf '%s\\n' 'apps/pwa/a.ts(8,3): error TS2322: baseline'; fi\n  printf '%s\\n' 'apps/pwa/b.ts(9,4): error TS2339: baseline' 'apps/pwa/b.ts(10,4): error TS2339: baseline'; exit 2\nfi\nprintf '%s\\n' 'apps/pwa/a.ts(8,3): error TS2322: baseline' 'apps/pwa/b.ts(9,4): error TS2339: baseline' 'apps/pwa/b.ts(10,4): error TS2339: baseline'; exit 1\n`);
  chmodSync(gitPath, 0o755);
  chmodSync(bunPath, 0o755);
  const script = pwaBuildTypecheckRemoteArgv()[2]!;
  try {
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, STATE: state, TMPDIR: root },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PWA_TYPECHECK_MAIN rc=1 diagnostics=3');
    expect(result.stdout).toContain('PWA_TYPECHECK_MERGED rc=2 diagnostics=3 introduced=0');
    const moved = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, STATE: state, TMPDIR: root, MOVE_ERROR: '1' },
    });
    expect(moved.status).toBe(1);
    expect(moved.stdout).toContain('introduced=1');
    expect(moved.stdout).toContain('apps/pwa/a.ts(11,3): error TS2322: baseline');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unrelated changes skip the PWA remote gate and an unsupported host is unmeasured', () => {
  let remoteCalls = 0;
  const skipped = runPwaBuildTypecheck({ repo: process.cwd(), host: 'gcp2', mirror: '~/mirror/elanous-agent.git' }, {
    run: fakeGit('src/release-loop/unrelated.ts\n'), pwaProgramFiles: new Set(), baselinePwaProgramFiles: new Set(), targetPwaProgramFiles: new Set(), integratedPwaProgramFiles: new Set(), runRemote: () => {
      remoteCalls++;
      return { kind: 'ran', rc: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), commit: head, host: 'gcp2', ms: 5 };
    },
  });
  const invalidHost = runPwaBuildTypecheck({ repo: process.cwd(), host: 'mshq', mirror: '~/mirror/elanous-agent.git' }, { runRemote: () => {
    remoteCalls++;
    return { kind: 'ran', rc: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), commit: head, host: 'mshq', ms: 5 };
  } });
  expect(skipped.status).toBe('skipped');
  expect(invalidHost.status).toBe('unmeasured');
  expect(remoteCalls).toBe(0);
});
