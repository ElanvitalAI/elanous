import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { fakeMembersHost, packReleaseTarball, RELEASE_ENTRY, runHostScript, writeReleaseEntry, type MembersHost } from './members-host-fixture.js';

// MEMBERS-DEPLOY-PATH: 가짜 회원 호스트 루트에서만 돈다 — systemctl·curl·bun 은 PATH 의 가짜이고,
// gcloud/ssh/docker 는 불리면 실패하는 가짜로 막는다(실제 회원 서버·클라우드·IAP 호출 0).
const script = resolve(import.meta.dir, 'members-deploy.sh');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Host = MembersHost;
const fakeHost = () => fakeMembersHost(roots);
const run = (host: Host, args: string[]) => runHostScript(script, host, args);
/** Log lines carry utc= between result and the extra fields: members-deploy step=X result=Y utc=… extra. */
const stepLine = (step: string, result: string, extra = '') =>
  new RegExp(`members-deploy step=${step} result=${result} utc=\\S+${extra ? ` ${extra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : ''}`);

function baseArgs(host: Host, release: string[] = ['--release-dir', host.newRelease]) {
  return [...release, '--state-root', host.state, '--dropin', host.dropin, '--old-release', host.oldRelease,
    '--health-url', 'http://127.0.0.1:31415/v1/members/home', '--txn-root', host.txnRoot,
    '--health-attempts', '2', '--health-interval', '0', '--min-free-mb', '1'];
}

function restarts(host: Host) {
  return existsSync(host.systemctlCalls) ? readFileSync(host.systemctlCalls, 'utf8').match(/--user restart/g)?.length ?? 0 : 0;
}

describe('members deploy orchestrator', () => {
  test('dry-run prints the plan and changes nothing', () => {
    const host = fakeHost();
    const before = readFileSync(host.dropin, 'utf8');
    const { status, output } = run(host, [...baseArgs(host), '--dry-run', '--pre-hook', 'touch should-not-run']);

    expect(status).toBe(0);
    expect(output).toContain('dry-run');
    expect(output).toContain('members-release-switch.sh switch');
    expect(output).toContain('health: http://127.0.0.1:31415/v1/members/home = 401');
    expect(readFileSync(host.dropin, 'utf8')).toBe(before);
    expect(existsSync(host.systemctlCalls)).toBe(false);
    expect(existsSync(host.curlCalls)).toBe(false);
    expect(existsSync(host.txnRoot)).toBe(false);
  });

  test('happy path stages the tarball, switches, sees health and verifies apps twice', () => {
    const host = fakeHost();
    const src = join(host.root, 'src', 'elanous-81200b1b');
    mkdirSync(join(src, 'bin'), { recursive: true });
    writeReleaseEntry(src, '// candidate\n');
    writeFileSync(join(src, 'package.json'), '{}\n');
    const tarball = join(host.root, 'member-81200b1b.tar.gz');
    expect(packReleaseTarball(join(host.root, 'src'), 'elanous-81200b1b', tarball)).toBe(0);

    const { status, output } = run(host, [...baseArgs(host, ['--release-tarball', tarball]), '--releases-root', host.home,
      '--smoke-slot', 'kaist-demo-slot', '--smoke-url', 'http://127.0.0.1:31415/apps/{slot}/', '--smoke-expect', '200,302']);

    expect(status).toBe(0);
    const staged = readdirSync(host.home).find((name) => name === 'elanous-members-member-81200b1b');
    expect(staged).toBeDefined();
    const stagedPath = join(host.home, staged!);
    expect(readFileSync(join(stagedPath, RELEASE_ENTRY), 'utf8')).toContain('candidate');
    expect(readFileSync(join(host.root, 'bun.calls'), 'utf8')).toContain('install --frozen-lockfile skip=1');
    expect(output).toMatch(stepLine('stage', 'ok'));
    expect(output).toMatch(stepLine('switch', 'ok'));
    expect(output).toMatch(stepLine('health', 'ok', 'code=401'));
    expect(output).toMatch(stepLine('smoke', 'ok', 'slot=kaist-demo-slot code=200'));
    expect(output).toMatch(stepLine('verify-late', 'ok'));
    expect(output).toContain('deploy=ok');
    // verify 두 번: switch 안의 사후 확인 ⊕ health 뒤 늦은 소실 확인.
    expect(output.match(/✅ apps 보존/g)?.length).toBe(2);
    expect(readFileSync(host.dropin, 'utf8')).toContain('elanous-members-member-81200b1b');
    expect(readFileSync(host.curlCalls, 'utf8')).toContain('/apps/kaist-demo-slot/');
    expect(restarts(host)).toBe(1);
    expect(output).not.toContain('must not run');
  });

  test('health that never answers as expected rolls back through the switch script', () => {
    const host = fakeHost();
    writeFileSync(join(host.root, 'health.code'), '503');
    const { status, output } = run(host, baseArgs(host));

    expect(status).toBe(4);
    expect(output).toMatch(stepLine('health', 'fail', 'last=503 attempts=2'));
    expect(output).toContain('되돌림(health 503≠401)');
    expect(output).toMatch(stepLine('rollback', 'ok'));
    expect(output).toContain('deploy=rolled-back');
    expect(output).not.toContain('deploy=ok release=');
    const dropin = readFileSync(host.dropin, 'utf8');
    expect(dropin).toContain(host.oldRelease);
    expect(dropin).not.toContain(host.newRelease);
    expect(restarts(host)).toBe(2);
    expect(readFileSync(join(host.slot, 'app.yaml'), 'utf8')).toContain('kaist-demo-slot');
  });

  test('refuses a release dir inside the state root before touching the unit', () => {
    const host = fakeHost();
    const inside = join(host.state, 'release');
    mkdirSync(join(inside, 'bin'), { recursive: true });
    writeReleaseEntry(inside);
    const { status, output } = run(host, baseArgs(host, ['--release-dir', inside]));

    expect(status).toBe(1);
    expect(output).toContain('새 릴리스 경로가 상태 루트 안에 있다');
    expect(existsSync(host.systemctlCalls)).toBe(false);
    expect(readFileSync(host.dropin, 'utf8')).toContain(host.oldRelease);
  });

  test('Claude r1 MF: a smoke failure after the slot vanished restores the slot before the old release restarts', () => {
    const host = fakeHost();
    writeFileSync(join(host.root, 'vanish-on-health'), '');
    const { status, output } = run(host, [...baseArgs(host), '--smoke-slot', 'kaist-demo-slot',
      '--smoke-url', 'http://127.0.0.1:31415/apps/{slot}/', '--smoke-expect', '200']);

    expect(status).toBe(6);
    expect(output).toMatch(stepLine('rollback', 'ok', 'why='));
    expect(output).toContain('restore=ok');
    expect(readFileSync(join(host.slot, 'app.yaml'), 'utf8')).toContain('kaist-demo-slot');
    expect(readFileSync(host.dropin, 'utf8')).toContain(host.oldRelease);
    const calls = readFileSync(host.systemctlCalls, 'utf8').trim().split('\n');
    expect(calls).toContain('--user stop elanous-nexus.service');
    expect(calls.filter((line) => line.startsWith('slot-at-restart=')).at(-1)).toBe('slot-at-restart=present');
  });

  test('a slot that vanishes after health fails the second verify', () => {
    const host = fakeHost();
    writeFileSync(join(host.root, 'vanish-on-health'), '');
    const { status, output } = run(host, baseArgs(host));

    expect(status).toBe(7);
    expect(output).toMatch(stepLine('health', 'ok'));
    expect(output).toContain('⛔ slot 이 사라졌다: kaist-demo-slot');
    expect(output).toMatch(stepLine('verify-late', 'fail'));
    expect(output).toContain('deploy=apps-lost-after-health');
    expect(output).not.toContain('deploy=ok release=');
    // 사람이 복원할 slot 사본이 거래 폴더에 남는다.
    const runs = readdirSync(host.txnRoot);
    expect(runs.length).toBe(1);
    expect(existsSync(join(host.txnRoot, runs[0]!, 'switch', 'slots', 'kaist-demo-slot', 'app.yaml'))).toBe(true);
  });
});
