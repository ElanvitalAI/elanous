#!/usr/bin/env bun
// ── 크론 관측성 래퍼 (RFC-scheduler-execution-observability-memory·2026-07-15) ────────────────
//
// crontab 이 실제 스크립트를 이 래퍼로 감싸 실행하면, 그 파이어를 3계층(logs.db·레지스트리·자기기억)에
// 기록한다. 사용:  bun scripts/cron-run.ts [--schedule-id <id>] <target-script> [target-args...]
//                 bun scripts/cron-run.ts [--schedule-id <id>] --shell <interpreter> <target> [args...]
//   예) cd <repo> && bun scripts/cron-run.ts scripts/community-buzz-cycle.ts --collect-only >> /tmp/x.log 2>&1
//
// ★ fail-open 불변식: 관측(sink 등록·레지스트리·기억) 무엇이 실패해도 자식은 반드시 실행하고 자식의
//   exit code 를 보존한다. 관측이 실제 잡을 절대 깨지 않는다. 자식 stdout/stderr 는 그대로 흘려(2>&1
//   /tmp 로그 보존) 실패 시 stderr tail 만 캡처해 관측에 싣는다.

import { spawn } from 'node:child_process';
import { ensureCronNodePath } from '../src/domains/cron-path.js';

ensureCronNodePath();

