/**
 * STOP-AUTOHEAL (0.2.20 P0 · 첫 조각) — 멈춘 런의 stop 레코드(STOP-RECORD #24907)를 읽고
 * 갈래마다 «한 번»만 스스로 고쳐 본다. 안 되면 `needs-owner` 로 사람에게 넘긴다.
 *
 * S: 런이 멈추면 원장에 `event='stop'` 한 줄(class·cause·evidenceRef·nextMove)이 남는다.
 * C: 그 줄을 읽는 쪽이 없어서 환경 결손·main 동기화·Pod 사망·증거 누락처럼 «기계가 고칠 수 있는» 멈춤도 사람을 기다렸다.
 * Q: 갈래별로 한 수를 정해 두고 «한 번만» 시도할 수 있나?
 * A: `autohealFromStop` 하나가 class → action 을 고르고, 원장 `event='autoheal'` 줄로 시도를 남긴다.
 *    같은 런·같은 갈래·같은 모드에 이미 줄이 있으면 다시 하지 않는다(원장 가드).
 *
 * 사다리(class → action):
 *   env-unrelated      → clean-workspace-regate   깨끗한 자리에서 gate 만 다시 1회(GATE-ENV-RETRY 재사용 자리)
 *   main-sync          → rebase-regate            리베이스(MERGE-INTENT-RESOLVE 의도 해석) 뒤 재게이트
 *   pod-died           → resume-from-salvage      `salvage/run-<6hex>/<leaf>` 가지에서 resume(DRAFT-NOT-ARCHIVE)
 *   evidence-uncovered → derive-evidence-rejudge  런 출력·시험·배선에서 증거를 끌어내 1회 재판정
 *   review-repeat · review-out-of-scope · fabric · launch-failed · unclassified → needs-owner(새 라운드 없음)
 *
 * 사다리의 «출처»: `graphs/overlays/stop-heal-ladder.yaml` 이 갈래마다 처방 노드(id = 처방 이름)를 선언한다.
 *    그 갈래에 얹힌 오버레이가 더한 노드 id 가 처방이다(source='graph'). 선언이 없거나 못 읽으면
 *    위 표(`AUTOHEAL_ACTION_BY_CLASS`)로 간다(source='code-default'). 둘이 같은 답을 내는지는 시험이 문다.
 *
 * 모드 `tools.selfImplement.autoheal.mode` = `shadow`(기본: 할 일을 원장에만 적고 손대지 않는다) | `live`.
 * ⛔ live 에서도 행동은 주입 seam 으로만 한다 — seam 이 없는 행동은 `needs-owner`(action-unwired)로 떨어진다.
 *    «안 이어진 손»을 「고쳤다」로 읽지 않게.
 * 관측 = `debug.log('self-implement.autoheal', …)` ⊕ 원장 `event='autoheal'`.
 */
import { debug } from '../debug/log.js';
import { applyGraphOverlays, defaultOverlaysDir, loadGraphOverlays, selectOverlays, type GraphOverlaySpec } from './graph-overlay-yaml.js';
import type { GraphTemplateSpec } from './graph-yaml.js';
import { GRAPH_SPECS } from './graph-templates.js';
import { appendRunLedgerEntry, loadRunLedger, type RunLedgerEntry, type RunLedgerWriter } from './run-ledger.js';
import type { RunStopClass, RunStopRecord } from './run-stop.js';

export const AUTOHEAL_EVENT = 'autoheal';
export type AutohealMode = 'shadow' | 'live';
export const DEFAULT_AUTOHEAL_MODE: AutohealMode = 'shadow';

export type AutohealAction =
  | 'clean-workspace-regate'
  | 'rebase-regate'
  | 'resume-from-salvage'
  | 'derive-evidence-rejudge'
  | 'needs-owner';

