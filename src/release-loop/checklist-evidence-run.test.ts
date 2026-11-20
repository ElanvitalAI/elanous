import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateRemoteRunner } from '../self-implement/gate-remote.js';
import { resolveGateRemoteSettings } from '../self-implement/gate-remote.js';
import {
  EVIDENCE_PACKAGE_INSTALL_ARGV, EVIDENCE_RECEIPT_MARKER, EVIDENCE_REMOTE_ENTRY, dispatchEvidenceRun, evidenceRunPlan, owningPackageDir, evidenceRemoteArgv, evidenceTestHosts, outputTail, parseEvidenceReceipt,
  registryHostName, runEvidenceReceipt, runInIsolatedUniverse, type EvidenceRunRequest, type EvidenceSpawn, type RegistryHostEntry,
} from './checklist-evidence-run.js';

// 리터럴 출처: OP #112782 — 등록 시험 호스트 node-b · mbp · node-c, HQ mshq · 별칭 MacStudioB1 은 EVIDENCE-RUN-0331 README 의 node-b 자기 이름.
// sha 는 #39237 병합 커밋 · 칸·명령은 0.3.31 ELS-HERDR-IMPORT 원문 · 시각은 이 칸 작업일.
const commit = 'ce760462e8476ed9e5a41dfb19e12fd600b39547';
const mainSha = '2bdcf71cfc000000000000000000000000000000';
const runId = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const at = '2026-11-20T09:00:00.000Z';
const SUCCESS_RC = 0; // POSIX 성공 종료 코드
const request: EvidenceRunRequest = { runId, cellId: 'ELS-HERDR-IMPORT', version: '0.3.31', host: 'node-b', ledgerHost: 'mshq', commit, argv: ['bun', 'test', 'src/els/'] };
const registry: RegistryHostEntry[] = [
  { key: 'mshq', host: 'mshq' }, { key: 'node-b', host: 'node-b', aliases: ['MacStudioB1'] }, { key: 'mbp', host: 'mbp' }, { key: 'node-c', host: 'node-c' },
];

test('registryHostName maps a self-reported name to its registry entry through the entry aliases', () => {
  expect(registryHostName('MacStudioB1', registry)).toBe('node-b');
  expect(registryHostName('node-b', registry)).toBe('node-b');
  expect(registryHostName('unregistered', registry)).toBeNull();
});

test('evidenceTestHosts keeps registry order and drops the HQ host (by alias too)', () => {
  expect(evidenceTestHosts(registry, ['mshq'])).toEqual(['node-b', 'mbp', 'node-c']);
  expect(evidenceTestHosts(registry, ['MacStudioB1', 'mshq'])).toEqual(['mbp', 'node-c']);
  expect(evidenceTestHosts([], ['mshq'])).toEqual([]);
});

test('remote argv is bun + the repo entry + request fields + the allow-listed test argv — no shell', () => {
  const argv = evidenceRemoteArgv(request);
  expect(argv).toEqual(['bun', EVIDENCE_REMOTE_ENTRY, runId, 'ELS-HERDR-IMPORT', '0.3.31', 'node-b', 'mshq', commit, 'bun', 'test', 'src/els/']);
  for (const shell of ['sh', 'bash', 'zsh', '-c', 'eval']) expect(argv).not.toContain(shell);
});

