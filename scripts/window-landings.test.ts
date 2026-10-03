import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const SCRIPT = join(process.cwd(), 'scripts/window-landings.sh');
const dirs: string[] = [];

type Scenario = { defaultBranch?: string; defaultBranchExit?: number; rows: string[] };

function makeCommandBin(scenario: Scenario): string {
  const bin = mkdtempSync(join(tmpdir(), 'window-landings-bin-'));
  dirs.push(bin);
  const bun = join(bin, 'bun');
  const rows = scenario.rows.join('\\n');
  const defaultBranch = scenario.defaultBranch ?? '';
  const defaultBranchExit = scenario.defaultBranchExit ?? 0;
  writeFileSync(bun, `#!/usr/bin/env bash
args="$*"
case "$args" in
  *' where') echo '인스턴스: test' ;;
  *'search/issues'*) echo '1' ;;
  *'gh repo view'*) printf '%b\\n' '${defaultBranch}'; exit ${defaultBranchExit} ;;
  *'--json number --jq length'*) echo '3' ;;
  *'--json mergedAt'*) echo '2026-09-05T00:00:00Z' ;;
  *'--json number,mergedAt,headRefName,baseRefName'*) printf '%b\\n' '${rows}' ;;
esac
`);
  chmodSync(bun, 0o755);
  return bin;
}

function run(scenario: Scenario, since = '2026-09-01T00:00:00Z') {
  const bin = makeCommandBin(scenario);
  return spawnSync('bash', [SCRIPT, since], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('scripts/window-landings.sh', () => {
  test('counts and classifies only PRs merged into the query-returned default branch', () => {
    const result = run({
      defaultBranch: 'trunk',
      rows: ['101\\ttrunk\\ts141-feature', '102\\trelease\\tf40-release-fix', '103\\ttrunk\\tself-impl/example'],
    });

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n').slice(0, 3)).toEqual([
      expect.stringContaining('📍 자리:'),
      expect.stringContaining('📍 우주:'),
      expect.stringContaining('📍 시점:'),
    ]);
    expect(result.stdout).toContain('baseRefName = trunk');
    expect(result.stdout).toContain('기본 브랜치(trunk) 아닌 base 병합 1건: #102');
    expect(result.stdout).toContain('s141');
    expect(result.stdout).toContain('하니스 브랜치(주인 미상)');
    expect(result.stdout).not.toContain('f40-release-fix');
    expect(result.stdout).toContain('합 2 = 전체 2   ✅');
    expect(result.stdout).toContain('이 수를 «인용»하지 말고 다음 창에서 다시 치십시오.');
  });

  test('omits the other-base line when every merged PR targets the default branch', () => {
    const result = run({ defaultBranch: 'develop', rows: ['201\\tdevelop\\tt134-fix'] });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('아닌 base 병합');
    expect(result.stdout).toContain('합 1 = 전체 1   ✅');
  });

  test('fails closed when the default branch cannot be queried', () => {
    const result = run({ rows: ['301\\tmain\\ts141-feature'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('기본 브랜치 조회가 실패했다');
  });

  test('fails closed when default-branch output contains only a gh diagnostic', () => {
    const result = run({ defaultBranch: '[gh] authentication failed', rows: ['302\\tmain\\ts141-feature'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('기본 브랜치 조회가 실패했다');
  });

  test('fails closed when the default-branch query exits unsuccessfully', () => {
    const result = run({ defaultBranch: 'main', defaultBranchExit: 1, rows: ['303\\tmain\\ts141-feature'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('기본 브랜치 조회가 실패했다');
  });

  test('preserves the zero-row warning and exit code', () => {
    const result = run({ defaultBranch: 'main', rows: [] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('0행');
    expect(result.stdout).toContain('「0건」으로 읽지 마라');
  });
});