/** 닫힌 목록 전체를 덮는다 — 새 class 가 생기면 여기서 타입 오류가 난다. */
export const AUTOHEAL_ACTION_BY_CLASS: Readonly<Record<RunStopClass, AutohealAction>> = {
  'env-unrelated': 'clean-workspace-regate',
  'main-sync': 'rebase-regate',
  'pod-died': 'resume-from-salvage',
  'evidence-uncovered': 'derive-evidence-rejudge',
  'review-repeat': 'needs-owner',
  'review-out-of-scope': 'needs-owner',
  fabric: 'needs-owner',
  'launch-failed': 'needs-owner',
  unclassified: 'needs-owner',
};

/** 처방 노드 id 로 인정하는 이름 — 오버레이가 더한 노드 중 이 넷만 처방으로 읽는다. */
const HEAL_ACTION_NODE_IDS: ReadonlySet<string> = new Set<Exclude<AutohealAction, 'needs-owner'>>([
  'clean-workspace-regate', 'rebase-regate', 'resume-from-salvage', 'derive-evidence-rejudge',
]);

/** 처방이 «어디서» 왔나 — `graph` = 그 갈래에 얹힌 오버레이가 더한 노드 · `code-default` = 위 표. */
export type AutohealActionSource = 'graph' | 'code-default';

export interface AutohealPick {
  action: AutohealAction;
  source: AutohealActionSource;
  /** source='graph' 일 때 그 처방 노드를 더한 오버레이. */
  overlayId?: string;
}

/** 사다리를 읽어 오는 자리 — 활성 템플릿 선언 ⊕ 오버레이 목록. 시험이 갈아 끼운다. */
export interface AutohealLadder {
  template: GraphTemplateSpec | undefined;
  overlays: readonly GraphOverlaySpec[];
}

function loadDefaultLadder(): AutohealLadder {
  return { template: GRAPH_SPECS['self-implement'], overlays: loadGraphOverlays(defaultOverlaysDir()).overlays };
}

/**
 * 갈래 → 처방. 그 `stop_class` 에 얹힌 오버레이가 활성 템플릿에 더한 처방 노드 id 를 고른다.
 * ⛔ 오버레이가 없거나 · 조건 키가 없거나 · 로드·적용이 실패하거나 · 처방 노드가 정확히 하나가 아니면
 *    «조용히» 코드 표로 간다 — 그 사실은 `source` 가 말한다. 던지지 않는다.
 */
export function pickAutohealAction(cls: RunStopClass, loadLadder: () => AutohealLadder = loadDefaultLadder): AutohealPick {
  const codeDefault: AutohealPick = { action: AUTOHEAL_ACTION_BY_CLASS[cls] ?? 'needs-owner', source: 'code-default' };
  try {
    const { template, overlays } = loadLadder();
    if (!template) return codeDefault;
    const { applied } = selectOverlays(overlays, { graphId: template.graphId, stage: 'heal', state: { stop_class: cls } });
    const declared = new Set(template.nodes.map((node) => node.nodeId));
    for (const overlay of applied) {
      const result = applyGraphOverlays(template, [overlay]);
      if (!result.ok) {
        observe('overlay-rejected', { stopClass: cls, overlayId: overlay.overlayId, rejections: result.rejections.map((r) => r.kind) });
        continue;
      }
      const added = result.template.nodes.map((node) => node.nodeId).filter((id) => !declared.has(id) && HEAL_ACTION_NODE_IDS.has(id));
      if (added.length === 1) return { action: added[0] as AutohealAction, source: 'graph', overlayId: overlay.overlayId };
    }
  } catch (error) {
    observe('ladder-unreadable', { stopClass: cls, error: error instanceof Error ? error.message : String(error) });
  }
  return codeDefault;
}

/** 설정 원값 → 모드. 모르는 값은 «좁은 쪽»(shadow). */
export function parseAutohealMode(raw: unknown): AutohealMode {
  return raw === 'live' ? 'live' : 'shadow';
}

