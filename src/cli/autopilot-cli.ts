import type { Command } from 'commander';
import * as ui from '../ui.js';
import { writeStdoutJson } from './stdout-json.js';

// ROADMAP-ipad-companion-autopilot-priority §D1.3 — headless mission
// runner. Spawns an ACP backend, opens a single session, runs the
// AutopilotLoopDriver against the mission, prints agent deltas on
// stdout + envelope/termination summary on stderr.
export function registerAutopilotCommands(program: Command): void {
  // Explicit runtime entry for a selected action; the task chooser can invoke this entry.
  const autopilotCmd = program
    .command('autopilot')
    .description('Mission-driven autopilot — runs an ACP agent against a single mission with safety + budget guards');
  autopilotCmd.command('task-agent-action <actionJson>')
    .description('Execute a selected task-agent action; defaults to shadow')
    .action(async (actionJson: string) => {
      const { executeNextAction } = await import('../task-agent/actions.js');
      const { getUserConfig } = await import('../user-config.js');
      const { spawnSync } = await import('node:child_process');
      const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { debug } = await import('../debug/log.js');
      const { withFileLockSync } = await import('../storage/file-lock.js');
      const config = getUserConfig() as ReturnType<typeof getUserConfig> & { taskAgent?: { mode?: string } };
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const statePath = join(effectiveInstanceRoot(), 'task-agent-actions.json');
      let state: { landingDay?: string; landingsToday?: number; failureCounts?: Record<string, number> } = {};
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first run */ }
      const action = JSON.parse(actionJson) as import('../task-agent/actions.js').NextAction;
      const deps: import('../task-agent/actions.js').ActionDeps = {
        ...state,
        failureCounts: state.failureCounts ?? {},
        saveState: () => {
          mkdirSync(dirname(statePath), { recursive: true });
          // 실패 횟수는 incrementFailure 가 잠금 안에서 키별로 더한다 — 여기선 덮어쓰지 않는다.
        },
        mode: config.taskAgent?.mode,
        // 하루 착지 칸은 상태 파일 잠금 안에서 확보·반환한다 — 두 CLI 프로세스가 같은 잔여 칸을 쓰지 않게.
        reserveLanding: (day, limit) => withFileLockSync(`${statePath}.lock`, () => {
          let disk: typeof state = {};
          try { disk = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first */ }
          const used = disk.landingDay === day ? disk.landingsToday ?? 0 : 0;
          if (used >= limit) return false;
          mkdirSync(dirname(statePath), { recursive: true });
          writeFileSync(statePath, JSON.stringify({ ...disk, landingDay: day, landingsToday: used + 1 }));
          deps.landingDay = day; deps.landingsToday = used + 1;
          return true;
        }),
        incrementFailure: (key) => withFileLockSync(`${statePath}.lock`, () => {
          let disk: typeof state = {};
          try { disk = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first */ }
          const counts = { ...(disk.failureCounts ?? {}) };
          counts[key] = (counts[key] ?? 0) + 1;
          mkdirSync(dirname(statePath), { recursive: true });
          writeFileSync(statePath, JSON.stringify({ ...disk, failureCounts: counts }));
          return counts[key]!;
        }),
        releaseLanding: (day) => withFileLockSync(`${statePath}.lock`, () => {
          let disk: typeof state = {};
          try { disk = JSON.parse(readFileSync(statePath, 'utf8')); } catch { return; }
          if (disk.landingDay !== day || !disk.landingsToday) return;
          writeFileSync(statePath, JSON.stringify({ ...disk, landingsToday: disk.landingsToday - 1 }));
          deps.landingsToday = disk.landingsToday - 1;
        }),
        observe: (_event, data) => debug.log('task-agent', 'action', data),
        command: async args => {
          const p = args[0] === 'gh'
            // PR 조회는 착지할 작업 트리에서 — 다른 저장소에서 불러도 엉뚱한 PR 을 읽지 않게.
            ? spawnSync('gh', args.slice(1), { encoding: 'utf8', ...(action.cwd ? { cwd: action.cwd } : {}) })
            // 지금 돌고 있는 진입점으로 부른다 — 저장소 밖(설치본)에서 불러도 같은 elanous 를 쓴다.
            : spawnSync(process.execPath, [process.argv[1]!, ...(process.argv.includes('--test') ? ['--test'] : []), ...args], { encoding: 'utf8' });
          return { status: p.status ?? 1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
        },
      };
      const result = await executeNextAction(action, deps);
      if (config.taskAgent?.mode === 'live') deps.saveState?.();
      process.stdout.write(`${result}\n`);
    });

autopilotCmd
  .command('run <mission...>')
  .description('Run a single mission. The mission is sent as the first prompt to the ACP backend; subsequent turns require a planner (deferred to D1.4+).')
  .option('-b, --backend <id>', 'ACP backend id (claude / codex / gemini …)', 'claude')
  .option('-i, --max-iterations <n>', 'Max loop iterations', '1')
  .option('-w, --max-wallclock-ms <ms>', 'Wall-clock budget in milliseconds', '0')
  .option('-c, --max-output-chars <n>', 'Cumulative output character budget (token proxy)', '0')
  .option('-d, --cwd <path>', 'Working directory for the spawned backend (default: elanous session cwd)')
  .option('-v, --verbose', 'Mirror ACP subprocess log lines to stderr')
  .option('-p, --auto-plan', 'Parse mission numbered/bulleted list into AutopilotPlan (D1.4b heuristic · no LLM)')
  .action(async (
    missionParts: string[],
    opts: {
      backend: string;
      maxIterations: string;
      maxWallclockMs: string;
      maxOutputChars: string;
      cwd?: string;
      verbose?: boolean;
      autoPlan?: boolean;
    },
  ) => {
    const { runAutopilotMission } = await import('./autopilot-run.js');
    const mission = missionParts.join(' ').trim();
    if (!mission) {
      process.stderr.write('autopilot run: mission text is required\n');
      process.exit(2);
    }
    const wallClock = parseInt(opts.maxWallclockMs, 10);
    const outputChars = parseInt(opts.maxOutputChars, 10);
    try {
      const outcome = await runAutopilotMission({
        mission,
        backend: opts.backend,
        maxIterations: parseInt(opts.maxIterations, 10) || 1,
        maxWallClockMs: wallClock > 0 ? wallClock : undefined,
        maxOutputChars: outputChars > 0 ? outputChars : undefined,
        cwd: opts.cwd,
        verbose: opts.verbose,
        autoPlan: opts.autoPlan,
      });
      process.exit(outcome.exitCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`autopilot run: ${msg}\n`);
      process.exit(1);
    }
  });

autopilotCmd
  .command('rerun <missionId>')
  .description('미션 유지·재실행 — 페이즈를 backlog 로 리셋하고 run-mission 재spawn(멀티페이즈 순회 재개). --from 으로 특정 페이즈부터(그 이후 전부 재실행).')
  .option('-f, --from <index>', '재실행 시작 페이즈 인덱스(0=처음부터·기본)', '0')
  .action(async (missionId: string, opts: { from: string }) => {
    const { rerunMission } = await import('../autopilot/mission-lifecycle.js');
    const r = rerunMission(missionId, { fromPhaseIndex: parseInt(opts.from, 10) || 0 });
    if (r.ok) {
      process.stdout.write(`🔄 재실행: ${r.reset}/${r.total} 페이즈 리셋(from ${r.fromIndex})·집행 시작\n`);
      process.exit(0);
    }
    process.stderr.write(`autopilot rerun: ${r.error ?? '실패'}\n`);
    process.exit(1);
  });

autopilotCmd
  .command('signal <missionId> <kind>')
  .description('★CW3 signal control — 실행 중(mid-phase) walker 에 신호를 graceful 발신(SIGTERM kill 아님). kind=abort(중단·부분결과 반환)|pause(정지)|clear(신호 해제)|peek(현재 신호 조회). walker turn 루프가 다음 turn 폴링·graceful 수신(autopilot.coordinatorControl ON 필요). audit #59 (b) mid-phase 양방향 채널.')
  .option('--reason <r>', '신호 사유(관측·표면화용)')
  .option('--phase <id>', '★신호 대상 페이즈(task:xxxx) — 지정 시 그 페이즈에만 스코프(다른 페이즈 누수 차단). 미지정=global(TTL만·최대 15분 후 만료)')
  .action(async (missionId: string, kind: string, opts: { reason?: string; phase?: string }) => {
    const { sendMissionSignal, peekMissionSignal, clearMissionSignal } = await import('../autopilot/pipeline/mission-signal.js');
    if (kind === 'peek') {
      const s = peekMissionSignal(missionId);
      process.stdout.write(s ? `현재 신호: ${s.kind}${s.reason ? ` · ${s.reason}` : ''}\n` : '신호 없음\n');
      process.exit(0);
    }
    if (kind === 'clear') {
      clearMissionSignal(missionId);
      process.stdout.write(`🧹 신호 클리어: ${missionId}\n`);
      process.exit(0);
    }
    if (kind !== 'abort' && kind !== 'pause') {
      process.stderr.write(`autopilot signal: kind 는 abort|pause|clear|peek (받음: ${kind})\n`);
      process.exit(1);
    }
    const sig = sendMissionSignal(missionId, kind, { ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.phase ? { phaseId: opts.phase } : {}) });
    process.stdout.write(`📡 신호 발신: ${sig.kind}${sig.reason ? ` · ${sig.reason}` : ''}${sig.phaseId ? ` · phase=${sig.phaseId}` : ' · global(TTL 15분)'} → ${missionId}\n   walker 가 다음 turn 에 graceful 수신(autopilot.coordinatorControl ON 필요).\n`);
    process.exit(0);
  });

