import type { Command } from 'commander';
import * as ui from '../ui.js';
import { writeStdoutJson } from './stdout-json.js';
import type { OpsNowResult } from '../ops-now/ops-now-refresh.js';

export function opsNowExitCode(outcome: OpsNowResult['outcome']): number {
  return outcome === 'channel-unreadable' || outcome === 'summarize-failed' ? 2 : 0;
}

export function registerOpsCommands(program: Command): void {
const opsCmd = program.command('ops')
  .description('운영 관측(READ-ONLY) — 미션·태스크·계약 루프·오케스트레이터 현재 상태·이상·전이. --json 프로그래매틱.');

interface OpsOpts { id?: string; entityType?: string; event?: string; sinceHours?: string; limit?: string; json?: boolean }

// ops 연합(fleet · --all-instances) — 각 인스턴스에 opsSnapshot 을 인스턴스별 스토어 경로로
// 호출해 미션·태스크뿐 아니라 loops(계약루프)·스케줄·오케스트레이션까지 전체 종합한다.
// 경로 주입이 opsSnapshot 의 부작용/편향을 자동 우회한다:
//   · schedulesDbPath 주입 → crontab inventory skip(ops-status.ts `if(!opts.schedulesDbPath)`)
//   · mandate 명시 주입 → loadMandate() 기본(prod) 미호출(ops-status.ts `opts.mandate!==undefined`)
// loadMandate(path) 는 파일 부재 시 DEFAULT_MANDATE(DISARMED) fail-soft — test 인스턴스 안전.
// prod 는 instanceStorePaths(~/.elanous)==기본 경로라 종전 loops/스케줄이 그대로 보인다(무회귀).
async function runOpsFleet(json: boolean, includeTest = false): Promise<never> {
  const { buildFleetView, instanceStorePaths } = await import('../domains/fleet.js');
  const { TaskStore } = await import('../task-orchestrator/store.js');
  const { opsSnapshot } = await import('../domains/ops-status.js');
  const { loadMandate } = await import('../domains/trade-mandate.js');
  // 격리 test 인스턴스는 기본 제외(데이터 오염 방지 · Phase A) — --include-test 로 opt-in.
  const view = buildFleetView().filter((v) => v.stores.tasks && (includeTest || v.kind !== 'test'));
  const rows: Array<{ name: string; kind: string; stateDir: string; snapshot: import('../domains/ops-status.js').OpsSnapshot }> = [];
  for (const i of view) {
    let store: InstanceType<typeof TaskStore> | null = null;
    try {
      const p = instanceStorePaths(i.stateDir, i.configDir);
      store = new TaskStore({ path: p.tasks });
      const snapshot = opsSnapshot({
        opsDbPath: p.opsEvents,
        schedulesDbPath: p.schedules,
        mandate: loadMandate(p.mandate),   // 파일 부재 → DEFAULT(DISARMED) fail-soft
        missionStore: store,
      });
      rows.push({ name: i.name, kind: i.kind, stateDir: i.stateDir, snapshot });
    } catch { /* skip 손상/락 db */ } finally { store?.close?.(); }
  }
  if (json) { await writeStdoutJson(JSON.stringify(rows, null, 2) + '\n'); process.exit(0); }
  ui.header(`ops · fleet (${rows.length} instances · read-only union · loops/스케줄/오케스트레이션 포함)`);
  for (const { name, kind, snapshot: s } of rows) {
    const kindTag = kind === 'test' ? ui.dim(' [test]') : '';
    const sched = s.schedules ? `${s.schedules.elanousTotal}개(stale ${s.schedules.stale.length}·err ${s.schedules.errored.length})` : '—';
    console.log(`  ${name.padEnd(22)}${kindTag} 미션 ${String(s.missions.total).padStart(3)} ${JSON.stringify(s.missions.byStatus)}`);
    console.log(ui.dim(`  ${''.padEnd(22)} 태스크 ${String(s.tasks.total).padStart(3)} ${JSON.stringify(s.tasks.byStatus)} — 스케줄실행 ${s.tasks.scheduleBacked}(최근 ${s.tasks.recentlyActive}) · blocked ${s.tasks.blocked.length}`));
    console.log(ui.dim(`  ${''.padEnd(22)} 루프 ${s.loops.loops.length}개 armed=${s.loops.armed}${s.loops.live ? '·LIVE' : ''} mode=${s.loops.executionMode} · 오케스트 ${s.orchestration.recent.length}건 · 스케줄 ${sched}`));
  }
  ui.info(ui.dim('연합=미션/태스크/loops/스케줄/오케스트레이션 전체 종합(스토어 경로 주입). 단일 인스턴스 상세=`elanous ops status`.'));
  process.exit(0);
}

async function runOps(action: string, opts: OpsOpts): Promise<never> {
  const { dispatchOpsStatus } = await import('../domains/ops-status-tool.js');
  const result = await dispatchOpsStatus({
    action,
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.entityType ? { entityType: opts.entityType } : {}),
    ...(opts.event ? { event: opts.event } : {}),
    ...(opts.sinceHours ? { sinceHours: Number(opts.sinceHours) } : {}),
    ...(opts.limit ? { limit: Number(opts.limit) } : {}),
  });
  const isErr = !!result && typeof result === 'object' && 'error' in (result as object);
  if (opts.json || isErr) {
    await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
  } else if (action === 'mission') {
    const r = result as { mission: { goal: string; disposition: string; source: string; engine: string | null; rationale: string | null; createdAt: string } | null; derived: Array<{ kind: string; name: string; status: string; detail?: string }>; transitions: Array<{ ts: string; event: string; toState: string | null }>; phases: Array<{ index: number; title: string; status: string; failClass?: string; diagnosis?: { narrative: string; rootCause: string; heal: string; confidence: string }; prUrl?: string }>; runLogPath: string | null; planDraft: string | null; note: string };
    if (!r.mission) { console.log(r.note); }
    else {
      ui.header(`미션 상세 · ${r.mission.disposition}`);
      console.log(`  목표    ${r.mission.goal}`);
      console.log(`  출처    ${r.mission.source}${r.mission.engine ? ` · engine=${r.mission.engine}` : ''}  · 생성 ${r.mission.createdAt.slice(0, 16)}`);
      if (r.mission.rationale) console.log(`  근거    ${r.mission.rationale}`);
      if (r.planDraft) { console.log(`\n  ── 멀티페이즈 플랜 (승인 전 검토) ──`); for (const line of r.planDraft.split('\n')) console.log(`  ${line}`); console.log(''); }
      // ★ 페이즈 + 저장 진단(P1) — 실패 페이즈는 failClass·근본원인·권장 힐을 그대로(재계산 없음).
      if (r.phases?.length) {
        console.log(`  페이즈 ${r.phases.length}건:`);
        for (const p of r.phases) {
          const mark = p.status === 'done' ? '✅' : p.status === 'failed' ? '❌' : p.status === 'running' ? '🔧' : '·';
          console.log(`    ${mark} ${p.index}. [${p.status}${p.failClass ? `·${p.failClass}` : ''}] ${p.title}${p.prUrl ? ` · PR ${p.prUrl}` : ''}`);
          if (p.diagnosis) {
            console.log(`       🧭 ${p.diagnosis.rootCause}`);
            console.log(`       💡 권장: ${p.diagnosis.heal}(${p.diagnosis.confidence})`);
          }
        }
      }
      if (r.runLogPath) console.log(`  실행 로그  ${r.runLogPath}`);
      console.log(`  관련 파생물 (태스크/스케줄/자율행동) ${r.derived.length}건:`);
      for (const d of r.derived) console.log(`    [${d.kind}] ${d.name}  — ${d.status}${d.detail ? ` (${d.detail})` : ''}`);
      if (r.transitions.length) {
        console.log(`  상태 전이 ${r.transitions.length}건:`);
        for (const t of r.transitions) console.log(`    ${t.ts.slice(0, 16)}  ${t.event} ${t.toState ?? ''}`);
      }
    }
  } else if (action === 'health') {
    const r = result as { healthy: boolean; anomalies: Array<{ kind: string; entity: string; detail: string }>; note: string };
    ui.header(r.healthy ? '운영 상태: 정상 ✓' : `운영 상태: 이상 ${r.anomalies.length}건 ⚠`);
    for (const a of r.anomalies) console.log(`  [${a.kind}] ${a.entity} — ${a.detail}`);
    console.log(`  ${r.note}`);
  } else if (action === 'timeline') {
    const r = result as { count: number; timeline: Array<{ ts: string; entityType: string; entityId: string; event: string; toState: string | null }> };
    ui.header(`운영 전이 타임라인 (${r.count})`);
    for (const e of r.timeline) console.log(`  ${e.ts}  ${e.entityType.padEnd(13)} ${e.event.padEnd(14)} ${e.toState ?? ''}  ${e.entityId}`);
  } else {
    const r = result as {
      missions: { total: number; byStatus: Record<string, number>; active: Array<{ status: string; disposition: string; goal: string }> };
      tasks: { total: number; byStatus: Record<string, number>; scheduleBacked: number; recentlyActive: number; dispatchPending: number; blocked: unknown[]; dispatchable: Array<{ title: string }> };
      loops: { loops: unknown[]; armed: boolean; executionMode: string }; health: { healthy: boolean; anomalyCount: number; anomalies: Array<{ kind: string; entity: string; detail: string }> };
    };
    ui.header('운영 상태 스냅샷');
    console.log(`  미션    ${r.missions.total}건  ${JSON.stringify(r.missions.byStatus)}  (대부분 승인대기·HITL)`);
    console.log(`  태스크  ${r.tasks.total}건 — 스케줄실행 ${r.tasks.scheduleBacked}(최근발화 ${r.tasks.recentlyActive}) · 디스패치대기 ${r.tasks.dispatchPending} · blocked ${r.tasks.blocked.length}`);
    if (r.tasks.dispatchable.length) console.log(`          대기: ${r.tasks.dispatchable.map((t) => t.title).slice(0, 3).join(' · ')}`);
    console.log(`  루프    ${r.loops.loops.length}개 활성  armed=${r.loops.armed}  mode=${r.loops.executionMode}`);
    console.log(`  건강    ${r.health.healthy ? '정상 ✓' : `이상 ${r.health.anomalyCount}건 ⚠`}`);
    // 이상 상세도 스냅샷에서 바로 — "무엇이" 이상인지 ops health 재조회 없이(관측 갭 해소).
    if (!r.health.healthy) for (const a of r.health.anomalies) console.log(`          ⚠ [${a.kind}] ${a.entity} — ${a.detail}`);
  }
  process.exit(isErr ? 1 : 0);
}