export interface AutohealContext {
  runId: string;
  goalId?: string;
  record: RunStopRecord;
}

export interface AutohealActionResult {
  ok: boolean;
  /** 한 줄 — 무엇을 했나/왜 못 했나. */
  detail?: string;
}

export type AutohealActionFn = (ctx: AutohealContext) => Promise<AutohealActionResult> | AutohealActionResult;

/** 행동 seam — needs-owner 를 뺀 넷. 없는 seam 은 live 에서도 실행하지 않는다. */
export type AutohealActions = Partial<Record<Exclude<AutohealAction, 'needs-owner'>, AutohealActionFn>>;

export type AutohealOutcome =
  /** shadow — 할 일을 적기만 했다. */
  | 'would-act'
  /** live — 행동을 했고 성공했다. */
  | 'healed'
  /** 사람에게 넘긴다(갈래가 needs-owner 이거나 행동이 실패·미배선). */
  | 'needs-owner'
  /** 같은 런·갈래·모드에 이미 시도가 있다 — 아무것도 안 했다(원장에 새 줄도 안 쓴다). */
  | 'already-attempted';

export interface AutohealResult {
  runId: string;
  class: RunStopClass;
  action: AutohealAction;
  /** 처방을 «어디서» 골랐나 — 그래프 선언 또는 코드 표. */
  source: AutohealActionSource;
  /** source='graph' 일 때 처방 노드를 더한 오버레이. */
  overlayId?: string;
  mode: AutohealMode;
  outcome: AutohealOutcome;
  /** needs-owner 일 때 사람이 볼 이유(멈춘 원인 그대로 또는 행동 실패). */
  reason?: string;
  detail?: string;
  entry?: RunLedgerEntry;
}

export interface AutohealDeps {
  mode?: AutohealMode;
  actions?: AutohealActions;
  /** 가드용 원장 읽기 — 기본 `loadRunLedger(runId)`. null = 원장 없음(첫 시도). */
  loadLedger?: (runId: string) => readonly RunLedgerEntry[] | null;
  writeLedger?: RunLedgerWriter;
  /** 사다리 선언 읽기 — 기본은 활성 템플릿 ⊕ `graphs/overlays`. 던지면 코드 표로 간다. */
  loadLadder?: () => AutohealLadder;
}

/**
 * 이 프로세스가 쓴 autoheal 줄 — 원장 읽기가 주입 writer 와 다른 곳을 보거나(시험 seam) 비어 있어도
 * 같은 프로세스 안에서는 «한 번»이 지켜지게 한다(리뷰 must-fix #24912).
 */
const writtenThisProcess = new Map<string, RunLedgerEntry[]>();
const WRITTEN_MAX_RUNS = 4096;

/** 시험용 — 프로세스 기억을 비운다. */
export function resetAutohealProcessMemory(): void {
  writtenThisProcess.clear();
}

/** 원장 가드 — 같은 런·같은 갈래·같은 모드의 autoheal 줄이 있으면 참. */
export function autohealAlreadyAttempted(ledger: readonly RunLedgerEntry[] | null, cls: RunStopClass, mode: AutohealMode): boolean {
  if (!ledger) return false;
  return ledger.some((e) => e.event === AUTOHEAL_EVENT && e.data?.class === cls && e.data?.mode === mode);
}

function observe(event: string, data: Record<string, unknown>): void {
  try { debug.log('self-implement.autoheal', event, data); } catch { /* observation is fail-soft */ }
}

/**
 * stop 레코드 하나 → 최대 한 번의 힐 시도. 예외를 던지지 않는다(행동 seam 의 throw 도 needs-owner 로 접는다).
 */
