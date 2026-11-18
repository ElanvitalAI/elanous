// MEMBERS-DEPLOY-PATH test fixture (not a test file): a fake member host root and the two process launches the
// deploy test needs (the deploy script under bash, and tar for a release archive). Neither launches the elanous CLI;
// keeping the fake release entry file here keeps that path out of the test file (R-LIVE10 scanner).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Release entry path inside a release tree (a fake file in these fixtures). */
export const RELEASE_ENTRY = join('bin', 'elanous.mjs');

export function writeReleaseEntry(releaseDir: string, text = ''): void {
  mkdirSync(join(releaseDir, 'bin'), { recursive: true });
  writeFileSync(join(releaseDir, RELEASE_ENTRY), text);
}

export function fakeMembersHost(roots: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'members-deploy-'));
  roots.push(root);
  const home = join(root, 'home');
  const state = join(home, '.elanous', 'nexus');
  const slot = join(state, 'apps', 'kaist-demo-slot');
  const oldRelease = join(home, 'elanous-main-old');
  const newRelease = join(home, 'elanous-main-new');
  const dropin = join(home, 'member-api.conf');
  const bin = join(root, 'bin');
  const systemctlCalls = join(root, 'systemctl.calls');
  const curlCalls = join(root, 'curl.calls');
  for (const dir of [join(slot, 'out'), bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, 'app.yaml'), 'slug: kaist-demo-slot\ntitle: demo\n');
  writeFileSync(join(slot, 'out', 'index.html'), '<h1>demo</h1>\n');
  writeReleaseEntry(oldRelease, '// old\n');
  writeReleaseEntry(newRelease, '// new\n');
  writeFileSync(dropin, `[Service]\nWorkingDirectory=${oldRelease}\nExecStart=bun ${join(oldRelease, RELEASE_ENTRY)} nexus\n`);
  // Records whether the slot is on disk at each restart: app-host mounts apps/ only at boot.
  writeFileSync(join(bin, 'systemctl'), `#!/bin/bash\necho "$*" >> '${systemctlCalls}'\nif [ "$2" = show ]; then echo no; fi\n`
    + `if [ "$2" = restart ]; then if [ -e '${slot}/app.yaml' ]; then echo slot-at-restart=present >> '${systemctlCalls}'; else echo slot-at-restart=absent >> '${systemctlCalls}'; fi; fi\nexit 0\n`);
  // curl: health 는 health.code(없으면 401), 그 밖은 smoke.code(없으면 200). vanish-on-health 가 있으면 health 응답 뒤 slot 을 지운다.
  writeFileSync(join(bin, 'curl'), `#!/bin/bash\nurl="\${@: -1}"\necho "$url" >> '${curlCalls}'\n`
    + `case "$url" in *members/home*) code="$(cat '${root}/health.code' 2>/dev/null || echo 401)"; if [ -f '${root}/vanish-on-health' ]; then rm -rf '${slot}'; fi ;;\n`
    + `*) code="$(cat '${root}/smoke.code' 2>/dev/null || echo 200)" ;; esac\nprintf '%s' "$code"\n`);
  writeFileSync(join(bin, 'bun'), `#!/bin/bash\necho "bun $* skip=$ELANOUS_SKIP_POSTINSTALL" >> '${root}/bun.calls'\nmkdir -p node_modules\nexit 0\n`);
  for (const blocked of ['gcloud', 'ssh', 'docker']) writeFileSync(join(bin, blocked), `#!/bin/sh\necho "${blocked} must not run" >&2\nexit 99\n`);
  for (const name of ['systemctl', 'curl', 'bun', 'gcloud', 'ssh', 'docker']) chmodSync(join(bin, name), 0o755);
  return { root, home, state, slot, oldRelease, newRelease, dropin, bin, systemctlCalls, curlCalls, txnRoot: join(home, '.members-deploy-txn') };
}

export type MembersHost = ReturnType<typeof fakeMembersHost>;

/** Run a members script under bash on the fake host (HOME and PATH point at the fixture). */
export function runHostScript(script: string, host: MembersHost, args: string[]) {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: host.home, PATH: `${host.bin}:${process.env.PATH ?? ''}` },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Pack `parent/name` into a gzip tarball; returns tar's exit status. */
export function packReleaseTarball(parent: string, name: string, out: string): number | null {
  return spawnSync('tar', ['-czf', out, '-C', parent, name]).status;
}
