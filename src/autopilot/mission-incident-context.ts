// ── 미션 사건 문맥 팩 (봇 답변 결정론 grounding · RFC-mission-incident-context-2026-07-15) ──
//
// 문제(동기 사건): 텔레그램에서 "왜 실패했고 뭘 했나" 물으면 봇 LLM 이 fuzzy 의미기억(ambient recall)으로
// 무관한 옛 사건(#3928 KGS·CLOSED)을 끌어와 confabulation. write 측(recordMissionObservation·[DIAGNOSIS]
// task.notes)은 grounded 인데 read 측(봇 답변)이 구조화 기록을 질의 안 함.
//
// 해법: 미션 질문에 답하기 前, 그 미션의 실제 사건 로그를 결정론으로 조립해 주입(#4288 빌드-前 게이트의
// 대화판). **재구현 0** — 기존 assembler `opsMissionDetail`(페이즈별 진단·전이·PR) + `attemptsForPhase`
// (시도 트레일)만 얇게 합친다. anti-confabulation: 팩에 없는 사실은 "기록 없음"—유사 과거 회수 금지.

import { opsMissionDetail, type OpsMissionDetail } from '../domains/ops-status.js';
import { attemptsForPhase, type PhaseAttemptFact } from './se-build-registry.js';
import { formatDateTime } from '../time/calendar.js';
import { resolveTimeZone } from '../time/time-zone.js';

/** 페이즈 1건의 사건 사실(진단 + 시도 트레일). */
export interface IncidentPhaseFact {
  index: number;
  title: string;
  status: string;
  failClass?: string;
  rootCause?: string;
  heal?: string;
  prUrl?: string;
  critiqueVerdict?: string;
  /** 실측 시도 트레일(backend·gate 결과) — 실패/건너뜀 페이즈만 조회(비용 bound). */
  attempts: Array<{ backend: string; gateResult: string; excerpt?: string }>;
}

/** 미션 단위 사건 문맥 — 봇 답변에 주입할 결정론 ground-truth. */
export interface MissionIncidentContext {
  /** 미션 실존 여부 — false 면 봇은 "기록 없음"만 답(추측 금지). */
  found: boolean;
  missionId: string;
  goal: string;
  /** freshness — 이 팩을 조립한 시각(ISO). "as of" 앵커. */
  asOf: string;
  state: { total: number; done: number; failed: number; skipped: number; running: number; backlog: number };
  phases: IncidentPhaseFact[];
  transitions: Array<{ ts: string; from?: string; to?: string; rationale?: string }>;
  /** 이 미션 소속 PR 만(phase notes 의 [SE-PR]). 외부 PR(#3928 류) confabulation 차단. */
  deliverables: Array<{ prUrl: string; phase: string }>;
  /** 조립이 부분 실패했나(fail-soft 정직성) — true 면 "문맥 조립 실패·불확실" 표기. */
  degraded: boolean;
}

export interface IncidentContextDeps {
  /** 미션 상세 조립기(기본 opsMissionDetail). 테스트 seam. */
  detail?: (missionId: string) => OpsMissionDetail;
  /** 페이즈 시도 트레일(기본 attemptsForPhase). 테스트 seam. */
  attempts?: (phaseId: string) => PhaseAttemptFact[];
  /** freshness 시각(기본 실시간). 테스트 결정론 주입. */
  now?: () => string;
}

/** 시도 트레일을 조회할 '사건 관련' 페이즈인가(실패·건너뜀·진단 있음) — done/backlog 는 스킵(비용 bound). */
function isIncidentPhase(status: string, hasDiagnosis: boolean): boolean {
  return status === 'failed' || status === 'skipped' || hasDiagnosis;
}

/**
 * 미션 사건 문맥 팩 조립(결정론·READ-ONLY·fail-soft). opsMissionDetail(진단·전이·PR) 코어 재사용 +
 * 사건 페이즈에 attemptsForPhase(시도 트레일) 보강. 미션 부재 시 found=false(봇이 "기록 없음"만 답).
 */