autopilotCmd
  .command('review <missionId>')
  .description('완료 미션 리뷰 요약 재발송 — 보존된 PR + 자동 비평 요약을 origin(텔레그램)으로 다시 보내고 [🔧 비평 재반영] 버튼 첨부(지적 있을 때). 콘솔에도 출력.')
  .action(async (missionId: string) => {
    const { buildMissionReviewMessage } = await import('../autopilot/mission-lifecycle.js');
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { loadMissionOrigin } = await import('../autopilot/mission-origin.js');
    const { notifyMissionReviewSummary } = await import('../autopilot/mission-notify.js');
    const store = new TaskStore();
    try {
      const { text, hasCritiques, hasMergeable } = buildMissionReviewMessage(missionId, store);
      process.stdout.write(`${text}\n`);
      const origin = loadMissionOrigin(missionId);
      const sent = notifyMissionReviewSummary(origin, missionId, text, { hasCritiques, hasMergeable });
      process.stdout.write(sent !== null ? '📨 텔레그램 origin 으로 재발송됨(반영/재반영 버튼 포함).\n' : '(텔레그램 origin 없음 — 콘솔 출력만)\n');
    } finally { store.close(); }
    process.exit(0);
  });

autopilotCmd
  .command('rereflect <missionId>')
  .description('비평 재반영 — 완료 미션의 자동 비평 지적이 있는 페이즈만 골라 재구현(비평→[REBUILD]·이전 PR close·개선된 새 PR). clean 페이즈 유지. 머지는 HITL.')
  .action(async (missionId: string) => {
    const { rebuildCritiquedPhases } = await import('../autopilot/mission-lifecycle.js');
    const r = rebuildCritiquedPhases(missionId);
    if (r.ok) {
      process.stdout.write(`🔧 비평 재반영: ${r.rebuilt}개 페이즈 재구현 시작\n${r.phases.map((t) => `· ${t}`).join('\n')}\n`);
      process.exit(0);
    }
    process.stderr.write(`autopilot rereflect: ${r.error ?? '실패'}\n`);
    process.exit(1);
  });

autopilotCmd
  .command('merge <missionId>')
  .description('반영(머지) — 완료 미션의 clean PR(자동 비평 지적 없음)을 squash 머지(gh). 비평 FAIL/WARN 페이즈는 머지 안 함(재반영 먼저). 대표 트리거·unattended 아님.')
  .action(async (missionId: string) => {
    const { mergeMissionPhases } = await import('../autopilot/mission-lifecycle.js');
    const r = mergeMissionPhases(missionId);
    if (r.ok) {
      process.stdout.write(`✅ 반영(머지): ${r.merged}개 clean PR 머지${r.skipped ? `·${r.skipped} 실패` : ''}\n${r.prs.map((u) => `· ${u}`).join('\n')}\n`);
      process.exit(0);
    }
    process.stderr.write(`autopilot merge: ${r.error ?? '실패'}\n`);
    process.exit(1);
  });

// ── autopilot 미션 CRUD (관측(ops)과 분리·변경 전용) ──
interface AutopilotOpts { id?: string; status?: string; source?: string; command?: string; cron?: string; prompt?: string; phase?: string; comment?: string; context?: string; title?: string; notify?: boolean; note?: string; pr?: string; reusables?: string; decisions?: string; sub?: string; toStage?: string; n?: string; model?: string; effort?: string; append?: string; kind?: string; full?: boolean; generation?: string; json?: boolean }

