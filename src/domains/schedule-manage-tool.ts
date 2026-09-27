// ── schedule_manage 공유 도구 (2026-07-07) — 전 표면 상속 ─────────────────
//
// 대표 지시: 스케줄/크론 CRUD를 텔레그램뿐 아니라 elanous 채팅(CLI)·PWA·iPad 등
// 전 표면에서. 이 모듈이 spec + dispatch의 단일 출처 — finance 팩(telegram)·
// 데몬 toolSurface(PWA/ACP)·CLI(buildCliAgentTools)가 동일하게 배선.
//
// schedule_manage는 crontab을 변경(mutating)하므로 쓰기는 자동 백업 + cd/bun/로그
// 가드. 실행 엔진 신설 아님(레거시 스케줄러 은퇴 교훈).
// 상세 = 내부 문서 `PLAN-scheduler-registry-2026-07-07`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMToolSpec } from '../llm.js';
import {
  openSchedulesDb, inventoryCrontab, inventoryInternalSchedules, listSchedules, readCrontab,
  buildCronLine, addLineToCrontab, removeLineFromCrontab, setLineEnabled, applyCrontab, setRunVia, setScheduleMission,
  deleteScheduleRow, setNote, parseCronLine, scriptName, wrapCronLine, wrapShellCronLine, unwrapCronLine, sharesCrontabLine, reindexCrontabEntry, repoRoot,
  type ScheduleRow,
} from './schedule-registry.js';
import { surfaceEventsDbPath, openSurfaceEventsDb, recallEvents } from './surface-events.js';

export const SCHEDULE_MANAGE_SPEC: LLMToolSpec = {
  name: 'schedule_manage',
  description: "⭐ 스케줄/크론 관리 — elanous가 **자기 예약 작업(크론)을 인지·CRUD**. 시스템 crontab의 모든 잡을 조회/생성/수정/삭제하는 단일 창구(사람이 crontab을 직접 편집하지 않게 elanous로 일반화·전 표면 공용). **'무슨 크론/스케줄 도나' '내가 뭘 예약해뒀지' '이 모니터 몇시에 도나' '이 알림 시간 바꿔줘' '이 잡 꺼줘/켜줘' '새 스케줄 추가'** 류 질문·지시에 사용. action: list(전체·category 필터)·inspect(id 상세+최근발송)·create(cron+command 신규)·update(cron 시간 변경)·enable/disable(주석 토글)·delete·adopt(elanous 데몬 실행 이관)·release(crontab 복원). **안전**: 쓰기는 자동 백업(~/.elanous/backups)·elanous .ts는 cd repo+로그 강제. category=ingest|monitor|report|alert|digest|maintenance(도메인 무관). 파괴적(delete/update/adopt)은 신중. (스케줄러=prospective memory·memory_recall과 더블트랙.)",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'list(기본)|inspect|create|update|enable|disable|delete|migrate(fabric Schedule Trigger 로 이관·elanous 데몬 발화)|adopt(=migrate 별칭·schedule-runner 은퇴로 통합)|release(crontab 실행으로 복원)|note(사람용 설명 저장).' },
      id: { type: 'string', description: 'inspect/update/enable/disable/delete/adopt/release/note 대상 잡 id(list에서 확인).' },
      category: { type: 'string', description: 'list 필터(선택) — ingest|monitor|report|alert|digest|maintenance.' },
      cron: { type: 'string', description: 'create/update용 cron 식(예: "0 7 * * *"·"*/10 9-15 * * 1-5").' },
      command: { type: 'string', description: 'create용 커맨드(예: "scripts/foo.ts --x" — cd/bun/로그 자동보강).' },
      note: { type: 'string', description: 'note 액션용 — 이게 무슨 스케줄인지 사람용 설명(툴팁으로 노출·저장).' },
    },
    required: [],
  },
};

/** schedule_manage 실행 — 전 표면 공용. 인지=schedule_registry, 실행=crontab/데몬 러너. */
/** 스케줄 cron 변경을 그 잡을 만든 미션(autopilot_id)의 materializeSpec.cron 으로 역전파.
 *  스펙↔크론 불일치 방지(2026-07-12: 봇이 크론만 바꿔 미션 스펙이 옛 cron 으로 남던 갭).
 *  dynamic import 로 autopilot 순환 회피. 미션 없거나 실패 시 조용히 skip(발화엔 crontab 이 SoT). */
