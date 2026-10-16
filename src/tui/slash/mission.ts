// TUI-SLASH-SPLIT-MISSION (D4b 1/2 · RFC-tui-essential-diet-and-legacy-removal A5/D4b)
// `/mission` 슬래시 묶음 — src/dashboard/slash-runtime/dashboard-handlers.ts 의
// buildDashboardSlashRegistry 안 한 구역을 «순수 이동»한 것이다(동작 변화 0).
// 하위 명령마다 함수 하나(각 ≤300줄). 등록은 옛 자리에서 registerMissionSlash(registry) 한 줄로,
// 같은 순서로 한 번만 일어난다. 미션 엔진(autopilot/*)은 여기 없다 — 늘 그랬듯 동적 import 로 부른다.
//
// ⛔ 순환 import 금지: 이 파일은 dashboard-handlers.ts 를 import 하지 않는다(타입도).
//    ctx 는 아래 MissionSlashContext(구조 타입)로 받는다 — DashboardSlashContext 가 이걸 만족한다.

import { getUserConfig } from '../../user-config.js';
import { inspectActiveProvider } from '../../provider-summary.js';
import { formatRouteDecisionSummary, resolveRouteDecision, type RouteDecision } from '../../llm/route-decision.js';
import type { SlashCommandRegistry } from '../../dashboard/slash-runtime/registry.js';

