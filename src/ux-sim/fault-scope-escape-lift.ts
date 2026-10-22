// ── 결함 주입 심 — «범위 이탈 vs 구현 결손» ─────────────────────────────────
//
// 🚨 왜 이것이 있나 (FAULT-SCOPE-ESCAPE-LIFT · 2026-10-21)
//   POD-RESULT-LIFT 초록이 «구현 결손 부모 stop·incident 원문 미확인» 으로 멈췄다(OPT 10-21 16:26).
//   범위 이탈(held 편집 있음)과 구현 결손(held 없음) 두 자식 실패가 같은 부모 기록 경로에서
//   서로 다른 필드로 갈리는지 일으킬 장치가 없었다. 이 심은 그 두 실패를 «기다리지 않고 일으킨다».
//
// ⛔ 흉내 내지 않는다: 운영이 부르는 «같은» 함수를 그대로 부른다 —
//    ① parseSelfImplementJson(→ podChildEvidenceFromResult) · self-implement.ts (Pod 호스트가 자식 끝 JSON 을 읽는 자리)
//    ② 원장 줄 pod-child-run ⊕ pod-child-evidence — self-implement-pod.ts 가 쓰는 꼴 그대로 appendRunLedgerEntry
//    ③ classifyHarnessPodExit → recordHarnessPodStop(부모 stop) → recordClassifiedHarnessPodExit(incident) · harness-cli-command.ts
//    부모 출력 줄은 formatOrchestrateResultLine(운영 요약 줄) ⊕ extractPodFailureReason(운영 Pod 사유)로 만든다.
//    kubectl·Pod·네트워크는 없다. 쓰기는 임시 ELANOUS_STATE_DIR 하나에만 가고 끝에 지운다.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseSelfImplementJson, type PodChildEvidence, type SelfImplementDisposition } from '../task-orchestrator/surfaces/self-implement.js';
import { extractPodFailureReason } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import { formatOrchestrateResultLine } from '../self-dev/orchestrate-summary-line.js';
import { classifyHarnessPodExit, recordClassifiedHarnessPodExit, recordHarnessPodStop } from '../harness/harness-cli-command.js';
import { readRunExits } from '../harness/harness-incidents.js';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { readRunStopRecord, type RunStopRecord } from '../self-implement/run-stop.js';

export type ScopeEscapeLiftCase = 'scope-escape' | 'implementation-deficit';

/** 두 입력이 공유하는 자식 끝 JSON 몸통 — `attachAbandonedClassification` 이 붙이는 분류 꼴 그대로. */
function childBase(): Record<string, unknown> {
  return {
    stage: 'soft-stopped',
    ok: false,
    worktreePath: '/work/.claude/worktrees/sim-scope-escape-lift',
    branch: 'self/sim-scope-escape-lift',
    abandonedClassification: {
      classification: 'implementation-deficit',
      classificationBasis: 'no-must-fix-without-clean-worktree-or-completed-without-changes',
      worktreeClean: false,
    },
  };
}

/** 범위 이탈 자식만 싣는 «held» 칸 — orchestrator 가 범위 밖 편집을 worktree 에 held 할 때 끝 JSON 에 더하는 넷(이것 말고는 두 입력이 같다). */
export const SCOPE_ESCAPE_HELD_KEYS = ['detail', 'outOfScopeEdits', 'outsideCount', 'nameCapReached'] as const;

/** 범위 이탈 — orchestrator 가 범위 밖 편집을 worktree 에 held 한 채 멈출 때의 끝 JSON(orchestrator.ts detail 원문 · outOfScopeEdits). */
export function scopeEscapeChildResult(): Record<string, unknown> {
  const held: Record<(typeof SCOPE_ESCAPE_HELD_KEYS)[number], unknown> = {
    detail: 'Out-of-scope edits held in the worktree; gate and publication skipped.',
    outOfScopeEdits: ['LICENSE'],
    outsideCount: 1,
    nameCapReached: false,
  };
  return { ...childBase(), ...held };
}

