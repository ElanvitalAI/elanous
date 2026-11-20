import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAllCleanups } from '../src/domains/memory-lifecycle.js';
import { simCli } from '../src/ux-sim/in-process-cli.js';

// 03:00 기억 정리는 cron-run 이 «자식 프로세스»로 띄운다. 래퍼의 logs.db 싱크는 자식에 안 간다 —
// 자식이 스스로 싱크를 달아야 memory.lifecycle/cycle 이 logs.db 에 남는다. 실제 자식 프로세스로 증명한다.
const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(import.meta.dir, 'memory-lifecycle-cycle.ts');
const made: string[] = [];
afterAll(() => { for (const p of made) rmSync(p, { recursive: true, force: true }); });

/** 격리 상태 루트: 임시 HOME·STATE_DIR, 상속된 ELANOUS_* 와 NODE_ENV 는 지운다(실제 DB·발송 경로가 밖으로 새지 않게). */
function isolatedRoot(prepare?: (dir: string) => void): { dir: string; env: Record<string, string | undefined> } {
  const dir = mkdtempSync(join(tmpdir(), 'memlife-iso-'));
  made.push(dir);
  prepare?.(dir);
  const env: Record<string, string | undefined> = { ...process.env, HOME: dir, ELANOUS_STATE_DIR: dir };
  for (const key of Object.keys(env)) if (key.startsWith('ELANOUS_') && key !== 'ELANOUS_STATE_DIR') delete env[key];
  // bun test 는 NODE_ENV=test 를 심고 log-store 는 그 값이면 스토어를 끈다(getDefaultLogStore). 크론 실환경엔 없다.
  delete env.NODE_ENV;
  return { dir, env };
}

async function runScript(scriptPath: string, prepare?: (dir: string) => void) {
  const { dir, env } = isolatedRoot(prepare);
  const run = spawnSync(process.execPath, [scriptPath], { cwd: ROOT, env, encoding: 'utf8' });
  const query = await simCli(['logs', '--category', 'memory.lifecycle', '--json'],
    { allowPaths: [['logs']], stateRoot: dir, cwd: ROOT, env });
  const rows = query.stdout.split('\n').filter((l) => l.startsWith('{"id"') && l.includes('"event":"cycle"'));
  return { run, query, rows };
}

describe('memory-lifecycle-cycle 관측(실제 자식 프로세스)', () => {
  test('싱크 등록이 있으면 logs.db 에 memory.lifecycle/cycle 행이 생기고 조회 CLI 도 성공한다', async () => {
    const r = await runScript(SCRIPT);
    expect(r.run.status, r.run.stderr).toBe(0);
    expect(r.query.exitCode, r.query.stderr).toBe(0);
    expect(r.rows.length).toBe(1);
  }, 180_000);

  test('반증 — 싱크 등록을 뺀 사본은 같은 경로에서 행이 0 이다(자식은 정상 종료·스토어 없음 안내는 조회 실패가 아니다)', async () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const stripped = src.replace(/offSink = registerLogStoreSink\([^;]*;/, '');
    expect(stripped).not.toBe(src); // 제거가 실제로 일어났다
    const copy = join(import.meta.dir, `memory-lifecycle-cycle.nosink-${process.pid}.tmp.ts`);
    writeFileSync(copy, stripped);
    try {
      const r = await runScript(copy);
      expect(r.run.status, r.run.stderr).toBe(0);
      expect(r.rows.length).toBe(0);
      // 조회가 실패해서 0행인 것이 아님을 못박는다: 성공(0)이거나, 스토어 자체가 없다는 CLI 안내(1)여야 한다.
      expect(r.query.exitCode === 0 || /열 수 있는 로그 스토어 없음/.test(r.query.stderr + r.query.stdout)).toBe(true);
    } finally { rmSync(copy, { force: true }); }
  }, 180_000);

  test('싱크 등록이 실패해도(로그 스토어 경로가 파일) 정리는 끝까지 돌고 rc 0 이다', async () => {
    const r = await runScript(SCRIPT, (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'logs'), 'not a directory'); });
    expect(r.run.status, r.run.stderr).toBe(0);
    expect(r.run.stdout).toContain('=== memory-lifecycle 완료 ===');
    expect(r.rows.length).toBe(0);
  }, 180_000);
});

describe('runAllCleanups — 정리 단계는 각각 독립', () => {
  test('앞 단계(DB close)가 던져도 뒤 단계(싱크 해제)는 실행되고 오류가 모인다', () => {
    const ran: string[] = [];
    const errors = runAllCleanups([
      { name: 'close-surface-db', fn: () => { ran.push('a'); throw new Error('close boom'); } },
      { name: 'close-knowledge-db', fn: () => { ran.push('b'); } },
      { name: 'unregister-sink', fn: () => { ran.push('c'); } },
    ]);
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(errors).toEqual([{ stage: 'close-surface-db', error: 'close boom' }]);
  });
  test('전부 성공이면 오류가 없다', () => {
    expect(runAllCleanups([{ name: 'x', fn: () => {} }])).toEqual([]);
  });
});
