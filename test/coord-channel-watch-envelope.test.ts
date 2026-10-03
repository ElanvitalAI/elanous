import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

setDefaultTimeout(60_000);
const script = resolve('scripts/coord-channel-watch.sh');
const dirs: string[] = [];
const jqPath = resolve('.elanous-test/scratch/jq');
const bodies = [
  '**[OP]** 12:00 → MK · 요청 · K6 · 기한 12:40\n확인 바랍니다',
  '**[TC]** 12:01 → OP · 보고 · K7\n완료',
  '**[UX]** 12:02 → 전원 · 사고 · K8\n장애',
  '**[TC]** 12:03 → OP — 무엇\n옛 형식',
  '**[MK]** 12:04 → OP · 보고 · K9\n내 글',
];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function availableJq(): string {
  const found = spawnSync('which', ['jq'], { encoding: 'utf8' });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  if (existsSync(jqPath)) return jqPath;
  throw new Error('jq required for coord-channel-watch envelope test');
}

function fixture(dir: string, comments: string[]): void {
  const rows = comments.map((body, index) => ({
    id: 101 + index, created_at: '2099-01-01T00:00:00Z', user: { login: `writer${index}` }, body,
  }));
  writeFileSync(join(dir, 'comments.json'), JSON.stringify(rows));
  writeFileSync(join(dir, 'graphql.json'), JSON.stringify({
    data: { repository: { pullRequest: { comments: { nodes: rows.map(row => ({
      databaseId: row.id, createdAt: row.created_at, author: row.user, body: row.body,
    })) } } } },
  }));
}