async function runAutopilot(action: string, opts: AutopilotOpts): Promise<never> {
  const { dispatchAutopilotMissions } = await import('../autopilot/mission-tool.js');
  const result = await dispatchAutopilotMissions({
    action,
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.cron ? { cron: opts.cron } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.phase ? { phase: opts.phase } : {}),
    ...(opts.comment ? { comment: opts.comment } : {}),
    ...(opts.context ? { context: opts.context } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.notify ? { notify: true } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.pr ? { pr: opts.pr } : {}),
    ...((opts as { arc?: string }).arc ? { arc: (opts as { arc?: string }).arc } : {}),
    ...(opts.reusables ? { reusables: opts.reusables } : {}),
    ...(opts.decisions ? { decisions: opts.decisions } : {}),
    ...(opts.sub ? { sub: opts.sub } : {}),
    ...(opts.toStage ? { stage: opts.toStage } : {}),
    ...(opts.n !== undefined ? { n: opts.n } : {}),
    ...(opts.generation !== undefined ? { generation: opts.generation } : {}),
    // pipeline rerun(P4) 튜닝 인자 — 저장 프롬프트 재실행 시 모델·effort·추가지시·종류(critique|clarify).
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.append ? { append: opts.append } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.full ? { full: true } : {}),
    ...((opts as { tail?: number }).tail ? { tail: (opts as { tail?: number }).tail } : {}),
    // briefing 용 — send(텔레그램 카드 발송)·grounded(현실 관측 on/off). send 는 boolean true 만 통과.
    ...((opts as { send?: boolean }).send === true ? { send: true } : {}),
    ...((opts as { grounded?: boolean }).grounded === false ? { grounded: false } : {}),
  });
  const isErr = !!result && typeof result === 'object' && 'error' in (result as object);
  if (opts.json || isErr) {
    await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
  } else if (action === 'list' && result && typeof result === 'object' && 'missions' in result) {
    const r = result as { missions: Array<{ id: string; goal: string; status: string; source: string; domain?: string | null; mode?: string | null }>; count?: number };
    ui.header(`오토파일럿 미션 (${r.missions.length})`);
    // 컬럼: status | domain(WHAT·골성격) | mode(HOW·에이전트유형·RFC 이후 채움) | source | id
    for (const m of r.missions) console.log(`  ${m.status.padEnd(9)} ${(m.domain ?? '—').padEnd(11)} ${(m.mode ?? '—').padEnd(12)} ${m.source.padEnd(10)} ${m.id}\n            ${m.goal.slice(0, 70)}`);
  } else if (action === 'phases' && result && typeof result === 'object' && 'phases' in result) {
    const r = result as { missionId: string; phases: Array<{ index: number; title: string; status: string }>; note: string };
    ui.header(`미션 페이즈 (${r.phases.length})`);
    for (const p of r.phases) console.log(`  ${String(p.index).padStart(2)}. [${p.status}] ${p.title}`);
    console.log(`  ${r.note}`);
  } else if (action === 'history' && result && typeof result === 'object' && 'history' in result) {
    const r = result as { missionId: string; currentGeneration: number; currentGoal?: string; history: Array<{ generation: number; reason: string; goal?: string; phases: Array<{ title: string; status: string; prUrl?: string }> }>; comprehensive?: Array<{ ts: string; kind: 'edit' | 'decision' | 'split' | 'drift' | 'revision' | 'external'; op: string; summary: string; provenance?: string }>; coldArchived?: boolean; lineageText?: string };
    if (r.coldArchived) console.log('  ❄️  냉동보관 이력(행 purge 후 cold ledger 에서 복원 — self-recall 도달)');
    ui.header(`미션 생애주기 — revision (현재 gen ${r.currentGeneration} · 보관 ${r.history.length}세대)`);
    for (const s of r.history) {
      console.log(`  ── gen ${s.generation} [${s.reason}]${s.goal ? ` · 골: ${s.goal.slice(0, 56)}` : ''}`);
      s.phases.forEach((p, i) => console.log(`     ${i}. [${p.status}] ${p.title.slice(0, 48)}${p.prUrl ? ` · ${p.prUrl}` : ''}`));
    }
    console.log(`  ── 현재 gen ${r.currentGeneration}${r.currentGoal ? ` · 골: ${r.currentGoal.slice(0, 56)}` : ''}`);
    // ★ 종합 히스토리(Track B·대표 2026-07-16 갭수정) — 편집/결정/분할/drift/외부(🔧 PR) 통합.
    //   runAutopilot 가 이 뒤 process.exit 하므로 여기서 렌더(과거 history 커맨드의 post-call 블록은 dead code).
    if (r.comprehensive && r.comprehensive.length) {
      const { formatMissionHistory } = await import('../autopilot/mission-history.js');
      process.stdout.write('\n' + formatMissionHistory(r.missionId, r.comprehensive) + '\n');
    }
    // ★ 5-way lineage(--full·H1) — Historian 통합 타임라인(시간축 교차 뷰). RFC §2a 관측 부족 수복.
    if (r.lineageText) process.stdout.write('\n' + r.lineageText + '\n');
  } else if (action === 'reconcile' && result && typeof result === 'object' && 'phases' in result) {
    const r = result as { missionId: string; phaseCount: number; drifts: number; note: string; phases: Array<{ phase: string; recordedStatus: string; recordedPr: number | null; perceived: string; drift: boolean; note: string }> };
    ui.header(`미션 self-perception — drift ${r.drifts}/${r.phaseCount} (기록 vs 현실)`);
    for (const p of r.phases) {
      console.log(`  ${p.drift ? '⚠️ DRIFT' : '  ✓ ok '} [${p.recordedStatus}→${p.perceived}]${p.recordedPr ? ` PR#${p.recordedPr}` : ''} ${p.phase.slice(0, 34)}`);
      console.log(`           ${p.note.slice(0, 96)}`);
    }
    console.log(`  ${r.note}`);
  } else if (action === 'revise-suggest' && result && typeof result === 'object' && 'reviseKind' in result) {
    const r = result as { missionId: string; shouldRevise: boolean; reviseKind: string; reviseKindLabel: string; comment: string; confidence: string; rationale: string; source: string; observed: { generation: number; priorRevisions: number; driftCount: number; hasFailedPhases: boolean }; note: string };
    ui.header(`미션 자율 revise 추천 — ${r.shouldRevise ? `${r.reviseKindLabel} (${r.confidence})` : '정정 불필요'}`);
    console.log(`  관측: gen ${r.observed.generation} · 이전정정 ${r.observed.priorRevisions}회 · drift ${r.observed.driftCount} · 실패페이즈 ${r.observed.hasFailedPhases ? '있음' : '없음'} · source=${r.source}`);
    if (r.shouldRevise) {
      console.log(`\n  정정 지시(comment):\n    ${r.comment}`);
      console.log(`\n  근거: ${r.rationale}`);
      console.log(`\n  집행: elanous autopilot revise ${r.missionId} "${r.comment.slice(0, 40)}..."  (또는 텔레그램 원탭 승인)`);
    } else {
      console.log(`  ${r.rationale}`);
    }
  } else if ((action === 'prepare-log' || action === 'log') && result && typeof result === 'object' && 'lines' in result) {
    const r = result as { missionId: string; lines: string[]; note: string };
    ui.header(action === 'prepare-log' ? '재분해 진행 로그 (단계 전이)' : '미션 실행 로그');
    for (const l of r.lines) console.log(l);
    console.log(`  ${r.note}`);
  } else if (action === 'pipeline' && result && typeof result === 'object' && 'exists' in result) {
    const r = result as {
      missionId: string; exists: boolean; note?: string; frameCount?: number;
      current?: string | null; currentStatus?: string | null; statuses?: Record<string, string>;
      stuck?: string[]; superseded?: string[]; incomplete?: string[]; healable?: boolean; recommendation?: string;
      frames?: Array<{ seq: number; stage: string; status: string; op: string; at: string; supersededBy?: number; hasLlm: boolean }>;
    };
    const rr = result as { mode?: string; generation?: number; replayed?: string[]; skipped?: string[]; stoppedAt?: string; resultStages?: string[]; decisions?: Record<string, unknown>; note?: string };
    if (!r.exists) { console.log(r.note ?? '파이프라인 프레임 없음'); }
    else if (rr.mode === 'replay') {
      // replay — 저장 출력 재생(결정론·집행 0)
      ui.header(`파이프라인 리플레이 — ${rr.replayed?.length ?? 0}단계 재생(LLM 0)${rr.generation !== undefined ? ` · gen ${rr.generation}` : ''}`);
      console.log(`  재생: ${(rr.replayed ?? []).join(' → ') || '-'}`);
      if (rr.skipped?.length) console.log(`  skip: ${rr.skipped.join(',')} (superseded/failed)`);
      console.log(`  재구성 결과: ${(rr.resultStages ?? []).join(',') || '-'}${rr.stoppedAt ? ` · ${rr.stoppedAt} 까지` : ''}`);
      console.log(`  decisions: ${JSON.stringify(rr.decisions ?? {})}`);
    }
    else if (rr.mode === 'rewind' || rr.mode === 'goto') {
      // rewind/goto — 되감기(셀프힐·이후 supersede)
      const g = result as { targetStage?: string; targetSeq?: number; superseded?: number; note?: string };
      ui.header(`파이프라인 ${rr.mode === 'rewind' ? '되감기' : 'goto'} — → ${g.targetStage ?? '(?)'}`);
      console.log(`  타겟: ${g.targetStage} (seq ${g.targetSeq}) · 이후 ${g.superseded ?? 0}프레임 무효화(superseded·MESI I)`);
      console.log(`  ${g.note ?? ''}`);
      console.log(`  다음: pipeline status 로 재확인 · 재실행은 rerun(P4)`);
    }
    else if (rr.mode === 'rerun') {
      // rerun(P4) — 저장 프롬프트 재실행(모델·effort·추가지시 튜닝) · old vs new 비교
      const rp = result as unknown as { kind?: string; phase?: string; model?: string; effort?: string; appended?: boolean;
        oldVerdict?: string; newVerdict?: string; changed?: boolean; oldSeverity?: string; newSeverity?: string;
        newReason?: string; newConcerns?: string[]; newSuggestion?: string; oldResponse?: string; newResponse?: string; note?: string };
      ui.header(`파이프라인 rerun(P4) — ${rp.kind} '${rp.phase ?? ''}' · ${rp.model} effort ${rp.effort}${rp.appended ? ' ·추가지시' : ''}`);
      if (rp.kind === 'critique') {
        console.log(`  verdict: ${rp.oldVerdict} → ${rp.newVerdict}${rp.changed ? '  ★변화' : '  (동일)'} · severity ${rp.oldSeverity}→${rp.newSeverity}`);
        if (rp.newReason) console.log(`  새 근거: ${rp.newReason}`);
        if (rp.newConcerns?.length) console.log(`  관심사: ${rp.newConcerns.join(' + ')}`);
        if (rp.newSuggestion) console.log(`  제안: ${rp.newSuggestion}`);
      }
      console.log(`\n  ── old 응답(앞 800) ──\n${(rp.oldResponse ?? '').slice(0, 800)}`);
      console.log(`\n  ── new 응답(앞 1500) ──\n${(rp.newResponse ?? '').slice(0, 1500)}`);
      console.log(`\n  ${rp.note ?? ''}`);
    }
    else if (rr.mode === 'critique') {
      // critique 트레이스 목록 — sol 입출력·오탐 진단
      const ct = result as unknown as { count: number; round?: string; model?: string; traces: Array<{ phaseId: string; title: string; verdict: string; existsCount: number; total: number; dropped: number; groundConfidence: string; model: string; promptChars: number; responseChars: number }> };
      ui.header(`critique 트레이스 — ${ct.count} 페이즈 · 모델 ${ct.model ?? '?'} (최신 라운드·오탐 진단)`);
      for (const t of ct.traces) {
        const flag = t.verdict === 'ungrounded' && t.existsCount > 0 ? '  ⚠️[실존인데ungrounded]' : '';
        console.log(`  [${t.verdict.padEnd(15)}] 실존 ${t.existsCount}/${t.total}${t.dropped ? ` drop${t.dropped}` : ''} · gr ${t.groundConfidence} · ${t.model} ${t.promptChars}→${t.responseChars}자 · ${t.title.slice(0, 30)}${flag}`);
      }
      console.log(`\n  ⚠️ = LLM 이 [실존] 실측을 받고도 ungrounded(LLM 층 오탐). 원문: --sub critique --phase <제목일부>`);
    }
    else if (rr.mode === 'critique-detail') {
      // critique 원문 — sol 이 받은 실존맵 + 프롬프트 + 응답(왜 무시했나)
      const d = result as unknown as { phase?: { title?: string; verdict?: string; reuseMap?: string }; sidecar?: { prompt: string; response: string } };
      ui.header(`critique 원문 — ${d.phase?.title ?? ''} [${d.phase?.verdict ?? ''}]`);
      console.log(`\n  ── sol 이 받은 실존맵(실측) ──\n${(d.phase?.reuseMap || '(없음)').split('\n').map((l) => '    ' + l).join('\n')}`);
      if (d.sidecar) {
        console.log(`\n  ── sol 프롬프트(${d.sidecar.prompt.length}자·앞 3000) ──\n${d.sidecar.prompt.slice(0, 3000)}`);
        console.log(`\n  ── sol 응답 원문(파싱 前) ──\n${d.sidecar.response.slice(0, 2000)}`);
      } else console.log('\n  (원문 sidecar 없음)');
    }
    else if (rr.mode === 'clarify') {
      // clarify 트레이스 목록 — sol 입출력·비결정성 진단(왜 범위 0개인가)
      const cl = result as unknown as { count: number; traces: Array<{ phase: string; count: number; kinds: string[]; heavy: boolean; fallback: boolean; promptChars: number; responseChars: number }> };
      ui.header(`clarify 트레이스 — ${cl.count} 판정 (sol 입출력·비결정성 진단)`);
      for (const t of cl.traces) {
        const flag = t.count === 0 ? '  (clear·범위 명확)' : t.fallback ? '  ⚠️[fallback 강제·A]' : '';
        console.log(`  [${t.phase.padEnd(6)}] 질문 ${t.count} (${t.kinds.join(',') || '-'}) · heavy ${t.heavy} · sol ${t.promptChars}→${t.responseChars}자${flag}`);
      }
      console.log(`\n  원문(왜 이 판정): --sub clarify --phase scope|arc`);
    }
    else if (rr.mode === 'clarify-detail') {
      // clarify 원문 — sol 이 범위/아크를 어떻게 판정했나(비결정성 진단)
      const cd = result as unknown as { clarifyPhase?: { phase?: string; count?: number; kinds?: string[] }; sidecar?: { prompt: string; response: string } };
      ui.header(`clarify 원문 — ${cd.clarifyPhase?.phase ?? ''} (질문 ${cd.clarifyPhase?.count ?? 0})`);
      if (cd.sidecar) {
        console.log(`\n  ── sol 프롬프트(${cd.sidecar.prompt.length}자·앞 3000) ──\n${cd.sidecar.prompt.slice(0, 3000)}`);
        console.log(`\n  ── sol 응답 원문(파싱 前) ──\n${cd.sidecar.response.slice(0, 2000)}`);
      } else console.log('\n  (원문 sidecar 없음)');
    }
    else if (rr.mode === 'exec-rewind') {
      // exec-rewind/exec-goto — 실행 프레임 되감기(P5·셀프힐·이후 supersededBy)
      const er = result as unknown as { sub?: string; targetPhase?: string; targetSeq?: number; superseded?: number; note?: string };
      ui.header(`실행 되감기 — ${er.sub} → ${er.targetPhase ?? '(?)'}`);
      console.log(`  타겟: ${er.targetPhase} (seq ${er.targetSeq}) · 이후 ${er.superseded ?? 0}프레임 무효화(supersededBy)`);
      console.log(`  ${er.note ?? ''}`);
      console.log(`  다음: pipeline --sub thread 로 재확인 · 재실행은 미션 재개(resume)`);
    }
    else if (rr.mode === 'coordinator') {
      // coordinator — P0~P2 통합 단일 관측(thread 요약 + 채널 version + Progress Ledger)
      const co = result as unknown as {
        summary?: { buildFrames: number; execFrames: number; transitioned: boolean; orphanPendingWrites: number; current?: { layer: string; label: string; status: string } | null; channelVersions?: Record<string, number> };
        ledger?: { satisfied: boolean; progressBeingMade: boolean; inLoop: boolean; stalled: boolean; stallCount: number; recommendation: string; rationale: string };
      };
      const s = co.summary; const lg = co.ledger;
      ui.header(`조율자 단일 관측 — build ${s?.buildFrames ?? 0} · exec ${s?.execFrames ?? 0}${s?.transitioned ? ' · 실행✓' : ''}`);
      if (s?.current) console.log(`  현재 위치: [${s.current.layer}] ${s.current.label} [${s.current.status}]`);
      if (lg) {
        const icon = lg.recommendation === 'done' ? '✅' : lg.recommendation === 'replan' ? '♻️' : lg.recommendation === 'escalate' ? '🚨' : '▶️';
        console.log(`\n  ${icon} Progress Ledger → ${lg.recommendation.toUpperCase()}`);
        console.log(`     satisfied=${lg.satisfied} · progress=${lg.progressBeingMade} · inLoop=${lg.inLoop} · stall=${lg.stallCount}`);
        console.log(`     ${lg.rationale}`);
      }
      if (s?.orphanPendingWrites) console.log(`\n  ♻️  미종결 pending-write(고아 후보): ${s.orphanPendingWrites}건`);
      const cv = s?.channelVersions ?? {};
      if (Object.keys(cv).length) console.log(`  📊 채널 version: ${Object.entries(cv).map(([c, v]) => `${c}=${v}`).join(' · ')}`);
      console.log(`\n  전과정 단일 관측(P0 thread+channel_versions · P2 ledger) — mission.coordinator.* 로그.`);
    }
    else if (rr.mode === 'thread') {
      // thread — build+exec 통합 단일 thread(조율자 전컨텍스트·단일관측·P0 조각2)
      const th = result as unknown as {
        summary?: { buildFrames: number; execFrames: number; transitioned: boolean; orphanPendingWrites: number; current?: { layer: string; label: string; status: string } | null; channelVersions?: Record<string, number> };
        thread?: Array<{ layer: string; seq: number; at: string; label: string; op: string; status: string; supersededBy?: number; artifacts?: string[]; arcName?: string; arcSeq?: string }>;
      };
      const s = th.summary;
      ui.header(`미션 thread(통합) — build ${s?.buildFrames ?? 0} · exec ${s?.execFrames ?? 0} 프레임${s?.transitioned ? ' · 실행 전이✓' : ''}`);
      if (s?.current) console.log(`  현재: [${s.current.layer}] ${s.current.label} [${s.current.status}]`);
      if (s?.orphanPendingWrites) console.log(`  ♻️  미종결 pending-write(고아 후보): ${s.orphanPendingWrites}건`);
      const cv = s?.channelVersions ?? {};
      if (Object.keys(cv).length) console.log(`  📊 채널 version: ${Object.entries(cv).map(([c, v]) => `${c}=${v}`).join(' · ')}`);
      console.log('');
      for (const e of th.thread ?? []) {
        const tag = e.layer === 'build' ? '🏗 build' : '⚙ exec ';
        const arc = e.arcName ? ` 〔${e.arcSeq ?? ''} ${e.arcName}〕` : '';
        const art = e.artifacts?.length ? ` 📎${e.artifacts.length}` : '';
        const sup = e.supersededBy !== undefined ? ` ⟲→${e.supersededBy}` : '';
        console.log(`  ${tag} #${String(e.seq).padStart(2)} [${e.status.padEnd(9)}] ${e.label.slice(0, 28).padEnd(28)} ${e.op}${arc}${art}${sup}`);
      }
      console.log(`\n  단일 thread(checkpoint_ns build·exec) — 조율자 전컨텍스트/단일관측(RFC ①②).`);
    }
    else if (r.frames) {
      // stack — 프레임 목록(관측)
      ui.header(`파이프라인 스택 — ${r.frameCount} 프레임`);
      for (const f of r.frames) {
        console.log(`  #${String(f.seq).padStart(2)} [${f.status.padEnd(10)}] ${f.stage.padEnd(11)} ${f.op}${f.supersededBy !== undefined ? ` ⟲superseded→${f.supersededBy}` : ''}${f.hasLlm ? ' 📎llm' : ''}`);
      }
    } else {
      // status — 단계 ENUM 현재위치 + 자기인지 진단
      ui.header(`파이프라인 STATUS — 현재: ${r.current ?? '(없음)'} [${r.currentStatus ?? '-'}]`);
      for (const [stage, status] of Object.entries(r.statuses ?? {})) console.log(`  ${stage.padEnd(12)} ${status}`);
      console.log(`\n  자기인지 — stuck=${(r.stuck ?? []).join(',') || '-'} · superseded=${(r.superseded ?? []).join(',') || '-'} · 미완=${(r.incomplete ?? []).join(',') || '-'}`);
      console.log(`  ${r.healable ? '🔧 셀프힐 가능' : '✓ 정상'} — ${r.recommendation ?? ''}`);
    }
  } else {
    await writeStdoutJson(JSON.stringify(result, null, 2) + '\n');
  }
  process.exit(isErr ? 1 : 0);
}

