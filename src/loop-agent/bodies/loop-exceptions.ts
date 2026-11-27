// LOOP-EXCEPTION-WATCH (대표 11-27 «이런 식으로 루프 에이전트를 감시해야» · GUARDIAN.md §2 순찰대 = run-supervisor · run-doctor ·
// autopsy) — run-doctor's loop lane: a registered trigger whose last fire ended in `exception` was nobody's job (watchers-check
// only checks that supervisors beat; release-traffic stayed red on the LOOPS tab after rail 95's els kickstart).
//
// 세 얼굴:
//   관측 = the trigger registry (listTriggers · listFires — status `exception`) ⊕ the failed graph run
//          (`{stateRoot}/graph-runs/<graph>/<run>.json`: the failing node and its error/output tail) ⊕ the rail fact from
//          레일지기 (`{stateRoot}/land-graph/rail-watch.json` at · the installed build's install.json mtime).
//   판단 근거 = reconcile (대표 «1. 본다 2. 문제가 있을 경우 정상화를 한다» · kit/case-ledger): NORMAL = the loop's last fire is
//          `done`. Every exception is a case (domain `loop-exception` · owner = the trigger owner · SLA `loop_case_sla_min`).
//          NORMALIZE ladder (agent.yaml policies): ① retry once through the registry — only for a restart casualty (began
//          within `rail_window_min` after a rail) or the loop's first failure of the day · ② retry again with the reason
//          captured (the failed run's node output is read into the case) — up to `loop_normalize_attempts`. The case is
//          resolved only when the next observation sees the normal state. ESCALATE (one card to the owner with run id ·
//          failing node · output tail, or «no-reason» said aloud) is the last resort: ladder exhausted, out of policy, or
//          the SLA passed. `loop_exception_min`: an exception younger than this is the registry's own retry business.
//   수복과 인계 = `retry-loop` re-arms that window (registry retryWindow · attempt 0) and fires `eln loop trigger tick --only`
//          (idempotent: a window that is no longer `exception` is not touched) → case `acting` · `card-loop-owner` mails
//          once per window (dedupe key) through the runtime's post port → case `escalated`. The runtime journals both; the
//          case ledger journals every transition.
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pv } from '../policy-context.js';
import { attemptsOf, moveCase, openCase, openCases, readCases, unresolvedCases, type Case } from '../../kit/case-ledger/index.js';

/** kit/case-ledger domain of this lane (`<stateRoot>/cases/loop-exception.jsonl`). */
export const LOOP_CASE_DOMAIN = 'loop-exception';
/** Normalize attempts (retries through the registry) before the case is escalated. */
export const LOOP_NORMALIZE_ATTEMPTS = 2; // 출처: 대표 11-27 사다리 — ① 한 번 다시 ② 이유를 잡으며 다시 → 그다음 카드
/** A loop case not normal again within this many minutes is escalated whatever the ladder says. */
export const LOOP_CASE_SLA_MIN = 60; // 출처: run-doctor escalate_after_min 120 의 절반 — 루프 예외는 착지·발행 박자를 막는다

/** An exception younger than this is left to the registry's own backoff retries. */
export const LOOP_EXCEPTION_MIN = 5; // 출처: graphs/triggers/*.yaml failure.backoff_sec [60] × max_attempts 2 — the registry's own retry is done by then
/** An exception that began within this many minutes after a rail is a restart casualty → retry once. */
export const RAIL_WINDOW_MIN = 20; // 출처: rail = install ⊕ els kickstart ⊕ rail-watch smokes (≤ 10 min tick) — 11-27 release-traffic failed 22:21:58 right after rail 95
const DAY_MS = 86_400_000; // 출처: «first failure» = no retry/card for this loop in the last day

export interface LoopFault {
  readonly graphId: string; readonly owner: string; readonly window: string;
  /** When the fire entered its current state (ms). */
  readonly at: number;
  readonly attempt: number; readonly runId: string | null;
  /** The registry's own error column (may be empty). */
  readonly error: string | null;
  /** The failing node of the run and its error/output tail ('' = the run left no reason). */
  readonly node: string | null; readonly tail: string;
}
export interface LoopScan {
  readonly total: number;
  /** Loops whose last fire is `exception`. */
  readonly faults: LoopFault[];
  /** graphId → its last fire status (`done` = the normal state). */
  readonly status: Readonly<Record<string, string | null>>;
}
export interface LoopExceptionDeps {
  /** Registered (non-retired) loops, the ones in `exception` and every loop's last status (null = registry unreadable). */
  faults(now: Date): LoopScan | null;
  /** Where the case ledger lives (`<root>/cases/loop-exception.jsonl`). */
  readonly caseRoot: string;
  /** The last rail (ms) from 레일지기 facts · null = unknown. */
  railAt(): number | null;
  /** Re-arm the window and fire the loop once (idempotent). */
  retry(graphId: string, window: string): { ok: boolean; line: string };
  /** The runtime's deduped post port (wiring passes ports.post). id = sent · null = already sent · false = could not send. */
  post(key: string, to: string, body: string, kind?: string): number | string | null | false;
}

