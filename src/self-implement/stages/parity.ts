/**
 * TA-GRAPH-1124 H4 — parity 하네스. 같은 «가짜 seam» 으로 self-implement 엔진을 돌려 (걸음 순서 · 종단 stage · seam 호출 로그)를
 * 한 줄 리터럴로 고정하고, 두 엔진(legacy · graph)이 같은 줄을 내는지 비교한다.
 *
 * 규칙 11 — 기대값은 제품과 독립이다. 이 파일은 «실행·기록·비교» 만 하고, 기대 걸음은 시나리오 표(`parity-scenarios.ts`)에
 * 손으로 쓴 리터럴이다(파이프라인 상수·렌더 함수·엔진 출력으로 만들지 않는다).
 * 엔진은 주입한다(`SiEngineRunner`) — legacy = `runSelfImplement`, graph = 11-21 에 H1·H3 가 같은 시그니처로 낸다.
 */
import type { LlmMergeOutcome } from '../../autopilot/build/llm-conflict-merge.js';
import { createFakeGh } from '../../ux-sim/fake-gh.js';
import type { SelfImplementOptions, SelfImplementResult, SelfImplementReview, SelfImplementSeams } from '../orchestrator.js';
import { seams as baseSeams } from '../test-seams.js';

/** 시나리오 한 줄 — 걸음·종단·seam 호출. 모든 값은 사람이 읽는 문자열이라 diff 가 그대로 보고서가 된다. */
export interface SiWalk {
  /** `노드@라운드` 진입 순서 (`onNodeEntry`). */
  readonly walk: readonly string[];
  readonly stage: string;
  /** 종단 노드(결과의 `node`). */
  readonly node: string;
  readonly ok: boolean;
  readonly merged: boolean;
  /** 호출된 seam 이름 순서 — `gate` 는 모드별로 `gate`·`gate:postsync`. */
  readonly seamCalls: readonly string[];
  /** implement 호출마다 자식 공급자(provider) — `childLlm` 을 지정한 시나리오에서만 기록(재작업 재바인딩 칸). 모델 이름은 제품 기본값이라 적지 않는다. */
  readonly childProviders?: readonly string[];
}

export type SiEngineRunner = (options: SelfImplementOptions) => Promise<SelfImplementResult>;

export interface SiReviewPlan { readonly verdict: 'pass' | 'warn' | 'fail'; readonly mustFix?: readonly string[] }

/** 시나리오가 바꾸는 seam·옵션을 선언적으로 적는다 — 기본은 «정상 병합» 하나가 걷는 길이다. */
export interface SiScenarioPlan {
  /** gate 결과 순서(마지막 값 반복). 기본 [true]. */
  readonly gateResults?: readonly boolean[];
  /** postsync(regate) gate 결과 순서. 기본 = 일반 gate 와 같은 규칙에서 true. */
  readonly regateResults?: readonly boolean[];
  /** review 결과 순서(마지막 값 반복). 기본 [pass]. */
  readonly reviews?: readonly SiReviewPlan[];
  /** `mergeMain` 결과 status. 주면 `commitWork` 도 같이 심어 main-sync 노드를 연다. */
  readonly mainSync?: LlmMergeOutcome['status'];
  /** PR 사전승인(approvePr). 기본 true. */
  readonly approve?: boolean;
  /** mergePr 결과. 기본 merged:true. */
  readonly merged?: boolean;
  /** 변경 없음(preservationHasChanges=false). */
  readonly noChanges?: boolean;
  /** implement 가 어떻게 끝나나. 기본 ok. */
  readonly implement?: 'ok' | 'hang';
  /** PR 열기 seam 이 던진다. */
  readonly openPr?: 'ok' | 'throw';
  /** 부모 soft-stop 요청이 있다(현재 시각 이후). */
  readonly softStop?: boolean;
  /** grok 자식의 잔량이 «소진»이고 codex 계정이 있다 — rework 에서 자식이 grok→codex 로 재바인딩된다(`childLlm` 도 함께 준다). */
  readonly grokExhausted?: boolean;
  /** Pod 안에서 도는 것처럼 `ELANOUS_SUBSTRATE=pod` 를 건다(러너가 걸고 되돌린다) — `no-changes` 종단은 Pod 에서만 난다. */
  readonly substrate?: 'pod';
  /** 착지 동결(landing-freeze)을 켠다 — 러너가 켜고 끈다. */
  readonly freeze?: boolean;
  readonly options?: Partial<Pick<SelfImplementOptions, 'maxReworkRounds' | 'autoMerge' | 'completion' | 'mergeByHost' | 'stepTimeouts' | 'childLlm'>>;
}

export interface SiPlanHooks {
  /** grok 발사 잔량 판독을 고정한다(시험 전용 seam) — `undefined` 로 되돌린다. */
  readonly setGrokQuota?: (quota: 'usable' | 'exhausted' | 'unknown' | undefined) => void;
  /** 착지 동결 켜기/끄기 — 격리 상태 디렉터리 안에서만(호출자가 보장). */
  readonly setFreeze?: (on: boolean) => void;
}

