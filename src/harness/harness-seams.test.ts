// 하니스 실 seam 팩토리(H1) — fake SelfImplementSeams 로 배선·fail-closed deploy·하니스 통합 검증.
import { test, expect, describe, spyOn } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import * as prReviewer from '../agent-substrate/pr-reviewer.js';
import { buildGenericSkillExecute } from './generic-skill-executor.js';
import { buildWebDomainExecute } from './web-executor.js';
// 매매 집행기는 애드온이다(공개 코어엔 없다 · release/trading-export.yaml) — 있을 때만 그 시험을 돌린다.
const EXECUTION_EXECUTOR_MODULE: string = './execution-executor.js';
const HAS_TRADING_ADDON = existsSync(join(import.meta.dir, 'execution-executor.ts'));
import { buildHarnessSeams, classifyHeft, adversarialThreshold, ADVERSARIAL_AUTO_STEPS, postPrReview } from './harness-seams.js';
import { runStagedHarness, type StagedHarnessSeams } from './staged-harness.js';
import { releasePathHoldComment } from '../self-dev/release-path-guard.js';
import { realWorktreeSeams as fakeSeams } from './harness-test-seams.js';

describe('buildHarnessSeams — 실 인프라 배선(fake)', () => {
  test('plan → worktree 생성 + heuristic 스텝(마커 없으면 objective 1스텝)', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams() });
    const p = await s.plan({ objective: '기능 X' });
    expect(p.steps).toEqual(['기능 X']);
  });

  // ── C1/C3(§8) 골루프-우선 · 옵션 차용 ──────────────────────────────────────
  test('C1 — plan 이 경량 Context Capsule 산출(steps=inScope·gate evidence·attach)', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams() });
    const p = await s.plan({ objective: '기능 X' });
    expect(p.capsule?.objective).toBe('기능 X');
    expect(p.capsule?.inScope).toEqual(['기능 X']);
    expect(p.capsule?.evidenceRequired.length).toBeGreaterThan(0);
  });

  // 🚨 73차 — ***비-코드 도메인에 「gate 통과」를 성공기준으로 주지 않는다***(채울 수 없는 요구).
  //   📏 실측: 씨앗이 없으면 24/24 가 *"계획된 모든 스텝이 구현되고 gate(tsc/test) 통과"* 였고,
  //     `--domain` 을 명시해도 그대로여서 read-only 런 3/3 이 그 문장을 「미충족 성공기준」으로 받고 죽었다.
  test('비-코드 도메인이면 성공기준이 «코드 게이트»가 아니다', async () => {
    const codeSeams = buildHarnessSeams({ seams: fakeSeams() });
    const codePlan = await codeSeams.plan({ objective: '기능 X' });
    expect(codePlan.capsule?.successCriteria.join(' ')).toContain('gate');

    const domainSeams = buildHarnessSeams({ seams: fakeSeams(), domainExecute: buildGenericSkillExecute({ skill: 'noop' } as never) });
    const domainPlan = await domainSeams.plan({ objective: '이 저장소를 조사해 보고한다' });
    const criteria = domainPlan.capsule?.successCriteria.join(' ') ?? '';
    expect(criteria).not.toContain('gate(tsc/test)');
    expect(criteria).toContain('비-코드');
  });

  test('C3 observe(기본) — sizing 채점 attach(골루프 runway 무접촉·steps 그대로)', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams() });
    const p = await s.plan({ objective: '작업\n- s1\n- s2' });
    expect(p.sizing).toBeDefined();
    expect(p.steps).toEqual(['s1', 's2']);   // sizing 은 자르지 않는다 — steps 무접촉
  });

  test('plan 관측은 runId를 싣고 기존 sizing 필드를 보존하며 data runId를 우선한다', async () => {
    const previousRunId = process.env.ELANOUS_RUN_ID;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    process.env.ELANOUS_RUN_ID = 'run-seams-observation';
    try {
      const seams = buildHarnessSeams({ seams: fakeSeams() });
      await seams.plan({ objective: '작업\n- s1\n- s2' });
      const seamPayloads = log.mock.calls
        .filter(([category]) => category === 'harness.seams')
        .map(([, , payload]) => payload as Record<string, unknown>);

      expect(seamPayloads.length).toBeGreaterThan(0);
      for (const payload of seamPayloads) {
        expect(payload.runId).toBe('run-seams-observation');
      }
      expect(seamPayloads).toContainEqual(expect.objectContaining({ steps: 2 }));
      expect(seamPayloads).toContainEqual(expect.objectContaining({ oversized: expect.any(Number), tooSmall: expect.any(Number) }));
      expect(readFileSync(new URL('./harness-seams.ts', import.meta.url), 'utf8')).toContain(
        "debug.log('harness.seams', event, { runId, ...data })",
      );
    } finally {
      log.mockRestore();
      if (previousRunId === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = previousRunId;
    }
  });

  test('C3 off — sizing 완전 비활성(순수 골루프·계측조차 안 함)', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams(), sizingMode: 'off' });
    const p = await s.plan({ objective: '작업\n- s1\n- s2' });
    expect(p.sizing).toBeUndefined();
    expect(p.capsule).toBeDefined();          // capsule 은 골루프를 돕는 쪽 → off 여도 유지
    expect(p.steps).toEqual(['s1', 's2']);
  });

  // ── run identity(K) 전파 — #5476 의 컴파일 가드가 실제로는 이 경로를 놓쳤던 갭의 회귀 가드 ──
  test('★ execute 가 자식 implement 에 non-empty runId 를 전파(라운드 간 동일 — self run 조인 앵커)', async () => {
    // ⚠️ must-fix(#5484 3R): `ELANOUS_RUN_ID` 를 **반드시 비운다** — 상속이 있으면 라운드별 mint 구현도
    //    같은 값을 뱉어 가드가 무력해진다(하니스 안에서 테스트를 돌릴 때 실제로 그렇게 된다).
    //    비워야 "seams 1회 확정"과 "라운드마다 mint"가 갈린다 = 이 테스트가 고정하려는 바로 그 축.
    const prevRun = process.env.ELANOUS_RUN_ID;
    const prevSpace = process.env.ELANOUS_HARNESS_SPACE;
    delete process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_HARNESS_SPACE;
    try {
      const seen: string[] = [];
      const s = buildHarnessSeams({ seams: fakeSeams({ async implement({ runId }) { seen.push(runId); return { ok: true, summary: 'x' }; } }) });
      await s.plan({ objective: 'bar' });
      await s.execute({ objective: 'bar', steps: [], round: 1 });
      await s.execute({ objective: 'bar', steps: [], round: 2 });   // 리워크 라운드
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeTruthy();
      expect(seen[1]).toBe(seen[0]!);   // 라운드마다 mint 하면 `elanous self run <runId>` 가 호출 전체를 못 묶는다
    } finally {
      if (prevRun === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = prevRun;
      if (prevSpace === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = prevSpace;
    }
  });

  // self review should-fix(#5484) — mint 경로만 덮으면 "부모 runId 를 버리고 새로 mint" 회귀를 놓친다.
  //   fan-out 은 부모 1개 : 자식 N 이 같은 runId 를 공유하는 게 계약이므로 상속 경로를 따로 고정한다.
  test('★ 하니스 공간(부모 fan-out)의 runId 를 상속 — 새로 mint 하지 않는다', async () => {
    const prevSpace = process.env.ELANOUS_HARNESS_SPACE;
    const prevRun = process.env.ELANOUS_RUN_ID;
    process.env.ELANOUS_HARNESS_SPACE = 'dev-harness';
    process.env.ELANOUS_RUN_ID = 'run-parent-abc';
    try {
      let seen = '';
      const s = buildHarnessSeams({ seams: fakeSeams({ async implement({ runId }) { seen = runId; return { ok: true, summary: 'x' }; } }) });
      await s.plan({ objective: 'bar' });
      await s.execute({ objective: 'bar', steps: [], round: 1 });
      expect(seen).toBe('run-parent-abc');
    } finally {
      if (prevSpace === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = prevSpace;
      if (prevRun === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = prevRun;
    }
  });

  test('B auto(기본) — seed 없으면 미carry(휴리스틱 기본값뿐=noise 회피)', async () => {
    let captured = '';
    const s = buildHarnessSeams({ seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }) });
    await s.plan({ objective: 'bar' });   // capsuleSeed 없음 → seedEnriched false → auto 미carry
    await s.execute({ objective: 'bar', steps: [], round: 1 });
    expect(captured).not.toContain('설계 계약');
  });

  test('★ B 조건부 flip — 인터뷰 seed 있으면 carryCapsule 미지정이어도 자동 carry', async () => {
    let captured = '';
    const s = buildHarnessSeams({ seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }) });
    await s.plan({ objective: 'bar', capsuleSeed: { successCriteria: ['done: 결제 왕복'] } });   // 인터뷰 nav → auto carry
    await s.execute({ objective: 'bar', steps: [], round: 1 });
    expect(captured).toContain('설계 계약(Context Capsule)');
    expect(captured).toContain('done: 결제 왕복');
  });

  test('B carryCapsule=false 명시 — seed 있어도 never carry', async () => {
    let captured = '';
    const s = buildHarnessSeams({ seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }), carryCapsule: false });
    await s.plan({ objective: 'bar', capsuleSeed: { successCriteria: ['done: x'] } });
    await s.execute({ objective: 'bar', steps: [], round: 1 });
    expect(captured).not.toContain('설계 계약');
  });

  test('C1 carryCapsule=true(opt-in) — execute 프롬프트에 계약 digest 주입', async () => {
    let captured = '';
    const s = buildHarnessSeams({ seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }), carryCapsule: true });
    await s.plan({ objective: 'bar' });
    await s.execute({ objective: 'bar', steps: [], round: 1 });
    expect(captured).toContain('설계 계약(Context Capsule)');
    expect(captured).toContain('bar');   // 원 objective 유지
  });

  test('C2 — plan 이 capsuleSeed(인터뷰 산출)로 Capsule 나침반 채움(success/scope/risk 승격)', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams() });
    const p = await s.plan({ objective: '기능 X', capsuleSeed: {
      successCriteria: ['범위: A 흐름 완주', '범위: B 검증'],
      outOfScope: ['레거시 C 는 후속'],
      riskBoundaries: ['운영 배포 금지'],
    } });
    expect(p.capsule?.successCriteria).toEqual(['범위: A 흐름 완주', '범위: B 검증']);   // 휴리스틱 기본 대신 인터뷰 값
    expect(p.capsule?.outOfScope).toEqual(['레거시 C 는 후속']);
    expect(p.capsule?.riskBoundaries).toEqual(['운영 배포 금지']);
  });

  test('C2 — capsuleSeed 없으면 휴리스틱 기본(무회귀)', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams() });
    const p = await s.plan({ objective: '기능 X' });
    expect(p.capsule?.successCriteria.length).toBeGreaterThan(0);   // 기본 성공기준
    expect(p.capsule?.outOfScope).toEqual([]);                       // 씨앗 없으면 빈 범위밖
  });

  test('C2 — carryCapsule + seed → execute 프롬프트에 인터뷰 성공기준·범위밖 도달', async () => {
    let captured = '';
    const s = buildHarnessSeams({ seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }), carryCapsule: true });
    await s.plan({ objective: 'bar', capsuleSeed: { successCriteria: ['done: 결제 왕복'], outOfScope: ['환불은 후속'] } });
    await s.execute({ objective: 'bar', steps: [], round: 1 });
    expect(captured).toContain('done: 결제 왕복');   // 골루프가 나침반(무엇이 done)을 봄
    expect(captured).toContain('환불은 후속');
  });

  test('★ replan 진행-보존(2026-07-22) — 재계획(2회차 plan)은 worktree 를 재사용(createWorktree 1회만·백지 리셋 금지)', async () => {
    let wtCalls = 0;
    const s = buildHarnessSeams({
      seams: fakeSeams({
        async createWorktree({ branch }: { branch: string; base?: string }) { wtCalls += 1; return { path: `/tmp/harness-wt-${wtCalls}`, branch }; },
      }),
    });
    await s.plan({ objective: '기능 X' });                                        // 첫 계획 → worktree 1회 생성
    await s.plan({ objective: '기능 X', priorFindings: ['이전 시도의 dead code'], attempt: 1 }); // 재계획 → 재사용(누적 작업 보존)
    expect(wtCalls).toBe(1);   // ⭐ fresh 리셋이면 2가 됨 — near-done 상태 폐기 방지(legC 붕괴 회귀 가드)
  });

  test('plan heuristic — 리스트 마커면 스텝 파싱', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams() });
    const p = await s.plan({ objective: '작업\n- 스텝1\n- 스텝2' });
    expect(p.steps.length).toBe(2);
  });

  test('★ H2 adversarial — force 시 크리틱 호출·보강 스텝 사용', async () => {
    let seen: { steps: readonly string[] } | null = null;
    const s = buildHarnessSeams({
      seams: fakeSeams(),
      adversarialForce: true,
      adversarialPlan: async (_obj, steps) => { seen = { steps }; return { revisedSteps: ['보강A', '보강B', '보강C'], issues: ['누락'] }; },
    });
    const p = await s.plan({ objective: '기능 X' });   // heuristic=1스텝
    expect(seen).not.toBeNull();
    expect(p.steps).toEqual(['보강A', '보강B', '보강C']);  // 크리틱 보강본으로 교체
  });

  test('★ H2 adversarial — force 아니고 단순 계획(<4스텝)이면 크리틱 미호출', async () => {
    let called = false;
    const s = buildHarnessSeams({
      seams: fakeSeams(),
      adversarialForce: false,
      adversarialPlan: async () => { called = true; return null; },
    });
    await s.plan({ objective: '기능 X' });   // 1스텝 < 임계 → 미발동
    expect(called).toBe(false);
  });

  test('★ H2 adversarial — 복잡 계획(≥10스텝)은 force 없어도 자동 발동', async () => {
    let called = false;
    const s = buildHarnessSeams({
      seams: fakeSeams(),
      adversarialForce: false,
      adversarialPlan: async () => { called = true; return null; },
    });
    await s.plan({ objective: '작업\n- s1\n- s2\n- s3\n- s4\n- s5\n- s6\n- s7\n- s8\n- s9\n- s10' });   // 10스텝 ≥ 임계 → 자동
    expect(called).toBe(true);
  });

  test('execute — worktree 없으면 실패, plan 후 implement 호출', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams() });
    expect((await s.execute({ objective: 'x', steps: [], round: 1 })).ok).toBe(false); // plan 전
    await s.plan({ objective: 'x' });
    expect((await s.execute({ objective: 'x', steps: [], round: 1 })).ok).toBe(true);
  });

  test('★ 이식 §3.1 — grounding 팩트가 Executor 자식 프롬프트에 주입(재조사·재구현 환각 차단)', async () => {
    let captured = '';
    const s = buildHarnessSeams({
      seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'done' }; } }),
      ground: async () => ({
        grounded: true,
        context: '기존 관련 코드/문서/스킬: - src/foo.ts: helper',
        files: ['src/foo.ts'],
        skillFacts: ['[skill:yt-vault] 지식 흡수'],
        codeFacts: ['[code:src/foo.ts] runFoo, FooResult'],
        memoryFacts: ['[memory:project] 이전 아크 X'],
        documentFacts: [],
        refFacts: [],
        ptyFacts: [],
      }),
    });
    await s.plan({ objective: 'foo 확장' });
    await s.execute({ objective: 'foo 확장', steps: [], round: 1 });
    expect(captured).toContain('[기존 자산 grounding');
    expect(captured).toContain('웹 재검색 대신 이 로컬 canonical 참조를 직접 Read/Grep 하라');
    expect(captured).toContain('[code:src/foo.ts] runFoo');   // L4 코드 심볼
    expect(captured).toContain('[skill:yt-vault]');            // L3 skill 계약
    expect(captured).toContain('[memory:project]');            // P2 참조 기억
    expect(captured).toContain('foo 확장');                    // 원 objective 도 유지
  });

  test('ground 미주입 → grounding 블록 없음(무회귀·기존 동작 보존)', async () => {
    let captured = '';
    const s = buildHarnessSeams({ seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }) });
    await s.plan({ objective: 'bar' });
    await s.execute({ objective: 'bar', steps: [], round: 1 });
    expect(captured).toBe('bar'); // grounding 없이 objective 그대로
  });

  test('★ H3 research — 외부지식 요하는 objective(게이트 통과) → 조사결과가 Executor 프롬프트에', async () => {
    let captured = ''; let researchCalled = false;
    const s = buildHarnessSeams({
      seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }),
      research: async (topic) => { researchCalled = true; return { ok: true, output: `${topic}: 외부 문서 요약 본문` }; },
    });
    await s.plan({ objective: 'Stripe 최신 API 로 결제 붙이기' }); // '최신' → 게이트 통과
    await s.execute({ objective: 'Stripe 최신 API 로 결제 붙이기', steps: [], round: 1 });
    expect(researchCalled).toBe(true);
    expect(captured).toContain('[외부 조사(web)');
    expect(captured).toContain('외부 문서 요약');
  });

  test('H3 research — 평범한 objective(게이트 미통과) → research 안 부름(경량·비용 0)', async () => {
    let researchCalled = false;
    const s = buildHarnessSeams({
      seams: fakeSeams(),
      research: async () => { researchCalled = true; return { ok: true, output: 'x' }; },
    });
    await s.plan({ objective: 'clamp 유틸 추가' }); // 게이트 미통과
    expect(researchCalled).toBe(false);
  });

  test('skillExec carry — 고른 skill 수와 grounding 전달 수를 관측', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const s = buildHarnessSeams({
        seams: fakeSeams(),
        skillExec: async () => ({ skill: 'research', output: '격리 skill 결과', picked: ['research', 'docs'] }),
      });
      await s.plan({ objective: 'skill 실행' });
      expect(log).toHaveBeenCalledWith('harness.skill', 'facts-carry', { found: 2, delivered: 1 });
    } finally {
      log.mockRestore();
    }
  });

  test('skillExec carry — 빈 출력도 선택 수와 전달 0을 관측', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const s = buildHarnessSeams({
        seams: fakeSeams(),
        skillExec: async () => ({ skill: 'research', output: '', picked: ['research', 'docs'] }),
      });
      await s.plan({ objective: 'skill 실행' });
      expect(log).toHaveBeenCalledWith('harness.skill', 'facts-carry', { found: 2, delivered: 0 });
    } finally {
      log.mockRestore();
    }
  });

  test('review — 게이트 fail → verdict fail', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams({ async gate() { return { passed: false }; } }) });
    await s.plan({ objective: 'x' });
    expect((await s.review({ objective: 'x', changes: [] })).verdict).toBe('fail');
  });

  test('빈 worktree diff는 심사 미실행 warn을 reviewed=false로 반환한다', async () => {
    let reviewerCalled = false;
    const s = buildHarnessSeams({
      seams: fakeSeams(),
      llmReview: async () => { reviewerCalled = true; return 'VERDICT: PASS'; },
    });
    await s.plan({ objective: 'empty diff review' });
    const review = await s.review({ objective: 'empty diff review', changes: [] });
    expect(review).toMatchObject({
      verdict: 'warn',
      findings: ['자율 PR 리뷰 미실행(fail-soft) — 미검토'],
      reviewed: false,
    });
    expect(reviewerCalled).toBe(false);
  });

  test('실제 diff 심사는 reviewed=true를 유지한다', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams(), llmReview: async () => 'VERDICT: PASS' });
    await s.plan({ objective: 'reviewed diff' });
    await s.execute({ objective: 'reviewed diff', steps: [], round: 1 });
    expect(await s.review({ objective: 'reviewed diff', changes: ['feature.ts'] })).toMatchObject({ verdict: 'pass', reviewed: true });
  });

  test('⭐ staged reviewer가 GateLike 실행 증빙을 evidenceNote로 받는다', async () => {
    let prompt = '';
    const s = buildHarnessSeams({
      seams: fakeSeams({ async gate() { return { passed: true, log: '23 pass\n0 fail\nRan 6 tests across 1 file\nerror TS9999: 0 relevant errors' }; } }),
      llmReview: async (input) => { prompt = input; return 'VERDICT: PASS'; },
    });
    await s.plan({ objective: 'gate evidence' });
    await s.execute({ objective: 'gate evidence', steps: [], round: 1 });
    expect((await s.review({ objective: 'gate evidence', changes: ['feature.ts'] })).verdict).toBe('pass');
    expect(prompt).toContain('## Evidence');
    expect(prompt).toContain('## Gate execution evidence');
    expect(prompt).toContain('Ran 6 tests across 1 file');
    expect(prompt).toContain('error TS9999: 0 relevant errors');
  });

  test('★ deploy fail-closed — authorizeDeploy 없으면 PR 안 열고 브랜치만(ref=branch)', async () => {
    let prOpened = false;
    const s = buildHarnessSeams({ seams: fakeSeams({ async openPr() { prOpened = true; return { url: 'x', number: 1 }; } }) });
    await s.plan({ objective: 'my feat' });
    await s.execute({ objective: 'my feat', steps: [], round: 1 }); // 실 변경 생성(deploy 전제)
    const d = await s.deploy({ objective: 'my feat', summary: 's' });
    expect(d.ok).toBe(true);
    expect(d.kind).toBe('branch');          // 커밋·준비됨(PR 미개설)
    expect(prOpened).toBe(false);           // ★ 무단 PR 안 열림
    expect(d.ref).toBe('harness/my-feat');  // 브랜치만 준비
  });

  test('deploy — authorizeDeploy true 면 실 PR open', async () => {
    const s = buildHarnessSeams({ seams: fakeSeams(), authorizeDeploy: () => true });
    await s.plan({ objective: 'my feat' });
    await s.execute({ objective: 'my feat', steps: [], round: 1 }); // 실 변경 생성(deploy 전제)
    const d = await s.deploy({ objective: 'my feat', summary: 's' });
    expect(d.kind).toBe('pr');
    expect(d.ref).toBe('https://pr/harness/my-feat');
  });

  test.each(['scripts/release-loop/publish.ts', 'graphs/release/check.yaml', 'src/release-loop/manifest.ts'])(
    'staged harness holds %s before auto-review can opt in', async (path) => {
      const operations: string[] = [];
      const log = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        const s = buildHarnessSeams({ authorizeDeploy: () => true, autoReview: true, seams: fakeSeams({
          openPr: async ({ labels }) => { expect(labels).toBeUndefined(); operations.push('open'); return { url: 'https://pr/7', number: 7 }; },
          readPrFiles: async () => { operations.push('inspect'); return [path]; },
          addPrLabel: async ({ label }) => { operations.push(`label:${label}`); },
          postPrComment: async ({ body }) => { operations.push(`comment:${body}`); },
        }) });
        await s.plan({ objective: 'safe ordinary change' });
        await s.execute({ objective: 'safe ordinary change', steps: [], round: 1 });
        const result = await s.deploy({ objective: 'safe ordinary change', summary: 'done' });
        expect(result.kind).toBe('pr');
        expect(operations).toEqual(['open', 'inspect', 'label:elanous:release-path', `comment:${releasePathHoldComment(path)}`]);
        expect(log).toHaveBeenCalledWith('self-dev.merge', 'release-path-hold', expect.objectContaining({ path }));
      } finally { log.mockRestore(); }
    },
  );

  test('staged harness does not opt in to auto-review when PR paths cannot be read', async () => {
    const labels: string[] = [];
    const s = buildHarnessSeams({ authorizeDeploy: () => true, autoReview: true, seams: fakeSeams({
      readPrFiles: async () => { throw new Error('PR files unavailable'); },
      addPrLabel: async ({ label }) => { labels.push(label); },
    }) });
    await s.plan({ objective: 'safe ordinary change' });
    await s.execute({ objective: 'safe ordinary change', steps: [], round: 1 });
    expect((await s.deploy({ objective: 'safe ordinary change', summary: 'done' })).kind).toBe('pr');
    expect(labels).toEqual([]);
  });

  test('staged harness activates eligible ordinary PR auto-review after inspection', async () => {
    const events: string[] = [];
    const s = buildHarnessSeams({ authorizeDeploy: () => true, autoReview: true, seams: fakeSeams({
      reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'clean', reviewed: true, diffTruncated: false }),
      openPr: async ({ labels }) => { expect(labels).toBeUndefined(); events.push('open'); return { url: 'https://pr/7', number: 7 }; },
      readPrFiles: async () => { events.push('inspect'); return ['src/ordinary.ts']; },
      addPrLabel: async ({ label }) => { events.push(`label:${label}`); },
    }) });
    await s.plan({ objective: 'safe ordinary change' });
    await s.execute({ objective: 'safe ordinary change', steps: [], round: 1 });
    await s.deploy({ objective: 'safe ordinary change', summary: 'done', verdict: 'pass' });
    expect(events).toEqual(['open', 'inspect', 'label:auto-review']);
  });

  test('staged harness keeps ordinary PR behavior without release-path annotations', async () => {
    const operations: string[] = [];
    const s = buildHarnessSeams({ authorizeDeploy: () => true, autoReview: true, seams: fakeSeams({
      openPr: async () => { operations.push('open'); return { url: 'https://pr/7', number: 7 }; },
      readPrFiles: async () => { operations.push('inspect'); return ['src/ordinary.ts']; },
      addPrLabel: async ({ label }) => { operations.push(`label:${label}`); },
      postPrComment: async ({ body }) => { if (body.includes('OP approval required')) operations.push('hold-comment'); },
    }) });
    await s.plan({ objective: 'safe ordinary change' });
    await s.execute({ objective: 'safe ordinary change', steps: [], round: 1 });
    const result = await s.deploy({ objective: 'safe ordinary change', summary: 'done' });
    expect(result.kind).toBe('pr');
    expect(operations).toEqual(['open', 'inspect']);
  });

  test('auto-review decision emits redacted, bounded risk evidence without changing eligibility', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const longSentence = `wire ${'context '.repeat(40)}`;
    try {
      const s = buildHarnessSeams({ seams: fakeSeams(), authorizeDeploy: () => true, autoReview: true });
      await s.plan({ objective: `Do not deploy. ${longSentence}\ncredential=secret` });
      await s.execute({ objective: `Do not deploy. ${longSentence}\ncredential=secret`, steps: [], round: 1 });
      await s.deploy({ objective: `Do not deploy. ${longSentence}\ncredential=secret`, summary: 's' });

      expect(log).toHaveBeenCalledWith('autoreview.decision', 'declined', expect.objectContaining({
        surface: 'harness',
        eligible: false,
        reasons: expect.arrayContaining(['위험 신호: 실주문/금전 거래', '위험 신호: 보안/인증 정보']),
        suppressedRiskHits: 1,
        riskHits: expect.arrayContaining([
          expect.objectContaining({ reason: '실주문/금전 거래', match: 'wire', sentenceTruncated: true }),
          expect.objectContaining({ reason: '보안/인증 정보' }),
        ]),
      }));
      const payload = log.mock.calls.find(([category]) => category === 'autoreview.decision')![2] as { riskHits: Array<Record<string, unknown>> };
      expect(payload.riskHits.find((hit) => hit.reason === '실주문/금전 거래')).toMatchObject({ match: 'wire', sentence: expect.any(String) });
      expect(payload.riskHits.find((hit) => hit.reason === '보안/인증 정보')).not.toHaveProperty('match');
    } finally {
      log.mockRestore();
    }
  });
});

