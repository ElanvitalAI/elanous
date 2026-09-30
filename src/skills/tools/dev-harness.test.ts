// RunDevHarness front door(P2) — objective/autoDrive/base 스레딩·ctx→ux·seam 주입.
import { test, expect, describe, afterEach, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunDevHarnessTool, dispatchRunDevHarness, resolveAutoDrive, resolveMultiAngle, resolveRedTeam, resolveHarnessKnobs, type DevHarnessDeps } from './dev-harness.js';
import type { DaemonToolDispatchCtx } from '../../boot/daemon-tools/types.js';
import type { ConfirmChannel } from '../../hitl/confirm.js';
import type { HarnessResult } from '../../harness/staged-harness.js';
import type { RunHarnessOnSurfaceOptions } from '../../harness/harness-membrane.js';
import type { DefaultSeamsOptions } from '../../self-implement/seams.js';
import type { LlmHitlRelayDeps } from '../../harness/llm-hitl-relay.js';
import type { HitlRelay } from '../../harness/detached-hitl.js';
import { debug } from '../../debug/log.js';
import { dispatchTask, type DispatchTaskInput, type DispatchTaskResult } from '../../execution-loop/dispatch-task.js';
import { CardStore } from '../../task-cards/card-store.js';

const okResult: HarnessResult = { runId: 'test-run', ok: true, terminal: 'deployed', rounds: 2, deployRef: 'https://pr/1', state: {} as never };

/** 하니스 호출 캡처 + seam 팩토리 캡처. */
function deps(over: { result?: HarnessResult } = {}) {
  const calls: RunHarnessOnSurfaceOptions[] = [];
  const seamCalls: unknown[] = [];
  const d: DevHarnessDeps = {
    runHarness: async (opts) => { calls.push(opts); return over.result ?? okResult; },
    seamsFactory: (o) => { seamCalls.push(o); return {} as never; },
  };
  return { deps: d, calls, seamCalls };
}

function yesChannel(): ConfirmChannel {
  return { name: 'telegram', async request() { return true; }, cancel() {} };
}

describe('resolveAutoDrive — 명시 파라미터 + objective 텍스트 추론(#24)', () => {
  test('명시 auto_drive 파라미터 우선', () => {
    expect(resolveAutoDrive({ auto_drive: 'on', objective: 'x' })).toBe('on');
    expect(resolveAutoDrive({ auto_drive: 'off', objective: 'auto_drive on으로' })).toBe('off'); // 명시가 텍스트 이김
    expect(resolveAutoDrive({ auto_drive: 'safe' })).toBe('safe');
  });
  test('★ 파라미터 없으면 objective 텍스트에서 on 추론(텔레그램 자연어)', () => {
    expect(resolveAutoDrive({ objective: 'auto_drive on으로 P→E→R→D 하니스로 ...' })).toBe('on');
    expect(resolveAutoDrive({ objective: '완전 자율로(승인 없이) 만들어줘' })).toBe('on');
    expect(resolveAutoDrive({ objective: 'fully autonomous build' })).toBe('on');
  });
  test('off 추론 · 기본 safe', () => {
    expect(resolveAutoDrive({ objective: 'auto_drive off 로 조심히' })).toBe('off');
    expect(resolveAutoDrive({ objective: '그냥 유틸 하나 추가해줘' })).toBe('safe');
    expect(resolveAutoDrive({})).toBe('safe');
  });
});

describe('resolveMultiAngle / resolveRedTeam — adversarial 트리거(대표 정정: HITL=자율 트리거만)', () => {
  test('유저 원문 "다각도" 키워드 → explicit(바로 실행·HITL 불요)', () => {
    expect(resolveMultiAngle({ objective: 'x' }, '다각도로 리뷰해서 개발해줘')).toBe('explicit');
    expect(resolveMultiAngle({ objective: '플랜 다각도 점검하고 구현' })).toBe('explicit');   // objective 도 유저의도
  });
  test('multi_angle 파라미터만(유저 키워드 없음) → llm(HITL 대상)', () => {
    expect(resolveMultiAngle({ objective: '기능 추가', multi_angle: true }, '기능 추가해줘')).toBe('llm');
  });
  test('아무 신호 없음 → none', () => {
    expect(resolveMultiAngle({ objective: '기능 추가' }, '기능 추가해줘')).toBe('none');
  });
  test('baked multi_angle_mode(detached 자식) 우선', () => {
    expect(resolveMultiAngle({ objective: 'x', multi_angle_mode: 'llm' })).toBe('llm');
    expect(resolveMultiAngle({ objective: '다각도', multi_angle_mode: 'none' })).toBe('none');  // baked 가 이김
  });
  test('resolveRedTeam — param/키워드', () => {
    expect(resolveRedTeam({ red_team: true, objective: 'x' })).toBe(true);
    expect(resolveRedTeam({ objective: '레드팀으로 꼼꼼히 계획' })).toBe(true);
    expect(resolveRedTeam({ objective: '유틸 추가' })).toBe(false);
  });
});

