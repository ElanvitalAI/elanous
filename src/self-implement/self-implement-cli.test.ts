import { afterEach, describe, it, expect } from 'bun:test';
import { runSelfImplementCliCommand, singleRunAsJobResult, type SelfImplementCliOpts, type SelfImplementCliDeps } from './self-implement-cli.js';
import { classifyFailure } from '../self-dev/orchestrate.js';
import { _setObserveOnlyConfigReaderForTesting } from './observe-only.js';
import { planDevPipeline, type DevPipelineDeps, type DevPipelineSpec } from '../self-dev/dev-pipeline.js';
import type { SelfImplementResult } from './orchestrator.js';

const RESULT = (over: Partial<SelfImplementResult> = {}): SelfImplementResult =>
  ({ ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed', ...over } as SelfImplementResult);

/** executeReroute 를 가로채 전달된 spec/exit-code 를 관찰(source-grep Goodhart 회피 — 실 주입 실행 검증). */
function capture(exitCode = 0, result = RESULT()) {
  const calls: DevPipelineSpec[] = [];
  const executeReroute = (async (spec: DevPipelineSpec) => {
    calls.push(spec);
    return { result, exitCode };
  }) as SelfImplementCliDeps['executeReroute'];
  return { calls, executeReroute, last: (): DevPipelineSpec => calls[calls.length - 1] };
}

const opts = (over: Partial<SelfImplementCliOpts> = {}): SelfImplementCliOpts => ({ ...over });

afterEach(() => _setObserveOnlyConfigReaderForTesting());

describe('runSelfImplementCliCommand — 재라우팅 글루 seam(무손실 등가)', () => {
  it('single-run supervisor receives the harvestable branch without relaunching the completed implementation', async () => {
    const result = RESULT({ ok: false, stage: 'timed-out', outcome: 'abandoned', branch: 'self-impl/finished', harvestable: true });
    const decisions: string[] = [];
    const cap = capture(1, result);
    const out = await runSelfImplementCliCommand('finished merge', { supervise: { onDecision: (decision) => { decisions.push(decision.stopReason ?? 'none'); } } }, {
      executeReroute: cap.executeReroute,
    });
    expect(singleRunAsJobResult('finished merge', result)).toMatchObject({ harvestable: true, branch: result.branch });
    expect(out.ok).toBe(true);
    expect(decisions).toEqual(['harvestable-awaiting-human']);
    expect(cap.calls).toHaveLength(1);
  });
  it('모든 옵션이 spec 으로 무손실 매핑(base·enhance·draft·autoMerge·autoReview)', async () => {
    const cap = capture();
    const out = await runSelfImplementCliCommand('기능 F', opts({ base: 'main', enhance: true, autoMerge: true }), {
      executeReroute: cap.executeReroute,
    });
    expect(out.ok).toBe(true);
    expect(cap.last()).toEqual({
      input: { text: '기능 F' },
      executor: { kind: 'self' },
      entrance: 'cli-self-implement',
      completion: 'auto-merge',
      completionSource: 'request',
      autoReview: false,
      autoReviewSource: 'config',
      base: 'main', enhance: true,
      self: { draft: true, entry: 'external-verbatim' },
    });
  });

  it('Pod 밖 --merge-by-host 는 PR 실행 전에 거부한다', async () => {
    const cap = capture();
    const previous = process.env.ELANOUS_SUBSTRATE;
    delete process.env.ELANOUS_SUBSTRATE;
    try {
      expect(await runSelfImplementCliCommand('F', opts({ mergeByHost: true }), { executeReroute: cap.executeReroute }))
        .toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining('Pod 자식 전용') });
      expect(cap.calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SUBSTRATE;
      else process.env.ELANOUS_SUBSTRATE = previous;
    }
  });

  it('--ground → self.ground true로 무손실 전달', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts({ ground: true }), { resolveWantAutoReview: () => false, executeReroute: cap.executeReroute });
    expect(cap.last().self!.ground).toBe(true);
  });

  it('NL 인자는 spec과 transient approver·progress seams로 손실 없이 전달한다', async () => {
    const cap = capture();
    const documentReferences = [{ result: { kind: 'inside-repository' } }] as never;
    const approver = async () => true;
    const progress: NonNullable<DevPipelineDeps['progress']> = () => {};
    let pipelineDeps: DevPipelineDeps | undefined;
    const executeReroute = (async (spec: DevPipelineSpec, deps?: { pipelineDeps?: DevPipelineDeps }) => {
      cap.calls.push(spec);
      pipelineDeps = deps?.pipelineDeps;
      return { result: RESULT(), exitCode: 0 };
    }) as SelfImplementCliDeps['executeReroute'];

    await runSelfImplementCliCommand('F', opts({
      parentSessionId: 'session-nl', goalFile: '/goals/nl.md', documentReferences, naturalLanguageDispatch: true, approver, progress,
    }), { resolveWantAutoReview: () => false, executeReroute });

    expect(cap.last().self).toMatchObject({ parentSessionId: 'session-nl', goalFile: '/goals/nl.md', documentReferences, naturalLanguageDispatch: true });
    expect(pipelineDeps?.approver).toBe(approver);
    expect(pipelineDeps?.progress).toBe(progress);
    expect(await pipelineDeps!.approver!({} as never)).toBe(true);
  });

  it('opts.runId 는 spec.runId 로 흘리고 없으면 키를 생략한다', async () => {
    const withId = capture();
    await runSelfImplementCliCommand('F', opts({ runId: 'run-caller-owned' }), {
      resolveWantAutoReview: () => false,
      executeReroute: withId.executeReroute,
    });
    expect(withId.last().runId).toBe('run-caller-owned');

    const withoutId = capture();
    await runSelfImplementCliCommand('F', opts(), {
      resolveWantAutoReview: () => false,
      executeReroute: withoutId.executeReroute,
    });
    expect(withoutId.last()).not.toHaveProperty('runId');
  });

  it('CLI fallback keeps pipeline deps absent without approver or progress', async () => {
    let receivedDeps: { pipelineDeps?: DevPipelineDeps } | undefined;
    const executeReroute = (async (_spec: DevPipelineSpec, deps?: { pipelineDeps?: DevPipelineDeps }) => {
      receivedDeps = deps;
      return { result: RESULT(), exitCode: 0 };
    }) as SelfImplementCliDeps['executeReroute'];

    const out = await runSelfImplementCliCommand('F', opts(), { resolveWantAutoReview: () => false, executeReroute });

    expect(out).toMatchObject({ ok: true, kind: 'self', exitCode: 0 });
    expect(receivedDeps).toBeUndefined();
  });

  it('미지정 선택 입력은 production config 결정만 provenance와 함께 seam spec에 전달한다', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts(), { executeReroute: cap.executeReroute });
    const spec = cap.last();
    expect(Object.hasOwn(spec, 'base')).toBe(false);
    expect(Object.hasOwn(spec, 'enhance')).toBe(false);
    expect(spec).toMatchObject({ autoReview: false, autoReviewSource: 'config' });
    expect(Object.hasOwn(spec.self!, 'ground')).toBe(false);
    expect('maxWaitSec' in spec.self!).toBe(false);
    expect('parentSessionId' in spec.self!).toBe(false);
    expect('goalFile' in spec.self!).toBe(false);
    expect('documentReferences' in spec.self!).toBe(false);
    expect('naturalLanguageDispatch' in spec.self!).toBe(false);
  });

  it('--ground → self.ground 키와 true를 그대로 전달', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts({ ground: true }), { resolveWantAutoReview: () => false, executeReroute: cap.executeReroute });
    expect(Object.hasOwn(cap.last().self!, 'ground')).toBe(true);
    expect(cap.last().self!.ground).toBe(true);
  });

  it('--no-draft(draft:false) → self.draft false', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts({ draft: false, openPr: true }), { executeReroute: cap.executeReroute });
    expect(cap.last().self).toEqual({ draft: false, entry: 'external-verbatim' });
    expect(cap.last().completion).toBe('pr');
    expect(cap.last()).toMatchObject({ autoReview: false, autoReviewSource: 'config' });
  });

  it('--max-wait 지정값은 검증 후 self.maxWaitSec으로 전달', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts({ maxWait: '1800' }), { resolveWantAutoReview: () => false, executeReroute: cap.executeReroute });
    expect(cap.last().self!.maxWaitSec).toBe(1800);
  });

  for (const maxWait of ['abc', '-5', '0']) {
    it(`잘못된 --max-wait ${maxWait}는 오류로 반환`, async () => {
      const out = await runSelfImplementCliCommand('F', opts({ maxWait }), { resolveWantAutoReview: () => false, executeReroute: capture().executeReroute });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.exitCode).toBe(1);
        expect(out.message).toContain('--max-wait');
      }
    });
  }

  it('명시 autoReview는 config 해석 없이 request provenance로 전달한다', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts({ autoReview: true }), { resolveWantAutoReview: () => { throw new Error('explicit request wins'); }, executeReroute: cap.executeReroute });
    expect(cap.last()).toMatchObject({ autoReview: true, autoReviewSource: 'request' });
  });

  it('생략 autoReview는 호환 config seam의 값과 provenance를 resolver로 전달한다', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts(), { resolveWantAutoReview: () => false, executeReroute: cap.executeReroute });
    expect(cap.last()).toMatchObject({ autoReview: false, autoReviewSource: 'config' });
    expect(planDevPipeline(cap.last())).toMatchObject({ autoReview: false, autoReviewSource: 'config' });
  });

  it('자연어 무지정은 config 선결정 없이 capability를 생략하고 자율 shared resolver 기본으로 수렴한다', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts({ naturalLanguageDispatch: true }), {
      resolveWantAutoReview: () => { throw new Error('natural-language omission must not read config'); },
      executeReroute: cap.executeReroute,
    });
    expect(cap.last()).toMatchObject({ entrance: 'nl-self-implement' });
    expect(cap.last().completion).toBeUndefined();
    expect(cap.last().autoReview).toBeUndefined();
    expect(planDevPipeline(cap.last())).toMatchObject({
      completion: 'auto-merge', completionSource: 'default', autoReview: true, autoReviewSource: 'default',
    });
  });

  it('실제 자연어 생산자의 명시 completion·autoReview는 자율 기본을 이기고 request provenance를 보존한다', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts({ naturalLanguageDispatch: true, openPr: true, autoReview: false }), {
      resolveWantAutoReview: () => { throw new Error('explicit request wins'); },
      executeReroute: cap.executeReroute,
    });
    expect(cap.last()).toMatchObject({
      entrance: 'nl-self-implement', completion: 'pr', completionSource: 'request', autoReview: false, autoReviewSource: 'request',
    });
    expect(planDevPipeline(cap.last())).toMatchObject({
      completion: 'pr', completionSource: 'request', autoReview: false, autoReviewSource: 'request',
    });
  });

  it('기본 실행도 getUserConfig()+resolveAutoReview 설정 결정을 config provenance로 보존한다', async () => {
    const cap = capture();
    await runSelfImplementCliCommand('F', opts(), { executeReroute: cap.executeReroute });
    expect(cap.last()).toMatchObject({ autoReview: false, autoReviewSource: 'config' });
    expect(planDevPipeline(cap.last())).toMatchObject({ autoReview: false, autoReviewSource: 'config' });
  });

  it('exit-code 는 executeReroute 결과를 그대로 전파 (kind:self)', async () => {
    const cap = capture(1, RESULT({ stage: 'gate-failed', ok: false }));
    const out = await runSelfImplementCliCommand('F', opts(), { resolveWantAutoReview: () => false, executeReroute: cap.executeReroute });
    expect(out.ok).toBe(true);
    if (out.ok && out.kind === 'self') { expect(out.exitCode).toBe(1); expect(out.result.stage).toBe('gate-failed'); }
  });

  it('executeReroute throw → ok:false·exit 1·message(원 액션 catch 동형)', async () => {
    const boom = (async () => { throw new Error('파이프라인 폭발'); }) as SelfImplementCliDeps['executeReroute'];
    const out = await runSelfImplementCliCommand('F', opts(), { resolveWantAutoReview: () => false, executeReroute: boom });
    expect(out.ok).toBe(false);
    if (!out.ok) { expect(out.exitCode).toBe(1); expect(out.message).toContain('파이프라인 폭발'); }
  });

  it('--observe-only records the flag decision and never starts the reroute', async () => {
    const cap = capture();
    const out = await runSelfImplementCliCommand('관측 요청', opts({ observeOnly: true }), {
      resolveWantAutoReview: () => { throw new Error('must not resolve review'); },
      executeReroute: cap.executeReroute,
    });
    expect(out).toEqual({ ok: true, kind: 'observed', source: 'flag', exitCode: 0 });
    expect(cap.calls).toEqual([]);
  });

  it('config observe-only keeps working without the CLI flag and records config as the decision source', async () => {
    _setObserveOnlyConfigReaderForTesting(() => true);
    const cap = capture();
    const out = await runSelfImplementCliCommand('config 관측 요청', opts(), {
      resolveWantAutoReview: () => { throw new Error('must not resolve review'); },
      executeReroute: cap.executeReroute,
    });
    expect(out).toEqual({ ok: true, kind: 'observed', source: 'config', exitCode: 0 });
    expect(cap.calls).toEqual([]);
  });

  it('no flag and no config preserves the default decision and starts the established reroute', async () => {
    _setObserveOnlyConfigReaderForTesting(() => false);
    const cap = capture();
    const out = await runSelfImplementCliCommand('default 실행 요청', opts(), {
      resolveWantAutoReview: () => false,
      executeReroute: cap.executeReroute,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.kind).toBe('self');
    expect(cap.calls).toHaveLength(1);
  });

  it('--plan은 은퇴한 staged 하니스 입구를 명시적으로 거부하고 어떤 reroute도 시작하지 않는다', async () => {
    const out = await runSelfImplementCliCommand('플랜 기능', opts({ plan: true, observeOnly: true }), {
      resolveWantAutoReview: () => { throw new Error('must not resolve review'); },
      executeReroute: async () => { throw new Error('must not reroute'); },
      pipelineDeps: { dispatchRunDevHarness: async () => { throw new Error('must not dispatch staged harness'); } },
    });
    expect(out).toEqual({ ok: false, message: '--plan is retired for self implement and is rejected', exitCode: 1 });
  });
});