/** 구현 결손 — held 편집 없이 같은 분류(implementation-deficit)로 멈춘 끝 JSON. */
export function implementationDeficitChildResult(): Record<string, unknown> {
  return childBase();
}

export interface ScopeEscapeLiftObservation {
  readonly case: ScopeEscapeLiftCase;
  /** Pod 호스트가 자식 끝 JSON 에서 읽은 disposition(일부). */
  readonly disposition: Pick<SelfImplementDisposition, 'stage' | 'failureClassification'>;
  /** podChildEvidenceFromResult 결과(disposition.childEvidence). */
  readonly childEvidence: PodChildEvidence | undefined;
  /** 부모 원장 pod-child-evidence 줄에 실린 childEvidence(다시 읽은 값). */
  readonly ledgerChildEvidence: unknown;
  /** classifyHarnessPodExit 가 낸 부모 종료 사유. */
  readonly parentExitReason: string;
  /** recordHarnessPodStop 이 부모 원장에 쓴 stop 레코드. */
  readonly stop: RunStopRecord | undefined;
  /** recordClassifiedHarnessPodExit 가 incidents 에 쓴 한 줄. */
  readonly incident: { reason: string; childEvidence?: PodChildEvidence } | undefined;
}

function withTempState<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-scope-escape-lift-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try { return fn(root); }
  finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** 한 자식 실패를 부모 기록 경로 전체에 흘리고 각 층의 필드를 돌려준다. */
export function simScopeEscapeLift(
  which: ScopeEscapeLiftCase,
  childResult: Record<string, unknown> = which === 'scope-escape' ? scopeEscapeChildResult() : implementationDeficitChildResult(),
): ScopeEscapeLiftObservation {
  const suffix = randomBytes(4).toString('hex');
  const runId = `run-sim-scope-lift-${suffix}`;
  const job = `si-sim-scope-lift-${suffix}`;
  const childRunId = `run-sim-scope-child-${suffix}`;
  const logs = `${JSON.stringify(childResult)}\n`;
  return withTempState((root) => {
    // ① Pod 호스트 — 자식 끝 JSON → disposition(→ podChildEvidenceFromResult).
    const parsed = parseSelfImplementJson(logs);
    const childEvidence = parsed?.childEvidence;
    // ② 부모 원장 — self-implement-pod.ts 가 쓰는 두 줄 꼴 그대로.
    const dir = runLedgerDir(root);
    appendRunLedgerEntry({ runId, event: 'pod-child-run', data: { job, childRunId } }, dir);
    appendRunLedgerEntry({ runId, event: 'pod-child-evidence', data: { childEvidence: childEvidence ?? null, childRunId, job } }, dir);
    // ③ 부모 출력 — Job 실패(backoffLimit 0) 요약 줄. 사유는 운영 extractPodFailureReason 이 자식 로그에서 읽는다.
    const podReason = extractPodFailureReason({ logs, containerReason: 'Error', jobReason: 'BackoffLimitExceeded',
      result: parsed ? { stage: parsed.stage ?? null, prUrl: parsed.prUrl ?? null, prNumber: parsed.prNumber ?? null } : null });
    const message = `Job ${job} failed (BackoffLimitExceeded, container=Error/1) — childStage=${parsed?.stage ?? 'unknown'} · reason=${podReason}`;
    const parentOutput = `[self-dev] run ${runId} pod\n${formatOrchestrateResultLine({ status: 'failed', feature: 'sim scope escape lift',
      stage: parsed?.stage, error: { code: 'pod-job-failed', message } })}\n`;
    const status = 1;
    const classified = classifyHarnessPodExit({ status }, parentOutput, { runId,
      supervisorDecision: () => undefined, hasJobApplied: () => true, loadCheckpoint: () => null });
    // ④ 부모 stop ⊕ incident — 운영 진입점이 부르는 순서 그대로(harness-cli-command.ts onPod).
    recordClassifiedHarnessPodExit(runId, classified.reason, status, { output: parentOutput });
    recordHarnessPodStop(runId, status, classified, parentOutput);
    const ledger = loadRunLedger(runId, dir) ?? [];
    const stopEntry = ledger.find((entry) => entry.event === 'stop');
    const incidentRow = readRunExits(root).find((row) => row.runId === runId);
    return {
      case: which,
      disposition: {
        ...(parsed?.stage !== undefined ? { stage: parsed.stage } : {}),
        ...(parsed?.failureClassification ? { failureClassification: parsed.failureClassification } : {}),
      },
      childEvidence,
      ledgerChildEvidence: ledger.find((entry) => entry.event === 'pod-child-evidence')?.data.childEvidence,
      parentExitReason: classified.reason,
      stop: stopEntry ? readRunStopRecord(stopEntry) : undefined,
      incident: incidentRow ? { reason: incidentRow.reason,
        ...(incidentRow.childEvidence ? { childEvidence: incidentRow.childEvidence } : {}) } : undefined,
    };
  });
}