describe('buildRunDevHarnessTool — 스펙', () => {
  test('name·required·auto_drive enum', () => {
    const spec = buildRunDevHarnessTool();
    expect(spec.name).toBe('RunDevHarness');
    expect(spec.parameters.required).toEqual(['objective']);
    expect((spec.parameters.properties as Record<string, { enum?: string[] }>).auto_drive.enum).toEqual(['off', 'safe', 'on']);
    const targetDescription = (spec.parameters.properties as Record<string, { description?: string }>).target.description;
    expect(targetDescription).toContain('omit this');
    expect(targetDescription).toContain('elanous itself');
    expect(targetDescription).toContain('never invent or construct a path');
  });

  test('하니스 표현은 도구 사용 시점과 조사·문장부호 변형까지 설명한다', () => {
    const description = buildRunDevHarnessTool().description;
    for (const example of ['Use this tool when the user mentions the harness', '하니스로 개발', '하니스:', '하니스로 구현해줘', '하니스 구현', 'harness', 'self dev', 'particles or punctuation']) {
      expect(description).toContain(example);
    }
  });
});

describe('resolveHarnessKnobs — B1 membrane 관통(C1~C4 노브 surface 해석)', () => {
  test('명시 파라미터 — carry_capsule/sizing_mode/ledger_mode', () => {
    expect(resolveHarnessKnobs({ objective: 'x', carry_capsule: true, sizing_mode: 'off', ledger_mode: 'off' }))
      .toEqual({ carryCapsule: true, sizingMode: 'off', ledgerMode: 'off' });
  });
  test('자연어 — "설계 계약/나침반 전달" → carryCapsule', () => {
    expect(resolveHarnessKnobs({ objective: '설계 계약 전달하며 구현' }).carryCapsule).toBe(true);
    expect(resolveHarnessKnobs({ objective: 'x' }, '나침반 실어서 돌려줘').carryCapsule).toBe(true);
  });
  test('미지정 → 빈 객체(seam/sequencer 기본·무회귀)', () => {
    expect(resolveHarnessKnobs({ objective: 'x' })).toEqual({});
  });
  test('잘못된 enum 무시', () => {
    expect(resolveHarnessKnobs({ objective: 'x', sizing_mode: 'bogus', ledger_mode: 'nope' })).toEqual({});
  });
});

