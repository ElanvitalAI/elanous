/** STOP-RECORD stop_class values used by the card terminal classifier. */
export const STOP_CLASS_POD_FAILURE = 'pod-failure' as const;
export const STOP_CLASS_NO_LAUNCH = 'no-launch' as const;

/** Executor kinds of the dev child's `--json` result line (`src/index.ts` writeStdoutJson · DevExecutor.kind). */
const CHILD_RESULT_KINDS = new Set(['self', 'external']);

/** The dev child's terminal line nests the stage: {ok, kind, result:{stage, ok, node, outcome, …}}. Other JSON rows are not results. */
export function nestedPodResult(row: Record<string, unknown>): { stage: string; ok: boolean; error?: string } | null {
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
  return { stage: result.stage, ok: false, ...(error ? { error } : {}) };
}

/** One line naming each preflight blocker (`(대상 경로 0) — …`), or '' when the row carries none. */
function preflightBlockerText(blockers: unknown): string {
  if (!Array.isArray(blockers)) return '';
  return blockers.flatMap((blocker) => {
    if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) return [];
    const { name, detail } = blocker as Record<string, unknown>;
    const parts = [name, detail].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).map((part) => part.trim().replace(/\s+/gu, ' '));
    return parts.length ? [parts.join(' — ')] : [];
  }).join(' · ');
}

/** A child terminal row: the legacy flat form {stage, ok, error?} (no kind, or a child kind) or the nested dev result. Any other kind is not a result. */
export function podTerminalRow(row: Record<string, unknown>): { stage: string; ok: boolean; error?: string } | null {
  if (typeof row.kind === 'string' && !CHILD_RESULT_KINDS.has(row.kind)) return null;
  if (typeof row.stage === 'string' && typeof row.ok === 'boolean') {
    if (typeof row.error === 'string') return { stage: row.stage, ok: row.ok, error: row.error };
    // PREFLIGHT-RESULT-LINE: `{kind:'self', ok:false, stage:'preflight-blocked', blockers}` carries its reason in the blockers, not in `error`.
    const blockers = row.ok === false && row.stage === 'preflight-blocked' ? preflightBlockerText(row.blockers) : '';
    return { stage: row.stage, ok: row.ok, ...(blockers ? { error: blockers } : {}) };
  }
  return nestedPodResult(row);
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

  const isBookkeeping = (line: string): boolean =>
    /^(?:ELANOUS_(?:MEM|RUN_LEDGER|USAGE_ROLLUP|POD_)|\[graph\] |\[ask\]\s+\d+\)\s)/u.test(line) || /^(?:at\s+\S|\.\.\.\s+\d+\s+more\b|cleanup\s+(?:complete|done|finished)\b)/iu.test(line);
  const isError = (line: string): boolean =>
    /\berror\b|\bfail(?:ed|ure)?\b|exception|fatal|denied|timed?\s*out|exceeded|overloaded|unavailable|exhausted|오류|실패/iu.test(line);
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
  const reason = errorLine?.text.replace(/\/home\/[^/\s]+\//gu, '~/').slice(0, 240);
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
  return `사유 못 읽음: ${why.replace(/\/home\/[^/\s]+\//gu, '~/').slice(0, 240)}`;
}
