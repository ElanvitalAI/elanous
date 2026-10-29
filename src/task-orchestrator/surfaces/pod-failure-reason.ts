/** STOP-RECORD stop_class values used by the card terminal classifier. */
export const STOP_CLASS_POD_FAILURE = 'pod-failure' as const;
export const STOP_CLASS_NO_LAUNCH = 'no-launch' as const;

/** Executor kinds of the dev child's `--json` result line (`src/index.ts` writeStdoutJson · DevExecutor.kind). */
const CHILD_RESULT_KINDS = new Set(['self', 'external']);

/** The dev child's terminal line nests the stage: {ok, kind, result:{stage, ok, node, outcome, …}}. Other JSON rows are not results. */
export function nestedPodResult(row: Record<string, unknown>): {
  stage: string;
  ok: boolean;
  error?: string;
  reasonCode?: string;
  checkName?: string;
  targetPath?: string;
  preflightChecks?: PreflightCheck[];
} | null {
  if (typeof row.kind !== 'string' || !CHILD_RESULT_KINDS.has(row.kind) || typeof row.ok !== 'boolean') return null;
  if (!row.result || typeof row.result !== 'object' || Array.isArray(row.result)) return null;
  const result = row.result as Record<string, unknown>;
  if (typeof result.stage !== 'string' || typeof result.ok !== 'boolean') return null;
  if (result.ok) return { stage: result.stage, ok: true };
  const classification = result.abandonedClassification;
  const detail = typeof result.supervisorVerdict === 'string' ? result.supervisorVerdict
    : classification && typeof classification === 'object' && !Array.isArray(classification)
      ? (classification as Record<string, unknown>).classification : undefined;
  const reason = [result.node, result.outcome].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
  const error = [reason || (typeof result.error === 'string' ? result.error : ''), typeof detail === 'string' && detail ? detail : ''].filter(Boolean).join(' · ');
  // PREFLIGHT-RESULT-LINE: a nested preflight rejection carries its blockers under result.blockers — the same ledger fields as the flat row.
  const blockers = result.stage === 'preflight-blocked' ? preflightBlockerText(result.blockers)
    : { error: '', preflightChecks: [] as PreflightCheck[] };
  return {
    stage: result.stage,
    ok: false,
    ...(error || blockers.error ? { error: error || blockers.error } : {}),
    ...(blockers.preflightChecks.length === 1 ? blockers.preflightChecks[0] : {}),
    ...(blockers.preflightChecks.length > 1 ? { preflightChecks: blockers.preflightChecks } : {}),
  };
}

function ledgerString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

export type PreflightCheck = { reasonCode: string; checkName: string; targetPath?: string };

/**
 * A Pod failure's structured ledger axes: the rejection's own reason code, check name and *untruncated* target
 * path, kept apart from the human-readable reason text — and, separately from all of them, whether the child's
 * terminal result line was absent at all.
 */
export interface PodFailureLedgerAxes {
  readonly reasonCode?: string;
  readonly checkName?: string;
  readonly targetPath?: string;
  readonly preflightChecks?: readonly PreflightCheck[];
  /** `true` = the child wrote no terminal result line. Absence is never folded into the rejection reason. */
  readonly noResultLine?: true;
}

/** Keep the failure's structured facts as their own ledger fields; absent facts stay omitted (never `''`). */
export function podFailureLedgerAxes(exit: PodFailureLedgerAxes): PodFailureLedgerAxes {
  return {
    ...(exit.reasonCode ? { reasonCode: exit.reasonCode } : {}),
    ...(exit.checkName ? { checkName: exit.checkName } : {}),
    ...(exit.targetPath ? { targetPath: exit.targetPath } : {}),
    ...(exit.preflightChecks?.length ? { preflightChecks: exit.preflightChecks } : {}),
    ...(exit.noResultLine ? { noResultLine: true as const } : {}),
  };
}