autopilotCmd.command('list').description('미션 목록(+헬스 롤업)').option('--status <s>', 'proposed|armed|running|done|failed|disarmed').option('--source <s>', 'human-intent|discovery|repo-watch|manual').option('--json')
  .action((o: AutopilotOpts) => runAutopilot('list', o));
autopilotCmd.command('threads').description('★조율자 상주 thread authority(UR4a) — 데몬이 인지하는 살아있는 미션 thread 뷰(disk-discovery·READ-ONLY). 활성도 + 중앙 State(progress/cursor) 요약. Option B 상주 조율자의 인지 관문.').option('--active', '활성(기본 60분 내 갱신) thread 만').option('--within <min>', '활성 판정 시간창(분·기본 60)').option('--json')
  .action((o: AutopilotOpts) => runAutopilot('threads', o));
autopilotCmd.command('trace <id>').description('미션 계보 트리(파생 크론/태스크/자율행동 live 상태)').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('trace', { ...o, id }));
autopilotCmd.command('resources <id>').aliases(['res']).description('★미션 자원 원장 — 미션이 만든 살아있는 자원(태스크·크론)을 미션ID로 역추적·링크. PR은 부가정보(관리 아님). 삭제/수정은 elanous schedule/task CRUD로 라우팅.').option('--json')
  .action(async (id: string, o: { json?: boolean }) => {
    const { missionResources } = await import('../autopilot/mission-resources.js');
    const led = missionResources(id);
    if (o.json) { await writeStdoutJson(JSON.stringify(led, null, 2) + '\n'); return; }
    ui.header(`미션 자원 원장 — ${id.slice(0, 52)}`);
    console.log(`\n▸ 태스크 ${led.tasks.length}  (CRUD: elanous autopilot / task)`);
    for (const t of led.tasks) console.log(`  [${t.status}] ${t.title.slice(0, 52)}${t.prUrl ? `  · ${t.prUrl.replace(/.*\/pull\//, 'PR#')}` : ''}`);
    console.log(`\n▸ 크론 ${led.crons.length}  (CRUD: elanous schedule update/release <id>)`);
    for (const c of led.crons) console.log(`  ${c.enabled ? '●' : '○'} ${c.id} · ${c.cron ?? '-'} · ${(c.command ?? '').replace(/^cd .*&& /, '').slice(0, 44)}`);
    console.log(`\n▸ 루프 에이전트 ${led.loopAgents.length}  (반복 실행 주체 · CRUD: EnterAutoMode off · 크론 release)`);
    for (const l of led.loopAgents) console.log(`  ◆ ${l.loopKind}/${l.lifecycle} · ${l.name.slice(0, 40)}${l.ttlMin ? ` (TTL ${l.ttlMin}m)` : ''}${l.scheduleIds.length ? ` · 크론 ${l.scheduleIds.join(',')}` : ''}`);
    if (led.prRefs.length) { console.log(`\n▸ PR (부가정보·provenance)`); for (const p of led.prRefs) console.log(`  ${p}`); }
    if (!led.tasks.length && !led.crons.length && !led.loopAgents.length) console.log('  (이 미션의 살아있는 자원 없음)');
  });
autopilotCmd.command('approve <id>').description('★HITL 승인·실행 — 텔레그램/PWA 승인 버튼의 CLI 파리티. task 미션=backlog 페이즈 스테이징+run-mission 실집행 · scheduler 미션=반복 예약 배선. 미션 running').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('approve', { ...o, id }));
autopilotCmd.command('arm <id>').description('승인 — materialize spec 저장(실행 안 함·HITL)').option('--command <c>').option('--cron <expr>').option('--prompt <p>').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('arm', { ...o, id }));
autopilotCmd.command('materialize <id>').description('구체화 — 실제 cron 생성(command 명시 필수·HITL)').option('--command <c>').option('--cron <expr>').option('--prompt <p>').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('materialize', { ...o, id }));
autopilotCmd.command('cancel <id>').description('미션 종료(파생 잡 release)').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('cancel', { ...o, id }));
autopilotCmd.command('history <id>').description('미션 생애주기 — revision 타임라인 + 종합 편집/결정/분할/외부(🔧 PR) 히스토리(Track B)').option('--full', '5-way lineage 통합 타임라인(세대아카이브·워킹메모리·빌드/실행프레임·캐시)').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('history', { ...o, id }));
autopilotCmd.command('pipeline <id>').description('★파이프라인 프레임 상태머신·시간여행·critique관측 — 빌드 단계(ENUM) 관측/자기인지/되감기를 미션ID로. sub=status(기본)|stack|thread(build+exec 통합 단일 thread·조율자 전컨텍스트)|replay(재생·LLM0)|rewind(N단계 전·--n)|goto(그 단계로·--to-stage)|critique(sol 입출력·오탐 진단·--phase 로 원문)|rerun(P4·저장 프롬프트 재실행·--model/--effort/--append 튜닝). rewind/goto=셀프힐.').option('--sub <s>', 'status(기본)|stack|thread(build+exec 통합)|coordinator(전과정 단일관측+Progress Ledger)|state(중앙 MissionState read-through 조립·통합런타임 UR0)|replay|rewind|goto|build-rerun(P4·그 단계부터 LLM 재구동·--to-stage)|build-fresh(진짜 처음부터·캐시무효+clarify 재발동)|exec-rewind|exec-goto(실행 프레임 되감기·P5)|critique|clarify|rerun').option('--persist', 'state: 조립 snapshot 을 <id>.state.json 으로 저장(체크포인터 seed)').option('--to-stage <s>', 'replay/goto 대상 단계').option('--n <k>', 'rewind 되감을 단계 수(기본 1)').option('--generation <g>', 'replay/rewind/goto 대상 rerun 세대(기본=최신·H6 세대 인지)').option('--phase <p>', 'critique/rerun 페이즈(제목 일부) 또는 clarify 단계(scope|arc)').option('--kind <k>', 'rerun 종류 critique(기본)|clarify').option('--model <m>', 'rerun 재실행 모델(기본=저장 모델)').option('--effort <e>', 'rerun reasoning effort low|medium|high').option('--append <t>', 'rerun 프롬프트 끝에 덧붙일 추가 지시(튜닝)').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('pipeline', { ...o, id }));
  // ★ 종합 히스토리(Track B)는 runAutopilot 의 history 렌더러에서 exit 전에 출력(과거 여기 post-call 블록은
  //   runAutopilot 의 process.exit 로 dead code 였음 — 대표 2026-07-16 갭수정으로 렌더러 안으로 이동).