describe('하니스 통합 — runStagedHarness(buildHarnessSeams(fake))', () => {
  test('end-to-end: plan→execute→review(pass)→deploy(fail-closed) → deployed(ref=branch)', async () => {
    const seams = buildHarnessSeams({ seams: fakeSeams() });
    const r = await runStagedHarness({ objective: '기능 X 구현', seams });
    expect(r.ok).toBe(true);
    expect(r.terminal).toBe('branch-prepared'); // fail-closed → 커밋·준비(정직한 terminal·버그A)
    expect(r.deployRef).toBe('harness/x');  // fail-closed → 브랜치
  });

  test('end-to-end: 게이트 fail → review-diverge → escalate(autoDrive safe)', async () => {
    const seams = buildHarnessSeams({ seams: fakeSeams({ async gate() { return { passed: false }; } }) });
    const r = await runStagedHarness({ objective: 'x', seams, maxReviewRounds: 2, autoDrive: 'safe' });
    expect(r.ok).toBe(false);
    expect(r.terminal).toBe('escalated');
  });

  test('⓪ clarify seam(safe) → refinedObjective 가 plan/execute 로 흐름', async () => {
    let captured = '';
    const seams = buildHarnessSeams({
      seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }),
      clarify: async ({ objective }) => ({ refinedObjective: `[확정설계] 범위 A\n---\n${objective}`, asked: 1 }),
    });
    await runStagedHarness({ objective: '원본 골', seams, autoDrive: 'safe' });
    expect(captured).toContain('[확정설계] 범위 A'); // clarify refine 이 execute 프롬프트까지 흐름
    expect(captured).toContain('원본 골');
  });

  test('⓪ autoDrive on → clarify 스킵(완전자율·인터뷰 없음)', async () => {
    let clarifyCalled = false;
    const seams = buildHarnessSeams({
      seams: fakeSeams(),
      clarify: async ({ objective }) => { clarifyCalled = true; return { refinedObjective: objective, asked: 0 }; },
    });
    await runStagedHarness({ objective: 'x', seams, autoDrive: 'on' });
    expect(clarifyCalled).toBe(false);
  });

  test('③ 구현이양 — review warn 시 should-fix 를 deploy 로 이양(PR 메모·재작업 없이)', async () => {
    let deployShouldFix: string[] | undefined;
    const seams: StagedHarnessSeams = {
      async plan() { return { steps: ['s'] }; },
      async execute() { return { ok: true, summary: 'done', changes: ['f.ts'] }; },
      async review() { return { verdict: 'warn', findings: ['nit: 네이밍', '엣지케이스 미검'] }; },
      async deploy({ shouldFix }) { deployShouldFix = shouldFix; return { ok: true, ref: 'pr', kind: 'pr' }; },
    };
    await runStagedHarness({ objective: 'x', seams, autoDrive: 'on' });
    expect(deployShouldFix).toEqual(['nit: 네이밍', '엣지케이스 미검']); // 경미 → rework 없이 메모 이양
  });

  test('review pass → should-fix 미전달(정상)', async () => {
    let deployShouldFix: string[] | undefined = ['sentinel'];
    const seams: StagedHarnessSeams = {
      async plan() { return { steps: ['s'] }; },
      async execute() { return { ok: true, summary: 'done', changes: ['f.ts'] }; },
      async review() { return { verdict: 'pass', findings: [] }; },
      async deploy({ shouldFix }) { deployShouldFix = shouldFix; return { ok: true, ref: 'pr', kind: 'pr' }; },
    };
    await runStagedHarness({ objective: 'x', seams, autoDrive: 'on' });
    expect(deployShouldFix).toBeUndefined();
  });
});