// ── SE 격리 빌드 관측 CLI(PLAN B3) — list/스냅샷/--follow(tail -f 스트리밍) ──
interface OpsBuildOpts { all?: boolean; follow?: boolean; stop?: boolean; tail?: string; json?: boolean }
async function runOpsBuild(buildId: string | undefined, opts: OpsBuildOpts): Promise<never> {
  const { dispatchSeBuild, buildSnapshot } = await import('../domains/se-build-tool.js');
  const { buildLogPath } = await import('../autopilot/se-build-registry.js');
  // --stop (빌드 컨트롤 — 실행중 빌드 중단)
  if (buildId && opts.stop) {
    const r = await dispatchSeBuild({ action: 'stop', buildId }) as { ok?: boolean; error?: string; killedPids?: number[]; missionId?: string; note?: string };
    if (opts.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); process.exit(r.ok ? 0 : 1); }
    if (r.ok) console.log(`⏹ 빌드 중단: ${buildId}${r.killedPids ? ` (SIGTERM pid ${r.killedPids.join(',')})` : ''}\n  미션 ${r.missionId} — 재개는 재구현/재실행으로.`);
    else console.log(`중단 실패: ${r.error}`);
    process.exit(r.ok ? 0 : 1);
  }
  // list (buildId 없음)
  if (!buildId) {
    const r = await dispatchSeBuild({ action: 'list', all: opts.all === true }) as { builds: Array<{ buildId: string; status: string; phase: string; backend: string; attempt: number }>; note: string };
    if (opts.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); process.exit(0); }
    ui.header('SE 격리 빌드');
    if (!r.builds.length) console.log(`  ${r.note}`);
    for (const b of r.builds) console.log(`  ${b.buildId}  [${b.status}]  ${b.backend}·시도${b.attempt}  ${b.phase.slice(0, 40)}`);
    process.exit(0);
  }
  // --follow (tail -f 스트리밍·adb logcat 스타일)
  if (opts.follow) {
    const { readFileSync, existsSync, statSync } = await import('node:fs');
    const snap = buildSnapshot(buildId, { tail: 1 });
    const logPath = snap?.build.logPath ?? buildLogPath(buildId);
    console.log(`── follow ${buildId} · ${logPath} (Ctrl-C 종료) ──`);
    let offset = 0;
    if (existsSync(logPath)) { const buf = readFileSync(logPath); process.stdout.write(buf); offset = buf.length; }
    for (;;) {
      await new Promise((res) => setTimeout(res, 1000));
      try {
        if (!existsSync(logPath)) continue;
        const size = statSync(logPath).size;
        if (size > offset) { const buf = readFileSync(logPath); process.stdout.write(buf.subarray(offset)); offset = buf.length; }
        else if (size < offset) { offset = 0; } // 로그 회전 감지 → 처음부터
      } catch { /* fail-soft·계속 폴링 */ }
    }
  }
  // 스냅샷
  const snap = buildSnapshot(buildId, { tail: opts.tail ? Number(opts.tail) : 40 });
  if (opts.json) { await writeStdoutJson(JSON.stringify(snap, null, 2) + '\n'); process.exit(snap ? 0 : 1); }
  if (!snap) { console.log(`빌드 없음: ${buildId}`); process.exit(1); }
  ui.header(`SE 빌드 · ${snap.build.status}`);
  console.log(`  ${snap.build.buildId}  ${snap.build.backend}·시도${snap.build.attemptSeq}·maxTurns${snap.build.maxTurns ?? '?'}`);
  console.log(`  페이즈  ${snap.build.phaseTitle}`);
  console.log(`  worktree  ${snap.worktree ?? '(없음)'}`);
  if (snap.diffStat) { console.log(`  ── 변경(diff --stat) ──`); for (const l of snap.diffStat.split('\n')) console.log(`  ${l}`); }
  console.log(`  ── 로그 tail ──`);
  for (const l of snap.logTail) console.log(`  ${l}`);
  process.exit(0);
}