function reviewResult(plan: SiReviewPlan): SelfImplementReview {
  return {
    verdict: plan.verdict,
    mustFix: [...(plan.mustFix ?? (plan.verdict === 'fail' ? ['정의 누락'] : []))],
    shouldFix: [],
    summary: 'review',
    reviewed: true,
    // 실제 리뷰어는 reviewed:true 와 diff 예산을 함께 낸다 — 빠뜨리면 auto-merge 가 «예산 미보고» 로 HITL 이 된다.
    diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0,
  } as SelfImplementReview;
}

/** 시나리오 계획으로 호출 기록 seam 을 만든다. 호출 로그는 `calls` 에 쌓인다. */
function buildScenarioSeams(plan: SiScenarioPlan, calls: string[], childProviders: string[] = []): SelfImplementSeams {
  const gates = plan.gateResults ?? [true];
  const regates = plan.regateResults ?? [true];
  const reviews = plan.reviews ?? [{ verdict: 'pass' }];
  const gh = createFakeGh({ prs: [], faults: plan.openPr === 'throw' ? [{ kind: 'unexpected-eof', match: /^pr create/, times: 1 }] : [], repository: 'parity/repo', now: () => new Date('2030-01-01T00:00:00Z') });
  let gateCall = 0;
  let regateCall = 0;
  let reviewCall = 0;
  const base = baseSeams({
    stdinIsInteractive: () => false,
    // 실제 계정 스토어를 읽어 codex 자식을 띄우거나 쿼터를 쓰지 않게 «후보 없음» 으로 고정한다(orchestrator.test 와 같다).
    inspectCodexRotation: (plan.grokExhausted
      ? () => ({ reason: 'ok', candidateCount: 1, knownAccountCount: 1 })
      : () => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 0 })) as SelfImplementSeams['inspectCodexRotation'],
    implement: async (ctx) => {
      calls.push('implement');
      if (plan.options?.childLlm) childProviders.push(ctx.childLlm?.provider ?? 'none');
      if (plan.implement === 'hang') return new Promise(() => {});
      return { ok: true, summary: 'impl' };
    },
    gate: async (_cwd, ctx) => {
      if (ctx?.mode === 'postsync') {
        calls.push('gate:postsync');
        const passed = regates[Math.min(regateCall++, regates.length - 1)]!;
        return { passed, log: 'regate' };
      }
      calls.push('gate');
      const passed = gates[Math.min(gateCall++, gates.length - 1)]!;
      return { passed, log: passed ? 'ok' : 'gate failed' };
    },
    reviewDiff: async () => { calls.push('review'); return reviewResult(reviews[Math.min(reviewCall++, reviews.length - 1)]!); },
    // PR 열기·병합은 원장 장치 `fake-github`(ux-sim/fake-gh.ts) 위에서 — 실제 gh CLI 인자 모양·필수 플래그 거절·EOF 고장 주입을 그대로 쓴다.
    openPr: async ({ head, title, body }) => {
      calls.push('openPr');
      const url = gh.api(['pr', 'create', '--title', title, '--head', head, '--body', body]).trim();
      return { url, number: Number(/\/pull\/(\d+)$/.exec(url)?.[1]) } as never;
    },
    mergePr: async ({ number }) => {
      calls.push('mergePr');
      if (plan.merged === false) return { merged: false };
      gh.api(['pr', 'merge', String(number), '--squash']);
      return { merged: (JSON.parse(gh.api(['pr', 'view', String(number), '--json', 'state'])) as { state?: string }).state === 'MERGED' };
    },
    approvePr: async () => { calls.push('approvePr'); return plan.approve ?? true; },
    ...(plan.mainSync !== undefined ? {
      mergeMain: async () => { calls.push('mergeMain'); return { status: plan.mainSync } as LlmMergeOutcome; },
      commitWork: () => { calls.push('commitWork'); },
    } : {}),
    ...(plan.noChanges ? { preservationHasChanges: () => false } : {}),
    ...(plan.softStop ? {
      parentSoftStopSpaceId: 'parity-space',
      readSoftStopRequestStatus: () => ({ status: 'present' as const, request: { version: 1 as const, requestedAt: new Date(Date.now() + 3_600_000).toISOString() } }),
    } : {}),
    readPrFiles: async () => ['src/ordinary.ts'],
    readPrDiff: async () => '',
    // mergeByHost(Pod) 는 «완전한 40자 sha» 가 아니면 병합 전 가드가 막는다 — 실제 모양으로 준다.
    readPrCommitShas: async () => ({ baseCommit: 'b'.repeat(40), headCommit: 'c'.repeat(40) }),
  });
  return base;
}

/**
 * 시나리오 하나를 주어진 엔진으로 돌려 한 줄(SiWalk)을 만든다. ⚠ 프로세스 전역(`ELANOUS_SUBSTRATE`·훅의 동결/잔량)을 바꾸므로 **직렬 전용** — 병렬 실행은 격리를 먼저 만들어야 한다.
 * 엔진이 던지면 `threw:<앞부분>` 종단으로 기록한다(던짐도 기준선이다). */
