// ── 사건 주입 «이벤트 몽키» (SIM-EVENT-MONKEY · 사다리 L0 · 0.2.35) ─────────────────
//
// 🚨 왜 이것이 있나
//   green 판정·run doctor 는 «진짜 사건»이 일어나야 돈다. 그런데 긴 자식 오류 · 같은 칸 재사용 push ·
//   범위 밖 편집 보류 · 결과 줄 없음 · PR 번호 잃은 종료 · 착지 슬롯 대기는 운영에서 «기다려야» 났다.
//   이 장치는 그 사건 줄을 «격리 시험 우주»에 언제든 쓴다 — 소비자(run doctor · tasks outcomes · green 근거)를
//   사건을 기다리지 않고 돌려 볼 수 있게.
//
// ⛔ 흉내 내지 않는다(MANUAL-ux-simulation-devices §2):
//   - 원장 줄은 운영과 «같은» 쓰기 함수 appendRunLedgerEntry 로 쓴다(JSONL 을 손으로 짓지 않는다).
//   - 자식 증거는 호스트가 부르는 «같은» 정형기 podChildEvidenceFromResult 로, PR 종료 기록은
//     «같은» 분류기 classifyPodTerminal 로 만든다. 관측 줄은 debug.log 와 같은 꼴(category·event·data)로,
//     격리 우주 logs.db 를 «같은» LogStore 로 직접 열어 쓴다.
//   ⛔ 전역 debug.log 로 보내지 않는다 — 그 프로세스에 운영 LogStore 싱크가 붙어 있으면 원장 검사를 통과해도
//     운영 logs.db 에 주입 줄이 들어간다(리뷰 r3 must-fix). 그래서 관측 줄의 출구는 격리 DB «하나»뿐이다.
// ⛔ 운영 우주(~/.elanous · 계정의 ops 뿌리)에는 «한 줄도» 쓰지 않는다 — 쓰기 전에 거부한다.
// 🏷️ 모든 줄에 injected:true · injectionId · level:'L0' 를 싣는다 — 소비자가 진짜 사건과 가를 수 있게.

import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appendRunLedgerEntry, runLedgerDir, runLedgerPath, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { podChildEvidenceFromResult } from '../task-orchestrator/surfaces/self-implement.js';
import { classifyPodTerminal } from '../self-dev/draft-residue.js';
import { effectiveInstanceRoot, normRoot, prodInstanceRoot } from '../instance/resolve.js';
import { isInsideOpsRoot, physicalPath } from '../instance/test-write-guard.js';
import { LogStore } from '../mss/logging/log-store.js';
import { resolveTestRoot } from '../cli/test-flag.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';

export const EVENT_MONKEY_LEVEL = 'L0' as const;

export const EVENT_MONKEY_KINDS = [
  'child-error-long', 'same-cell-reuse-push', 'scope-escape-held', 'no-result-line', 'pr-terminal-null', 'land-slot-wait',
] as const;
export type EventMonkeyKind = (typeof EVENT_MONKEY_KINDS)[number];

export interface EventMonkeyCatalogEntry {
  readonly summary: string;
  /** 원장(run-ledger)에 쓰는 사건 이름 — 운영의 같은 이름. */
  readonly ledgerEvents: readonly string[];
  /** 격리 logs.db 에 쓰는 «범주 사건» — 운영 debug.log 의 같은 이름. */
  readonly debugEvents: readonly string[];
  /** 이 줄을 읽어야 하는 소비자(정적 목록). */
  readonly consumers: readonly string[];
}