/** Keep each structured check paired with its own path; legacy blockers retain their name/detail diagnostic. */
function preflightBlockerText(blockers: unknown): { error: string; preflightChecks: PreflightCheck[] } {
  if (!Array.isArray(blockers)) return { error: '', preflightChecks: [] };
  const errors: string[] = [];
  const preflightChecks: PreflightCheck[] = [];
  for (const blocker of blockers) {
    if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) continue;
    const record = blocker as Record<string, unknown>;
    const reasonCode = ledgerString(record.reasonCode);
    const checkName = ledgerString(record.checkName);
    if (reasonCode && checkName) {
      const targetPath = ledgerString(record.targetPath);
      preflightChecks.push({ reasonCode, checkName, ...(targetPath ? { targetPath } : {}) });
      errors.push(`${reasonCode} · ${checkName}`);
      continue;
    }
    const parts = [record.name, record.detail]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.trim().replace(/\s+/gu, ' '));
    if (parts.length) errors.push(parts.join(' — '));
  }
  return { error: errors.join(' · '), preflightChecks };
}

/** A child terminal row: the legacy flat form {stage, ok, error?} (no kind, or a child kind) or the nested dev result. Any other kind is not a result. */
export function podTerminalRow(row: Record<string, unknown>): {
  stage: string;
  ok: boolean;
  error?: string;
  reasonCode?: string;
  checkName?: string;
  targetPath?: string;
  preflightChecks?: PreflightCheck[];
} | null {
  if (typeof row.kind === 'string' && !CHILD_RESULT_KINDS.has(row.kind)) return null;
  if (typeof row.stage === 'string' && typeof row.ok === 'boolean') {
    // PREFLIGHT-RESULT-LINE: preserve structured blockers even when an explicit error supplies the human-readable reason.
    if (row.ok === false && row.stage === 'preflight-blocked') {
      const blockers = preflightBlockerText(row.blockers);
      return {
        stage: row.stage,
        ok: row.ok,
        ...(typeof row.error === 'string' ? { error: row.error } : blockers.error ? { error: blockers.error } : {}),
        ...(blockers.preflightChecks.length === 1 ? blockers.preflightChecks[0] : {}),
        ...(blockers.preflightChecks.length > 1 ? { preflightChecks: blockers.preflightChecks } : {}),
      };
    }
    return { stage: row.stage, ok: row.ok, ...(typeof row.error === 'string' ? { error: row.error } : {}) };
  }
  return nestedPodResult(row);
}

export const POD_EXIT_CLASSES = ['oom-killed', 'deadline-exceeded', 'gh-login-failed', 'pod-secret', 'ask-reprompt', 'provider-error', 'child-unconverged', 'child-error', 'no-result-line', 'unknown'] as const;

export type PodExitClass = typeof POD_EXIT_CLASSES[number];

/** Build the parent-ledger row for a terminal child attempt. A Job can complete
 * successfully while its child result is still unsuccessful (for example,
 * report-deficit after preserving a partial PR); retain both facts together. */
export function podChildEvidenceLedgerRow(input: {
  job: string;
  childRunId: string;
  state: 'complete' | 'failed' | 'aborted';
  result?: {
    stage?: unknown;
    ok?: unknown;
    failureClassification?: unknown;
    completionDisposition?: unknown;
    error?: unknown;
    childEvidence?: unknown;
  } | null;
  noResultDiagnostic?: string | null;
  noResultLogEvidence?: Record<string, unknown> | null;
  podTermination?: PodTermination | null;
}): Record<string, unknown> | null {
  const { result } = input;
  const persist = input.state === 'failed' || input.state === 'aborted' || input.noResultLogEvidence != null
    || (input.state === 'complete' && (input.noResultDiagnostic != null || result?.ok === false));
  if (!persist) return null;

  const childEvidence = input.noResultLogEvidence
    ? { ...(result?.childEvidence && typeof result.childEvidence === 'object' && !Array.isArray(result.childEvidence)
      ? result.childEvidence as Record<string, unknown> : {}), ...input.noResultLogEvidence }
    : result?.childEvidence ?? null;
  const completedButUnsuccessful = input.state === 'complete' && result?.ok === false;
  const childResult = completedButUnsuccessful && result ? Object.fromEntries([
    ['stage', result.stage], ['ok', result.ok], ['failureClassification', result.failureClassification],
    ['completionDisposition', result.completionDisposition], ['error', result.error],
  ].filter(([, value]) => value !== undefined)) : null;

  return {
    childEvidence,
    childRunId: input.childRunId,
    job: input.job,
    ...(input.podTermination ? { podTermination: input.podTermination } : {}),
    ...(childResult && Object.keys(childResult).length > 0 ? { childResult } : {}),
  };
}