export function buildMissionIncidentContext(
  missionId: string, deps: IncidentContextDeps = {},
): MissionIncidentContext {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const attemptsFn = deps.attempts ?? attemptsForPhase;
  let detail: OpsMissionDetail;
  let degraded = false;
  try {
    detail = (deps.detail ?? ((id: string) => opsMissionDetail(id)))(missionId);
  } catch {
    return { found: false, missionId, goal: '', asOf: now, state: emptyState(), phases: [], transitions: [], deliverables: [], degraded: true };
  }
  if (!detail.mission) {
    return { found: false, missionId, goal: '', asOf: now, state: emptyState(), phases: [], transitions: [], deliverables: [], degraded: false };
  }

  const phases: IncidentPhaseFact[] = detail.phases.map((p) => {
    let attempts: IncidentPhaseFact['attempts'] = [];
    if (isIncidentPhase(p.status, !!p.diagnosis)) {
      try {
        attempts = attemptsFn(p.id).map((a) => ({
          backend: a.backend, gateResult: a.gateResult,
          ...(a.gateOutputExcerpt ? { excerpt: a.gateOutputExcerpt.slice(0, 200) } : {}),
        }));
      } catch { degraded = true; }
    }
    return {
      index: p.index, title: p.title, status: p.status,
      ...(p.failClass ? { failClass: p.failClass } : {}),
      ...(p.diagnosis?.rootCause ? { rootCause: p.diagnosis.rootCause } : {}),
      ...(p.diagnosis?.heal ? { heal: p.diagnosis.heal } : {}),
      ...(p.prUrl ? { prUrl: p.prUrl } : {}),
      ...(p.critiqueVerdict ? { critiqueVerdict: p.critiqueVerdict } : {}),
      attempts,
    };
  });

  const state = {
    total: phases.length,
    done: phases.filter((p) => p.status === 'done').length,
    failed: phases.filter((p) => p.status === 'failed').length,
    skipped: phases.filter((p) => p.status === 'skipped').length,
    running: phases.filter((p) => p.status === 'running').length,
    backlog: phases.filter((p) => p.status === 'backlog' || p.status === 'ready' || p.status === 'blocked').length,
  };

  const transitions = detail.transitions.slice(0, 12).map((t) => {
    const e = t as { ts?: string; timestamp?: string; fromState?: string; toState?: string; from?: string; to?: string; rationale?: string };
    return {
      ts: e.ts ?? e.timestamp ?? '',
      ...(e.fromState ?? e.from ? { from: e.fromState ?? e.from } : {}),
      ...(e.toState ?? e.to ? { to: e.toState ?? e.to } : {}),
      ...(e.rationale ? { rationale: String(e.rationale).slice(0, 160) } : {}),
    };
  });

  // 산출 PR = 이 미션 페이즈 notes 의 [SE-PR] 뿐(opsMissionDetail 이 이미 소속 판정). 외부 PR 차단.
  const deliverables = phases.filter((p) => p.prUrl).map((p) => ({ prUrl: p.prUrl!, phase: p.title }));

  return { found: true, missionId, goal: detail.mission.goal, asOf: now, state, phases, transitions, deliverables, degraded };
}

function emptyState(): MissionIncidentContext['state'] {
  return { total: 0, done: 0, failed: 0, skipped: 0, running: 0, backlog: 0 };
}

/** 이 미션에 봇이 답할 만한 '사건'(실패·건너뜀·진단)이 있나 — ambient push 게이팅(정상 미션 무노이즈). */
export function hasIncident(ctx: MissionIncidentContext): boolean {
  return ctx.found && (ctx.state.failed > 0 || ctx.state.skipped > 0 || ctx.phases.some((p) => p.failClass));
}

/**
 * ambient 주입용 **압축** 문맥(매 턴 주입 가능한 크기). 사건 페이즈(진단 있음)만 1줄씩 + 산출 PR + anti-
 * confabulation 규칙. 봇이 툴 호출을 건너뛰어도(terra 경향) 실제 사건 사실이 이미 문맥에 있게 한다.
 */