function fakeRunner(receiptJson: string) {
  const scripts: { host: string; script: string }[] = [];
  const pushes: string[][] = [];
  const runner: GateRemoteRunner = {
    local(cmd, args) {
      if (cmd === 'git' && args[0] === 'cat-file') return { rc: 0, stdout: 'commit\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, stdout: `${mainSha}\n`, stderr: '' };
      if (cmd === 'git' && args[0] === 'config') return { rc: 0, stdout: 'git@github.com:ElanvitalAI/elanous.git\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'push') { pushes.push(args); return { rc: 0, stdout: '', stderr: '' }; }
      return { rc: 1, stdout: '', stderr: 'unexpected' };
    },
    ssh(host, script) {
      scripts.push({ host, script });
      return { rc: 0, stdout: `${EVIDENCE_RECEIPT_MARKER}${receiptJson}\n`, stderr: ' 3 pass\n 0 fail\n\n__GATE_REMOTE_RC=0\n' };
    },
  };
  return { runner, scripts, pushes };
}

test('dispatchEvidenceRun reuses runOnRemote: pushes the HQ commit, checks it out detached, runs the quoted argv in a scratch state — rc, receipt and output tail come back', () => {
  const receipt = { ...request, selfReportedHost: 'MacStudioB1', command: 'bun test src/els/', rc: SUCCESS_RC, durationMs: 0, at };
  const { runner, scripts, pushes } = fakeRunner(JSON.stringify(receipt));
  const outcome = dispatchEvidenceRun(request, process.cwd(), { settings: resolveGateRemoteSettings(undefined), runner });
  expect(outcome).toEqual({ kind: 'ran', rc: SUCCESS_RC, receipt: expect.objectContaining({ runId, cellId: 'ELS-HERDR-IMPORT', host: 'node-b', commit }), outputTail: ' 3 pass\n 0 fail' });
  expect(pushes[0]).toContain(`${commit}:refs/elanous/gate/${commit}`);
  expect(scripts.map((row) => row.host)).toEqual(['node-b']);
  const script = scripts[0]!.script;
  expect(script).toContain(`git checkout -q --detach ${commit}`);
  const runLine = script.split('\n').find((line) => line.includes(`'${EVIDENCE_REMOTE_ENTRY}'`))!;
  expect(runLine).toContain(`ELANOUS_STATE_DIR="$W/state" ELANOUS_GATE_REMOTE_CHILD=1 ${evidenceRemoteArgv(request).map((arg) => `'${arg}'`).join(' ')} </dev/null`);
  expect(runLine).not.toMatch(/'(?:sh|bash)' '-c'/u);
});

test('dispatchEvidenceRun reports an unreachable host (push/ssh failure) without a receipt', () => {
  const { runner } = fakeRunner('{}');
  const failing: GateRemoteRunner = { ...runner, local: (cmd, args, cwd, options) => cmd === 'git' && args[0] === 'push' ? { rc: 128, stdout: '', stderr: 'ssh: connect to host node-b port 22: Operation timed out' } : runner.local(cmd, args, cwd, options) };
  const outcome = dispatchEvidenceRun(request, process.cwd(), { settings: resolveGateRemoteSettings(undefined), runner: failing });
  expect(outcome.kind).toBe('unreachable');
});

test('runEvidenceReceipt (test-host half): runs the allow-listed argv with a credential-free env, logs one event, prints the receipt', () => {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: EvidenceSpawn = (command, args, options) => { calls.push({ command, args, env: options.env }); return { status: SUCCESS_RC }; };
  const parent = { PATH: '/usr/bin:/bin', LANG: 'ko_KR.UTF-8', HOME: '/Users/operator', GITHUB_TOKEN: 'ghp_fake_secret', ANTHROPIC_API_KEY: 'sk-ant-fake', SSH_AUTH_SOCK: '/tmp/agent.sock', ELANOUS_STATE_DIR: '/Users/operator/.elanous' };
  const logged: Record<string, unknown>[] = [];
  const printed: string[] = [];
  const rc = runEvidenceReceipt([runId, 'ELS-HERDR-IMPORT', '0.3.31', 'node-b', 'mshq', commit, 'bun', 'test', 'src/els/'], {
    execute: (argv, cwd) => runInIsolatedUniverse(argv, cwd, parent, spawn), log: (data) => { logged.push(data); },
    selfReportedHost: () => 'MacStudioB1', now: () => new Date(at), cwd: process.cwd(), print: (line) => { printed.push(line); },
  });
  expect(rc).toBe(SUCCESS_RC);
  expect(calls.map(({ command, args }) => [command, ...args])).toEqual([['bun', 'test', 'src/els/']]);
  const env = calls[0]!.env;
  expect(Object.keys(env).sort()).toEqual(['ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'TMPDIR']);
  for (const secret of ['ghp_fake_secret', 'sk-ant-fake', '/tmp/agent.sock', '/Users/operator/.elanous']) expect(Object.values(env)).not.toContain(secret);
  expect(logged).toEqual([expect.objectContaining({ runId, cellId: 'ELS-HERDR-IMPORT', rc: SUCCESS_RC, host: 'node-b', executedOn: 'node-b', selfReportedHost: 'MacStudioB1', ledgerHost: 'mshq', commit, layer: 'test', at })]);
  expect(parseEvidenceReceipt(printed.join('\n'))).toMatchObject({ runId, rc: SUCCESS_RC, at, host: 'node-b' });
});

for (const argv of [['bun', 'test', '/etc/passwd'], ['sh', '-c', 'bun test src/els/'], ['bun', 'test', '--preload', 'evil.ts', 'src/els/'], ['bun', 'test']]) {
  test(`runEvidenceReceipt refuses a non-allow-listed argv (${argv.join(' ')}) — nothing executed or logged`, () => {
    const executed: (readonly string[])[] = [];
    const logged: Record<string, unknown>[] = [];
    expect(() => runEvidenceReceipt([runId, 'ELS-HERDR-IMPORT', '0.3.31', 'node-b', 'mshq', commit, ...argv], {
      execute: (run) => { executed.push(run); return { status: SUCCESS_RC }; }, log: (data) => { logged.push(data); },
      selfReportedHost: () => 'node-b', now: () => new Date(at), cwd: process.cwd(), print: () => {},
    })).toThrow('evidence receipt');
    expect([executed, logged]).toEqual([[], []]);
  });
}

test('outputTail keeps only the last lines of the remote output', () => {
  const text = Array.from({ length: 3 }, (_, index) => `line ${index}`).join('\n');
  expect(outputTail(`${text}\n`, 2)).toBe('line 1\nline 2');
});

// ── workspace package cwd (OP #113166 ①: 구조 판정 — 가장 가까운 package.json · 문자열 정규식 0) ─────────────────────
// 리터럴 출처: 0.3.31 PWA-INTAKE-N1-N5A-N6A 칸 증거 명령(bun test apps/pwa/src/app/intake/page.test.tsx) · 이 저장소의 apps/pwa 꼴(자체 bun.lock · 루트 workspaces 없음).
const pwaTest = 'apps/pwa/src/app/intake/page.test.tsx';
const FAILURE_RC = 1; // bun install / bun test 실패 종료 코드
const fixtureBase = realpathSync(mkdtempSync(join(tmpdir(), 'evidence-pkg-')));
afterAll(() => { rmSync(fixtureBase, { recursive: true, force: true }); });
let fixtureCount = 0; // Source: fixture directories are numbered from zero per test file (NUMGUARD)
function repoFixture(options: { pwaInstalled?: boolean } = {}): string {
  const root = join(fixtureBase, `repo-${fixtureCount++}`);
  const file = (path: string, text = '') => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  file('package.json', '{"name":"elanous"}'); file('src/els/herdr-import.test.ts');
  file('apps/pwa/package.json', '{"name":"@elanous/pwa"}'); file('apps/pwa/bun.lock'); file(pwaTest);
  file('apps/desktop/package.json', '{"name":"@elanous/desktop"}'); file('apps/desktop/src/main.test.ts');
  if (options.pwaInstalled) mkdirSync(join(root, 'apps/pwa/node_modules'));
  // A package-shaped directory outside the repo, reachable only through a symlink inside it.
  const outside = join(fixtureBase, `outside-${fixtureCount}`);
  mkdirSync(join(outside, 'src'), { recursive: true }); writeFileSync(join(outside, 'package.json'), '{}');
  symlinkSync(outside, join(root, 'apps/escape'));
  return root;
}

test('owningPackageDir walks up to the nearest package.json below the root — the root package.json never counts', () => {
  const root = repoFixture();
  expect(owningPackageDir(root, pwaTest)).toBe('apps/pwa');
  expect(owningPackageDir(root, 'apps/pwa/src/')).toBe('apps/pwa');
  expect(owningPackageDir(root, 'src/els/herdr-import.test.ts')).toBeNull();
  expect(owningPackageDir(root, 'src/els/')).toBeNull();
});

test('evidence plan: a package path runs from the package dir with the path rewritten relative to it; install when its node_modules is absent', () => {
  const root = repoFixture();
  expect(evidenceRunPlan(root, ['bun', 'test', pwaTest])).toEqual({ packageDir: 'apps/pwa', argv: ['bun', 'test', 'src/app/intake/page.test.tsx'], install: true });
  expect(evidenceRunPlan(root, ['bun', 'test', 'apps/pwa/src/app/', pwaTest])).toEqual({ packageDir: 'apps/pwa', argv: ['bun', 'test', 'src/app/', 'src/app/intake/page.test.tsx'], install: true });
  expect(evidenceRunPlan(repoFixture({ pwaInstalled: true }), ['bun', 'test', pwaTest])).toMatchObject({ packageDir: 'apps/pwa', install: false });
  // A package with no lockfile of its own is never installed by the run.
  expect(evidenceRunPlan(root, ['bun', 'test', 'apps/desktop/src/main.test.ts'])).toEqual({ packageDir: 'apps/desktop', argv: ['bun', 'test', 'src/main.test.ts'], install: false });
});

test('evidence plan: root paths are unchanged', () => {
  const root = repoFixture();
  expect(evidenceRunPlan(root, ['bun', 'test', 'src/els/'])).toEqual({ packageDir: null, argv: ['bun', 'test', 'src/els/'], install: false });
});

for (const [label, paths] of [
  ['two different packages', [pwaTest, 'apps/desktop/src/main.test.ts']],
  ['the root mixed with a package', ['src/els/', pwaTest]],
] as const) {
  test(`evidence plan refuses paths spanning ${label}`, () => {
    const plan = evidenceRunPlan(repoFixture(), ['bun', 'test', ...paths]);
    expect(plan).toEqual({ refused: expect.stringContaining('서로 다른 패키지') });
  });
}

test('evidence plan refuses a package directory that is a symlink out of the repo (realpath check)', () => {
  const root = repoFixture();
  expect(owningPackageDir(root, 'apps/escape/src/x.test.ts')).toBe('apps/escape');
  expect(evidenceRunPlan(root, ['bun', 'test', 'apps/escape/src/x.test.ts'])).toEqual({ refused: expect.stringContaining('저장소 밖') });
});

function receiptRun(root: string, argv: readonly string[], installRc = SUCCESS_RC) {
  const runs: { argv: readonly string[]; cwd: string }[] = [];
  const logged: Record<string, unknown>[] = [];
  const printed: string[] = [];
  const rc = runEvidenceReceipt([runId, 'PWA-INTAKE-N1-N5A-N6A', '0.3.31', 'node-b', 'mshq', commit, ...argv], {
    execute: (run, cwd) => { runs.push({ argv: run, cwd }); return { status: run[1] === 'install' ? installRc : SUCCESS_RC }; },
    log: (data) => { logged.push(data); }, selfReportedHost: () => 'MacStudioB1', now: () => new Date(at), cwd: root, print: (line) => { printed.push(line); },
  });
  return { rc, runs, logged, receipt: parseEvidenceReceipt(printed.join('\n')) };
}

test('runEvidenceReceipt: a package path installs from the package lockfile, runs bun test from the package dir, and records cwd in the event and receipt', () => {
  const root = repoFixture();
  const { rc, runs, logged, receipt } = receiptRun(root, ['bun', 'test', pwaTest]);
  expect(rc).toBe(SUCCESS_RC);
  expect(runs).toEqual([{ argv: [...EVIDENCE_PACKAGE_INSTALL_ARGV], cwd: join(root, 'apps/pwa') }, { argv: ['bun', 'test', 'src/app/intake/page.test.tsx'], cwd: join(root, 'apps/pwa') }]);
  expect(logged).toEqual([expect.objectContaining({ cwd: 'apps/pwa', argv: ['bun', 'test', 'src/app/intake/page.test.tsx'], installRc: SUCCESS_RC, command: `bun test ${pwaTest}`, rc: SUCCESS_RC })]);
  expect(receipt).toMatchObject({ cwd: 'apps/pwa', command: `bun test ${pwaTest}` });
});

test('runEvidenceReceipt: a failed package install is the run rc — the test is not run', () => {
  const { rc, runs, logged } = receiptRun(repoFixture(), ['bun', 'test', pwaTest], FAILURE_RC);
  expect(rc).toBe(FAILURE_RC);
  expect(runs.map((run) => run.argv[1])).toEqual(['install']);
  expect(logged).toEqual([expect.objectContaining({ rc: FAILURE_RC, installRc: FAILURE_RC, error: expect.stringContaining('bun install --frozen-lockfile') })]);
});

test('runEvidenceReceipt: a root path runs from the checkout root with no cwd field (unchanged)', () => {
  const root = repoFixture();
  const { runs, logged, receipt } = receiptRun(root, ['bun', 'test', 'src/els/']);
  expect(runs).toEqual([{ argv: ['bun', 'test', 'src/els/'], cwd: root }]);
  expect(logged[0]).not.toHaveProperty('cwd');
  expect(receipt).not.toHaveProperty('cwd');
});

for (const [label, paths] of [['mixed packages', [pwaTest, 'apps/desktop/src/main.test.ts']], ['a symlink escape', ['apps/escape/src/x.test.ts']]] as const) {
  test(`runEvidenceReceipt refuses ${label} — nothing executed or logged`, () => {
    const root = repoFixture();
    const runs: (readonly string[])[] = [];
    const logged: Record<string, unknown>[] = [];
    expect(() => runEvidenceReceipt([runId, 'PWA-INTAKE-N1-N5A-N6A', '0.3.31', 'node-b', 'mshq', commit, 'bun', 'test', ...paths], {
      execute: (run) => { runs.push(run); return { status: SUCCESS_RC }; }, log: (data) => { logged.push(data); },
      selfReportedHost: () => 'node-b', now: () => new Date(at), cwd: root, print: () => {},
    })).toThrow('evidence receipt');
    expect([runs, logged]).toEqual([[], []]);
  });
}