async function main(): Promise<void> {
  const { argv, maxRuntimeMs } = extractMaxRuntimeArgs(process.argv.slice(2)); // 래퍼 옵션은 대상 앞에서만 소비한다.
  const hasScheduleId = argv[0] === '--schedule-id';
  const scheduleId = hasScheduleId ? argv.splice(0, 2)[1] : undefined;
  if (hasScheduleId && (!scheduleId?.trim() || scheduleId === '--shell')) {
    process.stderr.write('cron-run: --schedule-id 인자 필수\n');
    process.exit(2);
  }
  const shell = argv[0] === '--shell';
  const interpreter = shell ? argv[1] : process.execPath;
  const target = argv[shell ? 2 : 0];
  if (!interpreter || !target) { process.stderr.write('cron-run: target script 인자 필수\n'); process.exit(2); }
  const targetArgs = argv.slice(shell ? 3 : 1);

  // 관측 준비(fail-open) — logs.db sink 등록 + 레지스트리 행 해석.
  let name = target;
  let db: import('bun:sqlite').Database | null = null;
  let id: string | undefined;
  let prevStatus: string | null = null;
  let prerequisiteError: unknown;
  let prerequisiteFailed = false;
  let scheduleRowMissing = false;
  let activeScheduleRowsAmbiguous = false;
  try {
    const [sMod, dMod, cMod, rMod] = await Promise.all([
      import('../src/mss/logging/log-store.js'),
      import('../src/debug/log.js'),
      import('../src/user-config.js'),
      import('../src/domains/schedule-registry.js'),
    ]);
    const lc = cMod.getUserConfig().logs;
    sMod.setLogInstanceName(lc.instanceName);
    const off = sMod.registerLogStoreSink((s) => dMod.debug.registerSink(s), 'scheduler', lc.retention);
    if (off) process.on('exit', off);
    // 셸 대상은 해석기와 함께 넘겨 레지스트리 파생 이름(`bash /x/backup.sh` → backup)과 맞춘다.
    name = rMod.scriptName(shell ? `${interpreter} ${target}` : target);
    db = rMod.openSchedulesDb();
    // 최신 crontab 인벤토리 반영(래핑된 라인도 unwrap-aware 로 동일 id 승계).
    try { rMod.inventoryCrontab(db); } catch { /* fail-soft */ }
    if (scheduleId) {
      // 명시된 id만 조회한다. 해당 행이 없더라도 이름으로 폴백해 다른 잡을 갱신하지 않는다.
      const row = db.query('SELECT id, last_status FROM schedule_registry WHERE id = ?').get(scheduleId) as
        | { id: string; last_status: string | null }
        | undefined;
      if (row) {
        id = row.id;
        prevStatus = row.last_status ?? null;
      } else scheduleRowMissing = true;
    } else {
      const rows = rMod.listSchedules(db).filter((r) => r.name === name);
      const activeRows = rows.filter((r) => r.enabled);
      const selectedRow = activeRows[0] ?? rows[0];
      if (selectedRow) {
        id = selectedRow.id;
        prevStatus = selectedRow.last_status ?? null;
        activeScheduleRowsAmbiguous = activeRows.length > 1;
      } else scheduleRowMissing = true;
    }
  } catch (error) {
    prerequisiteFailed = true;
    prerequisiteError = error; // fail-open — 관측 없이도 자식은 실행
  }

  const start = Date.now();
  // 기본 자식은 이 래퍼와 같은 bun 으로 실행(cron PATH 무관·process.execPath).
  // --shell 자식은 지정한 interpreter 로 실행한다. stdout 은 흘리고(2>&1 보존), stderr 는 tee(흘리며 tail 캡처).
  // ⛔⭐ env 를 «명시»한다 — bun 은 자식에게 「기동 시 스냅샷」을 주므로 ensureCronNodePath() 가
  //   런타임에 세운 PATH 가 «안 간다»(node 와 갈리고, 실패가 조용하다).
  //   📏 2026-08-31 실측(알려진 양성 /ZZZ_SENTINEL): env 미지정 ⇒ ⛔ 안 흐름 · env 명시 ⇒ ✅ 흐름.
  //   🔑 크론은 PATH= 선언이 «없어» cron 기본 PATH(pyenv·bun «없음»)로 도는데, 그것을 메우려고
  //     ensureCronNodePath() 가 있다 — 그 수리가 자식에게 안 가면 python 스킬 shell-out 이
  //     `exit 1` 로 «조용히» 죽는다(cron-path.ts 주석의 그 사고).
  const child = spawn(interpreter, [target, ...targetArgs], {
    stdio: ['ignore', 'inherit', 'pipe'],
    env: { ...process.env },
    // ⓐ detached — 자식이 프로세스 그룹 리더가 된다. 상한 초과 kill 은 그룹 전체
    // (자식의 자식까지)를 죽린다: process.kill(-pid).
    detached: true,
  });
  let errTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    try { process.stderr.write(chunk); } catch { /* */ }
    errTail = (errTail + chunk.toString()).slice(-2000); // 바운디드
  });

  // ⓐ 상한 타이머 — 넘으면 자식 프로세스 그룹 전체를 SIGKILL 하고 관측 플래그를 올린다.
  // 진단(stderr 한 줄)은 여기서, 관측 기록은 기존 finish() 경로가 그대로 맡는다(fail-open 불변).
  // ⚠ 리더가 이미 종료했다고 조기 반환하지 않는다(리뷰 must-fix): 리더만 죽고 손자가 stderr
  //   파이프를 쥔 채 남으면 close 가 영영 안 와 관측도 반환도 없다. 이 경로에서도 그룹(트리)
  //   종료를 시도하고, close 가 오지 않으면 finish 를 직접 불러 관측·반환을 마무리한다.
  let overrun = false;
  let finished = false;
  let forwardedExit: number | null = null;
  let signalKillTimer: ReturnType<typeof setTimeout> | null = null;
  const timer: ReturnType<typeof setTimeout> | null = maxRuntimeMs > 0
    ? setTimeout(() => {
        if (child.pid === undefined || finished) return;
        overrun = true;
        const leaderGone = child.exitCode !== null || child.signalCode !== null;
        try { process.stderr.write(`cron-run overrun: ${maxRuntimeMs}ms 상한 초과 — 자식 트리(pid ${child.pid}) 종료${leaderGone ? ' — 리더 이미 종료, 파이프를 쥔 손자 정리' : ''}\n`); } catch { /* */ }
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } }
        // 그룹 밖(setsid) 잔존자가 파이프를 계속 쥐면 close 가 오지 않는다 — 관측까지 여기서
        // 마무리한다. close 가 정상적으로 오면 finish 의 멱등 가드가 이 호출을 흡수한다.
        setTimeout(() => finish(child.exitCode), OVERRUN_CLOSE_GRACE_MS);
      }, maxRuntimeMs)
    : null;

  const finish = (code: number | null): void => {
    if (finished) return; // 멱등 — close·error·상한 유예 경로가 겹쳐도 관측·반환은 1회
    finished = true;
    // 신호를 받은 뒤 리더가 먼저 닫혀도, SIGTERM을 무시하고 stdio를 닫은 손자가
    // 그룹에 남을 수 있다. close가 온 시점에도 그룹 전체를 마지막으로 거둔다.
    if (forwardedExit !== null && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 그룹 이미 종료 */ }
    }
    if (timer !== null) clearTimeout(timer);
    if (signalKillTimer !== null) clearTimeout(signalKillTimer);
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
    const exit = overrun ? 124 : forwardedExit ?? code ?? 0;
    try {
      const durationMs = Date.now() - start;
      const status: 'ok' | 'error' = exit === 0 ? 'ok' : 'error';
      const overrunNote = overrun
        ? `cron-run overrun: killed ${target} (pid ${child.pid ?? '?'}) after ${durationMs}ms — cap ${maxRuntimeMs}ms`
        : null;
      const record = {
        status, exit, durationMs, via: 'crontab' as const,
        error: overrunNote
          ? [overrunNote, ...errTail.trim().split('\n').slice(-3).filter(Boolean)].join('\n')
          : exit === 0 ? null : errTail.trim().split('\n').slice(-3).join('\n') || `exit ${exit}`,
      };
      const options = { ...(db ? { db } : {}), ...(id ? { id } : {}), prevStatus };
      const diagnostic = (kind: 'prerequisite' | 'registry record skipped' | 'registry selection ambiguous' | 'import' | 'record', error: unknown): Promise<void> => {
        const message = String((error as Error)?.message ?? error).replace(/\s+/g, ' ').trim();
        const suffix = kind === 'registry record skipped' || kind === 'registry selection ambiguous' ? ':' : ' failed:';
        const detail = message ? ` ${message}` : '';
        return new Promise((resolve) => {
          try {
            process.stderr.write(`cron-run observation ${kind}${suffix}${detail}\n`, () => resolve());
          } catch {
            resolve();
          }
        });
      };
      const observabilityModule = process.env.CRON_RUN_OBSERVABILITY_MODULE
        ?? '../src/domains/schedule-observability.js';
      const prerequisiteDiagnostic = prerequisiteFailed
        ? diagnostic('prerequisite', prerequisiteError)
        : scheduleRowMissing
          ? diagnostic('registry record skipped', `schedule row not found for ${name}`)
          : activeScheduleRowsAmbiguous
            ? diagnostic('registry selection ambiguous', `multiple enabled schedule rows for ${name}; recording ${id}`)
            : Promise.resolve();
      void prerequisiteDiagnostic.then(() => import(observabilityModule))
        .then((o) => {
          try {
            return Promise.resolve(o.recordScheduledExecution(name, record, options))
              .catch((error) => diagnostic('record', error));
          } catch (error) {
            return diagnostic('record', error);
          }
        })
        .catch((error) => diagnostic('import', error))
        .finally(() => { try { db?.close(); } catch { /* */ } process.exit(exit); });
    } catch {
      try { db?.close(); } catch { /* */ }
      process.exit(exit);
    }
  };
  const forwardSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (finished || forwardedExit !== null) return;
    forwardedExit = signal === 'SIGINT' ? 130 : 143;
    if (child.pid === undefined) { finish(forwardedExit); return; }
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* 이미 종료 */ } }
    signalKillTimer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } }
      finish(forwardedExit);
    }, OVERRUN_CLOSE_GRACE_MS);
  };
  const onSigInt = (): void => forwardSignal('SIGINT');
  const onSigTerm = (): void => forwardSignal('SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
  child.on('close', finish);
  child.on('error', (e) => { process.stderr.write(`cron-run spawn error: ${e.message}\n`); finish(1); });
}

