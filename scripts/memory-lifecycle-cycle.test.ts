import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAllCleanups } from '../src/domains/memory-lifecycle.js';
import { simCli } from '../src/ux-sim/in-process-cli.js';
import { openSurfaceEventsDb, recordEvent } from '../src/domains/surface-events.js';
import { ensureArchiveTable } from '../src/domains/memory-archive.js';

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
  // ★ 안전 경계 — 이 파일의 «모든» 자식 사이클에 일괄 적용(JUD-B #120774/#120781/#120806 · 2026-11-21).
  //   싱크 시험(3건)·반증 사본·3경로 시험 자식까지 전부 — offline 시험만의 경계가 아니다.
  //   (a) 자격 prefix 스크럽 — 실 어댑터가 env 자격(TELEGRAM/OPENAI/ANTHROPIC/AWS/S3)을 보지 못하게.
  for (const key of Object.keys(env)) if (/^(TELEGRAM_|OPENAI_|ANTHROPIC_|AWS_|S3_)/.test(key)) delete env[key];
  //   (b) aws CLI canary 스텁 — 물리적 차단 원문. 실 S3 경로가 구성돼도 aws 호출은 PATH 의 이 스텁에
  //       걸리고 <dir>/canary.log 에 흔적이 남는다(스텁 exit 1 — 호출 자체가 실패).
  const canaryBin = join(dir, 'canary-bin');
  mkdirSync(canaryBin, { recursive: true });
  writeFileSync(join(canaryBin, 'aws'), `#!/bin/sh\necho "aws $*" >> '${join(dir, 'canary.log')}'\nexit 1\n`);
  chmodSync(join(canaryBin, 'aws'), 0o755);
  env.PATH = `${canaryBin}:${env.PATH ?? ''}`;
  //   (c) 오프라인 가짜 어댑터 주입 — 실 S3(aws cli)·임베딩(LLM)·발송 어댑터를 «구성조차 하지 않고»
  //       가짜로 먼저(시뮬 장치 먼저). 가짜 호출 원장은 <dir>/offline/offline-adapter-ledger.json 에.
  //       seam: memory-lifecycle-cycle.ts 의 ELANOUS_CYCLE_OFFLINE — env 미설정 시 현행 동작 그대로(크론 실환경).
  env.ELANOUS_CYCLE_OFFLINE = join(dir, 'offline');
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
    const effect = JSON.parse(r.run.stdout.trim().split('\n').at(-1)!);
    for (const key of ['replayStrengthened', 'decayChanged', 'hot', 'warm', 'cold', 'consolidated', 'archived', 'prunedEvents']) {
      expect(typeof effect[key] === 'number' || effect[key] === null).toBe(true);
    }
    expect(effect.promotionCandidates).toBeNull();
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
// ── 사이클 3경로 (JUD-B #120047 · OP #120052 — MEM-STABILITY-DAYS-CALIBRATION 완료선) ──────
// 지정 시험(이 파일)에서 «실제 사이클 경로» 를 그대로 돌려 승격·강등·보존 3경로를 각각 단언한다.
// 합성 단위시험(calibration.test.ts)이 아니라 사이클 스크립트(자식 프로세스 · 격리 우주) 본체.
// 합성 장치: 같은 격리 우주의 surface_events.db 에 경로별 1행 — 나이 [1, 1, 300]일 · importance 5 · recall 0.
// 경로 판정은 λ 무관(1일은 어떤 stability(≥1)에서도 hot → cold 대기행은 승격, 300일은 hot 밑으로
// 떨어지므로 강등, 1일 hot 유지행은 보존) — 기대값은 사이클 출력이 아니라 장치 설계에서 온 독립 리터럴.
describe('사이클 3경로 — 승격·강등·보존 (합성 장치 · 독립 리터럴)', () => {
  /** 안전 경계 러너 — 장치의 cold 행은 archive→changed→sendOutbound 경로까지 갈 수 있다.
   *  자격 prefix 스크럽·aws canary·오프라인 가짜 어댑터는 isolatedRoot 가 «모든» 자식에 일괄 적용한다
   *  (JUD-B #120774/#120781/#120806). 가짜 원장·canary 원문은 반환값 dir 에서 직접 단언한다. */
  async function runScriptScrubbed(scriptPath: string, prepare?: (dir: string) => void) {
    const { dir, env } = isolatedRoot(prepare);
    const run = spawnSync(process.execPath, [scriptPath], { cwd: ROOT, env, encoding: 'utf8' });
    const query = await simCli(['logs', '--category', 'memory.lifecycle', '--json', '--json-data'],
      { allowPaths: [['logs']], stateRoot: dir, cwd: ROOT, env });
    const rows = query.stdout.split('\n').filter((l) => l.startsWith('{"id"') && l.includes('"event":"cycle"'));
    return { dir, run, query, rows };
  }

  test('실제 사이클 decay 경계 — 승격 1·강등 1·보존 1 을 원장 행·콘솔 원문으로 각각 단언', async () => {
    const DAY = 86_400_000;
    const r = await runScriptScrubbed(SCRIPT, (dir) => {
      // 장치 조립은 같은 격리 우주 안에서 — openSurfaceEventsDb 의 자가치유(migrateLegacyMemoryDb)도
      // HOME/ELANOUS_STATE_DIR 을 dir 로 두고 돌려 실제 홈을 건드리지 않게 한다.
      const prevHome = process.env.HOME;
      const prevState = process.env.ELANOUS_STATE_DIR;
      process.env.HOME = dir;
      process.env.ELANOUS_STATE_DIR = dir;
      let db: ReturnType<typeof openSurfaceEventsDb> | undefined;
      try {
        db = openSurfaceEventsDb();
        const now = Date.now();
        const add = (ageDays: number, text: string) => recordEvent(db!, {
          surface: 'sim', direction: 'inbound', text, importance: 5,
          ts: new Date(now - ageDays * DAY).toISOString(),
        });
        const promote = add(1, 'cycle-path promote — 1일, cold 대기 → hot 승격');
        const demote = add(300, 'cycle-path demote — 300일, hot 대기 → cold 강등');
        const retain = add(1, 'cycle-path retain — 1일, hot 대기 → hot 보존');
        db!.run('UPDATE events SET tier = ? WHERE id = ?', ['cold', promote]);
        db!.run('UPDATE events SET tier = ? WHERE id = ?', ['hot', demote]);
        db!.run('UPDATE events SET tier = ? WHERE id = ?', ['hot', retain]);
      } finally {
        db?.close();
        if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
        if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prevState;
      }
    });
    expect(r.run.status, r.run.stderr).toBe(0);
    expect(r.query.exitCode, r.query.stderr).toBe(0);
    // 장치 가시성 — 사이클이 이 우주에서 실측한 보정(측정 소스 · 표본 3 · 회상 0).
    expect(r.run.stdout).toContain('source=measured');
    expect(r.run.stdout).toContain('표본 3(회상 0)');
    // 원장 경로 ① — memory.lifecycle/decay-effect 행(경계 수치 그대로).
    const decayRows = r.query.stdout.split('\n').filter((l) => l.startsWith('{"id"') && l.includes('"event":"decay-effect"'));
    expect(decayRows.length, `decay-effect 원장 행 수: ${decayRows.length}`).toBe(1);
    // logs --json 행은 payload 를 data 열에 싣는다(--json-data) — 행 최상위가 아니라 data 안에서 찾는다.
    const unwrapRow = (raw: string): Record<string, unknown> => {
      const row = JSON.parse(raw) as Record<string, unknown>;
      const data = row['data'];
      return (data !== null && typeof data === 'object' && !Array.isArray(data) ? data : row) as Record<string, unknown>;
    };
    const decayRow = unwrapRow(decayRows[0]!) as { promoted?: number; demoted?: number; retained?: number };
    expect(decayRow.promoted, `decay-effect 행 원문: ${decayRows[0]}`).toBe(1);   // 승격 경로 — 1일 cold → hot
    expect(decayRow.demoted).toBe(1);    // 강등 경로 — 300일 hot → cold
    expect(decayRow.retained).toBe(1);  // 보존 경로 — 1일 hot → hot
    // 원장 경로 ② — cycle 행이 남긴 decay 경계 결과: 변경 2(승격 1+강등 1) · 잔류 tier hot2/warm0/cold1.
    expect(r.rows.length).toBe(1);
    const cycleRow = unwrapRow(r.rows[0]!) as { decayChanged?: number; hot?: number; warm?: number; cold?: number; archived?: number; errors?: number };
    expect(cycleRow.decayChanged, `cycle 행 원문: ${r.rows[0]}`).toBe(2);  // 승격(cold→hot) 1 + 강등(hot→cold) 1
    expect(cycleRow.hot).toBe(2);    // 승격행 + 보존행이 hot에 남음
    expect(cycleRow.warm).toBe(0);
    expect(cycleRow.cold).toBe(1);   // 강등행이 cold에 남음
    expect(cycleRow.errors).toBe(0);
    expect(cycleRow.archived, `cycle 행 원문: ${r.rows[0]}`).toBe(1);  // 가짜 S3 이관 — 강등기 cold 1행(offline seam)
    // 사람 읽는 콘솔 원문 — 같은 경계 수치.
    expect(r.run.stdout).toContain('[M1 효과 수치] 승격 1 · 강등 1 · 보존 1');
    // ★ 안전 경계 원문(JUD-B #120774/#120781/#120806) — 3경로 «자식» 도 isolatedRoot 경계 안에서 돈다.
    //   (a) 가짜 어댑터 원장 — 강등기 cold 1행 → 가짜 S3 put 1 · changed=archived 1>0 → 가짜 발송 1.
    //       seam 부재(옛 head)면 원장 파일 자체가 없다 → 이 단언이 빨강이다(실패 먼저).
    const ledgerPath = join(r.dir, 'offline', 'offline-adapter-ledger.json');
    expect(existsSync(ledgerPath), `3경로 자식 오프라인 원장 부재 — 실 어댑터 경로 의심. stdout 꼬리: ${r.run.stdout.slice(-300)}`).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      archive: { available: number; put: number; get: number }; outbound: number;
    };
    expect(ledger.archive.available, `가짜 원장 원문: ${JSON.stringify(ledger)}`).toBeGreaterThanOrEqual(1);
    expect(ledger.archive.put, `가짜 원장 원문: ${JSON.stringify(ledger)}`).toBe(1);
    expect(ledger.outbound, `가짜 원장 원문: ${JSON.stringify(ledger)}`).toBe(1);
    //   (b) 물리적 차단 원문 — 실 aws CLI 0호출(canary 흔적 없음) · 자식 콘솔에 실 발송·계정 rotation 부재.
    expect(existsSync(join(r.dir, 'canary.log')), `aws canary 발화 — 실 S3 경로 구성 의심: ${existsSync(join(r.dir, 'canary.log')) ? readFileSync(join(r.dir, 'canary.log'), 'utf8') : ''}`).toBe(false);
    expect(r.run.stdout).not.toContain('[outbound]');
    expect(r.run.stdout).not.toContain('Codex account rotated');
  }, 180_000);
});

