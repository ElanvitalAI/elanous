export type HarvestInput = {
  ask?: unknown;
  context?: unknown;
  prior?: unknown;
};

export type ReviewInvocation = {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
};

export type HarvestResult = {
  outcome: 'done' | 'rework' | 'needs-human' | 'failed';
  result: Record<string, unknown>;
  evidence: Record<string, unknown>;
};

type ReviewRecord = Record<string, unknown> & {
  pr?: string | number;
  reviewed?: boolean;
  verdict?: string | null;
  mustFix?: unknown;
  model?: string;
  headCommit?: string;
  currentHeadCommit?: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectedHead(input: HarvestInput): string | undefined {
  if (object(input.context) && typeof input.context.expectedHead === 'string' && input.context.expectedHead.trim()) return input.context.expectedHead.trim();
  return undefined;
}

function normalizedPr(value: unknown): string | undefined {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const normalized = raw.replace(/^#/, '');
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

function previousAttempts(input: HarvestInput): number {
  if (!object(input.prior)) return 0;
  const result = object(input.prior.result) ? input.prior.result : input.prior;
  const attempts = result.attempts;
  return Number.isSafeInteger(attempts) && (attempts as number) >= 0 ? attempts as number : 0;
}

function parseReview(stdout: string): ReviewRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (Array.isArray(parsed)) {
      if (parsed.length !== 1) return undefined;
      return object(parsed[0]) ? parsed[0] as ReviewRecord : undefined;
    }
    return object(parsed) ? parsed as ReviewRecord : undefined;
  } catch {
    return undefined;
  }
}

export async function runHarvestUnit(
  input: HarvestInput,
  invokeReview: (args: { pr: string; intent: string }) => Promise<ReviewInvocation>,
): Promise<HarvestResult> {
  const attempts = previousAttempts(input) + 1;
  const prValue = object(input.context) ? input.context.pr : undefined;
  const pr = normalizedPr(prValue);
  if (!pr) {
    return { outcome: 'failed', result: { attempts, error: 'context.pr must identify one pull request' }, evidence: { pr: pr || null, attempts } };
  }

  const context = object(input.context) ? input.context : {};
  const hasContextIntent = Object.prototype.hasOwnProperty.call(context, 'reviewIntent');
  const intentValue = context.reviewIntent;
  const intent = hasContextIntent
    ? typeof intentValue === 'string' ? intentValue.trim() : ''
    : typeof input.ask === 'string' ? input.ask.trim() : '';
  if (!intent) {
    return { outcome: 'failed', result: { attempts, error: hasContextIntent ? 'context.reviewIntent must be a non-empty string' : 'context.reviewIntent or ask is required' }, evidence: { pr, attempts } };
  }
  const expected = expectedHead(input);
  if (!expected || !/^[0-9a-f]{40}$/i.test(expected)) {
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'expected PR head is required' }, evidence: { pr, attempts, expectedHead: expected ?? null } };
  }

  let invocation: ReviewInvocation;
  try {
    invocation = await invokeReview({ pr: pr.replace(/^#/, ''), intent });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'review could not be executed' }, evidence: { pr, attempts, error: reason } };
  }

  const review = parseReview(invocation.stdout);
  if (!review || review.reviewed !== true || typeof review.headCommit !== 'string' || typeof review.currentHeadCommit !== 'string') {
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'review result is missing or incomplete' }, evidence: {
      pr, attempts, exitCode: invocation.exitCode, stderr: invocation.stderr ?? '', stdout: invocation.stdout.slice(0, 4000),
    } };
  }
  if (normalizedPr(review.pr) !== pr) {
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'review result belongs to a different pull request' }, evidence: {
      pr, attempts, reviewedPr: review.pr ?? null, expectedHead: expected,
    } };
  }
  if (invocation.exitCode !== 0) {
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'review command exited unsuccessfully' }, evidence: {
      pr, attempts, exitCode: invocation.exitCode, stderr: invocation.stderr ?? '',
    } };
  }
  if (review.headCommit !== review.currentHeadCommit || (expected !== undefined && review.headCommit !== expected)) {
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'review head is stale or differs from expected head' }, evidence: {
      pr, attempts, expectedHead: expected ?? null, reviewedHead: review.headCommit, currentHead: review.currentHeadCommit,
    } };
  }
  if (!['pass', 'warn', 'fail'].includes(review.verdict ?? '')) {
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'review verdict is missing or invalid' }, evidence: {
      pr, attempts, verdict: review.verdict ?? null, headCommit: review.headCommit,
    } };
  }
  if (!Array.isArray(review.mustFix) || !review.mustFix.every(item => typeof item === 'string' && item.trim().length > 0)) {
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'review mustFix field is invalid' }, evidence: { pr, attempts, headCommit: review.headCommit } };
  }

  const mustFix = review.mustFix as string[];
  if ((review.verdict === 'fail' && mustFix.length === 0)
    || ((review.verdict === 'pass' || review.verdict === 'warn') && mustFix.length > 0)) {
    return { outcome: 'needs-human', result: { pr, attempts, reason: 'review verdict conflicts with mustFix findings' }, evidence: {
      pr, attempts, verdict: review.verdict, mustFix, headCommit: review.headCommit,
    } };
  }
  const evidence = {
    pr, headCommit: review.headCommit, attempts, model: review.model ?? null, verdict: review.verdict ?? null,
    reviewResultsJson: true, exitCode: invocation.exitCode,
  };
  return mustFix.length > 0
    ? { outcome: 'rework', result: { pr, headCommit: review.headCommit, attempts, mustFix }, evidence }
    : { outcome: 'done', result: { pr, headCommit: review.headCommit, attempts, mustFix: [] }, evidence };
}