autopilotCmd.command('briefing <id>').aliases(['brief']).description('★미션 최종 브리핑(실집행 전 종합 점검) — 골 진화(최초/중간/최종)+여정(편집·분할·결정)+산출물 grounded 점검(PR merge·main deliverable 실존)+정착 상태를 종합. --send 면 텔레그램 카드[승인/재조치/보류] 발송').option('--send', '텔레그램 브리핑 카드 발송(발신 origin)').option('--no-grounded', '현실 관측(reconcile·gh/git) 생략·title 휴리스틱만(빠름)').option('--json')
  .action(async (id: string, o: { send?: boolean; grounded?: boolean; json?: boolean }) => {
    if (o.send) { await runAutopilot('briefing', { id, send: true, ...(o.grounded === false ? { grounded: false } : {}) } as AutopilotOpts); return; }
    const { buildLiveMissionBriefing } = await import('../autopilot/mission-briefing-live.js');
    const { formatBriefingSummary, formatBriefingReport } = await import('../autopilot/mission-briefing.js');
    const b = buildLiveMissionBriefing(id, { grounded: o.grounded !== false });
    if (o.json) { await writeStdoutJson(JSON.stringify(b, null, 2) + '\n'); return; }
    ui.header(`미션 최종 브리핑 — ${id.slice(0, 52)}`);
    process.stdout.write('\n' + formatBriefingSummary(b) + '\n\n' + formatBriefingReport(b) + '\n');
  });
autopilotCmd.command('landing <id>').aliases(['land']).description('★랜딩 빠른 스캔 — 기록 PR merge 상태만 1회 gh 배치(git 고고학 없음·수초). 완주/arming 전 "미머지 있나?" 즉답. ⛔ open PR=확정 미머지(완주 차단) · ⚠️ closed=대체 랜딩 확인 권장(→ briefing grounded)').option('--json')
  .action(async (id: string, o: { json?: boolean }) => {
    const { scanMissionLanding, formatLandingScanReport } = await import('../autopilot/mission-landing-scan.js');
    const scan = scanMissionLanding(id);
    if (o.json) { await writeStdoutJson(JSON.stringify(scan, null, 2) + '\n'); return; }
    ui.header(`미션 랜딩 스캔 — ${id.slice(0, 52)}`);
    process.stdout.write('\n' + formatLandingScanReport(scan) + '\n');
    if (scan.blocking > 0) process.exitCode = 2; // 미머지 있으면 non-zero(완주 게이트 스크립트용).
  });
autopilotCmd.command('reconcile <id>').description('★self-perception — 각 페이즈의 기록(상태·PR) vs 현실(git/PR/main)을 미션이 스스로 관측해 drift 감지·자기 형상 재인지(self-memory 에 provenance=reconcile self-write)').option('--notify', '재인지 결과를 텔레그램(발신 origin)으로 다시 통지').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('reconcile', { ...o, id }));
autopilotCmd.command('inject <id>').description('★외부 가이드/수습 주입(방향 A) — 재사용맵·교정·페이즈 상태(done)·머지PR을 미션에 정식 주입(provenance=external·self-memory 안 해침)')
  .option('--phase <p>', '대상 페이즈 index 또는 task id(선택)').option('--status <s>', '페이즈 새 상태(예: done)').option('--pr <n>', '외부 머지 PR 번호(링크)').option('--note <t>', '가이드/수습 내용').option('--reusables <csv>', '재사용 경계(; 구분)').option('--decisions <csv>', '결정(; 구분)').option('--json')
  .option('--arc <name>', '★외부 아크 수습(대표 2026-07-16) — 외부가 아크 통합을 미션 밖(main 머지)에서 완성했을 때 그 아크(arcId·name·index)를 done+verified 로 정식 처리(provenance=external·후속 배리어 해제). --note 로 근거')
  .action((id: string, o: AutopilotOpts) => runAutopilot('inject', { ...o, id }));
autopilotCmd.command('check <id> <phase>').description('★HITL 확인 패스 — 카나리 등 사람이 도착/결과를 눈으로 확인해야 하는 페이즈를 done 처리(에이전트 검증 불가 항목)').option('--json')
  .action((id: string, phase: string, o: AutopilotOpts) => runAutopilot('check', { ...o, id, phase }));