describe('리뷰어 배선(critique·자동수정 rework·PR 품질) — 2026-07-21', () => {
  test('execute rework — priorReview findings 를 구현 프롬프트에 주입(자동수정)', async () => {
    let captured = '';
    const seams = buildHarnessSeams({ seams: fakeSeams({
      async implement({ feature, cwd }) { captured = feature; writeFileSync(join(cwd, 'x.ts'), 'x'); return { ok: true, summary: 'ok' }; },
    }) });
    await seams.plan({ objective: 'feat X' });
    await seams.execute({ objective: 'feat X', steps: [], round: 2, priorReview: { verdict: 'fail', findings: ['블로커 A', 'nit B'] } });
    expect(captured).toContain('feat X');           // 원 objective 유지
    expect(captured).toContain('이전 리뷰 지적');    // rework 주입
    expect(captured).toContain('블로커 A');
  });

  test('Q1 execute — plan.steps 가 executor 프롬프트에 [계획] 블록으로 실림', async () => {
    let captured = '';
    const seams = buildHarnessSeams({ seams: fakeSeams({
      async implement({ feature, cwd }) { captured = feature; writeFileSync(join(cwd, 'x.ts'), 'x'); return { ok: true, summary: 'ok' }; },
    }) });
    await seams.plan({ objective: 'feat X' });
    await seams.execute({ objective: 'feat X', steps: ['스텝 1: 스캐폴드', '스텝 2: 배선', '스텝 3: 테스트'], round: 1 });
    expect(captured).toContain('feat X');                 // 원 objective 유지
    expect(captured).toContain('[계획 — 이 스텝대로 구현]'); // 계획 블록 주입
    expect(captured).toContain('1. 스텝 1: 스캐폴드');
    expect(captured).toContain('3. 스텝 3: 테스트');
  });

  test('Q1 무회귀 — steps 가 objective 통짜 1스텝이면 계획 블록 미주입(종전 동일)', async () => {
    let captured = '';
    const seams = buildHarnessSeams({ seams: fakeSeams({
      async implement({ feature, cwd }) { captured = feature; writeFileSync(join(cwd, 'x.ts'), 'x'); return { ok: true, summary: 'ok' }; },
    }) });
    await seams.plan({ objective: 'feat Y' });
    await seams.execute({ objective: 'feat Y', steps: ['feat Y'], round: 1 }); // steps === [objective]
    expect(captured).toContain('feat Y');
    expect(captured).not.toContain('[계획 — 이 스텝대로 구현]'); // objective 중복 배제 = 무회귀
  });

  test('Q6 classifyHeft — deep/light/standard 분류', () => {
    expect(classifyHeft('전반 리팩토링 마이그레이션')).toBe('deep');
    expect(classifyHeft('아키텍처 재설계')).toBe('deep');
    expect(classifyHeft('오타 수정만')).toBe('light');
    expect(classifyHeft('주석 rename')).toBe('light');
    expect(classifyHeft('로그인 폼에 유효성 검증 추가')).toBe('standard');   // 신호 없음 → standard(무회귀)
  });

  test('Q6 classifyHeft — 성공한 접지 구조 신호가 같은 objective를 세 heft로 가른다', () => {
    const objective = '로그인 폼에 유효성 검증 추가';
    expect(classifyHeft(objective, { files: 1, codeFacts: 1 })).toBe('light');
    expect(classifyHeft(objective, { files: 3, codeFacts: 2 })).toBe('standard');
    expect(classifyHeft(objective, { files: 5, codeFacts: 3 })).toBe('deep');
  });

  test('Q6 classifyHeft — signals 생략은 기존 키워드 분류를 보존한다', () => {
    expect(classifyHeft('전반 리팩토링 마이그레이션')).toBe('deep');
    expect(classifyHeft('오타 수정만')).toBe('light');
    expect(classifyHeft('로그인 폼에 유효성 검증 추가')).toBe('standard');
  });

  test('Q6 adversarialThreshold — deep=8·standard=10·light=12', () => {
    expect(adversarialThreshold('standard')).toBe(ADVERSARIAL_AUTO_STEPS);
    expect(adversarialThreshold('deep')).toBe(8);
    expect(adversarialThreshold('light')).toBe(12);
    expect(adversarialThreshold('deep')).toBeLessThan(adversarialThreshold('standard'));
    expect(adversarialThreshold('standard')).toBeLessThan(adversarialThreshold('light'));
  });

  test('Q6 통합 — 성공한 고밀도 접지는 standard objective의 레드팀 임계를 deep으로 낮춘다', async () => {
    let critiqued = 0;
    const seams = buildHarnessSeams({
      seams: fakeSeams(),
      adversarialPlan: async (_o, steps) => { critiqued += 1; return { revisedSteps: [...steps], issues: [] }; },
      ground: async () => ({
        grounded: true, context: '', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], skillFacts: [],
        codeFacts: ['a', 'b', 'c'], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [],
      }),
    });
    await seams.plan({ objective: '기능 추가\n- 스텝1\n- 스텝2\n- 스텝3\n- 스텝4\n- 스텝5\n- 스텝6\n- 스텝7\n- 스텝8' });
    expect(critiqued).toBe(1);
  });

  test('Q6 통합 — 실패한 접지는 signals 없이 기존 standard 임계를 유지한다', async () => {
    let critiqued = 0;
    const seams = buildHarnessSeams({
      seams: fakeSeams(),
      adversarialPlan: async (_o, steps) => { critiqued += 1; return { revisedSteps: [...steps], issues: [] }; },
      ground: async () => { throw new Error('grounding unavailable'); },
    });
    await seams.plan({ objective: '기능 추가\n- 스텝1\n- 스텝2' });
    expect(critiqued).toBe(0);
  });

  test('Q6 통합 — deep objective 는 스텝 8개에서 레드팀 자동발동', async () => {
    let critiqued = 0;
    const seams = buildHarnessSeams({
      seams: fakeSeams(),
      adversarialPlan: async (_o, steps) => { critiqued += 1; return { revisedSteps: [...steps], issues: [] }; },
    });
    // deep + 스텝 8개 → deep 임계 8에서 자동발동.
    await seams.plan({ objective: '전반 리팩토링\n- 스텝1\n- 스텝2\n- 스텝3\n- 스텝4\n- 스텝5\n- 스텝6\n- 스텝7\n- 스텝8' });
    expect(critiqued).toBe(1);
  });

  test('Q6 통합 — standard objective 스텝 2개는 레드팀 미발동(임계10)', async () => {
    let critiqued = 0;
    const seams = buildHarnessSeams({
      seams: fakeSeams(),
      adversarialPlan: async (_o, steps) => { critiqued += 1; return { revisedSteps: [...steps], issues: [] }; },
    });
    await seams.plan({ objective: '기능 추가\n- 스텝1\n- 스텝2' });   // standard·2스텝 < 10
    expect(critiqued).toBe(0);
  });

  test('F1 refFacts 렌더 — grounding 의 refFacts 가 executor 프롬프트에 로컬 ref 섹션으로 실림', async () => {
    let captured = '';
    const seams = buildHarnessSeams({
      seams: fakeSeams({ async implement({ feature, cwd }) { captured = feature; writeFileSync(join(cwd, 'x.ts'), 'x'); return { ok: true, summary: 'ok' }; } }),
      ground: async () => ({
        grounded: true, context: '기존 자산 X', files: [], skillFacts: [], codeFacts: [], memoryFacts: [], documentFacts: [],
        refFacts: ['[ref:dnd-kit] /Users/me/source/ref/dnd-kit — 드래그앤드롭 참조'], ptyFacts: [],
      }),
    });
    await seams.plan({ objective: 'dnd-kit 드래그 구현' });
    await seams.execute({ objective: 'dnd-kit 드래그 구현', steps: [], round: 1 });
    expect(captured).toContain('로컬 참조 repo');          // F1 신규 섹션
    expect(captured).toContain('[ref:dnd-kit]');
    expect(captured).toContain('드래그앤드롭 참조');         // F2 참조 이유 carry
    expect(captured).toContain('직접 Read/Grep');           // F4 프레이밍
  });

  test('F2 ptyFacts 렌더 — 상류 잡 capsule 팩트가 executor 프롬프트에 도달(handoff 실소비·MF1/MF2)', async () => {
    let captured = '';
    const seams = buildHarnessSeams({
      seams: fakeSeams({ async implement({ feature, cwd }) { captured = feature; writeFileSync(join(cwd, 'x.ts'), 'x'); return { ok: true, summary: 'ok' }; } }),
      ground: async () => ({
        grounded: true, context: '기존 자산 X', files: [], skillFacts: [], codeFacts: [], memoryFacts: [], documentFacts: [], refFacts: [],
        ptyFacts: ['[pty:up-1] URL 라우터 파이프라인 구현 — 완료기준: 라우팅 통과'],
      }),
    });
    await seams.plan({ objective: 'URL 라우터 배선' });
    await seams.execute({ objective: 'URL 라우터 배선', steps: [], round: 1 });
    expect(captured).toContain('상류/병렬 잡 컨텍스트');        // F2 신규 섹션(provenance 메타 아닌 프롬프트 도달)
    expect(captured).toContain('[pty:up-1]');
    expect(captured).toContain('URL 라우터 파이프라인 구현');   // 상류 objective·완료기준이 planner 에 실제 전달
  });

  test('F1 무회귀 — refFacts 없으면 로컬 ref 섹션 미출력', async () => {
    let captured = '';
    const seams = buildHarnessSeams({
      seams: fakeSeams({ async implement({ feature, cwd }) { captured = feature; writeFileSync(join(cwd, 'x.ts'), 'x'); return { ok: true, summary: 'ok' }; } }),
      ground: async () => ({ grounded: true, context: 'C', files: [], skillFacts: ['[skill:x]'], codeFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] }),
    });
    await seams.plan({ objective: 'feat' });
    await seams.execute({ objective: 'feat', steps: [], round: 1 });
    expect(captured).not.toContain('로컬 참조 repo');
    expect(captured).toContain('[skill:x]');   // 종전 facts 는 유지
  });

  test('R3 신호 게이트 — signalGate 산출이 grounding→executor 프롬프트에 실림', async () => {
    let captured = '';
    const seams = buildHarnessSeams({
      seams: fakeSeams({ async implement({ feature, cwd }) { captured = feature; writeFileSync(join(cwd, 'x.ts'), 'x'); return { ok: true, summary: 'ok' }; } }),
      signalGate: (obj) => obj.includes('삼성') ? '[규율 신호 — asset-attractiveness ±1σ · 판단 참고(집행 아님)]\n- 005930.KO: BUY (score 72 · z +1.3)' : null,
    });
    await seams.plan({ objective: '삼성전자 매력도 분석' });
    await seams.execute({ objective: '삼성전자 매력도 분석', steps: [], round: 1 });
    expect(captured).toContain('규율 신호');
    expect(captured).toContain('005930.KO: BUY');
    expect(captured).toContain('집행 아님');   // 판단층·부작용0 명시
  });

  test('R3 무회귀 — signalGate 미주입이면 grounding 무변경', async () => {
    let captured = '';
    const seams = buildHarnessSeams({
      seams: fakeSeams({ async implement({ feature, cwd }) { captured = feature; writeFileSync(join(cwd, 'x.ts'), 'x'); return { ok: true, summary: 'ok' }; } }),
    });
    await seams.plan({ objective: 'feat W' });
    await seams.execute({ objective: 'feat W', steps: [], round: 1 });
    expect(captured).not.toContain('규율 신호');
    expect(captured).toContain('feat W');
  });

  test('Q3 비-코드 종결상태 — domainExecute outcome(changes:[]) → deploy 가 비-코드 kind 반환', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const seams = buildHarnessSeams({
      seams: fakeSeams(),
      // 비-코드 executor: 파일 변경 0·집행/신호 성과만.
      domainExecute: async () => ({ ok: true, summary: '신호 산출', changes: [], outcome: 'signaled', ref: 'BUY z=1.2' }),
      authorizeDeploy: () => true,
    });
    await seams.plan({ objective: '삼성전자 매력도 신호' });
    const ex = await seams.execute({ objective: '삼성전자 매력도 신호', steps: [], round: 1 });
    expect(ex.changes.length).toBe(0);
    const dep = await seams.deploy({ objective: '삼성전자 매력도 신호', summary: '완료' });
    expect(dep.kind).toBe('none');       // signaled는 운영 producer가 없어 evidence 없이 승격되지 않음
    expect(dep.ok).toBe(false);
    expect(log).toHaveBeenCalledWith('harness.seams', 'executed', expect.objectContaining({
      changes: 0, executor: 'domain', outcome: 'signaled', nonCodeOutcomePromoted: false,
    }));
    } finally {
      log.mockRestore();
    }
  });

  test('Q3 producer evidence — 실제 generic regex 폴백은 무변경 published를 terminal 성공으로 승격하지 않는다', async () => {
    const domainExecute = buildGenericSkillExecute({
      enhance: false,
      discover: async () => [{ name: 'manual-reader', description: '문서를 읽음' }],
      planChain: async () => [{ skill: 'manual-reader', task: '문서 확인' }],
      runSkill: async () => '인용한 기존 문서: ./manual.md',
    });
    const seams = buildHarnessSeams({ seams: fakeSeams(), domainExecute });
    await seams.plan({ objective: '코드 수정' });
    const ex = await seams.execute({ objective: '코드 수정', steps: [], round: 1 });
    expect(ex.ok).toBe(true);
    expect(ex.changes).toEqual([]);
    const dep = await seams.deploy({ objective: '코드 수정', summary: ex.summary });
    expect(dep).toEqual({ ok: false, kind: 'none' });
  });

  test('Q3 producer evidence — 생성 뒤 삭제한 generic 파일은 terminal 성공으로 승격하지 않는다', async () => {
    const generic = buildGenericSkillExecute({
      enhance: false,
      discover: async () => [{ name: 'writer', description: '임시 파일 생성' }],
      planChain: async () => [{ skill: 'writer', task: '임시 보고서 생성' }],
      runSkill: async (_skill, _task, _prior, cwd) => {
        const path = join(cwd, 'deleted-report.md');
        writeFileSync(path, '임시 산출물');
        unlinkSync(path);
        return '완료: ./deleted-report.md';
      },
    });
    const seams = buildHarnessSeams({ seams: fakeSeams(), domainExecute: generic });
    await seams.plan({ objective: '코드 수정' });
    const ex = await seams.execute({ objective: '코드 수정', steps: [], round: 1 });
    expect(ex).toMatchObject({ ok: true, changes: [] });
    expect(await seams.deploy({ objective: '코드 수정', summary: ex.summary })).toEqual({ ok: false, kind: 'none' });
  });

  test('Q3 producer evidence — 기존 경로 regex와 무관한 신규 파일은 published를 증명하지 않는다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let cachePath = '';
    const generic = buildGenericSkillExecute({
      enhance: false,
      discover: async () => [{ name: 'manual-reader', description: '기존 문서 읽기' }],
      planChain: async () => [{ skill: 'manual-reader', task: '문서 확인' }],
      runSkill: async (_skill, _task, _prior, cwd) => {
        cachePath = join(cwd, 'cache.tmp');
        writeFileSync(cachePath, 'unrelated');
        return '인용한 기존 문서: ./manual.md';
      },
    });
    const seams = buildHarnessSeams({ seams: fakeSeams(), domainExecute: generic });
    await seams.plan({ objective: '코드 수정' });
    const ex = await seams.execute({ objective: '코드 수정', steps: [], round: 1 });
    expect(ex).toMatchObject({ ok: true, changes: [] });
    try {
      unlinkSync(cachePath); // deploy의 실제 files 재확인을 no-changes로 돌려 producer 승격만 검증한다.
      expect(await seams.deploy({ objective: '코드 수정', summary: ex.summary })).toEqual({ ok: false, kind: 'none' });
      expect(log).toHaveBeenCalledWith('harness.seams', 'deploy-noncode-blocked', expect.objectContaining({
        ref: cachePath, reason: 'artifact-created-ref-missing',
      }));
    } finally {
      log.mockRestore();
    }
  });

  test('Q3 producer evidence — signaled와 execution evidence의 잘못된 조합은 terminal 성공으로 승격하지 않는다', async () => {
    const seams = buildHarnessSeams({
      seams: fakeSeams(),
      domainExecute: async () => ({
        ok: true, summary: '잘못된 조합', changes: [], outcome: 'signaled', ref: 'cancel:ORDER123',
        nonCodeEvidence: 'execution-completed',
      } as any), // hostile runtime producer: type 계약 밖 조합도 seams에서 차단한다.
    });
    await seams.plan({ objective: '신호 분석' });
    const ex = await seams.execute({ objective: '신호 분석', steps: [], round: 1 });
    expect(ex).toMatchObject({ ok: true, changes: [] });
    expect(await seams.deploy({ objective: '신호 분석', summary: ex.summary })).toEqual({ ok: false, kind: 'none' });
  });

  test.skipIf(!HAS_TRADING_ADDON)('Q3 producer evidence — 실제 generic 신규 파일·web URL·execution action은 무변경 terminal 성공을 유지한다', async () => {
    const { buildHarnessExecutionExecutor } = await import(EXECUTION_EXECUTOR_MODULE) as {
      buildHarnessExecutionExecutor(o: { allowedSymbols: Set<string>; maxOrderKrw: number; estimateValueKrw: () => Promise<number> }): NonNullable<Parameters<typeof buildHarnessSeams>[0]['domainExecute']>;
    };
    const generic = buildGenericSkillExecute({
      enhance: false,
      discover: async () => [{ name: 'writer', description: '파일 생성' }],
      planChain: async () => [{ skill: 'writer', task: '보고서 생성' }],
      runSkill: async (_skill, _task, _prior, cwd) => { writeFileSync(join(cwd, 'report.md'), '새 산출물'); return '완료'; },
    });
    const web = buildWebDomainExecute({
      publish: async () => ({ url: 'https://example.test/report', detail: '게시 완료' }),
      verify: async () => ({ ok: true, findings: [] }),
    });
    const execution = buildHarnessExecutionExecutor({
      allowedSymbols: new Set(['005930']), maxOrderKrw: 100_000, estimateValueKrw: async () => 50_000,
    });
    for (const [objective, domainExecute, kind] of [
      ['코드와 별개인 보고서 생성', generic, 'branch'],
      ['웹 리포트 게시', web, 'published'],
      ['005930 1주 매수', execution, 'executed'],
    ] as const) {
      const seams = buildHarnessSeams({ seams: fakeSeams(), domainExecute });
      await seams.plan({ objective });
      const ex = await seams.execute({ objective, steps: [], round: 1 });
      expect(ex.ok).toBe(true);
      expect(ex.changes).toEqual([]);
      const dep = await seams.deploy({ objective, summary: ex.summary });
      expect(dep.ok).toBe(true);
      expect(dep.kind).toBe(kind);
    }
  });

  test('Q3 무회귀 — 코드 executor(outcome 없음)는 changes:[] 시 종전대로 no-changes', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const seams = buildHarnessSeams({ seams: fakeSeams({
      async implement() { return { ok: true, summary: '변경 없음' }; },   // 파일 안 씀 → changedFiles 0
    }) });
    await seams.plan({ objective: 'feat Z' });
    await seams.execute({ objective: 'feat Z', steps: [], round: 1 });
    const dep = await seams.deploy({ objective: 'feat Z', summary: '완료' });
    expect(dep.kind).toBe('none');   // 비-코드 outcome 없음 → 종전 no-changes 경로
    expect(log).toHaveBeenCalledWith('harness.seams', 'executed', expect.objectContaining({
      changes: 0, nonCodeOutcomePromoted: false,
    }));
    } finally {
      log.mockRestore();
    }
  });

  test('review critique — llmReview FAIL → verdict fail + findings(게이트 pass 여도)', async () => {
    const llmReview = async () => 'VERDICT: FAIL\nMUST-FIX:\n- 심각한 회귀 버그';
    const seams = buildHarnessSeams({ seams: fakeSeams(), llmReview });
    await seams.plan({ objective: 'feat X' });
    await seams.execute({ objective: 'feat X', steps: [], round: 1 });   // feature.ts(untracked) 씀
    const v = await seams.review({ objective: 'feat X', changes: ['feature.ts'] });
    expect(v.verdict).toBe('fail');
    expect(v.findings.join(' ')).toContain('심각한 회귀 버그');
  });

  test('deploy PR 제목/본문 — llmReview 제목 + objective/파일목록 본문(공수표 대체)', async () => {
    let titleSeen = '', bodySeen = '';
    const llmReview = async (p: string) => (p.includes('naming a pull request') ? 'feat: 근사한 제목' : 'VERDICT: PASS');
    const seams = buildHarnessSeams({
      seams: fakeSeams({ async openPr({ title, body, head }) { titleSeen = title; bodySeen = body; return { url: `https://pr/${head}`, number: 1 }; } }),
      authorizeDeploy: () => true, llmReview,
    });
    await seams.plan({ objective: 'feat X 구현' });
    await seams.execute({ objective: 'feat X 구현', steps: [], round: 1 });
    await seams.deploy({ objective: 'feat X 구현', summary: '1라운드 완료·verdict=pass' });
    expect(titleSeen).toBe('feat: 근사한 제목');       // A: LLM 제목
    expect(bodySeen).toContain('## 목표');
    expect(bodySeen).toContain('feature.ts');          // 변경 파일목록
    expect(bodySeen).toContain('dev-harness');         // footer
  });
});

