// run-doctor (런 닥터 · L0 TC) — LOOP-AGENT v2 body. Stage 2 of the run lifecycle (detect → diagnose → autopsy).
//
// 세 얼굴:
//   관측 = RED pregates (RES evidence/PREGATE-RED/<pr>-<head12>-<host>/SUMMARY.json · last stage = the failed stage ·
//          red.tar receipt.json `failure` ⊕ last step exit, 124 = timeout) ⊕ failed TA/graph runs (run-ledger stop /
//          run-status failed). KPI re_success_ratio = of the PRs whose first RED in the last 24h is ≥ 1h old, the share
//          that later got a PREGATE-GREEN (null when either evidence lane cannot be read; no RED = 1).
//   판단 근거 = LANDING-KNOWHOW L5 (기반 RED → 다른 호스트) · L7 (main 도 실패 = 기존 간섭) · L9 (규칙 RED = 작성자) ·
//          OPS-RULES 11-27 ④ (기준선 실패는 착지 차단 아님) — encoded in `diagnoseRed`. The old run-doctor supervisor
//          definition (src/supervision/definitions/run-doctor.supervisor.yaml: diagnose ⊕ propose-repair on run.failed /
//          gate.verdict) is reattached here to the pregate/TA subject; failed runs are also recorded as DOCTOR-VISITs
//          (src/self-implement/doctor-visit.ts) so the existing doctor ledger sees them.
//   수복과 인계 = a diagnosis card per failure (own ledger · undo = remove the row) ⊕ ONE automatic repair per PR head:
//          infra-class REDs (timeouts · fetch/checkout/install) are re-run on another admitted host. Content REDs go to
//          the author through the card; if the ratio stays low the KPI breach is carded to TC. Repeated classes
//          (`changed-tsc-timeout@minim5`, `interference-ratchet`) become candidate lessons.
import { join } from 'node:path';
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, BodyCtx, Observation, PlannedAction, Subject } from '../runtime.js';
import { agentHome } from '../memory.js';
import { admittedPregateHosts, pregateLane, readJsonlFile, scanPregateLane, scanRunLedgers, seatStateRoot } from './run-lifecycle-shared.js';
import { pn } from '../policy-context.js';
import { LOOP_CASE_DOMAIN, liveLoopDeps, loopCardBody, loopCardKey, loopDecision, loopFactLine, loopTarget, reconcileLoopCases, type LoopExceptionDeps, type LoopFault } from './loop-exceptions.js';
import { attemptsOf, moveCase, readCases, type Case } from '../../kit/case-ledger/index.js';


export interface RedGate {
  readonly id: string; readonly pr: number | null; readonly head: string; readonly host: string; readonly at: number;
  readonly stage: string; readonly exit: number | null; readonly failure: string | null; readonly mode: string | null; readonly focused: readonly string[];
}
export interface FailedRun { readonly runId: string; readonly graphId: string; readonly at: string; readonly cls: string; readonly stage: string | null }
export type DiagKind = 'infra' | 'content' | 'baseline' | 'unknown';
export interface Diagnosis { readonly cls: string; readonly kind: DiagKind; readonly rx: string }
export interface DiagnosisRow { readonly id: string; readonly at: string; readonly subject: string; readonly cls: string; readonly kind: DiagKind; readonly rx: string; readonly removed?: boolean }
export interface RetryRow { readonly key: string; readonly at: string; readonly host: string; readonly pid?: number }

export interface RunDoctorDeps {
  redGates(now: Date): RedGate[] | null;
  /** PRs with any PREGATE-GREEN, with the newest GREEN time (null = unknown). */
  greens(now: Date): Map<number, number> | null;
  failedRuns(now: Date): FailedRun[] | null;
  hosts(): string[];
  /** A pregate for this head is running now (inflight lock with a live pid). */
  inflight(head12: string): boolean;
  diagnoses(): DiagnosisRow[];
  writeDiagnosis(row: DiagnosisRow): void;
  /** Mirror a failed run into the DOCTOR-VISIT ledger (fail-soft). */
  recordRunVisit(run: FailedRun, d: Diagnosis): void;
  retries(): RetryRow[];
  retry(g: RedGate, host: string): { ok: boolean; pid?: number; line: string };
  recordRetry(r: RetryRow): void;
  /** LOOP-EXCEPTION-WATCH (순찰대 · loop-exceptions.ts): trigger exceptions — retry once · card the owner. Absent = lane off. */
  loops?: LoopExceptionDeps | null;
}