const isPodBookkeepingLine = (line: string): boolean =>
  /^(?:ELANOUS_(?:MEM|RUN_LEDGER|USAGE_ROLLUP|POD_)|\[graph\] |\[ask\]\s+\d+\)\s)/u.test(line) || /^(?:at\s+\S|\.\.\.\s+\d+\s+more\b|cleanup\s+(?:complete|done|finished)\b)/iu.test(line);

const isPodErrorLine = (line: string): boolean =>
  /\berror\b|\bfail(?:ed|ure)?\b|exception|fatal|denied|timed?\s*out|exceeded|overloaded|unavailable|exhausted|오류|실패/iu.test(line);

const normalizePodLogLine = (line: string): string => line.replace(/\/home\/[^/\s]+\//gu, '~/').slice(0, 240);

/**
 * PROVIDER-ERROR-PRIORITY: 모델 호출 쪽이 죽은 줄(자격증명·쿼터·과부하·업스트림 5xx).
 * 자식이 스스로 수렴 못 한 것과 사유가 다르므로 generic 실패(child-error/unknown)보다 먼저 분류한다.
 */
const POD_PROVIDER_ERROR_LINE =
  /\bllm\.[a-z0-9_-]+ (?:credential|response|stream)\b.*\b(?:error|fail(?:ed|ure)?|denied|unavailable|overloaded|exhausted)\b|\b(?:rate[_ -]?limit|quota|credits?)\b.*\b(?:exceeded|exhausted|insufficient|hit)\b|\b(?:provider|upstream)\b.*\b(?:error|overloaded|unavailable|timed? out|5\d\d)\b|(?:프로바이더|제공자|모델)\s*(?:오류|호출 실패|한도 초과)/iu;

/** provider error 줄인가 — bookkeeping 줄과 «파싱되는 JSON 줄»은 세지 않는다(classifyPodExit 의 줄 기준과 같다). */
function isPodProviderErrorLine(line: string): boolean {
  if (!line || isPodBookkeepingLine(line)) return false;
  if (line.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return false;
    } catch { /* 일반 줄이 중괄호로 시작할 수 있다. */ }
  }
  return POD_PROVIDER_ERROR_LINE.test(line);
}

/**
 * POD-FAIL-EVIDENCE-CAPTURE-FU — duplicate-cap 귀속: 마지막 «canonical» 자식 terminal 하나에만 실패를 붙인다.
 * canonical 접두(`self`/`external`)가 아닌 lookalike kind 행은 건너뛰고, 마지막 canonical terminal 이 성공이거나
 * 읽을 오류 줄이 bookkeeping 뿐이면 null — 더 오래된(다른 terminal 의) 실패를 재사용하지 않는다.
 */
