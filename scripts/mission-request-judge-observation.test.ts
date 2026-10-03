import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const wrapper = join(import.meta.dir, 'cron-run.ts');
const judge = join(import.meta.dir, 'mission-request-judge.ts');
const cli = join(repo, 'bin/elanous.mjs');

async function invoke(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { ...process.env, NODE_ENV: 'production', ELANOUS_CONFIG_DIR: join(cwd, '.elanous-test'), ELANOUS_STATE_DIR: join(cwd, '.elanous-test') },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test('spawned cron judge persists decisions in the isolated logs.db after exit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mission-fabric-judge-'));
  try {
    await mkdir(join(cwd, 'docs/mission-requests'), { recursive: true });
    await writeFile(join(cwd, 'docs/mission-requests', 'invalid.md'), 'request without frontmatter\n');
    const fired = await invoke(cwd, [wrapper, judge, '--root', cwd]);
    expect(fired.code, fired.stderr).toBe(0);
    expect(fired.stdout).toContain('📏 훑은 요청 1건');
    expect(fired.stderr).not.toContain('registerStandaloneLogSink(scheduler) failed');
    const tick = await invoke(cwd, [wrapper, judge, '--root', cwd, '--tick']);
    expect(tick.code, tick.stderr).toBe(0);
    expect(tick.stdout).toContain('invalid.md ⇒');
    expect((await stat(join(cwd, '.elanous-test/logs/logs.db'))).size).toBeGreaterThan(0);

    const queried = await invoke(cwd, [cli, `--test=${join(cwd, '.elanous-test')}`, 'logs', '--test', '--category', 'mission-fabric.judge', '--json', '--json-data', '--limit', '20']);
    expect(queried.code, queried.stderr).toBe(0);
    const rows = queried.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { event?: string; data?: Record<string, unknown> });
    expect(rows.filter(row => row.event === 'requests-judged'), queried.stdout).toHaveLength(2);
    expect(rows.some(row => row.event === 'requests-judged' && row.data?.requestsScanned === 1
      && row.data?.candidateCount === 0 && row.data?.invalidCount === 1 && row.data?.catalogStatus === 'present')).toBe(true);
    expect(rows.some(row => row.event === 'request-decision' && row.data?.file === 'invalid.md'
      && row.data?.status === 'invalid-request' && Array.isArray(row.data?.reasons))).toBe(true);
    expect(rows.some(row => row.event === 'skipped' && row.data?.reason === 'tick-not-requested')).toBe(true);
    expect(rows.some(row => row.event === 'cycle-decision' && row.data?.action === 'ignored'
      && row.data?.requestId === 'invalid.md' && row.data?.reason === '프론트매터 없음')).toBe(true);
    const count = rows.filter(row => row.event && row.data).length;
    expect(count).toBeGreaterThanOrEqual(1);
    console.log(`mission-fabric.judge persisted rows: ${count}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
