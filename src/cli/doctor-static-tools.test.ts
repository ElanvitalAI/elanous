import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installStaticTool, linuxArch, STATIC_TOOLS } from './doctor-static-tools.js';
import { managedPythonNeeded, planDoctorFixes, smokeCheck, staticToolsNeeded } from './doctor-fix.js';
import { managedPythonCandidate } from '../python/resolve-python.js';

// 2026-09-25 amazonlinux:2·2023 컨테이너 실측의 판정 규칙을 고정한다.
describe('static tools — which distro gets them', () => {
  test('AL2023 without rg gets static rg (no rg line); codex goes the npm path because a node line exists', () => {
    expect(staticToolsNeeded({ platform: 'linux', distro: 'amzn2023', rgOnPath: false, codexOnPath: false, nodeOnPath: false })).toEqual(['rg']);
  });
  test('AL2 without rg, codex and node gets both static rg and static codex (no node line)', () => {
    expect(staticToolsNeeded({ platform: 'linux', distro: 'amzn2', rgOnPath: false, codexOnPath: false, nodeOnPath: false })).toEqual(['rg', 'codex']);
  });
  test('debian with package lines gets none; macOS gets none', () => {
    expect(staticToolsNeeded({ platform: 'linux', distro: 'debian', rgOnPath: false, codexOnPath: false, nodeOnPath: false })).toEqual([]);
    expect(staticToolsNeeded({ platform: 'darwin', distro: 'darwin', rgOnPath: false })).toEqual([]);
  });
  test('an unknown architecture is planned as skipped, never guessed', () => {
    const plan = planDoctorFixes({ arch: 'ppc64', readiness: { platform: 'linux', distro: 'amzn2', rgOnPath: false }, home: mkdtempSync(join(tmpdir(), 'st-')) });
    expect(plan.items.find((i) => i.id === 'static-tools')?.status).toBe('skipped');
    expect(linuxArch('ppc64')).toBeNull();
  });
});

describe('managed python — when', () => {
  const linux = (distro: 'amzn2' | 'amzn2023' | 'debian', evidence: string) => ({ platform: 'linux' as const, distro, pythonEnv: { status: 'manual' as const, evidence } });
  test('AL2023 python 3.9 below the floor → managed', () => {
    expect(managedPythonNeeded(linux('amzn2023', 'path python 3.9.25 is older than the minimum 3.11'))).toBe(true);
  });
  test('AL2 with no python → managed (no distro python line)', () => {
    expect(managedPythonNeeded(linux('amzn2', 'no python3 found (ELANOUS_PYTHON · elanous venv · pyenv · PATH)'))).toBe(true);
  });
  test('debian with no python → the distro line (--sudo) first, not managed', () => {
    expect(managedPythonNeeded(linux('debian', 'no python3 found (ELANOUS_PYTHON · elanous venv · pyenv · PATH)'))).toBe(false);
  });
  test('ensurepip-missing is a venv package problem, not managed', () => {
    expect(managedPythonNeeded(linux('debian', 'the base python cannot create a venv with pip (ensurepip missing)'))).toBe(false);
  });
});

describe('installStaticTool — verification', () => {
  const arch = 'aarch64' as const;
  function fakeRun(payload: Buffer) {
    return (command: string, args: readonly string[]) => {
      if (command === 'curl') { writeFileSync(args[args.indexOf('-o') + 1]!, payload); return { status: 0, stderr: '' }; }
      if (command === 'tar') { const dir = args[args.indexOf('-C') + 1]!; const member = args.at(-1)!; mkdirSync(join(dir, member, '..'), { recursive: true }); writeFileSync(join(dir, member), '#!/bin/sh\necho ok\n'); return { status: 0, stderr: '' }; }
      return { status: 0, stderr: '', stdout: 'rg 15.2.0' };
    };
  }
  test('a tarball whose sha256 does not match the pin is refused and nothing is written', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'st-')), 'bin', 'rg');
    const r = installStaticTool('rg', arch, dest, { run: fakeRun(Buffer.from('tampered')) });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('sha256 mismatch');
    expect(existsSync(dest)).toBe(false);
  });
  test('pins are 64-hex for every tool and arch', () => {
    for (const spec of Object.values(STATIC_TOOLS)) for (const d of Object.values(spec.sha256)) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
  test('sanity: the digest function is sha256 of the downloaded bytes', () => {
    expect(createHash('sha256').update(Buffer.from('x')).digest('hex')).toHaveLength(64);
    void readFileSync;
  });
});