export function podChildFailureAttribution(logs: string): { stage: string; error: string } | null {
  for (const line of logs.split('\n').reverse()) {
    if (!line.trimStart().startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    const terminal = podTerminalRow(row);
    if (!terminal) continue;
    if (terminal.ok !== false || typeof terminal.error !== 'string') return null;
    const errorLines = terminal.error.replace(/\/home\/[^/\s]+\//gu, '~/').split(/\r\n|\n|\r/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !isPodBookkeepingLine(part));
    if (!errorLines.length) return null;
    const first = errorLines[0]!.slice(0, 240);
    const last = errorLines.at(-1)!.slice(0, 240);
    return { stage: terminal.stage, error: first === last ? first : `${first}\n${last}` };
  }
  return null;
}

/** Classify a failed Pod using its terminal metadata and child output, without side effects. */
export function classifyPodExit(input: {
  errorCode?: string | null;
  containerReason?: string | null;
  containerExitCode?: number | null;
  jobReason?: string | null;
  logs: string;
  result?: Record<string, unknown> | null;
}): {
  class: PodExitClass;
  errorCode: string | null;
  containerReason: string | null;
  exitCode: number | null;
  jobReason: string | null;
  tail: string[];
  reasonCode?: string;
  checkName?: string;
  targetPath?: string;
  preflightChecks?: PreflightCheck[];
  noResultLine?: true;
} {
  const logLines = input.logs.split(/\r\n|\n|\r/u).map((line) => line.trim()).filter(Boolean);
  let terminalResult: ReturnType<typeof podTerminalRow> = null;
  let lastTerminalIndex = -1;
  let previousTerminalIndex = -1;
  for (const [index, line] of logLines.entries()) {
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const terminal = podTerminalRow(parsed as Record<string, unknown>);
    if (!terminal) continue;
    // 마지막 canonical terminal 만 유지 — 앞선 terminal 의 실패를 재사용하지 않는다(duplicate-cap).
    previousTerminalIndex = lastTerminalIndex;
    terminalResult = terminal;
    lastTerminalIndex = index;
  }
  const hasResultLine = terminalResult !== null;
  if (!terminalResult && input.result) terminalResult = podTerminalRow(input.result);
  const askReprompt = logLines.some((line) =>
    /^\[ask\](?!\s+\d+\)\s).*(?:implementation[_ -]?target|reprompt|re-prompt|되묻)/iu.test(line));
  // 파싱되는 JSON 줄(진행·결과 행)은 오류 «줄»로 세지 않는다 — tail 과 같은 기준.
  const isParsedJsonLine = (line: string): boolean => {
    if (!line.startsWith('{')) return false;
    try { const parsed = JSON.parse(line); return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed); } catch { return false; }
  };
  const hasErrorLine = logLines.some((line) => !isPodBookkeepingLine(line) && !isParsedJsonLine(line) && isPodErrorLine(line));
  // 동일 terminal 직전만: 마지막 canonical terminal 에 딸린 구간(직전 terminal 다음 ~ 마지막 terminal)의 줄만
  // provider error 근거로 쓴다 — 오래된 terminal 의 실패를 재사용하지 않는다(duplicate-cap).
  const attributionLines = lastTerminalIndex === -1
    ? logLines
    : logLines.slice(previousTerminalIndex + 1, lastTerminalIndex);
  const providerError = attributionLines.some((line) => isPodProviderErrorLine(line));
  let exitClass: PodExitClass;
  if (input.errorCode === 'pod-secret') exitClass = 'pod-secret';
  else if (input.jobReason === 'DeadlineExceeded') exitClass = 'deadline-exceeded';
  else if (input.containerReason === 'OOMKilled') exitClass = 'oom-killed';
  else if (input.containerExitCode === 7) exitClass = 'gh-login-failed';
  else if (askReprompt) exitClass = 'ask-reprompt';
  else if (providerError) exitClass = 'provider-error';
  else if (terminalResult?.stage && terminalResult.ok === false) exitClass = 'child-unconverged';
  else if (!hasResultLine && hasErrorLine) exitClass = 'child-error';
  else if (!hasResultLine) exitClass = 'no-result-line';
  else exitClass = 'unknown';

  const tail = logLines.flatMap((line) => {
    if (line.startsWith('{')) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { parsed = undefined; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const terminal = podTerminalRow(parsed as Record<string, unknown>);
        if (terminal?.error) return terminal.error.split(/\r\n|\n|\r/u).map((part) => part.trim())
          .filter((part) => part && !isPodBookkeepingLine(part)).map(normalizePodLogLine);
        return [];
      }
    }
    return isPodBookkeepingLine(line) ? [] : [normalizePodLogLine(line)];
  }).slice(-5);

  return {
    class: exitClass,
    errorCode: input.errorCode ?? null,
    containerReason: input.containerReason ?? null,
    exitCode: input.containerExitCode ?? null,
    jobReason: input.jobReason ?? null,
    tail,
    ...(terminalResult?.reasonCode ? { reasonCode: terminalResult.reasonCode } : {}),
    ...(terminalResult?.checkName ? { checkName: terminalResult.checkName } : {}),
    ...(terminalResult?.targetPath ? { targetPath: terminalResult.targetPath } : {}),
    ...(terminalResult?.preflightChecks ? { preflightChecks: terminalResult.preflightChecks } : {}),
    ...(!hasResultLine ? { noResultLine: true as const } : {}),
  };
}