/** `/mission` 이 ctx 에서 쓰는 것만(DashboardSlashContext 의 부분집합 · 구조 타입). */
export interface MissionSlashContext {
  chatLines: string[];
  setChatScrollOffset(value: number): void;
  muted(text: string): string;
  accent(text: string): string;
  text(text: string): string;
  error(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  info(text: string): string;
  subtext(text: string): string;
  missionTui: {
    startReadyWatch(missionId: string): void;
    startRunWatch(missionId: string): void;
  };
}

type MissionDispatch = typeof import('../../autopilot/mission-tool.js').dispatchAutopilotMissions;

type MissionSubHandler = (
  sub: string,
  args: string[],
  ctx: MissionSlashContext,
  dispatchAutopilotMissions: MissionDispatch,
) => Promise<void>;

// PR ③ — 페이즈 보드 + 조정(trim/defer/edit) + 재실행(rerun/rebuild).
// 전부 dispatchAutopilotMissions 단일 창구 — 텔레그램/PWA/CLI 와 같은 write 경로.
async function pushPhaseBoard(ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch, id: string): Promise<void> {
  const r = await dispatchAutopilotMissions({ action: 'phases', id }) as {
    error?: string; count?: number; phases?: Array<{ index: number; status: string; title: string }>; note?: string;
  };
  if (r.error) { ctx.chatLines.push(ctx.error(`  ✗ ${r.error}`)); return; }
  if (!r.phases || r.phases.length === 0) {
    ctx.chatLines.push(ctx.muted('  (페이즈 없음 — 단일/미분해 미션)'));
    return;
  }
  for (const p of r.phases) {
    const st = p.status === 'done' ? ctx.success(p.status)
      : p.status === 'failed' ? ctx.error(p.status)
      : p.status === 'running' ? ctx.info(p.status)
      : p.status === 'scheduled' ? ctx.warning(p.status)
      : ctx.muted(p.status);
    ctx.chatLines.push(`  ${ctx.muted(String(p.index).padStart(2) + '.')} [${st}] ${ctx.text(p.title)}`);
  }
}

// C-b-2 PR① — 채팅에서 미션 생성. 텔레그램 "미션:" 발화와 동형(submitIntent
// 단일 허리 · origin channel='tui'). 등록 확인 라인 후 ready 워처 시작 —
// detached prepare(외부조사+분해)가 끝나면 페이즈 보드 + 인라인 HITL 이 뜬다.
async function missionNew(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const goal = args.slice(1).join(' ').replace(/^["'“]|["'”]$/g, '').trim();
  ctx.chatLines.push(ctx.accent(`❯ /mission new`));
  if (!goal) {
    ctx.chatLines.push(ctx.warning('  usage: /mission new <goal 문장>'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const { submitIntent } = await import('../../intent-gate/gate.js');
  const gate = await submitIntent({
    text: `미션: ${goal}`, channel: 'tui', source: 'human-intent',
    origin: { channel: 'tui' },
  });
  if (gate.route !== 'mission') {
    ctx.chatLines.push(ctx.error('  ✗ 미션 등록 실패(게이트 passthrough)'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  ctx.chatLines.push(ctx.success(`  🎯 미션 등록: ${gate.goal.slice(0, 72)}`));
  // R2: preparation board shows a prediction only. It is deliberately
  // not persisted as a pin; arming/execution re-resolves capability and
  // explicit selection at the later authority boundary.
  const cfg = getUserConfig();
  const expectedRoute = resolveRouteDecision({
    provider: cfg.llm.provider,
    configuredModel: inspectActiveProvider().model,
    text: goal,
    routePolicy: cfg.llm.routePolicy,
  });
  ctx.chatLines.push(ctx.muted(`  · 예상 실행 레인 ${formatRouteDecisionSummary(expectedRoute)} (승인 시 재확인)`));
  ctx.chatLines.push(ctx.muted(`  · 실행모델 ${gate.executionModel} (${gate.tier === 'heavy' ? '무거움' : '가벼움'})`));
  ctx.chatLines.push(ctx.muted(`  · 🔎 외부조사 보강${gate.heavy ? ' + 멀티페이즈 분해' : ''} 준비 중 (백그라운드·수십초~분)`));
  ctx.chatLines.push(ctx.muted(`  · id ${gate.missionId}`));
  ctx.chatLines.push(ctx.muted('  ⏳ 준비되면 페이즈 보드 + 승인 선택이 이 채팅에 뜨집니다 (진행 확인: /mission trace)'));
  ctx.missionTui.startReadyWatch(gate.missionId);
  ctx.setChatScrollOffset(-1);
  return;
}

// C-b-2 PR① — 정정 코멘트 재분해(HITL 픽커 ✉ 직접입력 경로의 착지점).
// 텔레그램 force_reply 답장과 동형 — spawnMissionPrepare(comment) 후 재준비 워처.
async function missionRevise(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  const comment = args.slice(2).join(' ').trim();
  ctx.chatLines.push(ctx.accent(`❯ /mission revise ${id}`));
  if (!id || !comment) {
    ctx.chatLines.push(ctx.warning('  usage: /mission revise <apm_id> <정정 코멘트>'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const { spawnMissionPrepare } = await import('../../autopilot/mission-prepare-spawn.js');
  try { spawnMissionPrepare(id, { comment }); } catch { /* fail-soft */ }
  ctx.chatLines.push(ctx.success(`  🔧 정정 반영 중: "${comment.slice(0, 60)}"`));
  ctx.chatLines.push(ctx.muted('  재분해 후 새 페이즈 보드 + 승인 선택을 다시 보여드립니다'));
  ctx.missionTui.startReadyWatch(id);
  ctx.setChatScrollOffset(-1);
  return;
}

async function missionPhases(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  ctx.chatLines.push(ctx.accent(`❯ /mission phases ${id}`));
  if (!id) {
    ctx.chatLines.push(ctx.warning('  usage: /mission phases <apm_id>'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  await pushPhaseBoard(ctx, dispatchAutopilotMissions, id);
  ctx.chatLines.push(ctx.muted('  조정: /mission trim|defer <id> <n> · edit <id> <n> <새 제목> · rebuild <id> <n>'));
  ctx.setChatScrollOffset(-1);
  return;
}

async function missionTrimOrDefer(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  const phase = (args[2] ?? '').trim();
  ctx.chatLines.push(ctx.accent(`❯ /mission ${sub} ${id} ${phase}`));
  if (!id || !phase) {
    ctx.chatLines.push(ctx.warning(`  usage: /mission ${sub} <apm_id> <phase index|task id>`));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const r = await dispatchAutopilotMissions({ action: sub, id, phase }) as { error?: string; note?: string };
  if (r.error) ctx.chatLines.push(ctx.error(`  ✗ ${r.error}`));
  else {
    ctx.chatLines.push(ctx.success(`  ✓ ${r.note ?? `${sub} 완료`}`));
    await pushPhaseBoard(ctx, dispatchAutopilotMissions, id); // 조정 결과를 새 보드로 즉시 확인.
  }
  ctx.setChatScrollOffset(-1);
  return;
}

async function missionEdit(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  const phase = (args[2] ?? '').trim();
  const title = args.slice(3).join(' ').trim();
  ctx.chatLines.push(ctx.accent(`❯ /mission edit ${id} ${phase}`));
  if (!id || !phase || !title) {
    ctx.chatLines.push(ctx.warning('  usage: /mission edit <apm_id> <phase> <새 제목> (설명 교정은 CLI/tool 의 description)'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const r = await dispatchAutopilotMissions({ action: 'edit', id, phase, title }) as { error?: string; note?: string };
  if (r.error) ctx.chatLines.push(ctx.error(`  ✗ ${r.error}`));
  else {
    ctx.chatLines.push(ctx.success(`  ✓ ${r.note ?? '교정 완료'}`));
    await pushPhaseBoard(ctx, dispatchAutopilotMissions, id);
  }
  ctx.setChatScrollOffset(-1);
  return;
}

// dogfood 지적 — 픽커를 Esc(나중에)로 닫으면 TUI 재승인 경로가 없었다(arm 만 존재).
// 픽커 승인과 동일 경로(dispatch approve via:'tui' — 텔레그램 역싱크 포함) + 워처 attach.
async function missionApproveOrHold(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  ctx.chatLines.push(ctx.accent(`❯ /mission ${sub} ${id}`));
  if (!id) {
    ctx.chatLines.push(ctx.warning(`  usage: /mission ${sub} <apm_id>${sub === 'hold' ? ' — 보류(기록 유지·실행 안 함)' : ' — 승인·집행 시작'}`));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const r = await dispatchAutopilotMissions(
    sub === 'approve'
      ? { action: 'approve', id, via: 'tui' }
      : { action: 'cancel', id, via: 'tui', defer: true },
  ) as { error?: string; note?: string; scheduledCron?: string };
  if (r.error) ctx.chatLines.push(ctx.error(`  ✗ ${r.error}`));
  else if (sub === 'approve') {
    ctx.chatLines.push(ctx.success(`  ✅ 승인 — ${r.note ?? '실행 시작'}`));
    if (!r.scheduledCron) ctx.missionTui.startRunWatch(id);
  } else ctx.chatLines.push(ctx.warning(`  ⏸️ 보류 — ${r.note ?? '기록 유지'}`));
  ctx.setChatScrollOffset(-1);
  return;
}

// P4 (2026-07-13) — split/skip 합류: 텔레그램 3층 탈출구의 slash 패리티(dispatch 단일 창구).
async function missionRerunFamily(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  const phase = (args[2] ?? '').trim();
  const needsPhase = sub === 'rebuild' || sub === 'split' || sub === 'skip';
  ctx.chatLines.push(ctx.accent(`❯ /mission ${sub} ${id}${phase ? ` ${phase}` : ''}`));
  if (!id || (needsPhase && !phase)) {
    ctx.chatLines.push(ctx.warning(sub === 'rerun'
      ? '  usage: /mission rerun <apm_id> — 처음부터 재실행(세대+1·이전 PR close)'
      : sub === 'rereflect'
        ? '  usage: /mission rereflect <apm_id> — 비평 지적 페이즈만 자동 재구현(머지는 HITL)'
        : sub === 'split'
          ? '  usage: /mission split <apm_id> <phase index> — 과대 페이즈를 단일책임 서브페이즈로 재분해'
          : sub === 'skip'
            ? '  usage: /mission skip <apm_id> <phase index> — 페이즈 건너뛰기(기능 제외·부분 완주)'
            : '  usage: /mission rebuild <apm_id> <phase index|task id> — 그 페이즈부터 재구현'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const r = await dispatchAutopilotMissions({
    action: sub, id, ...(needsPhase ? { phase } : {}), via: 'tui',
  }) as { error?: string; note?: string };
  if (r.error) ctx.chatLines.push(ctx.error(`  ✗ ${r.error}`));
  else {
    ctx.chatLines.push(ctx.success(`  🔄 ${r.note ?? `${sub} 시작`}`));
    ctx.missionTui.startRunWatch(id); // 재실행 진행을 즉시 관찰(페이즈 전이·진행바·종결).
  }
  ctx.setChatScrollOffset(-1);
  return;
}

// P5 (2026-07-13) — 미션 실행 로그 tail. O3 영속 run.log 를 채팅에서 바로(진단 근거 실체).
async function missionLog(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  const n = (args[2] ?? '').trim();
  ctx.chatLines.push(ctx.accent(`❯ /mission log ${id}${n ? ` ${n}` : ''}`));
  if (!id) {
    ctx.chatLines.push(ctx.warning('  usage: /mission log <apm_id> [줄수(기본 40)] — 미션 실행 로그 tail'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const r = await dispatchAutopilotMissions({
    action: 'log', id, ...(n ? { tail: Number(n) } : {}),
  }) as { error?: string; exists?: boolean; lines?: string[]; runLogPath?: string; note?: string };
  if (r.error) ctx.chatLines.push(ctx.error(`  ✗ ${r.error}`));
  else if (!r.exists) ctx.chatLines.push(ctx.muted(`  ${r.note ?? '로그 없음'}`));
  else {
    for (const line of r.lines ?? []) ctx.chatLines.push(ctx.muted(`  │ ${line}`));
    ctx.chatLines.push(ctx.subtext(`  ${r.note ?? r.runLogPath ?? ''}`));
  }
  ctx.setChatScrollOffset(-1);
  return;
}

// PR ② — 실행 관찰 attach. 타 서피스(텔레그램/PWA/CLI)에서 승인된 미션의 진행을
// TUI 채팅에서도 보고 싶을 때 수동으로 워처를 붙인다(TUI approve 는 자동 attach).
async function missionWatch(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  ctx.chatLines.push(ctx.accent(`❯ /mission watch ${id}`));
  if (!id) {
    ctx.chatLines.push(ctx.warning('  usage: /mission watch <apm_id>'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  ctx.chatLines.push(ctx.muted('  ⏳ 실행 워처 attach — 페이즈 전이·진행바·종결 리포트가 이 채팅에 뜹니다'));
  ctx.missionTui.startRunWatch(id);
  ctx.setChatScrollOffset(-1);
  return;
}

async function missionList(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const status = (args[1] ?? '').trim();
  const result = await dispatchAutopilotMissions({
    action: 'list',
    ...(status ? { status } : {}),
  }) as { error?: string; count?: number; missions?: Array<Record<string, unknown>>; note?: string };
  ctx.chatLines.push(ctx.accent(`\u276f /mission list${status ? ` ${status}` : ''}  (${result.count ?? 0})`));
  if (result.error) {
    ctx.chatLines.push(ctx.error(`  \u2717 ${result.error}`));
    ctx.setChatScrollOffset(-1);
    return;
  }
  for (const m of result.missions ?? []) {
    const st = String(m.status ?? '?');
    const stColored = st === 'running' ? ctx.info(st.padEnd(9))
      : st === 'done' ? ctx.success(st.padEnd(9))
      : st === 'failed' ? ctx.error(st.padEnd(9))
      : st === 'armed' ? ctx.warning(st.padEnd(9))
      : ctx.muted(st.padEnd(9));
    const d = m.derived as { total: number; ok: number; error: number; active: number } | undefined;
    const health = d && d.total > 0
      ? ctx.subtext(` \u2705${d.ok}${d.error > 0 ? ` \u274c${d.error}` : ''}${d.active > 0 ? ` \ud83d\udd35${d.active}` : ''}`)
      : '';
    ctx.chatLines.push(`  ${stColored} ${ctx.muted(String(m.source ?? '').padEnd(10))} ${ctx.text(String(m.id ?? ''))}${health}`);
    ctx.chatLines.push(ctx.subtext(`            ${String(m.goal ?? '').slice(0, 72)}`));
  }
  if (result.note) ctx.chatLines.push(ctx.muted(`  ${result.note}`));
  ctx.chatLines.push(ctx.muted('  /mission new <goal> \u2014 \uc0dd\uc131 \u00b7 trace <id> \u2014 \uacc4\ubcf4 \u00b7 briefing <id> \u2014 \uc2e4\uc9d1\ud589 \uc804 \uc885\ud569 \ube0c\ub9ac\ud551 \u00b7 arm <id> \u2014 \uc2b9\uc778 \u00b7 \uad6c\uccb4\ud654/\uc885\ub8cc\ub294 `elanous autopilot` CLI'));
  ctx.setChatScrollOffset(-1);
  return;
}

async function missionTrace(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  ctx.chatLines.push(ctx.accent(`\u276f /mission trace ${id}`));
  if (!id) {
    ctx.chatLines.push(ctx.warning('  usage: /mission trace <apm_id>'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const result = await dispatchAutopilotMissions({ action: 'trace', id }) as {
    error?: string;
    mission?: Record<string, unknown>;
    routeDecision?: RouteDecision;
    derived?: Array<{ kind: string; name: string; status: string; detail?: string | null }>;
    note?: string;
  };
  if (result.error) {
    ctx.chatLines.push(ctx.error(`  \u2717 ${result.error}`));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const m = result.mission ?? {};
  ctx.chatLines.push(`  ${ctx.text(String(m.id ?? ''))}  ${ctx.muted(String(m.status ?? ''))} \u00b7 ${ctx.muted(String(m.source ?? ''))} \u00b7 ${ctx.muted(String(m.kind ?? ''))}`);
  ctx.chatLines.push(ctx.subtext(`  ${String(m.goal ?? '').slice(0, 76)}`));
  if (result.routeDecision) ctx.chatLines.push(ctx.muted(`  route: ${formatRouteDecisionSummary(result.routeDecision)}`));
  // \uc900\ube44 \ub9e5\ub77d \uc804\ubb38(dogfood \uc9c0\uc801: "\uc804\ubb38: /mission trace" \ud78c\ud2b8\uc758 \uc2e4\uccb4) \u2014 grounding \ud30c\uc77c
  // \ubaa9\ub85d\u00b7\uc678\ubd80\uc870\uc0ac \ubcf4\uac15/\uad50\uc815\u00b7\uc911\ubcf5\uae4c\uc9c0. \uacfc\ub3c4\ud55c \uc2a4\ud06c\ub864 \ubc29\uc9c0\ub85c 40\uc904 \ucea1.
  if (typeof m.description === 'string' && m.description.trim()) {
    const descLines = m.description.split('\n');
    for (const dl of descLines.slice(0, 40)) {
      ctx.chatLines.push(dl.startsWith('## ') ? ctx.subtext(`  ${dl.slice(3)}`) : ctx.muted(`  ${dl}`));
    }
    if (descLines.length > 40) ctx.chatLines.push(ctx.muted(`  \u2026 \uc678 ${descLines.length - 40}\uc904`));
  }
  for (const dv of result.derived ?? []) {
    const mark = dv.status === 'ok' ? ctx.success('\u2705')
      : dv.status === 'error' ? ctx.error('\u274c')
      : dv.status === 'active' ? ctx.info('\ud83d\udd35')
      : ctx.muted('\u00b7');
    ctx.chatLines.push(`    ${mark} ${ctx.muted(dv.kind.padEnd(9))} ${dv.name}${dv.detail ? ctx.subtext(`  ${String(dv.detail).slice(0, 40)}`) : ''}`);
  }
  if (result.note) ctx.chatLines.push(ctx.muted(`  ${result.note}`));
  ctx.setChatScrollOffset(-1);
  return;
}

// \ubbf8\uc158 \ucd5c\uc885 \ube0c\ub9ac\ud551(B6\u00b7TUI \ud328\ub9ac\ud2f0\u00b7PLAN-mission-pre-arming-briefing \u00a7B4) \u2014 \uc2e4\uc9d1\ud589 \uc804 \uc885\ud569
// \uc810\uac80(\uace8 \uc9c4\ud654\u00b7\uc5ec\uc815\u00b7\uc0b0\ucd9c\ubb3c grounded\u00b7\uc815\ucc29)\uc744 \ucc44\ud305\uc5d0\uc11c \uc77d\ub294\ub2e4. grounded \uc778\uc790\uba74 PR merge \ud604\uc2e4
// \ub300\uc870(gh/git\u00b7\ub290\ub9bc). \ubc1c\uc1a1(--send)\uc740 \ud154\ub808\uadf8\ub7a8 \uc804\uc6a9\uc774\ub77c CLI \ub85c \uc548\ub0b4(TUI \ub294 \ud310\ub2e8 \ud45c\uba74).
async function missionBriefing(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  const grounded = (args[2] ?? '').toLowerCase() === 'grounded';
  ctx.chatLines.push(ctx.accent(`\u276f /mission briefing ${id}${grounded ? ' grounded' : ''}`));
  if (!id) {
    ctx.chatLines.push(ctx.warning('  usage: /mission briefing <apm_id> [grounded] \u2014 \uc2e4\uc9d1\ud589 \uc804 \uc885\ud569 \ube0c\ub9ac\ud551(\uace8 \uc9c4\ud654\u00b7\uc5ec\uc815\u00b7\uc0b0\ucd9c\ubb3c\u00b7\uc815\ucc29). grounded=PR merge \ud604\uc2e4 \ub300\uc870(\ub290\ub9bc)'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  if (grounded) ctx.chatLines.push(ctx.muted('  \u23f3 grounded \ud604\uc2e4 \ub300\uc870(gh/git) \uc911\u2026 (\uc218\ucd08 \uc18c\uc694)'));
  const r = await dispatchAutopilotMissions({ action: 'briefing', id, ...(grounded ? {} : { grounded: false }) }) as {
    error?: string;
    briefing?: {
      currentGoal: string;
      goalEvolution: Array<{ generation: number; reason?: string; phaseCount: number }>;
      journey: { splits: number; edits: number; decisions: number; drifts: number; externalInterventions: number; notable: string[] };
      deliverables: { logicPhases: string[]; prUrls: string[]; resourceCount: number; driftWarnings: Array<{ phase: string; issue: string }>; groundedChecked: boolean };
      settlement: { arcs: Array<{ name: string; status: string; phaseCount: number }>; phasesDone: number; phasesTotal: number; missionStatus: string };
      pendingArming?: { phaseId: string; title: string };
      routeDecision?: { provider: string; model: string; effort?: string; source: string };
    };
  };
  if (r.error) { ctx.chatLines.push(ctx.error(`  \u2717 ${r.error}`)); ctx.setChatScrollOffset(-1); return; }
  const b = r.briefing;
  if (!b) { ctx.chatLines.push(ctx.muted('  (\ube0c\ub9ac\ud551 \uc5c6\uc74c)')); ctx.setChatScrollOffset(-1); return; }
  ctx.chatLines.push(`  ${ctx.text('\uace8')} ${ctx.muted(String(b.currentGoal).replace(/\s+/g, ' ').slice(0, 72))}`);
  if (b.routeDecision) ctx.chatLines.push(ctx.muted(`  \uc2e4\ud589 \ub808\uc778: ${b.routeDecision.provider}/${b.routeDecision.model}${b.routeDecision.effort ? `\u00b7${b.routeDecision.effort}` : ''} (${b.routeDecision.source})`));
  // \u2460 \uace8 \uc9c4\ud654(\ucd5c\ucd08\u2192\uc911\uac04\u2192\ucd5c\uc885)
  ctx.chatLines.push(ctx.subtext(`  \u2460 \uace8 \uc9c4\ud654 (${b.goalEvolution.length}\uc138\ub300 \uad6c\uc870 \uc804\uc774)`));
  for (const g of b.goalEvolution) ctx.chatLines.push(ctx.muted(`    gen${g.generation} [${g.reason ?? ''}] ${g.phaseCount}\ud398\uc774\uc988`));
  // \u2461 \uc5ec\uc815
  ctx.chatLines.push(ctx.subtext(`  \u2461 \uc5ec\uc815 \u2014 split ${b.journey.splits}\u00b7\ud3b8\uc9d1 ${b.journey.edits}\u00b7\uacb0\uc815 ${b.journey.decisions}(\uc678\ubd80 ${b.journey.externalInterventions})\u00b7drift ${b.journey.drifts}`));
  for (const n of b.journey.notable.slice(-4)) ctx.chatLines.push(ctx.muted(`    \u00b7 ${String(n).slice(0, 68)}`));
  // \u2462 \uc0b0\ucd9c\ubb3c grounded \uc810\uac80
  const dv = b.deliverables;
  const gmark = dv.driftWarnings.length ? ctx.error(`\u26a0\ufe0f \ubbf8\ud655\uc815 ${dv.driftWarnings.length}`) : (dv.groundedChecked ? ctx.success('\u2713 grounded') : ctx.muted('\ud734\ub9ac\uc2a4\ud2f1'));
  ctx.chatLines.push(ctx.subtext(`  \u2462 \uc0b0\ucd9c\ubb3c \u2014 \ub85c\uc9c1 ${dv.logicPhases.length}\u00b7PR ${dv.prUrls.length}\u00b7\ub9ac\uc18c\uc2a4 ${dv.resourceCount} \u00b7 ${gmark}`));
  for (const w of dv.driftWarnings.slice(0, 8)) ctx.chatLines.push(`    ${ctx.error('\u26a0\ufe0f')} ${ctx.text(String(w.phase).slice(0, 26))} ${ctx.muted('\u2014 ' + String(w.issue).slice(0, 52))}`);
  // \u2463 \uc815\ucc29
  const arcStr = b.settlement.arcs.map((a) => `${a.name.slice(0, 8)}[${a.status}]`).join('\u00b7') || 'flat';
  ctx.chatLines.push(ctx.subtext(`  \u2463 \uc815\ucc29 \u2014 ${arcStr} \u00b7 ${b.settlement.phasesDone}/${b.settlement.phasesTotal} done \u00b7 ${b.settlement.missionStatus}`));
  if (b.pendingArming) ctx.chatLines.push(ctx.warning(`  \ud83d\udd12 \uc2e4\uc9d1\ud589 \uc2b9\uc778 \ub300\uc0c1: ${b.pendingArming.title.slice(0, 48)}`));
  if (!grounded) ctx.chatLines.push(ctx.muted('  \u00b7 grounded \uc2e4\uce21(PR merge \ud604\uc2e4 \ub300\uc870): /mission briefing <id> grounded \u00b7 \ube60\ub978 \ubbf8\uba38\uc9c0 \uc2a4\uce94: /mission landing <id>'));
  ctx.chatLines.push(ctx.muted('  \u00b7 \ud154\ub808\uadf8\ub7a8 \uce74\ub4dc \ubc1c\uc1a1: elanous autopilot briefing <id> --send'));
  ctx.setChatScrollOffset(-1);
  return;
}

// \ub79c\ub529 \ube60\ub978 \uc2a4\uce94(B7) \u2014 \uc644\uc8fc/arming \uc804 "\ubbf8\uba38\uc9c0 \uc788\ub098?" \uc989\ub2f5(\uae30\ub85d PR merge \uc0c1\ud0dc\ub9cc\u00b71\ud68c gh \ubc30\uce58\u00b7\uc218\ucd08).
// \u26d4 open=\ud655\uc815 \ubbf8\uba38\uc9c0(\uc644\uc8fc \ucc28\ub2e8) \u00b7 \u26a0\ufe0f closed=\ub300\uccb4 \ub79c\ub529 \ud655\uc778 \uad8c\uc7a5(\u2192 briefing grounded).
async function missionLanding(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  ctx.chatLines.push(ctx.accent(`\u276f /mission landing ${id}`));
  if (!id) {
    ctx.chatLines.push(ctx.warning('  usage: /mission landing <apm_id> \u2014 \uc644\uc8fc \uc804 \ubbf8\uba38\uc9c0 PR \ube60\ub978 \uc2a4\uce94'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  ctx.chatLines.push(ctx.muted('  \u23f3 \uae30\ub85d PR merge \uc0c1\ud0dc \uc2a4\uce94 \uc911\u2026 (gh\u00b7\uc218\ucd08)'));
  const r = await dispatchAutopilotMissions({ action: 'landing', id }) as {
    error?: string; summary?: string;
    scan?: { total: number; merged: number; open: number; closed: number; none: number; blocking: number; needsRecheck: number; phases: Array<{ phaseTitle: string; pr: number | null; state: string }> };
  };
  if (r.error) { ctx.chatLines.push(ctx.error(`  \u2717 ${r.error}`)); ctx.setChatScrollOffset(-1); return; }
  const s = r.scan;
  if (!s) { ctx.chatLines.push(ctx.muted('  (\uc2a4\uce94 \uc5c6\uc74c)')); ctx.setChatScrollOffset(-1); return; }
  const line = s.blocking > 0 ? ctx.error(r.summary ?? '') : s.needsRecheck > 0 ? ctx.warning(r.summary ?? '') : ctx.success(r.summary ?? '');
  ctx.chatLines.push(`  ${line}`);
  ctx.chatLines.push(ctx.muted(`  \ucd1d ${s.total} \u00b7 merged ${s.merged} \u00b7 open ${s.open} \u00b7 closed ${s.closed} \u00b7 none ${s.none}`));
  for (const p of s.phases) {
    if (p.state === 'none') continue;
    const mk = p.state === 'merged' ? ctx.success('\u2705') : p.state === 'open' ? ctx.error('\u26d4') : ctx.warning('\u26a0\ufe0f');
    ctx.chatLines.push(`    ${mk} ${ctx.muted(`[${p.state}]${p.pr ? ` #${p.pr}` : ''}`)} ${ctx.text(p.phaseTitle.slice(0, 42))}`);
  }
  if (s.needsRecheck > 0) ctx.chatLines.push(ctx.muted('  \u00b7 \ub2eb\ud78c PR \ub300\uccb4 \ub79c\ub529 \ud655\uc778: /mission briefing <id> grounded'));
  ctx.setChatScrollOffset(-1);
  return;
}

async function missionArm(sub: string, args: string[], ctx: MissionSlashContext, dispatchAutopilotMissions: MissionDispatch): Promise<void> {
  const id = (args[1] ?? '').trim();
  ctx.chatLines.push(ctx.accent(`\u276f /mission arm ${id}`));
  if (!id) {
    ctx.chatLines.push(ctx.warning('  usage: /mission arm <apm_id>'));
    ctx.setChatScrollOffset(-1);
    return;
  }
  const result = await dispatchAutopilotMissions({ action: 'arm', id }) as { error?: string; ok?: boolean };
  if (result.error) {
    ctx.chatLines.push(ctx.error(`  \u2717 ${result.error}`));
    ctx.setChatScrollOffset(-1);
    return;
  }
  ctx.chatLines.push(ctx.success(`  \u2713 armed \u2014 ${id} (materialize spec \uc800\uc7a5 \u00b7 \uc2e4\ud589\uc740 materialize \uc2dc)`));
  ctx.setChatScrollOffset(-1);
  return;
}

/** 하위 명령 → 처리 함수. 옛 if 사슬과 같은 순서(이름이 겹치지 않아 순서는 결과를 바꾸지 않는다). */
const MISSION_SUBCOMMANDS: ReadonlyArray<readonly [readonly string[], MissionSubHandler]> = [
  [['new'], missionNew],
  [['revise'], missionRevise],
  [['phases'], missionPhases],
  [['trim', 'defer'], missionTrimOrDefer],
  [['edit'], missionEdit],
  [['approve', 'hold'], missionApproveOrHold],
  [['rerun', 'rebuild', 'rereflect', 'split', 'skip'], missionRerunFamily],
  [['log'], missionLog],
  [['watch'], missionWatch],
  [['list', 'ls'], missionList],
  [['trace'], missionTrace],
  [['briefing', 'brief'], missionBriefing],
  [['landing', 'land'], missionLanding],
  [['arm'], missionArm],
];

/** `/mission` 본체 — 옛 registry.register('mission', …) 핸들러 그대로. */
export async function handleMissionSlash(args: string[], ctx: MissionSlashContext): Promise<void> {
  const sub = (args[0] ?? 'list').toLowerCase();
  const { dispatchAutopilotMissions } = await import('../../autopilot/mission-tool.js');
  ctx.chatLines.push('');

  for (const [names, handler] of MISSION_SUBCOMMANDS) {
    if (names.includes(sub)) {
      await handler(sub, args, ctx, dispatchAutopilotMissions);
      return;
    }
  }

  ctx.chatLines.push(ctx.accent('\u276f /mission'));
  ctx.chatLines.push(ctx.warning(`  unknown subcommand: ${sub}`));
  ctx.chatLines.push(ctx.muted('  usage: /mission [list [status]] | new <goal> | approve|hold <id> | phases <id> | trim|defer <id> <n> | edit <id> <n> <\uc81c\ubaa9> | rerun <id> | rebuild <id> <n> | rereflect <id> | watch <id> | trace <id> | briefing <id> [grounded] | landing <id> | arm <id> | revise <id> <\ucf54\uba58\ud2b8>'));
  ctx.setChatScrollOffset(-1);
}

/** buildDashboardSlashRegistry 가 옛 자리(같은 순서)에서 한 번 부른다. */
export function registerMissionSlash<C extends MissionSlashContext, R>(registry: SlashCommandRegistry<C, R>): void {
  registry.register('mission', async (args, ctx) => {
    await handleMissionSlash(args, ctx);
  });
}