const INFRA_STAGES = new Set(['fetch-main', 'fetch-head', 'fetch-base', 'checkout', 'frozen-install', 'pwa-frozen-install', 'baseline-install']);

/** Deterministic diagnosis of one RED (LANDING-KNOWHOW L5/L7/L9 · OPS-RULES 11-27 ④). */
export function diagnoseRed(g: Pick<RedGate, 'stage' | 'exit' | 'failure' | 'host'>): Diagnosis {
  if (g.exit === 124) return { cls: `${g.stage}-timeout@${g.host}`, kind: 'infra', rx: `${g.host} 에서 ${g.stage} 시간 초과 — 다른 호스트로 한 번 재실행(L5)` };
  if (INFRA_STAGES.has(g.stage)) return { cls: `infra-${g.stage}@${g.host}`, kind: 'infra', rx: `시험 전 단계 ${g.stage} 기반 RED — 다른 호스트로 재실행 · 저장소 수리는 RES(L5)` };
  if (g.stage === 'baseline-focused' && g.failure !== 'FOCUSED_NEW_FAILURE') return { cls: 'baseline-failing-focused', kind: 'baseline', rx: 'main 도 같은 이름으로 실패 — 착지 차단 아님(OPS-RULES 11-27 ④) · 이름 대조만' };
  if (g.failure === 'FOCUSED_NEW_FAILURE' || g.stage === 'focused' || g.stage === 'baseline-focused') return { cls: 'focused-new-failure', kind: 'content', rx: 'main 대비 새 집중 시험 실패 — 작성자 수리(L7)' };
  if (g.stage === 'interference-ratchet') return { cls: 'interference-ratchet', kind: 'content', rx: '간섭 래칫 RED(본문 동적 import 등) — 시험 파일 정적 import 로(L9)' };
  if (g.stage === 'rules-and-ratchets') return { cls: 'rules-and-ratchets', kind: 'content', rx: '규칙 시험 RED — 원문 줄대로 작성자 수리(L9)' };
  if (g.stage === 'diff-check') return { cls: 'diff-check', kind: 'content', rx: 'git diff --check RED(끝 공백·빈 줄) — 작성자 수리' };
  if (g.stage === 'merge-main') return { cls: 'merge-main-conflict', kind: 'content', rx: 'main 병합 충돌 — main 위 새 가지로 다시(L1)' };
  if (g.stage === 'changed-tsc') return { cls: 'tsc-error', kind: 'content', rx: '변경 타입검사 오류 — 작성자 수리' };
  return { cls: `${g.stage || 'unknown'}-red`, kind: 'unknown', rx: '분류 밖 RED — 원문 확인' };
}

export function diagnoseRun(r: FailedRun): Diagnosis {
  if (/provider|auth/u.test(r.cls)) return { cls: `run:${r.cls}`, kind: 'infra', rx: '공급자·자격 실패 — 자격/공급자 상태 확인 뒤 재발사' };
  if (/pod-died|pod-vanished|env-unrelated/u.test(r.cls)) return { cls: `run:${r.cls}`, kind: 'infra', rx: 'Pod·환경 사망 — 다른 호스트로 재발사(런 슈퍼바이저/TA doctor)' };
  return { cls: `run:${r.graphId}:${r.cls}${r.stage ? `@${r.stage}` : ''}`, kind: 'content', rx: '런 내용 실패 — 원장 꼬리를 보고 골 재저작·수확' };
}

const DOCTOR_SYMPTOM_FOR: ReadonlyArray<[RegExp, string]> = [
  [/pod-died|pod-vanished/u, 'child-dead-no-result'], [/review-repeat|review-budget/u, 'review-loop'], [/scope-escape|out-of-scope/u, 'scope-drift'],
  [/provider|auth/u, 'needs-owner'], [/evidence-uncovered/u, 'not-grounded'],
];

