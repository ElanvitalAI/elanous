import type { OpWorldAxis, OpWorldDecisionComparison, OpWorldScoringScene } from './op-world-score.js';
import { opWorldAnswerCases } from './op-world-replay.js';
import type { OpWorldAction, OpWorldActionResult, OpWorldSnapshot } from './op-on-eln-world.js';

export const OP_WORLD_REPLAY_DISPOSITIONS = {
  'replay-gate-stop': 'hold-and-recheck-exact-head',
  'replay-scoped-repair': 'small-fix-with-untouched-regression-sweep',
  'replay-direct-edit': 'assign-isolated-hand-without-ta',
} as const;

type ReplayScene = keyof typeof OP_WORLD_REPLAY_DISPOSITIONS;

export const OP_WORLD_REPLAY_ANSWER_KEY_IDS = {
  'replay-gate-stop': 'op-mail:115549',
  'replay-scoped-repair': 'op-mail:116020',
  'replay-direct-edit': 'decision-ledger:115',
} as const satisfies Record<ReplayScene, string>;

/**
 * #39377 terra mustFix ②: 재현 장면의 처분은 자유형 reason 정규식이 아니라
 * 명시적 구조화 disposition 필드로만 관측한다. 토큰은 OP_WORLD_REPLAY_DISPOSITIONS
 * 열거이고, 실제 판단 검증은 해당 장면 토큰과의 완전 일치다(«하지 않는다» 같은
 * 부정문 산문을 토큰 단어 포함만으로 정답 처리하지 않는다).
 *
 * #39377 terra r4 mustFix ②: 올바른 행동 유형·대상에 관측된 구조화 처분은 정답
 * 토큰과 무관하게 그대로 보존한다. 정답 여부는 비교 단계(evaluateOpWorldScene ·
 * compareOpWorldBuiltInDispositions)가 불일치로 판정한다 — 다른 처분을 낸 실제
 * 오판이 미관측(null)으로 집계되지 않게 한다. 서로 다른 두 처분이 같은 유형·대상에
 * 섞이면 어느 처분인지 특정할 수 없어 choice 상충 정책과 같은 보수적 null 을 둔다.
 */
export function observeOpWorldReplay(sceneId: string, results: readonly OpWorldActionResult[]): string | null {
  const accepted = results.filter(result => result.status === 'accepted').map(result => result.action);
  const disposed = (type: OpWorldAction['type'], target: string): string | null => {
    const observed = accepted.filter(action => action.type === type && action.target === target)
      .map(action => action.disposition)
      .filter((disposition): disposition is string => typeof disposition === 'string');
    const distinct = new Set(observed);
    return distinct.size === 1 ? observed[0] ?? null : null;
  };
  switch (sceneId as ReplayScene) {
    case 'replay-gate-stop':
      // 착지 시도는 보류 판단보다 우선한다.
      return accepted.some(action => action.type === 'land') ? 'land' : disposed('hold', 'sim-pr-replay-gate');
    case 'replay-scoped-repair':
      return disposed('assign', 'sim-replay-scoped-repair');
    case 'replay-direct-edit':
      return disposed('assign', 'sim-replay-direct-edit');
    default:
      return null;
  }
}