opsCmd.command('now-refresh').description('채널 📌안내로 ops-now 고정 기억 갱신(1회)')
  .option('--once', '한 번 실행(기본)')
  .option('--dry-run', '기억을 쓰지 않고 새 본문 출력')
  .option('--json', '결과를 JSON으로 출력')
  .action(async (o: { dryRun?: boolean; json?: boolean }) => {
    const { refreshOpsNow } = await import('../ops-now/ops-now-refresh.js');
    const result = await refreshOpsNow({ dryRun: o.dryRun === true });
    if (o.json) await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
    else {
      console.log(`ops-now: ${result.outcome} · 안내 ${result.notices}개`);
      if (o.dryRun && result.body !== undefined) console.log(result.body);
    }
    process.exitCode = opsNowExitCode(result.outcome);
  });

opsCmd.command('status').description('현재 상태 종합(미션·태스크·루프·오케스트레이션·스케줄) · --all-instances 로 fleet 전체 종합(미션/태스크/loops/스케줄/오케스트레이션) · -r/--remote 로 원격 GET 조립')
  .option('--json').option('--all-instances', '등록 인스턴스 전체 종합(미션/태스크/loops/스케줄/오케스트레이션 · fleet · read-only · §10)')
  .option('--include-test', '연합에 격리 test 인스턴스도 포함(기본 제외)')
  // ⛔ `-r` 은 값을 받지 않는다 — default 북마크만. 이름은 `--remote <name>` 으로만 준다.
  .option('-r', 'query ops status on the default remote bookmark (does not take a value)')
  .option('--remote <name>', 'query ops status on a named remote bookmark via GET /v1/missions · /v1/tasks · /v1/autopilot/arming')
  .action(async (o: OpsOpts & { allInstances?: boolean; includeTest?: boolean; r?: boolean; remote?: string }) => {
    if (o.remote !== undefined || o.r === true) {
      const { runOpsStatusRemote } = await import('./ops-status-remote.js');
      const result = await runOpsStatusRemote({
        args: process.argv.slice(2),
        remote: o.remote !== undefined ? o.remote : true,
        json: o.json === true,
        allInstances: o.allInstances === true,
      });
      process.exitCode = result.classification === 'ok' ? 0 : 1;
      return;
    }
    return o.allInstances ? runOpsFleet(o.json === true, o.includeTest === true) : runOps('snapshot', o);
  });