export const EVENT_MONKEY_CATALOG: Readonly<Record<EventMonkeyKind, EventMonkeyCatalogEntry>> = {
  'child-error-long': {
    summary: 'Pod 자식이 ≈4KB 오류 문면으로 실패 — 호스트가 pod-child-evidence 로 옮긴 꼴',
    ledgerEvents: ['pod-child-run', 'pod-child-evidence'],
    debugEvents: ['self-implement.pod child-error', 'self-implement.pod job-finished'],
    consumers: ['run doctor (elanous doctor · child-dead-no-result)', 'harness 종료 분류 latestPodChildEvidence → recordRunExit', 'elanous tasks outcomes', 'harness incidents'],
  },
  'same-cell-reuse-push': {
    summary: '같은 칸 OPEN PR 재사용 push — allowed(fast-forward) · refused(신원 불일치) 두 변형',
    ledgerEvents: ['same-cell-push-decision', 'pod-child-run', 'pod-child-evidence'],
    debugEvents: ['autopilot.pr-manager same-cell-push-decision', 'autopilot.pr-manager same-cell-reused'],
    consumers: ['elanous tasks outcomes (prFailure)', 'green 근거 (card-evidence)', 'elanous logs --category autopilot.pr-manager'],
  },
  'scope-escape-held': {
    summary: '범위 밖 편집을 worktree 에 보류 — outOfScopeEdits 이름 목록',
    ledgerEvents: ['execution-scope-held', 'pod-child-run', 'pod-child-evidence'],
    debugEvents: ['self-implement.pod child-error'],
    consumers: ['run doctor (scope-drift)', 'harness 종료 분류 scope-escape', 'elanous tasks outcomes', 'harness incidents'],
  },
  'no-result-line': {
    summary: 'Pod 가 결과 줄 없이 실패 — childEvidence null · PR 종료 미관측',
    ledgerEvents: ['pod-child-run', 'pod-child-evidence', 'pod-ledger-incomplete', 'pr-terminal'],
    debugEvents: ['self-implement.pod job-finished'],
    consumers: ['run doctor (child-dead-no-result)', 'elanous tasks outcomes', 'draft residue sweeper (pr-terminal)', 'green 근거 (card-evidence)'],
  },
  'pr-terminal-null': {
    summary: 'draft 를 연 뒤 자식 실패 — 같은 가지인데 pr-terminal.prNumber 가 null',
    ledgerEvents: ['pod-child-run', 'pr-opened', 'pod-child-evidence', 'pr-terminal'],
    debugEvents: ['self-implement.pod pr-terminal-branch-lookup'],
    consumers: ['draft residue sweeper (pr-terminal)', 'green 근거 (card-evidence)', 'elanous tasks outcomes', 'harness 하니스 draft 소유 판정 (pr-opened)'],
  },
  'land-slot-wait': {
    summary: '착지 무거운 단계 호스트 슬롯이 모두 차서 대기',
    ledgerEvents: ['land-slot-wait'],
    debugEvents: ['pr.land host-busy'],
    consumers: ['run doctor (host-overload)', 'elanous logs --category pr.land', 'OP 착지 줄(land-queue) 관측'],
  },
};

export type EventMonkeyVariant = 'allowed' | 'refused';