// ⭐⭐⭐ 2026-08-19 (E2) — 단일 실행도 «루프»를 지난다.
//   대표 물음("동시에 켜야 하니스 루프가 안 끊기는거죠?")에 재보니 끊기는 이유가 «층»이었다:
//   📏 슈퍼바이저가 연합 층에만 살고 단일은 그 층을 안 지났다 ⇒ 실패하면 그냥 «끝났다».
//   📏 그리고 사람이 가장 많이 쓰는 길이 그 길이다(30일 SelfImplement 17 · SelfOrchestrate 0).
describe('단일 실행의 런 슈퍼바이저 (E2)', () => {
  const lockRace = (): SelfImplementResult => RESULT({
    ok: false, stage: 'error' as never,
    detail: "error: cannot lock ref 'refs/remotes/origin/main': is at abc",
  } as never);
  const landed = (): SelfImplementResult => RESULT({ ok: true, stage: 'merged' as never, merged: true } as never);

  it('⛔ supervise 를 «안 주면» 한 번만 돈다 — 기본 동작 무변경', async () => {
    const cap = capture(1, lockRace());
    const out = await runSelfImplementCliCommand('f', opts(), { executeReroute: cap.executeReroute });
    expect(out.ok).toBe(true);
    expect(cap.calls.length).toBe(1);
  });

  // ⛔⭐⭐ 2026-08-19 실측 — ***단일 결과엔 「에러 메시지」가 «없다».***
  //   SelfImplementResult 필드 전수에 error 도 message 도 없다(detail 은 관측 인자였다).
  //   ⇒ 그래서 「락 경합이면 다시 건다」가 ***지금은 원리상 판정 불가***다.
  //     transient 판정은 execution-transient 어휘가 «메시지»를 봐야 서기 때문이다.
  //   📌 이것을 「형태만 있고 안 꽂혔다」로 남기지 않고 «값»으로 물어 둔다:
  //     아래 테스트가 「지금은 안 걸린다」를 못 박고, 값이 실리는 순간 ***이 테스트가 깨져서*** 알려준다.
  it('종결 사유를 error.message로 옮겨 기존 트리아지가 transient로 판정한다', async () => {
    const result = singleRunAsJobResult('f', lockRace());
    expect(result.error?.message).toBe("error: cannot lock ref 'refs/remotes/origin/main': is at abc");
    expect(Object.hasOwn(result.error!, 'code')).toBe(false);
    expect(classifyFailure(result)).toBe('transient');

    const calls: DevPipelineSpec[] = [];
    let n = 0;
    const executeReroute = (async (spec: DevPipelineSpec) => {
      calls.push(spec); n++;
      return n === 1 ? { result: lockRace(), exitCode: 1 } : { result: landed(), exitCode: 0 };
    }) as SelfImplementCliDeps['executeReroute'];
    await runSelfImplementCliCommand(
      'f', { ...opts(), supervise: { rounds: 2 } } as never, { executeReroute },
    );
    expect(calls.length).toBe(2);
  });

  it('typed proposal metadata and plan-revision observation survive the single-run conversion', () => {
    const decomposeProposal = { pieces: [
      { id: 'part-a', feature: 'part a', dependsOn: [] },
      { id: 'part-b', feature: 'part b', dependsOn: [] },
    ] };
    const goalPlanRevision = { status: 'read' as const, attempted: 0, applied: 0, failureReasons: [] };
    const result = singleRunAsJobResult('f', { ...RESULT({ runId: 'run-single' }), decomposeProposal, goalPlanRevision });
    expect(result).toMatchObject({ taskId: 'run-single', runId: 'run-single', decomposeProposal, goalPlanRevision });
  });

  it('실행 결과의 수확 상태를 감독 잡 결과로 옮기고 미지정 상태는 싣지 않는다', () => {
    expect(singleRunAsJobResult('f', RESULT({ salvage: 'launched' })).salvage).toBe('launched');
    expect(singleRunAsJobResult('f', RESULT({ salvage: 'parked' })).salvage).toBe('parked');
    expect(singleRunAsJobResult('f', RESULT())).not.toHaveProperty('salvage');
  });

  it('리뷰 실행 여부와 미실행 사유를 감독용 결과에 보존하고, 사유 생략은 유지한다', () => {
    const noDiff = singleRunAsJobResult('f', RESULT({ review: { reviewed: false, failureReason: 'no-diff' } } as never));
    const failed = singleRunAsJobResult('f', RESULT({ review: { reviewed: false, failureReason: 'reviewer unavailable' } } as never));
    const legacy = singleRunAsJobResult('f', RESULT({ review: { reviewed: false } } as never));
    const reviewed = singleRunAsJobResult('f', RESULT({ review: { reviewed: true } } as never));
    expect(noDiff).toMatchObject({ reviewed: false, reviewReason: 'no-diff' });
    expect(failed).toMatchObject({ reviewed: false, reviewReason: 'reviewer unavailable' });
    expect(legacy).toMatchObject({ reviewed: false });
    expect(legacy).not.toHaveProperty('reviewReason');
    expect(reviewed.reviewed).toBe(true);
  });

  it('자식 분류를 failureClassification 으로 옮기고 completionDisposition 은 독립으로 보존한다', () => {
    const result = singleRunAsJobResult('f', RESULT({
      runId: 'run-classified',
      completionDisposition: 'completed-without-changes',
      abandonedClassification: {
        classification: 'goal-unconvergeable-candidate',
        classificationBasis: 'supervisor-unconvergeable-goal-candidate',
        worktreeClean: true,
        mustFixReported: false,
      },
    }));
    expect(result.failureClassification).toBe('goal-unconvergeable-candidate');
    expect(result.completionDisposition).toBe('completed-without-changes');
    expect(Object.hasOwn(result, 'goalCauseObserved')).toBe(false);
  });

  it('사유 없는 실패와 성공 결과에는 합성 error를 만들지 않는다', () => {
    const failedWithoutDetail = singleRunAsJobResult('f', RESULT({ ok: false, stage: 'error' as never } as never));
    const succeeded = singleRunAsJobResult('f', landed());
    expect(Object.hasOwn(failedWithoutDetail, 'error')).toBe(false);
    expect(Object.hasOwn(succeeded, 'error')).toBe(false);
  });

  it('⛔ 모르는 실패면 «안» 다시 건다 — 무한 재실행 금지', async () => {
    const cap = capture(1, RESULT({ ok: false, stage: 'error' as never, error: { code: 'X', message: 'TypeError: boom' } } as never));
    await runSelfImplementCliCommand('f', { ...opts(), supervise: { rounds: 3 } } as never, { executeReroute: cap.executeReroute });
    expect(cap.calls.length).toBe(1);
  });

  it('착지하면 «한 번»에 선다', async () => {
    const cap = capture(0, landed());
    await runSelfImplementCliCommand('f', { ...opts(), supervise: { rounds: 3 } } as never, { executeReroute: cap.executeReroute });
    expect(cap.calls.length).toBe(1);
  });

  it('⭐ 판정 사유가 입구로 «간다» — onDecision', async () => {
    const cap = capture(0, landed());
    const seen: string[] = [];
    await runSelfImplementCliCommand(
      'f',
      { ...opts(), supervise: { rounds: 2, onDecision: (d: { stopReason?: string; action: string }) => { seen.push(d.stopReason ?? d.action); } } } as never,
      { executeReroute: cap.executeReroute },
    );
    expect(seen).toEqual(['converged']);
  });
});

