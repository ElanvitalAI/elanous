import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

// MEMBERS-DEPLOY-PRESERVE-APPS: 가짜 서버 루트에서만 돈다 — systemctl 은 PATH 의 가짜이고,
// gcloud/ssh 는 불리면 실패하는 가짜로 막는다(실제 회원 서버·클라우드 호출 0).
const script = resolve(import.meta.dir, 'members-release-switch.sh');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeServer(restartScript = '') {
  const root = mkdtempSync(join(tmpdir(), 'members-switch-'));
  roots.push(root);
  const home = join(root, 'home');
  const state = join(home, '.elanous', 'nexus');
  const slot = join(state, 'apps', 'kaist-demo-slot');
  const oldRelease = join(home, 'elanous-main-old');
  const newRelease = join(home, 'elanous-main-new');
  const dropin = join(home, 'member-api.conf');
  const bin = join(root, 'bin');
  const calls = join(root, 'systemctl.calls');
  for (const dir of [slot, join(slot, 'out'), join(oldRelease, 'bin'), join(newRelease, 'bin'), bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, 'app.yaml'), 'slug: kaist-demo-slot\ntitle: demo\n');
  writeFileSync(join(slot, 'out', 'index.html'), '<h1>demo</h1>\n');
  writeFileSync(join(state, 'apps', 'kaist-demo-slot.db'), 'db-bytes-not-copied');
  writeFileSync(join(oldRelease, 'bin', 'elanous.mjs'), '');
  writeFileSync(join(newRelease, 'bin', 'elanous.mjs'), '');
  writeFileSync(dropin, `[Service]\nWorkingDirectory=${oldRelease}\nExecStart=bun ${oldRelease}/bin/elanous.mjs nexus\n`);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/bash\necho "$*" >> '${calls}'\nif [ "$2" = restart ]; then\n${restartScript || ':'}\nfi\nexit 0\n`);
  for (const blocked of ['gcloud', 'ssh', 'docker']) writeFileSync(join(bin, blocked), `#!/bin/sh\necho "${blocked} must not run" >&2\nexit 99\n`);
  for (const name of ['systemctl', 'gcloud', 'ssh', 'docker']) chmodSync(join(bin, name), 0o755);
  return { root, home, state, slot, oldRelease, newRelease, dropin, bin, calls, txn: join(home, 'deploy-txn') };
}

function run(server: ReturnType<typeof fakeServer>, args: string[]) {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: server.home, PATH: `${server.bin}:${process.env.PATH ?? ''}` },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function switchArgs(server: ReturnType<typeof fakeServer>, overrides: { newRelease?: string; txn?: string } = {}) {
  return ['switch', '--state-root', server.state, '--txn', overrides.txn ?? server.txn,
    '--old-release', server.oldRelease, '--new-release', overrides.newRelease ?? server.newRelease, '--dropin', server.dropin];
}

describe('members release switch preserves operating apps', () => {
  test('switches the release and keeps the mounted demo slot', () => {
    const server = fakeServer();
    const { status, output } = run(server, switchArgs(server));

    expect(status).toBe(0);
    expect(output).toContain('deploy=ok');
    expect(output).toContain('✅ apps 보존');
    expect(readFileSync(join(server.slot, 'app.yaml'), 'utf8')).toContain('kaist-demo-slot');
    expect(readFileSync(join(server.slot, 'out', 'index.html'), 'utf8')).toContain('demo');
    expect(readFileSync(server.dropin, 'utf8')).toContain(server.newRelease);
    expect(readFileSync(server.dropin, 'utf8')).not.toContain(server.oldRelease);
    expect(readFileSync(server.calls, 'utf8')).toContain('--user restart elanous-nexus.service');
    // 회원/앱 DB 는 거래 사본에 들어가지 않는다 — slot 디렉터리만 담는다.
    expect(existsSync(join(server.txn, 'slots', 'kaist-demo-slot', 'app.yaml'))).toBe(true);
    expect(existsSync(join(server.txn, 'slots', 'kaist-demo-slot.db'))).toBe(false);
  });

  test('a wipe during restart trips the guard, rolls back the unit and restores the slot', () => {
    // 21:45:52 사건 재현: 재기동 무렵 apps 아래 slot 디렉터리만 사라지고 .db 는 남는다.
    const server = fakeServer();
    // The fake records whether the slot is on disk at each restart: app-host mounts apps/ only at boot.
    writeFileSync(join(server.bin, 'systemctl'), `#!/bin/bash\necho "$*" >> '${server.calls}'\n`
      + `if [ "$2" = restart ]; then if [ -e '${server.slot}/app.yaml' ]; then echo slot-at-restart=present >> '${server.calls}'; else echo slot-at-restart=absent >> '${server.calls}'; fi; fi\n`
      + `if [ "$2" = restart ] && [ ! -e '${server.root}/wiped' ]; then rm -rf '${server.slot}'; touch '${server.root}/wiped'; fi\nexit 0\n`);
    const { status, output } = run(server, switchArgs(server));

    expect(status).toBe(3);
    expect(output).toContain('⛔ slot 이 사라졌다: kaist-demo-slot');
    expect(output).toContain('⛔ 마운트 대상 slot 이 1 → 0 으로 줄었다');
    expect(output).toContain('운영 앱 보존 가드가 막았다');
    expect(output).toContain('deploy=rolled-back apps=restored');
    expect(output).not.toContain('deploy=ok');
    expect(readFileSync(server.dropin, 'utf8')).toContain(server.oldRelease);
    expect(readFileSync(join(server.slot, 'out', 'index.html'), 'utf8')).toContain('demo');
    const calls = readFileSync(server.calls, 'utf8');
    expect(calls.match(/--user restart/g)?.length).toBe(2);
    // Claude r1 MF: the rollback stops first, restores the slot, and only then restarts the old release.
    expect(calls).toContain('--user stop elanous-nexus.service');
    expect(calls.indexOf('--user stop')).toBeLessThan(calls.lastIndexOf('--user restart'));
    expect(calls.trim().split('\n').filter((line) => line.startsWith('slot-at-restart=')).at(-1)).toBe('slot-at-restart=present');
  });

  test('verify alone fails loudly when the apps directory itself is gone', () => {
    const server = fakeServer();
    expect(run(server, ['snapshot', '--state-root', server.state, '--txn', server.txn]).status).toBe(0);
    rmSync(join(server.state, 'apps'), { recursive: true, force: true });
    const { status, output } = run(server, ['verify', '--state-root', server.state, '--txn', server.txn]);

    expect(status).toBe(3);
    expect(output).toContain('⛔ apps 폴더가 사라졌다');
  });

  test('refuses a release tree that overlaps the operating state root before touching the unit', () => {
    const server = fakeServer();
    const inside = join(server.state, 'release');
    mkdirSync(join(inside, 'bin'), { recursive: true });
    writeFileSync(join(inside, 'bin', 'elanous.mjs'), '');
    const { status, output } = run(server, switchArgs(server, { newRelease: inside }));

    expect(status).not.toBe(0);
    expect(output).toContain('새 릴리스 경로가 상태 루트 안에 있다');
    expect(existsSync(server.calls)).toBe(false);
    expect(readFileSync(server.dropin, 'utf8')).toContain(server.oldRelease);
  });

  test('refuses a release tree that contains the state root', () => {
    const server = fakeServer();
    const { status, output } = run(server, switchArgs(server, { newRelease: server.home }));

    expect(status).not.toBe(0);
    expect(output).toContain('새 릴리스 경로가 상태 루트를 품는다');
    expect(existsSync(server.calls)).toBe(false);
  });
});