autopilotCmd.command('escalate <id> <phase>').description('★시스템 셀프힐링 — 진단이 escalate 권장한 실패 페이즈(R2 시스템 결함 의심)를 R3 Opus 룩백 후 system-repair 수리 미션으로 스폰(Opus 강제·분해→HITL). merge+데몬 재시작은 HITL').option('--json')
  .action((id: string, phase: string, o: AutopilotOpts) => runAutopilot('escalate', { ...o, id, phase }));
autopilotCmd.command('prepare-log <id>').description('★재분해 진행 관측 — se-mission-prepare 단계 전이(준비→조사→grounding→중복체크→분해)를 tail 로 본다("ING만" 해소)').option('--tail <n>', '마지막 N줄(기본 40)').option('--json')
  .action((id: string, o: AutopilotOpts & { tail?: string }) => runAutopilot('prepare-log', { ...o, id, ...(o.tail ? { tail: Number(o.tail) } : {}) }));
autopilotCmd.command('decompose-crash [id]').description('★분해 실패 근본조사 — decompose_crash.log(code·validationErrors·rawText 원문·컨텍스트) 조회. id 지정 시 해당 미션만. elanous logs(요약) 너머 전문 진단(스키마 위반 정확한 필드).').option('--limit <n>', '최근 N건(기본 3)').option('--json')
  .action(async (id: string | undefined, o: { limit?: string; json?: boolean }) => {
    const { readDecomposeCrashLog, formatCrashEntry } = await import('../autopilot/decompose-crash-log.js');
    const entries = readDecomposeCrashLog({ ...(id ? { missionId: id } : {}), limit: o.limit ? Number(o.limit) : 3 });
    if (o.json) { await writeStdoutJson(JSON.stringify(entries, null, 2) + '\n'); return; }
    if (!entries.length) { console.log(`분해 크래시 기록 없음${id ? ` (미션 ${id})` : ''}`); return; }
    console.log(entries.map(formatCrashEntry).join('\n\n'));
  });
autopilotCmd.command('decompose-stream <id>').description('★분해 스트리밍 실시간 관측 — decompose(sol 리즈닝) 출력을 미션별 임시 파일에서 조회. 분해 중에도 "지금 뭘 쓰는지"를 본다(블랙박스 해소). --follow 로 실시간 tail.').option('--tail <n>', '마지막 N자(기본 전체)').option('-f, --follow', '실시간 tail(2초 폴링·Ctrl-C 종료)')
  .action(async (id: string, o: { tail?: string; follow?: boolean }) => {
    const { readDecomposeStream, decomposeStreamPath } = await import('../autopilot/mission-decompose-stream.js');
    const tailChars = o.tail ? Number(o.tail) : undefined;
    const render = () => { const r = readDecomposeStream(id, tailChars ? { tailChars } : {}); return r.exists ? `${r.content}\n[${r.chars}자 · ${r.mtime}]` : `분해 스트림 없음 (${decomposeStreamPath(id)})`; };
    if (!o.follow) { console.log(render()); return; }
    let prev = ''; console.error('실시간 tail (Ctrl-C 종료)…');
    for (;;) { const cur = render(); if (cur !== prev) { console.clear(); console.log(cur); prev = cur; } await new Promise((r) => setTimeout(r, 2000)); }
  });
autopilotCmd.command('promote <id>').description('★테스트→운영 캐스케이드(ISO 상향) — 격리 테스트에서 셋업/분해한 미션+플랜(+태스크)을 운영 스토어로 이관. proposed 로 착지(arm/materialize 는 운영 HITL). origin(notify)/이력/cron 스트립·config promote 동형. dry-run 기본')
  .option('--from <dir>', '소스 테스트 state 루트(기본 <repo>/.elanous-test)').option('--repo <path>', '레포 루트 override').option('--with-tasks', '파생 태스크도 이관').option('--yes', '적용(기본 dry-run)')
  .action(async (id: string, o: { from?: string; repo?: string; withTasks?: boolean; yes?: boolean }) => {
    const { runMissionPromote } = await import('./mission-promote-cli.js');
    process.exit(runMissionPromote(id, o));
  });
autopilotCmd.command('freshness').description('★신선도 재게이트(2차 안전망) — 현 브랜치 base(또는 --base) 산출 파일이 origin/main 대비 stale 한지 재검증. 거리>0 자체는 stale 아님(파일 겹침 기준·sub8 교훈). fresh=통과·stale=rebase+rebuild 필요')
  .option('--base <sha>', 'base SHA(미지정=merge-base HEAD origin/main)')
  .option('--files <csv>', '검사할 파일(쉼표·미지정=base..HEAD 변경 파일)')
  .option('--no-fetch', 'origin main fetch 생략(기본은 fetch 선행·stale ref 방지)')
  .action(async (o: { base?: string; files?: string; fetch?: boolean }) => {
    const { regateCurrentBranch } = await import('../autopilot/freshness-regate.js');
    const files = typeof o.files === 'string' && o.files.trim() ? o.files.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const v = regateCurrentBranch({ ...(o.base ? { baseSha: o.base } : {}), ...(files ? { phaseFiles: files } : {}), fetchFirst: o.fetch !== false });
    await writeStdoutJson(JSON.stringify({ fresh: v.fresh, baseSha: v.baseSha.slice(0, 10), mainSha: v.mainSha.slice(0, 10), distance: v.distance, staleFiles: v.staleFiles, reason: v.reason }, null, 2) + '\n');
    if (!v.fresh) process.exitCode = 2; // 스크립트 게이트용(stale 이면 non-zero).
  });
autopilotCmd.command('restart-daemon').description('★시스템 셀프힐 — 수리 merge 후 환경별 데몬 재시작(reboot-adjacent). 기본 dry-run(계획만)·--execute 로 실제 실행(HITL·operator 승인)')
  .option('--env <e>', 'production|test (미지정=자동 감지)')
  .option('--execute', '실제 재시작(HITL·operator 가 직접 실행=승인). 미지정=dry-run 계획만')
  .option('--force', '교차오염 가드 우회(요청 env != 감지 env 강제·명시적일 때만)')
  .action(async (o: { env?: string; execute?: boolean; force?: boolean }) => {
    const { restartDaemon } = await import('../autopilot/daemon-control.js');
    const env = o.env === 'test' ? 'test' as const : o.env === 'production' ? 'production' as const : undefined;
    // operator 가 --execute 를 직접 침 = HITL 승인(authorized). config 오염 사건 교훈: 자율 실행 아님.
    const r = await restartDaemon({ ...(env ? { env } : {}), execute: !!o.execute, authorized: !!o.execute, forceEnvMismatch: !!o.force });
    await writeStdoutJson(JSON.stringify({ env: r.plan.env, command: r.plan.command.join(' '), description: r.plan.description, executed: r.executed, ok: r.ok, detectedEnv: r.detectedEnv, ...(r.reason ? { reason: r.reason } : {}) }, null, 2) + '\n');
  });
autopilotCmd.command('add-phase <id> <title...>').description('안착 미션에 페이즈 추가(revision 스냅샷·backlog 스택)').option('--prompt <p>').option('--json')
  .action((id: string, title: string[], o: AutopilotOpts) => runAutopilot('add-phase', { ...o, id, title: title.join(' ') }));
autopilotCmd.command('pause <id>').description('미션 일시정지 — 다음 페이즈 전 중단(상태 보존·캐스케이드 컨트롤)').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('pause', { ...o, id }));
autopilotCmd.command('resume <id>').description('미션 재개 — paused 해제 + 재실행(남은 페이즈 집행)').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('resume', { ...o, id }));
// ★ 시스템 수리 미션 opt-in(대표 2026-07-13) — 대표가 명시 등재한 미션만 IMMUTABLE_CORE
//   (매매/arming/safety/재부팅) 수정 예외(worktree·PR 까지 · merge 는 여전히 HITL). fail-closed.
autopilotCmd.command('system-repair <action> [id]')
  .description('시스템 수리 미션 예외 — IMMUTABLE_CORE 수정 허용 등재(merge HITL). authorize|revoke|list')
  .action(async (action: string, id: string | undefined) => {
    const sr = await import('../autopilot/system-repair.js');
    if (action === 'list') { const l = sr.listSystemRepairAuthorized(); console.log(l.length ? l.join('\n') : '(등재 없음)'); return; }
    if (!id) { console.error('id 필요: autopilot system-repair authorize|revoke <missionId>'); process.exit(1); }
    if (action === 'authorize') { sr.authorizeSystemRepair(id); console.log(`✅ 시스템 수리 예외 등재: ${id}\n   IMMUTABLE_CORE 수정 허용(worktree·PR). merge 는 여전히 HITL(대표 확인).`); }
    else if (action === 'revoke') { sr.revokeSystemRepair(id); console.log(`🔒 시스템 수리 예외 해제: ${id}`); }
    else { console.error('action: authorize | revoke | list'); process.exit(1); }
  });
// ★ 페이즈 레벨 읽기/힐(P2 · 2026-07-13) — 텔레그램 버튼 전용이던 3층 탈출구를 CLI 에도 개방
//   (외부 opus/codex 가 진단[ops mission] 후 권장 힐을 실행하는 경로). 동일 dispatch 단일 창구.
autopilotCmd.command('phases <id>').description('멀티페이즈 플랜 목록(index·status — trim/defer/rebuild/split/skip 대상 확인)').option('--json')
  .action((id: string, o: AutopilotOpts) => runAutopilot('phases', { ...o, id }));