export async function autohealFromStop(ctx: AutohealContext, deps: AutohealDeps = {}): Promise<AutohealResult> {
  const mode = deps.mode ?? DEFAULT_AUTOHEAL_MODE;
  const cls = ctx.record.class;
  const { action, source, overlayId } = pickAutohealAction(cls, deps.loadLadder);
  const base = { runId: ctx.runId, class: cls, action, source, ...(overlayId ? { overlayId } : {}), mode };

  let ledger: readonly RunLedgerEntry[] | null = null;
  try {
    ledger = (deps.loadLedger ?? ((id) => loadRunLedger(id)))(ctx.runId);
  } catch (error) {
    // ⛔ 가드를 못 읽으면 «한 번»을 보장할 수 없다 — live 행동을 하지 않고 사람에게 넘긴다.
    const reason = `ledger-unreadable: ${error instanceof Error ? error.message : String(error)}`;
    observe('guard-unreadable', { ...base, reason });
    return { ...base, outcome: 'needs-owner', reason };
  }
  if (autohealAlreadyAttempted(ledger, cls, mode) || autohealAlreadyAttempted(writtenThisProcess.get(ctx.runId) ?? null, cls, mode)) {
    observe('already-attempted', base);
    return { ...base, outcome: 'already-attempted' };
  }

  observe('action-source', { stopClass: cls, action, source, overlayId: overlayId ?? null });

  let outcome: AutohealOutcome;
  let reason: string | undefined;
  let detail: string | undefined;
  if (action === 'needs-owner') {
    outcome = 'needs-owner';
    reason = `stop ${cls}: ${ctx.record.cause}`;
  } else if (mode === 'shadow') {
    outcome = 'would-act';
  } else {
    const fn = deps.actions?.[action];
    if (!fn) {
      outcome = 'needs-owner';
      reason = `action-unwired: ${action} (stop ${cls}: ${ctx.record.cause})`;
    } else {
      // ⭐ 시도 «전»에 원장 줄을 쓴다 — 행동 중 프로세스가 죽어도 두 번째 시도가 막힌다.
      //    ⛔ 그 줄을 못 쓰면 «한 번»을 보장할 수 없으니 행동하지 않는다.
      if (!writeEntry(ctx, deps, { ...base, phase: 'attempt' })) {
        const unguarded = `guard-write-failed: ${action} not attempted (stop ${cls}: ${ctx.record.cause})`;
        observe('needs-owner', { ...base, reason: unguarded });
        return { ...base, outcome: 'needs-owner', reason: unguarded };
      }
      try {
        const res = await fn(ctx);
        detail = res.detail;
        outcome = res.ok ? 'healed' : 'needs-owner';
        if (!res.ok) reason = `${action} failed${res.detail ? `: ${res.detail}` : ''}`;
      } catch (error) {
        outcome = 'needs-owner';
        reason = `${action} threw: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  const entry = writeEntry(ctx, deps, {
    ...base, phase: 'result', outcome,
    ...(reason ? { reason } : {}), ...(detail ? { detail } : {}),
    evidenceRef: ctx.record.evidenceRef, nextMove: ctx.record.nextMove,
  });
  observe(outcome, { ...base, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
  return { ...base, outcome, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}), ...(entry ? { entry } : {}) };
}

function writeEntry(ctx: AutohealContext, deps: AutohealDeps, data: Record<string, unknown>): RunLedgerEntry | undefined {
  const entry: RunLedgerEntry = {
    timestamp: new Date().toISOString(), runId: ctx.runId, event: AUTOHEAL_EVENT, data,
    ...(ctx.goalId ? { goalId: ctx.goalId } : {}),
  };
  try {
    (deps.writeLedger ?? appendRunLedgerEntry)(entry);
    if (!writtenThisProcess.has(ctx.runId) && writtenThisProcess.size >= WRITTEN_MAX_RUNS) writtenThisProcess.clear();
    writtenThisProcess.set(ctx.runId, [...(writtenThisProcess.get(ctx.runId) ?? []), entry]);
    return entry;
  } catch (error) {
    observe('ledger-write-failed', { runId: ctx.runId, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}