/** Extract a human-readable reason from a failed child Pod without treating transfer markers as child errors. */
export function extractPodFailureReason(input: {
  logs: string;
  logTailReason?: string;
  containerReason?: string | null;
  jobReason?: string;
  deadlineSeconds?: number;
  /** POD-NORESULT: the stage and PR from the child's parsed result row (disposition) — used only when no log line gives a readable reason. */
  result?: { stage?: string | null; prUrl?: string | null; prNumber?: number | null } | null;
}): string {
  if (input.jobReason === 'DeadlineExceeded') {
    return `DeadlineExceeded: Job 수명 상한 ${input.deadlineSeconds ?? 'unknown'}초 초과`;
  }
  if (input.containerReason === 'OOMKilled') return 'OOMKilled: 컨테이너 메모리 한도 초과';

  const isBookkeeping = isPodBookkeepingLine;
  const isError = isPodErrorLine;
  const meaningful: Array<{ text: string; terminal: boolean }> = [];
  for (const line of input.logs.split(/\r\n|\n|\r/u)) {
    const trimmed = line.trim();
    if (!trimmed || isBookkeeping(trimmed)) continue;
    if (trimmed.startsWith('{')) {
      let parsed: unknown;
      try { parsed = JSON.parse(trimmed); } catch { /* An ordinary line may begin with a brace. */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const row = parsed as Record<string, unknown>;
        const terminal = podTerminalRow(row);
        if (terminal) {
          meaningful.length = 0;
          if (terminal.ok === false && typeof terminal.error === 'string') {
            const errorLines = terminal.error.split(/\r\n|\n|\r/u).map((part) => part.trim())
              .filter((part) => part && !isBookkeeping(part));
            const errorLine = [...errorLines].reverse().find(isError) ?? errorLines.at(-1);
            if (errorLine) meaningful.push({ text: errorLine, terminal: true });
          }
          continue;
        }
        // A JSON transfer/observation is not a plain-text failure reason.
        continue;
      }
    }
    meaningful.push({ text: trimmed, terminal: false });
  }
  const errorLine = [...meaningful].reverse().find((line) => line.terminal || isError(line.text));
  const reason = errorLine ? normalizePodLogLine(errorLine.text) : undefined;
  if (reason) return reason;
  // POD-NORESULT: an unconverged child (exit 2 → BackoffLimitExceeded under backoffLimit 0) often leaves a result row
  // with a stage and PR but no error text — report that instead of «unreadable».
  const stage = input.result?.stage?.trim();
  if (stage) {
    const prNumber = input.result?.prNumber;
    const pr = Number.isSafeInteger(prNumber) && prNumber! > 0 ? `PR #${prNumber}` : input.result?.prUrl ? `PR ${input.result.prUrl}` : '';
    return pr ? `수확 가능(${stage}) · ${pr}` : `수렴 못 함(단계 ${stage})`;
  }
  const why = input.logTailReason?.trim() || (input.logs.trim() ? '로그에 읽을 수 있는 오류 줄 없음' : '자식 로그 비어 있음');
  return `사유 못 읽음: ${normalizePodLogLine(why)}`;
}

// JOB-FAILURE-TERMINATION-CAPTURE — the Kubernetes facts of a failed Job, read once at the failure verdict
//   (Job Failed condition · result marker early exit) before GC removes the Job and its Pod. Unobserved stays
//   `unknown` — `no-result-line` is never promoted to OOM or deadline here. Only these scalar fields are kept:
//   no Pod env, Secret, or describe output.
export type PodTerminationPath = 'job-failed-condition' | 'result-marker';
export type PodTerminationUnknown = 'unknown';