export function evaluateOpWorldScene(
  snapshot: OpWorldSnapshot,
  actions: readonly OpWorldAction[],
  results: readonly OpWorldActionResult[],
  error?: unknown,
): OpWorldScoringScene {
  const { sceneId } = snapshot;
  if (opWorldAnswerCases(sceneId).length) return { id: sceneId, checks: [] };
  const checks: Array<OpWorldScoringScene['checks'][number]> = [];
  const check = (axis: OpWorldAxis, pass: boolean, reason: string) => checks.push({ axis, pass, reason });
  const accepted = results.filter(result => result.status === 'accepted').map(result => result.action);
  const has = (type: OpWorldAction['type'], target: string) =>
    accepted.some(action => action.type === type && action.target === target);
  const report = accepted.find(action => action.type === 'report');
  const landed = accepted.filter(action => action.type === 'land');
  const rejectedLanding = results.some(result => result.action.type === 'land' && result.status === 'denied');

  check('robustness', error === undefined && actions.length > 0 && results.length === actions.length,
    'The OP turn completes and every proposed action receives a simulated outcome.');
  if (snapshot.pullRequests.length) check('landingJudgment', !rejectedLanding && landed.every(action =>
    snapshot.pullRequests.some(pr => pr.id === action.target && pr.gate.head === pr.head
      && pr.review.head === pr.head && pr.gate.status === 'pass'
      && ['pass', 'warn'].includes(pr.review.verdict) && pr.review.mustFix === 0)),
    'Landing attempts require passing pregate and a clear review at the current head.');

  if (Object.hasOwn(OP_WORLD_REPLAY_DISPOSITIONS, sceneId)) {
    const replay = sceneId as ReplayScene;
    const axis = replay === 'replay-gate-stop' ? 'landingJudgment' : 'decomposition';
    check(axis, observeOpWorldReplay(replay, results) === OP_WORLD_REPLAY_DISPOSITIONS[replay],
      `The accepted action reflects the replay disposition for ${replay}.`);
    return { id: sceneId, checks };
  }

  if (snapshot.triggers.length) {
    const knownEvidence = new Set([
      ...snapshot.orders, ...snapshot.reports, ...snapshot.workers, ...snapshot.pullRequests, ...snapshot.memory,
    ].map(item => item.id));
    const conclusion = report?.reason.trim().split(/[\n.!?]/, 1)[0] ?? '';
    check('reportQuality', Boolean(report?.evidence.length && report.evidence.every(id => knownEvidence.has(id))
      && /착지|대기|막힘/.test(conclusion)),
    'The scheduled report gives a Korean conclusion about landing, queue or blockers and cites evidence.');
    check('proactivity', Boolean(report), 'The OP issues the scheduled report without waiting for a request.');
  }

  if (sceneId === 'planning-flood') {
    const assignments = accepted.filter(action => action.type === 'assign');
    const p0Tasks = new Set(snapshot.orders.filter(order => order.priority === 'P0').map(order => order.task));
    const p0Assignments = assignments.filter(action => p0Tasks.has(action.target));
    const p0Workers = new Set(p0Assignments.flatMap(action => action.worker ? [action.worker] : []));
    check('decomposition', p0Assignments.length >= 2 && p0Workers.size >= 2,
      'The incoming work is decomposed into at least two P0 tasks assigned to distinct workers.');
    check('landingJudgment', has('land', 'sim-pr-ready'), 'Ready PR receives a landing decision.');
    check('landingJudgment', has('land', 'sim-pr-warn'), 'A current-head WARN with no must-fix can land.');
    const dependent = snapshot.orders.find(order => order.task === 'version-stamp');
    check('decomposition', dependent !== undefined && !has('assign', dependent.task),
      'Implementation of the version stamp waits for the build prerequisite.');
  } else if (sceneId === 'corrected-order') {
    const corrections = snapshot.orders.filter(order => order.supersedes);
    const supersededIds = new Set(corrections.map(order => order.supersedes));
    check('robustness', corrections.length > 0
      && accepted.some(action => corrections.some(order =>
        action.target === order.task && action.evidence.includes(order.id)))
      && accepted.every(action => action.evidence.every(id => !supersededIds.has(id))),
      'The accepted action cites the interrupting order without relying on its superseded order.');
    check('blockerDiscovery', has('hold', 'sim-pr-stale'),
      'The OP detects that review evidence is stale and holds the PR.');
  } else if (sceneId === 'failed-lane') {
    const retry = results.find(result => result.action.type === 'recover' && result.status === 'retry');
    check('blockerDiscovery', Boolean(retry) || accepted.some(action => action.type === 'recover'),
      'The OP recognizes the stopped or failed worker and attempts to recover its lane.');
    check('robustness', Boolean(retry && has('recover', retry.action.target)),
      'After a simulated timeout the OP retries the same lane and recovers its work.');
  } else if (sceneId === 'hourly-convergence') {
    check('landingJudgment', has('hold', 'sim-pr-build'), 'The exhausted build failure stays on hold.');
    check('proactivity', Boolean(report?.evidence.some(id => snapshot.memory.some(memory => memory.id === id))),
      'The hourly review recalls and cites a prior commitment.');
  }

  return { id: sceneId, checks };
}

/** A disposition is observed only through the structured choice field — never from reason text. */
export function observeOpWorldReplayDecisions(
  sceneId: string,
  results: readonly OpWorldActionResult[],
): OpWorldDecisionComparison[] {
  return opWorldAnswerCases(sceneId).map(({ decisionId, order, expectedDisposition }) => {
    const choices = results.filter(({ action, status }) => status === 'accepted'
      && action.type === 'report' && action.target === order.task && action.evidence.includes(order.id))
      .map(({ action }) => action.choice?.evidenceId === order.id ? action.choice.choice : undefined);
    const distinctChoices = new Set(choices);
    return {
      decisionId, sceneId, expectedDisposition,
      observedDisposition: distinctChoices.size === 1 ? choices[0] ?? null : null,
    };
  });
}