export async function runScenario(plan: SiScenarioPlan, engine: SiEngineRunner, hooks: SiPlanHooks = {}): Promise<SiWalk> {
  const calls: string[] = [];
  const walk: string[] = [];
  const childProviders: string[] = [];
  const priorSubstrate = process.env.ELANOUS_SUBSTRATE;
  // 조건을 거는 훅이 없으면 «조건 없이 통과» 하지 말고 명시적으로 실패한다(규칙 14) — 전역 상태를 바꾸기 «전에» 검사한다.
  if (plan.freeze && !hooks.setFreeze) throw new Error('parity: freeze 시나리오는 hooks.setFreeze 가 필수다 — 동결 없이 돌리면 병합이 일어나 다른 걸음이 된다');
  if (plan.grokExhausted && !hooks.setGrokQuota) throw new Error('parity: grokExhausted 시나리오는 hooks.setGrokQuota 가 필수다 — 잔량을 고정하지 않으면 재바인딩이 환경에 따라 달라진다');
  // 설정 단계도 정리 범위 안이다: 적용한 것만 `applied` 에 표시하고, 설정 중 어디서 던져도 finally 가 적용된 전역 상태를 각각 되돌린다.
  const applied = { freeze: false, substrate: false, grok: false };
  try {
    if (plan.freeze) { applied.freeze = true; hooks.setFreeze!(true); }
    if (plan.substrate) { applied.substrate = true; process.env.ELANOUS_SUBSTRATE = plan.substrate; }
    if (plan.grokExhausted) { applied.grok = true; hooks.setGrokQuota!('exhausted'); }
    try {
      const result = await engine({
        feature: 'si parity scenario',
        seams: buildScenarioSeams(plan, calls, childProviders),
        onNodeEntry: (node, round) => { walk.push(`${node}@${round}`); },
        ...(plan.options ?? {}),
      });
      return { walk, stage: result.stage, node: result.node, ok: result.ok, merged: result.merged === true, seamCalls: calls,
        ...(plan.options?.childLlm ? { childProviders } : {}) };
    } catch (error) {
      // 엔진이 던진 것만 기준선으로 기록한다(설정 단계 예외는 위로 그대로 전파된다). 메시지의 가변 꼬리는 괄호 앞에서 자른다.
      const head = (error instanceof Error ? error.message : String(error)).split('(')[0]!.trim();
      return { walk, stage: `threw:${head}`, node: '-', ok: false, merged: false, seamCalls: calls,
        ...(plan.options?.childLlm ? { childProviders } : {}) };
    }
  } finally {
    // 복원도 각각 독립이다 — 하나가 던져도 나머지를 건너뛰지 않고, 처음 던진 오류는 마지막에 전파한다.
    const restoreErrors: unknown[] = [];
    const restore = (fn: () => void): void => { try { fn(); } catch (error) { restoreErrors.push(error); } };
    if (applied.substrate) restore(() => { if (priorSubstrate === undefined) delete process.env.ELANOUS_SUBSTRATE; else process.env.ELANOUS_SUBSTRATE = priorSubstrate; });
    if (applied.grok) restore(() => hooks.setGrokQuota?.(undefined));
    if (applied.freeze) restore(() => hooks.setFreeze?.(false));
    if (restoreErrors.length > 0) throw restoreErrors[0];
  }
}

/** 두 줄의 차이를 사람이 읽는 목록으로 — 비어 있으면 일치. */
export function diffWalks(expected: SiWalk, actual: SiWalk): string[] {
  const out: string[] = [];
  const line = (label: string, e: unknown, a: unknown): void => {
    const es = JSON.stringify(e);
    const as = JSON.stringify(a);
    if (es !== as) out.push(`${label}: 기대 ${es} ≠ 실제 ${as}`);
  };
  line('walk', expected.walk, actual.walk);
  line('stage', expected.stage, actual.stage);
  line('node', expected.node, actual.node);
  line('ok', expected.ok, actual.ok);
  line('merged', expected.merged, actual.merged);
  line('seamCalls', expected.seamCalls, actual.seamCalls);
  line('childProviders', expected.childProviders, actual.childProviders);
  return out;
}

export interface SiParityRow { readonly id: string; readonly diffs: readonly string[] }

/** 두 엔진(기준 vs 후보)의 같은 시나리오 비교 — 11-21 에 graph 엔진이 legacy 기준선과 12/12 인지 판정한다. */
export function compareEngines(baseline: Readonly<Record<string, SiWalk>>, candidate: Readonly<Record<string, SiWalk>>): SiParityRow[] {
  return Object.keys(baseline).map((id) => {
    const other = candidate[id];
    return { id, diffs: other === undefined ? ['후보 엔진에 이 시나리오 결과가 없다'] : diffWalks(baseline[id]!, other) };
  });
}