export interface PodTermination {
  job: string;
  path: PodTerminationPath;
  observedAt: string;
  /** `ok` only when the Job read names this launch's uid · `unavailable`: failed (NotFound after GC · API error),
   *  a different or missing uid, or no launch uid to attribute it to. */
  jobLookup: 'ok' | 'unavailable';
  /** This launch's Job uid (the attribution key) — `unknown` when the launcher had none, and then nothing is attributed. */
  jobUid: string | PodTerminationUnknown;
  jobConditionReason: string | PodTerminationUnknown;
  /** The Job's configured `spec.activeDeadlineSeconds` — a setting, not evidence the deadline fired. */
  activeDeadlineSeconds: number | PodTerminationUnknown;
  /** From the Job Failed condition reason `DeadlineExceeded` only. */
  deadlineExceeded: boolean | PodTerminationUnknown;
  /** `terminated`: the latest child container of this uid has a terminated state · without one, the Pod phase
   *  (`running` · `pending`) or `unknown` (any other or unread phase) · `absent`: no Pod of this uid. */
  podLookup: 'terminated' | 'running' | 'pending' | 'unknown' | 'absent' | 'unavailable';
  containerReason: string | PodTerminationUnknown;
  exitCode: number | PodTerminationUnknown;
  finishedAt: string | PodTerminationUnknown;
  /** From `state.terminated.reason === 'OOMKilled'` only (never from exit code 137). */
  oomKilled: boolean | PodTerminationUnknown;
  /** A terminal verdict can race Kubernetes container status; one bounded Pod re-read records the outcome. */
  collectionAttempts?: 2;
  collectionFailureReason?: 'pod-still-running-after-retry' | 'pod-absent-after-retry' |
    'pod-read-unavailable-after-retry' | 'terminated-fields-missing-after-retry' | 'pod-state-unknown-after-retry';
}

/** FailureTarget can precede Failed at the deadline. Read both in the same Job snapshot. */
export const POD_TERMINATION_JOB_JSONPATH = '{.status.conditions[?(@.type=="Failed")].reason}{"|"}{.status.conditions[?(@.type=="FailureTarget")].reason}{"\\t"}{.spec.activeDeadlineSeconds}{"\\t"}{.metadata.uid}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.status.completionTime}';

export function podJobConditionReason(value: string | undefined): string {
  const [failed, target] = (value ?? '').split('|');
  return terminationWord(failed || target);
}

/** Emitted by the Pod wrapper before the Job's hard deadline, scoped to this Job and child run. */
export function podDeadlineResultMarker(logs: string, job: string, runId: string): { stage: string; pr: number | null; branch: string | null } | null {
  if (!/^[A-Za-z0-9_.:-]+$/.test(job) || !/^[A-Za-z0-9_.:-]+$/.test(runId)) return null;
  const prefix = `ELANOUS_POD_DEADLINE_RESULT ${job} ${runId} stop-cause=deadline `;
  for (const line of logs.split('\n').reverse()) {
    if (!line.startsWith(prefix)) continue;
    const match = /^stage=(clone|setup|run|unknown) pr=(unknown|[1-9]\d*) branch=(unknown|[A-Za-z0-9_./-]+)$/.exec(line.slice(prefix.length).trim());
    if (match) return { stage: match[1]!, pr: match[2] === 'unknown' ? null : Number(match[2]), branch: match[3] === 'unknown' ? null : match[3]! };
  }
  return null;
}
/**
 * One row per Pod of this Job name. The first three columns keep the classification read's layout
 * (`creation · terminated.reason · terminated.exitCode`, empty when the child has no status yet), so the
 * Failed-condition path reads Pods once for both; `finishedAt` follows, then `|phase · owner Job uid`.
 */
export const POD_TERMINATION_PODS_JSONPATH = '{range .items[*]}{.metadata.creationTimestamp}{"\\t"}{range .status.containerStatuses[?(@.name=="child")]}{.state.terminated.reason}{"\\t"}{.state.terminated.exitCode}{"\\t"}{.state.terminated.finishedAt}{end}{"\\t"}{"\\t"}{"\\t"}{"|"}{.status.phase}{"\\t"}{.metadata.ownerReferences[?(@.kind=="Job")].uid}{"\\n"}{end}';

type PodTerminationKubectl = (args: readonly string[]) => { status: number | null; stdout: string; stderr: string };