async function syncMissionCron(autopilotId: string | null | undefined, cron: string): Promise<string | undefined> {
  const id = autopilotId?.trim();
  if (!id) return undefined;
  try {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { getMission, setMissionSpec } = await import('../autopilot/mission-registry.js');
    const store = new TaskStore();
    try {
      const m = getMission(store, id);
      if (!m) return undefined;
      let spec: { command?: string; cron?: string; prompt?: string } = {};
      try { spec = m.materialize_spec ? JSON.parse(m.materialize_spec) : {}; } catch { /* 손상 무시 */ }
      if (spec.cron === cron) return undefined; // 이미 일치
      setMissionSpec(store, id, { ...spec, cron });
      return id;
    } finally { store.close(); }
  } catch { return undefined; }
}

export const compactSchedule = (r: ScheduleRow) => {
  const command = r.command ?? '';
  const commandTruncated = command.length > 120;
  const lastError = r.last_error ?? null;
  const lastErrorTruncated = (lastError?.length ?? 0) > 120;
  const executionHistoryUnavailable = r.source === 'crontab' && !r.raw?.includes('scripts/cron-run.ts');
  return {
    id: r.id, name: r.name, cron: r.cron, interval_ms: r.interval_ms, category: r.category,
    source: r.source, enabled: !!r.enabled, run_via: r.run_via, last_run: r.last_run,
    command: command.slice(0, 120), note: r.note ?? null,
    last_status: r.last_status ?? null,
    last_exit: r.last_exit ?? null,
    last_duration_ms: r.last_duration_ms ?? null,
    last_error: lastError === null ? null : lastError.slice(0, 120),
    ...(commandTruncated ? { command_truncated: true } : {}),
    ...(lastErrorTruncated ? { last_error_truncated: true } : {}),
    ...(executionHistoryUnavailable ? { execution_history_available: false } : {}),
  };
};