export const loopTarget = (f: Pick<LoopFault, 'graphId' | 'window'>): string => `loop:${f.graphId}@${f.window}`;
export const loopCardKey = (f: Pick<LoopFault, 'graphId' | 'window'>): string => `loop-exception:${f.graphId}:${f.window}`;
const ageMin = (f: LoopFault, now: number): number => Math.max(0, Math.round((now - f.at) / 60_000));

const graphOf = (caseId: string): string => caseId.replace(/^loop:/u, '').replace(/@.*$/u, '');

/** Reconcile (observe side): open a case per exception · resolve an open case whose loop is normal (`done`) again. */
export function reconcileLoopCases(deps: Pick<LoopExceptionDeps, 'caseRoot'>, scan: LoopScan, by: string, now: Date): { open: Case[]; unresolved: number; resolved: string[] } {
  const resolved: string[] = [];
  for (const f of scan.faults) openCase(deps.caseRoot, { domain: LOOP_CASE_DOMAIN, id: loopTarget(f), subject: `${f.graphId} 예외 (창 ${f.window})`, owner: f.owner,
    slaMin: pv('loop_case_sla_min', LOOP_CASE_SLA_MIN), by, why: `last fire exception · run ${f.runId ?? '?'} · node ${f.node ?? '?'}${f.tail ? '' : ' · no-reason'}`, ...(f.runId ? { refs: [`run:${f.runId}`] } : {}) }, now);
  const faultIds = new Set(scan.faults.map(loopTarget));
  for (const c of unresolvedCases(readCases(deps.caseRoot, LOOP_CASE_DOMAIN))) {
    if (faultIds.has(c.id)) continue;
    if (scan.status[graphOf(c.id)] === 'done') { moveCase(deps.caseRoot, LOOP_CASE_DOMAIN, c.id, 'resolved', { by, why: 'normal again: the loop\'s last fire is done (re-observed)' }, now); resolved.push(c.id); }
  }
  const all = readCases(deps.caseRoot, LOOP_CASE_DOMAIN);
  return { open: openCases(all), unresolved: unresolvedCases(all).length, resolved };
}

/** The ladder step for one exception: normalize (retry) · escalate (card) · wait (the registry or a retry is still running) · done. */
export function loopDecision(f: LoopFault, c: Case | null, cases: readonly Case[], railAt: number | null, now: number): 'retry' | 'card' | 'wait' | 'done' {
  if (c?.state === 'escalated' || c?.state === 'resolved') return 'done';
  if (c && now - Date.parse(c.detectedAt) > c.slaMin * 60_000) return 'card'; // SLA passed — never stays «seen»
  if (now - f.at < pv('loop_exception_min', LOOP_EXCEPTION_MIN) * 60_000) return 'wait';
  const attempts = c ? attemptsOf(c) : 0;
  if (attempts >= pv('loop_normalize_attempts', LOOP_NORMALIZE_ATTEMPTS)) return 'card'; // ladder exhausted
  if (attempts > 0) return 'retry'; // ② continue the ladder (the reason of the failed retry is captured in the case)
  const inRail = railAt !== null && f.at >= railAt && f.at - railAt <= pv('rail_window_min', RAIL_WINDOW_MIN) * 60_000;
  const failedBefore = cases.some(x => x.id !== loopTarget(f) && graphOf(x.id) === f.graphId && now - Date.parse(x.detectedAt) < DAY_MS);
  return inRail || !failedBefore ? 'retry' : 'card'; // ① restart casualty or first failure → normalize · else out of policy
}

/** One fact line for the observation (and the voice): «루프 ok n/m · 루프 예외 k: … · 미정상화 사건 j». */
export function loopFactLine(r: LoopScan | null, now: number, open: number | null = null): string {
  if (!r) return '루프(트리거 레지스트리) 읽기 실패 — 모름';
  const ex = r.faults.map(f => `${f.graphId} ${ageMin(f, now)}분${f.tail ? '' : ' (이유 없음)'}`);
  return `루프 ok ${r.total - r.faults.length}/${r.total} · 루프 예외 ${r.faults.length}${ex.length ? `: ${ex.slice(0, 5).join(' · ')}` : ''}${open === null ? '' : ` · 미정상화 사건 ${open}`}`;
}

/** The owner card body (run id · failing node · output tail, or «no-reason» said aloud). */
export function loopCardBody(f: LoopFault, attempts: number, now: number): string {
  const reason = f.tail ? `출력 끝: ${f.tail.slice(-400)}` : '이유 출력 없음(no-reason) — 관측 결함: 실패한 노드가 이유를 남기지 않는다(노드가 {"outcome":"fail","why":…} 를 내야 한다)';
  return [`[런 닥터 → L0 ${f.owner}] 루프 ${f.graphId} 예외 ${ageMin(f, now)}분 (창 ${f.window} · 시도 ${f.attempt})`,
    attempts ? `정상화 ${attempts}번(레지스트리로 다시 돌림) 했으나 정상(done)으로 돌아오지 않았다 — 마지막 수단으로 올린다` : '정책 밖(레일 재기동 창이 아니고 같은 루프가 하루 안에 이미 실패했다) 또는 SLA 초과 — 재시도 없이 올린다',
    `런 ${f.runId ?? '?'} · 실패 노드 ${f.node ?? '?'}${f.error ? ` · 레지스트리 오류 ${f.error.slice(0, 160)}` : ''}`,
    reason, `다시 돌리기: eln loop trigger retry ${f.graphId} --window ${f.window}`].join('\n');
}