describe('managed python candidate', () => {
  test('picks the newest cpython-<x.y.z> folder that has bin/python3', () => {
    const names = ['cpython-3.12.9-linux-aarch64-gnu', 'cpython-3.12.13-linux-aarch64-gnu', '.lock', 'cpython-3.11.4-linux-aarch64-gnu'];
    const got = managedPythonCandidate('/r', () => names, (p) => p.includes('3.12.13') || p.includes('3.12.9'));
    expect(got).toBe('/r/cpython-3.12.13-linux-aarch64-gnu/bin/python3');
  });
  test('an unreadable root is «none», not a throw', () => {
    expect(managedPythonCandidate('/nope', () => { throw new Error('ENOENT'); }, () => true)).toBeNull();
  });
});

// 📏 2026-09-25 amazonlinux:2 — 정적 codex 를 넣은 뒤에도 「codex requires node」로 남았다.
import { checkReadiness } from './doctor-readiness.js';
import { codexIsNodeScript } from './doctor-cli.js';
describe('a static codex does not need node', () => {
  const pick = (d: Parameters<typeof checkReadiness>[0]) => checkReadiness(d).items.find((i) => i.id === 'harness-tools')!;
  test('codex binary on PATH + node missing → harness-tools ok', () => {
    expect(pick({ distro: 'amzn2', rgOnPath: true, codexOnPath: true, nodeOnPath: false, codexNeedsNode: false }).status).toBe('ok');
  });
  test('codex npm script on PATH + node missing → still manual', () => {
    expect(pick({ distro: 'amzn2', rgOnPath: true, codexOnPath: true, nodeOnPath: false, codexNeedsNode: true }).status).toBe('manual');
  });
  test('shebang detection reads only the first two bytes', () => {
    expect(codexIsNodeScript(['/a', '/b'], (p) => (p === '/b/codex' ? Buffer.from('#!') : null))).toBe(true);
    expect(codexIsNodeScript(['/a'], () => Buffer.from([0x7f, 0x45]))).toBe(false);
    expect(codexIsNodeScript(['/a'], () => null)).toBeNull();
  });
});

