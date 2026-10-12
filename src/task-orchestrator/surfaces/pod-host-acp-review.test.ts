/**
 * REVIEW-ACP-POD — Pod 런의 merge-ready PR 을 호스트 Claude ACP(구독)로 리뷰한 뒤 재게이트한다(opt-in).
 * ⛔ 꺼져 있으면 지금과 같다 · ⛔ ACP 를 못 쓰면 종전 길(재게이트) ⊕ `acp-review-refused` 관측 · ⛔ must-fix 면 병합하지 않는다.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { POD_HOST_ACP_REVIEW_ENV, resolvePodHostAcpReview, runPodHostAcpReview, type PodHostAcpReviewOutcome } from './pod-host-acp-review.js';
import type { ReviewResult } from '../../agent-substrate/pr-reviewer.js';
import { REVIEW_DEFERRED_TO_HOST_ENV } from '../../self-implement/review-deferred-to-host.js';

const CREDS = () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' });
const HEAD = 'a'.repeat(40);
const MERGE_READY = JSON.stringify({ stage: 'merge-ready', ok: true, prUrl: 'https://github.com/o/r/pull/9', prNumber: 9, checkedHeadCommit: HEAD,
  review: { reviewed: true, verdict: 'pass', mustFix: [] }, reviewedHeadCommit: HEAD });

function fakeKubectl(logs: string, applied: string[] = []): Kubectl {
  return (args, input) => {
    if (args.includes('apply') && input) applied.push(input);
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: `${logs}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

async function runPod(opts: { hostAcpReview?: boolean; env?: NodeJS.ProcessEnv; outcome?: PodHostAcpReviewOutcome; logs?: string; autoMerge?: boolean }) {
  const applied: string[] = [];
  const regated: number[] = [];
  const reviewed: Array<{ prNumber: number; headCommit: string }> = [];
  const comments: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-implement.pod') events.push([event, data ?? {}]);
  }) as typeof debug.log);
  try {
    const env = { ...process.env, ...(opts.env ?? {}) };
    if (!opts.env || !(POD_HOST_ACP_REVIEW_ENV in opts.env)) delete env[POD_HOST_ACP_REVIEW_ENV];
    const r = await podSelfImplementSpawn({
      kubectl: fakeKubectl(opts.logs ?? MERGE_READY, applied), sleep: async () => {}, credentials: CREDS, env,
      ...(opts.hostAcpReview !== undefined ? { hostAcpReview: opts.hostAcpReview } : {}),
      podHostAcpReview: async (input) => { reviewed.push({ prNumber: input.prNumber, headCommit: input.headCommit }); return opts.outcome ?? { status: 'clean', mustFix: 0, shouldFix: 0 }; },
      ghComment: (_pr, body) => { comments.push(body); },
      hostRegate: async (request) => { regated.push(request.prNumber); return { passed: true, failures: [], os: process.platform }; },
    })({ feature: 'acp review', spaceId: 'pod-acp-review', autoMerge: opts.autoMerge ?? true }).done;
    return { r, regated, reviewed, comments, events, applied };
  } finally { spy.mockRestore(); }
}

describe('REVIEW-ACP-POD — host Claude ACP review gate on Pod merge-ready PRs', () => {
  test('default (no option · no env · test = no config read): no ACP review, merges exactly as today', async () => {
    const { r, regated, reviewed, events } = await runPod({});
    expect(reviewed).toEqual([]);
    expect(regated).toEqual([9]);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true });
    expect(events.some(([e]) => e.startsWith('host-acp-review'))).toBe(false);
  });

  test('on ⊕ ACP clean: the ACP review is called for that PR/head, then host re-gate merges', async () => {
    const { r, regated, reviewed, events } = await runPod({ hostAcpReview: true });
    expect(reviewed).toEqual([{ prNumber: 9, headCommit: HEAD }]);
    expect(regated).toEqual([9]);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true });
    expect(events).toContainEqual(['host-acp-review-gate', expect.objectContaining({ pr: 9, status: 'clean', source: 'option' })]);
  });

  test('on via env ⊕ ACP must-fix: no re-gate, no merge, PR comment, ok=false', async () => {
    const { r, regated, comments } = await runPod({ env: { [POD_HOST_ACP_REVIEW_ENV]: '1' },
      outcome: { status: 'must-fix', mustFix: 1, findings: ['null deref in x.ts'], verdict: 'fail' } });
    expect(regated).toEqual([]);
    expect(r.disposition).toMatchObject({ stage: 'pr-opened', merged: false, ok: false, mergeReason: 'host-acp-review-must-fix' });
    expect(comments.join('\n')).toContain('null deref in x.ts');
    expect(r.exitCode).toBe(1);
  });

  test('on ⊕ ACP refused: the previous path (Pod review → re-gate → merge) and the refusal is observed', async () => {
    const { r, regated, events } = await runPod({ hostAcpReview: true, outcome: { status: 'refused', reason: 'unavailable: cct subscription check failed' } });
    expect(regated).toEqual([9]);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true });
    expect(events).toContainEqual(['host-acp-review-gate', expect.objectContaining({ status: 'refused', path: 'pod-review' })]);
  });
});

// REVIEW-ACP-POD ②-b — 켜진 런은 Pod 안 리뷰를 호스트로 미룬다(표지 env) · 미룬 런은 호스트 ACP 가 유일한 리뷰다(refused = 병합 0).
const DEFERRED_MERGE_READY = JSON.stringify({ stage: 'merge-ready', ok: true, prUrl: 'https://github.com/o/r/pull/9', prNumber: 9, checkedHeadCommit: HEAD,
  review: { reviewed: false, verdict: 'warn', mustFix: [], failureReason: 'deferred-to-host', deferredToHost: true }, mergeReason: 'review-deferred-to-host' });

function childEnv(applied: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const doc of applied) {
    const o = JSON.parse(doc) as { kind?: string; spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } } };
    if (o.kind !== 'Job') continue;
    for (const e of o.spec?.template?.spec?.containers?.[0]?.env ?? []) if (typeof e.value === 'string') out[e.name] = e.value;
  }
  return out;
}

describe('REVIEW-ACP-POD ②-b — Pod review deferred to the host ACP review', () => {
  test('on ⊕ auto-merge: the child Job env carries the deferral marker; off: it does not', async () => {
    const on = await runPod({ hostAcpReview: true });
    expect(childEnv(on.applied)[REVIEW_DEFERRED_TO_HOST_ENV]).toBe('1');
    expect(on.events).toContainEqual(['review-deferred-armed', expect.objectContaining({ env: REVIEW_DEFERRED_TO_HOST_ENV })]);
    const off = await runPod({});
    expect(Object.keys(childEnv(off.applied)).length).toBeGreaterThan(0);
    expect(childEnv(off.applied)[REVIEW_DEFERRED_TO_HOST_ENV]).toBeUndefined();
  });

  test('on but not auto-merge (no host review door): no marker — the Pod reviews as today', async () => {
    const r = await runPod({ hostAcpReview: true, autoMerge: false });
    expect(childEnv(r.applied)[REVIEW_DEFERRED_TO_HOST_ENV]).toBeUndefined();
  });

  test('deferred ⊕ ACP clean: host ACP review then re-gate merges', async () => {
    const { r, regated, reviewed } = await runPod({ hostAcpReview: true, logs: DEFERRED_MERGE_READY });
    expect(reviewed).toEqual([{ prNumber: 9, headCommit: HEAD }]);
    expect(regated).toEqual([9]);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true });
  });

  test('deferred ⊕ ACP refused: fail-closed — no re-gate, no merge, PR left open with host-acp-review-unavailable', async () => {
    const { r, regated, comments, events } = await runPod({ hostAcpReview: true, logs: DEFERRED_MERGE_READY,
      outcome: { status: 'refused', reason: 'unavailable: cct subscription check failed' } });
    expect(regated).toEqual([]);
    expect(r.disposition).toMatchObject({ stage: 'pr-opened', merged: false, ok: false, mergeReason: 'host-acp-review-unavailable' });
    expect(comments.join('\n')).toContain('자동 병합하지 않는다');
    expect(events).toContainEqual(['host-acp-review-unavailable', expect.objectContaining({ pr: 9, reason: 'unavailable: cct subscription check failed' })]);
    expect(events).toContainEqual(['host-acp-review-gate', expect.objectContaining({ status: 'refused', path: 'hold-pr', podReviewDeferred: true })]);
  });

  test('deferred but the switch was turned off since launch: the host still reviews (it is the only review)', async () => {
    const off = await runPod({ hostAcpReview: false, logs: DEFERRED_MERGE_READY, outcome: { status: 'refused', reason: 'no-subscription-reviewer' } });
    expect(off.reviewed).toEqual([{ prNumber: 9, headCommit: HEAD }]);
    expect(off.regated).toEqual([]);
    expect(off.r.disposition).toMatchObject({ merged: false, mergeReason: 'host-acp-review-unavailable' });
    expect(off.events).toContainEqual(['host-acp-review-gate', expect.objectContaining({ source: 'pod-deferred' })]);
  });
});

describe('resolvePodHostAcpReview', () => {
  test('option → env → config → off', () => {
    expect(resolvePodHostAcpReview(false, { [POD_HOST_ACP_REVIEW_ENV]: '1' }, () => ({ llm: { podHostAcpReview: true } }))).toEqual({ enabled: false, source: 'option' });
    expect(resolvePodHostAcpReview(undefined, { [POD_HOST_ACP_REVIEW_ENV]: 'true' }, () => ({}))).toEqual({ enabled: true, source: 'env' });
    expect(resolvePodHostAcpReview(undefined, { [POD_HOST_ACP_REVIEW_ENV]: '0' }, () => ({ llm: { podHostAcpReview: true } }))).toEqual({ enabled: false, source: 'env' });
    expect(resolvePodHostAcpReview(undefined, {}, () => ({ llm: { podHostAcpReview: true } }))).toEqual({ enabled: true, source: 'config' });
    expect(resolvePodHostAcpReview(undefined, {}, () => ({ llm: { podHostAcpReview: 'yes' } }))).toEqual({ enabled: false, source: 'default' });
    expect(resolvePodHostAcpReview(undefined, {}, () => { throw new Error('unreadable'); })).toEqual({ enabled: false, source: 'default' });
  });
});

describe('runPodHostAcpReview', () => {
  const SPEC = { spec: { provider: 'claude-acp' as const }, cap: 85 };
  const SPAWN = { command: 'claude-code-acp', args: [], env: {}, backendSpec: { command: 'claude-code-acp', args: [] } } as never;
  const PR = { headRefOid: HEAD, title: 't', body: 'b', diff: 'diff --git a/x b/x\n+1\n' };
  const result = (r: Partial<ReviewResult>): ReviewResult => ({ verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true, ...r });

  async function call(deps: Parameters<typeof runPodHostAcpReview>[1]) {
    const events: Array<[string, Record<string, unknown>]> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod') events.push([event, data ?? {}]);
    }) as typeof debug.log);
    try { return { out: await runPodHostAcpReview({ prNumber: 9, headCommit: HEAD, repoRoot: '/repo' }, deps), events }; }
    finally { spy.mockRestore(); }
  }

  test('ACP reviewer is built from the subscription spawn and its verdict decides', async () => {
    const built: unknown[] = [];
    const { out } = await call({ resolveReviewer: () => SPEC, availability: () => ({ spawn: SPAWN }), readPr: () => PR,
      makeAcpReviewLLM: (spawn) => { built.push(spawn); return async () => 'x'; },
      reviewPullRequest: async (_i, llm) => { await llm('p'); return result({}); } });
    expect(built).toEqual([SPAWN]);
    expect(out).toEqual({ status: 'clean', mustFix: 0, shouldFix: 0 });
  });

  test('must-fix verdict is returned with findings', async () => {
    const { out } = await call({ resolveReviewer: () => SPEC, availability: () => ({ spawn: SPAWN }), readPr: () => PR,
      makeAcpReviewLLM: () => async () => 'x', reviewPullRequest: async () => result({ verdict: 'fail', mustFix: ['bug'] }) });
    expect(out).toMatchObject({ status: 'must-fix', mustFix: 1, findings: ['bug'] });
  });

  test('refusals never call the ACP reviewer and are observed as acp-review-refused', async () => {
    let acpCalls = 0;
    const acp = () => { acpCalls++; return async () => 'x'; };
    const cases: Array<[Parameters<typeof runPodHostAcpReview>[1], string]> = [
      [{ resolveReviewer: () => undefined, makeAcpReviewLLM: acp }, 'no-subscription-reviewer'],
      [{ resolveReviewer: () => SPEC, availability: () => ({ reason: 'Claude subscription usage unavailable or at harness cap (85%)' }), makeAcpReviewLLM: acp }, 'unavailable: Claude subscription usage unavailable or at harness cap (85%)'],
      [{ resolveReviewer: () => SPEC, availability: () => ({ spawn: SPAWN }), readPr: () => undefined, makeAcpReviewLLM: acp }, 'pr-unreadable'],
      [{ resolveReviewer: () => SPEC, availability: () => ({ spawn: SPAWN }), readPr: () => ({ ...PR, headRefOid: 'b'.repeat(40) }), makeAcpReviewLLM: acp }, 'head-moved'],
    ];
    for (const [deps, reason] of cases) {
      const { out, events } = await call(deps);
      expect(out).toEqual({ status: 'refused', reason });
      expect(events).toContainEqual(['acp-review-refused', expect.objectContaining({ reason, pr: 9 })]);
    }
    expect(acpCalls).toBe(0);
  });

  test('a review that did not complete (reviewed=false) or throws is refused, not read as clean', async () => {
    const base = { resolveReviewer: () => SPEC, availability: () => ({ spawn: SPAWN }), readPr: () => PR, makeAcpReviewLLM: () => async () => 'x' };
    expect((await call({ ...base, reviewPullRequest: async () => result({ reviewed: false }) })).out).toEqual({ status: 'refused', reason: 'acp-review-not-completed' });
    expect((await call({ ...base, reviewPullRequest: async () => { throw new Error('ACP handshake timeout'); } })).out).toEqual({ status: 'refused', reason: 'acp-handshake-timeout' });
  });
});
