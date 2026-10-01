// R6 — npm 설치 입구 `bin/elanous.cjs`: Bun 이 있으면 `bin/elanous.mjs` 로 넘기고, 없으면 안내한다(`--version` 은 스스로 답한다).
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SHIM = join(ROOT, 'bin', 'elanous.cjs');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; bin: Record<string, string> };

/** A real Node.js only — some images (the Linux gate pod) ship `node` as a symlink to Bun, where «no Bun» cannot be staged. */
function findNode(): string | null {
  const r = spawnSync('which', ['node'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const path = r.stdout.trim();
  const probe = spawnSync(path, ['-e', 'process.stdout.write(typeof Bun)'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout === 'undefined' ? path : null;
}
const node = findNode();

/** Bun 이 «없는» 환경: PATH 에 node 폴더만 · HOME·BUN_INSTALL 을 빈 임시 폴더로 · ELANOUS_BUN 없음. */
function noBunEnv(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'r6-nobun-'));
  return { PATH: dirname(node!), HOME: home, BUN_INSTALL: join(home, '.bun'), CI: '1' };
}

describe.skipIf(!node)('bin/elanous.cjs (npm entry)', () => {
  test('package.json bin 은 elanous·eln 모두 Node 입구를 가리킨다', () => {
    expect(pkg.bin).toEqual({ elanous: './bin/elanous.cjs', eln: './bin/elanous.cjs' });
  });

  test('Bun 이 없어도 --version 은 package.json 판을 낸다', () => {
    const env = noBunEnv();
    expect(spawnSync('bun', ['--version'], { env, encoding: 'utf8' }).error).toBeTruthy(); // 전제: 이 PATH 에 bun 이 없다
    const r = spawnSync(node!, [SHIM, '--version'], { env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.startsWith(`${pkg.version} `)).toBe(true);
  });

  test('Bun 이 없으면 다른 명령은 설치 안내와 함께 실패한다(묻지 않는다 · 비대화)', () => {
    const r = spawnSync(node!, [SHIM, 'where'], { env: noBunEnv(), encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bun.sh/install');
    expect(r.stderr).not.toContain('[y/N]');
  });

  test('Bun 이 있으면 bin/elanous.mjs 로 인자·종료 코드를 그대로 넘긴다', () => {
    const env = { ...noBunEnv(), ELANOUS_BUN: process.execPath };
    const r = spawnSync(node!, [SHIM, '--version'], { env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.startsWith(`${pkg.version} `)).toBe(true);
    const bad = spawnSync(node!, [SHIM, 'no-such-command-r6'], { env, encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
  }, 60_000);

  test('부모에 온 SIGTERM 은 자식(Bun)에게 넘어가 둘 다 끝난다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r6-sig-'));
    const marker = join(dir, 'got-term');
    const fakeBun = join(dir, 'bun');
    writeFileSync(fakeBun, `#!/bin/sh\ntrap 'echo term > "${marker}"; exit 143' TERM\necho ready\nwhile :; do sleep 0.1; done\n`);
    chmodSync(fakeBun, 0o755);
    const child = spawn(node!, [SHIM, 'anything'], { env: { ...noBunEnv(), ELANOUS_BUN: fakeBun } });
    await new Promise<void>((ok) => child.stdout!.on('data', (d) => { if (String(d).includes('ready')) ok(); }));
    const exited = new Promise<number | null>((ok) => child.on('exit', (code, signal) => ok(code ?? (signal ? 128 : null))));
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise<null>((ok) => setTimeout(() => ok(null), 5000))]);
    expect(code).not.toBeNull();
    expect(existsSync(marker)).toBe(true);
  }, 15_000);
});