export interface EventMonkeyDebugRow {
  readonly category: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface EmitInjectedEventOptions {
  kind: EventMonkeyKind;
  /** 기존 런에 덧붙일 때. 없으면 정규 run-<uuid> 를 새로 민다. */
  runId?: string;
  /** same-cell-reuse-push 전용 — 없으면 두 변형 모두. */
  variant?: EventMonkeyVariant;
  /** 쓸 우주 뿌리. 없으면 effectiveInstanceRoot(). */
  stateRoot?: string;
  injectionId?: string;
  now?: () => Date;
}

export interface EmitInjectedEventResult {
  readonly kind: EventMonkeyKind;
  readonly level: typeof EVENT_MONKEY_LEVEL;
  readonly injectionId: string;
  readonly runId: string;
  readonly stateRoot: string;
  readonly ledgerPath: string;
  readonly ledgerRows: readonly RunLedgerEntry[];
  readonly debugRows: readonly EventMonkeyDebugRow[];
  readonly consumers: readonly string[];
}

export class EventMonkeyRefusedError extends Error {
  constructor(readonly stateRoot: string, readonly reason: 'production-root' | 'ops-root') {
    super(`event monkey refuses to write into a production root (${reason}): ${stateRoot} — set ELANOUS_STATE_DIR (or --state-dir) to an isolated test dir`);
    this.name = 'EventMonkeyRefusedError';
  }
}

/** 이 장치가 실제로 쓰는 자리 — 뿌리 ⊕ 원장 디렉터리·파일 ⊕ logs 디렉터리·logs.db(⊕ WAL·SHM). */
export function eventMonkeyWriteTargets(root: string, runId?: string): string[] {
  const logs = join(root, 'logs');
  const db = join(logs, 'logs.db');
  return [root, runLedgerDir(root), ...(runId ? [runLedgerPath(runId, runLedgerDir(root))] : []), logs, db, `${db}-wal`, `${db}-shm`];
}

function insideOrEqual(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 운영 뿌리면 던진다 — 쓰기 «전»에 부른다.
 * ⛔ 뿌리 «이름»만 보지 않는다: 격리 뿌리 안의 `run-ledger`·`logs` 가 운영으로 가는 symlink 면
 *    이름 검사를 통과한 뒤 운영에 쓴다. 그래서 실제 쓰기 대상마다 «물리 경로»를 운영 뿌리·ops 뿌리와 대조한다.
 */
export function assertIsolatedEventRoot(root: string, runId?: string): string {
  const normalized = normRoot(root);
  const prod = prodInstanceRoot();
  const prodPhysical = physicalPath(prod);
  // ⛔ 디렉터리에서 멈추지 않는다 — 원장 «파일»·logs.db «파일» 자체가 symlink 여도 물리 경로로 잡는다.
  for (const target of eventMonkeyWriteTargets(normalized, runId)) {
    const physical = physicalPath(target);
    if (insideOrEqual(prod, target) || insideOrEqual(prodPhysical, physical)) throw new EventMonkeyRefusedError(normalized, 'production-root');
    if (isInsideOpsRoot(target) || isInsideOpsRoot(physical)) throw new EventMonkeyRefusedError(normalized, 'ops-root');
  }
  return normalized;
}

/** 짧은 별칭 — 사람이 치기 쉽게. 정식 이름도 그대로 받는다. */
export const EVENT_MONKEY_ALIASES: Readonly<Record<string, EventMonkeyKind>> = {
  'child-error': 'child-error-long',
  'same-cell': 'same-cell-reuse-push',
  'scope-escape': 'scope-escape-held',
  'no-result': 'no-result-line',
  'pr-null': 'pr-terminal-null',
  'slot-wait': 'land-slot-wait',
};

export function resolveEventMonkeyKind(name: string): EventMonkeyKind | undefined {
  return isEventMonkeyKind(name) ? name : EVENT_MONKEY_ALIASES[name];
}

/**
 * 기본 우주 = test. 명시(--test/--config-dir/ELANOUS_STATE_DIR)가 있으면 그것을 쓰고(운영이면 거부된다),
 * 없으면 `--test` 와 같은 `<트리>/.elanous-test`. 트리도 없으면 운영 뿌리를 돌려 거부되게 둔다(조용히 다른 곳에 쓰지 않는다).
 */
export function resolveEventMonkeyRoot(cwd: string = process.cwd()): string {
  const effective = effectiveInstanceRoot();
  const explicit = Boolean(getElanousConfigDirOverride() || process.env.ELANOUS_STATE_DIR?.trim());
  if (explicit || effective !== prodInstanceRoot()) return effective;
  return resolveTestRoot(cwd) ?? effective;
}

function isEventMonkeyKind(value: string): value is EventMonkeyKind {
  return (EVENT_MONKEY_KINDS as readonly string[]).includes(value);
}
export { isEventMonkeyKind };

const LONG_ERROR_LINE = 'error: bun test src/self-implement/orchestrator.test.ts exited 1 — expect(received).toEqual(expected) at orchestrator.test.ts:4210:7 (injected L0 long child error)';

/** 실제 자식 실패처럼 «한 줄 요약 + 긴 스택» 꼴의 ≈4KB 문면. 정형기가 4,000자로 자른다. */
function longChildError(): string {
  const lines: string[] = [LONG_ERROR_LINE];
  for (let i = 0; lines.join('\n').length < 4_400; i++) {
    lines.push(`    at runGate (src/self-implement/gate.ts:${100 + i}:${(i * 7) % 80}) — frame ${i}`);
  }
  return lines.join('\n');
}

/** 원장 쓰기만 담당하는 묶음 — 줄마다 주입 꼬리표를 붙여 «같은» 쓰기 함수로 쓴다. */
function makeWriter(runId: string, dir: string, tag: Record<string, unknown>, now: () => Date) {
  const rows: RunLedgerEntry[] = [];
  return {
    rows,
    write(event: string, data: Record<string, unknown>): void {
      const entry: RunLedgerEntry = { timestamp: now().toISOString(), runId, event, data: { ...data, ...tag } };
      appendRunLedgerEntry(entry, dir);
      rows.push(entry);
    },
  };
}

export function emitInjectedEvent(options: EmitInjectedEventOptions): EmitInjectedEventResult {
  const { kind } = options;
  if (!isEventMonkeyKind(kind)) throw new Error(`unknown event monkey kind: ${String(kind)}`);
  // ⛔ 거부·검증은 «쓰기 전» — 운영 뿌리면 0줄.
  const runId = options.runId ?? `run-${randomUUID()}`;
  const requestedRoot = resolve(options.stateRoot ?? resolveEventMonkeyRoot());
  const ledgerPath = runLedgerPath(runId, runLedgerDir(requestedRoot)); // 정규화 계약 밖 runId 는 여기서 던진다(쓰기 전).
  const stateRoot = assertIsolatedEventRoot(requestedRoot, runId);
  const dir = runLedgerDir(stateRoot);
  const injectionId = options.injectionId ?? `inj-${randomUUID()}`;
  const tag = { injected: true, injectionId, level: EVENT_MONKEY_LEVEL } as const;
  const now = options.now ?? (() => new Date());
  const debugRows: EventMonkeyDebugRow[] = [];
  const emit = (category: string, event: string, data: Record<string, unknown>): void => {
    debugRows.push({ category, event, data: { ...data, ...tag, runId } });
  };
  const ledger = makeWriter(runId, dir, tag, now);

  const short = injectionId.slice(4, 12);
  const job = `si-sim-${short}`;
  const childRunId = `run-${randomUUID()}`;
  const branch = `elanous/self-dev/sim-event-monkey-goalid-${short}`;
  const podChildRun = (): void => ledger.write('pod-child-run', { childRunId, job, attempt: 1 });
  const childEvidence = (result: Record<string, unknown> | null): void => {
    ledger.write('pod-child-evidence', { childEvidence: result ? podChildEvidenceFromResult(result) ?? null : null, childRunId, job });
  };

  switch (kind) {
    case 'child-error-long': {
      const error = longChildError();
      podChildRun();
      childEvidence({ ok: false, error, exitCode: 1, failureClassification: 'child-error' });
      emit('self-implement.pod', 'child-error', { job, stage: 'implement', error: error.slice(0, 500) });
      emit('self-implement.pod', 'job-finished', { job, state: 'failed', containerReason: 'Error', stage: null, prUrl: null, childRunId, childStage: 'implement', childError: error.slice(0, 500) });
      break;
    }
    case 'same-cell-reuse-push': {
      const variants: EventMonkeyVariant[] = options.variant ? [options.variant] : ['allowed', 'refused'];
      const headSha = 'a'.repeat(40);
      const cardId = `card-sim-${short}`;
      const pushEvidence = { ref: `refs/heads/${branch}`, remoteHead: headSha, cardId };
      for (const variant of variants) {
        if (variant === 'allowed') {
          ledger.write('same-cell-push-decision', { ...pushEvidence, outcome: 'allowed', reason: 'bound-card-pr-head-fast-forward' });
          emit('autopilot.pr-manager', 'same-cell-push-decision', { ...pushEvidence, outcome: 'allowed', reason: 'bound-card-pr-head-fast-forward' });
          emit('autopilot.pr-manager', 'same-cell-reused', { pr: 99_999_999, cellId: 'SIM-EVENT-MONKEY', cardId, branch });
        } else {
          const reason = 'candidate identity mismatch';
          ledger.write('same-cell-push-decision', { ...pushEvidence, outcome: 'refused', reason });
          emit('autopilot.pr-manager', 'same-cell-push-decision', { ...pushEvidence, outcome: 'refused', reason });
          podChildRun();
          childEvidence({ ok: false, exitCode: 1, error: `PR guard 실패: same-cell reuse: ${reason} blockingPr=#99999999:${cardId} candidateCardId=card-sim-other` });
        }
      }
      break;
    }
    case 'scope-escape-held': {
      const outOfScopeEdits = ['src/index.ts', 'src/cli/tasks-cli.ts', 'docs/_index.md'];
      ledger.write('execution-scope-held', { outOfScopeEdits, nameCapReached: false, outsideCount: outOfScopeEdits.length,
        worktreePath: `/tmp/elanous-sim/${job}`, branch, disposition: 'in-scope-only' });
      podChildRun();
      childEvidence({ ok: false, exitCode: 1, outOfScopeEdits, detail: 'Out-of-scope edits held in the worktree; gate and publication skipped.' });
      emit('self-implement.pod', 'child-error', { job, stage: 'soft-stopped', error: 'Out-of-scope edits held in the worktree' });
      break;
    }
    case 'no-result-line': {
      podChildRun();
      childEvidence(null);
      ledger.write('pod-ledger-incomplete', { job, reason: 'child-ledger-missing' });
      ledger.write('pr-terminal', { ...classifyPodTerminal({ childRunId, state: 'failed', disposition: undefined, at: now().toISOString() }) });
      emit('self-implement.pod', 'job-finished', { job, state: 'failed', containerReason: 'Error', stage: null, prUrl: null, childRunId, childError: 'no-result-line' });
      break;
    }
    case 'pr-terminal-null': {
      podChildRun();
      ledger.write('pr-opened', { number: 99_999_999, url: 'https://github.com/elanous-sim/event-monkey/pull/99999999', branch, draft: true });
      childEvidence({ ok: false, exitCode: 1, error: 'review loop exhausted after draft open (injected L0)' });
      ledger.write('pr-terminal', { ...classifyPodTerminal({ childRunId, state: 'failed',
        disposition: { prNumber: null, prUrl: null, stage: 'review-failed', ok: false, branch }, at: now().toISOString() }) });
      emit('self-implement.pod', 'pr-terminal-branch-lookup', { branch, status: 'not-found', reason: 'injected-no-lookup', job });
      break;
    }
    case 'land-slot-wait': {
      const data = { host: 'node-b', occupied: 2, slotWaitSeconds: 600 };
      ledger.write('land-slot-wait', { ...data, waitedSeconds: 600, pr: 99_999_999 });
      emit('pr.land', 'host-busy', data);
      break;
    }
  }

  // 관측 줄 — 격리 우주 logs.db 하나로만(전역 싱크 0). 경로는 위 assertIsolatedEventRoot 가 이미 물리 대조했다.
  const store = new LogStore(join(stateRoot, 'logs', 'logs.db'));
  try {
    store.insertBatch(debugRows.map((row) => ({ rec: { ts: now().toISOString(), category: row.category, event: row.event, data: row.data, level: 'info' as const }, surface: 'ux-sim' })));
  } finally { store.close(); }

  return {
    kind, level: EVENT_MONKEY_LEVEL, injectionId, runId, stateRoot, ledgerPath,
    ledgerRows: ledger.rows, debugRows, consumers: EVENT_MONKEY_CATALOG[kind].consumers,
  };
}

/** 사람용 한 줄 — 주입 id · 쓴 원장 경로 · 읽어야 할 소비자. */
export function renderInjectedEventLine(result: EmitInjectedEventResult): string {
  return `주입 ${result.injectionId} · ${result.kind} · 원장 ${result.ledgerPath} · 소비자: ${result.consumers.join(' · ')}`;
}

/** JSON 출력 꼴(CLI 공용). */
export function injectedEventJson(result: EmitInjectedEventResult): Record<string, unknown> {
  return {
    ok: true, level: result.level, kind: result.kind, injectionId: result.injectionId, runId: result.runId,
    stateRoot: result.stateRoot, ledgerPath: result.ledgerPath,
    ledgerEvents: result.ledgerRows.map((row) => row.event),
    debugEvents: result.debugRows.map((row) => `${row.category} ${row.event}`),
    consumers: result.consumers,
  };
}

export interface EventMonkeyCliInput {
  kindName: string | undefined;
  runId?: string;
  variant?: string;
  /** 명시 우주(없으면 resolveEventMonkeyRoot). */
  stateDir?: string;
  json?: boolean;
}

export interface EventMonkeyCliOutcome {
  /** 0 성공 · 1 기타 오류 · 2 사용법 · 3 운영 뿌리 거부. */
  code: 0 | 1 | 2 | 3;
  stdout: string[];
  stderr: string[];
}

/** `eln sim emit` · `scripts/ux-sim.ts emit` 공용 — 인자 해석 뒤 «같은» 함수 하나. 출력은 돌려주기만 한다. */
export function runEventMonkeyCli(input: EventMonkeyCliInput): EventMonkeyCliOutcome {
  const kind = input.kindName ? resolveEventMonkeyKind(input.kindName) : undefined;
  if (!kind) {
    const known = [...EVENT_MONKEY_KINDS, ...Object.keys(EVENT_MONKEY_ALIASES)].join(' · ');
    return { code: 2, stdout: [], stderr: [`⛔ 모르는 사건이다: ${input.kindName ?? '(없음)'} — 아는 것: ${known}`] };
  }
  if (input.variant !== undefined && (kind !== 'same-cell-reuse-push' || (input.variant !== 'allowed' && input.variant !== 'refused'))) {
    return { code: 2, stdout: [], stderr: ['⛔ --variant 는 same-cell-reuse-push 에만 · allowed|refused'] };
  }
  try {
    const result = emitInjectedEvent({
      kind, stateRoot: input.stateDir ? resolve(input.stateDir) : resolveEventMonkeyRoot(),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.variant ? { variant: input.variant as EventMonkeyVariant } : {}),
    });
    return { code: 0, stdout: [input.json ? JSON.stringify(injectedEventJson(result)) : renderInjectedEventLine(result)], stderr: [] };
  } catch (error) {
    if (error instanceof EventMonkeyRefusedError) {
      return input.json
        ? { code: 3, stdout: [JSON.stringify({ ok: false, error: error.reason === 'ops-root' ? 'refused-ops-root' : 'refused-production-root', reason: error.reason, stateRoot: error.stateRoot })], stderr: [] }
        : { code: 3, stdout: [], stderr: [`⛔ ${error.message}`] };
    }
    return { code: 1, stdout: [], stderr: [`⛔ ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** `eln sim kinds` · `emit --list` 공용 출력. */
export function renderEventMonkeyKinds(json = false): string[] {
  if (json) return [JSON.stringify(EVENT_MONKEY_CATALOG, null, 2)];
  const alias = (kind: EventMonkeyKind): string => Object.entries(EVENT_MONKEY_ALIASES).find(([, k]) => k === kind)?.[0] ?? '-';
  return EVENT_MONKEY_KINDS.map((kind) => {
    const entry = EVENT_MONKEY_CATALOG[kind];
    return `${kind} (${alias(kind)})\t${entry.summary}\n  원장: ${entry.ledgerEvents.join(' · ')}\n  소비자: ${entry.consumers.join(' · ')}`;
  });
}
