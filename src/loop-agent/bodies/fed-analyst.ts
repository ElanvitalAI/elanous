// 연방 분석관 (fed-analyst) — LOOP-AGENT v3 body (FED-ANALYST-LOOP-AGENT · 0.3.39 P1 · L0 OP).
//
// S: the 30-min federation analysis (six «finding → who · what · re-check» lines ⊕ the topology pass board) was a Claude OP
//    subagent re-armed by hand — 11-27 13:07–15:27 it simply did not run.
// C: an analysis that depends on a session being armed is not a loop; and numbers re-derived by hand drift window to window.
// A: 세 얼굴 —
//   관측 = src/fed-analyst/live.ts gatherInputs (msg store window ⊕ fed kpi at the window end ⊕ throughput controller row ⊕
//          open ✋ ⊕ trigger registry ⊕ active board) → src/fed-analyst/analyze.ts (pure · LLM 0). KPI = minutes since the last
//          published window (target ≤ window ⊕ slack) — «틱 완료» is the row, «목표 완료» is the row being ≤ 35 min old.
//   판단 근거 = the pass board thresholds (agent.yaml policies · pv) ⊕ the owner of each finding (lever owner · ✋ receiver ·
//          trigger owner · dormant reader).
//   수복과 인계 = `publish` writes the window (analyst ledger ⊕ FED-ANALYST-NOW.md ⊕ the OP world card reads it) with ONE
//          cheap-tier LLM call for the prose (numbers guarded) · `case` opens a kit/case-ledger case for a breached finding's
//          owner (idempotent) and a finding that reads ok again resolves it. Undo: none needed — append-only rows, the NOW file
//          is rewritten every window, a case resolves on its own when the normal state is observed.
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { pv } from '../policy-context.js';
import { type Analysis, type AnalystNumbers, analyze, DEFAULT_NUMBERS, renderAnalysis } from '../../fed-analyst/analyze.js';
import type { AnalystRow } from '../../fed-analyst/live.js';
import type { VoiceLlm } from '../role-llm.js';

export const SELF_ADDRESS = 'FED-ANALYST';
/** KPI when no window was ever published (an «infinitely old» analysis — never read as 0). */
export const NEVER_PUBLISHED_MIN = 999; // not-policy: sentinel age for «never published» (compared by identity, not a bound)

/** The window the tick analyses ends on the last window boundary (:00 / :30 for 30 min) — the same windows the chat-log
 *  collector and the Claude analyst used; a tick at :02 reads [:30, :00). */
export function alignedEnd(now: Date, windowMin: number): Date {
  const w = windowMin * 60_000;
  return new Date(Math.floor(now.getTime() / w) * w);
}

export interface AnalystDeps {
  gather(now: Date, windowMin: number): Promise<{ inputs: import('../../fed-analyst/analyze.js').Inputs; unread: string[] }>;
  latest(): AnalystRow | null;
  write(row: AnalystRow): boolean;
  openCase(a: Analysis, key: string, now: Date, slaMin: number): boolean;
  resolveOk(a: Analysis, now: Date): string[];
  llm(): VoiceLlm | null;
  prose(a: Analysis, llm: VoiceLlm | null): Promise<{ prose: Partial<Record<string, string>>; model: string | null; used: boolean; why: string }>;
}

function liveDeps(stateRoot: string): AnalystDeps {
  // lazy requires: a tick that never publishes never loads the msg store / LLM stack
  const live = () => require('../../fed-analyst/live.js') as typeof import('../../fed-analyst/live.js');
  return {
    gather: (now, windowMin) => live().gatherInputs({ at: now, windowMin, instanceRoot: stateRoot }),
    latest: () => live().latestAnalysis(stateRoot),
    write: row => live().writeAnalysis(stateRoot, row),
    openCase(a, key, now, slaMin) {
      const ck = require('../../kit/case-ledger/index.js') as typeof import('../../kit/case-ledger/index.js');
      const f = a.findings.find(x => x.key === key);
      if (!f || f.status !== 'breach' || !f.action) return false;
      return ck.openCase(stateRoot, { domain: live().CASE_DOMAIN, id: `fed:${key}`, subject: `${f.title}: ${f.facts}`.slice(0, 300), owner: f.action.who, slaMin,
        by: 'loop:fed-analyst', why: `${f.action.what} · 재확인 ${f.action.recheckAt}(${f.action.criterion})`.slice(0, 300) }, now) !== null;
    },
    resolveOk(a, now) {
      // only the ok side of syncCases (opening is the `case` action's right)
      const okOnly: Analysis = { ...a, findings: a.findings.filter(f => f.status === 'ok') };
      return live().syncCases(stateRoot, okOnly, now, 0).resolved;
    },
    llm: () => (require('../../fed-analyst/prose.js') as typeof import('../../fed-analyst/prose.js')).liveProseLlm(),
    prose: (a, llm) => (require('../../fed-analyst/prose.js') as typeof import('../../fed-analyst/prose.js')).proseLines(a, llm),
  };
}

const numbersNow = (): AnalystNumbers => {
  const out: Record<string, number> = {};
  for (const [k, d] of Object.entries(DEFAULT_NUMBERS)) out[k] = pv(k, d);
  return out as unknown as AnalystNumbers;
};

