// Device: `createFakeBins` (src/ux-sim/fake-bin.ts) — fake `eln` · `bun` · `codex` · `ssh` · `kubectl` first on PATH.
// The real wsl-node-setup.sh runs under bash; no real host is touched (fake ssh records argv and fails).
// What this proves: the default mode is an offline plan (no ssh), the plan is deterministic across reruns,
// and every --apply refusal fires before the first ssh. What it does not prove: a real WSL host install.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFakeBins, type FakeBins, type FakeBinSpec } from '../../src/ux-sim/fake-bin.js';

const SCRIPT = resolve(import.meta.dir, 'wsl-node-setup.sh');
const STAGES = ['a2', 'a2b', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b8b', 'train-route', 'side-env'] as const;
const HOST_ARGS = ['--host', 'wsl2-test', '--distro', 'Ubuntu-24.04', '--win-user', 'tester'];

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function setup(overrides: Record<string, FakeBinSpec> = {}): { fake: FakeBins; run: (args: string[]) => { status: number | null; stdout: string; stderr: string } } {
  const fake = createFakeBins({
    eln: { stdout: '"0123456789abcdef0123456789abcdef01234567"\n' },
    bun: { stdout: '1.3.0\n' },
    codex: { stdout: 'codex-cli 0.50.0\n' },
    ssh: { exitCode: 255, stderr: 'fake ssh: no host\n' },
    kubectl: { exitCode: 1 },
    ...overrides,
  });
  const home = mkdtempSync(join(tmpdir(), 'wsl-node-setup-home-'));
  cleanups.push(() => { fake.cleanup(); rmSync(home, { recursive: true, force: true }); });
  const env = { PATH: fake.path('/usr/bin:/bin'), HOME: home, LANG: 'C' };
  return {
    fake,
    run: (args) => {
      const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 30_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
const sshCalls = (fake: FakeBins) => fake.calls().filter((c) => c.name === 'ssh');

describe('wsl-node-setup.sh dry-run (default mode)', () => {
  test('every stage plans offline: rc 0 · DRY-RUN header · no ssh · identical on rerun', () => {
    const { fake, run } = setup();
    for (const stage of STAGES) {
      const first = run([stage, ...HOST_ARGS]);
      const second = run([stage, ...HOST_ARGS, '--dry-run']);
      expect({ stage, status: first.status, stderr: first.stderr }).toEqual({ stage, status: 0, stderr: '' });
      expect(first.stdout).toContain(`DRY-RUN ${stage} host=wsl2-test distro=Ubuntu-24.04 win-user=tester mem=40GB(default example) pod-cap=4(default example) pin=0123456789ab`);
      expect(first.stdout.split('\n').length).toBeGreaterThan(2);
      expect(second.stdout).toBe(first.stdout);
    }
    expect(sshCalls(fake)).toEqual([]);
  });

  test('explicit --mem/--pod-cap drop the «default example» label', () => {
    const { run } = setup();
    const r = run(['b7', ...HOST_ARGS, '--mem', '48GB', '--pod-cap', '6']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('mem=48GB pod-cap=6 pin=');
    expect(r.stdout).toContain('podPool k3d-elanous-pool:6');
  });

  test('unreadable image pin plans as pin=unmeasured instead of failing', () => {
    const { run } = setup({ eln: { exitCode: 1 } });
    const r = run(['b4', ...HOST_ARGS]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pin=unmeasured');
  });

  test('b3 prints human-only credential commands with the host substituted and never runs them', () => {
    const { fake, run } = setup();
    const r = run(['b3', ...HOST_ARGS, '--apply']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('B3: 사람만 실행');
    expect(r.stdout).toContain('ssh wsl2-test ');
    expect(r.stdout).not.toContain('<wsl>');
    expect(sshCalls(fake)).toEqual([]);
  });

  test('train-route proposes registration with the fixed WSL policy', () => {
    const { run } = setup();
    const r = run(['train-route', ...HOST_ARGS]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('HOSTS+=(wsl2-test)');
    expect(r.stdout).toContain('fixed WSL policy 8 shards');
  });
});

describe('wsl-node-setup.sh --apply refusals fire before any ssh', () => {
  const cases: Array<[label: string, args: string[], rc: number, stderr: string, overrides?: Record<string, FakeBinSpec>]> = [
    ['train-route has no apply', ['train-route', ...HOST_ARGS, '--apply'], 2, 'train-route is a registration proposal only'],
    ['a2 apply needs explicit --mem', ['a2', ...HOST_ARGS, '--apply'], 2, '--apply a2 requires explicit --mem'],
    ['b7 apply needs explicit --pod-cap', ['b7', ...HOST_ARGS, '--mem', '40GB', '--apply'], 2, '--apply b7 requires explicit --mem (and --pod-cap for b7)'],
    ['b4 apply refuses an unreadable pin', ['b4', ...HOST_ARGS, '--apply'], 1, 'image pin unreadable; refusing apply', { eln: { exitCode: 1 } }],
    ['side-env apply without a live PID is UNMEASURED', ['side-env', ...HOST_ARGS, '--apply'], 12, 'UNMEASURED: run an actual side-pr.sh job'],
    ['unknown stage', ['b9', ...HOST_ARGS], 2, 'usage: wsl-node-setup.sh'],
    ['host with a shell metacharacter', ['b1', '--host', 'wsl;rm', '--distro', 'Ubuntu', '--win-user', 'tester'], 2, 'usage: wsl-node-setup.sh'],
    ['non-numeric side PID', ['side-env', ...HOST_ARGS, '--side-pid', '12x'], 2, 'usage: wsl-node-setup.sh'],
  ];
  for (const [label, args, rc, stderr, overrides] of cases) {
    test(label, () => {
      const { fake, run } = setup(overrides);
      const r = run(args);
      expect(r.status).toBe(rc);
      expect(r.stderr).toContain(stderr);
      expect(r.stdout).toBe('');
      expect(sshCalls(fake)).toEqual([]);
    });
  }

  test('unreachable host stops at the first BatchMode probe with «no changes»', () => {
    const { fake, run } = setup();
    const r = run(['a2', ...HOST_ARGS, '--mem', '40GB', '--apply']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SSH unavailable: wsl2-test; no changes');
    const calls = sshCalls(fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'wsl2-test', 'true']);
  });
});

// 📏 10-22 리뷰 r1(#30204): 원격 bash 는 할당문이 아닌 단어 속 «=~/» 의 틸드를 펼치지 않고 git 도 안 펼친다
//   (`bash -c 'echo --git-dir=~/x'` → `--git-dir=~/x` 그대로) — --apply 경로가 상대 경로 «~/…» 를 찾다 실패한다.
test('remote ssh commands never put a tilde right after «=» (bash does not expand it there)', () => {
  const remoteCommands = readFileSync(SCRIPT, 'utf8').split('\n')
    .filter((line) => /\bssh\b/.test(line))
    .flatMap((line) => [...line.matchAll(/'([^']*)'/g)].map((m) => m[1]!));
  expect(remoteCommands.length).toBeGreaterThan(0);
  // 할당문(`f=~/x`)은 bash 가 펼치므로 허용 — 잡는 것은 할당이 아닌 단어 속 «=~/»(예 `--git-dir=~/x`)뿐이다.
  const unexpanded = remoteCommands.flatMap((command) => command.split(/[\s;|&]+/))
    .filter((word) => /=~\//.test(word) && !/^[A-Za-z_][A-Za-z0-9_]*=~\//.test(word));
  expect(unexpanded).toEqual([]);
});

// 📏 10-22 리뷰 r3(#30204): PIN 은 12자로 잘린다 — git 은 줄인 SHA 를 fetch 대상(refspec)으로 받지 않아
//   «couldn't find remote ref» 로 fetch 전체가 실패한다. fetch 는 가지만, 줄인 SHA 는 로컬 checkout 에만 쓴다.
test('no git fetch passes the abbreviated pin as a refspec', () => {
  const fetchLines = readFileSync(SCRIPT, 'utf8').split('\n').filter((line) => /\bgit\b[^#]*\bfetch\b/.test(line));
  expect(fetchLines.length).toBeGreaterThan(0);
  expect(fetchLines.filter((line) => /\$\{?(pin|PIN)\b/.test(line))).toEqual([]);
});
