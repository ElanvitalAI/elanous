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
  const argv = process.argv.slice(2);
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
  });
  let errTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    try { process.stderr.write(chunk); } catch { /* */ }
    errTail = (errTail + chunk.toString()).slice(-2000); // 바운디드
  });

  const finish = (code: number | null): void => {
    const exit = code ?? 0;
    try {
      const durationMs = Date.now() - start;
      const status: 'ok' | 'error' = exit === 0 ? 'ok' : 'error';
      const record = {
        status, exit, durationMs, via: 'crontab' as const,
        error: exit === 0 ? null : errTail.trim().split('\n').slice(-3).join('\n') || `exit ${exit}`,
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
  child.on('close', finish);
  child.on('error', (e) => { process.stderr.write(`cron-run spawn error: ${e.message}\n`); finish(1); });
}

void main().catch(() => process.exit(0));