export function liveDeps(stateRoot: string, address = 'RUN-DOCTOR'): RunDoctorDeps {
  const seat = seatStateRoot();
  const home = agentHome(stateRoot, 'run-doctor');
  const diagPath = join(home, 'diagnoses.jsonl');
  const retryPath = join(home, 'retries.jsonl');
  const fs = require('node:fs') as typeof import('node:fs');
  const append = (p: string, row: unknown): void => { fs.mkdirSync(home, { recursive: true }); fs.appendFileSync(p, `${JSON.stringify(row)}\n`); };
  const receiptFacts = (dir: string): { exit: number | null; failure: string | null; focused: string[] } => {
    try {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const r = spawnSync('tar', ['xOf', join(dir, 'red.tar'), 'receipt.json'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0) return { exit: null, failure: null, focused: [] };
      const j = JSON.parse(r.stdout) as { failure?: unknown; steps?: Array<{ exit?: unknown }>; focused?: unknown };
      const last = Array.isArray(j.steps) ? j.steps[j.steps.length - 1] : undefined;
      return { exit: typeof last?.exit === 'number' ? last.exit : null, failure: typeof j.failure === 'string' ? j.failure : null,
        focused: Array.isArray(j.focused) ? j.focused.filter((x): x is string => typeof x === 'string') : [] };
    } catch { return { exit: null, failure: null, focused: [] }; }
  };
  const factCache = new Map<string, { exit: number | null; failure: string | null; focused: string[] }>();
  return {
    redGates(now) {
      const reds = scanPregateLane(pregateLane('PREGATE-RED', seat), now.getTime() - pn('window_h') * 3_600_000);
      if (!reds) return null;
      return reds.map(s => {
        let f = factCache.get(s.dir);
        if (!f) { f = receiptFacts(s.dir); factCache.set(s.dir, f); }
        return { id: s.id, pr: s.pr, head: s.head, host: s.host, at: s.at, stage: s.stages[s.stages.length - 1] ?? '', exit: f.exit, failure: f.failure, mode: s.mode, focused: f.focused };
      });
    },
    greens(now) {
      const g = scanPregateLane(pregateLane('PREGATE-GREEN', seat), now.getTime() - 2 * pn('window_h') * 3_600_000);
      if (!g) return null;
      const m = new Map<number, number>();
      for (const s of g) if (s.pr !== null && (m.get(s.pr) ?? 0) < s.at) m.set(s.pr, s.at);
      return m;
    },
    failedRuns(now) {
      const runs = scanRunLedgers(join(stateRoot, 'run-ledger'), now.getTime() - pn('window_h') * 3_600_000);
      if (!runs) return null;
      return runs.filter(r => r.terminal?.failed && Date.parse(r.terminal.at) >= now.getTime() - pn('window_h') * 3_600_000)
        .map(r => ({ runId: r.runId, graphId: r.graphId, at: r.terminal!.at, cls: r.terminal!.kind === 'stop' ? r.terminal!.cls : (r.lastNodeOutcome ?? r.terminal!.cls), stage: r.stage }));
    },
    hosts: () => admittedPregateHosts(seat),
    inflight(h12) {
      const dir = process.env.RES_INFLIGHT_DIR ?? join(seat, 'RES', 'inflight');
      for (const mode of ['full', 'light']) {
        try {
          const pid = Number(fs.readFileSync(join(dir, `${h12}-${mode}.lock`), 'utf8').trim().split(/\s+/u)[0]);
          if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, 0); return true; } catch { /* dead */ } }
        } catch { /* no lock */ }
      }
      return false;
    },
    diagnoses() {
      const rows = readJsonlFile<DiagnosisRow>(diagPath);
      const removed = new Set(rows.filter(r => r.removed).map(r => r.id));
      return rows.filter(r => !r.removed && !removed.has(r.id));
    },
    writeDiagnosis: row => append(diagPath, row),
    recordRunVisit(run, d) {
      try {
        const dv = require('../../self-implement/doctor-visit.js') as typeof import('../../self-implement/doctor-visit.js');
        const symptom = DOCTOR_SYMPTOM_FOR.find(([re]) => re.test(run.cls))?.[1] ?? 'no-progress';
        if (!dv.doctorVisitRunExists(run.runId, { dir: join(stateRoot, 'run-ledger') })) return;
        if (dv.readDoctorVisits(run.runId, { dir: join(stateRoot, 'run-ledger') }).some(v => v.from === 'supervisor')) return;
        dv.recordDoctorVisit({ runId: run.runId, from: 'supervisor', symptom, evidence: `run-doctor: ${d.cls} — ${d.rx}`.slice(0, 300), dir: join(stateRoot, 'run-ledger') });
      } catch { /* fail-soft: the diagnosis card is already in our own ledger */ }
    },
    retries: () => readJsonlFile<RetryRow>(retryPath),
    retry(g, host) {
      if (g.pr === null) return { ok: false, line: `${g.id}: PR 번호 없는 영수(head 입력) — 재실행은 작성자 몫` };
      try {
        const argv = [String(g.pr), '--host', host, ...(g.mode === 'light' ? ['--light'] : []), ...g.focused.flatMap(f => ['--focused', f])];
        const { spawn } = require('node:child_process') as typeof import('node:child_process');
        const child = spawn(join(seat, 'RES', 'tools', 'pregate'), argv, { detached: true, stdio: 'ignore' });
        child.unref();
        return child.pid ? { ok: true, pid: child.pid, line: `pregate ${g.pr} --host ${host} 재실행 pid ${child.pid}` } : { ok: false, line: 'spawn 이 pid 를 주지 않음' };
      } catch (e) { return { ok: false, line: `재실행 실패 — ${e instanceof Error ? e.message : String(e)}` }; }
    },
    recordRetry: r => append(retryPath, r),
    // the owner card goes through the runtime's post port (dedupe · from = this agent's seat), built lazily
    loops: liveLoopDeps(stateRoot, (() => {
      let posting: LoopExceptionDeps['post'] | null = null;
      return (key, to, body, kind) => {
        if (!posting) {
          const { livePorts } = require('../live.js') as typeof import('../live.js');
          const { loadCard } = require('../card.js') as typeof import('../card.js');
          posting = livePorts({ ...loadCard('run-doctor'), address }, { stateRoot, llm: false }).post;
        }
        return posting(key, to, body, kind);
      };
    })()),
  };
}