// OPS-OVERVIEW-CLI (RFC-ops-overview-flow-health-cli-2026-10-08) — 판정 먼저 · 이유 사슬 · 절. 못 잼 = null(0 아님).
opsCmd.command('overview').description('흐름 한 장 — 저작→구현→착지가 흐르나(판정 먼저·이유 사슬) · 판·일꾼·기계·착지·루프 · 못 잼은 null · exit 0=흐름 정상/저하 3=그 밖 1=수집 실패')
  .option('--json', '칸 꼴 그대로 ⊕ 머리 {verdict, reasons, nextActions, meta.elapsedMs}')
  .option('--watch [seconds]', '주기 재조회(기본 30초)')
  .option('--since <window>', '착지 창(<n>m|h|d · 기본 1h)', '1h')
  .option('--owner <owner>', '일꾼 절 거르기 — seat:TC · TC · unassigned · all')
  .option('--version <v>', '판(기본: 다음 컷)')
  .action(async (o: { json?: boolean; watch?: string | boolean; since?: string; owner?: string; version?: string }) => {
    const { runOpsOverview } = await import('./ops-overview-cli.js');
    process.exitCode = await runOpsOverview(o);
  });
opsCmd.command('health').description('이상 판정만(blocked·errored·stale)').option('--json')
  .action((o: OpsOpts) => runOps('health', o));
