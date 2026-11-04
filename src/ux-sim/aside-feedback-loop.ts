import { randomUUID } from 'node:crypto';
import { subscribeTopicSearch, type SubscribeTopicSearchDeps, type SubscribeTopicSearchInput } from '../intake-plane/actions.js';
import { updateLinearSecretaryProgress } from '../intake-plane/linear-wish.js';
import { createElanousLinearSecretaryRuntime } from '../tool-runtime/elanous-linear-secretary-runtime.js';

export interface AsideFeedbackResearch {
  summary: string;
  sourceUrls: string[];
}

export type AsideFeedbackCapture =
  | { status: 'captured'; path: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; sessionId: string; browserRunId?: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'failed'; reason: string };

export type AsideFeedbackLinear =
  | { status: 'recorded'; parentIssueId: string; taskIssueId: string; captureAttached: boolean }
  | { status: 'failed'; parentIssueId: string; taskIssueId: string; reason: string };

export type AsideFeedbackSubscription =
  | { status: 'active'; subscriptionId: string; scheduleId: string; recurring: true; immediateStatus: 'succeeded' | 'failed'; immediateError?: string }
  | { status: 'pending-approval'; taskId: string; recurring: false }
  | { status: 'unsupported'; recurring: false; reason?: string };

export interface AsideFeedbackLoopResult {
  runId: string;
  question: string;
  sourceUrl: string;
  research: AsideFeedbackResearch;
  capture: AsideFeedbackCapture;
  linear: AsideFeedbackLinear;
  subscription: AsideFeedbackSubscription;
  status: 'complete' | 'partial';
  events: string[];
}

export interface AsideFeedbackLoopDependencies {
  question?: string;
  sourceUrl?: string;
  captureTimeoutMs?: number;
  research(question: string): Promise<AsideFeedbackResearch>;
  capture(input: { loopRunId: string; sourceUrl: string; research: AsideFeedbackResearch; signal: AbortSignal }): Promise<AsideFeedbackCapture>;
  linear: {
    apiKey: string;
    parentIssueId: string;
    taskIssueId: string;
    fetch?: typeof fetch;
    captureDeps?: Parameters<typeof updateLinearSecretaryProgress>[0]['deps'];
  };
  subscription: SubscribeTopicSearchInput;
  external: {
    stateDir: string;
    schedule: SubscribeTopicSearchDeps;
  };
}

const DEFAULT_QUESTION = '이 공지의 40-foot 긴급 운임과 Hormuz 할증을 대체한 더 뒤 notice가 있는가?';
const DEFAULT_SOURCE = 'https://www.maersk.com/news/articles/2026/10/26/middle-east-operational-update-52';

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the real Linear secretary progress runtime and topic subscription function.
 * Only research, browser capture, HTTP and schedule edges are injected for simulation.
 */