const retryKey = (g: Pick<RedGate, 'pr' | 'head'>): string => `${g.pr ?? 'x'}-${g.head.slice(0, 12)}`;

export function createBody(env: BodyEnv, deps: RunDoctorDeps = liveDeps(env.stateRoot, env.card.address)): AgentBody {
  // the last observation's loop exceptions (an action only touches what observe just saw)
  let loops = new Map<string, LoopFault>(); let railAt: number | null = null; let cases: Case[] = [];
  const observe = (ctx: BodyCtx): Observation => {
    const nowMs = ctx.now.getTime();
    const reds = deps.redGates(ctx.now);
    const greens = deps.greens(ctx.now);
    const runs = deps.failedRuns(ctx.now);
    const diagnosed = new Set(deps.diagnoses().map(d => d.id));
    const retried = new Set(deps.retries().map(r => r.key));
    const subjects: Subject[] = []; const facts: string[] = []; const patterns: { key: string; lesson: string }[] = [];
    let kpi: number | null = null;
    if (reds && greens) {
      // ratio: per PR, its first RED in the window, settled ≥ settle_min
      const first = new Map<number, number>();
      for (const g of reds) if (g.pr !== null && (!first.has(g.pr) || first.get(g.pr)! > g.at)) first.set(g.pr, g.at);
      const settled = [...first].filter(([, at]) => nowMs - at >= pn('settle_min') * 60_000);
      const recovered = settled.filter(([pr, at]) => (greens.get(pr) ?? 0) > at).length;
      kpi = settled.length ? Math.round((recovered / settled.length) * 100) / 100 : 1;
      facts.push(`RED ${reds.length}(PR ${first.size}) · 재성공 ${recovered}/${settled.length} (창 ${pn('window_h')}h · 1h 지난 것)`);
    } else facts.push(`pregate 증거 읽기 실패(${reds ? '' : 'RED '}${greens ? '' : 'GREEN'}) — 모름`);
    // a pattern counts an event once: only failures that appeared since the previous tick
    const lastTick = ctx.state.lastTickAt ? Date.parse(ctx.state.lastTickAt) : 0;
    for (const g of reds ?? []) {
      const d = diagnoseRed(g);
      const fixed = g.pr !== null && (greens?.get(g.pr) ?? 0) > g.at;
      if (g.at > lastTick) patterns.push({ key: d.kind === 'infra' ? d.cls : d.cls.replace(/@.*/u, ''), lesson: `${d.cls} 꼴 RED 가 반복된다 — ${d.rx}` });
      if (fixed) continue;
      const ageMin = (nowMs - g.at) / 60_000;
      const tags = [diagnosed.has(`red:${g.id}`) ? '진단함' : '', retried.has(retryKey(g)) ? '재실행함' : ''].filter(Boolean).join('·');
      subjects.push({ id: `red:${g.id}`, kind: `red-${d.kind}`, summary: `#${g.pr ?? '?'} ${g.head.slice(0, 8)} @${g.host} ${g.stage}${g.exit !== null ? ` exit ${g.exit}` : ''} → ${d.cls}${tags ? ` (${tags})` : ''}`, ageMin });
    }
    if (runs) {
      facts.push(`실패 런 ${runs.length} (창 ${pn('window_h')}h)`);
      for (const r of runs) {
        const d = diagnoseRun(r);
        if (Date.parse(r.at) > lastTick) patterns.push({ key: d.cls, lesson: `${d.cls} 런 실패가 반복된다 — ${d.rx}` });
        if (!diagnosed.has(`run:${r.runId}`)) subjects.push({ id: `run:${r.runId}`, kind: 'run-failed', summary: `${r.graphId} → ${d.cls}`, ageMin: (nowMs - Date.parse(r.at)) / 60_000 });
      }
    } else facts.push('런 원장 읽기 실패(모름)');
    // LOOP-EXCEPTION-WATCH: trigger runs in `exception` (retry once · card the owner with the reason)
    loops = new Map(); cases = [];
    if (deps.loops) {
      const lf = deps.loops.faults(ctx.now);
      railAt = deps.loops.railAt();
      // reconcile: a case per exception · resolved only when the normal state (last fire done) is seen again
      const rec = lf ? reconcileLoopCases(deps.loops, lf, env.card.address, ctx.now) : null;
      cases = rec ? readCases(deps.loops.caseRoot, LOOP_CASE_DOMAIN) : [];
      facts.push(loopFactLine(lf, nowMs, rec ? rec.unresolved : null));
      if (rec?.resolved.length) facts.push(`정상으로 돌아온 루프 사건 ${rec.resolved.length}: ${rec.resolved.slice(0, 3).join(' · ')}`);
      if (rec?.settled.length) facts.push(`은퇴한 루프의 사건 정리 ${rec.settled.length}: ${rec.settled.slice(0, 3).join(' · ')}`);
      for (const f of lf?.faults ?? []) {
        loops.set(loopTarget(f), f);
        subjects.push({ id: loopTarget(f), kind: 'loop-exception', summary: `${f.graphId} 예외 (창 ${f.window} · 런 ${f.runId ?? '?'} · 노드 ${f.node ?? '?'})${f.tail ? '' : ' · 이유 없음'}`, ageMin: (nowMs - f.at) / 60_000 });
        if (!f.tail && f.at > lastTick) patterns.push({ key: `loop-no-reason:${f.graphId}`, lesson: `${f.graphId} 가 실패 이유 없이 예외로 끝나는 일이 반복된다 — 그 노드가 {"outcome":"fail","why":…} 를 내도록 고친다(관측 결함).` });
      }
      // an open case whose loop is neither exception nor done (a retry still running) past its SLA → escalate too
      for (const c of rec?.open ?? []) {
        if (loops.has(c.id) || nowMs - Date.parse(c.detectedAt) <= c.slaMin * 60_000) continue;
        const [graphId, window] = [c.id.replace(/^loop:/u, '').replace(/@.*$/u, ''), c.id.replace(/^[^@]*@/u, '')];
        loops.set(c.id, { graphId, owner: c.owner, window, at: Date.parse(c.detectedAt), attempt: 0, runId: null, error: null, node: null, tail: '' });
        subjects.push({ id: c.id, kind: 'loop-exception', summary: `${graphId} 미정상화 사건 SLA ${c.slaMin}분 초과 (${c.state})`, ageMin: (nowMs - Date.parse(c.detectedAt)) / 60_000 });
      }
    }
    // patterns: one per class per tick (the runtime counts ticks, not rows)
    const seen = new Set<string>();
    return { kpi, subjects, facts, patterns: patterns.filter(p => (seen.has(p.key) ? false : (seen.add(p.key), true))) };
  };

  const plan = (obs: Observation, ctx: BodyCtx): PlannedAction[] => {
    const diagnosed = new Set(deps.diagnoses().map(d => d.id));
    const retried = new Set(deps.retries().map(r => r.key));
    const reds = new Map((deps.redGates(ctx.now) ?? []).map(g => [`red:${g.id}`, g] as const));
    const repairs: PlannedAction[] = []; const cards: PlannedAction[] = [];
    for (const s of obs.subjects) {
      if (s.kind === 'loop-exception') {
        const f = loops.get(s.id);
        const d = f ? loopDecision(f, cases.find(c => c.id === s.id) ?? null, cases, railAt, ctx.now.getTime()) : 'wait';
        if (d === 'retry') repairs.push({ action: 'retry-loop', target: s.id, why: `${s.summary} — 레일 재기동 창이거나 첫 실패: 레지스트리로 한 번 다시` });
        else if (d === 'card') cards.push({ action: 'card-loop-owner', target: s.id, why: `${s.summary} — 다시 돌려도 실패했거나 정책 밖: 주인(L0)에게 이유와 함께` });
        continue;
      }
      if (s.kind === 'red-infra') {
        const g = reds.get(s.id as `red:${string}`);
        if (g && !retried.has(retryKey(g)) && (s.ageMin ?? 0) <= pn('retry_max_age_h') * 60) {
          repairs.push({ action: 'retry-other-host', target: s.id, why: `${s.summary} — 기반 RED 는 다른 호스트로 한 번(L5)` });
          continue; // the retry writes its own diagnosis card
        }
      }
      if (!diagnosed.has(s.id)) cards.push({ action: 'diagnose', target: s.id, why: s.summary });
    }
    return [...repairs, ...cards];
  };

  const actions: AgentBody['actions'] = {
    'retry-loop': {
      describe: '정상화: 예외로 끝난 루프(트리거) 창을 레지스트리로 다시 무장하고 한 번 돌린다(eln loop trigger tick --only) — ① 레일 재기동 창·첫 실패 ② 이유를 잡은 두 번째까지(loop_normalize_attempts) · 정상(done)은 다음 관측에서 확인 · 되돌릴 것 없음(깨움)',
      run(target, ctx): ActionResult {
        const f = loops.get(target);
        if (!f || !deps.loops) return { ok: false, line: `${target}: 방금 관측에서 예외 루프가 아니다` };
        const r = deps.loops.retry(f.graphId, f.window);
        const c = cases.find(x => x.id === target);
        if (r.ok) moveCase(deps.loops.caseRoot, LOOP_CASE_DOMAIN, target, 'acting', { by: env.card.address, why: `normalize ${(c ? attemptsOf(c) : 0) + 1}: registry retry · failed run ${f.runId ?? '?'} node ${f.node ?? '?'} · ${f.tail ? f.tail.slice(-200) : 'no-reason'}`, ...(f.runId ? { refs: [`run:${f.runId}`] } : {}) }, ctx.now);
        return { ok: r.ok, line: r.line, ref: `loop:${f.graphId}`, ...(r.ok ? { undo: '없음 — 창을 다시 무장해 한 번 돌린 것뿐 · 정상(done)은 다음 관측에서 확인' } : {}) };
      },
    },
    'card-loop-owner': {
      describe: '다시 돌려도 예외인 루프(또는 정책 밖 예외)를 그 루프의 주인(L0)에게 카드 한 장으로 — 런 id · 실패 노드 · 출력 끝(없으면 «이유 없음» 이라고 말한다) · 창당 1회',
      run(target, ctx): ActionResult {
        const f = loops.get(target);
        if (!f || !deps.loops) return { ok: false, line: `${target}: 방금 관측에서 예외 루프가 아니다` };
        const c = cases.find(x => x.id === target);
        const id = deps.loops.post(loopCardKey(f), f.owner, loopCardBody(f, c ? attemptsOf(c) : 0, ctx.now.getTime()), 'request');
        if (id === false) return { ok: false, line: `${target}: ${f.owner} 카드 우편 실패 — 다음 틱에 다시` };
        moveCase(deps.loops.caseRoot, LOOP_CASE_DOMAIN, target, 'escalated', { by: env.card.address, why: `escalated to ${f.owner}${typeof id === 'number' || typeof id === 'string' ? ` #${id}` : ''} — ${c && attemptsOf(c) ? `ladder exhausted (${attemptsOf(c)} normalize)` : 'out of policy or SLA'}${f.tail ? '' : ' · no-reason'}` }, ctx.now);
        const noReason = f.tail ? '' : ' · no-reason(관측 결함: 노드가 실패 이유를 남기지 않음)';
        return { ok: true, line: `${f.graphId} 예외 → ${f.owner} 카드${id === null ? '(이미 보냄)' : ` #${id}`}${noReason}`, ref: id === null ? `loop:${f.graphId}` : `msg:${id}`, undo: '없음 — 알림 한 장(창당 멱등 키)' };
      },
    },
    diagnose: {
      describe: '실패 하나(RED pregate · 실패 런)에 진단 카드(분류 · 종류 · 처방)를 내 원장에 쓴다 · 실패 런은 DOCTOR-VISIT 에도 — 되돌림: 카드 행 삭제 표시',
      run(target, ctx): ActionResult {
        if (deps.diagnoses().some(d => d.id === target)) return { ok: true, line: `${target}: 이미 진단함` };
        let d: Diagnosis | null = null; let subject = target;
        if (target.startsWith('red:')) {
          const g = deps.redGates(ctx.now)?.find(x => `red:${x.id}` === target);
          if (g) { d = diagnoseRed(g); subject = `#${g.pr ?? '?'} ${g.head.slice(0, 12)} @${g.host} ${g.stage}`; }
        } else if (target.startsWith('run:')) {
          const r = deps.failedRuns(ctx.now)?.find(x => `run:${x.runId}` === target);
          if (r) { d = diagnoseRun(r); subject = `${r.graphId} ${r.runId}`; deps.recordRunVisit(r, d); }
        }
        if (!d) return { ok: false, line: `${target}: 다시 읽으니 실패 대상이 없다` };
        deps.writeDiagnosis({ id: target, at: ctx.now.toISOString(), subject, cls: d.cls, kind: d.kind, rx: d.rx });
        return { ok: true, line: `진단 ${target}: ${d.cls} (${d.kind}) — ${d.rx}`, ref: target, undo: `진단 카드 ${target} 삭제 표시(diagnoses.jsonl {id, removed:true})` };
      },
    },
    'retry-other-host': {
      describe: '기반(infra) RED 한 건을 다른 허용 호스트로 pregate 한 번 재실행한다(PR·head 당 1회 · 같은 head 도는 중이면 안 함 · 진단 카드도 함께) — 되돌림: 새 pid 재확인 뒤 정확 PID 종료',
      run(target, ctx): ActionResult {
        const g = deps.redGates(ctx.now)?.find(x => `red:${x.id}` === target);
        if (!g) return { ok: false, line: `${target}: 다시 읽으니 RED 가 없다` };
        if (diagnoseRed(g).kind !== 'infra') return { ok: false, line: `${target}: 기반 RED 가 아니다 — 재실행은 작성자 몫` };
        const key = retryKey(g);
        if (deps.retries().some(r => r.key === key)) return { ok: false, line: `${target}: 이 head 는 이미 한 번 재실행했다(1회 한도)` };
        if (deps.inflight(g.head.slice(0, 12))) return { ok: false, line: `${target}: 같은 head pregate 가 도는 중 — 기다린다` };
        const host = deps.hosts().find(h => h !== g.host);
        if (!host) return { ok: false, line: `${target}: ${g.host} 말고 허용 호스트가 없다` };
        const d = diagnoseRed(g);
        if (!deps.diagnoses().some(x => x.id === target))
          deps.writeDiagnosis({ id: target, at: ctx.now.toISOString(), subject: `#${g.pr ?? '?'} ${g.head.slice(0, 12)} @${g.host} ${g.stage}`, cls: d.cls, kind: d.kind, rx: `${d.rx} → ${host} 재실행` });
        const r = deps.retry(g, host);
        if (r.ok) deps.recordRetry({ key, at: ctx.now.toISOString(), host, ...(r.pid ? { pid: r.pid } : {}) });
        return { ok: r.ok, line: r.line, ref: target, ...(r.pid ? { undo: `pid ${r.pid} 명령줄 재확인 뒤 정확 PID 종료` } : {}) };
      },
    },
  };
  return { observe, plan, actions };
}