// ── live deps ────────────────────────────────────────────────────────────────────────────────────────────────────────
const tailOf = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.trim().slice(-400);
};

/** The failing node and its reason from a graph run state file (missing file → nulls). */
export function runFailure(stateRoot: string, graphId: string, runId: string | null): { node: string | null; tail: string } {
  if (!runId) return { node: null, tail: '' };
  try {
    const p = join(stateRoot, 'graph-runs', graphId, `${runId}.json`);
    if (!existsSync(p)) return { node: null, tail: '' };
    const s = JSON.parse(readFileSync(p, 'utf8')) as { reason?: string; path?: string[]; nodes?: Array<{ nodeId: string; ok: boolean; output?: unknown; error?: string; reason?: string; failure?: { message?: string } }> };
    const bad = [...(s.nodes ?? [])].reverse().find(n => !n.ok);
    const node = bad?.nodeId ?? s.path?.at(-1) ?? null;
    const tail = [bad?.failure?.message, bad?.error, bad?.reason, tailOf(bad?.output), s.reason].map(x => (x ?? '').trim()).filter(Boolean).join(' · ');
    // an output that only says {"outcome":"fail"} carries no reason
    return { node, tail: /^\{"outcome":"(fail|error)"\}$/u.test(tail) ? '' : tail.slice(-400) };
  } catch { return { node: null, tail: '' }; }
}

/** 레일지기 facts: the newest of rail-watch's «new rail seen» and the installed build's install.json write. */
export function liveRailAt(stateRoot: string): number | null {
  const at: number[] = [];
  try { const j = JSON.parse(readFileSync(join(stateRoot, 'land-graph', 'rail-watch.json'), 'utf8')) as { at?: string }; if (j.at && Number.isFinite(Date.parse(j.at))) at.push(Date.parse(j.at)); } catch { /* none */ }
  try { const cur = join(homedir(), '.local', 'share', 'elanous', 'current'); at.push(lstatSync(cur).mtimeMs); at.push(statSync(join(cur, 'install.json')).mtimeMs); } catch { /* none */ }
  return at.length ? Math.max(...at) : null;
}

export function liveLoopDeps(stateRoot: string, post: LoopExceptionDeps['post']): LoopExceptionDeps {
  type Reg = typeof import('../../loops/trigger-registry.js');
  const reg = (): Reg => require('../../loops/trigger-registry.js') as Reg;
  return {
    faults(_now) {
      try {
        const r = reg(); const db = r.openTriggerRegistry(stateRoot);
        try {
          const rows = r.listTriggers(db).filter(t => t.stage !== 'retired');
          const faults = rows.filter(t => t.lastStatus === 'exception').map(t => {
            const fire = r.listFires(db, t.graphId, 1)[0];
            const runId = fire?.runId ?? t.lastRunId;
            const rf = runFailure(stateRoot, t.graphId, runId);
            return { graphId: t.graphId, owner: t.owner, window: fire?.window ?? t.lastWindow ?? '', at: Date.parse(t.lastAt ?? '') || Date.now(),
              attempt: fire?.attempt ?? 0, runId, error: fire?.error ?? null, node: rf.node, tail: rf.tail || (fire?.error ?? '').trim() };
          });
          return { total: rows.length, faults, status: Object.fromEntries(rows.map(t => [t.graphId, t.lastStatus ?? null])) };
        } finally { db.close(); }
      } catch { return null; }
    },
    caseRoot: stateRoot,
    railAt: () => liveRailAt(stateRoot),
    retry(graphId, window) {
      try {
        const r = reg(); const db = r.openTriggerRegistry(stateRoot);
        let armed: boolean;
        try { armed = r.retryWindow(db, graphId, window); } finally { db.close(); }
        if (!armed) return { ok: false, line: `${graphId}@${window}: 이 창은 이제 exception 이 아니다(이미 다시 돌거나 끝남)` };
        const { spawnElanous } = require('../../instance/spawn-elanous.js') as typeof import('../../instance/spawn-elanous.js');
        const child = spawnElanous(['loop', 'trigger', 'tick', '--only', graphId], { stateDir: stateRoot, detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true, line: `${graphId}@${window} 다시 무장 · eln loop trigger tick --only ${graphId}${child.pid ? ` (pid ${child.pid})` : ''}` };
      } catch (e) { return { ok: false, line: `${graphId}@${window} 재시도 실패 — ${e instanceof Error ? e.message : String(e)}` }; }
    },
    post,
  };
}