export async function dispatchScheduleManage(args: Record<string, unknown>): Promise<unknown> {
  let action = String(args.action ?? 'list');
  // Mission Fabric 통합 U4d — schedule-runner 은퇴. adopt(→elanous 러너 실행)는
  // 더 이상 실행 주체가 없으므로 migrate(→fabric Schedule Trigger)의 별칭으로 리다이렉트.
  if (action === 'adopt') action = 'migrate';
  const sdb = openSchedulesDb();
  try {
    inventoryCrontab(sdb);            // crontab 27잡
    inventoryInternalSchedules(sdb);  // B2 — 데몬 내부 스케줄(daily-reflection·discovery) 통합 뷰
    if (action === 'list') {
      const rows = listSchedules(sdb, typeof args.category === 'string' && args.category ? { category: args.category as ScheduleRow['category'] } : {});
      return { schedules: rows.map(compactSchedule), count: rows.length,
        note: `crontab 인지 레지스트리(prospective memory). 총 ${rows.length}잡.` };
    }
    // 정확 매칭(id 완전 · name) 우선 → 없으면 id prefix 매칭(git 스타일).
    // CLI list 가 표시하는 짧은 id 를 그대로 붙여넣어도 동작하도록. prefix 가
    // 여러 잡에 걸리면 ambiguous 로 반환(잘못된 잡 조작 방지).
    const byId = (id: string): ScheduleRow | { ambiguous: string[] } | undefined => {
      if (!id) return undefined;
      const all = listSchedules(sdb);
      const exact = all.find(r => r.id === id || r.name === id);
      if (exact) return exact;
      const prefixed = all.filter(r => r.id.startsWith(id));
      if (prefixed.length === 1) return prefixed[0];
      if (prefixed.length > 1) return { ambiguous: prefixed.map(r => r.id) };
      return undefined;
    };
    const isAmbiguous = (r: ReturnType<typeof byId>): r is { ambiguous: string[] } =>
      !!r && typeof r === 'object' && 'ambiguous' in r;
    if (action === 'inspect') {
      const row = byId(String(args.id ?? ''));
      if (isAmbiguous(row)) return { error: `id 모호(여러 잡 매칭): ${row.ambiguous.join(', ')} — 더 긴 id 사용.` };
      if (!row) return { error: `잡 없음: ${args.id} (list로 id 확인).` };
      // S3 메모리 루프 — 이 잡이 최근 보낸 것(surface_events 교차 회상).
      let recentSends: Array<{ when: string; text: string }> = [];
      try {
        if (existsSync(surfaceEventsDbPath())) {
          const edb = openSurfaceEventsDb();
          try {
            const q = row.name.replace(/[-_]/g, ' ');
            // bump:false — cron 표시용 read-only 회상(미엘린 강화 대상 아님).
            recentSends = recallEvents(edb, { query: q, sinceHours: 72, limit: 3, bump: false })
              .map(h => ({ when: h.ts, text: h.text.slice(0, 120) }));
          } finally { edb.close(); }
        }
      } catch { /* fail-soft */ }
      return { schedule: { ...compactSchedule(row), raw: row.raw, last_seen: row.last_seen, domain: row.domain, source: row.source },
        recentSends, note: 'last_run=마지막 발화 · recentSends=이 잡 관련 최근 발송(예약↔실행 폐루프·S3).' };
    }
    // ── 쓰기 액션 (자동 백업) ──
    const current = readCrontab();
    if (action === 'create') {
      const cron = String(args.cron ?? '').trim();
      const command = String(args.command ?? '').trim();
      if (!cron || !command) return { error: 'create엔 cron + command 필수.' };
      const line = buildCronLine(cron, command);
      const backup = applyCrontab(addLineToCrontab(current, line));
      inventoryCrontab(sdb);
      // 오토파일럿 계보(AL2) — autopilotId 가 오면 방금 만든 잡에 미션 스탬프.
      const autopilotId = typeof args.autopilotId === 'string' ? args.autopilotId.trim() : '';
      let mission: string | undefined;
      if (autopilotId) {
        const created = listSchedules(sdb).find(r => r.raw === line.trim());
        if (created) { setScheduleMission(sdb, created.id, autopilotId); mission = autopilotId; }
      }
      return { created: line, backup, ...(mission ? { autopilotId: mission } : {}),
        note: '크론 추가됨(백업 완료). 다음 발화부터 적용.' };
    }
    // ── 관측성 래핑(P3·RFC-scheduler-execution-observability) — bun .ts 크론을 cron-run.ts 로 감싸/풀어
    //    3계층 관측 발효. dry-run 기본(--yes 적용·백업 자동). id 지정=그 잡만·미지정=전 .ts 크론. 가역(unwrap).
    if (action === 'wrap' || action === 'unwrap') {
      const isWrap = action === 'wrap';
      const idArg = String(args.id ?? '').trim();
      const onlyName = idArg ? (listSchedules(sdb).find(r => r.id.startsWith(idArg) || r.name === idArg)?.name ?? null) : null;
      if (idArg && !onlyName) return { error: `잡 없음: ${idArg} (list로 id 확인).` };
      const changes: Array<{ name: string; after: string }> = [];
      let skippedShell = 0;
      const newLines = current.split('\n').map((line) => {
        const parsed = parseCronLine(line);
        if (!parsed) return line;
        const nm = scriptName(parsed.command);
        if (onlyName && nm !== onlyName) return line;
        // 기존 bun .ts 래핑을 보존하고, 명시적 해석기가 있는 .sh만 셸 래퍼로 보낸다.
        // 앞선 쪽이 발화 주체다 — `env bun scripts/x.ts` 는 bun, `zsh x.sh --runner bun scripts/y.ts` 는 셸.
        const bunAt = parsed.command.search(/\bbun\s+\S*scripts\/[\w.-]+\.ts/);
        const shellAt = parsed.command.search(/(?:^|\s)(?:\S*\/)?(?:bash|zsh|sh)\s+\S+\.sh(?=\s|$)/);
        const bunJob = bunAt >= 0 && (shellAt < 0 || bunAt < shellAt);
        const after = isWrap
          ? bunJob ? wrapCronLine(line) : wrapShellCronLine(line, { bun: process.execPath, cronRun: join(repoRoot(), 'scripts', 'cron-run.ts') })
          : unwrapCronLine(line);
        if (isWrap && after === line && !bunJob && !/cron-run\.ts/.test(line)
          && /^(?:cd\s+\S+\s*&&\s*)?(?:\.\/|\S*\/)?[\w.-]+\.sh(?=\s|$)/.test(parsed.command)) skippedShell++;
        if (after === line) return line;
        changes.push({ name: nm, after: after.trim() });
        return after;
      });
      if (!changes.length) return { [isWrap ? 'wrapped' : 'unwrapped']: 0, ...(isWrap ? { skippedShell } : {}), note: isWrap ? '래핑할 .ts/.sh 크론 없음(이미 전부 래핑?).' : '언래핑할 래퍼 없음.' };
      if (args.yes !== true) {
        return { dryRun: true, action, count: changes.length, jobs: changes.map(c => c.name),
          ...(isWrap ? { skippedShell } : {}),
          note: `${changes.length}건 ${isWrap ? '래핑' : '언래핑'} 예정 — 적용하려면 yes:true(백업 자동·crontab 재작성).` };
      }
      const backup = applyCrontab(newLines.join('\n'));
      inventoryCrontab(sdb); // unwrap-aware 파생 → id/계보 승계.
      return { [isWrap ? 'wrapped' : 'unwrapped']: changes.length, jobs: changes.map(c => c.name), backup,
        ...(isWrap ? { skippedShell } : {}),
        note: `${changes.length}건 ${isWrap ? '래핑' : '언래핑'} 완료(백업 완료). ${isWrap ? '다음 발화부터 3계층(logs.db·레지스트리·자기기억) 관측' : '관측 래퍼 제거'}.` };
    }
    const target = byId(String(args.id ?? ''));
    if (isAmbiguous(target)) return { error: `id 모호(여러 잡 매칭): ${target.ambiguous.join(', ')} — 더 긴 id 사용.` };
    if (!target) return { error: `잡 없음: ${args.id} (list로 id 확인).` };
    if (action === 'delete') {
      // ★ 내부 기억 정합 — crontab 제거 + registry 명시 삭제(스캔미러는 upsert만). raw 부재
      //   (crontab 에 이미 없는 stale)면 registry 만 정리(정합 복구).
      // ★ 공유-라인 가드(2026-07-15·axon 세션 사고 근본 예방) — 팬텀/중복 registry 행이 실잡과 같은
      //   crontab 라인(raw)을 공유하면, removeLineFromCrontab 이 그 라인을 지워 실잡까지 죽인다.
      //   다른 활성 행이 같은 raw 를 쓰면 crontab 무접촉·registry 행만 삭제(팬텀 정리 안전).
      const sharedByOther = sharesCrontabLine(listSchedules(sdb), target.id, target.raw);
      const backup = (target.raw && !sharedByOther) ? applyCrontab(removeLineFromCrontab(current, target.raw)) : null;
      // U4e — trigger 이관잡은 파생 tox task 도 삭제(부팅 sweep 재등록 방지·고아 방지).
      let triggerNote = '';
      if (target.run_via === 'trigger') {
        const { deleteTriggerJob } = await import('./schedule-migrate.js');
        const { TaskStore } = await import('../task-orchestrator/store.js');
        const store = new TaskStore();
        try {
          const r = deleteTriggerJob(store, target.id);
          triggerNote = r.taskDeleted
            ? ' trigger 이관잡: tox task 삭제(재시작 후 트리거 소멸·live unregister 없음).'
            : ' trigger 이관잡(파생 task 없음).';
        } finally { store.close(); }
      }
      deleteScheduleRow(sdb, target.id);
      inventoryCrontab(sdb);
      return { deleted: target.name, id: target.id, backup, ...(sharedByOther ? { crontabPreserved: true } : {}),
        note: (triggerNote || (sharedByOther
          ? 'registry 행만 삭제 — 같은 crontab 라인을 다른 잡이 공유해 실 crontab 보존(팬텀/중복 안전 정리).'
          : (target.raw ? '삭제됨(crontab+registry 정합·백업 복구 가능).' : 'registry stale 정리(crontab엔 이미 없음).'))) };
    }
    if (action === 'note') {
      // 사람용 설명 저장(툴팁). raw 무관 — internal(daily-reflection 등) 잡도 설명 가능.
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      setNote(sdb, target.id, note);
      return { noted: target.name, id: target.id, note };
    }
    if (action === 'migrate') {
      // Mission Fabric 통합 U3(B안) — 예약잡을 fabric Task(cron surface)+Schedule
      // Trigger 로 이관(schedule-runner 은퇴 경로). raw 무관(elanous 러너 잡도 이관)이라
      // 원문 부재 가드보다 앞. 데몬 live 등록·run_via='trigger'·crontab 라인 제거.
      // workflow-run 결과는 U3b 브릿지가 schedule_registry 로 되먹임.
      const { migrateJobToTrigger } = await import('./schedule-migrate.js');
      const { TaskStore } = await import('../task-orchestrator/store.js');
      const { getToxRuntimeDeps } = await import('../task-orchestrator/runtime-deps.js');
      const daemon = getToxRuntimeDeps().getWorkflowDaemon?.() as
        { registerWorkflow: (e: unknown) => void } | null;
      const store = new TaskStore();
      try {
        const res = migrateJobToTrigger({
          scheduleDb: sdb,
          store,
          ...(daemon ? { registerWorkflow: (e) => daemon.registerWorkflow(e) } : {}),
          ...(target.raw ? { removeCrontabLine: (raw: string) => { applyCrontab(removeLineFromCrontab(current, raw)); } } : {}),
        }, target.id);
        inventoryCrontab(sdb);
        return {
          migrated: target.name, id: target.id, taskId: res.taskId,
          registered: res.registered, crontabRemoved: res.crontabRemoved,
          note: res.registered
            ? 'fabric Schedule Trigger 로 이관(run_via=trigger·crontab 제거·데몬 live 등록). schedule-runner 정지·결과는 브릿지가 되먹임. 복원은 데몬 재시작 필요(unregister 없음).'
            : '⚠️ 데몬 미가동 — Task 저장·run_via=trigger 됐으나 live 등록 안 됨. 데몬 재시작 시 부팅 sweep 이 등록(그때까지 미발화).',
        };
      } finally { store.close(); }
    }
    // U4e — trigger 이관잡은 crontab 라인이 없으므로 crontab 기반 update/enable/disable
    // 금지(이중발화 위험: enable/update 가 라인 재추가). trigger 전용 처리.
    if (target.run_via === 'trigger' && (action === 'update' || action === 'enable' || action === 'disable')) {
      if (action === 'update') {
        const cron = String(args.cron ?? '').trim();
        if (!cron) return { error: 'update엔 새 cron 필수.' };
        const { findScheduledTaskId } = await import('./schedule-migrate.js');
        const { TaskStore } = await import('../task-orchestrator/store.js');
        const store = new TaskStore();
        try {
          const taskId = findScheduledTaskId(store, target.id);
          if (!taskId) return { error: 'trigger 이관잡의 tox task 없음(정합 깨짐) — migrate 재실행 필요.' };
          const t = store.getTask(taskId);
          if (t) store.saveTask({ ...t, scheduleText: cron, updatedAt: Date.now() });
        } finally { store.close(); }
        return { updated: target.name, newCron: cron,
          note: 'trigger 이관잡 스케줄 갱신(tox task). ⚠️ 데몬 재시작해야 새 cron 발화(기존 트리거는 재시작 전까지 옛 cron·unregister 없음).' };
      }
      return { error: `trigger 이관잡은 ${action} 미지원(crontab 라인 없음). 정지=delete(+재시작)·재이관=migrate.` };
    }
    if (!target.raw) return { error: `원문 부재(수정 불가): ${args.id}` };
    if (action === 'enable' || action === 'disable') {
      const next = setLineEnabled(current, target.raw, action === 'enable');
      // ⭐ crontab 이 «안 변하면» 이미 그 상태였다는 뜻 — 쓰지 않고 그렇게 «말한다».
      //   ⛔ 종전엔 무조건 성공 문면을 내서, 이미 꺼진 잡에 disable 을 쳐도 「disabled」라 답했다
      //     (2026-08-19 실측: 그렇게 답하고 레지스트리 값은 enabled=true 그대로였다).
      //     ⇒ 도구가 「했다」고 말하는데 값이 안 변하면 사람은 그것을 «검증하지 않는다».
      if (next === current) {
        inventoryCrontab(sdb); // 표시 정합만 회복(주석 줄을 읽어 enabled 를 내린다)
        return { [action + 'd']: target.name, changed: false,
          note: `이미 ${action === 'enable' ? '켜져' : '꺼져'} 있었다 — crontab 무변경(표시 정합만 회복).` };
      }
      const backup = applyCrontab(next);
      inventoryCrontab(sdb);
      return { [action + 'd']: target.name, changed: true, backup };
    }
    if (action === 'update') {
      const cron = String(args.cron ?? '').trim();
      if (!cron) return { error: 'update엔 새 cron 필수.' };
      if (cron === target.cron) return { updated: target.name, newCron: cron, note: '동일 cron — 변경 없음' };
      const oldCmd = target.raw.replace(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, ''); // cron 5필드 제거 = 커맨드
      const line = `${cron} ${oldCmd}`;
      const backup = applyCrontab(addLineToCrontab(removeLineFromCrontab(current, target.raw), line));
      inventoryCrontab(sdb);
      // ★ id 는 sha1(cron+command) 라 cron 변경 시 id 가 바뀐다 → 옛 id 는 crontab 에서 사라져
      //   registry 에 고아로 남는다(inventory=upsert-only). 새 라인(raw)으로 새 id 를 찾아 옛 id 의
      //   이력/설정을 이관하고 고아를 제거(정합 회복). raw 매칭이라 해시 재계산 중복/드리프트 없음.
      const fresh = sdb.prepare(`SELECT id FROM schedule_registry WHERE raw = ?`).get(line.trim()) as { id: string } | undefined;
      const reindexed = fresh && fresh.id !== target.id ? reindexCrontabEntry(sdb, target.id, fresh.id) : false;
      // ★ 미션 연결 잡이면 미션 materializeSpec.cron 도 동기화(스펙↔크론 불일치 방지·2026-07-12).
      const missionSync = await syncMissionCron(target.autopilot_id, cron);
      return {
        updated: target.name, newCron: cron, backup,
        ...(fresh && fresh.id !== target.id ? { id: fresh.id, reindexedFrom: target.id } : {}),
        ...(reindexed ? { reindexed: true } : {}),
        ...(missionSync ? { missionSpecSynced: missionSync } : {}),
      };
    }
    // (adopt 는 U4d 에서 migrate 별칭으로 리다이렉트됨 — schedule-runner 은퇴.)
    if (action === 'release') {
      const line = target.raw ?? (target.cron && target.command ? buildCronLine(target.cron, target.command) : '');
      if (!line) return { error: 'release: 복원할 라인 없음(raw/cron 부재).' };
      const backup = applyCrontab(addLineToCrontab(current, line));
      setRunVia(sdb, target.id, 'crontab');
      inventoryCrontab(sdb);
      // 파생 tox task 도 지운다 — delete 와 같은 규칙(안 지우면 부팅 sweep 이 다시 트리거로 등록한다).
      // run_via 가 이미 crontab 이어도 지운다(앞선 release 가 남긴 고아를 이 명령으로 치울 수 있게).
      const { deleteTriggerJob } = await import('./schedule-migrate.js');
      const { TaskStore } = await import('../task-orchestrator/store.js');
      const store = new TaskStore();
      let taskDeleted = false;
      try { taskDeleted = deleteTriggerJob(store, target.id).taskDeleted; } finally { store.close(); }
      return { released: target.name, id: target.id, backup, taskDeleted, note: taskDeleted
        ? 'crontab 실행으로 복원 · 파생 tox task 삭제(재시작 뒤 트리거 소멸).'
        : 'crontab 실행으로 복원(파생 tox task 없음).' };
    }
    return { error: `알 수 없는 action: ${action}` };
  } catch (e) {
    return { error: `schedule_manage 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  } finally { sdb.close(); }
}