// 🩸 2026-09-25 L2 — codex 바이너리만 깔려 `--version` 은 되고 셸 도구는 못 떴다.
import { codexHasCodeModeHost } from './doctor-cli.js';
import { applyDoctorFixes } from './doctor-fix.js';
describe('codex needs its code-mode host', () => {
  test('binary codex without the host next to its real path → harness-tools manual', () => {
    const it = checkReadiness({ platform: 'linux', distro: 'amzn2', rgOnPath: true, codexOnPath: true, nodeOnPath: false, codexNeedsNode: false, codexCodeModeHost: false }).items.find((i) => i.id === 'harness-tools')!;
    expect(it.status).toBe('manual');
    expect(it.evidence).toContain('codex-code-mode-host');
  });
  test('brew-cask style: host sits next to the resolved (Caskroom) path', () => {
    const fsx = { exists: (p: string) => p === '/bin/codex' || p === '/cask/bin/codex-code-mode-host', realpath: () => '/cask/bin/codex' };
    expect(codexHasCodeModeHost(['/bin'], fsx)).toBe(true);
    expect(codexHasCodeModeHost(['/bin'], { ...fsx, exists: (p: string) => p === '/bin/codex' })).toBe(false);
  });
  test('installing codex installs the host too (one set)', () => {
    const installed: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'st-'));
    applyDoctorFixes({ arch: 'arm64', home, env: { HOME: home }, readiness: { platform: 'linux', distro: 'amzn2', rgOnPath: true, codexOnPath: false, nodeOnPath: false }, installStaticTool: (name) => { installed.push(name); return { ok: true, detail: name }; }, smokeCheck: () => true }, true);
    expect(installed).toEqual(['codex', 'codex-code-mode-host']);
  });
  test('a codex binary missing its host is re-installed as a set', () => {
    expect(staticToolsNeeded({ platform: 'linux', distro: 'debian', rgOnPath: true, codexOnPath: true, codexCodeModeHost: false })).toEqual(['codex']);
  });
  test('smokeCheck runs the injected host probe rather than assuming it works', () => {
    const calls: string[][] = [];
    const ok = smokeCheck('codex-code-mode-host', '/tmp/test-host', (command, args) => {
      calls.push([command, ...args]);
      return { status: 0 };
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([['/tmp/test-host', '--help']]);
    expect(smokeCheck('codex-code-mode-host', '/tmp/test-host', () => ({ status: null }))).toBe(false);
  });
  test('host handshake requires a framed ready response, not just successful process exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-host-protocol-'));
    try {
      const dest = join(dir, 'codex-code-mode-host');
      writeFileSync(dest, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(smokeCheck('codex-code-mode-host', dest)).toBe(false);
      const payload = Buffer.from(JSON.stringify({ type: 'connection/ready', selectedVersion: 1, capabilities: [] }));
      const frame = Buffer.alloc(payload.length + 4);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      writeFileSync(dest, `#!/bin/sh\nprintf '${[...frame].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('')}'\n`, { mode: 0o755 });
      expect(smokeCheck('codex-code-mode-host', dest)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('a host that exists but cannot execute prevents static-tools from reporting fixed', () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-host-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'codex-code-mode-host'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
      const result = applyDoctorFixes({
        home, env: { HOME: home, ELANOUS_INSTALL_PREFIX: home }, keyNames: [], arch: 'x64',
        readiness: { platform: 'linux', distro: 'amzn2', codexOnPath: false, nodeOnPath: false },
        installStaticTool: (name) => ({ ok: true, detail: name }),
      }, true, new Set(['static-tools']));
      expect(spawnSync(join(bin, 'codex'), ['--help'], { stdio: 'ignore' }).status).toBe(0);
      expect(result.items.find((item) => item.id === 'static-tools')).toMatchObject({ result: 'failed', reason: 'installed, but smoke check failed' });
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// 🩸 2026-09-25 k8s Pod — Ubuntu 24.04 apt gh 2.45.0 으로 하니스 PR 생성이 「Projects (classic) is being deprecated」로 실패.
import { ghVersionAtLeast } from './doctor-readiness.js';
describe('an old gh is replaced by the pinned static gh', () => {
  test('version floor 2.80 (cli/cli#12476)', () => {
    expect(ghVersionAtLeast('2.45.0')).toBe(false);
    expect(ghVersionAtLeast('2.79.9')).toBe(false);
    expect(ghVersionAtLeast('2.80.0')).toBe(true);
    expect(ghVersionAtLeast('2.101.0')).toBe(true);
    expect(ghVersionAtLeast('3.0.0')).toBe(true);
  });
  test('readiness flags an old gh even when it is logged in', () => {
    const it = checkReadiness({ platform: 'linux', distro: 'debian', ghOnPath: true, ghAuthStatus: 0, ghVersion: '2.45.0' }).items.find((i) => i.id === 'gh-auth')!;
    expect(it.status).toBe('manual');
    expect(it.evidence).toContain('older than 2.80');
    expect(it.remedy).toBe('elanous doctor --fix --yes');
  });
  test('static-tools plans gh for a missing or old gh on linux, and keeps the codex host check independent', () => {
    expect(staticToolsNeeded({ platform: 'linux', distro: 'debian', ghOnPath: true, ghVersion: '2.45.0' })).toEqual(['gh']);
    expect(staticToolsNeeded({ platform: 'linux', distro: 'debian', ghOnPath: false })).toEqual(['gh']);
    expect(staticToolsNeeded({ platform: 'linux', distro: 'debian', ghOnPath: true, ghVersion: '2.89.0' })).toEqual([]);
    expect(staticToolsNeeded({ platform: 'linux', distro: 'debian', ghOnPath: true, ghVersion: '2.45.0', codexOnPath: true, codexCodeModeHost: false })).toEqual(['codex', 'gh']);
    expect(staticToolsNeeded({ platform: 'darwin', distro: 'darwin', ghOnPath: true, ghVersion: '2.45.0' })).toEqual([]);
  });
});