autopilotCmd.command('rebuild <id> <phase>').description('특정 페이즈부터 재구현(후속 리셋·앞 성공 보존)').option('--json')
  .action((id: string, phase: string, o: AutopilotOpts) => runAutopilot('rebuild', { ...o, id, phase }));
autopilotCmd.command('split <id> <phase>').description('실패 페이즈를 단일책임 서브페이즈로 국소 재분해(과대 페이즈 탈출구)').option('--json')
  .action((id: string, phase: string, o: AutopilotOpts) => runAutopilot('split', { ...o, id, phase }));
autopilotCmd.command('skip <id> <phase>').description('페이즈 건너뛰기(기능 제외·후속 언블록·부분 완주)').option('--json')
  .action((id: string, phase: string, o: AutopilotOpts) => runAutopilot('skip', { ...o, id, phase }));
autopilotCmd.command('revise <id> [comment...]').description('골 정정·재분해(실패 컨텍스트 자동 포함 — 예: "범위축소: X 제외"). --pr 로 PR 내용·연관 RFC 를 자동으로 읽어 재분해(comment 생략 가능)').option('--json')
  .option('--pr <n>', 'PR 번호(들·쉼표구분·예 "4306,4307") — 시스템이 스스로 PR 제목·본문·변경파일·연관 RFC/PLAN 을 읽어 정정 맥락에 합류')
  .action((id: string, comment: string[], o: AutopilotOpts) => runAutopilot('revise', { ...o, id, ...(comment.length ? { comment: comment.join(' ') } : {}) }));
autopilotCmd.command('revise-suggest <id> [context...]').description('★미션 자율 revise 추천 — 관측+맥락으로 정정 comment 를 LLM 자동 생성(READ-ONLY·트리거 안 함). --pr 로 PR 자동 인지').option('--json')
  .option('--pr <n>', 'PR 번호(들·쉼표구분) — PR 내용·연관 RFC 를 자동으로 읽어 정정 맥락에 합류(PR 던지면 알아서 분해 추천)')
  .action((id: string, context: string[], o: AutopilotOpts) => runAutopilot('revise-suggest', { ...o, id, ...(context.length ? { context: context.join(' ') } : {}) }));

// ── 아크 구조 편집(E2·E3 · PLAN-arc-phase-lifecycle-editing-2026-07-15) ──
//   아크 사이즈 오판 비파괴 교정 — 중간 삽입(카빙)·순서 재배치. revise(전체 재분해) 회피.
autopilotCmd.command('insert-arc <id> <name...>')
  .description('★아크 중간 삽입 — --after 아크 뒤에 새 아크를 끼우고 --phases 를 카빙(배리어 재배선·예산 재산정)')
  .requiredOption('--after <arc>', '앵커 아크(핸들 A1.. 또는 arcId)')
  .requiredOption('--phases <refs>', '새 아크로 옮길 페이즈(쉼표구분·1-based 순번 또는 task hash4)')
  .option('--intent <t>', '아크 의도(1~2문장)')
  .option('--json')
  .action(async (id: string, name: string[], o: { after: string; phases: string; intent?: string; json?: boolean }) => {
    const { insertArcIntoMission } = await import('../autopilot/mission-lifecycle.js');
    const r = insertArcIntoMission(id, { afterArc: o.after, name: name.join(' '), phaseHandles: o.phases.split(','), ...(o.intent ? { intent: o.intent } : {}) });
    if (o.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); return; }
    if (!r.ok) { process.stderr.write(`insert-arc 실패: ${r.error}\n`); process.exit(1); }
    process.stdout.write(`⬡ 아크 삽입: "${r.arcName}" (${r.arcId})\n   페이즈 ${r.movedPhases}개 카빙 · 예산 델타 ${(r.budgetDelta ?? 0) >= 0 ? '+' : ''}$${(r.budgetDelta ?? 0).toFixed(2)} · 총 $${(r.totalBudget ?? 0).toFixed(2)}\n   → resume/rerun 으로 재편성된 아크 순회.\n`);
  });
autopilotCmd.command('reorder-arc <id> <arc> <newIdx>')
  .description('★아크 순서 재배치 — 아크를 위치 newIdx(0-based) 로 이동(핸들 A<ord> 순번 갱신·의존 불변)')
  .option('--json')
  .action(async (id: string, arc: string, newIdx: string, o: { json?: boolean }) => {
    const { reorderArcInMission } = await import('../autopilot/mission-lifecycle.js');
    const r = reorderArcInMission(id, { arcRef: arc, newIdx: Number(newIdx) });
    if (o.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); return; }
    if (!r.ok) { process.stderr.write(`reorder-arc 실패: ${r.error}\n`); process.exit(1); }
    process.stdout.write(`↕ 아크 재배치 완료 · 순서: ${r.order!.join(' → ')}\n`);
  });
autopilotCmd.command('insert-phase <id> <title...>')
  .description('★페이즈 중간 삽입 — --after 페이즈 뒤에 새 backlog 페이즈를 끼운다(후속 의존 재배선·아크 편입)')
  .requiredOption('--after <phase>', '앵커 페이즈(1-based 순번 또는 task hash4)')
  .option('--prompt <p>', '페이즈 설명/프롬프트')
  .option('--json')
  .action(async (id: string, title: string[], o: { after: string; prompt?: string; json?: boolean }) => {
    const { insertPhaseIntoMission } = await import('../autopilot/mission-lifecycle.js');
    const r = insertPhaseIntoMission(id, { afterHandle: o.after, title: title.join(' '), ...(o.prompt ? { description: o.prompt } : {}) });
    if (o.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); return; }
    if (!r.ok) { process.stderr.write(`insert-phase 실패: ${r.error}\n`); process.exit(1); }
    process.stdout.write(`＋ 페이즈 삽입: ${r.phaseId} (backlog·앵커 뒤)\n`);
  });
autopilotCmd.command('delete-phase <id> <phase>')
  .description('★페이즈 진짜 삭제 — backlog/failed 만(의존 브리지·아크 제거). skip(제외 표기)과 구분')
  .option('--json')
  .action(async (id: string, phase: string, o: { json?: boolean }) => {
    const { deletePhaseFromMission } = await import('../autopilot/mission-lifecycle.js');
    const r = deletePhaseFromMission(id, phase);
    if (o.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); return; }
    if (!r.ok) { process.stderr.write(`delete-phase 실패: ${r.error}\n`); process.exit(1); }
    process.stdout.write(`🗑 페이즈 삭제: ${r.deletedId}\n`);
  });
autopilotCmd.command('delete-arc <id> <arc>')
  .description('★아크 삭제 — 전 페이즈 backlog 면 아크+페이즈 삭제(배리어 재배선). 진행분 있으면 descoped 승격을 쓰라')
  .option('--json')
  .action(async (id: string, arc: string, o: { json?: boolean }) => {
    const { deleteArcFromMission } = await import('../autopilot/mission-lifecycle.js');
    const r = deleteArcFromMission(id, arc);
    if (o.json) { await writeStdoutJson(JSON.stringify(r, null, 2) + '\n'); return; }
    if (!r.ok) { process.stderr.write(`delete-arc 실패: ${r.error}\n`); process.exit(1); }
    process.stdout.write(`🗑 아크 삭제: ${r.deletedArcId} (페이즈 ${r.deletedPhases}개)\n`);
  });
// ── 미션 결정 기록(RFC-mission-decision-injection·2026-07-15) ──
//   운영자 결정(re-ground·defer·check-pass·boundary…)을 관측·기억·자기인지·셀프힐 3박자로 미션에 새김.
autopilotCmd.command('decide <id> <note...>')
  .description('★미션 결정 기록 — 운영자 결정을 워킹메모리+관측관문(logs.db+기억+ops) 3박자로 주입')
  .option('-k, --kind <kind>', 're-ground|defer|check-pass|scope-note|boundary|reuse|accept', 'scope-note')
  .option('--applies-to <t>', '대상(아크 핸들·페이즈·criterion 등)')
  .option('--rationale <r>', '왜(comprehension-debt 방지)')
  .option('--actor <a>', '누가(기본 operator)')
  .option('--arc <id>', '대상 아크 arcId(선택)')
  .option('--json')
  .action(async (id: string, note: string[], o: { kind?: string; appliesTo?: string; rationale?: string; actor?: string; arc?: string; json?: boolean }) => {
    // ★ 결정을 logs.db 에 관측 — CLI 프로세스는 데몬 sink 미상속(negotiate 동형). mission.selfheal.decision
    //   debug.log 가 logs.db 에 닿아 `elanous logs --category mission.selfheal.decision` 회상 가능.
    try {
      const [sMod, dMod, cMod] = await Promise.all([import('../mss/logging/log-store.js'), import('../debug/log.js'), import('../user-config.js')]);
      const lc = cMod.getUserConfig().logs; sMod.setLogInstanceName(lc.instanceName);
      const off = sMod.registerLogStoreSink((s) => dMod.debug.registerSink(s), 'autopilot', lc.retention); if (off) process.on('exit', off);
    } catch { /* fail-soft */ }
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { recordMissionDecision } = await import('../autopilot/mission-decision.js');
    const store = new TaskStore();
    try {
      if (!store.getMission(id)) { process.stderr.write(`decide 실패: 미션 없음 ${id}\n`); process.exit(1); }
    } finally { store.close(); }
    const kinds = ['re-ground', 'defer', 'check-pass', 'scope-note', 'boundary', 'reuse', 'accept'];
    const kind = (kinds.includes(o.kind ?? '') ? o.kind : 'scope-note') as import('../autopilot/mission-decision.js').MissionDecisionKind;
    const line = recordMissionDecision(id, {
      kind, note: note.join(' '), actor: o.actor ?? 'operator',
      ...(o.appliesTo ? { appliesTo: o.appliesTo } : {}),
      ...(o.rationale ? { rationale: o.rationale } : {}),
      ...(o.arc ? { arcId: o.arc } : {}),
    });
    if (o.json) { await writeStdoutJson(JSON.stringify({ ok: true, recorded: line }, null, 2) + '\n'); return; }
    process.stdout.write(`🧭 결정 기록: ${line}\n   → 워킹메모리+logs.db(mission.selfheal.decision)+기억(회상)+ops. elanous logs --category mission.selfheal.decision\n`);
  });

