import { describe, test, expect, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const script = join(import.meta.dir, '..', 'seat-state', 'OP', 'tools', 'traffic-hold.sh');
const root = mkdtempSync(join(import.meta.dir, '..', '.tmp-traffic-hold-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const PAST = fmt(new Date(Date.now() - 3600_000));
const SOON = fmt(new Date(Date.now() + 30 * 60_000));
const FUTURE = fmt(new Date(Date.now() + 6 * 3600_000));

function fixture(hold: string[] = [], meta: object[] = []) {
  const dir = mkdtempSync(join(root, 'case-'));
  const traffic = join(dir, 'traffic.json');
  const metadata = join(dir, 'hold-meta.jsonl');
  const opLog = join(dir, 'op.log');
  const state = join(dir, 'summary-hour.txt');
  const env = { ...process.env, TZ: 'UTC', TRAFFIC_JSON: traffic, HOLD_META_JSONL: metadata,
    OP_LOG: opLog, HOLD_SUMMARY_STATE: state, HOLD_BY: 'mk-test' };
  writeFileSync(traffic, JSON.stringify({ global: 'green', hold, versions: ['0.2.32'] }));
  writeFileSync(metadata, meta.map((row) => JSON.stringify(row)).join('\n') + (meta.length ? '\n' : ''));
  function run(...args: string[]) {
    return spawnSync(script, args, {
      encoding: 'utf8',
      env,
    });
  }
  const held = () => JSON.parse(readFileSync(traffic, 'utf8')).hold as string[];
  return { traffic, metadata, opLog, state, env, run, held };
}

describe('traffic-hold.sh — 문자열 hold와 별도 메타 계약', () => {
  test('add는 사유·미래 만료를 요구하고 문자열 hold와 메타를 기록한다', () => {
    const f = fixture();
    expect(f.run('add', 'CELL-A').status).toBe(12);
    expect(f.run('add', 'CELL-A', '--reason', 'two words', '--until', FUTURE).status).toBe(12);
    expect(f.run('add', 'CELL-A', '--reason', 'demo', '--until', PAST).status).toBe(12);
    expect(f.run('add', 'CELL-A', '--reason', 'demo', '--until', '202602301200').status).toBe(12);
    expect(f.held()).toEqual([]);
    expect(f.run('add', 'CELL-A', '--reason', 'demo', '--until', FUTURE).status).toBe(0);
    expect(f.held()).toEqual(['CELL-A']);
    expect(readFileSync(f.metadata, 'utf8')).toContain('"reason": "demo"');
    expect(f.run('gate', 'CELL-A').status).toBe(10);
  });

  test('gate는 만료만 허용하고 활성·사유 없음·판정 실패를 거부한다', () => {
    const f = fixture(['OLD', 'ACTIVE', 'EXPIRED'], [
      { id: 'ACTIVE', op: 'add', reason: 'infra', until: FUTURE },
      { id: 'EXPIRED', op: 'add', reason: 'demo', until: PAST },
    ]);
    expect(f.run('gate', 'EXPIRED').status).toBe(0);
    expect(f.run('gate', 'ABSENT').status).toBe(0);
    expect(f.run('gate', 'ACTIVE').status).toBe(10);
    expect(f.run('gate', 'OLD').status).toBe(11);
    writeFileSync(f.metadata, JSON.stringify({ id: 'OLD', op: 'add', reason: '   ', until: PAST }) + '\n');
    expect(f.run('gate', 'OLD').status).toBe(11);
    writeFileSync(f.metadata, '{broken json\n');
    expect(f.run('gate', 'EXPIRED').status).toBe(12);
    expect(f.run('gate', 'ABSENT').status).toBe(12);
    rmSync(f.traffic);
    expect(f.run('gate', 'ABSENT').status).toBe(12);
  });

  test('손상된 메타 타입은 만료 시각이 과거여도 발사 금지', () => {
    const f = fixture(['DAMAGED'], [
      { id: 'DAMAGED', op: 'add', reason: 1, until: PAST },
    ]);
    expect(f.run('gate', 'DAMAGED').status).toBe(12);
    expect(f.run('sweep').status).toBe(12);
    expect(f.held()).toEqual(['DAMAGED']);
  });

  test('만료 뒤 재등록 pending 중단은 hold 배열 기록 전후 모두 발사 금지', () => {
    const expired = { id: 'CELL-E', op: 'add', reason: 'old', until: PAST };
    const pending = { id: 'CELL-E', op: 'pending', reason: 'new', until: FUTURE };
    const beforeTrafficWrite = fixture([], [expired, pending]);
    expect(beforeTrafficWrite.run('gate', 'CELL-E').status).toBe(12);
    const afterTrafficWrite = fixture(['CELL-E'], [expired, pending]);
    expect(afterTrafficWrite.run('gate', 'CELL-E').status).toBe(12);
    expect(afterTrafficWrite.run('sweep').status).toBe(12);
    expect(afterTrafficWrite.held()).toEqual(['CELL-E']);
  });

  test('잠금이 잡힌 동안 sweep/add는 판독하지 않고 직렬화되어 새 hold가 남는다', async () => {
    const f = fixture(['EXPIRED'], [{ id: 'EXPIRED', op: 'add', reason: 'old', until: PAST }]);
    const lock = `${f.traffic}.hold.lock`;
    const holder = spawn('python3', ['-c',
      'import fcntl,sys,time; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(0.8)', lock],
    { stdio: ['ignore', 'pipe', 'pipe'], env: f.env });
    await once(holder.stdout!, 'data');
    const sweep = spawn(script, ['sweep'], { env: f.env });
    const add = spawn(script, ['add', 'NEW', '--reason', 'infra', '--until', FUTURE], { env: f.env });
    await Bun.sleep(80);
    expect(sweep.exitCode).toBeNull();
    expect(add.exitCode).toBeNull();
    const [[sweepCode], [addCode]] = await Promise.all([once(sweep, 'exit'), once(add, 'exit')]);
    expect(sweepCode).toBe(0);
    expect(addCode).toBe(0);
    expect(f.held()).toEqual(['NEW']);
    expect(f.run('gate', 'NEW').status).toBe(10);
  });

  test('sweep는 만료만 걷고 사유 없는 옛 hold는 남긴다', () => {
    const f = fixture(['OLD', 'ACTIVE', 'EXPIRED'], [
      { id: 'ACTIVE', op: 'add', reason: 'infra', until: FUTURE },
      { id: 'EXPIRED', op: 'add', reason: 'demo', until: PAST },
    ]);
    const result = f.run('sweep');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('hold 만료 EXPIRED\n');
    expect(f.held()).toEqual(['OLD', 'ACTIVE']);
    writeFileSync(f.metadata, '{broken json\n');
    expect(f.run('sweep').status).toBe(12);
    expect(f.held()).toEqual(['OLD', 'ACTIVE']);
  });

  test('summary는 로그 성공 뒤 완료를 기록하고 실패한 hour는 재시도한다', () => {
    const f = fixture(['OLD', 'SOON', 'ACTIVE', 'EXPIRED'], [
      { id: 'SOON', op: 'add', reason: 'demo', until: SOON },
      { id: 'ACTIVE', op: 'add', reason: 'infra', until: FUTURE },
      { id: 'EXPIRED', op: 'add', reason: 'demo', until: PAST },
    ]);
    // 로그 파일 자리에 디렉터리를 두면 append 실패: 완료 state는 없어야 한다.
    mkdirSync(f.opLog);
    expect(f.run('summary').status).toBe(12);
    expect(() => readFileSync(f.state, 'utf8')).toThrow();
    rmSync(f.opLog, { recursive: true });
    const first = f.run('summary');
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/총4 활성2 만료1 사유없음1 임박1/);
    expect(first.stdout).toMatch(/사유 demo:1,infra:1/);
    expect(readFileSync(f.opLog, 'utf8')).toBe(first.stdout);
    expect(f.run('summary').stdout).toBe('');
    expect(readFileSync(f.opLog, 'utf8')).toBe(first.stdout);
  });
});