const POD_TERMINATION_WORD = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const JOB_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const terminationWord = (value: string | undefined): string => {
  const text = value?.trim() ?? '';
  return POD_TERMINATION_WORD.test(text) ? text : 'unknown';
};
const terminationCount = (value: string | undefined): number | PodTerminationUnknown => {
  const text = value?.trim() ?? '';
  return /^\d{1,10}$/.test(text) ? Number(text) : 'unknown';
};
const terminationInstant = (value: string | undefined): string => {
  const text = value?.trim() ?? '';
  return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(text) && Number.isFinite(Date.parse(text)) ? text : 'unknown';
};

/** Two reads (the Job · its Pods), each fail-soft: a failed or thrown read is `unavailable`, never an inferred value. */
export function readPodTermination(input: { kubectl: PodTerminationKubectl; namespace: string; job: string; path: PodTerminationPath;
  /** This launch's Job uid — the only attribution key. A same-name Job of another round (OOM retry · relaunch)
   *  is not this verdict's state; without it every Job/Pod fact stays unobserved. */
  jobUid: string | undefined;
  /** The Failed-condition path's own Job read of `POD_TERMINATION_JOB_JSONPATH` (null: it threw) — not read again,
   *  so a GC between the verdict and the capture cannot turn an observed reason into `unknown`. */
  jobRead?: { status: number | null; stdout: string } | null;
  /** The Failed-condition path's own Pods read of `POD_TERMINATION_PODS_JSONPATH` (null: it threw) — not read again. */
  podsRead?: { status: number | null; stdout: string } | null;
  now?: () => Date }): PodTermination {
  const { kubectl, namespace, job, path } = input;
  const read = (args: readonly string[]): { status: number | null; stdout: string } | null => {
    try { return kubectl(args); } catch { return null; }
  };
  const jobRead = 'jobRead' in input ? input.jobRead ?? null
    : read(['-n', namespace, 'get', 'job', job, '-o', `jsonpath=${POD_TERMINATION_JOB_JSONPATH}`]);
  const [reasonText, deadlineText, uidText] = jobRead?.status === 0 ? jobRead.stdout.replace(/\r?\n$/, '').split('\t') : [];
  const readUid = JOB_UID.test(uidText?.trim() ?? '') ? uidText!.trim() : undefined;
  const jobUid = input.jobUid && JOB_UID.test(input.jobUid) ? input.jobUid : undefined;
  // A read without a uid, or with another uid, is not this launch's Job.
  const jobOk = jobRead?.status === 0 && jobUid !== undefined && readUid === jobUid;
  const jobConditionReason = jobOk ? podJobConditionReason(reasonText) : 'unknown';
  const podsRead = 'podsRead' in input ? input.podsRead ?? null
    : read(['-n', namespace, 'get', 'pods', '-l', `job-name=${job}`, '-o', `jsonpath=${POD_TERMINATION_PODS_JSONPATH}`]);
  let podLookup: PodTermination['podLookup'] = 'unavailable';
  let containerReason = 'unknown';
  let exitCode: PodTermination['exitCode'] = 'unknown';
  let finishedAt = 'unknown';
  // Without a uid the rows cannot be attributed to this Job — they stay unread rather than borrowed from another round.
  if (podsRead?.status === 0 && jobUid) {
    // The latest Pod owned by this Job uid only.
    const rows = podsRead.stdout.split('\n').map((line) => {
      const cut = line.lastIndexOf('\t|');
      const [created, reason, exit, finished] = (cut >= 0 ? line.slice(0, cut) : line).split('\t');
      const [phase, owner] = cut >= 0 ? line.slice(cut + 2).split('\t') : [];
      return { created: created ?? '', reason, exit, finished, phase: phase?.trim(), owner: owner?.trim() };
    });
    const owned = rows.filter((row) => row.created && Number.isFinite(Date.parse(row.created)) && row.owner === jobUid)
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
    const latest = owned[0];
    // Two Pods of this uid created at the same instant (a Job retry): which one is «this» failure is not knowable.
    const tied = latest !== undefined && owned.length > 1 && Date.parse(owned[1]!.created) === Date.parse(latest.created);
    if (!latest) podLookup = 'absent';
    else if (tied) podLookup = 'unknown';
    else {
      const { reason, exit, finished, phase } = latest;
      containerReason = terminationWord(reason);
      exitCode = terminationCount(exit);
      finishedAt = terminationInstant(finished);
      podLookup = containerReason !== 'unknown' || exitCode !== 'unknown' ? 'terminated'
        : phase === 'Running' ? 'running' : phase === 'Pending' ? 'pending' : 'unknown';
    }
  }
  return {
    job, path, observedAt: (input.now?.() ?? new Date()).toISOString(),
    jobLookup: jobOk ? 'ok' : 'unavailable',
    jobUid: jobUid ?? 'unknown',
    jobConditionReason,
    activeDeadlineSeconds: jobOk ? terminationCount(deadlineText) : 'unknown',
    deadlineExceeded: jobConditionReason === 'unknown' ? 'unknown' : jobConditionReason === 'DeadlineExceeded',
    podLookup, containerReason, exitCode, finishedAt,
    oomKilled: podLookup === 'terminated' && containerReason !== 'unknown' ? containerReason === 'OOMKilled' : 'unknown',
  };
}