describe('dispatchRunDevHarness — 스레딩', () => {
  test('runId는 dispatch 관측과 막 호출에 같은 값을 전달하며 호출자 값은 보존한다', async () => {
    const { deps: d, calls } = deps();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: Array<{ category: string; event: string; data: { runId?: string } }> = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: { runId?: string }) => {
      logs.push({ category, event, data: data ?? {} });
    }) as typeof debug.log;
    try {
      await dispatchRunDevHarness({ objective: '런 식별자 전달', runId: 'pipeline-run-42' }, {} as DaemonToolDispatchCtx, d);
      expect(calls[0]?.runId).toBe('pipeline-run-42');
      expect(calls[0]?.harnessMention).toBe('absent');
      expect(logs.find((log) => log.category === 'harness.frontdoor' && log.event === 'dispatch')?.data.runId).toBe('pipeline-run-42');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('dispatch 관측은 raw domain과 비-코드 executor 주입 여부를 함께 남긴다', async () => {
    const { deps: d } = deps();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await dispatchRunDevHarness({ objective: '리서치 요청', domain: 'research' }, {} as DaemonToolDispatchCtx, d);
      await dispatchRunDevHarness({ objective: '코드 요청' }, {} as DaemonToolDispatchCtx, d);
      const dispatches = log.mock.calls
        .filter(([category, event]) => category === 'harness.frontdoor' && event === 'dispatch')
        .map(([, , data]) => data as { domain?: unknown; domainExecuteInjected?: unknown });
      expect(dispatches).toEqual([
        expect.objectContaining({ domain: 'research', domainExecuteInjected: true }),
        expect.objectContaining({ domain: null, domainExecuteInjected: false }),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('하니스 원문 유무를 dispatch 관측에만 남기며 호출 동작은 유지한다', async () => {
    const { deps: d, calls } = deps();
    const original = debug.log.bind(debug) as typeof debug.log;
    const mentions: unknown[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: { harnessMention?: unknown }) => {
      if (category === 'harness.frontdoor' && event === 'dispatch') mentions.push(data?.harnessMention);
    }) as typeof debug.log;
    try {
      await dispatchRunDevHarness({ objective: '하니스로 개발' }, { userText: '조사 붙은 하니스로 개발해줘!' } as DaemonToolDispatchCtx, d);
      await dispatchRunDevHarness({ objective: 'plain request' }, { userText: '그냥 구현해줘' } as DaemonToolDispatchCtx, d);
      await dispatchRunDevHarness({ objective: 'legacy request' }, {} as DaemonToolDispatchCtx, d);
      expect(mentions).toEqual(['matched', 'not-matched', 'absent']);
      expect(calls.map((call) => call.harnessMention)).toEqual(['matched', 'not-matched', 'absent']);
      // ⛔⭐ 종전 단언은 `[true, true, true]` 였다 — 프론트도어가 그 값을 «단정»했기 때문이다.
      //   그런데 세 번째 호출은 `ctx` 자체가 없다(=`elanous harness run` CLI 와 같은 모양).
      //   그 단정 때문에 CLI 런도 원장에 자연어 유래로 찍혔다(2026-08-06 라이브 실측) ⇒ v25 ⑷ 분자가 부풀었다.
      //   ⭐ 이제 프론트도어는 «안 정한다» — 판정은 harnessMention 이 하고 막이 파생한다.
      expect(calls.map((call) => call.naturalLanguageDispatch)).toEqual([undefined, undefined, undefined]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  // ⛔⭐ 자의 «충실도» — 프론트도어가 `naturalLanguageDispatch` 를 «단정»하면 안 된다(2026-08-06 실측).
  //   이 함수는 둘이 지난다: 모델이 부른 도구(ctx.userText 있음) ⊕ `elanous harness run` CLI(ctx 없음).
  //   종전엔 `true` 로 못 박혀 CLI 런도 자연어 유래로 원장에 찍혔고(라이브 확인), v25 ⑷ 의 분자가 부풀었다.
  //   ⇒ 판정은 harnessMention 이 한다. 이 테스트는 «단정이 돌아오면» 실패한다.
  test('사용자 문면이 없으면 자연어 유래를 단정하지 않는다', async () => {
    const calls: Array<{ naturalLanguageDispatch?: boolean; harnessMention?: unknown }> = [];
    const d: DevHarnessDeps = { runHarness: async (o) => { calls.push(o as never); return okResult; }, seamsFactory: () => ({} as never) };
    await dispatchRunDevHarness({ objective: 'CLI 경로' }, {} as DaemonToolDispatchCtx, d);
    expect(calls[0]?.harnessMention).toBe('absent');
    expect(calls[0]?.naturalLanguageDispatch).toBeUndefined();
  });

  test('호출자 식별자가 없으면 기존 mintRunId 형식으로 한 번 생성해 전달한다', async () => {
    const { deps: d, calls } = deps();
    await dispatchRunDevHarness({ objective: '런 식별자 생성' }, {} as DaemonToolDispatchCtx, d);
    expect(calls[0]?.runId).toMatch(/^run-[0-9a-f-]{36}$/);
  });

  test('objective/base 전달·branchPrefix dev·autoDrive 기본 safe', async () => {
    const { deps: d, calls } = deps();
    const res = await dispatchRunDevHarness({ objective: 'null 병합 유틸 추가', base: 'main' }, {} as DaemonToolDispatchCtx, d);
    expect(calls.length).toBe(1);
    expect(calls[0]?.objective).toBe('null 병합 유틸 추가');
    expect(calls[0]?.autoDrive).toBe('safe');
    expect(calls[0]?.base).toBe('main');
    expect(calls[0]?.branchPrefix).toBe('dev');
    expect(res.output).toContain('deployed');
    expect(res.output).toContain('autoDrive=safe');
  });

  test('★ 비인터랙티브 ctx → in-process HITL LLM relay 배선(ux.interactive=true 승격·CLI --plan 무인 완주)', async () => {
    const { deps: d, calls } = deps();
    // ctx {} → surfaceUxFromDispatchCtx 비인터랙티브(채널 없음). effectiveUx 가 LLM relay 로 confirm/question 을
    // 위임하며 interactive:true 로 승격 → harness 가 HITL 을 시도(fail-closed dead-end 회피).
    await dispatchRunDevHarness({ objective: '테스트 골' }, {} as DaemonToolDispatchCtx, d);
    expect(calls[0]?.ux.interactive).toBe(true);
  });

  test('두 비대화형 relay 생성 지점은 정규화된 objective만 context로 전달한다', async () => {
    const contexts: Array<string | undefined> = [];
    const hitlRelayFactory = (relayDeps: LlmHitlRelayDeps): HitlRelay => {
      contexts.push(relayDeps.context);
      return { confirm: async () => false, question: async () => null };
    };
    const { deps: inProcessDeps } = deps();
    await dispatchRunDevHarness({ objective: '  in-process 작업 설명  ' }, {} as DaemonToolDispatchCtx, {
      ...inProcessDeps,
      hitlRelayFactory,
    });
    const detachedDeps: DevHarnessDeps = {
      hitlRelayFactory,
      dispatchDetached: async () => ({ output: 'detached' }),
    };
    await dispatchRunDevHarness(
      { objective: '  detached 작업 설명  ' },
      {} as DaemonToolDispatchCtx,
      detachedDeps,
    );
    expect(contexts).toEqual(['in-process 작업 설명', 'detached 작업 설명']);
  });

  test('★ B1 — carry_capsule/sizing_mode/ledger_mode 를 막 옵션으로 관통', async () => {
    const { deps: d, calls } = deps();
    await dispatchRunDevHarness({ objective: 'x', carry_capsule: true, sizing_mode: 'off', ledger_mode: 'off' }, {} as DaemonToolDispatchCtx, d);
    expect(calls[0]?.carryCapsule).toBe(true);
    expect(calls[0]?.sizingMode).toBe('off');
    expect(calls[0]?.ledgerMode).toBe('off');
  });

  test('★ B1 — 노브 미지정 시 막 옵션 미설정(기본·무회귀)', async () => {
    const { deps: d, calls } = deps();
    await dispatchRunDevHarness({ objective: 'x' }, {} as DaemonToolDispatchCtx, d);
    expect(calls[0]?.carryCapsule).toBeUndefined();
    expect(calls[0]?.sizingMode).toBeUndefined();
    expect(calls[0]?.ledgerMode).toBeUndefined();
  });

  test('auto_drive 파싱(on/off)·잘못된 값은 safe 폴백', async () => {
    const { deps: d1, calls: c1 } = deps();
    await dispatchRunDevHarness({ objective: 'x', auto_drive: 'on' }, {} as DaemonToolDispatchCtx, d1);
    expect(c1[0]?.autoDrive).toBe('on');
    const { deps: d2, calls: c2 } = deps();
    await dispatchRunDevHarness({ objective: 'x', auto_drive: 'bogus' }, {} as DaemonToolDispatchCtx, d2);
    expect(c2[0]?.autoDrive).toBe('safe');
  });

  test('ctx 채널 → ux.interactive 전달', async () => {
    const { deps: d, calls } = deps();
    const ctx = { surfaceHitlChannels: [yesChannel()] } as unknown as DaemonToolDispatchCtx;
    await dispatchRunDevHarness({ objective: 'x' }, ctx, d);
    expect(calls[0]?.ux.interactive).toBe(true);
  });

  test('seamsOptions(repoRoot) 를 seam 팩토리로 전파(P3 대비)', async () => {
    const { deps: base, seamCalls } = deps();
    const d: DevHarnessDeps = { ...base, seamsOptions: { repoRoot: '/ext/repo' } };
    await dispatchRunDevHarness({ objective: 'x' }, {} as DaemonToolDispatchCtx, d);
    expect((seamCalls[0] as { repoRoot?: string }).repoRoot).toBe('/ext/repo');
  });

  test('objective 누락 → 에러', async () => {
    await expect(dispatchRunDevHarness({}, {} as DaemonToolDispatchCtx)).rejects.toThrow('objective required');
  });

  test('실패 terminal → ⚠️ 요약', async () => {
    const { deps: d } = deps({ result: { runId: 'test-run', ok: false, terminal: 'escalated', rounds: 1, detail: 'HITL 필요', state: {} as never } });
    const res = await dispatchRunDevHarness({ objective: 'x' }, {} as DaemonToolDispatchCtx, d);
    expect(res.output).toContain('escalated');
    expect(res.output).toContain('HITL 필요');
  });
});

describe('dispatchRunDevHarness — execution-loop observation', () => {
  const originalRecorded = process.env.ELANOUS_DISPATCH_RECORDED;
  afterEach(() => {
    if (originalRecorded === undefined) delete process.env.ELANOUS_DISPATCH_RECORDED;
    else process.env.ELANOUS_DISPATCH_RECORDED = originalRecorded;
  });

  test('real nonempty gate decisions, including stop, do not change harness options or result', async () => {
    delete process.env.ELANOUS_DISPATCH_RECORDED;
    const root = mkdtempSync(join(tmpdir(), 'dev-harness-dispatch-'));
    const args = { objective: '  Create widget  ', runId: 'run-observed', auto_drive: 'on', sizing_mode: 'off' };
    const baseline = deps();
    const observed = deps();
    const order: string[] = [];
    const inputs: DispatchTaskInput[] = [];
    try {
      const baselineResult = await dispatchRunDevHarness({ ...args, plan_staged: true }, undefined, baseline.deps);
      let dispatchResult: DispatchTaskResult | undefined;
      observed.deps.dispatchTask = async (input, dispatchDeps) => {
        order.push('dispatch');
        inputs.push(input);
        dispatchResult = await dispatchTask(input, dispatchDeps);
        return dispatchResult;
      };
      observed.deps.dispatchTaskDeps = {
        createStore: () => new CardStore(root),
        budgetGate: async () => ({ decision: { action: 'stop', reasons: ['no quota'] }, explanation: 'no quota' }),
        placementGate: () => ({ decision: { substrate: 'unknown', pool: null, source: 'unknown', poolReachability: 'unknown', localReasons: [], unknownInputs: [] }, explanation: 'unknown' }),
        relationGate: async () => ({ decision: { action: 'record', overlappingCards: [], preflightOverlaps: 'unknown', dependsOn: 'unknown', similarCards: 'unknown', sameGoalActiveRuns: [] }, explanation: 'none' }),
        memoryGate: async () => ({ decision: { action: 'record', context: 'remember', fragmentIds: [] }, explanation: 'remember' }),
        emitDecision: () => true,
        log: () => {},
      };
      const runHarness = observed.deps.runHarness!;
      observed.deps.runHarness = async (opts) => { order.push('harness'); return runHarness(opts); };
      const result = await dispatchRunDevHarness(args, undefined, observed.deps);
      expect(order).toEqual(['dispatch', 'harness']);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ goalText: 'Create widget', title: 'Create widget', runKey: 'run-observed', targetPaths: [], spec: { input: { text: 'Create widget' }, plan: true, runId: 'run-observed' } });
      expect(dispatchResult?.mode).toBe('observe');
      expect(dispatchResult?.decisions.budget.decision).toMatchObject({ action: 'stop' });
      expect(dispatchResult?.decisions.placement.decision).toMatchObject({ substrate: 'unknown' });
      expect(dispatchResult?.decisions.relation.decision).toMatchObject({ action: 'record' });
      expect(dispatchResult?.decisions.memory.decision).toMatchObject({ action: 'record' });
      const optionValues = (opts: RunHarnessOnSurfaceOptions) => Object.fromEntries(Object.entries(opts).map(([key, value]) => [
        key,
        key === 'ux' ? { surface: opts.ux.surface, interactive: opts.ux.interactive, keys: Object.keys(opts.ux).sort() }
          : key === 'seams' ? Object.keys(opts.seams).sort()
            : typeof value === 'function' ? '[function]' : value,
      ]));
      expect(optionValues(observed.calls[0]!)).toEqual(optionValues(baseline.calls[0]!));
      expect(result).toEqual(baselineResult);
      const store = new CardStore(root);
      try {
        const cards = store.listCards();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.sections.map((section) => section.key.split(':')[0])).toEqual(['gates', 'relations', 'memory']);
      } finally { store.close(); }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deadline aborts a non-settling observer without blocking the harness', async () => {
    delete process.env.ELANOUS_DISPATCH_RECORDED;
    const order: string[] = [];
    const { deps: d } = deps();
    d.dispatchTaskDeps = { timeoutMs: 20 };
    d.dispatchTask = async (_input, dispatchDeps) => {
      order.push('dispatch-start');
      dispatchDeps?.signal?.addEventListener('abort', () => { order.push('abort'); }, { once: true });
      return new Promise(() => {});
    };
    d.runHarness = async () => { order.push('harness'); return okResult; };
    expect((await dispatchRunDevHarness({ objective: 'Create widget' }, undefined, d)).output).toContain('deployed');
    expect(order).toEqual(['dispatch-start', 'abort', 'harness']);
  });

  test('real dispatch abort closes its card before harness despite a gate completing later', async () => {
    delete process.env.ELANOUS_DISPATCH_RECORDED;
    const root = mkdtempSync(join(tmpdir(), 'dev-harness-abort-'));
    let release!: () => void;
    const pending = new Promise<string>((resolve) => { release = () => resolve('late memory'); });
    const { deps: d } = deps();
    const order: string[] = [];
    d.dispatchTaskDeps = {
      timeoutMs: 20,
      createStore: () => new CardStore(root),
      budgetGate: async () => ({ decision: { action: 'stop', reasons: [] }, explanation: 'stop' }),
      placementGate: () => ({ decision: { substrate: 'unknown', pool: null, source: 'unknown', poolReachability: 'unknown', localReasons: [], unknownInputs: [] }, explanation: 'unknown' }),
      relationGate: async () => ({ decision: { action: 'record', overlappingCards: [], preflightOverlaps: 'unknown', dependsOn: 'unknown', similarCards: 'unknown', sameGoalActiveRuns: [] }, explanation: 'none' }),
      memoryGate: async () => { await pending; order.push('late-gate'); return { decision: { action: 'record', context: 'late memory', fragmentIds: [] }, explanation: 'late' }; },
      emitDecision: () => true,
      log: () => {},
    };
    d.runHarness = async () => { order.push('harness'); return okResult; };
    try {
      const result = await dispatchRunDevHarness({ objective: 'Create widget' }, undefined, d);
      expect(result.output).toContain('deployed');
      const store = new CardStore(root);
      const before = store.listCards();
      expect(before).toHaveLength(1);
      expect(before[0]!.sections).toHaveLength(0);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.listCards()).toEqual(before);
      expect(order).toEqual(['harness', 'late-gate']);
      store.close();
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('failed observation still launches the harness with the same output', async () => {
    delete process.env.ELANOUS_DISPATCH_RECORDED;
    const order: string[] = [];
    const { deps: d } = deps();
    d.dispatchTask = async () => { order.push('dispatch'); throw new Error('card unavailable'); };
    d.runHarness = async () => { order.push('harness'); return okResult; };
    const result = await dispatchRunDevHarness({ objective: 'Create widget' }, undefined, d);
    expect(order).toEqual(['dispatch', 'harness']);
    expect(result.output).toContain('deployed');
  });

  test('detached parent and already-recorded in-process launches do not duplicate a dispatch', async () => {
    delete process.env.ELANOUS_DISPATCH_RECORDED;
    let dispatches = 0;
    const { deps: d } = deps();
    d.dispatchTask = async () => { dispatches++; throw new Error('dispatch must be skipped'); };
    await dispatchRunDevHarness({ objective: 'Create widget' }, { surfaceHitlChannels: [yesChannel()] } as unknown as DaemonToolDispatchCtx, {
      ...d, dispatchDetached: async () => ({ output: 'detached' }),
    });
    expect(dispatches).toBe(0);
    await dispatchRunDevHarness({ objective: 'Create widget', plan_staged: true }, undefined, d);
    expect(dispatches).toBe(0);
    await dispatchRunDevHarness({ objective: 'Create widget', dispatch_recorded: true }, undefined, d);
    expect(dispatches).toBe(0);
    process.env.ELANOUS_DISPATCH_RECORDED = '1';
    await dispatchRunDevHarness({ objective: 'Create widget' }, undefined, d);
    expect(dispatches).toBe(0);
  });
});

describe('dispatchRunDevHarness — P3 외부 repo 타깃', () => {
  test('홈 밖 + 존재하지 않는 경로 → 구조화 거부(크래시 아님)', async () => {
    // seamsOptions 미주입 → 실제 target 검증 경로. runHarness 는 캡처만.
    const calls: RunHarnessOnSurfaceOptions[] = [];
    const d: DevHarnessDeps = { runHarness: async (o) => { calls.push(o); return okResult; }, seamsFactory: () => ({} as never) };
    const res = await dispatchRunDevHarness({ objective: 'x', target: '/nonexistent/bogus-repo-xyz' }, {} as DaemonToolDispatchCtx, d);
    expect(res.output).toContain('거부');
    expect(res.output).toContain('target을 생략하세요(그러면 elanous 자신을 대상으로 합니다)');
    expect(calls.length).toBe(0); // 하니스 미구동.
  });

  test('target 실 git repo → repoRoot+elanousBinRoot 를 seam 으로', async () => {
    const seamCalls: Array<{ repoRoot?: string; elanousBinRoot?: string }> = [];
    const d: DevHarnessDeps = {
      runHarness: async () => okResult,
      seamsFactory: (o) => { seamCalls.push(o as never); return {} as never; },
    };
    // 이 테스트가 도는 elanous repo 자체를 '외부 target' 으로 사용(실 git repo).
    const res = await dispatchRunDevHarness({ objective: 'x', target: process.cwd() }, {} as DaemonToolDispatchCtx, d);
    expect(res.output).not.toContain('거부');
    expect(seamCalls[0]?.repoRoot).toBeTruthy();
    expect(seamCalls[0]?.elanousBinRoot).toBeTruthy();
  });

  test('target 생략/self → 외부 검증 스킵(seamsOptions 없음)', async () => {
    const seamCalls: Array<{ repoRoot?: string }> = [];
    const d: DevHarnessDeps = { runHarness: async () => okResult, seamsFactory: (o) => { seamCalls.push(o as never); return {} as never; } };
    await dispatchRunDevHarness({ objective: 'x', target: 'self' }, {} as DaemonToolDispatchCtx, d);
    expect(seamCalls[0]?.repoRoot).toBeUndefined();
  });
});

describe('dispatchRunDevHarness — #25 P4 target 종류 라우팅(비-git dir·config·안전벽)', () => {
  // 홈 안에 실 디렉토리/파일을 만들어 라우팅 검증(resolveTargetKind 는 홈 밖=outside-home 거부).
  const inHome: string[] = [];
  const mkHome = (make: (dir: string) => void): string => {
    const dir = mkdtempSync(join(homedir(), '.elanous-devharness-test-'));
    inHome.push(dir);
    make(dir);
    return dir;
  };
  afterEach(() => { for (const d of inHome.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test('비-git 디렉토리 → targetKind=non-git-dir·targetPath 전파(거부 아님)', async () => {
    const dir = mkHome((d) => writeFileSync(join(d, 'note.txt'), 'hi\n'));
    const seamCalls: DefaultSeamsOptions[] = [];
    const d: DevHarnessDeps = { runHarness: async () => okResult, seamsFactory: (o) => { seamCalls.push(o); return {} as never; } };
    const res = await dispatchRunDevHarness({ objective: 'x', target: dir }, {} as DaemonToolDispatchCtx, d);
    expect(res.output).not.toContain('거부');
    expect(seamCalls[0]?.targetKind).toBe('non-git-dir');
    expect(seamCalls[0]?.targetPath).toBe(dir);
    expect(seamCalls[0]?.repoRoot).toBeUndefined();
  });

  test('config 파일 → targetKind=file·targetPath 전파', async () => {
    const dir = mkHome((d) => writeFileSync(join(d, 'config.json'), '{"a":1}\n'));
    const file = join(dir, 'config.json');
    const seamCalls: DefaultSeamsOptions[] = [];
    const d: DevHarnessDeps = { runHarness: async () => okResult, seamsFactory: (o) => { seamCalls.push(o); return {} as never; } };
    const res = await dispatchRunDevHarness({ objective: 'x', target: file }, {} as DaemonToolDispatchCtx, d);
    expect(res.output).not.toContain('거부');
    expect(seamCalls[0]?.targetKind).toBe('file');
    expect(seamCalls[0]?.targetPath).toBe(file);
  });

  test('★ 홈 밖 시스템경로(실존) + HITL 승인 → 진행(dir=non-git-dir·2단 HITL 진입 게이트)', async () => {
    // 실존 홈 밖 디렉토리로 진입 확인 승인 경로 검증. yesChannel → ux.confirm true.
    const sysDir = mkdtempSync(join(tmpdir(), 'devharness-sys-'));  // tmpdir 은 홈 밖(outside-home)
    inHome.push(sysDir); // 정리 재사용(경로 무관)
    const seamCalls: DefaultSeamsOptions[] = [];
    const d: DevHarnessDeps = { runHarness: async () => okResult, seamsFactory: (o) => { seamCalls.push(o); return {} as never; } };
    const ctx = { surfaceHitlChannels: [yesChannel()] } as unknown as DaemonToolDispatchCtx;
    const res = await dispatchRunDevHarness({ objective: 'x', target: sysDir }, ctx, d);
    expect(res.output).not.toContain('거부');
    expect(seamCalls[0]?.targetKind).toBe('non-git-dir');
    expect(seamCalls[0]?.targetPath).toBe(realpathSync(sysDir));
  });

  test('홈 밖 시스템경로(실존) + HITL 미승인/채널없음 → fail-closed 거부', async () => {
    const sysDir = mkdtempSync(join(tmpdir(), 'devharness-sys2-'));
    inHome.push(sysDir);
    const calls: RunHarnessOnSurfaceOptions[] = [];
    const d: DevHarnessDeps = { runHarness: async (o) => { calls.push(o); return okResult; }, seamsFactory: () => ({} as never) };
    // 빈 ctx → 승인 채널 없음 → ux.confirm fail-closed(false) → 거부.
    const res = await dispatchRunDevHarness({ objective: 'x', target: sysDir }, {} as DaemonToolDispatchCtx, d);
    expect(res.output).toContain('거부');
    expect(calls.length).toBe(0);
  });

  test('홈 안 존재하지 않는 경로 → 거부', async () => {
    const res = await dispatchRunDevHarness(
      { objective: 'x', target: join(homedir(), '.elanous-nope-xyz-does-not-exist') },
      {} as DaemonToolDispatchCtx,
      { runHarness: async () => okResult, seamsFactory: () => ({} as never) },
    );
    expect(res.output).toContain('거부');
    expect(res.output).toContain('target을 생략하세요(그러면 elanous 자신을 대상으로 합니다)');
  });

  test('스테이징 직전 symlink 재지정은 dispatch를 통과해도 createWorktree에서 차단한다', async () => {
    const first = mkHome((d) => mkdirSync(join(d, 'first')));
    const second = join(first, 'second');
    const link = join(first, 'mutable');
    mkdirSync(second);
    symlinkSync(join(first, 'first'), link, 'dir');
    let staged = false;
    const d: DevHarnessDeps = {
      seamsFactory: () => ({
        createWorktree: async () => { staged = true; return { path: first, branch: 'dev-test' }; },
      } as never),
      runHarness: async (opts) => {
        rmSync(link);
        symlinkSync(second, link, 'dir');
        await expect(opts.seams.createWorktree({ branch: 'dev-test' })).rejects.toThrow('harness target revalidation failed');
        return okResult;
      },
    };
    await dispatchRunDevHarness({ objective: 'x', target: link }, {} as DaemonToolDispatchCtx, d);
    expect(staged).toBe(false);
  });
});

// ⛔⭐⭐⭐ observe-only 관문 회귀 (대표 2026-08-06).
//
//   ***이 파일이 지키는 것은 「플래그가 읽혔다」가 아니라 「하니스가 «안 돌았다»」다.***
//   ⛔ 스위치가 전달됐는지만 보면 Goodhart 다 — 실제로 막는지는 **막이 안 불렸다**로만 증명된다.
//   📏 왜 필요했나: 이 입구는 `self_implement`(18건)보다 **많이 돈다**(harness.frontdoor 92 · harness.skill 43).
//     관문이 없던 동안, 라우팅을 재려고 자연어를 넣으면 사람 트리에 진짜 런이 떴다.
describe('dispatchRunDevHarness — observe-only 관문', () => {
  const ENV = 'ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY';
  let prev: string | undefined;
  beforeEach(() => { prev = process.env[ENV]; });
  afterEach(() => { if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev; });

  test('★ 켜져 있으면 «막이 안 불린다» — 기록만 남는다', async () => {
    process.env[ENV] = '1';
    const { deps: d, calls } = deps();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: Array<{ category: string; event: string }> = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string) => {
      logs.push({ category, event });
    }) as typeof debug.log;
    try {
      const r = await dispatchRunDevHarness({ objective: '관문 확인' }, {} as DaemonToolDispatchCtx, d);
      // ⑴ ⭐ 하니스가 «안 돌았다» — 이 한 줄이 이 테스트의 전부다.
      expect(calls.length).toBe(0);
      // ⑵ 그런데 «불렸다는 사실»은 남는다(라우팅 판정에 필요한 것은 이것이다).
      expect(logs.some((log) => log.category === 'harness.frontdoor' && log.event === 'observed')).toBe(true);
      // ⑶ 그리고 호출자에게 «조용히 성공»이라 말하지 않는다.
      expect(r.output).toContain('observe-only');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('꺼져 있으면 종전대로 막이 불린다(무회귀)', async () => {
    delete process.env[ENV];
    const { deps: d, calls } = deps();
    await dispatchRunDevHarness({ objective: '무회귀' }, {} as DaemonToolDispatchCtx, d);
    expect(calls.length).toBeGreaterThan(0);
  });
});