export interface ScopeEscapeLiftPair {
  readonly scopeEscape: ScopeEscapeLiftObservation;
  readonly implementationDeficit: ScopeEscapeLiftObservation;
  /** 두 결과가 갈린 칸(고정 순서). */
  readonly differingFields: readonly string[];
  /** 두 결과가 같은 칸(고정 순서). */
  readonly sameFields: readonly string[];
}

const COMPARED: ReadonlyArray<readonly [string, (o: ScopeEscapeLiftObservation) => unknown]> = [
  ['disposition.stage', (o) => o.disposition.stage],
  ['disposition.failureClassification', (o) => o.disposition.failureClassification],
  ['childEvidence.classification', (o) => o.childEvidence?.classification],
  ['childEvidence.scopeEscape', (o) => o.childEvidence?.scopeEscape],
  ['childEvidence.outOfScopeEdits', (o) => o.childEvidence?.outOfScopeEdits],
  ['childEvidence.detail', (o) => o.childEvidence?.detail],
  ['parentExitReason', (o) => o.parentExitReason],
  ['stop.class', (o) => o.stop?.class],
  ['stop.cause', (o) => o.stop?.cause],
  ['incident.reason', (o) => o.incident?.reason],
];

/** 두 입력을 나란히 흘리고 갈린 칸을 센다. */
export function simScopeEscapeLiftPair(): ScopeEscapeLiftPair {
  const scopeEscape = simScopeEscapeLift('scope-escape');
  const implementationDeficit = simScopeEscapeLift('implementation-deficit');
  const differingFields: string[] = [];
  const sameFields: string[] = [];
  for (const [name, read] of COMPARED) {
    (JSON.stringify(read(scopeEscape)) === JSON.stringify(read(implementationDeficit)) ? sameFields : differingFields).push(name);
  }
  return { scopeEscape, implementationDeficit, differingFields, sameFields };
}

/** CLI·시험 출력 한 화면 — 두 분류 원문을 나란히. */
export function renderScopeEscapeLift(pair: ScopeEscapeLiftPair): string[] {
  const row = (o: ScopeEscapeLiftObservation): string =>
    `  ${o.case} · classification=${o.childEvidence?.classification ?? '-'} · scopeEscape=${String(o.childEvidence?.scopeEscape ?? '-')}`
    + ` · exit=${o.parentExitReason} · stop=${o.stop?.class ?? '-'} · incident=${o.incident?.reason ?? '-'}`
    + ` · failureClassification=${o.disposition.failureClassification ?? '-'}`;
  return [
    'scope-escape-lift · 층 L1 · 운영 함수 직접 호출(kubectl·네트워크 0)',
    row(pair.scopeEscape),
    row(pair.implementationDeficit),
    `  다른 칸: ${pair.differingFields.join(', ') || '없음'}`,
    `  같은 칸: ${pair.sameFields.join(', ') || '없음'}`,
    `  stop.cause[scope-escape]=${pair.scopeEscape.stop?.cause ?? '-'}`,
    `  stop.cause[implementation-deficit]=${pair.implementationDeficit.stop?.cause ?? '-'}`,
  ];
}