/** Ledger → incident: only a well-formed record of `job` (the current attempt's Job) is carried; anything else is dropped. */
export function parsePodTermination(value: unknown, job: string): PodTermination | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const oneOf = (v: unknown, allowed: readonly unknown[]) => allowed.includes(v);
  const wordOrUnknown = (v: unknown) => typeof v === 'string' && (v === 'unknown' || POD_TERMINATION_WORD.test(v));
  const numberOrUnknown = (v: unknown) => v === 'unknown' || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
  const boolOrUnknown = (v: unknown) => v === 'unknown' || typeof v === 'boolean';
  if (row.job !== job || !oneOf(row.path, ['job-failed-condition', 'result-marker'])
    || typeof row.observedAt !== 'string' || !Number.isFinite(Date.parse(row.observedAt))
    || !oneOf(row.jobLookup, ['ok', 'unavailable']) || !wordOrUnknown(row.jobConditionReason)
    || !(row.jobUid === 'unknown' || (typeof row.jobUid === 'string' && JOB_UID.test(row.jobUid)))
    || !numberOrUnknown(row.activeDeadlineSeconds) || !boolOrUnknown(row.deadlineExceeded)
    || !oneOf(row.podLookup, ['terminated', 'running', 'pending', 'unknown', 'absent', 'unavailable'])
    || !wordOrUnknown(row.containerReason) || !numberOrUnknown(row.exitCode)
    || !(row.finishedAt === 'unknown' || (typeof row.finishedAt === 'string' && terminationInstant(row.finishedAt) !== 'unknown'))
    || !boolOrUnknown(row.oomKilled)
    || (row.collectionAttempts !== undefined && row.collectionAttempts !== 2)
    || (row.collectionFailureReason !== undefined && !oneOf(row.collectionFailureReason, [
      'pod-still-running-after-retry', 'pod-absent-after-retry', 'pod-read-unavailable-after-retry',
      'terminated-fields-missing-after-retry', 'pod-state-unknown-after-retry']))) return undefined;
  // Facts are attributed through the uid only: a record claiming Job or Pod facts without one is contradictory.
  if (row.jobUid === 'unknown' && (row.jobLookup !== 'unavailable' || row.podLookup !== 'unavailable')) return undefined;
  return {
    job, path: row.path as PodTerminationPath, observedAt: row.observedAt,
    jobLookup: row.jobLookup as PodTermination['jobLookup'], jobUid: row.jobUid as string, jobConditionReason: row.jobConditionReason as string,
    activeDeadlineSeconds: row.activeDeadlineSeconds as PodTermination['activeDeadlineSeconds'],
    deadlineExceeded: row.deadlineExceeded as PodTermination['deadlineExceeded'],
    podLookup: row.podLookup as PodTermination['podLookup'], containerReason: row.containerReason as string,
    exitCode: row.exitCode as PodTermination['exitCode'], finishedAt: row.finishedAt as string,
    oomKilled: row.oomKilled as PodTermination['oomKilled'],
    ...(row.collectionAttempts === 2 ? { collectionAttempts: 2 as const } : {}),
    ...(row.collectionFailureReason ? { collectionFailureReason: row.collectionFailureReason as PodTermination['collectionFailureReason'] } : {}),
  };
}