const HARNESS_SIGNAL_BODY = '조건 = bun test src/harness/harness-seams.test.ts; 관측 = acceptanceChars; 기대 = 0보다 큼';
const HARNESS_GOAL_WITH_SIGNAL = `## 판정 신호\n${HARNESS_SIGNAL_BODY}`;
const HARNESS_GOAL_WITHOUT_SIGNAL = '## WHAT TO BUILD\n리뷰 입력만 잇는다';

function ghDiffSpawn(stdout = 'diff --git a/x.ts b/x.ts\n+ok', status = 0) {
  return ((command: string, args: string[]) => command === 'gh' && args[1] === 'diff'
    ? { status, stdout: status === 0 ? stdout : '', stderr: status === 0 ? '' : 'gh failed' }
    : { status: 0, stdout: '', stderr: '' }) as typeof import('node:child_process').spawnSync;
}

describe('harness review acceptance plumbing', () => {
  test('무골 runCritique — reviewPullRequest 입력에 acceptance 키가 없고 관측 필드가 둘이다', async () => {
    const received: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async (input) => {
      received.push({ ...input });
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true };
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'harness.seams' && event === 'review.done') events.push({ ...(data ?? {}) });
    }) as never);
    try {
      const seams = buildHarnessSeams({ seams: fakeSeams(), llmReview: async () => 'VERDICT: PASS' });
      await seams.plan({ objective: 'feat X' });
      await seams.execute({ objective: 'feat X', steps: [], round: 1 });
      await seams.review({ objective: 'feat X', changes: ['feature.ts'] });
      expect(received).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(received[0], 'acceptance')).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ goalLoaded: false, acceptanceChars: 0 });
    } finally {
      reviewSpy.mockRestore();
      log.mockRestore();
    }
  });

  test('골+판정 신호 runCritique — acceptance 전달 · goalLoaded=true · acceptanceChars>0', async () => {
    const received: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async (input) => {
      received.push({ ...input });
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true };
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'harness.seams' && event === 'review.done') events.push({ ...(data ?? {}) });
    }) as never);
    try {
      const seams = buildHarnessSeams({
        seams: fakeSeams(),
        llmReview: async () => 'VERDICT: PASS',
        goalDocument: HARNESS_GOAL_WITH_SIGNAL,
      });
      await seams.plan({ objective: 'feat X' });
      await seams.execute({ objective: 'feat X', steps: [], round: 1 });
      await seams.review({ objective: 'feat X', changes: ['feature.ts'] });
      expect(received[0]!.acceptance).toContain(HARNESS_SIGNAL_BODY);
      expect(String(received[0]!.acceptance).length).toBeGreaterThan(0);
      expect(events[0]).toMatchObject({ goalLoaded: true });
      expect(Number(events[0]!.acceptanceChars)).toBeGreaterThan(0);
    } finally {
      reviewSpy.mockRestore();
      log.mockRestore();
    }
  });

  test('골은 있으나 판정 신호 절이 없으면 acceptance 키가 없고 goalLoaded=true · acceptanceChars=0', async () => {
    const received: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async (input) => {
      received.push({ ...input });
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true };
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'harness.seams' && event === 'review.done') events.push({ ...(data ?? {}) });
    }) as never);
    try {
      const seams = buildHarnessSeams({
        seams: fakeSeams(),
        llmReview: async () => 'VERDICT: PASS',
        goalDocument: HARNESS_GOAL_WITHOUT_SIGNAL,
      });
      await seams.plan({ objective: 'feat X' });
      await seams.execute({ objective: 'feat X', steps: [], round: 1 });
      await seams.review({ objective: 'feat X', changes: ['feature.ts'] });
      expect(Object.prototype.hasOwnProperty.call(received[0], 'acceptance')).toBe(false);
      expect(events[0]).toMatchObject({ goalLoaded: true, acceptanceChars: 0 });
    } finally {
      reviewSpy.mockRestore();
      log.mockRestore();
    }
  });

  test('무골 postPrReview — acceptance 키 없음 · goalLoaded=false · acceptanceChars=0', async () => {
    const received: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async (input) => {
      received.push({ ...input });
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true };
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'harness.seams' && event === 'deployed-review') events.push({ ...(data ?? {}) });
    }) as never);
    try {
      await postPrReview('.', 42, 'feat X', async () => 'VERDICT: PASS', ghDiffSpawn());
      expect(received).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(received[0], 'acceptance')).toBe(false);
      expect(events[0]).toMatchObject({ goalLoaded: false, acceptanceChars: 0 });
    } finally {
      reviewSpy.mockRestore();
      log.mockRestore();
    }
  });

  test('골+판정 신호 postPrReview — acceptance 전달 · goalLoaded=true · acceptanceChars>0', async () => {
    const received: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async (input) => {
      received.push({ ...input });
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true };
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'harness.seams' && event === 'deployed-review') events.push({ ...(data ?? {}) });
    }) as never);
    try {
      await postPrReview('.', 42, 'feat X', async () => 'VERDICT: PASS', ghDiffSpawn(), HARNESS_GOAL_WITH_SIGNAL);
      expect(received[0]!.acceptance).toContain(HARNESS_SIGNAL_BODY);
      expect(events[0]).toMatchObject({ goalLoaded: true });
      expect(Number(events[0]!.acceptanceChars)).toBeGreaterThan(0);
    } finally {
      reviewSpy.mockRestore();
      log.mockRestore();
    }
  });

  test('deploy 가 deps.goalDocument 를 postPrReview 로 넘긴다', async () => {
    const received: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async (input) => {
      received.push({ ...input });
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true };
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'harness.seams' && event === 'deployed-review') events.push({ ...(data ?? {}) });
    }) as never);
    try {
      const seams = buildHarnessSeams({
        seams: fakeSeams(),
        authorizeDeploy: () => true,
        llmReview: async () => 'VERDICT: PASS',
        goalDocument: HARNESS_GOAL_WITH_SIGNAL,
        spawnSyncFn: ghDiffSpawn(),
      });
      await seams.plan({ objective: 'feat X 구현' });
      await seams.execute({ objective: 'feat X 구현', steps: [], round: 1 });
      await seams.deploy({ objective: 'feat X 구현', summary: '1라운드 완료·verdict=pass' });
      expect(received).toHaveLength(1);
      expect(received[0]!.acceptance).toContain(HARNESS_SIGNAL_BODY);
      expect(events[0]).toMatchObject({ goalLoaded: true });
      expect(Number(events[0]!.acceptanceChars)).toBeGreaterThan(0);
    } finally {
      reviewSpy.mockRestore();
      log.mockRestore();
    }
  });

  test('review.done — reviewed:false 이고 failureReason 이 있으면 그 사유를 그대로 싣는다', async () => {
    const events: Array<Record<string, unknown>> = [];
    const reason = 'Unknown ACP backend "claude-code". Known: claude, gemini';
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async () => {
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: false, failureReason: reason };
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'harness.seams' && event === 'review.done') events.push({ ...(data ?? {}) });
    }) as never);
    try {
      const seams = buildHarnessSeams({ seams: fakeSeams(), llmReview: async () => 'VERDICT: PASS' });
      await seams.plan({ objective: 'feat X' });
      await seams.execute({ objective: 'feat X', steps: [], round: 1 });
      await seams.review({ objective: 'feat X', changes: ['feature.ts'] });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        verdict: 'pass',
        reviewed: false,
        mustFix: 0,
        shouldFix: 0,
        failureReason: reason,
      });
      expect(Object.prototype.hasOwnProperty.call(events[0], 'gateEvidenceLines')).toBe(true);
    } finally {
      reviewSpy.mockRestore();
      log.mockRestore();
    }
  });

  test('review.done — failureReason 이 없으면 그 칸을 만들지 않는다', async () => {
    const events: Array<Record<string, unknown>> = [];
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async () => {
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true };
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'harness.seams' && event === 'review.done') events.push({ ...(data ?? {}) });
    }) as never);
    try {
      const seams = buildHarnessSeams({ seams: fakeSeams(), llmReview: async () => 'VERDICT: PASS' });
      await seams.plan({ objective: 'feat X' });
      await seams.execute({ objective: 'feat X', steps: [], round: 1 });
      await seams.review({ objective: 'feat X', changes: ['feature.ts'] });
      expect(events).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(events[0], 'failureReason')).toBe(false);
      expect(events[0]).toMatchObject({
        verdict: 'pass',
        reviewed: true,
        mustFix: 0,
        shouldFix: 0,
      });
      expect(Object.prototype.hasOwnProperty.call(events[0], 'gateEvidenceLines')).toBe(true);
    } finally {
      reviewSpy.mockRestore();
      log.mockRestore();
    }
  });

  test('postPrReview fail-soft — gh pr diff 실패는 reject 하지 않는다', async () => {
    const reviewSpy = spyOn(prReviewer, 'reviewPullRequest').mockImplementation(async () => {
      throw new Error('should not review');
    });
    try {
      await expect(postPrReview('.', 42, 'feat X', async () => 'VERDICT: PASS', ghDiffSpawn('', 1))).resolves.toBeUndefined();
    } finally {
      reviewSpy.mockRestore();
    }
  });

  test('postPrReview fail-soft — 골 파싱 예외는 reject 하지 않는다', async () => {
    const exploding = { trim() { throw new Error('goal-parse'); } } as unknown as string;
    await expect(postPrReview('.', 42, 'feat X', async () => 'VERDICT: PASS', ghDiffSpawn(), exploding)).resolves.toBeUndefined();
  });
});