// ── 오프라인 가짜 어댑터 주입 (JUD-B #120295 · OP #120302 — #39418 보안 HOLD 이행 · 2026-11-21) ──
// 자식 «실제 사이클» 의 외부 어댑터 3종(S3 archive·임베딩·발송)을 오프라인 가짜로 «먼저» 주입한다.
// env 제거/exit 0 만으로는 차단 증명이 안 된다(OP #120302 판정) — 가짜 호출 원장 + aws CLI canary
// 스텁(물리적 차단 흔적) + 실 사이클 rc 0 + SQLite 원장 단언을 한 세트로 증명한다.
describe('오프라인 가짜 어댑터 주입 — 실 사이클·SQLite 단언 유지, 실제 외부 호출 0', () => {
  test('ELANOUS_CYCLE_OFFLINE: 가짜 이관·발송 원장 1/1, aws canary 미발화, 원장 행 archived=1', async () => {
    const DAY = 86_400_000;
    // 장치는 «사이클 3경로» 시험과 같은 격리 우주·같은 3행(1일 cold 승격기 / 300일 hot 강등기 /
    // 1일 hot 보존기) — decay 경계(승격 1·강등 1·보존 1)가 초록으로 실측된 배치다. 강등기만 cold 로
    // 남으므로 가짜 S3 이관(put)은 «정확히 1», 발송은 archived=1 → changed>0 게이트로 «정확히 1».
    const { dir, env } = isolatedRoot((d) => {
      const prevHome = process.env.HOME;
      const prevState = process.env.ELANOUS_STATE_DIR;
      process.env.HOME = d;
      process.env.ELANOUS_STATE_DIR = d;
      let db: ReturnType<typeof openSurfaceEventsDb> | undefined;
      try {
        db = openSurfaceEventsDb();
        const now = Date.now();
        const add = (ageDays: number, text: string) => recordEvent(db!, {
          surface: 'sim', direction: 'inbound', text, importance: 5,
          ts: new Date(now - ageDays * DAY).toISOString(),
        });
        const promote = add(1, 'offline-path promote — 1일, cold 대기 → hot 승격');
        const demote = add(300, 'offline-path demote — 300일, hot 대기 → cold 강등 → 가짜 S3 이관');
        const retain = add(1, 'offline-path retain — 1일, hot 대기 → hot 보존');
        db!.run('UPDATE events SET tier = ? WHERE id = ?', ['cold', promote]);
        db!.run('UPDATE events SET tier = ? WHERE id = ?', ['hot', demote]);
        db!.run('UPDATE events SET tier = ? WHERE id = ?', ['hot', retain]);
      } finally {
        db?.close();
        if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
        if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prevState;
      }
    });
    for (const key of Object.keys(env)) if (/^(TELEGRAM_|OPENAI_|ANTHROPIC_|AWS_|S3_)/.test(key)) delete env[key];
    // canary — 물리적 차단 원문: 실 S3 경로가 구성돼도 aws CLI 는 PATH 의 이 스텁에 걸리고 흔적이 남는다.
    const canaryBin = join(dir, 'canary-bin'); mkdirSync(canaryBin, { recursive: true });
    const canaryLog = join(dir, 'canary.log');
    writeFileSync(join(canaryBin, 'aws'), `#!/bin/sh\necho "aws $*" >> '${canaryLog}'\nexit 1\n`);
    chmodSync(join(canaryBin, 'aws'), 0o755);
    env.PATH = `${canaryBin}:${env.PATH ?? ''}`;
    // 오프라인 주입(시뮬 장치 먼저) — 자식은 이 dir 에 가짜 어댑터 호출 원장을 남긴다.
    const offlineDir = join(dir, 'offline');
    env.ELANOUS_CYCLE_OFFLINE = offlineDir;
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    // ① 가짜 원장 — seam 이 없으면(현재 head) 원장 파일 자체가 없다 → 이 단언이 빨강이다.
    const ledgerPath = join(offlineDir, 'offline-adapter-ledger.json');
    expect(existsSync(ledgerPath), `오프라인 주입 seam 부재 — 가짜 원장 미작성. stdout 꼬리: ${run.stdout.slice(-200)}`).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      archive: { available: number; put: number; get: number }; embed: number; outbound: number;
    };
    expect(ledger.archive.available, `가짜 원장 원문: ${JSON.stringify(ledger)}`).toBeGreaterThanOrEqual(1);
    expect(ledger.archive.put, `가짜 원장 원문: ${JSON.stringify(ledger)}`).toBe(1);   // 강등기 1행 → 가짜 S3 이관
    expect(ledger.outbound, `가짜 원장 원문: ${JSON.stringify(ledger)}`).toBe(1);      // archived=1 → changed>0 → 가짜 발송 1
    // ② 물리적 차단 원문 — 실 aws CLI 0호출(canary 흔적 없음).
    expect(existsSync(canaryLog), `aws canary 발화(실 S3 경로 구성 의심): ${existsSync(canaryLog) ? readFileSync(canaryLog, 'utf8') : ''}`).toBe(false);
    // ③ 실 사이클·SQLite 원장 — 이관 메타 1 + events 잔류 cold 0.
    const prevHome = process.env.HOME;
    const prevState = process.env.ELANOUS_STATE_DIR;
    process.env.HOME = dir;
    process.env.ELANOUS_STATE_DIR = dir;
    let db: ReturnType<typeof openSurfaceEventsDb> | undefined;
    try {
      db = openSurfaceEventsDb();
      ensureArchiveTable(db);
      const meta = db.prepare('SELECT id FROM events_archive').all() as Array<{ id: string }>;
      expect(meta.length, '이관 메타 행 수').toBe(1);
      const cold = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE tier = 'cold'`).get() as { c: number };
      expect(cold.c, '잔류 cold 이벤트').toBe(0);
    } finally {
      db?.close();
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prevState;
    }
    // ④ 관측 원장(logs.db) — cycle 행이 archived=1 · errors=0 으로 남는다(실 사이클 유지).
    const query = await simCli(['logs', '--category', 'memory.lifecycle', '--json', '--json-data'],
      { allowPaths: [['logs']], stateRoot: dir, cwd: ROOT, env });
    expect(query.exitCode, query.stderr).toBe(0);
    const cycleLines = query.stdout.split('\n').filter((l) => l.startsWith('{"id"') && l.includes('"event":"cycle"'));
    expect(cycleLines.length).toBe(1);
    const unwrap = (raw: string): Record<string, unknown> => {
      const row = JSON.parse(raw) as Record<string, unknown>;
      const data = row['data'];
      return (data !== null && typeof data === 'object' && !Array.isArray(data) ? data : row) as Record<string, unknown>;
    };
    const cycleRow = unwrap(cycleLines[0]!) as { archived?: number; errors?: number };
    expect(cycleRow.archived, `cycle 행 원문: ${cycleLines[0]}`).toBe(1);
    expect(cycleRow.errors).toBe(0);
  }, 180_000);
});
