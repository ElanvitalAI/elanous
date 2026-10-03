import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function runWindowLandings(defaultBranch: string | null, rows: string[]) {
  const sandbox = await mkdtemp(join(tmpdir(), 'window-landings-'));
  sandboxes.push(sandbox);
  const bun = join(sandbox, 'bun');
  const repoResponse = defaultBranch === null ? 'exit 1' : `printf '%s\\n' '${defaultBranch}'`;
  await writeFile(bun, `#!/usr/bin/env bash
case "$*" in
  *' where'*) printf '인스턴스: test\\n' ;;
  *'search/issues'*) printf '3\\n' ;;
  *'gh repo view'*) ${repoResponse} ;;
  *'--json number --jq length'*) printf '3\\n' ;;
  *'--json mergedAt --jq'*) printf '2026-09-06T12:00:00Z\\n' ;;
  *'--json number,mergedAt,headRefName,baseRefName'*) printf '%s\\n' '${rows.join('\n')}' ;;
  *) exit 2 ;;
esac
`);
  await chmod(bun, 0o755);
  return Bun.spawnSync(['bash', 'scripts/window-landings.sh', '2026-09-06T13:40:00Z'], {
    cwd: import.meta.dir + '/..',
    env: { ...process.env, PATH: `${sandbox}:${process.env.PATH}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('counts and classifies only PRs merged into the query-returned default base', async () => {
  const result = await runWindowLandings('trunk', [
    '101\ttrunk\ts141-feature',
    '102\trelease\tf40-fix',
    '103\ttrunk\tself-impl/ownerless',
  ]);
  const output = result.stdout.toString();

  expect(result.exitCode).toBe(0);
  expect(output).toStartWith('📍 자리:');
  expect(output).toContain('baseRefName = trunk');
  expect(output).toContain('기본 브랜치(trunk) 아닌 base 병합 1건: #102');
  expect(output).toContain('s141');
  expect(output).not.toContain('f40');
  expect(output).toContain('하니스 브랜치(주인 미상)');
  expect(output).toContain('합 2 = 전체 2   ✅');
  expect(output).toEndWith('⚠️  이 수를 «인용»하지 말고 다음 창에서 다시 치십시오.\n');
});

test('omits the other-base line when every merged PR targets the default base', async () => {
  const result = await runWindowLandings('stable', ['201\tstable\tf40-fix']);
  const output = result.stdout.toString();

  expect(result.exitCode).toBe(0);
  expect(output).not.toContain('아닌 base 병합');
  expect(output).toContain('합 1 = 전체 1   ✅');
});

test('fails closed when the query cannot return the repository default branch', async () => {
  const result = await runWindowLandings(null, ['201\tstable\tf40-fix']);

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('기본 브랜치 조회가 실패했다');
});