opsCmd.command('timeline').description('상태 전이 최근순 통합')
  .option('--entity-type <t>', 'mission|task|loop|orchestration')
  .option('--event <e>', 'created|status_change|cycle_start|cycle_end|merge|alloc|blocked')
  .option('--since-hours <n>', '조회 기간(기본 48)').option('--limit <n>', '건수(기본 40)').option('--json')
  .action((o: OpsOpts) => runOps('timeline', o));
opsCmd.command('mission <id>').description('미션 1건 상세 — 내용 + 페이즈별 진단(failClass·권장 힐) + 관련 태스크/스케줄/자율행동 fan-in + 전이')
  .option('--json').action((id: string, o: OpsOpts) => runOps('mission', { ...o, id }));
// P5 (2026-07-13) — 미션별 영속 run.log tail(O3 의 표면 완결·READ-ONLY). 빌드 단위 실시간
// follow 는 `elanous ops build --follow`(B3) — 여긴 미션 레벨 스냅샷 tail.
opsCmd.command('mission-log <id>').description('미션 실행 로그(run.log) tail — 진단 근거의 실체(재부팅에도 영속)')
  .option('-n, --lines <n>', '마지막 N줄(기본 40·최대 200)').option('--json')
  .action(async (id: string, o: { lines?: string; json?: boolean }) => {
    const { dispatchAutopilotMissions } = await import('../autopilot/mission-tool.js');
    const r = await dispatchAutopilotMissions({ action: 'log', id, ...(o.lines ? { tail: Number(o.lines) } : {}) }) as
      { error?: string; exists?: boolean; lines?: string[]; runLogPath?: string; note?: string };
    if (o.json || r.error) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); process.exit(r.error ? 1 : 0); }
    if (!r.exists) { console.log(r.note ?? '로그 없음'); process.exit(0); }
    for (const line of r.lines ?? []) console.log(line);
    console.log(`\n· ${r.note ?? r.runLogPath ?? ''}`);
    process.exit(0);
  });
opsCmd.command('build [buildId]').description('SE 격리 빌드 관측/컨트롤 — 없으면 list, buildId 지정 시 스냅샷. --follow=tail -f 스트리밍, --stop=실행중 빌드 중단')
  .option('--stop', '실행중 빌드 중단(미션 프로세스 SIGTERM·재개는 재구현/재실행)')
  .option('--all', '종결 포함 전체(list)').option('--follow', 'tail -f 스트리밍(adb logcat 스타일)')
  .option('--tail <n>', '로그 tail 줄 수(기본 40)').option('--json')
  .action((buildId: string | undefined, o: OpsBuildOpts) => runOpsBuild(buildId, o));

}
