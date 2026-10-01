import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const cli = join(repo, 'bin/elanous.mjs');

function version(cwd: string): string {
  const result = spawnSync('bun', [cli, '--version'], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

// ⛔⭐ 이 파일은 「산출 «모양»」만 문다 — ***어느 트리의 리비전인가***는 여기 있지 않다.
//   📍 그 계약의 정본 = test/cli-version-revision.test.ts (#9325 · 2026-08-15)
//      ***설치된 도구 트리***의 HEAD 를 쓰고, 호출자 cwd 로 «절대» 폴백하지 않는다.
//      (못 재면 'unknown' — 그 칸도 그 파일 3번째 시험이 문다)
//   🪞 2026-08-26 정정: 여기 있던 두 번째 시험이 그 «반대»(cwd 에 git 이 없으면 unknown)를
//      물고 있었다. 두 시험이 같은 함수에 «정반대»를 요구했고, 늙은 쪽은 이쪽이다.
//      ⛔ 되살리지 마라 — B-1 관문은 「지금 도는 코드가 무엇인가」를 물으므로
//      cwd 를 따르면 pilot 바이너리가 «남의 트리» sha 를 자신 있게 말한다.
test('version reports the package version and current checkout revision', () => {
  const output = version(repo);
  const packageVersion = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  expect(head.status, head.stderr).toBe(0);
  expect(output).toBe(`${packageVersion} ${head.stdout.trim()}`);
});
