import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendClause, clauseCount, clausesPath } from './clauses.js';

// ── 원장 강인성 — OP #117563(JUD HOLD 좁힘 3개 · 2026-11-21) ─────────────────────
// ① 판독 ENOENT 만 «신규 원장» — existsSync 통과 뒤 파일 소실(TOCTAU)도 신규 원장으로 진행
// ② 쓰기 = tmp + rename 원자 교체 — 쓰기 중간 실패(반쪽 기록)에도 기존 원장 바이트 보존
// ③ 읽기-수정-쓰기 직렬화(잠금) — 병렬 프로세스 동시 추가 손실 0
// ①② 판정은 실제 자식 bun-test 프로세스(mock.module 로 node:fs 봉인)에서 — 부모 프로세스 오염 0.

const stateDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'clauses-robustness-')));
const NOW = () => new Date('2026-11-21T00:00:00Z');
const INPUT = { lessonId: 'l1', owner: 'TC', incident: 'i', cause: 'c', remedy: 'r', occurrences: 3 };
const CLAUSES_MODULE = JSON.stringify(join(import.meta.dir, 'clauses.ts'));

function runBun(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.stderr?.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const RUNNER1 = `import { expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
const path = process.env.CLAUSES_LEDGER_PATH!;
const dir = process.env.CLAUSES_STATE_DIR!;
const realExists = realFs.existsSync; // mock.module 은 네임스페이스를 제자리에서 갈아끼운다 — 원본은 봉인 전에 확보
const realRead = realFs.readFileSync;
test('① 판독 ENOENT 만 신규 원장 — existsSync 통과 뒤 소실(TOCTAU)은 신규 원장으로 진행', async () => {
  mock.module('node:fs', () => ({
    ...realFs,
    existsSync: (p: unknown) => (String(p) === path ? true : realExists(String(p))),
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      if (String(p) === path) { const e = new Error('ENOENT: no such file'); (e as { code?: string }).code = 'ENOENT'; throw e; }
      return (realRead as unknown as (p: string, ...rest: unknown[]) => string)(String(p), ...rest);
    },
  } as unknown as typeof realFs));
  const { appendClause } = await import(${CLAUSES_MODULE});
  const r = appendClause(dir, { lessonId: 'l1', owner: 'TC', incident: 'i', cause: 'c', remedy: 'r', occurrences: 3 }, () => new Date(0));
  expect(r.duplicate).toBe(false);
  expect((JSON.parse((realRead as unknown as (p: string, encoding: string) => string)(path, 'utf8')) as { clauses: unknown[] }).clauses).toHaveLength(1);
});
`;

const RUNNER2 = `import { expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { dirname } from 'node:path';
const path = process.env.CLAUSES_LEDGER_PATH!;
const dir = process.env.CLAUSES_STATE_DIR!;
const realWrite = realFs.writeFileSync; // 봉인 전 원본 확보 — 그 외 경로 쓰기는 그대로 통과
test('② 원자 쓰기 — 쓰기 중간 실패(반쪽 기록)에도 기존 원장 바이트 그대로 + 잔여 tmp 0', async () => {
  const before = realFs.readFileSync(path, 'utf8');
  const ledgerDir = dirname(path);
  mock.module('node:fs', () => ({
    ...realFs,
    writeFileSync: (p: unknown, data: unknown, ...rest: unknown[]) => {
      if (!String(p).startsWith(ledgerDir)) return (realWrite as unknown as (p: string, data: string, ...rest: unknown[]) => void)(String(p), String(data), ...rest);
      realFs.appendFileSync(String(p), String(data).slice(0, 40)); // 디스크가 기록 중간에 끊긴 꼴 — 반쪽 기록 후 실패
      const e = new Error('ENOSPC: no space left'); (e as { code?: string }).code = 'ENOSPC'; throw e;
    },
  } as unknown as typeof realFs));
  const { appendClause } = await import(${CLAUSES_MODULE});
  expect(() => appendClause(dir, { lessonId: 'l2', owner: 'TC', incident: 'i', cause: 'c', remedy: 'r', occurrences: 3 }, () => new Date(0))).toThrow();
  expect(realFs.readFileSync(path, 'utf8')).toBe(before); // 기존 바이트 그대로 — 덮어쓰기 없음
  expect(realFs.readdirSync(ledgerDir).filter((name) => name.startsWith('clauses.json.tmp-'))).toEqual([]);
});
`;

const RUNNER3 = `const { appendClause } = await import(${CLAUSES_MODULE});
const dir = process.argv[2];
const tag = process.argv[3];
for (let i = 0; i < 30; i += 1) {
  appendClause(dir, { lessonId: tag + '-' + i, owner: 'TC', incident: 'i', cause: 'c', remedy: 'r', occurrences: i }, () => new Date(0));
}
console.log(JSON.stringify({ tag, done: true }));
`;

describe('원장 강인성 — 판독 ENOENT · 원자 쓰기 · 직렬화 (OP #117563)', () => {
  test('① 판독 ENOENT 만 신규 원장 — existsSync 통과 뒤 소실(TOCTAU)은 신규 원장으로 진행(크래시 아님)', async () => {
    const dir = stateDir();
    try {
      const path = clausesPath(dir);
      const runner = join(dir, 'runner-1-enoent.test.ts');
      writeFileSync(runner, RUNNER1);
      const r = await runBun(['test', runner], { CLAUSES_LEDGER_PATH: path, CLAUSES_STATE_DIR: dir });
      // 현재 코드: 판독 ENOENT 가 그대로 전파돼 러너 실패(exit 1) → 빨강
      expect(r.code, `① 러너: ${r.out.slice(-600)} / ${r.err.slice(-600)}`).toBe(0);
      expect(clauseCount(dir)).toBe(1);
      expect((JSON.parse(readFileSync(path, 'utf8')) as { clauses: unknown[] }).clauses).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('② 원자 쓰기 — 쓰기 중간 실패(반쪽 기록)에도 기존 원장 바이트 그대로 + 잔여 tmp 0', async () => {
    const dir = stateDir();
    try {
      const path = clausesPath(dir);
      expect(appendClause(dir, INPUT, NOW).duplicate).toBe(false); // 원장 1조항 시딩(실 fs)
      const before = readFileSync(path, 'utf8');
      expect(clauseCount(dir)).toBe(1);
      const runner = join(dir, 'runner-2-torn.test.ts');
      writeFileSync(runner, RUNNER2);
      const r = await runBun(['test', runner], { CLAUSES_LEDGER_PATH: path, CLAUSES_STATE_DIR: dir });
      // 현재 코드: 원장 경로에 직접 기록 → 반쪽이 섞여 러너 실패(exit 1) → 빨강
      expect(r.code, `② 러너: ${r.out.slice(-600)} / ${r.err.slice(-600)}`).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(clauseCount(dir)).toBe(1);
      expect(readdirSync(dirname(path)).filter((name) => name.startsWith('clauses.json.tmp-'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('③ 직렬화 — 두 프로세스가 같은 원장에 30조항씩 병렬 추가 → 60조항 손실 0', async () => {
    const dir = stateDir();
    try {
      const runner = join(dir, 'runner-3-race.ts');
      writeFileSync(runner, RUNNER3);
      const a = runBun([runner, dir, 'A']);
      const b = runBun([runner, dir, 'B']);
      const [ra, rb] = await Promise.all([a, b]);
      // 현재 코드: 동시 쓰기가 서로를 덮어쓰거나 파손해 유실/크래시(exit≠0) → 빨강
      expect(ra.code, `③ 러너 A: ${ra.out.slice(-300)} / ${ra.err.slice(-300)}`).toBe(0);
      expect(rb.code, `③ 러너 B: ${rb.out.slice(-300)} / ${rb.err.slice(-300)}`).toBe(0);
      expect((JSON.parse(ra.out) as { tag?: string }).tag).toBe('A');
      expect((JSON.parse(rb.out) as { tag?: string }).tag).toBe('B');
      expect(clauseCount(dir)).toBe(60);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── 잠금 = mkdir 원자 디렉터리 + owner.json — OP #118502(6라운드 · 자동 회수 전폐 · 2026-11-21) ──
// 획득 = 잠금 디렉터리 mkdir(원자 · 이미 있으면 EEXIST = 남이 잠금 중) → 그 안에 owner.json(pid·시각)
// 기록. 해제 = owner.json 의 pid 가 자기 pid 인지 확인한 뒤에만 rmdir. 남의 잠금(죽은 pid·빈 클레임
// 포함)은 절대 회수하지 않는다 — rename·덮어쓰기 0(JUD HOLD #118510: 회수 판정과 rename 사이 교체
// 경합 제거)으로 활성 쓰기 상호배제가 구조적으로 보장된다. 남은 잠금은 대기 상한 뒤 «잠금 남음
// (pid·시각) — 수동 회수 필요» 오류로 멈춘다. 비정상 종료 뒤 회수는 수동 — FU-39383-LOCK-CRASH-RECOVERY.

const deadPidOf = (): number => {
  const pid = spawnSync('true').pid;
  if (!pid || pid <= 0) throw new Error('죽은 자식 pid 확보 실패(spawnSync true)');
  return pid;
};

/** 잠금 디렉터리 시딩 — ownerless 면 owner.json 없이(빈 클레임). ageMs>0 이면 디렉터리·owner 모두 늙게. */
const lockSeed = (path: string, pid: number, opts: { ownerless?: boolean; ageMs?: number } = {}): string => {
  const lockDir = `${path}.lockdir`;
  mkdirSync(lockDir);
  const past = new Date(Date.now() - (opts.ageMs ?? 0));
  if (!opts.ownerless) {
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({ pid, createdAtMs: past.getTime() })}\n`);
    utimesSync(join(lockDir, 'owner.json'), past, past);
  }
  utimesSync(lockDir, past, past);
  return lockDir;
};

const RUNNER5 = `const { appendClause } = await import(${CLAUSES_MODULE});
const dir = process.argv[2];
const tag = process.argv[3];
for (let i = 0; i < 50; i += 1) {
  appendClause(dir, { lessonId: tag + '-' + i, owner: 'TC', incident: 'i', cause: 'c', remedy: 'r', occurrences: i }, () => new Date(0));
}
console.log(JSON.stringify({ tag, done: true }));
`;

describe('잠금 = mkdir 원자 디렉터리 + owner.json — 자동 회수 전폐 · 남은 잠금 = 명확한 오류 (OP #118502 · 6라운드)', () => {
  test('① 남은 잠금(죽은 소유자) — 회수·묘비 0 · 잠금 바이트 보존 · 원장 무변경 · 수동 회수 오류', () => {
    const dir = stateDir();
    const prevTimeout = process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS;
    try {
      const path = clausesPath(dir);
      appendClause(dir, INPUT, NOW); // 원장 시딩 1조항
      const lockDir = lockSeed(path, deadPidOf(), { ageMs: 31_000 }); // 죽은 소유자 · 31s 노후(구 나이 상한 30s 초과)
      const ownerBefore = readFileSync(join(lockDir, 'owner.json'), 'utf8');
      // 대기 상한 단축(400ms · 출처: 본 시험 전용 — 제품 기본 LOCK_TIMEOUT_MS_DEFAULT 10s 그대로)
      process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS = '400';
      let thrown: unknown;
      try { appendClause(dir, { ...INPUT, lessonId: 'l-dead-held' }, NOW); }
      catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      const message = String((thrown as Error).message);
      expect(message).toContain('잠금 남음');
      expect(message).toContain('수동 회수 필요');
      expect(message).toContain(lockDir); // 수동 회수 대상 경로 안내
      expect(message).toMatch(/pid=\d+, 시각=/); // pid·시각 동봉
      expect(existsSync(lockDir)).toBe(true); // 회수(제거) 0
      expect(readFileSync(join(lockDir, 'owner.json'), 'utf8')).toBe(ownerBefore); // 바이트 보존
      expect(readdirSync(dirname(path)).some((name) => name.includes('.tomb-'))).toBe(false); // 묘비 0
      expect(clauseCount(dir)).toBe(1); // 원장 무변경
    } finally {
      if (prevTimeout === undefined) delete process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS;
      else process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS = prevTimeout;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('② 빈 클레임(owner 없음 · 나이 무관) — 유예 회수 없이 같은 오류로 멈춤', () => {
    const dir = stateDir();
    const prevTimeout = process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS;
    try {
      const path = clausesPath(dir);
      appendClause(dir, INPUT, NOW);
      const lockDir = lockSeed(path, 0, { ownerless: true }); // 빈 클레임 — 소유자가 owner.json 을 쓰는 중일 수 있다
      utimesSync(lockDir, new Date(Date.now() - 6_000), new Date(Date.now() - 6_000)); // 구 유예(5s)를 넘은 나이 — 나이·유예로 회수하지 않는다
      // 대기 상한 단축(400ms · 출처: 본 시험 전용 — 제품 기본 LOCK_TIMEOUT_MS_DEFAULT 10s 그대로)
      process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS = '400';
      expect(() => appendClause(dir, { ...INPUT, lessonId: 'l-ownerless-held' }, NOW)).toThrow('잠금 남음');
      expect(existsSync(lockDir)).toBe(true);
      expect(readdirSync(dirname(path)).some((name) => name.includes('.tomb-'))).toBe(false);
      expect(clauseCount(dir)).toBe(1);
    } finally {
      if (prevTimeout === undefined) delete process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS;
      else process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS = prevTimeout;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('③ 산 소유자 잠금 — 절대 회수 0 · owner.json 바이트 보존 · 같은 오류', () => {
    const dir = stateDir();
    const prevTimeout = process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS;
    try {
      const path = clausesPath(dir);
      appendClause(dir, INPUT, NOW);
      const lockDir = lockSeed(path, process.pid, { ageMs: 40_000 }); // 산 소유자(자기 자신) · 40s 노후
      const ownerBefore = readFileSync(join(lockDir, 'owner.json'), 'utf8');
      // 대기 상한 단축(400ms · 출처: 본 시험 전용 — 제품 기본 LOCK_TIMEOUT_MS_DEFAULT 10s 그대로)
      process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS = '400';
      expect(() => appendClause(dir, { ...INPUT, lessonId: 'l-live-held' }, NOW)).toThrow('잠금 남음');
      expect(existsSync(lockDir)).toBe(true);
      expect(readFileSync(join(lockDir, 'owner.json'), 'utf8')).toBe(ownerBefore); // 회수·조작 없음
      expect(readdirSync(dirname(path)).some((name) => name.includes('.tomb-'))).toBe(false);
      expect(clauseCount(dir)).toBe(1);
    } finally {
      if (prevTimeout === undefined) delete process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS;
      else process.env.KNOWHOW_CLAUSES_LOCK_TIMEOUT_MS = prevTimeout;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('④ 동시 append 2프로세스 × 50라운드 — 유실 0 · 끝난 뒤 남은 잠금 0 · 묘비 0', async () => {
    const dir = stateDir();
    try {
      const path = clausesPath(dir);
      appendClause(dir, INPUT, NOW); // 시딩 1조항
      const runner = join(dir, 'runner-6-race.ts');
      writeFileSync(runner, RUNNER5);
      const a = runBun([runner, dir, 'A']);
      const b = runBun([runner, dir, 'B']);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.code, `④ 러너 A: ${ra.out.slice(-300)} / ${ra.err.slice(-300)}`).toBe(0);
      expect(rb.code, `④ 러너 B: ${rb.out.slice(-300)} / ${rb.err.slice(-300)}`).toBe(0);
      const clauses = JSON.parse(readFileSync(clausesPath(dir), 'utf8')).clauses as Array<{ lessonId: string }>;
      expect(clauses.length, '④ 원장 조항 수(시드 1 + 100)').toBe(101);
      const missing: string[] = [];
      for (const t of ['A', 'B']) for (let i = 0; i < 50; i += 1) {
        if (!clauses.some((c) => c.lessonId === `${t}-${i}`)) missing.push(`${t}-${i}`);
      }
      expect(missing, '④ 동시 추가에서 유실된 조항(상호배제 위반의 흔적)').toEqual([]);
      expect(existsSync(`${path}.lockdir`), '④ 두 러너의 해제(rmdir) 뒤 남은 잠금').toBe(false);
      expect(readdirSync(dirname(path)).some((name) => name.includes('.tomb-'))).toBe(false); // 회수 잔해 0
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