// ── A6-c 연관 미션 fabric (동급 관계 CRUD·RFC §9) ──
autopilotCmd.command('link <id> <targetId>')
  .description('연관 미션 연결(양방향 동급) — friend(동일 골 계보 형제·재실행/변형) 또는 associate(자원·산출 공유·충돌 경보). parent/child 와 별개.')
  .option('-r, --relation <kind>', 'friend | associate', 'associate')
  .option('-n, --note <text>', '관계 메모(선택)')
  .action(async (id: string, targetId: string, opts: { relation?: string; note?: string }) => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { attachAssociatedMission, detectAssociateConflicts } = await import('../autopilot/mission-associate.js');
    const relation = opts.relation === 'friend' ? 'friend' : 'associate';
    const store = new TaskStore();
    try {
      if (!store.getMission(id) || !store.getMission(targetId)) {
        process.stderr.write(`autopilot link: 미션 없음(${id} 또는 ${targetId})\n`); process.exit(1);
      }
      attachAssociatedMission(store, id, targetId, relation, opts.note);
      process.stdout.write(`🔗 연결: ${id} ⟷ ${targetId} (${relation}${opts.note ? ` · ${opts.note}` : ''})\n`);
      if (relation === 'associate') {
        const conflicts = detectAssociateConflicts(store, id, targetId);
        if (conflicts.length) process.stdout.write(`⚠️ 자원 충돌 후보 ${conflicts.length}건(같은 grounding 파일·동시 개발 주의):\n${conflicts.map((f) => `  · ${f}`).join('\n')}\n`);
      }
    } finally { store.close(); }
    process.exit(0);
  });
autopilotCmd.command('unlink <id> <targetId>')
  .description('연관 미션 해제(양방향) — relation 미지정 시 그 대상과의 모든 동급 관계 제거.')
  .option('-r, --relation <kind>', 'friend | associate (미지정=전부)')
  .action(async (id: string, targetId: string, opts: { relation?: string }) => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { removeAssociatedMission } = await import('../autopilot/mission-associate.js');
    const relation = opts.relation === 'friend' ? 'friend' : opts.relation === 'associate' ? 'associate' : undefined;
    const store = new TaskStore();
    try { removeAssociatedMission(store, id, targetId, relation); process.stdout.write(`🔗✗ 해제: ${id} ⟷ ${targetId}${relation ? ` (${relation})` : ' (전부)'}\n`); }
    finally { store.close(); }
    process.exit(0);
  });

// ── A6-b 성숙도 분리 — 과대 미션을 핵심(M1) + 후속(proposed) 으로 역제안(RFC §8b) ──
autopilotCmd.command('maturity-split <id>')
  .description('과대 미션 성숙도 분리 — 기본=제안 표시(READ-ONLY). --apply 시 후속 아크를 proposed 후속 미션으로 분리·parent-child 연결(M1 불변·자동 실행 없음).')
  .option('--apply', '집행(후속 proposed 미션 생성). 미지정 시 제안만 표시.')
  .action(async (id: string, opts: { apply?: boolean }) => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { buildMaturityProposal, formatMaturityProposal, applyMaturitySplit } = await import('../autopilot/mission-maturity.js');
    const store = new TaskStore();
    try {
      const m = store.getMission(id);
      if (!m) { process.stderr.write(`autopilot maturity-split: 미션 없음(${id})\n`); process.exit(1); }
      const proposal = buildMaturityProposal(m.autopilot?.arcs, m.autopilot?.tier as 'light' | 'heavy');
      if (!proposal.oversized) { process.stdout.write(`✅ 과대 아님 — 분리 불필요 (${proposal.reason})\n`); process.exit(0); }
      process.stdout.write(`${formatMaturityProposal(proposal)}\n`);
      if (!opts.apply) { process.stdout.write(`\n집행하려면: elanous autopilot maturity-split ${id} --apply\n`); process.exit(0); }
      const r = applyMaturitySplit(store, id);
      if (r.ok) process.stdout.write(`\n✂️ 성숙도 분리: 후속 ${r.created.length}개 proposed 생성(M1 종속·자동 실행 없음)\n${r.created.map((c) => `  · ${c}`).join('\n')}\n`);
      else process.stderr.write(`분리 실패: ${r.reason}\n`);
    } finally { store.close(); }
    process.exit(0);
  });

// ── A6-a 골 리디자인 역제안 — 골 형태 grounded 판정(READ-ONLY·RFC §8) ──
autopilotCmd.command('redesign <id>')
  .description('골 형태 grounded 판정(READ-ONLY) — founded(진행)/mirage·bundle(리디자인 역제안)/over_scope(성숙도 분리). 자동 재구성 없음·HITL.')
  .action(async (id: string) => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { assessGoalShape, formatRedesignProposal, findSimilarMissions } = await import('../autopilot/mission-redesign.js');
    const store = new TaskStore();
    try {
      const m = store.getMission(id);
      if (!m) { process.stderr.write(`autopilot redesign: 미션 없음(${id})\n`); process.exit(1); }
      const goal = m.intent ?? m.title;
      const shape = await assessGoalShape(goal);
      if (shape.verdict === 'founded') { process.stdout.write(`✅ founded — 단일 응집 미션(그대로 진행). ${shape.reason}\n`); process.exit(0); }
      const similar = findSimilarMissions(store, goal, id);
      process.stdout.write(`${formatRedesignProposal(shape, similar)}\n`);
    } finally { store.close(); }
    process.exit(0);
  });

// ── D3 실현가능성 협상 — 교착 페이즈 스코프컷/replan 제안(READ-ONLY·RFC §3b) ──
autopilotCmd.command('negotiate <id> <phase>')
  .description('교착 페이즈 실현가능성 협상(READ-ONLY) — 근본원인 규명 → replan 또는 ★스코프컷(acceptance 축소·나머지 defer) 제안. 자동 집행 없음·항상 HITL.')
  .action(async (id: string, phase: string) => {
    // ★ D3 협상 결정을 logs.db 에 관측(2026-07-15) — CLI 프로세스는 데몬 sink 미상속. mission.negotiate
    //   debug.log 가 logs.db 에 닿아 `elanous logs --category mission.negotiate` 로 회상 가능(자가진단 소스).
    try {
      const [sMod, dMod, cMod] = await Promise.all([import('../mss/logging/log-store.js'), import('../debug/log.js'), import('../user-config.js')]);
      const lc = cMod.getUserConfig().logs; sMod.setLogInstanceName(lc.instanceName);
      const off = sMod.registerLogStoreSink((s) => dMod.debug.registerSink(s), 'autopilot', lc.retention); if (off) process.on('exit', off);
    } catch { /* fail-soft */ }
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { proposeScopeNegotiation, formatNegotiationCard } = await import('../autopilot/mission-feasibility-negotiate.js');
    const store = new TaskStore();
    try {
      const tasks = store.listTasks({ goalSlug: id }).sort((a, b) => a.createdAt - b.createdAt);
      const idx = parseInt(phase, 10);
      const t = Number.isFinite(idx) ? tasks[idx] : tasks.find((x) => x.id === phase);
      if (!t) { process.stderr.write(`autopilot negotiate: 페이즈 없음(${phase})\n`); process.exit(1); }
      const notes = typeof t.notes === 'string' ? t.notes : JSON.stringify(t.notes ?? '');
      const neg = await proposeScopeNegotiation({
        phaseTitle: t.title,
        phasePrompt: t.surface.kind === 'subagent' ? t.surface.prompt : t.title,
        acceptance: t.acceptance?.criteria ? [...t.acceptance.criteria] : [],
        diagnosis: notes.slice(-1500),
      });
      process.stdout.write(`${formatNegotiationCard(neg, t.title)}\n`);
    } finally { store.close(); }
    process.exit(0);
  });

}