describe('산출물의 «눈» — «실제 CLI»가 골 문서에서 읽어 판정까지 흘린다', () => {
  // ⛔ 리뷰 #10556 must-fix: 앞선 시험은 wiring helper 와 superviseRun 을 «각각» 불러
  //   실제 CLI 배선을 증명하지 못하는 Goodhart 시험이었다.
  //   ⇒ 여기서는 runSelfImplementCliCommand 를 «그대로» 부르고, 심은 «브라우저 하나»만 바꾼다.

  const GOAL_DOCUMENT = [
    '# 골', '', '## 산출물을 어떻게 켜나', '',
    '- Entrypoint: apps/demo/server.ts',
    '- Port: 31415',
    '- Environment: DEMO_TOKEN', '',
  ].join('\n');

  it('⭐⭐ feature(=골 문서 전문) → 타깃 → 눈 → 판정 «전 구간»이 CLI 한 번으로 돈다', async () => {
    const cap = capture();
    const askedFor: string[] = [];
    const decisions: Array<{ deliverableObservation: string; classifications: Array<{ kind: string; errorCode?: string }>; action: string }> = [];

    const out = await runSelfImplementCliCommand(
      GOAL_DOCUMENT,
      { ...opts(), supervise: { rounds: 1, onDecision: (d) => { decisions.push(d as never); } } },
      {
        resolveWantAutoReview: () => false,
        executeReroute: cap.executeReroute,
        // ⛔ 브라우저만 심으로 — 그 «위 층»(선언 파싱·타깃 생성·판정 배선)은 전부 진짜다.
        observeDeliverables: async (targets) => {
          for (const t of targets) askedFor.push(t.target);
          return {
            deployFindings: new Map(targets.map((t) => [
              t.taskId,
              { target: t.target, findings: [{ kind: 'empty-body', certainty: 'confirmed' }] },
            ])),
            unmeasured: [],
          };
        },
      },
    );

    expect(out.ok).toBe(true);
    // ① 골 문서의 「Port: 31415」가 «눈이 실제로 연 URL»이 됐다.
    //   ⭐ 라운드마다 «다시 본다» — 수리 조각을 붙였으면 그 다음 라운드에서 또 봐야 하기 때문이다.
    //   ⇒ 그래서 횟수가 아니라 «무엇을 봤나»를 문다(≥1회 · 전부 그 URL).
    expect(askedFor.length).toBeGreaterThan(0);
    expect(new Set(askedFor)).toEqual(new Set(['http://127.0.0.1:31415/']));
    // ②~④ 그 답이 판정에 흘렀다.
    expect(decisions.length).toBeGreaterThan(0);
    const first = decisions[0]!;
    expect(first.deliverableObservation).toBe('observed');
    expect(first.classifications.map((c) => c.kind)).toContain('deliverable-broken');
    expect(first.action).toBe('add-repair-task');
    // 🔑 지문이 «포트를 담는다» — 다른 로컬 앱과 안 섞인다.
    expect(first.classifications[0]!.errorCode).toBe('web|empty-body|http://127.0.0.1:31415/');
  });

  it('⛔⭐ «심을 안 준» 기본 경로를 한 번 태운다 — 심은 「누구를 부르나」를 시험에서 «지운다»', async () => {
    // 🔑 이 시험이 있는 이유(🅣 발신 2026-08-20 · OBS-T163 과 «같은 축»):
    //   *"주입 목록으로 시험하면 「기본 구현이 «어디»를 읽나」가 구조적으로 안 보인다"*.
    //   📏 실측: 이 파일의 눈 시험 셋이 «3/3 주입»이었고 기본 import 줄은 «한 번도» 안 탔다.
    //   ⇒ 심을 «안 주고» 부른다. 이 환경엔 CDP 가 없으므로 눈은 답을 못 낸다 —
    //     그때 「완주」가 아니라 'deliverable-unobserved' 로 흘러야 한다.
    //   ⛔ 그 갈림을 오늘 세웠는데 정작 «기본 경로»로는 한 번도 안 태워 봤다.
    const cap = capture(0, RESULT({ stage: 'merged', node: 'merge', merged: true } as never));
    const decisions: Array<{ stopReason?: string; deliverableObservation: string }> = [];
    const out = await runSelfImplementCliCommand(
      GOAL_DOCUMENT,
      { ...opts(), supervise: { rounds: 1, onDecision: (d) => { decisions.push(d as never); } } },
      {
        resolveWantAutoReview: () => false,
        executeReroute: cap.executeReroute,
        // ⛔ observeDeliverables 를 «주지 않는다» — 기본 구현이 돈다.
      },
    );
    expect(out.ok).toBe(true);
    expect(decisions.length).toBeGreaterThan(0);
    // ⛔ 기본 경로가 «무엇을 냈든» 「안 달았다」로 흘러서는 안 된다 — 눈은 «달렸다».
    expect(decisions[0]!.deliverableObservation).not.toBe('not-attempted');
    // ⭐ 그리고 못 봤으면 「완주」라 부르지 않는다.
    if (decisions[0]!.deliverableObservation === 'failed') {
      expect(decisions[0]!.stopReason).toBe('deliverable-unobserved');
    }
  }, 60_000);

  it('⛔ 켜기 선언이 «없는» feature 면 CLI 가 눈을 «안 단다»', async () => {
    const cap = capture();
    let called = 0;
    const decisions: Array<{ deliverableObservation: string }> = [];
    await runSelfImplementCliCommand(
      '평범한 요청 한 줄',
      { ...opts(), supervise: { rounds: 1, onDecision: (d) => { decisions.push(d as never); } } },
      {
        resolveWantAutoReview: () => false,
        executeReroute: cap.executeReroute,
        observeDeliverables: async () => { called += 1; return { deployFindings: new Map(), unmeasured: [] }; },
      },
    );
    expect(called).toBe(0);                                        // 심을 아예 «안 부른다»
    expect(decisions[0]!.deliverableObservation).toBe('not-attempted');
  });

  it('⛔ 눈이 «죽으면» CLI 경로도 「완주」라 부르지 않는다', async () => {
    // ⛔ 조각이 «착지»해야 「완주냐 아니냐」 분기에 닿는다 — pr-opened 는 아직 미해결이라 다른 가지로 간다.
    const cap = capture(0, RESULT({ stage: 'merged', node: 'merge', merged: true } as never));
    const decisions: Array<{ stopReason?: string; deliverableObservation: string }> = [];
    await runSelfImplementCliCommand(
      GOAL_DOCUMENT,
      { ...opts(), supervise: { rounds: 1, onDecision: (d) => { decisions.push(d as never); } } },
      {
        resolveWantAutoReview: () => false,
        executeReroute: cap.executeReroute,
        observeDeliverables: async () => { throw new Error('CDP 없음'); },
      },
    );
    expect(decisions[0]!.deliverableObservation).toBe('failed');
    expect(decisions[0]!.stopReason).toBe('deliverable-unobserved');
    expect(decisions[0]!.stopReason).not.toBe('converged');
  });
});