export function formatIncidentContextCompact(ctx: MissionIncidentContext): string {
  if (!hasIncident(ctx)) return '';
  const s = ctx.state;
  const L: string[] = [];
  L.push(`[미션 사건 사실 — 이 사실로만 답하고 없으면 "기록 없음"이라 하라(유사 과거 지어내기 금지)]`);
  L.push(`미션 ${ctx.missionId.slice(0, 60)} · 페이즈 ${s.total}(완료 ${s.done}·실패 ${s.failed}·건너뜀 ${s.skipped}·실행 ${s.running})`);
  for (const p of ctx.phases.filter((ph) => ph.failClass || ph.status === 'failed' || ph.status === 'skipped').slice(0, 4)) {
    const at = p.attempts.length ? ` [${p.attempts.map((a) => `${a.backend.split(':').pop()}:${a.gateResult}`).join('→')}]` : '';
    L.push(`· P${p.index} ${p.status}${p.failClass ? `(${p.failClass})` : ''}: ${p.title.slice(0, 40)}${p.heal ? ` →${p.heal}` : ''}${at}`);
  }
  L.push(`산출 PR: ${ctx.deliverables.length ? ctx.deliverables.map((d) => d.prUrl).join(', ') : '없음(이 미션엔 PR 없음)'}`);
  return L.join('\n');
}

/**
 * 봇 답변 주입용 결정론 문맥 문자열(anti-confabulation). 팩의 사실만 담고, 끝에 "없으면 기록 없음"
 * 규칙을 명시해 LLM 이 유사 과거 사건을 지어내지 못하게 한다(동기 사건 #3928 confabulation 차단).
 */
export function formatIncidentContext(ctx: MissionIncidentContext): string {
  if (!ctx.found) {
    return [
      `## 미션 사건 기록 조회 — ${ctx.missionId}`,
      ctx.degraded ? '⚠️ 문맥 조립 실패(불확실) — 확언 금지.' : `이 미션의 기록을 찾지 못함.`,
      '규칙: 추측·유사 과거 사건 회수 금지. "해당 미션 기록을 찾지 못했다"고만 답하고 id 확인을 요청하라.',
    ].join('\n');
  }
  const L: string[] = [];
  // 2026-07-24 — 사용자 시간대 + 시간대 라벨 명시. 종전엔 ISO slice 로 UTC 를 넣어,
  // "결정론"이라는 이름표를 달고 9시간 어긋난 사건 시각이 LLM 에 사실로 주입됐다.
  const tz = resolveTimeZone().timeZone;
  L.push(`## 이 미션의 실제 사건 기록 (결정론·as of ${formatDateTime(ctx.asOf, { seconds: true })} ${tz}) — 이 팩의 사실로만 답하라`);
  L.push(`미션: ${ctx.missionId}`);
  L.push(`골: ${ctx.goal.slice(0, 160).replace(/\n/g, ' ')}`);
  const s = ctx.state;
  L.push(`상태: 전체 ${s.total} · 완료 ${s.done} · 실패 ${s.failed} · 건너뜀 ${s.skipped} · 실행중 ${s.running} · 대기 ${s.backlog}`);
  L.push('');
  L.push('페이즈:');
  for (const p of ctx.phases) {
    L.push(`- [P${p.index} ${p.status}] ${p.title.slice(0, 80)}`);
    if (p.failClass || p.rootCause || p.heal) {
      L.push(`    ${p.failClass ? `실패분류: ${p.failClass} · ` : ''}${p.rootCause ? `근본원인: ${p.rootCause.slice(0, 160)} · ` : ''}${p.heal ? `권장힐: ${p.heal}` : ''}`.replace(/ · $/, ''));
    }
    if (p.attempts.length) {
      L.push(`    시도: ${p.attempts.map((a) => `${a.backend.split(':').pop()}(${a.gateResult})`).join(' → ')}`);
    }
    if (p.critiqueVerdict) L.push(`    비평: ${p.critiqueVerdict}`);
    if (p.prUrl) L.push(`    PR: ${p.prUrl}`);
  }
  if (ctx.transitions.length) {
    L.push('');
    L.push('전이(최근):');
    for (const t of ctx.transitions.slice(0, 8)) {
      L.push(`- ${formatDateTime(t.ts, { seconds: true })} ${t.from ?? '?'}→${t.to ?? '?'}${t.rationale ? ` : ${t.rationale}` : ''}`);
    }
  }
  L.push('');
  L.push(`산출 PR(이 미션 소속만): ${ctx.deliverables.length ? ctx.deliverables.map((d) => d.prUrl).join(', ') : '없음'}`);
  if (ctx.degraded) L.push('⚠️ 일부 문맥 조립 실패(불확실) — 그 부분은 확언 금지.');
  L.push('─ 규칙: 위에 없는 PR·사건·페이즈를 지어내지 말 것. 없으면 "이 미션엔 그 기록 없음"이라 답하라(유사 과거 사건 회수 금지).');
  return L.join('\n');
}