export function createBody(env: BodyEnv, deps: AnalystDeps = liveDeps(env.stateRoot)): AgentBody {
  let current: { a: Analysis; unread: string[]; n: AnalystNumbers } | null = null;

  const observe = async (ctx: { now: Date }): Promise<Observation> => {
    const n = numbersNow();
    const last = deps.latest();
    const age = last ? Math.max(0, Math.round((ctx.now.getTime() - Date.parse(last.windowEnd)) / 60_000)) : NEVER_PUBLISHED_MIN;
    let a: Analysis;
    let unread: string[];
    try { const g = await deps.gather(alignedEnd(ctx.now, n.window_min), n.window_min); a = analyze(g.inputs, n); unread = g.unread; }
    catch (e) { current = null; return { kpi: null, subjects: [], facts: [`분석 입력 읽기 실패 → 모름 (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`] }; }
    current = { a, unread, n };
    const due = age >= n.window_min - pv('publish_slack_min', 3);
    const subjects: Subject[] = [
      ...(due ? [{ id: 'window', kind: 'window-due', summary: `지난 분석 ${age === NEVER_PUBLISHED_MIN ? '없음' : `${age}분 전`} — ${n.window_min}분 창 발행 차례`, ageMin: age }] : []),
      ...a.findings.filter(f => f.status === 'breach' && f.action).map(f => ({ id: f.key, kind: `finding-${f.key}`, summary: `${f.title}: ${f.facts.slice(0, 120)} → ${f.action!.who}` })),
    ];
    return {
      kpi: age, subjects,
      facts: [...renderAnalysis(a), ...(unread.length ? [`unread(?): ${unread.join(', ')}`] : [])],
      patterns: a.findings.filter(f => f.status === 'breach').map(f => ({ key: `breach:${f.key}`,
        lesson: `«${f.title}» 이 창마다 기준 밖이다 — 조치 주인(${f.action?.who ?? '?'})이 움직이지 않으면 그 주인의 깨움 경로를 OP 가 먼저 본다.` })),
    };
  };

  const plan = (obs: Observation): PlannedAction[] => [
    ...obs.subjects.filter(s => s.id === 'window').map(s => ({ action: 'publish', target: 'window', why: s.summary })),
    ...obs.subjects.filter(s => s.id !== 'window').map(s => ({ action: 'case', target: s.id, why: s.summary })),
  ];

  const actions: AgentBody['actions'] = {
    publish: {
      describe: '이 창의 여섯 줄 ⊕ 합격판을 분석 원장(loops/fed-analyst.jsonl) ⊕ seat-state/OP/pulse/FED-ANALYST-NOW.md 에 쓴다(세계 카드가 읽는다) · 문장만 싼 LLM 한 번(숫자는 결정적 줄 그대로) · 기준 안으로 돌아온 줄의 사건은 닫는다',
      async run(_t, ctx): Promise<ActionResult> {
        if (!current) return { ok: false, line: '방금 관측이 없다(입력 읽기 실패) — 발행하지 않음' };
        const { a, unread } = current;
        const want = pv('prose_llm_per_tick', 1) > 0;
        const p = want ? await deps.prose(a, deps.llm()) : { prose: {}, model: null, used: false, why: 'prose_llm_per_tick 0' };
        const lines = renderAnalysis(a, p.prose as Parameters<typeof renderAnalysis>[1]);
        const live = require('../../fed-analyst/live.js') as typeof import('../../fed-analyst/live.js');
        const row: AnalystRow = { at: ctx.now.toISOString(), windowStart: a.windowStart, windowEnd: a.windowEnd, passed: a.passed, bottleneck: a.bottleneck,
          numbers: live.analystNumbers(a), findings: a.findings, lines, prose: { model: p.model, used: p.used, why: p.why }, unread };
        if (!deps.write(row)) return { ok: false, line: '분석 원장·NOW 쓰기 실패 — 다음 틱이 다시 쓴다', ref: 'loops/fed-analyst.jsonl' };
        const resolved = (() => { try { return deps.resolveOk(a, ctx.now); } catch { return []; } })();
        return { ok: true, line: `창 ${a.windowStart.slice(11, 16)}–${a.windowEnd.slice(11, 16)}Z 발행 · 합격판 ${a.passed}/6 · 기준 밖 ${a.findings.filter(f => f.status === 'breach').length}줄 · 문장 ${p.used ? p.model : `템플릿(${p.why})`}${resolved.length ? ` · 사건 닫음 ${resolved.join(',')}` : ''}`,
          ref: 'loops/fed-analyst.jsonl', undo: '없음 — 원장은 덧붙이기만, NOW 파일은 창마다 다시 쓴다' };
      },
    },
    case: {
      describe: '기준 밖 줄(조치 주인 있음)마다 사건 원장(cases/fed-analyst.jsonl)에 사건 하나 — 주인 ⊕ 재확인 SLA · 같은 사건은 열린 동안 다시 쓰지 않는다',
      run(target, ctx): ActionResult {
        if (!current) return { ok: false, line: '방금 관측이 없다 — 사건 없음' };
        const f = current.a.findings.find(x => x.key === target);
        if (!f || f.status !== 'breach' || !f.action) return { ok: false, line: `${target}: 방금 관측에서 기준 밖이 아니다` };
        if (!deps.openCase(current.a, target, ctx.now, current.n.recheck_min)) return { ok: false, line: `${target}: 사건 쓰기 실패 — 다음 틱이 다시 연다`, ref: `fed:${target}` };
        return { ok: true, line: `사건 fed:${target} → ${f.action.who} · ${f.action.what.slice(0, 80)} · 재확인 ${f.action.recheckAt}`, ref: `fed:${target}`, undo: '없음 — 정상이 관측되면 publish 가 닫는다' };
      },
    },
  };

  return { observe, plan, actions };
}