async function poll(comments: string[], opts: { skip?: boolean; graphql?: boolean; track?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coord-envelope-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  fixture(dir, comments);
  const jq = join(bin, 'jq');
  writeFileSync(jq, `#!/bin/bash\nexec "${availableJq()}" "$@"\n`, { mode: 0o755 });
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/bash
if [ "$1" != api ]; then exit 2; fi
if [ "$2" = graphql ]; then
  file="$GH_FIXTURE_DIR/graphql.json"
else
  [ "${opts.graphql ? '1' : '0'}" = 0 ] || exit 1
  file="$GH_FIXTURE_DIR/comments.json"
fi
for ((i=1; i<=$#; i++)); do
  if [ "${'$'}{!i}" = --jq ]; then
    j=$((i+1))
    jq -r "${'$'}{!j}" "$file"
    exit $?
  fi
done
exit 2
`, { mode: 0o755 });
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir,
    GH_FIXTURE_DIR: dir, CH_PR: String(910000 + dirs.length), CH_INTERVAL: '0.2',
    CH_WATCH_BODY: '0', CH_HEARTBEAT_EVERY: '0',
  };
  delete env.COORD_WATCH_SKIP_OTHERS_REPORTS;
  if (opts.skip) env.COORD_WATCH_SKIP_OTHERS_REPORTS = '1';
  const proc = Bun.spawn(['bash', script, 'ensure', '--track', opts.track ?? 'MK'], {
    env, stdout: Bun.file(join(dir, 'watch.out')), stderr: Bun.file(join(dir, 'watch.err')),
  });
  const since = join(dir, `ch${env.CH_PR}-${opts.track ?? 'MK'}.since`);
  try {
    for (let i = 0; i < 100 && !existsSync(since); i++) await Bun.sleep(100);
    if (!existsSync(since)) throw new Error(`poll did not complete: ${readFileSync(join(dir, 'watch.err'), 'utf8')} / ${readFileSync(join(dir, 'watch.out'), 'utf8')}`);
  } finally {
    proc.kill('SIGTERM');
  }
  await proc.exited;
  const output = readFileSync(join(dir, 'watch.out'), 'utf8');
  const errors = readFileSync(join(dir, 'watch.err'), 'utf8');
  expect(errors).toBe('');
  const lines = output.split('\n').filter(line => line.includes(' 신규 id='));
  const reports = join(dir, '.elanous', 'coord', `${opts.track === 'T' ? 'MK' : opts.track ?? 'MK'}-reports.jsonl`);
  return { lines, reports: existsSync(reports) ? readFileSync(reports, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}

describe('coord-channel-watch envelope v2', () => {
  test('기본: 네 글을 모두 보이고 봉투 표지만 단다 (자기 글은 제외)', async () => {
    const { lines, reports } = await poll(bodies);
    expect(lines).toHaveLength(4);
    expect(lines.map(line => Number(line.match(/신규 id=(\d+)/)?.[1]))).toEqual([101, 102, 103, 104]);
    expect(lines[0]).toContain('🙋 나에게 «요청»');
    expect(lines[1]).toContain('📄 보고');
    expect(lines[2]).toContain('🚨');
    expect(lines[3]).not.toMatch(/🙋|🚨|📄 보고/);
    expect(reports).toHaveLength(0);
  });

  test('선택: 다른 자리 보고만 보관하고 나머지는 즉시 보인다', async () => {
    const { lines, reports } = await poll(bodies, { skip: true });
    expect(lines.map(line => Number(line.match(/신규 id=(\d+)/)?.[1]))).toEqual([101, 103, 104]);
    expect(lines[0]).toContain('🙋 나에게 «요청»');
    expect(lines[1]).toContain('🚨');
    expect(lines[2]).not.toMatch(/🙋|🚨|📄 보고/);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: 102, body: bodies[1] });
  });

  test('GraphQL 폴백도 같은 봉투 분류와 보관을 쓴다', async () => {
    const { lines, reports } = await poll(bodies, { skip: true, graphql: true });
    expect(lines.map(line => Number(line.match(/신규 id=(\d+)/)?.[1]))).toEqual([101, 103, 104]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: 102 });
  });

  test('봉투 없는 글과 내게 온 보고는 선택 모드에도 즉시 출력한다', async () => {
    const { lines, reports } = await poll([
      '**[OP]** 12:00 → MK · 보고 · K1',
      '**[TC]** 12:01 → OP · 보고\nK2',
      '**[UX]** 12:02 보고 · MK · K3',
      '**[TC]** 12:03 → O · 요청 · K4',
      '**[OP]** 12:04 → 전원 · 요청 · K5 · 기한 13:00',
      '**[TC]** 12:05 → 전원 · 보고 · K6',
      '**[OP]** 12:06 → MK · 요청 · K7\n🅣 께 부탁드립니다',
    ], { skip: true });
    expect(lines).toHaveLength(7);
    expect(lines.slice(0, 4).every(line => !/🙋|🚨|📄 보고/.test(line))).toBe(true);
    expect(lines[4]).toContain('🙋 나에게 «요청»');
    expect(lines[5]).not.toContain('📄 보고');
    expect(lines[6]).toContain('🙋 나에게 «요청»');
    expect(lines[6]).toContain('🙋‼️ 나에게 온 «요청»');
    expect(reports).toHaveLength(0);
  });

  test('여러 받는 이와 옛 alias 및 기존 낱말 요청을 함께 보존한다', async () => {
    const { lines, reports } = await poll([
      '**[OP]** 12:00 → OP · MK · 결정 · K1 · 기한 13:00',
      '**[TC]** 12:01 → T · 보고 · K2',
      '**[UX]** 12:02 → OP · 정정 · K3',
      '**[TC]** 12:03 → OP · 보고 · K4\n🅣 께 부탁드립니다',
      '**[OP]** 12:04 → OP — 기타\n🅣 께 부탁드립니다',
      '**[T]** 12:05 → OP · 요청 · K5',
    ], { skip: true, track: 'T' });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('🙋 나에게 «결정»');
    expect(lines[1]).toContain('보고');
    expect(lines[1]).not.toContain('📄 보고');
    expect(lines[2]).toContain('🚨');
    expect(lines[3]).toContain('🙋‼️ 나에게 온 «요청»');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: 104 });
  });
});