export async function simAsideFeedbackLoop(deps: AsideFeedbackLoopDependencies): Promise<AsideFeedbackLoopResult> {
  const runId = randomUUID();
  const question = deps.question ?? DEFAULT_QUESTION;
  const sourceUrl = deps.sourceUrl ?? DEFAULT_SOURCE;
  const events: string[] = [];
  const emit = (event: string): void => { events.push(event); };

  emit('aside-question');
  emit('research-started');
  let research: AsideFeedbackResearch = { summary: '', sourceUrls: [] };
  let researchFailed = false;
  try {
    const candidate = await deps.research(question);
    if (!candidate.summary.trim()) throw new Error('research result has no conclusion');
    if (!candidate.sourceUrls.includes(sourceUrl)) throw new Error('research result must retain the question source URL');
    research = candidate;
    emit('research-completed');
  } catch (error) {
    researchFailed = true;
    research = { summary: '', sourceUrls: [] };
    emit(`research-failed:${failureReason(error)}`);
  }

  emit('aside-capture-requested');
  const timeoutMs = Math.max(1, deps.captureTimeoutMs ?? 90_000);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let settled = false;
  let settledCapture: AsideFeedbackCapture | undefined;
  let markSettled!: () => void;
  const captureSettled = new Promise<void>(resolve => { markSettled = resolve; });
  const capturePromise = (researchFailed ? Promise.resolve<AsideFeedbackCapture>({ status: 'failed', reason: 'Skipped because research failed' })
    : Promise.resolve().then(() => deps.capture({ loopRunId: runId, sourceUrl, research, signal: controller.signal })))
    .then(result => { settled = true; settledCapture = result; markSettled(); return result; })
    .catch(error => {
      settled = true;
      markSettled();
      return { status: 'failed' as const, reason: `aside_exec capture failed: ${failureReason(error)}` };
    });
  const timeoutPromise = new Promise<AsideFeedbackCapture>(resolve => {
    if (researchFailed) { resolve({ status: 'failed', reason: 'Skipped because research failed' }); return; }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('aside_exec capture time limit reached'));
      resolve({ status: 'failed', reason: `aside_exec capture exceeded ${timeoutMs}ms; abort requested` });
    }, timeoutMs);
  });
  let capture = await Promise.race([capturePromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    if (!settled) await Promise.race([
      captureSettled,
      new Promise<void>(resolve => setTimeout(resolve, 100)),
    ]);
    const cancellationConfirmed = settledCapture?.status === 'cancelled';
    const lateCompletion = settledCapture?.status === 'captured' ? '; capture completed after timeout despite abort' : '';
    capture = { status: 'failed', reason: `aside_exec capture exceeded ${timeoutMs}ms; abort requested; cancellation ${cancellationConfirmed ? 'confirmed' : 'unconfirmed'}${lateCompletion}` };
  }
  emit(capture.status === 'captured' ? 'aside-capture-completed' : 'aside-capture-failed');

  const artifact = capture.status === 'captured' && capture.browserRunId
    ? { path: capture.path, mimeType: capture.mimeType, runId: capture.browserRunId,
      linearIssueId: deps.linear.parentIssueId, externalShare: true as const, sensitivity: 'public' as const, createdAt: Date.now() }
    : undefined;
  let linear: AsideFeedbackLinear;
  try {
    const secretary = createElanousLinearSecretaryRuntime({
      getApiKey: async () => deps.linear.apiKey,
      ...(deps.linear.fetch ? { fetch: deps.linear.fetch } : {}),
      updateProgress: input => updateLinearSecretaryProgress({ ...input,
        ...(deps.linear.captureDeps ? { deps: deps.linear.captureDeps } : {}),
      }),
    });
    const result = await secretary.run({ action: 'progress', teamKey: 'DEMO', parentIssueId: deps.linear.parentIssueId,
      taskIssueId: deps.linear.taskIssueId, state: 'comment',
      summary: [`aside feedback loop=${runId}`, `질문: ${question}`,
        `연구: ${research.summary || (researchFailed ? '실패 — 출처 확인 전 진행하지 않음' : '요약 없음')}`,
        `출처: ${research.sourceUrls.length ? research.sourceUrls.join(', ') : '없음'}`,
        `캡처: ${capture.status === 'captured' ? `session=${capture.sessionId}; browserRunId=${capture.browserRunId ?? '없음'}` : capture.reason}`,
      ].join('\n'),
      ...(artifact ? { captureArtifact: artifact } : {}) }, { surface: 'mcp' });
    linear = result.ok
      ? { status: 'recorded', parentIssueId: deps.linear.parentIssueId, taskIssueId: deps.linear.taskIssueId, captureAttached: !!artifact }
      : { status: 'failed', parentIssueId: deps.linear.parentIssueId, taskIssueId: deps.linear.taskIssueId, reason: result.output };
  } catch (error) {
    linear = { status: 'failed', parentIssueId: deps.linear.parentIssueId, taskIssueId: deps.linear.taskIssueId, reason: failureReason(error) };
  }
  emit(linear.status === 'recorded' ? 'linear-recorded' : 'linear-record-failed');

  let subscription: AsideFeedbackSubscription;
  try {
    const result = await subscribeTopicSearch({ ...deps.subscription, linearIssueId: deps.linear.parentIssueId }, {
      ...deps.external.schedule,
      stateDir: deps.external.stateDir,
    });
    const immediateErrors = result.immediate.ran.flatMap(row => row.error ? [row.error] : []);
    const immediateSucceeded = result.immediate.ran.length > 0 && immediateErrors.length === 0;
    subscription = result.scheduleId
      ? { status: 'active', subscriptionId: result.source.id, scheduleId: result.scheduleId, recurring: true,
        immediateStatus: immediateSucceeded ? 'succeeded' : 'failed',
        ...(immediateSucceeded ? {} : { immediateError: immediateErrors.join('; ') || 'immediate intake returned no result rows' }) }
      : { status: 'unsupported', recurring: false, reason: 'topic-search schedule registry did not return a schedule ID' };
  } catch (error) {
    subscription = { status: 'unsupported', recurring: false, reason: failureReason(error) };
  }
  if (subscription.status === 'active' && subscription.recurring !== true) throw new Error('active subscription must be recurring');
  emit(subscription.status === 'active' ? 'subscription-active' : 'subscription-unsupported');

  const status = capture.status === 'captured' && !!capture.browserRunId && linear.status === 'recorded'
    && linear.captureAttached && subscription.status === 'active' && subscription.immediateStatus === 'succeeded' ? 'complete' : 'partial';
  emit(status === 'complete' ? 'completed' : 'partial');
  return { runId, question, sourceUrl, research, capture, linear, subscription, status, events };
}