const MAX_TIMER_MS = 2_147_483_647;
void main().catch(() => process.exit(0));

// ⓐ LOGS-RETENTION-46MIN: 실행 시간 상한 — 상한 없이 살아남은 옛 판 크론이 6시간마다
// «오래된 행 50%» 삭제를 겹쳐 돌려 보존 창을 무너뜨린 사고(10-12)의 재발 방지.
// 우선순위: --max-runtime-ms > CRON_RUN_MAX_RUNTIME_MS > 기본 30분. 0 이하는 상한 끔.
//
// 래퍼 플래그는 대상 앞에서만 읽는다. 대상 뒤의 같은 이름은 자식 인자다.
// ⚠ main() 안쪽이 아니라 여기(helper)에 두는 이유: main() 머리에 줄을 늘리면 위쪽
//   registerLogStoreSink 호출의 줄번호가 움직여 log-store-retention-callers.test.ts
//   가 git 색인과 대비하는 검사를 깬다(부메랑).
function extractMaxRuntimeArgs(argv: string[]): { argv: string[]; maxRuntimeMs: number } {
  const args = [...argv];
  if (args[0] === '--schedule-id') args.splice(0, 2);
  if (args[0] === '--max-runtime-ms') {
    const raw = args[1];
    const parsed = Number(raw);
    if (!raw || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_TIMER_MS) {
      process.stderr.write(`cron-run: --max-runtime-ms 인자는 0~${MAX_TIMER_MS} 사이의 정수여야 합니다\n`);
      process.exit(2);
    }
    const flagIndex = argv.indexOf('--max-runtime-ms');
    return { argv: argv.filter((_, index) => index !== flagIndex && index !== flagIndex + 1), maxRuntimeMs: parsed };
  }
  const rawEnv = process.env.CRON_RUN_MAX_RUNTIME_MS;
  const fromEnv = Number(rawEnv);
  if (rawEnv?.trim() && fromEnv > MAX_TIMER_MS) {
    process.stderr.write(`cron-run: CRON_RUN_MAX_RUNTIME_MS 인자는 0~${MAX_TIMER_MS} 사이의 정수여야 합니다\n`);
    process.exit(2);
  }
  return { argv, maxRuntimeMs: rawEnv?.trim() && Number.isSafeInteger(fromEnv) && fromEnv >= 0 && fromEnv <= MAX_TIMER_MS ? fromEnv : 30 * 60_000 };
}

// ⓐ 상한 시점의 그룹 종료 뒤에도 close 가 오지 않는 경로(파이프를 쥔 그룹 밖 손자)에서
// 관측(finish)을 마무리할 때까지 기다리는 유예.
const OVERRUN_CLOSE_GRACE_MS = 2_000;
